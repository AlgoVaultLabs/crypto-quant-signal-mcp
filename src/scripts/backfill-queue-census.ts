/**
 * backfill-queue-census.ts — OPS-ALARM-OWNER-DERIVATION-W1 CH1. A PURE emitter of the PFE outcome
 * backfill's OWN census SQL, for the canary that judges it.
 *
 *   node dist/scripts/backfill-queue-census.js --emit-sql --now <epoch-seconds>
 *
 * Prints ONE JSON line — `{census_sql, venue_sql, past_reach_clause, horizons_s, constants, reach_measured_at,
 * source_sha}`
 * — then `BACKFILL_CENSUS_EMIT_VERDICT=PASS` (exit 0). A malformed argument or any builder throw prints
 * `BACKFILL_CENSUS_EMIT_VERDICT=INDETERMINATE` and NO JSON (exit 3, the token-law default for a new
 * gate). It opens no database and makes no network call: the canary runs the SQL itself, through its
 * own least-privilege read-only seam (`aoe_readonly`).
 *
 * WHY. `ops/monitoring/outcome-backfill-freshness.py` judged the producer through a hand-written Python
 * mirror of the queue predicate and of `EVAL_CANDLES` — a second derivation that is structurally
 * blind to every change it is not told about (the A1b maturity clause nearly diverged; the drain
 * gate's copy did). Executing the producer's own builders makes that drift unrepresentable: the next
 * change to the queue, the cap, the cooldown, the horizons or the reach table reaches the canary in
 * the same deploy, with nothing to keep in sync.
 */
import {
  buildBackfillCensusSql, buildBackfillVenueCensusSql,
  BACKFILL_QUEUE_LIMIT, BACKFILL_MAX_ATTEMPTS, BACKFILL_ATTEMPT_COOLDOWN_S,
} from '../lib/performance-db.js';
import { EVAL_CANDLES, maturityHorizonS } from '../lib/pfe-mae.js';
import { REACH_MARGIN_S, EXPIRY_REACH_DAYS_MEASURED_AT, buildPastReachClause } from '../lib/venue-candle-reach.js';
import { runScript } from '../lib/script-lifecycle.js';

export const VERDICT_TOKEN = 'BACKFILL_CENSUS_EMIT_VERDICT';

/** The emitted keys, in order. The canary declares the same tuple and a test pins the two equal. */
export const EMITTER_KEYS = [
  'census_sql', 'venue_sql', 'past_reach_clause', 'horizons_s', 'constants', 'reach_measured_at', 'source_sha',
] as const;
export const EMITTER_CONSTANT_KEYS = ['limit', 'max_attempts', 'cooldown_s', 'reach_margin_s'] as const;

export interface CensusEmission {
  census_sql: string;
  venue_sql: string;
  /** The past-reach subtrahend, emitted on its own so the canary can audit it on every live run: it must
   *  name no attempt column (RIDER 4) and must be the clause `census_sql` executes. */
  past_reach_clause: string;
  horizons_s: Record<string, number>;
  constants: { limit: number; max_attempts: number; cooldown_s: number; reach_margin_s: number };
  reach_measured_at: string;
  source_sha: string;
}

/** The deployed commit, as the image records it (`Dockerfile` ARG/ENV GIT_SHA) — provenance only.
 *  Same rule as `normaliseSha` in ops-build-api.ts (a full 40-hex SHA, or nothing), kept local so this
 *  emitter does not import the HTTP layer. */
function sourceSha(env: NodeJS.ProcessEnv): string {
  const s = (env.GIT_SHA ?? '').trim();
  return /^[0-9a-f]{40}$/.test(s) ? s : 'unknown';
}

/** PURE: the census the canary executes, at a pinned `now`. Throws only if a builder throws. */
export function buildCensusEmission(nowS: number, env: NodeJS.ProcessEnv = process.env): CensusEmission {
  const horizons: Record<string, number> = {};
  for (const tf of Object.keys(EVAL_CANDLES)) {
    const h = maturityHorizonS(tf);
    if (h === null) throw new Error(`no maturity horizon for ${tf} — refusing to emit a partial horizon map`);
    horizons[tf] = h;
  }
  const emission: CensusEmission = {
    census_sql: buildBackfillCensusSql(nowS),
    venue_sql: buildBackfillVenueCensusSql(nowS),
    past_reach_clause: buildPastReachClause(nowS),
    horizons_s: horizons,
    constants: {
      limit: BACKFILL_QUEUE_LIMIT,
      max_attempts: BACKFILL_MAX_ATTEMPTS,
      cooldown_s: BACKFILL_ATTEMPT_COOLDOWN_S,
      reach_margin_s: REACH_MARGIN_S,
    },
    reach_measured_at: EXPIRY_REACH_DAYS_MEASURED_AT,
    source_sha: sourceSha(env),
  };
  // The contract the canary parses, checked on the object actually emitted: a key added, dropped or
  // reordered here without the declared tuple (and the canary's copy, pinned equal by a test) is a
  // throw — i.e. INDETERMINATE at the canary — never a census the canary half-reads.
  const keys = Object.keys(emission).join(',');
  if (keys !== EMITTER_KEYS.join(',')) throw new Error(`emission keys ${keys} ≠ EMITTER_KEYS ${EMITTER_KEYS.join(',')}`);
  const ckeys = Object.keys(emission.constants).join(',');
  if (ckeys !== EMITTER_CONSTANT_KEYS.join(',')) throw new Error(`constants ${ckeys} ≠ EMITTER_CONSTANT_KEYS`);
  return emission;
}

/** The CLI as a pure function of argv: the lines to print and the exit code. */
export function runCensusEmitter(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): { lines: string[]; exitCode: number } {
  const indeterminate = (why: string) => ({
    lines: [`[backfill-queue-census] ${why}`, `${VERDICT_TOKEN}=INDETERMINATE`],
    exitCode: 3,
  });
  if (!argv.includes('--emit-sql')) return indeterminate('usage: --emit-sql --now <epoch-seconds>');
  const i = argv.indexOf('--now');
  const raw = i >= 0 ? argv[i + 1] : undefined;
  if (raw === undefined || !/^[0-9]{9,11}$/.test(raw)) return indeterminate(`--now must be epoch seconds, got ${JSON.stringify(raw ?? null)}`);
  try {
    return { lines: [JSON.stringify(buildCensusEmission(Number(raw), env)), `${VERDICT_TOKEN}=PASS`], exitCode: 0 };
  } catch (e) {
    return indeterminate(`a builder threw: ${e instanceof Error ? e.message : String(e)}`);
  }
}

if (require.main === module) {
  // runScript: drain-then-exit on every path (OPS-SCRIPT-EXIT-LIFECYCLE-W1) — it flushes stdout before
  // exiting, so the verdict token can never be cut off the pipe the canary reads through `docker exec`.
  void runScript('backfill-queue-census', async () => {
    const r = runCensusEmitter(process.argv.slice(2));
    for (const line of r.lines) console.log(line);
    return r.exitCode;
  });
}
