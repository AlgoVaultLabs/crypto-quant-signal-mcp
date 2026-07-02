#!/usr/bin/env tsx
/**
 * backfill-directional-labels.ts — EDGE-DWR-METRIC-SOT-W1 (R3/R4)
 *
 * Backfills the durable `directional_labels` dataset: a symmetric triple-barrier label
 * for every historical crypto BUY/SELL signal, across all three barrier specs (τ = 1.0
 * primary; 0.5 / 2.0 sensitivity). INTERNAL-ONLY dataset (same class as outcome_return_pct).
 *
 * Machinery reused from backfill-outcomes.ts (OPS-ADAPTER-RATELIMIT-UNIFY-W1): the shared
 * rate-limited transport (getAdapter + runAsBatch/runAsCaller/WeightBudgetSkipError, 418/429
 * never retried) and the getDexForCoin HL routing. The pure label math lives in
 * ./directional-labeler.ts (unit-tested). NEVER raw fetch.
 *
 * Batches by (exchange, coin, timeframe): a group-level candle cache is filled incrementally
 * (contiguous when signals are dense, island fetches across gaps) so a kline range is fetched
 * ~once, never per-signal. Idempotent + resumable via DB state: a (signal_id, barrier_spec)
 * that already exists is skipped, so a re-run — or `--check` — writes nothing.
 *
 * Q4 (architect): mfe/mae are REUSED from signals.pfe_return_pct / mae_return_pct (identical
 * eval window); the kline-derived excursions are recomputed only for a non-fatal sanity WARN.
 *
 *   node dist/scripts/backfill-directional-labels.js                 (all specs, all groups)
 *   node dist/scripts/backfill-directional-labels.js --check         (audit only, zero writes)
 *   node dist/scripts/backfill-directional-labels.js --barrier-spec tau1.0-floor0.30-v1
 *   node dist/scripts/backfill-directional-labels.js --venue BINANCE --coin BTC --limit-groups 20
 */

import { dbQuery, dbExec, closeDb } from '../lib/performance-db.js';
import { getAdapter } from '../lib/exchange-adapter.js';
import { getDexForCoin } from '../lib/asset-tiers.js';
import { runAsBatch, runAsCaller, WeightBudgetSkipError } from '../lib/upstream-weight-budget.js';
import type { Candle, ExchangeId } from '../types.js';
import {
  EVAL_CANDLES,
  TF_MS,
  SIGMA_TARGET_WINDOWS,
  computeSigmaW,
  barrierPct,
  runTripleBarrier,
} from './directional-labeler.js';

const DELAY_BETWEEN_FETCHES_MS = 250;
const FETCH_BUFFER_CANDLES = 2; // pad each fetched range slightly
const MAX_PAGES_PER_RANGE = 500; // runaway guard for one paginated range
const INSERT_CHUNK_ROWS = 1000; // stay well under the PG bind-param ceiling (9 params/row)

const ALL_SPECS = [
  { tau: 1.0, spec: 'tau1.0-floor0.30-v1' },
  { tau: 0.5, spec: 'tau0.5-floor0.30-v1' },
  { tau: 2.0, spec: 'tau2.0-floor0.30-v1' },
] as const;

interface Cli {
  check: boolean;
  specs: { tau: number; spec: string }[];
  venue?: string;
  coin?: string;
  limitGroups?: number;
}

interface SignalRow {
  id: number;
  created_at: number; // unix seconds
  price_at_signal: number;
  signal: 'BUY' | 'SELL';
  pfe_return_pct: number | null;
  mae_return_pct: number | null;
}

interface Coverage {
  groups: number;
  groupsSkipped: number; // already fully labeled
  signalsSeen: number;
  labeled: number; // (signal,spec) rows written or already-present
  written: number; // rows actually inserted this run
  noKlines: number; // forward window unreachable (signal×spec)
  lowVolHistory: number; // labeled but flagged (excluded from cell stats)
  ambiguous: number; // same-candle -1 conservative
  timeouts: number; // label 0
  wins: number;
  losses: number;
  sanityWarn: number; // kline-derived vs stored mfe/mae gross mismatch
  budgetSkips: number; // groups deferred on WeightBudgetSkipError (retry on re-run)
  errors: number;
}

const cov: Coverage = {
  groups: 0, groupsSkipped: 0, signalsSeen: 0, labeled: 0, written: 0,
  noKlines: 0, lowVolHistory: 0, ambiguous: 0, timeouts: 0, wins: 0, losses: 0,
  sanityWarn: 0, budgetSkips: 0, errors: 0,
};
const noKlinesByVenue = new Map<string, number>();

function ts(): string {
  return new Date().toISOString();
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseCli(argv: string[]): Cli {
  const has = (f: string) => argv.includes(f);
  const val = (f: string): string | undefined => {
    const i = argv.indexOf(f);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const specSel = val('--barrier-spec');
  const specs = specSel ? ALL_SPECS.filter((s) => s.spec === specSel) : ALL_SPECS.slice();
  if (specSel && specs.length === 0) throw new Error(`unknown --barrier-spec '${specSel}'`);
  const lim = val('--limit-groups');
  return {
    check: has('--check'),
    specs,
    venue: val('--venue'),
    coin: val('--coin'),
    limitGroups: lim ? parseInt(lim, 10) : undefined,
  };
}

/** Ensure the internal table + index exist (idempotent; migrations/019 is the SoT). */
function ensureTable(): void {
  dbExec(`
    CREATE TABLE IF NOT EXISTS directional_labels (
      signal_id        INTEGER NOT NULL,
      barrier_spec     TEXT NOT NULL,
      label            SMALLINT NOT NULL,
      ambiguous_candle BOOLEAN NOT NULL DEFAULT FALSE,
      low_vol_history  BOOLEAN NOT NULL DEFAULT FALSE,
      t_hit_candles    INT,
      mfe_return_pct   DOUBLE PRECISION,
      mae_return_pct   DOUBLE PRECISION,
      barrier_pct      DOUBLE PRECISION NOT NULL,
      computed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (signal_id, barrier_spec)
    );
    CREATE INDEX IF NOT EXISTS idx_dirlabels_spec_signal ON directional_labels (barrier_spec, signal_id);
  `);
}

async function loadGroups(cli: Cli): Promise<{ exchange: string; coin: string; timeframe: string }[]> {
  const where: string[] = [
    "signal IN ('BUY','SELL')",
    'pfe_return_pct IS NOT NULL',
    "timeframe <> '1m'", // retired lane (OPS-1M-SEED-DECOM-W1) — never labeled
  ];
  const params: unknown[] = [];
  if (cli.venue) { params.push(cli.venue); where.push(`exchange = $${params.length}`); }
  if (cli.coin) { params.push(cli.coin); where.push(`coin = $${params.length}`); }
  const rows = await dbQuery<{ exchange: string; coin: string; timeframe: string }>(
    `SELECT exchange, coin, timeframe FROM signals WHERE ${where.join(' AND ')}
     GROUP BY exchange, coin, timeframe ORDER BY exchange, coin, timeframe`,
    params,
  );
  return cli.limitGroups ? rows.slice(0, cli.limitGroups) : rows;
}

/** Paginated ranged fetch [startMs, endMs] via the shared transport; stops at venue horizon. */
async function fetchRangeInto(
  cache: Map<number, Candle>,
  exchangeId: ExchangeId,
  coin: string,
  timeframe: string,
  startMs: number,
  endMs: number,
): Promise<void> {
  const tfMs = TF_MS[timeframe];
  const adapter = getAdapter(exchangeId);
  const dex = exchangeId === 'HL' ? getDexForCoin(coin) : undefined;
  let cursor = startMs;
  let pages = 0;
  while (cursor <= endMs && pages < MAX_PAGES_PER_RANGE) {
    pages++;
    const page = await adapter.getCandles(coin, timeframe, cursor, dex, endMs);
    if (!page || page.length === 0) break;
    let maxTime = cursor;
    for (const c of page) {
      if (c.time >= startMs && c.time <= endMs) cache.set(c.time, c);
      if (c.time > maxTime) maxTime = c.time;
    }
    if (maxTime <= cursor) break; // no forward progress → venue horizon reached
    cursor = maxTime + tfMs;
    await sleep(DELAY_BETWEEN_FETCHES_MS);
  }
}

async function processGroup(cli: Cli, g: { exchange: string; coin: string; timeframe: string }): Promise<void> {
  const W = EVAL_CANDLES[g.timeframe];
  const tfMs = TF_MS[g.timeframe];
  if (!W || !tfMs) return; // unknown/retired timeframe — already filtered, defensive

  const sigs = await dbQuery<SignalRow>(
    `SELECT id, created_at, price_at_signal, signal, pfe_return_pct, mae_return_pct
     FROM signals
     WHERE exchange = $1 AND coin = $2 AND timeframe = $3
       AND signal IN ('BUY','SELL') AND pfe_return_pct IS NOT NULL
     ORDER BY created_at ASC`,
    [g.exchange, g.coin, g.timeframe],
  );
  if (sigs.length === 0) return;

  // Which (signal_id, spec) already exist → skip (idempotency + resume).
  const specNames = cli.specs.map((s) => s.spec);
  const ids = sigs.map((s) => s.id);
  const existing = await dbQuery<{ signal_id: number; barrier_spec: string }>(
    `SELECT signal_id, barrier_spec FROM directional_labels
     WHERE barrier_spec = ANY($1) AND signal_id = ANY($2)`,
    [specNames, ids],
  );
  const done = new Set(existing.map((e) => `${e.signal_id}|${e.barrier_spec}`));
  cov.labeled += existing.length;

  // Build the to-do list: signal × spec not yet present.
  const todo = sigs.filter((s) => cli.specs.some((sp) => !done.has(`${s.id}|${sp.spec}`)));
  cov.signalsSeen += sigs.length;
  if (todo.length === 0) {
    cov.groupsSkipped++;
    return;
  }
  if (cli.check) {
    // Report only: count what WOULD be written, touch nothing.
    for (const s of todo) for (const sp of cli.specs) if (!done.has(`${s.id}|${sp.spec}`)) cov.written++;
    return;
  }

  // Incremental group candle cache (dense → contiguous; sparse → islands).
  const cache = new Map<number, Candle>();
  let coveredUntil = -Infinity;
  const rows: unknown[][] = [];

  for (const s of todo) {
    const entryMs = s.created_at * 1000;
    const neededStart = entryMs - (SIGMA_TARGET_WINDOWS * W + FETCH_BUFFER_CANDLES) * tfMs;
    const neededEnd = entryMs + (W + FETCH_BUFFER_CANDLES) * tfMs;
    try {
      if (neededEnd > coveredUntil) {
        const start = coveredUntil + tfMs >= neededStart ? coveredUntil + tfMs : neededStart; // extend vs new island
        await fetchRangeInto(cache, g.exchange as ExchangeId, g.coin, g.timeframe, start, neededEnd);
        coveredUntil = Math.max(coveredUntil, neededEnd);
      }
    } catch (err) {
      if (err instanceof WeightBudgetSkipError) {
        cov.budgetSkips++;
        return; // defer whole group; re-run picks it up (labels absent)
      }
      cov.errors++;
      noKlinesByVenue.set(g.exchange, (noKlinesByVenue.get(g.exchange) || 0) + 1);
      continue;
    }

    const asc = [...cache.values()].sort((a, b) => a.time - b.time);
    const trailingCloses = asc.filter((c) => c.time < entryMs).map((c) => c.close);
    const forwardAsc = asc.filter((c) => c.time >= entryMs);

    const { sigma } = computeSigmaW(trailingCloses, W);
    const lowVol = sigma == null;

    // Forward reachability: need a resolved race OR full-window coverage to call a timeout.
    for (const sp of cli.specs) {
      if (done.has(`${s.id}|${sp.spec}`)) continue;
      const bpSpec = barrierPct(sigma, sp.tau);
      const race = runTripleBarrier(s.signal, s.price_at_signal, forwardAsc, bpSpec, W);
      const indeterminateTimeout = race.label === 0 && forwardAsc.length < W;
      if (forwardAsc.length === 0 || indeterminateTimeout) {
        cov.noKlines++;
        noKlinesByVenue.set(g.exchange, (noKlinesByVenue.get(g.exchange) || 0) + 1);
        continue;
      }
      // Q4: persist stored mfe/mae; kline-derived only for a non-fatal sanity check.
      const storedMfe = s.pfe_return_pct;
      const storedMae = s.mae_return_pct;
      if (storedMfe != null && Math.abs(race.mfeReturnPct - storedMfe) > 0.5 &&
          Math.abs(race.mfeReturnPct) > 2 * Math.abs(storedMfe) + 0.5) {
        cov.sanityWarn++;
        if (cov.sanityWarn <= 20) {
          console.warn(`[${ts()}] SANITY ${g.exchange}:${g.coin}:${g.timeframe} sig ${s.id} kline-mfe ${race.mfeReturnPct.toFixed(3)} vs stored ${storedMfe}`);
        }
      }
      rows.push([
        s.id, sp.spec, race.label, race.ambiguousCandle, lowVol,
        race.tHitCandles, storedMfe, storedMae, bpSpec,
      ]);
      cov.labeled++;
      if (lowVol) cov.lowVolHistory++;
      if (race.ambiguousCandle) cov.ambiguous++;
      if (race.label === 0) cov.timeouts++;
      else if (race.label === 1) cov.wins++;
      else cov.losses++;
    }
  }

  // Batch insert (idempotent).
  for (let i = 0; i < rows.length; i += INSERT_CHUNK_ROWS) {
    const chunk = rows.slice(i, i + INSERT_CHUNK_ROWS);
    const values: string[] = [];
    const params: unknown[] = [];
    chunk.forEach((r, j) => {
      const b = j * 9;
      values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`);
      params.push(...r);
    });
    const res = await dbQuery<{ signal_id: number }>(
      `INSERT INTO directional_labels
         (signal_id, barrier_spec, label, ambiguous_candle, low_vol_history, t_hit_candles, mfe_return_pct, mae_return_pct, barrier_pct)
       VALUES ${values.join(',')}
       ON CONFLICT (signal_id, barrier_spec) DO NOTHING
       RETURNING signal_id`,
      params,
    );
    cov.written += res.length;
  }
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  ensureTable();
  const groups = await loadGroups(cli);
  console.log(`[${ts()}] DWR backfill start — ${groups.length} groups, specs=[${cli.specs.map((s) => s.spec).join(', ')}]${cli.check ? ' (CHECK — no writes)' : ''}`);

  await runAsBatch(async () => {
    for (const g of groups) {
      cov.groups++;
      try {
        await processGroup(cli, g);
      } catch (err) {
        cov.errors++;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[${ts()}] group ${g.exchange}:${g.coin}:${g.timeframe} error: ${msg}`);
      }
      if (cov.groups % 200 === 0) {
        console.log(`[${ts()}] ${cov.groups}/${groups.length} groups | labeled ${cov.labeled} | written ${cov.written} | noKlines ${cov.noKlines} | budgetSkips ${cov.budgetSkips}`);
      }
    }
  });

  console.log(`[${ts()}] DONE ${JSON.stringify({ ...cov, noKlinesByVenue: Object.fromEntries(noKlinesByVenue) })}`);
}

if (require.main === module) {
  runAsCaller('dwr-backfill', main)
    .then(() => closeDb())
    .catch((err) => {
      console.error('Fatal:', err);
      closeDb();
      process.exit(1);
    });
}
