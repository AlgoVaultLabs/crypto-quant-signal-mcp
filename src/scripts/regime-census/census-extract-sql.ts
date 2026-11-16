// regime-census/census-extract-sql.ts — EDGE-REGIME-CENSUS-W1: the ONE generator of every statement the census pull
// runs. The census asks who really calls get_market_regime, for what, and with which brackets; its frozen output
// (vault audits/regime-census-<date>.json) sets ARC-REGIME-ACCURACY T3's weights.
//
// TWO PARTS, each a complete script for one read-only session on signal-1:
//   pg   — `docker exec -i <postgres> psql -U aoe_readonly -At -q -v window_start=… -v window_end=…`, ONE
//          `BEGIN READ ONLY`, the token line first. Sections BOTKEY, REGIME, CHECKS, printed as CSV by psql itself.
//   bot  — `sqlite3 -readonly -bail 'file:/var/lib/algovault-bot/state.db?immutable=1'` (the immutable open is the
//          pull's: a WAL file with no side files cannot be opened read-only any other way without creating them).
//          `PRAGMA query_only`, the token line first. Section WATCHES.
//
// Privacy, decided here and checked by partDefects before anything is emitted:
//   · a request_log caller is `left(md5('regime-census-v1:' || ip_hash || '|' || client_name), 12)`, computed in SQL,
//     and a check's caller is the same md5 of its pseudonym — the raw values never leave the host;
//   · user agents are never read (client_name, the server's own classification, is);
//   · a bot chat is a dense rank over the chat id, computed in SQLite — the chat id never leaves the host;
//   · no outcome, odds, rules, venues or decision column is read.
// The window is two psql variables bound by the pull from its own clock, so a statement's text — and its sha256 —
// never changes with the date.
//
// The bot key is the CH1 ruling's restatement: `license_tier = 'internal' AND client_name = 'python-httpx'` (two
// sequential ip_hashes over the 90-day window, measured 2026-11-16). BOTKEY re-measures it on the frozen data.

import { TOKEN_SQL } from '../ads1/extract-sql.js';
import { selectedColumns } from '../sr-probe/sr-extract-sql.js';

export const CENSUS_DOMAIN = 'regime-census-v1:';
export const BOT_CLIENT_NAME = 'python-httpx';

/** Write and export statements that may never appear in a census script, matched as whole words. */
export const BANNED_TOKENS: readonly string[] = ['INSERT', 'UPDATE', 'DELETE', 'GRANT', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'COPY'];
const BANNED_RE = new RegExp(`\\b(${BANNED_TOKENS.join('|')})\\b`, 'i');

/** Columns the postgres part must never read. */
const FORBIDDEN_PG_COLUMNS: readonly string[] = [
  'pre_trade_check_outcomes', 'p_timeout', 'p_target_first', 'p_stop_first', 'p_liq_hold', 'odds_version',
  'p.rules', 'p.venues', 'p.decision', 'ledger_id', 'user_agent',
];

/** The CSV header each section prints, in order. The pull reads these through `--headers`. */
export const HEADERS = {
  BOTKEY: ['bot_keys', 'bot_rows', 'first_ts', 'last_ts'],
  REGIME: ['ts', 'tool_name', 'caller', 'internal', 'client_name', 'is_automated', 'coin', 'timeframe', 'exchange', 'regime', 'verdict', 'next_tool', 'next_gap_s'],
  CHECKS: ['checked_at', 'channel', 'caller', 'keyless', 'coin', 'side', 'size_usd', 'leverage', 'hold_hours', 'timeframe', 'stop_pct', 'target_pct', 'sigma_1h_pct'],
  WATCHES: ['chat_n', 'blocked', 'coin', 'timeframe', 'exchange', 'alert_type'],
} as const satisfies Record<string, readonly string[]>;
export type SectionName = keyof typeof HEADERS;

const RL_KEY = `left(md5('${CENSUS_DOMAIN}' || coalesce(r.ip_hash, '') || '|' || coalesce(r.client_name, '')), 12)`;
const PC_KEY = `left(md5('${CENSUS_DOMAIN}' || coalesce(p.caller_ref, '')), 12)`;
const PC_NULL = '(p.caller_ref IS NULL)';
const RL_WINDOW = `r.timestamp >= :'window_start' AND r.timestamp < :'window_end'`;
const BOT_PREDICATE = `r.license_tier = 'internal' AND r.client_name = '${BOT_CLIENT_NAME}'`;

/** BOTKEY — the restated bot key, re-measured on the window: how many caller keys and rows it covers. */
export function botKeySql(): string {
  return `SELECT count(DISTINCT ${RL_KEY}) AS bot_keys, count(*) AS bot_rows, min(r.timestamp) AS first_ts, max(r.timestamp) AS last_ts
FROM request_log r
WHERE ${RL_WINDOW}
  AND ${BOT_PREDICATE}`;
}

/** REGIME — every get_market_regime and scan_market_regimes row of the window, with the caller's NEXT request_log
 *  call of any tool (lead over the caller's whole window) and the gap to it in seconds. */
export function regimeSql(): string {
  return `SELECT s.ts, s.tool_name, s.caller, s.internal, s.client_name, s.is_automated, s.coin, s.timeframe, s.exchange, s.regime, s.verdict, s.next_tool,
       round(extract(epoch FROM s.next_at::timestamptz) - extract(epoch FROM s.ts::timestamptz), 3) AS next_gap_s
FROM (
  SELECT w.id, w.ts, w.tool_name, w.caller, w.internal, w.client_name, w.is_automated, w.coin, w.timeframe, w.exchange, w.regime, w.verdict,
         lead(w.tool_name) OVER (PARTITION BY w.caller ORDER BY w.ts, w.id) AS next_tool,
         lead(w.ts) OVER (PARTITION BY w.caller ORDER BY w.ts, w.id) AS next_at
  FROM (
    SELECT r.id, r.timestamp AS ts, r.tool_name, ${RL_KEY} AS caller, (r.license_tier = 'internal') AS internal,
           r.client_name, r.is_automated, r.asset AS coin, r.timeframe, r.exchange, r.regime, r.verdict
    FROM request_log r
    WHERE ${RL_WINDOW}
  ) w
) s
WHERE s.tool_name IN ('get_market_regime', 'scan_market_regimes')
ORDER BY s.ts, s.id`;
}

/** CHECKS — the bracket a caller sent with each logged pre_trade_check of the window. */
export function checksSql(): string {
  return `SELECT p.checked_at, p.channel, ${PC_KEY} AS caller, ${PC_NULL} AS keyless, p.coin, p.side, p.size_usd, p.leverage,
       p.hold_hours, p.timeframe, p.stop_pct, p.target_pct, p.sigma_1h_pct
FROM pre_trade_checks p
WHERE p.checked_at >= :'window_start'::timestamptz AND p.checked_at < :'window_end'::timestamptz
ORDER BY p.id`;
}

/** WATCHES (SQLite) — every bot watch the bot polls get_market_regime for, one pseudonymous chat number per chat. */
export function watchesSql(): string {
  return `SELECT dense_rank() OVER (ORDER BY w.chat_id) AS chat_n, CASE WHEN s.bot_blocked_at IS NULL THEN 0 ELSE 1 END AS blocked, w.coin, w.timeframe, w.exchange, w.alert_type
FROM watchlists w JOIN subscribers s ON s.chat_id = w.chat_id
WHERE w.alert_type IN ('regime', 'both')
ORDER BY chat_n, w.coin, w.timeframe, w.exchange`;
}

export type CensusPart = 'pg' | 'bot';
export const CENSUS_PARTS: readonly CensusPart[] = ['pg', 'bot'];

export interface CensusSection {
  name: SectionName;
  sql: string;
  header: readonly string[];
}

/** The sections one part runs, in order. */
export function partSections(part: CensusPart): CensusSection[] {
  return part === 'pg'
    ? [
        { name: 'BOTKEY', sql: botKeySql(), header: HEADERS.BOTKEY },
        { name: 'REGIME', sql: regimeSql(), header: HEADERS.REGIME },
        { name: 'CHECKS', sql: checksSql(), header: HEADERS.CHECKS },
      ]
    : [{ name: 'WATCHES', sql: watchesSql(), header: HEADERS.WATCHES }];
}

/** What is wrong with a part's sections, read from their own text; empty when nothing is. The entrypoint refuses
 *  to emit a part with a defect, so an edit cannot carry a write, a raw identifier or a widened select to the host. */
export function partDefects(part: CensusPart, sections: readonly CensusSection[] = partSections(part)): string[] {
  const out: string[] = [];
  for (const s of sections) {
    const banned = BANNED_RE.exec(s.sql);
    if (banned) out.push(`${s.name}: write token ${banned[1].toUpperCase()}`);
    const cols = selectedColumns(s.sql);
    if (cols.join(',') !== s.header.join(',')) out.push(`${s.name}: selects [${cols.join(', ')}], registered [${s.header.join(', ')}]`);
    if (part === 'pg') {
      const stripped = s.sql.split(RL_KEY).join('<KEY>').split(PC_KEY).join('<KEY>').split(PC_NULL).join('<NULLTEST>');
      const raw = /\b(ip_hash|caller_ref|user_agent)\b/.exec(stripped);
      if (raw) out.push(`${s.name}: raw identifier ${raw[1]} outside the census key`);
      const forbidden = FORBIDDEN_PG_COLUMNS.filter((c) => s.sql.includes(c));
      if (forbidden.length > 0) out.push(`${s.name}: reads forbidden column(s) ${forbidden.join(', ')}`);
      if (!s.sql.includes(":'window_start'") || !s.sql.includes(":'window_end'")) out.push(`${s.name}: window is not the bound pair`);
    } else {
      const stripped = s.sql.split('OVER (ORDER BY w.chat_id)').join('<RANK>').split('ON s.chat_id = w.chat_id').join('<JOIN>');
      if (/\bchat_id\b|\busername\b/.test(stripped)) out.push(`${s.name}: raw chat identifier outside the rank and the join`);
    }
  }
  return out;
}

/** A complete script for one part (pg: run with `psql -At -q`; bot: piped to `sqlite3 -readonly -bail`). Its own
 *  read-only frame, the token line first, a `===SECTION===` marker before every result. */
export function sessionScript(part: CensusPart): string {
  if (part === 'pg') {
    const body = partSections('pg').flatMap((s) => [`\\echo '===${s.name}==='`, `${s.sql};`]);
    return [
      '\\set ON_ERROR_STOP 1',
      "SET statement_timeout = '300s';",
      "SET TIME ZONE 'UTC';",
      "SET DateStyle = 'ISO, YMD';",
      'BEGIN READ ONLY;',
      `${TOKEN_SQL};`,
      // Session-local, measured in CH1 (P6): the caller-window sort runs in memory (peak 143 MB), never a temp file.
      "SET LOCAL work_mem = '256MB';",
      'SET LOCAL max_parallel_workers_per_gather = 0;',
      '\\pset tuples_only off',
      '\\pset format csv',
      ...body,
      'COMMIT;',
      '',
    ].join('\n');
  }
  const body = partSections('bot').flatMap((s) => [`.print ===${s.name}===`, '.headers on', '.mode csv', '.separator "," "\\n"', `${s.sql};`]);
  return [
    '.bail on',
    'PRAGMA query_only = 1;',
    '.headers off',
    '.mode list',
    "SELECT 'TOKEN sqlite query_only=' || query_only FROM pragma_query_only;",
    ...body,
    '',
  ].join('\n');
}

/** Frame defects of a whole script: a banned token anywhere (meta-commands included) or a missing read-only frame. */
export function scriptDefects(part: CensusPart, script: string = sessionScript(part)): string[] {
  const out: string[] = [];
  const banned = BANNED_RE.exec(script);
  if (banned) out.push(`${part}: write token ${banned[1].toUpperCase()} in the script`);
  if (part === 'pg' && !script.includes('\nBEGIN READ ONLY;\n')) out.push('pg: no BEGIN READ ONLY frame');
  if (part === 'bot' && !script.includes('\nPRAGMA query_only = 1;\n')) out.push('bot: no query_only pragma');
  return out;
}

if (require.main === module) {
  if (process.argv.includes('--headers')) {
    process.stdout.write(Object.entries(HEADERS).map(([k, v]) => `${k}=${v.join(',')}\n`).join(''));
  } else {
    const i = process.argv.indexOf('--part');
    const asked = i >= 0 ? process.argv[i + 1] : undefined;
    const part = CENSUS_PARTS.find((p) => p === asked);
    if (!part) {
      process.stderr.write(`usage: census-extract-sql.ts --part ${CENSUS_PARTS.join('|')} | --headers\n`);
      process.exit(2);
    }
    const defects = [...partDefects(part), ...scriptDefects(part)];
    if (defects.length > 0) {
      process.stderr.write(`census-extract-sql: refusing to emit the ${part} session — ${defects.join('; ')}\n`);
      process.exit(1);
    }
    process.stdout.write(sessionScript(part));
  }
}
