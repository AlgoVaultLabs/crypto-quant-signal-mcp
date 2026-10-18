/**
 * tests/unit/venue-candle-reach.test.ts — OPS-ALARM-OWNER-DERIVATION-W1 CH1 (AC1).
 *
 * ONE table answers "how far back does this venue still serve candles for this timeframe": the
 * PFE outcome backfill's queue, the canary's census and the directional labeler all read
 * `src/lib/venue-candle-reach.ts`. Three properties are pinned here:
 *
 *   1. VALUE IDENTITY. The move out of `backfill-directional-labels.ts` changed no number: the literals
 *      below are the table as it stood on `8087db29`. Exactly ONE correction since, named here:
 *      OPS-CANDLE-REQUEST-OWNER-DERIVATION-W1 CH3 set the five count-limited `2h` rows to their venue's
 *      `1h` row (2h is served as 1h bars), after the relabel (EDGE-LABELER-RACE-WINDOW-V2-W1) and ADS-1
 *      registrations that read these values had CLOSED. Any other change fails.
 *   2. EXHAUSTIVE OVER ExchangeId. A venue without an entry does not compile — "served every row
 *      probed" is spelled `{}`, never by omission.
 *   3. ONE TABLE. `venue-candle-horizons.ts`, a second measurement of the same fact, is deleted (CH3):
 *      nothing imports it, and the labeler's horizon-first worklist reads this table — pinned through
 *      the worklist's behaviour on a pair only this table lists, not only by a grep.
 *
 * SPAWN BUDGET DECLARED on the one spawning block (`scripts/check-test-budget.mjs`).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  VENUE_CANDLE_REACH_DAYS, EXPIRY_REACH_DAYS, EXPIRY_REACH_DAYS_MEASURED_AT, HL_CANDLE_DEPTH, REACH_MARGIN_S,
  expiryReachDays,
} from '../../src/lib/venue-candle-reach.js';
import * as labeler from '../../src/scripts/backfill-directional-labels.js';

const REPO = path.resolve(__dirname, '../..');
const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** The table exactly as `backfill-directional-labels.ts:1147` held it on 8087db29 (measured 2026-09-27). */
const PRE_WAVE_EXPIRY_REACH_DAYS: Record<string, Record<string, number>> = {
  BINGX: { '3m': 2, '5m': 3.25, '15m': 10.25, '30m': 20.75, '1h': 41, '2h': 83 },
  BITGET: { '2h': 8.75, '8h': 51 },
  GATE: { '3m': 34.5, '5m': 34.5, '15m': 104 },
  HL: { '3m': 10.41, '5m': 17.36, '15m': 52.08, '30m': 104.16, '1h': 208.33 },
  HTX: { '3m': 3.25, '5m': 3.25, '15m': 10.25, '30m': 20.75, '1h': 41, '2h': 42 },
  MEXC: { '3m': 6.75, '5m': 6.75, '15m': 20.75, '30m': 41, '1h': 83, '2h': 83 },
  PHEMEX: { '3m': 3.25, '5m': 3.25, '15m': 10.25, '30m': 20.75, '1h': 41, '2h': 42 },
  WEEX: { '3m': 2.08, '5m': 3.47, '15m': 10.41, '30m': 20.83, '1h': 41.66, '2h': 83.33, '4h': 166.66 },
  WHITEBIT: { '5m': 10.25, '15m': 10.25, '30m': 20.75, '1h': 41, '2h': 42 },
  XT: { '3m': 3.25, '5m': 3.25, '15m': 10.25, '30m': 20.75, '1h': 41, '2h': 42 },
};

/** OPS-CANDLE-REQUEST-OWNER-DERIVATION-W1 CH3 — the ONLY values changed since 8087db29: each count-limited `2h`
 *  row set to its venue's `1h` row, because those adapters serve 2h as 1h bars × 1,000 (41.67 d). */
const CH3_2H_CORRECTIONS: Record<string, number> = { HTX: 41, PHEMEX: 41, WEEX: 41.66, WHITEBIT: 41, XT: 41 };

/** The table as it must stand now: the 2026-09-27 measurement with the five CH3 corrections and nothing else. */
function expectedTable(): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = JSON.parse(JSON.stringify(PRE_WAVE_EXPIRY_REACH_DAYS));
  for (const [v, d] of Object.entries(CH3_2H_CORRECTIONS)) out[v]['2h'] = d;
  return out;
}

function exchangeIds(): string[] {
  const src = readFileSync(path.join(REPO, 'src/types.ts'), 'utf8');
  const m = /export type ExchangeId = ([^;]+);/.exec(src);
  if (!m) throw new Error('ExchangeId union not found in src/types.ts');
  return [...m[1].matchAll(/'([A-Z0-9]+)'/g)].map((x) => x[1]).sort();
}

describe('AC1 — value identity: the 2026-09-27 measurements, the five CH3 2h corrections, nothing else', () => {
  it('EXPIRY_REACH_DAYS holds exactly the measured table with the five 2h rows corrected, all 10 venues and every pair', () => {
    expect(EXPIRY_REACH_DAYS).toEqual(expectedTable());
    expect(Object.keys(EXPIRY_REACH_DAYS)).toHaveLength(10);
    expect(Object.values(EXPIRY_REACH_DAYS).reduce((n, m) => n + Object.keys(m).length, 0)).toBe(52);
  });

  it('the margin, the depth and the measurement date are value-identical', () => {
    expect(REACH_MARGIN_S).toBe(3600);
    expect(HL_CANDLE_DEPTH).toBe(5000);
    expect(EXPIRY_REACH_DAYS_MEASURED_AT).toBe('2026-09-27');
  });

  it('each corrected 2h row IS its venue’s 1h measurement — and every other venue’s 2h row is untouched', () => {
    expect(Object.keys(CH3_2H_CORRECTIONS).sort()).toEqual(['HTX', 'PHEMEX', 'WEEX', 'WHITEBIT', 'XT']);
    for (const v of Object.keys(CH3_2H_CORRECTIONS)) expect(EXPIRY_REACH_DAYS[v]['2h'], v).toBe(EXPIRY_REACH_DAYS[v]['1h']);
    for (const v of ['BINGX', 'BITGET', 'MEXC']) expect(EXPIRY_REACH_DAYS[v]['2h'], v).toBe(PRE_WAVE_EXPIRY_REACH_DAYS[v]['2h']);
  });

  it('the labeler re-exports the SAME objects — one table, not a copy', () => {
    expect(labeler.EXPIRY_REACH_DAYS).toBe(EXPIRY_REACH_DAYS);
    expect(labeler.expiryReachDays).toBe(expiryReachDays);
    expect(labeler.HL_CANDLE_DEPTH).toBe(HL_CANDLE_DEPTH);
    expect(labeler.EXPIRY_REACH_DAYS_MEASURED_AT).toBe(EXPIRY_REACH_DAYS_MEASURED_AT);
  });

  it('the labeler no longer DECLARES the table or the margin — it imports them', () => {
    const src = readFileSync(path.join(REPO, 'src/scripts/backfill-directional-labels.ts'), 'utf8');
    expect(src).not.toMatch(/^export const EXPIRY_REACH_DAYS\b/m);
    expect(src).not.toMatch(/^const REACH_MARGIN_S\s*=/m);
    expect(src).toMatch(/from '\.\.\/lib\/venue-candle-reach\.js'/);
  });

  it('expiryReachDays: absent ⇒ Infinity, present ⇒ the measured value', () => {
    expect(expiryReachDays('BINANCE', '1h')).toBe(Infinity);
    expect(expiryReachDays('HL', '5m')).toBe(17.36);
    expect(expiryReachDays('NOT_A_VENUE', '5m')).toBe(Infinity);
  });
});

describe('AC1 — exhaustive over ExchangeId', () => {
  it('VENUE_CANDLE_REACH_DAYS declares exactly the ExchangeId union, unbounded venues as {}', () => {
    expect(Object.keys(VENUE_CANDLE_REACH_DAYS).sort()).toEqual(exchangeIds());
    for (const v of exchangeIds()) {
      expect(VENUE_CANDLE_REACH_DAYS[v as keyof typeof VENUE_CANDLE_REACH_DAYS], v)
        .toEqual(expectedTable()[v] ?? {});
    }
  });

  it('tsc FAILS when any one venue is removed, and compiles when none is', { timeout: 120_000 }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'venue-reach-tsc-'));
    tmpDirs.push(dir);
    writeFileSync(path.join(dir, 'types.ts'),
      `export type ExchangeId = ${exchangeIds().map((v) => `'${v}'`).join(' | ')};\n`);
    const src = readFileSync(path.join(REPO, 'src/lib/venue-candle-reach.ts'), 'utf8')
      .replace("from '../types.js'", "from './types.js'");
    const tsc = path.join(REPO, 'node_modules/.bin/tsc');
    const compile = (body: string) => {
      writeFileSync(path.join(dir, 'venue-candle-reach.ts'), body);
      return spawnSync(tsc, ['--noEmit', '--strict', '--target', 'ES2022', '--module', 'Node16', '--moduleResolution',
        'Node16', path.join(dir, 'venue-candle-reach.ts')], { encoding: 'utf8' });
    };
    expect(compile(src).status).toBe(0);
    const removed = src.replace(/\n  KUCOIN: \{\},\n/, '\n');
    expect(removed).not.toBe(src);
    const r = compile(removed);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/KUCOIN/);
  });
});

describe('CH3 — ONE reach table: the second measurement is gone and the worklist reads this one', () => {
  const RETIRED = path.join(REPO, 'src/lib/venue-candle-horizons.ts');
  const IMPORT_OF_RETIRED = /(?:from\s+|require\x28\s*|import\x28\s*)['"][^'"]*venue-candle-horizons(?:\.js|\.ts)?['"]/;

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) sourceFiles(p, out);
      else if (/\.(?:ts|mts|cts|js|mjs|cjs)$/.test(name)) out.push(p);
    }
    return out;
  }

  it('src/lib/venue-candle-horizons.ts is deleted — there is no second table to drift from', () => {
    expect(existsSync(RETIRED)).toBe(false);
  });

  it('nothing in src, scripts, ops or tests imports it (counted, not sampled)', () => {
    const files = ['src', 'scripts', 'ops', 'tests'].flatMap((d) => sourceFiles(path.join(REPO, d)));
    expect(files.length, 'the corpus is the repo, not an empty glob').toBeGreaterThan(500);
    const importers = files.filter((f) => IMPORT_OF_RETIRED.test(readFileSync(f, 'utf8')));
    expect(importers.map((f) => path.relative(REPO, f))).toEqual([]);
  });

  it('the labeler reads its worklist horizons from this table: a pair ONLY this table listed is now critical', () => {
    // WEEX 30m (20.83 d) was absent from the retired table, so its rows were "deep" and never promoted.
    const now = 1_790_420_000;
    const near = { exchange: 'WEEX', coin: 'ZZZ', timeframe: '30m', todoOldest: now - Math.round(20.5 * 86_400), todoLabelable: 1, todoPastHorizon: 0 };
    const breadth = { exchange: 'WEEX', coin: 'AAA', timeframe: '1h', todoOldest: now - 20.9 * 86_400, todoLabelable: 9, todoPastHorizon: 0 };
    expect(expiryReachDays('WEEX', '30m')).toBe(20.83);
    expect(labeler.orderGroupsForVenue([breadth, near], now).map((g) => g.coin)).toEqual(['ZZZ', 'AAA']);
    expect(labeler.worklistStats([near], now).critical).toBe(1);
  });

  it('the worklist SQL carries every finite pair of this table as its horizon cut-off', () => {
    const now = 1_790_420_000;
    const { text } = labeler.buildGroupsSql({ lookbackCutoff: now - 21 * 86_400, nowSec: now });
    for (const [v, m] of Object.entries(EXPIRY_REACH_DAYS)) {
      for (const [tf, d] of Object.entries(m)) expect(text).toContain(`('${v}', '${tf}', ${Math.floor(now - d * 86_400)})`);
    }
  });
});
