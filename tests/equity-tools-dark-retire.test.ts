/**
 * EQUITY-TOOLS-DARK-RETIRE-W1 — the single reversible lever proven both ways.
 *
 * Pins: (a) the flag parser (default OFF; accepts 1/true, case-insensitive — the
 * X402_NUDGE hotfix lesson); (b) the equity-tool name set; (c) liveMcpToolNames —
 * OFF → 7 (the two equity tools absent), ON → 9 (both return). This is the SAME
 * derivation the index.ts registration loop consumes, so the live tools/list 9→7→9
 * behavior is proven at the seam it's produced. Env is passed in (never mutating the
 * shared process.env) to stay race-free under parallel vitest.
 */
import { describe, it, expect } from 'vitest';
import {
  EQUITY_TOOL_NAMES,
  isEquityToolName,
  isEquityToolsEnabled,
  liveMcpToolNames,
} from '../src/lib/equities/equity-tools-flag.js';
import { allToolNames, projectCapabilities } from '../src/lib/feature-registry.js';

const CRYPTO_LIVE = [
  'get_trade_call', 'get_trade_signal', 'get_market_regime',
  'scan_funding_arb', 'scan_trade_calls', 'chat_knowledge', 'search_knowledge',
].sort();
const ALL_NINE = [...CRYPTO_LIVE, 'get_equity_call', 'get_equity_regime'].sort();

describe('EQUITY-TOOLS-DARK-RETIRE-W1 — flag parser (default OFF)', () => {
  it('is OFF by default (unset env) — the dark-retire default', () => {
    expect(isEquityToolsEnabled({})).toBe(false);
    expect(isEquityToolsEnabled({ EQUITY_TOOLS_ENABLED: undefined })).toBe(false);
  });
  it('accepts both `1` and `true` (case-insensitive, trimmed) — X402_NUDGE hotfix lesson', () => {
    for (const on of ['1', 'true', 'TRUE', 'True', ' 1 ', ' true ']) {
      expect(isEquityToolsEnabled({ EQUITY_TOOLS_ENABLED: on })).toBe(true);
    }
  });
  it('treats every other value as OFF (no accidental enable)', () => {
    for (const off of ['0', '', 'false', 'no', 'yes', 'on', 'enabled', '2']) {
      expect(isEquityToolsEnabled({ EQUITY_TOOLS_ENABLED: off })).toBe(false);
    }
  });
});

describe('EQUITY-TOOLS-DARK-RETIRE-W1 — equity tool set', () => {
  it('EQUITY_TOOL_NAMES is exactly the two gated tools', () => {
    expect([...EQUITY_TOOL_NAMES]).toEqual(['get_equity_call', 'get_equity_regime']);
  });
  it('isEquityToolName flags only the equity tools', () => {
    expect(isEquityToolName('get_equity_call')).toBe(true);
    expect(isEquityToolName('get_equity_regime')).toBe(true);
    for (const n of CRYPTO_LIVE) expect(isEquityToolName(n)).toBe(false);
  });
});

describe('EQUITY-TOOLS-DARK-RETIRE-W1 — reversibility proven both ways (7 vs 9)', () => {
  it('DECLARED registry is unchanged (allToolNames stays 9) — no add/remove/rename', () => {
    expect([...allToolNames()].sort()).toEqual(ALL_NINE);
  });
  it('flag OFF → live tools/list = 7, both equity tools ABSENT', () => {
    const live = liveMcpToolNames({}).sort();
    expect(live).toEqual(CRYPTO_LIVE);
    expect(live).toHaveLength(7);
    expect(live).not.toContain('get_equity_call');
    expect(live).not.toContain('get_equity_regime');
  });
  it('flag ON → live tools/list = 9, both equity tools RETURN (== declared)', () => {
    const live = liveMcpToolNames({ EQUITY_TOOLS_ENABLED: '1' }).sort();
    expect(live).toEqual(ALL_NINE);
    expect(live).toHaveLength(9);
    expect(live).toContain('get_equity_call');
    expect(live).toContain('get_equity_regime');
    // ON is exactly the declared set — the flip is a pure add-back, no drift.
    expect(live).toEqual([...allToolNames()].sort());
  });
  it('OFF is exactly ON minus the two equity tools (the only delta is equities)', () => {
    const off = new Set(liveMcpToolNames({}));
    const on = new Set(liveMcpToolNames({ EQUITY_TOOLS_ENABLED: 'true' }));
    const delta = [...on].filter((n) => !off.has(n)).sort();
    expect(delta).toEqual(['get_equity_call', 'get_equity_regime']);
  });
});

describe('EQUITY-TOOLS-DARK-RETIRE-W1 — /capabilities tracks live tools/list (MCP-channel self-consistency)', () => {
  // The index.ts /capabilities route filters projectCapabilities() by liveMcpToolNames();
  // this replicates that projection so the MCP-channel invariant the feature-registry
  // `--live` drift canary enforces (tools/list == /capabilities) can never regress.
  const liveCapabilityNames = (env: NodeJS.ProcessEnv) => {
    const live = new Set(liveMcpToolNames(env));
    return projectCapabilities().tools.filter((t) => live.has(t.name)).map((t) => t.name).sort();
  };
  it('projectCapabilities() itself stays the pristine registry projection (9) — STATIC canary safe', () => {
    expect(projectCapabilities().tools.map((t) => t.name).sort()).toEqual(ALL_NINE);
  });
  it('flag OFF → live /capabilities == live tools/list (both 7, no equity — no MCP-channel drift)', () => {
    expect(liveCapabilityNames({})).toEqual(liveMcpToolNames({}).sort());
    expect(liveCapabilityNames({})).toEqual(CRYPTO_LIVE);
  });
  it('flag ON → live /capabilities == live tools/list (both 9)', () => {
    const env = { EQUITY_TOOLS_ENABLED: '1' };
    expect(liveCapabilityNames(env)).toEqual(liveMcpToolNames(env).sort());
    expect(liveCapabilityNames(env)).toEqual(ALL_NINE);
  });
});
