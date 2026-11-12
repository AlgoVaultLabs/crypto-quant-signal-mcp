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
import { fromXtSymbol } from '../../src/lib/adapters/xt.js';
import { fromHtxSymbol } from '../../src/lib/adapters/htx.js';
import { fromPhemexSymbol } from '../../src/lib/adapters/phemex.js';
import { fromAsterSymbol, toAsterSymbol } from '../../src/lib/adapters/aster.js';
import { fromKucoinSymbol, toKucoinSymbol } from '../../src/lib/adapters/kucoin.js';
import { fromWeexSymbol, toWeexSymbol } from '../../src/lib/adapters/weex.js';

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
    expect(Object.keys(CENSUS.venues).sort()).toEqual(['ASTER', 'BINANCE', 'BINGX', 'BITGET', 'BYBIT', 'GATE', 'HL', 'HTX', 'KUCOIN', 'MEXC', 'OKX', 'PHEMEX', 'WEEX', 'WHITEBIT', 'XT']);
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
    expect(fx.map(([n]) => n).sort()).toEqual(['EURUSDUSDT', 'GBPUSDUSDT', 'USDBRLUSDT', 'USDJPYUSDT']);
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

  it('XT (OPS-ASSET-CLASS-XT-DECODE-W1): every tagged perp resolves TradFi through its own coin; FOREX → FX, INDEX → INDEX unless refined', () => {
    const xt = CENSUS.venues.XT ?? [];
    expect(xt.length).toBeGreaterThanOrEqual(300);
    const coinOf = (native: string) => fromXtSymbol(native); // the coin the app stores and serves
    for (const [native, tag] of xt) {
      const c = cls(coinOf(native), 'XT');
      if (['PAXG', 'XAUT'].includes(bareOf('XT', native))) { expect(c, native).toBe('CRYPTO'); continue; } // the deny-list
      expect(c === null || c === 'CRYPTO', `${native} ${tag} → ${c}`).toBe(false);
    }
    const fx = rowsWithTag('XT', ['FOREX']);
    expect(fx.length).toBeGreaterThanOrEqual(30);
    for (const [n] of fx) expect(cls(coinOf(n), 'XT'), n).toBe('FX');
    // The four books the measured defect named (resolved CRYPTO while XT sat in the union).
    for (const [coin, want] of [['USDTRY', 'FX'], ['USDNOK', 'FX'], ['NZDUSD', 'FX'], ['DE30EUR', 'INDEX']] as const) {
      expect(cls(coin, 'XT'), coin).toBe(want);
    }
    // Every XT market index no field venue lists stays INDEX (level 0, nothing refines it).
    for (const coin of ['UK100GBP', 'FR40EUR', 'EU50EUR', 'HK33HKD', 'AU200AUD', 'DJ30', 'FUSHIA50']) expect(cls(coin, 'XT'), coin).toBe('INDEX');
    // A ticker clash: XT's CAT is Caterpillar and its PURR Hyperliquid Strategies Inc.; elsewhere they are tokens.
    expect(family(cls('CAT', 'XT'))).toBe('EQUITY');
    expect(family(cls('PURR', 'XT'))).toBe('EQUITY');
    expect(cls('PURR', 'HL')).toBe('CRYPTO');
    // Pre-IPO: Pre-M wins over STOCK; a plain-STOCK pre-IPO name still refines from OKX's pre_market.
    for (const coin of ['OPENAI', 'ANTHROPIC', 'MOONSHOT', 'OURA']) expect(cls(coin, 'XT'), coin).toBe('PREMARKET');
    const L = SNAP.ledger.venues.XT!;
    expect({ crypto: L.crypto, lost: L.lost, collisions: L.collisions }).toEqual({ crypto: 0, lost: 0, collisions: 0 });
  });

  it('HTX (OPS-ASSET-CLASS-HTX-DECODE-W1): every labeled swap resolves TradFi through its own coin; NASDAQ100 → INDEX', () => {
    const htx = CENSUS.venues.HTX ?? [];
    expect(htx.length).toBeGreaterThanOrEqual(250);
    const coinOf = (native: string) => fromHtxSymbol(native); // the coin the app stores and serves
    const denied = (native: string) => ['PAXG', 'XAUT'].includes(bareOf('HTX', native));
    for (const [native, tag] of htx) {
      const c = cls(coinOf(native), 'HTX');
      if (denied(native)) { expect(c, native).toBe('CRYPTO'); continue; } // the deny-list
      expect(c === null || c === 'CRYPTO', `${native} ${tag} → ${c}`).toBe(false);
    }
    // The book the measured defect named: no field venue lists it, so it resolved CRYPTO while HTX sat in the union.
    expect(cls('NASDAQ100', 'HTX')).toBe('INDEX');
    expect(cls('SPX500', 'HTX')).toBe('INDEX');
    // Every metal and commodity HTX labels is COMMODITY (level 2), oil included (the union had USOIL as EQUITY).
    const commodities = rowsWithTag('HTX', ['metals', 'commodities']).filter(([n]) => !denied(n));
    expect(commodities.length).toBeGreaterThanOrEqual(5);
    for (const [n] of commodities) expect(cls(coinOf(n), 'HTX'), n).toBe('COMMODITY');
    expect(cls('USOIL', 'HTX')).toBe('COMMODITY');
    // A ticker clash: HTX's PURR is Hyperliquid Strategies Inc. (8.67 USDT, 2026-11-12); HL's PURR is the token (0.09).
    expect(family(cls('PURR', 'HTX'))).toBe('EQUITY');
    expect(cls('PURR', 'HL')).toBe('CRYPTO');
    // Pre-IPO names HTX labels `stock` still refine from Binance's and OKX's pre-market records (stock rows are level 0).
    for (const coin of ['OPENAI', 'ANTHROPIC', 'MOONSHOT', 'OURA']) expect(cls(coin, 'HTX'), coin).toBe('PREMARKET');
    const L = SNAP.ledger.venues.HTX!;
    expect({ crypto: L.crypto, lost: L.lost, collisions: L.collisions }).toEqual({ crypto: 0, lost: 0, collisions: 0 });
  });

  it('PHEMEX (OPS-ASSET-CLASS-PHEMEX-DECODE-W1): every typed perp resolves TradFi through its own coin; XTI and XBR → COMMODITY', () => {
    const px = CENSUS.venues.PHEMEX ?? [];
    expect(px.length).toBeGreaterThanOrEqual(120);
    const coinOf = (native: string) => fromPhemexSymbol(native); // the coin the app stores and serves
    const denied = (native: string) => ['PAXG', 'XAUT'].includes(bareOf('PHEMEX', native));
    for (const [native, tag] of px) {
      const c = cls(coinOf(native), 'PHEMEX');
      if (denied(native)) { expect(c, native).toBe('CRYPTO'); continue; } // the deny-list
      expect(c === null || c === 'CRYPTO', `${native} ${tag} → ${c}`).toBe(false);
    }
    // The five books the measured defect named: no field venue lists them, so they resolved CRYPTO while Phemex sat in the union.
    for (const [coin, want] of [['XTI', 'COMMODITY'], ['XBR', 'COMMODITY'], ['MUX', 'EQUITY'], ['SPYX', 'INDEX'], ['CATX', 'EQUITY']] as const) {
      expect(cls(coin, 'PHEMEX'), coin).toBe(want);
    }
    // Every metal and commodity Phemex groups is COMMODITY (level 2).
    const commodities = rowsWithTag('PHEMEX', ['Metals', 'Commodities']).filter(([n]) => !denied(n));
    expect(commodities.length).toBeGreaterThanOrEqual(5);
    for (const [n] of commodities) expect(cls(coinOf(n), 'PHEMEX'), n).toBe('COMMODITY');
    // Phemex files the S&P 500 under Stocks: the stock row is level 0, so Gate's level-2 `indices` names it.
    expect(cls('SPX500', 'PHEMEX')).toBe('INDEX');
    // PreMarket is Phemex's own record, even for a name that has since listed (QNTX trades as EQUITY on Binance).
    for (const coin of ['OPENAI', 'ANTHROPIC', 'SPACEX', 'QNTX']) expect(cls(coin, 'PHEMEX'), coin).toBe('PREMARKET');
    expect(cls('QNTX', 'BINANCE')).toBe('EQUITY');
    const L = SNAP.ledger.venues.PHEMEX!;
    expect({ crypto: L.crypto, lost: L.lost, collisions: L.collisions }).toEqual({ crypto: 0, lost: 0, collisions: 0 });
  });

  it('ASTER, KUCOIN, WEEX (OPS-TIER-CLASSIFIER-DECODE-W2): every record resolves through its own coin — TradFi to TradFi, crypto to CRYPTO', () => {
    const mappers = {
      ASTER: { from: fromAsterSymbol, to: toAsterSymbol, min: 500 },
      KUCOIN: { from: fromKucoinSymbol, to: toKucoinSymbol, min: 600 },
      WEEX: { from: fromWeexSymbol, to: toWeexSymbol, min: 400 },
    } as const;
    for (const v of ['ASTER', 'KUCOIN', 'WEEX'] as const) {
      const rows = CENSUS.venues[v] ?? [];
      expect(rows.length, v).toBeGreaterThanOrEqual(mappers[v].min);
      for (const [native, tag] of rows) {
        const coin = mappers[v].from(native); // the coin the app stores and serves
        if (mappers[v].to(coin) !== native) continue; // shadowed: no coin reaches this instrument
        const c = cls(coin, v);
        if (venueRecord(v, native, tag).flag === 'CRYPTO' || ['PAXG', 'XAUT', 'ALL'].includes(coin)) {
          expect(c, `${v} ${native}`).toBe('CRYPTO'); // the venue's own crypto record, or the deny-list
          continue;
        }
        expect(c === null || c === 'CRYPTO', `${v} ${native} ${tag} → ${c}`).toBe(false);
      }
      const L = SNAP.ledger.venues[v]!;
      expect({ lost: L.lost, collisions: L.collisions }, v).toEqual({ lost: 0, collisions: 0 });
    }
    // The books the measured defects named: listed by no other venue, they resolved CRYPTO from the union…
    expect(cls('ACNX', 'KUCOIN')).toBe('EQUITY');
    expect(cls('KKR', 'WEEX')).toBe('EQUITY');
    // …and a 0.22 USDT token the union read as Gate's Raytheon. Gate's own record still decides on Gate.
    expect(cls('RTX', 'ASTER')).toBe('CRYPTO');
    expect(cls('RTX', 'GATE')).toBe('EQUITY');
    // WEEX files the Dow and the DAX under Stocks: the row is level 0, so the level-2 indices name them.
    for (const coin of ['US30', 'GER40']) expect(cls(coin, 'WEEX'), coin).toBe('INDEX');
    // Every forex and pre-IPO contract keeps its level-2 class.
    for (const [n] of rowsWithTag('WEEX', ['Forex'])) expect(cls(fromWeexSymbol(n), 'WEEX'), n).toBe('FX');
    for (const [n] of rowsWithTag('WEEX', ['Pre-IPO'])) expect(cls(fromWeexSymbol(n), 'WEEX'), n).toBe('PREMARKET');
    for (const [n] of rowsWithTag('KUCOIN', ['PRE_MARKET'])) expect(cls(fromKucoinSymbol(n), 'KUCOIN'), n).toBe('PREMARKET');
    for (const [n] of rowsWithTag('ASTER', ['pre-launch'])) expect(cls(fromAsterSymbol(n), 'ASTER'), n).toBe('PREMARKET');
    // KuCoin's market rows: HK and KR stocks keep their market.
    for (const [n] of rowsWithTag('KUCOIN', ['HK.STOCK'])) expect(cls(fromKucoinSymbol(n), 'KUCOIN'), n).toBe('HK_EQUITY');
    for (const [n] of rowsWithTag('KUCOIN', ['KR.STOCK'])) expect(cls(fromKucoinSymbol(n), 'KUCOIN'), n).toBe('KR_EQUITY');
    // A ticker clash: KuCoin's and WEEX's PURR is the stock (8.87 / 8.85 USDT, 2026-11-12); HL's is the token.
    expect(family(cls('PURR', 'KUCOIN'))).toBe('EQUITY');
    expect(family(cls('PURR', 'WEEX'))).toBe('EQUITY');
    expect(cls('PURR', 'HL')).toBe('CRYPTO');
    // WEEX's PERPETUAL is not crypto evidence: it lists the Nikkei as one, and the union keeps JP225 an index.
    expect(cls('JP225', 'WEEX')).toBe('INDEX');
    expect(SNAP.ledger.venues.WEEX!.crypto).toBe(0);
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
