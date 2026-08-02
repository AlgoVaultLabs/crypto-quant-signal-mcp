/**
 * OPS-AUDIT-REMEDIATION-LOW-W1 · Ch3 — API and adapter correctness.
 *
 * SEC-27 terminal error handler · SEC-35 list-endpoint identity asserts ·
 * SEC-45 bounded rankBy · SEC-50 no raw upstream message on the x402 wire.
 *
 * These are structural assertions against the SOURCE, deliberately. The live behaviour of
 * SEC-27 was reproduced against production before the fix (a malformed POST to
 * https://api.algovault.com/mcp returned /app/node_modules/... frames) and is re-verified
 * against production after deploy; what a test can hold forever is that the handler still
 * exists, is still four-arity, and still does not put a stack on the wire.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

describe('SEC-27 — production API must not return stack traces', () => {
  const src = read('src/index.ts');

  it('registers a terminal error-handling middleware', () => {
    expect(src).toMatch(/app\.use\(\s*\(\s*\n?\s*err: unknown,/);
  });

  it('the handler keeps FOUR arguments — Express identifies error handlers by arity', () => {
    // Dropping `_next` silently demotes this to ordinary middleware and it stops catching.
    const block = src.slice(src.indexOf('app.use((\n    err: unknown,'));
    expect(block.slice(0, 400)).toContain('_next: import(\'express\').NextFunction');
  });

  it('never places a stack on the wire, and logs it server-side instead', () => {
    const start = src.indexOf('app.use((\n    err: unknown,');
    const block = src.slice(start, start + 1600);
    // the response body must not interpolate err.stack / err.message
    const resJson = block.slice(block.indexOf('res.status(status).json('));
    expect(resJson).not.toMatch(/err\.stack|err\.message|String\(err\)/);
    // and the stack must still reach the log
    expect(block).toMatch(/console\.error\([\s\S]*err\.stack/);
  });

  it('classifies malformed JSON as 400, not 500', () => {
    expect(src).toContain('MALFORMED_JSON_BODY');
  });

  it('NODE_ENV=production is also set in compose (belt, alongside the code braces)', () => {
    expect(read('docker-compose.yml')).toMatch(/^\s+- NODE_ENV=production$/m);
  });
});

describe('SEC-50 — x402 route must not return the raw upstream message', () => {
  const src = read('src/lib/x402-http-routes.ts');

  it('returns a static message while keeping the machine-readable code', () => {
    const i = src.indexOf('X402_HTTP_HANDLER_ERROR');
    const block = src.slice(i - 400, i + 400);
    expect(block).toContain('X402_HTTP_HANDLER_ERROR');
    expect(block).not.toMatch(/message: err instanceof Error \? err\.message/);
  });

  it('still logs the real error server-side', () => {
    expect(src).toMatch(/console\.error\(\s*'\[x402-http\] handler error:'/);
  });
});

describe('SEC-35 — list-endpoint single-entity reads assert row identity', () => {
  const okx = read('src/lib/adapters/okx.ts');

  it('okx getAssetContext routes all four reads through an identity assert', () => {
    for (const ep of ['ticker', 'funding-rate', 'open-interest', 'mark-price']) {
      expect(okx).toContain(`assertOkxRow(`);
      expect(okx).toContain(`'${ep}'`);
    }
  });

  it('the assert THROWS on a mismatch rather than returning a plausible wrong row', () => {
    const i = okx.indexOf('private assertRow');
    const block = okx.slice(i, i + 700);
    expect(block).toMatch(/row\.instId !== instId/);
    expect(block).toMatch(/throw new Error/);
  });

  it('a MISSING row is not treated as an identity failure', () => {
    // The venue may simply not list the instrument; the existing `?? '0'` handling must survive.
    const i = okx.indexOf('private assertRow');
    expect(okx.slice(i, i + 700)).toMatch(/if \(row && row\.instId/);
  });

  it('the assert is reachable from the real call path (bound in getAssetContext)', () => {
    expect(okx).toMatch(/const assertOkxRow = this\.assertRow\.bind\(this\)/);
  });
});

describe('SEC-45 — rankBy is bounded', () => {
  it('scan_trade_calls rankBy carries an explicit .max()', () => {
    const src = read('src/tools/scan-trade-calls.ts');
    const i = src.indexOf('rankBy: z');
    expect(src.slice(i, i + 500)).toMatch(/\.max\(32\)/);
  });

  it('rankBy is the only unbounded z.string() left on the scan tool surface', () => {
    const src = read('src/tools/scan-trade-calls.ts');
    // any `z.string()` that is neither bounded nor an enum/uuid-style refinement
    const unbounded = [...src.matchAll(/(\w+): z\s*\.?\s*\n?\s*\.?string\(\)(?![\s\S]{0,120}?\.max\()/g)]
      .map((m) => m[1])
      .filter((name) => name !== 'describe');
    expect(unbounded, `unbounded z.string() params: ${unbounded.join(', ')}`).toEqual([]);
  });
});
