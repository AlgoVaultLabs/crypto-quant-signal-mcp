/**
 * DEV-TRACK-RECORD-TOOL-PARITY-W1 CH2 — the ONE public projection of the track record.
 *
 * What this file is actually defending. Before this wave the public-safety filtering lived
 * INLINE in the `/api/performance-public` handler, so `performance://signal-performance` —
 * an unauthenticated surface — never had it. Measured against prod on 2026-08-28 the
 * resource itemised 17 venues where the endpoint served 14: BITMART (`retired`), EDGEX
 * (`retired`) and WEEX (`shadow`). BITMART is the sharp end — the estate had WITHDRAWN that
 * venue and a public surface was still publishing its per-asset track record. The resource
 * also served the `1m` shadow timeframe and an `equities` block that is absent from the
 * endpoint's published allow-list and under a standing public-copy HOLD.
 *
 * So the filter moved into ONE exported formatter and every channel calls it. These tests
 * pin the three properties that make that a fix rather than a fourth copy:
 * allow-list-BY-CONSTRUCTION, FAIL-CLOSED, and one derivation.
 *
 * The fixture is a trimmed capture of the REAL live resource payload (2026-08-28), not an
 * invented shape — including the three venues that must not survive.
 */
import { describe, it, expect } from 'vitest';
import {
  PUBLIC_PERF_FORBIDDEN_KEYS,
  PUBLIC_PERF_SECTIONS,
  SHADOW_TIMEFRAMES,
  emptyPublicPerformanceAllowList,
  formatPublicPerformance,
  isPublicTimeframe,
  type PublicPerformanceAllowList,
} from '../../src/lib/public-performance-formatter.js';
import { METHODOLOGY } from '../../src/lib/performance-db.js';
import type { PerformanceStats } from '../../src/types.js';

const tf = (count: number, wr: number | null) => ({ count, evaluated: count, pfeWinRate: wr });
const asset = (count: number, tier: number, wr: number | null) => ({ count, tier, pfeWinRate: wr });

const venueAgg = (exchange: string, count: number) => ({
  exchange,
  count,
  evaluated: count,
  pfeWinRate: 0.9,
  byTimeframe: { '1m': tf(10, 0.9), '3m': tf(20, 0.9), '5m': tf(30, 0.9) },
  byTier: { tier1: tf(count, 0.9) },
  byCallType: { BUY: tf(count, 0.9) },
  byAsset: { BTC: asset(count, 1, 0.9) },
});

/** Trimmed capture of the live producer output — the 3 non-promoted venues included. */
const STATS: PerformanceStats = {
  totalCalls: 520832,
  period: { from: '2026-04-10', to: '2026-08-28' },
  overall: { totalCalls: 520832, totalEvaluated: 514500, pfeWinRate: 0.916862973760933 },
  byCallType: { BUY: tf(479552, 0.9194602462298145), SELL: tf(34948, 0.8812235321048415), HOLD: tf(0, null) },
  byTimeframe: { '1m': tf(7632, 0.92), '3m': tf(120212, 0.93), '5m': tf(143734, 0.92), '1d': tf(1297, 0.59) },
  byAsset: { BTC: asset(9000, 1, 0.93), BNB: asset(5517, 2, 0.9276495182694056) },
  byExchange: {
    BINANCE: venueAgg('BINANCE', 40000),
    GATE: venueAgg('GATE', 44881),
    BITMART: venueAgg('BITMART', 111),   // retired  — must not survive
    EDGEX: venueAgg('EDGEX', 222),       // retired  — must not survive
    WEEX: venueAgg('WEEX', 333),         // shadow   — must not survive
  },
  byTier: {
    tier1: { tier: 1, name: 'Blue Chip', label: 'Tier 1', color: '#58a6ff', count: 25660, evaluated: 25651, pfeWinRate: 0.9254999805075825, assets: ['BTC'] },
  },
  recentSignals: [{ id: 526894, coin: 'BNB', timeframe: '5m', tier: 2, created_at: 1787929962, exchange: 'GATE' }],
  methodology: METHODOLOGY,
};

const PROMOTED: PublicPerformanceAllowList = {
  venues: new Set(['BINANCE', 'GATE']),
  revealedShadowTimeframes: new Set(['3m']), // prod reveals 3m only
  degraded: false,
};

describe('public-performance-formatter — allow-list BY CONSTRUCTION', () => {
  it('drops every venue outside the allow-list, retired and shadow alike', () => {
    const out = formatPublicPerformance(STATS, PROMOTED);
    expect(Object.keys(out.byExchange ?? {}).sort()).toEqual(['BINANCE', 'GATE']);
    for (const gone of ['BITMART', 'EDGEX', 'WEEX']) {
      expect(out.byExchange).not.toHaveProperty(gone);
      // Not merely absent as a key — absent from the serialised body, so no nested
      // reference survives inside another venue's breakdown either.
      expect(JSON.stringify(out)).not.toContain(gone);
    }
  });

  it('a venue newly added to the producer is EXCLUDED with no edit here (the point of an allow-list)', () => {
    const withNewVenue: PerformanceStats = {
      ...STATS,
      byExchange: { ...STATS.byExchange, BRANDNEW: venueAgg('BRANDNEW', 5) },
    };
    const out = formatPublicPerformance(withNewVenue, PROMOTED);
    expect(Object.keys(out.byExchange ?? {}).sort()).toEqual(['BINANCE', 'GATE']);
  });

  it('never emits a forbidden key — including `equities`, which the producer-side payload carried', () => {
    const withEquities = { ...STATS, equities: { state: 'live', overall: { pfeWinRate: 0.9 } } } as unknown as PerformanceStats;
    const out = formatPublicPerformance(withEquities, PROMOTED);

    // Asserted over the KEY SET, recursively — not as a substring of the body. `call` and
    // `confidence` are forbidden as recentSignals FIELD NAMES (the PERFORMANCE-PUBLIC-
    // SANITIZE-W1 leak), and both are substrings of legitimate keys (`totalCalls`,
    // `byCallType`). A substring grep here reports a leak on every healthy payload, which is
    // the guard-that-cries-wolf shape; the key-set predicate is the one that means anything.
    const keys = new Set<string>();
    (function walk(v: unknown): void {
      if (Array.isArray(v)) return v.forEach(walk);
      if (v && typeof v === 'object') {
        for (const [k, child] of Object.entries(v)) { keys.add(k); walk(child); }
      }
    })(out);

    for (const k of PUBLIC_PERF_FORBIDDEN_KEYS) {
      expect(keys.has(k), `forbidden key emitted: ${k}`).toBe(false);
    }
    // Vacuity guard + positive control: the walk really visited the payload, and the
    // predicate really can fire.
    expect(keys.size).toBeGreaterThan(10);
    expect(keys.has('pfeWinRate')).toBe(true);
    expect(keys.has('equities')).toBe(false);
  });

  it('strips shadow timeframes at the top level AND inside each admitted venue', () => {
    const out = formatPublicPerformance(STATS, PROMOTED);
    expect(Object.keys(out.byTimeframe)).not.toContain('1m'); // not revealed
    expect(Object.keys(out.byTimeframe)).toContain('3m');     // revealed in this fixture
    for (const v of Object.values(out.byExchange ?? {})) {
      expect(Object.keys(v.byTimeframe)).not.toContain('1m');
      expect(Object.keys(v.byTimeframe)).toContain('3m');
    }
  });

  it('isPublicTimeframe: shadow only when revealed; every other timeframe always public', () => {
    const none = emptyPublicPerformanceAllowList();
    for (const s of SHADOW_TIMEFRAMES) expect(isPublicTimeframe(s, none)).toBe(false);
    for (const s of SHADOW_TIMEFRAMES) expect(isPublicTimeframe(s, PROMOTED)).toBe(s === '3m');
    expect(isPublicTimeframe('4h', none)).toBe(true);
  });
});

describe('public-performance-formatter — FAIL-CLOSED', () => {
  it('an empty/unreadable venue allow-list emits NO per-venue rows — never all of them', () => {
    const out = formatPublicPerformance(STATS, emptyPublicPerformanceAllowList());
    expect(out.byExchange).toEqual({});
    // This is the SV-02 regression in one assertion: the pre-fix code fell through to the
    // UNFILTERED map when the promoted set was empty, which is how shadow rows reached a
    // public surface. Five venues in, zero out.
    expect(Object.keys(STATS.byExchange)).toHaveLength(5);
  });

  it('an unrevealed shadow timeframe stays stripped when the allow-list is degraded', () => {
    const out = formatPublicPerformance(STATS, emptyPublicPerformanceAllowList());
    expect(Object.keys(out.byTimeframe)).not.toContain('1m');
    expect(Object.keys(out.byTimeframe)).not.toContain('3m');
  });
});

describe('public-performance-formatter — include gating', () => {
  it('defaults to every section (the resource and endpoint keep their shape)', () => {
    const out = formatPublicPerformance(STATS, PROMOTED);
    for (const s of PUBLIC_PERF_SECTIONS) expect(out).toHaveProperty(s);
  });

  it('omits every unrequested section, and the compact head is what remains', () => {
    const out = formatPublicPerformance(STATS, PROMOTED, { include: [] });
    expect(Object.keys(out)).toEqual([
      'totalCalls', 'period', 'overall', 'byCallType', 'byTimeframe', 'byTier', 'methodology',
    ]);
  });

  it('include widens SECTIONS, never ROWS — an explicitly-included byExchange is still filtered', () => {
    const out = formatPublicPerformance(STATS, PROMOTED, { include: ['byExchange'] });
    expect(Object.keys(out.byExchange ?? {}).sort()).toEqual(['BINANCE', 'GATE']);
    expect(out).not.toHaveProperty('byAsset');
    expect(out).not.toHaveProperty('recentSignals');
  });

  it('emits keys in PerformanceStats declaration order, so a full projection serialises byte-identically', () => {
    const out = formatPublicPerformance(STATS, PROMOTED);
    expect(Object.keys(out)).toEqual([
      'totalCalls', 'period', 'overall', 'byCallType', 'byTimeframe',
      'byAsset', 'byExchange', 'byTier', 'recentSignals', 'methodology',
    ]);
  });
});

describe('public-performance-formatter — methodology is a GATE, not silent loss', () => {
  it('projects every key the producer declares (adding one upstream fails here, deliberately)', () => {
    const out = formatPublicPerformance(STATS, PROMOTED);
    expect(Object.keys(out.methodology).sort()).toEqual(Object.keys(METHODOLOGY).sort());
    for (const k of Object.keys(METHODOLOGY)) {
      expect(out.methodology[k]).toEqual(METHODOLOGY[k]);
    }
  });

  it('signalFilter describes the REAL recording gate, and no longer claims a read-time filter', () => {
    // CRYPTO-PFE-BENCHMARK-AUDIT-W1 finding 1: the published string said "Confidence >= 60%"
    // while MIN_TRACKABLE_CONFIDENCE has been 52 since 2026-04-15 and the read path applies
    // NO confidence predicate at all. Measured on prod 2026-08-28: min(confidence) = 52, zero
    // rows below it, and 304,518 of 521,677 rows (58.4%) sit under the disclosed 60% floor.
    const s = String(METHODOLOGY.signalFilter);
    expect(s).not.toMatch(/>=\s*60%/);
    expect(s).toContain('52%');
    expect(s.toLowerCase()).toContain('recording gate');
    expect(s.toLowerCase()).toContain('no further confidence filter');
    expect(s.toLowerCase()).toContain('hold');
  });
});
