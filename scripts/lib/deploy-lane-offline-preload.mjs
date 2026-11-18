/**
 * OPS-DEPLOY-LANE-NETWORK-FREE-W1 — the deploy lane's network guard, Node half.
 *
 * WHY THIS EXISTS. "The deploy lane must be deterministic and network-free" was the law of this
 * repo's deploy.yml for months — written in check-external-origin-csp.mjs, in the lockfile and
 * served-surface steps, and in the plugin-manifest step — and it was PROSE. A gate added on
 * 2026-09-19 read the live MCP endpoint and npm from a PRE-deploy step with a 5 s budget sized for
 * a pre-commit hook. Measured over 2026-09-28..11-18: it blocked 15 deploy attempts, every one
 * PRIMITIVE_RESOLUTION_VERDICT=INDETERMINATE (a stalled connection or an overrun budget), never a
 * FAIL; 11 of the 12 re-runs that reached it passed the unchanged SHA. Each block left prod behind
 * main and paged DRIFT_INDETERMINATE until a human re-ran the deploy.
 *
 * WHAT IT DOES. Loaded through NODE_OPTIONS=--import by scripts/ci/deploy-lane-shell.sh, and ONLY
 * while deploy.yml's network-free gate window is open. Every TCP/TLS connection a process opens
 * passes through net.Socket.prototype.connect — net.connect, tls.connect, http(s), and the fetch
 * built into Node all land there — so that one method is the guard. A loopback or unix-socket
 * target passes. Anything else is REFUSED with EDEPLOYLANEOFFLINE (delivered asynchronously,
 * the way ECONNREFUSED is, so every client's own error path handles it) and RECORDED in the
 * ledger. The ledger is what the window's closing step judges, so a gate that swallows the error
 * and prints PASS anyway is still caught.
 *
 * WHY RECORD, NOT JUST REFUSE. A gate written to fail open on transport would turn a refusal into
 * a quiet fallback and a green step. Detection must not depend on the code it is detecting.
 *
 * IT NEVER THROWS AT LOAD. A preload that throws kills every node process in the window — the
 * guard would become the outage. Any failure to arm is recorded as GUARD_ERROR, which the judge
 * reads as INDETERMINATE (fail-closed, and deterministic: it fails on every run, never 6%).
 *
 * Ledger line format (tab-separated): KIND · via · target · script · pid
 *   LOADED  node  -            <script>  <pid>   one per node process: proof the guard was live
 *   ATTEMPT tcp   host:port    <script>  <pid>   a refused connection
 *   ATTEMPT dns   hostname     <script>  <pid>   a refused name lookup
 *   GUARD_ERROR …                                the guard could not arm
 */
import net from 'node:net';
import dns from 'node:dns';
import { appendFileSync } from 'node:fs';
import { relative } from 'node:path';

const LEDGER = process.env.DEPLOY_LANE_OFFLINE_LEDGER || '';

/** Who is asking — the script path relative to the workspace, or the inline command. */
const WHO = (() => {
  try {
    const a1 = process.argv[1];
    if (a1) return relative(process.cwd(), a1) || a1;
    return `node ${process.execArgv.join(' ')}`.slice(0, 120);
  } catch {
    return 'node';
  }
})();

function record(kind, via, target) {
  const line = `${kind}\t${via}\t${String(target).replace(/[\t\n]/g, ' ')}\t${WHO}\t${process.pid}\n`;
  if (LEDGER) {
    try { appendFileSync(LEDGER, line); } catch { /* an unwritable ledger reads as zero LOADED: INDETERMINATE */ }
  }
  if (kind !== 'LOADED') {
    try { process.stderr.write(`DEPLOY_LANE_NETWORK_${kind === 'ATTEMPT' ? 'ATTEMPT' : 'GUARD_ERROR'} via=${via} target=${target} script=${WHO}\n`); } catch { /* best effort */ }
  }
}

/** Loopback, the unspecified address (which connects locally), or a local name. Pure. */
export function isLocalHost(host) {
  if (host === undefined || host === null || host === '') return true; // net.connect's default is localhost
  const h = String(host).trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (net.isIPv4(h)) return h.startsWith('127.') || h === '0.0.0.0';
  if (net.isIPv6(h)) return h === '::1' || h === '::' || /^(0:){7}1$/.test(h) || /^::ffff:127\./.test(h);
  return false;
}

/**
 * Where a Socket#connect call is going. Pure. Covers every calling shape net.js produces:
 * net.connect() hands over a pre-normalized [options, cb] array; direct callers pass
 * (options), (path), or (port[, host]).
 */
export function connectTarget(args) {
  let a0 = args[0];
  if (Array.isArray(a0)) a0 = a0[0];
  if (a0 && typeof a0 === 'object') {
    if (a0.path) return { local: true, target: `unix:${a0.path}` };
    return { local: isLocalHost(a0.host), target: `${a0.host ?? 'localhost'}:${a0.port ?? ''}` };
  }
  if (typeof a0 === 'string' && !/^\d+$/.test(a0)) return { local: true, target: `unix:${a0}` };
  const host = typeof args[1] === 'string' ? args[1] : 'localhost';
  return { local: isLocalHost(host), target: `${host}:${a0 ?? ''}` };
}

function refusal(target) {
  const err = new Error(`deploy lane is network-free: refused ${target} (${WHO}). A live read belongs post-deploy or on a host cron — see scripts/check-deploy-lane-offline.mjs`);
  err.code = 'EDEPLOYLANEOFFLINE';
  return err;
}

try {
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const { local, target } = connectTarget(args);
    if (local) return realConnect.apply(this, args);
    record('ATTEMPT', 'tcp', target);
    const err = refusal(target);
    process.nextTick(() => this.destroy(err));
    return this;
  };

  const realLookup = dns.lookup;
  dns.lookup = function guardedLookup(hostname, ...rest) {
    if (isLocalHost(hostname)) return realLookup.call(this, hostname, ...rest);
    record('ATTEMPT', 'dns', hostname);
    const cb = rest.find((x) => typeof x === 'function');
    if (cb) process.nextTick(cb, refusal(hostname));
    return {};
  };

  const realPromiseLookup = dns.promises.lookup;
  dns.promises.lookup = function guardedPromiseLookup(hostname, ...rest) {
    if (isLocalHost(hostname)) return realPromiseLookup.call(this, hostname, ...rest);
    record('ATTEMPT', 'dns', hostname);
    return Promise.reject(refusal(hostname));
  };

  record('LOADED', 'node', '-');
} catch (e) {
  record('GUARD_ERROR', 'node', e instanceof Error ? e.message : String(e));
}
