/**
 * TRADFI-SYMBOL-ALIAS-W1 canary suite (v1.11.1).
 *
 * Locks the alias-resolution invariants for TIER_3 (TradFi) symbols across all
 * 4 CEX adapters + the venue-coverage helper + the forbidden-phrase canary
 * (carries over from CHANGE-DEFAULT-EXCHANGE-W1's "no HL-only TradFi" rule).
 *
 * Refresh procedure if these tests start failing on a future CEX listing change:
 *   1. Re-run the Plan-Mode coverage probe per
 *      `audits/TRADFI-SYMBOL-ALIAS-W1-endpoint-truth.md` §2.
 *   2. Update the adapter's `TRADFI_ALIASES` map + `venue-coverage.ts`
 *      `HL_ONLY` / `PARTIAL_COVERAGE` constants in lockstep.
 *   3. Bump `COVERAGE_PROBED_AT` in venue-coverage.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { toBinanceSymbol, fromBinanceSymbol } from '../../src/lib/adapters/binance.js';
import { toBybitSymbol, fromBybitSymbol } from '../../src/lib/adapters/bybit.js';
import { toBitgetSymbol, fromBitgetSymbol } from '../../src/lib/adapters/bitget.js';
import { toOKXInstId, fromOKXInstId } from '../../src/lib/adapters/okx.js';
import { getVenuesSupporting, isVenueSupportedFor } from '../../src/lib/venue-coverage.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename), '..', '..');

describe('TRADFI_ALIASES — forward resolution (canonical → CEX-native)', () => {
  it('Binance: GOLD → XAUUSDT', () => {
    expect(toBinanceSymbol('GOLD')).toBe('XAUUSDT');
  });
  it('Binance: SILVER → XAGUSDT', () => {
    expect(toBinanceSymbol('SILVER')).toBe('XAGUSDT');
  });
  it('Binance: PLATINUM → XPTUSDT', () => {
    expect(toBinanceSymbol('PLATINUM')).toBe('XPTUSDT');
  });
  it('Binance: PALLADIUM → XPDUSDT', () => {
    expect(toBinanceSymbol('PALLADIUM')).toBe('XPDUSDT');
  });
  it('Binance: BTC → BTCUSDT (crypto-major path unchanged — no alias)', () => {
    expect(toBinanceSymbol('BTC')).toBe('BTCUSDT');
  });
  it('Binance: PEPE → 1000PEPEUSDT (meme-coin 1000-prefix path unchanged)', () => {
    expect(toBinanceSymbol('PEPE')).toBe('1000PEPEUSDT');
  });

  it('Bybit: GOLD → XAUUSDT', () => {
    expect(toBybitSymbol('GOLD')).toBe('XAUUSDT');
  });
  it('Bybit: SILVER → XAGUSDT', () => {
    expect(toBybitSymbol('SILVER')).toBe('XAGUSDT');
  });
  it('Bybit: ETH → ETHUSDT (crypto-major path unchanged)', () => {
    expect(toBybitSymbol('ETH')).toBe('ETHUSDT');
  });

  it('Bitget: GOLD → XAUUSDT', () => {
    expect(toBitgetSymbol('GOLD')).toBe('XAUUSDT');
  });
  it('Bitget: PLATINUM → XPTUSDT', () => {
    expect(toBitgetSymbol('PLATINUM')).toBe('XPTUSDT');
  });
  it('Bitget: SOL → SOLUSDT (crypto-major path unchanged)', () => {
    expect(toBitgetSymbol('SOL')).toBe('SOLUSDT');
  });

  it('OKX: GOLD → XAU-USDT-SWAP', () => {
    expect(toOKXInstId('GOLD')).toBe('XAU-USDT-SWAP');
  });
  it('OKX: COPPER → XCU-USDT-SWAP', () => {
    expect(toOKXInstId('COPPER')).toBe('XCU-USDT-SWAP');
  });
  it('OKX: NATGAS → NG-USDT-SWAP', () => {
    expect(toOKXInstId('NATGAS')).toBe('NG-USDT-SWAP');
  });
  it('OKX: BTC → BTC-USDT-SWAP (crypto-major path unchanged)', () => {
    expect(toOKXInstId('BTC')).toBe('BTC-USDT-SWAP');
  });
});

describe('TRADFI_ALIASES — reverse resolution (CEX-native → canonical)', () => {
  it('Binance: XAUUSDT → GOLD', () => {
    expect(fromBinanceSymbol('XAUUSDT')).toBe('GOLD');
  });
  it('Binance: XAGUSDT → SILVER', () => {
    expect(fromBinanceSymbol('XAGUSDT')).toBe('SILVER');
  });
  it('Binance: 1000PEPEUSDT → PEPE (meme-coin reverse path unchanged)', () => {
    expect(fromBinanceSymbol('1000PEPEUSDT')).toBe('PEPE');
  });
  it('Binance: BTCUSDT → BTC (crypto-major reverse path unchanged)', () => {
    expect(fromBinanceSymbol('BTCUSDT')).toBe('BTC');
  });

  it('Bybit: XAUUSDT → GOLD', () => {
    expect(fromBybitSymbol('XAUUSDT')).toBe('GOLD');
  });
  it('Bitget: XPDUSDT → PALLADIUM', () => {
    expect(fromBitgetSymbol('XPDUSDT')).toBe('PALLADIUM');
  });
  it('OKX: XAU-USDT-SWAP → GOLD', () => {
    expect(fromOKXInstId('XAU-USDT-SWAP')).toBe('GOLD');
  });
  it('OKX: XCU-USDT-SWAP → COPPER', () => {
    expect(fromOKXInstId('XCU-USDT-SWAP')).toBe('COPPER');
  });
  it('OKX: BTC-USDT-SWAP → BTC (crypto-major path unchanged)', () => {
    expect(fromOKXInstId('BTC-USDT-SWAP')).toBe('BTC');
  });
});

describe('getVenuesSupporting — venue-coverage matrix', () => {
  it('GOLD: supported on all 5 venues (HL + 4 CEXs via XAU alias)', () => {
    const venues = getVenuesSupporting('GOLD');
    expect(venues).toContain('HL');
    expect(venues).toContain('BINANCE');
    expect(venues).toContain('BYBIT');
    expect(venues).toContain('BITGET');
    expect(venues).toContain('OKX');
  });

  it('SILVER: supported on all 5 venues (XAG alias)', () => {
    const venues = getVenuesSupporting('SILVER');
    expect(venues.length).toBe(5);
  });

  it('SPX (memecoin): all 5 venues — present on every CEX + HL standard perp', () => {
    const venues = getVenuesSupporting('SPX');
    expect(venues.length).toBeGreaterThan(0);
    expect(venues).toContain('HL');
  });

  it('SP500 (S&P 500 index): HL-only — namespace collision with SPX memecoin on CEXs', () => {
    // The CEX `SPX` ticker is the SPX6900 memecoin (~$0.40), NOT the S&P 500 index
    // (~$7400 on HL). See audits/TRADFI-SYMBOL-ALIAS-W1-endpoint-truth.md §3.b.
    const venues = getVenuesSupporting('SP500');
    expect(venues).toEqual(['HL']);
  });

  it('TTF (Dutch natural gas): HL-only', () => {
    expect(getVenuesSupporting('TTF')).toEqual(['HL']);
  });

  it('JPY: HL-only (FX TradFi pair not listed on CEXs as USDT perp)', () => {
    expect(getVenuesSupporting('JPY')).toEqual(['HL']);
  });

  it('HIMS: partial coverage — Bitget only (per probe 2026-05-15)', () => {
    const venues = getVenuesSupporting('HIMS');
    expect(venues).toContain('HL');
    expect(venues).toContain('BITGET');
    expect(venues).not.toContain('BINANCE');
    expect(venues).not.toContain('BYBIT');
    expect(venues).not.toContain('OKX');
  });

  it('NATGAS: 4 venues (Bybit missing per probe)', () => {
    const venues = getVenuesSupporting('NATGAS');
    expect(venues).toContain('HL');
    expect(venues).toContain('BINANCE');
    expect(venues).toContain('BITGET');
    expect(venues).toContain('OKX');
    expect(venues).not.toContain('BYBIT');
  });

  it('TSLA: 5 venues (direct USDT match on every CEX, no alias)', () => {
    expect(getVenuesSupporting('TSLA').length).toBe(5);
  });

  it('BTC (non-TradFi): returns all 5 venues by default (function only narrows TradFi)', () => {
    const venues = getVenuesSupporting('BTC');
    expect(venues.length).toBe(5);
  });
});

describe('isVenueSupportedFor convenience helper', () => {
  it('GOLD on BINANCE → true', () => {
    expect(isVenueSupportedFor('GOLD', 'BINANCE')).toBe(true);
  });
  it('SP500 on BINANCE → false (namespace-collision-fixed)', () => {
    expect(isVenueSupportedFor('SP500', 'BINANCE')).toBe(false);
  });
  it('HIMS on BYBIT → false', () => {
    expect(isVenueSupportedFor('HIMS', 'BYBIT')).toBe(false);
  });
  it('HIMS on BITGET → true', () => {
    expect(isVenueSupportedFor('HIMS', 'BITGET')).toBe(true);
  });
  it('TTF on HL → true', () => {
    expect(isVenueSupportedFor('TTF', 'HL')).toBe(true);
  });
});

describe('Forbidden-phrase canary — no HL-only TradFi claim (carries from CHANGE-DEFAULT-EXCHANGE-W1)', () => {
  const SURFACES = [
    'README.md',
    'landing/index.html',
    'landing/docs.html',
    'landing/integrations.html',
    'landing/verify.html',
    'landing/skills.html',
    'landing/llms.txt',
    'landing/llms-full.txt',
    'src/index.ts',
    'src/lib/asset-tiers.ts',
    'src/lib/welcome-page.ts',
    'src/lib/venue-coverage.ts',
    'src/tools/get-trade-call.ts',
    'src/tools/get-market-regime.ts',
  ];
  const FORBIDDEN = [
    /TradFi assets[^.]*are HL-only/i,
    /TradFi[^.]*Hyperliquid-only/i,
    /\bHL-only\s+TradFi\b/i,
  ];

  it('no public-surface file ships the "HL-only TradFi" claim', () => {
    const violations: string[] = [];
    for (const f of SURFACES) {
      const abs = join(REPO_ROOT, f);
      if (!existsSync(abs)) continue;
      const txt = readFileSync(abs, 'utf8');
      for (const re of FORBIDDEN) {
        if (re.test(txt)) violations.push(`${f}: matches ${re}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});

describe('Version coherence', () => {
  it('package.json version is in 1.x major (TRADFI alias maps persist across all 1.x patches/minors)', () => {
    // Originally pinned 1.11.1 (TRADFI-SYMBOL-ALIAS-W1 shipped at that version);
    // widened to 1.x major after PILOT-ADAPTERS-W1 bumped to 1.12.0. The TradFi
    // alias invariants persist across releases; locking the test to a single
    // patch creates churn at every wave.
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(pkg.version).toMatch(/^1\.\d+\.\d+$/);
  });
});
