/**
 * Payment-rail topology — PAY-RAIL-DASHBOARD-W1 (R2).
 *
 * Projects the LIVE rail topology from its sources of truth for the admin dashboard. Follows
 * the `*-coverage.ts` helper convention: one exported reader, a `PROBED_AT` stamp, and no
 * rendering logic — the panel renders what this returns and computes nothing itself.
 *
 * ── WHY THIS EXISTS RATHER THAN A LINE OF TEXT ──────────────────────────────────────────
 * The request was to display `Stripe: Visa/Mastercard/UnionPay` and `x402: Base/Circle`.
 * Both halves would have been defects:
 *
 *   1. A baked brand list is a claim that drifts. It keeps reading "UnionPay" after a Radar
 *      rule starts rejecting every CN issuer, and never grows when a brand is added. The repo
 *      already runs a forward-stability test over tool descriptions for exactly this class,
 *      after a stale "5 perp venues" shipped when real coverage was 12.
 *
 *   2. 🛑 **"Base/Circle" is factually wrong, and correcting it is the point.** Base and
 *      Circle are NOT one rail:
 *        · CDP `exact`      → `eip155:8453`  (Base mainnet)
 *        · Circle Gateway   → `eip155:84532` (Base Sepolia, TESTNET) + `eip155:10` (OP Mainnet)
 *      `eip155:8453` is DELIBERATELY ABSENT from the Gateway allowlist and guarded, because
 *      registering it would collide with the CDP `exact` scheme and REPLACE it — silently
 *      rerouting Base settlement. Rendering "Base/Circle" as one rail asserts Circle settles
 *      on Base mainnet. It does not; it settles on `eip155:10`.
 *
 * ── WHAT IS DERIVED vs WHAT IS TRANSLATED ────────────────────────────────────────────────
 * The distinction matters, because only one of the two can go dangerously stale:
 *
 *   DERIVED (never hardcoded) — the SET of networks and schemes. It comes from
 *   `gatewayAllowedNetworks()`, `cdpExactNetwork()`, `XLAYER_NETWORK` and the observed payment
 *   data. This is the part that drifts, and `resolvePaymentRails` takes it as an injected
 *   config so a test can prove the output is a function of the SoT rather than of this file.
 *
 *   TRANSLATED — a CAIP-2 id to a human label. `NETWORK_META` below is a lookup keyed BY ID,
 *   and an id it does not know renders as the raw CAIP-2 with `isTestnet: null`. So a network
 *   added upstream shows up with its real identifier and an explicitly unestablished testnet
 *   flag — it is never silently labelled "mainnet", which is the only way this table could
 *   lie. A translation keyed by id is not a claim about what exists.
 */
import { gatewayAllowedNetworks, resolveCircleGatewayFromEnv } from './circle-gateway.js';
import { cdpExactNetwork } from './x402.js';
import { XLAYER_NETWORK, resolveOkxA2mcpConfig } from './okx-a2mcp-config.js';

/** Stamp for the `*-coverage.ts` convention — when this projection's shape was last probed. */
export const PAYMENT_RAIL_TOPOLOGY_PROBED_AT = '2026-08-13';

export interface RailNetwork {
  /** CAIP-2 identifier — the authoritative value; always rendered. */
  caip2: string;
  /** Human label, or the raw `caip2` when this id is not in the translation table. */
  label: string;
  /**
   * `true` testnet · `false` mainnet · **`null` = not established**.
   *
   * Null is load-bearing: an unknown network must never be presented as mainnet. Guessing
   * would put a testnet row on an operator surface labelled as production money.
   */
  isTestnet: boolean | null;
}

export interface RailObservedMethods {
  /**
   * 🛑 ALWAYS `true` on the Stripe row, and the panel must say so.
   *
   * These brands are what has TRANSACTED, not what is configured. The Payment Method
   * Configuration is structurally silent on card brands — UnionPay is a BRAND carried by the
   * `card_payments` capability and has no PMC key at all (measured by
   * PAY-UNIONPAY-ATTRIBUTION-W1). So an absent brand here means **no observed volume**, and
   * claiming it meant "not configured" would be a false statement about precisely the brand
   * this arc was opened for.
   */
  observedOnly: true;
  brands: { name: string | null; n: number }[];
  methodTypes: { name: string | null; n: number }[];
  window: string;
}

export interface PaymentRailView {
  /** Stable row id. */
  id: string;
  /** Rail family — the product-level grouping. */
  rail: string;
  /** x402 scheme name where one applies. */
  scheme: string | null;
  /** Who settles it. */
  facilitator: string | null;
  networks: RailNetwork[];
  status: 'live' | 'dark';
  /** Why it is dark — names the env flag, never a vague "disabled". */
  darkReason: string | null;
  /** Module this row derived from, so a wrong value is traceable in one hop. */
  source: string;
  observed?: RailObservedMethods;
}

/**
 * CAIP-2 → human label. A TRANSLATION table, not an inventory: nothing here decides which
 * networks exist or are live. An unknown id degrades to itself with `isTestnet: null`.
 */
const NETWORK_META: Readonly<Record<string, { label: string; isTestnet: boolean }>> = Object.freeze({
  'eip155:8453': { label: 'Base Mainnet', isTestnet: false },
  'eip155:84532': { label: 'Base Sepolia', isTestnet: true },
  'eip155:10': { label: 'OP Mainnet', isTestnet: false },
  'eip155:196': { label: 'X Layer', isTestnet: false },
});

/** Describe a CAIP-2 id. Unknown ids keep their identifier and an unestablished testnet flag. */
export function describeNetwork(caip2: string): RailNetwork {
  const meta = NETWORK_META[caip2];
  return meta
    ? { caip2, label: meta.label, isTestnet: meta.isTestnet }
    : { caip2, label: caip2, isTestnet: null };
}

/**
 * Everything `resolvePaymentRails` needs, injected.
 *
 * Injection is what makes the derivation PROVABLE: a test feeds a modified config and requires
 * a different result, which establishes that the output is a function of the SoT and not of
 * this module's own text. A resolver that read the live modules directly could only be tested
 * against whatever they happen to say today.
 */
export interface RailTopologyConfig {
  cdpNetwork: string;
  gatewayNetworks: readonly string[];
  gatewayEnabled: boolean;
  gatewayReason?: string;
  gatewayActiveNetwork: string;
  a2mcpEnabled: boolean;
  a2mcpNetwork: string;
  observed: RailObservedMethods | null;
}

/** Read the live modules. The ONLY place this file touches global state. */
export function defaultRailTopologyConfig(observed: RailObservedMethods | null = null): RailTopologyConfig {
  const gw = resolveCircleGatewayFromEnv();
  const okx = resolveOkxA2mcpConfig();
  return {
    cdpNetwork: cdpExactNetwork(),
    gatewayNetworks: gatewayAllowedNetworks(),
    gatewayEnabled: gw.enabled,
    gatewayReason: gw.reason,
    gatewayActiveNetwork: gw.network,
    a2mcpEnabled: okx.enabled,
    a2mcpNetwork: XLAYER_NETWORK,
    observed,
  };
}

/**
 * Project the live rail topology. PURE over its config — no I/O, no clock, no throw.
 *
 * One row PER REGISTERED SCHEME rather than per rail family, because the scheme→network
 * mapping is the fact the shorthand destroys. Rendering CDP and Gateway as one "x402" row
 * would reintroduce exactly the "Base/Circle" error this module exists to correct.
 */
export function resolvePaymentRails(cfg: RailTopologyConfig): PaymentRailView[] {
  const rows: PaymentRailView[] = [];

  // ── Stripe ──────────────────────────────────────────────────────────────────────────
  rows.push({
    id: 'stripe-card',
    rail: 'Stripe subscription',
    scheme: null,
    facilitator: 'Stripe',
    networks: [],
    status: 'live',
    darkReason: null,
    source: 'src/lib/payment-method-report.ts (observed) + src/lib/payment-rail.ts (taxonomy)',
    observed: cfg.observed ?? undefined,
  });

  // ── x402 · CDP `exact` ──────────────────────────────────────────────────────────────
  rows.push({
    id: 'x402-cdp-exact',
    rail: 'x402',
    scheme: 'exact',
    facilitator: 'Coinbase CDP',
    networks: [describeNetwork(cfg.cdpNetwork)],
    status: 'live',
    darkReason: null,
    source: 'src/lib/x402.ts#cdpExactNetwork',
  });

  // ── x402 · Circle Gateway ───────────────────────────────────────────────────────────
  // Its OWN allowlist — deliberately excluding the CDP network. The panel showing these as
  // separate rows is what makes a collision visible on an operator surface instead of only
  // in a log line nobody reads.
  rows.push({
    id: 'x402-circle-gateway',
    rail: 'x402',
    scheme: 'exact',
    facilitator: 'Circle Gateway',
    networks: cfg.gatewayNetworks.map(describeNetwork),
    status: cfg.gatewayEnabled ? 'live' : 'dark',
    darkReason: cfg.gatewayEnabled ? null : (cfg.gatewayReason ?? 'CIRCLE_GATEWAY_ENABLED is not "true"'),
    source: 'src/lib/circle-gateway.ts#gatewayAllowedNetworks',
  });

  // ── OKX a2mcp ───────────────────────────────────────────────────────────────────────
  rows.push({
    id: 'a2mcp-okx',
    rail: 'okx.ai A2MCP',
    scheme: 'exact',
    facilitator: 'OKX managed facilitator',
    networks: [describeNetwork(cfg.a2mcpNetwork)],
    status: cfg.a2mcpEnabled ? 'live' : 'dark',
    // Name the FLAG, not a vague "disabled" — an operator needs to know which lever to pull.
    darkReason: cfg.a2mcpEnabled ? null : 'OKX_AI_ENABLED is not "true"',
    source: 'src/lib/okx-a2mcp-config.ts#XLAYER_NETWORK',
  });

  return rows;
}

// ── Calibration state (R2b) ─────────────────────────────────────────────────────────────

export interface CalibrationState {
  /** Observed population in the window — DERIVED, never a literal. */
  n: number;
  threshold: number;
  nToThreshold: number;
  state: 'INERT' | 'ACTIVE';
  window: string;
  /**
   * 🛑 MANDATORY provenance, and it is not decoration.
   *
   * This threshold is the DASHBOARD's own `LOW_CONFIDENCE_N`. It is NOT the decline canary's
   * `MIN_N`, which is a separate constant, per-host overridable via
   * `ALGOVAULT_PAYMENT_DECLINE_MIN_N`, and therefore able to diverge from this one silently.
   * They happen to agree today. An earlier draft of this wave claimed the two surfaces
   * "cannot disagree" — that claim was false and is retracted. Unifying them is owed to
   * OPS-PAYMENT-DECLINE-CALIBRATION-TRIPWIRE-W1; until then this panel speaks only for itself.
   */
  thresholdSource: string;
  canaryAttribution: string;
}

// ── Payload assembly (R3) ───────────────────────────────────────────────────────────────

/** The minimum shape `buildRailsPayload` needs from a payment-method report. */
export interface RailsReportLike {
  low_confidence_threshold_n: number;
  windows: {
    window: string;
    population_n: number;
    successes: {
      by_brand: { card_brand: string | null; n: number }[];
      by_method_type: { payment_method_type: string | null; n: number }[];
    };
  }[];
}

export interface RailsPayload {
  generated_at: string;
  topology_probed_at: string;
  rails: PaymentRailView[];
  metrics: { available: true; report: unknown } | { available: false; reason: string };
  calibration: CalibrationState | null;
}

/**
 * Assemble the `/dashboard/api/payment-rails` payload. PURE — no I/O, no clock (the caller
 * supplies `generatedAt`), no throw.
 *
 * Extracted from the route deliberately. The degradation branch below is the single most
 * important behaviour in this wave, and inside an Express handler in `index.ts` — which boots
 * a server at import — it would be assertable only by reading it. This repo's own law is that
 * a handler is a thin shell over an exported, testable function; AC12 is proven against this,
 * not against a comment.
 *
 * 🛑 A missing report yields `metrics.available: false` WITH a reason — never zeros, never an
 * empty aggregate that renders identically to "nothing happened". A confident zero from an
 * instrument that could not read its subject is the failure mode this estate has met four
 * times; the topology still renders, because it does not depend on the metrics at all.
 */
export function buildRailsPayload(args: {
  rails: PaymentRailView[];
  report: RailsReportLike | null;
  metricsError: string | null;
  generatedAt: string;
}): RailsPayload {
  const { rails, report, metricsError, generatedAt } = args;
  if (!report) {
    return {
      generated_at: generatedAt,
      topology_probed_at: PAYMENT_RAIL_TOPOLOGY_PROBED_AT,
      rails,
      metrics: { available: false, reason: metricsError ?? 'payment-method report unavailable' },
      // Null, not a zeroed CalibrationState: "we could not read it" and "n is 0" are
      // different facts and must not render the same.
      calibration: null,
    };
  }
  const last30d = report.windows.find((w) => w.window === 'Last 30d') ?? null;
  return {
    generated_at: generatedAt,
    topology_probed_at: PAYMENT_RAIL_TOPOLOGY_PROBED_AT,
    rails,
    metrics: { available: true, report },
    calibration: last30d
      ? resolveCalibrationState(last30d.population_n, report.low_confidence_threshold_n, last30d.window)
      : null,
  };
}

/** Project the observed-methods view from a report's Lifetime window. */
export function observedFromReport(report: RailsReportLike | null): RailObservedMethods | null {
  const lifetime = report?.windows.find((w) => w.window === 'Lifetime');
  if (!lifetime) return null;
  return {
    observedOnly: true,
    brands: lifetime.successes.by_brand.map((b) => ({ name: b.card_brand, n: b.n })),
    methodTypes: lifetime.successes.by_method_type.map((m) => ({ name: m.payment_method_type, n: m.n })),
    window: lifetime.window,
  };
}

export function resolveCalibrationState(n: number, threshold: number, window: string): CalibrationState {
  return {
    n,
    threshold,
    nToThreshold: Math.max(0, threshold - n),
    state: n >= threshold ? 'ACTIVE' : 'INERT',
    window,
    thresholdSource: 'LOW_CONFIDENCE_N (src/lib/payment-method-report.ts)',
    canaryAttribution:
      'Dashboard threshold only. The decline canary holds its own MIN_N ' +
      '(ops/monitoring/payment-decline-canary.py, overridable via ALGOVAULT_PAYMENT_DECLINE_MIN_N) ' +
      'and can diverge from this value.',
  };
}
