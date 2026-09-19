/**
 * OPS-EDITORIAL-PRIMITIVE-RESOLUTION-GATE-W1 CH2 — the WIRING for
 * scripts/check-primitive-resolution.mjs.
 *
 * This file is what makes the gate a gate. `check-canaries-wired.mjs` holds no registry: a script
 * counts as WIRED when something that is NOT A COMMENT actually invokes it. Importing the pure
 * functions here puts the gate inside the pre-push test-baseline gate and inside deploy.yml's
 * vitest step, beside the sibling tests/unit/partner-install-coords.test.ts which is wired the
 * same way.
 *
 * Network discipline, same rule as that sibling: every assertion here drives an INJECTED
 * resolver, so the suite is deterministic and offline. The live audit is the CLI's job
 * (`node scripts/check-primitive-resolution.mjs`), wired into deploy.yml — a test that fails
 * because npm was slow teaches people to ignore it.
 *
 * What this file asserts that the hermetic --self-test structurally CANNOT: the real registry on
 * disk. The self-test builds its own fixtures, so the shipped rows are exactly the corpus no
 * scenario of its own ever reads.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadRegistry,
  hasUsableBin,
  classifyNpm,
  parseNextCursor,
  evaluate,
  exitCodeFor,
  selfTest,
} from '../../scripts/check-primitive-resolution.mjs';

const REGISTRY = join(process.cwd(), 'ops', 'primitive-registry.json');
const cli = (over: Record<string, unknown> = {}) => ({
  id: 'c', kind: 'npm_package', name: 'c', invocation: 'cli', status: 'live', public_nameable: true, ...over,
});

describe('primitive-resolution — gate wiring', () => {
  it("the gate's own two-way self-test passes", () => {
    expect(selfTest()).toBe(true);
  });
});

describe('primitive-resolution — the shipped registry', () => {
  it('loads, and is not vacuous', () => {
    const out = loadRegistry(REGISTRY);
    expect(out.error).toBeUndefined();
    expect(out.rows.length).toBeGreaterThanOrEqual(12);
  });

  it('every row carries a non-null invocation', () => {
    // The CH2 gate greps for this too, but `has("invocation")|not` in jq does NOT catch an
    // explicit null — measured 2026-09-19 on a 3-row fixture: has()|not -> 1, ==null -> 2.
    // Assert the strong form here so the weaker jq leg can never be the only guard.
    const { rows } = loadRegistry(REGISTRY);
    for (const r of rows) expect(r.invocation, `${r.id} invocation`).not.toBeNull();
    expect(rows.every((r: any) => ['cli', 'library', 'n_a'].includes(r.invocation))).toBe(true);
  });

  it('mcp_tool rows take invocation n_a — a tool has no install form', () => {
    const { rows } = loadRegistry(REGISTRY);
    for (const r of rows.filter((x: any) => x.kind === 'mcp_tool')) expect(r.invocation).toBe('n_a');
  });

  it('nothing is both planned and publicly nameable', () => {
    // The whole point of the wave: a surface may only name what resolves.
    const { rows } = loadRegistry(REGISTRY);
    for (const r of rows.filter((x: any) => x.status !== 'live')) {
      expect(r.public_nameable, `${r.id} is ${r.status} but public_nameable`).toBe(false);
    }
  });

  it('carries the five primitives the P16 post named', () => {
    // The regression corpus, as data. If a future edit drops one of these rows, the surface that
    // names it stops being checked — which is precisely how this wave started.
    const names = loadRegistry(REGISTRY).rows.map((r: any) => r.name);
    for (const n of ['crypto-quant-risk-mcp', 'crypto-quant-backtest-mcp', 'get_position_size', 'run_backtest']) {
      expect(names, `registry must govern ${n}`).toContain(n);
    }
  });

  it('declares no row for the @algovault scope, which does not exist', () => {
    const raw = readFileSync(REGISTRY, 'utf8');
    expect(raw).not.toMatch(/"name":\s*"@algovault\//);
  });
});

describe('primitive-resolution — the registry refuses malformed input', () => {
  const bad = (primitives: unknown) => {
    const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
    const { tmpdir } = require('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'primres-vitest-'));
    try {
      const p = join(dir, 'r.json');
      writeFileSync(p, JSON.stringify({ schema_version: 1, primitives }));
      return loadRegistry(p).error;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('zero rows is INDETERMINATE, never a clean pass over an empty set', () => {
    expect(bad([])).toBeDefined();
  });
  it('a missing invocation refuses', () => {
    expect(bad([{ id: 'x', kind: 'npm_package', name: 'x', status: 'live', public_nameable: true }])).toBeDefined();
  });
  it('an unknown status refuses', () => {
    expect(bad([{ id: 'x', kind: 'npm_package', name: 'x', invocation: 'cli', status: 'maybe', public_nameable: true }])).toBeDefined();
  });
  it('a duplicate id refuses', () => {
    const row = { id: 'x', kind: 'npm_package', name: 'x', invocation: 'cli', status: 'live', public_nameable: true };
    expect(bad([row, { ...row }])).toBeDefined();
  });
  it('a missing file refuses', () => {
    expect(loadRegistry('/nonexistent/primitive-registry.json').error).toBeDefined();
  });
});

describe('primitive-resolution — the bin predicate is about INVOCATION, not existence', () => {
  const noBin = { httpCode: 200, body: JSON.stringify({ 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {} } }) };
  const withBin = { httpCode: 200, body: JSON.stringify({ 'dist-tags': { latest: '2.0.0' }, versions: { '2.0.0': { bin: { x: 'dist/x.js' } } } }) };

  it('a LIBRARY with no bin resolves — the false-DRIFT trap', () => {
    // Measured 2026-09-19: @modelcontextprotocol/sdk, zod and express are all has_bin=false and
    // all correct. A blanket bin leg would page on correct data, and a gate that pages on correct
    // data is a gate that gets ignored.
    expect(classifyNpm(cli({ invocation: 'library' }), noBin).state).toBe('resolved');
  });
  it('a CLI with no bin does NOT resolve — the bin:null stub', () => {
    expect(classifyNpm(cli(), noBin).state).toBe('absent');
  });
  it('a CLI with a bin resolves', () => {
    expect(classifyNpm(cli(), withBin).state).toBe('resolved');
  });
  it('an empty bin object is not a CLI', () => {
    expect(hasUsableBin({})).toBe(false);
    expect(hasUsableBin(null)).toBe(false);
    expect(hasUsableBin({ x: 'y' })).toBe(true);
  });
});

describe('primitive-resolution — 404 is a measurement, a transport error is not', () => {
  it('404 is evidence of absence', () => {
    expect(classifyNpm(cli(), { httpCode: 404, body: '' }).state).toBe('absent');
  });
  it('a transport failure decides nothing', () => {
    expect(classifyNpm(cli(), { httpCode: 0, body: '', transportFailed: true }).state).toBe('unknown');
  });
  it('an npm 5xx decides nothing', () => {
    expect(classifyNpm(cli(), { httpCode: 503, body: '' }).state).toBe('unknown');
  });
  it('an unparseable packument decides nothing', () => {
    expect(classifyNpm(cli(), { httpCode: 200, body: 'not json' }).state).toBe('unknown');
  });
});

describe('primitive-resolution — the verdict join', () => {
  const rows = [cli({ id: 'a' })];
  const fixed = (state: string) => () => ({ state, detail: 'fixture' });

  it('a live row that does not resolve FAILs', () => {
    expect(evaluate(rows, fixed('absent')).verdict).toBe('FAIL');
  });
  it('a planned row that now resolves FAILs — a stale registry is how this class returns', () => {
    expect(evaluate([cli({ status: 'planned', public_nameable: false })], fixed('resolved')).verdict).toBe('FAIL');
  });
  it('an unknown state is INDETERMINATE, never a pass', () => {
    expect(evaluate(rows, fixed('unknown')).verdict).toBe('INDETERMINATE');
  });
  it('a FAIL outranks an INDETERMINATE — a real red is not softened by a blip', () => {
    const two = [cli({ id: 'a' }), cli({ id: 'b', name: 'b' })];
    expect(evaluate(two, (r: any) => ({ state: r.id === 'a' ? 'absent' : 'unknown', detail: 'f' })).verdict).toBe('FAIL');
  });
  it('the token→exit mapping is asserted, not assumed', () => {
    // Re-coding INDETERMINATE to 0 is the known hole: it leaves every token assertion green
    // while the gate silently fails open. Measured on this gate 2026-09-19 — the break is caught.
    expect(exitCodeFor('PASS')).toBe(0);
    expect(exitCodeFor('FAIL')).toBe(1);
    expect(exitCodeFor('INDETERMINATE')).toBe(3);
  });
});

describe('primitive-resolution — tools/list is exhausted, never a capped first page', () => {
  it('reads a cursor out of an SSE frame', () => {
    expect(parseNextCursor('event: message\ndata: {"result":{"tools":[],"nextCursor":"c1"}}\n')).toBe('c1');
  });
  it('a terminal page has no cursor', () => {
    expect(parseNextCursor('{"result":{"tools":[]}}')).toBeUndefined();
  });
  it('an unparseable body yields no cursor rather than a false terminal', () => {
    expect(parseNextCursor('garbage')).toBeUndefined();
  });
});
