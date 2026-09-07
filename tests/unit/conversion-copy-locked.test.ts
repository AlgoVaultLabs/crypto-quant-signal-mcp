// CONVERSION-SURFACES-W2 — copy-lock (Build Rule 4) + the forbidden/positive pair (Design.md §10).
//
// The wave's §Copy block is the complete visitor-facing delta and dispatch was its sign-off, so
// the strings are frozen. This asserts src/lib/conversion-copy.ts against the verbatim extract in
// audits/CONVERSION-SURFACES-W2-copy-locked-source.txt — a paraphrase, a synonym swap or a
// punctuation change fails here rather than reaching a visitor.
//
// The FORBIDDEN list and the POSITIVE-PRESENCE list ship as a pair on purpose: the first catches
// drift BACK to a retired claim, the second catches drift AWAY from the new one. Either alone
// half-disables the guard.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as copy from '../../src/lib/conversion-copy.js';
import { renderConversionBand } from '../../src/lib/footer-content.js';
import { landingCopy } from '../../src/lib/landing-content.js';

const SOURCE = join(process.cwd(), 'audits', 'CONVERSION-SURFACES-W2-copy-locked-source.txt');

function lockedPairs(): Array<[string, string]> {
  return readFileSync(SOURCE, 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trimStart().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('\t');
      expect(i, `malformed copy-lock row: ${l}`).toBeGreaterThan(0);
      return [l.slice(0, i).trim(), l.slice(i + 1)] as [string, string];
    });
}

describe('conversion copy — locked to the signed §Copy block', () => {
  const pairs = lockedPairs();

  it('the extract is non-empty — an empty corpus would make every assertion below vacuous', () => {
    expect(pairs.length).toBeGreaterThanOrEqual(10);
  });

  it.each(lockedPairs())('%s is byte-identical to the signed source', (key, value) => {
    expect((copy as unknown as Record<string, string>)[key]).toBe(value);
  });

  it('the band sub-line PROJECTS the live hero line rather than re-typing it', () => {
    expect(copy.bandSubLine()).toBe(landingCopy('hero.free_tier_note', 'desktop'));
    // and the allowances still come from plans.ts, so no wave can hand-type them back in
    expect(copy.bandSubLine()).toContain('200 calls/month');
    expect(copy.bandSubLine()).toContain('up to 100/day');
  });
});

describe('conversion copy — forbidden phrases and positive presence', () => {
  // The rendered band is what a visitor actually reads, so the sweep runs over the OUTPUT, not
  // over the constants — a forbidden word could otherwise enter through a template.
  const rendered = renderConversionBand({ route: '/verify' });

  const FORBIDDEN = [
    'trial', 'MOST POPULAR', 'unlimited', 'no daily cap', '100 calls/month',
    'crypto signal layer', 'Quant Layer', 'AI Trading Platform', 'Crypto Signal API',
    'intelligence layer', 'powerful', 'seamless', 'robust', 'cutting-edge',
  ];

  it('renders no forbidden phrase', () => {
    const hits = FORBIDDEN.filter((p) => new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(rendered));
    expect(hits).toEqual([]);
  });

  it('never cites algovault.com/pricing — that URL 404s (brand-facts.md)', () => {
    expect(rendered).not.toContain('algovault.com/pricing');
  });

  it('renders every §Copy string it is supposed to (drift AWAY from the new claim)', () => {
    for (const s of [
      copy.BAND_EYEBROW, copy.BAND_HEADING, copy.bandSubLine(),
      copy.BAND_CTA_PRIMARY_LABEL, copy.BAND_CTA_PRIMARY_HREF,
      copy.BAND_CTA_SECONDARY_LABEL, copy.BAND_CTA_SECONDARY_HREF,
      copy.BAND_LINK_LABEL, copy.BAND_LINK_HREF,
    ]) {
      expect(rendered).toContain(s);
    }
  });

  it('renders NO string outside §Copy — the visible text is exactly the signed set', () => {
    const visible = rendered
      .replace(/<style[\s\S]*?<\/style>/g, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const expected = [
      copy.BAND_EYEBROW, copy.BAND_HEADING, copy.bandSubLine(),
      copy.BAND_CTA_PRIMARY_LABEL, copy.BAND_CTA_SECONDARY_LABEL, copy.BAND_LINK_LABEL,
    ].join(' ');
    expect(visible).toBe(expected);
  });
});
