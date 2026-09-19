#!/usr/bin/env node
/**
 * OPS-EDITORIAL-PRIMITIVE-RESOLUTION-GATE-W1 CH2 — retire "a public surface names a primitive
 * nobody checked exists".
 *
 * On 2026-09-18 the autopub slot P16/full-3-tool-pipeline published to dev.to telling readers to
 * run `npx -y @algovault/crypto-quant-signal-mcp@latest` — a scope that 404s — and to install
 * crypto-quant-risk-mcp / crypto-quant-backtest-mcp for get_position_size / run_backtest. Both are
 * 0.1.0 "Coming soon" stubs from 2026-04-04 with `bin: null`, and neither tool is on tools/list.
 *
 * Nothing in the org could express either predicate. `check-forbidden-phrases.mjs` bans retired
 * TEXT; `ops/figure-registry.json` governs retired FIGURES. Neither can say "this package must
 * resolve as a CLI" or "this tool must be live".
 *
 * ── WHY THIS IS A SECOND npm-RESOLUTION PREDICATE, AND THAT IS CORRECT ───────────────────────
 * `scripts/check-partner-install-coords.mjs` already resolves npm coordinates
 * (PARTNER_INSTALL_VERDICT, 0/1/3). It answers a DIFFERENT question over a DIFFERENT corpus:
 * "does a THIRD-PARTY coordinate in our tutorials resolve", scanning src/lib/integrations-data
 * and docs/integrations, with a published-versions-exist predicate. This one answers "is one of
 * OUR OWN primitives nameable in public", over a declared registry, and it has an `mcp_tool` kind
 * that the incumbent has no concept of. The two share the `bin` LEG (added to probeNpm() by this
 * wave's commit 2) and nothing else. Extending the incumbent instead was rejected: its corpus
 * cannot reach a registry, and a tool row has no install coordinate to extract.
 *
 * ── VERDICT CONTRACT ────────────────────────────────────────────────────────────────────────
 * Exactly ONE terminal line: PRIMITIVE_RESOLUTION_VERDICT=PASS|FAIL|INDETERMINATE.
 * Exit 0=PASS / 1=FAIL / 3=INDETERMINATE. Callers gate on the TOKEN, never the bare code — a
 * shell that tests for "not 1" reads INDETERMINATE as a pass, which is the fail-open this file
 * exists to prevent. 3 is the token-law default for a NEW gate; it deliberately does not match
 * check_test_baseline.sh's 2, and the two must NOT be "aligned".
 *
 * ── 404 IS A MEASUREMENT. A TRANSPORT ERROR IS NOT. ─────────────────────────────────────────
 * A 404 says the package is not published — that is evidence, and it FAILs. `curl` exit 6/7/28,
 * an npm 5xx, or an unparseable tools/list says we learned nothing — that is INDETERMINATE.
 * Measured 2026-09-19: a missing scope answers 404, an unresolvable host answers http_code 000
 * with curl exit 6. They are distinguishable, so the gate distinguishes them.
 *
 * ── VACUITY GUARD SITS WHERE THE CORPUS IS CONSTRUCTED ──────────────────────────────────────
 * Zero rows is vacuity only because we were supposed to LOAD rows. An unreadable or empty
 * registry is INDETERMINATE at load time, never a PASS over an empty set.
 *
 * ── NEVER AGGREGATE OVER A LIMIT-CAPPED COLLECTION ──────────────────────────────────────────
 * tools/list is paginated in the MCP spec. This reader follows `nextCursor` to exhaustion and
 * refuses (INDETERMINATE) if it cannot, rather than judging `planned` rows against a first page.
 *
 * ── ONE DERIVATION OF THE tools/list PARSE ──────────────────────────────────────────────────
 * The SSE-vs-bare framing parse lives in scripts/lib/mcp-tools-list.mjs, extracted by
 * OPS-CURSOR-PLUGIN-MANIFESTS-W1 for exactly this "a second gate needs it" reason. This is its
 * third consumer. Do not re-implement it here: two readers of one wire format come to disagree
 * about it, and the divergence is invisible until the one string that matters.
 *
 *   node scripts/check-primitive-resolution.mjs              # gate
 *   node scripts/check-primitive-resolution.mjs --self-test  # two-way proof, no network
 *   node scripts/check-primitive-resolution.mjs --show-config # resolved config, no network
 */
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseToolNames } from './lib/mcp-tools-list.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = join(ROOT, 'ops', 'primitive-registry.json');

const NPM_BASE = process.env.PRIMRES_NPM_BASE || 'https://registry.npmjs.org';
const MCP_ORIGIN = process.env.PRIMRES_MCP_ORIGIN || 'https://api.algovault.com/mcp';
const ABBREVIATED = 'application/vnd.npm.install-v1+json';
const TOOLS_LIST_PAGE_CAP = 50;

/**
 * TOTAL wall-clock budget for every network leg in one run, not a per-call timeout.
 *
 * A REFUSED connection fails in milliseconds; a BLACKHOLED route HANGS. This gate is the repo's
 * first network-dependent pre-commit block, shared by 146 checkouts, so an unbounded hang is a
 * fleet-wide stall — and a per-call `--max-time` does not bound it, because one run makes up to
 * 4 npm fetches plus 3 + N tools/list POSTs. The budget is the whole phase: once it is spent,
 * every remaining leg reports `unknown` and the run is INDETERMINATE.
 *
 * Measured healthy latency is 1.3–2.1 s, so 5 s leaves headroom without letting a commit hang.
 */
const NETWORK_BUDGET_MS = Number(process.env.PRIMRES_BUDGET_MS || 5000);

/** Wall-clock deadline for one run's network phase. `remaining()` is what each curl gets. */
function makeBudget(ms = NETWORK_BUDGET_MS) {
  const started = Date.now();
  return {
    remainingMs: () => Math.max(0, ms - (Date.now() - started)),
    spent: () => Date.now() - started,
    exhausted() { return this.remainingMs() <= 0; },
    /** curl's --max-time takes SECONDS and floors to 0, which means "no limit". Never emit 0. */
    curlMaxTime() { return Math.max(1, Math.ceil(this.remainingMs() / 1000)); },
  };
}

const VERDICT = (tok, code) => {
  console.log(`PRIMITIVE_RESOLUTION_VERDICT=${tok}`);
  process.exit(code);
};

/* ── registry load — the construction site, so the vacuity guard lives here ───────────────── */

export function loadRegistry(path = REGISTRY) {
  if (!existsSync(path)) return { error: `registry not found: ${path}` };
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return { error: `registry is not valid JSON: ${String(e.message).slice(0, 160)}` };
  }
  const rows = doc?.primitives;
  if (!Array.isArray(rows)) return { error: 'registry has no `primitives` array' };
  if (rows.length === 0) return { error: 'registry has ZERO rows — vacuity, not a clean pass' };
  for (const [i, r] of rows.entries()) {
    for (const f of ['id', 'kind', 'name', 'invocation', 'status', 'public_nameable']) {
      if (r?.[f] === undefined || r?.[f] === null) return { error: `row ${i} (${r?.id ?? '?'}) is missing \`${f}\`` };
    }
    if (!['npm_package', 'mcp_tool', 'http_endpoint'].includes(r.kind)) return { error: `row ${r.id}: unknown kind \`${r.kind}\`` };
    if (!['cli', 'library', 'n_a'].includes(r.invocation)) return { error: `row ${r.id}: unknown invocation \`${r.invocation}\`` };
    if (!['live', 'planned', 'retired'].includes(r.status)) return { error: `row ${r.id}: unknown status \`${r.status}\`` };
    if ((r.kind === 'mcp_tool' || r.kind === 'http_endpoint') && r.invocation !== 'n_a') {
      return { error: `row ${r.id}: ${r.kind} must take invocation n_a, has \`${r.invocation}\`` };
    }
  }
  const ids = rows.map((r) => r.id);
  const dupe = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dupe) return { error: `duplicate row id \`${dupe}\`` };
  return { rows };
}

/* ── npm predicate ───────────────────────────────────────────────────────────────────────── */

/** `bin` is a CLI property. Non-null, an object, and non-empty. */
export function hasUsableBin(bin) {
  if (bin === null || bin === undefined) return false;
  if (typeof bin === 'string') return bin.trim().length > 0;
  if (typeof bin === 'object') return Object.keys(bin).length > 0;
  return false;
}

/** (state, detail). state ∈ resolved | absent | unknown — `unknown` never decides. */
export function classifyNpm(row, { httpCode, body, transportFailed }) {
  if (transportFailed) return { state: 'unknown', detail: 'transport failure — learned nothing' };
  if (httpCode === 404) return { state: 'absent', detail: 'npm 404 — not published' };
  if (httpCode !== 200) return { state: 'unknown', detail: `npm http ${httpCode}` };
  let doc;
  try {
    doc = JSON.parse(body);
  } catch {
    return { state: 'unknown', detail: 'packument is not valid JSON' };
  }
  const latest = doc?.['dist-tags']?.latest;
  if (!latest) return { state: 'unknown', detail: 'packument carries no dist-tags.latest' };
  if (row.invocation === 'library') return { state: 'resolved', detail: `published, latest ${latest} (library: bin not asserted)` };
  const bin = doc?.versions?.[latest]?.bin ?? null;
  return hasUsableBin(bin)
    ? { state: 'resolved', detail: `latest ${latest}, bin ${JSON.stringify(bin)}` }
    : { state: 'absent', detail: `latest ${latest} has no usable bin — published, but not CLI-invocable` };
}

function fetchPackument(name, budget) {
  if (budget.exhausted()) return { httpCode: 0, body: '', transportFailed: true, err: 'network budget exhausted' };
  const url = `${NPM_BASE}/${name.startsWith('@') ? encodeURIComponent(name) : name}`;
  try {
    const raw = execFileSync('curl', ['-sS', '--max-time', String(budget.curlMaxTime()), '-H', `Accept: ${ABBREVIATED}`,
      '-w', '\\n__HTTP__%{http_code}', url], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const m = raw.match(/\n__HTTP__(\d+)\s*$/);
    return { httpCode: m ? parseInt(m[1], 10) : 0, body: m ? raw.slice(0, m.index) : raw, transportFailed: !m || m[1] === '000' };
  } catch (e) {
    return { httpCode: 0, body: '', transportFailed: true, err: String(e.message).slice(0, 160) };
  }
}

/* ── tools/list — exhausted, never a capped first page ───────────────────────────────────── */

function postMcp(payload, budget) {
  if (budget.exhausted()) throw new Error('network budget exhausted');
  return execFileSync('curl', ['-sS', '--max-time', String(budget.curlMaxTime()), '-X', 'POST', MCP_ORIGIN,
    '-H', 'Content-Type: application/json', '-H', 'Accept: application/json, text/event-stream',
    '-d', JSON.stringify(payload)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Cursor out of an SSE-framed or bare body; undefined when the page is terminal. */
export function parseNextCursor(body) {
  const raw = String(body ?? '');
  const json = /^data: /m.test(raw)
    ? (raw.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6))[0] ?? '')
    : raw;
  try {
    return JSON.parse(json)?.result?.nextCursor;
  } catch {
    return undefined;
  }
}

/** All live tool names, or null when anything could not be read. */
export function readLiveTools(budget = makeBudget()) {
  try {
    postMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'primitive-resolution-gate', version: '1' } } }, budget);
    postMcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, budget);
    const names = [];
    let cursor;
    for (let page = 0; page < TOOLS_LIST_PAGE_CAP; page += 1) {
      const body = postMcp({ jsonrpc: '2.0', id: 2 + page, method: 'tools/list', params: cursor ? { cursor } : {} }, budget);
      const got = parseToolNames(body);
      if (got === null) return null;
      names.push(...got);
      cursor = parseNextCursor(body);
      if (!cursor) return names;
    }
    // Hit the cap with a cursor still outstanding: we have a TRUNCATED list, and judging a
    // `planned` row against a truncated list would call a live tool absent.
    return null;
  } catch {
    return null;
  }
}

/* ── the join: measured state vs declared status ─────────────────────────────────────────── */

/** (verdict, problems[], notes[]) from rows + a resolver. Pure, so the self-test drives it. */
export function evaluate(rows, resolve) {
  const problems = [];
  const notes = [];
  let indeterminate = false;
  for (const row of rows) {
    const { state, detail } = resolve(row);
    if (state === 'unknown') {
      indeterminate = true;
      notes.push(`INDETERMINATE ${row.id} — ${detail}`);
      continue;
    }
    const resolves = state === 'resolved';
    if (row.status === 'live' && !resolves) problems.push(`${row.id}: declared live but does not resolve — ${detail}`);
    else if (row.status !== 'live' && resolves) problems.push(`${row.id}: declared ${row.status} but RESOLVES — ${detail}; a stale registry is how this class returns`);
    else notes.push(`ok ${row.id} (${row.status}) — ${detail}`);
  }
  if (problems.length) return { verdict: 'FAIL', problems, notes };
  if (indeterminate) return { verdict: 'INDETERMINATE', problems, notes };
  return { verdict: 'PASS', problems, notes };
}

/* ── live run ────────────────────────────────────────────────────────────────────────────── */

function run() {
  const loaded = loadRegistry();
  if (loaded.error) {
    console.error(`primitive-resolution: ${loaded.error}`);
    VERDICT('INDETERMINATE', 3);
  }
  const { rows } = loaded;

  const budget = makeBudget();
  const needsTools = rows.some((r) => r.kind === 'mcp_tool');
  const liveTools = needsTools ? readLiveTools(budget) : [];
  if (needsTools && liveTools === null) {
    console.error(`primitive-resolution: tools/list unreachable or unexhausted after ${budget.spent()}ms — verified nothing`);
    VERDICT('INDETERMINATE', 3);
  }

  const npmCache = new Map();
  const resolve = (row) => {
    if (row.kind === 'mcp_tool') {
      return liveTools.includes(row.name)
        ? { state: 'resolved', detail: `present on tools/list (${liveTools.length} tools)` }
        : { state: 'absent', detail: `absent from tools/list (${liveTools.length} tools)` };
    }
    if (row.kind === 'npm_package') {
      if (!npmCache.has(row.name)) npmCache.set(row.name, fetchPackument(row.name, budget));
      return classifyNpm(row, npmCache.get(row.name));
    }
    return { state: 'unknown', detail: `kind ${row.kind} has no predicate yet` };
  };

  const { verdict, problems, notes } = evaluate(rows, resolve);
  // Positive per-row output: a row silently skipped by a load error must not look like a row
  // that passed. Absence-of-problem is not evidence.
  for (const n of notes) console.log(`  ${n}`);
  for (const p of problems) console.error(`  FAIL ${p}`);
  console.log(`primitive-resolution: ${rows.length} rows, ${problems.length} problem(s), network ${budget.spent()}ms of ${NETWORK_BUDGET_MS}ms budget`);
  VERDICT(verdict, verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 1 : 3);
}

/* ── self-test — two-way, hermetic, and it asserts the token→exit mapping ─────────────────── */

const SCENARIOS = [
  { name: 'all rows agree with reality', rows: [{ id: 'a', kind: 'npm_package', name: 'a', invocation: 'cli', status: 'live', public_nameable: true }], state: 'resolved', want: 'PASS', code: 0 },
  { name: 'live row that does not resolve', rows: [{ id: 'a', kind: 'npm_package', name: 'a', invocation: 'cli', status: 'live', public_nameable: true }], state: 'absent', want: 'FAIL', code: 1 },
  { name: 'planned row that now resolves (stale registry)', rows: [{ id: 'a', kind: 'npm_package', name: 'a', invocation: 'cli', status: 'planned', public_nameable: false }], state: 'resolved', want: 'FAIL', code: 1 },
  { name: 'planned row still absent', rows: [{ id: 'a', kind: 'npm_package', name: 'a', invocation: 'cli', status: 'planned', public_nameable: false }], state: 'absent', want: 'PASS', code: 0 },
  { name: 'retired row that resolves again', rows: [{ id: 'a', kind: 'npm_package', name: 'a', invocation: 'cli', status: 'retired', public_nameable: false }], state: 'resolved', want: 'FAIL', code: 1 },
  { name: 'retired row stays gone', rows: [{ id: 'a', kind: 'npm_package', name: 'a', invocation: 'cli', status: 'retired', public_nameable: false }], state: 'absent', want: 'PASS', code: 0 },
  { name: 'transport failure never decides', rows: [{ id: 'a', kind: 'npm_package', name: 'a', invocation: 'cli', status: 'live', public_nameable: true }], state: 'unknown', want: 'INDETERMINATE', code: 3 },
  { name: 'a FAIL outranks an INDETERMINATE', rows: [{ id: 'a', kind: 'npm_package', name: 'a', invocation: 'cli', status: 'live', public_nameable: true }, { id: 'b', kind: 'npm_package', name: 'b', invocation: 'cli', status: 'live', public_nameable: true }], state: (r) => (r.id === 'a' ? 'absent' : 'unknown'), want: 'FAIL', code: 1 },
];

/** Token → exit code. Asserted by the self-test, because re-coding it silently is the known hole. */
export function exitCodeFor(verdict) {
  return verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 1 : 3;
}

/**
 * Two-way proof. Returns TRUE when every case holds — it must NOT exit, because
 * tests/unit/primitive-resolution.test.ts imports and calls it, and a process.exit here kills the
 * vitest worker. The CLI wrapper below owns the token and the exit code. Same split as the
 * sibling scripts/check-partner-install-coords.mjs.
 */
export function selfTest() {
  let failed = 0;
  const check = (label, got, want) => {
    if (got === want) return;
    failed += 1;
    console.log(`  SELF-TEST case FAILED: ${label} — got ${got}, want ${want}`);
  };

  for (const s of SCENARIOS) {
    const state = typeof s.state === 'function' ? s.state : () => s.state;
    const { verdict } = evaluate(s.rows, (r) => ({ state: state(r), detail: 'fixture' }));
    check(s.name, verdict, s.want);
    check(`${s.name} → exit code`, exitCodeFor(verdict), s.code);
  }

  // The vacuity guard, at the CONSTRUCTION site. A registry with zero rows must never PASS.
  //
  // The EMPTY-ARRAY case is asserted from a real file on disk, not from a missing path. Proven
  // necessary 2026-09-19: deleting the `rows.length === 0` line left every OTHER assertion here
  // green while the live gate printed `0 rows, 0 problem(s)` and PRIMITIVE_RESOLUTION_VERDICT=PASS.
  // A missing-file check does not cover it — they are different branches, and only one of them is
  // the shape a bad `--sync` or a truncated write actually produces.
  const scratch = mkdtempSync(join(tmpdir(), 'primres-selftest-'));
  try {
    const emptyPath = join(scratch, 'empty.json');
    writeFileSync(emptyPath, JSON.stringify({ schema_version: 1, primitives: [] }));
    check('EMPTY-array registry refuses to load', loadRegistry(emptyPath).error !== undefined, true);
    const badRow = join(scratch, 'badrow.json');
    writeFileSync(badRow, JSON.stringify({ schema_version: 1, primitives: [{ id: 'x', kind: 'npm_package', name: 'x', status: 'live', public_nameable: true }] }));
    check('row missing `invocation` refuses to load', loadRegistry(badRow).error !== undefined, true);
    const nullInv = join(scratch, 'nullinv.json');
    writeFileSync(nullInv, JSON.stringify({ schema_version: 1, primitives: [{ id: 'x', kind: 'npm_package', name: 'x', invocation: null, status: 'live', public_nameable: true }] }));
    check('row with `invocation: null` refuses to load', loadRegistry(nullInv).error !== undefined, true);
    const toolCli = join(scratch, 'toolcli.json');
    writeFileSync(toolCli, JSON.stringify({ schema_version: 1, primitives: [{ id: 'x', kind: 'mcp_tool', name: 'x', invocation: 'cli', status: 'live', public_nameable: true }] }));
    check('mcp_tool with a non-n_a invocation refuses to load', loadRegistry(toolCli).error !== undefined, true);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  check('the real registry loads', loadRegistry(join(ROOT, 'ops', 'primitive-registry.json')).error, undefined);

  // The bin predicate, in both directions — this is the leg the whole wave turns on.
  check('bin null is not usable', hasUsableBin(null), false);
  check('bin {} is not usable', hasUsableBin({}), false);
  check('bin absent is not usable', hasUsableBin(undefined), false);
  check('bin {"x":"y"} is usable', hasUsableBin({ x: 'y' }), true);
  check('bin "x" is usable', hasUsableBin('x'), true);

  // A library row must NOT be judged on bin — the false-DRIFT trap. @modelcontextprotocol/sdk,
  // zod and express are all has_bin=false and all correct (measured 2026-09-19).
  const libRow = { id: 'l', kind: 'npm_package', name: 'l', invocation: 'library', status: 'live', public_nameable: true };
  const cliRow = { ...libRow, id: 'c', invocation: 'cli' };
  const noBin = { httpCode: 200, body: JSON.stringify({ 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {} } }) };
  check('library + no bin → resolved', classifyNpm(libRow, noBin).state, 'resolved');
  check('cli + no bin → absent', classifyNpm(cliRow, noBin).state, 'absent');

  // 404 is a measurement; a transport error is not.
  check('404 → absent', classifyNpm(cliRow, { httpCode: 404, body: '' }).state, 'absent');
  check('transport → unknown', classifyNpm(cliRow, { httpCode: 0, body: '', transportFailed: true }).state, 'unknown');
  check('npm 503 → unknown', classifyNpm(cliRow, { httpCode: 503, body: '' }).state, 'unknown');

  // Pagination: a terminal page has no cursor, a non-terminal page does.
  check('nextCursor read from SSE frame', parseNextCursor('event: message\ndata: {"result":{"tools":[],"nextCursor":"c1"}}\n'), 'c1');
  check('terminal page has no cursor', parseNextCursor('{"result":{"tools":[]}}'), undefined);

  console.log(`SELF-TEST: ${failed === 0 ? 'PASS' : `FAIL (${failed})`}`);
  return failed === 0;
}

const argv = process.argv.slice(2);
if (argv.includes('--show-config')) {
  console.log(`REGISTRY=${REGISTRY}`);
  console.log(`NPM_BASE=${NPM_BASE}`);
  console.log(`MCP_ORIGIN=${MCP_ORIGIN}`);
  console.log(`TOOLS_LIST_PAGE_CAP=${TOOLS_LIST_PAGE_CAP}`);
  console.log(`NETWORK_BUDGET_MS=${NETWORK_BUDGET_MS}`);
  process.exit(0);
} else if (argv.includes('--self-test')) {
  const ok = selfTest();
  VERDICT(ok ? 'PASS' : 'FAIL', ok ? 0 : 1);
} else if (process.argv[1] && process.argv[1].endsWith('check-primitive-resolution.mjs')) {
  run();
}
