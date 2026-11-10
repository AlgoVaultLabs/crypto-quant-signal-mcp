// sr-probe/sr-features.ts — EDGE-SR-LEVEL-PROBE-W1: one row of Level-v0 features per corpus call.
//
//   npx tsx src/scripts/sr-probe/sr-features.ts --extract <extract.csv> --store <dir> --out <features.csv> --cells primary|descriptive
//
// Reads the LABEL-FREE extract and the candle store only — no label, no database, no network. Every stratum comes
// from level-v0.ts; this file only finds each call's bars and writes the result. Its output's sha256 is recorded
// before the label statement runs.
//
// A call is `ok` only when every layer the ladder gives it was fetched and is current at the call: a layer whose
// series is missing, failed or stale is never read as "no level there" — the call is dropped by name instead.

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { SR_VENUES } from './sr-extract-sql.js';
import { asOfBars, callFeatures, layerLevels, opposingLevels, V0, type Bar, type LayerSeries } from './level-v0.js';
import { applySampling, layersFor, PRIMARY_TIMEFRAMES, readCalls, seriesId, type Call } from './plan.js';
import { readSeries } from './store.js';

export const FEATURES_HEADER: readonly string[] = [
  'id', 'exchange', 'coin', 'timeframe', 'day', 'side', 'low_vol', 'status', 'l1_bars', 'l2_bars', 'l3_bars', 'l1_holes',
  'opposing', 'f', 'f_bin', 'behind', 'naive', 'opposing_strong', 'n_opposing', 'n_qualifying', 'xv_checked', 'xv_matched',
];

interface Loaded {
  status: 'ok' | 'failed' | 'missing';
  bars: Bar[]; // ascending by open time
  times: number[];
}

/** The bars of `s` that OPEN at or before `createdAtMs`, the last lookback + 2 — a speed window only; which of
 *  them the call may see is decided by level-v0's `asOfBars`. */
export function preWindow(s: Loaded, createdAtMs: number): Bar[] {
  let lo = 0;
  let hi = s.times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (s.times[mid] <= createdAtMs) lo = mid + 1;
    else hi = mid;
  }
  return s.bars.slice(Math.max(0, lo - (V0.lookbackBars + 2)), lo);
}

/** A layer is current when its newest as-of bar closed less than two served steps before the call. */
export function isCurrent(asOf: readonly Bar[], stepMs: number, createdAtMs: number): boolean {
  if (asOf.length === 0) return false;
  return createdAtMs - (asOf[asOf.length - 1].time + stepMs) < 2 * stepMs;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const extract = arg('--extract');
  const store = arg('--store');
  const out = arg('--out');
  const cells = arg('--cells');
  if (!extract || !store || !out || (cells !== 'primary' && cells !== 'descriptive')) {
    process.stderr.write('usage: sr-features.ts --extract <extract.csv> --store <dir> --out <features.csv> --cells primary|descriptive\n');
    process.exitCode = 2;
    return;
  }
  const all = readCalls(extract);
  const { kept } = applySampling(all);
  const keptIds = new Set(kept.map((c) => c.id));
  const inCells = (c: Call): boolean => PRIMARY_TIMEFRAMES.includes(c.timeframe) === (cells === 'primary');

  const cache = new Map<string, Loaded>();
  const load = (exchange: string, coin: string, stepMs: number): Loaded => {
    const id = seriesId(exchange, coin, stepMs);
    let s = cache.get(id);
    if (!s) {
      const raw = readSeries(store, { exchange, coin, stepMs });
      if (!raw) s = { status: 'missing', bars: [], times: [] };
      else {
        const bars = raw.bars.map(([time, open, high, low, close]) => ({ time, open, high, low, close })).sort((a, b) => a.time - b.time);
        s = { status: raw.status, bars, times: bars.map((b) => b.time) };
      }
      cache.set(id, s);
    }
    return s;
  };

  const lines: string[] = [FEATURES_HEADER.join(',')];
  const tally: Record<string, number> = {};
  const bump = (k: string): void => {
    tally[k] = (tally[k] ?? 0) + 1;
  };
  for (const c of all) {
    if (!inCells(c)) continue;
    const day = new Date(c.createdAt * 1000).toISOString().slice(0, 10);
    const head = [c.id, c.exchange, c.coin, c.timeframe, day, c.side, c.lowVol ? 1 : 0];
    const blank = (status: string): void => {
      lines.push([...head, status, '', '', '', '', '', '', '', '', '', '', '', '', '', ''].join(','));
      bump(status);
    };
    if (!keptIds.has(c.id)) {
      blank('not_sampled');
      continue;
    }
    const createdAtMs = c.createdAt * 1000;
    const specs = layersFor(c.exchange, c.timeframe);
    const layers: LayerSeries[] = [];
    let bad: string | null = null;
    for (const l of specs) {
      const s = load(c.exchange, c.coin, l.stepMs);
      if (s.status !== 'ok') {
        bad = `unresolved_${s.status}_L${l.layer}`;
        break;
      }
      const win = preWindow(s, createdAtMs);
      if (!isCurrent(asOfBars(win, l.stepMs, createdAtMs), l.stepMs, createdAtMs)) {
        bad = `unresolved_stale_L${l.layer}`;
        break;
      }
      layers.push({ layer: l.layer, stepMs: l.stepMs, bars: win });
    }
    if (bad) {
      blank(bad);
      continue;
    }
    const barrierDist = (c.entry * c.barrierPct) / 100;
    const ft = callFeatures(c.side, c.entry, barrierDist, createdAtMs, layers);
    const l1 = asOfBars(layers[0].bars, layers[0].stepMs, createdAtMs);
    const holes = l1.length === 0 ? 0 : Math.round((l1[l1.length - 1].time - l1[0].time) / layers[0].stepMs) + 1 - l1.length;

    // Cross-venue (descriptive): of this call's opposing levels, how many have a qualifying level within
    // 0.25 x ATR on ANOTHER venue's candles for the same coin, layer and served step, as of the same instant.
    let xvChecked = 0;
    let xvMatched = 0;
    const opp = opposingLevels(c.side, c.entry, barrierDist, ft.levels);
    if (opp.length > 0) {
      const other = new Map<number, Array<{ price: number }>[]>();
      for (const l of specs) {
        if (!opp.some((o) => o.layer === l.layer)) continue;
        const sets: Array<{ price: number }>[] = [];
        for (const v of SR_VENUES) {
          if (v === c.exchange) continue;
          const s = load(v, c.coin, l.stepMs);
          if (s.status !== 'ok') continue;
          const asOf = asOfBars(preWindow(s, createdAtMs), l.stepMs, createdAtMs);
          if (!isCurrent(asOf, l.stepMs, createdAtMs)) continue;
          sets.push(layerLevels(asOf, l.layer).filter((x) => x.touches >= V0.minTouches));
        }
        other.set(l.layer, sets);
      }
      for (const o of opp) {
        const sets = other.get(o.layer) ?? [];
        if (sets.length === 0) continue;
        xvChecked++;
        if (sets.some((set) => set.some((x) => Math.abs(x.price - o.price) <= V0.mergeAtrMult * o.atr))) xvMatched++;
      }
    }
    lines.push([
      ...head, 'ok', ft.layerBars[0], ft.layerBars[1], ft.layerBars[2], holes,
      ft.opposing ? 1 : 0, ft.f === null ? '' : ft.f.toFixed(6), ft.fBin, ft.behind ? 1 : 0, ft.naive ? 1 : 0,
      ft.opposingStrong ? 1 : 0, ft.nOpposing, ft.nQualifying, xvChecked, xvMatched,
    ].join(','));
    bump('ok');
  }
  const body = `${lines.join('\n')}\n`;
  fs.writeFileSync(out, body);
  const sha256 = createHash('sha256').update(body).digest('hex');
  process.stdout.write(`${JSON.stringify({ cells, rows: lines.length - 1, tally, sha256 }, null, 2)}\n`);
  // Constructed here, so emptiness here is vacuity: no resolved call means the store was not read.
  const ok = (tally.ok ?? 0) > 0;
  // exitCode, never process.exit(): a queued pipe write would lose the token.
  process.stdout.write(`SR_FEATURES_VERDICT=${ok ? 'PASS' : 'INDETERMINATE'}\n`);
  process.exitCode = ok ? 0 : 3;
}

if (require.main === module) main();
