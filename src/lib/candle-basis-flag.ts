/**
 * candle-basis-flag.ts — SIGNAL-CLOSEDBAR-SHADOW-W1 CH2
 *
 * The `CANDLE_BASIS` firewall for the signal engine's candle window. Default 'live' =
 * the current behaviour (indicators read `candles[length-1]`, the IN-PROGRESS bar) ⇒
 * call/confidence BYTE-IDENTICAL. CH2 only INSTRUMENTS the confirmed-bar re-base
 * (shadow); the FLIP wave (SIGNAL-CLOSEDBAR-FLIP-W{NEXT}) sets CANDLE_BASIS='closed'
 * once ≥7d of divergence data supports the threshold retune, and flips back instantly
 * by unsetting the env.
 *
 * Modelled on `oiscore-source-flag.ts` — same shape, same DEFAULT-DENY contract, same
 * one-env-var rollback. (This is the SECOND such shadow-re-base pair in the tree; the
 * shared-helper extraction threshold is ≥3, so it is cloned deliberately rather than
 * extracted early. Logged as a WIS candidate for the third.)
 *
 * DEFAULT-DENY: only the exact string 'closed' selects the closed basis. Anything else —
 * unset, empty, a typo, 'CLOSED', 'true', '1' — resolves to 'live'. Garbage NEVER
 * enables a basis change, because the failure mode of accidentally flipping the engine
 * is a silent re-scoring of every signal the product emits.
 */
export type CandleBasis = 'live' | 'closed';

export function getCandleBasis(): CandleBasis {
  return process.env.CANDLE_BASIS === 'closed' ? 'closed' : 'live';
}

/**
 * `CANDLE_BASIS_SHADOW_ENABLED` — whether to compute the closed-basis scores alongside
 * the live ones and persist the divergence. Default ON: the shadow window is the entire
 * deliverable of this wave, so it must not require an env var to exist to start working.
 *
 * OFF-switch rather than default-deny, deliberately and in the opposite direction to
 * `getCandleBasis`: this flag cannot change the emitted verdict, it only governs extra
 * measurement work. The risk it manages is COST (it doubles the indicator pipeline, and
 * `scan_trade_calls` fans out across many assets), not correctness — so '0' or 'false'
 * turns it off and everything else leaves it on.
 */
export function isCandleBasisShadowEnabled(): boolean {
  const raw = process.env.CANDLE_BASIS_SHADOW_ENABLED;
  return raw !== '0' && raw !== 'false';
}
