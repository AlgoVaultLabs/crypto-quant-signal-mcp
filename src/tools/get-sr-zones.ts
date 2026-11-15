/**
 * get-sr-zones.ts — SR-ZONES-W1 CH2. The get_sr_zones handler: Binance perpetual candles → the zone formula
 * (src/lib/sr-zones) → the §0 response. Facts only; MCP only; dispatched by the tool-call pipeline.
 *
 * Order — every refusal is unbilled:
 *   1. Quota wall: checkQuota → buildScanQuotaWall (429), the envelope scan_trade_calls and scan_market_regimes render.
 *   2. Per requested timeframe (deduplicated, request order): the candle window from the per-bar cache, else from
 *      Binance (see fetchWindow). A timeframe that cannot be served goes to `unserved` with its reason and is not billed.
 *   3. No timeframe served → refused (`no_timeframe_served`), 0 units.
 *   4. trackCall(license, served timeframes) → `_algovault` with buildScanQuotaState.
 *
 * Price. `price` is the close of the newest candle in the freshest window used (the forming candle when the venue
 * serves it), and `timestamp` (unix seconds) is when that window's newest page was read. The candle history is cached
 * per venue × coin × timeframe until that timeframe's next candle close (R5 Q3). Inside that candle a read less than
 * 60 s old is served as is (no venue request); an older one first re-reads the newest page (one getCandles call, the
 * trade_call 100-candle window) and merges it over the cached tail, so the price stays live. A failed re-read serves
 * the cached window with its older timestamp, never as unserved. The full history is never re-read inside a candle.
 */
import type { Candle, LicenseInfo, QuotaState } from '../types.js';
import { getAdapter } from '../lib/exchange-adapter.js';
import { assembleServingWindow } from '../lib/adapters/_history-plan.js';
import { intervalMsFor } from '../lib/candle-guard.js';
import { TRADE_CALL_CANDLE_COUNT } from '../lib/serving-windows.js';
import { StaleUpstreamWindowError, TimeframeUnservedError, UpstreamRateLimitError, VenueMarketClosedError } from '../lib/errors.js';
import { checkQuota, trackCall, getRequestSessionId } from '../lib/license.js';
import { referralCodeForKey } from '../lib/referral-store.js';
import { buildScanQuotaWall, buildScanQuotaState, type ScanQuotaWallBody } from '../lib/scan-shared.js';
import { withAuthState } from '../lib/tier-warning.js';
import { PKG_VERSION } from '../lib/pkg-version.js';
import { SR_ZONES_PARAMS } from '../lib/sr-zones/params.js';
import { computeSrZones, attachSrZoneOverlaps, type SrZone, type SrZoneFlag } from '../lib/sr-zones/zones.js';
import { SR_ZONES_NOTE, SR_ZONES_ORDER, buildSrZonesSummary } from '../lib/sr-zones/summary.js';

const GET_SR_ZONES_TOOL = 'get_sr_zones' as const;
const VENUE = 'BINANCE' as const;
/** Binance klines answer at most 200 candles per request (the adapter's limit). */
const PAGE_BARS = 200;
/** Candles a full window holds: H closed candles and the forming one. */
const WINDOW_BARS = SR_ZONES_PARAMS.historyBars + 1;
/** The head page, then enough 200-candle history pages to reach WINDOW_BARS, plus one page of slack. */
const MAX_PAGES = 1 + Math.ceil((WINDOW_BARS - TRADE_CALL_CANDLE_COUNT) / PAGE_BARS) + 1;
/** Windows held at once (~100 KB each); past this the oldest read is dropped first. */
const MAX_CACHED_WINDOWS = 256;
/** A cached window whose newest page is at least this old re-reads that page before it is served (R5 Q3). */
const HEAD_REFRESH_MS = 60_000;

export interface GetSrZonesParams {
  coin: string;
  timeframes: string[];
  venue?: string;
}

export interface SrZonesTimeframeResult {
  timeframe: string;
  summary: string;
  volume_vs_20: number | null;
  flags: SrZoneFlag[];
  support: SrZone[];
  resistance: SrZone[];
}

export interface SrZonesUnserved {
  timeframe: string;
  reason: string;
}

interface SrZonesIdentity {
  tool: typeof GET_SR_ZONES_TOOL;
  version: string;
  session_id: string | null;
}

export interface GetSrZonesResponse {
  coin: string;
  venue: typeof VENUE;
  price: number;
  order: string;
  note: string;
  results: SrZonesTimeframeResult[];
  unserved: SrZonesUnserved[];
  timestamp: number;
  _algovault: SrZonesIdentity & { quota: QuotaState };
}

export type GetSrZonesRefusal =
  | (ScanQuotaWallBody & { _algovault: SrZonesIdentity })
  | {
      error: 'no_timeframe_served';
      code: 'no_timeframe_served';
      coin: string;
      venue: typeof VENUE;
      message: string;
      unserved: SrZonesUnserved[];
      suggested_action: string;
      _algovault: SrZonesIdentity;
    };

/** The handler's outcome. `status` is the HTTP-equivalent status of a refusal, for the pipeline. */
export type GetSrZonesOutcome =
  | { kind: 'ok'; response: GetSrZonesResponse }
  | { kind: 'refused'; payload: GetSrZonesRefusal; status: number };

/**
 * A cached candle window: every candle read (closed and forming), when its newest page was read, and when its history
 * stops being valid (the timeframe's next candle close after the full read).
 */
export interface SrZonesWindow {
  candles: Candle[];
  readAtMs: number;
  validUntilMs: number;
}

/** What the handler reads besides the formula — a seam, so tests count venue requests and own the cache. */
export interface SrZonesDeps {
  getCandles: (coin: string, timeframe: string, startTime: number, endTime?: number) => Promise<Candle[]>;
  nowMs: () => number;
  /** venue × coin × timeframe → window, valid until the timeframe's next candle close. */
  cache: Map<string, SrZonesWindow>;
}

export const DEFAULT_SR_ZONES_DEPS: SrZonesDeps = {
  getCandles: (coin, timeframe, startTime, endTime) => getAdapter(VENUE).getCandles(coin, timeframe, startTime, undefined, endTime),
  nowMs: () => Date.now(),
  cache: new Map(),
};

/** Concurrent reads of one key share one read: `<key>#full` for the whole window, `<key>#head` for the newest page. */
const inflight = new WeakMap<Map<string, SrZonesWindow>, Map<string, Promise<SrZonesWindow>>>();

const ident = (): SrZonesIdentity => ({ tool: GET_SR_ZONES_TOOL, version: PKG_VERSION, session_id: getRequestSessionId() ?? null });

/**
 * One timeframe's window, newest WINDOW_BARS candles, ascending. The head page is a serving read (no endTime) of the
 * trade_call@100 window src/lib/serving-windows.ts already declares on every timeframe, so the getAdapter seam checks
 * its head and contract-suite S tests this exact read on every venue. Older candles come from history pages
 * (endTime set) stepping back 200 candles at a time, assembled by the shared serving-window assembler; a young
 * listing stops at its first candle.
 */
async function fetchWindow(deps: SrZonesDeps, coin: string, timeframe: string, stepMs: number): Promise<SrZonesWindow> {
  const now = deps.nowMs();
  const first = await deps.getCandles(coin, timeframe, now - TRADE_CALL_CANDLE_COUNT * stepMs);
  const { bars } = await assembleServingWindow({
    first,
    servedStepMs: stepMs,
    from: now - WINDOW_BARS * stepMs,
    nowMs: now,
    maxPages: MAX_PAGES,
    backward: async (oldestOpenMs) => {
      const page = await deps.getCandles(coin, timeframe, oldestOpenMs - PAGE_BARS * stepMs, oldestOpenMs - 1);
      const older = page.filter((c) => c.time < oldestOpenMs);
      return { bars: older, exhausted: older.length < PAGE_BARS };
    },
  });
  return { candles: bars.slice(-WINDOW_BARS), readAtMs: now, validUntilMs: (Math.floor(now / stepMs) + 1) * stepMs };
}

/**
 * The newest page — the same serving read fetchWindow starts with — merged over a cached window's tail. The history and
 * its validity are kept; only `readAtMs` moves. A page that does not reach back to the cached tail would leave a hole,
 * so it is not merged and the cached window stands.
 */
async function refreshHead(deps: SrZonesDeps, coin: string, timeframe: string, stepMs: number, cached: SrZonesWindow): Promise<SrZonesWindow> {
  const now = deps.nowMs();
  const head = await deps.getCandles(coin, timeframe, now - TRADE_CALL_CANDLE_COUNT * stepMs);
  const tail = cached.candles[cached.candles.length - 1];
  if (head.length === 0 || tail === undefined || head[0].time > tail.time) return cached;
  const kept = cached.candles.filter((c) => c.time < head[0].time);
  return { candles: [...kept, ...head].slice(-WINDOW_BARS), readAtMs: now, validUntilMs: cached.validUntilMs };
}

/** One read per flight key at a time; later callers share the running promise. */
function shared(deps: SrZonesDeps, flightKey: string, start: () => Promise<SrZonesWindow>): Promise<SrZonesWindow> {
  let pending = inflight.get(deps.cache);
  if (!pending) {
    pending = new Map();
    inflight.set(deps.cache, pending);
  }
  const running = pending.get(flightKey);
  if (running) return running;
  const read = start().finally(() => pending!.delete(flightKey));
  pending.set(flightKey, read);
  return read;
}

async function windowFor(deps: SrZonesDeps, coin: string, timeframe: string, stepMs: number): Promise<SrZonesWindow> {
  const key = `${VENUE}:${coin}:${timeframe}`;
  const now = deps.nowMs();
  const hit = deps.cache.get(key);
  if (hit && now < hit.validUntilMs) {
    if (now - hit.readAtMs < HEAD_REFRESH_MS) return hit;
    return shared(deps, `${key}#head`, () =>
      refreshHead(deps, coin, timeframe, stepMs, hit).then(
        (w) => {
          // Store it only over the window it was merged from: a full read that landed meanwhile is newer.
          if (w !== hit && deps.cache.get(key) === hit) {
            deps.cache.delete(key);
            deps.cache.set(key, w);
          }
          return w;
        },
        () => hit, // a failed re-read serves the cached window with its older timestamp
      ),
    );
  }
  return shared(deps, `${key}#full`, () =>
    fetchWindow(deps, coin, timeframe, stepMs).then((w) => {
      for (const [k, v] of deps.cache) if (v.validUntilMs <= w.readAtMs) deps.cache.delete(k);
      deps.cache.delete(key);
      deps.cache.set(key, w);
      // Map order is insertion order, so the first key is the oldest read.
      while (deps.cache.size > MAX_CACHED_WINDOWS) deps.cache.delete(deps.cache.keys().next().value as string);
      return w;
    }),
  );
}

/** Why a timeframe was not served, from what its read threw; `transient` when a retry can change the answer. */
function unservedReason(err: unknown, coin: string): { reason: string; transient: boolean } {
  if (err instanceof TimeframeUnservedError) return { reason: `${VENUE} does not serve this timeframe`, transient: false };
  if (err instanceof VenueMarketClosedError) return { reason: `${VENUE} has the ${coin} market closed`, transient: false };
  if (err instanceof StaleUpstreamWindowError) {
    return { reason: `${VENUE} served a candle window that ends ${err.headGapBars} closed candles before now`, transient: true };
  }
  if (err instanceof UpstreamRateLimitError) return { reason: `${VENUE} is rate-limiting requests`, transient: true };
  const message = err instanceof Error ? err.message : String(err);
  if (/\bAPI 400\b/.test(message)) return { reason: `${VENUE} refused the candle request for ${coin} (HTTP 400)`, transient: false };
  return { reason: `${VENUE} candle request failed`, transient: true };
}

/**
 * get_sr_zones: support and resistance zones for one coin on Binance perpetuals, for one to three timeframes.
 */
export async function runGetSrZones(
  params: GetSrZonesParams,
  license: LicenseInfo,
  deps: SrZonesDeps = DEFAULT_SR_ZONES_DEPS,
): Promise<GetSrZonesOutcome> {
  const coin = params.coin.trim().toUpperCase();
  const timeframes = [...new Set(params.timeframes)];

  // 1. Quota wall.
  const entry = checkQuota(license);
  if (!entry.allowed) {
    return {
      kind: 'refused',
      status: 429,
      payload: {
        ...buildScanQuotaWall(GET_SR_ZONES_TOOL, entry, license, referralCodeForKey(license.key)),
        _algovault: withAuthState(ident(), license),
      },
    };
  }

  // 2. Windows, one per timeframe; each failure stays with its timeframe.
  const unserved: SrZonesUnserved[] = [];
  let transient = false;
  const windows: Array<{ timeframe: string; stepMs: number; window: SrZonesWindow }> = [];
  for (const timeframe of timeframes) {
    const stepMs = intervalMsFor(timeframe);
    if (stepMs === null) {
      unserved.push({ timeframe, reason: `${VENUE} does not serve this timeframe` });
      continue;
    }
    try {
      windows.push({ timeframe, stepMs, window: await windowFor(deps, coin, timeframe, stepMs) });
    } catch (err) {
      const why = unservedReason(err, coin);
      transient ||= why.transient;
      unserved.push({ timeframe, reason: why.reason });
    }
  }

  // The response price: the newest candle of the freshest window that holds one.
  const freshest = windows
    .filter((w) => w.window.candles.length > 0)
    .reduce<SrZonesWindow | null>((a, w) => (a === null || w.window.readAtMs > a.readAtMs ? w.window : a), null);
  const price = freshest?.candles[freshest.candles.length - 1]?.close;

  const results: SrZonesTimeframeResult[] = [];
  if (freshest && price !== undefined) {
    for (const { timeframe, stepMs, window } of windows) {
      const closed = window.candles.filter((c) => c.time + stepMs <= window.readAtMs);
      const computed = computeSrZones(closed, closed.length - 1, price);
      if (!computed.ok) {
        unserved.push({ timeframe, reason: computed.reason });
        continue;
      }
      const f = computed.frame;
      results.push({
        timeframe,
        summary: buildSrZonesSummary(coin, timeframe, price, f),
        volume_vs_20: f.volume_vs_20,
        flags: f.flags,
        support: f.support,
        resistance: f.resistance,
      });
    }
  }
  unserved.sort((a, b) => timeframes.indexOf(a.timeframe) - timeframes.indexOf(b.timeframe));

  // 3. Nothing served → refused, unbilled.
  if (results.length === 0 || freshest === null || price === undefined) {
    return {
      kind: 'refused',
      status: transient ? 503 : 422,
      payload: {
        error: 'no_timeframe_served',
        code: 'no_timeframe_served',
        coin,
        venue: VENUE,
        message: `No requested timeframe could be served for ${coin} on ${VENUE} perpetuals.`,
        unserved,
        suggested_action: `Check the coin symbol (e.g. BTC or ETH), or ask for a longer-listed coin or a shorter timeframe; nothing was charged.`,
        _algovault: withAuthState(ident(), license),
      },
    };
  }

  // 4. Bill the served timeframes and answer.
  attachSrZoneOverlaps(results);
  const tracked = trackCall(license, results.length);
  return {
    kind: 'ok',
    response: {
      coin,
      venue: VENUE,
      price,
      order: SR_ZONES_ORDER,
      note: SR_ZONES_NOTE,
      results,
      unserved,
      timestamp: Math.floor(freshest.readAtMs / 1000),
      _algovault: withAuthState(
        {
          tool: GET_SR_ZONES_TOOL,
          version: PKG_VERSION,
          quota: buildScanQuotaState(tracked, license),
          session_id: getRequestSessionId() ?? null,
        },
        license,
      ),
    },
  };
}
