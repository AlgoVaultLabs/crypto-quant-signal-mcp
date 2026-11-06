#!/usr/bin/env tsx
/**
 * deploy-call-ledger-registry.ts — DECISION-CALL-V2-W5 CH2 (Cowork ruling Q1 = A).
 *
 * Deploys the call-ledger `MerkleRootRegistry` on Base, ONCE, from inside the signal-1 app container, where the
 * publisher key already lives (it is read from the container's environment, and never printed, logged or put on
 * a command line):
 *
 *   docker exec crypto-quant-signal-mcp-mcp-server-1 node dist/scripts/deploy-call-ledger-registry.js
 *
 * The bytes deployed are the committed creation code (merkle-root-registry-creation-code.ts): the signal registry's
 * own deploy-tx input, so the new registry's runtime equals the live one's BY CONSTRUCTION, with no compiler in the
 * loop. (`deploy-merkle-contract.ts` needs hardhat, a devDependency the production image does not carry.)
 *
 * REFUSES — FAIL, nothing sent — unless every one of these holds, in this order:
 *   the creation code hashes to REGISTRY_CREATION_KECCAK · the signer IS the publisher (owner of both registries)
 *   · the RPC serves Base (8453) · an `eth_call` of the creation code returns runtime hashing to
 *   REGISTRY_RUNTIME_KECCAK. A publisher tx already in flight is INDETERMINATE (nothing sent).
 *
 * IDEMPOTENT. Before any send it scans every address the publisher has created (CREATE(publisher, 0..nonce-1)) for a
 * contract with the registry's runtime other than the signal registry. If one exists — a previous run that was
 * stopped after its broadcast — it prints that address, checks it the same way, and sends nothing.
 *
 * Output, in order: REGISTRY_DEPLOY_EXPECTED_ADDRESS=<a> nonce=<n> (before the send), REGISTRY_DEPLOY_TX=<hash>
 * (the moment it is broadcast, BEFORE the receipt is awaited — the record a stopped run leaves), then exactly one
 *   REGISTRY_DEPLOY_VERDICT=PASS address=<a> tx=<hash|unknown> block=<n|unknown>
 *   REGISTRY_DEPLOY_VERDICT=FAIL <why>   ·   REGISTRY_DEPLOY_VERDICT=INDETERMINATE <why>
 * PASS also asserts, on chain: the runtime hash, owner() = the publisher, latestBatchId() = 0. Exit 0 / 1 / 3.
 */
import { createPublicClient, createWalletClient, getContractAddress, http, keccak256, type Hex } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { MERKLE_ROOT_REGISTRY_CREATION_CODE } from '../lib/merkle-root-registry-creation-code.js';
import {
  BASE_CHAIN_ID,
  MERKLE_ROOT_REGISTRY_ABI,
  REGISTRY_CREATION_KECCAK,
  REGISTRY_PUBLISHER,
  REGISTRY_RUNTIME_KECCAK,
  SIGNAL_REGISTRY,
  sameAddress,
} from '../lib/onchain-registries.js';
import { runScript } from '../lib/script-lifecycle.js';

type Verdict = 'PASS' | 'FAIL' | 'INDETERMINATE';
const EXIT: Record<Verdict, number> = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };

/** The slice of a viem PublicClient the deploy reads. A test passes a fake with this shape. */
export interface DeployPublicClient {
  getChainId(): Promise<number>;
  getTransactionCount(args: { address: Hex; blockTag: 'latest' | 'pending' }): Promise<number>;
  getCode(args: { address: Hex }): Promise<Hex | undefined>;
  call(args: { account: Hex; data: Hex }): Promise<{ data?: Hex }>;
  readContract(args: { address: Hex; abi: typeof MERKLE_ROOT_REGISTRY_ABI; functionName: 'owner' | 'latestBatchId' }): Promise<unknown>;
  waitForTransactionReceipt(args: { hash: Hex; timeout: number }): Promise<{ status: 'success' | 'reverted'; contractAddress?: Hex | null; blockNumber: bigint }>;
}

export interface DeployWalletClient {
  sendTransaction(args: { data: Hex }): Promise<Hex>;
}

export interface DeployIo {
  publicClient: DeployPublicClient;
  walletClient: DeployWalletClient;
  /** The signer's address (derived from the key by the caller). */
  signer: Hex;
  log: (line: string) => void;
}

/** CREATE addresses are scanned this many at a time. */
const SCAN_CHUNK = 20;
const RECEIPT_TIMEOUT_MS = 300_000;

const hashOf = (code: Hex | undefined): Hex | null => (code && code !== '0x' ? keccak256(code) : null);

/** Assert a deployed registry: runtime, owner and an untouched batch counter. Returns the reason it fails, or null. */
async function checkDeployed(pc: DeployPublicClient, address: Hex): Promise<string | null> {
  const runtime = hashOf(await pc.getCode({ address }));
  if (runtime !== REGISTRY_RUNTIME_KECCAK) return `the runtime at ${address} hashes to ${runtime ?? 'nothing'}, not ${REGISTRY_RUNTIME_KECCAK}`;
  const owner = await pc.readContract({ address, abi: MERKLE_ROOT_REGISTRY_ABI, functionName: 'owner' });
  if (!sameAddress(String(owner), REGISTRY_PUBLISHER)) return `owner() of ${address} is ${String(owner)}, not the publisher ${REGISTRY_PUBLISHER}`;
  const latest = await pc.readContract({ address, abi: MERKLE_ROOT_REGISTRY_ABI, functionName: 'latestBatchId' });
  if (latest !== 0n) return `latestBatchId() of ${address} is ${String(latest)}, not 0 — this registry is already in use`;
  return null;
}

/** The deploy itself: returns the verdict line (without the token prefix) and prints the progress lines. */
export async function deployCallLedgerRegistry(io: DeployIo): Promise<{ verdict: Verdict; detail: string }> {
  const { publicClient: pc, walletClient: wc, log } = io;
  const fail = (detail: string) => ({ verdict: 'FAIL' as const, detail });
  const undecided = (detail: string) => ({ verdict: 'INDETERMINATE' as const, detail });

  // 1. The bytes, the signer, the chain.
  const creation = keccak256(MERKLE_ROOT_REGISTRY_CREATION_CODE);
  if (creation !== REGISTRY_CREATION_KECCAK) return fail(`the committed creation code hashes to ${creation}, not ${REGISTRY_CREATION_KECCAK}`);
  if (!sameAddress(io.signer, REGISTRY_PUBLISHER)) return fail(`the signer ${io.signer} is not the publisher ${REGISTRY_PUBLISHER}`);
  const chainId = await pc.getChainId();
  if (chainId !== BASE_CHAIN_ID) return fail(`the RPC serves chain ${chainId}, not Base (${BASE_CHAIN_ID})`);

  // 2. No tx in flight, then the CREATE scan: a registry this publisher already deployed is reused, never doubled.
  const [latest, pending] = await Promise.all([
    pc.getTransactionCount({ address: REGISTRY_PUBLISHER, blockTag: 'latest' }),
    pc.getTransactionCount({ address: REGISTRY_PUBLISHER, blockTag: 'pending' }),
  ]);
  if (pending > latest) return undecided(`a publisher tx is in flight (pending nonce ${pending} > latest ${latest}) — nothing sent`);
  const found: Hex[] = [];
  for (let start = 0; start < latest; start += SCAN_CHUNK) {
    const nonces = Array.from({ length: Math.min(SCAN_CHUNK, latest - start) }, (_, i) => start + i);
    const codes = await Promise.all(
      nonces.map(async (nonce) => {
        const address = getContractAddress({ from: REGISTRY_PUBLISHER, nonce: BigInt(nonce) }).toLowerCase() as Hex;
        return { address, runtime: hashOf(await pc.getCode({ address })) };
      }),
    );
    for (const c of codes) {
      if (c.runtime === REGISTRY_RUNTIME_KECCAK && !sameAddress(c.address, SIGNAL_REGISTRY.address)) found.push(c.address);
    }
  }
  log(`REGISTRY_DEPLOY_SCAN nonces=0..${latest - 1} scanned=${latest} registries_besides_signal=${found.length}`);
  if (found.length > 1) return fail(`the publisher already created ${found.length} registries besides the signal one (${found.join(', ')}) — resolve by hand`);
  if (found.length === 1) {
    const why = await checkDeployed(pc, found[0]);
    if (why !== null) return fail(why);
    return { verdict: 'PASS', detail: `address=${found[0]} tx=unknown block=unknown (already deployed — found by the CREATE scan; nothing sent)` };
  }

  // 3. The dry run: executing the creation code must return exactly the live registry's runtime.
  const dry = await pc.call({ account: REGISTRY_PUBLISHER, data: MERKLE_ROOT_REGISTRY_CREATION_CODE });
  const dryRuntime = hashOf(dry.data);
  if (dryRuntime !== REGISTRY_RUNTIME_KECCAK) return fail(`the eth_call dry run returns runtime hashing to ${dryRuntime ?? 'nothing'}, not ${REGISTRY_RUNTIME_KECCAK} — nothing sent`);

  // 4. Send — and print the hash at once, before the receipt is awaited.
  const expected = getContractAddress({ from: REGISTRY_PUBLISHER, nonce: BigInt(latest) }).toLowerCase() as Hex;
  log(`REGISTRY_DEPLOY_EXPECTED_ADDRESS=${expected} nonce=${latest}`);
  const tx = await wc.sendTransaction({ data: MERKLE_ROOT_REGISTRY_CREATION_CODE });
  log(`REGISTRY_DEPLOY_TX=${tx}`);

  // 5. The receipt, then the deployed registry itself.
  const rc = await pc.waitForTransactionReceipt({ hash: tx, timeout: RECEIPT_TIMEOUT_MS });
  if (rc.status !== 'success') return fail(`tx ${tx} reverted in block ${rc.blockNumber}`);
  if (!sameAddress(rc.contractAddress ?? null, expected)) return fail(`tx ${tx} created ${rc.contractAddress ?? 'nothing'}, not the expected ${expected}`);
  const why = await checkDeployed(pc, expected);
  if (why !== null) return fail(why);
  return { verdict: 'PASS', detail: `address=${expected} tx=${tx} block=${rc.blockNumber}` };
}

/** The CLI body. RETURNS the exit code — runScript takes it only from here. */
export async function main(env: NodeJS.ProcessEnv = process.env, io?: DeployIo): Promise<number> {
  const log = io?.log ?? ((line: string) => console.log(line));
  let deps = io;
  if (!deps) {
    const raw = env.MERKLE_PUBLISHER_KEY;
    if (!raw) {
      log('REGISTRY_DEPLOY_VERDICT=INDETERMINATE MERKLE_PUBLISHER_KEY is not set in this environment — nothing sent');
      return EXIT.INDETERMINATE;
    }
    const account = privateKeyToAccount((raw.startsWith('0x') ? raw : `0x${raw}`) as Hex);
    const rpc = env.BASE_RPC_URL || 'https://mainnet.base.org';
    deps = {
      // Cast to the slices above: viem's generic signatures are wider than what the deploy calls.
      publicClient: createPublicClient({ chain: base, transport: http(rpc) }) as unknown as DeployPublicClient,
      walletClient: createWalletClient({ chain: base, transport: http(rpc), account }) as unknown as DeployWalletClient,
      signer: account.address,
      log,
    };
  }
  let r: { verdict: Verdict; detail: string };
  try {
    r = await deployCallLedgerRegistry(deps);
  } catch (e) {
    r = { verdict: 'INDETERMINATE', detail: `stopped on an error (if REGISTRY_DEPLOY_TX was printed, re-run: the CREATE scan finds it) — ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`.slice(0, 400) };
  }
  log(`REGISTRY_DEPLOY_VERDICT=${r.verdict} ${r.detail}`);
  return EXIT[r.verdict];
}

// require.main guard (CJS, target ES2022).
if (require.main === module) {
  void runScript('deploy-call-ledger-registry', () => main(), { watchdogMs: 10 * 60_000 });
}
