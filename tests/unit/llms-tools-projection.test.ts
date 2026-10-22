// DOCS-MARKET-REGIME-SCREENER-W1 CH2 — the LLM-facing tool lists are a projection of the public
// set. Freezes: both regions name exactly publicToolNames(), in registry order, in the COMMITTED
// files (the artifact a crawler reads) as well as in the renderer; every subsection carries the
// served description and a /docs link that resolves; the falsified hand lines stay gone; bytes
// outside the markers are never touched. Requires `npm run build` first (the default inputs read dist).
import * as fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  buildLlmsTools,
  fillBlock,
  renderToolsSentence,
  renderToolsSections,
  LLMS_TXT,
  LLMS_FULL_TXT,
  LIST_BLOCK,
  FULL_BLOCK,
} from '../../scripts/build_llms_tools.mjs';
import { publicToolNames, servedDescription } from '../../src/lib/feature-registry.js';
import { publicToolEntries } from '../../src/lib/nav-manifest.js';
import { allAnchorIds } from '../../src/lib/docs-outline.js';
import * as schema from '../../src/lib/tool-param-schema.js';

const region = (text: string, name: string): string => {
  const open = `<!-- BUILD:${name} -->`;
  const close = `<!-- /BUILD:${name} -->`;
  const si = text.indexOf(open);
  const ei = text.indexOf(close);
  expect(si, `BUILD:${name} open marker`).toBeGreaterThan(-1);
  expect(ei, `BUILD:${name} close marker`).toBeGreaterThan(si);
  return text.slice(si + open.length, ei);
};
const sentenceNames = (body: string): string[] =>
  [...body.replace(/\(full set via `tools\/list`\)/, '').matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
const sectionNames = (body: string): string[] => [...body.matchAll(/^### \d+\. `([a-z_]+)`/gm)].map((m) => m[1]);
const sections = (body: string): string[] => body.split(/^(?=### \d+\. )/m).filter((s) => s.startsWith('### '));

const entries = publicToolEntries();
const llms = fs.readFileSync(LLMS_TXT, 'utf8');
const full = fs.readFileSync(LLMS_FULL_TXT, 'utf8');

describe('CH2 AC — the committed regions name exactly publicToolNames(), in registry order', () => {
  it('llms.txt key fact', () => {
    expect(sentenceNames(region(llms, LIST_BLOCK))).toEqual(publicToolNames());
  });
  it('llms-full.txt "## The MCP Tools" subsections, numbered 1..n', () => {
    const body = region(full, FULL_BLOCK);
    expect(sectionNames(body)).toEqual(publicToolNames());
    expect([...body.matchAll(/^### (\d+)\. /gm)].map((m) => Number(m[1]))).toEqual(publicToolNames().map((_, i) => i + 1));
  });
  it('includes the two tools the hand lists had dropped', () => {
    for (const n of ['scan_trade_calls', 'scan_market_regimes']) {
      expect(sentenceNames(region(llms, LIST_BLOCK))).toContain(n);
      expect(sectionNames(region(full, FULL_BLOCK))).toContain(n);
    }
  });
});

describe('CH2 — each subsection = label + served description + a resolving /docs link', () => {
  const bodies = sections(region(full, FULL_BLOCK));
  const docsIds = new Set(allAnchorIds());
  it.each(entries.map((e, i) => [e.name, e, i] as const))('%s', (_n, e, i) => {
    const s = bodies[i];
    expect(s.split('\n')[0]).toBe(`### ${i + 1}. \`${e.name}\` — ${e.label}`);
    expect(s).toContain(servedDescription(e.name)!);
    const link = s.match(/\*\*How to use:\*\* https:\/\/algovault\.com\/docs#([a-z0-9-]+)/);
    expect(link?.[1]).toBe(e.anchor);
    expect(docsIds.has(link![1])).toBe(true);
  });
});

describe('CH2 — carried lines: confirmed kept, falsified dropped (ruling Q2=A)', () => {
  const body = region(full, FULL_BLOCK);
  it('keeps the confirmed get_market_regime defaults, projected from the served declaration', () => {
    expect(body).toContain('- `timeframe` (string, default `"4h"`)');
    expect(body).toContain('- `exchange` (enum, default `"HL"`)');
  });
  it('projects the get_trade_call timeframe values from the declaration /docs renders', () => {
    const tf = schema.PUBLIC_TOOL_ENUM_PARAMS.get_trade_call.timeframe.values.map((v: string) => `\`"${v}"\``).join(', ');
    expect(body).toContain(`- \`timeframe\` (enum): ${tf}.`);
  });
  it.each([
    ['get_trade_call timeframe default', 'Default `"15m"`'],
    ['get_trade_call exchange default', 'Binance USDT-M Futures, default'],
    ['scan_funding_arb minSpreadBps default', '`minSpreadBps` (number, default 10)'],
    ['scan_funding_arb limit default', '`limit` (number, default 5)'],
    ['scan_funding_arb output shape', 'annualisedReturn'],
  ])('drops %s', (_label, falsified) => {
    expect(full).not.toContain(falsified);
  });
});

describe('CH2 — the projection itself', () => {
  it('the committed files are in sync (what build_landing --check asserts)', () => {
    expect(buildLlmsTools({ check: true, inputs: { entries, describe: servedDescription, schema } })).toEqual({ drifted: [], missing: [] });
  });
  it('the renderer names every entry it is given — and only those', () => {
    const fewer = entries.slice(1);
    expect(sentenceNames(renderToolsSentence(fewer))).toEqual(fewer.map((e) => e.name));
    expect(sectionNames(renderToolsSections(fewer, servedDescription, schema))).toEqual(fewer.map((e) => e.name));
  });
  it('a public tool with no served description throws rather than rendering a blank section', () => {
    expect(() => renderToolsSections([{ name: 'ghost_tool', label: 'Ghost', anchor: 'ghost-tool', href: '' }], () => undefined, schema)).toThrow(/ghost_tool/);
  });
  it('fillBlock leaves every byte outside the markers untouched, and reports a missing region', () => {
    const text = 'head\n<!-- BUILD:X -->\nold\n<!-- /BUILD:X -->\ntail\n';
    expect(fillBlock(text, 'X', 'new')).toEqual({ text: 'head\n<!-- BUILD:X -->\nnew\n<!-- /BUILD:X -->\ntail\n', found: true });
    expect(fillBlock(text, 'Y', 'new')).toEqual({ text, found: false });
  });
  it('the sibling generator\'s regions are still present and distinct from ours', () => {
    for (const n of ['LLMS_INTEGRATIONS_LIST', 'LLMS_SKILLS_LIST']) region(llms, n);
    for (const n of ['LLMS_FULL_INTEGRATIONS', 'LLMS_FULL_SKILLS']) region(full, n);
    expect(new Set([LIST_BLOCK, FULL_BLOCK, 'LLMS_INTEGRATIONS_LIST', 'LLMS_SKILLS_LIST', 'LLMS_FULL_INTEGRATIONS', 'LLMS_FULL_SKILLS']).size).toBe(6);
  });
});
