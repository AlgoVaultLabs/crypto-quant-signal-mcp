/**
 * IDENTITY-LIFECYCLE-W3 CH1 — the engine's eligibility matrix, idempotency, caps and mode.
 *
 * Every assertion here was PROVEN ABLE TO FAIL by deliberately breaking the logic it guards
 * before the file was committed; the mutations are named in `status.md`. An assertion that
 * cannot fail is decoration, and this estate has met the vacuous shape six times.
 *
 * The suite drives the REAL modules against an in-memory SQLite backend. It does NOT mock
 * `sendLifecycle` itself — a hermetic seam is structurally blind to exactly what it replaces,
 * so the only thing stubbed is the Resend transport at the very edge (`sendLifecycleMessage`),
 * and the ledger, suppression, cap and render paths all execute for real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const KEY = 'a'.repeat(48); // >= 32 chars, not a placeholder — resolveIpHashKey's contract.

function freshEnv(): void {
  vi.resetModules();
  process.env.PERFORMANCE_DB_PATH = ':memory:';
  process.env.ALGOVAULT_IP_HASH_KEY = KEY;
  delete process.env.DATABASE_URL;
  delete process.env.LIFECYCLE_MODE;
}

const CTX = {
  keyMasked: 'av_free_…a1b2',
  used: 160,
  total: 200,
  resetDate: '14 September 2026',
  mcpConfigSnippet: '{\n  "mcpServers": {}\n}',
  periodKey: '2026-08-15T12:57:42.368Z',
};

const RECIPIENT = { recipientId: 'fk_abc123', email: 'Person@Example.com ', identityBound: true };

describe('resolveMode — unset is shadow, and that is the production default', () => {
  beforeEach(freshEnv);

  it('unset ⇒ shadow', async () => {
    const { resolveMode } = await import('../../src/lib/lifecycle/engine.js');
    expect(resolveMode({} as NodeJS.ProcessEnv)).toBe('shadow');
  });

  it('garbage ⇒ shadow, never live — an unparseable flag must not light the engine', async () => {
    const { resolveMode } = await import('../../src/lib/lifecycle/engine.js');
    expect(resolveMode({ LIFECYCLE_MODE: 'LIVE!!' } as unknown as NodeJS.ProcessEnv)).toBe('shadow');
    expect(resolveMode({ LIFECYCLE_MODE: '' } as unknown as NodeJS.ProcessEnv)).toBe('shadow');
  });

  it('off and live-permitted are reachable', async () => {
    const { resolveMode } = await import('../../src/lib/lifecycle/engine.js');
    expect(resolveMode({ LIFECYCLE_MODE: 'off' } as unknown as NodeJS.ProcessEnv)).toBe('off');
    expect(resolveMode({ LIFECYCLE_MODE: 'live-permitted' } as unknown as NodeJS.ProcessEnv)).toBe('live-permitted');
  });
});

describe('eligibility matrix', () => {
  beforeEach(freshEnv);
  afterEach(() => vi.doUnmock('../../src/lib/email.js'));

  it('an address that is NOT identity-bound is never mailed and writes NO ledger row', async () => {
    const eng = await import('../../src/lib/lifecycle/engine.js');
    const { dbQuery } = await import('../../src/lib/performance-db.js');
    const r = await eng.sendLifecycle('quota_80', { ...RECIPIENT, identityBound: false }, CTX);
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('not_identity_bound');
    // No row at all — an un-bound address must leave no trace, not a `suppressed` one.
    const { ensureLifecycleSchema } = await import('../../src/lib/lifecycle/schema.js');
    ensureLifecycleSchema();
    const rows = await dbQuery('SELECT * FROM lifecycle_sends');
    expect(rows.length).toBe(0);
  });

  it('mode=off short-circuits before anything is written', async () => {
    process.env.LIFECYCLE_MODE = 'off';
    const eng = await import('../../src/lib/lifecycle/engine.js');
    const r = await eng.sendLifecycle('quota_80', RECIPIENT, CTX);
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('mode_off');
  });

  it('shadow writes would_send WITH the rendered bytes, and calls Resend NOT AT ALL', async () => {
    const sendSpy = vi.fn();
    vi.doMock('../../src/lib/email.js', async (orig) => ({
      ...(await orig<Record<string, unknown>>()),
      sendLifecycleMessage: sendSpy,
    }));
    const eng = await import('../../src/lib/lifecycle/engine.js');
    const { dbQuery } = await import('../../src/lib/performance-db.js');
    const r = await eng.sendLifecycle('quota_80', RECIPIENT, CTX);
    expect(r.status).toBe('would_send');
    expect(sendSpy).not.toHaveBeenCalled();
    const rows = await dbQuery<{ status: string; rendered_subject: string; rendered_html: string }>(
      'SELECT status, rendered_subject, rendered_html FROM lifecycle_sends',
    );
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('would_send');
    // The whole value of shadow mode is that a human can read the exact bytes first.
    expect(rows[0].rendered_subject).toBe('160 of 200 free calls used');
    expect(rows[0].rendered_html).toContain('/email/unsubscribe/');
  });

  it('a suppressed address lands as `suppressed` and stores NO plaintext address', async () => {
    const eng = await import('../../src/lib/lifecycle/engine.js');
    const { hashEmail } = await import('../../src/lib/lifecycle/identity.js');
    const { addSuppression } = await import('../../src/lib/lifecycle/suppression.js');
    const { dbQuery } = await import('../../src/lib/performance-db.js');
    await addSuppression({ emailHash: hashEmail(RECIPIENT.email), reason: 'unsubscribe' });
    const r = await eng.sendLifecycle('quota_80', RECIPIENT, CTX);
    expect(r.status).toBe('suppressed');
    const rows = await dbQuery<{ recipient_email: string | null }>('SELECT recipient_email FROM lifecycle_sends');
    expect(rows[0].recipient_email).toBeNull();
  });

  it('a `usage`-scoped suppression blocks the four usage steps but NOT product_updates', async () => {
    const eng = await import('../../src/lib/lifecycle/engine.js');
    const { hashEmail } = await import('../../src/lib/lifecycle/identity.js');
    const { addSuppression, isSuppressed } = await import('../../src/lib/lifecycle/suppression.js');
    const h = hashEmail(RECIPIENT.email);
    await addSuppression({ emailHash: h, reason: 'preference', scope: 'usage' });
    for (const step of ['activation_nudge', 'quota_80', 'quota_wall', 'reset_return'] as const) {
      expect(await isSuppressed(h, step)).toBe(true);
    }
    expect(await isSuppressed(h, 'product_updates')).toBe(false);
    void eng;
  });

  // The OFF->ON path (`clearPreferenceSuppression`) lands in CH3 with the /account handler that
  // calls it, and its test goes with it. What CH1 owns is the ROW SHAPE and the asymmetry above:
  // a `usage` row must not reach product_updates, and an `all` row must reach everything.
});

describe('idempotency — the UNIQUE constraint is the mechanism', () => {
  beforeEach(freshEnv);

  it('the same (recipient, step, period) twice yields ONE row and the 2nd call is a no-op', async () => {
    const eng = await import('../../src/lib/lifecycle/engine.js');
    const { dbQuery } = await import('../../src/lib/performance-db.js');
    const first = await eng.sendLifecycle('quota_80', RECIPIENT, CTX);
    const second = await eng.sendLifecycle('quota_80', RECIPIENT, CTX);
    expect(first.status).toBe('would_send');
    expect(second.status).toBe('skipped');
    expect(second.reason).toBe('already_handled');
    const rows = await dbQuery('SELECT * FROM lifecycle_sends');
    expect(rows.length).toBe(1);
  });

  it('a DIFFERENT period for the same recipient+step is a separate, allowed row', async () => {
    const eng = await import('../../src/lib/lifecycle/engine.js');
    const { dbQuery } = await import('../../src/lib/performance-db.js');
    await eng.sendLifecycle('quota_80', RECIPIENT, CTX);
    await eng.sendLifecycle('quota_80', RECIPIENT, { ...CTX, periodKey: '2026-09-14T12:57:42.368Z' });
    const rows = await dbQuery('SELECT * FROM lifecycle_sends');
    // Two periods ⇒ two rows. A cap may still refuse the second; that is a different gate.
    expect(rows.length).toBe(2);
  });

  it('case and whitespace variants of one address are ONE person', async () => {
    const { hashEmail } = await import('../../src/lib/lifecycle/identity.js');
    expect(hashEmail(' Person@Example.com ')).toBe(hashEmail('person@example.com'));
  });
});

describe('frequency caps', () => {
  beforeEach(freshEnv);

  it('a second step on the same UTC day is capped', async () => {
    const eng = await import('../../src/lib/lifecycle/engine.js');
    const now = new Date('2026-09-08T10:00:00.000Z');
    const a = await eng.sendLifecycle('quota_80', RECIPIENT, CTX, { now });
    const b = await eng.sendLifecycle('quota_wall', RECIPIENT, { ...CTX, periodKey: CTX.periodKey }, { now });
    expect(a.status).toBe('would_send');
    expect(b.status).toBe('capped');
    expect(b.reason).toBe('daily_cap');
  });

  it('the 7-day cap refuses the 4th delivery inside a week', async () => {
    const eng = await import('../../src/lib/lifecycle/engine.js');
    const steps = ['quota_80', 'quota_wall', 'reset_return', 'activation_nudge'] as const;
    const results = [];
    for (let i = 0; i < steps.length; i += 1) {
      // One per day, so the DAILY cap never fires and the WEEKLY one is what is under test.
      const now = new Date(Date.UTC(2026, 8, 1 + i, 9, 0, 0));
      results.push(await eng.sendLifecycle(steps[i], RECIPIENT, { ...CTX, periodKey: `p${i}` }, { now }));
    }
    expect(results.slice(0, 3).map((r) => r.status)).toEqual(['would_send', 'would_send', 'would_send']);
    expect(results[3].status).toBe('capped');
    expect(results[3].reason).toBe('weekly_cap');
  });

  /**
   * A `suppressed` outcome must not spend the recipient's daily budget.
   *
   * Exercised through the usage/digest asymmetry rather than by clearing the suppression, so the
   * test needs nothing CH3 owns: a `usage`-scoped row suppresses `quota_80` and leaves
   * `product_updates` eligible. If `suppressed` counted toward the cap, the digest would come
   * back `capped` instead of `would_send` — which is exactly what a deliberate mutation adding
   * 'suppressed' to DELIVERED_STATUSES produces.
   */
  it('a suppressed row does NOT consume the daily budget', async () => {
    const eng = await import('../../src/lib/lifecycle/engine.js');
    const { hashEmail } = await import('../../src/lib/lifecycle/identity.js');
    const { addSuppression } = await import('../../src/lib/lifecycle/suppression.js');
    const now = new Date('2026-09-08T10:00:00.000Z');
    await addSuppression({ emailHash: hashEmail(RECIPIENT.email), reason: 'preference', scope: 'usage' });
    const suppressed = await eng.sendLifecycle('quota_80', RECIPIENT, CTX, { now });
    expect(suppressed.status).toBe('suppressed');
    const digest = await eng.sendLifecycle('product_updates', RECIPIENT, { ...CTX, periodKey: '2026-09' }, { now });
    expect(digest.status).toBe('would_send');
  });
});

describe('per-step go-live blocker (architect Q1(A))', () => {
  beforeEach(freshEnv);

  const OK = { duplicates: 0, wouldSendCount: 1, healthPass: true, unsubSelfTestPass: true };

  it('a step with ZERO would_send never goes live — the measured case for 3 of 4 steps', async () => {
    const eng = await import('../../src/lib/lifecycle/engine.js');
    expect(await eng.stepGoLiveBlocker('quota_80', { ...OK, wouldSendCount: 0 })).toBe('no_would_send');
  });

  it('the clock must have STARTED and RUN for 7 days', async () => {
    const eng = await import('../../src/lib/lifecycle/engine.js');
    const led = await import('../../src/lib/lifecycle/ledger.js');
    expect(await eng.stepGoLiveBlocker('activation_nudge', OK)).toBe('clock_not_started');
    await led.stampFirstWouldSend('activation_nudge', '2026-09-08T00:00:00.000Z');
    expect(await eng.stepGoLiveBlocker('activation_nudge', OK, new Date('2026-09-13T00:00:00.000Z')))
      .toBe('shadow_clock_not_elapsed');
    expect(await eng.stepGoLiveBlocker('activation_nudge', OK, new Date('2026-09-16T00:00:00.000Z')))
      .toBeNull();
  });

  it('the clock is WRITE-ONCE — a later would_send must not restart it', async () => {
    const led = await import('../../src/lib/lifecycle/ledger.js');
    await led.stampFirstWouldSend('quota_80', '2026-09-01T00:00:00.000Z');
    await led.stampFirstWouldSend('quota_80', '2026-09-07T00:00:00.000Z');
    const s = await led.getStepState('quota_80');
    expect(String(s.first_would_send_at)).toContain('2026-09-01');
  });

  it('duplicates, a red health verdict or a failing unsub self-test each block on their own', async () => {
    const eng = await import('../../src/lib/lifecycle/engine.js');
    const led = await import('../../src/lib/lifecycle/ledger.js');
    await led.stampFirstWouldSend('quota_wall', '2026-09-01T00:00:00.000Z');
    const late = new Date('2026-09-16T00:00:00.000Z');
    expect(await eng.stepGoLiveBlocker('quota_wall', { ...OK, duplicates: 1 }, late)).toBe('duplicates_present');
    expect(await eng.stepGoLiveBlocker('quota_wall', { ...OK, healthPass: false }, late)).toBe('health_not_pass');
    expect(await eng.stepGoLiveBlocker('quota_wall', { ...OK, unsubSelfTestPass: false }, late)).toBe('unsub_selftest_not_pass');
  });

  it('a rolled-back step stays down until a human clears it — never re-lights itself', async () => {
    const eng = await import('../../src/lib/lifecycle/engine.js');
    const led = await import('../../src/lib/lifecycle/ledger.js');
    await led.stampFirstWouldSend('reset_return', '2026-09-01T00:00:00.000Z');
    await led.rollbackStep('reset_return', '2026-09-10T00:00:00.000Z', 'bounce rate breach');
    expect(await eng.stepGoLiveBlocker('reset_return', OK, new Date('2026-09-20T00:00:00.000Z')))
      .toBe('rolled_back');
  });

  it('rolling ONE step back leaves its siblings live — per-step rollback, not wave-level', async () => {
    const led = await import('../../src/lib/lifecycle/ledger.js');
    await led.setStepLive('quota_80', '2026-09-10T00:00:00.000Z');
    await led.setStepLive('quota_wall', '2026-09-10T00:00:00.000Z');
    await led.rollbackStep('quota_80', '2026-09-11T00:00:00.000Z', 'complaint breach');
    expect((await led.getStepState('quota_80')).live_since).toBeNull();
    expect((await led.getStepState('quota_wall')).live_since).not.toBeNull();
  });
});

describe('parseDbTimestamp — the shapes each backend actually returns', () => {
  beforeEach(freshEnv);

  /**
   * REGRESSION, measured live on signal-1 2026-09-08. node-postgres returns
   * `2026-09-08 13:46:46.246+00`; `Date.parse` of that with a bare `' ' -> T` swap is NaN,
   * because an ISO offset must be `+00:00` or `Z`. The dispatcher printed
   * `min_since_last_tick=NaN`, and the SAME parse gates go-live via `first_would_send_at` —
   * so on Postgres every step would have sat in shadow FOREVER while the SQLite suite passed.
   */
  it('parses the Postgres shape with a bare +00 offset', async () => {
    const { parseDbTimestamp } = await import('../../src/lib/lifecycle/ledger.js');
    const ms = parseDbTimestamp('2026-09-08 13:46:46.246+00');
    expect(Number.isFinite(ms)).toBe(true);
    expect(new Date(ms).toISOString()).toBe('2026-09-08T13:46:46.246Z');
  });

  it('parses the SQLite shape, treating an offset-less value as UTC', async () => {
    const { parseDbTimestamp } = await import('../../src/lib/lifecycle/ledger.js');
    expect(new Date(parseDbTimestamp('2026-09-08 13:46:46')).toISOString())
      .toBe('2026-09-08T13:46:46.000Z');
  });

  it('parses a plain ISO value unchanged', async () => {
    const { parseDbTimestamp } = await import('../../src/lib/lifecycle/ledger.js');
    expect(new Date(parseDbTimestamp('2026-09-08T13:46:46.246Z')).toISOString())
      .toBe('2026-09-08T13:46:46.246Z');
  });

  it('normalises to STRICT ISO-8601 — the shape is asserted, not inferred from a parse', async () => {
    // Node's Date.parse tolerates the space-separated form, so a behavioural test alone cannot
    // see the normalisation disappear. ECMA-262 leaves that tolerance implementation-defined,
    // so the shape is pinned here rather than rented from the runtime.
    const { toIso8601 } = await import('../../src/lib/lifecycle/ledger.js');
    const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
    for (const raw of ['2026-09-08 13:46:46.246+00', '2026-09-08 13:46:46', '2026-09-08T13:46:46.246Z']) {
      expect(toIso8601(raw), raw).toMatch(ISO);
    }
  });

  it('still REFUSES genuine garbage — the fix narrows unparseable, it does not widen acceptance', async () => {
    const { parseDbTimestamp } = await import('../../src/lib/lifecycle/ledger.js');
    for (const bad of ['', null, undefined, 'not a date', 'yesterday']) {
      expect(Number.isNaN(parseDbTimestamp(bad as string))).toBe(true);
    }
  });

  it('the go-live clock ELAPSES against a Postgres-shaped stamp', async () => {
    // The end-to-end version of the bug: a PG timestamp must let a step reach day 7.
    const eng = await import('../../src/lib/lifecycle/engine.js');
    const { dbRun } = await import('../../src/lib/performance-db.js');
    const { ensureLifecycleSchema } = await import('../../src/lib/lifecycle/schema.js');
    ensureLifecycleSchema();
    dbRun('INSERT INTO lifecycle_step_state (step, first_would_send_at) VALUES (?, ?)',
      'quota_80', '2026-09-01 00:00:00.123+00');
    const facts = { duplicates: 0, wouldSendCount: 1, healthPass: true, unsubSelfTestPass: true };
    expect(await eng.stepGoLiveBlocker('quota_80', facts, new Date('2026-09-05T00:00:00Z')))
      .toBe('shadow_clock_not_elapsed');
    expect(await eng.stepGoLiveBlocker('quota_80', facts, new Date('2026-09-20T00:00:00Z')))
      .toBeNull();
  });
});
