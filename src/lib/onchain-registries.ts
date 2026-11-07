/**
 * onchain-registries.ts — DECISION-CALL-V2-W5 CH2: the ONE committed table of AlgoVault's on-chain registries.
 *
 * Both rows are deployments of `contracts/MerkleRootRegistry.sol`, unchanged, on Base (chain 8453), owned by the
 * one publisher address, so both publishers share ONE nonce sequence (anchor-batch.ts holds one Postgres advisory
 * lock across them for exactly that reason).
 *
 *   signal       the daily signal batches (`publish-merkle-batch.ts`, since 2026-04). Its publisher still reads
 *                `MERKLE_CONTRACT_ADDRESS` from the environment, and REFUSES to send when that differs from the
 *                row below: an env var that drifted from this table would anchor to a registry nobody verifies.
 *   call-ledger  the daily `pre_trade_check` call ledger (`publish-call-ledger-batch.ts`; Prompt/call-ledger-contract
 *                v1). Its address is NULL until the wave's §9 deploy commits it here, and while it is null the
 *                call-ledger publisher refuses to send — there is no env override, by construction.
 *
 * The pinned hashes are what `deploy-call-ledger-registry.ts` proves a deploy against: the creation code is the
 * signal registry's own deploy-tx input (`merkle-root-registry-creation-code.ts`, beside this file), and the runtime
 * hash is that registry's live `eth_getCode`. Both were re-derived from Base on 2026-11-06 by two parties (Cowork's
 * ruling Q1, and Code's Step-0 probe) and agree.
 */
import type { Hex } from 'viem';

/** Base mainnet. Every registry row lives here; a publisher on any other chain refuses. */
export const BASE_CHAIN_ID = 8453 as const;

/** The publisher EOA: owner of both registries, the only address that can `publishRoot`. */
export const REGISTRY_PUBLISHER: Hex = '0x804b82544e0b779c69192ff5fc64a4c5d1017b80';

export interface RegistryRow {
  readonly name: 'signal' | 'call-ledger';
  readonly chainId: typeof BASE_CHAIN_ID;
  /** Lowercase 0x address, or null before the registry is deployed. */
  readonly address: Hex | null;
  /** The contract-creation transaction, or null before the registry is deployed. */
  readonly deployTx: Hex | null;
}

export const SIGNAL_REGISTRY: RegistryRow = Object.freeze({
  name: 'signal',
  chainId: BASE_CHAIN_ID,
  address: '0x6485396ac981fe0a58540dfbf3e730f6f7bcbf81',
  deployTx: '0x65fe231c5c2c66efd1c0083ed1eca06aab997ca9133477ad1cde5f36f406369b',
});

/** Deployed 2026-11-07 by DECISION-CALL-V2-W5 §9.2 (REGISTRY_DEPLOY_VERDICT=PASS, Base block 54188921, publisher nonce
 *  214; runtime = the signal registry's), committed in §9.3. */
export const CALL_LEDGER_REGISTRY: RegistryRow = Object.freeze({
  name: 'call-ledger',
  chainId: BASE_CHAIN_ID,
  address: '0x5f1cec4f56c274f36233d0e64f527c162b55b240',
  deployTx: '0xb871abd946c83d77274bb2d56bb33c05ee2fa57395737e5d4f8a0a8b2d20f9cc',
});

/** keccak256 of the 1,627-byte creation code (the signal registry's deploy-tx input). */
export const REGISTRY_CREATION_KECCAK: Hex = '0x69dfec69d065e1b020250e13acc6ec0c5ba7cf33741267737ccc1fd7408e47df';
/** keccak256 of the 1,535-byte runtime code (`eth_getCode` of the signal registry). */
export const REGISTRY_RUNTIME_KECCAK: Hex = '0xde489b58e34f8bd850b830277d15450113b98bf57fa244fe498464e41c7c2d43';

/** The registry's full surface (contracts/MerkleRootRegistry.sol). `publishRoot`'s selector is the signal publisher's. */
export const MERKLE_ROOT_REGISTRY_ABI = [
  {
    name: 'publishRoot',
    type: 'function',
    inputs: [
      { name: 'batchId', type: 'uint256' },
      { name: 'root', type: 'bytes32' },
      { name: 'signalCount', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'verifyRoot',
    type: 'function',
    inputs: [{ name: 'batchId', type: 'uint256' }],
    outputs: [
      { name: 'root', type: 'bytes32' },
      { name: 'signalCount', type: 'uint256' },
      { name: 'timestamp', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
  { name: 'latestBatchId', type: 'function', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { name: 'owner', type: 'function', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  {
    name: 'RootPublished',
    type: 'event',
    inputs: [
      { name: 'batchId', type: 'uint256', indexed: true },
      { name: 'root', type: 'bytes32', indexed: false },
      { name: 'signalCount', type: 'uint256', indexed: false },
      { name: 'timestamp', type: 'uint256', indexed: false },
    ],
  },
] as const;

/** Case-insensitive address equality; false when either side is not a 20-byte 0x address. */
export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  const re = /^0x[0-9a-fA-F]{40}$/;
  return typeof a === 'string' && typeof b === 'string' && re.test(a) && re.test(b) && a.toLowerCase() === b.toLowerCase();
}
