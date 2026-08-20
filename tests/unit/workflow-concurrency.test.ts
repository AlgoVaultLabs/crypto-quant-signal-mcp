/**
 * OPS-SERIALIZE-LANDING-AND-DEPLOY-W1 CH3 R4/R5 — every CI workflow declares how it serializes.
 *
 * ENUMERATED FROM DISK, never from a hardcoded list of six. That direction is the whole point:
 * a SEVENTH workflow must fail this canary on arrival rather than wait to be noticed. A test
 * that iterated a literal list would pass forever while the file it does not know about deploys
 * concurrently with another one.
 *
 * ── WHY THIS EXISTS ALONGSIDE scripts/check-shared-state.mjs ────────────────────────────────
 *
 * They own DIFFERENT questions and neither duplicates the other:
 *
 *   this canary            — does every workflow HAVE a group, with queue: max and no
 *                            cancel-in-progress?  (BLOCKS, in the pre-push test-gate)
 *   check-shared-state.mjs — do the DECLARATION and the REALITY agree, in both directions?
 *                            (BLOCKS on a mismatch; only the "declared but not applied yet"
 *                            state reports, precisely because this canary owns it)
 *
 * ── ONE PARSER, NOT TWO ─────────────────────────────────────────────────────────────────────
 *
 * The YAML is read with the SAME exported parseWorkflowConcurrency the reconciler uses. Two
 * readers of one grammar drift, and the bug returns in whichever copy nobody is watching. It is
 * also comment-immune by construction, which matters here: every workflow's block carries a
 * comment explaining why `cancel-in-progress` is NOT set, and a naive grep would read that
 * explanation as the setting.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
// @ts-expect-error — .mjs sibling with no type declarations; the export is plain JS.
import { parseWorkflowConcurrency } from '../../scripts/check-shared-state.mjs';

const REPO = resolve(__dirname, '../..');
const WF_DIR = join(REPO, '.github', 'workflows');
const REGISTRY = join(REPO, 'ops', 'shared-worktree-state.json');

/** Enumerate from DISK. Never a literal list — that is the property under test. */
function workflowFiles(): string[] {
  return readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
}

const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
const ciRows: Record<string, any> = Object.fromEntries(
  registry.resources.filter((r: any) => r.kind === 'ci-workflow').map((r: any) => [r.path, r]),
);

describe('CI workflow concurrency — enumerated from disk', () => {
  it('the corpus is non-empty (a vacuous sweep must never read as a clean one)', () => {
    // WE build this corpus by pointing at a directory, so an empty one means the canary checked
    // nothing — a defect in the canary, not a fact about the repo. REFUSE rather than pass.
    expect(existsSync(WF_DIR)).toBe(true);
    expect(workflowFiles().length).toBeGreaterThan(0);
  });

  // One case PER FILE, generated from the directory listing. A new workflow gets its own case
  // automatically, and fails until it is grouped and registered.
  for (const file of workflowFiles()) {
    const rel = `.github/workflows/${file}`;

    describe(rel, () => {
      const parsed = parseWorkflowConcurrency(readFileSync(join(WF_DIR, file), 'utf8'));
      const row = ciRows[rel];

      it('is REGISTERED in ops/shared-worktree-state.json', () => {
        expect(row, `${rel} is on disk but has no ci-workflow row — an unregistered workflow is an unserialized one`).toBeTruthy();
      });

      it('declares a TOP-LEVEL concurrency group', () => {
        expect(parsed.present, `${rel} has no top-level concurrency block`).toBe(true);
        expect(parsed.group, `${rel} has a concurrency block with no group`).toBeTruthy();
      });

      it('the group MATCHES the key declared in the registry', () => {
        expect(parsed.group).toBe(row?.serialization?.key);
      });

      it('sets queue: max, never the `single` default', () => {
        // Under `single` a PENDING run is cancelled when the next one queues. That is a MISSING
        // run, not a failed one — nothing anywhere goes red, and a release can silently not ship.
        expect(parsed.queue).toBe('max');
      });

      it('does NOT set cancel-in-progress', () => {
        // Wrong knob for pending-run cancellation, its `false` value is undocumented, and
        // `queue: max` + `cancel-in-progress: true` is an explicit validation error.
        expect(parsed.cancelInProgress).toBeNull();
      });

      it('does NOT also declare a JOB-level concurrency block', () => {
        // GitHub does not document how workflow-level and job-level groups interact, and a
        // load-bearing safety property must never be rented from undocumented behaviour.
        expect(parsed.jobLevel).toBe(false);
      });
    });
  }

  it('tag-triggered workflows are keyed PER-REF so two versions cannot share a group', () => {
    // Derived from the trigger, not from a hardcoded pair of filenames: a future tag-triggered
    // workflow inherits this assertion instead of quietly escaping it.
    const tagTriggered = workflowFiles().filter((f) => {
      const src = readFileSync(join(WF_DIR, f), 'utf8');
      const on = src.slice(src.search(/^on:/m));
      const end = on.search(/^[a-zA-Z_]+:/m);
      return /^\s+tags:/m.test(end > 0 ? on.slice(3, end) : on);
    });
    expect(tagTriggered.length).toBeGreaterThan(0);
    for (const f of tagTriggered) {
      const parsed = parseWorkflowConcurrency(readFileSync(join(WF_DIR, f), 'utf8'));
      expect(parsed.group, `${f} is tag-triggered, so a global group would cancel a PENDING publish for the previous version`).toContain('github.ref');
    }
  });

  it('every registered ci-workflow row still exists on disk', () => {
    // The other direction. A row whose file was deleted or renamed is a declaration guarding
    // nothing, and it would make the count-based assertions above look healthier than they are.
    const onDisk = new Set(workflowFiles().map((f) => `.github/workflows/${f}`));
    for (const path of Object.keys(ciRows)) expect(onDisk.has(path), `${path} is registered but not on disk`).toBe(true);
  });
});

describe('the canary is PROVEN able to fail', () => {
  // Not ceremony. An assertion nobody has watched go red is a hope. Each fixture below is the
  // real parser applied to a deliberately broken document, asserted through the same predicates
  // the per-file cases use above.
  const good = 'name: x\non:\n  push:\nconcurrency:\n  group: G\n  queue: max\njobs:\n  a:\n    runs-on: ubuntu-latest\n';

  it('a MISSING group fails the group assertion', () => {
    const p = parseWorkflowConcurrency(good.replace(/concurrency:\n  group: G\n  queue: max\n/, ''));
    expect(p.present).toBe(false);
    expect(p.group).toBeNull();
  });

  it('a WRONG group fails the registry-match assertion', () => {
    const p = parseWorkflowConcurrency(good.replace('group: G', 'group: SOMETHING-ELSE'));
    expect(p.group).not.toBe('G');
  });

  it('an ABSENT queue fails the queue assertion (GitHub would default to `single`)', () => {
    const p = parseWorkflowConcurrency(good.replace('  queue: max\n', ''));
    expect(p.queue).not.toBe('max');
  });

  it('a PRESENT cancel-in-progress fails the cancel assertion', () => {
    const p = parseWorkflowConcurrency(good.replace('  queue: max\n', '  cancel-in-progress: true\n'));
    expect(p.cancelInProgress).not.toBeNull();
  });

  it('a JOB-level block fails the job-level assertion', () => {
    const p = parseWorkflowConcurrency(good.replace('    runs-on: ubuntu-latest\n', '    concurrency:\n      group: J\n'));
    expect(p.jobLevel).toBe(true);
  });

  it('a comment MENTIONING the keys is not mistaken for setting them', () => {
    const p = parseWorkflowConcurrency(
      'name: x\n# cancel-in-progress: true would be the wrong knob here\nconcurrency:\n  group: G\n  # queue: max keeps every pending run alive\n  queue: max\n');
    expect(p.cancelInProgress).toBeNull();
    expect(p.queue).toBe('max');
    expect(p.group).toBe('G');
  });
});
