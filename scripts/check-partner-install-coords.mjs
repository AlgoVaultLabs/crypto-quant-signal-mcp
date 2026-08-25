#!/usr/bin/env node
/**
 * BINANCE-AGENT-OS-TRUTH-AND-PAGE-W1 CH1 — retire the "partner install command verified once
 * in prose, then rots" class.
 *
 * A partner coordinate — an npm package, a Claude Code plugin owner/repo, a skills-ecosystem
 * repo, a remote MCP endpoint, a vendor doc URL — is written into public copy once, checked by
 * a human reading a page, and then decays silently. Measured 2026-08-25: our live copy shipped
 * `claude plugin install binance/binance-skills-hub`, which CANNOT work, because that repo has
 * no `.claude-plugin/` manifest (`contents/.claude-plugin` → 404). It carried the footer note
 * "Tutorials verified 2026-05-19". Prose verification IS the generator of the class, so the
 * fix is a gate, not a correction.
 *
 * This audit RESOLVES every coordinate against its vendor's live artifact and fails when one
 * cannot exist. It scans the SOURCES, never the rendered HTML — a rendered page is derived, and
 * fixing HTML is a lane fix the next generator run silently reverts.
 *
 *   node scripts/check-partner-install-coords.mjs            # report
 *   node scripts/check-partner-install-coords.mjs --check    # gate
 *   node scripts/check-partner-install-coords.mjs --self-test
 *
 * tests/unit/partner-install-coords.test.ts imports `auditPartnerInstallCoords()` and
 * `extractCoordinates()`, so the pre-push test-gate and deploy.yml's vitest step both block a
 * push that introduces an unresolvable coordinate. Modelled on the sibling
 * scripts/check-attribution-src-coverage.mjs (exported audit fn + a unit test as the wiring),
 * which is how `check-canaries-wired.mjs` sees a gate as WIRED — it holds no registry, it looks
 * for a real (non-comment) invocation from a workflow, a package.json script, or another file.
 *
 * ── VERDICT TOKEN (the gates LAW) ─────────────────────────────────────────────────────────
 * Exactly ONE terminal machine-readable line: `PARTNER_INSTALL_VERDICT=CLEAN|DRIFT|INDETERMINATE`.
 * Callers gate on the TOKEN, never the exit code. Codes: 0=CLEAN / 1=DRIFT / 3=INDETERMINATE.
 * 3 is the token-law default for a NEW gate — this script has no incumbent code for "could not
 * verify", so it does not inherit check_test_baseline.sh's 2, and the two must not be aligned.
 *
 * A gate that verified NOTHING must never be indistinguishable from one that verified
 * everything, so: network unreachable, DNS failure, rate-limit, timeout, TLS failure, an
 * unreadable/corrupt cache, and a scan that found ZERO coordinates are all INDETERMINATE.
 * Zero coordinates is the regex-stopped-matching failure mode — the one a "nothing found, so
 * nothing is broken" gate can never report.
 *
 * ── The MCP-endpoint predicate is FOUR states, and that is load-bearing (R2b) ──────────────
 * An auth challenge is proof of life, not absence of it. Binance's live endpoint answers
 * `initialize` with `HTTP 401` + `www-authenticate: Bearer resource_metadata="…"` — the correct
 * MCP OAuth handshake per RFC 9728. A naive "no result.serverInfo ⇒ fictional" rule would mark
 * a live partner endpoint fictional, and this wave's own CH2 could then never pass CH1's gate.
 *   200 + result.serverInfo ................................. CLEAN (live, open)
 *   401/403 CARRYING a www-authenticate challenge ........... CLEAN (live, auth-gated)
 *   401/403 WITHOUT a www-authenticate header ............... INDETERMINATE (WAF/edge block —
 *                                                             indistinguishable, we verified nothing)
 *   404 / NXDOMAIN / connection refused ..................... FICTIONAL (nothing is listening)
 *   timeout / 429 / TLS failure ............................. INDETERMINATE
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Source files scanned in addition to the tutorial markdown tree. */
const SCAN_DIRS_TS = ['src/lib/integrations-data'];
/**
 * Tutorial markdown ROOT — deliberately the whole tree, not the `mcp-clients/` literal the
 * sibling attribution gate used to carry. A future tutorial directory must not be able to
 * escape this gate merely by existing.
 */
const DOCS_MD_ROOT = 'docs/integrations';

const CACHE_PATH = join(ROOT, '.cache', 'partner-install-coords.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Our own host — an AlgoVault URL is not a PARTNER coordinate and is not probed here. */
const OWN_MCP_HOST = 'api.algovault.com';

// ── Coordinate extraction ────────────────────────────────────────────────────────────────────

/**
 * Strip line and block comments so a coordinate MENTIONED in prose is not probed as if it were
 * shipped copy. Same reason `check-canaries-wired.mjs` strips comments: an explanatory docblock
 * quoting a historical bad form is the most valuable text in the file, and a naive scan demands
 * its deletion. Markdown has no comment syntax we rely on, so only *.ts is stripped.
 */
export function stripComments(text) {
  // Blank the comment IN PLACE, preserving newlines. Collapsing a comment to a single space
  // shifts every subsequent line number, so the gate names a line that is not the one it read —
  // worse than naming none, because it reads as precise. Measured on first run: a finding was
  // reported at `exchange-kits.ts:32` whose real position is `:45`.
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/^[ \t]*\/\/.*$/gm, blank);
}

/**
 * Is this URL a remote MCP ENDPOINT (a thing you POST JSON-RPC to), or merely a documentation
 * page whose URL happens to contain the letters "mcp"?
 *
 * "Contains mcp" is not "is an MCP endpoint", and conflating them is not a cosmetic problem: the
 * gate POSTs a JSON-RPC body to every match, so a vendor doc page answers 405/404/308 and gets
 * reported as FICTIONAL or UNVERIFIED. Measured on first run — 18 of 20 `mcp-endpoint`
 * extractions were documentation links, and `support.claude.com/…/remote-mcp` was called
 * FICTIONAL while a plain GET returns 200.
 *
 * The discriminator is structural: an MCP endpoint carries a bare `mcp` PATH SEGMENT (ours is
 * `api.algovault.com/mcp`, Binance's is `agent.binance.com/mcp/agentic`), and documentation
 * hosts/paths are excluded outright. `…/langchain-mcp-adapters` and `…/crypto-quant-signal-mcp`
 * have no such segment and are correctly not endpoints.
 */
export function isLikelyMcpEndpoint(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  const segments = u.pathname.split('/').filter(Boolean);
  if (!segments.includes('mcp')) return false;
  if (/^(docs|support|learn|help|developer|developers)\./i.test(u.hostname)) return false;
  if (/^(github\.com|www\.npmjs\.com|pypi\.org|registry\.npmjs\.org)$/i.test(u.hostname)) return false;
  if (segments.some((s) => /^(docs?|guides?|articles?|blog)$/i.test(s))) return false;
  if (/\.(html?|md)$/i.test(u.pathname)) return false;
  return true;
}

const PATTERNS = [
  // `claude plugin install <owner>/<repo>`
  { kind: 'claude-plugin', re: /claude\s+plugin\s+install\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/g },
  // `npx skills add <github url>`
  { kind: 'skills-repo', re: /npx\s+skills\s+add\s+(https?:\/\/[^\s"'`<>)]+)/g },
  // `npm i|install <pkg>` — SAME LINE ONLY. `\s+` crosses a newline, and a code block reading
  // `npm install\nnpm run build` then yields the package name "npm". A bare `npm install` with
  // no argument installs from the lockfile and is not a partner coordinate at all.
  { kind: 'npm', re: /npm[ \t]+(?:i|install)[ \t]+(?:-g[ \t]+)?(@?[a-z0-9][a-z0-9._/-]*(?:@[0-9][^\s"'`<>)]*)?)/g },
  // `npx [flags] <pkg>` — the form `@smithery/cli` ships in on the smithery tutorial.
  { kind: 'npm', re: /npx[ \t]+(?:-[a-zA-Z-]+[ \t]+)*(@?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?(?:@[0-9][^\s"'`<>)]*)?)/g },
  // a backticked `<pkg>@<ver>`
  { kind: 'npm', re: /`(@?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?@[0-9][A-Za-z0-9._-]*)`/g },
  // `git clone <repo>` — the Gemini kit ships one, and it decays exactly like the others
  { kind: 'git-repo', re: /git[ \t]+clone[ \t]+(https?:\/\/[^\s"'`<>)]+)/g },
  // a remote MCP endpoint on someone else's host.
  // The capture group is NOT decorative: every pattern here is read through `m[group ?? 1]`, so
  // a group-less regex yields `undefined` and the kind is silently never extracted. The
  // self-test caught exactly that on first run — which is the whole point of asserting each
  // kind individually rather than asserting the corpus is merely non-empty.
  { kind: 'mcp-endpoint', re: /(https:\/\/[a-z0-9.-]+\/[^\s"'`<>)]*mcp[^\s"'`<>)]*)/gi },
  // a vendor link in a footerLinks entry
  { kind: 'doc-url', re: /href:\s*'(https?:\/\/[^']+)'/g },
];

/** `npx -y`, `npm i -g` and friends are flags, not packages. */
const NPM_NOISE = new Set(['-y', '-g', '--yes', 'i', 'install', 'npx']);

/**
 * Extract every partner coordinate from one file's text.
 * Returns [{ kind, value, file, line }]. Pure — no network — so the self-test can drive it.
 */
export function extractCoordinates(text, file) {
  const src = file.endsWith('.ts') ? stripComments(text) : text;
  const found = [];
  const seen = new Set();
  for (const { kind, re, group } of PATTERNS) {
    for (const m of src.matchAll(new RegExp(re.source, re.flags))) {
      let value = (m[group ?? 1] ?? '').trim();
      if (!value) continue;
      if (kind === 'npm') {
        if (NPM_NOISE.has(value)) continue;
        if (value.startsWith('-')) continue;
      }
      if (kind === 'mcp-endpoint') {
        if (value.includes(OWN_MCP_HOST)) continue;   // our own host is not a PARTNER coordinate
        if (!isLikelyMcpEndpoint(value)) continue;    // a doc page that merely says "mcp"
      }
      if (kind === 'doc-url' && value.includes('algovault.com')) continue;
      const line = src.slice(0, m.index).split('\n').length;
      const key = `${kind}::${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ kind, value, file, line });
    }
  }
  return found;
}

/** Every scanned source path, repo-relative. */
export function scanTargets() {
  const targets = [];
  for (const dir of SCAN_DIRS_TS) {
    for (const f of readdirSync(join(ROOT, dir))) {
      if (f.endsWith('.ts')) targets.push(`${dir}/${f}`);
    }
  }
  const walk = (rel) => {
    for (const e of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${rel}/${e.name}`);
      else if (e.name.endsWith('.md')) targets.push(`${rel}/${e.name}`);
    }
  };
  if (existsSync(join(ROOT, DOCS_MD_ROOT))) walk(DOCS_MD_ROOT);
  return targets.sort();
}

// ── Probes ───────────────────────────────────────────────────────────────────────────────────

/** One probe outcome. `state` ∈ resolved | fictional | indeterminate. */
const ok = (detail) => ({ state: 'resolved', detail });
const dead = (detail) => ({ state: 'fictional', detail });
const unknown = (detail) => ({ state: 'indeterminate', detail });

function curlHead(url, extra = []) {
  // `%{http_code}` alone cannot distinguish "404" from "DNS failed"; curl's own exit code can.
  const out = execFileSync('curl', [
    '-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '20', ...extra, url,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return parseInt(out.trim(), 10);
}

/**
 * Pure HTTP-code → state mapping for a "does this artifact exist?" probe. EXPORTED and asserted
 * directly, because the self-test substitutes `probe` wholesale: the classifier is then the one
 * piece of decision logic no scenario executes, and a deliberate break flipping 404 from
 * FICTIONAL to resolved survived the whole suite until this was pulled out.
 */
export function classifyPresenceProbe(code, label) {
  if (code === 200) return ok(`${label} → 200`);
  if (code === 404) return dead(`${label} → 404 — it does not exist`);
  if (code === 403 || code === 429) return unknown(`${label} → ${code} (rate-limited)`);
  if (code === 0) return unknown(`${label} → probe failed`);
  return unknown(`${label} → ${code}`);
}

function probeGithubPath(owner, repo, path) {
  const label = `github ${owner}/${repo}/${path}`;
  try {
    return classifyPresenceProbe(curlHead(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`), label);
  } catch (e) {
    return unknown(`${label} probe failed: ${String(e.message).slice(0, 120)}`);
  }
}

function probeNpm(spec) {
  const at = spec.lastIndexOf('@');
  const hasVersion = at > 0;
  const name = hasVersion ? spec.slice(0, at) : spec;
  const wanted = hasVersion ? spec.slice(at + 1) : null;
  try {
    const versions = execFileSync('npm', ['view', name, 'versions', '--json'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
    });
    const list = JSON.parse(versions);
    const all = Array.isArray(list) ? list : [list];
    if (all.length === 0) return dead(`npm ${name} — no published versions`);
    if (wanted && !all.includes(wanted)) {
      return dead(`npm ${name} — pinned version ${wanted} is not published (latest ${all[all.length - 1]})`);
    }
    return ok(`npm ${name}${wanted ? `@${wanted}` : ''} → ${wanted ?? all[all.length - 1]}`);
  } catch (e) {
    const msg = String(e.stderr || e.message || '');
    if (/E404|is not in this registry|404 Not Found/i.test(msg)) return dead(`npm ${name} → 404, not published`);
    return unknown(`npm probe failed for ${name}: ${msg.replace(/\s+/g, ' ').slice(0, 140)}`);
  }
}

/** R2b — the four-state MCP-endpoint predicate. An auth challenge is proof of life. */
export function classifyMcpProbe({ curlExit, httpCode, headers, body }) {
  if (curlExit === 6 || curlExit === 7) return dead(`connection failed (curl ${curlExit}) — nothing is listening`);
  if (curlExit === 28) return unknown('timeout');
  if (curlExit === 35 || curlExit === 60) return unknown(`TLS failure (curl ${curlExit})`);
  if (curlExit !== 0) return unknown(`curl exit ${curlExit}`);
  if (httpCode === 404) return dead('404 — no MCP endpoint at that URL');
  if (httpCode === 429) return unknown('429 rate-limited');
  if (httpCode === 401 || httpCode === 403) {
    return /^www-authenticate:/im.test(headers)
      ? ok(`${httpCode} + www-authenticate challenge — live, OAuth-gated (RFC 9728)`)
      : unknown(`${httpCode} with NO www-authenticate — indistinguishable from a WAF/edge block`);
  }
  if (httpCode >= 200 && httpCode < 300) {
    // SSE-framed or plain JSON; the transport is stateless, so never assert on Mcp-Session-Id.
    const json = body.split('\n').map((l) => l.replace(/^data:\s*/, '')).filter(Boolean);
    for (const line of json) {
      try {
        if (JSON.parse(line)?.result?.serverInfo) return ok(`${httpCode} with result.serverInfo`);
      } catch { /* not this line */ }
    }
    return unknown(`${httpCode} but no result.serverInfo in the body`);
  }
  return unknown(`HTTP ${httpCode}`);
}

function probeMcpEndpoint(url) {
  const payload = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'algovault-gate', version: '1' } },
  });
  let curlExit = 0; let raw = '';
  try {
    raw = execFileSync('curl', [
      '-sS', '-D', '-', '-o', '/dev/stdout', '-w', '\n__HTTP__%{http_code}', '--max-time', '25',
      '-X', 'POST', url,
      '-H', 'Content-Type: application/json',
      '-H', 'Accept: application/json, text/event-stream',
      '-d', payload,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    curlExit = typeof e.status === 'number' ? e.status : 1;
    raw = String(e.stdout || '');
  }
  const httpCode = parseInt((raw.match(/__HTTP__(\d+)\s*$/) || [])[1] ?? '0', 10);
  const split = raw.indexOf('\r\n\r\n') >= 0 ? raw.indexOf('\r\n\r\n') : raw.indexOf('\n\n');
  const headers = split > 0 ? raw.slice(0, split) : raw;
  const body = split > 0 ? raw.slice(split) : '';
  return classifyMcpProbe({ curlExit, httpCode, headers, body });
}

function probeDocUrl(url) {
  // An npmjs.com package PAGE is CDN-protected and answers 403 to any headless client, so it is
  // permanently unverifiable through the page. The registry is the SoT for the same fact — the
  // same substitution CLAUDE.md already mandates for README verification.
  const npmPage = url.match(/^https?:\/\/(?:www\.)?npmjs\.com\/package\/(.+?)\/?$/);
  if (npmPage) {
    const pkg = npmPage[1].startsWith('@') ? npmPage[1].replace('/', '%2F') : npmPage[1];
    try {
      const code = curlHead(`https://registry.npmjs.org/${pkg}`);
      if (code === 200) return ok(`npm registry ${npmPage[1]} → 200 (page is CDN-protected; registry is the SoT)`);
      if (code === 404) return dead(`npm registry ${npmPage[1]} → 404, package not published`);
      return unknown(`npm registry → ${code}`);
    } catch (e) {
      return unknown(`npm registry probe failed: ${String(e.message).slice(0, 120)}`);
    }
  }
  try {
    // GET, not HEAD: many doc hosts answer 405 to HEAD, which is not a statement about the page.
    const code = curlHead(url, ['-L', '-A', 'Mozilla/5.0 (compatible; AlgoVaultGate/1.0)']);
    if (code >= 200 && code < 300) return ok(`doc ${code}`);
    if (code === 404 || code === 410) return dead(`doc → ${code}`);
    if (code === 429 || code === 403) return unknown(`doc → ${code} (bot mitigation / rate limit)`);
    return unknown(`doc → ${code}`);
  } catch (e) {
    return unknown(`doc probe failed: ${String(e.message).slice(0, 120)}`);
  }
}

/** Resolve one coordinate. Exported so the self-test can drive real probes for known values. */
export function probeCoordinate(coord) {
  switch (coord.kind) {
    case 'claude-plugin': {
      const [owner, repo] = coord.value.split('/');
      return probeGithubPath(owner, repo, '.claude-plugin');
    }
    case 'skills-repo': {
      const m = coord.value.match(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/);
      if (!m) return unknown(`unparseable skills repo URL: ${coord.value}`);
      return probeGithubPath(m[1], m[2].replace(/\.git$/, ''), 'skills');
    }
    case 'npm': return probeNpm(coord.value);
    case 'git-repo': {
      const m = coord.value.match(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
      if (!m) return probeDocUrl(coord.value);
      try {
        return classifyPresenceProbe(curlHead(`https://api.github.com/repos/${m[1]}/${m[2]}`), `git clone ${m[1]}/${m[2]}`);
      } catch (e) {
        return unknown(`git-repo probe failed: ${String(e.message).slice(0, 120)}`);
      }
    }
    case 'mcp-endpoint': return probeMcpEndpoint(coord.value);
    case 'doc-url': {
      const m = coord.value.match(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
      if (m) {
        const code = (() => { try { return curlHead(`https://api.github.com/repos/${m[1]}/${m[2]}`); } catch { return 0; } })();
        return classifyPresenceProbe(code, `github repo ${m[1]}/${m[2]}`);
      }
      return probeDocUrl(coord.value);
    }
    default: return unknown(`unknown coordinate kind ${coord.kind}`);
  }
}

// ── Cache ────────────────────────────────────────────────────────────────────────────────────

/**
 * A cache MISS must probe. A cache ERROR must go INDETERMINATE — a gate that silently treats an
 * unreadable cache as "nothing to check" is the fail-open this token exists to make visible.
 */
function readCache() {
  if (!existsSync(CACHE_PATH)) return { entries: {} };
  try {
    const age = Date.now() - statSync(CACHE_PATH).mtimeMs;
    if (age > CACHE_TTL_MS) return { entries: {} };
    const parsed = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.entries !== 'object' || parsed.entries === null) {
      return { error: 'cache is present but not the expected shape' };
    }
    return { entries: parsed.entries };
  } catch (e) {
    return { error: `cache unreadable: ${String(e.message).slice(0, 120)}` };
  }
}

function writeCache(entries) {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify({ written_at: new Date().toISOString(), entries }, null, 2));
  } catch { /* a cache we cannot write is not a gate failure — the probes already ran */ }
}

// ── Audit ────────────────────────────────────────────────────────────────────────────────────

/**
 * @returns {{verdict:'CLEAN'|'DRIFT'|'INDETERMINATE', coordinates:number, results:Array, reasons:string[]}}
 */
export function auditPartnerInstallCoords({ useCache = true, probe = probeCoordinate, targets } = {}) {
  const coordinates = [];
  // `targets` exists so the ZERO-COORDINATE branch below is reachable from a test. It is a
  // read-scope seam, never a verdict seam: a caller can narrow WHAT is scanned, and can never
  // make this function report a pass it did not compute. Measured need — a deliberate break
  // flipping that branch's verdict from INDETERMINATE to CLEAN went UNDETECTED by the suite,
  // because every scenario ran against the real tree and never produced an empty corpus.
  for (const rel of targets ?? scanTargets()) {
    coordinates.push(...extractCoordinates(readFileSync(join(ROOT, rel), 'utf8'), rel));
  }

  // Vacuity guard, at the point the corpus is OBSERVED: the world built this corpus, but an
  // EMPTY one here means our own regexes stopped matching, which is a defect in this gate.
  if (coordinates.length === 0) {
    return {
      verdict: 'INDETERMINATE', coordinates: 0, results: [],
      reasons: ['0 coordinates found across the whole scan scope — the extraction regexes have drifted, or the scan scope moved. Nothing was verified.'],
    };
  }

  const cache = useCache ? readCache() : { entries: {} };
  if (cache.error) {
    return {
      verdict: 'INDETERMINATE', coordinates: coordinates.length, results: [],
      reasons: [`${cache.error} — delete ${CACHE_PATH} and re-run. Nothing was verified.`],
    };
  }

  const entries = { ...cache.entries };
  const results = [];
  for (const c of coordinates) {
    const key = `${c.kind}::${c.value}`;
    let outcome = entries[key];
    if (!outcome) {
      outcome = probe(c);
      // Never cache an indeterminate: a transient blip must not become a 24h silent pass.
      if (outcome.state !== 'indeterminate') entries[key] = outcome;
    }
    results.push({ ...c, ...outcome });
  }
  if (useCache) writeCache(entries);

  const fictional = results.filter((r) => r.state === 'fictional');
  const indeterminate = results.filter((r) => r.state === 'indeterminate');
  const verdict = fictional.length ? 'DRIFT' : indeterminate.length ? 'INDETERMINATE' : 'CLEAN';
  const reasons = [
    ...fictional.map((r) => `FICTIONAL  ${r.file}:${r.line}  [${r.kind}] ${r.value} — ${r.detail}`),
    ...indeterminate.map((r) => `UNVERIFIED ${r.file}:${r.line}  [${r.kind}] ${r.value} — ${r.detail}`),
  ];
  return { verdict, coordinates: coordinates.length, results, reasons };
}

const EXIT = { CLEAN: 0, DRIFT: 1, INDETERMINATE: 3 };

// ── Self-test ────────────────────────────────────────────────────────────────────────────────

/**
 * Two-way, and it must be PROVEN able to fail. Fixtures are built with the REAL extractor, never
 * hand-written literals: a hermetic self-test is structurally blind to exactly what its own seam
 * replaces, and a fixture in a shape the extractor has never emitted passes for the wrong reason.
 * Every assertion REPORTS — an assertion that throws aborts the suite instead of printing FAIL,
 * which silently converts "proven able to fail" into "crashes".
 */
export function selfTest() {
  const checks = [];
  const check = (name, fn) => {
    let passed = false; let note = '';
    try { const r = fn(); passed = r === true; note = r === true ? '' : String(r); }
    catch (e) { passed = false; note = `threw: ${String(e.message).slice(0, 140)}`; }
    checks.push({ name, passed, note });
  };

  // (1) The extractor sees each kind — corpus built HERE, so empty is vacuity and must refuse.
  const fixture = [
    "  setupSummary: '<code>claude plugin install binance/binance-skills-hub</code>',",
    "  install: 'npx skills add https://github.com/binance/binance-skills-hub',",
    '  run: `npm install bitget-mcp-server`,',
    '  alt: `npx -y @smithery/cli install thing`,',
    '  src: `git clone https://github.com/gemini/developer-platform`,',
    "  endpoint: 'https://agent.binance.com/mcp/agentic',",
    "  { label: 'Hub', href: 'https://github.com/binance/binance-skills-hub' },",
    "  ours: 'https://api.algovault.com/mcp?src=docs',",
  ].join('\n');
  const got = extractCoordinates(fixture, 'fixture.ts');
  check('fixture corpus is non-empty (vacuity guard)', () => got.length > 0 || 'extractor produced 0 coordinates from a hand-built fixture — the test built nothing');
  for (const kind of ['claude-plugin', 'skills-repo', 'npm', 'mcp-endpoint', 'doc-url', 'git-repo']) {
    check(`extracts kind=${kind}`, () => got.some((c) => c.kind === kind) || `no ${kind} coordinate extracted`);
  }
  check('our own MCP host is not treated as a partner coordinate',
    () => !got.some((c) => c.value.includes(OWN_MCP_HOST)) || 'api.algovault.com leaked into the coordinate set');

  // (2) Comments are stripped — a historical bad form quoted in a docblock is not shipped copy.
  check('a coordinate inside a block comment is NOT extracted', () => {
    const c = extractCoordinates('/* claude plugin install ghost/repo */\nconst x = 1;', 'x.ts');
    return c.length === 0 || `extracted ${c.length} coordinate(s) from a pure comment`;
  });

  // (3) MUST-CATCH — a fictional coordinate produces DRIFT.
  //
  // The stub keys on ORDINAL POSITION, never on a vendor value. It used to return `dead` for
  // `binance/binance-skills-hub` — the very coordinate this chapter REMOVES — so the moment the
  // repair landed, the corpus no longer contained the value and the scenario silently degraded
  // into MUST-PASS: `CLEAN` instead of `DRIFT`, self-test red. A must-catch scenario that
  // depends on the defect still being present in the tree can only work until it is fixed.
  let n = 0;
  const fakeProbe = () => (n++ === 0 ? dead('synthetic: unresolvable coordinate') : ok('fine'));
  const drifted = auditPartnerInstallCoords({ useCache: false, probe: fakeProbe });
  check('MUST-CATCH: a fictional coordinate ⇒ DRIFT',
    () => drifted.verdict === 'DRIFT' || `verdict was ${drifted.verdict}, expected DRIFT`);
  check('MUST-CATCH: exit code for DRIFT is 1', () => EXIT[drifted.verdict] === 1 || `mapped to ${EXIT[drifted.verdict]}`);

  // (4) MUST-PASS — every coordinate resolving produces CLEAN.
  const clean = auditPartnerInstallCoords({ useCache: false, probe: () => ok('resolved') });
  check('MUST-PASS: all-resolved ⇒ CLEAN', () => clean.verdict === 'CLEAN' || `verdict was ${clean.verdict}`);
  check('MUST-PASS: exit code for CLEAN is 0', () => EXIT[clean.verdict] === 0 || `mapped to ${EXIT[clean.verdict]}`);

  // (4b) ZERO coordinates is the regex-stopped-matching failure mode. It must be INDETERMINATE,
  // never CLEAN — "found nothing" and "verified everything" are the two things a gate may never
  // conflate. Reachable only because `targets` narrows the read scope.
  const empty = auditPartnerInstallCoords({ useCache: false, targets: [], probe: () => ok('unused') });
  check('zero coordinates ⇒ INDETERMINATE, never CLEAN',
    () => empty.verdict === 'INDETERMINATE' || `verdict was ${empty.verdict} over an empty corpus`);
  check('zero-coordinate INDETERMINATE maps to exit 3', () => EXIT[empty.verdict] === 3 || `mapped to ${EXIT[empty.verdict]}`);
  check('zero-coordinate verdict states WHY', () => (empty.reasons[0] || '').includes('0 coordinates') || 'no reason printed');

  // (4c) The REAL presence classifier — the self-test swaps `probe` wholesale, so this mapping
  // is seam-bypassed and was provably breakable while the suite stayed green.
  for (const [code, want] of [[200, 'resolved'], [404, 'fictional'], [403, 'indeterminate'],
                              [429, 'indeterminate'], [500, 'indeterminate'], [0, 'indeterminate']]) {
    check(`presence classifier: HTTP ${code} ⇒ ${want}`,
      () => classifyPresenceProbe(code, 'x').state === want || `got ${classifyPresenceProbe(code, 'x').state}`);
  }

  // (4d) The discriminator must be WIRED, not merely correct. Asserting the pure function leaves
  // a break that deletes its call site invisible — measured.
  check('discriminator is wired into extraction: a doc URL yields no mcp-endpoint', () => {
    const c = extractCoordinates("  a: 'https://code.claude.com/docs/en/mcp',", 'x.ts');
    return !c.some((x) => x.kind === 'mcp-endpoint') || 'a documentation URL was extracted as an MCP endpoint';
  });
  check('discriminator is wired into extraction: a real endpoint IS extracted', () => {
    const c = extractCoordinates("  a: 'https://agent.binance.com/mcp/agentic',", 'x.ts');
    return c.some((x) => x.kind === 'mcp-endpoint') || 'a real MCP endpoint was not extracted';
  });

  // (5) An indeterminate probe must NOT launder into a pass, and must map to 3.
  const murky = auditPartnerInstallCoords({ useCache: false, probe: () => unknown('rate-limited') });
  check('an unverifiable coordinate ⇒ INDETERMINATE, never CLEAN',
    () => murky.verdict === 'INDETERMINATE' || `verdict was ${murky.verdict}`);
  check('INDETERMINATE maps to exit 3', () => EXIT[murky.verdict] === 3 || `mapped to ${EXIT[murky.verdict]}`);

  // (6) R2b — the four-state MCP predicate, INCLUDING the state the naive rule gets wrong.
  const mcp = [
    ['200 + serverInfo', { curlExit: 0, httpCode: 200, headers: '', body: 'data: {"result":{"serverInfo":{"name":"x"}}}' }, 'resolved'],
    ['401 + www-authenticate', { curlExit: 0, httpCode: 401, headers: 'HTTP/2 401\r\nwww-authenticate: Bearer realm="x"', body: '' }, 'resolved'],
    ['401 WITHOUT www-authenticate', { curlExit: 0, httpCode: 401, headers: 'HTTP/2 401\r\nserver: waf', body: '' }, 'indeterminate'],
    ['404', { curlExit: 0, httpCode: 404, headers: '', body: '' }, 'fictional'],
    ['connection refused', { curlExit: 7, httpCode: 0, headers: '', body: '' }, 'fictional'],
    ['timeout', { curlExit: 28, httpCode: 0, headers: '', body: '' }, 'indeterminate'],
    ['429', { curlExit: 0, httpCode: 429, headers: '', body: '' }, 'indeterminate'],
  ];
  for (const [name, input, want] of mcp) {
    check(`R2b ${name} ⇒ ${want}`, () => {
      const g = classifyMcpProbe(input).state;
      return g === want || `got ${g}`;
    });
  }

  // (7) A pinned npm version that does not exist is FICTIONAL, not a pass.
  check('extractor captures a pinned backticked spec', () => {
    const c = extractCoordinates('see `bitget-mcp-server@1.1.0` for details', 'x.md');
    return c.some((x) => x.kind === 'npm' && x.value === 'bitget-mcp-server@1.1.0') || 'pinned spec not captured';
  });
  // A code block whose next line starts with `npm` must not yield the package name "npm".
  check('bare `npm install` does not become a coordinate named "npm"', () => {
    const c = extractCoordinates('npm install\nnpm run build', 'x.ts');
    return !c.some((x) => x.value === 'npm') || 'extracted a package literally called "npm"';
  });
  check('npx flags are skipped, the package is captured', () => {
    const c = extractCoordinates('npx -y @smithery/cli install foo', 'x.md');
    return c.some((x) => x.kind === 'npm' && x.value === '@smithery/cli') || `got ${JSON.stringify(c.map((x) => x.value))}`;
  });

  // (8) "contains mcp" is NOT "is an MCP endpoint". Each row below was a live false positive on
  // this gate's first run; a doc page POSTed with JSON-RPC answers 405/404 and reads as dead.
  const endpointCases = [
    ['https://agent.binance.com/mcp/agentic', true],
    ['https://api.algovault.com/mcp', true],
    ['https://cursor.com/docs/context/mcp', false],
    ['https://code.claude.com/docs/en/mcp', false],
    ['https://docs.cline.bot/mcp/connecting-to-a-remote-server', false],
    ['https://docs.crewai.com/en/mcp/overview', false],
    ['https://moonshotai.github.io/kimi-code/en/customization/mcp.html', false],
    ['https://www.npmjs.com/package/bitget-mcp-server', false],
    ['https://github.com/langchain-ai/langchain-mcp-adapters', false],
    ['https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/issues', false],
    ['https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp', false],
    ['https://pypi.org/project/llama-index-tools-mcp/', false],
    ['https://smithery.ai/server/@AlgoVaultLabs/crypto-quant-signal-mcp', false],
  ];
  for (const [url, want] of endpointCases) {
    check(`endpoint discriminator: ${want ? 'IS' : 'is NOT'} an endpoint — ${url.slice(0, 62)}`,
      () => isLikelyMcpEndpoint(url) === want || `got ${!want}`);
  }

  // (9) Line numbers must index the ORIGINAL file. Blanking a comment to one space shifts every
  // later line, so the gate names a line it never read — precise-looking and wrong.
  check('comment stripping preserves line numbers', () => {
    const text = ['/* a', ' * multi-line', ' * docblock', ' */', 'const a = 1;',
      "  x: 'claude plugin install owner/repo',"].join('\n');
    const c = extractCoordinates(text, 'x.ts');
    return (c[0]?.line === 6) || `reported line ${c[0]?.line}, expected 6`;
  });

  const failed = checks.filter((c) => !c.passed);
  for (const c of checks) console.log(`  ${c.passed ? 'PASS' : 'FAIL'}  ${c.name}${c.note ? ` — ${c.note}` : ''}`);
  console.log(`SELF-TEST: ${failed.length ? `FAIL (${failed.length}/${checks.length})` : `PASS (${checks.length} assertions)`}`);
  return failed.length === 0;
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────

const IS_MAIN = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) {
    process.exit(selfTest() ? 0 : 1);
  }
  let out;
  try {
    out = auditPartnerInstallCoords();
  } catch (e) {
    // The token law forbids dying with no verdict at all.
    console.error(`[partner-install-coords] ${String(e.stack || e.message)}`);
    console.log('PARTNER_INSTALL_VERDICT=INDETERMINATE');
    process.exit(EXIT.INDETERMINATE);
  }
  // Positive per-coordinate output: a row silently skipped by a load error must not look like
  // a row that passed. Print the corpus size beside every result.
  for (const r of out.results) {
    const glyph = r.state === 'resolved' ? 'ok  ' : r.state === 'fictional' ? 'DEAD' : 'UNK ';
    console.log(`  ${glyph} [${r.kind}] ${r.value}  (${r.file}:${r.line})  ${r.detail}`);
  }
  console.log(`[partner-install-coords] ${out.coordinates} coordinate(s) across ${scanTargets().length} source file(s).`);
  for (const reason of out.reasons) console.error(`  ${reason}`);
  if (out.verdict === 'DRIFT') {
    console.error('\nFix: correct the coordinate in its SOURCE (never the rendered HTML), re-run the generator, commit the output.');
  }
  console.log(`PARTNER_INSTALL_VERDICT=${out.verdict}`);
  process.exit(EXIT[out.verdict]);
}
