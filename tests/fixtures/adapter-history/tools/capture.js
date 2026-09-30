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

(async () => {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const pairs = [];
  for (const v of PROMOTED) for (const tf of tfs.CRON_TIMEFRAMES) pairs.push([v, tf, tfs.isTimeframeFaithful(v, tf)]);
  const byVenue = {};
  for (const [v, tf, faithful] of pairs) {
    if (ONLY && !ONLY.split(',').includes(v)) continue;
    const s = served(v, tf);
    const W = EVAL_CANDLES[tf];
    const now = Date.now();
    (byVenue[v] ||= []).push({ pair: `${v}/${tf}`, faithful, R: await scenario('R', v, tf, 'BTC', now - (2 * W + 1) * s) });
    const now2 = Date.now();
    const from = now2 - (200 + 2 * W + 6) * s;
    byVenue[v].at(-1).D = await scenario('D', v, tf, 'BTC', from, from + 2 * W * s);
    fs.writeFileSync(path.join(OUTDIR, `${v}.raw.json`), JSON.stringify({ venue: v, capturedBy: 'mac', pairs: byVenue[v] }));
    process.stderr.write(`${v}/${tf} R:${byVenue[v].at(-1).R.output.length}${byVenue[v].at(-1).R.error ? '!' : ''} D:${byVenue[v].at(-1).D.output.length}${byVenue[v].at(-1).D.error ? '!' : ''}\n`);
  }
  process.stderr.write('done\n');
})();
