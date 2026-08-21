/**
 * OPS-CI-MAIN-WRITER-HARDEN-W1 CH2 R4 — the release ordering gate.
 *
 * THE HAZARD. scripts/land.sh REBASES, and a rebase rewrites the commits unique to a branch. The
 * release ritual used to create the annotated tag and then `git push --follow-tags`. If a release
 * ever landed through land.sh under that ordering, the tag would point at a commit rewritten away
 * — orphaned but still perfectly pushable, because refs/tags/* is a separate namespace with no
 * fast-forward rule to refuse it. And .github/workflows/publish-npm.yml checks out the TAG TREE.
 * npm would publish a tree that never landed, and nothing anywhere would fail.
 *
 * Measured, not theorised (throwaway repo, 2026-08-21): tag at 9137fb4, HEAD after rebase
 * 38cbb7e, `git merge-base --is-ancestor <tag> HEAD` -> NO.
 *
 * The correct ordering — land, re-read the landed SHA, tag THAT, push the tag alone — is
 * documented in CLAUDE.md and Prompt/release-wave-daily-template.md, and both rejected
 * alternatives are recorded there so neither is re-proposed.
 *
 * ── TWO HALVES, AND WHY THEY BEHAVE DIFFERENTLY ─────────────────────────────────────────────
 *
 * The REPO half (land.sh's guard, and this repo's own release surfaces) ALWAYS blocks — it runs
 * everywhere the suite runs, including both CI lanes.
 *
 * The VAULT half cannot. The two live documentation surfaces are CLAUDE.md and
 * Prompt/release-wave-daily-template.md, and both live in the operator's Obsidian vault, which
 * does not exist on a GitHub runner. `npm test` runs in CI twice (deploy.yml and postgres-lane.yml
 * on branches:['**']), so a test that hard-failed on vault-absence would red every push.
 *
 * That is not a compromise, it is the vacuity law applied correctly: "empty input is only vacuity
 * when YOU were supposed to fill it." In `--self-test`-style fixtures WE build the corpus, so
 * empty means the test built nothing and must REFUSE. Here the WORLD supplies the corpus, so its
 * absence on a runner is a FACT, and the verdict that fact implies is PASS — reported explicitly,
 * never silently.
 *
 * ── AND WHY THE PRESENT CASE PRINTS A COUNT ─────────────────────────────────────────────────
 *
 * Printing only on absence would make a resolver that silently resolved to the WRONG directory
 * indistinguishable from a healthy run: both would be green and both would be quiet. So when the
 * corpus IS present the gate prints how many surfaces it scanned and asserts that count is > 0.
 * A dark guard exiting 0 must never look like a working one.
 *
 * ── ONE RESOLVER, NOT TWO ───────────────────────────────────────────────────────────────────
 *
 * The vault is located with the repo's EXISTING resolver — `resolveCorpus()` in
 * scripts/check-claudemd-claims.mjs, which already owns the default path, the
 * ALGOVAULT_CLAUDEMD_CORPUS override and `vaultDir`. A second hardcoded path would drift, and
 * the bug would return in whichever copy nobody is watching.
 *
 * ── HISTORY IS NOT REWRITTEN ────────────────────────────────────────────────────────────────
 *
 * ~20 files under Prompt/ are HISTORICAL wave prompts that legitimately contain
 * `git push --follow-tags` — that is what those waves actually did. Rewriting them to match
 * present law would destroy the record of what was true when each shipped. Only the LIVE
 * surfaces are scanned, and a mention that is explicitly REJECTED/never/do-not is not an
 * instruction.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, mkdtempSync, rmSync, cpSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error — .mjs sibling with no type declarations; the exports are plain JS.
import { resolveCorpus } from '../../scripts/check-claudemd-claims.mjs';

const REPO = resolve(__dirname, '../..');
const LAND = join(REPO, 'scripts', 'land.sh');

/**
 * A `--follow-tags` mention that is an INSTRUCTION, not a recorded rejection.
 *
 * WINDOWED, NOT LINE-BASED, and that is the whole subtlety. The first draft filtered whole LINES
 * carrying a caveat word — and the deliberate-break step caught it going blind: CLAUDE.md's entire
 * release cadence is ONE ~2000-character line which now also contains the REJECTED A / REJECTED B
 * addendum, so a genuine `git push origin main --follow-tags` instruction inserted into that same
 * line inherited the caveat and vanished from the results. Line granularity is meaningless in a
 * document whose paragraphs are single lines.
 *
 * A real rejection always negates the phrase INLINE and immediately, so the window is tight:
 * 70 characters before and 25 after. Wide enough for "**REJECTED B — `scripts/land.sh` then `git
 * push --follow-tags`**" and "# NOT `git push --follow-tags`:", narrow enough that a caveat
 * elsewhere in a long paragraph cannot launder an instruction.
 */
export function uncaveatedFollowTags(text: string): string[] {
  const CAVEAT = /reject|never|do not|don't|wrong|not `git push|instead of|hazard|orphan|block/i;
  const out: string[] = [];
  let i = text.indexOf('follow-tags');
  while (i !== -1) {
    const window = text.slice(Math.max(0, i - 70), i + 25);
    // TWO conditions, and the first is what makes this precise. R4 forbids INSTRUCTING
    // `git push --follow-tags` — so a bare `--follow-tags` token in prose ("this gate blocks the
    // reintroduction of `--follow-tags`") is not an instruction at all and must not be flagged.
    // Requiring `git push` inside the same window is a sharper rule than growing the caveat
    // vocabulary every time someone writes a sentence about the flag.
    const isCommand = /git\s+push[^\n]{0,40}$/.test(text.slice(Math.max(0, i - 70), i));
    if (isCommand && !CAVEAT.test(window)) out.push(window.replace(/\s+/g, ' ').trim());
    i = text.indexOf('follow-tags', i + 1);
  }
  return out;
}

const GIT_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|INDEX_FILE|WORK_TREE|COMMON_DIR|QUARANTINE_PATH)$/.test(k))),
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^ALGOVAULT_LOCK_(HELD|DEPTH)_/.test(k))),
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e.invalid',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e.invalid',
} as NodeJS.ProcessEnv;
for (const k of Object.keys(GIT_ENV)) {
  if (/^(GIT_(DIR|INDEX_FILE|WORK_TREE|COMMON_DIR|QUARANTINE_PATH)|ALGOVAULT_LOCK_(HELD|DEPTH)_.*)$/.test(k)) delete GIT_ENV[k];
}

function sh(cmd: string, cwd: string): string {
  return execFileSync('bash', ['-c', cmd], { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A throwaway remote + clone carrying a real copy of land.sh, with the remote moved ahead. */
function fixture(): { root: string; wt: string } {
  const root = mkdtempSync(join(tmpdir(), 'algovault-tagorder-'));
  sh('git init -q --bare -b main remote.git && git clone -q remote.git seed && echo s > seed/f', root);
  sh('cd seed && git add f && git commit -qm seed && git push -q origin main', root);
  sh('git clone -q remote.git w && git -C w remote set-head origin main', root);
  const wt = join(root, 'w');
  mkdirSync(join(wt, 'scripts', 'lib'), { recursive: true });
  cpSync(LAND, join(wt, 'scripts', 'land.sh'));
  cpSync(join(REPO, 'scripts', 'lib', 'with-lock.sh'), join(wt, 'scripts', 'lib', 'with-lock.sh'));
  sh('git add scripts && git commit -qm "branch work"', wt);
  // Move the remote so a rebase genuinely has something to replay onto.
  sh('git clone -q remote.git mover && cd mover && echo m > m && git add m && git commit -qm moved && git push -q origin main', root);
  return { root, wt };
}

function land(wt: string, root: string, args = ''): string {
  try {
    return sh(`ALGOVAULT_LOCK_DIR="${root}/locks" bash scripts/land.sh ${args} 2>&1`, wt);
  } catch (e: any) {
    return `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
}
const verdict = (out: string) => (out.match(/LAND_VERDICT=([A-Z]+)/g) || []).pop() ?? 'NONE';

describe('scripts/land.sh — the tag guard (asserted BEHAVIOURALLY, never by grep)', () => {
  // A grep for the string "tag" in land.sh returns 1 on the PRE-guard file, matching the word
  // "percentage" on line 28. A lexical predicate here would have gone green before the guard was
  // written, so every assertion below RUNS the lander.

  it('REFUSES when a tag sits on a commit the rebase would rewrite', { timeout: 120_000 }, () => {
    const { root, wt } = fixture();
    try {
      sh('git tag -a v9.9.9 -m v9.9.9 HEAD', wt);
      const out = land(wt, root);
      expect(verdict(out)).toBe('LAND_VERDICT=TAGGED');
      expect(out).toContain('v9.9.9');
      expect(out, 'a refusal without remediation is hostile — it must print the 4-step ordering')
        .toMatch(/1\.\s+scripts\/land\.sh[\s\S]*2\.\s+LANDED=[\s\S]*3\.\s+git tag -a[\s\S]*4\.\s+git push origin/);
      expect(sh('git -C remote.git log --oneline main | wc -l', root).trim(), 'nothing may be pushed').toBe('2');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('does NOT fire on an ordinary tagless landing (the other direction)', { timeout: 120_000 }, () => {
    const { root, wt } = fixture();
    try {
      const out = land(wt, root);
      expect(verdict(out)).toBe('LAND_VERDICT=LANDED');
      expect(out).not.toContain('TAGGED');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('does NOT fire on a tag pointing at an ALREADY-LANDED commit', { timeout: 120_000 }, () => {
    // The scoping property that makes the WIDE predicate safe in a repo with 37 release tags:
    // an old tag is not in $DEFAULT_REF..HEAD, so it cannot trip the guard.
    const { root, wt } = fixture();
    try {
      expect(verdict(land(wt, root))).toBe('LAND_VERDICT=LANDED');
      sh('git tag -a v1.0.0 -m v1.0.0 HEAD && echo n > n && git add n && git commit -qm "work after the release"', wt);
      sh('cd mover && git fetch -q origin && git reset -q --hard origin/main && echo m2 > m2 && git add m2 && git commit -qm moved2 && git push -q origin main', root);
      expect(verdict(land(wt, root))).toBe('LAND_VERDICT=LANDED');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('is surfaced by --dry-run, proving it runs BEFORE the lock is taken', { timeout: 120_000 }, () => {
    const { root, wt } = fixture();
    try {
      sh('git tag -a v5.5.5 -m v5.5.5 HEAD', wt);
      expect(verdict(land(wt, root, '--dry-run'))).toBe('LAND_VERDICT=TAGGED');
      expect(sh(`ls "${root}/locks" 2>/dev/null | wc -l`, root).trim(), 'no lock may be left held').toBe('0');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('the corrected 4-step ordering yields a tag on exactly the landed commit', { timeout: 120_000 }, () => {
    const { root, wt } = fixture();
    try {
      expect(verdict(land(wt, root))).toBe('LAND_VERDICT=LANDED');           // 1. land
      const landed = sh('git rev-parse HEAD', wt).trim();                    // 2. re-read AFTER
      sh(`git tag -a v1.2.3 -m v1.2.3 ${landed}`, wt);                       // 3. tag THAT sha
      sh('git push -q origin v1.2.3 && git fetch -q origin', wt);            // 4. the tag alone
      expect(sh("git rev-parse 'v1.2.3^{}'", wt).trim()).toBe(sh('git rev-parse origin/main', wt).trim());
      expect(sh("git rev-parse 'v1.2.3^{tree}'", wt).trim()).toBe(sh("git rev-parse 'origin/main^{tree}'", wt).trim());
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('declares TAGGED in its own verdict enum, on the existing line — not a second channel', () => {
    const src = readFileSync(LAND, 'utf8');
    expect(src).toMatch(/LAND_VERDICT=LANDED \| DIRTY \| TAGGED \| CONFLICT \| GATE_BLOCKED \| EXHAUSTED \| INDETERMINATE/);
    expect((src.match(/finish TAGGED 1/g) || []).length, 'TAGGED is a definite refusal: exit 1, never 3').toBe(1);
  });
});

describe('release surfaces IN THIS REPO must not instruct --follow-tags', () => {
  // audits/** is excluded: those are historical wave records, and rewriting them to match
  // present law would destroy the record of what was true when each wave shipped.
  const files = ['.github/workflows/publish-npm.yml', '.github/workflows/release-knowledge.yml'];

  it('the corpus is non-empty', () => {
    expect(files.filter((f) => existsSync(join(REPO, f))).length).toBeGreaterThan(0);
  });

  for (const f of files) {
    it(`${f} carries no uncaveated --follow-tags`, () => {
      if (!existsSync(join(REPO, f))) return;
      expect(uncaveatedFollowTags(readFileSync(join(REPO, f), 'utf8'))).toEqual([]);
    });
  }

  it('publish-npm.yml documents the land-then-tag ordering', () => {
    const src = readFileSync(join(REPO, '.github/workflows/publish-npm.yml'), 'utf8');
    expect(src).toContain('scripts/land.sh');
    expect(src).toMatch(/git push origin vX\.Y\.Z/);
  });
});

describe('the LIVE vault release surfaces (present-only, and it says which)', () => {
  let vaultDir: string | null = null;
  try {
    const cfg = JSON.parse(readFileSync(join(REPO, 'ops', 'claudemd-claim-config.json'), 'utf8'));
    const r = resolveCorpus(cfg);
    if (!r?.error && r?.vaultDir && existsSync(r.vaultDir)) vaultDir = r.vaultDir;
  } catch { vaultDir = null; }

  const LIVE = ['CLAUDE.md', 'Prompt/release-wave-daily-template.md'];

  it('reports whether the corpus resolved, and scans a POSITIVE number of surfaces when it did', () => {
    if (!vaultDir) {
      // A FACT about this environment, not a defect in the test. CI runners have no vault.
      console.log('[release-tag-order] vault corpus NOT PRESENT in this environment — vault assertions skipped, repo assertions above still blocked. This is expected on a CI runner.');
      expect(vaultDir).toBeNull();
      return;
    }
    const present = LIVE.filter((f) => existsSync(join(vaultDir!, f)));
    console.log(`[release-tag-order] vault corpus at ${vaultDir} — scanned ${present.length}/${LIVE.length} live release surfaces: ${present.join(', ')}`);
    // Asserted, not merely printed: a resolver that silently pointed at the wrong directory would
    // otherwise pass identically to a healthy run.
    expect(present.length, 'the corpus resolved but contains NONE of the live release surfaces — the resolver is pointing somewhere wrong').toBeGreaterThan(0);
    expect(present.length).toBe(LIVE.length);
  });

  for (const f of LIVE) {
    it(`${f} carries no uncaveated --follow-tags`, () => {
      if (!vaultDir) return;
      const p = join(vaultDir, f);
      if (!existsSync(p)) return;
      expect(uncaveatedFollowTags(readFileSync(p, 'utf8'))).toEqual([]);
    });

    it(`${f} documents the land-then-tag ordering`, () => {
      if (!vaultDir) return;
      const p = join(vaultDir, f);
      if (!existsSync(p)) return;
      const src = readFileSync(p, 'utf8');
      expect(src).toContain('scripts/land.sh');
      expect(src).toMatch(/git rev-parse HEAD/);
      expect(src).toMatch(/git push origin v/);
      expect(src, 'both rejected alternatives must stay recorded so neither is re-proposed').toMatch(/REJECTED A/);
      expect(src).toMatch(/REJECTED B/);
    });
  }
});

describe('the gate is PROVEN able to fail', () => {
  it('an INSTRUCTED --follow-tags is caught', () => {
    expect(uncaveatedFollowTags('- `git push origin main --follow-tags` (pushes commits + the tag).')).toHaveLength(1);
    expect(uncaveatedFollowTags('run: git push --follow-tags')).toHaveLength(1);
  });

  it('an instruction inside a LONG line that ALSO carries a caveat elsewhere is still caught', () => {
    // The exact blind spot the deliberate-break step exposed, kept permanently. CLAUDE.md's
    // release cadence is one ~2000-char line; a line-granular predicate lets an instruction hide
    // behind a REJECTED note 900 characters away in the same paragraph.
    const longLine =
      'Daily release wave: npm version -> jq sync -> CHANGELOG -> README -> ' +
      'Then run `git push origin main --follow-tags`. Skip on no-activity days. ' +
      'x'.repeat(400) +
      ' **REJECTED B — `land.sh` then `git push --follow-tags`.** The tag is orphaned.';
    const hits = uncaveatedFollowTags(longLine);
    expect(hits.length, 'the instruction must be caught; only the REJECTED mention may be excused').toBe(1);
    expect(hits[0]).toContain('git push origin main');
  });

  it('a RECORDED-AS-REJECTED mention is not caught', () => {
    expect(uncaveatedFollowTags('- **REJECTED B — `land.sh` then `git push --follow-tags`.** The tag is orphaned.')).toEqual([]);
    expect(uncaveatedFollowTags('# NOT `git push --follow-tags`: land.sh REBASES, so the tag is orphaned')).toEqual([]);
    expect(uncaveatedFollowTags('Never use `git push --follow-tags` here.')).toEqual([]);
  });

  it('PROSE ABOUT the flag, with no `git push`, is not an instruction', () => {
    // A real false positive this predicate produced on its own author's addendum, kept as a
    // fixture: `--follow-tags` named as a TOKEN is not `git push --follow-tags` issued as a step.
    expect(uncaveatedFollowTags('the ordering gate blocks the reintroduction of `--follow-tags` into any live surface')).toEqual([]);
    expect(uncaveatedFollowTags('(`--follow-tags` skips lightweight tags; this is why the tag is annotated `-a`.)')).toEqual([]);
  });

  it('the real live surfaces would fail if --follow-tags were reintroduced', () => {
    const src = readFileSync(join(REPO, '.github/workflows/publish-npm.yml'), 'utf8');
    expect(uncaveatedFollowTags(src)).toEqual([]);
    const broken = src.replace(/^on:/m, '# broken fixture\n#\nrun: git push origin main --follow-tags\non:');
    expect(uncaveatedFollowTags(broken).length, 'reintroducing it must be caught').toBe(1);
  });
});
