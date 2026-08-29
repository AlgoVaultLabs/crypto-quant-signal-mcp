/**
 * EQUITY-TOOLS-DARK-RETIRE-W1 — the single reversible lever proven both ways.
 *
 * Pins: (a) the flag parser (default OFF; accepts 1/true, case-insensitive — the
 * X402_NUDGE hotfix lesson); (b) the equity-tool name set; (c) liveMcpToolNames —
 * OFF → the crypto set, ON → the full declared set. This is the SAME derivation the
 * index.ts registration loop consumes, so the live tools/list behavior is proven at the
 * seam it's produced. Env is passed in (never mutating the shared process.env) to stay
 * race-free under parallel vitest.
 *
 * DEV-TRACK-RECORD-TOOL-PARITY-W1 CH2: the counts moved 7→8 live / 9→10 declared when
 * `get_track_record` shipped. The DELTA between OFF and ON is what this file actually
 * guards, and it is unchanged: exactly the two equity tools, whatever else the registry
 * holds. The counts are asserted against the name lists below rather than as bare digits,
 * so the next tool moves one literal and not five.
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
  'get_track_record',
].sort();
const ALL_DECLARED = [...CRYPTO_LIVE, 'get_equity_call', 'get_equity_regime'].sort();

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
  it('DECLARED registry == allToolNames() — no unintended add/remove/rename', () => {
    expect([...allToolNames()].sort()).toEqual(ALL_DECLARED);
  });
  it('flag OFF → live tools/list = the crypto set (8), both equity tools ABSENT', () => {
    const live = liveMcpToolNames({}).sort();
    expect(live).toEqual(CRYPTO_LIVE);
    expect(live).toHaveLength(CRYPTO_LIVE.length);
    expect(live).not.toContain('get_equity_call');
    expect(live).not.toContain('get_equity_regime');
  });
  it('flag ON → live tools/list = the declared set (10), both equity tools RETURN', () => {
    const live = liveMcpToolNames({ EQUITY_TOOLS_ENABLED: '1' }).sort();
    expect(live).toEqual(ALL_DECLARED);
    expect(live).toHaveLength(ALL_DECLARED.length);
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
  it('projectCapabilities() itself stays the pristine registry projection — STATIC canary safe', () => {
    expect(projectCapabilities().tools.map((t) => t.name).sort()).toEqual(ALL_DECLARED);
  });
  it('flag OFF → live /capabilities == live tools/list (no equity — no MCP-channel drift)', () => {
    expect(liveCapabilityNames({})).toEqual(liveMcpToolNames({}).sort());
    expect(liveCapabilityNames({})).toEqual(CRYPTO_LIVE);
  });
  it('flag ON → live /capabilities == live tools/list', () => {
    const env = { EQUITY_TOOLS_ENABLED: '1' };
    expect(liveCapabilityNames(env)).toEqual(liveMcpToolNames(env).sort());
    expect(liveCapabilityNames(env)).toEqual(ALL_DECLARED);
  });
});
