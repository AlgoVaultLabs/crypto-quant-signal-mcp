// sr-probe/store.ts — EDGE-SR-LEVEL-PROBE-W1: the on-disk shape of one fetched candle series. A leaf, so the
// feature builder can read what the fetcher wrote without importing the fetcher (and its caller tag).

import fs from 'node:fs';
import path from 'node:path';

export interface StoredSeries {
  exchange: string;
  coin: string;
  key: string;
  stepMs: number;
  ranges: Array<[number, number]>;
  status: 'ok' | 'failed';
  error?: string;
  pages: number;
  branches: Record<string, number>;
  fetchedAt: string;
  /** [openMs, open, high, low, close], ascending, unique. */
  bars: Array<[number, number, number, number, number]>;
  /** The paging rule the series was walked with (absent = the first rule, which stopped at an empty window). */
  walk?: number;
}

/** The current paging rule: an empty window is stepped over, never read as the end of the series. */
export const WALK_VERSION = 2;

/** True when the stored bars reach both ends of every planned range — a series the first paging rule read whole. */
export function coversRanges(s: StoredSeries): boolean {
  return s.ranges.every(([a, b]) => {
    let first = Infinity;
    let last = -Infinity;
    for (const bar of s.bars) {
      if (bar[0] < a || bar[0] > b) continue;
      if (bar[0] < first) first = bar[0];
      if (bar[0] > last) last = bar[0];
    }
    return first <= a + s.stepMs && last >= b - 2 * s.stepMs;
  });
}

export function seriesFile(store: string, s: { exchange: string; coin: string; stepMs: number }): string {
  return path.join(store, s.exchange, `${encodeURIComponent(s.coin)}__${s.stepMs}.json`);
}

export function readSeries(store: string, s: { exchange: string; coin: string; stepMs: number }): StoredSeries | null {
  const f = seriesFile(store, s);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8')) as StoredSeries;
}
