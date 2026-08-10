/**
 * OPS-X402-RAIL-DERIVE-FROM-NETWORK-W1 — `processed_x402_payments.rail` is DERIVED per payment.
 *
 * THE INCIDENT THIS PINS. Both claim sites passed `RAIL_BASE_USDC` as a hardcoded literal, on a
 * prose assumption in the store ("Both writers of this table settle on Base, so this is
 * structural today"). Circle Gateway went live on `eip155:10` on 2026-07-25 and falsified it —
 * silently, because no Gateway payment existed until 2026-08-10 13:03Z. That first one settled on
 * OP Mainnet and was written `rail='base-usdc'` (Circle settlement 1dc4ae9d-dc02-4219-9707-
 * 90b232a1c5d8). Money moved correctly; only the attribution lied, which is the kind of defect
 * that reconciles cleanly forever.
 *
 * FIXTURES ARE THE REAL WIRE SHAPE, not invented. Both requirement objects below are copied
 * verbatim from the live `402` response of `POST https://api.algovault.com/x402/get_trade_signal`
 * captured 2026-08-10. A hand-shaped fixture is exactly how a derivation passes its suite and
 * fails on the wire (CLAUDE.md's hermetic-self-test law).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  railForRequirement,
  RAIL_BASE_USDC,
  RAIL_OP_GATEWAY_USDC,
  RAIL_UNKNOWN,
} from '../src/lib/x402-idempotency-store.js';

/** Live `accepts[0]` — CDP rail, Base mainnet. */
const CDP_BASE = Object.freeze({
  scheme: 'exact',
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  payTo: '0x778A05280Fd8dB980E920fE9f31d0A8eAbD17d59',
  extra: { name: 'USD Coin', version: '2' },
});

/** Live `accepts[1]` — Circle Gateway rail, OP mainnet. The one that was mislabelled. */
const GATEWAY_OP = Object.freeze({
  scheme: 'exact',
  network: 'eip155:10',
  asset: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  payTo: '0x11447b963c1408E7c84868314eF2fe9304768717',
  extra: {
    name: 'GatewayWalletBatched',
    version: '1',
    verifyingContract: '0x77777777dcc4d5a8b6e418fd04d8997ef11000ee',
  },
});

describe('railForRequirement — the rail is a function of the payment, not of the call site', () => {
  it('an eip155:10 Gateway payment records the OP rail (the row that was wrong)', () => {
    expect(railForRequirement(GATEWAY_OP)).toBe(RAIL_OP_GATEWAY_USDC);
  });

  it('an eip155:8453 CDP payment records base-usdc (all 18 historical rows)', () => {
    expect(railForRequirement(CDP_BASE)).toBe(RAIL_BASE_USDC);
  });

  it('the two rails are DISTINCT — a constant-returning stub would pass everything else', () => {
    expect(railForRequirement(GATEWAY_OP)).not.toBe(railForRequirement(CDP_BASE));
  });

  it('array and bare-object forms agree (the SDK returns either)', () => {
    expect(railForRequirement([GATEWAY_OP])).toBe(RAIL_OP_GATEWAY_USDC);
    expect(railForRequirement([CDP_BASE])).toBe(RAIL_BASE_USDC);
  });
});

describe('railForRequirement — ORDER-INDEPENDENT, never rented from upstream iteration order', () => {
  it('a single-rail array gives the same answer in both orders', () => {
    // Duplicated entries of one rail must not depend on position.
    const a = [GATEWAY_OP, { ...GATEWAY_OP, amount: '20000' }];
    expect(railForRequirement(a)).toBe(RAIL_OP_GATEWAY_USDC);
    expect(railForRequirement([...a].reverse())).toBe(RAIL_OP_GATEWAY_USDC);
  });

  it('a MIXED-rail array is ambiguous ⇒ unknown, in BOTH orders — never `[0]`', () => {
    // This is the property that matters: `license.ts` used to read `requirements[0]`, so the
    // persisted rail would have been decided by whatever order the SDK happened to return.
    const forward = railForRequirement([CDP_BASE, GATEWAY_OP]);
    const reverse = railForRequirement([GATEWAY_OP, CDP_BASE]);
    expect(forward).toBe(RAIL_UNKNOWN);
    expect(reverse).toBe(RAIL_UNKNOWN);
    expect(forward).toBe(reverse);
  });
});

describe('railForRequirement — NEVER GUESSES (unknown beats a plausible default)', () => {
  it.each([
    ['unrecognised network', { ...CDP_BASE, network: 'eip155:84532' }],
    ['unrecognised domain', { ...CDP_BASE, extra: { name: 'Something Else', version: '2' } }],
    ['Gateway domain on the Base network (the collision case the guard exists for)',
      { ...CDP_BASE, extra: { name: 'GatewayWalletBatched', version: '1' } }],
    ['missing extra', { scheme: 'exact', network: 'eip155:8453' }],
    ['missing network', { scheme: 'exact', extra: { name: 'USD Coin' } }],
    ['empty object', {}],
    ['null', null],
    ['undefined', undefined],
    ['empty array', []],
    ['a string', 'eip155:10'],
  ])('%s ⇒ unknown', (_name, input) => {
    expect(railForRequirement(input)).toBe(RAIL_UNKNOWN);
  });

  it('never throws — the claim decision must not depend on this succeeding', () => {
    const nasty: unknown[] = [
      { network: 123, extra: { name: {} } },
      { get network() { throw new Error('boom'); } },
    ];
    // A throw here would take down a PAID request path, so the contract is total.
    expect(() => railForRequirement(nasty[0])).not.toThrow();
    expect(railForRequirement(nasty[0])).toBe(RAIL_UNKNOWN);
  });
});

describe('no claim site may reintroduce a hardcoded rail literal', () => {
  // The generator-level guard: the bug was not a wrong constant, it was a CONSTANT AT ALL.
  const ROOT = join(__dirname, '..');
  const CLAIM_SITES = ['src/lib/x402-http-routes.ts', 'src/lib/license.ts'];

  it('both claim sites pass a derived rail, never RAIL_BASE_USDC', () => {
    expect(CLAIM_SITES.length).toBe(2); // vacuity guard
    for (const rel of CLAIM_SITES) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      // Strip comments — the historical note at the HTTP site names the retired constant, and a
      // correction record must not be punished by the rule it records (the ban-grep law).
      //
      // LINE COMMENTS FIRST, and the order is load-bearing: `x402-http-routes.ts:120` contains
      // the path `/x402/*` inside a line comment, which a block-comment rule reads as an OPENING
      // delimiter and then consumes everything up to the next `*/` — swallowing the very
      // `tryClaimPayment` call this asserts on. Stripping block-first silently emptied the corpus
      // and the vacuity guard below is what caught it. (Same `*/`-in-a-path gotcha CLAUDE.md
      // records for JSDoc, arriving from the other direction.)
      const code = src.replace(/(^|[^:])\/\/[^\n]*/g, '$1 ').replace(/\/\*[\s\S]*?\*\//g, ' ');
      const calls = code.match(/tryClaimPayment\([^)]*\)/g) ?? [];
      expect(calls.length, `${rel} has no tryClaimPayment call — the guard would be vacuous`).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call, `${rel} passes a hardcoded rail`).not.toMatch(/RAIL_[A-Z_]+/);
      }
      expect(code, `${rel} must derive the rail`).toContain('railForRequirement(');
    }
  });
});
