/**
 * graceful-stop.ts — OPS-LABEL-FRESHNESS-W1 R2 (A1 mechanism 3: deploy-kill survival).
 *
 * A cooperative stop flag driven by SIGTERM/SIGINT. The long venue-rotation loop polls
 * isStopRequested() at every venue/group BOUNDARY and exits cleanly (like a budget
 * expiry) instead of being decapitated mid-venue. Because the labeler commits per group
 * with ON CONFLICT DO NOTHING and resumes from DB state, a boundary stop loses at most the
 * in-flight group — so the deploy container-recreate that killed the 07-23 run (A1: it
 * reached only 4 of 17 venues before the 03:49 OPS-VENUE-GO-LIVE-15-W1 recreate) becomes a
 * clean checkpoint. The deploy step SIGTERMs the running labeler before `docker compose up`.
 *
 * Installing a SIGTERM handler suppresses the default terminate — intentional: the process
 * now finishes the in-flight group and exits, rather than dropping it. The lifecycle
 * watchdog (OPS-SCRIPT-EXIT-LIFECYCLE-W1) still bounds the pathological "never reaches a
 * boundary" case, so this cannot wedge a process open.
 */

let stopRequested = false;
let installed = false;

export function isStopRequested(): boolean {
  return stopRequested;
}

/** Idempotent — first call flips the flag and logs; repeats are silent. */
export function requestStop(reason = 'manual'): void {
  if (stopRequested) return;
  stopRequested = true;
  console.error(`[graceful-stop] stop requested (${reason}) — checkpointing at the next venue/group boundary`);
}

/** Install SIGTERM/SIGINT → requestStop. Idempotent. Call once inside require.main guards. */
export function installGracefulStop(signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT']): void {
  if (installed) return;
  installed = true;
  for (const sig of signals) process.on(sig, () => requestStop(sig));
}

/** Test seam — reset module state between cases. */
export function _resetGracefulStopForTest(): void {
  stopRequested = false;
  installed = false;
}
