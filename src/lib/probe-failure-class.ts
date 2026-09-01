/**
 * probe-failure-class — OPS-MONITOR-TRANSIENT-CLASSIFY-W1
 *
 * The ONE place that decides whether a monitoring / self-audit probe failure is
 * TRANSIENT ("could not measure / ambiguous read") or CONFIRMED ("measured, the
 * adverse state is real"). Every alerting decision projects from this single
 * classifier so the two can never be conflated again.
 *
 * ## Why this exists (the generator fix)
 *
 * A transient read — HTTP 429, a 5xx, an `ECONNRESET` on a Postgres socket
 * during a container recreate, a DNS blip — is NOT a confirmed adverse state.
 * Paging on a single such failure violates the operator law "TG fires ONLY on
 * sustained / accumulating drift" and the codebase's own "429 = rate-limited but
 * alive" rule (monitor.ts checkExchangeHealth). This class has been lane-fixed
 * three times already, each on ONE check:
 *
 *   1. `exchanges` transient flap        → 3-cycle consecutive gate
 *   2. `gas_wallet` under-reporting RPC   → 2-RPC quorum (OPS-GAS-WALLET-RPC-QUORUM-W1)
 *   3. `pfe_winrate` loopback abort       → 3x in-process fetch retry
 *
 * `backfill` (monitor) + the forum self-audit are the 4th instance — both fired
 * 2026-07-24 (a Postgres `read ECONNRESET` during a deploy recreate; a dev.to
 * `http-429` on a verify GET counted as a "silently dropped" post). Per
 * CLAUDE.md the 4th same-root-cause incident MUST upgrade to a generator that
 * makes the class structurally impossible: classify ONCE, then
 *
 *   - `effectiveFailThreshold` floors a transient monitor failure to
 *     >= TRANSIENT_MIN_CYCLES consecutive cron cycles (never a cycle-1 page),
 *     regardless of the check's own threshold — applies to EVERY current and
 *     future check through the single `runCritical` chokepoint;
 *   - the forum self-audit treats a transient verify failure as
 *     INDETERMINATE (retry next audit), never as drift; a genuinely
 *     unverifiable post is escalated only after INDETERMINATE_ESCALATE_STREAK
 *     consecutive daily audits, with honest "could not verify" framing.
 *
 * A CONFIRMED adverse state (queue depth over threshold, a 404 / not-published
 * post, a real win-rate drop) is unaffected and still pages per policy. The
 * default for an unknown reason is `confirmed` — we never silently swallow a
 * novel real breach; the worst case is a 1-cycle / 1-day-slower page, caught by
 * the consecutive gate.
 *
 * Pure + dependency-free ⇒ unit-tested in isolation (tests/unit/probe-failure-class.test.ts).
 *
 * ## The gap this generator itself had — OPS-PFE-PROBE-INDETERMINATE-W1 (2026-09-01)
 *
 * The generator above was correct and still did not fire, for the check named
 * in its own lane-fix list. `extractHttpStatus` required THREE digits, and the
 * failure string every `fetchJson()` throw produces is `HTTP 0` — one digit.
 * So the classifier was blind to the single commonest could-not-measure marker
 * in the codebase and returned `confirmed`, and `pfe_winrate` (threshold 1)
 * paged at consecutive=1 on a healthy endpoint that self-healed two minutes
 * later.
 *
 * The lesson is about the FIXTURE, not the logic: this module's suite asserted
 * the PFE sentence with `HTTP 503` — a status that path had produced twice in
 * three weeks — and never with the status the code emits on every abort. A
 * classifier's test corpus must be drawn from what its PRODUCERS actually
 * output, not from what reads plausibly. The producers are now declared once in
 * `src/scripts/monitor-probe-alerts.ts` and enumerated by
 * `tests/unit/monitor-probe-alerts.test.ts`, so a new probe alert is classified
 * the day it is written rather than the day it pages.
 */

export type ProbeFailureClass = 'transient' | 'confirmed';

/**
 * Minimum consecutive cron cycles a TRANSIENT monitor failure must persist
 * before it is allowed to page. Cron runs every 2 min, so 2 ⇒ ~4 min of
 * sustained failure. A single deploy-churn blip self-heals next cycle.
 */
export const TRANSIENT_MIN_CYCLES = 2;

/**
 * Consecutive daily audits a forum post must stay UNVERIFIABLE (transient
 * verify failure each time, never confirmed-absent) before the honest
 * sustained-indeterminate escalation fires. 3 ⇒ ~3 days of a platform
 * rate-limiting our verification probe — operator-actionable, not "dropped".
 */
export const INDETERMINATE_ESCALATE_STREAK = 3;

/**
 * Lowercased substrings that mark a failure as transient / could-not-measure.
 * Network errno, socket/fetch phrasings, Postgres transport + pool exhaustion
 * (the zombie-connection + deploy-recreate class), and parse errors (a body was
 * received but was unreadable ⇒ the entity almost certainly exists).
 */
const TRANSIENT_TOKENS: readonly string[] = [
  // Node network errno
  'econnreset', 'econnrefused', 'etimedout', 'econnaborted', 'epipe',
  'eai_again', 'enotfound', 'enetunreach', 'ehostunreach', 'ehostdown',
  // socket / fetch / abort phrasings
  'socket hang up', 'socket disconnected', 'network-error', 'network error',
  'fetch failed', 'request timed out', 'timed out', 'timeout',
  'the operation was aborted', 'operation was aborted', 'aborted',
  // Postgres transport + pool (deploy recreate, OOM, zombie-connection saturation)
  'connection terminated', 'terminating connection', 'connection reset',
  'server closed the connection', 'too many clients',
  // body received but unreadable ⇒ entity exists, retry
  'parse-error', 'unexpected end of json', 'unexpected token',
];

/**
 * HTTP status codes meaning "retry / ambiguous", NOT "confirmed absent".
 * 404 / 410 are deliberately EXCLUDED — they are the confirmed-drop signal.
 * All 5xx are transient (handled separately). 401 / 403 are auth-ambiguous: a
 * removed post returns 404 / 410 / unpublished, and 403 is the classic
 * headless-probe block (e.g. Hashnode-on-Vercel), so treat as could-not-verify.
 */
const TRANSIENT_HTTP: ReadonlySet<number> = new Set([401, 403, 408, 425, 429]);

function nodeCode(input: object): string {
  const code = (input as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

/** Build a lowercased haystack from a string, Error (message + code + cause), or anything. */
function haystack(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input.toLowerCase();
  if (input instanceof Error) {
    const cause = (input as { cause?: unknown }).cause;
    const causeStr =
      cause instanceof Error ? `${cause.message} ${nodeCode(cause)}`
      : typeof cause === 'string' ? cause
      : '';
    return `${input.message} ${nodeCode(input)} ${causeStr}`.toLowerCase();
  }
  try {
    return String(input).toLowerCase();
  } catch {
    return '';
  }
}

/**
 * First HTTP status mentioned in the text ("http-429", "HTTP 503", "http_404")
 * — or the NON-status a probe reports when the fetch threw ("HTTP 0").
 *
 * OPS-PFE-PROBE-INDETERMINATE-W1: this matched `\d{3}` and therefore could not
 * see `HTTP 0`, which is `monitor.ts fetchJson()`'s universal "the fetch threw"
 * sentinel (`FETCH_THROW_STATUS`) and so the most common failure string the
 * monitor emits. The one classifier built to stop could-not-measure being
 * conflated with confirmed-adverse was blind to the commonest could-not-measure
 * marker in the codebase, and on 2026-09-01 06:44:01Z it paged a healthy
 * `/api/performance-public` at consecutive=1. The suite had tested this exact
 * PFE sentence with `HTTP 503` and never with the status the code produces.
 *
 * `\d{1,3}` with a trailing `\b` is STRICTLY better than `\d{3}`, not merely
 * wider: "http 4041" previously mis-parsed as 404, and now matches nothing.
 */
function extractHttpStatus(text: string): number | null {
  const m = text.match(/http[\s_-]?(\d{1,3})\b/);
  return m ? Number(m[1]) : null;
}

/**
 * A value below 100 is not an HTTP status at all — it is a probe reporting that
 * it never got a response. That is could-not-measure by construction, which is
 * the definition of transient, and it is a stronger statement than any token
 * match: it holds whatever the underlying errno turned out to be.
 */
const NOT_A_STATUS_CEILING = 100;

/**
 * Classify a probe failure. Accepts the composed error string a check returns,
 * a raw verify `reason`, or an Error object. Transient is an explicit allowlist;
 * everything else — including 404 / 410 and every domain reason — is `confirmed`.
 */
export function classifyProbeFailure(input: unknown): ProbeFailureClass {
  const text = haystack(input);
  if (!text) return 'confirmed';
  if (TRANSIENT_TOKENS.some((t) => text.includes(t))) return 'transient';
  const status = extractHttpStatus(text);
  if (status != null && (status < NOT_A_STATUS_CEILING || TRANSIENT_HTTP.has(status) || status >= 500)) {
    return 'transient';
  }
  return 'confirmed';
}

/**
 * The consecutive-cycle threshold a monitor check must actually cross before it
 * pages, given its base threshold and this cycle's error. A transient failure is
 * floored to TRANSIENT_MIN_CYCLES so a single blip can never page; a confirmed
 * breach keeps its configured threshold (including 1). `null`/absent error (the
 * check passed) passes straight through.
 */
export function effectiveFailThreshold(
  baseThreshold: number,
  error: string | null | undefined,
): number {
  if (!error) return baseThreshold;
  return classifyProbeFailure(error) === 'transient'
    ? Math.max(baseThreshold, TRANSIENT_MIN_CYCLES)
    : baseThreshold;
}

/** True once a post has been unverifiable (transient) for >= INDETERMINATE_ESCALATE_STREAK audits. */
export function shouldEscalateIndeterminate(streak: number): boolean {
  return streak >= INDETERMINATE_ESCALATE_STREAK;
}
