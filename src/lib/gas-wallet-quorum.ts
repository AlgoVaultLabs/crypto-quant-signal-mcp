/**
 * Gas-wallet balance quorum — OPS-GAS-WALLET-RPC-QUORUM-W1.
 *
 * Why this exists: the monitor used to page "Gas wallet low" off the FIRST
 * valid-looking RPC read. Public Base RPCs intermittently return a well-formed
 * { result: "0x0" } when the backend node behind their load balancer is pruned
 * or lagging — that passes a `0x`-prefix check and reads as 0.000000 ETH. On
 * 2026-07-17 this produced 28 false "Gas wallet low: 0.000000 ETH" readings
 * (one paged Telegram) while the wallet held ~0.0471 ETH at every Base block.
 *
 * Fix: a LOW verdict requires independent corroboration from >= N distinct
 * endpoints and must not be outnumbered by healthy reads. Trust is
 * deliberately asymmetric — public nodes fail by UNDER-reporting (pruned state
 * -> 0x0), not by fabricating a high balance — so a single healthy read is
 * enough to refute a lone low read, while a genuine drain (every endpoint
 * agrees) still pages on the very next 2-minute cycle.
 *
 * Parsing is kept separate from trusting: parseGasBalanceResult() accepts 0x0
 * as a legitimately-parsed zero, and evaluateGasQuorum() decides whether to
 * believe it.
 */

/** Low-water mark, in ETH, below which the facilitator gas wallet is "low". */
export const GAS_WALLET_MIN_ETH = 0.005;

/** Distinct endpoints that must independently agree before a low verdict pages. */
export const GAS_LOW_CONFIRMATIONS = 2;

export type GasRead =
  | { endpoint: string; ok: true; eth: number }
  | { endpoint: string; ok: false; error: string };

export type GasQuorumVerdict = 'healthy' | 'low' | 'unconfirmed' | 'no-data';

export interface GasQuorumResult {
  verdict: GasQuorumVerdict;
  /** Operator-facing alert text. Non-null ONLY for a corroborated low. */
  error: string | null;
  balance: number;
  detail: string;
}

export interface GasQuorumOptions {
  minEth?: number;
  requiredConfirmations?: number;
}

/**
 * A JSON-RPC QUANTITY: 0x followed by at least one hex digit. Deliberately
 * stricter than `startsWith('0x')` — '0x', '0xzz' and a bare decimal string
 * must be rejected outright rather than coerced toward 0.
 */
const HEX_QUANTITY = /^0x[0-9a-fA-F]+$/;

/** Parse an eth_getBalance JSON-RPC body into ETH. Never coerces junk to 0. */
export function parseGasBalanceResult(
  data: unknown,
): { ok: true; eth: number } | { ok: false; error: string } {
  if (data === null || typeof data !== 'object') {
    return { ok: false, error: 'RPC returned non-JSON response' };
  }
  const body = data as { result?: unknown; error?: { message?: string } };
  if (body.error) {
    return {
      ok: false,
      error: `RPC error: ${body.error.message ?? JSON.stringify(body.error)}`,
    };
  }
  if (typeof body.result !== 'string' || !HEX_QUANTITY.test(body.result)) {
    return {
      ok: false,
      error: `Invalid RPC response (no usable hex result): ${JSON.stringify(data).slice(0, 200)}`,
    };
  }
  return { ok: true, eth: Number(BigInt(body.result)) / 1e18 };
}

/**
 * Decide the gas-wallet verdict from a set of per-endpoint reads.
 *
 * - `low`         — >= requiredConfirmations distinct endpoints agree it is
 *                   below the floor, and they are not outnumbered. Pages.
 * - `unconfirmed` — at least one low read, but not corroborated. Never pages;
 *                   the caller should log `detail` for forensics.
 * - `healthy`     — no endpoint reported below the floor.
 * - `no-data`     — zero valid reads; caller reports the RPC-exhausted error.
 */
export function evaluateGasQuorum(
  reads: readonly GasRead[],
  opts: GasQuorumOptions = {},
): GasQuorumResult {
  const minEth = opts.minEth ?? GAS_WALLET_MIN_ETH;
  const required = opts.requiredConfirmations ?? GAS_LOW_CONFIRMATIONS;

  // Two reads from the SAME endpoint are one node's opinion, not independent
  // corroboration — dedupe (first wins) before counting votes.
  const seen = new Set<string>();
  const valid: { endpoint: string; eth: number }[] = [];
  for (const r of reads) {
    if (!r.ok || seen.has(r.endpoint)) continue;
    seen.add(r.endpoint);
    valid.push({ endpoint: r.endpoint, eth: r.eth });
  }

  if (valid.length === 0) {
    return { verdict: 'no-data', error: null, balance: 0, detail: 'no valid RPC reads' };
  }

  const low = valid.filter(v => v.eth < minEth);
  const healthy = valid.filter(v => v.eth >= minEth);
  const maxEth = Math.max(...valid.map(v => v.eth));
  const summary = valid.map(v => `${v.endpoint}=${v.eth.toFixed(6)}`).join(', ');

  if (low.length >= required && low.length >= healthy.length) {
    const worst = Math.min(...low.map(v => v.eth));
    return {
      verdict: 'low',
      error:
        `Gas wallet low: ${worst.toFixed(6)} ETH (< ${minEth}) — ` +
        `confirmed by ${low.length}/${valid.length} independent RPCs [${summary}]`,
      balance: worst,
      detail: summary,
    };
  }

  if (low.length > 0) {
    return {
      verdict: 'unconfirmed',
      error: null,
      // Report the corroborated truth, not the suspect zero.
      balance: maxEth,
      detail:
        `uncorroborated low read (${low.length}/${valid.length} below ${minEth}; ` +
        `need ${required} and not outnumbered) [${summary}]`,
    };
  }

  return {
    verdict: 'healthy',
    error: null,
    balance: maxEth,
    detail: `${valid.length} RPC read(s) >= ${minEth} [${summary}]`,
  };
}
