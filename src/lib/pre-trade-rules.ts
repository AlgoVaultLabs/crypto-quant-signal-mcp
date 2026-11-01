/**
 * pre-trade-rules.ts — DECISION-CALL-V2-W1 CH2. The `pre_trade_check` rules: ONE table, ONE evaluator.
 *
 * Every check the tool makes on an order is a row of `PRE_TRADE_RULES` — the metric it reads, how it
 * compares, its default and the bounds of the value a caller may send (`Prompt/pre-trade-check-contract-v2.md`
 * § Params). v1's three checks — funding, size, regime — are rows WITH defaults, and those defaults are v1's
 * own thresholds, which live here and nowhere else (`pre-trade-decision.ts` re-exports them). So a call that
 * sends no rules is judged exactly as v1 judged it; the other rows are the caller's to switch on.
 *
 *   active   every key the caller sends (source `yours`) and every default not switched off (source
 *            `default`). `false` switches a boolean default off; a number replaces a default and makes it
 *            `yours`; `true` on a boolean rule makes it `yours`.
 *   result   on one venue: pass · fail · not_evaluated (the metric is null — the detail names what to send,
 *            or what is missing).
 *
 * The evaluator is the ONLY place a rule compares. `decide` turns results into reasons and the handler shows
 * the same results as `rules[]`, so the row a caller reads and the reason that moved the decision can never
 * disagree.
 *
 * PURE, AND A LEAF: no I/O, and nothing here imports the decision engine or the handler (both import this).
 */
import type { PreTradeSide } from './pre-trade-costs.js';

// ── v1's thresholds: each lives once, here ──────────────────────────────────────────────────────

/** Funding at or above this many bps over the hold fails `maxFundingBps` (v1 HIGH_CARRY_BPS). */
export const DEFAULT_MAX_FUNDING_BPS = 10;
/** An order above this PERCENT of a venue's 24h volume fails `maxSizePctOf24hVolume` (v1's 0.1% size guard). */
export const DEFAULT_MAX_SIZE_PCT_OF_24H_VOLUME = 0.1;
/** A regime against the side fails `regimeCheck` from this confidence. */
export const REGIME_AGAINST_MIN_CONFIDENCE = 60;
/** VOLATILE fails `regimeCheck` from this confidence. */
export const VOLATILE_MIN_CONFIDENCE = 70;

// ── The table ───────────────────────────────────────────────────────────────────────────────────

type Comparator =
  | 'max'            // fails strictly above the limit
  | 'max_or_equal'   // fails at or above (v1's funding comparison)
  | 'min'            // fails strictly below
  | 'capacity'       // fails when the venue's capacity at the limit is below the order (v1's size comparison)
  | 'liq_before_stop' // fails when liquidation is at or inside the stop
  | 'regime';        // fails on a regime against the side, or VOLATILE, at v1's confidences

/** A caller input a rule needs before it can be checked (the detail tells the caller to send it). */
type CallerInput = 'leverage' | 'stop_pct' | 'equity_usd';
/** Data a rule needs that the caller cannot send. */
type DataInput = 'tier' | 'sigma' | 'regime';

const RULES = [
  { id: 'maxLeverage', metric: 'leverage', comparator: 'max', default: null, needs: ['leverage'], data: [],
    param: { type: 'number', minimum: 1, maximum: 200 } },
  { id: 'noLiqBeforeStop', metric: 'liq_before_stop', comparator: 'liq_before_stop', default: true, needs: ['leverage', 'stop_pct'], data: ['tier'],
    param: { type: 'boolean' } },
  { id: 'minLiqDistanceSigma', metric: 'liq_distance_sigma', comparator: 'min', default: null, needs: ['leverage'], data: ['tier', 'sigma'],
    param: { type: 'number', minimum: 0, maximum: 50 } },
  { id: 'maxLossAtStopPctEquity', metric: 'loss_at_stop_pct_equity', comparator: 'max', default: null, needs: ['stop_pct', 'equity_usd'], data: [],
    param: { type: 'number', minimum: 0, maximum: 100 } },
  { id: 'maxDailyMovePctEquity', metric: 'one_sigma_day_pct_equity', comparator: 'max', default: null, needs: ['equity_usd'], data: ['sigma'],
    param: { type: 'number', minimum: 0, maximum: 100 } },
  { id: 'maxRoundTripBps', metric: 'round_trip_bps', comparator: 'max', default: null, needs: [], data: [],
    param: { type: 'number', minimum: 0, maximum: 1000 } },
  { id: 'maxAccuracyNeededPct', metric: 'accuracy_needed_pct', comparator: 'max', default: null, needs: [], data: ['sigma'],
    param: { type: 'number', minimum: 50, maximum: 100 } },
  { id: 'maxFundingBps', metric: 'funding_cost_bps', comparator: 'max_or_equal', default: DEFAULT_MAX_FUNDING_BPS, needs: [], data: [],
    param: { type: 'number', minimum: 0, maximum: 10_000 } },
  { id: 'maxSizePctOf24hVolume', metric: 'size_pct_of_24h_volume', comparator: 'capacity', default: DEFAULT_MAX_SIZE_PCT_OF_24H_VOLUME, needs: [], data: [],
    param: { type: 'number', exclusiveMinimum: 0, maximum: 100 } },
  { id: 'regimeCheck', metric: 'regime', comparator: 'regime', default: true, needs: [], data: ['regime'],
    param: { type: 'boolean' } },
] as const;

export type PreTradeRuleId = (typeof RULES)[number]['id'];
type Metric = (typeof RULES)[number]['metric'];

export type PreTradeRuleParam =
  | { readonly type: 'number'; readonly minimum?: number; readonly exclusiveMinimum?: number; readonly maximum: number }
  | { readonly type: 'boolean' };

export interface PreTradeRuleRow {
  readonly id: PreTradeRuleId;
  readonly metric: Metric;
  readonly comparator: Comparator;
  /** The default limit; `true` for a boolean rule that is on by default; null for a rule the caller opts into. */
  readonly default: number | true | null;
  readonly needs: readonly CallerInput[];
  readonly data: readonly DataInput[];
  readonly param: PreTradeRuleParam;
}

/** The ten rules, in the contract's table order — the order `rules[]` is served in. Frozen, rows and all. */
export const PRE_TRADE_RULES: readonly PreTradeRuleRow[] = Object.freeze(
  RULES.map((r) => Object.freeze({ ...r, needs: Object.freeze([...r.needs]), data: Object.freeze([...r.data]), param: Object.freeze({ ...r.param }) })),
);

// ── What the caller sent, and what is active ────────────────────────────────────────────────────

/** The caller's `rules` object, parsed: each key optional; null reads as not sent. */
export type PreTradeRulesInput = Partial<Record<PreTradeRuleId, number | boolean>>;

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const RULE_BY_ID: ReadonlyMap<string, PreTradeRuleRow> = new Map(PRE_TRADE_RULES.map((r) => [r.id, r]));

function boundsText(p: Extract<PreTradeRuleParam, { type: 'number' }>): string {
  return p.exclusiveMinimum !== undefined
    ? `above ${p.exclusiveMinimum} and at most ${p.maximum}`
    : `between ${p.minimum} and ${p.maximum}`;
}

/**
 * Parse a caller's `rules` value against the table. The first problem names its own param — `rules`, or
 * `rules.<key>` for an unknown key or a value outside the key's type and bounds — for `invalid_parameter`.
 */
export function parseRules(raw: unknown):
  | { ok: true; rules: PreTradeRulesInput }
  | { ok: false; kind: 'not_object' | 'unknown_key' | 'bad_value'; param: string; message: string } {
  if (raw === undefined || raw === null) return { ok: true, rules: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, kind: 'not_object', param: 'rules', message: 'rules must be an object whose keys are rule names.' };
  }
  const rules: PreTradeRulesInput = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const row = RULE_BY_ID.get(key);
    if (!row) {
      return { ok: false, kind: 'unknown_key', param: `rules.${key}`, message: `rules.${key} is not a rule.` };
    }
    if (value === null || value === undefined) continue;
    const p = row.param;
    if (p.type === 'boolean') {
      if (typeof value !== 'boolean') return { ok: false, kind: 'bad_value', param: `rules.${key}`, message: `rules.${key} must be true or false.` };
    } else {
      const inBounds = isNum(value)
        && (p.exclusiveMinimum !== undefined ? value > p.exclusiveMinimum : value >= (p.minimum as number))
        && value <= p.maximum;
      if (!inBounds) return { ok: false, kind: 'bad_value', param: `rules.${key}`, message: `rules.${key} must be a number ${boundsText(p)}.` };
    }
    rules[row.id] = value as number | boolean;
  }
  return { ok: true, rules };
}

export interface PreTradeActiveRule {
  id: PreTradeRuleId;
  source: 'yours' | 'default';
  /** A number limit, or `true` for an on boolean rule. */
  limit: number | true;
}

/** Every key the caller sent (`yours`) and every default not switched off (`default`), in table order. */
export function activeRules(sent: PreTradeRulesInput = {}): PreTradeActiveRule[] {
  return PRE_TRADE_RULES.flatMap((row): PreTradeActiveRule[] => {
    const v = sent[row.id];
    if (v === undefined) return row.default === null ? [] : [{ id: row.id, source: 'default', limit: row.default }];
    if (v === false) return [];
    return [{ id: row.id, source: 'yours', limit: v }];
  });
}

/** The active limit of a number rule that always has one (a default the caller can only replace). */
export function activeLimit(active: readonly PreTradeActiveRule[], id: 'maxFundingBps' | 'maxSizePctOf24hVolume'): number {
  const rule = active.find((r) => r.id === id);
  return typeof rule?.limit === 'number' ? rule.limit : (RULE_BY_ID.get(id)?.default as number);
}

// ── Evaluation ──────────────────────────────────────────────────────────────────────────────────

/** Everything the rules read about one venue (or, with `exchange` null, about no venue). Null = unknown. */
export interface PreTradeRuleMetrics {
  exchange: string | null;
  side: PreTradeSide;
  sizeUsd: number;
  leverage: number | null;
  stop_pct: number | null;
  equity_usd: number | null;
  liq_distance_pct: number | null;
  liq_before_stop: boolean | null;
  liq_distance_sigma: number | null;
  loss_at_stop_pct_equity: number | null;
  one_sigma_day_pct_equity: number | null;
  round_trip_bps: number | null;
  accuracy_needed_pct: number | null;
  funding_cost_bps: number | null;
  size_pct_of_24h_volume: number | null;
  /** The venue's capacity at the ACTIVE size limit, to cents — the figure v1's size comparison reads. */
  capacity_usd: number | null;
  regime: { label: string; confidence: number; timeframe: string } | null;
  /** Why a figure is missing, for the detail: was fresh 1h volatility read, and the venue's liquidation basis. */
  sigma_available: boolean;
  liq_basis: string | null;
}

/** The reason a FAILED default rule emits — v1's code where v1 had the check. */
export type PreTradeDefaultFailCode = 'SIZE_ABOVE_VENUE_LIMIT' | 'FUNDING_COST_HIGH' | 'REGIME_AGAINST_SIDE' | 'REGIME_VOLATILE' | 'LIQUIDATION_BEFORE_STOP';

export interface PreTradeRuleResult {
  id: PreTradeRuleId;
  source: 'yours' | 'default';
  limit: number | boolean;
  value: number | boolean | string | null;
  result: 'pass' | 'fail' | 'not_evaluated';
  detail: string;
  /** Set on a failed rule: the reason a DEFAULT emits. Internal — never copied to the wire. */
  failCode: PreTradeDefaultFailCode | null;
}

const PARAM_NAME: Readonly<Record<CallerInput, string>> = { leverage: 'leverage', stop_pct: 'stopPct', equity_usd: 'equityUsd' };

const METRIC_TEXT: Readonly<Partial<Record<Metric, { label: string; unit: string }>>> = {
  leverage: { label: 'Leverage', unit: 'x' },
  liq_distance_sigma: { label: 'Liquidation distance', unit: ' hold-period sigmas' },
  loss_at_stop_pct_equity: { label: 'Loss at the stop', unit: '% of equity' },
  one_sigma_day_pct_equity: { label: 'A one-sigma day', unit: '% of equity' },
  round_trip_bps: { label: 'Round trip', unit: ' bps' },
  accuracy_needed_pct: { label: 'Accuracy needed to break even', unit: '%' },
  funding_cost_bps: { label: 'Funding over the hold', unit: ' bps' },
};

const BASIS_TEXT: Readonly<Record<string, string>> = {
  tier_table_requires_key: 'publishes its maintenance tiers only to account holders',
  tier_unavailable: 'has no readable maintenance tier for this order',
};

const usd = (x: number): string => `$${Math.round(x).toLocaleString('en-US')}`;

/** What is missing, in the order a caller can act on it: an input to send first, then data we lack. */
function notEvaluatedDetail(row: PreTradeRuleRow, m: PreTradeRuleMetrics): string {
  const missing = row.needs.filter((k) => m[k] === null).map((k) => PARAM_NAME[k]);
  if (missing.length) return `Send ${missing.join(' and ')} to check this rule.`;
  if (row.data.includes('regime') && m.regime === null) return 'No fresh market regime is available.';
  if (row.data.includes('sigma') && !m.sigma_available) return 'No fresh 1h volatility is available.';
  if (m.exchange === null) return 'No venue can take this order, so it was not checked.';
  if (row.data.includes('tier') && m.liq_distance_pct === null) {
    return `${m.exchange} ${BASIS_TEXT[m.liq_basis ?? 'tier_unavailable'] ?? BASIS_TEXT.tier_unavailable}.`;
  }
  return `Its figure is unavailable on ${m.exchange}.`;
}

function evaluateOne(row: PreTradeRuleRow, rule: PreTradeActiveRule, m: PreTradeRuleMetrics): PreTradeRuleResult {
  const base = { id: row.id, source: rule.source, limit: rule.limit };
  const notEvaluated = (value: PreTradeRuleResult['value'] = null): PreTradeRuleResult =>
    ({ ...base, value, result: 'not_evaluated', detail: notEvaluatedDetail(row, m), failCode: null });
  const judged = (value: PreTradeRuleResult['value'], fail: boolean, detail: string, failCode: PreTradeDefaultFailCode | null = null): PreTradeRuleResult =>
    ({ ...base, value, result: fail ? 'fail' : 'pass', detail, failCode: fail ? failCode : null });

  switch (row.comparator) {
    case 'max':
    case 'max_or_equal':
    case 'min': {
      const value = m[row.metric as keyof PreTradeRuleMetrics] as number | null;
      if (value === null) return notEvaluated();
      const limit = rule.limit as number;
      const { label, unit } = METRIC_TEXT[row.metric] as { label: string; unit: string };
      if (row.comparator === 'min') {
        const fail = value < limit;
        return judged(value, fail, `${label} ${value}${unit} is ${fail ? 'below' : 'at or above'} the minimum of ${limit}${unit}.`);
      }
      const fail = row.comparator === 'max_or_equal' ? value >= limit : value > limit;
      const over = row.comparator === 'max_or_equal' ? 'at or above' : 'above';
      const under = row.comparator === 'max_or_equal' ? 'below' : 'within';
      return judged(value, fail, `${label} ${value}${unit} is ${fail ? over : under} the limit of ${limit}${unit}.`, row.id === 'maxFundingBps' ? 'FUNDING_COST_HIGH' : null);
    }
    case 'capacity': {
      if (m.capacity_usd === null || m.size_pct_of_24h_volume === null) return notEvaluated();
      const fail = m.capacity_usd < m.sizeUsd;
      return judged(m.size_pct_of_24h_volume, fail,
        `The order is ${m.size_pct_of_24h_volume}% of 24h volume${fail ? ', above' : ', within'} the limit of ${rule.limit}% (${usd(m.capacity_usd)} on ${m.exchange}).`,
        'SIZE_ABOVE_VENUE_LIMIT');
    }
    case 'liq_before_stop': {
      if (m.liq_before_stop === null || m.liq_distance_pct === null || m.stop_pct === null) return notEvaluated();
      const fail = m.liq_before_stop;
      return judged(fail, fail,
        `Isolated liquidation at ${m.liq_distance_pct}% from entry is ${fail ? 'at or inside' : 'beyond'} the ${m.stop_pct}% stop.`,
        'LIQUIDATION_BEFORE_STOP');
    }
    case 'regime': {
      const r = m.regime;
      if (r === null) return notEvaluated();
      const against = (m.side === 'long' && r.label === 'TRENDING_DOWN') || (m.side === 'short' && r.label === 'TRENDING_UP');
      if (against && r.confidence >= REGIME_AGAINST_MIN_CONFIDENCE) {
        return judged(r.label, true, `The ${r.timeframe} regime is ${r.label} at confidence ${r.confidence}, against a ${m.side}.`, 'REGIME_AGAINST_SIDE');
      }
      if (r.label === 'VOLATILE' && r.confidence >= VOLATILE_MIN_CONFIDENCE) {
        return judged(r.label, true, `The ${r.timeframe} regime is VOLATILE at confidence ${r.confidence}.`, 'REGIME_VOLATILE');
      }
      return judged(r.label, false, `The ${r.timeframe} regime is ${r.label} at confidence ${r.confidence}.`);
    }
  }
}

/** Each active rule on one venue's metrics, in table order. */
export function evaluateRules(active: readonly PreTradeActiveRule[], metrics: PreTradeRuleMetrics): PreTradeRuleResult[] {
  return active.map((rule) => evaluateOne(RULE_BY_ID.get(rule.id) as PreTradeRuleRow, rule, metrics));
}
