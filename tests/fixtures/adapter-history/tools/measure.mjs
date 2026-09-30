// Measure the sanitized fixtures with the SAME classification the suite uses (tests/harness/adapter-history-model.ts
// `measure`), running the compiled adapters with upstreamFetch replaced by the replay venue. Prints the
// measurement; with --write, writes BASELINE.json / REACH.json drafts for review (never run by the suite).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const [WT, FIX, MODE] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const h = await import(path.join(WT, 'tests/harness/adapter-history-model.ts'));
const uf = require(path.join(WT, 'dist/lib/adapters/_upstream-fetch.js'));
let venue = null;
uf.upstreamFetch = async (_cfg, req) => { if (!venue) throw new Error('no venue'); return venue.answer(req.url, req.body ?? null); };
const FILES = { ASTER: ['aster', 'AsterAdapter'], BINANCE: ['binance', 'BinanceAdapter'], BINGX: ['bingx', 'BingxAdapter'], BITGET: ['bitget', 'BitgetAdapter'], BYBIT: ['bybit', 'BybitAdapter'], GATE: ['gateio', 'GateAdapter'], HL: ['hyperliquid', 'HyperliquidAdapter'], HTX: ['htx', 'HTXAdapter'], KUCOIN: ['kucoin', 'KuCoinAdapter'], MEXC: ['mexc', 'MEXCAdapter'], OKX: ['okx', 'OKXAdapter'], PHEMEX: ['phemex', 'PhemexAdapter'], WEEX: ['weex', 'WeexAdapter'], WHITEBIT: ['whitebit', 'WhitebitAdapter'], XT: ['xt', 'XtAdapter'] };
globalThis.fetch = () => { throw new Error('gen: network forbidden'); };
const read = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const fixtures = Object.keys(FILES).map((v) => read(`${v}.json`));
const controls = fs.existsSync(path.join(FIX, 'CONTROLS.json')) ? read('CONTROLS.json').controls : [];
const unservable = fs.existsSync(path.join(FIX, 'UNSERVABLE.json')) ? read('UNSERVABLE.json').pairs : [];
const realNow = Date.now;
const m = await h.measure(fixtures, controls, unservable, async (s) => {
  const v = new h.ReplayVenue(); v.load(s); venue = v;
  Date.now = () => s.calledAt;
  let out = [], err = null, meta;
  try {
    const mod = require(path.join(WT, 'dist/lib/adapters', FILES[s.venue][0] + '.js'));
    const page = await new mod[FILES[s.venue][1]]().getCandles(s.coin, s.tf, s.from, undefined, s.to ?? undefined);
    meta = Object.getOwnPropertyDescriptor(page, 'meta')?.value;
    out = page.map((c) => ({ ts: c.time, open: c.open }));
  } catch (e) { err = String(e.message || e); }
  finally { Date.now = realNow; venue = null; }
  return { out, err, drained: v.drained(), meta };
});
console.log(JSON.stringify({ edit: m.edit, unservable: m.unservable, unclassified: m.unclassified, replayFailures: m.replayFailures }, null, 1));
if (MODE === '--write') {
  fs.writeFileSync(path.join(FIX, 'BASELINE.json'), JSON.stringify({ wave: 'OPS-ADAPTER-HISTORY-ANCHOR-W1', note: 'EDIT-class violations measured by tests/harness/adapter-history-model.ts measure(); CH1 pins them, CH2 empties this list (OAH-Q1).', entries: m.edit }, null, 1) + '\n');
  fs.writeFileSync(path.join(FIX, 'REACH.json'), JSON.stringify({ wave: 'OPS-ADAPTER-HISTORY-ANCHOR-W1', note: 'REPORT-class page facts per pair and scenario (OAH-Q1). A venue changing its reach reddens the contract suite; update consciously, never absorb.', pairs: m.reach }, null, 1) + '\n');
  console.error('wrote BASELINE.json + REACH.json');
}
