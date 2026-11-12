// sr-backtest/run.ts — EDGE-SR-LEVEL-BACKTEST-W1: the harness's one entrypoint. It reads no network.
//
//   --fixture                          writes ops/sr-level-parity-fixture.json (fixture.ts)
//   --calibrate --out F [--from A --reps N --width-mult X]
//                                      the null calibration's counts on seeded driftless walks (synthetic only)
//   --skeleton --store S --out DIR     the label-free skeleton of the registered store: who is served, who has a
//                                      control, side mix — no outcome is resolved
//   --outcomes --store S --out DIR --registration audits/<file>.md
//                                      THE outcome read. Guarded (guard.ts): it refuses, reason named, unless the
//                                      registration is on origin/main and pins this code and this store.
//
// Outcome files go to DIR, which must sit outside the repository: the repo is public and carries no figure.
// Callers gate on the token: SR_BACKTEST_RUN_VERDICT=PASS | REFUSED — <reason> | INDETERMINATE — <reason>
// (exit 0 / 3 / 3).
import fs from 'node:fs';
import path from 'node:path';
import { BT, DAY, STUDY, TIMEFRAMES, WAVE, tfOf, type BtParams } from './spec.js';
import { COLS, Tally, maxHorizonBars, runCoin, type PairEvent } from './engine.js';
import { FIXTURE_PATH, fixtureText } from './fixture.js';
import { checkOutcomeGuard, type GuardResult } from './guard.js';
import { loadCoin, readPlan, sha256, writeAtomic } from './store.js';
import { CALIBRATION, calibrationBars, synthCoin } from './synth.js';

const REPO = path.resolve(__dirname, '../../..');

/** Header of the calibration counts: one tally row per replication, arm, timeframe, day and walk. */
export const CALIBRATION_HEADER = `rep,key,tf,day,coin,${COLS.join(',')}`;

/** One replication of the null calibration: `CALIBRATION.walks` driftless walks through the whole harness. */
export function calibrationRows(rep: number, p: BtParams = BT): string[] {
  const bars = calibrationBars(maxHorizonBars(tfOf('1d'), p));
  const firstMs = CALIBRATION.startMs - CALIBRATION.warmupDays * DAY;
  const endMs = firstMs + bars * 900_000;
  const tally = new Tally();
  for (let w = 0; w < CALIBRATION.walks; w++) {
    const coin = synthCoin(`W${String(w).padStart(2, '0')}`, { seed: CALIBRATION.seed, key: `cal|${rep}|${w}`, firstMs, bars });
    runCoin(coin, { params: p, startMs: CALIBRATION.startMs, endMs, evalDays: CALIBRATION.evalDays, sources: ['z1'], crossTf: false, outcomes: true }, tally);
  }
  const out: string[] = [];
  for (const id of [...tally.rows.keys()].sort()) {
    if (!/^(z1|v4a|v4b)\|/.test(id)) continue;
    out.push(`${rep},${id.split('|').join(',')},${tally.rows.get(id)!.join(',')}`);
  }
  return out;
}

export function calibrationCsv(from: number, reps: number, p: BtParams = BT, header = true): string {
  const lines: string[] = header ? [CALIBRATION_HEADER] : [];
  for (let r = from; r < from + reps; r++) lines.push(...calibrationRows(r, p));
  return `${lines.join('\n')}\n`;
}

export const EVENTS_HEADER = 'coin,tf,t,t2,side,rank,touches,agree,round,distance_atr,width_atr,forced,s_entered,s_outcome,c_entered,c_outcome';

const eventLine = (e: PairEvent): string =>
  [e.coin, e.tf, e.t, e.t2, e.side, e.rank, e.touches, e.agree, e.round ? 1 : 0, e.distanceAtr.toFixed(6), e.widthAtr.toFixed(6), e.forced ? 1 : 0,
    e.s.entered ? 1 : 0, e.s.outcome ?? '', e.c.entered ? 1 : 0, e.c.outcome ?? ''].join(',');

export interface StoreRunResult {
  ok: boolean;
  reason: string;
  files: Record<string, string>;
}

/** The registered store through the harness. `outcomes: false` is the label-free skeleton. */
export function runStore(opts: { store: string; venue: string; out: string; outcomes: boolean; guard: GuardResult | null; coins?: number }): StoreRunResult {
  const plan = readPlan(opts.store, opts.venue);
  if (!plan) return { ok: false, reason: `no store plan for ${opts.venue} in ${opts.store}`, files: {} };
  const rel = path.relative(REPO, path.resolve(opts.out));
  if (!rel.startsWith('..')) return { ok: false, reason: 'the output directory is inside the repository; figures never go there', files: {} };
  fs.mkdirSync(opts.out, { recursive: true });
  const startedAt = new Date().toISOString();
  const tally = new Tally();
  const coins = plan.coins.slice(0, opts.coins ?? plan.coins.length);
  const eventsFile = path.join(opts.out, 'events-z1.csv');
  const fd = opts.outcomes ? fs.openSync(`${eventsFile}.tmp`, 'w') : null;
  if (fd !== null) fs.writeSync(fd, `${EVENTS_HEADER}\n`);
  let buf: string[] = [];
  const flush = (): void => {
    if (fd !== null && buf.length) fs.writeSync(fd, `${buf.join('\n')}\n`);
    buf = [];
  };
  for (const coin of coins) {
    runCoin({ coin, frames: loadCoin(opts.store, plan, coin) }, {
      params: BT, startMs: plan.startMs, endMs: plan.endMs, crossTf: true, outcomes: opts.outcomes,
      onPair: fd === null ? undefined : (e) => {
        buf.push(eventLine(e));
        if (buf.length >= 5000) flush();
      },
    }, tally);
    process.stderr.write(`sr-backtest run: ${coin} done (${tally.rows.size} rows)\n`);
  }
  flush();
  const files: Record<string, string> = {};
  const put = (name: string, text: string): void => {
    writeAtomic(path.join(opts.out, name), text);
    files[name] = sha256(text);
  };
  if (fd !== null) {
    fs.closeSync(fd);
    fs.renameSync(`${eventsFile}.tmp`, eventsFile);
    files['events-z1.csv'] = sha256(fs.readFileSync(eventsFile));
  }
  put(opts.outcomes ? 'counts.csv' : 'skeleton.csv', tally.csv());
  put('sides.json', `${JSON.stringify(Object.fromEntries([...tally.sides.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), null, 1)}\n`);
  const meta = {
    wave: WAVE, mode: opts.outcomes ? 'outcomes' : 'skeleton', venue: opts.venue, guard: opts.guard, coins, startMs: plan.startMs, endMs: plan.endMs,
    holdoutStartMs: plan.endMs - STUDY.holdoutDays * DAY, panelAsOf: plan.panelAsOf, instants: tally.instants, params: BT, study: STUDY,
    timeframes: TIMEFRAMES.map((t) => ({ key: t.key, horizonBars: maxHorizonBars(t, BT) })), startedAt, finishedAt: new Date().toISOString(), files,
  };
  writeAtomic(path.join(opts.out, 'run-meta.json'), `${JSON.stringify(meta, null, 1)}\n`);
  return { ok: true, reason: 'ok', files };
}

/** THE outcome read, guarded. Refused — reason named — unless the guard passes; nothing is read or written then. */
export function outcomeStep(opts: { repo: string; registration: string; store: string; venue: string; out: string }): { guard: GuardResult; run: StoreRunResult | null } {
  const guard = checkOutcomeGuard({ repo: opts.repo, registration: opts.registration, store: opts.store, venue: opts.venue });
  if (!guard.ok) return { guard, run: null };
  return { guard, run: runStore({ store: opts.store, venue: opts.venue, out: opts.out, outcomes: true, guard }) };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const say = (verdict: string): void => {
    process.stdout.write(`SR_BACKTEST_RUN_VERDICT=${verdict}\n`);
    if (!verdict.startsWith('PASS')) process.exitCode = 3;
  };
  const venue = arg('--venue') ?? 'BINANCE';
  if (process.argv.includes('--fixture')) {
    writeAtomic(path.join(REPO, FIXTURE_PATH), fixtureText());
    return say('PASS');
  }
  const out = arg('--out');
  if (!out) return say('INDETERMINATE — --out is required');
  if (process.argv.includes('--calibrate')) {
    const from = Number(arg('--from') ?? 0);
    const reps = Number(arg('--reps') ?? CALIBRATION.replications);
    const mult = Number(arg('--width-mult') ?? 1);
    writeAtomic(out, calibrationCsv(from, reps, { ...BT, controlWidthMult: mult }, !process.argv.includes('--no-header')));
    return say('PASS');
  }
  const store = arg('--store');
  if (!store) return say('INDETERMINATE — --store is required');
  if (process.argv.includes('--skeleton')) {
    const r = runStore({ store, venue, out, outcomes: false, guard: null, coins: arg('--coins') ? Number(arg('--coins')) : undefined });
    return say(r.ok ? 'PASS' : `INDETERMINATE — ${r.reason}`);
  }
  if (process.argv.includes('--outcomes')) {
    const registration = arg('--registration');
    if (!registration) return say('INDETERMINATE — --registration is required');
    const { guard, run } = outcomeStep({ repo: REPO, registration, store, venue, out });
    if (!run) return say(`REFUSED — ${guard.reason}`);
    return say(run.ok ? 'PASS' : `INDETERMINATE — ${run.reason}`);
  }
  say('INDETERMINATE — no mode given (--fixture | --calibrate | --skeleton | --outcomes)');
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`sr-backtest run: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.stdout.write('SR_BACKTEST_RUN_VERDICT=INDETERMINATE — the run threw\n');
    process.exitCode = 3;
  }
}
