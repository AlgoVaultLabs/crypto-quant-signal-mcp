#!/usr/bin/env npx tsx
/**
 * verdict-mix-r1.ts — SIGNAL-VERDICT-MIX-REPLAY-W1 R1, the BLOCKING fidelity gate.
 *
 * Flag-ON has never executed in production, so every flag-ON figure in this wave is
 * replay-derived. That makes the replay itself the instrument, and an unvalidated instrument
 * produces numbers that look like measurements and are not. R1 validates it before R2-R4 run.
 *
 * ── THE TEST, AND WHY IT NEEDS NO FUNDING RECONSTRUCTION ─────────────────────────────────────
 * The scorer splits into terms this replay reconstructs EXACTLY from candles — rsi, ema, volume,
 * 60% of the weight — and terms it cannot: funding (±20 raw), oi (±9 raw), and `deriveVerdict`'s
 * post-weight adjustments. For each bar we compute the FEASIBLE INTERVAL of |rawScore| across
 * every possible value of the uncertain terms, and ask whether the STORED |rawScore| falls in it.
 *
 * A stored value OUTSIDE that interval cannot be produced by any funding or OI reading, so it can
 * only mean the candle-derived terms are computed differently from production. That is exactly
 * the failure R1 exists to catch, and the test is immune to the one input we cannot rebuild.
 *
 * ── WHY NOT VERDICT AGREEMENT ────────────────────────────────────────────────────────────────
 * The stored stream is 98.3% HOLD. A verdict-match metric would score ~98% by construction while
 * proving nothing — a coarse metric that passes by base rate is the "confident number for the
 * wrong quantity" trap. Verdict agreement IS reported below, with that caveat attached, but the
 * GATE is the interval test.
 *
 * TOLERANCE, STATED BEFORE RUNNING: >= 99.0% of rows inside the feasible interval.
 * Basis: the interval is a hard bound from the ladder's own extremes, so an inside-rate near 100%
 * is the expected result of a faithful scorer; the 1% allowance covers bar-boundary races where
 * the replay's closed window differs from production's by one bar. Below 99.0% => HALT.
 *
 * Read-only: reads pre-extracted CSVs, touches no database, writes no repo file.
 */
import { readFileSync } from 'node:fs';
import {
  parseShadowCsv, storedRawBand, achievableAbsRaw, certainPart, windowAt, loadCandlesCsv,
} from './verdict-mix-replay.js';
import { computeIndicatorScores } from '../tools/get-trade-call.js';

const DATA = process.env.R1_DATA ?? '/tmp/r1data';
const TOLERANCE = 0.99;
const MAX_RAW = 89;
const IV_MS: Record<string, number> = { '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };
/** `R1_SHIFT=<n>` replays a window n bars in the past — the deliberate-break proof. 0 = real run. */
const SHIFT = Number(process.env.R1_SHIFT ?? 0);

function main(): number {
  const shadow = parseShadowCsv(readFileSync(`${DATA}/shadow.csv`, 'utf8'));
  const candles = loadCandlesCsv(`${DATA}/klines.csv`);

  // ── SELF-CHECK: the restated ladder extremes must match the LIVE ladder ──────────────────
  // The feasible interval is only a valid bound if the rungs it spans are the real ones. Probe
  // the live scorer at ladder extremes rather than trusting the restatement.
  const probe = (rsi: number[]) => {
    const c = rsi.map((p, i) => ({ time: i * 3_600_000, open: p, high: p * 1.001, low: p * 0.999, close: p, volume: 1 }));
    return computeIndicatorScores({ candles: c, fundingRateAnnualized: 0, priceChange: 0, openInterest: 1 });
  };
  const rising = probe(Array.from({ length: 120 }, (_, i) => 100 * 1.01 ** i));
  const falling = probe(Array.from({ length: 120 }, (_, i) => 100 * 0.99 ** i));
  if (Math.abs(rising.rsiScore) !== 100 || Math.abs(falling.rsiScore) !== 100) {
    console.log(`R1 SELF-CHECK FAILED: ladder extremes are ${rising.rsiScore}/${falling.rsiScore}, expected ±100`);
    console.log('R1_VERDICT=INDETERMINATE');
    return 3;
  }
  console.log(`self-check: live ladder extremes ±${Math.abs(rising.rsiScore)} — matches the restated bound`);

  let considered = 0, inside = 0, outside = 0, skipped = 0;
  let verdictMatch = 0, verdictTotal = 0;
  const holdN = shadow.filter((r) => r.call === 'HOLD').length;
  const outsideExamples: string[] = [];
  const widths: number[] = [];
  const bySymbol = new Map<string, { n: number; inside: number }>();

  for (const row of shadow) {
    const key = `${row.symbol}|${row.timeframe}`;
    const all = candles.get(key);
    const iv = IV_MS[row.timeframe];
    if (!all || !iv) { skipped++; continue; }
    // MUST-FAIL MODE: shift the window back by `SHIFT` bars. A gate that still reports ~100%
    // under a deliberately wrong window is vacuous, and the previous draft of this file was.
    const win = windowAt(all, row.ts - SHIFT * iv, iv);
    if (win.length < 30) { skipped++; continue; }

    // Funding and priceChange are deliberately 0: both live in the UNCERTAIN set, and the
    // feasible interval already spans every value they could take.
    const off = computeIndicatorScores({
      candles: win, fundingRateAnnualized: 0, priceChange: 0, openInterest: 1, trendMode: false,
    });
    const feas = achievableAbsRaw(off);
    const stored = storedRawBand(row.conf);
    const overlaps = stored.lo <= feas.hi && feas.lo <= stored.hi;

    considered++;
    if (overlaps) inside++; else {
      outside++;
      if (outsideExamples.length < 6) {
        outsideExamples.push(
          `${row.symbol}/${row.timeframe} ts=${row.ts} conf=${row.conf} stored|raw|∈[${stored.lo.toFixed(1)},${stored.hi === Infinity ? '∞' : stored.hi.toFixed(1)}] feasible=[${feas.lo.toFixed(1)},${feas.hi.toFixed(1)}] certain=${certainPart(off).toFixed(1)}`,
        );
      }
    }
    widths.push(feas.hi - feas.lo);
    const b = bySymbol.get(row.symbol) ?? { n: 0, inside: 0 };
    b.n++; if (overlaps) b.inside++; bySymbol.set(row.symbol, b);

    // Verdict agreement, reported but NOT gated on — see the header.
    verdictTotal++;
    const wouldHold = feas.lo <= 55 && row.call === 'HOLD';
    if (wouldHold || (row.call !== 'HOLD' && feas.hi > 40)) verdictMatch++;
  }

  const pct = considered ? inside / considered : 0;
  console.log('');
  if (SHIFT) console.log(`⚠️  MUST-FAIL MODE: window shifted back ${SHIFT} bars — a PASS here means the gate is vacuous`);
  console.log(`corpus            : ${shadow.length} shadow rows (${holdN} HOLD = ${(100 * holdN / shadow.length).toFixed(1)}%)`);
  console.log(`considered        : ${considered}   skipped (no window): ${skipped}`);
  console.log(`INSIDE interval   : ${inside}  (${(100 * pct).toFixed(2)}%)`);
  console.log(`OUTSIDE interval  : ${outside}`);
  const mw = widths.length ? widths.reduce((a, b) => a + b, 0) / widths.length : 0;
  console.log(`achievable width  : mean ${mw.toFixed(1)} raw pts of a possible ${MAX_RAW}  — the tighter this is, the more the gate proves`);
  for (const [sym, b] of bySymbol) {
    console.log(`  ${sym.padEnd(4)} ${b.inside}/${b.n} = ${(100 * b.inside / b.n).toFixed(2)}%`);
  }
  console.log(`verdict-consistent: ${verdictMatch}/${verdictTotal} = ${(100 * verdictMatch / Math.max(verdictTotal, 1)).toFixed(2)}%  ⚠️ base-rate inflated (${(100 * holdN / shadow.length).toFixed(1)}% HOLD) — reported, NOT the gate`);
  if (outsideExamples.length) {
    console.log('\noutside-interval examples:');
    for (const e of outsideExamples) console.log(`  ${e}`);
  }
  console.log('');
  console.log(`tolerance (pre-stated): >= ${(100 * TOLERANCE).toFixed(1)}%`);
  if (pct >= TOLERANCE) { console.log('R1_VERDICT=PASS'); return 0; }
  console.log('R1_VERDICT=FAIL  — harness fidelity unproven; R2-R4 MUST NOT RUN');
  return 1;
}

// GUARDED with the `process.argv[1]` idiom — one of the four spellings
// `scripts/check-entrypoint-guards.mjs` accepts — rather than `require.main === module`.
//
// Not a style choice, and the two nearby gates are why. The entrypoint gate is fail-closed and
// demands SOME guard, because anything importing this file would otherwise RUN it. But
// `script-exit-lifecycle-canary` adds: a file guarded with `require.main === module` MUST
// terminate through `runScript()`. That wrapper exits 0 on return and 1 on throw, so it would
// map this gate's THREE verdicts (0 PASS / 1 FAIL / 3 INDETERMINATE) onto two — and a FAILING
// R1 would exit 0, which is precisely the fail-open a verdict-token gate exists to prevent.
// The argv1 idiom satisfies the entrypoint gate, leaves the exit contract intact, and keeps the
// file import-safe. This script opens no pool, so the zombie class is unreachable regardless.
if (process.argv[1]?.endsWith('verdict-mix-r1.ts') || process.argv[1]?.endsWith('verdict-mix-r1.js')) {
  process.exit(main());
}
