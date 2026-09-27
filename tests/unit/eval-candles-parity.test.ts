// EDGE-ADS1-SCORECARD-W1-V2 CH2 (D34) — the vertical-barrier window is declared in two literal tables:
// the labeler's (directional-labeler.ts) and the outcome path's (pfe-mae.ts). The complete label, the
// expiry column and T_CAP all assume they agree; nothing asserted it until now.

import { describe, expect, it } from 'vitest';
import { EVAL_CANDLES as LABELER } from '../../src/scripts/directional-labeler.js';
import { EVAL_CANDLES as PFE_MAE } from '../../src/lib/pfe-mae.js';

describe('EVAL_CANDLES parity', () => {
  it('labeler == pfe-mae minus the retired 1m lane', () => {
    const { '1m': _retired, ...rest } = PFE_MAE;
    expect(LABELER).toEqual(rest);
  });

  it('covers every labelled timeframe (a parity over nothing proves nothing)', () => {
    expect(Object.keys(LABELER).sort()).toEqual(['12h', '15m', '1d', '1h', '2h', '30m', '3m', '4h', '5m', '8h']);
  });
});
