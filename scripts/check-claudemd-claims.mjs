#!/usr/bin/env node
// @ts-check
/**
 * check-claudemd-claims.mjs — verify the SoT that verifies everything else.
 *
 * OPS-CLAUDEMD-CLAIM-VERIFIER-W1. Every wave spec is derived from the vault CLAUDE.md. Five
 * measured incidents (all recorded in that file's own correction notes) show what a false claim
 * in the prescriptive SoT costs: a gate cited for months that was never built, a deployed-artifact
 * grep whose structural 0 shipped an unsatisfiable AC, a paths-ignore list that drifted twice in
 * one session, an exit-code documented as 3 while live main deployed 2, and a --dry-run that
 * publishes. monitoring-inventory.json has a reconciler, so its over-claims surface in a day;
 * CLAUDE.md had no verifier, so its false claims survived for weeks. This is that verifier.
 *
 * THE DOMINANT FALSE-POSITIVE CLASS, designed for from line one: CLAUDE.md's historical
 * correction notes — `_( … )_` italic parentheticals — deliberately cite things that no longer
 * exist. Those citations are the most valuable prose in the file. They are STRIPPED (paren-depth
 * aware, multiline) before any assertion is extracted; only prescriptive prose is verified.
 * Same lesson as check-canaries-wired.mjs's comment-strip: a mention is not an invocation.
 *
 * CORPUS vs LOCK. The corpus is the vault CLAUDE.md — private, outside this public repo, and
 * unreachable from CI runners. The gate therefore keeps a committed claim lock
 * (ops/claudemd-claims.lock.json) holding IDENTIFIERS ONLY (repo paths, script names, wiring
 * points, exit codes) — never the manual's prose. Locally (corpus reachable) the gate re-extracts
 * fresh, enforces lock freshness by corpus sha256, and additionally verifies local-only classes
 * (vault paths, home paths). In CI it verifies the lock against the repo — which is exactly the
 * high-value direction: the commit that deletes/renames a file CLAUDE.md prescribes fails here.
 *
 * SEVERITY LADDER (measured, not assumed — see _step0_measurement in the config): repo paths,
 * root files, resolvable basenames, and wiring claims BLOCK (0 measured false positives);
 * script-content (exit codes / verdict tokens), cron-vs-inventory, env-vars, absence claims and
 * the local-only classes REPORT, with a numeric promotion criterion in the config. Wiring claims
 * are resolved by IMPORTING check-canaries-wired.mjs's findInvocations — never re-implemented.
 *
 * Usage:
 *   node scripts/check-claudemd-claims.mjs --self-test   # two-directional, vacuity-guarded
 *   node scripts/check-claudemd-claims.mjs --check       # verify (default). CI: lock-mode.
 *   node scripts/check-claudemd-claims.mjs --sync        # regenerate the lock from the corpus
 *   node scripts/check-claudemd-claims.mjs --measure     # R1 corpus measurement, incl. strip A/B
 *   node scripts/check-claudemd-claims.mjs --probe-hosts # with --check: read-only host probes
 *
 * Verdict: exactly one terminal `CLAUDEMD_CLAIMS_VERDICT=PASS|FAIL|INDETERMINATE`.
 * Exit: 0 = PASS · 1 = FAIL · 3 = INDETERMINATE (token-law default for a new gate).
 * FAIL-CLOSED: missing/invalid config, missing lock (in CI), unreadable corpus (when required),
 * or a vacuous extraction (0 claims from a non-empty corpus) is INDETERMINATE and blocks.
 * ALGOVAULT_CLAUDEMD_GATE=warn downgrades the EXIT CODE only — never the token.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, basename } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { tracked, invokerFiles, findInvocations } from './check-canaries-wired.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = join(ROOT, 'ops', 'claudemd-claim-config.json');
const LOCK_PATH = join(ROOT, 'ops', 'claudemd-claims.lock.json');
const DEFAULT_CORPUS = join(homedir(), 'My Drive', 'Obsidian Vault', 'AlgoVault MCP', 'CLAUDE.md');
const CORPUS_PATH = process.env.ALGOVAULT_CLAUDEMD_CORPUS || DEFAULT_CORPUS;

const argv = process.argv.slice(2);

/** Claim classes that are verifiable from the repo alone — the only classes the lock carries. */
const LOCK_CLASSES = new Set(['repo-path', 'root-file', 'basename', 'wiring', 'script-content', 'cron-schedule', 'env-var', 'absence-repo']);

// ── correction-block stripper ─────────────────────────────────────────────────

/**
 * Locate `_( … )_` historical-correction blocks, paren-depth aware, multiline.
 * @param {string} t
 * @returns {[number, number][]} char ranges [start, end)
 */
export function findCorrectionBlocks(t) {
  const blocks = [];
  let i = 0;
  while (i < t.length) {
    const s = t.indexOf('_(', i);
    if (s === -1) break;
    let depth = 0, end = -1;
    for (let j = s + 1; j < t.length; j++) {
      const c = t[j];
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) {
          if (t[j + 1] === '_') end = j + 2;
          break;
        }
      }
    }
    if (end !== -1) { blocks.push([s, end]); i = end; }
    else i = s + 2;
  }
  return blocks;
}

/** Replace correction-block chars with spaces so positions/line numbers survive. */
export function maskCorrections(text) {
  const chars = text.split('');
  for (const [s, e] of findCorrectionBlocks(text)) {
    for (let i = s; i < e; i++) if (chars[i] !== '\n') chars[i] = ' ';
  }
  return chars.join('');
}

// ── config ────────────────────────────────────────────────────────────────────

export function validateConfig(cfg) {
  for (const key of ['classes', 'exemptions', 'root_file_map', 'wiring_point_map', 'repo_prefixes', 'vault_names', 'vault_prefixes', 'absence_markers', 'nonclaim_markers', 'report_class_promotion']) {
    if (!(key in cfg)) throw new Error(`config missing required key: ${key}`);
  }
  for (const row of cfg.exemptions) {
    if (!row.reason || typeof row.reason !== 'string') throw new Error(`exemption row ${JSON.stringify(row.value)} has no reason`);
  }
  if (typeof cfg.report_class_promotion.runs_required !== 'number') {
    throw new Error('report_class_promotion.runs_required must be numeric — a promotion criterion is a number that can be checked, not a vibe');
  }
  return cfg;
}

export function loadConfig() {
  return validateConfig(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')));
}

// ── extraction ────────────────────────────────────────────────────────────────

const TEMPLATE_RE = /[<>{}]|…|\bNNN\b|X\.Y\.Z|YYYY|XXXXX/;
const EXT_RE = /\.(sh|mjs|js|cjs|ts|py|ya?ml|json|txt|html|jsx|md)$/;
const SCRIPT_EXT_RE = /\.(sh|mjs|js|cjs|ts|py)$/;

/**
 * Extract classified claims from a CLAUDE.md-shaped corpus.
 * @param {string} rawText
 * @param {any} cfg
 * @param {{stripCorrections?: boolean}} [opts]
 */
export function extractClaims(rawText, cfg, opts = {}) {
  const stripOn = opts.stripCorrections !== false;
  const text = stripOn ? maskCorrections(rawText) : rawText;
  const lines = text.split('\n');
  const claims = [];
  const stats = { spans: 0, skipped: 0, blocks: findCorrectionBlocks(rawText).length };
  const exemptSet = new Set(cfg.exemptions.map((e) => `${e.class}|${e.value}`));
  const isExempt = (cls, v) => exemptSet.has(`${cls}|${v}`);
  const push = (c) => { if (!isExempt(c.class, c.value)) claims.push(c); };

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const spans = [];
    const re = /`([^`\n]+)`/g;
    let m;
    while ((m = re.exec(line))) spans.push({ v: m[1], s: m.index, e: m.index + m[0].length });
    stats.spans += spans.length;

    const scriptSpans = spans.filter((sp) => SCRIPT_EXT_RE.test(sp.v) && !TEMPLATE_RE.test(sp.v) && !/[*?\s]/.test(sp.v));

    for (const sp of spans) {
      const v = sp.v;
      const window = line.slice(Math.max(0, sp.s - 45), Math.min(line.length, sp.e + 70));
      const absent = cfg.absence_markers.some((mk) => window.includes(mk));
      const nonclaim = cfg.nonclaim_markers.some((mk) => window.includes(mk));

      if (TEMPLATE_RE.test(v) || /[*?]/.test(v) || /\s/.test(v)) { stats.skipped++; continue; }

      // absence claims first: the check INVERTS (the thing must NOT exist)
      if (absent && (EXT_RE.test(v) || cfg.vault_names.includes(v))) {
        const vaultish = cfg.vault_names.includes(v) || cfg.vault_prefixes.some((p) => v.startsWith(p));
        push({ class: vaultish ? 'absence-vault' : 'absence-repo', value: v, line: lineNo });
        continue;
      }
      if (nonclaim) { stats.skipped++; continue; }

      if (/^[A-Z][A-Z0-9_]*_VERDICT=/.test(v)) {
        // the emitter is not always the NEAREST script span (L-202 names the installer between
        // the token and the gate), so carry every script on the line, nearest first
        const candidates = [...scriptSpans].sort((a, b) => Math.abs(a.s - sp.s) - Math.abs(b.s - sp.s)).map((x) => x.v);
        if (candidates.length) push({ class: 'script-content', value: candidates[0], candidates, token: v.split('=')[0] + '=', line: lineNo });
        continue;
      }
      if (/^[A-Z][A-Z0-9_]{2,}=/.test(v)) { push({ class: 'env-var', value: v.split('=')[0] + '=', line: lineNo }); continue; }
      if (/^\d{1,2} \d{1,2}$/.test(v)) {
        const near = nearestScript(scriptSpans, sp.s);
        if (near) push({ class: 'cron-schedule', value: v, script: near, line: lineNo });
        continue;
      }
      if (/^~\//.test(v)) { push({ class: 'home-path', value: v, line: lineNo }); continue; }
      if (/^\/(opt|var|etc)\//.test(v)) { push({ class: 'host-path', value: v, line: lineNo }); continue; }
      if (/^\//.test(v)) { stats.skipped++; continue; } // /app/** (container), routes, regex fragments

      if (cfg.repo_prefixes.some((p) => v.startsWith(p))) {
        if (EXT_RE.test(v)) push({ class: 'repo-path', value: v, line: lineNo });
        else stats.skipped++; // bare directory reference — prose, not a claim (measured)
        continue;
      }
      if (v in cfg.root_file_map) { push({ class: 'root-file', value: v, line: lineNo }); continue; }
      if (cfg.vault_names.includes(v) || cfg.vault_prefixes.some((p) => v.startsWith(p))) {
        push({ class: 'vault-path', value: v, line: lineNo });
        continue;
      }
      if (!v.includes('/') && EXT_RE.test(v) && !v.endsWith('.md') && /^[A-Za-z0-9]/.test(v)) {
        push({ class: 'basename', value: v, line: lineNo });
        continue;
      }
      stats.skipped++;
    }

    // line-level claims (masked text ⇒ correction blocks already blank)
    // exit-code mappings as (code, meaning) PAIRS: `0=PASS / 1=FAIL / 2=INDETERMINATE`, `INDETERMINATE=3`
    const pairs = new Map();
    let firstPairIdx = -1;
    for (const mm of line.matchAll(/\b(\d)\s*=\s*(PASS|FAIL|INDETERMINATE|silent|escalate|critical-bypass|framework-error)\b/g)) {
      pairs.set(mm[1] + mm[2], { code: mm[1], meaning: mm[2] });
      if (firstPairIdx === -1) firstPairIdx = mm.index;
    }
    for (const mm of line.matchAll(/\bINDETERMINATE\s*=\s*(\d)\b/g)) {
      pairs.set(mm[1] + 'INDETERMINATE', { code: mm[1], meaning: 'INDETERMINATE' });
      if (firstPairIdx === -1) firstPairIdx = mm.index;
    }
    if (pairs.size && scriptSpans.length) {
      // associate to the script NEAREST the mapping text, carrying the rest as fallbacks —
      // measured: the L-202 bullet names three scripts before its code table, and the first is
      // the wrong one (check_system_map.sh) while the nearest-to-match is right
      const candidates = [...scriptSpans].sort((a, b) => Math.abs(a.s - firstPairIdx) - Math.abs(b.s - firstPairIdx)).map((x) => x.v);
      push({ class: 'script-content', value: candidates[0], candidates, codes: [...pairs.values()].sort((a, b) => a.code.localeCompare(b.code)), line: lineNo });
    }
    // wiring pattern A: "wired into `X` + `Y`" — nearest preceding script span.
    // The segment ends at a sentence/clause boundary that cannot sit inside a backticked
    // point name (`deploy.yml` contains “.”, so a naive [^.]* capture truncates it).
    const wired = /wired into (.*)$/.exec(line);
    if (wired) {
      const segment = wired[1].split(/\.\*\*|\.\s|;|—/)[0];
      const before = scriptSpans.filter((sp) => sp.s < wired.index);
      const script = before.length ? before[before.length - 1].v : null;
      const points = Object.keys(cfg.wiring_point_map).filter((p) => segment.includes('`' + p + '`'));
      if (script && points.length) push({ class: 'wiring', value: script, points, line: lineNo });
    }
    // wiring pattern B: "detected at `pre-push` by `script`"
    const atBy = /at `(pre-push|pre-commit)` by `([^`]+)`/.exec(line);
    if (atBy && SCRIPT_EXT_RE.test(atBy[2])) push({ class: 'wiring', value: atBy[2], points: [atBy[1]], line: lineNo });
  });

  // dedupe (same claim restated on several lines) — keep first line
  const seen = new Map();
  for (const c of claims) {
    const key = [c.class, c.value, c.token || '', JSON.stringify(c.codes || []), (c.points || []).join(','), c.script || ''].join('|');
    if (!seen.has(key)) seen.set(key, c);
  }
  return { claims: [...seen.values()], stats };
}

function nearestScript(scriptSpans, pos) {
  let best = null, dist = Infinity;
  for (const sp of scriptSpans) {
    const d = Math.abs(sp.s - pos);
    if (d < dist) { dist = d; best = sp.v; }
  }
  return best;
}

// ── verification ──────────────────────────────────────────────────────────────

export function makeContext(cfg, { vaultDir } = {}) {
  const files = tracked();
  const trackedSet = new Set(files);
  const basenames = new Map();
  for (const f of files) {
    const b = basename(f);
    if (!basenames.has(b)) basenames.set(b, []);
    basenames.get(b).push(f);
  }
  const invokers = invokerFiles(files);
  const textCache = new Map();
  const fileText = (f) => {
    if (!textCache.has(f)) {
      try { textCache.set(f, readFileSync(join(ROOT, f), 'utf8')); } catch { textCache.set(f, null); }
    }
    return textCache.get(f);
  };
  let inventory = null;
  try { inventory = JSON.parse(fileText('ops/monitoring/monitoring-inventory.json') || 'null'); } catch { inventory = null; }
  const invRows = inventory && Array.isArray(inventory.artifacts) ? inventory.artifacts : [];
  return {
    trackedSet, basenames, fileText, invRows,
    refs: (gatePath) => findInvocations(gatePath, invokers),
    vaultDir: vaultDir ?? dirname(CORPUS_PATH),
    vaultReachable: existsSync(dirname(CORPUS_PATH)),
  };
}

/**
 * Resolve a script span (repo path, bare basename, or host path whose committed ancestor is
 * tracked — every host monitoring artifact has one, per the inventory law) to a tracked repo path.
 */
function resolveScript(ctx, v) {
  if (ctx.trackedSet.has(v)) return v;
  const name = v.includes('/') ? basename(v) : v;
  const hits = ctx.basenames.get(name) || [];
  if (!hits.length) return null;
  return hits.find((h) => h.startsWith('scripts/')) || hits.find((h) => h.startsWith('ops/')) || hits[0];
}

/**
 * Verify one claim. Returns { status, detail } where status ∈
 * OK | MISSING | UNRESOLVED | STALE | UNREACHABLE | UNPROBED | REVIEW.
 * @param {any} claim @param {any} ctx @param {any} cfg
 */
export function verifyClaim(claim, ctx, cfg) {
  switch (claim.class) {
    case 'repo-path':
      return ctx.trackedSet.has(claim.value)
        ? { status: 'OK' }
        : { status: 'MISSING', detail: `not in git ls-files — the manual prescribes a file this repo does not track` };
    case 'root-file': {
      const real = cfg.root_file_map[claim.value];
      return ctx.trackedSet.has(real) ? { status: 'OK' } : { status: 'MISSING', detail: `${claim.value} maps to ${real}, which is not tracked` };
    }
    case 'basename':
      return ctx.basenames.has(claim.value)
        ? { status: 'OK' }
        : { status: 'UNRESOLVED', detail: `no tracked file has this basename — either the file moved repos or the name rotted` };
    case 'absence-repo':
      return !ctx.trackedSet.has(claim.value) && !ctx.basenames.has(basename(claim.value))
        ? { status: 'OK' }
        : { status: 'REVIEW', detail: `claimed absent (“DOES NOT EXIST”/retired) but a tracked file matches — the warning has gone stale in the other direction` };
    case 'absence-vault': {
      if (!ctx.vaultReachable) return { status: 'UNREACHABLE', detail: 'vault not reachable (CI) — local-only check' };
      return !existsSync(join(ctx.vaultDir, claim.value))
        ? { status: 'OK' }
        : { status: 'REVIEW', detail: `claimed retired/absent but the vault file still exists` };
    }
    case 'vault-path': {
      if (!ctx.vaultReachable) return { status: 'UNREACHABLE', detail: 'vault not reachable (CI) — local-only check' };
      return existsSync(join(ctx.vaultDir, claim.value))
        ? { status: 'OK' }
        : { status: 'MISSING', detail: `vault file/dir not found at ${join(ctx.vaultDir, claim.value)}` };
    }
    case 'home-path': {
      const p = claim.value.replace(/^~/, homedir());
      return existsSync(p) ? { status: 'OK' } : { status: 'MISSING', detail: `not found at ${p} (existence-only probe)` };
    }
    case 'host-path':
      return { status: 'UNPROBED', detail: 'host probes run only under --probe-hosts (read-only)' };
    case 'env-var': {
      try {
        execFileSync('git', ['grep', '-l', '-F', claim.value], { cwd: ROOT, stdio: 'pipe' });
        return { status: 'OK' };
      } catch {
        try {
          execFileSync('git', ['grep', '-l', '-F', claim.value.slice(0, -1)], { cwd: ROOT, stdio: 'pipe' });
          return { status: 'OK', detail: 'name found without “=”' };
        } catch {
          return { status: 'REVIEW', detail: `token appears in no tracked file` };
        }
      }
    }
    case 'script-content': {
      if (claim.token) {
        // pass if ANY script named on the claim's line emits the token, nearest first
        const tried = [];
        for (const cand of claim.candidates || [claim.value]) {
          const p = resolveScript(ctx, cand);
          if (!p) continue;
          const t = ctx.fileText(p);
          if (t != null && t.includes(claim.token)) return { status: 'OK' };
          tried.push(p);
        }
        return { status: 'REVIEW', detail: `none of [${tried.join(', ')}] emit ${claim.token}` };
      }
      // a code claim holds if the script shows every (code, meaning) association in any form —
      // literal exit, ternary/map, constant (EXIT_CRITICAL_BYPASS = 2), or contract header —
      // via bounded, case-insensitive, hyphen/underscore-tolerant proximity
      const missingIn = (text) => (claim.codes || []).filter(({ code, meaning }) => {
        const m = meaning.replace(/[-_]/g, '[-_ ]?');
        return !new RegExp(`${m}\\D{0,20}${code}\\b|\\b${code}\\D{0,20}${m}`, 'i').test(text);
      });
      const tried = [];
      for (const cand of claim.candidates || [claim.value]) {
        const p = resolveScript(ctx, cand);
        if (!p) continue;
        const t = ctx.fileText(p);
        if (t == null) continue;
        if (missingIn(t).length === 0) return { status: 'OK' };
        tried.push(p);
      }
      if (!tried.length) return { status: 'UNRESOLVED', detail: `script ${claim.value} not tracked` };
      return { status: 'REVIEW', detail: `no script on the claim line satisfies ${claim.codes.map((m) => `${m.code}=${m.meaning}`).join(', ')} (tried ${tried.join(', ')})` };
    }
    case 'cron-schedule': {
      const rows = ctx.invRows.filter((r) => r.artifact && basename(r.artifact) === basename(claim.script));
      if (!rows.length) return { status: 'REVIEW', detail: `no monitoring-inventory row for ${claim.script} — schedule claim unverifiable against the committed SoT` };
      const [min, hour] = claim.value.split(' ');
      return rows.some((r) => typeof r.schedule === 'string' && r.schedule.startsWith(`${min} ${hour}`))
        ? { status: 'OK' }
        : { status: 'REVIEW', detail: `inventory schedule(s) [${rows.map((r) => r.schedule).join(' | ')}] do not start with “${min} ${hour}”` };
    }
    case 'wiring': {
      const path = resolveScript(ctx, claim.value);
      if (!path) return { status: 'MISSING', detail: `wired-claim subject ${claim.value} is not tracked` };
      const refs = ctx.refs(path);
      const bad = [];
      for (const point of claim.points) {
        if (point === 'prepublishOnly') {
          const pkg = JSON.parse(ctx.fileText('package.json') || '{}');
          if (!String(pkg.scripts?.prepublishOnly || '').includes(basename(path))) bad.push(point);
          continue;
        }
        const candidates = cfg.wiring_point_map[point] || [];
        // an entry ending in "/" or "_" is a PREFIX (tests/, scripts/install_ — per-gate hook installers)
        const hit = refs.some((r) => candidates.some((c) => (/[/_]$/.test(c) ? r.startsWith(c) : r === c)));
        if (!hit) bad.push(point);
      }
      return bad.length
        ? { status: 'MISSING', detail: `claimed wired into [${claim.points.join(', ')}] but no invocation found for [${bad.join(', ')}] (resolved via check-canaries-wired.mjs; live refs: ${refs.join(', ') || 'none'})` }
        : { status: 'OK' };
    }
    default:
      return { status: 'REVIEW', detail: `unknown class ${claim.class}` };
  }
}

/** Which severities fail the gate, per the config ladder. */
export function isBlocking(claim, result, cfg) {
  if (result.status === 'OK' || result.status === 'UNREACHABLE' || result.status === 'UNPROBED') return false;
  const cls = claim.class === 'absence-repo' || claim.class === 'absence-vault' ? 'absence' : claim.class;
  const ship = cfg.classes[cls]?.ship;
  return ship === 'block';
}

// ── lock ──────────────────────────────────────────────────────────────────────

export function buildLock(rawText, cfg) {
  const { claims } = extractClaims(rawText, cfg);
  const lockClaims = claims
    .filter((c) => LOCK_CLASSES.has(c.class))
    .sort((a, b) => a.line - b.line || a.class.localeCompare(b.class) || a.value.localeCompare(b.value));
  return {
    _comment: 'GENERATED by scripts/check-claudemd-claims.mjs --sync from the vault CLAUDE.md. Identifiers only — the manual’s prose never enters this repo. Do not hand-edit; --check fails on any divergence from a fresh extraction.',
    corpus_sha256: createHash('sha256').update(rawText).digest('hex'),
    corpus_lines: rawText.split('\n').length,
    claims: lockClaims,
  };
}

// ── check runner ──────────────────────────────────────────────────────────────

function printFinding(kind, claim, result, corpusLineText) {
  const loc = `CLAUDE.md L${claim.line}`;
  const what = claim.token || (claim.codes ? `exit ${claim.codes.join('/')}` : '') || (claim.points ? `→ ${claim.points.join('+')}` : '');
  console.log(`  ${kind} [${claim.class}] ${loc}  ${claim.value} ${what ? `(${what}) ` : ''}— ${result.status}${result.detail ? `: ${result.detail}` : ''}`);
  if (corpusLineText) console.log(`      claim line: ${corpusLineText.trim().slice(0, 160)}`);
  if (kind === '✖') {
    console.log(`      fix: correct the claim at ${loc} (add a _( … )_ note preserving the history), or add an exemption row WITH a reason to ops/claudemd-claim-config.json; then run: node scripts/check-claudemd-claims.mjs --sync`);
  }
}

function runCheck(cfg, { probeHosts = false } = {}) {
  const ctx = makeContext(cfg);
  const corpusReadable = existsSync(CORPUS_PATH);
  let claims, freshLock = null, corpusLines = null, stats = null;

  if (corpusReadable) {
    const rawText = readFileSync(CORPUS_PATH, 'utf8');
    corpusLines = rawText.split('\n');
    if (!rawText.trim()) return { verdict: 'INDETERMINATE', why: `corpus at ${CORPUS_PATH} is empty` };
    const ex = extractClaims(rawText, cfg);
    claims = ex.claims; stats = ex.stats;
    freshLock = buildLock(rawText, cfg);
    if (!existsSync(LOCK_PATH)) {
      return { verdict: 'FAIL', why: `lock missing at ops/claudemd-claims.lock.json — run: node scripts/check-claudemd-claims.mjs --sync (and commit the lock)` };
    }
    const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
    if (lock.corpus_sha256 !== freshLock.corpus_sha256 || JSON.stringify(lock.claims) !== JSON.stringify(freshLock.claims)) {
      return { verdict: 'FAIL', why: `lock is STALE vs the live corpus (CLAUDE.md changed, or the lock was hand-edited) — run: node scripts/check-claudemd-claims.mjs --sync (and commit the lock)` };
    }
    console.log(`corpus: ${CORPUS_PATH} (reachable; ${corpusLines.length} lines, ${stats.blocks} correction blocks stripped) — lock fresh`);
  } else {
    if (!existsSync(LOCK_PATH)) return { verdict: 'INDETERMINATE', why: 'corpus unreachable AND lock missing — nothing to verify' };
    const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
    claims = lock.claims;
    if (!Array.isArray(claims)) return { verdict: 'INDETERMINATE', why: 'lock is malformed (claims not an array)' };
    console.log(`corpus: UNREACHABLE (CI) — verifying committed lock (${claims.length} claims, corpus sha ${String(lock.corpus_sha256).slice(0, 12)}…)`);
  }

  if (!claims.length) return { verdict: 'INDETERMINATE', why: 'zero claims extracted — vacuous run refuses to report a pass' };

  let blockFails = 0, reports = 0, ok = 0, unreachable = 0, unprobed = 0;
  for (const claim of claims) {
    if (claim.class === 'host-path' && probeHosts) {
      // read-only remote existence probe, only on explicit request
      try {
        execFileSync('ssh', ['-o', 'ConnectTimeout=6', '-i', join(homedir(), '.ssh', 'algovault_deploy'), 'root@204.168.185.24', `test -e '${claim.value.replace(/'/g, '')}'`], { stdio: 'pipe' });
        ok++; continue;
      } catch {
        reports++;
        printFinding('⚠', claim, { status: 'REVIEW', detail: 'not found on signal host (read-only probe; may live on another host)' }, corpusLines?.[claim.line - 1]);
        continue;
      }
    }
    const result = verifyClaim(claim, ctx, cfg);
    if (result.status === 'OK') { ok++; continue; }
    if (result.status === 'UNREACHABLE') { unreachable++; continue; }
    if (result.status === 'UNPROBED') { unprobed++; continue; }
    if (isBlocking(claim, result, cfg)) {
      blockFails++;
      printFinding('✖', claim, result, corpusLines?.[claim.line - 1]);
    } else {
      reports++;
      printFinding('⚠', claim, result, corpusLines?.[claim.line - 1]);
    }
  }
  console.log(`\nclaims: ${claims.length} verified — ${ok} OK · ${blockFails} blocking · ${reports} report-only · ${unreachable} unreachable (local-only class in CI) · ${unprobed} unprobed (host)`);
  if (blockFails) return { verdict: 'FAIL', why: `${blockFails} blocking claim failure(s) — the prescriptive SoT asserts something the repo contradicts` };
  return { verdict: 'PASS' };
}

// ── measure (R1, reproducible) ────────────────────────────────────────────────

function runMeasure(cfg) {
  if (!existsSync(CORPUS_PATH)) { console.error('corpus unreachable — --measure needs the vault'); process.exit(3); }
  const rawText = readFileSync(CORPUS_PATH, 'utf8');
  const ctx = makeContext(cfg);
  for (const stripOn of [false, true]) {
    const { claims, stats } = extractClaims(rawText, cfg, { stripCorrections: stripOn });
    let fires = 0;
    const list = [];
    for (const c of claims) {
      const r = verifyClaim(c, ctx, cfg);
      if (r.status !== 'OK' && r.status !== 'UNREACHABLE' && r.status !== 'UNPROBED') { fires++; list.push(`${c.class} L${c.line} ${c.value} → ${r.status}`); }
    }
    console.log(`\nstrip=${stripOn}: spans=${stats.spans} claims=${claims.length} would-fire=${fires}`);
    for (const l of list) console.log('   ' + l);
  }
  console.log(`\ncorrection blocks: ${findCorrectionBlocks(rawText).length}; corpus sha ${createHash('sha256').update(rawText).digest('hex').slice(0, 16)}…`);
}

// ── self-test ─────────────────────────────────────────────────────────────────

const FIXTURES = join(ROOT, 'tests', 'fixtures', 'claudemd');

export function selfTest(cfg) {
  const fails = [];
  const ctx = makeContext(cfg);
  const fx = (name) => {
    const p = join(FIXTURES, name);
    if (!existsSync(p)) { fails.push(`fixture missing: ${name}`); return null; }
    return readFileSync(p, 'utf8');
  };
  const firingsOf = (text) => {
    const { claims } = extractClaims(text, cfg);
    return claims.map((c) => ({ c, r: verifyClaim(c, ctx, cfg) })).filter(({ r }) => r.status !== 'OK' && r.status !== 'UNREACHABLE' && r.status !== 'UNPROBED');
  };

  // (a) a prescriptive dead repo path MUST fire, and as a BLOCKING class
  const live = fx('live-dead-path.md');
  if (live) {
    const f = firingsOf(live);
    if (f.length !== 1) fails.push(`live dead path: expected exactly 1 firing, got ${f.length}`);
    else if (!isBlocking(f[0].c, f[0].r, cfg)) fails.push('live dead path fired but was not blocking');
  }
  // (b) the SAME dead path inside a _( … )_ correction block MUST NOT fire (AC2)
  const hist = fx('hist-dead-path.md');
  if (hist) {
    const { claims } = extractClaims(hist, cfg);
    if (claims.length !== 0) fails.push(`historical block: expected 0 claims, got ${claims.length}`);
    const noStrip = extractClaims(hist, cfg, { stripCorrections: false });
    if (noStrip.claims.length === 0) fails.push('strip A/B is vacuous: the historical fixture yields no claims even WITHOUT the strip');
  }
  // (c) clean fixture: several true claims, zero firings, non-vacuous
  const clean = fx('clean.md');
  if (clean) {
    const { claims } = extractClaims(clean, cfg);
    if (claims.length < 4) fails.push(`clean fixture vacuous: only ${claims.length} claims extracted`);
    const f = firingsOf(clean);
    if (f.length !== 0) fails.push(`clean fixture fired: ${f.map(({ c, r }) => `${c.value}→${r.status}`).join(', ')}`);
  }
  // (d) vacuity: an empty corpus must never verify anything
  const { claims: none } = extractClaims('no backticks here.\n', cfg);
  if (none.length !== 0) fails.push('empty corpus produced claims');
  // (e) absence inverse: an absence claim on an EXISTING file must fire
  const inv = firingsOf('`scripts/check-canaries-wired.mjs` DOES NOT EXIST — never built.\n');
  if (inv.length !== 1 || inv[0].r.status !== 'REVIEW') fails.push('absence claim on an existing file did not fire');
  // (f) wiring negative: a script NOT in prepublishOnly claimed wired there must fire
  const wneg = firingsOf('the gate `scripts/backtest.ts` is wired into `prepublishOnly`.\n');
  if (wneg.length !== 1) fails.push(`wiring negative: expected 1 firing, got ${wneg.length}`);
  // (g) wiring positive resolves through check-canaries-wired.mjs on the real tree
  const wpos = firingsOf('the meta-canary `scripts/check-canaries-wired.mjs` is wired into `deploy.yml`.\n');
  if (wpos.length !== 0) fails.push(`wiring positive fired: ${wpos.map(({ r }) => r.detail).join('; ')}`);
  // (h) nested parens inside a correction block are stripped correctly
  const nested = extractClaims('ok. _(Corrected — the prior line (see `scripts/gone-file.mjs` (v2)) was wrong.)_\n', cfg);
  if (nested.claims.length !== 0) fails.push('nested-paren correction block leaked a claim');
  // (i) config validation fail-closed: an exemption row without a reason must be rejected
  const bad = JSON.parse(JSON.stringify(cfg));
  bad.exemptions.push({ value: 'x', class: 'env-var' });
  let threw = false;
  try { validateConfig(bad); } catch { threw = true; }
  if (!threw) fails.push('validateConfig accepted an exemption row without a reason');
  return fails;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const IS_MAIN = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

function emit(verdict, why) {
  if (why) console.log(`\n${verdict === 'FAIL' ? '✖' : 'ℹ'} ${why}`);
  console.log(`CLAUDEMD_CLAIMS_VERDICT=${verdict}`);
  const warn = process.env.ALGOVAULT_CLAUDEMD_GATE === 'warn';
  const code = verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 1 : 3;
  if (warn && code !== 0) {
    console.log('⚠ ALGOVAULT_CLAUDEMD_GATE=warn — exit code downgraded; the token above is the truth.');
    process.exit(0);
  }
  process.exit(code);
}

if (IS_MAIN) {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    console.error(`✖ config unusable: ${e.message}`);
    emit('INDETERMINATE', `ops/claudemd-claim-config.json missing or invalid — fail-closed`);
  }

  if (argv.includes('--self-test')) {
    const fails = selfTest(cfg);
    if (fails.length) { console.error('✖ claudemd-claims self-test FAILED:'); fails.forEach((f) => console.error('   - ' + f)); process.exit(1); }
    console.log('✓ claudemd-claims self-test passed (dead prescriptive path fires; correction blocks do not; vacuity guarded both ways)');
    process.exit(0);
  }
  if (argv.includes('--measure')) { runMeasure(cfg); process.exit(0); }
  if (argv.includes('--sync')) {
    if (!existsSync(CORPUS_PATH)) emit('INDETERMINATE', `--sync needs the corpus; not found at ${CORPUS_PATH}`);
    const rawText = readFileSync(CORPUS_PATH, 'utf8');
    const lock = buildLock(rawText, cfg);
    const next = JSON.stringify(lock, null, 2) + '\n';
    const prev = existsSync(LOCK_PATH) ? readFileSync(LOCK_PATH, 'utf8') : null;
    if (prev === next) { console.log(`lock already fresh (${lock.claims.length} claims, corpus sha ${lock.corpus_sha256.slice(0, 12)}…)`); process.exit(0); }
    writeFileSync(LOCK_PATH, next);
    console.log(`lock written: ${lock.claims.length} claims, corpus sha ${lock.corpus_sha256.slice(0, 12)}… — commit ops/claudemd-claims.lock.json`);
    process.exit(0);
  }

  // default: --check. Self-test first — a verifier that cannot detect a planted defect must not report.
  const stFails = selfTest(cfg);
  if (stFails.length) {
    console.error('✖ claudemd-claims self-test FAILED — refusing to report a vacuous pass:');
    stFails.forEach((f) => console.error('   - ' + f));
    emit('INDETERMINATE', 'self-test failure');
  }
  const { verdict, why } = runCheck(cfg, { probeHosts: argv.includes('--probe-hosts') });
  emit(verdict, why);
}
