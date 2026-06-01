/**
 * tests/unit/promote-venue.test.ts — OPS-SHADOW-PIPELINE-W1 / C4.
 * Operator-gated promote/retire: criteria re-check + refusal, qualified flip,
 * --force override, retire. Mocks venue-store + computeVenueStats + telegram.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/venue-store.js', () => ({ getVenue: vi.fn(), setStatus: vi.fn() }));
vi.mock('../../src/scripts/evaluate-venues.js', () => ({ computeVenueStats: vi.fn() }));
vi.mock('../../src/lib/telegram.js', () => ({ sendVenueStatusChange: vi.fn().mockResolvedValue(true) }));

import { promoteVenue } from '../../src/scripts/promote-venue.js';
import { retireVenue } from '../../src/scripts/retire-venue.js';
import { getVenue, setStatus } from '../../src/lib/venue-store.js';
import { computeVenueStats } from '../../src/scripts/evaluate-venues.js';
import type { VenueRecord } from '../../src/types.js';

const mockGet = vi.mocked(getVenue);
const mockSet = vi.mocked(setStatus);
const mockStats = vi.mocked(computeVenueStats);

function venue(overrides: Partial<VenueRecord> = {}): VenueRecord {
  return {
    exchange_id: 'GATE', status: 'shadow', asset_count: 100, min_buy_sell_sample: 500,
    integrated_at: '2026-05-16T00:00:00Z', promoted_at: null, retired_at: null,
    extension_count: 0, last_eval_at: null, last_eval_pfe_wr: null,
    last_eval_buy_sell_count: null, seeding_started_at: null, notes: null, ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('promote-venue (C4)', () => {
  it('refuses an unqualified venue (sample < min) without any status change', async () => {
    mockGet.mockResolvedValueOnce(venue());
    mockStats.mockResolvedValueOnce({ days_since: 16, buy_sell_count: 100, pfe_wr: 0.9 });
    expect(await promoteVenue('GATE', false)).toBe(1);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('refuses an unknown venue', async () => {
    mockGet.mockResolvedValueOnce(null);
    expect(await promoteVenue('NOPE', false)).toBe(1);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('refuses to promote a retired venue', async () => {
    mockGet.mockResolvedValueOnce(venue({ status: 'retired' }));
    expect(await promoteVenue('GATE', false)).toBe(1);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('no-ops an already-promoted venue', async () => {
    mockGet.mockResolvedValueOnce(venue({ status: 'promoted' }));
    expect(await promoteVenue('GATE', false)).toBe(0);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('promotes a qualified venue → setStatus(promoted, promoted_at)', async () => {
    const now = new Date('2026-06-05T00:00:00Z');
    mockGet
      .mockResolvedValueOnce(venue())
      .mockResolvedValueOnce(venue({ status: 'promoted', promoted_at: now.toISOString() }));
    mockStats.mockResolvedValueOnce({ days_since: 20, buy_sell_count: 600, pfe_wr: 0.85 });
    expect(await promoteVenue('GATE', false, now)).toBe(0);
    expect(mockSet).toHaveBeenCalledWith('GATE', 'promoted', { promoted_at: now });
  });

  it('--force overrides unmet criteria and promotes', async () => {
    const now = new Date('2026-06-05T00:00:00Z');
    mockGet
      .mockResolvedValueOnce(venue())
      .mockResolvedValueOnce(venue({ status: 'promoted', promoted_at: now.toISOString() }));
    mockStats.mockResolvedValueOnce({ days_since: 5, buy_sell_count: 0, pfe_wr: null });
    expect(await promoteVenue('GATE', true, now)).toBe(0);
    expect(mockSet).toHaveBeenCalledWith('GATE', 'promoted', { promoted_at: now });
  });
});

describe('retire-venue (C4 / D3)', () => {
  it('retires a venue → setStatus(retired, retired_at)', async () => {
    const now = new Date('2026-06-15T00:00:00Z');
    mockGet
      .mockResolvedValueOnce(venue())
      .mockResolvedValueOnce(venue({ status: 'retired', retired_at: now.toISOString() }));
    expect(await retireVenue('GATE', now)).toBe(0);
    expect(mockSet).toHaveBeenCalledWith('GATE', 'retired', { retired_at: now });
  });

  it('no-ops an already-retired venue', async () => {
    mockGet.mockResolvedValueOnce(venue({ status: 'retired' }));
    expect(await retireVenue('GATE')).toBe(0);
    expect(mockSet).not.toHaveBeenCalled();
  });
});
