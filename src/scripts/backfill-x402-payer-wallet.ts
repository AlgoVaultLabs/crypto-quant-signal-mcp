/**
 * backfill-x402-payer-wallet.ts — OPS-X402-WALLET-ATTRIBUTION-W1 R3 (Q3-B).
 *
 * One-shot READ-ONLY on-chain backfill of `processed_x402_payments.payer_wallet` for historical
 * rows (the ERC-3009 `from` was never stored). For each row with `payer_wallet IS NULL`, resolves
 * the payer via the Base USDC `AuthorizationUsed(address indexed authorizer, bytes32 indexed
 * nonce)` log (the nonce is indexed → an exact lookup), and UPDATEs the row. Rows that don't
 * resolve stay NULL = "pre-instrumentation (wallet unknown)".
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

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');
  // Client is created + used ONLY here so its concrete viem type is inferred (viem's generic
  // client types don't survive a cross-function param annotation). The pure, viem-free helpers
  // (isValidAddress / normalizeAuthorizer / estimateBlock) are exported + unit-tested instead.
  const client = createPublicClient({ chain: base, transport: http(BASE_RPC) });
  const headBlock = await client.getBlockNumber();
  const headTs = Number((await client.getBlock({ blockNumber: headBlock })).timestamp);

  const rows = await dbQuery<{ nonce: string; created_at: string | Date }>(
    'SELECT nonce, created_at FROM processed_x402_payments WHERE payer_wallet IS NULL ORDER BY created_at',
    [],
  );
  console.log(`[backfill-x402-payer] ${rows.length} row(s) with NULL payer_wallet · execute=${execute} · rpc=${BASE_RPC}`);

  let filled = 0;
  let unresolved = 0;
  for (const row of rows) {
    const epoch = Math.floor(new Date(row.created_at as string).getTime() / 1000);
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
    const wallet = logs.length ? normalizeAuthorizer(logs[0].args.authorizer) : null;
    if (!wallet) {
      unresolved++;
      console.log(`  ${row.nonce.slice(0, 14)}… UNRESOLVED — left NULL (pre-instrumentation)`);
      continue;
    }
    console.log(`  ${row.nonce.slice(0, 14)}… → ${wallet}${execute ? ' [UPDATED]' : ' [dry-run]'}`);
    if (execute) {
      // Idempotent: only fills a still-NULL row (never overwrites a captured wallet).
      await dbQuery('UPDATE processed_x402_payments SET payer_wallet = ? WHERE nonce = ? AND payer_wallet IS NULL', [wallet, row.nonce]);
    }
    filled++;
  }
  console.log(`[backfill-x402-payer] filled=${filled} unresolved=${unresolved} — ${execute ? 'APPLIED' : 'DRY-RUN (pass --execute to write)'}`);
}

if (require.main === module) {
  void runScript('backfill-x402-payer-wallet', main); // OPS-SCRIPT-EXIT-LIFECYCLE-W1
}
