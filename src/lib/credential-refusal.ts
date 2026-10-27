/**
 * credential-refusal.ts — AUTH-THREE-STATE-W1 CH2. ONE decision, two emitters.
 *
 * A guard on a live serving path REFUSES; it does not THROW (CLAUDE.md build-and-runtime, codified
 * after a boot-time `throw` in the x402 rail would have taken the whole server down for a fault in
 * one optional lane). So everything here returns a value; nothing raises, and nothing exits.
 *
 * WHAT REFUSES AND WHAT DOES NOT. Only `UNKNOWN` and `INDETERMINATE` refuse. `ABSENT` and
 * `RESOLVED` are ordinary traffic, and `MALFORMED` is deliberately SERVED: the repo's own docs tell
 * seven MCP clients to send `Authorization: Bearer ${env:AV_API_KEY}`, and when that variable is
 * not expanded the literal string arrives here (`docs/integrations/mcp-clients/cursor.md:34` lists
 * it as a top failure mode). That literal fails `AV_KEY_SHAPE`, so it is MALFORMED, so it never
 * refuses — which is the entire reason refusal can ship default-ON rather than behind a flag
 * nobody flips.
 *
 * GROWTH-AGENT-SIGNIN-OAUTH-W1 CH2 (proposal (b)): `TOKEN_INVALID` refuses too, but ONLY over HTTP.
 * The JSON-RPC tables stay keyed by `JsonRpcRefusingOutcome`, and `decideRefusal` cannot accept a
 * TOKEN_INVALID at compile time: `/mcp` routes it to its 401 first (`applyCredentialRefusal`, C13),
 * and the REST sites emit the Q-E body through `refuseCredentialHttp` with no site edits.
 */
import type { Response } from 'express';
import type { CredentialOutcome, CredentialResolution } from './credential-outcome.js';
import { isRetryable } from './credential-outcome.js';
import { effectiveKeylessMonthlyCalls, resolveStepupMode } from './plans.js';

/**
 * JSON-RPC error codes for the two refusing outcomes.
 *
 * 🛑 `-32001` AND `-32002` ARE DELIBERATELY SKIPPED. `-32001` is `ErrorCode.RequestTimeout` in
 * `@modelcontextprotocol/sdk` AND the code its own Streamable-HTTP transport returns for
 * `Session not found` — both of which clients RETRY, so reusing it would make a settled bad key
 * indistinguishable from a dead session and re-create, in the wire protocol, the exact collapse
 * this wave exists to end. `-32002` is unused today but sits inside the SDK's own `-32000`/`-32001`
 * block and is the likeliest value it claims next; leaving the gap costs nothing.
 *
 * The implementation-defined range is `[-32000, -32099]` (`spec.types.js:24`), so both of these are
 * legal server errors.
 *
 * ⚠️ This is a property RENTED from a dependency, and `package.json` carries a CARET range
 * (`^1.12.1`) while the lockfile resolves 1.29.0 — so a routine `npm install` can move the SDK with
 * no code change here. A comment saying "verified free" is prose, and prose is not a control:
 * `tests/auth-refusal-mcp.test.ts` imports `ErrorCode` from the SDK at RUNTIME and fails if either
 * code appears among its values.
 */
export const AUTH_REFUSAL_JSONRPC_CODES: Readonly<Record<'UNKNOWN' | 'INDETERMINATE', number>> = Object.freeze({
  UNKNOWN: -32003,
  INDETERMINATE: -32004,
});

/** HTTP `code` values for the plain-REST emitter. Extends `authRequired`'s vocabulary; never a second shape. */
export const AUTH_REFUSAL_HTTP_CODES: Readonly<Record<RefusingOutcome, string>> = Object.freeze({
  UNKNOWN: 'auth_key_unknown',
  INDETERMINATE: 'auth_upstream_indeterminate',
  TOKEN_INVALID: 'auth_oauth_token_mcp_only',
});

/**
 * Caller-facing copy. Action-verb, ≤20 words, no internal detail (Design.md §10 + the CTA law).
 *
 * 🛑 `INDETERMINATE` NEVER SAYS "INVALID". It is not a rejection — it is the absence of an answer.
 * Saying "invalid" would repeat, in the copy layer, the same four-into-one collapse this wave is
 * removing from the resolver, and would tell a paying customer their key is bad when it is not.
 */
export const AUTH_REFUSAL_COPY: Readonly<Record<RefusingOutcome, { error: string; suggested_action: string }>> =
  Object.freeze({
    UNKNOWN: {
      error: 'That API key was not recognised.',
      // GROWTH-AGENT-SIGNIN-STEPUP-W1-V2 CH4: a RUNTIME string, so it names the allowance the meter
      // will actually apply to the keyless retry — the resolved STEPUP_MODE's, read per access (a
      // getter, not a load-time constant), never a baked figure.
      get suggested_action(): string {
        return `Check the key at https://api.algovault.com/account, or drop the Authorization header to try ${effectiveKeylessMonthlyCalls(resolveStepupMode()).toLocaleString('en-US')} free calls.`;
      },
    },
    INDETERMINATE: {
      error: 'Could not verify your API key right now.',
      suggested_action:
        'Retry in a few seconds. Your key was not rejected — we could not reach the billing service.',
    },
    // §Copy Q-E, REST only: an OAuth access token presented where only a key works.
    TOKEN_INVALID: {
      error: 'This access token works on /mcp only.',
      suggested_action: 'Use your AlgoVault API key on this endpoint, or call the tool through /mcp.',
    },
  });

/** The two outcomes the JSON-RPC tables cover. TOKEN_INVALID never reaches them (C13). */
export type JsonRpcRefusingOutcome = 'UNKNOWN' | 'INDETERMINATE';

/** The outcomes that refuse. Everything else is served. */
export type RefusingOutcome = JsonRpcRefusingOutcome | 'TOKEN_INVALID';

export function isRefusingOutcome(outcome: CredentialOutcome): outcome is RefusingOutcome {
  return outcome === 'UNKNOWN' || outcome === 'INDETERMINATE' || outcome === 'TOKEN_INVALID';
}

/**
 * The kill switch. Default ON — precedent `MCP_STATELESS` (`src/index.ts:1289`), which is likewise
 * "the new behaviour unless explicitly turned off".
 *
 * A default-OFF flag would leave the defect live behind a switch nobody flips, which is how a fix
 * ships and changes nothing. Read per call rather than captured at module load so the lever is
 * exercisable by test — a flag proven only by inspection is a flag that has never been proven.
 */
export function isStrictUnknownEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AUTH_STRICT_UNKNOWN !== '0';
}

export interface RefusalDecision {
  refuse: boolean;
  /** JSON-RPC error code — present iff `refuse`. */
  code?: number;
  /** The JSON-RPC `error` object — present iff `refuse`. */
  error?: {
    code: number;
    message: string;
    data: { auth_outcome: JsonRpcRefusingOutcome; retryable: boolean; suggested_action: string };
  };
  /** Why we did not refuse, for the tests and for anyone reading a trace. */
  reason?: 'served_outcome' | 'kill_switch_off';
}

/**
 * THE decision. Pure — no Express, no I/O, no clock — so it is unit-testable on its own and cannot
 * drift from the thing production runs.
 *
 * `method` is accepted and DELIBERATELY NOT used to narrow the decision. Every JSON-RPC method
 * refuses, `initialize` and `tools/list` included: clients run both at connect, so a bad key fails
 * AT CONNECTION with our `suggested_action` in the body, instead of connecting cleanly, listing
 * seven tools, and erroring on every call — which reads to a user as "the product is broken"
 * rather than "your key is wrong". The parameter stays in the signature because the scope was a
 * decision rather than an oversight, and `tests/auth-refusal-mcp.test.ts` asserts it holds for
 * every method rather than trusting this comment.
 */
export function decideRefusal(
  resolution: { outcome: Exclude<CredentialResolution['outcome'], 'TOKEN_INVALID'> },
  method?: string,
  env: NodeJS.ProcessEnv = process.env,
): RefusalDecision {
  void method; // scope is method-independent by decision; see the docblock above.
  const outcome = resolution.outcome;
  if (!isRefusingOutcome(outcome)) return { refuse: false, reason: 'served_outcome' };
  if (!isStrictUnknownEnabled(env)) return { refuse: false, reason: 'kill_switch_off' };
  return { refuse: true, code: AUTH_REFUSAL_JSONRPC_CODES[outcome], error: refuseCredentialJsonRpc(outcome) };
}

/**
 * JSON-RPC emitter for `/mcp`.
 *
 * `data.retryable` is projected from the outcome via the single derivation in
 * `credential-outcome.ts`, never restated here — a second copy of "which state can be retried" is
 * exactly the kind of duplicated classification that produced the original defect.
 */
export function refuseCredentialJsonRpc(outcome: JsonRpcRefusingOutcome): NonNullable<RefusalDecision['error']> {
  const copy = AUTH_REFUSAL_COPY[outcome];
  return {
    code: AUTH_REFUSAL_JSONRPC_CODES[outcome],
    message: copy.error,
    data: {
      auth_outcome: outcome,
      retryable: isRetryable(outcome),
      suggested_action: copy.suggested_action,
    },
  };
}

/**
 * HTTP emitter for the plain-REST routes (4 webhook routes + `/api/performance-shadow`), wired in
 * CH3.
 *
 * 🛑 THESE KEEP THEIR 401, and that asymmetry with `/mcp`'s 200 is deliberate. `/mcp` speaks
 * JSON-RPC, where an API key's error travels in the body; a 401 there carrying `WWW-Authenticate`
 * starts OAuth discovery, so `/mcp` answers 401 ONLY for TOKEN_INVALID and only while `MCP_OAUTH` is
 * on (GROWTH-AGENT-SIGNIN-OAUTH-W1 R2.12) — the one case where discovery is the right answer. These
 * routes are ordinary REST, `authRequired` already 401s on them, and that is correct. Two surfaces,
 * two right answers; do not unify them.
 *
 * The BODY is what changes: same four members as `authRequired` (`webhook-api.ts:80-90`), so this
 * extends one shape rather than inventing a second.
 */
export function refuseCredentialHttp(res: Response, outcome: RefusingOutcome): Response {
  const copy = AUTH_REFUSAL_COPY[outcome];
  return res.status(401).json({
    ok: false,
    code: AUTH_REFUSAL_HTTP_CODES[outcome],
    error: copy.error,
    suggested_action: copy.suggested_action,
  });
}
