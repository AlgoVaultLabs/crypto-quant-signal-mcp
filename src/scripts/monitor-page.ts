/**
 * OPS-DIGEST-DELIVERY-DURABLE-W1 CH1 — the monitor's page step: a page is MARKED only
 * when it was DELIVERED.
 *
 * `runCritical` used to do `await sendAlert(msg, level); markAlerted(state, key);` — the
 * boolean was discarded, so a page Telegram never accepted opened the 30-minute dedup
 * window exactly as if the operator had read it, and the next re-fire was 30 minutes
 * away instead of 2. `firePage` makes "alerted" mean "delivered".
 *
 * It sends on the default `serving` profile on purpose: the next 2-minute tick IS this
 * step's retry, so a page must never block the tick on an in-process backoff.
 *
 * The pure state helpers moved here with it (unchanged) so this module never imports
 * `monitor.ts` back — `monitor.ts` runs `main()` behind its entrypoint guard and this
 * stays a leaf a suite can execute directly.
 */
import { sendAlert, redactBotToken } from '../lib/telegram.js';

/** 30 minutes — moved verbatim from monitor.ts; the value is unchanged. */
export const DEDUP_WINDOW_MS = 30 * 60 * 1000;

export interface AlertState {
  lastAlerted: Record<string, number>;
  // Number of consecutive cron cycles each check has failed. Resets to
  // 0 the moment the check passes again. Persists across cron runs in
  // STATE_FILE; resets to {} on container restart (deploy) — that's
  // intentional, prevents stale pre-deploy counters from firing
  // spurious post-deploy alerts.
  consecutiveFails: Record<string, number>;
}

export function shouldAlert(state: AlertState, key: string): boolean {
  const last = state.lastAlerted[key] ?? 0;
  return Date.now() - last > DEDUP_WINDOW_MS;
}

export function markAlerted(state: AlertState, key: string): void {
  state.lastAlerted[key] = Date.now();
}

export type PageLevel = 'critical' | 'warning' | 'info';

/**
 * Send one page. `true` ⇒ delivered and marked; `false` ⇒ NOT marked, the consecutive
 * counter is left exactly as the caller set it, and the next cycle re-fires. A sender
 * that throws counts as undelivered — a page step must never crash the tick.
 */
export async function firePage(args: {
  state: AlertState;
  key: string;
  msg: string;
  level: PageLevel;
  send?: (msg: string, level: PageLevel) => Promise<boolean>;
}): Promise<boolean> {
  const send = args.send ?? sendAlert;
  let delivered = false;
  try {
    delivered = await send(args.msg, args.level);
  } catch (err) {
    console.error(`[monitor] page sender threw for ${args.key}: ${redactBotToken((err as Error)?.message ?? String(err))}`);
    delivered = false;
  }
  if (delivered) {
    markAlerted(args.state, args.key);
    return true;
  }
  console.log(`[monitor] PAGE_UNDELIVERED ${args.key} — re-fires next cycle`);
  return false;
}
