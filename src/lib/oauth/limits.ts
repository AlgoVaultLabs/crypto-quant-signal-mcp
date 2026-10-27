/**
 * GROWTH-AGENT-SIGNIN-OAUTH-W1 CH2 — OAuth rate limits (R2.14), never keyed on a shared egress.
 *
 * Every Claude user's token and register calls arrive from Anthropic's egress range, so a per-IP
 * key there would let one busy minute lock out all of them (I-2). Those calls are keyed on what is
 * theirs instead — the refresh family, the client + IP — and the egress IP itself is exempt from
 * every per-IP key. Browser routes (`/authorize`, `/oauth/*`) are keyed per browser IP.
 *
 * In-process fixed windows: one container serves `/mcp`, and the SDK's own limiter is disabled
 * (`rateLimit: false`) because its key is the IP. A 429 is OAuth JSON, never the app's HTML.
 */
import type { NextFunction, Request, Response } from 'express';
import { clientIp } from '../client-ip.js';
import { isAnthropicEgressIp } from '../platform-egress.js';
import { getToken, sha256Hex } from './store.js';

interface FixedWindow {
  start: number;
  count: number;
}

const windows = new Map<string, FixedWindow>();
const MAX_KEYS = 50_000;
const HOUR = 60 * 60 * 1000;
const TEN_MIN = 10 * 60 * 1000;

/** One hit on `key`; false once the window's `max` is spent. */
export function hit(key: string, max: number, windowMs: number, now: number = Date.now()): boolean {
  let w = windows.get(key);
  if (!w || now - w.start >= windowMs) {
    if (windows.size >= MAX_KEYS) {
      for (const [k, v] of windows) if (now - v.start >= HOUR) windows.delete(k);
      if (windows.size >= MAX_KEYS) windows.clear();
    }
    w = { start: now, count: 0 };
    windows.set(key, w);
  }
  w.count += 1;
  return w.count <= max;
}

/** Test seam. */
export function _resetOAuthLimitsForTest(): void {
  windows.clear();
}

export const OAUTH_LIMITS = {
  browser: { max: 60, windowMs: TEN_MIN },
  register: { max: 20, windowMs: HOUR },
  tokenCode: { max: 30, windowMs: TEN_MIN },
  tokenRefresh: { max: 30, windowMs: TEN_MIN },
  revoke: { max: 60, windowMs: TEN_MIN },
} as const;

function tooMany(res: Response, windowMs: number): void {
  res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)));
  res.setHeader('Cache-Control', 'no-store');
  res.status(429).json({ error: 'too_many_requests', error_description: 'Too many requests. Try again later.' });
}

type Limit = { max: number; windowMs: number };

/** Per browser IP — `/authorize` and every `/oauth/*` page. */
export function browserLimiter(bucket: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const { max, windowMs } = OAUTH_LIMITS.browser;
    if (!hit(`${bucket}|ip|${clientIp(req)}`, max, windowMs)) return tooMany(res, windowMs);
    next();
  };
}

/** Per IP with the Anthropic egress exempt — `/register` and `/revoke`. */
export function perIpExemptLimiter(bucket: 'register' | 'revoke') {
  const { max, windowMs }: Limit = OAUTH_LIMITS[bucket];
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = clientIp(req);
    if (isAnthropicEgressIp(ip)) return next();
    if (!hit(`${bucket}|ip|${ip}`, max, windowMs)) return tooMany(res, windowMs);
    next();
  };
}

/**
 * `/token`, after the urlencoded parse: a refresh grant is keyed on its family (an unknown token on
 * its own hash), a code grant on client_id + IP — and not at all from the Anthropic egress, where
 * the IP is shared and the client_id is every Claude user's.
 */
export function tokenLimiter() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      if (body.grant_type === 'refresh_token' && typeof body.refresh_token === 'string') {
        const hash = sha256Hex(body.refresh_token);
        const row = await getToken(hash).catch(() => null);
        const { max, windowMs } = OAUTH_LIMITS.tokenRefresh;
        if (!hit(`token|family|${row?.family_id ?? hash}`, max, windowMs)) return tooMany(res, windowMs);
      } else {
        const ip = clientIp(req);
        if (!isAnthropicEgressIp(ip)) {
          const clientId = typeof body.client_id === 'string' ? body.client_id.slice(0, 512) : '';
          const { max, windowMs } = OAUTH_LIMITS.tokenCode;
          if (!hit(`token|client|${clientId}|${ip}`, max, windowMs)) return tooMany(res, windowMs);
        }
      }
    } catch {
      // A limiter that cannot decide lets the request through: the handler still validates it.
    }
    next();
  };
}
