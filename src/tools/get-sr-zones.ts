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
 *
 * Failures (R7 #2, #4). A window with no candles is never cached. A failed full read (an unknown coin, a throttled or
 * empty read) is remembered for 20 to 30 s (jittered), and a repeat call inside that time gets the same `unserved`
 * reason with no venue request. History pages read in the batch weight class (see fetchWindow).
 *
 * Load-timeout (R8). A call waits at most 10 s for a full read; past that, the timeframe is `unserved` for that call
 * (unbilled, not remembered as a failure) while the read finishes in the background, single-flight, and caches its
 * window (or has its failure remembered) for the next call. See boundedWait.
 *
 * Served edges (SR-ZONES-W2 §0.1–§0.2 as R7 #3 amends it). Every zone's low and high are rounded outward to one step
 * per call, from the response's price and the venue's price tick (src/lib/sr-zones/rounding.ts), once, where the
 * response is built (src/lib/sr-zones/served.ts). The served zone is the zone: distance_pct, the price_inside_zone flag
 * and the summary's range, "inside" and distance read the served edges. Selection, order, side, state, broke_at,
 * touches, no_zone_above / no_zone_below and overlaps stay on the computed zone exactly as T1. The tick is Binance's
 * PRICE_FILTER from one exchangeInfo read shared by every coin for 24 h (batch class); a failed, unknown or
 * slower-than-2-s tick read serves the call with the significant-figure step.
 */
import type { Candle, LicenseInfo, QuotaState } from '../types.js';
import { getAdapter } from '../lib/exchange-adapter.js';
import { assembleServingWindow } from '../lib/adapters/_history-plan.js';
import { intervalMsFor } from '../lib/candle-guard.js';
import { TRADE_CALL_CANDLE_COUNT } from '../lib/serving-windows.js';
import { StaleUpstreamWindowError, TimeframeUnservedError, UpstreamRateLimitError, VenueMarketClosedError } from '../lib/errors.js';
import { runAsBatch, WeightBudgetSkipError } from '../lib/upstream-weight-budget.js';
import { processScopedTag } from '../lib/caller-tags.js';
import { checkQuota, trackCall, getRequestSessionId } from '../lib/license.js';
import { referralCodeForKey } from '../lib/referral-store.js';
import { buildScanQuotaWall, buildScanQuotaState, type ScanQuotaWallBody } from '../lib/scan-shared.js';
import { withAuthState } from '../lib/tier-warning.js';
import { PKG_VERSION } from '../lib/pkg-version.js';
import { SR_ZONES_PARAMS } from '../lib/sr-zones/params.js';
import { computeSrZones, attachSrZoneOverlaps, type SrZone, type SrZoneFlag, type SrZonesFrame } from '../lib/sr-zones/zones.js';
import { SR_ZONES_NOTE, SR_ZONES_ORDER, buildSrZonesSummary } from '../lib/sr-zones/summary.js';
import { priceLevelStep } from '../lib/sr-zones/rounding.js';
import { serveSrZonesFrame } from '../lib/sr-zones/served.js';

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
/** A failed full read answers repeat calls for this long plus up to half again (jitter), with no venue request (R7 #2). */
const FAILED_READ_TTL_MS = 20_000;
/** Failed reads remembered at once (the key holds a caller-chosen coin); past this the oldest is dropped first. */
const MAX_FAILED_READS = 1024;
/** A call waits this long for a full read; past it the timeframe is unserved for that call and the read goes on (R8). */
const FULL_READ_TIMEOUT_MS = 10_000;
/** A call waits this long for the venue tick once its windows are in; past it the step is sig and the read goes on. */
const PRICE_TICK_WAIT_MS = 2_000;

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
  /** venue × coin × timeframe → what the last full read threw, and until when that answers instead of a new read. */
  failures: Map<string, { error: unknown; untilMs: number }>;
  /** SR-ZONES-W2: the venue's price tick for the coin, null when unknown; the step falls back to sig without it. */
  getPriceTick: (coin: string) => Promise<number | null>;
}

export const DEFAULT_SR_ZONES_DEPS: SrZonesDeps = {
  getCandles: (coin, timeframe, startTime, endTime) => getAdapter(VENUE).getCandles(coin, timeframe, startTime, undefined, endTime),
  nowMs: () => Date.now(),
  cache: new Map(),
  failures: new Map(),
  // One exchangeInfo read serves every coin for 24 h; it reads in the batch class, like the history pages, so a cold
  // read never spends the interactive reserve. processScopedTag, not a literal: the handler has 3 entrypoints.
  getPriceTick: (coin) =>
    runAsBatch(async () => (await getAdapter(VENUE).getPriceTick?.(coin)) ?? null, processScopedTag('get_sr_zones')),
};

/** Concurrent reads of one key share one read: `<key>#full` for the whole window, `<key>#head` for the newest page. */
const inflight = new WeakMap<Map<string, SrZonesWindow>, Map<string, Promise<SrZonesWindow>>>();

/** A full read that came back with no candles at all: there is nothing to serve, so nothing is cached (R7 #4). */
class EmptyCandleWindowError extends Error {
  constructor() {
    super(`${VENUE} returned no candles`);
    this.name = 'EmptyCandleWindowError';
  }
}

/** This call stopped waiting for a full read that is still running. Not a failure: nothing is remembered (R8). */
class FullReadTimeoutError extends Error {
  constructor() {
    super(`${VENUE} full read still running after ${FULL_READ_TIMEOUT_MS} ms`);
    this.name = 'FullReadTimeoutError';
  }
}

/**
 * A call's wait on a shared full read, bounded at FULL_READ_TIMEOUT_MS (R8; the build-and-runtime load-timeout, not a
 * throw-only fallback, which never fires while the batch lane WAITS for capacity). Past the bound this call throws
 * FullReadTimeoutError and the read goes on in the background, still single-flight: it caches its window, or its
 * failure is remembered (R7 #2), for the next call. The timer resolves (it never rejects) and is cleared when the read
 * wins; a rejection of the read after the bound is handled, because Promise.race subscribed to it.
 */
async function boundedWait(read: Promise<SrZonesWindow>): Promise<SrZonesWindow> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), FULL_READ_TIMEOUT_MS);
  });
  try {
    const first = await Promise.race([read, bound]);
    if (first === null) throw new FullReadTimeoutError();
    return first;
  } finally {
    clearTimeout(timer);
  }
}

const ident = (): SrZonesIdentity => ({ tool: GET_SR_ZONES_TOOL, version: PKG_VERSION, session_id: getRequestSessionId() ?? null });

/** The tick read, which never rejects: a failed, throwing or unusable read is "no tick". */
function readPriceTick(deps: SrZonesDeps, coin: string): Promise<number | null> {
  return Promise.resolve()
    .then(() => deps.getPriceTick(coin))
    .then(
      (t) => (typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : null),
      () => null,
    );
}

/** The tick, waited for at most PRICE_TICK_WAIT_MS; a read still running then answers null and goes on (shared cache). */
async function tickWithin(read: Promise<number | null>): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), PRICE_TICK_WAIT_MS);
  });
  try {
    return await Promise.race([read, bound]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One timeframe's window, newest WINDOW_BARS candles, ascending. The head page is a serving read (no endTime) of the
 * trade_call@100 window src/lib/serving-windows.ts already declares on every timeframe, so the getAdapter seam checks
 * its head and contract-suite S tests this exact read on every venue. Older candles come from history pages
 * (endTime set) stepping back 200 candles at a time, assembled by the shared serving-window assembler. Binance answers
 * a history page with 200 candles from startTime (endTime ignored), so a gap inside the page also comes back short:
 * a short page is not the listing start (R9 #2). Only a page that adds no older candle ends the walk; with the
 * assembler's no-progress stop and MAX_PAGES that costs a young listing one extra request at most. A read with no
 * candles at all throws, so it is never cached.
 *
 * Weight classes (R7 #2): the head page reads in the caller's class (interactive for an MCP call). Every history page
 * reads in the batch class under `get_sr_zones`, so it spends only the Binance weight the interactive reserve leaves
 * and never get_trade_call's share. A history page the budget or Binance throttles fails the whole window.
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
      const page = await runAsBatch(
        () => deps.getCandles(coin, timeframe, oldestOpenMs - PAGE_BARS * stepMs, oldestOpenMs - 1),
        processScopedTag('get_sr_zones'),
      );
      const older = page.filter((c) => c.time < oldestOpenMs);
      return { bars: older, exhausted: older.length === 0 };
    },
  });
  if (bars.length === 0) throw new EmptyCandleWindowError();
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
  // A cached window with no candles has no tail to merge a newer page over, so it goes to a full read (R7 #4).
  if (hit && hit.candles.length > 0 && now < hit.validUntilMs) {
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
  // A full read that failed moments ago answers again with the same failure, and no venue request (R7 #2).
  const failed = deps.failures.get(key);
  if (failed && now < failed.untilMs) throw failed.error;
  // The store and the failure record live inside the shared read, so they happen whether or not a caller still waits.
  return boundedWait(shared(deps, `${key}#full`, () =>
    fetchWindow(deps, coin, timeframe, stepMs).then(
      (w) => {
        for (const [k, v] of deps.cache) if (v.validUntilMs <= w.readAtMs) deps.cache.delete(k);
        deps.cache.delete(key);
        deps.cache.set(key, w);
        // Map order is insertion order, so the first key is the oldest read.
        while (deps.cache.size > MAX_CACHED_WINDOWS) deps.cache.delete(deps.cache.keys().next().value as string);
        return w;
      },
      (err: unknown) => {
        const at = deps.nowMs();
        for (const [k, v] of deps.failures) if (v.untilMs <= at) deps.failures.delete(k);
        deps.failures.delete(key);
        // Jittered, so failures that land together are not all read again in the same instant.
        deps.failures.set(key, { error: err, untilMs: at + FAILED_READ_TTL_MS * (1 + Math.random() / 2) });
        while (deps.failures.size > MAX_FAILED_READS) deps.failures.delete(deps.failures.keys().next().value as string);
        throw err;
      },
    ),
  ));
}

/** Why a timeframe was not served, from what its read threw; `transient` when a retry can change the answer. */
function unservedReason(err: unknown, coin: string): { reason: string; transient: boolean } {
  if (err instanceof TimeframeUnservedError) return { reason: `${VENUE} does not serve this timeframe`, transient: false };
  if (err instanceof VenueMarketClosedError) return { reason: `${VENUE} has the ${coin} market closed`, transient: false };
  if (err instanceof StaleUpstreamWindowError) {
    return { reason: `${VENUE} served a candle window that ends ${err.headGapBars} closed candles before now`, transient: true };
  }
  if (err instanceof UpstreamRateLimitError) return { reason: `${VENUE} is rate-limiting requests`, transient: true };
  if (err instanceof WeightBudgetSkipError) {
    return { reason: `${VENUE} candle history was skipped: the shared request budget was full`, transient: true };
  }
  if (err instanceof EmptyCandleWindowError) return { reason: `${VENUE} returned no candles for this timeframe`, transient: true };
  if (err instanceof FullReadTimeoutError) {
    return { reason: `${VENUE} candle history did not load within ${FULL_READ_TIMEOUT_MS / 1000} s; the read continues in the background`, transient: true };
  }
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

  // The venue tick behind the step, read alongside the windows (it is cached for 24 h; see tickWithin).
  const tickRead = readPriceTick(deps, coin);

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

  const frames: Array<{ timeframe: string } & SrZonesFrame> = [];
  if (freshest && price !== undefined) {
    for (const { timeframe, stepMs, window } of windows) {
      const closed = window.candles.filter((c) => c.time + stepMs <= window.readAtMs);
      const computed = computeSrZones(closed, closed.length - 1, price);
      if (!computed.ok) {
        unserved.push({ timeframe, reason: computed.reason });
        continue;
      }
      frames.push({ timeframe, ...computed.frame });
    }
  }
  unserved.sort((a, b) => timeframes.indexOf(a.timeframe) - timeframes.indexOf(b.timeframe));

  // 3. Nothing served → refused, unbilled.
  if (frames.length === 0 || freshest === null || price === undefined) {
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

  // 4. Overlaps on the computed edges (§0.2), then the served frame: edges rounded outward once, one step for the call,
  //    from the response's price and the venue tick (§0.1); the distance, the inside flag and the summary read those
  //    served edges (R7 #3). Bill and answer.
  attachSrZoneOverlaps(frames);
  const step = priceLevelStep(price, await tickWithin(tickRead));
  const results: SrZonesTimeframeResult[] = frames.map((f) => {
    const served = serveSrZonesFrame(f, price, step);
    return {
      timeframe: f.timeframe,
      summary: buildSrZonesSummary(coin, f.timeframe, price, served),
      volume_vs_20: served.volume_vs_20,
      flags: served.flags,
      support: served.support,
      resistance: served.resistance,
    };
  });
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
