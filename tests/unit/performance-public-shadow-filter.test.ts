/**
 * EXCHANGE-SHADOW-PROMOTE-W1 / C4 — public surface filter unit tests.
 * Hardened by OPS-AUDIT-REMEDIATION-MED-W1 / SV-02 to encode FAIL-CLOSED.
 * Re-anchored by DEV-TRACK-RECORD-TOOL-PARITY-W1 CH2 onto the REAL formatter.
 *
 * The byExchange filter is a Data-Integrity hardening gate: only `venues.status='promoted'`
 * rows may reach a PUBLIC surface. SV-02 found the prior implementation failed OPEN — an
 * empty or erroring venues table fell through to the UNFILTERED `stats.byExchange`, leaking
 * shadow rows.
 *
 * WHAT CHANGED, AND WHY THE OLD ANCHOR HAD TO GO. This file used to assert source-text
 * markers (`let filteredByExchange = {}`, a `filteredByExchange = {}` catch) against the
 * handler, because the fail-closed logic was INLINE in `/api/performance-public` and the
 * scenarios below were a hand-written REPLICA of it — "replays the EXACT logic" was the
 * standing comment, i.e. a second derivation the markers existed to tie back to the first.
 * CH2 extracted that logic into `src/lib/public-performance-formatter.ts` so the MCP resource
 * (which had NO filter at all, and was publishing retired and shadow venues) could share it.
 * The markers then pinned literals that no longer exist.
 *
 * Deleting them would have been wrong and so would relaxing them: the guard is real. They are
 * REPOINTED. The scenarios now run through the actual exported formatter rather than a
 * replica, which is strictly stronger — a regression in the real code now fails here instead
 * of only failing a copy of it — and the source block asserts the property that matters today:
 * BOTH public surfaces call the shared formatter and neither re-implements the filter.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatPublicPerformance,
  emptyPublicPerformanceAllowList,
  type PublicPerformanceAllowList,
} from '../../src/lib/public-performance-formatter.js';
import type { PerformanceStats } from '../../src/types.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename), '..', '..');

const venue = (exchange: string, count: number) => ({
  exchange, count, evaluated: count, pfeWinRate: 0.9,
  byTimeframe: {}, byTier: {}, byCallType: {}, byAsset: {},
});

/** Minimal producer output carrying only what this file asserts on. */
const statsWith = (byExchange: Record<string, ReturnType<typeof venue>>): PerformanceStats => ({
  totalCalls: 0,
  period: { from: '', to: '' },
  overall: { totalCalls: 0, totalEvaluated: 0, pfeWinRate: null },
  byCallType: {}, byTimeframe: {}, byAsset: {},
  byExchange,
  byTier: {}, recentSignals: [], methodology: {},
});

const allowing = (ids: string[]): PublicPerformanceAllowList => ({
  venues: new Set(ids),
  revealedShadowTimeframes: new Set(),
  degraded: false,
});

describe('public byExchange filter — fail-CLOSED (SV-02), through the REAL formatter', () => {
  const STATS = statsWith({
    HL: venue('HL', 100),
    BINANCE: venue('BINANCE', 200),
    BYBIT: venue('BYBIT', 150),
    OKX: venue('OKX', 80),
    BITGET: venue('BITGET', 110),
    GATEIO: venue('GATEIO', 30),  // shadow — must be filtered out
    DYDXV4: venue('DYDXV4', 25),  // shadow — must be filtered out
  });
  const PROMOTED5 = ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET'];

  it('returns ONLY promoted venues when both promoted + shadow rows exist', () => {
    const out = formatPublicPerformance(STATS, allowing(PROMOTED5));
    expect(Object.keys(out.byExchange ?? {}).sort()).toEqual(['BINANCE', 'BITGET', 'BYBIT', 'HL', 'OKX']);
    expect(out.byExchange?.GATEIO).toBeUndefined();
    expect(out.byExchange?.DYDXV4).toBeUndefined();
  });

  it('happy path: promoted-only input passes through unchanged', () => {
    const fiveOnly = statsWith({
      HL: venue('HL', 100), BINANCE: venue('BINANCE', 200), BYBIT: venue('BYBIT', 150),
      OKX: venue('OKX', 80), BITGET: venue('BITGET', 110),
    });
    const out = formatPublicPerformance(fiveOnly, allowing(PROMOTED5));
    expect(Object.keys(out.byExchange ?? {})).toHaveLength(5);
    expect(out.byExchange).toEqual(fiveOnly.byExchange);
  });

  it('FAIL-CLOSED: empty promoted set → EMPTY byExchange (never leaks all/shadow)', () => {
    const out = formatPublicPerformance(STATS, allowing([]));
    expect(Object.keys(out.byExchange ?? {})).toHaveLength(0);
    expect(out.byExchange?.GATEIO).toBeUndefined();
    expect(out.byExchange?.HL).toBeUndefined();
  });

  it('FAIL-CLOSED: a degraded allow-list → EMPTY byExchange (no unfiltered fallthrough)', () => {
    const out = formatPublicPerformance(STATS, emptyPublicPerformanceAllowList());
    expect(Object.keys(out.byExchange ?? {})).toHaveLength(0);
    for (const ex of ['GATEIO', 'DYDXV4', 'HL', 'BINANCE']) {
      expect(out.byExchange?.[ex]).toBeUndefined();
    }
  });

  it('FAIL-CLOSED: a shadow venue NEVER appears even when its row is the only difference', () => {
    const stats = statsWith({
      HL: venue('HL', 1), BINANCE: venue('BINANCE', 2),
      ASTER: venue('ASTER', 9), EDGEX: venue('EDGEX', 9),
    });
    const out = formatPublicPerformance(stats, allowing(['HL', 'BINANCE']));
    expect(Object.keys(out.byExchange ?? {}).sort()).toEqual(['BINANCE', 'HL']);
    expect(out.byExchange?.ASTER).toBeUndefined();
    expect(out.byExchange?.EDGEX).toBeUndefined();
  });
});

describe('the allow-list RESOLVER is fail-CLOSED at its source (SV-02, the venues-table outage)', () => {
  it('a throwing venues lookup yields an EMPTY venue set and flags degraded', async () => {
    vi.resetModules();
    vi.doMock('../../src/lib/venue-store.js', () => ({
      listVenues: async () => { throw new Error('Connection terminated unexpectedly'); },
      getActivePromotedVenueIds: async () => ['HL', 'BINANCE'],
    }));
    const mod = await import('../../src/lib/public-performance-formatter.js');
    const allow = await mod.resolvePublicPerformanceAllowList({} as NodeJS.ProcessEnv);
    expect(allow.venues.size).toBe(0);
    expect(allow.degraded).toBe(true);
    vi.doUnmock('../../src/lib/venue-store.js');
    vi.resetModules();
  });

  it('the retired subtraction NARROWS the promoted read — it can never widen it', async () => {
    vi.resetModules();
    vi.doMock('../../src/lib/venue-store.js', () => ({
      // The DB says these three are promoted...
      listVenues: async () => [{ exchange_id: 'HL' }, { exchange_id: 'BINANCE' }, { exchange_id: 'BITMART' }],
      // ...but the retired subtraction (getActivePromotedVenueIds) has dropped BITMART.
      getActivePromotedVenueIds: async () => ['HL', 'BINANCE'],
    }));
    const mod = await import('../../src/lib/public-performance-formatter.js');
    const allow = await mod.resolvePublicPerformanceAllowList({} as NodeJS.ProcessEnv);
    expect([...allow.venues].sort()).toEqual(['BINANCE', 'HL']);
    expect(allow.venues.has('BITMART')).toBe(false);
    vi.doUnmock('../../src/lib/venue-store.js');
    vi.resetModules();
  });
});

describe('public track-record surfaces — ONE shared formatter, no inline re-implementation', () => {
  const indexTs = readFileSync(join(REPO_ROOT, 'src/index.ts'), 'utf8');

  it('both public surfaces call the shared formatter', () => {
    // The MCP resource and the HTTP endpoint. Two call sites, one derivation.
    expect((indexTs.match(/formatPublicPerformance\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((indexTs.match(/resolvePublicPerformanceAllowList\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('the inline filter is GONE — no handler re-derives the promoted set', () => {
    // These are the exact literals SV-02 hardened. Their absence is now the contract: the
    // logic lives in the formatter, and a handler growing its own copy is the regression.
    expect(indexTs).not.toMatch(/let\s+filteredByExchange/);
    expect(indexTs).not.toMatch(/filteredByExchange\s*=\s*\{\}/);
    expect(indexTs).not.toMatch(/const\s+SHADOW_TIMEFRAMES\s*=/);
    expect(indexTs).not.toMatch(/if\s*\(\s*promotedIds\.size\s*>\s*0\s*\)/);
  });

  it('the MCP resource no longer serves the producer value raw', () => {
    // The line this wave removed. It is what published BITMART, EDGEX, WEEX and 1m publicly.
    expect(indexTs).not.toMatch(/JSON\.stringify\(\{\s*\.\.\.stats,\s*equities\s*\}/);
  });
});

describe('/api/performance-shadow endpoint shape — auth-gated, internal keys stripped (SV-01)', () => {
  const indexTs = readFileSync(join(REPO_ROOT, 'src/index.ts'), 'utf8');

  it('uses the allow-list formatter (no inline forbidden-key construction)', () => {
    expect(indexTs).toContain('formatShadowVenuePublic');
    // the inline object that leaked the internal keys is gone
    expect(indexTs).not.toMatch(/min_buy_sell_sample:\s*v\.min_buy_sell_sample/);
    expect(indexTs).not.toMatch(/last_eval_pfe_wr:\s*v\.last_eval_pfe_wr/);
  });

  it('auth-gates the route (resolveOwner + authRequired before stats)', () => {
    expect(indexTs).toMatch(/app\.get\('\/api\/performance-shadow', async \(req, res\)/);
    // AUTH-THREE-STATE-W1 CH3 re-anchored this ONE literal. The gate is unchanged and so is its
    // message: `refuseOwner` branches on the credential outcome and falls back to exactly this
    // `authRequired(res, 'An API key is required.')` for ABSENT/MALFORMED. What it adds is that a
    // caller who DID send a key is no longer told they forgot to.
    expect(indexTs).toMatch(/refuseOwner\(res, license, 'An API key is required\.'\)/);
  });

  it('still emits { venues, updated_at } envelope', () => {
    expect(indexTs).toMatch(/res\.json\(\{ venues, updated_at:/);
  });
});

describe('mcp://algovault/venues resource — internal keys stripped (SV-01)', () => {
  const indexTs = readFileSync(join(REPO_ROOT, 'src/index.ts'), 'utf8');

  it('uses the allow-list formatter for the resource', () => {
    expect(indexTs).toContain('venues.map(formatVenueForResource)');
  });

  it('description prose no longer names min_buy_sell_sample / last evaluation stats', () => {
    // pull the venues resource description string and assert the leaked terms are gone
    const descMatch = indexTs.match(/description: "Per-venue lifecycle state machine[^"]*"/);
    expect(descMatch).not.toBeNull();
    const desc = descMatch![0];
    expect(desc).not.toContain('min_buy_sell_sample');
    expect(desc).not.toContain('last evaluation stats');
  });
});
