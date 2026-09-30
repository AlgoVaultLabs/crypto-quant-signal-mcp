// OPS-ADAPTER-HISTORY-ANCHOR-W1 CH1 — fixture capture THROUGH the shipped adapters (worktree dist == origin/main).
// Scenarios per pair (s = the adapter's served step, W = EVAL_CANDLES[tf]):
//   R  recent : from = now - (2W+1)*s, no endTime            (the canary's recent page; serving-like: no endTime)
//   D  deep   : from = now - (200+2W+6)*s, to = from + 2W*s   (beyond every venue's 100/200-bar recent reach)
// Extras: E (young-coin pre-listing window) on BITGET/OKX 1h; D2 (deeper) on BITGET 2h/8h; raw off-grid probes.
// Read-only public klines. Pacing: >= 1.0 s global, >= 2 s per venue (HL 3 s, WEEX 5 s). No retries added by us.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const [WT, OUTDIR, ONLY] = process.argv.slice(2);
const D = (p) => require(path.join(WT, 'dist', p));
const tfs = D('lib/tf-support.js');
const { EVAL_CANDLES } = D('scripts/directional-labeler.js');
const TF_MS = D('lib/pfe-mae.js').TF_MS;

const FILES = {
  ASTER: ['aster', 'AsterAdapter'], BINANCE: ['binance', 'BinanceAdapter'], BINGX: ['bingx', 'BingxAdapter'],
  BITGET: ['bitget', 'BitgetAdapter'], BYBIT: ['bybit', 'BybitAdapter'], GATE: ['gateio', 'GateAdapter'],
  HL: ['hyperliquid', 'HyperliquidAdapter'], HTX: ['htx', 'HTXAdapter'], KUCOIN: ['kucoin', 'KuCoinAdapter'],
  MEXC: ['mexc', 'MEXCAdapter'], OKX: ['okx', 'OKXAdapter'], PHEMEX: ['phemex', 'PhemexAdapter'],
  WEEX: ['weex', 'WeexAdapter'], WHITEBIT: ['whitebit', 'WhitebitAdapter'], XT: ['xt', 'XtAdapter'],
};
const PROMOTED = Object.keys(FILES); // pinned from `venues` (aoe_readonly, 2026-09-30T02:5xZ): 15 promoted, BITMART/EDGEX retired
function adapterClass(v) {
  const m = D(`lib/adapters/${FILES[v][0]}.js`);
  const C = m[FILES[v][1]] || Object.values(m).find((x) => typeof x === 'function' && /Adapter$/.test(x.name));
  if (!C) throw new Error('no adapter class for ' + v);
  return C;
}
const served = (v, tf) => D(`lib/adapters/${FILES[v][0]}.js`).servedIntervalMs(tf);

let log = [];
const lastAtVenue = {};
let lastAt = 0;
const gapFor = (u) => (/weex/i.test(u) ? 5000 : /hyperliquid/i.test(u) ? 3000 : 2000);
const hostKey = (u) => { try { return new URL(u).host; } catch { return u; } };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  const calledAt = Date.now();
  const h = hostKey(u);
  const wait = Math.max((lastAtVenue[h] || 0) + gapFor(u), lastAt + 1000) - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastAt = lastAtVenue[h] = Date.now();
  const sentAt = Date.now();
  try {
    const res = await realFetch(url, init);
    const text = await res.clone().text();
    log.push({ url: u, method: (init && init.method) || 'GET', reqBody: init && init.body ? String(init.body) : null, calledAt, sentAt, status: res.status, body: text });
    return res;
  } catch (e) {
    log.push({ url: u, method: (init && init.method) || 'GET', reqBody: init && init.body ? String(init.body) : null, calledAt, sentAt, status: 0, error: String(e && e.message || e), body: null });
    throw e;
  }
};

async function scenario(tag, v, tf, coin, from, to) {
  log = [];
  const calledAt = Date.now();
  let out = null, err = null;
  try { out = await new (adapterClass(v))().getCandles(coin, tf, from, undefined, to); } catch (e) { err = String(e && e.message || e); }
  return {
    tag, venue: v, tf, coin, from, to: to ?? null, calledAt, requestedMs: TF_MS[tf], servedMs: served(v, tf),
    W: EVAL_CANDLES[tf] ?? null, error: err,
    output: (out || []).map((c) => ({ ts: c.time, open: c.open })),
    requests: log.map((r) => ({ ...r, sha256: r.body == null ? null : crypto.createHash('sha256').update(r.body).digest('hex') })),
  };
}

// ── extras: E (young-coin pre-listing window, BITGET/OKX 1h) · D2 (deeper, BITGET 2h/8h) · raw controls ──
async function raw(tag, pair, url) {
  log = [];
  try { await fetch(url); } catch (e) { /* recorded by the interceptor */ }
  const r = log[0];
  return { tag, pair, url, calledAt: r ? r.calledAt : Date.now(), status: r ? r.status : 0, error: r && r.error || null, body: r ? r.body : null };
}
(async () => {
  const H = 3_600_000;
  // listing instants, measured at capture time from the venues' own data
  const bitgetFirst = JSON.parse((await raw('probe', 'BITGET/PONS', 'https://api.bitget.com/api/v2/mix/market/candles?productType=USDT-FUTURES&symbol=PONSUSDT&granularity=1D&limit=100')).body).data;
  const okxInst = JSON.parse((await raw('probe', 'OKX/FLOCK', 'https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=FLOCK-USDT-SWAP')).body).data[0];
  const bitgetListing = +bitgetFirst[0][0];
  const okxListing = +okxInst.listTime;
  const extras = { BITGET: [], OKX: [] };
  extras.BITGET.push(await scenario('E', 'BITGET', '1h', 'PONS', bitgetListing - 20 * 24 * H, bitgetListing - 10 * 24 * H));
  extras.OKX.push(await scenario('E', 'OKX', '1h', 'FLOCK', okxListing - 20 * 24 * H, okxListing - 10 * 24 * H));
  const now = Date.now();
  const f2 = now - 1000 * H, f8 = now - 3000 * H;
  extras.BITGET.push(await scenario('D2', 'BITGET', '2h', 'BTC', f2, f2 + 12 * H));
  extras.BITGET.push(await scenario('D2', 'BITGET', '8h', 'BTC', f8, f8 + 48 * H));
  // controls: the venue's own history page anchored on the SERVED step (proves the venue can serve the window)
  const controls = [];
  const bitD = JSON.parse(fs.readFileSync(path.join(OUTDIR, 'BITGET.raw.json'), 'utf8'));
  const d2h = bitD.pairs.find((p) => p.pair === 'BITGET/2h').D, d8h = bitD.pairs.find((p) => p.pair === 'BITGET/8h').D;
  for (const [pair, s, from, to, gran] of [['BITGET/2h', 'D', d2h.from, d2h.to, '1H'], ['BITGET/8h', 'D', d8h.from, d8h.to, '6H'], ['BITGET/2h', 'D2', f2, f2 + 12 * H, '1H'], ['BITGET/8h', 'D2', f8, f8 + 48 * H, '6H']]) {
    const step = gran === '1H' ? H : 6 * H;
    const c = await raw('CONTROL', pair, `https://api.bitget.com/api/v2/mix/market/history-candles?productType=USDT-FUTURES&symbol=BTCUSDT&granularity=${gran}&endTime=${from + 200 * step}&limit=200`);
    controls.push({ ...c, scenario: s, from, to, servedMs: step, parser: 'bitget-rows' });
  }
  // model probes for CH2's synthetic Bitget/OKX venue (boundary semantics at off-grid instants)
  const g = Math.floor((now - 48 * H) / H) * H + 30 * 60_000;
  const probes = [];
  probes.push(await raw('MODEL', 'BITGET/history-endTime-offgrid', `https://api.bitget.com/api/v2/mix/market/history-candles?productType=USDT-FUTURES&symbol=BTCUSDT&granularity=1H&endTime=${g}&limit=5`));
  probes.push(await raw('MODEL', 'BITGET/candles-startTime-offgrid', `https://api.bitget.com/api/v2/mix/market/candles?productType=USDT-FUTURES&symbol=BTCUSDT&granularity=1H&startTime=${g}&limit=5`));
  probes.push(await raw('MODEL', 'BITGET/candles-90d-window-6H', `https://api.bitget.com/api/v2/mix/market/candles?productType=USDT-FUTURES&symbol=BTCUSDT&granularity=6H&startTime=${now - 120 * 24 * H}&limit=1000`));
  probes.push(await raw('MODEL', 'OKX/history-after-offgrid', `https://www.okx.com/api/v5/market/history-candles?instId=BTC-USDT-SWAP&bar=1H&after=${g}&limit=5`));
  probes.push(await raw('MODEL', 'OKX/candles-before-offgrid', `https://www.okx.com/api/v5/market/candles?instId=BTC-USDT-SWAP&bar=1H&before=${g}&limit=5`));
  fs.writeFileSync(path.join(OUTDIR, 'EXTRAS.raw.json'), JSON.stringify({ bitgetListing, okxListing, extras, controls, probes }));
  process.stderr.write(`extras: E bitget ${extras.BITGET[0].output.length}/${extras.BITGET[0].requests.length}req, E okx ${extras.OKX[0].output.length}/${extras.OKX[0].requests.length}req, D2 ${extras.BITGET[1].output.length},${extras.BITGET[2].output.length}; controls ${controls.map((c) => c.status).join(',')}; probes ${probes.map((p) => p.status).join(',')}\n`);
})();
