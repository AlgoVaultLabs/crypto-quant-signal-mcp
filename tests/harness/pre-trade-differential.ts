/**
 * pre-trade-differential.ts — DECISION-CALL-V2-AUDIT-W1 R2.
 *
 * A seeded generator of v1-SHAPE `pre_trade_check` engine inputs (no leverage, stop, target, equity,
 * order type or rules) and a runner that pushes them through any engine exposing v1's `rankVenues` +
 * `decide`, projecting what the v2 contract says a no-input call must keep: decision, reasons, best
 * venue, candidate order, split, timing and the size limits ("A call with no v2 input decides exactly
 * as v1 did").
 *
 * The pinned fixture `tests/fixtures/pre-trade-differential-v1.json` was produced by running THIS
 * generator through the v1 engine at `53ee499` (the commit before DECISION-CALL-V2-W1) in a throwaway
 * worktree. `tests/unit/pre-trade-differential.test.ts` re-runs the generator at HEAD and asserts
 * case-by-case equality. The fixture also pins the sha256 of the generated INPUTS, so an edit to this
 * file fails DISTINCTLY (generator drift) rather than as an engine regression. The only honest repair
 * for generator drift is to regenerate at 53ee499 — never to re-pin at HEAD, which would turn the guard
 * into a snapshot of whatever HEAD does.
 *
 * Determinism: mulberry32 over 32-bit integer arithmetic; every magnitude is a uniform mantissa times an
 * exact power of ten (no Math.log / exp / pow), so each platform produces the same doubles.
 */
import { createHash } from 'node:crypto';
import type {
  DecideInput,
  DecideResult,
  RankVenuesInput,
  RegimeRead,
  VenueMarketInput,
  VenueRanking,
} from '../../src/lib/pre-trade-decision.js';

export const DIFFERENTIAL_BASE_SHA = '53ee499';
export const DIFFERENTIAL_SEED = 0x5eed2026;
export const DIFFERENTIAL_N = 1000;

/** The priced venues in the handler's order, with the base-tier taker fee their fee rows carry at 53ee499 and at HEAD. */
const PRICED: readonly { exchange: string; takerFeeBps: number }[] = [
  { exchange: 'BINANCE', takerFeeBps: 5 },
  { exchange: 'BYBIT', takerFeeBps: 5.5 },
  { exchange: 'OKX', takerFeeBps: 5 },
  { exchange: 'BITGET', takerFeeBps: 6 },
];
const COINS = ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP', 'ARB'] as const;
const TIMEFRAMES = ['1h', '4h', '1d'] as const;
const LABELS = ['TRENDING_UP', 'TRENDING_DOWN', 'RANGING', 'VOLATILE'] as const;
const HOLDS = [0.25, 0.5, 1, 2, 4, 6, 8, 12, 24, 36, 48, 72, 168, 240] as const;
const STALE_DATES = ['2025-12-31', '2026-06-01', '2026-07-15'] as const;
const BASE_NOW_MS = Date.parse('2026-10-30T12:00:00Z');
const H = 3_600_000;

/** Exact powers of ten (every value below 1e22 is an exact double). */
const POW10: number[] = [1];
for (let i = 1; i <= 16; i++) POW10.push(POW10[i - 1]! * 10);

/** mulberry32: a 32-bit seeded PRNG in integer arithmetic; uniform in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private readonly u: () => number;
  constructor(seed: number) {
    this.u = mulberry32(seed);
  }
  next(): number {
    return this.u();
  }
  chance(p: number): boolean {
    return this.u() < p;
  }
  /** An integer in [lo, hi], both inclusive. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.u() * (hi - lo + 1));
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.u() * xs.length)]!;
  }
  /** A mantissa in [1, 10) times 10^e for an integer e in [loExp, hiExp]: log-uniform without transcendentals. */
  magnitude(loExp: number, hiExp: number): number {
    const m = 1 + 9 * this.u();
    const e = this.int(loExp, hiExp);
    return e >= 0 ? m * POW10[e]! : m / POW10[-e]!;
  }
  /** Uniform in [lo, hi), rounded to `places` decimals. */
  real(lo: number, hi: number, places: number): number {
    const f = POW10[places]!;
    return Math.round((lo + (hi - lo) * this.u()) * f) / f;
  }
}

const round = (x: number, places: number): number => Math.round(x * POW10[places]!) / POW10[places]!;

/** One generated call: v1's `rankVenues` input and v1's `decide` input minus the ranking. */
export interface DifferentialCase {
  rank: RankVenuesInput;
  decide: Omit<DecideInput, 'ranking' | 'rules' | 'sizeMaxPct' | 'volatilityUnavailable' | 'liquidationUnavailable'>;
}

function venue(rng: Rng, exchange: string, takerFeeBps: number | null, nowMs: number, hourlyFunding: boolean): VenueMarketInput {
  const universeOk = rng.chance(0.92);
  const fundingFeedOk = rng.chance(0.92);
  let asset: VenueMarketInput['asset'] = null;
  if (rng.chance(0.85)) {
    const a: NonNullable<VenueMarketInput['asset']> = {
      liquidityUsd: round(rng.magnitude(4, 10), 2),
      volume24hUsd: rng.chance(0.06) ? null : round(rng.magnitude(5, 10), 2),
    };
    const q = rng.next();
    if (q < 0.35 && q >= 0.25) {
      a.bidPx = null;
      a.askPx = null;
    } else if (q >= 0.35) {
      const mid = rng.magnitude(-2, 4);
      const spreadBps = rng.magnitude(-1, 2);
      a.bidPx = round(mid * (1 - spreadBps / 20_000), 6);
      a.askPx = round(mid * (1 + spreadBps / 20_000), 6);
    }
    asset = a;
  }
  const funding: VenueMarketInput['funding'] = rng.chance(0.12)
    ? null
    : {
        rate: rng.chance(0.7) ? rng.real(-0.0005, 0.0005, 8) : rng.real(-0.005, 0.005, 8),
        intervalHours: hourlyFunding ? 1 : rng.pick([8, 8, 8, 4, 1]),
        intervalBasis: rng.chance(0.7) ? 'contract' : 'declared',
        nextFundingTime: rng.chance(0.1) ? null : nowMs + rng.int(-2 * H, 8 * H),
      };
  return {
    exchange,
    universeOk,
    fundingFeedOk,
    asset,
    funding,
    takerFeeBps: takerFeeBps !== null && rng.chance(0.06) ? null : takerFeeBps,
  };
}

function oneCase(rng: Rng): DifferentialCase {
  const nowMs = BASE_NOW_MS + rng.int(-30 * 24, 30 * 24) * H + rng.int(0, H - 1);
  const side = rng.chance(0.5) ? 'long' : 'short';
  const sizeUsd = round(rng.magnitude(2, 7), 2);
  const holdHours = rng.chance(0.7) ? rng.pick(HOLDS) : rng.real(0.1, 200, 2);
  const timeframe = rng.pick(TIMEFRAMES);
  const venues: VenueMarketInput[] = PRICED.map((p) => venue(rng, p.exchange, p.takerFeeBps, nowMs, false));
  if (rng.chance(0.1)) venues.push(venue(rng, 'HL', null, nowMs, true));
  const regime: RegimeRead | null = rng.chance(0.15)
    ? null
    : {
        label: rng.pick(LABELS),
        confidence: rng.int(0, 100),
        timeframe,
        asOfMs: nowMs - rng.int(0, 8 * H),
        sourceExchange: rng.pick(PRICED).exchange,
      };
  const staleFees: { exchange: string; verifiedAt: string }[] = [];
  if (!rng.chance(0.8)) {
    const picked = new Set<string>();
    for (let k = rng.int(1, 2); k > 0; k--) picked.add(rng.pick(PRICED).exchange);
    for (const exchange of picked) staleFees.push({ exchange, verifiedAt: rng.pick(STALE_DATES) });
  }
  return {
    rank: { venues, side, sizeUsd, holdHours, nowMs },
    decide: {
      coin: rng.pick(COINS),
      side,
      sizeUsd,
      holdHours,
      timeframe,
      nowMs,
      regime,
      underlyingClosed: rng.chance(0.08),
      staleFees,
    },
  };
}

/** `n` v1-shape cases from `seed` — the same seed and n always give the same cases. */
export function generateCases(seed: number = DIFFERENTIAL_SEED, n: number = DIFFERENTIAL_N): DifferentialCase[] {
  const rng = new Rng(seed);
  const out: DifferentialCase[] = [];
  for (let i = 0; i < n; i++) out.push(oneCase(rng));
  return out;
}

/** sha256 of the generated inputs — pinned in the fixture so generator drift fails as itself. */
export function inputsSha256(cases: readonly DifferentialCase[]): string {
  return createHash('sha256').update(JSON.stringify(cases)).digest('hex');
}

/** Anything exposing v1's two engine entry points — the v1 module at 53ee499 or HEAD's. */
export interface Engine {
  rankVenues: (input: RankVenuesInput) => VenueRanking;
  decide: (input: DecideInput) => DecideResult;
}

/** What a no-input call must keep, JSON-normalised (so −0, undefined and key order cannot differ between a run and the file). */
export interface Projection {
  decision: string;
  reasons: [code: string, severity: string, detail: string][];
  best: string | null;
  candidates: string[];
  venues: { exchange: string; excluded: string | null; estCostBps: number | null }[];
  sizeLimitUsd: number | null;
  sizeLimitUsdTotal: number | null;
  split: unknown;
  timing: unknown;
}

export function project(ranking: VenueRanking, result: DecideResult): Projection {
  return JSON.parse(
    JSON.stringify({
      decision: result.decision,
      reasons: result.reasons.map((r) => [r.code, r.severity, r.detail]),
      best: ranking.best?.exchange ?? null,
      candidates: ranking.candidates.map((c) => c.exchange),
      venues: ranking.venues.map((v) => ({ exchange: v.exchange, excluded: v.excluded, estCostBps: v.estCostBps })),
      sizeLimitUsd: ranking.sizeLimitUsd,
      sizeLimitUsdTotal: ranking.sizeLimitUsdTotal,
      split: ranking.split,
      timing: result.timing,
    }),
  ) as Projection;
}

export function runCases(engine: Engine, cases: readonly DifferentialCase[]): Projection[] {
  return cases.map((c) => {
    const ranking = engine.rankVenues(c.rank);
    return project(ranking, engine.decide({ ...c.decide, ranking }));
  });
}

export interface DifferentialFixture {
  base: string;
  seed: number;
  n: number;
  inputsSha256: string;
  cases: Projection[];
}

/** One case per line, so a diff of the fixture names the case that changed. */
export function serializeFixture(f: DifferentialFixture): string {
  const head = JSON.stringify({ base: f.base, seed: f.seed, n: f.n, inputsSha256: f.inputsSha256 }).slice(0, -1);
  return `${head},\n"cases":[\n${f.cases.map((c) => JSON.stringify(c)).join(',\n')}\n]}\n`;
}
