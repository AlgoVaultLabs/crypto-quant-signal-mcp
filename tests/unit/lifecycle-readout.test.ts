/**
 * IDENTITY-LIFECYCLE-W3 CH2 R4 — the day-7 flip, proven BOTH ways on a fixture ledger.
 *
 * AC(4) requires the flip demonstrated green→LIVE, duplicates→stays shadow, bounces→ROLLED_BACK,
 * and the cron not flipping before day 7 on live data. All four are here, against an in-memory
 * ledger, so the proof costs nothing and touches no real recipient.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const KEY = 'a'.repeat(48);
const H = 3_600_000;
const D = 24 * H;

function freshEnv(): void {
  vi.resetModules();
  process.env.PERFORMANCE_DB_PATH = ':memory:';
  process.env.ALGOVAULT_IP_HASH_KEY = KEY;
  delete process.env.DATABASE_URL;
  delete process.env.LIFECYCLE_MODE;
}

const OK = { duplicates: 0, wouldSendCount: 1, healthPass: true, unsubSelfTestPass: true };

async function seed(step: string, rows: { status: string; recipient: string; period: string; at: string }[]) {
  const { claimSlot } = await import('../../src/lib/lifecycle/ledger.js');
  const { hashEmail } = await import('../../src/lib/lifecycle/identity.js');
  for (const r of rows) {
    await claimSlot({
      recipientId: r.recipient, emailHash: hashEmail(`${r.recipient}@example.com`),
      recipientEmail: `${r.recipient}@example.com`,
      step: step as never, periodKey: r.period, status: r.status as never,
      subject: 's', html: '<p>h</p>', text: 't', now: new Date(r.at),
    });
  }
}

describe('the day-7 flip, green path', () => {
  beforeEach(freshEnv);

  it('a step with evidence and an elapsed clock goes LIVE', async () => {
    const eng = await import('../../src/lib/lifecycle/engine.js');
    const led = await import('../../src/lib/lifecycle/ledger.js');
    await led.stampFirstWouldSend('activation_nudge', new Date(Date.now() - 8 * D).toISOString());
    expect(await eng.stepGoLiveBlocker('activation_nudge', OK)).toBeNull();
    await led.setStepLive('activation_nudge', new Date().toISOString());
    expect((await led.getStepState('activation_nudge')).live_since).not.toBeNull();
  });

  it('DUPLICATES hold the step in shadow — the constraint is gone if this ever fires', async () => {
    const eng = await import('../../src/lib/lifecycle/engine.js');
    const led = await import('../../src/lib/lifecycle/ledger.js');
    await led.stampFirstWouldSend('activation_nudge', new Date(Date.now() - 8 * D).toISOString());
    expect(await eng.stepGoLiveBlocker('activation_nudge', { ...OK, duplicates: 1 })).toBe('duplicates_present');
  });

  it('BEFORE day 7 the cron does not flip, however healthy everything else is', async () => {
    const eng = await import('../../src/lib/lifecycle/engine.js');
    const led = await import('../../src/lib/lifecycle/ledger.js');
    await led.stampFirstWouldSend('quota_80', new Date(Date.now() - 6.9 * D).toISOString());
    expect(await eng.stepGoLiveBlocker('quota_80', OK)).toBe('shadow_clock_not_elapsed');
  });

  it('a step with ZERO evidence never lights — the measured case for 3 of 4 steps', async () => {
    const eng = await import('../../src/lib/lifecycle/engine.js');
    // No stamp at all, because nothing was ever eligible. It reports `no_would_send` before it
    // even reaches the clock, and it will report that for ever, at zero cost.
    expect(await eng.stepGoLiveBlocker('quota_wall', { ...OK, wouldSendCount: 0 })).toBe('no_would_send');
  });
});

describe('rollbackReason — the first 72h', () => {
  beforeEach(freshEnv);

  const row = (over: Record<string, unknown> = {}) => ({
    step: 'quota_80', wouldSend: 0, sent: 100, failed: 0, suppressed: 0, capped: 0,
    recipients: 100, duplicates: 0, firstAt: null, lastAt: null, liveHours: 10,
    bounces: 0, unsubs: 0,
    state: { step: 'quota_80', first_would_send_at: null, live_since: new Date().toISOString(),
             canary_batch_done: true, rolled_back_at: null, rollback_reason: null },
    ...over,
  }) as never;

  it('bounce+complaint at 5% of sends rolls back', async () => {
    const { rollbackReason } = await import('../../src/scripts/lifecycle-readout.js');
    expect(rollbackReason(row({ bounces: 4 }))).toBeNull();
    expect(rollbackReason(row({ bounces: 5 }))).toMatch(/bounce\+complaint 5\/100/);
  });

  it('the bounce leg is INERT below n=10 — small-n noise must not roll a healthy step back', async () => {
    const { rollbackReason } = await import('../../src/scripts/lifecycle-readout.js');
    expect(rollbackReason(row({ sent: 9, bounces: 9 }))).toBeNull();
    expect(rollbackReason(row({ sent: 10, bounces: 5 }))).toMatch(/bounce/);
  });

  it('unsubscribes at 20% of sends roll back, and that leg has no MIN_N', async () => {
    const { rollbackReason } = await import('../../src/scripts/lifecycle-readout.js');
    // Deliberately no floor: 1 unsubscribe out of 3 sends is a louder signal than 5 out of 100,
    // and a step whose first handful of recipients all opt out should stop immediately.
    expect(rollbackReason(row({ sent: 3, unsubs: 1 }))).toMatch(/unsubscribe 1\/3/);
    expect(rollbackReason(row({ sent: 100, unsubs: 19 }))).toBeNull();
    expect(rollbackReason(row({ sent: 100, unsubs: 20 }))).toMatch(/unsubscribe/);
  });

  it('AFTER the 72h window the rollback legs stop applying', async () => {
    const { rollbackReason } = await import('../../src/scripts/lifecycle-readout.js');
    // The window is a launch guard, not a permanent tripwire — steady-state deliverability is
    // the health canary's job, and leaving this armed forever would make one bad week
    // retroactively un-ship a step that has been fine for months.
    expect(rollbackReason(row({ bounces: 50, liveHours: 73 }))).toBeNull();
  });

  it('a step still in SHADOW can never roll back', async () => {
    const { rollbackReason } = await import('../../src/scripts/lifecycle-readout.js');
    expect(rollbackReason(row({
      bounces: 99,
      state: { step: 'quota_80', first_would_send_at: null, live_since: null,
               canary_batch_done: false, rolled_back_at: null, rollback_reason: null },
    }))).toBeNull();
  });
});

describe('assess() over a fixture ledger', () => {
  beforeEach(freshEnv);

  it('counts each status per step and reports duplicates as 0', async () => {
    const { assess } = await import('../../src/scripts/lifecycle-readout.js');
    const at = new Date().toISOString();
    await seed('activation_nudge', [
      { status: 'would_send', recipient: 'k1', period: 'once', at },
      { status: 'would_send', recipient: 'k2', period: 'once', at },
      { status: 'suppressed', recipient: 'k3', period: 'once', at },
      { status: 'capped', recipient: 'k4', period: 'once', at },
    ]);
    const rows = await assess();
    const nudge = rows.find((r) => r.step === 'activation_nudge')!;
    expect(nudge.wouldSend).toBe(2);
    expect(nudge.suppressed).toBe(1);
    expect(nudge.capped).toBe(1);
    expect(nudge.recipients).toBe(4);
    expect(nudge.duplicates).toBe(0);
    // Every step appears, including the ones with nothing — a step missing from the table is
    // indistinguishable from a step with no rows, and the zero IS the finding here.
    expect(rows.map((r) => r.step).sort()).toEqual(
      ['activation_nudge', 'product_updates', 'quota_80', 'quota_wall', 'reset_return']);
  });

  it('the UNIQUE constraint makes a duplicate unwritable in the first place', async () => {
    const { assess } = await import('../../src/scripts/lifecycle-readout.js');
    const at = new Date().toISOString();
    await seed('quota_80', [
      { status: 'would_send', recipient: 'dup', period: 'p1', at },
      { status: 'would_send', recipient: 'dup', period: 'p1', at },
    ]);
    const q80 = (await assess()).find((r) => r.step === 'quota_80')!;
    expect(q80.wouldSend).toBe(1);
    expect(q80.duplicates).toBe(0);
  });
});
