// regime-diag/frame.ts — EDGE-REGIME-DIAG-W1: the frame of one window, and the label-free skeleton (§2).
//
// A frame holds every entry of a window (§4.2), its rows (one per timeframe the entry is eligible at, §4.5), the
// label of each row under each answer key, the indicators the served label was decided from, and — only when
// `outcomes` is asked for — the path label and the baselines of every entry × cell × side. Coins are read one
// at a time. The skeleton is computed from a frame built WITHOUT outcomes, and compared with the tables the
// registration carries.
import { sigma1hFromVolatilityRatio } from '../../lib/pre-trade-calc.js';
import { aggregate, noGap, type Bars, type Grid } from './archive.js';
import { PHASE_NONE, PHASE_UP, buildKeyA, keyBAt, phaseAt, volLeg, type KeyA } from './keys.js';
import { OUT_BOTH, OUT_NULL, countOutcomes, drawEntries, labelEntry, newCellTable, type CellTable } from './labeler.js';
import { buildSeries, quietly, served, type Series } from './replay.js';
import { CONF_BINS, ENTRIES_PER_DAY, HISTORY_MIN, KEY_B_DESCRIPTIVE_LEADS, L_DOWN, L_RANGING, L_UP, L_VOLATILE, NO_LABEL, N_CS, PATH_MIN,
  REGIME_AGAINST_MIN_CONFIDENCE, TFS, VOLATILE_MIN_CONFIDENCE, type Span, type Win } from './diag-spec.js';

export interface Census { panel: string[]; wCoin: number[]; wTf: number[] }

/** The panel and the design weights, from the census field `t3_weights`. Never renormalised. */
export function parseCensus(text: string): Census {
  const t = (JSON.parse(text) as { t3_weights?: { panel?: unknown; coins?: Record<string, unknown>; timeframes?: Record<string, unknown> } }).t3_weights;
  if (!t || !Array.isArray(t.panel) || !t.coins || !t.timeframes) throw new Error('regime-diag: the census has no t3_weights panel');
  const num = (x: unknown, what: string): number => {
    if (typeof x !== 'number' || !Number.isFinite(x) || x <= 0) throw new Error(`regime-diag: the census weight of ${what} is not a positive number`);
    return x;
  };
  const panel = t.panel.map((c) => { if (typeof c !== 'string' || !/^[A-Z0-9]{1,20}$/.test(c)) throw new Error('regime-diag: a census panel entry is not a coin'); return c; });
  return { panel, wCoin: panel.map((c, i) => num(t.coins![c], `position ${i + 1}`)), wTf: TFS.map((tf) => num(t.timeframes![tf.key], tf.key)) };
}

export const posName = (i: number): string => `P${String(i + 1).padStart(2, '0')}`;
export const N_TF = TFS.length;

/** A label per row under one answer key. `lab` is an index into LABELS, or NO_LABEL. */
export interface Lab { lab: Uint8Array; conf: Uint8Array }
const newLab = (rows: number): Lab => ({ lab: new Uint8Array(rows).fill(NO_LABEL), conf: new Uint8Array(rows) });

/** The bar-level part of one coin: the per-closed-bar series over the whole span, and key A inside this window. */
export interface CoinPart { pos: number; series: Series[]; keyA: KeyA[]; eligible: number; e0: number; e1: number }

export interface Frame {
  win: Win; span: Span; census: Census; outcomes: boolean;
  nE: number;
  /** Per entry: its position (index into the panel) and its grid minute. Entries of a position are in time order. */
  ePos: Uint8Array; eM: Int32Array;
  cells: CellTable | null;
  /** Per row `e·3 + τ`: 1 when the entry has a served label at that timeframe. */
  has: Uint8Array;
  S: Lab; B: Lab; B7: Lab; B28: Lab;
  /** Key A at the row: the phase of the entry's last closed bar, and the forward volatility leg (NaN when unavailable). */
  phase: Uint8Array; volLeg: Float64Array;
  adx: Float64Array; adxSlope: Float64Array; plusDI: Float64Array; minusDI: Float64Array; vol: Float64Array;
  slope: Uint8Array; structure: Uint8Array;
  /** Closes the entry's label has stood for in the per-closed-bar series (0 when the series disagrees, §4.1). */
  age: Int32Array;
  drops: Record<string, number>;
  coins: CoinPart[];
}

export interface Loaded { g: Grid | null; noArchive: number }
export interface FrameOpts { outcomes: boolean; log?: (line: string) => void }

interface Chunk { n: number; eM: Int32Array; cells: CellTable | null; rows: Omit<Frame, 'win' | 'span' | 'census' | 'outcomes' | 'nE' | 'ePos' | 'eM' | 'cells' | 'drops' | 'coins'> }
const newRows = (n: number): Chunk['rows'] => {
  const r = n * N_TF;
  const f = (): Float64Array => new Float64Array(r).fill(NaN);
  return { has: new Uint8Array(r), S: newLab(r), B: newLab(r), B7: newLab(r), B28: newLab(r), phase: new Uint8Array(r), volLeg: f(), adx: f(), adxSlope: f(), plusDI: f(), minusDI: f(), vol: f(),
    slope: new Uint8Array(r), structure: new Uint8Array(r), age: new Int32Array(r) };
};

/** σ of the 1h call at an entry (null when the entry has no 1h row): what scales the σ shapes of its brackets. */
const sigmaOf = (has: Uint8Array, vol: Float64Array, e: number): number | null => (has[e * N_TF] ? sigma1hFromVolatilityRatio(vol[e * N_TF]) : null);
/** The two outcome drops (§3): cell-sides whose deciding bar touches both barriers, and cell-sides with a null in the odds. */
const outcomeDrops = (cells: CellTable): { both_touch: number; null_odds: number } => {
  const n = countOutcomes(cells);
  return { both_touch: n[OUT_BOTH], null_odds: n[OUT_NULL] };
};

/**
 * The frames of `wins`, one coin at a time. `load(pos)` returns the coin's 1 m grid (null when it has no archive)
 * and the count of coin-months the store lacks. With `outcomes: false` no path is labelled and no odds are read.
 */
export function buildFrames(span: Span, wins: readonly Win[], census: Census, load: (pos: number) => Loaded, opts: FrameOpts): Frame[] {
  const parts: Array<{ chunks: Chunk[]; pos: number[]; coins: CoinPart[]; drops: Record<string, number> }> = wins.map(() => ({ chunks: [], pos: [], coins: [], drops: {} }));
  const inc = (d: Record<string, number>, k: string, by = 1): void => { d[k] = (d[k] ?? 0) + by; };
  let noArchive = 0;
  for (let pos = 0; pos < census.panel.length; pos++) {
    const { g, noArchive: lacking } = load(pos);
    noArchive += lacking;
    if (!g) continue;
    const coin = census.panel[pos];
    const bars: Bars[] = TFS.map((tf) => aggregate(g, tf.min));
    const series = quietly(() => TFS.map((tf, t) => buildSeries(g, bars[t], tf, coin)));
    wins.forEach((win, wi) => {
      const P = parts[wi];
      const keyA = TFS.map((tf, t) => buildKeyA(bars[t], tf, win));
      const { eligible, picks } = drawEntries(g, win, posName(pos));
      for (let m = win.lo; m < win.hi && m < span.n; m++) {
        if (!g.has[m] || (m + PATH_MIN <= win.hi && noGap(g, m - HISTORY_MIN, m + PATH_MIN))) continue;
        inc(P.drops, m + PATH_MIN > win.hi ? 'path_beyond_window' : m - HISTORY_MIN < Math.max(0, g.first) ? 'short_history' : 'gap');
      }
      const n = picks.length;
      const c: Chunk = { n, eM: picks, cells: opts.outcomes ? newCellTable(n) : null, rows: newRows(n) };
      const R = c.rows;
      quietly(() => {
        for (let e = 0; e < n; e++) {
          const m = picks[e];
          for (let t = 0; t < N_TF; t++) {
            const tf = TFS[t], r = e * N_TF + t;
            if (!noGap(g, m - tf.n * tf.min, m)) { inc(P.drops, 'no_1d_history'); continue; }
            let s;
            try { s = served(g, bars[t], tf, m, coin); } catch { inc(P.drops, 'core_refusal'); continue; }
            R.has[r] = 1; R.S.lab[r] = s.label; R.S.conf[r] = s.confidence;
            R.adx[r] = s.adx; R.adxSlope[r] = s.adxSlope; R.plusDI[r] = s.plusDI; R.minusDI[r] = s.minusDI; R.vol[r] = s.vol; R.slope[r] = s.slope; R.structure[r] = s.structure;
            const j = Math.floor(m / tf.min), sr = series[t];
            R.age[r] = j <= sr.nb && sr.ok[j] && sr.label[j] === s.label ? sr.age[j] : 0;
            const b = keyBAt(g, bars[t], tf, win, m, coin);
            if (b) { R.B.lab[r] = b.label; R.B.conf[r] = b.confidence; } else inc(P.drops, 'key_b_beyond_window');
            [R.B7, R.B28].forEach((lab, i) => {
              const d = keyBAt(g, bars[t], tf, win, m, coin, KEY_B_DESCRIPTIVE_LEADS[i]);
              if (d) { lab.lab[r] = d.label; lab.conf[r] = d.confidence; }
            });
            R.phase[r] = phaseAt(keyA[t], m);
            if (R.phase[r] === PHASE_NONE) inc(P.drops, 'undated');
            R.volLeg[r] = volLeg(bars[t], win, m, g.O[m]);
            if (!Number.isFinite(R.volLeg[r])) inc(P.drops, 'undated_volatility_leg');
          }
          if (c.cells) labelEntry(g, m, sigmaOf(R.has, R.vol, e), c.cells, e);
        }
      });
      const e0 = P.pos.length;
      for (let e = 0; e < n; e++) P.pos.push(pos);
      P.chunks.push(c);
      P.coins.push({ pos, series, keyA, eligible, e0, e1: e0 + n });
      opts.log?.(`${posName(pos)} ${win.name}: ${n} entries`);
    });
  }
  return wins.map((win, wi) => {
    const P = parts[wi];
    const nE = P.pos.length;
    const cat = <T extends Uint8Array | Int32Array | Float64Array>(pick: (c: Chunk) => T, width: number, make: (n: number) => T): T => {
      const out = make(nE * width);
      let at = 0;
      for (const c of P.chunks) { out.set(pick(c) as never, at); at += c.n * width; }
      return out;
    };
    const u8 = (n: number): Uint8Array => new Uint8Array(n), f64 = (n: number): Float64Array => new Float64Array(n), i32 = (n: number): Int32Array => new Int32Array(n);
    const lab = (k: 'S' | 'B' | 'B7' | 'B28'): Lab => ({ lab: cat((c) => c.rows[k].lab, N_TF, u8), conf: cat((c) => c.rows[k].conf, N_TF, u8) });
    const cells: CellTable | null = opts.outcomes
      ? { n: nE, out: cat((c) => c.cells!.out, N_CS, u8), aT: cat((c) => c.cells!.aT, N_CS, f64), aS: cat((c) => c.cells!.aS, N_CS, f64), bT: cat((c) => c.cells!.bT, N_CS, f64), bS: cat((c) => c.cells!.bS, N_CS, f64) }
      : null;
    const drops: Record<string, number> = { ...P.drops, no_archive: noArchive, ...(cells ? outcomeDrops(cells) : {}) };
    return { win, span, census, outcomes: opts.outcomes, nE, ePos: Uint8Array.from(P.pos), eM: cat((c) => c.eM, 1, i32), cells,
      has: cat((c) => c.rows.has, N_TF, u8), S: lab('S'), B: lab('B'), B7: lab('B7'), B28: lab('B28'),
      phase: cat((c) => c.rows.phase, N_TF, u8), volLeg: cat((c) => c.rows.volLeg, N_TF, f64),
      adx: cat((c) => c.rows.adx, N_TF, f64), adxSlope: cat((c) => c.rows.adxSlope, N_TF, f64), plusDI: cat((c) => c.rows.plusDI, N_TF, f64), minusDI: cat((c) => c.rows.minusDI, N_TF, f64),
      vol: cat((c) => c.rows.vol, N_TF, f64), slope: cat((c) => c.rows.slope, N_TF, u8), structure: cat((c) => c.rows.structure, N_TF, u8), age: cat((c) => c.rows.age, N_TF, i32),
      drops, coins: P.coins };
  });
}

/**
 * The same frame with the path label and the baselines of every entry × cell × side (§4.4, §4.7) — the outcome
 * computation. The rows are the bare frame's own, untouched: what the skeleton was compared on is what the
 * outcomes attach to. Each coin's grid is loaded again.
 */
export function withOutcomes(f: Frame, load: (pos: number) => Loaded): Frame {
  if (f.outcomes || f.cells) throw new Error('regime-diag: this frame already has outcomes');
  const cells = newCellTable(f.nE);
  for (const c of f.coins) {
    if (c.e1 === c.e0) continue;
    const { g } = load(c.pos);
    if (!g) throw new Error(`regime-diag: ${posName(c.pos)} has no archive now, and had one when the frame was built`);
    quietly(() => { for (let e = c.e0; e < c.e1; e++) labelEntry(g, f.eM[e], sigmaOf(f.has, f.vol, e), cells, e); });
  }
  return { ...f, outcomes: true, cells, drops: { ...f.drops, ...outcomeDrops(cells) } };
}

/** The cluster of an entry: its coin × the UTC day of the entry (the grid starts at a UTC midnight). */
export const dayOf = (m: number): number => Math.floor(m / 1440);
export const isTrending = (lab: number): boolean => lab === L_UP || lab === L_DOWN;

// ── the skeleton (§2, Tables 2a–2e): label-free cardinalities ────────────────────────────────────────────────────

export type Skeleton = Record<'2a' | '2b' | '2c' | '2d' | '2e', Record<string, Array<number | null>>>;
const WIN_NAME: Record<string, string> = { fit: 'fit', holdout: 'hold-out' };
const GROUPS: Array<[string, (pos: number) => boolean]> = [['all', () => true], ['P01–P08', (p) => p < 8], ['P09–P15', (p) => p >= 8]];
export const ROW_SETS: Array<[string, (lab: number, conf: number) => boolean]> = [
  ['all', () => true],
  ['TRENDING', (l) => isTrending(l)],
  ['TRENDING, confidence ≥ 60', (l, c) => isTrending(l) && c >= REGIME_AGAINST_MIN_CONFIDENCE],
  ['TRENDING, confidence < 60', (l, c) => isTrending(l) && c < REGIME_AGAINST_MIN_CONFIDENCE],
  ['RANGING', (l) => l === L_RANGING],
  ['VOLATILE', (l) => l === L_VOLATILE],
  ['VOLATILE, confidence ≥ 70', (l, c) => l === L_VOLATILE && c >= VOLATILE_MIN_CONFIDENCE],
  ['VOLATILE, confidence < 70', (l, c) => l === L_VOLATILE && c < VOLATILE_MIN_CONFIDENCE],
];
/** Index of a confidence in the bins <50, 50–59, 60–69, 70–79, 80+. */
export const confBin = (c: number): number => { let b = 0; while (b < CONF_BINS.length && c >= CONF_BINS[b]) b++; return b; };

export function skeletonOf(frames: readonly Frame[]): Skeleton {
  const sk: Skeleton = { '2a': {}, '2b': {}, '2c': {}, '2d': {}, '2e': {} };
  for (const f of frames) {
    const w = WIN_NAME[f.win.name];
    TFS.forEach((tf, t) => {
      for (const [gname, inGroup] of GROUPS) {
        const v = [0, 0, 0, 0, 0, 0, 0];
        for (const c of f.coins) {
          if (!inGroup(c.pos)) continue;
          const s = c.series[t];
          for (let j = Math.ceil(f.win.lo / tf.min); j * tf.min < f.win.hi && j <= s.nb; j++) {
            if (!s.ok[j]) continue;
            v[0]++;
            const l = s.label[j];
            v[l === L_UP ? 1 : l === L_DOWN ? 2 : l === L_RANGING ? 3 : 4]++;
            if (isTrending(l) && s.conf[j] >= REGIME_AGAINST_MIN_CONFIDENCE) v[5]++;
            if (l === L_VOLATILE && s.conf[j] >= VOLATILE_MIN_CONFIDENCE) v[6]++;
          }
        }
        sk['2a'][`${gname}|${tf.key}|${w}`] = v;
      }
      const a = [0, 0, 0, 0];
      for (const c of f.coins) { const k = c.keyA[t]; a[0] += k.nBars; a[1] += k.turns.idx.length; a[2] += k.dated; a[3] += k.up; }
      sk['2b'][`${tf.key}|${w}`] = a;
      const e = new Array<number>(18).fill(0);
      for (let en = 0; en < f.nE; en++) {
        const r = en * N_TF + t;
        if (!f.has[r]) continue;
        const l = f.S.lab[r], conf = f.S.conf[r], adx = f.adx[r];
        if (isTrending(l)) {
          if (adx > 40) e[3]++; else if (adx > 30) e[2]++; else if (adx > 25) e[1]++; else if (adx > 18) e[0]++;
          e[4 + (2 - f.slope[r])]++; // RISING, FLAT, FALLING
          if (adx > 25 && f.structure[r] !== 0) { e[8]++; if ((f.structure[r] === 1) !== (f.plusDI[r] > f.minusDI[r])) e[9]++; }
          e[10 + confBin(conf)]++;
        } else if (l === L_RANGING) {
          if (adx > 25) e[7]++;
        } else if (conf >= 60) e[15 + Math.min(2, confBin(conf) - 2)]++;
      }
      sk['2e'][`${w}|${tf.key}`] = e;
    });
    let with1d = 0, eligible = 0;
    for (let en = 0; en < f.nE; en++) if (f.has[en * N_TF + 2]) with1d++;
    for (const c of f.coins) eligible += c.eligible;
    sk['2c'][w] = [eligible, f.nE, with1d, f.coins.filter((c) => c.e1 > c.e0).length,
      Math.round((ENTRIES_PER_DAY * (f.win.hi - PATH_MIN - Math.max(f.win.lo, HISTORY_MIN) + 1)) / 1440)];
    for (const [name, inSet] of ROW_SETS) {
      const v = [0, 0, 0, 0, 0, 0];
      const clusters = new Set<number>(), positions = new Set<number>();
      let up = 0, tr = 0;
      for (let r = 0; r < f.nE * N_TF; r++) {
        if (!f.has[r] || !inSet(f.S.lab[r], f.S.conf[r])) continue;
        const en = Math.floor(r / N_TF);
        v[0]++; v[3 + (r % N_TF)]++;
        clusters.add(f.ePos[en] * 100_000 + dayOf(f.eM[en])); positions.add(f.ePos[en]);
        if (isTrending(f.S.lab[r])) { tr++; if (f.S.lab[r] === L_UP) up++; }
      }
      v[1] = clusters.size; v[2] = positions.size;
      const m = name.startsWith('TRENDING') && tr > 0 ? Math.round((Math.min(up, tr - up) / tr) * 10_000) / 10_000 : null;
      sk['2d'][`${w}|${name}`] = [...v, m];
    }
  }
  return sk;
}

/** The skeleton tables the registration carries (§2, Tables 2a–2e), parsed from its text. */
export function registeredSkeleton(markdown: string): Skeleton {
  const sk: Skeleton = { '2a': {}, '2b': {}, '2c': {}, '2d': {}, '2e': {} };
  const keyCols: Record<string, number> = { '2a': 3, '2b': 2, '2c': 1, '2d': 2, '2e': 2 };
  const lines = markdown.split('\n');
  for (const id of Object.keys(keyCols) as Array<keyof Skeleton>) {
    let i = lines.findIndex((ln) => ln.startsWith(`**Table ${id} `));
    if (i < 0) throw new Error(`regime-diag: the registration has no Table ${id}`);
    while (i < lines.length && !lines[i].startsWith('|')) i++;
    for (i += 2; i < lines.length && lines[i].startsWith('|'); i++) {
      const f = lines[i].split('|').slice(1, -1).map((x) => x.trim());
      const nums = f.slice(keyCols[id]).map((x) => {
        if (x === 'n/a') return null;
        if (!/^\d{1,3}(,\d{3})*(\.\d+)?$|^\d+(\.\d+)?$/.test(x)) throw new Error(`regime-diag: Table ${id} holds a cell that is not a number`);
        return Number(x.replace(/,/g, ''));
      });
      sk[id][f.slice(0, keyCols[id]).join('|')] = nums;
    }
    if (Object.keys(sk[id]).length === 0) throw new Error(`regime-diag: Table ${id} of the registration is empty`);
  }
  return sk;
}

/** Every cell where two skeletons differ, and every row one of them lacks. Empty means equal. */
export function diffSkeleton(got: Skeleton, want: Skeleton): string[] {
  const out: string[] = [];
  for (const id of Object.keys(want) as Array<keyof Skeleton>) {
    for (const k of new Set([...Object.keys(want[id]), ...Object.keys(got[id] ?? {})])) {
      const a = got[id]?.[k], b = want[id][k];
      if (!a || !b) { out.push(`Table ${id} row ${k}: ${a ? 'not registered' : 'not computed'}`); continue; }
      for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) out.push(`Table ${id} row ${k} column ${i + 1}: computed ${a[i]}, registered ${b[i]}`);
    }
  }
  return out;
}

/** PHASE_UP / PHASE_DOWN as a label direction; NO_LABEL where the row has no dated phase. */
export const phaseLab = (f: Frame): Lab => {
  const n = f.phase.length, lab = new Uint8Array(n).fill(NO_LABEL), conf = new Uint8Array(n);
  for (let r = 0; r < n; r++) if (f.has[r] && f.phase[r] !== PHASE_NONE) { lab[r] = f.phase[r] === PHASE_UP ? L_UP : L_DOWN; conf[r] = 100; }
  return { lab, conf };
};
