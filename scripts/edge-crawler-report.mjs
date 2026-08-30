#!/usr/bin/env node
/**
 * GEO-EDGE-LOG-VISIBILITY-W1 — edge-side AI-crawler visibility reporter. Wave 4 of 4, arc close.
 *
 * WHAT THIS RETIRES: "a GEO claim rests on a number a human read off a dashboard." Until now
 * every figure about AI-Discovery Visibility — the program's north star — came from a
 * screenshot. This makes it queryable, repeatable and diffable.
 *
 *   node scripts/edge-crawler-report.mjs --daily
 *   node scripts/edge-crawler-report.mjs --reconcile --since <ISO> --until <ISO> [--origin-log <path>]
 *
 * IT IS A REPORTER, NOT A GATE. It emits NO `*_VERDICT` token and blocks nothing. The robots
 * allowlist gate's RED means "crawl policy is broken"; a failure to fetch analytics is not
 * that, and folding one into the other would blunt the gate. Its single alarm — a crawler that
 * STOPPED arriving — is severity-gated and carries no auto-recovery arm, because the response
 * to a crawler leaving is investigation, never a mutation.
 *
 * INSTRUMENT LABELLING IS THE POINT, NOT DECORATION. Every row carries `instrument`. A bare
 * "573 vs 1" is a FORBIDDEN output shape: the two numbers came from different instruments
 * measuring different populations over different host sets, and a delta across two instruments
 * is not a delta. The origin column is `unavailable` — never `0` — wherever Caddy structurally
 * cannot see the traffic, which is every host but the apex (its access log is declared INSIDE
 * the `algovault.com { }` site block).
 *
 * HONEST LIMIT, STATED IN EVERY REPORT: on this plan `botDetectionIds_hasany` is REFUSED, so
 * crawler identification here is USER-AGENT MATCHING, which Cloudflare's own documentation
 * calls spoofable. The dashboard may classify using verified detection IDs we cannot query.
 * This reconstruction is therefore an APPROXIMATION of the dashboard's population, not an
 * identity, and must never be presented as one.
 *
 * The crawler list is NOT forked: it is read from `AI_CRAWLER_ALLOWLIST` via the same text
 * reader W1-W3 use, making this the FOURTH consumer of that one constant.
 */
import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ALLOWLIST_SOURCE, readAllowlistFromSource } from './check-robots-ai-allowlist.mjs';
import { GROUP_LIMIT, MAX_QUERIES_PER_WINDOW, RETENTION_DAYS, assertQueryBudget,
         queryWindow, redactToken, splitWindow, withinRetention } from './lib/cf-graphql.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..');
export const SERIES_DIR = process.env.EDGE_CRAWLER_DIR || '/var/lib/algovault-monitoring/edge-crawler';
export const SERIES_FILE = 'daily-series.ndjson';
export const INSTRUMENT_EDGE = 'edge:graphql';
export const INSTRUMENT_ORIGIN = 'origin:caddy';
/** Consecutive zero-days that make a previously-present crawler an alarm. */
export const DISAPPEARED_DAYS = 3;
/** The apex is the ONLY host Caddy's access log can see — the log lives in its site block. */
export const ORIGIN_VISIBLE_HOSTS = Object.freeze(['algovault.com']);
/** Reconcile keys are `<host> <status_class>`; a SPACE separator, never a raw NUL byte. */
export const KEY_SEP = ' ';

export const GROUPED_QUERY = `query($zoneTag:String!,$since:Time!,$until:Time!){
  viewer { zones(filter:{zoneTag:$zoneTag}) {
    httpRequestsAdaptiveGroups(limit:${GROUP_LIMIT}, filter:{datetime_geq:$since, datetime_lt:$until}) {
      count
      sum { edgeResponseBytes }
      dimensions { userAgent clientRequestHTTPHost edgeResponseStatus }
    } } } }`;

/** 2xx/3xx/4xx/5xx, or `other` for anything outside 100-599. PURE. */
export function statusClass(status) {
  const n = Number(status);
  if (!Number.isFinite(n) || n < 100 || n > 599) return 'other';
  return `${Math.floor(n / 100)}xx`;
}

/**
 * Which allowlisted crawler does this UA string name? PURE.
 *
 * Case-insensitive substring, matching RFC 9309 §2.2.1's case-insensitive product-token rule
 * and the same comparison the robots gate uses — so "measured by this reporter" and "allowed
 * by our robots.txt" cannot mean two different populations.
 *
 * Returns null for an unmatched UA. Those are counted separately rather than dropped: a
 * crawler arriving that is NOT on our allowlist is a finding, and silently discarding it
 * would make the report structurally unable to tell us about it.
 */
export function matchCrawler(userAgent, allowlist) {
  const ua = String(userAgent ?? '').toLowerCase();
  if (!ua) return null;
  for (const name of allowlist) {
    if (ua.includes(String(name).toLowerCase())) return name;
  }
  return null;
}

/**
 * Fold raw grouped rows into one row per (crawler, host). PURE.
 *
 * R2.3: a crawler with zero requests emits an EXPLICIT ZERO ROW. An absent row and a zero row
 * must be distinguishable — "we did not look" and "we looked and it was zero" are different
 * facts, and only one of them is information.
 */
export function assembleDailyRows(rawRows, allowlist, { since, until, capturedAt, filter }) {
  const byKey = new Map();
  for (const r of rawRows ?? []) {
    const d = r?.dimensions ?? {};
    const crawler = matchCrawler(d.userAgent, allowlist);
    if (!crawler) continue;
    const host = d.clientRequestHTTPHost ?? '(unknown)';
    const cls = statusClass(d.edgeResponseStatus);
    const key = `${crawler}${KEY_SEP}${host}`;
    const row = byKey.get(key) ?? {
      crawler, host, requests: 0, bytes: 0,
      status: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 },
    };
    row.requests += Number(r?.count ?? 0);
    row.bytes += Number(r?.sum?.edgeResponseBytes ?? 0);
    row.status[cls] += Number(r?.count ?? 0);
    byKey.set(key, row);
  }
  const rows = [...byKey.values()];
  // Explicit zero row per crawler that produced nothing anywhere in the window.
  const seen = new Set(rows.map((r) => r.crawler));
  for (const name of allowlist) {
    if (seen.has(name)) continue;
    rows.push({ crawler: name, host: null, requests: 0, bytes: 0,
      status: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 }, zero_row: true });
  }
  return rows
    .map((r) => ({ ...r, instrument: INSTRUMENT_EDGE, since, until, captured_at: capturedAt, filter }))
    .sort((a, b) => b.requests - a.requests || String(a.crawler).localeCompare(String(b.crawler)));
}

/** Unmatched (non-allowlisted) traffic, per host. PURE. Reported, never silently dropped. */
export function assembleUnmatched(rawRows, allowlist, meta) {
  const byHost = new Map();
  for (const r of rawRows ?? []) {
    const d = r?.dimensions ?? {};
    if (matchCrawler(d.userAgent, allowlist)) continue;
    const host = d.clientRequestHTTPHost ?? '(unknown)';
    byHost.set(host, (byHost.get(host) ?? 0) + Number(r?.count ?? 0));
  }
  return [...byHost.entries()]
    .map(([host, requests]) => ({ host, requests, instrument: INSTRUMENT_EDGE, ...meta }))
    .sort((a, b) => b.requests - a.requests);
}

/**
 * Reconciliation rows: one per (host, status_class), both instruments side by side. PURE.
 *
 * `originCounts` is a Map keyed `<host> <status_class>`. A host Caddy cannot see yields
 * `origin_count: 'unavailable'` and `difference: null` — NEVER `0`, and never a subtraction
 * against a number that does not exist. R0.4's rule: an absent log is not a zero.
 */
export function assembleReconcileRows(edgeRows, originCounts, { originVisibleHosts = ORIGIN_VISIBLE_HOSTS } = {}) {
  const byKey = new Map();
  for (const r of edgeRows ?? []) {
    const d = r?.dimensions ?? {};
    const host = d.clientRequestHTTPHost ?? '(unknown)';
    const cls = statusClass(d.edgeResponseStatus);
    const key = `${host}${KEY_SEP}${cls}`;
    byKey.set(key, (byKey.get(key) ?? 0) + Number(r?.count ?? 0));
  }
  const out = [];
  for (const [key, edge] of byKey) {
    const [host, cls] = key.split(KEY_SEP);
    const visible = originVisibleHosts.includes(host);
    const origin = visible ? (originCounts?.get?.(key) ?? 0) : 'unavailable';
    out.push({
      host, status_class: cls,
      edge_count: edge, edge_instrument: INSTRUMENT_EDGE,
      origin_count: origin, origin_instrument: visible ? INSTRUMENT_ORIGIN : null,
      difference: typeof origin === 'number' ? edge - origin : null,
      origin_note: visible ? null
        : 'Caddy access log is declared inside the algovault.com site block and is structurally blind to this host',
    });
  }
  return out.sort((a, b) => b.edge_count - a.edge_count);
}

/**
 * R5.3 — a crawler present in the trailing 7-day series that has been at zero for
 * DISAPPEARED_DAYS consecutive days. PURE.
 *
 * Deliberately narrow. No volume-change alarm and no daily summary page: the only thing worth
 * waking a human for is a crawler that stopped coming. A crawler that was never present cannot
 * disappear, so it is excluded rather than reported as a zero-forever alarm.
 */
export function detectDisappearedCrawlers(records, { days = DISAPPEARED_DAYS, window = 7 } = {}) {
  const recent = (records ?? []).slice(-window);
  // NO "not enough history" guard here, and its absence is deliberate — it was written, then
  // PROVEN redundant by this wave's own break harness: the mutation that disabled it failed no
  // fixture, and enumerating all 255 presence/absence series of length 0-7 found zero outcomes
  // where it changed the answer. `recent.length <= days` implies `head` is empty, which implies
  // `wasPresent` is false for every crawler, which implies no alarm — the guard could only ever
  // restate what the logic below already concludes. A guard that cannot change an outcome is
  // not a guard, it is a comment that costs a branch. Thin history still yields no alarm; the
  // fixture asserting that is kept and now exercises the real path.
  const perDay = recent.map((rec) => {
    const m = new Map();
    for (const r of rec.rows ?? []) m.set(r.crawler, (m.get(r.crawler) ?? 0) + Number(r.requests ?? 0));
    return m;
  });
  const names = new Set(perDay.flatMap((m) => [...m.keys()]));
  const out = [];
  const tail = perDay.slice(-days);
  const head = perDay.slice(0, -days);
  for (const name of names) {
    const wasPresent = head.some((m) => (m.get(name) ?? 0) > 0);
    const goneNow = tail.every((m) => (m.get(name) ?? 0) === 0);
    if (wasPresent && goneNow) {
      out.push({ crawler: name, zero_days: days,
        last_seen_requests: Math.max(...head.map((m) => m.get(name) ?? 0)) });
    }
  }
  return out.sort((a, b) => a.crawler.localeCompare(b.crawler));
}

/** Read the origin Caddy log into `<host> <status_class>` counts. PURE. */
export function parseOriginLog(text, { since, until }) {
  const s = Date.parse(since) / 1000;
  const u = Date.parse(until) / 1000;
  const counts = new Map();
  let parsed = 0;
  for (const line of String(text ?? '').split('\n')) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const ts = Number(rec?.ts);
    if (!Number.isFinite(ts) || ts < s || ts >= u) continue;
    const host = rec?.request?.host ?? '(unknown)';
    counts.set(`${host}${KEY_SEP}${statusClass(rec?.status)}`,
      (counts.get(`${host}${KEY_SEP}${statusClass(rec?.status)}`) ?? 0) + 1);
    parsed += 1;
  }
  return { counts, parsed };
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

function env(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`missing ${name} — set it in the host .env; this reporter cannot run without it`);
    process.exit(1);
  }
  return v;
}

function nowIso(d = new Date()) { return d.toISOString().replace(/\.\d{3}Z$/, 'Z'); }

export function readSeries(dir = SERIES_DIR, file = SERIES_FILE) {
  const p = join(dir, file);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

async function runDaily() {
  const token = env('CF_ANALYTICS_TOKEN');
  const zoneTag = env('CF_ZONE_ID');
  const until = nowIso();
  const since = nowIso(new Date(Date.now() - 86400000));
  const allowlist = readAllowlistFromSource(readFileSync(ALLOWLIST_SOURCE, 'utf8'));
  if (allowlist.length === 0) {
    console.error('allowlist read back EMPTY — refusing to write a series record built from nothing');
    return 1;
  }
  const res = await queryWindow(GROUPED_QUERY, { zoneTag, since, until, token });
  const capturedAt = nowIso();
  const filter = 'datetime_geq/datetime_lt only; no UA filter (matched client-side against AI_CRAWLER_ALLOWLIST)';

  const record = {
    captured_at: capturedAt, since, until,
    instrument: INSTRUMENT_EDGE,
    status: res.status,
    queries_issued: res.queriesIssued,
    query_budget: MAX_QUERIES_PER_WINDOW,
    reasons: res.reasons.map((r) => redactToken(r, token)),
    identification: 'user-agent substring match; Cloudflare documents user agents as spoofable. '
      + 'botDetectionIds_hasany is REFUSED on this plan, so verified classification is unavailable here.',
    rows: res.status === 'OK' ? assembleDailyRows(res.rows, allowlist, { since, until, capturedAt, filter }) : [],
    unmatched: res.status === 'OK' ? assembleUnmatched(res.rows, allowlist, { since, until }) : [],
  };

  // INDETERMINATE is RECORDED, not skipped — a gap in the series must be visible as a gap.
  mkdirSync(SERIES_DIR, { recursive: true });
  appendFileSync(join(SERIES_DIR, SERIES_FILE), JSON.stringify(record) + '\n', 'utf8');

  console.log(`edge-crawler-report --daily  ${since} -> ${until}`);
  console.log(`  instrument=${INSTRUMENT_EDGE} status=${record.status} queries=${record.queries_issued}/${MAX_QUERIES_PER_WINDOW}`);
  for (const r of record.reasons) console.log(`  REASON: ${r}`);
  for (const r of record.rows) {
    console.log(`  ${r.crawler.padEnd(20)} ${String(r.host ?? '(none)').padEnd(26)} `
      + `req=${String(r.requests).padStart(6)} 2xx=${r.status['2xx']} 3xx=${r.status['3xx']} `
      + `4xx=${r.status['4xx']} 5xx=${r.status['5xx']} bytes=${r.bytes}`
      + (r.zero_row ? '   [explicit zero row]' : ''));
  }
  for (const u of record.unmatched) console.log(`  (not allowlisted) ${u.host.padEnd(26)} req=${u.requests}`);

  // R5.3 alarm — evaluated over the durable series, never over this single run.
  const gone = detectDisappearedCrawlers(readSeries());
  if (gone.length) {
    console.log(`  ALARM: ${gone.length} crawler(s) at zero for ${DISAPPEARED_DAYS} consecutive days: `
      + gone.map((g) => g.crawler).join(', '));
  } else {
    console.log(`  alarm: none (no allowlisted crawler has gone quiet for ${DISAPPEARED_DAYS} consecutive days)`);
  }
  return 0;
}

async function runReconcile(argv) {
  const token = env('CF_ANALYTICS_TOKEN');
  const zoneTag = env('CF_ZONE_ID');
  const since = argv[argv.indexOf('--since') + 1];
  const until = argv[argv.indexOf('--until') + 1];
  const originLog = argv.includes('--origin-log') ? argv[argv.indexOf('--origin-log') + 1] : null;
  if (!since || !until) { console.error('--reconcile needs --since <ISO> --until <ISO>'); return 1; }

  const ret = withinRetention(since, Date.now());
  console.log(`edge-crawler-report --reconcile  ${since} -> ${until}`);
  console.log(`  retention: ${ret.ok ? `OK (window starts ${ret.ageDays}d ago, floor ${RETENTION_DAYS}d)` : ret.reason}`);
  const budget = assertQueryBudget(splitWindow(since, until).length);
  console.log(`  query budget: ${budget.planned} planned / ${budget.max} allowed -> ${budget.ok ? 'OK' : 'REFUSED'}`);
  if (!budget.ok) { console.error(`  ${budget.reason}`); return 1; }

  const res = await queryWindow(GROUPED_QUERY, { zoneTag, since, until, token });
  console.log(`  edge status=${res.status} queries=${res.queriesIssued}`);
  for (const r of res.reasons) console.log(`  REASON: ${redactToken(r, token)}`);

  let originCounts = null;
  let originNote = 'origin log not supplied — every origin column reads `unavailable`';
  if (originLog && existsSync(originLog)) {
    const parsed = parseOriginLog(readFileSync(originLog, 'utf8'), { since, until });
    originCounts = parsed.counts;
    originNote = `origin log ${originLog}: ${parsed.parsed} record(s) inside the window`;
  }
  console.log(`  ${originNote}`);

  const rows = assembleReconcileRows(res.rows, originCounts,
    { originVisibleHosts: originCounts ? ORIGIN_VISIBLE_HOSTS : [] });
  console.log('\n  host                         class  edge:graphql  origin:caddy   difference');
  for (const r of rows) {
    console.log(`  ${r.host.padEnd(28)} ${r.status_class.padEnd(6)} `
      + `${String(r.edge_count).padStart(12)}  ${String(r.origin_count).padStart(12)}   `
      + `${r.difference === null ? 'n/a' : String(r.difference)}`);
  }
  console.log('\n  Both instruments are named on every row by design: a delta across two');
  console.log('  instruments is not a delta, and `unavailable` is not zero.');
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--daily')) return runDaily();
  if (argv.includes('--reconcile')) return runReconcile(argv);
  console.error('usage: edge-crawler-report.mjs --daily | --reconcile --since <ISO> --until <ISO> [--origin-log <path>]');
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
