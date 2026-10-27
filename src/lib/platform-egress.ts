/**
 * GROWTH-AGENT-SIGNIN-OAUTH-W1 CH1 — the ONE declaration of a platform's published egress.
 *
 * Anthropic publishes the range its hosted MCP connector (Claude apps) calls out from:
 * `160.79.104.0/21`, IPv4 only — the docs list no IPv6 range (endpoint-truth F1). Every consumer
 * projects from `ANTHROPIC_EGRESS_CIDRS`: `stepup-readout.py` builds its pool set A from
 * `anthropicEgressNetworks()` in-container, and the CH3 challenge asks `isAnthropicEgressIp` /
 * `isAnthropicEgressHash`. Before this module the readout carried its own `160.79.104..111` loop.
 *
 * The edge hands us IPv4 callers /24-masked (Cloudflare masks CF-Connecting-IP upstream, see
 * `analytics.ts`), so a request_log `ip_hash` is `hashIp(<a.b.c.0>)`: set A is the hashes of the
 * /24 network addresses inside each declared range.
 */
import net from 'node:net';
import { hashIp } from './analytics.js';

export const ANTHROPIC_EGRESS_CIDRS: readonly string[] = ['160.79.104.0/21'];

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => acc * 256 + Number(o), 0);
}

function intToV4(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function parseCidr(cidr: string): { base: number; bits: number } {
  const [addr, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  const size = 2 ** (32 - bits);
  return { base: Math.floor(v4ToInt(addr) / size) * size, bits };
}

/** The IPv4 inside an IPv4 or IPv4-mapped IPv6 string, else null. Pure IPv6 is never in the range. */
function asV4(ip: string): string | null {
  const v = ip.trim().replace(/^::ffff:/i, '');
  return net.isIPv4(v) ? v : null;
}

/** True iff `ip` is an IPv4 address inside a declared Anthropic egress range. IPv6 → false. */
export function isAnthropicEgressIp(ip: string | null | undefined): boolean {
  if (!ip) return false;
  const v4 = asV4(ip);
  if (!v4) return false;
  const n = v4ToInt(v4);
  return ANTHROPIC_EGRESS_CIDRS.some((c) => {
    const { base, bits } = parseCidr(c);
    return n >= base && n < base + 2 ** (32 - bits);
  });
}

/** The /24 network addresses (`a.b.c.0`) the declared ranges cover — the form the edge delivers. */
export function anthropicEgressNetworks(): string[] {
  const out: string[] = [];
  for (const c of ANTHROPIC_EGRESS_CIDRS) {
    const { base, bits } = parseCidr(c);
    const span = bits >= 24 ? 1 : 2 ** (24 - bits);
    for (let i = 0; i < span; i++) out.push(intToV4(base + i * 256));
  }
  return out;
}

/**
 * True iff `hash` (a stored `ip_hash` / anonymous `session_id`) is one of set A. Refuses, never
 * throws: without a usable ip-hash key nothing can be matched, so the answer is false — the
 * caller's undecided path, which is today's behaviour.
 */
export function isAnthropicEgressHash(hash: string | null | undefined): boolean {
  if (!hash) return false;
  try {
    return anthropicEgressNetworks().some((n) => hashIp(n) === hash);
  } catch {
    return false;
  }
}
