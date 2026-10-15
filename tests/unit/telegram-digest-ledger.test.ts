/**
 * OPS-DIGEST-DELIVERY-DURABLE-W1 CH2 — the digest ledger EXECUTES its SQL; nothing here greps.
 *
 * Backend: whatever this process is given. The default lane has no DATABASE_URL, so the suite
 * runs on an in-memory SQLite (the isolation `performance-db.ts` documents); the Postgres lane
 * (`.github/workflows/postgres-lane.yml`, PG16) sets DATABASE_URL and the SAME assertions run
 * against real Postgres — the BIGINT-as-string and RETURNING paths included. Every test uses
 * its own label, so a shared lane database cannot couple one test to another.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

vi.hoisted(() => {
  if (!process.env.DATABASE_URL) process.env.PERFORMANCE_DB_PATH = ':memory:';
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_CHAT_ID = '-100123';
});

import { randomUUID } from 'node:crypto';
import { dbQuery, closeDbAsync } from '../../src/lib/performance-db.js';
import {
  writeDigestRun,
  drainDigestLedger,
  pageDeadRun,
  ensureDigestLedgerSchema,
  type DrainDeps,
} from '../../src/lib/telegram-digest-ledger.js';
import {
  classifyTelegramFailure,
  sendDigest,
  _setDigestLedgerForTest,
  type DeliveryResult,
} from '../../src/lib/telegram.js';

const BACKEND = process.env.DATABASE_URL ? 'postgres' : 'sqlite';
const T0 = Date.UTC(2026, 9, 15, 8, 0, 5);

const ok = (messageId = 7): DeliveryResult => ({ ok: true, degraded: false, failure: null, attempts: 1, posts: 1, elapsedMs: 5, retryAfterS: null, messageId });
const transient = (retryAfterS: number | null = null): DeliveryResult => ({
  ok: false, degraded: false, attempts: 3, posts: 3, elapsedMs: 10_000, retryAfterS, messageId: null,
  failure: retryAfterS != null
    ? classifyTelegramFailure({ httpStatus: 429, body: JSON.stringify({ ok: false, error_code: 429, description: `Too Many Requests: retry after ${retryAfterS}`, parameters: { retry_after: retryAfterS } }) })
    : classifyTelegramFailure({ error: new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' }) }) }),
});
const content = (): DeliveryResult => ({
  ok: false, degraded: false, attempts: 1, posts: 2, elapsedMs: 50, retryAfterS: null, messageId: null,
  failure: classifyTelegramFailure({ httpStatus: 400, body: '{"ok":false,"error_code":400,"description":"Bad Request: message is too long"}' }),
});
const http502 = (): DeliveryResult => ({
  ok: false, degraded: false, attempts: 1, posts: 1, elapsedMs: 5, retryAfterS: null, messageId: null,
  failure: classifyTelegramFailure({ httpStatus: 502, body: '{"ok":false,"error_code":502,"description":"Bad Gateway"}' }),
});

function scriptedDeps(results: DeliveryResult[]) {
  const sent: string[] = [];
  const pages: string[] = [];
  const deps: DrainDeps = {
    send: async (text) => { sent.push(text); return results.shift() ?? ok(); },
    page: async (msg) => { pages.push(msg); return true; },
  };
  return { deps, sent, pages };
}

async function rows(label: string) {
  return dbQuery<Record<string, unknown>>(
    'SELECT id, period_key, part, status, attempts, next_attempt_at, expires_at, text, delivered_at, tg_message_id, paged_at, last_cause FROM telegram_digest_ledger WHERE label = ? ORDER BY period_key, part',
    [label],
  );
}
const n = (v: unknown) => (v == null ? null : Number(v));
const freshLabel = () => `t-${randomUUID().slice(0, 8)}`;

async function queueOne(label: string, opts: { parts?: number; failPart?: number; result?: DeliveryResult; ttlS?: number; text?: (i: number) => string } = {}) {
  const parts = opts.parts ?? 1;
  const failPart = opts.failPart ?? parts;
  return writeDigestRun({
    label, periodKey: '2026-10-15', nowMs: T0, ttlS: opts.ttlS ?? 21_600, hostLog: '/var/log/test.log',
    parts: Array.from({ length: parts }, (_, i) => ({
      part: i + 1,
      text: opts.text?.(i + 1) ?? `part ${i + 1}`,
      result: i + 1 === failPart ? (opts.result ?? transient()) : ok(),
    })),
  });
}

beforeAll(async () => {
  await ensureDigestLedgerSchema();
});
afterAll(async () => {
  _setDigestLedgerForTest(null);
  await closeDbAsync();
});

describe(`telegram_digest_ledger on ${BACKEND}`, () => {
  it('queue → drain(502) → queued, attempts+1, next_attempt_at advanced → drain(200) → delivered, text NULL, run delivered', async () => {
    const label = freshLabel();
    const rec = await queueOne(label);
    expect(rec.runStatus).toBe('queued');
    expect(rec.deadPage).toBeNull();
    let r = await rows(label);
    const queued = r.find((x) => n(x.part) === 1)!;
    expect(queued.status).toBe('queued');
    expect(n(queued.attempts)).toBe(3);
    expect(n(queued.next_attempt_at)).toBe(T0 + 120_000);
    expect(n(queued.expires_at)).toBe(T0 + 21_600_000);

    const a = scriptedDeps([http502()]);
    const d1 = await drainDigestLedger({ nowMs: T0 + 121_000, deps: a.deps, labels: [label] });
    expect(d1).toMatchObject({ verdict: 'QUEUED', queued: 1, delivered: 0 });
    expect(d1.line).toMatch(/^\[ledger\] DRAIN_VERDICT=QUEUED 1/);
    r = await rows(label);
    const after502 = r.find((x) => n(x.part) === 1)!;
    expect(after502.status).toBe('queued');
    expect(n(after502.attempts)).toBe(4);
    expect(String(after502.last_cause)).toContain('class=http_5xx');
    expect(n(after502.next_attempt_at)).toBe(T0 + 121_000 + 16 * 60_000); // min(60, 2^4) minutes

    const b = scriptedDeps([ok(99)]);
    const early = await drainDigestLedger({ nowMs: T0 + 122_000, deps: b.deps, labels: [label] });
    expect(early.verdict).toBe('IDLE'); // not due yet
    expect(early.line).toBe('[ledger] DRAIN_VERDICT=IDLE'); // every tick prints ONE line, idle included
    expect(b.sent).toHaveLength(0);
    const d2 = await drainDigestLedger({ nowMs: T0 + 121_000 + 16 * 60_000, deps: b.deps, labels: [label] });
    expect(d2).toMatchObject({ verdict: 'DELIVERED', delivered: 1 });
    // The text survived the failed redelivery: it is cleared only AFTER a delivery.
    expect(b.sent[0].startsWith('part 1')).toBe(true);
    r = await rows(label);
    const done = r.find((x) => n(x.part) === 1)!;
    expect(done.status).toBe('delivered');
    expect(done.text).toBeNull();
    expect(n(done.tg_message_id)).toBe(99);
    expect(n(done.delivered_at)).toBe(T0 + 121_000 + 16 * 60_000);
    expect(r.find((x) => n(x.part) === 0)!.status).toBe('delivered');
  });

  it('a 429 retry_after=600 ⇒ next_attempt_at ≥ now + 600 s', async () => {
    const label = freshLabel();
    await queueOne(label, { result: transient(600) });
    const r = await rows(label);
    expect(n(r.find((x) => n(x.part) === 1)!.next_attempt_at)).toBeGreaterThanOrEqual(T0 + 600_000);
  });

  it('the LEASE: two concurrent drains over one due part ⇒ exactly ONE POST', async () => {
    const label = freshLabel();
    await queueOne(label);
    const a = scriptedDeps([ok()]);
    const b = scriptedDeps([ok()]);
    await Promise.all([
      drainDigestLedger({ nowMs: T0 + 121_000, deps: a.deps, labels: [label] }),
      drainDigestLedger({ nowMs: T0 + 121_000, deps: b.deps, labels: [label] }),
    ]);
    expect(a.sent.length + b.sent.length).toBe(1);
  });

  it('past expires_at ⇒ dead and exactly ONE page, never re-paged', async () => {
    const label = freshLabel();
    await queueOne(label, { ttlS: 60 });
    const a = scriptedDeps([]);
    const d = await drainDigestLedger({ nowMs: T0 + 121_000, deps: a.deps, labels: [label] });
    expect(d).toMatchObject({ verdict: 'DEAD', dead: 1, paged: 1 });
    expect(a.sent).toHaveLength(0);
    expect(a.pages).toHaveLength(1);
    expect(a.pages[0]).toContain('FAILED to deliver');
    expect(a.pages[0]).toContain(label);
    const run = (await rows(label)).find((x) => n(x.part) === 0)!;
    expect(run.status).toBe('dead');
    expect(n(run.paged_at)).toBe(T0 + 121_000);
    const again = scriptedDeps([]);
    await drainDigestLedger({ nowMs: T0 + 999_000, deps: again.deps, labels: [label] });
    expect(again.pages).toHaveLength(0);
  });

  it('a content rejection ⇒ dead IMMEDIATELY with a rendered page; pageDeadRun pages it exactly once', async () => {
    const label = freshLabel();
    const rec = await queueOne(label, { result: content() });
    expect(rec.runStatus).toBe('dead');
    expect(rec.deadPage).toContain('DIGEST_UNDELIVERED');
    expect(rec.deadPage).toContain('FAILED to deliver');
    expect(rec.deadPage).toContain('message is too long');
    expect(rec.deadPage).toContain('OPS-DIGEST-DELIVERY-DEAD-W{NEXT}');
    const sent: string[] = [];
    const send = async (m: string) => { sent.push(m); return true; };
    expect(await pageDeadRun({ runId: rec.runId, page: rec.deadPage!, nowMs: T0, send })).toBe('paged');
    expect(await pageDeadRun({ runId: rec.runId, page: rec.deadPage!, nowMs: T0 + 1, send })).toBe('not-claimed');
    expect(sent).toHaveLength(1);
    const a = scriptedDeps([]);
    await drainDigestLedger({ nowMs: T0 + 300_000, deps: a.deps, labels: [label] });
    expect(a.pages).toHaveLength(0);
  });

  it('an UNDELIVERED page leaves paged_at NULL and the next drain retries it', async () => {
    const label = freshLabel();
    const rec = await queueOne(label, { result: content() });
    expect(await pageDeadRun({ runId: rec.runId, page: rec.deadPage!, nowMs: T0, send: async () => false })).toBe('undelivered');
    expect(n((await rows(label)).find((x) => n(x.part) === 0)!.paged_at)).toBeNull();
    const a = scriptedDeps([]);
    const d = await drainDigestLedger({ nowMs: T0 + 300_000, deps: a.deps, labels: [label] });
    expect(d.paged).toBe(1);
    expect(a.pages).toHaveLength(1);
  });

  it('the footer rides the LAST redelivered part only when it fits; a stored part is never re-chunked', async () => {
    const small = freshLabel();
    await queueOne(small, { parts: 2, failPart: 2 });
    const a = scriptedDeps([ok()]);
    await drainDigestLedger({ nowMs: T0 + 121_000, deps: a.deps, labels: [small] });
    expect(a.sent[0]).toMatch(/^part 2\n\n⏱ redelivered 08:02Z · first attempt 08:00:05Z failed: `EAI_AGAIN`$/);

    const big = freshLabel();
    const full = 'x'.repeat(4_090);
    await queueOne(big, { text: () => full });
    const b = scriptedDeps([ok()]);
    await drainDigestLedger({ nowMs: T0 + 121_000, deps: b.deps, labels: [big] });
    expect(b.sent[0]).toBe(full);

    const notLast = freshLabel();
    await queueOne(notLast, { parts: 2, failPart: 1 });
    const c = scriptedDeps([ok()]);
    await drainDigestLedger({ nowMs: T0 + 121_000, deps: c.deps, labels: [notLast] });
    expect(c.sent[0]).toBe('part 1');
  });

  it('the label filter sits BEFORE the LIMIT: earlier-due foreign rows cannot starve a registered part', async () => {
    const mine = freshLabel();
    const foreign = freshLabel();
    for (let i = 0; i < 3; i++) {
      await writeDigestRun({
        label: foreign, periodKey: `2026-10-0${i + 1}`, nowMs: T0 - 3_600_000, ttlS: 21_600, hostLog: 'n/a',
        parts: [{ part: 1, text: `foreign ${i}`, result: transient() }],
      });
    }
    await queueOne(mine);
    const a = scriptedDeps([ok(), ok(), ok(), ok()]);
    await drainDigestLedger({ nowMs: T0 + 121_000, deps: a.deps, labels: [mine], maxParts: 3 });
    expect(a.sent).toEqual([expect.stringMatching(/^part 1/)]);
  });

  it('a __proof__ (or any unregistered) row is NEVER selected by the production drain', async () => {
    await writeDigestRun({
      label: '__proof__', periodKey: `proof-${randomUUID()}`, nowMs: T0, ttlS: 3_600, hostLog: 'n/a',
      parts: [{ part: 1, text: 'proof', result: transient() }],
    });
    const a = scriptedDeps([]);
    await drainDigestLedger({ nowMs: T0 + 10 * 86_400_000, deps: a.deps }); // default = registered labels
    expect(a.sent.filter((t) => t === 'proof')).toHaveLength(0);
  });

  it('BIGINT columns round-trip as numbers through Number() on this backend', async () => {
    const label = freshLabel();
    const rec = await queueOne(label);
    expect(typeof rec.runId).toBe('number');
    expect(Number.isFinite(rec.runId)).toBe(true);
  });
});

describe('AC3 — end to end through sendDigest: only the failed part is redelivered', () => {
  it('a 2-part digest whose part 2 fails transiently ⇒ part 1 POSTed once, part 2 queued; the drain POSTs ONLY part 2', async () => {
    const label = freshLabel();
    // Route the labelled run into THIS backend under a fresh label (a registered label would
    // collide across lanes): the real ledger, re-labelled.
    const real = await import('../../src/lib/telegram-digest-ledger.js');
    _setDigestLedgerForTest({
      recordDigestRun: (args) => real.writeDigestRun({ label, periodKey: '2026-10-15', nowMs: args.nowMs, ttlS: 21_600, hostLog: '/var/log/test.log', parts: args.parts }),
      pageDeadRun: real.pageDeadRun,
    });
    const posts: string[] = [];
    const originalFetch = globalThis.fetch;
    const { _setTelegramTimeForTest } = await import('../../src/lib/telegram.js');
    let clock = T0;
    _setTelegramTimeForTest({ now: () => clock, sleep: async (ms) => { clock += ms; }, random: () => 0 });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    globalThis.fetch = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      const text = String(JSON.parse(String(init?.body)).text);
      posts.push(text);
      if (text.includes('— part 2/2')) throw new TypeError('fetch failed');
      return new Response('{"ok":true,"result":{"message_id":1}}', { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const sections = [`*A* ${'a'.repeat(3_000)}`, `*B* ${'b'.repeat(3_000)}`];
      expect(await sendDigest(sections, { label: 'monitor-daily-digest' })).toBe(false);
      expect(posts.filter((p) => p.includes('— part 1/2'))).toHaveLength(1);
      expect(posts.filter((p) => p.includes('— part 2/2'))).toHaveLength(3);
      expect(posts.some((p) => p.includes('AlgoVault Alert'))).toBe(false); // queued ⇒ silent
      const r = await rows(label);
      expect(r.filter((x) => n(x.part)! > 0).map((x) => [n(x.part), x.status])).toEqual([[2, 'queued']]);

      const drained: string[] = [];
      await drainDigestLedger({
        nowMs: Date.now() + 10 * 60_000,
        deps: { send: async (t) => { drained.push(t); return ok(); }, page: async () => true },
        labels: [label],
      });
      expect(drained).toHaveLength(1);
      expect(drained[0]).toContain('— part 2/2');
      expect(drained[0]).not.toContain('— part 1/2');
    } finally {
      globalThis.fetch = originalFetch;
      _setTelegramTimeForTest(null);
      _setDigestLedgerForTest(null);
      vi.restoreAllMocks();
    }
  });

  it('ledger unavailable ⇒ CH1\'s immediate page, suffixed NOT QUEUED (fail toward noise, never silence)', async () => {
    _setDigestLedgerForTest({
      recordDigestRun: async () => { throw new Error('relation "telegram_digest_ledger" does not exist'); },
      pageDeadRun: async () => 'not-claimed',
    });
    const posts: string[] = [];
    const originalFetch = globalThis.fetch;
    const { _setTelegramTimeForTest } = await import('../../src/lib/telegram.js');
    _setTelegramTimeForTest({ sleep: async () => {} });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    globalThis.fetch = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      const text = String(JSON.parse(String(init?.body)).text);
      posts.push(text);
      if (text.includes('AlgoVault Alert')) return new Response('{"ok":true}', { status: 200 });
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    try {
      expect(await sendDigest(['x'], { label: 'monitor-daily-digest' })).toBe(false);
      const pages = posts.filter((p) => p.includes('AlgoVault Alert'));
      expect(pages).toHaveLength(1);
      expect(pages[0]).toContain('FAILED to deliver');
      expect(pages[0]).toContain('NOT QUEUED');
    } finally {
      globalThis.fetch = originalFetch;
      _setTelegramTimeForTest(null);
      _setDigestLedgerForTest(null);
      vi.restoreAllMocks();
    }
  });
});
