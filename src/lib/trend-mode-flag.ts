/**
 * trend-mode-flag.ts — SIGNAL-TREND-BLINDNESS-FIX-W1 CH3
 *
 * The `TREND_MODE` firewall for the scorer's RSI polarity. Default 'off' = today's ladder,
 * contrarian in every regime ⇒ call/confidence BYTE-IDENTICAL. Setting `TREND_MODE=on` lets a
 * CONFIRMED trend flip the overbought/oversold region's sign, so a saturating RSI inside a
 * confirmed uptrend stops being scored as the single most bearish input available.
 *
 * WHY A FLAG AT ALL. This is the only behaviour change in the wave and it moves a LIVE,
 * revenue-bearing verdict. The flag is the revert path: unset the env and the engine is
 * arithmetically back to where it was, with no deploy and no code change.
 *
 * DEFAULT-DENY: only the exact string 'on' enables it. Unset, empty, 'ON', 'true', '1', a typo —
 * all resolve to 'off'. Garbage must never re-score the product's output, which is the same
 * contract `getCandleBasis()` and `getOiScoreSource()` hold.
 *
 * ── THIRD CLONE, DELIBERATELY NOT EXTRACTED ─────────────────────────────────────────────────
 * `candle-basis-flag.ts` records itself as the SECOND of these one-env-var default-deny flags and
 * says the shared-helper extraction threshold is >=3, logging a WIS candidate for the third. This
 * is that third. It is still CLONED rather than extracted, because CLAUDE.md's 3-example rule is
 * explicit that the third instance ACKNOWLEDGES the threshold, flags the candidate and DEFERS —
 * never inline-extracts inside the wave that happens to trip it. Extraction is
 * `OPS-SHARED-ENV-FLAG-EXTRACTION-W{NEXT}`, and it now has three real consumers to generalise
 * from instead of two.
 *
 * Read PER CALL, never cached at module scope — same as the other two, so a test can flip
 * `process.env` between cases without a reset seam.
 */
export type TrendMode = 'off' | 'on';

export function getTrendMode(): TrendMode {
  return process.env.TREND_MODE === 'on' ? 'on' : 'off';
}
