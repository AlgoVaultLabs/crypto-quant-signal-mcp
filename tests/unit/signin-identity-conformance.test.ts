/**
 * FUNNEL-FIX-SIGNIN-PAID-IDENTITY-W1 / CH2 — the gate that makes the bug class
 * structurally impossible rather than merely fixed once.
 *
 * The defect was not that one handler called the wrong function. It was that EVERY sign-in
 * surface independently decided which credential a human gets, and each decided "mint a free
 * one" — so fixing the OAuth callback alone would have left `/api/signup-email` reproducing
 * it verbatim. Both lanes were live at once; a third would have been too.
 *
 * So the rule is enforced on the SOURCE, not on behaviour: `mintFreeKey` has exactly one
 * legitimate caller outside its own store, and sign-in surfaces reach it only through
 * `resolveSigninIdentity`. A future surface that mints directly fails here at build time
 * instead of shipping and being discovered by a customer two months later.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

const ROOT = resolve(__dirname, '../..');

/**
 * Scans are on RAW text, deliberately.
 *
 * A comment-stripping pre-pass was tried first and is the wrong instrument here: `src/index.ts`
 * embeds HTML, CSS and browser JS inside template literals, so a naive block-comment regex
 * swallows multi-thousand-line spans and the gate then passes because it scanned almost
 * nothing — a vacuous green, which is worse than a false red. Raw text cannot do that. The
 * cost is that a source comment must not spell the needle with a paren; the two docblocks in
 * `index.ts` that describe this defect are worded accordingly, and this gate's own prose below
 * is never scanned by it.
 */

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

/**
 * The ONE allow-listed direct caller, with its reason ON THE ROW — never in prose, because an
 * exemption that lives only in a comment gets "fixed" by a future wave enforcing the contract.
 *
 * `referral-accrual.ts` mints for a REFERRED signup as part of crediting the referrer. It is
 * reached from `/api/signup-email`, which now short-circuits a PAID identity before the
 * referral block runs, so a paying customer never reaches it.
 */
const ALLOWED_DIRECT_CALLERS: ReadonlyArray<{ file: string; reason: string }> = [
  {
    file: 'src/lib/referral-accrual.ts',
    reason: 'referred-signup mint, gated upstream by the PAID short-circuit in /api/signup-email',
  },
];

describe('sign-in identity is derived in exactly one place', () => {
  it('no source file outside the store and the allow-list calls mintFreeKey directly', () => {
    const offenders = tsFiles(join(ROOT, 'src'))
      .filter((f) => /\bmintFreeKey\s*\(/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(ROOT, f))
      .filter((rel) => rel !== 'src/lib/free-keys-store.ts')
      .filter((rel) => rel !== 'src/lib/signin-identity.ts')
      .filter((rel) => !ALLOWED_DIRECT_CALLERS.some((a) => a.file === rel));

    expect(offenders).toEqual([]);
  });

  it('src/index.ts reaches free keys ONLY through the shared resolver', () => {
    const src = readFileSync(join(ROOT, 'src/index.ts'), 'utf8');
    // The exact regression: a bare mint on a sign-in surface.
    expect(/\bmintFreeKey\s*\(/.test(src)).toBe(false);
    expect(src).toContain('resolveSigninIdentity');
  });

  it('the corpus is non-empty and the needle is findable — a walker that scanned nothing, or a regex that matches nothing, would pass every assertion above vacuously', () => {
    const files = tsFiles(join(ROOT, 'src'));
    expect(files.length).toBeGreaterThan(50);
    // PROOF the predicate can fire: the store itself must match it.
    const store = readFileSync(join(ROOT, 'src/lib/free-keys-store.ts'), 'utf8');
    expect(/\bmintFreeKey\s*\(/.test(store)).toBe(true);
  });

  it('BOTH human sign-in surfaces call the resolver — one fixed lane is not a fix', () => {
    const src = readFileSync(join(ROOT, 'src/index.ts'), 'utf8');
    const calls = src.match(/await resolveSigninIdentity\(/g) ?? [];
    // /auth/:provider/callback (verified) and /api/signup-email (unverified).
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('the resolver module imports both sides, so the store keeps its no-Stripe contract', () => {
    const store = readFileSync(join(ROOT, 'src/lib/free-keys-store.ts'), 'utf8');
    // The store must never learn about Stripe — that constraint is WHY the decision moved up.
    expect(/from '\.\/stripe\.js'/.test(store)).toBe(false);

    const resolver = readFileSync(join(ROOT, 'src/lib/signin-identity.ts'), 'utf8');
    expect(resolver).toContain("from './stripe.js'");
    expect(resolver).toContain("from './free-keys-store.js'");
  });

  it('the unverified surface never puts a PAID key in its response body', () => {
    const src = readFileSync(join(ROOT, 'src/index.ts'), 'utf8');
    const start = src.indexOf('a PAYING customer never gets a shadow free key');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 2600);
    // It emails the credential (ownership proof) and returns a body with no key field.
    expect(block).toContain('sendKeyRecoveryEmail');
    expect(block).toContain('res.status(200).json({ ok: true, optin_at: optinAt, inserted: result.inserted })');
    expect(/json\(\{[^}]*\bkey\b\s*[,:}]/.test(block)).toBe(false);
  });
});
