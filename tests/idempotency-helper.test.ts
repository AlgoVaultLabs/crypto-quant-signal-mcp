/**
 * PRICING-BOT-DELIVERY-METERING-W1 CH1 — the shared claim-once helper.
 *
 * Flat in tests/, beside x402-idempotency-store's neighbours (Step-0 probe P5).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const dbQuery = vi.fn();
const recordIndeterminate = vi.fn();

vi.mock('../src/lib/performance-db.js', () => ({
  dbQuery: (...a: unknown[]) => dbQuery(...a),
  dbExec: vi.fn(),
}));
vi.mock('../src/lib/indeterminate-counter.js', () => ({
  recordIndeterminate: (...a: unknown[]) => recordIndeterminate(...a),
}));

const { tryClaimOnce } = await import('../src/lib/idempotency.js');

const ROW = { idem_key: 'bot:1:2', tracker_key: 'av_live_x', channel: 'bot', tier: 'starter', units: 1 };

beforeEach(() => {
  dbQuery.mockReset();
  recordIndeterminate.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('tryClaimOnce — the three states', () => {
  it('a returned row means this call won the insert → CLAIMED', async () => {
    dbQuery.mockResolvedValue([{ idem_key: 'bot:1:2' }]);
    await expect(tryClaimOnce('entitlement_debits', ['idem_key'], ROW, 'entitlement_debit')).resolves.toBe('CLAIMED');
  });

  it('an empty result means a genuine replay → ALREADY_CLAIMED', async () => {
    dbQuery.mockResolvedValue([]);
    await expect(tryClaimOnce('entitlement_debits', ['idem_key'], ROW, 'entitlement_debit')).resolves.toBe('ALREADY_CLAIMED');
  });

  it('a throw is INDETERMINATE, never ALREADY_CLAIMED — a fault is not a fact about the caller', async () => {
    dbQuery.mockRejectedValue(new Error('connection terminated unexpectedly'));
    await expect(tryClaimOnce('entitlement_debits', ['idem_key'], ROW, 'entitlement_debit')).resolves.toBe('INDETERMINATE');
  });

  it('the INDETERMINATE path COUNTS the fault where a canary can read it', async () => {
    dbQuery.mockRejectedValue(new Error('boom'));
    await tryClaimOnce('entitlement_debits', ['idem_key'], ROW, 'entitlement_debit');
    expect(recordIndeterminate).toHaveBeenCalledTimes(1);
    expect(recordIndeterminate.mock.calls[0][0]).toBe('entitlement_debit');
  });
});

describe('the SQL it builds', () => {
  it('uses DO NOTHING — never DO UPDATE, which would overwrite a row whose state moved on', async () => {
    process.env.DATABASE_URL = 'postgres://x';
    dbQuery.mockResolvedValue([{ idem_key: 'k' }]);
    await tryClaimOnce('entitlement_debits', ['idem_key'], ROW, 'tag');
    const sql = String(dbQuery.mock.calls[0][0]);
    expect(sql).toContain('ON CONFLICT (idem_key) DO NOTHING');
    expect(sql).not.toContain('DO UPDATE');
    expect(sql).toContain('RETURNING idem_key');
    delete process.env.DATABASE_URL;
  });

  it('switches dialect on DATABASE_URL, exactly as the x402 store does', async () => {
    delete process.env.DATABASE_URL;
    dbQuery.mockResolvedValue([]);
    await tryClaimOnce('entitlement_debits', ['idem_key'], ROW, 'tag');
    const sql = String(dbQuery.mock.calls[0][0]);
    expect(sql).toContain('INSERT OR IGNORE');
    expect(sql).not.toContain('ON CONFLICT');
  });

  it('binds every row value positionally, in column order', async () => {
    dbQuery.mockResolvedValue([{ idem_key: 'k' }]);
    await tryClaimOnce('entitlement_debits', ['idem_key'], ROW, 'tag');
    expect(dbQuery.mock.calls[0][1]).toEqual(Object.values(ROW));
  });
});

describe('table and conflictCols are never caller-supplied at runtime', () => {
  it('refuses a table that is not on the literal allowlist', async () => {
    await expect(tryClaimOnce('quota_usage', ['tracker_key'], ROW, 'tag')).resolves.toBe('ALREADY_CLAIMED');
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('refuses conflict columns that disagree with the declaration', async () => {
    await expect(tryClaimOnce('entitlement_debits', ['tracker_key'], ROW, 'tag')).resolves.toBe('ALREADY_CLAIMED');
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('refuses an injection-shaped table name without touching the DB', async () => {
    await expect(
      tryClaimOnce('entitlement_debits; DROP TABLE quota_usage; --', ['idem_key'], ROW, 'tag'),
    ).resolves.toBe('ALREADY_CLAIMED');
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('refuses a row whose column names are not bare identifiers', async () => {
    await expect(
      tryClaimOnce('entitlement_debits', ['idem_key'], { 'idem_key); --': 'x' } as never, 'tag'),
    ).resolves.toBe('ALREADY_CLAIMED');
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('a refusal is ALREADY_CLAIMED, not INDETERMINATE — we know the answer', async () => {
    // INDETERMINATE is reserved for "the DB errored". An unlisted table is a DETERMINED "no".
    await tryClaimOnce('nope', ['idem_key'], ROW, 'tag');
    expect(recordIndeterminate).not.toHaveBeenCalled();
  });
});
