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

/**
 * OPS-XREPO-CI-CONCLUSION-FRESHNESS-W1-V2 CH2 — the freshness legs.
 *
 * The canary now answers two questions the badge cannot: is this repo about to have its scheduled
 * workflows auto-disabled (Leg A, on `commits/<branch>.atom`, a real `application/atom+xml`
 * contract), and how old is the run the badge just reported (Leg B, CH3, on the Actions HTML).
 * Everything below pins a property that a green self-test alone would not.
 */
describe('xrepo-ci-conclusion-canary — the 5th watch-row field is a declared enum', () => {
  const inventory = JSON.parse(readFileSync(resolve(ROOT, 'ops/monitoring/monitoring-inventory.json'), 'utf8')) as {
    artifacts: Array<{ id: string; watches?: Array<Record<string, unknown>> }>;
  };
  const row = inventory.artifacts.find((a) => a.id === 'xrepo-ci-conclusion-canary');

  const scriptRows = (src.match(/WATCHED="\$\{XREPO_CI_WATCHED-([\s\S]*?)\}"/)?.[1] ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split('|'));

  const validCadence = (v: unknown) =>
    v === 'event-driven' || (typeof v === 'number' && Number.isInteger(v) && v > 0);

  it('declares a cadence on every row of BOTH declarations — a bound is derived from it', () => {
    expect(scriptRows.length).toBeGreaterThanOrEqual(2);
    for (const r of scriptRows) {
      expect(r.length, `row ${r.join('|')} does not carry 5 fields`).toBe(5);
      const cadence = r[4] === 'event-driven' ? 'event-driven' : Number(r[4]);
      expect(validCadence(cadence), `row ${r.join('|')} has an invalid cadence`).toBe(true);
    }
    for (const w of row!.watches ?? []) {
      expect(validCadence(w.cadence_seconds), `inventory row ${String(w.workflow)} cadence`).toBe(true);
    }
  });

  it('the event-driven row is the repository_dispatch one — the exemption is declared, not emergent', () => {
    const evented = (row!.watches ?? []).filter((w) => w.cadence_seconds === 'event-driven');
    expect(evented.map((w) => w.workflow)).toEqual(['regenerate-landing.yml']);
  });

  it('the script default and the inventory agree on cadence too, not only on the first four fields', () => {
    const fromScript = scriptRows.map((r) => `${r[0]}|${r[1]}|${r[4]}`).sort();
    const fromInventory = (row!.watches ?? [])
      .map((w) => `${String(w.repo)}|${String(w.workflow)}|${String(w.cadence_seconds)}`)
      .sort();
    expect(fromScript).toEqual(fromInventory);
  });
});

describe('xrepo-ci-conclusion-canary — the freshness legs', () => {
  const r = runSelfTest();

  it('emits BOTH token lines, so a caller can gate on recency separately from the conclusion', () => {
    expect(r.out).toContain('XREPO_CI_FRESHNESS=');
    expect(r.out.match(/XREPO_CI_FRESHNESS=/g)?.length).toBe(1);
  });

  /**
   * The self-test skips the inventory-parity assertion when no checkout is reachable — correct on
   * a host, where the file genuinely does not exist. In CI it always exists, so a SKIP here would
   * mean the assertion had quietly stopped running: the seam-blindness class, in the one check
   * that compares the script's declaration against the inventory's.
   */
  it('really ran the inventory-parity assertion here — it did not take the host SKIP branch', () => {
    expect(r.out).not.toContain('inventory parity SKIPPED');
  });

  /**
   * Leg A rides `commits/<branch>.atom` because it is a real machine contract. `…/<wf>.atom`
   * answers 200 with `content-type: text/html` (measured 2026-09-22) — a 200 is not a contract,
   * so every leg asserts the content type it was promised.
   */
  it('reads repo activity from the atom feed, never from a workflow .atom URL', () => {
    expect(executableBody).toMatch(/commits\/%s\.atom|commits\/\$\{?\w+\}?\.atom/);
    expect(executableBody).not.toMatch(/actions\/workflows\/[^\s"']*\.atom/);
  });

  /**
   * Detect and alert; never mutate (Q3=A — no keepalive, because an unattended commit to a public
   * repo is a public-surface write). The chapter gate greps the WHOLE file for a repo-mutating
   * command, so not even the alert body may carry a copy-pasteable one: the body names the UI path
   * and the runbook carries the CLI form.
   *
   * It scans the COMMENT-STRIPPED body, because a mention is not an invocation: this file has
   * carried the line "publish-npm.yml's `git push` hit is a comment" since 2026-08-21, and a
   * gate that demands the deletion of the estate's own explanatory prose is the gate-writing bug
   * CLAUDE.md already records. Strings are NOT stripped — an alert body is executable text.
   */
  it('never writes to a watched repo — it detects and alerts, it does not keep anything alive', () => {
    expect(executableBody).not.toMatch(/git\s+(push|commit)/);
    expect(executableBody).not.toMatch(/gh\s+workflow\s+(enable|run)/);
    expect(executableBody).not.toMatch(/gh\s+api\s+.*-X\s+(POST|PUT|PATCH)/);
  });

  /** The ledger lives outside MONITORING_DIR so an unregistered file there cannot orphan. */
  it('appends its freshness ledger under /var/lib, not beside the installed artifacts', () => {
    expect(executableBody).toMatch(/\/var\/lib\/algovault-monitoring\/xrepo-ci-freshness\.jsonl/);
  });
});
