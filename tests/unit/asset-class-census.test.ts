/**
 * OPS-ASSET-CLASS-TOTALITY-W1 — the engine over the LIVE census (CH1.10) and the daily check's
 * verdict (CH3 AC). The corpus is `tests/fixtures/asset-class-census.json`: every listed USDT perp on
 * every active field venue, as `[native, tag]`, written by
 * `node dist/scripts/asset-class-totality.js --census` (refresh it with that command).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAssetClassSnapshot,
  assetClassIn,
  venueRecord,
  type VenueRecord,
} from '../../src/lib/asset-class-detection.js';
import {
  ASSET_CLASS_TAXONOMY,
  VENUE_TAG_CLASS,
  type AssetClass,
  type FieldVenue,
} from '../../src/lib/market-sessions-constants.js';
import { evaluateTotality, type PerformancePublicTiers } from '../../src/scripts/asset-class-totality.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CENSUS = JSON.parse(readFileSync(join(HERE, '..', 'fixtures', 'asset-class-census.json'), 'utf8')) as {
  generated_at: string;
  skipped_retired: string[];
  venues: Partial<Record<FieldVenue, Array<[string, string]>>>;
};

function records(extra: Partial<Record<FieldVenue, Array<[string, string]>>> = {}): Partial<Record<FieldVenue, VenueRecord[]>> {
  const out: Partial<Record<FieldVenue, VenueRecord[]>> = {};
  for (const v of Object.keys(CENSUS.venues) as FieldVenue[]) {
    out[v] = [...CENSUS.venues[v]!, ...(extra[v] ?? [])].map(([n, t]) => venueRecord(v, n, t));
  }
  return out;
}
const SNAP = buildAssetClassSnapshot(records());
const cls = (coin: string, venue?: string) => assetClassIn(SNAP, coin, venue as FieldVenue | undefined);
const family = (c: AssetClass | null) => (c ? ASSET_CLASS_TAXONOMY[c].family : null);
const rowsWithTag = (v: FieldVenue, tags: readonly string[]) => (CENSUS.venues[v] ?? []).filter(([, t]) => tags.includes(t));
const bareOf = (v: FieldVenue, native: string) => venueRecord(v, native, '').bare;

describe('the census itself', () => {
  it('covers every active field venue; retired venues are skipped, not failed', () => {
    expect(Object.keys(CENSUS.venues).sort()).toEqual(['BINANCE', 'BINGX', 'BITGET', 'BYBIT', 'GATE', 'HL', 'MEXC', 'OKX', 'WHITEBIT']);
    expect(CENSUS.skipped_retired.sort()).toEqual(['BITMART', 'EDGEX']);
  });

  it('AC: lost 0 · field-venue collisions 0 · unmapped 0 — every venue', () => {
    const L = SNAP.ledger;
    expect(L.failed).toEqual([]);
    expect(L.unmapped).toEqual([]);
    expect(L.collisions).toEqual([]);
    expect(L.lost).toEqual([]);
    for (const [v, x] of Object.entries(L.venues)) {
      expect(x.tradfi + x.crypto, v).toBeGreaterThan(0);
      expect({ v, lost: x.lost, collisions: x.collisions }).toEqual({ v, lost: 0, collisions: 0 });
    }
  });
});

describe('CH1.10 — every perp lands in its class, from its own venue’s record', () => {
  it('E1: Binance’s 18 HK_EQUITY / CN_EQUITY / FX contracts resolve to their class (were UNKNOWN)', () => {
    const rows = rowsWithTag('BINANCE', ['HK_EQUITY', 'CN_EQUITY', 'FX']);
    expect(rows).toHaveLength(18);
    for (const [native, tag] of rows) expect(cls(bareOf('BINANCE', native), 'BINANCE'), native).toBe(tag);
    for (const [coin, c] of [['HK0700', 'HK_EQUITY'], ['TENCENT', 'HK_EQUITY'], ['BYD', 'HK_EQUITY'], ['USDBRL', 'FX'], ['CXMT', 'CN_EQUITY']] as const) {
      expect(cls(coin, 'BINANCE'), coin).toBe(c);
    }
  });

  it('Bybit ETF → the EQUITY family; Bybit forex → FX', () => {
    const etf = rowsWithTag('BYBIT', ['ETF']);
    expect(etf.length).toBeGreaterThanOrEqual(50);
    for (const [n] of etf) expect(family(cls(bareOf('BYBIT', n), 'BYBIT')), n).toBe('EQUITY');
    const fx = rowsWithTag('BYBIT', ['forex']);
    expect(fx.map(([n]) => n).sort()).toEqual(['EURUSDUSDT', 'GBPUSDUSDT', 'USDJPYUSDT']);
    for (const [n] of fx) expect(cls(bareOf('BYBIT', n), 'BYBIT'), n).toBe('FX');
  });

  it('OKX: instCategory 3 → EQUITY family, 4 → COMMODITY, ruleType pre_market → PREMARKET', () => {
    for (const [n] of rowsWithTag('OKX', ['3'])) expect(family(cls(bareOf('OKX', n), 'OKX')), n).toBe('EQUITY');
    const c4 = rowsWithTag('OKX', ['4']);
    expect(c4.map(([n]) => bareOf('OKX', n)).sort()).toEqual(['BZ', 'CL', 'H100', 'NG', 'XAG', 'XAU', 'XCU', 'XPD', 'XPT']);
    for (const [n] of c4) expect(cls(bareOf('OKX', n), 'OKX'), n).toBe('COMMODITY');
    const pm = rowsWithTag('OKX', ['pre_market']).map(([n]) => bareOf('OKX', n)).sort();
    expect(pm).toEqual(['ANTHROPIC', 'MOONSHOT', 'OPENAI', 'OURA']);
    for (const c of pm) expect(cls(c, 'OKX'), c).toBe('PREMARKET');
    expect(cls('BTC', 'OKX')).toBe('CRYPTO');
  });

  it('Bitget isRwa refines: XAU COMMODITY · USDJPY FX · TENCENT(HKD) HK_EQUITY · OPENAI PREMARKET', () => {
    expect(cls('XAU', 'BITGET')).toBe('COMMODITY');
    expect(cls('USDJPY', 'BITGET')).toBe('FX');
    expect(cls('TENCENTHKD', 'BITGET')).toBe('HK_EQUITY');
    expect(cls('OPENAI', 'BITGET')).toBe('PREMARKET');
    expect(cls('CVXSTOCK', 'BITGET')).toBe('EQUITY');
  });

  it('E5 coins are crypto wherever their own venue lists them as crypto', () => {
    for (const coin of ['CVX', 'STX', 'QNT', 'T', 'BB', 'DIA', 'FORM', 'C', 'ON']) {
      for (const v of Object.keys(CENSUS.venues) as FieldVenue[]) {
        const own = SNAP.byBare.get(v)?.get(coin);
        if (own?.flag === 'CRYPTO') expect(cls(coin, v), `${coin}@${v}`).toBe('CRYPTO');
      }
    }
    expect(cls('CVX', 'BINANCE')).toBe('CRYPTO');
    expect(cls('STX', 'BINANCE')).toBe('CRYPTO');
  });

  it('…and a stock where their own venue lists them as a stock (BB: OKX EQUITY, BINANCE CRYPTO)', () => {
    expect(cls('BB', 'OKX')).toBe('EQUITY');
    expect(cls('BB', 'BINANCE')).toBe('CRYPTO');
    for (const [coin, v] of [['QNT', 'OKX'], ['ON', 'OKX'], ['ON', 'BYBIT'], ['BB', 'HL']] as const) {
      expect(family(cls(coin, v)), `${coin}@${v}`).toBe('EQUITY');
    }
    expect(cls('PURR', 'HL')).toBe('CRYPTO');
    expect(family(cls('PURR', 'OKX'))).toBe('EQUITY');
  });

  it('an injected unknown tag (JP_EQUITY) lands by TAG_PATTERNS and in the ledger', () => {
    const snap = buildAssetClassSnapshot(records({ BINANCE: [['TOYOTAUSDT', 'JP_EQUITY']] }));
    expect(assetClassIn(snap, 'TOYOTA', 'BINANCE')).toBe('EQUITY');
    expect(snap.ledger.unmapped).toEqual([{ venue: 'BINANCE', tag: 'JP_EQUITY', natives: ['TOYOTAUSDT'] }]);
  });

  it('unchanged instruments are byte-identical: every pre-wave level-2 mapping keeps its class; level-1 keeps its family', () => {
    // The pre-wave detectors' inline maps (BINANCE_UNDERLYING_TO_ASSET_CLASS, GATE_CONTRACT_TYPE,
    // BINGX_PREFIX, Bybit stock/commodity, MEXC's zone rules), keyed by today's tags.
    const LEGACY: Partial<Record<FieldVenue, Record<string, AssetClass>>> = {
      BINANCE: { EQUITY: 'EQUITY', KR_EQUITY: 'KR_EQUITY', COMMODITY: 'COMMODITY', INDEX: 'INDEX', PREMARKET: 'PREMARKET' },
      GATE: { stocks: 'EQUITY', indices: 'INDEX', commodities: 'COMMODITY', metals: 'COMMODITY', forex: 'FX' },
      BYBIT: { stock: 'EQUITY', commodity: 'COMMODITY' },
      BINGX: { NCSK: 'EQUITY', NCSI: 'INDEX', NCCO: 'COMMODITY', NCFX: 'FX' },
      MEXC: { commodities: 'COMMODITY', metals: 'COMMODITY', metalsfutures: 'COMMODITY', forex: 'FX', stockindex: 'INDEX', usstocks: 'EQUITY' },
    };
    let checked = 0;
    for (const [v, legacy] of Object.entries(LEGACY) as Array<[FieldVenue, Record<string, AssetClass>]>) {
      for (const [native, tag] of CENSUS.venues[v] ?? []) {
        const before = legacy[tag];
        if (!before) continue;
        const r = SNAP.byNative.get(v)!.get(native)!;
        if (r.cls === 'CRYPTO') continue; // the deny-list (USDC/XAUT/PAXG) — unchanged by construction
        const level = (VENUE_TAG_CLASS[v] as Record<string, { level: number } | string>)[tag];
        if (typeof level === 'object' && level.level === 2) expect(r.cls, `${v} ${native}`).toBe(before);
        else expect(family(r.cls), `${v} ${native}`).toBe(family(before));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1500);
  });
});

describe('CH3 — the daily check’s verdict (evaluateTotality)', () => {
  const perf = (byExchange: Record<string, Record<string, { tier: number; count: number }>>): PerformancePublicTiers => {
    const byAsset: Record<string, { tier: number; count: number }> = {};
    for (const e of Object.values(byExchange)) for (const [c, a] of Object.entries(e)) byAsset[c] = a;
    return { byAsset, byExchange: Object.fromEntries(Object.entries(byExchange).map(([k, v]) => [k, { byAsset: v }])) };
  };
  const CLEAN = perf({
    BINANCE: { BTC: { tier: 1, count: 9 }, CVX: { tier: 4, count: 5 }, TENCENT: { tier: 3, count: 4 } },
    OKX: { BB: { tier: 3, count: 3 }, AAPL: { tier: 3, count: 2 } },
  });

  it('the census fixture: PASS (and the token is the last line)', () => {
    const r = evaluateTotality(SNAP, 'skip');
    expect(r.verdict).toBe('PASS');
    expect(r.lines.at(-1)).toBe('ASSET_CLASS_TOTALITY_VERDICT=PASS');
    expect(evaluateTotality(SNAP, CLEAN).verdict).toBe('PASS');
  });

  it('an injected unmapped tag or collision: FAIL, naming venue + tag + action', () => {
    const u = evaluateTotality(buildAssetClassSnapshot(records({ OKX: [['EURUSD-USDT-SWAP', '5']] })), 'skip');
    expect(u.verdict).toBe('FAIL');
    expect(u.lines.find((l) => l.startsWith('FAIL unmapped'))).toMatch(/venue=OKX tag="5" .*action=add a VENUE_TAG_CLASS row for OKX "5"/);
    const c = evaluateTotality(buildAssetClassSnapshot(records({ HL: [['xyz:BTC', 'xyz']] })), 'skip');
    expect(c.verdict).toBe('FAIL');
    expect(c.lines.some((l) => l.startsWith('FAIL collision venue=HL bare=BTC'))).toBe(true);
  });

  it('a failed venue fetch, or an unreadable public endpoint: INDETERMINATE, never FAIL', () => {
    const failed = buildAssetClassSnapshot(records({ OKX: [['EURUSD-USDT-SWAP', '5']] }), ['GATE']);
    expect(evaluateTotality(failed, 'skip').verdict).toBe('INDETERMINATE');
    expect(evaluateTotality(SNAP, null).verdict).toBe('INDETERMINATE');
    expect(evaluateTotality(SNAP, { byAsset: {}, byExchange: {} }).verdict).toBe('INDETERMINATE');
    expect(evaluateTotality(buildAssetClassSnapshot({}), 'skip').verdict).toBe('INDETERMINATE');
  });

  it('two-way tier check: a non-3 TradFi row FAILs; a Tier-3 coin crypto on every venue FAILs', () => {
    const t4 = evaluateTotality(SNAP, perf({ BINANCE: { TENCENT: { tier: 4, count: 7 } } }));
    expect(t4.verdict).toBe('FAIL');
    expect(t4.lines).toContain('FAIL tier-not3-tradfi venue=BINANCE coin=TENCENT tier=4 class=HK_EQUITY n=7 action=the venue records TENCENT as HK_EQUITY; its tier must follow');
    const t3 = evaluateTotality(SNAP, perf({ BINANCE: { CVX: { tier: 3, count: 5 } }, BYBIT: { CVX: { tier: 3, count: 2 } } }));
    expect(t3.verdict).toBe('FAIL');
    expect(t3.lines.some((l) => l.startsWith('FAIL tier3-crypto coin=CVX venues=BINANCE,BYBIT'))).toBe(true);
    // Tier 3 on a venue that lists it as a stock is NOT crypto-everywhere (BB: OKX stock).
    expect(evaluateTotality(SNAP, perf({ BINANCE: { BB: { tier: 3, count: 1 } }, OKX: { BB: { tier: 3, count: 1 } } })).verdict).toBe('PASS');
  });
});
