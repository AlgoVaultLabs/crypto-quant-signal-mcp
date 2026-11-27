/**
 * owed-read-regime-15m-sampler-trigger.test.ts — REGIME-15M-SERVE-W1 CH3(b) (ARC-REGIME-15M T6).
 *
 * The owed read that pages Mr.1 the first hour 15m snapshot demand is real (G2: 15m snapshots are his decision,
 * taken from data). Its contract, proved here end to end:
 *   - its own self-test passes against its declared floor, judged by its token, never its exit code;
 *   - the self-test CAN fail: a copy with the threshold broken (5 → 6, and `>=` → `>`) turns red on a named
 *     behavioural check (verification-gates: prove the self-test can fail);
 *   - the registry row validates under the runner's OWN schema check (`--validate`);
 *   - through the REAL runner (`--sandbox`, a stub `docker` on PATH printing a canned bundle): PENDING records
 *     INDETERMINATE and pages nothing; FIRED records FAIL, writes the terminal marker and pages OWED_READ_FAIL
 *     keyed by the read id; a database that cannot be read records INDETERMINATE — never a parse error.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = 'ops/monitoring/owed-read-regime-15m-sampler-trigger.py';
const RUNNER = 'ops/monitoring/owed-read-runner.py';
const READ_ID = 'regime-15m-sampler-trigger';
const WAVE = 'REGIME-15M-SERVE-W1';
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** A clock for the hermetic runs: since = 2026-11-28T10:00Z, not_before one hour later, expiry 30 days on. */
const SINCE = 1_795_860_000;
const NOT_BEFORE = SINCE + 3600;
const iso = (s: number) => new Date(s * 1000).toISOString().replace('.000Z', 'Z');

/** The canonical registry row (Q4): not_before after the deploy, expires_at = not_before + 30 d, anchors.since. */
const canonicalRow = (notBefore: number, since: number) => ({
  id: READ_ID,
  wave: WAVE,
  not_before: iso(notBefore),
  expires_at: iso(notBefore + 30 * 86400),
  script: 'owed-read-regime-15m-sampler-trigger.py',
  timeout_s: 300,
  anchors: { since, callers_min: 5 },
  criteria:
    'FIRED — 15m snapshot demand met; Mr.1 decides 15m snapshots (G2). Bar: >= 5 distinct external callers of get_market_regime at 15m (request_log, census caller identity), or 15m refusals on scan_market_regimes/pre_trade_check from >= 5 caller_keys. PENDING retries hourly; expiry = NOT_FIRED.',
});

const selfTest = (script: string) => spawnSync('python3', [script, '--self-test'], { cwd: ROOT, encoding: 'utf8', timeout: 50_000 });
const tokensOf = (out: string) => out.split('\n').filter((l) => l.startsWith('SELF_TEST_VERDICT='));

describe('the read\'s self-test — judged by its token, counted against its own floor', () => {
  it('passes every check it declares', { timeout: 60_000 }, () => {
    const floor = Number(read(SCRIPT).match(/^_SELF_TEST_MIN_CHECKS = (\d+)$/m)?.[1]);
    expect(floor).toBeGreaterThan(0);
    const r = selfTest(join(ROOT, SCRIPT));
    const tokens = tokensOf(r.stdout ?? '');
    expect(tokens, `${r.stdout}\n${r.stderr}`.slice(-3000)).toHaveLength(1);
    expect(Number(tokens[0].match(/^SELF_TEST_VERDICT=PASS — (\d+) checks /)?.[1])).toBe(floor);
    expect(r.status).toBe(0);
  });
});

describe('the self-test can fail — break the threshold, see red', () => {
  const mutate = (from: RegExp, to: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'r15-trigger-mut-'));
    const src = read(SCRIPT);
    expect(src, `mutation anchor ${from} not found`).toMatch(from);
    const out = join(dir, 'owed-read-regime-15m-sampler-trigger.py');
    writeFileSync(out, src.replace(from, to));
    return out;
  };

  it('CALLERS_MIN 5 → 6: the FIRED-at-5 fixtures go red', { timeout: 60_000 }, () => {
    const r = selfTest(mutate(/^CALLERS_MIN = 5$/m, 'CALLERS_MIN = 6'));
    expect(tokensOf(r.stdout ?? '')).toHaveLength(1);
    expect(tokensOf(r.stdout ?? '')[0]).toMatch(/^SELF_TEST_VERDICT=FAIL/);
    expect(r.stdout).toMatch(/\[FAIL\] FIRED via request_log/);
    expect(r.stdout).toMatch(/\[FAIL\] FIRED via refusal_counts/);
    expect(r.status).toBe(1);
  });

  it('`>= CALLERS_MIN` → `> CALLERS_MIN`: exactly-at-the-bar no longer fires, and the self-test says so', { timeout: 60_000 }, () => {
    const r = selfTest(mutate(/if n >= CALLERS_MIN\]/, 'if n > CALLERS_MIN]'));
    expect(tokensOf(r.stdout ?? '')[0]).toMatch(/^SELF_TEST_VERDICT=FAIL/);
    expect(r.stdout).toMatch(/\[FAIL\] FIRED via request_log/);
    expect(r.status).toBe(1);
  });
});

describe('the registry row — the runner\'s own schema check', () => {
  it('a canonical row validates (`--validate`, script present beside the runner)', { timeout: 60_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'r15-trigger-reg-'));
    const reg = join(dir, 'owed-reads.json');
    writeFileSync(reg, JSON.stringify({ schema_version: 1, reads: [canonicalRow(NOT_BEFORE, SINCE)] }, null, 2));
    const r = spawnSync('python3', [RUNNER, '--validate'], { cwd: ROOT, encoding: 'utf8', timeout: 50_000, env: { ...process.env, OWED_READ_REGISTRY: reg } });
    expect(r.stdout, r.stderr).toContain(`OWED_READ_REGISTRY row=${READ_ID} OK`);
    expect(r.stdout).toContain('OWED_READ_REGISTRY_VERDICT=PASS');
    expect(r.status).toBe(0);
  });

  it('the criteria line names the decision and fits the runner\'s 400 chars; the timeout exceeds the read\'s own psql bound', () => {
    const row = canonicalRow(NOT_BEFORE, SINCE);
    expect(row.criteria.startsWith('FIRED — 15m snapshot demand met; Mr.1 decides 15m snapshots (G2)')).toBe(true);
    expect(row.criteria.length).toBeLessThanOrEqual(400);
    const psqlTimeout = Number(read(SCRIPT).match(/^PSQL_TIMEOUT_S = (\d+)$/m)?.[1]);
    expect(psqlTimeout).toBeGreaterThan(0);
    expect(row.timeout_s).toBeGreaterThan(psqlTimeout);
    expect(row.timeout_s).toBeLessThanOrEqual(1800);
  });
});

describe('through the real runner (--sandbox), a stub `docker` printing the database\'s answer', () => {
  type Rec = { verdict: string; exit_code: number; metrics: Record<string, unknown> };
  /** The read's bundle as psql would print it: one read-only snapshot, two sections, MARK|end. */
  const bundle = (rl: [number, number, number], rc: [number, number, number, number]) =>
    ['MARK|ro|on|aoe_readonly', 'MARK|sec|request_log', rl.join('|'), 'MARK|sec|refusal_counts', rc.join('|'), 'MARK|end', ''].join('\n');

  const tickWith = (stub: { stdout?: string; rc?: number }) => {
    const dir = mkdtempSync(join(tmpdir(), 'r15-trigger-run-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(dir, 'answer.txt'), stub.stdout ?? '');
    writeFileSync(join(bin, 'docker'), `#!/bin/sh\ncat > /dev/null\ncat "${join(dir, 'answer.txt')}"\n${stub.rc ? `echo "stub: no database" >&2\nexit ${stub.rc}\n` : 'exit 0\n'}`);
    chmodSync(join(bin, 'docker'), 0o755);
    const reg = join(dir, 'owed-reads.json');
    writeFileSync(reg, JSON.stringify({ schema_version: 1, reads: [canonicalRow(NOT_BEFORE, SINCE)] }));
    const box = join(dir, 'box');
    const r = spawnSync('python3', [RUNNER, '--sandbox', box, '--now', String(NOT_BEFORE + 600), '--only', READ_ID, '--registry', reg], {
      cwd: ROOT, encoding: 'utf8', timeout: 50_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    const results = join(box, 'canary-results.jsonl');
    const recs: Rec[] = existsSync(results) ? readFileSync(results, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const calls = existsSync(join(box, 'wrapper-calls.log')) ? readFileSync(join(box, 'wrapper-calls.log'), 'utf8') : '';
    return { r, recs, calls, marker: existsSync(join(box, 'owed-reads', `${READ_ID}.json`)) };
  };

  it('PENDING (4 external callers, 4 caller_keys): INDETERMINATE recorded, no marker, nothing paged', { timeout: 60_000 }, () => {
    const t = tickWith({ stdout: bundle([4, 9, 12], [4, 3, 2, 17]) });
    expect(t.recs, `${t.r.stdout}\n${t.r.stderr}`).toHaveLength(1);
    expect(t.recs[0].verdict).toBe('INDETERMINATE');
    expect(t.recs[0].metrics.trigger).toBe('PENDING');
    expect(t.recs[0].metrics).not.toHaveProperty('runner_reason');
    expect(t.marker).toBe(false);
    expect(t.calls).not.toContain('OWED_READ_FAIL CRITICAL_PERSISTENT');
  });

  it('FIRED (5 external callers): FAIL recorded, terminal marker written, OWED_READ_FAIL paged under the read id', { timeout: 60_000 }, () => {
    const t = tickWith({ stdout: bundle([5, 0, 7], [1, 1, 0, 1]) });
    expect(t.recs, `${t.r.stdout}\n${t.r.stderr}`).toHaveLength(1);
    expect(t.recs[0].verdict).toBe('FAIL');
    expect(t.recs[0].metrics.trigger).toBe('FIRED');
    expect(t.recs[0].metrics.fired_by).toEqual(['request_log']);
    expect(t.marker).toBe(true);
    expect(t.calls).toContain('OWED_READ_FAIL CRITICAL_PERSISTENT');
    expect(t.calls).toContain(`ALERT_KEYS=${READ_ID}`);
  });

  it('a database that cannot be read: INDETERMINATE with the read\'s cause, never a parse error', { timeout: 60_000 }, () => {
    const t = tickWith({ rc: 1 });
    expect(t.recs, `${t.r.stdout}\n${t.r.stderr}`).toHaveLength(1);
    expect(t.recs[0].verdict).toBe('INDETERMINATE');
    expect(t.recs[0].metrics.trigger).toBe('INDETERMINATE');
    expect(String(t.recs[0].metrics.reason)).toMatch(/^psql rc=1/);
    expect(t.recs[0].metrics).not.toHaveProperty('runner_reason');
    expect(t.marker).toBe(false);
  });
});

describe('the read stays a read', () => {
  it('is named under the runner\'s grammar, and the SQL it sends is one read-only snapshot with no write verb', { timeout: 60_000 }, () => {
    expect(SCRIPT.split('/').pop()).toMatch(/^owed-read-[a-z0-9-]+\.py$/);
    // the bundle exactly as the read builds it (imported, not grepped from source: the self-test names the verbs)
    const py = "import importlib.util as u, sys; s = u.spec_from_file_location('r', sys.argv[1]); m = u.module_from_spec(s); "
      + 's.loader.exec_module(m); print(m.PSQL_CMD); print(m.build_bundle(m.SINCE_FLOOR_S, m.SINCE_FLOOR_S + 86400))';
    const r = spawnSync('python3', ['-I', '-c', py, join(ROOT, SCRIPT)], { encoding: 'utf8', timeout: 50_000 });
    expect(r.status, r.stderr).toBe(0);
    const [cmd, ...sql] = r.stdout.split('\n');
    expect(cmd).toContain('-U aoe_readonly');
    const bundle = sql.join('\n');
    expect(bundle.match(/BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;/g)).toHaveLength(1);
    expect(bundle).toContain('COMMIT;');
    expect(bundle.toUpperCase()).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|GRANT|COPY)\b/);
  });
});
