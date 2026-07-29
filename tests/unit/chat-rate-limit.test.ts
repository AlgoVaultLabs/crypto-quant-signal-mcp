import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatQuotaApiKey } from '../../src/lib/chat-rate-limit.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

/**
 * OPS-AUDIT-REMEDIATION-HIGH-W1 · Ch1 · SEC-03 + SEC-07 wiring guards.
 *
 * The unit-level invariant lives in quota-key-integrity.test.ts. What is asserted here is the
 * WIRING — the two places the correct resolver has to actually be reached, both of which were
 * the real defect rather than the resolver itself:
 *
 *   SEC-03  /api/chat read the AsyncLocalStorage store, which is only entered for /mcp, so the
 *           license and ipHash were always empty on that route.
 *   SEC-07  Caddy forwarded {remote_host} — the Cloudflare edge — as X-Forwarded-For, so req.ip
 *           was a PoP address and every per-client bucket was really a per-PoP bucket.
 *
 * These are source-level assertions because the handler closures live inside src/index.ts, which
 * boots the server at import and therefore cannot be exercised directly from a unit test.
 */
describe('chat quota wiring (SEC-03)', () => {
  const idx = read('src/index.ts');

  it('/api/chat resolves the license from the REQUEST, not the empty ALS store', () => {
    const start = idx.indexOf("app.post('/api/chat'");
    expect(start).toBeGreaterThan(-1);
    // Bound the slice to the quota-key line — everything this test cares about sits between the
    // route registration and the chatQuotaApiKey call. A looser boundary swallows later routes.
    const body = idx.slice(start, idx.indexOf('chatQuotaApiKey', start));
    expect(body).toContain('resolveLicense(req.headers');
    expect(body).toContain('hashIp(clientIp(req)');
    // Assert against CODE only. The fix's own comment names the ALS readers it replaced, so a
    // raw substring check matches its own explanation and fails on a correct tree.
    const code = body.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    // The regression: on THIS route the ALS store is never entered, so these returned the env
    // fallback and undefined — which is what produced the shared `ip:unknown` bucket.
    expect(code).not.toContain('getRequestLicense()');
    expect(code).not.toContain('getRequestIpHash()');
  });

  it('the chat_knowledge MCP tool keeps its ALS reads (it DOES run inside requestContext.run)', () => {
    // Guards against an over-eager "fix" that strips the ALS reads from the path where they are
    // correct — /mcp enters the store, so there the readers are the right source.
    const tool = idx.slice(idx.indexOf("'chat_knowledge'"));
    const body = tool.slice(0, 2000);
    expect(body).toContain('getRequestLicense()');
  });
});

describe('client-IP wiring (SEC-07)', () => {
  const caddy = read('Caddyfile');
  const apiBlock = caddy.slice(caddy.indexOf('api.algovault.com'), caddy.indexOf('algovault.com {', caddy.indexOf('api.algovault.com') + 10));

  it('api. forwards the real client IP, not the Cloudflare edge', () => {
    expect(apiBlock).toContain('header_up X-Forwarded-For {http.request.header.CF-Connecting-IP}');
    expect(apiBlock).not.toContain('header_up X-Forwarded-For {remote_host}');
  });

  it('keeps trust proxy at the matching single hop', () => {
    expect(read('src/index.ts')).toContain("app.set('trust proxy', 1)");
  });
});

describe('the two wirings compose into per-caller metering', () => {
  it('a paid caller and two distinct anonymous callers occupy three separate buckets', () => {
    const paid = chatQuotaApiKey('av_live_deadbeefdeadbeefdeadbeef', 'hash_a');
    const anonA = chatQuotaApiKey(null, 'hash_a');
    const anonB = chatQuotaApiKey(null, 'hash_b');
    expect(new Set([paid, anonA, anonB]).size).toBe(3);
  });
});
