// EDGE-SR-HTF-LEVELS-W1 CH1 — the candle store. src/scripts/sr-backtest/fetch-store.ts gained an explicit window
// (--start / --end), per-coin plans (--label, --panel-size) and store version 2 (--volume); without those flags
// every byte it writes must be what it wrote for the closed study, and the closed study's store must still read
// identically (AC1.4). Driven end to end on a fake adapter: no network.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { fake } = vi.hoisted(() => {
  const STEP: Record<string, number> = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };
  const calls = { n: 0 };
  /** Binance's paging: bars opening at or after startTime, at most 200, none after endTime. Integer prices. */
  const getCandles = async (coin: string, interval: string, startTime: number, _limit: unknown, endTime: number) => {
    calls.n++;
    const step = STEP[interval];
    const out = [];
    for (let t = Math.ceil(startTime / step) * step; t <= endTime && out.length < 200; t += step) {
      const k = t / step;
      const mid = 1000 + (k % 17) * 3 + coin.length;
      out.push({ time: t, open: mid, high: mid + 5 + (k % 3), low: mid - 4 - (k % 5), close: mid + 1, volume: 10 + (k % 7) });
    }
    return out;
  };
  return { fake: { getCandles, calls } };
});
vi.mock('../../src/lib/exchange-adapter.js', () => ({ getAdapter: () => ({ getCandles: fake.getCandles }) }));

import { readSeries, seriesFile } from '../../src/scripts/sr-probe/store.js';
import { DAY, M15, STUDY, TIMEFRAMES } from '../../src/scripts/sr-backtest/spec.js';
import { buildManifest, loadCoin, manifestText, planFile, readPlan, type StorePlan } from '../../src/scripts/sr-backtest/store.js';
import { STORE_VERSION_VOLUME, barTuple, firstFullDay, planWindow, run, seriesVersion } from '../../src/scripts/sr-backtest/fetch-store.js';
import { STUDY_HTF } from '../../src/scripts/sr-htf/config.js';
import { loadVCoin, readPanel } from '../../src/scripts/sr-htf/htf-store.js';

let dir = '';
const argv = process.argv;
let now = Date.UTC(2026, 0, 1);

/** fetch-store's `run` with these flags on the command line. */
async function fetchWith(store: string, label: string, volume: boolean, flags: string[]): Promise<boolean> {
  process.argv = [argv[0], 'fetch-store.ts', '--store', store, ...flags];
  try {
    return await run(store, 'BINANCE', label, volume);
  } finally {
    process.argv = argv;
  }
}

const panelFile = (coins: string[]): string => {
  const f = path.join(dir, `panel-${coins.join('-')}.json`);
  writeFileSync(f, JSON.stringify(coins));
  return f;
};

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'sr-htf-store-'));
  // The pacing waits on Date.now(): a clock that moves a second per read never waits.
  vi.spyOn(Date, 'now').mockImplementation(() => (now += 1000));
});

afterAll(() => {
  vi.restoreAllMocks();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('the helpers', () => {
  it('writes five fields per bar, or six with the volume, and reads a missing version as 1', () => {
    const c = { time: 1, open: 2, high: 3, low: 4, close: 5, volume: 6 };
    expect(barTuple(c, false)).toEqual([1, 2, 3, 4, 5]);
    expect(barTuple(c, true)).toEqual([1, 2, 3, 4, 5, 6]);
    expect([STORE_VERSION_VOLUME, seriesVersion({}), seriesVersion({ version: 2 })]).toEqual([2, 1, 2]);
  });

  it('finds the first full UTC day of a history', () => {
    expect(firstFullDay(Date.UTC(2020, 8, 9))).toBe(Date.UTC(2020, 8, 9));
    expect(firstFullDay(Date.UTC(2020, 8, 8, 8, 15))).toBe(Date.UTC(2020, 8, 9));
    expect(firstFullDay(Date.UTC(2020, 8, 8, 23, 45))).toBe(Date.UTC(2020, 8, 9));
  });

  it('plans the closed study\'s window by default and an explicit one when asked; UTC midnights only', () => {
    const at = Date.UTC(2026, 10, 13, 9, 30);
    expect(planWindow({ nowMs: at })).toEqual({ startMs: Date.UTC(2026, 10, 13) - STUDY.windowDays * DAY, endMs: Date.UTC(2026, 10, 13) });
    expect(planWindow({ nowMs: at, endArg: '2025-11-12T00:00:00Z' })).toEqual({ startMs: Date.UTC(2025, 10, 12) - 365 * DAY, endMs: Date.UTC(2025, 10, 12) });
    expect(planWindow({ nowMs: at, endArg: '2025-11-12T00:00:00Z', startArg: '2020-12-02T00:00:00Z' })).toEqual({ startMs: Date.UTC(2020, 11, 2), endMs: Date.UTC(2025, 10, 12) });
    expect(() => planWindow({ nowMs: at, endArg: '2025-11-12T01:00:00Z' })).toThrow(/--end must be a UTC midnight that has passed/);
    expect(() => planWindow({ nowMs: at, endArg: '2026-11-14T00:00:00Z' })).toThrow(/--end must be a UTC midnight that has passed/);
    expect(() => planWindow({ nowMs: at, endArg: '2025-11-12T00:00:00Z', startArg: '2025-11-12T00:00:00Z' })).toThrow(/--start must be a UTC midnight before --end/);
    expect(() => planWindow({ nowMs: at, endArg: '2025-11-12T00:00:00Z', startArg: '2021-01-01T06:00:00Z' })).toThrow(/--start must be a UTC midnight before --end/);
  });
});

describe('without the new flags, the closed study\'s store, byte for byte', () => {
  let store = '';
  let plan: StorePlan;
  beforeAll(async () => {
    store = path.join(dir, 'v1');
    await fetchWith(store, 'BINANCE', false, ['--end', '2024-01-02T00:00:00Z', '--panel', panelFile(['AAA'])]);
    plan = readPlan(store, 'BINANCE')!;
  }, 120_000);

  it('writes the plan the closed study wrote: its keys in order, its window, its panel size, no store version', () => {
    expect(Object.keys(JSON.parse(readFileSync(planFile(store, 'BINANCE'), 'utf8')))).toEqual(['venue', 'endMs', 'startMs', 'warmupBars', 'panelSize', 'panelAsOf', 'panelSource', 'candidates', 'coins']);
    expect(plan).toMatchObject({ venue: 'BINANCE', endMs: Date.UTC(2024, 0, 2), startMs: Date.UTC(2024, 0, 2) - 365 * DAY, warmupBars: STUDY.warmupBars, panelSize: STUDY.panelSize, coins: ['AAA'] });
    expect(plan.candidates).toEqual([{ coin: 'AAA', symbol: 'AAA', quoteVolume: 0, status: 'accepted' }]);
  });

  it('writes the series the closed study wrote: five fields per bar and no version', () => {
    for (const tf of TIMEFRAMES) {
      const raw = JSON.parse(readFileSync(seriesFile(store, { exchange: 'BINANCE', coin: 'AAA', stepMs: tf.stepMs }), 'utf8'));
      expect(Object.keys(raw), tf.key).toEqual(['exchange', 'coin', 'key', 'stepMs', 'ranges', 'status', 'pages', 'branches', 'fetchedAt', 'bars', 'walk']);
      expect(raw.bars.every((b: number[]) => b.length === 5), tf.key).toBe(true);
    }
    expect(buildManifest(store, plan).failures).toEqual([]);
  });

  it('reads identically through the closed loader and this study\'s loader', () => {
    const closed = loadCoin(store, plan, 'AAA');
    const mine = loadVCoin(store, plan, 'AAA');
    expect(mine).toEqual(closed);
    expect(mine['15m'].length).toBe(365 * 96 + STUDY.warmupBars);
    expect(mine['1d'].every((b) => b.volume === undefined)).toBe(true);
    expect(manifestText(buildManifest(store, plan))).toBe(manifestText(buildManifest(store, readPlan(store, 'BINANCE')!)));
  });

  it('refuses to resume a version-1 plan with --volume', async () => {
    await expect(fetchWith(store, 'BINANCE', true, ['--end', '2024-01-02T00:00:00Z'])).rejects.toThrow(/is store version 1: drop --volume to resume it/);
  });
});

describe('--start, --label, --panel-size and --volume: one plan per coin, store version 2', () => {
  let store = '';
  beforeAll(async () => {
    store = path.join(dir, 'v2');
    for (const coin of ['BBB', 'CCCC']) {
      expect(await fetchWith(store, `BINANCE-${coin}`, true, ['--end', '2025-11-12T00:00:00Z', '--start', '2025-11-08T00:00:00Z', '--panel', panelFile([coin]), '--panel-size', '1'])).toBe(true);
    }
  }, 120_000);

  it('writes each coin its own plan: the explicit window, panel size 1, store version 2', () => {
    const plan = readPlan(store, 'BINANCE-BBB') as StorePlan & { storeVersion?: number };
    expect(plan).toMatchObject({ venue: 'BINANCE', startMs: Date.UTC(2025, 10, 8), endMs: Date.UTC(2025, 10, 12), warmupBars: 300, panelSize: 1, coins: ['BBB'], storeVersion: 2 });
    expect(readPlan(store, 'BINANCE')).toBeNull();
  });

  it('stores the volume as a sixth field and loads it', () => {
    const s = readSeries(store, { exchange: 'BINANCE', coin: 'BBB', stepMs: M15 }) as unknown as { version: number; bars: number[][] };
    expect(s.version).toBe(2);
    expect(s.bars.every((b) => b.length === 6)).toBe(true);
    const bars = loadVCoin(store, readPlan(store, 'BINANCE-BBB')!, 'BBB');
    expect(bars['1h'][0]).toEqual({ time: Date.UTC(2025, 10, 8) - 300 * 3_600_000, open: expect.any(Number), high: expect.any(Number), low: expect.any(Number), close: expect.any(Number), volume: expect.any(Number) });
    // The closed loader reads the same candles, without the volume.
    const closed = loadCoin(store, readPlan(store, 'BINANCE-BBB')!, 'BBB');
    expect(bars['4h'].map(({ volume: _v, ...b }) => b)).toEqual(closed['4h']);
  });

  it('reads the panel: each coin\'s plan, its first evaluable instant and its first full day', () => {
    const panel = readPanel(store, ['BBB', 'CCCC']).map((c) => ({ ...c, plan: undefined }));
    expect(panel).toEqual([
      { coin: 'BBB', label: 'BINANCE-BBB', plan: undefined, firstMs: Date.UTC(2025, 10, 8), firstFullDayMs: Date.UTC(2025, 10, 8) - 300 * DAY },
      { coin: 'CCCC', label: 'BINANCE-CCCC', plan: undefined, firstMs: Date.UTC(2025, 10, 8), firstFullDayMs: Date.UTC(2025, 10, 8) - 300 * DAY },
    ]);
    expect(STUDY_HTF.endMs).toBe(Date.UTC(2025, 10, 12));
  });

  it('refuses a coin it cannot read as registered, by name', () => {
    expect(() => readPanel(store, ['BBB', 'DDD'])).toThrow(/no plan for DDD \(BINANCE-DDD\)/);
    const f = planFile(store, 'BINANCE-CCCC');
    const orig = readFileSync(f, 'utf8');
    const edit = (change: (p: Record<string, unknown>) => void): void => {
      const p = JSON.parse(orig);
      change(p);
      writeFileSync(f, JSON.stringify(p));
    };
    try {
      edit((p) => delete p.storeVersion);
      expect(() => readPanel(store, ['CCCC'])).toThrow(/is not store version 2/);
      edit((p) => (p.endMs = Date.UTC(2025, 10, 13)));
      expect(() => readPanel(store, ['CCCC'])).toThrow(/is not the registered window/);
      edit((p) => (p.coins = ['CCCC', 'BBB']));
      expect(() => readPanel(store, ['CCCC'])).toThrow(/does not hold exactly CCCC/);
    } finally {
      writeFileSync(f, orig);
    }
    expect(readPanel(store, ['CCCC'])).toHaveLength(1);
  });

  it('names a hole in a series', () => {
    const f = seriesFile(store, { exchange: 'BINANCE', coin: 'CCCC', stepMs: 3_600_000 });
    const orig = readFileSync(f, 'utf8');
    const s = JSON.parse(orig);
    s.bars.splice(10, 1);
    writeFileSync(f, JSON.stringify(s));
    try {
      expect(() => loadVCoin(store, readPlan(store, 'BINANCE-CCCC')!, 'CCCC')).toThrow(/CCCC 1h holds \d+ of \d+ bars/);
    } finally {
      writeFileSync(f, orig);
    }
  });

  it('re-uses a series on disk only for the same range and the same store version', async () => {
    const flags = (coin: string): string[] => ['--end', '2025-11-12T00:00:00Z', '--start', '2025-11-08T00:00:00Z', '--panel', panelFile([coin]), '--panel-size', '1'];
    // A version-1 plan over the same coin and range: every series is read again, as version 1.
    let before = fake.calls.n;
    expect(await fetchWith(store, 'V1-BBB', false, flags('BBB'))).toBe(true);
    expect(fake.calls.n).toBeGreaterThan(before);
    expect(seriesVersion(readSeries(store, { exchange: 'BINANCE', coin: 'BBB', stepMs: M15 }) as { version?: number })).toBe(1);
    // A second version-2 plan: read again once, then re-used by a third.
    before = fake.calls.n;
    expect(await fetchWith(store, 'V2A-BBB', true, flags('BBB'))).toBe(true);
    expect(fake.calls.n).toBeGreaterThan(before);
    before = fake.calls.n;
    expect(await fetchWith(store, 'V2B-BBB', true, flags('BBB'))).toBe(true);
    expect(fake.calls.n).toBe(before);
  });
});
