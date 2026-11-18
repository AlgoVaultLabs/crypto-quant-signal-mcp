// regime-forward/forward-run.ts — EDGE-REGIME-FORWARD-W1: the one Mac read of T5 (registration §1, §4, §6).
//
//   npx tsx src/scripts/regime-forward/forward-run.ts --snapshot DIR --census FILE --results FILE
//
// DIR holds the three files the host owed read wrote (pulled from signal-1), FILE the frozen census (vault) and
// FILE the vault's canary-results.jsonl, which carries the owed read's PASS record and the files' sha256. Order:
//   lever → clock → home → a seal that exists (a spent read writes nothing and asks nothing) → source →
//   registration on origin/main, its pins and the served code's fingerprint → census pin → the PASS record and the
//   files' sha256 → the rows under the registered filters → the label-only floors and the label-parity count
//   (logged) → every bar of the read, paced, into the home's store, read back and its manifest logged → the
//   rehearsal → the seal → the scores, from what was verified, with no request and no store read → the result, in
//   the home only (outside the repository; figures stay in the vault). Every step up to the seal is retryable: a
//   rate-limited or unreachable venue leaves the seal unclaimed and a later run resumes from the store.
// Callers gate on the token, never on the exit code alone:
//   REGIME_FORWARD_RUN_VERDICT=PASS | REFUSED — <reason> | INDETERMINATE — <reason>        exit 0 | 1 | 3
// and a PASS also prints the scoring line `REGIME_FORWARD_VERDICT=BINANCE:A4=<S>,A5=<S>;BYBIT:…` (S = PASS, FAIL or
// INDETERMINATE). Only `main()` prints the tokens, and `main()` never injects a seam: a test's run cannot print PASS,
// and a seam run refuses the network source, the registered census, any signal-1 record of this read, a snapshot
// not marked synthetic (so the registered one, whatever its record says) and the registered home.
import fs from 'node:fs';
import path from 'node:path';
import { parseCensus, type Census } from '../regime-diag/frame.js';
import { floorClusters, seedsFor } from '../regime-diag/prims.js';
import type { Bars } from '../regime-diag/archive.js';
import {
  B, CENSUS_SHA256, FILES, MAX_NO_BARS_SHARE, MUTATE, READ_HOST, REGISTRATION, SEAM_HOST, SEAM_MARK, SEED, TFS, VENUES, WAVE, NOT_BEFORE_MS, type Venue,
} from './forward-spec.js';
import {
  FLOORS, RESULT, SEAL, claimSeal, clockRefusal, entryExists, forwardHome, homeRefusal, leverRefusal, log, makeHome,
  registrationRefusal, rehearse, replaceFile, seamHomeRefusal, sha256,
} from './forward-guard.js';
import { findRecord, hasRecordFrom, loadCalls, loadSnapshot, readGz, recordRefusal, seriesKey, type Call, type Loaded } from './snapshot.js';
import { RefusedError, barsOf, guardedSource, isNetworkSource, restSource, type BarSource } from './venue-bars.js';
import { MANIFEST, fillStore, verifyStore, type Plan, type Verified } from './bar-store.js';
import { emptySeries, labelFloors, scoreVenue, servedSeries, t5Census, type LabelFloors, type ScoreOpts, type VenueData, type VenueResult } from './score.js';
import { servedRefusal, type Want } from './served-fingerprint.js';

const REPO = path.resolve(__dirname, '../../..');
const TOKEN = 'REGIME_FORWARD_RUN_VERDICT';
export const LINE_TOKEN = 'REGIME_FORWARD_VERDICT';

/** What a test injects. `main()` never passes one; a result written under it says `study: 'injected'`. */
/** A test seam: its own home, clock, source, resample counts, census pin and served values (never the registered ones). */
export interface Seam { home: string; now: () => number; source: BarSource; opts: ScoreOpts; censusSha256: string; fetch: boolean; served: Want }

export interface RunInput { repo: string; censusFile: string; snapshotDir: string; resultsLog: string; seam?: Seam }
export interface RunResult { verdict: 'PASS' | 'REFUSED' | 'INDETERMINATE'; reason: string; line: string | null; file: string | null }

const real = (p: string): string => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
/** The registered read runs the pinned source in the repository the guard reads: never a compiled or copied harness. */
export const isPinnedSource = (file: string, repo: string): boolean => real(file) === real(path.join(repo, 'src/scripts/regime-forward/forward-run.ts'));

const idOf = (p: string): string | null => { try { const s = fs.statSync(p); return `${s.dev}:${s.ino}`; } catch { return null; } };

/**
 * Re-check N4: the registered read judges only the checkout that runs it — `repo` is the root of the executing
 * forward-run.ts by real path and by device and inode — and runs the pinned source there, never a compiled, copied
 * or linked harness. A test seam judges its own sandbox and does not come here.
 */
export function sourceRefusal(file: string, repo: string): string | null {
  const root = path.resolve(path.dirname(real(file)), '../../..');
  if (real(repo) !== real(root) || idOf(repo) === null || idOf(repo) !== idOf(root)) return `the read judges only the checkout that runs it: ${repo} is not ${root}`;
  return isPinnedSource(file, repo) ? null : 'the read runs the pinned source (tsx src/scripts/regime-forward/forward-run.ts), never a compiled or copied harness';
}

/** The label a caller received against the served label of the last close before the call (correction 2: a count only; CH3 F13). */
export function labelParity(loaded: Loaded, calls: readonly Call[]): { calls: number; equal: number; differ: number; no_row: number } {
  const out = { calls: calls.length, equal: 0, differ: 0, no_row: 0 };
  for (const c of calls) {
    const s = loaded.series.get(seriesKey(c.venue, c.t, c.coin));
    let lo = 0, hi = s ? s.length - 1 : -1, at = -1;
    while (s && lo <= hi) { const mid = (lo + hi) >> 1; if (s[mid].bar < c.atMs) { at = mid; lo = mid + 1; } else hi = mid - 1; }
    if (!s || at < 0) out.no_row++;
    else if (s[at].label === c.label) out.equal++;
    else out.differ++;
  }
  return out;
}

/** One venue's served series, with every bar empty: what the label-only floors read before any bar exists. */
function labelOnly(v: Venue, loaded: Loaded): VenueData {
  const coins = loaded.coins[v];
  const series = coins.map((coin) => TFS.map((tf, t) => {
    const nb = spanBars(v, t);
    const b: Bars = { min: tf.min, nb, O: new Float64Array(nb), H: new Float64Array(nb), L: new Float64Array(nb), C: new Float64Array(nb), V: new Float64Array(nb), cnt: new Int32Array(nb) };
    return servedSeries(v, t, loaded.series.get(seriesKey(v, t, coin)) ?? [], b);
  }));
  return { venue: v, coins, series, bars: coins.map(() => TFS.map(() => null)) };
}

const spanBars = (v: Venue, t: number): number => barsOf([], v, TFS[t], 0).bars.nb;

/** The seeds of the read: one per venue × arm, from the registered seed label (T3's `seedsFor`). */
export function seedsOf(): Record<Venue, ScoreOpts['seeds']> {
  const arms = ['a4Boot', 'a4Shuffle', 'a5Boot', 'a5Shuffle', 'mono'] as const;
  const xs = seedsFor(SEED, VENUES.flatMap((v) => arms.map((a) => `${v}.${a}`)));
  return Object.fromEntries(VENUES.map((v, i) => [v, Object.fromEntries(arms.map((a, k) => [a, xs[i * arms.length + k]]))])) as Record<Venue, ScoreOpts['seeds']>;
}

/** Registration §3.4: a venue with more than MAX_NO_BARS_SHARE of its coins without bars (failed or no_bars) reads INDETERMINATE on both answers. */
export function withBarsRule(r: VenueResult, noBars: number, coins: number): VenueResult {
  if (coins > 0 && noBars / coins <= MAX_NO_BARS_SHARE) return r;
  const cause = `BARS_UNAVAILABLE: ${noBars} of ${coins} coins without bars`;
  return { ...r, A4: { ...r.A4, state: 'INDETERMINATE', cause }, A5: { ...r.A5, state: 'INDETERMINATE', cause } };
}

/** CH3 F2: the registered read reads only the registered census; a test seam reads only its own, never the registered one. */
export const censusRefusalFor = (sha: string, seamPin: string | null): string | null =>
  seamPin === null ? (sha === CENSUS_SHA256 ? null : 'the census does not hash to its pin')
    : sha === CENSUS_SHA256 ? 'a test seam never reads the registered census' : sha === seamPin ? null : 'the census does not hash to its pin';

/**
 * A test seam reads only a synthetic snapshot: every row's `computed_at` and every call's `caller` is SEAM_MARK,
 * which no host read can write (re-check R3). So the registered snapshot is refused under any record, a relabelled
 * host included.
 */
export function seamSnapshotRefusal(snapText: string, callsText: string): string | null {
  const marked = (text: string): boolean => text.split('\n').slice(1).every((l) => l === '' || l.slice(l.lastIndexOf('|') + 1) === SEAM_MARK);
  return marked(snapText) && marked(callsText) ? null : 'a test seam reads only a synthetic snapshot: a row or a call does not carry the seam mark';
}

export const lineOf = (results: readonly VenueResult[]): string => `${LINE_TOKEN}=${results.map((r) => `${r.venue}:A4=${r.A4.state},A5=${r.A5.state}`).join(';')}`;

/** The pairs a venue is asked for, coin by coin: every kept coin at each timeframe it has served rows. */
export function planOf(loaded: Loaded): Plan {
  return Object.fromEntries(VENUES.map((v) => [v, loaded.coins[v].flatMap((coin) => TFS.map((_, t) => ({ coin, t })).filter(({ t }) => (loaded.series.get(seriesKey(v, t, coin)) ?? []).length > 0))])) as Plan;
}

/**
 * One venue's scored inputs, from the rows and the verified bars: a coin with an error answer at any timeframe is
 * dropped whole (every series empty; registration §3.4, CH3 F6), a timeframe without bars is an empty series.
 */
export function venueDataOf(v: Venue, loaded: Loaded, vb: Verified['venues'][Venue]): { data: VenueData; failed: number; noBars: number } {
  const coins = loaded.coins[v];
  let noBars = 0;
  const series = coins.map((coin, pos) => TFS.map((_, t) => {
    const b = vb.failed.has(coin) ? null : vb.bars[pos][t];
    return b ? servedSeries(v, t, loaded.series.get(seriesKey(v, t, coin)) ?? [], b) : emptySeries(t, spanBars(v, t));
  }));
  const bars = coins.map((coin, pos) => TFS.map((_, t) => (vb.failed.has(coin) ? null : vb.bars[pos][t])));
  coins.forEach((coin, pos) => { if (!vb.failed.has(coin) && bars[pos].every((b) => b === null)) noBars++; });
  return { data: { venue: v, coins, series, bars }, failed: vb.failed.size, noBars };
}

export async function forwardRun(input: RunInput): Promise<RunResult> {
  const seam = input.seam;
  const stop = (verdict: 'REFUSED' | 'INDETERMINATE', reason: string): RunResult => ({ verdict, reason, line: null, file: null });
  const lever = leverRefusal();
  if (lever) return stop('REFUSED', lever);
  const now = seam ? seam.now : Date.now;
  const early = clockRefusal(now());
  if (early) return stop('REFUSED', early);
  const home = seam ? seam.home : forwardHome();
  const badHome = homeRefusal(home, input.repo) ?? (seam ? seamHomeRefusal(home) : null);
  if (badHome) return stop('REFUSED', badHome);
  if (seam && isNetworkSource(seam.source)) return stop('REFUSED', 'a test seam never uses the network source');
  // CH3 F1: a spent read writes nothing and asks nothing — not the floors, the rehearsal, the log or a request
  if (entryExists(path.join(home, SEAL)) && MUTATE !== 'seal') return stop('REFUSED', 'the seal exists: T5 has been read');
  // from here every refusal is logged; a log that cannot be appended stops the read with the token (CH3 F3)
  const refuse = (leg: string, verdict: 'REFUSED' | 'INDETERMINATE', reason: string): RunResult => {
    const bad = log(home, { ok: false, leg, reason });
    return stop(verdict, bad ? `${reason} (run.log refused: ${bad})` : reason);
  };
  const noted = (verdict: 'REFUSED' | 'INDETERMINATE', entry: Record<string, unknown>): RunResult | null => {
    const bad = log(home, { ok: true, ...entry });
    return bad ? stop(verdict, `run.log refused: ${bad}`) : null;
  };
  const badSource = seam ? null : sourceRefusal(__filename, input.repo);
  if (badSource) return refuse('source', 'REFUSED', badSource);

  const reg = registrationRefusal(input.repo, seam ? seam.fetch : true);
  if (reg.reason) return refuse('registration', 'REFUSED', reg.reason);
  // review RV1, PRN: the served files of the repository read, judged at the read (a seam's by its own values)
  const served = servedRefusal(input.repo, REGISTRATION, seam ? seam.served : null);
  if (served) return refuse('registration', 'REFUSED', served);
  if (!fs.existsSync(input.censusFile)) return refuse('census', 'INDETERMINATE', 'the census file is absent');
  const censusBytes = fs.readFileSync(input.censusFile), censusSha = sha256(censusBytes);
  const badCensus = censusRefusalFor(censusSha, seam ? seam.censusSha256 : null);
  if (badCensus) return refuse('census', 'REFUSED', badCensus);
  const census: Census = parseCensus(censusBytes.toString('utf8'));
  if (census.panel.length === 0) return refuse('census', 'REFUSED', 'the census names no panel: its coins would be fetched and scored');
  const panel = new Set(census.panel);

  if (!fs.existsSync(input.resultsLog)) return refuse('record', 'INDETERMINATE', 'the results log is absent');
  const jsonl = fs.readFileSync(input.resultsLog, 'utf8');
  if (seam && hasRecordFrom(jsonl, READ_HOST)) return refuse('record', 'REFUSED', `a test seam never reads a ${READ_HOST} record of this read`);
  const rec = findRecord(jsonl);
  const badRec = recordRefusal(rec, input.snapshotDir, seam ? SEAM_HOST : READ_HOST);
  if (badRec) return refuse('record', rec && rec.verdict !== 'PASS' ? 'INDETERMINATE' : 'REFUSED', badRec);

  let loaded: Loaded, calls: ReturnType<typeof loadCalls>;
  try {
    const snapText = readGz(path.join(input.snapshotDir, FILES[0])), callsText = fs.readFileSync(path.join(input.snapshotDir, FILES[2]), 'utf8');
    const notSeam = seam ? seamSnapshotRefusal(snapText, callsText) : null;
    if (notSeam) return refuse('load', 'REFUSED', notSeam);
    loaded = loadSnapshot(snapText, panel);
    calls = loadCalls(callsText, panel);
  } catch (e) {
    return refuse('load', 'INDETERMINATE', (e as Error).message);
  }
  if (loaded.rows === 0) return refuse('load', 'INDETERMINATE', 'no row survives the registered filters');

  // The Python bridge answers before any request (the floor, the seeds and the label floors are its calls), so a
  // broken bridge spends nothing; every call is inside the try (CH3 F4).
  let floorClustersN: number, seeds: Record<Venue, ScoreOpts['seeds']>, parity: ReturnType<typeof labelParity>;
  const floors = {} as Record<Venue, LabelFloors>;
  try {
    parity = labelParity(loaded, calls.calls);
    floorClustersN = seam ? seam.opts.floorClusters : floorClusters();
    seeds = seam ? Object.fromEntries(VENUES.map((v) => [v, seam.opts.seeds])) as Record<Venue, ScoreOpts['seeds']> : seedsOf();
    for (const v of VENUES) floors[v] = labelFloors(labelOnly(v, loaded), t5Census(loaded.coins[v], census.wTf));
    makeHome(home);
    replaceFile(home, FLOORS, `${JSON.stringify({ wave: WAVE, floor_clusters: floorClustersN, drops: loaded.drops, coins: Object.fromEntries(VENUES.map((v) => [v, loaded.coins[v].length])), floors, parity }, null, 1)}\n`);
  } catch (e) {
    return refuse('floors', 'INDETERMINATE', (e as Error).message);
  }
  const f1 = noted('REFUSED', { leg: 'floors', file: FLOORS, sha256: sha256(fs.readFileSync(path.join(home, FLOORS))) });
  if (f1) return f1;

  // CH3 F16: every bar, before the seal, into the home's store; a stopped venue leaves the seal unclaimed
  const src = guardedSource(seam ? seam.source : restSource(), now, panel, home);
  const plan = planOf(loaded);
  let verified: Verified;
  try {
    const filled = await fillStore(home, plan, src, now);
    if (filled.stopped.length) {
      const until = filled.stopped.map((x) => x.untilMs).filter((x): x is number => x !== null);
      return refuse('bars', 'INDETERMINATE', `before the seal: ${filled.stopped.map((x) => x.reason).join('; ')} — nothing is sealed; run again${until.length ? ` after ${new Date(Math.max(...until)).toISOString()}` : ''}`);
    }
    verified = verifyStore(home, plan, loaded.coins, now());
    replaceFile(home, MANIFEST, verified.manifest);
    const f2 = noted('REFUSED', { leg: 'bars', file: MANIFEST, sha256: verified.manifestSha256, requests: filled.requests, fetched: filled.fetched });
    if (f2) return f2;
  } catch (e) {
    return refuse('bars', e instanceof RefusedError ? 'REFUSED' : 'INDETERMINATE', `before the seal: ${(e as Error).message}`);
  }

  const why = rehearse(home);
  if (why) return refuse('rehearsal', 'REFUSED', why);
  const sealed = claimSeal(home, { registration_commit: reg.landed?.commit, census_sha256: censusSha, record_at: rec?.at, bars_manifest_sha256: verified.manifestSha256, claimed_at: new Date(now()).toISOString(), injected: Boolean(seam) });
  if (!sealed.claimed) return refuse('seal', 'REFUSED', sealed.reason as string);
  // CH3 F8: the seal is claimed; a fault writing its record is logged with leg `seal` and the window is spent
  if (sealed.reason) return refuse('seal', 'INDETERMINATE', `after the seal: ${sealed.reason}`);
  const f3 = noted('INDETERMINATE', { leg: 'seal', bars_manifest_sha256: verified.manifestSha256 });
  if (f3) return { ...f3, reason: `after the seal: ${f3.reason}` };

  // after the seal: no request, no store read — only what was verified before it
  const outcome_read_at = new Date(now()).toISOString();
  let results: VenueResult[];
  const bars = {} as Record<Venue, Verified['venues'][Venue]['tally'] & { no_bars: number }>;
  try {
    results = VENUES.map((v) => {
      const x = venueDataOf(v, loaded, verified.venues[v]);
      bars[v] = { ...verified.venues[v].tally, no_bars: x.noBars };
      return withBarsRule(
        scoreVenue(x.data, t5Census(x.data.coins, census.wTf), seam ? { ...seam.opts, seeds: seeds[v] } : { B: B.boot, shuffleB: B.shuffle, permB: B.perm, seeds: seeds[v], floorClusters: floorClustersN }),
        x.failed + x.noBars, x.data.coins.length);
    });
  } catch (e) {
    // after the seal the read is spent: the fault is logged with its leg, and the token says what happened
    return refuse('score', 'INDETERMINATE', `after the seal: ${(e as Error).message}`);
  }
  const line = lineOf(results);
  const text = `${JSON.stringify({
    wave: WAVE, study: seam ? 'injected' : 'registered', seed: SEED, floor_clusters: floorClustersN, line,
    registration: { path: REGISTRATION, commit: reg.landed?.commit, commit_time: reg.landed?.commitTime },
    clocks: { not_before: new Date(NOT_BEFORE_MS).toISOString(), outcome_read_at },
    census_sha256: censusSha, record: rec, bars_manifest_sha256: verified.manifestSha256, drops: loaded.drops, calls_dropped: calls.dropped, parity, floors, bars, venues: results,
  }, null, 1)}\n`;
  try {
    replaceFile(home, RESULT, text);
  } catch (e) {
    return refuse('result', 'INDETERMINATE', `after the seal: ${(e as Error).message}`);
  }
  const f4 = noted('INDETERMINATE', { leg: 'result', line, sha256: sha256(text) });
  if (f4) return { ...f4, reason: `after the seal: ${f4.reason}` };
  return { verdict: 'PASS', reason: 'ok', line, file: path.join(home, RESULT) };
}

function finish(verdict: RunResult['verdict'], reason = 'ok'): void {
  process.stdout.write(verdict === 'PASS' ? `${TOKEN}=PASS\n` : `${TOKEN}=${verdict} — ${reason}\n`);
  process.exitCode = verdict === 'PASS' ? 0 : verdict === 'REFUSED' ? 1 : 3;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const val = (name: string): string | null => { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? path.resolve(argv[i + 1]) : null; };
  const snapshotDir = val('--snapshot'), censusFile = val('--census'), resultsLog = val('--results');
  if (!snapshotDir || !censusFile || !resultsLog) return finish('INDETERMINATE', 'usage: forward-run.ts --snapshot DIR --census FILE --results FILE');
  const r = await forwardRun({ repo: REPO, censusFile, snapshotDir, resultsLog });
  if (r.line) process.stdout.write(`${r.line}\n`);
  if (r.file) process.stdout.write(`result=${r.file}\n`);
  finish(r.verdict, r.reason);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`regime-forward run: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    finish('INDETERMINATE', 'the run threw');
  });
}
