import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * OPS-XREPO-CI-CANARY-DARK-W1 — the first test this canary has ever had.
 *
 * It shipped 2026-08-06, its two alerts were dark until 2026-08-21, its reader was rate-limited
 * blind for most of its life, and its first real delivery rendered literal `%0A`. Every one of
 * those was found by hand. `git grep xrepo` over origin/main matched no test file, so nothing in
 * CI or the pre-push gate could have caught any of them.
 *
 * The canary carries its own `--self-test` (it must — it runs on a host, far from this suite).
 * This file's job is to make CI RUN that self-test, and to pin the three regressions that have
 * actually happened, so they cannot come back through a path the self-test does not own.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CANARY = 'ops/cron/xrepo-ci-conclusion-canary.sh';
const src = readFileSync(resolve(ROOT, CANARY), 'utf8');

/** The script's executable body — comments stripped, self-test cut. */
const executableBody = src
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n')
  .split(/^self_test\(\)/m)[0];

const runSelfTest = () => {
  try {
    return { code: 0, out: execFileSync('bash', [CANARY, '--self-test'], { cwd: ROOT, encoding: 'utf8' }) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
};

describe('xrepo-ci-conclusion-canary — self-test', () => {
  const r = runSelfTest();

  it('passes, and prints exactly one terminal verdict token', () => {
    expect(r.out).toContain('XREPO_CI_VERDICT=PASS');
    expect(r.out.match(/XREPO_CI_VERDICT=/g)?.length).toBe(1);
    expect(r.code).toBe(0);
  });

  it('is not vacuous — it reports the number of assertions it actually ran', () => {
    const m = r.out.match(/SELF-TEST: PASS — (\d+) assertions/);
    expect(m, `no assertion count in output:\n${r.out}`).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(30);
  });
});

describe('xrepo-ci-conclusion-canary — regressions that have actually happened', () => {
  /**
   * D1. The reader was `api.github.com`, whose unauthenticated budget (60/hr per IP, shared with
   * everything else egressing signal-1) was drained. Measured 2026-08-21 in one shell on that
   * host: the REST endpoint returned 403 while the badge endpoint returned 200. Re-introducing a
   * REST read puts the canary back on a budget it does not control.
   */
  it('never reads a conclusion from the REST API', () => {
    expect(executableBody).not.toMatch(/api\.github\.com/);
    expect(executableBody).toMatch(/badge\.svg\?branch=/);
  });

  /**
   * D2. `send_telegram.sh` does its own `--data-urlencode "text=${BODY}"`, so a body carrying
   * `%0A` is double-encoded and Telegram prints the escape literally. Measured on the DELIVERED
   * body: `09:41:02Z [xrepo_ci_dark] FIRED: HTTP 200 body=🟡 AlgoVault Alert%0A%0A…`. This canary
   * was the only caller on the host still doing it; ~30 others pipe real newlines.
   */
  it('builds alert bodies with real newlines, never %0A escapes', () => {
    expect(executableBody).not.toMatch(/%0A/);
  });

  /**
   * D3 (inherited, from OPS-CI-MAIN-WRITER-HARDEN-W1). `send_telegram.sh`'s fire contract is
   * POSITIONAL — `<alert_id> <severity> [body_file|-]`. This script called it with env vars, so
   * `$2` was unset, the wrapper died on `severity required`, and the fail-open swallowed it.
   * Both alerts were dark for two weeks. The self-test's mock enforces the same refusal; this
   * pins the call SHAPE in the committed source as well, because the mock only sees what runs.
   */
  it('invokes the alerter positionally, not through environment variables', () => {
    expect(executableBody).toMatch(/"\$SEND" "\$id" "CRITICAL_PERSISTENT" -/);
    expect(executableBody).not.toMatch(/ALERT_ID=.*"\$SEND"/);
  });
});

describe('xrepo-ci-conclusion-canary — the watch list is declared in two places and they must agree', () => {
  /**
   * The script's WATCHED default and the monitoring-inventory row's `watches[]` are two
   * declarations of one fact. Nothing previously compared them, so a workflow could be added to
   * one and not the other — and the inventory is what the reconciler and every human read.
   */
  const inventory = JSON.parse(readFileSync(resolve(ROOT, 'ops/monitoring/monitoring-inventory.json'), 'utf8')) as {
    artifacts: Array<{ id: string; watches?: Array<{ repo: string; workflow: string; label: string; branch?: string }> }>;
  };
  const row = inventory.artifacts.find((a) => a.id === 'xrepo-ci-conclusion-canary');

  const watchedRows = (() => {
    const m = src.match(/WATCHED="\$\{XREPO_CI_WATCHED-([\s\S]*?)\}"/);
    if (!m) return [];
    return m[1]
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [repo, workflow, label, branch] = l.split('|');
        return { repo, workflow, label, branch };
      });
  })();

  it('parses a non-empty watch list out of the script (guards the assertions below)', () => {
    expect(watchedRows.length).toBeGreaterThanOrEqual(2);
    expect(row, 'no xrepo-ci-conclusion-canary row in the monitoring inventory').toBeTruthy();
  });

  it('declares a branch on every row — the badge reads ONE branch, so it may not be inferred', () => {
    for (const w of watchedRows) {
      expect(w.branch, `watch row ${w.repo}/${w.workflow} has no branch field`).toBeTruthy();
    }
    for (const w of row!.watches ?? []) {
      expect(w.branch, `inventory watch row ${w.repo}/${w.workflow} has no branch field`).toBeTruthy();
    }
  });

  it('matches the inventory row exactly, repo/workflow/label/branch', () => {
    const norm = (xs: Array<{ repo: string; workflow: string; label: string; branch?: string }>) =>
      xs.map((w) => `${w.repo}|${w.workflow}|${w.label}|${w.branch}`).sort();
    expect(norm(watchedRows)).toEqual(norm(row!.watches ?? []));
  });
});
