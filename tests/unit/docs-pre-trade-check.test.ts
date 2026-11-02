/**
 * DOCS-PRE-TRADE-CHECK-LISTING-W1 — the `/docs#pre-trade-check` section, held to the declarations it
 * describes.
 *
 * The section has two hand-written tables: the non-enum parameter rows and the `rules` key table. Hand
 * prose is how `/docs` once listed five venues beside a server accepting seventeen, so each hand row here
 * is pinned to its SoT — `PRE_TRADE_CHECK_PARAM_DECL` for the parameter set, `PRE_TRADE_RULES` for each
 * key's range and default, and `PRE_TRADE_RULE_PARAM_DESC` (the served `rules.<key>` description) for its
 * copy. A rule added to the table without a docs row, or a bound changed on one side only, is red here
 * before the live P7 leg ever runs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRE_TRADE_CHECK_PARAM_DECL, PUBLIC_TOOL_ENUM_PARAMS, TOOL_DOCS_PARTIAL } from '../../src/lib/tool-param-schema.js';
import { PRE_TRADE_RULES, type PreTradeRuleRow } from '../../src/lib/pre-trade-rules.js';
import { PRE_TRADE_RULE_PARAM_DESC } from '../../src/tool-descriptions.js';
import { renderedParamsFor } from '../../scripts/check-docs-samples-live.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOCS_HTML = readFileSync(join(REPO_ROOT, 'landing', 'docs.html'), 'utf8');
const ANCHOR = 'pre-trade-check';

/** The rendered `<section id="pre-trade-check">` slice, or '' when it is absent. */
function section(html: string): string {
  const si = html.indexOf(`<section id="${ANCHOR}"`);
  if (si === -1) return '';
  const next = html.indexOf('<section id="', si + 1);
  return html.slice(si, next === -1 ? undefined : next);
}
const SECTION = section(DOCS_HTML);

/** The range cell a rule's declared param implies — the exact HTML the hand table must carry. */
function rangeCell(r: PreTradeRuleRow): string {
  const p = r.param;
  if (p.type === 'boolean') return 'boolean';
  if (p.exclusiveMinimum !== undefined) return `&gt; ${p.exclusiveMinimum}, &le; ${p.maximum}`;
  return `${p.minimum}&ndash;${p.maximum}`;
}
const defaultCell = (r: PreTradeRuleRow): string => (r.default === null ? '&mdash;' : r.default === true ? 'on' : String(r.default));

/** Every `data-rule-key` row: [key, range, default, description] cell HTML, in page order. */
function ruleRows(html: string): Array<[string, string, string, string]> {
  return [...html.matchAll(/<tr class="param-row" data-rule-key="([^"]+)"[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => {
    const cells = [...m[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]);
    expect(cells, `rule row ${m[1]} has 4 cells`).toHaveLength(4);
    expect(cells[0], `rule row ${m[1]} names its own key`).toBe(m[1]);
    return [m[1], cells[1], cells[2], cells[3]];
  });
}

describe('/docs#pre-trade-check is listed, right after the screener', () => {
  it('the section exists and is the one that follows #scan-market-regimes', () => {
    expect(SECTION, 'landing/docs.html has no #pre-trade-check section').not.toBe('');
    const ids = [...DOCS_HTML.matchAll(/<section id="([a-z0-9-]+)"/g)].map((m) => m[1]);
    expect(ids[ids.indexOf('scan-market-regimes') + 1]).toBe(ANCHOR);
  });

  it('its projected rows land in the partial the docs map names', () => {
    expect(TOOL_DOCS_PARTIAL.pre_trade_check).toBe(ANCHOR);
    expect(SECTION).toContain('data-schema-tool="pre_trade_check"');
  });
});

describe('the parameter table documents every declared parameter, and only those', () => {
  const rows = renderedParamsFor(DOCS_HTML, ANCHOR) ?? [];

  it('one row per PRE_TRADE_CHECK_PARAM_DECL key — the offline twin of the live P7 completeness leg', () => {
    expect(rows.map((r: { name: string }) => r.name).sort()).toEqual(Object.keys(PRE_TRADE_CHECK_PARAM_DECL).sort());
  });

  it('the projected rows carry the declaration\'s values, default and type', () => {
    for (const [name, spec] of Object.entries(PUBLIC_TOOL_ENUM_PARAMS.pre_trade_check)) {
      const row = rows.find((r: { name: string }) => r.name === name);
      expect(row, name).toBeTruthy();
      expect(row.values, name).toEqual([...spec.values]);
      expect(row.default, name).toBe(spec.default ?? null);
      expect(row.type, name).toBe(spec.type ?? 'string');
    }
  });

  it('every required parameter is tagged Required, and no optional one is', () => {
    for (const [name, decl] of Object.entries(PRE_TRADE_CHECK_PARAM_DECL)) {
      const tr = SECTION.match(new RegExp(`<tr class="param-row"[^>]*><td>${name}</td>[\\s\\S]*?</tr>`));
      expect(tr, name).not.toBeNull();
      expect(tr![0].includes('>Required</span>'), name).toBe(decl.required);
    }
  });
});

describe('the rules key table is the rule table, row for row', () => {
  const rows = ruleRows(SECTION);

  it('lists every PRE_TRADE_RULES key, in served order', () => {
    expect(rows.map((r) => r[0])).toEqual(PRE_TRADE_RULES.map((r) => r.id));
  });

  it('each range and default is the declared one', () => {
    for (const r of PRE_TRADE_RULES) {
      const row = rows.find((x) => x[0] === r.id)!;
      expect(row[1], `${r.id} range`).toBe(rangeCell(r));
      expect(row[2], `${r.id} default`).toBe(defaultCell(r));
    }
  });

  it('each description is the served rules.<key> copy, verbatim', () => {
    for (const r of PRE_TRADE_RULES) {
      expect(rows.find((x) => x[0] === r.id)![3], r.id).toBe(PRE_TRADE_RULE_PARAM_DESC[r.id]);
    }
  });
});

describe('the section follows the wave\'s section order and copy law', () => {
  it('Parameters → Your rules → Response Fields → Recipe → curl → Refusals', () => {
    const order = ['>Parameters<', '>Your rules<', '>Response Fields<', '>Recipe<', '>Call it over HTTP<', '>Refusals<'].map((h) => SECTION.indexOf(h));
    expect(order.every((i) => i !== -1), `missing heading: ${order}`).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('documents the three refusals: hosted_only, an undeclared argument, the quota wall', () => {
    for (const code of ['hosted_only', '-32602', 'TIER_LIMIT_REACHED']) expect(SECTION).toContain(`rounded">${code}</code></td>`);
  });

  it('the recipe and the curl sample send the rule the recipe explains', () => {
    expect(SECTION).toContain('rules: { maxLeverage: 10 }');
    expect(SECTION).toContain('"rules":{"maxLeverage":10}');
  });

  it('prose: no "win rate", no venue count, no wave id', () => {
    const prose = SECTION.replace(/<code[^>]*>[\s\S]*?<\/code>/g, ' ').replace(/<[^>]+>/g, ' ');
    expect(prose).not.toMatch(/win\s+rate/i);
    expect(prose).not.toMatch(/\b\d+\s+(?:venues|exchanges)\b/i);
    expect(prose).not.toMatch(/\b[A-Z]+(?:-[A-Z0-9]+)+-W\d+\b/);
    expect(prose).not.toMatch(/chatgpt/i);
  });
});
