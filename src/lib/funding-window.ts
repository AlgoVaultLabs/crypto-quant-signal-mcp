/**
 * The funding z-score window, as a dependency-free leaf.
 *
 * These were inline `14 * 86400` / `< 20` literals repeated across four call sites in
 * `performance-db.ts`. They are extracted — rather than merely named in place — because
 * `reasoning` now CITES the window in public copy ("unusually negative for XRP over 14
 * days"), so the prose and the query that computes the z-score must read one value.
 *
 * The extraction (rather than importing the constant from `performance-db.ts`) is the
 * same move `isShortLivedScript` → `runtime.ts` made: every test that exercises the
 * trade-call path mocks `performance-db.js` wholesale, so a constant living there would
 * arrive `undefined` at the renderer and put "over undefined days" in front of a user.
 * A value that must survive a mock does not belong behind one.
 */

/** Rolling lookback for the per-coin funding z-score. */
export const FUNDING_Z_WINDOW_DAYS = 14;

/** Below this many samples no z-score is produced at all — see D9 in the wave spec. */
export const FUNDING_Z_MIN_SAMPLES = 20;

export const FUNDING_Z_WINDOW_SECONDS = FUNDING_Z_WINDOW_DAYS * 86400;
