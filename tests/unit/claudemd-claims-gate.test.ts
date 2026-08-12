/**
 * OPS-CLAUDEMD-CLAIM-VERIFIER-W1 — pre-push enforcement of the CLAUDE.md claim gate.
 *
 * The vitest suite runs at pre-push (check_test_baseline.sh), so this test is what makes a
 * STALE claim lock — the vault CLAUDE.md edited without `--sync` — block the push that would
 * ship around it, with the gate's own remediation printed. In CI the vault corpus is
 * unreachable and the gate verifies the committed lock against the tree (lock-mode), so this
 * test is corpus-independent: it must pass on any machine.
 *
 * It asserts the CONTRACT, not internals: self-test green both directions, exactly one
 * terminal verdict token, and a PASS verdict on the current tree + lock.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = resolve(__dirname, '..', '..');
const GATE = resolve(ROOT, 'scripts', 'check-claudemd-claims.mjs');

// spawnSync, not execFileSync: the latter returns ONLY stdout on the success path, so a warning
// written to stderr by a run that exits 0 is invisible to the test. That is precisely the shape of
// the --sync refusal below, and a harness that cannot see a guard's warning cannot assert it fires.
function run(args: string[], env: Record<string, string> = {}): { code: number; out: string } {
  // The ledger is telemetry keyed on $GIT_COMMON_DIR and shared by every worktree; a test must
  // never write to it. Individual cases may still override this.
  const merged = { ...process.env, ALGOVAULT_CLAUDEMD_LEDGER: '0', ...env };
  const r = spawnSync('node', [GATE, ...args], { cwd: ROOT, encoding: 'utf8', env: merged });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const tokensIn = (out: string) => out.match(/CLAUDEMD_CLAIMS_VERDICT=\w+/g) ?? [];

describe('claudemd-claims gate (OPS-CLAUDEMD-CLAIM-VERIFIER-W1)', () => {
  it('self-test passes: dead prescriptive path fires, correction blocks do not, vacuity guarded', { timeout: 60_000 }, () => {
    const { code, out } = run(['--self-test']);
    expect(out).toContain('self-test passed');
    expect(code).toBe(0);
  });

  // Generous by intent: this spawns the REAL gate, which shells out to git. It passed standalone
  // at ~3s and still blocked a push under the full parallel suite, against vitest's 5s default —
  // a timing-fragile gate teaches people to re-run until green, which is how a real red gets
  // waved through. The underlying cost was fixed too (one batched cat-file, not ~160 spawns).
  it('--check emits exactly one verdict token and it is PASS on the current tree + lock', { timeout: 60_000 }, () => {
    const { code, out } = run(['--check']);
    const tokens = out.match(/CLAUDEMD_CLAIMS_VERDICT=\w+/g) ?? [];
    expect(tokens).toHaveLength(1);
    // The token is the truth; a stale lock or a broken claim must surface here, at pre-push,
    // with the gate's printed remediation (node scripts/check-claudemd-claims.mjs --sync).
    expect(tokens[0], out.slice(-2000)).toBe('CLAUDEMD_CLAIMS_VERDICT=PASS');
    expect(code).toBe(0);
  });
});

/**
 * OPS-CLAUDEMD-CLAIM-FRESHNESS-SEVERITY-W1 CH2 — staleness is CLASSIFIED, not fatal.
 *
 * `runCheck` used to `return FAIL` the moment the claim set differed from the lock, which made the
 * whole unpublished / in_flight / was_verified ladder below it unreachable in exactly the race it
 * was built for. Measured 2026-08-08: a foreign edit to the shared vault corpus named a file that
 * was committed and pushed on ANOTHER session's branch, buildLock stamped it in_flight, isBlocking
 * returned false — and every worktree on the machine still failed pre-push, because the freshness
 * predicate ran first.
 *
 * These cases pin BOTH directions: the bookkeeping condition must stop blocking, and the dangerous
 * one must keep blocking WHILE the lock is stale — a combination that was previously impossible to
 * observe, since staleness masked everything behind it.
 *
 * Fixtures drive ALGOVAULT_CLAUDEMD_CORPUS + ALGOVAULT_CLAUDEMD_LOCK, the overrides the gate
 * documents for this purpose. The committed lock is never touched.
 */
describe('freshness severity (OPS-CLAUDEMD-CLAIM-FRESHNESS-SEVERITY-W1 CH2)', () => {
  let dir: string;
  const F = (n: string) => join(dir, n);
  // A path that is tracked here, and one that exists nowhere at all.
  const TRACKED = 'scripts/check-canaries-wired.mjs';
  const NOWHERE = 'scripts/this-file-exists-on-no-ref-anywhere.mjs';

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'claudemd-fresh-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  /** Build a lock FROM a corpus with the real --sync, then optionally drift the corpus. */
  function seed(corpus: string): { corpusPath: string; lockPath: string } {
    const corpusPath = F('corpus.md');
    const lockPath = F('lock.json');
    writeFileSync(corpusPath, corpus);
    const r = run(['--sync'], { ALGOVAULT_CLAUDEMD_CORPUS: corpusPath, ALGOVAULT_CLAUDEMD_LOCK: lockPath });
    expect(r.out, 'seeding the fixture lock must succeed').toContain('lock written');
    return { corpusPath, lockPath };
  }
  const check = (corpusPath: string, lockPath: string) =>
    run(['--check'], { ALGOVAULT_CLAUDEMD_CORPUS: corpusPath, ALGOVAULT_CLAUDEMD_LOCK: lockPath });

  it('a stale lock whose only delta is a TRACKED path REPORTS as STALE_SYNCABLE and PASSES', { timeout: 60_000 }, () => {
    const { corpusPath, lockPath } = seed('The gate `scripts/check-claudemd-claims.mjs` is the SoT.\n');
    writeFileSync(corpusPath, `The gate \`scripts/check-claudemd-claims.mjs\` is the SoT.\nAlso \`${TRACKED}\` resolves invocations.\n`);
    const { code, out } = check(corpusPath, lockPath);
    expect(tokensIn(out), out.slice(-1500)).toEqual(['CLAUDEMD_CLAIMS_VERDICT=PASS']);
    expect(code).toBe(0);
    expect(out).toContain('STALE_SYNCABLE');
    // A report with no remediation is the same failure mode wearing a different hat.
    expect(out).toContain('--sync');
  });

  it('a stale lock whose only delta is a path on NO ref REPORTS as STALE_UNPUBLISHED and PASSES', { timeout: 60_000 }, () => {
    const { corpusPath, lockPath } = seed('The gate `scripts/check-claudemd-claims.mjs` is the SoT.\n');
    writeFileSync(corpusPath, `The gate \`scripts/check-claudemd-claims.mjs\` is the SoT.\nAnd \`${NOWHERE}\` is coming.\n`);
    const { code, out } = check(corpusPath, lockPath);
    expect(tokensIn(out), out.slice(-1500)).toEqual(['CLAUDEMD_CLAIMS_VERDICT=PASS']);
    expect(code).toBe(0);
    expect(out).toContain('STALE_UNPUBLISHED');
    // …and it must tell the pusher NOT to land someone else's claim on their behalf.
    expect(out).toMatch(/other session|no remote ref/);
  });

  it('a locked-VERIFIED path that is now absent BLOCKS — even while the lock is also stale', { timeout: 60_000 }, () => {
    const { corpusPath, lockPath } = seed(`The gate \`${NOWHERE}\` is the SoT.\nAnd \`${TRACKED}\` resolves invocations.\n`);
    // --sync stamps the nonexistent path `unpublished`; strip that marker so the lock records it as
    // VERIFIED — i.e. it resolved once and a commit has since removed it.
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    lock.claims = lock.claims.map(({ unpublished: _u, in_flight: _f, ...rest }: any) => rest);
    writeFileSync(lockPath, JSON.stringify(lock, null, 2));

    // Now ALSO make the lock stale with a completely unrelated added claim. Before CH2 this one
    // extra line was enough to hide the missing prescribed path behind "lock is STALE".
    writeFileSync(corpusPath, `The gate \`${NOWHERE}\` is the SoT.\nAnd \`${TRACKED}\` resolves invocations.\nPlus \`scripts/check-claudemd-claims.mjs\` gates the manual.\n`);
    const { code, out } = check(corpusPath, lockPath);
    expect(tokensIn(out), out.slice(-1500)).toEqual(['CLAUDEMD_CLAIMS_VERDICT=FAIL']);
    expect(code).toBe(1);
    expect(out).toContain('blocking claim failure');
    expect(out, 'the finding must NAME the deleted path, not just say the lock is stale').toContain(NOWHERE);
    // and the staleness itself is still reported alongside, not swallowed
    expect(out).toContain('STALE_SYNCABLE');
  });

  it('an unparseable lock is INDETERMINATE with exit 3 — never an uncaught throw', { timeout: 60_000 }, () => {
    const lockPath = F('broken.json');
    const corpusPath = F('corpus.md');
    writeFileSync(corpusPath, 'The gate `scripts/check-claudemd-claims.mjs` is the SoT.\n');
    writeFileSync(lockPath, '{ this is not json');
    const { code, out } = check(corpusPath, lockPath);
    expect(tokensIn(out), out.slice(-1500)).toEqual(['CLAUDEMD_CLAIMS_VERDICT=INDETERMINATE']);
    expect(code).toBe(3);
  });

  /**
   * F6, measured 2026-08-08 and NOT modelled by the wave spec: with a locked-VERIFIED path deleted
   * and the lock stale, the gate reported only staleness and printed `--sync` as the remediation —
   * and running it re-stamped the claim `unpublished`, turning the BLOCK into a PASS. The one
   * safety property this subsystem has was destroyed by following the gate's own instructions.
   */
  it('--sync REFUSES to downgrade a locked-VERIFIED claim whose path is gone (no laundering)', { timeout: 60_000 }, () => {
    const { corpusPath, lockPath } = seed(`The gate \`${NOWHERE}\` is the SoT.\nAnd \`${TRACKED}\` resolves invocations.\n`);
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    lock.claims = lock.claims.map(({ unpublished: _u, in_flight: _f, ...rest }: any) => rest);
    writeFileSync(lockPath, JSON.stringify(lock, null, 2));

    // Drift the corpus, because that is the real scenario: --sync is id-gated and no-ops when the
    // claim set is unchanged, so the laundering path is only reachable when some OTHER claim moved.
    // That is exactly the measured incident — a deleted file plus an unrelated prose edit.
    writeFileSync(corpusPath, `The gate \`${NOWHERE}\` is the SoT.\nAnd \`${TRACKED}\` resolves invocations.\nPlus \`scripts/check-claudemd-claims.mjs\` gates the manual.\n`);
    const sync = run(['--sync'], { ALGOVAULT_CLAUDEMD_CORPUS: corpusPath, ALGOVAULT_CLAUDEMD_LOCK: lockPath });
    expect(sync.out, 'the refusal must be loud, not silent').toContain('must not launder');
    expect(sync.out).toContain('lock written');

    const after = JSON.parse(readFileSync(lockPath, 'utf8'));
    const claim = after.claims.find((c: any) => c.value === NOWHERE);
    expect(claim, 'the claim must survive the sync').toBeTruthy();
    expect(claim.unpublished, 'a verified-then-deleted claim must NOT be downgraded').toBeUndefined();
    expect(claim.in_flight).toBeUndefined();

    // and the gate still blocks after the operator followed the printed remediation
    const { code, out } = check(corpusPath, lockPath);
    expect(tokensIn(out), out.slice(-1500)).toEqual(['CLAUDEMD_CLAIMS_VERDICT=FAIL']);
    expect(code).toBe(1);
  });

  /**
   * Severity classification is DERIVED from buildLock's own three-state marking, never re-derived.
   * The seam that can drift is the FIELD NAMES, so the in_flight/unpublished rows are asserted
   * against markers a real buildLock produces (the unpublished case is proven end-to-end above;
   * manufacturing a remote-ref-only path in a test would require mutating refs, so in_flight is
   * pinned here at the unit boundary plus by the shared marker branch it reads).
   */
  it('classifyStaleness maps all four severities, and order/direction are respected', async () => {
    const m: any = await import(GATE);
    const fresh = [
      { class: 'repo-path', value: 'a.ts' },
      { class: 'repo-path', value: 'b.ts', in_flight: 'origin/some-branch' },
      { class: 'repo-path', value: 'c.ts', unpublished: true },
    ];
    const added = fresh.map((c) => m.claimId(c));
    const rows = m.classifyStaleness(added, ['repo-path:gone.ts'], fresh, {});
    const bySeverity = Object.fromEntries(rows.map((r: any) => [r.id, r.severity]));
    expect(bySeverity['repo-path:a.ts']).toBe('STALE_SYNCABLE');
    expect(bySeverity['repo-path:b.ts']).toBe('STALE_IN_FLIGHT');
    expect(bySeverity['repo-path:c.ts']).toBe('STALE_UNPUBLISHED');
    expect(bySeverity['repo-path:gone.ts']).toBe('STALE_DROPPED');
    expect(rows.find((r: any) => r.id === 'repo-path:b.ts').ref).toBe('origin/some-branch');
    expect(rows.find((r: any) => r.id === 'repo-path:gone.ts').direction).toBe('removed');
  });

  /**
   * META-CLAUDEMD-VERIFIER-CORPUS-SET-W1 — the corpus is a SET.
   *
   * CORPUS-INDEPENDENT BY CONSTRUCTION: every case below builds its own parts in a tmpdir, so it
   * passes on a CI runner where the vault does not exist. The equality-against-the-real-baseline
   * half is `--baseline`, a LOCAL gate with its own token — see runBaseline for why it cannot live
   * here (an earlier cut of the sibling suite copied the private corpus and failed the pre-deploy
   * gate with ENOENT on `/home/runner/My Drive/…`).
   */
  describe('corpus set (META-CLAUDEMD-VERIFIER-CORPUS-SET-W1)', () => {
    const PARTS_ENV = 'ALGOVAULT_CLAUDEMD_CORPUS_PARTS';

    it('AC6: a declared part missing on disk is INDETERMINATE with exit 3 — never a pass', { timeout: 60_000 }, () => {
      const anchor = F('CLAUDE.md');
      writeFileSync(anchor, 'The gate `scripts/check-claudemd-claims.mjs` is the SoT.\n');
      const absent = F('rules-that-were-deleted.md');
      const { code, out } = run(['--check'], { [PARTS_ENV]: `${anchor}:${absent}` });
      expect(tokensIn(out), out.slice(-1500)).toEqual(['CLAUDEMD_CLAIMS_VERDICT=INDETERMINATE']);
      expect(code).toBe(3);
      // The finding must NAME the part, or the operator cannot act on it.
      expect(out).toContain(absent);
      // …and it must be distinguishable from the empty-corpus case in words, not just in code.
      expect(out).toMatch(/HANDED and could not read|fail-closed/);
    });

    it('AC6: --sync REFUSES an incomplete corpus rather than baking the loss into the lock', { timeout: 60_000 }, () => {
      const anchor = F('CLAUDE.md');
      writeFileSync(anchor, 'The gate `scripts/check-claudemd-claims.mjs` is the SoT.\n');
      const { code, out } = run(['--sync'], { [PARTS_ENV]: `${anchor}:${F('gone.md')}`, ALGOVAULT_CLAUDEMD_LOCK: F('lock.json') });
      expect(tokensIn(out), out.slice(-1500)).toEqual(['CLAUDEMD_CLAIMS_VERDICT=INDETERMINATE']);
      expect(code).toBe(3);
    });

    it('refuses a SECOND FULL MANUAL among the parts, even under an innocent filename', { timeout: 60_000 }, () => {
      // The filename guard only knows `_ORIGINAL-CLAUDE-md-*`; this is the structural control, and
      // it is what catches a renamed or re-dated snapshot.
      const anchor = F('CLAUDE.md');
      const manual = '# Manual\n\n## FACTUALITY (THE LAW)\n\nx\n\n## Precedence (THE LAW)\n\ny\n';
      writeFileSync(anchor, `${manual}\nThe gate \`scripts/check-claudemd-claims.mjs\` is the SoT.\n`);
      const renamed = F('rules-archive-2026.md');
      writeFileSync(renamed, manual);
      const { code, out } = run(['--check'], { [PARTS_ENV]: `${anchor}:${renamed}` });
      expect(tokensIn(out), out.slice(-1500)).toEqual(['CLAUDEMD_CLAIMS_VERDICT=INDETERMINATE']);
      expect(code).toBe(3);
      expect(out).toContain('SECOND FULL MANUAL');
    });

    it('refuses two corpus declarations at once instead of picking one silently', { timeout: 60_000 }, () => {
      const anchor = F('CLAUDE.md');
      writeFileSync(anchor, 'The gate `scripts/check-claudemd-claims.mjs` is the SoT.\n');
      const { code, out } = run(['--check'], { ALGOVAULT_CLAUDEMD_CORPUS: anchor, [PARTS_ENV]: anchor });
      expect(tokensIn(out), out.slice(-1500)).toEqual(['CLAUDEMD_CLAIMS_VERDICT=INDETERMINATE']);
      expect(code).toBe(3);
    });

    it('--baseline distinguishes "equal" from "never compared" — its own token, and 3 on unreachable', { timeout: 60_000 }, () => {
      // THE Q3(a) PROPERTY. exit 0 may never encode both "baseline equal" and "the vault was not
      // there, so nothing was compared" — that is the dark-guard shape, and it is why this gate
      // carries a token of its own rather than borrowing the claims one.
      const baseline = F('baseline.json');
      writeFileSync(baseline, JSON.stringify({ claim_ids: ['repo-path:scripts/x.mjs'] }));
      const { code, out } = run(['--baseline', baseline], { ALGOVAULT_CLAUDEMD_CORPUS: F('no-such-corpus.md') });
      expect(out).toContain('CLAUDEMD_BASELINE_VERDICT=INDETERMINATE');
      expect(out, 'the claims token must not be emitted by the baseline gate').not.toContain('CLAUDEMD_CLAIMS_VERDICT=');
      expect(code).toBe(3);
      expect(out).toMatch(/NEVER COMPARED/);
    });

    it('--baseline refuses a baseline carrying no ids — a vacuous comparison is not a pass', { timeout: 60_000 }, () => {
      const anchor = F('CLAUDE.md');
      writeFileSync(anchor, 'The gate `scripts/check-claudemd-claims.mjs` is the SoT.\n');
      const baseline = F('empty-baseline.json');
      writeFileSync(baseline, JSON.stringify({ claim_ids: [] }));
      const { code, out } = run(['--baseline', baseline], { ALGOVAULT_CLAUDEMD_CORPUS: anchor });
      expect(out).toContain('CLAUDEMD_BASELINE_VERDICT=INDETERMINATE');
      expect(code).toBe(3);
    });

    it('the config declares the parts explicitly: anchor first, no globs, never the frozen snapshot', async () => {
      const m: any = await import(GATE);
      const cfg = m.loadConfig();
      const entry = m.corpusEntryOf(cfg);
      expect(entry, 'the CLAUDE.md corpus row must exist').toBeTruthy();
      expect(Array.isArray(entry.parts)).toBe(true);
      expect(entry.parts.length).toBeGreaterThan(1);
      expect(entry.parts[0], 'parts[0] anchors vaultDir for every vault-path claim').toBe('CLAUDE.md');
      for (const p of entry.parts) {
        expect(p, `part ${p} must not be a glob`).not.toMatch(/[*?[\]]/);
        expect(p, `part ${p} must not be the frozen snapshot`).not.toMatch(/_ORIGINAL-CLAUDE-md-/);
      }
      expect(new Set(entry.parts).size).toBe(entry.parts.length);
      // The reason lives ON the key: an exemption that survives only in prose gets "fixed" by a
      // future wave enforcing the contract.
      expect(entry._parts_semantics?.length ?? 0).toBeGreaterThan(200);
    });

    it('validateConfig refuses a malformed parts declaration — it is a config WE author', async () => {
      const m: any = await import(GATE);
      const base = m.loadConfig();
      const mutate = (fn: (e: any) => void) => {
        const c = JSON.parse(JSON.stringify(base));
        fn(m.corpusEntryOf(c));
        return () => m.validateConfig(c);
      };
      expect(mutate((e) => { e.parts = []; }), 'empty parts is vacuity, not "no parts"').toThrow();
      expect(mutate((e) => { e.parts = ['Claude files/rules/x.md', 'CLAUDE.md']; }), 'anchor must be first').toThrow();
      expect(mutate((e) => { e.parts = ['CLAUDE.md', 'Claude files/rules/*.md']; }), 'globs are refused').toThrow();
      expect(mutate((e) => { e.parts = ['CLAUDE.md', 'Claude files/rules/_ORIGINAL-CLAUDE-md-2026-08-12.md']; }), 'the snapshot is refused by name').toThrow();
      expect(mutate((e) => { delete e._parts_semantics; }), 'parts without a recorded reason').toThrow();
      expect(mutate(() => {}), 'the committed config itself must remain valid').not.toThrow();
    });

    it('`part` is LOCATION, never identity: it changes no claim id and never enters the lock', async () => {
      const m: any = await import(GATE);
      expect(m.claimId({ class: 'repo-path', value: 'scripts/x.mjs', part: 'CLAUDE.md' }))
        .toBe(m.claimId({ class: 'repo-path', value: 'scripts/x.mjs', part: 'verification-gates.md' }));
      // …and the merged extraction is the union, deduped — a claim in two parts is ONE claim.
      const cfg = m.loadConfig();
      const mk = (name: string, text: string) => ({ path: `/fixture/${name}`, name, text, sha: 'x'.repeat(64) });
      const text = 'The wiring canary lives at `scripts/check-canaries-wired.mjs`.\n';
      const once = m.extractCorpusClaims([mk('a.md', text)], cfg);
      const twice = m.extractCorpusClaims([mk('a.md', text), mk('b.md', text)], cfg);
      expect(once.claims.length).toBeGreaterThan(0);
      expect(twice.claims.length).toBe(once.claims.length);
      expect(twice.rawCount).toBe(once.rawCount * 2);
      expect(twice.claims[0].part).toBe('a.md');
    });
  });

  it('the config declares every severity with a reason, and the promotion criterion is time-bound', async () => {
    const m: any = await import(GATE);
    const cfg = m.loadConfig();
    for (const s of ['STALE_SYNCABLE', 'STALE_IN_FLIGHT', 'STALE_UNPUBLISHED', 'STALE_DROPPED']) {
      const row = cfg.freshness_severity.find((r: any) => r.severity === s);
      expect(row, `${s} must be declared in config, not only in code`).toBeTruthy();
      expect(row.reason.length).toBeGreaterThan(40);
      expect(row.ship, 'Build Rule 6: no new BLOCK ships in this wave').toBe('report');
    }
    // A promotion criterion needs a TIME BOUND, not just a numeric one — otherwise it can never
    // fire if staleness does not heal, and the guard is decoration.
    expect(typeof cfg.freshness_promotion.runs_required).toBe('number');
    expect(cfg.freshness_promotion.escalate_after).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(cfg.freshness_promotion.owner).toContain('W{NEXT}');
    // and the two promotion criteria must stay distinct — different subjects, different owners
    expect(cfg.freshness_promotion.owner).not.toBe(
      'OPS-CLAUDEMD-CLAIM-PROMOTE-W{NEXT}',
    );
  });
});
