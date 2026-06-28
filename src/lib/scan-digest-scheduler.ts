/**
 * FEATURE-PARITY-CHANNELS-W1 CH2 — scheduled scan-digest producer (MCP side).
 *
 * In-server setInterval (D1; sibling of the webhook delivery worker in index.ts,
 * gated by WEBHOOK_DELIVERY_ENABLED). Each tick finds active scan_digest
 * subscriptions whose CURRENT cadence bucket hasn't been enqueued yet, runs
 * scanTradeCalls ONCE per distinct (exchange,timeframe,topN,minConfidence) tuple
 * (subs sharing params share the scan), builds a scan_digest event per sub, and
 * idempotently enqueues a delivery (eventId = scan_digest:<subId>:<bucketEpoch>).
 *
 * The scheduler does NOT charge quota or deliver — the existing delivery worker
 * drains the pending rows and `deliverOne` charges the owner max(1, non-HOLD) at
 * delivery + pauses an exhausted owner (CH2 quota rule). Idempotency rides the
 * delivery UNIQUE(subscription_id,event_id); a 2nd tick in the same bucket no-ops.
 *
 * Fail-quiet: a scan/enqueue error for one group is logged + skipped, never thrown
 * (a digest failure can't break the server). No Telegram (background producer).
 */
import {
  listActiveSubscriptions,
  enqueueDelivery,
  tryClaimDelivery,
  type WebhookSubscription,
  type ScanDigestWebhookEventData,
} from './webhooks-store.js';
import { scanTradeCalls, SCAN_EXCHANGES, type ScanExchangeId } from './trade-call-scanner.js';
import { cadenceForTimeframe, isValidCadence, scanDigestEventId, type Cadence } from './scan-digest.js';

const DEFAULT_TICK_MS = 300_000; // 5 min — detects a new hourly bucket within 5 min of its start

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function envPositiveInt(name: string, def: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : def;
}

export interface ResolvedDigestSub {
  sub: WebhookSubscription;
  cadence: Cadence;
  timeframe: string;
  exchange: ScanExchangeId;
  topN: number;
  minConfidence: number | undefined;
  eventId: string;
}

/**
 * Resolve a scan_digest subscription's scan params (defaults applied: tf→15m,
 * cadence→cadenceForTimeframe, exchange→BINANCE, topN→20) + its current-bucket
 * eventId. Returns null for a non-scan_digest subscription.
 */
export function resolveDigestSub(sub: WebhookSubscription, now: number): ResolvedDigestSub | null {
  if (!sub.events.includes('scan_digest')) return null;
  const timeframe = sub.timeframe ?? '15m';
  const cadence: Cadence = isValidCadence(sub.cadence) ? sub.cadence : cadenceForTimeframe(timeframe);
  const exchange: ScanExchangeId =
    sub.exchange && (SCAN_EXCHANGES as readonly string[]).includes(sub.exchange)
      ? (sub.exchange as ScanExchangeId)
      : 'BINANCE';
  const topN = sub.top_n ?? 20;
  const minConfidence = sub.min_confidence ?? undefined;
  return { sub, cadence, timeframe, exchange, topN, minConfidence, eventId: scanDigestEventId(sub.id, cadence, now) };
}

/** Group key so subs with identical scan params share ONE scan per tick. */
function scanKey(r: ResolvedDigestSub): string {
  return `${r.exchange}|${r.timeframe}|${r.topN}|${r.minConfidence ?? ''}`;
}

/**
 * One scheduler tick (exported + `now`-parameterised so tests pin the bucket).
 * Returns a summary {due, scans, enqueued} for the log + assertions.
 */
export async function runScanDigestTick(now: number = nowSec()): Promise<{ due: number; scans: number; enqueued: number }> {
  const subs = await listActiveSubscriptions();
  const digestSubs = subs
    .map((s) => resolveDigestSub(s, now))
    .filter((r): r is ResolvedDigestSub => r !== null);
  if (digestSubs.length === 0) return { due: 0, scans: 0, enqueued: 0 };

  // Only subs whose CURRENT bucket hasn't been enqueued are "due" — the pre-check
  // avoids re-scanning a bucket already delivered (enqueueDelivery is the atomic guard).
  const due: ResolvedDigestSub[] = [];
  for (const r of digestSubs) {
    if (await tryClaimDelivery(r.sub.id, r.eventId)) due.push(r);
  }
  if (due.length === 0) return { due: 0, scans: 0, enqueued: 0 };

  const groups = new Map<string, ResolvedDigestSub[]>();
  for (const r of due) {
    const k = scanKey(r);
    const arr = groups.get(k);
    if (arr) arr.push(r);
    else groups.set(k, [r]);
  }

  let scans = 0;
  let enqueued = 0;
  for (const group of groups.values()) {
    const head = group[0];
    try {
      const result = await scanTradeCalls({
        topN: head.topN,
        timeframe: head.timeframe,
        exchange: head.exchange,
        minConfidence: head.minConfidence,
        // SCAN-DIGEST-MCP-PARITY-W1 CH2: project the SAME enriched calls every channel
        // derives from (enrichScanCall) — additive (price/factors/reasoning ride along
        // on calls[]; existing subscribers' parsers are unaffected). Charging is the
        // delivery rule max(1, non-HOLD), independent of enrichment → 0 new units.
        includeReasoning: true,
      });
      scans++;
      for (const r of group) {
        const eventData: ScanDigestWebhookEventData = {
          type: 'scan_digest',
          cadence: r.cadence,
          timeframe: r.timeframe,
          exchange: r.exchange,
          calls: result.calls,
          generated_at: now,
        };
        const enq = await enqueueDelivery({
          subscriptionId: r.sub.id,
          eventId: r.eventId,
          eventType: 'scan_digest',
          eventData,
        });
        if (enq.claimed) enqueued++;
      }
    } catch (err) {
      // fail-quiet: skip this group, never block others / throw (background producer).
      console.error(
        `[scan-digest-scheduler] group failed ${head.exchange}/${head.timeframe}/top${head.topN}:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
  }
  return { due: due.length, scans, enqueued };
}

let schedulerHandle: ReturnType<typeof setInterval> | null = null;

/** Start the cadence scheduler. Idempotent. Mirrors startDeliveryWorker in index.ts. */
export function startScanDigestScheduler(
  intervalMs: number = envPositiveInt('SCAN_DIGEST_TICK_MS', DEFAULT_TICK_MS),
): void {
  if (schedulerHandle) return;
  console.log(`[scan-digest-scheduler] started — ticking every ${intervalMs}ms`);
  schedulerHandle = setInterval(() => {
    runScanDigestTick().catch((err) =>
      console.error('[scan-digest-scheduler] tick error:', err instanceof Error ? err.message : err),
    );
  }, intervalMs);
}

/** Stop the scheduler (test cleanup / graceful shutdown). Idempotent. */
export function stopScanDigestScheduler(): void {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
  }
}
