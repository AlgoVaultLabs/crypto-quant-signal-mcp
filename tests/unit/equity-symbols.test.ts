/** Unit tests — EQUITIES-ENGINE-W1 C2 symbol normalization. */
import { describe, it, expect } from 'vitest';
import { normalizeSymbol, sameSymbol } from '../../src/lib/equities/equity-symbols.js';

describe('normalizeSymbol', () => {
  it('maps dashed share-class form to dotted Nasdaq form', () => {
    expect(normalizeSymbol('BRK-B')).toBe('BRK.B');
    expect(normalizeSymbol('brk-b')).toBe('BRK.B');
    expect(normalizeSymbol('BF-B')).toBe('BF.B');
  });
  it('passes through already-canonical symbols', () => {
    expect(normalizeSymbol('BRK.B')).toBe('BRK.B');
    expect(normalizeSymbol('AAPL')).toBe('AAPL');
  });
  it('uppercases and trims', () => {
    expect(normalizeSymbol(' aapl ')).toBe('AAPL');
    expect(normalizeSymbol('spy')).toBe('SPY');
  });
  it('returns empty for null/empty/invalid', () => {
    expect(normalizeSymbol(null)).toBe('');
    expect(normalizeSymbol(undefined)).toBe('');
    expect(normalizeSymbol('')).toBe('');
    expect(normalizeSymbol('  ')).toBe('');
    expect(normalizeSymbol('A B')).toBe('');     // space invalid
    expect(normalizeSymbol('AA$PL')).toBe('');    // bad char
  });
  it('only rewrites a dash that splits two non-empty alnum chunks', () => {
    expect(normalizeSymbol('-AAPL')).toBe('-AAPL'); // not a class dash; left as-is (invalid-ish but not silently rewritten)
    expect(normalizeSymbol('A-B-C')).toBe('A-B-C'); // multiple dashes untouched
  });
});

describe('sameSymbol', () => {
  it('compares by canonical form', () => {
    expect(sameSymbol('BRK-B', 'brk.b')).toBe(true);
    expect(sameSymbol('AAPL', 'aapl')).toBe(true);
    expect(sameSymbol('AAPL', 'MSFT')).toBe(false);
    expect(sameSymbol('', '')).toBe(false);
  });
});
