#!/usr/bin/env node
/**
 * audit-thresholds-pertf-from-hold-counts.mjs
 *
 * OPS-TRADE-CALL-CALIBRATION-AUDIT-W1 — read-only postgres audit of
 * `hold_counts` table for per-(timeframe × coin) HOLD-emission counts.
 * Combined with `from_signals` data, the synthesizer computes per-TF
 * fire-rate ratio = signals_count / (signals_count + holds_count).
 *
 * Per Plan-Mode R0(c) finding: hold_counts effective window varies by TF:
 *  - 1m + 3m: 28 days (started 2026-04-30)
 *  - other 9 TFs: 47 days (started 2026-04-11)
 * Documented in output as `effective_window_days` per TF.
 *
 * Designed for Path α execution. Zero new npm deps beyond existing `pg`.
 *
 * CLI:
 *   node scripts/audit-thresholds-pertf-from-hold-counts.mjs --window-days=90 --out=/tmp/audit-hold-counts.json
 *   node scripts/audit-thresholds-pertf-from-hold-counts.mjs --dry-run
 */
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';

const { Pool } = pg;

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

function buildPerTfSQL(windowDays) {
  return `
    SELECT
      timeframe,
      COUNT(DISTINCT coin) AS n_coins,
      SUM(hold_count)::bigint AS total_holds,
      MIN(date) AS first_date,
      MAX(date) AS last_date,
      MAX(date) - MIN(date) + 1 AS effective_window_days
    FROM hold_counts
    WHERE date >= CURRENT_DATE - INTERVAL '${windowDays} days'
    GROUP BY timeframe
    ORDER BY timeframe;
  `;
}

function buildPerTfCoinSQL(windowDays) {
  return `
    SELECT
      timeframe,
      coin,
      SUM(hold_count)::bigint AS holds,
      MIN(date) AS first_date,
      MAX(date) AS last_date
    FROM hold_counts
    WHERE date >= CURRENT_DATE - INTERVAL '${windowDays} days'
    GROUP BY timeframe, coin
    ORDER BY timeframe, holds DESC;
  `;
}

async function main() {
  const args = parseArgs();
  const sqls = {
    per_tf: buildPerTfSQL(args.windowDays),
    per_tf_coin: buildPerTfCoinSQL(args.windowDays),
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
    const [tfR, coinR] = await Promise.all([
      pool.query(sqls.per_tf),
      pool.query(sqls.per_tf_coin),
    ]);

    const per_tf = tfR.rows.map((r) => ({
      timeframe: r.timeframe,
      n_coins: Number(r.n_coins),
      total_holds: Number(r.total_holds),
      first_date: r.first_date,
      last_date: r.last_date,
      effective_window_days: Number(r.effective_window_days),
      window_truncated:
        Number(r.effective_window_days) < args.windowDays
          ? `EFFECTIVE_WINDOW_TRUNCATED — only ${r.effective_window_days}d of data in this ${args.windowDays}d query (first row dated ${r.first_date})`
          : null,
    }));
    const per_tf_coin = coinR.rows.map((r) => ({
      timeframe: r.timeframe,
      coin: r.coin,
      holds: Number(r.holds),
      first_date: r.first_date,
      last_date: r.last_date,
    }));

    const result = {
      generated_at: startedAt,
      window_days: args.windowDays,
      wave_id: 'OPS-TRADE-CALL-CALIBRATION-AUDIT-W1',
      schema_version: 1,
      from_hold_counts: {
        per_tf,
        per_tf_coin,
      },
    };

    const outPath = args.out;
    if (outPath) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
      console.log(`OK_WROTE ${outPath} (${per_tf.length} per_tf rows, ${per_tf_coin.length} per_tf_coin rows)`);
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
