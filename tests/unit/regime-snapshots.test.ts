/**
 * regime-snapshots.test.ts — SCAN-MARKET-REGIMES-W1-V2 CH1
 *
 * The store's SQL/param contract (mock-tested, the same dual-backend deferral as oi-snapshots: $N SQL
 * is PG-only and verified live post-deploy), the ONE servability rule, the default-deny env parses,
 * the venue derivation, and DDL parity between the lazy ensure and migrations/048.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../../src/lib/performance-db.js', () => ({ dbQuery: vi.fn() }));
vi.mock('../../src/lib/venue-store.js', () => ({ getActivePromotedVenueIds: vi.fn() }));

import { dbQuery } from '../../src/lib/performance-db.js';
import { getActivePromotedVenueIds } from '../../src/lib/venue-store.js';
import {
  ensureRegimeSnapshotTables,
  adoptExistingRegimeSnapshotTables,
  _resetRegimeSnapshotsEnsure,
  recordRegimeSnapshots,
  recordRegimeSnapshotRun,
  latestServableGeneration,
  readGenerationRows,
  readGenerationRow,
  latestRunDisposition,
  latestRunForBar,
  recentDueRuns,
  lastTickAt,
  sampledRegimeVenues,
  regimeSnapshotMinCoverage,
  generationCoverage,
  isServableRun,
  REGIME_RUN_DISPOSITIONS,
  MARKET_REGIME_RULE_VERSION,
  DEFAULT_REGIME_SNAPSHOT_MIN_COVERAGE,
  type RegimeSnapshotRow,
  type RegimeSnapshotRunRecord,
} from '../../src/lib/regime-snapshots.js';

const ROOT = resolve(__dirname, '../..');
const MIGRATION = readFileSync(resolve(ROOT, 'migrations/048_regime_snapshots.sql'), 'utf8');
const STORE = readFileSync(resolve(ROOT, 'src/lib/regime-snapshots.ts'), 'utf8');

const q = vi.mocked(dbQuery);
/** SQL of every call so far, whitespace-collapsed. */
const sqls = () => q.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' '));
/** The call whose SQL matches `re` (DDL excluded). */
const callMatching = (re: RegExp) => q.mock.calls.find((c) => re.test(String(c[0])) && !/CREATE/.test(String(c[0])));

const row = (coin: string, over: Partial<RegimeSnapshotRow> = {}): RegimeSnapshotRow => ({
  exchange: 'BINANCE', timeframe: '1h', bar_close_ms: 1_792_400_400_000, coin, regime: 'TRENDING_UP',
  confidence: 66, trend_strength: 'MODERATE', adx: 31.2, adx_slope: 0.41, volatility_ratio: 0.0043,
  price_structure: 'HIGHER_HIGHS', asset_class: 'CRYPTO', underlying_session_at_compute: 'ALWAYS_OPEN',
  regime_since_ms: null, rule_version: MARKET_REGIME_RULE_VERSION, computed_at: 1_792_400_500_000, ...over,
});

const run = (over: Partial<RegimeSnapshotRunRecord> = {}): RegimeSnapshotRunRecord => ({
  exchange: 'BINANCE', timeframe: '1h', bar_close_ms: 1_792_400_400_000, tick_at: 1_792_400_460_000,
  disposition: 'COMPLETE', universe_n: 745, written_n: 740, too_new_n: 5, window_stale_n: 0, skipped_n: 0,
  errors_n: 0, finished_at: 1_792_400_520_000, ...over,
});

beforeEach(() => {
  q.mockReset();
  q.mockResolvedValue([]);
  _resetRegimeSnapshotsEnsure();
  delete process.env.REGIME_SNAPSHOT_MIN_COVERAGE;
  delete process.env.REGIME_SNAPSHOT_VENUES;
});

/** Column `name type` pairs of the first CREATE TABLE body for `table` in `sql`. */
function columnsOf(sql: string, table: string): string[] {
  const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${table}`);
  if (start === -1) return [];
  const open = sql.indexOf('(', start);
  let depth = 0, end = -1;
  for (let i = open; i < sql.length; i += 1) {
    if (sql[i] === '(') depth += 1;
    else if (sql[i] === ')') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  return sql.slice(open + 1, end).split('\n')
    .map((l) => l.replace(/--.*$/, '').trim())
    .filter((l) => /^[a-z_]+\s/.test(l))
    .map((l) => { const [name, type] = l.split(/\s+/); return `${name} ${type.replace(/,$/, '')}`; });
}
const pkOf = (sql: string, table: string) => {
  const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${table}`);
  const m = /PRIMARY KEY \(([^)]+)\)/.exec(sql.slice(start));
  return m ? m[1].replace(/\s+/g, '') : null;
};

describe('DDL parity — the lazy ensure and migrations/048 build the same tables', () => {
  for (const table of ['regime_snapshots', 'regime_snapshot_runs']) {
    it(`${table}: same columns, same types, same primary key`, () => {
      const a = columnsOf(MIGRATION, table);
      const b = columnsOf(STORE, table);
      expect(a.length, `migration parser found nothing for ${table}`).toBeGreaterThan(8);
      expect(b).toEqual(a);
      expect(pkOf(STORE, table)).toBe(pkOf(MIGRATION, table));
      expect(pkOf(MIGRATION, table)).not.toBeNull();
    });
  }

  it('the stored session column is named as history, never as a live read (V2 §0 Q6)', () => {
    const cols = columnsOf(MIGRATION, 'regime_snapshots').map((c) => c.split(' ')[0]);
    expect(cols).toContain('underlying_session_at_compute');
    expect(cols).not.toContain('underlying_session');
    expect(cols.some((c) => /funding|outcome|price$/.test(c))).toBe(false);
  });

  it('the disposition CHECK names exactly the closed set, in both DDLs', () => {
    const set = `(${REGIME_RUN_DISPOSITIONS.map((d) => `'${d}'`).join(',')})`;
    expect(MIGRATION).toContain(`CHECK (disposition IN ${set})`);
    expect(STORE).toContain(`CHECK (disposition IN ${set})`);
  });

  it('the bar-order index exists in both', () => {
    const idx = 'CREATE INDEX IF NOT EXISTS idx_regime_snapshot_runs_pair_bar ON regime_snapshot_runs (exchange, timeframe, bar_close_ms, tick_at)';
    expect(MIGRATION).toContain(idx);
    expect(STORE).toContain(idx);
  });
});

describe('writes', () => {
  it('ensures the tables once per process', async () => {
    await ensureRegimeSnapshotTables();
    await ensureRegimeSnapshotTables();
    expect(sqls().filter((s) => /^CREATE/.test(s))).toHaveLength(3);
  });

  it('recordRegimeSnapshots chunks at 200 rows, first-write-wins on the full PK, params in column order', async () => {
    const rows = Array.from({ length: 450 }, (_, i) => row(`C${i}`));
    expect(await recordRegimeSnapshots(rows)).toBe(450);
    const inserts = q.mock.calls.filter((c) => /^INSERT INTO regime_snapshots/.test(String(c[0])));
    expect(inserts).toHaveLength(3);
    for (const [sql] of inserts) {
      expect(String(sql)).toMatch(/ON CONFLICT \(exchange, timeframe, bar_close_ms, coin\) DO NOTHING$/);
    }
    const [sql0, p0] = inserts[0] as [string, unknown[]];
    expect(p0).toHaveLength(200 * 16);
    expect(sql0).toContain('($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)');
    expect(p0.slice(0, 16)).toEqual([
      'BINANCE', '1h', 1_792_400_400_000, 'C0', 'TRENDING_UP', 66, 'MODERATE', 31.2, 0.41, 0.0043,
      'HIGHER_HIGHS', 'CRYPTO', 'ALWAYS_OPEN', null, MARKET_REGIME_RULE_VERSION, 1_792_400_500_000,
    ]);
    expect((inserts[2][1] as unknown[]).length).toBe(50 * 16);
  });

  it('recordRegimeSnapshots on zero rows touches nothing', async () => {
    expect(await recordRegimeSnapshots([])).toBe(0);
    expect(q).not.toHaveBeenCalled();
  });

  it('recordRegimeSnapshotRun writes one row, idempotent per tick, and refuses an unknown disposition', async () => {
    await recordRegimeSnapshotRun(run());
    const c = callMatching(/^INSERT INTO regime_snapshot_runs/)!;
    expect(String(c[0])).toMatch(/ON CONFLICT \(exchange, timeframe, tick_at\) DO NOTHING$/);
    expect(c[1]).toEqual(['BINANCE', '1h', 1_792_400_400_000, 1_792_400_460_000, 'COMPLETE', 745, 740, 5, 0, 0, 0, 1_792_400_520_000]);
    await expect(recordRegimeSnapshotRun(run({ disposition: 'DONE' as never }))).rejects.toThrow(/unknown disposition/);
  });
});

describe('adoptExistingRegimeSnapshotTables — the READ-ONLY ensure (CH3 freshness canary)', () => {
  const exists = (s: boolean, r: boolean, i: boolean) => q.mockResolvedValueOnce([{ s, r, i }] as never);

  it('probes with to_regclass only — no DDL, no write — and on success every reader skips its ensure', async () => {
    exists(true, true, true);
    expect(await adoptExistingRegimeSnapshotTables()).toBe(true);
    expect(sqls()).toHaveLength(1);
    expect(sqls()[0]).toMatch(/^SELECT to_regclass\('regime_snapshots'\)/);
    expect(sqls()[0]).toContain("to_regclass('regime_snapshot_runs')");
    expect(sqls()[0]).toContain("to_regclass('idx_regime_snapshot_runs_pair_bar')");
    await latestRunDisposition('BINANCE', '1h');
    await recentDueRuns('BINANCE', '1h', 2);
    await lastTickAt('BINANCE');
    expect(sqls().filter((s) => /\b(CREATE|INSERT|UPDATE|DELETE|ALTER|DROP)\b/i.test(s))).toEqual([]);
    expect(await adoptExistingRegimeSnapshotTables()).toBe(true);    // once per process
    expect(sqls().filter((s) => /to_regclass/.test(s))).toHaveLength(1);
  });

  for (const [label, s, r, i] of [
    ['regime_snapshots', false, true, true], ['regime_snapshot_runs', true, false, true], ['the bar-order index', true, true, false],
  ] as const) {
    it(`any relation absent (${label}) → false, and the lazy ensure is NOT marked done`, async () => {
      exists(s, r, i);
      expect(await adoptExistingRegimeSnapshotTables()).toBe(false);
      await ensureRegimeSnapshotTables();
      expect(sqls().filter((x) => /^CREATE/.test(x))).toHaveLength(3);
    });
  }

  it('an empty / null probe result is absent, never assumed present', async () => {
    q.mockResolvedValueOnce([] as never);
    expect(await adoptExistingRegimeSnapshotTables()).toBe(false);
    q.mockResolvedValueOnce([{ s: null, r: true, i: true }] as never);
    expect(await adoptExistingRegimeSnapshotTables()).toBe(false);
  });

  it('a probe error propagates (the judge turns it into INDETERMINATE)', async () => {
    q.mockRejectedValueOnce(new Error('connection refused'));
    await expect(adoptExistingRegimeSnapshotTables()).rejects.toThrow('connection refused');
  });
});

describe('the ONE servability rule', () => {
  it('coverage = written / (universe − too_new), clamped, 0 when nothing was writable', () => {
    expect(generationCoverage({ universe_n: 100, written_n: 90, too_new_n: 0 })).toBe(0.9);
    expect(generationCoverage({ universe_n: 100, written_n: 95, too_new_n: 5 })).toBe(1);
    expect(generationCoverage({ universe_n: 100, written_n: 120, too_new_n: 0 })).toBe(1);
    expect(generationCoverage({ universe_n: 5, written_n: 0, too_new_n: 5 })).toBe(0);
  });

  it('COMPLETE always serves; PARTIAL serves only at coverage; nothing else ever serves', () => {
    expect(isServableRun(run({ disposition: 'COMPLETE', written_n: 0 }), 0.9)).toBe(true);
    expect(isServableRun(run({ disposition: 'PARTIAL', universe_n: 100, too_new_n: 0, written_n: 90 }), 0.9)).toBe(true);
    expect(isServableRun(run({ disposition: 'PARTIAL', universe_n: 100, too_new_n: 0, written_n: 89 }), 0.9)).toBe(false);
    for (const d of ['WINDOW_STALE', 'NOT_DUE', 'SKIPPED_BUDGET', 'FAILED'] as const) {
      expect(isServableRun(run({ disposition: d, universe_n: 10, written_n: 10, too_new_n: 0 }), 0.1), d).toBe(false);
    }
  });

  it('REGIME_SNAPSHOT_MIN_COVERAGE is default-deny: only a finite value in (0, 1] is honoured', () => {
    const at = (v: string | undefined) => regimeSnapshotMinCoverage(v === undefined ? {} : { REGIME_SNAPSHOT_MIN_COVERAGE: v });
    expect(at(undefined)).toBe(DEFAULT_REGIME_SNAPSHOT_MIN_COVERAGE);
    expect(at('0.75')).toBe(0.75);
    expect(at('1')).toBe(1);
    for (const bad of ['', ' ', '0', '-0.5', '1.5', 'abc', 'NaN', 'Infinity', '90%']) {
      expect(at(bad), bad).toBe(DEFAULT_REGIME_SNAPSHOT_MIN_COVERAGE);
    }
  });
});

describe('reads', () => {
  it('latestServableGeneration: newest bar, latest run per bar, coverage in SQL, BIGINT strings coerced', async () => {
    q.mockImplementation(async (sql: string) => (/DISTINCT ON/.test(sql) ? [{
      exchange: 'BINANCE', timeframe: '1h', bar_close_ms: '1792400400000', tick_at: '1792400460000', disposition: 'PARTIAL',
      universe_n: 745, written_n: 700, too_new_n: 5, window_stale_n: 2, skipped_n: 0, errors_n: 38, finished_at: '1792400520000',
    }] : []));
    const g = await latestServableGeneration('BINANCE', '1h', 0.9);
    expect(g).toEqual({
      exchange: 'BINANCE', timeframe: '1h', bar_close_ms: 1_792_400_400_000, disposition: 'PARTIAL', universe_n: 745,
      written_n: 700, too_new_n: 5, window_stale_n: 2, coverage: 700 / 740, tick_at: 1_792_400_460_000, finished_at: 1_792_400_520_000,
    });
    const [sql, params] = callMatching(/DISTINCT ON/)! as [string, unknown[]];
    const flat = sql.replace(/\s+/g, ' ');
    expect(flat).toContain("disposition IN ('COMPLETE','PARTIAL')");
    expect(flat).toContain('ORDER BY bar_close_ms DESC, tick_at DESC');
    expect(flat).toContain("WHERE disposition = 'COMPLETE' OR (universe_n - too_new_n > 0 AND written_n::float8 / (universe_n - too_new_n) >= $3)");
    expect(flat).toMatch(/ORDER BY bar_close_ms DESC LIMIT 1$/);
    expect(params).toEqual(['BINANCE', '1h', 0.9]);
  });

  it('latestServableGeneration: the JS rule backstops the SQL — a row below coverage is never returned', async () => {
    q.mockImplementation(async (sql: string) => (/DISTINCT ON/.test(sql) ? [run({ disposition: 'PARTIAL', universe_n: 100, too_new_n: 0, written_n: 10 })] : []));
    expect(await latestServableGeneration('BINANCE', '1h', 0.9)).toBeNull();
  });

  it('latestServableGeneration: null when the pair has no generation', async () => {
    expect(await latestServableGeneration('OKX', '1h')).toBeNull();
  });

  it('latestServableGeneration: defaults the coverage from the env (default-deny)', async () => {
    process.env.REGIME_SNAPSHOT_MIN_COVERAGE = 'oops';
    await latestServableGeneration('BINANCE', '4h');
    expect(callMatching(/DISTINCT ON/)![1]).toEqual(['BINANCE', '4h', DEFAULT_REGIME_SNAPSHOT_MIN_COVERAGE]);
  });

  it('readGenerationRows reads ONE generation, coin-ordered, numbers coerced', async () => {
    q.mockImplementation(async (sql: string) => (/FROM regime_snapshots WHERE/.test(sql)
      ? [{ ...row('ETH'), bar_close_ms: '1792400400000', confidence: '66', adx: null, regime_since_ms: '1792396800000', computed_at: '1792400500000' }]
      : []));
    const rows = await readGenerationRows('BINANCE', '1h', 1_792_400_400_000);
    expect(rows).toEqual([{ ...row('ETH'), adx: null, regime_since_ms: 1_792_396_800_000 }]);
    const [sql, params] = callMatching(/FROM regime_snapshots WHERE/)! as [string, unknown[]];
    expect(sql).toMatch(/WHERE exchange = \$1 AND timeframe = \$2 AND bar_close_ms = \$3 ORDER BY coin$/);
    expect(params).toEqual(['BINANCE', '1h', 1_792_400_400_000]);
  });

  it('latestRunDisposition ignores NOT_DUE ticks and takes the newest by tick_at', async () => {
    q.mockImplementation(async (sql: string) => (/FROM regime_snapshot_runs WHERE/.test(sql) ? [run({ disposition: 'WINDOW_STALE', exchange: 'OKX' })] : []));
    expect((await latestRunDisposition('OKX', '1h'))?.disposition).toBe('WINDOW_STALE');
    const [sql, params] = callMatching(/FROM regime_snapshot_runs WHERE/)! as [string, unknown[]];
    expect(sql).toMatch(/disposition <> 'NOT_DUE' ORDER BY tick_at DESC LIMIT 1$/);
    expect(params).toEqual(['OKX', '1h']);
  });

  it('latestRunDisposition: null when the pair never had a due tick', async () => {
    expect(await latestRunDisposition('BITGET', '1d')).toBeNull();
  });

  it('latestRunForBar keys on the bar and ignores NOT_DUE', async () => {
    await latestRunForBar('BINANCE', '4h', 123);
    const [sql, params] = callMatching(/bar_close_ms = \$3 AND disposition <> 'NOT_DUE'/)! as [string, unknown[]];
    expect(sql).toMatch(/ORDER BY tick_at DESC LIMIT 1$/);
    expect(params).toEqual(['BINANCE', '4h', 123]);
  });

  it('recentDueRuns clamps its limit to [1, 100] and never interpolates a non-integer', async () => {
    await recentDueRuns('BINANCE', '1h', 3);
    await recentDueRuns('BINANCE', '1h', 1e9);
    await recentDueRuns('BINANCE', '1h', -4);
    await recentDueRuns('BINANCE', '1h', 2.7);
    const limits = sqls().filter((s) => /disposition <> 'NOT_DUE' ORDER BY tick_at DESC LIMIT/.test(s)).map((s) => s.match(/LIMIT (\S+)$/)![1]);
    expect(limits).toEqual(['3', '100', '1', '2']);
  });

  it('lastTickAt reads each pair by PK and returns the newest across timeframes', async () => {
    q.mockImplementation(async (_sql: string, params?: unknown[]) => {
      if (!params) return [];
      const tf = params[1];
      return tf === '1h' ? [{ tick_at: '300' }] : tf === '4h' ? [{ tick_at: '100' }] : [];
    });
    expect(await lastTickAt('BINANCE')).toBe(300);
    expect(await lastTickAt('BINANCE', '4h')).toBe(100);
    expect(await lastTickAt('BINANCE', '1d')).toBeNull();
    for (const s of sqls().filter((x) => /SELECT tick_at/.test(x))) expect(s).toMatch(/ORDER BY tick_at DESC LIMIT 1$/);
  });
});

describe('sampledRegimeVenues — env ∩ ACTIVE promoted, unknown tokens dropped with ONE warning', () => {
  const active = vi.mocked(getActivePromotedVenueIds);
  beforeEach(() => active.mockResolvedValue(['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'ASTER'] as never));

  it('defaults to BINANCE,BYBIT,OKX,BITGET', async () => {
    expect(await sampledRegimeVenues(1, {})).toEqual(['BINANCE', 'BYBIT', 'OKX', 'BITGET']);
  });

  it('a retired venue drops out with zero code change', async () => {
    active.mockResolvedValue(['HL', 'BINANCE', 'BYBIT', 'BITGET'] as never);
    expect(await sampledRegimeVenues(1, {})).toEqual(['BINANCE', 'BYBIT', 'BITGET']);
  });

  it('narrows, dedupes, normalises case, and warns once for everything it ignores', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await sampledRegimeVenues(1, { REGIME_SNAPSHOT_VENUES: ' binance, OKX ,BINANCE, NOPE, GATE' })).toEqual(['BINANCE', 'OKX']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('NOPE,GATE');
    warn.mockRestore();
  });

  it('an empty env value is the default, not an empty venue set', async () => {
    expect(await sampledRegimeVenues(1, { REGIME_SNAPSHOT_VENUES: '  ' })).toEqual(['BINANCE', 'BYBIT', 'OKX', 'BITGET']);
  });
});

// DECISION-CALL-V1-W2 R5 — the additive single-coin read pre_trade_check uses.
describe('readGenerationRow', () => {
  beforeEach(() => { q.mockReset(); _resetRegimeSnapshotsEnsure(); });
  it('reads ONE coin of ONE generation by its primary key, numbers coerced', async () => {
    q.mockImplementation(async (sql: string) => (/FROM regime_snapshots WHERE/.test(sql)
      ? [{ ...row('BTC'), bar_close_ms: '1792400400000', confidence: '71', regime_since_ms: null, computed_at: '1792400500000' }]
      : []));
    expect(await readGenerationRow('BINANCE', '4h', 1_792_400_400_000, 'BTC')).toEqual({ ...row('BTC'), confidence: 71 });
    const [sql, params] = callMatching(/FROM regime_snapshots WHERE/)! as [string, unknown[]];
    expect(sql).toMatch(/WHERE exchange = \$1 AND timeframe = \$2 AND bar_close_ms = \$3 AND coin = \$4$/);
    expect(params).toEqual(['BINANCE', '4h', 1_792_400_400_000, 'BTC']);
  });
  it('null when the generation has no row for the coin', async () => {
    q.mockImplementation(async () => []);
    expect(await readGenerationRow('BINANCE', '4h', 1_792_400_400_000, 'NOPE')).toBeNull();
  });
});
