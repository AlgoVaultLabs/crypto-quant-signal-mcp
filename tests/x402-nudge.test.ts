/**
 * FUNNEL-FIX-AGENT-X402-NUDGE-W1 — suggested_x402 helper.
 *
 * The helper derives the agent-actionable in-protocol x402 pay-per-call rail(s) for the tool
 * an agent just called, from the feature-registry channels{} SoT + the live rail-enable
 * predicates + the one price SoT. Rail-agnostic (never hardcodes a rail), single-derivation
 * (price = registry basePriceUsd; route = /x402|/a2mcp/<the-called-tool>), default-deny (no
 * live public rail ⇒ returns undefined ⇒ envelope unchanged), and it never surfaces a HELD
 * tool (equities while EQUITY_PUBLIC_COPY_HOLD).
 *
 * OPS-A2MCP-SERVED-TRUTH-W1 R1 (ruling R-1, SERVED NOT CONFIGURED): a rail is offered only when
 * its env predicate holds AND its mount reported it served. Every pre-existing case now injects
 * the served-state its env would produce at boot (so each expectation is unchanged); the new
 * cases at the bottom pin "env says live, mount says dark ⇒ not offered" for BOTH rails.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildSuggestedX402, isX402NudgeEnabled } from '../src/lib/x402-nudge.js';
import {
  markServed,
  markDark,
  _resetRailServedStateForTest,
  type RailServedEntry,
  type RailServedState,
} from '../src/lib/rail-served-state.js';

const T0 = '2026-10-13T00:00:00.000Z';
const SERVED = (mode: string): RailServedEntry => ({ status: 'served', mode, reason: `mounted mode=${mode}`, since: T0 });
const DARK = (reason: string): RailServedEntry => ({ status: 'dark', reason, since: T0 });
const UNREPORTED: RailServedEntry = { status: 'unreported', reason: 'no mount has reported', since: null };

/** What a boot with each env would have reported. */
const SERVED_BAZAAR_ONLY: RailServedState = { httpX402: SERVED('cdp'), a2mcp: DARK('off'), acp: UNREPORTED };
const SERVED_BOTH: RailServedState = { httpX402: SERVED('cdp'), a2mcp: SERVED('live'), acp: UNREPORTED };
const SERVED_A2MCP_STUB: RailServedState = { httpX402: SERVED('cdp'), a2mcp: SERVED('stub'), acp: UNREPORTED };
const SERVED_NONE: RailServedState = { httpX402: DARK('off'), a2mcp: DARK('off'), acp: UNREPORTED };

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
    const sx = buildSuggestedX402('get_trade_call', 'monthly', BAZAAR_ONLY_ENV, SERVED_BAZAAR_ONLY);
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
    const sx = buildSuggestedX402('get_trade_call', 'monthly', BOTH_RAILS_ENV, SERVED_BOTH);
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
    const sx = buildSuggestedX402('get_trade_call', 'monthly', BAZAAR_ONLY_ENV, SERVED_BAZAAR_ONLY);
    expect(sx!.alternatives).toEqual([]);
  });

  it('does NOT surface okx in stub mode (enabled but creds missing — not a real settle rail)', () => {
    const stubEnv = { ...BAZAAR_ONLY_ENV, OKX_AI_ENABLED: 'true' }; // no OKX creds ⇒ stub
    const sx = buildSuggestedX402('get_trade_call', 'monthly', stubEnv, SERVED_A2MCP_STUB);
    expect(sx!.alternatives).toEqual([]);
  });
});

describe('buildSuggestedX402 — HELD tools + default-deny (Q5)', () => {
  it('never surfaces a HELD equity tool while EQUITY_PUBLIC_COPY_HOLD (even though it is x402-payable)', () => {
    // Bazaar live + get_equity_call has channels.httpX402=true, but it is on the equity public-copy HOLD.
    expect(buildSuggestedX402('get_equity_call', 'monthly', BOTH_RAILS_ENV, SERVED_BOTH)).toBeUndefined();
    expect(buildSuggestedX402('get_equity_regime', 'monthly', BOTH_RAILS_ENV, SERVED_BOTH)).toBeUndefined();
  });

  it('returns undefined for an unpriced tool (knowledge tools: x402=null)', () => {
    expect(buildSuggestedX402('chat_knowledge', 'monthly', BOTH_RAILS_ENV, SERVED_BOTH)).toBeUndefined();
    expect(buildSuggestedX402('search_knowledge', 'monthly', BOTH_RAILS_ENV, SERVED_BOTH)).toBeUndefined();
  });

  it('returns undefined for an unknown tool', () => {
    expect(buildSuggestedX402('does_not_exist', 'monthly', BOTH_RAILS_ENV, SERVED_BOTH)).toBeUndefined();
  });

  it('default-deny: no live rail (Bazaar off, okx off) ⇒ undefined ⇒ envelope unchanged', () => {
    expect(buildSuggestedX402('get_trade_call', 'monthly', {}, SERVED_NONE)).toBeUndefined();
  });

  it('resolves an alias to its canonical route (get_trade_signal → get_trade_call)', () => {
    const sx = buildSuggestedX402('get_trade_signal', 'monthly', BAZAAR_ONLY_ENV, SERVED_BAZAAR_ONLY);
    expect(sx!.tool).toBe('get_trade_call');
    expect(sx!.primary.url).toBe('https://api.algovault.com/x402/get_trade_call');
  });
});

describe('buildSuggestedX402 — rail-agnostic (AC2/R4) + per-tool single-derivation (Q3/Q6)', () => {
  it('AC2: toggling OKX_AI_ENABLED in the SoT surfaces/hides the okx rail with ZERO code change', () => {
    const okxLive = { ...BAZAAR_ONLY_ENV, OKX_AI_ENABLED: 'true', OKX_API_KEY: 'k', OKX_SECRET_KEY: 's', OKX_PASSPHRASE: 'p', OKX_A2MCP_PAYTO: '0xp' };
    const okxOff = { ...okxLive, OKX_AI_ENABLED: 'false' };
    // same fn, same tool — only the SoT flag differs
    expect(buildSuggestedX402('get_trade_call', 'monthly', okxLive, SERVED_BOTH)!.alternatives.map((r) => r.rail)).toEqual(['okx_a2mcp']);
    expect(buildSuggestedX402('get_trade_call', 'monthly', okxOff, SERVED_BAZAAR_ONLY)!.alternatives).toEqual([]);
  });

  it('Q3/Q6: route + price are per-tool from the SoT — scan_funding_arb is $0.01 at its own route', () => {
    const sx = buildSuggestedX402('scan_funding_arb', 'monthly', BAZAAR_ONLY_ENV, SERVED_BAZAAR_ONLY);
    expect(sx!.primary.url).toBe('https://api.algovault.com/x402/scan_funding_arb');
    expect(sx!.primary.price_usd).toBe(0.01); // NOT 0.02 — proves price interpolates from TOOL_PRICING
    expect(sx!.instructions).toContain('$0.01');
    expect(sx!.instructions).not.toContain('$0.02');
  });

  it('Q3: get_market_regime points at its OWN canonical /x402 route', () => {
    const sx = buildSuggestedX402('get_market_regime', 'monthly', BAZAAR_ONLY_ENV, SERVED_BAZAAR_ONLY);
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
    const daily = buildSuggestedX402('get_trade_call', 'daily', BAZAAR_ONLY_ENV, SERVED_BAZAAR_ONLY)!;
    const monthly = buildSuggestedX402('get_trade_call', 'monthly', BAZAAR_ONLY_ENV, SERVED_BAZAAR_ONLY)!;
    expect(daily.instructions).toMatch(/^Free daily quota reached\./);
    expect(monthly.instructions).toMatch(/^Free monthly quota reached\./);
    // THE REGRESSION, NAMED: production told an agent walled for hours that its MONTHLY quota was
    // gone. A daily nudge must never speak of a month.
    expect(daily.instructions).not.toMatch(/month/i);
  });

  it('leaves the MONTHLY string byte-identical to pre-wave', () => {
    // The monthly path is the one every existing consumer sees; this wave must move zero bytes on
    // it. Pinned as a literal rather than a shape, because "looks the same" is what a diff is for.
    const sx = buildSuggestedX402('get_trade_call', 'monthly', BAZAAR_ONLY_ENV, SERVED_BAZAAR_ONLY)!;
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
    // OPS-A2MCP-SERVED-TRUTH-W1: the lock pins its stated intent — the LOWER bound (`wall` is
    // REQUIRED, "got 1"). The upper bound is incidental: it moved 3 → 4 when the optional `served`
    // param was appended, and would move again with every future optional parameter.
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
      .toMatch(/Expected 2-\d+ arguments, but got 1|expects at least 2 arguments/);
  });
});

// ── OPS-A2MCP-SERVED-TRUTH-W1 R1 — SERVED, NOT CONFIGURED (ruling R-1) ─────────────────────────
describe('buildSuggestedX402 — a rail is offered only when its mount reported it served', () => {
  it('Bazaar: env predicate live but the /x402 mount reported DARK ⇒ not offered (no rail ⇒ undefined)', () => {
    const served: RailServedState = { ...SERVED_BAZAAR_ONLY, httpX402: DARK('not mounted') };
    expect(buildSuggestedX402('get_trade_call', 'monthly', BAZAAR_ONLY_ENV, served)).toBeUndefined();
  });

  it('Bazaar: env predicate live but no mount has REPORTED ⇒ not offered (unreported = not served)', () => {
    const served: RailServedState = { ...SERVED_BAZAAR_ONLY, httpX402: UNREPORTED };
    expect(buildSuggestedX402('get_trade_call', 'monthly', BAZAAR_ONLY_ENV, served)).toBeUndefined();
  });

  it('a2mcp: env resolves `live` but the LIVE mount failed (facilitator 401) ⇒ okx not offered; Bazaar stays', () => {
    // THE INCIDENT, NAMED: OKX_AI_ENABLED=true + all creds set ⇒ selectOkxA2mcp().mode === 'live',
    // while `initialize()` threw at boot and every /a2mcp/<tool> answered 404.
    const served: RailServedState = { ...SERVED_BOTH, a2mcp: DARK('live-mount failed: Failed to initialize') };
    const sx = buildSuggestedX402('get_trade_call', 'monthly', BOTH_RAILS_ENV, served)!;
    expect(sx.primary.rail).toBe('x402_bazaar');
    expect(sx.alternatives).toEqual([]);
    expect(JSON.stringify(sx)).not.toContain('/a2mcp/');
  });

  it('a2mcp: served in STUB mode while env says live ⇒ not offered (only a LIVE mount can take money)', () => {
    const sx = buildSuggestedX402('get_trade_call', 'monthly', BOTH_RAILS_ENV, SERVED_A2MCP_STUB)!;
    expect(sx.alternatives).toEqual([]);
  });

  it('served but env predicate OFF ⇒ still not offered (served is necessary, never sufficient)', () => {
    expect(buildSuggestedX402('get_trade_call', 'monthly', {}, SERVED_BOTH)).toBeUndefined();
  });
});

describe('buildSuggestedX402 — the default served-state is the live module', () => {
  beforeEach(() => _resetRailServedStateForTest());
  afterEach(() => _resetRailServedStateForTest());

  it('reads what the mounts reported in THIS process (no 4th argument)', () => {
    // Nothing reported yet ⇒ nothing offered, even with every env predicate live.
    expect(buildSuggestedX402('get_trade_call', 'monthly', BOTH_RAILS_ENV)).toBeUndefined();

    markServed('httpX402', { mode: 'cdp', routes: 7 });
    markDark('a2mcp', 'live-mount failed: OKX getSupported failed: 401');
    const sx = buildSuggestedX402('get_trade_call', 'monthly', BOTH_RAILS_ENV)!;
    expect(sx.primary.rail).toBe('x402_bazaar');
    expect(sx.alternatives).toEqual([]);

    markServed('a2mcp', { mode: 'live', routes: 5 });
    expect(buildSuggestedX402('get_trade_call', 'monthly', BOTH_RAILS_ENV)!.alternatives.map((r) => r.rail)).toEqual(['okx_a2mcp']);
  });
});
