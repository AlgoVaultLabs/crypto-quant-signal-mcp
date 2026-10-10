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
const STUBS = [
  // The four wrapper seams and the result recorder — every effect main() has, captured instead of
  // performed, and printed so a test can assert WHICH alert id heard WHAT on this run.
  'import json',
  'calls = []',
  'm.fire_ceiling = lambda body: calls.append(["fire_ceiling"])',
  'm.clear_ceiling = lambda: calls.append(["clear_ceiling"])',
  'm.fire_dead_book = lambda body, keys: calls.append(["fire_dead_book", keys])',
  'm.clear_dead_book = lambda: calls.append(["clear_dead_book"])',
  'results = []',
  'm._append_result = lambda *a, **k: (results.append(list(a)) or (True, "line=0"))',
  // OPS-ALARM-OWNER-DERIVATION-W1 CH2: the admission-verdict seam (a `docker exec` into the app
  // container). Recorded, and by DEFAULT failing — no app container exists here — which is exactly the
  // "script failure ⇒ every key STATUS_UNKNOWN, paged" path. A test that needs classes overrides it.
  'adm = []',
  'def _adm(keys):',
  '    adm.append(list(keys))',
  '    raise m.AdmissionError("stubbed: no app container in the test")',
  'm.admission_verdicts = _adm',
];
const REPORT = [
  'print("CALLS=" + json.dumps(calls))',
  'print("RESULT=" + json.dumps(results[-1] if results else None))',
  'print("ADM=" + json.dumps(adm))',
];

/** Override the admission seam: every requested key gets the class named here. */
function admissionClasses(classes: Record<string, string>): string {
  return [
    `_cls = ${JSON.stringify(classes)}`,
    'def _adm_ok(keys):',
    '    adm.append(list(keys))',
    '    return {k: {"key": k, "class": _cls[k], "symbol": None, "status_state": "ok", "venue_last_trade": None,',
    '                "traded_bars_24h": 0, "contradiction_check": "outside_window", "reason": "stub"} for k in keys}',
    'm.admission_verdicts = _adm_ok',
  ].join('\n');
}

/** The harness's own report lines — never part of the canary's output contract. */
function calls(stdout: string): unknown[] {
  return JSON.parse(stdout.match(/^CALLS=(.*)$/m)?.[1] ?? 'null');
}
function result(stdout: string): [string, string, number, Record<string, unknown>] {
  return JSON.parse(stdout.match(/^RESULT=(.*)$/m)?.[1] ?? 'null');
}
function admCalls(stdout: string): string[][] {
  return JSON.parse(stdout.match(/^ADM=(.*)$/m)?.[1] ?? 'null');
}

function runMain(mode: string, psqlPy: string, admissionPy = '') {
  const code = [
    'import importlib.util, sys',
    `spec = importlib.util.spec_from_file_location("c", ${JSON.stringify(PY)})`,
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    `m.probe_mode = lambda: ${JSON.stringify(mode)}`,
    ...STUBS,
    admissionPy,
    psqlPy,
    'rc = m.main()',
    ...REPORT,
    'sys.exit(rc)',
  ].join('\n');
  return spawnSync('python3', ['-c', code], { encoding: 'utf8', env: { ...process.env } });
}

/**
 * A `psql` stub: routes by builder fragment, returns `-tA -F'|'` shaped text.
 *
 * `counterAge` is routed SEPARATELY from the persistence rows on purpose — the two answer
 * different questions ("how old is the counter" vs "which days carry a suppression"), and the
 * state that distinguishes them is the one this canary is built to reach: a mature counter with
 * zero suppressions, i.e. a fully enforcing gate.
 */
function psqlStub(
  frozen: string, persistence: string, floor: string,
  counterAge = '4|2026-08-25', shadowAge = '99999',
): string {
  return [
    'def _q(sql):',
    '    if "n_frozen" in sql:',
    `        return ${JSON.stringify(frozen)}`,
    '    if "window_days_seen" in sql:',
    `        return ${JSON.stringify(persistence)}`,
    // Both remaining builders mention MAX(date); route on what is UNIQUE to each, or a
    // reordering of the two would silently swap which answer each query receives.
    '    if "99999" in sql:',
    `        return ${JSON.stringify(shadowAge)}`,
    '    if "MIN(date)" in sql:',
    `        return ${JSON.stringify(counterAge)}`,
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
      // verified NOTHING, so neither alert id hears anything — and the run is still RECORDED.
      expect(calls(r.stdout)).toEqual([]);
      expect(result(r.stdout)[1]).toBe('INDETERMINATE');
    });

  it('an unreadable container env is INDETERMINATE/3, never a defaulted mode',
    { timeout: 30_000 }, () => {
      const code = [
        'import importlib.util, sys',
        `spec = importlib.util.spec_from_file_location("c", ${JSON.stringify(PY)})`,
        'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
        'def _p(): raise m.QueryError("cannot read env")',
        'm.probe_mode = _p',
        ...STUBS,
        'rc = m.main()',
        ...REPORT,
        'sys.exit(rc)',
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
      const rows = psqlStub('XT|500|15', '', '', '4|2026-08-25', '3');   // shadow tail already aged out
      const shadow = runMain('shadow', rows);
      const enforce = runMain('enforce', rows);
      expect(tokenLines(shadow.stdout)).toEqual([`${TOKEN}=PASS`]);
      expect(tokenLines(enforce.stdout)).toEqual([`${TOKEN}=FAIL`]);
    });

  it('the stage reason is still DERIVED, but ONLY the stage query uses it — the detector '
    + 'window is reason-INDEPENDENT so a flip cannot restart it', { timeout: 30_000 }, () => {
      // MEASURED 2026-08-29: the shadow->enforce flip changed reason_for(mode), the window
      // queries were scoped by it, and the dead-book detector silently reset to zero — counter
      // age 5d -> 1d, and 3 of 5 KNOWN dead books dropped to zero recorded days. A window keyed
      // on a mutable reason restarts itself every time the reason changes.
      const r = spawnSync('python3', ['-c', [
        'import importlib.util',
        `spec = importlib.util.spec_from_file_location("c", ${JSON.stringify(PY)})`,
        'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
        'print(m.reason_for("enforce"))',
        'print(m.reason_for("shadow"))',
        // the stage query SHOULD be stage-scoped — that is its actual subject
        'print("STAGE_SCOPED" if "frozen_book_shadow" in m.build_shadow_recency_sql() else "NO")',
        // the three WINDOW queries must mention no reason at all
        'w = [m.build_persistence_sql(28), m.build_counter_age_sql(), m.build_floor_sql(28)]',
        'print("WINDOW_REASON_FREE" if not any("reason" in q for q in w) else "LEAKED")',
      ].join('\n')], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim().split('\n')).toEqual([
        'frozen_book', 'frozen_book_shadow', 'STAGE_SCOPED', 'WINDOW_REASON_FREE',
      ]);
    });
});

describe('book-liveness-canary — closed-vs-broken discriminator', () => {
  it('a dead book breaches; a closed market on the SAME run does not', { timeout: 30_000 }, () => {
    // cols: exchange|coin|days|tfs|n|window_days_seen — a full 28-day window.
    const rows = ['XT|EPT|28|3|140|28', 'ASTER|SPY|9|2|9|28'].join('\n');
    const r = runMain('enforce', psqlStub('BINANCE|500|0', rows, 'XT|10', '28|2026-08-01'));
    expect(r.status, r.stderr).toBe(0);
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=FAIL`]);
    expect(r.stdout).toMatch(/BREACH dead book XT\|EPT/);
    expect(r.stdout).not.toMatch(/ASTER\|SPY/);
  });

  it('a young counter reports INSUFFICIENT_WINDOW and never a verdict', { timeout: 30_000 }, () => {
    // The same dead book, but the counter has only seen 4 of 28 days.
    const rows = 'XT|EPT|4|3|15|4';
    const r = runMain('shadow', psqlStub('BINANCE|500|0', rows, 'XT|10', '4|2026-08-25'));
    expect(r.status, r.stderr).toBe(0);
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=PASS`]);
    expect(r.stdout).toMatch(/INSUFFICIENT_WINDOW - the counter is 4 day\(s\) old, needs 28; full coverage on 2026-09-21/);
      expect(r.stdout).toMatch(/NO dead-book detection until then/);
  });
});

describe('book-liveness-canary — the shadow→enforce cutover must not page on itself', () => {
  // MEASURED at the real flip, 2026-08-29T03:25:45Z: the enforce table breached HTX 2.36% and
  // XT 2.85% within seconds, and ALL 21 offending rows were emitted BEFORE the flip (post-flip
  // count 0 on every venue). The mode flips in an instant; the LOOKBACK_DAYS window does not.
  it('a fresh shadow tail defers the ratchet and says so', { timeout: 30_000 }, () => {
    // 15 frozen of 500 = 3.00% — over the 1.0 enforce ratchet, under XT's 6.0 shadow ceiling.
    const r = runMain('enforce', psqlStub('XT|500|15', '', '', '28|2026-08-01', '0'));
    expect(r.status, r.stderr).toBe(0);
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=PASS`]);
    expect(r.stdout).toMatch(/frozen ceilings=shadow \(MIXED_WINDOW\)/);
    expect(r.stdout).toMatch(/MIXED_WINDOW - shadow last wrote 0d ago, lookback is 3d/);
  });

  it('once the window is entirely post-transition the ratchet BITES', { timeout: 30_000 }, () => {
    const r = runMain('enforce', psqlStub('XT|500|15', '', '', '28|2026-08-01', '3'));
    expect(r.status, r.stderr).toBe(0);
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=FAIL`]);
    expect(r.stdout).toMatch(/BREACH frozen XT: 3\.00%.*ceiling 1\.0%/);
  });
});

describe('book-liveness-canary — the target state', () => {
  it('a MATURE counter with ZERO suppressions is a reported PASS, not an unknown',
    { timeout: 30_000 }, () => {
      // The state a fully enforcing gate reaches. Keying evaluability on "days carrying a
      // suppression" instead of counter AGE would make the canary call its own success
      // INSUFFICIENT_WINDOW forever.
      const r = runMain('enforce', psqlStub('BINANCE|500|0', '', '', '28|2026-08-01'));
      expect(r.status, r.stderr).toBe(0);
      expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=PASS`]);
      expect(r.stdout).toMatch(/persistence: 0 suppressions in the last 28 days over a full 28-day counter - no dead books/);
      expect(r.stdout).not.toMatch(/INSUFFICIENT_WINDOW/);
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

  it('the PROMOTED floor prints every venue against its pin, and a pinless venue is report-only',
    { timeout: 30_000 }, () => {
      const r = runMain('shadow', psqlStub('BINANCE|500|0', '', 'ASTER|10|2026-09-14\nBINANCE|5'));
      expect(r.stdout).toMatch(/floor: PROMOTED — pins = 3 x the per-venue maximum measured 2026-09-30/);
      expect(r.stdout).toMatch(/floor ASTER: 10 on 2026-09-14 within pin 3180/);
      expect(r.stdout).toMatch(/floor BINANCE: 5 suppressions — no pin .* report-only/);
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

  it('ONE alert id, ONE remedy — two TEMPLATED, DISTINCT recommended waves', () => {
    expect(SRC).toMatch(/^WAVE_CEILING = "OPS-BOOK-LIVENESS-W\{NEXT\}"$/m);
    expect(SRC).toMatch(/^WAVE_DEAD_BOOK = "OPS-UNIVERSE-ADMISSION-W\{NEXT\}"$/m);
    // a literal wave number in a remedy is HALT-class (historical wave ids in comments are provenance)
    expect(SRC).not.toMatch(/^WAVE_[A-Z_]+ = "OPS-[A-Z0-9-]+-W\d/m);
    expect(SRC).not.toMatch(/recommended_wave: OPS-[A-Z-]+-W\d/);
  });

  it('both alert ids keep LITERAL call sites, so the registry gate can enumerate them', () => {
    expect(SRC).toContain('[TG, "book_liveness_ceiling", "CRITICAL_PERSISTENT", "-"]');
    expect(SRC).toContain('[TG, "book_liveness_dead_book", "CRITICAL_PERSISTENT", "-"]');
    expect(SRC).toContain('[TG, "--clear", "book_liveness_ceiling"]');
    expect(SRC).toContain('[TG, "--clear", "book_liveness_dead_book"]');
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

describe('book-liveness-canary — ONE window, ONE remedy per alert id (OPS-ALARM-SINGLE-DERIVATION-W1 CH4)', () => {
  // cols: exchange|coin|days|tfs|n|window_days_seen
  it('"29 of the last 28" cannot be produced — a builder regression is INDETERMINATE instrument_defect',
    { timeout: 30_000 }, () => {
      const r = runMain('enforce', psqlStub('BINANCE|500|0', 'XT|EPT|29|3|140|29', 'XT|10', '36|2026-08-25'));
      expect(r.status, r.stderr).toBe(3);
      expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=INDETERMINATE`]);
      expect(r.stderr).toMatch(/instrument_defect: 29 of 28/);
      expect(r.stdout).not.toMatch(/suppressed on 29 of 28/);   // never reported as a fact about a book
      expect(result(r.stdout)[3].reason).toMatch(/^instrument_defect: 29 of 28 window dates/);
      expect(calls(r.stdout)).toEqual([]);          // never paged, never cleared
    });

  it('a dead set fires the DEAD-BOOK id with ENTITY keys; the LEVEL id, unbreached, is cleared',
    { timeout: 30_000 }, () => {
      const rows = ['XT|EPT|28|3|140|28', 'HTX|LRDS|28|5|100|28', 'ASTER|SPY|9|2|9|28'].join('\n');
      const r = runMain('enforce', psqlStub('BINANCE|500|0', rows, 'ASTER|10', '36|2026-08-25'));
      expect(r.status, r.stderr).toBe(0);
      expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=FAIL`]);
      expect(calls(r.stdout)).toEqual([
        ['clear_ceiling'],
        ['fire_dead_book', ['dead:XT|EPT', 'dead:HTX|LRDS']],
      ]);
      expect(r.stdout).toMatch(/dead:XT\|EPT — suppressed on 28 of 28 days across 3 timeframe\(s\)/);
      expect(r.stdout).toMatch(/recommended_wave: OPS-UNIVERSE-ADMISSION-W\{NEXT\}/);
      expect(r.stdout).toMatch(/Runbook: https:\/\/github\.com\/AlgoVaultLabs\/crypto-quant-signal-mcp\/blob\/main\/docs\/RUNBOOK-BOOK-LIVENESS-FLIP\.md/);
    });

  it('the result line carries the dead-set KEYS and the window dates', { timeout: 30_000 }, () => {
    const rows = ['XT|EPT|28|3|140|28', 'HTX|LRDS|28|5|100|28'].join('\n');
    const r = runMain('enforce', psqlStub('BINANCE|500|0', rows, 'ASTER|10', '36|2026-08-25'));
    const [canary, verdict, code, metrics] = result(r.stdout);
    expect([canary, verdict, code]).toEqual(['book-liveness', 'FAIL', 0]);
    expect(metrics.dead_keys).toEqual(['dead:XT|EPT', 'dead:HTX|LRDS']);
    expect(metrics.dead_keys_dropped).toBe(0);
    expect(metrics.dead_set_size).toBe(2);
    expect(metrics.dead_per_venue).toEqual({ XT: 1, HTX: 1 });
    expect((metrics.window as { dates: number }).dates).toBe(28);
  });

  it('an EMPTY evaluable dead set clears the dead-book id — the wrapper prunes only if called',
    { timeout: 30_000 }, () => {
      const r = runMain('enforce', psqlStub('BINANCE|500|0', 'ASTER|SPY|9|2|9|28', 'ASTER|10', '36|2026-08-25'));
      expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=PASS`]);
      expect(calls(r.stdout)).toEqual([['clear_ceiling'], ['clear_dead_book']]);
    });

  it('an UNEVALUABLE window says nothing to the dead-book id — "could not judge" is not "none dead"',
    { timeout: 30_000 }, () => {
      const r = runMain('shadow', psqlStub('BINANCE|500|0', 'XT|EPT|4|3|15|4', 'XT|10', '4|2026-08-25'));
      expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=PASS`]);
      expect(calls(r.stdout)).toEqual([['clear_ceiling']]);
    });

  it('a floor above its pin fires the LEVEL id — not the dead-book id', { timeout: 30_000 }, () => {
    const r = runMain('enforce', psqlStub('BINANCE|500|0', 'ASTER|SPY|9|2|9|28', 'ASTER|5000|2026-09-30', '36|2026-08-25'));
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=FAIL`]);
    expect(r.stdout).toMatch(/BREACH floor ASTER: 5000 suppressions on 2026-09-30 > pin 3180 \(3 x the 1060 measured 2026-09-30\)/);
    expect(r.stdout).toMatch(/recommended_wave: OPS-BOOK-LIVENESS-W\{NEXT\}/);
    expect(calls(r.stdout)).toEqual([['fire_ceiling'], ['clear_dead_book']]);
  });
});

describe('book-liveness-canary — a dead book pages only when the venue does not explain it (OPS-ALARM-OWNER-DERIVATION-W1 CH2)', () => {
  // cols: exchange|coin|days|tfs|n|window_days_seen — R0.6's live shape: five thin, venue-live Aster books.
  const DEAD = ['ASTER|EWT|25|3|90|28', 'ASTER|KSTR|25|3|80|28', 'ASTER|SPY|9|2|9|28'].join('\n');
  const run = (admission: string) => runMain('enforce', psqlStub('BINANCE|500|0', DEAD, 'ASTER|10', '47|2026-08-25'), admission);

  it('an all-THIN_LIVE dead set is PASS: nothing fires, the id is CLEARED, and the run says why',
    { timeout: 30_000 }, () => {
      const r = run(admissionClasses({ 'dead:ASTER|EWT': 'THIN_LIVE', 'dead:ASTER|KSTR': 'THIN_LIVE' }));
      expect(r.status, r.stderr).toBe(0);
      expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=PASS`]);
      expect(calls(r.stdout)).toEqual([['clear_ceiling'], ['clear_dead_book']]);
      expect(r.stdout).toContain('DEAD_BOOKS_THIN_LIVE=2 (not paged: the venue lists them tradeable; the emit gate is suppressing correctly)');
      expect(r.stdout).not.toContain('BREACH dead book');
      const metrics = result(r.stdout)[3];
      expect(metrics.dead_keys).toEqual(['dead:ASTER|EWT', 'dead:ASTER|KSTR']);   // the FULL set, meaning unchanged
      expect(metrics.paged_keys).toEqual([]);
      expect(metrics.dead_key_class).toEqual({ 'dead:ASTER|EWT': 'THIN_LIVE', 'dead:ASTER|KSTR': 'THIN_LIVE' });
    });

  it('the seam is asked about exactly the dead keys — never a closed market', { timeout: 30_000 }, () => {
    const r = run(admissionClasses({ 'dead:ASTER|EWT': 'THIN_LIVE', 'dead:ASTER|KSTR': 'THIN_LIVE' }));
    expect(admCalls(r.stdout)).toEqual([['dead:ASTER|EWT', 'dead:ASTER|KSTR']]);
  });

  it('VENUE_OFF beside THIN_LIVE pages ONLY the VENUE_OFF key, with the admission remedy', { timeout: 30_000 }, () => {
    const r = run(admissionClasses({ 'dead:ASTER|EWT': 'VENUE_OFF', 'dead:ASTER|KSTR': 'THIN_LIVE' }));
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=FAIL`]);
    expect(calls(r.stdout)).toEqual([['clear_ceiling'], ['fire_dead_book', ['dead:ASTER|EWT']]]);
    expect(r.stdout).toContain('dead:ASTER|EWT — suppressed on 25 of 28 days across 3 timeframe');
    expect(r.stdout).toContain('— VENUE_OFF: status ok · last trade n/a · traded bars 24h 0 · stub');
    expect(r.stdout).toContain('recommended_wave: OPS-UNIVERSE-ADMISSION-W{NEXT}');
    expect(r.stdout).not.toContain('recommended_wave: OPS-BOOK-LIVENESS-W{NEXT}');
    expect(result(r.stdout)[3].paged_keys).toEqual(['dead:ASTER|EWT']);
  });

  it('ADAPTER_CONTRADICTION pages with the gate/adapter remedy', { timeout: 30_000 }, () => {
    const r = run(admissionClasses({ 'dead:ASTER|EWT': 'THIN_LIVE', 'dead:ASTER|KSTR': 'ADAPTER_CONTRADICTION' }));
    expect(calls(r.stdout)).toEqual([['clear_ceiling'], ['fire_dead_book', ['dead:ASTER|KSTR']]]);
    expect(r.stdout).toContain('recommended_wave: OPS-BOOK-LIVENESS-W{NEXT}');
    expect(r.stdout).not.toContain('recommended_wave: OPS-UNIVERSE-ADMISSION-W{NEXT}');
  });

  it('a FAILED verdict script pages every dead key as STATUS_UNKNOWN — noise, never silence', { timeout: 30_000 }, () => {
    const r = run('');   // the default stub: the docker exec failed
    expect(r.status, r.stderr).toBe(0);
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=FAIL`]);
    expect(calls(r.stdout)).toEqual([['clear_ceiling'], ['fire_dead_book', ['dead:ASTER|EWT', 'dead:ASTER|KSTR']]]);
    expect(r.stderr).toContain('admission verdict UNAVAILABLE - stubbed: no app container in the test');
    expect(r.stdout).toContain('declare a status source for ASTER');
    expect(result(r.stdout)[3].dead_key_class).toEqual({ 'dead:ASTER|EWT': 'STATUS_UNKNOWN', 'dead:ASTER|KSTR': 'STATUS_UNKNOWN' });
  });

  it('no dead set: the seam is never called and the id is cleared', { timeout: 30_000 }, () => {
    const r = runMain('enforce', psqlStub('BINANCE|500|0', 'ASTER|SPY|9|2|9|28', 'ASTER|10', '47|2026-08-25'));
    expect(admCalls(r.stdout)).toEqual([]);
    expect(calls(r.stdout)).toEqual([['clear_ceiling'], ['clear_dead_book']]);
    expect(r.stdout).toContain('DEAD_BOOKS_THIN_LIVE=0 ');
  });

  it('the seam stays the app container\'s own admission step, read-only, with a timeout', () => {
    expect(SRC).toContain('ADMISSION_CMD = ["docker", "exec", APP_CONTAINER, "node", "dist/scripts/admission-verdict.js", "--keys"]');
    expect(SRC).toMatch(/timeout=ADMISSION_TIMEOUT_S/);
  });
});
