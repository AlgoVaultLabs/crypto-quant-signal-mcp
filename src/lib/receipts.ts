/**
 * Verdict-with-Receipts primitive (P0 VERDICT-WITH-RECEIPTS-W1).
 *
 * One reusable, typed, allow-listed generator that turns an ALREADY-computed
 * verdict into the inline proof both layers project from:
 *   - the structured `_receipts` block agents read (sibling of `_algovault`)
 *   - the human-readable receipt lines Claude/ChatGPT render in the tool text
 *
 * Single-derivation LAW: the verdict (call / confidence / regime / indicators) is
 * computed ONCE upstream; `formatReceipts` consumes it and NEVER re-derives the
 * call, and `renderReceiptText` projects the human lines from the SAME `Receipts`
 * object — so the human-line verdict can never disagree with `_receipts.verdict`.
 *
 * Allow-list LAW: `formatReceipts` returns ONLY the fields on the exported
 * `Receipts` interface. `outcome_return_pct` / `outcome_price` / any P&L is
 * structurally unreachable — the formatter reads named verdict fields and an
 * INJECTED track-record value; it never spreads the caller's object. The
 * positive-assertion canary in `tests/unit/receipts.test.ts` pins this.
 *
 * Track-record honesty: the numbers are LIVE (sourced from the in-process
 * performance data behind `performance://signal-performance`, cached by
 * `receipts-track-record.ts`) and OMITTED when the source is momentarily
 * unavailable (fail-open) — never a stale hardcoded value. Merkle anchoring
 * proves the aggregate record is genuine + unaltered, NOT that a call came true,
 * so `verification_uri` points at the aggregate track-record page only — ad-hoc
 * live calls are not individually anchored, so we never mint a per-call
 * `/verify/<id>` here (that is the named follow-up OPS-PERCALL-VERIFY-ANCHOR-W1).
 */
import type { SignalVerdict, RegimeType } from '../types.js';
import type { FundingState, TrendPersistence, BreakoutPending } from './indicator-buckets.js';

/** Aggregate track-record proof page. Mr.1 decision: NOT a per-call /verify/<id>. */
export const VERIFICATION_URI = 'https://algovault.com/track-record';

/** Compliance anchor — lives in the structured block only (NOT the per-call human text). */
export const RECEIPTS_DISCLAIMER =
  'Informational analytics, not investment advice. Past performance does not guarantee future results.';

/**
 * Approved tooltip / microcopy strings (Mr.1-approved, verbatim). Exported as the
 * single source for the later landing verdict card (P2) to import where a tooltip
 * slot exists — deliberately NOT injected into the per-call `_receipts` payload
 * (the allow-listed shape stays minimal; these are render-surface copy).
 */
export const RECEIPTS_BADGE_TOOLTIP = 'Every call is logged and Merkle-anchored on Base. Check it yourself.';
export const RECEIPTS_CONVICTION_TOOLTIP =
  "Conviction is our model's confidence in an actionable setup — not a probability of profit.";

export type FactorDirection = 'bullish' | 'bearish' | 'neutral';

/** A single ranked driver behind the verdict, with its directional read. */
export interface ReceiptFactor {
  /** Indicator key, e.g. `trend_persistence`, `funding_state`, `oi_change_pct`. */
  factor: string;
  direction: FactorDirection;
  /** Human/agent-readable value (bucket name or signed percent). */
  value: string;
}

/** Live, cached track-record proof. All fields LIVE — never hardcoded. */
export interface ReceiptTrackRecord {
  /** PFE win rate as a fraction in [0,1] (e.g. 0.916). */
  pfe_win_rate: number;
  /** Number of EVALUATED calls behind the win rate (the honest denominator). */
  n: number;
  /** Coverage window, `YYYY-MM-DD..YYYY-MM-DD`. */
  window: string;
  /** ISO timestamp of the cached snapshot's freshness. */
  as_of: string;
}

/** The allow-listed structured receipt block — the ONLY shape that reaches the wire. */
export interface Receipts {
  verdict: SignalVerdict;
  /** The live 0–100 engine confidence, shown on EVERY call incl. HOLD. */
  conviction_pct: number;
  regime: RegimeType;
  /** Top 2–3 salient drivers with direction. */
  factors: ReceiptFactor[];
  /** LIVE track record; OMITTED entirely when the source is unavailable (fail-open). */
  track_record?: ReceiptTrackRecord;
  verification_uri: string;
  disclaimer: string;
}

/**
 * The already-computed verdict the formatter consumes. A structural subset of
 * `TradeCallResult` — passing the full result is fine (extra fields ignored;
 * the formatter only reads these named fields, so P&L can never leak through).
 */
export interface VerdictContext {
  call: SignalVerdict;
  confidence: number;
  regime: RegimeType;
  indicators: {
    funding_rate: number;
    funding_state: FundingState;
    /** SCAN-RANKBY-W3: REAL OI %Δ; OMITTED while the oi_snapshots store is warming. */
    oi_change_pct?: number;
    trend_persistence: TrendPersistence;
    breakout_pending: BreakoutPending;
  };
}

export interface FormatReceiptsOptions {
  /** The cached track-record value, or null/undefined when the source is down. */
  trackRecord?: ReceiptTrackRecord | null;
}

/** Funding is a contrarian signal: a one-sided crowd reads against itself. */
function fundingDirection(state: FundingState, fundingRate: number): FactorDirection {
  // NORMAL crowd / administratively-fixed pre-IPO funding carry no sentiment read.
  if (state === 'NORMAL' || state === 'FIXED_PREIPO') return 'neutral';
  // ELEVATED / EXTREME: direction comes from the funding-rate SIGN (the codebase's
  // established convention — see indicator-buckets.ts). Positive funding = crowded
  // longs paying = contrarian bearish; negative = shorts paying = contrarian bullish.
  if (fundingRate > 0) return 'bearish';
  if (fundingRate < 0) return 'bullish';
  return 'neutral';
}

function oiDirection(oiChangePct: number): FactorDirection {
  if (oiChangePct >= 0.5) return 'bullish';
  if (oiChangePct <= -0.5) return 'bearish';
  return 'neutral';
}

function signedPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

/**
 * Derive the top 2–3 salient factors from the verdict's bucketed indicators.
 * Core always-on drivers: trend persistence (regime quality) + funding state
 * (crowd positioning). The 3rd slot is the most salient situational driver:
 * an IMMINENT breakout setup if present, else a meaningful OI move (|Δ| ≥ 0.5%).
 */
function buildFactors(ind: VerdictContext['indicators']): ReceiptFactor[] {
  const factors: ReceiptFactor[] = [
    { factor: 'trend_persistence', direction: 'neutral', value: ind.trend_persistence },
    { factor: 'funding_state', direction: fundingDirection(ind.funding_state, ind.funding_rate), value: ind.funding_state },
  ];
  if (ind.breakout_pending === 'IMMINENT') {
    // Compression pending direction — directionless by definition.
    factors.push({ factor: 'breakout_pending', direction: 'neutral', value: ind.breakout_pending });
  } else if (ind.oi_change_pct !== undefined && Math.abs(ind.oi_change_pct) >= 0.5) {
    // SCAN-RANKBY-W3: skipped while oi_change_pct is warming (omitted) — never a stale/wrong factor.
    factors.push({ factor: 'oi_change_pct', direction: oiDirection(ind.oi_change_pct), value: signedPct(ind.oi_change_pct) });
  }
  return factors;
}

/**
 * Build the allow-listed `_receipts` block from an already-computed verdict and
 * an injected (cached) track-record value. Pure: no I/O, no clock, no re-derivation.
 */
export function formatReceipts(verdict: VerdictContext, opts: FormatReceiptsOptions = {}): Receipts {
  const tr = opts.trackRecord;
  return {
    verdict: verdict.call,
    conviction_pct: verdict.confidence,
    regime: verdict.regime,
    factors: buildFactors(verdict.indicators),
    // Reconstruct from named fields (allow-list) so no foreign key rides along.
    ...(tr
      ? { track_record: { pfe_win_rate: tr.pfe_win_rate, n: tr.n, window: tr.window, as_of: tr.as_of } }
      : {}),
    verification_uri: VERIFICATION_URI,
    disclaimer: RECEIPTS_DISCLAIMER,
  };
}

/**
 * Envelope-shared proof block for `scan_trade_calls`. Each scanned row already
 * stands alone with its own `call` / `confidence` / `regime`; the proof
 * (track record + verify link + disclaimer) is shared ONCE at the envelope —
 * the lower-token shape that still lets a row + envelope screenshot stand alone.
 */
export type ScanReceipts = Pick<Receipts, 'track_record' | 'verification_uri' | 'disclaimer'>;

/** Build the shared scan envelope receipt from the cached track-record (fail-open). */
export function formatScanReceipts(trackRecord?: ReceiptTrackRecord | null): ScanReceipts {
  return {
    ...(trackRecord
      ? { track_record: { pfe_win_rate: trackRecord.pfe_win_rate, n: trackRecord.n, window: trackRecord.window, as_of: trackRecord.as_of } }
      : {}),
    verification_uri: VERIFICATION_URI,
    disclaimer: RECEIPTS_DISCLAIMER,
  };
}

/** `TRENDING_UP` → `Trending up`. */
function humanizeRegime(regime: RegimeType): string {
  return regime.charAt(0).toUpperCase() + regime.slice(1).toLowerCase().replace(/_/g, ' ');
}

/** 231222 → `231K`; 1_200_000 → `1.2M`; small counts as-is. */
function humanizeCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/**
 * The single proof-line format shared by the per-call receipt (Line 3) and the
 * scan envelope footer (single-derivation of the copy). Humanizes the live WR +
 * evaluated count and links to the aggregate verification page.
 */
function proofLine(tr: ReceiptTrackRecord, verificationUri: string): string {
  const pfePct = (tr.pfe_win_rate * 100).toFixed(1);
  return `Proof: ${pfePct}% PFE win rate · ${humanizeCount(tr.n)} calls · Merkle-anchored on Base · Verify → ${verificationUri}`;
}

/**
 * Project the human-readable inline receipt from the SAME `Receipts` object
 * (single-derivation). Returns up to three lines (newline-joined):
 *   1. `${verdict} · ${conviction}% conviction — ${regime}`
 *   2. `Why: ${reasoning}`               (reuses the existing reasoning verbatim)
 *   3. `Proof: …Verify → ${uri}`         (ONLY when track_record is present)
 * No disclaimer line per call (Mr.1: redundant — the page/agent-field anchor it).
 */
export function renderReceiptText(receipts: Receipts, reasoning: string): string {
  const lines: string[] = [
    `${receipts.verdict} · ${receipts.conviction_pct}% conviction — ${humanizeRegime(receipts.regime)}`,
  ];
  if (reasoning && reasoning.trim().length > 0) {
    lines.push(`Why: ${reasoning}`);
  }
  const tr = receipts.track_record;
  if (tr) {
    lines.push(proofLine(tr, receipts.verification_uri));
  }
  return lines.join('\n');
}

/**
 * The scan envelope proof footer — the shared proof line, or '' when the
 * track-record source is unavailable (fail-open). Lets a scan screenshot carry
 * the proof alongside the per-row verdict/conviction/regime.
 */
export function renderScanReceiptText(scanReceipts: ScanReceipts): string {
  return scanReceipts.track_record ? proofLine(scanReceipts.track_record, scanReceipts.verification_uri) : '';
}
