// EDGE-ADS1-SCORECARD-W1-V2 CH2 (D1, D12, D24) — the ADS-1 constants' single source and its locks.
//
//  * TS == JSON: `ops/ads1-spec.json` is the byte-exact output of `serializeAds1Spec()` — the file the
//    autonomous-optimizer repo vendors with a pinned sha256. Regenerate with
//    `npm run build && node scripts/emit-ads1-spec.mjs --write`.
//  * The barrier literals are ONE set: ads1 imports them. Since the V3 amendment (registration §10.1) the set is the
//    labeler's `BARRIER_SPECS_V2` — imported by identity, never copied — while `FRESHNESS_BARRIER_SPEC` stays `-v1`
//    (ruling Q9). The hold labeler's own copy (a file this wave does not touch) still names the three `-v1` strings.
//  * The coarser-served pairs are DERIVED (`servedCandleStepMs`) and equal, as a set, LRW's registered nine-row
//    literal; the JSON's sha256 is the one the amendment records; no family literal lives in the ADS-1 source.
//  * The power floors are DERIVED here from the normal quantiles, not trusted as literals.

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  ADS1_BARRIER_SPECS,
  BANDS,
  ADAPTER_SPLIT_CELLS,
  COARSER_SERVED,
  COST_TIERS_PCT,
  FLAT_FLOOR_PCT,
  N_EFF_FLOOR,
  PRIMARY_BARRIER_SPEC,
  PRIMARY_V1_TWIN_SPEC,
  SEAL_LIFT,
  T_DIAG_END,
  T_FLIP,
  Z_ONE_SIDED,
  serializeAds1Spec,
  withinTCap,
  withinTCapMax,
} from '../../src/scripts/ads1/spec.js';
import { extractSql, extractSqlTemplate, instantiateTemplate } from '../../src/scripts/ads1/extract-sql.js';
import { tCapCases } from '../../src/scripts/ads1/parity-fixture.js';
import { ADAPTER_PENDING_CELLS } from '../../src/scripts/lrw/registered.js';
import { FRESHNESS_BARRIER_SPEC } from '../../src/lib/venue-slo-tiers.js';
import { BARRIER_SPECS, BARRIER_SPECS_V2, ROUND_TRIP_COST_PCT, FLOOR_PCT } from '../../src/scripts/directional-labeler.js';

const ROOT = path.resolve(__dirname, '../..');

describe('ADS-1 spec lock', () => {
  it('ops/ads1-spec.json is byte-identical to serializeAds1Spec()', () => {
    expect(readFileSync(path.join(ROOT, 'ops', 'ads1-spec.json'), 'utf8')).toBe(serializeAds1Spec());
  });

  it('the JSON carries no "name" / "version" key (the system-map gate reads those as manifest edits)', () => {
    expect(serializeAds1Spec()).not.toMatch(/"(name|version)":/);
  });

  it('one barrier literal set: ADS-1 reads the labeler\'s BARRIER_SPECS_V2 by identity; FRESHNESS stays -v1 (Q9)', () => {
    expect(ADS1_BARRIER_SPECS).toBe(BARRIER_SPECS_V2); // imported, never copied
    expect(PRIMARY_BARRIER_SPEC).toBe(BARRIER_SPECS_V2[0].spec);
    expect(ADS1_BARRIER_SPECS.map((b) => b.spec)).toEqual(['tau1.0-floor0.30-v2', 'tau0.5-floor0.30-v2', 'tau2.0-floor0.30-v2']);
    // the -v1 twin is read for PRESENCE only; it is the digest's freshness spec, unchanged by this wave
    expect(PRIMARY_V1_TWIN_SPEC).toBe(BARRIER_SPECS[0].spec);
    expect(FRESHNESS_BARRIER_SPEC).toBe(BARRIER_SPECS[0].spec);
    expect(PRIMARY_BARRIER_SPEC).not.toBe(FRESHNESS_BARRIER_SPEC);
  });

  it('no barrier-family literal lives in the ADS-1 source (every family string is imported)', () => {
    const dir = path.join(ROOT, 'src/scripts/ads1');
    const files = [...readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => path.join(dir, f)), path.join(ROOT, 'src/scripts/ads1-scorecard.ts')];
    expect(files.length, 'the scan found the ADS-1 sources').toBeGreaterThan(5);
    const hits = files.filter((f) => /tau\d\.\d-floor0\.30-v\d/.test(readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f));
    expect(hits).toEqual([]);
  });

  it('COARSER_SERVED equals, as a set, the nine-row literal of the LRW registration §3.1', () => {
    const lrw = readFileSync(path.join(ROOT, 'audits/labeler-race-window-v2-preregistration-2026-09-28.md'), 'utf8');
    const m = /LEFT JOIN \x28VALUES ((?:\x28'[A-Z]+', '\w+', \d+\x29(?:, )?)+)\x29 AS coarser/.exec(lrw);
    expect(m, 'the LRW registration carries its coarser-served VALUES literal').not.toBeNull();
    const registered = [...m![1].matchAll(/\x28'([A-Z]+)', '(\w+)', (\d+)\x29/g)].map((x) => `${x[1]}|${x[2]}|${x[3]}`).sort();
    expect(registered).toHaveLength(9);
    expect(COARSER_SERVED.map((c) => `${c.exchange}|${c.timeframe}|${c.servedSeconds}`).sort()).toEqual(registered);
  });

  it('the JSON sha256 is the one the LATEST registration records (ADS-1 §10.1 at its amendment; AOE-ADS1-OBJECTIVE-W1 §10 at its registration)', () => {
    // Every registration that adopts a revision of the contract records its sha256; the NEWEST record (by the
    // registration date in its filename) is the lock, and older records stay as history. The ADS-1 registration
    // admits exactly ONE amendment (its pin test), so a later revision is recorded by the registration that made it.
    const RE = /`ops\/ads1-spec\.json` \x28sha256 at this (?:amendment|registration) `([0-9a-f]{64})`/g;
    const records = readdirSync(path.join(ROOT, 'audits'))
      .filter((f) => /preregistration-\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .flatMap((f) => [...readFileSync(path.join(ROOT, 'audits', f), 'utf8').matchAll(RE)].map((m) => ({ file: f, sha: m[1], date: /(\d{4}-\d{2}-\d{2})\.md$/.exec(f)![1] })))
      .sort((a, b) => a.date.localeCompare(b.date) || a.file.localeCompare(b.file));
    expect(records.length, 'at least the ADS-1 amendment record and this wave\'s').toBeGreaterThanOrEqual(2);
    // history, kept verbatim: the sha the registered ADS-1 pull ran under
    expect(records.find((r) => r.file === 'ads1-scorecard-preregistration-2026-09-27.md')?.sha).toBe('31e1c67f436888a00f7cdbbbf9f7001938de6a4cba2a6ecdbe84fe2df5eb69b8');
    const latest = records[records.length - 1];
    expect(latest.file).toBe('aoe-ads1-objective-preregistration-2026-10-15.md');
    const actual = createHash('sha256').update(readFileSync(path.join(ROOT, 'ops', 'ads1-spec.json'))).digest('hex');
    expect(actual).toBe(latest.sha);
  });

  it('the seal lift and the horizon template are in the contract (AOE-ADS1-OBJECTIVE-W1 CH1, D1 / D7)', () => {
    expect(SEAL_LIFT).toBe(1800180000);
    expect(new Date(SEAL_LIFT * 1000).toISOString()).toBe('2027-01-17T10:00:00.000Z');
    expect(T_DIAG_END).toBeLessThan(SEAL_LIFT);
    const spec = JSON.parse(serializeAds1Spec());
    expect(spec.seal_lift_epoch).toBe(SEAL_LIFT);
    expect(spec.extract_sql_template).toBe(extractSqlTemplate());
    // the template is the REGISTERED statement with `$1` where it carries T_DIAG_END — there and nowhere else
    expect(instantiateTemplate(extractSqlTemplate(), T_DIAG_END)).toBe(extractSql());
    expect(extractSqlTemplate().split('$1')).toHaveLength(3); // the two sides of the max-form predicate
    expect(extractSqlTemplate()).not.toContain(String(T_DIAG_END));
    expect(() => instantiateTemplate(extractSql(), T_DIAG_END)).toThrow(/no \$1/);
    expect(() => instantiateTemplate(extractSqlTemplate(), 1.5)).toThrow(/integer/);
    expect(() => instantiateTemplate(extractSqlTemplate(), -1)).toThrow(/integer/);
  });

  it('the T_ADAPTER split cells are the registration §10.5 pair, held apart from LRW\'s shrinking pending set', () => {
    expect([...ADAPTER_SPLIT_CELLS].sort()).toEqual(['BITGET:2h', 'BITGET:8h']);
    expect(ADAPTER_SPLIT_CELLS).not.toBe(ADAPTER_PENDING_CELLS); // same shape today, different purpose: never aliased
    const reg = readFileSync(path.join(ROOT, 'audits/ads1-scorecard-preregistration-2026-09-27.md'), 'utf8');
    expect(reg).toContain('**10.5 BITGET 2h / 8h**');
    expect(reg).toContain('`ADAPTER_SPLIT_CELLS`');
  });

  it('T_CAP: the max form admits a SUBSET of the requested form, differing only on coarser-served pairs', () => {
    const cases = tCapCases();
    expect(cases.length).toBeGreaterThan(30);
    for (const c of cases) {
      expect(c.within_requested).toBe(withinTCap(c.created_at, c.timeframe));
      expect(c.within_max).toBe(withinTCapMax(c.created_at, c.exchange, c.timeframe));
      if (c.within_max) expect(c.within_requested, `${c.exchange} ${c.timeframe} ${c.created_at}`).toBe(true);
      const coarser = COARSER_SERVED.some((p) => p.exchange === c.exchange && p.timeframe === c.timeframe);
      if (!coarser) expect(c.within_max).toBe(c.within_requested);
    }
    expect(cases.some((c) => c.within_requested && !c.within_max), 'a case the max form excludes').toBe(true);
  });

  it("the hold labeler's untouched copy names the same three strings", () => {
    const src = readFileSync(path.join(ROOT, 'src/scripts/backfill-hold-decision-labels.ts'), 'utf8');
    const found = [...src.matchAll(/'(tau\d\.\d-floor0\.30-v1)'/g)].map((m) => m[1]);
    expect(new Set(found)).toEqual(new Set(BARRIER_SPECS.map((b) => b.spec)));
  });

  it('the label writer uses the shared set, not a retyped literal', () => {
    const src = readFileSync(path.join(ROOT, 'src/scripts/backfill-directional-labels.ts'), 'utf8');
    expect(src).toMatch(/const ALL_SPECS = BARRIER_SPECS;/);
    expect(src).not.toMatch(/spec: 'tau\d\.\d-floor0\.30-v1'/);
  });

  it('derived constants: FLAT floor = the label floor; taker = ROUND_TRIP_COST_PCT; T_FLIP < T_DIAG_END', () => {
    expect(FLAT_FLOOR_PCT).toBe(FLOOR_PCT);
    expect(FLAT_FLOOR_PCT).toBe(0.3);
    expect(COST_TIERS_PCT.taker).toBe(ROUND_TRIP_COST_PCT);
    expect(T_FLIP).toBe(1788169595);
    expect(T_DIAG_END).toBe(1790402400);
    expect(T_FLIP).toBeLessThan(T_DIAG_END);
  });

  it('power floors are the ceilings of the one-sided α=.05, power=.8 sample sizes (D12)', () => {
    const zBeta = 0.8416212335729143; // Φ⁻¹(0.80)
    const n = (p1: number) => ((Z_ONE_SIDED * 0.5 + zBeta * Math.sqrt(p1 * (1 - p1))) / (p1 - 0.5)) ** 2;
    expect(n(0.52)).toBeCloseTo(3862.005, 2);
    expect(Math.ceil(n(0.52))).toBe(N_EFF_FLOOR);
    expect(Math.ceil(n(0.55))).toBe(BANDS.auditMinNeff);
  });
});
