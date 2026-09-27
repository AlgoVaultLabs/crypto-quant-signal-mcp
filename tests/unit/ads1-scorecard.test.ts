// EDGE-ADS1-SCORECARD-W1-V2 CH3 R6 — the scorecard on a SYNTHETIC fixture (no DB, no figure).
//
// The spec's known answer: a cell engineered at +2.0 pp over the mix-matched null reads CREDIBLE only when
// its nEff clears the floor (3863), else PROVISIONAL; a 95/5 cell reads NOT_IDENTIFIABLE. Plus: the
// self-check can fail (registration after the pull, a write-counter delta, a non-RO token), the
// allow-list SQL carries no scorer input and every label-bearing read is under T_CAP, and the parsers
// refuse what they cannot read instead of guessing.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { BARRIER_SPECS } from '../../src/scripts/directional-labeler.js';
import { N_EFF_FLOOR, PRIMARY_BARRIER_SPEC, T_DIAG_END, T_FLIP, withinTCap } from '../../src/scripts/ads1/spec.js';
import {
  EXTRACT_HEADER,
  TOKEN_SQL,
  censusSql,
  countersSql,
  extractSql,
  integritySql,
  sessionScript,
  sideMixSql,
} from '../../src/scripts/ads1/extract-sql.js';
import {
  RO_TOKEN,
  buildScorecard,
  extractHeaderClause,
  parseExtract,
  renderMarkdown,
  selfCheck,
  splitCsvLine,
  tierMapOf,
  type ExtractRow,
  type PullMeta,
} from '../../src/scripts/ads1/scorecard.js';

const DAY0 = 1788220800; // 2026-09-01T00:00:00Z — after T_FLIP
let nextId = 1;

/** One decided call. `up` is where price went; the side-relative label follows. */
function call(exchange: string, t: number, side: 'BUY' | 'SELL', up: boolean): ExtractRow {
  const win = (side === 'BUY') === up;
  const specs: ExtractRow['specs'] = {};
  for (const b of BARRIER_SPECS) specs[b.spec] = null;
  specs[PRIMARY_BARRIER_SPEC] = { label: win ? 1 : -1, ambiguous: false, lowVol: false, barrierPct: 1.0, expiryRetPct: null };
  return {
    id: nextId++, createdAt: t, exchange, coin: 'BTC', timeframe: '1h', side, confidence: 60,
    regimeRuleVersion: 3, regime: 'RANGING', verdictRuleVersion: 2, anchored: true, specs,
  };
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
    registrationCommitTs: 1790600000, pullStartTs: 1790604000, pullEndTs: 1790604600, // 12:xx UTC
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
  it('every row is after the flip and under T_CAP', () => {
    expect(rows.every((r) => r.createdAt > T_FLIP && withinTCap(r.createdAt, r.timeframe))).toBe(true);
    expect(Math.max(...rows.map((r) => r.createdAt))).toBeLessThan(T_DIAG_END);
  });
});

describe('buildScorecard — the three-cell known answer', { timeout: 60_000 }, () => {
  const sc = buildScorecard({ rows, tierMap, census: [], sideMix: [], meta: meta() });
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
    const late = buildScorecard({ rows: rows.slice(0, 400), tierMap, census: [], sideMix: [], meta: meta({ registrationCommitTs: 1790605000 }) });
    expect(selfCheck(late).line).toMatch(/FAIL .*registration landed before the pull/);
    const wrote = buildScorecard({ rows: rows.slice(0, 400), tierMap, census: [], sideMix: [], meta: meta({ countersAfter: { ins: 6, upd: 7, del: 0 } }) });
    expect(selfCheck(wrote).line).toMatch(/FAIL .*counters unchanged/);
    const writer = buildScorecard({
      rows: rows.slice(0, 400), tierMap, census: [], sideMix: [],
      meta: meta({ tokenLines: [RO_TOKEN, 'TOKEN current_user=algovault_app transaction_read_only=off', RO_TOKEN, RO_TOKEN] }),
    });
    expect(selfCheck(writer).line).toMatch(/FAIL .*read-only token/);
    const nightly = buildScorecard({ rows: rows.slice(0, 400), tierMap, census: [], sideMix: [], meta: meta({ pullStartTs: 1790574000 }) }); // 03:40Z
    expect(selfCheck(nightly).line).toMatch(/FAIL .*outside 02:20–06:30Z/);
  });
});

describe('the allow-list SQL', () => {
  const FEATURE = /raw_final|raw0|rsi_score|ema_score|funding_score|oi_score|volume_score|_delta\b|adjust_code|scorer_input/;
  it('names only allow-listed columns, binds T_CAP, and pins the three barrier specs', () => {
    const sql = extractSql();
    expect(sql).not.toMatch(FEATURE);
    expect(sql).not.toMatch(/SELECT \*|\.\*/);
    expect(sql).not.toMatch(/outcome_|mfe_|mae_|t_hit/);
    expect(sql).toContain(`s.created_at <= ${T_DIAG_END} AND s.created_at + (tf.w + 1) * tf.sec <= ${T_DIAG_END}`);
    for (const b of BARRIER_SPECS) expect(sql).toContain(`'${b.spec}'`);
    expect(sql).toMatch(/JOIN directional_labels d10 ON[^\n]*'tau1\.0-floor0\.30-v1'/);
    expect(sql).not.toMatch(/LEFT JOIN directional_labels d10/);
  });

  it('the label-free statements read no label and no outcome column', () => {
    for (const sql of [censusSql(), sideMixSql(), integritySql()]) {
      expect(sql).not.toMatch(FEATURE);
      expect(sql).not.toMatch(/\blabel\b|outcome_|ret_at_expiry|mfe_|mae_/);
    }
  });

  it('every session part is one READ ONLY transaction that prints the token first', () => {
    for (const p of ['counters', 'extract', 'labelfree'] as const) {
      const s = sessionScript(p);
      expect(s.indexOf('BEGIN READ ONLY;')).toBeLessThan(s.indexOf('TOKEN current_user='));
      expect(s).toContain('\\set ON_ERROR_STOP 1');
      expect(s.trimEnd().endsWith('COMMIT;')).toBe(true);
    }
  });
});

describe('parsers refuse what they cannot read', () => {
  it('splitCsvLine: NULL vs empty string vs quoted comma', () => {
    expect(splitCsvLine('a,,"",b')).toEqual(['a', null, '', 'b']);
    expect(splitCsvLine('"x,y","say ""hi"""')).toEqual(['x,y', 'say "hi"']);
    expect(() => splitCsvLine('"open')).toThrow();
  });

  it('parseExtract round-trips a row and refuses a foreign header', () => {
    const vals: Record<string, string> = {
      id: '9', created_at: String(DAY0), exchange: 'OKX', coin: 'BTC', timeframe: '1h', side: 'SELL', confidence: '71',
      regime_rule_version: '3', regime: 'TRENDING_DOWN', verdict_rule_version: '2', anchored: 't',
      label_t10: '0', amb_t10: 'f', lowvol_t10: 'f', barrier_t10: '1.25', expiry_t10: '-0.4',
    };
    const line = EXTRACT_HEADER.map((h) => vals[h] ?? '').join(',');
    const [r] = parseExtract(`${EXTRACT_HEADER.join(',')}\n${line}\n`);
    expect(r).toMatchObject({ id: 9, side: 'SELL', confidence: 71, anchored: true, regime: 'TRENDING_DOWN' });
    expect(r.specs[PRIMARY_BARRIER_SPEC]).toEqual({ label: 0, ambiguous: false, lowVol: false, barrierPct: 1.25, expiryRetPct: -0.4 });
    expect(r.specs['tau0.5-floor0.30-v1']).toBeNull();
    expect(() => parseExtract(`id,created_at\n1,2\n`)).toThrow(/header mismatch/);
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

describe('the pre-registration is the SQL the session runs', () => {
  it('audits/ads1-scorecard-preregistration-*.md quotes every statement byte-for-byte', () => {
    const dir = path.resolve(__dirname, '../../audits');
    const files = readdirSync(dir).filter((f) => /^ads1-scorecard-preregistration-.*\.md$/.test(f));
    expect(files, 'exactly one ADS-1 scorecard registration').toHaveLength(1);
    const md = readFileSync(path.join(dir, files[0]), 'utf8');
    for (const [name, sql] of [
      ['token', TOKEN_SQL], ['counters', countersSql()], ['extract', extractSql()],
      ['census', censusSql()], ['side mix', sideMixSql()], ['integrity', integritySql()],
    ] as const) {
      expect(md.includes(sql), `${name} statement is not quoted verbatim`).toBe(true);
    }
    expect(md).toMatch(/^## (?:\d+\. )?Support stress-test$/m);
    expect(md).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });
});
