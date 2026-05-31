import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import {
  BAZAAR_ROUTES,
  declareBazaarRoute,
  isDiscoverableTool,
  assertNoBazaarLeak,
  FORBIDDEN_BAZAAR_TOKENS,
  bazaarResourceUrl,
} from '../src/lib/x402-bazaar.js';
import { TOOL_PRICING } from '../src/lib/x402.js';

describe('Bazaar discovery routes', () => {
  it('declares exactly the paid tools (stays in sync with TOOL_PRICING)', () => {
    expect(Object.keys(BAZAAR_ROUTES).sort()).toEqual(Object.keys(TOOL_PRICING).sort());
  });

  it('get_trade_call is NOT discoverable (intentionally free — Cowork A2)', () => {
    expect(isDiscoverableTool('get_trade_call')).toBe(false);
    expect(declareBazaarRoute('get_trade_call')).toEqual({});
  });

  it('every route input example validates against its own declared inputSchema (strict)', () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    for (const spec of Object.values(BAZAAR_ROUTES)) {
      const validate = ajv.compile(spec.inputSchema);
      const ok = validate(spec.example);
      expect(ok, `${spec.toolName} example invalid: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  it('declareBazaarRoute returns a non-empty bazaar extension for each paid tool', () => {
    for (const tool of Object.keys(BAZAAR_ROUTES)) {
      const ext = declareBazaarRoute(tool);
      expect(Object.keys(ext).length).toBeGreaterThan(0);
    }
  });

  it('declares HTTP body-discovery (type:http, bodyType:json) — NOT mcp (CDP catalog is http-only)', () => {
    for (const tool of Object.keys(BAZAAR_ROUTES)) {
      const ext = declareBazaarRoute(tool) as {
        bazaar?: { info?: { input?: { type?: string; bodyType?: string; method?: string } }; schema?: unknown };
      };
      expect(ext.bazaar, `${tool} missing bazaar block`).toBeDefined();
      expect(ext.bazaar?.info?.input?.type, `${tool} must be http-type (not mcp)`).toBe('http');
      expect(ext.bazaar?.info?.input?.bodyType, `${tool} must be json body`).toBe('json');
      expect(ext.bazaar?.info?.input?.method, `${tool} must declare method POST (schema requires it)`).toBe('POST');
      expect(ext.bazaar?.info?.input?.type).not.toBe('mcp');
      expect(ext.bazaar?.schema, `${tool} must carry a discovery JSON Schema`).toBeDefined();
    }
  });

  it('exposes the HTTP resource URL for each paid tool (the listed Bazaar URL)', () => {
    for (const tool of Object.keys(BAZAAR_ROUTES)) {
      expect(bazaarResourceUrl(tool)).toMatch(new RegExp(`/x402/${tool}$`));
    }
  });

  it('no Data-Integrity leak in any route description/example/output', () => {
    for (const spec of Object.values(BAZAAR_ROUTES)) {
      expect(() => assertNoBazaarLeak(spec, `route ${spec.toolName}`)).not.toThrow();
      // declared extension also clean
      expect(() => declareBazaarRoute(spec.toolName)).not.toThrow();
    }
  });

  it('leak guard throws on every forbidden internal token', () => {
    expect(() => assertNoBazaarLeak({ description: 'leak outcome_return_pct here' }, 'test')).toThrow(/leak/i);
    for (const token of FORBIDDEN_BAZAAR_TOKENS) {
      expect(() => assertNoBazaarLeak({ x: `prefix ${token} suffix` }, 'test')).toThrow();
    }
  });

  it('descriptions are outcome-framed (non-trivial length, no bare endpoint name)', () => {
    for (const spec of Object.values(BAZAAR_ROUTES)) {
      expect(spec.description.length).toBeGreaterThan(80);
      expect(spec.description).not.toBe(spec.toolName);
    }
  });
});
