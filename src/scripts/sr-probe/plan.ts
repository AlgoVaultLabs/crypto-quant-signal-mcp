// sr-probe/plan.ts — EDGE-SR-LEVEL-PROBE-W1: what the probe reads, derived from the label-free extract alone.
// Pure: the layer ladder per venue x timeframe (Plan-Mode ruling Q2 = A), the candle series each call needs, the
// windows to fetch, and the request estimate the registration's sampling rule reads. No network, no label.

import fs from 'node:fs';
import { TF_MS } from '../directional-labeler.js';
import { servedCandleStepMs, servedTimeframes } from '../../lib/tf-support.js';
import type { ExchangeId } from '../../types.js';
import { LABELFREE_HEADER } from './sr-extract-sql.js';
import { V0 } from './level-v0.js';

export interface Call {
  id: number;
  createdAt: number; // epoch s
  exchange: string;
  coin: string;
  timeframe: string;
  side: 'BUY' | 'SELL';
  entry: number;
  barrierPct: number; // PERCENT, as stored
  lowVol: boolean;
}

/** The label-free extract, parsed strictly: the generator's header or a refusal. */
export function readCalls(path: string): Call[] {
  const lines = fs.readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0);
  if (lines[0] !== LABELFREE_HEADER.join(',')) throw new Error(`sr-probe/plan: ${path} does not carry the label-free header`);
  return lines.slice(1).map((l, i) => {
    const c = l.split(',');
    if (c.length !== LABELFREE_HEADER.length) throw new Error(`sr-probe/plan: row ${i + 2} has ${c.length} cells`);
    const side = c[5];
    if (side !== 'BUY' && side !== 'SELL') throw new Error(`sr-probe/plan: row ${i + 2} side '${side}'`);
    // Every call belongs to exactly one registered cell; a timeframe in neither list is a refusal, never "descriptive".
    if (!PRIMARY_TIMEFRAMES.includes(c[4]) && !DESCRIPTIVE_TIMEFRAMES.includes(c[4])) throw new Error(`sr-probe/plan: row ${i + 2} timeframe '${c[4]}' is in no registered cell`);
    const call: Call = {
      id: Number(c[0]), createdAt: Number(c[1]), exchange: c[2], coin: c[3], timeframe: c[4], side,
      entry: Number(c[6]), barrierPct: Number(c[8]), lowVol: c[9] === 't',
    };
    if (c[9] !== 't' && c[9] !== 'f') throw new Error(`sr-probe/plan: row ${i + 2} low_vol_history '${c[9]}'`);
    if (!(call.entry > 0) || !(call.barrierPct > 0) || !Number.isFinite(call.createdAt)) throw new Error(`sr-probe/plan: row ${i + 2} is not numeric`);
    return call;
  });
}

export interface LayerSpec {
  /** 1, 2 or 3. */
  layer: number;
  /** The served step of the layer's candles, ms. */
  stepMs: number;
  /** The timeframe key the series is read with: the first key the venue serves at that step. */
  key: string;
}

/** The distinct steps `venue` serves, ascending, each with the first product timeframe key that reads it. */
export function servedSteps(venue: string): Array<{ stepMs: number; key: string }> {
  const byStep = new Map<number, string>();
  for (const key of servedTimeframes(venue as ExchangeId)) {
    const step = servedCandleStepMs(venue, key);
    if (step !== null && !byStep.has(step)) byStep.set(step, key);
  }
  return [...byStep.entries()].map(([stepMs, key]) => ({ stepMs, key })).sort((a, b) => a.stepMs - b.stepMs);
}

/**
 * The layers of a call on `venue` x `tf`. L1 = the step the venue serves for the call's own timeframe. L2 / L3 =
 * the smallest step the venue serves that is >= 4x / >= 16x the call's NOMINAL timeframe; a layer with no such
 * step is absent. Never an invented interval.
 */
export function layersFor(venue: string, tf: string): LayerSpec[] {
  const nominal = TF_MS[tf];
  const l1 = servedCandleStepMs(venue, tf);
  if (nominal === undefined || l1 === null) throw new Error(`sr-probe/plan: ${venue} does not serve ${tf}`);
  const steps = servedSteps(venue);
  const keyOf = (stepMs: number): string => {
    const hit = steps.find((s) => s.stepMs === stepMs);
    if (!hit) throw new Error(`sr-probe/plan: ${venue} has no key for step ${stepMs}`);
    return hit.key;
  };
  const out: LayerSpec[] = [{ layer: 1, stepMs: l1, key: keyOf(l1) }];
  [4, 16].forEach((mult, i) => {
    const hit = steps.find((s) => s.stepMs >= mult * nominal);
    if (hit) out.push({ layer: i + 2, stepMs: hit.stepMs, key: hit.key });
  });
  return out;
}

export interface SeriesPlan {
  exchange: string;
  coin: string;
  stepMs: number;
  key: string;
  /** Merged [startMs, endMs] windows, ascending. */
  ranges: Array<[number, number]>;
  bars: number;
  calls: number;
}

export const seriesId = (exchange: string, coin: string, stepMs: number): string => `${exchange}|${coin}|${stepMs}`;

/** Bars one request returns on a historical read, per venue (the adapters' own page caps). */
export const PAGE_CAP: Readonly<Record<string, number>> = Object.freeze({ BINANCE: 200, BYBIT: 200, OKX: 100, BITGET: 200 });
/** Requests one historical page costs: OKX and BITGET try the recent endpoint before the history endpoint. */
export const REQ_PER_PAGE: Readonly<Record<string, number>> = Object.freeze({ BINANCE: 1, BYBIT: 1, OKX: 2, BITGET: 2 });

/** Every series the calls need, with its fetch windows: [created − (lookback + 1) steps, created], merged when the
 *  gap between two windows is at most one page. */
export function planSeries(calls: readonly Call[]): SeriesPlan[] {
  const windows = new Map<string, { exchange: string; coin: string; stepMs: number; key: string; w: Array<[number, number]> }>();
  for (const c of calls) {
    for (const l of layersFor(c.exchange, c.timeframe)) {
      const id = seriesId(c.exchange, c.coin, l.stepMs);
      let s = windows.get(id);
      if (!s) {
        s = { exchange: c.exchange, coin: c.coin, stepMs: l.stepMs, key: l.key, w: [] };
        windows.set(id, s);
      }
      const end = c.createdAt * 1000;
      s.w.push([end - (V0.lookbackBars + 1) * l.stepMs, end]);
    }
  }
  const out: SeriesPlan[] = [];
  for (const s of windows.values()) {
    const sorted = s.w.sort((a, b) => a[0] - b[0]);
    const slack = (PAGE_CAP[s.exchange] ?? 100) * s.stepMs;
    const ranges: Array<[number, number]> = [];
    for (const [a, b] of sorted) {
      const last = ranges[ranges.length - 1];
      if (last && a <= last[1] + slack) last[1] = Math.max(last[1], b);
      else ranges.push([a, b]);
    }
    // Align each start down to the step grid so a venue that snaps to its own grid returns the first bar.
    for (const r of ranges) r[0] = Math.floor(r[0] / s.stepMs) * s.stepMs;
    const bars = ranges.reduce((n, [a, b]) => n + Math.floor((b - a) / s.stepMs) + 1, 0);
    out.push({ exchange: s.exchange, coin: s.coin, stepMs: s.stepMs, key: s.key, ranges, bars, calls: sorted.length });
  }
  return out.sort((a, b) => b.stepMs - a.stepMs || a.exchange.localeCompare(b.exchange) || a.coin.localeCompare(b.coin));
}

/** Pages and requests a series costs (an upper estimate: one page per `PAGE_CAP` bars per range). */
export function seriesCost(s: SeriesPlan): { pages: number; requests: number } {
  const cap = PAGE_CAP[s.exchange] ?? 100;
  const pages = s.ranges.reduce((n, [a, b]) => n + Math.ceil((Math.floor((b - a) / s.stepMs) + 1) / cap), 0);
  return { pages, requests: pages * (REQ_PER_PAGE[s.exchange] ?? 1) };
}

/** The cells whose side mix lets the +3.0pp floor be reached (Plan-Mode ruling Q3 = B): BUY share <= 0.80. */
export const PRIMARY_TIMEFRAMES: readonly string[] = Object.freeze(['1h', '2h', '4h', '8h', '12h']);
export const DESCRIPTIVE_TIMEFRAMES: readonly string[] = Object.freeze(['3m', '5m', '15m', '30m', '1d']);

/** Seeded Fisher–Yates over a sorted copy (mulberry32) — the registered coin draw. */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  let a = seed >>> 0;
  const rnd = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** The per-venue request cap above which the registration draws a coin sample (ruling 5). */
export const REQUEST_CAP_PER_VENUE = 20_000;
export const SAMPLE_SEED = 20261110;

/**
 * Ruling 5, as applied: a venue whose full plan exceeds the cap keeps EVERY coin in the primary cells and a seeded
 * coin sample in the descriptive cells — coins taken in shuffled order while the venue's requests stay at or under
 * the cap. Returns the calls kept and, per venue, what the rule did.
 */
export function applySampling(calls: readonly Call[]): { kept: Call[]; venues: Record<string, { fullRequests: number; sampled: boolean; requests: number; coinsKept: number; coinsAll: number; callsDropped: number }> } {
  const venues: Record<string, { fullRequests: number; sampled: boolean; requests: number; coinsKept: number; coinsAll: number; callsDropped: number }> = {};
  const kept: Call[] = [];
  const reqOf = (cs: readonly Call[]): number => planSeries(cs).reduce((n, s) => n + seriesCost(s).requests, 0);
  for (const venue of [...new Set(calls.map((c) => c.exchange))].sort()) {
    const mine = calls.filter((c) => c.exchange === venue);
    const full = reqOf(mine);
    const primary = mine.filter((c) => PRIMARY_TIMEFRAMES.includes(c.timeframe));
    const descriptive = mine.filter((c) => !PRIMARY_TIMEFRAMES.includes(c.timeframe));
    const coinsAll = [...new Set(descriptive.map((c) => c.coin))].sort();
    if (full <= REQUEST_CAP_PER_VENUE) {
      kept.push(...mine);
      venues[venue] = { fullRequests: full, sampled: false, requests: full, coinsKept: coinsAll.length, coinsAll: coinsAll.length, callsDropped: 0 };
      continue;
    }
    // A series belongs to one coin, so a coin's marginal cost is its full plan minus its primary-only plan.
    const group = (cs: readonly Call[]): Map<string, Call[]> => {
      const m = new Map<string, Call[]>();
      for (const c of cs) {
        const g = m.get(c.coin);
        if (g) g.push(c);
        else m.set(c.coin, [c]);
      }
      return m;
    };
    const descByCoin = group(descriptive);
    const primByCoin = group(primary);
    const chosen: Call[] = [...primary];
    let requests = reqOf(primary);
    let coinsKept = 0;
    for (const coin of seededShuffle(coinsAll, SAMPLE_SEED)) {
      const prim = primByCoin.get(coin) ?? [];
      const desc = descByCoin.get(coin) ?? [];
      const marginal = reqOf([...prim, ...desc]) - reqOf(prim);
      if (requests + marginal > REQUEST_CAP_PER_VENUE) continue;
      chosen.push(...desc);
      requests += marginal;
      coinsKept++;
    }
    kept.push(...chosen);
    venues[venue] = { fullRequests: full, sampled: true, requests, coinsKept, coinsAll: coinsAll.length, callsDropped: mine.length - chosen.length };
  }
  return { kept: kept.sort((a, b) => a.id - b.id), venues };
}
