/**
 * OPS-HL-INTERACTIVE-STARVATION-W1 CH1 — `get_market_regime` request observability.
 *
 * WHAT THIS SUITE DEFENDS, and why each assertion earns its place:
 *
 *  1. The verdict vocabulary is THREE-valued. Collapsing the middle state (`DEGRADED_FUNDING_BUDGET`)
 *     into either neighbour re-creates the defect: folded into OK it is the silent degradation that
 *     ran unobserved from 2026-07-07; folded into the error state it overstates hard failures and
 *     makes the CH2 fix unprovable.
 *
 *  2. The `regimeFundingDegraded` ALS pair has a LIVE READER. `license.ts` carries a tombstone for a
 *     previously-deleted write-only seam, and the architect made "a live reader plus a test that
 *     fails if the read stops" a condition of adding another. That is asserted against the real
 *     `src/index.ts` source, not a fixture, because a fixture cannot notice the reader being removed.
 *
 *  3. THE ERROR ARM IS LOGGED. This is the whole wave in one assertion. Before it, `logRequest` sat
 *     inside the `try` after the awaited call and the `catch` returned without logging, so a refused
 *     call wrote no `request_log` row and the failure rate was 0.0% BY CONSTRUCTION. A test that only
 *     checked `verdict` was populated would have passed against that broken state.
 *
 *  4. `logRequest`'s new explicit `regime`/`exchange` fields do NOT disturb `get_trade_call`, whose
 *     rows must stay byte-identical — they share the two columns with `holdCapture`, and routing a
 *     regime row through `holdCapture` would silently enrol it in the hold-decision population.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REGIME_VERDICT_OK,
  REGIME_VERDICT_DEGRADED_FUNDING,
  REGIME_VERDICT_ERROR_PREFIX,
  REGIME_VERDICT_ERROR_UNKNOWN,
  regimeSuccessVerdict,
  regimeErrorVerdict,
  isRegimeErrorVerdict,
} from '../../src/lib/regime-request-verdict.js';
import { UpstreamRateLimitError } from '../../src/lib/errors.js';
import { requestContext, setRequestRegimeFundingDegraded, getRequestRegimeFundingDegraded } from '../../src/lib/license.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (p: string) => readFileSync(join(REPO, p), 'utf8');

describe('regime verdict vocabulary — three states, and the middle one is the point', () => {
  it('maps a clean call to OK and an observed funding refusal to DEGRADED_FUNDING_BUDGET', () => {
    expect(regimeSuccessVerdict(false)).toBe(REGIME_VERDICT_OK);
    expect(regimeSuccessVerdict(true)).toBe(REGIME_VERDICT_DEGRADED_FUNDING);
  });

  it('keeps the three states mutually distinct — a collapse here is the defect returning', () => {
    const all = [
      regimeSuccessVerdict(false),
      regimeSuccessVerdict(true),
      regimeErrorVerdict(new UpstreamRateLimitError('Hyperliquid')),
    ];
    expect(new Set(all).size).toBe(3);
  });

  it("carries the error's stable machine code, which is what the caller pattern-matches on", () => {
    // errors.ts pins `code = 'UPSTREAM_RATE_LIMIT'` precisely because clients match on it, so the
    // stored token must track that contract rather than the human-readable message.
    expect(regimeErrorVerdict(new UpstreamRateLimitError('Hyperliquid'))).toBe(
      `${REGIME_VERDICT_ERROR_PREFIX}UPSTREAM_RATE_LIMIT`,
    );
  });

  it('never throws on the error path, whatever it is handed', () => {
    // This runs in a catch block. A throw here loses the row and restores the blind spot.
    for (const junk of [null, undefined, 'a string', 42, {}, { code: 123 }, { code: '' }, new Error('plain')]) {
      expect(() => regimeErrorVerdict(junk)).not.toThrow();
      expect(regimeErrorVerdict(junk)).toBe(`${REGIME_VERDICT_ERROR_PREFIX}${REGIME_VERDICT_ERROR_UNKNOWN}`);
    }
  });

  it('rejects an absurdly long code rather than writing it into a TEXT column', () => {
    expect(regimeErrorVerdict({ code: 'X'.repeat(65) })).toBe(
      `${REGIME_VERDICT_ERROR_PREFIX}${REGIME_VERDICT_ERROR_UNKNOWN}`,
    );
  });

  it('isRegimeErrorVerdict separates the error arm from both success states', () => {
    expect(isRegimeErrorVerdict(regimeErrorVerdict(new UpstreamRateLimitError('Hyperliquid')))).toBe(true);
    expect(isRegimeErrorVerdict(REGIME_VERDICT_OK)).toBe(false);
    expect(isRegimeErrorVerdict(REGIME_VERDICT_DEGRADED_FUNDING)).toBe(false);
    expect(isRegimeErrorVerdict(null)).toBe(false);
  });
});

describe('regimeFundingDegraded ALS seam', () => {
  it('round-trips inside a request context', () => {
    requestContext.run({ license: { tier: 'free', key: null } } as never, () => {
      expect(getRequestRegimeFundingDegraded()).toBe(false);
      setRequestRegimeFundingDegraded();
      expect(getRequestRegimeFundingDegraded()).toBe(true);
    });
  });

  it('is a silent no-op outside a request context (stdio / fleet), never a throw', () => {
    expect(() => setRequestRegimeFundingDegraded()).not.toThrow();
    expect(getRequestRegimeFundingDegraded()).toBe(false);
  });

  it('does not leak across requests — one degraded call must not mark the next as degraded', () => {
    requestContext.run({ license: { tier: 'free', key: null } } as never, () => {
      setRequestRegimeFundingDegraded();
    });
    requestContext.run({ license: { tier: 'free', key: null } } as never, () => {
      expect(getRequestRegimeFundingDegraded()).toBe(false);
    });
  });
});

describe('the seam has a LIVE READER — the condition license.ts states for its existence', () => {
  const indexSrc = src('src/index.ts');

  it('src/index.ts reads the flag and writes it into the success verdict', () => {
    expect(indexSrc).toContain('regimeSuccessVerdict(getRequestRegimeFundingDegraded())');
  });

  it('only get_market_regime stamps the flag — a second writer would need its own reader', () => {
    const regimeSrc = src('src/tools/get-market-regime.ts');
    expect(regimeSrc).toContain('setRequestRegimeFundingDegraded()');
    // Stamped ONLY for a rate-limit refusal. A bare `.catch(() => …)` that stamped unconditionally
    // would relabel every parse error as a budget refusal and rebuild the conflation.
    expect(regimeSrc).toContain('if (e instanceof UpstreamRateLimitError) setRequestRegimeFundingDegraded();');
  });
});

describe('THE ERROR ARM — the assertion the whole wave rests on', () => {
  const indexSrc = src('src/index.ts');
  // Isolate the get_market_regime registration so a sibling tool's logging cannot satisfy this.
  const block = (() => {
    const start = indexSrc.indexOf("// ── Tool 3: get_market_regime ──");
    expect(start).toBeGreaterThan(-1);
    const next = indexSrc.indexOf('// ── Tool 4', start);
    expect(next).toBeGreaterThan(start);
    return indexSrc.slice(start, next);
  })();

  it('logs a request_log row on the catch path, not only on success', () => {
    const catchIdx = block.indexOf('} catch (err: unknown) {');
    expect(catchIdx).toBeGreaterThan(-1);
    const catchBody = block.slice(catchIdx);
    expect(catchBody).toContain('logRequest({');
    expect(catchBody).toContain('regimeErrorVerdict(err)');
  });

  it('still returns the structured error to the caller — logging must not change the contract', () => {
    expect(block.slice(block.indexOf('} catch (err: unknown) {'))).toContain('return toolErrorContent(err);');
  });

  it('populates verdict AND regime on the success arm', () => {
    const successSlice = block.slice(0, block.indexOf('} catch (err: unknown) {'));
    expect(successSlice).toContain('verdict: regimeSuccessVerdict(');
    expect(successSlice).toContain('regime:');
    expect(successSlice).toContain('exchange,');
  });
});

describe('logRequest precedence — get_trade_call rows must stay byte-identical', () => {
  const analyticsSrc = src('src/lib/analytics.ts');

  it('prefers an explicit entry value, else the HOLD stamp, else NULL', () => {
    expect(analyticsSrc).toContain('entry.exchange ?? hold?.exchange ?? null');
    expect(analyticsSrc).toContain('entry.regime ?? hold?.regime ?? null');
  });

  it('get_trade_call passes neither field, so it still falls through to its HOLD stamp', () => {
    const indexSrc = src('src/index.ts');
    const start = indexSrc.indexOf('// ── Tool 1');
    const end = indexSrc.indexOf('// ── Tool 3: get_market_regime ──');
    const before = indexSrc.slice(start > -1 ? start : 0, end);
    // The trade-call handler sets `verdict` (its BUY/SELL/HOLD) but must not set `regime:`/`exchange:`
    // as logRequest entry fields, or it would bypass the holdCapture single-stamp guarantee.
    expect(before).toContain('verdict,');
    expect(before).not.toContain('regime: (result as { regime?: string }).regime');
  });
});
