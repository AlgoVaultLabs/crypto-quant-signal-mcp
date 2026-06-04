/**
 * Unit tests for the TradFi funding interpretation helper
 * (TRADIFI-SIGNAL-HARDENING-W1, R4/R7).
 */
import { describe, it, expect } from 'vitest';
import { tradfiFundingAnnotation } from '../../src/lib/tradfi-funding.js';
import {
  FUNDING_NOTE_PREIPO,
  FUNDING_NOTE_TRADFI,
} from '../../src/lib/market-sessions-constants.js';

describe('tradfiFundingAnnotation', () => {
  it('PREMARKET → FIXED_PREIPO override + pre-IPO note', () => {
    const a = tradfiFundingAnnotation('PREMARKET');
    expect(a.fundingStateOverride).toBe('FIXED_PREIPO');
    expect(a.fundingNote).toBe(FUNDING_NOTE_PREIPO);
    expect(a.fundingNote).toMatch(/fixed/i);
    expect(a.fundingNote).toMatch(/not a sentiment signal/i);
  });

  it.each(['EQUITY', 'KR_EQUITY', 'COMMODITY'] as const)(
    '%s → no state override, structural-near-zero note',
    (cls) => {
      const a = tradfiFundingAnnotation(cls);
      expect(a.fundingStateOverride).toBeNull();
      expect(a.fundingNote).toBe(FUNDING_NOTE_TRADFI);
      expect(a.fundingNote).toMatch(/0% interest component/i);
    },
  );

  it.each(['CRYPTO', 'UNKNOWN'] as const)('%s → no annotation', (cls) => {
    const a = tradfiFundingAnnotation(cls);
    expect(a.fundingStateOverride).toBeNull();
    expect(a.fundingNote).toBeNull();
  });
});
