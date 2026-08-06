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
    raw.exempt_paths = [{ path: 'x.md', phrase_id: 'per-day-quota' }]; // no reason
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

  const FIXTURES: Record<string, string> = {
    // must fire — the phrase CLASS, not one literal
    'a.md': 'Free tier covers 20 calls/day per IP — plenty for development.',
    'b.md': 'Free tier covers up to 20 calls/day per IP',
    'c.md': 'Free tier covers 20 free calls/day',
    'd.md': 'Free tier covers 20 calls per day',
    'e.md': 'Free tier covers 25 calls/day',
    // must NOT fire — the correction itself, and real VENUE rate limits
    'ok1.md': 'Free tier: 100 calls/month, every coin and timeframe.',
    'ok2.md': 'rate limits are per-IP, not per-key (2,400 weight/min, 1,200 order/min)',
    'ok3.md': '10/s per UID and 3/s per IP on the place-order endpoint.',
  };

  for (const f of ['a.md', 'b.md', 'c.md', 'd.md', 'e.md']) {
    it(`fires on ${f}`, () => {
      expect(checkBlocklist([f], read, bl, '').length).toBe(1);
    });
  }

  for (const f of ['ok1.md', 'ok2.md', 'ok3.md']) {
    it(`spares ${f}`, () => {
      expect(checkBlocklist([f], read, bl, '').length).toBe(0);
    });
  }

  it('a future per-day number is caught by the class, not by a literal list', () => {
    // The whole reason the blocklist stores a PATTERN. If this ever fails, someone
    // replaced the regex with an enumeration of today's known-bad strings.
    expect(checkBlocklist(['e.md'], read, bl, '').length).toBe(1);
  });
});
