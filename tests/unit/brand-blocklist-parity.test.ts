/**
 * Parity + behaviour lock for the cross-repo brand blocklist.
 * CROSS-REPO-TUTORIAL-PRODUCER-GATE-W1.
 *
 * `ops/brand-forbidden-phrases.json` is the CANONICAL copy; `algovault-skills`
 * carries a vendored copy plus a copy of the `.sha256` recorded here.
 *
 * Per CLAUDE.md's shared-primitive law, the hash is necessary but NOT sufficient:
 * "a hash cannot catch a re-vendor from a stale source that also re-records the
 * hash". So this file pins BEHAVIOUR too — the phrase class must actually match the
 * strings it exists to catch, and must actually spare the ones it exists to spare.
 * If someone re-vendors from a stale source and re-stamps the hash, the behaviour
 * assertions still fail.
 *
 * KNOWN LIMITATION, recorded rather than papered over: the two repos share no CI,
 * so neither side can read the other at test time. Each asserts its own copy
 * against the ONE recorded hash. True cross-repo drift (canonical edited, skills
 * never re-vendored) is caught at the next re-vendor, not continuously —
 * `OPS-XREPO-BLOCKLIST-DRIFT-CANARY-W{NEXT}`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { loadBlocklist, checkBlocklist } from '../../scripts/check-mcp-client-copy.mjs';

const ROOT = join(__dirname, '..', '..');
const JSON_PATH = join(ROOT, 'ops', 'brand-forbidden-phrases.json');
const SHA_PATH = `${JSON_PATH}.sha256`;

describe('brand blocklist: canonical hash', () => {
  it('the recorded .sha256 matches the canonical file', () => {
    const actual = createHash('sha256').update(readFileSync(JSON_PATH)).digest('hex');
    const recorded = readFileSync(SHA_PATH, 'utf8').trim();
    expect(
      actual,
      'ops/brand-forbidden-phrases.json changed without re-stamping its .sha256 — ' +
        're-run: shasum -a 256 ops/brand-forbidden-phrases.json | awk \'{print $1}\' > ops/brand-forbidden-phrases.json.sha256 ' +
        'and RE-VENDOR the copy in algovault-skills.',
    ).toBe(recorded);
  });

  it('the recorded hash is a well-formed sha256', () => {
    expect(readFileSync(SHA_PATH, 'utf8').trim()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('brand blocklist: schema', () => {
  it('loads, and is not empty (vacuity guard)', () => {
    const bl = loadBlocklist(JSON_PATH);
    expect(bl, 'blocklist failed to load').not.toBeNull();
    expect(bl!.length).toBeGreaterThan(0);
  });

  it('every phrase carries id, pattern, correction, severity and a ratification citation', () => {
    const raw = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
    expect(raw.phrases.length).toBeGreaterThan(0);
    for (const p of raw.phrases) {
      expect(p.id, 'phrase id').toMatch(/^[a-z0-9-]+$/);
      expect(p.correction, `${p.id} correction`).toBeTruthy();
      expect(p.severity, `${p.id} severity`).toBeTruthy();
      expect(p.ratified, `${p.id} must cite the ratifying authority`).toBeTruthy();
      expect(() => new RegExp(p.pattern), `${p.id} pattern compiles`).not.toThrow();
    }
  });

  it('every exemption carries a reason — a bare path is indistinguishable from an oversight', () => {
    const raw = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
    for (const e of raw.exempt_paths ?? []) {
      expect(e.path, 'exemption path').toBeTruthy();
      expect(e.phrase_id, `${e.path} phrase_id`).toBeTruthy();
      expect(e.reason, `${e.path} MUST state why`).toBeTruthy();
      expect(e.reason.length, `${e.path} reason is too short to be a reason`).toBeGreaterThan(40);
    }
  });

  it('refuses an exemption with no reason', () => {
    // Proves the loader's refusal is real, not decorative.
    const raw = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
    raw.exempt_paths = [{ path: 'x.md', phrase_id: 'free-hold-promise' }]; // no reason
    const tmp = join(ROOT, 'ops', '.brand-blocklist-parity-tmp.json');
    const fs = require('node:fs');
    fs.writeFileSync(tmp, JSON.stringify(raw));
    try {
      expect(loadBlocklist(tmp)).toBeNull();
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});

describe('brand blocklist: BEHAVIOUR (a hash cannot catch a stale re-vendor)', () => {
  const bl = loadBlocklist(JSON_PATH)!;
  const read = (f: string) => FIXTURES[f];

  // PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1 (2026-08-09): the `per-day-quota` class was
  // RETIRED — ruling R-B gave the free tier a real per-UTC-day cap, so "100 calls/day"
  // became an accurate statement the gate was blocking. The live class is now the
  // free-HOLD promise, which R-A made false everywhere. The retired class's fixtures are
  // kept INVERTED rather than deleted: they are the regression lock proving the ban is
  // gone, and without them a silently-reinstated pattern would block every pricing page.
  const FIXTURES: Record<string, string> = {
    // must fire — the phrase CLASS, not one literal
    'a.md': 'HOLD verdicts are free and never charged.',
    'b.md': 'A HOLD is free, so scan as often as you like.',
    'c.md': 'Batch scans give you free HOLDs at no quota cost.',
    'd.md': 'A HOLD is never charged against your allowance.',
    'e.md': "HOLDs don't count towards your monthly quota.",
    // must NOT fire — the correction itself, real VENUE rate limits, and the RETIRED class
    'ok1.md': 'Free tier: 200 calls/month, every coin and timeframe.',
    'ok2.md': 'rate limits are per-IP, not per-key (2,400 weight/min, 1,200 order/min)',
    'ok3.md': '10/s per UID and 3/s per IP on the place-order endpoint.',
    'ok4.md': 'Every verdict counts, HOLD included.',
    'ok5.md': 'Free tier covers 100 calls/day per IP — plenty for development.',
    'ok6.md': 'Starter covers 1,000 calls per day.',
  };

  for (const f of ['a.md', 'b.md', 'c.md', 'd.md', 'e.md']) {
    it(`fires on ${f}`, () => {
      expect(checkBlocklist([f], read, bl, '').length).toBe(1);
    });
  }

  for (const f of ['ok1.md', 'ok2.md', 'ok3.md', 'ok4.md', 'ok5.md', 'ok6.md']) {
    it(`spares ${f}`, () => {
      expect(checkBlocklist([f], read, bl, '').length).toBe(0);
    });
  }

  it('a fresh paraphrase is caught by the class, not by a literal list', () => {
    // The whole reason the blocklist stores a PATTERN. If this ever fails, someone
    // replaced the regex with an enumeration of today's known-bad strings.
    expect(checkBlocklist(['e.md'], read, bl, '').length).toBe(1);
  });

  it('the RETIRED per-day class stays retired — and its correction is not resurrected', () => {
    // The other half of a retirement. Asserting only that the new phrase fires would let
    // someone re-add the old one tomorrow and every test above would still pass, while
    // the deploy blocked on legitimate copy — which is exactly how this wave's deploy failed.
    expect(bl.map((p) => p.id)).not.toContain('per-day-quota');
    for (const f of ['ok5.md', 'ok6.md']) {
      expect(checkBlocklist([f], read, bl, ''), `${f} states a REAL daily cap`).toEqual([]);
    }
  });
});
