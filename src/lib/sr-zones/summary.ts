/**
 * summary.ts — SR-ZONES-W1 §0. The fixed strings of a get_sr_zones response and the one-sentence summary template.
 *
 * Facts only: every sentence states where zones are and what price and volume did, never what they will do. The
 * facts lint (tests/unit/sr-zones-facts-lint.test.ts) checks every string literal in src/lib/sr-zones/**, NOTE, ORDER
 * and this template's output on the last 365 fixture candles.
 *
 * SR-ZONES-W2 §0.1–§0.2: the printed range of zone 1 is the SERVED range (the edges the response carries, rounded
 * outward once by the caller); whether price is inside the zone and how far it is stay on the computed zone.
 */
import { isPriceInsideZone, type SrZone, type SrZonesFrame } from './zones.js';
import { formatLevel } from './rounding.js';

/** The edges a response serves for each zone, index for index with the computed frame. */
export interface SrZonesServedEdges {
  support: ReadonlyArray<{ low: number; high: number }>;
  resistance: ReadonlyArray<{ low: number; high: number }>;
}

export const SR_ZONES_NOTE = 'Zones mark where price has clustered before. Price can move through any zone.';

export const SR_ZONES_ORDER =
  'Zones are ranked from the most recent price cluster outward: each next zone formed earlier and sits further from price.';

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

function nearestPart(
  zone: SrZone | undefined,
  served: { low: number; high: number } | undefined,
  side: 'support' | 'resistance',
  timeframe: string,
  price: number,
): string {
  const where = side === 'support' ? 'below' : 'above';
  if (!zone) return `no ${side} zone ${where} in the loaded history`;
  const edges = served ?? zone;
  const range = `${formatLevel(edges.low)}–${formatLevel(edges.high)}`;
  // R6 #3: "inside" is the flag's predicate on the zone's edges, never a rounded distance_pct of 0.
  const position = isPriceInsideZone(zone, price)
    ? `price inside ${side} zone 1 at ${range}`
    : `${side} zone 1 at ${range}, ${zone.distance_pct}% ${where}`;
  if (zone.state === 'intact' || zone.broke_at === null) return position;
  const was = zone.state === 'former_support' ? 'support' : 'resistance';
  return `${position} (${was} until ${formatTime(zone.broke_at, timeframe)})`;
}

/** One factual sentence describing a timeframe's zones: positions from `frame`, the printed ranges from `served`. */
export function buildSrZonesSummary(
  coin: string,
  timeframe: string,
  price: number,
  frame: SrZonesFrame,
  served: SrZonesServedEdges,
): string {
  const parts = [
    `${frame.support.length} support and ${frame.resistance.length} resistance zones`,
    nearestPart(frame.support[0], served.support[0], 'support', timeframe, price),
    nearestPart(frame.resistance[0], served.resistance[0], 'resistance', timeframe, price),
  ];
  if (frame.volume_vs_20 !== null) parts.push(`last closed candle volume ${frame.volume_vs_20}× its 20-candle average`);
  return `${coin} ${timeframe} at ${formatPrice(price)}: ${parts.join('; ')}.`;
}
