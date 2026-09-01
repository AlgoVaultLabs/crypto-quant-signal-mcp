/**
 * OPS-POSTGRES-MEM-RIGHTSIZE-W1 — pure verdict logic for the monitor's PFE
 * win-rate check, split out of monitor.ts (which runs main() on import) so it
 * is unit-testable. `checkPfeWinRate` fetches the server-side-cached
 * /api/performance-public surface and passes the parsed body here, instead of
 * recomputing the full ~6 s / 152k-row stats query in the cold cron process.
 *
 * Alert ONLY on a KNOWN win rate below the floor. An unknown rate (null /
 * missing / non-numeric — no matured data, or a transient malformed body) is
 * never treated as a drop; an outright endpoint/server outage is caught by the
 * separate server_health + database checks.
 */
export const PFE_WR_FLOOR = 0.85;

export function evaluatePfeWinRate(data: unknown): { error: string | null; rate: number | null } {
  const raw = (data as { overall?: { pfeWinRate?: unknown } } | null | undefined)?.overall?.pfeWinRate;
  const rate = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  if (rate !== null && rate < PFE_WR_FLOOR) {
    return { error: `PFE win rate dropped to ${(rate * 100).toFixed(1)}% (< 85%)`, rate };
  }
  return { error: null, rate };
}

/**
 * Internal URL for the monitor's PFE check — hits the co-located server on
 * 127.0.0.1:$PORT directly instead of the public api.algovault.com host. The
 * monitor runs via `docker exec` in the SAME container as the server (PID 1,
 * listening on $PORT, default 3000), so the loopback is reliable + fast. The
 * public hairpin (container → Cloudflare → back) intermittently returned
 * HTTP 0 when the ~4.7 s cache-miss recompute brushed the 5 s fetch timeout.
 */
export function internalPerfPublicUrl(env: NodeJS.ProcessEnv = process.env): string {
  const port = env.PORT && /^\d+$/.test(env.PORT) ? env.PORT : '3000';
  return `http://127.0.0.1:${port}/api/performance-public`;
}

/**
 * OPS-PFE-PROBE-INDETERMINATE-W1 — the two verdicts this check can reach, kept
 * on SEPARATE alerting channels.
 *
 * `checkPfeWinRate` answers two different questions and used to report both
 * through the one `pfe_winrate` key:
 *
 *   BREACH      — measured, and the rate is below the floor. Operator-actionable
 *                 data integrity. Keeps its cycle-1 visibility.
 *   UNREADABLE  — could not measure at all. Says nothing about the win rate.
 *
 * Sharing one key is not merely untidy, it has a false-NEGATIVE path: `runCritical`
 * keys BOTH `consecutiveFails` and the 30-min `lastAlerted` dedup window on the
 * check key, so an UNREADABLE page at T would suppress a genuine win-rate page
 * until T+30min — the one alert this check exists to deliver. It is the
 * verdict-token law applied to an alert channel: a gate that can fail open must
 * not report "verified nothing" down the same wire as "verified, and it is bad."
 *
 * Exactly one field is non-null; `tests/unit/monitor-probe-alerts.test.ts` asserts it.
 */
export interface PfeProbeVerdict {
  /** Measured, below the floor → `pfe_winrate` channel, threshold 1. */
  breach: string | null;
  /** Could not measure → `pfe_probe` channel, sustained-only. */
  unreadable: string | null;
  /** The measured rate, or null when unknown OR unread. */
  rate: number | null;
}

/** The endpoint answered: the verdict is whatever the (unchanged) floor rule says. */
export function pfeReadVerdict(data: unknown): PfeProbeVerdict {
  const { error, rate } = evaluatePfeWinRate(data);
  return { breach: error, unreadable: null, rate };
}

/** The endpoint did not answer: INDETERMINATE. Never a win-rate claim, in either direction. */
export function pfeUnreadableVerdict(probeAlert: string): PfeProbeVerdict {
  return { breach: null, unreadable: probeAlert, rate: null };
}

/**
 * OPS-PFE-PROBE-INDETERMINATE-W1 CH3 — is this body one we can ADJUDICATE?
 *
 * `evaluatePfeWinRate` deliberately reports an unknown rate as "no error", and that
 * rule is right: a null `pfeWinRate` on a well-formed body means no matured data,
 * which is not a drop. But it cannot distinguish that from a body we never read.
 * `fetchJson`'s `res.json().catch(() => null)` turned an abort landing mid-body into
 * `{ ok: true, status: 200, data: null }`, and the check then reported VERIFIED CLEAN
 * and reset its counter — the exact "exit 0 encoding both 'verified, clean' and
 * 'verified nothing'" the token law forbids, reachable by the same 69.7 s degradation
 * that produced the 2026-09-01 page.
 *
 * So the two questions are separated: THIS one asks whether the payload is structurally
 * a performance body at all. Only if it is does the floor rule get to speak.
 * A present `overall` object with `pfeWinRate: null` is READABLE (and clean) — unchanged.
 */
export function isReadablePerfBody(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false;
  const overall = (data as { overall?: unknown }).overall;
  return typeof overall === 'object' && overall !== null;
}
