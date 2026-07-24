/**
 * OPS-WEBHOOK-DELIVERY-AUTO-DISABLED-W1 C3 — the ONE webhook failure classifier.
 *
 * A pure LEAF: no store, no HTTP, no side effects (import graph has no cycle).
 * Maps a delivery failure to a granular `failure_class`. The lifecycle policy
 * (webhooks-store `recordFailureAndTransition`) derives terminality from this by
 * a SINGLE rule — `failure_class === 'http_410'` is the ONLY permanent class
 * (Mr.1 Q4); everything else is transient (quarantine + health-probe → auto-resume
 * or, after 7d, `quarantine_expired`). Per Mr.1 Q1 an SSRF `egressBlocked` (which
 * the guard also raises for NXDOMAIN / EAI_AGAIN, collapsing them) is TRANSIENT —
 * a transient DNS blip must not permanently kill a paying subscriber; the guard
 * still blocks every probe/delivery attempt regardless of lifecycle state.
 */

export type WebhookFailureClass =
  | 'http_410'
  | 'http_5xx'
  | 'http_4xx'
  | 'timeout'
  | 'conn'
  | 'egress_block'
  | 'tls'
  | 'other';

export interface DeliveryFailureInput {
  /** Last HTTP status observed (undefined = no response: network error / timeout). */
  httpStatus?: number;
  /** Node/undici error code (ETIMEDOUT, ECONNRESET, a TLS cert code, …). */
  errorCode?: string;
  /** The SSRF egress guard rejected the target (the per-delivery `dead` path). */
  egressBlocked?: boolean;
}

const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'ERR_SSL_WRONG_VERSION_NUMBER',
]);

const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ETIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const CONN_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'UND_ERR_SOCKET',
  // DNS errors rarely reach here (the SSRF guard resolves first and raises
  // egress_block), but if a raw one surfaces it is transient-connectivity.
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAIL',
]);

export function classifyDeliveryFailure(input: DeliveryFailureInput): WebhookFailureClass {
  // 1) SSRF egress block — TRANSIENT (Mr.1 Q1). The guard collapses NXDOMAIN /
  //    EAI_AGAIN / internal-target here; all quarantine + probe rather than die.
  if (input.egressBlocked) return 'egress_block';

  // 2) HTTP status classes.
  const s = input.httpStatus;
  if (typeof s === 'number' && Number.isFinite(s)) {
    if (s === 410) return 'http_410'; // RFC 410 Gone — the ONLY permanent class (Q4)
    if (s >= 500 && s <= 599) return 'http_5xx';
    if (s >= 400 && s <= 499) return 'http_4xx';
    return 'other'; // an unexpected non-2xx that isn't 4xx/5xx
  }

  // 3) Network error codes (no HTTP response).
  const code = (input.errorCode ?? '').toUpperCase();
  if (code) {
    if (TLS_CODES.has(code) || code.startsWith('ERR_TLS') || code.startsWith('ERR_SSL') || code.includes('CERT')) return 'tls';
    if (TIMEOUT_CODES.has(code)) return 'timeout';
    if (CONN_CODES.has(code)) return 'conn';
    return 'other';
  }

  // 4) No status, no code — a bare network failure/abort. Default TRANSIENT
  //    (safest: never false-kill on an unclassifiable blip — the probe decides).
  return 'timeout';
}

/**
 * Pull a Node/undici error code out of a caught fetch/postWithTimeout error so
 * the classifier can see it (the retry loop otherwise discards it). undici wraps
 * the underlying system error in `.cause`; our AbortController timeout surfaces
 * as `AbortError`. Pure — safe to call on anything.
 */
export function extractErrorCode(err: unknown): string | undefined {
  if (err == null || typeof err !== 'object') return undefined;
  const e = err as { name?: string; code?: string; cause?: unknown };
  if (e.name === 'AbortError') return 'ETIMEDOUT'; // our timeout abort
  if (e.cause && typeof e.cause === 'object') {
    const c = e.cause as { code?: string; name?: string };
    if (c.code) return String(c.code);
    if (c.name === 'AbortError') return 'ETIMEDOUT';
  }
  if (e.code) return String(e.code);
  return undefined;
}
