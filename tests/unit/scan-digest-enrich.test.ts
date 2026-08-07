/**
 * SCAN-DIGEST-MCP-PARITY-W1 CH1 — enrichScanCall + renderScanDigestLine.
 *
 * The ONE projector the scan digest is computed once from; every channel (MCP
 * content[1], webhook scan_digest calls[], bot /scan + /scanwatch) projects from
 * it (single-derivation LAW). enrichScanCall is allow-listed (explicit copy — no
 * outcome_* / raw indicators can ride along); its `factors` are byte-identical to
 * the formatReceipts factors get_trade_call emits (single source of the factor
 * mapping). renderScanDigestLine is the per-call digest-line SoT MIRRORED by the
 * bot's Python rendering (CH3); the CH4 canary pins the two byte-identical.
 */
import { describe, it, expect } from 'vitest';
import {
  enrichScanCall,
  renderScanDigestLine,
  renderScanDigest,
  type ScanCallSource,
  type EnrichedScanCall,
} from '../../src/lib/scan-digest.js';
import { formatReceipts, type VerdictContext } from '../../src/lib/receipts.js';

/** Baseline non-HOLD detail (matches the spec example: CL BUY @ $71.49). */
function source(over: Partial<ScanCallSource> = {}): ScanCallSource {
  return {
    coin: 'CL',
    timeframe: '4h',
    call: 'BUY',
    confidence: 60,
    regime: 'TRENDING_UP',
    price: 71.49,
    reasoning: 'Trending regime, upward bias. Funding pressure mild.',
    indicators: {
      funding_rate: -0.0009,
      funding_state: 'ELEVATED',
      oi_change_pct: 10.0,
      oi_change_window: '24h',
      trend_persistence: 'HIGH',
      breakout_pending: 'INACTIVE',
    },
    ...over,
  };
}

describe('enrichScanCall — allow-listed enriched projection', () => {
  it('projects the enriched shape from the engine detail', () => {
    const e = enrichScanCall(source(), 'BINANCE');
    expect(e.coin).toBe('CL');
    expect(e.timeframe).toBe('4h');
    expect(e.exchange).toBe('BINANCE');
    expect(e.call).toBe('BUY');
    expect(e.confidence).toBe(60);
    expect(e.regime).toBe('TRENDING_UP');
    expect(e.price).toBe(71.49);
    expect(e.reasoning).toContain('Trending regime');
    expect(e.oi_change_window).toBe('24h');
    expect(Array.isArray(e.factors)).toBe(true);
  });

  it('factors === formatReceipts(detail).factors (single-derivation with get_trade_call)', () => {
    const src = source();
    const e = enrichScanCall(src, 'BINANCE');
    const expected = formatReceipts(src as unknown as VerdictContext).factors;
    expect(e.factors).toEqual(expected);
    // top 3 salient drivers, in buildFactors order
    expect(e.factors.map((f) => f.factor)).toEqual(['trend_persistence', 'funding_state', 'oi_change_pct']);
  });

  it('exposes ONLY allow-listed keys; never outcome_* / raw indicators (even when the source is polluted)', () => {
    const polluted = {
      ...source(),
      outcome_return_pct: 12.34,
      outcome_price: 65432.1,
      pnl: 999,
    } as unknown as ScanCallSource;
    const e = enrichScanCall(polluted, 'BINANCE');
    const json = JSON.stringify(e);
    expect(json).not.toContain('outcome_');
    expect(json).not.toMatch(/"indicators"\s*:/);
    expect(json.toLowerCase()).not.toContain('pnl');
    expect(Object.keys(e).sort()).toEqual(
      ['call', 'coin', 'confidence', 'exchange', 'factors', 'oi_change_window', 'price', 'reasoning', 'regime', 'timeframe'].sort(),
    );
  });

  it('omits oi_change_window when the engine omits it (oi_snapshots warming)', () => {
    const e = enrichScanCall(
      source({
        indicators: {
          funding_rate: 0.0001,
          funding_state: 'NORMAL',
          trend_persistence: 'MEDIUM',
          breakout_pending: 'INACTIVE',
        },
      }),
      'BINANCE',
    );
    expect('oi_change_window' in e).toBe(false);
    expect(e.factors.map((f) => f.factor)).toEqual(['trend_persistence', 'funding_state']);
  });

  it('graceful with missing detail (no indicators/price/reasoning) → empty factors, no throw', () => {
    const e = enrichScanCall({ coin: 'X', timeframe: '15m', call: 'SELL', confidence: 50, regime: 'RANGING' }, 'OKX');
    expect(e.factors).toEqual([]);
    expect(e.reasoning).toBe('');
    expect('oi_change_window' in e).toBe(false);
  });
});

describe('renderScanDigestLine — per-call digest block (bot-parity SoT)', () => {
  /**
   * OPS-RECEIPTS-FACTORS-DIRECTION-FIX-W1 R2 — RE-BASELINED. Class 1 (falsehood).
   * WAS: `… · OI +10.0% (24h) ↑`. The ↑ came from the sign of the OI delta, and open
   * interest feeds no weight term and no adjustment, so nothing derived it. The figure
   * `+10.0%` still carries the sign; only the causal glyph is gone.
   * UNCHANGED and load-bearing: `funding elevated ↑` — that arrow is Class 2, a deferred
   * NAMING COLLISION rather than a falsehood, so it must NOT move in this wave.
   */
  it('renders the spec-example BUY block: price · conviction · regime, 📊 drivers(+window), 💡 why', () => {
    const e = enrichScanCall(source(), 'BINANCE');
    expect(renderScanDigestLine(e)).toBe(
      '🟢 CL — BUY @ $71.49 · 60% conviction · TRENDING_UP\n' +
        '   📊 trend persistence HIGH · funding elevated ↑ · OI +10.0% (24h)\n' +
        '   💡 Trending regime, upward bias',
    );
  });

  it('SELL renders 🔴', () => {
    const e = enrichScanCall(source({ call: 'SELL', regime: 'TRENDING_DOWN', reasoning: 'Downtrend.' }), 'BINANCE');
    expect(renderScanDigestLine(e).split('\n')[0]).toBe('🔴 CL — SELL @ $71.49 · 60% conviction · TRENDING_DOWN');
  });

  it('formats price like the bot _fmt_price: ≥1000 no-dec w/ comma, ≥1 2-dec, <1 stripped', () => {
    const big = enrichScanCall(source({ price: 71000 }), 'BINANCE');
    expect(renderScanDigestLine(big).split('\n')[0]).toContain('@ $71,000');
    const small = enrichScanCall(source({ price: 0.0123 }), 'BINANCE');
    expect(renderScanDigestLine(small).split('\n')[0]).toContain('@ $0.0123');
    const mid = enrichScanCall(source({ price: 2 }), 'BINANCE');
    expect(renderScanDigestLine(mid).split('\n')[0]).toContain('@ $2.00');
  });

  it('omits 📊 when no factors and 💡 when no reasoning; omits price when absent', () => {
    const e = enrichScanCall({ coin: 'X', timeframe: '15m', call: 'BUY', confidence: 40, regime: 'RANGING' }, 'OKX');
    const line = renderScanDigestLine(e);
    expect(line).toBe('🟢 X — BUY · 40% conviction · RANGING');
    expect(line).not.toContain('📊');
    expect(line).not.toContain('💡');
    expect(line).not.toContain('@ $');
  });

  it('💡 uses the FIRST sentence of reasoning (parity with the bot _trim_reasoning)', () => {
    const e = enrichScanCall(source({ reasoning: 'Trending regime, upward bias. Funding pressure mild. Extra.' }), 'BINANCE');
    const why = renderScanDigestLine(e).split('\n').find((l) => l.includes('💡'))!;
    expect(why).toBe('   💡 Trending regime, upward bias');
  });

  /**
   * OPS-RECEIPTS-FACTORS-DIRECTION-FIX-W1 R2 — RE-BASELINED. Class 1 (falsehood).
   * WAS: `… · OI -3.2% (24h) ↓`. Same reason as above — a sign-of-delta arrow for an
   * input that moves no score. This case is the more instructive one: it proves the fix
   * is NOT "arrows always disappear", because `funding elevated ↓` survives beside it.
   */
  it('arrows: funding keeps its ↑/↓, a non-contributing factor gets none', () => {
    // ELEVATED + positive funding rate → bearish ↓ (Class 2, deferred — still derived
    // from the bucket). OI negative → NO arrow (Class 1, fixed): it feeds nothing.
    const e = enrichScanCall(
      source({
        indicators: {
          funding_rate: 0.0009,
          funding_state: 'ELEVATED',
          oi_change_pct: -3.2,
          oi_change_window: '24h',
          trend_persistence: 'LOW',
          breakout_pending: 'INACTIVE',
        },
      }),
      'BINANCE',
    );
    const drivers = renderScanDigestLine(e).split('\n').find((l) => l.includes('📊'))!;
    expect(drivers).toBe('   📊 trend persistence LOW · funding elevated ↓ · OI -3.2% (24h)');
  });

  it('the rendered line never leaks outcome_* / raw indicators', () => {
    const e = enrichScanCall(source(), 'BINANCE') as EnrichedScanCall;
    const line = renderScanDigestLine(e);
    expect(line).not.toContain('outcome_');
    expect(line.toLowerCase()).not.toContain('funding_rate');
  });
});

describe('renderScanDigest — MCP content[1] (header + lines, NO Proof footer)', () => {
  it('renders a header + one line per actionable call, no Proof footer', () => {
    const calls = [
      enrichScanCall(source({ coin: 'CL' }), 'BINANCE'),
      enrichScanCall(source({ coin: 'NG', call: 'SELL', regime: 'TRENDING_DOWN' }), 'BINANCE'),
    ];
    const text = renderScanDigest(calls, { topN: 20, timeframe: '4h', exchange: 'BINANCE' });
    expect(text.split('\n')[0]).toBe('🚀 Scan digest — top 20 perps on BINANCE @ 4h — 2 actionable:');
    expect(text).toContain('🟢 CL — BUY @ $71.49');
    expect(text).toContain('🔴 NG — SELL @ $71.49');
    expect(text).not.toContain('Proof:'); // the digest omits the receipts footer
  });

  it('shows the lens in the header for a non-oi rankBy', () => {
    const text = renderScanDigest([enrichScanCall(source(), 'OKX')], { topN: 30, timeframe: '1h', exchange: 'OKX', rankBy: 'funding_negative' });
    expect(text.split('\n')[0]).toBe('🚀 Scan digest — top 30 perps by funding_negative on OKX @ 1h — 1 actionable:');
  });

  it('returns "" when nothing is actionable (all-HOLD)', () => {
    const hold = enrichScanCall(source({ call: 'HOLD' }), 'BINANCE');
    expect(renderScanDigest([hold], { topN: 20, timeframe: '4h', exchange: 'BINANCE' })).toBe('');
  });
});
