#!/usr/bin/env node
/**
 * PRICING-BOT-DELIVERY-METERING-W1 CH1 — no NEW hand-rolled claim store.
 *
 * WHY THIS EXISTS. Four independent `tryClaim*` implementations accumulated in `src/lib/`
 * (x402 payments, webhook deliveries, stripe events, signup emails), each re-deriving the same
 * INSERT-ON-CONFLICT-RETURNING dance and its dialect split. The 4th carried a standing WIS to
 * extract a shared helper; this wave needed a 5th, which is where CLAUDE.md's generator rule
 * binds: *"the 4th same-class fix MUST build a gate making the bug class structurally
 * impossible."* `src/lib/idempotency.ts` is the helper; this is the gate that keeps it the
 * only one.
 *
 * THE ALLOWLIST IS SHRINK-ONLY. It names the four incumbents, whose migration is
 * `OPS-IDEMPOTENCY-HELPER-EXTRACTION-W1` and is explicitly deferred — they are live revenue and
 * mail paths, and rewriting them does not belong in a wave about bot metering. The gate FAILS if
 * the list grows, so "just add mine to the allowlist" is not available as an escape.
 *
 * CONTRACT: exactly one terminal `IDEMPOTENCY_HELPER_VERDICT=PASS|FAIL|INDETERMINATE`. Callers
 * gate on the TOKEN, never the exit code. Exit 0=PASS, 1=FAIL, 3=INDETERMINATE.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(ROOT, 'src/lib');

/**
 * The pre-existing hand-rolled stores. SHRINK-ONLY: adding an entry FAILS the gate.
 * Migrating these is OPS-IDEMPOTENCY-HELPER-EXTRACTION-W1 — deferred, not forgotten.
 *
 * ⚠️ THERE ARE SIX, NOT FOUR. The dispatching spec listed four, and the standing WIS in
 * `x402-idempotency-store.ts` names itself plus three siblings — both undercounts. This gate's
 * FIRST run found two more, verified by hand as genuine
 * `INSERT … ON CONFLICT DO NOTHING RETURNING` claim stores:
 *   referral-store.ts      → tryClaimLedgerForPayout  → referral_payout_claims
 *   subscriber-notify.ts   → tryClaimNotification     → subscriber_notifications
 * Both return `boolean` rather than the three-state `ClaimOutcome`, so neither can distinguish
 * "already claimed" from "the database errored" — the precise defect that cost the x402 rail
 * ~25 hours of silent non-service. That makes OPS-IDEMPOTENCY-HELPER-EXTRACTION-W1 a
 * six-store migration, and the WIS prose that says otherwise is stale.
 *
 * Recorded here rather than quietly padded, because a count nobody checked is how the two got
 * missed in the first place. The gate's INTENT is unchanged: no NEW hand-rolled store.
 */
const LEGACY_HANDROLLED_CLAIM_STORES = Object.freeze([
  'src/lib/x402-idempotency-store.ts',
  'src/lib/webhooks-store.ts',
  'src/lib/stripe-events-store.ts',
  'src/lib/signup-emails-store.ts',
  'src/lib/referral-store.ts',
  'src/lib/subscriber-notify.ts',
]);
const LEGACY_COUNT = 6;

const DEFINES_TRY_CLAIM = /^\s*(export\s+)?(async\s+)?function\s+tryClaim/m;
const IMPORTS_HELPER = /from\s+['"]\.\/idempotency\.js['"]/;

/** The helper itself is not a violation of its own rule. */
const HELPER_REL = 'src/lib/idempotency.ts';

export function scanFiles(files) {
  const offenders = [];
  let scanned = 0;
  for (const { rel, source } of files) {
    if (rel === HELPER_REL) continue;
    scanned++;
    if (!DEFINES_TRY_CLAIM.test(source)) continue;
    if (LEGACY_HANDROLLED_CLAIM_STORES.includes(rel)) continue;
    if (IMPORTS_HELPER.test(source)) continue;
    offenders.push(rel);
  }
  return { offenders: offenders.sort(), scanned };
}

function readLib() {
  return readdirSync(LIB)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ rel: `src/lib/${f}`, source: readFileSync(join(LIB, f), 'utf8') }));
}

function run() {
  if (LEGACY_HANDROLLED_CLAIM_STORES.length !== LEGACY_COUNT) {
    console.log(
      `allowlist holds ${LEGACY_HANDROLLED_CLAIM_STORES.length} entries, expected exactly ${LEGACY_COUNT} — ` +
        'it is SHRINK-ONLY; a new hand-rolled store may not be admitted by widening it',
    );
    console.log('IDEMPOTENCY_HELPER_VERDICT=FAIL');
    return 1;
  }
  let files;
  try {
    files = readLib();
  } catch (err) {
    console.log(`could not read src/lib: ${err.message}`);
    console.log('IDEMPOTENCY_HELPER_VERDICT=INDETERMINATE');
    return 3;
  }
  const { offenders, scanned } = scanFiles(files);
  // Print the corpus size beside every result: a sweep that searched nothing must never be
  // indistinguishable from a clean one.
  console.log(`scanned ${scanned} modules under src/lib (allowlisted: ${LEGACY_COUNT})`);
  if (scanned === 0) {
    console.log('scanned nothing — the extractor is broken, not the repo');
    console.log('IDEMPOTENCY_HELPER_VERDICT=INDETERMINATE');
    return 3;
  }
  // Every allowlisted entry must still exist: a stale exemption is the permission-slip shape.
  const present = new Set(files.map((f) => f.rel));
  const ghosts = LEGACY_HANDROLLED_CLAIM_STORES.filter((p) => !present.has(p));
  for (const g of ghosts) console.log(`  ✗ allowlisted ${g} no longer exists — shrink the list`);
  for (const o of offenders) console.log(`  ✗ ${o} defines its own tryClaim* and does not import ./idempotency.js`);
  const ok = offenders.length === 0 && ghosts.length === 0;
  console.log(`IDEMPOTENCY_HELPER_VERDICT=${ok ? 'PASS' : 'FAIL'}`);
  return ok ? 0 : 1;
}

// ── self-test ───────────────────────────────────────────────────────────────
function selfTest() {
  const cases = [
    ['a module with no claim function', [{ rel: 'src/lib/foo.ts', source: 'export function bar() {}' }], 0],
    ['a NEW hand-rolled tryClaim', [{ rel: 'src/lib/new-store.ts', source: 'export async function tryClaimThing() {}' }], 1],
    ['a new store that DOES import the helper', [{ rel: 'src/lib/new-store.ts', source: "import { tryClaimOnce } from './idempotency.js';\nexport async function tryClaimThing() {}" }], 0],
    ['an allowlisted incumbent', [{ rel: 'src/lib/webhooks-store.ts', source: 'export async function tryClaimDelivery() {}' }], 0],
    ['the helper itself is exempt', [{ rel: HELPER_REL, source: 'export async function tryClaimOnce() {}' }], 0],
  ];
  let passed = 0, failed = 0;
  for (const [label, files, expected] of cases) {
    let got;
    try { got = scanFiles(files).offenders.length; } catch (e) { got = `CRASH(${e.message})`; }
    if (got === expected) { passed++; console.log(`  ✓ ${label}: ${got} offender(s)`); }
    else { failed++; console.log(`  ✗ ${label}: expected ${expected}, got ${got}`); }
  }
  // Vacuity at the construction site.
  const probe = scanFiles([{ rel: 'src/lib/a.ts', source: 'x' }]);
  if (probe.scanned === 0) { failed++; console.log('  ✗ vacuity: fixture corpus scanned to zero'); }
  else { passed++; console.log(`  ✓ vacuity: fixture corpus non-empty (${probe.scanned})`); }
  // The bypassed artifact: the real readdir + read of src/lib, which no fixture exercises.
  try {
    const real = readLib();
    const hasAll = LEGACY_HANDROLLED_CLAIM_STORES.every((p) => real.some((f) => f.rel === p));
    if (real.length >= 20 && hasAll) { passed++; console.log(`  ✓ bypassed artifact: real src/lib reads (${real.length} modules, all incumbents present)`); }
    else { failed++; console.log(`  ✗ bypassed artifact: real read implausible (${real.length} modules, incumbents_present=${hasAll})`); }
  } catch (e) { failed++; console.log(`  ✗ bypassed artifact: real read raised ${e.message}`); }

  console.log(`SELF-TEST: ${failed === 0 ? 'PASS' : 'FAIL'} (${passed} passed, ${failed} failed)`);
  console.log(`IDEMPOTENCY_HELPER_VERDICT=${failed === 0 ? 'PASS' : 'FAIL'}`);
  return failed === 0 ? 0 : 1;
}

process.exit(process.argv.includes('--self-test') ? selfTest() : run());
