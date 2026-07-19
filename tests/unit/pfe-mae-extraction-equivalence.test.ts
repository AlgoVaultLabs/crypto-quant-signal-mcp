/**
 * OPS-PFE-MAE-EXTRACTION-W1 — byte-equivalence canary for the computePFEMAE extraction.
 *
 * Before this wave, `computePFEMAE` existed as TWO module-private copies
 * (`src/scripts/backfill-outcomes.ts:72` and `src/resources/signal-performance.ts:64`) with
 * ZERO test coverage between them — `git grep computePFEMAE` returned only the two
 * definitions and their two internal call sites. The extraction therefore had no safety net
 * of any kind, which is exactly why this file exists.
 *
 * Both originals are reproduced below VERBATIM as frozen oracles (copied from
 * `origin/main` @ 055d107). Every case asserts the shared implementation is byte-identical
 * to BOTH — including the snake_case projection, since the two originals disagreed on the
 * returned key casing and one call site remapped by hand while the other passed straight
 * through.
 *
 * DO NOT "simplify" the oracles. They are a frozen record of pre-extraction behaviour; if a
 * future wave intentionally changes the evaluator (e.g. OPS-PFE-METRIC-INTEGRITY-W1 teaching
 * it to skip zero-volume bars), DELETE the affected assertions deliberately and say so in the
 * commit — do not edit the oracles to match the new behaviour, which would silently convert
 * this canary into a tautology.
 */

import { describe, it, expect } from 'vitest';
import { computePFEMAE, toSignalOutcomeUpdate, EVAL_CANDLES, TF_MS } from '../../src/lib/pfe-mae.js';
import type { Candle, SignalRecord } from '../../src/types.js';

// ─────────────────────────── FROZEN ORACLE A ───────────────────────────
// Verbatim from src/scripts/backfill-outcomes.ts:72 @ origin/main 055d107 (camelCase).
interface OracleAResult {
  outcomePrice: number; outcomeReturnPct: number; return1candle: number;
  pfePrice: number; pfeReturnPct: number; maePrice: number;
  maeReturnPct: number; pfeCandles: number;
}
function oracleA(signal: SignalRecord, candles: Candle[], evalCount: number): OracleAResult | null {
  if (candles.length === 0) return null;
  const window = [...candles].sort((a, b) => a.time - b.time).slice(0, evalCount);
  if (window.length === 0) return null;
  const entryPrice = signal.price_at_signal;
  const isBuy = signal.signal === 'BUY';
  const outcomePrice = window[window.length - 1].close;
  const outcomeReturnPct = ((outcomePrice - entryPrice) / entryPrice) * 100;
  const firstClose = window[0].close;
  const raw1c = ((firstClose - entryPrice) / entryPrice) * 100;
  const return1candle = isBuy ? raw1c : -raw1c;
  let pfePrice = entryPrice;
  let maePrice = entryPrice;
  let pfeCandles = 0;
  for (let i = 0; i < window.length; i++) {
    const c = window[i];
    if (isBuy) {
      if (c.high > pfePrice) { pfePrice = c.high; pfeCandles = i + 1; }
      if (c.low < maePrice) { maePrice = c.low; }
    } else {
      if (c.low < pfePrice) { pfePrice = c.low; pfeCandles = i + 1; }
      if (c.high > maePrice) { maePrice = c.high; }
    }
  }
  const pfeReturnPct = ((pfePrice - entryPrice) / entryPrice) * 100;
  const maeReturnPct = ((maePrice - entryPrice) / entryPrice) * 100;
  return {
    outcomePrice: parseFloat(outcomePrice.toFixed(6)),
    outcomeReturnPct: parseFloat(outcomeReturnPct.toFixed(4)),
    return1candle: parseFloat(return1candle.toFixed(4)),
    pfePrice: parseFloat(pfePrice.toFixed(6)),
    pfeReturnPct: parseFloat(pfeReturnPct.toFixed(4)),
    maePrice: parseFloat(maePrice.toFixed(6)),
    maeReturnPct: parseFloat(maeReturnPct.toFixed(4)),
    pfeCandles,
  };
}

// ─────────────────────────── FROZEN ORACLE B ───────────────────────────
// Verbatim from src/resources/signal-performance.ts:64 @ origin/main 055d107 (snake_case,
// no empty-input early return, inlined pfe/mae percentage expressions).
function oracleB(signal: SignalRecord, candles: Candle[], evalCount: number) {
  const window = [...candles].sort((a, b) => a.time - b.time).slice(0, evalCount);
  if (window.length === 0) return null;
  const entry = signal.price_at_signal;
  const isBuy = signal.signal === 'BUY';
  const outcomePrice = window[window.length - 1].close;
  const outcomeReturnPct = ((outcomePrice - entry) / entry) * 100;
  const raw1c = ((window[0].close - entry) / entry) * 100;
  const return1candle = isBuy ? raw1c : -raw1c;
  let pfePrice = entry;
  let maePrice = entry;
  let pfeCandles = 0;
  for (let i = 0; i < window.length; i++) {
    const c = window[i];
    if (isBuy) {
      if (c.high > pfePrice) { pfePrice = c.high; pfeCandles = i + 1; }
      if (c.low < maePrice) { maePrice = c.low; }
    } else {
      if (c.low < pfePrice) { pfePrice = c.low; pfeCandles = i + 1; }
      if (c.high > maePrice) { maePrice = c.high; }
    }
  }
  return {
    outcome_price: parseFloat(outcomePrice.toFixed(6)),
    outcome_return_pct: parseFloat(outcomeReturnPct.toFixed(4)),
    return_1candle: parseFloat(return1candle.toFixed(4)),
    pfe_price: parseFloat(pfePrice.toFixed(6)),
    pfe_return_pct: parseFloat(((pfePrice - entry) / entry * 100).toFixed(4)),
    mae_price: parseFloat(maePrice.toFixed(6)),
    mae_return_pct: parseFloat(((maePrice - entry) / entry * 100).toFixed(4)),
    pfe_candles: pfeCandles,
  };
}

// ─────────────────────────── fixtures ───────────────────────────
function sig(signal: 'BUY' | 'SELL', price: number): SignalRecord {
  return { coin: 'TEST', signal, confidence: 60, timeframe: '5m', price_at_signal: price } as SignalRecord;
}
function c(time: number, open: number, high: number, low: number, close: number, volume = 100): Candle {
  return { time, open, high, low, close, volume };
}

const CASES: Array<{ name: string; s: SignalRecord; candles: Candle[]; evalCount: number }> = [
  {
    name: 'BUY, ordinary favourable run',
    s: sig('BUY', 100),
    candles: [c(1, 100, 101, 99.5, 100.5), c(2, 100.5, 103, 100, 102), c(3, 102, 102.5, 101, 101.5)],
    evalCount: 12,
  },
  {
    name: 'SELL, ordinary favourable run (favourable = down)',
    s: sig('SELL', 100),
    candles: [c(1, 100, 100.5, 98, 99), c(2, 99, 99.5, 96.5, 97), c(3, 97, 98, 96.8, 97.5)],
    evalCount: 12,
  },
  {
    name: 'BUY, never favourable — the S1 genuine-loss shape (pfe stays 0, mae moves)',
    s: sig('BUY', 100),
    candles: [c(1, 100, 100, 98, 99), c(2, 99, 99.5, 97, 98)],
    evalCount: 12,
  },
  {
    name: 'FROZEN BOOK — zero-volume synthetic flat bars, the S2 shape (pfe = mae = 0)',
    s: sig('SELL', 694.84),
    candles: [
      c(1, 694.84, 694.84, 694.84, 694.84, 0),
      c(2, 694.84, 694.84, 694.84, 694.84, 0),
      c(3, 694.84, 694.84, 694.84, 694.84, 0),
    ],
    evalCount: 12,
  },
  {
    name: 'PARTIAL freeze — some real bars, some zero-volume (currently scored as a win)',
    s: sig('BUY', 50),
    candles: [c(1, 50, 50, 50, 50, 0), c(2, 50, 51.2, 49.8, 51), c(3, 51, 51, 51, 51, 0)],
    evalCount: 12,
  },
  {
    name: 'NEWEST-FIRST venue payload — the EdgeX kline-order class (sort must fix it)',
    s: sig('BUY', 100),
    candles: [c(9, 102, 104, 101, 103), c(5, 100.5, 101, 100, 100.8), c(1, 100, 100.4, 99.2, 100.2)],
    evalCount: 12,
  },
  {
    name: 'window TRUNCATION — more candles than evalCount',
    s: sig('BUY', 100),
    candles: Array.from({ length: 20 }, (_, i) => c(i + 1, 100, 100 + i, 99, 100 + i * 0.5)),
    evalCount: 6,
  },
  {
    name: 'SUB-PENNY asset — toFixed(6) rounding boundary',
    s: sig('BUY', 0.00003845),
    candles: [c(1, 0.00003845, 0.000039, 0.0000381, 0.00003862), c(2, 0.00003862, 0.0000395, 0.00003855, 0.0000390)],
    evalCount: 12,
  },
  {
    name: 'single candle',
    s: sig('SELL', 200),
    candles: [c(1, 200, 201, 197, 198)],
    evalCount: 12,
  },
  {
    name: 'evalCount larger than the candle count',
    s: sig('BUY', 10),
    candles: [c(1, 10, 10.5, 9.9, 10.2), c(2, 10.2, 10.3, 10.1, 10.25)],
    evalCount: 12,
  },
  {
    name: 'exactly-at-entry highs and lows (strict > / < comparators must not fire)',
    s: sig('BUY', 100),
    candles: [c(1, 100, 100, 100, 100), c(2, 100, 100, 100, 100)],
    evalCount: 12,
  },
];

describe('OPS-PFE-MAE-EXTRACTION-W1 — shared computePFEMAE is byte-identical to both frozen oracles', () => {
  for (const tc of CASES) {
    it(`matches ORACLE A (backfill-outcomes) — ${tc.name}`, () => {
      const shared = computePFEMAE(tc.s, tc.candles, tc.evalCount);
      const a = oracleA(tc.s, tc.candles, tc.evalCount);
      expect(shared).toEqual(a);
    });

    it(`matches ORACLE B (signal-performance) through the snake_case projection — ${tc.name}`, () => {
      const shared = computePFEMAE(tc.s, tc.candles, tc.evalCount);
      const b = oracleB(tc.s, tc.candles, tc.evalCount);
      expect(shared === null).toBe(b === null);
      if (shared && b) expect(toSignalOutcomeUpdate(shared)).toEqual(b);
    });
  }

  it('returns null on empty input, matching both call sites\' skip-the-UPDATE behaviour', () => {
    const s = sig('BUY', 100);
    expect(computePFEMAE(s, [], 12)).toBeNull();
    expect(oracleA(s, [], 12)).toBeNull();
    expect(oracleB(s, [], 12)).toBeNull();
  });

  it('returns null when evalCount is 0 (empty window after slicing)', () => {
    const s = sig('BUY', 100);
    const candles = [c(1, 100, 101, 99, 100.5)];
    expect(computePFEMAE(s, candles, 0)).toBeNull();
    expect(oracleA(s, candles, 0)).toBeNull();
    expect(oracleB(s, candles, 0)).toBeNull();
  });

  it('does not mutate the caller\'s candle array (sorts a copy)', () => {
    const candles = [c(9, 1, 2, 0.5, 1.5), c(1, 1, 1.2, 0.9, 1.1)];
    const before = candles.map(x => x.time);
    computePFEMAE(sig('BUY', 1), candles, 12);
    expect(candles.map(x => x.time)).toEqual(before);
  });
});

describe('OPS-PFE-MAE-EXTRACTION-W1 — the constants moved verbatim', () => {
  it('EVAL_CANDLES matches the pre-extraction table exactly', () => {
    expect(EVAL_CANDLES).toEqual({
      '1m': 12, '3m': 12, '5m': 12, '15m': 12,
      '30m': 8, '1h': 8, '2h': 6, '4h': 6,
      '8h': 4, '12h': 4, '1d': 3,
    });
  });

  it('TF_MS matches the pre-extraction table exactly', () => {
    expect(TF_MS).toEqual({
      '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000,
      '30m': 1_800_000, '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000,
      '8h': 28_800_000, '12h': 43_200_000, '1d': 86_400_000,
    });
  });

  it('every EVAL_CANDLES timeframe has a TF_MS entry and vice versa', () => {
    expect(Object.keys(EVAL_CANDLES).sort()).toEqual(Object.keys(TF_MS).sort());
  });
});

describe('OPS-PFE-MAE-EXTRACTION-W1 — the one-sidedness that makes PFE WR a coverage rate', () => {
  it('PFE can never move adversely for a BUY, whatever the candles do', () => {
    const r = computePFEMAE(sig('BUY', 100), [c(1, 100, 100, 80, 85), c(2, 85, 86, 70, 75)], 12);
    expect(r!.pfeReturnPct).toBe(0);          // never negative
    expect(r!.maeReturnPct).toBeLessThan(0);  // the adverse move lands in MAE
  });

  it('PFE can never move adversely for a SELL, whatever the candles do', () => {
    const r = computePFEMAE(sig('SELL', 100), [c(1, 100, 120, 100, 115), c(2, 115, 130, 114, 128)], 12);
    expect(r!.pfeReturnPct).toBe(0);             // never positive
    expect(r!.maeReturnPct).toBeGreaterThan(0);  // the adverse move lands in MAE
  });

  it('a frozen book is indistinguishable from a flat market by pfe alone — mae is the discriminator', () => {
    const frozen = computePFEMAE(sig('SELL', 694.84), [
      c(1, 694.84, 694.84, 694.84, 694.84, 0),
      c(2, 694.84, 694.84, 694.84, 694.84, 0),
    ], 12)!;
    const genuineLoss = computePFEMAE(sig('SELL', 100), [c(1, 100, 103, 100, 102)], 12)!;

    expect(frozen.pfeReturnPct).toBe(0);
    expect(genuineLoss.pfeReturnPct).toBe(0);      // same pfe...
    expect(frozen.maeReturnPct).toBe(0);           // ...but mae separates them
    expect(genuineLoss.maeReturnPct).toBeGreaterThan(0);
  });
});
