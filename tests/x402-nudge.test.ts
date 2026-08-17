/**
 * FUNNEL-FIX-AGENT-X402-NUDGE-W1 — suggested_x402 helper.
 *
 * The helper derives the agent-actionable in-protocol x402 pay-per-call rail(s) for the tool
 * an agent just called, from the feature-registry channels{} SoT + the live rail-enable
 * predicates + the one price SoT. Rail-agnostic (never hardcodes a rail), single-derivation
 * (price = registry basePriceUsd; route = /x402|/a2mcp/<the-called-tool>), default-deny (no
 * live public rail ⇒ returns undefined ⇒ envelope unchanged), and it never surfaces a HELD
 * tool (equities while EQUITY_PUBLIC_COPY_HOLD).
 */
import { describe, it, expect } from 'vitest';
import { buildSuggestedX402, isX402NudgeEnabled } from '../src/lib/x402-nudge.js';

/** Bazaar (Base/USDC) live; OKX a2mcp OFF. */
const BAZAAR_ONLY_ENV: Record<string, string | undefined> = {
  X402_FACILITATOR: 'cdp',
  CDP_API_KEY_ID: 'test-id',
  CDP_API_KEY_SECRET: 'test-secret',
  BAZAAR_DISCOVERABLE: 'true',
  X402_NETWORK: 'base-mainnet',
  // OKX_AI_ENABLED unset ⇒ okx off
};

describe('buildSuggestedX402 — Bazaar rail', () => {
  it('offers the Bazaar (Base/USDC) rail for get_trade_call at its own /x402 route + registry price', () => {
    const sx = buildSuggestedX402('get_trade_call', 'monthly', BAZAAR_ONLY_ENV);
    expect(sx).toBeDefined();
    expect(sx!.tool).toBe('get_trade_call');
    expect(sx!.primary.rail).toBe('x402_bazaar');
    expect(sx!.primary.method).toBe('POST');
    expect(sx!.primary.url).toBe('https://api.algovault.com/x402/get_trade_call');
    expect(sx!.primary.network).toBe('eip155:8453');
    expect(sx!.primary.asset).toBe('USDC');
    expect(sx!.primary.price_usd).toBe(0.02);
    expect(sx!.primary.scheme).toBe('exact');
    expect(sx!.alternatives).toEqual([]); // okx off
    expect(sx!.instructions).toContain('$0.02'); // price interpolated, not hardcoded
  });
});

/** Bazaar live AND okx.ai A2MCP live (flag + creds ⇒ mode 'live'). */
const BOTH_RAILS_ENV: Record<string, string | undefined> = {
  ...BAZAAR_ONLY_ENV,
  OKX_AI_ENABLED: 'true',
  OKX_API_KEY: 'k',
  OKX_SECRET_KEY: 's',
  OKX_PASSPHRASE: 'p',
  OKX_A2MCP_PAYTO: '0xpayto',
};

describe('buildSuggestedX402 — okx.ai A2MCP alternative rail', () => {
  it('adds okx a2mcp (X Layer/USDT0) as alternatives[0] when live; Bazaar stays primary (Q2)', () => {
    const sx = buildSuggestedX402('get_trade_call', 'monthly', BOTH_RAILS_ENV);
    expect(sx).toBeDefined();
    expect(sx!.primary.rail).toBe('x402_bazaar'); // broadest agent rail first
    expect(sx!.alternatives).toHaveLength(1);
    const okx = sx!.alternatives[0];
    expect(okx.rail).toBe('okx_a2mcp');
    expect(okx.method).toBe('POST');
    expect(okx.url).toBe('https://api.algovault.com/a2mcp/get_trade_call');
    expect(okx.network).toBe('eip155:196'); // X Layer
    expect(okx.asset).toBe('USDT0');
    expect(okx.price_usd).toBe(0.02);
  });

  it('does NOT surface okx when OKX_AI_ENABLED is off (dark rail never offered)', () => {
    const sx = buildSuggestedX402('get_trade_call', 'monthly', BAZAAR_ONLY_ENV);
    expect(sx!.alternatives).toEqual([]);
  });

  it('does NOT surface okx in stub mode (enabled but creds missing — not a real settle rail)', () => {
    const stubEnv = { ...BAZAAR_ONLY_ENV, OKX_AI_ENABLED: 'true' }; // no OKX creds ⇒ stub
    const sx = buildSuggestedX402('get_trade_call', 'monthly', stubEnv);
    expect(sx!.alternatives).toEqual([]);
  });
});

describe('buildSuggestedX402 — HELD tools + default-deny (Q5)', () => {
  it('never surfaces a HELD equity tool while EQUITY_PUBLIC_COPY_HOLD (even though it is x402-payable)', () => {
    // Bazaar live + get_equity_call has channels.httpX402=true, but it is on the equity public-copy HOLD.
    expect(buildSuggestedX402('get_equity_call', 'monthly', BOTH_RAILS_ENV)).toBeUndefined();
    expect(buildSuggestedX402('get_equity_regime', 'monthly', BOTH_RAILS_ENV)).toBeUndefined();
  });

  it('returns undefined for an unpriced tool (knowledge tools: x402=null)', () => {
    expect(buildSuggestedX402('chat_knowledge', 'monthly', BOTH_RAILS_ENV)).toBeUndefined();
    expect(buildSuggestedX402('search_knowledge', 'monthly', BOTH_RAILS_ENV)).toBeUndefined();
  });

  it('returns undefined for an unknown tool', () => {
    expect(buildSuggestedX402('does_not_exist', 'monthly', BOTH_RAILS_ENV)).toBeUndefined();
  });

  it('default-deny: no live rail (Bazaar off, okx off) ⇒ undefined ⇒ envelope unchanged', () => {
    expect(buildSuggestedX402('get_trade_call', 'monthly', {})).toBeUndefined();
  });

  it('resolves an alias to its canonical route (get_trade_signal → get_trade_call)', () => {
    const sx = buildSuggestedX402('get_trade_signal', 'monthly', BAZAAR_ONLY_ENV);
    expect(sx!.tool).toBe('get_trade_call');
    expect(sx!.primary.url).toBe('https://api.algovault.com/x402/get_trade_call');
  });
});

describe('buildSuggestedX402 — rail-agnostic (AC2/R4) + per-tool single-derivation (Q3/Q6)', () => {
  it('AC2: toggling OKX_AI_ENABLED in the SoT surfaces/hides the okx rail with ZERO code change', () => {
    const okxLive = { ...BAZAAR_ONLY_ENV, OKX_AI_ENABLED: 'true', OKX_API_KEY: 'k', OKX_SECRET_KEY: 's', OKX_PASSPHRASE: 'p', OKX_A2MCP_PAYTO: '0xp' };
    const okxOff = { ...okxLive, OKX_AI_ENABLED: 'false' };
    // same fn, same tool — only the SoT flag differs
    expect(buildSuggestedX402('get_trade_call', 'monthly', okxLive)!.alternatives.map((r) => r.rail)).toEqual(['okx_a2mcp']);
    expect(buildSuggestedX402('get_trade_call', 'monthly', okxOff)!.alternatives).toEqual([]);
  });

  it('Q3/Q6: route + price are per-tool from the SoT — scan_funding_arb is $0.01 at its own route', () => {
    const sx = buildSuggestedX402('scan_funding_arb', 'monthly', BAZAAR_ONLY_ENV);
    expect(sx!.primary.url).toBe('https://api.algovault.com/x402/scan_funding_arb');
    expect(sx!.primary.price_usd).toBe(0.01); // NOT 0.02 — proves price interpolates from TOOL_PRICING
    expect(sx!.instructions).toContain('$0.01');
    expect(sx!.instructions).not.toContain('$0.02');
  });

  it('Q3: get_market_regime points at its OWN canonical /x402 route', () => {
    const sx = buildSuggestedX402('get_market_regime', 'monthly', BAZAAR_ONLY_ENV);
    expect(sx!.primary.url).toBe('https://api.algovault.com/x402/get_market_regime');
  });
});

describe('isX402NudgeEnabled', () => {
  it('is true for the funnel-flag go-live values 1/true (default OFF ⇒ envelope byte-identical)', () => {
    expect(isX402NudgeEnabled({ X402_NUDGE_ENABLED: '1' })).toBe(true); // the documented go-live value (auth-providers.ts convention)
    expect(isX402NudgeEnabled({ X402_NUDGE_ENABLED: 'true' })).toBe(true);
    expect(isX402NudgeEnabled({ X402_NUDGE_ENABLED: 'TRUE' })).toBe(true);
    expect(isX402NudgeEnabled({})).toBe(false);
    expect(isX402NudgeEnabled({ X402_NUDGE_ENABLED: 'false' })).toBe(false);
    expect(isX402NudgeEnabled({ X402_NUDGE_ENABLED: '0' })).toBe(false);
  });
});

// ── OPS-QUOTA-METER-SURFACE-CONFORMANCE-W1 CH2 (instance 11) ────────────────────────────────────
describe('the nudge noun follows the wall it is attached to', () => {
  it('renders the DAILY noun on a daily wall and the MONTHLY noun on a monthly one', () => {
    const daily = buildSuggestedX402('get_trade_call', 'daily', BAZAAR_ONLY_ENV)!;
    const monthly = buildSuggestedX402('get_trade_call', 'monthly', BAZAAR_ONLY_ENV)!;
    expect(daily.instructions).toMatch(/^Free daily quota reached\./);
    expect(monthly.instructions).toMatch(/^Free monthly quota reached\./);
    // THE REGRESSION, NAMED: production told an agent walled for hours that its MONTHLY quota was
    // gone. A daily nudge must never speak of a month.
    expect(daily.instructions).not.toMatch(/month/i);
  });

  it('leaves the MONTHLY string byte-identical to pre-wave', () => {
    // The monthly path is the one every existing consumer sees; this wave must move zero bytes on
    // it. Pinned as a literal rather than a shape, because "looks the same" is what a diff is for.
    const sx = buildSuggestedX402('get_trade_call', 'monthly', BAZAAR_ONLY_ENV)!;
    expect(sx.instructions).toBe(
      'Free monthly quota reached. Pay per call with your own wallet — no signup: POST to the '
      + 'x402 route below (HTTP 402 → sign ERC-3009 → resend with x-payment). $0.02 per call.',
    );
  });

  // TIMEOUT IS EXPLICIT AND LOAD-BEARING. This test invokes the TypeScript compiler, which took
  // ~2.5s on a warm local machine and blew vitest's 5000ms DEFAULT on the CI runner — failing the
  // pre-deploy gate and blocking the deploy of the very wave that added it. A test that shells out
  // to a compiler must own its budget rather than inherit the default meant for pure-function
  // assertions. Also invokes the LOCAL tsc binary, never `npx`: npx re-resolves (and on a cold
  // cache can fetch) before it runs, which is a network-shaped variable inside a compile assertion.
  it('THE STRUCTURAL LOCK: `wall` is REQUIRED, so a call site that forgets it fails to COMPILE', { timeout: 180_000 }, () => {
    // AC (ratified): assert this by compiling, never by review. An OPTIONAL `wall` defaulting to
    // 'monthly' would let a future call site silently re-introduce instance 11; a REQUIRED one makes
    // tsc name the offender. `tsconfig.json` excludes tests/, so this compiles the fixture against
    // the real declaration explicitly rather than relying on the repo typecheck to cover it.
    const ts = require('node:child_process');
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x402wall.'));
    const file = path.join(dir, 'probe.ts');
    fs.writeFileSync(file, [
      `import { buildSuggestedX402 } from '${path.resolve('src/lib/x402-nudge.ts').replace(/\.ts$/, '.js')}';`,
      `buildSuggestedX402('get_trade_call');`,
    ].join('\n'));
    let out = '';
    try {
      const tsc = path.resolve('node_modules/.bin/tsc');
      ts.execFileSync(tsc, ['--noEmit', '--skipLibCheck', '--module', 'node16',
        '--moduleResolution', 'node16', '--target', 'ES2022', file], { encoding: 'utf8', stdio: 'pipe' });
    } catch (e: unknown) {
      out = String((e as { stdout?: string }).stdout ?? '');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(out, 'omitting `wall` must be a COMPILE error, not a silent monthly default')
      .toMatch(/Expected 2-3 arguments, but got 1|expects at least 2 arguments/);
  });
});
