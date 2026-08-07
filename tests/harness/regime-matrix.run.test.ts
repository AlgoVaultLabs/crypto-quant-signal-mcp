/**
 * regime-matrix.run.test.ts — SIGNAL-REGIME-LABEL-STABILITY-W1 R2 + R4.
 *
 * The live measurement run. Gated behind `REGIME_MATRIX=1` so it never fires in CI or in the
 * pre-push gate — it makes several hundred upstream requests. That gating follows the repo's
 * existing `describe.skipIf` pattern rather than inventing a second dialect.
 *
 *   REGIME_MATRIX=1 npx vitest run tests/harness/regime-matrix.run.test.ts
 *
 * Writes `audits/regime-label-stability-<date>.json`. INTERNAL artifact — no
 * `outcome_return_pct`, no component scores, no Phase-E WR, and deliberately NOT named
 * `*-shape-snapshot-*` (that glob is projected into the PUBLIC knowledge bundle by
 * `scripts/build-knowledge-json.mjs`).
 */
import { describe, it } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { getAdapter } from '../../src/lib/exchange-adapter.js';
import { runAsBatch } from '../../src/lib/upstream-weight-budget.js';
import type { Candle, ExchangeId } from '../../src/types.js';
import * as H from './regime-replay.js';

const ENABLED = process.env.REGIME_MATRIX === '1';

const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'ADA', 'AVAX'];
const VENUES: ExchangeId[] = ['HL', 'BINANCE', 'BYBIT'];
const TF_MS: Record<string, number> = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 };
/** Depth per TF, chosen to roughly equalise bar counts (2880 / 1440 / 540). */
const TF_DAYS: Record<string, number> = { '15m': 30, '1h': 60, '4h': 90 };

/** R4 frontier settings. `(9, 21)` is the shipped one and is marked in the output. */
const SWEEP: Array<[number, number]> = [
  [5, 13],
  [7, 17],
  [9, 21],
  [12, 26],
  [16, 34],
];

/** Separation required for a transition to count as resolvable (2x the structural lag). */
const ISOLATION_BARS = 24;

const MAX_PAGES = 40;
const PAGE_DELAY_MS = 250;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let requestCount = 0;

async function fetchSeries(venue: ExchangeId, coin: string, tf: string): Promise<Candle[]> {
  const tfMs = TF_MS[tf];
  const end = Date.now();
  const start = end - TF_DAYS[tf] * 86_400_000;
  const adapter = getAdapter(venue);
  const cache = new Map<number, Candle>();
  let cursor = start;
  for (let page = 0; page < MAX_PAGES && cursor <= end; page++) {
    requestCount += 1;
    const rows = await adapter.getCandles(coin, tf, cursor, undefined, end);
    if (!rows || rows.length === 0) break;
    let maxTime = cursor;
    for (const c of rows) {
      if (c.time >= start && c.time <= end) cache.set(c.time, c);
      if (c.time > maxTime) maxTime = c.time;
    }
    if (maxTime <= cursor) break; // venue horizon reached — no forward progress
    cursor = maxTime + tfMs;
    await sleep(PAGE_DELAY_MS);
  }
  return [...cache.values()].sort((a, b) => a.time - b.time);
}

interface Cell {
  venue: string;
  coin: string;
  timeframe: string;
  bars: number;
  churn: H.ChurnMetrics | null;
  lag: H.LagMetrics | null;
  lag_isolated?: H.LagMetrics | null;
  dwell_vs_lag?: number | null;
  latency_verdict: 'MEASURED' | 'INDETERMINATE' | 'NO_DATA';
  label_share: Record<string, number>;
  error?: string;
}

describe.skipIf(!ENABLED)('regime label-stability matrix (live)', () => {
  it(
    'runs the matrix and writes the audit artifact',
    { timeout: 3_600_000 },
    async () => {
      const cells: Cell[] = [];
      const sweepRows: Array<Record<string, unknown>> = [];

      await runAsBatch(async () => {
        for (const venue of VENUES) {
          for (const coin of ASSETS) {
            for (const tf of Object.keys(TF_MS)) {
              const cell: Cell = {
                venue,
                coin,
                timeframe: tf,
                bars: 0,
                churn: null,
                lag: null,
                latency_verdict: 'NO_DATA',
                label_share: {},
              };
              try {
                const candles = await fetchSeries(venue, coin, tf);
                cell.bars = candles.length;
                if (candles.length > 4 * H.EDGE_DISCARD_BARS) {
                  const fwd = H.liveSeries(candles);
                  const bwd = H.backwardSeries(candles);
                  cell.churn = H.churnOf(fwd);
                  const tf_ = H.transitionsOf(fwd);
                  const tb_ = H.transitionsOf(bwd);
                  const pairs = H.pairLags(tf_, tb_);
                  cell.lag = H.lagMetrics(pairs);
                  cell.latency_verdict = H.latencyVerdict(cell.lag);
                  // Identifiability probe: restrict to transitions the data can actually
                  // separate (nothing else within ISOLATION bars).
                  const iso = H.pairLags(
                    H.isolatedTransitions(tf_, ISOLATION_BARS),
                    H.isolatedTransitions(tb_, ISOLATION_BARS),
                    ISOLATION_BARS,
                  );
                  cell.lag_isolated = H.lagMetrics(iso);
                  cell.dwell_vs_lag =
                    cell.churn.dwell_bars_p50 !== null
                      ? Number((cell.churn.dwell_bars_p50 / H.PREDICTED_CROSSOVER_LAG_BARS).toFixed(3))
                      : null;
                  for (const s of fwd) cell.label_share[s.regime] = (cell.label_share[s.regime] ?? 0) + 1;
                  for (const k of Object.keys(cell.label_share)) {
                    cell.label_share[k] = Number((cell.label_share[k] / fwd.length).toFixed(4));
                  }
                  // R4 — sweep on the 1h series only, so the frontier is read at one cadence.
                  if (tf === '1h' && venue === 'HL') {
                    for (const [fast, slow] of SWEEP) {
                      sweepRows.push({
                        coin,
                        fast,
                        slow,
                        is_shipped: fast === H.EMA_FAST && slow === H.EMA_SLOW,
                        flips_per_100_bars: Number(H.sweepChurn(candles, fast, slow).toFixed(3)),
                        closed_form_lag_bars: Number(H.crossoverLagAfterReversal(fast, slow).toFixed(3)),
                      });
                    }
                  }
                }
              } catch (e) {
                cell.error = (e as Error).message.slice(0, 160);
              }
              cells.push(cell);
              console.log(
                `${venue}/${coin}/${tf}: bars=${cell.bars} flips/100=${cell.churn?.flips_per_100_bars.toFixed(2) ?? '-'} ` +
                  `n_tr=${cell.lag?.n_transitions_observed ?? '-'} verdict=${cell.latency_verdict}${cell.error ? ' ERR=' + cell.error : ''}`,
              );
            }
          }
        }
      }, 'regime-label-stability-w1');

      const measured = cells.filter((c) => c.latency_verdict === 'MEASURED');
      const allLags = measured.flatMap((c) => (c.lag?.p50 !== null && c.lag ? [c.lag.p50 as number] : []));
      allLags.sort((a, b) => a - b);

      const sha = execSync('git rev-parse HEAD').toString().trim();
      const artifact = {
        wave: 'SIGNAL-REGIME-LABEL-STABILITY-W1',
        generated_at_utc: new Date().toISOString(),
        classification: 'INTERNAL',
        tree_sha: sha,
        classifier_unchanged_since: 'dc42b38',
        method: 'zero-phase: production classifier run forward and over the time-reversed series; tau = (t_forward - t_backward) / 2',
        reference_caveat:
          'The reference is NOT ground truth. Forward-backward filtering squares the magnitude response, so it is zero-phase AND sharper than production. It is valid for isolating LAG - phase is exactly what the construction removes - but its regime LABELS are not those of a hypothetical lag-free production classifier.',
        mirror_caveat:
          'Time reversal maps an uptrend to a downtrend. The mirror is EXACT for the EMA crossover and INEXACT through the RSI gate, so lag is reported ONLY for EMA-driven transitions. RSI-driven flips are counted in churn with lag null.',
        declared_indeterminate_threshold: {
          n_transitions_observed: H.MIN_TRANSITIONS_FOR_LATENCY,
          rationale: 'A p90 over 3 transitions is not a measurement. Declared as a decision, not a filter for a later wave to "fix".',
        },
        closed_form: {
          predicted_crossover_lag_bars: Number(H.PREDICTED_CROSSOVER_LAG_BARS.toFixed(3)),
          ema_dc_delays: H.EMA_DC_DELAYS,
          preregistration_correction:
            'The wave pre-registered [tau_9, tau_21] = [4, 10] bars. That was WRONG: those bracket where each EMA SITS on a ramp, not where they CROSS. The difference must change sign, not merely shrink, so the crossover lags by more than either individual tau. Corrected closed form = 11.64 bars, confirmed by the harness at 11.5 (two-sided) and 12 (forward detection = ceil).',
        },
        request_count: requestCount,
        request_budget_note:
          'The plan estimated 264 requests at an assumed 500 rows/page. Measured page depth is venue-specific (HL 1501, BINANCE/BYBIT ~200, OKX 100), so the real count is recorded here rather than the estimate.',
        matrix: cells,
        aggregate: {
          cells_total: cells.length,
          cells_measured: measured.length,
          cells_indeterminate: cells.filter((c) => c.latency_verdict === 'INDETERMINATE').length,
          cells_no_data: cells.filter((c) => c.latency_verdict === 'NO_DATA').length,
          median_of_cell_p50_lag_bars: allLags.length ? allLags[Math.floor(allLags.length / 2)] : null,
          isolated: (() => {
            const v = cells
              .flatMap((c) => (c.lag_isolated?.p50 !== null && c.lag_isolated ? [c.lag_isolated.p50 as number] : []))
              .sort((a, b) => a - b);
            const n = cells.reduce((a, c) => a + (c.lag_isolated?.n_transitions_observed ?? 0), 0);
            return {
              isolation_bars: ISOLATION_BARS,
              n_isolated_pairs_total: n,
              median_of_cell_p50_lag_bars: v.length ? v[Math.floor(v.length / 2)] : null,
              cells_contributing: v.length,
            };
          })(),
        },
        r4_window_sweep: sweepRows,
      };

      const dir = resolve(process.cwd(), 'audits');
      mkdirSync(dir, { recursive: true });
      const out = resolve(dir, 'regime-label-stability-2026-08-07.json');
      writeFileSync(out, JSON.stringify(artifact, null, 2));
      console.log(`\nWROTE ${out}`);
      console.log(`cells: ${measured.length} MEASURED / ${artifact.aggregate.cells_indeterminate} INDETERMINATE / ${artifact.aggregate.cells_no_data} NO_DATA`);
      console.log(`requests: ${requestCount}`);
    },
  );
});
