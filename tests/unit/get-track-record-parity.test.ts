/**
 * DEV-TRACK-RECORD-TOOL-PARITY-W1 CH2 — the tool is the SAME aggregate, per included section.
 *
 * The wave's whole safety argument is that `get_track_record` is a channel projection and not
 * a new disclosure. That argument is only worth something if it is MECHANICALLY checked, so
 * this file asserts the tool's payload against `formatPublicPerformance` — the shared filtered
 * formatter — over the same producer value, section by section.
 *
 * It is deliberately NOT asserted against the raw producer output. The raw value is the thing
 * this wave is repairing: it carries retired and shadow venues, the 1m shadow timeframe and an
 * `equities` block, none of which may reach a public channel. An oracle that still contains
 * the defect cannot certify the fix.
 *
 * `_algovault` is envelope, not payload, so it is excluded from the identity comparison — and
 * asserted PRESENT separately, so "excluded from identity" cannot quietly decay into
 * "not checked".
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PerformanceStats } from '../../src/types.js';

const { mockStats, mockAllow } = vi.hoisted(() => ({ mockStats: vi.fn(), mockAllow: vi.fn() }));

vi.mock('../../src/resources/signal-performance.js', () => ({
  getSignalPerformance: (...a: unknown[]) => mockStats(...a),
}));

// The formatter is mocked ONLY for `resolvePublicPerformanceAllowList` (which needs a DB);
// `formatPublicPerformance` stays the REAL implementation, because it is the oracle.
vi.mock('../../src/lib/public-performance-formatter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/public-performance-formatter.js')>();
  return { ...actual, resolvePublicPerformanceAllowList: (...a: unknown[]) => mockAllow(...a) };
});

import { runGetTrackRecord } from '../../src/tools/get-track-record.js';
import {
  PUBLIC_PERF_SECTIONS,
  PUBLIC_PERF_FORBIDDEN_KEYS,
  formatPublicPerformance,
  type PublicPerformanceAllowList,
} from '../../src/lib/public-performance-formatter.js';

const tf = (count: number, wr: number | null) => ({ count, evaluated: count, pfeWinRate: wr });
const asset = (count: number, tier: number, wr: number | null) => ({ count, tier, pfeWinRate: wr });
const venueAgg = (exchange: string, count: number) => ({
  exchange, count, evaluated: count, pfeWinRate: 0.9,
  byTimeframe: { '1m': tf(10, 0.9), '5m': tf(30, 0.9) },
  byTier: { tier1: tf(count, 0.9) },
  byCallType: { BUY: tf(count, 0.9) },
  byAsset: { BTC: asset(count, 1, 0.9) },
});

const STATS: PerformanceStats = {
  totalCalls: 520832,
  period: { from: '2026-04-10', to: '2026-08-28' },
  overall: { totalCalls: 520832, totalEvaluated: 514500, pfeWinRate: 0.916862973760933 },
  byCallType: { BUY: tf(479552, 0.91), SELL: tf(34948, 0.88), HOLD: tf(0, null) },
  byTimeframe: { '1m': tf(7632, 0.92), '5m': tf(143734, 0.92) },
  byAsset: { BTC: asset(9000, 1, 0.93) },
  byExchange: { BINANCE: venueAgg('BINANCE', 40000), WEEX: venueAgg('WEEX', 333) },
  byTier: {
    tier1: { tier: 1, name: 'Blue Chip', label: 'Tier 1', color: '#58a6ff', count: 25660, evaluated: 25651, pfeWinRate: 0.925, assets: ['BTC'] },
  },
  recentSignals: [{ id: 526894, coin: 'BNB', timeframe: '5m', tier: 2, created_at: 1787929962, exchange: 'GATE' }],
  methodology: { pfeWinRate: 'x', note: 'y', evaluationWindows: {}, dataSource: 'z', signalFilter: 'q' },
};

const ALLOW: PublicPerformanceAllowList = {
  venues: new Set(['BINANCE']),
  revealedShadowTimeframes: new Set(),
  degraded: false,
};

beforeEach(() => {
  mockStats.mockReset();
  mockAllow.mockReset();
  mockStats.mockResolvedValue(STATS);
  mockAllow.mockResolvedValue(ALLOW);
});

/** The tool's payload minus the envelope — what must equal the shared formatter's output. */
const withoutEnvelope = (p: Record<string, unknown>): Record<string, unknown> => {
  const { _algovault, ...rest } = p;
  void _algovault;
  return rest;
};

describe('get_track_record — identity against the SHARED FILTERED formatter, per included section', () => {
  it('the default (compact) response equals the formatter with no sections', async () => {
    const { payload, isError } = await runGetTrackRecord();
    expect(isError).toBe(false);
    expect(withoutEnvelope(payload as Record<string, unknown>))
      .toEqual(formatPublicPerformance(STATS, ALLOW, { include: [] }));
  });

  it.each(PUBLIC_PERF_SECTIONS.map((s) => [s]))('including %s equals the formatter for that section', async (section) => {
    const { payload } = await runGetTrackRecord({ include: [section] });
    expect(withoutEnvelope(payload as Record<string, unknown>))
      .toEqual(formatPublicPerformance(STATS, ALLOW, { include: [section] }));
  });

  it('every section at once equals the formatter with every section', async () => {
    const { payload } = await runGetTrackRecord({ include: [...PUBLIC_PERF_SECTIONS] });
    expect(withoutEnvelope(payload as Record<string, unknown>))
      .toEqual(formatPublicPerformance(STATS, ALLOW, { include: [...PUBLIC_PERF_SECTIONS] }));
  });

  it('computes no rate of its own — every number is the producer value, unmodified', async () => {
    const { payload } = await runGetTrackRecord();
    const p = payload as { overall: { pfeWinRate: number }; totalCalls: number };
    expect(p.overall.pfeWinRate).toBe(STATS.overall.pfeWinRate);
    expect(p.totalCalls).toBe(STATS.totalCalls);
  });
});

describe('get_track_record — the row allow-list holds even when a section is asked for by name', () => {
  it('an explicitly-included byExchange still drops the non-promoted venue', async () => {
    const { payload } = await runGetTrackRecord({ include: ['byExchange'] });
    const p = payload as { byExchange: Record<string, unknown> };
    expect(Object.keys(p.byExchange)).toEqual(['BINANCE']);
    expect(JSON.stringify(payload)).not.toContain('WEEX');
  });

  it('the unrevealed shadow timeframe never appears, at any include level', async () => {
    for (const include of [[], ['byExchange'], [...PUBLIC_PERF_SECTIONS]] as string[][]) {
      const { payload } = await runGetTrackRecord({ include });
      const p = payload as { byTimeframe: Record<string, unknown> };
      expect(Object.keys(p.byTimeframe)).not.toContain('1m');
    }
  });

  it('emits no forbidden key, asserted over the key set at full include', async () => {
    const { payload } = await runGetTrackRecord({ include: [...PUBLIC_PERF_SECTIONS] });
    const keys = new Set<string>();
    (function walk(v: unknown): void {
      if (Array.isArray(v)) return v.forEach(walk);
      if (v && typeof v === 'object') for (const [k, c] of Object.entries(v)) { keys.add(k); walk(c); }
    })(payload);
    for (const k of PUBLIC_PERF_FORBIDDEN_KEYS) {
      expect(keys.has(k), `forbidden key emitted: ${k}`).toBe(false);
    }
    expect(keys.size).toBeGreaterThan(10);      // vacuity guard
    expect(keys.has('pfeWinRate')).toBe(true);  // positive control
  });
});

describe('get_track_record — the `_algovault` envelope is present and is NOT part of identity', () => {
  it('carries the public CTA block plus tool, version and the echoed include list', async () => {
    const { payload } = await runGetTrackRecord({ include: ['byAsset'] });
    const meta = (payload as { _algovault: Record<string, unknown> })._algovault;
    expect(meta).toBeTruthy();
    expect(meta.tool).toBe('get_track_record');
    expect(typeof meta.version).toBe('string');
    expect((meta.version as string).length).toBeGreaterThan(0);
    expect(meta.included_sections).toEqual(['byAsset']);
    expect(meta.signal_performance).toBe('performance://signal-performance');
    for (const k of ['brand', 'note', 'get_started', 'docs']) expect(meta).toHaveProperty(k);
  });

  it('is present on the compact default too (the build rule is every tool output)', async () => {
    const { payload } = await runGetTrackRecord();
    expect(payload).toHaveProperty('_algovault');
    expect((payload as { _algovault: { included_sections: string[] } })._algovault.included_sections).toEqual([]);
  });
});

describe('get_track_record — a guard on a live serving path REFUSES, it does not throw', () => {
  it('an unknown include section is refused in-band, with the allowed set listed', async () => {
    const { payload, isError } = await runGetTrackRecord({ include: ['byAsset', 'byOutcome'] });
    expect(isError).toBe(true);
    const p = payload as { error_code: string; message: string; allowed_sections: string[]; suggested_include: string[] };
    expect(p.error_code).toBe('INVALID_INCLUDE');
    expect(p.message).toContain('byOutcome');
    expect(p.allowed_sections).toEqual([...PUBLIC_PERF_SECTIONS]);
    expect(p.suggested_include).toEqual(['byAsset']); // the valid remainder, not an empty shrug
  });

  it('refuses an explicitly-requested byExchange when the venue allow-list is empty, and says WHY', async () => {
    mockAllow.mockResolvedValue({ venues: new Set(), revealedShadowTimeframes: new Set(), degraded: true });
    const { payload, isError } = await runGetTrackRecord({ include: ['byExchange', 'byAsset'] });
    expect(isError).toBe(true);
    const p = payload as { error_code: string; message: string; suggested_include: string[] };
    expect(p.error_code).toBe('VENUE_BREAKDOWN_UNAVAILABLE');
    // "unreadable" and "none listed" are DIFFERENT facts and the caller is told which.
    expect(p.message).toContain('unreadable');
    expect(p.suggested_include).toEqual(['byAsset']);
  });

  it('distinguishes an empty venue registry from an unreadable one', async () => {
    mockAllow.mockResolvedValue({ venues: new Set(), revealedShadowTimeframes: new Set(), degraded: false });
    const { payload } = await runGetTrackRecord({ include: ['byExchange'] });
    expect((payload as { message: string }).message).toContain('No venues');
    expect((payload as { message: string }).message).not.toContain('unreadable');
  });

  it('a DEFAULT call still succeeds while the venue registry is down — one section degrades, not the call', async () => {
    mockAllow.mockResolvedValue({ venues: new Set(), revealedShadowTimeframes: new Set(), degraded: true });
    const { payload, isError } = await runGetTrackRecord();
    expect(isError).toBe(false);
    expect(payload).toHaveProperty('overall');
    expect(payload).not.toHaveProperty('byExchange');
  });
});
