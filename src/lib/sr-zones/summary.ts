/**
 * summary.ts — SR-ZONES-W1 §0. The one-sentence summary template of a get_sr_zones response.
 *
 * Facts only: every sentence states where zones are and what price and volume did, never what they will do. The
 * facts lint (tests/unit/sr-zones-facts-lint.test.ts) checks every string literal in src/lib/sr-zones/** and
 * this template's output on the last 365 fixture candles. (ORDER and its `order` field left the response, R7; NOTE
 * and its `note` field, R8.)
 *
 * SR-ZONES-W2 §0.1–§0.2 as R7 #3 amends it: a response's summary describes its SERVED frame (served.ts), so zone 1's
 * printed range, whether price is inside it and how far it is all read the edges the response carries; the state and
 * broke_at it prints are the computed zone's, which serving carries unchanged.
 */
import { isPriceInsideZone, type SrZone } from './zones.js';
import { formatLevel } from './rounding.js';

/** What the summary reads of a zone: a computed zone or a served one (served.ts). */
type SummaryZone = Pick<SrZone, 'low' | 'high' | 'distance_pct' | 'state' | 'broke_at'>;

/** A price with up to 6 significant digits after the leading one and no trailing zeros. */
function formatPrice(x: number): string {
  if (x === 0 || !Number.isFinite(x)) return String(x);
  const decimals = Math.max(0, Math.min(10, 6 - Math.floor(Math.log10(Math.abs(x)))));
  const s = x.toFixed(decimals);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** Candle open time: the date alone on the 1d timeframe, date and minute otherwise. */
function formatTime(isoTime: string, timeframe: string): string {
  return timeframe === '1d' ? isoTime.slice(0, 10) : `${isoTime.slice(0, 16).replace('T', ' ')} UTC`;
}

function nearestPart(zone: SummaryZone | undefined, side: 'support' | 'resistance', timeframe: string, price: number): string {
  const where = side === 'support' ? 'below' : 'above';
  if (!zone) return `no ${side} zone ${where} in the loaded history`;
  const range = `${formatLevel(zone.low)}–${formatLevel(zone.high)}`;
  // R6 #3: "inside" is the flag's predicate on the zone's edges, never a rounded distance_pct of 0.
  const position = isPriceInsideZone(zone, price)
    ? `price inside ${side} zone 1 at ${range}`
    : `${side} zone 1 at ${range}, ${zone.distance_pct}% ${where}`;
  if (zone.state === 'intact' || zone.broke_at === null) return position;
  const was = zone.state === 'former_support' ? 'support' : 'resistance';
  return `${position} (${was} until ${formatTime(zone.broke_at, timeframe)})`;
}

/** One factual sentence describing a timeframe's zones as `frame` gives them (in a response, the served frame). */
export function buildSrZonesSummary(
  coin: string,
  timeframe: string,
  price: number,
  frame: { support: readonly SummaryZone[]; resistance: readonly SummaryZone[]; volume_vs_20: number | null },
): string {
  const parts = [
    `${frame.support.length} support and ${frame.resistance.length} resistance zones`,
    nearestPart(frame.support[0], 'support', timeframe, price),
    nearestPart(frame.resistance[0], 'resistance', timeframe, price),
  ];
  if (frame.volume_vs_20 !== null) parts.push(`last closed candle volume ${frame.volume_vs_20}× its 20-candle average`);
  return `${coin} ${timeframe} at ${formatPrice(price)}: ${parts.join('; ')}.`;
}
