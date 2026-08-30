/**
 * GEO-EDGE-LOG-VISIBILITY-W1 — hermetic self-test for the edge crawler reporter.
 *
 * No network. The GraphQL fetch is the one thing this file cannot exercise, so per the
 * "a hermetic self-test is structurally blind to exactly what its own seam replaces" law it
 * also asserts the artifacts that seam bypasses: the window splitter that builds every request
 * URL's time range, the budget assertion that decides whether a run may start at all, and the
 * token redactor whose failure mode is a leak rather than a wrong number.
 *
 * EVERY FIXTURE ASSERTS ITS BRANCH'S DISTINCT OBSERVABLE, not merely a truthy result — the
 * discipline W3 arrived at. Two branches that return the same shape are indistinguishable to a
 * shape-only assertion, so a deliberate break can stay green while the logic is wrong.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_QUERIES_PER_WINDOW,
  MAX_RANGE_DAYS,
  RETENTION_DAYS,
  assertQueryBudget,
  parseGraphqlResponse,
  redactToken,
  splitWindow,
  withinRetention,
} from '../../scripts/lib/cf-graphql.mjs';
import {
  DISAPPEARED_DAYS,
  INSTRUMENT_EDGE,
  INSTRUMENT_ORIGIN,
  ORIGIN_VISIBLE_HOSTS,
  GROUPED_QUERY,
  assembleDailyRows,
  assembleReconcileRows,
  assembleUnmatched,
  detectDisappearedCrawlers,
  matchCrawler,
  parseOriginLog,
  statusClass,
} from '../../scripts/edge-crawler-report.mjs';

const ALLOWLIST = ['GPTBot', 'ClaudeBot', 'PerplexityBot'];
const META = { since: '2026-08-29T00:00:00Z', until: '2026-08-30T00:00:00Z',
               capturedAt: '2026-08-30T00:00:00Z', filter: 'test' };

const row = (ua: string, host: string, status: number, count: number, bytes = 0) => ({
  count, sum: { edgeResponseBytes: bytes },
  dimensions: { userAgent: ua, clientRequestHTTPHost: host, edgeResponseStatus: status },
});

describe('edge crawler reporter', () => {
  // --- fixture 1 -------------------------------------------------------------
  it('F1 a well-formed response becomes correct per-crawler, per-host, per-status rows', () => {
    const parsed = parseGraphqlResponse({
      data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: [
        row('GPTBot/1.1', 'algovault.com', 200, 10, 500),
        row('GPTBot/1.1', 'algovault.com', 404, 3, 60),
        row('ClaudeBot/1.0', 'api.algovault.com', 200, 7, 70),
      ] }] } },
    });
    expect(parsed.status).toBe('OK');
    const rows = assembleDailyRows(parsed.rows, ALLOWLIST, META);
    const gpt = rows.find((r) => r.crawler === 'GPTBot' && r.host === 'algovault.com')!;
    expect(gpt.requests).toBe(13);
    expect(gpt.status['2xx']).toBe(10);
    expect(gpt.status['4xx']).toBe(3);
    expect(gpt.bytes).toBe(560);
    const claude = rows.find((r) => r.crawler === 'ClaudeBot')!;
    expect(claude.host).toBe('api.algovault.com');
    expect(claude.requests).toBe(7);
  });

  // --- fixture 2 -------------------------------------------------------------
  it('F2 a 200 carrying a non-empty errors array is INDETERMINATE, never a zero', () => {
    const parsed = parseGraphqlResponse({
      errors: [{ message: 'zone does not have access to the field' }],
      data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: [row('GPTBot', 'algovault.com', 200, 99)] }] } },
    });
    expect(parsed.status).toBe('INDETERMINATE');
    expect(parsed.rows).toEqual([]);
    expect(parsed.reasons[0]).toContain('does not have access to the field');
  });

  // --- fixture 3 -------------------------------------------------------------
  it('F3 empty data with NO errors is a real zero, distinguishable from could-not-ask', () => {
    const parsed = parseGraphqlResponse({ data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: [] }] } } });
    expect(parsed.status).toBe('OK');
    expect(parsed.reasons).toEqual([]);
    const rows = assembleDailyRows(parsed.rows, ALLOWLIST, META);
    expect(rows).toHaveLength(ALLOWLIST.length);
    expect(rows.every((r) => r.zero_row === true && r.requests === 0)).toBe(true);
  });

  // --- fixture 4 -------------------------------------------------------------
  it('F4 a crawler absent from the response still emits an EXPLICIT zero row (R2.3)', () => {
    const rows = assembleDailyRows([row('GPTBot', 'algovault.com', 200, 5)], ALLOWLIST, META);
    const perplexity = rows.find((r) => r.crawler === 'PerplexityBot')!;
    expect(perplexity).toBeDefined();
    expect(perplexity.zero_row).toBe(true);
    expect(perplexity.requests).toBe(0);
    expect(perplexity.host).toBeNull();
    // and the present one is NOT marked as a zero row — the two must stay distinguishable
    expect(rows.find((r) => r.crawler === 'GPTBot')!.zero_row).toBeUndefined();
  });

  // --- fixture 5 -------------------------------------------------------------
  it('F5 a host the origin log cannot see reads `unavailable`, never 0 (R0.4)', () => {
    const edge = [row('x', 'algovault.com', 200, 100), row('x', 'api.algovault.com', 200, 900)];
    const origin = new Map([['algovault.com 2xx', 80]]);
    const rows = assembleReconcileRows(edge, origin);
    const apex = rows.find((r) => r.host === 'algovault.com')!;
    const api = rows.find((r) => r.host === 'api.algovault.com')!;
    expect(apex.origin_count).toBe(80);
    expect(apex.difference).toBe(20);
    expect(apex.origin_instrument).toBe(INSTRUMENT_ORIGIN);
    // The api host is NOT zero — it is structurally invisible, and the row says so.
    expect(api.origin_count).toBe('unavailable');
    expect(api.difference).toBeNull();
    expect(api.origin_instrument).toBeNull();
    expect(api.origin_note).toContain('structurally blind');
  });

  // --- fixture 6 -------------------------------------------------------------
  it('F6 a run that would exceed the query budget is REFUSED before any query is issued', () => {
    const over = assertQueryBudget(MAX_QUERIES_PER_WINDOW + 1);
    expect(over.ok).toBe(false);
    expect(over.reason).toContain('refusing to start');
    expect(assertQueryBudget(MAX_QUERIES_PER_WINDOW).ok).toBe(true);
    // A year-long window is exactly how this gets breached in practice: the zone caps a query
    // at one day, so the slice count IS the query count.
    const slices = splitWindow('2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z');
    expect(slices.length).toBe(365);
    expect(assertQueryBudget(slices.length).ok).toBe(false);
  });

  // --- fixture 7 -------------------------------------------------------------
  it('F7 the token never appears in any emitted string (R1.3)', () => {
    const token = 'sekret-token-value-0123456789abcdefghij';
    expect(redactToken(`Bearer ${token} failed`, token)).not.toContain(token);
    expect(redactToken(`Bearer ${token} failed`, token)).toContain('[REDACTED]');
    // Redaction must also survive the path nobody plans for: an error body echoing the header
    // when the caller did not pass the token in for substitution.
    expect(redactToken('authorization: Bearer abcdefghijklmnop', '')).toContain('Bearer [REDACTED]');
    expect(redactToken('nothing sensitive', token)).toBe('nothing sensitive');
  });

  // --- window splitting: the measured 1-day cap ------------------------------
  it('splitWindow honours the zone-measured 1-day maximum range', () => {
    expect(MAX_RANGE_DAYS).toBe(1);
    const s = splitWindow('2026-08-23T00:00:00Z', '2026-08-26T00:00:00Z');
    expect(s).toHaveLength(3);
    expect(s[0]).toEqual({ since: '2026-08-23T00:00:00Z', until: '2026-08-24T00:00:00Z' });
    expect(s[2].until).toBe('2026-08-26T00:00:00Z');
  });

  it('splitWindow returns zero slices for an inverted or unparseable range, never one bad query', () => {
    expect(splitWindow('2026-08-26T00:00:00Z', '2026-08-23T00:00:00Z')).toEqual([]);
    expect(splitWindow('not-a-date', '2026-08-23T00:00:00Z')).toEqual([]);
    expect(splitWindow('2026-08-23T00:00:00Z', '2026-08-23T00:00:00Z')).toEqual([]);
  });

  // --- retention -------------------------------------------------------------
  it('withinRetention refuses a window past the MEASURED floor and names its age', () => {
    const now = Date.parse('2026-08-30T00:00:00Z');
    expect(RETENTION_DAYS).toBe(7);
    expect(withinRetention('2026-08-25T00:00:00Z', now).ok).toBe(true);
    const old = withinRetention('2026-08-20T00:00:00Z', now);
    expect(old.ok).toBe(false);
    expect(old.reason).toContain('past the measured 7d retention floor');
    expect(withinRetention('rubbish', now).reason).toContain('unparseable since');
  });

  // --- transport / shape failures are INDETERMINATE, each on its own branch ---
  it('a non-200 HTTP status is INDETERMINATE on its own branch', () => {
    const r = parseGraphqlResponse({}, { httpStatus: 503 });
    expect(r.status).toBe('INDETERMINATE');
    expect(r.reasons[0]).toContain('HTTP 503');
  });

  it('a non-object body is INDETERMINATE on its own branch', () => {
    expect(parseGraphqlResponse(null).reasons[0]).toContain('not a JSON object');
  });

  it('a body with no viewer.zones array is INDETERMINATE on its own branch', () => {
    expect(parseGraphqlResponse({ data: {} }).reasons[0]).toContain('no viewer.zones array');
  });

  // --- crawler matching ------------------------------------------------------
  it('matchCrawler is case-insensitive substring, matching the robots gate rule', () => {
    expect(matchCrawler('Mozilla/5.0 (compatible; GPTBot/1.1; +https://openai.com)', ALLOWLIST)).toBe('GPTBot');
    expect(matchCrawler('gptbot', ALLOWLIST)).toBe('GPTBot');
    expect(matchCrawler('curl/8.7.1', ALLOWLIST)).toBeNull();
    expect(matchCrawler('', ALLOWLIST)).toBeNull();
    expect(matchCrawler(undefined, ALLOWLIST)).toBeNull();
  });

  it('non-allowlisted traffic is REPORTED per host, not silently dropped', () => {
    const rows = [row('curl/8.7.1', 'algovault.com', 404, 12), row('GPTBot', 'algovault.com', 200, 1)];
    const un = assembleUnmatched(rows, ALLOWLIST, {});
    expect(un).toHaveLength(1);
    expect(un[0]).toMatchObject({ host: 'algovault.com', requests: 12, instrument: INSTRUMENT_EDGE });
  });

  // --- instrument labelling --------------------------------------------------
  it('every emitted row carries its instrument (R2.1) and the filter used', () => {
    const rows = assembleDailyRows([row('GPTBot', 'algovault.com', 200, 1)], ALLOWLIST, META);
    expect(rows.every((r) => r.instrument === INSTRUMENT_EDGE)).toBe(true);
    expect(rows.every((r) => r.filter === 'test' && r.since === META.since)).toBe(true);
    expect(ORIGIN_VISIBLE_HOSTS).toEqual(['algovault.com']);
  });

  // --- status classing -------------------------------------------------------
  it('statusClass buckets by hundreds and refuses to invent a class', () => {
    expect(statusClass(200)).toBe('2xx');
    expect(statusClass(301)).toBe('3xx');
    expect(statusClass(429)).toBe('4xx');
    expect(statusClass(503)).toBe('5xx');
    expect(statusClass(0)).toBe('other');
    expect(statusClass('nonsense')).toBe('other');
  });

  // --- origin log parsing ----------------------------------------------------
  it('parseOriginLog counts only records inside the window and skips unparseable lines', () => {
    const lines = [
      JSON.stringify({ ts: Date.parse('2026-08-29T12:00:00Z') / 1000, status: 200, request: { host: 'algovault.com' } }),
      JSON.stringify({ ts: Date.parse('2026-08-29T13:00:00Z') / 1000, status: 404, request: { host: 'algovault.com' } }),
      JSON.stringify({ ts: Date.parse('2026-08-01T00:00:00Z') / 1000, status: 200, request: { host: 'algovault.com' } }),
      'not json at all',
    ].join('\n');
    const { counts, parsed } = parseOriginLog(lines, META);
    expect(parsed).toBe(2);
    expect(counts.get('algovault.com 2xx')).toBe(1);
    expect(counts.get('algovault.com 4xx')).toBe(1);
  });

  // --- R5.3 alarm ------------------------------------------------------------
  it('R5.3 a crawler at zero for 3 consecutive days after being present ALARMS', () => {
    const day = (n: number) => ({ rows: [{ crawler: 'GPTBot', requests: n }, { crawler: 'ClaudeBot', requests: 5 }] });
    const series = [day(10), day(8), day(9), day(0), day(0), day(0)];
    const gone = detectDisappearedCrawlers(series);
    expect(DISAPPEARED_DAYS).toBe(3);
    expect(gone).toHaveLength(1);
    expect(gone[0].crawler).toBe('GPTBot');
    expect(gone[0].last_seen_requests).toBe(10);
  });

  it('a crawler quiet for only 2 days does NOT alarm — the threshold is real', () => {
    const day = (n: number) => ({ rows: [{ crawler: 'GPTBot', requests: n }] });
    expect(detectDisappearedCrawlers([day(10), day(8), day(9), day(4), day(0), day(0)])).toEqual([]);
  });

  it('a crawler that was NEVER present cannot disappear, and is not alarmed on', () => {
    const day = () => ({ rows: [{ crawler: 'GPTBot', requests: 0 }] });
    expect(detectDisappearedCrawlers([day(), day(), day(), day(), day(), day()])).toEqual([]);
  });

  it('the alarm only looks at the trailing 7 days — older presence cannot resurrect it', () => {
    // Added because the break harness found this branch UNTESTED: every other fixture has <= 7
    // records, so `slice(-window)` was a no-op in all of them and disabling it failed nothing.
    // Here the crawler was busy 10 days ago and silent since. Windowed, `head` sees only zeros,
    // so there is nothing to have disappeared FROM and no alarm fires. Unwindowed, the ancient
    // traffic would make it look like a fresh disappearance every day, forever.
    const day = (n: number) => ({ rows: [{ crawler: 'GPTBot', requests: n }] });
    const series = [day(50), day(40), day(30), day(0), day(0), day(0), day(0), day(0), day(0), day(0)];
    expect(series).toHaveLength(10);
    expect(detectDisappearedCrawlers(series)).toEqual([]);
    // ...and the same series WITHOUT the window would alarm, which is what makes this a real test
    expect(detectDisappearedCrawlers(series, { window: 10 })).toHaveLength(1);
  });

  it('too little history to claim a disappearance yields no alarm, not a false one', () => {
    const day = (n: number) => ({ rows: [{ crawler: 'GPTBot', requests: n }] });
    expect(detectDisappearedCrawlers([day(10), day(0), day(0)])).toEqual([]);
  });

  // --- bypassed-seam assertions ---------------------------------------------
  it('the reporter emits NO verdict token and gates nothing (R5.2, AC14)', () => {
    // A reporting failure must never read as a policy failure. If a future edit adds a verdict
    // token here, the daily cron becomes something a caller can gate on — which is exactly the
    // conflation that would blunt the robots allowlist gate.
    const { readFileSync } = require('node:fs');
    const { join } = require('node:path');
    const root = join(__dirname, '..', '..');
    for (const f of ['scripts/edge-crawler-report.mjs', 'scripts/lib/cf-graphql.mjs']) {
      const src = readFileSync(join(root, f), 'utf8');
      expect(src).not.toMatch(/_VERDICT=/);
    }
  });

  it('Logpush is not reached for anywhere in the implementation (AC1)', () => {
    // Enterprise-only, and this zone is Free. A mention in a docblock explaining the absence is
    // documentation; an invocation would be fiction. Assert on comment-STRIPPED source, the
    // same invocation-vs-mention rule the repo's other ban-greps use.
    const { readFileSync } = require('node:fs');
    const { join } = require('node:path');
    const root = join(__dirname, '..', '..');
    for (const f of ['scripts/edge-crawler-report.mjs', 'scripts/lib/cf-graphql.mjs']) {
      const code = readFileSync(join(root, f), 'utf8')
        .split('\n').filter((l: string) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
      expect(code.toLowerCase()).not.toContain('logpush');
    }
  });

  it('the filters this plan REFUSES are absent from every query the reporter sends', () => {
    // botDetectionIds_hasany and clientRefererHost_like were measured rejected on this zone.
    // A future edit adding either would make every run INDETERMINATE, silently.
    const { readFileSync } = require('node:fs');
    const { join } = require('node:path');
    // Assert the QUERY TEXT, not the whole file: `botDetectionIds_hasany` legitimately appears
    // in the report's `identification` string, which is honest documentation of a limit rather
    // than a filter being sent. Testing the file would have forced deleting that disclosure.
    expect(GROUPED_QUERY).not.toContain('botDetectionIds_hasany');
    expect(GROUPED_QUERY).not.toContain('clientRefererHost_like');
    // ...and the filters it DOES send are all ones this zone was measured to accept.
    for (const f of ['datetime_geq', 'datetime_lt']) expect(GROUPED_QUERY).toContain(f);
    for (const d of ['userAgent', 'clientRequestHTTPHost', 'edgeResponseStatus']) {
      expect(GROUPED_QUERY).toContain(d);
    }
  });
});
