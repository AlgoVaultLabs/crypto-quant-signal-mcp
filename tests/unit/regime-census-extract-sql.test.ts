// EDGE-REGIME-CENSUS-W1 CH2 — the census generator: every statement the pull runs, read from its own text.
// AC2.1: no write token anywhere, every part inside its read-only frame, the token line first, the window bound.
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  BANNED_TOKENS,
  BOT_CLIENT_NAME,
  CENSUS_DOMAIN,
  CENSUS_PARTS,
  HEADERS,
  botKeySql,
  checksSql,
  partDefects,
  regimeSql,
  sessionScript,
  watchesSql,
} from '../../src/scripts/regime-census/census-extract-sql.js';

const BANNED_RE = /\b(INSERT|UPDATE|DELETE|GRANT|CREATE|ALTER|DROP|TRUNCATE|COPY)\b/i;

describe('census generator — AC2.1 read-only by construction', () => {
  it('emits no write token in any part', () => {
    for (const part of CENSUS_PARTS) {
      const script = sessionScript(part);
      expect(BANNED_RE.test(script), `${part}: ${script.match(BANNED_RE)?.[0]}`).toBe(false);
    }
    expect([...BANNED_TOKENS].sort()).toEqual(['ALTER', 'COPY', 'CREATE', 'DELETE', 'DROP', 'GRANT', 'INSERT', 'TRUNCATE', 'UPDATE']);
  });

  it('wraps the postgres part in one BEGIN READ ONLY with the token line first and COMMIT last', () => {
    const lines = sessionScript('pg').split('\n').filter((l) => l.trim() !== '');
    const begin = lines.indexOf('BEGIN READ ONLY;');
    expect(begin).toBeGreaterThan(0);
    expect(lines.filter((l) => /^BEGIN\b/i.test(l))).toEqual(['BEGIN READ ONLY;']);
    // the first statement after BEGIN prints the token; nothing before BEGIN can print a row
    expect(lines[begin + 1]).toMatch(/^SELECT 'TOKEN current_user=' \|\| current_user \|\| ' transaction_read_only=' \|\| current_setting\('transaction_read_only'\);$/);
    for (const l of lines.slice(0, begin)) expect(l).toMatch(/^(\\set ON_ERROR_STOP 1|SET (statement_timeout|TIME ZONE|DateStyle)\b.*)$/);
    expect(lines[lines.length - 1]).toBe('COMMIT;');
    // every SELECT section sits between BEGIN and COMMIT
    const firstSection = lines.findIndex((l) => l.startsWith("\\echo '==="));
    expect(firstSection).toBeGreaterThan(begin + 1);
  });

  it('holds the bot part query-only, token line first', () => {
    const lines = sessionScript('bot').split('\n').filter((l) => l.trim() !== '');
    const pragma = lines.indexOf('PRAGMA query_only = 1;');
    expect(pragma).toBeGreaterThanOrEqual(0);
    const firstSelect = lines.findIndex((l) => /^SELECT\b/.test(l));
    expect(firstSelect).toBeGreaterThan(pragma);
    expect(lines[firstSelect]).toBe("SELECT 'TOKEN sqlite query_only=' || query_only FROM pragma_query_only;");
  });

  it('binds the window as psql variables, never a literal date', () => {
    for (const sql of [botKeySql(), regimeSql(), checksSql()]) {
      expect(sql).toContain(":'window_start'");
      expect(sql).toContain(":'window_end'");
      expect(sql).not.toMatch(/'\d{4}-\d{2}-\d{2}/);
      expect(sql).not.toMatch(/now\(\)|interval/i);
    }
  });

  it('never lets a raw ip_hash, caller_ref, user_agent or chat id leave the host', () => {
    const pg = sessionScript('pg');
    expect(pg).not.toMatch(/user_agent/);
    // every ip_hash / caller_ref reference is the census key (md5 under its domain) or a NULL test — nothing else
    const RL_KEY = "left(md5('regime-census-v1:' || coalesce(r.ip_hash, '') || '|' || coalesce(r.client_name, '')), 12)";
    const PC_KEY = "left(md5('regime-census-v1:' || coalesce(p.caller_ref, '')), 12)";
    const PC_NULL = '(p.caller_ref IS NULL)';
    expect(CENSUS_DOMAIN).toBe('regime-census-v1:');
    expect(pg).toContain(RL_KEY);
    expect(pg).toContain(PC_KEY);
    const stripped = pg.split(RL_KEY).join('<KEY>').split(PC_KEY).join('<KEY>').split(PC_NULL).join('<NULLTEST>');
    expect(stripped).not.toMatch(/ip_hash|caller_ref/);
    expect(watchesSql()).toMatch(/dense_rank\(\) OVER \(ORDER BY w\.chat_id\) AS chat_n/);
    expect(HEADERS.WATCHES).not.toContain('chat_id');
  });

  it('reads no outcome, odds, rules or venues column, and no outcome table', () => {
    const pg = sessionScript('pg');
    for (const c of ['pre_trade_check_outcomes', 'p_timeout', 'p_target_first', 'p_stop_first', 'p_liq_hold', 'odds_version', 'p.rules', 'p.venues', 'p.decision', 'ledger_id']) {
      expect(pg).not.toContain(c);
    }
  });

  it('selects exactly the registered header in every section', () => {
    expect(partDefects('pg')).toEqual([]);
    expect(partDefects('bot')).toEqual([]);
  });

  it('keys the bot on the restated marker: internal tier and the bot client', () => {
    expect(BOT_CLIENT_NAME).toBe('python-httpx');
    expect(botKeySql()).toContain(`r.license_tier = 'internal' AND r.client_name = '${BOT_CLIENT_NAME}'`);
  });

  it('the defect detector can fail: an injected write, a widened select or a raw key are refused', () => {
    const pgSections = [
      { name: 'BOTKEY', sql: botKeySql(), header: HEADERS.BOTKEY },
      { name: 'REGIME', sql: regimeSql(), header: HEADERS.REGIME },
      { name: 'CHECKS', sql: checksSql(), header: HEADERS.CHECKS },
    ];
    const write = pgSections.map((s) => (s.name === 'CHECKS' ? { ...s, sql: `${s.sql}; DELETE FROM pre_trade_checks` } : s));
    expect(partDefects('pg', write).join(' ')).toMatch(/CHECKS: write token DELETE/);
    const widened = pgSections.map((s) => (s.name === 'REGIME' ? { ...s, sql: s.sql.replace('SELECT s.ts,', 'SELECT s.ts, s.user_agent,') } : s));
    expect(partDefects('pg', widened).join(' ')).toMatch(/REGIME: selects/);
    const raw = pgSections.map((s) => (s.name === 'CHECKS' ? { ...s, sql: s.sql.replace('p.coin,', 'p.caller_ref AS coin,') } : s));
    expect(partDefects('pg', raw).join(' ')).toMatch(/CHECKS: raw identifier/);
  });
});

describe('census generator — the entrypoint prints what the module builds', () => {
  for (const part of CENSUS_PARTS) {
    it(`--part ${part}`, { timeout: 120_000 }, () => {
      const r = spawnSync('npx', ['--no-install', 'tsx', 'src/scripts/regime-census/census-extract-sql.ts', '--part', part], { encoding: 'utf8', timeout: 90_000 });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(sessionScript(part));
    });
  }

  it('--headers prints one NAME=columns line per section', { timeout: 120_000 }, () => {
    const r = spawnSync('npx', ['--no-install', 'tsx', 'src/scripts/regime-census/census-extract-sql.ts', '--headers'], { encoding: 'utf8', timeout: 90_000 });
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split('\n')).toEqual(Object.entries(HEADERS).map(([k, v]) => `${k}=${v.join(',')}`));
  });
});
