/**
 * tests/unit/backfill-maturity-single-derivation.test.ts — OPS-OUTCOME-BACKFILL-STALL-W1 A1b
 *
 * ── The class this makes structurally impossible ─────────────────────────────────────────────
 * "Is this row workable?" was answered by FOUR independent derivations, and they disagreed. The
 * queue's ADMISSION predicate used a private `TIMEFRAME_SECONDS` map at ONE candle; every
 * consumer's ATTEMPT guard used `(EVAL_CANDLES[tf] + 1)` candles. Measured live 2026-09-06
 * 12:13:41Z, that gap held **2,133 of the 5,000 window slots (43%)** with rows that could not
 * possibly fill — `Batch 14 done: 0 filled, 1970 skipped, 0 errors`.
 *
 * This is the THIRD instance of the same generator in this wave (no-candle skips · thrown errors ·
 * immature rows), so per the estate spine the fix ships as a GATE and not a one-liner:
 *   1. ONE exported horizon — `maturityHorizonMs` / `maturityHorizonS` in `src/lib/pfe-mae.ts`;
 *   2. every admission and attempt site derives from it;
 *   3. THIS test fails if a fifth derivation appears, or if admission and attempt ever disagree
 *      at the boundary — for EVERY timeframe, including the slow lanes whose horizons
 *      (2h=14h · 4h=28h · 8h=40h · 12h=60h · 1d=96h) all exceed the alarm's own 12h threshold.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  EVAL_CANDLES,
  TF_MS,
  maturityHorizonMs,
  maturityHorizonS,
  isMatureAtS,
} from '../../src/lib/pfe-mae.js';
import { buildBackfillQueueSql } from '../../src/lib/performance-db.js';

const NOW_S = 1_788_700_000;

/** Evaluate the emitted per-timeframe maturity arms the way Postgres would. */
function sqlAdmits(sql: string, timeframe: string, createdAtS: number): boolean {
  const m = sql.match(/AND \(\(timeframe = .+?\)\) ORDER BY/);
  if (!m) throw new Error(`no maturity clause in: ${sql}`);
  const arms = [...m[1 - 1].matchAll(/\(timeframe = '([^']+)' AND created_at <= (\d+)\)/g)];
  if (arms.length === 0) throw new Error('maturity clause parsed to zero arms');
  for (const [, tf, bound] of arms) {
    if (tf === timeframe) return createdAtS <= Number(bound);
  }
  return false; // a timeframe with no arm is excluded — the intended refusal
}

describe('A1b — ONE maturity derivation, admission and attempt agree', () => {
  const sql = buildBackfillQueueSql(NOW_S);

  it('the horizon is (EVAL_CANDLES + 1) candles for every known timeframe', () => {
    for (const tf of Object.keys(EVAL_CANDLES)) {
      expect(maturityHorizonMs(tf), tf).toBe((EVAL_CANDLES[tf] + 1) * TF_MS[tf]);
      expect(maturityHorizonS(tf), tf).toBe(maturityHorizonMs(tf)! / 1000);
    }
  });

  it('pins the slow lanes the identifiability guard depends on', () => {
    // These are the horizons F8 measured; if any moves, the canary's NOT_IDENTIFIABLE arm and
    // this queue's admission both shift, so they are pinned by value and not by formula alone.
    const H = 3600;
    expect(maturityHorizonS('1h')).toBe(9 * H);
    expect(maturityHorizonS('2h')).toBe(14 * H);
    expect(maturityHorizonS('4h')).toBe(28 * H);
    expect(maturityHorizonS('8h')).toBe(40 * H);
    expect(maturityHorizonS('12h')).toBe(60 * H);
    expect(maturityHorizonS('1d')).toBe(96 * H);
    expect(maturityHorizonS('3m')).toBeCloseTo(0.65 * H, 6);
    expect(maturityHorizonS('5m')).toBeCloseTo(1.0833333 * H, 2);
  });

  it('an unknown timeframe has NO horizon and is never silently given one', () => {
    expect(maturityHorizonMs('7s')).toBeNull();
    expect(maturityHorizonS('7s')).toBeNull();
    expect(isMatureAtS(0, '7s', NOW_S)).toBe(false);
    expect(sqlAdmits(sql, '7s', 0)).toBe(false);
  });

  // THE CORE ASSERTION. If admission and attempt ever diverge again — at any timeframe, on
  // either side of the boundary — this fails.
  it.each(Object.keys(EVAL_CANDLES))(
    'admission and attempt agree at the boundary: %s',
    (tf) => {
      const h = maturityHorizonS(tf)!;
      const exactlyMature = NOW_S - h;      // boundary: workable
      const oneSecondShort = NOW_S - h + 1; // one second early: NOT workable
      const longMature = NOW_S - h - 86_400;

      for (const [createdAt, expected] of [
        [exactlyMature, true],
        [oneSecondShort, false],
        [longMature, true],
      ] as const) {
        const admitted = sqlAdmits(sql, tf, createdAt);
        const attempted = isMatureAtS(createdAt, tf, NOW_S);
        expect(admitted, `${tf} admission @${createdAt}`).toBe(expected);
        expect(attempted, `${tf} attempt @${createdAt}`).toBe(expected);
        // The property that matters is not either value alone — it is that they MATCH.
        expect(admitted, `${tf} admission/attempt divergence @${createdAt}`).toBe(attempted);
      }
    },
  );

  it('the queue admits NO immature row — the 43%-of-window defect, asserted', () => {
    // One row per timeframe, each one second short of its own horizon.
    const immature = Object.keys(EVAL_CANDLES).map((tf) => ({
      tf, createdAt: NOW_S - maturityHorizonS(tf)! + 1,
    }));
    const admittedAnyway = immature.filter((r) => sqlAdmits(sql, r.tf, r.createdAt));
    expect(admittedAnyway.map((r) => r.tf)).toEqual([]);
  });

  it('the maturity clause is emitted for every known timeframe, from the shared map', () => {
    for (const tf of Object.keys(EVAL_CANDLES)) {
      expect(sql, tf).toContain(`(timeframe = '${tf}' AND created_at <= ${NOW_S - maturityHorizonS(tf)!})`);
    }
  });

  it('the clause moves with `now`, so it is a function of time and not of build', () => {
    const later = buildBackfillQueueSql(NOW_S + 3600);
    expect(later).not.toBe(sql);
    const row = NOW_S - maturityHorizonS('1h')! + 1800; // 30 min short at NOW
    expect(sqlAdmits(sql, '1h', row)).toBe(false);
    expect(sqlAdmits(later, '1h', row)).toBe(true);
  });
});

describe('A1b — no FIFTH derivation can be introduced', () => {
  /** Every tracked .ts under src/, with block and line comments stripped. */
  function sourceFiles(dir: string, out: { path: string; code: string }[] = []) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { sourceFiles(p, out); continue; }
      if (!p.endsWith('.ts')) continue;
      const raw = readFileSync(p, 'utf8');
      // Strip comments BEFORE the ban-grep: a mention in prose is not an invocation, and the
      // explanatory comments are the most valuable lines in these files.
      const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
      out.push({ path: p, code });
    }
    return out;
  }

  const files = sourceFiles('src');

  it('the corpus is non-empty (a ban-grep over nothing is a vacuous pass)', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.path.endsWith('pfe-mae.ts'))).toBe(true);
  });

  it('ONLY pfe-mae.ts computes the (EVAL_CANDLES + 1) horizon', () => {
    // Matches the arithmetic shape regardless of local variable naming: `<anything> + 1) * <ms>`
    // adjacent to a candle-count read, plus the literal historic form.
    const offenders = files.filter(({ path, code }) => {
      if (path.endsWith(join('lib', 'pfe-mae.ts'))) return false;
      return /\(\s*evalCount\s*\+\s*1\s*\)/.test(code)
        || /\(\s*EVAL_CANDLES\s*\[[^\]]+\]\s*\+\s*1\s*\)/.test(code);
    });
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it('no module re-declares a private timeframe→duration map', () => {
    // `TIMEFRAME_SECONDS` in performance-db.ts was exactly this, and it is what diverged.
    const offenders = files.filter(({ path, code }) =>
      !path.endsWith(join('lib', 'pfe-mae.ts')) && /const\s+TIMEFRAME_SECONDS\s*:/.test(code));
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it('every consumer that gates on maturity imports the shared horizon', () => {
    for (const rel of [
      join('src', 'lib', 'performance-db.ts'),
      join('src', 'scripts', 'backfill-outcomes.ts'),
      join('src', 'resources', 'signal-performance.ts'),
      join('src', 'lib', 'band-outcome-lane.ts'),
    ]) {
      const f = files.find((x) => x.path === rel);
      expect(f, `${rel} must exist`).toBeTruthy();
      expect(f!.code, rel).toMatch(/maturityHorizon(Ms|S)|isMatureAtS/);
    }
  });
});
