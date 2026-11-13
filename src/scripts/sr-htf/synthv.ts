// sr-htf/synthv.ts — EDGE-SR-HTF-LEVELS-W1: the closed study's seeded driftless walks, with seeded volume.
//
// The price path is sr-backtest/synth.ts `walk15` and its aggregates, byte for byte; the volume is a second seeded
// stream (key + '|volume'), integer and uniform on 1 … volumeMax, independent of the price. Summed into each
// aggregate bar. Nothing here can carry information: the null calibration and the mirror tests run on these.
import type { CoinData } from '../sr-backtest/engine.js';
import { M15, TIMEFRAMES, rngOf } from '../sr-backtest/spec.js';
import { aggregate, walk15, type WalkOpts } from '../sr-backtest/synth.js';
import { CALIBRATION_HTF } from './config.js';
import type { VBar } from './sources.js';

/** `aggregate`'s bars with each one's volume summed over the same 15-minute bars. */
export function aggregateV(base: readonly VBar[], stepMs: number): VBar[] {
  const units = stepMs / M15;
  let i = 0;
  while (i < base.length && base[i].time % stepMs !== 0) i++;
  return aggregate(base, stepMs).map((b, k) => {
    let volume = 0;
    for (let j = i + k * units; j < i + (k + 1) * units; j++) volume += base[j].volume as number;
    return { ...b, volume };
  });
}

/** One synthetic coin with volume: the walk, its 1h / 4h / 1d aggregates. */
export function synthVCoin(coin: string, o: WalkOpts & { volumeMax?: number }): CoinData {
  const rnd = rngOf(o.seed, `${o.key}|volume`);
  const max = o.volumeMax ?? CALIBRATION_HTF.volumeMax;
  const base: VBar[] = walk15(o).map((b) => ({ ...b, volume: 1 + Math.floor(rnd() * max) }));
  const frames: Record<string, readonly VBar[]> = { '15m': base };
  for (const tf of TIMEFRAMES) if (tf.key !== '15m') frames[tf.key] = aggregateV(base, tf.stepMs);
  return { coin, frames };
}
