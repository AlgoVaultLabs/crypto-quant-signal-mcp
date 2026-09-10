/**
 * FUNNEL-ATTRIBUTION-CLASSIFY-BACKFILL-W1 CH1 R2 — the equivalence proof.
 *
 * The whole wave rests on one claim: **a `bot` derived from a stored UA alone is the SAME verdict
 * the live classifier wrote, from the same function, on the same input.** That must be PROVEN
 * before a single row is written, because if it is merely plausible then the backfill is an
 * inference wearing a measurement's clothes — the exact thing migration 038's own header says is
 * not owed here.
 *
 * ── THE CORPUS IS DERIVED, NOT DUPLICATED ────────────────────────────────────────────────────
 * The UA fixtures are EXTRACTED from `tests/unit/browser-intent.test.ts` rather than re-typed.
 * That file's fixtures are themselves drawn from the real 28d `signup_attribution` population
 * (its `:9-11`), and copying them here would create a second corpus that drifts: a UA added there
 * to pin a new registry behaviour would never reach this proof, and the gap would be invisible.
 * Extraction means a new live fixture enters the equivalence proof automatically.
 *
 * The extractor is VACUITY-GUARDED. We construct this corpus, so an empty one is a defect in this
 * test and must REFUSE — never a silent pass over zero items.
 *
 * ── PLUS THE PAIR MEASURED ON THE LIVE TABLE ─────────────────────────────────────────────────
 * signal-1, 2026-09-10, `utm_campaign='quota_exhausted_push'` — the wall's entire click history,
 * two rows, one on each side of the CH1 cutover:
 *
 *   2026-09-06 · `curl/7.81.0` · classification NULL   ← what this wave must recover
 *   2026-09-07 · `curl/7.81.0` · classification 'bot' · ua_class 'other'   ← what the live path wrote
 *
 * Byte-identical UA, and the live verdict for it is already recorded next to the row we are
 * recovering. That is the strongest available evidence that the recovery is a recovery, so it is
 * pinned explicitly rather than left to the extracted corpus.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyStoredUa } from '../../src/lib/attribution-backfill.js';
import { classifyBrowserIntent, type IntentHeaders } from '../../src/lib/browser-intent.js';

const REPO = join(__dirname, '..', '..');
const MODULE_SRC = readFileSync(join(REPO, 'src', 'lib', 'attribution-backfill.ts'), 'utf8');
const INTENT_TEST_SRC = readFileSync(join(REPO, 'tests', 'unit', 'browser-intent.test.ts'), 'utf8');

/**
 * Every UA string literal in the intent test's fixtures.
 *
 * Matches the two `Array<[string, string]>` fixture tables (`['label', 'ua']`) and the `CHROME_UA`
 * const. A UA literal is recognised by shape — it is the SECOND element of a label/ua pair, or the
 * value of a `*_UA` const — so a fixture added in either place is picked up with no edit here.
 */
function extractUaFixtures(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/\[\s*'[^']*'\s*,\s*'((?:[^'\\]|\\.)*)'\s*\]/g)) out.add(m[1]);
  for (const m of src.matchAll(/const\s+\w*_?UA\b[^=]*=\s*\n?\s*'((?:[^'\\]|\\.)*)'/g)) out.add(m[1]);
  return [...out];
}

const FIXTURE_UAS = extractUaFixtures(INTENT_TEST_SRC);

/** The live-measured pair above. Pinned, never extracted — it comes from the DB, not a file. */
const LIVE_WALL_UA = 'curl/7.81.0';

/**
 * Header bags spanning every non-step-2 outcome the live classifier can reach.
 *
 * The point of the matrix is the SECOND direction of the proof: `classifyStoredUa` saying `bot`
 * must imply the live classifier says `bot` *whatever the other headers were*. Each row below is
 * a bag that would resolve to `browser` or `unknown` on a human UA, so if step 2 did NOT dominate
 * them, this matrix is what would show it.
 */
const HEADER_BAGS: Array<[string, IntentHeaders]> = [
  ['perfect navigation (would be `browser` at step 5)', {
    accept: `text/html,application/xhtml+xml,application/xml;q=0.9,${'*'}/${'*'};q=0.8`,
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
  }],
  ['no metadata at all (would be `unknown` at step 6)', {}],
  ['html Accept only (would be `unknown` at step 6)', { accept: 'text/html' }],
  ['wildcard Accept (would be `bot` at step 4)', { accept: `${'*'}/${'*'}` }],
  ['cors mode (would be `bot` at step 3)', { 'sec-fetch-mode': 'cors' }],
];

describe('classifyStoredUa — the corpus is real and non-empty', () => {
  it('extracts the intent test\'s UA fixtures (a vacuous corpus proves nothing)', () => {
    // WE build this corpus, so empty means the extractor broke — a defect in this test, not a
    // fact about the world. Refuse rather than pass over zero items.
    expect(FIXTURE_UAS.length).toBeGreaterThanOrEqual(8);
    // Shape guard: a regex that silently started matching label strings instead of UAs would keep
    // the count up while emptying the proof of meaning.
    expect(FIXTURE_UAS).toContain('curl/8.7.1');
    expect(FIXTURE_UAS.some((u) => u.includes('Baiduspider'))).toBe(true);
    expect(FIXTURE_UAS.some((u) => u.startsWith('Mozilla/5.0 (Windows NT 10.0'))).toBe(true);
  });
});

describe('classifyStoredUa — the equivalence proof (both directions)', () => {
  for (const ua of FIXTURE_UAS) {
    const label = ua.length > 48 ? `${ua.slice(0, 48)}…` : ua;

    it(`→ whenever the live path says bot for reason ua_automated, so does this: ${label}`, () => {
      const live = classifyBrowserIntent({ ...HEADER_BAGS[0][1], 'user-agent': ua });
      if (live.cls === 'bot' && live.reason === 'ua_automated') {
        expect(classifyStoredUa(ua).classification).toBe('bot');
      } else {
        // The converse case is covered by the next test; asserting nothing here would make this
        // block vacuously green for a corpus of pure browsers.
        expect(classifyStoredUa(ua).classification).toBeNull();
      }
    });

    it(`← whenever this says bot, the live path says bot WHATEVER the other headers: ${label}`, () => {
      if (classifyStoredUa(ua).classification !== 'bot') return;
      // Step 2 precedes steps 3–6, and step 1 also returns `bot`, so no header combination can
      // reach a non-bot verdict past an automated UA. This is what makes the recovery lossless
      // despite the ordering information being gone.
      for (const [why, bag] of HEADER_BAGS) {
        const v = classifyBrowserIntent({ ...bag, 'user-agent': ua });
        expect(v.cls, `${label} under ${why}`).toBe('bot');
      }
    });

    it(`ua_class is byte-identical to the live derivation: ${label}`, () => {
      // The live path computes `classifyClient(ua).name` before any step runs, so this half is
      // recoverable in FULL — including for rows whose classification stays NULL.
      const live = classifyBrowserIntent({ ...HEADER_BAGS[0][1], 'user-agent': ua });
      expect(classifyStoredUa(ua).uaClass).toBe(live.uaClass);
    });
  }
});

describe('classifyStoredUa — the live wall pair (measured on signal-1, 2026-09-10)', () => {
  it('recovers exactly what the live path wrote for the same UA one day later', () => {
    const v = classifyStoredUa(LIVE_WALL_UA);
    expect(v.classification).toBe('bot');
    // The row the live classifier wrote on 2026-09-07 carries ua_class 'other' for this UA.
    expect(v.uaClass).toBe('other');
  });
});

describe('classifyStoredUa — it can never invent evidence it does not have', () => {
  it('returns null, never a string, for every browser-shaped fixture', () => {
    const browserShaped = FIXTURE_UAS.filter(
      (ua) => classifyBrowserIntent({ ...HEADER_BAGS[0][1], 'user-agent': ua }).cls === 'browser',
    );
    // Vacuity guard: if the corpus held no browser-shaped UA this assertion would be empty, and
    // the "never writes browser" claim would rest on nothing.
    expect(browserShaped.length).toBeGreaterThan(0);
    for (const ua of browserShaped) {
      expect(classifyStoredUa(ua).classification).toBeNull();
    }
  });

  it('never returns a class other than bot or null, across the whole corpus', () => {
    for (const ua of [...FIXTURE_UAS, LIVE_WALL_UA, '', '   ', 'wholly-unmatched-agent/1.0']) {
      const c = classifyStoredUa(ua).classification;
      expect(c === 'bot' || c === null, `classification for ${JSON.stringify(ua)} was ${c}`).toBe(true);
    }
  });

  it('an absent, empty or whitespace-only UA is unclassified with the canonical `unknown` slug', () => {
    // The live path gates step 2 on a TRIMMED `ua &&`, so whitespace must behave as absence here
    // too — the one input shape neither path ever thinks about.
    for (const ua of [null, undefined, '', '   ', '\t\n']) {
      const v = classifyStoredUa(ua);
      expect(v.classification).toBeNull();
      expect(v.uaClass).toBe('unknown');
    }
  });

  it('the module cannot even name the two forbidden classes in its CODE', () => {
    // Strip comments first: the prose EXPLAINING the ban is the most valuable text in that file
    // and a naive grep would demand its deletion. Same discipline as
    // `tests/unit/signup-intent.test.ts:101-108`, which bans a hand-written class filter.
    const code = MODULE_SRC.split('\n')
      .filter((l) => {
        const t = l.trimStart();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');
    expect(code).not.toMatch(/'browser'/);
    expect(code).not.toMatch(/'unknown'/);
    // …and the comment-stripper itself must not have eaten the whole file.
    expect(code).toContain('classifyTraffic');
    expect(code).toContain("'bot'");
  });

  it('is a pure leaf — it imports only the two canonical classifiers', () => {
    // An import of `browser-intent.ts` would be the tell that someone reached for headers this
    // path does not have; anything with I/O would make the projector untestable in isolation.
    const imports = [...MODULE_SRC.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['./client-registry.js', './traffic-classifier.js']);
  });
});
