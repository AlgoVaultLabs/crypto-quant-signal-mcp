/**
 * OPS-MCP-DEFENSE-IN-DEPTH-W1 R2 — `clientIp(req)` single-derivation IP source.
 *
 * The free-tier quota ipHash and the signup-attribution ipHash previously parsed
 * raw `x-forwarded-for` manually (leftmost entry) — safe ONLY because Caddy
 * REPLACES the header (`header_up X-Forwarded-For {remote_host}`). `clientIp(req)`
 * derives from Express's `req.ip`, which `app.set('trust proxy', 1)` (already set
 * in index.ts) resolves from the trusted hop — robust to a proxy reconfig.
 *
 * Regression contract (prompt R2): for a standard single-value XFF request the
 * helper-derived value (and hence its hash) is BYTE-IDENTICAL to the prior raw-XFF
 * leftmost parse — no quota-bucket reset, no analytics discontinuity. Under a
 * multi-hop (spoofable) XFF the two deliberately diverge: the helper resolves the
 * trusted-hop value, the old parse took the attacker-controlled leftmost.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';

// OPS-SEC-IPHASH-SALT-W1: hashIp is now HMAC-keyed and throws without a key (no unkeyed fallback,
// by design). This suite's contract — two EQUAL ips produce two EQUAL hashes — is unchanged; it
// just needs a key to compute one. Set before the module under test is imported.
vi.hoisted(() => {
  process.env.ALGOVAULT_IP_HASH_KEY ??= 'test-only-ip-hash-key-0123456789abcdef';
});

import { clientIp } from '../src/lib/client-ip.js';
import { hashIp } from '../src/lib/analytics.js';

/** The PRIOR derivation (index.ts:2293 quota site) — kept verbatim as the regression oracle. */
function legacyQuotaIp(headers: Record<string, string | undefined>, socketRemote?: string): string {
  return (headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
    || (headers['x-real-ip'] as string)
    || socketRemote
    || 'unknown';
}

let server: Server;
let baseUrl: string;
let captured: { newIp: string; rawXff?: string; socketRemote?: string };

beforeAll(async () => {
  const app = express();
  app.set('trust proxy', 1); // mirrors index.ts:1014
  app.get('/probe', (req, res) => {
    captured = {
      newIp: clientIp(req),
      rawXff: req.headers['x-forwarded-for'] as string | undefined,
      socketRemote: req.socket.remoteAddress ?? undefined,
    };
    res.json({ ok: true });
  });
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
});

describe('clientIp — unit', () => {
  it('returns req.ip when present', () => {
    expect(clientIp({ ip: '203.0.113.7' })).toBe('203.0.113.7');
  });

  it("returns '' when req.ip is absent; quota-site composition maps it to 'unknown'", () => {
    expect(clientIp({ ip: undefined })).toBe('');
    expect(clientIp({ ip: undefined }) || 'unknown').toBe('unknown');
  });
});

describe('clientIp — byte-identical to the prior raw-XFF parse under the deployed topology', () => {
  it('single-value XFF (Caddy replace-mode): helper === legacy leftmost parse; hashes identical', async () => {
    await fetch(`${baseUrl}/probe`, { headers: { 'x-forwarded-for': '203.0.113.7' } });
    const legacy = legacyQuotaIp({ 'x-forwarded-for': captured.rawXff }, captured.socketRemote);
    expect(captured.newIp).toBe('203.0.113.7');
    expect(captured.newIp).toBe(legacy);                 // byte-identical IP …
    expect(hashIp(captured.newIp)).toBe(hashIp(legacy)); // … hence byte-identical quota/analytics hash
  });

  it('multi-hop spoofed XFF: legacy leftmost = attacker value; helper = trusted-hop value (the hardening)', async () => {
    await fetch(`${baseUrl}/probe`, { headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.7' } });
    const legacy = legacyQuotaIp({ 'x-forwarded-for': captured.rawXff }, captured.socketRemote);
    expect(legacy).toBe('6.6.6.6');           // old parse: attacker-controlled (mintable quota buckets)
    expect(captured.newIp).toBe('203.0.113.7'); // req.ip under trust proxy=1: nearest-trusted-hop value
    expect(captured.newIp).not.toBe(legacy);
  });

  it('no XFF at all: helper falls back to the socket peer (never empty on a real connection)', async () => {
    await fetch(`${baseUrl}/probe`);
    expect(captured.newIp).not.toBe('');
    expect(captured.newIp).toContain('127.0.0.1');
  });
});
