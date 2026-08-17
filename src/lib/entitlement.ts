/**
 * PRICING-BOT-DELIVERY-METERING-W1 CH2 — the ONE debit for every non-request-context channel.
 *
 * WHAT THIS REPLACES. Four channels each decided their own metering, in four different files, and
 * none was forced to declare itself: `mcp` charges inline via `trackCall`, `webhook` out-of-band
 * via `trackCallByKey`, `httpX402` settles on-chain, and `bot` kept a wholly separate meter in its
 * own SQLite. `a2mcp` and `acp` were declared in `feature-registry.ts` and never decided. This
 * module is the single seam those out-of-band channels now share, and `entitlement-channels.ts` is
 * where each one's policy is DECLARED rather than implied by a call site.
 *
 * ── CLAIM BEFORE CHARGE, and why that ordering is the contract ─────────────────────────────────
 * Two failure modes are available and they are not symmetric:
 *
 *   claim → crash → replay      ⇒ the replay sees ALREADY_CLAIMED and one delivery goes FREE.
 *   charge → crash → replay     ⇒ the replay charges AGAIN and the subscriber pays TWICE.
 *
 * Under architect ruling R-1 the bot HARD WALLS a paid subscriber at the plan ceiling, so an
 * over-charge does not merely misreport — it walls a paying customer early, i.e. it takes away
 * service they bought. An under-charge costs us one delivery's revenue and takes nothing from
 * anyone. We therefore claim first and accept the cheaper failure. This is a deliberate trade,
 * not an accident of statement order, and it must not be "optimised" by moving the charge up.
 *
 * ── WHAT THIS MODULE MAY NOT DO ────────────────────────────────────────────────────────────────
 * It must not duplicate `getMonthlyQuota` / `getDailyCap` / any plan number (those live in
 * `plans.ts`, reached through `license.ts`), must not write `quota_usage` with its own SQL (it
 * calls `license.ts`), and must not render user-facing copy.
 *
 * 🛑 It must NOT write a `request_log` row, and neither may the HTTP route in front of it. A debit
 * is not a request. `tests/call-class.test.ts` asserts the digest identity
 * `recognized + raw + paid + TG-bot-row == headline`; a `request_log` row for a bot delivery would
 * put that delivery on BOTH sides and fail the partition by double-count. `entitlement_debits` is
 * the only row a debit writes.
 */
import type { LicenseTier } from '../types.js';
import { checkQuotaByKey, trackCallByKey, getTrackerEpisode } from './license.js';
import { policyFor, type ChannelId } from './entitlement-channels.js';
import { tryClaimOnce } from './idempotency.js';
import { dbExec } from './performance-db.js';

/** The table is both the ledger and the claim store — see migrations/029. */
const DEBITS_TABLE = 'entitlement_debits';
const DEBITS_CONFLICT_COLS = Object.freeze(['idem_key']);
const INDETERMINATE_TAG = 'entitlement_debit';

export interface EntitlementDecision {
  readonly allowed: boolean;
  readonly tier: LicenseTier;
  readonly used: number;
  /** `Infinity` for an uncapped tier. Serialises as `null` over HTTP — see the route. */
  readonly total: number;
  readonly remaining: number;
  /** WHICH meter refused, or `null` when allowed. */
  readonly limit: 'monthly' | 'daily' | null;
  /** The monthly episode key — lets a caller scope "notify once per episode" state correctly. */
  readonly periodStart: string | null;
  /** The daily episode key, same purpose. */
  readonly dailyDay: string | null;
  /** Projected from CHANNEL_BILLING_POLICY, never decided here. */
  readonly refusesAtWall: boolean;
}

export interface ConsumeResult {
  readonly outcome: 'CHARGED' | 'ALREADY_CHARGED' | 'REFUSED' | 'INDETERMINATE';
  readonly decision: EntitlementDecision;
}

let schemaReady = false;
/**
 * Idempotent DDL, mirroring migrations/029 for the SQLite backend and for a fresh PG that has not
 * had migrations applied. `x402-idempotency-store.ts` sets this pattern.
 */
function ensureEntitlementDebitsSchema(): void {
  if (schemaReady) return;
  const isPg = !!process.env.DATABASE_URL;
  dbExec(`
    CREATE TABLE IF NOT EXISTS ${DEBITS_TABLE} (
      idem_key    TEXT PRIMARY KEY,
      tracker_key TEXT NOT NULL,
      channel     TEXT NOT NULL,
      tier        TEXT NOT NULL,
      units       INTEGER NOT NULL,
      charged_at  ${isPg ? 'TIMESTAMPTZ' : 'TIMESTAMP'} NOT NULL DEFAULT ${isPg ? 'now()' : "(datetime('now'))"}
    );
    CREATE INDEX IF NOT EXISTS idx_entitlement_debits_tracker ON ${DEBITS_TABLE} (tracker_key, charged_at);
    CREATE INDEX IF NOT EXISTS idx_entitlement_debits_channel ON ${DEBITS_TABLE} (channel, charged_at);
  `);
  schemaReady = true;
}

/** Test seam: forget that the DDL ran, so a fresh in-memory DB re-creates it. */
export function _resetEntitlementSchemaForTest(): void {
  schemaReady = false;
}

/** A decision shaped for a channel whose ledger is NOT the plan meter (`settled`). */
function uncappedDecision(tier: LicenseTier, refusesAtWall: boolean): EntitlementDecision {
  return {
    allowed: true, tier, used: 0, total: Infinity, remaining: Infinity,
    limit: null, periodStart: null, dailyDay: null, refusesAtWall,
  };
}

/**
 * Read the current entitlement state WITHOUT charging or claiming.
 *
 * Projects from `checkQuotaByKey` — the same predicate the charge path treats as authoritative —
 * so a read and a subsequent refusal can never disagree about where the ceiling is.
 */
export function readEntitlement(
  trackerKey: string,
  tier: LicenseTier,
  channel: ChannelId,
): EntitlementDecision {
  const policy = policyFor(channel);
  if (policy.debitMode === 'settled') return uncappedDecision(tier, policy.refusesAtWall);
  // ORDER IS LOAD-BEARING: read the episode BEFORE the gate. `checkQuotaByKey` reaches
  // `getCallTracker`, which MATERIALISES a `{count: 0, periodStart: now}` entry for a key it has
  // never seen — so asking afterwards would report an episode that this very read had just
  // invented, and a never-charged subscriber would look mid-window. Asking first lets absent stay
  // absent, which is what "no episode yet" honestly means.
  const episode = getTrackerEpisode(trackerKey);
  const q = checkQuotaByKey(trackerKey, tier);
  return {
    allowed: q.allowed,
    tier,
    used: q.used,
    total: q.total,
    remaining: q.remaining,
    limit: q.limit ?? null,
    periodStart: episode.periodStart,
    dailyDay: episode.dailyDay,
    refusesAtWall: policy.refusesAtWall,
  };
}

/**
 * Consume one entitlement debit. The ordering below IS the contract — see the module docblock.
 */
export async function consumeEntitlement(args: {
  trackerKey: string;
  tier: LicenseTier;
  channel: ChannelId;
  units: number;
  idempotencyKey: string;
}): Promise<ConsumeResult> {
  const { trackerKey, tier, channel, units, idempotencyKey } = args;
  const policy = policyFor(channel);

  // 1. A channel nobody has decided about does not get to debit somebody's plan by default.
  if (policy.debitMode === 'none') {
    return { outcome: 'REFUSED', decision: readEntitlement(trackerKey, tier, channel) };
  }

  // 2. `settled` pays on its own rail; the plan meter is not its ledger. Never touch quota_usage.
  if (policy.debitMode === 'settled') {
    return { outcome: 'ALREADY_CHARGED', decision: uncappedDecision(tier, policy.refusesAtWall) };
  }

  // 3. `checkQuotaByKey` is THE decision.
  //
  //    RETIRED DIVERGENCE: `checkQuotaByKey` refuses at `count >= quota` while `trackCallByKey`
  //    returns allowed:false at `count > quota` — two predicates for one wall, differing by
  //    exactly one call. This module treats checkQuotaByKey as authoritative and IGNORES
  //    trackCallByKey's `allowed`, so a caller at exactly `used === total` is REFUSED rather than
  //    served-then-walled. Neither function's own predicate is changed: other callers depend on
  //    today's behaviour and that is out of this wave's scope.
  const gate = checkQuotaByKey(trackerKey, tier);
  if (!gate.allowed && policy.refusesAtWall) {
    // Nothing charged AND nothing claimed — so the caller may retry with the SAME key after a
    // reset or an upgrade and be served. Claiming here would burn the key on a refusal.
    return { outcome: 'REFUSED', decision: readEntitlement(trackerKey, tier, channel) };
  }
  // `!refusesAtWall` falls through deliberately: a meter-only channel counts past its ceiling.

  // 4. Claim BEFORE charging.
  let claim;
  try {
    ensureEntitlementDebitsSchema();
    claim = await tryClaimOnce(
      DEBITS_TABLE,
      DEBITS_CONFLICT_COLS,
      { idem_key: idempotencyKey, tracker_key: trackerKey, channel, tier, units },
      INDETERMINATE_TAG,
    );
  } catch (err) {
    // A guard on a live serving path REFUSES; it does not THROW into the caller's loop.
    console.error('[entitlement] claim failed hard — INDETERMINATE:', err instanceof Error ? err.message : String(err));
    claim = 'INDETERMINATE' as const;
  }

  if (claim === 'ALREADY_CLAIMED') {
    // A genuine replay. Do NOT charge. Return fresh state so the caller sees today's numbers.
    return { outcome: 'ALREADY_CHARGED', decision: readEntitlement(trackerKey, tier, channel) };
  }
  if (claim === 'INDETERMINATE') {
    // We do not know whether this key was already charged. NEVER charge on an unknown claim:
    // fail-CLOSED on the money. Whether to still DELIVER is the caller's call, not ours.
    return { outcome: 'INDETERMINATE', decision: readEntitlement(trackerKey, tier, channel) };
  }

  // 5. We won the claim. Charge monthly + daily.
  trackCallByKey(trackerKey, tier, units);

  // 6. Read AFTER the charge, so the caller sees the state its own debit produced.
  return { outcome: 'CHARGED', decision: readEntitlement(trackerKey, tier, channel) };
}
