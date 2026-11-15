#!/usr/bin/env node
/**
 * sr-zones-smoke.mjs — SR-ZONES-W1 AC2.4. A live smoke of get_sr_zones over MCP (streamable HTTP), reused at release.
 *
 *   node scripts/sr-zones-smoke.mjs --prod                 # https://api.algovault.com/mcp
 *   node scripts/sr-zones-smoke.mjs --url <mcp-url>        # any other deployment
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
 * The requested coin symbol is the caller's own input echoed back (in `coin` and in the summary), not our
 * wording, so it is masked before the lint: PREDICTUSDT is a real Binance perp, and its ticker alone matches
 * `predict\w*`. Every other character of every string is linted.
 *
 * Auth: the internal key from ~/.config/algovault/internal.env (ALGOVAULT_INTERNAL_BYPASS_KEY), sent as
 * X-AlgoVault-Internal-Key. The key is NEVER printed: no header, request or key-bearing value reaches stdout/stderr.
 *
 * Verdict: exactly one terminal `SR_ZONES_SMOKE_VERDICT=PASS|FAIL|INDETERMINATE`.
 * Exit: 0 PASS · 1 FAIL (a check ran and failed) · 2 usage · 3 INDETERMINATE (could not verify: no key, unreachable).
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
const RESULT_KEYS = ['timeframe', 'summary', 'volume_vs_20', 'flags', 'support', 'resistance'];
const TOP_KEYS = ['coin', 'venue', 'price', 'order', 'note', 'results', 'unserved', 'timestamp', '_algovault'];
const ZONE_KEYS = [
  'rank', 'low', 'high', 'distance_pct', 'formed_from', 'formed_to', 'members',
  'touch_bars_90', 'tests_30', 'last_touch', 'state', 'broke_at', 'overlaps',
];

function verdict(token, code) {
  console.log(`SR_ZONES_SMOKE_VERDICT=${token}`);
  process.exit(code);
}

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === '--self-test') return { selfTest: true };
  const out = { url: null, young: 'CT' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--prod') out.url = PROD_URL;
    else if (argv[i] === '--url') out.url = argv[++i] ?? null;
    else if (argv[i] === '--young') out.young = (argv[++i] ?? '').toUpperCase();
    else return null;
  }
  return out.url && out.young ? out : null;
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

/** One JSON-RPC POST; the body may come back as JSON or as an SSE stream of `data:` lines. */
async function rpc(url, key, payload) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'X-AlgoVault-Internal-Key': key,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new Unreachable(`POST ${url} failed: ${e instanceof Error ? e.name : 'error'}`);
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
async function callTool(url, key, id, name, args) {
  const result = await rpc(url, key, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
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

/** Two-way: every clean case must pass and every planted defect must be caught. */
function selfTest() {
  const edit = (body, f) => { const b = structuredClone(body); f(b); return b; };
  const btc = sampleBody('BTC', ['1d', '4h']);
  const predict = sampleBody('PREDICT', ['1d']);
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
  ];
  let failed = 0;
  for (const [name, fn] of cases) {
    let ok = false;
    try { ok = fn() === true; } catch { ok = false; }
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) failed++;
  }
  console.log(`SR_ZONES_SMOKE_SELFTEST=${failed === 0 ? 'PASS' : 'FAIL'}`);
  process.exit(failed === 0 ? 0 : 1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error('usage: node scripts/sr-zones-smoke.mjs (--prod | --url <mcp-url>) [--young <COIN>] | --self-test');
    process.exit(2);
  }
  if (args.selfTest) selfTest();
  const key = readKey();
  if (!key) {
    console.log('INDETERMINATE: no internal key in ~/.config/algovault/internal.env (ALGOVAULT_INTERNAL_BYPASS_KEY)');
    verdict('INDETERMINATE', 3);
  }

  const failures = [];
  const lintTargets = [];
  const check = (ok, line) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${line}`);
    if (!ok) failures.push(line);
  };

  try {
    await rpc(args.url, key, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'sr-zones-smoke', version: '1' } },
    });
    await rpc(args.url, key, { jsonrpc: '2.0', method: 'notifications/initialized' });

    const list = await rpc(args.url, key, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const tool = (list?.tools ?? []).find((t) => t.name === 'get_sr_zones');
    check(!!tool, `tools/list lists get_sr_zones (${(list?.tools ?? []).length} tools)`);
    if (tool) lintTargets.push(['tools/list get_sr_zones', { description: tool.description, inputSchema: tool.inputSchema }, null]);

    const btc = await callTool(args.url, key, 3, 'get_sr_zones', { coin: 'BTC', timeframes: ['1d', '4h'] });
    const btcProblems = btc.body && !btc.isError ? shapeProblems(btc.body, ['1d', '4h']) : [`refused: ${btc.text}`];
    check(btcProblems.length === 0, `BTC 1d+4h: 2 results, ≤3 zones a side, §0 fields${btcProblems.length ? ` — ${btcProblems.join('; ')}` : ''}`);
    if (btc.body) lintTargets.push(['BTC 1d+4h', btc.body, 'BTC']);

    const eth = await callTool(args.url, key, 4, 'get_sr_zones', { coin: 'ETH', timeframes: ['1h'] });
    const ethProblems = eth.body && !eth.isError ? shapeProblems(eth.body, ['1h']) : [`refused: ${eth.text}`];
    check(ethProblems.length === 0, `ETH 1h served${ethProblems.length ? ` — ${ethProblems.join('; ')}` : ''}`);
    if (eth.body) lintTargets.push(['ETH 1h', eth.body, 'ETH']);

    const young = await callTool(args.url, key, 5, 'get_sr_zones', { coin: args.young, timeframes: ['1d'] });
    const youngResult = young.body?.results?.[0];
    const youngServed = !young.isError && !!youngResult && Array.isArray(youngResult.flags);
    check(
      youngServed,
      `young listing ${args.young} 1d served with flags ${youngServed ? JSON.stringify(youngResult.flags) : ''}` +
        `${youngServed ? ` (support ${youngResult.support.length}, resistance ${youngResult.resistance.length})` : ` — ${young.text}`}`,
    );
    if (young.body) lintTargets.push([`${args.young} 1d`, young.body, args.young]);
  } catch (e) {
    if (e instanceof Unreachable) {
      console.log(`INDETERMINATE: ${e.message}`);
      verdict('INDETERMINATE', 3);
    }
    check(false, e instanceof Error ? e.message : String(e));
  }

  const lint = lintHits(lintTargets);
  check(lint.count > 0 && lint.hits.length === 0, `facts lint on ${lint.count} returned strings (requested coin symbol masked)${lint.hits.length ? ` — ${lint.hits.map(([p, s]) => `${p}: ${s}`).join(' | ')}` : ''}`);

  if (failures.length) verdict('FAIL', 1);
  verdict('PASS', 0);
}

main();
