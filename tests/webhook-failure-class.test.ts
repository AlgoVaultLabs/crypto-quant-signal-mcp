/**
 * OPS-WEBHOOK-DELIVERY-AUTO-DISABLED-W1 C3 — the failure classifier (pure leaf).
 * The ratified model (Mr.1 Q1/Q4): `http_410` is the ONLY terminal class; every
 * other class — including SSRF `egress_block` (NXDOMAIN/EAI_AGAIN collapse here) —
 * is transient and self-heals via quarantine + health-probe.
 */
import { describe, it, expect } from 'vitest';
import { classifyDeliveryFailure, extractErrorCode, type WebhookFailureClass } from '../src/lib/webhook-failure-class.js';

// The single terminality rule mirrored from the store's recordFailureAndTransition.
const isTerminal = (c: WebhookFailureClass) => c === 'http_410';

describe('classifyDeliveryFailure — HTTP status', () => {
  it('410 → http_410 (the ONLY permanent class)', () => {
    expect(classifyDeliveryFailure({ httpStatus: 410 })).toBe('http_410');
    expect(isTerminal(classifyDeliveryFailure({ httpStatus: 410 }))).toBe(true);
  });

  it.each([500, 502, 503, 504, 599])('%d → http_5xx (transient)', (s) => {
    const c = classifyDeliveryFailure({ httpStatus: s });
    expect(c).toBe('http_5xx');
    expect(isTerminal(c)).toBe(false);
  });

  it.each([400, 401, 403, 404, 408, 422, 429, 499])('%d → http_4xx (transient)', (s) => {
    const c = classifyDeliveryFailure({ httpStatus: s });
    expect(c).toBe('http_4xx');
    expect(isTerminal(c)).toBe(false);
  });
});

describe('classifyDeliveryFailure — egress block is TRANSIENT (Q1)', () => {
  it('egressBlocked → egress_block, NOT terminal (even over an httpStatus)', () => {
    const c = classifyDeliveryFailure({ egressBlocked: true, httpStatus: 410 });
    expect(c).toBe('egress_block'); // egress precedence, and it is transient
    expect(isTerminal(c)).toBe(false);
  });
});

describe('classifyDeliveryFailure — network error codes', () => {
  it.each(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT'])('%s → timeout', (code) => {
    expect(classifyDeliveryFailure({ errorCode: code })).toBe('timeout');
  });

  it.each(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET'])('%s → conn', (code) => {
    expect(classifyDeliveryFailure({ errorCode: code })).toBe('conn');
  });

  it.each(['ENOTFOUND', 'EAI_AGAIN'])('raw DNS %s → conn (transient) if it escapes the guard', (code) => {
    expect(classifyDeliveryFailure({ errorCode: code })).toBe('conn');
  });

  it.each([
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'CERT_HAS_EXPIRED',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'ERR_SSL_WRONG_VERSION_NUMBER',
  ])('%s → tls (transient — a cert can be renewed)', (code) => {
    const c = classifyDeliveryFailure({ errorCode: code });
    expect(c).toBe('tls');
    expect(isTerminal(c)).toBe(false);
  });

  it('an unknown code → other (transient)', () => {
    expect(classifyDeliveryFailure({ errorCode: 'EWEIRD' })).toBe('other');
  });

  it('no status and no code → timeout (safe transient default, never false-kill)', () => {
    expect(classifyDeliveryFailure({})).toBe('timeout');
  });
});

describe('classifyDeliveryFailure — every C1-observed prod status maps (no undefined)', () => {
  // From the C1 forensic: 502, 404, 401, 422, 400, and network-null.
  it.each([502, 404, 401, 422, 400])('observed %d classifies without undefined', (s) => {
    expect(classifyDeliveryFailure({ httpStatus: s })).toBeDefined();
    expect(isTerminal(classifyDeliveryFailure({ httpStatus: s }))).toBe(false); // all transient
  });
});

describe('extractErrorCode', () => {
  it('reads err.cause.code (undici wrap)', () => {
    expect(extractErrorCode(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))).toBe('ECONNREFUSED');
  });
  it('maps an AbortError (our timeout) → ETIMEDOUT', () => {
    const e = new Error('aborted'); e.name = 'AbortError';
    expect(extractErrorCode(e)).toBe('ETIMEDOUT');
  });
  it('reads a top-level err.code', () => {
    expect(extractErrorCode(Object.assign(new Error('x'), { code: 'EPIPE' }))).toBe('EPIPE');
  });
  it('returns undefined for a bare error / non-object', () => {
    expect(extractErrorCode(new Error('plain'))).toBeUndefined();
    expect(extractErrorCode('nope')).toBeUndefined();
    expect(extractErrorCode(null)).toBeUndefined();
  });
});
