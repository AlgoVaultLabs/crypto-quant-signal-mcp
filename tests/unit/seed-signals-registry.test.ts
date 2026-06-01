/**
 * tests/unit/seed-signals-registry.test.ts — OPS-SHADOW-PIPELINE-W1 / C1.
 *
 * The generator fix: seed-signals.ts main() is now data-driven off a
 * UNIVERSE_FETCHERS registry exhaustive over ExchangeId. These tests pin:
 *   - registry exhaustiveness (tsc enforces; this guards against a silent
 *     drift if the Record type is ever loosened),
 *   - the 12 shadow venues are []-returning stubs in C1 (filled in C2),
 *   - parseArgs --status + explicitExchanges (the venue-selection mechanism).
 *
 * Import is now safe: C1 added an `if (require.main === module)` guard so the
 * module no longer fires main() (which would hit the DB) on import.
 */
import { describe, it, expect, vi } from 'vitest';
import { UNIVERSE_FETCHERS, ALL_EXCHANGE_IDS, parseArgs } from '../../src/scripts/seed-signals.js';

const PROMOTED = ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET'] as const;
const SHADOW = ['ASTER', 'EDGEX', 'GATE', 'MEXC', 'KUCOIN', 'PHEMEX', 'BINGX', 'HTX', 'WEEX', 'BITMART', 'XT', 'WHITEBIT'] as const;

describe('UNIVERSE_FETCHERS registry — exhaustiveness + dispatch', () => {
  it('is exhaustive over all 17 ExchangeId values (matches ALL_EXCHANGE_IDS)', () => {
    const keys = Object.keys(UNIVERSE_FETCHERS).sort();
    expect(keys).toEqual([...ALL_EXCHANGE_IDS].sort());
    expect(keys).toHaveLength(17);
  });

  it('every entry is a function', () => {
    for (const id of ALL_EXCHANGE_IDS) {
      expect(typeof UNIVERSE_FETCHERS[id]).toBe('function');
    }
  });

  it('the 12 shadow venue fetchers are fail-soft: HTTP error → [] (no throw) [C2]', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 503 } as Response);
    for (const id of SHADOW) {
      await expect(UNIVERSE_FETCHERS[id](30)).resolves.toEqual([]);
    }
    fetchSpy.mockRestore();
    warn.mockRestore();
  });

  it('exactly 5 promoted + 12 shadow venues are represented', () => {
    expect(ALL_EXCHANGE_IDS.filter(id => (PROMOTED as readonly string[]).includes(id))).toHaveLength(5);
    expect(ALL_EXCHANGE_IDS.filter(id => (SHADOW as readonly string[]).includes(id))).toHaveLength(12);
  });
});

describe('parseArgs — --status + explicitExchanges (C1 venue selection)', () => {
  it('no exchange flag → explicitExchanges=false, statusFilter=null (table-driven default)', () => {
    const r = parseArgs(['--timeframe', '15m']);
    expect(r.explicitExchanges).toBe(false);
    expect(r.statusFilter).toBeNull();
  });

  it('--status shadow → statusFilter=shadow, explicitExchanges=false', () => {
    const r = parseArgs(['--timeframe', '15m', '--status', 'shadow']);
    expect(r.statusFilter).toBe('shadow');
    expect(r.explicitExchanges).toBe(false);
  });

  it('--status all → statusFilter=all', () => {
    expect(parseArgs(['--status', 'all']).statusFilter).toBe('all');
  });

  it('--exchange BINANCE → explicitExchanges=true (override wins, byte-equivalent list)', () => {
    const r = parseArgs(['--exchange', 'BINANCE']);
    expect(r.explicitExchanges).toBe(true);
    expect(r.exchanges).toEqual(['BINANCE']);
  });

  it('--exchange-list ASTER,EDGEX → explicitExchanges=true', () => {
    const r = parseArgs(['--exchange-list', 'ASTER,EDGEX']);
    expect(r.explicitExchanges).toBe(true);
    expect(r.exchanges).toEqual(['ASTER', 'EDGEX']);
  });

  it('invalid --status → process.exit(1)', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((): never => { throw new Error('exit'); }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => parseArgs(['--status', 'bogus'])).toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();
    err.mockRestore();
  });
});
