/**
 * OPS-GIT-IDENTITY-CANONICALIZE-W1 — behaviour tests for `scripts/check-author-identity.sh`.
 *
 * Pins BEHAVIOURS, never a hash: a hash cannot catch a re-vendor from a stale source that also
 * re-records the hash, and it says nothing about whether the gate still judges correctly.
 *
 * Every case runs in its OWN temp git repo (mkdtempSync + `git -C <dir>`), never against this
 * checkout's real `ops/author-identity-allowlist.json`. Two reasons, both load-bearing:
 *   1. A test that rewrites a shared artifact races any parallel reader in the same suite.
 *   2. Swapping the live allowlist would be a seam that can make the gate print PASS. The script
 *      deliberately has no allowlist-path override for exactly that reason; a temp repo gives the
 *      same coverage with none of the risk, because `git rev-parse --show-toplevel` relocates the
 *      lookup honestly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, copyFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve(__dirname, '..', '..', 'scripts', 'check-author-identity.sh');
const LIVE_ALLOWLIST = resolve(__dirname, '..', '..', 'ops', 'author-identity-allowlist.json');

const CANONICAL = '264139505+AlgoVaultFi@users.noreply.github.com';
const MEGATRON = '268183053+Megatron888-Robot@users.noreply.github.com';

interface Sandbox {
  dir: string;
  cleanup: () => void;
}

/** A throwaway repo carrying its own allowlist. `allowlist === null` omits the file entirely. */
function sandbox(allowlist: string | null): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'author-identity-'));
  execFileSync('git', ['-C', dir, 'init', '--initial-branch=main', '-q']);
  mkdirSync(join(dir, 'ops'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  copyFileSync(SCRIPT, join(dir, 'scripts', 'check-author-identity.sh'));
  chmodSync(join(dir, 'scripts', 'check-author-identity.sh'), 0o755);
  if (allowlist !== null) writeFileSync(join(dir, 'ops', 'author-identity-allowlist.json'), allowlist);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Run the gate inside `dir` as the given author. Returns the terminal token + the exit code. */
function runGate(dir: string, email: string, name = 'probe', env: Record<string, string> = {}) {
  const r = spawnSync('bash', [join(dir, 'scripts', 'check-author-identity.sh')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, ...env },
  });
  const lines = (r.stdout ?? '').trim().split('\n');
  return { token: lines[lines.length - 1] ?? '', code: r.status, stderr: r.stderr ?? '' };
}

const REPORT_MODE = JSON.stringify({
  allowed: [{ email: CANONICAL, name: 'AlgoVaultFi', class: 'canonical', reason: 'test fixture' }],
  denied: [{ email: 'test@test.local', reason: 'test fixture' }],
  promotion: { mode: 'report', max_violations: 0, not_before: '2026-08-16' },
});
const BLOCK_MODE = JSON.stringify({
  allowed: [{ email: CANONICAL, name: 'AlgoVaultFi', class: 'canonical', reason: 'test fixture' }],
  denied: [{ email: 'test@test.local', reason: 'test fixture' }],
  promotion: { mode: 'block', max_violations: 0, not_before: '2026-08-16' },
});

describe('check-author-identity.sh — self-test', () => {
  it('passes, and its terminal line is the verdict token', () => {
    const r = spawnSync('bash', [SCRIPT, '--self-test'], { encoding: 'utf8' });
    const lines = (r.stdout ?? '').trim().split('\n');
    expect(lines[lines.length - 1]).toBe('AUTHOR_IDENTITY_VERDICT=PASS');
    expect(r.status).toBe(0);
  });

  it('is not vacuous — it reports a positive assertion count', () => {
    const r = spawnSync('bash', [SCRIPT, '--self-test'], { encoding: 'utf8' });
    const m = (r.stdout ?? '').match(/SELF-TEST: (\d+) passed, (\d+) failed \((\d+) assertions\)/);
    expect(m).not.toBeNull();
    expect(Number(m![3])).toBeGreaterThan(0);
    expect(Number(m![2])).toBe(0);
  });
});

describe('check-author-identity.sh — verdict token for all three states', () => {
  let sb: Sandbox;
  afterEach(() => sb?.cleanup());

  it('PASS for an allowlisted author', () => {
    sb = sandbox(REPORT_MODE);
    expect(runGate(sb.dir, CANONICAL).token).toBe('AUTHOR_IDENTITY_VERDICT=PASS');
  });

  it('FAIL for an explicitly denied author', () => {
    sb = sandbox(REPORT_MODE);
    expect(runGate(sb.dir, 'test@test.local').token).toBe('AUTHOR_IDENTITY_VERDICT=FAIL');
  });

  it('FAIL for an unknown author — allowlist semantics, not deny-list', () => {
    sb = sandbox(REPORT_MODE);
    expect(runGate(sb.dir, 'someone@nowhere.example').token).toBe('AUTHOR_IDENTITY_VERDICT=FAIL');
  });

  it('INDETERMINATE for an EMPTY allowed[] — we author that file, so empty is our defect', () => {
    sb = sandbox(JSON.stringify({ allowed: [], denied: [], promotion: { mode: 'report' } }));
    const r = runGate(sb.dir, CANONICAL);
    expect(r.token).toBe('AUTHOR_IDENTITY_VERDICT=INDETERMINATE');
    expect(r.code).toBe(3);
  });

  it('INDETERMINATE for an unparseable allowlist', () => {
    sb = sandbox('not json at all {{{');
    const r = runGate(sb.dir, CANONICAL);
    expect(r.token).toBe('AUTHOR_IDENTITY_VERDICT=INDETERMINATE');
    expect(r.code).toBe(3);
  });

  it('INDETERMINATE for a missing allowlist', () => {
    sb = sandbox(null);
    const r = runGate(sb.dir, CANONICAL);
    expect(r.token).toBe('AUTHOR_IDENTITY_VERDICT=INDETERMINATE');
    expect(r.code).toBe(3);
  });
});

describe('check-author-identity.sh — token to exit-code mapping', () => {
  let sb: Sandbox;
  afterEach(() => sb?.cleanup());

  it('PASS maps to 0', () => {
    sb = sandbox(BLOCK_MODE);
    expect(runGate(sb.dir, CANONICAL).code).toBe(0);
  });

  it('FAIL maps to 1 in BLOCK mode', () => {
    sb = sandbox(BLOCK_MODE);
    const r = runGate(sb.dir, 'test@test.local');
    expect(r.token).toBe('AUTHOR_IDENTITY_VERDICT=FAIL');
    expect(r.code).toBe(1);
  });

  it('REPORT mode downgrades the CODE to 0 but never launders the TOKEN', () => {
    sb = sandbox(REPORT_MODE);
    const r = runGate(sb.dir, 'test@test.local');
    expect(r.token).toBe('AUTHOR_IDENTITY_VERDICT=FAIL');
    expect(r.code).toBe(0);
  });

  it('ALGOVAULT_AUTHOR_IDENTITY=warn downgrades the CODE only, in BLOCK mode', () => {
    sb = sandbox(BLOCK_MODE);
    const r = runGate(sb.dir, 'test@test.local', 'probe', { ALGOVAULT_AUTHOR_IDENTITY: 'warn' });
    expect(r.token).toBe('AUTHOR_IDENTITY_VERDICT=FAIL');
    expect(r.code).toBe(0);
  });

  it('no lever can make a denied author print PASS', () => {
    sb = sandbox(BLOCK_MODE);
    for (const env of [{ ALGOVAULT_AUTHOR_IDENTITY: 'warn' }, { ALGOVAULT_AUTHOR_IDENTITY: 'report' }, {}]) {
      expect(runGate(sb.dir, 'test@test.local', 'probe', env).token)
        .not.toBe('AUTHOR_IDENTITY_VERDICT=PASS');
    }
  });
});

describe('check-author-identity.sh — pure parser (the seam the gate body hides)', () => {
  /** Source the script and call one pure function, exactly as the self-test does. */
  function callPure(fn: string, arg: string): string {
    const r = spawnSync('bash', ['-c', `. "${SCRIPT}"; ${fn} "$1"`, '_', arg], { encoding: 'utf8' });
    return (r.stdout ?? '').trim();
  }

  it('extracts the email from a real GIT_AUTHOR_IDENT shape', () => {
    expect(callPure('author_identity_parse_email', 'AlgoVaultFi <a@b.com> 1786265766 +0800')).toBe('a@b.com');
  });

  it('handles a display name containing a space', () => {
    expect(callPure('author_identity_parse_email', 'AlgoVault Operator <x@y.z> 1700000000 -0500')).toBe('x@y.z');
    expect(callPure('author_identity_parse_name', 'AlgoVault Operator <x@y.z> 1700000000 -0500')).toBe('AlgoVault Operator');
  });

  it('anchors on the LAST "<" so a name containing "<" cannot smuggle a wrong email', () => {
    expect(callPure('author_identity_parse_email', 'Weird <Name <deep@mail.io> 1754700000 +0000')).toBe('deep@mail.io');
  });

  it('sourcing the script does NOT run the gate — no verdict token is emitted', () => {
    const r = spawnSync('bash', ['-c', `. "${SCRIPT}"; echo SOURCED_OK`], { encoding: 'utf8' });
    expect(r.stdout).toContain('SOURCED_OK');
    expect(r.stdout).not.toContain('AUTHOR_IDENTITY_VERDICT=');
  });
});

describe('ops/author-identity-allowlist.json — the shipped config', () => {
  it('is non-vacuous and judges every identity of record correctly', () => {
    const cfg = JSON.parse(
      execFileSync('cat', [LIVE_ALLOWLIST], { encoding: 'utf8' }),
    ) as {
      allowed: { email: string; reason: string }[];
      denied: { email: string; reason: string }[];
      exempt_repos: { path: string; reason: string }[];
      promotion: { mode: string; max_violations: number; not_before: string };
    };
    const allowed = cfg.allowed.map((a) => a.email);
    const denied = cfg.denied.map((d) => d.email);

    expect(allowed).toContain(CANONICAL);
    expect(allowed).toContain(MEGATRON);
    expect(denied).toContain('test@test.local');
    expect(denied).toContain('megatronwarlord1998@gmail.com');
    expect(denied).toContain('diophantus.hau@gmail.com');
    // The three denied addresses must never leak into `allowed`.
    for (const d of denied) expect(allowed).not.toContain(d);
  });

  it('carries a reason on EVERY row — an exemption living only in prose gets "fixed" later', () => {
    const cfg = JSON.parse(execFileSync('cat', [LIVE_ALLOWLIST], { encoding: 'utf8' }));
    for (const row of [...cfg.allowed, ...cfg.denied, ...cfg.exempt_repos]) {
      expect(typeof row.reason).toBe('string');
      expect(row.reason.length).toBeGreaterThan(20);
    }
  });

  it('ships REPORT-first with BOTH promotion criteria, never collapsed into one', () => {
    const cfg = JSON.parse(execFileSync('cat', [LIVE_ALLOWLIST], { encoding: 'utf8' }));
    expect(cfg.promotion.mode).toBe('report');
    expect(cfg.promotion.max_violations).toBe(0);
    expect(cfg.promotion.not_before).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof cfg.promotion.owner).toBe('string');
    expect(cfg.promotion.reason.length).toBeGreaterThan(20);
  });
});

/**
 * OPS-PROMOTION-INSTRUMENT-INDEPENDENCE-W1 CH2 R2.7 — the git-history instrument.
 *
 * Driven through the REAL script via spawnSync, per this file's existing strategy: what is asserted
 * is what ships, not a re-implementation. Every negative case runs in a throwaway repo.
 */
describe('check-author-identity.sh --measure-promotion — git-history instrument', () => {
  const OOS = 'ci@algovault.com';
  const UNLISTED = 'nobody@example.invalid';

  /** A throwaway repo with real commits, so `git log --all` has a population to bucket. */
  function commitRepo(opts: {
    allowlistExtra?: Record<string, unknown>;
    commits: Array<{ email: string; when: number }>;
    measureFrom: string;
    minCommits?: number;
  }) {
    const cfg = {
      allowed: [{ email: CANONICAL, name: 'AlgoVaultFi', class: 'canonical', reason: 'test fixture' }],
      denied: [{ email: 'test@test.local', reason: 'test fixture' }],
      out_of_scope_identities: [{ email: OOS, reason: 'test fixture — CI identity, hook not installed there' }],
      promotion: {
        mode: 'report',
        max_violations: 0,
        max_indeterminate_in_window: 0,
        not_before: '2026-08-16',
        measure_from: opts.measureFrom,
        min_commits_in_window: opts.minCommits ?? 1,
        owner: 'TEST',
        reason: 'test fixture reason, long enough to satisfy the row-reason assertions',
        ...(opts.allowlistExtra ?? {}),
      },
    };
    const box = sandbox(JSON.stringify(cfg));
    // A ledger is required — the INDETERMINATE bar reads it, and a MISSING ledger is not a clean one.
    const common = execFileSync('git', ['-C', box.dir, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim();
    const ledger = join(box.dir, common, 'algovault-author-identity.log');
    writeFileSync(ledger, `2000-01-01T00:00:00Z\tPASS\t${box.dir}\t${CANONICAL}\n`);
    for (const [i, c] of opts.commits.entries()) {
      const iso = new Date(c.when * 1000).toISOString();
      writeFileSync(join(box.dir, `f${i}.txt`), String(i));
      execFileSync('git', ['-C', box.dir, 'add', `f${i}.txt`]);
      execFileSync('git', ['-C', box.dir, 'commit', '-q', '--no-verify', '-m', `c${i}`], {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'probe', GIT_AUTHOR_EMAIL: c.email, GIT_AUTHOR_DATE: iso,
          GIT_COMMITTER_NAME: 'probe', GIT_COMMITTER_EMAIL: c.email, GIT_COMMITTER_DATE: iso,
        },
      });
    }
    return box;
  }

  function measure(dir: string) {
    const r = spawnSync('bash', [join(dir, 'scripts', 'check-author-identity.sh'), '--measure-promotion'], {
      cwd: dir, encoding: 'utf8',
    });
    const all = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    const num = (k: string) => {
      const m = all.match(new RegExp(`^\\s*${k}\\s*:\\s*(\\d+)`, 'm'));
      return m ? Number(m[1]) : null;
    };
    return {
      code: r.status,
      token: (all.match(/^PROMOTION_MEASURE_VERDICT=(\w+)$/m) ?? [])[1],
      all,
      counts: {
        total: num('commits_total_all_refs'),
        before: num('commits_before_measure_from'),
        inWindow: num('commits_in_window'),
        oos: num('in_window_out_of_scope'),
        inScope: num('in_window_in_scope'),
        refused: num('in_window_would_be_refused'),
      },
    };
  }

  const T0 = Math.floor(Date.parse('2026-08-09T11:07:26Z') / 1000);

  it('AC2.3 — prints all six counts, with out-of-scope broken down per identity', () => {
    const box = commitRepo({
      measureFrom: '2026-08-09T11:07:26Z',
      commits: [
        { email: CANONICAL, when: T0 - 3600 },
        { email: CANONICAL, when: T0 + 60 },
        { email: OOS, when: T0 + 120 },
      ],
    });
    try {
      const m = measure(box.dir);
      expect(m.counts.total).toBe(3);
      expect(m.counts.before).toBe(1);
      expect(m.counts.inWindow).toBe(2);
      expect(m.counts.oos).toBe(1);
      expect(m.counts.inScope).toBe(1);
      expect(m.counts.refused).toBe(0);
      // per-identity breakdown, and the DECLARED exclusion is named even at its own count
      expect(m.all).toMatch(new RegExp(`${OOS}\\s+1`));
    } finally { box.cleanup(); }
  });

  it('AC2.5 — an identity in NEITHER allowed[] nor out_of_scope_identities[] counts as a violation', () => {
    const box = commitRepo({
      measureFrom: '2026-08-09T11:07:26Z',
      commits: [
        { email: CANONICAL, when: T0 + 60 },
        { email: UNLISTED, when: T0 + 120 },
      ],
    });
    try {
      const m = measure(box.dir);
      expect(m.counts.refused).toBe(1);
      expect(m.counts.inScope).toBe(2); // the violator is IN the denominator, only the OOS set is removed
      expect(m.all).toContain(UNLISTED);
      expect(m.token).toBe('BLOCKED');
      expect(m.code).toBe(1);
    } finally { box.cleanup(); }
  });

  it('the out-of-scope set is subtracted from BOTH numerator and denominator', () => {
    const box = commitRepo({
      measureFrom: '2026-08-09T11:07:26Z',
      commits: [{ email: CANONICAL, when: T0 + 60 }, { email: OOS, when: T0 + 120 }],
    });
    try {
      const m = measure(box.dir);
      expect(m.counts.inWindow).toBe(2);
      expect(m.counts.inScope).toBe(1);
      expect(m.counts.refused).toBe(0); // NOT 1 — an out-of-scope identity is never a violation
    } finally { box.cleanup(); }
  });

  it('AC2.6 — a below-floor window is INDETERMINATE with exit 3, never READY and never BLOCKED', () => {
    const box = commitRepo({
      measureFrom: '2026-08-09T11:07:26Z',
      minCommits: 30,
      commits: [{ email: CANONICAL, when: T0 + 60 }],
    });
    try {
      const m = measure(box.dir);
      expect(m.counts.inScope).toBe(1);
      expect(m.token).toBe('INDETERMINATE');
      expect(m.code).toBe(3);
    } finally { box.cleanup(); }
  });

  it('buckets on EPOCH, not on an ISO string — a +08:00 commit before the bound stays before it', () => {
    // The regression this guards: `2026-08-09T18:51:09+08:00` is 10:51:09Z, EARLIER than an
    // 11:07:26Z bound, but it string-sorts AFTER it. On the live repo that artifact turned 0
    // violations into 21 and READY into BLOCKED.
    const box = commitRepo({
      measureFrom: '2026-08-09T11:07:26Z',
      commits: [
        { email: 'test@test.local', when: T0 - 970 }, // 10:51:16Z — renders +08:00 as 18:51
        { email: CANONICAL, when: T0 + 60 },
      ],
    });
    try {
      execFileSync('git', ['-C', box.dir, 'config', 'log.date', 'iso-strict']);
      const m = measure(box.dir);
      expect(m.counts.before).toBe(1);   // the denied commit is OUT of the window
      expect(m.counts.refused).toBe(0);  // ...so it is NOT a violation
      expect(m.token).toBe('READY');
    } finally { box.cleanup(); }
  });

  it('AC2.2 — the FAIL count is not read from the ledger: a ledger full of FAILs stays READY', () => {
    const box = commitRepo({
      measureFrom: '2026-08-09T11:07:26Z',
      commits: [{ email: CANONICAL, when: T0 + 60 }],
    });
    try {
      const common = execFileSync('git', ['-C', box.dir, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim();
      const ledger = join(box.dir, common, 'algovault-author-identity.log');
      writeFileSync(ledger, Array.from({ length: 25 }, () =>
        `2026-08-16T04:42:06Z\tFAIL\t${box.dir}\ttest@test.local`).join('\n') + '\n');
      const m = measure(box.dir);
      expect(m.counts.refused).toBe(0);
      expect(m.token).toBe('READY'); // 25 ledger FAILs, and the verdict is unmoved
    } finally { box.cleanup(); }
  });

  it('R2.5 — the INDETERMINATE bar IS read from the ledger, the one thing git cannot see', () => {
    const box = commitRepo({
      measureFrom: '2026-08-09T11:07:26Z',
      commits: [{ email: CANONICAL, when: T0 + 60 }],
    });
    try {
      const common = execFileSync('git', ['-C', box.dir, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim();
      writeFileSync(join(box.dir, common, 'algovault-author-identity.log'),
        `2026-08-16T04:42:06Z\tINDETERMINATE\t${box.dir}\t?\n`);
      const m = measure(box.dir);
      expect(m.counts.refused).toBe(0);   // git history is still clean
      expect(m.token).toBe('BLOCKED');    // ...and the ledger-side bar still blocks
    } finally { box.cleanup(); }
  });

  it('AC2.4 — a manual gate run writes a ledger row and moves NO git-history count', () => {
    const box = commitRepo({
      measureFrom: '2026-08-09T11:07:26Z',
      commits: [{ email: CANONICAL, when: T0 + 60 }],
    });
    try {
      const before = measure(box.dir).counts;
      // The exact act that poisoned the old instrument: a deliberate run by a DENIED identity.
      const g = runGate(box.dir, 'test@test.local');
      expect(g.token).toBe('AUTHOR_IDENTITY_VERDICT=FAIL');
      const after = measure(box.dir).counts;
      expect(after).toEqual(before); // manufacturing a FAIL cannot enter the population
    } finally { box.cleanup(); }
  });

  it('AC2.11 — the flag returns before the gate body: it never evaluates an identity', () => {
    const box = commitRepo({
      measureFrom: '2026-08-09T11:07:26Z',
      commits: [{ email: CANONICAL, when: T0 + 60 }],
    });
    try {
      const r = spawnSync('bash', [join(box.dir, 'scripts', 'check-author-identity.sh'), '--measure-promotion'], {
        cwd: box.dir, encoding: 'utf8',
        // A denied author would make the GATE body print FAIL. The flag must never reach it.
        env: { ...process.env, GIT_AUTHOR_NAME: 'probe', GIT_AUTHOR_EMAIL: 'test@test.local' },
      });
      const all = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
      expect(all).not.toContain('AUTHOR_IDENTITY_VERDICT');
      expect(all).toMatch(/^PROMOTION_MEASURE_VERDICT=/m);
    } finally { box.cleanup(); }
  });
});

describe('author-identity config — CH2 shape', () => {
  const cfg = () => JSON.parse(execFileSync('cat', [LIVE_ALLOWLIST], { encoding: 'utf8' }));

  it('AC2.9 — the instrument is grade A with no rederive left behind', () => {
    const i = cfg().promotion.instrument;
    expect(i.grade).toBe('A');
    expect(i.rederive).toBeUndefined();
    expect(i.reobserve).toBeUndefined();
    expect(i.written_by).toMatch(/git/i);
  });

  it('AC2.10 — promotion.mode is still report; the flip is W2', () => {
    expect(cfg().promotion.mode).toBe('report');
    expect(cfg().promotion.owner).toBe('OPS-AUTHOR-IDENTITY-PROMOTE-W2');
  });

  it('AC2.8 — the boundary law is present and measure_from is the remediation SHA instant', () => {
    const p = cfg().promotion;
    expect(p._window_boundary_law.length).toBeGreaterThan(200);
    expect(p._window_boundary_law).toContain('can the boundary be defined without reference to the row you want excluded?');
    expect(p.measure_from).toBe('2026-08-09T11:07:26Z');
    expect(p._measure_from_reason).toContain('24419af');
  });

  it('R2.2 — the rename completed: min_commits_in_window present, min_rows_in_window ABSENT', () => {
    const p = cfg().promotion;
    expect(p.min_commits_in_window).toBe(30);
    expect(p.min_rows_in_window).toBeUndefined();
  });

  it('AC2.7 — max_indeterminate_in_window exists and is declared SECONDARY in instrument.reason', () => {
    const p = cfg().promotion;
    expect(p.max_indeterminate_in_window).toBe(0);
    expect(p.instrument.reason.toUpperCase()).toContain('SECONDARY');
  });

  it('R2.3 — five out-of-scope identities, each with its own reason, and no personal address among them', () => {
    const rows = cfg().out_of_scope_identities;
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const r of rows) {
      expect(typeof r.email).toBe('string');
      expect(r.reason.length).toBeGreaterThan(20);
      // Out-of-scope means "the hook was never installed where this ran". A personal mailbox is a
      // violation by definition, never an exemption.
      expect(r.email).not.toMatch(/gmail\.com$/);
    }
    const emails = rows.map((r: { email: string }) => r.email);
    for (const e of ['ci@algovault.com', 'github-actions@github.com', 'funnel-snapshot@algovault.com',
                     'algovault@hetzner.local', 'editorial@algovault.com']) {
      expect(emails).toContain(e);
    }
    // Q4: deliberately NOT exempted — both were authored on THIS machine.
    expect(emails).not.toContain('admin@algovault.com');
  });
});
