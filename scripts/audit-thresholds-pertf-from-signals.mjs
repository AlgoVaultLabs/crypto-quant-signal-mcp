#!/usr/bin/env node
/**
 * audit-thresholds-pertf-from-signals.mjs
 *
 * OPS-TRADE-CALL-CALIBRATION-AUDIT-W1 — read-only postgres audit of `signals`
 * table for per-(timeframe × regime × signal-direction) calibration analysis.
 *
 * Emits JSON with PFE-WR as the PRIMARY metric. `outcome_return_pct`-based
 * stats appear ONLY under `_internal_audit_only` per CLAUDE.md
 * Data Integrity LAW ("Outcome WR is internal only").
 *
 * Designed for Path α execution (inside Hetzner container with DATABASE_URL
 * inherited from compose .env). Zero new npm deps beyond existing `pg`.
 *
 * CLI:
 *   node scripts/audit-thresholds-pertf-from-signals.mjs --window-days=90 --out=/tmp/audit-signals.json
 *   node scripts/audit-thresholds-pertf-from-signals.mjs --dry-run   # prints SQL only
 */
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';

const { Pool } = pg;

const SAMPLE_TOO_SMALL_THRESHOLD = 30;
const CONFIDENCE_BUCKETS = [
  { name: '40-44', min: 40, max: 44 },
  { name: '45-49', min: 45, max: 49 },
  { name: '50-54', min: 50, max: 54 },
  { name: '55-59', min: 55, max: 59 },
  { name: '60-69', min: 60, max: 69 },
  { name: '70-79', min: 70, max: 79 },
  { name: '80-89', min: 80, max: 89 },
  { name: '90-100', min: 90, max: 100 },
];

function parseArgs(argv = process.argv.slice(2)) {
  const out = { windowDays: 90, out: null, dryRun: false };
  for (const arg of argv) {
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg.startsWith('--window-days=')) out.windowDays = parseInt(arg.split('=')[1], 10);
    else if (arg.startsWith('--out=')) out.out = arg.split('=')[1];
  }
  if (!Number.isFinite(out.windowDays) || out.windowDays < 1) {
    throw new Error(`--window-days must be a positive integer (got: ${out.windowDays})`);
  }
  return out;
}

function buildAggregateSQL(windowDays) {
  return `
    SELECT
      timeframe,
      exchange,
      signal,
      regime,
      COUNT(*) AS n,
      COUNT(pfe_return_pct) AS n_with_pfe,
      AVG(confidence)::float AS avg_confidence,
      SUM(CASE WHEN signal = 'BUY' AND pfe_return_pct > 0 THEN 1
                WHEN signal = 'SELL' AND pfe_return_pct < 0 THEN 1
                ELSE 0 END)::int AS n_pfe_win,
      AVG(pfe_return_pct)::float AS avg_pfe,
      -- outcome_return_pct used ONLY in _internal_audit_only sub-object
      COUNT(outcome_return_pct) AS n_with_outcome_internal,
      SUM(CASE WHEN signal = 'BUY' AND outcome_return_pct > 0 THEN 1
                WHEN signal = 'SELL' AND outcome_return_pct < 0 THEN 1
                ELSE 0 END)::int AS n_outcome_win_internal,
      AVG(outcome_return_pct)::float AS avg_outcome_internal
    FROM signals
    WHERE created_at >= EXTRACT(EPOCH FROM NOW() - INTERVAL '${windowDays} days')
    GROUP BY timeframe, exchange, signal, regime
    ORDER BY timeframe, exchange, signal, regime;
  `;
}

function buildConfidenceHistogramSQL(windowDays) {
  return `
    SELECT
      timeframe,
      signal,
      CASE
        WHEN confidence BETWEEN 40 AND 44 THEN '40-44'
        WHEN confidence BETWEEN 45 AND 49 THEN '45-49'
        WHEN confidence BETWEEN 50 AND 54 THEN '50-54'
        WHEN confidence BETWEEN 55 AND 59 THEN '55-59'
        WHEN confidence BETWEEN 60 AND 69 THEN '60-69'
        WHEN confidence BETWEEN 70 AND 79 THEN '70-79'
        WHEN confidence BETWEEN 80 AND 89 THEN '80-89'
        WHEN confidence BETWEEN 90 AND 100 THEN '90-100'
        ELSE 'OUT_OF_RANGE'
      END AS bucket,
      COUNT(*) AS n,
      AVG(pfe_return_pct)::float AS avg_pfe,
      SUM(CASE WHEN signal = 'BUY' AND pfe_return_pct > 0 THEN 1
                WHEN signal = 'SELL' AND pfe_return_pct < 0 THEN 1
                ELSE 0 END)::int AS n_pfe_win
    FROM signals
    WHERE created_at >= EXTRACT(EPOCH FROM NOW() - INTERVAL '${windowDays} days')
      AND confidence IS NOT NULL
    GROUP BY timeframe, signal, bucket
    ORDER BY timeframe, signal, bucket;
  `;
}

function buildPerCoinDensitySQL(windowDays) {
  return `
    SELECT
      timeframe,
      coin,
      signal,
      COUNT(*) AS n
    FROM signals
    WHERE created_at >= EXTRACT(EPOCH FROM NOW() - INTERVAL '${windowDays} days')
    GROUP BY timeframe, coin, signal
    HAVING COUNT(*) >= 1
    ORDER BY timeframe, n DESC;
  `;
}

function shapeAggregateRow(row) {
  const n = Number(row.n);
  const n_with_pfe = Number(row.n_with_pfe);
  const n_pfe_win = Number(row.n_pfe_win);
  const pfe_wr = n_with_pfe > 0 ? n_pfe_win / n_with_pfe : null;
  const sample_too_small = n_with_pfe < SAMPLE_TOO_SMALL_THRESHOLD;

  return {
    timeframe: row.timeframe,
    exchange: row.exchange,
    signal: row.signal,
    regime: row.regime,
    n,
    n_with_pfe,
    avg_confidence: row.avg_confidence,
    pfe_wr,
    n_pfe_win,
    avg_pfe: row.avg_pfe,
    sample_too_small,
    sample_too_small_note: sample_too_small
      ? `SAMPLE_TOO_SMALL — recommendation deferred to longer window (n_with_pfe=${n_with_pfe} < ${SAMPLE_TOO_SMALL_THRESHOLD})`
      : null,
    _internal_audit_only: {
      n_with_outcome: Number(row.n_with_outcome_internal),
      n_outcome_win: Number(row.n_outcome_win_internal),
      outcome_wr:
        Number(row.n_with_outcome_internal) > 0
          ? Number(row.n_outcome_win_internal) / Number(row.n_with_outcome_internal)
          : null,
      avg_outcome: row.avg_outcome_internal,
      _label: 'internal-audit-only — do not surface to any public response',
    },
  };
}

async function main() {
  const args = parseArgs();
  const sqls = {
    aggregate: buildAggregateSQL(args.windowDays),
    confidence_histogram: buildConfidenceHistogramSQL(args.windowDays),
    per_coin_density: buildPerCoinDensitySQL(args.windowDays),
  };

  if (args.dryRun) {
    console.log('--- DRY-RUN SQL ---');
    for (const [name, sql] of Object.entries(sqls)) {
      console.log(`\n-- ${name} --\n${sql.trim()}`);
    }
    return;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL env var is required (Path α: inherits from Hetzner compose .env)');
  }
  const pool = new Pool({ connectionString });

  try {
    const startedAt = new Date().toISOString();
    const [aggR, histR, coinR] = await Promise.all([
      pool.query(sqls.aggregate),
      pool.query(sqls.confidence_histogram),
      pool.query(sqls.per_coin_density),
    ]);

    const aggregates = aggR.rows.map(shapeAggregateRow);
    const histograms = histR.rows.map((r) => ({
      timeframe: r.timeframe,
      signal: r.signal,
      bucket: r.bucket,
      n: Number(r.n),
      avg_pfe: r.avg_pfe,
      n_pfe_win: Number(r.n_pfe_win),
      pfe_wr: Number(r.n) > 0 ? Number(r.n_pfe_win) / Number(r.n) : null,
    }));
    const perCoin = coinR.rows.map((r) => ({
      timeframe: r.timeframe,
      coin: r.coin,
      signal: r.signal,
      n: Number(r.n),
    }));

    const sample_too_small_buckets = aggregates.filter((a) => a.sample_too_small);

    const result = {
      generated_at: startedAt,
      window_days: args.windowDays,
      wave_id: 'OPS-TRADE-CALL-CALIBRATION-AUDIT-W1',
      schema_version: 1,
      from_signals: {
        per_tf_exchange_signal_regime_aggregates: aggregates,
        confidence_histogram_per_tf_signal: histograms,
        per_coin_density: perCoin,
        sample_too_small_count: sample_too_small_buckets.length,
        sample_too_small_buckets: sample_too_small_buckets.map((b) => ({
          timeframe: b.timeframe,
          exchange: b.exchange,
          signal: b.signal,
          regime: b.regime,
          n_with_pfe: b.n_with_pfe,
        })),
      },
      _data_integrity_law: {
        primary_metric: 'pfe_wr',
        outcome_wr_visibility: 'INTERNAL-AUDIT-ONLY (nested under _internal_audit_only per CLAUDE.md Data Integrity LAW)',
        note: 'PFE-WR is the public-surface metric. outcome_return_pct stats live in _internal_audit_only sub-objects and MUST NOT surface to any public response.',
      },
    };

    const outPath = args.out;
    if (outPath) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
      console.log(`OK_WROTE ${outPath} (${aggregates.length} aggregate rows, ${histograms.length} histogram rows, ${perCoin.length} per-coin rows, ${sample_too_small_buckets.length} SAMPLE_TOO_SMALL buckets)`);
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`FATAL: ${err.stack || err.message}`);
  process.exit(1);
});
