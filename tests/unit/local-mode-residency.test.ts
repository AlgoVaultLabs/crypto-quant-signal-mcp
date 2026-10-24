/**
 * SCAN-MARKET-REGIMES-LOCAL-MODE-W1 R3 — `FeatureSpec.residency` and the pipeline's `hosted_only` admission.
 *
 * A local install (no DATABASE_URL → SQLite) used to LIST `scan_market_regimes` and then leak
 * `{"error":"This statement does not return data. Use run() instead"}` on every call; `chat_knowledge`
 * leaked `no such table: chat_usage_monthly`. Both rows now declare `residency:'hosted'`, and `callTool`
 * refuses them locally before dispatch with a typed, unbilled 501.
 *
 * What this file pins, and the evidence each assertion stands on:
 *   1. registry-exhaustive — every `residency:'hosted'` row is iterated (derived from FEATURE_REGISTRY,
 *      never a hand list), and the set is pinned to the Cowork 2026-10-24 ruling (Q1/Q2);
 *   2. per hosted row, local mode: `refused` · `code:'hosted_only'` · 501 · `mcpIsError` · `hosted_endpoint`,
 *      the exact payload key set (no `_algovault`, Q3), 0 dbQuery/dbRun/dbExec calls, no SQLite file
 *      created, quota delta 0, and 0 hits of the backend-leak regex on the MCP text;
 *   3. an `'any'` row is untouched by the rule (it reaches the timeframe admission that runs after it);
 *   4. hosted (Postgres) mode never fires the rule — the handler is dispatched;
 *   5. a FeatureSpec without `residency` is a compile error (in-process tsc, both directions).
 * Mutation proof (R3): deleting the admission block turns 2 and 4's twin red — recorded in the status entry.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

// The DB seam: every cross-module statement goes through these three. 'delegate' runs the real SQLite
// call (so a removed rule leaks the real error AND counts); 'sentinel' throws (hosted mode — a dummy
// DATABASE_URL must never open a socket).
const db = vi.hoisted(() => ({ mode: 'delegate' as 'delegate' | 'sentinel', calls: [] as string[] }));
vi.mock('../../src/lib/performance-db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/performance-db.js')>();
  const wrap = <F extends (...a: never[]) => unknown>(name: string, fn: F): F => vi.fn((...args: Parameters<F>) => {
    db.calls.push(name);
    if (db.mode === 'sentinel') throw new Error(`SENTINEL_DB_REACHED:${name}`);
    return fn(...args);
  }) as unknown as F;
  return { ...actual, dbQuery: wrap('dbQuery', actual.dbQuery), dbRun: wrap('dbRun', actual.dbRun), dbExec: wrap('dbExec', actual.dbExec) };
});

import { FEATURE_REGISTRY } from '../../src/lib/feature-registry.js';
import { callTool, toMcpToolResult, type ValidatedToolInput, type ToolCallOutcome } from '../../src/lib/tool-call-pipeline.js';
import { checkQuota, _resetCallTrackersForTest } from '../../src/lib/license.js';
import type { LicenseInfo } from '../../src/types.js';

const ROOT = path.resolve(__dirname, '..', '..');
const HOSTED_ENDPOINT = 'https://api.algovault.com/mcp';
const LEAK = /does not return data|no such table|sqlite|postgres|regime_snapshots|chat_usage_monthly/i;
const FREE: LicenseInfo = { tier: 'free', key: null };

/** A schema-valid input per hosted tool — a hosted row with no sample here fails test 1, by design. */
const SAMPLE_INPUT: Record<string, Record<string, unknown>> = {
  scan_market_regimes: { exchange: 'BINANCE', timeframe: '4h', assetClass: 'all', sortBy: 'confidence', limit: 20, offset: 0 },
  chat_knowledge: { question: 'What does scan_market_regimes return?' },
};

const hostedRows = FEATURE_REGISTRY.filter((f) => f.enabled && f.residency === 'hosted');
const call = (tool: string, input: Record<string, unknown>): Promise<ToolCallOutcome> =>
  callTool({ tool: tool as never, input: input as unknown as ValidatedToolInput, channel: 'mcp', license: FREE });

let tempHome: string;
let dbPath: string;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ['HOME', 'USERPROFILE', 'PERFORMANCE_DB_PATH', 'DATABASE_URL']) saved[k] = process.env[k];
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-residency-'));
  dbPath = path.join(tempHome, 'performance.db');
  process.env.HOME = tempHome; process.env.USERPROFILE = tempHome;
  process.env.PERFORMANCE_DB_PATH = dbPath;
  delete process.env.DATABASE_URL;
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(tempHome, { recursive: true, force: true });
});
beforeEach(() => { db.mode = 'delegate'; db.calls.length = 0; });

describe('1. registry — residency is declared on every row; the hosted set is the ruling', () => {
  it('every row declares any|hosted, and the hosted set is exactly scan_market_regimes + chat_knowledge', () => {
    for (const f of FEATURE_REGISTRY) expect(['any', 'hosted'], f.name).toContain(f.residency);
    expect(hostedRows.map((f) => f.name)).toEqual(['scan_market_regimes', 'chat_knowledge']);
  });
  it('every hosted row has a sample input (the loops below cannot silently skip one)', () => {
    expect(hostedRows.length, 'no hosted rows — every loop below would be vacuous').toBeGreaterThan(0);
    for (const f of hostedRows) expect(SAMPLE_INPUT[f.name], `add a SAMPLE_INPUT for ${f.name}`).toBeDefined();
  });
  it('residency is not projected onto /capabilities (allow-list)', async () => {
    const { projectCapabilities } = await import('../../src/lib/feature-registry.js');
    expect(JSON.stringify(projectCapabilities())).not.toContain('residency');
  });
});

describe('2. local mode — every hosted row is refused at admission: typed, unbilled, 0 DB statements', () => {
  for (const f of hostedRows) {
    it(`${f.name}: hosted_only · 501 · no DB · no quota · no backend text`, async () => {
      _resetCallTrackersForTest();
      const usedBefore = checkQuota(FREE).used;
      db.calls.length = 0;
      const o = await call(f.name, SAMPLE_INPUT[f.name]);
      const dbCalls = [...db.calls];
      expect(o.ok).toBe(false);
      if (o.ok || o.kind !== 'refused') throw new Error(`expected a refusal, got ${JSON.stringify(o)}`);
      expect(o.mcpIsError).toBe(true);
      expect(o.http).toEqual({ status: 501 });
      expect(Object.keys(o.payload)).toEqual(['error', 'code', 'tool', 'message', 'hosted_endpoint', 'suggested_action']);
      expect(o.payload).toMatchObject({ error: 'hosted_only', code: 'hosted_only', tool: f.name, hosted_endpoint: HOSTED_ENDPOINT });
      expect(o.payload.message).toBe(`This tool is served from the hosted endpoint. Connect your client to ${HOSTED_ENDPOINT} to use it.`);
      expect(dbCalls, 'the refusal must issue 0 DB statements').toEqual([]);
      expect(fs.existsSync(dbPath), 'no SQLite file may be opened by a refused call').toBe(false);
      expect(checkQuota(FREE).used - usedBefore, 'quota delta').toBe(0);

      const mcp = toMcpToolResult(o);
      expect(mcp.isError).toBe(true);
      const text = mcp.content.map((c) => c.text).join('\n');
      expect(JSON.parse(mcp.content[0].text)).toEqual(o.payload);
      expect(text.match(LEAK), 'backend text in the MCP envelope').toBeNull();
    });
  }
});

describe("3. local mode — an 'any' row is untouched by the rule", () => {
  for (const tool of ['get_trade_call', 'get_market_regime']) {
    it(`${tool} reaches the timeframe admission that runs after residency`, async () => {
      expect(FEATURE_REGISTRY.find((f) => f.name === tool)?.residency).toBe('any');
      const o = await call(tool, { coin: 'BTC', timeframe: '7h' });
      if (o.ok || o.kind !== 'refused') throw new Error(`expected a refusal, got ${JSON.stringify(o)}`);
      expect(o.payload.code).toBe('INVALID_TIMEFRAME');
      expect(db.calls).toEqual([]);
    });
  }
});

describe('4. hosted (Postgres) mode — the rule never fires; the handler is dispatched', () => {
  for (const f of hostedRows) {
    it(`${f.name}: not hosted_only when DATABASE_URL is set`, async () => {
      vi.stubEnv('DATABASE_URL', 'postgres://hosted-mode.invalid/never-connected');
      db.mode = 'sentinel';
      try {
        const o = await call(f.name, SAMPLE_INPUT[f.name]);
        const code = !o.ok && o.kind === 'refused' ? o.payload.code : undefined;
        expect(code).not.toBe('hosted_only');
        // Dispatch proof: the handler ran past admission — it either reached the DB seam or failed inside itself.
        const dispatched = db.calls.length > 0 || (!o.ok && o.kind === 'threw') || (!o.ok && o.kind === 'refused');
        expect(dispatched, JSON.stringify(o).slice(0, 300)).toBe(true);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  }
});

describe('5. compile-time — a FeatureSpec without residency does not type-check', () => {
  const ROW = "name: 'x', aliases: [], channels: { mcp: true, httpX402: false, bot: false, webhook: false, a2mcp: false, acp: false }, quota: { unit: 'per-call', holdFree: false }, x402: null, descriptionRef: 'X', enabled: true";
  const diagnose = (code: string) => {
    const probe = path.join(ROOT, 'src', '__residency_required_probe__.ts');
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.Node16, moduleResolution: ts.ModuleResolutionKind.Node16,
      strict: true, noEmit: true, skipLibCheck: true, types: ['node'], resolveJsonModule: true, esModuleInterop: true,
    };
    const host = ts.createCompilerHost(options);
    const orig = { getSourceFile: host.getSourceFile, fileExists: host.fileExists, readFile: host.readFile };
    host.getSourceFile = (f, lang, ...rest) => f === probe ? ts.createSourceFile(f, code, lang) : orig.getSourceFile.call(host, f, lang, ...rest);
    host.fileExists = (f) => f === probe || orig.fileExists.call(host, f);
    host.readFile = (f) => f === probe ? code : orig.readFile.call(host, f);
    const program = ts.createProgram([probe], options, host);
    return program.getSemanticDiagnostics(program.getSourceFile(probe)).map((d) => ({ code: d.code, text: ts.flattenDiagnosticMessageText(d.messageText, '\n') }));
  };
  const head = "import type { FeatureSpec } from './lib/feature-registry.js';";

  it('the @ts-expect-error fixture holds: a row missing residency is an error the directive consumes', () => {
    const fixture = [head, '// @ts-expect-error — residency is required: a row that has not decided must not compile', `export const missing: FeatureSpec = { ${ROW} };`].join('\n');
    expect(diagnose(fixture)).toEqual([]);
  }, 60_000);

  it('both directions: without the directive it errors on residency; with residency the directive is unused', () => {
    const bare = diagnose([head, `export const missing: FeatureSpec = { ${ROW} };`].join('\n'));
    expect(bare.map((d) => d.code)).toEqual([2741]);
    expect(bare[0].text).toContain("'residency'");
    const satisfiesForm = diagnose([head, `export const R = [{ ${ROW} }] as const satisfies readonly FeatureSpec[];`].join('\n'));
    expect(satisfiesForm.length, 'the registry literal form must reject the row too').toBeGreaterThan(0);
    expect(satisfiesForm.map((d) => d.text).join('\n')).toContain('residency');
    const decided = diagnose([head, '// @ts-expect-error', `export const ok: FeatureSpec = { ${ROW}, residency: 'any' };`].join('\n'));
    expect(decided.map((d) => d.code)).toEqual([2578]); // Unused '@ts-expect-error' directive
  }, 60_000);
});
