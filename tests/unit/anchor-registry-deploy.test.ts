/**
 * DECISION-CALL-V2-W5 CH2 — the call-ledger registry's deploy (Cowork ruling Q1 = A), offline.
 *
 * The pins: the committed creation code hashes to Cowork's re-derived value; the runtime it deploys is its own
 * 1,535-byte tail (solc copies it with CODECOPY: no immutables, no constructor args) and hashes to the pinned
 * runtime; every ABI function the publishers call is a selector IN that runtime; the signal registry is the
 * publisher's first contract. No RPC: every number here is derived from committed bytes.
 *
 * The deploy: each refusal sends nothing; the CREATE scan reuses a registry a stopped run already deployed (never
 * a second one); the tx hash is printed BEFORE the receipt is awaited; PASS is earned on chain (runtime, owner,
 * latestBatchId = 0). And `main` never prints the key.
 */
import { describe, it, expect, vi } from 'vitest';
import { getContractAddress, keccak256, size, slice, toEventSelector, toFunctionSelector, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const rpc = vi.hoisted(() => ({ requests: [] as string[] }));
// `main` builds real viem clients; the transport is a node that records every request and answers none.
vi.mock('viem', async (orig) => {
  const m = await orig<typeof import('viem')>();
  return {
    ...m,
    http: () => m.custom({ request: async (a: { method: string }) => { rpc.requests.push(a.method); throw new Error(`no network in tests (${a.method})`); } }),
  };
});

import { MERKLE_ROOT_REGISTRY_CREATION_CODE as CREATION } from '../../src/lib/merkle-root-registry-creation-code.js';
import {
  BASE_CHAIN_ID,
  CALL_LEDGER_REGISTRY,
  MERKLE_ROOT_REGISTRY_ABI,
  REGISTRY_CREATION_KECCAK,
  REGISTRY_PUBLISHER,
  REGISTRY_RUNTIME_KECCAK,
  SIGNAL_REGISTRY,
  sameAddress,
} from '../../src/lib/onchain-registries.js';
import { deployCallLedgerRegistry, main, type DeployIo, type DeployPublicClient, type DeployWalletClient } from '../../src/scripts/deploy-call-ledger-registry.js';

/** Cowork's ruling Q1, re-derived from Base on 2026-11-06 — literal here so a drift in onchain-registries.ts is red. */
const COWORK_CREATION_KECCAK = '0x69dfec69d065e1b020250e13acc6ec0c5ba7cf33741267737ccc1fd7408e47df';
const COWORK_RUNTIME_KECCAK = '0xde489b58e34f8bd850b830277d15450113b98bf57fa244fe498464e41c7c2d43';
const INIT_BYTES = 92;
const RUNTIME = slice(CREATION, INIT_BYTES);
const OTHER_RUNTIME = '0x6080604052600080fd' as Hex;
const TX = `0x${'7d'.repeat(32)}` as Hex;
const create = (nonce: number) => getContractAddress({ from: REGISTRY_PUBLISHER, nonce: BigInt(nonce) }).toLowerCase() as Hex;

// ── the pins ────────────────────────────────────────────────────────────────────────────────────

describe('the committed bytes are the deployed registry', () => {
  it('the creation code hashes to the pin, and the pin is Cowork’s', () => {
    expect(size(CREATION)).toBe(1627);
    expect(keccak256(CREATION)).toBe(REGISTRY_CREATION_KECCAK);
    expect(REGISTRY_CREATION_KECCAK).toBe(COWORK_CREATION_KECCAK);
  });

  it('the runtime it deploys is its own 1,535-byte tail, hashing to the runtime pin (Cowork’s)', () => {
    expect(size(RUNTIME)).toBe(1535);
    expect(RUNTIME.startsWith('0x6080604052')).toBe(true); // solc's preamble: the runtime starts here
    expect(keccak256(RUNTIME)).toBe(REGISTRY_RUNTIME_KECCAK);
    expect(REGISTRY_RUNTIME_KECCAK).toBe(COWORK_RUNTIME_KECCAK);
  });

  it('every function in the ABI is a selector the runtime dispatches, and RootPublished is its event', () => {
    const fns = MERKLE_ROOT_REGISTRY_ABI.filter((i) => i.type === 'function');
    expect(fns.map((f) => f.name).sort()).toEqual(['latestBatchId', 'owner', 'publishRoot', 'verifyRoot']);
    for (const f of fns) expect(RUNTIME, f.name).toContain(`63${toFunctionSelector(f).slice(2)}`); // PUSH4 <selector>
    const ev = MERKLE_ROOT_REGISTRY_ABI.find((i) => i.type === 'event')!;
    expect(RUNTIME).toContain(`7f${toEventSelector(ev).slice(2)}`); // PUSH32 <topic0>
  });

  it('the signal registry is the publisher’s first contract — CREATE(publisher, 0)', () => {
    expect(create(0)).toBe(SIGNAL_REGISTRY.address);
    expect(SIGNAL_REGISTRY.chainId).toBe(BASE_CHAIN_ID);
  });

  it('the call-ledger row is empty until §9.3 commits it, and then names a contract this publisher created', () => {
    if (CALL_LEDGER_REGISTRY.address === null) {
      expect(CALL_LEDGER_REGISTRY.deployTx).toBeNull();
      return;
    }
    expect(CALL_LEDGER_REGISTRY.deployTx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(CALL_LEDGER_REGISTRY.address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(sameAddress(CALL_LEDGER_REGISTRY.address, SIGNAL_REGISTRY.address)).toBe(false);
    expect(Array.from({ length: 10_000 }, (_, n) => n).some((n) => create(n) === CALL_LEDGER_REGISTRY.address)).toBe(true);
  });
});

// ── the deploy ──────────────────────────────────────────────────────────────────────────────────

/** A Base node seen through the deploy's two client slices. `events` records the order of what happened. */
class FakeDeployNode implements DeployPublicClient, DeployWalletClient {
  chain = 8453;
  latest = 5;
  pending = 5;
  readonly codes = new Map<string, Hex>();
  readonly owners = new Map<string, Hex>();
  readonly batchIds = new Map<string, bigint>();
  readonly getCodeCalls: string[] = [];
  readonly sends: Hex[] = [];
  readonly events: string[] = [];
  dryRuntime: Hex = RUNTIME;
  /** What the broadcast tx creates when it is mined. */
  mined: { status: 'success' | 'reverted'; at: 'expected' | Hex | null; runtime: Hex; owner: Hex; latestBatchId: bigint } = {
    status: 'success', at: 'expected', runtime: RUNTIME, owner: REGISTRY_PUBLISHER, latestBatchId: 0n,
  };
  receiptThrows = false;

  constructor() {
    this.install(SIGNAL_REGISTRY.address!, RUNTIME, REGISTRY_PUBLISHER, 412n); // the live signal registry, in use
  }

  install(address: Hex, code: Hex, owner: Hex, latestBatchId: bigint): void {
    this.codes.set(address.toLowerCase(), code);
    this.owners.set(address.toLowerCase(), owner);
    this.batchIds.set(address.toLowerCase(), latestBatchId);
  }

  async getChainId() {
    this.events.push('getChainId');
    return this.chain;
  }
  async getTransactionCount({ blockTag }: { address: Hex; blockTag: 'latest' | 'pending' }) {
    return blockTag === 'latest' ? this.latest : this.pending;
  }
  async getCode({ address }: { address: Hex }) {
    this.getCodeCalls.push(address.toLowerCase());
    return this.codes.get(address.toLowerCase());
  }
  async call({ data }: { account: Hex; data: Hex }) {
    this.events.push(data === CREATION ? 'dry-run' : 'call?');
    return { data: this.dryRuntime };
  }
  async readContract({ address, functionName }: { address: Hex; functionName: 'owner' | 'latestBatchId' }) {
    return functionName === 'owner' ? this.owners.get(address.toLowerCase()) ?? `0x${'0'.repeat(40)}` : this.batchIds.get(address.toLowerCase()) ?? 0n;
  }
  async sendTransaction({ data }: { data: Hex }) {
    this.sends.push(data);
    this.events.push('send');
    return TX;
  }
  async waitForTransactionReceipt() {
    this.events.push('wait');
    if (this.receiptThrows) throw Object.assign(new Error('Timed out while waiting for transaction'), { name: 'WaitForTransactionReceiptTimeoutError' });
    return this.mine();
  }
  /** The broadcast tx lands (also used to model a stopped run's tx landing later). */
  mine() {
    const expected = create(this.latest);
    const at = this.mined.at === 'expected' ? expected : this.mined.at;
    if (this.mined.status === 'success' && at) this.install(at, this.mined.runtime, this.mined.owner, this.mined.latestBatchId);
    this.latest += 1;
    this.pending = this.latest;
    return { status: this.mined.status, contractAddress: at, blockNumber: 41_234_567n };
  }
}

function io(node: FakeDeployNode, signer: Hex = REGISTRY_PUBLISHER): DeployIo & { lines: string[] } {
  const lines: string[] = [];
  return { publicClient: node, walletClient: node, signer, lines, log: (l) => { lines.push(l); node.events.push(`log:${l}`); } };
}

describe('deployCallLedgerRegistry — every refusal sends nothing', () => {
  it('a signer that is not the publisher is FAIL before any RPC', async () => {
    const node = new FakeDeployNode();
    const r = await deployCallLedgerRegistry(io(node, privateKeyToAccount(generatePrivateKey()).address));
    expect(r.verdict).toBe('FAIL');
    expect(r.detail).toMatch(/is not the publisher/);
    expect(node.events).toEqual([]);
    expect(node.sends).toEqual([]);
  });

  it('the publisher in another case is the publisher', async () => {
    const r = await deployCallLedgerRegistry(io(new FakeDeployNode(), REGISTRY_PUBLISHER.toUpperCase().replace('0X', '0x') as Hex));
    expect(r.verdict).toBe('PASS');
  });

  it('an RPC that is not Base is FAIL', async () => {
    const node = new FakeDeployNode();
    node.chain = 1;
    const r = await deployCallLedgerRegistry(io(node));
    expect(r).toMatchObject({ verdict: 'FAIL' });
    expect(r.detail).toMatch(/chain 1, not Base \(8453\)/);
    expect(node.sends).toEqual([]);
  });

  it('a publisher tx in flight is INDETERMINATE (the anchor may be sending: wait, never race it)', async () => {
    const node = new FakeDeployNode();
    node.pending = 6;
    const r = await deployCallLedgerRegistry(io(node));
    expect(r.verdict).toBe('INDETERMINATE');
    expect(r.detail).toMatch(/pending nonce 6 > latest 5/);
    expect(node.sends).toEqual([]);
    expect(node.getCodeCalls).toEqual([]);
  });

  it('a dry run that does not return the registry runtime is FAIL', async () => {
    const node = new FakeDeployNode();
    node.dryRuntime = OTHER_RUNTIME;
    const r = await deployCallLedgerRegistry(io(node));
    expect(r.verdict).toBe('FAIL');
    expect(r.detail).toMatch(/dry run returns runtime hashing to 0x[0-9a-f]{64}, not /);
    expect(node.sends).toEqual([]);
  });

  it('an empty dry run is FAIL, not a crash', async () => {
    const node = new FakeDeployNode();
    node.dryRuntime = '0x';
    const r = await deployCallLedgerRegistry(io(node));
    expect(r.verdict).toBe('FAIL');
    expect(r.detail).toMatch(/hashing to nothing/);
  });
});

describe('deployCallLedgerRegistry — the CREATE scan: one registry, never two', () => {
  it('scans every nonce the publisher used, across chunks, and skips the signal registry', async () => {
    const node = new FakeDeployNode();
    node.latest = node.pending = 45; // three chunks of 20
    const r = await deployCallLedgerRegistry(io(node));
    expect(r.verdict).toBe('PASS');
    const scanned = node.getCodeCalls.slice(0, 45);
    expect(new Set(scanned)).toEqual(new Set(Array.from({ length: 45 }, (_, n) => create(n))));
    expect(r.detail).toBe(`address=${create(45)} tx=${TX} block=41234567`);
  });

  it('a registry a stopped run already deployed is reused — PASS, nothing sent', async () => {
    const node = new FakeDeployNode();
    node.install(create(3), RUNTIME, REGISTRY_PUBLISHER, 0n);
    const r = await deployCallLedgerRegistry(io(node));
    expect(r).toEqual({ verdict: 'PASS', detail: `address=${create(3)} tx=unknown block=unknown (already deployed — found by the CREATE scan; nothing sent)` });
    expect(node.sends).toEqual([]);
    expect(node.events).not.toContain('dry-run');
  });

  it('a found registry already in use is FAIL (latestBatchId ≠ 0)', async () => {
    const node = new FakeDeployNode();
    node.install(create(3), RUNTIME, REGISTRY_PUBLISHER, 2n);
    const r = await deployCallLedgerRegistry(io(node));
    expect(r.verdict).toBe('FAIL');
    expect(r.detail).toMatch(/latestBatchId\(\) of .* is 2, not 0/);
    expect(node.sends).toEqual([]);
  });

  it('a found registry with another owner is FAIL', async () => {
    const node = new FakeDeployNode();
    node.install(create(3), RUNTIME, `0x${'99'.repeat(20)}`, 0n);
    const r = await deployCallLedgerRegistry(io(node));
    expect(r.verdict).toBe('FAIL');
    expect(r.detail).toMatch(/owner\(\) of .* is 0x9999/);
  });

  it('two registries besides the signal one is FAIL — resolve by hand, never a third', async () => {
    const node = new FakeDeployNode();
    node.install(create(2), RUNTIME, REGISTRY_PUBLISHER, 0n);
    node.install(create(4), RUNTIME, REGISTRY_PUBLISHER, 0n);
    const r = await deployCallLedgerRegistry(io(node));
    expect(r.verdict).toBe('FAIL');
    expect(r.detail).toContain(`(${create(2)}, ${create(4)})`);
    expect(node.sends).toEqual([]);
  });

  it('a contract with some OTHER runtime at a scanned nonce is not a registry', async () => {
    const node = new FakeDeployNode();
    node.install(create(2), OTHER_RUNTIME, REGISTRY_PUBLISHER, 0n);
    const r = await deployCallLedgerRegistry(io(node));
    expect(r.verdict).toBe('PASS');
    expect(node.sends).toHaveLength(1);
  });
});

describe('deployCallLedgerRegistry — the send', () => {
  it('prints the expected address, sends the creation code ONCE, prints the hash BEFORE awaiting the receipt, then earns PASS', async () => {
    const node = new FakeDeployNode();
    const d = io(node);
    const r = await deployCallLedgerRegistry(d);
    expect(r).toEqual({ verdict: 'PASS', detail: `address=${create(5)} tx=${TX} block=41234567` });
    expect(node.sends).toEqual([CREATION]);
    const at = (e: string) => node.events.findIndex((x) => x.startsWith(e));
    expect(at('getChainId')).toBeLessThan(at('dry-run'));
    expect(at('dry-run')).toBeLessThan(at(`log:REGISTRY_DEPLOY_EXPECTED_ADDRESS=${create(5)} nonce=5`));
    expect(at('log:REGISTRY_DEPLOY_EXPECTED_ADDRESS=')).toBeLessThan(at('send'));
    expect(at('send')).toBeLessThan(at(`log:REGISTRY_DEPLOY_TX=${TX}`));
    expect(at(`log:REGISTRY_DEPLOY_TX=${TX}`)).toBeLessThan(at('wait'));
    expect(d.lines[0]).toBe('REGISTRY_DEPLOY_SCAN nonces=0..4 scanned=5 registries_besides_signal=0');
  });

  it('a stopped run (receipt never seen) is INDETERMINATE; the re-run finds its registry and sends nothing', async () => {
    const node = new FakeDeployNode();
    node.receiptThrows = true;
    const lines1: string[] = [];
    expect(await main({}, { ...io(node), log: (l) => lines1.push(l) })).toBe(3);
    expect(lines1.at(-1)).toMatch(/^REGISTRY_DEPLOY_VERDICT=INDETERMINATE stopped on an error \(if REGISTRY_DEPLOY_TX was printed, re-run: the CREATE scan finds it\)/);
    expect(lines1).toContain(`REGISTRY_DEPLOY_TX=${TX}`);
    node.mine(); // the tx lands after the run was stopped
    node.receiptThrows = false;
    const lines2: string[] = [];
    expect(await main({}, { ...io(node), log: (l) => lines2.push(l) })).toBe(0);
    expect(lines2.at(-1)).toBe(`REGISTRY_DEPLOY_VERDICT=PASS address=${create(5)} tx=unknown block=unknown (already deployed — found by the CREATE scan; nothing sent)`);
    expect(node.sends).toHaveLength(1);
  });

  it('a reverted deploy is FAIL', async () => {
    const node = new FakeDeployNode();
    node.mined.status = 'reverted';
    const r = await deployCallLedgerRegistry(io(node));
    expect(r.verdict).toBe('FAIL');
    expect(r.detail).toBe(`tx ${TX} reverted in block 41234567`);
  });

  it('a receipt naming another contract address is FAIL', async () => {
    const node = new FakeDeployNode();
    node.mined.at = `0x${'ab'.repeat(20)}`;
    const r = await deployCallLedgerRegistry(io(node));
    expect(r.verdict).toBe('FAIL');
    expect(r.detail).toMatch(/created 0xabab.*not the expected/);
  });

  it.each([
    ['its runtime', { runtime: OTHER_RUNTIME }, /the runtime at .* hashes to 0x/],
    ['its owner', { owner: `0x${'99'.repeat(20)}` as Hex }, /owner\(\) of .* is 0x9999/],
    ['its batch counter', { latestBatchId: 1n }, /latestBatchId\(\) of .* is 1, not 0/],
  ] as const)('PASS is earned on chain: a deployed registry with the wrong %s is FAIL', async (_, patch, why) => {
    const node = new FakeDeployNode();
    Object.assign(node.mined, patch);
    const r = await deployCallLedgerRegistry(io(node));
    expect(r.verdict).toBe('FAIL');
    expect(r.detail).toMatch(why);
  });
});

describe('main — the CLI', () => {
  it('no key in the environment is INDETERMINATE (exit 3), and touches no node', async () => {
    rpc.requests.length = 0;
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((l: string) => { lines.push(l); });
    try {
      expect(await main({} as NodeJS.ProcessEnv)).toBe(3);
    } finally {
      spy.mockRestore();
    }
    expect(lines).toEqual(['REGISTRY_DEPLOY_VERDICT=INDETERMINATE MERKLE_PUBLISHER_KEY is not set in this environment — nothing sent']);
    expect(rpc.requests).toEqual([]);
  });

  it('a key that is not the publisher’s is FAIL before any RPC — and neither form of the key is ever printed', async () => {
    rpc.requests.length = 0;
    const key = generatePrivateKey();
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((l: string) => { lines.push(l); });
    try {
      for (const form of [key, key.slice(2)]) {
        expect(await main({ MERKLE_PUBLISHER_KEY: form, BASE_RPC_URL: 'https://base-node.invalid' } as unknown as NodeJS.ProcessEnv)).toBe(1);
      }
    } finally {
      spy.mockRestore();
    }
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      expect(l).toMatch(/^REGISTRY_DEPLOY_VERDICT=FAIL the signer 0x[0-9a-fA-F]{40} is not the publisher /);
      expect(l.toLowerCase()).not.toContain(key.slice(2).toLowerCase());
    }
    expect(lines[0]).toContain(privateKeyToAccount(key).address);
    expect(rpc.requests).toEqual([]);
  });

  it('an RPC error mid-scan is INDETERMINATE (exit 3), never an unhandled crash', async () => {
    const node = new FakeDeployNode();
    node.getCode = async () => { throw new Error('socket hang up'); };
    const lines: string[] = [];
    expect(await main({}, { ...io(node), log: (l) => lines.push(l) })).toBe(3);
    expect(lines.at(-1)).toMatch(/^REGISTRY_DEPLOY_VERDICT=INDETERMINATE stopped on an error .* Error: socket hang up$/);
    expect(node.sends).toEqual([]);
  });
});
