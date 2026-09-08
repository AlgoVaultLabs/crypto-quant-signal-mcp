/**
 * Fixture provenance: VERIFIED, not claimed.
 * OPS-FORBIDDEN-PHRASE-ENUMERATION-AND-WEBHOOKS-DOC-W1 CH3 R3.2.
 *
 * scripts/check-forbidden-phrases.mjs used to assert, in a comment, that every DIRTY self-test
 * fixture had been drawn from the retired-phrase census of the live estate. That was FALSE for
 * `retired-tier-quotas`: its fixture was authored FROM the regex, so the pattern and the proof of
 * the pattern had one author and one blind spot, and the gate reported PASS over a live falsehood
 * on a doc linked from every webhook payload. A rule that has once failed as prose must become a
 * gate or be deleted.
 *
 * 🛑 THE MOST IMPORTANT TEST IN THIS FILE IS THE NON-VACUITY ONE, and it is here because the first
 * cut of this check was itself vacuous. It compared the recorded sample against the DIRTY fixture
 * — but DIRTY is DERIVED from the sample, so the two sides came from one source and could only
 * ever agree. It passed. A deliberate mutation of the recorded bytes left the whole suite GREEN.
 * The check now verifies against git history, which the fixture cannot rewrite, and the mutation
 * below is pinned so the self-comparison can never come back.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error — .mjs gate script, no type declarations; it is the SUBJECT, not a dependency.
import { loadPhrases, loadEstateSamples, checkProvenance, gitObjectExists, isShallowRepo } from '../../scripts/check-forbidden-phrases.mjs';

const ROOT = join(__dirname, '..', '..');
const GATE = join(ROOT, 'scripts', 'check-forbidden-phrases.mjs');

type Prov = { source_path?: string; source_sha?: string; captured_on?: string; synthetic_reason?: string };
type Entry = { id: string; fixture_provenance?: Prov };

const { phrases } = loadPhrases() as { phrases: Entry[] };
const { samples } = loadEstateSamples() as { samples: Record<string, { sample: string; source_path: string; source_sha: string }> };

/**
 * 🛑 THIS FILE RUNS IN TWO DIFFERENT WORLDS, and assuming one of them BLOCKED A DEPLOY.
 *
 * `actions/checkout@v4` defaults to `fetch-depth: 1`, so CI holds exactly ONE commit. The moment
 * this wave landed, its own `source_sha` became the parent and was simply absent from the runner's
 * object store — five assertions that pass on any full clone failed there, reported as "REAL
 * failures (assertion diffs present)", which is the loudest possible way to be wrong about a
 * non-problem. Measured on a real `--depth 1` clone of the landed main: SELF-TEST FAIL (48/1).
 *
 * So history availability is a DECLARED axis here, not an assumption. Neither branch is a skip:
 * where history exists the claim is ENFORCED, and where it does not the test asserts that the
 * checker REPORTS it in those words. "We could not look" must never render as "we looked."
 */
const SHALLOW = isShallowRepo() === true;
const HISTORY = !SHALLOW;

describe('every phrase declares where its fixture came from', () => {
  it('the phrase set and the sample file both load', () => {
    expect(phrases.length, 'vacuity guard: no phrases means every loop below proves nothing').toBeGreaterThan(0);
    expect(samples).toBeDefined();
  });

  for (const p of phrases) {
    it(`${p.id} declares fixture_provenance`, () => {
      expect(p.fixture_provenance, 'undeclared is not permitted; synthetic is').toBeDefined();
      const f = p.fixture_provenance!;
      const estate = Boolean(f.source_path || f.source_sha || f.captured_on);
      if (estate) {
        expect(f.source_path && f.source_sha && f.captured_on, 'partial estate provenance').toBeTruthy();
        expect(existsSync(join(ROOT, f.source_path!)), `${f.source_path} does not resolve`).toBe(true);
        expect(f.source_sha, 'a source_sha must at least LOOK like one').toMatch(/^[0-9a-f]{40}$/);
        if (HISTORY) {
          expect(gitObjectExists(f.source_sha!), `${f.source_sha} is not a git object`).toBe(true);
        }
      } else {
        expect(f.synthetic_reason?.trim().length ?? 0, 'a synthetic_reason must be a sentence').toBeGreaterThan(20);
      }
    });
  }
});

describe('an estate claim is checked against git, not against itself', () => {
  const estateRows = phrases.filter((p) => p.fixture_provenance?.source_path);

  it('at least one entry actually carries estate provenance', () => {
    // Without this the whole block below is vacuous — the exact shape it exists to prevent.
    expect(estateRows.length).toBeGreaterThan(0);
  });

  for (const p of estateRows) {
    it(`${p.id}: the recorded bytes are present at source_path AS OF source_sha`, { timeout: 30_000 }, () => {
      const f = p.fixture_provenance!;
      const rec = samples[p.id];
      expect(rec, `no recorded sample for ${p.id}`).toBeDefined();
      if (!HISTORY) {
        // Not a skip. Assert the checker REPORTS the gap in its own words rather than passing quietly.
        const v = checkProvenance(p, rec.sample, samples) as { ok: boolean; unverifiable?: boolean; detail: string };
        expect(v.unverifiable, 'a shallow checkout must be REPORTED, never silently accepted').toBe(true);
        expect(v.detail).toMatch(/SHALLOW/);
        return;
      }
      const atSha = execFileSync('git', ['show', `${f.source_sha}:${f.source_path}`], { cwd: ROOT, encoding: 'utf8' });
      expect(atSha).toContain(rec.sample);
    });

    it(`${p.id}: the manifest and the fixture file agree on the source`, () => {
      const f = p.fixture_provenance!;
      expect(samples[p.id].source_path).toBe(f.source_path);
      expect(samples[p.id].source_sha).toBe(f.source_sha);
    });

    it(`${p.id}: those bytes are GONE from the current tree — the wave actually fixed the copy`, () => {
      // Provenance points at history on purpose. If the retired bytes were still live, the
      // provenance would be green while the defect shipped.
      const f = p.fixture_provenance!;
      expect(readFileSync(join(ROOT, f.source_path!), 'utf8')).not.toContain(samples[p.id].sample);
    });
  }
});

describe('the provenance check is NOT vacuous — pinned by mutation', () => {
  const ID = 'retired-tier-quotas';
  const live = phrases.find((p) => p.id === ID)!;
  const dirty = samples[ID].sample;

  it('accepts the real, unmutated provenance', () => {
    const v = checkProvenance(live, dirty, samples) as { ok: boolean; unverifiable?: boolean; detail: string };
    expect(v.ok, v.detail).toBe(true);
    // On a full clone this must be a REAL verification, not the report-only branch — otherwise
    // the suite would go green everywhere while enforcing nothing anywhere.
    if (HISTORY) expect(v.unverifiable, 'full clone must VERIFY, not report').toBeFalsy();
  });

  it.runIf(HISTORY)('REJECTS a mutated sample — the case that silently passed when the check compared the sample to itself', () => {
    const mutated = { ...samples, [ID]: { ...samples[ID], sample: dirty.replace('Free 100', 'Free 200') } };
    const v = checkProvenance(live, mutated[ID].sample, mutated) as { ok: boolean; detail: string };
    expect(v.ok).toBe(false);
    expect(v.detail).toMatch(/do NOT appear|provenance claim is false/);
  });

  it.runIf(!HISTORY)('on a SHALLOW checkout the same case REPORTS rather than blocking — and says so', () => {
    // The other half of the same rule. A blocking verdict must land on someone who can act on it,
    // and a CI runner cannot conjure a parent commit. What it must NOT do is read as verified.
    const mutated = { ...samples, [ID]: { ...samples[ID], sample: dirty.replace('Free 100', 'Free 200') } };
    const v = checkProvenance(live, mutated[ID].sample, mutated) as { ok: boolean; unverifiable?: boolean; detail: string };
    expect(v.unverifiable).toBe(true);
    expect(v.detail).toMatch(/SHALLOW|REPORTED, not verified/);
  });

  it.runIf(HISTORY)('REJECTS a source_path that is real but never carried those bytes', () => {
    const entry = { ...live, fixture_provenance: { ...live.fixture_provenance!, source_path: 'README.md' } };
    const moved = { ...samples, [ID]: { ...samples[ID], source_path: 'README.md' } };
    expect((checkProvenance(entry, dirty, moved) as { ok: boolean }).ok).toBe(false);
  });

  it.runIf(HISTORY)('REJECTS an unresolvable source_sha', () => {
    const entry = { ...live, fixture_provenance: { ...live.fixture_provenance!, source_sha: '0'.repeat(40) } };
    const moved = { ...samples, [ID]: { ...samples[ID], source_sha: '0'.repeat(40) } };
    expect((checkProvenance(entry, dirty, moved) as { ok: boolean }).ok).toBe(false);
  });

  it('REJECTS a missing provenance, and a synthetic_reason that is not a reason', () => {
    expect((checkProvenance({ id: 'x' } as Entry, 'z', {}) as { ok: boolean }).ok).toBe(false);
    expect((checkProvenance({ id: 'x', fixture_provenance: { synthetic_reason: 'because' } } as Entry, 'z', {}) as { ok: boolean }).ok).toBe(false);
  });

  it('REJECTS partial estate provenance rather than treating it as synthetic', () => {
    const entry = { id: 'x', fixture_provenance: { source_path: 'README.md' } } as Entry;
    expect((checkProvenance(entry, 'z', {}) as { ok: boolean }).ok).toBe(false);
  });
});

describe('no unenforced prose claim about fixture sourcing survives', () => {
  it('the retired blanket assertion is gone from the gate script', () => {
    const src = readFileSync(GATE, 'utf8');
    expect(src).not.toContain('ACTUAL retired phrases from the estate census');
  });

  it('the self-test reports a provenance verdict for EVERY phrase, and passes', { timeout: 30_000 }, () => {
    const out = execFileSync('node', [GATE, '--self-test'], { encoding: 'utf8', cwd: ROOT });
    for (const p of phrases) expect(out, `no provenance line for ${p.id}`).toContain(`provenance ${p.id}`);
    expect(out).toMatch(/SELF-TEST: PASS/);
    expect(out).toMatch(/FORBIDDEN_PHRASE_VERDICT=PASS/);
  });
});
