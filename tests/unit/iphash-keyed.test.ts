import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hashIp, resolveIpHashKey, assertIpHashKeyConfigured, stripIpHashVersion,
  IP_HASH_VERSION, IpHashKeyError,
} from '../../src/lib/analytics.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'a'.repeat(64);
const KEY2 = 'b'.repeat(64);

/**
 * OPS-SEC-IPHASH-SALT-W1.
 *
 * `hashIp` was `sha256(ip)[0:16]` — unkeyed. The input space is ~2^32 for a full IPv4 and only
 * ~2^24 for the /24-masked value actually hashed, so a stored `ip_hash` was reversible by brute
 * force in seconds and the analytics/quota tables were effectively an address store.
 *
 * The regression that matters most is NOT "is it HMAC" — it is "can any path still emit an unkeyed
 * value". A silent fallback would write v1-shaped values under a v2 label, which is worse than the
 * original bug because the label would assert a protection that does not exist. These tests pin
 * that property, not the algorithm.
 */
describe('hashIp is keyed — and cannot silently fall back (OPS-SEC-IPHASH-SALT-W1)', () => {
  it('throws rather than returning an unkeyed hash when the key is absent', () => {
    expect(() => resolveIpHashKey({})).toThrow(IpHashKeyError);
    expect(() => resolveIpHashKey({ ALGOVAULT_IP_HASH_KEY: '' })).toThrow(IpHashKeyError);
    expect(() => resolveIpHashKey({ ALGOVAULT_IP_HASH_KEY: '   ' })).toThrow(IpHashKeyError);
  });

  it('rejects placeholder keys — a "working" placeholder is worse than no key', () => {
    for (const bad of ['changeme', 'CHANGEME', 'placeholder', 'todo', 'secret', 'test', 'dev']) {
      expect(() => resolveIpHashKey({ ALGOVAULT_IP_HASH_KEY: bad })).toThrow(IpHashKeyError);
    }
  });

  it('rejects a key too short to be a real secret', () => {
    expect(() => resolveIpHashKey({ ALGOVAULT_IP_HASH_KEY: 'abc123' })).toThrow(/only 6 chars/);
    expect(resolveIpHashKey({ ALGOVAULT_IP_HASH_KEY: KEY })).toBe(KEY);
  });

  it('emits a version-tagged 16-hex pseudonym', () => {
    process.env.ALGOVAULT_IP_HASH_KEY = KEY;
    const out = hashIp('161.142.148.0');
    expect(out.startsWith(`${IP_HASH_VERSION}:`)).toBe(true);
    expect(stripIpHashVersion(out)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is NOT the old unsalted value — the whole point', () => {
    process.env.ALGOVAULT_IP_HASH_KEY = KEY;
    // Recorded live in OPS-SEC-CLIENT-IP-VERIFY-W1: sha256("161.142.148.0")[0:16].
    const V1_FOR_SAME_INPUT = '5522bd38c4669b52';
    const out = hashIp('161.142.148.0');
    expect(out).not.toBe(V1_FOR_SAME_INPUT);
    expect(stripIpHashVersion(out)).not.toBe(V1_FOR_SAME_INPUT);
  });

  it('is deterministic per key, and a different key gives a different pseudonym', () => {
    process.env.ALGOVAULT_IP_HASH_KEY = KEY;
    const a1 = hashIp('203.0.113.7');
    const a2 = hashIp('203.0.113.7');
    process.env.ALGOVAULT_IP_HASH_KEY = KEY2;
    const b1 = hashIp('203.0.113.7');
    process.env.ALGOVAULT_IP_HASH_KEY = KEY;
    expect(a1).toBe(a2);            // same key, same input → one bucket
    expect(b1).not.toBe(a1);        // rotating the key re-namespaces (that is the point)
  });

  it('distinct inputs land in distinct buckets (the metering property)', () => {
    process.env.ALGOVAULT_IP_HASH_KEY = KEY;
    expect(hashIp('161.142.148.0')).not.toBe(hashIp('204.168.185.0'));
  });
});

describe('boot guard is scoped to the transport that stores pseudonyms', () => {
  it('assert throws when unset — so an HTTP deploy that beat the key dies loudly', () => {
    expect(() => assertIpHashKeyConfigured({})).toThrow(IpHashKeyError);
  });

  it('assert passes with a real key', () => {
    expect(() => assertIpHashKeyConfigured({ ALGOVAULT_IP_HASH_KEY: KEY })).not.toThrow();
  });

  it('the guard runs on the HTTP branch ONLY — stdio/npx must still boot keyless', () => {
    // Every hashIp call site takes an Express `req`, so stdio can never reach it. Requiring a key
    // there would break every published `npx crypto-quant-signal-mcp` install.
    const idx = readFileSync(resolve(ROOT, 'src/index.ts'), 'utf8');
    const dispatch = idx.slice(idx.indexOf("const transport = (process.env.TRANSPORT"));
    const stdioBranch = dispatch.slice(dispatch.indexOf("if (transport === 'stdio')"), dispatch.indexOf('} else {'));
    const httpBranch = dispatch.slice(dispatch.indexOf('} else {'), dispatch.indexOf('} else {') + 1200);
    const code = (s: string) => s.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    expect(code(httpBranch)).toContain('assertIpHashKeyConfigured()');
    expect(code(stdioBranch)).not.toContain('assertIpHashKeyConfigured');
  });
});

describe('version tag survives the consumers that key on it', () => {
  it('the PQL join still lines up across tables', () => {
    process.env.ALGOVAULT_IP_HASH_KEY = KEY;
    const stored = hashIp('161.142.148.0');      // request_log.ip_hash
    const trackerKey = `free:${stored}`;          // quota_usage.tracker_key
    // The view does SUBSTR(tracker_key, 6) — 1-indexed, so it drops exactly 'free:'.
    expect(trackerKey.slice(5)).toBe(stored);
  });

  it('stripIpHashVersion is display-only and tolerates untagged v1 values', () => {
    expect(stripIpHashVersion('v2:abcdef0123456789')).toBe('abcdef0123456789');
    expect(stripIpHashVersion('5522bd38c4669b52')).toBe('5522bd38c4669b52'); // historical v1 row
    expect(stripIpHashVersion(null)).toBe('');
  });

  it('the admin PQL candidate_ref keeps 8 MEANINGFUL chars, not "v2:" + 5', () => {
    const pql = readFileSync(resolve(ROOT, 'src/lib/pql.ts'), 'utf8');
    const code = pql.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    expect(code).toContain('stripIpHashVersion(r.ip_hash).slice(0, 8)');
  });
});
