/**
 * SR-ZONES-W1 AC1.4 — the facts-only lint. get_support_resistance_zones states where zones are; it never says what price will do.
 * Every string literal under src/lib/sr-zones/** and in the handler src/tools/get-sr-zones.ts (unserved reasons, the
 * refusal message and suggested_action — R6 #11), the tool description and its param strings, and the
 * summary on each of the last 365 fixture candles must match none of FORBIDDEN (ORDER left the response, R7; NOTE, R8). scripts/sr-zones-smoke.mjs runs the
 * same pattern over live responses; a test below pins the two patterns equal.
 *
 * The lint is a gate that could pass vacuously, so it carries a two-way self-test of the regex and a floor on how
 * many strings it read.
 *
 * SR-ZONES-W2 AC1.5: the summaries are the served ones — zone edges rounded outward (src/lib/sr-zones/rounding.ts) at
 * BTCUSDT's Binance tick 0.1 (PRICE_FILTER, measured 2026-11-16) — and the new rounding.ts is read with the lib.
 */
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSrZones } from '../../src/lib/sr-zones/zones.js';
import { buildSrZonesSummary } from '../../src/lib/sr-zones/summary.js';
import { priceLevelStep } from '../../src/lib/sr-zones/rounding.js';
import { serveSrZonesFrame } from '../../src/lib/sr-zones/served.js';
import {
  GET_SR_ZONES_DESCRIPTION,
  PARAM_DESC_SR_ZONES_COIN,
  PARAM_DESC_SR_ZONES_TIMEFRAMES,
  PARAM_DESC_SR_ZONES_VENUE,
} from '../../src/tool-descriptions.js';
import { loadBtcFixture } from './sr-zones-helpers.js';

const FORBIDDEN =
  /\b(will|likely|unlikely|expect\w*|predict\w*|forecast\w*|target\w*|probab\w*|chances?|should|bounce\w*|revers\w*|may hold|must hold|strong(er|est)?|weak(er|est)?)\b/i;

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIB = join(REPO, 'src', 'lib', 'sr-zones');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** Every string literal and template-literal text in a TypeScript file. */
function stringLiterals(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n)
    ) {
      out.push(n.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const libLiterals: Array<[string, string]> = walk(LIB).flatMap((f) =>
  stringLiterals(f).map((s): [string, string] => [relative(REPO, f), s]),
);

/** R6 #11: the handler emits strings too — every unserved reason, the refusal message and its suggested_action. */
const HANDLER = join(REPO, 'src', 'tools', 'get-sr-zones.ts');
const handlerLiterals: Array<[string, string]> = stringLiterals(HANDLER).map((s): [string, string] => [relative(REPO, HANDLER), s]);

const candles = loadBtcFixture();
const summaries: string[] = [];
for (let t = candles.length - 365; t < candles.length; t++) {
  const price = candles[t].close;
  const r = computeSrZones(candles, t, price);
  if (r.ok) summaries.push(buildSrZonesSummary('BTC', '1d', price, serveSrZonesFrame(r.frame, price, priceLevelStep(price, 0.1))));
}

describe('SR-ZONES-W1 AC1.4 — facts lint: self-test', () => {
  it.each([
    'price will hold here',
    'likely to break',
    'expected to stop',
    'a strong zone',
    'weaker than before',
    'a bounce zone',
    'a reversal level',
    'the target is 70k',
    'probability of a break',
    'this zone may hold',
    'Price should rise',
    'Forecasts a drop',
  ])('flags a prediction: %s', (s) => {
    expect(FORBIDDEN.test(s)).toBe(true);
  });

  it.each(['support zone 1 at 62484–63235, 6.44% below', 'former_support', 'no_zone_above'])(
    'passes a fact: %s',
    (s) => {
      expect(FORBIDDEN.test(s)).toBe(false);
    },
  );
});

describe('SR-ZONES-W1 AC1.4 — facts lint: emitted strings', () => {
  it('read the lib and the fixture (non-vacuity)', () => {
    expect(walk(LIB).map((f) => relative(LIB, f)).sort()).toEqual(['build-bars.ts', 'params.ts', 'rounding.ts', 'served.ts', 'summary.ts', 'zones.ts']); // SR-ZONES-W3 R5: + build-bars.ts
    expect(libLiterals.length).toBeGreaterThanOrEqual(20);
    expect(summaries).toHaveLength(365);
  });

  it.each(libLiterals)('%s literal has no prediction word: %s', (_file, s) => {
    expect(s.match(FORBIDDEN)).toBeNull();
  });

  it('read the handler\'s emitted strings (non-vacuity)', () => {
    const texts = handlerLiterals.map(([, s]) => s);
    expect(texts).toContain(
      'Check the coin symbol (e.g. BTC or ETH), or ask for a longer-listed coin or a shorter timeframe; nothing was charged.',
    );
    // R7 #2: the unserved reasons are templates in one table (SR_UNSERVED_REASONS), linted as written.
    expect(texts).toContain('{venue} is rate-limiting requests');
    expect(texts).toContain('No requested timeframe could be served for ');
    expect(texts).toContain('{venue} candle request failed');
    expect(texts).toContain('{venue} candle history did not load within {n} s; the read continues in the background');
  });

  it.each(handlerLiterals)('%s literal has no prediction word: %s', (_file, s) => {
    expect(s.match(FORBIDDEN)).toBeNull();
  });

  it('the description is Mr.1\'s R8 text, the param strings are the frozen §0 copy, and none carries a prediction word', () => {
    expect(GET_SR_ZONES_DESCRIPTION).toBe(
      'Returns support and resistance zones for one coin on one venue\'s perpetuals, such as Binance, Bybit or OKX, for one to three timeframes. Read-only. Per timeframe: up to 3 support and 3 resistance zones, ranked outward from price, each with its low and high, distance from price, bars touched in the last 90, tests in the last 30, last touch, and whether it flipped between support and resistance after two closes through it. Also returns volume against its 20-bar average and flags such as no zone above (price above every zone in its history). Use with get_trade_call or get_market_regime for the same coin.',
    );
    expect(PARAM_DESC_SR_ZONES_COIN).toBe('Coin symbol, e.g. BTC or ETH.');
    expect(PARAM_DESC_SR_ZONES_TIMEFRAMES).toBe('One to three candle timeframes, e.g. ["1h", "4h"]. One result per timeframe.');
    for (const s of [GET_SR_ZONES_DESCRIPTION, PARAM_DESC_SR_ZONES_COIN, PARAM_DESC_SR_ZONES_TIMEFRAMES, PARAM_DESC_SR_ZONES_VENUE]) {
      expect(s.match(FORBIDDEN)).toBeNull();
    }
  });

  it('the live smoke lints with the same pattern', () => {
    const smoke = readFileSync(join(REPO, 'scripts', 'sr-zones-smoke.mjs'), 'utf8');
    const m = smoke.match(/const FORBIDDEN =\s*\n?\s*\/(.+)\/([a-z]*);/);
    expect(m, 'scripts/sr-zones-smoke.mjs declares FORBIDDEN').not.toBeNull();
    expect(m![1]).toBe(FORBIDDEN.source);
    expect(m![2]).toBe(FORBIDDEN.flags);
  });

  it('the summary on each of the last 365 fixture candles carries no prediction word', () => {
    const hits = summaries.filter((s) => FORBIDDEN.test(s));
    expect(hits).toEqual([]);
  });
});

describe('SR-ZONES-W2 AC2.3 — facts lint: the docs page', () => {
  /** A page's visible text: every tag (and so every attribute) dropped, entities decoded. */
  const pageText = (html: string): string =>
    html
      .replace(/<[^>]+>/g, ' ')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ');
  const partial = pageText(readFileSync(join(REPO, 'docs-src', 'partials', 'get-support-resistance-zones.html'), 'utf8'));
  const docs = readFileSync(join(REPO, 'landing', 'docs.html'), 'utf8');
  const start = docs.indexOf('<section id="get-support-resistance-zones"');
  const rendered = pageText(docs.slice(start, docs.indexOf('</section>', start)));

  it('read the partial and its rendered section (non-vacuity)', () => {
    expect(start).toBeGreaterThan(-1);
    for (const t of [partial, rendered]) {
      expect(t).toContain(GET_SR_ZONES_DESCRIPTION);
      expect(t).toContain('BTC 1d at '); // the example's served summary
    }
    expect(rendered).toContain('Support and Resistance Zones (Beta)');
  });

  it('the partial and the rendered section carry no prediction word', () => {
    expect(partial.match(FORBIDDEN)).toBeNull();
    expect(rendered.match(FORBIDDEN)).toBeNull();
  });
});
