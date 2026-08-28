/**
 * EDGE-SELL-RESOLUTION-ENFORCE-W1 CH1 — the book-liveness canary's token grammar, exit-code
 * contract and closed-vs-broken discriminator, pinned CROSS-LANGUAGE.
 *
 * `ops/monitoring/book-liveness-canary.py` is a Python canary whose callers are shell: the cron
 * line, and any gate block that greps its verdict. Nothing in the TypeScript tree can import it,
 * so the only honest way to pin its contract is to RUN it and read what it emits.
 *
 * Why this file exists at all, given the canary now has a 33-check `--self-test`: a hermetic
 * self-test is structurally blind to exactly what its own seam replaces. It asserts
 * `_token_exit_map()` as DATA; it never proves `main()` ACTUALLY returns those codes, nor that
 * the token reaches stdout exactly once on every path. Those are the two facts every caller
 * depends on, and they are the ones a refactor silently breaks. Structure and rationale copied
 * from `tests/unit/client-claim-freshness.test.ts`, the sibling that established this shape.
 *
 * The regression it exists to prevent is concrete and was live until this wave: every path in
 * this canary used to `exit 0` with no token at all, so a failed `psql` printed
 * "OK - 0 venue-metrics within ceilings" — a dark guard indistinguishable from a healthy one.
 *
 * SPAWN BUDGET DECLARED — every block here shells out to `python3`, and
 * `scripts/check-test-budget.mjs` blocks a spawning block that declares none. The budget sits in
 * the OPTIONS ARG, never as a trailing number: the gate reads `timeout:` from the text BEFORE
 * the callback, so `it(name, fn, 20_000)` declares nothing.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(__dirname, '../..');
const PY = path.join(REPO, 'ops/monitoring/book-liveness-canary.py');
const SRC = readFileSync(PY, 'utf8');

const TOKEN = 'BOOK_LIVENESS_VERDICT';

/** Every line that IS a terminal verdict token — anchored at column 0, nothing before it. */
function tokenLines(stdout: string): string[] {
  return stdout.split('\n').filter((l) => l.startsWith(`${TOKEN}=`));
}

/**
 * Drive the SHIPPED `main()` with its three effects stubbed — the DB, the container-env probe
 * and the Telegram dispatch. This is the point of the file: the self-test never calls `main()`,
 * so the token print and the exit-code mapping are only ever exercised here.
 *
 * `psqlPy` supplies the query results; queries are answered by matching on a distinctive
 * fragment of each builder's output, so a builder that stops emitting its scoping clause
 * changes which branch is exercised rather than passing silently.
 */
function runMain(mode: string, psqlPy: string) {
  const code = [
    'import importlib.util, sys',
    `spec = importlib.util.spec_from_file_location("c", ${JSON.stringify(PY)})`,
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    `m.probe_mode = lambda: ${JSON.stringify(mode)}`,
    'm.fire = lambda body: None',
    psqlPy,
    'sys.exit(m.main())',
  ].join('\n');
  return spawnSync('python3', ['-c', code], { encoding: 'utf8', env: { ...process.env } });
}

/** A `psql` stub: routes by builder fragment, returns `-tA -F'|'` shaped text. */
function psqlStub(frozen: string, persistence: string, floor: string): string {
  return [
    'def _q(sql):',
    '    if "n_frozen" in sql:',
    `        return ${JSON.stringify(frozen)}`,
    '    if "window_days_seen" in sql:',
    `        return ${JSON.stringify(persistence)}`,
    `    return ${JSON.stringify(floor)}`,
    'm.psql = _q',
  ].join('\n');
}

/** A clean fleet: one healthy venue over MIN_DENOM, a young counter, no suppressions. */
const CLEAN = psqlStub('BINANCE|500|0', '', '');

describe('book-liveness-canary — verdict token grammar', () => {
  it('the --self-test emits EXACTLY ONE token line and exits 0', { timeout: 60_000 }, () => {
    const r = spawnSync('python3', [PY, '--self-test'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=PASS`]);
    expect(r.stdout).toMatch(/^SELF-TEST: PASS \(\d+ checks\)$/m);
  });

  it('the token vocabulary is exactly three values, read from the SHIPPED map',
    { timeout: 20_000 }, () => {
      const r = spawnSync('python3', ['-c', [
        'import importlib.util, json',
        `spec = importlib.util.spec_from_file_location("c", ${JSON.stringify(PY)})`,
        'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
        'print(json.dumps(m._token_exit_map()))',
      ].join('\n')], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout.trim())).toEqual({ PASS: 0, FAIL: 0, INDETERMINATE: 3 });
    });
});

describe('book-liveness-canary — exit-code contract, through the real main()', () => {
  it('PASS exits 0 and prints one token', { timeout: 30_000 }, () => {
    const r = runMain('shadow', CLEAN);
    expect(r.status, r.stderr).toBe(0);
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=PASS`]);
  });

  it('FAIL exits 0 — the alert IS the action, so a breach must not bounce the cron line',
    { timeout: 30_000 }, () => {
      // 40 frozen of 500 = 8.00%, over XT's 6.0 shadow ceiling.
      const r = runMain('shadow', psqlStub('XT|500|40', '', ''));
      expect(r.status, r.stderr).toBe(0);
      expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=FAIL`]);
      expect(r.stdout).toMatch(/BREACH frozen XT: 8\.00%/);
    });

  it('an unreadable DB is INDETERMINATE/3 — verified NOTHING never reads as clean',
    { timeout: 30_000 }, () => {
      const r = runMain('shadow', [
        'def _q(sql): raise m.QueryError("connection refused")',
        'm.psql = _q',
      ].join('\n'));
      expect(r.status, r.stderr).toBe(3);
      expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=INDETERMINATE`]);
    });

  it('an unreadable container env is INDETERMINATE/3, never a defaulted mode',
    { timeout: 30_000 }, () => {
      const code = [
        'import importlib.util, sys',
        `spec = importlib.util.spec_from_file_location("c", ${JSON.stringify(PY)})`,
        'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
        'def _p(): raise m.QueryError("cannot read env")',
        'm.probe_mode = _p',
        'm.fire = lambda body: None',
        'sys.exit(m.main())',
      ].join('\n');
      const r = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(3);
      expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=INDETERMINATE`]);
    });

  it('mode=off PASSes positively — there is no gate to be right or wrong about',
    { timeout: 30_000 }, () => {
      const r = runMain('off', CLEAN);
      expect(r.status, r.stderr).toBe(0);
      expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=PASS`]);
      expect(r.stdout).toMatch(/gate mode=off/);
    });
});

describe('book-liveness-canary — mode-awareness', () => {
  it('shadow and enforce read DIFFERENT ceiling tables on identical input',
    { timeout: 40_000 }, () => {
      // 15 frozen of 500 = 3.00%: under XT's 6.0 shadow ceiling, over the 1.0 enforce ratchet.
      const rows = psqlStub('XT|500|15', '', '');
      const shadow = runMain('shadow', rows);
      const enforce = runMain('enforce', rows);
      expect(tokenLines(shadow.stdout)).toEqual([`${TOKEN}=PASS`]);
      expect(tokenLines(enforce.stdout)).toEqual([`${TOKEN}=FAIL`]);
    });

  it('each mode scopes the suppression rows to ITS OWN reason', { timeout: 30_000 }, () => {
    const r = spawnSync('python3', ['-c', [
      'import importlib.util',
      `spec = importlib.util.spec_from_file_location("c", ${JSON.stringify(PY)})`,
      'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
      'print(m.reason_for("enforce"))',
      'print(m.reason_for("shadow"))',
      'print("YES" if "frozen_book_shadow" in m.build_persistence_sql(28, "frozen_book_shadow")',
      '      else "NO")',
    ].join('\n')], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim().split('\n')).toEqual(['frozen_book', 'frozen_book_shadow', 'YES']);
  });
});

describe('book-liveness-canary — closed-vs-broken discriminator', () => {
  it('a dead book breaches; a closed market on the SAME run does not', { timeout: 30_000 }, () => {
    // cols: exchange|coin|days|tfs|n|window_days_seen — a full 28-day window.
    const rows = ['XT|EPT|28|3|140|28', 'ASTER|SPY|9|2|9|28'].join('\n');
    const r = runMain('enforce', psqlStub('BINANCE|500|0', rows, 'XT|10'));
    expect(r.status, r.stderr).toBe(0);
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=FAIL`]);
    expect(r.stdout).toMatch(/BREACH dead book XT\|EPT/);
    expect(r.stdout).not.toMatch(/ASTER\|SPY/);
  });

  it('a young counter reports INSUFFICIENT_WINDOW and never a verdict', { timeout: 30_000 }, () => {
    // The same dead book, but the counter has only seen 4 of 28 days.
    const rows = 'XT|EPT|4|3|15|4';
    const r = runMain('shadow', psqlStub('BINANCE|500|0', rows, 'XT|10'));
    expect(r.status, r.stderr).toBe(0);
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=PASS`]);
    expect(r.stdout).toMatch(/INSUFFICIENT_WINDOW - counter has 4 of 28 distinct days/);
  });
});

describe('book-liveness-canary — reporting is positive, never absence-of-alert', () => {
  it('a below-MIN_DENOM venue is reported as SKIPPED, not silently dropped',
    { timeout: 30_000 }, () => {
      const r = runMain('shadow', psqlStub('BITMART|3|3\nBINANCE|500|0', '', ''));
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/frozen BITMART: SKIPPED, n_eval=3 < MIN_DENOM=200/);
      expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=PASS`]);
    });

  it('the volume floor prints its observed maximum while REPORT-ONLY', { timeout: 30_000 }, () => {
    const r = runMain('shadow', psqlStub('BINANCE|500|0', '', 'ASTER|10\nXT|10'));
    expect(r.stdout).toMatch(/floor: REPORT-ONLY .* ASTER=10, XT=10/);
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=PASS`]);
  });
});

describe('book-liveness-canary — source-level invariants', () => {
  it('the retired suppression RATE ceiling is not silently reintroduced', () => {
    // It divided an emit_suppressions numerator by a deduped `signals` denominator — two
    // different populations. If a future wave wants it back, it needs a real denominator first.
    expect(SRC).not.toMatch(/SUPPRESSION_CEILING_PCT\s*=/);
    expect(SRC).toMatch(/WHY_THE_RATE_WAS_RETIRED/);
  });

  it('recommended_wave stays in TEMPLATE form — a literal W<n> is HALT-class', () => {
    expect(SRC).toMatch(/recommended_wave: OPS-BOOK-LIVENESS-W\{NEXT\}/);
    expect(SRC).not.toMatch(/recommended_wave: OPS-[A-Z-]+-W\d/);
  });

  it('every defensive constant carries a revisit date', () => {
    const todos = SRC.match(/TODO: revisit by (\d{4}-\d{2}-\d{2})/g) ?? [];
    expect(todos.length).toBeGreaterThanOrEqual(2);
  });

  it('the canary does not re-implement any send_telegram gate inline', () => {
    for (const gate of ['DRY_RUN_TG', 'cooldown', 'ALGOVAULT_TG_TEST_INERT']) {
      expect(SRC.includes(`${gate} =`), `${gate} must stay in send_telegram.sh`).toBe(false);
    }
  });
});
