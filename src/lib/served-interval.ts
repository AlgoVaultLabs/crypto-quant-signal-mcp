/**
 * served-interval.ts — OPS-SEED-UNSUPPORTED-TF-SKIP-W1 (R1/R2 seam · LEAF module).
 *
 * The FINEST base-candle duration (ms) an adapter actually FETCHES for a requested timeframe, derived
 * from the adapter's OWN interval map + unit. Consumed by `tf-support.ts::isTimeframeFaithful` to detect
 * COARSER substitution (served ≥ 2× requested → a `<tf>` win-rate computed on `>tf` candles).
 *
 * Single-derivation: each adapter exports its raw fetch-map (the one `getCandles` passes to the venue);
 * this module + `tf-support` turn it into `servedIntervalMs` and apply the ONE rule. There is NO
 * hand-maintained venue×TF faithfulness matrix — the faithful set is COMPUTED (SOP "Lessons burned in" #10).
 *
 * Q3 rider — servedIntervalMs must return the BASE candle the adapter pulls. Today no adapter aggregates
 * (all fetch-and-relabel), so served interval == fetched interval == map[tf]. A FUTURE adapter that
 * synthesises `3m` from 3×`1m` must report the `1m` base (→ faithful), NOT the `3m` output — i.e. wrap its
 * map so `map['3m']` resolves to the 1-minute base. Coarsening is base-resolution vs the requested horizon,
 * never the output-bar label.
 */

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;

/**
 * Parse ANY venue interval token → ms. Handles every notation the 17 adapters use:
 *   canonical `5m`/`1h`/`1d`; venue-upper `1H`/`4H`/`1D`; MEXC `Min5`/`Hour4`/`Day1`;
 *   HTX `5min`/`4hour`/`1day`; edgeX `MINUTE_5`/`HOUR_2`/`DAY_1`; Bybit bare `5`/`60` (= minutes) + `D`/`W`.
 * Returns null on an unrecognised token (→ predicate defaults faithful; a real gap is caught by the
 * seeder's error-path skip). A unit test pins every venue's parse so a new format can't silently return null.
 */
export function parseIntervalToken(tok: string): number | null {
  const t = tok.trim();
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^(\d+)m$/))) return +m[1] * UNIT_MS.m;            // 5m 15m 30m 3m (lowercase minutes)
  if ((m = t.match(/^(\d+)h$/i))) return +m[1] * UNIT_MS.h;          // 1h 2h 4h 8h 12h / 1H 6H 12H
  if ((m = t.match(/^(\d+)d$/i))) return +m[1] * UNIT_MS.d;          // 1d / 1D
  if ((m = t.match(/^(\d+)w$/i))) return +m[1] * UNIT_MS.w;          // 1w / 1W
  if ((m = t.match(/^Min(\d+)$/i))) return +m[1] * UNIT_MS.m;        // MEXC Min5 Min60
  if ((m = t.match(/^Hour(\d+)$/i))) return +m[1] * UNIT_MS.h;       // MEXC Hour4 Hour8
  if ((m = t.match(/^Day(\d+)$/i))) return +m[1] * UNIT_MS.d;        // MEXC Day1
  if ((m = t.match(/^(\d+)min$/i))) return +m[1] * UNIT_MS.m;        // HTX 5min 60min
  if ((m = t.match(/^(\d+)hour$/i))) return +m[1] * UNIT_MS.h;       // HTX 4hour
  if ((m = t.match(/^(\d+)day$/i))) return +m[1] * UNIT_MS.d;        // HTX 1day
  if ((m = t.match(/^MINUTE_(\d+)$/i))) return +m[1] * UNIT_MS.m;    // edgeX MINUTE_5
  if ((m = t.match(/^HOUR_(\d+)$/i))) return +m[1] * UNIT_MS.h;      // edgeX HOUR_2
  if ((m = t.match(/^DAY_(\d+)$/i))) return +m[1] * UNIT_MS.d;       // edgeX DAY_1
  if ((m = t.match(/^WEEK_(\d+)$/i))) return +m[1] * UNIT_MS.w;
  if ((m = t.match(/^(\d+)$/))) return +m[1] * UNIT_MS.m;            // Bybit bare 5 60 120 = minutes
  if (/^D$/i.test(t)) return UNIT_MS.d;                             // Bybit D
  if (/^W$/i.test(t)) return UNIT_MS.w;                             // Bybit W
  return null;
}

/**
 * Build `servedIntervalMs(tf)` from an adapter's fetch-map. String values → {@link parseIntervalToken};
 * number values → × the declared unit (minutes | seconds | ms). Returns null when the adapter cannot
 * serve `tf` at all (unmapped) — the seeder's existing InsufficientCandles/not-found skip covers that.
 */
export function makeServedIntervalMs(
  map: Record<string, string | number>,
  unit?: 'minutes' | 'seconds' | 'ms',
): (tf: string) => number | null {
  // OPS-SEED-TF-SKIP-STRAND-HOTFIX-W1 (R1) — structural anti-ambiguity invariant. A NUMBER map value is
  // dimensionless (`300` could be min/sec/ms), so a number-typed map MUST declare its unit at the call site.
  // This runs at MODULE LOAD (when an adapter's `export const servedIntervalMs = makeServedIntervalMs(MAP[, unit])`
  // is imported), so a future number-map adapter that forgets the unit throws immediately — it can never
  // silently default. String tokens are self-describing (parseIntervalToken) and need no unit, so bybit's
  // bare `'1'/'60'/'D'` stay valid. A permanent correctness invariant, not a revisit-later threshold.
  if (unit === undefined && Object.values(map).some((v) => typeof v === 'number')) {
    throw new Error(
      "served-interval: a number-typed interval map requires an explicit unit ('minutes' | 'seconds' | 'ms') — " +
        'a bare numeric token is dimensionally ambiguous. Pass makeServedIntervalMs(map, <unit>).',
    );
  }
  const mult = unit === 'seconds' ? 1_000 : unit === 'ms' ? 1 : 60_000;
  return (tf) => {
    const v = map[tf];
    if (v == null) return null;
    return typeof v === 'number' ? v * mult : parseIntervalToken(v);
  };
}
