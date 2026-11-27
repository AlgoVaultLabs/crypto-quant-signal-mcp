// regime-15m/r15-venues.ts — EDGE-REGIME-15M-BACKTEST-W1, item 6 (PROCEDURE §4e): the check venues' stored bars.
//
// The read's half of the check table, and it has no network: the bars r15-fetch.ts stored in the study's home, every
// byte checked against the registered manifest before one is parsed, read into T3's 1 m grid. A bar of R minutes
// fills its R minutes: the first R − 1 hold its open, the last its open, high, low, close and volume, so T3's
// aggregation gives the R-minute bar back exactly and no minute shows a price before its bar has reached it. The
// Binance twin is built the same way from T3's archives (`twinGrid`). No coin is named in this file.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aggregate, emptyGrid, finishGrid, type Grid } from '../regime-diag/archive.js';
import { MIN_MS, type Span } from '../regime-diag/diag-spec.js';
import { CHECK_DIR, CHECK_MANIFEST, HOME_NAME, RERUN_SEAL_FILE, SEAL_DIR, SEAL_FILE, STUDY_SPAN, type CheckVenue } from './r15-spec.js';

export const sha256 = (b: string | Buffer): string => crypto.createHash('sha256').update(b).digest('hex');
/** The study's home: under `~/.cache/algovault`, resolved from the user database entry (never from an argument). */
export const homeOf = (): string => path.join(os.userInfo().homedir, '.cache', 'algovault', HOME_NAME);
export const checkDirOf = (home: string = homeOf()): string => path.join(home, CHECK_DIR);
export const sealDirOf = (home: string = homeOf()): string => path.join(home, SEAL_DIR);
export const checkManifestOf = (home: string = homeOf()): string => path.join(checkDirOf(home), CHECK_MANIFEST);
/** True once the read has claimed its seal: no venue is asked after it. */
export const sealed = (home: string = homeOf()): boolean =>
  [SEAL_FILE, RERUN_SEAL_FILE].some((f) => fs.lstatSync(path.join(sealDirOf(home), f), { throwIfNoEntry: false }) !== undefined);

// ── the manifest ──────────────────────────────────────────────────────────────────────────────────────────

export interface CoinRecord {
  coin: string; position: number;
  /** `bars`: stored; `no_bars_in_window`: listed, nothing inside the window; `not_listed`: the venue answers that the instrument does not exist. */
  status: 'bars' | 'no_bars_in_window' | 'not_listed';
  answer?: string;
  first?: string; last?: string; rows?: number; file?: string; bytes?: number; sha256?: string;
}
export interface VenueRecord { venue: CheckVenue; resolution_min: number; pace_ms: number; page_max: number; coins: CoinRecord[]; requests: number; throttled: number; transient: number; started_at: string; finished_at: string; seconds: number }
export interface CheckManifest { wave: string; window: { from: string; to: string }; census_sha256: string; fetcher_sha256: string; venues: VenueRecord[] }

// ── the loader (no network) ─────────────────────────────────────────────────────────────────────────────────

/** A strict decimal: the stored rows are downloaded data, so nothing reaches `Number` unchecked. */
const DECIMAL = /^\d+(\.\d+)?$/;

/** The manifest's record of one venue × coin, or null when the venue has no stored bars for it. */
export function coinRecordOf(m: CheckManifest, v: CheckVenue, coin: string): CoinRecord | null {
  const r = m.venues.find((x) => x.venue === v)?.coins.find((c) => c.coin === coin);
  return r && r.status === 'bars' ? r : null;
}

/** Bars of `minutes` (open in ms, o, h, l, c, v) into a 1 m grid: the first R − 1 minutes hold the open, the last the bar. */
export function replicate(span: Span, minutes: number, bars: ReadonlyArray<readonly [number, number, number, number, number, number]>): { g: Grid; rejected: number } {
  const g = emptyGrid(span);
  let rejected = 0;
  for (const [t, o, h, l, c, v] of bars) {
    const k = (t - span.t0Ms) / MIN_MS;
    if (!Number.isInteger(k) || k % minutes !== 0 || k < 0 || k + minutes > span.n || !(o > 0 && h > 0 && l > 0 && c > 0) || !Number.isFinite(v)) { rejected++; continue; }
    for (let i = 0; i < minutes; i++) {
      const at = k + i, last = i === minutes - 1;
      g.O[at] = o; g.H[at] = last ? h : o; g.L[at] = last ? l : o; g.C[at] = last ? c : o; g.V[at] = last ? v : 0; g.has[at] = 1;
    }
  }
  g.counts.rows = bars.length; g.counts.rejected = rejected;
  return { g: finishGrid(g), rejected };
}

/** The stored bars of one venue × coin, checked against the manifest byte for byte before one is parsed. */
export function loadCheckGrid(m: CheckManifest, dir: string, v: CheckVenue, coin: string, span: Span = STUDY_SPAN): Grid | null {
  const r = coinRecordOf(m, v, coin);
  if (!r) return null;
  const buf = fs.readFileSync(path.join(dir, r.file as string));
  if (sha256(buf) !== r.sha256) throw new Error(`regime-15m: ${r.file} is not the file the check manifest records`);
  const R = m.venues.find((x) => x.venue === v)?.resolution_min as number;
  const lines = buf.toString('latin1').split('\n');
  const bars: Array<[number, number, number, number, number, number]> = [];
  let bad = 0;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].length === 0) continue;
    const f = lines[i].split(',');
    if (f.length !== 6 || !/^\d+$/.test(f[0]) || !f.slice(1).every((x) => DECIMAL.test(x))) { bad++; continue; }
    bars.push([Number(f[0]), Number(f[1]), Number(f[2]), Number(f[3]), Number(f[4]), Number(f[5])]);
  }
  const { g } = replicate(span, R, bars);
  g.counts.rejected += bad;
  return g;
}

/** The Binance twin at `minutes`: T3's 1 m grid aggregated to bars of that length, kept only when whole, and replicated. */
export function twinGrid(g: Grid, minutes: number): Grid {
  if (minutes === 1) return g;
  const b = aggregate(g, minutes), bars: Array<[number, number, number, number, number, number]> = [];
  for (let k = 0; k < b.nb; k++) if (b.cnt[k] === minutes) bars.push([g.span.t0Ms + k * minutes * MIN_MS, b.O[k], b.H[k], b.L[k], b.C[k], b.V[k]]);
  return replicate(g.span, minutes, bars).g;
}
