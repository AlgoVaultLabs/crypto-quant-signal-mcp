/**
 * TG-BROADCAST-STACK-W1 CH6 (2026-05-28): track-token helper tests.
 *
 * Pure-function coverage:
 *  - parseTrackTokenFromArgv: --track-token=VAL + --track-token VAL + invalid
 *  - extractHeaderTrackToken: header present + absent + malformed
 *  - resolveTrackTokenForRequest: header precedence over argv
 *  - shouldEmitForRequest: idempotency per (session, token) tuple
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetTrackTokenForTest,
  captureArgvTrackToken,
  extractHeaderTrackToken,
  getArgvTrackToken,
  parseTrackTokenFromArgv,
  resolveTrackTokenForRequest,
  resolveSessionIdentity,
  shouldEmitForRequest,
} from '../src/lib/track-token.js';

afterEach(() => {
  _resetTrackTokenForTest();
});

describe('parseTrackTokenFromArgv', () => {
  it('returns token for --track-token=VAL form', () => {
    const argv = ['node', 'script.js', '--track-token=abc12345'];
    expect(parseTrackTokenFromArgv(argv)).toBe('abc12345');
  });

  it('returns token for --track-token VAL space-separated form', () => {
    const argv = ['node', 'script.js', '--track-token', 'def67890'];
    expect(parseTrackTokenFromArgv(argv)).toBe('def67890');
  });

  it('returns null when flag is absent', () => {
    const argv = ['node', 'script.js', '--other-flag', 'x'];
    expect(parseTrackTokenFromArgv(argv)).toBeNull();
  });

  it('returns null for too-short token', () => {
    const argv = ['--track-token=short'];
    expect(parseTrackTokenFromArgv(argv)).toBeNull();
  });

  it('returns null for too-long token', () => {
    const argv = ['--track-token=' + 'a'.repeat(100)];
    expect(parseTrackTokenFromArgv(argv)).toBeNull();
  });

  it('accepts UUID hex (32 chars)', () => {
    const token = 'abcdef0123456789abcdef0123456789';
    const argv = ['--track-token=' + token];
    expect(parseTrackTokenFromArgv(argv)).toBe(token);
  });

  it('returns null for invalid chars (space)', () => {
    const argv = ['--track-token=has spaces here'];
    expect(parseTrackTokenFromArgv(argv)).toBeNull();
  });
});

describe('captureArgvTrackToken / getArgvTrackToken', () => {
  it('captures from process.argv and returns same value on re-call', () => {
    // Spoof process.argv via temporary override.
    const original = process.argv;
    process.argv = ['node', 'script.js', '--track-token=cafebabe' + 'cafe'.repeat(3)];
    try {
      const first = captureArgvTrackToken();
      expect(first).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
      // Second call must return identical (no re-parse).
      const second = captureArgvTrackToken();
      expect(second).toBe(first);
      expect(getArgvTrackToken()).toBe(first);
    } finally {
      process.argv = original;
    }
  });

  it('returns null when no flag is set', () => {
    const original = process.argv;
    process.argv = ['node', 'script.js'];
    try {
      expect(captureArgvTrackToken()).toBeNull();
      expect(getArgvTrackToken()).toBeNull();
    } finally {
      process.argv = original;
    }
  });
});

describe('extractHeaderTrackToken', () => {
  it('returns token from x-algovault-track-token header', () => {
    const headers = { 'x-algovault-track-token': 'deadbeef' + 'cafe'.repeat(3) };
    expect(extractHeaderTrackToken(headers)).toBe(headers['x-algovault-track-token']);
  });

  it('returns null when header absent', () => {
    expect(extractHeaderTrackToken({})).toBeNull();
  });

  it('returns null for malformed (too short)', () => {
    expect(extractHeaderTrackToken({ 'x-algovault-track-token': 'sht' })).toBeNull();
  });

  it('trims whitespace before validating', () => {
    const headers = { 'x-algovault-track-token': '   abc12345   ' };
    expect(extractHeaderTrackToken(headers)).toBe('abc12345');
  });
});

describe('resolveTrackTokenForRequest', () => {
  it('header takes precedence over argv-captured value', () => {
    const original = process.argv;
    process.argv = ['node', 'script.js', '--track-token=fromargv1'];
    try {
      captureArgvTrackToken();
      const headers = { 'x-algovault-track-token': 'fromheader' };
      expect(resolveTrackTokenForRequest(headers)).toBe('fromheader');
    } finally {
      process.argv = original;
    }
  });

  it('falls back to argv when header absent', () => {
    const original = process.argv;
    process.argv = ['node', 'script.js', '--track-token=fromargv2'];
    try {
      captureArgvTrackToken();
      expect(resolveTrackTokenForRequest({})).toBe('fromargv2');
    } finally {
      process.argv = original;
    }
  });

  it('returns null when neither is set', () => {
    expect(resolveTrackTokenForRequest({})).toBeNull();
  });
});

describe('shouldEmitForRequest', () => {
  it('returns true on first emit per (session, token)', () => {
    expect(shouldEmitForRequest('sess1', 'token1')).toBe(true);
  });

  it('returns false on duplicate emit', () => {
    shouldEmitForRequest('sess1', 'token1');
    expect(shouldEmitForRequest('sess1', 'token1')).toBe(false);
  });

  it('returns true for different session, same token', () => {
    shouldEmitForRequest('sess1', 'token1');
    expect(shouldEmitForRequest('sess2', 'token1')).toBe(true);
  });

  it('returns true for null session', () => {
    expect(shouldEmitForRequest(null, 'token1')).toBe(true);
  });
});

describe('OPS-TRACK-TOKEN-STDIO-CLIENT-WRAPPER-W1 — embedded channel slugs record via the header path', () => {
  // The ratified per-surface slug set embedded in the public install snippets.
  const WAVE_SLUGS = [
    'chan-docs',
    'chan-email',
    'chan-welcome',
    'chan-readme',
    'int-claude-desktop',
    'int-claude-code',
    'int-cursor',
    'int-cline',
  ];

  it.each(WAVE_SLUGS)(
    'slug "%s" is read back by extractHeaderTrackToken (≥8 chars → records)',
    (slug) => {
      expect(slug.length).toBeGreaterThanOrEqual(8);
      expect(slug).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
      expect(extractHeaderTrackToken({ 'x-algovault-track-token': slug })).toBe(slug);
    },
  );

  // R0 finding regression guard: the pre-ratification short slugs would have
  // been SILENTLY dropped by the {8,64} TOKEN_RE (recorded nothing at all).
  it.each(['docs', 'landing', 'email', 'readme', 'int-okx', 'int-maf'])(
    'pre-ratification short slug "%s" would be SILENTLY rejected (records nothing)',
    (shortSlug) => {
      expect(shortSlug.length).toBeLessThan(8);
      expect(extractHeaderTrackToken({ 'x-algovault-track-token': shortSlug })).toBeNull();
    },
  );

  it('records on the tools/call header path: value resolves and the first emit fires (idempotent)', () => {
    const headers = { 'x-algovault-track-token': 'chan-docs' };
    expect(resolveTrackTokenForRequest(headers)).toBe('chan-docs');
    // First tools/call per (session, token) → emit; duplicate → suppressed.
    expect(shouldEmitForRequest('sess-track-w1', 'chan-docs')).toBe(true);
    expect(shouldEmitForRequest('sess-track-w1', 'chan-docs')).toBe(false);
  });
});

describe('OPS-ACTIVATION-LEAK-FIX-W1 CH2 — resolveSessionIdentity (single-derivation id + tier)', () => {
  const NEVER_UUID = () => 'UUID-SHOULD-NOT-BE-CALLED';

  it('token tier: a valid track-token header → {id: token, tier: token}', () => {
    const id = resolveSessionIdentity({ 'x-algovault-track-token': 'tok-12345678' }, 'iphash-xyz', NEVER_UUID);
    expect(id).toEqual({ id: 'tok-12345678', tier: 'token' });
  });

  it('fallback tier: no token but ipHash present → {id: ipHash, tier: fallback}', () => {
    const id = resolveSessionIdentity({}, 'iphash-xyz', NEVER_UUID);
    expect(id).toEqual({ id: 'iphash-xyz', tier: 'fallback' });
  });

  it('anon tier: neither token nor ipHash → {id: uuid, tier: anon} (uuid only fires here)', () => {
    const id = resolveSessionIdentity({}, '', () => 'fixed-uuid');
    expect(id).toEqual({ id: 'fixed-uuid', tier: 'anon' });
  });

  it('precedence: token beats ipHash (token wins even when both present)', () => {
    const id = resolveSessionIdentity({ 'x-algovault-track-token': 'tok-abcdefgh' }, 'iphash-xyz', NEVER_UUID);
    expect(id.tier).toBe('token');
    expect(id.id).toBe('tok-abcdefgh');
  });

  it('an invalid (too-short) track-token is ignored → falls through to ipHash fallback', () => {
    // 'short' fails the token regex in resolveTrackTokenForRequest → treated as no token.
    const id = resolveSessionIdentity({ 'x-algovault-track-token': 'short' }, 'iphash-xyz', NEVER_UUID);
    expect(id).toEqual({ id: 'iphash-xyz', tier: 'fallback' });
  });

  it('the resolved .id is byte-identical to the historical token??ipHash??uuid precedence', () => {
    // token branch
    expect(resolveSessionIdentity({ 'x-algovault-track-token': 'tok-99999999' }, 'h', NEVER_UUID).id).toBe('tok-99999999');
    // ipHash branch
    expect(resolveSessionIdentity({}, 'h', NEVER_UUID).id).toBe('h');
    // uuid branch
    expect(resolveSessionIdentity({}, '', () => 'u').id).toBe('u');
  });
});
