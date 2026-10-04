#!/usr/bin/env node
// @ts-check
/**
 * check-packument-read.mjs — OPS-DISTTAG-EVENTUAL-CONSISTENCY-W1 CH1 R3.
 *
 * A RATCHET: no tracked workflow or script may read back OUR OWN package's cached registry documents.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────────────────────
 * CLAUDE.md § Verification gates already says a CDN-cached raw read is controlled by a
 * cache-buster or a pinned SHA, never by the URL form. scripts/check-smithery-sync.mjs says the same
 * for another vendor. Nothing checked it, and publish-npm.yml's `Verify dist-tag` step asserted
 * the CACHED packument (`public, max-age=300`) seconds after `npm publish` returned. That is one of
 * the two defects behind the red lane. The other, npm's publish-time propagation delay, is
 * handled by scripts/verify-npm-propagation.mjs. The law has been written three times; this file
 * makes it checkable.
 *
 * ── THE PREDICATE — our own package name, never "any package" ───────────────────────────────
 * The class is READ-YOUR-WRITE: asserting a value a publish just changed. Only a package THIS repo
 * publishes can have been "just changed" by this repo, so the predicate is scoped to the `name` in
 * package.json. Flagging every package would force correct third-party reads into the baseline
 * (scripts/check-partner-install-coords.mjs, scripts/gates/cmc-ch1-gate.sh,
 * src/lib/integrations-data/*, ops/monitoring/client-claim-freshness.py all read OTHER packages,
 * which never read back our publish). Every registry occurrence is still CLASSIFIED and PRINTED,
 * so an exemption is visible rather than silent.
 *
 *   FORBIDDEN  OWN_PACKUMENT      registry/<own>            measured HIT, public, max-age=300
 *   FORBIDDEN  OWN_DIST_TAG_DOC   registry/<own>/<tag>      e.g. /latest; measured HIT on repeat
 *   allowed    OWN_VERSION_DOC    registry/<own>/<semver>   immutable; a 404 is not cached
 *   allowed    OWN_TARBALL        registry/<own>/-/…        immutable
 *   allowed    OWN_REGISTRY_API   registry/-/package/<own>/… e.g. dist-tags: DYNAMIC, no cache-control
 *   exempt     BARE_HOST          registry                  config (setup-node `registry-url:`); no package path
 *   exempt     BASE_URL           registry/ + runtime       a base string; what is appended is not visible here
 *   exempt     REGISTRY_API       registry/-/…              not a package document (e.g. /-/v1/search)
 *   exempt     THIRD_PARTY        registry/<other>          not our publish
 *   report     RUNTIME_ASSEMBLED  registry/${…}             uncatchable textually; stated, not judged
 *
 * The bare-host form (publish-npm.yml's `registry-url:` on setup-node) has no package path, so it
 * is STRUCTURALLY unmatchable by the forbidden kinds: no allow-list row is needed for it.
 *
 * ── THE DATA FILE: ops/packument-read-baseline.json ─────────────────────────────────────────
 * Two SEPARATE top-level keys, never merged:
 *   "baseline": [{file, count, reason, date}]   the debt, which may only SHRINK. Seeded EMPTY.
 *   "allow":    ["scripts/lib/npm-registry-read.mjs"]   the one file allowed to NAME the
 *               packument shape (it exports PACKUMENT_URL so this gate has one source for it).
 * Same shape of discipline as scripts/check-colour-literal-ratchet.mjs and
 * ops/adapter-numeric-guard-baseline.json: `--write-baseline` only LOWERS rows; raising one needs
 * `--allow-raise <file> --reason "<why>"`, which stores the reason and date in `raises[]`. There is
 * no env lever.
 *
 * ── HONEST SCOPE ─────────────────────────────────────────────────────────────────────────────
 * A TEXTUAL scan of tracked files (.yml/.yaml/.mjs/.cjs/.js/.ts/.sh/.bash/.py/.json, excluding
 * prose dirs and package-lock.json). It catches the literal URL shape for our own package. It
 * CANNOT catch:
 *   · a URL assembled at runtime (`${REGISTRY}/${pkg}`), reported as RUNTIME_ASSEMBLED/BASE_URL;
 *   · a read in another repo;
 *   · a vendor cache-policy change. tests/unit/npm-registry-read.test.ts's LIVE leg covers that.
 * Comments are stripped with the shared scripts/lib/strip-comments.mjs before matching: a mention
 * is not a read. That stripper has no Python syntax, so a .py COMMENT naming our packument would
 * be counted. That is a false positive, never a false negative, and it is stated here.
 *
 * ── VERDICT ─────────────────────────────────────────────────────────────────────────────────
 *   PACKUMENT_READ_VERDICT=PASS            exit 0   no forbidden read beyond the baseline
 *   PACKUMENT_READ_VERDICT=FAIL            exit 1   a forbidden read over baseline, or a stale allow row
 *   PACKUMENT_READ_VERDICT=INDETERMINATE   exit 3   package.json / baseline unreadable or malformed,
 *                                                   git listing failed, or an EMPTY corpus
 * 3 is the token-law default for a new gate. Callers gate on the TOKEN. The token is the LAST line
 * and the process ends via process.exitCode, never process.exit(), because a queued pipe write
 * would be dropped (tests/unit/verdict-exit-path.test.ts).
 *
 * Usage:
 *   node scripts/check-packument-read.mjs                  # enforce
 *   node scripts/check-packument-read.mjs --self-test      # every class, both directions, offline
 *   node scripts/check-packument-read.mjs --write-baseline # lower rows only
 *   node scripts/check-packument-read.mjs --allow-raise <file> --reason "<why>"
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripComments } from './lib/strip-comments.mjs';
import { REGISTRY } from './lib/npm-registry-read.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINE_REL = 'ops/packument-read-baseline.json';
const TOKEN = 'PACKUMENT_READ_VERDICT';

/** 0=PASS / 1=FAIL / 3=INDETERMINATE. ONE meaning, ONE code. */
export const EXIT = Object.freeze({ PASS: 0, FAIL: 1, INDETERMINATE: 3 });

/** The registry host, derived from the reader module: one spelling of it in the estate. */
export const HOST = new URL(REGISTRY).host;

export const CORPUS_EXT = /\.(?:ya?ml|mjs|cjs|js|ts|sh|bash|py|json)$/;
/** Prose and generated trees describe; they do not read. The lockfile is 1000s of tarball URLs. */
export const NON_CODE = /^(?:audits|docs|docs-src|landing|node_modules|dist)\/|(?:^|\/)package-lock\.json$|\.d\.ts$/;

export const FORBIDDEN = new Set(['OWN_PACKUMENT', 'OWN_DIST_TAG_DOC']);

export const KIND_REASON = Object.freeze({
  OWN_PACKUMENT: 'our own packument: Cloudflare-cached public, max-age=300, so a read-back can be up to 300 s stale',
  OWN_DIST_TAG_DOC: 'our own /<pkg>/<dist-tag> document: cached on repeat (measured HIT, max-age=300)',
  OWN_VERSION_DOC: 'our own version document: immutable once it exists, and a 404 is not negatively cached',
  OWN_TARBALL: 'our own tarball: immutable',
  OWN_REGISTRY_API: 'registry API path for our package (e.g. /-/package/<pkg>/dist-tags): measured DYNAMIC, no cache-control',
  BARE_HOST: 'bare registry host with no package path: configuration (e.g. setup-node registry-url), not a read-back',
  BASE_URL: 'a base-URL string; whatever is appended happens at runtime and is outside a textual scan',
  REGISTRY_API: 'a registry API path that is not a package document (e.g. /-/v1/search)',
  THIRD_PARTY: 'another package: it never reads back a publish of ours',
  RUNTIME_ASSEMBLED: 'the package path is assembled at runtime: uncatchable textually, reported rather than judged',
});

const NAME_CHAR = /[A-Za-z0-9._~-]/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Read one npm name token at the start of `s` (scoped, %-encoded scoped, or plain). */
function readNameToken(s) {
  let i = 0;
  const plain = () => {
    const start = i;
    while (i < s.length && NAME_CHAR.test(s[i])) i++;
    return s.slice(start, i);
  };
  if (s.startsWith('@') || s.toLowerCase().startsWith('%40')) {
    i = s.startsWith('@') ? 1 : 3;
    const scope = plain();
    let sep = '';
    if (s[i] === '/') sep = '/';
    else if (s.slice(i, i + 3).toLowerCase() === '%2f') sep = '%2f';
    if (!scope || !sep) return { name: '', len: i };
    i += sep.length;
    const bare = plain();
    return { name: bare ? `@${scope}/${bare}` : '', len: i };
  }
  const name = plain();
  return { name, len: i };
}

/**
 * Classify the text that FOLLOWS the host in one occurrence. Pure; exported for the self-test.
 * @param {string} after  text immediately after the host name
 * @param {string} own    our package name (from package.json)
 */
export function classifyAfterHost(after, own) {
  if (after[0] !== '/') return 'BARE_HOST';
  const p = after.slice(1);
  if (p === '' || !(NAME_CHAR.test(p[0]) || p[0] === '@' || p[0] === '%' || p[0] === '-' || p[0] === '$' || p[0] === '{')) {
    return 'BASE_URL';
  }
  if (p[0] === '$' || p[0] === '{') return 'RUNTIME_ASSEMBLED';
  if (p.startsWith('-/')) {
    const rest = p.slice(2);
    if (rest.startsWith('package/')) {
      const tok = readNameToken(rest.slice('package/'.length));
      return tok.name && tok.name === own ? 'OWN_REGISTRY_API' : 'REGISTRY_API';
    }
    return 'REGISTRY_API';
  }
  const tok = readNameToken(p);
  if (!tok.name) return 'RUNTIME_ASSEMBLED';
  if (tok.name !== own) return 'THIRD_PARTY';
  const tail = p.slice(tok.len);
  const next = tail[0];
  if (next === undefined || (next !== '/' && !NAME_CHAR.test(next))) return 'OWN_PACKUMENT';
  if (next === '/') {
    const segTail = tail.slice(1);
    if (segTail[0] === '$' || segTail[0] === '{') return 'RUNTIME_ASSEMBLED';
    let j = 0;
    while (j < segTail.length && /[A-Za-z0-9._~+-]/.test(segTail[j])) j++;
    const seg = segTail.slice(0, j);
    if (seg === '') return 'OWN_PACKUMENT'; // trailing slash: still the packument
    if (seg === '-') return 'OWN_TARBALL';
    if (SEMVER.test(seg)) return 'OWN_VERSION_DOC';
    return 'OWN_DIST_TAG_DOC';
  }
  return 'THIRD_PARTY'; // unreachable: a name char would have extended the token
}

const HOST_RE_SRC = HOST.replace(/\./g, '\\.');

/** Every registry occurrence in one file, comments stripped. Pure. */
export function scanText(file, text, own) {
  const code = stripComments(text, file);
  const re = new RegExp(HOST_RE_SRC, 'g');
  const hits = [];
  let m;
  while ((m = re.exec(code)) !== null) {
    const before = code[m.index - 1];
    if (before && /[A-Za-z0-9-]/.test(before)) continue; // e.g. `myregistry.npmjs.org`
    const after = code.slice(m.index + m[0].length, m.index + m[0].length + 400);
    const kind = classifyAfterHost(after, own);
    const line = code.slice(0, m.index).split('\n').length;
    const lineText = text.split('\n')[line - 1] ?? '';
    hits.push({ file, line, kind, snippet: lineText.trim().slice(0, 140) });
  }
  return hits;
}

/** Tracked corpus files. Returns null when git cannot list (INDETERMINATE, never "clean"). */
export function corpusFiles(root = REPO_ROOT) {
  let out;
  try {
    out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
  return out.split('\0').filter((f) => f && CORPUS_EXT.test(f) && !NON_CODE.test(f));
}

/** Parse + validate the data file. Returns {data} or {error}. Two keys, never merged. */
export function parseBaseline(raw) {
  let d;
  try {
    d = JSON.parse(raw);
  } catch (e) {
    return { error: `baseline is not JSON: ${/** @type {Error} */ (e).message}` };
  }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { error: 'baseline is not an object' };
  if (!Array.isArray(d.baseline)) return { error: 'baseline has no "baseline" array' };
  if (!Array.isArray(d.allow)) return { error: 'baseline has no "allow" array (it must be a SEPARATE top-level key)' };
  for (const e of d.baseline) {
    if (!e || typeof e.file !== 'string' || !Number.isInteger(e.count) || e.count < 1 || typeof e.reason !== 'string' || !e.reason.trim()) {
      return { error: `malformed baseline row: ${JSON.stringify(e)} (needs file, integer count ≥ 1, reason)` };
    }
  }
  for (const a of d.allow) if (typeof a !== 'string' || !a) return { error: `malformed allow row: ${JSON.stringify(a)}` };
  if (d.raises !== undefined && !Array.isArray(d.raises)) return { error: '"raises" must be an array when present' };
  return { data: d };
}

/**
 * Judge one corpus. Pure: every input is an argument, so the self-test drives it with fixtures.
 * @param {{files: Array<{file: string, text: string}>|null, own: string|null, baselineRaw: string|null, tracked?: Set<string>}} input
 */
export function judge({ files, own, baselineRaw, tracked }) {
  const lines = [];
  if (typeof own !== 'string' || !own) return { verdict: 'INDETERMINATE', lines: ['package.json has no usable "name"'], hits: [], violations: [] };
  if (baselineRaw === null) return { verdict: 'INDETERMINATE', lines: [`${BASELINE_REL} is missing`], hits: [], violations: [] };
  const parsed = parseBaseline(baselineRaw);
  if (parsed.error) return { verdict: 'INDETERMINATE', lines: [parsed.error], hits: [], violations: [] };
  if (files === null) return { verdict: 'INDETERMINATE', lines: ['could not list tracked files (git ls-files failed)'], hits: [], violations: [] };
  if (files.length === 0) return { verdict: 'INDETERMINATE', lines: ['the corpus is EMPTY — a scan of nothing is not a clean tree'], hits: [], violations: [] };

  const { baseline, allow } = /** @type {{baseline: Array<{file: string, count: number}>, allow: string[]}} */ (parsed.data);
  const allowSet = new Set(allow);
  const hits = files.flatMap(({ file, text }) => scanText(file, text, own));
  const violations = hits.filter((h) => FORBIDDEN.has(h.kind) && !allowSet.has(h.file));
  const perFile = new Map();
  for (const v of violations) perFile.set(v.file, (perFile.get(v.file) ?? 0) + 1);
  const allowed = new Map(baseline.map((b) => [b.file, b.count]));

  let fail = false;
  const trackedSet = tracked ?? new Set(files.map((f) => f.file));
  for (const a of allow) {
    if (!trackedSet.has(a)) {
      fail = true;
      lines.push(`FAIL  stale allow row: ${a} is not a tracked file — delete the row`);
    }
  }
  for (const [file, n] of perFile) {
    const cap = allowed.get(file) ?? 0;
    if (n > cap) {
      fail = true;
      for (const v of violations.filter((x) => x.file === file)) {
        lines.push(`FAIL  ${v.file}:${v.line}  ${v.kind} — ${KIND_REASON[v.kind]}`);
        lines.push(`        ${v.snippet}`);
      }
      lines.push(`      ${file}: ${n} forbidden read(s) against a baseline of ${cap}. Read the uncached endpoints through scripts/lib/npm-registry-read.mjs instead.`);
    }
  }
  for (const [file, cap] of allowed) {
    const n = perFile.get(file) ?? 0;
    if (n < cap) lines.push(`LOWER ${file}: baseline ${cap}, now ${n} — run --write-baseline to tighten`);
  }
  return { verdict: fail ? 'FAIL' : 'PASS', lines, hits, violations, corpus: files.length };
}

/** Lower-only re-baseline. Never raises a row; drops rows that reach zero. Pure. */
export function lowerOnly(data, perFile) {
  const next = [];
  for (const row of data.baseline) {
    const n = perFile.get(row.file) ?? 0;
    if (n <= 0) continue;
    next.push({ ...row, count: Math.min(row.count, n) });
  }
  return { ...data, baseline: next };
}

function readOwnName(root) {
  try {
    const name = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).name;
    return typeof name === 'string' && name ? name : null;
  } catch {
    return null;
  }
}

export function evaluate(root = REPO_ROOT) {
  const own = readOwnName(root);
  const bPath = path.join(root, BASELINE_REL);
  const baselineRaw = existsSync(bPath) ? readFileSync(bPath, 'utf8') : null;
  const list = corpusFiles(root);
  const files = list === null ? null : list.map((file) => {
    let text = '';
    try { text = readFileSync(path.join(root, file), 'utf8'); } catch { /* deleted in the working tree */ }
    return { file, text };
  });
  return { own, ...judge({ files, own, baselineRaw }) };
}

function printReport(r) {
  console.log('─── packument read-back ratchet (our own package only) ───');
  console.log(`  package: ${r.own ?? '<unreadable>'} · corpus: ${r.corpus ?? 0} tracked file(s) · registry occurrences: ${r.hits.length}`);
  const order = ['OWN_PACKUMENT', 'OWN_DIST_TAG_DOC', 'OWN_VERSION_DOC', 'OWN_TARBALL', 'OWN_REGISTRY_API', 'BARE_HOST', 'BASE_URL', 'REGISTRY_API', 'THIRD_PARTY', 'RUNTIME_ASSEMBLED'];
  for (const kind of order) {
    const ks = r.hits.filter((h) => h.kind === kind);
    if (!ks.length) continue;
    const label = FORBIDDEN.has(kind) ? 'FORBIDDEN' : kind === 'RUNTIME_ASSEMBLED' ? 'REPORT' : 'exempt';
    console.log(`  ${label.padEnd(9)} ${kind} (${ks.length}) — ${KIND_REASON[kind]}`);
    for (const h of ks) console.log(`              ${h.file}:${h.line}`);
  }
  for (const l of r.lines) console.log(`  ${l}`);
}

// ─── self-test ──────────────────────────────────────────────────────────────────────────────
export function selfTest() {
  const results = [];
  const t = (name, fn) => {
    let ok = false;
    let detail = '';
    try {
      ok = fn() === true;
    } catch (e) {
      ok = false;
      detail = ` (threw: ${/** @type {Error} */ (e).message})`;
    }
    results.push({ name, ok, detail });
  };
  // The host is ASSEMBLED, never written as one literal, so this file's own fixtures can never
  // read as occurrences when the real scan runs over scripts/.
  const H = ['registry', 'npmjs', 'org'].join('.');
  const OWN = 'selftest-own-pkg';
  const EMPTY = JSON.stringify({ baseline: [], allow: ['lib/reader.mjs'] });
  const run = (files, baselineRaw = EMPTY, own = OWN) =>
    judge({ files, own, baselineRaw, tracked: new Set([...files.map((f) => f.file), 'lib/reader.mjs']) });
  const one = (file, text, baselineRaw) => run([{ file, text }], baselineRaw);
  const kindOf = (after) => classifyAfterHost(after, OWN);

  // forbidden, must FAIL
  t('planted packument read in a workflow → FAIL', () =>
    one('wf.yml', `run: curl -sS "https://${H}/${OWN}" | jq -r .x`).verdict === 'FAIL');
  t('packument with a query string is still the packument → FAIL', () =>
    one('a.mjs', `fetch('https://${H}/${OWN}?x=1')`).verdict === 'FAIL');
  t('packument with a trailing slash → FAIL', () => one('a.sh', `curl "https://${H}/${OWN}/"`).verdict === 'FAIL');
  t('/<own>/latest dist-tag document → FAIL', () => one('a.ts', `const u = 'https://${H}/${OWN}/latest';`).verdict === 'FAIL');
  t('scoped own name, %-encoded → OWN_PACKUMENT', () =>
    classifyAfterHost(`/%40sc%2Fpkg"`, '@sc/pkg') === 'OWN_PACKUMENT');
  t('scoped own name, raw slash, /next → OWN_DIST_TAG_DOC', () =>
    classifyAfterHost(`/@sc/pkg/next'`, '@sc/pkg') === 'OWN_DIST_TAG_DOC');

  // allowed / exempt, must PASS and classify correctly
  t('bare host (setup-node registry-url) → BARE_HOST, PASS', () =>
    kindOf(`'`) === 'BARE_HOST' && one('wf.yml', `          registry-url: 'https://${H}'`).verdict === 'PASS');
  t('base URL + runtime concatenation → BASE_URL, PASS', () =>
    kindOf(`/" + quote(name)`) === 'BASE_URL' && one('m.py', `u = "https://${H}/" + quote(name)`).verdict === 'PASS');
  t('own dist-tags endpoint → OWN_REGISTRY_API, PASS', () =>
    kindOf(`/-/package/${OWN}/dist-tags"`) === 'OWN_REGISTRY_API' &&
    one('a.mjs', `fetch("https://${H}/-/package/${OWN}/dist-tags")`).verdict === 'PASS');
  t('search API → REGISTRY_API', () => kindOf(`/-/v1/search?text=x`) === 'REGISTRY_API');
  t('own version document → OWN_VERSION_DOC, PASS', () =>
    kindOf(`/${OWN}/1.31.0?cb=1`) === 'OWN_VERSION_DOC' && one('a.mjs', `'https://${H}/${OWN}/1.31.0'`).verdict === 'PASS');
  t('own tarball → OWN_TARBALL', () => kindOf(`/${OWN}/-/${OWN}-1.0.0.tgz`) === 'OWN_TARBALL');
  t('third-party package → THIRD_PARTY, PASS', () =>
    kindOf(`/mcp-remote"`) === 'THIRD_PARTY' && one('e.json', `{"source": "https://${H}/mcp-remote"}`).verdict === 'PASS');
  t('third-party scoped %-encoded → THIRD_PARTY', () => kindOf(`/%40smithery%2Fcli"`) === 'THIRD_PARTY');
  t('a LONGER name sharing our prefix is not ours → THIRD_PARTY', () => kindOf(`/${OWN}-extra"`) === 'THIRD_PARTY');
  t('runtime-assembled package path → RUNTIME_ASSEMBLED, PASS', () =>
    kindOf('/${pkg}`') === 'RUNTIME_ASSEMBLED' && one('a.mjs', 'curlHead(`https://' + H + '/${pkg}`)').verdict === 'PASS');
  t('runtime-assembled suffix after our name → RUNTIME_ASSEMBLED', () => kindOf(`/${OWN}/` + '${v}') === 'RUNTIME_ASSEMBLED');
  t('a host-name SUFFIX match is not the registry (myregistry.…)', () =>
    one('a.mjs', `'https://my${H}/${OWN}'`).hits.length === 0);

  // a mention is not a read
  t('YAML comment naming the packument is ignored', () => one('wf.yml', `# old step read https://${H}/${OWN}\nrun: true`).verdict === 'PASS');
  t('JS line comment naming the packument is ignored', () => one('a.mjs', `// https://${H}/${OWN}\nconst x = 1;`).verdict === 'PASS');

  // the data file
  t('a violation in an ALLOWED file → PASS', () => one('lib/reader.mjs', `'https://${H}/${OWN}'`).verdict === 'PASS');
  const B1 = JSON.stringify({ baseline: [{ file: 'a.mjs', count: 1, reason: 'r' }], allow: ['lib/reader.mjs'] });
  t('baseline row tolerates exactly its count → PASS', () => one('a.mjs', `'https://${H}/${OWN}'`, B1).verdict === 'PASS');
  t('one over the baseline row → FAIL', () => one('a.mjs', `'https://${H}/${OWN}'\n'https://${H}/${OWN}/latest'`, B1).verdict === 'FAIL');
  t('a stale allow row (untracked file) → FAIL', () =>
    judge({ files: [{ file: 'x.mjs', text: '' }], own: OWN, baselineRaw: EMPTY, tracked: new Set(['x.mjs']) }).verdict === 'FAIL');
  t('allow merged INTO baseline (one key) → INDETERMINATE', () =>
    one('x.mjs', '', JSON.stringify({ baseline: ['lib/reader.mjs'] })).verdict === 'INDETERMINATE');
  t('baseline row without a reason → INDETERMINATE', () =>
    one('x.mjs', '', JSON.stringify({ baseline: [{ file: 'a', count: 1 }], allow: [] })).verdict === 'INDETERMINATE');
  t('unparseable baseline → INDETERMINATE', () => one('x.mjs', '', '{not json').verdict === 'INDETERMINATE');
  t('missing baseline → INDETERMINATE', () => one('x.mjs', '', null).verdict === 'INDETERMINATE');
  t('no package name → INDETERMINATE', () => run([{ file: 'x.mjs', text: '' }], EMPTY, '').verdict === 'INDETERMINATE');
  t('git listing failed → INDETERMINATE', () => judge({ files: null, own: OWN, baselineRaw: EMPTY }).verdict === 'INDETERMINATE');
  t('EMPTY corpus → INDETERMINATE (vacuity)', () => judge({ files: [], own: OWN, baselineRaw: EMPTY }).verdict === 'INDETERMINATE');

  // lower-only
  const data = { baseline: [{ file: 'a', count: 3, reason: 'r' }, { file: 'b', count: 1, reason: 'r' }], allow: [] };
  t('lowerOnly never RAISES a row', () => lowerOnly(data, new Map([['a', 9], ['b', 1]])).baseline.find((r) => r.file === 'a')?.count === 3);
  t('lowerOnly lowers a row and drops a zeroed one', () => {
    const n = lowerOnly(data, new Map([['a', 2]]));
    return n.baseline.length === 1 && n.baseline[0].count === 2;
  });

  // contract
  t('token → exit mapping is 0 / 1 / 3', () => EXIT.PASS === 0 && EXIT.FAIL === 1 && EXIT.INDETERMINATE === 3);
  t('the host is derived from the reader module', () => HOST === H);

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail}`);
  // Vacuity: we BUILT this corpus, so an empty one is a defect in the test, never a pass.
  if (results.length < 20) {
    console.log(`  FAIL  vacuity: only ${results.length} cases ran`);
    console.log('PACKUMENT_READ_SELFTEST_VERDICT=FAIL');
    return 1;
  }
  console.log(`self-test: ${results.length - failed.length}/${results.length} passed`);
  console.log(`PACKUMENT_READ_SELFTEST_VERDICT=${failed.length === 0 ? 'PASS' : 'FAIL'}`);
  return failed.length === 0 ? 0 : 1;
}

export function flagValue(argv, flag) {
  const i = argv.indexOf(flag);
  if (i === -1) return null;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : null;
}

function main(argv) {
  if (argv.includes('--self-test')) {
    process.exitCode = selfTest();
    return;
  }
  const r = evaluate();
  if (argv.includes('--write-baseline') || argv.includes('--allow-raise')) {
    const bPath = path.join(REPO_ROOT, BASELINE_REL);
    const parsed = parseBaseline(existsSync(bPath) ? readFileSync(bPath, 'utf8') : '');
    if (parsed.error || !r.own) {
      console.log(`  cannot rewrite the baseline: ${parsed.error ?? 'package.json has no name'}`);
      console.log(`${TOKEN}=INDETERMINATE`);
      process.exitCode = EXIT.INDETERMINATE;
      return;
    }
    const perFile = new Map();
    for (const v of r.violations) perFile.set(v.file, (perFile.get(v.file) ?? 0) + 1);
    let next = lowerOnly(parsed.data, perFile);
    const target = flagValue(argv, '--allow-raise');
    if (argv.includes('--allow-raise')) {
      const reason = flagValue(argv, '--reason');
      if (!target || !reason) {
        console.log('  --allow-raise needs <file> and --reason "<why>"');
        console.log(`${TOKEN}=INDETERMINATE`);
        process.exitCode = EXIT.INDETERMINATE;
        return;
      }
      const count = perFile.get(target) ?? 0;
      if (count === 0) {
        console.log(`  ${target} has no forbidden read to baseline`);
        console.log(`${TOKEN}=INDETERMINATE`);
        process.exitCode = EXIT.INDETERMINATE;
        return;
      }
      const today = new Date().toISOString().slice(0, 10);
      next = {
        ...next,
        baseline: [...next.baseline.filter((b) => b.file !== target), { file: target, count, reason, date: today }],
        raises: [...(next.raises ?? []), { file: target, count, reason, date: today }],
      };
    }
    writeFileSync(bPath, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`  baseline rewritten (${next.baseline.length} row(s))`);
  }
  const after = evaluate();
  printReport(after);
  console.log(`${TOKEN}=${after.verdict}`);
  process.exitCode = EXIT[after.verdict];
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2));
}
