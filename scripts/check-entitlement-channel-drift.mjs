#!/usr/bin/env node
/**
 * PRICING-BOT-DELIVERY-METERING-W1 CH1 — CHANNEL_BILLING_POLICY must cover exactly the channels
 * that exist, in both directions.
 *
 * WHY BOTH DIRECTIONS. `Record<ChannelId, …>` already makes a MISSING policy a `tsc` error, so
 * half the job is done by the type system. The half it cannot do is the reverse: a policy for a
 * channel that has been removed from `feature-registry.ts` still compiles, and a stale entry rots
 * into a permission slip — `consumeEntitlement` would happily debit through a policy for a channel
 * nothing can reach. That is the L2b lesson from `check-quota-refusal-seam.py`, where a lane table
 * naming a function nobody had was exactly how a dark module kept looking wired.
 *
 * The `ChannelId` union is also asserted against the registry, because the union is what the type
 * system checks the Record against — if the union itself drifts, `tsc` is checking the wrong set
 * and reports nothing.
 *
 * CONTRACT: exactly one terminal `ENTITLEMENT_CHANNEL_DRIFT_VERDICT=PASS|FAIL|INDETERMINATE`.
 * Callers gate on the TOKEN, never the exit code. Exit 0=PASS, 1=FAIL, 3=INDETERMINATE — 3 being
 * the token-law default for a NEW gate.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const POLICY_SRC = join(ROOT, 'src/lib/entitlement-channels.ts');
const REGISTRY_SRC = join(ROOT, 'src/lib/feature-registry.ts');

/** Keys of every `channels: { … }` object literal in the registry, plus the type declaration. */
export function registryChannelKeys(source) {
  const keys = new Set();
  // Matches both the interface declaration (`channels: { mcp: boolean; … }`) and every data
  // literal (`channels: { mcp: true, … }`). Reading BOTH is deliberate: a channel present in the
  // type but in no row is still a channel the system claims to have.
  for (const m of source.matchAll(/channels\s*:\s*\{([^}]*)\}/g)) {
    for (const k of m[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) keys.add(k[1]);
  }
  return keys;
}

/** Keys declared in `CHANNEL_BILLING_POLICY`, and the members of the `ChannelId` union. */
export function policyChannelKeys(source) {
  const body = source.match(
    /CHANNEL_BILLING_POLICY\s*:\s*Readonly<Record<ChannelId,[^>]*>>\s*=\s*Object\.freeze\(\{([\s\S]*?)\n\}\);/,
  );
  const keys = new Set();
  if (body) {
    // Top-level keys only: a nested `debitMode:` must not be mistaken for a channel. Anchored on
    // the two-space indent the file is formatted with.
    for (const k of body[1].matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\{/gm)) keys.add(k[1]);
  }
  const union = new Set();
  const u = source.match(/export type ChannelId\s*=([^;]*);/);
  if (u) for (const m of u[1].matchAll(/'([^']+)'/g)) union.add(m[1]);
  return { keys, union };
}

export function compare(registry, policy, union) {
  const missing = [...registry].filter((k) => !policy.has(k)).sort();
  const stale = [...policy].filter((k) => !registry.has(k)).sort();
  const unionDrift = [...new Set([
    ...[...registry].filter((k) => !union.has(k)),
    ...[...union].filter((k) => !registry.has(k)),
  ])].sort();
  return { missing, stale, unionDrift, ok: !missing.length && !stale.length && !unionDrift.length };
}

function run() {
  let registry, policy, union;
  try {
    registry = registryChannelKeys(readFileSync(REGISTRY_SRC, 'utf8'));
    ({ keys: policy, union } = policyChannelKeys(readFileSync(POLICY_SRC, 'utf8')));
  } catch (err) {
    // Input we were HANDED and could not read/parse is INDETERMINATE, always.
    console.log(`could not read the sources: ${err.message}`);
    console.log('ENTITLEMENT_CHANNEL_DRIFT_VERDICT=INDETERMINATE');
    return 3;
  }
  // Vacuity: the world builds this corpus, but a registry known to declare six channels yielding
  // none means the EXTRACTOR broke, not that the repo is clean. Never PASS on that.
  if (registry.size === 0 || policy.size === 0) {
    console.log(`extracted registry=${registry.size} policy=${policy.size} — the extractor is broken, not the repo`);
    console.log('ENTITLEMENT_CHANNEL_DRIFT_VERDICT=INDETERMINATE');
    return 3;
  }
  const r = compare(registry, policy, union);
  console.log(`registry channels: ${[...registry].sort().join(', ')} (${registry.size})`);
  console.log(`policy channels:   ${[...policy].sort().join(', ')} (${policy.size})`);
  for (const k of r.missing) console.log(`  ✗ ${k} is in feature-registry.ts but has NO billing policy`);
  for (const k of r.stale) console.log(`  ✗ ${k} has a billing policy but is in NO feature-registry channels object — stale entry`);
  for (const k of r.unionDrift) console.log(`  ✗ ${k} — the ChannelId union disagrees with the registry, so tsc is checking the wrong set`);
  console.log(`ENTITLEMENT_CHANNEL_DRIFT_VERDICT=${r.ok ? 'PASS' : 'FAIL'}`);
  return r.ok ? 0 : 1;
}

// ── self-test ───────────────────────────────────────────────────────────────
// Fixtures are pushed through the REAL extractors, never a hand-written stand-in: a prior gate in
// this repo passed its own property test because its fixture used a shape the extractor never
// emits (`verification-gates.md`).
function selfTest() {
  const REG = `export interface F { channels: { mcp: boolean; bot: boolean }; }
  export const R = [{ channels: { mcp: true, bot: false } }];`;
  const POL = (entries, union) => `export type ChannelId =${union};
export const CHANNEL_BILLING_POLICY: Readonly<Record<ChannelId, ChannelBillingPolicy>> = Object.freeze({
${entries}
});`;
  const entry = (k) => `  ${k}: {\n    debitMode: 'by-key',\n    refusesAtWall: true,\n    rationale: 'x',\n  },`;

  const cases = [
    ['aligned', REG, POL([entry('mcp'), entry('bot')].join('\n'), " 'mcp' | 'bot'"), 'PASS'],
    ['policy missing a registry channel', REG, POL(entry('mcp'), " 'mcp'"), 'FAIL'],
    ['policy has a channel the registry dropped', REG, POL([entry('mcp'), entry('bot'), entry('ghost')].join('\n'), " 'mcp' | 'bot' | 'ghost'"), 'FAIL'],
    ['union drifts from the registry', REG, POL([entry('mcp'), entry('bot')].join('\n'), " 'mcp'"), 'FAIL'],
  ];
  let passed = 0, failed = 0;
  for (const [label, reg, pol, expected] of cases) {
    let got;
    try {
      const r = registryChannelKeys(reg);
      const { keys, union } = policyChannelKeys(pol);
      got = compare(r, keys, union).ok ? 'PASS' : 'FAIL';
    } catch (e) {
      got = `CRASH(${e.message})`; // an assertion that RAISES is not an assertion
    }
    if (got === expected) { passed++; console.log(`  ✓ ${label}: ${got}`); }
    else { failed++; console.log(`  ✗ ${label}: expected ${expected}, got ${got}`); }
  }
  // Vacuity guard at the CONSTRUCTION site: in --self-test WE build the corpus, so an empty
  // extraction means the test built nothing — a defect in the test.
  const probe = registryChannelKeys(REG);
  if (probe.size === 0) { failed++; console.log('  ✗ vacuity: fixture registry parsed to nothing'); }
  else { passed++; console.log(`  ✓ vacuity: fixture registry non-empty (${probe.size})`); }
  // The seam these fixtures replace is the parse of REAL source, so no scenario above executes it.
  try {
    const real = registryChannelKeys(readFileSync(REGISTRY_SRC, 'utf8'));
    const { keys } = policyChannelKeys(readFileSync(POLICY_SRC, 'utf8'));
    if (real.size >= 6 && keys.size >= 6) { passed++; console.log(`  ✓ bypassed artifact: real sources parse (${real.size}/${keys.size})`); }
    else { failed++; console.log(`  ✗ bypassed artifact: real parse implausibly small (${real.size}/${keys.size})`); }
  } catch (e) { failed++; console.log(`  ✗ bypassed artifact: real parse raised ${e.message}`); }

  console.log(`SELF-TEST: ${failed === 0 ? 'PASS' : 'FAIL'} (${passed} passed, ${failed} failed)`);
  console.log(`ENTITLEMENT_CHANNEL_DRIFT_VERDICT=${failed === 0 ? 'PASS' : 'FAIL'}`);
  return failed === 0 ? 0 : 1;
}

process.exit(process.argv.includes('--self-test') ? selfTest() : run());
