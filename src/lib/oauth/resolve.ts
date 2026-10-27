/**
 * GROWTH-AGENT-SIGNIN-OAUTH-W1 CH2 — an access token on `/mcp` resolves to the PERSON, then to
 * their CURRENT credential (R2.12, proposal (b)).
 *
 * A token never carries a plan. It names an identity — a verified email, or (key path, no email on
 * file) the key itself — and every request re-derives which credential that identity holds now:
 * PAID and entitled → their paid key's license; PAID but lapsed, or FREE → their free key (minted
 * idempotently); a bare-key identity → that key's own resolution. So an upgrade or a lapse reaches
 * the client on its next call, with no new sign-in. The identity → key step is cached 5 min; the
 * key's own resolution keeps its existing caches.
 *
 * Outcomes: RESOLVED (the key's license) · INDETERMINATE (store, Stripe or the identity layer could
 * not answer → the last good license if under 24 h old, else today's INDETERMINATE, `-32004`) ·
 * TOKEN_INVALID (unknown · expired · revoked · wrong resource · a bare-key identity whose key no
 * longer resolves) → the caller's 401. Nothing here throws on a serving path.
 *
 * `mintFreeKey` is called directly here (allow-listed in `signin-identity-conformance.test.ts`):
 * the identity is already verified — it is the token's — and only the free fallback is minted.
 */
import type { LicenseInfo } from '../../types.js';
import { hashIp } from '../analytics.js';
import { mintFreeKey } from '../free-keys-store.js';
import { recordFunnelEvent } from '../performance-db.js';
import { resolveSigninIdentity } from '../signin-identity.js';
import { validateApiKey } from '../stripe.js';
import { clientHost } from './clients.js';
import { isOurResource } from './mode.js';
import { freshAccessGrant, isFamilyRevokedHere } from './provider.js';
import { getToken, sha256Hex } from './store.js';

const IDENTITY_TTL_MS = 5 * 60 * 1000;
const LAST_GOOD_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 20_000;

type KeyResolver = (authHeader?: string) => Promise<LicenseInfo>;

const TOKEN_INVALID: LicenseInfo = { tier: 'free', key: null, outcome: 'TOKEN_INVALID', anonymous: true };
const INDETERMINATE: LicenseInfo = { tier: 'free', key: null, indeterminate: true, outcome: 'INDETERMINATE', retryable: true };

/** identity → the credential it held when last asked (5 min). */
const identityKey = new Map<string, { key: string; at: number }>();
/** token hash → the last RESOLVED license (24 h), for INDETERMINATE. */
const lastGood = new Map<string, { license: LicenseInfo; at: number }>();
/** `${utcDay}|${identity hash}` already counted as oauth_active today. */
const activeToday = new Set<string>();
let activeDay = '';

/** Test seam. */
export function _resetOAuthResolveForTest(): void {
  identityKey.clear();
  lastGood.clear();
  activeToday.clear();
  activeDay = '';
}

function bounded<K, V>(map: Map<K, V>): void {
  if (map.size >= MAX_ENTRIES) map.clear();
}

function fallback(hash: string, now: number): LicenseInfo {
  const g = lastGood.get(hash);
  return g && now - g.at < LAST_GOOD_MS ? g.license : INDETERMINATE;
}

interface Grant {
  familyId: string;
  clientId: string;
  resource: string;
  identityKind: string;
  identityValue: string;
}

/** The token's grant, null when it is not a live access token for /mcp, 'unreachable' on a store fault. */
async function grantFor(hash: string, now: number): Promise<Grant | null | 'unreachable'> {
  const fresh = freshAccessGrant(hash, now);
  if (fresh) return fresh;
  let row;
  try {
    row = await getToken(hash);
  } catch {
    return 'unreachable';
  }
  if (!row || row.kind !== 'access' || row.revoked_at || Date.parse(row.expires_at) <= now || isFamilyRevokedHere(row.family_id)) return null;
  return { familyId: row.family_id, clientId: row.client_id, resource: row.resource, identityKind: row.identity_kind, identityValue: row.identity_value };
}

/** An email identity's current credential; null when the identity layer could not answer. */
async function currentKeyForEmail(email: string, now: number): Promise<string | null> {
  const cached = identityKey.get(email);
  if (cached && now - cached.at < IDENTITY_TTL_MS) return cached.key;
  const identity = await resolveSigninIdentity(email);
  let key: string | null = null;
  if (identity.outcome === 'PAID' && identity.key) {
    const v = await validateApiKey(identity.key);
    if (v.valid) key = identity.key;
    else if (v.entitlementState === 'INDETERMINATE') return null;
    else key = await mintFreeKey(email);
  } else if (identity.outcome === 'FREE' && identity.key) {
    key = identity.key;
  } else {
    return null;
  }
  bounded(identityKey);
  identityKey.set(email, { key, at: now });
  return key;
}

function noteActive(grant: Grant, license: LicenseInfo, now: number): void {
  const day = new Date(now).toISOString().slice(0, 10);
  if (day !== activeDay) {
    activeDay = day;
    activeToday.clear();
  }
  const session = hashIp(`oauth-identity:${grant.identityValue}`);
  const k = `${day}|${session}`;
  if (activeToday.has(k)) return;
  activeToday.add(k);
  try {
    recordFunnelEvent({ eventType: 'oauth_active', sessionId: session, licenseTier: license.tier, meta: { client_host: clientHost(grant.clientId), tier: license.tier } });
  } catch {
    /* best-effort */
  }
}

/** The license for an `avat_` bearer on `/mcp` (mode ≠ off). Never throws. */
export async function resolveOAuthAccess(token: string, resolveKey: KeyResolver, now: number = Date.now()): Promise<LicenseInfo> {
  const hash = sha256Hex(token);
  try {
    const grant = await grantFor(hash, now);
    if (grant === 'unreachable') return fallback(hash, now);
    if (grant === null || !isOurResource(grant.resource)) return TOKEN_INVALID;

    let license: LicenseInfo;
    if (grant.identityKind === 'email') {
      const key = await currentKeyForEmail(grant.identityValue, now);
      if (key === null) return fallback(hash, now);
      license = await resolveKey(`Bearer ${key}`);
    } else {
      license = await resolveKey(`Bearer ${grant.identityValue}`);
      if (license.outcome !== 'RESOLVED' && license.outcome !== 'INDETERMINATE') return TOKEN_INVALID;
    }
    if (license.outcome === 'INDETERMINATE') return fallback(hash, now);
    if (license.outcome !== 'RESOLVED') return fallback(hash, now);
    bounded(lastGood);
    lastGood.set(hash, { license, at: now });
    noteActive(grant, license, now);
    return license;
  } catch {
    return fallback(hash, now);
  }
}
