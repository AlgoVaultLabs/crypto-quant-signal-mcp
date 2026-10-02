// EDGE-ADS1-SCORECARD-W1-V2 CH3 R6 — the scorecard on a SYNTHETIC fixture (no DB, no figure).
//
// The spec's known answer: a cell engineered at +2.0 pp over the mix-matched null reads CREDIBLE only when
// its nEff clears the floor (3863), else PROVISIONAL; a 95/5 cell reads NOT_IDENTIFIABLE. Plus: the
// self-check can fail (registration after the pull, a write-counter delta, a non-RO token), the
// allow-list SQL carries no scorer input and every label-bearing read is under T_CAP, and the parsers
// refuse what they cannot read instead of guessing.
//
// EDGE-ADS1-SCORECARD-W1-V3 (registration §10): the family is `-v2` (imported), T_CAP is the max form, the extract
// carries two provenance columns, the label-free part a per-signal presence statement, and the scorecard prints the
// coverage chain. The pin is SECTION-scoped: the amended statements must sit inside the one admitted amendment.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  ADS1_BARRIER_SPECS,
  N_EFF_FLOOR,
  PRIMARY_BARRIER_SPEC,
  PRIMARY_V1_TWIN_SPEC,
  T_ADAPTER,
  T_CUT,
  T_DIAG_END,
  T_FLIP,
  withinTCapMax,
} from '../../src/scripts/ads1/spec.js';
import {
  EXTRACT_HEADER,
  PRESENCE_HEADER,
  TOKEN_SQL,
  censusSql,
  countersSql,
  extractSql,
  integritySql,
  presenceSql,
  sessionScript,
  sideMixSql,
} from '../../src/scripts/ads1/extract-sql.js';
import {
  RO_TOKEN,
  buildCoverage,
  buildScorecard,
  chainClass,
  extractHeaderClause,
  parseExtract,
  parsePresence,
  parseUtcTimestamptz,
  renderMarkdown,
  selfCheck,
  splitCsvLine,
  tierMapOf,
  unitsOf,
  type ExtractRow,
  type PresenceRow,
  type PullMeta,
} from '../../src/scripts/ads1/scorecard.js';

const DAY0 = 1788220800; // 2026-09-01T00:00:00Z — after T_FLIP
/** The fixture's relabel launch: 2026-10-02T19:40:00Z (after T_CUT, before the fixture pull). */
const LAUNCH = 1790970000;
let nextId = 1;

/** One decided call. `up` is where price went; the side-relative label follows. */
function call(exchange: string, t: number, side: 'BUY' | 'SELL', up: boolean): ExtractRow {
  const win = (side === 'BUY') === up;
  const specs: ExtractRow['specs'] = {};
  for (const b of ADS1_BARRIER_SPECS) specs[b.spec] = null;
  specs[PRIMARY_BARRIER_SPEC] = { label: win ? 1 : -1, ambiguous: false, lowVol: false, barrierPct: 1.0, expiryRetPct: null };
  return {
    id: nextId++, createdAt: t, exchange, coin: 'BTC', timeframe: '1h', side, confidence: 60,
    regimeRuleVersion: 3, regime: 'RANGING', verdictRuleVersion: 2, anchored: true, specs,
    computedAt: LAUNCH + 3600, raceGapCandles: 0,
  };
}

/** The presence rows a lawful pull would return for these extract rows: every one registered, a `-v1` twin, a `-v2` row. */
function presenceOf(rs: ExtractRow[]): PresenceRow[] {
  return rs.map((r) => ({
    id: r.id, exchange: r.exchange, coin: r.coin, timeframe: r.timeframe, win: r.createdAt > T_FLIP ? 'POST' : 'PRE',
    v1: true, v2: true, v2PostAdapter: r.computedAt >= T_ADAPTER,
  }));
}

/** A day of 2·perSide calls, `buyShare` of them BUY, whose engine hit rate is `hits/perSide` on each side.
 *  At buyShare ½ price is up on exactly half the rows, so the mix-matched null is 0.5 and the edge is
 *  hits/perSide − ½. */
function day(exchange: string, d: number, perSide: number, hits: number, buyShare = 0.5): ExtractRow[] {
  const t0 = DAY0 + d * 86_400;
  const out: ExtractRow[] = [];
  let j = 0;
  const nBuy = Math.round(2 * perSide * buyShare);
  const nSell = 2 * perSide - nBuy;
  const hB = Math.round((hits / perSide) * nBuy);
  const hS = Math.round((hits / perSide) * nSell);
  for (let i = 0; i < nBuy; i++) out.push(call(exchange, t0 + 60 * j++, 'BUY', i < hB));
  for (let i = 0; i < nSell; i++) out.push(call(exchange, t0 + 60 * j++, 'SELL', !(i < hS)));
  return out;
}

const tierMap = tierMapOf({ byTier: { tier1: { tier: 1, assets: ['BTC', 'ETH'] }, tier4: { tier: 4, assets: ['PEPE'] } } });

function meta(over: Partial<PullMeta> = {}): PullMeta {
  return {
    registrationPath: 'audits/ads1-scorecard-preregistration-fixture.md', registrationCommit: 'abc1234',
    registrationCommitTs: 1790600000, amendmentCommit: 'def5678', amendmentCommitTs: 1790930000, // 2026-10-02T08:33Z
    relabelLaunchTs: LAUNCH, extractFamily: PRIMARY_BARRIER_SPEC,
    doneTokens: ['LRW_RELABEL_COMPLETE=YES {}', 'LRW_ANNOTATION_COMPLETE=YES {}'], manifestSha256: ['m'],
    pullStartTs: 1791100000, pullEndTs: 1791100600, // 2026-10-04T07:46Z
    tokenLines: [RO_TOKEN, RO_TOKEN, RO_TOKEN, RO_TOKEN], extractSha256: 'x', tiersSha256: 'y', tiersFetchedAt: 'fixture',
    countersBefore: { ins: 5, upd: 7, del: 0 }, countersAfter: { ins: 5, upd: 7, del: 0 },
    integrity: { v1_after_flip: 0, sensitivity_only_under_tcap: 0 },
    ...over,
  };
}

// A: 24 days × 200 calls, days alternating +3 / +1 pp → +2.0 pp, n 4800 ≥ 3863.
// B: 20 days × 150 calls, every day +2.0 pp (39 of 75 per side), n 3000 < 3863.
// C: 24 days × 200 calls, 95 % BUY.
// (T_CAP ends 2026-09-26T06:00Z, so the post-flip fixture has at most 25 whole days.)
const rows: ExtractRow[] = [];
for (let d = 0; d < 24; d++) rows.push(...day('BINANCE', d, 100, d % 2 ? 51 : 53));
for (let d = 0; d < 20; d++) rows.push(...day('OKX', d, 75, 39));
for (let d = 0; d < 24; d++) rows.push(...day('BYBIT', d, 100, 55, 0.95));

describe('the fixture is lawful', () => {
  it('every row is after the flip and under T_CAP (max form)', () => {
    expect(rows.every((r) => r.createdAt > T_FLIP && withinTCapMax(r.createdAt, r.exchange, r.timeframe))).toBe(true);
    expect(Math.max(...rows.map((r) => r.createdAt))).toBeLessThan(T_DIAG_END);
  });
});

describe('buildScorecard — the three-cell known answer', { timeout: 60_000 }, () => {
  const sc = buildScorecard({ rows, tierMap, census: [], sideMix: [], presence: presenceOf(rows), manifest: new Map(), meta: meta() });
  const cell = (ex: string) => sc.units.find((u) => u.key === `cell:${ex}:1h:T1` && u.window === 'POST_FLIP' && u.spec === PRIMARY_BARRIER_SPEC)!;

  it('+2.0 pp with nEff ≥ the floor reads CREDIBLE', () => {
    const a = cell('BINANCE');
    expect(a.edgePp).toBeCloseTo(2.0, 9);
    expect(a.nEff as number).toBeGreaterThanOrEqual(N_EFF_FLOOR);
    expect(a.full?.verdict.token).toBe('CREDIBLE');
  });

  it('the same +2.0 pp with nEff below the floor reads PROVISIONAL', () => {
    const b = cell('OKX');
    expect(b.edgePp).toBeCloseTo(2.0, 9);
    expect(b.nEff as number).toBeLessThan(N_EFF_FLOOR);
    expect(b.full?.verdict.token).toBe('PROVISIONAL');
    expect(b.full?.verdict.reason).toBe('n_eff-below-floor');
  });

  it('a 95 / 5 cell reads NOT_IDENTIFIABLE on the minority rule', () => {
    const c = cell('BYBIT');
    expect(c.full?.verdict.token).toBe('NOT_IDENTIFIABLE');
    expect(c.identReason).toBe('minority');
  });

  it('cells carry the venue n/a token; roll-ups carry the census token; the withheld arm is never scored', () => {
    expect(cell('BINANCE').full?.coverage.naReason).toBe('CENSUS_HAS_NO_VENUE');
    const fleet = sc.units.find((u) => u.key === 'fleet:crypto' && u.window === 'POST_FLIP')!;
    expect(fleet.full?.coverage.naReason).toBe('COVERAGE_UNITS_INCOMMENSURATE');
    expect(fleet.full?.coverage.allDecisionsEdge).toBe('n/a: WITHHELD_ARM_QUARANTINED');
  });

  it('cells_tested counts every unit whose day-cluster bound was computed', () => {
    expect(sc.cellsTested).toBe(sc.units.filter((u) => u.clusterCiLbPp !== null).length);
    expect(sc.cellsTested).toBeGreaterThan(0);
  });

  it('the self-check passes on a lawful pull and renders one terminal line', () => {
    const ch = selfCheck(sc);
    expect(ch.line).toMatch(/^ADS1_SCORECARD_SELFCHECK: PASS \(\d+ checks\)$/);
    const md = renderMarkdown(sc, 'HEADER CLAUSE FIXTURE '.repeat(12), ch, '/tmp/x.csv.gz');
    expect(md).toContain('verdict: CREDIBLE');
    expect(md.trimEnd().split('\n').pop()).toBe(ch.line);
    expect(md).not.toContain('verdict: EXCEPTIONAL');
  });

  it('the self-check FAILS when the registration landed after the pull, on a counter delta, or on a writer token', () => {
    const late = buildScorecard({ rows: rows.slice(0, 400), tierMap, census: [], sideMix: [], presence: presenceOf(rows.slice(0, 400)), manifest: new Map(), meta: meta({ registrationCommitTs: 1791105000 }) });
    expect(selfCheck(late).line).toMatch(/FAIL .*registration and amendment landed before the pull/);
    const wrote = buildScorecard({ rows: rows.slice(0, 400), tierMap, census: [], sideMix: [], presence: presenceOf(rows.slice(0, 400)), manifest: new Map(), meta: meta({ countersAfter: { ins: 6, upd: 7, del: 0 } }) });
    expect(selfCheck(wrote).line).toMatch(/FAIL .*counters unchanged/);
    const writer = buildScorecard({
      rows: rows.slice(0, 400), tierMap, census: [], sideMix: [], presence: presenceOf(rows.slice(0, 400)), manifest: new Map(),
      meta: meta({ tokenLines: [RO_TOKEN, 'TOKEN current_user=algovault_app transaction_read_only=off', RO_TOKEN, RO_TOKEN] }),
    });
    expect(selfCheck(writer).line).toMatch(/FAIL .*read-only token/);
    const nightly = buildScorecard({ rows: rows.slice(0, 400), tierMap, census: [], sideMix: [], presence: presenceOf(rows.slice(0, 400)), manifest: new Map(), meta: meta({ pullStartTs: 1791085200, pullEndTs: 1791085800 }) }); // 2026-10-04T03:40Z
    expect(selfCheck(nightly).line).toMatch(/FAIL .*outside 02:20–06:30Z/);
  });
});

describe('the allow-list SQL', () => {
  const FEATURE = /raw_final|raw0|rsi_score|ema_score|funding_score|oi_score|volume_score|_delta\b|adjust_code|scorer_input/;
  const MAX_FORM = `s.created_at <= ${T_DIAG_END}\n    AND s.created_at + (tf.w + 1) * GREATEST(tf.sec, COALESCE(coarser.sec, tf.sec)) <= ${T_DIAG_END}`;
  it('names only allow-listed columns, binds T_CAP in the max form, and pins the three -v2 specs', () => {
    const sql = extractSql();
    expect(sql).not.toMatch(FEATURE);
    expect(sql).not.toMatch(/SELECT \*|\.\*/);
    expect(sql).not.toMatch(/outcome_|mfe_|mae_|t_hit/);
    expect(sql).toContain(MAX_FORM);
    expect(sql).not.toContain('(tf.w + 1) * tf.sec <='); // the requested form is gone from the population predicate
    for (const b of ADS1_BARRIER_SPECS) expect(sql).toContain(`'${b.spec}'`);
    expect(sql).not.toMatch(/-v1'/); // no -v1 column is read by the label-bearing extract
    expect(sql).toMatch(/JOIN directional_labels d10 ON[^\n]*'tau1\.0-floor0\.30-v2'/);
    expect(sql).not.toMatch(/LEFT JOIN directional_labels d10/);
    // the two provenance columns are the primary's only, right after its five
    expect(EXTRACT_HEADER.slice(11, 18)).toEqual(['label_t10', 'amb_t10', 'lowvol_t10', 'barrier_t10', 'expiry_t10', 'computed_t10', 'gap_t10']);
    expect(EXTRACT_HEADER.filter((h) => /^(computed|gap)_/.test(h))).toEqual(['computed_t10', 'gap_t10']);
  });

  it('the label-free statements read no label and no outcome column; presence reads -v1 by EXISTS only', () => {
    for (const sql of [censusSql(), sideMixSql(), integritySql(), presenceSql()]) {
      expect(sql).not.toMatch(FEATURE);
      expect(sql).not.toMatch(/\blabel\b|outcome_|ret_at_expiry|mfe_|mae_|race_gap/);
    }
    const pres = presenceSql();
    expect(pres).toContain(MAX_FORM);
    expect(integritySql()).toContain(MAX_FORM);
    // the one -v1 literal in the session is the primary's twin, inside an EXISTS (presence, never a value)
    expect(pres.match(/-v1'/g)).toHaveLength(1);
    expect(pres).toContain(`EXISTS (SELECT 1 FROM directional_labels v1 WHERE v1.signal_id = s.id AND v1.barrier_spec = '${PRIMARY_V1_TWIN_SPEC}') AS v1_present`);
    expect(pres).toContain(`v2.computed_at >= to_timestamp(${T_ADAPTER})`);
  });

  it('every session part is one READ ONLY transaction that prints the token first, in UTC', () => {
    for (const p of ['counters', 'extract', 'labelfree'] as const) {
      const s = sessionScript(p);
      expect(s.indexOf('BEGIN READ ONLY;')).toBeLessThan(s.indexOf('TOKEN current_user='));
      expect(s.indexOf("SET TIME ZONE 'UTC';")).toBeLessThan(s.indexOf('BEGIN READ ONLY;'));
      expect(s).toContain('\\set ON_ERROR_STOP 1');
      expect(s.trimEnd().endsWith('COMMIT;')).toBe(true);
    }
    const ex = sessionScript('extract');
    expect(ex.indexOf("\\echo '===FAMILY==='")).toBeLessThan(ex.indexOf("\\echo '===EXTRACT==='"));
    expect(ex).toContain(`\\echo '${PRIMARY_BARRIER_SPEC}'`);
    expect(sessionScript('labelfree')).toContain("\\echo '===PRESENCE==='");
  });
});

describe('parsers refuse what they cannot read', () => {
  it('splitCsvLine: NULL vs empty string vs quoted comma', () => {
    expect(splitCsvLine('a,,"",b')).toEqual(['a', null, '', 'b']);
    expect(splitCsvLine('"x,y","say ""hi"""')).toEqual(['x,y', 'say "hi"']);
    expect(() => splitCsvLine('"open')).toThrow();
  });

  it('parseExtract round-trips a row (incl. the provenance pair) and refuses a foreign header', () => {
    const vals: Record<string, string> = {
      id: '9', created_at: String(DAY0), exchange: 'OKX', coin: 'BTC', timeframe: '1h', side: 'SELL', confidence: '71',
      regime_rule_version: '3', regime: 'TRENDING_DOWN', verdict_rule_version: '2', anchored: 't',
      label_t10: '0', amb_t10: 'f', lowvol_t10: 'f', barrier_t10: '1.25', expiry_t10: '-0.4',
      computed_t10: '2026-10-03 19:00:01.5+00', gap_t10: '0',
    };
    const line = EXTRACT_HEADER.map((h) => vals[h] ?? '').join(',');
    const [r] = parseExtract(`${EXTRACT_HEADER.join(',')}\n${line}\n`);
    expect(r).toMatchObject({ id: 9, side: 'SELL', confidence: 71, anchored: true, regime: 'TRENDING_DOWN', raceGapCandles: 0 });
    expect(r.computedAt).toBe(Date.UTC(2026, 9, 3, 19, 0, 1) / 1000 + 0.5);
    expect(r.specs[PRIMARY_BARRIER_SPEC]).toEqual({ label: 0, ambiguous: false, lowVol: false, barrierPct: 1.25, expiryRetPct: -0.4 });
    expect(r.specs[ADS1_BARRIER_SPECS[1].spec]).toBeNull();
    expect(() => parseExtract(`id,created_at\n1,2\n`)).toThrow(/header mismatch/);
    // a v1-era header (no provenance pair) is a foreign header
    const v1Header = EXTRACT_HEADER.filter((h) => h !== 'computed_t10' && h !== 'gap_t10');
    expect(() => parseExtract(`${v1Header.join(',')}\n`)).toThrow(/header mismatch/);
  });

  it('parseUtcTimestamptz accepts only the UTC ISO form the session fixes, and refuses every other', () => {
    expect(parseUtcTimestamptz('2026-10-01 14:27:16+00')).toBe(T_ADAPTER);
    expect(parseUtcTimestamptz('2026-10-01 14:27:16.460000+00')).toBeCloseTo(T_ADAPTER + 0.46, 6);
    for (const bad of ['2026-10-01T14:27:16Z', '2026-10-01 14:27:16+02', '2026-10-01 16:27:16+02:00', '10/01/2026 14:27:16', '', null]) {
      expect(() => parseUtcTimestamptz(bad as string | null), String(bad)).toThrow(/not a UTC ISO timestamptz/);
    }
  });

  it('parsePresence reads t/f only and refuses anything else', () => {
    const ok = parsePresence(`${PRESENCE_HEADER.join(',')}\n7,OKX,BTC,1h,POST,t,f,f\n`);
    expect(ok).toEqual([{ id: 7, exchange: 'OKX', coin: 'BTC', timeframe: '1h', win: 'POST', v1: true, v2: false, v2PostAdapter: false }]);
    expect(() => parsePresence(`${PRESENCE_HEADER.join(',')}\n7,OKX,BTC,1h,POST,true,f,f\n`)).toThrow(/t\/f/);
    expect(() => parsePresence(`${PRESENCE_HEADER.join(',')}\n7,OKX,BTC,1h,LATER,t,f,f\n`)).toThrow(/window/);
    expect(() => parsePresence(`id,exchange\n7,OKX\n`)).toThrow(/header mismatch/);
  });

  it('tierMapOf refuses a coin listed in two tiers, and an empty instrument', () => {
    expect(() => tierMapOf({ byTier: { a: { tier: 1, assets: ['X'] }, b: { tier: 2, assets: ['X'] } } })).toThrow(/two tiers/);
    expect(() => tierMapOf({ byTier: {} })).toThrow();
  });

  it('extractHeaderClause lifts the blockquote verbatim and refuses a spec without one', () => {
    const body = 'A'.repeat(120);
    const spec = `# T\n\n> ## ⚠️ HEADER CLAUSE — REPRODUCE\n>\n> **First.** ${body}\n>\n> Second ${body}\n\n---\n`;
    expect(extractHeaderClause(spec)).toBe(`**First.** ${body}\n\nSecond ${body}`);
    expect(() => extractHeaderClause('# nothing here')).toThrow();
  });
});

describe('the coverage chain (registration §10.4) — every registered row lands in exactly one class', () => {
  const P = (id: number, over: Partial<PresenceRow> = {}): PresenceRow => ({
    id, exchange: 'BITGET', coin: 'BTC', timeframe: '2h', win: 'POST', v1: true, v2: true, v2PostAdapter: true, ...over,
  });
  it('chainClass: -v2 rows by twin and stamp; the rest by manifest class or not visited', () => {
    const man = new Map<number, string>([[3, 'refused:gap'], [4, 'unreachable:retired'], [5, 'deferred']]);
    expect(chainClass(P(1, { v1: false }), LAUNCH, man, LAUNCH)).toBe('no_v1_twin');
    expect(chainClass(P(1), LAUNCH, man, LAUNCH)).toBe('relabel'); // at the launch epoch: relabel
    expect(chainClass(P(1), LAUNCH - 1, man, LAUNCH)).toBe('nightly');
    expect(chainClass(P(1), T_CUT, man, LAUNCH)).toBe('nightly'); // at T_CUT: nightly
    expect(chainClass(P(1), T_CUT - 1, man, LAUNCH)).toBe('pre_cut');
    expect(chainClass(P(3, { v2: false }), null, man, LAUNCH)).toBe('refused:gap');
    expect(chainClass(P(4, { v2: false }), null, man, LAUNCH)).toBe('unreachable:retired');
    expect(chainClass(P(5, { v2: false }), null, man, LAUNCH)).toBe('deferred');
    expect(chainClass(P(6, { v2: false }), null, man, LAUNCH)).toBe('not_visited:v1');
    expect(chainClass(P(6, { v2: false, v1: false }), null, man, LAUNCH)).toBe('not_visited:no_v1');
    expect(() => chainClass(P(7, { v2: false }), null, new Map([[7, 'relabel']]), LAUNCH)).toThrow(/not registered/);
    // a -v2 twin the extract does not carry (a write between the two parts) is COUNTED, never thrown
    expect(chainClass(P(8), null, man, LAUNCH)).toBe('unstamped');
  });

  it('buildCoverage: partitions, reach, the T_ADAPTER split and the by-construction counts', () => {
    const ex = (id: number, computedAt: number, over: Partial<ExtractRow> = {}): ExtractRow => ({
      ...call('BITGET', DAY0 + id * 60, 'BUY', true), id, timeframe: '2h', computedAt, ...over,
    });
    const rs = [ex(1, LAUNCH + 1), ex(2, T_ADAPTER - 10), ex(3, LAUNCH + 2, { raceGapCandles: 2 })];
    const presence = [
      P(1), P(2, { v2PostAdapter: false }), P(3, { v1: false }),
      P(10, { v2: false, v2PostAdapter: false }), P(11, { v2: false, v2PostAdapter: false }), P(12, { v2: false, v1: false, v2PostAdapter: false }),
    ];
    const cv = buildCoverage({
      presence, rows: rs, manifest: new Map([[10, 'refused:gap'], [11, 'unreachable:adapter-pending']]), relabelLaunchTs: LAUNCH, tierOf: () => '1',
      defs: unitsOf(presence.map((p) => ({ exchange: p.exchange, timeframe: p.timeframe, tier: '1' }))),
    });
    const cell = cv.byCell.find((r) => r.key === 'BITGET 2h' && r.window === 'POST_FLIP')!;
    expect(cell).toMatchObject({ registered: 6, v1Present: 4, v2Present: 3 });
    expect(cell.reach).toBeCloseTo(0.5, 12);
    expect(cell.byClass).toMatchObject({ relabel: 1, nightly: 1, no_v1_twin: 1, 'refused:gap': 1, 'unreachable:adapter-pending': 1, 'not_visited:no_v1': 1 });
    expect(Object.values(cell.byClass).reduce((a, b) => a + b, 0)).toBe(cell.registered); // a partition
    expect(cv.byUnit.find((r) => r.key === 'fleet:all' && r.window === 'FULL')!.registered).toBe(6);
    expect(cv.adapterSplit.find((a) => a.cell === 'BITGET:2h' && a.window === 'FULL')).toMatchObject({ postAdapter: 2, preAdapterFix: 1 });
    expect(cv).toMatchObject({ gapNonZero: 1, gapNull: 0, presenceV2: 3, extractRows: 3, idSetsEqual: true, presencePostAdapterAgrees: true, deferredUnderTCap: 0 });
  });
});

describe('the -v2 amendment rows of the self-check FAIL when they should', { timeout: 60_000 }, () => {
  const base = rows.slice(0, 400);
  const sc = (over: Partial<PullMeta> = {}, rs: ExtractRow[] = base, pres = presenceOf(base)) =>
    selfCheck(buildScorecard({ rows: rs, tierMap, census: [], sideMix: [], presence: pres, manifest: new Map(), meta: meta(over) }));
  it('passes on the lawful fixture', () => {
    expect(sc().line).toMatch(/^ADS1_SCORECARD_SELFCHECK: PASS \(\d+ checks\)$/);
  });
  it('fails on an amendment landed after the pull, a v1 family, a missing DONE token, an early launch', () => {
    expect(sc({ amendmentCommitTs: 1791100001 }).line).toMatch(/FAIL .*registration and amendment landed before the pull/);
    expect(sc({ extractFamily: PRIMARY_V1_TWIN_SPEC }).line).toMatch(/FAIL .*family = -v2/);
    expect(sc({ doneTokens: ['LRW_RELABEL_COMPLETE=YES {}', 'LRW_ANNOTATION_COMPLETE=NO {}'] }).line).toMatch(/FAIL .*LRW DONE probes/);
    expect(sc({ relabelLaunchTs: T_CUT - 1 }).line).toMatch(/FAIL .*relabel launch/);
  });
  it('fails on a non-zero gap, a presence/extract mismatch and a pre-T_CUT -v2 row', () => {
    const gap = base.map((r, i) => (i === 0 ? { ...r, raceGapCandles: 1 } : r));
    expect(sc({}, gap, presenceOf(gap)).line).toMatch(/FAIL .*gap_t10 = 0/);
    expect(sc({}, base, presenceOf(base).slice(1)).line).toMatch(/FAIL .*presence -v2 set = extract set/);
    const early = base.map((r, i) => (i === 0 ? { ...r, computedAt: T_CUT - 5 } : r));
    expect(sc({}, early, presenceOf(early)).line).toMatch(/FAIL .*before T_CUT/);
  });
  it('a -v2 row written between the extract and the label-free part FAILS the self-check — the audit is still built', () => {
    const extra: PresenceRow = { ...presenceOf(base.slice(0, 1))[0], id: 999_999 };
    const s = buildScorecard({ rows: base, tierMap, census: [], sideMix: [], presence: [...presenceOf(base), extra], manifest: new Map(), meta: meta() });
    expect(s.coverage.byCell.reduce((a, r) => a + (r.window === 'FULL' ? r.byClass.unstamped : 0), 0)).toBe(1);
    expect(selfCheck(s).line).toMatch(/FAIL .*presence -v2 set = extract set/);
  });
  it('renders the coverage chain and the headline line', () => {
    const s = buildScorecard({ rows, tierMap, census: [], sideMix: [], presence: presenceOf(rows), manifest: new Map(), meta: meta() });
    const md = renderMarkdown(s, 'HEADER CLAUSE FIXTURE '.repeat(12), selfCheck(s), '/tmp/x.csv.gz');
    expect(md).toContain('## Coverage chain (registration §10.4)');
    expect(md).toContain('**Our score:**');
    expect(md).toContain('## (iii) By timeframe × regime');
    expect(md).not.toContain('→ LRW owner'); // no by-construction violation in the lawful fixture
  });
});

describe('the pre-registration is the SQL the session runs — amendment-scoped (registration §10)', () => {
  const dir = path.resolve(__dirname, '../../audits');
  const files = readdirSync(dir).filter((f) => /^ads1-scorecard-preregistration-.*\.md$/.test(f));
  const md = files.length === 1 ? readFileSync(path.join(dir, files[0]), 'utf8') : '';
  const amendmentHeadings = [...md.matchAll(/^## \d+\. Amendment .*$/gm)].map((m) => m[0]);
  /** The text of the ## section that starts at `start`, up to the next ## heading. */
  const section = (start: RegExp): string => {
    const m = start.exec(md);
    if (!m) return '';
    const rest = md.slice(m.index + m[0].length);
    const end = rest.search(/^## /m);
    return end === -1 ? rest : rest.slice(0, end);
  };
  const amendment = section(/^## 10\. Amendment .*$/m);

  it('exactly one registration file, one amendment heading and one Identifiability heading — nothing else added', () => {
    expect(files, 'exactly one ADS-1 scorecard registration').toHaveLength(1);
    expect(amendmentHeadings, 'the registration admits exactly ONE amendment').toHaveLength(1);
    expect(amendmentHeadings[0]).toMatch(/^## 10\. Amendment \d{4}-\d{2}-\d{2} — /);
    expect(md.match(/^## Identifiability$/gm) ?? []).toHaveLength(1);
    // §1–§9 each exactly once: a re-stated section appended after the amendment is not a third admitted heading
    for (let n = 1; n <= 9; n++) expect(md.match(new RegExp(`^## ${n}\\. `, 'gm')) ?? [], `## ${n}.`).toHaveLength(1);
    // the allow-list: every ## heading that is not one of §1–§9 is exactly one of the two admitted ones, in order
    const extra = [...md.matchAll(/^## (?![1-9]\. ).*$/gm)].map((m) => m[0]);
    expect(extra).toEqual([amendmentHeadings[0], '## Identifiability']);
    expect(md.indexOf(amendmentHeadings[0])).toBeGreaterThan(md.indexOf('\n## 9. '));
    expect(md.indexOf('\n## Identifiability\n')).toBeGreaterThan(md.indexOf(amendmentHeadings[0]));
  });

  it('the amended statements are quoted byte-for-byte INSIDE the amendment; the unchanged ones anywhere', () => {
    expect(amendment.length, 'the amendment section exists').toBeGreaterThan(1000);
    for (const [name, sql] of [['extract', extractSql()], ['presence', presenceSql()], ['integrity', integritySql()]] as const) {
      expect(amendment.includes(sql), `${name} statement is not quoted verbatim in §10`).toBe(true);
    }
    for (const [name, sql] of [['token', TOKEN_SQL], ['counters', countersSql()], ['census', censusSql()], ['side mix', sideMixSql()]] as const) {
      expect(md.includes(sql), `${name} statement is not quoted verbatim`).toBe(true);
    }
    expect(md).toMatch(/^## (?:\d+\. )?Support stress-test$/m);
    expect(md).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });
});
