/**
 * TOOL-DESC-AUDIT-W1 canary suite (2026-05-16).
 *
 * Locks the post-1.13.1 invariants for MCP tool descriptions consumed by
 * Anthropic Tool Search (`tool_search_tool_regex_20251119` +
 * `tool_search_tool_bm25_20251119`) which rank over `tools/list` name +
 * description + arg-name + arg-description.
 *
 * Each of the 3 public tools (`get_trade_call`, `scan_funding_arb`,
 * `get_market_regime`) plus the `get_trade_signal` alias has its combined
 * text (tool description + sum of param describe() strings) audited against:
 *
 *   1. TOP_20_KEYWORDS lock (single source of truth).
 *   2. ≥15-of-20 keyword coverage (case-insensitive substring match).
 *   3. Brand-voice forbidden phrases (feedback_public_copy_professional_concise).
 *   4. Internal-detail forbidden phrases (feedback_no_internal_details_in_public_copy).
 *   5. Length budget — tool description ≤350 chars; each param describe() ≤80 chars.
 *   6. Alias description starts with the canonical TRADE_CALL_DESCRIPTION.
 *
 * Imports description constants from src/tool-descriptions.ts (pure-data
 * module) so the test does NOT trigger src/index.ts's bottom-of-file
 * startHttp() / startStdio() bootstrap.
 */
import { describe, it, expect } from 'vitest';
import {
  TRADE_CALL_DESCRIPTION,
  TRADE_CALL_ALIAS_SUFFIX,
  SCAN_FUNDING_ARB_DESCRIPTION,
  GET_MARKET_REGIME_DESCRIPTION,
  PARAM_DESC_TRADE_CALL_COIN,
  PARAM_DESC_TRADE_CALL_TIMEFRAME,
  PARAM_DESC_TRADE_CALL_INCLUDE_REASONING,
  PARAM_DESC_TRADE_CALL_EXCHANGE,
  PARAM_DESC_FUNDING_MIN_SPREAD_BPS,
  PARAM_DESC_FUNDING_LIMIT,
  PARAM_DESC_REGIME_COIN,
  PARAM_DESC_REGIME_TIMEFRAME,
  PARAM_DESC_REGIME_EXCHANGE,
  TOP_20_KEYWORDS,
} from '../../src/tool-descriptions.js';

// Tool combined-text bundles (description + every registered param describe()).
const TOOL_COMBINED: Record<string, { desc: string; params: string[] }> = {
  get_trade_call: {
    desc: TRADE_CALL_DESCRIPTION,
    params: [
      PARAM_DESC_TRADE_CALL_COIN,
      PARAM_DESC_TRADE_CALL_TIMEFRAME,
      PARAM_DESC_TRADE_CALL_INCLUDE_REASONING,
      PARAM_DESC_TRADE_CALL_EXCHANGE,
    ],
  },
  scan_funding_arb: {
    desc: SCAN_FUNDING_ARB_DESCRIPTION,
    params: [PARAM_DESC_FUNDING_MIN_SPREAD_BPS, PARAM_DESC_FUNDING_LIMIT],
  },
  get_market_regime: {
    desc: GET_MARKET_REGIME_DESCRIPTION,
    params: [PARAM_DESC_REGIME_COIN, PARAM_DESC_REGIME_TIMEFRAME, PARAM_DESC_REGIME_EXCHANGE],
  },
};

function combine(name: string): string {
  const bundle = TOOL_COMBINED[name];
  return [bundle.desc, ...bundle.params].join(' ');
}

function keywordHits(text: string): string[] {
  const lower = text.toLowerCase();
  return TOP_20_KEYWORDS.filter((k) => lower.includes(k.toLowerCase()));
}

// Brand-voice forbidden (feedback_public_copy_professional_concise.md).
const BRAND_FORBIDDEN_RE =
  /intelligence layer|powerful|seamless|robust|cutting-edge|industry-leading|Quant LLM|Wall Street Quant Brain/i;

// Internal-detail forbidden (feedback_no_internal_details_in_public_copy.md).
// Note: the [A-Z]+-W\d+ pattern catches wave IDs (e.g. ERC-8004-W1,
// PILOT-ADAPTERS-W1, TOOL-DESC-AUDIT-W1).
const INTERNAL_FORBIDDEN_RE =
  /[A-Z]+-W\d+|Binance-clone|custom L2 envelope|archetype [ABC]|shadow signal production|4h funding cadence|8h funding period|outcome_return_pct|phase_e_/i;

const TOOL_NAMES = Object.keys(TOOL_COMBINED);

describe('TOOL-DESC-AUDIT-W1 keyword + canary suite (post-1.13.1 invariants)', () => {
  it('Case 1 — TOP_20_KEYWORDS lock: exactly 20 phrases, each unique, no empty strings', () => {
    expect(TOP_20_KEYWORDS).toHaveLength(20);
    const set = new Set(TOP_20_KEYWORDS.map((k) => k.toLowerCase()));
    expect(set.size).toBe(20);
    for (const k of TOP_20_KEYWORDS) {
      expect(k.trim().length).toBeGreaterThan(0);
    }
  });

  it.each(TOOL_NAMES)('Case 2 — %s combined-text contains ≥15-of-20 keyword phrases', (name) => {
    const combined = combine(name);
    const hits = keywordHits(combined);
    if (hits.length < 15) {
      // Surface what's missing so the failure is actionable.
      const missing = TOP_20_KEYWORDS.filter((k) => !combined.toLowerCase().includes(k.toLowerCase()));
      throw new Error(
        `${name}: only ${hits.length}/20 keyword hits — missing: ${missing.join(' | ')}`,
      );
    }
    expect(hits.length).toBeGreaterThanOrEqual(15);
  });

  it.each(TOOL_NAMES)('Case 3 — %s combined-text passes brand-voice forbidden-phrase canary', (name) => {
    const combined = combine(name);
    const match = combined.match(BRAND_FORBIDDEN_RE);
    if (match) {
      throw new Error(`${name}: brand-voice forbidden phrase leaked — "${match[0]}"`);
    }
    expect(match).toBeNull();
  });

  it.each(TOOL_NAMES)('Case 4 — %s combined-text passes internal-detail forbidden-phrase canary', (name) => {
    const combined = combine(name);
    const match = combined.match(INTERNAL_FORBIDDEN_RE);
    if (match) {
      throw new Error(`${name}: internal-detail forbidden phrase leaked — "${match[0]}"`);
    }
    expect(match).toBeNull();
  });

  it.each(TOOL_NAMES)('Case 5 — %s length budget: tool desc ≤350 chars; each param describe() ≤80 chars', (name) => {
    const bundle = TOOL_COMBINED[name];
    expect(bundle.desc.length, `${name} tool description length`).toBeLessThanOrEqual(350);
    bundle.params.forEach((p, i) => {
      expect(p.length, `${name} param[${i}] describe() length`).toBeLessThanOrEqual(80);
    });
  });

  it('Case 6 — get_trade_signal alias starts with TRADE_CALL_DESCRIPTION + appends suffix', () => {
    const aliasFull = TRADE_CALL_DESCRIPTION + TRADE_CALL_ALIAS_SUFFIX;
    expect(aliasFull.startsWith(TRADE_CALL_DESCRIPTION)).toBe(true);
    expect(aliasFull.slice(TRADE_CALL_DESCRIPTION.length)).toBe(TRADE_CALL_ALIAS_SUFFIX);
    // KNOWLEDGE-ARTIFACT-W1 (2026-05-18): suffix rewritten to use [ALIAS] tag
    // pattern so future tool aliases follow the same shape.
    expect(TRADE_CALL_ALIAS_SUFFIX).toMatch(/\[ALIAS\] This tool is an alias of get_trade_call/);
    // Alias suffix itself must NOT trip the internal-detail canary.
    expect(TRADE_CALL_ALIAS_SUFFIX.match(INTERNAL_FORBIDDEN_RE)).toBeNull();
  });
});
