/**
 * tf-support.ts — OPS-SEED-UNSUPPORTED-TF-SKIP-W1.
 *
 * `isTimeframeFaithful(venue, tf)` — does the venue serve `tf` at a base-candle resolution FINE ENOUGH
 * that a `<tf>` win-rate is not resolution-inflated? The public, Merkle-anchored `byTimeframe` record is
 * the proof AlgoVault sells; a `5m` PFE win-rate computed on `15m` candles cannot resolve 5-minute price
 * action, and Factuality is THE LAW.
 *
 * Ratified rule (B′, architect 2026-07-23): **faithful ⇔ servedIntervalMs(tf) < 2 × TF_MS[tf]**.
 *   - A served base candle ≥ 2× the requested horizon is resolution-inflating → skip (WhiteBIT 3m/5m→15m
 *     3×/5×; PHEMEX 12h→1d exactly 2×).
 *   - A 1-step approximation < 2× is KEPT and DISCLOSED in the public methodology (XT/GATE/MEXC/HTX 3m→5m
 *     1.67×). Keeping it silently is rejected — an undisclosed 3m-WR-on-5m-candles fails a programmatic audit.
 *
 * Single-derivation: the served interval comes from each adapter's OWN fetch-map via `servedIntervalMs`
 * (see served-interval.ts). There is **no hand-maintained venue×TF faithfulness matrix** — the faithful set
 * is COMPUTED (SOP "Lessons burned in" #10; CLAUDE.md "Data-drive everything"). The `Record<ExchangeId, …>`
 * below is tsc-exhaustive, so a newly-added venue that forgets `servedIntervalMs` fails the type-check.
 *
 * Consumers: the cron seeder now (skips unfaithful pairs before `seedExchange`), and the public formatter
 * once OPS-COARSENED-HISTORY-SUPPRESS-W1 suppresses already-public coarsened rows — one predicate, so the
 * write-side and read-side can never drift to two disagreeing definitions of "faithful".
 */
import type { ExchangeId } from '../types.js';
import { TF_MS } from './pfe-mae.js';
import { servedIntervalMs as HL } from './adapters/hyperliquid.js';
import { servedIntervalMs as BINANCE } from './adapters/binance.js';
import { servedIntervalMs as BYBIT } from './adapters/bybit.js';
import { servedIntervalMs as OKX } from './adapters/okx.js';
import { servedIntervalMs as BITGET } from './adapters/bitget.js';
import { servedIntervalMs as ASTER } from './adapters/aster.js';
import { servedIntervalMs as EDGEX } from './adapters/edgex.js';
import { servedIntervalMs as GATE } from './adapters/gateio.js';
import { servedIntervalMs as MEXC } from './adapters/mexc.js';
import { servedIntervalMs as KUCOIN } from './adapters/kucoin.js';
import { servedIntervalMs as PHEMEX } from './adapters/phemex.js';
import { servedIntervalMs as BINGX } from './adapters/bingx.js';
import { servedIntervalMs as HTX } from './adapters/htx.js';
import { servedIntervalMs as WEEX } from './adapters/weex.js';
import { servedIntervalMs as BITMART } from './adapters/bitmart.js';
import { servedIntervalMs as XT } from './adapters/xt.js';
import { servedIntervalMs as WHITEBIT } from './adapters/whitebit.js';

/** Finest base-candle ms each adapter fetches for `tf`. Exhaustive over ExchangeId — a new venue that omits
 *  its `servedIntervalMs` export is a compile error, so coverage can never silently regress. */
const SERVED_INTERVAL_MS: Record<ExchangeId, (tf: string) => number | null> = {
  HL, BINANCE, BYBIT, OKX, BITGET, ASTER, EDGEX, GATE, MEXC, KUCOIN, PHEMEX, BINGX, HTX, WEEX, BITMART, XT, WHITEBIT,
};

/** Coarsening threshold: a served base candle ≥ this × the requested horizon is unfaithful (resolution-inflating). */
export const FAITHFUL_MAX_RATIO = 2;

/**
 * OPS-SEED-TF-SKIP-STRAND-HOTFIX-W1 (R3) — kill switch (default ON). `ALGOVAULT_TF_SKIP_ENABLED=false`
 * makes `isTimeframeFaithful` return true for every (venue,tf), instantly restoring pre-wave seeding
 * (WhiteBIT 3m/5m + PHEMEX 12h resume) via an env flip + container restart — no code revert. Read per-call
 * so a flip takes effect on the next short-lived seeder fire and is unit-testable. Two-flag firewall: a
 * future predicate bug becomes a flag flip, not a redeploy.
 */
function tfSkipEnabled(): boolean {
  return process.env.ALGOVAULT_TF_SKIP_ENABLED !== 'false';
}

/**
 * Does `venue` serve `tf` faithfully (no coarser-than-2× substitution)? Pure; the seeder's proactive skip.
 * Fails OPEN (returns true) on an unknown `tf` or an unmapped pair — the seeder's existing
 * InsufficientCandles/not-found error-path skip is the defence-in-depth complement for genuinely-absent data.
 * With the kill switch OFF (`ALGOVAULT_TF_SKIP_ENABLED=false`) returns true unconditionally (pre-wave).
 */
export function isTimeframeFaithful(venue: ExchangeId, tf: string): boolean {
  if (!tfSkipEnabled()) return true;
  const requestedMs = TF_MS[tf];
  if (requestedMs == null) return true;
  const servedMs = SERVED_INTERVAL_MS[venue]?.(tf);
  if (servedMs == null) return true;
  return servedMs < FAITHFUL_MAX_RATIO * requestedMs;
}

/** The timeframes the cron seeder requests (1m is never cron-seeded). */
export const CRON_TIMEFRAMES = ['3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d'] as const;

/** The cron timeframes `venue` serves faithfully — the set the seeder will actually accrue. */
export function faithfulTimeframes(venue: ExchangeId): Set<string> {
  return new Set(CRON_TIMEFRAMES.filter((tf) => isTimeframeFaithful(venue, tf)));
}

/**
 * Canonical label of the base candle `venue` would serve for `tf` — for the seeder's load-bearing SKIP log
 * (`would coarsen 5m→15m`). Falls back to a minute count for a non-canonical served duration; 'unmapped' when
 * the adapter can't serve `tf` at all.
 */
export function servedTimeframeLabel(venue: ExchangeId, tf: string): string {
  const servedMs = SERVED_INTERVAL_MS[venue]?.(tf);
  if (servedMs == null) return 'unmapped';
  const canonical = Object.entries(TF_MS).find(([, ms]) => ms === servedMs)?.[0];
  return canonical ?? `${Math.round(servedMs / 60_000)}m`;
}
