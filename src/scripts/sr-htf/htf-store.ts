// sr-htf/htf-store.ts — EDGE-SR-HTF-LEVELS-W1: this study's candle store, read.
//
// One plan and one manifest per coin (fetch-store.ts --label BINANCE-<COIN>): each coin's window starts at its own
// first full UTC day of Binance perp history plus the 300-day warm-up, so no single plan range could hold every
// coin, and the closed study's guard (sr-backtest/guard.ts) re-derives a manifest from ONE plan range. Each plan is
// fetch-store.ts's own shape with `storeVersion: 2`: every bar carries the venue's volume as a sixth field.
import { readSeries } from '../sr-probe/store.js';
import { TIMEFRAMES } from '../sr-backtest/spec.js';
import { readPlan, seriesRange, type StorePlan } from '../sr-backtest/store.js';
import { PANEL, STUDY_HTF, VENUE, planLabel } from './config.js';
import type { VBar } from './sources.js';

export type HtfPlan = StorePlan & { storeVersion?: number };

/** One coin's four series as contiguous bars over its plan's range — store.ts `loadCoin`'s checks, with the volume
 *  kept when the store holds it (version 2) and left out when it does not (version 1). Throws, reason named, on a
 *  hole. */
export function loadVCoin(store: string, plan: StorePlan, coin: string): Record<string, VBar[]> {
  const out: Record<string, VBar[]> = {};
  for (const tf of TIMEFRAMES) {
    const s = readSeries(store, { exchange: plan.venue, coin, stepMs: tf.stepMs });
    if (!s || s.status !== 'ok') throw new Error(`sr-htf store: ${coin} ${tf.key} is absent or failed`);
    const range = seriesRange(plan, tf.stepMs);
    const bars = (s.bars as unknown as number[][]).filter((b) => b[0] >= range[0] && b[0] <= range[1]);
    const expected = (range[1] - range[0]) / tf.stepMs + 1;
    if (bars.length !== expected) throw new Error(`sr-htf store: ${coin} ${tf.key} holds ${bars.length} of ${expected} bars`);
    out[tf.key] = bars.map((b, i) => {
      if (b[0] !== range[0] + i * tf.stepMs) throw new Error(`sr-htf store: ${coin} ${tf.key} is not contiguous at bar ${i}`);
      const bar: VBar = { time: b[0], open: b[1], high: b[2], low: b[3], close: b[4] };
      if (b.length > 5) bar.volume = b[5];
      return bar;
    });
  }
  return out;
}

export interface PanelCoin {
  coin: string;
  label: string;
  plan: HtfPlan;
  /** The coin's first evaluable instant: the later of the study's start and its plan's start (first full day + 300 days). */
  firstMs: number;
  /** Its first full UTC day of Binance perp history: the first open of its 1d series. */
  firstFullDayMs: number;
}

/** The registered panel in the store: every coin's plan present, holding exactly that coin, store version 2, the
 *  registered end and warm-up. Throws, reason named, on anything else — a coin missing from the store is never
 *  dropped in silence. */
export function readPanel(store: string, panel: readonly string[] = PANEL): PanelCoin[] {
  return panel.map((coin) => {
    const label = planLabel(coin);
    const plan = readPlan(store, label) as HtfPlan | null;
    if (!plan) throw new Error(`sr-htf store: no plan for ${coin} (${label})`);
    if (plan.venue !== VENUE || plan.coins.length !== 1 || plan.coins[0] !== coin) throw new Error(`sr-htf store: the plan ${label} does not hold exactly ${coin} on ${VENUE}`);
    if (plan.storeVersion !== 2) throw new Error(`sr-htf store: the plan ${label} is not store version 2 (volume)`);
    if (plan.endMs !== STUDY_HTF.endMs || plan.warmupBars !== STUDY_HTF.warmupDays) throw new Error(`sr-htf store: the plan ${label} is not the registered window`);
    return { coin, label, plan, firstMs: Math.max(STUDY_HTF.startMs, plan.startMs), firstFullDayMs: plan.startMs - plan.warmupBars * 86_400_000 };
  });
}
