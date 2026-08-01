#!/usr/bin/env node
// @ts-check
/**
 * check-iphash-keyed.mjs — no unkeyed hash of an IP-derived value may exist in src/.
 *
 * OPS-SEC-IPHASH-SALT-W1 (R4), retiring the lane-copy class.
 *
 * THE BUG CLASS: `hashIp` was `sha256(ip)[0:16]` — unkeyed over a ~2^24 input space, so every
 * stored `ip_hash` was reversible by brute force and the analytics/quota tables were an address
 * store. The wave fixed the ONE function. What this gate prevents is the fix being quietly
 * undone in a NEW lane: someone writing a second `createHash('sha256').update(ip)` somewhere
 * else, which re-creates the identical defect while `hashIp` stays impeccable.
 *
 * WHAT IT ASSERTS
 *   1. No `createHash(...)` in src/ is fed an IP-derived value (a name containing ip/addr/remote).
 *   2. `hashIp` itself uses `createHmac`, not `createHash`.
 *   3. Every emitted pseudonym is version-tagged (IP_HASH_VERSION is prefixed in hashIp).
 *   4. No `?? '<literal>'`-style fallback around the key — a defaulted key is the bug relabelled.
 *
 * Usage:
 *   node scripts/check-iphash-keyed.mjs --self-test   # both directions, offline
 *   node scripts/check-iphash-keyed.mjs               # scan src/
 * Exit: 0 = clean · 1 = an unkeyed IP hash exists, or the detector itself broke.
 */

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

/** Strip comments so the gate never matches prose ABOUT the defect it hunts. */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}

/** An identifier that plausibly holds an address. Deliberately broad — a false hit is cheap. */
const IP_ISH = /\b(ip|ipv4|ipv6|addr|address|remote|remoteAddress|clientIp|resolvedIp)\b/i;

/**
 * Find `createHash(...)` calls whose update(...) argument looks IP-derived.
 * Matches across a chained one-liner, which is how the original defect was written.
 */
export function findUnkeyedIpHashes(src) {
  const hits = [];
  const code = stripComments(src);
  const re = /createHash\s*\(\s*['"][^'"]+['"]\s*\)\s*(?:\.\s*update\s*\(([^)]*)\))?/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const arg = (m[1] || '').trim();
    if (!arg) continue;                 // createHash with no inline update — cannot classify
    if (IP_ISH.test(arg)) hits.push(arg.slice(0, 60));
  }
  return hits;
}

/** The key must never be defaulted. `?? 'x'` / `|| 'x'` around it re-introduces a silent fallback. */
export function findKeyFallbacks(src) {
  const code = stripComments(src);
  const hits = [];
  const re = /ALGOVAULT_IP_HASH_KEY\s*\]?\s*(\?\?|\|\|)\s*['"`]/g;
  let m;
  while ((m = re.exec(code)) !== null) hits.push(m[0]);
  return hits;
}

function trackedSrcFiles() {
  return execFileSync('git', ['ls-files', 'src'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter((f) => /\.ts$/.test(f));
}

/**
 * Both directions. A gate that only ever passes cannot be distinguished from one that cannot fail
 * — the exact shape this repo's sibling canaries exist to retire.
 */
function selfTest() {
  const fails = [];

  // MUST fire — the original defect, and the plausible lane-copies of it.
  const bad = [
    "crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16)",
    "createHash('sha256').update(clientIp(req)).digest('hex')",
    "createHash('sha1').update(remoteAddress).digest('hex')",
    'createHash("sha256").update(req.ip).digest("hex")',
  ];
  for (const s of bad) {
    if (findUnkeyedIpHashes(s).length === 0) fails.push(`MISSED an unkeyed IP hash: ${s.slice(0, 52)}`);
  }

  // MUST NOT fire — the keyed form, and content hashes that merely live nearby.
  const good = [
    "crypto.createHmac('sha256', key).update(ip).digest('hex').slice(0, 16)",
    "createHash('sha256').update(fileContents).digest('hex')",
    "createHash('sha256').update(JSON.stringify(manifest)).digest('hex')",
    "createHash('sha256').update(question).digest('hex')",
  ];
  for (const s of good) {
    if (findUnkeyedIpHashes(s).length) fails.push(`FALSE POSITIVE on a legitimate hash: ${s.slice(0, 52)}`);
  }

  // Comment-only mentions must not count — this file and the fix both DESCRIBE the defect.
  const commented = "// was createHash('sha256').update(ip).digest('hex')\nconst x = 1;";
  if (findUnkeyedIpHashes(commented).length) fails.push('a comment describing the defect counted as the defect');

  // Key-fallback detector, both ways.
  if (findKeyFallbacks("const k = process.env.ALGOVAULT_IP_HASH_KEY ?? 'dev'").length === 0) {
    fails.push('MISSED a `?? "literal"` fallback on the key');
  }
  if (findKeyFallbacks("const k = resolveIpHashKey();").length) {
    fails.push('FALSE POSITIVE on the correct key resolution');
  }
  return fails;
}

const stFails = selfTest();
if (stFails.length) {
  console.error('✖ iphash-keyed self-test FAILED — refusing to report a vacuous pass:');
  stFails.forEach((f) => console.error('   - ' + f));
  process.exit(1);
}

if (argv.includes('--self-test')) {
  console.log('✓ iphash-keyed self-test passed (fires on unkeyed IP hashes + key fallbacks; silent on HMAC, content hashes and comments)');
  process.exit(0);
}

const files = trackedSrcFiles();
const offenders = [];
for (const f of files) {
  const abs = join(ROOT, f);
  if (!existsSync(abs)) continue;
  const src = readFileSync(abs, 'utf8');
  for (const h of findUnkeyedIpHashes(src)) offenders.push(`${f}  unkeyed hash of → ${h}`);
  for (const h of findKeyFallbacks(src)) offenders.push(`${f}  key fallback → ${h}`);
}

// The fix itself must remain keyed + versioned. If someone reverts hashIp, the scan above would
// catch it — but assert positively too, so the gate says what it verified rather than only what
// it failed to find.
const analytics = readFileSync(join(ROOT, 'src/lib/analytics.ts'), 'utf8');
const acode = stripComments(analytics);
if (!/createHmac\s*\(/.test(acode)) offenders.push('src/lib/analytics.ts  hashIp no longer uses createHmac');
if (!/IP_HASH_VERSION\s*=\s*['"]v\d+['"]/.test(acode)) offenders.push('src/lib/analytics.ts  IP_HASH_VERSION missing');
if (!/\$\{IP_HASH_VERSION\}:/.test(acode)) offenders.push('src/lib/analytics.ts  pseudonym is no longer version-tagged');

if (offenders.length) {
  console.error(`✖ ${offenders.length} unkeyed-IP-hash / key-fallback violation(s):`);
  offenders.forEach((o) => console.error('   - ' + o));
  console.error('\n  An unkeyed hash of an address is not a pseudonym — the input space is small');
  console.error('  enough to brute-force in seconds. Use hashIp() from src/lib/analytics.ts, which');
  console.error('  is HMAC-keyed and version-tagged. See docs/RUNBOOK-IPHASH-ROTATION.md.');
  process.exit(1);
}
console.log(`✓ iphash-keyed: no unkeyed IP hash and no key fallback across ${files.length} src files; hashIp is HMAC-keyed and ${/IP_HASH_VERSION = '([^']+)'/.exec(acode)?.[1] ?? '?'}-tagged.`);
process.exit(0);
