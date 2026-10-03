/**
 * verdict-rule-registry.ts — SIGNAL-VERDICT-RULE-REGISTRY-W1 CH2 (R1–R3).
 *
 * THE SINGLE DERIVATION OF "WHICH VERDICT RULE PRODUCED THIS CALL". It replaces the retired
 * `TREND_MODE` boolean (`trend-mode-flag.ts`, deleted), which could only switch a scoring rule for
 * every timeframe at once and so turned every scoped finding into a global one.
 *
 * One call to `resolveVerdictRule()` per verdict returns ONE value that every consumer projects
 * from: the served side, the stamp the three writers persist (ruling Q4 = A), and the capture the
 * forward test reads. A second site deriving any of these would drift from this one.
 *
 * ── HOW A CALL IS RESOLVED ─────────────────────────────────────────────────────────────────
 *   1. `m` is today's rule (the engine's live verdict); `v1` is the same inputs with the RSI
 *      negation off. A call is TREND-MODE-DECISIVE iff `m` emits a side that `v1` would not.
 *   2. The cell is (timeframe, regime) for regime ∈ {TRENDING_UP, TRENDING_DOWN}. RANGING, a null
 *      regime and a timeframe outside the registered ten are never cells, so they always serve M.
 *   3. Only a decisive call in a cell assigned F or H changes: F serves the opposite side at the
 *      same |raw| and confidence (trackability and timing unchanged); H serves HOLD. Every other
 *      call — every non-decisive call, in every cell — is identical under every variant.
 *
 * ── STAMP (ruling Q2 = A, 2026-10-03: ROW-LEVEL) ─────────────────────────────────────────────
 * `verdict_rule_version` is 3 only when the served side came from F; every other row is 2, so the
 * v2/v3 split is exactly the population a fade changed. 1 (the contrarian ladder) is never produced
 * again. The ASSIGNMENT travels in `rule_config_id`, the sha256 of the committed assignment plus
 * the kill-switch state (plus the H-store declaration), so the forward record is partitionable by
 * the configuration that produced each row.
 *
 * ── THE KILL SWITCH CAN ONLY FORCE M ────────────────────────────────────────────────────────
 * `VERDICT_RULE_FORCE_M=1` (exact string; default-deny like every other flag here) forces every
 * cell to M without a code deploy (an env change still needs `docker compose up -d`, never
 * `restart`). Rollback to v1 is DENIED (Mr.1, 2026-09-02 and 2026-10-01), so no path here — and
 * no env var anywhere — selects the contrarian ladder for serving.
 *
 * ── H IS REFUSED, NEVER THROWN ──────────────────────────────────────────────────────────────
 * Ruling Q3 = A: H's serving branch is built, but a committed H is refused (the cell serves M) until
 * a quarantined H-hold store ships, because an H-held call routed through the HOLD site would land
 * in `hold_decisions` mislabelled `below_threshold`. A guard on a live serving path REFUSES: one
 * CRITICAL line per refused cell per process, and the call is served. There is deliberately no
 * exported counter — nothing would read it (a dark export) — because the real gate is earlier:
 * `verdict-rule-registry.test.ts` refuses a committed H in CI, so this is the second line.
 *
 * ── EXTENSION CONTRACT (moved here from `currentVerdictRuleVersion()`, retired) ──────────────
 * Every future verdict-rule change arrives as a cell-scoped VARIANT here and in
 * `verdict-rule-assignment.ts` — a threshold move, a `WEIGHTS` retune, a bucket-ladder edit, a
 * B-DIR pass entering serving — judged by the one forward gate. An AOE weight promotion
 * (`src/lib/aoe-config-reader.ts`) is runtime-mutable by design and leaves no diff anywhere, so it
 * additionally needs its own config id in the stamp: a version number alone cannot say which
 * promoted vector produced a row.
 *
 * Pure apart from reading the kill switch from `process.env` per call (never cached at module
 * scope), so a test can flip it between cases without a reset seam.
 */
import { createHash } from 'node:crypto';
import type { SignalVerdict } from '../types.js';
import {
  VERDICT_RULE_ASSIGNMENT, REGISTRY_TIMEFRAMES, TREND_REGIMES,
  type VerdictRuleAssignment, type RuleVariant, type RegistryTimeframe, type TrendRegime,
} from './verdict-rule-assignment.js';

/** M → 2 (the TREND_MODE=on generation it continues), F → 3. H serves HOLD, which no stamped table stores. */
export const VERDICT_RULE_VERSION = { M: 2, F: 3 } as const;
export type VerdictRuleVersion = (typeof VERDICT_RULE_VERSION)[keyof typeof VERDICT_RULE_VERSION];

export const KILL_SWITCH_ENV = 'VERDICT_RULE_FORCE_M';

/**
 * Whether a quarantined H-hold store exists. While false, a committed H is refused to M. The wave
 * that ships the store flips this — and owns H's persistence, which this wave deliberately does
 * not build (nothing is written to `hold_decisions` for an H-held call).
 */
export const H_HOLD_STORE_SHIPPED = false;

/** What the three writers persist for a row (ruling Q4 = A: all three take it per call). */
export interface VerdictRuleStamp {
  verdictRuleVersion: VerdictRuleVersion;
  ruleConfigId: string;
}

/** The forward test's capture, computed at call time from the verdicts the engine actually derived. */
export interface VerdictRuleCapture {
  trendDecisive: boolean;
  v1Signal: SignalVerdict;
  v1RawFinal: number;
  verdictM: SignalVerdict;
  verdictF: SignalVerdict;
  verdictH: SignalVerdict;
}

/**
 * The capture as persisted on the emitted arm's sibling row: the resolution's capture plus the
 * inputs that make the decisive flag re-checkable from stored parts (registration §3). `rsiValue`
 * is null when RSI was not computable and `fundingZ` when the z-score is below its sample floor —
 * on a post-registry row (non-null `rule_config_id`) a NULL there is a measurement, not a gap.
 */
export interface VerdictRuleCaptureRow extends VerdictRuleCapture {
  rsiValue: number | null;
  rsiScorePre: number;
  fundingZ: number | null;
}

export interface RegistryOptions {
  /** The assignment to resolve against. Absent ⇒ the committed `VERDICT_RULE_ASSIGNMENT`. */
  assignment?: VerdictRuleAssignment;
  /** Absent ⇒ `process.env`, read per call. */
  env?: NodeJS.ProcessEnv;
  /** Absent ⇒ `H_HOLD_STORE_SHIPPED`. */
  hHoldStore?: boolean;
}

export interface RuleVerdict {
  signal: SignalVerdict;
  rawScore: number;
  confidence: number;
}

export interface VerdictRuleInput {
  timeframe: string;
  regime: string | null | undefined;
  /** Today's rule — the engine's live verdict. */
  m: RuleVerdict;
  /** The same inputs with the RSI negation off (the would-be verdict; never served). */
  v1: { signal: SignalVerdict; rawScore: number };
}

export interface VerdictRuleResolution {
  /** The cell's effective assignment, or null when the call is not in a cell. */
  cellVariant: RuleVariant | null;
  /** Whose verdict is served: M unless a decisive call sits in a cell assigned F or H. */
  variant: RuleVariant;
  decisive: boolean;
  served: RuleVerdict;
  stamp: VerdictRuleStamp;
  capture: VerdictRuleCapture;
}

let testOverride: RegistryOptions | null = null;

/**
 * Test seam: options `getTradeSignal`'s argument-less call resolves against. Production never sets
 * it; explicit options passed to a function still win over it.
 */
export function _setRegistryOverrideForTest(o: RegistryOptions | null): void {
  testOverride = o;
}

function resolved(opts?: RegistryOptions): Required<RegistryOptions> {
  const o = { ...(testOverride ?? {}), ...(opts ?? {}) };
  return {
    assignment: o.assignment ?? VERDICT_RULE_ASSIGNMENT,
    env: o.env ?? process.env,
    hHoldStore: o.hHoldStore ?? H_HOLD_STORE_SHIPPED,
  };
}

/** Default-deny: only the exact string '1' engages the switch. */
export function killSwitchActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[KILL_SWITCH_ENV] === '1';
}

const refusedCellsLogged = new Set<string>();

export function _resetHRefusalStateForTest(): void {
  refusedCellsLogged.clear();
}

function refuseH(tf: RegistryTimeframe, regime: TrendRegime): void {
  const key = `${tf}|${regime}`;
  if (refusedCellsLogged.has(key)) return;
  refusedCellsLogged.add(key);
  console.error(
    `[verdict-rule-registry] CRITICAL: cell ${tf} ${regime} is assigned H, but no quarantined H-hold store has shipped ` +
    `(H_HOLD_STORE_SHIPPED=false; ruling Q3). REFUSED — the cell serves M. Operator action: remove the H from ` +
    `src/lib/verdict-rule-assignment.ts, or ship the H-hold store first.`,
  );
}

/** The assignment as served: the kill switch forces M everywhere; an un-storable H is refused to M. */
export function effectiveAssignment(opts?: RegistryOptions): VerdictRuleAssignment {
  const { assignment, env, hHoldStore } = resolved(opts);
  const force = killSwitchActive(env);
  const out = {} as Record<RegistryTimeframe, Record<TrendRegime, RuleVariant>>;
  for (const tf of REGISTRY_TIMEFRAMES) {
    out[tf] = {} as Record<TrendRegime, RuleVariant>;
    for (const regime of TREND_REGIMES) {
      let v: RuleVariant = assignment[tf][regime];
      if (force) v = 'M';
      else if (v === 'H' && !hHoldStore) { refuseH(tf, regime); v = 'M'; }
      out[tf][regime] = v;
    }
  }
  return out as VerdictRuleAssignment;
}

const configIdCache = new WeakMap<VerdictRuleAssignment, Map<string, string>>();

/**
 * sha256 of the committed assignment plus the kill-switch state (and the H-store declaration, which
 * also decides what an H cell serves). The canonical string iterates the REGISTERED order, never
 * object-key order, so the identity is not rented from how a literal happened to be written.
 */
export function ruleConfigId(opts?: RegistryOptions): string {
  const { assignment, env, hHoldStore } = resolved(opts);
  const flags = `${killSwitchActive(env) ? 1 : 0}|${hHoldStore ? 1 : 0}`;
  let byFlags = configIdCache.get(assignment);
  if (!byFlags) { byFlags = new Map(); configIdCache.set(assignment, byFlags); }
  const hit = byFlags.get(flags);
  if (hit) return hit;
  const cells = REGISTRY_TIMEFRAMES
    .map((tf) => `${tf}:${assignment[tf].TRENDING_UP}${assignment[tf].TRENDING_DOWN}`)
    .join(',');
  const [kill, hStore] = flags.split('|');
  const canonical = `verdict-rule-config/v1|cells=${cells}|kill_switch=${kill}|h_hold_store=${hStore}`;
  const id = createHash('sha256').update(canonical).digest('hex');
  byFlags.set(flags, id);
  return id;
}

function isCell(timeframe: string, regime: string | null | undefined): [RegistryTimeframe, TrendRegime] | null {
  if (!(REGISTRY_TIMEFRAMES as readonly string[]).includes(timeframe)) return null;
  if (regime == null || !(TREND_REGIMES as readonly string[]).includes(regime)) return null;
  return [timeframe as RegistryTimeframe, regime as TrendRegime];
}

function opposite(side: SignalVerdict): SignalVerdict {
  return side === 'BUY' ? 'SELL' : side === 'SELL' ? 'BUY' : 'HOLD';
}

/** Resolve one call. Called ONCE per verdict; every projection reads the returned value. */
export function resolveVerdictRule(input: VerdictRuleInput, opts?: RegistryOptions): VerdictRuleResolution {
  const cell = isCell(input.timeframe, input.regime);
  const cellVariant = cell ? effectiveAssignment(opts)[cell[0]][cell[1]] : null;
  const decisive = input.m.signal !== 'HOLD' && input.v1.signal !== input.m.signal;

  const verdictM = input.m.signal;
  const verdictF = decisive ? opposite(verdictM) : verdictM;
  const verdictH: SignalVerdict = decisive ? 'HOLD' : verdictM;

  const variant: RuleVariant = decisive && cellVariant !== null && cellVariant !== 'M' ? cellVariant : 'M';
  const served: RuleVerdict =
    variant === 'F'
      ? { signal: verdictF, rawScore: -input.m.rawScore, confidence: input.m.confidence }
      : variant === 'H'
        ? { signal: 'HOLD', rawScore: input.m.rawScore, confidence: input.m.confidence }
        : { signal: verdictM, rawScore: input.m.rawScore, confidence: input.m.confidence };

  return {
    cellVariant,
    variant,
    decisive,
    served,
    stamp: {
      verdictRuleVersion: variant === 'F' ? VERDICT_RULE_VERSION.F : VERDICT_RULE_VERSION.M,
      ruleConfigId: ruleConfigId(opts),
    },
    capture: {
      trendDecisive: decisive,
      v1Signal: input.v1.signal,
      v1RawFinal: input.v1.rawScore,
      verdictM,
      verdictF,
      verdictH,
    },
  };
}
