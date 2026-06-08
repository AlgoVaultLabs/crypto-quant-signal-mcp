/**
 * TRADE-CALL-ROUTING-RESOLVER-W1 R2 — equity-universe membership check.
 *
 * The handler-side async edge that feeds the pure resolver's `inEquityUniverse`
 * boolean. Reuses the EXISTING universe SoT (`getAllUniverseSymbols`) — no
 * parallel list — behind a lazy TTL Set cache so the bare-route path does not
 * re-hit Postgres on every call. Fail-open: a universe-read error returns false,
 * so the caller routes to perp BINANCE (today's pre-wave behavior).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted: the spy must exist before the hoisted vi.mock factory runs AND be
// referenceable in the test body for call-count assertions.
const { getAllUniverseSymbols } = vi.hoisted(() => ({
  getAllUniverseSymbols: vi.fn(async () => ['AAPL', 'TSLA', 'SPY', 'BRK.B']),
}));
vi.mock('../src/lib/equities/equity-store.js', () => ({
  getEquityPool: vi.fn(() => ({})),
  getAllUniverseSymbols,
}));

import { isEquityUniverseSymbol, _resetUniverseMembershipCache } from '../src/lib/equities/equity-universe-membership.js';

beforeEach(() => {
  _resetUniverseMembershipCache();
  getAllUniverseSymbols.mockClear();
  getAllUniverseSymbols.mockResolvedValue(['AAPL', 'TSLA', 'SPY', 'BRK.B']);
});

describe('isEquityUniverseSymbol', () => {
  it('true for a symbol in the active equity universe', async () => {
    expect(await isEquityUniverseSymbol('TSLA')).toBe(true);
  });

  it('false for a symbol not in the universe (e.g. a crypto ticker)', async () => {
    expect(await isEquityUniverseSymbol('BTC')).toBe(false);
  });

  it('normalizes the ticker (brk-b → BRK.B matches the universe)', async () => {
    expect(await isEquityUniverseSymbol('brk-b')).toBe(true);
  });

  it('false for empty/invalid input WITHOUT hitting the DB', async () => {
    expect(await isEquityUniverseSymbol('')).toBe(false);
    expect(getAllUniverseSymbols).not.toHaveBeenCalled();
  });

  it('fail-open: returns false when the universe fetch throws', async () => {
    getAllUniverseSymbols.mockRejectedValueOnce(new Error('pg down'));
    expect(await isEquityUniverseSymbol('TSLA')).toBe(false);
  });

  it('caches the universe set — a 2nd lookup within TTL does not re-fetch', async () => {
    await isEquityUniverseSymbol('TSLA');
    await isEquityUniverseSymbol('AAPL');
    expect(getAllUniverseSymbols).toHaveBeenCalledTimes(1);
  });

  it('re-fetches after the TTL window elapses', async () => {
    await isEquityUniverseSymbol('TSLA', 0);
    await isEquityUniverseSymbol('TSLA', 11 * 60_000); // > 10-min TTL
    expect(getAllUniverseSymbols).toHaveBeenCalledTimes(2);
  });
});
