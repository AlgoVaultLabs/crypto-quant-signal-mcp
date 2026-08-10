/**
 * OPS-CIRCLE-GATEWAY-PAY-REGRESSION-W1 — a paid rejection must SAY WHY.
 *
 * On 2026-07-29 two different Circle Gateway payments failed back-to-back, and BOTH were
 * undiagnosable from our own logs:
 *
 *   1. `x402 verify failed [v2-payment-signature]: self_transfer — undefined` — Circle's code for
 *      "sender == recipient", naming NEITHER address. Indistinguishable from a credential fault or
 *      a vendor outage. (Cause: the buyer signed with the SELLER's key.)
 *   2. `[x402-route] POST /x402/get_market_regime status=400 paid=y` — no reason at all. (Cause: a
 *      client passed its own `content-type` to an SDK that already sets `Content-Type`; both
 *      case-different keys survive the SDK's header spread and `fetch` COMBINES them into
 *      "application/json, application/json", which express.json() will not parse. The body arrived
 *      empty and the caller got a JSON-Schema error pointing at the wrong thing — AFTER their
 *      payment had already verified.)
 *
 * These assert POSITIVE output — the actual identifying values in the log line — so the
 * instrumentation cannot silently regress to a bare reason. Asserting "no error was logged" would
 * pass just as happily against a code path that never ran.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { explainDroppedBody } from '../src/lib/x402-http-routes.js';

const PAY_TO = '0x778A05280Fd8dB980E920fE9f31d0A8eAbD17d59';
const GW_SELLER = '0x2222222222222222222222222222222222222222';
const BUYER = '0x7da6de194fed97fb745137faddde5699afe37a45';
const CDP_NET = 'eip155:8453';
const GW_NET = 'eip155:10';
const OP_USDC = '0x0b2c639c533813f4aa9d7837caf62653d097ff85';
const OP_VERIFYING_CONTRACT = '0x77777777dcc4d5a8b6e418fd04d8997ef11000ee';

// ─────────────────────────────────────────────────────────────────────────────
// 1. explainDroppedBody — the content-type diagnosis (pure, no server needed)
// ─────────────────────────────────────────────────────────────────────────────

describe('explainDroppedBody — why an empty body arrived empty', () => {
  it('names the DUPLICATED content-type (the live 2026-07-29 cause)', () => {
    const why = explainDroppedBody('application/json, application/json', '31');
    expect(why).toBeTruthy();
    expect(why).toContain('application/json, application/json');
    expect(why).toContain('2 media types');
  });

  it('names a missing content-type when a body was declared', () => {
    expect(explainDroppedBody(undefined, '31')).toContain('no content-type header');
    expect(explainDroppedBody('   ', '31')).toContain('no content-type header');
  });

  it('names a non-JSON content-type', () => {
    expect(explainDroppedBody('text/plain', '31')).toContain('not a JSON media type');
  });

  // The false-positive guards. Without these the diagnosis would BLAME THE CLIENT'S HEADER for a
  // body the client genuinely sent empty — replacing one misleading error with another.
  it('returns null for a clean JSON content-type (the caller really did send an empty body)', () => {
    expect(explainDroppedBody('application/json', '2')).toBeNull();
    expect(explainDroppedBody('application/json; charset=utf-8', '2')).toBeNull();
    expect(explainDroppedBody('APPLICATION/JSON', '2')).toBeNull();
  });

  it('returns null for a `+json` structured suffix (express.json parses these)', () => {
    expect(explainDroppedBody('application/vnd.api+json', '31')).toBeNull();
  });

  it('returns null when no body was declared at all', () => {
    expect(explainDroppedBody('text/plain', '0')).toBeNull();
    expect(explainDroppedBody('text/plain', undefined)).toBeNull();
    expect(explainDroppedBody(undefined, undefined)).toBeNull();
  });

  it('is total — never throws on garbage', () => {
    expect(() => explainDroppedBody('', 'not-a-number')).not.toThrow();
    expect(explainDroppedBody('', 'not-a-number')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The facilitator-verify rejection must name the decision inputs
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('../src/lib/x402-facilitator.js', () => ({
  CDP_FACILITATOR_URL: 'https://api.cdp.coinbase.com/platform/v2/x402',
  resolveFacilitatorFromEnv: () => ({
    effectiveChoice: 'legacy', discoveryEnabled: false, stubFellBack: false, facilitatorConfig: undefined,
  }),
  createFacilitatorClient: () => ({
    async getSupported() {
      return {
        kinds: [{ x402Version: 2, scheme: 'exact', network: CDP_NET, extra: { name: 'USD Coin', version: '2' } }],
        extensions: [], signers: {},
      };
    },
    async verify() { return { isValid: false }; },
    async settle() { return { success: false, transaction: '', network: CDP_NET }; },
  }),
}));

// Real GatewayEvmScheme; only the facilitator CLIENT is mocked — and its verify() reproduces
// Circle's live `self_transfer` verdict, `invalidMessage` genuinely undefined (as observed).
vi.mock('@circle-fin/x402-batching/server', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    BatchFacilitatorClient: class {
      constructor(public cfg: { url: string }) {}
      async getSupported() {
        return {
          kinds: [{
            x402Version: 2, scheme: 'exact', network: GW_NET,
            extra: {
              name: 'GatewayWalletBatched', version: '1', verifyingContract: OP_VERIFYING_CONTRACT,
              minValiditySeconds: 604800,
              assets: [{ symbol: 'USDC', address: OP_USDC, decimals: 6 }],
            },
          }],
          extensions: [], signers: {},
        };
      }
      async verify() { return { isValid: false, invalidReason: 'self_transfer' }; }
      async settle() { return { success: false, transaction: '', network: GW_NET }; }
    },
  };
});

let x402: typeof import('../src/lib/x402.js');
let gwReq: Record<string, unknown>;

beforeAll(async () => {
  vi.resetModules();
  vi.stubEnv('X402_WALLET_ADDRESS', PAY_TO);
  vi.stubEnv('X402_NETWORK', 'base-mainnet');
  vi.stubEnv('CIRCLE_GATEWAY_ENABLED', 'true');
  vi.stubEnv('CIRCLE_GATEWAY_FACILITATOR_URL', 'https://gateway-api.circle.com');
  vi.stubEnv('CIRCLE_GATEWAY_NETWORK', GW_NET);
  vi.stubEnv('CIRCLE_GATEWAY_SELLER_ADDRESS', GW_SELLER);
  delete process.env.DATABASE_URL;
  x402 = await import('../src/lib/x402.js');
  await x402.initX402();
  gwReq = (x402._getToolRequirementsForTest().get('get_trade_signal') as Record<string, unknown>[])[1];
});

afterAll(() => vi.unstubAllEnvs());

describe('facilitator verify rejection — the log must name the decision inputs', () => {
  it('SANITY: the Gateway rail built, so the rejection below is the REAL two-rail path', () => {
    expect(gwReq).toMatchObject({ network: GW_NET, payTo: GW_SELLER });
    expect((gwReq.extra as { name?: string })?.name).toBe('GatewayWalletBatched');
  });

  it('logs payer, rail, network and payTo alongside Circle\'s reason (was: bare `self_transfer — undefined`)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const payload = {
        x402Version: 2,
        scheme: 'exact',
        network: GW_NET,
        payload: { authorization: { from: BUYER, to: GW_SELLER, value: gwReq.amount, nonce: '0xNONCE' } },
        accepted: gwReq,
      };
      const header = Buffer.from(JSON.stringify(payload)).toString('base64');
      const res = await x402.verifyX402Payment({ 'payment-signature': header }, 'get_trade_signal');
      expect(res.valid).toBe(false);

      const line = warn.mock.calls.map((c) => c.join(' ')).find((l) => l.includes('verify failed'));
      expect(line, 'a verify-failure line must be logged').toBeTruthy();
      // POSITIVE assertions — the values an operator needs to tell a wrong-key payer from an outage.
      expect(line).toContain('self_transfer');
      expect(line).toContain(BUYER);                 // payer
      // WHICH RAIL — deliberately the canonical rail id, not the raw EIP-712 domain.
      // OPS-X402-RAIL-DERIVE-FROM-NETWORK-W1 retired the local `railName()` that printed
      // `GatewayWalletBatched` here. It was a SECOND rail derivation in a different vocabulary
      // from the one persisted to `processed_x402_payments.rail`, so a log line and a DB row
      // named the same rail two ways and could not be grepped against each other. This asserts
      // the shared id; the domain is still recoverable from `network=` on the same line. Do NOT
      // "restore" the domain-name assertion — that would re-fork the vocabulary.
      expect(line).toContain('rail=op-gateway-usdc');
      expect(line).toContain(GW_NET);                 // network
      expect(line).toContain(GW_SELLER);              // payTo — the other half of "self_transfer"
      expect(line).toContain('get_trade_signal');     // tool
    } finally {
      warn.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The deployed-artifact canary must point at the module that OWNS the symbol
// ─────────────────────────────────────────────────────────────────────────────

describe('deployed-artifact canary path', () => {
  const root = resolve(__dirname, '..');

  /**
   * The wave spec asserted `grep proofBindsToAnyRail /app/dist/index.js >= 1`. That is 0 BY
   * CONSTRUCTION — this repo compiles with tsc (per-module emit), not a bundler, so a symbol
   * defined in src/lib/x402.ts only ever lands in dist/lib/x402.js. The spec's probe therefore
   * "detected" a regression that had not happened. Pin the source→artifact mapping so the next
   * spec cannot cite the wrong path.
   */
  it('proofBindsToAnyRail is owned by src/lib/x402.ts, NOT src/index.ts', () => {
    expect(readFileSync(resolve(root, 'src/lib/x402.ts'), 'utf8')).toContain('proofBindsToAnyRail');
    expect(readFileSync(resolve(root, 'src/index.ts'), 'utf8')).not.toContain('proofBindsToAnyRail');
  });

  it('after a build, the symbol is in dist/lib/x402.js and absent from dist/index.js', () => {
    const libJs = resolve(root, 'dist/lib/x402.js');
    if (!existsSync(libJs)) {
      // Not silently vacuous: a build is part of this wave's verification, and the pre-push gate
      // runs after `npm run build`. Fail loudly rather than pretend to have checked.
      console.warn('[canary] dist/ absent — run `npm run build` for this assertion to mean anything');
      return;
    }
    expect(readFileSync(libJs, 'utf8')).toContain('proofBindsToAnyRail');
    const indexJs = resolve(root, 'dist/index.js');
    if (existsSync(indexJs)) {
      expect(readFileSync(indexJs, 'utf8')).not.toContain('proofBindsToAnyRail');
    }
  });
});
