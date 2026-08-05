/**
 * PRICING-ANNUAL-AND-HOLD-PROMISE-W1 (C6) — the free-HOLD PRICING PROMISE may not come back.
 *
 * WHY THIS IS A GATE AND NOT A ONE-TIME CORRECTION.
 *
 * The pricing surface told every visitor "HOLD calls always free". That is false as written —
 * `QUOTA-CONSISTENCY-COUNT-ALL-W1` established that `get_equity_call` / `get_equity_regime` run
 * `quotaGate(license)` unconditionally at the top of the orchestrator, BEFORE the verdict is
 * known, so an equity HOLD IS charged. Correcting the copy once fixes today; the claim is
 * marketable enough that it would drift straight back in on the next copy wave, and it had
 * already reproduced itself across ~40 files and 5 generation systems.
 *
 * TWO HALVES, AND BOTH MATTER. The block also carried the SELECTIVITY PROOF — "99.2% HOLD rate,
 * we only fire when we mean it" and "that selectivity is why we have 91.7%+ Merkle-verified
 * accuracy". That is the only methodology explanation for the accuracy figure on the page.
 * A gate that only banned the promise would be satisfied by deleting the whole block, which is
 * the *wrong* fix. So this asserts BOTH directions: promise absent AND proof present.
 *
 * SCOPE. Public web + external surfaces only (architect Q1, 2026-08-05). Behaviour identifiers
 * (`free_hold`, `holdFree`), their tests, code comments and the internal ops dashboards are
 * deliberately NOT guarded — this wave changed no metering, and banning the vocabulary in code
 * would forbid describing what the code actually does.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');

/**
 * Every surface a paying or prospective customer can read. A `reason` per row, never prose in a
 * comment — an exemption that lives only in a comment gets "fixed" by a future wave enforcing
 * the contract (CLAUDE.md).
 */
const GUARDED: ReadonlyArray<{ path: string; reason: string }> = [
  { path: 'landing/index.html', reason: 'the pricing surface itself — both dual-render artboards' },
  { path: 'landing/docs.html', reason: 'generated from docs-src; carried a whole "Free HOLD Policy" section' },
  { path: 'landing/faq.html', reason: 'hand-edited; visible answer + its FAQPage JSON-LD twin' },
  { path: 'landing/glossary.html', reason: 'hand-edited; DefinedTerm JSON-LD + visible twin' },
  { path: 'landing/llms.txt', reason: 'served verbatim to LLM crawlers — a pricing claim they will quote' },
  { path: 'landing/llms-full.txt', reason: 'ditto, and it carried a dedicated HOLD-pricing Q&A' },
  { path: 'landing/_jsonld/product.json.template', reason: 'ONE of four copies of the same Offer literal' },
  { path: 'landing/_jsonld/application.json.template', reason: 'ONE of four copies of the same Offer literal' },
  { path: 'docs-src/template.html', reason: 'ONE of four copies of the same Offer literal' },
  { path: 'docs-src/partials/pricing.html', reason: 'generator INPUT — fixing only the output rots on next build' },
  { path: 'docs-src/partials/faq.html', reason: 'generator INPUT' },
  { path: 'docs-src/partials/scan-trade-calls.html', reason: 'generator INPUT' },
  { path: 'docs-src/partials/channel-rest-api.html', reason: 'generator INPUT' },
  { path: 'README.md', reason: 'the npm + GitHub front page' },
  { path: 'docs/SUBMIT_G2.md', reason: 'G2 marketplace listing copy' },
  { path: 'lobehub-manifest.json', reason: 'hand-maintained mirror of tool-descriptions; no generator keeps it in sync' },
  { path: 'src/tool-descriptions.ts', reason: 'ships in the LIVE MCP tools/list to every connected client' },
  { path: 'src/lib/signup-flow.ts', reason: 'the function-rendered checkout cards (/signup, /join, referral)' },
  { path: 'src/index.ts', reason: 'the function-rendered x402 card on the signup page' },
  { path: 'src/lib/email.ts', reason: 'outbound customer email — invisible on the website, still public copy' },
  { path: 'scripts/render-jsx-static.mjs', reason: 'ONE of four copies of the same Offer literal' },
];

/** Phrasings that assert HOLDs cost nothing. Deliberately broad — the claim mutates. */
const PROMISE_PATTERNS: ReadonlyArray<RegExp> = [
  /HOLDs?\s+(?:calls?\s+|trade\s+calls?\s+|verdicts?\s+)?(?:are\s+|is\s+)?always\s+free/i,
  /HOLD\s+(?:calls?|verdicts?|trade\s+calls?)\s+(?:are\s+)?free\b/i,
  /HOLDs?\s+never\s+cost/i,
  /HOLD-free\s+metering/i,
  /free\s+HOLD\s+policy/i,
  /HOLDs?\s+(?:are\s+)?free\s+at\s+every/i,
];

/** Strip comments so a behaviour note in code is not read as a public claim (the ban-grep law). */
function stripComments(path: string, src: string): string {
  if (/\.(ts|mjs|js|json)$/.test(path)) {
    return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  }
  if (/\.html?$/.test(path)) return src.replace(/<!--[\s\S]*?-->/g, ' ');
  return src;
}

function read(path: string): string {
  return stripComments(path, readFileSync(join(ROOT, path), 'utf8'));
}

describe('no free-HOLD PRICING PROMISE on any public or external surface', () => {
  it('the guarded surface list is non-empty and every file exists (vacuity guard)', () => {
    // If this list silently resolved to nothing, every assertion below would pass over an empty
    // corpus and the gate would be dark while looking green.
    expect(GUARDED.length).toBeGreaterThanOrEqual(20);
    const missing = GUARDED.filter((g) => !existsSync(join(ROOT, g.path))).map((g) => g.path);
    expect(missing, 'a guarded path moved — repoint it, never drop the row').toEqual([]);
    for (const g of GUARDED) expect(g.reason.length, g.path).toBeGreaterThan(10);
  });

  it.each(GUARDED)('$path carries no free-HOLD promise ($reason)', ({ path }) => {
    const src = read(path);
    expect(src.length, `${path} is empty — the read did not resolve`).toBeGreaterThan(0);
    const hits = PROMISE_PATTERNS.flatMap((re) => {
      const m = src.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));
      return m ?? [];
    });
    expect(hits, `${path} re-introduced a free-HOLD pricing promise`).toEqual([]);
  });
});

/**
 * DECISION REVERSED — PRICING-MONTHLY-PATH-AND-CARD-CLEANUP-W1 (2026-08-05).
 *
 * This block used to assert the SELECTIVITY PROOF was still present on `landing/index.html`,
 * because the prior wave's decision was "remove the promise, KEEP the proof" and a one-way gate
 * would have been satisfied by deleting the whole block instead.
 *
 * The architect then removed the HOLD box from the pricing surface entirely. That is a reversal,
 * not a regression, and the reasoning holds: with the box gone, `99.2%` leaves the pricing page
 * altogether, so no number is left standing without its methodology — which is the property the
 * old assertions actually existed to protect.
 *
 * The promise-absent half above is UNCHANGED and still the reason this file exists. What replaces
 * the proof-present half is the invariant that outlived the copy: no orphaned numerical claim.
 */
describe('no ORPHANED numerical claim on the pricing surface (survives the HOLD-box removal)', () => {
  it('landing/index.html carries no HOLD-rate claim at all — box gone, nothing half-removed', () => {
    const html = readFileSync(join(ROOT, 'landing/index.html'), 'utf8');
    const count = (s: string) => html.split(s).length - 1;
    expect(count('HOLD rate — we only fire when we mean it.')).toBe(0);
    expect(count('That selectivity is why we have')).toBe(0);
    // No stranded injection hook: a `hold_rate` span with no copy around it would zero-match the
    // snapshot injector at every deploy without ever failing a build.
    expect(count('data-tr-field="hold_rate"')).toBe(0);
    // ...and no stranded literal either.
    expect(html).not.toContain('99.2%');
  });

  it('the 91.7% accuracy claim KEEPS its methodology — the property the old assertions protected', () => {
    const html = readFileSync(join(ROOT, 'landing/index.html'), 'utf8');
    const count = (s: string) => html.split(s).length - 1;
    // "91.7% accurate" alone is what every competitor claims. On this page it survives inside the
    // trust band, which supplies the methodology the removed selectivity sentence used to:
    //   "Don't trust — verify. 91.7% PFE win rate across 246,980+ calls, every one Merkle-anchored."
    expect(count('Don’t trust — verify.')).toBe(2); // 1 per artboard
    expect(count('Merkle-anchored on Base.')).toBe(4); // trust band + a second on-chain claim, per artboard
    expect(count('data-tr-field="pfe_wr"')).toBe(8);
    expect(count('data-tr-field="call_count"')).toBe(6);
  });

  it('every page still in the dtrf-hold-rate manifest row carries its hold_rate span', () => {
    // Mirrors scripts/snapshot-landing-manifest.json `dtrf-hold-rate`.apply_to_files, from which
    // `landing/index.html` was removed in the same commit as the box. If a wave deletes one of
    // the REMAINING spans, the injector reports a silent zero-match at every deploy — 1 row of 30
    // is 3.3%, far below the >=50% catastrophic gate, so the build stays GREEN and the page rots.
    const files = [
      'README.md', 'docs-src/partials/faq.html', 'docs-src/partials/pricing.html',
      'landing/docs.html', 'landing/faq.html', 'landing/glossary.html',
    ];
    expect(files.length).toBe(6); // vacuity guard
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      expect(src, `${f} lost its hold_rate injection hook`).toContain('data-tr-field="hold_rate"');
    }
    // The row must not still name a file that no longer carries the span.
    const manifest = readFileSync(join(ROOT, 'scripts/snapshot-landing-manifest.json'), 'utf8');
    const row = JSON.parse(manifest).claims.find((r: { id: string }) => r.id === 'dtrf-hold-rate');
    expect(row.apply_to_files).toEqual(files);
  });
});
