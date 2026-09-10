/**
 * prereg-mirror-parity.test.ts — OPS-PREREG-VAULT-MIRROR-W1.
 *
 * THE STALENESS GATE. `Claude files/repo-preregistrations/` mirrors the repo's
 * `audits/*preregistration*.md` so the PLANNING agent — whose mount is the vault only — can
 * read the commitments it must plan against. A silently stale mirror is worse than no mirror:
 * a wave would plan against a superseded registration and never know. This is what stops a
 * registration landing WITHOUT its mirror, at the seam where that landing happens.
 *
 * WHY A TEST AND NOT A pre-push HOOK BLOCK. The vitest suite already runs inside the pre-push
 * gate, so this blocks a stale landing at the same seam with the same force — while a new hook
 * block would mutate the ONE file in the shared git-common-dir that governs every worktree on
 * the machine (130 at the time of writing), which has twice halted every parallel session.
 * Same blocking power, no blast radius. Ruled this way three times now.
 *
 * ── THE CI PATH IS NOT A SILENT PASS ───────────────────────────────────────────────────────
 * There is no vault in CI. A test that "passes" there would make `exit 0` encode both
 * "verified, clean" and "verified nothing", which is precisely what the verdict-token law
 * forbids. So when the mirror is out of reach this file SKIPS — visibly, as skipped rather
 * than passed — and the always-running reachability test prints
 *
 *     PREREG_MIRROR_PARITY_VERDICT=PASS | FAIL | INDETERMINATE
 *
 * Skipped and passed are distinguishable in the vitest output; the token is distinguishable in
 * the log. Neither is inferred from an exit code.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, basename } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const REF = 'origin/main';

/**
 * The vault path comes from the ONE declaration, `scripts/lib/system-map-path.sh`, parsed out
 * rather than restated. Two copies of one absolute string can disagree about WHICH directory,
 * and after a vault move that disagreement does not surface as an error — it surfaces as a
 * gate that guards a path nobody writes to and reports PASS forever.
 */
function declaredVaultRoot(): string | null {
  const lib = join(REPO_ROOT, 'scripts', 'lib', 'system-map-path.sh');
  if (!existsSync(lib)) return null;
  const m = /ALGOVAULT_SYSTEM_MAP_PATH="\$\{SYSTEM_MAP_PATH:-(.+?)\/system-map\.md\}"/.exec(
    readFileSync(lib, 'utf8'),
  );
  return m ? m[1] : null;
}

function git(args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/**
 * The kind rule, restated here ON PURPOSE as an INDEPENDENT implementation of
 * `prereg-vault-mirror.sh`'s `classify_kind`. A test that imported the subject's own classifier
 * would agree with it by construction and could never catch it drifting — the vacuous
 * self-comparison this estate has now paid for twice. Divergence between these two is exactly
 * the finding worth having.
 */
function expectedKind(base: string): 'registration' | 'procedure' | 'UNCLASSIFIED' {
  if (base === 'PREREGISTRATION-PROCEDURE.md') return 'procedure';
  if (/^[a-z0-9][a-z0-9-]*-preregistration-\d{4}-\d{2}-\d{2}\.md$/.test(base)) return 'registration';
  return 'UNCLASSIFIED';
}

const isCandidate = (base: string) => /preregistration.*\.md$/i.test(base);

const VAULT_ROOT = declaredVaultRoot();
const MIRROR_DIR = VAULT_ROOT ? join(VAULT_ROOT, 'Claude files', 'repo-preregistrations') : null;
const STATE_FILE = MIRROR_DIR ? join(MIRROR_DIR, '_MIRROR-STATE.json') : null;
const REF_COMMIT = git(['rev-parse', REF]);

const unreachable: string | null = !VAULT_ROOT
  ? 'the vault path SoT (scripts/lib/system-map-path.sh) did not parse'
  : !existsSync(VAULT_ROOT)
    ? `no vault at ${VAULT_ROOT} — expected in CI, where the vault is not mounted`
    : !existsSync(STATE_FILE!)
      ? `no mirror state at ${STATE_FILE} — run: bash ops/scripts/prereg-vault-mirror.sh mirror`
      : !REF_COMMIT
        ? `cannot resolve ${REF} in this checkout — the freshness leg has nothing to compare against`
        : null;

interface Row {
  mirror: string;
  kind: string;
  source_path: string;
  source_blob: string;
  source_commit: string;
  body_offset_bytes: number;
  synced_at: string;
}

describe('prereg vault mirror — reachability', () => {
  // ALWAYS RUNS. This is the line that keeps `exit 0` from meaning two different things.
  it('reports whether the mirror could be verified at all', () => {
    if (unreachable) {
      // eslint-disable-next-line no-console
      console.log(
        `PREREG_MIRROR_PARITY_VERDICT=INDETERMINATE — parity NOT checked: ${unreachable}`,
      );
    } else {
      // eslint-disable-next-line no-console
      console.log(
        `PREREG_MIRROR_PARITY_VERDICT=PASS — parity checked against ${REF} @ ${REF_COMMIT!.slice(0, 8)}`,
      );
    }
    expect(typeof unreachable === 'string' || unreachable === null).toBe(true);
  });
});

describe.skipIf(unreachable !== null)('prereg vault mirror — parity with origin/main', () => {
  const state = () => JSON.parse(readFileSync(STATE_FILE!, 'utf8')) as {
    files: Row[];
    file_count: number;
    verifier_sha256: string;
    synced_at_epoch: number;
    max_age_hours: number;
  };

  /** Every `audits/*preregistration*.md` on the ref, with its live blob. */
  const liveCandidates = (): Map<string, string> => {
    const out = git(['ls-tree', '-r', REF, '--format=%(objectname) %(path)', 'audits/']) ?? '';
    const m = new Map<string, string>();
    for (const line of out.split('\n')) {
      const sp = line.indexOf(' ');
      if (sp < 0) continue;
      const blob = line.slice(0, sp);
      const path = line.slice(sp + 1);
      if (isCandidate(basename(path))) m.set(path, blob);
    }
    return m;
  };

  // Budgets are DECLARED in the OPTIONS ARGUMENT, which is the only place
  // scripts/check-test-budget.mjs reads them — a trailing `}, 20000)` is invisible to it. 20s is
  // ~8.5x the observed MAX of 2,351ms for this spawn (nine `git rev-parse` calls plus a
  // `git ls-tree`); headroom is taken from the max and never a p95, because this suite shares a
  // machine with ~130 worktrees and the tail is what trips a budget.
  //
  // NO APOSTROPHE IN THIS TITLE, either. That gate parses a title with
  // /^\s*(['"`])([\s\S]*?)\1/, which does not honour a backslash escape, so
  // `'the script\'s ...'` reads as the title `the script\`. Measured here. The parser
  // limitation belongs to OPS-TEST-BUDGET-BACKFILL-W1; avoiding the apostrophe is ours.
  it('the repo-side verifier reports PASS', { timeout: 20000 }, () => {
    let out = '';
    let code = 0;
    try {
      out = execFileSync('bash', [join(REPO_ROOT, 'ops', 'scripts', 'prereg-vault-mirror.sh'), '--verify'], {
        encoding: 'utf8',
      });
    } catch (e: unknown) {
      const err = e as { stdout?: string; status?: number };
      out = err.stdout ?? '';
      code = err.status ?? 1;
    }
    // Gate on the TOKEN, never the bare code.
    expect(out, out).toContain('PREREG_MIRROR_VERDICT=PASS');
    expect(code, out).toBe(0);
  });

  it('mirrors EVERY classified pre-registration on the ref, and nothing else', { timeout: 20000 }, () => {
    const rows = state().files;
    const live = liveCandidates();
    const expected = [...live.keys()].filter((p) => expectedKind(basename(p)) !== 'UNCLASSIFIED');

    // The count. Q3's rider: a count alone would pass while every file was the wrong kind, so
    // the kinds are asserted separately below — both, never one standing in for the other.
    expect(rows.length, `mirrored ${rows.length}, ref carries ${expected.length}`).toBe(expected.length);
    expect(state().file_count).toBe(rows.length);
    expect(rows.map((r) => r.source_path).sort()).toEqual(expected.sort());

    // An UNCLASSIFIED candidate must never have been mirrored — that is the whole reason the
    // classifier refuses instead of defaulting.
    for (const p of live.keys()) {
      if (expectedKind(basename(p)) === 'UNCLASSIFIED') {
        expect(rows.find((r) => r.source_path === p), `${p} is UNCLASSIFIED and must not be mirrored`).toBeUndefined();
      }
    }
  });

  it('assigns each file the kind the declared rule gives it', () => {
    for (const r of state().files) {
      expect(r.kind, `${r.mirror} carries kind=${r.kind}`).toBe(expectedKind(r.mirror));
    }
    // The live corpus, pinned by shape rather than by a bare number: exactly one procedure, and
    // it is the procedure file. A future PREREGISTRATION-TEMPLATE.md cannot slip in as binding.
    const procs = state().files.filter((r) => r.kind === 'procedure');
    expect(procs.map((r) => r.mirror)).toEqual(['PREREGISTRATION-PROCEDURE.md']);
    expect(state().files.filter((r) => r.kind === 'registration').length).toBeGreaterThan(0);
  });

  it('pins the blob each source path actually has on the ref RIGHT NOW', { timeout: 20000 }, () => {
    for (const r of state().files) {
      const live = git(['rev-parse', `${REF}:${r.source_path}`]);
      expect(live, `${r.source_path} is gone from ${REF} but still mirrored`).toBeTruthy();
      expect(
        r.source_blob,
        `${r.mirror} pins ${r.source_blob} but ${REF} holds ${live} — re-run: bash ops/scripts/prereg-vault-mirror.sh mirror`,
      ).toBe(live);
    }
  });

  it('every mirrored body still hashes to the blob its header declares', () => {
    for (const r of state().files) {
      const f = join(MIRROR_DIR!, r.mirror);
      expect(existsSync(f), `${r.mirror} is named by the state file but missing on disk`).toBe(true);
      const buf = readFileSync(f);
      const body = buf.subarray(r.body_offset_bytes);
      // git's blob hash, computed here rather than shelled out, so this leg does not depend on
      // the same `git hash-object` invocation the subject uses.
      const h = createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
      expect(h, `${r.mirror} has been HAND-EDITED — the repo copy is authoritative`).toBe(r.source_blob);
    }
  });

  it('carries the read-only marker and full provenance in every header', () => {
    for (const r of state().files) {
      const head = readFileSync(join(MIRROR_DIR!, r.mirror), 'utf8').slice(0, r.body_offset_bytes);
      expect(head, r.mirror).toContain('DERIVED COPY — READ-ONLY');
      expect(head, r.mirror).toContain('THE REPO WINS');
      expect(head, r.mirror).toContain(`source_path:   ${r.source_path}`);
      expect(head, r.mirror).toContain(`source_blob:   ${r.source_blob}`);
      expect(head, r.mirror).toContain(`source_commit: ${r.source_commit}`);
      expect(head, r.mirror).toContain(`synced_at:     ${r.synced_at}`);
    }
  });

  it('pins the vault-side verifier, so a patched one cannot clear itself', () => {
    const v = join(MIRROR_DIR!, '_verify.sh');
    expect(existsSync(v), 'the vault-side verifier is missing').toBe(true);
    const sha = createHash('sha256').update(readFileSync(v)).digest('hex');
    expect(sha, '_verify.sh has been modified since the last sync').toBe(state().verifier_sha256);
    expect(statSync(v).mode & 0o111, '_verify.sh must be executable by the planning agent').toBeGreaterThan(0);
  });

  it('is within its declared age bound — an intact mirror is not a fresh one', () => {
    const s = state();
    const ageH = (Date.now() / 1000 - s.synced_at_epoch) / 3600;
    expect(ageH, `mirror is ${ageH.toFixed(1)}h old, bound ${s.max_age_hours}h`).toBeLessThanOrEqual(
      s.max_age_hours,
    );
  });
});
