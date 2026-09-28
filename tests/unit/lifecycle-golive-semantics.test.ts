/**
 * LIFECYCLE-GOLIVE-SEMANTICS-W1 — "live" means SENDING.
 *
 * Measured on signal-1 2026-09-28 (audits/CONVERSION-ARC-DAY21-READOUT-2026-09-28.md §R2): the
 * deciding cron stamped `activation_nudge` live on 2026-09-16 and printed `LIVE lit=1`, the
 * dashboard showed `state: live`, and nothing could send, because the global master was unset.
 * Its 72 h rollback window then expired before a single email left, and its 16 shadow claims
 * could never be mailed. Each block below pins one of those defects, driven through the REAL
 * ledger/engine/dispatcher/readout against in-memory SQLite. Only the Resend edge is stubbed.
 *
 * Every assertion here was run RED against the pre-wave code first (named in status.md).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const KEY = 'a'.repeat(48);
const H = 3_600_000;
const D = 24 * H;
const ROOT = resolve(__dirname, '../..');

function freshEnv(mode?: string): void {
  vi.resetModules();
  process.env.PERFORMANCE_DB_PATH = ':memory:';
  process.env.ALGOVAULT_IP_HASH_KEY = KEY;
  delete process.env.DATABASE_URL;
  if (mode) process.env.LIFECYCLE_MODE = mode;
  else delete process.env.LIFECYCLE_MODE;
}

/** Stub ONLY the Resend edge. Every ledger/cap/suppression/render path runs for real. */
function stubResend() {
  const spy = vi.fn(async (_a: { idempotencyKey: string }) => `re_${spy.mock.calls.length}`);
  vi.doMock('../../src/lib/email.js', async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    sendLifecycleMessage: spy,
  }));
  return spy;
}

const ctx = (periodKey = 'once') => ({
  keyMasked: 'av_free_…a1b2', used: 0, total: 200, resetDate: '',
  mcpConfigSnippet: '{\n  "mcpServers": {}\n}', periodKey,
});
const cand = (id: string, periodKey = 'once') => ({
  recipient: { recipientId: id, email: `${id}@example.com`, identityBound: true },
  ctx: ctx(periodKey),
});
const evaluation = (ids: string[], explain = () => 'key_older_than_30d') =>
  ({ candidates: ids.map((i) => cand(i)), explain });

async function seedClaim(id: string, at: Date, status = 'would_send', step = 'activation_nudge', period = 'once') {
  const { claimSlot } = await import('../../src/lib/lifecycle/ledger.js');
  const { hashEmail } = await import('../../src/lib/lifecycle/identity.js');
  const { row } = await claimSlot({
    recipientId: id, emailHash: hashEmail(`${id}@example.com`), recipientEmail: `${id}@example.com`,
    step: step as never, periodKey: period, status: status as never,
    subject: 's', html: '<p>h</p>', text: 't', now: at,
  });
  return row!;
}

/** The measured production shape: per-step live since long ago, canary not yet spent. */
async function goLive(step = 'activation_nudge', since = new Date(Date.now() - 300 * H)) {
  const led = await import('../../src/lib/lifecycle/ledger.js');
  await led.stampFirstWouldSend(step as never, new Date(since.getTime() - 7 * D).toISOString());
  await led.setStepLive(step as never, since.toISOString());
}

async function ledger(): Promise<Array<{ id: number; recipient_id: string; status: string; expired_reason: string | null }>> {
  const { dbQuery } = await import('../../src/lib/performance-db.js');
  return dbQuery('SELECT id, recipient_id, status, expired_reason FROM lifecycle_sends ORDER BY id');
}

/** The scoreboard panel reads `free_keys`, whose DDL lives with its store, not the ledger's. */
async function panelSchema(): Promise<void> {
  const { ensureFreeKeysSchema } = await import('../../src/lib/free-keys-store.js');
  ensureFreeKeysSchema();
}

// ── R3 — ONE predicate ────────────────────────────────────────────────────────────────────

describe('R3 — stepLiveState is the one predicate behind "live"', () => {
  beforeEach(() => freshEnv());

  it('live requires BOTH the master AND the per-step stamp', async () => {
    const { stepLiveState, isStepLive } = await import('../../src/lib/lifecycle/engine.js');
    const stamped = { live_since: '2026-09-16T09:19:02.386Z', rolled_back_at: null };
    expect(stepLiveState('live-permitted', stamped)).toBe('live');
    expect(stepLiveState('shadow', stamped)).toBe('blocked-master');
    expect(stepLiveState('off', stamped)).toBe('blocked-master');
    expect(stepLiveState('live-permitted', { live_since: null, rolled_back_at: null })).toBe('shadow');
    expect(stepLiveState('live-permitted', { live_since: null, rolled_back_at: '2026-09-20T00:00:00Z' }))
      .toBe('rolled-back');
    expect(isStepLive('shadow', stamped)).toBe(false);
    expect(isStepLive('live-permitted', stamped)).toBe(true);
  });

  it('the master is the FIRST go-live leg — a stamped step reports it, never null', async () => {
    const eng = await import('../../src/lib/lifecycle/engine.js');
    await goLive();
    const facts = { duplicates: 0, wouldSendCount: 16, healthPass: true, unsubSelfTestPass: true };
    // Pre-wave: `if (state.live_since) return null` — the cron read that as "may go live".
    expect(await eng.stepGoLiveBlocker('activation_nudge', facts)).toBe('master_not_live_permitted');
  });

  it('an un-stamped step whose evidence all passes is ALSO held by the master', async () => {
    const eng = await import('../../src/lib/lifecycle/engine.js');
    const led = await import('../../src/lib/lifecycle/ledger.js');
    await led.stampFirstWouldSend('quota_80', new Date(Date.now() - 8 * D).toISOString());
    const facts = { duplicates: 0, wouldSendCount: 3, healthPass: true, unsubSelfTestPass: true };
    expect(await eng.stepGoLiveBlocker('quota_80', facts)).toBe('master_not_live_permitted');
    process.env.LIFECYCLE_MODE = 'live-permitted';
    expect(await eng.stepGoLiveBlocker('quota_80', facts)).toBeNull();
  });

  it('the dashboard state projects from it — live_since without the master is NOT live', async () => {
    await goLive();
    await panelSchema();
    const { computeLifecyclePanel, defaultScoreboardDeps } = await import('../../src/lib/funnel-scoreboard.js');
    const warnings: string[] = [];
    const panel = await computeLifecyclePanel(defaultScoreboardDeps, Date.now() - 30 * D, warnings);
    const nudge = panel.sends_by_step.find((s) => s.step === 'activation_nudge');
    expect(warnings).toEqual([]);
    expect(nudge?.state).toBe('blocked-master');
  });

  it('no consumer re-derives liveness from `live_since` — and the detector can fail', () => {
    // The LIVENESS shapes the pre-wave code used in six places. A display of the timestamp is
    // not liveness; a ternary / double-bang / filter / guard on it is.
    const LIVENESS = /live_since\s*\?|!!\s*[\w.?]*live_since|=>\s*\w+\.live_since\s*\)|if\s*\(\s*!?\s*[\w.?]*live_since\s*\)|&&\s*!\s*[\w.?]*live_since\s*\)/;
    for (const bad of ["s2?.live_since ? 'live' : 'shadow'", 'const live = !!state.live_since;',
      'states.filter((s) => s.live_since)', 'if (!r.state.live_since) return null;',
      'blocker === null && !r.state.live_since)']) {
      expect(bad, 'detector must catch the pre-wave shape').toMatch(LIVENESS);
    }
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    for (const f of ['src/scripts/lifecycle-dispatch.ts', 'src/scripts/lifecycle-readout.ts',
      'src/scripts/product-updates-digest.ts', 'src/lib/funnel-scoreboard.ts']) {
      expect(strip(readFileSync(resolve(ROOT, f), 'utf8')), f).not.toMatch(LIVENESS);
    }
  });
});

// ── R1 — the rollback window opens on the first REAL send ───────────────────────────────────

describe('R1 — rollback window keyed on first_sent_at', () => {
  beforeEach(() => freshEnv('live-permitted'));

  it('no send yet ⇒ not_opened, however old live_since is', async () => {
    const { rollbackWindow } = await import('../../src/lib/lifecycle/engine.js');
    expect(rollbackWindow({ first_sent_at: null }, new Date())).toEqual({ status: 'not_opened' });
  });

  it('the first send ARMS the window for 72 h; hour 80 is closed', async () => {
    const { rollbackWindow } = await import('../../src/lib/lifecycle/engine.js');
    const t0 = new Date('2026-09-29T09:22:00.000Z');
    const w10 = rollbackWindow({ first_sent_at: t0.toISOString() }, new Date(t0.getTime() + 10 * H));
    expect(w10).toMatchObject({ status: 'armed', opensAt: t0.toISOString(), closesAt: '2026-10-02T09:22:00.000Z' });
    const w80 = rollbackWindow({ first_sent_at: t0.toISOString() }, new Date(t0.getTime() + 80 * H));
    expect(w80.status).toBe('closed');
  });

  it('a ≥5 % bounce breach at hour 10 ROLLS BACK although live_since is 300 h old', async () => {
    const led = await import('../../src/lib/lifecycle/ledger.js');
    const { addSuppression } = await import('../../src/lib/lifecycle/suppression.js');
    const { hashEmail } = await import('../../src/lib/lifecycle/identity.js');
    const { assess, rollbackReason } = await import('../../src/scripts/lifecycle-readout.js');
    // Anchor the first send on the PREVIOUS UTC day: SQLite stores suppression `created_at` as
    // `YYYY-MM-DD HH:MM:SS`, which compares lexicographically BELOW a same-day ISO bound.
    const dayStart = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
    const firstSent = new Date(dayStart - H);
    await goLive('activation_nudge', new Date(firstSent.getTime() - 290 * H));
    for (let i = 0; i < 100; i += 1) await seedClaim(`s${i}`, firstSent, 'sent');
    await led.stampFirstSent('activation_nudge', firstSent.toISOString());
    for (let i = 0; i < 5; i += 1) await addSuppression({ emailHash: hashEmail(`s${i}@example.com`), reason: 'bounce' });
    const rows = await assess(new Date(firstSent.getTime() + 10 * H));
    const nudge = rows.find((r) => r.step === 'activation_nudge')!;
    expect(nudge.window.status).toBe('armed');
    expect(rollbackReason(nudge)).toMatch(/bounce\+complaint 5\/100/);
  });

  it('the same breach at hour 80 does NOT auto-roll-back (the health canary owns steady state)', async () => {
    const led = await import('../../src/lib/lifecycle/ledger.js');
    const { addSuppression } = await import('../../src/lib/lifecycle/suppression.js');
    const { hashEmail } = await import('../../src/lib/lifecycle/identity.js');
    const { assess, rollbackReason } = await import('../../src/scripts/lifecycle-readout.js');
    const firstSent = new Date(Date.now() - 80 * H);
    await goLive('activation_nudge', new Date(firstSent.getTime() - 10 * H));
    for (let i = 0; i < 20; i += 1) await seedClaim(`t${i}`, firstSent, 'sent');
    await led.stampFirstSent('activation_nudge', firstSent.toISOString());
    for (let i = 0; i < 10; i += 1) await addSuppression({ emailHash: hashEmail(`t${i}@example.com`), reason: 'complaint' });
    const nudge = (await assess(new Date())).find((r) => r.step === 'activation_nudge')!;
    expect(nudge.window.status).toBe('closed');
    expect(rollbackReason(nudge)).toBeNull();
  });

  it('the send path stamps first_sent_at on the first REAL send, write-once', async () => {
    const spy = stubResend();
    await goLive();
    const led = await import('../../src/lib/lifecycle/ledger.js');
    const { runStep } = await import('../../src/scripts/lifecycle-dispatch.js');
    const t1 = new Date(Date.now() - 2 * H);
    await runStep('activation_nudge', evaluation(['f1']), t1);
    await runStep('activation_nudge', evaluation(['f2']), new Date());
    expect(spy).toHaveBeenCalledTimes(2);
    const s = await led.getStepState('activation_nudge');
    expect(new Date(String(s.first_sent_at).replace(' ', 'T')).getTime()).toBe(t1.getTime());
  });
});

// ── R2 — shadow claims are consumable ──────────────────────────────────────────────────────

describe('R2 — a would_send row is a consumable claim', () => {
  beforeEach(() => freshEnv('live-permitted'));
  afterEach(() => vi.doUnmock('../../src/lib/email.js'));

  it('consume-once: the SAME row goes would_send → sent; a second tick never re-sends', async () => {
    const spy = stubResend();
    const claim = await seedClaim('k1', new Date(Date.now() - 3 * D));
    await goLive();
    const { runStep } = await import('../../src/scripts/lifecycle-dispatch.js');
    const t1 = await runStep('activation_nudge', evaluation(['k1']), new Date());
    expect(t1.sent).toBe(1);
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: claim.id, status: 'sent' });
    // The Resend Idempotency-Key is derived from the tuple (hashed inside sendLifecycleMessage).
    expect(spy.mock.calls[0][0].idempotencyKey).toBe('k1|activation_nudge|once');
    await runStep('activation_nudge', evaluation(['k1']), new Date());
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a claim no longer eligible is EXPIRED with the predicate\'s reason, and never mailed', async () => {
    const spy = stubResend();
    await seedClaim('old', new Date(Date.now() - 20 * D));
    await goLive();
    const { runStep } = await import('../../src/scripts/lifecycle-dispatch.js');
    const t = await runStep('activation_nudge', evaluation([], () => 'key_older_than_30d'), new Date());
    expect(t.expired).toBe(1);
    expect(spy).not.toHaveBeenCalled();
    expect((await ledger())[0]).toMatchObject({ status: 'expired', expired_reason: 'key_older_than_30d' });
  });

  it('a shadow step never consumes or expires its claims', async () => {
    freshEnv(); // master unset
    const spy = stubResend();
    await seedClaim('k1', new Date(Date.now() - 3 * D));
    await goLive();
    const { runStep } = await import('../../src/scripts/lifecycle-dispatch.js');
    await runStep('activation_nudge', evaluation([]), new Date());
    expect(spy).not.toHaveBeenCalled();
    expect((await ledger())[0].status).toBe('would_send');
  });

  it('oldest claims first, and the ≤5 canary batch caps claims ∪ new eligibles', async () => {
    const spy = stubResend();
    const base = Date.now() - 4 * D;
    await seedClaim('c1', new Date(base));
    await seedClaim('c2', new Date(base + H));
    await seedClaim('c3', new Date(base + 2 * H));
    await goLive();
    const { runStep } = await import('../../src/scripts/lifecycle-dispatch.js');
    const t = await runStep('activation_nudge', evaluation(['c3', 'n1', 'c1', 'n2', 'c2', 'n3', 'n4']), new Date());
    expect(t.sent).toBe(5);
    expect(spy.mock.calls.map((c) => c[0].idempotencyKey.split('|')[0])).toEqual(['c1', 'c2', 'c3', 'n1', 'n2']);
    // Over budget leaves NO trace: n3/n4 have no row and are simply eligible again next tick.
    const rows = await ledger();
    expect(rows.map((r) => r.recipient_id).sort()).toEqual(['c1', 'c2', 'c3', 'n1', 'n2']);
  });

  it('a claim written earlier TODAY does not count against its own daily cap', async () => {
    const spy = stubResend();
    const noon = new Date();
    noon.setUTCHours(12, 0, 0, 0);
    const early = new Date(noon.getTime() - 11 * H); // 01:00Z, same UTC day
    await seedClaim('same', early);
    await goLive();
    const { runStep } = await import('../../src/scripts/lifecycle-dispatch.js');
    const t = await runStep('activation_nudge', evaluation(['same']), noon);
    expect(t.capped).toBe(0);
    expect(t.sent).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('R2 — the canary batch holds across the WHOLE tick', () => {
  afterEach(() => vi.doUnmock('../../src/lib/email.js'));

  it('7 eligible on the first live tick ⇒ exactly 5 sent — the retry drain must not send the rest', async () => {
    freshEnv('live-permitted');
    const spy = stubResend();
    await goLive();
    const { runTick } = await import('../../src/scripts/lifecycle-dispatch.js');
    const r = await runTick(new Date(), {
      sources: { activation_nudge: async () => evaluation(['a', 'b', 'c', 'd', 'e', 'f', 'g']) },
      prime: async () => {},
    });
    expect(r.verdict).toBe('PASS');
    expect(spy).toHaveBeenCalledTimes(5);
    expect((await ledger()).filter((x) => x.status === 'sent')).toHaveLength(5);
  });

  it('the retry drain never resends a row whose step is not live', async () => {
    freshEnv('live-permitted');
    const spy = stubResend();
    const { markFailed } = await import('../../src/lib/lifecycle/ledger.js');
    const row = await seedClaim('r1', new Date(Date.now() - D), 'failed', 'quota_80', 'p1');
    await markFailed(row.id, 'resend 500');
    const { runTick } = await import('../../src/scripts/lifecycle-dispatch.js');
    await runTick(new Date(), { sources: {}, prime: async () => {} });
    expect(spy).not.toHaveBeenCalled();
  });
});

// ── R3 — the readout says what the send path does ───────────────────────────────────────────

describe('R3 — readout verdicts, in the shape the AC5 gate greps', () => {
  const firstMatch = (lines: string[], re: RegExp) => {
    for (const l of lines) { const m = l.match(re); if (m) return m[1]; }
    return null;
  };

  it('master unset + live_since ⇒ BLOCKED_MASTER, never LIVE', async () => {
    freshEnv();
    await goLive();
    const { assess, reportLines } = await import('../../src/scripts/lifecycle-readout.js');
    const lines = reportLines(await assess(new Date()), 'shadow');
    expect(firstMatch(lines, /master=([a-z-]*)/)).toBe('shadow');
    expect(lines.some((l) => /step=activation_nudge verdict=BLOCKED_MASTER/.test(l))).toBe(true);
    expect(lines.filter((l) => /activation_nudge[^|]*LIVE/.test(l))).toHaveLength(0);
  });

  it('live-permitted ⇒ LIVE, rollback_window=not_opened until the first send, then armed(closes_at=…)', async () => {
    freshEnv('live-permitted');
    stubResend();
    await goLive();
    const { assess, reportLines } = await import('../../src/scripts/lifecycle-readout.js');
    const before = reportLines(await assess(new Date()), 'live-permitted');
    expect(firstMatch(before, /master=([a-z-]*)/)).toBe('live-permitted');
    expect(before.filter((l) => /activation_nudge[^|]*LIVE/.test(l))).toHaveLength(1);
    expect(firstMatch(before, /rollback_window=([a-z_]*)/)).toBe('not_opened');
    const { runStep } = await import('../../src/scripts/lifecycle-dispatch.js');
    await runStep('activation_nudge', evaluation(['z1']), new Date());
    const after = reportLines(await assess(new Date()), 'live-permitted');
    expect(firstMatch(after, /rollback_window=([a-z_]*)/)).toBe('armed');
    expect(after.join('\n')).toMatch(/rollback_window=armed\(opens_at=[^,]+,closes_at=[^)]+\)/);
    vi.doUnmock('../../src/lib/email.js');
  });

  it('the aggregate is worst-wins over the steps the cron manages', async () => {
    const { aggregateVerdict } = await import('../../src/scripts/lifecycle-readout.js');
    expect(aggregateVerdict(['NOT_DUE', 'NOT_DUE', 'LIVE', 'NOT_DUE'])).toBe('LIVE');
    expect(aggregateVerdict(['NOT_DUE', 'BLOCKED_MASTER', 'NOT_DUE'])).toBe('BLOCKED_MASTER');
    expect(aggregateVerdict(['LIVE', 'BLOCKED_GATE'])).toBe('BLOCKED_GATE');
    expect(aggregateVerdict(['BLOCKED_GATE', 'ROLLED_BACK'])).toBe('ROLLED_BACK');
    expect(aggregateVerdict(['NOT_DUE'])).toBe('NOT_DUE');
  });

  it('the published record carries counts and verdicts only, per step', async () => {
    freshEnv();
    await goLive();
    await seedClaim('k1', new Date(Date.now() - D));
    const { assess, resultMetrics } = await import('../../src/scripts/lifecycle-readout.js');
    const m = resultMetrics(await assess(new Date()), 'shadow');
    expect(m.master).toBe('shadow');
    expect(m.steps.activation_nudge).toEqual({
      verdict: 'BLOCKED_MASTER', would_send: 1, sent: 0, expired: 0, live: false, rollback_window: 'not_opened',
    });
    expect(JSON.stringify(m)).not.toMatch(/rendered_|recipient|@/);
  });
});

// ── R5 — the identity-claim rate on ONE window ─────────────────────────────────────────────

describe('R5 — identity_claim_rate_30d divides a 30D numerator by the 30D denominator', () => {
  beforeEach(() => freshEnv());

  it('both reads carry the SAME 30-day instant; the old key is unchanged', async () => {
    await panelSchema();
    const { computeLifecyclePanel, defaultScoreboardDeps } = await import('../../src/lib/funnel-scoreboard.js');
    const NOW = Date.parse('2026-09-28T13:12:19.848Z');
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const deps = {
      ...defaultScoreboardDeps,
      now: () => NOW,
      query: async <T>(sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return defaultScoreboardDeps.query<T>(sql, params);
      },
    };
    const panel = await computeLifecyclePanel(deps, NOW - 90 * D, []);
    const num = calls.find((c) => /FROM free_keys/.test(c.sql) && /created_at >= \?/.test(c.sql))!;
    const den = calls.filter((c) => /FROM agent_sessions WHERE call_count >= 1/.test(c.sql))
      .find((c) => c.params[0] === NOW - 30 * D)!;
    expect(num, 'windowed numerator query').toBeTruthy();
    expect(den, '30D denominator query').toBeTruthy();
    expect(Date.parse(String(num.params[0]))).toBe(den.params[0]);
    expect(panel.identity_claim_rate_30d).toMatchObject({ window_days: 30 });
    // Add-only: the old object keeps its shape (all-time claims over the selected window).
    expect(Object.keys(panel.identity_claim_rate).sort()).toEqual(['activated', 'bound', 'pct']);
  });
});

// ── R2 — the expiry reason is the candidate predicate's own answer ───────────────────────────

describe('R2 — expiry reasons come from the SAME predicate that selects candidates', () => {
  beforeEach(() => freshEnv());
  const NOW = new Date('2026-09-28T15:00:00.000Z');
  const bucket = (over: Record<string, unknown> = {}) => ({
    apiKey: 'k', email: 'k@example.com', trackerKey: 'k', createdAtMs: NOW.getTime() - 10 * D,
    lastUsedAtMs: null,
    meter: { trackerKey: 'k', used: 0, total: 0, periodStart: null, resetAtMs: null, resetDate: null },
    ...over,
  });

  it('activation_nudge: eligible, too old, used, too new', async () => {
    const { stepVerdict } = await import('../../src/lib/lifecycle/steps.js');
    expect(stepVerdict('activation_nudge', bucket() as never, NOW)).toEqual({ eligible: true, periodKey: 'once' });
    expect(stepVerdict('activation_nudge', bucket({ createdAtMs: NOW.getTime() - 40 * D }) as never, NOW))
      .toEqual({ eligible: false, reason: 'key_older_than_30d' });
    expect(stepVerdict('activation_nudge', bucket({ lastUsedAtMs: NOW.getTime() - D }) as never, NOW))
      .toEqual({ eligible: false, reason: 'key_used' });
    expect(stepVerdict('activation_nudge', bucket({ createdAtMs: NOW.getTime() - H }) as never, NOW))
      .toEqual({ eligible: false, reason: 'key_too_new' });
  });

  it('explain(): a recipient absent from the email-bound set, and a rolled period', async () => {
    const { explainAgainst } = await import('../../src/lib/lifecycle/steps.js');
    const old = bucket({ apiKey: 'old', createdAtMs: NOW.getTime() - 40 * D });
    expect(explainAgainst('activation_nudge', [old] as never, NOW)('old', 'once')).toBe('key_older_than_30d');
    expect(explainAgainst('activation_nudge', [old] as never, NOW)('gone', 'once')).toBe('not_email_bound');
    const q = bucket({ apiKey: 'q', meter: { trackerKey: 'q', used: 170, total: 200, periodStart: 'P2', resetAtMs: null, resetDate: null } });
    expect(explainAgainst('quota_80', [q] as never, NOW)('q', 'P1')).toBe('period_rolled');
  });

  it('candidates are exactly the eligible verdicts — one derivation', async () => {
    const { activationNudgeCandidates, stepVerdict } = await import('../../src/lib/lifecycle/steps.js');
    const bs = [bucket({ apiKey: 'a' }), bucket({ apiKey: 'b', createdAtMs: NOW.getTime() - 40 * D }),
      bucket({ apiKey: 'c', lastUsedAtMs: NOW.getTime() - H })];
    const ids = activationNudgeCandidates(bs as never, NOW).map((c) => c.recipient.recipientId);
    expect(ids).toEqual(bs.filter((b) => stepVerdict('activation_nudge', b as never, NOW).eligible).map((b) => b.apiKey));
    expect(ids).toEqual(['a']);
  });
});

// ── R2 — a consumed claim is dated by its SEND, not by its shadow claim ──────────────────────
//
// MEASURED on signal-1 2026-09-28 15:52Z, first live tick: 5 claims consumed and sent, and the
// health canary's next line read `sent_7d=0` — the rows kept their shadow-claim `created_at`
// (09-09 … 09-16), and the canary and the frequency caps both date a delivery by `created_at`.
// A consumed send must count on the day it was SENT, or a step debut escapes the <= 1/day cap.

describe('R2 — consumption re-dates the row to the send', () => {
  beforeEach(() => freshEnv('live-permitted'));
  afterEach(() => vi.doUnmock('../../src/lib/email.js'));

  it('a claim written 10 days ago, consumed today, counts against TODAY\'s cap', async () => {
    const spy = stubResend();
    const now = new Date();
    await seedClaim('old10', new Date(now.getTime() - 10 * D));
    await goLive();
    const { runStep } = await import('../../src/scripts/lifecycle-dispatch.js');
    const { countDeliveredSince } = await import('../../src/lib/lifecycle/ledger.js');
    const { hashEmail } = await import('../../src/lib/lifecycle/identity.js');
    await runStep('activation_nudge', evaluation(['old10']), now);
    expect(spy).toHaveBeenCalledTimes(1);
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    expect(await countDeliveredSince(hashEmail('old10@example.com'), dayStart)).toBe(1);
  });
});
