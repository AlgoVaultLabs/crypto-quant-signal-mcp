// Measure the fixtures with the SAME classification and the SAME venues the contract suite uses
// (tests/harness/adapter-history-model.ts `measure`; Bitget/OKX on the synthetic venue, every other venue on the
// captured replay), running the COMPILED adapters (dist/) with upstreamFetch replaced. Prints the measurement;
// with --write, rewrites BASELINE.json / REACH.json for review (never run by the suite).
// Usage (from the repo root, after `npm run build`):  npx tsx tests/fixtures/adapter-history/tools/measure.mts [--write]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = process.cwd();
const FIX = path.join(ROOT, 'tests/fixtures/adapter-history');
const WRITE = process.argv.includes('--write');
const require = createRequire(import.meta.url);
// tsx compiles the harness as CommonJS (the package has no "type"), so load it through require, not import.
const { measure, ReplayVenue, SYNTHETIC_VENUES } = require('../../../harness/adapter-history-model.ts');
const { SyntheticVenue, listingFromProbes } = require('../../../harness/adapter-history-synthetic.ts');
const uf = require(path.join(ROOT, 'dist/lib/adapters/_upstream-fetch.js'));
let venue: { answer(url: string, body?: string | null): unknown } | null = null;
uf.upstreamFetch = async (_cfg: unknown, req: { url: string; body?: string }) => {
  if (!venue) throw new Error('no venue');
  return venue.answer(req.url, req.body ?? null);
};
const plan = require(path.join(ROOT, 'dist/lib/adapters/_history-plan.js'));
const FILES: Record<string, [string, string]> = { ASTER: ['aster', 'AsterAdapter'], BINANCE: ['binance', 'BinanceAdapter'], BINGX: ['bingx', 'BingxAdapter'], BITGET: ['bitget', 'BitgetAdapter'], BYBIT: ['bybit', 'BybitAdapter'], GATE: ['gateio', 'GateAdapter'], HL: ['hyperliquid', 'HyperliquidAdapter'], HTX: ['htx', 'HTXAdapter'], KUCOIN: ['kucoin', 'KuCoinAdapter'], MEXC: ['mexc', 'MEXCAdapter'], OKX: ['okx', 'OKXAdapter'], PHEMEX: ['phemex', 'PhemexAdapter'], WEEX: ['weex', 'WeexAdapter'], WHITEBIT: ['whitebit', 'WhitebitAdapter'], XT: ['xt', 'XtAdapter'] };
(globalThis as { fetch: unknown }).fetch = () => { throw new Error('measure: network forbidden'); };
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const fixtures = Object.keys(FILES).map((v) => read(`${v}.json`));
const listingOf = listingFromProbes(read('MODEL-PROBES.json'));
const realNow = Date.now;
const m = await measure(fixtures, read('CONTROLS.json').controls, read('UNSERVABLE.json').pairs, async (s) => {
  const synthetic = SYNTHETIC_VENUES.has(s.venue);
  const rv = synthetic ? null : new ReplayVenue();
  if (rv) { rv.load(s); venue = rv; } else venue = new SyntheticVenue(s.venue as 'BITGET' | 'OKX', () => Date.now(), listingOf);
  Date.now = () => s.calledAt;
  let out: { ts: number; open: number }[] = [], err: string | null = null, meta: unknown;
  try {
    const mod = require(path.join(ROOT, 'dist/lib/adapters', FILES[s.venue][0] + '.js'));
    const page = await new mod[FILES[s.venue][1]]().getCandles(s.coin, s.tf, s.from, undefined, s.to ?? undefined);
    meta = plan.historyMetaOf(page);
    out = page.map((c: { time: number; open: number }) => ({ ts: c.time, open: c.open }));
  } catch (e) { err = String((e as Error).message || e); }
  finally { Date.now = realNow; venue = null; }
  return { out, err, drained: rv ? rv.drained() : true, meta, synthetic };
});
console.log(JSON.stringify({ edit: m.edit, unservable: m.unservable, unclassified: m.unclassified, replayFailures: m.replayFailures }, null, 1));
if (WRITE) {
  fs.writeFileSync(path.join(FIX, 'BASELINE.json'), JSON.stringify({ wave: 'OPS-ADAPTER-HISTORY-ANCHOR-W1', note: 'EDIT-class violations measured by tests/harness/adapter-history-model.ts measure(); CH1 pinned them, CH2 empties this list (OAH-Q1).', entries: m.edit }, null, 1) + '\n');
  fs.writeFileSync(path.join(FIX, 'REACH.json'), JSON.stringify({ wave: 'OPS-ADAPTER-HISTORY-ANCHOR-W1', note: 'REPORT-class page facts per pair and scenario (OAH-Q1). A venue changing its reach reddens the contract suite; update consciously, never absorb.', pairs: m.reach }, null, 1) + '\n');
  console.error('wrote BASELINE.json + REACH.json');
}
