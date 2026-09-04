/**
 * Venue brand-colour source of truth — TRACK-RECORD-EXCHANGE-BRAND-COLORS-W1.
 *
 * ONE typed map from each rendered venue → its official exchange brand hex,
 * used to colour the "ANALYZING" venue-badge row on `/track-record`
 * (`getPerformanceDashboardHtml` in `src/index.ts`, both the server-rendered
 * chips and the client-side re-render, which project from THIS map — the
 * single-derivation rule across both rendered surfaces).
 *
 * Palette provenance: researched by Mr.1 against each venue's logo SVGs, brand
 * kits, and live-site CSS, then legibility-adjusted for the near-black page
 * background. The values below are authoritative — do NOT re-tint, lighten, or
 * "fix contrast". OKX (`#FFFFFF`) and WhiteBIT (`#F6F0FF`) are intentionally
 * near-but-not-equal (both monochrome brands, kept just distinguishable); do
 * not "dedupe" them.
 *
 * Keyed by {@link PromotedVenueId} — i.e. `(typeof EXCHANGES)[number]['id']`,
 * the exact promoted venues rendered on the dashboard — NOT the wider `ExchangeId`
 * union (which also carries EDGEX / WEEX, shadow ids that are not rendered and
 * have no approved brand colour). Because this is an exhaustive
 * `Record<PromotedVenueId, string>`, `tsc` FAILS THE BUILD if a 16th venue is
 * promoted into `EXCHANGES` without a brand colour here — the gap self-detects
 * at compile time, so no runtime fallback to an off-brand default is needed and
 * an unstyled/off-brand badge can never ship (see capabilities.ts §PromotedVenueId).
 *
 * This map is presentation-only: it holds no textual claim, number, or public
 * data. Any future venue-badge surface (integrations pages, social cards) can
 * import it for the same brand colours.
 */
import type { PromotedVenueId } from './capabilities.js';

/** Official exchange brand hex per rendered venue, in `EXCHANGES` render order. */
export const VENUE_BRAND_COLORS: Record<PromotedVenueId, string> = {
  HL: '#97FCE4', // Hyperliquid — live app accent
  BINANCE: '#F0B90B', // Binance — logo gold (Pantone 7406)
  BYBIT: '#F7A600', // Bybit — logo amber
  OKX: '#FFFFFF', // OKX — brand is black → white substitute (invisible on dark otherwise)
  BITGET: '#26C6DA', // Bitget — logo teal #1DA2B4, brightened for dark bg
  ASTER: '#EFBE84', // Aster — official logo SVG champagne gold
  BINGX: '#3D7BFF', // BingX — brand blue #0058FB, lightened
  GATE: '#3B6EF5', // Gate.io — "Gate blue" #2354E6, lightened
  HTX: '#0091D4', // HTX — brand azure
  KUCOIN: '#23AF91', // KuCoin — logo green (PMS 7723)
  MEXC: '#1972E2', // MEXC — "Ocean Blue" logo gradient
  PHEMEX: '#7DE95B', // Phemex — official logo green
  WHITEBIT: '#F6F0FF', // WhiteBIT — monochrome brand → off-white (kept distinct from OKX pure white)
  XT: '#FFBE40', // XT — logo amber (Pantone 1365)
  // OPS-WEEX-PROMOTE-W1 — Mr.1-approved 2026-09-04. Provenance: WEEX's OWN media kit
  // (weex.com/Media-kit), which states verbatim "Brand colors HEX #D8AE15 RGB 216 174 21
  // Alpha 100" alongside #000000. Fetched first-hand, not inferred. Deliberately NOT the
  // #E5AD00 read off the served stylesheet — that is the SITE ACCENT, not the brand value
  // (the page's own CSS renders #d8ae14, one unit of blue off its stated hex). Near BINANCE
  // #F0B90B / BYBIT #F7A600 by design: this map is BRAND FIDELITY and carries no distinctness
  // constraint — OKX/WhiteBIT already set that precedent. The chart-distinct value is
  // LB_EX_COLOR.WEEX (#FF6B3D) in index.ts, which is a different palette for a different job.
  WEEX: '#D8AE15', // WEEX — official media-kit brand gold (RGB 216 174 21)
};

/** Brand hex for a rendered venue. Total over {@link PromotedVenueId} (no fallback needed). */
export function venueBrandColor(id: PromotedVenueId): string {
  return VENUE_BRAND_COLORS[id];
}
