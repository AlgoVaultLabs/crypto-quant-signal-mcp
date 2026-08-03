/**
 * OPS-CLAUDEMD-CLAIM-PUBLISH-PRECONDITION-W1 — the claim gate under concurrency.
 *
 * Two defects, both measured, together blocked every parallel session three times:
 *   A. a prescribed path on no remote ref BLOCKED the pusher — who can neither verify it nor
 *      fix it, because only the OWNING session can honestly declare the race;
 *   B. freshness was keyed on the sha256 of an entire out-of-repo file that any session may edit
 *      (measured: three distinct shas in ~12 minutes), so `--sync` could not converge.
 *
 * The generator: **a gate's freshness signal must be a function of what it verifies, not of the
 * container that holds it** — the same law as OPS-FRESHNESS-SOURCE-TRUTH-W1's producer-vs-artifact
 * rule, in a new substrate.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { claimId, claimIdSet, sameClaimSet, isBlocking } from '../../scripts/check-claudemd-claims.mjs';

const GATE = resolve(__dirname, '..', '..', 'scripts', 'check-claudemd-claims.mjs');
const cfg = JSON.parse(readFileSync(resolve(__dirname, '..', '..', 'ops', 'claudemd-claim-config.json'), 'utf8'));

/**
 * A SYNTHETIC corpus, never the real one.
 *
 * The vault CLAUDE.md is unreachable from a CI runner BY DESIGN — that privacy property is the
 * entire reason the committed identifier lock exists, and it is stated as non-negotiable in this
 * gate's own header. An earlier cut of this file copied the real corpus into its fixture; it
 * passed locally (where the vault is mounted) and failed the pre-deploy gate with ENOENT on
 * `/home/runner/My Drive/…`. Depending on the private corpus to test the gate that exists
 * because the corpus is private is the mistake this comment is here to stop recurring.
 *
 * A synthetic corpus is also simply better: the claim set is fixed and known, so "adding a
 * claim" means what the test says rather than depending on what a 450-line living document
 * happens to assert today.
 */
const SYNTHETIC_CORPUS = [
  '# Fixture manual',
  '',
  'Some prose that asserts nothing whatsoever.',
  '',
  '- The wiring canary lives at `scripts/check-canaries-wired.mjs` and gates every commit.',
  '- Dependencies are declared in `package.json` at the repo root.',
  '- The shared hook emitter is `scripts/lib/hook-block.sh`.',
  '',
  'More prose. Still asserting nothing.',
  '',
].join('\n');

/** A throwaway corpus + its own lock, so nothing here can touch the committed lock. */
function sandbox(corpusText: string = SYNTHETIC_CORPUS) {
  const dir = mkdtempSync(join(tmpdir(), 'claimlock-'));
  const corpus = join(dir, 'corpus.md');
  writeFileSync(corpus, corpusText);
  return {
    dir,
    corpus,
    lock: join(dir, 'lock.json'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function gate(sb: ReturnType<typeof sandbox>, args: string[]) {
  const r = spawnSync('node', [GATE, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ALGOVAULT_CLAUDEMD_CORPUS: sb.corpus, ALGOVAULT_CLAUDEMD_LOCK: sb.lock },
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return { code: r.status, out, token: (out.match(/CLAUDEMD_CLAIMS_VERDICT=(\w+)/) ?? [])[1] };
}

describe('claim identity (R1)', () => {
  it('is line-agnostic — which is also what makes the lock migration back-compatible', () => {
    expect(claimId({ class: 'repo-path', value: 'scripts/x.mjs', line: 42 }))
      .toBe(claimId({ class: 'repo-path', value: 'scripts/x.mjs' }));
    expect(claimId({ class: 'repo-path', value: 'scripts/x.mjs', line: 42 })).not.toMatch(/\b42\b/);
  });

  // THE safety requirement. A subject-only id lets a claim change WHAT IT ASSERTS while the id
  // set stays identical → id-gated --sync no-ops → the lock silently records a claim set that no
  // longer matches the corpus. Both classes that carry an asserted value are covered.
  it('encodes the ASSERTED VALUE, not just the subject', () => {
    const wiredToPrePush = { class: 'wiring', value: 'scripts/foo.mjs', points: ['pre-push'] };
    const wiredToDeploy = { class: 'wiring', value: 'scripts/foo.mjs', points: ['deploy.yml'] };
    expect(claimId(wiredToPrePush)).not.toBe(claimId(wiredToDeploy));

    expect(claimId({ class: 'script-content', value: 'g.sh', codes: [2] }))
      .not.toBe(claimId({ class: 'script-content', value: 'g.sh', codes: [3] }));
    expect(claimId({ class: 'script-content', value: 'g.sh', token: 'A_VERDICT' }))
      .not.toBe(claimId({ class: 'script-content', value: 'g.sh', token: 'B_VERDICT' }));
  });

  it('treats the same assertion in a different order as ONE claim, and excludes `candidates`', () => {
    expect(claimId({ class: 'wiring', value: 'a', points: ['x', 'y'] }))
      .toBe(claimId({ class: 'wiring', value: 'a', points: ['y', 'x'] }));
    // `candidates` is a RESOLUTION helper, not an assertion — in identity it would re-introduce
    // the prose-sensitivity this wave exists to remove.
    expect(claimId({ class: 'script-content', value: 'a', codes: [2], candidates: ['p'] }))
      .toBe(claimId({ class: 'script-content', value: 'a', codes: [2], candidates: ['q'] }));
  });

  it('compares claim SETS: order- and duplicate-insensitive, membership-sensitive', () => {
    const A = [{ class: 'repo-path', value: 'a' }, { class: 'repo-path', value: 'b' }];
    expect(sameClaimSet(A, [...A].reverse())).toBe(true);
    expect(sameClaimSet(A, [...A, { class: 'repo-path', value: 'a', line: 9 }])).toBe(true);
    expect(sameClaimSet(A, [{ class: 'repo-path', value: 'a' }])).toBe(false);
    expect(sameClaimSet(A, [...A, { class: 'repo-path', value: 'c' }])).toBe(false);
    // Canonically sorted, so two branches adding different claims merge as a union.
    expect(claimIdSet(A)).toEqual([...claimIdSet(A)].sort());
  });
});

describe('pusher-relative verdicts (R2)', () => {
  it('REPORTS a path on no remote ref — blocking there lands the verdict on someone who cannot act', () => {
    expect(isBlocking({ class: 'repo-path', value: 'scripts/only-in-a-worktree.mjs', unpublished: true }, { status: 'MISSING' }, cfg)).toBe(false);
  });

  it('BLOCKS a path that was verified when locked and is now gone — that IS the pusher’s doing', () => {
    expect(isBlocking({ class: 'repo-path', value: 'scripts/deleted.mjs', unpublished: true, was_verified: true }, { status: 'MISSING' }, cfg)).toBe(true);
  });

  it('still blocks an unmarked missing path, so the downgrade cannot leak to its class', () => {
    expect(isBlocking({ class: 'repo-path', value: 'scripts/gone.mjs' }, { status: 'MISSING' }, cfg)).toBe(true);
  });
});

describe('freshness is claim-set equality, not container equality (R1b)', () => {
  it('an unrelated prose edit causes ZERO invalidation and --sync is a no-op', { timeout: 120_000 }, () => {
    const sb = sandbox();
    try {
      expect(gate(sb, ['--sync']).code).toBe(0);
      const before = readFileSync(sb.lock, 'utf8');

      // Insert a paragraph ABOVE every claim, so all of their line numbers shift — which under
      // the old predicate (corpus sha + line-bearing claims + line-ordered array) was an
      // instant STALE for reasons that had nothing to do with any claim.
      const text = readFileSync(sb.corpus, 'utf8').split('\n');
      text.splice(3, 0, '', 'A sentence asserting nothing at all.', '');
      writeFileSync(sb.corpus, text.join('\n'));

      const checked = gate(sb, ['--check']);
      expect(checked.token, checked.out.slice(-1500)).toBe('PASS');

      const synced = gate(sb, ['--sync']);
      expect(synced.out).toMatch(/claim set unchanged/);
      expect(readFileSync(sb.lock, 'utf8')).toBe(before); // byte-identical
    } finally { sb.cleanup(); }
  });

  it('adding a claim DOES invalidate, and prints the --sync remediation', { timeout: 120_000 }, () => {
    const sb = sandbox();
    try {
      gate(sb, ['--sync']);
      // A path the corpus does not already claim — otherwise the id set legitimately collapses.
      writeFileSync(sb.corpus, readFileSync(sb.corpus, 'utf8') + '\n- Test layout is pinned by `vitest.config.ts`.\n');
      const r = gate(sb, ['--check']);
      expect(r.token, r.out.slice(-1500)).toBe('FAIL');
      expect(r.out).toMatch(/claim not in the lock/);
      expect(r.out).toMatch(/--sync/);
    } finally { sb.cleanup(); }
  });
});

describe('lock shape (R1c / AC7)', () => {
  it('carries no line numbers and no prose, and names its sha as PROVENANCE', { timeout: 120_000 }, () => {
    const sb = sandbox();
    try {
      gate(sb, ['--sync']);
      const lock = JSON.parse(readFileSync(sb.lock, 'utf8'));
      expect(lock.extracted_from_corpus_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(lock.corpus_sha256).toBeUndefined(); // renamed: a field named for freshness WILL be read as live
      for (const c of lock.claims) {
        expect(c.line, `claim ${claimId(c)} still carries a line number`).toBeUndefined();
      }
      // The corpus is private. Nothing but identifiers may ever enter this repo.
      const idText = lock.claims.map((c: Record<string, unknown>) => String(c.value)).join('\n');
      expect(idText).not.toMatch(/\s{2,}\w+\s+\w+\s+\w+\s+\w+/); // no sentence-shaped values
    } finally { sb.cleanup(); }
  });
});
