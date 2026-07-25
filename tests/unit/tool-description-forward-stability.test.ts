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
import { readFileSync, readdirSync } from 'node:fs';
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

/**
 * OPS-VENUE-COPY-LIVEBIND-W1 (2026-07-24) — extend the guard to the landing/docs COPY SOURCES.
 *
 * The stale-venue-count bug survived the entire 12→15 growth on the LANDING copy because no canary scanned
 * it: a hardcoded "5 crypto perp venues (Hyperliquid, Binance, Bybit, OKX, Bitget)" sat in
 * `landing/_jsonld/product.json.template`, which `scripts/generate_jsonld.mjs` renders into the inline ld+json
 * of ~11 pages. This closes that gap at the SOURCE.
 */

// The JSON-LD SOURCE templates (generate_jsonld.mjs is their single owner) — where the "5 crypto perp venues"
// bug lived. Scanned with the VENUE-count rule below (not the broad VOLATILE_COUNT_RE): the templates also
// carry a pre-existing hardcoded "11 timeframes" in an offer line — a stable, out-of-scope count this wave
// does not touch — which the broad rule would over-fire on.
const JSONLD_TEMPLATES: Array<[string, string]> = readdirSync(join(REPO_ROOT, 'landing', '_jsonld'))
  .filter((f) => f.endsWith('.json.template') || f.endsWith('.json'))
  .map((f) => [`landing/_jsonld/${f}`, readFileSync(join(REPO_ROOT, 'landing', '_jsonld', f), 'utf8')]);

// The exact documented bug PHRASE: "N [crypto] perp[etual][-futures] venues", or the frozen 5-venue list.
// NARROWER than VOLATILE_COUNT_RE on purpose: the templates + hand-authored pages + docs-src carry many
// pre-existing, out-of-scope hardcoded numbers — asset/timeframe/win-rate counts, "N exchange ADAPTERS"
// (a codebase floor, not a coverage claim), and accurate-but-baked "N exchanges" hero stats (consistent with
// the current 15, tracked as a forward-stability follow-up) — that the broad rule would over-fire on. A
// data-tr-field/injector span breaks digit↔phrase adjacency, so a live-bound count is not flagged.
const VENUE_COUNT_RE =
  /\b\d+\+?\s*(?:crypto\s+)?perp\w*[\s-]*(?:futures\s+)?venues?\b|Hyperliquid,\s*Binance,\s*Bybit,\s*OKX,\s*Bitget/i;

// Copy sources to scan for a VENUE-count re-stale: docs-src + the top-level hand-authored landing pages.
// landing/integrations/** is scanned SEPARATELY below (INTEGRATION_PAGES) with the broader
// VOLATILE_COUNT_RE — OPS-SKILLS-MAF-COPY-W1 closed the gap OPS-VENUE-COPY-LIVEBIND-W1 deferred here. This
// readdirSync of landing/ stays non-recursive (top-level pages only); the subpages have their own block.
const LANDING_VENUE_COPY: Array<[string, string]> = [
  ['docs-src/template.html', readFileSync(join(REPO_ROOT, 'docs-src', 'template.html'), 'utf8')],
  ...readdirSync(join(REPO_ROOT, 'landing'))
    .filter((f) => f.endsWith('.html'))
    .map((f) => [`landing/${f}`, readFileSync(join(REPO_ROOT, 'landing', f), 'utf8')] as [string, string]),
];

describe('OPS-VENUE-COPY-LIVEBIND-W1 — JSON-LD templates carry no baked count', () => {
  it('loaded the _jsonld templates (non-vacuity)', () => {
    expect(JSONLD_TEMPLATES.length).toBeGreaterThanOrEqual(3); // product + service + application, at minimum
  });
  it.each(JSONLD_TEMPLATES)('%s contains no baked venue/exchange count', (name, value) => {
    const m = value.match(VENUE_COUNT_RE);
    if (m) {
      throw new Error(
        `${name}: baked venue/exchange count "${m[0]}" — the JSON-LD templates feed every landing page's ` +
          `ld+json; use {{exchange_count}} / qualitative copy ("major crypto perpetual-futures venues"). This is ` +
          `exactly the product.json.template "5 crypto perp venues" bug that OPS-VENUE-COPY-LIVEBIND-W1 fixed.`,
      );
    }
    expect(m).toBeNull();
  });
});

describe('OPS-VENUE-COPY-LIVEBIND-W1 — landing/docs copy carries no baked VENUE count', () => {
  it('loaded the landing copy sources (non-vacuity)', () => {
    expect(LANDING_VENUE_COPY.length).toBeGreaterThanOrEqual(10);
  });
  it.each(LANDING_VENUE_COPY)('%s contains no baked "N perp venues" count', (name, value) => {
    const m = value.match(VENUE_COUNT_RE);
    if (m) {
      throw new Error(
        `${name}: baked venue count "${m[0]}" — public copy carries NO venue count (standing rule); use ` +
          `"major crypto perpetual-futures venues" or a live-bound data-tr-field span.`,
      );
    }
    expect(m).toBeNull();
  });
});

describe('OPS-VENUE-COPY-LIVEBIND-W1 — VENUE_COUNT_RE self-test', () => {
  it.each([
    '5 perp venues',
    '15 crypto perp venues',
    '12 crypto perpetual-futures venues',
    'across 5 crypto perp venues (Hyperliquid, Binance, Bybit, OKX, Bitget)',
  ])('MUST flag a baked venue count: %s', (s) => {
    expect(VENUE_COUNT_RE.test(s)).toBe(true);
  });
  it.each([
    'major crypto perpetual-futures venues',
    'across perp venues',
    'cross-venue funding-rate arbitrage',
    '<span data-tr-field="exchange_count">15</span> crypto perp venues', // live-bound span breaks adjacency
  ])('MUST NOT flag qualitative / live-bound copy: %s', (s) => {
    expect(VENUE_COUNT_RE.test(s)).toBe(false);
  });
});

// OPS-SKILLS-MAF-COPY-W1 (2026-07-25): the framework-integration subpages
// (landing/integrations/*.html) were the LAST landing surface still rendering a
// baked venue count. Their tutorial prose is authored in the EXTERNAL
// algovault-skills repo and rendered in via render-integrations.mjs, so
// OPS-VENUE-COPY-LIVEBIND-W1 deferred them here (see the LANDING_VENUE_COPY note
// above). Post-regen the pages are in-repo, so we scan them with the BROADER
// VOLATILE_COUNT_RE (not the venue-only VENUE_COUNT_RE) — the leak here included
// bare "5 venues" and "12 exchanges", which VENUE_COUNT_RE does not match. Raw-HTML
// scan: a live-bound `<span data-tr-field="…">15</span> exchanges` is NOT flagged
// because the closing tag breaks digit↔noun adjacency (the same idempotency
// contract render-integrations.mjs relies on) — only a bare prose count matches.
const INTEGRATION_PAGES: Array<[string, string]> = readdirSync(
  join(REPO_ROOT, 'landing', 'integrations'),
)
  .filter((f) => f.endsWith('.html'))
  .sort()
  .map(
    (f) =>
      [`landing/integrations/${f}`, readFileSync(join(REPO_ROOT, 'landing', 'integrations', f), 'utf8')] as [
        string,
        string,
      ],
  );

describe('OPS-SKILLS-MAF-COPY-W1 — framework-integration subpages carry no baked count', () => {
  it('loaded the integration subpages (non-vacuity)', () => {
    // 12 exchanges + 4 frameworks + 5 mcp-clients = 21 today; guard against an
    // empty/renamed dir silently passing every assertion below.
    expect(INTEGRATION_PAGES.length).toBeGreaterThanOrEqual(15);
  });
  it.each(INTEGRATION_PAGES)('%s contains no baked exchange/asset/venue/timeframe count', (name, value) => {
    const m = value.match(VOLATILE_COUNT_RE);
    if (m) {
      throw new Error(
        `${name}: baked count "${m[0]}" on a rendered integration subpage — tutorial copy (authored in ` +
          `algovault-skills) must describe coverage qualitatively ("major crypto perpetual-futures venues"); a live ` +
          `count belongs in a live-bound data-tr-field span, never bare prose. render-integrations.mjs normalises ` +
          `"N venues"/"N exchanges" at generation time — this catches an upstream edit that slips a new one past it.`,
      );
    }
    expect(m).toBeNull();
  });
});

describe('OPS-SKILLS-MAF-COPY-W1 — integration-page scan predicate self-test', () => {
  // Proves the scan above actually discriminates (not vacuously green): a synthetic
  // subpage carrying the retired literal MUST fail; the count-free + live-bound-span
  // forms MUST pass.
  it('flags a subpage with a bare "5 crypto perp venues"', () => {
    const page = '<html><body><p>Composite trade calls across 5 crypto perp venues.</p></body></html>';
    expect(VOLATILE_COUNT_RE.test(page)).toBe(true);
  });
  it('passes a count-free subpage with a live-bound exchange_count span', () => {
    const page =
      '<p>across major crypto perpetual-futures venues</p>' +
      '<li>fused across <span data-tr-field="exchange_count">15</span> exchanges — not derivable</li>';
    expect(VOLATILE_COUNT_RE.test(page)).toBe(false);
  });
});
