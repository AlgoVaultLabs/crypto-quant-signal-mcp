/**
 * regime-snapshot-surfaces.test.ts — REGIME-15M-SERVE-W1 CH1 (G2: no snapshot-fed surface gains 15m).
 *
 * get_market_regime now serves 15m live. The surfaces fed by the bar-close regime snapshot serve only what the
 * sampler writes, `REGIME_SNAPSHOT_TIMEFRAMES` (1h, 4h, 1d): 15m snapshots are Mr.1's G2 decision, taken from the
 * T6 trigger's data. Surfaces (R0's grep, vault audits/REGIME-15M-SERVE-W1-evidence.md row 13):
 *   scan_market_regimes and pre_trade_check — Zod enum, declaration, pipeline admission (behaviourally, via callTool);
 *   the sampler — iterates the snapshot set;
 *   the regime track record (regime-forward) — scores the timeframes of T3's TFS;
 *   regime_shift webhooks — NOT snapshot-fed (R0 correction 14): detected from get_trade_call `signals` rows by the
 *     recordSignal hook. The invariant that matters is that get_market_regime, the one path gaining 15m, is no
 *     regime_shift producer: it writes no signals row.
 *
 * THE SENTINEL: every src file whose CODE (comments stripped) names the regime_snapshots table, the snapshot module or
 * the snapshot set must be HELD below with its surface. A new reader fails here until it is classified.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../../src/lib/performance-db.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/performance-db.js')>()),
  dbQuery: vi.fn().mockResolvedValue([]),
  dbExec: vi.fn(),
}));

import { REGIME_SNAPSHOT_TIMEFRAMES } from '../../src/lib/regime-snapshot-timeframes.js';
import { REGIME_TIMEFRAMES, SCAN_MARKET_REGIMES_PARAM_DECL, PRE_TRADE_CHECK_PARAM_DECL, PUBLIC_TOOL_ENUM_PARAMS } from '../../src/lib/tool-param-schema.js';
import { SCAN_MARKET_REGIMES_SCHEMA } from '../../src/tools/scan-market-regimes.js';
import { PRE_TRADE_CHECK_SCHEMA } from '../../src/tools/pre-trade-check.js';
import { TFS } from '../../src/scripts/regime-forward/forward-spec.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const SNAP = ['1h', '4h', '1d'];

/** Comments stripped, string contents kept (a `//` inside a quoted URL is preserved). */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
/** The sentinel's predicate: names the table, the snapshot module, its timeframe leaf, or the snapshot set. */
const SNAPSHOT_REF = /regime_snapshots|regime-snapshots\.js|regime-snapshot-timeframes\.js|REGIME_SNAPSHOT_TIMEFRAMES/;
/** What a snapshot surface must never name: get_market_regime's live set or its served registry. */
const LIVE_REF = /\bREGIME_TIMEFRAMES\b|REGIME_SERVED_|regime-served-/;

type Surface = 'declaration' | 'store' | 'scan_market_regimes' | 'pre_trade_check' | 'sampler' | 'admission' | 'table-adoption';
/** Every src file the sentinel finds, and its surface. `liveToo` = it also declares get_market_regime's set (allowed). */
const HELD: Record<string, { surface: Surface; liveToo?: true }> = {
  'src/lib/regime-snapshot-timeframes.ts': { surface: 'declaration' },
  'src/lib/regime-snapshots.ts': { surface: 'store' },
  'src/lib/market-regime-scanner.ts': { surface: 'scan_market_regimes' },
  'src/tools/scan-market-regimes.ts': { surface: 'scan_market_regimes' },
  'src/tools/pre-trade-check.ts': { surface: 'pre_trade_check' },
  'src/scripts/regime-snapshot-sampler.ts': { surface: 'sampler' },
  'src/scripts/pre-trade-health.ts': { surface: 'table-adoption' },
  'src/lib/tool-param-schema.ts': { surface: 'declaration', liveToo: true },
  'src/lib/tool-admission-timeframes.ts': { surface: 'admission', liveToo: true },
};

describe('the sentinel — every snapshot reader is held and classified', () => {
  const found = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter((f) => f.endsWith('.ts')).filter((f) => SNAPSHOT_REF.test(code(src(f)))).sort();

  it('the corpus is non-vacuous and equals the held list exactly (a new reader must be classified here)', () => {
    expect(found.length).toBeGreaterThanOrEqual(8);
    expect(found).toEqual(Object.keys(HELD).sort());
  });

  it('the predicate can fire: code naming the table is caught, the same words in a comment are not', () => {
    expect(SNAPSHOT_REF.test(code("const q = 'SELECT regime FROM regime_snapshots WHERE timeframe = $1';"))).toBe(true);
    expect(SNAPSHOT_REF.test(code('// reads regime_snapshots\n/* REGIME_SNAPSHOT_TIMEFRAMES */\nconst x = 1;'))).toBe(false);
  });

  it('no held snapshot surface names get_market_regime\'s live set or the served registry', () => {
    for (const [file, h] of Object.entries(HELD)) {
      if (h.liveToo) continue;
      expect(code(src(file)), file).not.toMatch(LIVE_REF);
    }
  });
});

describe('the snapshot set itself', () => {
  it('is 1h, 4h, 1d — no 15m — and a strict subset of get_market_regime\'s served set', () => {
    expect([...REGIME_SNAPSHOT_TIMEFRAMES]).toEqual(SNAP);
    expect(REGIME_SNAPSHOT_TIMEFRAMES).not.toContain('15m');
    for (const tf of REGIME_SNAPSHOT_TIMEFRAMES) expect(REGIME_TIMEFRAMES).toContain(tf);
    expect(REGIME_TIMEFRAMES.length).toBeGreaterThan(REGIME_SNAPSHOT_TIMEFRAMES.length);
    expect(REGIME_TIMEFRAMES).toContain('15m');
  });
});

describe('scan_market_regimes and pre_trade_check admit exactly the snapshot set', () => {
  it('their declarations and docs rows are the snapshot set', () => {
    expect(SCAN_MARKET_REGIMES_PARAM_DECL.enums.timeframe.values).toBe(REGIME_SNAPSHOT_TIMEFRAMES);
    expect(PRE_TRADE_CHECK_PARAM_DECL.timeframe.values).toBe(REGIME_SNAPSHOT_TIMEFRAMES);
    expect(PUBLIC_TOOL_ENUM_PARAMS.scan_market_regimes.timeframe.values).toBe(REGIME_SNAPSHOT_TIMEFRAMES);
    expect(PUBLIC_TOOL_ENUM_PARAMS.pre_trade_check.timeframe.values).toBe(REGIME_SNAPSHOT_TIMEFRAMES);
  });

  it('their Zod enums accept 1h, 4h, 1d and refuse 15m', () => {
    for (const schema of [SCAN_MARKET_REGIMES_SCHEMA.timeframe, PRE_TRADE_CHECK_SCHEMA.timeframe]) {
      for (const tf of SNAP) expect(schema.safeParse(tf).success, tf).toBe(true);
      expect(schema.safeParse('15m').success).toBe(false);
    }
  });

  describe('their pipeline admission (callTool, hosted backend): 15m refused naming 1h, 4h, 1d; the snapshot set dispatched', () => {
    const MOCKED = ['../../src/lib/analytics.js', '../../src/tools/scan-market-regimes.js', '../../src/tools/pre-trade-check.js', '../../src/lib/performance-db.js'];
    beforeEach(() => {
      vi.resetModules();
      vi.doMock('../../src/lib/analytics.js', async (orig) => ({ ...(await orig<typeof import('../../src/lib/analytics.js')>()), logRequest: () => {} }));
      vi.doMock('../../src/lib/performance-db.js', async (orig) => ({
        ...(await orig<typeof import('../../src/lib/performance-db.js')>()),
        isPgBackend: () => true, dbQuery: vi.fn().mockResolvedValue([]), dbExec: vi.fn(), upsertAgentSession: vi.fn(),
      }));
      vi.doMock('../../src/tools/scan-market-regimes.js', async (orig) => ({
        ...(await orig<typeof import('../../src/tools/scan-market-regimes.js')>()),
        runScanMarketRegimes: async () => ({ dispatched: true }),
      }));
      vi.doMock('../../src/tools/pre-trade-check.js', async (orig) => ({
        ...(await orig<typeof import('../../src/tools/pre-trade-check.js')>()),
        runPreTradeCheck: async () => ({ kind: 'ok', result: { dispatched: true } }),
      }));
    });
    afterEach(() => { for (const m of MOCKED) vi.doUnmock(m); vi.resetModules(); });

    const INTERNAL = { tier: 'internal', key: null, outcome: 'RESOLVED' } as const;
    const INPUT: Record<string, Record<string, unknown>> = {
      scan_market_regimes: {},
      pre_trade_check: { coin: 'BTC', side: 'long', sizeUsd: 1000 },
    };

    for (const tool of ['scan_market_regimes', 'pre_trade_check'] as const) {
      it(tool, async () => {
        const { callTool } = await import('../../src/lib/tool-call-pipeline.js');
        const call = (timeframe: string) => callTool({ tool, input: { ...INPUT[tool], timeframe } as never, license: INTERNAL as never, channel: 'mcp' });
        const refused = await call('15m') as { ok: boolean; payload?: { code?: string; valid_timeframes?: string[] } };
        expect(refused.ok).toBe(false);
        expect(refused.payload?.code).toBe('INVALID_TIMEFRAME');
        expect(refused.payload?.valid_timeframes).toEqual(SNAP);
        for (const tf of SNAP) {
          const out = await call(tf) as { ok: boolean; payload?: { code?: string } };
          expect(out.payload?.code, `${tool} ${tf}`).not.toBe('INVALID_TIMEFRAME');
        }
      });
    }
  });
});

describe('the sampler and the regime track record read the snapshot set only', () => {
  it('the sampler iterates REGIME_SNAPSHOT_TIMEFRAMES at both of its loops', () => {
    const s = code(src('src/scripts/regime-snapshot-sampler.ts'));
    expect(s.match(/for \(const \w+ of REGIME_SNAPSHOT_TIMEFRAMES\)/g)?.length).toBe(2);
  });

  it('the regime track record (regime-forward) scores exactly the snapshot timeframes', () => {
    expect(TFS.map((t) => t.key)).toEqual(SNAP);
  });
});

describe('regime_shift webhooks are fed by trade-call rows; get_market_regime is no producer', () => {
  it('detectEvents runs only from performance-db\'s recordSignal hook', () => {
    const callers = execFileSync('git', ['grep', '-l', "import('./webhook-events.js')\\|from './webhook-events.js'\\|from '../lib/webhook-events.js'", '--', 'src'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter(Boolean).sort();
    expect(callers).toEqual(['src/lib/performance-db.ts']);
  });

  it('get_market_regime writes no signals row: its module never calls recordSignal or reaches the webhook layer', () => {
    const s = code(src('src/tools/get-market-regime.ts'));
    expect(s).not.toMatch(/\brecordSignal\b|webhook/);
    const row = code(src('src/lib/tool-call-pipeline.ts'));
    const at = row.indexOf('\n  get_market_regime: {');
    const end = row.indexOf('\n  scan_funding_arb: {', at);
    expect(at).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(at);
    expect(row.slice(at, end)).not.toMatch(/\brecordSignal\b/);
  });
});
