/**
 * CALL-REGIME-WEBHOOK-LAYER-W1 (2026-05-29): webhook event detection.
 *
 * Turns a freshly-recorded call row (BUY/SELL insert into `signals`) into
 * deliverable webhook events, fans them out to matching active subscriptions,
 * and enqueues idempotent deliveries. Called fire-and-forget from
 * performance-db.recordSignal() behind WEBHOOK_DELIVERY_ENABLED.
 *
 * Scope (Mr.1/Cowork-ratified 2026-05-29): the post-insert hook is sufficient.
 * A 30-day prod probe found RANGING rows are ~32% of all calls (8,270 in 7d),
 * so BUY/SELL calls fire frequently enough in hostile regimes that transitions
 * INTO RANGING are caught promptly — no standalone regime poller needed this
 * wave. (VOLATILE is currently never emitted by the classifier; the detectable
 * regimes are TRENDING_UP / TRENDING_DOWN / RANGING.) HOLD calls never reach
 * recordSignal (they go to hold_counts), so HOLD trade_call events are a
 * documented follow-up, not this wave.
 *
 * MUST NOT: perform HTTP (that is webhook-delivery.ts); mutate `signals`.
 */
import { dbQuery } from './performance-db.js';
import {
  listActiveSubscriptions,
  enqueueDelivery,
  type WebhookSubscription,
  type WebhookEventType,
  type WebhookEventData,
} from './webhooks-store.js';
import { getTopCoinSet, type ScanExchangeId } from './trade-call-scanner.js';

export interface SignalRecordedParams {
  coin: string;
  signal: string;        // verdict: BUY | SELL | HOLD
  confidence: number;
  timeframe: string;
  exchange: string;
  priceAtSignal: number;
  signalHash: string | null;
  regime: string | null;
  createdAt: number;     // epoch seconds
}

export interface DetectedEvent {
  type: WebhookEventType;
  eventId: string;
  data: WebhookEventData;
}

const DEFAULT_REGIME_COOLDOWN_SEC = 3600;

/** Parse a positive-int env with default-deny on NaN/≤0 (CLAUDE.md default-deny). */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Most recent regime for (coin, timeframe, exchange) from a row OTHER than the
 * one just inserted (excluded by its unique signal_hash). Returns null when
 * there is no prior row or its regime is null.
 */
async function getPreviousRegime(
  coin: string,
  timeframe: string,
  exchange: string,
  excludeSignalHash: string | null,
): Promise<string | null> {
  const rows = await dbQuery<{ regime: string | null }>(
    `SELECT regime FROM signals
       WHERE coin = ? AND timeframe = ? AND exchange = ?
         AND (signal_hash IS NULL OR signal_hash <> ?)
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    [coin, timeframe, exchange, excludeSignalHash ?? '__none__'],
  );
  if (rows.length === 0) return null;
  return rows[0].regime ?? null;
}

/**
 * Per-(coin,tf,exchange) debounce: true if a regime_shift delivery for this
 * tuple was enqueued within `cooldownSec`. Uses the delivery ledger as the
 * cooldown state (no extra table); only meaningful when subscribers exist.
 */
async function regimeShiftInCooldown(
  coin: string,
  timeframe: string,
  exchange: string,
  cooldownSec: number,
): Promise<boolean> {
  const since = Math.floor(Date.now() / 1000) - cooldownSec;
  const prefix = `regime:${coin}:${timeframe}:${exchange}:%`;
  const rows = await dbQuery<{ one: number }>(
    `SELECT 1 AS one FROM webhook_deliveries
       WHERE event_type = 'regime_shift' AND event_id LIKE ? AND created_at >= ?
       LIMIT 1`,
    [prefix, since],
  );
  return rows.length > 0;
}

/** Build the allow-listed event-data snapshot (no forbidden Phase-E keys). */
function buildEventData(
  type: WebhookEventType,
  p: SignalRecordedParams,
  priorRegime: string | null,
): WebhookEventData {
  return {
    type,
    coin: p.coin,
    timeframe: p.timeframe,
    exchange: p.exchange,
    call: p.signal,
    confidence: p.confidence,
    regime: p.regime,
    ...(type === 'regime_shift' ? { prior_regime: priorRegime } : {}),
    price_at_call: p.priceAtSignal,
    signal_hash: p.signalHash,
    created_at: p.createdAt,
  };
}

/** Detect the events implied by a just-recorded call row. */
export async function detectEvents(p: SignalRecordedParams): Promise<DetectedEvent[]> {
  const events: DetectedEvent[] = [];

  // trade_call: BUY/SELL only. HOLD never reaches recordSignal (hold_counts).
  if (p.signal === 'BUY' || p.signal === 'SELL') {
    if (p.signalHash) {
      events.push({
        type: 'trade_call',
        eventId: `call:${p.signalHash}`,
        data: buildEventData('trade_call', p, null),
      });
    }
  }

  // regime_shift: previous non-null regime for the tuple differs from this one.
  if (p.regime) {
    const prior = await getPreviousRegime(p.coin, p.timeframe, p.exchange, p.signalHash);
    if (prior && prior !== p.regime) {
      const cooldownSec = envInt('WEBHOOK_REGIME_COOLDOWN_SEC', DEFAULT_REGIME_COOLDOWN_SEC);
      const debounced = await regimeShiftInCooldown(p.coin, p.timeframe, p.exchange, cooldownSec);
      if (!debounced) {
        events.push({
          type: 'regime_shift',
          eventId: `regime:${p.coin}:${p.timeframe}:${p.exchange}:${p.createdAt}`,
          data: buildEventData('regime_shift', p, prior),
        });
      }
    }
  }

  return events;
}

// SCAN-TRADE-CALLS-W1 C4: a `top:N` asset token (N=1..100) matches any coin in
// the event venue's current top-N-by-OI set. Canonical lowercase form, validated
// at POST time (webhook-api.ts).
const TOP_TOKEN_RE = /^top:([1-9][0-9]?|100)$/;
const PROMOTED_VENUES: ReadonlySet<string> = new Set(['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET']);

/**
 * Does a subscription want this event (type + asset/timeframe/min_confidence)?
 *
 * `topSets` (pre-resolved once per event by onSignalRecorded — D1, keeps this a
 * sync hot-path predicate, no await per subscription) maps each `top:N` token's
 * N to the event venue's top-N coin set. A token matches when the event coin is
 * in its set; an unresolved token (shadow-venue event, or a universe fetch that
 * failed) never matches (fail-quiet). Plain coin entries keep exact-match
 * semantics — with no tokens + no topSets this is byte-identical to before.
 */
export function subscriptionMatches(
  sub: WebhookSubscription,
  ev: DetectedEvent,
  topSets?: ReadonlyMap<number, ReadonlySet<string>>,
): boolean {
  if (!sub.events.includes(ev.type)) return false;
  if (sub.assets && sub.assets.length > 0) {
    const assetMatch = sub.assets.some((entry) => {
      const m = TOP_TOKEN_RE.exec(entry);
      if (m) {
        const set = topSets?.get(Number(m[1]));
        return set ? set.has(ev.data.coin) : false;
      }
      return entry === ev.data.coin;
    });
    if (!assetMatch) return false;
  }
  if (sub.timeframes && sub.timeframes.length > 0 && !sub.timeframes.includes(ev.data.timeframe)) return false;
  if (sub.min_confidence != null) {
    const conf = ev.data.confidence;
    if (conf == null || conf < sub.min_confidence) return false;
  }
  return true;
}

/**
 * Pre-resolve every distinct `top:N` token referenced by the active
 * subscriptions into the event venue's top-N coin set — ONCE per event, so the
 * sync matcher needs no awaits. Shadow-venue events resolve nothing (no token
 * ever matches them). A universe-fetch failure is swallowed (that token stays
 * unresolved → non-matching; NO delivery storm, NO alert).
 */
async function resolveTopSetsForEvent(
  ev: DetectedEvent,
  subs: WebhookSubscription[],
): Promise<Map<number, Set<string>>> {
  const resolved = new Map<number, Set<string>>();
  if (!PROMOTED_VENUES.has(ev.data.exchange)) return resolved; // shadow venue → tokens never match
  const ns = new Set<number>();
  for (const sub of subs) {
    if (!sub.assets) continue;
    for (const entry of sub.assets) {
      const m = TOP_TOKEN_RE.exec(entry);
      if (m) ns.add(Number(m[1]));
    }
  }
  for (const n of ns) {
    try {
      const coins = await getTopCoinSet(ev.data.exchange as ScanExchangeId, n);
      resolved.set(n, new Set(coins));
    } catch (err) {
      console.debug(
        `[webhook-events] top:${n} resolve failed for ${ev.data.exchange}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return resolved;
}

/**
 * Post-insert entry point (fire-and-forget from recordSignal). Detects events,
 * fans out to matching active subscriptions, and idempotently enqueues
 * deliveries. Never throws — logs and swallows so a webhook failure can never
 * affect a signal write.
 */
export async function onSignalRecorded(p: SignalRecordedParams): Promise<void> {
  if (process.env.WEBHOOK_DELIVERY_ENABLED !== 'true') return; // double-guard
  try {
    const events = await detectEvents(p);
    if (events.length === 0) return;

    const subs = await listActiveSubscriptions();
    if (subs.length === 0) return;

    for (const ev of events) {
      // D1: resolve top:N sets once per event so the matcher stays sync.
      const topSets = await resolveTopSetsForEvent(ev, subs);
      for (const sub of subs) {
        if (!subscriptionMatches(sub, ev, topSets)) continue;
        await enqueueDelivery({
          subscriptionId: sub.id,
          eventId: ev.eventId,
          eventType: ev.type,
          eventData: ev.data,
        });
      }
    }
  } catch (err) {
    console.error('[webhook-events] onSignalRecorded error:', err instanceof Error ? err.message : err);
  }
}
