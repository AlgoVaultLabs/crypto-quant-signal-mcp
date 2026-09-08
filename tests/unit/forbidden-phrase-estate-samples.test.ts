/**
 * The widened `retired-tier-quotas` pattern, pinned against the ESTATE sample it missed.
 * OPS-FORBIDDEN-PHRASE-ENUMERATION-AND-WEBHOOKS-DOC-W1 CH1 R1.4.
 *
 * WHAT WENT WRONG. `ops/forbidden-phrases.json`'s pattern was `\b3,000\s+calls|\b15,000\s+calls`
 * — it demanded the unit noun IMMEDIATELY after the figure, because it was transcribed from
 * `brand-facts.md`'s phrasing (`3,000 calls` · `15,000 calls`) rather than sampled from live copy.
 * `docs/WEBHOOKS.md` rendered the ladder as a slash-delimited enumeration with the noun once, far
 * to the left, so the gate reported PASS over a file linked from EVERY webhook payload. The
 * pattern and the fixture proving it had one author and therefore one blind spot.
 *
 * So the fixture here is NOT written inline. It is read from
 * `tests/fixtures/forbidden-phrases/estate-samples.json`, which holds bytes LIFTED from the live
 * surface at a named SHA. A test that retypes the string it is testing proves only that the author
 * was self-consistent.
 *
 * TWO DIRECTIONS, both load-bearing. The MUST-match half proves the widening worked. The MUST-NOT
 * half is what keeps the gate usable: a guard that fires on the copy it is steering authors toward
 * gets warn-moded within a week, and `100,000` / `10,000` are LIVE Pro and Starter figures.
 *
 * 🛑 THE SCOPE OF THIS PATTERN IS DELIBERATELY LIMITED. It is tier-anchored, so it does not catch
 * an un-tiered future phrasing ("the 3,000-call rung"). That is not a hole to be closed by widening
 * this regex — a bare `\b3,000\b` was measured firing on `landing/llms-full.txt` ("gates ≥85% and
 * ≥3,000", a shadow-mode sample-count threshold) and would turn the gate RED on honest copy. The
 * un-tiered case belongs to CH2's `bare_token` enumeration, and `forbidden-phrase-bare-token.test.ts`
 * is where it is proven.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const PHRASES = JSON.parse(readFileSync(join(ROOT, 'ops', 'forbidden-phrases.json'), 'utf8'));
const SAMPLES = JSON.parse(
  readFileSync(join(ROOT, 'tests', 'fixtures', 'forbidden-phrases', 'estate-samples.json'), 'utf8'),
);

const ID = 'retired-tier-quotas';
const entry = PHRASES.phrases.find((p: { id: string }) => p.id === ID);

/** A fresh regex per call: `g` carries `lastIndex`, so a shared instance answers differently by call order. */
const fires = (pattern: string, text: string): boolean => new RegExp(pattern, 'gi').test(text);

describe(`forbidden-phrase ${ID}: the estate sample it once missed`, () => {
  it('the phrase entry and its estate sample both exist', () => {
    // Vacuity guard. Every assertion below reads `entry.pattern` and `SAMPLES[ID].sample`; if
    // either were undefined the `fires()` calls would throw or coerce, and a suite that cannot
    // find its subject must say so rather than quietly proving nothing.
    expect(entry, `no phrase entry with id "${ID}" in ops/forbidden-phrases.json`).toBeDefined();
    expect(typeof entry.pattern).toBe('string');
    expect(SAMPLES[ID], `no estate sample recorded for "${ID}"`).toBeDefined();
    expect(SAMPLES[ID].sample.length).toBeGreaterThan(20);
    expect(SAMPLES[ID].source_path).toBe('docs/WEBHOOKS.md');
    expect(SAMPLES[ID].source_sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('fires on the ESTATE sample — the shape the old pattern could not see', () => {
    expect(
      fires(entry.pattern, SAMPLES[ID].sample),
      'the widened pattern does not match the bytes sampled from docs/WEBHOOKS.md — ' +
        'this is the exact defect CH1 exists to fix',
    ).toBe(true);
  });

  it('still fires on the pre-existing DIRTY fixture — no regression', () => {
    // The synthetic fixture the old pattern was authored against. Widening must ADD reach, never
    // trade one shape for another.
    expect(fires(entry.pattern, 'Starter includes 3,000 calls and Pro 15,000 calls a month.')).toBe(true);
  });

  // One assertion per string: a single `.some()` over the array would report "something matched"
  // and leave you grepping for which.
  const CANONICAL = [
    '10,000 calls/month',
    '100,000 calls/month',
    '10,000/mo',
    '100,000/mo',
    '1,000/day',
    '10,000/day',
  ];
  for (const good of CANONICAL) {
    it(`does NOT fire on canonical replacement copy: "${good}"`, () => {
      expect(fires(entry.pattern, good)).toBe(false);
    });
  }

  it('does NOT fire on the replacement ladder now shipped in docs/WEBHOOKS.md', () => {
    // The §Copy A parenthetical. A pattern that flags its own remediation is a gate nobody keeps.
    expect(
      fires(
        entry.pattern,
        'which refuse independently (Free 200/mo · 100/day · Starter 10,000/mo · ' +
          '1,000/day · Pro 100,000/mo · 10,000/day · Enterprise — custom volume, contact us).',
      ),
    ).toBe(false);
  });

  it('word boundaries hold: 3,000 is not inside 10,000/13,000, and 15,000 is not inside 100,000/115,000', () => {
    // The two collisions the spec named. Proven by execution rather than by reading `\b`.
    for (const near of ['10,000', '13,000', '100,000', '115,000']) {
      expect(fires(entry.pattern, `Starter ${near} calls/month`), `false positive on ${near}`).toBe(false);
    }
  });

  it('does NOT fire on the shadow-mode sample-count threshold in landing/llms-full.txt', () => {
    // The measured reason the widening is tier-anchored rather than bare. This line is live,
    // honest copy in the scan corpus; a bare `\b3,000\b` turns the whole gate RED on it.
    expect(
      fires(entry.pattern, 'PFE Win Rate 92.42% across 3,959 evaluated samples; gates ≥85% and ≥3,000).'),
    ).toBe(false);
  });
});

describe('docs/WEBHOOKS.md is clean against the WHOLE phrase set', () => {
  it('carries zero hits from any of the declared patterns', () => {
    const text = readFileSync(join(ROOT, 'docs', 'WEBHOOKS.md'), 'utf8');
    expect(text.length, 'docs/WEBHOOKS.md is empty — the scan below would be vacuous').toBeGreaterThan(1000);

    const hits: string[] = [];
    for (const p of PHRASES.phrases as Array<{ id: string; pattern: string; negative_context?: string }>) {
      text.split('\n').forEach((line, i) => {
        if (!new RegExp(p.pattern, 'gi').test(line)) return;
        // Mirror the gate's own suppression rule so this test and the gate cannot disagree about
        // what an occurrence IS.
        if (p.negative_context && new RegExp(p.negative_context).test(line)) return;
        hits.push(`${p.id} @ docs/WEBHOOKS.md:${i + 1}: ${line.trim().slice(0, 90)}`);
      });
    }
    expect(hits, `forbidden phrase(s) on a doc linked from every webhook payload:\n${hits.join('\n')}`).toEqual([]);
  });
});
