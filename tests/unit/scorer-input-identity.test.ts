/**
 * scorer-input-identity.test.ts — OPS-SCORER-INPUT-PERSISTENCE-W1 R3 (fixture half).
 *
 * THE ARITHMETIC IDENTITY: the persisted parts must reproduce the persisted total.
 *
 *   (1)  SUM(bucket_i * WEIGHTS_i)                        == raw0
 *   (2)  raw0 + funding_delta + hurst_delta + squeeze_delta == raw_final
 *
 * A capture whose parts do not sum to its own total is SILENTLY wrong, and would poison every
 * attribution built on it. There is no symptom to notice later: the numbers all look like
 * numbers. So the identity is asserted here over fixtures spanning every adjustment branch, and
 * again over LIVE rows by `ops/monitoring/scorer-input-identity-canary.py` — fixtures prove the
 * derivation, live rows prove the WRITER, and neither substitutes for the other.
 *
 * This file also carries the INJECTIVITY assertions. The branch codes exist because each stage's
 * net delta fails to identify its own branch; if a future edit ever made a stage injective the
 * code would become redundant, and if it made a currently-injective stage ambiguous the code
 * would become mandatory. Encoding the test rather than the conclusion is what keeps that
 * decision re-derivable.
 */
import { describe, expect, it } from 'vitest';
import { deriveVerdict, R4_THRESHOLDS, type VerdictGateInputs } from '../../src/tools/get-trade-call.js';
import {
  FUNDING_ADJUST, HURST_ADJUST, SQUEEZE_ADJUST, IDENTITY_TOLERANCE, toScorerParts,
} from '../../src/lib/scorer-input-codes.js';

/**
 * The weights, restated here ON PURPOSE and pinned against the engine below.
 *
 * `WEIGHTS` is not exported from `get-trade-call.ts`, so identity (1) cannot be checked by
 * importing it — and importing it would be the weaker test anyway: it would assert the engine
 * agrees with itself. These literals are an INDEPENDENT statement of the coefficients, so a
 * silent retune breaks this suite instead of sailing through it. `pins the live WEIGHTS` below
 * is what makes the duplication safe rather than a second source of truth.
 */
const W = { rsi: 0.30, ema: 0.10, funding: 0.25, oi: 0.15, volume: 0.20 };

const gates = (o: Partial<VerdictGateInputs> = {}): VerdictGateInputs => ({
  fundingZScore: null,
  fundingRateAnnualized: 0,
  hurstVal: null,
  squeezeActive: false,
  r4Thresholds: R4_THRESHOLDS,
  buyThreshold: 40,
  sellThreshold: 55,
  ...o,
});

const buckets = (o: Partial<Record<'rsiScore' | 'emaScore' | 'fundingScore' | 'oiScore' | 'volumeScore', number>> = {}) => ({
  rsiScore: 0, emaScore: 0, fundingScore: 0, oiScore: 0, volumeScore: 0, ...o,
});

/** Every reachable combination of stage branches, each a named row so a failure names itself. */
const CASES: Array<{ name: string; b: ReturnType<typeof buckets>; g: VerdictGateInputs }> = [
  { name: 'all-zero (no branch anywhere)', b: buckets(), g: gates() },
  { name: 'positive, no adjustment', b: buckets({ rsiScore: 100, volumeScore: 80 }), g: gates() },
  { name: 'negative, no adjustment', b: buckets({ rsiScore: -100, emaScore: -100 }), g: gates() },
  // funding, z-present set
  { name: 'funding BUY_PENALTY_Z', b: buckets({ rsiScore: 100, volumeScore: 100 }), g: gates({ fundingZScore: 3.0 }) },
  { name: 'funding BUY_PENALTY_Z flipping the sign negative', b: buckets({ volumeScore: 80 }), g: gates({ fundingZScore: 3.0 }) },
  { name: 'funding SELL_SOFTENING_Z', b: buckets({ rsiScore: -100, emaScore: -100, volumeScore: -70 }), g: gates({ fundingZScore: -3.0 }) },
  { name: 'funding CONTRARIAN_BONUS_Z', b: buckets({ rsiScore: 100 }), g: gates({ fundingZScore: -1.8 }) },
  // The composition the injectivity test found: softening flips the score positive, and because
  // sellSofteningZ (-2.0) is BELOW the contrarian gate (-1.5) the contrarian branch then also
  // fires. Net +30, a value no single branch produces.
  { name: 'funding SELL_SOFTENING_Z + CONTRARIAN_BONUS_Z (composed, net +30)', b: buckets({ emaScore: -100, oiScore: -20 }), g: gates({ fundingZScore: -3.0 }) },
  // funding, z-null fallback set
  { name: 'funding SELL_SOFTENING_RAW', b: buckets({ rsiScore: -100 }), g: gates({ fundingRateAnnualized: 9.0 }) },
  { name: 'funding CONTRARIAN_BONUS_RAW', b: buckets({ rsiScore: 100 }), g: gates({ fundingRateAnnualized: -9.0 }) },
  // hurst
  { name: 'hurst MEAN_REVERTING on a positive score', b: buckets({ rsiScore: 100, volumeScore: 100 }), g: gates({ hurstVal: 0.30 }) },
  { name: 'hurst MEAN_REVERTING on a negative score', b: buckets({ rsiScore: -100, volumeScore: -70 }), g: gates({ hurstVal: 0.30 }) },
  { name: 'hurst TRENDING on a positive score', b: buckets({ rsiScore: 100 }), g: gates({ hurstVal: 0.80 }) },
  { name: 'hurst TRENDING on a negative score', b: buckets({ rsiScore: -100 }), g: gates({ hurstVal: 0.80 }) },
  { name: 'hurst NEUTRAL (evaluated, in-band)', b: buckets({ rsiScore: 80 }), g: gates({ hurstVal: 0.50 }) },
  // squeeze
  { name: 'squeeze ACTIVE_APPLIED positive', b: buckets({ rsiScore: 100, volumeScore: 100 }), g: gates({ squeezeActive: true }) },
  { name: 'squeeze ACTIVE_APPLIED negative', b: buckets({ rsiScore: -100, volumeScore: -70 }), g: gates({ squeezeActive: true }) },
  { name: 'squeeze ACTIVE_GATED (|raw| <= 10)', b: buckets({ oiScore: 20 }), g: gates({ squeezeActive: true }) },
  // all three stages at once
  { name: 'funding + hurst + squeeze together', b: buckets({ rsiScore: 100, emaScore: 100, fundingScore: 80, oiScore: 60, volumeScore: 100 }), g: gates({ fundingZScore: 3.0, hurstVal: 0.80, squeezeActive: true }) },
];

describe('scorer-input arithmetic identity (R3, fixtures)', () => {
  it('pins the live WEIGHTS — this suite is only meaningful if these are the real coefficients', () => {
    // Recovers each coefficient from the engine by scoring ONE bucket at a time with everything
    // else at zero, so no adjustment can fire and raw0 IS that bucket's product. If a retune ever
    // lands, this fails first and names the coefficient rather than leaving the identity suite
    // asserting against stale literals.
    for (const [k, w] of Object.entries(W) as Array<[keyof typeof W, number]>) {
      const key = `${k}Score` as const;
      const v = deriveVerdict(buckets({ [key]: 100 } as never), gates());
      expect(v.raw0, `WEIGHTS.${k} moved`).toBeCloseTo(100 * w, 10);
    }
    // And the derived public constant, re-derived rather than quoted: 30+10+20+9+20.
    const max = deriveVerdict(
      buckets({ rsiScore: 100, emaScore: 100, fundingScore: 80, oiScore: 60, volumeScore: 100 }),
      gates(),
    );
    expect(max.raw0, 'MAX_RAW_SCORE = 89 is derived from these weights and is PUBLIC COPY').toBeCloseTo(89, 10);
  });

  describe.each(CASES)('$name', ({ b, g }) => {
    const v = deriveVerdict(b, g);
    const p = toScorerParts(b, v);

    it('identity (1): the five weighted buckets reproduce raw0', () => {
      const recomputed =
        p.rsiScore * W.rsi + p.emaScore * W.ema + p.fundingScore * W.funding +
        p.oiScore * W.oi + p.volumeScore * W.volume;
      expect(Math.abs(recomputed - p.raw0)).toBeLessThanOrEqual(IDENTITY_TOLERANCE);
    });

    it('identity (2): raw0 plus the three deltas reproduces the final raw score', () => {
      const chained = p.raw0 + p.fundingDelta + p.hurstDelta + p.squeezeDelta;
      expect(Math.abs(chained - p.rawFinal)).toBeLessThanOrEqual(IDENTITY_TOLERANCE);
    });

    it('the captured final raw score IS the one the verdict used', () => {
      // Guards the pairing rather than the arithmetic: a row whose parts sum perfectly but whose
      // total came from a different verdict would satisfy both identities and still be wrong.
      expect(p.rawFinal).toBe(v.rawScore);
    });
  });

  it('PROVES THE CHECK CAN FAIL — perturbing one bucket breaks identity (1)', () => {
    // Not ceremony. A gate whose failure mode has never been observed is a gate nobody has shown
    // to be connected to anything. One bucket is moved by the smallest step the ladder allows.
    const b = buckets({ rsiScore: 100, volumeScore: 80 });
    const v = deriveVerdict(b, gates());
    const good = toScorerParts(b, v);
    const tampered = { ...good, rsiScore: good.rsiScore - 20 };
    const recomputed =
      tampered.rsiScore * W.rsi + tampered.emaScore * W.ema + tampered.fundingScore * W.funding +
      tampered.oiScore * W.oi + tampered.volumeScore * W.volume;
    expect(Math.abs(recomputed - tampered.raw0)).toBeGreaterThan(IDENTITY_TOLERANCE);
    // And the magnitude is a real defect, not a rounding artifact: 20 * 0.30 = 6 raw points,
    // ~9 orders of magnitude above the tolerance.
    expect(Math.abs(recomputed - tampered.raw0)).toBeCloseTo(6, 10);
  });

  it('PROVES THE CHECK CAN FAIL — perturbing one delta breaks identity (2)', () => {
    const b = buckets({ rsiScore: 100, volumeScore: 100 });
    const v = deriveVerdict(b, gates({ hurstVal: 0.30 }));
    const good = toScorerParts(b, v);
    const tampered = { ...good, hurstDelta: good.hurstDelta + 1 };
    const chained = tampered.raw0 + tampered.fundingDelta + tampered.hurstDelta + tampered.squeezeDelta;
    expect(Math.abs(chained - tampered.rawFinal)).toBeGreaterThan(IDENTITY_TOLERANCE);
  });
});

describe('branch-code injectivity (R3, the test that decides whether a code is required)', () => {
  // THE RULE: a branch code is required wherever the stage's net delta is NOT injective onto its
  // branch set. Each block below demonstrates the collision that makes its code mandatory, so
  // the conclusion recorded in `scorer-input-codes.ts` is re-derivable rather than asserted.

  it('FUNDING is NOT injective — two different branches both emit +10', () => {
    const b = buckets({ rsiScore: 100 });
    const viaZ = deriveVerdict(b, gates({ fundingZScore: -1.8 }));
    const viaRaw = deriveVerdict(b, gates({ fundingRateAnnualized: -9.0 }));
    expect(viaZ.fundingDelta).toBe(10);
    expect(viaRaw.fundingDelta).toBe(10);
    // Same number, different claims about the market. Only the code separates them.
    expect(viaZ.fundingAdjustCode).not.toBe(viaRaw.fundingAdjustCode);
    expect(viaZ.fundingAdjustCode & FUNDING_ADJUST.CONTRARIAN_BONUS_Z).toBeTruthy();
    expect(viaRaw.fundingAdjustCode & FUNDING_ADJUST.CONTRARIAN_BONUS_RAW).toBeTruthy();
    expect(viaRaw.fundingAdjustCode & FUNDING_ADJUST.Z_NULL_PATH).toBeTruthy();
  });

  it('FUNDING branches COMPOSE — softening plus contrarian nets +30', () => {
    const v = deriveVerdict(buckets({ emaScore: -100, oiScore: -20 }), gates({ fundingZScore: -3.0 }));
    expect(v.fundingDelta).toBe(30);
    expect(v.fundingAdjustCode & FUNDING_ADJUST.SELL_SOFTENING_Z).toBeTruthy();
    expect(v.fundingAdjustCode & FUNDING_ADJUST.CONTRARIAN_BONUS_Z).toBeTruthy();
  });

  it('FUNDING code separates "z path, nothing fired" from "raw path, nothing fired"', () => {
    const b = buckets({ rsiScore: 40 });
    const zQuiet = deriveVerdict(b, gates({ fundingZScore: 0.1 }));
    const rawQuiet = deriveVerdict(b, gates({ fundingRateAnnualized: 0 }));
    expect(zQuiet.fundingDelta).toBe(0);
    expect(rawQuiet.fundingDelta).toBe(0);
    expect(zQuiet.fundingAdjustCode).toBe(0);
    expect(rawQuiet.fundingAdjustCode).toBe(FUNDING_ADJUST.Z_NULL_PATH);
  });

  it('HURST is NOT injective — not-evaluated and evaluated-neutral both emit 0', () => {
    const b = buckets({ rsiScore: 80 });
    const notEvaluated = deriveVerdict(b, gates({ hurstVal: null }));
    const neutral = deriveVerdict(b, gates({ hurstVal: 0.50 }));
    expect(notEvaluated.hurstDelta).toBe(0);
    expect(neutral.hurstDelta).toBe(0);
    // This is the one that matters most: Hurst is dead on 5 of 8 venues, so "did it fire" is a
    // per-venue finding that a bare 0 destroys.
    expect(notEvaluated.hurstAdjustCode).toBe(HURST_ADJUST.NOT_EVALUATED);
    expect(neutral.hurstAdjustCode).toBe(HURST_ADJUST.NEUTRAL);
  });

  it('HURST magnitude still separates the two LIVE branches (the code adds null-vs-neutral only)', () => {
    const b = buckets({ rsiScore: 100, volumeScore: 100 });
    expect(deriveVerdict(b, gates({ hurstVal: 0.30 })).hurstDelta).toBe(-25);
    expect(deriveVerdict(b, gates({ hurstVal: 0.80 })).hurstDelta).toBe(10);
  });

  it('SQUEEZE is NOT injective — inactive and detected-but-gated both emit 0', () => {
    const inactive = deriveVerdict(buckets({ oiScore: 20 }), gates({ squeezeActive: false }));
    const gated = deriveVerdict(buckets({ oiScore: 20 }), gates({ squeezeActive: true }));
    expect(inactive.squeezeDelta).toBe(0);
    expect(gated.squeezeDelta).toBe(0);
    expect(inactive.squeezeAdjustCode).toBe(SQUEEZE_ADJUST.INACTIVE);
    expect(gated.squeezeAdjustCode).toBe(SQUEEZE_ADJUST.ACTIVE_GATED);
  });

  it('SQUEEZE applied case is sign-preserving and coded', () => {
    const up = deriveVerdict(buckets({ rsiScore: 100, volumeScore: 100 }), gates({ squeezeActive: true }));
    const down = deriveVerdict(buckets({ rsiScore: -100, volumeScore: -70 }), gates({ squeezeActive: true }));
    expect(up.squeezeDelta).toBe(12);
    expect(down.squeezeDelta).toBe(-12);
    expect(up.squeezeAdjustCode).toBe(SQUEEZE_ADJUST.ACTIVE_APPLIED);
    expect(down.squeezeAdjustCode).toBe(SQUEEZE_ADJUST.ACTIVE_APPLIED);
  });
});
