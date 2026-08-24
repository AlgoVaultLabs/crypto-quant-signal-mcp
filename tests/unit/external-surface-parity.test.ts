/**
 * External published-surface parity — EXTERNAL-SURFACE-PARITY-W1 CH3.
 *
 * Every gate this repo owns runs INSIDE this repo, so a listing published into a third-party
 * catalog is invisible to all of them. Measured: `servers/algovault-remote/tools.json` in the
 * Docker MCP catalog fork was hand-corrected by an earlier wave while `server.yaml` and
 * `readme.md` sat beside it advertising 91.6% / 375,000+ calls / 1,300+ assets against a live
 * 91.71% / 508,080 / 1,748. Nothing failed, because nothing was looking.
 *
 * This file is HERMETIC — it makes no network call. The live comparison is
 * `scripts/check-external-surface-parity.mjs`, run on demand; here we pin (a) that the registry
 * is structurally complete and asserts something for every row, and (b) that the gate's three
 * verdict branches behave, including the token -> EXIT CODE mapping, which a token-only
 * assertion leaves untested (CLAUDE.md: re-coding a mapping to 0 once left a suite fully green).
 *
 * The INDETERMINATE branch is proven by COPYING the script and an empty registry into a temp tree
 * and running it there — no env seam, no injection point. A test seam must never be able to print
 * PASS, so the gate is given no lever a fixture could pull.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  TOKEN,
  accessor,
  parsePublished,
  extractField,
  compareField,
  findSotFigures,
  evaluateSurface,
  rollup,
  loadRegistry,
} from '../../scripts/check-external-surface-parity.mjs';

const ROOT = join(__dirname, '..', '..');
const REGISTRY_PATH = join(ROOT, 'ops', 'published-surface-registry.json');
const SCRIPT_PATH = join(ROOT, 'scripts', 'check-external-surface-parity.mjs');

/** The live SoT as measured 2026-08-24T15:09:49Z — the values CH3 wrote the listing against. */
const SOT = { overall: { pfeWinRate: 0.9171295475683566 }, totalCalls: 508080, asset_count: 1748, timeframe_count: 11 };

describe('AC 3.1 — the published-surface registry is complete', () => {
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));

  it('enumerates at least the three Docker catalog surfaces', () => {
    const docker = registry.surfaces.filter((s: any) => s.repo === 'AlgoVaultFi/mcp-registry');
    expect(docker.length).toBeGreaterThanOrEqual(3);
    expect(docker.map((s: any) => s.path).sort()).toEqual([
      'servers/algovault-remote/readme.md',
      'servers/algovault-remote/server.yaml',
      'servers/algovault-remote/tools.json',
    ]);
  });

  it('every row carries repo, path, branch, PR, fields, refresh mechanism and owner', () => {
    for (const s of registry.surfaces) {
      for (const k of ['id', 'repo', 'path', 'branch', 'pr', 'raw_url', 'refresh_mechanism', 'owner']) {
        expect(s[k], `${s.id ?? '(unnamed)'} is missing ${k}`).toBeTruthy();
      }
      expect(Array.isArray(s.fields), `${s.id} has no fields[] array`).toBe(true);
    }
  });

  it('every row ASSERTS something — a row that verifies nothing is the vacuity this registry exists to close', () => {
    for (const s of registry.surfaces) {
      const asserts = s.fields.length > 0 || s.assert_no_sot_figures?.enabled === true;
      expect(asserts, `${s.id} declares no fields and no assert_no_sot_figures`).toBe(true);
    }
  });

  it('each raw_url is derived from that row\'s own repo, branch and path — no copy-paste drift', () => {
    for (const s of registry.surfaces) {
      expect(s.raw_url).toBe(`https://raw.githubusercontent.com/${s.repo}/${s.branch}/${s.path}`);
    }
  });

  it('records the refresh mechanism honestly — these surfaces have NO producer', () => {
    for (const s of registry.surfaces) {
      expect(s.refresh_mechanism).toMatch(/^MANUAL/);
    }
  });

  it('loadRegistry accepts the committed registry', () => {
    expect(loadRegistry(REGISTRY_PATH).surfaces.length).toBeGreaterThanOrEqual(3);
  });
});

describe('AC 3.4 — FAIL on a stale surface', () => {
  const PCT = { name: 'pfe', sot_accessor: 'overall.pfeWinRate', sot_scale: 100, published: '91.7%', extract: '(\\d{1,3}\\.\\d)% verified accuracy', tolerance: { type: 'EXACT_ROUNDED', dp: 1 } };
  const ASSETS = { name: 'assets', sot_accessor: 'asset_count', published: '1,700+', extract: '([\\d,]+)\\+ assets', tolerance: { type: 'FLOOR_BOUNDED', floor: 1700, step: 100 } };
  const CALLS = { name: 'calls', sot_accessor: 'totalCalls', published: '500,000+', extract: '([\\d,]+)\\+ calls', tolerance: { type: 'FLOOR_BOUNDED', floor: 500000, step: 100000 } };

  it('catches the ACTUAL historical defect: 91.6% against a live 91.71%', () => {
    const stale = { ...PCT, published: '91.6%' };
    const r = compareField(stale, accessor(SOT, 'overall.pfeWinRate'), extractField('with 91.6% verified accuracy across', stale));
    expect(r.verdict).toBe('FAIL');
  });

  it('catches the ACTUAL historical defect: 1,300+ assets against a live 1,748', () => {
    const stale = { ...ASSETS, published: '1,300+', tolerance: { type: 'FLOOR_BOUNDED', floor: 1300, step: 100 } };
    const r = compareField(stale, SOT.asset_count, extractField('L2. 1,300+ assets, 11 timeframes.', stale));
    expect(r.verdict).toBe('FAIL');
    expect(r.detail).toMatch(/materially understated/);
  });

  it('catches the ACTUAL historical defect: 375,000+ calls against a live 508,080', () => {
    const stale = { ...CALLS, published: '375,000+', tolerance: { type: 'FLOOR_BOUNDED', floor: 375000, step: 25000 } };
    const r = compareField(stale, SOT.totalCalls, extractField('accuracy across 375,000+ calls.', stale));
    expect(r.verdict).toBe('FAIL');
  });

  it('max_steps defaults to 1, and a looser bound would have ACCEPTED the real defect', () => {
    // The first draft used max_steps=2. At 100k granularity that gives [375000, 575000), which
    // contains the live 508,080 — the bound would have passed the very figure this wave fixed.
    const loose = { ...CALLS, published: '375,000+', tolerance: { type: 'FLOOR_BOUNDED', floor: 375000, step: 100000, max_steps: 2 } };
    expect(compareField(loose, SOT.totalCalls, { found: true, literal: '375,000' }).verdict).toBe('PASS');
  });

  it('a bare floor would NOT have caught them — which is why the bound is two-sided', () => {
    // 1,300 <= 1,748 is true, so a one-sided floor passes the very defect this wave fixed.
    expect(1300 <= SOT.asset_count).toBe(true);
    expect(375000 <= SOT.totalCalls).toBe(true);
  });

  it('catches a SoT regression below the published floor', () => {
    expect(compareField(ASSETS, 1200, { found: true, literal: '1,700' }).verdict).toBe('FAIL');
  });

  it('catches the surface being reworded behind the registry\'s back', () => {
    expect(compareField(PCT, 0.917, { found: true, literal: '90.2' }).verdict).toBe('FAIL');
  });

  it('catches a selector that matches nothing — a definite defect, not an unknown', () => {
    expect(compareField(PCT, 0.917, extractField('no such claim on this page', PCT)).verdict).toBe('FAIL');
  });

  it('catches a figure-free surface that grows a figure', () => {
    expect(findSotFigures('now with 91.7% verified accuracy').length).toBeGreaterThan(0);
    expect(findSotFigures('{"limit":{"default":25,"max":2000}}')).toHaveLength(0);
    expect(evaluateSurface({ id: 'x', assert_no_sot_figures: { enabled: true } }, 'across 508,080 calls', SOT).verdict).toBe('FAIL');
  });

  it('catches a venue count on listing copy (standing policy)', () => {
    const s = { id: 'x', fields: [], assert_no_sot_figures: { enabled: true }, forbidden: { venue_count: 'y' } };
    expect(evaluateSurface(s, 'analysis across 15 exchanges', SOT).verdict).toBe('FAIL');
    expect(evaluateSurface(s, 'cross-venue funding analysis', SOT).verdict).toBe('PASS');
  });
});

describe('AC 3.4 — PASS on the corrected surfaces', () => {
  it('the corrected server.yaml text passes every declared field', () => {
    const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
    const s = registry.surfaces.find((x: any) => x.id === 'docker-mcp-registry-server-yaml');
    const text = '  description: "91.7% verified trading intelligence for AI agents. Composite verdicts, regime classification, 1,700+ assets. Merkle-verified on Base L2."';
    // server.yaml's win-rate selector is its own phrasing, so drive it through the real row.
    const r = evaluateSurface(s, text, SOT);
    expect(r.verdict, JSON.stringify(r.checks)).toBe('PASS');
  });

  it('the corrected readme.md text passes every declared field', () => {
    const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
    const s = registry.surfaces.find((x: any) => x.id === 'docker-mcp-registry-readme');
    const text =
      'AI trading intelligence with 91.7% verified accuracy across 500,000+ calls. Composite BUY/SELL/HOLD verdicts ' +
      'with confidence, regime classification, and cross-venue funding analysis. Track record Merkle-verified on Base L2. ' +
      '1,700+ assets, 11 timeframes. Free tier available.';
    const r = evaluateSurface(s, text, SOT);
    expect(r.verdict, JSON.stringify(r.checks)).toBe('PASS');
  });

  it('parsePublished normalises the unit away so one row carries the human-readable form', () => {
    expect(parsePublished('91.7%')).toBe(91.7);
    expect(parsePublished('1,700+')).toBe(1700);
    expect(parsePublished('11')).toBe(11);
    expect(Number.isNaN(parsePublished('n/a'))).toBe(true);
  });
});

describe('AC 3.4 — INDETERMINATE, never PASS, on an unreachable surface', () => {
  it('an unreachable surface makes the run INDETERMINATE', () => {
    expect(rollup([{ verdict: 'PASS' }, { verdict: 'INDETERMINATE' }])).toBe('INDETERMINATE');
  });

  it('a definite FAIL outranks an INDETERMINATE — evidence in hand is not spent on "unknown"', () => {
    expect(rollup([{ verdict: 'INDETERMINATE' }, { verdict: 'FAIL' }])).toBe('FAIL');
  });

  it('an empty result set can never be a PASS', () => {
    expect(rollup([])).toBe('INDETERMINATE');
  });

  it('an empty surfaces[] REFUSES — we construct this corpus, so empty means we built nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'espw1-vac.'));
    const f = join(dir, 'r.json');
    writeFileSync(f, JSON.stringify({ surfaces: [] }));
    expect(() => loadRegistry(f)).toThrow(/EMPTY/);
  });

  it('a row missing a required key REFUSES', () => {
    const dir = mkdtempSync(join(tmpdir(), 'espw1-req.'));
    const f = join(dir, 'r.json');
    writeFileSync(f, JSON.stringify({ surfaces: [{ id: 'x', repo: 'a/b', path: 'p', branch: 'm', raw_url: 'u', owner: 'o' }] }));
    expect(() => loadRegistry(f)).toThrow(/refresh_mechanism/);
  });
});

describe('token -> EXIT CODE mapping (asserted, not assumed)', () => {
  it('--self-test exits 0 and prints the PASS token', { timeout: 30000 }, () => {
    const r = spawnSync(process.execPath, [SCRIPT_PATH, '--self-test'], { encoding: 'utf8', timeout: 30_000 });
    expect(r.stdout, r.stderr).toContain(`${TOKEN}=PASS`);
    expect(r.status).toBe(0);
  });

  it('an unusable registry exits 3 with the INDETERMINATE token', { timeout: 30000 }, () => {
    // No env seam and no injection point: copy the script + an EMPTY registry into a temp tree
    // that preserves the relative layout, and run the real file there.
    const dir = mkdtempSync(join(tmpdir(), 'espw1-tree.'));
    mkdirSync(join(dir, 'scripts'));
    mkdirSync(join(dir, 'ops'));
    copyFileSync(SCRIPT_PATH, join(dir, 'scripts', 'check-external-surface-parity.mjs'));
    writeFileSync(join(dir, 'ops', 'published-surface-registry.json'), JSON.stringify({ surfaces: [] }));

    const r = spawnSync(process.execPath, [join(dir, 'scripts', 'check-external-surface-parity.mjs')], { encoding: 'utf8', timeout: 30_000 });
    expect(r.stdout, r.stderr).toContain(`${TOKEN}=INDETERMINATE`);
    expect(r.status).toBe(3);
  });
});
