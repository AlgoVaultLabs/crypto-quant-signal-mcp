/**
 * served.ts — SR-ZONES-W2 §0.1–§0.2 as R7 #3 amends it. The one projection from a computed frame to the frame a
 * response serves.
 *
 * The served zone is the zone. Each zone's low and high are rounded outward to the call's step (rounding.ts), and every
 * fact relating the current price to a zone is then read from those served edges: distance_pct (0 when price is at or
 * past the near edge) and the price_inside_zone flag. The summary describes this served frame. Selection, ladder order,
 * side, rank, state, broke_at, touches, the no_zone_above / no_zone_below flags and the overlaps (zone against zone,
 * attached before serving) stay as computed: nothing is refit.
 *
 * Outward rounding is monotone: along a ladder the served near edges keep their order, so the served distances never
 * invert. Two neighbouring zones can tie.
 */
import { isPriceInsideZone, nearDistancePct, type SrSide, type SrZone, type SrZoneFlag, type SrZonesFrame } from './zones.js';
import { roundZoneOutward, type LevelStep } from './rounding.js';

/** A computed frame as the response serves it, for the response's price and the call's step. */
export function serveSrZonesFrame(frame: SrZonesFrame, price: number, step: LevelStep | null): SrZonesFrame {
  const serve = (side: SrSide): SrZone[] =>
    frame[side].map((zone) => {
      const edges = roundZoneOutward(zone, step);
      return { ...edges, distance_pct: nearDistancePct(edges, side, price) };
    });
  const support = serve('support');
  const resistance = serve('resistance');
  // no_zone_above / no_zone_below count zones, which serving never changes; price_inside_zone is re-read, kept last.
  const flags: SrZoneFlag[] = frame.flags.filter((f) => f !== 'price_inside_zone');
  if ([...support, ...resistance].some((z) => isPriceInsideZone(z, price))) flags.push('price_inside_zone');
  return { support, resistance, flags, volume_vs_20: frame.volume_vs_20 };
}
