// regime-diag/run.ts — EDGE-REGIME-DIAG-W1: the run CLI (registration §1, §5, §6).
//
//   npx tsx src/scripts/regime-diag/run.ts --study ID --init-store --store S --census F --cache C --overlay O
//   npx tsx src/scripts/regime-diag/run.ts --study ID --skeleton   --census F --cache C --overlay O
//   npx tsx src/scripts/regime-diag/run.ts --study ID --fit        --store S --census F --cache C --overlay O --out DIR
//   npx tsx src/scripts/regime-diag/run.ts --study ID --holdout    --store S --census F --cache C --overlay O --out DIR --fit-result FILE
//
// EDGE-REGIME-CONFIRM-W1: a run names its study (`--study`, a `StudyRecord` of diag-spec.ts); there is no default,
// and a run that names none is refused. `diag-2026-11-16` is T3: closed, and it keeps refusing on its pins and its
// seal. `confirm` is the successor: one hold-out read (`--holdout`) on entries after T_END, not before its registered
// date, carrying T3's fit result by sha256, behind its own seal file. It has no fit read and no skeleton look:
// its one read logs the realized skeleton's sha256 and, against the floor, the clusters it achieved (guard-log legs
// `skeleton`, `floors`) before the seal is claimed. A coin-month of its outcome months without an archive is absent
// only by the probe's record (probe-absent.ts, its own CLI; this file never imports it).
//
// `--init-store` writes the two manifests a pin section records and prints their sha256. `--skeleton` rebuilds
// Tables 2a–2e from the archives and compares them with the registration: labels and cardinalities only.
// `--fit` and `--holdout` are the only modes that compute an outcome, and only behind the guard
// (`checkDiagGuard`): guard → skeleton → floors and identifiability → outcomes. The hold-out is read once, behind
// the seal, and needs the fit result. The seal has one place (`sealHome()`), which `--store` does not move.
// `S` and `DIR` sit outside the repository: no figure is written into it.
// The registered study is read only by this file as the registration pins it (tsx on the source): a compiled or
// copied harness is refused before the guard is asked.
//
// Callers gate on the token, never on the exit code alone:
//   REGIME_DIAG_RUN_VERDICT=PASS | REFUSED — <reason> | INDETERMINATE — <reason>        exit 0 | 1 | 3
// Only `main()` prints the token, and `main()` never injects a study: a test's study cannot print PASS.
import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from '../sr-backtest/store.js';
import { buildGrid, coinArchives, months, sha256, type ArchiveStore } from './archive.js';
import { a5, a5Eff, barSeq, flipFlops, lagOf, runsOf, type A5Reading } from './bars.js';
import {
  a3State, evidenceOf, fitState, fitStateA5, flagsOf, holdoutState, ladder, resultLine, secondaryFamily, selectA3,
  type Decision, type Evidence, type FitState, type HoldState, type KeyState, type Ladder, type SecondaryCell, type SecondaryState,
} from './decide.js';
import { accumulate, blocksOf, compute, context, cwOfRows, effOfCw, joint, sequences, type Ctx, type Reading, type Stat } from './engine.js';
import {
  N_TF, ROW_SETS, buildFrames, confBin, diffSkeleton, parseCensus, posName, registeredSkeleton, skeletonOf, withOutcomes,
  type Census, type Frame, type Lab, type Loaded, type Skeleton,
} from './frame.js';
import { ARCHIVES_PIN, carryRefusal, checkDiagGuard, claimSeal, initStore, logGuard, sealHome } from './guard.js';
import { PHASE_UP, keyBLead } from './keys.js';
import { OUT_NULL } from './labeler.js';
import { attainableOf, bhOf, floorClusters, prims, seedsFor } from './prims.js';
import {
  A3_FAMILY, ALPHA, BH_Q, FLOOR_PP, FLOOR_RATIO, KEY_B_DESCRIPTIVE_LEADS, L_UP, L_VOLATILE,
  REGIME_AGAINST_MIN_CONFIDENCE, SECONDARY_IDS, STAT_IDS, STUDIES, TFS, VENUE, VOLATILE_MIN_CONFIDENCE,
  seedArm, statDef, studyOf, type Carry, type Read, type Span, type StudyRecord, type Variant, type Win,
} from './diag-spec.js';
import { A3_CELLS, a3CellId, a3Stat, a4, delta1, delta1ByHold, minorityShare, pick, primaryRows, registered, s2, trendDir, type A3Cell, type Built } from './stats.js';

const REPO = path.resolve(__dirname, '../../..');
const TOKEN = 'REGIME_DIAG_RUN_VERDICT';

export interface Counts { boot: number; shuffle: number; perm: number }
/**
 * What a run reads. The registered study is the archive store over the span and windows of the study record the
 * run names. A test injects a synthetic one, and may shrink the resample counts and lower the cluster floor; its
 * results carry `study: 'injected'`, and a hold-out refuses a fit result of the other kind. A study with no fit
 * read (the successor) has no fit window.
 */
export interface Study {
  span: Span; fit?: Win; holdout: Win;
  load: (pos: number) => Loaded;
  counts?: (id: string) => Counts;
  floorClusters?: number;
  log?: (line: string) => void;
  /**
   * Where a synthetic study keeps its hold-out seal. A study injected by a test must name it; the registered
   * study has none, and its seal is at `sealHome()` whatever store the run names.
   */
  sealHome?: string;
  /** The fit result a synthetic successor carries: it names its own, never the registered one. */
  carry?: Carry;
  /** The instant a synthetic successor's clock leg reads (ms). Absent: the wall clock, as in a registered run. */
  now?: number;
}
export function registeredStudy(archives: ArchiveStore, panel: readonly string[], rec: StudyRecord): Study {
  const yms = months(rec.months.first, rec.months.last);
  const win = (name: Win['name']): Win | undefined => rec.windows.find((w) => w.name === name);
  return { span: rec.span, fit: win('fit'), holdout: win('holdout') as Win, load: (pos) => {
    const files = coinArchives(archives, panel[pos], yms);
    return { g: files.length ? buildGrid(rec.span, files) : null, noArchive: yms.length - files.length };
  } };
}
/** The clock leg: a study with a registered read date computes nothing before it. Null when the read may proceed. */
export const clockRefusal = (rec: StudyRecord, nowMs: number): string | null =>
  rec.notBefore && nowMs < Date.parse(rec.notBefore) ? `the ${rec.id} study is read once, not before ${rec.notBefore}` : null;

export interface RunInput {
  /** The study the run names: the `id` of a record of `STUDIES`. There is no default. */
  studyId: string;
  mode: 'fit' | 'holdout';
  repo: string;
  /** Repo-relative path of the registration. */
  registration: string;
  store: string;
  censusFile: string;
  archives: ArchiveStore;
  /** Where the result is written. Outside the repository. */
  out: string;
  /** The fit result a hold-out run reads its fit-window estimates and the fit-selected A3 cell from. */
  fitResult?: string;
  study?: Study;
}
export interface RunResult { verdict: 'PASS' | 'REFUSED' | 'INDETERMINATE'; reason: string; line: string | null; file: string | null }

// ── a session: one window's frame, its seeds, its floor ──────────────────────────────────────────────────────────

const PURPOSES = ['bootstrap', 'shuffle', 'perm'] as const;
const vid = (base: string, v?: Variant): string => (v ? `${base}@${v}` : base);
/** What is known of a row set before any outcome: its effective clusters, its minority share and the §4c bound. */
export interface Pre { eff: number; share: number | null; bound: number | null; identifiable: boolean; ok: boolean; cause: string }
interface PreItem { base: string; cell?: A3Cell }

class Session {
  /** FLOOR_CLUSTERS of the pinned primitive (a test's study may lower it). */
  readonly F: number;
  readonly used: Record<string, Counts> = {};
  private readonly seeds = new Map<string, number>();
  private readonly ctxs = new Map<string, Ctx>();
  private readonly pres = new Map<string, Pre>();
  private readonly a5effs = new Map<string, number>();
  constructor(readonly rec: StudyRecord, readonly study: Study, public f: Frame, readonly keep?: ReadonlySet<number>) {
    const arms = STAT_IDS.flatMap((id) => PURPOSES.map((p) => seedArm(f.win.name, id, p)));
    const seeds = seedsFor(rec.seed, arms);
    arms.forEach((a, i) => this.seeds.set(a, seeds[i]));
    this.F = study.floorClusters ?? floorClusters();
  }
  seed(id: string, purpose: (typeof PURPOSES)[number]): number { return this.seeds.get(seedArm(this.f.win.name, id, purpose)) as number; }
  ctx(variant?: Variant): Ctx {
    const k = variant ?? '';
    let c = this.ctxs.get(k);
    if (!c) { c = context(this.f, variant, this.keep); this.ctxs.set(k, c); }
    return c;
  }
  /** The registry's counts; a study's own counts can only lower them. */
  counts(id: string): Counts {
    const d = statDef(id), o = this.study.counts?.(id);
    const c = { boot: Math.min(d.boot, o?.boot ?? d.boot), shuffle: Math.min(d.shuffle, o?.shuffle ?? d.shuffle), perm: Math.min(d.perm, o?.perm ?? d.perm) };
    this.used[id] = c;
    return c;
  }
  row(id: string, stat: Stat, variant: Variant | undefined, alpha: number): Reading {
    const c = this.counts(id);
    return { ...compute(this.f, this.ctx(variant), stat, { B: c.boot, alpha, bootSeed: this.seed(id, 'bootstrap'), shuffle: c.shuffle > 0 ? { B: c.shuffle, seed: this.seed(id, 'shuffle') } : undefined }), id };
  }
  bar(id: string, lead: number, variant?: Variant): A5Reading {
    const c = this.counts(id);
    return a5(this.f, id, lead, { B: c.boot, alpha: ALPHA, bootSeed: this.seed(id, 'bootstrap'), shuffleB: c.shuffle, shuffleSeed: this.seed(id, 'shuffle'), variant, keep: this.keep });
  }
  /** Label-free, and remembered: the floors are checked on the bare frame, before the window's outcomes exist. */
  pre(items: readonly PreItem[], variant?: Variant): Pre[] {
    const key = (it: PreItem): string => `${variant ?? ''}|${it.base}|${it.cell ? a3CellId(it.cell) : ''}`;
    const miss = items.filter((it) => !this.pres.has(key(it)));
    if (miss.length) preOf(this, miss, variant).forEach((p, i) => this.pres.set(key(miss[i]), p));
    return items.map((it) => this.pres.get(key(it)) as Pre);
  }
  a5eff(lead: number, variant?: Variant): number {
    const k = `${variant ?? ''}|${lead}`;
    if (!this.a5effs.has(k)) this.a5effs.set(k, a5Eff(this.f, lead, variant, this.keep));
    return this.a5effs.get(k) as number;
  }
}

/** The row weights of a reading: zero for the rows outside it. */
function weightsOf(f: Frame, ctx: Ctx): Float64Array {
  const w = ctx.w.slice();
  for (let r = 0; r < w.length; r++) if (ctx.clOf[Math.floor(r / N_TF)] < 0) w[r] = 0;
  return w;
}
/** `attainable_bound_from_share` of each share; a share of null is 0.5 by construction. */
function boundsOfShares(shares: ReadonlyArray<number | null>): Array<{ bound: number | null; identifiable: boolean }> {
  const need = shares.flatMap((s, i) => (s === null ? [] : [i]));
  const bounds = attainableOf(need.map((i) => shares[i] as number));
  return shares.map((_, i) => {
    const k = need.indexOf(i);
    if (k < 0) return { bound: null, identifiable: true };
    return { bound: bounds[k], identifiable: bounds[k] !== null && (bounds[k] as number) >= FLOOR_PP };
  });
}
function preOf(S: Session, items: readonly PreItem[], variant?: Variant): Pre[] {
  const f = S.f, ctx = S.ctx(variant), w = weightsOf(f, ctx);
  const effs = effOfCw(items.map((it) => cwOfRows(f, ctx, primaryRows(f, it.base, it.cell))));
  const shares = items.map((it) => minorityShare(f, w, it.base, it.cell));
  const b = boundsOfShares(shares);
  return items.map((_, i) => {
    const ok = b[i].identifiable && effs[i] >= S.F;
    return { eff: effs[i], share: shares[i], bound: b[i].bound, identifiable: b[i].identifiable, ok, cause: !b[i].identifiable ? 'NOT_IDENTIFIABLE' : ok ? 'ok' : `fewer than ${S.F} effective clusters` };
  });
}

// ── the primaries ────────────────────────────────────────────────────────────────────────────────────────────

interface RowRead { pre: Pre; reading: Reading | null; evidence: Evidence }
type RowAnswer = 'A1' | 'A2' | 'A3' | 'A4';
const notRead = (pre: Pre): Evidence => ({ s: { point: NaN, lb: NaN, ub: NaN }, excess: [], shuffle: null, eff: pre.eff, identifiable: pre.identifiable, undefinedReplicates: 0 });
const slim = (r: Reading): Omit<Reading, 'reps'> => { const { reps, ...rest } = r; void reps; return rest; };

/** One primary on rows. Below the floor, or not identifiable: named, and not computed. */
function readRow(S: Session, ans: RowAnswer, base: string, alpha: number, variant?: Variant, cell?: A3Cell): RowRead {
  const pre = S.pre([{ base, cell }], variant)[0];
  if (!pre.ok) return { pre, reading: null, evidence: notRead(pre) };
  const built = registered(S.f, base, cell);
  if (!built) throw new Error(`regime-diag: ${base} has no statistic`);
  const reading = S.row(vid(base, variant), built.stat, variant, alpha);
  return { pre, reading, evidence: evidenceOf(ans, reading, true) };
}

interface CellRow { id: string; eff: number; identifiable: boolean; computed: boolean; point: number; lb: number; ub: number; k: number }
interface A3Read { cells: CellRow[]; selected: number; row: RowRead | null; decision: Decision; joint: Reading | null }
/** A3 in the fit window: the 36 cells on one resample at 0.025 / 36, the selection, then the selected cell's own reading. */
function readA3Fit(S: Session, variant?: Variant): A3Read {
  const alpha = ALPHA / A3_FAMILY, f = S.f;
  const pres = S.pre(A3_CELLS.map((cell) => ({ base: 'A3.S', cell })), variant);
  const inc = A3_CELLS.filter((_, i) => pres[i].ok);
  const jr = inc.length ? S.row(vid('A3.cells', variant), joint('A3.cells', inc.map((c) => a3Stat(f, a3CellId(c), c, 'S') as Stat)), variant, alpha) : null;
  const cells = A3_CELLS.map((c, i) => {
    const k = jr ? jr.names.indexOf(`${a3CellId(c)}:S`) : -1;
    return { id: a3CellId(c), eff: pres[i].eff, identifiable: pres[i].identifiable, computed: k >= 0, point: jr && k >= 0 ? jr.point[k] : NaN, lb: jr && k >= 0 ? jr.lb[k] : NaN, ub: jr && k >= 0 ? jr.ub[k] : NaN, k };
  });
  const gate = cells.map((c) => ({ eff: c.computed ? c.eff : 0, lb: c.lb, ub: c.ub }));
  const selected = selectA3(gate, S.F);
  const row = selected >= 0 ? readRow(S, 'A3', 'A3.S', alpha, variant, A3_CELLS[selected]) : null;
  return { cells, selected, row, decision: a3State(row ? row.evidence : null, gate, { F: FLOOR_PP, alpha, floorClusters: S.F }), joint: jr };
}
/** §4.11: A3's 36 cells as their own BH family; a cell that was not computed enters with p = 1. */
function a3Family(S: Session, a: A3Read): SecondaryState[] {
  const jr = a.joint, nOut = jr ? jr.names.length : 0, B = jr && nOut ? jr.reps.length / nOut : 0;
  const cells: SecondaryCell[] = a.cells.map((c) => {
    if (!jr || !c.computed) return { id: c.id, kind: 'general', point: [NaN], nOut: 1, reps: new Float64Array(0), eff: 0, undefinedReplicates: 0 };
    const col = new Float64Array(B);
    let bad = 0;
    for (let b = 0; b < B; b++) { col[b] = jr.reps[b * nOut + c.k]; if (!Number.isFinite(col[b])) bad++; }
    return { id: c.id, kind: 'general', point: [c.point], nOut: 1, reps: col, eff: c.eff, undefinedReplicates: bad };
  });
  return secondaryFamily(cells, FLOOR_PP, BH_Q, S.F, bhOf);
}

interface A5Read { eff: number; reading: A5Reading | null; decision: Decision }
function readA5(S: Session, id: string, lead: number, variant?: Variant): A5Read {
  const eff = S.a5eff(lead, variant);
  if (!(eff >= S.F)) return { eff, reading: null, decision: { state: 'too_little_data', cause: `fewer than ${S.F} effective clusters` } };
  const reading = S.bar(id, lead, variant);
  return { eff, reading, decision: fitStateA5(reading, { alpha: ALPHA, floorClusters: S.F }) };
}

interface FitRead { A1: RowRead; A2: RowRead; A3: A3Read; A4: RowRead; A5: A5Read; decisions: Decision[]; points: Array<number | null> }
const pointOf = (r: RowRead | null): number | null => (r && r.reading ? r.reading.point[0] : null);
/** The five primaries of the fit window under one reading (the default, or a sensitivity variant's whole rule). */
function fitRead(S: Session, variant?: Variant): FitRead {
  const o = { F: FLOOR_PP, alpha: ALPHA, floorClusters: S.F };
  const A1 = readRow(S, 'A1', 'A1.S', ALPHA, variant), A2 = readRow(S, 'A2', 'A2.S', ALPHA, variant);
  const A3 = readA3Fit(S, variant);
  const A4 = readRow(S, 'A4', 'A4.S', ALPHA, variant);
  const A5 = readA5(S, vid('A5.S', variant), 0, variant);
  return { A1, A2, A3, A4, A5, decisions: [fitState(A1.evidence, o), fitState(A2.evidence, o), A3.decision, fitState(A4.evidence, o), A5.decision],
    points: [pointOf(A1), pointOf(A2), pointOf(A3.row), pointOf(A4), A5.reading ? A5.reading.point : null] };
}
/** Everything a window's primaries need from the labels alone, under every reading — taken on the bare frame. */
function floorsFirst(S: Session, variants: ReadonlyArray<Variant | undefined>, cells: readonly A3Cell[]): void {
  for (const v of variants) {
    S.pre([{ base: 'A1.S' }, { base: 'A2.S' }, { base: 'A4.S' }, ...cells.map((cell) => ({ base: 'A3.S', cell }))], v);
    S.a5eff(0, v);
  }
}
/**
 * The effective clusters each primary achieves under one reading, on the rows its own statistic uses: A3 in the
 * fit-selected cell (null where the fit selected none), A5 on its runs. Label-free, and the values a read reports.
 */
function primaryEffs(S: Session, cell: A3Cell | undefined, v?: Variant): Record<string, number | null> {
  const [a1, a2, a4] = S.pre([{ base: 'A1.S' }, { base: 'A2.S' }, { base: 'A4.S' }], v);
  return { A1: a1.eff, A2: a2.eff, A3: cell ? S.pre([{ base: 'A3.S', cell }], v)[0].eff : null, A4: a4.eff, A5: S.a5eff(0, v) };
}

// ── the answer keys and the ladder (scored before any map row is read) ───────────────────────────────────────────

interface KeyRead { state: KeyState; cause: string; eff: number | null; reading: unknown }
interface KeysOf { ceiling: KeyRead | null; no_lag: KeyRead | null; ladder: Ladder | null }
/** The keys' readings by §6; a key whose rows have fewer effective clusters than the floor is named, and not computed. */
function readKeys(S: Session, p: FitRead): Record<'A1' | 'A2' | 'A3' | 'A4' | 'A5', KeysOf> {
  const f = S.f, ctx = S.ctx();
  const cell = p.A3.selected >= 0 ? A3_CELLS[p.A3.selected] : undefined, a3 = ALPHA / A3_FAMILY;
  const want: Array<{ ans: RowAnswer; id: string; alpha: number; cell?: A3Cell }> = [
    { ans: 'A1', id: 'A1.A', alpha: ALPHA }, { ans: 'A1', id: 'A1.B', alpha: ALPHA },
    { ans: 'A2', id: 'A2.A', alpha: ALPHA }, { ans: 'A2', id: 'A2.B', alpha: ALPHA },
    { ans: 'A4', id: 'A4.B', alpha: ALPHA },
    ...(cell ? [{ ans: 'A3' as const, id: 'A3.A', alpha: a3, cell }, { ans: 'A3' as const, id: 'A3.B', alpha: a3, cell }] : []),
  ];
  const built = want.map((k) => registered(f, k.id, k.cell));
  const effs = effOfCw(built.flatMap((b) => (b ? [accumulate(f, ctx, b.stat).cw] : [])));
  const read = new Map<string, KeyRead | null>();
  let at = 0;
  want.forEach((k, i) => {
    const b = built[i];
    if (!b) { read.set(k.id, null); return; } // key A has no ranging state
    const eff = effs[at++];
    if (!(eff >= S.F)) { read.set(k.id, { state: 'too_little_data', cause: `fewer than ${S.F} effective clusters`, eff, reading: null }); return; }
    const reading = S.row(k.id, b.stat, undefined, k.alpha);
    const d = fitState(evidenceOf(k.ans, reading), { F: FLOOR_PP, alpha: k.alpha, floorClusters: S.F });
    read.set(k.id, { state: d.state, cause: d.cause, eff, reading: slim(reading) });
  });
  const given: KeyRead = { state: 'by_construction', cause: 'holds by construction', eff: null, reading: null };
  const of = (ceiling: KeyRead | null, noLag: KeyRead, served: Decision): KeysOf =>
    ({ ceiling, no_lag: noLag, ladder: ladder({ ceiling: ceiling ? ceiling.state : null, noLag: noLag.state as FitState, served: served.state }) });
  const get = (id: string): KeyRead | null => read.get(id) ?? null;
  const b5 = readA5(S, 'A5.B', keyBLead());
  return {
    A1: of(get('A1.A'), get('A1.B') as KeyRead, p.decisions[0]),
    A2: of(get('A2.A'), get('A2.B') as KeyRead, p.decisions[1]),
    A3: cell ? of(get('A3.A'), get('A3.B') as KeyRead, p.decisions[2]) : { ceiling: null, no_lag: null, ladder: null },
    A4: of(given, get('A4.B') as KeyRead, p.decisions[3]),
    A5: of(given, { state: b5.decision.state, cause: b5.decision.cause, eff: b5.eff, reading: b5.reading }, p.decisions[4]),
  };
}

// ── the secondary family (§4.11): the 12 map rows and the two all-rows cells ────────────────────────────────────

const KIND: Record<string, SecondaryCell['kind']> = { M07: 'suppression', M08: 'sign', M09: 'sign', M12: 'timeframe' };
const answerOf = (id: string): 'A1' | 'A2' => (id === 'M09' || id === 'M11' || id === 'A2.all' ? 'A2' : 'A1');
function readSecondary(S: Session, ladders: Record<'A1' | 'A2', Ladder | null>): unknown[] {
  const f = S.f, ctx = S.ctx();
  const built = SECONDARY_IDS.map((id) => registered(f, id) as Built);
  const armEff = effOfCw(built.flatMap((b) => b.arms.map((a) => accumulate(f, ctx, a).cw)));
  let at = 0;
  const effs = built.map((b) => { let m = Infinity; for (let i = 0; i < b.arms.length; i++) m = Math.min(m, armEff[at++]); return m; });
  const allShare = minorityShare(f, weightsOf(f, ctx), 'A1.all');
  const all = boundsOfShares([allShare])[0];
  const readings: Array<Reading | null> = [];
  const cells: SecondaryCell[] = SECONDARY_IDS.map((id, i) => {
    const inert = id === 'A1.all' && !all.identifiable;
    const r = inert || !(effs[i] >= S.F) ? null : S.row(id, built[i].stat, undefined, ALPHA);
    readings.push(r);
    return { id, kind: KIND[id] ?? 'general', point: r ? r.point : [NaN, NaN], nOut: r ? r.names.length : 1, reps: r ? r.reps : new Float64Array(0), eff: inert ? 0 : effs[i], undefinedReplicates: r ? r.undefinedReplicates : 0 };
  });
  return secondaryFamily(cells, FLOOR_PP, BH_Q, S.F, bhOf).map((st, i) => {
    const r = readings[i], lad = ladders[answerOf(st.id)], inert = st.id === 'A1.all' && !all.identifiable;
    return {
      id: st.id, answer: answerOf(st.id), kind: cells[i].kind, state: st.state, cause: inert ? 'NOT_IDENTIFIABLE' : st.cause,
      p_works: st.pWorks, p_broken: st.pBroken, bh_works: st.bhWorks, bh_broken: st.bhBroken, eff: effs[i],
      names: r ? r.names : null, point: r ? r.point : null, lb: r ? r.lb : null, ub: r ? r.ub : null, rows: r ? r.rows : null,
      undefined_replicates: r ? r.undefinedReplicates : null, counts: built[i].counts,
      ...(st.id === 'A1.all' ? { share: allShare, bound: all.bound } : {}),
      read_under: lad ? lad.diagnosis : 'not read', nominates: st.id.startsWith('M') ? (lad ? lad.diagnosis !== 'NO_ROOM' : false) : null,
    };
  });
}

// ── floors of the Table 2d row sets, descriptives, the underpowered report ───────────────────────────────────────

const winName = (f: Frame): string => (f.win.name === 'holdout' ? 'hold-out' : 'fit');
/** §5: effective clusters and direction mix of every Table 2d row set, from the bare frame, under the design weights. */
function floorsOf(S: Session): Array<{ window: string; row_set: string; eff: number; [k: string]: unknown }> {
  const f = S.f, ctx = S.ctx();
  const sels = ROW_SETS.map(([, inSet]) => {
    const sel = new Uint8Array(f.has.length);
    for (let r = 0; r < sel.length; r++) if (f.has[r] && inSet(f.S.lab[r], f.S.conf[r])) sel[r] = 1;
    return sel;
  });
  const effs = effOfCw(sels.map((sel) => cwOfRows(f, ctx, sel)));
  const shares = ROW_SETS.map(([name], i) => {
    if (!name.startsWith('TRENDING')) return null;
    let up = 0, all = 0;
    for (let r = 0; r < sels[i].length; r++) if (sels[i][r]) { all += ctx.w[r]; if (f.S.lab[r] === L_UP) up += ctx.w[r]; }
    return all > 0 ? Math.min(up, all - up) / all : NaN;
  });
  const b = boundsOfShares(shares);
  return ROW_SETS.map(([name], i) => ({ window: winName(f), row_set: name, eff: effs[i], share: shares[i], bound: b[i].bound, identifiable: b[i].identifiable }));
}

function describe(S: Session, a5r: A5Reading | null): Record<string, unknown> {
  const f = S.f, ctx = S.ctx();
  const lag = TFS.map((tf, t) => {
    let turns = 0, censored = 0;
    const lags: number[] = [];
    for (const c of f.coins) { const l = lagOf(c.keyA[t], c.series[t]); turns += l.turns; censored += l.censored; for (const x of l.lags) lags.push(x); }
    lags.sort((a, b) => a - b);
    const n = lags.length;
    return { tf: tf.key, turns, censored, median: n ? (n % 2 ? lags[(n - 1) / 2] : (lags[n / 2 - 1] + lags[n / 2]) / 2) : null };
  });
  const flip_flops = TFS.map((tf, t) => {
    let bars = 0, changes = 0, flipflops = 0;
    for (const c of f.coins) { const x = flipFlops(c.series[t], f.win); bars += x.bars; changes += x.changes; flipflops += x.flipflops; }
    return { tf: tf.key, bars, changes, flipflops, per_1000: bars ? (1000 * flipflops) / bars : null };
  });
  // confidence monotonicity of the agreement between the served direction and the dated phase
  const rows = primaryRows(f, 'A4.S'), levels: number[] = [], wins: number[] = [], clusters: number[] = [];
  for (let r = 0; r < rows.length; r++) {
    const cl = ctx.clOf[Math.floor(r / N_TF)];
    if (!rows[r] || cl < 0) continue;
    levels.push(confBin(f.S.conf[r])); wins.push((f.S.lab[r] === L_UP) === (f.phase[r] === PHASE_UP) ? 1 : 0); clusters.push(cl);
  }
  const mono = S.counts('A4.mono'), monoPre = S.pre([{ base: 'A4.S' }])[0];
  const a4_mono = monoPre.ok && levels.length
    ? { state: 'reported', rows: levels.length, eff: monoPre.eff, B: mono.perm, ...(prims([{ op: 'perm', levels, wins, clusters, B: mono.perm, seed: S.seed('A4.mono', 'perm') }])[0] as object) }
    : { state: 'too little data', rows: levels.length, eff: monoPre.eff };
  // A slice below the cluster floor is named too little data and not reported (as §4d registers for A2 by timeframe).
  const slice = (eff: number): 'reported' | 'too little data' => (eff >= S.F ? 'reported' : 'too little data');
  // Δ1 by timeframe × hold, on map row 12's rows, averaged over the shapes
  const arms = (registered(f, 'M12') as Built).arms, armAcc = arms.map((arm) => accumulate(f, ctx, arm)), armEff = effOfCw(armAcc.map((a) => a.cw));
  const delta1_by_tf_hold = arms.map((arm, i) => {
    if (slice(armEff[i]) !== 'reported') return { tf: arm.id, eff: armEff[i], state: slice(armEff[i]), by_hold: null };
    return { tf: arm.id, eff: armEff[i], state: slice(armEff[i]), by_hold: delta1ByHold(armAcc[i].tot) };
  });
  // key B at the two descriptive leads: point values of Δ1, S2 and S4
  const leads: Array<[number, Lab, string]> = [[KEY_B_DESCRIPTIVE_LEADS[0], f.B7, 'B7'], [KEY_B_DESCRIPTIVE_LEADS[1], f.B28, 'B28']];
  const leadAcc = leads.map(([, lab, tag]) => [
    delta1(f, `A1.${tag}`, trendDir(f, lab, REGIME_AGAINST_MIN_CONFIDENCE), lab.lab),
    s2(f, `A2.${tag}`, pick(f, lab, L_VOLATILE, VOLATILE_MIN_CONFIDENCE), lab.lab),
    a4(f, `A4.${tag}`, trendDir(f, lab), lab.lab),
  ].map((st) => accumulate(f, ctx, st)));
  const leadEff = effOfCw(leadAcc.flat().map((a) => a.cw));
  const key_b_leads = Object.fromEntries(leads.map(([lead], i) => [lead, Object.fromEntries(['A1', 'A2', 'A4'].map((a, k) => {
    const eff = leadEff[i * 3 + k];
    return [a, { eff, state: slice(eff), point: slice(eff) === 'reported' ? leadAcc[i][k].point[0] : null }];
  }))]));
  // A2 by timeframe: a timeframe below the cluster floor is named, and not computed
  const tfRows = TFS.map((_, t) => pick(f, f.S, L_VOLATILE, VOLATILE_MIN_CONFIDENCE, 101, (r) => r % N_TF === t));
  const tfEff = effOfCw(tfRows.map((sel) => cwOfRows(f, ctx, sel)));
  const a2_by_tf = TFS.map((tf, t) => {
    const id = `A2.tf.${tf.key}`;
    if (!(tfEff[t] >= S.F)) return { tf: tf.key, eff: tfEff[t], state: 'too little data', point: null, lb: null, ub: null };
    const r = S.row(id, s2(f, id, tfRows[t], f.S.lab), undefined, ALPHA);
    return { tf: tf.key, eff: tfEff[t], state: 'reported', point: r.point[0], lb: r.lb[0], ub: r.ub[0] };
  });
  // sequences the block shuffle cannot move: fewer than 2 runs
  const rowSeqs: string[] = [];
  for (const seq of sequences(f, ctx)) if (blocksOf(seq.length, (i) => f.S.lab[seq[i]]).start.length < 2) rowSeqs.push(`${posName(f.ePos[Math.floor(seq[0] / N_TF)])}|${TFS[seq[0] % N_TF].key}`);
  const R = runsOf(f.coins.flatMap((c) => c.series.map((s, t) => barSeq(s, f.win, c.pos, t, 0))));
  const barSeqs = R.seqs.flatMap((q, i) => (R.blocks[i].start.length < 2 ? [`${posName(q.pos)}|${TFS[q.t].key}`] : []));
  let long = 0, short = 0;
  if (f.cells) for (let i = 0; i < f.cells.out.length; i++) if (f.cells.out[i] === OUT_NULL) { if (i % 2 === 0) long++; else short++; }
  return { lag, flip_flops, a4_mono, runs: a5r ? a5r.perTf : null, delta1_by_tf_hold, key_b_leads, a2_by_tf, unshufflable: { rows: rowSeqs, bars: barSeqs }, null_odds: { long, short } };
}

const addMonths = (ym: string, k: number): string => {
  const [y, m] = ym.split('-').map(Number), t = y * 12 + (m - 1) + k;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
/**
 * §5, the underpowered branch: the half-width, the multiple of coin-days that brings it to the floor, and the month
 * the panel supplies them by. Only where the half-width is above the floor. The fit window can be extended, so it
 * needs the coin-days it lacks; the hold-out cannot, so a successor needs the whole multiple on new months.
 */
function underpowered(lb: number, ub: number, eff: number, F: number, coinDays: number, extend: boolean, lastMonth: string): Record<string, unknown> | null {
  const h = (ub - lb) / 2, multiple = (h / F) ** 2;
  if (!(multiple > 1)) return null;
  const needed = (extend ? multiple - 1 : multiple) * coinDays;
  return { label: 'too little data — underpowered', half_width: h, effective_clusters: eff, multiple, coin_days_in_window: coinDays, coin_days_needed: needed,
    month: addMonths(lastMonth, Math.ceil(needed / 450)) };
}

// ── the skeleton check, and the fit result a hold-out reads ──────────────────────────────────────────────────────

export interface SkeletonCheck { verdict: 'PASS' | 'REFUSED' | 'INDETERMINATE'; reason: string; differences: string[]; frames: Frame[]; skeleton: Skeleton | null }
/**
 * Step 1 of the read: rebuild the skeleton, labels only. A study whose skeleton is `registered` compares it with
 * the registration's tables; one whose corpus did not exist at registration (`recorded`) has no table to compare
 * with, and the read records the realized skeleton before any outcome.
 */
export function skeletonCheck(registrationText: string, census: Census, study: Study, rec: StudyRecord): SkeletonCheck {
  let want: Skeleton | null = null;
  if (rec.skeleton === 'registered') {
    try {
      want = registeredSkeleton(registrationText);
    } catch (e) {
      return { verdict: 'INDETERMINATE', reason: `skeleton: ${e instanceof Error ? e.message : String(e)}`, differences: [], frames: [], skeleton: null };
    }
  }
  const wins = [study.fit, study.holdout].filter((w): w is Win => w !== undefined);
  const frames = buildFrames(study.span, wins, census, study.load, { outcomes: false, seed: rec.seed, log: study.log ? (l) => study.log?.(`frames: ${l}`) : undefined });
  if (frames.every((f) => f.nE === 0)) return { verdict: 'INDETERMINATE', reason: 'skeleton: the study holds no entry', differences: [], frames, skeleton: null };
  const skeleton = skeletonOf(frames);
  if (!want) return { verdict: 'PASS', reason: 'ok', differences: [], frames, skeleton };
  const differences = diffSkeleton(skeleton, want);
  if (differences.length) return { verdict: 'REFUSED', reason: `skeleton: ${differences.length} cells differ from the registered tables — ${differences.slice(0, 3).join('; ')}`, differences, frames, skeleton };
  return { verdict: 'PASS', reason: 'ok', differences, frames, skeleton };
}

interface FitFile {
  kind: string; study: string; registration: { commit: string }; positions: number[];
  fit_points: Record<string, number | null>;
  primaries: { A3: { selected: string | null; selected_index: number } } & Record<string, { state?: string } | undefined>;
  variants: Record<string, { points: Array<number | null> }>;
}
/** The fit result a hold-out reads. A carried one is that file by sha256, read under the commit the carry names. */
function readFitResult(file: string, marker: string, commit: string, carry: Carry | null): { fit: FitFile; sha: string } | string {
  if (!fs.existsSync(file)) return 'the fit result is absent';
  const bytes = fs.readFileSync(file);
  const not = carry ? carryRefusal(bytes, carry) : null;
  if (not) return not;
  let fit: FitFile;
  try { fit = JSON.parse(bytes.toString('utf8')) as FitFile; } catch { return 'the fit result is not JSON'; }
  const idx = fit?.primaries?.A3?.selected_index;
  if (fit?.kind !== 'fit' || !Array.isArray(fit.positions) || !fit.fit_points || !fit.variants || !Number.isInteger(idx) || idx < -1 || idx >= A3_CELLS.length) return 'the fit result is malformed';
  if (fit.study !== marker) return `the fit result is from another study (${String(fit.study)}, this run is ${marker})`;
  if (fit.registration?.commit !== commit) return 'the fit result was read under another registration commit';
  return { fit, sha: sha256(bytes) };
}

/** A path with its existing part resolved through symlinks. */
function real(p: string): string {
  let head = path.resolve(p), tail = '';
  while (!fs.existsSync(head) && path.dirname(head) !== head) { tail = path.join(path.basename(head), tail); head = path.dirname(head); }
  return path.join(fs.realpathSync(head), tail);
}
const within = (p: string, root: string): boolean => { const rel = path.relative(real(root), real(p)); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
const jsonText = (x: unknown): string => `${JSON.stringify(x, null, 1)}\n`;
/**
 * The pins bind the code that runs only when the running file IS the pinned source: this file, in the repository
 * the guard reads. A compiled copy (dist) or a harness copied elsewhere would be hashed as one thing and run as another.
 */
export const isPinnedSource = (file: string, repo: string): boolean => real(file) === real(path.join(repo, 'src/scripts/regime-diag/run.ts'));

// ── the outcome run ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * A fit-window or a hold-out read of the study the run names, in the registered order: the guard, the skeleton,
 * the floors and the identifiability of every row set, and only then the outcomes. A refusal computes no outcome
 * and is logged.
 */
export function outcomeRun(input: RunInput): RunResult {
  const log = input.study?.log ?? ((l: string): void => { process.stderr.write(`regime-diag: ${l}\n`); });
  const stop = (verdict: 'REFUSED' | 'INDETERMINATE', reason: string): RunResult => ({ verdict, reason, line: null, file: null });
  const { mode, store } = input;
  // A store inside the repository is never written to, its guard log included; every later refusal is logged.
  if (within(store, input.repo)) return stop('REFUSED', 'the store must sit outside the repository');
  const rec = studyOf(input.studyId);
  const refuse = (leg: string, verdict: 'REFUSED' | 'INDETERMINATE', reason: string): RunResult => { logGuard(store, rec ? rec.wave : null, { mode, ok: false, leg, reason }); return stop(verdict, reason); };
  // A run names its study: nothing defaults to one.
  if (!rec) return refuse('study', 'REFUSED', `a run names its study (${STUDIES.map((x) => x.id).join(' | ')}): ${input.studyId === undefined ? 'none was named' : `${String(input.studyId)} is not one`}`);
  if (within(input.out, input.repo)) return refuse('out', 'REFUSED', 'the output directory must sit outside the repository');
  const read = rec.reads[mode];
  if (!read) return refuse('study', 'REFUSED', `the ${rec.id} study has no ${mode} read: nothing is re-fit`);
  if (!input.study && rec.closed) return refuse('study', 'REFUSED', `the ${rec.id} study is closed: its hold-out is spent`);
  if (!input.study && !isPinnedSource(__filename, input.repo)) {
    return refuse('source', 'REFUSED', 'the registered study is read by the pinned sources of its repository (tsx src/scripts/regime-diag/run.ts), never a compiled or copied harness');
  }
  // The seal has one place, which the store argument does not move. Only a synthetic study names its own.
  const home = input.study ? input.study.sealHome : sealHome();
  if (!home) return refuse('seal-home', 'REFUSED', 'a synthetic study must name its own seal home');
  if (mode === 'holdout' && !input.fitResult) return refuse('fit-result', 'REFUSED', 'a hold-out run needs the fit result');
  // A study that carries a fit result accepts that one file; a synthetic one names its own, never the registered one.
  const carry = rec.carry ? (input.study ? input.study.carry ?? null : rec.carry) : null;
  if (rec.carry && !carry) return refuse('fit-result', 'REFUSED', 'a synthetic study that carries a fit result must name its own');
  const late = clockRefusal(rec, input.study?.now ?? Date.now());
  if (late) return refuse('clock', 'REFUSED', late);

  const g = checkDiagGuard({ study: rec, carry: carry ? carry.sha256 : null, repo: input.repo, registration: input.registration, store, sealHome: home, censusFile: input.censusFile, archives: input.archives, mode });
  if (!g.ok) return stop('REFUSED', `guard (${g.leg}): ${g.reason}`);
  log('guard: ok');
  const census = parseCensus(fs.readFileSync(input.censusFile, 'utf8'));
  const study = input.study ?? { ...registeredStudy(input.archives, census.panel, rec), log };
  const marker = input.study ? 'injected' : 'registered';
  let fit: FitFile | null = null, fitSha = '';
  if (mode === 'holdout') {
    const v = readFitResult(input.fitResult as string, marker, carry ? carry.registrationCommit : (g.registrationCommit as string), carry);
    if (typeof v === 'string') return refuse('fit-result', 'REFUSED', v);
    fit = v.fit; fitSha = v.sha;
  }

  const sk = skeletonCheck(g.registrationText as string, census, study, rec);
  if (sk.verdict !== 'PASS') return refuse('skeleton', sk.verdict, sk.reason);
  const recorded = rec.skeleton === 'recorded' ? sk.skeleton : null;
  if (recorded) logGuard(store, rec.wave, { mode, ok: true, leg: 'skeleton', skeleton_sha256: sha256(JSON.stringify(recorded)) });
  log(recorded ? 'skeleton: recorded' : 'skeleton: equal');
  const bare = sk.frames.find((f) => f.win.name === mode) as Frame;
  if (bare.nE === 0) return refuse('skeleton', 'INDETERMINATE', `the ${winName(bare)} window holds no entry`);

  const keep = fit ? new Set<number>(fit.positions) : undefined;
  const S = new Session(rec, study, bare, keep);
  const floors = floorsOf(S);
  const selected = fit && fit.primaries.A3.selected_index >= 0 ? A3_CELLS[fit.primaries.A3.selected_index] : undefined;
  const variants: Array<Variant | undefined> = mode === 'fit' ? [undefined, 'day', 'week', 'unit'] : [undefined, 'day', 'week', 'unit', 'panel13'];
  floorsFirst(S, variants, mode === 'fit' ? A3_CELLS : selected ? [selected] : []);
  // A study whose skeleton is recorded reads an accruing corpus: the clusters it achieved go on record against the
  // floor before the seal is claimed and before any outcome is read (PROCEDURE §4a) — every Table 2d row set, A3's
  // fit-selected cell, and each primary on the rows its own statistic uses, under the main reading and under every
  // sensitivity variant (A4's dated rows and A5's runs are no Table 2d set). All of it is computed on the bare
  // frame: no outcome of the window exists yet.
  if (recorded) {
    logGuard(store, rec.wave, {
      mode, ok: true, leg: 'floors', floor_clusters: S.F,
      row_sets: floors.map((x) => ({ row_set: x.row_set, eff: x.eff })),
      a3_selected: selected ? { cell: a3CellId(selected), eff: S.pre([{ base: 'A3.S', cell: selected }])[0].eff } : null,
      primaries: Object.fromEntries(variants.map((v) => [v ?? 'main', primaryEffs(S, selected, v)])),
    });
  }
  log(`floors: ${mode}`);
  fs.mkdirSync(input.out, { recursive: true });
  fs.accessSync(input.out, fs.constants.W_OK);

  let seal: Record<string, unknown> | null = null;
  if (mode === 'holdout') {
    seal = { registration_commit: g.registrationCommit, origin_main: g.originMain, fit_result_sha256: fitSha, claimed_at: new Date().toISOString() };
    const claim = claimSeal(home, store, rec, seal);
    if (!claim.ok) return stop('REFUSED', `seal: ${claim.reason}`);
    log('seal: claimed');
  }
  const outcome_read_at = new Date().toISOString();
  logGuard(store, rec.wave, { mode, ok: true, leg: 'outcomes', outcome_read_at });
  log(`outcomes: ${mode}`);
  S.f = withOutcomes(bare, study.load);

  const head = {
    wave: rec.wave, kind: mode, study: marker, seed: rec.seed, floor_clusters: S.F,
    registration: { path: input.registration, commit: g.registrationCommit, origin_main: g.originMain },
    clocks: { registration_landed_at: g.landedAt, outcome_read_at },
    pins: g.pins, positions: S.f.coins.filter((c) => c.e1 > c.e0).map((c) => c.pos), entries: S.f.nE, floors,
    // what only a successor's read records: its study, the realized skeleton, the archives verified at read time
    ...(recorded ? { study_id: rec.id, skeleton: recorded, archives_verified_at_read: g.later } : {}),
  };
  const body = mode === 'fit' ? fitStep(S, read.line) : holdStep(S, read.line, fit as FitFile, selected, seal as Record<string, unknown>);
  const file = path.join(input.out, read.file);
  const text = jsonText({ ...head, line: body.line, ...body.result, drops: S.f.drops, counts: S.used });
  writeAtomic(file, text);
  logGuard(store, rec.wave, { mode, ok: true, leg: 'result', line: body.line, result_sha256: sha256(text) });
  log(body.line);
  return { verdict: 'PASS', reason: 'ok', line: body.line, file };
}

function fitStep(S: Session, line: Read['line']): { line: string; result: Record<string, unknown> } {
  const coinDays = S.ctx().nCl;
  const p = fitRead(S);
  const keys = readKeys(S, p);
  const variants: Record<string, { states: string[]; causes: string[]; points: Array<number | null>; a3_selected: string | null }> = {};
  for (const v of ['day', 'week', 'unit'] as const) {
    const q = fitRead(S, v);
    variants[v] = { states: q.decisions.map((d) => d.state), causes: q.decisions.map((d) => d.cause), points: q.points, a3_selected: q.A3.selected >= 0 ? q.A3.cells[q.A3.selected].id : null };
  }
  const flags = p.decisions.map((d, i) => flagsOf(d.state, { day: variants.day.states[i], week: variants.week.states[i], unit: variants.unit.states[i] }));
  const secondary = readSecondary(S, { A1: keys.A1.ladder, A2: keys.A2.ladder });
  const family = a3Family(S, p.A3);
  const row = (r: RowRead, i: number): Record<string, unknown> => ({
    state: p.decisions[i].state, cause: p.decisions[i].cause, pre: r.pre, reading: r.reading ? slim(r.reading) : null, flags: flags[i],
    underpowered: p.decisions[i].state === 'too_little_data' && r.reading ? underpowered(r.reading.lb[0], r.reading.ub[0], r.reading.eff, FLOOR_PP, coinDays, true, S.rec.months.last) : null,
  });
  const a3row = p.A3.row, r5 = p.A5.reading;
  const primaries = {
    A1: row(p.A1, 0), A2: row(p.A2, 1),
    A3: {
      state: p.decisions[2].state, cause: p.decisions[2].cause, alpha: ALPHA / A3_FAMILY, selected: p.A3.selected >= 0 ? p.A3.cells[p.A3.selected].id : null, selected_index: p.A3.selected,
      cells: p.A3.cells.map(({ k, ...c }) => { void k; return c; }), family, pre: a3row ? a3row.pre : null, reading: a3row && a3row.reading ? slim(a3row.reading) : null, flags: flags[2],
      underpowered: p.decisions[2].state === 'too_little_data' && a3row && a3row.reading ? underpowered(a3row.reading.lb[0], a3row.reading.ub[0], a3row.reading.eff, FLOOR_PP, coinDays, true, S.rec.months.last) : null,
    },
    A4: row(p.A4, 3),
    A5: { state: p.decisions[4].state, cause: p.decisions[4].cause, pre: { eff: p.A5.eff, ok: p.A5.eff >= S.F }, reading: r5, flags: flags[4],
      underpowered: p.decisions[4].state === 'too_little_data' && r5 ? underpowered(r5.lb, r5.ub, r5.eff, FLOOR_RATIO - 1, coinDays, true, S.rec.months.last) : null },
  };
  const fit_points = Object.fromEntries(p.points.map((x, i) => [`A${i + 1}`, x]));
  return { line: resultLine(line, p.decisions.map((d) => d.state)), result: { primaries, fit_points, keys, variants, secondary, descriptives: describe(S, r5) } };
}

interface HoldRead { states: HoldState[]; rows: Array<RowRead | null>; a5: { eff: number; reading: A5Reading | null }; points: Array<number | null> }
const num = (x: number | null | undefined): number => (typeof x === 'number' ? x : NaN);
/** §6, the hold-out under one reading: each primary at the plain level; A3 is the fit-selected cell alone. */
function holdRead(S: Session, fitPoints: ReadonlyArray<number | null>, cell: A3Cell | undefined, variant?: Variant): HoldRead {
  const one = (ans: RowAnswer, base: string, i: number, c?: A3Cell): [HoldState, RowRead] => {
    const r = readRow(S, ans, base, ALPHA, variant, c);
    return [holdoutState({ identifiable: r.pre.ok, fitPoint: num(fitPoints[i]), ref: 0, alpha: ALPHA, hold: r.reading ? r.evidence : null }), r];
  };
  const a1 = one('A1', 'A1.S', 0), a2 = one('A2', 'A2.S', 1), a3 = cell ? one('A3', 'A3.S', 2, cell) : null, a4r = one('A4', 'A4.S', 3);
  const eff = S.a5eff(0, variant);
  let reading: A5Reading | null = null, s5: HoldState = 'NOT_IDENTIFIABLE';
  if (eff >= S.F) {
    reading = S.bar(vid('A5.S', variant), 0, variant);
    const hold: Evidence = { s: { point: reading.point, lb: reading.lb, ub: reading.ub }, excess: [{ name: 'reference', point: reading.point - 1, lb: reading.lb - 1, ub: reading.ub - 1 }],
      shuffle: reading.shuffle, eff: reading.eff, identifiable: true, undefinedReplicates: reading.undefinedReplicates };
    s5 = holdoutState({ identifiable: true, fitPoint: num(fitPoints[4]), ref: 1, alpha: ALPHA, hold });
  }
  const rows = [a1[1], a2[1], a3 ? a3[1] : null, a4r[1]];
  return { states: [a1[0], a2[0], a3 ? a3[0] : 'NOT_IDENTIFIABLE', a4r[0], s5], rows, a5: { eff, reading }, points: [...rows.map(pointOf), reading ? reading.point : null] };
}

function holdStep(S: Session, line: Read['line'], fit: FitFile, cell: A3Cell | undefined, seal: Record<string, unknown>): { line: string; result: Record<string, unknown> } {
  const coinDays = S.ctx().nCl;
  const base = [1, 2, 3, 4, 5].map((i) => fit.fit_points[`A${i}`] ?? null);
  /** A variant is compared with the fit estimate read under the same variant; A3 and the common panel with the fit's own. */
  const fitFor = (v?: Variant): Array<number | null> => {
    const own = v && v !== 'panel13' ? fit.variants[v]?.points : undefined;
    return own ? [own[0] ?? null, own[1] ?? null, base[2], own[3] ?? null, own[4] ?? null] : base;
  };
  const p = holdRead(S, base, cell);
  const variants: Record<string, { states: string[]; points: Array<number | null>; fit_points: Array<number | null>; eff: Array<number | null> }> = {};
  for (const v of ['day', 'week', 'unit', 'panel13'] as const) {
    const q = holdRead(S, fitFor(v), cell, v);
    // eff: the variant's effective clusters per primary, as counted before the outcomes (A1…A4 on rows, A5 on runs)
    variants[v] = { states: q.states, points: q.points, fit_points: fitFor(v), eff: [...q.rows.map((r) => (r ? r.pre.eff : null)), q.a5.eff] };
  }
  const flags = p.states.map((s, i) => flagsOf(s, { day: variants.day.states[i], week: variants.week.states[i], unit: variants.unit.states[i], panel13: variants.panel13.states[i] }));
  const shrink = (i: number): number | null => (typeof p.points[i] === 'number' && typeof base[i] === 'number' ? (p.points[i] as number) - (base[i] as number) : null);
  const row = (i: number): Record<string, unknown> => {
    const r = p.rows[i];
    return { state: p.states[i], pre: r ? r.pre : null, reading: r && r.reading ? slim(r.reading) : null, point: p.points[i], fit_point: base[i], shrinkage: shrink(i), flags: flags[i],
      underpowered: p.states[i] === 'NOT_CONFIRMED' && r && r.reading ? underpowered(r.reading.lb[0], r.reading.ub[0], r.reading.eff, FLOOR_PP, coinDays, false, S.rec.months.last) : null };
  };
  const r5 = p.a5.reading;
  const primaries = {
    A1: row(0), A2: row(1), A3: { ...row(2), cell: cell ? a3CellId(cell) : null }, A4: row(3),
    A5: { state: p.states[4], pre: { eff: p.a5.eff, ok: p.a5.eff >= S.F }, reading: r5, point: p.points[4], fit_point: base[4], shrinkage: shrink(4), flags: flags[4],
      underpowered: p.states[4] === 'NOT_CONFIRMED' && r5 ? underpowered(r5.lb, r5.ub, r5.eff, FLOOR_RATIO - 1, coinDays, false, S.rec.months.last) : null },
  };
  // a successor's result carries each primary's fit-window state, from the fit result it carries
  const carried = S.rec.carry ? { fit_states: Object.fromEntries([1, 2, 3, 4, 5].map((i) => [`A${i}`, fit.primaries[`A${i}`]?.state ?? null])) } : {};
  return { line: resultLine(line, p.states), result: { seal, ...carried, primaries, variants, common_positions: fit.positions, descriptives: describe(S, r5) } };
}

// ── the CLI ──────────────────────────────────────────────────────────────────────────────────────────────────

function finish(verdict: 'PASS' | 'REFUSED' | 'INDETERMINATE', reason = ''): void {
  process.stdout.write(verdict === 'PASS' ? `${TOKEN}=PASS\n` : `${TOKEN}=${verdict} — ${reason}\n`);
  process.exitCode = verdict === 'PASS' ? 0 : verdict === 'REFUSED' ? 1 : 3;
}

function main(): void {
  const argv = process.argv.slice(2);
  const modes = ['--init-store', '--skeleton', '--fit', '--holdout'].filter((m) => argv.includes(m));
  const raw = (name: string): string | null => { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; };
  const val = (name: string): string | null => { const v = raw(name); return v === null ? null : path.resolve(v); };
  const censusFile = val('--census'), cache = val('--cache'), overlay = val('--overlay'), store = val('--store'), out = val('--out'), fitResult = val('--fit-result');
  const mode = modes[0];
  // A run names its study: none is the default, and an unknown one is refused before anything is read.
  const rec = studyOf(raw('--study'));
  if (!rec) return finish('REFUSED', `a run names its study: --study ${STUDIES.map((x) => x.id).join(' | ')}`);
  const usage = 'usage: run.ts --study ID --init-store|--skeleton|--fit|--holdout --census F --cache C --overlay O [--store S] [--out DIR] [--fit-result FILE]';
  if (modes.length !== 1 || !censusFile || !cache || !overlay || (mode !== '--skeleton' && !store) || ((mode === '--fit' || mode === '--holdout') && !out) || (mode === '--holdout' && !fitResult)) return finish('INDETERMINATE', usage);
  if (!fs.existsSync(censusFile)) return finish('INDETERMINATE', 'the census file is absent');
  const archives: ArchiveStore = { cache, overlay };
  const log = (l: string): void => { process.stderr.write(`regime-diag: ${l}\n`); };
  if (mode === '--init-store') {
    if (within(store as string, REPO)) return finish('REFUSED', 'the store must sit outside the repository');
    const made = initStore(store as string, archives, parseCensus(fs.readFileSync(censusFile, 'utf8')).panel, rec);
    if (made.archiveFiles === 0) return finish('INDETERMINATE', 'the panel resolves to no archive');
    process.stdout.write(`| \`${ARCHIVES_PIN}\` | \`${made.archivesSha256}\` |\n| \`store:manifest-${VENUE}.json\` | \`${made.guardStoreSha256}\` |\narchive_files=${made.archiveFiles}\n`);
    return finish('PASS');
  }
  if (mode === '--skeleton') {
    // A recorded skeleton belongs to the study's one read: a look at it beforehand is an interim look.
    if (rec.skeleton !== 'registered') return finish('REFUSED', `the ${rec.id} study records its skeleton in its one read: it has no skeleton look`);
    const census = parseCensus(fs.readFileSync(censusFile, 'utf8'));
    const sk = skeletonCheck(fs.readFileSync(path.join(REPO, rec.registration), 'utf8'), census, { ...registeredStudy(archives, census.panel, rec), log }, rec);
    for (const d of sk.differences.slice(0, 40)) process.stdout.write(`${d}\n`);
    return finish(sk.verdict, sk.reason);
  }
  const r = outcomeRun({ studyId: rec.id, mode: mode === '--fit' ? 'fit' : 'holdout', repo: REPO, registration: rec.registration, store: store as string, censusFile, archives, out: out as string, fitResult: fitResult ?? undefined });
  if (r.line) process.stdout.write(`${r.line}\n`);
  if (r.file) process.stdout.write(`result=${r.file}\n`);
  finish(r.verdict, r.reason);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`regime-diag run: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    finish('INDETERMINATE', 'the run threw');
  }
}
