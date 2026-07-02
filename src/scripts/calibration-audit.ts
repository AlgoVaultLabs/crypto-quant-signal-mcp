/**
 * calibration-audit.ts — EQUITY-CALIBRATION-AUDIT-W1.
 *
 * A REUSABLE, asset-class-parameterised adversarial audit of a PFE win-rate:
 * is a headline "~90% win-rate" a real directional EDGE, or a metric artifact
 * (peak-favorable-excursion base rate on an oscillating tape)? Ships PURE,
 * unit-tested computation (PFE-win predicate, benchmark edge, confidence
 * calibration + ECE, realized-hit, sign-agreement, robustness splits) so crypto
 * can be re-audited with the identical harness and options/futures/intraday
 * inherit it (Pillar 2 — generator-level fix, not a one-off equity check).
 *
 * READ-ONLY: the CLI fetcher issues only SELECTs. No writes, ever.
 *
 * SINGLE-DERIVATION: `isPfeWin` is the SHIPPED predicate, byte-identical to
 * src/lib/equities/equity-outcomes.ts + src/resources/signal-performance.ts
 * (BUY tracks the highest high → win = pfe>0; SELL the lowest low → win = pfe<0).
 * Re-inventing it here would let the audit "pass" a definition the product
 * doesn't use — forbidden.
 *
 * INTERNAL — numeric findings live in the private vault, never a response path.
 * `outcome_return_pct` may be READ for the R5 sign-agreement RATE only; its
 * values are never emitted.
 */

// ── Row shape (asset-agnostic) ───────────────────────────────────────────────
export interface AuditRow {
  call: 'BUY' | 'SELL';
  pfePct: number; // signed favorable-excursion %, entry-anchored (the SHIPPED metric)
  confidence: number; // engine conviction score, [0,1]
  entry: number; // close on the decision session (anchor)
  winHighMax: number; // max high over the forward window (for the always-BUY benchmark)
  winLowMin: number; // min low over the forward window (for the always-SELL benchmark)
  outcomeReturnPct: number; // INTERNAL close-to-close return %; used only for the sign-agreement RATE
  regime: string | null;
  bucket?: string | null;
}

// ── The SHIPPED PFE-win predicate (single-derivation; do not re-invent) ──────
export function isPfeWin(call: 'BUY' | 'SELL', pfePct: number): boolean {
  return (call === 'BUY' && pfePct > 0) || (call === 'SELL' && pfePct < 0);
}

/** Realized close-to-close directional hit: did the call's direction actually pay? */
export function isRealizedFavorable(call: 'BUY' | 'SELL', outcomeReturnPct: number): boolean {
  return (call === 'BUY' && outcomeReturnPct > 0) || (call === 'SELL' && outcomeReturnPct < 0);
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const rate = (preds: boolean[]): number => mean(preds.map((b) => (b ? 1 : 0)));

// Deterministic seeded call for the random-benchmark (index-hashed — no
// Math.random, so unit tests are reproducible and workflow-safe).
export function seededCall(index: number, seed = 1337): 'BUY' | 'SELL' {
  let h = (index + 1) * 2654435761 + seed * 40503;
  h = (h ^ (h >>> 13)) >>> 0;
  h = (h * 1274126177) >>> 0;
  return (h & 1) === 0 ? 'BUY' : 'SELL';
}

// ── R2 — base rate & benchmark edge (the centerpiece) ────────────────────────
export interface BenchmarkEdge {
  n: number;
  actualWr: number; // engine's own directional calls
  alwaysBuyWr: number; // treat every verdict as BUY → win iff any high>entry
  alwaysSellWr: number; // treat every verdict as SELL → win iff any low<entry
  randomWr: number; // seeded coin-flip direction
  anyDirectionFavorable: number; // mechanical ease: a favorable move existed in EITHER direction
  bestBenchmark: number;
  edge: number; // actualWr − bestBenchmark  (≤ ~0 ⇒ artifact)
  buyWr: number;
  sellWr: number;
  nBuy: number;
  nSell: number;
}

export function benchmarkEdge(rows: AuditRow[]): BenchmarkEdge {
  const buyRows = rows.filter((r) => r.call === 'BUY');
  const sellRows = rows.filter((r) => r.call === 'SELL');
  const alwaysBuyWr = rate(rows.map((r) => r.winHighMax > r.entry));
  const alwaysSellWr = rate(rows.map((r) => r.winLowMin < r.entry));
  const randomWr = rate(
    rows.map((r, i) =>
      seededCall(i) === 'BUY' ? r.winHighMax > r.entry : r.winLowMin < r.entry,
    ),
  );
  const actualWr = rate(rows.map((r) => isPfeWin(r.call, r.pfePct)));
  const bestBenchmark = Math.max(alwaysBuyWr, alwaysSellWr, randomWr);
  return {
    n: rows.length,
    actualWr,
    alwaysBuyWr,
    alwaysSellWr,
    randomWr,
    anyDirectionFavorable: rate(rows.map((r) => r.winHighMax > r.entry || r.winLowMin < r.entry)),
    bestBenchmark,
    edge: actualWr - bestBenchmark,
    buyWr: rate(buyRows.map((r) => isPfeWin('BUY', r.pfePct))),
    sellWr: rate(sellRows.map((r) => isPfeWin('SELL', r.pfePct))),
    nBuy: buyRows.length,
    nSell: sellRows.length,
  };
}

/** Realized directional hit-rate vs the same always-long/short/random benchmarks. */
export interface RealizedHit {
  actual: number;
  alwaysBuy: number;
  alwaysSell: number;
  edge: number;
}
export function realizedHitRate(rows: AuditRow[]): RealizedHit {
  const actual = rate(rows.map((r) => isRealizedFavorable(r.call, r.outcomeReturnPct)));
  const alwaysBuy = rate(rows.map((r) => r.outcomeReturnPct > 0));
  const alwaysSell = rate(rows.map((r) => r.outcomeReturnPct < 0));
  return { actual, alwaysBuy, alwaysSell, edge: actual - Math.max(alwaysBuy, alwaysSell) };
}

// ── R3 — confidence calibration + ECE ────────────────────────────────────────
export interface CalibrationBin {
  lo: number;
  hi: number;
  n: number;
  wr: number;
  meanConf: number;
}
export function calibrationBins(rows: AuditRow[], nBins = 10): CalibrationBin[] {
  const bins: AuditRow[][] = Array.from({ length: nBins }, () => []);
  for (const r of rows) {
    const c = Math.min(Math.max(r.confidence, 0), 1);
    const idx = Math.min(nBins - 1, Math.floor(c * nBins)); // conf==1 → last bin
    bins[idx].push(r);
  }
  return bins
    .map((b, i) => ({
      lo: i / nBins,
      hi: (i + 1) / nBins,
      n: b.length,
      wr: rate(b.map((r) => isPfeWin(r.call, r.pfePct))),
      meanConf: mean(b.map((r) => r.confidence)),
    }))
    .filter((b) => b.n > 0);
}

/** Expected Calibration Error: Σ (n_b/N)·|WR_b − meanConf_b|. */
export function expectedCalibrationError(bins: CalibrationBin[]): number {
  const total = bins.reduce((a, b) => a + b.n, 0);
  if (total === 0) return 0;
  return bins.reduce((acc, b) => acc + (b.n / total) * Math.abs(b.wr - b.meanConf), 0);
}

/** Monotonic iff WR is non-decreasing across bins with n ≥ minN. */
export function isMonotonic(bins: CalibrationBin[], minN = 20): boolean {
  const wrs = bins.filter((b) => b.n >= minN).map((b) => b.wr);
  for (let i = 1; i < wrs.length; i++) if (wrs[i] < wrs[i - 1] - 1e-9) return false;
  return wrs.length > 1;
}

// ── R5 — magnitude + PFE↔realized sign agreement ─────────────────────────────
/** percentile_cont-equivalent (linear interpolation on the sorted sample). */
export function percentileCont(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  if (n === 1) return sortedAsc[0];
  const rank = p * (n - 1);
  const lo = Math.floor(rank);
  const frac = rank - lo;
  if (lo + 1 >= n) return sortedAsc[n - 1];
  return sortedAsc[lo] + frac * (sortedAsc[lo + 1] - sortedAsc[lo]);
}

export interface MagnitudeQuartiles {
  nWins: number;
  p25: number;
  median: number;
  p75: number;
}
export function winMagnitudeQuartiles(rows: AuditRow[]): MagnitudeQuartiles {
  const mags = rows
    .filter((r) => isPfeWin(r.call, r.pfePct))
    .map((r) => Math.abs(r.pfePct))
    .sort((a, b) => a - b);
  return {
    nWins: mags.length,
    p25: percentileCont(mags, 0.25),
    median: percentileCont(mags, 0.5),
    p75: percentileCont(mags, 0.75),
  };
}

export interface SignAgreement {
  nPfeWins: number;
  pfeWinAlsoRealizedFav: number; // of PFE-wins, fraction that also ended net-favorable
  overallAgreement: number; // fraction where PFE-win flag == realized-favorable flag
}
export function signAgreement(rows: AuditRow[]): SignAgreement {
  const wins = rows.filter((r) => isPfeWin(r.call, r.pfePct));
  return {
    nPfeWins: wins.length,
    pfeWinAlsoRealizedFav: rate(wins.map((r) => isRealizedFavorable(r.call, r.outcomeReturnPct))),
    overallAgreement: rate(
      rows.map((r) => isPfeWin(r.call, r.pfePct) === isRealizedFavorable(r.call, r.outcomeReturnPct)),
    ),
  };
}

// ── R6 — robustness splits ───────────────────────────────────────────────────
export interface SplitCell {
  key: string;
  n: number;
  wr: number;
}
export function splitWr(rows: AuditRow[], keyFn: (r: AuditRow) => string | null): SplitCell[] {
  const groups = new Map<string, AuditRow[]>();
  for (const r of rows) {
    const k = keyFn(r) ?? '(null)';
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  return [...groups.entries()]
    .map(([key, rs]) => ({ key, n: rs.length, wr: rate(rs.map((r) => isPfeWin(r.call, r.pfePct))) }))
    .sort((a, b) => b.n - a.n);
}

// ── Report orchestration (pure) ──────────────────────────────────────────────
export interface AuditReport {
  assetClass: string;
  n: number;
  headlineWr: number;
  edge: BenchmarkEdge;
  realized: RealizedHit;
  calibration: { bins: CalibrationBin[]; ece: number; monotonic: boolean };
  magnitude: MagnitudeQuartiles;
  sign: SignAgreement;
  byRegime: SplitCell[];
  byBucket: SplitCell[];
  edgeFloorPts: number;
  verdict: 'GO' | 'GO-WITH-REFRAME' | 'NO-GO';
}

/**
 * Verdict rule: NO-GO when the PFE-win edge over the best naive benchmark is
 * below the floor (metric artifact) OR realized directional edge ≤ 0 (the calls
 * don't beat a coin flip on realized return). GO-WITH-REFRAME when there is a
 * real (≥floor) PFE edge but PFE↔realized agreement is weak (needs caveats).
 * GO only when both edges clear their floors.
 */
export function computeAuditReport(
  rows: AuditRow[],
  assetClass: string,
  edgeFloorPts = 0.08,
): AuditReport {
  const edge = benchmarkEdge(rows);
  const realized = realizedHitRate(rows);
  const bins = calibrationBins(rows);
  let verdict: AuditReport['verdict'];
  if (edge.edge < edgeFloorPts || realized.edge <= 0) verdict = 'NO-GO';
  else if (signAgreement(rows).pfeWinAlsoRealizedFav < 0.6) verdict = 'GO-WITH-REFRAME';
  else verdict = 'GO';
  return {
    assetClass,
    n: rows.length,
    headlineWr: edge.actualWr,
    edge,
    realized,
    calibration: { bins, ece: expectedCalibrationError(bins), monotonic: isMonotonic(bins) },
    magnitude: winMagnitudeQuartiles(rows),
    sign: signAgreement(rows),
    byRegime: splitWr(rows, (r) => r.regime),
    byBucket: splitWr(rows, (r) => r.bucket ?? null),
    edgeFloorPts,
    verdict,
  };
}

// ── Crypto loader (2nd asset class — Pillar 2 reuse of the SAME pure fns) ─────
// The crypto `signals` table stores BOTH pfe_return_pct (favorable excursion)
// AND mae_return_pct (adverse excursion). Because pfe tracks the favorable side
// and mae the adverse side, and favorable/adverse map to window high/low by call
// direction, we can RECONSTRUCT the window max-high and min-low from stored
// columns alone — so the always-BUY / always-SELL benchmarks need NO kline
// re-fetch. Single-derivation: `isPfeWin(call, pfe_return_pct)` is the shipped
// crypto predicate (src/resources/signal-performance.ts), unchanged.
export interface CryptoSignalRow {
  signal: 'BUY' | 'SELL';
  pfe_return_pct: number; // favorable-side excursion %, entry-anchored
  mae_return_pct: number; // adverse-side excursion %, entry-anchored
  outcome_return_pct: number; // close-to-close return % (realized)
  confidence: number; // INTEGER 0-100 as stored
  coin: string;
  regime: string | null;
}

/** BTC/ETH = Tier-1. Full 4-tier needs the dynamic hourly top-20-OI set, which
 * cannot be reconstructed historically → the audit segments primarily by
 * timeframe (fully accurate) and reports T1-vs-rest as the tier proxy. */
export function cryptoTierProxy(coin: string): string {
  return coin === 'BTC' || coin === 'ETH' ? 'T1_bluechip' : 'rest';
}

/** Reconstruct a benchmark-ready AuditRow from one stored crypto signal. */
export function cryptoRowToAudit(r: CryptoSignalRow): AuditRow {
  // BUY: pfe = high-side (≥0), mae = low-side (≤0). SELL: pfe = low-side (≤0),
  // mae = high-side (≥0). So the window extrema recover as:
  const maxHighExc = r.signal === 'BUY' ? r.pfe_return_pct : r.mae_return_pct; // % of entry above
  const minLowExc = r.signal === 'BUY' ? r.mae_return_pct : r.pfe_return_pct; // % of entry below
  const entry = 1; // benchmarks depend only on signs/ratios; entry is a scale-free anchor
  return {
    call: r.signal,
    pfePct: r.pfe_return_pct,
    confidence: r.confidence / 100, // integer 0-100 → [0,1]
    entry,
    winHighMax: entry * (1 + maxHighExc / 100),
    winLowMin: entry * (1 + minLowExc / 100),
    outcomeReturnPct: r.outcome_return_pct,
    regime: r.regime,
    bucket: cryptoTierProxy(r.coin),
  };
}

// ── Edge-metric layer (CRYPTO-EDGE-METRIC-W1) — statistically-honest cell test ─
// The audit's coarse scan lacked CIs, multiple-testing control, and out-of-sample
// validation. A "winning cell" found by scanning N cells is a false positive
// unless it (a) beats its best always-long/short benchmark by a CI-separated
// margin, (b) survives FDR at q across ALL cells tested, and (c) repeats
// out-of-sample. The benchmark is the CRUX: realized-hit-vs-50% is inflated by
// tape drift — the honest edge is realized-hit − max(always-BUY, always-SELL).

/** erf via Abramowitz-Stegun 7.1.26. */
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** Wilson score interval for a binomial proportion k/n. */
export function wilsonInterval(k: number, n: number, z = 1.96): { lo: number; hi: number; pHat: number } {
  if (n === 0) return { lo: 0, hi: 1, pHat: NaN };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half), pHat: p };
}

/** One-sided z-test that the observed rate exceeds a benchmark rate p0. */
export function excessZP(hits: number, n: number, p0: number): { z: number; p: number } {
  if (n === 0 || p0 <= 0 || p0 >= 1) return { z: 0, p: 1 };
  const pHat = hits / n;
  const se = Math.sqrt((p0 * (1 - p0)) / n);
  const z = (pHat - p0) / se;
  return { z, p: 1 - normalCdf(z) };
}

/** Benjamini-Hochberg FDR at level q. Returns per-index rejection + the cut p. */
export function benjaminiHochberg(pvals: number[], q = 0.05): { rejected: boolean[]; threshold: number } {
  const m = pvals.length;
  const order = pvals.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  let kMax = -1;
  for (let r = 0; r < m; r++) if (order[r].p <= ((r + 1) / m) * q) kMax = r;
  const rejected = new Array(m).fill(false);
  for (let r = 0; r <= kMax; r++) rejected[order[r].i] = true;
  return { rejected, threshold: kMax >= 0 ? order[kMax].p : 0 };
}

/** Bonferroni family-wise correction. */
export function bonferroni(pvals: number[], q = 0.05): boolean[] {
  const thr = q / Math.max(1, pvals.length);
  return pvals.map((p) => p <= thr);
}

export interface EdgeSplit {
  n: number;
  engineHits: number; // realized directional hits (engine's call correct on close-to-close)
  upCount: number; // signals with outcome_return_pct > 0 (for the always-long/short benchmark)
}
export interface EdgeCell {
  key: string;
  full: EdgeSplit;
  train: EdgeSplit;
  holdout: EdgeSplit;
}
/** Best naive fixed-direction accuracy = max(always-BUY, always-SELL) realized. */
export function naiveRate(s: EdgeSplit): number {
  return s.n > 0 ? Math.max(s.upCount, s.n - s.upCount) / s.n : 0;
}

export interface EdgeCellResult {
  key: string;
  n: number;
  realizedHit: number;
  naive: number;
  excess: number; // realizedHit − naive  (the honest directional edge)
  z: number;
  p: number;
  ciLo: number;
  ciHi: number;
  fdrReject: boolean;
  bonferroni: boolean;
  holdoutN: number;
  holdoutExcess: number;
  holdoutZ: number;
  validated: boolean; // FDR-corrected AND out-of-sample-persistent
}
export interface EdgeReport {
  familySize: number;
  q: number;
  minN: number;
  rawPass: number;
  fdrPass: number;
  bonferroniPass: number;
  validated: number;
  verdict: 'EDGE-FOUND' | 'NO-VALIDATED-EDGE';
  cells: EdgeCellResult[];
}

/**
 * The full rigor: benchmark-excess + Wilson CI + BH-FDR (+ Bonferroni cross-check)
 * + walk-forward. A cell is `validated` ONLY if it survives FDR AND its holdout
 * excess is positive and one-sided-significant. `EDGE-FOUND` iff ≥1 validated.
 */
export function edgeMetricReport(cells: EdgeCell[], opts: { q?: number; minN?: number } = {}): EdgeReport {
  const q = opts.q ?? 0.05;
  const minN = opts.minN ?? 30;
  const powered = cells.filter((c) => c.full.n >= minN);
  const stats = powered.map((c) => {
    const nr = naiveRate(c.full);
    const rh = c.full.engineHits / c.full.n;
    const { z, p } = excessZP(c.full.engineHits, c.full.n, nr);
    const wi = wilsonInterval(c.full.engineHits, c.full.n);
    const hoNr = naiveRate(c.holdout);
    const hoRh = c.holdout.n > 0 ? c.holdout.engineHits / c.holdout.n : 0;
    const hoExcess = c.holdout.n > 0 ? hoRh - hoNr : 0;
    const hoZ = c.holdout.n > 0 ? excessZP(c.holdout.engineHits, c.holdout.n, hoNr).z : 0;
    return { key: c.key, n: c.full.n, realizedHit: rh, naive: nr, excess: rh - nr, z, p, ciLo: wi.lo, ciHi: wi.hi, holdoutN: c.holdout.n, holdoutExcess: hoExcess, holdoutZ: hoZ };
  });
  const pvals = stats.map((s) => s.p);
  const { rejected } = benjaminiHochberg(pvals, q);
  const bonf = bonferroni(pvals, q);
  const cellResults: EdgeCellResult[] = stats.map((s, i) => ({
    ...s,
    fdrReject: rejected[i],
    bonferroni: bonf[i],
    validated: rejected[i] && s.holdoutN >= minN && s.holdoutExcess > 0 && s.holdoutZ > 1.645,
  }));
  const validated = cellResults.filter((c) => c.validated).length;
  return {
    familySize: powered.length,
    q,
    minN,
    rawPass: stats.filter((s) => s.p < 0.05).length,
    fdrPass: rejected.filter(Boolean).length,
    bonferroniPass: bonf.filter(Boolean).length,
    validated,
    verdict: validated > 0 ? 'EDGE-FOUND' : 'NO-VALIDATED-EDGE',
    cells: cellResults.sort((a, b) => b.excess - a.excess),
  };
}

// ── CLI (read-only fetch → report). Runs in-container: node dist/scripts/calibration-audit.js ──
/* c8 ignore start */
const EQUITY_AUDIT_SQL = `
WITH v AS (
  SELECT id, symbol, session_date, call, pfe_pct, confidence, regime, outcome_return_pct
  FROM equity_verdicts
  WHERE call IN ('BUY','SELL') AND outcome_filled_at IS NOT NULL AND engine_version=$1
)
SELECT v.call, v.pfe_pct::float8 AS pfe_pct, v.confidence::float8 AS confidence,
       v.outcome_return_pct::float8 AS outcome_return_pct, v.regime,
       e.close::float8 AS entry, w.hi::float8 AS win_high_max, w.lo::float8 AS win_low_min,
       CASE WHEN u.is_etf THEN 'etf' WHEN u.rank_adv BETWEEN 1 AND 50 THEN '1-50'
            WHEN u.rank_adv BETWEEN 51 AND 100 THEN '51-100'
            WHEN u.rank_adv BETWEEN 101 AND 500 THEN '101-500' ELSE 'other' END AS bucket
FROM v
JOIN equity_bars_daily e ON e.symbol=v.symbol AND e.session_date=v.session_date
LEFT JOIN equity_universe u ON u.symbol=v.symbol
JOIN LATERAL (
  SELECT max(high) AS hi, min(low) AS lo, count(*) AS n
  FROM (SELECT high, low FROM equity_bars_daily b
        WHERE b.symbol=v.symbol AND b.session_date > v.session_date
        ORDER BY b.session_date ASC LIMIT 5) win
) w ON true
WHERE w.n = 5;`;

async function fetchEquityRows(engineVersion: string): Promise<AuditRow[]> {
  const { dbQuery } = await import('../lib/performance-db.js');
  const raw = await dbQuery<{
    call: 'BUY' | 'SELL';
    pfe_pct: number;
    confidence: number;
    outcome_return_pct: number;
    regime: string | null;
    entry: number;
    win_high_max: number;
    win_low_min: number;
    bucket: string | null;
  }>(EQUITY_AUDIT_SQL, [engineVersion]);
  return raw.map((r) => ({
    call: r.call,
    pfePct: r.pfe_pct,
    confidence: r.confidence,
    entry: r.entry,
    winHighMax: r.win_high_max,
    winLowMin: r.win_low_min,
    outcomeReturnPct: r.outcome_return_pct,
    regime: r.regime,
    bucket: r.bucket,
  }));
}

// Crypto `signals` loader — benchmarks reconstruct from stored (pfe,mae); no
// kline re-fetch. Optional per-(timeframe,tier) filter for cell-level audits.
const CRYPTO_AUDIT_SQL = `
SELECT signal, coin, regime,
       confidence::float8 AS confidence,
       pfe_return_pct::float8 AS pfe_return_pct,
       mae_return_pct::float8 AS mae_return_pct,
       outcome_return_pct::float8 AS outcome_return_pct
FROM signals
WHERE signal IN ('BUY','SELL')
  AND pfe_return_pct IS NOT NULL AND mae_return_pct IS NOT NULL AND outcome_return_pct IS NOT NULL
  AND ($1::text IS NULL OR timeframe = $1)
  AND ($2::text IS NULL OR (CASE WHEN coin IN ('BTC','ETH') THEN 'T1_bluechip' ELSE 'rest' END) = $2)`;

export async function loadCryptoAuditInput(
  opts: { timeframe?: string; tier?: string } = {},
): Promise<AuditRow[]> {
  const { dbQuery } = await import('../lib/performance-db.js');
  const raw = await dbQuery<CryptoSignalRow>(CRYPTO_AUDIT_SQL, [
    opts.timeframe ?? null,
    opts.tier ?? null,
  ]);
  return raw.map(cryptoRowToAudit);
}

const CRYPTO_TFS = ['3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d'];

// Edge-metric cell loader: per (timeframe × tier × confidence-bin × regime),
// realized directional hits + up-count (for the always-long/short benchmark),
// split into 60% train / 40% holdout by created_at. Read-only.
const CRYPTO_EDGE_SQL = `
WITH base AS (
  SELECT timeframe,
    CASE WHEN coin IN ('BTC','ETH') THEN 'T1' ELSE 'rest' END AS tier,
    CASE WHEN confidence<60 THEN 'c52_59' WHEN confidence<75 THEN 'c60_74' ELSE 'c75_100' END AS conf_bin,
    coalesce(regime,'none') AS regime, signal, outcome_return_pct AS orp, created_at
  FROM signals
  WHERE signal IN ('BUY','SELL') AND pfe_return_pct IS NOT NULL AND outcome_return_pct IS NOT NULL
    AND timeframe IN ('3m','5m','15m','30m','1h','2h','4h','8h','12h','1d')
),
bnd AS (SELECT percentile_cont(0.6) WITHIN GROUP (ORDER BY created_at) AS cut FROM base),
x AS (
  SELECT timeframe, tier, conf_bin, regime,
    ((signal='BUY' AND orp>0) OR (signal='SELL' AND orp<0))::int AS hit,
    (orp>0)::int AS up,
    CASE WHEN created_at < (SELECT cut FROM bnd) THEN 'train' ELSE 'holdout' END AS split
  FROM base
)
SELECT timeframe||'|'||tier||'|'||conf_bin||'|'||regime AS key,
  count(*)::int AS full_n, sum(hit)::int AS full_hits, sum(up)::int AS full_up,
  count(*) FILTER (WHERE split='train')::int AS tr_n, coalesce(sum(hit) FILTER (WHERE split='train'),0)::int AS tr_hits, coalesce(sum(up) FILTER (WHERE split='train'),0)::int AS tr_up,
  count(*) FILTER (WHERE split='holdout')::int AS ho_n, coalesce(sum(hit) FILTER (WHERE split='holdout'),0)::int AS ho_hits, coalesce(sum(up) FILTER (WHERE split='holdout'),0)::int AS ho_up
FROM x GROUP BY timeframe, tier, conf_bin, regime`;

export async function loadCryptoEdgeCells(): Promise<EdgeCell[]> {
  const { dbQuery } = await import('../lib/performance-db.js');
  const raw = await dbQuery<{
    key: string;
    full_n: number; full_hits: number; full_up: number;
    tr_n: number; tr_hits: number; tr_up: number;
    ho_n: number; ho_hits: number; ho_up: number;
  }>(CRYPTO_EDGE_SQL);
  return raw.map((r) => ({
    key: r.key,
    full: { n: r.full_n, engineHits: r.full_hits, upCount: r.full_up },
    train: { n: r.tr_n, engineHits: r.tr_hits, upCount: r.tr_up },
    holdout: { n: r.ho_n, engineHits: r.ho_hits, upCount: r.ho_up },
  }));
}

async function main(): Promise<void> {
  const argAfter = (flag: string): string | undefined =>
    process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : undefined;
  const asset = argAfter('--asset') ?? 'equities';

  if (asset === 'equities') {
    const rows = await fetchEquityRows('equities-v1');
    console.log(JSON.stringify(computeAuditReport(rows, asset), null, 2));
    return;
  }
  if (asset === 'crypto') {
    if (process.argv.includes('--edge')) {
      const report = edgeMetricReport(await loadCryptoEdgeCells(), { q: 0.05, minN: 30 });
      const top = report.cells.slice(0, 15).map((c) => ({
        key: c.key, n: c.n, realizedHit: +c.realizedHit.toFixed(4), naive: +c.naive.toFixed(4),
        excess: +c.excess.toFixed(4), z: +c.z.toFixed(2), fdr: c.fdrReject, bonf: c.bonferroni,
        holdoutN: c.holdoutN, holdoutExcess: +c.holdoutExcess.toFixed(4), validated: c.validated,
      }));
      console.log(JSON.stringify({
        verdict: report.verdict, familySize: report.familySize, q: report.q, minN: report.minN,
        rawPass: report.rawPass, fdrPass: report.fdrPass, bonferroniPass: report.bonferroniPass,
        validated: report.validated, topByExcess: top,
      }, null, 2));
      return;
    }
    const tf = argAfter('--timeframe');
    if (tf) {
      const rows = await loadCryptoAuditInput({ timeframe: tf });
      console.log(JSON.stringify(computeAuditReport(rows, `crypto:${tf}`), null, 2));
      return;
    }
    // Default: aggregate + a compact per-timeframe edge table (the crux).
    const agg = computeAuditReport(await loadCryptoAuditInput({}), 'crypto:aggregate');
    const cells = [];
    for (const t of CRYPTO_TFS) {
      const rep = computeAuditReport(await loadCryptoAuditInput({ timeframe: t }), `crypto:${t}`);
      cells.push({
        tf: t,
        n: rep.n,
        actualWr: +rep.edge.actualWr.toFixed(4),
        bestBenchmark: +rep.edge.bestBenchmark.toFixed(4),
        pfeEdge: +rep.edge.edge.toFixed(4),
        realizedHit: +rep.realized.actual.toFixed(4),
        realizedEdge: +rep.realized.edge.toFixed(4),
        verdict: rep.verdict,
      });
    }
    console.log(JSON.stringify({ aggregate: { n: agg.n, actualWr: +agg.edge.actualWr.toFixed(4), pfeEdge: +agg.edge.edge.toFixed(4), realizedHit: +agg.realized.actual.toFixed(4), ece: +agg.calibration.ece.toFixed(4), verdict: agg.verdict }, byTimeframe: cells }, null, 2));
    return;
  }
  console.error(`[calibration-audit] asset '${asset}' not wired (equities | crypto).`);
  process.exit(2);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(`[calibration-audit] FATAL ${e?.message ?? e}`);
      process.exit(1);
    });
}
/* c8 ignore stop */
