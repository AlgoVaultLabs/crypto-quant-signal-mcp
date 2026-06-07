/**
 * WEBHOOK-HARDENING-W1 (2026-05-29): SSRF egress guard.
 *
 * Reusable allowlist for ALL outbound HTTP to user-supplied URLs (webhook
 * delivery today; P0-3 adapters / any future fetch-to-user-URL tomorrow).
 * Retires the "unchecked egress" bug class.
 *
 * Two entry points:
 *   - assertEgressAllowed(url)        — SYNC: scheme + embedded-creds + literal-IP
 *                                        class checks. Used at REGISTRATION (a
 *                                        hostname can't be resolved yet — the
 *                                        async guard below catches it at delivery).
 *   - resolveAndAssertEgress(url,opts) — ASYNC: runs the sync checks, then
 *                                        dns.lookup(host, {all:true}) and runs
 *                                        EVERY resolved A/AAAA through the same
 *                                        IP-class block (DNS-rebind defense).
 *
 * Prod policy: https-only; block loopback / link-local / private / ULA / CGNAT /
 * unspecified literal + resolved IPs; reject `user:pass@host` creds. The
 * `WEBHOOK_SSRF_ALLOW_LOOPBACK=1` test seam (default off) permits loopback
 * (127/8, ::1, `localhost`) + `http` FOR LOOPBACK ONLY, so the W1 local-sink
 * tests run; nothing else is relaxed.
 *
 * MUST NOT: send HTTP, contain business logic. Pure validation.
 */
import net from 'node:net';
import dns from 'node:dns';

export type EgressBlockCode =
  | 'invalid_url'
  | 'embedded_credentials'
  | 'insecure_scheme'
  | 'disallowed_scheme'
  | 'blocked_ip';

export class EgressBlockedError extends Error {
  readonly code: EgressBlockCode;
  readonly reason: string;
  constructor(code: EgressBlockCode, reason: string) {
    super(`egress blocked (${code}): ${reason}`);
    this.code = code;
    this.reason = reason;
    Object.setPrototypeOf(this, EgressBlockedError.prototype);
  }
}

export interface IpClass {
  blocked: boolean;
  isLoopback: boolean;
  reason: string;
}

function loopbackSeamOn(): boolean {
  return process.env.WEBHOOK_SSRF_ALLOW_LOOPBACK === '1';
}

/** Classify an IPv4 literal against the SSRF block ranges. */
export function classifyIpv4(ip: string): IpClass {
  const parts = ip.split('.');
  if (parts.length !== 4) return { blocked: true, isLoopback: false, reason: 'invalid_ipv4' };
  const o = parts.map((p) => Number(p));
  if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return { blocked: true, isLoopback: false, reason: 'invalid_ipv4' };
  }
  const [a, b] = o;
  if (a === 127) return { blocked: true, isLoopback: true, reason: 'loopback 127.0.0.0/8' };
  if (a === 0) return { blocked: true, isLoopback: false, reason: 'unspecified/this-network 0.0.0.0/8' };
  if (a === 10) return { blocked: true, isLoopback: false, reason: 'private 10.0.0.0/8' };
  if (a === 172 && b >= 16 && b <= 31) return { blocked: true, isLoopback: false, reason: 'private 172.16.0.0/12' };
  if (a === 192 && b === 168) return { blocked: true, isLoopback: false, reason: 'private 192.168.0.0/16' };
  if (a === 169 && b === 254) return { blocked: true, isLoopback: false, reason: 'link-local 169.254.0.0/16' };
  if (a === 100 && b >= 64 && b <= 127) return { blocked: true, isLoopback: false, reason: 'CGNAT 100.64.0.0/10' };
  return { blocked: false, isLoopback: false, reason: 'public' };
}

/**
 * Expand an IPv6 string to its 8 hextet integers (0..0xffff each). Handles `::`
 * compression and a trailing dotted-quad (IPv4-mapped/compatible/NAT64 textual
 * form, e.g. `::ffff:10.0.0.1`). Returns null if it is not a well-formed IPv6.
 * `net.isIP` has already validated the literal before we get here, so this is a
 * structural expansion, not a full validator.
 */
function ipv6Hextets(s: string): number[] | null {
  let str = s;

  // A trailing dotted-quad (last 32 bits as a.b.c.d) → fold into two hextets.
  const dotted = str.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const o = dotted.slice(1).map((n) => Number(n));
    if (o.some((n) => n < 0 || n > 255)) return null;
    const hi = (o[0] << 8) | o[1];
    const lo = (o[2] << 8) | o[3];
    str = str.slice(0, dotted.index) + hi.toString(16) + ':' + lo.toString(16);
  }

  const halves = str.split('::');
  if (halves.length > 2) return null; // more than one '::' is invalid
  const parse = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (g === '' || g.length > 4 || !/^[0-9a-f]+$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  if (halves.length === 2) {
    const head = parse(halves[0]);
    const tail = parse(halves[1]);
    if (head === null || tail === null) return null;
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    return [...head, ...new Array(fill).fill(0), ...tail];
  }
  const flat = parse(str);
  if (flat === null || flat.length !== 8) return null;
  return flat;
}

/**
 * Classify an IPv6 literal against the SSRF block ranges.
 *
 * Embedded-IPv4 forms (the WH-02/WH-05 bypass class) are decoded from the PARSED
 * address — NOT a textual regex — and the embedded IPv4 is run through
 * classifyIpv4. This catches the hex IPv4-mapped form (`::ffff:7f00:1`) that the
 * old dotted-only regex missed (WHATWG URL normalizes dotted → hex), the
 * deprecated IPv4-compatible form (`::a.b.c.d`), and NAT64 (`64:ff9b::/96`).
 */
export function classifyIpv6(ip: string): IpClass {
  const s = ip.toLowerCase().split('%')[0]; // strip zone id

  if (s === '::1') return { blocked: true, isLoopback: true, reason: 'loopback ::1' };
  if (s === '::') return { blocked: true, isLoopback: false, reason: 'unspecified ::' };

  const h = ipv6Hextets(s);
  if (h) {
    const embeddedV4 = (): string => {
      const hi = h[6], lo = h[7];
      return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
    };
    // IPv4-mapped ::ffff:0:0/96  → first 5 hextets 0, hextet[5] === 0xffff.
    if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) {
      const v4 = classifyIpv4(embeddedV4());
      return { ...v4, reason: `IPv4-mapped ::ffff:${embeddedV4()} → ${v4.reason}` };
    }
    // NAT64 64:ff9b::/96 → hextet[0]===0x0064, hextet[1]===0xff9b, hextets 2..5 === 0.
    if (h[0] === 0x0064 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) {
      const v4 = classifyIpv4(embeddedV4());
      return { ...v4, reason: `NAT64 64:ff9b::${embeddedV4()} → ${v4.reason}` };
    }
    // IPv4-compatible ::a.b.c.d (deprecated) → first 6 hextets 0, low 32 bits != 0
    // and not ::1/:: (handled above). Treat the embedded v4 as the target.
    if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0 && (h[6] !== 0 || h[7] !== 0)) {
      const v4 = classifyIpv4(embeddedV4());
      return { ...v4, reason: `IPv4-compatible ::${embeddedV4()} → ${v4.reason}` };
    }
  }

  const head = s.split(':')[0];
  if (/^fe[89ab]/.test(head)) return { blocked: true, isLoopback: false, reason: 'link-local fe80::/10' };
  if (/^f[cd]/.test(head)) return { blocked: true, isLoopback: false, reason: 'ULA fc00::/7' };
  return { blocked: false, isLoopback: false, reason: 'public' };
}

/** Classify any IP literal; returns null if `value` is not an IP (i.e. a hostname). */
export function classifyIp(value: string): IpClass | null {
  const v = net.isIP(value);
  if (v === 4) return classifyIpv4(value);
  if (v === 6) return classifyIpv6(value);
  return null;
}

function isLoopbackHostname(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost');
}

/** WHATWG URL.hostname wraps IPv6 literals in brackets ([::1]); strip for net.isIP. */
function unbracket(host: string): string {
  return host.replace(/^\[(.+)\]$/, '$1');
}

/** Throw if a classified IP is disallowed (honoring the loopback seam). */
function assertIpAllowed(ipClass: IpClass, context: string): void {
  if (!ipClass.blocked) return;
  if (ipClass.isLoopback && loopbackSeamOn()) return; // test seam
  throw new EgressBlockedError('blocked_ip', `${context}: ${ipClass.reason}`);
}

/**
 * SYNC guard: scheme + embedded-creds + literal-IP class. Throws
 * EgressBlockedError on any violation. Hostnames pass here (resolved at
 * delivery by resolveAndAssertEgress).
 */
export function assertEgressAllowed(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new EgressBlockedError('invalid_url', 'not a valid URL');
  }

  if (url.username || url.password) {
    throw new EgressBlockedError('embedded_credentials', 'userinfo (user:pass@) not allowed');
  }

  const host = unbracket(url.hostname);
  const ipClass = classifyIp(host);
  const loopbackHost = (ipClass?.isLoopback ?? false) || isLoopbackHostname(host);

  // Scheme: https only; http permitted ONLY for loopback under the test seam.
  if (url.protocol === 'http:') {
    if (!(loopbackSeamOn() && loopbackHost)) {
      throw new EgressBlockedError('insecure_scheme', 'http not allowed (https required)');
    }
  } else if (url.protocol !== 'https:') {
    throw new EgressBlockedError('disallowed_scheme', `scheme ${url.protocol} not allowed`);
  }

  // Literal IP host → class-check now.
  if (ipClass) assertIpAllowed(ipClass, `literal host ${host}`);

  return url;
}

export interface ResolveEgressOpts {
  /** Injectable resolver (default dns.promises.lookup) — for hermetic tests + rebind tests. */
  lookup?: (host: string, opts: { all: true }) => Promise<{ address: string; family: number }[]>;
}

/** The validated egress address the caller MUST pin to the connection (WH-01). */
export interface PinnedAddress {
  address: string;
  family: number;
}

/**
 * ASYNC guard: sync checks + resolve the host and run EVERY A/AAAA through the
 * IP-class block (DNS-rebind defense), then RETURN the validated address to PIN
 * to the connection.
 *
 * WH-01 (OPS-WEBHOOK-SSRF-IP-PIN-W1): returning the validated IP is the
 * generator-level fix for the resolve→connect TOCTOU. The caller MUST dial THIS
 * address (e.g. via an undici Agent whose connect.lookup returns only this
 * address) so undici cannot re-resolve the hostname at connect time and rebind to
 * an internal target. For a literal-IP host the literal itself is returned; for a
 * hostname the FIRST validated resolved address is returned (every resolved
 * address has already passed the block-class check, so any is safe — we pin the
 * first deterministically).
 */
export async function resolveAndAssertEgress(rawUrl: string, opts: ResolveEgressOpts = {}): Promise<PinnedAddress> {
  const url = assertEgressAllowed(rawUrl); // scheme/creds/literal-IP
  const host = unbracket(url.hostname);

  // Literal IP already validated by assertEgressAllowed — no DNS needed. Pin the
  // literal itself (family from net.isIP).
  if (classifyIp(host)) {
    return { address: host, family: net.isIP(host) };
  }

  const lookup = opts.lookup ?? ((h, o) => dns.promises.lookup(h, o));
  let addrs: { address: string; family: number }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    // NXDOMAIN / resolver failure → fail closed (can't prove it's safe).
    throw new EgressBlockedError('blocked_ip', `host ${host} did not resolve`);
  }
  if (!addrs || addrs.length === 0) {
    throw new EgressBlockedError('blocked_ip', `host ${host} resolved to no addresses`);
  }
  for (const a of addrs) {
    const ipClass = classifyIp(a.address);
    if (ipClass) assertIpAllowed(ipClass, `host ${host} resolves to ${a.address}`);
  }
  // All resolved addresses passed the block-class check → pin the first.
  const pinned = addrs[0];
  return { address: pinned.address, family: pinned.family };
}
