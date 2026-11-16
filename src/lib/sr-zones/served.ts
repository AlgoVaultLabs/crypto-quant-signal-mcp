/**
 * served.ts — SR-ZONES-W2 §0.1–§0.2 as R7 amends it. The one projection from a computed frame to the frame a response
 * serves.
 *
 * The served zone is the zone (R7 #3). Each zone's low and high are rounded outward to the call's step (rounding.ts),
 * and every fact relating the current price to a zone is then read from those served edges: distance_pct (0 when price
 * is at or past the near edge) and the price_inside_zone flag. The summary describes this served frame. Selection,
 * ladder order, side, rank, state, broke_at, touches, the no_zone_above / no_zone_below flags and the overlaps (zone
 * against zone, attached before serving) stay as computed: nothing is refit.
 *
 * A served zone is built from an allow-list of fields, in served order. formed_from and formed_to are not on it (Mr.1,
 * R7): formation times stay internal to the ladder walk (zones.ts).
 *
 * Outward rounding is monotone: along a ladder the served near edges keep their order, so the served distances never
 * invert. Two neighbouring zones can tie.
 */
import { isPriceInsideZone, nearDistancePct, type SrSide, type SrZone, type SrZoneFlag } from './zones.js';
import { roundZoneOutward, type LevelStep } from './rounding.js';

/** The zone fields a response serves, in served order. */
export interface SrServedZone {
  rank: SrZone['rank'];
  low: SrZone['low'];
  high: SrZone['high'];
  distance_pct: SrZone['distance_pct'];
  members: SrZone['members'];
  touch_bars_90: SrZone['touch_bars_90'];
  tests_30: SrZone['tests_30'];
  last_touch: SrZone['last_touch'];
  state: SrZone['state'];
  broke_at: SrZone['broke_at'];
  overlaps: SrZone['overlaps'];
}

/** A timeframe's zones as a response serves them. */
export interface SrServedFrame {
  support: SrServedZone[];
  resistance: SrServedZone[];
  flags: SrZoneFlag[];
  volume_vs_20: number | null;
}

/** A computed frame as the response serves it, for the response's price and the call's step. */
export function serveSrZonesFrame(
  frame: { support: readonly SrZone[]; resistance: readonly SrZone[]; flags: readonly SrZoneFlag[]; volume_vs_20: number | null },
  price: number,
  step: LevelStep | null,
): SrServedFrame {
  const serve = (side: SrSide): SrServedZone[] =>
    frame[side].map((zone) => {
      const edges = roundZoneOutward({ low: zone.low, high: zone.high }, step);
      return {
        rank: zone.rank,
        low: edges.low,
        high: edges.high,
        distance_pct: nearDistancePct(edges, side, price),
        members: zone.members,
        touch_bars_90: zone.touch_bars_90,
        tests_30: zone.tests_30,
        last_touch: zone.last_touch,
        state: zone.state,
        broke_at: zone.broke_at,
        overlaps: zone.overlaps,
      };
    });
  const support = serve('support');
  const resistance = serve('resistance');
  // no_zone_above / no_zone_below count zones, which serving never changes; price_inside_zone is re-read, kept last.
  const flags: SrZoneFlag[] = frame.flags.filter((f) => f !== 'price_inside_zone');
  if ([...support, ...resistance].some((z) => isPriceInsideZone(z, price))) flags.push('price_inside_zone');
  return { support, resistance, flags, volume_vs_20: frame.volume_vs_20 };
}
