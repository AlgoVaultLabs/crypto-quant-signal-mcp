/**
 * OPS-AUDIT-REMEDIATION-MEDIUM-W1 / Ch2 — SEC-20: webhook idempotency.
 *
 * `customer.subscription.created` MINTS AN API KEY, overwrites customer.metadata and
 * sends the welcome email — with no idempotency claim. Stripe retries any non-2xx and
 * can deliver at-least-once, so a redelivery generated a SECOND key, silently
 * invalidating the one the paying customer had already installed.
 *
 * CLAUDE.md already mandated the fix ("tryClaimEvent() BEFORE side-effect"), but the
 * claim helper ITSELF was not a claim: it did SELECT-then-`dbRun`, and `dbRun` is the
 * fire-and-forget writer. On Postgres that made the UNIQUE-violation catch dead code
 * and returned `true` before the row was durable — so a lost write re-ran the
 * side-effect anyway. These tests pin BOTH properties: atomic (exactly one winner) and
 * durable (never routed through the fire-and-forget writer).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Per-file SQLite isolation (unique temp HOME before imports).
vi.hoisted(() => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-stripe-idem-'));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  delete process.env.DATABASE_URL;
});

// Pass the real backend through, but make `dbRun` observable. `dbRun` is the
// fire-and-forget writer; a claim must never go through it.
vi.mock('../../src/lib/performance-db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/performance-db.js')>();
  return { ...actual, dbRun: vi.fn(actual.dbRun) };
});

import {
  tryClaimEvent,
  ensureProcessedStripeEventsSchema,
  getEventCount,
} from '../../src/lib/stripe-events-store.js';
import { dbRun, dbQuery } from '../../src/lib/performance-db.js';

const row = (id: string) => ({
  event_id: id,
  event_type: 'customer.subscription.created',
  customer_email: null,
  metadata: { source: 'customer.subscription.created' },
});

beforeEach(async () => {
  ensureProcessedStripeEventsSchema();
  dbRun('DELETE FROM processed_stripe_events');
  vi.mocked(dbRun).mockClear();
});

describe('tryClaimEvent — atomic', () => {
  it('claims once and refuses every replay of the same event id', async () => {
    expect(await tryClaimEvent(row('evt_sub_1'))).toBe(true);
    expect(await tryClaimEvent(row('evt_sub_1'))).toBe(false);
    expect(await tryClaimEvent(row('evt_sub_1'))).toBe(false);
    expect(await getEventCount()).toBe(1);
  });

  it('THE REGRESSION: concurrent deliveries of one event yield exactly ONE winner', async () => {
    // Stripe can deliver at-least-once. The old SELECT-then-INSERT let both fibers see
    // an empty SELECT; only the database can arbitrate this.
    const results = await Promise.all([
      tryClaimEvent(row('evt_race')),
      tryClaimEvent(row('evt_race')),
      tryClaimEvent(row('evt_race')),
      tryClaimEvent(row('evt_race')),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await getEventCount()).toBe(1);
  });

  it('claims distinct events independently', async () => {
    expect(await tryClaimEvent(row('evt_a'))).toBe(true);
    expect(await tryClaimEvent(row('evt_b'))).toBe(true);
    expect(await getEventCount()).toBe(2);
  });
});

describe('tryClaimEvent — durable', () => {
  it('THE REGRESSION: the claim never goes through the fire-and-forget writer', async () => {
    // This is the property the OLD implementation violated: it wrote the claim with
    // `dbRun`, whose failure resolves inside trackedWrite's own promise and never
    // reaches the caller — so `true` was returned before the row was durable.
    vi.mocked(dbRun).mockClear();
    await tryClaimEvent(row('evt_durable'));
    expect(vi.mocked(dbRun)).not.toHaveBeenCalled();
  });

  it('the row is readable immediately after the claim resolves', async () => {
    await tryClaimEvent(row('evt_persisted'));
    const rows = await dbQuery<{ event_id: string; event_type: string }>(
      'SELECT event_id, event_type FROM processed_stripe_events WHERE event_id = ?',
      ['evt_persisted'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe('customer.subscription.created');
  });

  it('persists the metadata payload alongside the claim', async () => {
    await tryClaimEvent({ ...row('evt_meta'), customer_email: 'buyer@example.com', amount_total: 4900 });
    const rows = await dbQuery<{ customer_email: string; amount_total: number; metadata: string }>(
      'SELECT customer_email, amount_total, metadata FROM processed_stripe_events WHERE event_id = ?',
      ['evt_meta'],
    );
    expect(rows[0].customer_email).toBe('buyer@example.com');
    expect(Number(rows[0].amount_total)).toBe(4900);
    expect(JSON.parse(rows[0].metadata).source).toBe('customer.subscription.created');
  });

  it('a subscription event with no session_id claims cleanly (nullable columns)', async () => {
    // subscription.created carries no checkout session — the shared row shape must cope.
    expect(await tryClaimEvent(row('evt_no_session'))).toBe(true);
    const rows = await dbQuery<{ session_id: string | null }>(
      'SELECT session_id FROM processed_stripe_events WHERE event_id = ?',
      ['evt_no_session'],
    );
    expect(rows[0].session_id).toBeNull();
  });
});
