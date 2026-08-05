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

describe('the SELECTIVITY PROOF survives — a gate that only banned the promise would accept deleting it', () => {
  it('landing/index.html keeps the HOLD-rate proof in BOTH artboards, spans intact', () => {
    const html = readFileSync(join(ROOT, 'landing/index.html'), 'utf8');
    const count = (s: string) => html.split(s).length - 1;
    expect(count('HOLD rate — we only fire when we mean it.')).toBe(2);
    expect(count('That selectivity is why we have')).toBe(2);
    // The proof sentence is hydrated at deploy from /api/performance-public. Deleting a span
    // silently zero-matches the snapshot injector — the manifest row would rot, not fail.
    expect(count('data-tr-field="hold_rate"')).toBe(4);
    expect(count('data-tr-field="pfe_wr"')).toBe(10);
    expect(count('data-tr-field="call_count"')).toBe(8);
  });

  it('every page in the dtrf-hold-rate manifest row still carries its hold_rate span', () => {
    // Mirrors scripts/snapshot-landing-manifest.json `dtrf-hold-rate`.apply_to_files. If a wave
    // deletes one of these spans, the injector reports a silent zero-match at every deploy —
    // 1 row of 30 is 3.3%, far below the >=50% catastrophic gate, so the build stays GREEN.
    const files = [
      'README.md', 'docs-src/partials/faq.html', 'docs-src/partials/pricing.html',
      'landing/docs.html', 'landing/faq.html', 'landing/glossary.html', 'landing/index.html',
    ];
    expect(files.length).toBe(7); // vacuity guard
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      expect(src, `${f} lost its hold_rate injection hook`).toContain('data-tr-field="hold_rate"');
    }
  });

  it('the accuracy claim still has its methodology, not a bare number', () => {
    const html = readFileSync(join(ROOT, 'landing/index.html'), 'utf8');
    // "91.7% accurate" alone is what every competitor claims; the selectivity sentence is what
    // makes it mean something. They must appear together.
    expect(html).toContain('Merkle-verified accuracy');
    expect(html).toContain('That selectivity is why we have');
  });
});
