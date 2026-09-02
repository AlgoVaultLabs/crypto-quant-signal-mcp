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
  PROMOTED_VENUE_IDS,
  TIMEFRAMES,
  TIMEFRAME_COUNT,
  floorRoundTo10,
} from '../../src/lib/capabilities.js';
import { getVenueBudget } from '../../src/lib/venue-budget-registry.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename), '..', '..');

describe('capabilities SoT — exchange list', () => {
  it('EXCHANGES has the canonical 15 entries in canonical order', () => {
    // OPS-VENUE-GO-LIVE-2026-06-30: 5→12 (7 appended). OPS-VENUE-GO-LIVE-15-W1: 12→15 (WHITEBIT/BITMART/XT).
    // OPS-BITMART-ENUM-RECONCILE-W1: 15→14 — BITMART retired 2026-08-27, removed from the static SoT
    // so EXCHANGE_COUNT stops overstating (it published 15 while byExchange served 14 for 7 days).
    expect(EXCHANGES.map((e) => e.id)).toEqual(['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'ASTER', 'BINGX', 'GATE', 'HTX', 'KUCOIN', 'MEXC', 'PHEMEX', 'WHITEBIT', 'XT']);
  });
  it('EXCHANGES has display labels for every entry', () => {
    for (const e of EXCHANGES) {
      expect(typeof e.label).toBe('string');
      expect(e.label.length).toBeGreaterThan(0);
    }
  });
  it('EXCHANGE_COUNT === EXCHANGES.length', () => {
    expect(EXCHANGE_COUNT).toBe(EXCHANGES.length);
    expect(EXCHANGE_COUNT).toBe(14);
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

describe('capabilities SoT — leaderboard (LB_EX_*) covers every promoted venue', () => {
  // OPS-VENUE-GO-LIVE-15-W1: LB_EX_ORDER/LABEL/COLOR are plain objects in index.ts (NOT a
  // Record<PromotedVenueId>), so tsc does NOT force them. This text-extraction guard is what fails
  // the build when a venue is added to EXCHANGES but forgotten in the leaderboard — mirrors the
  // TIMEFRAMES↔Zod-enum drift guard above.
  const idx = readFileSync(join(REPO_ROOT, 'src/index.ts'), 'utf8');
  const arrLiteral = (name: string): string[] => {
    const m = idx.match(new RegExp(`var ${name} = \\[([^\\]]+)\\]`));
    expect(m, `${name} array literal not found`).not.toBeNull();
    return m![1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  };
  const objKeys = (name: string): string[] => {
    const m = idx.match(new RegExp(`var ${name} = \\{([^}]+)\\}`));
    expect(m, `${name} object literal not found`).not.toBeNull();
    return [...m![1].matchAll(/(\w+)\s*:/g)].map((x) => x[1]);
  };

  it('LB_EX_ORDER === PROMOTED_VENUE_IDS (same set + order)', () => {
    expect(arrLiteral('LB_EX_ORDER')).toEqual([...PROMOTED_VENUE_IDS]);
  });
  it('LB_EX_LABEL + LB_EX_COLOR have a key for every promoted venue', () => {
    const labels = objKeys('LB_EX_LABEL');
    const colors = objKeys('LB_EX_COLOR');
    for (const id of PROMOTED_VENUE_IDS) {
      expect(labels, `LB_EX_LABEL missing ${id}`).toContain(id);
      expect(colors, `LB_EX_COLOR missing ${id}`).toContain(id);
    }
  });
  // ── OPS-BITMART-ENUM-RECONCILE-W1 — projection parity for the venue CHIP strip ──
  // Four sites on /track-record project the venue list: :4835 (SSR, from EXCHANGES), the leaderboard
  // (guarded by `if (!e) return` against byExchange), the exchange filter TABS, and the client chip
  // re-render. Only the leaderboard is guarded, so for the other three the ONLY thing keeping a
  // retired venue off the public page is that LB_EX_ORDER/EXCHANGES no longer contain it. That makes
  // PARITY the correct assertion — not "chips subset of byExchange", which would still pass while a
  // retired venue sat in the static list (BitMart painted a live chip for 7 days exactly that way).
  it('LB_EX_LABEL / LB_EX_COLOR carry NO key beyond the promoted set (extras ship GREEN otherwise)', () => {
    // `toContain` above proves nothing is MISSING; without this, a leftover retired venue survives as
    // dead data and still paints a chip. This is the assertion that fails on a stale BITMART entry.
    expect([...objKeys('LB_EX_LABEL')].sort()).toEqual([...PROMOTED_VENUE_IDS].sort());
    expect([...objKeys('LB_EX_COLOR')].sort()).toEqual([...PROMOTED_VENUE_IDS].sort());
  });

  it('the chip strip + filter tabs project from LB_EX_ORDER, so they inherit that parity', () => {
    // If either stops projecting from LB_EX_ORDER, the parity above no longer covers it and this
    // test must be revisited — that is the point of asserting the SOURCE, not the output.
    expect(idx, 'chip strip must project from LB_EX_ORDER').toMatch(
      /chipsEl\.innerHTML = LB_EX_ORDER\.map/);
    expect(idx, 'exchange filter tabs must project from LB_EX_ORDER').toMatch(
      /\[\{\s*id:\s*'all'[^\]]*\]\.concat\(LB_EX_ORDER\.map/);
  });

  it('no RETIRED venue appears in any venue projection (the live-page defect this closes)', () => {
    // BITMART was retired 2026-08-27 and kept painting on the public page until 2026-09-03.
    for (const name of ['LB_EX_ORDER', 'LB_EX_LABEL', 'LB_EX_COLOR']) {
      expect(idx.match(new RegExp(`var ${name} = [^;]+;`))![0],
        `${name} still carries a retired venue`).not.toMatch(/BITMART/);
    }
    expect(PROMOTED_VENUE_IDS as readonly string[]).not.toContain('BITMART');
  });

  it('no two venues share a leaderboard colour (Design.md)', () => {
    const m = idx.match(/var LB_EX_COLOR = \{([^}]+)\}/);
    const hexes = [...m![1].matchAll(/'(#[0-9a-fA-F]{3,8})'/g)].map((x) => x[1].toLowerCase());
    expect(hexes.length).toBe(PROMOTED_VENUE_IDS.length);
    expect(new Set(hexes).size).toBe(hexes.length);
  });
});

describe('capabilities SoT — every promoted venue has a rate-limit budget', () => {
  // OPS-VENUE-GO-LIVE-15-W1: VENUE_BUDGETS is a tsc-exhaustive Record<PromotedVenueId>, but this
  // asserts the RUNTIME lookup actually resolves (guards a shadow-only or null budget entry) —
  // the mechanism that keeps a promoted venue from cron-seeding with zero cross-process pacing.
  it('getVenueBudget is non-null for every PromotedVenueId', () => {
    for (const id of PROMOTED_VENUE_IDS) {
      expect(getVenueBudget(id), `no budget for ${id}`).not.toBeNull();
    }
  });
});
