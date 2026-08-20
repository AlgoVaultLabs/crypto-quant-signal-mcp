/**
 * DOCS-COMPLETENESS-AND-NAVIGATION-W1 CH1 — the docs CONTAIN the answer instead of pointing at it.
 *
 * THE BUG. `/docs` rendered `rankBy` as *"`oi` (default), `oi_change`, `volume`, … See
 * `/capabilities` for the live lens set"* — **3 of 9**, with the rest outsourced to another
 * endpoint. Five lenses (`gainers`, `losers`, `movers`, `funding_positive`, `funding_negative`)
 * appeared NOWHERE on the page: measured `grep` count 0. A reader wanting to rank by funding had to
 * leave the docs to discover the lens exists. Four of six tools documented no response shape at all.
 *
 * WHY THE EXISTING GATES DID NOT CATCH IT. `DOCS-SAMPLE-EXECUTABLE-W1` proved the samples run;
 * `DOCS-PARAM-SCHEMA-PROJECTION-W1` proved the parameters match the served schema. Both assert
 * CORRECTNESS. Neither asserts COMPLETENESS — a table can be right about the three values it shows
 * and silent about six, and every gate stays green.
 *
 * These tests pin the two halves of the fix: the closed-set declaration is genuinely SINGLE (it
 * holds the imported SoT by reference, so a copied literal cannot pass), and the projection is
 * genuinely WIRED (the region is filled, is not on the freeze list, and does not advertise itself
 * as a Zod enum — which would make the live P7 gate red, correctly, because `rankBy` publishes no
 * `enum` on the wire).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RANK_BY_VALUES, RANK_BY_ALIASES, resolveRankBy } from '../../src/lib/rank-constants.js';
import { publicToolEntries } from '../../src/lib/nav-manifest.js';
import {
  PUBLIC_TOOL_CLOSED_SET_PARAMS,
  PUBLIC_TOOL_ENUM_PARAMS,
  SCAN_RANK_BY_DEFAULT,
  aliasByCanonical,
  assertClosedSetCoverage,
} from '../../src/lib/tool-param-schema.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const DOCS_HTML = read('landing/docs.html');
const RANK_BY = PUBLIC_TOOL_CLOSED_SET_PARAMS.scan_trade_calls.rankBy;

describe('the closed set is DECLARED once, by reference', () => {
  // The whole point of `valueSource`. A copied literal is correct on the day it is written and
  // wrong on the day a tenth lens ships — which is exactly how the venue list reached 5-vs-17.
  // An identity check cannot be satisfied by a copy no matter how faithful.
  it('valueSource IS RANK_BY_VALUES — the imported array, not a copy of it', () => {
    expect(RANK_BY.valueSource).toBe(RANK_BY_VALUES);
  });

  it('aliasSource IS RANK_BY_ALIASES — same reason', () => {
    expect(RANK_BY.aliasSource).toBe(RANK_BY_ALIASES);
  });

  it('every declared value has an authored description — a blank cell is the deferral again', () => {
    expect(assertClosedSetCoverage()).toEqual([]);
  });

  it('the documented default is the one the resolver treats as canonical', () => {
    expect(resolveRankBy(SCAN_RANK_BY_DEFAULT)).toBe(SCAN_RANK_BY_DEFAULT);
    expect(RANK_BY.default).toBe(SCAN_RANK_BY_DEFAULT);
  });

  // `rankBy` is `z.string().max(32)` on purpose so `resolveRankBy` owns validity and the TG bot can
  // forward `nfr` verbatim. Declaring it as an ENUM param would make the live P7 leg red on
  // "renders a fixed value list but the live schema declares no enum" — correctly, because the
  // served schema has no `enum`. The two declarations answer different questions and must stay apart.
  it('rankBy is NOT in the enum declaration — docs enumerate it, the API still accepts any string', () => {
    for (const params of Object.values(PUBLIC_TOOL_ENUM_PARAMS)) {
      expect(Object.keys(params)).not.toContain('rankBy');
    }
  });
});

describe('the token math: 9 canonical + 8 alias-only, never 18', () => {
  // `oi` maps to ITSELF in RANK_BY_ALIASES, so 9 values and 9 alias keys are 17 distinct tokens.
  // Rendering "all 9 aliases" literally would print `oi` in both cells of its own row.
  it('the inversion drops the self-mapping alias', () => {
    const inv = aliasByCanonical(RANK_BY);
    expect(inv.oi).toBeNull();
    expect(Object.values(inv).filter(Boolean)).toHaveLength(8);
  });

  it('every alias-only token resolves back to the lens it is rendered beside', () => {
    const inv = aliasByCanonical(RANK_BY);
    for (const [canonical, alias] of Object.entries(inv)) {
      if (alias) expect(resolveRankBy(alias)).toBe(canonical);
    }
  });

  it('the union of values and alias keys is 17', () => {
    expect(new Set([...RANK_BY_VALUES, ...Object.keys(RANK_BY_ALIASES)]).size).toBe(17);
  });

  it('every canonical value is covered by the inversion — none silently unrendered', () => {
    expect(Object.keys(aliasByCanonical(RANK_BY)).sort()).toEqual([...RANK_BY_VALUES].sort());
  });
});

describe('the published page renders the whole set', () => {
  const lensRows = [
    ...DOCS_HTML.matchAll(
      /<tr class="param-row"[^>]*data-closed-set-tool="scan_trade_calls"[^>]*data-closed-set-param="rankBy"[^>]*>([\s\S]*?)<\/tr>/g,
    ),
  ];

  it('renders exactly one row per lens — a self-mapping alias must not produce a second', () => {
    expect(lensRows).toHaveLength(RANK_BY_VALUES.length);
  });

  for (const v of RANK_BY_VALUES) {
    it(`lens ${v} is tagged data-enum-value on landing/docs.html`, () => {
      expect(DOCS_HTML).toContain(`data-enum-value="${v}"`);
    });
  }

  it('every alias-only token renders beside its lens', () => {
    const inv = aliasByCanonical(RANK_BY);
    for (const [canonical, alias] of Object.entries(inv)) {
      if (!alias) continue;
      const row = lensRows.find((m) => m[1].includes(`data-enum-value="${canonical}"`));
      expect(row, `no row for ${canonical}`).toBeTruthy();
      expect(row![1], `${canonical} does not render its alias ${alias}`).toContain(`>${alias}</code>`);
    }
  });

  it('the lens row does NOT carry data-schema-param — that would red the live P7 leg', () => {
    for (const m of lensRows) expect(m[0]).not.toContain('data-schema-param');
  });

  it('the retired deferral is gone from the source partial and the rendered page', () => {
    expect(read('docs-src/partials/scan-trade-calls.html')).not.toContain('See <code');
    expect(DOCS_HTML).not.toMatch(/&hellip;\s*See\s*<code[^>]*>\/capabilities/);
  });
});

describe('every public tool documents what it returns', () => {
  // 2 of 6 when this wave opened. The list DERIVES from the nav manifest, so a seventh tool joins
  // this assertion by being published rather than by anyone remembering to add it here.
  for (const e of publicToolEntries()) {
    it(`${e.name} has a Response Fields block`, () => {
      const partial = read(`docs-src/partials/${e.anchor}.html`);
      expect(partial).toContain('Response Fields');
      expect(DOCS_HTML).toContain(`<section id="${e.anchor}"`);
    });
  }

  it('covers all 6 published tools — the count the docs --check gate also pins', () => {
    expect(publicToolEntries()).toHaveLength(6);
  });
});

describe('build_docs OWNS the closed-set region — and must never register it as foreign', () => {
  it('no closed-set region appears in foreignMarkerRegions', async () => {
    // Registering one there is not a style slip, it is a silent revert. That list feeds
    // `blankMarkers` (so `--check` stops comparing the region) AND `preserveForeignMarkers` (which
    // UNCONDITIONALLY copies the on-disk content over the freshly generated one). A projected
    // region on that list renders exactly once and then freezes forever, with a green `--check`
    // reporting no drift because it is no longer looking.
    const mod = await import('../../scripts/build_docs.mjs');
    const names = mod.foreignMarkerRegions(['signup-flow']).map((r: { name: string }) => r.name);
    for (const n of names) expect(n).not.toMatch(/closed-set/);
  });

  it('REFUSES to generate when a declared tool has no marker — a projection landing nowhere is the bug', async () => {
    const { fillToolClosedSetRegions } = await import('../../scripts/build_docs.mjs');
    const schemaMod = {
      PUBLIC_TOOL_CLOSED_SET_PARAMS: { ghost_tool: { x: { valueSource: ['a'], aliasSource: {}, selects: { a: 'y' } } } },
      aliasByCanonical,
    };
    expect(fillToolClosedSetRegions('<html></html>', schemaMod).missing).toEqual(['ghost_tool']);
  });

  it('renders the alias cell as an em-dash when the lens has no distinct alias', async () => {
    const { renderToolClosedSetRows } = await import('../../scripts/build_docs.mjs');
    const html = renderToolClosedSetRows('t', 'p', RANK_BY, aliasByCanonical);
    const oiRow = html.split('\n').find((l: string) => l.includes('data-enum-value="oi"'));
    expect(oiRow).toContain('&mdash;');
    expect(oiRow).not.toContain('>oi</code></td><td class="text-gray-400"><code');
  });
});

describe('the deferral guard catches a known-bad fixture', () => {
  it('fires on the exact construction this wave deleted, and names the parameter', async () => {
    const { findParamDeferrals } = await import('../../scripts/check-docs-samples-live.mjs');
    const bad = '<tr class="param-row"><td>rankBy</td><td>string</td><td>Lens: <code>oi</code>, &hellip; See <code>/capabilities</code>.</td></tr>';
    const hits = findParamDeferrals(bad);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/^rankBy:/);
  });

  it('stays silent on the page we actually ship', async () => {
    const { findParamDeferrals } = await import('../../scripts/check-docs-samples-live.mjs');
    expect(findParamDeferrals(DOCS_HTML)).toEqual([]);
  });
});
