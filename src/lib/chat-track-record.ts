/**
 * chat-track-record.ts — CHAT-LIVE-SOT-INJECTION-W1.
 *
 * Canonical live-track-record string builder for agent-facing answer
 * surfaces. Born to stop the chat (`chat_knowledge` MCP tool + `/api/chat`)
 * repeating track-record figures baked into the frozen KnowledgeBundle
 * corpus ("56,375 signal calls / 89.4% win rate / 5 exchanges").
 *
 * Fix-at-generator: the block is assembled at ANSWER TIME from the same
 * in-process SoT `/api/performance-public` reads, so every future
 * track-record change flows into chat answers with zero corpus rebuild and
 * zero per-question branching. Any future agent-facing surface that needs a
 * live track-record string imports `getLiveTrackRecordBlock()` rather than
 * re-deriving one (single-derivation rule).
 *
 * Deliberately NOT built on `track-record-snapshot.ts`: that module's warmer
 * re-fetches `/api/performance-public` over HTTP, the self-call this wave
 * avoids. It IS the reference fail-open discipline mirrored here
 * (`STATIC_FALLBACK` + never throw).
 */
import { EXCHANGE_COUNT, getAssetCount } from './capabilities.js';
import { getSignalPerformance } from '../resources/signal-performance.js';

export interface TrackRecordBlockInput {
  totalCalls: number;
  pfeWinRatePct: number;
  exchangeCount: number;
  assetCount: number;
  asOfISO: string;
  live: boolean;
}

/**
 * Monotonic-grow FLOOR, verified against `/api/performance-public` on
 * 2026-07-19 (live that day: 382,434 calls / 91.5% PFE WR / 12 exchanges /
 * 1,336 assets — these sit at or below it, so the floor stays truthful as
 * the counters climb). Every count renders with a trailing `+`, so a floor
 * understates rather than overstates. Only ever surfaces behind a `[STATIC]`
 * label when the live read is unavailable or implausible.
 *
 * TODO: revisit STATIC_FALLBACK floor by 2026-08-02
 */
export const STATIC_FALLBACK: Omit<TrackRecordBlockInput, 'live'> = {
  totalCalls: 381618,
  pfeWinRatePct: 91.5,
  exchangeCount: 12,
  assetCount: 1334,
  asOfISO: '2026-07-19',
};

/** 5-min in-proc TTL — matches `getAssetCount()`; avoids a DB read per chat call. */
const TTL_MS = 5 * 60 * 1000;

let _blockCache: { block: string; fetchedAt: number } | null = null;

/**
 * Deterministic comma grouping. Deliberately not `toLocaleString()` /
 * `Intl.NumberFormat` — those vary with the runtime's ICU build, which would
 * make the formatter's output environment-dependent (and its tests flaky).
 */
function groupThousands(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Pure formatter — no I/O, no clock, no branching on the user's question.
 * Every value is projected straight from `input` (data-driven per the
 * Fix-at-generator LAW).
 */
export function formatTrackRecordBlock(input: TrackRecordBlockInput): string {
  const { totalCalls, pfeWinRatePct, exchangeCount, assetCount, asOfISO, live } = input;
  const prefix = live ? '' : '[STATIC] ';
  const freshness = live ? 'live as of' : 'as of';
  const asOfDate = asOfISO.slice(0, 10);
  return (
    `${prefix}CURRENT TRACK RECORD (authoritative, ${freshness} ${asOfDate}): ` +
    `${groupThousands(totalCalls)}+ signal calls · ` +
    `${pfeWinRatePct.toFixed(1)}% PFE win rate · ` +
    `${groupThousands(exchangeCount)} exchanges · ` +
    `${groupThousands(assetCount)} assets. ` +
    `These figures are canonical.`
  );
}

/**
 * A count is only publishable if it is a finite, strictly-positive number.
 *
 * This guard is the wave's correction to the spec: `getAssetCount()` swallows
 * its own errors and returns `0`, and `PerformanceStats.overall.pfeWinRate` is
 * `number | null`. Multiplying a null win rate by 100 would publish
 * "0.0% PFE win rate", and a DB blip would publish "0 assets" — both are
 * FALSE public claims, strictly worse than the staleness this wave fixes.
 * So an implausible value is treated exactly like a thrown error: fall back to
 * the labelled `[STATIC]` floor rather than emit a zero.
 */
function isPublishableCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/**
 * Live track-record block, 5-min cached, fail-open.
 *
 * All-or-nothing by design: if ANY field fails to read or is implausible, the
 * whole block falls back to the `[STATIC]` floor rather than mixing live and
 * static numbers under a single "live" label — a per-field mix would make the
 * block's own freshness label a lie for some of its numbers.
 *
 * Never throws, never returns empty.
 */
export async function getLiveTrackRecordBlock(): Promise<string> {
  if (_blockCache && Date.now() - _blockCache.fetchedAt < TTL_MS) {
    return _blockCache.block;
  }

  let block: string;
  try {
    const [stats, assetCount] = await Promise.all([getSignalPerformance(), getAssetCount()]);

    const totalCalls = stats?.totalCalls;
    const wrFraction = stats?.overall?.pfeWinRate;

    // `pfeWinRate` is a FRACTION (e.g. 0.9154) → percent, one decimal.
    // A rate outside (0, 1] means the upstream shape changed; don't publish it.
    const wrPublishable =
      isPublishableCount(wrFraction) && (wrFraction as number) <= 1;

    if (
      isPublishableCount(totalCalls) &&
      wrPublishable &&
      isPublishableCount(assetCount) &&
      isPublishableCount(EXCHANGE_COUNT)
    ) {
      block = formatTrackRecordBlock({
        totalCalls,
        pfeWinRatePct: (wrFraction as number) * 100,
        exchangeCount: EXCHANGE_COUNT,
        assetCount,
        asOfISO: new Date().toISOString(),
        live: true,
      });
    } else {
      block = formatTrackRecordBlock({ ...STATIC_FALLBACK, live: false });
    }
  } catch {
    block = formatTrackRecordBlock({ ...STATIC_FALLBACK, live: false });
  }

  _blockCache = { block, fetchedAt: Date.now() };
  return block;
}

/** Test-only reset hook. Never call in production. */
export function _resetTrackRecordBlockCache(): void {
  _blockCache = null;
}

/** Test-only read-only cache inspector. Never call in production. */
export function _getTrackRecordBlockCacheState(): { cached: boolean; ttlMs: number } {
  return { cached: _blockCache !== null, ttlMs: TTL_MS };
}
