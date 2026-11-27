/**
 * owed-read-regime-15m-sampler-trigger-pglite.test.ts — REGIME-15M-SERVE-W1 CH4 audit 1, finding A1.
 *
 * WHAT THE TRIGGER'S SQL COUNTS, proved in a REAL Postgres engine (PGlite). The read's self-test checks its bundle
 * as text; a FIRED is irreversible (the runner writes the terminal marker and pages once), so what the SQL counts
 * is pinned here, statement by statement, on the exact bundle `build_bundle(since, now)` emits:
 *   - the tables are the production DDL — request_log from analytics.ts's CREATE TABLE (its Postgres branch),
 *     refusal_counts from migrations/058 — and the bundle runs as a SELECT-only `aoe_readonly` role;
 *   - its output is rendered as `psql -tA -F '|'` prints it and handed to the read's own `evaluate`;
 *   - the vault evidence's 13 request_log + 11 refusal_counts fixtures give `4|1|5` and `3|2|2|5` (PENDING);
 *   - the audit's false-FIRED scenario gives `4|1|4` and `1|1|0|5` (PENDING);
 *   - three one-word SQL mutants the self-test cannot see (M26 drops `AND NOT automated`, M27 drops `DISTINCT`,
 *     M28 turns the internal filter into `OR`) each miscount here.
 *
 * PGlite 0.5.11 runs PostgreSQL 18; production runs 16. The bundle uses FILTER, bool_or and DATE literals only
 * (all Postgres >= 9.4).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'ops/monitoring/owed-read-regime-15m-sampler-trigger.py');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const S = 1_795_860_000;          // since = 2026-11-28T10:00:00Z
const NOW = S + 3 * 86400;        // now   = 2026-12-01T10:00:00Z
const DAY = 86400;
const iso = (t: number) => new Date(t * 1000).toISOString();
const day = (t: number) => iso(t).slice(0, 10);

/** request_log's Postgres DDL, taken from the app's own CREATE TABLE (each `DATABASE_URL ? pg : sqlite` → pg). */
function requestLogDdl(): string {
  const src = read('src/lib/analytics.ts');
  const m = src.match(/const CREATE_TABLE_SQL = `([\s\S]*?)`;/);
  if (!m) throw new Error('CREATE_TABLE_SQL not found in src/lib/analytics.ts');
  const ddl = m[1].replace(/\$\{process\.env\.DATABASE_URL \? '([^']*)' : '[^']*'\}/g, '$1');
  if (ddl.includes('${')) throw new Error('an unresolved interpolation is left in the request_log DDL');
  return ddl;
}
/** refusal_counts' DDL: migration 058's CREATE TABLE. */
const refusalCountsDdl = () => {
  const m = read('migrations/058_refusal_counts.sql').match(/CREATE TABLE IF NOT EXISTS refusal_counts \([\s\S]*?\);/);
  if (!m) throw new Error('CREATE TABLE refusal_counts not found in migrations/058');
  return m[0];
};

type RL = [t: number, tool: string, tf: string, tier: string, automated: boolean, ip: string, client: string];
type RC = [day: string, reason: string, tool: string, parameter: string, value: string, keyed: boolean, key: string, count: number];

/** The vault evidence's fixtures (audits/REGIME-15M-SERVE-W1-evidence.md § CH3(b)), each with what it exercises. */
const EVIDENCE_RL: RL[] = [
  [S + 60, 'get_market_regime', '15m', 'free', false, 'a', 'cl'],          // A external
  [S + 120, 'get_market_regime', '15m', 'free', false, 'b', 'cl'],         // B external
  [S + 180, 'get_market_regime', '15m', 'x402', false, 'b', 'cl'],         // B again: still one caller
  [S + 240, 'get_market_regime', '15m', 'free', false, 'c', 'cl'],         // C ...
  [S + 300, 'get_trade_call', '1h', 'free', true, 'c', 'cl'],              // ... automated on another tool: SYNTHETIC
  [S + 360, 'get_market_regime', '15m', 'internal', false, 'd', 'cl'],     // D internal: never external
  [S + 420, 'get_market_regime', '1h', 'free', false, 'e', 'cl'],          // E not 15m
  [S - 1, 'get_market_regime', '15m', 'free', false, 'f', 'cl'],           // F before since
  [NOW, 'get_market_regime', '15m', 'free', false, 'g', 'cl'],             // G at now: [since, now) excludes it
  [S + 480, 'get_market_regime', '15m', 'free', false, 'a', 'other'],      // H same ip, other client: its own caller
  [S + 540, 'get_market_regime', '15m', 'free', false, 'i', 'cl'],         // I external ...
  [S - 3600, 'get_trade_call', '1h', 'free', true, 'i', 'cl'],             // ... automation only before the window
  [S + 600, 'scan_market_regimes', '15m', 'free', false, 'j', 'cl'],       // J another tool
];
const EVIDENCE_RC: RC[] = [
  [day(S), 'invalid_enum_value', 'scan_market_regimes', 'timeframe', '15m', false, 'k1', 2],
  [day(S), 'invalid_enum_value', 'pre_trade_check', 'timeframe', '15m', false, 'k1', 1],       // k1 on both tools: one key
  [day(S + DAY), 'timeframe_admission', 'pre_trade_check', 'timeframe', '15m', true, 'k2', 1],
  [day(S), 'invalid_enum_value', 'scan_market_regimes', 'timeframe', '15m', false, '<none>', 5], // not an identity
  [day(S), 'invalid_enum_value', 'scan_market_regimes', 'timeframe', '4h', false, 'k3', 1],     // not 15m
  [day(S - DAY), 'invalid_enum_value', 'scan_market_regimes', 'timeframe', '15m', false, 'k4', 1], // the day before since
  [day(S), 'invalid_enum_value', 'get_market_regime', 'timeframe', '15m', false, 'k5', 1],     // not a snapshot tool
  [day(S), 'invalid_enum_value', 'scan_market_regimes', 'exchange', '15m', false, 'k6', 1],    // not the timeframe
  [day(NOW), 'invalid_enum_value', 'scan_market_regimes', 'timeframe', '15m', false, 'k7', 1], // now's day: counted
  [day(NOW + DAY), 'invalid_enum_value', 'scan_market_regimes', 'timeframe', '15m', false, 'k8', 1], // after now's day
  [day(S), 'invalid_enum_value', 'scan_market_regimes', 'timeframe', '15m', false, '<overflow>', 1], // not an identity
];

/** The audit's false-FIRED scenario: 4 real 15m callers, 1 automated 15m caller, 6 external get_trade_call callers,
 *  and one caller_key refused 15m on 5 rows (4 days, plus a keyed row) within [since's day, now's day]. */
const AUDIT_RL: RL[] = [
  ...['r1', 'r2', 'r3', 'r4'].map((ip, i): RL => [S + 60 * (i + 1), 'get_market_regime', '15m', 'free', false, ip, 'cl']),
  [S + 400, 'get_market_regime', '15m', 'free', true, 'bot', 'cl'],
  ...['t1', 't2', 't3', 't4', 't5', 't6'].map((ip, i): RL => [S + 500 + i, 'get_trade_call', '1h', 'free', false, ip, 'cl']),
];
const AUDIT_RC: RC[] = [
  ...[0, 1, 2, 3].map((d): RC => [day(S + d * DAY), 'invalid_enum_value', 'scan_market_regimes', 'timeframe', '15m', false, 'k-repeat', 1]),
  [day(S), 'invalid_enum_value', 'scan_market_regimes', 'timeframe', '15m', true, 'k-repeat', 1],   // the 5th row: same key, keyed
];

/** The three one-word SQL mutants the read's self-test cannot see (audit-1 M26–M28). */
const MUTANTS: Record<string, [string, string]> = {
  M26: ['FILTER (WHERE asked > 0 AND NOT automated)', 'FILTER (WHERE asked > 0)'],
  M27: ['"SELECT count(DISTINCT caller_key), count(DISTINCT', '"SELECT count(caller_key), count(DISTINCT'],
  M28: ["AND license_tier <> 'internal') AS asked", "OR license_tier <> 'internal') AS asked"],
};

const PY_IMPORT = "import importlib.util as u, json, sys; s = u.spec_from_file_location('r', sys.argv[1]); m = u.module_from_spec(s); s.loader.exec_module(m); ";

/** The bundle exactly as the read builds it; psql's `\set` meta-command is psql's, not SQL, and is dropped. */
function bundleOf(script: string): string {
  const r = spawnSync('python3', ['-I', '-c', PY_IMPORT + "sys.stdout.write(m.build_bundle(int(sys.argv[2]), int(sys.argv[3])))", script, String(S), String(NOW)],
    { encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) throw new Error(`build_bundle failed: ${r.stderr}`);
  const lines = r.stdout.split('\n');
  if (lines[0] !== '\\set ON_ERROR_STOP on') throw new Error(`unexpected first line ${lines[0]}`);
  return lines.slice(1).join('\n');
}

/** The read's own verdict on a rendered snapshot. */
function evaluateWith(script: string, stdout: string): [string, string | null, Record<string, any>] {
  const r = spawnSync('python3', ['-I', '-c', PY_IMPORT + "print(json.dumps(m.evaluate({'since': int(sys.argv[2]), 'callers_min': 5}, int(sys.argv[3]), sys.stdin.read(), None)))", script, String(S), String(NOW)],
    { encoding: 'utf8', input: stdout, timeout: 30_000 });
  if (r.status !== 0) throw new Error(`evaluate failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

let db: PGlite;

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(requestLogDdl());
  await db.exec(refusalCountsDdl());
  await db.exec("CREATE ROLE aoe_readonly; GRANT SELECT ON request_log, refusal_counts TO aoe_readonly;");
}, 60_000);
afterAll(async () => { await db?.close(); });

/** Load the fixtures, run the bundle as aoe_readonly, render it as `psql -tA -F '|'` does. */
async function snapshot(bundle: string, rl: RL[], rc: RC[]): Promise<string> {
  await db.exec('TRUNCATE request_log; TRUNCATE refusal_counts;');
  for (const [t, tool, tf, tier, auto, ip, client] of rl) {
    await db.query(
      'INSERT INTO request_log (timestamp, tool_name, timeframe, license_tier, response_time_ms, is_automated, ip_hash, client_name) VALUES ($1, $2, $3, $4, 1, $5, $6, $7)',
      [iso(t), tool, tf, tier, auto, ip, client]);
  }
  for (const r of rc) {
    await db.query('INSERT INTO refusal_counts (day, reason, tool, parameter, value, keyed, caller_key, count) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', r);
  }
  await db.exec('SET ROLE aoe_readonly;');
  try {
    const results = await db.exec(bundle, { rowMode: 'array' });
    return results.flatMap((res) => (res.rows as unknown[][]).map((row) => row.map((v) => String(v)).join('|'))).join('\n') + '\n';
  } finally {
    await db.exec('RESET ROLE;');
  }
}

const sectionRows = (out: string) => {
  const l = out.split('\n');
  return { rl: l[l.indexOf('MARK|sec|request_log') + 1], rc: l[l.indexOf('MARK|sec|refusal_counts') + 1] };
};

describe('the trigger SQL in a real Postgres engine (PGlite), the bundle as built, read as aoe_readonly', () => {
  it('the evidence fixtures: request_log 4|1|5, refusal_counts 3|2|2|5 — PENDING by the read\'s own evaluate', { timeout: 60_000 }, async () => {
    const out = await snapshot(bundleOf(SCRIPT), EVIDENCE_RL, EVIDENCE_RC);
    expect(out.split('\n')[0]).toBe('MARK|ro|on|aoe_readonly');
    expect(sectionRows(out)).toEqual({ rl: '4|1|5', rc: '3|2|2|5' });
    const [trigger, cause, m] = evaluateWith(SCRIPT, out);
    expect([trigger, cause]).toEqual(['PENDING', null]);
    expect(m.request_log).toEqual({ external_callers: 4, synthetic_callers: 1, external_rows: 5 });
    expect(m.refusal_counts).toMatchObject({ caller_keys: 3, scan_market_regimes_keys: 2, pre_trade_check_keys: 2, refusals: 5 });
  });

  it('the audit\'s false-FIRED scenario stays PENDING: 4|1|4 and 1|1|0|5', { timeout: 60_000 }, async () => {
    const out = await snapshot(bundleOf(SCRIPT), AUDIT_RL, AUDIT_RC);
    expect(sectionRows(out)).toEqual({ rl: '4|1|4', rc: '1|1|0|5' });
    expect(evaluateWith(SCRIPT, out)[0]).toBe('PENDING');
  });

  it('five distinct external callers fire it (the bar is reachable through the SQL, not only in fixtures)', { timeout: 60_000 }, async () => {
    const rl: RL[] = [...AUDIT_RL, [S + 900, 'get_market_regime', '15m', 'free', false, 'r5', 'cl']];
    const out = await snapshot(bundleOf(SCRIPT), rl, []);
    expect(sectionRows(out)).toEqual({ rl: '5|1|5', rc: '0|0|0|0' });
    const [trigger, , m] = evaluateWith(SCRIPT, out);
    expect([trigger, m.fired_by]).toEqual(['FIRED', ['request_log']]);
  });
});

describe('the SQL mutants the self-test cannot see miscount here (audit-1 M26, M27, M28)', () => {
  const mutant = (name: string) => {
    const [from, to] = MUTANTS[name];
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src.split(from).length - 1, `${name}: its anchor must occur exactly once`).toBe(1);
    const out = join(mkdtempSync(join(tmpdir(), 'r15-sql-mut-')), 'owed-read-regime-15m-sampler-trigger.py');
    writeFileSync(out, src.replace(from, to));
    return out;
  };
  const WANT: Record<string, { evidence: { rl: string; rc: string }; audit: string }> = {
    M26: { evidence: { rl: '5|1|5', rc: '3|2|2|5' }, audit: 'FIRED' },   // the automated caller counted external
    M27: { evidence: { rl: '4|1|5', rc: '4|2|2|5' }, audit: 'FIRED' },   // refusal rows counted, not keys
    M28: { evidence: { rl: '7|1|8', rc: '3|2|2|5' }, audit: 'FIRED' },   // any non-internal row on any tool, and internal 15m, counted
  };

  for (const name of Object.keys(MUTANTS)) {
    it(`${name}: miscounts the evidence fixtures and fires falsely on the audit scenario`, { timeout: 60_000 }, async () => {
      const script = mutant(name);
      const ev = sectionRows(await snapshot(bundleOf(script), EVIDENCE_RL, EVIDENCE_RC));
      expect(ev).not.toEqual({ rl: '4|1|5', rc: '3|2|2|5' });
      expect(ev).toEqual(WANT[name].evidence);
      const au = await snapshot(bundleOf(script), AUDIT_RL, AUDIT_RC);
      expect(evaluateWith(script, au)[0]).toBe(WANT[name].audit);
    });
  }
});
