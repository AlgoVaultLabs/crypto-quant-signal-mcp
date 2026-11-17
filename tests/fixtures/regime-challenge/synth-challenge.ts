// tests/fixtures/regime-challenge/synth-challenge.ts — EDGE-REGIME-CHALLENGE-R1-W1: what only the challenge tests need.
//
// A small synthetic round shaped as the registered one: a pre-score window of five whole months, a judge window
// of two, and monthly 1 m archives that also hold a month before the judge's history and a month after its
// window. No real market data. Nothing here is part of a run: the harness never imports this file.
import fs from 'node:fs';
import path from 'node:path';
import { archiveName, type ArchiveStore, type Grid } from '../../../src/scripts/regime-diag/archive.js';
import { MIN_MS, type Span, type Win } from '../../../src/scripts/regime-diag/diag-spec.js';
import type { Loaded } from '../../../src/scripts/regime-diag/frame.js';
import { synthCsv, synthGrid } from '../../../src/scripts/regime-diag/synth.js';
import { JUDGE, PRESCORE, type ChallengeRecord } from '../../../src/scripts/regime-challenge/challenge-spec.js';
import { SYNTH_CENSUS_TEXT, zipSingle } from '../regime-diag/synth-study.js';

const D = 1440;
/** 213 days from 2024-01-01: January … May is the pre-score window, June and July the judge window. */
export const SYN_SPAN: Span = Object.freeze({ t0Ms: Date.UTC(2024, 0, 1), n: 213 * D });
export const SYN_FIT: Win = Object.freeze({ name: 'fit', lo: 0, hi: 152 * D });
export const SYN_HOLD: Win = Object.freeze({ name: 'holdout', lo: 152 * D, hi: 213 * D });
/** Three positions (T3's synthetic census): the third has no archive at all. */
export const SYN_CENSUS_TEXT = SYNTH_CENSUS_TEXT;

/**
 * The two records of the synthetic round. As registered: the pre-score's grid ends where its window ends, and the
 * judge opens the months of its window and, before them, the label-free history a served call needs (100 daily
 * bars before June 1 is February 22) — never January, and never August.
 */
export const SYN_PRESCORE: ChallengeRecord = Object.freeze({
  ...PRESCORE, span: Object.freeze({ t0Ms: SYN_SPAN.t0Ms, n: SYN_FIT.hi }), win: SYN_FIT,
  outcomes: Object.freeze({ first: '2024-01', last: '2024-05' }), archives: Object.freeze({ first: '2024-01', last: '2024-05' }),
});
export const SYN_JUDGE: ChallengeRecord = Object.freeze({
  ...JUDGE, span: SYN_SPAN, win: SYN_HOLD,
  outcomes: Object.freeze({ first: '2024-06', last: '2024-07' }), archives: Object.freeze({ first: '2024-02', last: '2024-07' }),
});
/** The month after the judge's window: an archive of it sits in the store, and no record may open it. */
export const SYN_AFTER = '2024-08';

const HOLE = 100_000;
/** The series of each position: the first whole, the second from day 20 and lacking one minute. */
const SERIES: ReadonlyArray<{ coin: string; key: string; opts: { from?: number; holes?: ReadonlySet<number>; p0?: number } }> = [
  { coin: 'SYNA', key: 'challenge|A', opts: {} },
  { coin: 'SYNB', key: 'challenge|B', opts: { from: 20 * D, holes: new Set([HOLE]), p0: 40 } },
];

const grids = new Map<number, Grid>();
/** Every position's grid on the whole span, as one build of both windows reads it (how T3 registered its tables). */
export function synFullLoad(pos: number): Loaded {
  const s = SERIES[pos];
  if (!s) return { g: null, noArchive: 8 };
  let g = grids.get(pos);
  if (!g) { g = synthGrid(SYN_SPAN, s.key, s.opts); grids.set(pos, g); }
  return { g, noArchive: 0 };
}

const monthOf = (line: string): string => new Date(Number(line.slice(0, line.indexOf(',')))).toISOString().slice(0, 7);

/**
 * Writes the monthly 1 m archives of the synthetic round into the cache of `store`: every month of the span for
 * the two positions that have one, and — for the first — two hours of the month after the span. Returns the names.
 */
export function writeSynArchives(store: ArchiveStore): string[] {
  const names: string[] = [];
  for (const s of SERIES) {
    const byMonth = new Map<string, string[]>();
    for (const line of synthCsv(SYN_SPAN, s.key, s.opts).split('\n')) {
      if (!line) continue;
      const ym = monthOf(line);
      const rows = byMonth.get(ym) ?? [];
      if (rows.length === 0) byMonth.set(ym, rows);
      rows.push(line);
    }
    if (s.coin === 'SYNA') byMonth.set(SYN_AFTER, synthCsv(SYN_SPAN, s.key, { from: SYN_SPAN.n, to: SYN_SPAN.n + 120 }).split('\n').filter(Boolean));
    for (const [ym, rows] of byMonth) {
      const name = archiveName(s.coin, '1m', ym);
      fs.writeFileSync(path.join(store.cache, name), zipSingle(name.replace('.zip', '.csv'), Buffer.from(`${rows.join('\n')}\n`)));
      names.push(name);
    }
  }
  return names.sort();
}

/** The grid minute a UTC month of the registered span starts at (the registered records' tests place archives by it). */
export const minuteOfMonth = (span: Span, ym: string): number => (Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1) - span.t0Ms) / MIN_MS;
