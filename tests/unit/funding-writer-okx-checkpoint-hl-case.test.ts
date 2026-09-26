import { describe, it, expect, vi, beforeEach } from 'vitest';

// OPS-BDIR-V3-PANEL-READINESS-W1 CH1 — two fetch defects in the funding_rates_hist writer
// (`backfill-funding-episodes.js raw`, run by the nightly carry labeler AND the AOE hourly top-up).
//
//  1. OKX: `fetchSeed` ignored the incremental checkpoint and always asked the adapter for
//     "everything since now − 400 d", so the fetch could never be narrowed to the new prints.
//  2. HL: the manifest carries the estate's upper-cased coin (`exchange-universe.ts` upper-cases
//     HL names), but HL's `fundingHistory` is case-sensitive — measured 2026-09-26:
//     coin 'KPEPE' → null, coin 'kPEPE' → 24 prints. kPEPE and kBONK had never accrued a row.
//     The wire name must come from HL's own `meta`, never from a hardcoded k-list.

const env = vi.hoisted(() => {
  // pacing sleeps are real timers in the writer; keep the hermetic run fast
  process.env.BACKFILL_PACING_HL_MS = '1';
  process.env.BACKFILL_PACING_OKX_MS = '1';
  process.env.BACKFILL_PACING_GATE_MS = '1';
  return {
    adapterCalls: [] as Array<{ venue: string; coin: string; startTime: number }>,
    hlPosts: [] as Array<Record<string, unknown>>,
    metaFails: false,
  };
});

vi.mock('../../src/lib/exchange-adapter.js', () => ({
  getAdapter: (venue: string) => ({
    getFundingHistory: async (coin: string, startTime: number) => {
      env.adapterCalls.push({ venue, coin, startTime });
      return [{ time: startTime + 1, fundingRate: 0.0001 }];
    },
  }),
}));

vi.mock('../../src/lib/adapters/_upstream-fetch.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/adapters/_upstream-fetch.js')>()),
  VENUE_FETCH_CONFIGS: { HL: {}, OKX: {}, GATE: {}, BINANCE: {}, BYBIT: {}, ASTER: {}, KUCOIN: {} },
  upstreamFetch: vi.fn(async (_cfg: unknown, req: { url: string; body?: string }) => {
    const body = JSON.parse(req.body ?? '{}') as Record<string, unknown>;
    env.hlPosts.push(body);
    if (body.type === 'meta') {
      if (env.metaFails) throw new Error('simulated meta failure');
      return { universe: [{ name: 'BTC' }, { name: 'kPEPE' }, { name: 'kBONK' }] };
    }
    if (body.type === 'fundingHistory') {
      // HL is case-sensitive on the coin (measured): only the native name returns data.
      if (!['BTC', 'kPEPE', 'kBONK'].includes(String(body.coin))) return null;
      return [{ time: Number(body.startTime) + 3_600_000, fundingRate: '0.00001' }];
    }
    throw new Error(`unexpected request ${req.url}`);
  }),
}));

import { fetchVenueFunding, _resetHlNativeNamesForTest } from '../../src/scripts/backfill-funding-episodes.js';

const DAY = 86_400_000;

beforeEach(() => {
  env.adapterCalls.length = 0;
  env.hlPosts.length = 0;
  env.metaFails = false;
  _resetHlNativeNamesForTest?.();
});

describe('funding writer — OKX follows the incremental checkpoint', () => {
  it('passes the checkpoint start to the OKX adapter instead of now − 400 d', async () => {
    const checkpoint = Date.now() - 2 * DAY;
    await fetchVenueFunding('OKX', 'BTC', checkpoint);
    expect(env.adapterCalls).toEqual([{ venue: 'OKX', coin: 'BTC', startTime: checkpoint }]);
  });

  it('a full (non-incremental) OKX run still asks for the whole retained window', async () => {
    const before = Date.now();
    await fetchVenueFunding('OKX', 'BTC');
    expect(env.adapterCalls).toHaveLength(1);
    expect(Math.abs(env.adapterCalls[0].startTime - (before - 400 * DAY))).toBeLessThan(60_000);
  });

  it("GATE's leg is untouched: it still asks for now − 400 d even when a checkpoint exists", async () => {
    const before = Date.now();
    await fetchVenueFunding('GATE', 'BTC', before - 2 * DAY);
    expect(env.adapterCalls).toHaveLength(1);
    expect(Math.abs(env.adapterCalls[0].startTime - (before - 400 * DAY))).toBeLessThan(60_000);
  });
});

describe("funding writer — HL uses the venue's native coin name on the wire", () => {
  it('fetches kPEPE for the manifest coin KPEPE (resolved from HL meta)', async () => {
    const pts = await fetchVenueFunding('HL', 'KPEPE', Date.now() - DAY);
    const funding = env.hlPosts.filter((b) => b.type === 'fundingHistory');
    expect(funding.length).toBeGreaterThan(0);
    expect(funding.every((b) => b.coin === 'kPEPE')).toBe(true);
    expect(pts.length).toBeGreaterThan(0);
  });

  it('an already-native coin is sent unchanged', async () => {
    await fetchVenueFunding('HL', 'BTC', Date.now() - DAY);
    const funding = env.hlPosts.filter((b) => b.type === 'fundingHistory');
    expect(funding.every((b) => b.coin === 'BTC')).toBe(true);
  });

  it('reads HL meta once per process, not once per coin', async () => {
    await fetchVenueFunding('HL', 'KPEPE', Date.now() - DAY);
    await fetchVenueFunding('HL', 'KBONK', Date.now() - DAY);
    expect(env.hlPosts.filter((b) => b.type === 'meta')).toHaveLength(1);
    expect(env.hlPosts.filter((b) => b.type === 'fundingHistory').map((b) => b.coin)).toEqual(['kPEPE', 'kBONK']);
  });

  it('a meta failure falls back to the manifest name and never throws', async () => {
    env.metaFails = true;
    await expect(fetchVenueFunding('HL', 'BTC', Date.now() - DAY)).resolves.toBeDefined();
    const funding = env.hlPosts.filter((b) => b.type === 'fundingHistory');
    expect(funding.every((b) => b.coin === 'BTC')).toBe(true);
  });
});
