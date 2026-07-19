/**
 * GEO-REGISTRY-RANK-TDQS-W1 forward-stability canary (2026-06-17).
 *
 * Locks the forward-stability rule: a tool description (or param describe()
 * string) must NEVER hardcode a VOLATILE count — exchange / asset / venue /
 * timeframe counts, or a win-rate %. Volatile counts are the root cause of the
 * stale registry-listing bug class (e.g. a Glama listing frozen at an old
 * "N exchanges / M+ assets" because the number was baked into description text
 * instead of described qualitatively). Capability is described QUALITATIVELY
 * ("across major crypto perpetual venues"), never enumerated.
 *
 * The check regexes the actual EXPORTED string constants (what ships in
 * tools/list), so any NEW description added later is covered automatically —
 * a future hardcoded count fails CI here.
 *
 * Note: a param RANGE like "1-100" (a capability bound, e.g. topN) is NOT a
 * volatile count — it is a fixed parameter domain. The regexes below target
 * "<number> <exchanges|assets|venues|timeframes>" and "NN%" specifically.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as descriptions from '../../src/tool-descriptions.js';

const __filename_ = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename_), '..', '..');

/**
 * "<n> [qualifier...] exchanges|assets|venues|timeframes|perps" — singular/plural,
 * optional trailing "+", and up to 3 SPACE-SEPARATED qualifier words between the
 * count and the noun.
 *
 * WIDENED by OPS-RELEASE-TEMPLATE-AND-CANARY-HARDENING-W1 (2026-07-18). The prior
 * regex required the number to sit ADJACENT to the noun, so a qualifier between them
 * evaded it entirely: `package.json.description` carried a stale "5 perp venues" for
 * weeks (real coverage was 12) and NO gate caught it — see NPM-PUBLISH-v1.23.3-W1.
 *
 * Why each qualifier must be SPACE-separated (`(?:\s+[a-z][a-z-]*){0,3}`) rather than
 * the looser `\s*(?:[a-z][a-z-]*\s+){0,3}`: the loose form splits timeframe tokens into
 * <count>+<qualifier> and false-positives on ordinary trading copy — "1h and 4h
 * timeframes", "the 4h timeframe", "15m timeframe", "24h funding across venues" all
 * matched. Requiring whitespace after the digits makes "4h"/"15m"/"24h" unsplittable,
 * while still catching "12 perp venues". This regex is a strict SUPERSET of the prior
 * one (the zero-qualifier branch keeps `\s*`), so nothing previously caught is lost.
 */
const VOLATILE_COUNT_RE =
  /\b\d+\+?(?:\s+[a-z][a-z-]*){0,3}\s*(exchanges?|assets?|venues?|timeframes?|perps?)\b/i;
// A win-rate / percentage figure (two-digit %, optional decimals).
const WIN_RATE_RE = /\b\d{2}(\.\d+)?%/;

/**
 * Public PACKAGE-MANIFEST description fields — the npm page, the MCP-registry entry,
 * the DXT/Claude-Desktop catalog card and the LobeHub listing. These are shipped copy
 * that no other canary covered, and are exactly where the v1.23.3 bug lived.
 */
function manifestDescriptions(): Array<[string, string]> {
  const read = (f: string): any => JSON.parse(readFileSync(join(REPO_ROOT, f), 'utf8'));
  const out: Array<[string, string]> = [];
  for (const f of ['package.json', 'server.json', 'manifest.json']) {
    const d = read(f)?.description;
    if (typeof d === 'string' && d.length > 0) out.push([`${f}.description`, d]);
  }
  const lobehub = read('lobehub-manifest.json');
  if (typeof lobehub?.description === 'string' && lobehub.description.length > 0) {
    out.push(['lobehub-manifest.json.description', lobehub.description]);
  }
  for (const [i, entry] of (lobehub?.api ?? []).entries()) {
    if (typeof entry?.description === 'string' && entry.description.length > 0) {
      out.push([`lobehub-manifest.json.api[${i}:${entry?.name ?? '?'}].description`, entry.description]);
    }
  }
  return out;
}

const MANIFEST_DESCRIPTIONS = manifestDescriptions();

// Every exported STRING constant in tool-descriptions.ts = a tool description,
// a param describe() string, or the alias suffix. (TOP_20_KEYWORDS is an array
// and is filtered out by the typeof check.)
const STRING_CONSTANTS: Array<[string, string]> = Object.entries(descriptions).filter(
  (entry): entry is [string, string] => typeof entry[1] === 'string',
);

describe('GEO-REGISTRY-RANK-TDQS-W1 — description forward-stability canary', () => {
  it('covers a non-trivial set of exported description strings', () => {
    // Guards against the filter silently matching nothing (then every assertion
    // below would vacuously pass).
    expect(STRING_CONSTANTS.length).toBeGreaterThanOrEqual(20);
  });

  it.each(STRING_CONSTANTS)('%s contains no hardcoded exchange/asset/venue/timeframe count', (name, value) => {
    const m = value.match(VOLATILE_COUNT_RE);
    if (m) {
      throw new Error(`${name}: volatile count "${m[0]}" — describe capability qualitatively, do not enumerate.`);
    }
    expect(m).toBeNull();
  });

  it.each(STRING_CONSTANTS)('%s contains no hardcoded win-rate / percentage figure', (name, value) => {
    const m = value.match(WIN_RATE_RE);
    if (m) {
      throw new Error(`${name}: win-rate/% figure "${m[0]}" — public track-record numbers come from live /api/performance-public, never baked into copy.`);
    }
    expect(m).toBeNull();
  });
});

/**
 * OPS-RELEASE-TEMPLATE-AND-CANARY-HARDENING-W1 (2026-07-18).
 *
 * Two additions, both motivated by NPM-PUBLISH-v1.23.3-W1:
 *  1. The regex itself is now unit-tested. A guard with no self-test can silently
 *     stop matching (or start over-matching) and every assertion above would pass
 *     vacuously — the failure mode that let "5 perp venues" ship.
 *  2. Coverage extends to the published package-manifest descriptions, which no
 *     canary previously scanned.
 */
describe('OPS-RELEASE-TEMPLATE-AND-CANARY-HARDENING-W1 — VOLATILE_COUNT_RE self-test', () => {
  // Real + realistic baked counts. `12 perp venues` and `5 perp venues` are the exact
  // strings that EVADED the pre-2026-07-18 regex (qualifier between count and noun).
  it.each([
    '12 perp venues',
    '5 perp venues',
    '7 crypto perp venues',
    '12 exchanges',
    '720+ assets',
    '11 timeframes',
    '12 perps',
    'top 5 venues by volume',
  ])('MUST flag a baked count: %s', (sample) => {
    expect(VOLATILE_COUNT_RE.test(sample)).toBe(true);
  });

  // Qualitative capability copy + ordinary trading vocabulary. The timeframe tokens
  // (1h / 4h / 15m / 24h) are the false-positive class that a looser regex — one
  // allowing the qualifier to start immediately after the digits — would wrongly flag.
  it.each([
    'across major crypto perp venues',
    'across perp venues',
    'leading crypto perp venues',
    'major crypto perps',
    '1h and 4h timeframes',
    'the 4h timeframe',
    '15m timeframe',
    '24h funding across venues',
    '1h, 4h and 1d timeframes',
  ])('MUST NOT flag qualitative / timeframe copy: %s', (sample) => {
    expect(VOLATILE_COUNT_RE.test(sample)).toBe(false);
  });
});

describe('OPS-RELEASE-TEMPLATE-AND-CANARY-HARDENING-W1 — published manifest descriptions', () => {
  it('actually loaded the manifest description fields', () => {
    // Non-vacuity guard: if the reads silently yielded nothing, the assertions below
    // would pass on an empty set. package.json + server.json + manifest.json alone = 3.
    expect(MANIFEST_DESCRIPTIONS.length).toBeGreaterThanOrEqual(3);
  });

  it.each(MANIFEST_DESCRIPTIONS)('%s contains no hardcoded exchange/asset/venue/timeframe count', (name, value) => {
    const m = value.match(VOLATILE_COUNT_RE);
    if (m) {
      throw new Error(
        `${name}: volatile count "${m[0]}" — published manifest copy must describe coverage qualitatively ` +
          `(e.g. "across major crypto perp venues"). A baked count goes stale silently on the npm/registry/DXT/LobeHub ` +
          `listing; NPM-PUBLISH-v1.23.3-W1 shipped "5 perp venues" while real coverage was 12.`,
      );
    }
    expect(m).toBeNull();
  });
});
