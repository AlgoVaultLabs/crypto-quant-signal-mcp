/**
 * tests/unit/venue-candle-reach.test.ts — OPS-ALARM-OWNER-DERIVATION-W1 CH1 (AC1).
 *
 * ONE table answers "how far back does this venue still serve candles for this timeframe": the
 * PFE outcome backfill's queue, the canary's census and the directional labeler all read
 * `src/lib/venue-candle-reach.ts`. Three properties are pinned here:
 *
 *   1. VALUE IDENTITY. The move out of `backfill-directional-labels.ts` changes no number. The
 *      literals below are the table as it stood on `8087db29`; the relabel (EDGE-LABELER-RACE-
 *      WINDOW-V2-W1) and ADS-1 sit inside open registrations and must read byte-identical values.
 *   2. EXHAUSTIVE OVER ExchangeId. A venue without an entry does not compile — "served every row
 *      probed" is spelled `{}`, never by omission.
 *   3. THE SECOND TABLE'S DISAGREEMENTS ARE SHRINK-ONLY. `venue-candle-horizons.ts` is a second
 *      measurement of the same fact. Merging the two waits for LRW + ADS-1 to close; until then the
 *      7 in-scope conflicts are pinned exactly, so a NEW conflict fails and a RESOLVED one must be
 *      removed from the pin.
 *
 * SPAWN BUDGET DECLARED on the one spawning block (`scripts/check-test-budget.mjs`).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  VENUE_CANDLE_REACH_DAYS, EXPIRY_REACH_DAYS, EXPIRY_REACH_DAYS_MEASURED_AT, HL_CANDLE_DEPTH, REACH_MARGIN_S,
  expiryReachDays,
} from '../../src/lib/venue-candle-reach.js';
import * as labeler from '../../src/scripts/backfill-directional-labels.js';
import { CANDLE_HORIZON_DAYS } from '../../src/lib/venue-candle-horizons.js';

const REPO = path.resolve(__dirname, '../..');
const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** The table exactly as `backfill-directional-labels.ts:1147` held it on 8087db29 (measured 2026-09-27). */
const PRE_WAVE_EXPIRY_REACH_DAYS: Record<string, Record<string, number>> = {
  BINGX: { '3m': 2, '5m': 3.25, '15m': 10.25, '30m': 20.75, '1h': 41, '2h': 83 },
  BITGET: { '2h': 8.75, '8h': 51 },
  GATE: { '3m': 34.5, '5m': 34.5, '15m': 104 },
  HL: { '3m': 10.41, '5m': 17.36, '15m': 52.08, '30m': 104.16, '1h': 208.33 },
  HTX: { '3m': 3.25, '5m': 3.25, '15m': 10.25, '30m': 20.75, '1h': 41, '2h': 42 },
  MEXC: { '3m': 6.75, '5m': 6.75, '15m': 20.75, '30m': 41, '1h': 83, '2h': 83 },
  PHEMEX: { '3m': 3.25, '5m': 3.25, '15m': 10.25, '30m': 20.75, '1h': 41, '2h': 42 },
  WEEX: { '3m': 2.08, '5m': 3.47, '15m': 10.41, '30m': 20.83, '1h': 41.66, '2h': 83.33, '4h': 166.66 },
  WHITEBIT: { '5m': 10.25, '15m': 10.25, '30m': 20.75, '1h': 41, '2h': 42 },
  XT: { '3m': 3.25, '5m': 3.25, '15m': 10.25, '30m': 20.75, '1h': 41, '2h': 42 },
};

function exchangeIds(): string[] {
  const src = readFileSync(path.join(REPO, 'src/types.ts'), 'utf8');
  const m = /export type ExchangeId = ([^;]+);/.exec(src);
  if (!m) throw new Error('ExchangeId union not found in src/types.ts');
  return [...m[1].matchAll(/'([A-Z0-9]+)'/g)].map((x) => x[1]).sort();
}

describe('AC1 — value identity with the pre-wave labeler table', () => {
  it('EXPIRY_REACH_DAYS holds exactly the 2026-09-27 measurements, all 10 venues and every pair', () => {
    expect(EXPIRY_REACH_DAYS).toEqual(PRE_WAVE_EXPIRY_REACH_DAYS);
    expect(Object.keys(EXPIRY_REACH_DAYS)).toHaveLength(10);
    expect(Object.values(EXPIRY_REACH_DAYS).reduce((n, m) => n + Object.keys(m).length, 0)).toBe(52);
  });

  it('the margin, the depth and the measurement date are value-identical', () => {
    expect(REACH_MARGIN_S).toBe(3600);
    expect(HL_CANDLE_DEPTH).toBe(5000);
    expect(EXPIRY_REACH_DAYS_MEASURED_AT).toBe('2026-09-27');
  });

  it('the labeler re-exports the SAME objects — one table, not a copy', () => {
    expect(labeler.EXPIRY_REACH_DAYS).toBe(EXPIRY_REACH_DAYS);
    expect(labeler.expiryReachDays).toBe(expiryReachDays);
    expect(labeler.HL_CANDLE_DEPTH).toBe(HL_CANDLE_DEPTH);
    expect(labeler.EXPIRY_REACH_DAYS_MEASURED_AT).toBe(EXPIRY_REACH_DAYS_MEASURED_AT);
  });

  it('the labeler no longer DECLARES the table or the margin — it imports them', () => {
    const src = readFileSync(path.join(REPO, 'src/scripts/backfill-directional-labels.ts'), 'utf8');
    expect(src).not.toMatch(/^export const EXPIRY_REACH_DAYS\b/m);
    expect(src).not.toMatch(/^const REACH_MARGIN_S\s*=/m);
    expect(src).toMatch(/from '\.\.\/lib\/venue-candle-reach\.js'/);
  });

  it('expiryReachDays: absent ⇒ Infinity, present ⇒ the measured value', () => {
    expect(expiryReachDays('BINANCE', '1h')).toBe(Infinity);
    expect(expiryReachDays('HL', '5m')).toBe(17.36);
    expect(expiryReachDays('NOT_A_VENUE', '5m')).toBe(Infinity);
  });
});

describe('AC1 — exhaustive over ExchangeId', () => {
  it('VENUE_CANDLE_REACH_DAYS declares exactly the ExchangeId union, unbounded venues as {}', () => {
    expect(Object.keys(VENUE_CANDLE_REACH_DAYS).sort()).toEqual(exchangeIds());
    for (const v of exchangeIds()) {
      expect(VENUE_CANDLE_REACH_DAYS[v as keyof typeof VENUE_CANDLE_REACH_DAYS], v)
        .toEqual(PRE_WAVE_EXPIRY_REACH_DAYS[v] ?? {});
    }
  });

  it('tsc FAILS when any one venue is removed, and compiles when none is', { timeout: 120_000 }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'venue-reach-tsc-'));
    tmpDirs.push(dir);
    writeFileSync(path.join(dir, 'types.ts'),
      `export type ExchangeId = ${exchangeIds().map((v) => `'${v}'`).join(' | ')};\n`);
    const src = readFileSync(path.join(REPO, 'src/lib/venue-candle-reach.ts'), 'utf8')
      .replace("from '../types.js'", "from './types.js'");
    const tsc = path.join(REPO, 'node_modules/.bin/tsc');
    const compile = (body: string) => {
      writeFileSync(path.join(dir, 'venue-candle-reach.ts'), body);
      return spawnSync(tsc, ['--noEmit', '--strict', '--target', 'ES2022', '--module', 'Node16', '--moduleResolution',
        'Node16', path.join(dir, 'venue-candle-reach.ts')], { encoding: 'utf8' });
    };
    expect(compile(src).status).toBe(0);
    const removed = src.replace(/\n  KUCOIN: \{\},\n/, '\n');
    expect(removed).not.toBe(src);
    const r = compile(removed);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/KUCOIN/);
  });
});

describe('AC1 — the second table (venue-candle-horizons.ts) disagrees in exactly 7 pinned places', () => {
  /** In scope = the horizons table's own declared scope: pairs shallower than the labeler's 21-day reach. */
  const IN_SCOPE_DAYS = 21;
  // Remove an entry from this set when the two tables are reconciled for that pair; never add one.
  const PINNED_CONFLICTS = [
    'HL 5m value 17.36 vs 17.48',
    'WEEX 3m value 2.08 vs 3.25',
    'WEEX 5m value 3.47 vs 3.25',
    'WEEX 15m value 10.41 vs 10.25',
    'HL 3m missing from horizons (10.41)',
    'WEEX 30m missing from horizons (20.83)',
    'WHITEBIT 5m missing from horizons (10.25)',
  ];

  function conflicts(): string[] {
    const out: string[] = [];
    for (const [v, m] of Object.entries(EXPIRY_REACH_DAYS)) {
      for (const [tf, d] of Object.entries(m)) {
        const h = CANDLE_HORIZON_DAYS[v]?.[tf];
        if (h === undefined) {
          if (d < IN_SCOPE_DAYS) out.push(`${v} ${tf} missing from horizons (${d})`);
        } else if (h !== d) {
          out.push(`${v} ${tf} value ${d} vs ${h}`);
        }
      }
    }
    for (const [v, m] of Object.entries(CANDLE_HORIZON_DAYS)) {
      for (const tf of Object.keys(m)) {
        if (EXPIRY_REACH_DAYS[v]?.[tf] === undefined) out.push(`${v} ${tf} missing from reach`);
      }
    }
    return out.sort();
  }

  it('no NEW conflict (the set may only shrink)', () => {
    const extra = conflicts().filter((c) => !PINNED_CONFLICTS.includes(c));
    expect(extra, 'a new disagreement between the two reach tables').toEqual([]);
  });

  it('every pinned conflict still exists — a resolved one must be REMOVED from the pin', () => {
    const resolved = PINNED_CONFLICTS.filter((c) => !conflicts().includes(c));
    expect(resolved, 'reconciled pairs still listed in PINNED_CONFLICTS').toEqual([]);
    expect(PINNED_CONFLICTS).toHaveLength(7);
  });
});
