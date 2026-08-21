/**
 * OPS-CI-MAIN-WRITER-HARDEN-W1 CH1 R2 — every CI writer of a git ref tolerates losing the race.
 *
 * ENUMERATED FROM DISK, never from a hardcoded list of one. That direction is the whole point.
 * The class this wave retires is "a writer of a shared ref that neither takes the lock nor
 * tolerates losing the race", and four future cases inherit it: a second repository_dispatch
 * regenerator, a bot/Dependabot-style committer, an algovault-skills-side workflow that ever
 * pushes here, and the AOE/editorial repos reusing this workflow shape. A canary that iterated a
 * literal ['regenerate-landing.yml'] would pass forever while the second one silently shipped a
 * bare push. Detection is strictly weaker than enumeration.
 *
 * ── WHAT THIS OWNS, AND WHAT IT DELIBERATELY DOES NOT ───────────────────────────────────────
 *
 *   this canary            — do the workflows that WRITE A GIT REF do so safely? (bare push,
 *                            force/lease, and whether a push is accompanied by fetch+rebase)
 *   workflow-concurrency   — does every workflow HAVE a concurrency group, queue: max, and no
 *                            cancel-in-progress?
 *   check-shared-state.mjs — do the registry DECLARATION and the on-disk REALITY agree, in both
 *                            directions?
 *
 * Registration is already enforced BOTH WAYS by check-shared-state.mjs's CI_SERIALIZATION check
 * (a workflow on disk with no row, or a row with no file, blocks there). This file therefore
 * asserts registration only as a cheap cross-check on the SUBSET that writes refs — re-deriving
 * the full bidirectional rule here would be the second copy nobody watches.
 *
 * ── COMMENT-IMMUNITY IS LOAD-BEARING, NOT A NICETY ──────────────────────────────────────────
 *
 * Measured on origin/main 2026-08-21: a naive `grep -cE -- '--force'` over .github/workflows/
 * returns 3, and ALL THREE are legitimate — deploy.yml:451 and :792 are COMMENTS (one of them
 * quotes CLAUDE.md's own "never push --force" rule) and :799 is `docker compose up -d --build
 * --force-recreate`, a docker flag with no relation to git. A predicate that counted those could
 * only ever be satisfied by editing a file this wave must not touch. So every assertion below
 * strips comments first and evaluates `git push` LINES, which is what the rule actually says.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO = resolve(__dirname, '../..');
const WF_DIR = join(REPO, '.github', 'workflows');
const REGISTRY = join(REPO, 'ops', 'shared-worktree-state.json');

/** Enumerate from DISK. Never a literal list — that is the property under test. */
function workflowFiles(): string[] {
  return readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
}

/**
 * Strip YAML/shell comments so a rule QUOTED in prose is never read as a rule BROKEN in code.
 * Column-agnostic (workflow shell is deeply indented) and conservative: it only strips from a
 * `#` that begins a token, so `refs/heads/main#frag` or a `#` inside a word survives.
 */
export function stripComments(text: string): string[] {
  return text.split('\n').map((line) => line.replace(/(^|\s)#.*$/, '$1').trimEnd());
}

/**
 * ── TWO PREDICATE DIRECTIONS, AND WHY THEY DIFFER ──────────────────────────────────────────
 *
 * Both of these were WRONG in the first draft, and the deliberate-break step is what caught it:
 * two of five breaks against the real corpus went GREEN. The lesson is that "does this file
 * contain the string `git fetch`" and "does this file RUN git fetch" are different questions,
 * and which error you can afford depends on whether the predicate expresses a PROHIBITION or a
 * REQUIREMENT. Each is therefore tuned to err toward REFUSING:
 *
 *   PROHIBITION (no bare push, no --force)  -> match LOOSELY, anywhere on a non-comment line.
 *       Over-matching costs a false refusal the author clears by rewording. Under-matching
 *       ships a force-push from CI.
 *
 *   REQUIREMENT (a fetch and a rebase must be RUN) -> match in COMMAND POSITION only.
 *       The first draft used a loose match and was blind to deleting the fetch entirely,
 *       because this workflow's own error message reads
 *         echo "::error::… git fetch origin $BRANCH failed; cannot establish what to rebase onto."
 *       and that string satisfied a loose /\bgit\s+fetch\b/. A requirement satisfied by an
 *       error message about the thing not happening is the purest form of a dark guard.
 */
const CMD_POS = String.raw`(?:^|[;&|(]|&&|\|\||\bthen\b|\bdo\b|\bif\b|!)\s*`;

/** Non-comment lines that INVOKE `git <sub>` in command position. */
function gitInvocations(text: string, sub: string): string[] {
  const re = new RegExp(`${CMD_POS}git\\s+${sub}\\b`);
  return stripComments(text).filter((l) => re.test(l));
}

/**
 * A BARE push is one carrying NO ARGUMENTS — wherever it sits on the line. The first draft
 * anchored on `^\s*git push\s*$`, so `if git push; then` walked straight through it: the
 * defect had simply moved onto an `if`. Measured against the real corpus.
 */
function barePushLines(text: string): string[] {
  const re = new RegExp(`${CMD_POS}git\\s+push\\s*(?:$|[;&|>])`);
  return stripComments(text).filter((l) => re.test(l));
}

/**
 * A rebase that ADVANCES the branch. `--abort`, `--continue` and `--skip` operate on a rebase
 * already in progress, so a file containing only `git rebase --abort` has not rebased anything —
 * and the first draft counted it, staying green when the real rebase was deleted.
 */
function advancingRebases(text: string): string[] {
  return gitInvocations(text, 'rebase').filter((l) => !/--(abort|continue|skip|quit|edit-todo)\b/.test(l));
}

/** Every non-comment line MENTIONING git push. Loose on purpose — see the note above. */
function gitPushLines(text: string): string[] {
  return stripComments(text).filter((l) => /(^|[;&|]\s*|\s)git\s+push(\s|$)/.test(l));
}

/** A workflow WRITES a git ref if it invokes `git push` outside a comment. */
function writesGitRef(text: string): boolean {
  return gitInvocations(text, 'push').length > 0;
}

const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
const ciRows: Record<string, any> = Object.fromEntries(
  registry.resources.filter((r: any) => r.kind === 'ci-workflow').map((r: any) => [r.path, r]),
);

describe('CI git-ref writers — enumerated from disk', () => {
  it('the corpus is non-empty (a vacuous sweep must never read as a clean one)', () => {
    // WE build this corpus by pointing at a directory, so an empty one means the canary checked
    // nothing — a defect in the canary, not a fact about the repo. REFUSE rather than pass.
    expect(existsSync(WF_DIR)).toBe(true);
    expect(workflowFiles().length).toBeGreaterThan(0);
  });

  it('at least one workflow DOES write a git ref (or these assertions are vacuous)', () => {
    // If this ever reads zero, every per-writer assertion below is trivially satisfied and the
    // suite would go green having verified nothing. The day a repo genuinely has no CI writer,
    // this line is the one that has to be deliberately retired.
    const writers = workflowFiles().filter((f) => writesGitRef(readFileSync(join(WF_DIR, f), 'utf8')));
    expect(writers.length, 'no workflow invokes `git push` — the sweep below verifies nothing').toBeGreaterThan(0);
  });

  // One case PER FILE, generated from the directory listing. A new workflow gets its own case
  // automatically the moment it lands.
  for (const file of workflowFiles()) {
    const rel = `.github/workflows/${file}`;

    describe(rel, () => {
      const raw = readFileSync(join(WF_DIR, file), 'utf8');
      const pushes = gitPushLines(raw);

      it('contains NO bare `git push`', () => {
        // The exact defect this wave retires. A bare push takes whatever the checkout happened to
        // have and hopes nothing moved; when something did, the run goes red and the work is lost.
        expect(barePushLines(raw), `${rel} has an argument-less \`git push\` — it pushes whatever the checkout happened to have`).toEqual([]);
      });

      it('no `git push` carries --force or --force-with-lease', () => {
        // A CI writer that settles a collision by overwriting is a data-integrity defect wearing
        // a fix's clothes. Evaluated per PUSH LINE and comment-stripped — see the header.
        const forced = pushes.filter((l) => /--force(-with-lease)?\b/.test(l));
        expect(forced, `${rel} force-pushes from CI`).toEqual([]);
      });

      if (pushes.length > 0) {
        it('is REGISTERED in ops/shared-worktree-state.json', () => {
          expect(ciRows[rel], `${rel} writes a git ref but has no ci-workflow row`).toBeTruthy();
        });

        it('accompanies its push with a fetch AND a rebase — it tolerates losing the race', () => {
          // This is the invariant in one line. A writer that cannot take the landing lock (a
          // GitHub runner cannot participate in a mutex on the operator's laptop) must instead
          // survive being beaten to the ref: re-read the remote, replay onto it, push again.
          expect(gitInvocations(raw, 'fetch').length, `${rel} pushes without ever RUNNING git fetch`).toBeGreaterThan(0);
          expect(advancingRebases(raw).length, `${rel} pushes without ever RUNNING an advancing git rebase (--abort does not count)`).toBeGreaterThan(0);
        });

        it('never auto-resolves a rebase (-X ours/theirs, -s recursive strategy flags)', () => {
          // README.md is the canonical npm-README SoT and is NOT purely derived, so an
          // auto-resolve could destroy authored release copy. The only maintained action that
          // offers rebase-retry does exactly this, which is why it was rejected.
          const body = stripComments(raw).join('\n');
          expect(/-X\s*(ours|theirs)|--strategy-option[= ](ours|theirs)/.test(body),
            `${rel} auto-resolves a rebase conflict`).toBe(false);
        });

        it('bounds its retries — a NUMERIC ceiling is assigned, and no loop is unbounded', () => {
          // The first draft asserted `/MAX_ATTEMPTS/` — a NAME, which is a proxy, not the
          // property. Measured: deleting the assignment left three surviving mentions (the loop
          // condition, the progress message, a comment) and the assertion stayed green. The
          // predicate is now the ASSIGNMENT of a literal integer, which cannot survive its own
          // deletion.
          const body = stripComments(raw).join('\n');
          expect(/^\s*[A-Z_]*MAX_ATTEMPTS\s*=\s*[0-9]+\s*$/m.test(body),
            `${rel} retries with no assigned numeric ceiling`).toBe(true);
          expect(/while\s+(true|:)\b|until\s+git\s+push|for\s*\(\(\s*;\s*;\s*\)\)/.test(body),
            `${rel} contains an unbounded push loop`).toBe(false);
        });
      }
    });
  }

  it('every registered ci-workflow row still exists on disk', () => {
    const onDisk = new Set(workflowFiles().map((f) => `.github/workflows/${f}`));
    for (const path of Object.keys(ciRows)) expect(onDisk.has(path), `${path} is registered but not on disk`).toBe(true);
  });
});

describe('the canary is PROVEN able to fail', () => {
  // Not ceremony. An assertion nobody has watched go red is a hope. Each fixture is the real
  // predicate applied to a deliberately broken document.
  const safe = [
    'name: x',
    'jobs:',
    '  a:',
    '    steps:',
    '      - run: |',
    '          MAX_ATTEMPTS=3',
    '          git fetch origin "$BRANCH"',
    '          git rebase "origin/$BRANCH"',
    '          git push origin "HEAD:$BRANCH"',
    '',
  ].join('\n');

  it('the SAFE fixture satisfies every predicate (or the fixtures below prove nothing)', () => {
    expect(gitPushLines(safe).length).toBe(1);
    expect(stripComments(safe).filter((l) => /^\s*git\s+push\s*$/.test(l))).toEqual([]);
    expect(gitPushLines(safe).filter((l) => /--force(-with-lease)?\b/.test(l))).toEqual([]);
  });

  it('a BARE git push is caught, alone on its line', () => {
    expect(barePushLines(safe.replace('git push origin "HEAD:$BRANCH"', 'git push')).length).toBe(1);
  });

  it('a BARE git push hiding inside an `if` is caught too', () => {
    // The exact break that walked through the line-anchored first draft.
    expect(barePushLines('              if git push; then').length).toBe(1);
    expect(barePushLines('          git push || exit 1').length).toBe(1);
    expect(barePushLines('          git push >"$OUT" 2>&1').length).toBe(1);
  });

  it('an ARGUMENTED push is NOT flagged as bare', () => {
    expect(barePushLines(safe)).toEqual([]);
    expect(barePushLines('              if git push origin "HEAD:$BRANCH" >"$O" 2>&1; then')).toEqual([]);
    expect(barePushLines('          git push origin v1.2.3')).toEqual([]);
  });

  it('`git rebase --abort` alone does NOT satisfy the rebase requirement', () => {
    // The second break that stayed green: deleting the real rebase left the conflict handler's
    // `git rebase --abort`, and a bare /git rebase/ predicate accepted it.
    const bad = safe.replace('          git rebase "origin/$BRANCH"', '          git rebase --abort || true');
    expect(gitInvocations(bad, 'rebase').length, 'the --abort IS an invocation').toBe(1);
    expect(advancingRebases(bad).length, 'but it advances nothing').toBe(0);
    expect(advancingRebases(safe).length).toBe(1);
  });

  it('a --force push is caught', () => {
    const bad = safe.replace('git push origin', 'git push --force origin');
    expect(gitPushLines(bad).filter((l) => /--force(-with-lease)?\b/.test(l)).length).toBe(1);
  });

  it('a --force-with-lease push is caught', () => {
    const bad = safe.replace('git push origin', 'git push --force-with-lease origin');
    expect(gitPushLines(bad).filter((l) => /--force(-with-lease)?\b/.test(l)).length).toBe(1);
  });

  it('a push with NO fetch/rebase is caught', () => {
    const bad = safe.replace('          git fetch origin "$BRANCH"\n', '').replace('          git rebase "origin/$BRANCH"\n', '');
    expect(writesGitRef(bad)).toBe(true);
    expect(gitInvocations(bad, 'fetch').length).toBe(0);
    expect(advancingRebases(bad).length).toBe(0);
  });

  it('an ERROR MESSAGE mentioning git fetch does NOT satisfy the fetch requirement', () => {
    // The exact blind spot the deliberate-break step exposed, kept as a permanent fixture.
    const bad = safe.replace('          git fetch origin "$BRANCH"',
      '          echo "::error::git fetch origin $BRANCH failed; cannot establish what to rebase onto."');
    expect(gitInvocations(bad, 'fetch').length, 'a string ABOUT fetching must not count as fetching').toBe(0);
    expect(writesGitRef(bad)).toBe(true);
  });

  it('a DELETED numeric ceiling is caught even though the name survives elsewhere', () => {
    // The second blind spot: /MAX_ATTEMPTS/ stayed true after the assignment was removed,
    // because the loop condition and the progress message still name the variable.
    const withLoop = safe.replace('          MAX_ATTEMPTS=3',
      '          MAX_ATTEMPTS=3\n          while [ "$a" -lt "$MAX_ATTEMPTS" ]; do echo "attempt $a/$MAX_ATTEMPTS"; done');
    const bad = withLoop.replace('          MAX_ATTEMPTS=3\n', '');
    expect(/MAX_ATTEMPTS/.test(bad), 'the NAME still appears — which is why the old predicate was blind').toBe(true);
    expect(/^\s*[A-Z_]*MAX_ATTEMPTS\s*=\s*[0-9]+\s*$/m.test(stripComments(bad).join('\n'))).toBe(false);
    expect(/^\s*[A-Z_]*MAX_ATTEMPTS\s*=\s*[0-9]+\s*$/m.test(stripComments(withLoop).join('\n'))).toBe(true);
  });

  it('an auto-resolving rebase is caught', () => {
    const bad = safe.replace('git rebase "origin/$BRANCH"', 'git rebase -X ours "origin/$BRANCH"');
    expect(/-X\s*(ours|theirs)/.test(stripComments(bad).join('\n'))).toBe(true);
  });

  it('an UNBOUNDED retry loop is caught', () => {
    const bad = safe.replace('          MAX_ATTEMPTS=3\n', '          while true; do\n');
    const body = stripComments(bad).join('\n');
    expect(/^\s*[A-Z_]*MAX_ATTEMPTS\s*=\s*[0-9]+\s*$/m.test(body)).toBe(false);
    expect(/while\s+(true|:)\b|until\s+git\s+push|for\s*\(\(\s*;\s*;\s*\)\)/.test(body)).toBe(true);
  });

  it('COMMENTS that mention the forbidden shapes are NOT mistaken for using them', () => {
    // The measured false-positive set from origin/main, verbatim. Without this, the --force
    // predicate reads 3 violations that do not exist and can only be cleared by editing
    // deploy.yml — a file outside this wave's Scope.
    const commentary = [
      '      # and "Never reset --hard / push --force / branch -D without auth", and until this wave',
      '            # --force-recreate defends against env_file race: docker compose',
      '            docker compose up -d --build --force-recreate',
      '        # the bare `git push` that stood here failed non-fast-forward',
      '        # NEVER a force, NEVER a lease, NEVER an auto-resolve.',
    ].join('\n');
    expect(gitPushLines(commentary)).toEqual([]);
    expect(writesGitRef(commentary)).toBe(false);
    expect(barePushLines(commentary)).toEqual([]);
  });

  it('a docker --force-recreate line is not a git push line', () => {
    expect(gitPushLines('            docker compose up -d --build --force-recreate')).toEqual([]);
  });
});
