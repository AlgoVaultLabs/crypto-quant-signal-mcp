/**
 * book-liveness.ts — OPS-PFE-METRIC-INTEGRITY-W1 R2 (C2 ruling).
 *
 * THE emit-time book-liveness predicate. Pure, exported, single-derived.
 *
 * ── WHY THIS EXISTS ──
 *
 * Several venues emit a **zero-volume synthetic flat candle** (OHLC all equal to the last
 * price, `volume = 0`) for a book that is not trading, rather than omitting the bar. When a
 * whole evaluation window lands inside such a stretch, the PFE/MAE evaluator scores
 * `pfe = mae = 0` and the canonical predicate (`pfe_return_pct < 0` for a SELL) records it as
 * a **loss**. A market that was *shut* is scored as a trade that *lost*.
 *
 * Measured 2026-07-19 (contemporaneous era): 1,041 such rows, **BUY 0.108% vs SELL 14.654%**
 * — a 135× directional asymmetry that is an artifact of *where* we emit, not of edge. Full
 * evidence: `audits/OPS-PFE-METRIC-INTEGRITY-W1-endpoint-truth.md`.
 *
 * This module is the **generator-level** fix: do not emit a directional call into a book that
 * is not trading. It does not filter at scoring time — it stops manufacturing the row.
 *
 * ── THE PREDICATE IS DELIBERATELY IGNORANT ──
 *
 * It knows about **bars and volume**. Nothing else. It MUST NOT consult an asset-class
 * classifier, a symbol allow/deny list, market hours, or a venue name:
 *
 *   - Tokenized equity, commodity and FX perps are a **first-class ICP tier** and STAY
 *     (operator ruling C1, 2026-07-19). "Equity ⇒ suppress" is a category error.
 *   - Thin CRYPTO alts fail this predicate identically — on ASTER, `KNC · STX · API3 · AEVO ·
 *     1000SATS · SLP · OKB · BB` all measured 0–2 genuine bars of the last 24 at 1h.
 *   - The SAME tickers on BINANCE/BYBIT measured 24/24.
 *
 * The dead thing is always the `(venue, symbol)` **book**, never the asset class. A test
 * asserts this file contains no such reference; keep it that way.
 *
 * ── WHY `volume > 0` ALONE, AND NOT `numTrades` ──
 *
 * The ruling originally read "volume>0 or numTrades>0". `numTrades` does not exist anywhere in
 * this codebase (0 grep hits), the `Candle` interface has no such field, no adapter parses one,
 * and BYBIT/OKX/BITGET do not return it upstream at all. Where it IS available (Binance-family)
 * it measured **perfectly redundant** with `volume > 0` in 24/24 probed rows. Implementing it
 * would be an N-adapter cascade for zero discriminative gain. Ratified `volume`-only.
 *
 * Runtime-verified: `typeof candle.volume === 'number'` on every venue including KuCoin and
 * MEXC, whose adapters assign it without a `parseFloat` (66/66 samples each). `Number()` is
 * applied here anyway — defence in depth, and it makes a future string-typed adapter safe.
 */

import type { Candle } from '../types.js';

/**
 * Lookback window, in bars.
 *
 * Note this counts BARS, not wall-clock — a 24-bar window is 24h at `1h` but 72m at `3m`.
 * That is intentional: the question is "has this book traded in its own recent history",
 * which is a bar-relative question. Separation was measured *cleaner* at 3m/5m/15m than at 1h.
 */
export const BOOK_LIVENESS_WINDOW = 24;

/**
 * Minimum genuinely-traded bars required inside the window.
 *
 * **k = 12 of N = 24 (50%) is measured-safe, and is the ratified pin.**
 *
 * Two independent reasons it sits well below N, both of which a future tuner must preserve:
 *
 *  1. **The last bar is the current still-forming candle** and can legitimately read
 *     `volume = 0` for the moments after a bar opens. A pin near N converts that benign zero
 *     into a false suppression on every book, on every call, at bar boundaries.
 *  2. **Margin below the worst healthy observation.** Live replay across
 *     KUCOIN/MEXC/BINANCE/GATE/ASTER measured healthy floors of 24 / 16 / 23 / 23 genuine
 *     bars; the worst healthy book seen was **MEXC at 16/24**. k=12 leaves ~4 bars of margin.
 *
 * **Do NOT raise this to the once-proposed k ∈ [14,20] without re-measuring.** The k-sweep
 * that produced this pin found **MEXC false-suppressing at k ≥ 18** on that 16/24 book:
 *
 *   k       | KUCOIN | MEXC  | BINANCE | GATE  | ASTER
 *   12 (pin)|  0.0%  |  0.0% |   0.0%  |  0.0% | 27.0%
 *   18      |  0.0%  |  2.3% |   0.0%  |  0.0% | 37.8%
 *   20      |  0.0%  |  2.3% |   0.0%  |  0.0% | 45.9%
 *
 * ASTER's ~27% is EXPECTED and INTENDED (operator ruling Q3): those are calls into books with
 * 0–2 real bars/day, unactionable even under "perps trade 24/7".
 *
 * // TODO: revisit by 2026-08-03 — re-tune only after OPS-PFE-METRIC-INTEGRITY-W1 R4 measures
 * // the PARTIAL-freeze population (n>=500, ASTER-complete + cross-venue). Raising k to catch
 * // partials is the open question R4 exists to answer; until then this pin is full-freeze only.
 */
export const BOOK_LIVENESS_MIN_GENUINE_BARS = 12;

/**
 * Rollout stage. Two-flag firewall (precedent: `docs/RUNBOOK-CARRY-RERANK-FLIP.md`, the DARK
 * carry re-rank; `CARRY_RANKER_SOURCE` ∧ `CARRY_RANKER_ENABLED`):
 *
 *   - `off`     — the predicate never runs. Byte-identical legacy behaviour. **DEFAULT.**
 *   - `shadow`  — measure + count every suppression that WOULD have happened. The verdict is
 *                 untouched. This is the stage that produces the mandatory shadow-compare
 *                 report; no emission changes.
 *   - `enforce` — measure, count, and actually suppress: a frozen book yields `HOLD`.
 *
 * `EMIT_BOOK_LIVENESS_ENABLED` is the **kill switch**: unless it reads `1`/`true`, the mode is
 * forced to `off` regardless of `EMIT_BOOK_LIVENESS_MODE`. Rollback is one env var, no rebuild.
 */
export type BookLivenessMode = 'off' | 'shadow' | 'enforce';

/**
 * Resolve the live rollout stage. Default-deny: anything unrecognised resolves to `off`.
 *
 * Accepts `1` OR `true` (case-insensitive) for the kill switch — bakes in the
 * `X402_NUDGE_ENABLED` hotfix lesson, where a `=== 'true'`-only parser silently no-op'd the
 * documented `=1` go-live value (status.md 2026-07-12).
 */
export function getBookLivenessMode(env: NodeJS.ProcessEnv = process.env): BookLivenessMode {
  const enabled = String(env.EMIT_BOOK_LIVENESS_ENABLED ?? '').trim().toLowerCase();
  if (enabled !== '1' && enabled !== 'true') return 'off';

  const mode = String(env.EMIT_BOOK_LIVENESS_MODE ?? '').trim().toLowerCase();
  if (mode === 'enforce') return 'enforce';
  if (mode === 'shadow') return 'shadow';
  // Enabled but unset/garbage mode ⇒ shadow, never enforce. Turning the switch on must not
  // silently start suppressing emissions on a typo.
  return 'shadow';
}

export interface BookLivenessResult {
  /** False ⇒ the book is frozen and no directional call should be emitted. */
  live: boolean;
  /** Bars in the examined window carrying `volume > 0`. */
  genuineBars: number;
  /** Bars actually examined — `min(candles.length, BOOK_LIVENESS_WINDOW)`. */
  barsExamined: number;
}

/**
 * Assess whether a book is genuinely trading, from its most recent bars.
 *
 * Fails **OPEN** (`live: true`) when it cannot tell: an empty or short candle array means the
 * caller has bigger problems (`REQUIRED_CANDLES` already guards that upstream), and a liveness
 * probe must never be the thing that silences a healthy venue on missing data.
 *
 * @param candles Ascending-by-time candles. Only the last `BOOK_LIVENESS_WINDOW` are examined.
 */
export function assessBookLiveness(
  candles: Candle[],
  window: number = BOOK_LIVENESS_WINDOW,
  minGenuineBars: number = BOOK_LIVENESS_MIN_GENUINE_BARS,
): BookLivenessResult {
  if (!Array.isArray(candles) || candles.length === 0) {
    return { live: true, genuineBars: 0, barsExamined: 0 };
  }

  const win = candles.slice(-window);

  // Fail open on a window too short to judge: with fewer bars than the threshold, "genuine <
  // minGenuineBars" would be true by arithmetic alone, not by evidence of a frozen book.
  if (win.length < minGenuineBars) {
    return { live: true, genuineBars: win.length, barsExamined: win.length };
  }

  let genuineBars = 0;
  for (const c of win) {
    // Number() coerces a string-typed volume; NaN and null both fail the comparison, which is
    // the safe direction only because the short-window guard above already fired.
    if (Number(c.volume) > 0) genuineBars++;
  }

  return {
    live: genuineBars >= minGenuineBars,
    genuineBars,
    barsExamined: win.length,
  };
}
