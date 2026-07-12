/**
 * OPS-X402-WALLET-ATTRIBUTION-W1 R4/Q2 — operator x402 payer-wallet exclusion.
 *
 * Operator self-settle wallets (the harness buyer) are EXCLUDED from the distinct-paying-wallet
 * CONVERSION metric so the agent funnel measures REAL agent conversion, not operator self-settle.
 * The src constant is the RUNTIME source; audits/OPERATOR_X402_WALLET_FILTER.json is the documented
 * mirror — a canary asserts they never drift.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPERATOR_X402_WALLETS, isOperatorWallet, operatorExclusionSql, truncateWallet } from '../src/lib/x402-operator-wallets.js';

const HARNESS = '0x76de895fdd3f7b5814eb59ccd244b06b47d8c755';

describe('x402 operator wallet filter', () => {
  it('includes the self-settle harness buyer (on-chain-confirmed 2026-06-30)', () => {
    expect(OPERATOR_X402_WALLETS).toContain(HARNESS);
    expect(OPERATOR_X402_WALLETS.every((w) => w === w.toLowerCase())).toBe(true); // stored lowercased
  });

  it('isOperatorWallet is case-insensitive; false for non-operator / null', () => {
    expect(isOperatorWallet(HARNESS.toUpperCase().replace('0X', '0x'))).toBe(true);
    expect(isOperatorWallet('0xabc0000000000000000000000000000000000abc')).toBe(false);
    expect(isOperatorWallet(null)).toBe(false);
    expect(isOperatorWallet(undefined)).toBe(false);
  });

  it('operatorExclusionSql builds a lower() NOT IN clause + lowercased params', () => {
    const { clause, params } = operatorExclusionSql();
    expect(clause).toContain('NOT IN');
    expect(clause).toContain('lower(payer_wallet)');
    expect(params).toEqual([...OPERATOR_X402_WALLETS]);
  });

  it('truncateWallet → 0x76de…c755 (operator display only — never the full address)', () => {
    expect(truncateWallet(HARNESS)).toBe('0x76de…c755');
  });

  it('CANARY: the src constant matches audits/OPERATOR_X402_WALLET_FILTER.json (no drift)', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const json = JSON.parse(fs.readFileSync(path.join(here, '..', 'audits', 'OPERATOR_X402_WALLET_FILTER.json'), 'utf8'));
    const fromJson = (json.operator_wallets as string[]).map((w) => w.toLowerCase()).sort();
    expect([...OPERATOR_X402_WALLETS].sort()).toEqual(fromJson);
  });
});
