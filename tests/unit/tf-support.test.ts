/**
 * Unit tests for OPS-SEED-UNSUPPORTED-TF-SKIP-W1 — the faithful-timeframe predicate.
 *
 * `isTimeframeFaithful` is derived from each adapter's REAL interval map (single-derivation via
 * `servedIntervalMs`), so these assertions double as a live check of the coarsening matrix in
 * `audits/OPS-SEED-UNSUPPORTED-TF-SKIP-W1-endpoint-truth.md`. Ratified rule (B′):
 * faithful ⇔ servedIntervalMs(tf) < 2 × TF_MS[tf].
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  isTimeframeFaithful,
  faithfulTimeframes,
  servedTimeframeLabel,
  FAITHFUL_MAX_RATIO,
} from '../../src/lib/tf-support.js';
import { parseIntervalToken, makeServedIntervalMs } from '../../src/lib/served-interval.js';
import { PROMOTED_VENUE_IDS } from '../../src/lib/capabilities.js';
import { TF_MS } from '../../src/lib/pfe-mae.js';

describe('parseIntervalToken — every venue notation → ms (never silently null)', () => {
  it('canonical lowercase', () => {
    expect(parseIntervalToken('5m')).toBe(300_000);
    expect(parseIntervalToken('1h')).toBe(3_600_000);
    expect(parseIntervalToken('12h')).toBe(43_200_000);
    expect(parseIntervalToken('1d')).toBe(86_400_000);
  });
  it('venue-upper (OKX / Bitget 1H / 6H / 1D)', () => {
    expect(parseIntervalToken('1H')).toBe(3_600_000);
    expect(parseIntervalToken('6H')).toBe(21_600_000);
    expect(parseIntervalToken('1D')).toBe(86_400_000);
  });
  it('MEXC Min / Hour / Day', () => {
    expect(parseIntervalToken('Min5')).toBe(300_000);
    expect(parseIntervalToken('Min60')).toBe(3_600_000);
    expect(parseIntervalToken('Hour4')).toBe(14_400_000);
    expect(parseIntervalToken('Hour8')).toBe(28_800_000);
    expect(parseIntervalToken('Day1')).toBe(86_400_000);
  });
  it('HTX Nmin / Nhour / Nday', () => {
    expect(parseIntervalToken('5min')).toBe(300_000);
    expect(parseIntervalToken('60min')).toBe(3_600_000);
    expect(parseIntervalToken('4hour')).toBe(14_400_000);
    expect(parseIntervalToken('1day')).toBe(86_400_000);
  });
  it('edgeX MINUTE_ / HOUR_ / DAY_', () => {
    expect(parseIntervalToken('MINUTE_5')).toBe(300_000);
    expect(parseIntervalToken('HOUR_2')).toBe(7_200_000);
    expect(parseIntervalToken('DAY_1')).toBe(86_400_000);
  });
  it('Bybit bare-number = minutes, plus D', () => {
    expect(parseIntervalToken('5')).toBe(300_000);
    expect(parseIntervalToken('60')).toBe(3_600_000);
    expect(parseIntervalToken('720')).toBe(43_200_000);
    expect(parseIntervalToken('D')).toBe(86_400_000);
  });
  it('returns null on an unrecognised token', () => {
    expect(parseIntervalToken('banana')).toBeNull();
    expect(parseIntervalToken('')).toBeNull();
  });
});

describe('makeServedIntervalMs — number units, string parse, aggregation base (Q3 rider)', () => {
  it('minutes / seconds / ms number maps convert correctly', () => {
    expect(makeServedIntervalMs({ '5m': 5 }, 'minutes')('5m')).toBe(300_000);
    expect(makeServedIntervalMs({ '5m': 300 }, 'seconds')('5m')).toBe(300_000);
    expect(makeServedIntervalMs({ '5m': 300_000 }, 'ms')('5m')).toBe(300_000);
  });
  it('string map delegates to parseIntervalToken', () => {
    expect(makeServedIntervalMs({ '3m': '5m' })('3m')).toBe(300_000);
  });
  it('null when the pair is unmapped (→ predicate fails open, seeder error-path skips)', () => {
    expect(makeServedIntervalMs({ '5m': '5m' })('3m')).toBeNull();
  });
  // Coarsening is BASE-candle-resolution vs the requested horizon, never the output-bar label. A future
  // adapter AGGREGATING `2h` from 2×`1h` reports the 1h base → faithful; a SUBSTITUTED coarser 15m→ unfaithful.
  it('aggregation-from-finer base reads faithful; coarser substitution reads unfaithful', () => {
    const aggregatedBase = makeServedIntervalMs({ '2h': '1h' })('2h'); // hypothetical 2h built on 1h bars
    expect(aggregatedBase).toBe(3_600_000);
    expect(aggregatedBase! < FAITHFUL_MAX_RATIO * 7_200_000).toBe(true); // 1h < 2×2h → faithful
    const coarsenedBase = makeServedIntervalMs({ '5m': '15m' })('5m');
    expect(coarsenedBase).toBe(900_000);
    expect(coarsenedBase! < FAITHFUL_MAX_RATIO * 300_000).toBe(false); // 15m ≥ 2×5m → unfaithful
  });
});

describe('isTimeframeFaithful — derived from real adapter maps', () => {
  it('WhiteBIT 3m/5m coarsen to 15m (5× / 3×) → unfaithful (the hack the predicate replaces)', () => {
    expect(isTimeframeFaithful('WHITEBIT', '3m')).toBe(false);
    expect(isTimeframeFaithful('WHITEBIT', '5m')).toBe(false);
  });
  it('WhiteBIT ≥15m serve native-or-finer → faithful', () => {
    for (const tf of ['15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d']) {
      expect(isTimeframeFaithful('WHITEBIT', tf), `WhiteBIT ${tf}`).toBe(true);
    }
  });
  it('PHEMEX 12h coarsens to 1d (exactly 2×) → unfaithful (NEW case this wave adds)', () => {
    expect(isTimeframeFaithful('PHEMEX', '12h')).toBe(false);
  });
  it('PHEMEX 8h→4h (finer) and 3m→5m (1.67×) → faithful', () => {
    expect(isTimeframeFaithful('PHEMEX', '8h')).toBe(true);
    expect(isTimeframeFaithful('PHEMEX', '3m')).toBe(true);
  });
  it('XT/GATE/MEXC/HTX 3m→5m (1.67× < 2×) → KEPT faithful (ratified, methodology-disclosed)', () => {
    for (const v of ['XT', 'GATE', 'MEXC', 'HTX'] as const) {
      expect(isTimeframeFaithful(v, '3m'), `${v} 3m`).toBe(true);
    }
  });
  it('BitMart 3m is native → faithful', () => {
    expect(isTimeframeFaithful('BITMART', '3m')).toBe(true);
  });
  it('every fully-native venue serves every cron TF faithfully (exercises D / 1H / bare-number parsing)', () => {
    for (const v of ['BINANCE', 'BYBIT', 'OKX', 'BITGET', 'ASTER', 'BINGX'] as const) {
      for (const tf of ['3m', '5m', '15m', '30m', '1h', '4h', '1d']) {
        expect(isTimeframeFaithful(v, tf), `${v} ${tf}`).toBe(true);
      }
    }
  });
});

describe('faithfulTimeframes — the set the seeder will accrue', () => {
  it('WhiteBIT drops 3m/5m, keeps everything ≥15m', () => {
    const s = faithfulTimeframes('WHITEBIT');
    expect(s.has('3m')).toBe(false);
    expect(s.has('5m')).toBe(false);
    expect(s.has('15m')).toBe(true);
    expect(s.has('1d')).toBe(true);
  });
  it('PHEMEX drops only 12h', () => {
    const s = faithfulTimeframes('PHEMEX');
    expect(s.has('12h')).toBe(false);
    expect(s.has('8h')).toBe(true);
    expect(s.has('3m')).toBe(true);
  });
});

describe('servedTimeframeLabel — the coarsen target for the load-bearing SKIP log', () => {
  it('names the coarser bar the adapter would serve', () => {
    expect(servedTimeframeLabel('WHITEBIT', '5m')).toBe('15m');
    expect(servedTimeframeLabel('WHITEBIT', '3m')).toBe('15m');
    expect(servedTimeframeLabel('PHEMEX', '12h')).toBe('1d');
  });
});

describe('R4 safety — no promoted venue stranded below the 45-min freshness SLA', () => {
  it('every promoted venue keeps ≥1 faithful TF ≤30m', () => {
    for (const v of PROMOTED_VENUE_IDS) {
      const fast = [...faithfulTimeframes(v)].filter((tf) => ['3m', '5m', '15m', '30m'].includes(tf));
      expect(fast.length, `${v} has no faithful fast lane`).toBeGreaterThan(0);
    }
  });
});

describe('the predicate genuinely rejects (cannot silently return all-true)', () => {
  it('the three ratified coarsening pairs are all unfaithful', () => {
    expect(isTimeframeFaithful('WHITEBIT', '5m')).toBe(false);
    expect(isTimeframeFaithful('WHITEBIT', '3m')).toBe(false);
    expect(isTimeframeFaithful('PHEMEX', '12h')).toBe(false);
  });
  it('FAITHFUL_MAX_RATIO is the ratified 2×', () => {
    expect(FAITHFUL_MAX_RATIO).toBe(2);
  });
});

// ── OPS-SEED-TF-SKIP-STRAND-HOTFIX-W1 ──────────────────────────────────────────────────────────────

describe('R1 — a NUMBER-typed interval map requires an explicit unit (structural anti-ambiguity invariant)', () => {
  it('throws when a number map is built with NO unit (a future number-map adapter that forgets)', () => {
    expect(() => makeServedIntervalMs({ '5m': 300 })).toThrow(/explicit unit/i);
    expect(() => makeServedIntervalMs({ '1m': 60, '5m': 300 })).toThrow(/ambiguous/i);
  });
  it('accepts a number map WITH a unit and converts correctly', () => {
    expect(makeServedIntervalMs({ '5m': 300 }, 'seconds')('5m')).toBe(300_000);
    expect(makeServedIntervalMs({ '5m': 5 }, 'minutes')('5m')).toBe(300_000);
    expect(makeServedIntervalMs({ '5m': 300_000 }, 'ms')('5m')).toBe(300_000);
  });
  it('accepts a STRING map with NO unit — self-describing tokens; bybit bare-minutes stay valid', () => {
    expect(() => makeServedIntervalMs({ '1m': '1', '1h': '60', '1d': 'D' })).not.toThrow();
    expect(makeServedIntervalMs({ '1h': '60' })('1h')).toBe(3_600_000); // bybit bare '60' = 60min = 1h
    expect(makeServedIntervalMs({ '1d': 'D' })('1d')).toBe(86_400_000);
  });
  it('every real adapter already satisfies the invariant (all 17 servedIntervalMs imported clean at load)', () => {
    // tf-support.ts imports all 17 adapter servedIntervalMs at module load; a number-map adapter that omitted
    // its unit would have THROWN before this file loaded. Reaching here (and PHEMEX=seconds/BITMART=minutes
    // classifying correctly) proves the four number-map adapters declared their unit.
    expect(isTimeframeFaithful('PHEMEX', '12h')).toBe(false); // PHEMEX map SECONDS + unit → loaded clean
    expect(isTimeframeFaithful('BITMART', '3m')).toBe(true);  // BITMART map MINUTES + unit → loaded clean
  });
});

describe('R3 — ALGOVAULT_TF_SKIP_ENABLED kill switch (default ON)', () => {
  const KEY = 'ALGOVAULT_TF_SKIP_ENABLED';
  const orig = process.env[KEY];
  afterEach(() => { if (orig === undefined) delete process.env[KEY]; else process.env[KEY] = orig; });

  it('default (unset) → skip ENABLED: WHITEBIT 5m + PHEMEX 12h are unfaithful', () => {
    delete process.env[KEY];
    expect(isTimeframeFaithful('WHITEBIT', '5m')).toBe(false);
    expect(isTimeframeFaithful('PHEMEX', '12h')).toBe(false);
  });
  it('=false → skip DISABLED: EVERY (venue,tf) faithful (pre-wave seeding restored, no code revert)', () => {
    process.env[KEY] = 'false';
    for (const tf of ['3m', '5m', '15m', '12h', '1d']) {
      expect(isTimeframeFaithful('WHITEBIT', tf), `WHITEBIT ${tf} skip-off`).toBe(true);
      expect(isTimeframeFaithful('PHEMEX', tf), `PHEMEX ${tf} skip-off`).toBe(true);
    }
  });
  it('only the literal "false" disables — "true"/"1" keep the skip ENABLED', () => {
    process.env[KEY] = 'true';
    expect(isTimeframeFaithful('WHITEBIT', '5m')).toBe(false);
    process.env[KEY] = '1';
    expect(isTimeframeFaithful('WHITEBIT', '5m')).toBe(false);
  });
});

describe('R4 — the no-stranded invariant self-validates (FAILS on a synthetic stranded venue)', () => {
  // The live no-stranded test proves every REAL promoted venue keeps a faithful fast lane. This proves the
  // CHECK has teeth: a synthetic venue whose every fast TF coarsens ≥2× MUST read as stranded, else the
  // invariant is vacuous. (H1 taught us a green gate that cannot fail is worthless.)
  const FAST = ['3m', '5m', '15m', '30m'];
  const faithfulFast = (served: (tf: string) => number | null) =>
    FAST.filter((tf) => { const s = served(tf); return s != null && s < FAITHFUL_MAX_RATIO * TF_MS[tf]; });

  it('a synthetic venue serving ALL fast TFs from a ≥2× coarser candle is caught (0 faithful fast)', () => {
    const stranded = makeServedIntervalMs({ '3m': '1h', '5m': '1h', '15m': '1h', '30m': '1h' });
    expect(faithfulFast(stranded)).toEqual([]); // STRANDED — the invariant fires
  });
  it('a synthetic venue with even ONE native fast TF is NOT stranded (invariant does not over-fire)', () => {
    const ok = makeServedIntervalMs({ '3m': '1h', '5m': '1h', '15m': '15m', '30m': '1h' }); // 15m native
    expect(faithfulFast(ok)).toContain('15m');
    expect(faithfulFast(ok).length).toBeGreaterThan(0);
  });
});
