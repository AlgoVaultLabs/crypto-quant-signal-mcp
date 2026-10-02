// ads1/scorecard.ts — EDGE-ADS1-SCORECARD-W1-V2 CH3 R6: the one-shot ADS-1 cell scorecard. PURE — text
// and rows in, a scorecard object and its markdown out; the entrypoint (src/scripts/ads1-scorecard.ts)
// owns every read and write.
//
// NON-PROMOTABLE. Nothing here feeds a gate, a threshold, a weight, a serving path or a public figure; the
// output is a private vault audit.
//
// WHAT IS SCORED. Cells are (exchange, timeframe, tier), side-agnostic. Roll-ups are (timeframe, tier),
// (timeframe) and the fleet — crypto-only headlines (tiers 1, 2, 4; ruling Q7 = A), tier 3 on its own, and
// an all-tier line as a sensitivity. Two windows, never pooled: FULL [first row, T_CAP] and POST_FLIP
// (T_FLIP, T_CAP]. The primary barrier spec gets every layer; the two sensitivity specs get L0 / L1 only.
//
// WHAT IS NOT. The withheld arm (ruling Q3 = A): the all-decisions edge is a fixed n/a token. Coverage is a
// census ratio only where its units are commensurate — measured 2026-09-27 they are not — so it prints as
// an n/a token beside the raw census counts, and per-venue coverage is n/a because the HOLD census has no
// venue column.

import { clusterEdgeCompleteWithCi } from '../dwr-cluster-edge.js';
import {
  dwrComplete,
  dwrDecided,
  edge,
  engineOutcome,
  identifiability,
  isScored,
  nEff,
  sideOutcomes,
  toRaceRows,
  type Ads1Row,
} from './core.js';
import { calibration, coverageEmitted, payoff, renderVerdict, verdict, type Census, type Verdict } from './layers.js';
import {
  ADAPTER_SPLIT_CELLS,
  ADS1_BARRIER_SPECS,
  ADS1_SPEC_VERSION,
  ALPHA_ONE_SIDED,
  BOOTSTRAP_B,
  BOOTSTRAP_SEED,
  CALIB_FLOOR_TS,
  N_EFF_FLOOR,
  PRIMARY_BARRIER_SPEC,
  T_ADAPTER,
  T_CUT,
  T_FLIP,
  withinTCapMax,
} from './spec.js';
import { EXTRACT_HEADER, PRESENCE_HEADER, specSuffix } from './extract-sql.js';

// ── input parsing ────────────────────────────────────────────────────────────────────────────────

/** Split one CSV line (psql `FORMAT csv`: quotes only when needed, `""` escapes a quote). A NULL is an
 *  unquoted empty field — returned as `null`; a quoted empty string is `''`. */
export function splitCsvLine(line: string): Array<string | null> {
  const out: Array<string | null> = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      let v = '';
      i++;
      for (;;) {
        if (i >= line.length) throw new Error('splitCsvLine: unterminated quoted field');
        if (line[i] === '"') {
          if (line[i + 1] === '"') { v += '"'; i += 2; continue; }
          i++;
          break;
        }
        v += line[i++];
      }
      out.push(v);
      if (i < line.length && line[i] !== ',') throw new Error('splitCsvLine: text after a closing quote');
      i++;
    } else {
      const j = line.indexOf(',', i);
      const end = j === -1 ? line.length : j;
      const v = line.slice(i, end);
      out.push(v === '' ? null : v);
      i = end + 1;
    }
  }
  return out;
}

/** Parse a CSV text with a required header. Refuses a different header (the extract IS its column list). */
export function parseCsv(text: string, header: readonly string[]): Array<Array<string | null>> {
  const lines = text.split('\n').filter((l) => l.length > 0);
  if (lines.length === 0) throw new Error('parseCsv: empty input');
  const got = lines[0].replace(/\r$/, '').split(',');
  if (got.length !== header.length || got.some((h, i) => h !== header[i])) {
    throw new Error(`parseCsv: header mismatch — got [${got.join(',')}], want [${header.join(',')}]`);
  }
  return lines.slice(1).map((l, k) => {
    const cells = splitCsvLine(l.replace(/\r$/, ''));
    if (cells.length !== header.length) throw new Error(`parseCsv: line ${k + 2} has ${cells.length} fields, want ${header.length}`);
    return cells;
  });
}

export interface SpecLabel {
  label: number;
  ambiguous: boolean;
  lowVol: boolean;
  barrierPct: number;
  expiryRetPct: number | null;
}

export interface ExtractRow {
  id: number;
  createdAt: number;
  exchange: string;
  coin: string;
  timeframe: string;
  side: 'BUY' | 'SELL';
  confidence: number;
  regimeRuleVersion: number | null;
  regime: string | null;
  verdictRuleVersion: number | null;
  anchored: boolean;
  /** Keyed by the barrier_spec literal; null when that spec did not label the call. */
  specs: Record<string, SpecLabel | null>;
  /** PROVENANCE of the primary-spec row (registration §10.3), never a label: its first-write stamp (epoch seconds,
   *  fractional) and the generator's own contiguity count (`race_gap_candles`, 0 on every `-v2` row by
   *  construction; null when the column is NULL). */
  computedAt: number;
  raceGapCandles: number | null;
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));
const bool = (v: string | null): boolean => v === 't' || v === 'true';

/** A `timestamptz` as psql prints it under the session's `SET TIME ZONE 'UTC'` + `DateStyle 'ISO, YMD'`
 *  (`2026-10-03 19:00:01.123456+00`) → epoch seconds. ANY other shape is refused — a local offset or another
 *  DateStyle would otherwise shift the relabel / nightly / T_ADAPTER splits silently. */
export function parseUtcTimestamptz(v: string | null): number {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?\+00$/.exec(v ?? '');
  if (!m) throw new Error(`parseUtcTimestamptz: '${String(v).slice(0, 40)}' is not a UTC ISO timestamptz`);
  const whole = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) / 1000;
  return whole + (m[7] ? Number(`0${m[7]}`) : 0);
}

export function parseExtract(text: string): ExtractRow[] {
  const idx = (c: string) => EXTRACT_HEADER.indexOf(c);
  return parseCsv(text, EXTRACT_HEADER).map((c) => {
    const side = c[idx('side')];
    if (side !== 'BUY' && side !== 'SELL') throw new Error(`parseExtract: side ${side} is not BUY/SELL`);
    const specs: Record<string, SpecLabel | null> = {};
    for (const b of ADS1_BARRIER_SPECS) {
      const s = specSuffix(b.tau);
      const label = c[idx(`label_${s}`)];
      specs[b.spec] =
        label === null
          ? null
          : {
              label: Number(label),
              ambiguous: bool(c[idx(`amb_${s}`)]),
              lowVol: bool(c[idx(`lowvol_${s}`)]),
              barrierPct: Number(c[idx(`barrier_${s}`)]),
              expiryRetPct: num(c[idx(`expiry_${s}`)]),
            };
    }
    return {
      id: Number(c[idx('id')]),
      createdAt: Number(c[idx('created_at')]),
      exchange: String(c[idx('exchange')]),
      coin: String(c[idx('coin')]),
      timeframe: String(c[idx('timeframe')]),
      side,
      confidence: Number(c[idx('confidence')]),
      regimeRuleVersion: num(c[idx('regime_rule_version')]),
      regime: c[idx('regime')],
      verdictRuleVersion: num(c[idx('verdict_rule_version')]),
      anchored: bool(c[idx('anchored')]),
      specs,
      computedAt: parseUtcTimestamptz(c[idx(`computed_${specSuffix(ADS1_BARRIER_SPECS[0].tau)}`)]),
      raceGapCandles: num(c[idx(`gap_${specSuffix(ADS1_BARRIER_SPECS[0].tau)}`)]),
    };
  });
}

/** One registered signal under the max-form T_CAP (the label-free presence statement, registration §10.3). */
export interface PresenceRow {
  id: number;
  exchange: string;
  coin: string;
  timeframe: string;
  win: 'PRE' | 'POST';
  v1: boolean;
  v2: boolean;
  v2PostAdapter: boolean;
}

export function parsePresence(text: string): PresenceRow[] {
  const idx = (c: string) => PRESENCE_HEADER.indexOf(c);
  const tf = (v: string | null): boolean => {
    if (v !== 't' && v !== 'f') throw new Error(`parsePresence: boolean '${v}' is not t/f`);
    return v === 't';
  };
  return parseCsv(text, PRESENCE_HEADER).map((c) => {
    const win = c[idx('win')];
    if (win !== 'PRE' && win !== 'POST') throw new Error(`parsePresence: window ${win}`);
    const id = Number(c[idx('id')]);
    if (!Number.isInteger(id) || id <= 0) throw new Error(`parsePresence: id '${c[idx('id')]}'`);
    return {
      id, exchange: String(c[idx('exchange')]), coin: String(c[idx('coin')]), timeframe: String(c[idx('timeframe')]), win,
      v1: tf(c[idx('v1_present')]), v2: tf(c[idx('v2_present')]), v2PostAdapter: tf(c[idx('v2_post_adapter')]),
    };
  });
}

/** The tier instrument (ruling Q7 = A): `/api/performance-public` `byTier[].assets`, pinned at run time.
 *  Tiers are disjoint by construction; a coin listed twice is refused, never resolved silently. */
export function tierMapOf(performancePublic: unknown): Map<string, string> {
  const byTier = (performancePublic as { byTier?: Record<string, { tier?: unknown; assets?: unknown }> })?.byTier;
  if (!byTier || typeof byTier !== 'object') throw new Error('tierMapOf: no byTier object');
  const m = new Map<string, string>();
  for (const t of Object.values(byTier)) {
    if (typeof t.tier !== 'number' || !Array.isArray(t.assets)) throw new Error('tierMapOf: a tier without {tier, assets[]}');
    for (const a of t.assets) {
      if (m.has(String(a))) throw new Error(`tierMapOf: ${String(a)} is listed in two tiers`);
      m.set(String(a), String(t.tier));
    }
  }
  if (m.size === 0) throw new Error('tierMapOf: the tier instrument lists no asset');
  return m;
}

export const CRYPTO_TIERS: readonly string[] = ['1', '2', '4'];
export const UNMAPPED_TIER = 'U';

export interface CensusRow {
  source: 'signals' | 'band_signals' | 'hold_counts' | 'emit_suppressions';
  win: 'PRE' | 'POST';
  timeframe: string;
  coin: string;
  n: number;
}

export const CENSUS_HEADER: readonly string[] = ['source', 'win', 'timeframe', 'coin', 'n'];
export const SIDE_MIX_HEADER: readonly string[] = ['exchange', 'timeframe', 'regime_rule_version', 'regime', 'side', 'n'];

export function parseCensus(text: string): CensusRow[] {
  return parseCsv(text, CENSUS_HEADER).map((c) => {
    const source = c[0] as CensusRow['source'];
    if (!['signals', 'band_signals', 'hold_counts', 'emit_suppressions'].includes(String(source))) throw new Error(`parseCensus: source ${source}`);
    if (c[1] !== 'PRE' && c[1] !== 'POST') throw new Error(`parseCensus: window ${c[1]}`);
    return { source, win: c[1], timeframe: String(c[2]), coin: String(c[3]), n: Number(c[4]) };
  });
}

export interface SideMixRow {
  exchange: string;
  timeframe: string;
  side: 'BUY' | 'SELL';
  n: number;
}

export function parseSideMix(text: string): SideMixRow[] {
  return parseCsv(text, SIDE_MIX_HEADER).map((c) => {
    if (c[4] !== 'BUY' && c[4] !== 'SELL') throw new Error(`parseSideMix: side ${c[4]}`);
    return { exchange: String(c[0]), timeframe: String(c[1]), side: c[4], n: Number(c[5]) };
  });
}

// ── units ────────────────────────────────────────────────────────────────────────────────────────

export type WindowName = 'FULL' | 'POST_FLIP';
export type UnitKind = 'cell' | 'tf-tier' | 'tf' | 'tier' | 'fleet';

export interface UnitDef {
  key: string;
  kind: UnitKind;
  exchange: string | null;
  timeframe: string | null;
  /** 'crypto' (1, 2, 4), 'all', or one tier. */
  scope: string;
}

function scopeHas(scope: string, tier: string): boolean {
  if (scope === 'all') return true;
  if (scope === 'crypto') return CRYPTO_TIERS.includes(tier);
  return scope === tier;
}

/** Every unit the rows occupy, in a stable order. */
export function unitsOf(rows: Array<{ exchange: string; timeframe: string; tier: string }>): UnitDef[] {
  const cells = new Set<string>();
  const tfTier = new Set<string>();
  const tfs = new Set<string>();
  const tiers = new Set<string>();
  for (const r of rows) {
    cells.add(`${r.exchange}|${r.timeframe}|${r.tier}`);
    tfTier.add(`${r.timeframe}|${r.tier}`);
    tfs.add(r.timeframe);
    tiers.add(r.tier);
  }
  const out: UnitDef[] = [
    { key: 'fleet:crypto', kind: 'fleet', exchange: null, timeframe: null, scope: 'crypto' },
    { key: 'fleet:all', kind: 'fleet', exchange: null, timeframe: null, scope: 'all' },
  ];
  for (const t of [...tiers].sort()) out.push({ key: `tier:T${t}`, kind: 'tier', exchange: null, timeframe: null, scope: t });
  for (const tf of [...tfs].sort()) {
    out.push({ key: `tf:${tf}:crypto`, kind: 'tf', exchange: null, timeframe: tf, scope: 'crypto' });
    out.push({ key: `tf:${tf}:all`, kind: 'tf', exchange: null, timeframe: tf, scope: 'all' });
  }
  for (const k of [...tfTier].sort()) {
    const [tf, t] = k.split('|');
    out.push({ key: `tf-tier:${tf}:T${t}`, kind: 'tf-tier', exchange: null, timeframe: tf, scope: t });
  }
  for (const k of [...cells].sort()) {
    const [ex, tf, t] = k.split('|');
    out.push({ key: `cell:${ex}:${tf}:T${t}`, kind: 'cell', exchange: ex, timeframe: tf, scope: t });
  }
  return out;
}

function unitHas(u: UnitDef, r: { exchange: string; timeframe: string; tier: string }): boolean {
  return (u.exchange === null || u.exchange === r.exchange) && (u.timeframe === null || u.timeframe === r.timeframe) && scopeHas(u.scope, r.tier);
}

/** The census of a venue-free unit (a cell has no census: `CENSUS_HAS_NO_VENUE`). */
export function censusFor(u: UnitDef, window: WindowName, census: CensusRow[], tierOf: (coin: string) => string): Census | null {
  if (u.exchange !== null) return null;
  const c: Census = { signals: 0, bandSignals: 0, holdCounts: 0, emitSuppressions: 0, unitsCommensurate: false };
  for (const r of census) {
    if (window === 'POST_FLIP' && r.win !== 'POST') continue;
    if (u.timeframe !== null && r.timeframe !== u.timeframe) continue;
    if (!scopeHas(u.scope, tierOf(r.coin))) continue;
    if (r.source === 'signals') c.signals += r.n;
    else if (r.source === 'band_signals') c.bandSignals += r.n;
    else if (r.source === 'hold_counts') c.holdCounts += r.n;
    else c.emitSuppressions += r.n;
  }
  return c;
}

// ── one unit's score ─────────────────────────────────────────────────────────────────────────────

/** A row as the scorer sees it: the library's row plus the breakdown keys it never reads. */
export interface ScoredRow extends Ads1Row {
  tier: string;
  regimeRuleVersion: number | null;
  regime: string | null;
  anchored: boolean;
}

export interface UnitScore {
  key: string;
  kind: UnitKind;
  window: WindowName;
  spec: string;
  scope: string;
  n: number;
  nScored: number;
  nDays: number;
  rho: number | null;
  mStar: number;
  kishDays: number;
  nEff: number | null;
  emittedBuyShare: number;
  scoredBuyShare: number;
  identifiable: boolean;
  identReason: string | null;
  minorityShare: number;
  attainablePp: number;
  ptZ: number | null;
  ptP: number | null;
  dwrDecided: number;
  nDecided: number;
  dwrComplete: number;
  wins: number;
  losses: number;
  flat: number;
  unresolved: number;
  inconsistent: number;
  timeouts: number;
  flatRate: number;
  timeoutRate: number;
  alwaysBuy: number;
  alwaysSell: number;
  p0: number;
  edgePp: number | null;
  edgePpPooled: number;
  wilsonLb: number;
  clusterCiLbPp: number | null;
  clusterP: number | null;
  tStat: number | null;
  clusters: number;
  clustersDropped: number;
  clusterVerdict: string;
  malformedRows: number;
  /** |pooled − Σ_side share·(hit_side − q_side)|, rate units — the self-check's identity. */
  identityResidual: number;
  /** Primary spec only (L2–L5 + verdict); null on a sensitivity spec. */
  full: FullLayers | null;
}

export interface FullLayers {
  calibration: ReturnType<typeof calibration> & { rowsBeforeCalibFloor: number };
  coverage: ReturnType<typeof coverageEmitted> & { naReason: string | null; allDecisionsEdge: string };
  payoff: ReturnType<typeof payoff>;
  liveDays: number;
  regimes: Array<{ regimeRuleVersion: number | null; regime: string | null; n: number; edgePp: number | null; ciLbPp: number | null }>;
  regimesCiLbAbove0: number;
  merkleCoverage: number;
  verdict: Verdict;
  specVersion: string;
}

function decompositionResidual(rows: Ads1Row[], pooledPp: number): number {
  let n = 0, nB = 0, nS = 0, hitB = 0, hitS = 0, aB = 0, aS = 0;
  for (const r of rows) {
    const o = sideOutcomes(r);
    if (!isScored(o[r.side])) continue;
    n++;
    if (r.side === 'BUY') { nB++; if (o.BUY === 'WIN') hitB++; } else { nS++; if (o.SELL === 'WIN') hitS++; }
    if (o.BUY === 'WIN') aB++;
    if (o.SELL === 'WIN') aS++;
  }
  if (n === 0) return 0;
  const qB = aB / n, qS = aS / n;
  const d = (nB ? (nB / n) * (hitB / nB - qB) : 0) + (nS ? (nS / n) * (hitS / nS - qS) : 0);
  return Math.abs(pooledPp / 100 - d);
}

export function scoreUnit(u: UnitDef, window: WindowName, spec: string, rows: ScoredRow[], census: Census | null): UnitScore {
  const dc = dwrComplete(rows);
  const dd = dwrDecided(rows);
  const e = edge(rows);
  const ne = nEff(rows);
  const id = identifiability(rows);
  let scoredBuy = 0, scored = 0, aB = 0, aS = 0;
  for (const r of rows) {
    const o = sideOutcomes(r);
    if (!isScored(o[r.side])) continue;
    scored++;
    if (r.side === 'BUY') scoredBuy++;
    if (o.BUY === 'WIN') aB++;
    if (o.SELL === 'WIN') aS++;
  }
  const base: UnitScore = {
    key: u.key, kind: u.kind, window, spec, scope: u.scope,
    n: rows.length, nScored: scored, nDays: ne.nDays, rho: ne.rho, mStar: ne.mStar, kishDays: ne.kishDays, nEff: ne.nEff,
    emittedBuyShare: rows.length ? rows.filter((r) => r.side === 'BUY').length / rows.length : NaN,
    scoredBuyShare: scored ? scoredBuy / scored : NaN,
    identifiable: id.status === 'OK', identReason: id.reason, minorityShare: id.minorityShare, attainablePp: id.attainablePp,
    ptZ: id.pt.z, ptP: id.pt.p,
    dwrDecided: dd.dwr, nDecided: dd.nDecided,
    dwrComplete: dc.dwr, wins: dc.wins, losses: dc.losses, flat: dc.flat, unresolved: dc.unresolved, inconsistent: dc.inconsistent,
    timeouts: dc.timeouts, flatRate: dc.flatRate, timeoutRate: dc.timeoutRate,
    alwaysBuy: scored ? aB / scored : NaN, alwaysSell: scored ? aS / scored : NaN, p0: e.p0,
    edgePp: e.edgePp, edgePpPooled: e.edgePpPooled, wilsonLb: e.wilsonLb,
    clusterCiLbPp: e.cluster.ciLbPp, clusterP: e.cluster.p, tStat: e.cluster.tStat,
    clusters: e.cluster.clusters, clustersDropped: e.cluster.clustersDropped, clusterVerdict: e.cluster.verdict,
    malformedRows: e.cluster.malformedRows,
    identityResidual: decompositionResidual(rows, e.edgePpPooled),
    full: null,
  };
  if (spec !== PRIMARY_BARRIER_SPEC) return base;

  // L2 — one binning; the FULL window is floored at the April recalibration (earlier rows counted apart).
  const calibRows = rows.filter((r) => r.createdAt >= CALIB_FLOOR_TS);
  const cal = { ...calibration(calibRows), rowsBeforeCalibFloor: rows.length - calibRows.length };
  // L3 — emitted arm only.
  const cov = coverageEmitted(rows, census);
  const naReason = u.exchange !== null ? 'CENSUS_HAS_NO_VENUE' : cov.coverageReason;
  // L4
  const pay = payoff(rows);
  // L5 + the verdict's remaining inputs
  let tMin = Infinity, tMax = -Infinity, anchored = 0;
  const regimeGroups = new Map<string, ScoredRow[]>();
  for (const r of rows) {
    tMin = Math.min(tMin, r.createdAt);
    tMax = Math.max(tMax, r.createdAt);
    if (r.anchored) anchored++;
    const k = `${r.regimeRuleVersion ?? 'NULL'}|${r.regime ?? 'NULL'}`;
    const g = regimeGroups.get(k);
    if (g) g.push(r); else regimeGroups.set(k, [r]);
  }
  const regimes = [...regimeGroups.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, g]) => {
    const c = clusterEdgeCompleteWithCi(toRaceRows(g), { alpha: ALPHA_ONE_SIDED, B: BOOTSTRAP_B, seed: BOOTSTRAP_SEED });
    return { regimeRuleVersion: g[0].regimeRuleVersion, regime: g[0].regime, n: g.length, edgePp: c.meanPp, ciLbPp: c.ciLbPp };
  });
  // D30: only the current regime rule (v3) counts toward the EXCEPTIONAL regimes floor; NULL is disclosed.
  const regimesCiLbAbove0 = regimes.filter((g) => g.regimeRuleVersion === 3 && g.regime !== null && (g.ciLbPp ?? -Infinity) > 0).length;
  const liveDays = rows.length ? (tMax - tMin) / 86_400 : 0;
  const v = verdict({
    identifiable: id.status === 'OK',
    edgePp: e.edgePp,
    edgePpPooled: e.edgePpPooled,
    ciLbPp: e.cluster.ciLbPp,
    tStat: e.cluster.tStat,
    nEff: ne.nEff,
    dwrComplete: dc.dwr,
    wilsonLb: e.wilsonLb,
    liveDays,
    regimesCiLbAbove0,
    medianBarrierPct: pay.medianBarrierPct,
  });
  base.full = {
    calibration: cal,
    coverage: { ...cov, naReason, allDecisionsEdge: 'n/a: WITHHELD_ARM_QUARANTINED' },
    payoff: pay,
    liveDays,
    regimes,
    regimesCiLbAbove0,
    merkleCoverage: rows.length ? anchored / rows.length : NaN,
    verdict: v,
    specVersion: ADS1_SPEC_VERSION,
  };
  return base;
}

// ── the whole scorecard ──────────────────────────────────────────────────────────────────────────

export interface PullMeta {
  registrationPath: string;
  registrationCommit: string;
  /** Epoch seconds of the LANDED registration commit on origin/main. */
  registrationCommitTs: number;
  /** The pre-read amendment (registration §10): its LANDED commit and committer epoch. The self-check's ordering
   *  row tests the LATER of the two commits (§10, "Ordering"). */
  amendmentCommit: string;
  amendmentCommitTs: number;
  /** The relabel launch epoch LRW records (its CH3 entry; the first `START` line of the runner logs) — the
   *  `relabel` / `nightly` provenance boundary (§10.4). */
  relabelLaunchTs: number;
  /** The family the extract part declared (its `===FAMILY===` line, printed by the generator that emitted the SQL). */
  extractFamily: string;
  /** LRW's own read-only DONE probes, as run by the pull (`LRW_RELABEL_COMPLETE=…`, `LRW_ANNOTATION_COMPLETE=…`). */
  doneTokens: string[];
  /** sha256 of every LRW manifest file the scorecard read (the refusal manifest, §10.4). */
  manifestSha256: string[];
  pullStartTs: number;
  pullEndTs: number;
  /** One token line per session part (counters-before, extract, label-free, counters-after). */
  tokenLines: string[];
  extractSha256: string;
  tiersSha256: string;
  tiersFetchedAt: string;
  countersBefore: { ins: number; upd: number; del: number } | null;
  countersAfter: { ins: number; upd: number; del: number } | null;
  integrity: Record<string, number>;
}

export interface Scorecard {
  specVersion: string;
  generatedFrom: PullMeta;
  disclosures: {
    rows: number;
    rowsByWindow: Record<WindowName, number>;
    lowVolExcluded: Record<string, number>;
    specMissing: Record<string, number>;
    unmappedCoins: string[];
    unmappedRows: number;
    edgexPreFixRows: number;
    expiryDisagreements: number;
    rowsOutsideTCap: number;
    v1RowsAfterFlip: number;
  };
  units: UnitScore[];
  coverage: Coverage;
  cellsTested: number;
  auxiliaryLooks: number;
  sideMix: { cells: Array<{ exchange: string; timeframe: string; buy: number; sell: number; minorityShare: number }>; informativeCells: number; floor: number };
}

// ── the coverage chain (registration §10.4) — cardinalities, no test ─────────────────────────────

/** Where a registered signal stands in the chain. `relabel` / `nightly` / `no_v1_twin` / `pre_cut` partition the
 *  `-v2` population (n); the rest partition the registered rows WITHOUT a `-v2` row by LRW's manifest class. */
export type ChainClass =
  | 'relabel' | 'nightly' | 'no_v1_twin' | 'pre_cut' | 'unstamped'
  | 'refused:short' | 'refused:anchor' | 'refused:gap'
  | 'unreachable:depth' | 'unreachable:history' | 'unreachable:retired' | 'unreachable:adapter-pending'
  | 'deferred' | 'not_visited:v1' | 'not_visited:no_v1';

export const CHAIN_CLASSES: readonly ChainClass[] = [
  'relabel', 'nightly', 'no_v1_twin', 'pre_cut', 'unstamped',
  'refused:short', 'refused:anchor', 'refused:gap',
  'unreachable:depth', 'unreachable:history', 'unreachable:retired', 'unreachable:adapter-pending',
  'deferred', 'not_visited:v1', 'not_visited:no_v1',
];
const V2_CLASSES: ReadonlySet<ChainClass> = new Set(['relabel', 'nightly', 'no_v1_twin', 'pre_cut', 'unstamped']);

/** One registered signal's class. `-v2` present: `no_v1_twin` (LRW-Q16) first, else by its first-write stamp —
 *  at/after the relabel launch `relabel`, from T_CUT `nightly`, before T_CUT `pre_cut` (impossible for a `-v2` row;
 *  printed, expected 0); a `-v2` twin the extract does not carry is `unstamped` (a write landed between the extract
 *  and the label-free part — counted, never thrown, so the self-check FAILS on it and the audit is still written).
 *  `-v2` absent: LRW's manifest class; no manifest line = a signal outside the relabel's own
 *  population (`src/scripts/lrw/relabel-sql.ts` — e.g. a PFE not yet settled), split by whether a `-v1` row exists. */
export function chainClass(p: PresenceRow, computedAt: number | null, manifest: ReadonlyMap<number, string>, relabelLaunchTs: number): ChainClass {
  if (p.v2) {
    if (!p.v1) return 'no_v1_twin';
    if (computedAt === null) return 'unstamped';
    if (computedAt >= relabelLaunchTs) return 'relabel';
    return computedAt >= T_CUT ? 'nightly' : 'pre_cut';
  }
  const m = manifest.get(p.id);
  if (m === undefined) return p.v1 ? 'not_visited:v1' : 'not_visited:no_v1';
  if (!(CHAIN_CLASSES as readonly string[]).includes(m) || V2_CLASSES.has(m as ChainClass)) throw new Error(`chainClass: manifest class '${m}' is not registered`);
  return m as ChainClass;
}

export interface ChainRow {
  /** `(exchange, timeframe)` rows key as `EXCHANGE timeframe`; unit rows key as the unit key. */
  key: string;
  window: WindowName;
  registered: number;
  v1Present: number;
  /** n — the `-v2` population of the unit (before the low-volatility exclusion). */
  v2Present: number;
  reach: number;
  byClass: Record<ChainClass, number>;
}

export interface Coverage {
  byCell: ChainRow[];
  byUnit: ChainRow[];
  /** BITGET 2h / 8h (registration §10.5): `-v2` rows split at T_ADAPTER by `computed_at`, both windows. */
  adapterSplit: Array<{ cell: string; window: WindowName; postAdapter: number; preAdapterFix: number; presencePostAdapter: number }>;
  /** Over the primary spec's non-low-volatility rows (the scored population): expected 0 by construction (§10.4). */
  unresolved: number;
  inconsistent: number;
  /** `-v2` rows whose `race_gap_candles` is not 0 (expected none) and how many are NULL. */
  gapNonZero: number;
  gapNull: number;
  /** registered ∧ `-v2` present (presence) vs extract rows — must be the same id set. */
  presenceV2: number;
  extractRows: number;
  idSetsEqual: boolean;
  presencePostAdapterAgrees: boolean;
  deferredUnderTCap: number;
}

function emptyClasses(): Record<ChainClass, number> {
  return Object.fromEntries(CHAIN_CLASSES.map((c) => [c, 0])) as Record<ChainClass, number>;
}

export function buildCoverage(input: {
  presence: PresenceRow[];
  rows: ExtractRow[];
  manifest: ReadonlyMap<number, string>;
  relabelLaunchTs: number;
  tierOf: (coin: string) => string;
  defs: UnitDef[];
}): Coverage {
  const byId = new Map<number, ExtractRow>(input.rows.map((r) => [r.id, r]));
  const cell = new Map<string, ChainRow>();
  const unit = new Map<string, ChainRow>();
  const bump = (m: Map<string, ChainRow>, key: string, window: WindowName, p: PresenceRow, cls: ChainClass) => {
    const k = `${key}|${window}`;
    const row = m.get(k) ?? { key, window, registered: 0, v1Present: 0, v2Present: 0, reach: NaN, byClass: emptyClasses() };
    row.registered++;
    if (p.v1) row.v1Present++;
    if (p.v2) row.v2Present++;
    row.byClass[cls]++;
    m.set(k, row);
  };
  const split = new Map<string, { cell: string; window: WindowName; postAdapter: number; preAdapterFix: number; presencePostAdapter: number }>();
  let presenceV2 = 0, deferred = 0, postAdapterDisagree = 0;
  for (const p of input.presence) {
    const ex = byId.get(p.id);
    const cls = chainClass(p, ex ? ex.computedAt : null, input.manifest, input.relabelLaunchTs);
    if (p.v2) presenceV2++;
    if (cls === 'deferred') deferred++;
    const windows: WindowName[] = p.win === 'POST' ? ['FULL', 'POST_FLIP'] : ['FULL'];
    const r = { exchange: p.exchange, timeframe: p.timeframe, tier: input.tierOf(p.coin) };
    for (const w of windows) {
      bump(cell, `${p.exchange} ${p.timeframe}`, w, p, cls);
      for (const u of input.defs) if (unitHas(u, r)) bump(unit, u.key, w, p, cls);
      const pair = `${p.exchange}:${p.timeframe}`;
      if (p.v2 && ADAPTER_SPLIT_CELLS.has(pair) && ex) {
        const k = `${pair}|${w}`;
        const s = split.get(k) ?? { cell: pair, window: w, postAdapter: 0, preAdapterFix: 0, presencePostAdapter: 0 };
        if (ex.computedAt >= T_ADAPTER) s.postAdapter++; else s.preAdapterFix++;
        if (p.v2PostAdapter) s.presencePostAdapter++;
        split.set(k, s);
      }
    }
    // the presence statement's T_ADAPTER boolean and the extract's stamp must agree (one server-side, one parsed)
    if (p.v2 && ex && p.v2PostAdapter !== ex.computedAt >= T_ADAPTER) postAdapterDisagree++;
  }
  const finish = (m: Map<string, ChainRow>) => [...m.values()].map((r) => ({ ...r, reach: r.registered ? r.v2Present / r.registered : NaN }));
  const presentIds = new Set(input.presence.filter((p) => p.v2).map((p) => p.id));
  const idSetsEqual = presentIds.size === byId.size && [...byId.keys()].every((id) => presentIds.has(id));
  let unresolved = 0, inconsistent = 0, gapNonZero = 0, gapNull = 0;
  for (const r of input.rows) {
    if (r.raceGapCandles === null) gapNull++;
    else if (r.raceGapCandles !== 0) gapNonZero++;
    const s = r.specs[PRIMARY_BARRIER_SPEC];
    if (!s || s.lowVol) continue;
    const o = engineOutcome({
      createdAt: r.createdAt, exchange: r.exchange, coin: r.coin, timeframe: r.timeframe, side: r.side, confidence: r.confidence,
      label: s.label, ambiguous: s.ambiguous, barrierPct: s.barrierPct, expiryRetPct: s.expiryRetPct,
    });
    if (o === 'UNRESOLVED') unresolved++;
    else if (o === 'INCONSISTENT') inconsistent++;
  }
  const order = (a: ChainRow, b: ChainRow) => (a.key === b.key ? (a.window < b.window ? -1 : 1) : a.key < b.key ? -1 : 1);
  return {
    byCell: finish(cell).sort(order),
    byUnit: finish(unit).sort(order),
    adapterSplit: [...split.values()].sort((a, b) => (a.cell + a.window < b.cell + b.window ? -1 : 1)),
    unresolved, inconsistent, gapNonZero, gapNull,
    presenceV2, extractRows: input.rows.length, idSetsEqual, presencePostAdapterAgrees: postAdapterDisagree === 0,
    deferredUnderTCap: deferred,
  };
}

/** The EDGEX adapter fix (`e34f95e9`, committed 1781171876) + one day for push and deploy — D33: the
 *  cohort before it is DISCLOSED; the labeler's own sorted candles make its labels unaffected. */
export const EDGEX_FIX_CUT = 1781171876 + 86_400;

export function buildScorecard(input: {
  rows: ExtractRow[];
  tierMap: Map<string, string>;
  census: CensusRow[];
  sideMix: SideMixRow[];
  /** The label-free presence statement's rows (one per registered signal under the max-form T_CAP). */
  presence: PresenceRow[];
  /** LRW's refusal manifest, signal id → class (last line wins, `lrw/completeness.ts` `parseManifest`). */
  manifest: ReadonlyMap<number, string>;
  meta: PullMeta;
  /** Restrict to these units (tests); default every unit the rows occupy. */
  onlyKinds?: UnitKind[];
}): Scorecard {
  const tierOf = (coin: string) => input.tierMap.get(coin) ?? UNMAPPED_TIER;
  const unmapped = new Set<string>();
  let unmappedRows = 0, edgexPre = 0, expiryDisagreements = 0, outside = 0, v1After = 0;
  for (const r of input.rows) {
    if (!input.tierMap.has(r.coin)) { unmapped.add(r.coin); unmappedRows++; }
    if (r.exchange === 'EDGEX' && r.createdAt < EDGEX_FIX_CUT) edgexPre++;
    if (!withinTCapMax(r.createdAt, r.exchange, r.timeframe)) outside++;
    if (r.createdAt > T_FLIP && r.verdictRuleVersion === 1) v1After++;
    const p = r.specs[PRIMARY_BARRIER_SPEC]?.expiryRetPct ?? null;
    for (const b of ADS1_BARRIER_SPECS) {
      const x = r.specs[b.spec]?.expiryRetPct ?? null;
      if (p !== null && x !== null && Math.abs(p - x) > 1e-9) expiryDisagreements++;
    }
  }
  const units: UnitScore[] = [];
  const lowVolExcluded: Record<string, number> = {};
  const specMissing: Record<string, number> = {};
  for (const b of ADS1_BARRIER_SPECS) {
    const scored: ScoredRow[] = [];
    lowVolExcluded[b.spec] = 0;
    specMissing[b.spec] = 0;
    for (const r of input.rows) {
      const s = r.specs[b.spec];
      if (!s) { specMissing[b.spec]++; continue; }
      if (s.lowVol) { lowVolExcluded[b.spec]++; continue; }
      scored.push({
        createdAt: r.createdAt, exchange: r.exchange, coin: r.coin, timeframe: r.timeframe, side: r.side, confidence: r.confidence,
        label: s.label, ambiguous: s.ambiguous, barrierPct: s.barrierPct, expiryRetPct: s.expiryRetPct,
        tier: tierOf(r.coin), regimeRuleVersion: r.regimeRuleVersion, regime: r.regime, anchored: r.anchored,
      });
    }
    const defs = unitsOf(scored).filter((u) => !input.onlyKinds || input.onlyKinds.includes(u.kind));
    for (const window of ['FULL', 'POST_FLIP'] as const) {
      const inWindow = window === 'FULL' ? scored : scored.filter((r) => r.createdAt > T_FLIP);
      const buckets = new Map<string, ScoredRow[]>(defs.map((u) => [u.key, []]));
      for (const r of inWindow) for (const u of defs) if (unitHas(u, r)) buckets.get(u.key)!.push(r);
      for (const u of defs) {
        const rows = buckets.get(u.key)!;
        if (rows.length === 0) continue;
        units.push(scoreUnit(u, window, b.spec, rows, censusFor(u, window, input.census, tierOf)));
      }
    }
  }
  const cellsTested = units.filter((u) => u.clusterVerdict === 'PER_CLUSTER').length;
  const auxiliaryLooks = units.reduce(
    (a, u) =>
      a +
      (u.full
        ? u.full.coverage.edgeAt.filter((t) => t.keep < 1 && t.ciLbPp !== null).length + u.full.regimes.filter((g) => g.ciLbPp !== null).length
        : 0),
    0,
  );
  // the label-free emitted side mix after the flip, to now, per (exchange, timeframe)
  const sm = new Map<string, { exchange: string; timeframe: string; buy: number; sell: number }>();
  for (const r of input.sideMix) {
    const k = `${r.exchange}|${r.timeframe}`;
    const c = sm.get(k) ?? { exchange: r.exchange, timeframe: r.timeframe, buy: 0, sell: 0 };
    if (r.side === 'BUY') c.buy += r.n; else c.sell += r.n;
    sm.set(k, c);
  }
  const sideCells = [...sm.values()]
    .sort((a, b) => (a.exchange + a.timeframe < b.exchange + b.timeframe ? -1 : 1))
    .map((c) => ({ ...c, minorityShare: Math.min(c.buy, c.sell) / (c.buy + c.sell) }));
  // the chain is per unit over the REGISTERED rows (label-free), so its unit set is the presence rows' own
  const coverage = buildCoverage({
    presence: input.presence, rows: input.rows, manifest: input.manifest, relabelLaunchTs: input.meta.relabelLaunchTs, tierOf,
    defs: unitsOf(input.presence.map((p) => ({ exchange: p.exchange, timeframe: p.timeframe, tier: tierOf(p.coin) }))).filter(
      (u) => !input.onlyKinds || input.onlyKinds.includes(u.kind),
    ),
  });
  return {
    specVersion: ADS1_SPEC_VERSION,
    generatedFrom: input.meta,
    disclosures: {
      rows: input.rows.length,
      rowsByWindow: { FULL: input.rows.length, POST_FLIP: input.rows.filter((r) => r.createdAt > T_FLIP).length },
      lowVolExcluded,
      specMissing,
      unmappedCoins: [...unmapped].sort(),
      unmappedRows,
      edgexPreFixRows: edgexPre,
      expiryDisagreements,
      rowsOutsideTCap: outside,
      v1RowsAfterFlip: v1After,
    },
    units,
    coverage,
    cellsTested,
    auxiliaryLooks,
    sideMix: { cells: sideCells, informativeCells: sideCells.filter((c) => c.minorityShare >= 0.1).length, floor: 0.1 },
  };
}

// ── the self-check ───────────────────────────────────────────────────────────────────────────────

export const RO_TOKEN = 'TOKEN current_user=aoe_readonly transaction_read_only=on';
/** The nightly label window no pull or counter read may overlap (UTC minutes of the day). */
export const NIGHTLY_WINDOW_MIN: readonly [number, number] = [2 * 60 + 20, 6 * 60 + 30];

function inNightlyWindow(epochS: number): boolean {
  const d = new Date(epochS * 1000);
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return m >= NIGHTLY_WINDOW_MIN[0] && m < NIGHTLY_WINDOW_MIN[1];
}

export interface SelfCheck {
  rows: Array<{ check: string; pass: boolean; detail: string }>;
  line: string;
  pass: boolean;
}

export function selfCheck(sc: Scorecard): SelfCheck {
  const m = sc.generatedFrom;
  const rows: SelfCheck['rows'] = [];
  const add = (check: string, pass: boolean, detail: string) => rows.push({ check, pass, detail });
  const maxResidual = sc.units.reduce((a, u) => Math.max(a, u.identityResidual), 0);
  add('pooled identity (edgePpPooled = Σ_side share·(hit − q), every unit)', maxResidual <= 1e-9, `max residual ${maxResidual.toExponential(2)}`);
  const neffOver = sc.units.filter((u) => u.nEff !== null && u.nEff > u.nScored + 1e-9).length;
  add('nEff ≤ n (every unit)', neffOver === 0, `${neffOver} violations`);
  const badProv = sc.units.filter(
    (u) => u.full?.verdict.token === 'PROVISIONAL' && !(u.nEff === null || u.nEff < N_EFF_FLOOR || u.full.verdict.reason === 'under-clustered'),
  ).length;
  add(`PROVISIONAL ⇒ nEff < ${N_EFF_FLOOR} or under-clustered`, badProv === 0, `${badProv} violations`);
  const exc = sc.units.filter((u) => u.full?.verdict.token === 'EXCEPTIONAL').length;
  add('no EXCEPTIONAL token (unreachable before 365 live days)', exc === 0, `${exc} units`);
  // §10 "Ordering": the row tests the LATER of the two commits — the registration AND its one pre-read amendment.
  add(
    'registration and amendment landed before the pull',
    Number.isFinite(m.registrationCommitTs) && Number.isFinite(m.amendmentCommitTs) &&
      m.registrationCommitTs <= m.amendmentCommitTs && Math.max(m.registrationCommitTs, m.amendmentCommitTs) < m.pullStartTs,
    `registration ${m.registrationCommit} @ ${m.registrationCommitTs} · amendment ${m.amendmentCommit} @ ${m.amendmentCommitTs} < pull @ ${m.pullStartTs}`,
  );
  add('read-only token on every session part', m.tokenLines.length >= 4 && m.tokenLines.every((t) => t === RO_TOKEN), `${m.tokenLines.length} token lines`);
  add('pull and counter reads outside 02:20–06:30Z', !inNightlyWindow(m.pullStartTs) && !inNightlyWindow(m.pullEndTs), `${m.pullStartTs}..${m.pullEndTs}`);
  const cb = m.countersBefore, ca = m.countersAfter;
  const deltaZero = !!cb && !!ca && ca.ins === cb.ins && ca.upd === cb.upd && ca.del === cb.del;
  add('directional_labels write counters unchanged across the pull', deltaZero, cb && ca ? `ins +${ca.ins - cb.ins} upd +${ca.upd - cb.upd} del +${ca.del - cb.del}` : 'counters missing');
  add('every extracted row is under T_CAP (max form)', sc.disclosures.rowsOutsideTCap === 0, `${sc.disclosures.rowsOutsideTCap} rows outside`);
  add('no rule-v1 row after T_FLIP (extract and to-now count)', sc.disclosures.v1RowsAfterFlip === 0 && m.integrity.v1_after_flip === 0, `extract ${sc.disclosures.v1RowsAfterFlip} · to-now ${m.integrity.v1_after_flip}`);
  const malformed = sc.units.reduce((a, u) => a + u.malformedRows, 0);
  add('no malformed race row', malformed === 0, `${malformed}`);
  add('expiry return identical across barrier specs', sc.disclosures.expiryDisagreements === 0, `${sc.disclosures.expiryDisagreements} disagreements`);
  add('a headline unit exists', sc.units.some((u) => u.key === 'fleet:crypto' && u.window === 'POST_FLIP' && u.spec === PRIMARY_BARRIER_SPEC), 'fleet:crypto POST_FLIP primary');
  // ── registration §10 (the -v2 amendment)
  const cv = sc.coverage;
  add('every -v2 row has gap_t10 = 0', cv.gapNonZero === 0 && cv.gapNull === 0, `${cv.gapNonZero} non-zero · ${cv.gapNull} NULL`);
  // non-blocking on a NON-ZERO count (§10.4: printed, excluded as registered, escalated) — but it CAN fail: the
  // by-construction tally must equal the scorer's own count on the fleet:all FULL primary unit (same rows).
  const fleetAll = sc.units.find((u) => u.key === 'fleet:all' && u.window === 'FULL' && u.spec === PRIMARY_BARRIER_SPEC);
  add(
    'INCONSISTENT reported',
    Number.isInteger(cv.inconsistent) && Number.isInteger(cv.unresolved) &&
      (fleetAll ? fleetAll.inconsistent === cv.inconsistent && fleetAll.unresolved === cv.unresolved : cv.inconsistent === 0 && cv.unresolved === 0),
    `INCONSISTENT ${cv.inconsistent} · UNRESOLVED ${cv.unresolved} (expected 0 by construction${cv.inconsistent + cv.unresolved > 0 ? '; excluded as registered and ESCALATED to the LRW owner' : ''})`,
  );
  const specs = new Set(sc.units.map((u) => u.spec));
  const allV2 = ADS1_BARRIER_SPECS.every((b) => b.spec.endsWith('-v2')) && [...specs].every((x) => ADS1_BARRIER_SPECS.some((b) => b.spec === x));
  add('family = -v2 on every label column', allV2 && m.extractFamily === PRIMARY_BARRIER_SPEC, `extract declares '${m.extractFamily}' · unit specs ${[...specs].sort().join(', ')}`);
  add('presence -v2 set = extract set', cv.idSetsEqual && cv.presenceV2 === cv.extractRows, `presence ${cv.presenceV2} · extract ${cv.extractRows}`);
  add('presence T_ADAPTER flag agrees with the extract stamp', cv.presencePostAdapterAgrees, cv.presencePostAdapterAgrees ? 'agree' : 'disagree');
  const done = (t: string) => m.doneTokens.some((x) => x.startsWith(`${t}=YES`));
  add('LRW DONE probes YES (relabel + annotation)', done('LRW_RELABEL_COMPLETE') && done('LRW_ANNOTATION_COMPLETE'), m.doneTokens.map((t) => t.split(' ')[0]).join(' · ') || 'none');
  add('relabel launch recorded, after T_CUT, before the pull', Number.isFinite(m.relabelLaunchTs) && m.relabelLaunchTs >= T_CUT && m.relabelLaunchTs < m.pullStartTs, `launch ${m.relabelLaunchTs} · T_CUT ${T_CUT}`);
  add('no deferred / held-back signal under T_CAP', cv.deferredUnderTCap === 0, `${cv.deferredUnderTCap}`);
  const preCut = cv.byCell.filter((r) => r.window === 'FULL').reduce((a, r) => a + r.byClass.pre_cut, 0);
  add('no -v2 row first written before T_CUT', preCut === 0, `${preCut}`);
  const failed = rows.filter((r) => !r.pass).map((r) => r.check);
  const pass = failed.length === 0 && rows.length > 0;
  return { rows, pass, line: pass ? `ADS1_SCORECARD_SELFCHECK: PASS (${rows.length} checks)` : `ADS1_SCORECARD_SELFCHECK: FAIL ${failed.join('; ')}` };
}

// ── rendering ────────────────────────────────────────────────────────────────────────────────────

const pct = (x: number | null | undefined, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? null : (x * 100).toFixed(d));
const fx = (x: number | null | undefined, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? null : x.toFixed(d));
const or = (v: string | number | null, reason: string) => (v === null ? `n/a: ${reason}` : String(v));
const ppOr = (v: string | null, reason: string) => (v === null ? `n/a: ${reason}` : `${v} pp`);

function tiles(u: UnitScore): string[] {
  const f = u.full!;
  const t = (x: number | null, d = 2) => fx(x, d);
  const edgeAt = f.coverage.edgeAt
    .map((e) => `${Math.round(e.keep * 100)} %: ${ppOr(t(e.edgePp), 'UNDER_CLUSTERED')} (n ${e.n}, conf ≥ ${e.minConfidence})`)
    .join(' · ');
  return [
    `- **L0 complete label** — dwrComplete ${or(pct(u.dwrComplete), 'NO_SCORED_ROWS')} % (W′ ${u.wins} / L′ ${u.losses}) · dwrDecided ${or(pct(u.dwrDecided), 'NO_DECIDED_ROWS')} % · FLAT rate ${or(pct(u.flatRate), 'NONE_RESOLVED')} % · timeout rate ${or(pct(u.timeoutRate), 'NO_ROWS')} % · unresolved ${u.unresolved} · inconsistent ${u.inconsistent}`,
    `- **L1 edge** — edgePp (per-day) ${ppOr(t(u.edgePp), 'UNDER_CLUSTERED')} [clusterCiLb ${ppOr(t(u.clusterCiLbPp), 'UNDER_CLUSTERED')}, p ${or(fx(u.clusterP, 4), 'UNDER_CLUSTERED')}, t ${or(t(u.tStat), 'UNDER_CLUSTERED')}, ${u.clusters} days kept / ${u.clustersDropped} dropped] · edgePpPooled ${ppOr(t(u.edgePpPooled), 'NO_SCORED_ROWS')} · p0 ${or(pct(u.p0), 'NO_SCORED_ROWS')} % (always-BUY ${or(pct(u.alwaysBuy), 'NO_SCORED_ROWS')} % / always-SELL ${or(pct(u.alwaysSell), 'NO_SCORED_ROWS')} %) · identifiability ${u.identifiable ? 'OK' : `NOT_IDENTIFIABLE (${u.identReason})`} (minority ${or(pct(u.minorityShare), 'NO_SCORED_ROWS')} %, Fréchet ${or(t(u.attainablePp), 'NO_SCORED_ROWS')} pp, PT z ${or(t(u.ptZ), 'PT_UNDEFINED')}) · nEff ${or(fx(u.nEff, 0), 'ICC_UNDEFINED')} of n ${u.nScored} (ρ ${or(fx(u.rho, 5), 'ICC_UNDEFINED')}, m* ${fx(u.mStar, 1)}, ${u.nDays} days)`,
    `- **L2 calibration** — BSS ${or(fx(f.calibration.bss, 4), 'NO_SCORED_ROWS')} · ECE ${or(fx(f.calibration.ece, 4), 'NO_SCORED_ROWS')} · Spearman ${or(fx(f.calibration.spearman, 3), 'FEWER_THAN_2_BINS')} · Brier impl ${or(fx(f.calibration.brierImpl, 4), 'NO_SCORED_ROWS')} / base ${or(fx(f.calibration.brierBase, 4), 'NO_SCORED_ROWS')} / ½ ${or(fx(f.calibration.brierHalf, 4), 'NO_SCORED_ROWS')} · rows before the April floor ${f.calibration.rowsBeforeCalibFloor}`,
    `- **L3 coverage (emitted arm)** — coverage n/a: ${f.coverage.naReason ?? 'NONE'} · HOLD share n/a: ${f.coverage.naReason ?? 'NONE'} · census ${f.coverage.census ? `signals ${f.coverage.census.signals} · band_signals ${f.coverage.census.bandSignals} · hold evaluations ${f.coverage.census.holdCounts} · emit suppressions ${f.coverage.census.emitSuppressions}` : 'n/a: CENSUS_HAS_NO_VENUE'} · all-decisions edge ${f.coverage.allDecisionsEdge} · edge@ ${edgeAt} · flips/group-day ${or(fx(f.coverage.flipsPerGroupDay, 3), 'NO_GROUPS')} (reversal share ${or(pct(f.coverage.reversalShare), 'NO_PAIRS')} %)`,
    `- **L4 payoff** — median barrier ${or(fx(f.payoff.medianBarrierPct, 3), 'NO_ROWS')} % · break-even taker ${or(pct(f.payoff.breakEvenTaker), 'NO_ROWS')} % / maker ${or(pct(f.payoff.breakEvenMaker), 'NO_ROWS')} % · Wilson lb ${or(pct(u.wilsonLb), 'NO_SCORED_ROWS')} % · tradeable ${f.verdict.tradeable} · mean signed expiry R ${or(fx(f.payoff.meanSignedExpiryRetR, 4), 'NO_EXPIRY')} (n ${f.payoff.nWithExpiry})`,
    `- **L5 provenance** — anchored share ${or(pct(f.merkleCoverage), 'NO_ROWS')} % · live days ${fx(f.liveDays, 1)} · regimes (v3) with CI-lb > 0: ${f.regimesCiLbAbove0} · spec ${f.specVersion}`,
    `- ${renderVerdict(f.verdict)} (${f.verdict.reason})`,
  ];
}

function cellRow(u: UnitScore): string {
  const f = u.full;
  const cells = [
    u.key, u.window, String(u.n), String(u.nScored), String(u.nDays), or(fx(u.rho, 4), 'ICC_UNDEFINED'), or(fx(u.nEff, 0), 'ICC_UNDEFINED'),
    or(pct(u.scoredBuyShare, 1), 'NO_SCORED_ROWS'), u.identifiable ? 'OK' : `NI:${u.identReason}`,
    or(pct(u.dwrDecided), 'NO_DECIDED'), or(pct(u.dwrComplete), 'NO_SCORED'), or(pct(u.flatRate), 'NONE'), or(pct(u.timeoutRate), 'NO_ROWS'), String(u.unresolved),
    or(pct(u.alwaysBuy), 'NO_SCORED'), or(pct(u.alwaysSell), 'NO_SCORED'), or(pct(u.p0), 'NO_SCORED'),
    or(fx(u.edgePp), 'UNDER_CLUSTERED'), or(fx(u.edgePpPooled), 'NO_SCORED'), or(pct(u.wilsonLb), 'NO_SCORED'),
    or(fx(u.clusterCiLbPp), 'UNDER_CLUSTERED'), or(fx(u.clusterP, 4), 'UNDER_CLUSTERED'), or(fx(u.tStat), 'UNDER_CLUSTERED'), or(fx(u.ptZ), 'PT_UNDEFINED'),
  ];
  if (f) {
    cells.push(
      or(fx(f.calibration.spearman, 3), 'LT_2_BINS'), or(fx(f.calibration.brierImpl, 4), 'NO_SCORED'), or(fx(f.calibration.brierBase, 4), 'NO_SCORED'),
      or(fx(f.calibration.bss, 4), 'NO_SCORED'), or(fx(f.calibration.ece, 4), 'NO_SCORED'),
      `n/a: ${f.coverage.naReason}`, `n/a: ${f.coverage.naReason}`, f.coverage.census ? String(f.coverage.census.bandSignals) : 'n/a: CENSUS_HAS_NO_VENUE',
      ...f.coverage.edgeAt.map((e) => or(fx(e.edgePp), 'UNDER_CLUSTERED')),
      or(fx(f.coverage.flipsPerGroupDay, 3), 'NO_GROUPS'), or(fx(f.payoff.medianBarrierPct, 3), 'NO_ROWS'),
      or(pct(f.payoff.breakEvenTaker), 'NO_ROWS'), or(pct(f.payoff.breakEvenMaker), 'NO_ROWS'), f.verdict.tradeable,
      or(fx(f.payoff.meanSignedExpiryRetR, 4), 'NO_EXPIRY'), fx(f.liveDays, 1) ?? '0', String(f.regimesCiLbAbove0), or(pct(f.merkleCoverage, 1), 'NO_ROWS'),
      f.specVersion, renderVerdict(f.verdict),
    );
  }
  return `| ${cells.join(' | ')} |`;
}

/** The coverage chain, the provenance split, the T_ADAPTER split and the by-construction counts (registration
 *  §10.4–§10.5) — cardinalities, no test, no verdict attached. */
function renderCoverage(sc: Scorecard): string[] {
  const cv = sc.coverage;
  const head = ['key', 'window', 'registered', '-v1 present', '-v2 present (n)', 'reach %', ...CHAIN_CLASSES];
  const row = (r: ChainRow) => `| ${[r.key, r.window, r.registered, r.v1Present, r.v2Present, or(pct(r.reach, 1), 'NONE'), ...CHAIN_CLASSES.map((c) => r.byClass[c])].join(' | ')} |`;
  const out: string[] = [];
  out.push('## Coverage chain (registration §10.4) — label-free cardinalities', '');
  out.push(
    `- \`relabel\` / \`nightly\` / \`no_v1_twin\` / \`pre_cut\` partition the \`-v2\` population (n); the remaining classes partition the registered rows WITHOUT a \`-v2\` row by LRW's refusal manifest (\`not_visited:*\` = no manifest line: outside the relabel's own population). Reach = \`-v2\` present / registered — a venue-data fact, no verdict rule attached.`,
    `- By-construction counts (scored population, primary spec): UNRESOLVED ${cv.unresolved} · INCONSISTENT ${cv.inconsistent} · \`gap_t10\` ≠ 0: ${cv.gapNonZero} (NULL ${cv.gapNull}) · deferred / held back under T_CAP: ${cv.deferredUnderTCap} — each expected 0.`,
  );
  if (cv.unresolved + cv.inconsistent + cv.gapNonZero + cv.gapNull > 0) {
    out.push(`- **→ LRW owner (\`EDGE-LABELER-RACE-WINDOW-V2-W1\`), a generator finding, not routed around:** ${cv.unresolved} UNRESOLVED · ${cv.inconsistent} INCONSISTENT · ${cv.gapNonZero + cv.gapNull} non-zero/NULL \`race_gap_candles\` on \`-v2\` rows — excluded as registered, never coerced.`);
  }
  out.push('', '### By (exchange, timeframe)', '', `| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...cv.byCell.map(row), '');
  out.push('### By unit', '', `| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...cv.byUnit.map(row), '');
  out.push('### Adapter-pending cells split at T_ADAPTER (registration §10.5)', '', '| cell | window | computed ≥ T_ADAPTER | pre-adapter-fix | presence post-adapter |', '|---|---|---:|---:|---:|');
  for (const a of cv.adapterSplit) out.push(`| ${a.cell} | ${a.window} | ${a.postAdapter} | ${a.preAdapterFix} | ${a.presencePostAdapter} |`);
  if (cv.adapterSplit.length === 0) out.push('| (no -v2 row in these cells) | — | 0 | 0 | 0 |');
  out.push('');
  return out;
}

const L01_HEAD = ['unit', 'window', 'n', 'nScored', 'nDays', 'rho', 'nEff', 'sideMix BUY %', 'identifiability', 'dwrDecided %', 'dwrComplete %', 'flatRate %', 'timeoutRate %', 'unresolved', 'alwaysBUY %', 'alwaysSELL %', 'p0 %', 'edgePp', 'edgePpPooled', 'wilsonLb %', 'clusterCiLb', 'clusterP', 't', 'PT z'];
const FULL_HEAD = [...L01_HEAD, 'spearman', 'brierImpl', 'brierBase', 'BSS', 'ECE', 'coverageCensus', 'holdShareCensus', 'bandSignalsCount', 'edge@100', 'edge@75', 'edge@50', 'flipRate', 'medianBarrierPct', 'breakEvenTaker %', 'breakEvenMaker %', 'tradeable', 'meanSignedExpiryRetR', 'liveDays', 'regimesCiLbAbove0', 'merkleCoverage %', 'specVersion', 'verdict'];

function table(head: string[], units: UnitScore[]): string[] {
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...units.map(cellRow)];
}

export function renderMarkdown(sc: Scorecard, headerClause: string, check: SelfCheck, extractPath: string): string {
  const m = sc.generatedFrom;
  const P = PRIMARY_BARRIER_SPEC;
  const find = (key: string, window: WindowName, spec = P) => sc.units.find((u) => u.key === key && u.window === window && u.spec === spec);
  const head = find('fleet:crypto', 'POST_FLIP');
  const tfBoard = sc.units.filter((u) => u.kind === 'tf' && u.scope === 'crypto' && u.window === 'POST_FLIP' && u.spec === P);
  const out: string[] = [];
  out.push(`# EDGE-ADS1-SCORECARD-W1 — AlgoVault's ADS-1 cell scorecard (${ADS1_SPEC_VERSION}) — PRIVATE`, '');
  out.push(headerClause.trim(), '');
  out.push('## Provenance', '');
  out.push(`- Registration: \`${m.registrationPath}\` @ \`${m.registrationCommit}\`, landed ${new Date(m.registrationCommitTs * 1000).toISOString()} · amendment (§10) @ \`${m.amendmentCommit}\`, landed ${new Date(m.amendmentCommitTs * 1000).toISOString()} · pull ${new Date(m.pullStartTs * 1000).toISOString()} → ${new Date(m.pullEndTs * 1000).toISOString()} (\`date -u\`).`);
  out.push(`- Family: the extract declares \`${m.extractFamily}\` (primary) · relabel launch \`${m.relabelLaunchTs}\` (${Number.isFinite(m.relabelLaunchTs) ? new Date(m.relabelLaunchTs * 1000).toISOString() : 'n/a'}) · T_CUT \`${T_CUT}\` · T_ADAPTER \`${T_ADAPTER}\`.`);
  out.push(`- LRW DONE probes (read-only, run by this session): ${m.doneTokens.map((t) => `\`${t.split(' ')[0]}\``).join(' · ') || 'none'} · refusal manifest sha256 ${m.manifestSha256.map((h) => `\`${h}\``).join(' · ') || 'none'}.`);
  out.push(`- Extract: \`${extractPath}\` (Mac scratch; never committed, never in the vault) · sha256 \`${m.extractSha256}\` · ${sc.disclosures.rows} rows (POST_FLIP ${sc.disclosures.rowsByWindow.POST_FLIP}).`);
  out.push(`- Tier instrument: \`/api/performance-public\` \`byTier[].assets\` fetched ${m.tiersFetchedAt}, sha256 \`${m.tiersSha256}\` — present-day membership applied to every row (a limitation, disclosed); unmapped coins ${sc.disclosures.unmappedCoins.length} (${sc.disclosures.unmappedRows} rows).`);
  out.push(`- Read-only tokens: ${m.tokenLines.map((t) => `\`${t}\``).join(' · ')}`);
  out.push(`- directional_labels counters before → after: ${m.countersBefore ? `ins ${m.countersBefore.ins} / upd ${m.countersBefore.upd} / del ${m.countersBefore.del}` : 'missing'} → ${m.countersAfter ? `ins ${m.countersAfter.ins} / upd ${m.countersAfter.upd} / del ${m.countersAfter.del}` : 'missing'}.`);
  out.push(`- Disclosed: low-volatility rows excluded ${JSON.stringify(sc.disclosures.lowVolExcluded)} · sensitivity spec missing on primary rows ${JSON.stringify(sc.disclosures.specMissing)} · sensitivity-only rows left out ${m.integrity.sensitivity_only_under_tcap ?? 'n/a'} · EDGEX pre-fix cohort ${sc.disclosures.edgexPreFixRows} rows (D33: labels unaffected, kept) · 1m: absent from the label window (0 labels).`);
  out.push(`- **cells_tested = ${sc.cellsTested}** (every (unit, window, barrier spec) whose day-cluster lower bound was computed) · auxiliary looks ${sc.auxiliaryLooks} (conviction-trimmed and regime-level bounds; reported, not claims).`, '');
  out.push('## (i) Our score — fleet, POST_FLIP, primary spec, crypto-only (tiers 1, 2, 4)', '');
  if (head?.full) {
    const ch = sc.coverage.byUnit.find((r) => r.key === 'fleet:crypto' && r.window === 'POST_FLIP');
    out.push(
      `**Our score:** dwrComplete ${or(pct(head.dwrComplete), 'NO_SCORED_ROWS')} % · edgePp ${ppOr(fx(head.edgePp), 'UNDER_CLUSTERED')} [clusterCiLb ${ppOr(fx(head.clusterCiLbPp), 'UNDER_CLUSTERED')}] · BSS ${or(fx(head.full.calibration.bss, 4), 'NO_SCORED_ROWS')} · coverage chain registered ${ch?.registered ?? 'n/a'} → labelled ${ch?.v2Present ?? 'n/a'} (reach ${or(pct(ch?.reach ?? null, 1), 'NO_REGISTERED_ROWS')} %) → scored ${head.nScored} · tradeable ${head.full.verdict.tradeable} · ${renderVerdict(head.full.verdict)}`,
      '',
    );
  }
  if (head?.full) out.push(...tiles(head), '');
  else out.push('- n/a: HEADLINE_UNIT_ABSENT', '');
  const allTier = find('fleet:all', 'POST_FLIP');
  if (allTier?.full) out.push('**Sensitivity — all tiers (SoT-comparable):**', '', ...tiles(allTier), '');
  const t3 = find('tier:T3', 'POST_FLIP');
  if (t3?.full) out.push('**Tier 3 (TradFi perps incl. tokenized stocks) — reported separately:**', '', ...tiles(t3), '');
  out.push('## (ii) By timeframe — POST_FLIP, primary spec, crypto-only', '');
  for (const u of tfBoard) out.push(`### ${u.key}`, '', ...tiles(u), '');
  if (head?.full) {
    out.push('## Reliability table — the headline unit', '', '| confidence bin | n | mean p_impl | realized |', '|---|---:|---:|---:|');
    for (const b of head.full.calibration.bins) out.push(`| [${b.lo}, ${b.hi}) | ${b.n} | ${or(fx(b.pImplMean, 4), 'EMPTY')} | ${or(fx(b.realized, 4), 'EMPTY')} |`);
    out.push('', '## Regime breakdown — the headline unit', '', '| regime_rule_version | regime | n | edgePp | CI-lb |', '|---|---|---:|---:|---:|');
    for (const g of head.full.regimes) out.push(`| ${g.regimeRuleVersion ?? 'NULL'} | ${g.regime ?? 'NULL'} | ${g.n} | ${or(fx(g.edgePp), 'UNDER_CLUSTERED')} | ${or(fx(g.ciLbPp), 'UNDER_CLUSTERED')} |`);
    out.push('');
  }
  out.push('## (iii) By timeframe × regime — POST_FLIP, primary spec, crypto-only (reported, not tested)', '');
  out.push('| timeframe | regime_rule_version | regime | n | edgePp | CI-lb |', '|---|---|---|---:|---:|---:|');
  for (const u of tfBoard) {
    for (const g of u.full?.regimes ?? []) {
      out.push(`| ${u.key.split(':')[1]} | ${g.regimeRuleVersion ?? 'NULL'} | ${g.regime ?? 'NULL'} | ${g.n} | ${or(fx(g.edgePp), 'UNDER_CLUSTERED')} | ${or(fx(g.ciLbPp), 'UNDER_CLUSTERED')} |`);
    }
  }
  out.push('');
  out.push(...renderCoverage(sc));
  out.push('## POST_FLIP emitted side mix per (exchange, timeframe) — label-free, to now', '');
  out.push(`**${sc.sideMix.informativeCells} of ${sc.sideMix.cells.length} cells carry a minority side ≥ ${sc.sideMix.floor * 100} %.**`, '');
  out.push('| exchange | timeframe | BUY | SELL | minority % |', '|---|---|---:|---:|---:|');
  for (const c of sc.sideMix.cells) out.push(`| ${c.exchange} | ${c.timeframe} | ${c.buy} | ${c.sell} | ${(c.minorityShare * 100).toFixed(1)} |`);
  out.push('');
  const order: UnitKind[] = ['fleet', 'tier', 'tf', 'tf-tier', 'cell'];
  for (const window of ['POST_FLIP', 'FULL'] as const) {
    out.push(`## Every unit — ${window}, primary spec (every column, or n/a with its reason)`, '');
    out.push(...table(FULL_HEAD, order.flatMap((k) => sc.units.filter((u) => u.kind === k && u.window === window && u.spec === P))), '');
  }
  for (const b of ADS1_BARRIER_SPECS.filter((s) => s.spec !== P)) {
    for (const window of ['POST_FLIP', 'FULL'] as const) {
      out.push(`## Sensitivity — ${b.spec}, ${window} (L0 / L1 only)`, '');
      out.push(...table(L01_HEAD, order.flatMap((k) => sc.units.filter((u) => u.kind === k && u.window === window && u.spec === b.spec))), '');
    }
  }
  out.push('## Self-check', '', '| check | result | detail |', '|---|---|---|');
  for (const r of check.rows) out.push(`| ${r.check} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.detail} |`);
  out.push('', check.line, '');
  return out.join('\n');
}

/** The header clause, verbatim, from the wave spec's blockquote (the spec is its only source). */
export function extractHeaderClause(specMarkdown: string): string {
  const lines = specMarkdown.split('\n');
  const start = lines.findIndex((l) => /^>\s*##.*HEADER CLAUSE/.test(l));
  if (start < 0) throw new Error('extractHeaderClause: no "HEADER CLAUSE" blockquote in the spec');
  const body: string[] = [];
  for (let i = start + 1; i < lines.length && lines[i].startsWith('>'); i++) body.push(lines[i].replace(/^>\s?/, ''));
  const text = body.join('\n').trim();
  if (text.length < 200) throw new Error('extractHeaderClause: the clause is implausibly short');
  return text;
}
