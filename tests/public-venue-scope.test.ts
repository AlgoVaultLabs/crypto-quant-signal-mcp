/**
 * DOCS-SUPPORT-ANSWERS-AND-PUBLIC-VENUE-SCOPE-W1 CH1 — the published venue set IS the promoted set.
 *
 * THE BUG. `DOCS-PARAM-SCHEMA-PROJECTION-W1` projected the DECLARED venue set (`VENUE_IDS_ALL`, 17)
 * into `/docs`, so the page began advertising EDGEX (`venue_status: retired`, klines ~200×timeframe
 * stale, WR 25.2% — `INVESTIGATE-EDGEX-WR-W1`) and WEEX (`shadow`) as selectable. A reader picking
 * EDGEX off the table got a stale verdict from a venue we had stopped supporting. The projection was
 * right; the set was wrong. CH1 narrows what the API ACCEPTS so docs and schema agree at 15 without
 * a docs filter — which would have forced P7 down from set-equality to a subset check, weakening a
 * gate shipped two waves ago to hide a scope problem.
 *
 * WHAT THIS FILE CAN AND CANNOT SEE. `TRADE_CALL_SCHEMA` is function-scoped inside `startMcp()`, so
 * no test can import the live Zod object. Case 4 therefore runs the REAL validation against the
 * REAL exported array (`z.enum(PUBLIC_VENUE_ENUM)` is byte-identical to the registration's own
 * call), and the wiring is pinned separately by source assertion. The end-to-end proof is the
 * post-deploy probe recorded in `status.md`; it was also driven locally through `dist/index.js` over
 * stdio before this file was written, returning `result.isError: true` with 15 options.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROMOTED_VENUE_IDS } from '../src/lib/capabilities.js';
import { PUBLIC_VENUE_IDS, PUBLIC_VENUE_ENUM, VENUE_IDS_ALL, PUBLIC_TOOL_ENUM_PARAMS } from '../src/lib/tool-param-schema.js';
import { ALL_EXCHANGE_IDS } from '../src/scripts/seed-signals.js';
import {
  recordNonPublicVenue, isNonPublicVenue, getNonPublicVenueSnapshot, _resetNonPublicVenueCounters,
} from '../src/lib/non-public-venue-counter.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const indexSrc = read('src/index.ts');

/** The three exchange-bearing public tools. `get_trade_signal` shares get_trade_call's schema. */
const EXCHANGE_TOOLS = ['get_trade_call', 'get_market_regime', 'scan_trade_calls'] as const;

describe('1-2 — PUBLIC_VENUE_IDS is the promoted set, and excludes the two non-public venues', () => {
  it('has 14 entries and equals PROMOTED_VENUE_IDS as a set', () => {
    // OPS-BITMART-ENUM-RECONCILE-W1: 15→14 (BITMART retired 2026-08-27, removed from the static SoT).
    // OPS-WEEX-PROMOTE-W1: 14→15 (WEEX promoted 2026-09-04).
    expect(PUBLIC_VENUE_IDS).toHaveLength(15);
    expect([...PUBLIC_VENUE_IDS].sort()).toEqual([...PROMOTED_VENUE_IDS].sort());
  });

  it('excludes EDGEX; includes WEEX since OPS-WEEX-PROMOTE-W1', () => {
    // EDGEX stays out — RETIRED, not merely unpromoted. WEEX flipped ABSENT→PRESENT on
    // 2026-09-04; this assertion recorded the old state, while the load-bearing guard is the
    // set-equality with PROMOTED_VENUE_IDS directly above, which keeps working at 15.
    expect(PUBLIC_VENUE_IDS).not.toContain('EDGEX');
    expect(PUBLIC_VENUE_IDS).toContain('WEEX');
  });
});

describe('3 — VENUE_IDS_ALL still means "every venue with an adapter"', () => {
  it('keeps all 17 — narrowing it would break the ExchangeId set-equality assertions', () => {
    expect(VENUE_IDS_ALL).toHaveLength(17);
    expect(VENUE_IDS_ALL).toContain('EDGEX');
    expect(VENUE_IDS_ALL).toContain('WEEX');
  });

  it('still carries BOTH compile-time set-equality assertions (tsc enforces them; this pins them present)', () => {
    const src = read('src/lib/tool-param-schema.ts');
    expect(src).toMatch(/type _AllVenuesAreExchangeIds = \(typeof VENUE_IDS_ALL\)\[number\] extends ExchangeId/);
    expect(src).toMatch(/type _AllExchangeIdsAreVenues = ExchangeId extends \(typeof VENUE_IDS_ALL\)\[number\]/);
  });

  it('the public set is a strict subset of the declared set, differing by exactly BITMART + EDGEX', () => {
    // OPS-WEEX-PROMOTE-W1: WEEX left this difference on 2026-09-04. BITMART + EDGEX are RETIRED
    // and stay declared-but-not-public; that is the whole remaining gap.
    const pub = new Set<string>(PUBLIC_VENUE_IDS);
    expect(VENUE_IDS_ALL.filter((v) => !pub.has(v)).sort()).toEqual(['BITMART', 'EDGEX']);
  });
});

describe('4 — EDGEX is rejected, via result.isError and NOT via response.error', () => {
  // The SDK surfaces a Zod failure as HTTP 200 + `result.isError: true` with the code as TEXT in
  // `result.content[0].text`. `response.error` is ABSENT. A caller checking only `error` reads the
  // failure as success — which is why CH2's error section leads with the two-shape rule, and why
  // this case asserts the Zod issue rather than an `error.code` that never arrives.
  const schema = z.enum(PUBLIC_VENUE_ENUM);

  for (const bad of ['BITMART', 'EDGEX'] as const) {
    it(`rejects ${bad} with invalid_enum_value naming the 15 valid options`, () => {
      const r = schema.safeParse(bad);
      expect(r.success).toBe(false);
      if (r.success) return;
      const issue = r.error.issues[0] as { code: string; options?: readonly string[] };
      expect(issue.code).toBe('invalid_enum_value');
      expect(issue.options).toHaveLength(15);
      expect(issue.options).not.toContain(bad);
    });
  }

  it('all three public exchange enums are wired to PUBLIC_VENUE_ENUM — none left on the declared set', () => {
    expect(indexSrc.match(/exchange: z\.enum\(PUBLIC_VENUE_ENUM\)/g)).toHaveLength(3);
    expect(indexSrc).not.toMatch(/exchange: z\.enum\(VENUE_IDS_ALL\)/);
  });

  it('get_trade_signal shares get_trade_call\'s schema object — proven, not assumed', () => {
    // Both registrations pass the SAME identifier, so the alias cannot drift from the canonical
    // tool. Asserting the shape here is what makes "the alias follows automatically" a fact.
    const decl = indexSrc.indexOf('const TRADE_CALL_SCHEMA = {');
    expect(decl).toBeGreaterThan(-1);
    const after = indexSrc.slice(decl);
    expect(after.match(/^\s*TRADE_CALL_SCHEMA,$/gm)).toHaveLength(2);
    expect(after).toMatch(/'get_trade_signal',/);
  });
});

describe('5-6 — every public venue is accepted, on every tool, and the three sets agree', () => {
  const schema = z.enum(PUBLIC_VENUE_ENUM);

  for (const v of PROMOTED_VENUE_IDS) {
    it(`accepts ${v}`, () => expect(schema.safeParse(v).success).toBe(true));
  }

  it('all three tools project the SAME 15 — equal by derivation, not by coincidence', () => {
    for (const tool of EXCHANGE_TOOLS) {
      const values = PUBLIC_TOOL_ENUM_PARAMS[tool].exchange.values;
      expect([...values].sort(), `${tool} diverged`).toEqual([...PROMOTED_VENUE_IDS].sort());
    }
  });
});

describe('7 — the seeding asymmetry is pinned, not accidental', () => {
  it('ALL_EXCHANGE_IDS still covers EDGEX and WEEX so their history is not orphaned', () => {
    expect(ALL_EXCHANGE_IDS).toHaveLength(17);
    expect(ALL_EXCHANGE_IDS).toContain('EDGEX');
    expect(ALL_EXCHANGE_IDS).toContain('WEEX');
  });

  it('and says WHY in the source — an unexplained asymmetry gets "tidied" by a later wave', () => {
    const seed = read('src/scripts/seed-signals.ts');
    expect(seed).toMatch(/orphaned/);
    expect(seed).toMatch(/VENUE_IDS_ALL \(17\), NOT the public/);
  });
});

describe('8 — the rejection is measured, because request_log cannot see it', () => {
  beforeEach(() => _resetNonPublicVenueCounters());

  it('classifies only the venues CH1 removed — a typo is a different, pre-existing class', () => {
    expect(isNonPublicVenue('EDGEX')).toBe(true);
    expect(isNonPublicVenue('BITMART')).toBe(true);
    // WEEX is PUBLIC since OPS-WEEX-PROMOTE-W1 — NON_PUBLIC is derived from PUBLIC_VENUE_IDS,
    // so it dropped out by construction with no edit to the counter itself.
    expect(isNonPublicVenue('WEEX')).toBe(false);
    expect(isNonPublicVenue('BINANCE')).toBe(false);
    expect(isNonPublicVenue('NOTAVENUE')).toBe(false);
    expect(isNonPublicVenue(undefined)).toBe(false);
  });

  it('records exactly one entry per attempt, and NOTHING for a public venue', () => {
    recordNonPublicVenue('EDGEX', 'get_trade_call', 'free');
    recordNonPublicVenue('EDGEX', 'get_trade_call', 'free');
    recordNonPublicVenue('BITMART', 'get_market_regime', 'starter');
    // The public venue must be DRIVEN THROUGH the recorder, not merely absent from the calls
    // above: an earlier draft asserted only `counts['BINANCE:…']` is undefined without ever
    // calling it, so deleting the class guard entirely left every test green. The guard is what
    // keeps this counter a signal instead of one log line per request on the serving path.
    recordNonPublicVenue('BINANCE', 'get_trade_call', 'free');
    recordNonPublicVenue('NOTAVENUE', 'get_trade_call', 'free');
    const { counts } = getNonPublicVenueSnapshot();
    expect(counts['EDGEX:get_trade_call']).toBe(2);
    expect(counts['BITMART:get_market_regime']).toBe(1);
    expect(counts['BINANCE:get_trade_call']).toBeUndefined();
    expect(counts['NOTAVENUE:get_trade_call']).toBeUndefined();
    expect(Object.keys(counts)).toHaveLength(2);
  });

  it('never throws, even on hostile input — it sits on the live serving path', () => {
    expect(() => recordNonPublicVenue(null as unknown as string, 'get_trade_call', 'free')).not.toThrow();
    expect(() => recordNonPublicVenue('EDGEX', undefined as unknown as string, 'free')).not.toThrow();
  });

  it('is NOT filed under the [indeterminate] series — that one is alerted on', () => {
    // Same shape, separate series: `recordIndeterminate` means "could not determine an answer" and
    // a host canary pages on it. This event is a fully determined refusal working as designed;
    // filing it there would inject routine traffic into an alerting signal.
    // Assert on CODE, not on file text: this module's docblock NAMES recordIndeterminate to explain
    // why it does not use it, so a bare /recordIndeterminate/ match reddens on the explanation
    // itself. Match the import and the call — the two shapes prose cannot produce.
    const src = read('src/lib/non-public-venue-counter.ts');
    expect(src).not.toMatch(/from '\.\/indeterminate-counter/);
    expect(src).not.toMatch(/recordIndeterminate\(/);
    expect(src).toMatch(/\[non_public_venue_rejected\]/);
  });

  it('is wired at the ONE seam that can see the value, below the credential gate', () => {
    // Zod runs inside the SDK's tool wrapper, so the handler never executes on a rejected call and
    // cannot report it. The /mcp route already parses the body for x402 price binding — that is the
    // only place the venue is visible. Position matters: below applyCredentialRefusal, so a refused
    // caller is not counted ("a refusal claims nothing").
    const gate = indexSrc.indexOf('if (applyCredentialRefusal(req, res, license)) return;');
    const call = indexSrc.indexOf('recordNonPublicVenue(venueArg, callTool, license.tier)');
    expect(gate).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(gate);
  });
});

describe('9 — the public set is DERIVED, never subtracted', () => {
  it('no exclusion literal in tool-param-schema.ts — a deny-list re-publishes venue 18', () => {
    // Scoped to this file on purpose. src/types.ts:130 (the ExchangeId union) legitimately carries
    // both literals on one line, and CH1's own scope REQUIRES it to; a repo-wide grep for them is
    // the check that reddens on correct code.
    // Same trap, and it caught this file on the first run: the PUBLIC_VENUE_IDS docblock warns
    // against writing the deny-list as ['EDGEX','WEEX'], so matching that literal reddens on the
    // warning. The DERIVATION is the real guard — a value assigned from PROMOTED_VENUE_IDS cannot
    // be a deny-list — and the negatives below are code-shaped (an assignment, a filter call).
    const src = read('src/lib/tool-param-schema.ts');
    expect(src).toMatch(/export const PUBLIC_VENUE_IDS = PROMOTED_VENUE_IDS;/);
    expect(src).not.toMatch(/=\s*\[\s*'EDGEX'/);
    expect(src).not.toMatch(/\.filter\([^)]*EDGEX/);
  });
});
