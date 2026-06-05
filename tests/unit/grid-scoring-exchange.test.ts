/**
 * tests/unit/grid-scoring-exchange.test.ts — OPS-GRID-EXCHANGE-TRUTH-W1 (R2, DRIFT-3 guard)
 *
 * The generator drift-guard the rest of the suite was missing: every other grid
 * test injects a synthetic GridCell via `_setScorerOverride`, which short-circuits
 * BEFORE the real cell-construction path — so the production `exchange` label was
 * untested and could silently re-drift from the scoring venue.
 *
 * This test runs with override=NULL and mocks `getTradeSignal`, so `refreshGrid`
 * executes the REAL construction and we assert: (1) every produced GridCell.exchange
 * equals `GRID_SCORING_EXCHANGE`, and (2) the scorer is invoked with that same
 * exchange — i.e. the public provenance label IS the venue that actually scored.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the per-cell scorer so the REAL grid construction path runs offline
// (no live exchange APIs, no recursion back into getGridSnapshot).
vi.mock('../../src/tools/get-trade-call.js', () => ({
  getTradeSignal: vi.fn(async ({ coin, timeframe }: { coin: string; timeframe: string }) => ({
    coin,
    timeframe,
    call: 'BUY',
    confidence: 70,
    regime: 'TRENDING_UP',
  })),
}));

import {
  getGridSnapshot,
  _clearCache,
  _setScorerOverride,
  GRID_SCORING_EXCHANGE,
} from '../../src/lib/cross-asset-grid.js';
import { getTradeSignal } from '../../src/tools/get-trade-call.js';

describe('grid scoring-exchange provenance (OPS-GRID-EXCHANGE-TRUTH-W1)', () => {
  beforeEach(() => {
    _clearCache();
    _setScorerOverride(null); // exercise the REAL scorer path, not the synthetic override
    vi.clearAllMocks();
  });

  it('stamps every GridCell.exchange with the venue it actually scores on', async () => {
    const snapshot = await getGridSnapshot();
    expect(snapshot.length).toBeGreaterThan(0);
    for (const cell of snapshot) {
      // The label is the SAME symbol passed to the scorer — cannot drift by construction.
      expect(cell.exchange).toBe(GRID_SCORING_EXCHANGE);
    }
  });

  it('passes GRID_SCORING_EXCHANGE explicitly to the scorer (label == scoring venue)', async () => {
    await getGridSnapshot();
    expect(getTradeSignal).toHaveBeenCalled();
    for (const call of vi.mocked(getTradeSignal).mock.calls) {
      expect(call[0]).toMatchObject({ exchange: GRID_SCORING_EXCHANGE, internal: true });
    }
  });

  it('GRID_SCORING_EXCHANGE is BINANCE (the get_trade_call default the grid scores on)', () => {
    // Locks the constant to the documented default; a future per-cell-routing change
    // updates this + the labels together by construction.
    expect(GRID_SCORING_EXCHANGE).toBe('BINANCE');
  });
});
