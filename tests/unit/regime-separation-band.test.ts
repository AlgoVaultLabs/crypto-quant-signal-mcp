/**
 * SIGNAL-TREND-BLINDNESS-FIX-W1 CH2 — the separation-band label and its ledger contract.
 *
 * EVERY assertion runs on a PINNED FIXTURE. None touches a live call, and that is a hard rule for
 * this chapter rather than a style preference: under K-bar hysteresis a live label is a function of
 * WALL CLOCK, so a live gate can be turned green by waiting. It bit twice inside one session —
 * BTC/BINANCE/4h read `sep +4.326% / band 0.494% / side +1` with an 11-bar run at Plan Mode, and
 * `sep −0.391% / band 0.209% / side −1` hours later. A gate that flips on the tape measures the
 * market, not the code.
 *
 * SPAWN BUDGET: none required. `scripts/check-test-budget.mjs` scopes to blocks that spawn a
 * process; nothing here does, so declaring a timeout would budget for something that cannot happen.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyRegimeLabel, REGIME_SEPARATION_ATR_MULT, REGIME_CONFIRM_BARS,
} from '../../src/tools/get-trade-call.js';
import { buildFactorLedger, type FactorLedgerInput } from '../../src/lib/verdict-factors.js';
import { ema, atr } from '../../src/lib/indicators.js';
import { FUNDING_Z_WINDOW_DAYS } from '../../src/lib/funding-window.js';
import type { Candle } from '../../src/types.js';

const K = REGIME_CONFIRM_BARS;
/** `WEIGHTS` is module-private to the scorer and `verdict-factors` takes it INJECTED ("this module
 *  never holds a coefficient"), so a ledger fixture restates it — the same shape
 *  tests/unit/verdict-factors-strength.test.ts uses. */
const WEIGHTS = { rsi: 0.30, ema: 0.10, funding: 0.25, oi: 0.15, volume: 0.20 };

/** Flat closes with a fixed high/low envelope, so ATR is non-zero and `sep` is exactly 0. */
function flat(n: number, px = 100): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    time: i * 3_600_000, open: px, high: px * 1.005, low: px * 0.995, close: px, volume: 1,
  }));
}
/** `n` flat bars then `rise` bars advancing `pct` per bar — a clean, deterministic breakout. */
function breakout(n: number, rise: number, pct = 0.01, px = 100): Candle[] {
  const out = flat(n, px);
  let p = px;
  for (let i = 0; i < rise; i++) {
    p = p * (1 + pct);
    out.push({ time: (n + i) * 3_600_000, open: p, high: p * 1.005, low: p * 0.995, close: p, volume: 1 });
  }
  return out;
}
/** The side series the classifier derives — recomputed here only to CONSTRUCT and VERIFY fixtures. */
function sidesOf(c: Candle[]): number[] {
  const closes = c.map(x => x.close);
  const f = ema(closes, 9)!; const s = ema(closes, 21)!;
  const a = atr(c.map(x => x.high), c.map(x => x.low), closes, 14)!;
  const band = REGIME_SEPARATION_ATR_MULT * (a / closes[closes.length - 1]);
  return f.map((_, k) => {
    const A = f[k]; const B = s[k];
    if (isNaN(A) || isNaN(B) || B === 0) return 0;
    const sep = (A - B) / B;
    return Math.abs(sep) < band ? 0 : Math.sign(sep);
  });
}
const trailingRun = (sd: number[]) => {
  let r = 1;
  for (let i = sd.length - 2; i >= 0 && sd[i] === sd[sd.length - 1]; i--) r++;
  return r;
};
/** Smallest `rise` whose trailing run reaches `target`, so the fixture is built, not guessed. */
function seriesWithRun(target: number): Candle[] {
  for (let rise = 1; rise <= 200; rise++) {
    const c = breakout(80, rise);
    const sd = sidesOf(c);
    if (sd[sd.length - 1] === 1 && trailingRun(sd) === target) return c;
  }
  throw new Error(`no fixture reaches a trailing run of ${target}`);
}

function ledgerInput(regime: FactorLedgerInput['regime'], emaScore: number): FactorLedgerInput {
  return {
    coin: 'TESTC',
    scores: { rsiScore: 0, emaScore, fundingScore: 0, oiScore: 0, volumeScore: 0, hurstVal: 0.5, squeezeActive: false },
    weights: WEIGHTS,
    outcome: { rawScore: emaScore * WEIGHTS.ema },
    regime,
    indicators: {
      funding_rate: 0, funding_state: 'NORMAL', oi_change_pct: 0, oi_change_window: '24h',
      volume_24h: 1e9, trend_persistence: 'MEDIUM', breakout_pending: 'INACTIVE',
    },
    gates: { fundingZScore: 0, fundingWindowDays: FUNDING_Z_WINDOW_DAYS },
  };
}
const regimeRowOf = (i: FactorLedgerInput) => buildFactorLedger(i).rows.find(r => r.factor === 'regime')!;

describe('CH2 — the label is the band plus K unanimous bars', () => {
  it('a series whose trailing run reaches K yields TRENDING_UP', () => {
    const c = seriesWithRun(K);
    expect(trailingRun(sidesOf(c))).toBe(K);
    expect(classifyRegimeLabel(c)).toBe('TRENDING_UP');
  });

  it('its run == K-1 twin yields RANGING — so K is load-bearing, not decorative', () => {
    const c = seriesWithRun(K - 1);
    expect(trailingRun(sidesOf(c))).toBe(K - 1);
    expect(classifyRegimeLabel(c)).toBe('RANGING');
  });

  it('side is ±1 exactly when |sep| exceeds the band, and 0 otherwise', () => {
    const closes = flat(80).map(x => x.close);
    expect(sidesOf(flat(80)).every(s => s === 0)).toBe(true); // sep == 0 everywhere
    expect(closes.every(p => p === 100)).toBe(true);
    const c = seriesWithRun(K);
    const f = ema(c.map(x => x.close), 9)!; const s = ema(c.map(x => x.close), 21)!;
    const a = atr(c.map(x => x.high), c.map(x => x.low), c.map(x => x.close), 14)!;
    const band = REGIME_SEPARATION_ATR_MULT * (a / c[c.length - 1].close);
    sidesOf(c).forEach((side, k) => {
      if (isNaN(f[k]) || isNaN(s[k]) || s[k] === 0) return;
      const sep = (f[k] - s[k]) / s[k];
      expect(side).toBe(Math.abs(sep) < band ? 0 : Math.sign(sep));
    });
  });

  it('hysteresis holds the label through an oscillation that never confirms', () => {
    // Alternating one-bar pushes: the side series never achieves K unanimous bars, so the label
    // must stay put rather than chasing every crossing.
    const c = flat(60);
    let p = 100;
    for (let i = 0; i < 30; i++) {
      p = i % 2 === 0 ? p * 1.004 : p * 0.996;
      c.push({ time: (60 + i) * 3_600_000, open: p, high: p * 1.005, low: p * 0.995, close: p, volume: 1 });
    }
    // The right assertion is that no K-window is unanimous on a SIDE. A long trailing run of
    // ZEROS is not a confirmation — it is the contested state, and it correctly yields RANGING.
    const sd = sidesOf(c);
    const confirmedSide = sd.some((_, k) =>
      k >= K - 1 && new Set(sd.slice(k - K + 1, k + 1)).size === 1 && sd[k] !== 0);
    expect(confirmedSide).toBe(false);
    expect(classifyRegimeLabel(c)).toBe('RANGING');
  });

  it('RSI is not consulted for the label on any path', async () => {
    const src = await import('node:fs').then(fs =>
      fs.readFileSync('src/tools/get-trade-call.ts', 'utf8'));
    const body = src.slice(src.indexOf('export function classifyRegimeLabel'));
    const fn = body.slice(0, body.indexOf('\n}\n') + 3);
    expect(fn).not.toMatch(/\brsi\b/i);
  });
});

describe('CH2 step 6 — RANGING agrees; only a hysteresis hold disagrees', () => {
  it('a RANGING label with a SIGNED emaScore agrees — the >50% case', () => {
    // Measured 2026-08-21, per-bar, n=11,820: the old predicate disagreed on 53.7% of bars at K=12
    // because `RANGING && emaScore === 0` needs an exact EMA tie, while the band calls RANGING for
    // any |sep| < band with sep still non-zero. Widening it took that to 17.2%.
    for (const emaScore of [100, -100]) {
      const row = regimeRowOf(ledgerInput('RANGING', emaScore));
      expect(row.value).toBe('ranging');
      expect(row.contributes).toBe(true);
      expect(row.strength).not.toBe('none');   // the EMA term is NAMED, not withheld
      expect(row.direction).not.toBe('neutral');
    }
  });

  it('the EMA term is no longer pushed into strippedRemainder on a RANGING bar', () => {
    const led = buildFactorLedger(ledgerInput('RANGING', 100));
    expect(led.strippedRemainder.unnameableThisResponse).not.toContain('ema');
  });

  it('a hysteresis hold — TRENDING_UP against a bearish cross — still degrades to context', () => {
    // Unreachable before this wave: the retired rule required emaCross BULLISH for TRENDING_UP, so
    // this combination could not exist. This test is the only thing that will ever exercise it.
    const row = regimeRowOf(ledgerInput('TRENDING_UP', -100));
    expect(row.value).toBe('trending up');
    expect(row.direction).toBe('neutral');
    expect(row.strength).toBe('none');
    expect(row.contributes).toBe(true); // name-keyed — there is no "non-contributing neutral"
  });

  it('an agreeing trend still reports a real direction and strength', () => {
    expect(regimeRowOf(ledgerInput('TRENDING_UP', 100)).direction).toBe('bullish');
    expect(regimeRowOf(ledgerInput('TRENDING_DOWN', -100)).direction).toBe('bearish');
  });
});

describe('CH2 step 7 — an unmapped label never collides with a meaningful one', () => {
  const FOUR = ['trending up', 'trending down', 'ranging', 'volatile'];

  it('renders an unmapped label as its own lowercased name, never as one of the four', () => {
    // The catch-all used to be `: 'volatile'`, so ANY unmapped regime published as the word
    // "volatile" on a public receipt. The COLLISION is the defect, not the absence of a word.
    const row = regimeRowOf(ledgerInput('COMPRESSION' as FactorLedgerInput['regime'], 100));
    expect(row.value).toBe('compression');
    expect(FOUR).not.toContain(row.value);
  });

  it('does not throw — a rendering fault must never take down a live serving path', () => {
    expect(() => regimeRowOf(ledgerInput('SOMETHING_NEW' as FactorLedgerInput['regime'], 0))).not.toThrow();
  });

  it('the four existing labels render exactly as before', () => {
    expect(regimeRowOf(ledgerInput('TRENDING_UP', 100)).value).toBe('trending up');
    expect(regimeRowOf(ledgerInput('TRENDING_DOWN', -100)).value).toBe('trending down');
    expect(regimeRowOf(ledgerInput('RANGING', 0)).value).toBe('ranging');
    expect(regimeRowOf(ledgerInput('VOLATILE', 0)).value).toBe('volatile');
  });
});
