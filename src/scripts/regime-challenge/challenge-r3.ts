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
//     multiple at half its in-sample point is above 1 is `KEEP — underpowered before any read` and leaves.
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
import { ALPHA, B_BOOT, B_SHUFFLE } from '../regime-diag/diag-spec.js';
import { parseCensus, withOutcomes, type Frame, type Loaded } from '../regime-diag/frame.js';
import { sealHome } from '../regime-diag/guard.js';
import { MUTATE } from '../regime-diag/mutate.js';
import { PARITY_FIXTURE, checkCoreParity } from '../regime-diag/parity.js';
import { floorClusters, seedsFor } from '../regime-diag/prims.js';
import { archivesRefusal, landedSource, linkRefusal, outRefusal, real, within, writableRefusal, type Opened } from './challenge-guard.js';
import { CANDIDATES, CENSUS_SHA256, PRESCORE, monthRefusal, monthsOpened, windowRefusal, type Candidate, type ChallengeRecord, type Dial } from './challenge-spec.js';
import { R2_ROUND } from './challenge-r2.js';
import { armParity, challengerColumns, checkChallengerParity } from './challenger-replay.js';
import { a4Difference, a4Guard, a5Guard, a5Ratio, armSums, coverageGuard, coverageRatio, deltaDelta1, powerAt, sameDial, supportOf, type ArmSums, type GuardState, type Pair, type PairedReading } from './paired-stats.js';
import { selectionOf, type Counts, type PrescoreRow, type RunResult } from './challenge-run.js';
import { a5By, chunkedFrame, r3Context, r3Pair, stintsOf, strataOf, type PanelMonths } from './challenge-r3-frame.js';
import { nbaseOf, type MonthState, type R3Rule } from './challenge-r3-screen.js';

export const R3_WAVE = 'EDGE-REGIME-CHALLENGE-R3-W1';
export const R3_SEED = 'regime-challenge-r3';
/** Round 3's home under `~/.cache/algovault`: its archives, its store and its outputs. */
export const R3_HOME = 'regime-challenge-r3';
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
    if (!(n > 0)) continue;
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
  rho_raw: number; rho: number;
  /** var(day mean) ÷ σ² on each side: ρ + (1 − ρ) · mean(1/n). */
  v: { pre: number; judge: number };
  scale: number;
  power: ReturnType<typeof powerAt>;
  passes: boolean;
}
/**
 * The power gate (ruling Q5). With equal weights within a day, var(day mean) = σ²(ρ + (1 − ρ)/n). The coin × day
 * bootstrap treats the coins of a day as independent and reads σ² · mean(1/n) / D; the day bootstrap reads
 * σ² (ρ + (1 − ρ) · mean(1/n)) / D. Their ratio gives ρ = (deff − 1) · m / (1 − m), clamped to [0, 1]. The day-cluster SE
 * moves to 2020–23 by sqrt((v_J / D_J) ÷ (v_P / D_P)), and round 1's §5 instrument tests half the in-sample point.
 */
export function gateOf(i: GateInputs): Gate {
  const deff = (i.hDay / i.hCoinDay) ** 2, m = i.pre.meanInvN;
  const rhoRaw = (deff - 1) * m / (1 - m);
  const rho = Number.isFinite(rhoRaw) ? Math.min(1, Math.max(0, rhoRaw)) : NaN;
  const v = { pre: rho + (1 - rho) * i.pre.meanInvN, judge: rho + (1 - rho) * i.judge.meanInvN };
  const scale = Math.sqrt((v.judge / i.judge.days) / (v.pre / i.pre.days));
  const power = powerAt(i.hDay, i.point / 2, scale);
  return { inputs: i, deff, rho_raw: rhoRaw, rho, v, scale, power, passes: Number.isFinite(power.multiple) && power.multiple <= 1 };
}

// ── the pre-score ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface R3Study {
  rec: ChallengeRecord;
  counts?: Counts;
  floorClusters?: number;
  log?: (line: string) => void;
  /** The sha256 a synthetic pre-score holds its census, archive manifest and panel file to. */
  pins: { census: string; archives: string; panel: string };
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
  const { f, panel, load } = b;
  const cands = R3_CANDIDATES;
  if (cands.some((c) => c.arm)) {
    const ap = armParity(f);
    if (!ap.ok) return refuse('parity', 'REFUSED', ap.reason);
    log(`arms: parity ok on ${ap.calls} strong rows`);
  }
  const dials: Dial[] = [];
  for (const c of cands) if (c.dial && !dials.some((d) => sameDial(d, c.dial as Dial))) dials.push(c.dial);
  const cols = dials.length ? challengerColumns(f, load, dials) : null;
  const F = input.study?.floorClusters ?? floorClusters();
  const ctx = r3Context(f, panel.months, 'day'), ctxCd = r3Context(f, panel.months, 'coinday');
  const stints = stintsOf(f, panel.months);
  const strata = strataOf(f, panel.months);
  const items = cands.map((cand) => { const pair = r3Pair(f, cand, cols, stints); return { cand, pair, support: supportOf(f, ctx, pair, F), coverage: coverageRatio(ctx.w, pair) }; });
  const strataText = jsonText(strata);
  record({ ok: true, leg: 'frame', entries: f.nE, coins: panel.symbols.length, months_opened: [...b.opened.keys()].sort(), strata_sha256: sha256(strataText) });

  // the outcomes: every paired reading of every identifiable pair, under round 3's clusters and weights
  const counts: Counts = { boot: Math.min(B_BOOT, input.study?.counts?.boot ?? B_BOOT), shuffle: Math.min(B_SHUFFLE, input.study?.counts?.shuffle ?? B_SHUFFLE) };
  record({ ok: true, leg: 'outcomes', outcome_read_at: new Date().toISOString() });
  log('outcomes: pre-score');
  const keys = [...items.flatMap((it) => ['ddelta1|bootstrap', 'ddelta1-coinday|bootstrap', 'a4|bootstrap', 'a5|bootstrap', 'a5|shuffle'].map((k) => `${rec.id}|${it.cand.id}|${k}`)), `${rec.id}|served|a5|shuffle`];
  const values = seedsFor(R3_SEED, keys);
  const seed = (k: string): number => values[keys.indexOf(`${rec.id}|${k}`)];
  const by = a5By(f, panel.months);
  let fo: Frame | null = null;
  const servedArm = new Map<string, ArmSums>();
  const reads = new Map<string, { dd: PairedReading | null; a4: PairedReading | null; a5: PairedReading | null; pair: Pair }>();
  for (const it of items) {
    const id = it.cand.id;
    if (!it.support.identifiable) { reads.set(id, { dd: null, a4: null, a5: null, pair: it.pair }); continue; }
    fo ??= withOutcomes(f, load);
    const o = (k: string): { B: number; alpha: number; seed: number; arms: boolean } => ({ B: counts.boot, alpha: ALPHA, seed: seed(`${id}|${k}|bootstrap`), arms: true });
    const dd = deltaDelta1(fo, ctx, it.pair, o('ddelta1'));
    const g4 = a4Difference(fo, ctx, it.pair, o('a4'));
    const kind = it.cand.dial || it.cand.arm ? 'rows' : 'timeframe';
    let served = servedArm.get(kind);
    if (!served) { served = armSums(fo.census, it.pair.servSeqs, counts.shuffle, seed('served|a5|shuffle'), by); servedArm.set(kind, served); }
    const g5 = a5Ratio(fo.census, id, armSums(fo.census, it.pair.chalSeqs, counts.shuffle, seed(`${id}|a5|shuffle`), by), served, o('a5'));
    reads.set(id, { dd, a4: g4, a5: g5, pair: it.pair });
    log(`paired: ${id}`);
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
  const gate: Record<string, Gate> = {};
  const verdicts = { ...m.verdicts }, causes = { ...m.causes };
  for (const id of m.members) {
    const r = reads.get(id) as { dd: PairedReading; pair: Pair };
    const cd = deltaDelta1(fo as Frame, ctxCd, r.pair, { B: counts.boot, alpha: ALPHA, seed: seed(`${id}|ddelta1-coinday|bootstrap`), arms: true });
    const g = gateOf({ point: r.dd.point, hDay: half(r.dd), hCoinDay: half(cd), pre: preDays, judge: judgeDays });
    gate[id] = g;
    candidates[id].ddelta1_coinday = slim(cd);
    const ch = (R3_CANDIDATES.find((c) => c.id === id) as Candidate).challenger;
    if (!g.passes) { verdicts[ch] = 'KEEP — underpowered before any read'; causes[ch] = `${id}: the power multiple at half its in-sample point is ${g.power.multiple}, above 1`; }
    else causes[ch] = `${id} is powered: multiple ${g.power.multiple}`;
  }
  const line = `${rec.line}=${Object.entries(verdicts).map(([c, v]) => `${c}:${v}`).join(';')}`;
  const file = path.join(input.out, rec.file);
  const opened = [...b.opened.keys()].sort();
  const text = jsonText({
    wave: R3_WAVE, kind: 'prescore', study: input.study ? 'injected' : 'registered', record: rec.id, seed: R3_SEED, entry_seed: rec.entrySeed,
    source: { commit: source.commit }, pins, floor_clusters: F, alpha: ALPHA, counts, clusters: 'utc-day', weights: 'equal per coin-month × census EXTERNAL timeframe mix',
    window: { outcomes: rec.outcomes, archives: rec.archives }, months_opened: opened, entries: f.nE, challenger_calls: cols ? cols.calls : 0,
    panel: { coins: panel.symbols.length, sizes: panel.sizes }, strata, strata_sha256: sha256(strataText),
    line, selection: { judged: m.judged, members: m.members, verdicts, causes },
    gate: Object.fromEntries(Object.entries(gate).map(([id, g]) => [id, { ...g, passes: g.passes }])), candidates, drops: f.drops,
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
    const store = r3ArchivesRefusal(archives);
    if (store) return finish('REFUSED', store);
    if (!within(val('--out'), path.join(cacheRoot(), R3_HOME, 'store'))) return finish('REFUSED', `the manifest is written in ~/.cache/algovault/${R3_HOME}/store only`);
    const bytes = fs.readFileSync(val('--panel'));
    if (sha256(bytes) !== R3_PANEL_SHA256) return finish('REFUSED', 'the panel file is not the registered one');
    const panel = panelOf(JSON.parse(bytes.toString('utf8')) as PanelFile, R3_PRESCORE);
    if (typeof panel === 'string') return finish('REFUSED', panel);
    const text = r3ManifestText(archives, panel);
    fs.mkdirSync(path.dirname(val('--out')), { recursive: true });
    writeAtomic(val('--out'), text);
    process.stdout.write(`archives_sha256=${sha256(text)}\narchive_files=${(JSON.parse(text) as ArchiveManifest).files.length}\n`);
    return finish('PASS');
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
