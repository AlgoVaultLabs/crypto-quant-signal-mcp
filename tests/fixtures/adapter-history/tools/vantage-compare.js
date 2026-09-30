'use strict';
// Feed each second-vantage body through the SAME adapter (frozen clock = the Mac capture instant) and compare
// grid (served step set), phase and error class with the Mac capture. Output: per-scenario agreement rows.
const fs = require('fs'), path = require('path');
const [WT, MACDIR, VDIR, LABEL, OUT] = process.argv.slice(2);
const D = (p) => require(path.join(WT, 'dist', p));
const FILES = { ASTER: ['aster', 'AsterAdapter'], BINANCE: ['binance', 'BinanceAdapter'], BINGX: ['bingx', 'BingxAdapter'], BITGET: ['bitget', 'BitgetAdapter'], BYBIT: ['bybit', 'BybitAdapter'], GATE: ['gateio', 'GateAdapter'], HL: ['hyperliquid', 'HyperliquidAdapter'], HTX: ['htx', 'HTXAdapter'], KUCOIN: ['kucoin', 'KuCoinAdapter'], MEXC: ['mexc', 'MEXCAdapter'], OKX: ['okx', 'OKXAdapter'], PHEMEX: ['phemex', 'PhemexAdapter'], WEEX: ['weex', 'WeexAdapter'], WHITEBIT: ['whitebit', 'WhitebitAdapter'], XT: ['xt', 'XtAdapter'] };
const man = {};
for (const l of fs.readFileSync(path.join(VDIR, 'manifest.tsv'), 'utf8').trim().split('\n')) { const [id, code, rc] = l.split('\t'); man[id] = { code: +code, rc: +rc }; }
let queue = [];
globalThis.fetch = async () => { const q = queue.shift(); if (!q) throw new Error('no vantage body'); if (q.rc !== 0) throw new Error('vantage transport rc=' + q.rc); return new Response(fs.readFileSync(path.join(VDIR, 'b', q.id)), { status: q.code, headers: { 'content-type': 'application/json' } }); };
const realNow = Date.now;
const stats = (out, s) => { const t = out.map((c) => c.ts ?? c.time); const steps = [...new Set(t.slice(1).map((x, i) => x - t[i]))].sort((a, b) => a - b); return { n: t.length, steps, phase: t.length ? ((t[0] % s) + s) % s : null, first: t[0] ?? null, last: t.at(-1) ?? null }; };
(async () => {
  const rows = [];
  for (const v of Object.keys(FILES)) {
    const j = JSON.parse(fs.readFileSync(path.join(MACDIR, v + '.json'), 'utf8'));
    const scen = []; for (const p of j.pairs) scen.push(p.R, p.D); for (const s of j.extras || []) scen.push(s);
    for (const s of scen) {
      const ids = s.requests.map((_, i) => `${s.venue}__${s.tf}__${s.tag}__${i}`);
      if (!ids.length || !ids.every((id) => man[id])) { rows.push({ id: `${s.venue}/${s.tf}/${s.tag}`, vantage: LABEL, status: 'NOT_CAPTURED' }); continue; }
      queue = ids.map((id) => ({ id, ...man[id] }));
      Date.now = () => s.calledAt;
      let out = null, err = null;
      try { const m = D(`lib/adapters/${FILES[s.venue][0]}.js`); out = await new m[FILES[s.venue][1]]().getCandles(s.coin, s.tf, s.from, undefined, s.to ?? undefined); } catch (e) { err = String(e.message || e); }
      Date.now = realNow;
      const mac = stats(s.output, s.servedMs), v = stats((out || []).map((c) => ({ ts: c.time })), s.servedMs);
      const macErr = s.error ? s.error.replace(/[0-9]{6,}/g, '#') : null, vErr = err ? err.replace(/[0-9]{6,}/g, '#') : null;
      const agree = JSON.stringify(mac.steps) === JSON.stringify(v.steps) && mac.phase === v.phase && (macErr == null) === (vErr == null);
      rows.push({ id: `${s.venue}/${s.tf}/${s.tag}`, vantage: LABEL, status: agree ? 'AGREE' : 'DISAGREE', mac, [LABEL]: v, macErr, vErr, exact: mac.n === v.n && mac.first === v.first && mac.last === v.last });
    }
  }
  fs.writeFileSync(OUT, JSON.stringify(rows, null, 1));
  const c = {}; rows.forEach((r) => (c[r.status] = (c[r.status] || 0) + 1)); console.log(LABEL, JSON.stringify(c));
  rows.filter((r) => r.status !== 'AGREE').forEach((r) => console.log(' ', r.status, r.id, r.macErr || '', r.vErr || '', JSON.stringify(r.mac || {}), JSON.stringify(r[LABEL] || {})));
})();
