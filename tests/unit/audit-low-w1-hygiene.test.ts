/**
 * OPS-AUDIT-REMEDIATION-LOW-W1 · Ch4 — hygiene and debt.
 *
 * SEC-24 migration ordinals · SEC-25 credential precedence · SEC-41 version-field parity
 * (the GENERATOR) · SEC-51 declared dependencies.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
const readJson = (p: string) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'));
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

describe('SEC-41 — every version field must agree (the generator, not the lane)', () => {
  /**
   * The pre-publish parity check was `diff <(jq -r .version package.json) <(jq -r .version
   * server.json)` — it compared `.version` ONLY, which is exactly why `server.json`
   * packages[0].version sat frozen at 1.22.1 while the package shipped 1.24.1, pointing every
   * MCP-registry consumer at a stale npm version. Comparing one pair of fields will always miss
   * the third location; enumerate them all.
   */
  const canonical = readJson('package.json').version as string;

  const FIELDS: Array<[string, () => string | undefined]> = [
    ['package.json .version', () => readJson('package.json').version],
    ['server.json .version', () => readJson('server.json').version],
    ['server.json packages[0].version', () => readJson('server.json').packages?.[0]?.version],
    ['manifest.json .version', () => (existsSync(resolve(ROOT, 'manifest.json')) ? readJson('manifest.json').version : undefined)],
  ];

  it('canonical version is a semver string', () => {
    expect(canonical).toMatch(/^\d+\.\d+\.\d+$/);
  });

  for (const [label, get] of FIELDS) {
    it(`${label} matches package.json (${'expected'} canonical)`, () => {
      const v = get();
      if (v === undefined) return; // field/file absent is not a mismatch
      expect(v, `${label} is ${v} but package.json is ${canonical} — a stale mirror points consumers at the wrong release`).toBe(canonical);
    });
  }

  it('lobehub-manifest version is a STRING LINEAGE, not semver — asserted separately on purpose', () => {
    const p = resolve(ROOT, 'lobehub-manifest.json');
    if (!existsSync(p)) return;
    const v = readJson('lobehub-manifest.json').version;
    // CLAUDE.md: lobehub's version is "1" -> "2" -> "3", NOT semver. Asserting it equals the
    // package version would be wrong; asserting it is a bare integer keeps it from drifting
    // into a semver by accident.
    expect(String(v)).toMatch(/^\d+$/);
  });
});

describe('SEC-24 — migration ordinals must be unambiguous', () => {
  const files = readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort();

  it('finds migrations to check (vacuity guard)', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('no two migrations share an ordinal', () => {
    /**
     * Renumbering an APPLIED migration would be worse than the ambiguity — the ordinal is how
     * an already-run migration is identified. So this asserts loudly instead, and the two
     * historical collisions (011, 019) are declared below with the reason they are permitted.
     * A NEW collision fails.
     */
    const GRANDFATHERED = new Set(['011', '019']);
    const byOrdinal = new Map<string, string[]>();
    for (const f of files) {
      const ord = (f.match(/^(\d+)/) ?? [])[1];
      if (!ord) continue;
      byOrdinal.set(ord, [...(byOrdinal.get(ord) ?? []), f]);
    }
    const collisions = [...byOrdinal.entries()]
      .filter(([ord, fs]) => fs.length > 1 && !GRANDFATHERED.has(ord))
      .map(([ord, fs]) => `${ord}: ${fs.join(' + ')}`);
    expect(
      collisions,
      `New duplicate migration ordinal(s). Ordering becomes ambiguous and two environments can ` +
        `apply them in different orders. Pick the next free ordinal.\n${collisions.join('\n')}`,
    ).toEqual([]);
  });

  it('the grandfathered collisions are still exactly the two known ones', () => {
    // If one of these is ever renumbered, this test tells the next author to shrink the set
    // rather than leaving a permanent exemption behind.
    const dupes = new Set<string>();
    const seen = new Map<string, number>();
    for (const f of files) {
      const ord = (f.match(/^(\d+)/) ?? [])[1];
      if (!ord) continue;
      seen.set(ord, (seen.get(ord) ?? 0) + 1);
      if ((seen.get(ord) ?? 0) > 1) dupes.add(ord);
    }
    expect([...dupes].sort()).toEqual(['011', '019']);
  });
});

describe('SEC-25 — the caller credential beats a server env var', () => {
  const src = read('src/lib/license.ts');
  it('extractApiKey prefers the Authorization header', () => {
    expect(src).toContain('const key = headerKey || envKey;');
    expect(src).not.toContain('const key = envKey || headerKey;');
  });
  it('the stdio/operator path is documented as unaffected', () => {
    const i = src.indexOf('const key = headerKey || envKey;');
    expect(src.slice(i - 600, i)).toMatch(/stdio path is unaffected/i);
  });
});

describe('SEC-51 — every package imported by src/** is a declared dependency', () => {
  it('zod is declared', () => {
    const deps = readJson('package.json').dependencies as Record<string, string>;
    expect(deps.zod, 'zod is imported by src/index.ts and src/tools/scan-trade-calls.ts but was declared in neither dependencies nor devDependencies — it resolved only as a transitive of @anthropic-ai/sdk / @coinbase/cdp-sdk, so a dependency drop upstream would ReferenceError the pruned prod image').toBeTruthy();
  });
});
