/**
 * OPS-GAS-WALLET-RPC-QUORUM-W1 — a "gas wallet low" verdict requires RPC quorum.
 *
 * Regression under test: on 2026-07-17 the monitor emitted 28 false
 * "Gas wallet low: 0.000000 ETH (< 0.005)" readings — one of which paged
 * Telegram — while the facilitator gas wallet 0x804B…7B80 held ~0.0471 ETH at
 * every Base block for >= 7 days (verified against 3 independent RPCs).
 *
 * Root cause: checkGasWallet() returned on the FIRST valid-looking read, and a
 * throttled/pruned public Base RPC intermittently returns a well-formed
 * { result: "0x0" } that passes a `0x`-prefix check and reads as 0.000000 ETH.
 *
 * Contract: a LOW verdict now requires >= GAS_LOW_CONFIRMATIONS *independent*
 * endpoints and must not be outnumbered by healthy reads. Trust is deliberately
 * asymmetric — nodes fail by under-reporting (pruned state -> 0x0), not by
 * fabricating a high balance — so one healthy read refutes a lone low read.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateGasQuorum,
  parseGasBalanceResult,
  GAS_WALLET_MIN_ETH,
  GAS_LOW_CONFIRMATIONS,
} from '../src/lib/gas-wallet-quorum.js';

const ok = (endpoint: string, eth: number) => ({ endpoint, ok: true as const, eth });
const fail = (endpoint: string, error = 'HTTP 503') => ({ endpoint, ok: false as const, error });

/** The wallet's real balance throughout the 2026-07-17 false-alert window. */
const HEALTHY = 0.0471296798;

describe('evaluateGasQuorum', () => {
  it('does NOT page when one RPC under-reports 0 and another reads healthy (2026-07-17 regression)', () => {
    const r = evaluateGasQuorum([
      ok('https://mainnet.base.org', 0),
      ok('https://base.publicnode.com', HEALTHY),
    ]);
    expect(r.verdict).toBe('unconfirmed');
    expect(r.error).toBeNull();
    // Reports the corroborated truth, not the bogus zero.
    expect(r.balance).toBeCloseTo(HEALTHY, 9);
  });

  it('does NOT page on a lone low read when every other endpoint errored', () => {
    const r = evaluateGasQuorum([
      ok('https://mainnet.base.org', 0),
      fail('https://base.publicnode.com'),
      fail('https://base.drpc.org', 'timeout'),
    ]);
    expect(r.verdict).toBe('unconfirmed');
    expect(r.error).toBeNull();
  });

  it('pages when two independent endpoints both confirm low', () => {
    const r = evaluateGasQuorum([
      ok('https://mainnet.base.org', 0),
      ok('https://base.publicnode.com', 0.0001),
    ]);
    expect(r.verdict).toBe('low');
    expect(r.error).toMatch(/Gas wallet low/);
    // Most conservative (lowest) confirmed reading drives the number.
    expect(r.balance).toBe(0);
  });

  it('does NOT treat two reads from the SAME endpoint as independent corroboration', () => {
    const r = evaluateGasQuorum([
      ok('https://mainnet.base.org', 0),
      ok('https://mainnet.base.org', 0),
    ]);
    expect(r.verdict).toBe('unconfirmed');
    expect(r.error).toBeNull();
  });

  it('does NOT page when low reads are outnumbered by healthy reads', () => {
    const r = evaluateGasQuorum([
      ok('a', 0), ok('b', 0),
      ok('c', HEALTHY), ok('d', HEALTHY), ok('e', HEALTHY),
    ]);
    expect(r.verdict).toBe('unconfirmed');
    expect(r.error).toBeNull();
    expect(r.balance).toBeCloseTo(HEALTHY, 9);
  });

  it('pages on a genuine drain where every endpoint agrees', () => {
    const r = evaluateGasQuorum([
      ok('a', 0.0009), ok('b', 0.0009), ok('c', 0.0009),
    ]);
    expect(r.verdict).toBe('low');
    expect(r.error).toMatch(/Gas wallet low/);
  });

  it('reports healthy with the max balance when endpoints agree above the floor', () => {
    const r = evaluateGasQuorum([ok('a', HEALTHY), ok('b', HEALTHY)]);
    expect(r.verdict).toBe('healthy');
    expect(r.error).toBeNull();
    expect(r.balance).toBeCloseTo(HEALTHY, 9);
  });

  it('treats a balance exactly at the floor as healthy, not low', () => {
    const r = evaluateGasQuorum([
      ok('a', GAS_WALLET_MIN_ETH),
      ok('b', GAS_WALLET_MIN_ETH),
    ]);
    expect(r.verdict).toBe('healthy');
    expect(r.error).toBeNull();
  });

  it('returns no-data (never a low page) when there are zero valid reads', () => {
    const r = evaluateGasQuorum([fail('a'), fail('b')]);
    expect(r.verdict).toBe('no-data');
    expect(r.error).toBeNull();
    expect(r.balance).toBe(0);
  });

  it('honours a custom confirmation requirement', () => {
    const reads = [ok('a', 0), ok('b', 0)];
    expect(evaluateGasQuorum(reads, { requiredConfirmations: 3 }).verdict).toBe('unconfirmed');
    expect(evaluateGasQuorum(reads, { requiredConfirmations: 2 }).verdict).toBe('low');
    expect(GAS_LOW_CONFIRMATIONS).toBe(2);
  });
});

describe('parseGasBalanceResult', () => {
  it('converts a valid hex balance to ETH', () => {
    const r = parseGasBalanceResult({ jsonrpc: '2.0', id: 1, result: '0xa77031af2c8d11' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.eth).toBeCloseTo(0.047129679805320465, 12);
  });

  it('parses 0x0 as a valid zero — trusting it is the quorum layer\'s job, not the parser\'s', () => {
    const r = parseGasBalanceResult({ result: '0x0' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.eth).toBe(0);
  });

  it.each([
    ['null body', null],
    ['RPC error body', { error: { message: 'execution reverted' } }],
    ['missing result', { jsonrpc: '2.0', id: 1 }],
    ['non-string result', { result: 12345 }],
    ['non-hex result', { result: '0xzz' }],
    ['bare 0x with no digits', { result: '0x' }],
    ['decimal string', { result: '47129679805320465' }],
  ])('rejects %s instead of coercing it to 0', (_label, body) => {
    const r = parseGasBalanceResult(body);
    expect(r.ok).toBe(false);
  });
});
