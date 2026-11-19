// regime-challenge/challenge-r3.ts — EDGE-REGIME-CHALLENGE-R3-W1 (T6, round 3): the alt panel's pre-score and power gate.
//
//   npx tsx src/scripts/regime-challenge/challenge-r3.ts --init-archives --panel P --archives A --out MANIFEST
//   npx tsx src/scripts/regime-challenge/challenge-r3.ts --strata   --census F --panel P --archives A --manifest M --out DIR
//   npx tsx src/scripts/regime-challenge/challenge-r3.ts --prescore --census F --panel P --archives A --manifest M --out DIR
//
// Round 3 asks whether one dial helps liquid alts. The served segment keeps the served rules whatever it finds: it never
// enter the alt frame. The panel is the vault panel file (challenge-r3-screen.ts), pinned here by sha256; it names
// coins, and the repository names none. The five dials are rounds 1 and 2's (C1–C5), each read alts-only:
//   - the pre-score reads 2024-01 … 2025-12 and no other month (both its outcome and its archive months), on the
//     panel's coins, equally weighted within each month, the timeframes in the census EXTERNAL lane's mix, with
//     UTC-day clusters (ruling Q1);
//   - per dial, round 1's selection rule picks one value; at most 3 dials go forward, the largest points first, a tie
//     to the dial listed first (spec §1);
//   - the power gate (ruling Q5), registered before any read: ρ, the cross-coin correlation of the paired
//     difference, is estimated from the 2024–25 design effect (day clusters over coin × day clusters), and the
//     day-cluster SE is moved to 2020–23's smaller per-day panel with var(day mean) = σ²(ρ + (1 − ρ)/n). A member whose
//     multiple at half its in-sample point is above 1 is `KEEP — underpowered before any read` and leaves. The
//     result's `family` holds the powered members only; R3-W2 and the registration read `family`, never `members`.
//     A gate any of whose inputs or terms is not finite cannot decide: the run is then INDETERMINATE, with no member
//     verdict and no family (review 1, F1);
//   - memory (review 1, F2): outcomes are computed for the panel's entries only, in batches of whole coins whose
//     readings are the single pass's bit for bit, and the run refuses before its outcomes when its memory plan is
//     above the budget.
// No path of this module reads an outcome of 2020-01 … 2023-12: that window is round 3's sealed judge's, in R3-W2.
// `--strata` and `--init-archives` are label-free. Every output is written outside the repository; under
// `~/.cache/algovault` only in round 3's home.
//
// Callers gate on the token: REGIME_CHALLENGE_R3_RUN_VERDICT=PASS | REFUSED — <reason> | INDETERMINATE — <reason>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeAtomic } from '../sr-backtest/store.js';
import { archiveManifestText, buildArchiveManifest, buildGrid, months, resolveArchive, sha256, type ArchiveManifest, type ArchiveStore } from '../regime-diag/archive.js';
import { ALPHA, B_BOOT, B_SHUFFLE, N_CELLS, N_CS, TFS } from '../regime-diag/diag-spec.js';
import { N_TF, dayOf, parseCensus, type Frame, type Loaded } from '../regime-diag/frame.js';
import { sealHome } from '../regime-diag/guard.js';
import { MUTATE } from '../regime-diag/mutate.js';
import { PARITY_FIXTURE, checkCoreParity } from '../regime-diag/parity.js';
import { floorClusters, seedsFor } from '../regime-diag/prims.js';
import { archivesRefusal, landedSource, linkRefusal, outRefusal, real, within, writableRefusal, type Opened } from './challenge-guard.js';
import { CANDIDATES, CENSUS_SHA256, PRESCORE, monthRefusal, monthsOpened, windowRefusal, type Candidate, type ChallengeRecord, type Dial } from './challenge-spec.js';
import { R2_ROUND } from './challenge-r2.js';
import { armParity, challengerColumns, checkChallengerParity } from './challenger-replay.js';
import { a4Guard, a5Guard, a5Ratio, armSums, coverageGuard, coverageRatio, powerAt, sameDial, supportOf, type ArmSums, type GuardState, type Pair, type PairedReading } from './paired-stats.js';
import { selectionOf, type Counts, type PrescoreRow, type RunResult } from './challenge-run.js';
import { a5By, batchedReadings, chunkedFrame, collectGarbage, entryBatches, panelFrame, r3Context, r3Pair, stintsOf, strataOf, type PanelMonths, type ReadSpec, type Stint } from './challenge-r3-frame.js';
import { R3_HOME, nbaseOf, type MonthState, type R3Rule } from './challenge-r3-screen.js';

export const R3_WAVE = 'EDGE-REGIME-CHALLENGE-R3-W1';
export const R3_SEED = 'regime-challenge-r3';
export { R3_HOME };
export const R3_LOG = 'regime-challenge-r3-prescore.log';
export const STRATA_FILE = 'regime-challenge-r3-strata.json';
/** The pre-score's months, outcomes and archives alike; and round 3's sealed judge window, which no path here reads. */
export const R3_WINDOW: Readonly<{ first: string; last: string }> = Object.freeze({ first: '2024-01', last: '2025-12' });
export const R3_JUDGE_OUTCOMES: Readonly<{ first: string; last: string }> = Object.freeze({ first: '2020-01', last: '2023-12' });
/** A panel month's archives and its history and path margin (ruling Q3): m − 4 … m + 1, clipped to the window. */
export const R3_MARGIN = Object.freeze({ before: 4, after: 1 });
export const MAX_MEMBERS = 3;
/** The five dials, rounds 1 and 2's candidates, in their listed order (a tie goes to the first listed). */
export const R3_CANDIDATES: readonly Candidate[] = Object.freeze([...CANDIDATES, ...R2_ROUND.candidates]);
/** The pre-score: round 1's grid, window and months (T3's fit window), under round 3's names. No seal. */
export const R3_PRESCORE: ChallengeRecord = Object.freeze({ ...PRESCORE, id: 'challenge-r3-prescore', wave: R3_WAVE, file: 'regime-challenge-r3-prescore.json', line: 'REGIME_CHALLENGE_R3_PRESCORE' });

/** The vault panel file (coin names; never in the repository) and round 3's 2024–25 archive manifest, by sha256. */
export const R3_PANEL_SHA256 = '0e0c214ffe19ef7887f36f7378a5c4405f97cf4eb2b825d53053ba430246ecbc';
export const R3_ARCHIVES_SHA256 = '7cb2ee142e1a1cd89f93ca81662c4bb2df531684410821c75324f1ebe77527ef';

const cacheRoot = (): string => path.join(os.userInfo().homedir, '.cache', 'algovault');
/** Round 3's 2024–25 archive store, the one archive store its pre-score reads. */
export const r3ArchiveRoot = (): string => path.join(cacheRoot(), R3_HOME, 'archives', '1m-2024-25');

// ── the refusals ────────────────────────────────────────────────────────────────────────────────────────────────

/** Why a record is not one round 3's pre-score may read, or null: every outcome and archive month in 2024-01 … 2025-12. */
export function r3WindowRefusal(rec: ChallengeRecord): string | null {
  for (const [what, s] of [['outcome', rec.outcomes], ['archive', rec.archives]] as const) {
    if (s.first < R3_WINDOW.first || s.last > R3_WINDOW.last) {
      return `round 3's pre-score reads ${what} months of ${R3_WINDOW.first} … ${R3_WINDOW.last} only: the record's ${s.first} … ${s.last} reaches outside (2020-01 … 2023-12 is round 3's sealed judge's)`;
    }
  }
  return null;
}

/** Why `archives` is not round 3's 2024–25 store, or null: an allow-list, by identity, of the one store it reads. */
export function r3ArchivesRefusal(archives: ArchiveStore): string | null {
  const root = r3ArchiveRoot();
  for (const [what, p] of [['cache', archives.cache], ['overlay', archives.overlay]] as const) {
    if (!within(p, root)) return `the archive ${what} is not round 3's 2024–25 store (~/.cache/algovault/${R3_HOME}/archives/1m-2024-25): round 3 reads no other`;
  }
  return null;
}

// ── the panel ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PanelFile { kind?: string; rule?: R3Rule; archive_months?: Record<string, string[]>; table?: Record<string, Record<string, MonthState>> }
export interface R3Panel {
  /** The symbols with a panel month in the record's outcome months, sorted; and each one's archive name (no `USDT`). */
  symbols: string[]; names: string[];
  months: PanelMonths;
  /** Per coin (by name), the archive months the record may open for it: its panel months' margins, clipped. */
  allowed: Map<string, Set<string>>;
  /** Panel size per month of the pre-score window and of the judge window (label-free, from the table). */
  sizes: { prescore: Record<string, number>; judge: Record<string, number> };
}
const addMonths = (ym: string, k: number): string => { const i = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1 + k; return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`; };

/** The panel of a record, from the panel file; a string is the refusal. The served segment's coins never enter it. */
export function panelOf(file: PanelFile, rec: ChallengeRecord): R3Panel | string {
  if (file.kind !== 'regime-challenge-r3-panel' || !file.rule || !file.table || !file.archive_months) return 'the panel file is malformed';
  const served = file.rule.served;
  const outcomeMonths = months(rec.outcomes.first, rec.outcomes.last);
  for (const [sym, row] of Object.entries(file.table)) {
    if (Object.values(row).includes('panel') && served.includes(nbaseOf(sym))) return 'the panel holds a coin of the served segment: the served segment keeps the served rules and never enters the alt frame';
  }
  const symbols = Object.keys(file.table).filter((s) => outcomeMonths.some((m) => file.table?.[s][m] === 'panel')).sort();
  const names = symbols.map((s) => (s.endsWith('USDT') ? s.slice(0, -4) : s));
  const pm: Record<string, { pos: Set<number>; n: number }> = {};
  for (const m of outcomeMonths) {
    const pos = new Set(symbols.flatMap((s, i) => (file.table?.[s][m] === 'panel' ? [i] : [])));
    pm[m] = { pos, n: pos.size };
  }
  const allowed = new Map<string, Set<string>>();
  symbols.forEach((s, i) => {
    const arch = new Set(file.archive_months?.[s] ?? []), mine = new Set<string>();
    for (const m of outcomeMonths) {
      if (file.table?.[s][m] !== 'panel') continue;
      for (let k = -R3_MARGIN.before; k <= R3_MARGIN.after; k++) { const x = addMonths(m, k); if (x >= rec.archives.first && x <= rec.archives.last && arch.has(x)) mine.add(x); }
    }
    allowed.set(names[i], mine);
  });
  const count = (first: string, last: string): Record<string, number> =>
    Object.fromEntries(months(first, last).map((m) => [m, Object.values(file.table ?? {}).filter((row) => row[m] === 'panel').length]));
  return { symbols, names, months: pm, allowed, sizes: { prescore: count(rec.outcomes.first, rec.outcomes.last), judge: count(R3_JUDGE_OUTCOMES.first, R3_JUDGE_OUTCOMES.last) } };
}

/**
 * Round 3's loader: one coin's grid from the archives of the record's months, of the months the panel table allows
 * it only. A month the record may not open throws before its file is resolved; a file on disk at a month the table
 * does not allow throws too (the store holds the table's fetch and nothing else).
 */
export function r3Loader(rec: ChallengeRecord, archives: ArchiveStore, panel: R3Panel, opened: Opened): (pos: number) => Loaded {
  return (pos) => {
    const coin = panel.names[pos], allowed = panel.allowed.get(coin) ?? new Set<string>(), files: string[] = [];
    let missing = 0;
    for (const ym of monthsOpened(rec)) {
      const why = monthRefusal(rec, ym, 'archive');
      if (why) throw new Error(`regime-challenge r3: ${why}`);
      const r = resolveArchive(archives, coin, '1m', ym);
      if (r && !allowed.has(ym)) throw new Error(`regime-challenge r3: an archive of position ${pos + 1} at ${ym} lies outside the months the panel table allows it`);
      if (!r) { if (allowed.has(ym)) missing++; continue; }
      files.push(r.file);
      opened.set(ym, (opened.get(ym) ?? 0) + 1);
    }
    return { g: files.length ? buildGrid(rec.span, files) : null, noArchive: missing };
  };
}

// ── selection, members and the power gate ───────────────────────────────────────────────────────────────────────────

export interface Members { judged: string[]; members: string[]; verdicts: Record<string, string>; causes: Record<string, string> }
/**
 * Round 1's per-dial selection, then at most MAX_MEMBERS dials: the largest in-sample points, a tie to the dial listed
 * first. A dial selected and not among them is `KEEP (pre-score)`.
 */
export function membersOf(rows: readonly PrescoreRow[]): Members {
  const sel = selectionOf(rows);
  const order = (id: string): number => R3_CANDIDATES.findIndex((c) => c.id === id);
  const point = (id: string): number => (rows.find((r) => r.id === id) as PrescoreRow).point;
  const ranked = [...sel.judged].sort((a, b) => point(b) - point(a) || order(a) - order(b));
  const members = ranked.slice(0, MAX_MEMBERS);
  const verdicts: Record<string, string> = { ...sel.verdicts }, causes: Record<string, string> = { ...sel.causes };
  for (const id of ranked.slice(MAX_MEMBERS)) {
    const ch = (rows.find((r) => r.id === id) as PrescoreRow).challenger;
    verdicts[ch] = 'KEEP (pre-score)';
    causes[ch] = `${id}: its point is not among the ${MAX_MEMBERS} largest of the dials selected`;
  }
  return { judged: sel.judged, members, verdicts, causes };
}

/** Days and the mean of 1/n over the days of the months with a panel (each day of month m counts once, at its n). */
export function dayPanel(sizes: Readonly<Record<string, number>>): { days: number; meanInvN: number } {
  let days = 0, inv = 0;
  for (const [m, n] of Object.entries(sizes)) {
    // a month's n is a whole count; anything else leaves the panel's days unmeasured (review 1, F1)
    if (!Number.isInteger(n) || n < 0) return { days: NaN, meanInvN: NaN };
    if (n === 0) continue;
    const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
    days += d; inv += d / n;
  }
  return { days, meanInvN: days ? inv / days : NaN };
}

export interface GateInputs { point: number; hDay: number; hCoinDay: number; pre: { days: number; meanInvN: number }; judge: { days: number; meanInvN: number } }
export interface Gate {
  inputs: GateInputs;
  /** SE(day)² ÷ SE(coin × day)², the design effect the 2024–25 frame shows. */
  deff: number;
  /** ρ × coverage (GATE_NOTE): each day's n is its month's panel size, not the coins with an entry that day. */
  rho_x_coverage_raw: number; rho_x_coverage: number;
  /** var(day mean) ÷ σ² on each side: ρ + (1 − ρ) · mean(1/n). */
  v: { pre: number; judge: number };
  scale: number;
  power: ReturnType<typeof powerAt>;
  /** Why the gate cannot decide — the first input or term that is not finite — or null (review 1, F1). */
  unmeasured: string | null;
  /** Null when unmeasured: an unmeasured gate neither passes nor fails. */
  passes: boolean | null;
}
export const GATE_NOTE = 'rho_x_coverage is ρ × coverage: each day\'s n is its month\'s panel size, while the coins with an entry on a day may be fewer, so the design effect reads the cross-coin correlation scaled by the day\'s coverage';
/**
 * The power gate (ruling Q5). With equal weights within a day, var(day mean) = σ²(ρ + (1 − ρ)/n). The coin × day
 * bootstrap treats the coins of a day as independent and reads σ² · mean(1/n) / D; the day bootstrap reads
 * σ² (ρ + (1 − ρ) · mean(1/n)) / D. Their ratio gives ρ = (deff − 1) · m / (1 − m), clamped to [0, 1]. The day-cluster SE
 * moves to 2020–23 by sqrt((v_J / D_J) ÷ (v_P / D_P)), and round 1's §5 instrument tests half the in-sample point.
 * Any input or term that is not finite leaves the gate unmeasured: it neither passes nor fails (review 1, F1).
 */
export function gateOf(i: GateInputs): Gate {
  const deff = (i.hDay / i.hCoinDay) ** 2, m = i.pre.meanInvN;
  const rhoRaw = (deff - 1) * m / (1 - m);
  const rho = Math.min(1, Math.max(0, rhoRaw));
  const v = { pre: rho + (1 - rho) * i.pre.meanInvN, judge: rho + (1 - rho) * i.judge.meanInvN };
  const scale = Math.sqrt((v.judge / i.judge.days) / (v.pre / i.pre.days));
  const power = powerAt(i.hDay, i.point / 2, scale);
  const terms: Array<[string, number]> = [
    ['point', i.point], ['hDay', i.hDay], ['hCoinDay', i.hCoinDay], ['pre.days', i.pre.days], ['pre.meanInvN', i.pre.meanInvN], ['judge.days', i.judge.days], ['judge.meanInvN', i.judge.meanInvN],
    ['deff', deff], ['rho_x_coverage_raw', rhoRaw], ['rho_x_coverage', rho], ['v.pre', v.pre], ['v.judge', v.judge], ['scale', scale], ['power.se', power.se], ['power.multiple', power.multiple],
  ];
  const bad = terms.find(([, x]) => !Number.isFinite(x));
  const unmeasured = bad ? `${bad[0]} is ${bad[1]}` : null;
  return { inputs: i, deff, rho_x_coverage_raw: rhoRaw, rho_x_coverage: rho, v, scale, power, unmeasured, passes: unmeasured === null ? power.multiple <= 1 : null };
}

/** The members' fate after the gate: the family (powered members, in listed order) with the verdicts — or a refusal. */
export type Decision = { family: string[]; verdicts: Record<string, string>; causes: Record<string, string> } | { refusal: string };
/**
 * Review 1, F1 and F3. A member whose gate is unmeasured (or was not read) leaves the family undecided, so nothing is
 * decided: the run is INDETERMINATE. Otherwise a member that fails the gate is `KEEP — underpowered before any read`
 * and leaves; `family` holds the powered members, in listed order — what R3-W2 and the registration read.
 */
export function decide(m: Members, gates: Readonly<Record<string, Gate>>): Decision {
  for (const id of m.members) {
    const g = gates[id];
    if (!g) return { refusal: `the power gate of ${id} was not read` };
    if (g.unmeasured !== null || g.passes === null) return { refusal: `the power gate of ${id} cannot be measured: ${g.unmeasured}: one unmeasured member leaves the family undecided, so no member is judged` };
  }
  const verdicts = { ...m.verdicts }, causes = { ...m.causes };
  for (const id of m.members) {
    const g = gates[id], ch = (R3_CANDIDATES.find((c) => c.id === id) as Candidate).challenger;
    if (g.passes) causes[ch] = `${id} is powered: multiple ${g.power.multiple}`;
    else { verdicts[ch] = 'KEEP — underpowered before any read'; causes[ch] = `${id}: the power multiple at half its in-sample point is ${g.power.multiple}, above 1`; }
  }
  return { family: R3_CANDIDATES.map((c) => c.id).filter((id) => m.members.includes(id) && gates[id].passes === true), verdicts, causes };
}

// ── memory (review 1, F2) ───────────────────────────────────────────────────────────────────────────────────────

/** Half this host's memory: the pre-score refuses to start above it. */
export const MEMORY_BUDGET = 9 * 2 ** 30;
/** The runtime itself, one coin's grid and bars, the bridge's buffers: allowed for beside the planned arrays. */
export const MEMORY_OVERHEAD = 2 ** 30;
/** The most entries whose outcomes one batch computes (a coin is never split). */
export const MAX_BATCH_ENTRIES = 25_000;
/** Accumulator columns of the widest paired statistic (ΔΔ1: two arms of N_CELLS cells × 5 sums), and its cw. */
export const ACC_COLS = 2 * N_CELLS * 5 + 1;
/**
 * One arm's A5 bytes per bar of its stints: the bar sequence (close index, label, close, σ: 4 + 1 + 8 + 8), its
 * blocks (start, length: 8), the close list it is built from (8), and at most one run per bar (the run object, its
 * slot and its shuffle reference's sum, count and mean: 160).
 */
export const SEQ_BAR_BYTES = 4 + 1 + 8 + 8 + 8 + 8 + 160;
/** The closed bars of every timeframe inside the stints: what one arm's A5 sequences can hold at most. */
export const stintBars = (stints: readonly Stint[]): number => stints.reduce((a, s) => a + TFS.reduce((b, t) => b + Math.floor((s.hi - s.lo) / t.min) + 1, 0), 0);
/** The closes of every timeframe in the window, for every coin: what pairOf's sequences hold before r3Pair cuts them. */
export const windowBars = (f: Frame): number => f.coins.length * TFS.reduce((b, t) => b + Math.floor((f.win.hi - f.win.lo) / t.min) + 1, 0);
/** A window sequence's bytes per bar: close index, label, close, σ, and the close list it is built from. */
const WINDOW_BAR_BYTES = 4 + 1 + 8 + 8 + 8;
/** The row-share columns of a pair once its coverage is read: the outcome passes never read them. */
const NO_ROWS = new Uint8Array(0);

const viewBytes = (x: unknown): number => (ArrayBuffer.isView(x) ? x.byteLength : 0);
/** The bytes of a bare frame's arrays: per-entry rows and labels, and every coin's bar series and key A. */
export function frameBytes(f: Frame): { entries: number; series: number } {
  let entries = 0;
  for (const v of Object.values(f)) entries += viewBytes(v);
  for (const k of ['S', 'B', 'B7', 'B28'] as const) entries += viewBytes(f[k].lab) + viewBytes(f[k].conf);
  let series = 0;
  for (const c of f.coins) for (const part of [...c.series, ...c.keyA]) for (const v of Object.values(part as object)) series += viewBytes(v);
  return { entries, series };
}

export interface MemoryPlan { bytes: number; batchEntries: number; batches: number; parts: Record<string, number>; phases: Record<'build' | 'pairs' | 'outcomes', number> }
/**
 * What the pre-score holds at its widest, from the frame it is about to read (the panel's entries). The parts: the
 * full frame it was cut from, the panel frame, the two contexts, every candidate's pair, the challenger columns, one
 * candidate's A5 sequences (both arms) and the window's sequences pairOf builds before they are cut to the stints,
 * the largest batch's frame and outcome table (90 cell-sides × 33 B an entry), the wider of the two passes'
 * accumulators, and the runtime's overhead. The plan is its widest PHASE, each the parts alive together: the build
 * (the chunks beside their merge, then the merge beside the panel frame: at most twice the full frame), the pairs
 * (one candidate's sequences at a time) and the outcome passes. Every term is counted from the arrays' layouts (a run object's from its ten fields),
 * never assumed from a run of the pre-score.
 */
export function memoryPlan(f: Frame, x: { candidates: number; armCandidates: number; dials: number; maxBatch: number; members: number; fullFrameBytes: number; stintBars: number }): MemoryPlan {
  const rows = f.nE * N_TF, fb = frameBytes(f), perEntry = f.nE ? fb.entries / f.nE : 0;
  const batches = entryBatches(f, x.maxBatch), batchEntries = Math.max(0, ...batches.map((b) => b.e1 - b.e0));
  const days = new Set<number>(), coinDays = new Set<number>();
  for (let e = 0; e < f.nE; e++) { const d = dayOf(f.eM[e]); days.add(d); coinDays.add(f.ePos[e] * 100_000 + d); }
  const parts: Record<string, number> = {
    full_frame: x.fullFrameBytes,
    frame: fb.entries + fb.series,
    contexts: 2 * (f.nE * 4 + rows * 8),
    pairs: x.candidates * rows * 6 + x.armCandidates * rows * 2,
    columns: x.dials * (rows * 2 + fb.series),
    seqs: 2 * x.stintBars * SEQ_BAR_BYTES,
    window_seqs: 2 * windowBars(f) * WINDOW_BAR_BYTES,
    batch_frame: Math.ceil(batchEntries * perEntry),
    cells: batchEntries * N_CS * 33,
    accumulators: Math.max(2 * x.candidates * days.size, x.members * coinDays.size) * ACC_COLS * 8,
    overhead: MEMORY_OVERHEAD,
  };
  const held = parts.frame + parts.contexts + parts.pairs + parts.columns + parts.overhead;
  const phases = { build: 2 * parts.full_frame + parts.overhead, pairs: held + parts.seqs + parts.window_seqs, outcomes: held + parts.batch_frame + parts.cells + parts.accumulators };
  return { bytes: Math.max(...Object.values(phases)), batchEntries, batches: batches.length, parts, phases };
}
/** Why the pre-score may not start under `budget`, or null; the refusal names both numbers. */
export const memoryRefusal = (plan: MemoryPlan, budget: number): string | null =>
  (plan.bytes > budget ? `the pre-score's memory estimate is ${plan.bytes} B, above the budget of ${budget} B: it would not finish on this host, so it does not start` : null);

// ── the pre-score ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface R3Study {
  rec: ChallengeRecord;
  counts?: Counts;
  floorClusters?: number;
  log?: (line: string) => void;
  /** The sha256 a synthetic pre-score holds its census, archive manifest and panel file to. */
  pins: { census: string; archives: string; panel: string };
  /** A synthetic pre-score's memory budget and batch size (the registered run: MEMORY_BUDGET, MAX_BATCH_ENTRIES). */
  memoryBudget?: number; maxBatchEntries?: number;
  /** A synthetic pre-score's gate inputs, as a test plants them (the registered run has no study, so no seam). */
  gateInputs?: (id: string, inputs: GateInputs) => GateInputs;
}
export interface R3Input { repo: string; censusFile: string; panelFile: string; archives: ArchiveStore; manifest: string; out: string; study?: R3Study }

const jsonText = (x: unknown): string => `${JSON.stringify(x, null, 1)}\n`;
const num = (x: number): number | null => (Number.isFinite(x) ? x : null);
const slim = (r: PairedReading | null): Record<string, unknown> | null => (r ? {
  point: num(r.point), lb: num(r.lb), ub: num(r.ub), alpha: r.alpha, rows: r.rows, clusters: r.clusters, eff: r.eff, B: r.B, undefined_replicates: r.undefinedReplicates,
  ...(r.arms ? { arms: { challenger: num(r.arms.challenger), served: num(r.arms.served) } } : {}),
} : null);
const half = (r: PairedReading): number => (r.ub - r.lb) / 2;
export const isR3Source = (file: string, repo: string): boolean => real(file) === real(path.join(repo, 'src/scripts/regime-challenge/challenge-r3.ts'));

interface Built { rec: ChallengeRecord; panel: R3Panel; f: Frame; load: (pos: number) => Loaded; opened: Opened; manifestSha: string; wTf: number[] }
type Stop = { verdict: 'REFUSED' | 'INDETERMINATE'; reason: string; leg: string };

/** The checks every label-free and in-sample run makes before its frame, then the frame. No outcome is read here. */
function build(input: R3Input, rec: ChallengeRecord, pins: { census: string; archives: string; panel: string }, log: (l: string) => void): Built | Stop {
  const no = (verdict: Stop['verdict'], leg: string, reason: string): Stop => ({ verdict, leg, reason });
  for (const [what, file, pin] of [['census', input.censusFile, pins.census], ['archive manifest', input.manifest, pins.archives], ['panel file', input.panelFile, pins.panel]] as const) {
    if (!fs.existsSync(file)) return no('INDETERMINATE', what, `the ${what} is absent`);
    if (sha256(fs.readFileSync(file)) !== pin) return no('REFUSED', what, `the ${what} is not the registered one`);
  }
  const wTf = parseCensus(fs.readFileSync(input.censusFile, 'utf8')).wTf;
  const panel = panelOf(JSON.parse(fs.readFileSync(input.panelFile, 'utf8')) as PanelFile, rec);
  if (typeof panel === 'string') return no('REFUSED', 'panel', panel);
  if (!panel.symbols.length) return no('INDETERMINATE', 'panel', 'the panel holds no coin in the record\'s months');
  const manifestBytes = fs.readFileSync(input.manifest);
  const stale = archivesRefusal(rec, input.archives, panel.names, JSON.parse(manifestBytes.toString('utf8')) as ArchiveManifest);
  if (stale) return no('REFUSED', 'archives', stale);
  const opened: Opened = new Map();
  const load = r3Loader(rec, input.archives, panel, opened);
  const f = chunkedFrame(rec.span, rec.win, panel.names, wTf, load, { outcomes: false, seed: rec.entrySeed, log: (l) => log(`frames: ${l}`) });
  if (f.nE === 0) return no('INDETERMINATE', 'frame', `the ${rec.id} window holds no entry`);
  const win = windowRefusal(rec, f);
  if (win) return no('REFUSED', 'window', win);
  return { rec, panel, f, load, opened, manifestSha: sha256(manifestBytes), wTf };
}

/** The label-free strata tables of the pre-score's frame (counts only). */
export function r3StrataRun(input: R3Input): RunResult & { strata?: string } {
  const log = input.study?.log ?? ((l: string): void => { process.stderr.write(`regime-challenge r3: ${l}\n`); });
  const stop = (verdict: 'REFUSED' | 'INDETERMINATE', reason: string): RunResult => ({ verdict, reason, line: null, file: null });
  const rec = input.study?.rec ?? R3_PRESCORE;
  const pre = gateway(input, rec);
  if (pre) return stop('REFUSED', pre);
  const names = [STRATA_FILE, `${STRATA_FILE}.tmp`];
  const linked = linkRefusal(input.out, 'the output directory', names) ?? writableRefusal(input.out, 'the output directory', names);
  if (linked) return stop('REFUSED', linked);
  const b = build(input, rec, input.study?.pins ?? { census: CENSUS_SHA256, archives: R3_ARCHIVES_SHA256, panel: R3_PANEL_SHA256 }, log);
  if ('verdict' in b) return stop(b.verdict, b.reason);
  fs.mkdirSync(input.out, { recursive: true });
  const text = jsonText({ wave: R3_WAVE, kind: 'strata', record: rec.id, window: { outcomes: rec.outcomes, archives: rec.archives }, entries: b.f.nE, months_opened: [...b.opened.keys()].sort(), panel_sizes: b.panel.sizes.prescore, strata: strataOf(b.f, b.panel.months), drops: b.f.drops });
  const file = path.join(input.out, STRATA_FILE);
  writeAtomic(file, text);
  return { verdict: 'PASS', reason: 'ok', line: `strata_sha256=${sha256(text)}`, file };
}

/** The refusals before any directory or line: the output, the window and the archive store. Null: accepted. */
function gateway(input: R3Input, rec: ChallengeRecord): string | null {
  if (within(input.out, input.repo)) return 'the output directory must sit outside the repository';
  const foreignOut = outRefusal(input.out, R3_HOME, sealHome(), input.archives);
  if (foreignOut) return foreignOut;
  const reaches = r3WindowRefusal(rec);
  if (reaches) return reaches;
  return r3ArchivesRefusal(input.archives);
}

/** The in-sample read of round 3: every candidate on the alt panel of 2024-01 … 2025-12, the selection, the members and the gate. */
export function r3PrescoreRun(input: R3Input): RunResult {
  const log = input.study?.log ?? ((l: string): void => { process.stderr.write(`regime-challenge r3: ${l}\n`); });
  const stop = (verdict: 'REFUSED' | 'INDETERMINATE', reason: string): RunResult => ({ verdict, reason, line: null, file: null });
  const rec = input.study?.rec ?? R3_PRESCORE;
  const pre = gateway(input, rec);
  if (pre) return stop('REFUSED', pre);
  const names = [R3_LOG, rec.file, `${rec.file}.tmp`];
  const linked = linkRefusal(input.out, 'the output directory', names) ?? writableRefusal(input.out, 'the output directory', names);
  if (linked) return stop('REFUSED', linked);
  fs.mkdirSync(input.out, { recursive: true });
  const record = (entry: Record<string, unknown>): void => { fs.appendFileSync(path.join(input.out, R3_LOG), `${JSON.stringify({ at: new Date().toISOString(), wave: R3_WAVE, record: rec.id, ...entry })}\n`); };
  const refuse = (leg: string, verdict: 'REFUSED' | 'INDETERMINATE', reason: string): RunResult => { record({ ok: false, leg, reason }); return stop(verdict, reason); };
  if (MUTATE !== '') return refuse('mutation', 'REFUSED', `REGIME_DIAG_MUTATE is set (${MUTATE}): a deliberately broken harness computes no outcome`);
  if (!input.study && !isR3Source(__filename, input.repo)) return refuse('source', 'REFUSED', 'the pre-score is read by the landed sources of its repository (tsx src/scripts/regime-challenge/challenge-r3.ts), never a compiled or copied harness');
  const source = landedSource(input.repo);
  if (!source.ok) return refuse('source', 'REFUSED', source.reason);
  const pins = input.study?.pins ?? { census: CENSUS_SHA256, archives: R3_ARCHIVES_SHA256, panel: R3_PANEL_SHA256 };
  const fixture = fs.readFileSync(path.join(input.repo, PARITY_FIXTURE), 'utf8');
  for (const p of [checkCoreParity(fixture), checkChallengerParity(fixture)]) if (!p.ok) return refuse('parity', 'REFUSED', p.reason);
  const b = build(input, rec, pins, log);
  if ('verdict' in b) return refuse(b.leg, b.verdict, b.reason);
  const { panel, load } = b;
  const cands = R3_CANDIDATES;
  const dials: Dial[] = [];
  for (const c of cands) if (c.dial && !dials.some((d) => sameDial(d, c.dial as Dial))) dials.push(c.dial);
  // review 1, F2: the panel's entries only, and the full frame let go; then the memory plan, before any outcome
  const entriesFrame = b.f.nE, fullBytes = frameBytes(b.f);
  const f = panelFrame(b.f, panel.months);
  b.f = f;
  const collected = collectGarbage();
  const maxBatch = input.study?.maxBatchEntries ?? MAX_BATCH_ENTRIES, budget = input.study?.memoryBudget ?? MEMORY_BUDGET;
  const stints = stintsOf(f, panel.months);
  const plan = memoryPlan(f, { candidates: cands.length, armCandidates: cands.filter((c) => c.arm).length, dials: dials.length, maxBatch, members: MAX_MEMBERS, fullFrameBytes: fullBytes.entries + fullBytes.series, stintBars: stintBars(stints) });
  const tooBig = memoryRefusal(plan, budget);
  if (tooBig) return refuse('memory', 'INDETERMINATE', tooBig);
  if (cands.some((c) => c.arm)) {
    const ap = armParity(f);
    if (!ap.ok) return refuse('parity', 'REFUSED', ap.reason);
    log(`arms: parity ok on ${ap.calls} strong rows`);
  }
  const cols = dials.length ? challengerColumns(f, load, dials) : null;
  const F = input.study?.floorClusters ?? floorClusters();
  const ctx = r3Context(f, panel.months, 'day'), ctxCd = r3Context(f, panel.months, 'coinday');
  const strata = strataOf(f, panel.months);
  const strataText = jsonText(strata);
  const memory = { estimate_bytes: plan.bytes, budget_bytes: budget, batch_entries: plan.batchEntries, batches: plan.batches, parts: plan.parts, phases: plan.phases, collector: collected };
  record({ ok: true, leg: 'frame', entries_frame: entriesFrame, entries: f.nE, coins: panel.symbols.length, months_opened: [...b.opened.keys()].sort(), strata_sha256: sha256(strataText), memory });

  // the outcomes: every paired reading of every identifiable pair, under round 3's clusters and weights
  const counts: Counts = { boot: Math.min(B_BOOT, input.study?.counts?.boot ?? B_BOOT), shuffle: Math.min(B_SHUFFLE, input.study?.counts?.shuffle ?? B_SHUFFLE) };
  record({ ok: true, leg: 'outcomes', outcome_read_at: new Date().toISOString() });
  log('outcomes: pre-score');
  const keys = [...cands.flatMap((c) => ['ddelta1|bootstrap', 'ddelta1-coinday|bootstrap', 'a4|bootstrap', 'a5|bootstrap', 'a5|shuffle'].map((k) => `${rec.id}|${c.id}|${k}`)), `${rec.id}|served|a5|shuffle`];
  const values = seedsFor(R3_SEED, keys);
  const seed = (k: string): number => values[keys.indexOf(`${rec.id}|${k}`)];
  const o = (id: string, k: string): { B: number; alpha: number; seed: number; arms: boolean } => ({ B: counts.boot, alpha: ALPHA, seed: seed(`${id}|${k}|bootstrap`), arms: true });
  // one candidate at a time: its pair, its label-only support, and A5 on its bar sequences — then the sequences and
  // the row-share columns are let go (review 1, F2): what the outcome passes keep of a pair is its rows' directions
  const by = a5By(f, panel.months);
  const servedArm = new Map<string, ArmSums>();
  const items = cands.map((cand) => {
    const pair = r3Pair(f, cand, cols, stints);
    const support = supportOf(f, ctx, pair, F), coverage = coverageRatio(ctx.w, pair);
    let a5: PairedReading | null = null;
    if (support.identifiable) {
      const kind = cand.dial || cand.arm ? 'rows' : 'timeframe';
      let served = servedArm.get(kind);
      if (!served) { served = armSums(f.census, pair.servSeqs, counts.shuffle, seed('served|a5|shuffle'), by); servedArm.set(kind, served); }
      a5 = a5Ratio(f.census, cand.id, armSums(f.census, pair.chalSeqs, counts.shuffle, seed(`${cand.id}|a5|shuffle`), by), served, o(cand.id, 'a5'));
      log(`paired: ${cand.id}`);
    }
    const lean: Pair = { ...pair, chalSeqs: [], servSeqs: [], chalRows: NO_ROWS, servRows: NO_ROWS };
    collectGarbage();
    return { cand, pair: lean, support, coverage, a5 };
  });
  const specs: ReadSpec[] = items.filter((it) => it.support.identifiable).flatMap((it) => [
    { key: `${it.cand.id}|ddelta1`, kind: 'ddelta1' as const, ctx, pair: it.pair, o: o(it.cand.id, 'ddelta1') },
    { key: `${it.cand.id}|a4`, kind: 'a4' as const, ctx, pair: it.pair, o: o(it.cand.id, 'a4') },
  ]);
  const got = batchedReadings(f, load, specs, maxBatch);
  const reads = new Map<string, { dd: PairedReading | null; a4: PairedReading | null; a5: PairedReading | null; pair: Pair }>();
  for (const it of items) {
    const id = it.cand.id;
    reads.set(id, it.support.identifiable ? { dd: got.get(`${id}|ddelta1`) as PairedReading, a4: got.get(`${id}|a4`) as PairedReading, a5: it.a5, pair: it.pair } : { dd: null, a4: null, a5: null, pair: it.pair });
  }

  const rows: PrescoreRow[] = [];
  const candidates: Record<string, Record<string, unknown>> = {};
  for (const it of items) {
    const r = reads.get(it.cand.id) as { dd: PairedReading | null; a4: PairedReading | null; a5: PairedReading | null };
    const guards = { a4: r.a4 ? a4Guard(r.a4) : 'unreadable', a5: r.a5 ? a5Guard(r.a5) : 'unreadable', coverage: coverageGuard(it.coverage) } satisfies Record<string, GuardState>;
    rows.push({ id: it.cand.id, challenger: it.cand.challenger, identifiable: it.support.identifiable, point: r.dd ? r.dd.point : NaN, guards: Object.values(guards) });
    candidates[it.cand.id] = {
      challenger: it.cand.challenger, map: it.cand.map, what: it.cand.what, support: it.support, coverage: { ratio: num(it.coverage), guard: guards.coverage },
      ddelta1: slim(r.dd), a4: r.a4 ? { ...slim(r.a4), guard: guards.a4 } : null, a5: r.a5 ? { ...slim(r.a5), guard: guards.a5 } : null,
    };
  }
  const m = membersOf(rows);
  const preDays = dayPanel(panel.sizes.prescore), judgeDays = dayPanel(panel.sizes.judge);
  // the gate's second pass: each member's ΔΔ1 under coin × day clusters, in batches
  const cdSpecs: ReadSpec[] = m.members.map((id) => ({ key: id, kind: 'ddelta1' as const, ctx: ctxCd, pair: (reads.get(id) as { pair: Pair }).pair, o: o(id, 'ddelta1-coinday') }));
  const cdGot = cdSpecs.length ? batchedReadings(f, load, cdSpecs, maxBatch) : new Map<string, PairedReading>();
  const gate: Record<string, Gate> = {};
  for (const id of m.members) {
    const dd = (reads.get(id) as { dd: PairedReading }).dd, cd = cdGot.get(id) as PairedReading;
    const inputs: GateInputs = { point: dd.point, hDay: half(dd), hCoinDay: half(cd), pre: preDays, judge: judgeDays };
    gate[id] = gateOf(input.study?.gateInputs ? input.study.gateInputs(id, inputs) : inputs);
    candidates[id].ddelta1_coinday = slim(cd);
  }
  const d = decide(m, gate);
  if ('refusal' in d) return refuse('gate', 'INDETERMINATE', d.refusal);
  const { verdicts, causes } = d;
  const line = `${rec.line}=${Object.entries(verdicts).map(([c, v]) => `${c}:${v}`).join(';')}`;
  const file = path.join(input.out, rec.file);
  const opened = [...b.opened.keys()].sort();
  const text = jsonText({
    wave: R3_WAVE, kind: 'prescore', study: input.study ? 'injected' : 'registered', record: rec.id, seed: R3_SEED, entry_seed: rec.entrySeed,
    source: { commit: source.commit }, pins, floor_clusters: F, alpha: ALPHA, counts, clusters: 'utc-day', weights: 'equal per coin-month × census EXTERNAL timeframe mix',
    window: { outcomes: rec.outcomes, archives: rec.archives }, months_opened: opened, entries: f.nE, challenger_calls: cols ? cols.calls : 0,
    panel: { coins: panel.symbols.length, sizes: panel.sizes }, strata, strata_sha256: sha256(strataText), entries_frame: entriesFrame, memory,
    line, selection: { judged: m.judged, members: m.members, verdicts, causes }, family: d.family,
    gate, gate_note: GATE_NOTE, candidates, drops: f.drops,
  });
  writeAtomic(file, text);
  record({ ok: true, leg: 'result', line, result_sha256: sha256(text), months_opened: opened, last_month_opened: opened.length ? opened[opened.length - 1] : null });
  log(line);
  return { verdict: 'PASS', reason: 'ok', line, file };
}

/** The manifest of round 3's 2024–25 store: every 1m archive of the panel's coins in 2024-01 … 2025-12. Label-free. */
export function r3ManifestText(archives: ArchiveStore, panel: R3Panel): string {
  return archiveManifestText(buildArchiveManifest(archives, panel.names, R3_WINDOW.first, R3_WINDOW.last));
}

/**
 * `--init-archives`: writes the manifest of round 3's 2024–25 store, in round 3's store directory only, in place
 * (never through a link: review 1, F5), for the registered panel file (`pin`). Label-free.
 */
export function r3InitArchives(panelFile: string, archives: ArchiveStore, out: string, pin = R3_PANEL_SHA256): RunResult {
  const no = (reason: string): RunResult => ({ verdict: 'REFUSED', reason, line: null, file: null });
  const store = r3ArchivesRefusal(archives);
  if (store) return no(store);
  if (!within(out, path.join(cacheRoot(), R3_HOME, 'store'))) return no(`the manifest is written in ~/.cache/algovault/${R3_HOME}/store only`);
  const names = [path.basename(out), `${path.basename(out)}.tmp`];
  const linked = linkRefusal(path.dirname(out), 'the manifest directory', names) ?? writableRefusal(path.dirname(out), 'the manifest directory', names);
  if (linked) return no(linked);
  const bytes = fs.readFileSync(panelFile);
  if (sha256(bytes) !== pin) return no('the panel file is not the registered one');
  const panel = panelOf(JSON.parse(bytes.toString('utf8')) as PanelFile, R3_PRESCORE);
  if (typeof panel === 'string') return no(panel);
  const text = r3ManifestText(archives, panel);
  writeAtomic(out, text);
  return { verdict: 'PASS', reason: 'ok', line: `archives_sha256=${sha256(text)}\narchive_files=${(JSON.parse(text) as ArchiveManifest).files.length}`, file: out };
}

// ── the CLI ──────────────────────────────────────────────────────────────────────────────────────────────────────

const TOKEN = 'REGIME_CHALLENGE_R3_RUN_VERDICT';
const REPO = path.resolve(__dirname, '../../..');
const MODES: readonly string[] = ['--prescore', '--strata', '--init-archives'];
const VALUED: readonly string[] = ['--census', '--panel', '--archives', '--manifest', '--out'];

/** Why `argv` is not this CLI's, or null: one mode, valued flags each once with one value, nothing else. */
export function r3ArgvRefusal(argv: readonly string[]): string | null {
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!MODES.includes(t) && !VALUED.includes(t)) return `unknown argument '${t}'`;
    if (seen.has(t)) return `${t} is given twice`;
    seen.add(t);
    if (!VALUED.includes(t)) continue;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) return `${t} needs a value`;
    i++;
  }
  return MODES.filter((m) => seen.has(m)).length === 1 ? null : `exactly one of ${MODES.join(', ')}`;
}

function finish(verdict: 'PASS' | 'REFUSED' | 'INDETERMINATE', reason = ''): void {
  process.stdout.write(verdict === 'PASS' ? `${TOKEN}=PASS\n` : `${TOKEN}=${verdict} — ${reason}\n`);
  process.exitCode = verdict === 'PASS' ? 0 : verdict === 'REFUSED' ? 1 : 3;
}

function main(): void {
  const argv = process.argv.slice(2);
  const bad = r3ArgvRefusal(argv);
  if (bad) return finish('INDETERMINATE', bad);
  const val = (k: string): string => { const i = argv.indexOf(k); return i >= 0 ? path.resolve(argv[i + 1]) : ''; };
  const archives: ArchiveStore = { cache: val('--archives'), overlay: val('--archives') };
  if (argv.includes('--init-archives')) {
    if (!val('--panel') || !val('--archives') || !val('--out')) return finish('INDETERMINATE', 'usage: --init-archives --panel P --archives A --out MANIFEST');
    const res = r3InitArchives(val('--panel'), archives, val('--out'));
    if (res.line) process.stdout.write(`${res.line}\n`);
    return finish(res.verdict, res.reason);
  }
  const need = ['--census', '--panel', '--archives', '--manifest', '--out'];
  if (need.some((k) => !val(k))) return finish('INDETERMINATE', `usage: ${need.map((k) => `${k} X`).join(' ')}`);
  const input: R3Input = { repo: REPO, censusFile: val('--census'), panelFile: val('--panel'), archives, manifest: val('--manifest'), out: val('--out') };
  const res = argv.includes('--strata') ? r3StrataRun(input) : r3PrescoreRun(input);
  if (res.line) process.stdout.write(`${res.line}\n`);
  if (res.file) process.stdout.write(`result=${res.file}\n`);
  finish(res.verdict, res.reason);
}

if (require.main === module) {
  try { main(); } catch (err) { process.stderr.write(`regime-challenge r3: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`); finish('INDETERMINATE', 'the run threw'); }
}
