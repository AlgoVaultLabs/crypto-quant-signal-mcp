#!/usr/bin/env npx tsx
/**
 * REVENUE-METER-TRUTH-W5 CH4 — one-shot recovery of the subscriber profiles lost while
 * `buildSubscriberProfile` was silently dropping every write (2026-06-08 → the 22007 bind fix).
 *
 * Thin wrapper around `backfillMissingSubscriberProfiles()` in `src/lib/subscriber-attribution.ts`
 * (scripts/ is outside tsc rootDir, so this file is never compiled — the logic lives in the lib).
 * Replays each recorded `checkout.session.completed` through the REPAIRED producer; idempotent via
 * the upsert's `ON CONFLICT (customer_id) DO UPDATE`.
 *
 * Local / dev:
 *   npx tsx scripts/backfill-subscriber-profiles.ts
 *
 * PROD (the container prunes tsx — run against the compiled dist instead):
 *   docker exec <ctr> node -e "Promise.all([ \
 *       import('./dist/lib/subscriber-attribution.js'), import('./dist/lib/stripe.js'), \
 *       import('./dist/lib/performance-db.js') \
 *     ]).then(([m, s, db]) => { \
 *       const c = s.getStripeClient(); \
 *       if (!c) throw new Error('stripe not configured'); \
 *       return m.backfillMissingSubscriberProfiles({ retrieveSession: (id) => c.checkout.sessions.retrieve(id) }) \
 *         .then(n => db.closeDbAsync().then(() => n)); \
 *     }).then(n => { console.log('replayed', n); process.exit(0); }) \
 *       .catch(e => { console.error(e); process.exit(1); })"
 *
 * 🛑 The `closeDbAsync()` is NOT optional. `dbRun` is fire-and-forget on PG, so exiting straight
 * after the loop kills the last in-flight write — measured: 2 of 3 landed, silently.
 *
 * (That invocation form is the one the sibling `backfill-subscriber-bridges.ts` documents and the
 * one `subscriber-attribution.ts`'s docblock used to get wrong — it prescribed a
 * `dist/scripts/…` path that cannot exist because repo-root scripts/ is never compiled.)
 */
import { backfillMissingSubscriberProfiles } from '../src/lib/subscriber-attribution.js';
import { getStripeClient } from '../src/lib/stripe.js';
import { runScript } from '../src/lib/script-lifecycle.js';

async function main(): Promise<void> {
  const client = getStripeClient();
  if (!client) { console.error('[backfill-subscriber-profiles] Stripe not configured — refusing'); process.exit(1); }
  const n = await backfillMissingSubscriberProfiles({
    retrieveSession: (id: string) => client.checkout.sessions.retrieve(id) as unknown as Promise<unknown>,
  });
  console.log(`[backfill-subscriber-profiles] replayed ${n}`);
}

// runScript owns the exit lifecycle: success -> DRAIN -> exit(0), failure -> log -> drain -> exit(1)
// (OPS-SCRIPT-EXIT-LIFECYCLE-W1). Draining is load-bearing here, not hygiene — see the lib docblock.
void runScript('backfill-subscriber-profiles', main);
