/**
 * P0 VERDICT-WITH-RECEIPTS-W1 — `formatReceipts()` + `renderReceiptText()` unit suite.
 *
 * Pins the single reusable receipt primitive that every signal-producing tool
 * emits (get_trade_call / get_trade_signal / scan_trade_calls today; future suite
 * tools tomorrow). The helper is PURE — it consumes the ALREADY-computed verdict
 * and an INJECTED (cached) track-record value, never re-derives the call, and
 * returns ONLY allow-listed fields (no `outcome_*` / P&L can reach the wire).
 *
 * Coverage maps 1:1 to the wave AC:
 *   - conviction rendered on BUY/SELL AND HOLD (Mr.1 2026-06-20: every call)
 *   - factors <=3, valid direction enum, derived from indicators
 *   - verification_uri === track-record URL (never a per-call /verify/<id>)
 *   - track-record OMITTED when the source is null (fail-open)
 *   - positive-assertion canary: serialized receipts never contain outcome_ fields / P&L
 *   - single-derivation property: human-line verdict === _receipts.verdict
 */
import { describe, it, expect } from 'vitest';
import {
  formatReceipts,
  formatScanReceipts,
  renderReceiptText,
  renderScanReceiptText,
  VERIFICATION_URI,
  RECEIPTS_DISCLAIMER,
  type VerdictContext,
  type ReceiptTrackRecord,
} from '../../src/lib/receipts.js';

const TRACK_RECORD: ReceiptTrackRecord = {
  pfe_win_rate: 0.916,
  n: 231222,
  window: '2026-04-10..2026-06-15',
  as_of: '2026-06-20T00:00:00.000Z',
};

/** Build a baseline BUY verdict context; override per-test. */
function verdict(over: Partial<VerdictContext> = {}): VerdictContext {
  return {
    call: 'BUY',
    confidence: 55,
    regime: 'TRENDING_UP',
    indicators: {
      funding_rate: 0.0001,
      funding_state: 'NORMAL',
      oi_change_pct: 1.2,
      trend_persistence: 'MEDIUM',
      breakout_pending: 'INACTIVE',
    },
    ...over,
  };
}

const DIRECTIONS = ['bullish', 'bearish', 'neutral'] as const;

describe('formatReceipts — structured allow-listed block', () => {
  it('projects verdict + regime + live conviction from the computed verdict (no re-derivation)', () => {
    const r = formatReceipts(verdict({ call: 'SELL', confidence: 73, regime: 'TRENDING_DOWN' }), {
      trackRecord: TRACK_RECORD,
    });
    expect(r.verdict).toBe('SELL');
    expect(r.regime).toBe('TRENDING_DOWN');
    expect(r.conviction_pct).toBe(73);
  });

  it('renders conviction on EVERY call including HOLD (Mr.1 2026-06-20)', () => {
    const buy = formatReceipts(verdict({ call: 'BUY', confidence: 55 }));
    const sell = formatReceipts(verdict({ call: 'SELL', confidence: 61 }));
    const hold = formatReceipts(verdict({ call: 'HOLD', confidence: 12 }));
    expect(buy.conviction_pct).toBe(55);
    expect(sell.conviction_pct).toBe(61);
    expect(hold.conviction_pct).toBe(12); // HOLD still carries conviction
  });

  it('emits 1–3 factors, each with a valid direction enum', () => {
    const r = formatReceipts(verdict());
    expect(r.factors.length).toBeGreaterThanOrEqual(1);
    expect(r.factors.length).toBeLessThanOrEqual(3);
    for (const f of r.factors) {
      expect(typeof f.factor).toBe('string');
      expect(typeof f.value).toBe('string');
      expect(DIRECTIONS).toContain(f.direction);
    }
  });

  it('always surfaces trend_persistence + funding_state as core factors', () => {
    const names = formatReceipts(verdict()).factors.map((f) => f.factor);
    expect(names).toContain('trend_persistence');
    expect(names).toContain('funding_state');
  });

  it('trend_persistence direction is neutral; value is the bucket', () => {
    const f = formatReceipts(verdict({ indicators: { ...verdict().indicators, trend_persistence: 'HIGH' } }))
      .factors.find((x) => x.factor === 'trend_persistence')!;
    expect(f.direction).toBe('neutral');
    expect(f.value).toBe('HIGH');
  });

  it('funding_state direction derives from funding_rate sign when crowd is one-sided', () => {
    const base = verdict().indicators;
    const bearish = formatReceipts(verdict({ indicators: { ...base, funding_state: 'ELEVATED', funding_rate: 0.0009 } }))
      .factors.find((f) => f.factor === 'funding_state')!;
    const bullish = formatReceipts(verdict({ indicators: { ...base, funding_state: 'EXTREME', funding_rate: -0.0009 } }))
      .factors.find((f) => f.factor === 'funding_state')!;
    expect(bearish.direction).toBe('bearish'); // crowded longs paying → contrarian bearish
    expect(bullish.direction).toBe('bullish'); // shorts paying → contrarian bullish
  });

  it('funding_state direction is neutral when funding pressure is NORMAL', () => {
    const f = formatReceipts(verdict({ indicators: { ...verdict().indicators, funding_state: 'NORMAL', funding_rate: 0.0009 } }))
      .factors.find((x) => x.factor === 'funding_state')!;
    expect(f.direction).toBe('neutral');
  });

  it('includes oi_change_pct (directional) as the 3rd factor on a salient move', () => {
    const base = verdict().indicators;
    const up = formatReceipts(verdict({ indicators: { ...base, oi_change_pct: 2.4, breakout_pending: 'INACTIVE' } }))
      .factors.find((f) => f.factor === 'oi_change_pct');
    expect(up).toBeDefined();
    expect(up!.direction).toBe('bullish');
    expect(up!.value).toBe('+2.4%');

    const down = formatReceipts(verdict({ indicators: { ...base, oi_change_pct: -1.1, breakout_pending: 'INACTIVE' } }))
      .factors.find((f) => f.factor === 'oi_change_pct');
    expect(down!.direction).toBe('bearish');
    expect(down!.value).toBe('-1.1%');
  });

  it('SCAN-RANKBY-W3: omits the oi_change_pct factor while the store is warming (field absent)', () => {
    const factors = formatReceipts(
      verdict({
        indicators: {
          funding_rate: 0.0001,
          funding_state: 'NORMAL',
          trend_persistence: 'MEDIUM',
          breakout_pending: 'INACTIVE',
          // oi_change_pct intentionally ABSENT (the store is warming → omitted, never a wrong value)
        },
      }),
    ).factors;
    expect(factors.find((f) => f.factor === 'oi_change_pct')).toBeUndefined();
    expect(factors.map((f) => f.factor)).toEqual(['trend_persistence', 'funding_state']);
  });

  it('prefers an IMMINENT breakout over OI for the 3rd factor slot', () => {
    const names = formatReceipts(verdict({ indicators: { ...verdict().indicators, breakout_pending: 'IMMINENT', oi_change_pct: 2.4 } }))
      .factors.map((f) => f.factor);
    expect(names).toContain('breakout_pending');
    expect(names).not.toContain('oi_change_pct');
    expect(names.length).toBe(3);
  });

  it('verification_uri is the aggregate track-record page, never a per-call /verify/<id>', () => {
    const r = formatReceipts(verdict(), { trackRecord: TRACK_RECORD });
    expect(r.verification_uri).toBe(VERIFICATION_URI);
    expect(VERIFICATION_URI).toBe('https://algovault.com/track-record');
    expect(r.verification_uri).not.toContain('/verify/');
  });

  it('carries the disclaimer in the structured block', () => {
    expect(formatReceipts(verdict()).disclaimer).toBe(RECEIPTS_DISCLAIMER);
    expect(RECEIPTS_DISCLAIMER.toLowerCase()).toContain('not investment advice');
  });

  it('passes the injected (cached) track-record through verbatim', () => {
    const r = formatReceipts(verdict(), { trackRecord: TRACK_RECORD });
    expect(r.track_record).toEqual(TRACK_RECORD);
  });

  it('OMITS track_record when the source is unavailable (fail-open, never stale-hardcoded)', () => {
    expect(formatReceipts(verdict(), { trackRecord: null }).track_record).toBeUndefined();
    expect('track_record' in formatReceipts(verdict(), { trackRecord: null })).toBe(false);
    expect(formatReceipts(verdict()).track_record).toBeUndefined(); // no ctx at all
  });
});

describe('formatReceipts — allow-list canary (Data Integrity LAW)', () => {
  it('serialized receipts NEVER contain outcome_return_pct / outcome_price / P&L — even when the verdict ctx is polluted', () => {
    // Allow-list (not deny-list) proof: smuggle internal P&L fields into the
    // verdict context; the formatter must structurally drop them.
    const polluted = {
      ...verdict(),
      outcome_return_pct: 12.34,
      outcome_price: 65432.1,
      pnl: 999,
    } as unknown as VerdictContext;
    const serialized = JSON.stringify(formatReceipts(polluted, { trackRecord: TRACK_RECORD }));
    expect(serialized).not.toContain('outcome_return_pct');
    expect(serialized).not.toContain('outcome_price');
    expect(serialized).not.toContain('outcome_');
    expect(serialized.toLowerCase()).not.toContain('pnl');
  });

  it('exposes ONLY the whitelisted top-level keys', () => {
    const keys = Object.keys(formatReceipts(verdict(), { trackRecord: TRACK_RECORD })).sort();
    expect(keys).toEqual(
      ['conviction_pct', 'disclaimer', 'factors', 'regime', 'track_record', 'verdict', 'verification_uri'].sort(),
    );
  });
});

describe('formatScanReceipts — envelope-shared proof block for scan_trade_calls', () => {
  it('carries the shared track_record + verification_uri + disclaimer', () => {
    const r = formatScanReceipts(TRACK_RECORD);
    expect(r.track_record).toEqual(TRACK_RECORD);
    expect(r.verification_uri).toBe(VERIFICATION_URI);
    expect(r.disclaimer).toBe(RECEIPTS_DISCLAIMER);
  });

  it('OMITS track_record when the source is unavailable (fail-open)', () => {
    const r = formatScanReceipts(null);
    expect('track_record' in r).toBe(false);
    expect(r.verification_uri).toBe(VERIFICATION_URI);
    expect(r.disclaimer).toBe(RECEIPTS_DISCLAIMER);
  });

  it('exposes ONLY the whitelisted keys and never leaks outcome_ fields / P&L', () => {
    const r = formatScanReceipts(TRACK_RECORD);
    expect(Object.keys(r).sort()).toEqual(['disclaimer', 'track_record', 'verification_uri'].sort());
    expect(JSON.stringify(r)).not.toContain('outcome_');
  });
});

describe('renderScanReceiptText — scan proof footer (same proof-line format as the per-call receipt)', () => {
  it('renders the shared proof line when track_record is present', () => {
    expect(renderScanReceiptText(formatScanReceipts(TRACK_RECORD))).toBe(
      'Proof: 91.6% PFE win rate · 231K calls · Merkle-anchored on Base · Verify → https://algovault.com/track-record',
    );
  });

  it('returns an empty string when track_record is omitted (fail-open)', () => {
    expect(renderScanReceiptText(formatScanReceipts(null))).toBe('');
  });
});

describe('renderReceiptText — human inline receipt (projects from the SAME formatReceipts output)', () => {
  const REASONING = 'Trending regime, upward bias. Funding pressure mild.';

  it('Line 1 is verdict · conviction — humanized regime', () => {
    const r = formatReceipts(verdict({ call: 'BUY', confidence: 55, regime: 'TRENDING_UP' }), { trackRecord: TRACK_RECORD });
    const line1 = renderReceiptText(r, REASONING).split('\n')[0];
    expect(line1).toBe('BUY · 55% conviction — Trending up');
  });

  it('humanizes each regime token for Line 1', () => {
    const mk = (regime: VerdictContext['regime']) =>
      renderReceiptText(formatReceipts(verdict({ regime })), REASONING).split('\n')[0];
    expect(mk('TRENDING_DOWN')).toContain('Trending down');
    expect(mk('RANGING')).toContain('Ranging');
    expect(mk('VOLATILE')).toContain('Volatile');
  });

  it('Line 2 reuses the existing reasoning verbatim, prefixed "Why: "', () => {
    const r = formatReceipts(verdict());
    const lines = renderReceiptText(r, REASONING).split('\n');
    expect(lines).toContain(`Why: ${REASONING}`);
  });

  it('Line 3 proof renders ONLY when track_record is present, with humanized numbers + verify link', () => {
    const withTr = renderReceiptText(formatReceipts(verdict(), { trackRecord: TRACK_RECORD }), REASONING);
    expect(withTr).toContain('Proof: 91.6% PFE win rate · 231K calls · Merkle-anchored on Base · Verify → https://algovault.com/track-record');

    const withoutTr = renderReceiptText(formatReceipts(verdict(), { trackRecord: null }), REASONING);
    expect(withoutTr).not.toContain('Proof:');
  });

  it('humanizes large call counts (K / M)', () => {
    const k = renderReceiptText(formatReceipts(verdict(), { trackRecord: { ...TRACK_RECORD, n: 231222 } }), REASONING);
    expect(k).toContain('231K calls');
    const m = renderReceiptText(formatReceipts(verdict(), { trackRecord: { ...TRACK_RECORD, n: 1_200_000 } }), REASONING);
    expect(m).toContain('1.2M calls');
  });

  it('NEVER prints a disclaimer line in the per-call human text (Mr.1: redundant per call)', () => {
    const text = renderReceiptText(formatReceipts(verdict(), { trackRecord: TRACK_RECORD }), REASONING);
    expect(text.toLowerCase()).not.toContain('not investment advice');
    expect(text).not.toContain('Past performance');
  });

  it('single-derivation: the human-line verdict === _receipts.verdict for every verdict', () => {
    for (const call of ['BUY', 'SELL', 'HOLD'] as const) {
      const r = formatReceipts(verdict({ call }), { trackRecord: TRACK_RECORD });
      const humanVerdict = renderReceiptText(r, REASONING).split('\n')[0].split(' · ')[0];
      expect(humanVerdict).toBe(r.verdict);
    }
  });

  it('human text also never leaks outcome_* / P&L', () => {
    const text = renderReceiptText(formatReceipts(verdict(), { trackRecord: TRACK_RECORD }), REASONING);
    expect(text).not.toContain('outcome_');
    expect(text.toLowerCase()).not.toContain('return_pct');
  });
});
