/**
 * SR-ZONES-W2 CH2 AC2.3 — the docs page (docs-src/partials/get-sr-zones.html) holds only approved text (§0.5): the §0
 * description, NOTE and the parameter texts, verbatim; field names and JSON types; one example request and one real
 * production response (BTC, 1d), labelled Example. No other claim, number or venue count, and no inline palette
 * (Design.md §13). The facts lint over the page's text lives with the lint (sr-zones-facts-lint.test.ts).
 *
 * The example response is the production response of 2026-11-16 09:02 UTC (internal key, as the smoke), its edges and
 * summary range projected through the CH1 helper at BTCUSDT's tick 0.1 — what this build serves for those candles —
 * with the call-metadata block `_algovault` left out. These tests hold it to that: every edge on the step, the summary
 * printing those edges, and the field tables naming exactly the keys it carries.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GET_SR_ZONES_DESCRIPTION,
  PARAM_DESC_SR_ZONES_COIN,
  PARAM_DESC_SR_ZONES_TIMEFRAMES,
  PARAM_DESC_SR_ZONES_VENUE,
} from '../../src/tool-descriptions.js';
import { SR_ZONES_NOTE, SR_ZONES_ORDER, buildSrZonesSummary } from '../../src/lib/sr-zones/summary.js';
import { priceLevelStep } from '../../src/lib/sr-zones/rounding.js';
import type { SrZone } from '../../src/lib/sr-zones/zones.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PARTIAL = readFileSync(join(ROOT, 'docs-src', 'partials', 'get-sr-zones.html'), 'utf8');

const decode = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const text = (html: string): string => decode(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

/** The field names of the table that follows `heading` (an h3/h4 whose text is exactly `heading`). */
function tableAfter(heading: string): string[] {
  const hs = [...PARTIAL.matchAll(/<(h3|h4)[^>]*>([\s\S]*?)<\/\1>/g)];
  const h = hs.find((m) => text(m[2]) === heading);
  expect(h, `heading "${heading}"`).toBeDefined();
  const from = h!.index! + h![0].length;
  const table = PARTIAL.slice(from, PARTIAL.indexOf('</table>', from));
  return [...table.matchAll(/<tr class="param-row"[^>]*><td>([^<]+)<\/td>/g)].map((m) => m[1]);
}

/** The code blocks, in page order, decoded. */
const codeBlocks = (): string[] => [...PARTIAL.matchAll(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/g)].map((m) => decode(m[1]));

interface Example {
  coin: string;
  price: number;
  results: Array<{ timeframe: string; summary: string; volume_vs_20: number | null; flags: string[]; support: SrZone[]; resistance: SrZone[] }>;
  [k: string]: unknown;
}
const example = (): Example => JSON.parse(codeBlocks()[1]) as Example;

describe('SR-ZONES-W2 AC2.3 — the docs page is only the approved text', () => {
  it('the paragraphs are the §0 description and NOTE, verbatim, plus the two example labels', () => {
    const paras = [...PARTIAL.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g)].map((m) => text(m[1]));
    expect(paras).toEqual([GET_SR_ZONES_DESCRIPTION, SR_ZONES_NOTE, 'Request', 'Response']);
  });

  it('the headings are structure only', () => {
    const heads = [...PARTIAL.matchAll(/<(h3|h4)[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => text(m[2]));
    expect(heads).toEqual([
      'Parameters',
      'Response Fields',
      'Each entry in results',
      'Each zone in support and resistance',
      'Each entry in unserved',
      'Example',
    ]);
  });

  it('the parameter rows carry the frozen parameter texts', () => {
    const rows = [...PARTIAL.matchAll(/<tr class="param-row"[^>]*><td>([^<]+)<\/td><td[^>]*>([^<]+)<\/td><td[^>]*>([\s\S]*?)<\/td><\/tr>/g)]
      .map((m) => [m[1], m[2], text(m[3])]);
    expect(rows).toEqual([
      ['coin', 'string', `${PARAM_DESC_SR_ZONES_COIN} Required`],
      ['timeframes', 'string[]', `${PARAM_DESC_SR_ZONES_TIMEFRAMES} Required`],
      ['venue', 'string', PARAM_DESC_SR_ZONES_VENUE],
    ]);
  });

  it('every other table cell is a field name or a JSON type', () => {
    const cells = [...PARTIAL.matchAll(/<tr class="param-row"[^>]*>([\s\S]*?)<\/tr>/g)]
      .filter((m) => (m[1].match(/<td/g) ?? []).length === 2)
      .flatMap((m) => [...m[1].matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map((c) => c[1]));
    expect(cells.length).toBeGreaterThan(0);
    for (let i = 1; i < cells.length; i += 2) expect(cells[i]).toMatch(/^(string|number|array|object)( or null)?$/);
  });

  it('no inline palette (Design.md §13): no colour literal, no tailwind.config, no style but the row border', () => {
    expect(PARTIAL).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|oklch\(|hsl\(/i);
    expect(PARTIAL).not.toContain('tailwind.config');
    expect([...new Set([...PARTIAL.matchAll(/style="([^"]*)"/g)].map((m) => m[1]))]).toEqual(['border-bottom:none']);
  });
});

describe('SR-ZONES-W2 AC2.3 — the example: one request, one served BTC 1d response', () => {
  it('the request is a tools/call of get_sr_zones for BTC 1d at the production MCP URL', () => {
    const curl = codeBlocks()[0];
    expect(codeBlocks()).toHaveLength(2);
    expect(curl.startsWith('curl -s -X POST https://api.algovault.com/mcp ')).toBe(true);
    const body = JSON.parse(curl.match(/-d '(.*)'$/)![1]) as { method: string; params: { name: string; arguments: unknown } };
    expect(body.method).toBe('tools/call');
    expect(body.params).toEqual({ name: 'get_sr_zones', arguments: { coin: 'BTC', timeframes: ['1d'] } });
  });

  it('the response answers that request: BTC, one 1d result, nothing unserved, NOTE and ORDER as served', () => {
    const r = example();
    expect(Object.keys(r)).toEqual(['coin', 'venue', 'price', 'order', 'note', 'results', 'unserved', 'timestamp']);
    expect([r.coin, r.venue, r.order, r.note, r.unserved]).toEqual(['BTC', 'BINANCE', SR_ZONES_ORDER, SR_ZONES_NOTE, []]);
    expect(r.results.map((x) => x.timeframe)).toEqual(['1d']);
  });

  it('every edge is on the call\'s step (BTC tick 0.1 → 10), and each zone is a range', () => {
    const r = example();
    const step = priceLevelStep(r.price, 0.1)!;
    expect(step.value).toBe(10);
    const zones = [...r.results[0].support, ...r.results[0].resistance];
    expect(zones).toHaveLength(6);
    for (const z of zones) {
      expect(Number.isInteger(z.low / 10) && Number.isInteger(z.high / 10), `${z.low}–${z.high}`).toBe(true);
      expect(z.low).toBeLessThan(z.high);
    }
  });

  it('the summary prints the served edges of zone 1 on each side', () => {
    const r = example();
    const f = r.results[0];
    const frame = { support: f.support, resistance: f.resistance, flags: f.flags as never, volume_vs_20: f.volume_vs_20 };
    expect(f.summary).toBe(buildSrZonesSummary(r.coin, '1d', r.price, frame, frame));
    expect(f.summary).toContain(`${f.support[0].low}–${f.support[0].high}`);
  });

  it('the field tables name exactly the keys the response carries (plus _algovault, left out of the example)', () => {
    const r = example();
    expect(tableAfter('Response Fields')).toEqual([...Object.keys(r), '_algovault']);
    expect(tableAfter('Each entry in results')).toEqual(Object.keys(r.results[0]));
    expect(tableAfter('Each zone in support and resistance')).toEqual(Object.keys(r.results[0].support[0]));
    expect(tableAfter('Each entry in unserved')).toEqual(['timeframe', 'reason']);
  });
});
