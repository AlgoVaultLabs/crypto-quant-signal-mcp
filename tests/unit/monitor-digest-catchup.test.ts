/**
 * OPS-DIGEST-DELIVERY-DURABLE-W1 CH3 — the 08:00 digest heals itself.
 *
 * A deploy recreate at the measured 08:00 peak (or a crash) used to kill the monitor digest
 * before `sendDigest` with NO page at all, and nothing re-ran it for 24 h — while the interlock
 * registry called the job "idempotent on next fire". These tests EXECUTE the catch-up step and
 * the period guard against the real ledger, over a synthetic `self` label.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';

vi.hoisted(() => {
  if (!process.env.DATABASE_URL) process.env.PERFORMANCE_DB_PATH = ':memory:';
});

import { randomUUID } from 'node:crypto';
import { closeDbAsync } from '../../src/lib/performance-db.js';
import { chunkSections } from '../../src/lib/markdown-safe.js';
import { DIGEST_REGISTRY, type DigestRegistryRow } from '../../src/lib/digest-registry.js';
import { ensureDigestLedgerSchema, writeRunStamp, writeDigestRun, digestRunFor } from '../../src/lib/telegram-digest-ledger.js';
import {
  runDigestCatchupStep,
  digestPeriodGuard,
  withCatchupFooter,
  CATCHUP_DELAY_MS,
} from '../../src/scripts/monitor-digest-steps.js';

const M = 60_000;
const DUE = Date.UTC(2026, 9, 20, 8, 0); // the 08:00Z due instant
const DAY = '2026-10-20';
const PREV = '2026-10-19';

const selfRow = (o: Partial<DigestRegistryRow> = {}): DigestRegistryRow => ({
  ...DIGEST_REGISTRY['monitor-daily-digest'],
  registered_at: '2026-10-01',
  ...o,
});
const lbl = () => `c-${randomUUID().slice(0, 8)}`;

/** A catch-up `run` that delivers, as runDigest({ catchup: true }) would. */
function runner(label: string, nowMs: number) {
  const calls: string[] = [];
  const run = async (l: string) => {
    calls.push(l);
    await writeDigestRun({ label, periodKey: DAY, nowMs, ttlS: 21_600, hostLog: 'x', parts: [] });
  };
  return { calls, run };
}
async function withEarlierPeriod(label: string) {
  await writeRunStamp({ label, periodKey: PREV, nowMs: DUE - 24 * 60 * M, status: 'attempted' });
}

beforeAll(async () => {
  await ensureDigestLedgerSchema();
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await closeDbAsync();
});

describe('monitor digest self catch-up', () => {
  it('no run row at due + 10 min, with an earlier-period row ⇒ exactly ONE catch-up', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const a = lbl();
    await withEarlierPeriod(a);
    const now = DUE + CATCHUP_DELAY_MS + 2 * M;
    const r = runner(a, now);
    const d = await runDigestCatchupStep({ nowMs: now, run: r.run, registry: { [a]: selfRow() } });
    expect(d[a]).toBe('RAN');
    expect(r.calls).toHaveLength(1);
    const run = await digestRunFor(a, DAY);
    expect(run?.runAttempts).toBe(1);
    expect(run?.status).toBe('delivered');
  });

  it('no earlier-period row (the deploy day) ⇒ none: BOOTSTRAP', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const a = lbl();
    const r = runner(a, DUE + 30 * M);
    const d = await runDigestCatchupStep({ nowMs: DUE + 30 * M, run: r.run, registry: { [a]: selfRow() } });
    expect(d[a]).toBe('BOOTSTRAP');
    expect(r.calls).toHaveLength(0);
  });

  it('before due + 10 min ⇒ none: NOT_DUE', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const a = lbl();
    await withEarlierPeriod(a);
    const r = runner(a, DUE + 5 * M);
    expect((await runDigestCatchupStep({ nowMs: DUE + 5 * M, run: r.run, registry: { [a]: selfRow() } }))[a]).toBe('NOT_DUE');
    expect(r.calls).toHaveLength(0);
  });

  it('the cron run already delivered ⇒ none: ALREADY_DONE', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const a = lbl();
    await withEarlierPeriod(a);
    await writeDigestRun({ label: a, periodKey: DAY, nowMs: DUE, ttlS: 21_600, hostLog: 'x', parts: [] });
    const r = runner(a, DUE + 30 * M);
    expect((await runDigestCatchupStep({ nowMs: DUE + 30 * M, run: r.run, registry: { [a]: selfRow() } }))[a]).toBe('ALREADY_DONE');
    expect(r.calls).toHaveLength(0);
  });

  it('`attempted` 16 min old with run_attempts=1 (killed mid-run) ⇒ catch-up, run_attempts=2', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const a = lbl();
    await withEarlierPeriod(a);
    await writeRunStamp({ label: a, periodKey: DAY, nowMs: DUE, status: 'attempted' });
    const now = DUE + 16 * M;
    const r = runner(a, now);
    expect((await runDigestCatchupStep({ nowMs: now, run: r.run, registry: { [a]: selfRow() } }))[a]).toBe('RAN');
    expect((await digestRunFor(a, DAY))?.runAttempts).toBe(2);
  });

  it('`attempted` only 5 min old ⇒ none: IN_FLIGHT (the cron run may still be sending)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const a = lbl();
    await withEarlierPeriod(a);
    await writeRunStamp({ label: a, periodKey: DAY, nowMs: DUE + 20 * M, status: 'attempted' });
    const r = runner(a, DUE + 25 * M);
    expect((await runDigestCatchupStep({ nowMs: DUE + 25 * M, run: r.run, registry: { [a]: selfRow() } }))[a]).toBe('IN_FLIGHT');
  });

  it('run_attempts=3 ⇒ none: EXHAUSTED (the freshness step\'s stuck page owns it)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const a = lbl();
    await withEarlierPeriod(a);
    for (let i = 0; i < 3; i++) await writeRunStamp({ label: a, periodKey: DAY, nowMs: DUE, status: 'attempted' });
    const r = runner(a, DUE + 60 * M);
    expect((await runDigestCatchupStep({ nowMs: DUE + 60 * M, run: r.run, registry: { [a]: selfRow() } }))[a]).toBe('EXHAUSTED');
    expect(r.calls).toHaveLength(0);
  });

  it('two concurrent ticks ⇒ ONE claim, one run', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const a = lbl();
    await withEarlierPeriod(a);
    const now = DUE + 12 * M;
    const r = runner(a, now);
    const [x, y] = await Promise.all([
      runDigestCatchupStep({ nowMs: now, run: r.run, registry: { [a]: selfRow() } }),
      runDigestCatchupStep({ nowMs: now, run: r.run, registry: { [a]: selfRow() } }),
    ]);
    expect([x[a], y[a]].sort()).toEqual(['CLAIM_LOST', 'RAN']);
    expect(r.calls).toHaveLength(1);
  });

  it('the cron\'s own run after a delivered catch-up ⇒ ALREADY_DELIVERED (zero POSTs); --force ⇒ FORCED', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const a = lbl();
    await withEarlierPeriod(a);
    const now = DUE + 12 * M;
    const r = runner(a, now);
    await runDigestCatchupStep({ nowMs: now, run: r.run, registry: { [a]: selfRow() } });
    expect(await digestPeriodGuard(a, selfRow(), now + M, false)).toBe('ALREADY_DELIVERED');
    expect(await digestPeriodGuard(a, selfRow(), now + M, true)).toBe('FORCED');
    const fresh = lbl();
    expect(await digestPeriodGuard(fresh, selfRow(), now, false)).toBe('PROCEED');
  });

  it('a `catchup: none` label is never caught up', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const a = lbl();
    await withEarlierPeriod(a);
    const r = runner(a, DUE + 30 * M);
    const d = await runDigestCatchupStep({ nowMs: DUE + 30 * M, run: r.run, registry: { [a]: selfRow({ catchup: 'none' }) } });
    expect(d[a]).toBeUndefined();
    expect(r.calls).toHaveLength(0);
  });

  it('the cap trips ⇒ CATCHUP_FAILED, and the step returns normally', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...m: unknown[]) => { logs.push(m.map(String).join(' ')); });
    const a = lbl();
    await withEarlierPeriod(a);
    const d = await runDigestCatchupStep({
      nowMs: DUE + 12 * M, run: () => new Promise(() => {}), registry: { [a]: selfRow() }, capMs: 50,
    });
    expect(d[a]).toBe('CATCHUP_FAILED');
    expect(logs.join('\n')).toContain(`[monitor] CATCHUP_FAILED ${a}`);
    expect(logs.join('\n')).toContain(`[monitor] CATCHUP_DECISION=CATCHUP_FAILED label=${a}`);
  });
});

describe('the catch-up footer — fits-only, never an extra message', () => {
  it('rides the last section when it fits', () => {
    const out = withCatchupFooter(['a', 'b'], selfRow(), DUE + 12 * M, chunkSections);
    expect(out[1]).toBe('b\n\n⏱ catch-up 08:12Z — the 08:00Z run did not complete');
  });
  it('is dropped when it would add a message', () => {
    const big = ['x'.repeat(4_090)];
    expect(withCatchupFooter(big, selfRow(), DUE, chunkSections)).toEqual(big);
  });
});
