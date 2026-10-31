/**
 * DECISION-CALL-V1-W3 CH1 (AC1.4) — `pre_trade_check`'s Bazaar input schema and its SERVED zod schema
 * agree on keys, enums, defaults, bounds and required.
 *
 * Both project from `PRE_TRADE_CHECK_PARAM_DECL`, but through two different projectors (zod and the
 * SDK's JSON-Schema converter on one side, `projectParamDecl` in x402-bazaar.ts on the other), so this
 * compares the two OUTPUTS. The served side is read from a real `tools/list` on the real server factory,
 * never re-derived here. On the HTTP rail the Bazaar schema IS the validator (`validateToolInput`
 * compiles it), so a drift here is a paid caller judged differently on the two rails.
 *
 * One asymmetry is PINNED rather than skipped: `uniqueItems` on `exchanges`. The declaration carries it
 * and the Bazaar schema declares it; zod's JSON Schema cannot express it, and the handler refuses a
 * repeat as `invalid_parameter`. If the served side ever starts emitting it, the pin fails and says so.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';
import { BAZAAR_ROUTES, declareBazaarRoute, assertNoBazaarLeak } from '../../src/lib/x402-bazaar.js';
import { PRE_TRADE_CHECK_PARAM_DECL } from '../../src/lib/tool-param-schema.js';

type Props = Record<string, Record<string, unknown>>;
interface ObjectSchema { type?: string; properties?: Props; required?: string[]; additionalProperties?: unknown }

/** Every validator-relevant keyword, plus the description the two projections both carry. */
const COMPARED = ['type', 'enum', 'default', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'minItems', 'maxItems', 'description'] as const;

function view(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of COMPARED) if (k in p) out[k] = p[k];
  if (p.items) out.items = view(p.items as Record<string, unknown>);
  return out;
}

const DECL_KEYS = Object.keys(PRE_TRADE_CHECK_PARAM_DECL);
const bazaar = BAZAAR_ROUTES.pre_trade_check.inputSchema as ObjectSchema;
let served: ObjectSchema;

beforeAll(async () => {
  const { createSandboxServer } = await import('../../src/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const server = createSandboxServer();
  const client = new Client({ name: 'pre-trade-check-bazaar-parity', version: '0.0.0' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverT);
    await client.connect(clientT);
    const tool = (await client.listTools()).tools.find((t) => t.name === 'pre_trade_check');
    expect(tool, 'pre_trade_check is on the served tools/list').toBeTruthy();
    served = tool!.inputSchema as ObjectSchema;
  } finally {
    await client.close();
    await server.close();
  }
});

describe('pre_trade_check — the Bazaar input schema matches the served tools/list schema', () => {
  it('the same parameter keys, and they are the declaration’s', () => {
    expect(Object.keys(bazaar.properties!).sort()).toEqual(Object.keys(served.properties!).sort());
    expect(Object.keys(bazaar.properties!).sort()).toEqual([...DECL_KEYS].sort());
  });

  it('the same required set: coin, side, sizeUsd', () => {
    expect([...bazaar.required!].sort()).toEqual([...(served.required ?? [])].sort());
    expect([...bazaar.required!].sort()).toEqual(['coin', 'side', 'sizeUsd']);
  });

  it('both are closed to unknown keys', () => {
    expect(bazaar.additionalProperties).toBe(false);
    expect(served.additionalProperties).toBe(false);
  });

  for (const key of DECL_KEYS) {
    it(`${key}: identical type, enum, default, bounds and description`, () => {
      expect(view(bazaar.properties![key])).toEqual(view(served.properties![key]));
    });
  }

  it('exchanges: no default on either side; uniqueItems declared on the Bazaar, inexpressible in zod (the pinned asymmetry)', () => {
    const b = bazaar.properties!.exchanges;
    const s = served.properties!.exchanges;
    expect('default' in b).toBe(false);
    expect('default' in s).toBe(false);
    expect(PRE_TRADE_CHECK_PARAM_DECL.exchanges.uniqueItems).toBe(true);
    expect(b.uniqueItems).toBe(true);
    expect(s.uniqueItems).toBeUndefined();
  });

  it('the declared example is the spec’s, and it validates under BOTH schemas', () => {
    const ex = BAZAAR_ROUTES.pre_trade_check.example;
    expect(ex).toEqual({ coin: 'BTC', side: 'long', sizeUsd: 10000, holdHours: 8 });
    const ajv = new Ajv({ strict: false, allErrors: true });
    for (const schema of [bazaar, served]) {
      const validate = ajv.compile(schema);
      expect(validate(structuredClone(ex)), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it('the declared extension passes the leak guard; the output example holds only the shape snapshot’s allowed keys', () => {
    expect(() => assertNoBazaarLeak(declareBazaarRoute('pre_trade_check'), 'declared extension pre_trade_check')).not.toThrow();
    const snapshot = JSON.parse(readFileSync(join(__dirname, '..', '..', 'audits', 'pre-trade-check-shape-snapshot-2026-10-30.json'), 'utf8')) as { allowed_keys: string[] };
    const out = BAZAAR_ROUTES.pre_trade_check.output.example as Record<string, unknown>;
    expect(Object.keys(out).length).toBeGreaterThan(0);
    for (const k of Object.keys(out)) expect(snapshot.allowed_keys, `output key "${k}"`).toContain(k);
    // The contract's Never list: no directional-call key, no outcome key.
    for (const k of ['call', 'verdict', 'reasoning', 'price_at_signal']) expect(out).not.toHaveProperty(k);
    expect(Object.keys(out).filter((k) => k.startsWith('outcome_'))).toEqual([]);
  });
});
