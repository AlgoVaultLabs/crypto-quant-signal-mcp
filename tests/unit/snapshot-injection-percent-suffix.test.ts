/**
 * OPS-README-PCT-SUFFIX-W1 — the `data-tr-field-percent-suffix-discipline` canary (Design.md §6).
 *
 * `scripts/snapshot-landing-data.mjs` rewrites every `data-tr-field` span named by
 * `scripts/snapshot-landing-manifest.json`. For percentage claims the manifest's
 * `replace_template` is `"$1{value}%$2"` — the injector supplies the `%` INSIDE the span.
 * A template that ALSO carries a literal `%` right after `</span>` therefore renders a DOUBLE
 * percent once injected (`91.6%%`), even though the committed file reads perfectly.
 *
 * That is invisible to every pre-existing gate: the markup is valid, the span is present, the
 * value is live-bound, and the COMMITTED file renders correctly (which is what GitHub shows).
 * It only surfaces on the INJECTED artifact — the published npm README, the deployed landing
 * page — which no test looked at.
 *
 * v1.23.3 shipped exactly that to npm: README.md:14 (`pfe_wr`) and README.md:115 (`pfe_wr`,
 * `hold_rate`) all rendered `%%`. The Design.md §6 grep-guard already existed, but was
 * hardcoded to `landing/` — so when OPS-NPM-README-SINGLE-SOT-W1 (2026-05-31) added README.md
 * to those claims' `apply_to_files`, the guard never followed the new target.
 *
 * This canary therefore derives its scope FROM THE MANIFEST: it simulates the real injection
 * over every claim × every file in that claim's `apply_to_files`. A future wave that adds a
 * target file (or a new percentage claim) inherits the guard for free — no edit here required.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

interface Claim {
  id: string;
  find_pattern: string;
  replace_template: string;
  apply_to_files: string[];
  replace_all?: boolean;
  format: string;
}

const manifest = JSON.parse(read('scripts/snapshot-landing-manifest.json')) as { claims: Claim[] };

// None of the injector's formatters (integer / integer_with_commas / float_1dp / iso_to_human)
// can emit a '%', so every '%' in the injected output comes from replace_template alone. One
// value-shaped sentinel is therefore sufficient to expose a double-'%'.
const SENTINEL = '42.0';

/** Mirrors buildReplacement() in scripts/snapshot-landing-data.mjs. */
function buildReplacement(template: string, groups: string[], value: string): string {
  let out = template;
  for (let i = 1; i <= 9; i++) out = out.split(`$${i}`).join(groups[i] ?? '');
  return out.split('{value}').join(value);
}

/** Mirrors applyClaimToContent() in scripts/snapshot-landing-data.mjs. */
function applyClaim(content: string, claim: Claim, value: string): { newContent: string; count: number } {
  let count = 0;
  const re = new RegExp(claim.find_pattern, claim.replace_all ? 'g' : '');
  const newContent = content.replace(re, (...args: unknown[]) => {
    count++;
    // args = [match, ...captures, offset, string]
    const captures = args.slice(0, -2) as (string | undefined)[];
    const groups = [captures[0] as string, ...captures.slice(1).map((c) => c ?? '')];
    return buildReplacement(claim.replace_template, groups, value);
  });
  return { newContent, count };
}

/**
 * The two `%` are NEVER adjacent in the SOURCE — the defect reads `…42.0%</span>% PFE win rate`,
 * i.e. separated by the closing tag. It is only adjacent in the RENDERED text, which is what npm
 * and GitHub actually show. So strip tags before counting. (A naive /%%/ over the raw source
 * silently passes on the exact README that shipped the bug — verified during this wave.)
 */
const countRenderedDouble = (s: string) => (s.replace(/<[^>]+>/g, '').match(/%%/g) ?? []).length;

const PCT_CLAIMS = manifest.claims.filter((c) => c.replace_template.includes('{value}%'));
const PAIRS = manifest.claims.flatMap((c) => c.apply_to_files.map((file) => ({ claim: c, file })));

describe('snapshot injection never renders a double percent (Design.md §6)', () => {
  it('the guard is live: at least one manifest claim injects a "%" inside the span', () => {
    // If every replace_template stopped injecting '%', the suite below would still pass while
    // guarding nothing. Fail loudly instead of going quietly vacuous.
    expect(PCT_CLAIMS.map((c) => c.id)).not.toHaveLength(0);
  });

  it('self-test: the detector actually fires on the bad shape', () => {
    const pctClaim = PCT_CLAIMS[0];
    // Reconstruct the exact defect v1.23.3 shipped: value inside, literal '%' outside.
    const field = /data-tr-field="([a-z_]+)"/.exec(pctClaim.find_pattern)?.[1];
    expect(field, `could not read the field name out of ${pctClaim.id}.find_pattern`).toBeTruthy();
    const bad = `<span data-tr-field="${field}">91.3</span>% PFE win rate`;
    const { newContent, count } = applyClaim(bad, pctClaim, SENTINEL);
    expect(count).toBe(1);
    expect(countRenderedDouble(newContent)).toBeGreaterThan(countRenderedDouble(bad));
  });

  for (const { claim, file } of PAIRS) {
    it(`${claim.id} → ${file}: injection introduces no rendered "%%"`, () => {
      const before = read(file);
      const { newContent } = applyClaim(before, claim, SENTINEL);
      expect(
        countRenderedDouble(newContent),
        `injecting ${claim.id} into ${file} renders a double "%". The injector supplies the "%" ` +
          `via replace_template ${JSON.stringify(claim.replace_template)}, so the template must ` +
          `NOT also carry a literal "%" after </span>. Move it INSIDE the span.`,
      ).toBe(countRenderedDouble(before));
    });
  }
});
