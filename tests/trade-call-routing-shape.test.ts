/**
 * TRADE-CALL-ROUTING-RESOLVER-W1 R4 — public input-shape drift canary.
 *
 * Locks the tool input-schema contract against
 * audits/trade-call-routing-shape-snapshot-2026-06-09.json: the additive
 * optional params, the 2 architect-sanctioned (A1) non-additive default-key
 * removals on get_trade_call, and tools/list staying 9 (no add/remove/rename).
 * Source-text canary in the CHANGE-DEFAULT-EXCHANGE-W1 style (the live
 * tools/list inputSchema is verified post-deploy via the snapshot's
 * drift_check_command).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allToolNames } from '../src/lib/feature-registry.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8');
const snapshot = JSON.parse(read('audits/trade-call-routing-shape-snapshot-2026-06-09.json'));
const indexSrc = read('src/index.ts');
const descSrc = read('src/tool-descriptions.ts');

describe('TRADE-CALL-ROUTING-RESOLVER-W1 — public input-shape drift canary', () => {
  it('tools/list stays 9 — no add / remove / rename', () => {
    expect(new Set(allToolNames()).size).toBe(9);
    expect(snapshot.tools_list_count).toBe(9);
  });

  it('get_trade_call gains the additive optional assetClass param', () => {
    expect(indexSrc).toMatch(/assetClass:\s*z\.enum\(\['perp',\s*'equity'\]\)\.optional\(\)/);
    expect(snapshot.tools.get_trade_call.additive_input_keys).toContain('assetClass');
  });

  it('SANCTIONED A1 exception: get_trade_call timeframe + exchange optional, NO Zod default', () => {
    // The TRADE_CALL_SCHEMA timeframe (11-value enum) is optional — no `.default('15m')`.
    expect(indexSrc).toMatch(/timeframe:\s*z\.enum\(\[[^\]]*'12h',\s*'1d'\]\)\.optional\(\)/);
    // No BINANCE Zod default remains anywhere — the default moved to resolveMarketRoute.
    expect(indexSrc).not.toMatch(/\.default\('BINANCE'\)/);
    // The snapshot documents EXACTLY these two removals — the only permitted non-additive change.
    expect(snapshot.tools.get_trade_call.sanctioned_default_removals).toHaveLength(2);
  });

  it('get_equity_call gains additive optional exchange + timeframe (symbol unchanged)', () => {
    const block = indexSrc.slice(indexSrc.indexOf("'get_equity_call'"), indexSrc.indexOf("'get_equity_regime'"));
    expect(block).toMatch(/symbol:\s*z\.string\(\)\.max\(12\)/);
    expect(block).toMatch(/exchange:\s*z\.enum\(/);
    expect(block).toMatch(/timeframe:\s*z\.enum\(/);
  });

  it('no internal/forbidden field name leaks into the public descriptions', () => {
    for (const k of snapshot.forbidden_output_keys as string[]) {
      expect(descSrc.toLowerCase()).not.toContain(k.toLowerCase());
    }
  });

  it('R3 deferred: the regime pair is unchanged (get_market_regime keeps its HL default)', () => {
    expect(indexSrc).toMatch(/\.default\('HL'\)/);
  });
});
