/**
 * OPS-ALARM-SINGLE-DERIVATION-W1 CH1 — the regime canary measures the harm it names, over ONE
 * population. Pinned by running the SHIPPED `main()` with its effects stubbed (DB, container-env
 * probe, Telegram), the same shape as `book-liveness-canary.test.ts`.
 *
 * THE DEFECT, measured at R0 (2026-09-29): the pre-change canary paged "Interactive upstream
 * budget is refusing PAID calls" on 203 / 3,920 — 189 `scan_trade_calls` throws from an internal
 * scan plus 14 from a nightly labeler, divided by `get_market_regime` calls on every venue. Zero of
 * the throws were the tool's own and zero paid calls were refused. The rebuilt page predicate is
 * refusals (`ERR_UPSTREAM_RATE_LIMIT` ∪ `DEGRADED_FUNDING_BUDGET`) among PAID `get_market_regime`
 * calls — numerator and denominator from one statement — and the throws are EVIDENCE, never divided.
 *
 * The regression is pinned both ways (spec AC3):
 *   F1  = 150 HL interactive throws, all `scan_trade_calls`; 0 refusals; 3,900 regime calls
 *         → the new canary PASSES without paging, and its evidence names the caller;
 *   F2  = 60 `ERR_UPSTREAM_RATE_LIMIT` on 1,000 verified-paid regime calls → FAIL, body says PAID;
 *   F1 replayed through the PRE-CHANGE canary (frozen fixture, sha 29707b7f…) → FAIL — proof this
 *         suite would have caught the defect.
 *
 * SPAWN BUDGET DECLARED in every block's OPTIONS argument (`scripts/check-test-budget.mjs`).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PAYMENT_RAIL_BY_TIER, SUBSCRIPTION_TIERS, X402_TIERS } from '../../src/lib/payment-rail.js';
import { PLANS } from '../../src/lib/plans.js';
import { regimeErrorVerdict, regimeSuccessVerdict } from '../../src/lib/regime-request-verdict.js';
import { UpstreamRateLimitError } from '../../src/lib/errors.js';

const REPO = path.resolve(__dirname, '../..');
const CANARY = path.join(REPO, 'ops/monitoring/regime-budget-starvation-canary.py');
const PRE_FIX = path.join(REPO, 'tests/fixtures/regime-budget-starvation-canary.pre-alarm-single-derivation.py.txt');
const TOKEN = 'REGIME_STARVATION_VERDICT';

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function tokenLines(stdout: string): string[] {
  return stdout.split('\n').filter((l) => l.startsWith(`${TOKEN}=`));
}

interface Stub {
  slices?: string | 'RAISE';
  throws?: string;
  errUnknown?: string;
  evidence?: string;
  verification?: string;
  devPrefix?: string | null;
}

/**
 * Drive the shipped `main(['--check'])` with every effect stubbed. Queries are routed by a
 * distinctive fragment of each builder's SQL, so a builder that stops emitting its scoping clause
 * changes which branch runs rather than passing silently.
 */
function runCheck(s: Stub, file = CANARY) {
  const resultLog = path.join(tmp('regime-res-'), 'canary-results.jsonl');
  const code = [
    'import importlib.util, json, sys',
    `spec = importlib.util.spec_from_file_location("c", ${JSON.stringify(file)})`,
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    'fired, cleared = [], []',
    'def _q(sql):',
    `    if "CASE WHEN license_tier IN" in sql:`,
    s.slices === 'RAISE'
      ? '        raise RuntimeError("psql rc=2: could not connect")'
      : `        return ${JSON.stringify(s.slices ?? '')}`,
    '    if "FROM rate_limit_events" in sql:',
    `        return ${JSON.stringify(s.throws ?? '')}`,
    `    if "verdict = 'ERR_UNKNOWN'" in sql:`,
    `        return ${JSON.stringify(s.errUnknown ?? '0|0')}`,
    '    if "coalesce(exchange" in sql:',
    `        return ${JSON.stringify(s.evidence ?? '')}`,
    '    if "FROM subscriber_profiles" in sql:',
    `        return ${JSON.stringify(s.verification ?? '1|7|0')}`,
    '    raise RuntimeError("unrouted SQL: " + sql[:120])',
    'm.run_sql = _q',
    'm.fire = lambda body: fired.append(body)',
    'm.clear = lambda: cleared.append(1)',
    `m.read_container_env = lambda name: ${s.devPrefix === undefined || s.devPrefix === null ? 'None' : JSON.stringify(s.devPrefix)}`,
    "rc = m.main(['--check'])",
    'print("__RESULT__" + json.dumps({"rc": rc, "fired": fired, "cleared": len(cleared)}))',
  ].join('\n');
  const r = spawnSync('python3', ['-c', code], {
    encoding: 'utf8',
    env: { ...process.env, CANARY_RESULT_LOG_PATH: resultLog, ALGOVAULT_TG_TEST_INERT: '1' },
  });
  const line = r.stdout.split('\n').find((l) => l.startsWith('__RESULT__'));
  const res = line ? JSON.parse(line.slice('__RESULT__'.length)) : null;
  const records = existsSync(resultLog)
    ? readFileSync(resultLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  return { stdout: r.stdout, stderr: r.stderr, status: r.status, res, records };
}

// F1 — the 2026-09-28 shape: throws are real, all internal, and not one paid call was refused.
const F1: Stub = {
  slices: 'free_or_other|0|13\ninternal|0|1087\npaid|0|2800\n',
  throws: 'Hyperliquid|scan_trade_calls|150|150\n',
  errUnknown: '0|3900\n',
  evidence: '',
};

// F2 — genuine paid harm: 60 candle-leg refusals on 1,000 verified-paid calls.
const F2: Stub = {
  slices: 'paid|60|1000\n',
  throws: '',
  errUnknown: '0|1000\n',
  evidence: 'HL|ERR_UPSTREAM_RATE_LIMIT|60\n',
};

describe('F1 / F2 — the regression, pinned both ways', () => {
  it('F1: internal throws with zero paid refusals PASS and page nobody', { timeout: 30_000 }, () => {
    const r = runCheck(F1);
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=PASS`]);
    expect(r.res).toMatchObject({ rc: 0, fired: [], cleared: 1 });
    // the throws are EVIDENCE — named by caller, with their :00/:30 share, never divided by calls
    expect(r.stdout).toMatch(/caller=scan_trade_calls .*150 of 150 throws \(100\.00%\)/);
  });

  it('F2: paid refusals above tolerance FAIL at any volume, and the body says PAID', { timeout: 30_000 }, () => {
    const r = runCheck(F2);
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=FAIL`]);
    expect(r.res.rc).toBe(1);
    expect(r.res.fired).toHaveLength(1);
    const body: string = r.res.fired[0];
    expect(body).toContain('PAID');
    expect(body).not.toContain('unverified');
    expect(body).toContain('60 of 1000');
    expect(body).toContain('Action: dispatch OPS-PAID-INTERACTIVE-REFUSAL-W{NEXT}');
    expect(body).not.toContain('OPS-HL-INTERACTIVE-STARVATION');
  });

  it('F1 replayed through the PRE-CHANGE canary FAILS — this suite would have caught it', { timeout: 30_000 }, () => {
    const src = readFileSync(PRE_FIX, 'utf8');
    const dir = tmp('regime-prefix-');
    const file = path.join(dir, 'regime-budget-starvation-canary.py');
    writeFileSync(file, src);
    const code = [
      'import importlib.util, json',
      `spec = importlib.util.spec_from_file_location("old", ${JSON.stringify(file)})`,
      'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
      'fired = []',
      // the old rate query: venue | throws (any caller) | get_market_regime calls (any venue)
      'm.run_sql = lambda sql: "Binance|0|3900\\nBitget|0|3900\\nBybit|0|3900\\nHyperliquid|150|3900\\nOKX|0|3900\\n"',
      'm.fire = lambda body: fired.append(body)',
      'm.clear = lambda: None',
      'rc = m.main([])',
      'print("__RESULT__" + json.dumps({"rc": rc, "fired": fired}))',
    ].join('\n');
    const r = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
    const res = JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('__RESULT__'))!.slice(10));
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=FAIL`]);
    expect(res.rc).toBe(1);
    expect(res.fired[0]).toContain('refusing PAID calls');
  });
});

describe('paid verification — the body never asserts PAID it has not checked', () => {
  it('a tagged-identity count far above paying customers is labelled unverified', { timeout: 30_000 }, () => {
    const r = runCheck({ ...F2, verification: '40|7|0\n' });
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=FAIL`]);
    expect(r.res.fired[0]).toContain('paid-tagged (unverified)');
    expect(r.stdout).toContain('instrumentation_artifact=operator_dev_key');
  });

  it('an open dev-key prefix hatch makes the paid tag unverifiable', { timeout: 30_000 }, () => {
    const r = runCheck({ ...F2, devPrefix: 'true' });
    expect(r.res.fired[0]).toContain('paid-tagged (unverified)');
  });
});

describe('slices — non-paid traffic is reported, never paged', () => {
  it('a free-tier breach with a clean paid slice PASSES and pages nobody', { timeout: 30_000 }, () => {
    const r = runCheck({ ...F1, slices: 'free_or_other|9|145\ninternal|0|1087\npaid|0|2800\n' });
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=PASS`]);
    expect(r.res.fired).toEqual([]);
    expect(r.stdout).toMatch(/slice=free_or_other +verdict=FAIL .*pages=no/);
  });

  it('a clean paid slice below the floor is INDETERMINATE — a quiet day cannot earn a green', { timeout: 30_000 }, () => {
    const r = runCheck({ ...F1, slices: 'paid|0|1500\n' });
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=INDETERMINATE`]);
    expect(r.res).toMatchObject({ rc: 3, fired: [], cleared: 0 });
    expect(r.stdout).toContain('reason=below_floor');
  });

  it('no paid row at all is an empty population, not a pass', { timeout: 30_000 }, () => {
    const r = runCheck({ ...F1, slices: 'internal|0|1087\n' });
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=INDETERMINATE`]);
    expect(r.stdout).toContain('reason=empty_population');
  });

  it('an unreadable population is INDETERMINATE query_failed, never a pass', { timeout: 30_000 }, () => {
    const r = runCheck({ ...F1, slices: 'RAISE' });
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=INDETERMINATE`]);
    expect(r.res).toMatchObject({ rc: 3, fired: [], cleared: 0 });
    expect(r.stdout).toContain('reason=query_failed');
  });
});

describe('result line — the record comes back to the vault', () => {
  it('writes one canary_result_log record per run, naming the paged slices', { timeout: 30_000 }, () => {
    const r = runCheck(F2);
    expect(r.stdout).toMatch(/^CANARY_RESULT_LOG=ok line=1$/m);
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toMatchObject({ canary: 'regime_budget_starvation', verdict: 'FAIL', exit_code: 1 });
    expect(r.records[0].metrics.paged_slices).toEqual(['paid']);
    expect(r.records[0].metrics.slices.paid).toMatchObject({ num: 60, den: 1000 });
  });

  it('prints a positive CANARY_RESULT_LOG line on the INDETERMINATE path too', { timeout: 30_000 }, () => {
    const r = runCheck({ ...F1, slices: 'RAISE' });
    expect(r.stdout).toMatch(/^CANARY_RESULT_LOG=ok line=1$/m);
    expect(r.records[0]).toMatchObject({ verdict: 'INDETERMINATE', exit_code: 3 });
  });
});

describe('parity — no list is hand-typed twice', () => {
  let memo: { paid: string[]; events: string[]; wave: string; slice_sql: string } | null = null;
  const load = () => {
    if (memo) return memo;
    const code = [
      'import importlib.util, json',
      `spec = importlib.util.spec_from_file_location("c", ${JSON.stringify(CANARY)})`,
      'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
      'print(json.dumps({"paid": list(m.PAID_TIERS), "events": list(m.EVENT_VERDICTS),',
      '                  "wave": m.RECOMMENDED_WAVE, "slice_sql": m.slice_spec().group_by[0]}))',
    ].join('\n');
    const r = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`canary constants unreadable: ${r.stderr.slice(0, 300)}`);
    memo = JSON.parse(r.stdout) as { paid: string[]; events: string[]; wave: string; slice_sql: string };
    return memo;
  };

  it('the event set is exactly the two budget-attributable verdicts the TS vocabulary emits', { timeout: 30_000 }, () => {
    const ts = [
      regimeErrorVerdict(new UpstreamRateLimitError('Hyperliquid')),
      regimeSuccessVerdict(true),
    ].sort();
    expect([...load().events].sort()).toEqual(ts);
  });

  it('the paid set is the subscription rail plus the x402 rail, from the ONE tier→rail map', { timeout: 30_000 }, () => {
    const rail = [...SUBSCRIPTION_TIERS, ...X402_TIERS].sort();
    const plans = [...Object.keys(PLANS), ...X402_TIERS].sort();
    expect([...load().paid].sort()).toEqual(rail);
    expect([...load().paid].sort()).toEqual(plans);
    for (const t of load().paid) expect(Object.keys(PAYMENT_RAIL_BY_TIER)).toContain(t);
  });

  it('the slice SQL is built from that same constant', { timeout: 30_000 }, () => {
    for (const t of load().paid) expect(load().slice_sql).toContain(`'${t}'`);
  });

  it('the recommended wave is templated and is not the overridden one', { timeout: 30_000 }, () => {
    expect(load().wave).toMatch(/^OPS-[A-Z0-9-]+-W\{NEXT\}$/);
    expect(load().wave).not.toBe('OPS-HL-INTERACTIVE-STARVATION-W{NEXT}');
  });
});

describe('--self-test — the canary\'s own contract', () => {
  it('PASSES with exactly one token', { timeout: 30_000 }, () => {
    const r = spawnSync('python3', [CANARY, '--self-test'], { encoding: 'utf8' });
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=PASS`]);
    expect(r.status).toBe(0);
  });
});
