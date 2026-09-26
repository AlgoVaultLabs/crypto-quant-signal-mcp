/**
 * venue-slo-tiers.ts — OPS-LABEL-FRESHNESS-W1 R2.
 *
 * THE single source of truth for directional-label freshness SLO tiers. BOTH the
 * nightly labeler's SLO-deadline venue rotation (this repo, compiled into the image)
 * AND the host-side freshness canary (ops/monitoring/directional-label-freshness.py)
 * MUST derive "who is a major / what is its SLO" from HERE. When the scheduler and
 * the monitor disagree on the tier set they optimise/measure different objectives —
 * exactly the H1 incident: the rotation minimised *max-staleness* while the canary
 * measured *SLO-breach*, so a fresh major (BINANCE) sorted to the back of the queue
 * and aged past its 24h SLO while long-tail venues at 57h were served first.
 *
 * Single-derivation wiring:
 *   - the labeler `import`s this module (compile-time, in-image);
 *   - the Python canary reads the emitted mirror ops/monitoring/venue-slo-tiers.json;
 *   - tests/unit/venue-slo-tiers.test.ts locks the mirror == serializeTierSot() (pre-push);
 *   - scripts/emit-venue-slo-tiers.mjs --check regenerates/verifies it in CI.
 *
 * To change the tier set or an SLO: edit HERE, then `node scripts/emit-venue-slo-tiers.mjs --write`.
 */

/** The strict-SLO venues (top-liquidity). Mr.1 venue policy 2026-07-21. */
export const MAJOR_VENUES = ['BINANCE', 'BYBIT', 'OKX', 'BITGET', 'HL'] as const;
export type MajorVenue = (typeof MAJOR_VENUES)[number];

/**
 * The venues the B-DIR v3 FULL test can still admit to its panel (architect ruling Q-F,
 * OPS-BDIR-V3-PANEL-READINESS-W1, 2026-09-26). The nightly labeler serves them FIRST, and the
 * freshness canary PAGES only for them on label coverage; every other venue REPORTS with a declared
 * capacity reason. HL is deliberately absent: 76.5 % of its rows are sub-1h and its candle endpoint
 * serves 17.48 d of 5m history, so the FULL test's TA recompute (rule d) cannot reach its earliest
 * rows whatever their label coverage. Same single-derivation path as the majors: the labeler imports
 * this, the canary reads `full_panel_venues` from the emitted mirror.
 */
export const FULL_PANEL_VENUES = ['KUCOIN', 'BITGET', 'OKX', 'BINANCE', 'BYBIT'] as const;
const FULL_PANEL_SET: ReadonlySet<string> = new Set<string>(FULL_PANEL_VENUES);
export function isFullPanelVenue(venue: string): boolean {
  return FULL_PANEL_SET.has(venue);
}

export const MAJOR_SLO_HOURS = 24;
export const LONGTAIL_SLO_HOURS = 72;
/** The barrier spec the freshness SLO (and this rotation's frontier) is measured on. */
export const FRESHNESS_BARRIER_SPEC = 'tau1.0-floor0.30-v1';

const MAJOR_SET: ReadonlySet<string> = new Set<string>(MAJOR_VENUES);

export function isMajor(venue: string): boolean {
  return MAJOR_SET.has(venue);
}
export function tierOf(venue: string): 'major' | 'long-tail' {
  return isMajor(venue) ? 'major' : 'long-tail';
}
/** The tier SLO (hours) for a venue; long-tail is the default for any unknown/new venue. */
export function sloHoursFor(venue: string): number {
  return isMajor(venue) ? MAJOR_SLO_HOURS : LONGTAIL_SLO_HOURS;
}

/** The exact serialisable shape emitted to ops/monitoring/venue-slo-tiers.json. */
export interface TierSot {
  _generator: string;
  majors: string[];
  major_slo_hours: number;
  longtail_slo_hours: number;
  barrier_spec: string;
  full_panel_venues: string[];
}

export const TIER_SOT: TierSot = {
  _generator: 'src/lib/venue-slo-tiers.ts — OPS-LABEL-FRESHNESS-W1; regen: node scripts/emit-venue-slo-tiers.mjs --write',
  majors: [...MAJOR_VENUES],
  major_slo_hours: MAJOR_SLO_HOURS,
  longtail_slo_hours: LONGTAIL_SLO_HOURS,
  barrier_spec: FRESHNESS_BARRIER_SPEC,
  full_panel_venues: [...FULL_PANEL_VENUES],
};

/** Canonical JSON serialisation (2-space indent, trailing newline) — the emitted mirror. */
export function serializeTierSot(): string {
  return JSON.stringify(TIER_SOT, null, 2) + '\n';
}
