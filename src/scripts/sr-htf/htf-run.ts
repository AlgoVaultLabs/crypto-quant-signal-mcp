// sr-htf/htf-run.ts — EDGE-SR-HTF-LEVELS-W1: the study's one entrypoint. It reads no network.
//
//   --calibrate --out F [--from A --reps N --width-mult X]   the null calibration's counts on seeded driftless walks
//                                                           with seeded volume (synthetic only)
//   --skeleton --store S --out DIR                          the label-free skeleton of the registered store: who is
//                                                           served, who has a control, the side mix — no outcome
//   --outcomes --store S --out DIR --registration audits/<file>.md
//                                                           THE outcome read. Guarded per coin by the closed study's
//                                                           guard (sr-backtest/guard.ts): it refuses, reason named,
//                                                           unless the registration is on origin/main and pins this
//                                                           code and every coin's store manifest.
//
// The run: per coin, the sources `htf` and `vpoc` in the cells 1h and 4h, and the closed study's z1 in its 1d cell
// (descriptive), from the coin's first evaluable instant on the grid anchored at the study's start.
// Outcome files go to DIR, which must sit outside the repository: the repo is public and carries no figure.
// Callers gate on the token: SR_HTF_RUN_VERDICT=PASS | REFUSED — <reason> | INDETERMINATE — <reason> (exit 0 / 3 / 3).
import fs from 'node:fs';
import path from 'node:path';
import { BT, DAY, M15, tfOf, type BtParams } from '../sr-backtest/spec.js';
import { COLS, Tally, maxHorizonBars } from '../sr-backtest/engine.js';
import { checkOutcomeGuard, type GuardResult } from '../sr-backtest/guard.js';
import { sha256, writeAtomic } from '../sr-backtest/store.js';
import { CALIBRATION_HTF, HP, PANEL, STUDY_HTF, VENUE, WAVE, planLabel, type HtfParams } from './config.js';
import { REGISTERED, runRegistry, sourceCtx, type Provider, type SourceEvent } from './registry.js';
import { HTF_SOURCES, htfProvider, vpocProvider } from './sources.js';
import { loadVCoin, readPanel } from './htf-store.js';
import { synthVCoin } from './synthv.js';

const REPO = path.resolve(__dirname, '../../..');

/** Every file whose bytes decide an outcome of this study. The registration must pin each one. */
export const HTF_PINNED: readonly string[] = Object.freeze([
  'src/scripts/sr-probe/level-v0.ts',
  'src/scripts/sr-probe/store.ts',
  'src/scripts/sr-backtest/spec.ts',
  'src/scripts/sr-backtest/zones.ts',
  'src/scripts/sr-backtest/engine.ts',
  'src/scripts/sr-backtest/store.ts',
  'src/scripts/sr-backtest/guard.ts',
  'src/scripts/sr-backtest/synth.ts',
  'scripts/sr-backtest/sr_backtest.py',
  'src/scripts/sr-htf/config.ts',
  'src/scripts/sr-htf/registry.ts',
  'src/scripts/sr-htf/sources.ts',
  'src/scripts/sr-htf/htf-store.ts',
  'src/scripts/sr-htf/synthv.ts',
  'src/scripts/sr-htf/htf-run.ts',
  'src/scripts/sr-htf/sr_htf.py',
  'src/scripts/cluster-perm-stats.py',
  'ops/monitoring/population_comparison.py',
]);

export const CELLS = STUDY_HTF.cells.map(tfOf);
export const DESCRIPTIVE = [tfOf(STUDY_HTF.descriptiveCell)];

/** Header of the calibration counts: one tally row per replication, source, cell, day and walk. */
export const CALIBRATION_HEADER_HTF = `rep,key,tf,day,coin,${COLS.join(',')}`;

/** The calibration walks' length: the warm-up, the longest evaluation, one day, and the 4h cell's horizon. */
export function calibrationBarsHtf(p: BtParams = BT): number {
  const horizonDays = Math.max(...CELLS.map((tf) => Math.ceil((maxHorizonBars(tf, p) * tf.stepMs) / DAY)));
  return (CALIBRATION_HTF.warmupDays + Math.max(...Object.values(CALIBRATION_HTF.evalDays)) + 1 + horizonDays) * (DAY / M15);
}

/** One replication of the null calibration: `walks` driftless walks with volume through the whole harness. */
export function calibrationRowsHtf(rep: number, p: BtParams = BT, hp: HtfParams = HP): string[] {
  const bars = calibrationBarsHtf(p);
  const firstMs = CALIBRATION_HTF.startMs - CALIBRATION_HTF.warmupDays * DAY;
  const endMs = firstMs + bars * M15;
  const sources: ReadonlyArray<readonly [string, Provider]> = [['htf', htfProvider(hp)], ['vpoc', vpocProvider(hp)]];
  const tally = new Tally();
  for (let w = 0; w < CALIBRATION_HTF.walks; w++) {
    const coin = synthVCoin(`W${String(w).padStart(2, '0')}`, { seed: CALIBRATION_HTF.seed, key: `htfcal|${rep}|${w}`, firstMs, bars });
    runRegistry(coin, { params: p, startMs: CALIBRATION_HTF.startMs, endMs, evalDays: CALIBRATION_HTF.evalDays, timeframes: CELLS, sources, outcomes: true }, tally);
  }
  return [...tally.rows.keys()].sort().map((id) => `${rep},${id.split('|').join(',')},${tally.rows.get(id)!.join(',')}`);
}

export function calibrationCsvHtf(from: number, reps: number, p: BtParams = BT, header = true, hp: HtfParams = HP): string {
  const lines: string[] = header ? [CALIBRATION_HEADER_HTF] : [];
  for (let r = from; r < from + reps; r++) lines.push(...calibrationRowsHtf(r, p, hp));
  return `${lines.join('\n')}\n`;
}

export const EVENTS_HEADER_HTF = 'src,coin,tf,t,t2,side,rank,distance_atr,width_atr,forced,s_entered,s_outcome,c_entered,c_outcome';

const eventLine = (e: SourceEvent): string =>
  [e.src, e.coin, e.tf, e.t, e.t2, e.side, e.rank, e.distanceAtr.toFixed(6), e.widthAtr.toFixed(6), e.forced ? 1 : 0,
    e.s.entered ? 1 : 0, e.s.outcome ?? '', e.c.entered ? 1 : 0, e.c.outcome ?? ''].join(',');

/** What the outcome step's guard said, per coin: one call per coin's manifest, the first one fetching origin. */
export interface PanelGuard {
  ok: boolean;
  reason: string;
  registrationCommit: string | null;
  originMain: string | null;
  harnessSha256: Record<string, string>;
  manifests: Array<{ coin: string; label: string; manifestSha256: string | null }>;
}

/** The closed study's guard over every coin of the panel: all must pass, the first refusal is named. */
export function checkPanelGuard(opts: { repo: string; registration: string; store: string; panel?: readonly string[]; pinned?: readonly string[] }): PanelGuard {
  const out: PanelGuard = { ok: false, reason: '', registrationCommit: null, originMain: null, harnessSha256: {}, manifests: [] };
  const panel = opts.panel ?? PANEL;
  // The panel is constructed here, so an empty one is vacuity, never a pass: no manifest would be checked.
  if (panel.length === 0) return { ...out, reason: 'the panel is empty: no store manifest would be checked' };
  for (let i = 0; i < panel.length; i++) {
    const label = planLabel(panel[i]);
    const g: GuardResult = checkOutcomeGuard({ repo: opts.repo, registration: opts.registration, store: opts.store, venue: label, pinned: opts.pinned ?? HTF_PINNED, fetch: i === 0 });
    if (!g.ok) return { ...out, reason: `${panel[i]}: ${g.reason}`, registrationCommit: g.registrationCommit, originMain: g.originMain };
    if (i === 0) Object.assign(out, { registrationCommit: g.registrationCommit, originMain: g.originMain, harnessSha256: g.harnessSha256 });
    else if (g.registrationCommit !== out.registrationCommit || JSON.stringify(g.harnessSha256) !== JSON.stringify(out.harnessSha256)) {
      return { ...out, reason: `${panel[i]}: the registration or the harness changed between two coins' checks` };
    }
    out.manifests.push({ coin: panel[i], label, manifestSha256: g.manifestSha256 });
  }
  return { ...out, ok: true, reason: 'ok' };
}

export interface PanelRunResult {
  ok: boolean;
  reason: string;
  files: Record<string, string>;
}

/** The registered store through the harness. `outcomes: false` is the label-free skeleton. */
export function runPanel(opts: { store: string; out: string; outcomes: boolean; guard: PanelGuard | null; panel?: readonly string[] }): PanelRunResult {
  const rel = path.relative(REPO, path.resolve(opts.out));
  if (!rel.startsWith('..')) return { ok: false, reason: 'the output directory is inside the repository; figures never go there', files: {} };
  const coins = readPanel(opts.store, opts.panel ?? PANEL);
  if (coins.length === 0) return { ok: false, reason: 'the panel is empty: nothing would be read', files: {} };
  fs.mkdirSync(opts.out, { recursive: true });
  const startedAt = new Date().toISOString();
  const tally = new Tally();
  const eventsFile = path.join(opts.out, 'events.csv');
  const fd = opts.outcomes ? fs.openSync(`${eventsFile}.tmp`, 'w') : null;
  if (fd !== null) fs.writeSync(fd, `${EVENTS_HEADER_HTF}\n`);
  let buf: string[] = [];
  const flush = (): void => {
    if (fd !== null && buf.length) fs.writeSync(fd, `${buf.join('\n')}\n`);
    buf = [];
  };
  const onEvent = fd === null ? undefined : (e: SourceEvent): void => {
    buf.push(eventLine(e));
    if (buf.length >= 5000) flush();
  };
  for (const c of coins) {
    const data = { coin: c.coin, frames: loadVCoin(opts.store, c.plan, c.coin) };
    const ctx = sourceCtx(data, BT);
    const base = { params: BT, startMs: STUDY_HTF.startMs, firstMs: c.firstMs, endMs: STUDY_HTF.endMs, outcomes: opts.outcomes, onEvent };
    runRegistry(data, { ...base, timeframes: CELLS, sources: HTF_SOURCES }, tally, ctx);
    runRegistry(data, { ...base, timeframes: DESCRIPTIVE, sources: [['z1', REGISTERED.z1]] }, tally, ctx);
    process.stderr.write(`sr-htf run: ${c.coin} done (${tally.rows.size} rows)\n`);
  }
  flush();
  process.stderr.write(`sr-htf run: ${coins.length} coins, ${tally.rows.size} count rows, ${tally.instants} grid instants\n`);
  const files: Record<string, string> = {};
  const put = (name: string, text: string): void => {
    writeAtomic(path.join(opts.out, name), text);
    files[name] = sha256(text);
  };
  if (fd !== null) {
    fs.closeSync(fd);
    fs.renameSync(`${eventsFile}.tmp`, eventsFile);
    files['events.csv'] = sha256(fs.readFileSync(eventsFile));
  }
  put(opts.outcomes ? 'counts.csv' : 'skeleton.csv', tally.csv());
  put('sides.json', `${JSON.stringify(Object.fromEntries([...tally.sides.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), null, 1)}\n`);
  const meta = {
    wave: WAVE, mode: opts.outcomes ? 'outcomes' : 'skeleton', venue: VENUE, guard: opts.guard,
    coins: coins.map((c) => ({ coin: c.coin, firstMs: c.firstMs, firstFullDayMs: c.firstFullDayMs, planStartMs: c.plan.startMs })),
    startMs: STUDY_HTF.startMs, endMs: STUDY_HTF.endMs, holdoutStartMs: STUDY_HTF.holdoutStartMs, instants: tally.instants,
    params: BT, study: STUDY_HTF, hp: HP, cells: STUDY_HTF.cells, descriptiveCell: STUDY_HTF.descriptiveCell,
    horizonBars: Object.fromEntries([...CELLS, ...DESCRIPTIVE].map((t) => [t.key, maxHorizonBars(t, BT)])), startedAt, finishedAt: new Date().toISOString(), files,
  };
  writeAtomic(path.join(opts.out, 'run-meta.json'), `${JSON.stringify(meta, null, 1)}\n`);
  return { ok: true, reason: 'ok', files };
}

/** THE outcome read, guarded. Refused — reason named — unless every coin's guard passes; nothing is read then. */
export function outcomeStepHtf(opts: { repo: string; registration: string; store: string; out: string; panel?: readonly string[]; pinned?: readonly string[] }): { guard: PanelGuard; run: PanelRunResult | null } {
  const guard = checkPanelGuard(opts);
  if (!guard.ok) return { guard, run: null };
  return { guard, run: runPanel({ store: opts.store, out: opts.out, outcomes: true, guard, panel: opts.panel }) };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const say = (verdict: string): void => {
    process.stdout.write(`SR_HTF_RUN_VERDICT=${verdict}\n`);
    if (!verdict.startsWith('PASS')) process.exitCode = 3;
  };
  const out = arg('--out');
  if (!out) return say('INDETERMINATE — --out is required');
  if (process.argv.includes('--calibrate')) {
    const from = Number(arg('--from') ?? 0);
    const reps = Number(arg('--reps') ?? CALIBRATION_HTF.replications);
    const mult = Number(arg('--width-mult') ?? 1);
    writeAtomic(out, calibrationCsvHtf(from, reps, { ...BT, controlWidthMult: mult }, !process.argv.includes('--no-header')));
    return say('PASS');
  }
  const store = arg('--store');
  if (!store) return say('INDETERMINATE — --store is required');
  if (process.argv.includes('--skeleton')) {
    const r = runPanel({ store, out, outcomes: false, guard: null });
    return say(r.ok ? 'PASS' : `INDETERMINATE — ${r.reason}`);
  }
  if (process.argv.includes('--outcomes')) {
    const registration = arg('--registration');
    if (!registration) return say('INDETERMINATE — --registration is required');
    const { guard, run } = outcomeStepHtf({ repo: REPO, registration, store, out });
    if (!run) return say(`REFUSED — ${guard.reason}`);
    return say(run.ok ? 'PASS' : `INDETERMINATE — ${run.reason}`);
  }
  say('INDETERMINATE — no mode given (--calibrate | --skeleton | --outcomes)');
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`sr-htf run: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.stdout.write('SR_HTF_RUN_VERDICT=INDETERMINATE — the run threw\n');
    process.exitCode = 3;
  }
}
