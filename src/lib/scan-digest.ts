/**
 * FEATURE-PARITY-CHANNELS-W1 CH2 — scan-digest pure helpers.
 *
 * Cadence math for the SCHEDULED whole-market scan digest (the scan_digest webhook
 * event + the bot's /scanwatch). Pure + dependency-light (a type-only import) so it
 * is trivially unit-tested and importable by both the webhook scheduler and the
 * webhook-api validation path with no cycle.
 *
 * `cadenceForTimeframe` is the timeframe-aware DEFAULT cadence. It is MIRRORED by
 * the bot's Python `cadence_for_timeframe` (CH4) — the two implementations are a
 * shared-logic candidate flagged for extraction-via-/capabilities at the 3rd
 * consumer (CLAUDE.md 3-example rule); until then the test suites on both sides pin
 * the identical map.
 *
 * SCAN-DIGEST-MCP-PARITY-W1 CH1 extends this leaf with the digest PROJECTORS:
 * `enrichScanCall` (the ONE allow-listed projection every channel — MCP content[1],
 * the webhook scan_digest, the bot /scan + /scanwatch — derives the digest from)
 * and `renderScanDigestLine` (the per-call digest line whose format the bot's
 * Python rendering MIRRORS; the CH4 canary pins them byte-identical).
 */

import type { SignalVerdict, RegimeType } from '../types.js';
import { formatReceipts, type ReceiptFactor, type VerdictContext } from './receipts.js';
// Type-only import — erased at compile, so NO runtime cycle even though
// trade-call-scanner.ts imports enrichScanCall/renderScanDigestLine from here as values.
import type { ScanExchangeId } from './trade-call-scanner.js';

export const VALID_CADENCES = ['1h', '4h', '1d'] as const;
export type Cadence = (typeof VALID_CADENCES)[number];

const CADENCE_SECONDS: Record<Cadence, number> = { '1h': 3600, '4h': 14_400, '1d': 86_400 };

/**
 * Seconds for the scanner's supported timeframes (the SCAN_TRADE_CALLS_SCHEMA enum).
 * Self-contained on purpose — importing performance-db's private TIMEFRAME_SECONDS
 * would couple this leaf helper to the DB core (cycle risk).
 */
const TF_SECONDS: Record<string, number> = {
  '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
  '1h': 3600, '2h': 7200, '4h': 14_400, '8h': 28_800, '12h': 43_200, '1d': 86_400,
};

/**
 * The DEFAULT cadence for a scan timeframe: the nearest cadence ≥ the timeframe,
 * hard-floored at 1h (never push sub-hourly). 1m–1h → 1h · 2h–4h → 4h · 8h–1d → 1d.
 * An unknown/unsupported tf falls back to '1d' — the conservative default-deny
 * (slowest cadence = least quota draw + least delivery spam).
 */
export function cadenceForTimeframe(timeframe: string): Cadence {
  const sec = TF_SECONDS[timeframe];
  if (sec == null) return '1d';
  if (sec <= CADENCE_SECONDS['1h']) return '1h';
  if (sec <= CADENCE_SECONDS['4h']) return '4h';
  return '1d';
}

/** The scanner's supported timeframes (mirrors the SCAN_TRADE_CALLS_SCHEMA enum). */
export const SCAN_TIMEFRAMES: readonly string[] = Object.keys(TF_SECONDS);

/** Is `tf` a supported scan timeframe? */
export function isSupportedScanTimeframe(tf: unknown): tf is string {
  return typeof tf === 'string' && Object.prototype.hasOwnProperty.call(TF_SECONDS, tf);
}

/** Type guard: is `c` one of the three valid cadences? */
export function isValidCadence(c: unknown): c is Cadence {
  return typeof c === 'string' && (VALID_CADENCES as readonly string[]).includes(c);
}

/**
 * The cadence bucket epoch for `nowSec` — the bucket's start, i.e. `nowSec` floored
 * to the cadence period. Used in the idempotency key so at most one digest is
 * enqueued per (subscription, bucket): a 2nd scheduler tick in the same bucket
 * recomputes the SAME id and the delivery UNIQUE(subscription_id,event_id) no-ops it.
 */
export function cadenceBucketEpoch(cadence: Cadence, nowSec: number): number {
  const period = CADENCE_SECONDS[cadence];
  return Math.floor(nowSec / period) * period;
}

/**
 * True iff the chosen cadence is MORE frequent than the scan timeframe — i.e. the
 * digest fires faster than the scan refreshes, so it repeats the same calls and
 * charges each time. Drives the stronger heads-up in the create-response / bot copy.
 * (The timeframe-derived default is never faster, so it never triggers it.)
 */
export function cadenceFasterThanTimeframe(cadence: Cadence, timeframe: string): boolean {
  const tfSec = TF_SECONDS[timeframe];
  if (tfSec == null) return false;
  return CADENCE_SECONDS[cadence] < tfSec;
}

/** ~How many times a `cadence` digest repeats the same `timeframe` scan (for the heads-up). */
export function repeatsPerTimeframe(cadence: Cadence, timeframe: string): number {
  const tfSec = TF_SECONDS[timeframe];
  if (tfSec == null) return 1;
  return Math.max(1, Math.round(tfSec / CADENCE_SECONDS[cadence]));
}

/**
 * Deterministic idempotency key for a (subscription, cadence-bucket). Replay-safe:
 * the delivery ledger's UNIQUE(subscription_id, event_id) + enqueueDelivery's
 * ON CONFLICT DO NOTHING guarantee at-most-once delivery per bucket.
 */
export function scanDigestEventId(subscriptionId: number, cadence: Cadence, nowSec: number): string {
  return `scan_digest:${subscriptionId}:${cadenceBucketEpoch(cadence, nowSec)}`;
}

// ── SCAN-DIGEST-MCP-PARITY-W1 CH1 — the digest projectors ─────────────────────

/**
 * The canonical per-coin engine detail `enrichScanCall` projects from — a
 * structural subset of the get_trade_call engine output (`TradeCallResult`),
 * RETAINED by the scanner on the (coin,exchange,timeframe) cell (Option A,
 * architect-ratified 2026-06-28: cache-key-DETERMINED detail is correctly cached;
 * only the lens-VARYING rank echo stays output-only via attachRank). Every
 * enrichment field is optional so a bare / test score is handled gracefully.
 */
export interface ScanCallSource {
  coin: string;
  timeframe: string;
  call: SignalVerdict;
  confidence: number;
  regime: RegimeType;
  /** Live price at scan time. */
  price?: number;
  /** Engine reasoning (deterministic bucket-prose; no LLM). */
  reasoning?: string;
  /** Engine indicators (superset of VerdictContext['indicators']); buildFactors reads the named fields. */
  indicators?: VerdictContext['indicators'] & { oi_change_window?: string };
}

/**
 * The allow-listed enriched scan call — the FROZEN digest projection shape
 * (CH1 freezes it for CH2 webhook + CH3 bot + CH4 canary). Carries ONLY public
 * fields; raw `indicators` and any `outcome_*` are structurally unreachable
 * (enrichScanCall is an explicit-copy allow-list, never a spread).
 */
export interface EnrichedScanCall {
  coin: string;
  timeframe: string;
  exchange: ScanExchangeId;
  call: SignalVerdict;
  confidence: number;
  regime: RegimeType;
  /** Live price (raw; consumers format). Omitted only for a degenerate detail-less source. */
  price?: number;
  /** Top 2–3 salient drivers — byte-identical to formatReceipts(detail).factors. */
  factors: ReceiptFactor[];
  /** Engine reasoning (`''` when absent). */
  reasoning: string;
  /** OI-delta window label (e.g. "24h") for the digest "(24h)" — Q2, architect-ratified.
   *  Mirrors the engine `indicators.oi_change_window`; omitted while the store is warming. */
  oi_change_window?: string;
}

/**
 * Project the canonical per-coin engine detail onto the allow-listed enriched
 * scan-call shape. Explicit field copy (allow-list LAW — never a spread), so a
 * wider engine object can never leak `outcome_*` / raw `indicators`. `factors`
 * reuses `formatReceipts` — the SINGLE source of the factor mapping get_trade_call
 * emits (so a new engine factor propagates to every channel's digest for free).
 * Pure: no I/O, no clock, no re-derivation of the verdict.
 */
export function enrichScanCall(source: ScanCallSource, exchange: ScanExchangeId): EnrichedScanCall {
  const factors = source.indicators
    ? formatReceipts({
        call: source.call,
        confidence: source.confidence,
        regime: source.regime,
        indicators: source.indicators,
      }).factors
    : [];
  const out: EnrichedScanCall = {
    coin: source.coin,
    timeframe: source.timeframe,
    exchange,
    call: source.call,
    confidence: source.confidence,
    regime: source.regime,
    factors,
    reasoning: typeof source.reasoning === 'string' ? source.reasoning : '',
  };
  if (source.price !== undefined) out.price = source.price;
  const window = source.indicators?.oi_change_window;
  if (window !== undefined) out.oi_change_window = window;
  return out;
}

// ── Per-call digest-line rendering (the SoT the bot mirrors; CH4 pins parity) ──

/** Short labels for the receipt factor names (the 📊 drivers line). MIRRORS the
 *  bot's `_FACTOR_LABELS`. Unknown factors fall back to their raw name. */
const FACTOR_LABELS: Record<string, string> = {
  oi_change_pct: 'OI',
  trend_persistence: 'trend persistence',
  funding_state: 'funding',
  funding_24h_avg: 'funding',
  breakout_pending: 'breakout',
  volume_24h: 'vol',
};
/** Direction → arrow. MIRRORS the bot's `_DIR_ARROW` (neutral → no arrow). */
const DIR_ARROW: Record<string, string> = { bullish: ' ↑', bearish: ' ↓' };

/** Price format — MIRRORS the bot `_fmt_price`: ≥1000 no-dec (comma), ≥1 2-dec, <1 stripped. */
function fmtScanPrice(p: number): string {
  if (!Number.isFinite(p)) return '';
  if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (p >= 1) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return String(parseFloat(p.toFixed(4)));
}

/** First sentence of the reasoning, capped — MIRRORS the bot `_trim_reasoning`. */
function trimReasoning(text: string, maxLen = 110): string {
  const t = text.trim();
  if (!t) return '';
  const first = t.split('. ')[0].replace(/\.+$/, '');
  return first.length > maxLen ? `${first.slice(0, maxLen - 1).trimEnd()}…` : first;
}

/** The ≤3 drivers line — MIRRORS the bot `_render_drivers` + the (window) on the OI driver. */
function renderDrivers(factors: ReceiptFactor[], oiWindow?: string): string {
  const parts: string[] = [];
  for (const f of factors.slice(0, 3)) {
    const label = FACTOR_LABELS[f.factor] ?? f.factor;
    let val = f.value;
    if ((f.factor === 'funding_state' || f.factor === 'breakout_pending') && typeof val === 'string') {
      val = val.toLowerCase();
    }
    if (f.factor === 'oi_change_pct' && oiWindow) val = `${val} (${oiWindow})`;
    const arrow = DIR_ARROW[f.direction] ?? '';
    const piece = `${label} ${val}${arrow}`.trim();
    if (piece) parts.push(piece);
  }
  return parts.join(' · ');
}

/** The fields renderScanDigestLine reads — satisfied by EnrichedScanCall AND by a
 *  scanner `ScanCallItem` in enriched mode (the enrichment fields are then populated),
 *  so the handler passes `result.calls` straight through (no cast). */
export type RenderableScanCall = Pick<EnrichedScanCall, 'coin' | 'call' | 'confidence' | 'regime'> & {
  price?: number;
  factors?: ReceiptFactor[];
  reasoning?: string;
  oi_change_window?: string;
};

/**
 * Render ONE actionable scan call as the digest block — the SoT the bot's Python
 * rendering MIRRORS (CH3) and the CH4 canary pins byte-identical:
 *
 *     🟢 CL — BUY @ $71.49 · 60% conviction · TRENDING_UP
 *        📊 trend persistence HIGH · funding elevated ↑ · OI +10.0% (24h) ↑
 *        💡 Trending regime, upward bias
 *
 * 🟢 BUY / 🔴 SELL. The 📊 line is omitted with no drivers, 💡 omitted with no
 * reasoning, the price clause omitted when price is absent.
 */
export function renderScanDigestLine(call: RenderableScanCall): string {
  const mark = call.call === 'BUY' ? '🟢' : '🔴';
  const price = call.price !== undefined ? fmtScanPrice(call.price) : '';
  const priceStr = price ? ` @ $${price}` : '';
  const lines = [`${mark} ${call.coin} — ${call.call}${priceStr} · ${call.confidence}% conviction · ${call.regime}`];
  const drivers = renderDrivers(call.factors ?? [], call.oi_change_window);
  if (drivers) lines.push(`   📊 ${drivers}`);
  const why = trimReasoning(call.reasoning ?? '');
  if (why) lines.push(`   💡 ${why}`);
  return lines.join('\n');
}

/**
 * The Telegram showcase's CTA, verbatim. `/scanwatch` is a bot command, so it only makes
 * sense on the Telegram surface — every other surface passes its own.
 */
export const SCAN_SHOWCASE_TG_CTA = 'Want this on your coins automatically? Set a standing scan: /scanwatch.';

export interface ScanShowcaseOptions {
  /**
   * Replaces the final CTA line. Omitted ⇒ the Telegram wording (byte-identical to the bot).
   * `null` omits the CTA line AND its preceding blank line entirely — for a surface that
   * renders its own CTAs outside this block, so they cannot end up duplicated.
   */
  cta?: string | null;
}

/**
 * Render the WEEKLY CROSS-VENUE SHOWCASE body — the "📡 This week I scanned N assets
 * across M venues" digest Telegram subscribers receive every Monday.
 *
 * ⚠️ THIS IS A MIRROR, NOT AN IMPORT — and the direction matters.
 * The canonical implementation of this framing is Python:
 * `algovault_bot.adoption.render_scan_showcase`, which has shipped for months. Python
 * cannot import TypeScript, so a second surface wanting the same body had exactly two
 * options: replicate the framing, or fork the format. This is the honest replication, and
 * `tests/scan-showcase-render.test.ts` pins it against the Python source line for line.
 * Do not "tidy" a rule here without changing BOTH sides — a mirror edited on one side is
 * just a fork with a reassuring comment on it.
 *
 * The PER-CALL blocks are NOT mirrored: they delegate to `renderScanDigestLine` above,
 * which the bot's `scan_digest.py` already declares itself a mirror of. So the per-setup
 * format has exactly ONE definition and cannot drift between surfaces at all.
 *
 * Returns `null` when there are no fresh setups, leaving what a quiet week MEANS to the
 * caller — Telegram suppresses the broadcast; dev.to publishes an honest market-state
 * note. Returning null rather than an empty string keeps that a deliberate decision
 * instead of something a falsy check swallows.
 *
 * @param setups      selected non-HOLD calls, already ranked and deduped by coin
 * @param assetCount  total perps scanned across every venue that answered — LIVE, never a literal
 * @param venueCount  venues that scanned WITHOUT error — live, and NOT the venue set's size
 */
export function renderScanShowcase(
  setups: RenderableScanCall[],
  assetCount: number,
  venueCount: number,
  opts: ScanShowcaseOptions = {},
): string | null {
  if (setups.length === 0) return null;
  // Interpolate the counts RAW. The Python uses an f-string `{asset_count}` on an int, so
  // `toLocaleString()` here would insert thousands separators and silently break parity
  // for exactly the four-digit asset counts this runs at in production.
  const lines = [
    `📡 This week I scanned ${assetCount} assets across ${venueCount} venues.`,
    '',
    'Top fresh setups:',
    '',
    setups.map(renderScanDigestLine).join('\n\n'),
  ];
  // `cta: null` ⇒ no CTA line and no trailing blank line, for a caller that renders its
  // own CTAs around this block. `undefined` ⇒ the Telegram default (bot parity).
  if (opts.cta !== null) lines.push('', opts.cta ?? SCAN_SHOWCASE_TG_CTA);
  return lines.join('\n');
}

/** Header scope for the MCP `content[1]` digest (the one-call PULL — no cadence). */
export interface ScanDigestMeta {
  topN?: number;
  timeframe?: string;
  exchange?: string;
  rankBy?: string;
}

/**
 * Build the MCP `content[1]` digest text: a header + one renderScanDigestLine per
 * ACTIONABLE (non-HOLD) call. NO Proof footer (parity with the rocket scanwatch
 * digest — OPS-SCANWATCH-ROCKET-NO-PROOF); the structured `_receipts` envelope
 * stays in `content[0]`. Returns '' when there is nothing actionable.
 */
export function renderScanDigest(calls: RenderableScanCall[], meta: ScanDigestMeta = {}): string {
  const actionable = calls.filter((c) => c.call !== 'HOLD');
  if (actionable.length === 0) return '';
  const lens = meta.rankBy && meta.rankBy !== 'oi' ? ` by ${meta.rankBy}` : '';
  const scope = [
    meta.topN ? `top ${meta.topN} perps${lens}` : 'scan',
    meta.exchange ? `on ${meta.exchange}` : '',
    meta.timeframe ? `@ ${meta.timeframe}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const header = `🚀 Scan digest — ${scope} — ${actionable.length} actionable:`;
  return [header, '', actionable.map(renderScanDigestLine).join('\n\n')].join('\n');
}
