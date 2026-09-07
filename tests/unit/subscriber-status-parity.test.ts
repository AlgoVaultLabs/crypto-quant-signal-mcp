import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { STORED_STATUS_CLASS, STRIPE_SUBSCRIPTION_STATUSES } from '../../src/lib/subscriber-status.js';

/**
 * CROSS-LANGUAGE PARITY. OPS-SUBSCRIBER-STATUS-SOT-W1.
 *
 * `subscriber_profiles.status` is classified TWICE — by `src/lib/subscriber-status.ts` for every
 * TypeScript consumer, and by `ops/monitoring/payment-decline-canary.py` for the host canary
 * whose ABSOLUTE FLOOR reads the column. A JS gate cannot import a Python module, so the estate's
 * answer is one corpus fed to both sides with byte-identical output demanded — the same shape
 * `monitoring-schedule-boundary.test.ts` uses for `--classify-schedule`.
 *
 * 🛑 THIS EXECUTES THE PYTHON, IT DOES NOT PARSE IT. Reading the constants out of the source with
 * a regex would pass against a file whose printer had been deleted, and would test the test's own
 * transcription rather than the code the host actually runs.
 */

/** The 4-bucket partition, derived from the map PRODUCTION reads — not from a test-only export. */
function tsVocabulary(): Record<string, string[]> {
  const out: Record<string, string[]> = { HEALTHY: [], MONEY_STUCK: [], NOT_STARTED: [], ENDED: [] };
  for (const s of STRIPE_SUBSCRIPTION_STATUSES) out[STORED_STATUS_CLASS[s]].push(s);
  for (const k of Object.keys(out)) out[k].sort();
  return out;
}

const REPO = join(__dirname, '..', '..');
const CANARY = join(REPO, 'ops', 'monitoring', 'payment-decline-canary.py');

function canaryVocabulary(): Record<string, string[]> {
  const out = execFileSync('python3', [CANARY, '--status-vocabulary'], { encoding: 'utf8' });
  return JSON.parse(out);
}

describe('subscriber-status ⇄ payment-decline-canary parity', () => {
  it('🛑 the two implementations agree on the WHOLE partition, bucket for bucket', { timeout: 20_000 }, () => {
    expect(canaryVocabulary()).toEqual(tsVocabulary());
  });

  it('…and the shared partition is exactly Stripe’s documented enum', { timeout: 20_000 }, () => {
    const flat = Object.values(canaryVocabulary()).flat().sort();
    expect(flat).toEqual([
      'active', 'canceled', 'incomplete', 'incomplete_expired', 'past_due', 'paused', 'trialing', 'unpaid',
    ]);
  });

  it('`unpaid` is MONEY_STUCK on BOTH sides — the divergence is shared, not local', { timeout: 20_000 }, () => {
    // If a future wave "de-duplicates" either side against SUBSCRIPTION_STATUS_CLASS, `unpaid`
    // silently leaves the stuck set on that side only, and this comparison is what catches it.
    expect(canaryVocabulary().MONEY_STUCK).toContain('unpaid');
    expect(tsVocabulary().MONEY_STUCK).toContain('unpaid');
  });

  it('the python seam emits ONE json object and nothing else on stdout', { timeout: 20_000 }, () => {
    const out = execFileSync('python3', [CANARY, '--status-vocabulary'], { encoding: 'utf8' });
    expect(out.trim().split('\n')).toHaveLength(1);
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it('the canary’s own self-test still passes and still emits exactly one verdict token', { timeout: 30_000 }, () => {
    // A parity test that only compared vocabularies would stay green while the canary's suite
    // rotted. Its terminal-token contract is what every caller in the estate gates on.
    let out = '';
    try {
      out = execFileSync('python3', [CANARY, '--self-test'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e: any) {
      out = String(e.stdout ?? '');
      throw new Error(`canary self-test failed:\n${out}\n${String(e.stderr ?? '')}`);
    }
    const tokens = out.split('\n').filter((l) => l.startsWith('PAYMENT_DECLINE_VERDICT='));
    expect(tokens).toEqual(['PAYMENT_DECLINE_VERDICT=PASS']);
  });
});
