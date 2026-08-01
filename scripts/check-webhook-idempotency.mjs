#!/usr/bin/env node
// @ts-check
/**
 * check-webhook-idempotency.mjs — every external-webhook branch must claim BEFORE its
 * first side-effect, and no money path may be marked through the fire-and-forget writer.
 *
 * OPS-AUDIT-REMEDIATION-MEDIUM-W1 / Ch2. This is the EXECUTABLE form of a law CLAUDE.md
 * has carried for months:
 *
 *   "every webhook side-effect (tier promo, DB write, email) needs an idempotency store
 *    keyed by provider event-id ... tryClaimEvent() BEFORE the side-effect; duplicate
 *    returns 200 + skips."
 *
 * SEC-20 was that law simply never applied: `customer.subscription.created` minted an
 * API key, overwrote customer metadata and sent the welcome email with no claim, so a
 * Stripe retry issued a SECOND key and invalidated the customer's first. The law was
 * written; nothing enforced it. A gate nobody can bypass is the difference between
 * "we fixed this branch" and "this class cannot come back".
 *
 * WHAT IT ASSERTS (over src/, comments stripped so prose never matches):
 *   R1  Every `case '<provider>.<event>':` in a webhook switch either claims via
 *       tryClaimEvent/tryClaimDelivery/tryClaimPayment before its first side-effect, or
 *       performs no side-effect at all.
 *   R2  An idempotency claim is never written with `dbRun` — the fire-and-forget writer
 *       makes a claim neither atomic nor durable (that was the SEC-20 sub-defect).
 *   R3  A payout/transfer send is preceded by an atomic claim in the same function.
 *
 * Usage:
 *   node scripts/check-webhook-idempotency.mjs --self-test
 *   node scripts/check-webhook-idempotency.mjs
 *
 * Verdict: exactly one terminal `WEBHOOK_IDEMPOTENCY_VERDICT=PASS|FAIL|INDETERMINATE`.
 * Exit: 0 = PASS · 1 = FAIL · 3 = INDETERMINATE (scanned nothing — never a silent pass).
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

/**
 * Literal-aware comment stripper.
 *
 * A naive regex pass (block-comment regex + line-comment regex) is NOT safe on real
 * source: a comment-close sequence, or a double-slash, sitting inside a string or
 * template literal pairs with a distant comment-open and swallows
 * hundreds of lines of REAL CODE. Measured on this repo's `src/index.ts`: the naive
 * stripper removed 96,821 characters and destroyed the entire Stripe webhook switch, so
 * this gate reported PASS while scanning a file with no case labels left in it — the
 * dark-guard class all over again. (`check-canaries-wired.mjs` documents the same defect
 * for YAML globs.) This walks the source tracking string/template state instead.
 *
 * NOTE (CLAUDE.md 3-example-threshold): this is now the 3rd hand-written comment
 * stripper in scripts/. Flagged as a WIS extraction candidate for a dedicated
 * OPS-SHARED-STRIPCOMMENTS-EXTRACTION wave — deliberately NOT inline-extracted here.
 */
export function stripComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  let mode = 'code'; // 'code' | 'block' | 'line' | "'" | '"' | '`'
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (mode === 'code') {
      if (c === '/' && d === '*') { mode = 'block'; i += 2; out += ' '; continue; }
      if (c === '/' && d === '/') { mode = 'line'; i += 2; continue; }
      if (c === "'" || c === '"' || c === '`') { mode = c; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (mode === 'block') {
      if (c === '*' && d === '/') { mode = 'code'; i += 2; } else { if (c === '\n') out += '\n'; i++; }
      continue;
    }
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += '\n'; i++; } else i++;
      continue;
    }
    if (c === '\\') { out += c + (d ?? ''); i += 2; continue; } // escape inside a literal
    if (c === mode) { mode = 'code'; out += c; i++; continue; }
    out += c; i++;
  }
  return out;
}

/**
 * Anti-blind-spot guard. If the stripper drops a `case 'a.b':` label that the RAW source
 * plainly contains, it is destroying code and every R1 verdict from this file is
 * meaningless. Report INDETERMINATE rather than a silent PASS.
 */
export function strippingLostCaseLabels(rawSrc) {
  const count = (s) => (s.match(/case\s+'[a-z_]+(?:\.[a-z_]+)+'\s*:/g) || []).length;
  return count(rawSrc) > count(stripComments(rawSrc));
}

/** Any recognised atomic claim. Named broadly so a new provider's helper still counts. */
const CLAIM_RE = /\btryClaim[A-Za-z]*\s*\(/;

/**
 * Side-effects that must never precede a claim. Deliberately the irreversible /
 * externally-visible ones: minting credentials, mutating the customer at the provider,
 * sending mail, moving money.
 */
const SIDE_EFFECT_RE =
  /\b(generateApiKey|customers\.update|sendWelcomeEmail|sendPayoutPaidEmail|onPaidConversion|processInvoicePaid|handleSubscriptionCreated|sender\.send|\.transfer\s*\()/;

/** `case 'a.b':` — a provider event label, not an internal enum. */
const CASE_RE = /case\s+'([a-z_]+(?:\.[a-z_]+)+)'\s*:/g;

/** Slice a switch case body: from the case label to the next case label or the switch end. */
function caseBodies(code) {
  const out = [];
  CASE_RE.lastIndex = 0;
  let m;
  const starts = [];
  while ((m = CASE_RE.exec(code)) !== null) starts.push({ label: m[1], at: m.index, end: m.index + m[0].length });
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i].end;
    const to = i + 1 < starts.length ? starts[i + 1].at : Math.min(code.length, from + 4000);
    out.push({ label: starts[i].label, body: code.slice(from, to) });
  }
  return out;
}

/**
 * Cases whose claim legitimately lives one level down, inside the handler they call.
 *
 * This is a DECISION, not a default — and it is a VERIFIED exemption, not a bare
 * allowlist. `verifyInternalClaim` re-reads the named module and asserts the named claim
 * anchor is still present; if a future wave removes it, this gate FAILS instead of
 * silently continuing to excuse the case. (CLAUDE.md: "an exemption that lives only in
 * prose gets 'fixed' by a future wave enforcing the contract".)
 */
const INTERNAL_CLAIM = new Map([
  ['invoice.paid', {
    module: 'src/lib/referral-accrual.ts',
    // appendLedger writes referral_ledger.stripe_event_id, which carries a UNIQUE
    // constraint (verified live in production as referral_ledger_stripe_event_id_key);
    // a duplicate returns null and the handler logs "already accrued — skipping".
    anchor: /stripe_event_id:\s*event\.id/,
    reason: 'processInvoicePaid claims on referral_ledger.stripe_event_id (UNIQUE) before crediting',
  }],
]);

/**
 * R1 — a side-effect that runs before (or without) a claim in the same case body.
 * `readModule` is injected so the exemption check is testable offline.
 */
export function findUnclaimedWebhookCases(src, readModule) {
  const hits = [];
  const code = stripComments(src);
  if (!/webhooks?\//.test(code) && !/constructWebhookEvent/.test(code)) return hits; // not a webhook file
  for (const { label, body } of caseBodies(code)) {
    const se = body.search(SIDE_EFFECT_RE);
    if (se === -1) continue; // no side-effect in this branch — nothing to guard
    const claim = body.search(CLAIM_RE);
    if (claim !== -1 && claim < se) continue; // claimed before the side-effect — clean
    const exempt = INTERNAL_CLAIM.get(label);
    if (exempt && readModule) {
      const mod = readModule(exempt.module);
      if (mod && exempt.anchor.test(stripComments(mod))) continue; // exemption still earns itself
      hits.push({
        rule: 'R1',
        detail: `webhook case '${label}' is exempted as "${exempt.reason}", but that claim is GONE from ${exempt.module}`,
        snippet: body.slice(0, 140),
      });
      continue;
    }
    hits.push({
      rule: 'R1',
      detail: claim === -1
        ? `webhook case '${label}' runs a side-effect with NO idempotency claim`
        : `webhook case '${label}' claims AFTER its first side-effect`,
      snippet: body.slice(0, 140),
    });
  }
  return hits;
}

/** R2 — a claim written through the fire-and-forget writer is not a claim. */
export function findFireAndForgetClaims(src) {
  const hits = [];
  const code = stripComments(src);
  // A dbRun whose statement targets a *_claims / processed_*_events idempotency store.
  const re = /dbRun\s*\(\s*[`'"][^`'"]*\b(?:INSERT\s+INTO|UPDATE)\s+(processed_\w+|\w*_claims)\b/gi;
  let m;
  while ((m = re.exec(code)) !== null) {
    hits.push({ rule: 'R2', detail: `idempotency store '${m[1]}' written via fire-and-forget dbRun — not atomic, not durable`, snippet: code.slice(m.index, m.index + 120) });
  }
  return hits;
}

/** R3 — money leaves only downstream of an atomic claim in the same function. */
export function findUnclaimedPayouts(src) {
  const hits = [];
  const code = stripComments(src);
  const send = code.search(/\bsender\s*\.\s*send\s*\(/);
  if (send === -1) return hits;
  const claim = code.search(CLAIM_RE);
  if (claim === -1 || claim > send) {
    hits.push({ rule: 'R3', detail: 'sender.send() is reachable without a preceding atomic claim', snippet: code.slice(Math.max(0, send - 100), send + 60) });
  }
  return hits;
}

export function scanSource(src, readModule) {
  return [...findUnclaimedWebhookCases(src, readModule), ...findFireAndForgetClaims(src), ...findUnclaimedPayouts(src)];
}

// ── fixtures ──────────────────────────────────────────────────────────────────
const WEBHOOK_PRELUDE = "const event = constructWebhookEvent(body, sig);\nswitch (event.type) {\n";

const DIRTY = [
  // R1 — verbatim shape of SEC-20.
  ['R1', WEBHOOK_PRELUDE + "  case 'customer.subscription.created': {\n    const conv = await handleSubscriptionCreated(event);\n    break;\n  }\n}"],
  // R1 — claims, but only AFTER the side-effect has already run.
  ['R1', WEBHOOK_PRELUDE + "  case 'customer.subscription.created': {\n    const conv = await handleSubscriptionCreated(event);\n    const ok = await tryClaimEvent({ event_id: event.id });\n    break;\n  }\n}"],
  // R2 — the sub-defect: a claim through the fire-and-forget writer.
  ['R2', "dbRun(`INSERT INTO processed_stripe_events (event_id) VALUES (?)`, id);"],
  ['R2', "dbRun('INSERT INTO referral_payout_claims (ledger_id, claim_ref) VALUES (?, ?)', id, ref);"],
  // R3 — verbatim shape of SEC-16.
  ['R3', "for (const id of p.ledger_ids) {\n  const row = await getLedgerById(id);\n  if (row && row.status === 'usdc_pending') payableIds.push(id);\n}\nconst { txRef } = await sender.send(p.payout_address, payableE2);"],
  // The VERIFIED exemption must self-invalidate: same case, but the named internal
  // claim is gone from the named module.
  ['R1', WEBHOOK_PRELUDE + "  case 'invoice.paid': {\n    await processInvoicePaid(event);\n    break;\n  }\n}", () => 'const led = await appendLedger({ code });'],
];

const CLEAN = [
  ['claim before side-effect', WEBHOOK_PRELUDE + "  case 'customer.subscription.created': {\n    const isNew = await tryClaimEvent({ event_id: event.id });\n    if (!isNew) return res.json({ received: true, status: 'duplicate' });\n    const conv = await handleSubscriptionCreated(event);\n    break;\n  }\n}"],
  ['branch with no side-effect needs no claim', WEBHOOK_PRELUDE + "  case 'customer.subscription.deleted':\n    console.log('noted');\n    break;\n}"],
  ['claim via awaited dbQuery', "const claimed = await dbQuery('INSERT INTO processed_stripe_events (event_id) VALUES (?) ON CONFLICT (event_id) DO NOTHING RETURNING event_id', [id]);"],
  ['payout claims before sending', "for (const id of p.ledger_ids) {\n  if (!(await tryClaimLedgerForPayout(id, claimRef))) continue;\n  payableIds.push(id);\n}\nconst { txRef } = await sender.send(p.payout_address, payableE2);"],
  // R1 is scoped to webhook files (a `case 'a.b':` in an unrelated module is not a
  // webhook branch). NOTE this fixture deliberately contains NO `sender.send`: R3 is
  // intentionally NOT file-scoped — a payout send anywhere must be claim-gated.
  ['a case label outside a webhook file is not R1-scoped', "case 'a.b': { await handleSubscriptionCreated(event); }"],
  ['non-idempotency dbRun is fine', "dbRun('UPDATE referral_ledger SET status = ? WHERE id = ?', status, id);"],
  ['exemption holds while its internal claim is present', WEBHOOK_PRELUDE + "  case 'invoice.paid': {\n    await processInvoicePaid(event);\n    break;\n  }\n}", () => 'const led = await appendLedger({ stripe_event_id: event.id });'],
];

function selfTest() {
  const fails = [];
  if (DIRTY.length === 0 || CLEAN.length === 0) {
    console.error('✖ self-test corpus is empty — refusing to report a pass');
    return 'INDETERMINATE';
  }
  for (const [rule, fixture, reader] of DIRTY) {
    if (!scanSource(fixture, reader).some((h) => h.rule === rule)) {
      fails.push(`MISSED ${rule}: known-bad fixture not flagged → ${fixture.slice(0, 90).replace(/\n/g, ' ')}`);
    }
  }
  for (const [name, fixture, reader] of CLEAN) {
    const hits = scanSource(fixture, reader);
    if (hits.length) fails.push(`FALSE POSITIVE on "${name}": ${hits.map((h) => h.rule).join(',')}`);
  }
  if (fails.length) {
    console.error('✖ self-test FAILED:');
    fails.forEach((f) => console.error('   - ' + f));
    return 'FAIL';
  }
  console.log(`✓ self-test: ${DIRTY.length} known-bad fixtures flagged, ${CLEAN.length} clean fixtures passed.`);
  return 'PASS';
}

function verdictAndExit(v) {
  console.log(`WEBHOOK_IDEMPOTENCY_VERDICT=${v}`);
  process.exit(v === 'PASS' ? 0 : v === 'FAIL' ? 1 : 3);
}

if (argv.includes('--self-test')) verdictAndExit(selfTest());

const st = selfTest();
if (st !== 'PASS') verdictAndExit(st);

let files;
try {
  files = execFileSync('git', ['ls-files', 'src'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
} catch (err) {
  console.error(`✖ could not enumerate src/: ${err instanceof Error ? err.message : err}`);
  verdictAndExit('INDETERMINATE');
}
if (!files || files.length === 0) {
  console.error('✖ scanned 0 source files — refusing to report a pass');
  verdictAndExit('INDETERMINATE');
}

const findings = [];
for (const f of files) {
  let src;
  try {
    src = readFileSync(join(ROOT, f), 'utf8');
  } catch {
    continue;
  }
  if (strippingLostCaseLabels(src)) {
    console.error(`✖ comment-stripping destroyed case labels in ${f} — this gate cannot see that file`);
    verdictAndExit('INDETERMINATE');
  }
  const readModule = (rel) => { try { return readFileSync(join(ROOT, rel), 'utf8'); } catch { return null; } };
  for (const h of scanSource(src, readModule)) findings.push({ file: f, ...h });
}

if (findings.length) {
  console.error(`✖ ${findings.length} unclaimed side-effect site(s) across ${files.length} file(s):`);
  for (const h of findings) {
    console.error(`   - ${h.file}  [${h.rule}] ${h.detail}`);
    console.error(`     ${h.snippet.replace(/\s+/g, ' ').slice(0, 150)}`);
  }
  verdictAndExit('FAIL');
}

console.log(`✓ webhook idempotency: ${files.length} source files — every webhook side-effect and payout send is claim-gated.`);
verdictAndExit('PASS');
