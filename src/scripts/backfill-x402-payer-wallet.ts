/**
 * backfill-x402-payer-wallet.ts — OPS-X402-WALLET-ATTRIBUTION-W1 R3 (Q3-B).
 *
 * One-shot READ-ONLY on-chain backfill of `processed_x402_payments.payer_wallet` for historical
 * rows (the ERC-3009 `from` was never stored). For each unattributed row, resolves the payer via
 * the Base USDC `AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)` log (the
 * nonce is indexed → an exact lookup), and UPDATEs the row. Rows that don't resolve are left as-is.
 *
 * Two modes:
 *   (default)    backfill unattributed rows      — the original OPS-X402-WALLET-ATTRIBUTION-W1 job
 *   --classify   classify EVERY row, write nothing — REVENUE-METER-TRUTH-W1 CH2
 *
 * `--classify` exists because a row in this table is a CLAIM, not a payment: `tryClaimPayment`
 * writes it when the buyer presents an authorization, and nothing has ever checked that the
 * authorization was actually used on-chain. `AuthorizationUsed` is that check.
 *
 * ⚠️ The unattributed row is the EMPTY STRING, not NULL. `migrations/024:33` ran
 * `UPDATE … SET payer_wallet = '' WHERE payer_wallet IS NULL` and then `SET NOT NULL` (SEC-49 —
 * under the composite PK `(payer_wallet, nonce)` a NULL makes every unattributable row DISTINCT and
 * lets a replay bypass the claim). So there are ZERO NULLs on prod and the original
 * `WHERE payer_wallet IS NULL` selector matched **nothing** — this job has been a silent no-op
 * since migration 024. _(Widened 2026-08-04 REVENUE-METER-TRUTH-W1 CH2.)_
 *
 * On-chain access is READ-ONLY (`eth_getLogs`); the ONLY write is the DB UPDATE (`--execute`;
 * default is a dry-run). Idempotent — reruns skip already-backfilled rows (WHERE payer_wallet IS
 * NULL). Runs IN the app container (viem + DATABASE_URL + BASE_RPC_URL present):
 *   docker exec <ctr> node /app/dist/scripts/backfill-x402-payer-wallet.js [--execute]
 *
 * mainnet.base.org caps eth_getLogs at a 10,000-block range, so we anchor the search block from
 * the row's `created_at` (settle time ≈ on-chain time) via a head-timestamp 2s estimate and scan
 * a ±RANGE window (< 10k). No web3 WRITE deps (Data-Integrity LAW) — viem read client only.
 */
import { createPublicClient, http, parseAbiItem } from 'viem';
import { runScript } from '../lib/script-lifecycle.js';
import { base } from 'viem/chains';
import { dbQuery } from '../lib/performance-db.js';
import { isOperatorWallet } from '../lib/x402-operator-wallets.js';

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
const AUTHORIZATION_USED = parseAbiItem(
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
);
const BASE_RPC = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const RANGE = 4900n; // ±blocks around the estimate; to-from = 9800 < the 10k getLogs cap

/** A valid EVM address literal (0x + 40 hex). */
export function isValidAddress(a: unknown): a is string {
  return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
}

/** Normalize an authorizer to the lowercased address form used as the distinct-count key. */
export function normalizeAuthorizer(a: unknown): string | null {
  return isValidAddress(a) ? a.toLowerCase() : null;
}

/** Block just-before `targetEpoch`, anchored from the head timestamp (2s block time). */
export function estimateBlock(headBlock: bigint, headTs: number, targetEpoch: number): bigint {
  const est = headBlock - BigInt(Math.floor((headTs - targetEpoch) / 2));
  return est > 0n ? est : 1n;
}

/** REVENUE-METER-TRUTH-W1 CH2 — settlement state of one claim row. */
export type SettlementClass = 'SETTLED' | 'CLAIMED_UNSETTLED' | 'OPERATOR' | 'UNRESOLVABLE';

/**
 * Classify one row from its on-chain `AuthorizationUsed` lookup. Pure — the viem call stays in
 * `main` (viem's client generics don't survive a cross-function annotation), so this is the part
 * that gets unit-tested.
 *
 * `scanOk` is the honest-vs-vacuous distinction and it is the whole reason this is not a boolean:
 * "we looked and found no authorization" (**CLAIMED_UNSETTLED** — the money never moved) and "we
 * could not look" (**UNRESOLVABLE** — RPC error, unusable timestamp) are different facts, and
 * collapsing them would let an RPC outage read as proof that nobody paid.
 */
export function classifySettlement(authorizer: string | null, scanOk: boolean, isOperator: (w: string) => boolean): SettlementClass {
  if (!scanOk) return 'UNRESOLVABLE';
  if (authorizer === null) return 'CLAIMED_UNSETTLED';
  return isOperator(authorizer) ? 'OPERATOR' : 'SETTLED';
}

/**
 * Rows whose payer was never captured: the EMPTY STRING post-migration-024, NULL on older DBs.
 *
 * Exported so it is TESTABLE. The original selector was an untested inline literal
 * (`payer_wallet IS NULL`), and migration 024 turned every NULL into `''` — which silently reduced
 * this whole job to a no-op with no test able to notice. A selector that decides which rows a job
 * can see is load-bearing logic, not a string.
 */
export const UNATTRIBUTED_SQL = "(payer_wallet IS NULL OR trim(payer_wallet) = '')";

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');
  const classify = process.argv.includes('--classify');
  // Client is created + used ONLY here so its concrete viem type is inferred (viem's generic
  // client types don't survive a cross-function param annotation). The pure, viem-free helpers
  // (isValidAddress / normalizeAuthorizer / estimateBlock) are exported + unit-tested instead.
  const client = createPublicClient({ chain: base, transport: http(BASE_RPC) });
  const headBlock = await client.getBlockNumber();
  const headTs = Number((await client.getBlock({ blockNumber: headBlock })).timestamp);

  // --classify reads EVERY row (a claim is not a payment, so an attributed row still needs the
  // on-chain check); the backfill job reads only the unattributed ones.
  const rows = await dbQuery<{ nonce: string; created_at: string | Date; payer_wallet: string | null; tool: string | null; amount: string | null }>(
    `SELECT nonce, created_at, payer_wallet, tool, amount FROM processed_x402_payments${classify ? '' : ` WHERE ${UNATTRIBUTED_SQL}`} ORDER BY created_at`,
    [],
  );
  console.log(`[backfill-x402-payer] ${rows.length} row(s) · mode=${classify ? 'CLASSIFY (read-only)' : 'BACKFILL'} · execute=${execute && !classify} · rpc=${BASE_RPC}`);

  let filled = 0;
  let unresolved = 0;
  const tally: Record<SettlementClass, number> = { SETTLED: 0, CLAIMED_UNSETTLED: 0, OPERATOR: 0, UNRESOLVABLE: 0 };
  for (const row of rows) {
    const epoch = Math.floor(new Date(row.created_at as string).getTime() / 1000);
    let wallet: string | null = null;
    let scanOk = true;
    try {
      if (!Number.isFinite(epoch)) throw new Error('unusable created_at');
      const around = estimateBlock(headBlock, headTs, epoch);
      const fromBlock = around > RANGE ? around - RANGE : 0n;
      const toBlock = around + RANGE;
      const logs = await client.getLogs({
        address: USDC_BASE,
        event: AUTHORIZATION_USED,
        args: { nonce: row.nonce as `0x${string}` },
        fromBlock,
        toBlock,
      });
      wallet = logs.length ? normalizeAuthorizer(logs[0].args.authorizer) : null;
    } catch (err) {
      // Could not look ≠ looked and found nothing. Never let an RPC fault read as "nobody paid".
      scanOk = false;
      console.log(`  ${row.nonce.slice(0, 14)}… SCAN FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (classify) {
      const klass = classifySettlement(wallet, scanOk, isOperatorWallet);
      tally[klass]++;
      const stored = (row.payer_wallet ?? '').trim() || '<unattributed>';
      console.log(`  ${row.nonce.slice(0, 14)}… ${String(row.created_at).slice(0, 19)} ${String(row.tool ?? '-').padEnd(18)} ${String(row.amount ?? '-').padStart(7)} stored=${stored} onchain=${wallet ?? '<none>'} → ${klass}${execute ? ' [PERSISTED]' : ''}`);
      if (execute) {
        // REVENUE-METER-TRUTH-W2 CH3: promote the row to its measured state. This is the ONLY
        // forward path from CLAIMED_UNSETTLED — `tryClaimPayment` cannot know at insert time
        // whether the chain accepted the authorization, so nothing but this scan may write
        // SETTLED/OPERATOR. Keyed on the FULL primary key `(payer_wallet, nonce)`: a bare
        // `WHERE nonce = ?` would be ambiguous under the composite key migration 024 installed.
        // UNRESOLVABLE is deliberately NOT written — a scan we could not run must leave the
        // existing state alone rather than overwrite a known verdict with an unknown one.
        if (klass !== 'UNRESOLVABLE') {
          await dbQuery(
            'UPDATE processed_x402_payments SET settlement_state = ? WHERE nonce = ? AND payer_wallet = ?',
            [klass, row.nonce, row.payer_wallet ?? ''],
          );
        }
      }
      continue;
    }

    if (!wallet) {
      unresolved++;
      console.log(`  ${row.nonce.slice(0, 14)}… UNRESOLVED — left unattributed (pre-instrumentation)`);
      continue;
    }
    console.log(`  ${row.nonce.slice(0, 14)}… → ${wallet}${execute ? ' [UPDATED]' : ' [dry-run]'}`);
    if (execute) {
      // Idempotent: only fills a still-unattributed row (never overwrites a captured wallet).
      await dbQuery(`UPDATE processed_x402_payments SET payer_wallet = ? WHERE nonce = ? AND ${UNATTRIBUTED_SQL}`, [wallet, row.nonce]);
    }
    filled++;
  }

  if (classify) {
    console.log(`[backfill-x402-payer] CLASSIFY tally: SETTLED=${tally.SETTLED} OPERATOR=${tally.OPERATOR} CLAIMED_UNSETTLED=${tally.CLAIMED_UNSETTLED} UNRESOLVABLE=${tally.UNRESOLVABLE} (total=${rows.length})`);
    console.log(`X402_SETTLEMENT_VERDICT=${tally.UNRESOLVABLE > 0 ? 'INDETERMINATE' : 'COMPLETE'}`);
    return;
  }
  console.log(`[backfill-x402-payer] filled=${filled} unresolved=${unresolved} — ${execute ? 'APPLIED' : 'DRY-RUN (pass --execute to write)'}`);
}

if (require.main === module) {
  void runScript('backfill-x402-payer-wallet', main); // OPS-SCRIPT-EXIT-LIFECYCLE-W1
}
