/**
 * tests/hyperliquid-endtime.test.ts — OPS-HL-SEED-LOAD-W1
 *
 * The HL adapter's getCandles previously fetched [startTime, now], so outcome
 * backfill of an old signal pulled ~5000 candles (HL weight ~104) to use only
 * evalCount (~8). This bounds the fetch with an optional `endTime`, cutting the
 * candle count + the upstream weight ~5×. Covers:
 *   1. endTime is passed into the candleSnapshot request when provided.
 *   2. endTime is omitted (backward-compatible) when not provided.
 *   3. expectedCandleItems (the weightHint source) reflects the BOUNDED window
 *      [startTime, endTime] rather than [startTime, now].
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  HyperliquidAdapter,
  _resetHyperliquidMetaCache,
  expectedCandleItems,
} from '../src/lib/adapters/hyperliquid.js';

describe('hyperliquid getCandles — bounded endTime (OPS-HL-SEED-LOAD-W1)', () => {
  let bodies: Array<Record<string, unknown>>;

  beforeEach(() => {
    bodies = [];
    _resetHyperliquidMetaCache();
    vi.spyOn(global, 'fetch').mockImplementation((async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      bodies.push(body);
      // OPS-CANDLE-REQUEST-OWNER-DERIVATION-W1: the adapter reads HL's market listing (standard + xyz) first.
      if (body.type === 'metaAndAssetCtxs') {
        const name = body.dex === 'xyz' ? 'xyz:GOLD' : 'BTC';
        return new Response(JSON.stringify([{ universe: [{ name }] }, [{}]]), { status: 200 });
      }
      return new Response(JSON.stringify([{ t: 0, o: '1', h: '1', l: '1', c: '1', v: '1' }]), {
        status: 200,
      });
    }) as typeof fetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetHyperliquidMetaCache();
  });

  it('passes endTime into the candleSnapshot request when provided', async () => {
    const adapter = new HyperliquidAdapter();
    const startTime = 1_000_000_000;
    const endTime = startTime + 10 * 900_000; // 10 × 15m candles
    await adapter.getCandles('BTC', '15m', startTime, undefined, endTime);
    const body = bodies.find((b) => b.type === 'candleSnapshot') as
      | { req: { startTime: number; endTime?: number } }
      | undefined;
    expect(body).toBeTruthy();
    expect(body!.req.startTime).toBe(startTime);
    expect(body!.req.endTime).toBe(endTime);
  });

  it('omits endTime from the request when not provided (backward compatible)', async () => {
    const adapter = new HyperliquidAdapter();
    await adapter.getCandles('BTC', '15m', 1_000_000_000);
    const body = bodies.find((b) => b.type === 'candleSnapshot') as
      | { req: { endTime?: number } }
      | undefined;
    expect(body!.req.endTime).toBeUndefined();
  });

  it('expectedCandleItems counts the BOUNDED window when endTime is given', () => {
    const start = 1_000_000_000;
    const end = start + 10 * 900_000; // exactly 10 15m intervals
    // bounded: ~10 (NOT (now-start)/interval which would be enormous)
    expect(expectedCandleItems('15m', start, end)).toBe(10);
    // unbounded fallback (no endTime) → large (to now); just assert it's >> 10
    expect(expectedCandleItems('15m', start)).toBeGreaterThan(1000);
  });
});
