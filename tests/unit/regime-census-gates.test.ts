// EDGE-REGIME-CENSUS-W1 CH2 — the census's own gates, and proof that they can fail.
// AC2.2: the analyzer's hermetic self-test (lanes, one vote per caller, the next-tool window, shape mapping, every
// registered branch, INDETERMINATE on an empty or unparseable extract). AC2.2b: weighting by calls instead of callers
// turns the one-vote check red; restored, it is green. The pull script's self-test rides along.
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const analyze = (mutate: string): { status: number | null; stdout: string; stderr: string } => {
  const r = spawnSync('python3', ['-I', 'scripts/regime-census/census_analyze.py', '--self-test'], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, REGIME_CENSUS_MUTATE: mutate },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

describe('census analyzer — self-test (AC2.2) and mutation proof (AC2.2b)', () => {
  it('passes on the synthetic fixture', { timeout: 180_000 }, () => {
    const ok = analyze('');
    expect(ok.stdout).toContain('REGIME_CENSUS_SELFTEST_VERDICT=PASS');
    expect(ok.status).toBe(0);
  });

  it('weighting by calls instead of callers turns the one-vote check red', { timeout: 180_000 }, () => {
    const bad = analyze('call_weighting');
    expect(bad.stdout).toContain('REGIME_CENSUS_SELFTEST_VERDICT=FAIL');
    expect(bad.stderr).toMatch(/self-test FAIL: one vote: BTC share/);
    expect(bad.status).toBe(1);
  });

  it('dropping the docs-sample canary filter turns the bracket checks red', { timeout: 180_000 }, () => {
    const bad = analyze('no_canary_filter');
    expect(bad.stdout).toContain('REGIME_CENSUS_SELFTEST_VERDICT=FAIL');
    expect(bad.stderr).toMatch(/self-test FAIL: canary rows removed/);
    expect(bad.status).toBe(1);
  });
});

describe('census pull — self-test', () => {
  it('passes, offline', { timeout: 120_000 }, () => {
    const r = spawnSync('bash', ['scripts/regime-census/census-pull.sh', '--self-test'], { encoding: 'utf8', timeout: 90_000 });
    expect(r.stdout).toContain('REGIME_CENSUS_PULL_SELFTEST_VERDICT=PASS');
    expect(r.status).toBe(0);
  });
});
