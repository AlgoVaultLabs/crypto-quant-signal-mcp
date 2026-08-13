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

/*
 * `isCandleBasisShadowEnabled()` and its `CANDLE_BASIS_SHADOW_ENABLED` env var were removed
 * by OPS-CANDLE-BASIS-SHADOW-DECOM-W1 along with the shadow they gated. It was an OFF-switch
 * defaulting ON, which is why the write was live while the var was set nowhere — measured at
 * decom: 0 occurrences in the host `.env`, 0 in `docker-compose.yml`, UNSET in the container.
 * There was therefore no env residue to strip on the host.
 *
 * `getCandleBasis()` above is a DIFFERENT flag and is deliberately untouched. It is
 * default-DENY, it selects the basis that produces the EMITTED verdict, and
 * `CANDLE_BASIS=closed` is the live production setting SIGNAL-CLOSEDBAR-FLIP-W1 shipped.
 * Do not merge the two, and do not restore the deleted one by symmetry with it.
 */
