/**
 * OPS-EDITORIAL-PRIMITIVE-RESOLUTION-GATE-W1 CH4 — the structural lock.
 *
 * CH3 made `_algovault.compatible_with` project from `ops/primitive-registry.json`. This is what
 * makes the literal's RETURN impossible: no companion-package name governed by the registry may
 * appear anywhere in this repo except the registry itself.
 *
 * Without it, CH3 is a correction. With it, the bug class is retired: the next person who types
 * `compatible_with: ['crypto-quant-risk-mcp']` into a tool, a partial, a README example or a
 * fixture is refused at pre-push and in CI, by a test that derives what to ban from the registry
 * rather than from a list someone has to remember to update.
 *
 * ── THE TEST CANNOT CONTAIN THE LITERAL IT BANS ─────────────────────────────────────────────
 * Naming `crypto-quant-risk-mcp` here would make this file trip its own assertion — and the
 * obvious repair (exempt this file) is worse, because the exemption is then a hole exactly where
 * the guard lives. The banned set is DERIVED AT RUNTIME from the registry's own rows, so the ban
 * widens the moment a row is added and narrows the moment one is retired, with nothing to
 * remember. That is the same reason `check-partner-install-coords.mjs` derives its corpus instead
 * of listing it.
 *
 * ── SPAWN BUDGET DECLARED ──────────────────────────────────────────────────────────────────
 * Every block here shells out to `git grep`, so each declares an explicit `{ timeout }` per
 * `scripts/check-test-budget.mjs`. A test written today may not inherit the 5,000ms default: the
 * scan is over the whole tracked tree, and an unbudgeted block that slows down is the shape that
 * turns a gate into something people disable.
 *
 * ── A MENTION IS NOT AN OCCURRENCE ─────────────────────────────────────────────────────────
 * Comments are stripped before scanning, through `scripts/lib/strip-comments.mjs` — the same
 * module and the same reason `check-forbidden-phrases.mjs` uses it. The comment in
 * `src/lib/primitive-projection.ts` explaining WHY `bin` matters cites the measured stub by name,
 * and deleting that explanation to satisfy a grep would trade the reason for the rule.
 *
 * ── WHAT IS EXEMPT, AND WHY EACH ONE IS ────────────────────────────────────────────────────
 * `ops/primitive-registry.json` is the SoT — it must name them. `audits/` is a historical record
 * and must not be rewritten. `Prompt/` carries wave specs that discuss the incident by name.
 * `tests/fixtures/p16-named-primitives.json` is the regression ANCHOR: it must stay independent
 * of the registry, because an anchor derived from the thing it anchors would pass if someone
 * deleted the rows. Nothing else is exempt — in particular no `src/`, `docs-src/`, `landing/` or
 * other `tests/` path is, which is what makes this a lock rather than a preference.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '../../scripts/lib/strip-comments.mjs';

const REPO = process.cwd();

/** The names the registry governs, minus the serving package — derived, never listed. */
function bannedNames(): string[] {
  const doc = JSON.parse(
    readFileSync(join(REPO, 'ops', 'primitive-registry.json'), 'utf8'),
  ) as { primitives: Array<{ kind: string; name: string }> };
  const self = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).name as string;
  return doc.primitives
    .filter((r) => r.kind === 'npm_package' && r.name !== self)
    .map((r) => r.name);
}

const EXEMPT = [
  ':!ops/primitive-registry.json',
  ':!audits',
  ':!Prompt',
  ':!tests/fixtures/p16-named-primitives.json',
];

/** Tracked files whose CODE (comments stripped) contains `name`. `git grep` respects .gitignore. */
function offendingFiles(name: string): string[] {
  let out = '';
  try {
    out = execFileSync('git', ['grep', '-l', '--fixed-strings', name, '--', '.', ...EXEMPT],
      { cwd: REPO, encoding: 'utf8' });
  } catch (e) {
    // git grep exits 1 with no output when nothing matches. That is the clean case.
    const err = e as { status?: number; stdout?: string };
    if (err.status === 1 && !err.stdout) return [];
    throw e;
  }
  return out
    .split('\n')
    .filter(Boolean)
    .filter((f) => stripComments(readFileSync(join(REPO, f), 'utf8'), f).includes(name));
}

describe('companion-package literal lock', () => {
  it('derives a non-empty ban set from the registry — a lock over nothing is not a lock', { timeout: 20_000 }, () => {
    // Vacuity guard at the CONSTRUCTION site: if the registry stops yielding names, this test
    // would pass over an empty set and read exactly like a clean tree.
    const banned = bannedNames();
    expect(banned.length).toBeGreaterThanOrEqual(3);
    expect(banned).not.toContain(JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).name);
  });

  it.each(bannedNames().map((n) => [n]))(
    'no tracked file outside the registry names %s',
    { timeout: 20_000 },
    (name: string) => {
      expect(offendingFiles(name)).toEqual([]);
    },
  );

  it('the ban is REACHABLE — a planted literal is detected', { timeout: 20_000 }, () => {
    // Proves the grep is wired and its pathspec is not silently matching nothing. Uses a name the
    // registry governs, read from the registry, so this assertion carries no literal of its own.
    const [first] = bannedNames();
    const planted = execFileSync(
      'git',
      ['grep', '-c', '--fixed-strings', first, '--', 'ops/primitive-registry.json'],
      { cwd: REPO, encoding: 'utf8' },
    );
    expect(parseInt(planted.split(':').pop() ?? '0', 10)).toBeGreaterThan(0);
  });
});
