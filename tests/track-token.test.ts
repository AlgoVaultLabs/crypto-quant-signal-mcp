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
