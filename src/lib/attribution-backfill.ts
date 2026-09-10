/**
 * FUNNEL-ATTRIBUTION-CLASSIFY-BACKFILL-W1 CH1 — the ONE place a STORED `user_agent` becomes a class.
 *
 * `signup_attribution.classification` + `.ua_class` landed at 2026-09-07T00:10Z (migration 038).
 * Every row written before that instant carries NULL in both, so the funnel's historical series
 * carries known machine traffic in a bucket no class filter can reach. Measured on signal-1
 * 2026-09-10: **826 rows total, 782 with NULL `classification`** (743 of them carrying a UA, 39
 * with none).
 *
 * ── 🛑 THE FIDELITY LIMIT — WHY THIS MODULE CAN ONLY EVER SAY `bot` ──────────────────────────
 * `classifyBrowserIntent()` (`./browser-intent.js`) decides in SIX ordered steps. Exactly ONE of
 * them is recoverable from what the table stored:
 *
 *   | step | evidence it reads                                  | stored on the row? |
 *   |------|----------------------------------------------------|--------------------|
 *   | 1    | `Sec-Purpose` / `Purpose` (prefetch/prerender)      | ❌                 |
 *   | 2    | `user_agent` → `classifyTraffic({ua}).is_automated`| ✅ **this module** |
 *   | 3    | `Sec-Fetch-Mode` / `Sec-Fetch-Dest` contradiction  | ❌                 |
 *   | 4    | `Accept` lacking `text/html`                       | ❌                 |
 *   | 5    | positive navigation ⇒ `browser`                    | ❌                 |
 *   | 6    | residual ⇒ `unknown`                               | ❌                 |
 *
 * Step 2 in the live path is literally `if (ua && isAutomatedUa(ua)) return bot('ua_automated')`,
 * where `isAutomatedUa` defaults to `classifyTraffic({ ua }).is_automated`. Re-running that same
 * function on that same stored UA yields the IDENTICAL verdict — this is a **recovery**, not an
 * inference. And a row step 1 would have caught would have been `bot` too, so losing the ordering
 * cannot change the answer.
 *
 * **It may NEVER return `'browser'`.** `signup-intent.ts` defines `browser` as the only class with
 * positive evidence of a human navigation — evidence that is not in this table. Writing it from a
 * UA alone manufactures the human clicks this whole arc exists to stop counting.
 *
 * **It may NEVER return `'unknown'`.** `signup-intent.ts` defines it as the fail-open residual
 * AFTER steps 1–4 found nothing. A backfilled row cleared one layer of four; calling that
 * `unknown` overstates what was checked and corrupts the one bucket that measures "what CH1 did
 * not close".
 *
 * The return type is `'bot' | null` so both are **unrepresentable**: the limit is enforced by
 * `tsc`, not by this comment. A later wave that stores a richer signal (a header column, say) may
 * widen the projector — and the type will still refuse to let it guess.
 *
 * ── THE INSTRUMENT, RECORDED BESIDE THE NUMBER ───────────────────────────────────────────────
 * This module's instrument is `classifyTraffic`, NOT raw `isbot`, and the two DISAGREE. The
 * canonical classifier deliberately un-tags bare SDKs and agent_clients under the ratified ICP
 * bias ("never drop a real agent"). Measured over the 743 UA-bearing NULL rows on 2026-09-10:
 *
 *   raw `isbot@5.1.44`                 255 (34.3 %)
 *   `classifyTraffic().is_automated`   222 (29.9 %)   ← what this module recovers
 *   disagreement                        33 rows — aiohttp 23, GPTBot 4, python-requests 3,
 *                                       ClaudeBot 3
 *
 * Those 33 stay NULL **by policy, not by accident**. Re-basing this module on raw `isbot` to
 * capture them was considered and REFUSED: the backfilled verdict is only a recovery *because* it
 * is the same function the live path runs, and a different classifier would make it an inference —
 * voiding the equivalence proof in `tests/unit/attribution-backfill.test.ts` outright.
 *
 * The 42.2 % figure in `ops/scripts/intent-classification-readout.sh` is raw `isbot` over a
 * DIFFERENT 28-day window and is not this wave's denominator. Never compare across the two.
 *
 * PURE — no I/O, no clock, no DB. Imports nothing but the two canonical classifiers.
 */
import { classifyTraffic } from './traffic-classifier.js';
import { classifyClient } from './client-registry.js';

export interface StoredUaVerdict {
  /**
   * `'bot'` when the canonical classifier calls the stored UA automated; `null` otherwise.
   *
   * `null` means "still genuinely unclassified" — exactly what a pre-CH1 row already meant — and
   * NOT "browser" and NOT "unknown". See the fidelity limit above; the union has no third member
   * on purpose.
   */
  classification: 'bot' | null;
  /**
   * The client slug from the ONE UA→identity map (`classifyClient().name`): a named
   * agent/crawler/SDK/browser, `unknown` for an absent UA, `other` for an unmatched one.
   *
   * Recoverable in FULL, unlike `classification` — it is a pure function of the UA and the live
   * path derives it exactly this way (`browser-intent.ts` computes `classifyClient(ua).name`
   * before any step runs, so it is written even for rows that resolve to `browser`).
   */
  uaClass: string;
}

/**
 * Project a STORED `user_agent` onto the classes recoverable from it.
 *
 * Trims first, because the live path reads the header through a trimming accessor and then gates
 * step 2 on `ua &&` — so a whitespace-only stored UA must behave as an ABSENT one here too, or the
 * two paths disagree on the one input shape neither of them ever thinks about.
 */
export function classifyStoredUa(ua: string | null | undefined): StoredUaVerdict {
  const s = (ua ?? '').trim();
  return {
    classification: s && classifyTraffic({ ua: s }).is_automated ? 'bot' : null,
    uaClass: classifyClient(s).name,
  };
}
