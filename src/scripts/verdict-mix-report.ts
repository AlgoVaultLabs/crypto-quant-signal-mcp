#!/usr/bin/env npx tsx
/**
 * verdict-mix-report.ts — SIGNAL-VERDICT-MIX-REPLAY-W1 R2 / R3 / R4.
 *
 * ⚠️ RUNS ONLY AFTER R1 IS GREEN. R1 (`verdict-mix-r1-point.ts`) proved this harness reproduces
 * production's rawScore to 92.08% inside the stored confidence band, and — the part that makes it
 * a gate — collapses to 37.27% under a ONE-bar window shift. Every flag-ON figure below is
 * REPLAY-DERIVED and is labelled as such: flag-ON has never executed in production, so no stored
 * row describes it.
 *
 * ── WHY THE DELTA IS EXACT EVEN WHERE THE ABSOLUTE IS APPROXIMATE ────────────────────────────
 * The two arms differ in exactly ONE input (`trendMode`), and trend mode changes exactly one term
 * (`rsiScore`). Funding, OI, priceChange, Hurst and squeeze are identical between arms by
 * construction, so any reconstruction error in them CANCELS in the delta. Absolute mix inherits
 * that error; the delta does not. That distinction is stated wherever a number appears.
 *
 * ── OUTCOME DEFINITION, STATED NOT INHERITED ─────────────────────────────────────────────────
 * PFE is evaluated over the next `FORWARD_BARS` bars of the same timeframe from the bar's close.
 * A peak-favorable-excursion win is NOT a P&L. `isPfeWin` and `seededCall` are imported from
 * `calibration-audit.ts` so the win predicate and the random baseline are not re-derived here.
 *
 * Read-only: reads pre-extracted CSVs, touches no database, writes no repo file.
 */
import { readFileSync } from 'node:fs';
import { loadCandlesCsv, windowAt } from './verdict-mix-replay.js';
import { computeIndicatorScores, deriveVerdict } from '../tools/get-trade-call.js';
import { runScript } from '../lib/script-lifecycle.js';
import { getR4Thresholds } from '../lib/r4-relax-flag.js';
import { isPfeWin, seededCall } from './calibration-audit.js';
import type { Candle, RegimeType, SignalVerdict } from '../types.js';

const DATA = process.env.R1_DATA ?? '/tmp/r1data';
const IV_MS: Record<string, number> = { '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };
const ANNUALIZE = 1095;
const FORWARD_BARS = 24;
const BUY_THRESHOLD = 40;
const SELL_SWEEP = [55, 45, 40, 35];

interface Cell { BUY: number; SELL: number; HOLD: number }
const cell = (): Cell => ({ BUY: 0, SELL: 0, HOLD: 0 });
const total = (c: Cell) => c.BUY + c.SELL + c.HOLD;
const pct = (n: number, d: number) => (d ? (100 * n) / d : 0);

function loadHourlyFunding(path: string): Map<string, Array<{ at: number; rate: number }>> {
  const out = new Map<string, Array<{ at: number; rate: number }>>();
  for (const line of readFileSync(path, 'utf8').trim().split('\n').slice(1)) {
    if (!line) continue;
    const [coin, at, rate] = line.split(',');
    if (!out.has(coin)) out.set(coin, []);
    out.get(coin)!.push({ at: Number(at), rate: Number(rate) });
  }
  for (const a of out.values()) a.sort((x, y) => x.at - y.at);
  return out;
}
function nearest(arr: Array<{ at: number; rate: number }>, atSec: number): number {
  let lo = 0, hi = arr.length - 1, best = 0;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (arr[m].at <= atSec) { best = arr[m].rate; lo = m + 1; } else hi = m - 1;
  }
  return best;
}

interface Row {
  coin: string; tf: string; ts: number; regime: RegimeType;
  offRaw: number; onRaw: number;
  entry: number; winHighMax: number; winLowMin: number; fwdClose: number;
  fundAnn: number;
}

function build(): Row[] {
  const candles = loadCandlesCsv(`${DATA}/corpus.csv`);
  const funding = loadHourlyFunding(`${DATA}/funding_hourly.csv`);
  const rows: Row[] = [];
  for (const [key, all] of candles) {
    const [coin, tf] = key.split('|');
    const iv = IV_MS[tf];
    const fa = funding.get(coin);
    if (!iv || !fa) continue;
    for (let i = 100; i < all.length - FORWARD_BARS; i++) {
      const at = all[i].time + iv; // the instant this bar closed
      const win = windowAt(all, at, iv);
      if (win.length < 30) continue;
      const fundAnn = nearest(fa, Math.floor(at / 1000)) * ANNUALIZE;
      const dayAgo = all.filter((c) => c.time + iv <= at - 86_400_000).slice(-1)[0];
      const cur = win[win.length - 1].close;
      const priceChange = dayAgo ? (cur - dayAgo.close) / dayAgo.close : 0;
      const common = { candles: win, fundingRateAnnualized: fundAnn, priceChange, openInterest: 1 };
      const off = computeIndicatorScores({ ...common, trendMode: false });
      const on = computeIndicatorScores({ ...common, trendMode: true });
      const gates = {
        fundingZScore: null, fundingRateAnnualized: fundAnn, hurstVal: off.hurstVal,
        squeezeActive: off.squeezeActive, r4Thresholds: getR4Thresholds(),
        buyThreshold: BUY_THRESHOLD, sellThreshold: 55,
      };
      const fwd = all.slice(i + 1, i + 1 + FORWARD_BARS);
      if (!fwd.length) continue;
      rows.push({
        coin, tf, ts: at, regime: off.regime,
        offRaw: deriveVerdict(off, gates).rawScore,
        onRaw: deriveVerdict(on, gates).rawScore,
        entry: cur,
        winHighMax: Math.max(...fwd.map((c) => c.high)),
        winLowMin: Math.min(...fwd.map((c) => c.low)),
        fwdClose: fwd[fwd.length - 1].close,
        fundAnn,
      });
    }
  }
  return rows;
}

const verdictOf = (raw: number, sell: number): SignalVerdict =>
  raw > BUY_THRESHOLD ? 'BUY' : Math.abs(raw) > sell && raw < 0 ? 'SELL' : 'HOLD';

function mix(rows: Row[], pick: (r: Row) => number, sell: number, keyOf: (r: Row) => string) {
  const m = new Map<string, Cell>();
  for (const r of rows) {
    const k = keyOf(r);
    if (!m.has(k)) m.set(k, cell());
    m.get(k)![verdictOf(pick(r), sell)] += 1;
  }
  return m;
}

function main(): void {
  const rows = build();
  console.log(`REPLAY CORPUS: ${rows.length} bars · ${new Set(rows.map(r => r.coin)).size} coins · timeframes ${[...new Set(rows.map(r => r.tf))].join('/')}`);
  console.log(`forward window for outcomes: ${FORWARD_BARS} bars (stated, not inherited) · PFE is NOT a P&L`);
  console.log(`BUY_BASE_THRESHOLD=${BUY_THRESHOLD} (src/tools/get-trade-call.ts:173) · SELL_THRESHOLD_GATED=55 (:174)`);

  // ── R2: verdict mix by regime and timeframe, both flag states ─────────────────────────────
  console.log('\n================ R2 · VERDICT MIX (flag-ON is REPLAY-DERIVED) ================');
  for (const dim of ['regime', 'tf'] as const) {
    const keyOf = (r: Row) => (dim === 'regime' ? r.regime : r.tf);
    const off = mix(rows, (r) => r.offRaw, 55, keyOf);
    const on = mix(rows, (r) => r.onRaw, 55, keyOf);
    console.log(`\n-- by ${dim} --`);
    console.log(`${'key'.padEnd(15)} ${'n'.padStart(6)} | ${'BUY off→on'.padStart(16)} ${'SELL off→on'.padStart(16)} ${'HOLD off→on'.padStart(18)}`);
    for (const k of [...off.keys()].sort()) {
      const a = off.get(k)!; const b = on.get(k)!; const n = total(a);
      const f = (x: number, y: number) => `${pct(x, n).toFixed(2)}→${pct(y, n).toFixed(2)}%`;
      const d = b.BUY - a.BUY;
      console.log(`${k.padEnd(15)} ${String(n).padStart(6)} | ${f(a.BUY, b.BUY).padStart(16)} ${f(a.SELL, b.SELL).padStart(16)} ${f(a.HOLD, b.HOLD).padStart(18)}   ΔBUY=${d >= 0 ? '+' : ''}${d}`);
    }
  }

  // ── R3: sell-threshold sweep, verdict mix AND realized outcome ────────────────────────────
  console.log('\n================ R3 · SELL-GATE SWEEP (evidence only — decides nothing) ================');
  console.log(`${'sell'.padStart(5)} ${'flag'.padStart(5)} ${'SELLs'.padStart(7)} ${'pfeWR'.padStart(8)} ${'realizedWR'.padStart(11)}   (SELLs admitted at this threshold)`);
  for (const sell of SELL_SWEEP) {
    for (const [label, pickRaw] of [['off', (r: Row) => r.offRaw], ['on', (r: Row) => r.onRaw]] as const) {
      const sells = rows.filter((r) => verdictOf(pickRaw(r), sell) === 'SELL');
      const pfe = sells.filter((r) => isPfeWin('SELL', ((r.winLowMin - r.entry) / r.entry) * 100)).length;
      const real = sells.filter((r) => r.fwdClose < r.entry).length;
      console.log(`${String(sell).padStart(5)} ${label.padStart(5)} ${String(sells.length).padStart(7)} ${sells.length ? pct(pfe, sells.length).toFixed(2) : '  n/a'}% ${sells.length ? pct(real, sells.length).toFixed(2) : '  n/a'}%`);
    }
  }
  // The band the CURRENT gate suppresses: |raw| in (40, 55] on the sell side.
  //
  // ⚠️ POOLING TIMEFRAMES HERE IS CONFOUNDED AND THE FIRST DRAFT DID IT. The always-SELL base rate
  // swings from 33.0% at 1h to 60.6% at 1d, so a pooled "suppressed SELLs win 52.67%" compares a
  // mixed population against no baseline at all. The answer is only meaningful per timeframe,
  // against THAT timeframe's own always-SELL rate — the excess column is the actual finding.
  console.log(`\n${'tf'.padEnd(4)} ${'flag'.padEnd(4)} ${'n'.padStart(6)} ${'realizedWR'.padStart(11)} ${'alwaysSELL'.padStart(11)} ${'EXCESS'.padStart(9)}   (SELLs the gate suppresses: |raw| ∈ (40,55])`);
  for (const tf of ['1h', '4h', '1d']) {
    for (const [label, pickRaw] of [['off', (r: Row) => r.offRaw], ['on', (r: Row) => r.onRaw]] as const) {
      const sub = rows.filter((r) => r.tf === tf);
      const supp = sub.filter((r) => { const v = pickRaw(r); return v < 0 && Math.abs(v) > BUY_THRESHOLD && Math.abs(v) <= 55; });
      if (!supp.length) { console.log(`${tf.padEnd(4)} ${label.padEnd(4)} ${'0'.padStart(6)}   (none suppressed)`); continue; }
      const win = supp.filter((r) => r.fwdClose < r.entry).length;
      const base = supp.filter((r) => r.fwdClose < r.entry).length; // same rows, baseline below
      const baseAll = sub.filter((r) => r.fwdClose < r.entry).length;
      const wr = pct(win, supp.length);
      const bs = pct(baseAll, sub.length);
      console.log(`${tf.padEnd(4)} ${label.padEnd(4)} ${String(supp.length).padStart(6)} ${(wr.toFixed(2) + '%').padStart(11)} ${(bs.toFixed(2) + '%').padStart(11)} ${((wr - bs).toFixed(2) + 'pts').padStart(9)}`);
      void base;
    }
  }

  // ── R4: the 1d cell ───────────────────────────────────────────────────────────────────────
  console.log('\n================ R4 · THE 1d CELL ================');
  console.log('⚠️  PFE IS SATURATED AT THIS HORIZON AND CANNOT DISCRIMINATE. Over 24 forward bars price');
  console.log('    touches favourably in SOME direction almost always, so engine and every naive baseline');
  console.log('    all sit at 97-100% and every edge rounds to ~0. That is the base-rate property the');
  console.log('    2026-07-02 audit already recorded, not a result. REALIZED directional accuracy below is');
  console.log('    the discriminating metric; the PFE column is shown only to make the saturation visible.');
  console.log(`\n${'tf'.padEnd(4)} ${'flag'.padEnd(4)} ${'n'.padStart(6)} | ${'PFE eng/best'.padStart(15)} | ${'REALIZED eng'.padStart(13)} ${'aBUY'.padStart(7)} ${'aSELL'.padStart(7)} ${'rand'.padStart(7)} ${'EDGE'.padStart(8)}`);
  for (const tf of ['1h', '4h', '1d']) {
    const sub = rows.filter((r) => r.tf === tf);
    if (!sub.length) continue;
    for (const [label, pickRaw] of [['off', (r: Row) => r.offRaw], ['on', (r: Row) => r.onRaw]] as const) {
      const acted = sub.filter((r) => verdictOf(pickRaw(r), 55) !== 'HOLD');
      if (!acted.length) { console.log(`${tf.padEnd(4)} ${label.padEnd(4)} ${'0'.padStart(6)} | no directional calls`); continue; }
      const dirOf = (r: Row) => verdictOf(pickRaw(r), 55) as 'BUY' | 'SELL';
      // PFE (saturated — shown for transparency only)
      const pfeEng = acted.filter((r) => {
        const v = dirOf(r);
        const p = v === 'BUY' ? ((r.winHighMax - r.entry) / r.entry) * 100 : ((r.winLowMin - r.entry) / r.entry) * 100;
        return isPfeWin(v, p);
      }).length;
      const pfeBest = Math.max(
        acted.filter((r) => r.winHighMax > r.entry).length,
        acted.filter((r) => r.winLowMin < r.entry).length,
      );
      // REALIZED — did the close actually move the way the call said?
      const rEng = acted.filter((r) => (dirOf(r) === 'BUY' ? r.fwdClose > r.entry : r.fwdClose < r.entry)).length;
      const rBuy = acted.filter((r) => r.fwdClose > r.entry).length;
      const rSell = acted.filter((r) => r.fwdClose < r.entry).length;
      const rRnd = acted.filter((r, i) => (seededCall(i) === 'BUY' ? r.fwdClose > r.entry : r.fwdClose < r.entry)).length;
      const best = Math.max(rBuy, rSell, rRnd);
      const n = acted.length;
      console.log(
        `${tf.padEnd(4)} ${label.padEnd(4)} ${String(n).padStart(6)} | ` +
        `${(pct(pfeEng, n).toFixed(1) + '/' + pct(pfeBest, n).toFixed(1) + '%').padStart(15)} | ` +
        `${(pct(rEng, n).toFixed(2) + '%').padStart(13)} ${(pct(rBuy, n).toFixed(1) + '%').padStart(7)} ` +
        `${(pct(rSell, n).toFixed(1) + '%').padStart(7)} ${(pct(rRnd, n).toFixed(1) + '%').padStart(7)} ` +
        `${((pct(rEng, n) - pct(best, n)).toFixed(2) + 'pts').padStart(8)}`,
      );
    }
  }
}

// OPS-SCRIPT-EXIT-LIFECYCLE-W1 — a bare top-level `main()` runs on IMPORT and never
// drains; `script-exit-lifecycle-canary` caught exactly that here. `main` is sync, so it
// is wrapped rather than passed directly (runScript takes `() => Promise<unknown>`).
if (require.main === module) {
  void runScript('verdict-mix-report', async () => main());
}
