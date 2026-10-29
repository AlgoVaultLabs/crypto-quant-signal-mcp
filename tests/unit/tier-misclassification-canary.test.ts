/**
 * OPS-ASSET-CLASS-TOTALITY-W1 CH3 — the daily two-way tier-misclassification canary's own self-test, run
 * in CI and the pre-push gate. The self-test drives the REAL wrapper script with a fake docker (the judge's
 * canned output) and the real canary_result_log + send_telegram.sh beside it, two-way and vacuity-guarded:
 * PASS pages nothing · FAIL pages once with venue + tag + action · a failed fetch / no token / stopped
 * container is INDETERMINATE and sends nothing · DRY_RUN sends and publishes nothing.
 * The judge's own verdict logic is pinned in tests/unit/asset-class-census.test.ts (evaluateTotality).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '..', '..', 'ops', 'monitoring', 'tier-misclassification-canary.sh');

describe('tier-misclassification-canary.sh --self-test', () => {
  // The self-test spawns ~16 bash runs of the wrapper (measured ~2.5 s alone); 60 s covers a loaded suite.
  it('passes, two-way, with its vacuity floor met', { timeout: 60_000 }, () => {
    let out = '';
    try {
      out = execFileSync('bash', [SCRIPT, '--self-test'], { encoding: 'utf8' });
    } catch (e) {
      out = (e as { stdout?: string }).stdout ?? String(e);
    }
    expect(out.match(/^SELF_TEST_VERDICT=\w+/m)?.[0], out.split('\n').filter((l) => l.includes('FAIL')).join('\n')).toBe('SELF_TEST_VERDICT=PASS');
    expect(Number(out.match(/SELF_TEST_VERDICT=PASS — (\d+) assertions/)?.[1])).toBeGreaterThanOrEqual(36);
  });
});
