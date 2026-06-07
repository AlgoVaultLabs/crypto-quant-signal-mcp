/**
 * x402 payment idempotency store (SECURITY-FIX-X402-WEBHOOK-W1 / X402-02).
 *
 * Closes the pre-settle replay window found by SECURITY-AUDIT-RECENT-FEATURES-W1
 * (area1-x402.md, X402-02): `verifyX402Payment` (x402.ts) is stateless and
 * `settleX402Async` is fire-and-forget, so within the ~2s window between verify
 * and the on-chain settle (which burns the ERC-3009 nonce) the SAME X-PAYMENT
 * header replayed concurrently unlocks N resources for ONE on-chain charge. PoC:
 * 20/20 concurrent replays served. The fix is a server-side single-use claim on
 * the payment's ERC-3009 nonce, taken BEFORE the resource is served.
 *
 * WIS: 4th tryClaim variant; extract shared tryClaim(table,pk) — OPS-IDEMPOTENCY-HELPER-EXTRACTION-W1
 * (siblings: webhooks-store.tryClaimDelivery, stripe-events-store.tryClaimEvent,
 * signup-emails-store.tryClaimSignupEmailEvent). Do NOT extract here.
 *
 * MIRRORS stripe-events-store.tryClaimEvent's `processed_<provider>_events` +
 * INSERT-ON-CONFLICT-DO-NOTHING shape, with ONE deliberate difference: the x402
 * threat is *concurrent* replay (the PoC fires 20 at once), NOT the seconds-apart
 * retry Stripe does. A SELECT-then-INSERT (as stripe-events-store uses, whose own
 * comment notes "race window is acceptable here — Stripe retries are seconds
 * apart, not concurrent") would let two concurrent fibers both pass the SELECT
 * and both serve. So this store claims ATOMICALLY via `INSERT ... ON CONFLICT
 * (nonce) DO NOTHING RETURNING nonce` and treats "a row came back" as "I won the
 * claim" — the DB's PRIMARY KEY uniqueness is the single point of arbitration, so
 * exactly one of N concurrent replays wins regardless of settle latency.
 *
 * Uses the same dual-backend DB access helper the other stores use
 * (./performance-db). RETURNING is supported on PG and on SQLite ≥3.35 (the
 * codebase's better-sqlite3 baseline; cf. CLAUDE.md "SQLite (3.35+) ... DO
 * support" ADD COLUMN IF NOT EXISTS).
 */
import { dbExec, dbQuery } from './performance-db.js';

const CREATE_PROCESSED_X402_PAYMENTS_SQL = `
  CREATE TABLE IF NOT EXISTS processed_x402_payments (
    nonce TEXT PRIMARY KEY,
    tool TEXT,
    amount TEXT,
    created_at ${process.env.DATABASE_URL ? 'TIMESTAMPTZ' : 'TIMESTAMP'} DEFAULT ${process.env.DATABASE_URL ? 'now()' : "(datetime('now'))"}
  );
  CREATE INDEX IF NOT EXISTS idx_processed_x402_payments_created_at ON processed_x402_payments (created_at);
`;

let _initialized = false;

/** Idempotent schema-setup. No-op against the prod table (pre-applied via SSH). */
export function ensureProcessedX402PaymentsSchema(): void {
  if (_initialized) return;
  dbExec(CREATE_PROCESSED_X402_PAYMENTS_SQL);
  _initialized = true;
}

/**
 * Atomically claim a payment nonce for single use.
 *
 * Returns `true` if THIS call inserted the row (the caller MAY serve + settle),
 * `false` if the nonce was already claimed (replay → caller MUST 402 without
 * serving/settling). Concurrency-safe: of N concurrent calls with the same
 * nonce, exactly one gets `true` (the DB PRIMARY KEY arbitrates the
 * `INSERT ... ON CONFLICT DO NOTHING RETURNING` race).
 *
 * The ON CONFLICT/OR IGNORE clause is keyed on `nonce` (the PRIMARY KEY); the
 * RETURNING clause yields the row only when the insert actually happened, which
 * is the signal we read. PG: `ON CONFLICT (nonce) DO NOTHING RETURNING nonce`.
 * SQLite: `INSERT OR IGNORE ... RETURNING nonce`.
 *
 * DB-unreachable / error path: FAIL SAFE (default-deny on the paid path, per
 * CLAUDE.md "default-deny + load-bearing logging"). We do NOT grant a free
 * re-serve on a DB error — we log loudly and return `false` so the route 402s.
 * A reject on a transient DB blip costs the buyer one retry (their nonce is
 * still unspent on-chain); a grant on a DB blip would re-open the very replay
 * hole this store closes.
 */
export async function tryClaimPayment(
  nonce: string,
  tool: string,
  amount: string,
): Promise<boolean> {
  if (!nonce) {
    // No usable idempotency key — fail safe (do not serve). Should not happen
    // for a verified EIP-3009 payment (nonce is a required authorization field).
    console.error('[x402-idempotency] tryClaimPayment called with empty nonce — failing safe (reject)');
    return false;
  }
  try {
    ensureProcessedX402PaymentsSchema();
    const isPg = !!process.env.DATABASE_URL;
    const sql = isPg
      ? `INSERT INTO processed_x402_payments (nonce, tool, amount)
         VALUES (?, ?, ?)
         ON CONFLICT (nonce) DO NOTHING
         RETURNING nonce`
      : `INSERT OR IGNORE INTO processed_x402_payments (nonce, tool, amount)
         VALUES (?, ?, ?)
         RETURNING nonce`;
    const inserted = await dbQuery<{ nonce: string }>(sql, [nonce, tool, amount]);
    // Row returned ⇒ this call won the insert ⇒ first use. Empty ⇒ replay.
    return inserted.length > 0;
  } catch (err) {
    // Fail safe: reject (do not serve) on any DB error. Loud per default-deny.
    console.error(
      `[x402-idempotency] tryClaimPayment DB error for nonce=${nonce} tool=${tool} — failing safe (reject):`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/** Count of claimed payments (test/observability). */
export async function getClaimedPaymentCount(): Promise<number> {
  ensureProcessedX402PaymentsSchema();
  const rows = await dbQuery<{ count: string }>(
    'SELECT COUNT(*) as count FROM processed_x402_payments',
    [],
  );
  return rows.length > 0 ? Number(rows[0].count) : 0;
}

/**
 * Extract the single-use idempotency key (ERC-3009 authorization nonce) from a
 * verified x402 payment payload (the parsed X-PAYMENT envelope stored as
 * `pendingSettlement.paymentPayload`).
 *
 * x402 v2 EIP-3009 shape (cf. @x402/evm ExactEIP3009Payload):
 *   { x402Version, accepted, payload: { signature, authorization: { ..., nonce } } }
 * Permit2 shape nests under `payload.permit2Authorization.nonce`. We read the
 * EIP-3009 path first (the configured USDC/exact scheme), then Permit2, then a
 * couple of defensive fallbacks. Returns `undefined` if no nonce is present
 * (caller fails safe).
 */
export function extractPaymentNonce(paymentPayload: unknown): string | undefined {
  if (!paymentPayload || typeof paymentPayload !== 'object') return undefined;
  const p = paymentPayload as {
    payload?: {
      authorization?: { nonce?: unknown };
      permit2Authorization?: { nonce?: unknown };
    };
    authorization?: { nonce?: unknown };
    nonce?: unknown;
  };
  const candidates = [
    p.payload?.authorization?.nonce,        // EIP-3009 (USDC transferWithAuthorization)
    p.payload?.permit2Authorization?.nonce, // Permit2 flow
    p.authorization?.nonce,                 // defensive: un-nested authorization
    p.nonce,                                // defensive: top-level nonce
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return undefined;
}
