/**
 * venue-margin-tiers.ts — DECISION-CALL-V2-W1 CH1.
 *
 * The maintenance-margin rate a venue charges an ISOLATED position of a given notional, read from the
 * venue's OWN published tier table — never a guess, never another venue's table. `pre_trade_check` turns it
 * into a liquidation distance (pre-trade-calc.ts), so where liquidation sits differs by venue exactly as the
 * venues' schedules do.
 *
 *   OKX     GET /api/v5/public/position-tiers (isolated, by instrument family) — bands in CONTRACTS, turned
 *           into USD by the instrument's `ctVal` (GET /api/v5/public/instruments) and the venue's own price
 *   Bitget  GET /api/v2/mix/market/query-position-lever — bands in USDT; its published liquidation formula
 *           adds the taker fee to the maintenance rate, so `liquidationMaintenanceRate` does too
 *   Bybit   GET /v5/market/risk-limit — `riskLimitValue` (USDT) is each band's upper edge
 *   Binance GET /fapi/v1/leverageBracket is USER_DATA (signed): `tier_table_requires_key`, zero requests
 *
 * ONE LOOKUP: `marginTierAt(exchange, coin, notionalUsd, refPx)`. Each read goes through the venue's own
 * adapter (`getMarginTiers`, structural and optional — never on `ExchangeAdapter`), so it inherits that
 * adapter's coin-to-symbol map, its throttle and the shared upstream budget, under whatever caller the
 * handler runs as. Tables are cached 24 h per (venue, coin) in a single-flight `coalescedCache`: N
 * concurrent callers share ONE read, a failed read is remembered for a jittered minute (and a table read
 * earlier keeps serving), and a cold read slower than `MARGIN_TIER_LOAD_TIMEOUT_MS` answers
 * `tier_unavailable` now while it finishes warming the cache.
 *
 * A BAND EDGE TAKES THE HIGHER RATE. At exactly a band's upper edge — and in a gap between one band's top
 * and the next band's bottom (OKX publishes 1000 then 1000.01 contracts) — the higher of the two rates
 * applies, so a liquidation distance is never overstated. A notional beyond the table has no published rate:
 * `tier_unavailable`.
 */
import { coalescedCache } from './coalesced-cache.js';
import { getAdapter } from './exchange-adapter.js';
import { takerFeeBps } from './venue-fees.js';
import type { ExchangeAdapter, ExchangeId } from '../types.js';

/** Where a venue row's liquidation figure comes from (the contract's `liq_basis`). */
export type LiqBasis = 'public_tier_table' | 'tier_table_requires_key' | 'tier_unavailable' | 'leverage_not_given';

/** One band: every notional up to `upTo` (in the table's unit) pays `rate` (a fraction, 0.004 = 0.4%). */
export interface MarginTierBand {
  upTo: number;
  rate: number;
}

/** A venue's table for one coin, ascending by `upTo`. `contractValue` is set only for a contract-unit table. */
export interface MarginTierTable {
  unit: 'usd' | 'contracts';
  /** Base-asset quantity per contract (OKX `ctVal`). */
  contractValue: number | null;
  bands: readonly MarginTierBand[];
}

/** The adapter capability this module reads. Structural and optional: an adapter without it has no public table. */
export interface MarginTierReader {
  getMarginTiers?: (coin: string) => Promise<MarginTierTable>;
}

interface TierSource {
  access: 'public' | 'requires_key';
  /** The venue's published isolated-liquidation formula adds its taker fee to the maintenance rate. */
  formulaAddsTakerFee: boolean;
}

/** The decision venues' tier sources. A venue absent here has no table we read: `tier_unavailable`. */
const TIER_SOURCES: Readonly<Partial<Record<ExchangeId, TierSource>>> = Object.freeze({
  BINANCE: Object.freeze({ access: 'requires_key', formulaAddsTakerFee: false }),
  BYBIT: Object.freeze({ access: 'public', formulaAddsTakerFee: false }),
  OKX: Object.freeze({ access: 'public', formulaAddsTakerFee: false }),
  BITGET: Object.freeze({ access: 'public', formulaAddsTakerFee: true }),
});

export const MARGIN_TIER_TTL_MS = 24 * 3_600_000;
/** A failed read is not retried for this long (± 20% jitter); a table read earlier keeps serving meanwhile. */
const MARGIN_TIER_NEGATIVE_TTL_MS = 60_000;
/** A cold read slower than this answers `tier_unavailable` now and keeps warming the cache. */
const MARGIN_TIER_LOAD_TIMEOUT_MS = 3_000;

const positive = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0;

/** A table is usable only when every band is a finite rate in [0, 1) under a strictly rising positive edge. */
function assertUsable(t: MarginTierTable, key: string): MarginTierTable {
  const bands = t?.bands;
  if (!Array.isArray(bands) || bands.length === 0) throw new Error(`${key}: empty tier table`);
  bands.forEach((b, i) => {
    if (!positive(b.upTo) || !(Number.isFinite(b.rate) && b.rate >= 0 && b.rate < 1)) throw new Error(`${key}: band ${i + 1} unreadable`);
    if (i > 0 && !(b.upTo > bands[i - 1].upTo)) throw new Error(`${key}: band ${i + 1} edge not above band ${i}`);
  });
  if (t.unit === 'contracts' && !positive(t.contractValue)) throw new Error(`${key}: contract value unreadable`);
  return t;
}

/**
 * The maintenance rate at `notionalUsd`: the band holding it, a band edge or a gap between bands taking the
 * higher rate. `refPx` converts USD to contracts for a contract-unit table. Null when the notional cannot be
 * placed (no usable price for a contract table, or beyond the last band).
 */
export function tierRateAt(table: MarginTierTable, notionalUsd: number, refPx: number | null): number | null {
  let size = notionalUsd;
  if (table.unit === 'contracts') {
    if (!positive(refPx) || !positive(table.contractValue)) return null;
    size = notionalUsd / (table.contractValue * refPx);
  }
  if (!positive(size)) return null;
  const { bands } = table;
  const i = bands.findIndex((b) => b.upTo >= size);
  if (i < 0) return null;
  const next = bands[i + 1];
  return bands[i].upTo === size && next ? Math.max(bands[i].rate, next.rate) : bands[i].rate;
}

/**
 * m for the liquidation formula: the tier rate, plus the taker fee where the venue's formula adds it. Rounded
 * once, to 1e-8, so the `maintenance_rate` a venue row shows is exactly the m its distance was computed from.
 */
export function liquidationMaintenanceRate(exchange: string, tierRate: number): number {
  const fee = TIER_SOURCES[exchange as ExchangeId]?.formulaAddsTakerFee ? takerFeeBps(exchange) : null;
  return Math.round((fee === null ? tierRate : tierRate + fee / 1e4) * 1e8) / 1e8 + 0;
}

export interface MarginTierRead {
  /** The published maintenance rate (no fee added), or null with any basis but `public_tier_table`. */
  rate: number | null;
  basis: Exclude<LiqBasis, 'leverage_not_given'>;
}

export interface MarginTierLookupDeps {
  /** The adapter for a venue — `getAdapter` in production, a counting fake in tests. */
  reader: (exchange: ExchangeId) => MarginTierReader;
  loadTimeoutMs?: number;
  now?: () => number;
}

export interface MarginTierLookup {
  marginTierAt: (exchange: string, coin: string, notionalUsd: number, refPx?: number | null) => Promise<MarginTierRead>;
  _clear: () => void;
}

export function createMarginTierLookup(deps: MarginTierLookupDeps): MarginTierLookup {
  const cache = coalescedCache<MarginTierTable | null>({
    load: async (key) => {
      const [exchange, coin] = key.split(':');
      const adapter = deps.reader(exchange as ExchangeId);
      try {
        // Called as a method, never detached: a wrapped adapter's `this` must survive.
        if (typeof adapter.getMarginTiers !== 'function') throw new Error(`${exchange} adapter reads no tier table`);
        return assertUsable(await adapter.getMarginTiers(coin), key);
      } catch (err) {
        console.warn(`[venue-margin-tiers] ${key} tier read failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    },
    ttlMs: MARGIN_TIER_TTL_MS,
    negativeTtlMs: MARGIN_TIER_NEGATIVE_TTL_MS,
    staleOk: true,
    fallback: () => null,
    loadTimeoutMs: deps.loadTimeoutMs ?? MARGIN_TIER_LOAD_TIMEOUT_MS,
    now: deps.now,
  });
  return {
    async marginTierAt(exchange, coin, notionalUsd, refPx = null) {
      const source = TIER_SOURCES[exchange as ExchangeId];
      if (!source) return { rate: null, basis: 'tier_unavailable' };
      if (source.access === 'requires_key') return { rate: null, basis: 'tier_table_requires_key' };
      let table: MarginTierTable | null;
      try {
        table = await cache.get(`${exchange}:${coin}`);
      } catch {
        table = null; // the cache serves its fallback; a throw here would be a cache defect, answered the same way
      }
      const rate = table ? tierRateAt(table, notionalUsd, refPx) : null;
      return rate === null ? { rate: null, basis: 'tier_unavailable' } : { rate, basis: 'public_tier_table' };
    },
    _clear: () => cache._clear(),
  };
}

const DEFAULT_LOOKUP = createMarginTierLookup({ reader: (exchange) => getAdapter(exchange) as ExchangeAdapter & MarginTierReader });

/** The ONE tier lookup `pre_trade_check` reads. */
export const marginTierAt = DEFAULT_LOOKUP.marginTierAt;

/** Test-only: empty the production cache. */
export function _resetMarginTierCacheForTest(): void {
  DEFAULT_LOOKUP._clear();
}
