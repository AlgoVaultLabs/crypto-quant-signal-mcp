/**
 * CHANGE-DEFAULT-EXCHANGE-W1 canary suite.
 *
 * Locks the post-1.11.0 invariants:
 *   - Zod schema default for `exchange` in TRADE_CALL_SCHEMA = 'BINANCE'
 *     (covers BOTH get_trade_call and get_trade_signal tools, since they
 *     share the same TRADE_CALL_SCHEMA constant).
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
  it('TRADE_CALL_SCHEMA.exchange Zod default = BINANCE (covers get_trade_call AND get_trade_signal)', () => {
    const src = read('src/index.ts');
    // The TRADE_CALL_SCHEMA line is single-source for both tool registrations.
    // Enum widened in PILOT-ADAPTERS-W1 (ASTER added for shadow); regex must
    // accept any trailing additions after the original 5 promoted venues.
    const re = /exchange:\s*z\.enum\(\['HL',\s*'BINANCE',\s*'BYBIT',\s*'OKX',\s*'BITGET'(?:,\s*'[A-Z]+')*\]\)\.default\('BINANCE'\)/;
    const matches = src.match(new RegExp(re.source, 'g')) || [];
    // Exactly one match expected — the TRADE_CALL_SCHEMA. The get_market_regime
    // schema (separate registration) keeps its 'HL' default for this wave.
    expect(matches.length).toBe(1);
  });

  it('TRADE_CALL_SCHEMA describe-text leads with "Binance USDT-M Futures (default)"', () => {
    // TOOL-DESC-AUDIT-W1 (2026-05-16): describe constants refactored into
    // src/tool-descriptions.ts (pure-data module). The canary substring now
    // lives in PARAM_DESC_TRADE_CALL_EXCHANGE; assert it's reachable from
    // src/index.ts's import + present in the descriptions module.
    const desc = read('src/tool-descriptions.ts');
    expect(desc).toContain("'BINANCE' = Binance USDT-M Futures (default)");
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
