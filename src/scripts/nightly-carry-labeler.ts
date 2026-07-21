/**
 * EDGE-CARRY-RANKER-W1 CH2 — permanent nightly label-freshness cadence (in-container, cron 02:23 UTC).
 *
 * Sequences the three label streams; each step reuses the SHIPPED script verbatim as a child process
 * (identical to manual invocation; isolated memory/crash):
 *   1. raw-incremental       backfill-funding-episodes.js raw --since-checkpoint
 *   2. episodes-close        backfill-funding-episodes.js episodes --reclose-censored
 *   3. directional-labels    backfill-directional-labels.js        (DB-state resume)
 *
 * Silent-recovery contract (CLAUDE.md): failures LOG ONLY (no TG), non-zero exit, cron retries next
 * night. Steps 2–3 depend on step 1's data, so the run aborts at the first failure. Every step emits a
 * success-path log line (load-bearing-logging rule).
 *
 * Pass-through for bounded gate fires: --check (all steps), --venue=X (all steps; step 3 space-style),
 * --limit=N (steps 1–2), --limit-groups=N (step 3).
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { dbQuery } from '../lib/performance-db.js';
import { runScript } from '../lib/script-lifecycle.js';

export interface Step { name: string; args: string[] }

export interface SpawnResult { status: number | null; error?: Error }
export type Spawner = (cmd: string, args: string[], opts: { stdio: 'inherit' }) => SpawnResult;

const dist = (f: string): string => path.resolve(__dirname, f);

export function buildSteps(argv: string[]): Step[] {
  const check = argv.includes('--check');
  const venue = argv.find((a) => a.startsWith('--venue='))?.split('=')[1];
  const limit = argv.find((a) => a.startsWith('--limit='))?.split('=')[1];
  const limitGroups = argv.find((a) => a.startsWith('--limit-groups='))?.split('=')[1];

  const fundingFlags = [
    ...(venue ? [`--venue=${venue}`] : []),
    ...(limit ? [`--limit=${limit}`] : []),
    ...(check ? ['--check'] : []),
  ];
  // backfill-directional-labels.ts parses space-separated flag values.
  const labelFlags = [
    ...(venue ? ['--venue', venue] : []),
    ...(limitGroups ? ['--limit-groups', limitGroups] : []),
    ...(check ? ['--check'] : []),
  ];

  return [
    { name: 'raw-incremental', args: [dist('backfill-funding-episodes.js'), 'raw', '--since-checkpoint', ...fundingFlags] },
    { name: 'episodes-close', args: [dist('backfill-funding-episodes.js'), 'episodes', '--reclose-censored', ...fundingFlags] },
    { name: 'directional-labels', args: [dist('backfill-directional-labels.js'), ...labelFlags] },
  ];
}

export function runSteps(argv: string[], spawn: Spawner = spawnSync as unknown as Spawner): number {
  const t0 = Date.now();
  for (const step of buildSteps(argv)) {
    const s = Date.now();
    console.log(`[nightly-carry-labeler] STEP ${step.name} START`);
    const res = spawn(process.execPath, step.args, { stdio: 'inherit' });
    if (res.error || res.status !== 0) {
      console.error(
        `[nightly-carry-labeler] STEP ${step.name} FAILED (exit ${res.status ?? 'spawn-error'}${res.error ? `: ${res.error.message}` : ''}) — aborting run; cron retries next night`,
      );
      return 1;
    }
    console.log(`[nightly-carry-labeler] STEP ${step.name} OK (${Math.round((Date.now() - s) / 1000)}s)`);
  }
  console.log(`[nightly-carry-labeler] ALL 3 LABEL STREAMS OK (${Math.round((Date.now() - t0) / 1000)}s)`);
  return 0;
}

// EDGE-CARRY-SERVING-W2 R3 — housekeeping: prune carry_divergence_log rows older than the window.
// Idempotent + fail-SOFT: a retention error NEVER fails the label run (housekeeping, logged only).
export const DIVERGENCE_RETENTION_DAYS = 90;
type RetentionQuery = (sql: string, params?: unknown[]) => Promise<unknown[]>;
export async function sweepDivergenceRetention(query: RetentionQuery = dbQuery as RetentionQuery): Promise<number> {
  try {
    const deleted = await query(
      `DELETE FROM carry_divergence_log WHERE scan_ts < now() - make_interval(days => $1) RETURNING id`,
      [DIVERGENCE_RETENTION_DAYS],
    );
    const n = Array.isArray(deleted) ? deleted.length : 0;
    console.log(`[nightly-carry-labeler] STEP divergence-retention OK (pruned ${n} rows older than ${DIVERGENCE_RETENTION_DAYS}d)`);
    return n;
  } catch (e) {
    console.error(`[nightly-carry-labeler] STEP divergence-retention FAILED (non-fatal): ${String((e as Error).message ?? e).slice(0, 160)}`);
    return -1;
  }
}

export async function main(argv: string[]): Promise<number> {
  const labelStatus = runSteps(argv);
  // Runs regardless of the label-stream status but NEVER changes the exit code; skipped on --check.
  if (!argv.includes('--check')) await sweepDivergenceRetention();
  return labelStatus;
}

if (require.main === module) {
  // OPS-SCRIPT-EXIT-LIFECYCLE-W1: this tail already exited on the success path,
  // yet still produced zombies (observed 1d00h elapsed at 0:00 CPU) because
  // `main()` itself never settled — no tail fix can catch that. runScript's
  // watchdog bounds the process regardless. Numeric resolve is kept as exit code.
  void runScript('nightly-carry-labeler', () => main(process.argv.slice(2)));
}
