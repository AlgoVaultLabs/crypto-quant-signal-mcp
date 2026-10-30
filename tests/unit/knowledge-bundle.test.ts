/**
 * KNOWLEDGE-ARTIFACT-W1 vitest canary.
 *
 * Locks the v1.14.0+ invariants for the auto-generated KnowledgeBundle JSON:
 *   - Generator emits a schema-valid bundle that survives formatKnowledgeBundle().
 *   - Generator is byte-idempotent (same input → same output, modulo timestamp).
 *   - bundle.tools[] IS the server's tools/list (OPS-KNOWLEDGE-BUNDLE-TOOL-PROJECTION-W1):
 *     set-equal in BOTH directions with an independent in-process read of src/index.ts, and
 *     byte-equal per tool (description, parameters = inputSchema). Replaces a 4-name pin that
 *     enshrined the gap — five live tools were invisible to search_knowledge / chat_knowledge.
 *     The comparator is proven able to fail; the generator is proven to exit 1 on an empty list.
 *   - bundle includes every audits/*-shape-snapshot-*.json on disk.
 *   - Two-sided PII guard (per Plan-Mode Q-3, Mr.1-approved 2026-05-18):
 *     (a) DENY: no value bindings of outcome_return_pct / outcome_price.
 *     (b) REQUIRE: at least one response_shapes[*].forbidden_keys array
 *         contains "outcome_return_pct" (proves the term lives as METADATA
 *         in the right place, never as a leaked value).
 *   - formatKnowledgeBundle({}) throws (rejects empty input).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

/**
 * OPS-PARALLEL-SESSION-CAPACITY-W2 / Ch2 — a budget that survives concurrency.
 *
 * The `beforeAll` builds the entire knowledge bundle (~264 audits files in, ~240 KB out)
 * against vitest's 10 s HOOK default — the tighter of the two budgets, and the one that fires
 * first here. hookTimeout matters more than testTimeout in this file.
 *
 * Measured: under 3-5 concurrent gates (89 checkouts share one pre-push hook) every failure
 * in this class was a TIMEOUT, never an assertion — durations of 5.4-19.9 s against 5 s
 * budgets, including a pure-JSON-read test that took 7.15 s. The assertions are right; the
 * budgets were stale. File-level, per 136954a: the per-`it` third argument silently no-ops
 * when placed after the closing paren, and every test here pays the same cost anyway.
 */
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatKnowledgeBundle,
  type KnowledgeBundle,
  type KnowledgeBundleTool,
} from '../../src/lib/knowledge-formatter.js';

import { liveMcpToolNames } from '../../src/lib/equities/equity-tools-flag.js';
import { allToolNames } from '../../src/lib/feature-registry.js';
import { assertToolList } from '../../scripts/lib/mcp-tools-list.mjs';

/** D3's tool-name recogniser (`pre_` since DECISION-CALL-V1-W2) — pinned to the registry below. */
const BUNDLE_TOOL_RE = /\b(?:get|scan|chat|search|pre)_[a-z0-9_]+\b/g;

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename), '..', '..');
const BUNDLE_LATEST = join(REPO_ROOT, 'dist', 'knowledge', 'latest.json');
const FIXED_TS = '2026-05-18T00:00:00.000Z';

function buildOnce(): KnowledgeBundle {
  execSync(`node scripts/build-knowledge-json.mjs`, {
    cwd: REPO_ROOT,
    env: { ...process.env, KNOWLEDGE_GENERATED_AT: FIXED_TS },
    stdio: 'pipe',
  });
  return JSON.parse(readFileSync(BUNDLE_LATEST, 'utf8'));
}

type ServedTool = { name: string; description?: string; inputSchema: Record<string, unknown> };

/**
 * The served list, read INDEPENDENTLY of the generator: src/index.ts (not dist/), the SDK client
 * built here (not scripts/lib/mcp-tools-list.mjs). If the generator's reader, its projection or a
 * stale dist/ drifted from what the server registers, the two sides disagree.
 */
async function servedToolsFromSrc(): Promise<ServedTool[]> {
  const { createSandboxServer } = await import('../../src/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const server = createSandboxServer();
  const client = new Client({ name: 'knowledge-bundle-canary', version: '0.0.0' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverT);
    await client.connect(clientT);
    const out: ServedTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      out.push(...(page.tools as ServedTool[]));
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  } finally {
    await client.close();
    await server.close();
  }
}

/** Every way the bundle can disagree with the served list. All four empty ⇔ projection exact. */
function diffProjection(bundleTools: KnowledgeBundleTool[], served: ServedTool[]) {
  const b = new Map(bundleTools.map((t) => [t.name, t]));
  const s = new Map(served.map((t) => [t.name, t]));
  const both = [...b.keys()].filter((n) => s.has(n));
  return {
    missingFromBundle: [...s.keys()].filter((n) => !b.has(n)).sort(),
    notServed: [...b.keys()].filter((n) => !s.has(n)).sort(),
    descriptionDrift: both.filter((n) => b.get(n)!.description !== s.get(n)!.description).sort(),
    parametersDrift: both
      .filter((n) => JSON.stringify(b.get(n)!.parameters) !== JSON.stringify(s.get(n)!.inputSchema))
      .sort(),
  };
}
const NO_DRIFT = { missingFromBundle: [], notServed: [], descriptionDrift: [], parametersDrift: [] };

describe('KNOWLEDGE-ARTIFACT-W1 canaries (v1.14.0+ invariants)', () => {
  let bundle: KnowledgeBundle;
  let served: ServedTool[];

  beforeAll(async () => {
    // Assumes `npm run build` already ran (dist/lib/knowledge-formatter.js and dist/index.js
    // exist). The generator reads both: the formatter to validate, the server to project tools.
    if (!existsSync(join(REPO_ROOT, 'dist', 'lib', 'knowledge-formatter.js'))) {
      throw new Error('dist/lib/knowledge-formatter.js missing — run `npm run build` before vitest');
    }
    // Pin BOTH sides to the public default tool set — the set the Docker builder's empty env
    // projects. A developer shell carrying the equity dark-launch flag would otherwise widen both
    // sides at once and still pass, while silently no longer testing what ships.
    vi.stubEnv('EQUITY_TOOLS_ENABLED', '');
    bundle = buildOnce();
    served = await servedToolsFromSrc();
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it('generator produces schema-valid output (formatKnowledgeBundle accepts it)', () => {
    const reshaped = formatKnowledgeBundle(bundle);
    expect(reshaped.version).toBeTypeOf('string');
    expect(reshaped.generated_at).toBe(FIXED_TS);
    expect(reshaped.package_name).toBe('crypto-quant-signal-mcp');
    expect(Array.isArray(reshaped.keywords)).toBe(true);
    expect(reshaped.keywords.length).toBeGreaterThan(0);
    expect(reshaped._algovault.bundle_version).toBe(2); // BUNDLE-EXPAND-BLOG-W1 (2026-05-19): schema bumped 1 → 2 (pages[] added)
    expect(reshaped._algovault.generator).toBe('build-knowledge-json.mjs');
    expect(reshaped._algovault.repo).toBe('AlgoVaultLabs/crypto-quant-signal-mcp');
  });

  // OPS-KNOWLEDGE-BUNDLE-HOLD-PROMISE-W1: this block SPAWNS a full `npm run build:knowledge` plus
  // two shasum processes, so it cannot rely on the 5,000ms default. Declared in the OPTIONS
  // argument, which is the only place check-test-budget.mjs counts a budget — a `timeout:` in the
  // body is fixture data, not a declaration.
  it('generator is byte-idempotent under fixed KNOWLEDGE_GENERATED_AT (two runs match)', { timeout: 120_000 }, () => {
    const firstSha = execSync(`shasum -a 256 "${BUNDLE_LATEST}"`).toString().split(/\s+/)[0];
    buildOnce();
    const secondSha = execSync(`shasum -a 256 "${BUNDLE_LATEST}"`).toString().split(/\s+/)[0];
    expect(firstSha).toBe(secondSha);
  });

  // ── OPS-KNOWLEDGE-BUNDLE-TOOL-PROJECTION-W1 ──────────────────────────────────────────────
  // This used to pin exactly 4 names, which enshrined the gap: tools/list served 9 while the
  // knowledge base knew 4, and the pin would have held through every future tool too.

  it('bundle.tools ⇔ the served tools/list: set-equal in BOTH directions, byte-equal per tool', () => {
    expect(served.length, 'the served tool list resolved to nothing — every assertion below would be vacuous').toBeGreaterThan(0);
    expect(diffProjection(bundle.tools, served)).toEqual(NO_DRIFT);
    // Same order as registration — the order agents see, and what keeps the build idempotent.
    expect(bundle.tools.map((t) => t.name)).toEqual(served.map((t) => t.name));
  });

  it('bundle.tools carries exactly the KnowledgeBundleTool fields — no field added by the projection', () => {
    for (const t of bundle.tools) expect(Object.keys(t).sort()).toEqual(['description', 'name', 'parameters']);
  });

  it('bundle.tools is the PUBLIC DEFAULT set — a dark-launched tool stays out of public knowledge', () => {
    // Cowork ruling Q1 = A: the bundle projects the build env. Under the Docker builder's empty env
    // that is liveMcpToolNames({}); a runtime-only EQUITY_TOOLS_ENABLED flip is a dark launch and is
    // deliberately NOT inherited. A real release changes the default in code, and this follows it.
    expect(bundle.tools.map((t) => t.name).sort()).toEqual([...liveMcpToolNames({} as NodeJS.ProcessEnv)].sort());
  });

  it('the projection comparator can FAIL — drop one tool → red, restore → green', () => {
    // Without this, a comparator that always returned "no drift" would pass every test above.
    const dropped = bundle.tools.slice(1);
    expect(diffProjection(dropped, served).missingFromBundle).toEqual([bundle.tools[0].name]);
    expect(diffProjection(bundle.tools, served.slice(1)).notServed).toEqual([served[0].name]);
    const edited = bundle.tools.map((t, i) => (i === 0 ? { ...t, description: `${t.description} ` } : t));
    expect(diffProjection(edited, served).descriptionDrift).toEqual([bundle.tools[0].name]);
    const reshaped = bundle.tools.map((t, i) => (i === 0 ? { ...t, parameters: { ...t.parameters, required: [] } } : t));
    expect(diffProjection(reshaped, served).parametersDrift).toEqual([bundle.tools[0].name]);
    expect(diffProjection([...dropped, bundle.tools[0]], served)).toEqual(NO_DRIFT); // restored
  });

  it('get_trade_signal description = get_trade_call description + TRADE_CALL_ALIAS_SUFFIX', () => {
    const canonical = bundle.tools.find((t) => t.name === 'get_trade_call');
    const alias = bundle.tools.find((t) => t.name === 'get_trade_signal');
    expect(canonical).toBeDefined();
    expect(alias).toBeDefined();
    expect(alias!.description.startsWith(canonical!.description)).toBe(true);
    // Alias suffix must contain the [ALIAS] tag (Q-5 Mr.1-directed literal).
    expect(alias!.description.includes('[ALIAS]')).toBe(true);
  });

  it('bundle.tools[*].parameters has type=object with non-empty properties', () => {
    for (const t of bundle.tools) {
      const params = t.parameters as Record<string, unknown>;
      expect(params.type).toBe('object');
      expect(typeof params.properties).toBe('object');
      const props = params.properties as Record<string, unknown>;
      expect(Object.keys(props).length).toBeGreaterThan(0);
    }
  });

  // AMENDED by OPS-SHAPE-SNAPSHOT-INTEGRITY-W1. This asserted the bundle covers EVERY snapshot on
  // disk, which is now deliberately false: a snapshot carrying `superseded_by` is kept as history
  // and NOT projected. Before that, 12 of 46 rows were superseded duplicates publishing an EMPTY
  // allowed_keys under their FILENAME as the endpoint — and the filename fallback is the only
  // reason they did not collide, since real endpoints would produce duplicate doc ids that
  // winkBM25S rejects outright. The invariant is coverage of the LIVE set, not of the directory.
  it('bundle.response_shapes covers every NON-SUPERSEDED audits/*-shape-snapshot-*.json on disk', () => {
    const snapshotFiles = readdirSync(join(REPO_ROOT, 'audits')).filter((n) =>
      /-shape-snapshot-.*\.json$/.test(n)
    );
    const live = snapshotFiles.filter((n) => {
      const d = JSON.parse(readFileSync(join(REPO_ROOT, 'audits', n), 'utf-8'));
      return !(typeof d.superseded_by === 'string' && d.superseded_by.length > 0);
    });
    expect(bundle.response_shapes.length).toBe(live.length);
    expect(live.length).toBeGreaterThanOrEqual(2);
    // every superseded row must say WHY — an exemption in prose gets "fixed" by a future wave
    for (const n of snapshotFiles.filter((x) => !live.includes(x))) {
      const d = JSON.parse(readFileSync(join(REPO_ROOT, 'audits', n), 'utf-8'));
      expect(d.superseded_reason, `${n} is superseded without a reason`).toBeTruthy();
    }
  });

  it('bundle.integrations covers every landing/integrations/*.html on disk', () => {
    const htmlFiles = readdirSync(join(REPO_ROOT, 'landing', 'integrations')).filter((n) => n.endsWith('.html'));
    expect(bundle.integrations.length).toBe(htmlFiles.length);
    expect(htmlFiles.length).toBeGreaterThanOrEqual(8);
  });

  it('PII guard DENY: bundle JSON contains no value bindings of outcome_return_pct / outcome_price', () => {
    const bundleJson = JSON.stringify(bundle);
    expect(bundleJson).not.toMatch(/"(outcome_return_pct|outcome_price)"\s*:\s*[-\d.]/);
  });

  it('PII guard REQUIRE: at least one response_shapes[*].forbidden_keys contains "outcome_return_pct"', () => {
    const hasMetadataListing = bundle.response_shapes.some((rs) =>
      rs.forbidden_keys.includes('outcome_return_pct')
    );
    expect(hasMetadataListing).toBe(true);
  });

  // ── OPS-KNOWLEDGE-BUNDLE-HOLD-PROMISE-W1 ─────────────────────────────────────────────────
  // The bundle republishes dated snapshots under a generated_at refreshed on every build, so
  // stale content reads as current. These three assert the specific untruths that reached the
  // live artifact, plus the one thing that must NOT be "fixed".

  it('D2 — no published shape promises a free HOLD (every verdict is metered on both rails)', () => {
    // Measured on the live bundle 2026-08-21: four x402 shapes carried
    // "(HOLDs free; async settle post-response)" in cache_contract while
    // src/lib/call-class.ts states "Post cutover no HOLD is unbilled on any rail" and
    // src/lib/x402-http-routes.ts had already been corrected on 2026-08-09. A pricing
    // misstatement a customer could rely on.
    const claim = /HOLDs?\b[^\n"]{0,40}?\b(?:free|unmetered|unbilled|not charged|never charged|no quota)\b/i;
    const offenders = bundle.response_shapes
      .filter((r: any) => claim.test(JSON.stringify(r)))
      .map((r: any) => r.endpoint);
    expect(offenders, 'a published response shape claims a HOLD is free').toEqual([]);
  });

  it('D3 recogniser — every allToolNames() entry is one whole match', () => {
    const names = allToolNames();
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(`MCP tool ${n}`.match(BUNDLE_TOOL_RE), n).toEqual([n]);
  });

  it('D3 — no published shape documents an MCP tool absent from the live tool set', () => {
    // The bundle documented `MCP tool get_equity_call` / `get_equity_regime` long after
    // EQUITY-TOOLS-DARK-RETIRE-W1 took both off tools/list. Enumerated from the artifact and
    // resolved against the DECLARED live set, so this needs no network and no hardcoded list.
    const live = new Set(liveMcpToolNames({} as NodeJS.ProcessEnv));
    expect(live.size, 'the live tool set resolved to nothing — the check would be vacuous').toBeGreaterThan(0);
    const dangling: string[] = [];
    for (const r of bundle.response_shapes as any[]) {
      const ep = String(r.endpoint ?? '');
      // Only endpoints that NAME an MCP tool — an HTTP route is a different reference class.
      if (!/\bMCP tools?\b/i.test(ep)) continue;
      for (const m of ep.match(BUNDLE_TOOL_RE) ?? []) {
        if (!live.has(m)) dangling.push(`${ep} -> ${m}`);
      }
    }
    expect(dangling, 'a published shape documents a tool an agent cannot call').toEqual([]);
  });

  it('THE FALSE ALARM — forbidden_keys still NAME the internal fields (do NOT "fix" this)', () => {
    // outcome_return_pct / phase_e / realized / win_rate appear in the public bundle ONLY inside
    // forbidden_keys and the drift_check_command that greps for them. Naming a field as forbidden
    // is the Data Integrity law working exactly as designed. Removing them would delete the
    // assertion that keeps the real fields OUT — so this pins them PRESENT, deliberately.
    const forbidden = (bundle.response_shapes as any[]).flatMap((r) => r.forbidden_keys ?? []).map(String);
    for (const name of ['outcome_return_pct', 'phase_e', 'realized', 'win_rate']) {
      expect(
        forbidden.some((k) => k.includes(name)),
        `${name} vanished from every forbidden_keys list — that is a REGRESSION, not a cleanup`,
      ).toBe(true);
    }
  });

  it('bundle.examples is an empty array (Plan-Mode Q-4: demos live in algovault-skills repo, not signal-MCP)', () => {
    expect(Array.isArray(bundle.examples)).toBe(true);
    expect(bundle.examples.length).toBe(0);
  });

  it('formatKnowledgeBundle rejects empty {} input', () => {
    expect(() => formatKnowledgeBundle({})).toThrowError(/missing required field/);
  });

  it('formatKnowledgeBundle is allow-list (extra keys are dropped)', () => {
    // Construct a valid-shaped raw bundle + an extra key, confirm formatter
    // returns the typed shape with no extra key leaked.
    const polluted = { ...bundle, outcome_return_pct: 42, _danger: 'should-not-survive' } as unknown;
    const cleaned = formatKnowledgeBundle(polluted);
    expect((cleaned as Record<string, unknown>).outcome_return_pct).toBeUndefined();
    expect((cleaned as Record<string, unknown>)._danger).toBeUndefined();
  });

  it('bundle.whats_new contains the current package.json version anchor', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(bundle.whats_new).toMatch(/^## What.s new/i);
    // The current version OR a prior recap heading must appear in the slice.
    const hasVersionAnchor = bundle.whats_new.includes(`v${pkg.version}`) || /v\d+\.\d+\.\d+/.test(bundle.whats_new);
    expect(hasVersionAnchor).toBe(true);
  });

  it('bundle.version matches package.json .version', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(bundle.version).toBe(pkg.version);
  });

  it('drift_check_command shape: latest.json passes the jq probe', () => {
    // Replicate the audits/knowledge-shape-snapshot-2026-05-18.json drift_check
    // as a TS-side assertion (no network — just shape introspection).
    expect(bundle).toHaveProperty('version');
    expect(bundle).toHaveProperty('generated_at');
    expect(bundle).toHaveProperty('tools');
    expect(bundle).toHaveProperty('response_shapes');
    expect(bundle).toHaveProperty('integrations');
    expect(bundle).toHaveProperty('examples');
    expect(bundle).toHaveProperty('discussions');
    expect(bundle).not.toHaveProperty('outcome_return_pct');
  });
});

// ── OPS-KNOWLEDGE-BUNDLE-TOOL-PROJECTION-W1 — the generator fails CLOSED (AC2) ─────────────
// A projection that yields nothing must stop the Docker build, never ship a bundle that knows
// nothing. Proven twice: the validator over every refused shape, and the WHOLE generator, run as
// the Dockerfile runs it, against a real MCP server that serves an empty / undescribed list.
describe('OPS-KNOWLEDGE-BUNDLE-TOOL-PROJECTION-W1 — the generator fails closed', () => {
  it('assertToolList refuses every unpublishable list and passes a usable one through unchanged', () => {
    const ok = [{ name: 'a', description: 'd', inputSchema: { type: 'object' } }];
    expect(assertToolList(ok)).toBe(ok);
    const refused: Array<[unknown, RegExp]> = [
      [[], /0 tools/],
      [[{ name: '', description: 'd', inputSchema: {} }], /no name/],
      [[{ name: 'a', description: '  ', inputSchema: {} }], /a: no description/],
      [[{ name: 'a', inputSchema: {} }], /a: no description/],
      [[{ name: 'a', description: 'd', inputSchema: {} }, { name: 'a', description: 'e', inputSchema: {} }], /a: duplicate name/],
      [[{ name: 'a', description: 'd', inputSchema: null }], /a: inputSchema is not an object/],
      [[{ name: 'a', description: 'd', inputSchema: [] }], /a: inputSchema is not an object/],
    ];
    for (const [tools, why] of refused) expect(() => assertToolList(tools)).toThrowError(why);
  });

  function runGeneratorAgainstStub(stubTools: unknown[]) {
    const root = mkdtempSync(join(tmpdir(), 'kb-failclosed-'));
    try {
      mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
      mkdirSync(join(root, 'dist'), { recursive: true });
      copyFileSync(join(REPO_ROOT, 'scripts', 'build-knowledge-json.mjs'), join(root, 'scripts', 'build-knowledge-json.mjs'));
      copyFileSync(join(REPO_ROOT, 'scripts', 'lib', 'mcp-tools-list.mjs'), join(root, 'scripts', 'lib', 'mcp-tools-list.mjs'));
      symlinkSync(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'kb-failclosed-stub', version: '0.0.0' }));
      writeFileSync(join(root, 'README.md'), "## What's new in v0.0.0\n\nstub\n");
      // A REAL MCP server (the SDK's low-level Server) whose tools/list serves exactly stubTools.
      writeFileSync(
        join(root, 'dist', 'index.js'),
        [
          "const { Server } = require('@modelcontextprotocol/sdk/server/index.js');",
          "const { ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');",
          'exports.createSandboxServer = () => {',
          "  const s = new Server({ name: 'kb-failclosed-stub', version: '0.0.0' }, { capabilities: { tools: {} } });",
          `  s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ${JSON.stringify(stubTools)} }));`,
          '  return s;',
          '};',
        ].join('\n'),
      );
      const r = spawnSync(process.execPath, [join(root, 'scripts', 'build-knowledge-json.mjs')], { cwd: root, encoding: 'utf8' });
      return { status: r.status, stderr: r.stderr, wroteBundle: existsSync(join(root, 'dist', 'knowledge', 'latest.json')) };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('the generator exits 1 and writes NO bundle when tools/list yields 0 tools', () => {
    const r = runGeneratorAgainstStub([]);
    expect(r.stderr).toMatch(/0 tools/);
    expect(r.status).toBe(1);
    expect(r.wroteBundle).toBe(false);
  });

  it('the generator exits 1 and writes NO bundle when a served tool has no description', () => {
    const r = runGeneratorAgainstStub([{ name: 'undescribed_tool', inputSchema: { type: 'object', properties: {} } }]);
    expect(r.stderr).toMatch(/undescribed_tool: no description/);
    expect(r.status).toBe(1);
    expect(r.wroteBundle).toBe(false);
  });
});
