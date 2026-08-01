/**
 * market-insight-post — composes the weekly market-insight post body.
 *
 * PURE by design (no network, no env, no clock): `agent-forum-post.ts` calls `main()`
 * unconditionally at import, so nothing in that file can be unit-tested. The composition
 * lives here instead, which means the tests exercise the ACTUAL published copy rather
 * than a transcription of it in a fixture — the distinction that matters, because the
 * defect this wave fixes was in published copy that no test ever looked at.
 *
 * FIX-CONVICTION-CALL-POSTS-W1.
 */

import { renderScanShowcase, type RenderableScanCall } from './scan-digest.js';

export interface MarketInsightScan {
  setups: RenderableScanCall[];
  /** Total perps scanned across every venue that answered. LIVE — never a literal. */
  assetCount: number;
  /** Venues that scanned WITHOUT error. LIVE, and NOT the size of the venue set. */
  venueCount: number;
  /** First venue of the live enum — named in the quiet-week regime sentence. */
  probeVenue: string;
}

export interface ComposedPost {
  title: string;
  body: string;
  /** Which branch produced it — surfaced in logs so a quiet week is visible as a CHOICE. */
  kind: 'digest' | 'quiet';
}

/**
 * Compose the post.
 *
 * `monthTag` and `regime` are injected rather than derived so this stays pure: the caller
 * owns the clock and the network. `regime` is `null` when it could not be measured — the
 * copy then says so instead of guessing, because a fabricated regime in public copy is
 * exactly the class of claim this wave exists to remove.
 */
export function composeMarketInsightPost(
  scan: MarketInsightScan,
  monthTag: string,
  regime: string | null,
): ComposedPost {
  // `cta: null` drops the renderer's Telegram "/scanwatch" line — a bot command means
  // nothing to a dev.to reader — and leaves CTAs to the post type's single block, so they
  // cannot be emitted twice.
  const digest = renderScanShowcase(scan.setups, scan.assetCount, scan.venueCount, { cta: null });

  if (digest) {
    return {
      kind: 'digest',
      title: `This week's top crypto trade setups — ${scan.assetCount} assets · ${scan.venueCount} venues (${monthTag})`,
      body: [
        digest,
        '',
        'Every setup above is a live call from the same engine that publishes its full record on-chain — each one written down before its outcome is known. Conviction is shown as measured, not rounded up: these are the week\'s strongest setups, not certainties.',
        '',
        'Ranking is by conviction across every venue scanned, deduplicated per coin, and filtered to assets that actually carry enough open interest to trade. What is not here matters as much as what is: the engine holds by default.',
      ].join('\n'),
    };
  }

  // ── Quiet week ──
  // Telegram SUPPRESSES its broadcast here. dev.to publishes instead, by explicit operator
  // decision (Q5): a weekly slot that silently vanishes teaches the reader nothing, and
  // "nothing fired" is itself a real result from a selective engine. The one thing that
  // must never happen is inventing a setup to fill the slot.
  const regimeNote = regime
    ? `The dominant regime across the ${scan.probeVenue} universe was ${regime}.`
    : 'Regime data was not available for this run.';
  return {
    kind: 'quiet',
    title: `Quiet week: ${scan.assetCount} assets scanned, no fresh directional setups (${monthTag})`,
    body: [
      `📡 This week I scanned ${scan.assetCount} assets across ${scan.venueCount} venues.`,
      '',
      `No fresh directional setups cleared the bar. ${regimeNote}`,
      '',
      'That is a result, not a gap. The engine holds by default and only surfaces a directional call when the structure actually supports one, so a quiet week is what selectivity looks like from the outside. The alternative — promoting a marginal call to fill a weekly slot — is exactly what a verifiable track record is meant to make impossible.',
      '',
      'Every call it does publish is Merkle-anchored on Base L2 before its outcome is known. That is also why the quiet weeks get reported: a record you can only see when it flatters us is not a record.',
      '',
      'The same scan runs continuously across every supported venue, so a week with no setups is not a week with no coverage.',
    ].join('\n'),
  };
}
