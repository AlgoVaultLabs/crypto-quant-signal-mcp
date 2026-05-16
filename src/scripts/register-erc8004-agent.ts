#!/usr/bin/env tsx
/**
 * register-erc8004-agent.ts — One-time mint or canonical-URI update of
 * AlgoVault's ERC-8004 agent identity on Base mainnet.
 *
 * Two modes:
 *
 * (1) MINT mode (default): fresh registration on Identity Registry.
 *     a. Idempotency check: ERC8004_AGENT_ID set → log + exit 0 (no RPC).
 *     b. PRE_MINT canary: balanceOf(owner) == 0 → proceed; else HALT.
 *     c. Pin v1 JSON to IPFS (registrations[].agentId = 'pending-mint').
 *     d. register(ipfs://<v1-CID>) → parse agentId from Transfer event.
 *     e. Pin v2 JSON to IPFS (registrations[].agentId = <minted>).
 *     f. setAgentURI(agentId, ipfs://<v2-CID>).
 *
 * (2) UPDATE-URI mode (--update-uri): adopt an existing agentId and update
 *     its on-chain tokenURI to canonical Amendment-B shape. Use case:
 *     ERC-8004-W1 discovered an earlier non-canonical mint by archived
 *     molthunt-launch.ts under the same wallet (agentId 44544 minted
 *     2026-04-13 with molthunt-shape data: URI).
 *     a. Require ERC8004_AGENT_ID env (operator-supplied).
 *     b. Verify ownerOf(agentId) == account.address (sanity).
 *     c. Read prior on-chain tokenURI (audit trail).
 *     d. Pin v2 canonical JSON to IPFS.
 *     e. setAgentURI(agentId, ipfs://<v2-CID>).
 *     Skips PRE_MINT canary; skips "already registered" exit (the env var
 *     IS the opt-in trigger in this mode).
 *
 * Persistence (both modes):
 *   - ~/.config/algovault/erc8004.env (mode 600) — env-pinned ERC8004_AGENT_ID
 *     + ERC8004_REGISTRATION_TX_HASH + ERC8004_FIRST_REGISTERED_AT.
 *   - <repo>/audits/erc-8004-registration-<YYYY-MM-DD>.json (committed) —
 *     full audit trail (no private keys ever written).
 *
 * Required env (both modes):
 *   ERC8004_AGENT_OWNER_KEY  hex (with or without 0x prefix). For ERC-8004-W1
 *                            post-architect-pivot: same value as
 *                            MERKLE_PUBLISHER_KEY (Wallet A).
 *   IPFS_PINNING_PROVIDER    'pinata' (only provider implemented).
 *   IPFS_PINNING_TOKEN       Pinata JWT (https://app.pinata.cloud/keys).
 *
 * Required env (--update-uri mode only):
 *   ERC8004_AGENT_ID         existing tokenId to adopt.
 *
 * Optional env:
 *   BASE_RPC_URL                  default 'https://mainnet.base.org'.
 *   ERC8004_FIRST_REGISTERED_AT   UTC ISO timestamp of original mint
 *                                 (default: now). For --update-uri mode,
 *                                 supply the historical block timestamp.
 *   ERC8004_ORIGINAL_TX_HASH      audit-trail field for --update-uri mode.
 *
 * CLI flags:
 *   --dry-run     Build JSON + show plan; no IPFS pin, no on-chain tx.
 *   --update-uri  Adopt + update existing agentId (see mode 2 above).
 */

import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

import { createPublicClient, createWalletClient, http } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

import {
  IDENTITY_REGISTRY_ADDRESS,
  IDENTITY_REGISTRY_ABI,
  ERC721_TRANSFER_TOPIC,
  getBaseRpcUrl,
  normalizePrivateKey,
} from '../lib/erc8004.js';
import {
  buildRegistrationJson,
  type RegistrationJson,
} from '../lib/erc8004-registration-json.js';

function ts(): string {
  return new Date().toISOString();
}

function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function fail(msg: string, code = 1): never {
  console.error(`[${ts()}] ${msg}`);
  process.exit(code);
}

const ENV_PIN_PATH = join(homedir(), '.config', 'algovault', 'erc8004.env');
// CJS build target — use __dirname (per CLAUDE.md build rule). Compiled file
// lives at dist/scripts/register-erc8004-agent.js; repo root is two parents up.
const REPO_ROOT = resolve(__dirname, '..', '..');
const AUDIT_DIR = join(REPO_ROOT, 'audits');

interface PinataResponse {
  IpfsHash: string;
  PinSize: number;
  Timestamp: string;
}

async function pinJsonToIpfs(
  doc: RegistrationJson,
  label: string,
): Promise<string> {
  const provider = (process.env.IPFS_PINNING_PROVIDER || '').toLowerCase();
  const token = process.env.IPFS_PINNING_TOKEN;
  if (provider !== 'pinata') {
    fail(
      `IPFS_PINNING_PROVIDER must be 'pinata' (got '${provider || '<unset>'}'). Storacha is a future wave.`,
    );
  }
  if (!token) {
    fail('IPFS_PINNING_TOKEN unset (Pinata JWT). Mint aborted before any tx.');
  }
  const res = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      pinataContent: doc,
      pinataMetadata: { name: `algovault-erc-8004-registration-${label}` },
      pinataOptions: { cidVersion: 1 },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    fail(`Pinata pin failed: HTTP ${res.status} ${body.slice(0, 240)}`);
  }
  const json = (await res.json()) as PinataResponse;
  if (!json.IpfsHash) fail(`Pinata response missing IpfsHash: ${JSON.stringify(json).slice(0, 240)}`);
  console.log(`[${ts()}] Pinned ${label} JSON to IPFS: ${json.IpfsHash} (${json.PinSize} bytes)`);
  return json.IpfsHash;
}

async function preMintIdempotencyCheck(updateUriMode: boolean): Promise<void> {
  if (updateUriMode) return; // env var is the OPT-IN trigger in update-uri mode
  if (process.env.ERC8004_AGENT_ID) {
    console.log(
      `[${ts()}] Already registered (ERC8004_AGENT_ID=${process.env.ERC8004_AGENT_ID}), skipping`,
    );
    process.exit(0);
  }
}

// Loose `publicClient: any` because viem's chain-bound client type can't be
// passed cleanly across function boundaries without TS7056-class generic
// blowups. Function body uses `readContract` only, with the strongly-typed
// IDENTITY_REGISTRY_ABI providing the call-site safety.
async function preMintBalanceCanary(
  ownerAddress: `0x${string}`,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publicClient: any,
): Promise<void> {
  const balance = (await publicClient.readContract({
    address: IDENTITY_REGISTRY_ADDRESS,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: 'balanceOf',
    args: [ownerAddress],
  })) as bigint;
  if (balance === 0n) return;
  console.error(
    `[${ts()}] PRE_MINT_BALANCE_NONZERO: owner ${ownerAddress} already holds ${balance} agentId NFT(s).`,
  );
  console.error(
    `[${ts()}] Investigate via Transfer-event scan:`,
  );
  console.error(
    `  cast logs --address ${IDENTITY_REGISTRY_ADDRESS} \\\n    --from-block 0 --to-block latest \\\n    --topic ${ERC721_TRANSFER_TOPIC} \\\n    --topic 0x0000000000000000000000000000000000000000000000000000000000000000 \\\n    --topic 0x000000000000000000000000${ownerAddress.slice(2).toLowerCase()} \\\n    --rpc-url ${process.env.BASE_RPC_URL || 'https://mainnet.base.org'}`,
  );
  console.error(
    `[${ts()}] If intentional re-use, set ERC8004_AGENT_ID to existing token id and re-run.`,
  );
  process.exit(2);
}

function parseAgentIdFromReceipt(
  logs: { topics: readonly `0x${string}`[]; address: `0x${string}` }[],
): bigint {
  const transfer = logs.find(
    (l) =>
      l.address.toLowerCase() === IDENTITY_REGISTRY_ADDRESS.toLowerCase() &&
      l.topics[0] === ERC721_TRANSFER_TOPIC,
  );
  if (!transfer || !transfer.topics[3]) {
    fail('Transfer event not found in mint receipt logs');
  }
  return BigInt(transfer.topics[3]);
}

function persistEnvPin(
  agentId: string,
  registrationTxHash: string,
  firstRegisteredAt: string,
): void {
  mkdirSync(dirname(ENV_PIN_PATH), { recursive: true });
  const body = [
    '# AlgoVault ERC-8004 agent identity — auto-written by register-erc8004-agent.ts',
    '# Source via: set -a; . ~/.config/algovault/erc8004.env; set +a',
    `ERC8004_AGENT_ID=${agentId}`,
    `ERC8004_REGISTRATION_TX_HASH=${registrationTxHash}`,
    `ERC8004_FIRST_REGISTERED_AT=${firstRegisteredAt}`,
    '',
  ].join('\n');
  writeFileSync(ENV_PIN_PATH, body);
  chmodSync(ENV_PIN_PATH, 0o600);
  console.log(`[${ts()}] Pinned agentId to ${ENV_PIN_PATH} (mode 600)`);
}

interface AuditPayload {
  mode: 'mint' | 'update-uri-adopt';
  agentId: string;
  agent_registry_caip10: string;
  identity_registry_address: string;
  owner_address: string;
  base_chain_id: number;
  v1_ipfs_cid: string | null;
  v2_ipfs_cid: string;
  registration_tx_hash: string | null;
  registration_block_number: string | null;
  set_agent_uri_tx_hash: string;
  set_agent_uri_block_number: string;
  prior_token_uri: string | null;
  registration_json_v2: RegistrationJson;
  basescan_token_url: string;
  first_registered_at: string;
  recorded_at: string;
}

function writeAuditJson(payload: AuditPayload): string {
  mkdirSync(AUDIT_DIR, { recursive: true });
  const path = join(AUDIT_DIR, `erc-8004-registration-${utcDate()}.json`);
  writeFileSync(path, JSON.stringify(payload, null, 2) + '\n');
  console.log(`[${ts()}] Wrote audit JSON: ${path}`);
  return path;
}

async function runMint(
  dryRun: boolean,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publicClient: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  walletClient: any,
  account: ReturnType<typeof privateKeyToAccount>,
): Promise<void> {
  if (!dryRun) {
    await preMintBalanceCanary(account.address, publicClient);
  }

  const firstRegisteredAt = new Date().toISOString();
  const v1 = buildRegistrationJson({ agentId: 'pending-mint', firstRegisteredAt });

  if (dryRun) {
    console.log(`[${ts()}] --dry-run: would pin + mint registration JSON:`);
    console.log(JSON.stringify(v1, null, 2));
    return;
  }

  const v1Cid = await pinJsonToIpfs(v1, 'v1');
  const v1Uri = `ipfs://${v1Cid}`;

  console.log(`[${ts()}] Calling register("${v1Uri}") on Identity Registry...`);
  const mintHash = await walletClient.writeContract({
    chain: walletClient.chain,
    account,
    address: IDENTITY_REGISTRY_ADDRESS,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: 'register',
    args: [v1Uri],
  });
  console.log(`[${ts()}] Mint tx submitted: ${mintHash}`);

  const mintReceipt = await publicClient.waitForTransactionReceipt({
    hash: mintHash,
    confirmations: 2,
  });
  if (mintReceipt.status !== 'success') {
    fail(`Mint reverted on-chain. Tx: ${mintHash}`);
  }
  const agentId = parseAgentIdFromReceipt(
    mintReceipt.logs.map((l: { topics: readonly string[]; address: string }) => ({
      topics: l.topics as readonly `0x${string}`[],
      address: l.address as `0x${string}`,
    })),
  );
  console.log(
    `[${ts()}] Minted agentId=${agentId} block=${mintReceipt.blockNumber} tx=${mintHash}`,
  );

  const v2 = buildRegistrationJson({
    agentId: agentId.toString(),
    firstRegisteredAt,
  });
  const v2Cid = await pinJsonToIpfs(v2, 'v2');
  const v2Uri = `ipfs://${v2Cid}`;

  console.log(`[${ts()}] Calling setAgentURI(${agentId}, "${v2Uri}")...`);
  const updateHash = await walletClient.writeContract({
    chain: walletClient.chain,
    account,
    address: IDENTITY_REGISTRY_ADDRESS,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: 'setAgentURI',
    args: [agentId, v2Uri],
  });
  const updateReceipt = await publicClient.waitForTransactionReceipt({
    hash: updateHash,
    confirmations: 2,
  });
  if (updateReceipt.status !== 'success') {
    fail(`setAgentURI reverted on-chain. Tx: ${updateHash}`);
  }
  console.log(
    `[${ts()}] setAgentURI confirmed block=${updateReceipt.blockNumber} tx=${updateHash}`,
  );

  const audit: AuditPayload = {
    mode: 'mint',
    agentId: agentId.toString(),
    agent_registry_caip10: `eip155:8453:${IDENTITY_REGISTRY_ADDRESS}`,
    identity_registry_address: IDENTITY_REGISTRY_ADDRESS,
    owner_address: account.address,
    base_chain_id: 8453,
    v1_ipfs_cid: v1Cid,
    v2_ipfs_cid: v2Cid,
    registration_tx_hash: mintHash,
    registration_block_number: mintReceipt.blockNumber.toString(),
    set_agent_uri_tx_hash: updateHash,
    set_agent_uri_block_number: updateReceipt.blockNumber.toString(),
    prior_token_uri: null,
    registration_json_v2: v2,
    basescan_token_url: `https://basescan.org/token/${IDENTITY_REGISTRY_ADDRESS}?a=${agentId}`,
    first_registered_at: firstRegisteredAt,
    recorded_at: ts(),
  };
  writeAuditJson(audit);
  persistEnvPin(agentId.toString(), mintHash, firstRegisteredAt);

  console.log('');
  console.log(`[${ts()}] DONE. agentId=${agentId}`);
  console.log(`  basescan: ${audit.basescan_token_url}`);
  console.log(`  v2 tokenURI: ${v2Uri}`);
  console.log(`  Source the env-pin and re-run to confirm idempotency:`);
  console.log(`    set -a; . ${ENV_PIN_PATH}; set +a`);
  console.log(`    npx tsx src/scripts/register-erc8004-agent.ts`);
}

async function runUpdateUri(
  dryRun: boolean,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publicClient: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  walletClient: any,
  account: ReturnType<typeof privateKeyToAccount>,
): Promise<void> {
  const agentIdStr = process.env.ERC8004_AGENT_ID;
  if (!agentIdStr) {
    fail('--update-uri requires ERC8004_AGENT_ID env to identify the existing agentId.');
  }
  const agentId = BigInt(agentIdStr);
  const firstRegisteredAt =
    process.env.ERC8004_FIRST_REGISTERED_AT || new Date().toISOString();
  const originalTxHash = process.env.ERC8004_ORIGINAL_TX_HASH || null;
  console.log(`[${ts()}] update-uri mode: adopting agentId=${agentId}`);
  console.log(`[${ts()}] first_registered_at: ${firstRegisteredAt}`);

  // Sanity: confirm we own the token before attempting setAgentURI.
  const owner = (await publicClient.readContract({
    address: IDENTITY_REGISTRY_ADDRESS,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: 'ownerOf',
    args: [agentId],
  })) as `0x${string}`;
  if (owner.toLowerCase() !== account.address.toLowerCase()) {
    fail(
      `OWNERSHIP_MISMATCH: agentId ${agentId} is owned by ${owner}, but ERC8004_AGENT_OWNER_KEY derives address ${account.address}. Abort.`,
    );
  }
  console.log(`[${ts()}] ownerOf(${agentId}) = ${owner} ✓ matches our wallet`);

  // Record prior URI for audit lineage (Data Integrity — never silently overwrite).
  const priorUri = (await publicClient.readContract({
    address: IDENTITY_REGISTRY_ADDRESS,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: 'tokenURI',
    args: [agentId],
  })) as string;
  console.log(`[${ts()}] prior tokenURI (first 100 chars): ${priorUri.slice(0, 100)}…`);

  const v2 = buildRegistrationJson({
    agentId: agentId.toString(),
    firstRegisteredAt,
  });

  if (dryRun) {
    console.log(`[${ts()}] --dry-run --update-uri: would pin + setAgentURI with:`);
    console.log(JSON.stringify(v2, null, 2));
    return;
  }

  const v2Cid = await pinJsonToIpfs(v2, 'v2');
  const v2Uri = `ipfs://${v2Cid}`;

  console.log(`[${ts()}] Calling setAgentURI(${agentId}, "${v2Uri}")...`);
  const updateHash = await walletClient.writeContract({
    chain: walletClient.chain,
    account,
    address: IDENTITY_REGISTRY_ADDRESS,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: 'setAgentURI',
    args: [agentId, v2Uri],
  });
  const updateReceipt = await publicClient.waitForTransactionReceipt({
    hash: updateHash,
    confirmations: 2,
  });
  if (updateReceipt.status !== 'success') {
    fail(`setAgentURI reverted on-chain. Tx: ${updateHash}`);
  }
  console.log(
    `[${ts()}] setAgentURI confirmed block=${updateReceipt.blockNumber} tx=${updateHash}`,
  );

  const audit: AuditPayload = {
    mode: 'update-uri-adopt',
    agentId: agentId.toString(),
    agent_registry_caip10: `eip155:8453:${IDENTITY_REGISTRY_ADDRESS}`,
    identity_registry_address: IDENTITY_REGISTRY_ADDRESS,
    owner_address: account.address,
    base_chain_id: 8453,
    v1_ipfs_cid: null,
    v2_ipfs_cid: v2Cid,
    registration_tx_hash: originalTxHash,
    registration_block_number: null,
    set_agent_uri_tx_hash: updateHash,
    set_agent_uri_block_number: updateReceipt.blockNumber.toString(),
    prior_token_uri: priorUri,
    registration_json_v2: v2,
    basescan_token_url: `https://basescan.org/token/${IDENTITY_REGISTRY_ADDRESS}?a=${agentId}`,
    first_registered_at: firstRegisteredAt,
    recorded_at: ts(),
  };
  writeAuditJson(audit);
  persistEnvPin(
    agentId.toString(),
    originalTxHash || updateHash,
    firstRegisteredAt,
  );

  console.log('');
  console.log(`[${ts()}] DONE. agentId=${agentId} (URI updated to canonical Amendment-B shape)`);
  console.log(`  basescan: ${audit.basescan_token_url}`);
  console.log(`  v2 tokenURI: ${v2Uri}`);
  console.log(`  Source the env-pin and re-run to confirm idempotency (without --update-uri):`);
  console.log(`    set -a; . ${ENV_PIN_PATH}; set +a`);
  console.log(`    npx tsx src/scripts/register-erc8004-agent.ts`);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const updateUriMode = process.argv.includes('--update-uri');

  await preMintIdempotencyCheck(updateUriMode);

  const ownerKey = process.env.ERC8004_AGENT_OWNER_KEY;
  if (!ownerKey) fail('ERC8004_AGENT_OWNER_KEY unset. See .env.example.');

  const rpcUrl = getBaseRpcUrl();
  const account = privateKeyToAccount(normalizePrivateKey(ownerKey));
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: base, transport });
  const walletClient = createWalletClient({ chain: base, account, transport });
  console.log(
    `[${ts()}] Owner wallet: ${account.address} · RPC: ${rpcUrl} · mode: ${updateUriMode ? 'update-uri' : 'mint'}${dryRun ? ' (dry-run)' : ''}`,
  );

  if (updateUriMode) {
    await runUpdateUri(dryRun, publicClient, walletClient, account);
  } else {
    await runMint(dryRun, publicClient, walletClient, account);
  }
}

main().catch((err) => {
  console.error(`[${ts()}] Fatal:`, err);
  process.exit(1);
});
