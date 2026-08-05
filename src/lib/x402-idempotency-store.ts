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
import { recordIndeterminate } from './indeterminate-counter.js';

/**
 * REVENUE-METER-TRUTH-W4 Step 0B — the settlement vocabulary, imported rather than re-declared.
 *
 * `SettlementClass` is owned by the on-chain classifier (`src/scripts/backfill-x402-payer-wallet.ts`),
 * which is the only thing that can actually decide these values. This is a **type-only** import, so
 * it is erased at compile time: no runtime dependency, no import cycle, no lib→scripts coupling at
 * execution. What it buys is that `tsc` rejects a typo or a private fork of the vocabulary here —
 * the single-derivation property that matters, since a second copy of these strings is how two
 * meters start disagreeing about what "paid" means.
 *
 * If a THIRD consumer appears, extract the union to a pure leaf (the `okx-a2mcp-config.ts` pattern)
 * rather than adding another type-only reach across the layer boundary — 3-example threshold.
 */
import type { SettlementClass } from '../scripts/backfill-x402-payer-wallet.js';

/**
 * A new claim is UNVERIFIED by construction. `tryClaimPayment` runs when a buyer PRESENTS an
 * authorization; nothing at that moment has checked the chain, so the honest initial state is
 * "claimed, not settled". Only the on-chain scan may promote it
 * (`backfill-x402-payer-wallet.ts --classify --execute`).
 *
 * Consequence worth stating rather than discovering: any consumer counting only SETTLED rows reads
 * ZERO until a scan runs. That is the truthful reading, not a regression — the first-ever scan
 * (REVENUE-METER-TRUTH-W1 CH2) measured SETTLED=0 across all 18 historical rows.
 */
const CLAIM_INITIAL_SETTLEMENT_STATE: SettlementClass = 'CLAIMED_UNSETTLED';

/** Rail written when a caller does not declare one — never guessed on their behalf. */
const RAIL_UNKNOWN = 'unknown';

/**
 * The Base/USDC rail. Both writers of this table settle on Base, so this is structural today.
 * `rail` describes ROWS THAT EXIST, never all x402 revenue: OKX `/a2mcp/*` (X-Layer/USDT0) does not
 * write here at all, so a SUM over this table is a Base-only figure and must be labelled as one.
 * Making OKX record here is `OPS-A2MCP-SETTLEMENT-RECORDING-W{NEXT}` — filed, not fixed.
 */
export const RAIL_BASE_USDC = 'base-usdc';

const CREATE_PROCESSED_X402_PAYMENTS_SQL = `
  CREATE TABLE IF NOT EXISTS processed_x402_payments (
    nonce TEXT NOT NULL,
    tool TEXT,
    amount TEXT,
    payer_wallet TEXT NOT NULL DEFAULT '',
    settlement_state TEXT NOT NULL DEFAULT '${CLAIM_INITIAL_SETTLEMENT_STATE}',
    rail TEXT NOT NULL DEFAULT '${RAIL_UNKNOWN}',
    created_at ${process.env.DATABASE_URL ? 'TIMESTAMPTZ' : 'TIMESTAMP'} DEFAULT ${process.env.DATABASE_URL ? 'now()' : "(datetime('now'))"},
    PRIMARY KEY (payer_wallet, nonce)
  );
  CREATE INDEX IF NOT EXISTS idx_processed_x402_payments_nonce ON processed_x402_payments (nonce);
  CREATE INDEX IF NOT EXISTS idx_processed_x402_payments_created_at ON processed_x402_payments (created_at);
  CREATE INDEX IF NOT EXISTS idx_processed_x402_payments_settlement ON processed_x402_payments (settlement_state, created_at);
  ${process.env.DATABASE_URL ? 'ALTER TABLE processed_x402_payments ADD COLUMN IF NOT EXISTS payer_wallet TEXT;' : ''}
  ${process.env.DATABASE_URL ? `ALTER TABLE processed_x402_payments ADD COLUMN IF NOT EXISTS settlement_state TEXT NOT NULL DEFAULT '${CLAIM_INITIAL_SETTLEMENT_STATE}';` : ''}
  ${process.env.DATABASE_URL ? `ALTER TABLE processed_x402_payments ADD COLUMN IF NOT EXISTS rail TEXT NOT NULL DEFAULT '${RAIL_UNKNOWN}';` : ''}
`;
// OPS-X402-WALLET-ATTRIBUTION-W1: `payer_wallet` is additive + nullable (nonce stays the PK /
// idempotency key). Fresh DBs (SQLite tests + fresh PG) get it via CREATE TABLE; an EXISTING PG
// table self-heals via the PG-only `ADD COLUMN IF NOT EXISTS` (SQLite has no such clause, but its
// tables are fresh in tests). Prod was pre-applied via SSH → all three paths are no-ops there.
//
// REVENUE-METER-TRUTH-W4 Step 0B: `settlement_state` + `rail` follow the identical three-path shape
// (migration 026 pre-applied on prod 2026-08-04; fresh DBs via CREATE TABLE; existing PG self-heals).
// No CHECK constraint on either — see 026's header: `tryClaimPayment` fails safe, so a constraint
// violation would REFUSE PAYMENTS, the exact shape of the 25-hour outage this arc already closed.
// The vocabulary is enforced by the `SettlementClass` union and its tests, where a violation is cheap.

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
 * The ON CONFLICT/OR IGNORE clause is keyed on the FULL PRIMARY KEY (payer_wallet, nonce); the
 * RETURNING clause yields the row only when the insert actually happened, which
 * is the signal we read. PG: `ON CONFLICT (payer_wallet, nonce) DO NOTHING RETURNING nonce`.
 * SQLite: `INSERT OR IGNORE ... RETURNING nonce`.
 *
 * DB-unreachable / error path: FAIL SAFE (default-deny on the paid path, per
 * CLAUDE.md "default-deny + load-bearing logging"). We do NOT grant a free
 * re-serve on a DB error — we log loudly and return `false` so the route 402s.
 * A reject on a transient DB blip costs the buyer one retry (their nonce is
 * still unspent on-chain); a grant on a DB blip would re-open the very replay
 * hole this store closes.
 */
/**
 * The three states a claim attempt can be in. A boolean cannot carry three, which is the whole
 * defect: `false` meant BOTH "this nonce was already claimed" (a settled fact) and "the database
 * errored" (we have no idea), so a fault was reported to the caller as an ordinary replay and the
 * paid rail served nothing for ~25 hours while every gate stayed green.
 */
export type ClaimOutcome = 'CLAIMED' | 'ALREADY_CLAIMED' | 'INDETERMINATE';

export async function tryClaimPayment(
  nonce: string,
  tool: string,
  amount: string,
  // OPS-X402-WALLET-ATTRIBUTION-W1: the ERC-3009 payer wallet (additive IDENTITY dimension).
  // Additive TRAILING optional param → every existing caller stays valid. NULL when absent
  // (fail-open) — it is metadata on the winning insert, it NEVER gates the claim.
  payerWallet?: string,
  // REVENUE-METER-TRUTH-W4 Step 0B: the settlement rail. Additive TRAILING optional param, same
  // contract as payerWallet above — metadata on the winning insert, NEVER a gate on the claim, and
  // NOT part of the conflict target, so dedup arbitration stays byte-identical.
  // Absent ⇒ RAIL_UNKNOWN: a caller that does not declare its rail does not get one guessed.
  rail?: string,
): Promise<ClaimOutcome> {
  if (!nonce) {
    // No usable idempotency key — fail safe (do not serve). Should not happen
    // for a verified EIP-3009 payment (nonce is a required authorization field).
    console.error('[x402-idempotency] tryClaimPayment called with empty nonce — failing safe (reject)');
    // A missing nonce is a DETERMINED refusal, not an unknown: a verified EIP-3009 payment always
    // carries one, so its absence tells us the proof is unusable. Not INDETERMINATE.
    return 'ALREADY_CLAIMED';
  }
  try {
    ensureProcessedX402PaymentsSchema();
    const isPg = !!process.env.DATABASE_URL;
    const sql = isPg
      ? `INSERT INTO processed_x402_payments (nonce, tool, amount, payer_wallet, settlement_state, rail)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (payer_wallet, nonce) DO NOTHING
         RETURNING nonce`
      : `INSERT OR IGNORE INTO processed_x402_payments (nonce, tool, amount, payer_wallet, settlement_state, rail)
         VALUES (?, ?, ?, ?, ?, ?)
         RETURNING nonce`;
    // Conflict is STILL arbitrated on the nonce PK (DO NOTHING / OR IGNORE) → dedup byte-identical;
    // payer_wallet rides only on the winning insert, and a replay's DO-NOTHING never overwrites it.
    // SEC-49: '' (not NULL) for an unextractable payer. Under the composite key a NULL would
    // make every such row DISTINCT in Postgres — NULL != NULL — so an unattributable replay
    // would bypass the claim entirely and re-serve for free. '' dedupes; NULL does not.
    //
    // REVENUE-METER-TRUTH-W4: `DO NOTHING` is LOAD-BEARING for settlement, not just for dedup.
    // A replay must not touch the existing row, because the on-chain scan may since have promoted
    // its settlement_state to SETTLED/OPERATOR. Were this ever changed to DO UPDATE, every replay
    // would silently reset real settled revenue back to CLAIMED_UNSETTLED — un-settling money that
    // did move. That is what makes the forward promotion path durable, and it is pinned by a test.
    //
    // settlement_state is NOT a parameter: a claim is unverified by construction, so the constant is
    // the whole point. Passing it explicitly rather than leaning on the column DEFAULT keeps both
    // backends identical and makes the value greppable from the call site.
    const inserted = await dbQuery<{ nonce: string }>(sql, [
      nonce, tool, amount, payerWallet ?? '', CLAIM_INITIAL_SETTLEMENT_STATE, rail ?? RAIL_UNKNOWN,
    ]);
    // Row returned ⇒ this call won the insert ⇒ first use. Empty ⇒ a genuine replay.
    return inserted.length > 0 ? 'CLAIMED' : 'ALREADY_CLAIMED';
  } catch (err) {
    // OPS-ZERO-VS-UNKNOWN-W3: still REFUSE (architect-ratified — a lost sale is a foregone gain,
    // a double-settle is an irreversible on-chain USDC charge plus a manual refund), but no longer
    // LIE about why. Returning `false` here made a database fault indistinguishable from a settled
    // replay, so the caller answered "already used" and a well-built client — correctly treating
    // that as terminal — never retried. A transient server fault became a permanent client failure.
    //
    // The refusal is now LOUD: counted where a canary can read it, not merely logged. The log line
    // below already existed during the 25-hour outage and was invisible precisely because nothing
    // counted it.
    console.error(
      `[x402-idempotency] tryClaimPayment DB error for nonce=${nonce} tool=${tool} — INDETERMINATE (refusing):`,
      err instanceof Error ? err.message : err,
    );
    recordIndeterminate('x402_claim', 'claim store unreachable — refusing rather than mislabelling as a replay');
    return 'INDETERMINATE';
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

/** A valid EVM address literal (0x + 40 hex). */
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Extract the PAYER WALLET (ERC-3009 `from`) from a verified x402 payment payload
 * (OPS-X402-WALLET-ATTRIBUTION-W1). The buyer signs
 * `transferWithAuthorization(from, to, value, …)`, so the payer's wallet is the SIBLING of the
 * `nonce` we already read (`payload.authorization.from`). Returns the address LOWERCASED
 * (Q4: `0xAbc` and `0xabc` are the same wallet — never double-count on GROUP BY), or
 * `undefined` when absent/malformed (fail-open — the caller writes NULL, never blocks a
 * settle). INTERNAL-ONLY: this address is a distinct-count key + a truncated operator display;
 * it is NEVER surfaced in public copy or a public endpoint.
 */
export function extractPayerWallet(paymentPayload: unknown): string | undefined {
  if (!paymentPayload || typeof paymentPayload !== 'object') return undefined;
  const p = paymentPayload as {
    payload?: {
      authorization?: { from?: unknown };
      permit2Authorization?: { from?: unknown };
    };
    authorization?: { from?: unknown };
    from?: unknown;
  };
  const candidates = [
    p.payload?.authorization?.from,        // EIP-3009 (USDC transferWithAuthorization) — the prod rail
    p.payload?.permit2Authorization?.from, // Permit2 flow (defensive)
    p.authorization?.from,                 // defensive: un-nested authorization
    p.from,                                // defensive: top-level
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && EVM_ADDRESS_RE.test(c)) return c.toLowerCase();
  }
  return undefined;
}
