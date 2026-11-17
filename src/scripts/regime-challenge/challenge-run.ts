// regime-challenge/challenge-run.ts — EDGE-REGIME-CHALLENGE-R1-W1 (T6, round 1): the run CLI.
//
//   npx tsx src/scripts/regime-challenge/challenge-run.ts --prescore   --census F --cache C --overlay O --manifest M --out DIR
//   npx tsx src/scripts/regime-challenge/challenge-run.ts --init-store --census F --cache C --overlay O --store S
//   npx tsx src/scripts/regime-challenge/challenge-run.ts --judge      --census F --cache C --overlay O --store S --prescore-result FILE --out DIR
//
// `--prescore` reads 2024-01 … 2025-12 and no other month: in-sample, internal, selection only. It needs no
// registration and claims no seal; `M` is T3's archive-store manifest, read and never written.
// `--judge` is the one read of 2026-01 … 2026-10: behind the pinned guard (`checkDiagGuard`, asked of this round's
// record), under a registration landed on origin/main, with the pre-score result it pins by sha256, and behind the
// seal `challenge-r1.seal` in the one seal home. Its order is T3's: guard → skeleton → identifiability → seal →
// outcomes. Its result holds paired quantities only — challenger minus served, challenger over served.
// `--init-store` writes the judge's own store (the two manifests its registration pins): T3's store is never written.
// `S` and `DIR` sit outside the repository: no figure is written into it.
//
// Callers gate on the token, never on the exit code alone:
//   REGIME_CHALLENGE_RUN_VERDICT=PASS | REFUSED — <reason> | INDETERMINATE — <reason>        exit 0 | 1 | 3
// Only `main()` prints the token, and `main()` never injects a study: a test's study cannot print PASS.
import fs from 'node:fs';
import path from 'node:path';
import { pinsOf } from '../sr-backtest/guard.js';
import { writeAtomic } from '../sr-backtest/store.js';
import { sha256, type ArchiveManifest, type ArchiveStore } from '../regime-diag/archive.js';
import { ALPHA, B_BOOT, B_SHUFFLE, REGISTRATION as T3_REGISTRATION, VENUE } from '../regime-diag/diag-spec.js';
import { context, type Ctx } from '../regime-diag/engine.js';
import { buildFrames, parseCensus, withOutcomes, type Census, type Frame, type Loaded } from '../regime-diag/frame.js';
import { ARCHIVES_PIN, carryRefusal, checkDiagGuard, claimSeal, initStore, logGuard, sealHome } from '../regime-diag/guard.js';
import { MUTATE } from '../regime-diag/mutate.js';
import { PARITY_FIXTURE, checkCoreParity } from '../regime-diag/parity.js';
import { floorClusters, seedsFor } from '../regime-diag/prims.js';
import { archivesRefusal, landedSource, real, recordLoader, registrationOnMain, skeletonRefusal, within, type Opened } from './challenge-guard.js';
import {
  CANDIDATES, CENSUS_SHA256, CHALLENGE_SEED, JUDGE, PRESCORE, PRESCORE_PIN, REGISTRATION_RE, REQUIRED_PINS, T3_ARCHIVES_SHA256, candidateOf, coinDaysOf, judgeStudyRecord, windowRefusal,
  type Candidate, type ChallengeRecord, type Dial,
} from './challenge-spec.js';
import { challengerColumns, checkChallengerParity } from './challenger-replay.js';
import {
  a4Difference, a4Guard, a5Guard, a5Ratio, armSums, coverageGuard, coverageRatio, deltaDelta1, holm, pairOf, powerAt, sameDial, supportOf,
  type ArmSums, type GuardState, type Pair, type PairedReading,
} from './paired-stats.js';

const REPO = path.resolve(__dirname, '../../..');
const TOKEN = 'REGIME_CHALLENGE_RUN_VERDICT';
const PRESCORE_LOG = 'regime-challenge-r1-prescore.log';

export interface Counts { boot: number; shuffle: number }
/**
 * What a test injects in place of the registered round: a synthetic record (its own grid, window and months),
 * read through the record's own loader unless the test names another. It may shrink the resample counts and lower
 * the cluster floor; its results carry `study: 'injected'`, and a judge refuses a pre-score of the other kind.
 */
export interface ChallengeStudy {
  rec: ChallengeRecord;
  load?: (pos: number) => Loaded;
  counts?: Counts;
  floorClusters?: number;
  log?: (line: string) => void;
  /** Where a synthetic judge keeps its seal. A test must name it; the registered judge's is `sealHome()`. */
  sealHome?: string;
  /** The sha256 a synthetic pre-score holds its census and its archive manifest to. */
  pins?: { census: string; archives: string };
}
export interface RunResult { verdict: 'PASS' | 'REFUSED' | 'INDETERMINATE'; reason: string; line: string | null; file: string | null }

const jsonText = (x: unknown): string => `${JSON.stringify(x, null, 1)}\n`;
/** The pins bind the code that runs only when the running file IS the landed source of the repository the run reads. */
export const isChallengeSource = (file: string, repo: string): boolean => real(file) === real(path.join(repo, 'src/scripts/regime-challenge/challenge-run.ts'));
const countsOf = (study?: ChallengeStudy): Counts => ({ boot: Math.min(B_BOOT, study?.counts?.boot ?? B_BOOT), shuffle: Math.min(B_SHUFFLE, study?.counts?.shuffle ?? B_SHUFFLE) });

// ── before any outcome: the frame, its checks, the challenger columns, the support of each pair ────────────────

interface Item { cand: Candidate; pair: Pair; support: ReturnType<typeof supportOf>; coverage: number }
interface Prepared { f: Frame; ctx: Ctx; F: number; calls: number; items: Item[] }
interface Stop { stop: 'REFUSED' | 'INDETERMINATE'; leg: string; reason: string }
const isStop = (x: Prepared | Stop): x is Stop => 'stop' in x;

function prepare(rec: ChallengeRecord, census: Census, load: (pos: number) => Loaded, cands: readonly Candidate[], tables: string, F: number, log: (l: string) => void): Prepared | Stop {
  const f = buildFrames(rec.span, [rec.win], census, load, { outcomes: false, seed: rec.entrySeed, log: (l) => log(`frames: ${l}`) })[0];
  if (f.nE === 0) return { stop: 'INDETERMINATE', leg: 'skeleton', reason: `the ${rec.id} window holds no entry` };
  const sk = skeletonRefusal(f, tables);
  if (sk) return { stop: 'REFUSED', leg: 'skeleton', reason: sk };
  log('skeleton: equal');
  const win = windowRefusal(rec, f);
  if (win) return { stop: 'REFUSED', leg: 'window', reason: win };
  const dials: Dial[] = [];
  for (const c of cands) if (c.dial && !dials.some((d) => sameDial(d, c.dial as Dial))) dials.push(c.dial);
  const cols = dials.length ? challengerColumns(f, load, dials) : null;
  log(`challengers: ${cols ? cols.calls : 0} calls`);
  const ctx = context(f);
  const items = cands.map((cand) => { const pair = pairOf(f, cand, cols); return { cand, pair, support: supportOf(f, ctx, pair, F), coverage: coverageRatio(ctx.w, pair) }; });
  return { f, ctx, F, calls: cols ? cols.calls : 0, items };
}

// ── the outcomes: every paired reading of every identifiable pair ───────────────────────────────────────────────

interface CandRead { dd: PairedReading | null; a4: PairedReading | null; a5: PairedReading | null }
function readPairs(rec: ChallengeRecord, P: Prepared, load: (pos: number) => Loaded, counts: Counts, arms: boolean, log: (l: string) => void): Map<string, CandRead> {
  // the outcomes are formed only when a pair is identifiable: a round with none reads no path at all
  let fo: Frame | null = null;
  const names = [...P.items.flatMap((it) => ['ddelta1|bootstrap', 'a4|bootstrap', 'a5|bootstrap', 'a5|shuffle'].map((k) => `${rec.id}|${it.cand.id}|${k}`)), `${rec.id}|served|a5|shuffle`];
  const values = seedsFor(CHALLENGE_SEED, names);
  const seed = (k: string): number => values[names.indexOf(`${rec.id}|${k}`)];
  // the served arm's per-bar sums depend on its sequences alone: one pass for the pairs that share them
  const servedArm = new Map<string, ArmSums>();
  const out = new Map<string, CandRead>();
  for (const it of P.items) {
    const id = it.cand.id;
    if (!it.support.identifiable) { out.set(id, { dd: null, a4: null, a5: null }); continue; }
    fo ??= withOutcomes(P.f, load);
    const o = (k: string): { B: number; alpha: number; seed: number; arms: boolean } => ({ B: counts.boot, alpha: ALPHA, seed: seed(`${id}|${k}|bootstrap`), arms });
    const dd = deltaDelta1(fo, P.ctx, it.pair, o('ddelta1'));
    const g4 = a4Difference(fo, P.ctx, it.pair, o('a4'));
    const kind = it.cand.dial ? 'rows' : 'timeframe';
    let served = servedArm.get(kind);
    if (!served) { served = armSums(fo.census, it.pair.servSeqs, counts.shuffle, seed('served|a5|shuffle')); servedArm.set(kind, served); }
    const g5 = a5Ratio(fo.census, id, armSums(fo.census, it.pair.chalSeqs, counts.shuffle, seed(`${id}|a5|shuffle`)), served, o('a5'));
    out.set(id, { dd, a4: g4, a5: g5 });
    log(`paired: ${id}`);
  }
  return out;
}

const num = (x: number): number | null => (Number.isFinite(x) ? x : null);
/** A reading as it is written: no replicate, and the arms only where the reading carries them. */
const slim = (r: PairedReading | null): Record<string, unknown> | null => (r ? {
  point: num(r.point), lb: num(r.lb), ub: num(r.ub), alpha: r.alpha, rows: r.rows, clusters: r.clusters, eff: r.eff, B: r.B, undefined_replicates: r.undefinedReplicates,
  ...(r.arms ? { arms: { challenger: num(r.arms.challenger), served: num(r.arms.served) } } : {}),
} : null);
const halfWidth = (r: PairedReading): number => (r.ub - r.lb) / 2;

// ── the pre-score: selection ─────────────────────────────────────────────────────────────────────────────────────

export interface PrescoreRow { id: Candidate['id']; challenger: Candidate['challenger']; identifiable: boolean; point: number; guards: readonly GuardState[] }
export interface Selection { judged: string[]; verdicts: Record<string, 'JUDGE' | 'KEEP (pre-score)'>; causes: Record<string, string> }
/**
 * The selection rule, fixed before the pre-score ran. A challenger with two candidate values takes the one with
 * the larger ΔΔ1 point (the first listed on an exact tie). It goes to the judge iff that candidate is
 * identifiable, its ΔΔ1 point is above 0, and every guard holds — a guard that could not be read did not hold.
 */
export function selectionOf(rows: readonly PrescoreRow[]): Selection {
  const sel: Selection = { judged: [], verdicts: {}, causes: {} };
  for (const ch of [...new Set(rows.map((r) => r.challenger))]) {
    const mine = rows.filter((r) => r.challenger === ch);
    const read = mine.filter((r) => r.identifiable && Number.isFinite(r.point));
    const best = read.reduce<PrescoreRow | null>((b, r) => (b === null || r.point > b.point ? r : b), null);
    const cause = !best ? 'no candidate could be read in-sample'
      : !(best.point > 0) ? `${best.id}: the ΔΔ1 point is not above 0`
        : best.guards.some((g) => g !== 'holds') ? `${best.id}: a guard ${best.guards.includes('fails') ? 'fails' : 'could not be read'} in-sample` : '';
    sel.verdicts[ch] = cause ? 'KEEP (pre-score)' : 'JUDGE';
    sel.causes[ch] = cause || `${(best as PrescoreRow).id} goes to the judge`;
    if (!cause) sel.judged.push((best as PrescoreRow).id);
  }
  return sel;
}

export interface PrescoreInput {
  repo: string;
  censusFile: string;
  archives: ArchiveStore;
  /** T3's archive-store manifest (`regime-diag-archives.json` of T3's store): read, never written. */
  manifest: string;
  /** Where the result and the run's log are written. Outside the repository. */
  out: string;
  /** Repo-relative path of the registration whose Tables 2a–2e the frame is checked against (T3's). */
  tables?: string;
  study?: ChallengeStudy;
}

/**
 * The in-sample read: every candidate's ΔΔ1, guards and coverage on the pre-score record's window, the judge
 * window's power arithmetic, and the selection. Opens no month outside the record's; writes outside the repository.
 */
export function prescoreRun(input: PrescoreInput): RunResult {
  const log = input.study?.log ?? ((l: string): void => { process.stderr.write(`regime-challenge: ${l}\n`); });
  const stop = (verdict: 'REFUSED' | 'INDETERMINATE', reason: string): RunResult => ({ verdict, reason, line: null, file: null });
  if (within(input.out, input.repo)) return stop('REFUSED', 'the output directory must sit outside the repository');
  fs.mkdirSync(input.out, { recursive: true });
  const record = (entry: Record<string, unknown>): void => { fs.appendFileSync(path.join(input.out, PRESCORE_LOG), `${JSON.stringify({ at: new Date().toISOString(), wave: PRESCORE.wave, record: PRESCORE.id, ...entry })}\n`); };
  const refuse = (leg: string, verdict: 'REFUSED' | 'INDETERMINATE', reason: string): RunResult => { record({ ok: false, leg, reason }); return stop(verdict, reason); };
  if (MUTATE !== '') return refuse('mutation', 'REFUSED', `REGIME_DIAG_MUTATE is set (${MUTATE}): a deliberately broken harness computes no outcome`);
  if (!input.study && !isChallengeSource(__filename, input.repo)) return refuse('source', 'REFUSED', 'the pre-score is read by the landed sources of its repository (tsx src/scripts/regime-challenge/challenge-run.ts), never a compiled or copied harness');
  const source = landedSource(input.repo);
  if (!source.ok) return refuse('source', 'REFUSED', source.reason);
  const want = input.study ? input.study.pins : { census: CENSUS_SHA256, archives: T3_ARCHIVES_SHA256 };
  if (!want) return refuse('pins', 'REFUSED', 'a synthetic study must name the sha256 of its census and of its archive manifest');
  if (!fs.existsSync(input.censusFile)) return refuse('census', 'INDETERMINATE', 'the census file is absent');
  const censusBytes = fs.readFileSync(input.censusFile);
  if (sha256(censusBytes) !== want.census) return refuse('census', 'REFUSED', 'the census file is not the registered one');
  if (!fs.existsSync(input.manifest)) return refuse('archives', 'INDETERMINATE', 'the archive-store manifest is absent');
  const manifestBytes = fs.readFileSync(input.manifest);
  if (sha256(manifestBytes) !== want.archives) return refuse('archives', 'REFUSED', 'the archive-store manifest is not the registered one');
  const census = parseCensus(censusBytes.toString('utf8'));
  const rec = input.study?.rec ?? PRESCORE;
  const stale = archivesRefusal(rec, input.archives, census.panel, JSON.parse(manifestBytes.toString('utf8')) as ArchiveManifest);
  if (stale) return refuse('archives', 'REFUSED', stale);
  const fixture = fs.readFileSync(path.join(input.repo, PARITY_FIXTURE), 'utf8');
  const core = checkCoreParity(fixture);
  if (!core.ok) return refuse('parity', 'REFUSED', core.reason);
  const copy = checkChallengerParity(fixture);
  if (!copy.ok) return refuse('parity', 'REFUSED', copy.reason);
  const tablesFile = path.join(input.repo, input.tables ?? T3_REGISTRATION);
  if (!fs.existsSync(tablesFile)) return refuse('skeleton', 'INDETERMINATE', 'the registration whose tables the frame is checked against is absent');

  const opened: Opened = new Map();
  const load = input.study?.load ?? recordLoader(rec, input.archives, census.panel, opened);
  const F = input.study?.floorClusters ?? floorClusters();
  const P = prepare(rec, census, load, CANDIDATES, fs.readFileSync(tablesFile, 'utf8'), F, log);
  if (isStop(P)) return refuse(P.leg, P.stop, P.reason);
  record({ ok: true, leg: 'frame', entries: P.f.nE, months_opened: [...opened.keys()].sort() });

  const counts = countsOf(input.study);
  record({ ok: true, leg: 'outcomes', outcome_read_at: new Date().toISOString() });
  log('outcomes: pre-score');
  const reads = readPairs(rec, P, load, counts, true, log);

  const scale = Math.sqrt(coinDaysOf(PRESCORE) / coinDaysOf(JUDGE));
  const rows: PrescoreRow[] = [];
  const candidates: Record<string, unknown> = {};
  for (const it of P.items) {
    const r = reads.get(it.cand.id) as CandRead;
    const guards = { a4: r.a4 ? a4Guard(r.a4) : 'unreadable', a5: r.a5 ? a5Guard(r.a5) : 'unreadable', coverage: coverageGuard(it.coverage) } satisfies Record<string, GuardState>;
    rows.push({ id: it.cand.id, challenger: it.cand.challenger, identifiable: it.support.identifiable, point: r.dd ? r.dd.point : NaN, guards: Object.values(guards) });
    candidates[it.cand.id] = {
      challenger: it.cand.challenger, map: it.cand.map, what: it.cand.what, support: it.support,
      coverage: { ratio: num(it.coverage), guard: guards.coverage },
      ddelta1: slim(r.dd), a4: r.a4 ? { ...slim(r.a4), guard: guards.a4 } : null, a5: r.a5 ? { ...slim(r.a5), guard: guards.a5 } : null,
      // T3 §5's instrument, moved to the judge window: SE = h / 1.96, scaled by sqrt(coin-days here ÷ coin-days there), tested at half the point
      judge_power: r.dd && Number.isFinite(halfWidth(r.dd)) ? powerAt(halfWidth(r.dd), r.dd.point / 2, scale) : null,
    };
  }
  const selection = selectionOf(rows);
  const line = `${PRESCORE.line}=${Object.entries(selection.verdicts).map(([c, v]) => `${c}:${v}`).join(';')}`;
  const file = path.join(input.out, PRESCORE.file);
  const months = [...opened.keys()].sort();
  const text = jsonText({
    wave: PRESCORE.wave, kind: 'prescore', study: input.study ? 'injected' : 'registered', record: rec.id, seed: CHALLENGE_SEED, entry_seed: rec.entrySeed,
    source: { commit: source.commit }, pins: want, floor_clusters: F, alpha: ALPHA, counts,
    window: { outcomes: rec.outcomes, archives: rec.archives }, months_opened: months, entries: P.f.nE, challenger_calls: P.calls,
    coin_days: { prescore: coinDaysOf(PRESCORE), judge: coinDaysOf(JUDGE), scale },
    line, selection, candidates, drops: P.f.drops,
  });
  writeAtomic(file, text);
  record({ ok: true, leg: 'result', line, result_sha256: sha256(text), months_opened: months, last_month_opened: months.length ? months[months.length - 1] : null });
  log(line);
  return { verdict: 'PASS', reason: 'ok', line, file };
}

// ── the judge ────────────────────────────────────────────────────────────────────────────────────────────────

export type Decision = 'NOT_IDENTIFIABLE' | 'WINS' | 'KEEP' | 'KEEP — underpowered';
export interface Judged { identifiable: boolean; rejects: boolean; guards: readonly GuardState[]; lb: number; ub: number; prescorePoint: number }
/**
 * The decision of one judged challenger, in the registered order: identifiability first (it was settled before
 * any outcome); then WINS — Holm's step-down cleared 0 and every guard holds; else KEEP, which is
 * `KEEP — underpowered` when the interval reaches 0 and T3 §5's instrument, on the interval's half-width, cannot
 * detect half the pre-score point.
 */
export function decisionOf(j: Judged): { decision: Decision; cause: string; power: ReturnType<typeof powerAt> | null } {
  if (!j.identifiable) return { decision: 'NOT_IDENTIFIABLE', cause: 'an arm has too few effective clusters, or an attainable range below the floor', power: null };
  const bad = j.guards.find((g) => g !== 'holds');
  if (j.rejects && !bad) return { decision: 'WINS', cause: 'the interval lies wholly above 0 under Holm, and no guard fails', power: null };
  const h = (j.ub - j.lb) / 2;
  const power = Number.isFinite(h) && Number.isFinite(j.prescorePoint) ? powerAt(h, j.prescorePoint / 2) : null;
  const reaches = j.lb <= 0 && j.ub >= 0;
  const cause = j.rejects ? `a guard ${bad === 'fails' ? 'fails' : 'could not be read'}` : 'the interval does not lie wholly above 0 under Holm';
  return { decision: reaches && power !== null && power.underpowered ? 'KEEP — underpowered' : 'KEEP', cause, power };
}

interface PrescoreFile { kind?: string; study?: string; selection?: { judged?: unknown; verdicts?: Record<string, string> }; candidates?: Record<string, { ddelta1?: { point?: number | null } | null } | undefined> }
/** The pre-score result a judge carries: who it sent, and each one's in-sample point. A string is the refusal. */
function readPrescore(bytes: Buffer, marker: string): { cands: Candidate[]; points: number[]; verdicts: Record<string, string> } | string {
  let pre: PrescoreFile;
  try { pre = JSON.parse(bytes.toString('utf8')) as PrescoreFile; } catch { return 'the pre-score result is not JSON'; }
  const judged = pre?.selection?.judged;
  if (pre?.kind !== 'prescore' || !Array.isArray(judged) || !pre.candidates || !pre.selection?.verdicts) return 'the pre-score result is malformed';
  if (pre.study !== marker) return `the pre-score result is from another study (${String(pre.study)}, this run is ${marker})`;
  const cands = judged.map((id) => candidateOf(id));
  const points = judged.map((id) => pre.candidates?.[String(id)]?.ddelta1?.point);
  if (cands.some((c) => c === null) || points.some((p) => typeof p !== 'number' || !Number.isFinite(p)) || new Set(cands.map((c) => c?.challenger)).size !== cands.length) return 'the pre-score result is malformed';
  if (cands.length === 0) return 'the pre-score sent no challenger to the judge';
  return { cands: cands as Candidate[], points: points as number[], verdicts: pre.selection.verdicts };
}

export interface JudgeInput {
  repo: string;
  /** Repo-relative path of the judge's registration. Absent: the one of its name on origin/main. */
  registration?: string;
  /** The judge's own store (its manifests, its guard log). Outside the repository, and never T3's. */
  store: string;
  censusFile: string;
  archives: ArchiveStore;
  /** The pre-score result: accepted only as the file the registration pins by sha256. */
  prescore: string;
  out: string;
  /** Repo-relative path of the registration whose Tables 2a–2e the frame is checked against (T3's); the judge's registration pins it. */
  tables?: string;
  study?: ChallengeStudy;
}

/**
 * The judge: one read of the judge record's window, in T3's order — the guard, the skeleton, the identifiability
 * of every pair, the seal, and only then the outcomes. A refusal computes no outcome and is logged in the store.
 */
export function judgeRun(input: JudgeInput): RunResult {
  const log = input.study?.log ?? ((l: string): void => { process.stderr.write(`regime-challenge: ${l}\n`); });
  const stop = (verdict: 'REFUSED' | 'INDETERMINATE', reason: string): RunResult => ({ verdict, reason, line: null, file: null });
  const { store, repo } = input;
  if (within(store, repo)) return stop('REFUSED', 'the store must sit outside the repository');
  const refuse = (leg: string, verdict: 'REFUSED' | 'INDETERMINATE', reason: string): RunResult => { logGuard(store, JUDGE.wave, { mode: 'holdout', ok: false, leg, reason }); return stop(verdict, reason); };
  if (within(input.out, repo)) return refuse('out', 'REFUSED', 'the output directory must sit outside the repository');
  if (!input.study && !isChallengeSource(__filename, repo)) return refuse('source', 'REFUSED', 'the judge is read by the pinned sources of its repository (tsx src/scripts/regime-challenge/challenge-run.ts), never a compiled or copied harness');
  // The seal has one place, which the store argument does not move. Only a synthetic study names its own.
  const home = input.study ? input.study.sealHome : sealHome();
  if (!home) return refuse('seal-home', 'REFUSED', 'a synthetic study must name its own seal home');
  if (!fs.existsSync(input.prescore)) return refuse('carry', 'REFUSED', 'the pre-score result is absent');
  let registration = input.registration;
  if (!registration) {
    const found = registrationOnMain(repo, REGISTRATION_RE);
    if (!found.path) return refuse('registration', 'REFUSED', found.reason);
    registration = found.path;
  }

  const g = checkDiagGuard({ study: judgeStudyRecord(registration), carry: null, repo, registration, store, sealHome: home, censusFile: input.censusFile, archives: input.archives, mode: 'holdout' });
  if (!g.ok) return stop('REFUSED', `guard (${g.leg}): ${g.reason}`);
  log('guard: ok');
  const pins = pinsOf(g.registrationText as string);
  // the code: every file the judge runs is a row of the registration (the guard held each row to its sha256)
  const unpinned = REQUIRED_PINS.find((f) => !pins.has(f));
  if (unpinned) return refuse('pins', 'REFUSED', `the registration does not pin ${unpinned}, which the judge runs`);
  // the carry: the registration pins the one pre-score result the judge accepts
  const pinned = pins.get(PRESCORE_PIN);
  if (!pinned) return refuse('carry', 'REFUSED', `the registration does not pin ${PRESCORE_PIN}`);
  const bytes = fs.readFileSync(input.prescore);
  if (carryRefusal(bytes, { sha256: pinned, registrationCommit: g.registrationCommit as string })) {
    return refuse('carry', 'REFUSED', `the pre-score result is not the one the registration pins (sha256 ${sha256(bytes).slice(0, 12)}… read, ${pinned.slice(0, 12)}… pinned)`);
  }
  const marker = input.study ? 'injected' : 'registered';
  const pre = readPrescore(bytes, marker);
  if (typeof pre === 'string') return refuse('carry', 'REFUSED', pre);
  // the tables the frame is checked against are a file the registration pins: the guard held it to its sha256
  const tables = input.tables ?? T3_REGISTRATION;
  if (!pins.has(tables)) return refuse('skeleton', 'REFUSED', `the registration does not pin ${tables}, whose tables the frame is checked against`);
  const copy = checkChallengerParity(fs.readFileSync(path.join(repo, PARITY_FIXTURE), 'utf8'));
  if (!copy.ok) return refuse('parity', 'REFUSED', copy.reason);

  const census = parseCensus(fs.readFileSync(input.censusFile, 'utf8'));
  const rec = input.study?.rec ?? JUDGE;
  const opened: Opened = new Map();
  const load = input.study?.load ?? recordLoader(rec, input.archives, census.panel, opened);
  const F = input.study?.floorClusters ?? floorClusters();
  const P = prepare(rec, census, load, pre.cands, fs.readFileSync(path.join(repo, tables), 'utf8'), F, log);
  if (isStop(P)) return refuse(P.leg, P.stop, P.reason);
  // identifiability is on record before the seal is claimed and before any outcome is read
  logGuard(store, JUDGE.wave, { mode: 'holdout', ok: true, leg: 'identifiability', floor_clusters: F, candidates: Object.fromEntries(P.items.map((it) => [it.cand.id, it.support.identifiable])) });
  log('identifiability: judge');
  fs.mkdirSync(input.out, { recursive: true });
  fs.accessSync(input.out, fs.constants.W_OK);

  const prescoreSha = sha256(bytes);
  const seal = { registration_commit: g.registrationCommit, origin_main: g.originMain, prescore_sha256: prescoreSha, claimed_at: new Date().toISOString() };
  const claim = claimSeal(home, store, { seal: JUDGE.seal as string, wave: JUDGE.wave }, seal);
  if (!claim.ok) return stop('REFUSED', `seal: ${claim.reason}`);
  log('seal: claimed');
  const outcome_read_at = new Date().toISOString();
  logGuard(store, JUDGE.wave, { mode: 'holdout', ok: true, leg: 'outcomes', outcome_read_at });
  log('outcomes: judge');
  const counts = countsOf(input.study);
  const reads = readPairs(rec, P, load, counts, false, log);

  // Holm across the challengers judged: one that could not be read stays in the family and clears nothing
  const family = holm(P.items.map((it) => reads.get(it.cand.id)?.dd?.reps ?? []), ALPHA);
  const decisions: Record<string, Decision> = {};
  const candidates: Record<string, unknown> = {};
  P.items.forEach((it, i) => {
    const r = reads.get(it.cand.id) as CandRead;
    const guards = { a4: r.a4 ? a4Guard(r.a4) : 'unreadable', a5: r.a5 ? a5Guard(r.a5) : 'unreadable', coverage: coverageGuard(it.coverage) } satisfies Record<string, GuardState>;
    const d = decisionOf({ identifiable: it.support.identifiable, rejects: family[i].rejects, guards: Object.values(guards), lb: r.dd ? r.dd.lb : NaN, ub: r.dd ? r.dd.ub : NaN, prescorePoint: pre.points[i] });
    decisions[it.cand.challenger] = d.decision;
    candidates[it.cand.id] = {
      challenger: it.cand.challenger, map: it.cand.map, what: it.cand.what, decision: d.decision, cause: d.cause, identifiable: it.support.identifiable,
      ddelta1: slim(r.dd), holm: { rank: family[i].rank, level: family[i].level, lb: num(family[i].lb), rejects: family[i].rejects },
      a4: r.a4 ? { ...slim(r.a4), guard: guards.a4 } : null, a5: r.a5 ? { ...slim(r.a5), guard: guards.a5 } : null,
      coverage: { ratio: num(it.coverage), guard: guards.coverage }, prescore_point: pre.points[i], power: d.power,
    };
  });
  const line = `${JUDGE.line}=${Object.entries(pre.verdicts).map(([c, v]) => `${c}:${decisions[c] ?? v}`).join(';')}`;
  const file = path.join(input.out, JUDGE.file);
  const text = jsonText({
    wave: JUDGE.wave, kind: 'judge', study: marker, record: rec.id, seed: CHALLENGE_SEED, entry_seed: rec.entrySeed, floor_clusters: F, alpha: ALPHA, counts,
    registration: { path: registration, commit: g.registrationCommit, origin_main: g.originMain },
    clocks: { registration_landed_at: g.landedAt, outcome_read_at }, pins: g.pins, prescore_sha256: prescoreSha, seal,
    window: { outcomes: rec.outcomes, archives: rec.archives }, months_opened: [...opened.keys()].sort(), entries: P.f.nE,
    family: P.items.map((it) => it.cand.id), line, candidates,
  });
  writeAtomic(file, text);
  logGuard(store, JUDGE.wave, { mode: 'holdout', ok: true, leg: 'result', line, result_sha256: sha256(text) });
  log(line);
  return { verdict: 'PASS', reason: 'ok', line, file };
}

// ── the CLI ──────────────────────────────────────────────────────────────────────────────────────────────────

function finish(verdict: 'PASS' | 'REFUSED' | 'INDETERMINATE', reason = ''): void {
  process.stdout.write(verdict === 'PASS' ? `${TOKEN}=PASS\n` : `${TOKEN}=${verdict} — ${reason}\n`);
  process.exitCode = verdict === 'PASS' ? 0 : verdict === 'REFUSED' ? 1 : 3;
}

function main(): void {
  const argv = process.argv.slice(2);
  const modes = ['--prescore', '--judge', '--init-store'].filter((m) => argv.includes(m));
  const val = (name: string): string | null => { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? path.resolve(argv[i + 1]) : null; };
  const censusFile = val('--census'), cache = val('--cache'), overlay = val('--overlay'), store = val('--store'), out = val('--out'), manifest = val('--manifest'), prescore = val('--prescore-result');
  const mode = modes[0];
  const usage = 'usage: challenge-run.ts --prescore --census F --cache C --overlay O --manifest M --out DIR | --init-store --census F --cache C --overlay O --store S | --judge --census F --cache C --overlay O --store S --prescore-result FILE --out DIR';
  if (modes.length !== 1 || !censusFile || !cache || !overlay || (mode === '--prescore' ? !manifest || !out : !store) || (mode === '--judge' && (!out || !prescore))) return finish('INDETERMINATE', usage);
  if (!fs.existsSync(censusFile)) return finish('INDETERMINATE', 'the census file is absent');
  const archives: ArchiveStore = { cache, overlay };
  if (mode === '--init-store') {
    if (within(store as string, REPO)) return finish('REFUSED', 'the store must sit outside the repository');
    const made = initStore(store as string, archives, parseCensus(fs.readFileSync(censusFile, 'utf8')).panel, judgeStudyRecord(''));
    process.stdout.write(`| \`${ARCHIVES_PIN}\` | \`${made.archivesSha256}\` |\n| \`store:manifest-${VENUE}.json\` | \`${made.guardStoreSha256}\` |\narchive_files=${made.archiveFiles}\n`);
    return finish('PASS');
  }
  const r = mode === '--prescore'
    ? prescoreRun({ repo: REPO, censusFile, archives, manifest: manifest as string, out: out as string })
    : judgeRun({ repo: REPO, store: store as string, censusFile, archives, prescore: prescore as string, out: out as string });
  if (r.line) process.stdout.write(`${r.line}\n`);
  if (r.file) process.stdout.write(`result=${r.file}\n`);
  finish(r.verdict, r.reason);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`regime-challenge run: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    finish('INDETERMINATE', 'the run threw');
  }
}
