/**
 * BOT-W2 C1 — bot internal-bypass auth helper tests.
 *
 * Two-flag firewall: outer BOT_INTERNAL_BYPASS_ENABLED + inner header match.
 * Reuses the W1 env vars; no new shared secret.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkBotInternalAuth } from '../src/lib/bot-auth.js';

const VALID_KEY = 'a'.repeat(32);

describe('BOT-W2 checkBotInternalAuth', () => {
  const orig_enabled = process.env.BOT_INTERNAL_BYPASS_ENABLED;
  const orig_key = process.env.ALGOVAULT_INTERNAL_BYPASS_KEY;

  beforeEach(() => {
    process.env.BOT_INTERNAL_BYPASS_ENABLED = 'true';
    process.env.ALGOVAULT_INTERNAL_BYPASS_KEY = VALID_KEY;
  });

  afterEach(() => {
    if (orig_enabled === undefined) delete process.env.BOT_INTERNAL_BYPASS_ENABLED;
    else process.env.BOT_INTERNAL_BYPASS_ENABLED = orig_enabled;
    if (orig_key === undefined) delete process.env.ALGOVAULT_INTERNAL_BYPASS_KEY;
    else process.env.ALGOVAULT_INTERNAL_BYPASS_KEY = orig_key;
  });

  it('allows request with matching key (lowercase header)', () => {
    const r = checkBotInternalAuth({ 'x-algovault-internal-key': VALID_KEY });
    expect(r.ok).toBe(true);
  });

  it('allows request with matching key (case-insensitive header lookup)', () => {
    const r = checkBotInternalAuth({ 'X-AlgoVault-Internal-Key': VALID_KEY });
    expect(r.ok).toBe(true);
  });

  it('returns 403 when BOT_INTERNAL_BYPASS_ENABLED != "true"', () => {
    process.env.BOT_INTERNAL_BYPASS_ENABLED = 'false';
    const r = checkBotInternalAuth({ 'x-algovault-internal-key': VALID_KEY });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(403);
      expect(r.error).toBe('bot_internal_bypass_disabled');
    }
  });

  it('returns 403 when ALGOVAULT_INTERNAL_BYPASS_KEY is missing', () => {
    delete process.env.ALGOVAULT_INTERNAL_BYPASS_KEY;
    const r = checkBotInternalAuth({ 'x-algovault-internal-key': VALID_KEY });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it('returns 403 when env key is too short (<16 chars)', () => {
    process.env.ALGOVAULT_INTERNAL_BYPASS_KEY = 'short';
    const r = checkBotInternalAuth({ 'x-algovault-internal-key': 'short' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it('returns 401 when header missing', () => {
    const r = checkBotInternalAuth({});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(401);
      expect(r.error).toBe('unauthorized');
    }
  });

  it('returns 401 when header key mismatches env', () => {
    const r = checkBotInternalAuth({ 'x-algovault-internal-key': 'wrong-key-here-32-chars-aaaaaaaa' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it('returns 401 when header is empty string', () => {
    const r = checkBotInternalAuth({ 'x-algovault-internal-key': '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });
});
