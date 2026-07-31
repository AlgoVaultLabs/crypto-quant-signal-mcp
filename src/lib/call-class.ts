/**
 * OPS-TOP-IP-FORENSICS-W1 (2026-07-31): the ONE canonical `(tool, verdict) → billing class`
 * derivation. Every surface that reports "how many agent calls happened" projects from THIS
 * module — per CLAUDE.md's single-derivation rule, so the digest, /analytics and any future
 * funnel view can never disagree about what counts as demand.
 *
 * Why this exists: on 2026-07-31 the daily digest reported `Total Agent Calls 3080` with
 * `Raw API clients 2955 (top IP 91.6%)`, prompting "how did one caller make 2,707 calls
 * without subscribing?". Forensics (audit: OPS-TOP-IP-FORENSICS-W1-endpoint-truth, vault-only)
 * found the metering fully intact — that bucket's chargeable calls reconciled BYTE-EXACTLY with
 * its quota counter (67 → 67). The number was lying, not the meter: **2,819 of the 2,955 rows
 * (95.4%) were HOLD verdicts, which are free by explicit product design.** The headline
 * conflated free-by-design compute with billable demand, and the two differ ~50x.
 *
 * The classification is DERIVED from `FEATURE_REGISTRY[].quota.unit` — the charge model that
 * already governs the runtime meter — and never from a parallel literal. That is deliberate:
 * CLAUDE.md's "a duplicated fact goes stale — point at the SoT". Adding a tool to the registry
 * classifies it here automatically; adding a `QuotaUnit` member without classifying it is a
 * COMPILE error (`Record<QuotaUnit, …>`), not a silently-dropped bucket.
 *
 * Type-and-data-only imports keep this a dependency-free leaf, so analytics/digest/scoreboard
 * can all import it without a cycle (same shape as payment-rail.ts).
 */
import { FEATURE_REGISTRY, type QuotaUnit } from './feature-registry.js';

/**
 * How a logged `request_log` row relates to the 100/mo call quota.
 *
 * `billable`     — consumed (or would consume) quota. This is DEMAND.
 * `free_hold`    — a metered tool that returned HOLD; free by design, charged nothing.
 * `unmetered`    — not metered against the call quota at all (separately rate-limited).
 * `internal`     — `is_bot_internal` traffic (algovault-bot); enforces its own quota.
 * `unclassified` — a `tool_name` with no registry entry (e.g. a retired tool's historical
 *                  rows). Surfaced as `other N`, NEVER silently folded into another class.
 */
export type CallClass = 'billable' | 'free_hold' | 'unmetered' | 'internal' | 'unclassified';

/**
 * How each quota model maps onto the class axis.
 *
 * `always`  — every invocation charges (`per-call`), or charges a minimum of 1 even when every
 *             cell HOLDs (`per-non-hold-min1`, the market scanner). Verdict is irrelevant.
 * `verdict` — charges ONLY for an actionable verdict; HOLD is free (`per-non-hold`).
 * `never`   — not on the call quota (`rate-limited`; see src/lib/chat-rate-limit.ts).
 */
export type BillingAxis = 'always' | 'verdict' | 'never';

export const BILLING_AXIS_BY_QUOTA_UNIT: Record<QuotaUnit, BillingAxis> = {
  'per-call': 'always',
  'per-non-hold-min1': 'always',
  'per-non-hold': 'verdict',
  'rate-limited': 'never',
};

/**
 * Every registry tool NAME AND ALIAS → its billing axis.
 *
 * Aliases matter: `request_log.tool_name` stores the name the caller INVOKED, so
 * `get_trade_signal` (alias of `get_trade_call`) appears as its own value and must classify
 * identically. Verified live 2026-07-31: both appear as distinct `tool_name` values.
 */
export const BILLING_AXIS_BY_TOOL: Readonly<Record<string, BillingAxis>> = Object.freeze(
  Object.fromEntries(
    FEATURE_REGISTRY.flatMap((f) => {
      const axis = BILLING_AXIS_BY_QUOTA_UNIT[f.quota.unit];
      return [f.name, ...f.aliases].map((n) => [n, axis] as const);
    }),
  ),
);

/** Tool names (incl. aliases) on a given axis — DERIVED, never a parallel hand-kept literal. */
function toolsOnAxis(axis: BillingAxis): string[] {
  return Object.keys(BILLING_AXIS_BY_TOOL).filter((t) => BILLING_AXIS_BY_TOOL[t] === axis);
}

/** Charges on every invocation regardless of verdict. */
export const ALWAYS_BILLABLE_TOOLS: readonly string[] = toolsOnAxis('always');
/** Charges only for a non-HOLD verdict. */
export const VERDICT_BILLABLE_TOOLS: readonly string[] = toolsOnAxis('verdict');
/** Never charged against the call quota. */
export const UNMETERED_TOOLS: readonly string[] = toolsOnAxis('never');

/** The verdict string that means "no actionable call" — free on a `verdict` tool. */
export const HOLD_VERDICT = 'HOLD';

/**
 * THE single derivation. Every consumer projects from this one function (or from the SQL
 * generated below, which encodes the identical rule).
 *
 * `verdict` is `request_log.verdict`: null for tools that emit no verdict (regime/scan/search).
 * A null verdict on a `verdict`-axis tool cannot have been a HOLD (the handler only writes a
 * verdict once it has one), so it counts as billable — this matches the runtime, which charges
 * after the verdict is known and treats "not HOLD" as chargeable.
 */
export function callClassFor(
  toolName: string | null | undefined,
  verdict: string | null | undefined,
  isBotInternal = false,
): CallClass {
  if (isBotInternal) return 'internal';
  if (!toolName) return 'unclassified';
  const axis = BILLING_AXIS_BY_TOOL[toolName];
  if (axis === undefined) return 'unclassified';
  if (axis === 'never') return 'unmetered';
  if (axis === 'always') return 'billable';
  return verdict === HOLD_VERDICT ? 'free_hold' : 'billable';
}

/**
 * SQL fragment + bind params implementing `callClassFor` for the `billable` and `free_hold`
 * classes, GENERATED from the same map so no parallel literal can drift out of step with the
 * runtime meter. Placeholders are `?` to match the dbQuery idiom used across analytics.ts.
 *
 * Returns `null` when a class has no tools at all (an empty `IN ()` is a SQL syntax error), so
 * callers can substitute a constant-false predicate rather than emit invalid SQL.
 */
export interface ClassPredicate {
  /** SQL boolean expression over `request_log`, using `?` placeholders. */
  sql: string;
  /** Bind params, in the order the placeholders appear. */
  params: string[];
}

function inList(tools: readonly string[]): string {
  return tools.map(() => '?').join(',');
}

/** `billable` — always-charged tools, plus verdict-charged tools whose verdict is not HOLD. */
export function billablePredicate(): ClassPredicate | null {
  const clauses: string[] = [];
  const params: string[] = [];
  if (ALWAYS_BILLABLE_TOOLS.length > 0) {
    clauses.push(`tool_name IN (${inList(ALWAYS_BILLABLE_TOOLS)})`);
    params.push(...ALWAYS_BILLABLE_TOOLS);
  }
  if (VERDICT_BILLABLE_TOOLS.length > 0) {
    clauses.push(
      `(tool_name IN (${inList(VERDICT_BILLABLE_TOOLS)}) AND (verdict IS NULL OR verdict <> ?))`,
    );
    params.push(...VERDICT_BILLABLE_TOOLS, HOLD_VERDICT);
  }
  if (clauses.length === 0) return null;
  return { sql: `(${clauses.join(' OR ')})`, params };
}

/** `free_hold` — verdict-charged tools that returned HOLD. */
export function freeHoldPredicate(): ClassPredicate | null {
  if (VERDICT_BILLABLE_TOOLS.length === 0) return null;
  return {
    sql: `(tool_name IN (${inList(VERDICT_BILLABLE_TOOLS)}) AND verdict = ?)`,
    params: [...VERDICT_BILLABLE_TOOLS, HOLD_VERDICT],
  };
}

/** `unmetered` — tools off the call quota entirely. */
export function unmeteredPredicate(): ClassPredicate | null {
  if (UNMETERED_TOOLS.length === 0) return null;
  return { sql: `tool_name IN (${inList(UNMETERED_TOOLS)})`, params: [...UNMETERED_TOOLS] };
}
