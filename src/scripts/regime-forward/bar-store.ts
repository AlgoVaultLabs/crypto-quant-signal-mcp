// regime-forward/bar-store.ts — EDGE-REGIME-FORWARD-W1: every venue bar of the read, fetched BEFORE the seal (CH3 F16).
//
// A failure after the seal spends the read (arc lesson 12, 4th instance), so the bars are not fetched after it.
// On or after not_before, before the seal, `fillStore` asks each venue for key A's span of every kept coin ×
// timeframe and writes the venue's answer to the home's store, one file a coin × timeframe: its bars, or its error
// answer. A rate limit stops that venue until its Retry-After and an unreachable venue stops for this run; either
// leaves the seal unclaimed, and a later run resumes from the store, so every retry is pre-seal. `verifyStore` then
// reads every planned file back, refuses one that is absent, foreign or fetched before not_before, builds T3's Bars
// from it and writes the manifest of their sha256, which the run log and the seal record carry. Scoring reads only
// what `verifyStore` returned: nothing is fetched, and nothing of the store is read, after the seal.
import fs from 'node:fs';
import path from 'node:path';
import type { Candle } from '../../types.js';
import type { Bars } from '../regime-diag/archive.js';
import { NOT_BEFORE_MS, TFS, VENUES, WAVE, type Venue } from './forward-spec.js';
import { replaceFile, sha256 } from './forward-guard.js';
import { RateLimitedError, RefusedError, UnreachedError, barsOf, spanOf, type BarSource } from './venue-bars.js';

export const STORE = 'bars';
export const MANIFEST = 'bars-manifest.json';
const STOP = 'stop.json';

/** The coin × timeframe pairs a venue's bars are asked for: every kept coin at each timeframe it has rows. */
export type Plan = Record<Venue, Array<{ coin: string; t: number }>>;

/** One stored answer of a venue for one coin × timeframe. */
export interface Stored { wave: string; venue: Venue; coin: string; tf: string; start_ms: number; end_ms: number; fetched_at_ms: number; answer: 'bars' | 'error'; candles?: number[][]; error?: string }

export const storedName = (v: Venue, t: number, coin: string): string => path.join(STORE, v, TFS[t].key, `${coin}.json`);

/** Each directory of the store is a real directory inside the home: a link or a file there is refused (lesson 11). */
function storeDirs(home: string): string | null {
  for (const rel of [STORE, ...VENUES.flatMap((v) => [path.join(STORE, v), ...TFS.map((tf) => path.join(STORE, v, tf.key))])]) {
    const p = path.join(home, rel);
    let st: fs.Stats | null = null;
    try { st = fs.lstatSync(p); } catch { /* absent: created below */ }
    if (st && !st.isDirectory()) return `${rel} is not a directory of the home`;
    if (!st) fs.mkdirSync(p, { mode: 0o700 });
  }
  return null;
}

function readStored(home: string, rel: string): Stored | null {
  try {
    const s = fs.lstatSync(path.join(home, rel));
    if (!s.isFile()) return null;
    return JSON.parse(fs.readFileSync(path.join(home, rel), 'utf8')) as Stored;
  } catch {
    return null;
  }
}

const stopName = (v: Venue): string => path.join(STORE, v, STOP);

export interface Stop { venue: Venue; reason: string; untilMs: number | null }
export interface Filled { stopped: Stop[]; requests: Record<Venue, number>; fetched: Record<Venue, number> }

/**
 * Asks each venue (in parallel; its coins in turn) for every planned pair that has no stored answer. A pair whose
 * coin already holds an error answer is not asked: the coin is dropped whole (registration §3.4). A `RefusedError`
 * stops the read (a fault, thrown); a rate limit stops its venue until its Retry-After, persisted, so no later run
 * asks it before then; an unreachable venue stops for this run. Plain errors are the venue's answer, stored.
 */
export async function fillStore(home: string, plan: Plan, src: BarSource, now: () => number): Promise<Filled> {
  const bad = storeDirs(home);
  if (bad) throw new RefusedError(bad);
  const requests = Object.fromEntries(VENUES.map((v) => [v, 0])) as Record<Venue, number>;
  const fetched = Object.fromEntries(VENUES.map((v) => [v, 0])) as Record<Venue, number>;
  const stopped: Stop[] = [];
  await Promise.all(VENUES.map(async (v) => {
    const prior = readStored(home, stopName(v)) as unknown as { until_ms?: number; reason?: string } | null;
    if (prior && typeof prior.until_ms === 'number' && now() < prior.until_ms) {
      stopped.push({ venue: v, reason: `${prior.reason ?? 'rate limited'} (stopped by an earlier run)`, untilMs: prior.until_ms });
      return;
    }
    const failed = new Set<string>();
    for (const { coin, t } of plan[v]) {
      const rel = storedName(v, t, coin), have = readStored(home, rel);
      if (have && (have.answer === 'bars' || have.answer === 'error')) { if (have.answer === 'error') failed.add(coin); continue; }
      if (failed.has(coin)) continue;
      const span = spanOf(v, TFS[t]), base = { wave: WAVE, venue: v, coin, tf: TFS[t].key, start_ms: span.startMs, end_ms: span.endMs };
      let rec: Stored;
      try {
        requests[v]++;
        const got: Candle[] = await src(v, coin, TFS[t], span.startMs, span.endMs);
        rec = { ...base, fetched_at_ms: now(), answer: 'bars', candles: got.map((c) => [c.time, c.open, c.high, c.low, c.close, c.volume]) };
        fetched[v]++;
      } catch (e) {
        if (e instanceof RefusedError) throw e;
        if (e instanceof RateLimitedError) {
          replaceFile(home, stopName(v), `${JSON.stringify({ wave: WAVE, venue: v, until_ms: e.untilMs, reason: e.message })}\n`);
          stopped.push({ venue: v, reason: e.message, untilMs: e.untilMs });
          return;
        }
        if (e instanceof UnreachedError) { stopped.push({ venue: v, reason: e.message, untilMs: null }); return; }
        rec = { ...base, fetched_at_ms: now(), answer: 'error', error: (e as Error).message.slice(0, 300) };
        failed.add(coin);
      }
      replaceFile(home, rel, `${JSON.stringify(rec)}\n`);
    }
    if (prior) fs.rmSync(path.join(home, stopName(v)), { force: true });
  }));
  return { stopped, requests, fetched };
}

/** One venue's verified bars: per coin (position = index of `coins`) × timeframe, or null; and the coins dropped. */
export interface VenueBars { bars: Array<Array<Bars | null>>; failed: Set<string>; tally: { files: number; misaligned: number; open: number; bad: number; failed: number } }
export interface Verified { venues: Record<Venue, VenueBars>; manifest: string; manifestSha256: string }

/**
 * Reads back every planned answer, before the seal. A file that is not this read's, is for another pair, or was
 * fetched before not_before refuses the read (thrown as `RefusedError`), and so does a missing one, unless its coin
 * holds an error answer at another timeframe: that coin is dropped whole (registration §3.4, CH3 F6), every series
 * of it empty. Builds T3's Bars of the rest (closed by `nowMs`) and returns the manifest text: each file's sha256
 * and the tallies.
 */
export function verifyStore(home: string, plan: Plan, coins: Record<Venue, string[]>, nowMs: number): Verified {
  const files: Record<string, string> = {};
  const venues = {} as Record<Venue, VenueBars>;
  for (const v of VENUES) {
    const pos = new Map(coins[v].map((c, i) => [c, i]));
    const vb: VenueBars = { bars: coins[v].map(() => TFS.map(() => null)), failed: new Set(), tally: { files: 0, misaligned: 0, open: 0, bad: 0, failed: 0 } };
    const byCoin = new Map<string, number[]>();
    for (const { coin, t } of plan[v]) byCoin.set(coin, [...(byCoin.get(coin) ?? []), t]);
    for (const [coin, ts] of byCoin) {
      const got = ts.map((t) => {
        const rel = storedName(v, t, coin), p = path.join(home, rel);
        let st: fs.Stats;
        try { st = fs.lstatSync(p); } catch { return { t, rel, s: null }; }
        if (!st.isFile()) throw new RefusedError(`${rel} is not a regular file`);
        const bytes = fs.readFileSync(p), s = JSON.parse(bytes.toString('utf8')) as Stored, span = spanOf(v, TFS[t]);
        if (s.wave !== WAVE || s.venue !== v || s.coin !== coin || s.tf !== TFS[t].key || s.start_ms !== span.startMs || s.end_ms !== span.endMs) throw new RefusedError(`${rel} is not this read's answer for its pair`);
        if (!(s.fetched_at_ms >= NOT_BEFORE_MS)) throw new RefusedError(`${rel} was fetched before not_before`);
        if (s.answer !== 'error' && (s.answer !== 'bars' || !Array.isArray(s.candles))) throw new RefusedError(`${rel} holds no answer`);
        files[rel] = sha256(bytes);
        vb.tally.files++;
        return { t, rel, s };
      });
      if (got.some((g) => g.s?.answer === 'error')) { vb.failed.add(coin); continue; }
      const missing = got.find((g) => g.s === null);
      if (missing) throw new RefusedError(`the store lacks ${missing.rel}`);
      for (const g of got) {
        const r = barsOf((g.s?.candles ?? []).map((x) => ({ time: x[0], open: x[1], high: x[2], low: x[3], close: x[4], volume: x[5] })), v, TFS[g.t], nowMs);
        vb.tally.misaligned += r.misaligned; vb.tally.open += r.open; vb.tally.bad += r.bad;
        vb.bars[pos.get(coin) as number][g.t] = r.bars.cnt.some((c) => c > 0) ? r.bars : null;
      }
    }
    vb.tally.failed = vb.failed.size;
    venues[v] = vb;
  }
  const manifest = `${JSON.stringify({ wave: WAVE, files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
    tallies: Object.fromEntries(VENUES.map((v) => [v, venues[v].tally])) }, null, 1)}\n`;
  return { venues, manifest, manifestSha256: sha256(manifest) };
}
