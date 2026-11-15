#!/usr/bin/env node
/**
 * sr-zones-smoke.mjs — SR-ZONES-W1 AC2.4. A live smoke of get_sr_zones over MCP (streamable HTTP), reused at release.
 *
 *   node scripts/sr-zones-smoke.mjs --prod                 # https://api.algovault.com/mcp, the only target
 *   node scripts/sr-zones-smoke.mjs --prod --young CT      # the young listing to probe (default CT, 1d)
 *   node scripts/sr-zones-smoke.mjs --self-test            # the checks below over built-in bodies; no key, no network
 *
 * Checks, in order:
 *   1. tools/list lists get_sr_zones;
 *   2. BTC ["1d","4h"] returns 2 results, at most 3 zones a side, every §0 field;
 *   3. ETH 1h is served;
 *   4. the young listing is served (a result carrying its flags), not refused;
 *   5. the facts lint passes on every string of every response.
 *
 * Right after a deploy the cache is cold. A timeframe can then come back unserved with the server's load-timeout reason
 * (R8: its full read goes on in the background and caches the window). Checks 2-4 treat that answer as a retry (R9 #3):
 * they wait RETRY_WAIT_MS and call once more. A timeframe still loading after that is could-not-verify (INDETERMINATE),
 * never a FAIL; whatever was served is still checked, and any other unserved reason still FAILs.
 *
 * The requested coin symbol is the caller's own input echoed back (in `coin` and in the summary), not our
 * wording, so it is masked before the lint: PREDICTUSDT is a real Binance perp, and its ticker alone matches
 * `predict\w*`. Every other character of every string is linted.
 *
 * Auth: the internal key from ~/.config/algovault/internal.env (ALGOVAULT_INTERNAL_BYPASS_KEY), sent as
 * X-AlgoVault-Internal-Key. The key is NEVER printed: no header, request or key-bearing value reaches stdout/stderr.
 * It goes to one place only (R7 #1, Mr.1 2026-11-15): there is no target flag, every POST goes to PROD_URL, and every
 * POST refuses redirects (`redirect: 'error'`), so the key header never follows a redirect to another host. Any other
 * flag, `--url` included, is a usage error (exit 2) raised before the key file is opened.
 *
 * Verdict: exactly one terminal `SR_ZONES_SMOKE_VERDICT=PASS|FAIL|INDETERMINATE`, FAIL over INDETERMINATE over PASS.
 * Exit: 0 PASS · 1 FAIL (a check ran and failed) · 2 usage · 3 INDETERMINATE (could not verify: no key, unreachable,
 * or a timeframe still loading after one retry).
 * --self-test: exactly one terminal `SR_ZONES_SMOKE_SELFTEST=PASS|FAIL` (exit 0 / 1). Clean bodies must pass and
 * every planted defect must be caught, so a check that stopped checking turns the self-test red.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The facts-only lint (tests/unit/sr-zones-facts-lint.test.ts holds the same pattern; a test pins the two equal). */
const FORBIDDEN =
  /\b(will|likely|unlikely|expect\w*|predict\w*|forecast\w*|target\w*|probab\w*|chances?|should|bounce\w*|revers\w*|may hold|must hold|strong(er|est)?|weak(er|est)?)\b/i;

const PROD_URL = 'https://api.algovault.com/mcp';
/** The server's load-timeout unserved reason (src/tools/get-sr-zones.ts, R8); a handler test pins this pattern to it. */
const LOAD_TIMEOUT = /candle history did not load within \d+ s/;
/** How long a check waits before calling once more on a load-timeout answer (R9 #3). */
const RETRY_WAIT_MS = 15_000;
const RESULT_KEYS = ['timeframe', 'summary', 'volume_vs_20', 'flags', 'support', 'resistance'];
const TOP_KEYS = ['coin', 'venue', 'price', 'order', 'note', 'results', 'unserved', 'timestamp', '_algovault'];
const ZONE_KEYS = [
  'rank', 'low', 'high', 'distance_pct', 'formed_from', 'formed_to', 'members',
  'touch_bars_90', 'tests_30', 'last_touch', 'state', 'broke_at', 'overlaps',
];

/** The terminal token. process.exitCode, never process.exit(): a queued pipe write would lose the token. */
function verdict(token, code) {
  console.log(`SR_ZONES_SMOKE_VERDICT=${token}`);
  process.exitCode = code;
}

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === '--self-test') return { selfTest: true };
  const out = { prod: false, young: 'CT' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--prod') out.prod = true;
    else if (argv[i] === '--young') out.young = (argv[++i] ?? '').toUpperCase();
    else return null; // `--url` and every other flag: usage error, before the key file is opened
  }
  return out.prod && out.young ? out : null;
}

/** The internal key, or null. Read from the file only; never echoed. */
function readKey() {
  try {
    const text = readFileSync(join(homedir(), '.config', 'algovault', 'internal.env'), 'utf8');
    const line = text.split('\n').find((l) => l.startsWith('ALGOVAULT_INTERNAL_BYPASS_KEY='));
    const value = line ? line.slice('ALGOVAULT_INTERNAL_BYPASS_KEY='.length).trim().replace(/^['"]|['"]$/g, '') : '';
    return value.length >= 16 ? value : null;
  } catch {
    return null;
  }
}

class Unreachable extends Error {}

/**
 * One JSON-RPC POST to PROD_URL, the only fetch call site; the body may come back as JSON or as an SSE stream of
 * `data:` lines. A redirect is refused (fetch rejects), so it ends INDETERMINATE and the key goes nowhere else.
 */
async function rpc(key, payload) {
  let res;
  try {
    res = await fetch(PROD_URL, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'X-AlgoVault-Internal-Key': key,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new Unreachable(`POST ${PROD_URL} failed: ${e instanceof Error ? e.name : 'error'}`);
  }
  const raw = await res.text();
  if (payload.id === undefined) return null; // a notification
  const data = raw.includes('data:')
    ? raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n')
    : raw;
  let outer;
  try {
    outer = JSON.parse(data);
  } catch {
    throw new Error(`${payload.method}: HTTP ${res.status}, body is not JSON-RPC`);
  }
  if (outer.error) throw new Error(`${payload.method}: JSON-RPC error ${outer.error.code} ${outer.error.message}`);
  return outer.result;
}

/** tools/call → the tool's JSON payload (content[0].text parsed) and whether the server marked it an error. */
async function callTool(key, id, name, args) {
  const result = await rpc(key, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  const text = result?.content?.[0]?.text;
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { isError: result?.isError === true, body, text };
}

/** Every string value in a JSON value, with its path. */
function strings(v, path = '$') {
  if (typeof v === 'string') return [[path, v]];
  if (Array.isArray(v)) return v.flatMap((x, i) => strings(x, `${path}[${i}]`));
  if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => strings(x, `${path}.${k}`));
  return [];
}

const sameKeys = (o, keys) => o && typeof o === 'object' && JSON.stringify(Object.keys(o)) === JSON.stringify(keys);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The requested coin symbol, as a whole token, replaced by a placeholder: it is the caller's input, not our wording. */
function maskCoin(s, coin) {
  if (!coin) return s;
  return s.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRe(coin)}(?![A-Za-z0-9])`, 'g'), '<COIN>');
}

/** The facts lint over [label, value, coinToMask|null] targets → every string checked and the ones that hit. */
function lintHits(targets) {
  const all = targets.flatMap(([label, v, coin]) => strings(v).map(([p, s]) => [`${label} ${p}`, maskCoin(s, coin)]));
  return { count: all.length, hits: all.filter(([, s]) => FORBIDDEN.test(s)) };
}

function shapeProblems(body, expectedTimeframes) {
  const p = [];
  if (!sameKeys(body, TOP_KEYS)) return [`top-level keys ${JSON.stringify(body && Object.keys(body))}`];
  if (body.venue !== 'BINANCE') p.push(`venue ${body.venue}`);
  if (!(typeof body.price === 'number' && body.price > 0)) p.push('price is not a positive number');
  const tfs = body.results.map((r) => r.timeframe);
  if (JSON.stringify(tfs) !== JSON.stringify(expectedTimeframes)) p.push(`results ${JSON.stringify(tfs)}, unserved ${JSON.stringify(body.unserved)}`);
  for (const r of body.results) {
    if (!sameKeys(r, RESULT_KEYS)) p.push(`${r.timeframe}: result keys ${JSON.stringify(Object.keys(r))}`);
    if (r.support.length > 3 || r.resistance.length > 3) p.push(`${r.timeframe}: more than 3 zones a side`);
    for (const z of [...r.support, ...r.resistance]) if (!sameKeys(z, ZONE_KEYS)) p.push(`${r.timeframe}: zone keys ${JSON.stringify(Object.keys(z))}`);
  }
  return p;
}

/** Timeframes unserved only because their first full read was still loading (the read goes on and caches, R8). */
function loadingTimeframes(body) {
  const rows = Array.isArray(body?.unserved) ? body.unserved : [];
  return rows.filter((u) => typeof u?.reason === 'string' && LOAD_TIMEOUT.test(u.reason)).map((u) => u.timeframe);
}

/** The young listing's check: its result is served and carries flags. */
function youngProblems(body) {
  const r = body?.results?.[0];
  return r && Array.isArray(r.flags) ? [] : ['no result carrying flags'];
}

/**
 * One get_sr_zones check (R9 #3). `call(args)` performs tools/call and `sleep(ms)` waits; the self-test stubs both.
 * A load-timeout answer is called once more after RETRY_WAIT_MS. Timeframes still loading after that are not
 * verified (`indeterminate`); every timeframe that was served is checked by `verify(body, servedTimeframes)`, and a
 * refusal for any other reason is a problem. → { outcome: 'pass' | 'fail' | 'indeterminate', detail, body, bodies }
 */
async function checkZones(call, sleep, args, verify) {
  let res = await call(args);
  const bodies = [res.body];
  let loading = loadingTimeframes(res.body);
  const retried = loading.length > 0;
  if (retried) {
    await sleep(RETRY_WAIT_MS);
    res = await call(args);
    bodies.push(res.body);
    loading = loadingTimeframes(res.body);
  }
  const want = args.timeframes.filter((tf) => !loading.includes(tf));
  const problems = want.length === 0 ? [] : res.body && !res.isError ? verify(res.body, want) : [`refused: ${res.text}`];
  const outcome = problems.length > 0 ? 'fail' : loading.length > 0 ? 'indeterminate' : 'pass';
  const notes = [
    ...(retried ? [`called again after ${RETRY_WAIT_MS / 1000} s on a load-timeout answer`] : []),
    ...(loading.length > 0 ? [`${loading.join(', ')} still loading`] : []),
    ...problems,
  ];
  return { outcome, detail: notes.length > 0 ? ` — ${notes.join('; ')}` : '', body: res.body, bodies };
}

/** FAIL when a check failed, else INDETERMINATE when something could not be verified, else PASS. */
function finalVerdict(failures, unverified) {
  if (failures.length > 0) return ['FAIL', 1];
  if (unverified.length > 0) return ['INDETERMINATE', 3];
  return ['PASS', 0];
}

/**
 * Checks 1-5 through `rpcCall(payload)` (JSON-RPC) and `toolCall(args)` (get_sr_zones), waiting with `sleep(ms)`. It
 * neither exits nor rethrows: an unreachable host (Unreachable) is recorded as not verified and stops the remaining
 * checks (R10 #2), so a check that already failed keeps the run FAIL; any other error is a failed check. The facts lint
 * judges only what was collected. → { failures, unverified, verdict }, where `verdict` (finalVerdict, derived once
 * here) is what main() exits with.
 */
async function runChecks({ rpcCall, toolCall, sleep, young, log = console.log }) {
  const failures = [];
  const unverified = [];
  const lintTargets = [];
  const check = (ok, line) => {
    log(`${ok ? 'PASS' : 'FAIL'}  ${line}`);
    if (!ok) failures.push(line);
  };
  const report = (outcome, line) => {
    log(`${outcome === 'pass' ? 'PASS' : outcome === 'fail' ? 'FAIL' : 'INDETERMINATE'}  ${line}`);
    if (outcome === 'fail') failures.push(line);
    if (outcome === 'indeterminate') unverified.push(line);
  };
  const lintAll = (label, r, coin) => r.bodies.forEach((b, i) => { if (b) lintTargets.push([`${label}${i > 0 ? ' (retry)' : ''}`, b, coin]); });

  try {
    await rpcCall({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'sr-zones-smoke', version: '1' } },
    });
    await rpcCall({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const list = await rpcCall({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const tool = (list?.tools ?? []).find((t) => t.name === 'get_sr_zones');
    check(!!tool, `tools/list lists get_sr_zones (${(list?.tools ?? []).length} tools)`);
    if (tool) lintTargets.push(['tools/list get_sr_zones', { description: tool.description, inputSchema: tool.inputSchema }, null]);

    const btc = await checkZones(toolCall, sleep, { coin: 'BTC', timeframes: ['1d', '4h'] }, shapeProblems);
    report(btc.outcome, `BTC 1d+4h: 2 results, ≤3 zones a side, §0 fields${btc.detail}`);
    lintAll('BTC 1d+4h', btc, 'BTC');

    const eth = await checkZones(toolCall, sleep, { coin: 'ETH', timeframes: ['1h'] }, shapeProblems);
    report(eth.outcome, `ETH 1h served${eth.detail}`);
    lintAll('ETH 1h', eth, 'ETH');

    const yl = await checkZones(toolCall, sleep, { coin: young, timeframes: ['1d'] }, youngProblems);
    const yr = yl.outcome === 'pass' ? yl.body.results[0] : null;
    report(
      yl.outcome,
      `young listing ${young} 1d served with flags` +
        `${yr ? ` ${JSON.stringify(yr.flags)} (support ${yr.support.length}, resistance ${yr.resistance.length})` : ''}${yl.detail}`,
    );
    lintAll(`${young} 1d`, yl, young);
  } catch (e) {
    if (e instanceof Unreachable) report('indeterminate', e.message);
    else check(false, e instanceof Error ? e.message : String(e));
  }

  // No string collected: tools/list or the first call after it already failed or went unverified, so a skip is never a PASS.
  const lint = lintHits(lintTargets);
  if (lint.count === 0) log('SKIP  facts lint: nothing was collected');
  else check(lint.hits.length === 0, `facts lint on ${lint.count} returned strings (requested coin symbol masked)${lint.hits.length ? ` — ${lint.hits.map(([p, s]) => `${p}: ${s}`).join(' | ')}` : ''}`);
  return { failures, unverified, verdict: finalVerdict(failures, unverified) };
}

/** A §0-shaped body for the self-test: one support and one resistance zone per timeframe. */
function sampleBody(coin, timeframes) {
  const zone = (rank, low, high) => ({
    rank, low, high, distance_pct: 1.5, formed_from: '2026-11-01T00:00:00.000Z', formed_to: '2026-11-02T00:00:00.000Z',
    members: 2, touch_bars_90: 4, tests_30: 1, last_touch: '2026-11-10T00:00:00.000Z', state: 'intact', broke_at: null, overlaps: [],
  });
  return {
    coin, venue: 'BINANCE', price: 100,
    order: 'Zones are ranked from the most recent price cluster outward: each next zone formed earlier and sits further from price.',
    note: 'Zones mark where price has clustered before. Price can move through any zone.',
    results: timeframes.map((timeframe) => ({
      timeframe,
      summary: `${coin} ${timeframe} at 100: 1 support and 1 resistance zones; support zone 1 at 97–98, 2% below; resistance zone 1 at 102–103, 2% above; last closed candle volume 1× its 20-candle average.`,
      volume_vs_20: 1, flags: [], support: [zone(1, 97, 98)], resistance: [zone(1, 102, 103)],
    })),
    unserved: [], timestamp: 1763193600, _algovault: { tool: 'get_sr_zones' },
  };
}

/**
 * rpc() against a stubbed fetch (no network; a dummy key, never printed): the one POST it makes goes to PROD_URL,
 * as a POST, with redirects refused.
 */
async function postIsPinned() {
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), method: init?.method, redirect: init?.redirect });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    await rpc('x'.repeat(32), { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  } finally {
    globalThis.fetch = real;
  }
  return seen.length === 1 && seen[0].url === 'https://api.algovault.com/mcp' && seen[0].method === 'POST' && seen[0].redirect === 'error';
}

/** Two-way: every clean case must pass and every planted defect must be caught. */
async function selfTest() {
  const edit = (body, f) => { const b = structuredClone(body); f(b); return b; };
  const btc = sampleBody('BTC', ['1d', '4h']);
  const predict = sampleBody('PREDICT', ['1d']);
  // R9 #3: checkZones over scripted answers, with a recorded (instant) sleep.
  const LOADING = 'BINANCE candle history did not load within 10 s; the read continues in the background';
  const BTC2 = { coin: 'BTC', timeframes: ['1d', '4h'] };
  const answer = (body, isError = false) => ({ isError, body, text: JSON.stringify(body) });
  const loadingBody = (served, loading) => ({ ...sampleBody('BTC', served), unserved: loading.map((timeframe) => ({ timeframe, reason: LOADING })) });
  const refusalBody = (loading) => ({
    error: 'no_timeframe_served', code: 'no_timeframe_served', coin: 'BTC', venue: 'BINANCE', message: 'none served',
    unserved: loading.map((timeframe) => ({ timeframe, reason: LOADING })), suggested_action: 'retry', _algovault: { tool: 'get_sr_zones' },
  });
  const scripted = async (answers, args = BTC2, verify = shapeProblems) => {
    const waits = [];
    let calls = 0;
    const r = await checkZones(async () => answers[Math.min(calls++, answers.length - 1)], async (ms) => { waits.push(ms); }, args, verify);
    return { ...r, calls, waits: JSON.stringify(waits) };
  };
  // R9 #3 end to end: runChecks (what main() runs) over scripted answers per coin, a silent log, an instant sleep.
  const TOOLS = { tools: [{ name: 'get_sr_zones', description: 'Returns support and resistance zones for one coin.', inputSchema: {} }] };
  const endToEnd = async (perCoin, rpcCall = async (p) => (p.method === 'tools/list' ? TOOLS : {})) => {
    const seen = {};
    const found = await runChecks({
      rpcCall,
      toolCall: async (a) => {
        seen[a.coin] = (seen[a.coin] ?? -1) + 1;
        const next = perCoin[a.coin][Math.min(seen[a.coin], perCoin[a.coin].length - 1)];
        if (next instanceof Error) throw next; // a scripted unreachable call
        return next;
      },
      sleep: async () => {},
      young: 'CT',
      log: () => {},
    });
    return JSON.stringify(found.verdict);
  };
  const ethOk = [answer(sampleBody('ETH', ['1h']))];
  const ctOk = [answer(sampleBody('CT', ['1d']))];
  const cases = [
    ['clean BTC body passes the shape check', () => shapeProblems(btc, ['1d', '4h']).length === 0],
    ['clean BTC body passes the facts lint', () => { const l = lintHits([['btc', btc, 'BTC']]); return l.count > 0 && l.hits.length === 0; }],
    ['PREDICT coin echo is masked', () => lintHits([['predict', predict, 'PREDICT']]).hits.length === 0],
    ['PREDICT is caught when nothing is masked', () => lintHits([['predict', predict, null]]).hits.length === 2],
    ['the mask covers only the whole symbol', () => maskCoin('PREDICTS PREDICT', 'PREDICT') === 'PREDICTS <COIN>'],
    ['a forbidden word in the summary is caught', () => lintHits([['b', edit(btc, (b) => { b.results[0].summary += ' Price will hold.'; }), 'BTC']]).hits.length === 1],
    ['a forbidden word in the note is caught', () => lintHits([['b', edit(btc, (b) => { b.note = 'Zones likely hold.'; }), 'BTC']]).hits.length === 1],
    ['a forbidden word in the description is caught', () => lintHits([['t', { description: 'Predicts the next bounce.' }, null]]).hits.length === 1],
    ['a fourth support zone is caught', () => shapeProblems(edit(btc, (b) => { b.results[0].support.push(...b.results[0].support, ...b.results[0].support, ...b.results[0].support); }), ['1d', '4h']).length > 0],
    ['a zone without overlaps is caught', () => shapeProblems(edit(btc, (b) => { delete b.results[1].resistance[0].overlaps; }), ['1d', '4h']).length > 0],
    ['a missing result is caught', () => shapeProblems(edit(btc, (b) => { b.results.pop(); }), ['1d', '4h']).length > 0],
    ['top-level keys out of §0 order are caught', () => shapeProblems(edit(btc, (b) => { const { coin, ...rest } = b; Object.keys(b).forEach((k) => delete b[k]); Object.assign(b, rest, { coin }); }), ['1d', '4h']).length > 0],
    ['another venue is caught', () => shapeProblems(edit(btc, (b) => { b.venue = 'BYBIT'; }), ['1d', '4h']).length > 0],
    ['a zero price is caught', () => shapeProblems(edit(btc, (b) => { b.price = 0; }), ['1d', '4h']).length > 0],
    ['every POST goes to https://api.algovault.com/mcp with redirects refused', postIsPinned],
    ['a load-timeout unserved row is a retry: called again after 15 s, then served', async () => {
      const r = await scripted([answer(loadingBody(['1d'], ['4h'])), answer(btc)]);
      return r.outcome === 'pass' && r.calls === 2 && r.waits === '[15000]';
    }],
    ['still loading after the retry is INDETERMINATE, not FAIL', async () => {
      const r = await scripted([answer(loadingBody(['1d'], ['4h'])), answer(loadingBody(['1d'], ['4h']))]);
      return r.outcome === 'indeterminate' && r.calls === 2 && r.waits === '[15000]';
    }],
    ['every timeframe still loading (the call refused) is INDETERMINATE', async () => {
      const r = await scripted([answer(refusalBody(['1d', '4h']), true), answer(refusalBody(['1d', '4h']), true)]);
      return r.outcome === 'indeterminate' && r.calls === 2;
    }],
    ['another unserved reason is not retried, and FAILs', async () => {
      const failed = { ...sampleBody('BTC', ['1d']), unserved: [{ timeframe: '4h', reason: 'BINANCE candle request failed' }] };
      const r = await scripted([answer(failed)]);
      return r.outcome === 'fail' && r.calls === 1 && r.waits === '[]';
    }],
    ['a defect in what was served FAILs while another timeframe is loading', async () => {
      const bad = edit(loadingBody(['1d'], ['4h']), (b) => { delete b.results[0].support[0].overlaps; });
      const r = await scripted([answer(bad), answer(bad)]);
      return r.outcome === 'fail' && r.calls === 2;
    }],
    ['a clean first answer is not retried', async () => {
      const r = await scripted([answer(btc)]);
      return r.outcome === 'pass' && r.calls === 1 && r.waits === '[]';
    }],
    ['the verdict: FAIL over INDETERMINATE over PASS', () =>
      JSON.stringify([finalVerdict(['f'], ['u']), finalVerdict([], ['u']), finalVerdict([], [])]) ===
        JSON.stringify([['FAIL', 1], ['INDETERMINATE', 3], ['PASS', 0]])],
    ['end to end: BTC 4h still loading after the retry is the run\'s INDETERMINATE', async () =>
      (await endToEnd({ BTC: [answer(loadingBody(['1d'], ['4h']))], ETH: ethOk, CT: ctOk })) === '["INDETERMINATE",3]'],
    ['end to end: loading, then served on the retry, is the run\'s PASS', async () =>
      (await endToEnd({ BTC: [answer(loadingBody(['1d'], ['4h'])), answer(btc)], ETH: ethOk, CT: ctOk })) === '["PASS",0]'],
    ['end to end: a forbidden word beside a loading timeframe is the run\'s FAIL', async () => {
      const eth = [answer(edit(sampleBody('ETH', ['1h']), (b) => { b.results[0].summary += ' Price will hold.'; }))];
      return (await endToEnd({ BTC: [answer(loadingBody(['1d'], ['4h']))], ETH: eth, CT: ctOk })) === '["FAIL",1]';
    }],
    // R10 #2: an unreachable call is could-not-verify and ends the run; a check that already failed keeps it FAIL.
    ['end to end: a FAIL then an unreachable call is the run\'s FAIL', async () =>
      (await endToEnd({ BTC: [answer(edit(btc, (b) => { b.venue = 'BYBIT'; }))], ETH: [new Unreachable('POST failed')], CT: ctOk })) === '["FAIL",1]'],
    ['end to end: an unreachable first call is the run\'s INDETERMINATE, with nothing to lint', async () =>
      (await endToEnd({}, async () => { throw new Unreachable('POST failed'); })) === '["INDETERMINATE",3]'],
  ];
  let failed = 0;
  for (const [name, fn] of cases) {
    let ok = false;
    try { ok = (await fn()) === true; } catch { ok = false; }
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) failed++;
  }
  console.log(`SR_ZONES_SMOKE_SELFTEST=${failed === 0 ? 'PASS' : 'FAIL'}`);
  process.exitCode = failed === 0 ? 0 : 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error('usage: node scripts/sr-zones-smoke.mjs --prod [--young <COIN>] | --self-test');
    process.exitCode = 2;
    return;
  }
  if (args.selfTest) return selfTest();
  const key = readKey();
  if (!key) {
    console.log('INDETERMINATE: no internal key in ~/.config/algovault/internal.env (ALGOVAULT_INTERNAL_BYPASS_KEY)');
    return verdict('INDETERMINATE', 3);
  }

  let nextId = 3;
  const found = await runChecks({
    rpcCall: (payload) => rpc(key, payload),
    toolCall: (a) => callTool(key, nextId++, 'get_sr_zones', a),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    young: args.young,
  });
  verdict(...found.verdict); // the one verdict, derived in runChecks
}

main();
