/**
 * OPS-MONITOR-TRANSIENT-CLASSIFY-W1 — a transient / ambiguous read (HTTP 429,
 * ECONNRESET, 5xx, network/parse error) must NEVER be treated as a CONFIRMED
 * adverse state (dropped post / stuck queue) that pages on a single occurrence.
 *
 * Regressions under test (both fired 2026-07-24, both 🟡 warning noise):
 *   - monitor "Backfill queue check failed: read ECONNRESET" — a Postgres socket
 *     reset during a container force-recreate paged at consecutive=1 because
 *     FAIL_THRESHOLDS.backfill=1 has no transient gate. Self-healed next cycle.
 *   - forum self-audit "1 post silently dropped" — dev.to returned HTTP 429 on
 *     the verify GET (log: verified=2/3 drift=4223682:devto-http-429); a
 *     rate-limited probe was counted as a deleted post.
 *
 * This is the mandated 4th-instance GENERATOR fix (after exchanges-flap,
 * gas-wallet-quorum, pfe-no-retry): classify the failure ONCE and (a) floor a
 * transient monitor failure to >= TRANSIENT_MIN_CYCLES cycles, (b) never count a
 * transient verify failure as forum drift. A real breach (depth over threshold,
 * 404 / not-published) stays confirmed and pages per policy.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyProbeFailure,
  effectiveFailThreshold,
  shouldEscalateIndeterminate,
  TRANSIENT_MIN_CYCLES,
  INDETERMINATE_ESCALATE_STREAK,
} from '../../src/lib/probe-failure-class.js';

describe('classifyProbeFailure', () => {
  it('classifies the two 2026-07-24 false-page strings as transient', () => {
    expect(classifyProbeFailure('Backfill queue check failed: read ECONNRESET')).toBe('transient');
    expect(classifyProbeFailure('devto-http-429')).toBe('transient');
  });

  it('classifies network errno failures as transient', () => {
    for (const s of [
      'read ECONNRESET',
      'connect ECONNREFUSED 10.0.0.5:5432',
      'connect ETIMEDOUT',
      'getaddrinfo EAI_AGAIN dev.to',
      'getaddrinfo ENOTFOUND api.dev.to',
      'socket hang up',
      'Client network socket disconnected before secure TLS connection',
      'write EPIPE',
    ]) {
      expect(classifyProbeFailure(s), s).toBe('transient');
    }
  });

  it('classifies rate-limit / 5xx / auth-ambiguous HTTP as transient', () => {
    for (const s of [
      'devto-http-429', 'hashnode-http-429', 'moltbook-http-429',
      'devto-http-500', 'devto-http-502', 'devto-http-503', 'devto-http-504',
      'HTTP 408', 'http-425', 'devto-http-401', 'hashnode-http-403',
      'PFE check failed: performance-public HTTP 503 after 3 attempts',
    ]) {
      expect(classifyProbeFailure(s), s).toBe('transient');
    }
  });

  it('classifies pg pool / transport failures as transient (the zombie-connection + deploy-churn class)', () => {
    for (const s of [
      'Connection terminated unexpectedly',
      'Connection terminated due to connection timeout',
      'sorry, too many clients already',
      'terminating connection due to administrator command',
    ]) {
      expect(classifyProbeFailure(s), s).toBe('transient');
    }
  });

  it('classifies parse / generic-network wrapper reasons as transient (body received, unreadable ⇒ post exists)', () => {
    expect(classifyProbeFailure('devto-parse-error: Unexpected end of JSON input')).toBe('transient');
    expect(classifyProbeFailure('devto-network-error: fetch failed')).toBe('transient');
  });

  it('reads Error objects (message + errno .code + cause)', () => {
    const e = new Error('read ECONNRESET') as NodeJS.ErrnoException;
    e.code = 'ECONNRESET';
    expect(classifyProbeFailure(e)).toBe('transient');

    const timeout = new Error('The operation was aborted') as NodeJS.ErrnoException;
    timeout.code = 'ETIMEDOUT';
    expect(classifyProbeFailure(timeout)).toBe('transient');
  });

  it('classifies a CONFIRMED adverse state as confirmed (still pages per policy)', () => {
    for (const s of [
      'Backfill queue stuck: 60,000 pending (> 50,000)',
      'devto-not-published (type_of=null)',
      'devto-http-404',
      'devto-http-410',
      'moltbook-is_spam',
      'hashnode-is_deleted',
      'no-post-id',
      'no-article-id',
      'PFE win rate 41.2% below floor',
      'Gas wallet low: 0.001 ETH',
    ]) {
      expect(classifyProbeFailure(s), s).toBe('confirmed');
    }
  });

  it('does NOT mistake a 404 / 410 (the confirmed-drop signal) for a transient', () => {
    expect(classifyProbeFailure('devto-http-404')).toBe('confirmed');
    expect(classifyProbeFailure('hashnode-http-410')).toBe('confirmed');
  });

  it('defaults an empty / unknown reason to confirmed (never silently swallow a real breach)', () => {
    expect(classifyProbeFailure('')).toBe('confirmed');
    expect(classifyProbeFailure(null)).toBe('confirmed');
    expect(classifyProbeFailure(undefined)).toBe('confirmed');
    expect(classifyProbeFailure('some novel breach we have never seen')).toBe('confirmed');
  });
});

describe('effectiveFailThreshold', () => {
  it('floors a transient failure to TRANSIENT_MIN_CYCLES even when base threshold is 1', () => {
    // backfill / pfe_winrate ship threshold=1 (slow-signal first-cycle visibility)
    expect(effectiveFailThreshold(1, 'Backfill queue check failed: read ECONNRESET')).toBe(TRANSIENT_MIN_CYCLES);
    expect(TRANSIENT_MIN_CYCLES).toBeGreaterThanOrEqual(2);
  });

  it('keeps a confirmed breach at its configured threshold (first-cycle page preserved)', () => {
    expect(effectiveFailThreshold(1, 'Backfill queue stuck: 60,000 pending (> 50,000)')).toBe(1);
  });

  it('never LOWERS a threshold already above the transient floor', () => {
    expect(effectiveFailThreshold(3, 'exchanges: read ECONNRESET')).toBe(3);
  });

  it('passes null / absent error straight through (no failure this cycle)', () => {
    expect(effectiveFailThreshold(1, null)).toBe(1);
    expect(effectiveFailThreshold(2, undefined)).toBe(2);
  });
});

describe('shouldEscalateIndeterminate', () => {
  it('does not escalate below the streak', () => {
    expect(shouldEscalateIndeterminate(1)).toBe(false);
    expect(shouldEscalateIndeterminate(INDETERMINATE_ESCALATE_STREAK - 1)).toBe(false);
  });

  it('escalates at / above the streak (sustained ⇒ honest "could not verify" alert)', () => {
    expect(shouldEscalateIndeterminate(INDETERMINATE_ESCALATE_STREAK)).toBe(true);
    expect(shouldEscalateIndeterminate(INDETERMINATE_ESCALATE_STREAK + 5)).toBe(true);
  });
});
