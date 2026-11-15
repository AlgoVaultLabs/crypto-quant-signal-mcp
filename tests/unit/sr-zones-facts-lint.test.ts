/**
 * SR-ZONES-W1 AC1.4 — the facts-only lint. get_sr_zones states where zones are; it never says what price will do.
 * Every string literal under src/lib/sr-zones/**, NOTE, ORDER and the summary on each of the last 365 fixture
 * candles must match none of FORBIDDEN. (The tool description and its param strings join this list in CH2, when they
 * land in src/tool-descriptions.ts.)
 *
 * The lint is a gate that could pass vacuously, so it carries a two-way self-test of the regex and a floor on how
 * many strings it read.
 */
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSrZones } from '../../src/lib/sr-zones/zones.js';
import { SR_ZONES_NOTE, SR_ZONES_ORDER, buildSrZonesSummary } from '../../src/lib/sr-zones/summary.js';
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

const candles = loadBtcFixture();
const summaries: string[] = [];
for (let t = candles.length - 365; t < candles.length; t++) {
  const r = computeSrZones(candles, t, candles[t].close);
  if (r.ok) summaries.push(buildSrZonesSummary('BTC', '1d', candles[t].close, r.frame));
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

  it.each([SR_ZONES_NOTE, SR_ZONES_ORDER, 'support zone 1 at 62484–63235, 6.44% below', 'former_support', 'no_zone_above'])(
    'passes a fact: %s',
    (s) => {
      expect(FORBIDDEN.test(s)).toBe(false);
    },
  );
});

describe('SR-ZONES-W1 AC1.4 — facts lint: emitted strings', () => {
  it('read the lib and the fixture (non-vacuity)', () => {
    expect(walk(LIB).map((f) => relative(LIB, f)).sort()).toEqual(['params.ts', 'summary.ts', 'zones.ts']);
    expect(libLiterals.length).toBeGreaterThanOrEqual(20);
    expect(summaries).toHaveLength(365);
  });

  it.each(libLiterals)('%s literal has no prediction word: %s', (_file, s) => {
    expect(s.match(FORBIDDEN)).toBeNull();
  });

  it('NOTE and ORDER are the frozen §0 strings and carry no prediction word', () => {
    expect(SR_ZONES_NOTE).toBe('Zones mark where price has clustered before. Price can move through any zone.');
    expect(SR_ZONES_ORDER).toBe(
      'Zones are ranked from the most recent price cluster outward: each next zone formed earlier and sits further from price.',
    );
    expect(SR_ZONES_NOTE.match(FORBIDDEN)).toBeNull();
    expect(SR_ZONES_ORDER.match(FORBIDDEN)).toBeNull();
  });

  it('the summary on each of the last 365 fixture candles carries no prediction word', () => {
    const hits = summaries.filter((s) => FORBIDDEN.test(s));
    expect(hits).toEqual([]);
  });
});
