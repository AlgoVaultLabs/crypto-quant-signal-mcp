/**
 * OPS-PFE-METRIC-INTEGRITY-W1 R10 — tests for the emit-time book-liveness gate.
 *
 * Covers the specific ways this wave can produce a WRONG answer:
 *  - Trap 5  the predicate must be venue- and asset-class-AGNOSTIC (R2.7 / AC4)
 *  - Trap 7  S1 genuine-loss rows must NOT be swept up (any 100.00% cohort is a FAIL)
 *  - Trap 8  suppression must yield HOLD through deriveVerdict, never an early return
 *  - Trap 9  a still-forming last bar reading volume=0 must NOT suppress
 *  - §K      a suppressed emission stays in `totalGenerated` (it becomes a HOLD)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  assessBookLiveness,
  getBookLivenessMode,
  BOOK_LIVENESS_WINDOW,
  BOOK_LIVENESS_MIN_GENUINE_BARS,
} from '../../src/lib/book-liveness.js';
import { deriveVerdict, type VerdictGateInputs, type VerdictScoreInputs } from '../../src/tools/get-trade-call.js';
import type { Candle } from '../../src/types.js';

// ─────────────────────────── fixtures ───────────────────────────

/** A genuinely traded bar. */
const live = (t: number, price = 100, volume = 1234.5): Candle =>
  ({ time: t, open: price, high: price * 1.01, low: price * 0.99, close: price, volume });

/** A zero-volume synthetic flat bar — the shape venues emit for a non-trading book. */
const frozen = (t: number, price = 694.84): Candle =>
  ({ time: t, open: price, high: price, low: price, close: price, volume: 0 });

const bars = (n: number, make: (i: number) => Candle): Candle[] =>
  Array.from({ length: n }, (_, i) => make(i + 1));

// ─────────────────────────── the predicate ───────────────────────────

describe('assessBookLiveness — the predicate', () => {
  it('a fully traded book is live', () => {
    const r = assessBookLiveness(bars(24, (i) => live(i)));
    expect(r).toEqual({ live: true, genuineBars: 24, barsExamined: 24 });
  });

  it('a fully frozen book is NOT live — the ASTER QQQUSDT shape', () => {
    const r = assessBookLiveness(bars(24, (i) => frozen(i)));
    expect(r).toEqual({ live: false, genuineBars: 0, barsExamined: 24 });
  });

  it('is exactly at the boundary: k genuine bars is LIVE, k-1 is NOT', () => {
    const k = BOOK_LIVENESS_MIN_GENUINE_BARS;
    const N = BOOK_LIVENESS_WINDOW;
    const atK = bars(N, (i) => (i <= k ? live(i) : frozen(i)));
    const belowK = bars(N, (i) => (i <= k - 1 ? live(i) : frozen(i)));
    expect(assessBookLiveness(atK).genuineBars).toBe(k);
    expect(assessBookLiveness(atK).live).toBe(true);      // >= is inclusive
    expect(assessBookLiveness(belowK).genuineBars).toBe(k - 1);
    expect(assessBookLiveness(belowK).live).toBe(false);
  });

  it('Trap 9: a still-forming LAST bar at volume=0 does NOT suppress a healthy book', () => {
    // 23 traded bars + the current bar, which legitimately reads 0 moments after it opens.
    const withFormingBar = [...bars(23, (i) => live(i)), frozen(24)];
    const r = assessBookLiveness(withFormingBar);
    expect(r.genuineBars).toBe(23);
    expect(r.live).toBe(true);
    // The margin that makes this safe — assert it, so tightening k toward N fails HERE
    // rather than in production at a bar boundary.
    expect(BOOK_LIVENESS_MIN_GENUINE_BARS).toBeLessThanOrEqual(BOOK_LIVENESS_WINDOW - 4);
  });

  it('examines only the last N bars — ancient history cannot resurrect a dead book', () => {
    const oldLiveNewFrozen = [...bars(50, (i) => live(i)), ...bars(24, (i) => frozen(100 + i))];
    const r = assessBookLiveness(oldLiveNewFrozen);
    expect(r.barsExamined).toBe(BOOK_LIVENESS_WINDOW);
    expect(r.genuineBars).toBe(0);
    expect(r.live).toBe(false);
  });

  it('fails OPEN on empty input — a liveness probe must never silence a venue on missing data', () => {
    expect(assessBookLiveness([]).live).toBe(true);
    // @ts-expect-error — defensive: a malformed upstream payload must not suppress either
    expect(assessBookLiveness(null).live).toBe(true);
  });

  it('fails OPEN on a window shorter than the threshold (too little evidence to judge)', () => {
    const r = assessBookLiveness(bars(5, (i) => frozen(i)));
    expect(r.live).toBe(true);       // 0 genuine of 5 — but 5 < k, so we cannot conclude
    expect(r.barsExamined).toBe(5);
  });

  it('coerces a string-typed volume (KuCoin/MEXC assign without parseFloat)', () => {
    const stringVol = bars(24, (i) => ({ ...live(i), volume: '1234.5' as unknown as number }));
    expect(assessBookLiveness(stringVol).live).toBe(true);

    const stringZero = bars(24, (i) => ({ ...frozen(i), volume: '0' as unknown as number }));
    expect(assessBookLiveness(stringZero).live).toBe(false);
  });

  it('treats null/undefined/NaN volume as not-genuine (they cannot prove a trade happened)', () => {
    const bad = bars(24, (i) => ({ ...live(i), volume: (i % 2 ? null : undefined) as unknown as number }));
    expect(assessBookLiveness(bad).genuineBars).toBe(0);
    expect(assessBookLiveness(bad).live).toBe(false);
  });

  it('a negative volume is not a trade', () => {
    expect(assessBookLiveness(bars(24, (i) => ({ ...live(i), volume: -5 }))).live).toBe(false);
  });
});

// ─────────────────────────── the rollout flags ───────────────────────────

describe('getBookLivenessMode — two-flag firewall', () => {
  it('defaults to off with no env at all', () => {
    expect(getBookLivenessMode({})).toBe('off');
  });

  it('the kill switch dominates: MODE=enforce without ENABLED is still off', () => {
    expect(getBookLivenessMode({ EMIT_BOOK_LIVENESS_MODE: 'enforce' })).toBe('off');
  });

  it('accepts BOTH 1 and true for the kill switch (the X402_NUDGE_ENABLED lesson)', () => {
    expect(getBookLivenessMode({ EMIT_BOOK_LIVENESS_ENABLED: '1' })).toBe('shadow');
    expect(getBookLivenessMode({ EMIT_BOOK_LIVENESS_ENABLED: 'true' })).toBe('shadow');
    expect(getBookLivenessMode({ EMIT_BOOK_LIVENESS_ENABLED: 'TRUE' })).toBe('shadow');
  });

  it('enabled with an unset or garbage mode falls back to SHADOW, never enforce', () => {
    expect(getBookLivenessMode({ EMIT_BOOK_LIVENESS_ENABLED: '1' })).toBe('shadow');
    expect(getBookLivenessMode({ EMIT_BOOK_LIVENESS_ENABLED: '1', EMIT_BOOK_LIVENESS_MODE: 'ENFORC' })).toBe('shadow');
    expect(getBookLivenessMode({ EMIT_BOOK_LIVENESS_ENABLED: '1', EMIT_BOOK_LIVENESS_MODE: '' })).toBe('shadow');
  });

  it('reaches enforce only with both keys set correctly', () => {
    expect(getBookLivenessMode({ EMIT_BOOK_LIVENESS_ENABLED: '1', EMIT_BOOK_LIVENESS_MODE: 'enforce' })).toBe('enforce');
    expect(getBookLivenessMode({ EMIT_BOOK_LIVENESS_ENABLED: 'true', EMIT_BOOK_LIVENESS_MODE: 'ENFORCE' })).toBe('enforce');
  });

  it('flipping the kill switch off is an instant rollback from enforce', () => {
    const env = { EMIT_BOOK_LIVENESS_ENABLED: '1', EMIT_BOOK_LIVENESS_MODE: 'enforce' };
    expect(getBookLivenessMode(env)).toBe('enforce');
    expect(getBookLivenessMode({ ...env, EMIT_BOOK_LIVENESS_ENABLED: '0' })).toBe('off');
  });
});

// ─────────────────────────── the verdict seam ───────────────────────────

const scores = (dir: 'buy' | 'sell'): VerdictScoreInputs =>
  dir === 'buy'
    ? { rsiScore: 90, emaScore: 90, fundingScore: 90, oiScore: 90, volumeScore: 90 }
    : { rsiScore: -90, emaScore: -90, fundingScore: -90, oiScore: -90, volumeScore: -90 };

const gates = (over: Partial<VerdictGateInputs> = {}): VerdictGateInputs => ({
  fundingZScore: null,
  fundingRateAnnualized: 0,
  hurstVal: null,
  squeezeActive: false,
  r4Thresholds: { buyPenaltyZ: 2.5, sellSofteningZ: -2.5 } as VerdictGateInputs['r4Thresholds'],
  buyThreshold: 40,
  sellThreshold: 55,
  ...over,
});

describe('deriveVerdict — the book-liveness decision (Trap 8: decided HERE, not by early return)', () => {
  it('bookLive undefined ⇒ byte-identical legacy behaviour (every existing caller)', () => {
    const legacy = deriveVerdict(scores('buy'), gates());
    const explicit = deriveVerdict(scores('buy'), gates({ bookLive: undefined }));
    expect(legacy).toEqual(explicit);
    expect(legacy.signal).toBe('BUY');
  });

  it('bookLive true ⇒ unchanged', () => {
    expect(deriveVerdict(scores('buy'), gates({ bookLive: true })).signal).toBe('BUY');
    expect(deriveVerdict(scores('sell'), gates({ bookLive: true })).signal).toBe('SELL');
  });

  it('bookLive false ⇒ a BUY collapses to HOLD', () => {
    const r = deriveVerdict(scores('buy'), gates({ bookLive: false }));
    expect(r.signal).toBe('HOLD');
  });

  it('bookLive false ⇒ a SELL collapses to HOLD', () => {
    const r = deriveVerdict(scores('sell'), gates({ bookLive: false }));
    expect(r.signal).toBe('HOLD');
  });

  it('preserves rawScore and confidence — only the ACTION is withheld', () => {
    const open = deriveVerdict(scores('buy'), gates({ bookLive: true }));
    const shut = deriveVerdict(scores('buy'), gates({ bookLive: false }));
    expect(shut.rawScore).toBe(open.rawScore);
    expect(shut.confidence).toBe(open.confidence);
    expect(shut.confidence).toBeGreaterThan(0);
  });

  it('explains itself in scoreAdjustments (a silent suppression is undebuggable)', () => {
    const r = deriveVerdict(scores('buy'), gates({ bookLive: false }));
    const note = r.scoreAdjustments.find((a) => a.startsWith('Book not trading'));
    expect(note).toBeDefined();
    expect(note).toContain(String(BOOK_LIVENESS_MIN_GENUINE_BARS));
    expect(note).toContain(String(BOOK_LIVENESS_WINDOW));
  });

  it('adds NO note when the verdict was already HOLD — nothing was suppressed', () => {
    const weak: VerdictScoreInputs = { rsiScore: 1, emaScore: 1, fundingScore: 1, oiScore: 1, volumeScore: 1 };
    const r = deriveVerdict(weak, gates({ bookLive: false }));
    expect(r.signal).toBe('HOLD');
    expect(r.scoreAdjustments.some((a) => a.startsWith('Book not trading'))).toBe(false);
  });

  it('§K: suppression yields HOLD — so the call still counts toward totalGenerated', () => {
    // totalGenerated = totalCalls + totalHolds. A suppressed call MUST land in one of them,
    // or the published hold-rate denominator silently shrinks. HOLD is the correct bucket.
    const r = deriveVerdict(scores('sell'), gates({ bookLive: false }));
    expect(r.signal).toBe('HOLD');
    expect(['BUY', 'SELL']).not.toContain(r.signal);
  });
});

// ─────────────────────────── AC4: the agnosticism canary ───────────────────────────

describe('AC4 — the gate predicate is venue- and asset-class-agnostic (Trap 5)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(resolve(here, '../../src/lib/book-liveness.ts'), 'utf8');

  // Strip comments: the file legitimately DISCUSSES venues and asset classes in its rationale
  // (that is the point of the doc block). What must be clean is the executable predicate.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  const FORBIDDEN: Array<[RegExp, string]> = [
    [/\bASTER\b|\bBINANCE\b|\bBYBIT\b|\bKUCOIN\b|\bMEXC\b|\bOKX\b|\bBITGET\b|\bGATE\b|\bHTX\b|\bHL\b/i, 'venue name'],
    [/classifyAsset|isKnownTradFi|resolveAssetClass|assetClass|asset-tiers/, 'asset-class classifier'],
    [/marketSession|classifyUnderlyingSession|market-sessions|isClosedState|tradingHours|marketHours/i, 'market-hours logic'],
    [/\bQQQ\b|\bSPY\b|\bBTC\b|\bETH\b|USDT|allowlist|denylist|blocklist/i, 'symbol list'],
  ];

  for (const [re, label] of FORBIDDEN) {
    it(`contains no ${label}`, () => {
      const hit = code.match(re);
      expect(hit, `book-liveness.ts executable code must not reference a ${label}; found ${hit?.[0]}`).toBeNull();
    });
  }

  it('the canary is non-vacuous — it detects a planted violation', () => {
    const planted = code + "\nif (exchange === 'ASTER') return { live: false };\n";
    expect(planted.match(FORBIDDEN[0][0])).not.toBeNull();
  });

  it('the predicate signature takes only candles + numeric knobs — no venue, no symbol', () => {
    // `Function.length` counts params BEFORE the first default, so it is 1 here (candles).
    // What matters is that nothing venue/symbol-shaped can be passed in at all, so read the
    // declared signature from source.
    const sig = source.slice(source.indexOf('export function assessBookLiveness'));
    const params = sig.slice(sig.indexOf('(') + 1, sig.indexOf('):'));
    expect(params).toContain('candles');
    expect(params).toContain('window');
    expect(params).toContain('minGenuineBars');
    expect(params).not.toMatch(/exchange|venue|symbol|coin|asset/i);
  });
});
