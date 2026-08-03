/**
 * OPS-VENUE-DAY30-DECISION-W1 / CH1 — `review_deadline_at` store surface.
 *
 * Pins the DECISION DEADLINE as a field distinct from the MEASUREMENT FLOOR.
 * The invariant this whole wave exists to protect: an extension moves
 * `review_deadline_at` and NEVER touches `seeding_started_at`, because the
 * pre-wave "extension" (`resetSeedingStarted`) restarted the sample/PFE-WR
 * measurement window along with the clock — discarding, in WEEX's case, 3,412
 * accrued BUY/SELL samples at a 95.15% PFE WR.
 *
 * Mocks `performance-db` exactly like venue-store.test.ts. The `status='shadow'`
 * guard is enforced in SQL, so it is pinned here as a SQL-shape contract; the
 * behavioural both-directions proof (promoted venue ⇒ `UPDATE 0`, shadow venue
 * ⇒ `UPDATE 1`) runs against the real Postgres in the CH1 verification gate,
 * where a WHERE clause can actually be evaluated.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/performance-db.js', () => ({
  dbQuery: vi.fn(),
  dbRun: vi.fn(),
  dbExec: vi.fn(),
}));

import {
  initVenuesTable,
  getVenue,
  setReviewDeadline,
  MAX_EXTENSION_COUNT,
  _resetInitForTest,
} from '../../src/lib/venue-store.js';
import { dbQuery, dbRun, dbExec } from '../../src/lib/performance-db.js';

const mockQuery = vi.mocked(dbQuery);
const mockRun = vi.mocked(dbRun);
const mockExec = vi.mocked(dbExec);

/** The single `UPDATE venues` call setReviewDeadline is expected to make. */
function updateCall(): { sql: string; params: unknown[] } {
  const call = mockQuery.mock.calls.find(c => String(c[0]).includes('UPDATE venues'));
  if (!call) throw new Error('setReviewDeadline issued no UPDATE venues statement');
  return { sql: String(call[0]), params: (call[1] ?? []) as unknown[] };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetInitForTest();
  mockQuery.mockResolvedValue([]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('CH1 — column-ensure guard (D-2: repo idiom, not a third serialization)', () => {
  it('issues an idempotent ALTER for review_deadline_at after the CREATE', async () => {
    await initVenuesTable();
    const sqls = mockExec.mock.calls.map(c => String(c[0]));
    const alter = sqls.find(s => s.includes('ALTER TABLE venues'));
    expect(alter).toBeDefined();
    expect(alter).toMatch(/ALTER TABLE venues ADD COLUMN( IF NOT EXISTS)? review_deadline_at TIMESTAMPTZ/);

    // Ordering matters: the ALTER cannot precede the table it alters.
    const createIdx = sqls.findIndex(s => s.includes('CREATE TABLE IF NOT EXISTS venues'));
    const alterIdx = sqls.findIndex(s => s.includes('ALTER TABLE venues'));
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(alterIdx).toBeGreaterThan(createIdx);
  });

  it('omits IF NOT EXISTS on the SQLite branch — SQLite has no such syntax', async () => {
    // The suite runs without DATABASE_URL, i.e. the SQLite branch. Emitting
    // `ADD COLUMN IF NOT EXISTS` there is a hard syntax error (verified 3.49,
    // DASH-EXTERNAL-ONLY-W1-PATCH-A), so its absence is the assertion.
    expect(process.env.DATABASE_URL).toBeFalsy();
    await initVenuesTable();
    const alter = mockExec.mock.calls.map(c => String(c[0])).find(s => s.includes('ALTER TABLE venues'));
    expect(alter).not.toContain('IF NOT EXISTS');
  });

  it('swallows a SQLite duplicate-column throw AND still creates the index', async () => {
    mockExec.mockImplementation((sql: string) => {
      if (String(sql).includes('ALTER TABLE venues')) {
        throw new Error('SQLITE_ERROR: duplicate column name: review_deadline_at');
      }
    });
    await expect(initVenuesTable()).resolves.toBeUndefined();
    // The dedicated try/catch exists precisely so the throw does not skip this.
    const sqls = mockExec.mock.calls.map(c => String(c[0]));
    expect(sqls.some(s => s.includes('CREATE INDEX IF NOT EXISTS idx_venues_status'))).toBe(true);
  });

  it('is idempotent — a second initVenuesTable() adds no second column', async () => {
    await initVenuesTable();
    const firstCount = mockExec.mock.calls.filter(c => String(c[0]).includes('ALTER TABLE venues')).length;
    await initVenuesTable();
    const secondCount = mockExec.mock.calls.filter(c => String(c[0]).includes('ALTER TABLE venues')).length;
    expect(firstCount).toBe(1);
    expect(secondCount).toBe(1); // the `initialized` flag short-circuits
  });

  it('declares the column in CREATE_VENUES_TABLE_SQL so a fresh DB gets it', async () => {
    await initVenuesTable();
    const create = mockExec.mock.calls.map(c => String(c[0])).find(s => s.includes('CREATE TABLE IF NOT EXISTS venues'));
    expect(create).toContain('review_deadline_at    TIMESTAMPTZ');
  });
});

describe('CH1 — rowToRecord maps review_deadline_at (same shape as promoted_at)', () => {
  const base = {
    exchange_id: 'WEEX', status: 'shadow', asset_count: 723, min_buy_sell_sample: 7230,
    integrated_at: new Date('2026-05-20T15:21:27Z'), promoted_at: null, retired_at: null,
    extension_count: 1, last_eval_at: null, last_eval_pfe_wr: null,
    last_eval_buy_sell_count: 3412, seeding_started_at: new Date('2026-06-11T02:00:00Z'),
    notes: null,
  };

  it('serializes a Date to ISO', async () => {
    mockQuery.mockResolvedValue([{ ...base, review_deadline_at: new Date('2026-10-17T00:00:00Z') }]);
    const v = await getVenue('WEEX');
    expect(v?.review_deadline_at).toBe('2026-10-17T00:00:00.000Z');
  });

  it('passes a string through', async () => {
    mockQuery.mockResolvedValue([{ ...base, review_deadline_at: '2026-10-17T00:00:00.000Z' }]);
    expect((await getVenue('WEEX'))?.review_deadline_at).toBe('2026-10-17T00:00:00.000Z');
  });

  it('maps NULL and a missing column alike to null — never undefined', async () => {
    mockQuery.mockResolvedValue([{ ...base, review_deadline_at: null }]);
    expect((await getVenue('WEEX'))?.review_deadline_at).toBeNull();

    // A pre-migration row shape (column absent from the result set entirely).
    mockQuery.mockResolvedValue([{ ...base }]);
    expect((await getVenue('WEEX'))?.review_deadline_at).toBeNull();
  });

  it('leaves seeding_started_at untouched by the new mapping', async () => {
    mockQuery.mockResolvedValue([{ ...base, review_deadline_at: new Date('2026-10-17T00:00:00Z') }]);
    const v = await getVenue('WEEX');
    expect(v?.seeding_started_at).toBe('2026-06-11T02:00:00.000Z');
  });
});

describe('CH1 — setReviewDeadline', () => {
  const deadline = new Date('2026-10-17T00:00:00Z');

  it('uses an AWAITED dbQuery, never fire-and-forget dbRun (D-3)', async () => {
    await setReviewDeadline('WEEX', deadline);
    expect(mockRun).not.toHaveBeenCalled();
    expect(updateCall().sql).toContain('UPDATE venues');
  });

  it("guards status = 'shadow' — a promoted/retired venue has no pending decision", async () => {
    await setReviewDeadline('WEEX', deadline);
    const { sql, params } = updateCall();
    expect(sql).toContain("WHERE exchange_id = ? AND status = 'shadow'");
    expect(params[params.length - 1]).toBe('WEEX');
  });

  it('NEVER writes seeding_started_at — the whole point of the wave', async () => {
    await setReviewDeadline('WEEX', deadline, { note: ' | test', extensionCount: 2 });
    expect(updateCall().sql).not.toContain('seeding_started_at');
  });

  it('sets only the deadline when no extension budget is spent', async () => {
    await setReviewDeadline('WEEX', deadline);
    const { sql, params } = updateCall();
    expect(sql).toContain('review_deadline_at = ?');
    expect(sql).not.toContain('extension_count');
    expect(sql).not.toContain('notes');
    expect(params).toEqual([deadline, 'WEEX']);
  });

  it('writes extension_count in the SAME statement when supplied (atomic)', async () => {
    await setReviewDeadline('WEEX', deadline, { extensionCount: 2 });
    const { sql, params } = updateCall();
    expect(sql).toContain('extension_count = ?');
    expect(params).toEqual([deadline, 2, 'WEEX']);
    expect(mockQuery.mock.calls.filter(c => String(c[0]).includes('UPDATE venues')).length).toBe(1);
  });

  it('clamps extension_count to the schema CHECK bound — never writes 3', async () => {
    expect(MAX_EXTENSION_COUNT).toBe(2);
    for (const [asked, written] of [[3, 2], [99, 2], [2.7, 2], [-1, 0], [0, 0]] as const) {
      vi.clearAllMocks();
      await setReviewDeadline('WEEX', deadline, { extensionCount: asked });
      expect(updateCall().params[1]).toBe(written);
    }
  });

  it('APPENDS to notes, never overwrites', async () => {
    await setReviewDeadline('WEEX', deadline, { note: ' | auto-deferred 2026-08-03T06:00:00.000Z (#1)' });
    const { sql, params } = updateCall();
    expect(sql).toContain("notes = COALESCE(notes, '') || ?");
    expect(sql).not.toMatch(/notes\s*=\s*\?/);
    expect(params[1]).toBe(' | auto-deferred 2026-08-03T06:00:00.000Z (#1)');
  });

  it('omits the notes clause entirely for an empty note', async () => {
    await setReviewDeadline('WEEX', deadline, { note: '' });
    expect(updateCall().sql).not.toContain('notes');
  });

  it('accepts a null deadline (clears it — decision due now)', async () => {
    await setReviewDeadline('WEEX', null);
    expect(updateCall().params).toEqual([null, 'WEEX']);
  });

  it('orders params to match placeholder order with every option supplied', async () => {
    await setReviewDeadline('WEEX', deadline, { extensionCount: 2, note: ' | x' });
    const { sql, params } = updateCall();
    // deadline, extension_count, note, exchange_id
    expect(params).toEqual([deadline, 2, ' | x', 'WEEX']);
    expect(sql.indexOf('review_deadline_at')).toBeLessThan(sql.indexOf('extension_count'));
    expect(sql.indexOf('extension_count')).toBeLessThan(sql.indexOf('notes'));
  });
});
