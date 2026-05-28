/**
 * pertf-thresholds.ts
 *
 * OPS-TRADE-CALL-CLUSTER-W1 CH1 — per-TF threshold recommendations
 * sourced verbatim from OPS-TRADE-CALL-CALIBRATION-AUDIT-W1's audit .json
 * (`audits/ops-trade-call-calibration-audit-2026-05-28.json`'s
 * `recommended_per_tf_thresholds` object).
 *
 * Pure data module — zero runtime side effects. Consumed by
 * `getThresholdForTF()` helper in `src/tools/get-trade-call.ts` behind
 * the 2-flag firewall:
 *   - outer: process.env.ENABLE_PERTF_THRESHOLDS === '1'
 *   - inner: process.env[`ENABLE_PERTF_${tf.toUpperCase()}`] === '1'
 *
 * Both flags unset on first deploy → fallback to current
 * BUY_BASE_THRESHOLD=40 / SELL_THRESHOLD_GATED=55 literals (zero
 * behavioral change). Architect flips per-TF via follow-up
 * `OPS-TRADE-CALL-PERTF-ROLLOUT-W<N>` waves once `[seed-confidence-bucket]`
 * evidence (W1 R3 observability cron) confirms expected fire-rate impact.
 *
 * Schema: each TF's record carries:
 *   - buy_base:        recommended BUY_BASE_THRESHOLD (raw score; null if DEFER)
 *   - sell_gated:      recommended SELL_THRESHOLD_GATED (raw score; null if DEFER)
 *   - confidence_floor: recommended MIN_TRACKABLE_CONFIDENCE for this TF
 *   - confidence_band: HIGH | MEDIUM | LOW | DEFER per audit sample density
 *
 * `null` for buy_base / sell_gated means the audit could NOT find a confidence
 * bucket meeting WR ≥ 85% + n ≥ 30 + sign-check for that TF/direction; helper
 * returns the legacy fallback constant in that case (not null).
 */

export type TF = '1m' | '3m' | '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '8h' | '12h' | '1d';
export type ConfidenceBand = 'HIGH' | 'MEDIUM' | 'LOW' | 'DEFER';

export interface PertfThresholdRecord {
  buy_base: number | null;
  sell_gated: number | null;
  confidence_floor: number;
  confidence_band: ConfidenceBand;
}

/**
 * Per-TF threshold recommendations from W1 audit
 * (audits/ops-trade-call-calibration-audit-2026-05-28.json).
 *
 * Values are recommended raw-score thresholds (not confidences).
 * MAX_RAW_SCORE = 89; confidence = round(rawScore / 89 * 100).
 */
export const PERTF_THRESHOLDS: Record<TF, PertfThresholdRecord> = {
  '1m':  { buy_base: 45, sell_gated: null, confidence_floor: 50, confidence_band: 'HIGH' },
  '3m':  { buy_base: 45, sell_gated: null, confidence_floor: 50, confidence_band: 'HIGH' },
  '5m':  { buy_base: 45, sell_gated: 53,   confidence_floor: 50, confidence_band: 'HIGH' },
  '15m': { buy_base: 45, sell_gated: 53,   confidence_floor: 50, confidence_band: 'HIGH' },
  '30m': { buy_base: 45, sell_gated: 53,   confidence_floor: 50, confidence_band: 'HIGH' },
  '1h':  { buy_base: 49, sell_gated: 53,   confidence_floor: 55, confidence_band: 'HIGH' },
  '2h':  { buy_base: 49, sell_gated: 62,   confidence_floor: 55, confidence_band: 'HIGH' },
  '4h':  { buy_base: 49, sell_gated: 53,   confidence_floor: 55, confidence_band: 'HIGH' },
  '8h':  { buy_base: 49, sell_gated: null, confidence_floor: 52, confidence_band: 'MEDIUM' },
  '12h': { buy_base: 62, sell_gated: 62,   confidence_floor: 70, confidence_band: 'MEDIUM' },
  '1d':  { buy_base: 45, sell_gated: null, confidence_floor: 50, confidence_band: 'MEDIUM' },
};

/**
 * Compatibility map exports for direct lookup convenience.
 */
export const PERTF_BUY_BASE_THRESHOLD: Record<TF, number | null> = Object.fromEntries(
  (Object.keys(PERTF_THRESHOLDS) as TF[]).map((tf) => [tf, PERTF_THRESHOLDS[tf].buy_base]),
) as Record<TF, number | null>;

export const PERTF_SELL_THRESHOLD_GATED: Record<TF, number | null> = Object.fromEntries(
  (Object.keys(PERTF_THRESHOLDS) as TF[]).map((tf) => [tf, PERTF_THRESHOLDS[tf].sell_gated]),
) as Record<TF, number | null>;

export const PERTF_CONFIDENCE_BAND: Record<TF, ConfidenceBand> = Object.fromEntries(
  (Object.keys(PERTF_THRESHOLDS) as TF[]).map((tf) => [tf, PERTF_THRESHOLDS[tf].confidence_band]),
) as Record<TF, ConfidenceBand>;

/**
 * Per-TF threshold lookup behind 2-flag firewall.
 *
 *   getThresholdForTF('1m', 'buy', 40)
 *     → 40 (fallback) when ENABLE_PERTF_THRESHOLDS unset OR ENABLE_PERTF_1M unset
 *     → 45 (per-TF recommendation) when both env vars === '1'
 *
 * Falls back to `fallback` arg when:
 *   - outer flag ENABLE_PERTF_THRESHOLDS !== '1'
 *   - inner flag ENABLE_PERTF_<TF> !== '1'
 *   - per-TF recommendation is null (audit deferred — e.g. 1m sell_gated)
 *   - TF is not in PERTF_THRESHOLDS map (defensive default)
 */
export function getThresholdForTF(
  tf: string,
  side: 'buy' | 'sell',
  fallback: number,
): number {
  if (process.env.ENABLE_PERTF_THRESHOLDS !== '1') return fallback;
  const tfLower = tf.toLowerCase() as TF;
  const tfUpper = tfLower.toUpperCase();
  const innerEnv = process.env[`ENABLE_PERTF_${tfUpper}`];
  if (innerEnv !== '1') return fallback;
  const record = PERTF_THRESHOLDS[tfLower];
  if (!record) return fallback;
  const candidate = side === 'buy' ? record.buy_base : record.sell_gated;
  return candidate ?? fallback;
}
