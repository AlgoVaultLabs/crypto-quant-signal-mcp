/**
 * tool-readiness-report.ts — EQUITY-READINESS-REPORT-W1.
 *
 * A recurring, screenshot-style "Tool Promotion Readiness" card for launch-gated
 * MCP tools whose asset class is NOT a venue — so the venue-scoped
 * `venue-readiness-report.ts` (keyed by exchange_id) never covers them. This
 * card RIDES the SAME daily operator digest (venue-readiness-report `main()` →
 * `sendDigest`, exactly ONE Telegram) — it is NOT a new cron, alert channel, or
 * `send_telegram.sh` consumer. Complies with the no-TG-on-completion LAW + the
 * operator-alert contract.
 *
 * FIRST consumer: the equity engine — `get_equity_call` (directional, PFE-gated)
 * + `get_equity_regime` (classifier, no PFE gate). Factored asset-class-
 * parameterised (`renderToolReadiness`) so future launch gates (options /
 * futures / intraday Phase-2) reuse the same card with no new pattern.
 *
 * SINGLE-DERIVATION: the equity numbers are lifted VERBATIM from the launch
 * latch `/opt/algovault-monitoring/equity-launch-readiness.sh`
 * (EQUITY-LAUNCH-READINESS-W1) — the SAME matured predicate
 * (`outcome_filled_at IS NOT NULL`), the SAME PFE-WR math
 * (BUY∧pfe_pct>0 ∨ SELL∧pfe_pct<0), the SAME `equity_pfe_by_rank_bucket` view,
 * and the SAME gate constants (n≥150 ∧ s≥3). This card and the latch project
 * from ONE source — no independent re-derivation of column names or thresholds.
 *
 * INTERNAL / ops-only (a cron digest, never an MCP/HTTP response path). PFE WR
 * only per the Data Integrity LAW — `outcome_return_pct` is never selected.
 */

// ── Gate constants ───────────────────────────────────────────────────────────
// MUST stay byte-identical to N_THRESHOLD / S_THRESHOLD at the top of
// /opt/algovault-monitoring/equity-launch-readiness.sh (single-derivation).
// FUNNEL-FIX-AGENT-X402-NUDGE-W1: the public-copy HOLD flag is now the ONE SoT in
// lib/equities/equity-hold.ts (import-safe for runtime consumers like the agent x402 nudge).
import { EQUITY_PUBLIC_COPY_HOLD } from '../lib/equities/equity-hold.js';

export const EQUITY_N_THRESHOLD = 150; // min matured BUY/SELL PFE outcomes before the calibration sample is signal, not noise
export const EQUITY_S_THRESHOLD = 3; // min distinct matured sessions — guards against a single-session fluke

// Public-copy HOLD (Mr.1 2026-06-04, reaffirmed 2026-06-08): equities stay INTERNAL for all
// release/public copy until Mr.1 flips it AFTER EQUITY-CALIBRATION-AUDIT-W1. While true, the
// card appends the HOLD marker. SoT relocated to lib/equities/equity-hold.ts; re-exported here
// so this module's importers are byte-unchanged.
export { EQUITY_PUBLIC_COPY_HOLD };

// Canonical rank-bucket display order (the view groups into these; 'other' only
// appears if a verdict exists for a symbol outside the ranked/ETF universe).
const DISPLAY_BUCKET_ORDER = ['1-50', '51-100', '101-500', 'etf', 'other'];

// ── Types ────────────────────────────────────────────────────────────────────
export interface BucketWr {
  bucket: string;
  wr: number | null; // [0..1]
  matured: number;
}

/** A directional (PFE-win-rate-gated) tool, e.g. get_equity_call. */
export interface DirectionalToolStats {
  tool: string;
  n: number; // matured BUY/SELL outcomes
  s: number; // distinct matured sessions
  wr: number | null; // overall PFE win-rate [0..1]; null when n==0
  buckets: BucketWr[]; // per-rank-bucket PFE WR
  miss7d: number; // out-of-universe requests, last 7 days
  nTarget: number;
  sTarget: number;
}

/** A classifier tool with no directional PFE gate, e.g. get_equity_regime. */
export interface ClassifierToolStats {
  tool: string;
  sessions: number; // distinct sessions with verdicts
  lastSession: string | null; // YYYY-MM-DD
  coveragePct: number | null; // latest-session symbol coverage of the active universe
  latestSymbols: number;
  universeActive: number;
}

export interface ToolReadinessInput {
  assetClassLabel: string; // "Equities"
  nextStep: string; // "EQUITY-CALIBRATION-AUDIT-W1 → Mr.1 public-copy flip"
  holdInForce: boolean; // append the "HOLD — pending Mr.1 flip" marker
  directional: DirectionalToolStats;
  classifier?: ClassifierToolStats;
}

// ── Pure rendering (no DB, no Date.now — exported for tests) ─────────────────
const pct1 = (x: number) => `${x.toFixed(1)}%`;
const wrPct = (wr: number | null) => (wr === null ? 'n/a' : pct1(wr * 100));

/**
 * Directional readiness status. The gate (n≥target ∧ s≥target) triggers a
 * calibration AUDIT — it does NOT auto-promote and there is NO 0.80-WR auto-gate
 * here (that bar is venue-only). READY-FOR-AUDIT ⇔ the launch latch has fired.
 */
export function directionalStatus(
  n: number,
  s: number,
  nTarget: number,
  sTarget: number,
): { glyph: string; label: string } {
  return n >= nTarget && s >= sTarget
    ? { glyph: '✅', label: 'READY-FOR-AUDIT' }
    : { glyph: '⏳', label: 'ACCUMULATING' };
}

/**
 * PURE — renders ONE digest section string in the same visual grammar as the
 * venue readiness block. Exported for tests; takes pre-computed stats so it is
 * DB- and clock-free.
 */
export function renderToolReadiness(input: ToolReadinessInput): string {
  const { assetClassLabel, nextStep, holdInForce, directional: d, classifier: c } = input;
  const lines: string[] = [];

  lines.push(`🛠 *Tool Promotion Readiness — ${assetClassLabel}*`);
  lines.push(`Next: ${nextStep}`);

  // Directional tool (PFE-WR-gated).
  const { glyph, label } = directionalStatus(d.n, d.s, d.nTarget, d.sTarget);
  const samplePct = d.nTarget > 0 ? Math.round((100 * d.n) / d.nTarget) : 0;
  const sessPct = d.sTarget > 0 ? Math.round((100 * d.s) / d.sTarget) : 0;
  const hold = holdInForce ? '  🔒 HOLD — pending Mr.1 flip' : '';
  lines.push(
    `${glyph} ${d.tool} — ${label} · sample ${d.n}/${d.nTarget} (${samplePct}%), sessions ${d.s}/${d.sTarget} (${sessPct}%), PFE WR ${wrPct(d.wr)}${hold}`,
  );
  const bucketStr = d.buckets.length
    ? d.buckets.map((b) => `${b.bucket} ${wrPct(b.wr)}(${b.matured})`).join(' · ')
    : 'n/a';
  lines.push(`   • buckets: ${bucketStr} · out-of-universe(7d) ${d.miss7d}`);
  lines.push(
    `   • gate → calibration AUDIT (not auto-promote); the venue 0.80 WR bar is not an auto-gate here`,
  );

  // Classifier tool (no PFE gate).
  if (c) {
    const cov = c.coveragePct === null ? 'n/a' : pct1(c.coveragePct);
    lines.push(
      `🧭 ${c.tool} — classifier · no PFE gate · ${c.sessions} sessions, last ${c.lastSession ?? 'n/a'}, regime coverage ${cov} (${c.latestSymbols}/${c.universeActive} universe)`,
    );
  }

  return lines.join('\n');
}

// ── DB loader (equity first consumer) ────────────────────────────────────────
type QueryFn = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;

// SQL lifted VERBATIM from equity-launch-readiness.sh (single-derivation SoT).
// Matured BUY/SELL n, distinct matured sessions s, PFE wins, 7d out-of-universe.
const EQUITY_READINESS_SQL = `
SELECT
  count(*) FILTER (WHERE outcome_filled_at IS NOT NULL) AS n,
  count(DISTINCT session_date) FILTER (WHERE outcome_filled_at IS NOT NULL) AS s,
  count(*) FILTER (WHERE outcome_filled_at IS NOT NULL AND ((call='BUY' AND pfe_pct>0) OR (call='SELL' AND pfe_pct<0))) AS wins,
  (SELECT count(*) FROM equity_symbol_misses WHERE requested_at > now() - interval '7 days') AS miss7d
FROM equity_verdicts WHERE call IN ('BUY','SELL');`;

// Per-rank-bucket PFE WR — reads the SAME view the latch reads.
const EQUITY_BUCKETS_SQL = `SELECT bucket, matured_calls, pfe_win_rate FROM equity_pfe_by_rank_bucket;`;

// Classifier readiness for get_equity_regime — recency + latest-session universe
// coverage. No PFE / directional math (a regime classifier has no win-rate).
const EQUITY_REGIME_SQL = `
SELECT
  (SELECT count(DISTINCT session_date) FROM equity_verdicts) AS sessions,
  (SELECT max(session_date)::text FROM equity_verdicts) AS last_session,
  (SELECT count(DISTINCT symbol) FROM equity_verdicts WHERE session_date = (SELECT max(session_date) FROM equity_verdicts)) AS latest_symbols,
  (SELECT count(*) FROM equity_universe WHERE active) AS universe_active;`;

/**
 * Fetches the equity readiness numbers and shapes the render input. INTERNAL —
 * PFE WR only; `outcome_return_pct` is never referenced. Callers pass the app DB
 * `dbQuery` (the digest runs inside the mcp-server container against
 * `signal_performance`).
 */
export async function loadEquityReadinessInput(query: QueryFn): Promise<ToolReadinessInput> {
  const [agg] = await query<{ n: string; s: string; wins: string; miss7d: string }>(
    EQUITY_READINESS_SQL,
  );
  const bucketsRaw = await query<{
    bucket: string;
    matured_calls: string;
    pfe_win_rate: string | null;
  }>(EQUITY_BUCKETS_SQL);
  const [regime] = await query<{
    sessions: string;
    last_session: string | null;
    latest_symbols: string;
    universe_active: string;
  }>(EQUITY_REGIME_SQL);

  const n = Number(agg?.n ?? 0);
  const s = Number(agg?.s ?? 0);
  const wins = Number(agg?.wins ?? 0);
  const miss7d = Number(agg?.miss7d ?? 0);
  const wr = n > 0 ? wins / n : null;

  const byBucket = new Map(bucketsRaw.map((b) => [b.bucket, b]));
  const buckets: BucketWr[] = DISPLAY_BUCKET_ORDER.filter((name) => byBucket.has(name)).map(
    (name) => {
      const r = byBucket.get(name)!;
      return {
        bucket: name,
        wr: r.pfe_win_rate === null ? null : Number(r.pfe_win_rate),
        matured: Number(r.matured_calls),
      };
    },
  );

  const universeActive = Number(regime?.universe_active ?? 0);
  const latestSymbols = Number(regime?.latest_symbols ?? 0);
  const coveragePct = universeActive > 0 ? (100 * latestSymbols) / universeActive : null;

  return {
    assetClassLabel: 'Equities',
    nextStep: 'EQUITY-CALIBRATION-AUDIT-W1 → Mr.1 public-copy flip',
    holdInForce: EQUITY_PUBLIC_COPY_HOLD,
    directional: {
      tool: 'get_equity_call',
      n,
      s,
      wr,
      buckets,
      miss7d,
      nTarget: EQUITY_N_THRESHOLD,
      sTarget: EQUITY_S_THRESHOLD,
    },
    classifier: {
      tool: 'get_equity_regime',
      sessions: Number(regime?.sessions ?? 0),
      lastSession: regime?.last_session ? String(regime.last_session).slice(0, 10) : null,
      coveragePct,
      latestSymbols,
      universeActive,
    },
  };
}
