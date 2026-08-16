/**
 * FUNNEL-FIX-HUMAN-SIGNUP-W1 — deferred-identity orchestration (value BEFORE email).
 *
 * `startFree`  : mint an ephemeral av_free_ key, stamp ?src/?ref/utm first-touch, and return
 *                a REAL signal — no email required.
 * `captureEmail`: later claim the ephemeral key with an email (idempotent merge; email = identity).
 *
 * Dependency-injected so the flow is unit-testable without a DB / the market grid. Entitlement
 * is untouched — this only issues + merges keys; resolveFromApiKeyAsync is never called here.
 */
import { mintEphemeralKey, mergeEphemeralIntoEmail } from './free-keys-store.js';
import { recordSignupAttribution } from './subscriber-attribution.js';
import { getGridSnapshot } from './cross-asset-grid.js';
// CH2: the claim event. `license.ts` is FROZEN this wave — imported for reads, never edited.
import { recordFunnelEvent } from './performance-db.js';
import { checkQuotaByKey, getRequestSessionId } from './license.js';

export interface StartFreeAttribution {
  src?: string | null;
  ref?: string | null;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  landing_path?: string | null;
  ip_hash?: string | null;
  user_agent?: string | null;
}

export interface StartFreeSignal {
  asset: string;
  timeframe: string;
  verdict: string | null;
  confidence: number | null;
}

export interface StartFreeResult {
  key: string;
  ephemeral: true;
  signal: StartFreeSignal | null;
  signal_error?: string;
}

export interface DeferredSignupDeps {
  mintEphemeral: (ref?: string | null, ipHash?: string | null) => Promise<string>;
  recordAttribution: (input: Parameters<typeof recordSignupAttribution>[0]) => void;
  getSignal: () => Promise<StartFreeSignal>;
  merge: (ephemeralKey: string, email: string, ref?: string | null) => Promise<string>;
  /**
   * OPS-QUOTA-CLAIM-ALIAS-W1-R2 CH2 — the claim event.
   *
   * Two jobs. It gives CH5's owed claim-rate stage a producer, and it keeps the shared-IP cost the
   * architect ACCEPTED (callers behind CGNAT / corporate NAT / VPN share an `ip_hash`, so they
   * share a bucket once claimed) MEASURED rather than argued. `inherited_usage` is what that costs
   * in practice: a claim inheriting 0 is a fresh visitor; one inheriting 180 is a caller adopting a
   * stranger's spend. If it bites, the fix is a better bucket key — never a threshold.
   */
  recordClaim: (input: { inheritedFrom: string | null; inheritedUsage: number | null }) => void;
  /** Usage already on the bucket being adopted, at claim time. Null when it cannot be read. */
  bucketUsage: (bucketKey: string) => number | null;
}

/**
 * The "value" a first-time human sees before any email.
 *
 * OPS-AUDIT-REMEDIATION-HIGH-W1 (SEC-05): this used to run a LIVE `getTradeSignal('BTC','1h')`
 * on every unauthenticated POST /api/start-free — venue REST fetches against the shared weight
 * budget plus DB writes, driven by an anonymous caller. It is served from the warmed cross-asset
 * grid instead: the same numbers the rest of the surface shows, at zero marginal upstream cost.
 *
 * The grid is a warmed cache, so a cold process can legitimately return no BTC/1h cell. That is
 * reported as an absent signal (the route still returns the key) rather than silently falling
 * back to a live call, which would re-open the amplification path under exactly the load that
 * empties the cache.
 */
async function defaultGetSignal(): Promise<StartFreeSignal> {
  const grid = await getGridSnapshot();
  const cell = grid.find((c) => c.coin === 'BTC' && c.timeframe === '1h');
  if (!cell) return { asset: 'BTC', timeframe: '1h', verdict: null, confidence: null };
  return { asset: 'BTC', timeframe: '1h', verdict: cell.signal ?? null, confidence: cell.confidence ?? null };
}

export const defaultDeferredSignupDeps: DeferredSignupDeps = {
  mintEphemeral: (ref, ipHash) => mintEphemeralKey(ref, ipHash),
  recordAttribution: (input) => recordSignupAttribution(input),
  getSignal: defaultGetSignal,
  merge: (ephemeralKey, email, ref) => mergeEphemeralIntoEmail(ephemeralKey, email, ref),
  // Reads only — `license.ts` is frozen this wave and is imported, never edited.
  recordClaim: ({ inheritedFrom, inheritedUsage }) => recordFunnelEvent({
    eventType: 'free_key_claimed',
    sessionId: getRequestSessionId() ?? null,
    licenseTier: 'free',
    meta: { inherited_from: inheritedFrom, inherited_usage: inheritedUsage },
  }),
  bucketUsage: (bucketKey) => {
    try { return checkQuotaByKey(bucketKey, 'free').used; } catch { return null; }
  },
};

/** Issue an ephemeral key + a real signal, no email. Attribution stamped (client_reference_id = the key). */
export async function startFree(
  attr: StartFreeAttribution,
  deps: DeferredSignupDeps = defaultDeferredSignupDeps,
): Promise<StartFreeResult> {
  // SEC-05: the caller identity the issuance cap bounds on. Never mint unbounded.
  const key = await deps.mintEphemeral(attr.ref ?? null, attr.ip_hash ?? null);
  // Stamp first-touch attribution against the KEY (so a later merge/conversion joins). This
  // CLOSES the free-flow ?src/utm gap (only /signup captured it before). Fail-open.
  try {
    deps.recordAttribution({
      clientReferenceId: key,
      utmSource: attr.utm_source ?? attr.src ?? null, // ?src preserved as utmSource → channel derives from it
      utmMedium: attr.utm_medium ?? null,
      utmCampaign: attr.utm_campaign ?? null,
      landingPath: attr.landing_path ?? null,
      tierRequested: 'free',
      ipHash: attr.ip_hash ?? null,
      userAgent: attr.user_agent ?? null,
    });
  } catch { /* attribution is best-effort — never block issuance */ }
  // OPS-QUOTA-CLAIM-ALIAS-W1-R2 CH2 — record WHAT the claim inherited, at claim time.
  //
  // Read BEFORE the caller spends anything under the new key, so the figure is the bucket's
  // pre-claim state rather than a number already moving. `ip_hash` is the only source: adoption is
  // always from the caller's own keyless bucket, never from a previously claimed key. Fail-open —
  // a measurement must never cost someone their key.
  try {
    const inheritedFrom = attr.ip_hash ? `free:${attr.ip_hash}` : null;
    deps.recordClaim({
      inheritedFrom,
      inheritedUsage: inheritedFrom ? deps.bucketUsage(inheritedFrom) : null,
    });
  } catch { /* instrumentation is best-effort — never block issuance */ }
  let signal: StartFreeSignal | null = null;
  let signal_error: string | undefined;
  try { signal = await deps.getSignal(); }
  catch (err) { signal_error = err instanceof Error ? err.message : String(err); }
  return { key, ephemeral: true, signal, ...(signal_error ? { signal_error } : {}) };
}

/** Claim an ephemeral key with an email (idempotent merge; email = identity). Returns the durable key. */
export async function captureEmail(
  ephemeralKey: string,
  email: string,
  ref: string | null | undefined,
  deps: DeferredSignupDeps = defaultDeferredSignupDeps,
): Promise<{ key: string }> {
  const key = await deps.merge(ephemeralKey, email, ref ?? null);
  return { key };
}
