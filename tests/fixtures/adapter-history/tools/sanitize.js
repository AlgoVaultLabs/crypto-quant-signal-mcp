'use strict';
// Sanitize the raw adapter captures into repo fixtures:
//   - body → parsed JSON, candle rows older than (from − 2·served) dropped (the adapter can never return them);
//   - PROOF per scenario: replaying the trimmed bodies through the SAME adapter (frozen clock) reproduces the
//     recorded output exactly; otherwise the scenario keeps its untrimmed rows (and says so).
// OPS-SERVED-CANDLE-TRUTH-W1 CH1: `trim`, `makeReplay` and `sanitizeScenario` are exported, so the suite-S capture
// (capture-serving.js) sanitizes by this one rule. Run as a script, it does what it always did.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const FILES = { ASTER: ['aster', 'AsterAdapter'], BINANCE: ['binance', 'BinanceAdapter'], BINGX: ['bingx', 'BingxAdapter'], BITGET: ['bitget', 'BitgetAdapter'], BYBIT: ['bybit', 'BybitAdapter'], GATE: ['gateio', 'GateAdapter'], HL: ['hyperliquid', 'HyperliquidAdapter'], HTX: ['htx', 'HTXAdapter'], KUCOIN: ['kucoin', 'KuCoinAdapter'], MEXC: ['mexc', 'MEXCAdapter'], OKX: ['okx', 'OKXAdapter'], PHEMEX: ['phemex', 'PhemexAdapter'], WEEX: ['weex', 'WeexAdapter'], WHITEBIT: ['whitebit', 'WhitebitAdapter'], XT: ['xt', 'XtAdapter'] };

const toMs = (v) => { const n = typeof v === 'string' ? Number(v) : v; return typeof n === 'number' && Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : null; };
const rowTs = (r) => Array.isArray(r) ? toMs(r[0]) : r && typeof r === 'object' ? toMs(r.t ?? r.time ?? r.id ?? r.ts ?? r.timestamp ?? r.openTime) : null;
// Locate the candle rows: the largest array (anywhere) whose rows all carry a timestamp; or MEXC's column form.
function trim(json, minTs) {
  let best = null;
  const walk = (node, set) => {
    if (Array.isArray(node)) {
      if (node.length && node.every((r) => rowTs(r) != null) && (!best || node.length > best.node.length)) best = { node, set };
      return;
    }
    if (node && typeof node === 'object') {
      if (Array.isArray(node.time) && node.time.every((t) => toMs(t) != null) && Object.values(node).some((v) => Array.isArray(v) && v.length === node.time.length && v !== node.time)) {
        if (!best || node.time.length > best.node.length) best = { node: node.time, columns: node };
      }
      for (const [k, v] of Object.entries(node)) walk(v, (x) => { node[k] = x; });
    }
  };
  const root = { v: structuredClone(json) };
  walk(root.v, (x) => { root.v = x; });
  if (!best) return { json: root.v, dropped: 0 };
  if (best.columns) {
    const keep = best.columns.time.map((t) => toMs(t) >= minTs);
    let dropped = keep.filter((k) => !k).length;
    for (const [k, v] of Object.entries(best.columns)) if (Array.isArray(v) && v.length === keep.length) best.columns[k] = v.filter((_, i) => keep[i]);
    return { json: root.v, dropped };
  }
  const kept = best.node.filter((r) => rowTs(r) >= minTs);
  const dropped = best.node.length - kept.length;
  best.set(kept);
  return { json: root.v, dropped };
}

// The HL adapter reads HL's market listing (metaAndAssetCtxs) before a candle request. The capture never records it
// (capture.js `isHlMarketListing`), so the replay answers it with the scenario's coin as a STANDARD market, exactly
// as tests/unit/adapter-history-contract.test.ts does.
const isHlMarketListing = (url, init) => /hyperliquid/i.test(String(url)) && /"type":"metaAndAssetCtxs"/.test(String((init && init.body) || ''));
const hlListing = (init, coin) => {
  const names = JSON.parse(String(init.body)).dex === 'xyz' ? ['xyz:CONTRACT-TEST-ONLY'] : [coin];
  return [{ universe: names.map((name) => ({ name })) }, names.map(() => ({}))];
};
const asResponse = (json, status) => new Response(json == null ? '' : JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });

/** The replay proof's adapter run, through the adapters built in `${WT}/dist`: a frozen clock and a fetch that
 *  serves `reqs` in order. Both are restored afterwards. */
function makeReplay(WT) {
  const D = (p) => require(path.join(WT, 'dist', p));
  return async function replay(s, reqs) {
    const queue = reqs.map((r) => ({ ...r }));
    const realFetch = globalThis.fetch, realNow = Date.now;
    globalThis.fetch = async (url, init) => {
      if (isHlMarketListing(url, init)) return asResponse(hlListing(init, s.coin), 200);
      const q = queue.shift();
      if (!q) throw new Error('sanitize: unexpected extra request');
      if (q.error) throw new Error(q.error);
      return asResponse(q.json, q.status);
    };
    Date.now = () => s.calledAt;
    let out = null, err = null;
    try {
      const m = D(`lib/adapters/${FILES[s.venue][0]}.js`);
      if (typeof m._resetHyperliquidMetaCache === 'function') m._resetHyperliquidMetaCache();
      out = await new m[FILES[s.venue][1]]().getCandles(s.coin, s.tf, s.from, undefined, s.to ?? undefined);
    } catch (e) { err = String(e.message || e); }
    finally { Date.now = realNow; globalThis.fetch = realFetch; }
    return { out: (out || []).map((c) => ({ ts: c.time, open: c.open })), err, left: queue.length };
  };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** One raw scenario → its fixture form: trimmed when the replay proof holds, else untrimmed, else NONDETERMINISTIC. */
async function sanitizeScenario(replay, s) {
  // upstreamFetch retries a transport failure once (transientRetries: 1): the fetch-level capture records the
  // failed attempt AND the retry, while the replay stands in for upstreamFetch itself. Collapse each failed
  // attempt that the SAME request immediately retried, and say so on the scenario.
  const reqs = [];
  let transportRetries = 0;
  s.requests.forEach((r, i) => {
    const nx = s.requests[i + 1];
    if (r.status === 0 && nx && nx.url === r.url && (nx.reqBody || null) === (r.reqBody || null)) { transportRetries++; return; }
    reqs.push(r);
  });
  const parsed = reqs.map((r) => ({ url: r.url, method: r.method, reqBody: r.reqBody, status: r.status, error: r.error || null, json: r.body ? JSON.parse(r.body) : null, rawSha256: r.sha256 }));
  const minTs = s.from - 2 * s.servedMs;
  const trimmed = parsed.map((r) => { if (r.json == null) return { ...r, dropped: 0 }; const t = trim(r.json, minTs); return { ...r, json: t.json, dropped: t.dropped }; });
  const recorded = { out: s.output, err: s.error };
  const rt = await replay(s, trimmed);
  let use = trimmed, mode = 'trimmed';
  if (!(same(rt.out, recorded.out) && (rt.err == null) === (recorded.err == null) && rt.left === 0)) {
    const ru = await replay(s, parsed);
    if (same(ru.out, recorded.out) && (ru.err == null) === (recorded.err == null) && ru.left === 0) { use = parsed.map((r) => ({ ...r, dropped: 0 })); mode = 'untrimmed'; }
    else { mode = 'NONDETERMINISTIC'; use = parsed.map((r) => ({ ...r, dropped: 0 })); }
  }
  const row = { id: `${s.venue}/${s.tf}/${s.tag}${s.window ? `@${s.window}` : ''}`, mode, dropped: use.reduce((a, r) => a + (r.dropped || 0), 0) };
  const lastAt = Math.max(s.calledAt, ...reqs.map((r) => r.calledAt ?? s.calledAt));
  return { scenario: { ...s, transportRetries, replayToleranceMs: lastAt - s.calledAt + 2000, requests: use.map(({ dropped, ...r }) => r) }, row };
}

async function main(WT, MACDIR, OUTDIR, SHA) {
  const replay = makeReplay(WT);
  fs.mkdirSync(OUTDIR, { recursive: true });
  const report = [];
  const extrasFile = path.join(MACDIR, 'EXTRAS.raw.json');
  const extras = fs.existsSync(extrasFile) ? JSON.parse(fs.readFileSync(extrasFile, 'utf8')) : null;
  for (const f of fs.readdirSync(MACDIR).filter((f) => f.endsWith('.raw.json') && f !== 'EXTRAS.raw.json').sort()) {
    const j = JSON.parse(fs.readFileSync(path.join(MACDIR, f), 'utf8'));
    const doScen = async (s) => { const r = await sanitizeScenario(replay, s); report.push(r.row); return r.scenario; };
    const pairs = [];
    for (const p of j.pairs) pairs.push({ pair: p.pair, faithful: p.faithful, R: await doScen(p.R), D: await doScen(p.D) });
    const ex = [];
    if (extras && extras.extras[j.venue]) for (const s of extras.extras[j.venue]) ex.push(await doScen(s));
    const fixture = { venue: j.venue, originMainSha: SHA, capturedAt: new Date(Math.min(...pairs.map((p) => p.R.calledAt))).toISOString(), capturedBy: 'mac: capture through the shipped adapter; second vantages in VANTAGES.json', pairs, extras: ex };
    fs.writeFileSync(path.join(OUTDIR, `${j.venue}.json`), JSON.stringify(fixture));
  }
  const bad = report.filter((r) => r.mode !== 'trimmed');
  console.log('scenarios', report.length, 'trimmed', report.length - bad.length, 'other', JSON.stringify(bad));
  fs.writeFileSync(path.join(require('os').tmpdir(), 'adapter-history-sanitize-report.json'), JSON.stringify(report, null, 1));
}

if (require.main === module) main(...process.argv.slice(2));
module.exports = { FILES, trim, makeReplay, sanitizeScenario };
