/**
 * verdict-rule-registry.test.ts — SIGNAL-VERDICT-RULE-REGISTRY-W1 CH2 (R1–R5), and the CH3 gate's
 * registry leg.
 *
 * WHAT CHANGED. `TREND_MODE` was ONE global boolean (`src/lib/trend-mode-flag.ts`): a scoring rule
 * could only ever be switched for every timeframe at once, so every scoped finding became a global
 * one. The registry replaces it with a committed per-cell assignment — 10 timeframes ×
 * {TRENDING_UP, TRENDING_DOWN} → M (today's rule) | F (fade) | H (hold) — read once per call, with
 * every projection (the response, the ledger, the three persist arms, the capture) reading that ONE
 * resolution. This wave serves M in all 20 cells; F and H are built, tested and unreachable.
 *
 * Pinned here:
 *   - the committed assignment: exactly the registered cells, every one M, no H;
 *   - the kill switch: exact '1' forces M everywhere and can never select v1 (rollback denied);
 *   - the H refusal: REFUSES (cell → M, one CRITICAL line, a counter), never throws;
 *   - `rule_config_id`: deterministic, order-independent, sensitive to the assignment and the switch;
 *   - the variants: decisive ⇔ v1 would not have produced the served side; F = opposite side, same
 *     |raw|, same confidence; H = HOLD; every non-decisive row identical under every variant;
 *   - the stamp (ruling Q2 = A, row-level): 3 only where the served side came from F, else 2, never 1;
 *   - the selector is retired: nothing in src reads `TREND_MODE`;
 *   - the wiring in `getTradeSignal`: stamp + capture reach the writers; F and H change the served
 *     call exactly as specified; H writes no `hold_decisions` row (ruling Q3 = A).
 *
 * SPAWN BUDGET: none required — nothing here spawns a process.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

vi.mock('../../src/lib/exchange-adapter.js', () => ({ getAdapter: vi.fn() }));
vi.mock('../../src/lib/performance-db.js', () => ({
  recordSignal: vi.fn(),
  recordFunding: vi.fn(),
  recordHoldCount: vi.fn(),
  getFundingZScore: vi.fn().mockResolvedValue(null),
  getDb: vi.fn(),
  isShortLivedScript: () => false,
}));
vi.mock('../../src/lib/scorer-input-capture.js', () => ({ recordScorerInputCapture: vi.fn() }));
vi.mock('../../src/lib/band-signal-capture.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/band-signal-capture.js')>()),
  recordBandSignalCapture: vi.fn(),
}));
vi.mock('../../src/lib/hold-decision-capture.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/hold-decision-capture.js')>()),
  recordHoldDecision: vi.fn(),
}));

import {
  VERDICT_RULE_ASSIGNMENT, REGISTRY_TIMEFRAMES, TREND_REGIMES,
  type VerdictRuleAssignment, type RuleVariant,
} from '../../src/lib/verdict-rule-assignment.js';
import {
  resolveVerdictRule, effectiveAssignment, ruleConfigId, killSwitchActive,
  _resetHRefusalStateForTest, _setRegistryOverrideForTest,
  VERDICT_RULE_VERSION, KILL_SWITCH_ENV, H_HOLD_STORE_SHIPPED,
} from '../../src/lib/verdict-rule-registry.js';
import { getTradeSignal, computeIndicatorScores } from '../../src/tools/get-trade-call.js';
import { getAdapter } from '../../src/lib/exchange-adapter.js';
import * as perfDb from '../../src/lib/performance-db.js';
import { recordScorerInputCapture } from '../../src/lib/scorer-input-capture.js';
import { recordBandSignalCapture } from '../../src/lib/band-signal-capture.js';
import { recordHoldDecision } from '../../src/lib/hold-decision-capture.js';
import { resetLicenseCache } from '../../src/lib/license.js';
import { _setSnapshotForTest, _clearCache, _setScorerOverride } from '../../src/lib/cross-asset-grid.js';
import type { AssetContext, Candle, ExchangeAdapter, LicenseInfo, SignalVerdict } from '../../src/types.js';

const REPO_ROOT = join(__dirname, '..', '..');

/** Every cell set to one variant — a scratch assignment for the tests, never the committed one. */
function uniform(v: RuleVariant): VerdictRuleAssignment {
  return Object.fromEntries(REGISTRY_TIMEFRAMES.map((tf) => [tf, { TRENDING_UP: v, TRENDING_DOWN: v }])) as VerdictRuleAssignment;
}
function withCell(base: VerdictRuleAssignment, tf: string, regime: 'TRENDING_UP' | 'TRENDING_DOWN', v: RuleVariant): VerdictRuleAssignment {
  const out = JSON.parse(JSON.stringify(base));
  out[tf][regime] = v;
  return out as VerdictRuleAssignment;
}

const BUY = (raw = 60, confidence = 67) => ({ signal: 'BUY' as SignalVerdict, rawScore: raw, confidence });
const SELL = (raw = -62, confidence = 70) => ({ signal: 'SELL' as SignalVerdict, rawScore: raw, confidence });
const HOLDV = (raw = 12) => ({ signal: 'HOLD' as SignalVerdict, rawScore: raw });

describe('R1 — the committed assignment', () => {
  it('covers exactly the registered cells: the registration\'s 10 timeframes × {TRENDING_UP, TRENDING_DOWN}', () => {
    const reg = readFileSync(join(REPO_ROOT, 'audits', 'verdict-rule-registry-preregistration-2026-10-02.md'), 'utf8');
    const line = reg.split('\n').find((l) => l.includes('The 10 live timeframes are'));
    expect(line, 'the registration names its timeframes on one line').toBeDefined();
    const registered = [...line!.matchAll(/\b(\d+[mhd])\b/g)].map((m) => m[1]);
    expect(registered).toEqual([...REGISTRY_TIMEFRAMES]);
    expect([...TREND_REGIMES]).toEqual(['TRENDING_UP', 'TRENDING_DOWN']);
    expect(Object.keys(VERDICT_RULE_ASSIGNMENT)).toEqual([...REGISTRY_TIMEFRAMES]);
    for (const tf of REGISTRY_TIMEFRAMES) {
      expect(Object.keys(VERDICT_RULE_ASSIGNMENT[tf]).sort()).toEqual(['TRENDING_DOWN', 'TRENDING_UP']);
    }
  });

  it('serves M in all 20 cells — this wave switches nothing', () => {
    const cells = REGISTRY_TIMEFRAMES.flatMap((tf) => TREND_REGIMES.map((r) => VERDICT_RULE_ASSIGNMENT[tf][r]));
    expect(cells).toHaveLength(20);
    expect(new Set(cells)).toEqual(new Set(['M']));
  });

  it('commits no H, and H stays refused until a quarantined H-hold store ships (ruling Q3)', () => {
    expect(H_HOLD_STORE_SHIPPED).toBe(false);
    const cells = REGISTRY_TIMEFRAMES.flatMap((tf) => TREND_REGIMES.map((r) => VERDICT_RULE_ASSIGNMENT[tf][r]));
    expect(cells).not.toContain('H');
  });
});

describe('R1 — the kill switch forces M, and only M', () => {
  it('only the exact string "1" engages it', () => {
    for (const v of [undefined, '', '0', 'true', 'TRUE', 'yes', 'on', ' 1', '1 ', '01', '2']) {
      expect(killSwitchActive({ [KILL_SWITCH_ENV]: v } as NodeJS.ProcessEnv), `value ${JSON.stringify(v)}`).toBe(false);
    }
    expect(killSwitchActive({ [KILL_SWITCH_ENV]: '1' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('forces every cell to M over an assignment that switches every cell (scratch run)', () => {
    const forced = effectiveAssignment({ assignment: uniform('F'), env: { [KILL_SWITCH_ENV]: '1' } as NodeJS.ProcessEnv });
    expect(forced).toEqual(uniform('M'));
    const free = effectiveAssignment({ assignment: uniform('F'), env: {} as NodeJS.ProcessEnv });
    expect(free).toEqual(uniform('F'));
  });

  it('has no path to v1 serving: under the switch, a decisive call is served as M, never as v1', () => {
    const r = resolveVerdictRule(
      { timeframe: '1h', regime: 'TRENDING_UP', m: BUY(), v1: HOLDV() },
      { assignment: uniform('F'), env: { [KILL_SWITCH_ENV]: '1' } as NodeJS.ProcessEnv },
    );
    expect(r.served.signal).toBe('BUY');
    expect(r.variant).toBe('M');
    expect(r.stamp.verdictRuleVersion).toBe(2);
  });
});

describe('R1 — an H assignment is REFUSED, never thrown', () => {
  beforeEach(() => _resetHRefusalStateForTest());

  it('refuses H to M on every call, with ONE CRITICAL line per refused cell', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const committed = withCell(uniform('M'), '8h', 'TRENDING_DOWN', 'H');
      const a = effectiveAssignment({ assignment: committed, env: {} as NodeJS.ProcessEnv });
      const b = effectiveAssignment({ assignment: committed, env: {} as NodeJS.ProcessEnv });
      expect(a['8h'].TRENDING_DOWN).toBe('M');
      expect(b['8h'].TRENDING_DOWN).toBe('M');
      const critical = errors.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('CRITICAL'));
      expect(critical).toHaveLength(1);
      expect(critical[0]).toContain('8h');
      expect(critical[0]).toContain('TRENDING_DOWN');
    } finally {
      errors.mockRestore();
    }
  });

  it('keeps H only when the H-hold store is declared shipped (the branch is built and testable)', () => {
    const committed = withCell(uniform('M'), '8h', 'TRENDING_DOWN', 'H');
    const a = effectiveAssignment({ assignment: committed, env: {} as NodeJS.ProcessEnv, hHoldStore: true });
    expect(a['8h'].TRENDING_DOWN).toBe('H');
  });
});

describe('R1 — rule_config_id', () => {
  it('is a 64-hex sha256 and deterministic', () => {
    const id = ruleConfigId({ env: {} as NodeJS.ProcessEnv });
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(ruleConfigId({ env: {} as NodeJS.ProcessEnv })).toBe(id);
  });

  it('moves with the kill-switch state and with any one cell, and with nothing else', () => {
    const base = ruleConfigId({ assignment: uniform('M'), env: {} as NodeJS.ProcessEnv });
    expect(ruleConfigId({ assignment: uniform('M'), env: { [KILL_SWITCH_ENV]: '1' } as NodeJS.ProcessEnv })).not.toBe(base);
    expect(ruleConfigId({ assignment: withCell(uniform('M'), '3m', 'TRENDING_DOWN', 'F'), env: {} as NodeJS.ProcessEnv })).not.toBe(base);
    expect(ruleConfigId({ assignment: uniform('M'), env: { TREND_MODE: 'on' } as NodeJS.ProcessEnv })).toBe(base);
  });

  it('does not rent its identity from object key order (order-independence)', () => {
    const forward = uniform('M');
    const reversed = Object.fromEntries(
      [...REGISTRY_TIMEFRAMES].reverse().map((tf) => [tf, { TRENDING_DOWN: 'M', TRENDING_UP: 'M' }]),
    ) as VerdictRuleAssignment;
    expect(ruleConfigId({ assignment: reversed, env: {} as NodeJS.ProcessEnv }))
      .toBe(ruleConfigId({ assignment: forward, env: {} as NodeJS.ProcessEnv }));
  });

  it('the committed default equals the explicit committed assignment', () => {
    expect(ruleConfigId({ env: {} as NodeJS.ProcessEnv }))
      .toBe(ruleConfigId({ assignment: VERDICT_RULE_ASSIGNMENT, env: {} as NodeJS.ProcessEnv }));
  });
});

describe('R2 — the variants act only on trend-mode-decisive calls', () => {
  const env = {} as NodeJS.ProcessEnv;

  it('decisive ⇔ the emitted side would not be produced with the negation off', () => {
    const cases: Array<[SignalVerdict, SignalVerdict, boolean]> = [
      ['BUY', 'HOLD', true], ['BUY', 'SELL', true], ['BUY', 'BUY', false],
      ['SELL', 'HOLD', true], ['SELL', 'BUY', true], ['SELL', 'SELL', false],
      ['HOLD', 'BUY', false], ['HOLD', 'HOLD', false],
    ];
    for (const [m, v1, decisive] of cases) {
      const r = resolveVerdictRule(
        { timeframe: '1h', regime: 'TRENDING_UP', m: { signal: m, rawScore: 50, confidence: 56 }, v1: { signal: v1, rawScore: 10 } },
        { env },
      );
      expect(r.decisive, `m=${m} v1=${v1}`).toBe(decisive);
      expect(r.capture.trendDecisive).toBe(decisive);
    }
  });

  it('F serves the opposite side with the same |raw| and the same confidence', () => {
    const r = resolveVerdictRule(
      { timeframe: '4h', regime: 'TRENDING_DOWN', m: SELL(-62, 70), v1: HOLDV(-38) },
      { assignment: withCell(uniform('M'), '4h', 'TRENDING_DOWN', 'F'), env },
    );
    expect(r.variant).toBe('F');
    expect(r.served).toEqual({ signal: 'BUY', rawScore: 62, confidence: 70 });
    expect(r.stamp.verdictRuleVersion).toBe(3);
    expect(r.capture).toMatchObject({ verdictM: 'SELL', verdictF: 'BUY', verdictH: 'HOLD', v1Signal: 'HOLD', v1RawFinal: -38 });
  });

  it('H serves HOLD on a decisive call (store declared shipped)', () => {
    const r = resolveVerdictRule(
      { timeframe: '4h', regime: 'TRENDING_UP', m: BUY(), v1: HOLDV() },
      { assignment: withCell(uniform('M'), '4h', 'TRENDING_UP', 'H'), env, hHoldStore: true },
    );
    expect(r.variant).toBe('H');
    expect(r.served.signal).toBe('HOLD');
    expect(r.served.confidence).toBe(67);
  });

  it('a NON-decisive call is identical under every variant, and stamps 2 even in an F cell (ruling Q2 = A)', () => {
    for (const v of ['M', 'F', 'H'] as RuleVariant[]) {
      const r = resolveVerdictRule(
        { timeframe: '2h', regime: 'TRENDING_UP', m: BUY(55, 62), v1: { signal: 'BUY', rawScore: 49 } },
        { assignment: uniform(v), env, hHoldStore: true },
      );
      expect(r.served).toEqual({ signal: 'BUY', rawScore: 55, confidence: 62 });
      expect(r.variant).toBe('M');
      expect(r.stamp.verdictRuleVersion).toBe(2);
      expect(r.capture).toMatchObject({ verdictM: 'BUY', verdictF: 'BUY', verdictH: 'BUY', trendDecisive: false });
    }
  });

  it('RANGING, a null regime and a timeframe outside the cells (1m) are never cells — always M', () => {
    for (const [timeframe, regime] of [['1h', 'RANGING'], ['1h', null], ['1m', 'TRENDING_UP'], ['1w', 'TRENDING_DOWN']] as const) {
      const r = resolveVerdictRule(
        { timeframe, regime, m: BUY(), v1: HOLDV() },
        { assignment: uniform('F'), env },
      );
      expect(r.cellVariant, `${timeframe}/${regime}`).toBeNull();
      expect(r.served.signal).toBe('BUY');
      expect(r.stamp.verdictRuleVersion).toBe(2);
    }
  });

  it('never stamps 1, over every (m, v1, cell) combination', () => {
    const sides: SignalVerdict[] = ['BUY', 'SELL', 'HOLD'];
    for (const cell of ['M', 'F'] as RuleVariant[]) {
      for (const m of sides) {
        for (const v1 of sides) {
          const r = resolveVerdictRule(
            { timeframe: '30m', regime: 'TRENDING_DOWN', m: { signal: m, rawScore: m === 'SELL' ? -60 : 60, confidence: 66 }, v1: { signal: v1, rawScore: 0 } },
            { assignment: uniform(cell), env },
          );
          expect([2, 3]).toContain(r.stamp.verdictRuleVersion);
          expect(r.stamp.verdictRuleVersion === 3).toBe(r.variant === 'F');
          expect(r.stamp.ruleConfigId).toMatch(/^[0-9a-f]{64}$/);
        }
      }
    }
  });

  it('the version map is M → 2, F → 3', () => {
    expect(VERDICT_RULE_VERSION).toEqual({ M: 2, F: 3 });
  });
});

describe('R1 — the TREND_MODE selector is retired (single derivation)', () => {
  it('the flag module is gone and no src file reads TREND_MODE or calls getTrendMode', () => {
    expect(existsSync(join(REPO_ROOT, 'src', 'lib', 'trend-mode-flag.ts'))).toBe(false);
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!['.ts', '.js', '.mjs'].includes(extname(p))) continue;
        // comments stripped: a sentence about the retired flag is history, not a read
        const code = readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
        if (/process\.env\.TREND_MODE|getTrendMode\s*\(|trend-mode-flag/.test(code)) hits.push(p);
      }
    };
    walk(join(REPO_ROOT, 'src'));
    expect(hits).toEqual([]);
  });

  it('the env var no longer changes a resolution', () => {
    const a = resolveVerdictRule({ timeframe: '1h', regime: 'TRENDING_UP', m: BUY(), v1: HOLDV() }, { env: {} as NodeJS.ProcessEnv });
    const b = resolveVerdictRule({ timeframe: '1h', regime: 'TRENDING_UP', m: BUY(), v1: HOLDV() }, { env: { TREND_MODE: 'off' } as NodeJS.ProcessEnv });
    expect(b).toEqual(a);
  });
});

describe('R4 — the scorer exposes the pre-negation bucket', () => {
  const series = (pct: number): Candle[] => {
    let p = 100;
    return Array.from({ length: 140 }, (_, i) => {
      if (i > 0) p = p * (1 + pct);
      return { time: i * 14_400_000, open: p, high: p * 1.004, low: p * 0.996, close: p, volume: 1_000 };
    });
  };
  const inputs = (c: Candle[]) => ({ candles: c, fundingRateAnnualized: 0, priceChange: 0.03, openInterest: 1_000_000, trendMode: true });

  it('inside a confirmed trend with a saturated RSI, the served bucket is the negation of rsiScorePre', () => {
    const up = computeIndicatorScores(inputs(series(0.012)));
    expect(up.regime).toBe('TRENDING_UP');
    expect(up.rsiScorePre).toBe(-100);
    expect(up.rsiScore).toBe(100);
    const down = computeIndicatorScores(inputs(series(-0.012)));
    expect(down.regime).toBe('TRENDING_DOWN');
    expect(down.rsiScore).toBe(-down.rsiScorePre);
    expect(down.rsiScore).toBeLessThan(0);
  });

  it('outside a trend the two are equal', () => {
    const flat = computeIndicatorScores(inputs(series(0)));
    expect(flat.regime).toBe('RANGING');
    expect(flat.rsiScore).toBe(flat.rsiScorePre);
  });
});

// ── the wiring inside getTradeSignal ──────────────────────────────────────────────────────────

const LICENSE: LicenseInfo = { tier: 'x402', key: null };
function shaped(pct: number, lastVol: number): Candle[] {
  let p = 100;
  return Array.from({ length: 140 }, (_, i) => {
    if (i > 0) p = p * (1 + pct);
    return { time: i * 14_400_000, open: p, high: p * 1.004, low: p * 0.996, close: p, volume: i === 139 ? lastVol : 1_000 };
  });
}
function adapterFor(candles: Candle[], prevMove: number): ExchangeAdapter {
  const last = candles[candles.length - 1].close;
  const ctx = {
    coin: 'BTC', funding: 0, fundingAnnualized: 0, openInterest: 5_000_000,
    prevDayPx: last / (1 + prevMove), volume24h: 1e8, oraclePx: last, markPx: last,
  } as AssetContext;
  return {
    getName: () => 'RegistryExchange',
    getCandles: vi.fn().mockResolvedValue(candles.map((c) => ({ ...c }))),
    getAssetContext: vi.fn().mockResolvedValue(ctx),
    getPredictedFundings: vi.fn().mockResolvedValue([]),
    getCurrentPrice: vi.fn().mockResolvedValue(last),
  } as unknown as ExchangeAdapter;
}
/** A decisive tracked BUY (TRENDING_UP, saturated RSI) and a decisive tracked SELL (TRENDING_DOWN). */
const DECISIVE_BUY = () => adapterFor(shaped(0.012, 2_600), 0.05);
const DECISIVE_SELL = () => adapterFor(shaped(-0.012, 300), -0.05);
const BAND_BUY = () => adapterFor(shaped(0.012, 300), 0.05);

describe('R2–R4 — the wiring in getTradeSignal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLicenseCache();
    _clearCache();
    _setScorerOverride(null);
    _setSnapshotForTest([]);
    _setRegistryOverrideForTest(null);
    process.env.CQS_API_KEY = 'test-key';
    delete process.env.TREND_MODE;
  });
  afterEach(() => _setRegistryOverrideForTest(null));

  it('all-M: a decisive BUY is served as M and every writer gets stamp 2 + the committed rule_config_id + the capture', async () => {
    vi.mocked(getAdapter).mockReturnValue(DECISIVE_BUY());
    const r = await getTradeSignal({ coin: 'BTC', timeframe: '4h', license: LICENSE });
    expect(r.call).toBe('BUY');
    const expected = { verdictRuleVersion: 2, ruleConfigId: ruleConfigId({}) };
    const sig = vi.mocked(perfDb.recordSignal).mock.calls;
    expect(sig).toHaveLength(1);
    expect(sig[0][8]).toEqual(expected);
    const cap = vi.mocked(recordScorerInputCapture).mock.calls;
    expect(cap).toHaveLength(1);
    expect(cap[0][0].stamp).toEqual(expected);
    expect(cap[0][0].capture).toMatchObject({
      trendDecisive: true, v1Signal: 'HOLD', verdictM: 'BUY', verdictF: 'SELL', verdictH: 'HOLD',
      rsiScorePre: -100, fundingZ: null,
    });
    expect(typeof cap[0][0].capture.v1RawFinal).toBe('number');
    expect(typeof cap[0][0].capture.rsiValue).toBe('number');
    expect(r.reasoning).not.toMatch(/Fade rule|Hold rule/);
    expect((r._receipts as Record<string, unknown> | undefined)?.rule_variant).toBeUndefined();
  });

  it('the band writer takes the stamp argument (ruling Q4)', async () => {
    vi.mocked(getAdapter).mockReturnValue(BAND_BUY());
    const r = await getTradeSignal({ coin: 'SOL', timeframe: '4h', license: LICENSE });
    expect(r.call).toBe('BUY');
    expect(r.confidence).toBeLessThan(52);
    const band = vi.mocked(recordBandSignalCapture).mock.calls;
    expect(band).toHaveLength(1);
    expect(band[0][0].verdictRuleVersion).toBe(2);
  });

  it('F (scratch assignment): the decisive SELL is served as a BUY at the same confidence, stamped 3, and named', async () => {
    vi.mocked(getAdapter).mockReturnValue(DECISIVE_SELL());
    const m = await getTradeSignal({ coin: 'BTC', timeframe: '4h', license: LICENSE });
    expect(m.call).toBe('SELL');
    vi.clearAllMocks();
    vi.mocked(getAdapter).mockReturnValue(DECISIVE_SELL());
    _setRegistryOverrideForTest({ assignment: withCell(uniform('M'), '4h', 'TRENDING_DOWN', 'F') });
    const f = await getTradeSignal({ coin: 'BTC', timeframe: '4h', license: LICENSE });
    expect(f.call).toBe('BUY');
    expect(f.confidence).toBe(m.confidence);
    expect(f.reasoning).toContain('Fade rule');
    expect(f.reasoning.length).toBeLessThanOrEqual(280);
    expect((f._receipts as Record<string, unknown> | undefined)?.rule_variant).toBe('fade');
    const sig = vi.mocked(perfDb.recordSignal).mock.calls;
    expect(sig[0][1]).toBe('BUY');
    expect((sig[0][8] as { verdictRuleVersion: number }).verdictRuleVersion).toBe(3);
    expect(vi.mocked(recordScorerInputCapture).mock.calls[0][0].capture).toMatchObject({ verdictM: 'SELL', verdictF: 'BUY' });
  });

  it('H (store declared shipped): the decisive BUY is served as HOLD; hold_counts yes, hold_decisions NO (ruling Q3)', async () => {
    vi.mocked(getAdapter).mockReturnValue(DECISIVE_BUY());
    _setRegistryOverrideForTest({ assignment: withCell(uniform('M'), '4h', 'TRENDING_UP', 'H'), hHoldStore: true });
    const r = await getTradeSignal({ coin: 'BTC', timeframe: '4h', license: LICENSE });
    expect(r.call).toBe('HOLD');
    expect(r.reasoning).toContain('Hold rule');
    expect((r._receipts as Record<string, unknown> | undefined)?.rule_variant).toBe('hold');
    expect(vi.mocked(perfDb.recordHoldCount)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordHoldDecision)).not.toHaveBeenCalled();
    expect(vi.mocked(perfDb.recordSignal)).not.toHaveBeenCalled();
    expect(vi.mocked(recordScorerInputCapture)).not.toHaveBeenCalled();
  });

  it('an ordinary HOLD still writes its hold_decisions row — the guard is H-only', async () => {
    vi.mocked(getAdapter).mockReturnValue(adapterFor(shaped(0, 1_000), 0));
    const r = await getTradeSignal({ coin: 'ETH', timeframe: '4h', license: LICENSE });
    expect(r.call).toBe('HOLD');
    expect(vi.mocked(recordHoldDecision)).toHaveBeenCalledTimes(1);
  });
});
