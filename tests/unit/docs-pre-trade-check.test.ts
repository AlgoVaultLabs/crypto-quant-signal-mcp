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
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRE_TRADE_CHECK_PARAM_DECL, PUBLIC_TOOL_ENUM_PARAMS, TOOL_DOCS_PARTIAL } from '../../src/lib/tool-param-schema.js';
import { PRE_TRADE_RULES, type PreTradeRuleRow } from '../../src/lib/pre-trade-rules.js';
import { PARAM_DESC_PRE_TRADE_RULES, PRE_TRADE_RULE_PARAM_DESC } from '../../src/tool-descriptions.js';
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
  it('Parameters → Your rules → Response Fields → Recipe → curl → Refusals → Gate your orders', () => {
    const order = ['>Parameters<', '>Your rules<', '>Response Fields<', '>Recipe<', '>Call it over HTTP<', '>Refusals<', '>Gate your orders<'].map((h) => SECTION.indexOf(h));
    expect(order.every((i) => i !== -1), `missing heading: ${order}`).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const headings = [...SECTION.matchAll(/<h3[^>]*>([^<]+)<\/h3>/g)].map((m) => m[1]);
    expect(headings.at(-1), 'Gate your orders is the last heading').toBe('Gate your orders');
  });

  it('documents the three refusals: hosted_only, an undeclared argument, the quota wall', () => {
    for (const code of ['hosted_only', '-32602', 'TIER_LIMIT_REACHED']) expect(SECTION).toContain(`rounded">${code}</code></td>`);
  });

  it('the recipe and the curl sample send the rule the recipe explains', () => {
    expect(SECTION).toContain('rules: { maxLeverage: 10 }');
    expect(SECTION).toContain('"rules":{"maxLeverage":10}');
  });

  it('Your rules → Saved rules → Response Fields: the saved-rules section sits between the two', () => {
    const at = (h: string) => SECTION.indexOf(h);
    expect(at('>Saved rules<')).toBeGreaterThan(at('>Your rules<'));
    expect(at('>Saved rules<')).toBeLessThan(at('>Response Fields<'));
  });

  it('prose: no "win rate", no venue count, no wave id', () => {
    const prose = SECTION.replace(/<code[^>]*>[\s\S]*?<\/code>/g, ' ').replace(/<[^>]+>/g, ' ');
    expect(prose).not.toMatch(/win\s+rate/i);
    expect(prose).not.toMatch(/\b\d+\s+(?:venues|exchanges)\b/i);
    expect(prose).not.toMatch(/\b[A-Z]+(?:-[A-Z0-9]+)+-W\d+\b/);
    expect(prose).not.toMatch(/chatgpt/i);
  });
});

/** An element's rendered text: tags dropped, the three entities the partial uses decoded. */
const textOf = (html: string): string => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The live pre_trade_check shape snapshot: the one no later snapshot supersedes. */
function liveShapeSnapshot(): { allowed_keys: string[]; rule_source_values: string[] } {
  const dir = join(REPO_ROOT, 'audits');
  const live = readdirSync(dir)
    .filter((f) => /^pre-trade-check-shape-snapshot-.+\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
    .filter((s) => !s.superseded_by);
  expect(live, 'exactly one live pre_trade_check shape snapshot').toHaveLength(1);
  return live[0];
}

describe('saved rules (DECISION-CALL-V2-W2): the contract\'s copy verbatim, and the response it documents', () => {
  // Copy-locked: Prompt/pre-trade-check-contract-v2.md § v2.1 "Copy (verbatim; approved with the dispatch)".
  const RULES_PARAM_COPY = 'Your rules, each key optional. Saved rules apply too; a failed one returns WAIT.';
  const SAVED_RULES_COPY = 'Save your rules once. Send them to PUT https://api.algovault.com/api/pre-trade-rules with your API key (Authorization: Bearer <key>). Every check made with that key then applies them, marked saved in rules[]; a rule sent with a call overrides the saved one for that call. GET shows what is saved and DELETE clears it. Saving needs an API key; a free key works.';

  it('the served rules description is the contract string, and the docs row carries it in place of the old one', () => {
    expect(PARAM_DESC_PRE_TRADE_RULES).toBe(RULES_PARAM_COPY);
    const row = SECTION.match(/<tr class="param-row"[^>]*><td>rules<\/td>[\s\S]*?<\/tr>/);
    expect(row, 'the rules parameter row').not.toBeNull();
    expect(textOf(row![0])).toContain(RULES_PARAM_COPY);
    expect(textOf(SECTION)).not.toContain('A rule of yours that fails returns WAIT. Every key');
  });

  it('the Saved rules paragraph is the contract paragraph, verbatim', () => {
    const p = SECTION.match(/<p [^>]*data-copy-locked="saved-rules"[^>]*>([\s\S]*?)<\/p>/);
    expect(p, 'the copy-locked paragraph').not.toBeNull();
    expect(textOf(p![1])).toBe(SAVED_RULES_COPY);
  });

  it('the Response Fields table documents every key the shape snapshot allows, in its order', () => {
    const start = SECTION.indexOf('>Response Fields<');
    const table = SECTION.slice(start, SECTION.indexOf('</table>', start));
    const rows = [...table.matchAll(/<tr class="param-row"[^>]*><td>([^<]+)<\/td>/g)].map((m) => m[1]);
    expect(rows).toEqual(liveShapeSnapshot().allowed_keys);
    expect(rows).toContain('saved_rules');
  });

  it('the rules[].source row names every source the snapshot allows', () => {
    const src = SECTION.match(/<tr class="param-row"><td>source<\/td>[\s\S]*?<\/tr>/);
    expect(src, 'the source row').not.toBeNull();
    const named = [...src![0].matchAll(/rounded">([a-z]+)<\/code>/g)].map((m) => m[1]);
    expect(named).toEqual(liveShapeSnapshot().rule_source_values);
  });
});

describe('Gate your orders (DECISION-CALL-V2-W3): the approved copy, then the three recipes', () => {
  // Copy-locked: Prompt/pre-trade-gate-contract.md § Copy, item 3 (verbatim; approved with the dispatch).
  const GATE_COPY = 'Make the check a step your agent cannot skip. In Claude Code, the AlgoVault pre-trade gate plugin blocks an order tool call until pre_trade_check has recently checked that coin and side, and blocks it when the check returns WAIT. In LangChain, a middleware runs the check before your order tool; in Freqtrade, confirm_trade_entry skips the entry on WAIT. Each recipe blocks the order when the check cannot run, and lets CAUTION through with its reasons.';
  const GATE_LINKS = [
    'https://algovault.com/integrations/claude-code',
    'https://algovault.com/integrations/langchain',
    'https://github.com/AlgoVaultLabs/algovault-skills/tree/main/examples/freqtrade',
  ];
  const GATE = SECTION.slice(SECTION.indexOf('>Gate your orders<'));

  it('the paragraph is the contract paragraph, verbatim', () => {
    const p = GATE.match(/<p [^>]*data-copy-locked="gate-your-orders"[^>]*>([\s\S]*?)<\/p>/);
    expect(p, 'the copy-locked paragraph').not.toBeNull();
    expect(textOf(p![1])).toBe(GATE_COPY);
  });

  it('links the Claude Code page, the LangChain page and the Freqtrade recipe, in that order', () => {
    const list = GATE.match(/<ul [^>]*data-gate-links[^>]*>([\s\S]*?)<\/ul>/);
    expect(list, 'the gate links list').not.toBeNull();
    expect([...list![1].matchAll(/<a href="([^"]+)"/g)].map((m) => m[1])).toEqual(GATE_LINKS);
  });

  /** 200 → ok; 404 or 410 → dead; a network error or any other status (403, 429, 5xx) → could not verify. */
  async function probe(url: string): Promise<{ state: 'ok' | 'dead' | 'indeterminate'; detail: string }> {
    try {
      const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10_000) });
      if (r.status === 200) return { state: 'ok', detail: '200' };
      return { state: r.status === 404 || r.status === 410 ? 'dead' : 'indeterminate', detail: `HTTP ${r.status}` };
    } catch (err) {
      return { state: 'indeterminate', detail: err instanceof Error ? err.message : String(err) };
    }
  }

  for (const url of GATE_LINKS) {
    it(`${url} answers 200`, { timeout: 20_000 }, async (ctx) => {
      const r = await probe(url);
      // Could not verify is reported as SKIPPED, never as a pass; a dead link fails.
      ctx.skip(r.state === 'indeterminate', `could not verify ${url}: ${r.detail}`);
      expect(r.state, `${url}: ${r.detail}`).toBe('ok');
    });
  }
});
