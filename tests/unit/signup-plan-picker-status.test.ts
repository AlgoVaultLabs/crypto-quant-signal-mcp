import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const src = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

/**
 * Comments are stripped before every assertion, and that is load-bearing here rather than
 * incidental: the branch this file pins carries an explanation which QUOTES the historical `400`,
 * and that explanation is the most valuable text in the function. A naive ban-grep would demand
 * its deletion — the standing "strip comments before grepping source for a banned construct" rule,
 * which `scripts/check-canaries-wired.mjs` already applies for the same reason.
 *
 * LINE comments only, and that is deliberate. Measured while writing this file: adding the JS
 * BLOCK-comment regex (`/\/\*[\s\S]*?\*\//g`) to the same pipeline silently deleted the whole
 * `/signup` handler from the scanned text, so three assertions failed against source that was
 * demonstrably correct. `src/index.ts` contains sequences that close a block comment early, so the
 * regex spans from one docblock to a later `*&#47;` and swallows everything between — the exact
 * trap `check-canaries-wired.mjs` documents for YAML, reproduced here in TypeScript. The house
 * pattern (`tests/unit/referral-existence-guard.test.ts:19`) strips line comments only, and it is
 * the house pattern for this reason. The branch's own explanation is written with `//` so it is
 * fully removed by this form.
 *
 * The negative lookbehind for `:` is the second thing measured here, and it is not cosmetic. The
 * bare house form truncates a line at the FIRST `//` — which inside `https://algovault.com/...`
 * is the scheme separator, not a comment. So the naive stripper deletes every URL-bearing line in
 * the file, and an assertion about a redirect TARGET fails against source that is demonstrably
 * correct. The house pattern gets away with it only because its assertions happen not to name a
 * URL; ours do.
 */
const stripComments = (s: string) =>
  s.split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');

/**
 * RELEASE-v1.28.0-AND-README-LINK-GATE-W1 CH1 · Q4(a).
 *
 * A bare `GET /signup` — no `?plan=` — answered **HTTP 400** while serving the complete, correct
 * plan-picker page. Measured live 2026-08-21: `<h1>AlgoVault Subscriptions`, the Starter and Pro
 * cards and the x402 panel all rendered, with no error copy anywhere in the body, under a status
 * code that says the request was malformed.
 *
 * WHY IT MATTERS ENOUGH TO PIN. This is the primary paid-conversion CTA. `README.md` links to it
 * three times — including the **Sign Up** button in the header block, which is the first
 * interactive element an integrator sees on npmjs.com and on the GitHub front page. A crawler will
 * not index a 400, and an agent fetching the conversion entry point reads it as broken. The 400
 * shipped in `126ba67` (2026-04-09) and stood for four and a half months.
 *
 * WHY IT SURVIVED THAT LONG, which is the part worth remembering. It was SEEN. A previous wave's
 * Step-0 recorded it in `scripts/check-footer-body-flow.mjs` as *"`/signup`, which a live sweep
 * skips because it answers 400 without a ?plan param"* — filed as a property of the route rather
 * than as a defect, and then inherited. No gate had ever read a link in `README.md`, so nothing
 * disagreed. `scripts/check-readme-links.mjs` found it on its FIRST live run.
 *
 * These are source-level assertions by necessity: `src/index.ts` boots the server at import, so
 * the handler closures are not directly callable (the repo's own test-importability rule). The
 * runtime behaviour is asserted post-deploy by the live link gate in `deploy.yml`, which probes
 * this exact URL on every deploy — so the pair is source-pin here, live-probe there.
 */
describe('GET /signup — the plan picker is a page, not an error (Q4a)', () => {
  const code = stripComments(src('src/index.ts'));

  it('serves the no-plan plan picker with 200', () => {
    expect(code).toContain('return res.status(200).send(getSignupPageHtml());');
  });

  it('never serves the plan picker under a 4xx again', () => {
    // The whole class, not just the one literal: any 4xx wrapping this page is the same defect.
    expect(code).not.toMatch(/res\.status\(4\d\d\)\.send\(getSignupPageHtml\(\)\)/);
  });

  it('still redirects a chosen plan to Stripe with 303 — the fix must not touch the paid path', () => {
    // Measured live 2026-08-21: ?plan=starter → 303, ?plan=pro → 303,
    // ?plan=starter&interval=6month → 303. Unchanged by this wave.
    expect(code).toContain('res.redirect(303, url);');
  });

  it('still sends a no-plan referral link to the branded /join landing (REFERRAL-WEB-FIX-W1)', () => {
    // That branch precedes the picker and grants the free 500; a status-code edit must not
    // reorder or shadow it.
    expect(code).toContain('https://algovault.com/join?ref=');
  });

  it('the picker page is a picker — it renders the plan cards, so 200 is the honest status', () => {
    // The claim "this is not an error page" has to be checked, not asserted. If the body ever
    // became a genuine error, 200 would be the wrong code and this test should go red first.
    const page = stripComments(src('src/index.ts'));
    expect(page).toContain('renderPlanCards');
    expect(page).toContain('AlgoVault Subscriptions');
  });
});
