/**
 * REVENUE-METER-TRUTH-W1 CH2 — a row in `processed_x402_payments` is a CLAIM, not a payment.
 *
 * `tryClaimPayment` writes a row when a buyer presents an ERC-3009 authorization. Nothing had ever
 * checked that the authorization was subsequently USED on-chain. The Base USDC
 * `AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)` log is that check, and the
 * nonce is indexed, so each row is an exact lookup.
 *
 * Measured on live prod 2026-08-04 with `--classify` over all 18 rows:
 *   SETTLED=0 · OPERATOR=3 · CLAIMED_UNSETTLED=15 · UNRESOLVABLE=0
 * i.e. external settled x402 revenue is $0.00, and 15 of 18 "payments" never moved any money.
 */
import { describe, it, expect } from 'vitest';
import {
  classifySettlement,
  isValidAddress,
  normalizeAuthorizer,
  estimateBlock,
  UNATTRIBUTED_SQL,
  type SettlementClass,
} from '../src/scripts/backfill-x402-payer-wallet.js';

const OPERATOR = '0x76de895fdd3f7b5814eb59ccd244b06b47d8c755';
const EXTERNAL = '0x7da6de194fed97fb745137faddde5699afe37a45';
const isOperator = (w: string) => w.toLowerCase() === OPERATOR;

describe('classifySettlement — the four states', () => {
  it('an on-chain authorization by a non-operator wallet ⇒ SETTLED', () => {
    expect(classifySettlement(EXTERNAL, true, isOperator)).toBe<SettlementClass>('SETTLED');
  });

  it('an on-chain authorization by an operator wallet ⇒ OPERATOR (never counted as revenue)', () => {
    expect(classifySettlement(OPERATOR, true, isOperator)).toBe<SettlementClass>('OPERATOR');
  });

  it('scan ran, no authorization found ⇒ CLAIMED_UNSETTLED — the claim exists, the money never moved', () => {
    expect(classifySettlement(null, true, isOperator)).toBe<SettlementClass>('CLAIMED_UNSETTLED');
  });

  it('scan could NOT run ⇒ UNRESOLVABLE, never CLAIMED_UNSETTLED', () => {
    // The distinction that matters: "we looked and found nothing" is a finding about the world;
    // "we could not look" is a finding about us. Collapsing them would let an RPC outage render as
    // proof that nobody paid — which, on a revenue meter, is the exact failure this wave exists to
    // retire. Both null-authorizer cases below MUST disagree.
    expect(classifySettlement(null, false, isOperator)).toBe<SettlementClass>('UNRESOLVABLE');
    expect(classifySettlement(null, true, isOperator)).toBe<SettlementClass>('CLAIMED_UNSETTLED');
    expect(classifySettlement(null, false, isOperator)).not.toBe(classifySettlement(null, true, isOperator));
    // A failed scan is UNRESOLVABLE even if a wallet was somehow carried in.
    expect(classifySettlement(EXTERNAL, false, isOperator)).toBe<SettlementClass>('UNRESOLVABLE');
  });

  it('reproduces the live prod tally (18 rows: 0 settled / 3 operator / 15 unsettled)', () => {
    // The exact shape measured on prod, replayed through the classifier.
    const rows: Array<[string | null, boolean]> = [
      [OPERATOR, true], [OPERATOR, true], [OPERATOR, true],           // the 3 June rows that DID settle
      [null, true], [null, true], [null, true], [null, true],         // 4 June rows with no AuthorizationUsed
      ...Array.from({ length: 11 }, () => [null, true] as [string | null, boolean]), // the 11 "external" claims
    ];
    const tally = rows.reduce<Record<string, number>>((acc, [w, ok]) => {
      const k = classifySettlement(w, ok, isOperator);
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});
    expect(tally).toEqual({ OPERATOR: 3, CLAIMED_UNSETTLED: 15 });
    expect(tally.SETTLED ?? 0).toBe(0); // external settled x402 revenue = $0.00
  });
});

describe('UNATTRIBUTED_SQL — the selector migration 024 silently blinded', () => {
  it('matches BOTH the empty string and NULL', () => {
    // The original inline selector was `payer_wallet IS NULL`. migrations/024:33 ran
    // `UPDATE … SET payer_wallet = '' WHERE payer_wallet IS NULL` and then `SET NOT NULL`, so prod
    // holds ZERO NULLs and the job matched NOTHING — a no-op no test could see.
    expect(UNATTRIBUTED_SQL).toContain('IS NULL');
    expect(UNATTRIBUTED_SQL).toContain("trim(payer_wallet) = ''");
  });

  it('would not have matched the post-024 prod shape before widening', () => {
    const preWidening = 'payer_wallet IS NULL';
    expect(UNATTRIBUTED_SQL).not.toBe(preWidening);
    expect(UNATTRIBUTED_SQL.includes("= ''")).toBe(true);
  });
});

describe('address helpers', () => {
  it('isValidAddress accepts a 0x+40hex literal and rejects everything else', () => {
    expect(isValidAddress(EXTERNAL)).toBe(true);
    expect(isValidAddress('0x123')).toBe(false);
    expect(isValidAddress('')).toBe(false);
    expect(isValidAddress(null)).toBe(false);
  });

  it('normalizeAuthorizer lowercases a valid address and nulls an invalid one', () => {
    expect(normalizeAuthorizer(EXTERNAL.toUpperCase().replace('0X', '0x'))).toBe(EXTERNAL);
    expect(normalizeAuthorizer('nope')).toBeNull();
  });

  it('estimateBlock walks back from head at 2s/block and never goes below 1', () => {
    expect(estimateBlock(1000n, 2000, 1000)).toBe(1000n - 500n);
    expect(estimateBlock(10n, 100_000, 0)).toBe(1n); // clamped
  });
});
