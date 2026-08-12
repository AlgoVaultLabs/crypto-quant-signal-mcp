/**
 * PAY-RAIL-DASHBOARD-W1 (R4) — rail topology.
 *
 * The panel exists because the requested shorthand — `x402: Base/Circle` — is FALSE. Circle
 * Gateway does not settle on Base mainnet: `eip155:8453` is deliberately absent from its
 * allowlist because registering it would collide with the CDP `exact` scheme and REPLACE it,
 * silently rerouting Base settlement. These tests pin that the panel cannot re-introduce the
 * false claim, and that what it renders is a function of the source of truth rather than of
 * its own text.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  resolvePaymentRails,
  describeNetwork,
  resolveCalibrationState,
  buildRailsPayload,
  observedFromReport,
  type RailTopologyConfig,
} from '../../src/lib/payment-rail-topology.js';

/**
 * A config fixture. Values mirror the live SoT, but every test that asserts a RELATIONSHIP
 * feeds its own — the point is that the resolver is a function of this input.
 */
const cfg = (over: Partial<RailTopologyConfig> = {}): RailTopologyConfig => ({
  cdpNetwork: 'eip155:8453',
  gatewayNetworks: ['eip155:84532', 'eip155:10'],
  gatewayEnabled: true,
  gatewayActiveNetwork: 'eip155:10',
  a2mcpEnabled: false,
  a2mcpNetwork: 'eip155:196',
  observed: null,
  ...over,
});

const rowById = (rows: ReturnType<typeof resolvePaymentRails>, id: string) => {
  const r = rows.find((x) => x.id === id);
  if (!r) throw new Error(`row ${id} missing`);
  return r;
};
const caips = (r: { networks: { caip2: string }[] }) => r.networks.map((n) => n.caip2);

describe('🛑 the Base/Circle correction — AC4', () => {
  it('the Circle Gateway row NEVER claims eip155:8453', () => {
    const gw = rowById(resolvePaymentRails(cfg()), 'x402-circle-gateway');
    expect(caips(gw)).not.toContain('eip155:8453');
  });

  it('eip155:8453 belongs to the CDP `exact` row', () => {
    const cdp = rowById(resolvePaymentRails(cfg()), 'x402-cdp-exact');
    expect(caips(cdp)).toEqual(['eip155:8453']);
    expect(cdp.scheme).toBe('exact');
    expect(cdp.facilitator).toContain('CDP');
  });

  it('CDP and Gateway are SEPARATE rows — collapsing them is the false claim', () => {
    const rows = resolvePaymentRails(cfg());
    const cdp = rowById(rows, 'x402-cdp-exact');
    const gw = rowById(rows, 'x402-circle-gateway');
    expect(cdp.id).not.toBe(gw.id);
    // No network may appear on both — that overlap IS the collision the guard prevents.
    expect(caips(cdp).filter((n) => caips(gw).includes(n))).toEqual([]);
  });

  it('even if a config ERRONEOUSLY put 8453 in the allowlist, it renders on the Gateway row as its own network — never merged into CDP', () => {
    // The panel reports what it finds; it must not silently normalise a misconfiguration away.
    // Making it visible on the operator surface is the stated purpose.
    const gw = rowById(resolvePaymentRails(cfg({ gatewayNetworks: ['eip155:8453'] })), 'x402-circle-gateway');
    expect(caips(gw)).toEqual(['eip155:8453']);
    expect(gw.facilitator).toContain('Circle');
  });
});

describe('network labelling — AC5 / AC6', () => {
  it('AC5: eip155:84532 is labelled Base Sepolia AND flagged testnet', () => {
    const n = describeNetwork('eip155:84532');
    expect(n.label).toBe('Base Sepolia');
    expect(n.isTestnet).toBe(true);
  });

  it('AC6: eip155:10 is NAMED OP Mainnet and flagged MAINNET (presence + label, not just "not 8453")', () => {
    const n = describeNetwork('eip155:10');
    expect(n.caip2).toBe('eip155:10');
    expect(n.label).toBe('OP Mainnet');
    expect(n.isTestnet).toBe(false);
  });

  it('AC6: the Gateway row actually CARRIES eip155:10, labelled and mainnet', () => {
    const gw = rowById(resolvePaymentRails(cfg()), 'x402-circle-gateway');
    const op = gw.networks.find((n) => n.caip2 === 'eip155:10');
    expect(op).toBeDefined();
    expect(op!.label).toBe('OP Mainnet');
    expect(op!.isTestnet).toBe(false);
  });

  it('mainnet and testnet are distinguishable on the same row', () => {
    const gw = rowById(resolvePaymentRails(cfg()), 'x402-circle-gateway');
    expect(gw.networks.map((n) => n.isTestnet).sort()).toEqual([false, true]);
  });

  it('an UNKNOWN network keeps its id and is NOT claimed to be mainnet', () => {
    // The only way the translation table could lie is by guessing. `null` = not established.
    const n = describeNetwork('eip155:999999');
    expect(n.caip2).toBe('eip155:999999');
    expect(n.label).toBe('eip155:999999');
    expect(n.isTestnet).toBeNull();
  });
});

describe('the output is a function of the SoT, not of this module', () => {
  it('changing the gateway allowlist changes the rendered networks', () => {
    const before = caips(rowById(resolvePaymentRails(cfg()), 'x402-circle-gateway'));
    const after = caips(rowById(resolvePaymentRails(cfg({ gatewayNetworks: ['eip155:10'] })), 'x402-circle-gateway'));
    expect(before).not.toEqual(after);
    expect(after).toEqual(['eip155:10']);
  });

  it('changing the CDP network changes the CDP row', () => {
    const after = caips(rowById(resolvePaymentRails(cfg({ cdpNetwork: 'eip155:84532' })), 'x402-cdp-exact'));
    expect(after).toEqual(['eip155:84532']);
  });

  it('an EMPTY allowlist renders no networks rather than a remembered default', () => {
    const gw = rowById(resolvePaymentRails(cfg({ gatewayNetworks: [] })), 'x402-circle-gateway');
    expect(gw.networks).toEqual([]);
  });

  it('a dark rail names the FLAG, not a vague "disabled"', () => {
    const okx = rowById(resolvePaymentRails(cfg({ a2mcpEnabled: false })), 'a2mcp-okx');
    expect(okx.status).toBe('dark');
    expect(okx.darkReason).toContain('OKX_AI_ENABLED');
    const live = rowById(resolvePaymentRails(cfg({ a2mcpEnabled: true })), 'a2mcp-okx');
    expect(live.status).toBe('live');
    expect(live.darkReason).toBeNull();
  });

  it('a disabled gateway carries its reason through', () => {
    const gw = rowById(resolvePaymentRails(cfg({ gatewayEnabled: false, gatewayReason: 'CIRCLE_GATEWAY_ENABLED is not "true" (default OFF)' })), 'x402-circle-gateway');
    expect(gw.status).toBe('dark');
    expect(gw.darkReason).toContain('CIRCLE_GATEWAY_ENABLED');
  });

  it('every row names its source module', () => {
    for (const r of resolvePaymentRails(cfg())) {
      expect(r.source).toMatch(/src\/lib\/.+\.ts/);
    }
  });
});

describe('AC9 — the Stripe row is OBSERVED-only and says so', () => {
  it('carries observedOnly when data is present', () => {
    const rows = resolvePaymentRails(cfg({
      observed: {
        observedOnly: true,
        brands: [{ name: 'mastercard', n: 3 }],
        methodTypes: [{ name: 'card', n: 3 }],
        window: 'Lifetime',
      },
    }));
    const stripe = rowById(rows, 'stripe-card');
    expect(stripe.observed?.observedOnly).toBe(true);
    expect(stripe.observed?.window).toBe('Lifetime');
  });

  it('with NO observed data the row still renders — absence is not an error', () => {
    const stripe = rowById(resolvePaymentRails(cfg({ observed: null })), 'stripe-card');
    expect(stripe.status).toBe('live');
    expect(stripe.observed).toBeUndefined();
  });
});

describe('AC10/AC11 — calibration is relational, never a literal n', () => {
  // Per D8 a measured n is a SNAPSHOT, never a contract: it was 3 one day and 4 the next.
  // Every assertion here is a RELATIONSHIP that holds at any n.
  it('n < threshold ⇒ INERT', () => {
    for (const [n, t] of [[0, 20], [1, 20], [19, 20], [4, 20]]) {
      expect(resolveCalibrationState(n, t, 'Last 30d').state).toBe('INERT');
    }
  });

  it('n >= threshold ⇒ ACTIVE', () => {
    for (const [n, t] of [[20, 20], [21, 20], [1000, 20]]) {
      expect(resolveCalibrationState(n, t, 'Last 30d').state).toBe('ACTIVE');
    }
  });

  it('nToThreshold === max(0, threshold - n)', () => {
    for (const [n, t] of [[0, 20], [4, 20], [20, 20], [25, 20]]) {
      expect(resolveCalibrationState(n, t, 'Last 30d').nToThreshold).toBe(Math.max(0, t - n));
    }
  });

  it('AC10: names its threshold SOURCE and does NOT attribute it to the canary', () => {
    const c = resolveCalibrationState(4, 20, 'Last 30d');
    expect(c.thresholdSource).toContain('LOW_CONFIDENCE_N');
    expect(c.thresholdSource).toContain('payment-method-report.ts');
    // The canary holds a SEPARATE, env-overridable MIN_N. Presenting this as the canary's
    // state would be the false claim an earlier draft made and that was retracted.
    expect(c.canaryAttribution).toContain('MIN_N');
    expect(c.canaryAttribution).toContain('ALGOVAULT_PAYMENT_DECLINE_MIN_N');
    expect(c.canaryAttribution).toMatch(/diverge/i);
  });

  it('carries its window label — never a bare number', () => {
    expect(resolveCalibrationState(4, 20, 'Last 30d').window).toBe('Last 30d');
  });
});

describe('AC12 — a metrics failure degrades, it never zeros', () => {
  const rails = () => resolvePaymentRails(cfg());
  const report = {
    low_confidence_threshold_n: 20,
    windows: [
      { window: 'Last 30d', population_n: 7, successes: { by_brand: [], by_method_type: [] } },
      { window: 'Lifetime', population_n: 9, successes: { by_brand: [{ card_brand: 'mastercard', n: 3 }], by_method_type: [{ payment_method_type: 'card', n: 3 }] } },
    ],
  };

  it('the TOPOLOGY still renders when metrics are gone — it never depended on them', () => {
    const p = buildRailsPayload({ rails: rails(), report: null, metricsError: 'connection refused', generatedAt: 'T' });
    expect(p.rails.length).toBe(rails().length);
    expect(p.rails.map((r) => r.id)).toContain('x402-circle-gateway');
  });

  it('metrics unavailability is EXPLICIT and carries its reason', () => {
    const p = buildRailsPayload({ rails: rails(), report: null, metricsError: 'connection refused', generatedAt: 'T' });
    expect(p.metrics.available).toBe(false);
    expect(p.metrics).toHaveProperty('reason', 'connection refused');
  });

  it('🛑 calibration is NULL, not a zeroed state — "could not read" ≠ "n is 0"', () => {
    // A zeroed CalibrationState would render "0 / 20 · INERT", which is indistinguishable
    // from a real reading of an empty population. Those are different facts.
    const p = buildRailsPayload({ rails: rails(), report: null, metricsError: null, generatedAt: 'T' });
    expect(p.calibration).toBeNull();
    expect(JSON.stringify(p)).not.toContain('"n":0');
  });

  it('a missing reason still yields a stated one — never an empty string', () => {
    const p = buildRailsPayload({ rails: rails(), report: null, metricsError: null, generatedAt: 'T' });
    expect((p.metrics as { reason: string }).reason.length).toBeGreaterThan(0);
  });

  it('with a report present, calibration is derived from population_n of Last 30d', () => {
    const p = buildRailsPayload({ rails: rails(), report, metricsError: null, generatedAt: 'T' });
    expect(p.metrics.available).toBe(true);
    // Relationship, not a literal: it must equal whatever the report said.
    expect(p.calibration!.n).toBe(report.windows[0].population_n);
    expect(p.calibration!.threshold).toBe(report.low_confidence_threshold_n);
    expect(p.calibration!.window).toBe('Last 30d');
  });

  it('observedFromReport projects the Lifetime window and flags observed-only', () => {
    const o = observedFromReport(report);
    expect(o?.observedOnly).toBe(true);
    expect(o?.window).toBe('Lifetime');
    expect(o?.brands).toEqual([{ name: 'mastercard', n: 3 }]);
    expect(observedFromReport(null)).toBeNull();
  });
});

// ── Guards ────────────────────────────────────────────────────────────────────────────────

const SRC = path.resolve(__dirname, '../../src');
const readSrc = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

/**
 * Strip comments before any ban-grep.
 *
 * A guard that trips on its own explanatory prose demands the deletion of the most valuable
 * lines in the file — and this module's comments necessarily NAME the networks in order to
 * explain why Circle is not on Base mainnet. `check-canaries-wired.mjs` strips for the same
 * reason: a mention in a comment is not a use.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
}

/** The `loadRails` browser function as embedded in the dashboard template — the renderer. */
function extractRenderer(): string {
  const idx = readSrc('index.ts');
  const start = idx.indexOf('async function loadRails()');
  expect(start).toBeGreaterThan(-1);
  const end = idx.indexOf('async function load()', start);
  expect(end).toBeGreaterThan(start);
  return idx.slice(start, end);
}

describe('AC7 — no hardcoded brand/network literals', () => {
  const BRANDS = /['"`](visa|mastercard|unionpay|amex|american express|jcb|discover|diners)['"`]/i;
  /** An ARRAY literal containing a CAIP-2 id — the banned shape: a remembered network SET. */
  const CAIP2_ARRAY = /\[[^\]]*['"`]eip155:\d+['"`][^\]]*\]/;

  it('the renderer contains NO brand or network literal at all', () => {
    const r = stripComments(extractRenderer());
    expect(r).not.toMatch(BRANDS);
    expect(r).not.toMatch(/eip155:\d+/);
  });

  it('the topology module declares no brand literal', () => {
    expect(stripComments(readSrc('lib/payment-rail-topology.ts'))).not.toMatch(BRANDS);
  });

  it('the topology module declares no ARRAY literal of networks — the SET must be injected', () => {
    // The id-keyed NETWORK_META Record is deliberately NOT banned: it is a translation from
    // an id to a label, it decides nothing about which networks exist or are live, and an id
    // it does not know degrades to the raw CAIP-2 with isTestnet null. The drift-prone thing
    // is a remembered LIST, and that is what this forbids.
    expect(stripComments(readSrc('lib/payment-rail-topology.ts'))).not.toMatch(CAIP2_ARRAY);
  });

  it('the guard is not vacuous — it matches the shapes it claims to ban', () => {
    // Proving the regexes can fire, so a passing guard means something.
    expect(`const x = ['eip155:8453', 'eip155:10'];`).toMatch(CAIP2_ARRAY);
    expect(`const b = ['visa','mastercard'];`).toMatch(BRANDS);
    expect(stripComments('// const x = ["visa"]\nconst y = 1;')).not.toMatch(BRANDS);
  });
});

describe('AC8 — one derivation, two callers; no self-HTTP', () => {
  it('both dashboard routes call getPaymentMethodReport, and neither issues an HTTP request to itself', () => {
    const idx = readSrc('index.ts');
    const routes = ['/dashboard/api/payment-methods', '/dashboard/api/payment-rails'];
    for (const route of routes) {
      const start = idx.indexOf(`app.get('${route}'`);
      expect(start, `${route} route missing`).toBeGreaterThan(-1);
      const body = idx.slice(start, idx.indexOf('app.get(', start + 10));
      expect(body, `${route} must call getPaymentMethodReport`).toContain('getPaymentMethodReport');
      // A process fetching its own endpoint must re-authenticate to its own admin gate and can
      // stall on its own event loop, to obtain an object one function call away.
      expect(stripComments(body)).not.toMatch(/localhost|127\.0\.0\.1|fetch\(\s*['"`]https?:/);
    }
  });

  it('the aggregation has exactly ONE implementation', () => {
    // A second `export function getPaymentMethodReport` anywhere would be the drift this bans.
    const files = fs.readdirSync(path.join(SRC, 'lib')).filter((f) => f.endsWith('.ts'));
    const decls = files.filter((f) =>
      /export\s+(async\s+)?function\s+getPaymentMethodReport\b/.test(readSrc(`lib/${f}`)));
    expect(decls).toEqual(['payment-method-report.ts']);
  });
});
