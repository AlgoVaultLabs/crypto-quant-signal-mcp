/**
 * TRADE-CALL-ROUTING-RESOLVER-W1 R1 — pure market-route resolver.
 *
 * The resolver makes the composite trade call route deterministically by
 * parameters, so the engine is correct regardless of which tool the model picks
 * (single-derivation). This suite is the §AC truth table + a determinism
 * property. The resolver is pure/side-effect-free: equity-universe membership is
 * INJECTED as `inEquityUniverse` (resolved by the handler-side async check), and
 * it is consulted ONLY in the bare branch.
 */
import { describe, it, expect } from 'vitest';
import { resolveMarketRoute, venueDefault, type MarketRoute, type MarketRouteInput } from '../src/lib/market-route.js';

// The §AC truth table. `inEquityUniverse` is the injected membership the handler
// would resolve (only meaningful in the bare branch; n/a rows pass undefined).
const TRUTH_TABLE: Array<{
  name: string;
  input: MarketRouteInput;
  expected: MarketRoute;
}> = [
  {
    name: 'TSLA + BITGET + 1h → perp BITGET 1h (venue named wins)',
    input: { symbol: 'TSLA', exchange: 'BITGET', timeframe: '1h' },
    expected: { engine: 'perp', exchange: 'BITGET', timeframe: '1h' },
  },
  {
    name: 'TSLA bare (in universe) → equity 1d',
    input: { symbol: 'TSLA', inEquityUniverse: true },
    expected: { engine: 'equity', timeframe: '1d' },
  },
  {
    name: 'TSLA + 1h (no venue) → perp BINANCE 1h (timeframe named)',
    input: { symbol: 'TSLA', timeframe: '1h' },
    expected: { engine: 'perp', exchange: 'BINANCE', timeframe: '1h' },
  },
  {
    name: 'NVDA bare (in universe) → equity 1d',
    input: { symbol: 'NVDA', inEquityUniverse: true },
    expected: { engine: 'equity', timeframe: '1d' },
  },
  {
    name: 'BTC bare (not in universe) → perp BINANCE 15m',
    input: { symbol: 'BTC', inEquityUniverse: false },
    expected: { engine: 'perp', exchange: 'BINANCE', timeframe: '15m' },
  },
  {
    name: 'BTC + BYBIT + 5m → perp BYBIT 5m',
    input: { symbol: 'BTC', exchange: 'BYBIT', timeframe: '5m' },
    expected: { engine: 'perp', exchange: 'BYBIT', timeframe: '5m' },
  },
  {
    name: 'SPY bare (in universe) → equity 1d',
    input: { symbol: 'SPY', inEquityUniverse: true },
    expected: { engine: 'equity', timeframe: '1d' },
  },
  {
    name: "TSLA + assetClass=equity → equity 1d (forced)",
    input: { symbol: 'TSLA', assetClass: 'equity' },
    expected: { engine: 'equity', timeframe: '1d' },
  },
  {
    name: "TSLA + assetClass=perp → perp BINANCE 15m (forced)",
    input: { symbol: 'TSLA', assetClass: 'perp' },
    expected: { engine: 'perp', exchange: 'BINANCE', timeframe: '15m' },
  },
  {
    name: 'unknown ticker bare (not in universe) → perp BINANCE 15m (engine errors downstream)',
    input: { symbol: 'FOOBAR', inEquityUniverse: false },
    expected: { engine: 'perp', exchange: 'BINANCE', timeframe: '15m' },
  },
];

describe('resolveMarketRoute — §AC truth table', () => {
  it.each(TRUTH_TABLE)('$name', ({ input, expected }) => {
    expect(resolveMarketRoute(input)).toEqual(expected);
  });
});

describe('resolveMarketRoute — precedence + edge invariants', () => {
  it('assetClass=equity forces equity even when a venue is named', () => {
    expect(resolveMarketRoute({ symbol: 'TSLA', exchange: 'BITGET', timeframe: '1h', assetClass: 'equity' }))
      .toEqual({ engine: 'equity', timeframe: '1d' });
  });

  it('assetClass=perp forces perp even for an equity-universe symbol', () => {
    expect(resolveMarketRoute({ symbol: 'TSLA', assetClass: 'perp', inEquityUniverse: true }))
      .toEqual({ engine: 'perp', exchange: 'BINANCE', timeframe: '15m' });
  });

  it('assetClass=perp preserves a named venue + timeframe', () => {
    expect(resolveMarketRoute({ symbol: 'TSLA', assetClass: 'perp', exchange: 'BITGET', timeframe: '4h' }))
      .toEqual({ engine: 'perp', exchange: 'BITGET', timeframe: '4h' });
  });

  it('bare with membership UNRESOLVED (undefined) defaults to perp (fail-open to today\'s behavior)', () => {
    expect(resolveMarketRoute({ symbol: 'TSLA' }))
      .toEqual({ engine: 'perp', exchange: 'BINANCE', timeframe: '15m' });
  });

  it('venue named but no timeframe → perp on that venue at 15m default', () => {
    expect(resolveMarketRoute({ symbol: 'ETH', exchange: 'OKX' }))
      .toEqual({ engine: 'perp', exchange: 'OKX', timeframe: '15m' });
  });

  it('membership is IGNORED when a venue/timeframe/assetClass is present (lazy-resolution contract)', () => {
    // inEquityUniverse:true must NOT pull a venue-named call to equity.
    expect(resolveMarketRoute({ symbol: 'TSLA', exchange: 'BITGET', inEquityUniverse: true }))
      .toEqual({ engine: 'perp', exchange: 'BITGET', timeframe: '15m' });
  });

  it('equity routes never carry an exchange field', () => {
    const r = resolveMarketRoute({ symbol: 'AAPL', assetClass: 'equity' });
    expect(r.engine).toBe('equity');
    expect(r.exchange).toBeUndefined();
  });
});

describe('resolveMarketRoute — determinism', () => {
  it('identical input → identical route (referentially-stable, idempotent)', () => {
    for (const { input } of TRUTH_TABLE) {
      const a = resolveMarketRoute(input);
      const b = resolveMarketRoute(input);
      expect(a).toEqual(b);
    }
  });

  it('does not mutate its input', () => {
    const input: MarketRouteInput = { symbol: 'TSLA', exchange: 'BITGET', timeframe: '1h' };
    const snapshot = JSON.parse(JSON.stringify(input));
    resolveMarketRoute(input);
    expect(input).toEqual(snapshot);
  });
});

describe('venueDefault', () => {
  it('is BINANCE for every symbol — stock tickers included (no per-symbol special-casing)', () => {
    expect(venueDefault('BTC')).toBe('BINANCE');
    expect(venueDefault('TSLA')).toBe('BINANCE');
    expect(venueDefault('SPY')).toBe('BINANCE');
    expect(venueDefault('FOOBAR')).toBe('BINANCE');
  });
});
