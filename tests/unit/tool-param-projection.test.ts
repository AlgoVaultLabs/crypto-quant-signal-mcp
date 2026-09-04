/**
 * DOCS-PARAM-SCHEMA-PROJECTION-W1 — the `/docs` parameter tables project from the served schema.
 *
 * THE BUG. `/docs` told integrators `get_trade_call` accepted FIVE venues. `tools/list` published
 * SEVENTEEN, on the same host, on every request — the cross-venue differentiator under-reported by
 * 70%, and a live correctness trap (`exchange: "WHITEBIT"` is valid; the page implied otherwise).
 * The same page named `1h` as `scan_trade_calls`'s timeframe default while the server defaulted to
 * `15m`, so a caller omitting it got different candles than documented.
 *
 * WHY NO GATE CAUGHT IT. `build_docs --check` compares BYTES: a partial may assert anything at all
 * and the check is green so long as the rendered page matches its source. Every row was
 * hand-typed, so "fresh" meant "someone remembered".
 *
 * These tests pin the two halves of the fix: the declaration is genuinely SINGLE (nothing copies
 * the venue list any more), and the projection is genuinely WIRED (the marker regions are filled,
 * and are NOT on the list that would freeze them).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROMOTED_VENUE_IDS, TIMEFRAMES } from '../../src/lib/capabilities.js';
import { FUNDING_VENUE_LIST_TEXT } from '../../src/lib/funding-venues.js';
import {
  VENUE_IDS_ALL,
  PUBLIC_TOOL_ENUM_PARAMS,
  TOOL_DOCS_PARTIAL,
  PARAM_DOC_BLURB,
  REGIME_TIMEFRAMES,
  SCAN_TIMEFRAME_DEFAULT,
} from '../../src/lib/tool-param-schema.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const DOCS_HTML = read('landing/docs.html');

/** The 17-venue list as it was hand-typed in four places before this wave. */
const HARDCODED_17 = /'HL',\s*'BINANCE',\s*'BYBIT',\s*'OKX',\s*'BITGET',\s*'ASTER',\s*'EDGEX'/;

describe('the accepted-venue set is declared ONCE', () => {
  it('VENUE_IDS_ALL is a strict superset of the promoted set, differing by exactly BITMART + EDGEX', () => {
    // OPS-WEEX-PROMOTE-W1: WEEX joined the promoted set 2026-09-04 and left this difference.
    const promoted = new Set<string>(PROMOTED_VENUE_IDS);
    for (const v of promoted) expect(VENUE_IDS_ALL).toContain(v);
    expect(VENUE_IDS_ALL.filter((v) => !promoted.has(v)).sort()).toEqual(['BITMART', 'EDGEX']);
  });

  it('has no duplicates — a set comparison would hide one, a length check would not catch it', () => {
    expect(new Set(VENUE_IDS_ALL).size).toBe(VENUE_IDS_ALL.length);
  });

  // THE regression this wave exists to prevent. Four copies is how the docs got to 5-vs-17; a
  // fifth would put us straight back, and a reviewer cannot see a copy that is merely correct today.
  for (const f of ['src/index.ts', 'src/tools/scan-trade-calls.ts', 'src/lib/x402-bazaar.ts']) {
    it(`${f} carries NO hand-typed venue list — it projects from the declaration`, () => {
      expect(read(f)).not.toMatch(HARDCODED_17);
    });
  }

  it('src/lib/tool-param-schema.ts is the only place the literal list appears in src/', () => {
    const hits: string[] = [];
    const walk = (rel: string) => {
      for (const e of readdirSync(join(REPO_ROOT, rel), { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(rel, e.name));
        else if (e.name.endsWith('.ts') && HARDCODED_17.test(read(join(rel, e.name)))) hits.push(join(rel, e.name));
      }
    };
    walk('src');
    expect(hits).toEqual(['src/lib/tool-param-schema.ts']);
  });
});

describe('the per-tool difference is preserved, not flattened', () => {
  // DOCS-SUPPORT-ANSWERS-AND-PUBLIC-VENUE-SCOPE-W1 rewrote this from `scan.length < all.length`.
  // That assertion was correct while get_trade_call accepted the DECLARED set (17) and scan the
  // PROMOTED set (15); CH1 narrowed the public enums to the promoted set, so the two are now equal
  // BY DERIVATION and a strict-subset assertion fails on correct code. The test's intent —
  // per-tool differences survive the projection rather than being flattened — is unchanged and is
  // still carried by the get_market_regime timeframe-subset case below, which remains a real subset.
  it('get_trade_call and scan_trade_calls now accept the SAME venue set — equal by derivation', () => {
    const all = PUBLIC_TOOL_ENUM_PARAMS.get_trade_call.exchange.values;
    const scan = PUBLIC_TOOL_ENUM_PARAMS.scan_trade_calls.exchange.values;
    expect([...all].sort()).toEqual([...scan].sort());
    expect(all).not.toContain('EDGEX');
    expect(all).not.toContain('BITMART');
    expect(all).toContain('WEEX');   // OPS-WEEX-PROMOTE-W1 — publicly served since 2026-09-04
  });

  it('get_market_regime takes a deliberate timeframe SUBSET, not the full set', () => {
    expect(REGIME_TIMEFRAMES.length).toBeLessThan(TIMEFRAMES.length);
    for (const t of REGIME_TIMEFRAMES) expect(TIMEFRAMES).toContain(t);
    expect(PUBLIC_TOOL_ENUM_PARAMS.get_market_regime.timeframe.values).toEqual([...REGIME_TIMEFRAMES]);
  });

  it('every projected parameter has an authored blurb — a bare chip list reads as a schema dump', () => {
    for (const params of Object.values(PUBLIC_TOOL_ENUM_PARAMS)) {
      for (const name of Object.keys(params)) expect(PARAM_DOC_BLURB[name], `no blurb for ${name}`).toBeTruthy();
    }
  });
});

describe('build_docs OWNS these regions — and must never register them as foreign', () => {
  it('no tool-params region appears in foreignMarkerRegions', async () => {
    // Registering one there is not a style slip, it is a silent revert. That list has two
    // consumers: `blankMarkers`, so `--check` would stop comparing the region, and
    // `preserveForeignMarkers`, which UNCONDITIONALLY copies the existing on-disk content over the
    // freshly generated one. A projected region on that list renders exactly once and then freezes
    // forever, with a green `--check` reporting no drift because it is no longer looking.
    const mod = await import('../../scripts/build_docs.mjs');
    const names = mod.foreignMarkerRegions(['signup-flow', 'connect-mcp-client']).map((r: { name: string }) => r.name);
    for (const n of names) expect(n).not.toMatch(/tool-params/);
  });

  it('renders one row per enum parameter, tagging every accepted value', async () => {
    const { renderToolParamRows } = await import('../../scripts/build_docs.mjs');
    const html = renderToolParamRows(
      'demo_tool',
      { exchange: { values: ['HL', 'BINANCE'], default: 'BINANCE' } },
      { exchange: 'Venue to query.' },
    );
    expect(html).toContain('data-schema-tool="demo_tool"');
    expect(html).toContain('data-schema-param="exchange"');
    expect(html).toContain('data-schema-default="BINANCE"');
    expect([...html.matchAll(/data-enum-value="([^"]+)"/g)].map((m) => m[1])).toEqual(['HL', 'BINANCE']);
    // The default chip must NOT be tagged: the default is also an accepted value, and tagging it
    // would double-count that venue and quietly turn P7's set comparison into a multiset one.
    expect(html.match(/Default: <code[^>]*>/)?.[0]).not.toContain('data-enum-value');
  });

  it('REFUSES to generate when a declared tool has no marker — a projection landing nowhere is the original bug', async () => {
    const { fillToolParamRegions } = await import('../../scripts/build_docs.mjs');
    const schemaMod = { PUBLIC_TOOL_ENUM_PARAMS: { ghost_tool: { x: { values: ['a'] } } }, PARAM_DOC_BLURB: {} };
    expect(fillToolParamRegions('<html></html>', schemaMod).missing).toEqual(['ghost_tool']);
  });
});

describe('the published page reflects the declaration', () => {
  for (const [tool, params] of Object.entries(PUBLIC_TOOL_ENUM_PARAMS)) {
    for (const [param, spec] of Object.entries(params)) {
      it(`landing/docs.html renders ${tool}.${param} with all ${spec.values.length} accepted value(s)`, () => {
        const row = DOCS_HTML.match(
          new RegExp(`<tr class="param-row" data-schema-tool="${tool}" data-schema-param="${param}"[^>]*>([\\s\\S]*?)</tr>`),
        );
        expect(row, `${tool}.${param} is not rendered`).not.toBeNull();
        const rendered = [...row![1].matchAll(/data-enum-value="([^"]+)"/g)].map((m) => m[1]);
        expect(rendered.sort()).toEqual([...spec.values].sort());
      });
    }
  }

  it('carries the corrected scan default — the page said 1h while the server defaulted to 15m', () => {
    expect(SCAN_TIMEFRAME_DEFAULT).toBe('15m');
    expect(DOCS_HTML).toMatch(
      new RegExp(`data-schema-tool="scan_trade_calls" data-schema-param="timeframe" data-schema-default="${SCAN_TIMEFRAME_DEFAULT}"`),
    );
  });

  it('every documented tool has a partial mapping, and every mapped partial exists', () => {
    for (const tool of Object.keys(PUBLIC_TOOL_ENUM_PARAMS)) expect(TOOL_DOCS_PARTIAL[tool], tool).toBeTruthy();
    for (const partial of Object.values(TOOL_DOCS_PARTIAL)) {
      expect(() => read(`docs-src/partials/${partial}.html`)).not.toThrow();
      expect(DOCS_HTML).toContain(`<section id="${partial}"`);
    }
  });
});

describe('no hand-typed venue list survives on the docs source', () => {
  // AC4 as a standing gate rather than a one-off grep — and BROADER than AC4's own evidence line,
  // which greps for `<N> exchanges` and would have missed both offenders found while building this:
  // an FAQ answer naming "Binance, Hyperliquid, Bybit, OKX, or Bitget" (the stale five, with no
  // digit anywhere in it), and another rendering "15 exchanges — <five names>" where the live-bound
  // count and the hand-typed list visibly contradicted each other on the published page.
  const PARTIALS = join(REPO_ROOT, 'docs-src/partials');
  const files = readdirSync(PARTIALS).filter((f) => f.endsWith('.html'));

  it('no partial hardcodes an exchange count outside a live-bound span', () => {
    const offenders: string[] = [];
    for (const f of files) {
      for (const line of read(`docs-src/partials/${f}`).split('\n')) {
        if (!/\b\d+\s+exchanges?\b/i.test(line)) continue;
        if (/data-tr-field="exchange_count"/.test(line)) continue;   // Class A live binding
        offenders.push(`${f}: ${line.trim().slice(0, 100)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no partial enumerates our venues by hand — the projected table is the only venue list', () => {
    // The funding-arb list is the ONE exception and it is not an exemption: it is a different SoT
    // (`FUNDING_VENUE_META`, 7 venues that expose a usable predicted-funding feed) already owned by
    // `numerical-claim-live-bind.test.ts`, which asserts the copy equals FUNDING_VENUE_LIST_TEXT and
    // that its name count equals FUNDING_VENUE_COUNT. So this test defers to that owner by matching
    // the canonical string, never by listing a filename — an exemption keyed on a path goes stale
    // the moment the copy moves, and stops guarding without saying so.
    const LABELS = ['Hyperliquid', 'Binance', 'Bybit', 'OKX', 'Bitget', 'Aster', 'BingX', 'Gate',
      'HTX', 'KuCoin', 'MEXC', 'Phemex', 'WhiteBIT', 'BitMart', 'XT', 'EdgeX', 'WEEX'];
    const offenders: string[] = [];
    for (const f of files) {
      for (const raw of read(`docs-src/partials/${f}`).split('\n')) {
        const line = raw.replace(FUNDING_VENUE_LIST_TEXT, '');
        const named = LABELS.filter((l) => new RegExp(`\\b${l}\\b`).test(line));
        if (named.length >= 4) offenders.push(`${f}: names ${named.length} venues by hand — ${named.join(', ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
