/**
 * SCAN-RANKBY-REFINEMENTS-W1 CH2 — okx-funding-poller.
 *
 * fetchVenueUniverse + the OKX per-instId funding fetch are module-mocked; no live
 * API. Asserts: cold (never warmed) → null (caller falls back to the shortlist);
 * after a warm → the full map + a fresh heartbeat. The request-path getter never
 * fans out (it gates on the heartbeat, not a blocking load).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ExchangeAsset } from '../../src/lib/exchange-universe.js';

vi.mock('../../src/lib/exchange-universe.js', () => ({ fetchVenueUniverse: vi.fn() }));
vi.mock('../../src/lib/adapters/okx.js', () => ({ toOKXInstId: (c: string) => `${c}-USDT-SWAP` }));
vi.mock('../../src/lib/adapters/_upstream-fetch.js', () => ({
  upstreamFetch: vi.fn(),
  VENUE_FETCH_CONFIGS: { OKX: {} },
}));

import { fetchVenueUniverse } from '../../src/lib/exchange-universe.js';
import { upstreamFetch } from '../../src/lib/adapters/_upstream-fetch.js';
import {
  getOkxFullFundingIfWarm,
  okxFullFundingFreshness,
  _resetOkxFullFundingForTest,
  _warmOkxFullFundingForTest,
} from '../../src/lib/okx-funding-poller.js';

const mockUniverse = vi.mocked(fetchVenueUniverse);
const mockUpstream = vi.mocked(upstreamFetch);

function uni(coins: string[]): ExchangeAsset[] {
  return coins.map((coin, i) => ({ coin, notionalOI_usd: (coins.length - i) * 1e6, volume24h_usd: 1e6 }));
}

beforeEach(() => {
  _resetOkxFullFundingForTest();
  mockUniverse.mockReset();
  mockUpstream.mockReset();
});
afterEach(() => _resetOkxFullFundingForTest());

describe('okx-funding-poller (CH2 — full-universe OKX funding)', () => {
  it('cold (never warmed) → getOkxFullFundingIfWarm returns null (→ shortlist fallback)', async () => {
    expect(await getOkxFullFundingIfWarm()).toBeNull();
    expect(okxFullFundingFreshness().size).toBe(0);
  });

  it('after a warm → returns the FULL map; the heartbeat reflects the size', async () => {
    mockUniverse.mockResolvedValue(uni(['BTC', 'ETH', 'SOL']));
    const fundingByInst: Record<string, string> = {
      'BTC-USDT-SWAP': '0.0001',
      'ETH-USDT-SWAP': '-0.0002',
      'SOL-USDT-SWAP': '0.0003',
    };
    mockUpstream.mockImplementation(async (_cfg: unknown, opts: unknown) => {
      const url = (opts as { url: string }).url;
      const inst = decodeURIComponent(url.split('instId=')[1] ?? '');
      return { data: [{ fundingRate: fundingByInst[inst] ?? '' }] } as never;
    });
    const size = await _warmOkxFullFundingForTest();
    expect(size).toBe(3);
    const m = await getOkxFullFundingIfWarm();
    expect(m).not.toBeNull();
    expect(m!.get('ETH')).toBe(-0.0002);
    expect(m!.size).toBe(3); // FULL universe, not a 150 slice
    expect(okxFullFundingFreshness()).toMatchObject({ size: 3, enabled: true });
  });
});
