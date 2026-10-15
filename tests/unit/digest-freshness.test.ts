/**
 * OPS-DIGEST-DELIVERY-DURABLE-W1 CH3 — a digest that never ran is caught: ONE page per missed
 * period, per label. EXECUTED against the real ledger (in-memory SQLite here; PG16 in the
 * Postgres lane), over SYNTHETIC labels cloned from real registry rows, so no test can collide
 * with a real producer's rows on a shared database.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';

vi.hoisted(() => {
  if (!process.env.DATABASE_URL) process.env.PERFORMANCE_DB_PATH = ':memory:';
});

import { randomUUID } from 'node:crypto';
import { closeDbAsync, dbQuery } from '../../src/lib/performance-db.js';
import { DIGEST_REGISTRY, type DigestRegistryRow } from '../../src/lib/digest-registry.js';
import { ensureDigestLedgerSchema, writeRunStamp, writeDigestRun, recordDigestAttempt, recordDigestSkipped } from '../../src/lib/telegram-digest-ledger.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runDigestFreshnessStep, classifyDigestFreshness } from '../../src/scripts/monitor-digest-steps.js';
import type { AlertState } from '../../src/scripts/monitor-page.js';

const H = 3_600_000;
const D = 24 * H;
const T = Date.UTC(2026, 9, 20, 9, 0); // Tue 2026-10-20 09:00Z

const daily = (o: Partial<DigestRegistryRow> = {}): DigestRegistryRow => ({
  ...DIGEST_REGISTRY['venue-readiness-report'],
  sends: 'always',
  catchup: 'none',
  registered_at: '2026-10-01',
  ...o,
});
const lbl = () => `f-${randomUUID().slice(0, 8)}`;
const state = (): AlertState => ({ lastAlerted: {}, consecutiveFails: {} });
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function pager(answers: boolean[] = []) {
  const pages: string[] = [];
  const send = async (msg: string) => {
    pages.push(msg);
    return answers.length ? answers.shift()! : true;
  };
  return { pages, send };
}
async function missedRows(label: string) {
  return dbQuery<{ period_key: string; paged_at: unknown }>(
    `SELECT period_key, paged_at FROM telegram_digest_ledger WHERE label = ? AND status = 'missed'`,
    [label],
  );
}

let logs: string[] = [];
beforeAll(async () => {
  await ensureDigestLedgerSchema();
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await closeDbAsync();
});
function captureLogs() {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
}

describe('digest freshness — attempt recency, one page per missed period', () => {
  it('fresh ⇒ no page, and the summary line counts it', async () => {
    captureLogs();
    const a = lbl();
    await writeRunStamp({ label: a, periodKey: day(T), nowMs: T - H, status: 'attempted' });
    await writeDigestRun({ label: a, periodKey: day(T), nowMs: T - H, ttlS: 21_600, hostLog: 'x', parts: [] });
    const p = pager();
    const r = await runDigestFreshnessStep({ state: state(), nowMs: T, registry: { [a]: daily() }, send: p.send });
    expect(p.pages).toHaveLength(0);
    expect(r.counts).toEqual({ fresh: 1, bootstrap: 0, stale: 0, stuck: 0 });
    expect(logs).toContain('[monitor] DIGEST_FRESHNESS fresh=1 bootstrap=0 stale=0 stuck=0');
  });

  it('1 s past maxInterval + grace ⇒ ONE page naming label, interlock row and log; 10 more ticks ⇒ no second page; a second stale label gets its own', async () => {
    captureLogs();
    const a = lbl();
    const b = lbl();
    const row = daily();
    const last = T - (D + row.grace_s * 1000) - 1_000;
    await writeRunStamp({ label: a, periodKey: day(last), nowMs: last, status: 'attempted' });
    await writeRunStamp({ label: b, periodKey: day(last), nowMs: last, status: 'attempted' });
    const p = pager();
    await runDigestFreshnessStep({ state: state(), nowMs: T, registry: { [a]: row }, send: p.send });
    expect(p.pages).toHaveLength(1);
    expect(p.pages[0]).toContain(a);
    expect(p.pages[0]).toContain(row.interlock_id);
    expect(p.pages[0]).toContain(row.host_log);
    expect(p.pages[0]).toContain('not attempted since');
    for (let i = 1; i <= 10; i++) {
      await runDigestFreshnessStep({ state: state(), nowMs: T + i * 120_000, registry: { [a]: row }, send: p.send });
    }
    expect(p.pages).toHaveLength(1);
    expect((await missedRows(a)).map((r) => r.period_key)).toEqual([day(last + D)]);
    await runDigestFreshnessStep({ state: state(), nowMs: T, registry: { [a]: row, [b]: row }, send: p.send });
    expect(p.pages).toHaveLength(2);
    expect(p.pages[1]).toContain(b);
  });

  it('an UNDELIVERED page writes no missed row and is retried next tick', async () => {
    captureLogs();
    const a = lbl();
    const last = T - 3 * D;
    await writeRunStamp({ label: a, periodKey: day(last), nowMs: last, status: 'attempted' });
    const p = pager([false, true]);
    await runDigestFreshnessStep({ state: state(), nowMs: T, registry: { [a]: daily() }, send: p.send });
    expect(await missedRows(a)).toHaveLength(0);
    expect(logs.join('\n')).toContain('PAGE_UNDELIVERED');
    await runDigestFreshnessStep({ state: state(), nowMs: T + 120_000, registry: { [a]: daily() }, send: p.send });
    expect(p.pages).toHaveLength(2);
    expect(await missedRows(a)).toHaveLength(1);
  });

  it('a CONDITIONAL producer with a `skipped` row is fresh (freshness never keys on delivery)', async () => {
    captureLogs();
    const a = lbl();
    await writeRunStamp({ label: a, periodKey: day(T), nowMs: T - 2 * H, status: 'attempted' });
    await writeRunStamp({ label: a, periodKey: day(T), nowMs: T - 2 * H, status: 'skipped', reason: 'nothing actionable' });
    const p = pager();
    const r = await runDigestFreshnessStep({ state: state(), nowMs: T, registry: { [a]: daily({ sends: 'conditional' }) }, send: p.send });
    expect(r.counts.fresh).toBe(1);
    expect(p.pages).toHaveLength(0);
  });

  it('no row before the bootstrap deadline ⇒ no page + BOOTSTRAP; after it ⇒ a page (no permanent darkness)', async () => {
    captureLogs();
    const a = lbl();
    const row = daily({ registered_at: day(T) });
    const p = pager();
    const before = await runDigestFreshnessStep({ state: state(), nowMs: T, registry: { [a]: row }, send: p.send });
    expect(before.counts.bootstrap).toBe(1);
    expect(p.pages).toHaveLength(0);
    expect(logs.join('\n')).toContain(`DIGEST_FRESHNESS ${a} BOOTSTRAP`);
    const deadline = Date.parse(`${row.registered_at}T00:00:00Z`) + D + row.grace_s * 1000;
    const after = await runDigestFreshnessStep({ state: state(), nowMs: deadline + 1, registry: { [a]: row }, send: p.send });
    expect(after.counts.stale).toBe(1);
    expect(p.pages).toHaveLength(1);
  });

  it('a ledger read error ⇒ DIGEST_FRESHNESS_VERDICT=INDETERMINATE, and NOTHING pages', async () => {
    captureLogs();
    const p = pager();
    const r = await runDigestFreshnessStep({
      state: state(), nowMs: T, registry: { [lbl()]: daily() }, send: p.send,
      readLatest: async () => { throw new Error('connection terminated unexpectedly'); },
    });
    expect(r.verdict).toBe('INDETERMINATE');
    expect(p.pages).toHaveLength(0);
    expect(logs.join('\n')).toContain('[monitor] DIGEST_FRESHNESS_VERDICT=INDETERMINATE connection terminated unexpectedly');
  });

  it('a monthly producer whose last run was 31 days ago is fresh (a 7 8 1 * * gap)', () => {
    const row: DigestRegistryRow = DIGEST_REGISTRY['referral-payout-batch-detect'];
    const last = Date.UTC(2026, 0, 1, 8, 7);
    const v = classifyDigestFreshness('m', row, { id: 1, label: 'm', periodKey: '2026-01', status: 'skipped', attemptedAt: last, runAttempts: 1 }, last + 31 * D);
    expect(v.cls).toBe('fresh');
  });

  it('a run killed after its stamp (still `attempted` past stuck_after_s) ⇒ ONE stuck page, then the run is dead', async () => {
    captureLogs();
    const a = lbl();
    const row = daily();
    await writeRunStamp({ label: a, periodKey: day(T), nowMs: T - row.stuck_after_s * 1000 - 1_000, status: 'attempted' });
    const p = pager();
    const r = await runDigestFreshnessStep({ state: state(), nowMs: T, registry: { [a]: row }, send: p.send });
    expect(r.counts.stuck).toBe(1);
    expect(p.pages).toHaveLength(1);
    expect(p.pages[0]).toContain('never reached a terminal status');
    const again = await runDigestFreshnessStep({ state: state(), nowMs: T + 120_000, registry: { [a]: row }, send: p.send });
    expect(again.counts.fresh).toBe(1);
    expect(p.pages).toHaveLength(1);
  });

  it('the SELF catch-up label is not stuck while its catch-up still has attempts left', async () => {
    captureLogs();
    const a = lbl();
    const row = daily({ catchup: 'self' });
    await writeRunStamp({ label: a, periodKey: day(T), nowMs: T - 2 * H, status: 'attempted' });
    const p = pager();
    const r = await runDigestFreshnessStep({ state: state(), nowMs: T, registry: { [a]: row }, send: p.send });
    expect(r.counts.fresh).toBe(1);
    expect(p.pages).toHaveLength(0);
    await writeRunStamp({ label: a, periodKey: day(T), nowMs: T - 2 * H, status: 'attempted' });
    await writeRunStamp({ label: a, periodKey: day(T), nowMs: T - 2 * H, status: 'attempted' });
    const exhausted = await runDigestFreshnessStep({ state: state(), nowMs: T, registry: { [a]: row }, send: p.send });
    expect(exhausted.counts.stuck).toBe(1);
    expect(p.pages[0]).toContain('catch-up attempts exhausted');
  });
});

describe('AC3 — a dry run is not an attempt', () => {
  it('recordDigestAttempt / recordDigestSkipped with { dryRun: true } write NO ledger row', async () => {
    const count = async () =>
      Number((await dbQuery<{ n: unknown }>(`SELECT COUNT(*) AS n FROM telegram_digest_ledger WHERE label = ?`, ['venue-readiness-report']))[0]?.n ?? 0);
    const before = await count();
    await recordDigestAttempt('venue-readiness-report', { dryRun: true, nowMs: T });
    await recordDigestSkipped('venue-readiness-report', 'dry', { dryRun: true, nowMs: T });
    expect(await count()).toBe(before);
  });

  it('every producer that HAS a dry-run flag passes it to its attempt stamp (and stamps at job start)', () => {
    const REPO = path.resolve(__dirname, '..', '..');
    const withDryRun: Record<string, RegExp> = {
      'src/scripts/venue-readiness-report.ts': /recordDigestAttempt\('venue-readiness-report', \{ dryRun \}\)/,
      'src/scripts/geo-weekly-cron.ts': /recordDigestAttempt\('geo-weekly-cron', \{ dryRun: dryRun \|\| previewSend \}\)/,
      'src/scripts/rate-limit-digest-weekly.ts': /recordDigestAttempt\('rate-limit-digest-weekly', \{ dryRun \}\)/,
      'src/scripts/chat-analytics-digest.ts': /recordDigestAttempt\('chat-analytics-digest', \{ dryRun \}\)/,
      'src/scripts/referral-payout-batch-detect.ts': /recordDigestAttempt\('referral-payout-batch-detect', \{ dryRun \}\)/,
      'scripts/refresh-knowledge-pages.mjs': /recordDigestAttempt\('refresh-knowledge-pages', \{ dryRun \}\)/,
    };
    for (const [file, re] of Object.entries(withDryRun)) {
      expect(readFileSync(path.join(REPO, file), 'utf8'), file).toMatch(re);
    }
  });
});
