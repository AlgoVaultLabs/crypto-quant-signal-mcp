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
