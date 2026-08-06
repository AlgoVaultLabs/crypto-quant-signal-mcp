/**
 * P2-LANDING-VERDICT-CARD-W1 — baked landing verdict-card invariants.
 *
 * Asserts the styled "verdict-with-receipts" example card is server-rendered in
 * BOTH dual-render artboards of landing/index.html (crawlable, GEO-2026 raw-HTML
 * rule), live-binds the Proof numbers via the EXISTING data-tr-field hydration,
 * and stays byte-faithful to the P0 src/lib/receipts.ts Receipts contract +
 * RECEIPTS_* copy (so the card cannot silently drift from real tool output).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RECEIPTS_BADGE_TOOLTIP,
  RECEIPTS_CONVICTION_TOOLTIP,
  RECEIPTS_DISCLAIMER,
} from '../../src/lib/receipts.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = readFileSync(join(REPO_ROOT, 'landing', 'index.html'), 'utf8');
// React SSR escapes ASCII apostrophes as &#x27; (em-dash stays literal). Normalize
// for verbatim-copy comparison (react-ssr-apostrophe-normalization-for-grep-portability).
const norm = (s: string) => s.replace(/&#x27;/g, "'");
const htmlN = norm(html);

/** Extract the desktop live-verdict <section> (the one carrying id="live-verdict"). */
function liveVerdictSection(): string {
  const s = html.indexOf('<section id="live-verdict"');
  expect(s).toBeGreaterThan(-1);
  const e = html.indexOf('</section>', s) + '</section>'.length;
  return html.slice(s, e);
}

describe('P2 landing verdict card — dual-render presence', () => {
  it('renders the section in BOTH artboards (id once on desktop; mobile id-stripped for HTML uniqueness)', () => {
    expect((html.match(/id="live-verdict"/g) || []).length).toBe(1);
    expect((html.match(/One call\. One verdict\./g) || []).length).toBe(2);
    expect((html.match(/Example output/g) || []).length).toBe(2);
  });

  it('section heading applies the mint accent to the operative noun "Verifiable."', () => {
    const sec = liveVerdictSection();
    expect(sec).toMatch(/One call\. One verdict\. <span style="color:var\(--accent, var\(--mint\)\)">Verifiable\.<\/span>/);
    expect(sec).toContain('· live verdict'); // GEO kicker
  });
});

describe('P2 landing verdict card — receipt fields (mirror real tool output)', () => {
  const sec = liveVerdictSection();

  it('shows verdict + conviction + humanized regime', () => {
    expect(sec).toContain('>BUY<');
    expect(sec).toContain('· 62% conviction');
    expect(sec).toContain('— Ranging');
  });

  it('shows the top 3 factors with direction', () => {
    expect(sec).toContain('Trend persistence');
    expect(sec).toContain('Funding');
    expect(sec).toContain('Open interest');
    expect(sec).toContain('+2.4%');
    expect(sec).toMatch(/ELEVATED/);
    expect(sec).toMatch(/HIGH/);
  });

  /**
   * SIGNAL-REASONING-PROJECTION-W1-V2 R8. The card advertises itself as "Example
   * output", so it has to be output the tool would actually produce. This wave changed
   * `reasoning`, which would have left the card asserting a string the tool can no
   * longer emit — a false public claim created by the wave itself.
   *
   * The example ALSO moved AXS → XRP, and that was forced rather than chosen: the 06-20
   * AXS capture recorded `funding_state: ELEVATED` but not the underlying `funding_rate`,
   * and the projected prose cites the measured rate. Re-rendering AXS would have meant
   * inventing a figure for public copy. The XRP call is the one this wave was opened
   * over, measured live on 2026-08-06 with the full indicator set
   * (`audits/p2-example-call-2026-08-06.json`), so every number on the card traces to a
   * real reading — and it still clears the Q-P2-3 ">= 60% conviction" ratification at 62%.
   */
  it('uses the captured call reasoning verbatim as the "Why" line', () => {
    expect(sec).toContain('Funding at -0.0066% is unusually negative for XRP over 14 days: shorts pay longs → bullish.');
    expect(sec).toContain('Flips to HOLD if funding normalises.');
    // The defect this replaces, and the two phrasings the wave exists to retire.
    expect(sec).not.toContain('upward bias');
    expect(sec).not.toContain('Moderate conviction from blended signals');
  });

  it('the Why line is byte-identical to what the engine renders for this capture', () => {
    // Card ≡ tool. The golden is produced by renderVerdictReasoning over the capture's
    // own indicators, so the card cannot drift from the engine without this going red.
    const golden = JSON.parse(
      readFileSync(join(REPO_ROOT, 'tests', 'fixtures', 'verdict-reasoning-golden.json'), 'utf8'),
    ) as Record<string, string>;
    const xrp = Object.entries(golden).find(([k]) => k.startsWith('XRP'))![1];
    expect(norm(sec)).toContain(xrp);
  });

  it('"Example output" label is present (DEMONSTRATIVE-FROM-REAL-EVENT framing)', () => {
    expect(sec).toContain('Example output');
    expect(sec).toContain('XRP · 1h · Binance');
  });
});

describe('P2 landing verdict card — live-bind + verify (reuse existing hydration)', () => {
  const sec = liveVerdictSection();

  it('Proof line live-binds pfe_wr + call_count with % INSIDE the pfe_wr span', () => {
    expect(sec).toMatch(/<span data-tr-field="pfe_wr"[^>]*>[0-9.]+%<\/span>/);
    expect(sec).toMatch(/<span data-tr-field="call_count"[^>]*>[\d,]+<\/span>/);
    expect(sec).toContain('PFE win rate');
    expect(sec).toContain('Merkle-anchored on Base');
  });

  it('paired hydration exists for both keys (track-record-proxy.js setField)', () => {
    const proxy = readFileSync(join(REPO_ROOT, 'landing', 'js', 'track-record-proxy.js'), 'utf8');
    expect(proxy).toContain("setField('pfe_wr'");
    expect(proxy).toContain("setField('call_count'");
  });

  it('Verify → and the CTA point to the internal /track-record (no target=_blank)', () => {
    expect(sec).toMatch(/<a href="\/track-record"[^>]*>Verify →<\/a>/);
    expect(sec).toContain('View Live Track Record →');
    expect(sec).not.toContain('target="_blank"');
  });
});

describe('P2 landing verdict card — P0 RECEIPTS_* copy reuse (no silent drift)', () => {
  it('badge + conviction tooltips are byte-verbatim from src/lib/receipts.ts', () => {
    expect(htmlN).toContain(`title="${RECEIPTS_BADGE_TOOLTIP}"`);
    expect(htmlN).toContain(`title="${RECEIPTS_CONVICTION_TOOLTIP}"`);
  });

  it('disclaimer is the P0 string, at the section footer — AFTER the card face (not on it)', () => {
    const sec = liveVerdictSection();
    expect(sec).toContain(RECEIPTS_DISCLAIMER);
    // Footer placement: the disclaimer sits AFTER the card's Proof "Verify →" (i.e. below
    // the .glow card div), never on the card face (P0 decision: no per-card disclaimer line).
    expect(sec.indexOf(RECEIPTS_DISCLAIMER)).toBeGreaterThan(sec.indexOf('Verify →'));
    // And it is NOT inside the .glow card chrome (which ends before the CTA footer block).
    const cardFace = sec.slice(sec.indexOf('class="glow card-hover'), sec.indexOf('View Live Track Record'));
    expect(cardFace).not.toContain(RECEIPTS_DISCLAIMER);
  });
});

describe('P2 landing verdict card — shape-parity / Data-Integrity (card ⊆ Receipts, no P&L)', () => {
  it('the card never surfaces outcome_* / P&L (subset of the allow-listed Receipts shape)', () => {
    const sec = liveVerdictSection();
    expect(sec).not.toContain('outcome_return_pct');
    expect(sec).not.toContain('outcome_price');
    expect(sec.toLowerCase()).not.toContain('pnl');
    expect(sec.toLowerCase()).not.toContain('return_pct');
  });
});

describe('P2 landing verdict card — JSON-LD Q&A (R5)', () => {
  it('adds the "What does an AlgoVault trade call return?" Q&A to the existing FAQPage', () => {
    expect(html).toContain('What does an AlgoVault trade call return?');
    // Attribute-agnostic open-tag count (5 blocks carry data-algov*, 1 FAQPage is bare).
    const blocks = html.match(/<script type="application\/ld\+json"/g) || [];
    expect(blocks.length).toBe(6); // count unchanged — appended to existing FAQPage, no new block
  });
});
