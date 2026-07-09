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
import { getTradeSignal } from '../tools/get-trade-call.js';

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
  mintEphemeral: (ref?: string | null) => Promise<string>;
  recordAttribution: (input: Parameters<typeof recordSignupAttribution>[0]) => void;
  getSignal: () => Promise<StartFreeSignal>;
  merge: (ephemeralKey: string, email: string, ref?: string | null) => Promise<string>;
}

async function defaultGetSignal(): Promise<StartFreeSignal> {
  // One real BTC/1h call — the "value" a first-time human sees before any email.
  const r = (await getTradeSignal({ coin: 'BTC', timeframe: '1h' })) as unknown as { verdict?: string; confidence?: number | null };
  return { asset: 'BTC', timeframe: '1h', verdict: r?.verdict ?? null, confidence: r?.confidence ?? null };
}

export const defaultDeferredSignupDeps: DeferredSignupDeps = {
  mintEphemeral: (ref) => mintEphemeralKey(ref),
  recordAttribution: (input) => recordSignupAttribution(input),
  getSignal: defaultGetSignal,
  merge: (ephemeralKey, email, ref) => mergeEphemeralIntoEmail(ephemeralKey, email, ref),
};

/** Issue an ephemeral key + a real signal, no email. Attribution stamped (client_reference_id = the key). */
export async function startFree(
  attr: StartFreeAttribution,
  deps: DeferredSignupDeps = defaultDeferredSignupDeps,
): Promise<StartFreeResult> {
  const key = await deps.mintEphemeral(attr.ref ?? null);
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
