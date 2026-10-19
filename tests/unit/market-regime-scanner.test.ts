/**
 * SCAN-MARKET-REGIMES-W1-V2 CH2 — the read engine (`src/lib/market-regime-scanner.ts`), AC2.1.
 *
 * Every dependency is a seam (`RegimeScannerDeps`), so this suite runs with no DB and no network: the
 * generation is a fixture, and the lens / liquidity reads are spies. What it pins:
 *   • ONE generation per scan — the rows of `latestServableGeneration`'s bar, never another;
 *   • the staleness bound (factor × interval, default-deny env parse) as an OUTCOME, never a throw;
 *   • every filter, every order (NULL ages last), paging, `not_found`;
 *   • `underlying_session` recomputed at scan time from the stored class (frozen clock);
 *   • the allow-list — exact key set, zero forbidden keys, `funding_rate` only under a funding lens.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  scanMarketRegimes,
  toRegimeScanRow,
  regimeAgeBars,
  regimeIntervalMs,
  regimeSnapshotStaleFactor,
  DEFAULT_REGIME_SNAPSHOT_STALE_FACTOR,
  REGIME_SCAN_TOP_N_DEFAULT,
  type RegimeScannerDeps,
  type ScanMarketRegimesParams,
  type ScanMarketRegimesResult,
} from '../../src/lib/market-regime-scanner.js';
import type { RegimeSnapshotRow, ServableGeneration } from '../../src/lib/regime-snapshots.js';
import type { RankedAsset } from '../../src/lib/rank-metrics.js';

const H = 3_600_000;
/** 2026-10-17 is a SATURDAY: a US equity is CLOSED_WEEKEND at scan time whatever was stored. */
const BAR = Date.parse('2026-10-17T12:00:00.000Z');
const NOW = BAR + 10 * 60_000;

const FORBIDDEN_KEYS = /"(outcome_return_pct|outcome_price|price_at_signal|reasoning)"\s*:/;

function row(coin: string, over: Partial<RegimeSnapshotRow> = {}): RegimeSnapshotRow {
  return {
    exchange: 'BINANCE',
    timeframe: '1h',
    bar_close_ms: BAR,
    coin,
    regime: 'TRENDING_UP',
    confidence: 70,
    trend_strength: 'MODERATE',
    adx: 31.2,
    adx_slope: 0.8,
    volatility_ratio: 1.1,
    price_structure: 'HIGHER_HIGHS',
    asset_class: 'CRYPTO',
    underlying_session_at_compute: 'ALWAYS_OPEN',
    regime_since_ms: BAR - 2 * H,
    rule_version: 1,
    computed_at: BAR + 11 * 60_000,
    ...over,
  };
}

const ROWS: RegimeSnapshotRow[] = [
  row('BTC', { confidence: 82 }),
  row('ETH', { regime: 'TRENDING_DOWN', confidence: 64, regime_since_ms: BAR }),
  row('SOL', { regime: 'RANGING', confidence: 55, regime_since_ms: null }),
  row('DOGE', { regime: 'VOLATILE', confidence: 64, regime_since_ms: BAR - 9 * H }),
  row('TSLA', { asset_class: 'EQUITY', confidence: 77, underlying_session_at_compute: 'OPEN_REGULAR', regime_since_ms: BAR - H }),
  row('SAMSUNG', { asset_class: 'KR_EQUITY', confidence: 40 }),
  row('XAU', { asset_class: 'COMMODITY', regime: 'RANGING', confidence: 61 }),
  row('MYSTERY', { asset_class: 'UNKNOWN', confidence: 90, underlying_session_at_compute: 'UNKNOWN' }),
];

function gen(over: Partial<ServableGeneration> = {}): ServableGeneration {
  return {
    exchange: 'BINANCE', timeframe: '1h', bar_close_ms: BAR, disposition: 'PARTIAL',
    universe_n: 10, written_n: 8, too_new_n: 1, window_stale_n: 1, coverage: 8 / 9,
    tick_at: BAR + 11 * 60_000, finished_at: BAR + 13 * 60_000, ...over,
  };
}

interface Harness { deps: RegimeScannerDeps; reads: number[]; rankCalls: unknown[][]; floorCalls: unknown[][] }
function harness(opts: { generation?: ServableGeneration | null; rows?: RegimeSnapshotRow[]; ranked?: RankedAsset[]; floorKeeps?: string[] } = {}): Harness {
  const reads: number[] = [];
  const rankCalls: unknown[][] = [];
  const floorCalls: unknown[][] = [];
  const g = opts.generation === undefined ? gen() : opts.generation;
  return {
    reads, rankCalls, floorCalls,
    deps: {
      latestServableGeneration: async () => g,
      readGenerationRows: async (_ex, _tf, bar) => { reads.push(bar); return (opts.rows ?? ROWS).filter((r) => r.bar_close_ms === bar); },
      getRankedUniverse: (async (...args: unknown[]) => { rankCalls.push(args); return opts.ranked ?? []; }) as RegimeScannerDeps['getRankedUniverse'],
      applyLiquidityFloor: async (...args: unknown[]) => {
        floorCalls.push(args);
        const keep = new Set(opts.floorKeeps ?? []);
        return (args[1] as string[]).filter((c) => keep.has(c));
      },
      now: () => NOW,
    },
  };
}

const P = (over: Partial<ScanMarketRegimesParams> = {}): ScanMarketRegimesParams => ({ exchange: 'BINANCE', timeframe: '1h', ...over });

async function ok(params: ScanMarketRegimesParams, h: Harness = harness(), env: NodeJS.ProcessEnv = {}): Promise<ScanMarketRegimesResult> {
  const out = await scanMarketRegimes(params, h.deps, env);
  if (out.status !== 'ok') throw new Error(`expected ok, got ${out.status}`);
  return out.result;
}
const coins = (r: ScanMarketRegimesResult): string[] => r.regimes.map((x) => x.coin);

describe('one generation, and the staleness bound', () => {
  it('reads exactly the servable bar and stamps it as as_of', async () => {
    const h = harness();
    const r = await ok(P(), h);
    expect(h.reads).toEqual([BAR]);
    expect(r.as_of).toBe(new Date(BAR).toISOString());
    expect(r.computed_at).toBe(new Date(BAR + 13 * 60_000).toISOString());
    expect(r.generation).toEqual({ universe: 10, written: 8, too_new: 1, window_stale: 1, coverage_pct: 88.9 });
  });

  it('never blends bars: a row from another bar in the store is not served', async () => {
    const h = harness({ rows: [...ROWS, row('PEPE', { bar_close_ms: BAR - H, confidence: 99 })] });
    expect(coins(await ok(P(), h))).not.toContain('PEPE');
  });

  it('no servable generation → stale with as_of null (an outcome, not a throw)', async () => {
    const out = await scanMarketRegimes(P(), harness({ generation: null }).deps, {});
    expect(out).toEqual({ status: 'stale', as_of: null, max_age_ms: 2 * H });
  });

  it('a generation older than factor × interval is stale; inside the bound it serves', async () => {
    const old = harness({ generation: gen({ bar_close_ms: NOW - 2 * H - 1 }), rows: [] });
    const out = await scanMarketRegimes(P(), old.deps, {});
    expect(out.status).toBe('stale');
    expect(old.reads).toEqual([]); // refused before any row read
    const edge = harness({ generation: gen({ bar_close_ms: NOW - 2 * H }), rows: [] });
    expect((await scanMarketRegimes(P(), edge.deps, {})).status).toBe('ok');
    const widened = harness({ generation: gen({ bar_close_ms: NOW - 2 * H - 1 }), rows: [] });
    expect((await scanMarketRegimes(P(), widened.deps, { REGIME_SNAPSHOT_STALE_FACTOR: '3' })).status).toBe('ok');
  });

  it('REGIME_SNAPSHOT_STALE_FACTOR default-denies a malformed value', () => {
    for (const bad of ['', ' ', 'abc', '0', '0.5', '-2', 'NaN', 'Infinity']) {
      expect(regimeSnapshotStaleFactor({ REGIME_SNAPSHOT_STALE_FACTOR: bad }), bad).toBe(DEFAULT_REGIME_SNAPSHOT_STALE_FACTOR);
    }
    expect(regimeSnapshotStaleFactor({})).toBe(2);
    expect(regimeSnapshotStaleFactor({ REGIME_SNAPSHOT_STALE_FACTOR: '1.5' })).toBe(1.5);
  });

  it('intervals are the producer’s own table', () => {
    expect([regimeIntervalMs('1h'), regimeIntervalMs('4h'), regimeIntervalMs('1d')]).toEqual([H, 4 * H, 24 * H]);
  });
});

describe('filters', () => {
  it('regime is an OR filter', async () => {
    expect(coins(await ok(P({ regime: ['TRENDING_DOWN', 'VOLATILE'] }))).sort()).toEqual(['DOGE', 'ETH']);
  });

  it('minConfidence is inclusive', async () => {
    expect(coins(await ok(P({ minConfidence: 64 }))).sort()).toEqual(['BTC', 'DOGE', 'ETH', 'MYSTERY', 'TSLA']);
  });

  it('assetClass: tradfi = every non-crypto class, equity includes KR_EQUITY, UNKNOWN only under all', async () => {
    expect(coins(await ok(P({ assetClass: 'crypto' }))).sort()).toEqual(['BTC', 'DOGE', 'ETH', 'SOL']);
    expect(coins(await ok(P({ assetClass: 'tradfi' }))).sort()).toEqual(['SAMSUNG', 'TSLA', 'XAU']);
    expect(coins(await ok(P({ assetClass: 'equity' }))).sort()).toEqual(['SAMSUNG', 'TSLA']);
    expect(coins(await ok(P({ assetClass: 'commodity' })))).toEqual(['XAU']);
    expect(coins(await ok(P({ assetClass: 'fx' })))).toEqual([]);
    expect(coins(await ok(P({ assetClass: 'all' })))).toContain('MYSTERY');
    for (const c of ['crypto', 'tradfi', 'equity', 'commodity', 'index', 'fx', 'premarket'] as const) {
      expect(coins(await ok(P({ assetClass: c }))), c).not.toContain('MYSTERY');
    }
  });

  it('maxRegimeAgeBars keeps KNOWN ages ≤ n and excludes every NULL age', async () => {
    // BTC since BAR-2h → 3 bars · ETH since BAR → 1 · DOGE since BAR-9h → 10 · TSLA since BAR-1h → 2 · SOL null
    expect(coins(await ok(P({ maxRegimeAgeBars: 1 })))).toEqual(['ETH']);
    expect(coins(await ok(P({ maxRegimeAgeBars: 3 }))).sort()).toEqual(['BTC', 'ETH', 'MYSTERY', 'SAMSUNG', 'TSLA', 'XAU']);
    expect(coins(await ok(P({ maxRegimeAgeBars: 500 })))).not.toContain('SOL');
  });

  it('coins restricts the universe; unknown symbols land in not_found (case-insensitive, deduped)', async () => {
    const r = await ok(P({ coins: ['btc', 'BTC', ' eth ', 'NOPE', 'zzz'] }));
    expect(coins(r).sort()).toEqual(['BTC', 'ETH']);
    expect(r.not_found).toEqual(['NOPE', 'ZZZ']);
  });

  it('not_found is ABSENT without coins', async () => {
    expect('not_found' in (await ok(P()))).toBe(false);
  });

  it('minLiquidityUsd applies the shared floor over the candidates; omitted or 0 never reads it', async () => {
    const h = harness({ floorKeeps: ['BTC', 'ETH'] });
    expect(coins(await ok(P({ minLiquidityUsd: 5e8 }), h)).sort()).toEqual(['BTC', 'ETH']);
    expect(h.floorCalls).toHaveLength(1);
    expect(h.floorCalls[0][0]).toBe('BINANCE');
    expect(h.floorCalls[0][2]).toBe(5e8);
    const none = harness();
    await ok(P(), none);
    await ok(P({ minLiquidityUsd: 0 }), none);
    expect(none.floorCalls).toHaveLength(0);
  });
});

describe('lens universe + echo', () => {
  const FUNDING: RankedAsset[] = [
    { coin: 'ETH', rankBy: 'funding_negative', rank_value: -0.0004, funding_rate: -0.0004, funding_apr: -43.8 },
    { coin: 'BTC', rankBy: 'funding_negative', rank_value: -0.0001, funding_rate: -0.0001, funding_apr: -10.95 },
    { coin: 'NOT_IN_GEN', rankBy: 'funding_negative', rank_value: -0.0009, funding_rate: -0.0009, funding_apr: null },
  ];

  it('rankBy resolves aliases, defaults topN to 100, intersects with the generation and echoes the lens', async () => {
    const h = harness({ ranked: FUNDING });
    const r = await ok(P({ rankBy: 'nfr', oiChangeWindow: '4h', oiBasis: 'contracts' }), h);
    expect(h.rankCalls).toEqual([['BINANCE', 'funding_negative', REGIME_SCAN_TOP_N_DEFAULT, '1h', { oiChangeWindow: '4h', oiBasis: 'contracts' }]]);
    expect(coins(r)).toEqual(['BTC', 'ETH']); // confidence order; NOT_IN_GEN is outside the generation
    const eth = r.regimes.find((x) => x.coin === 'ETH')!;
    expect(eth.funding_rate).toBe(-0.0004);
    expect(eth.funding_apr).toBe(-43.8);
    expect(eth.rank_value).toBe(-0.0004);
  });

  it('sortBy rank follows the lens order', async () => {
    const r = await ok(P({ rankBy: 'funding_negative', sortBy: 'rank' }), harness({ ranked: FUNDING }));
    expect(coins(r)).toEqual(['ETH', 'BTC']);
  });

  it('a non-funding lens never emits funding_rate', async () => {
    const vol: RankedAsset[] = [{ coin: 'BTC', rankBy: 'volume', rank_value: 3e9, volume_24h: 3e9 }];
    const r = await ok(P({ rankBy: 'volume' }), harness({ ranked: vol }));
    expect(r.regimes[0]).toMatchObject({ coin: 'BTC', rank_value: 3e9, volume_24h: 3e9 });
    expect(JSON.stringify(r)).not.toMatch(/"funding_rate"\s*:/);
  });

  it('topN without rankBy selects by the oi lens and echoes nothing', async () => {
    const oi: RankedAsset[] = [{ coin: 'SOL', rankBy: 'oi', rank_value: 1e9 }, { coin: 'BTC', rankBy: 'oi', rank_value: 9e9 }];
    const h = harness({ ranked: oi });
    const r = await ok(P({ topN: 2 }), h);
    expect(h.rankCalls[0].slice(0, 3)).toEqual(['BINANCE', 'oi', 2]);
    expect(coins(r).sort()).toEqual(['BTC', 'SOL']);
    expect(r.regimes.every((x) => !('rank_value' in x))).toBe(true);
  });

  it('no lens and no topN never reads the lens universe', async () => {
    const h = harness();
    await ok(P(), h);
    expect(h.rankCalls).toHaveLength(0);
  });
});

describe('order + paging', () => {
  it('confidence desc, ties by coin', async () => {
    expect(coins(await ok(P()))).toEqual(['MYSTERY', 'BTC', 'TSLA', 'DOGE', 'ETH', 'XAU', 'SOL', 'SAMSUNG']);
  });

  it('regime_age: most recent entry first, NULL ages last', async () => {
    const r = await ok(P({ sortBy: 'regime_age' }));
    expect(coins(r)).toEqual(['ETH', 'TSLA', 'MYSTERY', 'BTC', 'XAU', 'SAMSUNG', 'DOGE', 'SOL']);
    expect(r.regimes.at(-1)!.regime_age_bars).toBeNull();
  });

  it('offset/limit page ONE ordering; matched counts the whole filter, returned the page', async () => {
    const r = await ok(P({ limit: 3, offset: 2 }));
    expect(coins(r)).toEqual(['TSLA', 'DOGE', 'ETH']);
    expect([r.matched, r.returned, r.offset]).toEqual([8, 3, 2]);
    const past = await ok(P({ offset: 50 }));
    expect([past.matched, past.returned]).toEqual([8, 0]);
  });
});

describe('rows — allow-list, ages, recomputed session', () => {
  it('the row key set is exactly the allow-list (no lens)', async () => {
    const r = await ok(P());
    for (const x of r.regimes) {
      expect(Object.keys(x)).toEqual([
        'coin', 'regime', 'confidence', 'trend_strength', 'adx', 'volatility_ratio', 'price_structure',
        'asset_class', 'underlying_session', 'regime_since', 'regime_age_bars',
      ]);
    }
    expect(JSON.stringify(r)).not.toMatch(FORBIDDEN_KEYS);
    const rowsText = JSON.stringify(r.regimes);
    for (const k of ['adx_slope', 'rule_version', 'computed_at', 'underlying_session_at_compute', 'price', 'funding_rate']) {
      expect(rowsText, k).not.toContain(`"${k}":`);
    }
  });

  it('underlying_session is recomputed at SCAN time, never the stored compute-time state', async () => {
    const r = await ok(P());
    const by = Object.fromEntries(r.regimes.map((x) => [x.coin, x.underlying_session]));
    expect(by.TSLA).toBe('CLOSED_WEEKEND'); // stored OPEN_REGULAR; the scan runs on a Saturday
    expect(by.BTC).toBe('ALWAYS_OPEN');
    expect(by.MYSTERY).toBe('UNKNOWN');
    const weekday = Date.parse('2026-10-19T15:00:00.000Z'); // Monday 11:00 New York
    const out = toRegimeScanRow(ROWS[4], BAR, H, weekday);
    expect(out.underlying_session).toBe('OPEN_REGULAR');
  });

  it('regime_since is ISO or null; regime_age_bars counts closed bars held, the as_of bar included', () => {
    expect(regimeAgeBars({ regime_since_ms: BAR }, BAR, H)).toBe(1);
    expect(regimeAgeBars({ regime_since_ms: BAR - 3 * H }, BAR, H)).toBe(4);
    expect(regimeAgeBars({ regime_since_ms: null }, BAR, H)).toBeNull();
    expect(toRegimeScanRow(ROWS[0], BAR, H, NOW).regime_since).toBe(new Date(BAR - 2 * H).toISOString());
    expect(toRegimeScanRow(ROWS[2], BAR, H, NOW).regime_since).toBeNull();
  });

  it('a lens echo is added only through the shared copy (never a spread of the ranked object)', () => {
    const ranked = { coin: 'BTC', rankBy: 'oi_change', rank_value: 4.2, oi_change_pct: 4.2, oi_change_window: '24h', extra: 'LEAK' } as unknown as RankedAsset;
    const out = toRegimeScanRow(ROWS[0], BAR, H, NOW, ranked) as unknown as Record<string, unknown>;
    expect(out.oi_change_pct).toBe(4.2);
    expect(out.extra).toBeUndefined();
    expect(out.rankBy).toBeUndefined();
  });

  it('the formatter copies fields by name — a wider stored row cannot leak', () => {
    const wide = { ...ROWS[0], outcome_return_pct: 9, reasoning: 'x', price: 1 } as unknown as RegimeSnapshotRow;
    expect(JSON.stringify(toRegimeScanRow(wide, BAR, H, NOW))).not.toMatch(/outcome_return_pct|reasoning|"price"/);
  });
});

describe('the clock is the injected one', () => {
  it('uses deps.now, not Date.now', async () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(0);
    try {
      expect((await scanMarketRegimes(P(), harness().deps, {})).status).toBe('ok');
    } finally {
      spy.mockRestore();
    }
  });
});
