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
 * THE CORPUS IS A SET (META-CLAUDEMD-VERIFIER-CORPUS-SET-W1, 2026-08-12). CLAUDE.md was split into
 * a router plus six trigger-read rule bodies under `Claude files/rules/`. The parts are DECLARED in
 * ops/claudemd-claim-config.json at `_corpus_enumeration.in[CLAUDE.md].parts` — an explicit ordered
 * list, never a glob — extracted per part and MERGED, deduped by claimId. Three properties make the
 * split provably lossless: claimId carries no location, extraction is heading-agnostic, and every
 * `Claude files/…` path contains a space so the router's own links mint no claims. Absent `parts`,
 * behaviour is byte-for-byte the old single-path one. `vaultDir` stays anchored on the CLAUDE.md
 * entry; a listed part missing on disk is INDETERMINATE, never a pass.
 *
 * Usage:
 *   node scripts/check-claudemd-claims.mjs --self-test   # two-directional, vacuity-guarded
 *   node scripts/check-claudemd-claims.mjs --check       # verify (default). CI: lock-mode.
 *   node scripts/check-claudemd-claims.mjs --sync        # regenerate the lock from the corpus
 *   node scripts/check-claudemd-claims.mjs --measure     # R1 corpus measurement, incl. strip A/B
 *   node scripts/check-claudemd-claims.mjs --probe-hosts # with --check: read-only host probes
 *   node scripts/check-claudemd-claims.mjs --baseline <f> # LOCAL: live claim set vs a recorded
 *                                                         # pre-split baseline. Own token.
 *
 * Verdict: exactly one terminal `CLAUDEMD_CLAIMS_VERDICT=PASS|FAIL|INDETERMINATE`
 * (`--baseline` emits `CLAUDEMD_BASELINE_VERDICT=` instead — a different gate, a different token).
 * Exit: 0 = PASS · 1 = FAIL · 3 = INDETERMINATE (token-law default for a new gate).
 * FAIL-CLOSED: missing/invalid config, missing lock (in CI), unreadable corpus (when required),
 * or a vacuous extraction (0 claims from a non-empty corpus) is INDETERMINATE and blocks.
 * ALGOVAULT_CLAUDEMD_GATE=warn downgrades the EXIT CODE only — never the token.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, basename } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { assertPromotionBound } from './lib/promotion-bound.mjs';
import { tracked, invokerFiles, findInvocations } from './check-canaries-wired.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = join(ROOT, 'ops', 'claudemd-claim-config.json');
// Overridable for the same reason CORPUS_PATH is: the freshness contract can only be tested by
// driving a fixture corpus AND its own lock, and a test that had to overwrite the committed lock
// to prove anything would be a test nobody dares run.
const LOCK_PATH = process.env.ALGOVAULT_CLAUDEMD_LOCK || join(ROOT, 'ops', 'claudemd-claims.lock.json');
const DEFAULT_CORPUS = join(homedir(), 'My Drive', 'Obsidian Vault', 'AlgoVault MCP', 'CLAUDE.md');
const CORPUS_ENV = 'ALGOVAULT_CLAUDEMD_CORPUS';
// A NARROW seam: it names WHICH FILES form the corpus and nothing else. The rejected alternative
// was an ALGOVAULT_CLAUDEMD_CONFIG override, which would also have exposed the severity ladder —
// a strictly broader risk class, and the ladder must never become settable. Same reasoning as
// narrow-token-over-wide-scope. No committed invocation sets this; it exists so the missing-part
// refusal can be proven END-TO-END through the real CLI rather than only in-process.
const PARTS_ENV = 'ALGOVAULT_CLAUDEMD_CORPUS_PARTS';

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
  for (const key of ['classes', 'exemptions', 'root_file_map', 'wiring_point_map', 'repo_prefixes', 'vault_names', 'vault_prefixes', 'absence_markers', 'nonclaim_markers', 'report_class_promotion', 'freshness_severity', 'freshness_promotion']) {
    if (!(key in cfg)) throw new Error(`config missing required key: ${key}`);
  }
  for (const row of cfg.exemptions) {
    if (!row.reason || typeof row.reason !== 'string') throw new Error(`exemption row ${JSON.stringify(row.value)} has no reason`);
  }
  // Both promotion blocks go through the SHARED assertion (OPS-AUTHOR-IDENTITY-PROMOTE-W1 R4b).
  // Single derivation: the inline checks that used to live here and below are gone, not merely
  // supplemented — leaving one beside the shared call would reproduce the duplication the shared
  // assertion exists to retire, and a second copy is what goes stale.
  assertPromotionBound(cfg.report_class_promotion, 'report_class_promotion');
  assertPromotionBound(cfg.freshness_promotion, 'freshness_promotion');
  // Every staleness severity is DECLARED with its own reason. A severity that lives only in code
  // gets "fixed" by a future wave enforcing the contract — the same argument as the exemption rows.
  const FRESHNESS_SEVERITIES = ['STALE_SYNCABLE', 'STALE_IN_FLIGHT', 'STALE_UNPUBLISHED', 'STALE_DROPPED'];
  for (const severity of FRESHNESS_SEVERITIES) {
    const row = (cfg.freshness_severity || []).find((r) => r.severity === severity);
    if (!row) throw new Error(`freshness_severity is missing a row for ${severity} — all four must be declared`);
    if (!row.reason || typeof row.reason !== 'string') throw new Error(`freshness_severity row ${severity} has no reason`);
    // Build Rule 6: no new BLOCK condition ships in this wave. A config that quietly flips one to
    // block would bypass the promotion criterion below, which is the whole control.
    if (row.ship !== 'report') throw new Error(`freshness_severity row ${severity} must ship 'report' — promotion is owned by ${cfg.freshness_promotion?.owner ?? 'the freshness_promotion criterion'}, not an inline edit`);
  }
  // (freshness_promotion's bound checks moved to the shared assertPromotionBound call above —
  //  see OPS-AUTHOR-IDENTITY-PROMOTE-W1 R4b. Deliberately not restated here.)
  // ── corpus PARTS (META-CLAUDEMD-VERIFIER-CORPUS-SET-W1 R2) ───────────────────────────────────
  // `parts` is a declaration WE author, so a malformed one is VACUITY and must refuse — the same
  // argument as the exemption rows, and the same law as "a vacuity guard belongs where the corpus
  // is CONSTRUCTED". ABSENT is not malformed: it is the single-path fallback, and it is the
  // regression bar. Every rule below is structural on purpose; the alternative is prose, and a
  // rule that lives only in prose gets "fixed" by a future wave enforcing the contract.
  const corpusEntry = corpusEntryOf(cfg);
  if (corpusEntry && 'parts' in corpusEntry) {
    const parts = corpusEntry.parts;
    if (!Array.isArray(parts) || !parts.length) {
      throw new Error('_corpus_enumeration.in[CLAUDE.md].parts must be a NON-EMPTY array — an empty declaration is vacuity, not "this corpus has no parts"; delete the key to fall back to single-path');
    }
    if (!parts.every((p) => typeof p === 'string' && p.trim())) {
      throw new Error('every corpus part must be a non-empty string path');
    }
    if (parts[0] !== corpusEntry.corpus) {
      throw new Error(`corpus parts[0] is "${parts[0]}" but must be the anchor "${corpusEntry.corpus}" — vaultDir, and therefore every vault-path/absence-vault/home-path claim, resolves against dirname(anchor)`);
    }
    for (const p of parts) {
      if (/[*?[\]]/.test(p)) {
        throw new Error(`corpus part "${p}" contains glob metacharacters — parts are an EXPLICIT list so that adding one is a reviewed act; see _parts_semantics`);
      }
      if (/^_ORIGINAL-CLAUDE-md-/.test(basename(p))) {
        throw new Error(`corpus part "${p}" is the frozen pre-split snapshot — listing it would resurrect superseded claims as prescriptive and the claim set could never shrink; see _parts_semantics`);
      }
    }
    if (new Set(parts).size !== parts.length) throw new Error('corpus parts contains a duplicate path');
    if (!corpusEntry._parts_semantics) {
      throw new Error('_corpus_enumeration.in[CLAUDE.md] declares `parts` but no `_parts_semantics` — write the reason ON the key, or a future wave deletes what it cannot explain');
    }
  }
  return cfg;
}

/** The `_corpus_enumeration.in` row for the CLAUDE.md corpus, or undefined. */
export function corpusEntryOf(cfg) {
  return (cfg?._corpus_enumeration?.in || []).find((e) => e && e.corpus === 'CLAUDE.md');
}

export function loadConfig() {
  return validateConfig(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')));
}

// ── corpus resolution (META-CLAUDEMD-VERIFIER-CORPUS-SET-W1 R3) ───────────────
//
// The corpus is a SET. On 2026-08-12 the vault CLAUDE.md was split into a router plus six
// trigger-read rule bodies; the verifier still read ONE hardcoded path, so it saw 17 of 114 claims
// and reported the other 97 as STALE_DROPPED — a "report" severity — while printing PASS. A gate
// that verifies 15% of its corpus and passes is the dark-guard class this file exists to retire.
//
// This is a FUNCTION and not a module-level const on purpose: a const is resolved once at import,
// so no self-test scenario can drive a second corpus in the same process. That is precisely the
// seam the old design could not test, and R4's scenarios all depend on re-resolving.

/**
 * Resolve the corpus to ONE anchor plus an ORDERED part list.
 *
 * `vaultDir` is ALWAYS `dirname(anchor)` and never `dirname(part)`. Measured: 4 of the 15
 * `vault-path` claims and all 3 `home-path` claims now live in `Claude files/rules/*`, so rebasing
 * on the part being read produces 11 spurious `vault-path MISSING` firings.
 *
 * @returns {{anchor:string, parts:string[], vaultDir:string, source:string, error?:undefined}
 *          |{error:string}}
 */
export function resolveCorpus(cfg, env = process.env) {
  const single = env[CORPUS_ENV];
  const many = env[PARTS_ENV];
  // No silent precedence: two declarations with no defined order is exactly the ambiguity that
  // makes a gate unfalsifiable. Refuse, fail-closed.
  if (single && many) {
    return { error: `${CORPUS_ENV} and ${PARTS_ENV} are both set — two corpus declarations with no defined precedence. Unset one.` };
  }
  // The single-file seam keeps its exact meaning: THAT ONE FILE ONLY. Every existing fixture-driven
  // test depends on it, and so does the pre-split baseline measurement.
  if (single) return { anchor: single, parts: [single], vaultDir: dirname(single), source: 'env-single' };
  if (many) {
    const list = many.split(/[:\n]/).map((s) => s.trim()).filter(Boolean);
    if (!list.length) return { error: `${PARTS_ENV} is set but names no path — a declaration we author, so empty is vacuity rather than "no parts"` };
    return { anchor: list[0], parts: list, vaultDir: dirname(list[0]), source: 'env-parts' };
  }
  const anchor = DEFAULT_CORPUS;
  const vaultDir = dirname(anchor);
  const declared = corpusEntryOf(cfg)?.parts;
  // ABSENT `parts` ⇒ today's single-path behaviour, byte for byte. This is the regression bar.
  if (!Array.isArray(declared) || !declared.length) return { anchor, parts: [anchor], vaultDir, source: 'default-single' };
  return { anchor, parts: declared.map((p) => join(vaultDir, p)), vaultDir, source: 'config-parts' };
}

/**
 * Read every part. A listed part we cannot read is INDETERMINATE, never a pass: it is input we were
 * HANDED and could not parse, which is the fail-closed side of the vacuity law — and distinct from
 * an unreachable ANCHOR, which means "no corpus in this world" (CI) and keeps its lock-mode path.
 */
export function readCorpusParts(paths) {
  const parts = [], missing = [];
  for (const p of paths) {
    let text;
    try { text = readFileSync(p, 'utf8'); } catch { missing.push(p); continue; }
    parts.push({ path: p, name: basename(p), text, sha: createHash('sha256').update(text).digest('hex') });
  }
  return { parts, missing };
}

/**
 * The manual's own top-level sections. EXACTLY ONE part — the anchor — may carry them.
 * Prefix-matched: the live headings are `## Precedence (THE LAW)` etc.
 */
const MANUAL_ANCHOR_SECTIONS = ['## Precedence', '## FACTUALITY', '## Execution flow', '## Never'];

/**
 * Parts that are a SECOND COPY OF THE WHOLE MANUAL rather than a fragment of it.
 *
 * The filename guard in validateConfig refuses `_ORIGINAL-CLAUDE-md-*` by NAME; this refuses the
 * same defect STRUCTURALLY, so a renamed or re-dated snapshot cannot slip in.
 *
 * ── TWO REJECTED FORMS, AND WHY, BECAUSE THE OBVIOUS ONES ARE BOTH WRONG ────────────────────
 * (a) "one part's TEXT contains another's" — MEASURED, and it does not fire on the real case: the
 *     live snapshot is not a substring of any part (CLAUDE.md gained a Rule Router; every rule
 *     body gained a header), so the guard would have advertised coverage it did not have.
 * (b) "some part contributes ZERO unique claim ids" — measured clean TODAY (each real part
 *     contributes 2..26 unique ids; adding the snapshot drives every part to 0). REJECTED anyway,
 *     and this is the important one: the moment a live part EDITS a claim, the snapshot starts
 *     contributing the SUPERSEDED id as a unique one, so the signal disappears exactly when the
 *     harm begins. A guard that fires while harmless and goes silent once dangerous is worse than
 *     none — it is the dark-guard class wearing a green tick.
 *
 * What is used instead is a structural invariant that does NOT decay: a rule BODY never carries
 * the manual's top-level LAW sections, and a full manual always does. Measured 2026-08-12: anchor
 * 4/4, frozen snapshot 4/4, all six rule bodies 0/4. Threshold-free, and it keeps firing after the
 * snapshot diverges — which is the only property that matters here.
 */
export function duplicateManualParts(parts, anchorName) {
  const bad = [];
  const seenSha = new Map();
  for (const p of parts) {
    // Byte-identical parts under two names: exact, free, and no heuristic.
    if (seenSha.has(p.sha)) bad.push({ part: p.path, why: `byte-identical to ${seenSha.get(p.sha)}`, sections: [] });
    else seenSha.set(p.sha, p.path);
    if (p.name === anchorName) continue;
    const hits = MANUAL_ANCHOR_SECTIONS.filter((s) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm').test(p.text));
    // >= 2 so that one incidental heading in a rule body cannot refuse the whole gate.
    if (hits.length >= 2) bad.push({ part: p.path, why: `carries the manual's own top-level sections (${hits.join(', ')}) — this is a SECOND FULL MANUAL, not a fragment`, sections: hits });
  }
  return bad;
}

/**
 * Extract over every part and MERGE into one claim list, deduped by `claimId`: a claim asserted in
 * two parts is ONE claim. Measured on the live corpus — 135 raw claims across 7 parts collapse to
 * 114 ids, so 21 are genuine cross-part restatements and the dedupe is load-bearing, not cosmetic.
 *
 * `part` is stamped as LOCATION and is treated exactly like `line`: it makes findings readable and
 * it is excluded from `claimId` and stripped by `buildLock`. If it entered identity, relocating a
 * rule would change every id — which is the very thing this wave proves does not happen.
 * First occurrence wins, so a deduped claim reports the EARLIEST part in the declared order; that
 * is stable because parts are an explicit ordered list rather than a glob.
 */
export function extractCorpusClaims(parts, cfg, opts = {}) {
  const claims = [];
  const stats = { spans: 0, skipped: 0, blocks: 0, lines: 0, parts: [] };
  for (const part of parts) {
    const ex = extractClaims(part.text, cfg, opts);
    stats.spans += ex.stats.spans;
    stats.skipped += ex.stats.skipped;
    stats.blocks += ex.stats.blocks;
    stats.lines += part.text.split('\n').length;
    stats.parts.push({ name: part.name, claims: ex.claims.length, spans: ex.stats.spans, blocks: ex.stats.blocks });
    for (const c of ex.claims) claims.push({ ...c, part: part.name });
  }
  const seen = new Map();
  for (const c of claims) {
    const id = claimId(c);
    if (!seen.has(id)) seen.set(id, c);
  }
  return { claims: [...seen.values()], rawCount: claims.length, stats };
}

/** Provenance over a SET: a digest of the ordered per-part hashes. Never compared to anything. */
export function corpusProvenance(parts) {
  const h = createHash('sha256');
  for (const p of parts) h.update(`${p.sha}  ${p.name}\n`);
  return h.digest('hex');
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
  let docClaims = null;
  try { docClaims = JSON.parse(fileText('ops/monitoring/doc-host-path-claims.json') || 'null'); } catch { docClaims = null; }
  // ANCHORED on the CLAUDE.md entry, never on whichever part is being read — see resolveCorpus.
  // `vaultReachable` now follows the SAME directory as `vaultDir`: it used to key off the module
  // const regardless of the override, so a caller could relocate vaultDir and still be told the
  // old one was reachable. That mattered the moment parts arrived.
  const resolved = resolveCorpus(cfg);
  const dir = vaultDir ?? (resolved.error ? dirname(DEFAULT_CORPUS) : resolved.vaultDir);
  return {
    trackedSet, basenames, fileText, invRows, docClaims,
    refs: (gatePath) => findInvocations(gatePath, invokers),
    vaultDir: dir,
    vaultReachable: existsSync(dir),
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
    case 'host-path': {
      // COVERAGE, not a second probe (OPS-CLAIM-VERIFIER-COVERAGE-W1). The TRUTH of a host path
      // is asserted on-host by monitoring-inventory-reconcile.py's DOC_PATH_CLAIM check, where
      // these are ordinary local files and no SSH is needed. What this gate owns is the inverse
      // question — is every host-path claim ROUTED there at all? A claim nobody routed is exactly
      // the blind spot W1 shipped, and asking "did my probe match something?" could never find it.
      const want = claim.value.replace(/\/+$/, '');
      // Inventory membership deliberately does NOT count as coverage, and this was MEASURED rather
      // than reasoned: simulate a DELETED send_telegram.sh against the live inventory and NOTHING
      // fires. HASH_DRIFT skips a file it cannot find ("absence is DARK/ORPHAN's business"), DARK
      // only looks at rows carrying a schedule and the wrapper has none, and ORPHAN runs host→repo
      // so a missing file is invisible to it. The shared alert wrapper every consumer depends on
      // could vanish silently. So an inventory row is not a substitute for an existence claim.
      const routed = (ctx.docClaims?.claims || []).some((c) => (c.path || '').replace(/\/+$/, '') === want);
      if (routed) return { status: 'OK', detail: 'routed to the daily on-host reconciler (DOC_PATH_CLAIM)' };
      const exempt = (ctx.docClaims?.exempt_claims || []).find((e) => e.value === claim.value);
      if (exempt) return { status: 'OK', detail: `exempt: ${exempt.reason.slice(0, 60)}…` };
      return {
        status: 'REVIEW',
        detail: `host-path claim is neither routed nor exempted — add a row to ops/monitoring/doc-host-path-claims.json (with hosts[] + expect + reason) so the daily reconciler checks it on-host, or an exempt_claims row explaining why it is not a real path claim`,
      };
    }
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
      return { status: 'REVIEW', detail: `no script on the claim line satisfies ${claim.codes.map(renderCodePair).join(', ')} (tried ${tried.join(', ')})` };
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

/** A declared in-flight race (OPS-CLAIM-VERIFIER-COVERAGE-W1), or undefined. */
export function inFlightRow(claim, cfg) {
  return (cfg.in_flight_claims || []).find((r) => r.value === claim.value && r.class === claim.class);
}

/** Which severities fail the gate, per the config ladder. */
export function isBlocking(claim, result, cfg) {
  if (result.status === 'OK' || result.status === 'UNREACHABLE' || result.status === 'UNPROBED') return false;
  // In flight on a pushed branch (stamped by --sync), or declared in config for the no-ref case.
  // Downgrades to REVIEW for that ONE claim — never for its class. See _in_flight_semantics.
  if (claim.in_flight) return false;
  // On NO remote ref at all — the file is in some session's working tree.
  // OPS-CLAUDEMD-CLAIM-PUBLISH-PRECONDITION-W1: the pusher can neither verify this nor fix it,
  // and the escape hatch (an in_flight_claims row) can only be authored honestly by the OWNING
  // session — so blocking here lands the verdict on someone with no move available. That is the
  // deadlock this gate kept causing, not the guard doing its job. The marker is stripped in CI,
  // where the world is merged and settled and a miss IS real.
  if (claim.unpublished && !claim.was_verified) return false;
  if (inFlightRow(claim, cfg)) return false;
  const cls = claim.class === 'absence-repo' || claim.class === 'absence-vault' ? 'absence' : claim.class;
  const ship = cfg.classes[cls]?.ship;
  return ship === 'block';
}

/**
 * In-flight declarations are self-cleaning: once the race resolves, the declaration is a lie about
 * the present, so it must be deleted. Returns the rows that have outlived their race.
 */
export function staleInFlight(claims, ctx, cfg) {
  const stale = [];
  for (const row of cfg.in_flight_claims || []) {
    const claim = claims.find((c) => c.value === row.value && c.class === row.class);
    if (!claim) { stale.push({ row, why: 'the claim is no longer made by CLAUDE.md at all' }); continue; }
    const r = verifyClaim(claim, ctx, cfg);
    if (r.status === 'OK') stale.push({ row, why: `the claim now RESOLVES (${row.wave} landed)` });
  }
  return stale;
}

// ── lock ──────────────────────────────────────────────────────────────────────

/**
 * The remote refs this checkout can see. Only consulted for a path that is NOT in the working
 * tree, so the cost is paid only when something is already anomalous.
 */
function remoteRefs() {
  try {
    return execFileSync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/remotes'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter((s) => s && !s.endsWith('/HEAD'));
  } catch { return []; }
}

/**
 * For each of `paths`, the first pushed ref whose tree contains it (or null). ONE `git cat-file
 * --batch-check` process for the whole cross-product — the naive form spawned a process per
 * (ref, path) pair, ~160 of them, which pushed the pre-push suite's copy of this gate past
 * vitest's 5s default and blocked a push whose tests all passed individually.
 *
 * MEASURED 2026-08-02, and the reason this exists at all: three concurrent sessions had edited the
 * shared vault CLAUDE.md to describe files still on their own un-merged branches. CLAUDE.md and the
 * repo are two shared artifacts with no shared transaction, so "the doc landed before the code" is
 * a routine race, not a defect — while "the file exists on no ref anywhere" is the real defect
 * class this gate was built for (a gate never built; a file moved). Collapsing the two would make
 * every wave hostage to every other wave's push order, and a gate that cries wolf gets disabled.
 */
function firstRefContaining(paths, refs) {
  const out = new Map(paths.map((p) => [p, null]));
  if (!paths.length || !refs.length) return out;
  const pairs = [];
  for (const p of paths) for (const ref of refs) pairs.push([p, ref]);
  let stdout = '';
  try {
    stdout = execFileSync('git', ['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
      cwd: ROOT, encoding: 'utf8', input: pairs.map(([p, ref]) => `${ref}:${p}`).join('\n') + '\n',
    });
  } catch { return out; }
  const lines = stdout.split('\n');
  pairs.forEach(([p, ref], i) => {
    // a hit prints "<sha> blob"; a miss prints "<rev> missing"
    if (out.get(p) === null && lines[i] && / blob$/.test(lines[i].trim())) out.set(p, ref);
  });
  return out;
}

/**
 * The identity of a claim: its class, its subject, AND the value it asserts.
 * OPS-CLAUDEMD-CLAIM-PUBLISH-PRECONDITION-W1.
 *
 * ── WHY THE ASSERTED VALUE MUST BE IN HERE ──────────────────────────────────────────────────
 * Freshness is now claim-set equality and `--sync` is id-gated, so an id that captured only the
 * SUBJECT would let a claim change WHAT IT ASSERTS while the id set stayed identical: the sync
 * would no-op and the lock would silently record a claim set that no longer matches the corpus's
 * meaning. That is not hypothetical in this corpus — `wiring` claims carry `points`, so
 * "scripts/foo.mjs is wired into pre-push" → "…into deploy.yml" is a same-subject, different-
 * assertion edit. Measured at design time: 10 of 102 claims carry an asserted value beyond their
 * subject (2 `wiring`, 8 `script-content`); the other 92 assert existence or absence, where the
 * subject IS the assertion.
 *
 * ── WHAT IS DELIBERATELY EXCLUDED ───────────────────────────────────────────────────────────
 * · `line` — line numbers shift on every prose edit, which is the whole defect being retired.
 *   They stay in MESSAGES, where they are useful, and out of IDENTITY, where they are poison.
 * · `candidates` — a RESOLUTION helper (which files the claim might refer to), not an assertion.
 *   Including it would re-introduce prose-sensitivity through the back door.
 * · prose, always — the corpus is private and must never enter this repo.
 *
 * Because this is line-agnostic, it computes the SAME id from an old-shape lock claim (which
 * carries `line`) as from a new one. That is what makes the migration back-compatible by
 * construction rather than by a legacy code path.
 */
/**
 * Render ONE (code, meaning) pair. This is the CANONICAL serialisation site — R3.2's "one of the
 * two, not both": `extractClaims` keeps emitting `{code, meaning}` objects, because `verifyClaim`
 * needs both halves to test the ASSOCIATION and the dedupe key needs the structure. Normalising at
 * extraction as well would be two places computing one identity, which is the drift shape this repo
 * forbids. Every consumer that renders a pair — claimId, printFinding, verifyClaim's REVIEW detail
 * — goes through here.
 *
 * `meaning` IS part of identity, and that is a measured decision rather than a stylistic one:
 * verifyClaim asserts the code↔meaning ASSOCIATION, so an id carrying only codes would collapse
 * check_test_baseline.sh's seven pairs to four codes and leave a `0=PASS` → `0=silent` swap
 * invisible — reintroducing exactly the blindness being retired.
 *
 * MEASURED 2026-08-08 (OPS-CLAUDEMD-CLAIM-FRESHNESS-SEVERITY-W1 CH1 §F4), and this is why the
 * function exists: claimId did `.map(String)` over those objects, so 6 of 113 ids rendered as
 * `exit:[object Object]/[object Object]/…` — encoding the NUMBER of pairs and nothing about their
 * values. Mutating `2=INDETERMINATE` to `7=INDETERMINATE` on the live corpus changed the extracted
 * codes array and left the entire 113-id set byte-identical. The gate was structurally incapable of
 * detecting an exit-code change: precisely the drift class it exists for, and the class of the
 * recorded check_test_baseline.sh 2-vs-3 incident where the SoT documented an undeployed code.
 */
export function renderCodePair(p) {
  if (p && typeof p === 'object' && 'code' in p) return p.meaning == null ? String(p.code) : `${p.code}=${p.meaning}`;
  return String(p); // primitives keep their own rendering; never the object default
}

export function claimId(c) {
  const base = `${c.class}:${c.value}`;
  if (c.class === 'wiring' && Array.isArray(c.points) && c.points.length) {
    return `${base}=${[...c.points].sort().join('+')}`;
  }
  if (c.class === 'script-content') {
    const parts = [];
    if (c.token) parts.push(`token:${c.token}`);
    // sort the RENDERED pairs, so the same assertion in any order has one id
    if (Array.isArray(c.codes) && c.codes.length) parts.push(`exit:${[...c.codes].map(renderCodePair).sort().join('/')}`);
    if (parts.length) return `${base}=${parts.join('|')}`;
  }
  return base;
}

/** The claim-id SET of a claim list — deduped and canonically ordered. */
export function claimIdSet(claims) {
  return [...new Set((claims || []).map(claimId))].sort();
}

/** Set equality over claim ids. The freshness predicate, and nothing else. */
export function sameClaimSet(a, b) {
  const x = claimIdSet(a), y = claimIdSet(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * The claim ids the CURRENT lock records as VERIFIED — no marker, so the path resolved when it was
 * synced. Best-effort: a missing or unparseable lock yields an empty set, because `--sync` has to
 * work on a fresh clone.
 */
export function verifiedIdsInLock(lockPath = LOCK_PATH) {
  try {
    const prev = JSON.parse(readFileSync(lockPath, 'utf8'));
    return new Set((prev.claims || []).filter((c) => !c.in_flight && !c.unpublished).map((c) => claimId(c)));
  } catch { return new Set(); }
}

export function buildLock(parts, cfg) {
  const { claims } = extractCorpusClaims(parts, cfg);
  const trackedSet = new Set(tracked());
  const refs = remoteRefs();
  // MEASURED 2026-08-08 (OPS-CLAUDEMD-CLAIM-FRESHNESS-SEVERITY-W1 CH1, §F6): without this, `--sync`
  // DESTROYS the one safety property this subsystem has. A claim locked as verified whose path was
  // then deleted is re-derived here, found on no ref, and stamped `unpublished` — which isBlocking
  // correctly treats as non-blocking. So the sequence "delete a prescribed file, edit any unrelated
  // prose, run the remediation the gate itself prints" turns a BLOCK into a PASS. Reproduced
  // end-to-end: 1 blocking → `CLAUDEMD_CLAIMS_VERDICT=PASS`.
  //
  // `unpublished`/`in_flight` mean "this was never verified here, so the pusher cannot act on it".
  // Once the lock has recorded a claim as verified, that sentence is false forever after: the path
  // WAS resolvable, and its disappearance is a deletion, not a publish race. So the markers are
  // refused for those ids and the claim keeps blocking. A genuine rename is unaffected — CLAUDE.md
  // renaming a path removes the old id from the corpus entirely, so it never reaches this branch.
  const wasVerified = verifiedIdsInLock();
  const locked = claims.filter((c) => LOCK_CLASSES.has(c.class));
  // Derived, never hand-maintained: stamped at --sync (where remote refs are visible) so CI —
  // which checks out one branch and can see none of them — inherits the same verdict. Resolved in
  // ONE batch for every missing path, so the cost does not scale with refs × claims.
  const missing = [...new Set(locked.filter((c) => c.class === 'repo-path' && !trackedSet.has(c.value)).map((c) => c.value))];
  const inFlightBy = firstRefContaining(missing, refs);
  const missingSet = new Set(missing);
  const lockClaims = locked
    .map((c) => {
      // `line` is DROPPED from the lock: a duplicated fact with no consumer. Locally the verifier
      // re-extracts and always has correct line numbers for its messages; in CI the corpus is
      // UNREACHABLE by design, so a locked line number is a pointer into a file CI cannot open —
      // authoritative-looking, uncheckable, and stale by however much prose has moved since.
      // `part` is DROPPED for exactly the same reason and by the same law: it is LOCATION, not
      // identity. Locking it would make relocating a rule rewrite the lock — the opposite of what
      // this wave proves, and it would re-introduce prose-sensitivity through a new door.
      const { line: _line, part: _part, ...rest } = c;
      if (c.class !== 'repo-path' || !missingSet.has(c.value)) return rest;
      const ref = inFlightBy.get(c.value);
      // A claim this lock already recorded as VERIFIED never gets downgraded — see wasVerified.
      if (wasVerified.has(claimId(c))) {
        console.error(`⚠ ${c.value}: locked as VERIFIED and its path is now gone — keeping it blocking rather than stamping ${ref ? 'in_flight' : 'unpublished'}. A prescribed file was deleted; --sync must not launder that into a pass.`);
        return rest;
      }
      // Three states, and the third is the one this wave adds. A path on NO remote ref is not
      // "a file that exists nowhere and never will" — it is in-flight one step earlier, sitting
      // in some session's working tree. The pusher can neither verify it nor fix it, so blocking
      // them is the deadlock, not the guard.
      return ref ? { ...rest, in_flight: ref } : { ...rest, unpublished: true };
    })
    .sort((a, b) => (claimId(a) < claimId(b) ? -1 : claimId(a) > claimId(b) ? 1 : 0));
  return {
    _comment: 'GENERATED by scripts/check-claudemd-claims.mjs --sync from the vault CLAUDE.md. Identifiers only — the manual’s prose never enters this repo. Do not hand-edit; --check fails on any divergence from a fresh extraction. Freshness is CLAIM-SET equality (see claimId): an edit that touches no claim does not invalidate this lock.',
    _extracted_from_corpus_sha256_semantics: 'PROVENANCE, not freshness. It records the corpus state this claim set was extracted from — it is NOT a live hash of the current CLAUDE.md and must never be compared against one. Keying freshness on a whole-file hash is exactly the defect OPS-CLAUDEMD-CLAIM-PUBLISH-PRECONDITION-W1 retired: the corpus is shared and concurrently edited (measured: three distinct shas in ~12 minutes), so a container hash makes every unrelated prose edit a false invalidation. Since META-CLAUDEMD-VERIFIER-CORPUS-SET-W1 the corpus is a SET, so this is a digest over the ORDERED per-part hashes rather than one file hash — still provenance, still never compared.',
    extracted_from_corpus_sha256: corpusProvenance(parts),
    corpus_parts: parts.map((p) => p.name),
    corpus_lines: parts.reduce((n, p) => n + p.text.split('\n').length, 0),
    claims: lockClaims,
  };
}

// ── check runner ──────────────────────────────────────────────────────────────

function printFinding(kind, claim, result, corpusLineText) {
  // `line` exists only on freshly-extracted claims. Lock-sourced claims (CI) carry none by
  // design — see buildLock — so say that plainly rather than printing "Lundefined", which reads
  // like a bug in the gate. Since the corpus became a SET, the PART must be named too: `line` is
  // per-part, so "CLAUDE.md L340" for a claim that actually lives in verification-gates.md is a
  // confident pointer at the wrong file — the authoritative-looking-and-false shape this manual
  // records three times over.
  const where = claim.part || 'CLAUDE.md';
  const loc = claim.line ? `${where} L${claim.line}` : `${where} (line: re-run locally)`;
  // THIRD [object Object] site, and the one a human actually reads: `codes.join('/')` calls the
  // object default too, so a finding printed `exit [object Object]/[object Object]`. Same defect as
  // claimId's, same single canonical renderer.
  const what = claim.token || (claim.codes ? `exit ${claim.codes.map(renderCodePair).join('/')}` : '') || (claim.points ? `→ ${claim.points.join('+')}` : '');
  console.log(`  ${kind} [${claim.class}] ${loc}  ${claim.value} ${what ? `(${what}) ` : ''}— ${result.status}${result.detail ? `: ${result.detail}` : ''}`);
  if (corpusLineText) console.log(`      claim line: ${corpusLineText.trim().slice(0, 160)}`);
  if (kind === '✖') {
    console.log(`      fix: correct the claim at ${loc} (add a _( … )_ note preserving the history), or add an exemption row WITH a reason to ops/claudemd-claim-config.json; then run: node scripts/check-claudemd-claims.mjs --sync`);
  }
}

// ── staleness severity (OPS-CLAUDEMD-CLAIM-FRESHNESS-SEVERITY-W1 CH2) ─────────

/** The config row governing one staleness severity. Fail-closed: validateConfig demands all four. */
function freshnessRow(cfg, severity) {
  return (cfg.freshness_severity || []).find((r) => r.severity === severity);
}

/**
 * Classify each member of a claim-set delta.
 *
 * SINGLE DERIVATION: the three path states are NOT re-derived here. buildLock already resolved
 * tracked-vs-in_flight-vs-unpublished (it is the only place that can see remote refs), so this
 * reads its markers. A second implementation of "is this path published" would drift from the
 * first, which is the exact shape this repo forbids.
 *
 * @returns {{id:string, severity:string, direction:'added'|'removed', ref:string|null}[]}
 */
export function classifyStaleness(added, removed, freshClaims, _cfg) {
  const byId = new Map((freshClaims || []).map((c) => [claimId(c), c]));
  const rows = [];
  for (const id of added) {
    const c = byId.get(id);
    rows.push({
      id,
      // in_flight is the THIRD state the original severity table omitted, and it was the state the
      // live 2026-08-08 case was actually in.
      severity: c?.in_flight ? 'STALE_IN_FLIGHT' : c?.unpublished ? 'STALE_UNPUBLISHED' : 'STALE_SYNCABLE',
      direction: 'added',
      ref: c?.in_flight ?? null,
    });
  }
  for (const id of removed) rows.push({ id, severity: 'STALE_DROPPED', direction: 'removed', ref: null });
  return rows;
}

const SYNC_CMD = 'node scripts/check-claudemd-claims.mjs --sync   # then commit ops/claudemd-claims.lock.json';

/** Per-severity remediation. A report nobody can act on is the failure mode being retired. */
function staleRemediation(row) {
  switch (row.severity) {
    case 'STALE_SYNCABLE':
      return `this claim's subject resolves in this tree — it is yours to land: ${SYNC_CMD}`;
    case 'STALE_IN_FLIGHT':
      return `subject lives on ${row.ref}; the lock absorbs it on the next --sync and it settles when that branch merges. Nothing for you to do.`;
    case 'STALE_UNPUBLISHED':
      return `subject is on no remote ref — it is in some other session's working tree. Only that session can publish it; do NOT --sync this one in on their behalf.`;
    case 'STALE_DROPPED':
      return `CLAUDE.md no longer makes this claim; --sync drops it from the lock.`;
    default:
      return SYNC_CMD;
  }
}

function printStaleness(rows, cfg) {
  if (!rows.length) return;
  for (const row of rows) {
    const cr = freshnessRow(cfg, row.severity);
    const sign = row.direction === 'added' ? '+' : '−';
    console.log(`  ⚠ ${sign} [${row.severity}] ${row.id}`);
    console.log(`      why REPORT: ${cr ? cr.reason : '(no config row — see ops/claudemd-claim-config.json)'}`);
    console.log(`      do: ${staleRemediation(row)}`);
  }
  const bySeverity = rows.reduce((a, r) => ((a[r.severity] = (a[r.severity] || 0) + 1), a), {});
  console.log(`  lock staleness is REPORT-only (${Object.entries(bySeverity).map(([k, v]) => `${k}=${v}`).join(' · ')}). ` +
    `A stale lock is bookkeeping; it does not block. What still BLOCKS is a claim this lock recorded as VERIFIED whose path is now gone.`);
}

/**
 * One row per run, in the SHARED $GIT_COMMON_DIR so all worktrees feed one series. R2.4's promotion
 * back to BLOCK is then decided on a measured healing RATE, not a guess — and per CLAUDE.md, a
 * promotion criterion that cannot be measured is how a guard gets stuck in REPORT forever.
 * Best-effort by construction: a gate must never fail because a log was unwritable.
 */
function appendFreshnessLedger(rows, addedN, removedN) {
  const override = process.env.ALGOVAULT_CLAUDEMD_LEDGER;
  if (override === '0' || override === 'off') return;
  try {
    let target = override;
    if (!target) {
      const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' }).trim();
      target = join(resolve(ROOT, common), 'algovault-claudemd-freshness.log');
    }
    const by = rows.reduce((a, r) => ((a[r.severity] = (a[r.severity] || 0) + 1), a), {});
    const cols = ['STALE_SYNCABLE', 'STALE_IN_FLIGHT', 'STALE_UNPUBLISHED', 'STALE_DROPPED'].map((s) => `${s}=${by[s] || 0}`);
    appendFileSync(target, [
      new Date().toISOString(), ROOT, `added=${addedN}`, `removed=${removedN}`, ...cols,
    ].join('\t') + '\n');
  } catch { /* a ledger is telemetry; it never gates a push */ }
}

/**
 * Parse the lock, or say why not. A malformed lock used to throw an uncaught SyntaxError, which
 * killed the process with NO verdict token at all — the one outcome the token law forbids, since a
 * caller greping for PASS|FAIL|INDETERMINATE would find nothing and have to guess.
 */
function readLock(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch (e) { return { error: `lock unreadable at ${path}: ${e.message}` }; }
  let lock;
  try { lock = JSON.parse(raw); } catch (e) { return { error: `lock is not parseable JSON (${path}): ${e.message}` }; }
  if (!lock || !Array.isArray(lock.claims)) return { error: `lock is malformed (claims is not an array) at ${path}` };
  return { lock };
}

function runCheck(cfg, { probeHosts = false } = {}) {
  const corpus = resolveCorpus(cfg);
  if (corpus.error) return { verdict: 'INDETERMINATE', why: corpus.error };
  const ctx = makeContext(cfg, { vaultDir: corpus.vaultDir });
  // The ANCHOR decides which world we are in. Unreachable anchor ⇒ the corpus does not exist here
  // at all (CI, by design) ⇒ lock-mode, unchanged. Anchor present but a listed PART missing is a
  // different fact entirely: the corpus exists and is INCOMPLETE. Collapsing the two is what would
  // let a deleted rule file read as a clean pass.
  const corpusReadable = existsSync(corpus.anchor);
  let claims, freshLock = null, linesByPart = null, stats = null;

  if (corpusReadable) {
    const { parts, missing } = readCorpusParts(corpus.parts);
    if (missing.length) {
      return {
        verdict: 'INDETERMINATE',
        why: `corpus part(s) declared but unreadable: ${missing.join(', ')} — input we were HANDED and could not read is fail-closed, never a pass. Restore the file, or correct _corpus_enumeration.in[CLAUDE.md].parts in ops/claudemd-claim-config.json.`,
      };
    }
    const dupes = duplicateManualParts(parts, basename(corpus.anchor));
    if (dupes.length) {
      return {
        verdict: 'INDETERMINATE',
        why: `corpus part ${dupes[0].part} ${dupes[0].why}. Claims would be counted from a duplicate corpus, and a frozen copy resurrects superseded claims as prescriptive; see _parts_semantics.`,
      };
    }
    if (!parts.some((p) => p.text.trim())) {
      return { verdict: 'INDETERMINATE', why: `every one of the ${parts.length} corpus part(s) under ${corpus.vaultDir} is empty` };
    }
    linesByPart = new Map(parts.map((p) => [p.name, p.text.split('\n')]));
    const ex = extractCorpusClaims(parts, cfg);
    stats = ex.stats;
    freshLock = buildLock(parts, cfg);
    // The in-flight markers are DERIVED during buildLock (it can see remote refs). Carry them onto
    // the fresh claim set so the local run and CI's lock-only run reach the SAME verdict — a gate
    // that passes locally and fails in CI teaches people to distrust it.
    const marked = new Map(freshLock.claims.filter((c) => c.in_flight).map((c) => [claimId(c), c.in_flight]));
    const unpub = new Set(freshLock.claims.filter((c) => c.unpublished).map((c) => claimId(c)));
    claims = ex.claims.map((c) => {
      const id = claimId(c);
      if (marked.has(id)) return { ...c, in_flight: marked.get(id) };
      if (unpub.has(id)) return { ...c, unpublished: true };
      return c;
    });
    if (!existsSync(LOCK_PATH)) {
      return { verdict: 'FAIL', why: `lock missing at ops/claudemd-claims.lock.json — run: node scripts/check-claudemd-claims.mjs --sync (and commit the lock)` };
    }
    const parsed = readLock(LOCK_PATH);
    if (parsed.error) return { verdict: 'INDETERMINATE', why: `${parsed.error} — a lock that cannot be read is not a report, it is an unverifiable run` };
    const lock = parsed.lock;
    // FRESHNESS = CLAIM-SET EQUALITY, and nothing else.
    //
    // It used to be `corpus_sha256 !== fresh || JSON.stringify(claims) !== …`, which made THREE
    // independent things invalidate the lock while only one of them was a claim change: any byte
    // of the corpus, every claim's `line` (a paragraph insert shifts all of them), and the array
    // ORDER (the old sort was line-first). On a corpus every parallel session can edit — measured
    // at three distinct shas in ~12 minutes — that made false invalidation the steady state and
    // `--sync` unable to converge.
    //
    // claimId() is line-agnostic, so this computes the same id set from an OLD-shape lock as from
    // a new one. That is why the migration needs no legacy compare path: a new verifier reading
    // the not-yet-regenerated lock simply passes, which is exactly the intra-wave transition.
    // ── STALENESS IS CLASSIFIED, NOT FATAL (OPS-CLAUDEMD-CLAIM-FRESHNESS-SEVERITY-W1 CH2) ────────
    //
    // This used to `return FAIL` right here, and that single early return is the generator defect
    // the wave exists to retire. Everything below it — the `unpublished` / `in_flight` /
    // `was_verified` ladder that OPS-CLAIM-VERIFIER-COVERAGE-W1 and
    // OPS-CLAUDEMD-CLAIM-PUBLISH-PRECONDITION-W1 built FOR THIS EXACT RACE — was unreachable in
    // precisely the scenario it was designed for. Measured 2026-08-08: a foreign edit to the shared
    // vault corpus named a file that was committed and pushed on another session's branch;
    // buildLock stamped it `in_flight`, isBlocking returned FALSE — the ladder had the right answer
    // and never got to give it, because this predicate ran first and returned FAIL.
    //
    // A severity ladder is only as good as the earliest predicate that can short-circuit it.
    //
    // So: classify the delta per id, REPORT it, and fall through to the per-claim verification that
    // owns the dangerous conditions. The bookkeeping condition stops blocking; the dangerous one
    // (a claim the lock recorded as VERIFIED whose path is now absent) keeps blocking, and is now
    // reachable WHILE the lock is stale — which it never was before.
    const freshIds = new Set(claimIdSet(freshLock.claims));
    const lockIds = new Set(claimIdSet(lock.claims));
    const added = [...freshIds].filter((x) => !lockIds.has(x));
    const removed = [...lockIds].filter((x) => !freshIds.has(x));
    const stale = classifyStaleness(added, removed, freshLock.claims, cfg);
    // Name every part and its claim count. A merged corpus that printed only a total would hide
    // exactly the failure this wave retires: a part contributing ZERO because it silently moved.
    console.log(`corpus: ${corpus.parts.length} part(s) under ${corpus.vaultDir} [${corpus.source}] — ${
      stats.lines} lines, ${stats.blocks} correction blocks stripped, ${ex.rawCount} claims → ${claimIdSet(ex.claims).length} after dedupe`);
    for (const p of stats.parts) console.log(`  · ${String(p.claims).padStart(3)} claims  ${p.name}`);
    console.log(`  ${stale.length ? `lock STALE (+${added.length}/-${removed.length}), reported below` : `lock fresh (${lockIds.size} claim ids)`}`);
    printStaleness(stale, cfg);
    appendFreshnessLedger(stale, added.length, removed.length);
    // The committed lock is the MEMORY of what was once verified, and it is what separates the two
    // reasons a path can be missing. A claim locked with no marker was satisfied at sync time; if
    // its path is gone now, a commit removed a prescribed path — definitively wrong, and
    // definitively the pusher's doing, so it BLOCKS. A claim that was never verified (new, or
    // already marked) only REPORTS. Without this the two collapse, and `unpublished` would become
    // a way to delete a prescribed file unnoticed.
    //
    // This marking now runs UNCONDITIONALLY. It used to sit after the staleness return, so one
    // unrelated prose edit anywhere in a corpus ~22 worktrees share was enough to make every
    // deleted-prescribed-path invisible.
    const lockedVerified = new Set(
      lock.claims.filter((c) => !c.in_flight && !c.unpublished).map((c) => claimId(c)),
    );
    claims = claims.map((c) => (lockedVerified.has(claimId(c)) ? { ...c, was_verified: true } : c));
  } else {
    if (!existsSync(LOCK_PATH)) return { verdict: 'INDETERMINATE', why: 'corpus unreachable AND lock missing — nothing to verify' };
    const parsed = readLock(LOCK_PATH);
    if (parsed.error) return { verdict: 'INDETERMINATE', why: parsed.error };
    const lock = parsed.lock;
    // CI sees a MERGED, settled world, so "it was only in someone's working tree" is no longer an
    // excuse — a prescribed path missing here is real. The `unpublished` downgrade is therefore
    // stripped; `in_flight` is deliberately NOT, because a branch that has not merged yet is a
    // statement about the future, and another wave's merge order must never break main.
    claims = lock.claims.map(({ unpublished: _unpublished, ...rest }) => rest);
    const prov = lock.extracted_from_corpus_sha256 ?? lock.corpus_sha256; // old-shape locks pre-date the rename
    console.log(`corpus: UNREACHABLE (CI) — verifying committed lock (${claims.length} claims, extracted from corpus ${String(prov).slice(0, 12)}…)`);
  }

  if (!claims.length) return { verdict: 'INDETERMINATE', why: 'zero claims extracted — vacuous run refuses to report a pass' };

  // Resolve a claim's source line IN ITS OWN PART. One flat line array indexed by a per-part line
  // number is the confident-wrong-answer shape: it always returns SOME line, just not the claim's.
  const claimLineText = (claim) => linesByPart?.get(claim.part || 'CLAUDE.md')?.[claim.line - 1];

  let blockFails = 0, reports = 0, ok = 0, unreachable = 0, unprobed = 0;
  for (const claim of claims) {
    if (claim.class === 'host-path' && probeHosts) {
      // read-only remote existence probe, only on explicit request
      try {
        execFileSync('ssh', ['-o', 'ConnectTimeout=6', '-i', join(homedir(), '.ssh', 'algovault_deploy'), 'root@204.168.185.24', `test -e '${claim.value.replace(/'/g, '')}'`], { stdio: 'pipe' });
        ok++; continue;
      } catch {
        reports++;
        printFinding('⚠', claim, { status: 'REVIEW', detail: 'not found on signal host (read-only probe; may live on another host)' }, claimLineText(claim));
        continue;
      }
    }
    const result = verifyClaim(claim, ctx, cfg);
    if (result.status === 'OK') { ok++; continue; }
    if (result.status === 'UNREACHABLE') { unreachable++; continue; }
    if (result.status === 'UNPROBED') { unprobed++; continue; }
    if (isBlocking(claim, result, cfg)) {
      blockFails++;
      printFinding('✖', claim, result, claimLineText(claim));
    } else {
      reports++;
      printFinding('⚠', claim, result, claimLineText(claim));
    }
  }
  console.log(`\nclaims: ${claims.length} verified — ${ok} OK · ${blockFails} blocking · ${reports} report-only · ${unreachable} unreachable (local-only class in CI) · ${unprobed} unprobed (host)`);
  for (const row of cfg.in_flight_claims || []) {
    console.log(`  ⧖ in-flight (declared): ${row.value} — owed by ${row.wave}, declared ${row.declared_on}`);
  }
  for (const c of claims.filter((x) => x.in_flight)) {
    const landed = verifyClaim({ ...c, in_flight: undefined }, ctx, cfg).status === 'OK';
    console.log(landed
      ? `  ⚠ in-flight marker is STALE: ${c.value} — ${c.in_flight} has merged; the marker clears on the next --sync (reported, not failed: another wave's merge must never break main)`
      : `  ⧖ in-flight (on a pushed branch): ${c.value} — ${c.in_flight}; resolves when that branch merges`);
  }
  const stale = staleInFlight(claims, ctx, cfg);
  for (const { row, why } of stale) {
    console.log(`  ✖ [in-flight] ${row.value} — ${why}; DELETE this row from ops/claudemd-claim-config.json (a declaration must not outlive its race), then run --sync`);
  }
  if (stale.length) return { verdict: 'FAIL', why: `${stale.length} in-flight declaration(s) have outlived the race they describe` };
  if (blockFails) return { verdict: 'FAIL', why: `${blockFails} blocking claim failure(s) — the prescriptive SoT asserts something the repo contradicts` };
  return { verdict: 'PASS' };
}

// ── measure (R1, reproducible) ────────────────────────────────────────────────

function runMeasure(cfg) {
  const corpus = resolveCorpus(cfg);
  if (corpus.error) { console.error(corpus.error); process.exit(3); }
  const { parts, missing } = readCorpusParts(corpus.parts);
  if (missing.length) { console.error(`corpus part(s) unreadable: ${missing.join(', ')} — --measure needs the whole set`); process.exit(3); }
  if (!parts.length) { console.error('corpus unreachable — --measure needs the vault'); process.exit(3); }
  const ctx = makeContext(cfg, { vaultDir: corpus.vaultDir });
  console.log(`corpus: ${parts.length} part(s) under ${corpus.vaultDir} [${corpus.source}]`);
  for (const stripOn of [false, true]) {
    const { claims, stats, rawCount } = extractCorpusClaims(parts, cfg, { stripCorrections: stripOn });
    let fires = 0;
    const list = [];
    for (const c of claims) {
      const r = verifyClaim(c, ctx, cfg);
      if (r.status !== 'OK' && r.status !== 'UNREACHABLE' && r.status !== 'UNPROBED') { fires++; list.push(`${c.class} ${c.part} L${c.line} ${c.value} → ${r.status}`); }
    }
    console.log(`\nstrip=${stripOn}: spans=${stats.spans} raw=${rawCount} claims=${claims.length} would-fire=${fires}`);
    for (const p of stats.parts) console.log(`   · ${String(p.claims).padStart(3)} claims  ${String(p.spans).padStart(4)} spans  ${p.name}`);
    for (const l of list) console.log('   ' + l);
  }
  console.log(`\ncorrection blocks: ${parts.reduce((n, p) => n + findCorrectionBlocks(p.text).length, 0)}; corpus provenance ${corpusProvenance(parts).slice(0, 16)}…`);
}

// ── baseline equality (LOCAL-only gate, META-CLAUDEMD-VERIFIER-CORPUS-SET-W1 R3b) ─────────────

/**
 * Compare the LIVE merged claim-id set against a recorded pre-split baseline.
 *
 * WHY THIS IS ITS OWN MODE AND ITS OWN TOKEN. The regression bar — "the 7-part corpus reproduces
 * the pre-split claim set exactly" — cannot be asserted inside `--self-test`, because that runs in
 * CI (deploy.yml) where the vault is unreachable BY DESIGN. Copying the private corpus into a
 * fixture is not a hypothetical mistake: it is recorded in tests/unit/claudemd-claim-precondition
 * .test.ts, where an earlier cut passed locally and failed the pre-deploy gate with ENOENT on
 * `/home/runner/My Drive/…`.
 *
 * So it is a local gate — and a local gate that can fail open MUST emit a distinguishable verdict.
 * `exit 0` may never encode both "baseline equal" and "vault unreachable, so nothing was ever
 * compared": that is the dark-guard shape this repo has now recorded five times. Hence
 * CLAUDEMD_BASELINE_VERDICT, with the token-law default codes for a NEW gate (0/1/3).
 */
function runBaseline(cfg, baselinePath) {
  if (!baselinePath) return { verdict: 'INDETERMINATE', why: '--baseline needs a path to the recorded baseline JSON' };
  let baseline;
  try { baseline = JSON.parse(readFileSync(baselinePath, 'utf8')); } catch (e) {
    return { verdict: 'INDETERMINATE', why: `baseline unreadable at ${baselinePath}: ${e.message}` };
  }
  const recorded = baseline?.claim_ids;
  // WE author the baseline, so an empty or absent id list is VACUITY — a defect in the artifact,
  // never "the corpus asserts nothing". Refuse rather than compare against nothing and pass.
  if (!Array.isArray(recorded) || !recorded.length) {
    return { verdict: 'INDETERMINATE', why: `baseline at ${baselinePath} carries no claim_ids — an empty baseline would make this comparison vacuous, and a vacuous comparison must never report a pass` };
  }
  const corpus = resolveCorpus(cfg);
  if (corpus.error) return { verdict: 'INDETERMINATE', why: corpus.error };
  if (!existsSync(corpus.anchor)) {
    return { verdict: 'INDETERMINATE', why: `corpus anchor unreachable at ${corpus.anchor} — the live claim set was NEVER COMPARED. This is the outcome that must not be confused with equality.` };
  }
  const { parts, missing } = readCorpusParts(corpus.parts);
  if (missing.length) return { verdict: 'INDETERMINATE', why: `corpus part(s) unreadable: ${missing.join(', ')} — comparison refused on an incomplete corpus` };
  const live = claimIdSet(extractCorpusClaims(parts, cfg).claims);
  const rec = new Set(recorded), liv = new Set(live);
  const added = live.filter((x) => !rec.has(x));
  const removed = recorded.filter((x) => !liv.has(x));

  console.log(`baseline: ${baselinePath}`);
  console.log(`  recorded ${recorded.length} claim ids · live ${live.length} across ${parts.length} part(s) [${corpus.source}]`);
  // Explicit POSITIVE output on the snapshot too: "did not check" and "checked, matched" must not
  // look identical. A silent skip is how a guard goes dark at a green exit code.
  const snap = baseline.snapshot;
  if (snap?.path && snap?.sha256) {
    if (!existsSync(snap.path)) console.log(`  snapshot: NOT PRESENT at ${snap.path} — not compared (informational; the baseline id list is the subject of this gate)`);
    else {
      const liveSha = createHash('sha256').update(readFileSync(snap.path)).digest('hex');
      console.log(`  snapshot: ${liveSha === snap.sha256 ? `sha MATCHES (${liveSha.slice(0, 12)}…)` : `sha DIFFERS — recorded ${snap.sha256.slice(0, 12)}… live ${liveSha.slice(0, 12)}…`}`);
    }
  }
  for (const id of added) console.log(`  + ADDED (live, not in baseline)   ${id}`);
  for (const id of removed) console.log(`  − REMOVED (baseline, not live)   ${id}`);
  if (added.length || removed.length) {
    return {
      verdict: 'FAIL',
      why: `claim set diverges from the pre-split baseline: +${added.length} / −${removed.length}. Do NOT run --sync to make this pass — a delta means the merge or the corpus split LOST or INVENTED something, and --sync would bake it into the committed lock permanently. Diff both directions above and halt.`,
    };
  }
  return { verdict: 'PASS' };
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
  // (i1) in-flight declarations (OPS-CLAIM-VERIFIER-COVERAGE-W1) downgrade ONE claim, not a class,
  // and are self-cleaning — a declaration that has outlived its race must FAIL.
  const ifCfg = { ...cfg, in_flight_claims: [{ value: 'scripts/not-a-real-file.mjs', class: 'repo-path', wave: 'W', declared_on: '2026-01-01', reason: 'fixture' }] };
  const ifClaim = { class: 'repo-path', value: 'scripts/not-a-real-file.mjs', line: 1 };
  if (isBlocking(ifClaim, { status: 'MISSING' }, ifCfg)) fails.push('a declared in-flight claim still blocked');
  if (!isBlocking({ class: 'repo-path', value: 'scripts/other-missing.mjs', line: 1 }, { status: 'MISSING' }, ifCfg)) {
    fails.push('an in-flight declaration leaked to another claim in the same class');
  }
  const resolvedCfg = { ...cfg, in_flight_claims: [{ value: 'scripts/check-canaries-wired.mjs', class: 'repo-path', wave: 'W', declared_on: '2026-01-01', reason: 'fixture' }] };
  if (staleInFlight([{ class: 'repo-path', value: 'scripts/check-canaries-wired.mjs', line: 1 }], ctx, resolvedCfg).length !== 1) {
    fails.push('an in-flight declaration that has RESOLVED was not reported stale');
  }
  if (staleInFlight([], ctx, resolvedCfg).length !== 1) fails.push('an in-flight row for a claim CLAUDE.md no longer makes was not reported stale');
  // the DERIVED marker (stamped by --sync from a pushed branch) downgrades the same way
  if (isBlocking({ class: 'repo-path', value: 'scripts/gone.mjs', line: 1, in_flight: 'origin/x' }, { status: 'MISSING' }, cfg)) {
    fails.push('a claim marked in_flight on a pushed branch still blocked');
  }
  if (!isBlocking({ class: 'repo-path', value: 'scripts/gone.mjs', line: 1 }, { status: 'MISSING' }, cfg)) {
    fails.push('an unmarked missing repo-path stopped blocking — the in-flight downgrade leaked');
  }

  // (i2) host-path COVERAGE (OPS-CLAIM-VERIFIER-COVERAGE-W1): an unrouted, unexempted host path
  // must fire — the blind spot W1 shipped. A routed one must not.
  const unrouted = firingsOf('deploy to `/opt/algovault-nowhere/thing.py` on the box.\n');
  if (unrouted.length !== 1 || unrouted[0].r.status !== 'REVIEW') fails.push('an unrouted host-path claim did not fire');
  const rerouted = firingsOf('the wrapper lives at `/opt/algovault-monitoring/send_telegram.sh`.\n');
  if (rerouted.length !== 0) fails.push('a routed host-path claim fired');
  // and the claims file itself must carry a reason on every row, both kinds
  const dc = ctx.docClaims || {};
  for (const row of [...(dc.claims || []), ...(dc.exempt_claims || [])]) {
    if (!row.reason) { fails.push(`doc-host-path-claims row ${row.path || row.value} has no reason`); break; }
  }
  for (const row of dc.claims || []) {
    if (!Array.isArray(row.hosts) || !row.hosts.length) { fails.push(`doc-host-path-claims row ${row.path} names no owning host`); break; }
  }
  // (i) config validation fail-closed: an exemption row without a reason must be rejected
  const bad = JSON.parse(JSON.stringify(cfg));
  bad.exemptions.push({ value: 'x', class: 'env-var' });
  let threw = false;
  try { validateConfig(bad); } catch { threw = true; }
  if (!threw) fails.push('validateConfig accepted an exemption row without a reason');

  // ── OPS-CLAUDEMD-CLAIM-PUBLISH-PRECONDITION-W1 ──────────────────────────────────────────
  //
  // (j) IDENTITY IS LINE-AGNOSTIC. This is the whole fix, and it is also what makes the lock
  // migration back-compatible with no legacy compare path: an old-shape (line-bearing) claim
  // must yield the SAME id as its line-free equivalent.
  const wLine = { class: 'repo-path', value: 'scripts/x.mjs', line: 42 };
  const wNone = { class: 'repo-path', value: 'scripts/x.mjs' };
  if (claimId(wLine) !== claimId(wNone)) fails.push('claimId is line-sensitive — the defect this wave exists to retire');
  if (/\b42\b/.test(claimId(wLine))) fails.push('a line number leaked into a claim id');

  // (k) THE SAFETY REQUIREMENT. An id must encode the ASSERTED VALUE, not just the subject —
  // otherwise a claim can change what it asserts while the id set stays identical, --sync
  // no-ops, and the lock silently records a claim set that no longer matches the corpus.
  // Both classes that carry an asserted value are covered.
  const wire1 = { class: 'wiring', value: 'scripts/foo.mjs', points: ['pre-push'], line: 1 };
  const wire2 = { class: 'wiring', value: 'scripts/foo.mjs', points: ['deploy.yml'], line: 1 };
  if (claimId(wire1) === claimId(wire2)) {
    fails.push('SUBJECT-ONLY id: a wiring claim changed its asserted point and the id did not change');
  }
  // ── (k1) THE BYPASSED ARTIFACT (OPS-CLAUDEMD-CLAIM-FRESHNESS-SEVERITY-W1 CH3) ────────────────
  //
  // These fixtures are produced by the REAL extractClaims, and that is the whole point. The
  // previous version of this case hand-wrote `codes: [2]` / `codes: [3]` — RAW NUMBERS, a shape
  // extractClaims has never once emitted. It emits `{code, meaning}` OBJECTS. So the assertion
  // passed for a reason that had nothing to do with production: String(2) !== String(3), while the
  // real objects both stringified to "[object Object]".
  //
  // A hermetic fixture is structurally blind to exactly what its own seam replaces. Here the seam
  // was the extractor's output shape, and substituting it made this guard vacuous while it looked
  // like the strongest assertion in the file — it is the one case explicitly written to catch an
  // exit-code change, and it could not have caught one.
  const scriptContentFrom = (text) => {
    const { claims } = extractClaims(text, cfg);
    return claims.find((c) => c.class === 'script-content' && Array.isArray(c.codes) && c.codes.length);
  };
  const GATE_SPAN = '`scripts/check-canaries-wired.mjs`';
  const sc1 = scriptContentFrom(`the gate ${GATE_SPAN} exits 0=PASS / 1=FAIL / 2=INDETERMINATE.\n`);
  const sc2 = scriptContentFrom(`the gate ${GATE_SPAN} exits 0=PASS / 1=FAIL / 7=INDETERMINATE.\n`);
  // Vacuity first: WE build this corpus, so extracting nothing is a defect in the test, not a fact
  // about the world. Refuse rather than silently skip the assertions below.
  if (!sc1 || !sc2) {
    fails.push('exit-code fixtures extracted NOTHING — the self-test corpus stopped producing script-content claims');
  } else if (sc1.codes.length !== 3 || !sc1.codes.every((p) => p && typeof p === 'object' && 'code' in p && 'meaning' in p)) {
    fails.push(`exit-code fixture is not the extractor's real shape: ${JSON.stringify(sc1.codes)}`);
  } else {
    // the measured F4 scenario: one digit changes, and the id MUST change with it
    if (claimId(sc1) === claimId(sc2)) {
      fails.push('VALUE-BLIND id: an exit code changed from 2 to 7 and the claim id did not change — the drift class this gate exists for');
    }
    // and the id must never render the object default, in any pair count
    for (const c of [sc1, sc2]) {
      if (claimId(c).includes('[object Object]')) fails.push(`claim id renders [object Object]: ${claimId(c)}`);
    }
    // it must carry the actual asserted values, not merely differ
    if (!claimId(sc1).includes('2=INDETERMINATE')) fails.push(`claim id does not encode its asserted pair: ${claimId(sc1)}`);
    // COLLISION (forward-guard — zero live instances measured 2026-08-08, across all 89 lockable
    // ids): equal pair COUNT with different values must not collapse to one id. Under the old
    // `.map(String)` these were identical strings, so the claim set could change meaning silently.
    const one1 = scriptContentFrom(`the gate ${GATE_SPAN} exits 2=INDETERMINATE.\n`);
    const one2 = scriptContentFrom(`the gate ${GATE_SPAN} exits 3=INDETERMINATE.\n`);
    if (!one1 || !one2) fails.push('single-pair collision fixtures extracted nothing');
    else if (claimId(one1) === claimId(one2)) {
      fails.push('COLLISION: two same-subject claims with equal pair count but different codes share one id');
    }
    // …and the same pairs in a different textual ORDER are the SAME claim, or the set is not a set
    const ord1 = scriptContentFrom(`the gate ${GATE_SPAN} exits 0=PASS / 1=FAIL.\n`);
    const ord2 = scriptContentFrom(`the gate ${GATE_SPAN} exits 1=FAIL / 0=PASS.\n`);
    if (ord1 && ord2 && claimId(ord1) !== claimId(ord2)) {
      fails.push('claimId is order-sensitive over exit pairs — the same assertion must have one id');
    }
  }
  const tok1 = { class: 'script-content', value: 'scripts/g.sh', token: 'A_VERDICT', line: 1 };
  const tok2 = { class: 'script-content', value: 'scripts/g.sh', token: 'B_VERDICT', line: 1 };
  if (claimId(tok1) === claimId(tok2)) fails.push('SUBJECT-ONLY id: a script-content claim changed its asserted token and the id did not change');
  // …and the same assertion in a different ORDER is the SAME claim, or the set is not a set.
  if (claimId({ class: 'wiring', value: 'a', points: ['x', 'y'] }) !== claimId({ class: 'wiring', value: 'a', points: ['y', 'x'] })) {
    fails.push('claimId is order-sensitive over an asserted list — the same assertion must have one id');
  }
  // `candidates` is a RESOLUTION helper, not an assertion; if it entered identity, prose changes
  // that merely alter which files a claim might refer to would invalidate the lock again.
  if (claimId({ class: 'script-content', value: 'a', codes: [2], candidates: ['p'] })
      !== claimId({ class: 'script-content', value: 'a', codes: [2], candidates: ['q'] })) {
    fails.push('`candidates` leaked into claim identity — prose-sensitivity re-introduced');
  }

  // (l) FRESHNESS IS SET EQUALITY: order and duplication must not matter, membership must.
  const A = [{ class: 'repo-path', value: 'a' }, { class: 'repo-path', value: 'b' }];
  if (!sameClaimSet(A, [...A].reverse())) fails.push('claim-set comparison is order-sensitive');
  if (!sameClaimSet(A, [...A, { class: 'repo-path', value: 'a', line: 9 }])) fails.push('a duplicate id changed the set');
  if (sameClaimSet(A, [{ class: 'repo-path', value: 'a' }])) fails.push('a REMOVED claim did not change the set');
  if (sameClaimSet(A, [...A, { class: 'repo-path', value: 'c' }])) fails.push('an ADDED claim did not change the set');
  if (claimIdSet([]).length !== 0) fails.push('claimIdSet of nothing is not empty');

  // (m) PUSHER-RELATIVE VERDICTS. A path on no remote ref REPORTS — the pusher can neither
  // verify nor fix it. But a claim that WAS verified when locked and is now missing BLOCKS:
  // that is a commit removing a prescribed path, and it is the pusher's doing.
  if (isBlocking({ class: 'repo-path', value: 'scripts/only-in-a-worktree.mjs', unpublished: true }, { status: 'MISSING' }, cfg)) {
    fails.push('an unpublished path BLOCKED the pusher — the deadlock this wave exists to retire');
  }
  if (!isBlocking({ class: 'repo-path', value: 'scripts/deleted.mjs', unpublished: true, was_verified: true }, { status: 'MISSING' }, cfg)) {
    fails.push('a previously-VERIFIED path that is now missing did not block — unpublished became a way to delete a prescribed file unnoticed');
  }
  if (isBlocking({ class: 'repo-path', value: 'scripts/x.mjs', unpublished: true }, { status: 'OK' }, cfg)) {
    fails.push('an unpublished marker turned a satisfied claim into a failure');
  }

  // ── META-CLAUDEMD-VERIFIER-CORPUS-SET-W1 — THE CORPUS IS A SET ──────────────────────────────
  //
  // Every scenario below is CORPUS-INDEPENDENT on purpose. This suite runs in CI (deploy.yml),
  // where the vault is unreachable BY DESIGN, and an earlier cut of the sibling suite copied the
  // real corpus into a fixture, passed locally, and failed the pre-deploy gate with ENOENT on
  // `/home/runner/My Drive/…`. The equality-against-the-real-baseline half therefore lives in
  // `--baseline`, which is local and carries its own verdict token. See runBaseline.
  //
  // Fixtures are built by the REAL extractor from real fixture TEXT — never hand-written claim
  // literals. Hand-written `codes: [2]` is exactly how the [object Object] id defect passed its
  // own guard: a shape extractClaims has never emitted.
  const mkPart = (name, text) => ({ path: join(FIXTURES, name), name, text, sha: createHash('sha256').update(text).digest('hex') });
  const cleanText = fx('clean.md');
  const liveText = fx('live-dead-path.md');

  // AN ASSERTION THAT RAISES IS NOT AN ASSERTION. Every scenario below is wrapped, so a broken
  // subject reports `SELF-TEST: FAIL (n)` instead of aborting the suite — the difference between
  // "proven able to fail" and "crashes", which this manual records having conflated before.
  const guard = (label, fn) => {
    try { fn(); } catch (e) { fails.push(`${label} THREW instead of reporting: ${e && e.message}`); }
  };

  // (n1) THE REGRESSION BAR. With ONE part, the merge path must reproduce single-path extraction
  // exactly — that is what "absent `parts` ⇒ today's behaviour" means, expressed so CI can check it.
  guard('(n1) regression bar', () => { if (cleanText) {
    const merged1 = extractCorpusClaims([mkPart('clean.md', cleanText)], cfg);
    const legacy = extractClaims(cleanText, cfg);
    if (!legacy.claims.length) fails.push('regression-bar fixture extracted NOTHING — the comparison would be vacuous');
    else if (!sameClaimSet(merged1.claims, legacy.claims)) {
      fails.push(`REGRESSION BAR: one-part merge does not reproduce single-path extraction (${claimIdSet(merged1.claims).length} vs ${claimIdSet(legacy.claims).length} ids)`);
    }
  } });

  // (n2) MERGE = UNION. Three parts yield exactly the union of their per-part id sets.
  guard('(n2) merge=union', () => { if (cleanText && liveText) {
    const a = mkPart('a.md', 'The wiring canary lives at `scripts/check-canaries-wired.mjs`.\n');
    const b = mkPart('b.md', 'Dependencies are declared in `package.json` at the repo root.\n');
    const c = mkPart('c.md', 'The pre-push gate is `check_test_baseline.sh`.\n');
    const union = new Set([a, b, c].flatMap((p) => claimIdSet(extractClaims(p.text, cfg).claims)));
    const got = claimIdSet(extractCorpusClaims([a, b, c], cfg).claims);
    if (!union.size) fails.push('merge fixture produced no claims — vacuous');
    else if (got.length !== union.size || !got.every((id) => union.has(id))) {
      fails.push(`MERGE: 3-part corpus is not the union of its parts (got ${got.length}, union ${union.size})`);
    }
  } });

  // (n3) MOVE-INVARIANCE — the whole wave in miniature, where a failure costs nothing. Cut a block
  // of lines OUT of a fixture into a second part; the claim set must be IDENTICAL. Extraction is
  // line-local, so a split at a line boundary preserves every claim — and this is what proves that
  // relocating a rule is lossless, mechanically, rather than by argument.
  guard('(n3) move-invariance', () => { if (cleanText) {
    const lines = cleanText.split('\n');
    const cut = Math.floor(lines.length / 2);
    const head = lines.slice(0, cut).join('\n') + '\n';
    const tail = lines.slice(cut).join('\n');
    // A fixture that stopped being a byte-exact split would make this pass for the wrong reason.
    if (head + tail !== cleanText) fails.push('move-invariance fixture is not a byte-exact split — the scenario would prove nothing');
    else {
      const whole = extractCorpusClaims([mkPart('whole.md', cleanText)], cfg);
      const moved = extractCorpusClaims([mkPart('head.md', head), mkPart('tail.md', tail)], cfg);
      if (!whole.claims.length) fails.push('move-invariance fixture extracted nothing — vacuous');
      else if (!sameClaimSet(whole.claims, moved.claims)) {
        fails.push(`MOVE-INVARIANCE: splitting a fixture across two parts changed the claim set (${claimIdSet(whole.claims).length} → ${claimIdSet(moved.claims).length})`);
      }
    }
  } });

  // (n4) DEDUPE. The same claim asserted in two parts is ONE claim, and it reports the FIRST part.
  guard('(n4) dedupe', () => {
    const dupText = 'The wiring canary lives at `scripts/check-canaries-wired.mjs`.\n';
    const one = extractCorpusClaims([mkPart('first.md', dupText)], cfg);
    const two = extractCorpusClaims([mkPart('first.md', dupText), mkPart('second.md', dupText)], cfg);
    if (!one.claims.length) fails.push('dedupe fixture extracted nothing — vacuous');
    else {
      if (two.claims.length !== one.claims.length) fails.push(`DEDUPE: the same claim in two parts produced ${two.claims.length} claims, expected ${one.claims.length}`);
      if (two.rawCount !== one.rawCount * 2) fails.push('dedupe fixture did not actually restate the claim twice — the scenario is vacuous');
      if (two.claims[0] && two.claims[0].part !== 'first.md') fails.push(`DEDUPE: deduped claim reports part "${two.claims[0].part}", expected the FIRST part`);
    }
  });

  // (n5) MISSING PART ⇒ reported, never silently skipped. Asserted through BOTH paths: the env
  // seam AND the config-driven resolution the seam replaces. A hermetic fixture is structurally
  // blind to exactly what its own seam substitutes, so testing only through the seam would leave
  // corpusEntryOf + join(vaultDir, …) — the code that runs in production — unexercised.
  guard('(n5) missing part', () => {
    const ghostAbs = join(FIXTURES, '__no-such-part__.md');
    const { parts: got, missing } = readCorpusParts([join(FIXTURES, 'clean.md'), ghostAbs]);
    if (!missing.includes(ghostAbs)) fails.push('MISSING PART: an absent part was not reported missing');
    if (got.length !== 1) fails.push(`MISSING PART: expected the readable part to survive, got ${got.length}`);

    const cfgGhost = JSON.parse(JSON.stringify(cfg));
    const entry = corpusEntryOf(cfgGhost);
    if (entry && Array.isArray(entry.parts)) {
      const GHOST = 'Claude files/rules/__this-part-does-not-exist__.md';
      entry.parts = [...entry.parts, GHOST];
      const viaConfig = resolveCorpus(cfgGhost, {}); // {} ⇒ no env, so the CONFIG path is forced
      if (viaConfig.source !== 'config-parts') fails.push(`config-driven resolution did not engage (source=${viaConfig.source})`);
      if (viaConfig.parts[0] !== DEFAULT_CORPUS) fails.push('config-driven parts[0] is not the anchor');
      if (!viaConfig.parts.every((p) => p.startsWith(viaConfig.vaultDir))) fails.push('config-driven parts did not resolve against dirname(anchor)');
      const resolvedGhost = join(viaConfig.vaultDir, GHOST);
      if (!readCorpusParts(viaConfig.parts).missing.includes(resolvedGhost)) {
        fails.push('MISSING PART (config path): a genuinely absent declared part was not reported missing');
      }
    }
  });

  // (n6) vaultDir ANCHORING. A part in a SUBDIRECTORY must not move vaultDir — otherwise every
  // vault-path and home-path claim rebases and the local-only classes go quietly wrong. Measured:
  // pointing the corpus inside `Claude files/rules/` yields 11 spurious `vault-path MISSING`.
  guard('(n6) vaultDir anchoring', () => {
    const anchor = '/tmp/algovault-fixture-vault/CLAUDE.md';
    const sub = '/tmp/algovault-fixture-vault/Claude files/rules/deep.md';
    const r = resolveCorpus(cfg, { [PARTS_ENV]: `${anchor}:${sub}` });
    if (r.error) fails.push(`vaultDir anchoring: resolveCorpus errored: ${r.error}`);
    else {
      if (r.vaultDir !== dirname(anchor)) fails.push(`vaultDir ANCHORING: got ${r.vaultDir}, expected ${dirname(anchor)}`);
      if (r.vaultDir === dirname(sub)) fails.push('vaultDir ANCHORING: vaultDir followed the SUBDIRECTORY part — every vault-path claim would rebase');
      if (r.parts.length !== 2) fails.push(`vaultDir anchoring fixture lost a part (${r.parts.length})`);
    }
    // …and the override must carry vaultReachable with it, or a caller can relocate vaultDir and
    // still be told the OLD directory's reachability.
    const ctxOverride = makeContext(cfg, { vaultDir: '/tmp' });
    if (ctxOverride.vaultDir !== '/tmp') fails.push('makeContext ignored an explicit vaultDir override');
    if (ctxOverride.vaultReachable !== existsSync('/tmp')) fails.push('vaultReachable did not follow the vaultDir override');
    // Two corpus declarations with no defined precedence must REFUSE, not silently pick one.
    const both = resolveCorpus(cfg, { [CORPUS_ENV]: '/a/x.md', [PARTS_ENV]: '/a/y.md' });
    if (!both.error) fails.push('both corpus env seams set at once did not refuse — silent precedence');
    // The single-file seam still means THAT ONE FILE ONLY; R1.3's baseline depends on it.
    const single = resolveCorpus(cfg, { [CORPUS_ENV]: '/a/only.md' });
    if (single.error || single.parts.length !== 1 || single.parts[0] !== '/a/only.md') {
      fails.push('ALGOVAULT_CLAUDEMD_CORPUS no longer means exactly one file');
    }
  });

  // (n7) `part` IS LOCATION, NEVER IDENTITY — the same law as `line`, and it must hold in BOTH the
  // id and the lock. If it entered identity, relocating a rule would change every id, which is the
  // precise thing this wave proves does not happen.
  guard('(n7) part is location', () => {
    if (claimId({ class: 'repo-path', value: 'scripts/x.mjs', part: 'a.md' })
        !== claimId({ class: 'repo-path', value: 'scripts/x.mjs', part: 'verification-gates.md' })) {
      fails.push('`part` leaked into claim identity — relocating a rule would rewrite every id');
    }
    if (cleanText) {
      const lock = buildLock([mkPart('clean.md', cleanText)], cfg);
      if (!lock.claims.length) fails.push('lock-shape fixture produced no lockable claims — vacuous');
      for (const c of lock.claims) {
        if ('part' in c) { fails.push(`the lock carries a \`part\` field (${claimId(c)}) — location must never be locked`); break; }
        if ('line' in c) { fails.push(`the lock carries a \`line\` field (${claimId(c)})`); break; }
      }
      if (!/^[0-9a-f]{64}$/.test(String(lock.extracted_from_corpus_sha256))) fails.push('corpus provenance is not a sha256 digest');
    }
  });

  // (n8) DUPLICATE-MANUAL REFUSAL — a renamed snapshot must be caught STRUCTURALLY, since the
  // filename guard only knows `_ORIGINAL-CLAUDE-md-*`.
  //
  // The fixture is shaped like the REAL artefacts, which is the whole point: the previous cut of
  // this scenario asserted byte-containment against a synthetic `outer ⊃ inner` pair, and it PASSED
  // while the guard provably did not fire on the live snapshot. A fixture that can only exercise
  // the easy case is the hermetic-seam blindness again — so the positive case here carries the
  // manual's own top-level sections (what a full manual always has) and the negative cases are
  // shaped like rule bodies (what a fragment always is).
  guard('(n8) duplicate manual', () => {
    const MANUAL = '# Manual\n\n## FACTUALITY (THE LAW)\n\nx\n\n## Precedence (THE LAW)\n\ny\n\n## Never\n\nz\n';
    const BODY = '# Verification gate patterns\n\n> Trigger — read this file BEFORE writing code.\n\n- a rule about `scripts/check-canaries-wired.mjs`.\n';
    const anchor = mkPart('CLAUDE.md', MANUAL);
    const body = mkPart('verification-gates.md', BODY);
    const renamedSnapshot = mkPart('rules-archive-2026.md', MANUAL);
    if (duplicateManualParts([anchor, body], 'CLAUDE.md').length !== 0) {
      fails.push('DUPLICATE-MANUAL: a legitimate anchor + rule body was wrongly refused');
    }
    const caught = duplicateManualParts([anchor, body, renamedSnapshot], 'CLAUDE.md');
    if (!caught.some((d) => d.part.endsWith('rules-archive-2026.md'))) {
      fails.push('DUPLICATE-MANUAL: a RENAMED full-manual snapshot was not refused — the filename guard is then the only control');
    }
    // …and byte-identical parts under two names, which is the same defect with no headings needed.
    const twin = duplicateManualParts([anchor, body, mkPart('copy-of-body.md', BODY)], 'CLAUDE.md');
    if (!twin.some((d) => /byte-identical/.test(d.why))) fails.push('DUPLICATE-MANUAL: two byte-identical parts were not refused');
  });

  return fails;
}

/**
 * What a corpus-independent pass does NOT cover.
 *
 * Q3(b): a green `--self-test` proves the MECHANISM, never the live corpus — the vault is
 * unreachable in CI by design. Printing that explicitly is the difference between a reported pass
 * and a silent one, and it is the same discipline as asserting positive per-row output rather than
 * absence-of-alert.
 */
function announceSelfTestCoverage(cfg) {
  const corpus = resolveCorpus(cfg);
  const reachable = !corpus.error && existsSync(corpus.anchor);
  console.log('  NOT verified by this suite (corpus-independent by design):');
  console.log('    · equality of the LIVE claim set against the recorded pre-split baseline —');
  console.log('      that is `--baseline <file>`, a LOCAL gate with its own CLAUDEMD_BASELINE_VERDICT token.');
  console.log(`    · the local-only claim classes (vault-path, absence-vault, home-path) — corpus ${
    reachable ? 'IS reachable here, so `--check` does verify them' : 'is UNREACHABLE here (CI), so `--check` reports them UNREACHABLE'}.`);
  console.log('    · host-path truth, which is asserted on-host by the daily reconciler (DOC_PATH_CLAIM).');
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const IS_MAIN = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// `token` is a parameter because --baseline is a DIFFERENT gate answering a different question,
// and two gates sharing one token name would make a caller unable to tell which one spoke. Exactly
// one terminal token per invocation either way; the codes are this script's existing 0/1/3.
function emit(verdict, why, token = 'CLAUDEMD_CLAIMS_VERDICT') {
  if (why) console.log(`\n${verdict === 'FAIL' ? '✖' : 'ℹ'} ${why}`);
  console.log(`${token}=${verdict}`);
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
    console.log('✓ claudemd-claims self-test passed (dead prescriptive path fires; correction blocks do not; vacuity guarded both ways; corpus-set merge/move-invariance/dedupe/missing-part/anchoring proven)');
    announceSelfTestCoverage(cfg);
    process.exit(0);
  }
  if (argv.includes('--measure')) { runMeasure(cfg); process.exit(0); }
  if (argv.includes('--baseline')) {
    const at = argv.indexOf('--baseline');
    const { verdict, why } = runBaseline(cfg, argv[at + 1]);
    emit(verdict, why, 'CLAUDEMD_BASELINE_VERDICT');
  }
  if (argv.includes('--sync')) {
    const corpus = resolveCorpus(cfg);
    if (corpus.error) emit('INDETERMINATE', corpus.error);
    if (!existsSync(corpus.anchor)) emit('INDETERMINATE', `--sync needs the corpus; anchor not found at ${corpus.anchor}`);
    const { parts, missing } = readCorpusParts(corpus.parts);
    // --sync writes the committed lock, so an INCOMPLETE corpus is the one thing it must never
    // absorb: syncing 6 of 7 parts would silently drop the missing part's claims and bake the loss
    // in — the exact failure this wave exists to make impossible.
    if (missing.length) emit('INDETERMINATE', `--sync refuses an incomplete corpus; unreadable part(s): ${missing.join(', ')}`);
    const dupes = duplicateManualParts(parts, basename(corpus.anchor));
    if (dupes.length) emit('INDETERMINATE', `--sync refuses a duplicated corpus: ${dupes[0].part} ${dupes[0].why}`);
    const lock = buildLock(parts, cfg);
    const next = JSON.stringify(lock, null, 2) + '\n';
    const prevRaw = existsSync(LOCK_PATH) ? readFileSync(LOCK_PATH, 'utf8') : null;
    const prevLock = prevRaw ? JSON.parse(prevRaw) : null;

    // ── ID-GATED SYNC ───────────────────────────────────────────────────────────────────────
    // The whole point of claim-set freshness is that a prose edit is not a claim change. If
    // --sync still rewrote the file on every prose edit, the lock would churn anyway and two
    // sessions syncing would keep colliding on the same rows — the defect would survive in the
    // one place it is most visible. So: no-op unless the CLAIM SET changed.
    //
    // The exception is a lock still in the OLD shape (line-bearing, `corpus_sha256`). That must
    // be rewritten once even though its id set is identical — that rewrite IS the migration.
    const oldShape = Boolean(prevLock) && prevLock.extracted_from_corpus_sha256 === undefined;
    if (prevLock && !oldShape && sameClaimSet(prevLock.claims, lock.claims)) {
      console.log(`lock already fresh — claim set unchanged (${claimIdSet(lock.claims).length} claim ids).`);
      console.log('  Prose moved but no claim did, so the lock is NOT rewritten: freshness is claim-set');
      console.log('  equality, and rewriting here is what used to make every session collide on this file.');
      process.exit(0);
    }
    if (prevRaw === next) { console.log(`lock already fresh (${lock.claims.length} claims)`); process.exit(0); }
    writeFileSync(LOCK_PATH, next);
    const why = oldShape ? ' (migrated to claim-set shape: line numbers dropped, provenance field renamed)' : '';
    console.log(`lock written: ${lock.claims.length} claims, ${claimIdSet(lock.claims).length} ids${why} — commit ops/claudemd-claims.lock.json`);
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
