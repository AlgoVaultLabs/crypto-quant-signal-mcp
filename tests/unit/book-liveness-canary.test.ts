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
  // The wrapper seams and the result recorder — every effect main() has, captured instead of
  // performed, and printed so a test can assert WHICH alert id heard WHAT on this run.
  'import json',
  'calls = []',
  'm.fire_dead_book = lambda body, keys: calls.append(["fire_dead_book", keys])',
  'm.clear_dead_book = lambda: calls.append(["clear_dead_book"])',
  'm.fire_defect = lambda body, keys: calls.append(["fire_defect", keys])',
  'm.clear_defect = lambda: calls.append(["clear_defect"])',
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
  // OPS-BOOK-LIVENESS-W2 CH2: the two probe seams (each a `docker exec` into the app container). By
  // DEFAULT one LIVE sentinel, and a rows call that fails — but with no S2 rows the rows leg is never
  // called. A test that needs another world overrides them with `probeWorld`.
  'probes = []',
  'def _sent_default():',
  '    probes.append(["sentinels"])',
  '    return {"mode": "sentinels", "sentinels": [{"venue": "BINANCE", "coin": "BTC", "state": "LIVE", "reason": "stub"}]}',
  'm.probe_sentinels = _sent_default',
  'def _rows_default(rows):',
  '    probes.append(["rows", [r.token for r in rows]])',
  '    raise m.ProbeError("stubbed: no app container in the test")',
  'm.probe_rows = _rows_default',
];
const REPORT = [
  'print("CALLS=" + json.dumps(calls))',
  'print("RESULT=" + json.dumps(results[-1] if results else None))',
  'print("ADM=" + json.dumps(adm))',
  'print("PROBES=" + json.dumps(probes))',
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
function probeCalls(stdout: string): unknown[][] {
  return JSON.parse(stdout.match(/^PROBES=(.*)$/m)?.[1] ?? 'null');
}

/**
 * Override the two probe seams. `sentinels` maps venue -> state, or is a string: the --sentinels call
 * FAILS with that reason. `rows` maps signal id -> verdict, or is a string: the --rows call fails.
 */
function probeWorld(sentinels: Record<string, string> | string, rows: Record<string, string> | string = {}): string {
  return [
    `_sw = ${JSON.stringify(sentinels)}`,
    `_rw = ${JSON.stringify(rows)}`,
    'def _sent():',
    '    probes.append(["sentinels"])',
    '    if isinstance(_sw, str): raise m.ProbeError(_sw)',
    '    return {"mode": "sentinels", "sentinels": [{"venue": v, "coin": "BTC", "state": s, "reason": "stub"} for v, s in _sw.items()]}',
    'm.probe_sentinels = _sent',
    'def _rows(rows):',
    '    probes.append(["rows", [r.token for r in rows]])',
    '    if isinstance(_rw, str): raise m.ProbeError(_rw)',
    '    return {"mode": "rows", "rows": [{"signal_id": r.id, "venue": r.venue, "coin": r.coin, "timeframe": r.timeframe,',
    '            "entry": "T", "verdict": _rw[str(r.id)], "reason": "stub"} for r in rows]}',
    'm.probe_rows = _rows',
  ].join('\n');
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
  persistence: string, suppressions = '', counterAge = '4|2026-08-25', s2 = '',
): string {
  return [
    'def _q(sql):',
    // OPS-BOOK-LIVENESS-W2: leg G's S2 rows (id|exchange|coin|timeframe|s2_entry) — routed FIRST, on the
    // alias only that builder emits.
    '    if "s2_entry" in sql:',
    `        return ${JSON.stringify(s2)}`,
    '    if "window_days_seen" in sql:',
    `        return ${JSON.stringify(persistence)}`,
    // Both remaining builders read dates; route on what is UNIQUE to each, or a reordering of the two
    // would silently swap which answer each query receives.
    '    if "MIN(date)" in sql:',
    `        return ${JSON.stringify(counterAge)}`,
    // OPS-BOOK-LIVENESS-W2 CH3: the 7-date suppressions record (exchange|date|n), recorded and never paged.
    '    if "date::text" in sql:',
    `        return ${JSON.stringify(suppressions)}`,
    // Anything else is a query this stub does not know: a builder the canary should not be running.
    '    raise m.QueryError("unrouted query: " + sql[:60])',
    'm.psql = _q',
  ].join('\n');
}

/** A clean fleet: a young counter, no suppressions, one LIVE sentinel (the default probe stub). */
const CLEAN = psqlStub('');

/**
 * Appended AFTER a psqlStub: rewrites DATE0..DATE6 in its answers to the canary's own 7 record dates
 * (oldest first), so a suppressions fixture can never age out of the window it is meant to sit in.
 */
const RELATIVE_DATES = [
  'import datetime as _dt',
  '_d = m.record_dates(7, _dt.datetime.now(_dt.timezone.utc).date())',
  '_q1 = m.psql',
  'def _qd(sql):',
  '    out = _q1(sql)',
  '    for i, d in enumerate(_d): out = out.replace("DATE%d" % i, d)',
  '    return out',
  'm.psql = _qd',
].join('\n');

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
      const r = runMain('shadow', CLEAN, probeWorld({ BINGX: 'FROZEN' }));
      expect(r.status, r.stderr).toBe(0);
      expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=FAIL`]);
      expect(r.stdout).toContain('level_breaches=1 (the page keys of book_liveness_defect)');
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
  it('the stage reason is still DERIVED, and NO window query uses it — a flip cannot restart a detector',
    { timeout: 30_000 }, () => {
      // MEASURED 2026-08-29: the shadow->enforce flip changed reason_for(mode), the window
      // queries were scoped by it, and the dead-book detector silently reset to zero — counter
      // age 5d -> 1d, and 3 of 5 KNOWN dead books dropped to zero recorded days. A window keyed
      // on a mutable reason restarts itself every time the reason changes. The one stage-scoped
      // query (the shadow-recency read behind MIXED_WINDOW) went with the frozen-row rate in
      // OPS-BOOK-LIVENESS-W2 CH3.
      const r = spawnSync('python3', ['-c', [
        'import importlib.util',
        `spec = importlib.util.spec_from_file_location("c", ${JSON.stringify(PY)})`,
        'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
        'print(m.reason_for("enforce"))',
        'print(m.reason_for("shadow"))',
        'w = [m.build_persistence_sql(28), m.build_counter_age_sql(), m.build_suppressions_sql(7), m.build_s2_rows_sql(3)]',
        'print("WINDOW_REASON_FREE" if not any("reason" in q for q in w) else "LEAKED")',
      ].join('\n')], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim().split('\n')).toEqual(['frozen_book', 'frozen_book_shadow', 'WINDOW_REASON_FREE']);
    });
});

describe('book-liveness-canary — closed-vs-broken discriminator', () => {
  it('a dead book breaches; a closed market on the SAME run does not', { timeout: 30_000 }, () => {
    // cols: exchange|coin|days|tfs|n|window_days_seen — a full 28-day window.
    const rows = ['XT|EPT|28|3|140|28', 'ASTER|SPY|9|2|9|28'].join('\n');
    const r = runMain('enforce', psqlStub(rows, '', '28|2026-08-01'));
    expect(r.status, r.stderr).toBe(0);
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=FAIL`]);
    expect(r.stdout).toMatch(/BREACH dead book XT\|EPT/);
    expect(r.stdout).not.toMatch(/ASTER\|SPY/);
  });

  it('a young counter reports INSUFFICIENT_WINDOW and never a verdict', { timeout: 30_000 }, () => {
    // The same dead book, but the counter has only seen 4 of 28 days.
    const rows = 'XT|EPT|4|3|15|4';
    const r = runMain('shadow', psqlStub(rows, '', '4|2026-08-25'));
    expect(r.status, r.stderr).toBe(0);
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=PASS`]);
    expect(r.stdout).toMatch(/INSUFFICIENT_WINDOW - the counter is 4 day\(s\) old, needs 28; full coverage on 2026-09-21/);
      expect(r.stdout).toMatch(/NO dead-book detection until then/);
  });
});

describe('book-liveness-canary — the target state', () => {
  it('a MATURE counter with ZERO suppressions is a reported PASS, not an unknown',
    { timeout: 30_000 }, () => {
      // The state a fully enforcing gate reaches. Keying evaluability on "days carrying a
      // suppression" instead of counter AGE would make the canary call its own success
      // INSUFFICIENT_WINDOW forever.
      const r = runMain('enforce', psqlStub('', '', '28|2026-08-01'));
      expect(r.status, r.stderr).toBe(0);
      expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=PASS`]);
      expect(r.stdout).toMatch(/persistence: 0 suppressions in the last 28 days over a full 28-day counter - no dead books/);
      expect(r.stdout).not.toMatch(/INSUFFICIENT_WINDOW/);
    });
});

describe('book-liveness-canary — reporting is positive, never absence-of-alert', () => {
  it('the suppressions record prints every venue\'s total and busiest date, and never pages',
    { timeout: 30_000 }, () => {
      const r = runMain('enforce', `${psqlStub('', 'ASTER|DATE3|10\nBINGX|DATE6|3', '28|2026-08-01')}\n${RELATIVE_DATES}`);
      expect(r.status, r.stderr).toBe(0);
      expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=PASS`]);
      expect(r.stdout).toMatch(/suppressions \(recorded, never paged\): 7 UTC dates \d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2} - ASTER 10 \(peak 10 on \d{4}-\d{2}-\d{2}\) · BINGX 3 /);
      expect(calls(r.stdout)).toEqual([['clear_dead_book'], ['clear_defect']]);
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
    expect(SRC).toMatch(/^WAVE_DEFECT = "OPS-BOOK-LIVENESS-W\{NEXT\}"$/m);
    expect(SRC).toMatch(/^WAVE_DEAD_BOOK = "OPS-UNIVERSE-ADMISSION-W\{NEXT\}"$/m);
    // a literal wave number in a remedy is HALT-class (historical wave ids in comments are provenance)
    expect(SRC).not.toMatch(/^WAVE_[A-Z_]+ = "OPS-[A-Z0-9-]+-W\d/m);
    expect(SRC).not.toMatch(/recommended_wave: OPS-[A-Z-]+-W\d/);
  });

  it('every alert id keeps LITERAL call sites, so the registry gate can enumerate them', () => {
    expect(SRC).toContain('[TG, "book_liveness_dead_book", "CRITICAL_PERSISTENT", "-"]');
    expect(SRC).toContain('[TG, "book_liveness_defect", "CRITICAL_PERSISTENT", "-"]');
    expect(SRC).toContain('[TG, "--clear", "book_liveness_dead_book"]');
    expect(SRC).toContain('[TG, "--clear", "book_liveness_defect"]');
  });

  it('the retired LEVEL id has no call site left, and the pins are gone (OPS-BOOK-LIVENESS-W2 CH3, AC3.2)', () => {
    expect(SRC).not.toMatch(/\[TG, "(--clear", ")?book_liveness_ceiling"/);
    expect(SRC).not.toMatch(/FLOOR_PINS|FROZEN_CEILING_PCT|classify_floor|MIN_DENOM =/);
  });

  it('the dead-book window still carries its revisit date', () => {
    const todos = SRC.match(/TODO: revisit by (\d{4}-\d{2}-\d{2})/g) ?? [];
    expect(todos.length).toBeGreaterThanOrEqual(1);
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
      const r = runMain('enforce', psqlStub('XT|EPT|29|3|140|29', '', '36|2026-08-25'));
      expect(r.status, r.stderr).toBe(3);
      expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=INDETERMINATE`]);
      expect(r.stderr).toMatch(/instrument_defect: 29 of 28/);
      expect(r.stdout).not.toMatch(/suppressed on 29 of 28/);   // never reported as a fact about a book
      expect(result(r.stdout)[3].reason).toMatch(/^instrument_defect: 29 of 28 window dates/);
      expect(calls(r.stdout)).toEqual([]);          // never paged, never cleared
    });

  it('a dead set fires the DEAD-BOOK id with ENTITY keys; the defect id, unbreached, is cleared',
    { timeout: 30_000 }, () => {
      const rows = ['XT|EPT|28|3|140|28', 'HTX|LRDS|28|5|100|28', 'ASTER|SPY|9|2|9|28'].join('\n');
      const r = runMain('enforce', psqlStub(rows, '', '36|2026-08-25'));
      expect(r.status, r.stderr).toBe(0);
      expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=FAIL`]);
      expect(calls(r.stdout)).toEqual([
        ['fire_dead_book', ['dead:XT|EPT', 'dead:HTX|LRDS']],
        ['clear_defect'],
      ]);
      expect(r.stdout).toMatch(/dead:XT\|EPT — suppressed on 28 of 28 days across 3 timeframe\(s\)/);
      expect(r.stdout).toMatch(/recommended_wave: OPS-UNIVERSE-ADMISSION-W\{NEXT\}/);
      expect(r.stdout).toMatch(/Runbook: https:\/\/github\.com\/AlgoVaultLabs\/crypto-quant-signal-mcp\/blob\/main\/docs\/RUNBOOK-BOOK-LIVENESS-FLIP\.md/);
    });

  it('the result line carries the dead-set KEYS and the window dates', { timeout: 30_000 }, () => {
    const rows = ['XT|EPT|28|3|140|28', 'HTX|LRDS|28|5|100|28'].join('\n');
    const r = runMain('enforce', psqlStub(rows, '', '36|2026-08-25'));
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
      const r = runMain('enforce', psqlStub('ASTER|SPY|9|2|9|28', '', '36|2026-08-25'));
      expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=PASS`]);
      expect(calls(r.stdout)).toEqual([['clear_dead_book'], ['clear_defect']]);
    });

  it('an UNEVALUABLE window says nothing to the dead-book id — "could not judge" is not "none dead"',
    { timeout: 30_000 }, () => {
      const r = runMain('shadow', psqlStub('XT|EPT|4|3|15|4', '', '4|2026-08-25'));
      expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=PASS`]);
      expect(calls(r.stdout)).toEqual([['clear_defect']]);
    });

  it('AC3.1: the 11-08/09 state (BINGX 14, BITGET 9) pages NOTHING — the counts are recorded',
    { timeout: 30_000 }, () => {
      // OPS-BOOK-LIVENESS-W1: the floor paged BINGX 14 on 2026-11-09 > pin 9 and BITGET 9 on 2026-11-08 > pin 3
      // at the 2026-11-11T19:09Z run. Every one was a correct suppression. The same counts, today:
      const r = runMain('enforce',
        `${psqlStub('ASTER|SPY|9|2|9|28', 'BINGX|DATE5|14\nBITGET|DATE4|9', '36|2026-08-25')}\n${RELATIVE_DATES}`);
      expect(r.status, r.stderr).toBe(0);
      expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=PASS`]);
      expect(calls(r.stdout)).toEqual([['clear_dead_book'], ['clear_defect']]);
      expect(r.stdout).toContain('level_breaches=0 (the page keys of book_liveness_defect)');
      const metrics = result(r.stdout)[3] as { level_breaches: number; suppressions: { dates: string[]; by_venue: Record<string, number[]> } };
      expect(metrics.level_breaches).toBe(0);
      expect(metrics.suppressions.dates).toHaveLength(7);
      expect(metrics.suppressions.by_venue).toEqual({ BINGX: [0, 0, 0, 0, 0, 14, 0], BITGET: [0, 0, 0, 0, 9, 0, 0] });
      expect(metrics).not.toHaveProperty('floor_max');
    });

  it('a suppression row dated outside the 7-date window is an INDETERMINATE instrument_defect, never recorded',
    { timeout: 30_000 }, () => {
      const r = runMain('enforce', psqlStub('', 'XT|1999-01-01|3', '36|2026-08-25'));
      expect(r.status, r.stderr).toBe(3);
      expect(r.stderr).toMatch(/instrument_defect: 1 suppression row\(s\) dated outside the/);
      expect(calls(r.stdout)).toEqual([]);
    });
});

describe('book-liveness-canary — a dead book pages only when the venue does not explain it (OPS-ALARM-OWNER-DERIVATION-W1 CH2)', () => {
  // cols: exchange|coin|days|tfs|n|window_days_seen — R0.6's live shape: five thin, venue-live Aster books.
  const DEAD = ['ASTER|EWT|25|3|90|28', 'ASTER|KSTR|25|3|80|28', 'ASTER|SPY|9|2|9|28'].join('\n');
  const run = (admission: string) => runMain('enforce', psqlStub(DEAD, '', '47|2026-08-25'), admission);

  it('an all-THIN_LIVE dead set is PASS: nothing fires, the id is CLEARED, and the run says why',
    { timeout: 30_000 }, () => {
      const r = run(admissionClasses({ 'dead:ASTER|EWT': 'THIN_LIVE', 'dead:ASTER|KSTR': 'THIN_LIVE' }));
      expect(r.status, r.stderr).toBe(0);
      expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=PASS`]);
      expect(calls(r.stdout)).toEqual([['clear_dead_book'], ['clear_defect']]);
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
    expect(calls(r.stdout)).toEqual([['fire_dead_book', ['dead:ASTER|EWT']], ['clear_defect']]);
    expect(r.stdout).toContain('dead:ASTER|EWT — suppressed on 25 of 28 days across 3 timeframe');
    expect(r.stdout).toContain('— VENUE_OFF: status ok · last trade n/a · traded bars 24h 0 · stub');
    expect(r.stdout).toContain('recommended_wave: OPS-UNIVERSE-ADMISSION-W{NEXT}');
    expect(r.stdout).not.toContain('recommended_wave: OPS-BOOK-LIVENESS-W{NEXT}');
    expect(result(r.stdout)[3].paged_keys).toEqual(['dead:ASTER|EWT']);
  });

  it('ADAPTER_CONTRADICTION pages with the gate/adapter remedy', { timeout: 30_000 }, () => {
    const r = run(admissionClasses({ 'dead:ASTER|EWT': 'THIN_LIVE', 'dead:ASTER|KSTR': 'ADAPTER_CONTRADICTION' }));
    expect(calls(r.stdout)).toEqual([['fire_dead_book', ['dead:ASTER|KSTR']], ['clear_defect']]);
    expect(r.stdout).toContain('recommended_wave: OPS-BOOK-LIVENESS-W{NEXT}');
    expect(r.stdout).not.toContain('recommended_wave: OPS-UNIVERSE-ADMISSION-W{NEXT}');
  });

  it('a FAILED verdict script pages every dead key as STATUS_UNKNOWN — noise, never silence', { timeout: 30_000 }, () => {
    const r = run('');   // the default stub: the docker exec failed
    expect(r.status, r.stderr).toBe(0);
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=FAIL`]);
    expect(calls(r.stdout)).toEqual([['fire_dead_book', ['dead:ASTER|EWT', 'dead:ASTER|KSTR']], ['clear_defect']]);
    expect(r.stderr).toContain('admission verdict UNAVAILABLE - stubbed: no app container in the test');
    expect(r.stdout).toContain('declare a status source for ASTER');
    expect(result(r.stdout)[3].dead_key_class).toEqual({ 'dead:ASTER|EWT': 'STATUS_UNKNOWN', 'dead:ASTER|KSTR': 'STATUS_UNKNOWN' });
  });

  it('no dead set: the seam is never called and the id is cleared', { timeout: 30_000 }, () => {
    const r = runMain('enforce', psqlStub('ASTER|SPY|9|2|9|28', '', '47|2026-08-25'));
    expect(admCalls(r.stdout)).toEqual([]);
    expect(calls(r.stdout)).toEqual([['clear_dead_book'], ['clear_defect']]);
    expect(r.stdout).toContain('DEAD_BOOKS_THIN_LIVE=0 ');
  });

  it('the seam stays the app container\'s own admission step, read-only, with a timeout', () => {
    expect(SRC).toContain('ADMISSION_CMD = ["docker", "exec", APP_CONTAINER, "node", "dist/scripts/admission-verdict.js", "--keys"]');
    expect(SRC).toMatch(/timeout=ADMISSION_TIMEOUT_S/);
  });
});

describe('book-liveness-canary — leg S and leg G page under book_liveness_defect (OPS-BOOK-LIVENESS-W2 CH2)', () => {
  // cols: id|exchange|coin|timeframe|s2_entry
  const S2 = ['1328245|XT|AUD|8h|1794300000', '1311028|ASTER|SYRUP|15m|1794200000'].join('\n');
  const FIXTURES = path.join(REPO, 'tests/fixtures/book-liveness-probe');

  it('a FROZEN sentinel FAILs and fires sentinel:<VENUE>',
    { timeout: 30_000 }, () => {
      const r = runMain('enforce', CLEAN, probeWorld({ BINGX: 'FROZEN', XT: 'LIVE' }));
      expect(r.status, r.stderr).toBe(0);
      expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=FAIL`]);
      expect(calls(r.stdout)).toEqual([['fire_defect', ['sentinel:BINGX']]]);
      expect(r.stdout).toContain('sentinel leg: 2 active venue(s) read - LIVE 1 · FROZEN 1 · UNREADABLE 0');
      expect(r.stdout).toContain("fix the adapter's volume parse");
      expect(r.stdout).toContain('recommended_wave: OPS-BOOK-LIVENESS-W{NEXT}');
    });

  it('a GATE_MISS under enforce fires miss:<id>; each S2 row reaches the probe as its own row token',
    { timeout: 30_000 }, () => {
      const r = runMain('enforce', psqlStub('', '', '4|2026-08-25', S2),
        probeWorld({ XT: 'LIVE' }, { 1328245: 'GATE_MISS', 1311028: 'FROZE_AFTER' }));
      expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=FAIL`]);
      expect(calls(r.stdout)).toEqual([['fire_defect', ['miss:1328245']]]);
      expect(probeCalls(r.stdout)).toEqual([
        ['sentinels'],
        ['rows', ['XT|AUD|8h|1794300000|1328245', 'ASTER|SYRUP|15m|1794200000|1311028']],
      ]);
      expect(r.stdout).toContain('gate-miss leg: 2 S2 row(s) in the last 3d - GATE_MISS 1 · FROZE_AFTER 1 · UNVERIFIABLE 0 (gate mode enforce)');
    });

  it('a GATE_MISS under SHADOW is recorded per venue and never paged — the gate withholds nothing in shadow',
    { timeout: 30_000 }, () => {
      const r = runMain('shadow', psqlStub('', '', '4|2026-08-25', S2),
        probeWorld({ XT: 'LIVE' }, { 1328245: 'GATE_MISS', 1311028: 'FROZE_AFTER' }));
      expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=PASS`]);
      expect(calls(r.stdout)).toEqual([['clear_defect']]);
      expect(r.stdout).toContain('(gate mode shadow; a miss pages only while it enforces)');
      expect(result(r.stdout)[3].s2).toEqual({
        XT: { gate_miss: 1, froze_after: 0, unverifiable: 0 },
        ASTER: { gate_miss: 0, froze_after: 1, unverifiable: 0 },
      });
    });

  it('an UNREADABLE sentinel is INDETERMINATE/3: book_liveness_defect hears nothing, the other ids still do',
    { timeout: 30_000 }, () => {
      const r = runMain('enforce', psqlStub('', '', '36|2026-08-25'), probeWorld({ BINGX: 'UNREADABLE', XT: 'LIVE' }));
      expect(r.status, r.stderr).toBe(3);
      expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=INDETERMINATE`]);
      expect(calls(r.stdout)).toEqual([['clear_dead_book']]);
      expect(r.stdout).toContain('book_liveness_defect: INDETERMINATE - neither fired nor cleared');
      const [, verdict, code, metrics] = result(r.stdout);
      expect([verdict, code]).toEqual(['INDETERMINATE', 3]);
      expect(metrics.sentinel).toEqual({ BINGX: 'UNREADABLE', XT: 'LIVE' });
    });

  it('a failed --rows call with S2 rows present is INDETERMINATE/3 — every row UNVERIFIABLE, none dropped',
    { timeout: 30_000 }, () => {
      const r = runMain('enforce', psqlStub('', '', '4|2026-08-25', S2),
        probeWorld({ XT: 'LIVE' }, 'timed out'));
      expect(r.status, r.stderr).toBe(3);
      expect(calls(r.stdout)).toEqual([]);
      expect(r.stdout).toContain('gate-miss probe UNAVAILABLE - timed out');
      expect(result(r.stdout)[3].s2).toEqual({
        XT: { gate_miss: 0, froze_after: 0, unverifiable: 1 },
        ASTER: { gate_miss: 0, froze_after: 0, unverifiable: 1 },
      });
    });

  it('a failed --sentinels call is INDETERMINATE/3, and the rows leg still runs', { timeout: 30_000 }, () => {
    const r = runMain('enforce', psqlStub('', '', '4|2026-08-25', S2),
      probeWorld('docker exec: no such container', { 1328245: 'FROZE_AFTER', 1311028: 'FROZE_AFTER' }));
    expect(r.status, r.stderr).toBe(3);
    expect(r.stdout).toContain('sentinel leg: UNAVAILABLE - docker exec: no such container');
    expect(probeCalls(r.stdout).map((c) => c[0])).toEqual(['sentinels', 'rows']);
  });

  it('zero S2 rows is a fact: PASS, --clear, a positive line per leg, and the rows probe is never called',
    { timeout: 30_000 }, () => {
      const r = runMain('enforce', CLEAN);
      expect(r.status, r.stderr).toBe(0);
      expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=PASS`]);
      expect(calls(r.stdout)).toEqual([['clear_defect']]);
      expect(r.stdout).toContain('sentinel leg: 1 active venue(s) read - LIVE 1 · FROZEN 0 · UNREADABLE 0');
      expect(r.stdout).toContain('gate-miss leg: 0 S2 rows in the last 3d - nothing to judge (a fact, not a gap)');
      expect(probeCalls(r.stdout)).toEqual([['sentinels']]);
      const metrics = result(r.stdout)[3];
      expect(metrics.defect_verdict).toBe('PASS');
      expect(metrics.sentinel).toEqual({ BINANCE: 'LIVE' });
      expect(metrics.s2).toEqual({});
      expect(metrics.defect_keys).toEqual([]);
    });

  it('an unreadable S2 query is INDETERMINATE/3 and no alert id hears anything', { timeout: 30_000 }, () => {
    const r = runMain('enforce', [
      CLEAN,
      '_q0 = m.psql',
      'def _q2(sql):',
      '    if "s2_entry" in sql: raise m.QueryError("statement timeout")',
      '    return _q0(sql)',
      'm.psql = _q2',
    ].join('\n'));
    expect(r.status, r.stderr).toBe(3);
    expect(calls(r.stdout)).toEqual([]);
    expect(r.stderr).toContain('s2 rows query: statement timeout');
  });

  it('the parser reads the REAL container captures (tests/fixtures/book-liveness-probe)', { timeout: 20_000 }, () => {
    const r = spawnSync('python3', ['-c', [
      'import importlib.util, json, re, sys',
      `spec = importlib.util.spec_from_file_location("c", ${JSON.stringify(PY)})`,
      'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
      `sent = open(${JSON.stringify(path.join(FIXTURES, 'sentinels.stdout.txt'))}).read()`,
      `rows = open(${JSON.stringify(path.join(FIXTURES, 'rows.stdout.txt'))}).read()`,
      `req = open(${JSON.stringify(path.join(FIXTURES, 'rows.request.txt'))}).read().split()`,
      'ids = [int(t.rsplit("|", 1)[1]) for t in req]',
      's = m.parse_probe_output(sent, "sentinels")',
      'd = m.parse_probe_output(rows, "rows", ids)',
      'print(json.dumps({"venues": sorted(x["venue"] for x in s["sentinels"]), "excluded": s["excluded_retired"],',
      '                  "states": sorted({x["state"] for x in s["sentinels"]}), "rows": len(d["rows"]), "ids": len(ids),',
      '                  "noise": sum(1 for ln in sent.splitlines() if ln.startswith("[universe-admission]"))}))',
    ].join('\n')], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const got = JSON.parse(r.stdout.trim());
    expect(got.venues).toEqual(['ASTER', 'BINANCE', 'BINGX', 'BITGET', 'BYBIT', 'GATE', 'HL', 'HTX', 'KUCOIN',
      'MEXC', 'OKX', 'PHEMEX', 'WEEX', 'WHITEBIT', 'XT']);
    expect(got.excluded).toEqual(['BITMART', 'EDGEX']);
    expect(got.rows).toBe(got.ids);
    expect(got.noise).toBeGreaterThan(0);   // the capture really carries the app's own log lines before the document
  });

  it('the S2 query is the S2 predicate, and the probe seam is the app container\'s own CLI', () => {
    expect(SRC).toContain("\" WHERE signal IN ('BUY','SELL')\"");
    expect(SRC).toContain('"   AND pfe_candles = 0 AND mae_return_pct = 0"');
    expect(SRC).toContain('PROBE_CMD = ["docker", "exec", APP_CONTAINER, "node", "dist/scripts/book-liveness-probe.js"]');
    expect(SRC).toMatch(/timeout=timeout_s/);
  });
});
