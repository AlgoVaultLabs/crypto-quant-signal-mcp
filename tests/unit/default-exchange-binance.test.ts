/**
 * CHANGE-DEFAULT-EXCHANGE-W1 canary suite.
 *
 * Locks the post-1.11.0 invariants:
 *   - Default perp venue = 'BINANCE'. Since TRADE-CALL-ROUTING-RESOLVER-W1 this
 *     lives in resolveMarketRoute.venueDefault — the TRADE_CALL_SCHEMA exchange is
 *     now optional with NO Zod default (so the resolver can tell a named venue
 *     from a bare call); omitting the venue still resolves to BINANCE.
 *   - Handler fallback in src/tools/get-trade-call.ts uses 'BINANCE'.
 *   - No public-surface file ships the literal phrase "TradFi assets ...
 *     are HL-only" (empirically false per signal_performance.signals
 *     postgres GROUP BY coin,exchange 2026-05-15: TSLA seeded on 5 venues,
 *     XAU on 4 venues, MSTR on 5 venues, etc.).
 *   - get_market_regime schema (out of scope for this wave) keeps default
 *     'HL'.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename), '..', '..');

function read(rel: string): string {
  const abs = join(REPO_ROOT, rel);
  return readFileSync(abs, 'utf8');
}

describe('CHANGE-DEFAULT-EXCHANGE-W1 canaries (post-1.11.0 invariants)', () => {
  it('default perp venue = BINANCE via resolveMarketRoute; TRADE_CALL_SCHEMA exchange is optional with NO Zod default', () => {
    // TRADE-CALL-ROUTING-RESOLVER-W1: the Zod .default('BINANCE') was removed so the
    // shared resolver can distinguish a named venue (→ perp) from a bare call
    // (→ equity-universe routing). The default-venue invariant MOVED to the resolver;
    // omitting the venue still resolves to BINANCE — so the guard tracks it there now.
    const route = read('src/lib/market-route.ts');
    expect(route).toMatch(/function venueDefault[\s\S]*?return 'BINANCE';/);
    const src = read('src/index.ts');
    // No stale BINANCE Zod default remains anywhere (the old mechanism is fully gone).
    expect(src).not.toMatch(/\.default\('BINANCE'\)/);
    // The trade-call exchange is now optional (single-source for get_trade_call AND
    // its get_trade_signal alias — both share TRADE_CALL_SCHEMA).
    expect(src).toMatch(/exchange:\s*z\.enum\(\['HL',\s*'BINANCE',\s*'BYBIT',\s*'OKX',\s*'BITGET'(?:,\s*'[A-Z]+')*\]\)\.optional\(\)/);
  });

  it('TRADE_CALL exchange describe conveys the Binance default venue', () => {
    // TRADE-CALL-ROUTING-RESOLVER-W1 reworded PARAM_DESC_TRADE_CALL_EXCHANGE for the
    // routing-disambiguation copy (the USDT-M phrasing was dropped), but the
    // Binance-default signal stays so callers still know the default venue.
    const desc = read('src/tool-descriptions.ts');
    expect(desc).toMatch(/PARAM_DESC_TRADE_CALL_EXCHANGE[\s\S]{0,120}default Binance/);
    const indexSrc = read('src/index.ts');
    expect(indexSrc).toContain('PARAM_DESC_TRADE_CALL_EXCHANGE');
    expect(indexSrc).toContain("from './tool-descriptions.js'");
  });

  it('get_trade_call handler fallback uses BINANCE (not HL)', () => {
    const src = read('src/tools/get-trade-call.ts');
    expect(src).toContain("const exchange = input.exchange || 'BINANCE';");
    expect(src).not.toMatch(/const\s+exchange\s*=\s*input\.exchange\s*\|\|\s*'HL';/);
  });

  it('get_market_regime schema keeps HL default (out of scope for this wave)', () => {
    const src = read('src/index.ts');
    // Find the get_market_regime registration block and assert its exchange default.
    // The CALL/SIGNAL schema lives at TRADE_CALL_SCHEMA (already covered above);
    // the get_market_regime registration has its own inline exchange Zod field.
    const regimeBlock = src.slice(src.indexOf("'get_market_regime'"));
    expect(regimeBlock).toMatch(/exchange:\s*z\.enum\(\['HL',\s*'BINANCE',\s*'BYBIT',\s*'OKX',\s*'BITGET'(?:,\s*'[A-Z]+')*\]\)\.default\('HL'\)/);
  });

  it('No public-surface file ships the "HL-only TradFi" claim', () => {
    // CHANGELOG.md is intentionally excluded: it documents the historical
    // REMOVAL of the claim (the entry literally contains "HL-only TradFi" in
    // a documenting context). Same for the audits/ + Old Status/ trees and
    // this canary file itself.
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
      'src/tools/get-trade-call.ts',
    ];
    const FORBIDDEN = [
      /TradFi assets[^.]*are HL-only/i,
      /TradFi[^.]*Hyperliquid-only/i,
      /\bHL-only\s+TradFi\b/i,
    ];
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

  it('package.json version is in the 1.x major (release coherent with this wave + future minor/patch bumps)', () => {
    const pkg = JSON.parse(read('package.json'));
    // Originally pinned 1.11.x (CHANGE-DEFAULT-EXCHANGE-W1); widened to 1.x
    // after PILOT-ADAPTERS-W1 bumped to 1.12.0 — the W1 invariants persist
    // across all 1.x releases (default exchange = BINANCE; describe-text;
    // handler fallback; forbidden-phrase canary). Locking to a single minor
    // creates churn at every release.
    expect(pkg.version).toMatch(/^1\.\d+\.\d+$/);
  });
});
