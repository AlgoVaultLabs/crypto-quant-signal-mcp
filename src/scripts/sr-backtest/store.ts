// sr-backtest/store.ts — EDGE-SR-LEVEL-BACKTEST-W1: the candle store's plan and manifest. A leaf beside the probe's
// own store shape (imported, never edited), so the harness reads what the fetcher wrote without importing it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Bar } from '../sr-probe/level-v0.js';
import { readSeries, type StoredSeries } from '../sr-probe/store.js';
import { TIMEFRAMES } from './spec.js';

export const sha256 = (data: string | Buffer): string => crypto.createHash('sha256').update(data).digest('hex');

export interface StorePlan {
  venue: string;
  /** First instant after the window: every bar closes at or before it. */
  endMs: number;
  /** First instant of the window. */
  startMs: number;
  warmupBars: number;
  panelSize: number;
  /** When the volume ranking was read (ISO UTC), and from where. */
  panelAsOf: string;
  panelSource: string;
  /** Every candidate walked, in descending 24h quote volume. */
  candidates: Array<{ coin: string; symbol: string; quoteVolume: number; status: 'accepted' | 'rejected'; reason?: string }>;
  coins: string[];
}

export interface ManifestSeries {
  coin: string;
  key: string;
  stepMs: number;
  firstOpen: number;
  lastOpen: number;
  bars: number;
  expected: number;
  /** sha256 of JSON.stringify(bars) — the bars alone, so a second fetch of the same candles hashes the same. */
  sha256: string;
}

export interface StoreManifest {
  venue: string;
  startMs: number;
  endMs: number;
  warmupBars: number;
  panelAsOf: string;
  coins: string[];
  series: ManifestSeries[];
  failures: Array<{ coin: string; key: string; reason: string }>;
}

export const planFile = (store: string, venue: string): string => path.join(store, `plan-${venue}.json`);
export const manifestFile = (store: string, venue: string): string => path.join(store, `manifest-${venue}.json`);

export function readPlan(store: string, venue: string): StorePlan | null {
  const f = planFile(store, venue);
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as StorePlan) : null;
}

export function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
}

/** The planned open-time range of one series: `warmupBars` bars before the window, up to the last bar closing at `endMs`. */
export const seriesRange = (plan: { startMs: number; endMs: number; warmupBars: number }, stepMs: number): [number, number] => [
  plan.startMs - plan.warmupBars * stepMs,
  plan.endMs - stepMs,
];

/** Missing bars inside the planned range (0 = every step present, first to last). */
export function missingBars(s: StoredSeries, range: [number, number]): number {
  const expected = (range[1] - range[0]) / s.stepMs + 1;
  let inRange = 0;
  let prev = -Infinity;
  for (const b of s.bars) {
    if (b[0] < range[0] || b[0] > range[1] || b[0] === prev || (b[0] - range[0]) % s.stepMs !== 0) continue;
    prev = b[0];
    inRange++;
  }
  return expected - inRange;
}

/** Rebuilds the manifest from the series files on disk. Deterministic: same store, same bytes. */
export function buildManifest(store: string, plan: StorePlan): StoreManifest {
  const series: ManifestSeries[] = [];
  const failures: StoreManifest['failures'] = [];
  for (const coin of plan.coins) {
    for (const tf of TIMEFRAMES) {
      const s = readSeries(store, { exchange: plan.venue, coin, stepMs: tf.stepMs });
      const range = seriesRange(plan, tf.stepMs);
      if (!s || s.status !== 'ok') {
        failures.push({ coin, key: tf.key, reason: s ? `fetch failed: ${s.error ?? 'unknown'}` : 'series file absent' });
        continue;
      }
      const bars = s.bars.filter((b) => b[0] >= range[0] && b[0] <= range[1]);
      const expected = (range[1] - range[0]) / tf.stepMs + 1;
      const missing = missingBars(s, range);
      if (missing !== 0) failures.push({ coin, key: tf.key, reason: `${missing} of ${expected} bars missing` });
      series.push({
        coin, key: tf.key, stepMs: tf.stepMs, firstOpen: bars.length ? bars[0][0] : 0, lastOpen: bars.length ? bars[bars.length - 1][0] : 0,
        bars: bars.length, expected, sha256: sha256(JSON.stringify(bars)),
      });
    }
  }
  return { venue: plan.venue, startMs: plan.startMs, endMs: plan.endMs, warmupBars: plan.warmupBars, panelAsOf: plan.panelAsOf, coins: plan.coins, series, failures };
}

export const manifestText = (m: StoreManifest): string => `${JSON.stringify(m, null, 1)}\n`;

/** One coin's four series, as contiguous bar arrays over the planned range. Throws, reason named, on a hole. */
export function loadCoin(store: string, plan: StorePlan, coin: string): Record<string, Bar[]> {
  const out: Record<string, Bar[]> = {};
  for (const tf of TIMEFRAMES) {
    const s = readSeries(store, { exchange: plan.venue, coin, stepMs: tf.stepMs });
    if (!s || s.status !== 'ok') throw new Error(`sr-backtest store: ${coin} ${tf.key} is absent or failed`);
    const range = seriesRange(plan, tf.stepMs);
    const bars = s.bars.filter((b) => b[0] >= range[0] && b[0] <= range[1]);
    const expected = (range[1] - range[0]) / tf.stepMs + 1;
    if (bars.length !== expected) throw new Error(`sr-backtest store: ${coin} ${tf.key} holds ${bars.length} of ${expected} bars`);
    out[tf.key] = bars.map((b, i) => {
      if (b[0] !== range[0] + i * tf.stepMs) throw new Error(`sr-backtest store: ${coin} ${tf.key} is not contiguous at bar ${i}`);
      return { time: b[0], open: b[1], high: b[2], low: b[3], close: b[4] };
    });
  }
  return out;
}
