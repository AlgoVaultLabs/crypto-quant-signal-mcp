/**
 * EXCHANGE-SHADOW-PROMOTE-W1 / C4 — public surface filter unit tests.
 * Hardened by OPS-AUDIT-REMEDIATION-MED-W1 / SV-02 to encode FAIL-CLOSED.
 *
 * The `/api/performance-public` byExchange filter is a Data-Integrity hardening
 * gate: it must show ONLY `venues.status='promoted'` rows on the PUBLIC surface.
 * SV-02 found the prior implementation failed OPEN — an empty/erroring venues
 * table fell through to the UNFILTERED `stats.byExchange`, leaking shadow rows.
 * This test pins the FAIL-CLOSED contract: empty promoted set → EMPTY result
 * (never "all"); a thrown lookup → EMPTY result. The happy path (5 promoted)
 * stays byte-identical.
 *
 * The filter helper here replays the EXACT logic of the src/index.ts handler
 * (default `{}` + always-filter, no `size>0` skip, catch → `{}`).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename), '..', '..');

/**
 * FAIL-CLOSED replica of the handler logic. `lookup()` returns the promoted ids
 * (or throws to simulate a venues-table outage). Mirrors src/index.ts:
 *   default {} → always filter to promotedIds → catch sets {}.
 */
function filteredByExchangeFailClosed(
  byExchange: Record<string, unknown>,
  lookup: () => Set<string>,
): Record<string, unknown> {
  let filtered: Record<string, unknown> = {}; // FAIL-CLOSED default (NOT byExchange)
  try {
    const promotedIds = lookup();
    // ALWAYS filter — empty promoted set yields {} (never all). No size>0 skip.
    filtered = Object.fromEntries(
      Object.entries(byExchange).filter(([ex]) => promotedIds.has(ex)),
    );
  } catch {
    filtered = {}; // fail-CLOSED on lookup error
  }
  return filtered;
}

describe('/api/performance-public byExchange filter — fail-CLOSED (SV-02)', () => {
  const STATS = {
    HL: { count: 100 },
    BINANCE: { count: 200 },
    BYBIT: { count: 150 },
    OKX: { count: 80 },
    BITGET: { count: 110 },
    GATEIO: { count: 30 }, // shadow — must be filtered out
    DYDXV4: { count: 25 }, // shadow — must be filtered out
  };
  const PROMOTED5 = ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET'];

  it('returns ONLY promoted venues when both promoted + shadow rows exist', () => {
    const result = filteredByExchangeFailClosed(STATS, () => new Set(PROMOTED5));
    expect(Object.keys(result).sort()).toEqual(['BINANCE', 'BITGET', 'BYBIT', 'HL', 'OKX']);
    expect(result.GATEIO).toBeUndefined();
    expect(result.DYDXV4).toBeUndefined();
  });

  it('happy path: 5 promoted venues unchanged when no shadow venues exist (byte-identical)', () => {
    const fiveOnly = { HL: { count: 100 }, BINANCE: { count: 200 }, BYBIT: { count: 150 }, OKX: { count: 80 }, BITGET: { count: 110 } };
    const result = filteredByExchangeFailClosed(fiveOnly, () => new Set(PROMOTED5));
    expect(Object.keys(result)).toHaveLength(5);
    expect(result).toEqual(fiveOnly);
  });

  it('FAIL-CLOSED: empty promoted set → EMPTY byExchange (never leaks all/shadow)', () => {
    const result = filteredByExchangeFailClosed(STATS, () => new Set());
    expect(Object.keys(result)).toHaveLength(0);
    // explicitly: no shadow row, no promoted row — nothing leaks
    expect(result.GATEIO).toBeUndefined();
    expect(result.HL).toBeUndefined();
  });

  it('FAIL-CLOSED: venues-table lookup throws → EMPTY byExchange (no unfiltered fallthrough)', () => {
    const result = filteredByExchangeFailClosed(STATS, () => {
      throw new Error('Connection terminated unexpectedly');
    });
    expect(Object.keys(result)).toHaveLength(0);
    for (const ex of ['GATEIO', 'DYDXV4', 'HL', 'BINANCE']) {
      expect(result[ex]).toBeUndefined();
    }
  });

  it('FAIL-CLOSED: shadow venue NEVER appears even when its row is the only difference', () => {
    // Only promoted ids are HL+BINANCE; ASTER/EDGEX are shadow and present in stats.
    const stats = { HL: { count: 1 }, BINANCE: { count: 2 }, ASTER: { count: 9 }, EDGEX: { count: 9 } };
    const result = filteredByExchangeFailClosed(stats, () => new Set(['HL', 'BINANCE']));
    expect(Object.keys(result).sort()).toEqual(['BINANCE', 'HL']);
    expect(result.ASTER).toBeUndefined();
    expect(result.EDGEX).toBeUndefined();
  });
});

describe('/api/performance-public handler source — fail-CLOSED markers (SV-02)', () => {
  const indexTs = readFileSync(join(REPO_ROOT, 'src/index.ts'), 'utf8');

  it('default filteredByExchange is EMPTY ({}) not stats.byExchange', () => {
    // The fail-OPEN default (`let filteredByExchange = stats.byExchange`) is gone.
    expect(indexTs).not.toMatch(/let\s+filteredByExchange\s*=\s*stats\.byExchange/);
    expect(indexTs).toMatch(/let\s+filteredByExchange:[^=]*=\s*\{\}/);
  });

  it('does NOT skip filtering when the promoted set is empty (no size>0 guard)', () => {
    expect(indexTs).not.toMatch(/if\s*\(\s*promotedIds\.size\s*>\s*0\s*\)/);
  });

  it('catch path sets filteredByExchange to {} (fail-CLOSED) + logs it', () => {
    expect(indexTs).toMatch(/filteredByExchange\s*=\s*\{\}/);
    expect(indexTs).toMatch(/fail-CLOSED/i);
  });
});

describe('/api/performance-shadow endpoint shape — auth-gated, internal keys stripped (SV-01)', () => {
  const indexTs = readFileSync(join(REPO_ROOT, 'src/index.ts'), 'utf8');

  it('uses the allow-list formatter (no inline forbidden-key construction)', () => {
    expect(indexTs).toContain('formatShadowVenuePublic');
    // the inline object that leaked the internal keys is gone
    expect(indexTs).not.toMatch(/min_buy_sell_sample:\s*v\.min_buy_sell_sample/);
    expect(indexTs).not.toMatch(/last_eval_pfe_wr:\s*v\.last_eval_pfe_wr/);
  });

  it('auth-gates the route (resolveOwner + authRequired before stats)', () => {
    expect(indexTs).toMatch(/app\.get\('\/api\/performance-shadow', async \(req, res\)/);
    // AUTH-THREE-STATE-W1 CH3 re-anchored this ONE literal. The gate is unchanged and so is its
    // message: `refuseOwner` branches on the credential outcome and falls back to exactly this
    // `authRequired(res, 'An API key is required.')` for ABSENT/MALFORMED. What it adds is that a
    // caller who DID send a key is no longer told they forgot to.
    expect(indexTs).toMatch(/refuseOwner\(res, license, 'An API key is required\.'\)/);
  });

  it('still emits { venues, updated_at } envelope', () => {
    expect(indexTs).toMatch(/res\.json\(\{ venues, updated_at:/);
  });
});

describe('mcp://algovault/venues resource — internal keys stripped (SV-01)', () => {
  const indexTs = readFileSync(join(REPO_ROOT, 'src/index.ts'), 'utf8');

  it('uses the allow-list formatter for the resource', () => {
    expect(indexTs).toContain('venues.map(formatVenueForResource)');
  });

  it('description prose no longer names min_buy_sell_sample / last evaluation stats', () => {
    // pull the venues resource description string and assert the leaked terms are gone
    const descMatch = indexTs.match(/description: "Per-venue lifecycle state machine[^"]*"/);
    expect(descMatch).not.toBeNull();
    const desc = descMatch![0];
    expect(desc).not.toContain('min_buy_sell_sample');
    expect(desc).not.toContain('last evaluation stats');
  });
});
