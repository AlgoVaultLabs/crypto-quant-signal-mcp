// regime-diag/mutate.ts — EDGE-REGIME-DIAG-W1: the test-only lever of the mutation proofs (AC2.4).
//
// A named break of one rule: `replay` (the core call), `keyb` (key B's lead), `bothtouch` (the both-touch rule),
// `seal` (the hold-out seal). Unset in every real run: the guard refuses, reason named, when it is set.
export const MUTATE: string = process.env.REGIME_DIAG_MUTATE ?? '';
