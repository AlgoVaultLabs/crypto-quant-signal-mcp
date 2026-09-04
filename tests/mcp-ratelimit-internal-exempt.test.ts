/**
 * OPS-BOT-DISPATCH-LATENCY-W1 CH4 — the /mcp per-IP limiter exempts the INTERNAL caller,
 * and nobody else.
 *
 * WHY THE EXEMPTION EXISTS. The Telegram bot's dispatch is being collapsed onto one tick so
 * every watch row fires at bar close. The whole watchlist is ~104 rows ≈ 115 tool calls plus
 * handshakes inside a single minute, against `max: 120` — and the overflow arrives as a
 * SILENTLY DROPPED ALERT, not a retry. Measured peak before the collapse was 31 tool-calls/min
 * with 0 × HTTP 429 in 14 days, so this is headroom for a change we are making rather than a
 * fix for an incident.
 *
 * WHY IT IS ONLY SAFE NOW. The bot used to reach the MCP over the PUBLIC url, so its requests
 * arrived through Cloudflare and the Caddyfile rewrote X-Forwarded-For to CF-Connecting-IP —
 * which Cloudflare delivers already MASKED to a /24 (v4) or /48 (v6). `req.ip` was a shared
 * Hetzner prefix, so an address-keyed exemption would have exempted an entire /48. CH1b
 * repointed the bot to loopback, and the predicate keys on a SHARED SECRET rather than on an
 * address anyway, so neither half depends on the network shape.
 *
 * THE TEST IS TWO-WAY BY CONSTRUCTION. An exemption test that only proves the internal caller
 * is exempt would pass just as happily against `skip: () => true`, which is an open door. Every
 * exemption assertion here is paired with a refusal assertion on the same server.
 *
 * ONE DERIVATION: `index.ts` boots the server at import, so its limiter options cannot be
 * imported. The skip therefore lives in `isInternalRateLimitExempt` and BOTH sides call it —
 * re-declaring the lambda here would let the test pass against its own copy while production
 * drifted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const ORIGINAL = {
  BOT_INTERNAL_BYPASS_ENABLED: process.env.BOT_INTERNAL_BYPASS_ENABLED,
  ALGOVAULT_INTERNAL_BYPASS_KEY: process.env.ALGOVAULT_INTERNAL_BYPASS_KEY,
};

const GOOD_KEY = 'internal-bypass-key-long-enough-to-pass';
const CAP = 3;

let server: http.Server;
let baseUrl: string;

/** Mount ONLY the limiter under test, with the production skip, at a small cap. */
async function mount(): Promise<void> {
  vi.resetModules();
  const express = (await import('express')).default;
  const { default: rateLimit } = await import('express-rate-limit');
  const { isInternalRateLimitExempt } = await import('../src/lib/license.js');

  const app = express();
  app.set('trust proxy', 1);
  app.use('/mcp', rateLimit({
    windowMs: 60_000,
    max: CAP,
    standardHeaders: true,
    legacyHeaders: false,
    // THE PRODUCTION PREDICATE, imported — not a copy.
    skip: (req: import('express').Request): boolean =>
      isInternalRateLimitExempt(req.headers as Record<string, string | undefined>),
  }));
  app.all('/mcp', (_req, res) => { res.status(200).json({ ok: true }); });

  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function hit(n: number, headers: Record<string, string> = {}): Promise<number[]> {
  const codes: number[] = [];
  for (let i = 0; i < n; i++) {
    const res = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers });
    codes.push(res.status);
  }
  return codes;
}

const internal = () => ({ 'X-AlgoVault-Internal-Key': GOOD_KEY });

beforeEach(async () => {
  process.env.BOT_INTERNAL_BYPASS_ENABLED = 'true';
  process.env.ALGOVAULT_INTERNAL_BYPASS_KEY = GOOD_KEY;
  await mount();
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const [k, v] of Object.entries(ORIGINAL)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe('/mcp per-IP limiter — internal exemption', () => {
  it('EXEMPTS the internal caller well past the cap', async () => {
    const codes = await hit(CAP * 4, internal());
    expect(codes.every((c) => c === 200)).toBe(true);
  });

  it('STILL LIMITS an ordinary caller — the other half of the same server', async () => {
    const codes = await hit(CAP + 2);
    expect(codes.slice(0, CAP).every((c) => c === 200)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });

  it('does not exempt a caller presenting the WRONG key', async () => {
    const codes = await hit(CAP + 2, { 'X-AlgoVault-Internal-Key': 'wrong-but-long-enough-key' });
    expect(codes.at(-1)).toBe(429);
  });

  it('does not exempt a caller presenting the key as a Bearer token', async () => {
    // The neighbouring per-key limiter reads `Authorization: Bearer`; this one must not, or the
    // two would silently share a spoofing surface.
    const codes = await hit(CAP + 2, { Authorization: `Bearer ${GOOD_KEY}` });
    expect(codes.at(-1)).toBe(429);
  });

  it('FAILS CLOSED when the bypass is disabled', async () => {
    process.env.BOT_INTERNAL_BYPASS_ENABLED = 'false';
    await new Promise<void>((r) => server.close(() => r()));
    await mount();
    const codes = await hit(CAP + 2, internal());
    expect(codes.at(-1)).toBe(429);
  });

  it('FAILS CLOSED when the configured key is too short to be a secret', async () => {
    process.env.ALGOVAULT_INTERNAL_BYPASS_KEY = 'short';
    await new Promise<void>((r) => server.close(() => r()));
    await mount();
    const codes = await hit(CAP + 2, { 'X-AlgoVault-Internal-Key': 'short' });
    expect(codes.at(-1)).toBe(429);
  });

  it('FAILS CLOSED when no key is configured at all', async () => {
    delete process.env.ALGOVAULT_INTERNAL_BYPASS_KEY;
    await new Promise<void>((r) => server.close(() => r()));
    await mount();
    const codes = await hit(CAP + 2, internal());
    expect(codes.at(-1)).toBe(429);
  });
});

describe('isInternalRateLimitExempt — the predicate itself', () => {
  it('is true only for the exact configured key', async () => {
    const { isInternalRateLimitExempt } = await import('../src/lib/license.js');
    expect(isInternalRateLimitExempt({ 'x-algovault-internal-key': GOOD_KEY })).toBe(true);
    expect(isInternalRateLimitExempt({ 'x-algovault-internal-key': `${GOOD_KEY}x` })).toBe(false);
    expect(isInternalRateLimitExempt({})).toBe(false);
    expect(isInternalRateLimitExempt({ authorization: `Bearer ${GOOD_KEY}` })).toBe(false);
  });
});
