/**
 * OPS-ALARM-SINGLE-DERIVATION-W1 CH1 — the ONE derivation for an alarm rate over a SINGLE
 * population (`ops/monitoring/population_rate.py`), pinned cross-language.
 *
 * WHY THIS MODULE EXISTS. `regime-budget-starvation-canary.py` divided every caller's Hyperliquid
 * `BUDGET_CEILING` throws by one tool's calls on every venue — two populations, one quotient — and
 * paged nightly on the disagreement between its own derivations (203 throws / 3,920 calls, none of
 * them the tool's own). The fix is structural: the numerator and the denominator come from ONE
 * statement over ONE `FROM` and ONE `WHERE`, so the numerator is a subset of the denominator BY
 * CONSTRUCTION, and a count that ever violates that is refused as an instrument defect.
 *
 * What this suite proves that the module's own `--self-test` cannot:
 *   1. the token and the exit code a caller gates on are what `main()` actually emits;
 *   2. every load-bearing rule in the self-test is PROVEN ABLE TO FAIL — each mutation below breaks
 *      one rule in a temp copy and the self-test must report FAIL, never PASS and never a crash.
 *      A mutation whose anchor text is missing FAILS this suite, so the anchors cannot rot silently.
 *
 * SPAWN BUDGET DECLARED in every block's OPTIONS argument (`scripts/check-test-budget.mjs`).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const REPO = path.resolve(__dirname, '../..');
const MOD = path.join(REPO, 'ops/monitoring/population_rate.py');
const TOKEN = 'POPULATION_RATE_VERDICT';

function run(file: string, args: string[]) {
  return spawnSync('python3', [file, ...args], { encoding: 'utf8', env: { ...process.env } });
}

/** Run a python snippet with the module importable as `pr`. Returns parsed JSON from stdout. */
function py(snippet: string, file = MOD): unknown {
  const code = [
    'import importlib.util, json, sys',
    `spec = importlib.util.spec_from_file_location("pr", ${JSON.stringify(file)})`,
    'pr = importlib.util.module_from_spec(spec); spec.loader.exec_module(pr)',
    snippet,
  ].join('\n');
  const r = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`python failed (${r.status}): ${r.stderr}`);
  return JSON.parse(r.stdout);
}

function tokenLines(stdout: string): string[] {
  return stdout.split('\n').filter((l) => l.startsWith(`${TOKEN}=`));
}

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('population_rate --self-test — the shipped contract', () => {
  it('PASSES with exactly one terminal token and exit 0', { timeout: 30_000 }, () => {
    const r = run(MOD, ['--self-test']);
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=PASS`]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/SELF-TEST: PASS \(\d+ assertions, non-vacuous\)/);
  });
});

describe('build_sql — numerator and denominator from ONE statement', () => {
  it('emits one SELECT, one FROM, one WHERE, FILTER for the event', { timeout: 30_000 }, () => {
    const sql = py(`print(json.dumps(pr.build_sql("request_log", "tool_name='x'", "verdict='E'", (), "ts > 1")))`) as string;
    expect(sql.match(/\bSELECT\b/g)?.length).toBe(1);
    expect(sql.match(/\bFROM\b/g)?.length).toBe(1);
    expect(sql.match(/\bWHERE\b/g)?.length).toBe(2); // the WHERE clause + the FILTER (WHERE …)
    expect(sql).toContain("count(*) FILTER (WHERE verdict='E')");
    expect(sql).toContain("WHERE (tool_name='x') AND (ts > 1)");
    expect(sql).not.toContain('GROUP BY');
  });

  it('groups only when asked, and orders by the same keys', { timeout: 30_000 }, () => {
    const sql = py(`print(json.dumps(pr.build_sql("t", "a=1", "b=2", ("venue", "caller"), "c=3")))`) as string;
    expect(sql).toContain('GROUP BY venue, caller ORDER BY venue, caller');
    expect(sql.startsWith('SELECT venue, caller, count(*) FILTER')).toBe(true);
  });

  it('refuses a second statement or an empty fragment rather than emitting it', { timeout: 30_000 }, () => {
    const out = py(`
res = {}
for name, args in [("semicolon", ("t", "a=1; DROP TABLE x", "b", (), "c")), ("empty", ("t", "", "b", (), "c"))]:
    try:
        pr.build_sql(*args); res[name] = "emitted"
    except ValueError:
        res[name] = "refused"
print(json.dumps(res))`) as Record<string, string>;
    expect(out).toEqual({ semicolon: 'refused', empty: 'refused' });
  });
});

describe('evaluate — the order is the contract', () => {
  const cases = `
cases = {
  "num_gt_den": pr.evaluate(pr.PopulationCounts("x", (), 29, 28), 1.0, 10),
  "negative": pr.evaluate(pr.PopulationCounts("x", (), -1, 28), 1.0, 10),
  "empty": pr.evaluate(pr.PopulationCounts("x", (), 0, 0), 1.0, 10),
  "breach_low_volume": pr.evaluate(pr.PopulationCounts("x", (), 60, 1000), 1.0, 2030),
  "clean_low_volume": pr.evaluate(pr.PopulationCounts("x", (), 0, 1000), 1.0, 2030),
  "clean_high_volume": pr.evaluate(pr.PopulationCounts("x", (), 0, 3000), 1.0, 2030),
  "at_tolerance": pr.evaluate(pr.PopulationCounts("x", (), 30, 3000), 1.0, 2030),
  "one_over": pr.evaluate(pr.PopulationCounts("x", (), 31, 3000), 1.0, 2030),
}
print(json.dumps({k: [v.verdict, v.reason] for k, v in cases.items()}))`;

  it('refuses an impossible count, then emptiness, then judges the rate before the floor', { timeout: 30_000 }, () => {
    const out = py(cases) as Record<string, [string, string]>;
    expect(out.num_gt_den).toEqual(['INDETERMINATE', 'instrument_defect']);
    expect(out.negative).toEqual(['INDETERMINATE', 'instrument_defect']);
    expect(out.empty).toEqual(['INDETERMINATE', 'empty_population']);
    // a breach FAILS at any volume — refusals are information even on a quiet day
    expect(out.breach_low_volume).toEqual(['FAIL', 'rate_above_tolerance']);
    // …but a quiet CLEAN window cannot earn a green
    expect(out.clean_low_volume).toEqual(['INDETERMINATE', 'below_floor']);
    expect(out.clean_high_volume).toEqual(['PASS', 'within_tolerance']);
    expect(out.at_tolerance).toEqual(['PASS', 'within_tolerance']);
    expect(out.one_over).toEqual(['FAIL', 'rate_above_tolerance']);
  });
});

describe('bounded_fraction — "29 of 28" is unwritable', () => {
  it('renders N of D and refuses num > den', { timeout: 30_000 }, () => {
    const out = py(`
res = {"ok": pr.bounded_fraction(28, 28, "days")}
try:
    pr.bounded_fraction(29, 28, "days"); res["over"] = "rendered"
except pr.InstrumentDefect:
    res["over"] = "refused"
print(json.dumps(res))`) as Record<string, string>;
    expect(out.ok).toBe('28 of 28 days');
    expect(out.over).toBe('refused');
  });
});

describe('measure — the seam executes the REAL builder and parses strictly', () => {
  it('passes build_sql(spec) to run_sql and parses grouped rows into counts', { timeout: 30_000 }, () => {
    const out = py(`
seen = []
def run_sql(sql):
    seen.append(sql)
    return "paid|2|2800\\nfree|9|145\\n"
spec = pr.RateSpec(table="request_log", population_where="tool_name='get_market_regime'",
                   event_where="verdict='E'", window_where="timestamp > 'x'", group_by=("slice",))
got = pr.measure(run_sql, spec)
print(json.dumps({"sql_is_builder": seen == [pr.build_sql(spec.table, spec.population_where, spec.event_where, spec.group_by, spec.window_where)],
                  "rows": [[c.group, c.numerator, c.denominator] for c in got]}))`) as {
      sql_is_builder: boolean; rows: [string[], number, number][];
    };
    expect(out.sql_is_builder).toBe(true);
    expect(out.rows).toEqual([[['paid'], 2, 2800], [['free'], 9, 145]]);
  });

  it('refuses a malformed row instead of reading a wrong column', { timeout: 30_000 }, () => {
    const out = py(`
spec = pr.RateSpec(table="t", population_where="a=1", event_where="b=2", window_where="c=3", group_by=("g",))
res = {}
for name, raw in [("short", "2|2800\\n"), ("non_int", "paid|x|3\\n")]:
    try:
        pr.measure(lambda sql, raw=raw: raw, spec); res[name] = "parsed"
    except ValueError:
        res[name] = "refused"
print(json.dumps(res))`) as Record<string, string>;
    expect(out).toEqual({ short: 'refused', non_int: 'refused' });
  });
});

describe('counts_for — an absent group is an empty population, built inside the module', () => {
  it('returns the matching group, or a zero-count row for a group the statement never emitted', { timeout: 30_000 }, () => {
    const out = py(`
rows = pr.parse_counts("paid|2|2800\\n", pr.RateSpec(table="t", population_where="a", event_where="b", window_where="c", group_by=("g",)))
hit = pr.counts_for(rows, ("paid",), "x")
miss = pr.counts_for(rows, ("internal",), "x")
print(json.dumps({"hit": [hit.numerator, hit.denominator], "miss": [miss.group, miss.numerator, miss.denominator],
                  "miss_verdict": pr.evaluate(miss, 1.0, 10).reason}))`) as { hit: number[]; miss: [string[], number, number]; miss_verdict: string };
    expect(out.hit).toEqual([2, 2800]);
    expect(out.miss).toEqual([['internal'], 0, 0]);
    expect(out.miss_verdict).toBe('empty_population');
  });
});

/**
 * Each mutation breaks ONE rule in a temp copy; the self-test must answer FAIL (exit 1) with a
 * token — never PASS, and never a crash without a token.
 */
const MUTATIONS: { name: string; from: string; to: string }[] = [
  {
    name: 'floor judged before the rate (a quiet day would mask a breach)',
    from: '    if per_100 > max_per_100:\n        return RateVerdict(FAIL, "rate_above_tolerance", per_100, counts)\n    if den < min_den:\n        return RateVerdict(INDET, "below_floor", per_100, counts)\n',
    to: '    if den < min_den:\n        return RateVerdict(INDET, "below_floor", per_100, counts)\n    if per_100 > max_per_100:\n        return RateVerdict(FAIL, "rate_above_tolerance", per_100, counts)\n',
  },
  {
    name: 'numerator-exceeds-denominator guard removed',
    from: '    if num < 0 or den < 0 or num > den:',
    to: '    if num < 0 or den < 0:',
  },
  {
    name: 'tolerance made inclusive (exactly-at-tolerance becomes a breach)',
    from: '    if per_100 > max_per_100:',
    to: '    if per_100 >= max_per_100:',
  },
  {
    name: 'bounded_fraction stops refusing num > den',
    from: '    if num < 0 or den < 0 or num > den:\n        raise InstrumentDefect(',
    to: '    if num < 0 or den < 0:\n        raise InstrumentDefect(',
  },
  {
    name: 'numerator computed in a second statement (two populations again)',
    from: 'f"count(*) FILTER (WHERE {event_where}), count(*) "',
    to: 'f"(SELECT count(*) FROM {table} WHERE {event_where}), count(*) "',
  },
  {
    name: 'row-width check removed (a short row reads the wrong column)',
    from: '        if len(parts) != width:',
    to: '        if len(parts) < 2:',
  },
];

describe('the self-test is PROVEN able to fail — one mutation per load-bearing rule', () => {
  const src = readFileSync(MOD, 'utf8');
  for (const m of MUTATIONS) {
    it(`catches: ${m.name}`, { timeout: 30_000 }, () => {
      // An anchor that no longer matches would make this mutation a no-op that "passes".
      expect(src.includes(m.from)).toBe(true);
      const dir = mkdtempSync(path.join(tmpdir(), 'poprate-mut-'));
      tmpDirs.push(dir);
      const file = path.join(dir, 'population_rate.py');
      writeFileSync(file, src.replace(m.from, m.to));
      const r = run(file, ['--self-test']);
      expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=FAIL`]);
      expect(r.status).toBe(1);
    });
  }

  it('states the mutation count it proves', { timeout: 30_000 }, () => {
    expect(MUTATIONS.length).toBeGreaterThanOrEqual(3);
  });
});
