/**
 * seed-equities.ts — EQUITIES-ENGINE-W1 C5 nightly producer.
 *
 * Pulls the latest session's ohlcv-1d for the frozen universe → upserts bars →
 * computes verdicts → writes equity_verdicts. Idempotent + holiday/no-advance
 * no-op (skips if the latest available session already has verdicts). Follows
 * the cron:prod precedent (compiled dist/scripts, run via docker exec).
 *
 * Run: docker exec crypto-quant-signal-mcp-mcp-server-1 node dist/scripts/seed-equities.js [--once]
 * CJS/Node16.
 */
import pLimit from 'p-limit';
import { runScript } from '../lib/script-lifecycle.js';
import { DatabentoEquityBarsProvider } from '../lib/equities/equity-bars-provider.js';
import { computeVerdictsForUniverse } from '../lib/equities/equity-verdict.js';
import { isValidSession } from '../lib/equities/equity-indicators.js';
import { makeEquityPool, getActiveUniverse, upsertBars, insertVerdicts } from '../lib/equities/equity-store.js';
import { ENGINE_VERSION, PFE_HORIZON_SESSIONS } from '../lib/equities/equity-constants.js';

const SYMBOLS_PER_REQUEST = 40;
const CONCURRENCY = 4;
/** Small self-heal window so a missed nightly run backfills recent gaps. */
const SEED_WINDOW_DAYS = 7;

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function log(msg: string): void { console.log(`[seed-equities] ${msg}`); }
function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export async function seedEquities(): Promise<{ session: string; bars: number; verdicts: number; noop: boolean }> {
  const key = process.env.DATABENTO_API_KEY;
  if (!key) throw new Error('DATABENTO_API_KEY not set (container .env + `docker compose up -d mcp-server`).');

  const provider = new DatabentoEquityBarsProvider(key, { logger: log });
  const pool = makeEquityPool();
  try {
    const session = await provider.getLatestAvailableSession();
    if (!isValidSession(session)) log(`WARN latest session ${session} is not a valid trading day per calendar — proceeding (Databento authoritative)`);

    // Holiday / no-advance no-op: latest session already fully computed → exit clean.
    const already = await pool.query(
      `SELECT count(*)::int AS c FROM equity_verdicts WHERE session_date=$1 AND engine_version=$2`,
      [session, ENGINE_VERSION]
    );
    if (already.rows[0].c > 0) {
      log(`no-op: ${already.rows[0].c} verdicts already exist for session ${session} (holiday or already ran)`);
      return { session, bars: 0, verdicts: 0, noop: true };
    }

    const universe = await getActiveUniverse(pool);
    if (universe.length === 0) throw new Error('equity_universe empty — run build-equity-universe first.');

    // Pull bars for the recent window (self-heal) and upsert.
    const start = addDays(session, -SEED_WINDOW_DAYS);
    const end = addDays(session, 1);
    const limit = pLimit(CONCURRENCY);
    let barsUpserted = 0;
    await Promise.all(chunk(universe.map((u) => u.symbol), SYMBOLS_PER_REQUEST).map((batch) => limit(async () => {
      try {
        const bars = await provider.getDailyBars(batch, start, end);
        barsUpserted += await upsertBars(pool, bars);
      } catch (e: unknown) {
        log(`bar batch error ${(e as Error).message} — continuing (resumable)`);
      }
    })));
    log(`bars upserted for ${start}..${end}: +${barsUpserted}`);

    // Compute + persist verdicts for the latest session.
    const rows = await computeVerdictsForUniverse(pool, session);
    const written = await insertVerdicts(pool, rows, PFE_HORIZON_SESSIONS);
    log(`verdicts: computed=${rows.length} written=${written} for session ${session}`);
    return { session, bars: barsUpserted, verdicts: written, noop: false };
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  void runScript('seed-equities', async () => {
    const r = await seedEquities();
    log(`DONE session=${r.session} bars=${r.bars} verdicts=${r.verdicts} noop=${r.noop}`);
  }); // OPS-SCRIPT-EXIT-LIFECYCLE-W1
}
