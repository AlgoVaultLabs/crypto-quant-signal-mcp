/**
 * FUNNEL-ATTRIBUTION-CLASSIFY-BACKFILL-W1 CH2 — recover the recoverable class, refuse the rest.
 *
 * Every `signup_attribution` row written before 2026-09-07T00:10Z carries NULL `classification`
 * and NULL `ua_class`, because migration 038 landed the columns at that instant. This script
 * projects each row's STORED `user_agent` through `classifyStoredUa()` and writes back ONLY what
 * that projection can prove:
 *
 *   `classification = 'bot'`  when the canonical classifier calls the UA automated
 *   `ua_class = <slug>`       always (it is a pure function of the UA — recoverable in full)
 *   `backfilled_at = <now>`   on every row touched
 *
 * Rows whose UA is browser-shaped keep `classification` NULL. That is the POINT, not a shortfall:
 * the evidence that would make them `browser` or `unknown` (Sec-Fetch metadata, Accept) was never
 * stored, and inventing it would manufacture the human clicks this whole arc exists to stop
 * counting. `src/lib/attribution-backfill.ts` carries the six-step recoverability table and the
 * type that makes those two classes unrepresentable.
 *
 * Measured expectation on signal-1, 2026-09-10 — scanned 782 · set_bot 222 · set_ua_class_only 521
 * · skipped_no_ua 39. Recovery rate 29.9 % of the 743 UA-bearing rows, under THIS script's
 * instrument (`classifyTraffic`). Raw `isbot@5.1.44` over the same rows says 34.3 %; the 33-row
 * gap is bare SDKs and agent_clients the registry deliberately un-tags, and they stay NULL by
 * policy. Do not compare either figure to the 42.2 % in
 * `ops/scripts/intent-classification-readout.sh` — that is raw isbot over a different 28d window.
 *
 * ── SAFETY: THE UPDATE CANNOT REACH A LIVE VERDICT ───────────────────────────────────────────
 * Two statement shapes, and the split is the safety property rather than a convenience:
 *
 *   `botUpdateSql()`     writes `classification` and carries `classification IS NULL` in its own
 *                        WHERE — belt and braces over the selector.
 *   `uaClassUpdateSql()` never names `classification` at all, so it is STRUCTURALLY incapable of
 *                        overwriting a verdict; no guard to forget.
 *
 * Both carry `backfilled_at IS NULL`, which is what makes a re-run a no-op by construction rather
 * than by a flag somebody has to remember.
 *
 * ── `dbQuery` + `RETURNING`, NEVER `dbRun` ───────────────────────────────────────────────────
 * `dbRun` is fire-and-forget on the PG backend and returns `void`: a one-shot script can lose its
 * last writes at process exit, and can never count what it actually wrote — which would leave the
 * idempotence and dry-run-wrote-nothing proofs resting on intentions. `RETURNING <pk>` gives the
 * statement result columns, so better-sqlite3's `.all()` is the correct method there too, and the
 * write stays on the awaited, durable path. Identical syntax on both backends. This is the ruling
 * recorded at `src/scripts/backfill-x402-payer-wallet.ts:198-219` and the skill
 * `db-wrapper-update-delete-needs-returning-not-dbrun`.
 *
 * ── DEFAULT READ-ONLY ────────────────────────────────────────────────────────────────────────
 * Without `--execute` this reads, projects, prints the tally, and writes NOTHING (the
 * `backfill-x402-payer-wallet.ts:137` pattern). The dry run is what CH3 compares the executed run
 * against, so it must produce the same tally from the same rows.
 *
 * Prints exactly ONE terminal line: `SIGNUP_ATTRIBUTION_BACKFILL_VERDICT=PASS|INDETERMINATE`.
 * INDETERMINATE (exit 3 — the token-law default for a gate with no incumbent code) when the DB is
 * unreachable or a batch throws. Never FAIL: "nothing to do" is a legitimate PASS, and this script
 * has no notion of a wrong answer — only of an answer it could not obtain.
 *
 * Usage:
 *   npm run backfill:signup-class            # read-only, prints the tally
 *   npm run backfill:signup-class -- --execute
 */
import { dbQuery } from '../lib/performance-db.js';
import { classifyStoredUa } from '../lib/attribution-backfill.js';

/** Batch size for the `IN (…)` lists. Bounds the parameter count per statement. */
export const BATCH_SIZE = 500;

/**
 * The rows this job can see.
 *
 * `backfilled_at IS NULL` is the idempotence key — a second run selects nothing. The second
 * clause is the work predicate: a row already carrying both values needs nothing, even if it
 * predates the stamp. Exported because a selector that decides which rows a job can see is
 * load-bearing logic, not a string — the same lesson `UNATTRIBUTED_SQL` records next door, where
 * an untested inline literal silently reduced a whole job to a no-op.
 */
export const BACKFILL_CANDIDATE_SQL =
  `SELECT client_reference_id, user_agent, classification
     FROM signup_attribution
    WHERE backfilled_at IS NULL
      AND (classification IS NULL OR ua_class IS NULL)
    ORDER BY created_at`;

export interface CandidateRow {
  client_reference_id: string;
  user_agent: string | null;
  /**
   * The row's CURRENT classification. Selected so the tally can distinguish "we set this" from
   * "this was already set and we only filled its ua_class" — without it,
   * `already_classified_skipped` would be a hard-coded zero, which is a claim rather than a count.
   */
  classification: string | null;
}

/** One group of rows sharing a target (classification, ua_class) pair. */
export interface BackfillGroup {
  classification: 'bot' | null;
  uaClass: string;
  ids: string[];
}

export interface BackfillTally {
  scanned: number;
  set_bot: number;
  set_ua_class_only: number;
  skipped_no_ua: number;
  already_classified_skipped: number;
}

/**
 * Project every candidate row and group it by its target pair. PURE — no I/O, no clock.
 *
 * Grouping is what makes this batched at all: the distinct (classification, ua_class) pairs over
 * the live population number about a dozen, so ~12 statements replace 782 round trips while every
 * row still gets exactly the verdict its own UA implies.
 *
 * `alreadyClassified` counts rows the selector admitted because their `ua_class` was NULL while
 * their `classification` was not. It is 0 on the measured population (the two NULL sets are
 * identical, both 782) and is carried for exhaustiveness: a non-zero count here means the two
 * columns diverged, which is worth seeing rather than silently folding into another bucket.
 */
export function planBackfill(rows: readonly CandidateRow[]): { groups: BackfillGroup[]; tally: BackfillTally } {
  const byKey = new Map<string, BackfillGroup>();
  const tally: BackfillTally = {
    scanned: rows.length,
    set_bot: 0,
    set_ua_class_only: 0,
    skipped_no_ua: 0,
    already_classified_skipped: 0,
  };

  for (const row of rows) {
    const projected = classifyStoredUa(row.user_agent);
    const hasUa = !!(row.user_agent ?? '').trim();
    // A row that ALREADY carries a verdict keeps it, whatever the projector says. This is the
    // never-overwrite-a-live-verdict rule expressed in the PLAN, so the tally and the SQL agree
    // about which rows are being written rather than only the SQL knowing.
    const alreadyClassified = row.classification !== null && row.classification !== undefined;
    const classification = alreadyClassified ? null : projected.classification;

    if (alreadyClassified) tally.already_classified_skipped += 1;
    else if (classification === 'bot') tally.set_bot += 1;
    else if (hasUa) tally.set_ua_class_only += 1;
    else tally.skipped_no_ua += 1;

    const key = `${classification ?? '-'}|${projected.uaClass}`;
    const g = byKey.get(key) ?? { classification, uaClass: projected.uaClass, ids: [] };
    g.ids.push(row.client_reference_id);
    byKey.set(key, g);
  }

  return { groups: [...byKey.values()], tally };
}

/** Split a group's ids into statement-sized chunks. */
export function chunk<T>(xs: readonly T[], size = BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/**
 * Writes `classification='bot'`. Carries `classification IS NULL` in its OWN WHERE so the
 * safety property does not depend on the selector having been correct.
 *
 * `COALESCE(ua_class, ?)` rather than a bare assignment: a row that somehow already carries a
 * `ua_class` keeps it. This job recovers what is missing; it never restates what is present.
 */
export function botUpdateSql(idCount: number): string {
  return `UPDATE signup_attribution
             SET classification = 'bot',
                 ua_class = COALESCE(ua_class, ?),
                 backfilled_at = ?
           WHERE client_reference_id IN (${placeholders(idCount)})
             AND classification IS NULL
             AND backfilled_at IS NULL
       RETURNING client_reference_id`;
}

/**
 * Writes `ua_class` and the stamp, and NEVER names `classification`.
 *
 * That omission is the guard. A row this statement touches cannot have its verdict changed no
 * matter what the selector did, because the column is not in the SET list at all.
 */
export function uaClassUpdateSql(idCount: number): string {
  return `UPDATE signup_attribution
             SET ua_class = COALESCE(ua_class, ?),
                 backfilled_at = ?
           WHERE client_reference_id IN (${placeholders(idCount)})
             AND backfilled_at IS NULL
       RETURNING client_reference_id`;
}

function fmt(t: BackfillTally): string {
  return `scanned=${t.scanned} set_bot=${t.set_bot} set_ua_class_only=${t.set_ua_class_only} `
    + `skipped_no_ua=${t.skipped_no_ua} already_classified_skipped=${t.already_classified_skipped}`;
}

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');
  const stampedAt = new Date().toISOString();

  let rows: CandidateRow[];
  try {
    rows = await dbQuery<CandidateRow>(BACKFILL_CANDIDATE_SQL, []);
  } catch (err) {
    // Could not READ. "Could not see" is never "saw nothing" — the row count is the denominator
    // every downstream figure is a fraction of, so an unreadable table must not print a tally.
    console.error(`[backfill-signup-class] SELECT failed: ${err instanceof Error ? err.message : err}`);
    console.log('SIGNUP_ATTRIBUTION_BACKFILL_VERDICT=INDETERMINATE');
    process.exit(3);
  }

  const { groups, tally } = planBackfill(rows);

  console.log(`[backfill-signup-class] mode=${execute ? 'EXECUTE' : 'DRY-RUN (read-only)'} · ${fmt(tally)}`);
  console.log(`[backfill-signup-class] ${groups.length} group(s) by (classification, ua_class):`);
  for (const g of [...groups].sort((a, b) => b.ids.length - a.ids.length)) {
    console.log(`    ${String(g.ids.length).padStart(5)}  classification=${g.classification ?? 'NULL (kept)'} ua_class=${g.uaClass}`);
  }

  if (!execute) {
    console.log('[backfill-signup-class] DRY RUN — nothing written. Re-run with --execute to apply.');
    console.log('SIGNUP_ATTRIBUTION_BACKFILL_VERDICT=PASS');
    return;
  }

  let written = 0;
  for (const g of groups) {
    for (const ids of chunk(g.ids)) {
      const sql = g.classification === 'bot' ? botUpdateSql(ids.length) : uaClassUpdateSql(ids.length);
      try {
        const res = await dbQuery<{ client_reference_id: string }>(sql, [g.uaClass, stampedAt, ...ids]);
        written += res.length;
        console.log(`[backfill-signup-class]   wrote ${res.length}/${ids.length} · classification=${g.classification ?? 'NULL (kept)'} ua_class=${g.uaClass}`);
      } catch (err) {
        // A batch that threw leaves the run PARTIAL, and a partial run's tally is not the tally
        // CH3 compares against. Stop and say so rather than continuing into a number nobody can
        // reconcile; `backfilled_at` makes the completed batches a safe resume point.
        console.error(`[backfill-signup-class] batch failed: ${err instanceof Error ? err.message : err}`);
        console.log('SIGNUP_ATTRIBUTION_BACKFILL_VERDICT=INDETERMINATE');
        process.exit(3);
      }
    }
  }

  console.log(`[backfill-signup-class] EXECUTED · rows stamped=${written} (expected ${tally.scanned})`);
  console.log('SIGNUP_ATTRIBUTION_BACKFILL_VERDICT=PASS');
}

// Import-safe: the test suite imports the pure helpers above without touching a database.
if (require.main === module) {
  main().catch((err) => {
    console.error(`[backfill-signup-class] fatal: ${err instanceof Error ? err.message : err}`);
    console.log('SIGNUP_ATTRIBUTION_BACKFILL_VERDICT=INDETERMINATE');
    process.exit(3);
  });
}
