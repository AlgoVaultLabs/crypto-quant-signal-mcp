// lrw/disagreement.ts — EDGE-LABELER-RACE-WINDOW-V2-W1 CH3: the registered `-v1` vs `-v2` disagreement table
// (registration §4 measures, §4.1 strata, §5 floors, §6 cells, §8 states), computed off-DB from the read
// session's extract and the sha-pinned label-free strata. A DATA-QUALITY MEASUREMENT, not a directional test:
// nothing here is a p-value, an interval, an edge or a headline engine rate; comparators are the mix-matched null
// and the always-side shares, never max(); `cells_tested` is 0. Its outputs go to the PRIVATE vault only (the code
// repo is public — it carries no figure).
//
//   node dist/scripts/lrw/disagreement.js --extract <csv> --counts-apart <csv> --v2-without-v1 <csv> --pull-meta <txt>
//     --worklist <gz> --delta <gz> --crossed <gz> --retired-uc <csv> --adapter-before <csv> --manifest <log>[,<log>…]
//     --out-dir <dir>
//
// Every input is verified before a cell is computed: the pull's own verdict is PASS, its T_CUT is the pinned one,
// the extract / counts-apart / v2-without-v1 / manifest files are the ones the pull hashed, and each off-DB
// stratum is its registered sha256. Prints exactly one `LRW_DISAGREEMENT_VERDICT=PASS|INDETERMINATE` (exit 0 / 3):
// INDETERMINATE when an input cannot be read, parsed or verified — never a table over an unverified corpus.
//
// Coarser-served pairs (registration §0, §7 E4) are their own cells, per pair: they enter no pooled cell — not
// the fleet, a timeframe, a fleet-wide or per-timeframe stratum, a comparator roll-up or a headline. Neither does
// the BITGET 2h / 8h cell (registration amendment 2026-10-01, OPS-ADAPTER-HISTORY-ANCHOR-W1, ruling OAH-Q8): a
// twin whose `-v2` row was written at or after T_ADAPTER is "reached via adapter fix", its own cell; a row whose
// `-v2` row was written before T_ADAPTER (the pinned snapshot) keeps "unreachable pending" and is counted, never
// compared. A stratum fact the strata files do not carry for a row reads `unknown`, never the clean level.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { EXTRACT_HEADER, COUNTS_APART_HEADER, V2_WITHOUT_V1_HEADER } from './extract-sql.js';
import { ADAPTER_CELL, PINNED_SHA256, T_CUT_EPOCH } from './registered.js';
import { parseManifest } from './completeness.js';
import { deriveRaceOutcome } from '../dwr-baseline.js';
import { TF_MS } from '../directional-labeler.js';
import { servedCandleStepMs, SERVED_VENUES, CRON_TIMEFRAMES } from '../../lib/tf-support.js';
import { T_FLIP } from '../ads1/spec.js';

/** The registration's header clause, VERBATIM — the first thing in every report this wave writes (a test pins it
 *  byte-equal to the registration). */
export const HEADER_CLAUSE = "> ## ⚠️ HEADER CLAUSE — REPRODUCE VERBATIM AT THE TOP OF EVERY REPORT THIS WAVE WRITES\n>\n> **A `-v1` label is never edited, overwritten or deleted.** The corrected race is a new, versioned label series (`tau{0.5,1.0,2.0}-floor0.30-v2`) written **beside** `-v1`; every consumer migrates by an explicit wave of its own; nothing switches silently (AVS-1 §5, §9: values preserved, methodology versioned, changes published before they take effect).\n>\n> **The seal is respected in full.** Writing `-v2` for rows above `T_DIAG_END` is a mechanical label write, exactly like the nightly labeler's. Reading a label value above `T_CAP` is not: the disagreement table is computed **under `T_CAP` only**; above it, cardinalities (rows written, holes counted) and nothing else.\n>\n> **Three foreign consumers are flagged, not routed around:** the B-DIR v3 FULL test (registered on `-v1`; owner B-DIR v3 FULL / Cowork Main-AOE), the HOLD-discipline pre-registration (earliest read 2026-10-07; owner EDGE-HOLD-DISCIPLINE) if R0 finds the hold labeler shares the defect, and the DWR SoT digest / `dwr_baseline_runs` / AOE `edge_gate` + retune (pinned to `-v1`). Each gets a migration row in the consumer registry and a line in `status.md`; none is changed here.";

export const PRIMARY_SPEC = 'tau1.0-floor0.30-v1';
/** §5 floors. */
export const THIN_FLOOR = 30;
export const MIN_CLUSTER_DAYS = 20;
/** WEEX 30m / 12h rows computed before this were raced on 15m / 4h candles (§4.1). */
export const WEEX_V3_DEPLOYED = 1788432900;
const PHASE_PAIRS = new Set(['OKX:12h', 'OKX:1d', 'BITGET:8h', 'BITGET:12h', 'BITGET:1d', 'HTX:1d']);
const RETIRED = new Set(['BITMART', 'EDGEX']);

export interface ExtractRow {
  id: number; createdAt: number; exchange: string; coin: string; timeframe: string; side: 'BUY' | 'SELL';
  spec: string; labelV1: number; ambV1: boolean; lowvolV1: boolean; barrierV1: number; gapV1: number | null;
  computedV1: number; hasV2: boolean; labelV2: number | null; ambV2: boolean | null; barrierV2: number | null;
}

const bool = (x: string): boolean => {
  if (x === 't' || x === 'true') return true;
  if (x === 'f' || x === 'false') return false;
  throw new Error(`not a boolean: '${x}'`);
};
const num = (x: string): number => {
  const n = Number(x);
  if (x === '' || !Number.isFinite(n)) throw new Error(`not a number: '${x}'`);
  return n;
};
const optNum = (x: string): number | null => (x === '' ? null : num(x));

/** Split CSV text whose first line must be exactly `header`; every row must have its width. Refuses otherwise. */
export function csvRows(text: string, header: readonly string[], name: string): string[][] {
  const lines = text.split('\n').filter((l) => l.length > 0);
  if (lines[0] !== header.join(',')) throw new Error(`${name}: header '${lines[0]}' is not '${header.join(',')}'`);
  return lines.slice(1).map((l, i) => {
    const c = l.split(',');
    if (c.length !== header.length) throw new Error(`${name}:${i + 2}: ${c.length} fields, want ${header.length}`);
    return c;
  });
}

export function parseExtract(text: string): ExtractRow[] {
  return csvRows(text, EXTRACT_HEADER, 'extract').map((c) => {
    const side = c[5];
    if (side !== 'BUY' && side !== 'SELL') throw new Error(`extract: side '${side}'`);
    const hasV2 = bool(c[13]);
    return {
      id: num(c[0]), createdAt: num(c[1]), exchange: c[2], coin: c[3], timeframe: c[4], side,
      spec: c[6], labelV1: num(c[7]), ambV1: bool(c[8]), lowvolV1: bool(c[9]), barrierV1: num(c[10]),
      gapV1: optNum(c[11]), computedV1: num(c[12]), hasV2,
      labelV2: hasV2 ? num(c[14]) : null, ambV2: hasV2 ? bool(c[15]) : null, barrierV2: hasV2 ? num(c[16]) : null,
    };
  });
}

/** The off-DB strata, keyed `${signal_id}|${spec_v1}` (the manifest by signal — a refusal is per window). */
export interface Strata {
  worklist: Map<string, { sigmaHoles: number; ambiguousUc: number; forming: number }>;
  delta: Map<string, { sigmaHoles: number }>;
  crossed: Map<string, number>;
  retiredUc: Set<string>;
  manifest: Map<number, string>;
  /** BITGET 2h / 8h rows whose `-v2` row was written before T_ADAPTER, keyed `${signal_id}|${spec_v1}`. */
  adapterBefore: Set<string>;
}

/** Parse the strata. Each file must carry at least one row (a header-only file is a wrong file, not an empty
 *  stratum); the manifest parses through the ONE manifest reader, which refuses an unregistered class. */
export function parseStrata(input: { worklist: string; delta: string; crossed: string; retiredUc: string; adapterBefore: string; manifest: readonly string[] }): Strata {
  const idx = (header: string[], name: string, file: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`${file}: no column ${name}`);
    return i;
  };
  const table = (text: string, file: string) => {
    const lines = text.split('\n').filter((l) => l.length > 0);
    if (lines.length < 2) throw new Error(`${file}: no data row`);
    return { header: lines[0].split(','), rows: lines.slice(1).map((l) => l.split(',')) };
  };
  const wl = table(input.worklist, 'worklist');
  const [wId, wSpec, wSig, wAmb, wForm] = ['signal_id', 'barrier_spec', 'sigma_holes_L', 'ambiguous_L_Uc', 'forming'].map((n) => idx(wl.header, n, 'worklist'));
  const worklist = new Map(wl.rows.map((r) => [`${num(r[wId])}|${r[wSpec]}`, { sigmaHoles: num(r[wSig]), ambiguousUc: num(r[wAmb]), forming: num(r[wForm]) }]));
  const dl = table(input.delta, 'delta');
  const [dId, dSpec, dSig] = ['signal_id', 'barrier_spec', 'sigma_holes_L'].map((n) => idx(dl.header, n, 'delta'));
  const delta = new Map(dl.rows.map((r) => [`${num(r[dId])}|${r[dSpec]}`, { sigmaHoles: num(r[dSig]) }]));
  const cr = table(input.crossed, 'crossed');
  const [cId, cSpec, cX] = ['signal_id', 'barrier_spec', 'crossed_L'].map((n) => idx(cr.header, n, 'crossed'));
  const crossed = new Map(cr.rows.map((r) => [`${num(r[cId])}|${r[cSpec]}`, num(r[cX])]));
  const ru = table(input.retiredUc, 'retired-uc');
  const [rId, rSpec] = ['signal_id', 'barrier_spec'].map((n) => idx(ru.header, n, 'retired-uc'));
  const retiredUc = new Set(ru.rows.map((r) => `${num(r[rId])}|${r[rSpec]}`));
  const manifest = new Map<number, string>(parseManifest(input.manifest));
  // the pinned pre-T_ADAPTER snapshot may hold no row in principle (it is pinned by sha, not judged by size); its
  // rows carry the -v2 spec, keyed here on the -v1 twin's spec
  const ab = input.adapterBefore.split('\n').filter((l) => l.length > 0);
  if (ab[0] !== 'signal_id,barrier_spec') throw new Error(`adapter-before: header '${ab[0] ?? ''}' is not 'signal_id,barrier_spec'`);
  const adapterBefore = new Set(ab.slice(1).map((l) => {
    const [id, spec] = l.split(',');
    if (!/-v2$/.test(spec ?? '')) throw new Error(`adapter-before: '${l.slice(0, 60)}' is not a -v2 row`);
    return `${num(id)}|${spec.replace(/-v2$/, '-v1')}`;
  }));
  return { worklist, delta, crossed, retiredUc, manifest, adapterBefore };
}

export type GridClass = 'same' | 'finer' | 'coarser';
export function gridClass(exchange: string, timeframe: string): GridClass {
  const req = TF_MS[timeframe];
  const served = servedCandleStepMs(exchange, timeframe) ?? req;
  return served === req ? 'same' : served < req ? 'finer' : 'coarser';
}

type Tri = 'yes' | 'no' | 'unknown';
const tri = (known: boolean, v: boolean): Tri => (!known ? 'unknown' : v ? 'yes' : 'no');

/** The §4.1 strata of one row — label-free facts only. A fact the strata files do not hold for the row is
 *  `unknown` (the delta replay carries no ambiguity / forming column; an unannotated row has no race gap). */
export interface Axes {
  gap: '0' | '1' | '2' | '3+' | 'unannotated';
  gapDetail: string;
  sigmaChanged: Tri;
  crossed: 'no-race-hole' | 'zero-crossed' | 'crossed' | 'unknown';
  grid: GridClass;
  weexPre: boolean;
  phase: boolean;
  adapterCell: boolean;
  modelAmbiguity: Tri;
  provenance: 'replay' | 'delta' | 'none';
  forming: Tri;
}

export function axesOf(r: ExtractRow, s: Strata): Axes {
  const key = `${r.id}|${r.spec}`;
  const wl = s.worklist.get(key);
  const dl = s.delta.get(key);
  const grid = gridClass(r.exchange, r.timeframe);
  const g = r.gapV1;
  const crossedL = s.crossed.get(key);
  const holes = wl?.sigmaHoles ?? dl?.sigmaHoles;
  return {
    gap: g === null ? 'unannotated' : g === 0 ? '0' : g === 1 ? '1' : g === 2 ? '2' : '3+',
    gapDetail: g === null ? 'unannotated' : String(g),
    // a coarser pair's -v1 σ history was bounded on the requested step — changed by construction
    sigmaChanged: grid === 'coarser' ? 'yes' : tri(holes !== undefined, (holes ?? 0) > 0),
    crossed: g === null ? 'unknown' : g === 0 ? 'no-race-hole' : crossedL === undefined ? 'unknown' : crossedL === 0 ? 'zero-crossed' : 'crossed',
    grid,
    weexPre: r.exchange === 'WEEX' && (r.timeframe === '30m' || r.timeframe === '12h') && r.computedV1 < WEEX_V3_DEPLOYED,
    phase: PHASE_PAIRS.has(`${r.exchange}:${r.timeframe}`),
    adapterCell: ADAPTER_CELL.has(`${r.exchange}:${r.timeframe}`),
    modelAmbiguity: s.retiredUc.has(key) ? 'yes' : tri(wl !== undefined, wl?.ambiguousUc === 1),
    provenance: wl ? 'replay' : dl ? 'delta' : 'none',
    forming: tri(wl !== undefined, wl?.forming === 1),
  };
}

const LABELS = [1, -1, 0] as const;
type Lab = (typeof LABELS)[number];

/** One cell's accumulators — counts only until it is read. */
export interface Acc {
  registered: number; lowvol: number; twins: number; nonTwin: Record<string, number>;
  differ: number; transition: Record<string, number>; nonTwinByV1: Record<string, number>;
  decidedV1: number; decidedV2: number; ambV1: number; ambV2: number; ratios: number[];
}
export function newAcc(): Acc {
  return { registered: 0, lowvol: 0, twins: 0, nonTwin: {}, differ: 0, transition: {}, nonTwinByV1: {}, decidedV1: 0, decidedV2: 0, ambV1: 0, ambV2: 0, ratios: [] };
}
const nonTwinClass = (r: ExtractRow, s: Strata): string => {
  if (RETIRED.has(r.exchange)) return 'unreachable:retired';
  if (s.adapterBefore.has(`${r.id}|${r.spec}`)) return 'unreachable:adapter-pending';
  return s.manifest.get(r.id) ?? 'not-reached';
};
export function addRow(a: Acc, r: ExtractRow, s: Strata): void {
  a.registered++;
  if (r.lowvolV1) { a.lowvol++; return; }
  if (!r.hasV2) {
    const cls = nonTwinClass(r, s);
    a.nonTwin[cls] = (a.nonTwin[cls] ?? 0) + 1;
    const k = `${r.labelV1}|${cls.split(':')[0]}`;
    a.nonTwinByV1[k] = (a.nonTwinByV1[k] ?? 0) + 1;
    return;
  }
  a.twins++;
  const v2 = r.labelV2 as Lab;
  if (v2 !== r.labelV1) a.differ++;
  const t = `${r.labelV1}>${v2}`;
  a.transition[t] = (a.transition[t] ?? 0) + 1;
  if (r.labelV1 !== 0) a.decidedV1++;
  if (v2 !== 0) a.decidedV2++;
  if (r.ambV1) a.ambV1++;
  if (r.ambV2) a.ambV2++;
  if (r.barrierV1 > 0 && r.barrierV2 !== null) a.ratios.push(r.barrierV2 / r.barrierV1);
}

const median = (xs: number[]): number => {
  const v = [...xs].sort((p, q) => p - q);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

/** §4 measures of a cell under the §5 floors: no row → EMPTY, rows but zero twins → UNDEFINED (never 0 %),
 *  < 30 twins → thin (counts only). */
export function readAcc(a: Acc): Record<string, unknown> {
  const base = { registered: a.registered, low_vol_excluded: a.lowvol, twins: a.twins, non_twins: a.nonTwin };
  if (a.twins === 0) return { ...base, status: a.registered > 0 ? 'UNDEFINED' : 'EMPTY' };
  if (a.twins < THIN_FLOOR) return { ...base, status: 'thin', transition: a.transition, non_twin_by_v1: a.nonTwinByV1 };
  return {
    ...base,
    status: 'ok',
    p_differ: a.differ / a.twins,
    differ: a.differ,
    transition: a.transition,
    non_twin_by_v1: a.nonTwinByV1,
    decided_share_v1: a.decidedV1 / a.twins,
    decided_share_v2: a.decidedV2 / a.twins,
    decided_share_delta: (a.decidedV2 - a.decidedV1) / a.twins,
    same_candle_share_delta: (a.ambV2 - a.ambV1) / a.twins,
    barrier_ratio_median: a.ratios.length ? median(a.ratios) : null,
    barrier_ratio_share_ne_1: a.ratios.length ? a.ratios.filter((x) => Math.abs(x - 1) > 1e-9).length / a.ratios.length : null,
  };
}

type Cmp = { q_buy: number; q_sell: number; p0: number; decided: number };
/** Always-BUY / always-SELL decided hit shares and the mix-matched null of a set of twins, under one version. A
 *  same-candle race loses for both sides (deriveRaceOutcome); timeouts are not decided. null when nothing decided. */
function comparatorOf(rs: readonly ExtractRow[], v: 'v1' | 'v2'): Cmp | null {
  let up = 0, lo = 0, amb = 0, buy = 0;
  for (const r of rs) {
    const label = v === 'v1' ? r.labelV1 : (r.labelV2 as number);
    const isAmb = v === 'v1' ? r.ambV1 : !!r.ambV2;
    const o = deriveRaceOutcome(r.side, label, isAmb);
    if (o === 'timeout') continue;
    if (o === 'upper') up++; else if (o === 'lower') lo++; else amb++;
    if (r.side === 'BUY') buy++;
  }
  const decided = up + lo + amb;
  if (decided === 0) return null;
  const qBuy = up / decided;
  const qSell = lo / decided;
  const shareBuy = buy / decided;
  return { q_buy: qBuy, q_sell: qSell, p0: shareBuy * qBuy + (1 - shareBuy) * qSell, decided };
}
const KEYS = ['q_buy', 'q_sell', 'p0'] as const;

/** The comparators of a roll-up (twins, low-vol excluded), under each version, pooled with the -v2 − -v1 delta;
 *  and the unweighted per-UTC-day means — of each version AND of the per-day delta — over the SAME days: days
 *  with ≥ 30 twins on which both versions decide something. Fewer than 20 such days → under-clustered (pooled
 *  only). */
export function comparators(rows: readonly ExtractRow[]): Record<string, unknown> {
  const twins = rows.filter((r) => r.hasV2 && !r.lowvolV1);
  const v1 = comparatorOf(twins, 'v1');
  const v2 = comparatorOf(twins, 'v2');
  const pooledDelta = v1 && v2 ? Object.fromEntries(KEYS.map((k) => [k, v2[k] - v1[k]])) : null;
  const byDay = new Map<string, ExtractRow[]>();
  for (const r of twins) {
    const d = new Date(r.createdAt * 1000).toISOString().slice(0, 10);
    const list = byDay.get(d);
    if (list) list.push(r); else byDay.set(d, [r]);
  }
  const qualifying = [...byDay.values()].filter((d) => d.length >= THIN_FLOOR);
  const used = qualifying.map((d) => ({ v1: comparatorOf(d, 'v1'), v2: comparatorOf(d, 'v2') }))
    .filter((d): d is { v1: Cmp; v2: Cmp } => d.v1 !== null && d.v2 !== null);
  let perDay: unknown = { status: 'under-clustered', days_qualifying: qualifying.length, days_used: used.length };
  if (used.length >= MIN_CLUSTER_DAYS) {
    const mean = (f: (d: { v1: Cmp; v2: Cmp }) => number) => used.reduce((p, d) => p + f(d), 0) / used.length;
    perDay = {
      status: 'ok', days_qualifying: qualifying.length, days_used: used.length,
      v1: Object.fromEntries(KEYS.map((k) => [k, mean((d) => d.v1[k])])),
      v2: Object.fromEntries(KEYS.map((k) => [k, mean((d) => d.v2[k])])),
      delta: Object.fromEntries(KEYS.map((k) => [k, mean((d) => d.v2[k] - d.v1[k])])),
    };
  }
  return { twins: twins.length, pooled: { v1, v2 }, pooled_delta: pooledDelta, per_day: perDay };
}

/** The registered cells (§6) over the POOLED rows (coarser-served pairs excluded), as predicates over the axes.
 *  E1 / E2 / E3 need every condition KNOWN: an `unknown` fact is never read as the clean level. */
export const E_CELLS: Record<string, (x: Axes) => boolean> = {
  'E1 noise floor': (x) => x.gap === '0' && x.sigmaChanged === 'no' && x.grid === 'same' && !x.weexPre && !x.phase && x.modelAmbiguity === 'no' && x.forming === 'no',
  'E2 race-invariant': (x) => x.crossed === 'zero-crossed' && x.sigmaChanged === 'no',
  'E3 gap 1 (same grid, sigma unchanged)': (x) => x.grid === 'same' && x.sigmaChanged === 'no' && x.gap === '1',
  'E3 gap 2 (same grid, sigma unchanged)': (x) => x.grid === 'same' && x.sigmaChanged === 'no' && x.gap === '2',
  'E3 gap 3+ (same grid, sigma unchanged)': (x) => x.grid === 'same' && x.sigmaChanged === 'no' && x.gap === '3+',
  'E5 BITGET 2h/8h reached via adapter fix': (x) => x.adapterCell,
};
/** E4: one cell per coarser-served pair (registration §7: the horizon change is disclosed per pair) — derived from
 *  the served table here (a test pins it to the labeller's coarserV1LagTable), never by importing the writer: this
 *  file is an entrypoint, and the writer's batch-caller names must stay emitted by the writer alone. */
export const E4_PAIRS: readonly string[] = SERVED_VENUES.flatMap((v) => CRON_TIMEFRAMES.filter((tf) => gridClass(v, tf) === 'coarser').map((tf) => `${v}:${tf}`)).sort();

// the BITGET 2h / 8h cell is no stratum of a pooled cell (amendment 2026-10-01): it is its own registered cell (E5)
const DIMS = ['gap', 'gapDetail', 'sigmaChanged', 'crossed', 'grid', 'weexPre', 'phase', 'modelAmbiguity', 'provenance'] as const;

export interface Cell { key: Record<string, string>; read: Record<string, unknown> }
export interface Table {
  meta: Record<string, unknown>;
  headline: Record<string, unknown>;
  sensitivity: Array<Record<string, unknown>>;
  expectations: Array<Record<string, unknown>>;
  coverage: Record<string, unknown>;
  cells: Cell[];
  comparators: Cell[];
}

/** The headline form (§4) of one spec × window, over its pooled twins: where the flips sit by hole count. */
export function headlineOf(twins: readonly ExtractRow[], spec: string, window: string): Record<string, unknown> {
  const flips = twins.filter((r) => r.labelV2 !== r.labelV1);
  const byGap: Record<string, number> = {};
  for (const r of flips) { const g = r.gapV1 === null ? 'unannotated' : String(r.gapV1); byGap[g] = (byGap[g] ?? 0) + 1; }
  const levels = Object.keys(byGap).filter((k) => k !== 'unannotated').map(Number).sort((p, q) => q - p);
  const atLeast = (share: number): number | null => {
    let acc = 0;
    for (const g of levels) { acc += byGap[String(g)]; if (acc >= share * flips.length) return g; }
    return null;
  };
  return {
    spec, window,
    n: twins.length,
    k: flips.length,
    share: twins.length ? flips.length / twins.length : null,
    flips_by_race_gap: byGap,
    hole_count_holding_half_the_flips_at_or_above: atLeast(0.5),
    hole_count_holding_90pct_of_flips_at_or_above: atLeast(0.9),
    line: twins.length
      ? `of ${twins.length} -v1 labels under T_CAP with a -v2 twin (same-grid and finer-served; coarser-served pairs and BITGET 2h/8h apart), ` +
        `${flips.length} (${((100 * flips.length) / twins.length).toFixed(2)} %) differ; ` +
        `half the flips sit at hole-count >= ${atLeast(0.5)} (90 % at >= ${atLeast(0.9)})`
      : 'no twin under T_CAP — UNDEFINED',
  };
}

/** §8 states where the registration fixes the reading mechanically (E3 monotone); E1 / E2 / E4 are printed with
 *  their cells for the architect's reading (no numeric tolerance is registered for "≈"); E5's expectation ("no
 *  twins") was amended away 2026-10-01 (OAH-Q8) — the cell is printed as its own, never judged against it. */
function expectationsOf(cells: readonly Cell[], spec: string, window: string): Array<Record<string, unknown>> {
  const reg = (name: string) => cells.find((c) => c.key.spec === spec && c.key.window === window && c.key.registered_cell === name)!.read;
  const out: Array<Record<string, unknown>> = [];
  const e3 = ['1', '2', '3+'].map((g) => ({ g, r: reg(`E3 gap ${g} (same grid, sigma unchanged)`) }));
  const notOk = e3.filter((x) => x.r.status !== 'ok');
  if (notOk.length) out.push({ spec, window, expectation: 'E3', state: 'indeterminate', cause: notOk.map((x) => `gap ${x.g}: ${x.r.status}`).join('; ') });
  else {
    const p = e3.map((x) => x.r.p_differ as number);
    const broken = [p[0] > p[1] ? 'gap 1 > gap 2' : '', p[1] > p[2] ? 'gap 2 > gap 3+' : ''].filter(Boolean);
    out.push({ spec, window, expectation: 'E3', state: broken.length ? 'inconsistent' : 'consistent', cells: broken });
  }
  out.push({ spec, window, expectation: 'E5', state: 'amended 2026-10-01 (OAH-Q8) — read as its own cell, the architect reads it', cells: ['E5 BITGET 2h/8h reached via adapter fix'] });
  for (const e of ['E1 noise floor', 'E2 race-invariant']) {
    const r = reg(e);
    out.push({ spec, window, expectation: e.slice(0, 2), state: r.status === 'ok' ? 'reported — the architect reads it' : 'indeterminate', cause: r.status === 'ok' ? undefined : String(r.status) });
  }
  out.push({ spec, window, expectation: 'E4', state: 'reported per pair — the architect reads it', cells: E4_PAIRS.map((p) => `E4 coarser ${p}`) });
  return out;
}

/** The whole registered table. Windows never pooled; specs never pooled; coarser-served pairs never pooled.
 *  Pure on its inputs. */
export function buildTable(input: {
  rows: ExtractRow[]; strata: Strata; countsApart: string[][]; v2WithoutV1: string[][]; meta: Record<string, unknown>;
}): Table {
  const { strata } = input;
  // amendment 2026-10-01 (OAH-Q8): a BITGET 2h / 8h row whose -v2 row was written before T_ADAPTER keeps
  // "unreachable pending" — counted as a non-twin of that class, its label pair never compared
  const rows = input.rows.map((r) => (ADAPTER_CELL.has(`${r.exchange}:${r.timeframe}`) && strata.adapterBefore.has(`${r.id}|${r.spec}`)
    ? { ...r, hasV2: false, labelV2: null, ambV2: null, barrierV2: null }
    : r));
  const axes = new Map<ExtractRow, Axes>();
  for (const r of rows) axes.set(r, axesOf(r, strata));
  const ax = (r: ExtractRow) => axes.get(r)!;
  const windows: Array<[string, (r: ExtractRow) => boolean]> = [['FULL', () => true], ['POST_FLIP', (r) => r.createdAt > T_FLIP]];
  const specs = [...new Set(rows.map((r) => r.spec))].sort();
  const cells: Cell[] = [];
  const comps: Cell[] = [];
  const heads: Array<Record<string, unknown>> = [];
  const expectations: Array<Record<string, unknown>> = [];
  const group = (sel: readonly ExtractRow[], keyOf: (r: ExtractRow) => string, base: Record<string, string>, dim: string) => {
    const m = new Map<string, Acc>();
    for (const r of sel) {
      const k = keyOf(r);
      let a = m.get(k);
      if (!a) { a = newAcc(); m.set(k, a); }
      addRow(a, r, strata);
    }
    for (const [k, a] of [...m.entries()].sort()) cells.push({ key: { ...base, [dim]: k }, read: readAcc(a) });
  };
  /** A registered cell is ALWAYS printed — EMPTY when no row occupies it, never silently absent. */
  const fixed = (sel: readonly ExtractRow[], name: string, base: Record<string, string>) => {
    const a = newAcc();
    for (const r of sel) addRow(a, r, strata);
    cells.push({ key: { ...base, registered_cell: name }, read: readAcc(a) });
  };
  for (const spec of specs) {
    for (const [w, inW] of windows) {
      const sel = rows.filter((r) => r.spec === spec && inW(r));
      const pooled = sel.filter((r) => ax(r).grid !== 'coarser' && !ax(r).adapterCell);
      const base = { spec, window: w };
      group(pooled, () => 'fleet', base, 'cell');
      group(pooled, (r) => r.timeframe, base, 'timeframe');
      // a (timeframe, venue) cell is one grid class — coarser pairs appear here, each apart
      group(sel, (r) => `${r.timeframe}|${r.exchange}`, base, 'timeframe|venue');
      for (const dim of DIMS) {
        group(pooled, (r) => String(ax(r)[dim]), base, dim);
        group(pooled, (r) => `${r.timeframe}|${String(ax(r)[dim])}`, base, `timeframe|${dim}`);
        group(sel, (r) => `${r.timeframe}|${r.exchange}|${String(ax(r)[dim])}`, base, `timeframe|venue|${dim}`);
      }
      for (const [name, pred] of Object.entries(E_CELLS)) {
        fixed((name.startsWith('E5') ? sel : pooled).filter((r) => pred(ax(r))), name, base);
      }
      for (const pair of E4_PAIRS) fixed(sel.filter((r) => `${r.exchange}:${r.timeframe}` === pair), `E4 coarser ${pair}`, base);
      comps.push({ key: { ...base, rollup: 'fleet (coarser-served and BITGET 2h/8h apart)' }, read: comparators(pooled) });
      for (const tf of [...new Set(pooled.map((r) => r.timeframe))].sort()) {
        comps.push({ key: { ...base, rollup: `timeframe ${tf} (coarser-served and BITGET 2h/8h apart)` }, read: comparators(pooled.filter((r) => r.timeframe === tf)) });
      }
      heads.push(headlineOf(pooled.filter((r) => r.hasV2 && !r.lowvolV1), spec, w));
      expectations.push(...expectationsOf(cells, spec, w));
    }
  }
  const headline = heads.find((h) => h.spec === PRIMARY_SPEC && h.window === 'FULL') ?? headlineOf([], PRIMARY_SPEC, 'FULL');
  const coverage = {
    registered_rows: rows.length,
    counts_apart: input.countsApart.map((c) => Object.fromEntries(COUNTS_APART_HEADER.map((h, i) => [h, c[i]]))),
    v2_without_v1: input.v2WithoutV1.map((c) => Object.fromEntries(V2_WITHOUT_V1_HEADER.map((h, i) => [h, c[i]]))),
  };
  return { meta: input.meta, headline, sensitivity: heads.filter((h) => h !== headline), expectations, coverage, cells, comparators: comps };
}

const fmt = (x: unknown): string => (typeof x === 'number' ? (Number.isInteger(x) ? String(x) : x.toFixed(4)) : String(x ?? ''));

/** The vault report: the header clause verbatim, the headline and its sensitivity lines, the §8 states, every
 *  registered cell and the strata tables. */
export function renderMarkdown(t: Table): string {
  const out: string[] = [HEADER_CLAUSE, ''];
  out.push('# EDGE-LABELER-RACE-WINDOW-V2-W1 — the `-v1` vs `-v2` disagreement table (registered; under T_CAP)', '');
  out.push('> A DATA-QUALITY MEASUREMENT, not a directional test (`cells_tested = 0`). Private vault only. Comparators are the mix-matched null and the always-side decided shares; never an edge, never max(). Coarser-served pairs and the BITGET 2h/8h cell (amendment 2026-10-01, OAH-Q8) are their own cells and enter no pooled line.', '');
  out.push('## Meta', '', '```json', JSON.stringify(t.meta, null, 1), '```', '');
  out.push('## Headline (FULL, primary spec, pooled twins, low-vol excluded)', '', `**${t.headline.line}**`, '', '```json', JSON.stringify(t.headline, null, 1), '```', '');
  out.push('## Sensitivity lines (the other specs × windows, same form)', '', ...t.sensitivity.map((h) => `- ${h.spec} · ${h.window}: ${h.line}`), '');
  out.push('## §8 states', '', '| spec | window | expectation | state | cells / cause |', '|---|---|---|---|---|',
    ...t.expectations.map((e) => `| ${e.spec} | ${e.window} | ${e.expectation} | ${e.state} | ${Array.isArray(e.cells) ? (e.cells as string[]).join('; ') : fmt(e.cause)} |`), '');
  const row = (c: Cell) => {
    const r = c.read;
    return `| ${Object.values(c.key).join(' · ')} | ${fmt(r.registered)} | ${fmt(r.twins)} | ${fmt(r.low_vol_excluded)} | ${fmt(r.status)} | ${fmt(r.p_differ)} | ${fmt(r.decided_share_delta)} | ${fmt(r.same_candle_share_delta)} | ${fmt(r.barrier_ratio_median)} | ${fmt(r.barrier_ratio_share_ne_1)} |`;
  };
  const head = '| cell | registered | twins | low-vol excl. | status | P(differ) | decided Δ | same-candle Δ | barrier ratio med | ratio ≠ 1 |\n|---|---|---|---|---|---|---|---|---|---|';
  const sections: Array<[string, string]> = [
    ['Registered cells (§6)', 'registered_cell'], ['Fleet (coarser-served and BITGET 2h/8h apart)', 'cell'], ['By timeframe (coarser-served and BITGET 2h/8h apart)', 'timeframe'],
    ...DIMS.map((d): [string, string] => [`By ${d} (coarser-served and BITGET 2h/8h apart)`, d]),
    ['Timeframe × venue', 'timeframe|venue'],
    ...DIMS.map((d): [string, string] => [`Timeframe × ${d}`, `timeframe|${d}`]),
    ...DIMS.map((d): [string, string] => [`Timeframe × venue × ${d}`, `timeframe|venue|${d}`]),
  ];
  for (const [title, dim] of sections) {
    const cs = t.cells.filter((c) => dim in c.key);
    if (!cs.length) continue;
    out.push(`## ${title}`, '', head, ...cs.map(row), '');
  }
  out.push('## Comparators (roll-ups)', '', '```json', JSON.stringify(t.comparators, null, 1), '```', '');
  out.push('## Coverage', '', '```json', JSON.stringify(t.coverage, null, 1), '```', '');
  return out.join('\n');
}

function arg(argv: string[], f: string): string {
  const i = argv.indexOf(f);
  if (i < 0 || i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`missing ${f}`);
  return argv[i + 1];
}
const readText = (p: string): string => (p.endsWith('.gz') ? gunzipSync(readFileSync(p)).toString('utf8') : readFileSync(p, 'utf8'));
const sha = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');

/** The pull's own record (scripts/lrw/lrw-pull.sh writes it): its verdict, its T_CUT and the sha256 of every file
 *  it produced or was handed. Refuses a pull that did not PASS or ran on another cut. */
export function parsePullMeta(text: string): { tCut: number; shas: Map<string, string>; manifestShas: Set<string> } {
  const lines = text.split('\n');
  if (!lines.includes('LRW_PULL_VERDICT=PASS')) throw new Error('pull-meta: the pull did not PASS');
  const tl = lines.find((l) => l.startsWith('t_cut='));
  const tCut = tl === undefined ? Number.NaN : Number(tl.slice(6));
  if (tCut !== T_CUT_EPOCH) throw new Error(`pull-meta: t_cut '${tl ?? ''}' is not the pinned T_CUT ${T_CUT_EPOCH}`);
  const shas = new Map<string, string>();
  for (const l of lines) {
    const m = l.match(/^([0-9a-f]{64})  (\S+)$/);
    if (m) shas.set(m[2], m[1]);
  }
  const ml = lines.find((l) => l.startsWith('manifest_sha256='));
  const manifestShas = new Set((ml ?? '').slice('manifest_sha256='.length).split(',').filter(Boolean));
  if (manifestShas.size === 0) throw new Error('pull-meta: no manifest_sha256 recorded');
  return { tCut, shas, manifestShas };
}

export function main(argv: string[] = process.argv.slice(2)): number {
  try {
    const files = Object.fromEntries(
      ['--extract', '--counts-apart', '--v2-without-v1', '--pull-meta', '--worklist', '--delta', '--crossed', '--retired-uc', '--adapter-before', '--out-dir'].map((f) => [f, arg(argv, f)]),
    );
    const manifestPaths = arg(argv, '--manifest').split(',').filter(Boolean);
    const pull = parsePullMeta(readFileSync(files['--pull-meta'], 'utf8'));
    for (const [flag, name] of [['--extract', 'extract.csv'], ['--counts-apart', 'counts-apart.csv'], ['--v2-without-v1', 'v2-without-v1.csv']] as const) {
      if (basename(files[flag]) !== name || pull.shas.get(name) !== sha(files[flag])) throw new Error(`${flag}: not the ${name} the pull hashed`);
    }
    const manifestShas = new Set(manifestPaths.map(sha));
    if (manifestShas.size !== pull.manifestShas.size || [...manifestShas].some((h) => !pull.manifestShas.has(h))) {
      throw new Error('--manifest: not the manifest files the pull recorded');
    }
    for (const [flag, pin] of [
      ['--worklist', PINNED_SHA256.worklist], ['--delta', PINNED_SHA256.delta], ['--crossed', PINNED_SHA256.crossed],
      ['--retired-uc', PINNED_SHA256.retiredUc], ['--adapter-before', PINNED_SHA256.adapterBefore],
    ] as const) {
      if (sha(files[flag]) !== pin) throw new Error(`${flag}: sha256 is not the registered ${pin.slice(0, 12)}…`);
    }
    const rows = parseExtract(readText(files['--extract']));
    if (rows.length === 0) throw new Error('the extract holds no row — refusing an empty table');
    const countsApart = csvRows(readText(files['--counts-apart']), COUNTS_APART_HEADER, 'counts-apart');
    const v2WithoutV1 = csvRows(readText(files['--v2-without-v1']), V2_WITHOUT_V1_HEADER, 'v2-without-v1');
    const strata = parseStrata({
      worklist: readText(files['--worklist']), delta: readText(files['--delta']), crossed: readText(files['--crossed']),
      retiredUc: readText(files['--retired-uc']), adapterBefore: readText(files['--adapter-before']),
      manifest: manifestPaths.map((p) => readFileSync(p, 'utf8')),
    });
    const outDir = files['--out-dir'];
    const meta = {
      cells_tested: 0,
      t_cut: pull.tCut,
      inputs: Object.fromEntries(Object.entries(files).filter(([f]) => f !== '--out-dir').map(([f, p]) => [f.slice(2), { path: p, sha256: sha(p) }])),
      manifest: manifestPaths.map((p) => ({ path: p, sha256: sha(p) })),
      produced_at: new Date().toISOString(),
    };
    const table = buildTable({ rows, strata, countsApart, v2WithoutV1, meta });
    mkdirSync(outDir, { recursive: true });
    writeFileSync(`${outDir}/disagreement.json`, JSON.stringify(table, null, 1) + '\n');
    writeFileSync(`${outDir}/disagreement.md`, renderMarkdown(table) + '\n');
    console.log(`LRW_DISAGREEMENT_VERDICT=PASS rows=${rows.length} twins=${table.headline.n} cells=${table.cells.length} out=${outDir}`);
    return 0;
  } catch (err) {
    console.log(`LRW_DISAGREEMENT_VERDICT=INDETERMINATE ${(err as Error).message.slice(0, 300)}`);
    return 3;
  }
}

if (process.argv[1] && process.argv[1].includes('lrw/disagreement')) process.exit(main());
