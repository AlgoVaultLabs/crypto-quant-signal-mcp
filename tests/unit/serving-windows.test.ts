/**
 * serving-windows.test.ts — OPS-SERVED-CANDLE-TRUTH-W1 CH1: the serving-window registry is the ONE owner of every
 * candle window the product serves, and every consumer reads it.
 *
 * Pins, in order: the registry's rows and values; that each consumer's own window IS the registry's (the same
 * reference where it is a module import, the literal where the consumer is a script outside this wave's writers);
 * SERVING_MAX_PAGES re-derived from the registry and the two split venues' declared reach; the HEAD_STALE_BARS table
 * with its separation from the two measured defects; and the retired `|| 168` default in regimeFetchWindow.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// regime-snapshots and the sampler load performance-db; nothing here touches a store.
vi.mock('../../src/lib/performance-db.js', () => ({ dbQuery: vi.fn().mockResolvedValue([]), dbExec: vi.fn() }));

import {
  SERVING_WINDOWS,
  servingWindowBars,
  servingWindowsFor,
  TRADE_CALL_CANDLE_COUNT,
  CANDLE_COUNTS,
  ATRP_CANDLE_COUNT,
  REGIME_REFERENCE_SHORT_BARS,
  LABELER_PROBE_SERVED_BARS,
  SERVING_MAX_PAGES,
  HEAD_STALE_BARS,
} from '../../src/lib/serving-windows.js';
import { TIMEFRAMES } from '../../src/lib/capabilities.js';
import { intervalMsFor } from '../../src/lib/candle-guard.js';
import { servedCandleStepMs } from '../../src/lib/tf-support.js';
import { REGIME_TIMEFRAMES } from '../../src/lib/tool-param-schema.js';
import { REGIME_SNAPSHOT_TIMEFRAMES } from '../../src/lib/regime-snapshots.js';
import { CANDLE_COUNTS as CORE_CANDLE_COUNTS, regimeFetchWindow } from '../../src/lib/market-regime-core.js';
import { CANDLE_COUNTS as TOOL_CANDLE_COUNTS } from '../../src/tools/get-market-regime.js';
import { REGIME_REFERENCE_SHORT_BARS as SAMPLER_SHORT_BARS } from '../../src/scripts/regime-snapshot-sampler.js';
import { HEAD_ALLOWANCE_BARS } from '../../src/lib/adapters/_history-plan.js';
import { HEAD_ALLOWANCE_BARS as CONTIGUITY_ALLOWANCE } from '../../src/scripts/adapter-history-contiguity.js';
import { servingReachBars as okxReach } from '../../src/lib/adapters/okx.js';
import { servingReachBars as bitgetReach } from '../../src/lib/adapters/bitget.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const H = 3_600_000;

describe('the registry', () => {
  it('declares exactly the five serving consumers, in order, with their units and windows', () => {
    expect(SERVING_WINDOWS.map((r) => [r.consumer, r.unit])).toEqual([
      ['trade_call', 'requested'],
      ['market_regime', 'requested'],
      ['atrp_lens', 'requested'],
      ['regime_reference', 'requested'],
      ['labeler_probe', 'served'],
    ]);
    const every = (n: number) => Object.fromEntries(TIMEFRAMES.map((tf) => [tf, n]));
    expect(SERVING_WINDOWS[0].bars).toEqual(every(100));
    expect(SERVING_WINDOWS[1].bars).toEqual({ '1h': 168, '4h': 42, '1d': 100 });
    expect(SERVING_WINDOWS[2].bars).toEqual(every(50));
    expect(SERVING_WINDOWS[3].bars).toEqual({ '1h': 4, '4h': 4, '1d': 4 });
    expect(SERVING_WINDOWS[4].bars).toEqual(every(5));
    expect([TRADE_CALL_CANDLE_COUNT, ATRP_CANDLE_COUNT, REGIME_REFERENCE_SHORT_BARS, LABELER_PROBE_SERVED_BARS]).toEqual([100, 50, 4, 5]);
    expect(TIMEFRAMES).toHaveLength(11);
  });

  it('every declared timeframe is a product timeframe', () => {
    for (const r of SERVING_WINDOWS) for (const tf of Object.keys(r.bars)) expect(TIMEFRAMES, `${r.consumer} ${tf}`).toContain(tf);
  });

  it('the regime rows equal the tool\'s admitted timeframes and the sampler\'s, exactly', () => {
    const tfsOf = (c: string) => Object.keys(SERVING_WINDOWS.find((r) => r.consumer === c)!.bars).sort();
    expect(tfsOf('market_regime')).toEqual([...REGIME_TIMEFRAMES].sort());
    expect(tfsOf('regime_reference')).toEqual([...REGIME_SNAPSHOT_TIMEFRAMES].sort());
  });

  it('is frozen all the way down', () => {
    expect(Object.isFrozen(SERVING_WINDOWS)).toBe(true);
    for (const r of SERVING_WINDOWS) {
      expect(Object.isFrozen(r), r.consumer).toBe(true);
      expect(Object.isFrozen(r.bars), r.consumer).toBe(true);
    }
    expect(Object.isFrozen(CANDLE_COUNTS)).toBe(true);
    expect(Object.isFrozen(HEAD_STALE_BARS)).toBe(true);
  });

  it('lookups read own keys only: a prototype name is never a timeframe', () => {
    expect(servingWindowBars('trade_call', '4h')).toBe(100);
    expect(servingWindowBars('market_regime', '15m')).toBeUndefined();
    expect(servingWindowBars('trade_call', 'constructor')).toBeUndefined();
    expect(servingWindowBars('market_regime', 'toString')).toBeUndefined();
    expect(servingWindowsFor('constructor')).toEqual([]);
    expect(servingWindowsFor('1d')).toEqual([
      { consumer: 'trade_call', unit: 'requested', bars: 100 },
      { consumer: 'market_regime', unit: 'requested', bars: 100 },
      { consumer: 'atrp_lens', unit: 'requested', bars: 50 },
      { consumer: 'regime_reference', unit: 'requested', bars: 4 },
      { consumer: 'labeler_probe', unit: 'served', bars: 5 },
    ]);
    expect(servingWindowsFor('15m').map((w) => w.consumer)).toEqual(['trade_call', 'atrp_lens', 'labeler_probe']);
  });
});

describe('every consumer reads the registry', () => {
  it('module consumers hold the registry\'s own objects, not copies', () => {
    expect(CORE_CANDLE_COUNTS).toBe(CANDLE_COUNTS);
    expect(TOOL_CANDLE_COUNTS).toBe(CANDLE_COUNTS);
    expect(SAMPLER_SHORT_BARS).toBe(REGIME_REFERENCE_SHORT_BARS);
    expect(CONTIGUITY_ALLOWANCE).toBe(HEAD_ALLOWANCE_BARS);
  });

  it('get_trade_call computes its window from TRADE_CALL_CANDLE_COUNT, and the retired literal is gone', () => {
    const s = src('src/tools/get-trade-call.ts');
    expect(s).toContain("import { TRADE_CALL_CANDLE_COUNT } from '../lib/serving-windows.js';");
    expect(s).toContain('const startTime = Date.now() - TRADE_CALL_CANDLE_COUNT * intervalMs;');
    expect(s).not.toMatch(/Date\.now\(\) - 100 \* intervalMs/);
  });

  it('the ATRP lens imports ATRP_CANDLE_COUNT and holds no private copy', () => {
    const s = src('src/lib/rank-metrics.ts');
    expect(s).toContain("import { ATRP_CANDLE_COUNT } from './serving-windows.js';");
    expect(s).not.toMatch(/const ATRP_CANDLE_COUNT\s*=/);
  });

  it('the regime fetch window and the sampler\'s short read read the registry', () => {
    expect(src('src/lib/market-regime-core.ts')).toContain("const candleCount = servingWindowBars('market_regime', timeframe);");
    const s = src('src/scripts/regime-snapshot-sampler.ts');
    expect(s).toContain("import { REGIME_REFERENCE_SHORT_BARS } from '../lib/serving-windows.js';");
    expect(s).not.toMatch(/const REGIME_REFERENCE_SHORT_BARS\s*=/);
  });

  it('the labeler probe — a script outside this registry\'s writers — still asks exactly LABELER_PROBE_SERVED_BARS served bars', () => {
    const s = src('src/scripts/backfill-directional-labels.ts');
    const probes = [...s.matchAll(/getCandles\(coin, timeframe, Date\.now\(\) - (\d+) \* stepMs\)/g)];
    expect(probes).toHaveLength(1);
    expect(Number(probes[0][1])).toBe(LABELER_PROBE_SERVED_BARS);
  });
});

describe('SERVING_MAX_PAGES', () => {
  it('is max over the split venues of ⌈window ÷ single-request reach⌉ + 1, from the registry and the adapters\' declared reach', () => {
    const rows: Array<{ venue: string; tf: string; consumer: string; pages: number }> = [];
    for (const [venue, reach] of [['OKX', okxReach], ['BITGET', bitgetReach]] as const) {
      for (const tf of TIMEFRAMES) {
        const r = reach(tf);
        const step = servedCandleStepMs(venue, tf);
        if (r == null || step == null) continue;
        for (const w of servingWindowsFor(tf)) {
          const served = w.unit === 'served' ? w.bars : Math.ceil((w.bars * intervalMsFor(tf)!) / step);
          rows.push({ venue, tf, consumer: w.consumer, pages: Math.ceil(served / r) + 1 });
        }
      }
    }
    expect(rows.length).toBeGreaterThan(50); // the derivation iterated the registry, not a hand list
    const max = Math.max(...rows.map((x) => x.pages));
    expect(max).toBe(SERVING_MAX_PAGES);
    // The binding pair is BITGET 1d@100: the recent endpoint returns at most 90 days.
    expect(rows.filter((x) => x.pages === max).map((x) => `${x.venue} ${x.tf} ${x.consumer}`).sort())
      .toEqual(['BITGET 1d market_regime', 'BITGET 1d trade_call']);
    expect(bitgetReach('1d')).toBe(90);
    expect(okxReach('1h')).toBe(300);
  });
});

describe('HEAD_STALE_BARS', () => {
  it('is the R0 P6 calibration, one ceiling per product timeframe', () => {
    expect(HEAD_STALE_BARS).toEqual({ '1m': 50, '3m': 40, '5m': 24, '15m': 68, '30m': 34, '1h': 17, '2h': 9, '4h': 4, '8h': 2, '12h': 1, '1d': 1 });
    expect(Object.keys(HEAD_STALE_BARS).sort()).toEqual([...TIMEFRAMES].sort());
  });

  it('separates both measured defects from every legitimate head gap (R0 P6: OKX 1h 67 bars, BITGET 1d 9 bars)', () => {
    expect(67).toBeGreaterThan(HEAD_STALE_BARS['1h']);
    expect(9).toBeGreaterThan(HEAD_STALE_BARS['1d']);
  });

  it('is never tighter than the assembler\'s completion allowance, so a window the assembler calls complete is never refused', () => {
    expect(HEAD_ALLOWANCE_BARS).toBe(1);
    expect(Math.min(...Object.values(HEAD_STALE_BARS))).toBeGreaterThanOrEqual(HEAD_ALLOWANCE_BARS);
  });
});

describe('regimeFetchWindow', () => {
  it('turns the registry row into startTime on every declared timeframe', () => {
    const now = Date.UTC(2026, 9, 22, 12);
    expect(regimeFetchWindow('1h', now)).toEqual({ candleCount: 168, intervalMs: H, startTime: now - 168 * H });
    expect(regimeFetchWindow('4h', now)).toEqual({ candleCount: 42, intervalMs: 4 * H, startTime: now - 42 * 4 * H });
    expect(regimeFetchWindow('1d', now)).toEqual({ candleCount: 100, intervalMs: 24 * H, startTime: now - 100 * 24 * H });
  });

  it('refuses an undeclared timeframe instead of defaulting to 168 one-hour bars', () => {
    expect(() => regimeFetchWindow('15m', 0)).toThrow("timeframe '15m' has no declared market_regime serving window");
    expect(() => regimeFetchWindow('constructor', 0)).toThrow('has no declared market_regime serving window');
  });
});
