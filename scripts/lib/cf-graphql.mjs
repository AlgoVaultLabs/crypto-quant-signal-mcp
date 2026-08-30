#!/usr/bin/env node
/**
 * GEO-EDGE-LOG-VISIBILITY-W1 — minimal Cloudflare GraphQL Analytics client.
 *
 * WHY THIS EXISTS AND WHAT IT IS NOT. Logpush is Enterprise-only and this zone is Free, so the
 * only edge-side instrument reachable here is the GraphQL Analytics API. Logpush appears
 * nowhere in this wave, deliberately — a design reaching for it would be fictional.
 *
 * THIS IS A REPORTER'S CLIENT, NOT A GATE'S. It emits no `*_VERDICT` token and blocks nothing.
 * A reporting failure is not a policy failure, and conflating the two would degrade the
 * robots-allowlist gate whose RED means "crawl policy broken".
 *
 * FOUR LIMITS, ALL MEASURED ON THIS ZONE 2026-08-30 — not read off the docs:
 *   1. 300 queries / 5-minute window (documented; enforced here before issuing, not after).
 *   2. A query may not span more than ONE DAY. Measured: a 1w9h57m range is refused with
 *      `cannot request a time range wider than 1d`. Every window is therefore SLICED.
 *   3. Retention `notOlderThan` = 691200s (8d nominal); empirically T-7d answers and T-8d is
 *      refused with `cannot request data`. Ask the zone, never assume.
 *   4. `botDetectionIds_hasany` and `clientRefererHost_like` are REFUSED on this plan
 *      (`does not have access to the field`). UA matching is the only crawler lever here,
 *      and Cloudflare's own docs call user agents spoofable. That caveat travels with every
 *      number this client produces.
 */
import { setTimeout as sleep } from 'node:timers/promises';

export const GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
/** Documented limit. The budget is asserted BEFORE issuing, so a run refuses rather than 429s. */
export const MAX_QUERIES_PER_WINDOW = 300;
export const RATE_WINDOW_MS = 5 * 60 * 1000;
/** Measured, not documented: this zone refuses any range wider than one day. */
export const MAX_RANGE_DAYS = 1;
/** Measured: T-7d answers, T-8d is refused. Nominal notOlderThan is 8d; this is the usable floor. */
export const RETENTION_DAYS = 7;
export const GROUP_LIMIT = 10000;
const DAY_MS = 86400000;

/**
 * Slice [since, until) into <= MAX_RANGE_DAYS pieces. PURE.
 * Returns [] for an empty or inverted range — the caller reports zero slices rather than
 * silently issuing a query for a window that does not exist.
 */
export function splitWindow(sinceIso, untilIso, maxDays = MAX_RANGE_DAYS) {
  const s = Date.parse(sinceIso);
  const u = Date.parse(untilIso);
  if (Number.isNaN(s) || Number.isNaN(u) || u <= s) return [];
  const step = maxDays * DAY_MS;
  const out = [];
  for (let cur = s; cur < u; cur += step) {
    out.push({ since: new Date(cur).toISOString().replace(/\.\d{3}Z$/, 'Z'),
               until: new Date(Math.min(cur + step, u)).toISOString().replace(/\.\d{3}Z$/, 'Z') });
  }
  return out;
}

/**
 * Refuse a run that WOULD breach the rate limit, before a single query is issued. PURE.
 * Refusing beforehand beats discovering it at query 301: a partial result that stops mid-run
 * is indistinguishable from a complete one once it is written to the series.
 */
export function assertQueryBudget(planned, max = MAX_QUERIES_PER_WINDOW) {
  if (planned > max) {
    return { ok: false, planned, max,
      reason: `refusing to start: ${planned} queries planned exceeds the ${max}-per-${RATE_WINDOW_MS / 60000}min limit` };
  }
  return { ok: true, planned, max };
}

/** Is this window reachable at all, given measured retention? PURE. */
export function withinRetention(sinceIso, nowMs, days = RETENTION_DAYS) {
  const s = Date.parse(sinceIso);
  if (Number.isNaN(s)) return { ok: false, reason: `unparseable since: ${sinceIso}` };
  const ageDays = (nowMs - s) / DAY_MS;
  if (ageDays > days) {
    return { ok: false, ageDays: Math.floor(ageDays),
      reason: `window starts ${Math.floor(ageDays)}d ago, past the measured ${days}d retention floor` };
  }
  return { ok: true, ageDays: Math.floor(ageDays) };
}

/**
 * Strip the token from anything about to be printed. PURE.
 * Called on EVERY emitted string, not only the ones expected to contain it — an error body
 * echoing the Authorization header is exactly the path nobody anticipates.
 */
export function redactToken(text, token) {
  let s = String(text ?? '');
  // Token-specific substitution FIRST, when we have one to substitute.
  if (token) s = s.split(token).join('[REDACTED]');
  // Then the safety net, ALWAYS — including when no token was passed in. An early return here
  // was a real leak path: an error body echoing `authorization: Bearer <value>` reaches a
  // caller that has no token to hand (a transport failure before the token is in scope), and
  // an unconditional early return would have printed it verbatim. Caught by this file's own
  // fixture 7, which is the whole reason that fixture asserts the no-token case.
  return s.replace(/Bearer\s+[A-Za-z0-9_.:~+/=-]{8,}/gi, 'Bearer [REDACTED]');
}

/**
 * Classify one GraphQL response. PURE.
 *
 * A Cloudflare GraphQL 200 can carry a NON-EMPTY `errors` array alongside partial `data`.
 * Treating that as data is how a partial result becomes a published zero. Same rule as the
 * W1 robots gate: input we could not fully retrieve is INDETERMINATE, never a clean result.
 *
 * The distinction that matters and is easy to lose: `data` present with an EMPTY rows array
 * and NO errors is a real, complete answer meaning "nothing happened" — that is a zero, and
 * it must stay distinguishable from "we could not ask".
 */
export function parseGraphqlResponse(body, { httpStatus = 200 } = {}) {
  if (httpStatus !== 200) {
    return { status: 'INDETERMINATE', rows: [], reasons: [`HTTP ${httpStatus} from the analytics endpoint`] };
  }
  if (body == null || typeof body !== 'object') {
    return { status: 'INDETERMINATE', rows: [], reasons: ['response body was not a JSON object'] };
  }
  const errors = Array.isArray(body.errors) ? body.errors : [];
  if (errors.length > 0) {
    return { status: 'INDETERMINATE', rows: [],
      reasons: errors.map((e) => String(e?.message ?? e)).slice(0, 5) };
  }
  const zones = body?.data?.viewer?.zones;
  if (!Array.isArray(zones)) {
    return { status: 'INDETERMINATE', rows: [], reasons: ['response carried no viewer.zones array'] };
  }
  const rows = zones.flatMap((z) => z?.httpRequestsAdaptiveGroups ?? []);
  return { status: 'OK', rows, reasons: [] };
}

/** One POST. Never logs the token; every thrown message is redacted before it escapes. */
export async function queryGraphql(query, variables, { token, fetchImpl = fetch, timeoutMs = 60000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(GRAPHQL_ENDPOINT, {
      method: 'POST',
      signal: ac.signal,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text().catch(() => '');
    let body = null;
    try { body = JSON.parse(text); } catch { /* parseGraphqlResponse reports it */ }
    return parseGraphqlResponse(body, { httpStatus: res.status });
  } catch (err) {
    return { status: 'INDETERMINATE', rows: [],
      reasons: [redactToken(`request failed: ${err?.name ?? 'Error'}: ${err?.message ?? err}`, token)] };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Run one query per window slice, accumulating rows. Throttles to <=1/s.
 *
 * ANY slice landing INDETERMINATE makes the WHOLE run INDETERMINATE. Partial coverage silently
 * reported as a total is the defect this rule exists to prevent — a missing day looks exactly
 * like a quiet day once the numbers are summed.
 */
export async function queryWindow(query, { zoneTag, since, until, token, extra = {},
                                           fetchImpl = fetch, throttleMs = 1000, now = Date.now() } = {}) {
  const slices = splitWindow(since, until);
  const budget = assertQueryBudget(slices.length);
  if (!budget.ok) return { status: 'REFUSED', rows: [], queriesIssued: 0, slices: slices.length, reasons: [budget.reason] };
  const retention = withinRetention(since, now);
  const reasons = retention.ok ? [] : [retention.reason];

  const rows = [];
  let issued = 0;
  let status = slices.length === 0 ? 'INDETERMINATE' : 'OK';
  if (slices.length === 0) reasons.push(`window [${since}, ${until}) produced zero slices`);

  for (const slice of slices) {
    if (issued > 0 && throttleMs > 0) await sleep(throttleMs);
    const r = await queryGraphql(query, { zoneTag, since: slice.since, until: slice.until, ...extra },
                                 { token, fetchImpl });
    issued += 1;
    if (r.status !== 'OK') {
      status = 'INDETERMINATE';
      reasons.push(`slice ${slice.since}: ${r.reasons.join('; ')}`);
      continue;
    }
    for (const row of r.rows) rows.push({ ...row, _slice: slice.since });
  }
  return { status, rows, queriesIssued: issued, slices: slices.length, reasons };
}
