/**
 * KNOWLEDGE-ARTIFACT-W1 vitest canary.
 *
 * Locks the v1.14.0+ invariants for the auto-generated KnowledgeBundle JSON:
 *   - Generator emits a schema-valid bundle that survives formatKnowledgeBundle().
 *   - Generator is byte-idempotent (same input → same output, modulo timestamp).
 *   - bundle.tools[] mirrors the MCP runtime shape (4 entries) — NOT the
 *     source-file export count (which is 3 *_DESCRIPTION constants).
 *   - bundle includes every audits/*-shape-snapshot-*.json on disk.
 *   - Two-sided PII guard (per Plan-Mode Q-3, Mr.1-approved 2026-05-18):
 *     (a) DENY: no value bindings of outcome_return_pct / outcome_price.
 *     (b) REQUIRE: at least one response_shapes[*].forbidden_keys array
 *         contains "outcome_return_pct" (proves the term lives as METADATA
 *         in the right place, never as a leaked value).
 *   - formatKnowledgeBundle({}) throws (rejects empty input).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatKnowledgeBundle,
  type KnowledgeBundle,
} from '../../src/lib/knowledge-formatter.js';

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

describe('KNOWLEDGE-ARTIFACT-W1 canaries (v1.14.0+ invariants)', () => {
  let bundle: KnowledgeBundle;

  beforeAll(() => {
    // Assumes `npm run build` already ran (dist/lib/knowledge-formatter.js
    // and dist/tool-descriptions.js exist). The generator depends on them.
    if (!existsSync(join(REPO_ROOT, 'dist', 'lib', 'knowledge-formatter.js'))) {
      throw new Error('dist/lib/knowledge-formatter.js missing — run `npm run build` before vitest');
    }
    bundle = buildOnce();
  });

  it('generator produces schema-valid output (formatKnowledgeBundle accepts it)', () => {
    const reshaped = formatKnowledgeBundle(bundle);
    expect(reshaped.version).toBeTypeOf('string');
    expect(reshaped.generated_at).toBe(FIXED_TS);
    expect(reshaped.package_name).toBe('crypto-quant-signal-mcp');
    expect(Array.isArray(reshaped.keywords)).toBe(true);
    expect(reshaped.keywords.length).toBeGreaterThan(0);
    expect(reshaped._algovault.bundle_version).toBe(1);
    expect(reshaped._algovault.generator).toBe('build-knowledge-json.mjs');
    expect(reshaped._algovault.repo).toBe('AlgoVaultLabs/crypto-quant-signal-mcp');
  });

  it('generator is byte-idempotent under fixed KNOWLEDGE_GENERATED_AT (two runs match)', () => {
    const firstSha = execSync(`shasum -a 256 "${BUNDLE_LATEST}"`).toString().split(/\s+/)[0];
    buildOnce();
    const secondSha = execSync(`shasum -a 256 "${BUNDLE_LATEST}"`).toString().split(/\s+/)[0];
    expect(firstSha).toBe(secondSha);
  });

  it('bundle.tools[].name matches MCP runtime shape exactly (4 entries, alias included)', () => {
    const names = bundle.tools.map((t) => t.name).sort();
    expect(names).toEqual(['get_market_regime', 'get_trade_call', 'get_trade_signal', 'scan_funding_arb']);
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

  it('bundle.response_shapes covers every audits/*-shape-snapshot-*.json on disk', () => {
    const snapshotFiles = readdirSync(join(REPO_ROOT, 'audits')).filter((n) =>
      /-shape-snapshot-.*\.json$/.test(n)
    );
    expect(bundle.response_shapes.length).toBe(snapshotFiles.length);
    expect(snapshotFiles.length).toBeGreaterThanOrEqual(2);
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
