// OPS-PERFSTATS-SWR-W1 — a deterministic, production-shaped `aggregateSignalsSql` result.
//
// Shape measured on signal-1 2026-11-20: 85,036 groups over 2,836 coins, 15 exchanges, 11 timeframes,
// BUY/SELL/HOLD. One group per (exchange, coin, timeframe, signal) — the SQL GROUP BY key. Ties in
// (max_ca, max_id) are seeded on purpose so the recency order is exercised, not assumed.
import type { PeriodRow, StatGroupRow } from '../../src/lib/performance-db.js';

/** mulberry32 — a tiny seeded PRNG, so the fixture is byte-stable across machines and runs. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const FIXTURE_EXCHANGES = ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE', 'MEXC', 'KUCOIN', 'HTX', 'BINGX', 'PHEMEX', 'WHITEBIT', 'ASTER', 'LIGHTER', 'COINBASE'];
export const FIXTURE_TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d'];

export function productionShapedGroups(opts: { seed?: number; coins?: number; target?: number } = {}): { groups: StatGroupRow[]; period: PeriodRow } {
  const rnd = prng(opts.seed ?? 20261120);
  const nCoins = opts.coins ?? 2836;
  const target = opts.target ?? 85036;
  // A few majors, then synthetic tickers; majors exercise the tier classifier's named paths.
  const majors = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'ADA', 'AVAX', 'LINK', 'SUI'];
  const coins = Array.from({ length: nCoins }, (_, i) => (i < majors.length ? majors[i] : `C${i.toString(36).toUpperCase()}`));
  const signals = ['BUY', 'SELL', 'HOLD'] as const;
  const seen = new Set<string>();
  const groups: StatGroupRow[] = [];
  let guard = 0;
  while (groups.length < target && guard++ < target * 20) {
    const coin = coins[Math.floor(Math.pow(rnd(), 1.6) * nCoins)];           // skewed: low indices are busier
    const exchange = FIXTURE_EXCHANGES[Math.floor(rnd() * FIXTURE_EXCHANGES.length)];
    const timeframe = FIXTURE_TIMEFRAMES[Math.floor(rnd() * FIXTURE_TIMEFRAMES.length)];
    const signal = signals[Math.floor(rnd() * signals.length)];
    const key = `${exchange}|${coin}|${timeframe}|${signal}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cnt = 1 + Math.floor(rnd() * 400);
    const pfe_eval = signal === 'HOLD' ? 0 : Math.floor(cnt * rnd());
    const pfe_win = Math.floor(pfe_eval * rnd());
    const evaluated_n = Math.min(cnt, pfe_eval + Math.floor(rnd() * 5));
    const max_ca = 1_760_000_000 + Math.floor(rnd() * 400) * 3600;            // coarse → many max_ca ties
    const max_id = 1 + Math.floor(rnd() * 1_500_000);
    groups.push({ exchange, coin, timeframe, signal, cnt, pfe_eval, pfe_win, evaluated_n, max_ca, max_id });
  }
  const total = groups.reduce((a, g) => a + g.cnt, 0);
  return { groups, period: { min_created_at: 1_760_000_000, max_created_at: 1_761_440_000, total } };
}
