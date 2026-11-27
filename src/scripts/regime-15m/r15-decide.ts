// regime-15m/r15-decide.ts — EDGE-REGIME-15M-BACKTEST-W1, items 4–5: Bar A, its three states, and the readout's
// component-map rows.
//
// Bar A (Mr.1, 2026-11-27), on the comparison rows, both arms from one resample of the coin × UTC-day clusters,
// bounds one-sided at ALPHA:
//   A4: LB(A4₁₅ₘ − A4₁ₕ) > −δ_A4, δ_A4 = 0.5 × (A4₁ₕ − max(50 %, always-up₁ₕ))
//   Δ1: LB(Δ1₁₅ₘ − Δ1₁ₕ) > −δ_Δ1, δ_Δ1 = 0.5 × Δ1₁ₕ
//   flip-flops: 15m's rate ≤ the highest of 1h's, 4h's and 1d's
// PASS = all three hold. FAIL = any fails, with parity green. INDETERMINATE = any of: parity red; δ_A4 ≤ 0 or
// δ_Δ1 ≤ 0 (NOT_IDENTIFIABLE); a timeframe under the floor; a non-finite input or result; a throw. INDETERMINATE is
// never FAIL. The δs are read from the 1h point estimates on the same rows.
import type { Pre, Measures, TfMeasures } from './r15-stats.js';
import { MUTATE, RETENTION } from './r15-spec.js';

export type State = 'PASS' | 'FAIL' | 'INDETERMINATE';
export const CAUSES = Object.freeze(['parity', 'not_identifiable', 'floor', 'non_finite', 'throw'] as const);
export type Cause = (typeof CAUSES)[number];

export interface Criterion {
  id: 'A4' | 'D1' | 'FF';
  /** The 15m − 1h difference (A4, Δ1, pp) or 15m's flip-flop rate per 1,000 bars (FF). */
  estimate: number;
  /** The one-sided lower bound of the difference (A4, Δ1); null for FF. */
  lb: number | null;
  /** δ (A4, Δ1), or the highest of 1h, 4h and 1d (FF): what the criterion is judged against. */
  margin: number;
  /** The 1h edge δ is half of (A4, Δ1); null for FF. */
  reference: number | null;
  holds: boolean;
  /** The interval's lower half is at least δ wide, so an arm equal to 1h would fail too. Never a state: a FAIL whose every failing criterion carries it reads `FAIL (underpowered)`. */
  underpowered: boolean | null;
}
export interface MapRow { slice: string; dial: string; criterion: Criterion['id']; state: 'works' | 'broken' | 'too little data' }
export interface Decision { state: State; causes: Cause[]; criteria: Criterion[]; map: MapRow[]; line: string }

const tf = (m: Measures, k: string): TfMeasures => {
  const t = m.tfs.find((x) => x.tf === k);
  if (!t) throw new Error(`regime-15m: no ${k} measures`);
  return t;
};
const finite = (...xs: Array<number | null | undefined>): boolean => xs.every((x) => typeof x === 'number' && Number.isFinite(x));

/**
 * The token line: `REGIME_15M_BACKTEST=PASS`, `=FAIL`, `=FAIL (underpowered)` or `=INDETERMINATE (<cause>[, <cause>])`.
 * `underpowered` annotates a FAIL only (the lead's rulings of 2026-11-27: option (a), then R2-F1): a FAIL whose every
 * failing criterion's interval could not resolve its δ — PROCEDURE §6's null rule, reported. It is never a state.
 */
export const lineOf = (state: State, causes: readonly Cause[], underpowered = false): string =>
  `REGIME_15M_BACKTEST=${state}${state === 'INDETERMINATE' ? ` (${causes.join(', ')})` : state === 'FAIL' && underpowered ? ' (underpowered)' : ''}`;

/**
 * Bar A on one run's measures. `parity` is null on a check row (only the Binance read has a parity reference).
 * The floor is read from `pre`, which was written before any outcome.
 */
export function decide(m: Measures, pre: Pre, parity: boolean | null): Decision {
  const h = tf(m, '1h'), q = tf(m, '15m');
  const sign = MUTATE === 'sign' ? 1 : -1;
  // δ_A4 = 0.5 × (A − max(50, p_K)) = 0.5 × min(A − 50, A − p_K): the 1h arm's excess over its stronger fixed baseline
  const refA4 = Math.min(h.a4.excess.coin.point, h.a4.excess.always_up.point), dA4 = RETENTION * refA4;
  const refD1 = h.d1.delta1.point, dD1 = RETENTION * refD1;
  const ffRef = Math.max(tf(m, '1h').flip_flops.per_1000, tf(m, '4h').flip_flops.per_1000, tf(m, '1d').flip_flops.per_1000);
  const criteria: Criterion[] = [
    { id: 'A4', estimate: m.a4_pair.theta.point, lb: m.a4_pair.theta.lb, margin: dA4, reference: refA4, holds: m.a4_pair.theta.lb > sign * dA4, underpowered: m.a4_pair.theta.point - m.a4_pair.theta.lb >= dA4 },
    { id: 'D1', estimate: m.d1_pair.theta.point, lb: m.d1_pair.theta.lb, margin: dD1, reference: refD1, holds: m.d1_pair.theta.lb > sign * dD1, underpowered: m.d1_pair.theta.point - m.d1_pair.theta.lb >= dD1 },
    { id: 'FF', estimate: q.flip_flops.per_1000, lb: null, margin: ffRef, reference: null, holds: q.flip_flops.per_1000 <= ffRef, underpowered: null },
  ];
  const causes = new Set<Cause>();
  if (parity === false) causes.add('parity');
  if (finite(dA4, dD1) && (dA4 <= 0 || dD1 <= 0)) causes.add('not_identifiable');
  if (!pre.floor_ok) causes.add('floor');
  // every value read, before any min or max: Math.min(+∞, x) is x, so a derived value alone would hide a +∞ input
  const inputs = [dA4, dD1, refA4, refD1, ffRef, h.a4.excess.coin.point, h.a4.excess.always_up.point,
    m.a4_pair.theta.point, m.a4_pair.theta.lb, m.d1_pair.theta.point, m.d1_pair.theta.lb, q.flip_flops.per_1000,
    ...['1h', '4h', '1d'].map((k) => tf(m, k).flip_flops.per_1000), pre.F, ...pre.tfs.flatMap((t) => [t.a4_eff, t.d1_eff, t.ff_coin_days])];
  if (!finite(...inputs)) causes.add('non_finite');
  const ordered = CAUSES.filter((c) => causes.has(c));
  const state: State = ordered.length ? 'INDETERMINATE' : criteria.every((c) => c.holds) ? 'PASS' : 'FAIL';
  // "could not tell" only when no failure was resolved: flip-flops carry no interval (null), so a flip-flop failure blocks it
  const failing = criteria.filter((c) => !c.holds);
  const blind = state === 'FAIL' && failing.length > 0 && failing.every((c) => c.underpowered === true);
  return { state, causes: ordered, criteria, map: mapOf(criteria, pre, causes), line: lineOf(state, ordered, blind) };
}

/** The component map (PROCEDURE §4d): one row per criterion, each read on its own floor and its own δ. */
function mapOf(criteria: readonly Criterion[], pre: Pre, causes: ReadonlySet<Cause>): MapRow[] {
  const pt = (k: string) => pre.tfs.find((t) => t.tf === k);
  const floorOk = (keys: string[], field: 'a4_eff' | 'd1_eff' | 'ff_coin_days'): boolean => keys.every((k) => { const v = pt(k)?.[field]; return typeof v === 'number' && Number.isFinite(v) && v >= pre.F; });
  const row = (slice: string, dial: string, c: Criterion, floor: boolean, identifiable: boolean): MapRow => ({
    slice, dial, criterion: c.id,
    state: !floor || !identifiable || causes.has('non_finite') || !finite(c.estimate, c.margin, c.lb ?? 0) ? 'too little data' : c.holds ? 'works' : 'broken',
  });
  const [a4, d1, ff] = criteria;
  return [
    row('15m TRENDING edge: TRENDING 15m rows at confidence ≥ 60', 'REGIME_AGAINST_MIN_CONFIDENCE', d1, floorOk(['15m', '1h'], 'd1_eff'), d1.margin > 0),
    row('15m direction: TRENDING 15m rows with a dated key-A phase', 'REGIME_15M_WINDOW_BARS', a4, floorOk(['15m', '1h'], 'a4_eff'), a4.margin > 0),
    row('15m stability: the 15m per-closed-bar series', 'REGIME_15M_WINDOW_BARS', ff, floorOk(['15m', '1h', '4h', '1d'], 'ff_coin_days'), true),
  ];
}

/** A run that threw after its seal: INDETERMINATE (throw), with no criterion read. */
export const thrown = (): Pick<Decision, 'state' | 'causes' | 'line'> => ({ state: 'INDETERMINATE', causes: ['throw'], line: lineOf('INDETERMINATE', ['throw']) });
