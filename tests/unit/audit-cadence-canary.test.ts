/**
 * OPS-AUDIT-CADENCE-CANARY-W1 CH2 — the cadence canary's token grammar and exit-code contract,
 * pinned CROSS-LANGUAGE through the SHIPPED `main()`.
 *
 * `ops/monitoring/audit-cadence-canary.py` is a Python canary whose callers are shell: the cron
 * line at `51 8 * * *`, and CH3's verification gate which greps its verdict over SSH. Nothing in
 * the TypeScript tree can import it, so the only honest way to pin its contract is to RUN it and
 * read what it emits.
 *
 * ─── WHY THIS FILE EXISTS, GIVEN THE CANARY ALREADY HAS A 32-CHECK `--self-test` ─────────────
 * A hermetic self-test is structurally blind to exactly what its own seam replaces. That suite
 * asserts `EXIT_FOR` as DATA and builds the alert argv as DATA — it never proves that `main()`
 * ACTUALLY returns those codes, nor that the token reaches stdout exactly once on every path.
 * Those are the two facts every caller depends on, and they are precisely what a refactor breaks
 * silently. This repo has already paid for that once: a sibling gate's suite asserted its verdict
 * TOKENS but never the token→exit-code association, so re-coding INDETERMINATE to 0 left the
 * whole suite green while the gate stopped blocking.
 *
 * ─── THE 0/0/0/3 MAPPING IS LOAD-BEARING FOR TWO OTHER GATES ─────────────────────────────────
 * CH2's gate greps `AUDIT_CADENCE_VERDICT=INDETERMINATE` and CH3's gate REDs on it. If DUE or
 * OVERDUE ever started exiting non-zero, cron would mail an operator who already has the page —
 * a second, worse notification channel. And it deliberately DIFFERS from its sibling build gate
 * `scripts/check-audit-cadence-schema.mjs`, which maps FAIL→1 because a build gate must fail the
 * build. One meaning, one exit code, chosen locally. **Do not align them.**
 *
 * SPAWN BUDGET DECLARED — every block here shells out to `python3`, and
 * `scripts/check-test-budget.mjs` blocks a spawning block that declares none. The budget sits in
 * the OPTIONS ARG, never as a trailing number: the gate reads `timeout:` from the text BEFORE the
 * callback, so `it(name, fn, 20_000)` declares nothing.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(__dirname, '../..');
const PY = path.join(REPO, 'ops/monitoring/audit-cadence-canary.py');
const SRC = readFileSync(PY, 'utf8');

const TOKEN = 'AUDIT_CADENCE_VERDICT';

/** Every line that IS a terminal verdict token — anchored at column 0, nothing before it. */
function tokenLines(stdout: string): string[] {
  return stdout.split('\n').filter((l) => l.startsWith(`${TOKEN}=`));
}

/**
 * Build a ledger whose single entry is `daysAgo` old BY ITS OWN `completed_utc`, then drive the
 * shipped `main()` against it with the Telegram wrapper stubbed to a recorder.
 *
 * The stub is the point: it proves the send path is reachable and correctly formed WITHOUT ever
 * touching the real wrapper — which would write a 24h cooldown marker and suppress the next
 * genuine page.
 */
function runAgainst(
  daysAgo: number,
  opts: { cadence?: number; warnLead?: number; corrupt?: boolean; absent?: boolean; empty?: boolean } = {},
): { stdout: string; status: number; sent: string | null } {
  const dir = mkdtempSync(path.join(tmpdir(), 'audit-cadence-'));
  try {
    const ledger = path.join(dir, 'audit-cadence.json');
    const stub = path.join(dir, 'stub-tg.sh');
    const sent = path.join(dir, 'sent.log');
    writeFileSync(stub, `#!/bin/sh\n{ echo "ARGV: $*"; cat; } >> ${JSON.stringify(sent)}\n`, { mode: 0o755 });

    if (!opts.absent) {
      if (opts.corrupt) {
        writeFileSync(ledger, '{ not json');
      } else {
        const ts = new Date(Date.now() - daysAgo * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
        writeFileSync(ledger, JSON.stringify({
          schema_version: 1,
          cadence_days: opts.cadence ?? 30,
          warn_lead_days: opts.warnLead ?? 7,
          rotation: ['algovault-bot', 'autonomous-optimizer', 'algovault-editorial', 'algovault-skills'],
          rotation_slot: 0,
          audits: opts.empty ? [] : [{
            wave_id: 'SECURITY-AUDIT-MONTHLY-W1',
            completed_utc: ts,
            baseline_sha: '0'.repeat(40),
            head_sha: 'c'.repeat(40),
            scope: ['crypto-quant-signal-mcp'],
          }],
        }, null, 2));
      }
    }

    const r = spawnSync('python3', [PY], {
      encoding: 'utf8',
      env: { ...process.env, AC_LEDGER: ledger, AC_TG_WRAPPER: stub },
    });
    return {
      stdout: r.stdout ?? '',
      status: r.status ?? -1,
      sent: existsSync(sent) ? readFileSync(sent, 'utf8') : null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('audit-cadence-canary — verdict token grammar', () => {
  it('emits EXACTLY ONE terminal verdict token on every path', { timeout: 30_000 }, () => {
    for (const [label, run] of [
      ['PASS', () => runAgainst(1)],
      ['DUE', () => runAgainst(25)],
      ['OVERDUE', () => runAgainst(40)],
      ['INDETERMINATE(absent)', () => runAgainst(0, { absent: true })],
      ['INDETERMINATE(corrupt)', () => runAgainst(0, { corrupt: true })],
      ['INDETERMINATE(empty)', () => runAgainst(0, { empty: true })],
    ] as const) {
      const { stdout } = run();
      expect(tokenLines(stdout), `${label} must emit exactly one ${TOKEN}= line`).toHaveLength(1);
    }
  });

  it('the token vocabulary is exactly the four declared verdicts', { timeout: 20_000 }, () => {
    // Pinned against the SOURCE, so a fifth state cannot be added without updating this list.
    const declared = [...SRC.matchAll(/AUDIT_CADENCE_VERDICT=\{?(\w+)/g)].map((m) => m[1]);
    const emitted = new Set<string>();
    for (const run of [() => runAgainst(1), () => runAgainst(25), () => runAgainst(40), () => runAgainst(0, { absent: true })]) {
      emitted.add(tokenLines(run().stdout)[0].split('=')[1]);
    }
    expect([...emitted].sort()).toEqual(['DUE', 'INDETERMINATE', 'OVERDUE', 'PASS']);
    expect(declared.length, 'the source must reference the token literal').toBeGreaterThan(0);
  });
});

describe('audit-cadence-canary — exit-code contract, through the real main()', () => {
  /**
   * THE reason this file exists. `EXIT_FOR` being right as DATA proves nothing about what the
   * process returns; only running it does.
   */
  it('PASS / DUE / OVERDUE all exit 0 — a page must not ALSO mail cron', { timeout: 30_000 }, () => {
    expect(runAgainst(1).status, 'PASS').toBe(0);
    expect(runAgainst(25).status, 'DUE').toBe(0);
    expect(runAgainst(40).status, 'OVERDUE').toBe(0);
  });

  it('INDETERMINATE exits 3 on all three fail-open inputs — never 0, never PASS', { timeout: 30_000 }, () => {
    for (const [label, opts] of [
      ['absent', { absent: true }],
      ['unparseable', { corrupt: true }],
      ['empty audits[]', { empty: true }],
    ] as const) {
      const r = runAgainst(0, opts);
      expect(r.status, `${label} must exit 3`).toBe(3);
      expect(tokenLines(r.stdout)[0], `${label} must not read as PASS`).toBe(`${TOKEN}=INDETERMINATE`);
    }
  });

  it('a MISSING ledger never reads as "no audit is overdue"', { timeout: 20_000 }, () => {
    const r = runAgainst(0, { absent: true });
    expect(r.stdout).not.toContain(`${TOKEN}=PASS`);
    expect(r.sent, 'a blind cadence guard must escalate, not go quiet').toContain('SECURITY_AUDIT_CADENCE_INDETERMINATE');
  });
});

describe('audit-cadence-canary — the band edges, through the real main()', () => {
  it('DUE opens at cadence - warn_lead and OVERDUE opens at cadence', { timeout: 30_000 }, () => {
    // 30/7 => PASS below 23, DUE in [23,30), OVERDUE at >= 30. An off-by-one here shifts every
    // page by a full day and nothing else in the estate would notice.
    expect(tokenLines(runAgainst(22.9).stdout)[0]).toBe(`${TOKEN}=PASS`);
    expect(tokenLines(runAgainst(23.1).stdout)[0]).toBe(`${TOKEN}=DUE`);
    expect(tokenLines(runAgainst(29.9).stdout)[0]).toBe(`${TOKEN}=DUE`);
    expect(tokenLines(runAgainst(30.1).stdout)[0]).toBe(`${TOKEN}=OVERDUE`);
  });
});

describe('audit-cadence-canary — the alert the operator actually receives', () => {
  it('OVERDUE dispatches the delivering severity and names the whole next dispatch', { timeout: 20_000 }, () => {
    const r = runAgainst(41);
    expect(r.sent, 'the send path must have been reached').toBeTruthy();
    const body = r.sent as string;
    // CRITICAL_PERSISTENT is the ONLY severity send_telegram.sh delivers (:526); anything else
    // is logged as SUPPRESSED_SEVERITY. An OVERDUE that does not deliver is a dead page.
    expect(body).toContain('ARGV: SECURITY_AUDIT_OVERDUE CRITICAL_PERSISTENT -');
    // Every quantity carries its ENTITY NOUN — a bare parenthesised number beside a count is
    // forbidden and once cost a real operator misread.
    expect(body).toMatch(/\d+ day\(s\) PAST DUE/);
    expect(body).toContain('wave SECURITY-AUDIT-MONTHLY-W1');
    expect(body).toContain('c'.repeat(40));                       // next BASELINE_SHA
    expect(body).toContain('autonomous-optimizer');               // rotation[(slot+1) % len]
    expect(body).toContain('R7 appends its own audits[] entry');  // what keeps the corpus alive
  });

  it('the NEXT wave id is TEMPLATE form — a literal number is forbidden', { timeout: 20_000 }, () => {
    const body = runAgainst(41).sent as string;
    // Scoped to the "Next wave:" line ONLY. The body legitimately names the LAST audit's wave id
    // ("Last audit: wave SECURITY-AUDIT-MONTHLY-W1") — that is a historical fact read from the
    // ledger, and banning it would ban the evidence. What CLAUDE.md forbids is a hardcoded
    // FORWARD wave number, because `send_telegram.sh`'s resolver substitutes it at send time and
    // a literal there once shipped an Action line naming an already-GREEN wave.
    const nextLine = body.split('\n').find((l) => l.startsWith('Next wave:'));
    expect(nextLine, 'the body must carry a Next wave line').toBeTruthy();
    expect(nextLine).toContain('SECURITY-AUDIT-MONTHLY-W{NEXT}');
    expect(nextLine).not.toMatch(/-W\d/);
  });

  it('DUE uses the NON-delivering severity, so it cannot page for warn_lead_days', { timeout: 20_000 }, () => {
    const body = runAgainst(25).sent as string;
    expect(body).toContain('ARGV: SECURITY_AUDIT_DUE WARN -');
    expect(body).not.toContain('CRITICAL_PERSISTENT');
  });

  it('PASS sends no alert and clears any standing OVERDUE', { timeout: 20_000 }, () => {
    const r = runAgainst(1);
    expect(r.sent).toContain('--clear SECURITY_AUDIT_OVERDUE');
    expect(r.sent).not.toContain('CRITICAL_PERSISTENT');
  });
});

describe('audit-cadence-canary — freshness is keyed on the PRODUCER, not the container', () => {
  it('never reads the ledger mtime — the file is rewritten hourly by declaration-sync.sh', { timeout: 20_000 }, () => {
    // Structural: an mtime-keyed age would read "fresh" forever, because declaration-sync.sh
    // rewrites this file at `33 * * * *`. The canary would then be permanently, silently green.
    // Comments are stripped so a docstring explaining the hazard is not mistaken for the hazard.
    const code = SRC.replace(/^\s*#.*$/gm, '').replace(/"""[\s\S]*?"""/g, '');
    expect(code).not.toMatch(/getmtime|st_mtime|\.stat\(\)\.st_mtime/);
  });

  it('a 40-day-old ledger written THIS SECOND is still OVERDUE', { timeout: 20_000 }, () => {
    // The fixture file is created milliseconds before the run, so its mtime is "now". Only the
    // producer's own completed_utc can produce OVERDUE here.
    expect(tokenLines(runAgainst(40).stdout)[0]).toBe(`${TOKEN}=OVERDUE`);
  });
});

describe('audit-cadence-canary — positive per-check output', () => {
  it('prints the numbers that produced the verdict, in the shape CH3\'s gate greps', { timeout: 20_000 }, () => {
    // CH3 asserts `age_days=<int> ... cadence_days=<int>`; a dark guard exiting 0 must not be
    // indistinguishable from a healthy one.
    const { stdout } = runAgainst(5);
    expect(stdout).toMatch(/age_days=\d+.*cadence_days=\d+/);
    expect(stdout).toContain('host_clock=');
  });

  it('the self-test reports a non-vacuous count and exits 0', { timeout: 30_000 }, () => {
    const r = spawnSync('python3', [PY, '--self-test'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    const m = /SELF-TEST: PASS \((\d+)\)/.exec(r.stdout ?? '');
    expect(m, 'the suite must emit its terminal count').toBeTruthy();
    expect(Number(m![1])).toBeGreaterThanOrEqual(6);
  });
});
