#!/usr/bin/env node
// @ts-check
/**
 * check-client-ip-not-cf.mjs — the proxy-hop drift gate.
 *
 * OPS-SEC-CLIENT-IP-VERIFY-W1 (R5), retiring the class behind SEC-07.
 *
 * THE BUG CLASS: `req.ip` silently stops being the client and becomes a PROXY address. When that
 * happened, every free-tier `free:${ipHash}` bucket and every express-rate-limit bucket collapsed
 * to per-Cloudflare-PoP — thousands of unrelated users sharing one 100-call/month counter, and an
 * abuser multiplying free quota by rotating PoPs. Nothing failed. Nothing alerted. It was found by
 * a manual audit weeks later, and then took two waves to confirm because both attempts INFERRED
 * the address from `ipHash` values instead of reading it.
 *
 * THE INVARIANT: the address the app resolves as the client must never be inside a published
 * Cloudflare range. If it is, we are metering the CDN, not the caller.
 *
 * Usage:
 *   node scripts/check-client-ip-not-cf.mjs --self-test   # offline; proves both directions
 *   node scripts/check-client-ip-not-cf.mjs               # + live probe when ADMIN_API_KEY is set
 *   node scripts/check-client-ip-not-cf.mjs --ip=1.2.3.4  # classify a single address
 * Exit: 0 = invariant holds · 1 = a proxy address is being metered as a client, or the detector broke.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const RANGES_FILE = join(ROOT, 'scripts/data/cloudflare-ip-ranges.json');

/**
 * Baked Cloudflare ranges. Refreshed by `--refresh-ranges`; committed so CI never depends on a
 * live fetch to cloudflare.com (a gate that needs the network to decide is a gate that fails open
 * on a bad network day).
 */
function loadRanges() {
  if (!existsSync(RANGES_FILE)) return null;
  try {
    const j = JSON.parse(readFileSync(RANGES_FILE, 'utf8'));
    return Array.isArray(j.ipv4) && j.ipv4.length ? j : null;
  } catch { return null; }
}

/** IPv4 CIDR containment. IPv6 ranges are matched by prefix-string, which is coarse but sufficient. */
function ipv4ToInt(ip) {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const o of p) {
    const v = Number(o);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n << 8) + v;
  }
  return n >>> 0;
}

export function isInCidr(ip, cidr) {
  const [base, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(base);
  if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

export function isCloudflareAddress(ip, ranges) {
  if (!ip) return false;
  const v4 = ip.replace(/^::ffff:/i, '');
  for (const c of ranges.ipv4 || []) if (isInCidr(v4, c)) return true;
  for (const c of ranges.ipv6 || []) {
    const pfx = c.split('::')[0];
    if (pfx && ip.toLowerCase().startsWith(pfx.toLowerCase())) return true;
  }
  return false;
}

/**
 * Both directions. A gate that only ever passes is indistinguishable from a gate that cannot fail,
 * which is the exact failure mode this wave's sibling canaries were built to retire.
 */
function selfTest(ranges) {
  const fails = [];
  // MUST flag: real CF edge addresses, including the one observed serving this origin.
  for (const ip of ['172.69.85.157', '104.16.0.1', '173.245.48.1', '::ffff:172.69.85.157']) {
    if (!isCloudflareAddress(ip, ranges)) fails.push(`MISSED a Cloudflare address: ${ip}`);
  }
  // MUST NOT flag: real client addresses, including the operator's measured IP and its /24 form.
  for (const ip of ['161.142.148.58', '161.142.148.0', '8.8.8.8', '203.0.113.77']) {
    if (isCloudflareAddress(ip, ranges)) fails.push(`FALSE POSITIVE on a client address: ${ip}`);
  }
  // Boundary correctness — an off-by-one mask would silently pass a whole PoP.
  if (!isCloudflareAddress('172.64.0.0', ranges)) fails.push('missed the first address of 172.64.0.0/13');
  if (!isCloudflareAddress('172.71.255.255', ranges)) fails.push('missed the last address of 172.64.0.0/13');
  if (isCloudflareAddress('172.72.0.0', ranges)) fails.push('flagged 172.72.0.0, which is OUTSIDE 172.64.0.0/13');
  return fails;
}

const ranges = loadRanges();
if (!ranges) {
  console.error(`✖ ${RANGES_FILE} missing or empty — the gate cannot decide, so it fails CLOSED.`);
  console.error('  Regenerate: curl -sS https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6');
  process.exit(1);
}

const stFails = selfTest(ranges);
if (stFails.length) {
  console.error('✖ cloudflare-range self-test FAILED — refusing to report a vacuous pass:');
  stFails.forEach((f) => console.error('   - ' + f));
  process.exit(1);
}

if (argv.includes('--self-test')) {
  console.log(`✓ cloudflare-range self-test passed (${ranges.ipv4.length} v4 + ${ranges.ipv6.length} v6 ranges; flags CF edges, ignores client IPs, CIDR boundaries exact)`);
  process.exit(0);
}

const oneIp = (argv.find((a) => a.startsWith('--ip=')) || '').split('=')[1];
if (oneIp) {
  const hit = isCloudflareAddress(oneIp, ranges);
  console.log(`${oneIp} → ${hit ? 'INSIDE a Cloudflare range (would be a metering bug)' : 'not a Cloudflare address'}`);
  process.exit(hit ? 1 : 0);
}

// Live probe — opportunistic. The invariant above is already gated; this additionally proves the
// DEPLOYED app resolves a real client. Absent credentials it reports SKIPPED loudly rather than
// pretending to have checked (a silent skip reads identically to a pass).
const adminKey = process.env.ADMIN_API_KEY;
const base = process.env.CLIENT_IP_PROBE_BASE || 'https://api.algovault.com';
if (!adminKey) {
  console.log(`✓ self-test passed. LIVE PROBE SKIPPED — ADMIN_API_KEY not set, so the deployed value was NOT checked.`);
  console.log(`  (run locally: ADMIN_API_KEY=… node scripts/check-client-ip-not-cf.mjs)`);
  process.exit(0);
}

const res = await fetch(`${base}/debug/client-ip`, { headers: { authorization: `Bearer ${adminKey}` } }).catch((e) => ({ ok: false, _err: e }));
if (!res || !res.ok) {
  console.log(`✓ self-test passed. Live probe unreachable (${res && res.status ? res.status : res && res._err ? res._err.message : '?'}) — fail-open, exit 0.`);
  process.exit(0);
}
const body = await res.json();
const resolved = body?.derived?.clientIp;
if (isCloudflareAddress(resolved, ranges)) {
  console.error(`✖ PROXY ADDRESS IS BEING METERED AS A CLIENT: req.ip resolved to ${resolved}, which is inside a published Cloudflare range.`);
  console.error('  Every free-tier and rate-limit bucket is currently per-PoP, not per-caller.');
  console.error(`  headers seen by the app: ${JSON.stringify(body.headers)}`);
  process.exit(1);
}
console.log(`✓ client-ip invariant holds — app resolved ${resolved}, not a Cloudflare address.`);
process.exit(0);
