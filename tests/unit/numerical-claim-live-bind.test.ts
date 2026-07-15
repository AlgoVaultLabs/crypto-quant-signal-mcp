/**
 * OPS-LANDING-FUNDING-VENUE-RECONCILE-W1 CH4 — the `numerical-claim-live-bind-at-introduction` canary.
 *
 * Makes a HARDCODED venue/exchange count on a landing surface (or the generator that produces one)
 * structurally impossible. Every venue/exchange count on a public landing surface MUST be
 * single-derived, i.e. one of:
 *   (a) a `data-tr-field` proxy span (live-bound at runtime; the digit is never contiguous with the
 *       unit word so COUNT_RE structurally cannot match it), OR
 *   (b) covered by a `snapshot-landing-manifest.json` find_pattern (deploy-time injected from the SoT), OR
 *   (c) — for the funding-arb venue NAME list — a list whose name-count == FUNDING_VENUE_COUNT (Q4b).
 *
 * The manifest is read at test time, so a FUTURE landing wave that adds a count + its injector row
 * (or a data-tr-field span) inherits this guard for free — no edit here required.
 *
 * Also greps the GENERATOR SOURCE (scripts/render-jsx-static.mjs) so the 12->5 re-render regression
 * that motivated this wave is structurally impossible (Q5): no "N (crypto perp) venues" claim may
 * carry a digit != EXCHANGE_COUNT.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EXCHANGE_COUNT } from '../../src/lib/capabilities.js';
import { FUNDING_VENUE_COUNT, FUNDING_VENUE_LIST_TEXT } from '../../src/lib/funding-venues.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const LANDING_FILES = ['landing/faq.html', 'landing/glossary.html', 'landing/index.html'];

// Every "<digit> (crypto perp )?(venues|exchanges)" claim. A data-tr-field span breaks the
// contiguity ("12</span> crypto perp venues") so span-bound counts never match here by construction.
const COUNT_RE = /(\d+)\s+(?:crypto perp |perp )?(?:venues?|exchanges?)\b/g;

const manifest = JSON.parse(read('scripts/snapshot-landing-manifest.json')) as {
  claims: { id: string; find_pattern: string }[];
};

/** Byte ranges covered by ANY snapshot-manifest find_pattern (deploy-time single-derivation). */
function injectorRanges(html: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const c of manifest.claims) {
    const re = new RegExp(c.find_pattern, 'g');
    for (const m of html.matchAll(re)) {
      if (m.index !== undefined) ranges.push([m.index, m.index + m[0].length]);
    }
  }
  return ranges;
}

function unboundCounts(html: string, file: string) {
  const ranges = injectorRanges(html);
  const offenders: string[] = [];
  for (const m of html.matchAll(COUNT_RE)) {
    const start = m.index!;
    const end = start + m[0].length;
    const covered = ranges.some(([a, b]) => start >= a && end <= b);
    if (!covered) {
      offenders.push(`${file} @${start}: "${m[0]}" — …${html.slice(Math.max(0, start - 24), end + 8)}…`);
    }
  }
  return offenders;
}

describe('numerical-claim-live-bind canary — venue/exchange counts are single-derived', () => {
  for (const file of LANDING_FILES) {
    it(`${file}: no bare venue/exchange count (must be a span or snapshot-injected)`, () => {
      const offenders = unboundCounts(read(file), file);
      expect(offenders, `\nUNBOUND venue counts (wrap in data-tr-field or add a manifest row):\n${offenders.join('\n')}`).toEqual([]);
    });
  }

  it('generator carries no "N (crypto perp) venues" claim != EXCHANGE_COUNT (Q5: kills 12->5 re-render regression)', () => {
    const gen = read('scripts/render-jsx-static.mjs');
    const bad = [...gen.matchAll(/(\d+)\s+(?:crypto perp |perp )venues?\b/g)]
      .map((m) => Number(m[1]))
      .filter((n) => n !== EXCHANGE_COUNT);
    expect(bad, `generator has perp-venue claim(s) != ${EXCHANGE_COUNT}: [${bad}]`).toEqual([]);
  });

  it('funding name-list length == FUNDING_VENUE_COUNT and the canonical list is present; no stale 3-name form (Q4b)', () => {
    const nameCount = FUNDING_VENUE_LIST_TEXT.split(/,\s*(?:and\s+)?/).filter(Boolean).length;
    expect(nameCount, 'FUNDING_VENUE_LIST_TEXT name count drifted from the SoT count').toBe(FUNDING_VENUE_COUNT);
    for (const file of ['landing/faq.html', 'landing/glossary.html']) {
      const html = read(file);
      expect(html.includes(FUNDING_VENUE_LIST_TEXT), `${file} missing canonical funding venue list`).toBe(true);
      expect(html, `${file} still has a pre-expansion 3-name funding list`).not.toMatch(/Hyperliquid vs Binance vs Bybit/);
      expect(html, `${file} still has a pre-expansion 3-name funding list`).not.toMatch(/across Hyperliquid, Binance, and Bybit\b/);
    }
  });
});
