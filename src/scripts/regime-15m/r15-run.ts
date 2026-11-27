// regime-15m/r15-run.ts — EDGE-REGIME-15M-BACKTEST-W1 CH2: the read, once.
//
//   npx tsx src/scripts/regime-15m/r15-run.ts --census F --cache C --overlay O --archives-manifest M --t3-fit F --out DIR
//
// One read of the registered study, in the registered order (PROCEDURE §1; r15-guard.ts):
//   guard → the label-only fit frame → T3's skeleton → T3's label-only figures (parity, first leg) → the 15m rows →
//   the floors, written to disk → the memory plan → the rehearsal → the seal → the outcomes → the measures, the
//   paired comparisons, the parity leg's path-label figures, Bar A → the check table → the result and its sha256,
//   each recording the registration commit.
// A refusal before the seal reads no outcome and spends nothing; after the seal every fault is written down as
// INDETERMINATE (throw). The check bars are on disk: r15-fetch.ts fetched them before the registration landed and
// the registration pins their manifest. This file and everything it imports open no socket.
//
// Callers gate on the token, never on the exit code alone:
//   REGIME_15M_RUN_VERDICT=PASS | REFUSED — <reason> | INDETERMINATE — <reason>        exit 0 | 1 | 3
// and, when the read ran, the backtest's line before it: REGIME_15M_BACKTEST=PASS | FAIL | FAIL (underpowered) | INDETERMINATE (<causes>).
// Only `main()` prints them, and `main()` never passes a seam: a test's world cannot print a registered read.
import fs from 'node:fs';
import path from 'node:path';
import { months as monthsOf, type ArchiveManifest, type ArchiveStore } from '../regime-diag/archive.js';
import { ALPHA, B_BOOT, ENTRIES_PER_DAY, MIN_MS, SEED, type Span, type Win } from '../regime-diag/diag-spec.js';
import { context } from '../regime-diag/engine.js';
import { parseCensus, withOutcomes, type Census, type Frame, type Loaded } from '../regime-diag/frame.js';
import { floorClusters } from '../regime-diag/prims.js';
import { decide, lineOf, thrown, type Decision } from './r15-decide.js';
import { build15, comparisonRows, frameBytes, frameOf, type Rows15 } from './r15-frame.js';
import {
  archiveLoader, archivesRefusal, checkRefusal, claimSeal, harnessRefusal, leverRefusal, logLine, memoryPlan, memoryRefusal, outRefusal, pinsRefusal,
  registrationOf, rehearse, replaceFile, rerunAuthorization, sealState, skeletonRefusal, sourceRefusal, within, type Months, type Opened, type Sized,
} from './r15-guard.js';
import { joinParity, labelPart, outcomePart, parityOf, recomputeT3Labels, recomputeT3Outcomes, t3FiguresOf, type Parity, type T3Figures } from './r15-parity.js';
import {
  ARCHIVES_PIN, CENSUS_PIN, CENSUS_SHA256, CHECK_PIN, CHECK_VENUES, FIRST_MONTH, LAST_MONTH, MEMORY_BUDGET, PRE_FILE, RERUN_SEAL_FILE, RESULT_FILE, RESULT_SHA_FILE,
  SEAL_FILE, STUDY_SPAN, STUDY_WIN, T3_ARCHIVES_SHA256, T3_FIT_PIN, T3_FIT_SHA256, T3_REGISTRATION, T3_REGISTRATION_COMMIT, TF_KEYS, WAVE, type CheckVenue,
} from './r15-spec.js';
import { measures, preOf, seedsOf, type Measures, type Pre } from './r15-stats.js';
import { checkDirOf, checkManifestOf, homeOf, loadCheckGrid, sha256, twinGrid, type CheckManifest } from './r15-venues.js';

const REPO = path.resolve(__dirname, '../../..');
const TOKEN = 'REGIME_15M_RUN_VERDICT';

/** A synthetic world for the tests: its own grid and window, months, resample count and cluster floor. */
export interface Seam { span: Span; win: Win; months: Months; B: number; F: number }

export interface ReadInput {
  repo: string;
  censusFile: string;
  archives: ArchiveStore;
  /** T3's archive manifest (its store's `regime-diag-archives.json`). */
  archiveManifest: string;
  /** T3's fit result: the parity reference. */
  t3Fit: string;
  /** Where the outputs are written: outside the repository and outside ~/.cache/algovault. */
  out: string;
  /** The study's home: the seal and the check bars. A registered read uses `homeOf()`. */
  home: string;
  now?: () => number;
  log?: (line: string) => void;
  /** Whether the registration leg fetches origin first (a registered read always does). */
  fetchOrigin?: boolean;
}
export interface ReadResult { verdict: 'PASS' | 'REFUSED' | 'INDETERMINATE'; reason: string; line: string | null; file: string | null }

const iso = (ms: number): string => new Date(ms).toISOString();
const text = (o: unknown): string => `${JSON.stringify(o, null, 1)}\n`;
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** One run of the frozen settings on one set of grids: its floors, its measures and Bar A on them. */
export interface RunRead { run: string; coins: number; entries: number; comparison_entries: number; pre: Pre; measures: Measures; decision: Decision; drops: Record<string, number> }

/** What the bare frame of a run needs: the frame, its 15m rows and the comparison rows. */
interface Bare { f0: Frame; r15: Rows15; keep: Uint8Array }
function bareOf(span: Span, win: Win, census: Census, load: (pos: number) => Loaded, say: (l: string) => void): Bare {
  const f0 = frameOf(span, win, census, load, say);
  const r15 = build15(f0, load, say);
  return { f0, r15, keep: comparisonRows(f0, r15) };
}
/** A bare frame's outcomes, measures and Bar A. `parity` is null on a check run. */
function readBare(run: string, b: Bare, pre: Pre, load: (pos: number) => Loaded, B: number, F: number, parity: boolean | null): RunRead & { f: Frame } {
  const f = withOutcomes(b.f0, load);
  const m = measures(f, b.r15, b.keep, F, { B, alpha: ALPHA, seeds: seedsOf(run), run });
  return { run, coins: f.coins.length, entries: f.nE, comparison_entries: pre.comparison_entries, pre, measures: m, decision: decide(m, pre, parity), drops: { ...f.drops, ...b.r15.drops }, f };
}
/** Bytes a bare frame's 15m rows hold beside the frame. */
const rowsBytes = (r: Rows15): number => {
  let n = r.has.byteLength + r.S.lab.byteLength * 2 + r.B.lab.byteLength * 2 + r.phase.byteLength;
  for (const c of r.coins) for (const part of [c.series, c.keyA]) for (const v of Object.values(part as object)) if (ArrayBuffer.isView(v)) n += v.byteLength;
  return n;
};

// ── the check table (item 6, PROCEDURE §4e) ──────────────────────────────────────────────────────────────────

export type Coverage = 'value' | 'no Binance test' | 'NO_HISTORY' | 'not listed';
export interface CheckCoin { position: number; coverage: Coverage; first: string | null; last: string | null }
export interface CheckVenueRead {
  venue: CheckVenue; resolution_min: number; coins: CheckCoin[];
  /** `value` when the venue's run read at least one panel coin Binance also has; `NO_HISTORY` when none. */
  state: 'value' | 'NO_HISTORY';
  venue_run: Omit<RunRead, 'run'> | null;
  /** The Binance twin at the venue's resolution on the same coins; `main read` when that is the main read itself. */
  twin: Omit<RunRead, 'run'> | 'main read' | null;
  /** The coins the venue lists and Binance does not: the same settings, reported as `no Binance test`. */
  no_binance_test: Omit<RunRead, 'run'> | null;
  errors: string[];
}
const slimRun = (r: RunRead & { f?: Frame }): Omit<RunRead, 'run'> => {
  const { run, f, ...rest } = r;
  void run; void f;
  return rest;
};

interface CheckCtx {
  span: Span; win: Win; census: Census; check: CheckManifest; dir: string; binanceLoad: (pos: number) => Loaded; binance: ReadonlySet<number>;
  B: number; F: number; say: (l: string) => void;
}
function checkVenue(v: CheckVenue, x: CheckCtx): CheckVenueRead {
  const rec = x.check.venues.find((r) => r.venue === v);
  if (!rec) throw new Error(`regime-15m: the check manifest has no ${v} record`);
  const R = rec.resolution_min;
  const coins: CheckCoin[] = rec.coins.map((c) => ({
    position: c.position,
    coverage: c.status === 'not_listed' ? 'not listed' : c.status === 'no_bars_in_window' ? 'NO_HISTORY' : x.binance.has(c.position - 1) ? 'value' : 'no Binance test',
    first: c.first ?? null, last: c.last ?? null,
  }));
  const common = new Set(coins.filter((c) => c.coverage === 'value').map((c) => c.position - 1));
  const alone = new Set(coins.filter((c) => c.coverage === 'no Binance test').map((c) => c.position - 1));
  const out: CheckVenueRead = { venue: v, resolution_min: R, coins, state: common.size ? 'value' : 'NO_HISTORY', venue_run: null, twin: null, no_binance_test: null, errors: [] };
  const venueLoad = (set: ReadonlySet<number>) => (pos: number): Loaded => ({ g: set.has(pos) ? loadCheckGrid(x.check, x.dir, v, x.census.panel[pos], x.span) : null, noArchive: 0 });
  const one = (run: string, load: (pos: number) => Loaded): Omit<RunRead, 'run'> | null => {
    try {
      x.say(`${run}: start`);
      const b = bareOf(x.span, x.win, x.census, load, x.say);
      const pre = preOf(b.f0, b.r15, b.keep, x.F);
      const r = slimRun(readBare(run, b, pre, load, x.B, x.F, null));
      x.say(`${run}: ${r.decision.line}`);
      return r;
    } catch (e) {
      out.errors.push(`${run}: ${message(e)}`);
      return null;
    }
  };
  if (common.size) {
    out.venue_run = one(`check:${v}`, venueLoad(common));
    const same = common.size === x.binance.size && [...common].every((p) => x.binance.has(p));
    out.twin = R === 1 && same ? 'main read' : one(`twin:${v}`, (pos) => {
      if (!common.has(pos)) return { g: null, noArchive: 0 };
      const l = x.binanceLoad(pos);
      return { g: l.g ? twinGrid(l.g, R) : null, noArchive: l.noArchive };
    });
  }
  if (alone.size) out.no_binance_test = one(`alone:${v}`, venueLoad(alone));
  return out;
}

// ── the read ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The read: `main()` calls it with the registered inputs; a test calls it with a seam and a world of its own. */
export function readRun(x: ReadInput, seam?: Seam): ReadResult {
  const now = x.now ?? Date.now;
  const say = x.log ?? ((l: string): void => { process.stderr.write(`${iso(now())} regime-15m: ${l}\n`); });
  const stop = (verdict: 'REFUSED' | 'INDETERMINATE', reason: string): ReadResult => ({ verdict, reason, line: null, file: null });
  const started = now();

  // Nothing is written anywhere before the lever and the output directory are cleared.
  const lever = leverRefusal();
  if (lever) return stop('REFUSED', `lever: ${lever}`);
  const outWhy = outRefusal(x.out, x.repo, [x.home]);
  if (outWhy) return stop('REFUSED', `out: ${outWhy}`);
  fs.mkdirSync(x.out, { recursive: true });
  const refuse = (leg: string, reason: string): ReadResult => {
    logLine(x.out, { ok: false, leg, reason }, now);
    say(`${leg}: ${reason}`);
    return stop('REFUSED', `${leg}: ${reason}`);
  };
  const passed = (leg: string, more: Record<string, unknown> = {}): void => {
    const why = logLine(x.out, { ok: true, leg, ...more }, now);
    if (why) throw new Error(`the run log: ${why}`);
    say(`${leg}: ok`);
  };
  if (seam && within(x.home, homeOf())) return refuse('seam', 'a seam names a home of its own, never the study\'s');

  const src = sourceRefusal(x.repo);
  if (src.reason) return refuse('source', src.reason);
  const { reg, reason: regWhy } = registrationOf(x.repo, x.fetchOrigin ?? true);
  if (!reg) return refuse('registration', regWhy as string);
  if (!(now() > Date.parse(reg.commitTime))) return refuse('clock', `the clock reads ${iso(now())}, not after the registration landed (${reg.commitTime})`);
  passed('registration', { registration_commit: reg.commit, commit_time: reg.commitTime, origin_main: reg.originMain, source_commit: src.commit });

  // the inputs, each read once and handed on as the bytes whose sha256 was checked
  const files: Record<string, string> = { [CENSUS_PIN]: x.censusFile, [ARCHIVES_PIN]: x.archiveManifest, [T3_FIT_PIN]: x.t3Fit, [CHECK_PIN]: checkManifestOf(x.home) };
  const bytes: Record<string, Buffer> = {}, inputs: Record<string, string> = {};
  for (const [pin, file] of Object.entries(files)) {
    try { bytes[pin] = fs.readFileSync(file); } catch { return refuse('inputs', `${pin} cannot be read`); }
    inputs[pin] = sha256(bytes[pin]);
  }
  const registered: Record<string, string> = { [CENSUS_PIN]: CENSUS_SHA256, [ARCHIVES_PIN]: T3_ARCHIVES_SHA256, [T3_FIT_PIN]: T3_FIT_SHA256 };
  for (const [pin, want] of Object.entries(registered)) {
    if (seam && inputs[pin] === want) return refuse('seam', `a seam never reads the registered ${pin}`);
    if (!seam && inputs[pin] !== want) return refuse('inputs', `${pin} is not the input the sibling spec registers`);
  }
  const pinWhy = pinsRefusal(x.repo, reg.text, inputs);
  if (pinWhy) return refuse('pins', pinWhy);
  const harness = harnessRefusal(x.repo);
  if (harness) return refuse('harness', harness);
  const seal = sealState(x.home, reg.text);
  if (!seal.mode) return refuse('seal', seal.reason as string);
  passed('pins', { inputs, read: seal.mode });

  const span = seam?.span ?? STUDY_SPAN, win = seam?.win ?? STUDY_WIN, mo: Months = seam?.months ?? { first: FIRST_MONTH, last: LAST_MONTH };
  const B = seam?.B ?? B_BOOT, F = seam?.F ?? floorClusters();
  if (win.lo !== 0 || win.hi !== span.n) return refuse('window', 'the study\'s window is its whole grid');
  const window = { from: iso(span.t0Ms), to: iso(span.t0Ms + span.n * MIN_MS) };
  let census: Census, manifest: ArchiveManifest, check: CheckManifest, t3: T3Figures;
  try {
    census = parseCensus(bytes[CENSUS_PIN].toString('utf8'));
    manifest = JSON.parse(bytes[ARCHIVES_PIN].toString('utf8')) as ArchiveManifest;
    check = JSON.parse(bytes[CHECK_PIN].toString('utf8')) as CheckManifest;
    const t3json = JSON.parse(bytes[T3_FIT_PIN].toString('utf8')) as { kind?: string; study?: string; seed?: string; floor_clusters?: number; registration?: { commit?: string }; counts?: Record<string, { boot?: number }> };
    t3 = t3FiguresOf(t3json);
    const asRead = [t3json.kind === 'fit', t3json.study === (seam ? 'injected' : 'registered'), t3json.seed === SEED, t3json.floor_clusters === F,
      t3json.counts?.['A4.S']?.boot === B, t3json.counts?.M12?.boot === B, seam ? true : t3json.registration?.commit === T3_REGISTRATION_COMMIT];
    if (!asRead.every(Boolean)) return refuse('carry', 'T3\'s fit result is not the fit read of T3\'s registration at its seed, floor and resample counts');
  } catch (e) {
    return refuse('inputs', `an input does not parse: ${message(e)}`);
  }
  if (manifest.interval !== '1m') return refuse('archives', 'the archive manifest is not of 1 m archives');
  const archWhy = archivesRefusal(x.archives, manifest, census.panel, mo);
  if (archWhy) return refuse('archives', archWhy);
  const checkWhy = checkRefusal(check, checkDirOf(x.home), census.panel, inputs[CENSUS_PIN], window);
  if (checkWhy) return refuse('check', checkWhy);
  passed('inputs', { months: { first: mo.first, last: mo.last, count: monthsOf(mo.first, mo.last).length } });

  // label-only: T3's fit frame, its skeleton, T3's label-only figures, the 15m rows, the floors
  const opened: Opened = new Map();
  const load = archiveLoader(x.archives, manifest, census.panel, span, mo, opened);
  let bare: Bare | null = bareOf(span, win, census, load, say);
  const skWhy = skeletonRefusal(bare.f0, fs.readFileSync(path.join(x.repo, T3_REGISTRATION), 'utf8'));
  if (skWhy) return refuse('skeleton', skWhy);
  passed('skeleton');
  const parity0 = parityOf(labelPart(t3), recomputeT3Labels(bare.f0, B));
  if (!parity0.ok) {
    logLine(x.out, { ok: false, leg: 'parity-labels', misses: parity0.misses.slice(0, 20) }, now);
    return refuse('parity', `T3's label-only figures are not reproduced: ${parity0.misses.length} of ${parity0.compared} differ (${parity0.misses.slice(0, 3).map((m) => m.field).join(', ')})`);
  }
  passed('parity-labels', { compared: parity0.compared });
  const pre = preOf(bare.f0, bare.r15, bare.keep, F);
  const binance = new Set(bare.f0.coins.map((c) => c.pos));
  const preRecord = {
    wave: WAVE, kind: 'pre-outcome', study: seam ? 'injected' : 'registered', read: seal.mode,
    registration: { path: reg.path, commit: reg.commit, commit_time: reg.commitTime, origin_main: reg.originMain }, source_commit: src.commit, inputs, window,
    timeframes: TF_KEYS, F, B, alpha: ALPHA, pre, drops: { ...bare.f0.drops, ...bare.r15.drops }, archive_months_opened: [...opened.keys()].sort(), written_at: iso(now()),
  };

  // the memory plan: the main run as built, and the largest a check run on this window and panel can be
  const days = Math.ceil(span.n / 1440), base: Sized = { bytes: frameBytes(bare.f0) + rowsBytes(bare.r15), nE: bare.f0.nE, clusters: context(bare.f0).nCl };
  const boundNE = ENTRIES_PER_DAY * days * census.panel.length;
  const bound: Sized = { bytes: Math.ceil(base.bytes * Math.max(1, boundNE / Math.max(1, base.nE))), nE: boundNE, clusters: days * census.panel.length };
  const plan = memoryPlan([base], bound);
  const memWhy = memoryRefusal(plan, MEMORY_BUDGET);
  if (memWhy) return refuse('memory', memWhy);
  passed('memory', { plan });

  const rehearsal = rehearse(x.out, now);
  if (rehearsal) return refuse('rehearsal', rehearsal);
  const preText = text(preRecord), preSha = sha256(preText);
  replaceFile(x.out, PRE_FILE, preText);
  passed('pre', { pre_sha256: preSha });

  const sealFile = seal.mode === 'first' ? SEAL_FILE : RERUN_SEAL_FILE;
  const claim = claimSeal(x.home, sealFile, { registration_commit: reg.commit, origin_main: reg.originMain, source_commit: src.commit, inputs, pre_sha256: preSha, claimed_at: iso(now()) });
  if (!claim.claimed) return refuse('seal', claim.reason as string);
  passed('seal', { file: sealFile, fault: claim.reason });

  // ── after the seal: the read is spent, and every fault is written down ────────────────────────────────────
  let main: (RunRead & { f?: Frame }) | null = null, parity: Parity | null = null, decision: Decision | null = null, fault: string | null = null;
  try {
    const r = readBare('main', bare, pre, load, B, F, null);
    parity = joinParity(parity0, parityOf(outcomePart(t3), recomputeT3Outcomes(r.f, F, B)));
    decision = decide(r.measures, pre, parity.ok);
    main = { ...r, decision };
    passed('main', { line: decision.line, parity: parity.ok });
  } catch (e) {
    fault = `main: ${message(e)}`;
    say(fault);
  }
  bare = null;
  const mainSlim = main ? slimRun(main) : null;
  main = null;
  const venues: CheckVenueRead[] = [];
  if (mainSlim) {
    for (const v of CHECK_VENUES) {
      try {
        venues.push(checkVenue(v, { span, win, census, check, dir: checkDirOf(x.home), binanceLoad: load, binance, B, F, say }));
      } catch (e) {
        venues.push({ venue: v, resolution_min: NaN, coins: [], state: 'NO_HISTORY', venue_run: null, twin: null, no_binance_test: null, errors: [`${v}: ${message(e)}`] });
      }
    }
  }
  const t = decision ?? { ...thrown(), criteria: [], map: [] };
  const line = decision ? decision.line : lineOf('INDETERMINATE', ['throw']);
  const result = {
    wave: WAVE, kind: 'regime-15m-read', study: seam ? 'injected' : 'registered', read: seal.mode, rerun_reason: seal.mode === 'rerun' ? rerunAuthorization(reg.text) : null,
    registration: { path: reg.path, commit: reg.commit, commit_time: reg.commitTime, origin_main: reg.originMain, last_commit: reg.lastCommit }, source_commit: src.commit,
    inputs, pre_sha256: preSha, window, timeframes: TF_KEYS, F, B, alpha: ALPHA,
    verdict: { state: t.state, causes: t.causes, line }, criteria: t.criteria, map: t.map,
    main: mainSlim, parity, fault,
    check: { fit_venue: 'BINANCE', venues },
    archive_months_opened: [...opened.keys()].sort(), memory: plan, seal: { file: sealFile, fault: claim.reason },
    started_at: iso(started), finished_at: iso(now()),
  };
  const resultText = text(result), resultSha = sha256(resultText);
  replaceFile(x.out, RESULT_FILE, resultText);
  replaceFile(x.out, RESULT_SHA_FILE, `${resultSha}  ${RESULT_FILE}\nregistration_commit: ${reg.commit}\n`);
  passed('result', { sha256: resultSha, line });
  const file = path.join(x.out, RESULT_FILE);
  return fault ? { verdict: 'INDETERMINATE', reason: `the read threw after its seal (${fault}); the result records it`, line, file } : { verdict: 'PASS', reason: '', line, file };
}

// ── the CLI ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The registered read runs from this repository's own source, never a compiled or copied one. */
export const isPinnedSource = (file: string, repo: string): boolean => {
  try { return fs.realpathSync(file) === fs.realpathSync(path.join(repo, 'src/scripts/regime-15m/r15-run.ts')); } catch { return false; }
};

function finish(verdict: ReadResult['verdict'], reason = ''): void {
  process.stdout.write(verdict === 'PASS' ? `${TOKEN}=PASS\n` : `${TOKEN}=${verdict} — ${reason}\n`);
  process.exitCode = verdict === 'PASS' ? 0 : verdict === 'REFUSED' ? 1 : 3;
}

function main(): void {
  const argv = process.argv.slice(2);
  const names = ['--census', '--cache', '--overlay', '--archives-manifest', '--t3-fit', '--out'];
  const val = (name: string): string | null => { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? path.resolve(argv[i + 1]) : null; };
  const [censusFile, cache, overlay, archiveManifest, t3Fit, out] = names.map(val);
  if (argv.length !== 2 * names.length || !censusFile || !cache || !overlay || !archiveManifest || !t3Fit || !out) {
    return finish('INDETERMINATE', `usage: r15-run.ts ${names.map((n) => `${n} <path>`).join(' ')}`);
  }
  if (!isPinnedSource(__filename, REPO)) return finish('REFUSED', 'the registered read runs from the repository\'s own source (tsx src/scripts/regime-15m/r15-run.ts)');
  const r = readRun({ repo: REPO, censusFile, archives: { cache, overlay }, archiveManifest, t3Fit, out, home: homeOf() });
  if (r.line) process.stdout.write(`${r.line}\n`);
  if (r.file) process.stdout.write(`result=${r.file}\n`);
  finish(r.verdict, r.reason);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`regime-15m run: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    finish('INDETERMINATE', 'the run threw');
  }
}
