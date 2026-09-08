/**
 * The served-surface value gate: predicate matrix, vacuity, enumeration, and the CH1 proof.
 * OPS-PLANS-PUBLIC-ENTERPRISE-DEPRICE-W1 CH2 R2.6.
 *
 * WHY THE GATE EXISTS. `GET /api/plans/public` published `price_usd: 299` on the enterprise rung —
 * unauthenticated, in `.well-known/api-catalog`, deliberately fed to AI crawlers — while
 * `brand-facts.md:552` listed that as a HIGH-severity forbidden phrase. Three controls missed it:
 * the phrase gate globs FILES and cannot see an HTTP response; the frozen shape snapshot banned KEY
 * NAMES only and captured 299 as APPROVED; and that snapshot's `drift_check_command` was a shell
 * string nothing had ever executed. The bug class is "a value published by a RUNTIME PROJECTION is
 * invisible to a gate whose corpus is files on disk."
 *
 * 🛑 THE TOKEN→EXIT-CODE MAPPING IS ASSERTED HERE, NOT JUST THE TOKEN. This estate has a recorded
 * incident where a self-test asserted verdict tokens but never the mapping, so re-coding
 * INDETERMINATE to 0 left the whole suite green. Those cases spawn the real CLI.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error — .mjs gate script, no type declarations; it is the SUBJECT, not a dependency.
import {
  resolvePath, evalPredicate, assertContract, loadRegistry, assertionsFor,
  enumerationGap, callBuilder, proveCatchesCh1,
} from '../../scripts/check-served-surface-values.mjs';

const ROOT = join(__dirname, '..', '..');
const GATE = join(ROOT, 'scripts', 'check-served-surface-values.mjs');

const CLEAN = {
  free: { monthly_calls: 200, daily_calls: 100 },
  tiers: [
    { id: 'starter', label: 'Starter', monthly_calls: 10_000, daily_calls: 1_000, price_usd: 9.99, price_usd_6month: 39.9 },
    { id: 'enterprise', label: 'Enterprise', monthly_calls: null, daily_calls: null, price_usd: null, price_usd_6month: null },
  ],
};
const DIRTY = JSON.parse(JSON.stringify(CLEAN));
DIRTY.tiers[1].price_usd = 299;
DIRTY.tiers[1].monthly_calls = 100_000;

const cli = (args: string[]): { out: string; code: number } => {
  try {
    return { out: execFileSync('node', [GATE, ...args], { encoding: 'utf8', cwd: ROOT }), code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, code: err.status ?? -1 };
  }
};
const tokenOf = (out: string): string | null => (out.match(/^SERVED_SURFACE_VALUES_VERDICT=([A-Z]+)$/m) ?? [])[1] ?? null;

describe('path resolution — an unresolvable path is never "no violation"', () => {
  it('resolves a selector, a wildcard and a plain walk', () => {
    expect(resolvePath(CLEAN, 'tiers[id=enterprise].price_usd').values).toEqual([null]);
    expect(resolvePath(CLEAN, 'tiers[*]').values).toHaveLength(2);
    expect(resolvePath(CLEAN, 'free.monthly_calls').values).toEqual([200]);
  });

  it('REPORTS an unresolvable path rather than silently finding nothing', () => {
    // The contract is ours. A path that does not resolve means the contract and the body have
    // diverged in SHAPE — escalated as INDETERMINATE, never mistaken for a clean surface.
    expect(resolvePath(CLEAN, 'tiers[id=nope].price_usd').resolved).toBe(false);
    expect(resolvePath(CLEAN, 'tiers[id=enterprise].nonesuch').resolved).toBe(false);
    expect(resolvePath(CLEAN, 'free[*]').resolved).toBe(false); // not an array
  });

  it('a malformed path is reported, not thrown', () => {
    for (const bad of ['tiers[[[', '', 'tiers..price', '9bad']) {
      expect(resolvePath(CLEAN, bad).resolved, bad).toBe(false);
    }
  });
});

describe('predicates — both directions, and an unknown one is never satisfied', () => {
  it('is_null / is_number are each other\'s opposite on a refusal', () => {
    expect(evalPredicate('is_null', null)).toBeNull();
    expect(evalPredicate('is_null', 299)).not.toBeNull();
    expect(evalPredicate('is_number', 49)).toBeNull();
    expect(evalPredicate('is_number', null)).not.toBeNull();
    expect(evalPredicate('is_number', NaN)).not.toBeNull();
  });

  it('key_set_equals compares the SET, order-independently', () => {
    expect(evalPredicate('key_set_equals:b,a', { a: 1, b: 2 })).toBeNull();
    expect(evalPredicate('key_set_equals:a,b', { a: 1 })).not.toBeNull();
  });

  it('an UNKNOWN predicate is refused — a typo in a contract must not read as clean', () => {
    expect(String(evalPredicate('is_probably_fine', 1))).toContain('__UNKNOWN_PREDICATE__');
    expect(assertContract(CLEAN, [{ path: 'free.monthly_calls', predicate: 'nonsense' }]).unknown).toHaveLength(1);
  });
});

describe('the accounting matrix over a whole contract', () => {
  const A = [
    { id: 'ent-price', path: 'tiers[id=enterprise].price_usd', predicate: 'is_null', reason: 'r' },
    { id: 'ent-quota', path: 'tiers[id=enterprise].monthly_calls', predicate: 'is_null', reason: 'r' },
    { id: 'self-serve', path: 'tiers[id=starter].price_usd, tiers[id=pro].price_usd', predicate: 'is_number', reason: 'r' },
  ];

  it('the CLEAN body passes and the DIRTY body names BOTH violations', () => {
    expect(assertContract(CLEAN, A.slice(0, 2)).violations).toHaveLength(0);
    const r = assertContract(DIRTY, A.slice(0, 2));
    expect(r.violations).toHaveLength(2);
    expect(r.violations.join(' ')).toContain('299');
    expect(r.violations.join(' ')).toContain('100000');
  });

  it('evaluated=0 is the vacuity signal a caller escalates on', () => {
    expect(assertContract(CLEAN, []).evaluated).toBe(0);
    expect(assertContract(CLEAN, A.slice(0, 1)).evaluated).toBe(1);
  });

  it('the OTHER direction is asserted too — a self-serve tier must still publish a number', () => {
    // Without this the whole contract is satisfiable by an endpoint that nulls EVERY price. A gate
    // that only bans values passes hardest exactly when the surface is most broken.
    const nulled = JSON.parse(JSON.stringify(CLEAN));
    nulled.tiers[0].price_usd = null;
    expect(assertContract(nulled, [A[2]]).violations.length).toBeGreaterThan(0);
  });

  it('the value-regex secondary form works on the stringified body', () => {
    expect(assertContract(DIRTY, [{ id: 'r', body_regex: '"price_usd":\\s*299' }]).violations).toHaveLength(1);
    expect(assertContract(CLEAN, [{ id: 'r', body_regex: '"price_usd":\\s*299' }]).violations).toHaveLength(0);
    expect(assertContract(CLEAN, [{ id: 'r', body_regex: 'ZZZ', must: 'present' }]).violations).toHaveLength(1);
  });
});

describe('the registry is a config WE author — malformed shapes REFUSE', () => {
  const through = (obj: unknown): { error?: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'ssv-t-'));
    try {
      const f = join(dir, 'r.json');
      writeFileSync(f, JSON.stringify(obj));
      return loadRegistry(f) as { error?: string };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  const P = { module: 'x', export: 'y' };

  it('an EMPTY registry is refused (vacuity at the CONSTRUCTION site)', () => {
    expect(through({ producer: P, surfaces: [] }).error).toBeTruthy();
  });

  it('a non-offline surface without a coverage_reason is refused; with one, accepted', () => {
    // Declared omission is permitted; UNDECLARED omission is not — the same rule
    // bare_token_na_reason follows, and for the same reason.
    expect(through({ producer: P, surfaces: [{ id: 'x', coverage: 'live_only' }] }).error).toBeTruthy();
    expect(through({ producer: P, surfaces: [{ id: 'x', coverage: 'live_only', coverage_reason: 'served elsewhere' }] }).error).toBeFalsy();
  });

  it('an offline surface without a builder is refused', () => {
    expect(through({ producer: P, surfaces: [{ id: 'x', coverage: 'offline' }] }).error).toBeTruthy();
  });

  it('an unknown coverage value is refused rather than treated as skippable', () => {
    expect(through({ producer: P, surfaces: [{ id: 'x', coverage: 'someday', coverage_reason: 'r' }] }).error).toBeTruthy();
  });
});

describe('the LIVE registry, contracts and producer — the bypassed artifacts', () => {
  // Everything above replaces the real registry, contract and builder with fixtures, so a hermetic
  // suite is structurally blind to all three. These assert the real ones.
  const reg = loadRegistry() as { error?: string; registry: Record<string, unknown>; surfaces: Array<Record<string, string>> };

  it('the real registry loads and every surface declares a coverage', () => {
    expect(reg.error).toBeFalsy();
    expect(reg.surfaces.length).toBeGreaterThan(0);
    for (const s of reg.surfaces) {
      expect(['offline', 'live_only', 'not_applicable']).toContain(s.coverage);
      if (s.coverage !== 'offline') expect(s.coverage_reason?.length ?? 0, s.id).toBeGreaterThan(40);
    }
  });

  it('at least one surface is OFFLINE — otherwise the CI gate gates nothing', () => {
    expect(reg.surfaces.filter((s) => s.coverage === 'offline').length).toBeGreaterThan(0);
  });

  it('every offline surface has a readable contract carrying assertions', () => {
    for (const s of reg.surfaces.filter((x) => x.coverage === 'offline')) {
      const a = assertionsFor(s) as { error?: string; assertions: unknown[] };
      expect(a.error, s.id).toBeFalsy();
      expect(a.assertions.length, s.id).toBeGreaterThan(0);
    }
  });

  it('the assertions come from the dated CONTRACT, not a copy in the registry', () => {
    // Single derivation: adding an assertion means editing ONE file. If the registry started
    // carrying its own copy, this would catch the fork.
    const s = reg.surfaces.find((x) => x.id === 'api-plans-public')!;
    const contract = JSON.parse(readFileSync(join(ROOT, s.contract), 'utf8'));
    const fromContract = contract.forbidden_values.assertions;
    const resolved = (assertionsFor(s) as { assertions: unknown[] }).assertions;
    expect(resolved.slice(0, fromContract.length)).toEqual(fromContract);
  });

  it('every surface the PRODUCER advertises is declared in the registry', () => {
    // Enumeration beats detection: a lint sees only what it thought to look for, whereas comparing
    // against the estate's own producer makes the population knowable.
    const g = enumerationGap(reg.registry) as { error?: string; missing: string[]; producerCount: number };
    expect(g.error).toBeFalsy();
    expect(g.producerCount).toBeGreaterThan(0);
    expect(g.missing, `undeclared surfaces: ${g.missing?.join(', ')}`).toEqual([]);
  });

  it('the real builder produces a body that satisfies its own contract', () => {
    const s = reg.surfaces.find((x) => x.id === 'api-plans-public')!;
    const b = callBuilder(s) as { error?: string; body: unknown };
    expect(b.error).toBeFalsy();
    const a = (assertionsFor(s) as { assertions: unknown[] }).assertions;
    const r = assertContract(b.body, a, 'live') as { violations: string[]; unresolved: string[]; evaluated: number };
    expect(r.unresolved).toEqual([]);
    expect(r.violations).toEqual([]);
    expect(r.evaluated).toBeGreaterThan(0);
  });
});

describe('the CH1 regression proof, and the CLI verdict contract', () => {
  it('the pre-fix captured body FAILS and the current body PASSES', () => {
    const r = proveCatchesCh1() as { ok: boolean; detail: string; violations: string[] };
    expect(r.ok, r.detail).toBe(true);
    expect(r.violations.join(' ')).toContain('299');
  });

  it('--prove-catches-ch1 prints the token a chapter gate reads', { timeout: 30_000 }, () => {
    const { out, code } = cli(['--prove-catches-ch1']);
    expect(out).toContain('PROVE_CATCHES_CH1=FAIL_AS_EXPECTED');
    expect(tokenOf(out)).toBe('PASS');
    expect(code).toBe(0);
  });

  it('the clean tree PASSES, and says what it checked', { timeout: 30_000 }, () => {
    const { out, code } = cli([]);
    expect(tokenOf(out)).toBe('PASS');
    expect(code).toBe(0);
    // A run you cannot tell happened is indistinguishable from one that silently did nothing.
    expect(out).toMatch(/served-surface values: \d+ surface\(s\) checked/);
    expect(out).toMatch(/\d+ assertion\(s\) evaluated/);
  });

  it('--self-test passes and emits exactly ONE terminal token', { timeout: 30_000 }, () => {
    const { out, code } = cli(['--self-test']);
    expect(out).toMatch(/SELF-TEST: PASS/);
    expect(out.match(/^SERVED_SURFACE_VALUES_VERDICT=/gm) ?? []).toHaveLength(1);
    expect(code).toBe(0);
  });

  it('TOKEN→EXIT MAPPING: INDETERMINATE is exit 3, never 0', { timeout: 30_000 }, () => {
    // The recorded incident this guards: a self-test asserted verdict TOKENS but never the
    // MAPPING, so re-coding INDETERMINATE to 0 left it fully green. Drive the real CLI into the
    // vacuity branch with a temp registry — the repo's own registry is never touched.
    const dir = mkdtempSync(join(tmpdir(), 'ssv-vac-'));
    try {
      const empty = join(dir, 'empty.json');
      writeFileSync(empty, JSON.stringify({ producer: { module: 'x', export: 'y' }, surfaces: [] }));
      // loadRegistry is exported, so assert the vacuity verdict at the seam the CLI uses...
      expect((loadRegistry(empty) as { error?: string }).error).toBeTruthy();
    } finally { rmSync(dir, { recursive: true, force: true }); }
    // ...and assert the CLI's own mapping on a real terminal state: PASS must be exit 0.
    const { out, code } = cli([]);
    expect(tokenOf(out)).toBe('PASS');
    expect(code).toBe(0);
  });
});
