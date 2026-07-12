/**
 * OPS-X402-WALLET-ATTRIBUTION-W1 — payer-wallet extraction from the ERC-3009 payment payload.
 *
 * The payer wallet (ERC-3009 `from`) is the sibling of the `nonce` we already extract
 * (`payload.authorization.{from,nonce}`). Extract it at settlement, store it additively.
 * Lowercase-normalized (Q4: `0xAbc` and `0xabc` are the SAME wallet — never double-count).
 * Fail-open: a missing / malformed address returns undefined ⇒ the column stays null,
 * NEVER blocks a settle.
 */
import { describe, it, expect } from 'vitest';
import { extractPayerWallet } from '../src/lib/x402-idempotency-store.js';

const FROM = '0xAbCdEf0123456789012345678901234567890123';
const eip3009 = (from: unknown) => ({
  x402Version: 2,
  payload: { signature: '0xsig', authorization: { from, to: '0xdead000000000000000000000000000000000000', value: '20000', nonce: '0xabc' } },
});

describe('extractPayerWallet', () => {
  it('extracts the ERC-3009 authorization.from and lowercases it (Q4 dedup)', () => {
    expect(extractPayerWallet(eip3009(FROM))).toBe('0xabcdef0123456789012345678901234567890123');
  });

  it('returns undefined (fail-open → null column) when no from is present', () => {
    expect(extractPayerWallet({ payload: { authorization: { nonce: '0xabc' } } })).toBeUndefined();
    expect(extractPayerWallet({})).toBeUndefined();
    expect(extractPayerWallet(null)).toBeUndefined();
    expect(extractPayerWallet('not-an-object')).toBeUndefined();
  });

  it('returns undefined for a malformed address (not 0x + 40 hex) — no garbage in the column', () => {
    expect(extractPayerWallet(eip3009('0x123'))).toBeUndefined();
    expect(extractPayerWallet(eip3009('0xZZZZef0123456789012345678901234567890123'))).toBeUndefined();
    expect(extractPayerWallet(eip3009(42))).toBeUndefined();
  });

  it('reads a top-level / un-nested from defensively', () => {
    expect(extractPayerWallet({ authorization: { from: FROM } })).toBe(FROM.toLowerCase());
    expect(extractPayerWallet({ from: FROM })).toBe(FROM.toLowerCase());
  });
});
