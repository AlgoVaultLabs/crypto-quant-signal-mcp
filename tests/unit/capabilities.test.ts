/**
 * Unit tests for AUTO-TRACE-W1 canonical capability SoT module.
 *
 * Asserts EXCHANGES/EXCHANGE_COUNT shape, TIMEFRAMES match the Zod enum at
 * src/index.ts:97, and floorRoundTo10 behavior for asset_count formatting.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXCHANGES,
  EXCHANGE_COUNT,
  TIMEFRAMES,
  TIMEFRAME_COUNT,
  floorRoundTo10,
} from '../../src/lib/capabilities.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename), '..', '..');

describe('capabilities SoT — exchange list', () => {
  it('EXCHANGES has the canonical 12 entries in canonical order', () => {
    // OPS-VENUE-GO-LIVE-2026-06-30: promoted 5→12 (7 appended alphabetically).
    expect(EXCHANGES.map((e) => e.id)).toEqual(['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'ASTER', 'BINGX', 'GATE', 'HTX', 'KUCOIN', 'MEXC', 'PHEMEX']);
  });
  it('EXCHANGES has display labels for every entry', () => {
    for (const e of EXCHANGES) {
      expect(typeof e.label).toBe('string');
      expect(e.label.length).toBeGreaterThan(0);
    }
  });
  it('EXCHANGE_COUNT === EXCHANGES.length', () => {
    expect(EXCHANGE_COUNT).toBe(EXCHANGES.length);
    expect(EXCHANGE_COUNT).toBe(12);
  });
  it('EXCHANGES is frozen (cannot mutate at runtime)', () => {
    expect(Object.isFrozen(EXCHANGES)).toBe(true);
  });
});

describe('capabilities SoT — timeframe list', () => {
  it('TIMEFRAMES has 11 canonical entries (matches Zod enum at src/index.ts:97)', () => {
    expect(TIMEFRAMES).toEqual(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d']);
    expect(TIMEFRAME_COUNT).toBe(11);
  });
  it('TIMEFRAMES matches the Zod enum literal at src/index.ts (drift guard)', () => {
    // Read src/index.ts and extract the Zod enum to verify they stay in sync.
    const idx = readFileSync(join(REPO_ROOT, 'src/index.ts'), 'utf8');
    const m = idx.match(/timeframe:\s*z\.enum\(\[([^\]]+)\]\)/);
    expect(m).not.toBeNull();
    const enumLiterals = m![1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
    expect(enumLiterals).toEqual([...TIMEFRAMES]);
  });
});

describe('capabilities SoT — floorRoundTo10', () => {
  it('rounds floor to nearest 10', () => {
    expect(floorRoundTo10(718)).toBe(710);
    expect(floorRoundTo10(710)).toBe(710);
    expect(floorRoundTo10(719)).toBe(710);
    expect(floorRoundTo10(720)).toBe(720);
    expect(floorRoundTo10(0)).toBe(0);
    expect(floorRoundTo10(9)).toBe(0);
  });
  it('returns 0 for invalid inputs', () => {
    expect(floorRoundTo10(NaN)).toBe(0);
    expect(floorRoundTo10(-5)).toBe(0);
    expect(floorRoundTo10(Infinity)).toBe(0);
  });
});
