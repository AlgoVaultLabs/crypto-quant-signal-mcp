/**
 * confidence-bucket-logger.ts
 *
 * OPS-TRADE-CALL-CALIBRATION-AUDIT-W1 R3 — additive observability ONLY.
 *
 * Captures the HOLD-side rawScore/confidence distribution that the
 * `signals` table doesn't persist (HOLDs are gated out by `recordSignal`
 * at the `signal !== 'HOLD' && confidence >= MIN_TRACKABLE_CONFIDENCE`
 * filter at src/tools/get-trade-call.ts:485). Fills the counterfactual
 * fire-rate evidence gap for the follow-up threshold-change wave
 * `OPS-TRADE-CALL-THRESHOLD-PERTF-W1`.
 *
 * Gated on `process.env.ENABLE_CONFIDENCE_BUCKET_LOGGING === '1'`
 * (default OFF in prod; explicitly enabled by deploy.yml env append for
 * the 7d capture window per CLAUDE.md "Defensive thresholds get tracked
 * follow-ups" 14-day revisit cadence — TODO: revisit by 2026-06-11).
 *
 * Zero-side-effect when disabled. Single `console.log(JSON.stringify(...))`
 * call when enabled — consumed downstream by docker logs → host logrotate
 * at `/var/log/algovault-seed-confidence/<YYYY-MM-DD>.log` (weekly,
 * 4-rotate, gzip, copytruncate).
 */

export interface ConfidenceBucketLogArgs {
  coin: string;
  tf: string;
  regime: string;
  exchange: string;
  rawScore: number;
  confidence: number;
  signal: string;
  thresholdUsed: number | null;
}

export function logConfidenceBucket(args: ConfidenceBucketLogArgs): void {
  if (process.env.ENABLE_CONFIDENCE_BUCKET_LOGGING !== '1') return;
  // Single structured JSON line; downstream log parser keys on the prefix.
  console.log(
    JSON.stringify({
      ts: Date.now(),
      prefix: '[seed-confidence-bucket]',
      coin: args.coin,
      tf: args.tf,
      regime: args.regime,
      exchange: args.exchange,
      rawScore: args.rawScore,
      confidence: args.confidence,
      signal: args.signal,
      thresholdUsed: args.thresholdUsed,
    }),
  );
}
