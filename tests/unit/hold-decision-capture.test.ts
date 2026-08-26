/**
 * hold-decision-capture.test.ts — OPS-HOLD-DECISION-CAPTURE-W1 R1/R2/R4.
 *
 * Three things are under test, and only the first is ordinary unit testing:
 *
 *  1. the pure capture logic (side derivation, arm allowlist, runaway cap);
 *  2. THE SEAM IS READ. `license.ts` carries a tombstone for `setRequestVerdict`, deleted for
 *     being a write-only seam with "one writer, ZERO readers, no test". The architect made a live
 *     reader plus a test that fails if the read stops happening a CONDITION of re-introducing the
 *     pattern. That is the `logRequest` block below, and it is the reason this file exists at
 *     all rather than just a couple of `Math.sign` assertions;
 *  3. QUARANTINE. HOLD labels are counterfactual and must never reach `directional_labels`. The
 *     structural half of that guarantee is a source-level assertion, because the runtime half
 *     (the FK) only exists on a database that has run migration 032.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  wouldBeSideFromRawScore,
  resolveCaptureArm,
  admitFleetCapture,
  fleetDailyCap,
  captureEnabled,
  _resetFleetCapForTest,
} from '../../src/lib/hold-decision-capture.js';
import {
  requestContext,
  setRequestHoldCapture,
  getRequestHoldCapture,
} from '../../src/lib/license.js';

const REPO = join(import.meta.dirname, '../..');
const src = (p: string) => readFileSync(join(REPO, p), 'utf8');

describe('wouldBeSideFromRawScore — the sign Math.abs() destroys', () => {
  it('maps a positive post-adjustment score to BUY and a negative one to SELL', () => {
    expect(wouldBeSideFromRawScore(41)).toBe(1);
    expect(wouldBeSideFromRawScore(-56)).toBe(-1);
    // Below-threshold scores are the whole point: these are the HOLDs, and they still have a side.
    expect(wouldBeSideFromRawScore(12)).toBe(1);
    expect(wouldBeSideFromRawScore(-3)).toBe(-1);
  });

  it('returns 0 for an exactly-zero score rather than inventing a direction', () => {
    expect(wouldBeSideFromRawScore(0)).toBe(0);
  });

  it('normalises negative zero — Math.sign(-0) is -0, which is not a valid CHECK value', () => {
    // `-0` would be stored as 0 by PG anyway, but `Object.is(-0, 0)` is false and any JS
    // consumer doing `=== 0` after a round trip through JSON would see it differently.
    expect(Object.is(wouldBeSideFromRawScore(-0), 0)).toBe(true);
  });

  it('returns 0 for a non-finite score instead of propagating NaN into a NOT NULL column', () => {
    expect(wouldBeSideFromRawScore(NaN)).toBe(0);
    expect(wouldBeSideFromRawScore(Infinity)).toBe(0);
  });
});

describe('resolveCaptureArm — the fail-safe direction is the point', () => {
  it('recognises the two request-path callers', () => {
    expect(resolveCaptureArm('get_trade_call')).toBe('request');
    expect(resolveCaptureArm('get_trade_signal')).toBe('request');
  });

  it("routes seed-signals' untagged runAsBatch ('unknown') to the fleet arm", () => {
    expect(resolveCaptureArm('unknown')).toBe('fleet');
    expect(resolveCaptureArm(undefined)).toBe('fleet');
  });

  it('defaults an UNRECOGNISED caller to fleet, so a new call site cannot blow the unsampled arm', () => {
    // This is the whole reason it is an allowlist. A denylist would classify a future caller as
    // 'request' — the arm with no DB-side quota — and the first anyone would know is the table
    // growing at the firehose rate.
    expect(resolveCaptureArm('some_future_tool')).toBe('fleet');
    expect(resolveCaptureArm('')).toBe('fleet');
  });
});

describe('admitFleetCapture — runaway guard, and it must not be silent', () => {
  const DAY0 = 1_756_166_400; // 2026-08-26T00:00:00Z
  beforeEach(() => _resetFleetCapForTest());

  it('admits up to the cap and then drops', () => {
    expect(admitFleetCapture(DAY0, 3)).toBe(true);
    expect(admitFleetCapture(DAY0, 3)).toBe(true);
    expect(admitFleetCapture(DAY0, 3)).toBe(true);
    expect(admitFleetCapture(DAY0, 3)).toBe(false);
  });

  it('resets on the UTC day boundary', () => {
    expect(admitFleetCapture(DAY0, 1)).toBe(true);
    expect(admitFleetCapture(DAY0, 1)).toBe(false);
    expect(admitFleetCapture(DAY0 + 86_400, 1)).toBe(true);
  });

  it('LOGS when it truncates — a capture path that drops rows silently reads downstream as "no HOLDs here"', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    admitFleetCapture(DAY0, 1);
    admitFleetCapture(DAY0, 1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('fleet daily cap');
    // ...but only once per day, or the log becomes the runaway.
    admitFleetCapture(DAY0, 1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('defaults the cap to 20000 and honours a valid override, rejecting junk', () => {
    expect(fleetDailyCap({} as NodeJS.ProcessEnv)).toBe(20_000);
    expect(fleetDailyCap({ HOLD_CAPTURE_FLEET_DAILY_CAP: '500' } as NodeJS.ProcessEnv)).toBe(500);
    expect(fleetDailyCap({ HOLD_CAPTURE_FLEET_DAILY_CAP: 'nonsense' } as NodeJS.ProcessEnv)).toBe(20_000);
    expect(fleetDailyCap({ HOLD_CAPTURE_FLEET_DAILY_CAP: '-1' } as NodeJS.ProcessEnv)).toBe(20_000);
  });
});

describe('captureEnabled — the no-rebuild kill switch', () => {
  it('is ON by default and OFF only for an explicit 0/false', () => {
    expect(captureEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(captureEnabled({ HOLD_DECISION_CAPTURE_ENABLED: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(captureEnabled({ HOLD_DECISION_CAPTURE_ENABLED: '0' } as NodeJS.ProcessEnv)).toBe(false);
    expect(captureEnabled({ HOLD_DECISION_CAPTURE_ENABLED: 'false' } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('the ALS seam round-trips inside a request context', () => {
  it('stamps and reads back the four fields', () => {
    requestContext.run(
      { license: { tier: 'free', key: null, outcome: 'ABSENT' } } as never,
      () => {
        expect(getRequestHoldCapture()).toBeUndefined();
        setRequestHoldCapture({ wouldBeSide: -1, exchange: 'BINANCE', regime: 'RANGING', priceAtDecision: 42.5 });
        expect(getRequestHoldCapture()).toEqual({
          wouldBeSide: -1, exchange: 'BINANCE', regime: 'RANGING', priceAtDecision: 42.5,
        });
      },
    );
  });

  it('is a no-op outside a request context (stdio / fleet) rather than throwing', () => {
    expect(() => setRequestHoldCapture({ wouldBeSide: 1, exchange: null, regime: null, priceAtDecision: 1 })).not.toThrow();
    expect(getRequestHoldCapture()).toBeUndefined();
  });
});

/**
 * THE CONDITION THE ARCHITECT ATTACHED TO R-iv.
 *
 * `license.ts:119-128` is a tombstone: `setRequestVerdict`/`getRequestVerdict` were deleted for
 * being a write-only seam — "one writer (index.ts), ZERO readers, no test" — and the docstring
 * explains that a write-only seam is worse than no seam because it still looks authoritative.
 *
 * Re-introducing the pattern was approved on condition that a real reader ships with a test that
 * fails if the read stops happening. These assertions ARE that test. They are source-level rather
 * than behavioural on purpose: the failure mode is a future wave quietly deleting the read while
 * leaving the setter standing, and no runtime assertion on a NULL column can distinguish that
 * from "this request was not a HOLD".
 */
describe('the seam has a live reader (R-iv condition — see the setRequestVerdict tombstone)', () => {
  it('logRequest reads the ALS stamp', () => {
    const analytics = src('src/lib/analytics.ts');
    expect(analytics).toContain('getRequestHoldCapture');
    expect(analytics).toMatch(/entry\.holdCapture\s*\?\?\s*getRequestHoldCapture\(\)/);
  });

  it('logRequest writes all four columns into request_log', () => {
    const analytics = src('src/lib/analytics.ts');
    for (const col of ['would_be_side', 'exchange', 'regime', 'price_at_decision']) {
      expect(analytics).toContain(col);
    }
    expect(analytics).toMatch(/hold\?\.wouldBeSide\s*\?\?\s*null/);
    expect(analytics).toMatch(/hold\?\.priceAtDecision\s*\?\?\s*null/);
  });

  it('the INSERT column count still matches its placeholder count', () => {
    // The four columns were appended to a 14-column INSERT. Getting this wrong is a runtime-only
    // failure on a fail-open path — it would be swallowed by logRequest's own catch and lose
    // EVERY request_log row, silently, which is exactly the class this assertion is cheap against.
    const analytics = src('src/lib/analytics.ts');
    const m = analytics.match(/INSERT INTO request_log \(([^)]+)\)\s*\n\s*VALUES \(([^)]+)\)/);
    expect(m, 'the request_log INSERT should still be findable').toBeTruthy();
    const cols = m![1].split(',').length;
    const placeholders = m![2].split(',').length;
    expect(cols).toBe(18);
    expect(placeholders).toBe(18);
  });

  it('the capture site stamps the seam', () => {
    expect(src('src/tools/get-trade-call.ts')).toContain('setRequestHoldCapture');
  });
});

/**
 * QUARANTINE — the one unrecoverable failure mode.
 *
 * `directional_labels` is the corpus behind the DWR baseline and, downstream, the published track
 * record. A counterfactual HOLD row landing there would corrupt a Merkle-anchored public number.
 *
 * The hazard is specifically SILENT: `request_log.id` (max ~355k) and `signals.id` (max ~512k)
 * numerically overlap, so a HOLD row carrying either id into `directional_labels.signal_id` joins
 * cleanly to an unrelated acted signal — no constraint violation, no error, no symptom.
 */
describe('quarantine — HOLD labels can never reach the published corpus', () => {
  /**
   * Strip `--` comments before asserting on SQL.
   *
   * The first draft of these assertions did not, and BOTH of them failed on their own
   * explanation: the comment `-- NEVER \`signal_id\`` tripped the no-signal_id check, and
   * `-- ...fail loudly at INSERT...` tripped the no-DML check. A ban-line matching its own
   * literal is the standard false-positive shape for this class of guard, and the fix belongs
   * here rather than in the prose — the comments are the most useful part of that file.
   */
  const sqlOnly = (path: string) =>
    src(path)
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n');

  it('the HOLD label table keys on hold_decision_id and never on signal_id', () => {
    const mig = sqlOnly('migrations/032_hold_decision_capture.sql');
    const labelTable = mig.slice(mig.indexOf('CREATE TABLE IF NOT EXISTS hold_decision_labels'));
    expect(labelTable).toContain('hold_decision_id');
    expect(labelTable).not.toMatch(/\bsignal_id\b/);
    // The FK is what turns a wrong id from a silent bad join into a loud INSERT failure.
    expect(labelTable).toContain('REFERENCES hold_decisions(decision_id)');
  });

  it('the migration never writes to directional_labels, signals, or any published aggregate', () => {
    // Anchored to statement start: `ON DELETE CASCADE` is a constraint clause, not a DML verb,
    // and an unanchored /\bDELETE\b/ flags the very FK that enforces the quarantine.
    const statements = sqlOnly('migrations/032_hold_decision_capture.sql');
    expect(statements).not.toMatch(/^\s*(INSERT|UPDATE|DELETE)\b/im);
    expect(statements).not.toMatch(/ALTER TABLE\s+(directional_labels|signals|hold_counts)/i);
  });

  it('no source file writes a HOLD row into directional_labels', () => {
    // The labeler for the acted corpus is allowed to write there; the HOLD labeler is not.
    const holdLabeler = src('src/scripts/backfill-hold-decision-labels.ts');
    expect(holdLabeler).not.toMatch(/INSERT INTO directional_labels/i);
    expect(holdLabeler).toMatch(/INSERT INTO hold_decision_labels/i);
    // ...and it must not UPDATE the acted corpus either.
    expect(holdLabeler).not.toMatch(/UPDATE\s+(directional_labels|signals)\b/i);
  });

  it('the published DWR report still reads only signals-backed labels', () => {
    // buildReport's queries JOIN directional_labels -> signals. If a future wave pointed any of
    // them at hold_decision_labels, the published number would silently absorb counterfactuals.
    const report = src('src/scripts/dwr-baseline-report.ts')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//'))
      .join('\n');
    expect(report).not.toMatch(/hold_decision_labels|hold_decisions/i);
  });
});

describe('capture cannot change what a caller receives', () => {
  it('the capture block is wrapped so a throw cannot escape into the response path', () => {
    const s = src('src/tools/get-trade-call.ts');
    const block = s.slice(s.indexOf('OPS-HOLD-DECISION-CAPTURE-W1 R1 — the capture seam'));
    const upTo = block.slice(0, block.indexOf('return result;'));
    expect(upTo).toContain('try {');
    expect(upTo).toContain('hold-decision capture failed:');
  });

  it('adds no await to the request path — recordHoldDecision returns void, synchronously', () => {
    const capture = src('src/lib/hold-decision-capture.ts');
    expect(capture).toMatch(/export function recordHoldDecision\([^)]*\): void/);
    const s = src('src/tools/get-trade-call.ts');
    expect(s).not.toMatch(/await\s+recordHoldDecision/);
    expect(s).not.toMatch(/await\s+setRequestHoldCapture/);
  });

  it('does not add a field to the response type', () => {
    // The would-be side is threaded out through the ALS precisely so TradeCallResult is untouched.
    const types = src('src/types.ts');
    expect(types).not.toMatch(/would_be_side|wouldBeSide|price_at_decision/);
  });

  it('hold-decision-capture has ZERO static value imports (the init-cycle constraint)', () => {
    const capture = src('src/lib/hold-decision-capture.ts');
    const staticImports = capture
      .split('\n')
      .filter((l) => /^import\s/.test(l) && !/^import type\s/.test(l));
    expect(staticImports).toEqual([]);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
