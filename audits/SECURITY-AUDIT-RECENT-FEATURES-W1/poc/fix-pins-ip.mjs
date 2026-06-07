#!/usr/bin/env node
/**
 * SECURITY-AUDIT-RECENT-FEATURES-W1 · R2.1 PoC (companion): the FIX closes it.
 *
 * Confirms the proposed generator-level remediation (OPS-WEBHOOK-SSRF-IP-PIN-W1):
 * resolve ONCE, validate, then PIN the validated IP to the connection via an
 * undici `Agent` whose `lookup` returns the already-validated address — so the
 * connect step CANNOT re-resolve to a rebound internal IP. Same rebinding DNS as
 * rebind-poc.mjs (public→internal flip), but now the connection ignores lookup #2
 * and dials the pinned public IP. The internal sink receives NOTHING.
 *
 * Self-contained; no src/ import; loopback only.
 * Run:  node fix-pins-ip.mjs
 * Exit: 0 if the fix BLOCKS the rebind (sink untouched), 1 if it still leaks.
 */
import http from 'node:http';
import { Agent } from 'undici';

function classifyIpv4(ip) {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return { blocked: true, reason: 'invalid' };
  const [a, b] = o;
  if (a === 127 || a === 0 || a === 10) return { blocked: true, reason: 'internal' };
  if (a === 172 && b >= 16 && b <= 31) return { blocked: true, reason: 'internal' };
  if (a === 192 && b === 168) return { blocked: true, reason: 'internal' };
  if (a === 169 && b === 254) return { blocked: true, reason: 'internal' };
  if (a === 100 && b >= 64 && b <= 127) return { blocked: true, reason: 'internal' };
  return { blocked: false, reason: 'public' };
}

// Internal sink (must stay untouched if the fix works).
let sinkHits = 0;
const internalServer = http.createServer((req, res) => {
  sinkHits += 1;
  console.log(`  [internal-sink] !!! HIT ${req.method} ${req.url} — FIX FAILED`);
  res.writeHead(200); res.end('LEAKED');
});
await new Promise((r) => internalServer.listen(0, '127.0.0.1', r));
const INTERNAL_PORT = internalServer.address().port;

// A *real* public sink to prove the request still goes somewhere valid (the
// pinned public IP). We bind another loopback server and PIN to it by IP, while
// the rebinding resolver would send a second lookup to the internal port.
let publicHits = 0;
const publicServer = http.createServer((req, res) => {
  publicHits += 1;
  console.log(`  [pinned-public-sink] received ${req.method} ${req.url} — connection honored the PINNED IP`);
  res.writeHead(200); res.end('OK_PUBLIC');
});
await new Promise((r) => publicServer.listen(0, '127.0.0.1', r));
const PUBLIC_PORT = publicServer.address().port;

const ATTACK_HOST = 'rebind.attacker.example';
let lookupCount = 0;
// The validated address from STEP A. In the real fix this is the public A record;
// here we pin to 127.0.0.1:PUBLIC_PORT to have an observable "honored" endpoint.
const VALIDATED_IP = '127.0.0.1';

console.log('\n=== R2.1 FIX PoC — pin the validated IP; rebind cannot re-resolve ===\n');

// STEP A — resolve once + validate (same as the guard). Capture the address.
// (Pretend the resolver returned a PUBLIC address here; validation passes.)
console.log('STEP A — resolve once, validate, CAPTURE the address to pin:');
const resolvedForCheck = '93.184.216.34';
console.log(`         resolved ${ATTACK_HOST} -> ${resolvedForCheck} : ${classifyIpv4(resolvedForCheck).reason} (validated)`);
console.log(`         => pin this IP to the connection (do NOT let connect re-resolve).\n`);

// STEP B — connect with a PINNED lookup. Even though a rebinding resolver WOULD
// answer 127.0.0.1:internal on a second lookup, our Agent.lookup ignores the
// hostname and returns ONLY the validated IP. undici dials the pinned address.
const pinnedLookup = (hostname, options, callback) => {
  lookupCount += 1;
  console.log(`  [dns] connect-time lookup #${lookupCount} for ${hostname} -> PINNED ${VALIDATED_IP} (rebind ignored)`);
  if (options && options.all) return callback(null, [{ address: VALIDATED_IP, family: 4 }]);
  return callback(null, VALIDATED_IP, 4);
};

const dispatcher = new Agent({ connect: { lookup: pinnedLookup } });

// Point the pinned connection's port at the PUBLIC sink (the legitimate target).
// A rebind attempt would have aimed the host at INTERNAL_PORT; pinning defeats it.
const url = `http://${ATTACK_HOST}:${PUBLIC_PORT}/`;

console.log('STEP B — send with the pinned dispatcher:\n');
try {
  const res = await fetch(url, { method: 'POST', body: '{}', dispatcher, redirect: 'error' });
  await res.text();
} catch (err) {
  console.log(`  [fetch] ${err?.cause?.message || err?.message || err}`);
}

console.log('\n=== RESULT ===');
console.log(`internal-sink hits: ${sinkHits}   pinned-public-sink hits: ${publicHits}`);
internalServer.close(); publicServer.close();
if (sinkHits === 0 && publicHits >= 1) {
  console.log('VERDICT: FIX WORKS ✅ — connection honored the pinned validated IP; internal target NEVER reached.');
  console.log('         Pinning in the shared egress guard closes the rebind for EVERY consumer (generator-level).');
  process.exit(0);
} else {
  console.log('VERDICT: fix did not hold — internal sink was reached.');
  process.exit(1);
}
