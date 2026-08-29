/**
 * TRADE-CALL-ROUTING-RESOLVER-W1 R4 — public input-shape drift canary.
 *
 * Locks the tool input-schema contract against the CURRENT
 * audits/trade-call-routing-shape-snapshot-*.json: the additive optional params, the 2
 * architect-sanctioned (A1) non-additive default-key removals on get_trade_call, and the
 * tool set matching what the code actually declares.
 *
 * DEV-TRACK-RECORD-TOOL-PARITY-W1 CH2 repointed this from the 2026-06-09 snapshot — which had
 * been SUPERSEDED TWICE and still recorded `tools_list_count: 9` — to the current one, and
 * replaced the bare digit with a comparison against the live derivation. A count asserted as a
 * literal on both sides proves only that two literals match; asserting the snapshot against
 * `liveMcpToolNames()` and `allToolNames()` is what makes this a drift canary rather than a
 * second copy of the number.
 * Source-text canary in the CHANGE-DEFAULT-EXCHANGE-W1 style (the live
 * tools/list inputSchema is verified post-deploy via the snapshot's
 * drift_check_command).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PUBLIC_TOOL_ENUM_PARAMS } from '../src/lib/tool-param-schema.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allToolNames } from '../src/lib/feature-registry.js';
import { liveMcpToolNames } from '../src/lib/equities/equity-tools-flag.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8');
const snapshot = JSON.parse(read('audits/trade-call-routing-shape-snapshot-2026-08-28.json'));
const indexSrc = read('src/index.ts');
const descSrc = read('src/tool-descriptions.ts');

describe('TRADE-CALL-ROUTING-RESOLVER-W1 — public input-shape drift canary', () => {
  it('the snapshot documents the tool set the code actually declares', () => {
    // The snapshot's count is the LIVE surface (what an agent can call); the declared set is
    // larger by exactly the flag-gated equity tools. Both sides derive, so an add/remove/rename
    // that forgets the snapshot goes red here rather than shipping a stale public contract.
    expect(snapshot.tools_list_count).toBe(liveMcpToolNames({}).length);
    expect([...snapshot.allowed_keys].sort()).toEqual(liveMcpToolNames({}).sort());
    expect(new Set(allToolNames()).size).toBe(liveMcpToolNames({}).length + 2); // + the 2 gated equity tools
  });

  it('get_trade_call gains the additive optional assetClass param', () => {
    // DOCS-PARAM-SCHEMA-PROJECTION-W1 re-pointed this from the SOURCE LITERAL to the declaration
    // the Zod schema is now built from. The literal is gone, so the old regex asserted nothing —
    // it failed loudly, which is the good case, but a symbol-shaped rewrite of a sibling guard
    // would have made it pass over an empty match instead. The VALUE assertion below is the same
    // contract, and survives the next refactor of how the schema is spelled.
    expect(PUBLIC_TOOL_ENUM_PARAMS.get_trade_call.assetClass.values).toEqual(['perp', 'equity']);
    expect(PUBLIC_TOOL_ENUM_PARAMS.get_trade_call.assetClass.default).toBeUndefined();   // optional, no Zod default
    expect(indexSrc).toMatch(/assetClass:\s*z\.enum\(ASSET_CLASSES\)\.optional\(\)/);
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
    // DOCS-PARAM-SCHEMA-PROJECTION-W1 re-pointed this from the SOURCE LITERAL to the declaration
    // the Zod schema is now built from. The literal is gone, so the old regex asserted nothing —
    // it failed loudly, which is the good case, but a symbol-shaped rewrite of a sibling guard
    // would have made it pass over an empty match instead. The VALUE assertion below is the same
    // contract, and survives the next refactor of how the schema is spelled.
    expect(PUBLIC_TOOL_ENUM_PARAMS.get_market_regime.exchange.default).toBe('HL');
    expect(indexSrc).toMatch(/exchange:\s*z\.enum\(PUBLIC_VENUE_ENUM\)\.default\(REGIME_EXCHANGE_DEFAULT\)/);
  });
});
