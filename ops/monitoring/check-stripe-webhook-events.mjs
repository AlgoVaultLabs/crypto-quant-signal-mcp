#!/usr/bin/env node
/**
 * check-stripe-webhook-events.mjs — Stripe webhook `enabled_events` drift canary.
 * OPS-STRIPE-WEBHOOK-EVENT-SUBSCRIPTION-W1 (R3).
 *
 * Asserts the LIVE Stripe webhook endpoint's `enabled_events` ⊇ the set of events the
 * webhook handler actually processes (the `src/index.ts` switch `case` labels). This
 * retires the drift class that caused WEBHOOK-RECORDING-GAP-DIAGNOSIS (2026-06-08): the
 * handler expecting an event that Stripe was never configured to deliver. Any future
 * handler-added event that isn't subscribed in Stripe is now caught automatically.
 *
 * Exit codes:
 *   0  clean   — live enabled_events ⊇ EXPECTED
 *   1  DRIFT   — missing ≥1 expected event; prints a single operator-action alert body
 *               (the host wrapper pages via send_telegram.sh on this code only)
 *   2  ERROR   — canary infra failure (no key / Stripe unreachable / endpoint not found);
 *               log-only / fail-open — does NOT page (a canary outage is not a config drift)
 *
 * Modes:
 *   (default)                GET the live endpoint by URL using STRIPE_SECRET_KEY (env).
 *   --simulate-live "<csv>"  treat <csv> as the live enabled_events (no Stripe call) — the
 *                            dry-run gate that proves a non-zero exit on a simulated miss.
 */
import process from 'node:process';

const ENDPOINT_URL = 'https://api.algovault.com/webhooks/stripe';

// ⚠️ KEEP IN SYNC with the webhook switch in src/index.ts (the `case '<event>':` labels).
// Shipping a new handler case + deploy WITHOUT subscribing the event in Stripe is exactly
// the drift this canary catches on its next run.
//
// 🛑 THIS ARRAY WAS VIOLATING ITS OWN CONTRACT (fixed 2026-08-06, OPS-STRIPE-SUBSCRIPTION-TRUTH-W2
// CH3). It held THREE of the five events the switch handled, silently omitting `invoice.paid` and
// `charge.refunded` since they were added. Because the check is a SUPERSET test
// (live ⊇ EXPECTED), the omission never failed — it passed while proving less than it claimed,
// which is the more dangerous shape: a declaration nobody watched fail. Unsubscribing either of
// those two in Stripe would have gone undetected indefinitely.
//
// It is now the full set, enumerated against the switch and against the live endpoint.
// If you add a `case` to that switch, add it here in the SAME commit — and remember there are
// TWO byte-identical copies of this file (`ops/monitoring/` and `scripts/`).
//
// SIX → NINE by PAY-UNIONPAY-ATTRIBUTION-W1 (R4b), which added three FAILURE cases to the
// switch. They belong here for the same reason the array exists at all: that wave's whole
// deliverable is a measurable decline rate, and a decline rate whose failure events Stripe
// was never configured to deliver would read as a flawless 0% — the most dangerous possible
// value, because it looks like good news rather than like a broken instrument.
const EXPECTED = [
  'charge.failed',
  'charge.refunded',
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.deleted',
  'customer.subscription.updated',
  'invoice.paid',
  'invoice.payment_failed',
  'payment_intent.payment_failed',
];

const ALERT_ID = 'STRIPE_WEBHOOK_EVENT_DRIFT';
// Template form per CLAUDE.md (hardcoded recommended_wave FORBIDDEN); send_telegram.sh
// resolves {NEXT} from status.md at send time.
const RECOMMENDED_WAVE = 'OPS-STRIPE-WEBHOOK-EVENT-SUBSCRIPTION-W{NEXT}';

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--simulate-live') { a.simulate = argv[++i]; continue; }
    if (k.startsWith('--')) a[k.slice(2)] = true;
  }
  return a;
}

// Pure + exported for unit testing.
export function computeMissing(expected, live) {
  const liveSet = new Set(live);
  return expected.filter((e) => !liveSet.has(e));
}

async function fetchLiveEnabledEvents() {
  const KEY = process.env.STRIPE_SECRET_KEY || '';
  if (!KEY) throw new Error('STRIPE_SECRET_KEY not set');
  const res = await fetch('https://api.stripe.com/v1/webhook_endpoints?limit=100', {
    headers: { Authorization: 'Bearer ' + KEY },
  });
  if (!res.ok) throw new Error(`Stripe HTTP ${res.status}`);
  const body = await res.json();
  const ep = (body.data || []).find((e) => e.url === ENDPOINT_URL && e.status === 'enabled');
  if (!ep) throw new Error(`no enabled endpoint at ${ENDPOINT_URL}`);
  return ep.enabled_events || [];
}

function alertBody(missing, live) {
  return [
    `🛑 ${ALERT_ID}`,
    `Live Stripe webhook endpoint (${ENDPOINT_URL}) is missing ${missing.length} handler event(s): ${missing.join(', ')}`,
    `live enabled_events=[${live.join(', ')}] vs handler-expected [${EXPECTED.join(', ')}]`,
    `Action: dispatch ${RECOMMENDED_WAVE} via Cowork → Claude Code`,
    `Audit shape: audits/WEBHOOK-RECORDING-GAP-DIAGNOSIS-2026-06-08.md`,
    `Source: /var/log/stripe-webhook-events-canary.log`,
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  let live;
  try {
    live = args.simulate != null
      ? String(args.simulate).split(',').map((s) => s.trim()).filter(Boolean)
      : await fetchLiveEnabledEvents();
  } catch (e) {
    process.stderr.write(`CANARY_ERROR: ${e.message}\n`);
    process.exit(2); // canary-infra failure → log-only / fail-open (never page on our own outage)
  }
  const missing = computeMissing(EXPECTED, live);
  if (missing.length === 0) {
    process.stdout.write(`OK: enabled_events superset of handler set (${EXPECTED.length} events covered)\n`);
    process.exit(0);
  }
  process.stdout.write(alertBody(missing, live) + '\n');
  process.exit(1);
}

main();
