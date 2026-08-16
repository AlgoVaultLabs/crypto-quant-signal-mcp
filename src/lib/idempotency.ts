/**
 * PRICING-BOT-DELIVERY-METERING-W1 CH1 — the shared claim-once helper.
 *
 * This extraction was owed. `x402-idempotency-store.ts` has carried the WIS
 * *"4th tryClaim variant; extract shared tryClaim(table,pk) — OPS-IDEMPOTENCY-HELPER-EXTRACTION-W1
 * (siblings: webhooks-store.tryClaimDelivery, stripe-events-store.tryClaimEvent,
 * signup-emails-store.tryClaimSignupEmailEvent). Do NOT extract here."* — and this wave needs a
 * FIFTH. CLAUDE.md's generator rule ("the 4th same-class fix MUST build a gate making the bug
 * class structurally impossible") makes the extraction mandatory at this point rather than
 * optional, so the helper ships WITH its gate: `scripts/check-idempotency-helper.mjs` fails any
 * new hand-rolled `tryClaim*` under `src/lib/`.
 *
 * The four incumbents are NOT migrated here — that is `OPS-IDEMPOTENCY-HELPER-EXTRACTION-W1`,
 * explicitly deferred, and they sit in the gate's shrink-only allowlist. Migrating them is a
 * behaviour-touching change to three live revenue/mail paths and does not belong in a wave whose
 * subject is bot metering.
 *
 * WHAT THIS OWNS: the INSERT-and-see-if-a-row-came-back dance, and the Postgres-vs-SQLite
 * dialect split. It does NOT own any table's DDL (each store keeps its own), does NOT know what
 * a quota is, and must not be imported by anything that is not a claim store.
 */
import { dbQuery } from './performance-db.js';
import { recordIndeterminate } from './indeterminate-counter.js';

/**
 * The three states a claim attempt can be in — re-exported from the store that first got this
 * right, so there is ONE home for the union rather than a second identical declaration.
 *
 * A boolean cannot carry three, and that IS the defect it replaced: `false` meant BOTH "already
 * claimed" (a settled fact about the caller) and "the database errored" (a confession about us),
 * so a fault was reported as an ordinary replay and the x402 rail served nothing for ~25 hours
 * while every gate stayed green.
 */
export type { ClaimOutcome } from './x402-idempotency-store.js';
import type { ClaimOutcome } from './x402-idempotency-store.js';

/**
 * Tables this helper is permitted to write, and the conflict columns it may arbitrate on.
 *
 * `table` and `conflictCols` are interpolated into SQL, so they must NEVER be caller-supplied at
 * runtime. Every call site passes a module constant; this allowlist turns that convention into an
 * assertion. A caller reaching here with a runtime-derived table name is either a bug or an
 * injection attempt, and both get the same answer.
 */
const CLAIMABLE_TABLES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  entitlement_debits: Object.freeze(['idem_key']),
});

/** Identifier shape SQL will accept from us: a bare snake_case name, nothing else. */
const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;

/**
 * Claim an idempotency key exactly once.
 *
 * `'CLAIMED'`         — this call won the insert. The caller may now perform its side effect.
 * `'ALREADY_CLAIMED'` — a genuine replay. The side effect already happened; do it again at your peril.
 * `'INDETERMINATE'`   — the database errored. We do NOT know. Distinct from a replay on purpose.
 *
 * Concurrency-safe: of N concurrent calls with the same key, exactly one gets `'CLAIMED'` — the
 * DB's own conflict arbitration decides, not application logic.
 *
 * **`DO NOTHING`, never `DO UPDATE`.** Carried verbatim from the x402 store's reasoning because it
 * generalises exactly: a replay must never overwrite a row whose state has since moved forward.
 * There, a `DO UPDATE` would have reset genuinely-settled on-chain revenue back to
 * CLAIMED_UNSETTLED on every replay — un-settling money that did move. Any table this helper
 * serves inherits that guarantee, and it is why the winning insert is the ONLY write.
 */
export async function tryClaimOnce(
  table: string,
  conflictCols: readonly string[],
  row: Readonly<Record<string, string | number>>,
  reasonTag: string,
): Promise<ClaimOutcome> {
  const allowedCols = CLAIMABLE_TABLES[table];
  if (!allowedCols) {
    // Not INDETERMINATE: an unlisted table is a DETERMINED refusal — we know the answer, and the
    // answer is "you may not write here". INDETERMINATE is reserved for "the DB errored".
    console.error(`[idempotency] tryClaimOnce called for unlisted table ${JSON.stringify(table)} — refusing`);
    return 'ALREADY_CLAIMED';
  }
  const colsMatch =
    conflictCols.length === allowedCols.length && conflictCols.every((c, i) => c === allowedCols[i]);
  if (!colsMatch) {
    console.error(
      `[idempotency] tryClaimOnce(${table}) conflict columns ${JSON.stringify(conflictCols)} ` +
        `do not match the declared ${JSON.stringify(allowedCols)} — refusing`,
    );
    return 'ALREADY_CLAIMED';
  }
  const cols = Object.keys(row);
  if (cols.length === 0 || !cols.every((c) => SAFE_IDENT.test(c))) {
    console.error(`[idempotency] tryClaimOnce(${table}) got an unusable column set — refusing`);
    return 'ALREADY_CLAIMED';
  }

  try {
    const isPg = !!process.env.DATABASE_URL;
    const placeholders = cols.map(() => '?').join(', ');
    // RETURNING is supported on PG and on SQLite >= 3.35 (this codebase's better-sqlite3
    // baseline). The returned row is the signal: it exists only when the insert actually
    // happened, which is precisely "I won the race".
    const sql = isPg
      ? `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})
         ON CONFLICT (${conflictCols.join(', ')}) DO NOTHING
         RETURNING ${conflictCols[0]}`
      : `INSERT OR IGNORE INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})
         RETURNING ${conflictCols[0]}`;
    const inserted = await dbQuery<Record<string, unknown>>(
      sql,
      cols.map((c) => row[c]),
    );
    return inserted.length > 0 ? 'CLAIMED' : 'ALREADY_CLAIMED';
  } catch (err) {
    // Loud, counted, and DISTINCT from a replay. Collapsing this into 'ALREADY_CLAIMED' is the
    // 25-hour outage described in the type's docblock; the caller decides what a fault means for
    // its own path, and it cannot decide if we lie about which one happened.
    console.error(
      `[idempotency] tryClaimOnce(${table}) failed — INDETERMINATE:`,
      err instanceof Error ? err.message : String(err),
    );
    recordIndeterminate(reasonTag, err instanceof Error ? err.message : String(err));
    return 'INDETERMINATE';
  }
}
