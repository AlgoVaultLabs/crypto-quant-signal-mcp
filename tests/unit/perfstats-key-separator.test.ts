// OPS-GREPPABLE-SOURCE-GUARD-W1 C1 (R2b) — the group-key separator is invariant.
//
// The separator was written as a RAW NUL byte in source, which made every tool that
// skips binary files (notably ugrep invoked with `-I`, which is how the agent shell
// resolves `grep`) silently skip all 2600+ lines of performance-db.ts and report its
// contents as ABSENT. That cost a 3-chapter false HALT on 2026-08-01.
//
// The fix rewrites the SOURCE BYTES only. This suite is the proof that the RUNTIME
// VALUE did not move — and that its value is load-bearing rather than arbitrary:
// a printable separator would silently merge two distinct tuples into one group.

import { describe, it, expect } from 'vitest';
import { STAT_GROUP_KEY_SEP, aggregateRowsInJs } from '../../src/lib/performance-db.js';
import type { SignalRecord } from '../../src/lib/performance-db.js';

/** Minimal SignalRecord factory — only the fields the grouping reads. */
function row(over: Partial<SignalRecord> = {}): SignalRecord {
  return {
    id: 1,
    coin: 'BTC',
    timeframe: '1h',
    signal: 'BUY',
    exchange: 'HL',
    created_at: 1_700_000_000,
    pfe_return_pct: null,
    ...over,
  } as SignalRecord;
}

describe('STAT_GROUP_KEY_SEP — runtime byte-identical to the pre-change raw NUL', () => {
  it('is exactly one byte, and that byte is 0x00', () => {
    expect(STAT_GROUP_KEY_SEP.length).toBe(1);
    expect(STAT_GROUP_KEY_SEP.charCodeAt(0)).toBe(0);
    expect(Buffer.from(STAT_GROUP_KEY_SEP).equals(Buffer.from([0]))).toBe(true);
    expect(Buffer.from(STAT_GROUP_KEY_SEP).length).toBe(1);
  });

  it('the escape sequence and a raw NUL are the SAME string at runtime', () => {
    // This is the whole claim of the change: only the source bytes moved.
    expect(STAT_GROUP_KEY_SEP).toBe(String.fromCharCode(0));
    // NB: written via fromCharCode, not a literal - authoring this very file
    // accidentally emitted a RAW NUL here on the first pass, which is exactly
    // the defect this wave exists to make impossible.
    expect(STAT_GROUP_KEY_SEP === String.fromCodePoint(0)).toBe(true);
  });

  it('GOLDEN: a key built with the pre-change raw separator deep-equals the new one', () => {
    const parts = ['HL', 'BTC', '1h', 'BUY'];
    // Pre-change encoder, reconstructed with an explicitly-constructed NUL.
    const preChange = parts.join(String.fromCharCode(0));
    const postChange = `${parts[0]}${STAT_GROUP_KEY_SEP}${parts[1]}${STAT_GROUP_KEY_SEP}${parts[2]}${STAT_GROUP_KEY_SEP}${parts[3]}`;
    expect(postChange).toBe(preChange);
    expect(Buffer.from(postChange).equals(Buffer.from(preChange))).toBe(true);
  });
});

describe('grouping round-trip — the separator survives adversarial field values', () => {
  it('distinct tuples stay distinct even when values contain | : - and whitespace', () => {
    const rows: SignalRecord[] = [
      row({ coin: 'BTC|ETH', timeframe: '1h', exchange: 'HL' }),
      row({ coin: 'BTC', timeframe: 'ETH|1h', exchange: 'HL' }),
      row({ coin: 'A:B', timeframe: '4h', exchange: 'HL' }),
      row({ coin: 'A', timeframe: 'B:4h', exchange: 'HL' }),
      row({ coin: 'X Y', timeframe: '1d', exchange: 'HL' }),
      row({ coin: 'X', timeframe: 'Y 1d', exchange: 'HL' }),
      row({ coin: 'P-Q', timeframe: '15m', exchange: 'HL' }),
      row({ coin: 'P', timeframe: 'Q-15m', exchange: 'HL' }),
    ];
    const { groups } = aggregateRowsInJs(rows);
    // 8 adversarial rows that a naive separator would collapse into 4.
    expect(groups).toHaveLength(8);
    for (const g of groups) expect(g.cnt).toBe(1);
  });

  it('every group round-trips back to the exact input tuple', () => {
    const rows: SignalRecord[] = [
      row({ coin: 'BTC', timeframe: '1h', signal: 'BUY', exchange: 'HL' }),
      row({ coin: 'BTC', timeframe: '1h', signal: 'SELL', exchange: 'HL' }),
      row({ coin: 'BTC', timeframe: '1h', signal: 'BUY', exchange: 'BINANCE' }),
      row({ coin: 'ETH', timeframe: '1h', signal: 'BUY', exchange: 'HL' }),
    ];
    const { groups } = aggregateRowsInJs(rows);
    expect(groups).toHaveLength(4);
    const seen = groups.map((g) => `${g.exchange}/${g.coin}/${g.timeframe}/${g.signal}`).sort();
    expect(seen).toEqual([
      'BINANCE/BTC/1h/BUY',
      'HL/BTC/1h/BUY',
      'HL/BTC/1h/SELL',
      'HL/ETH/1h/BUY',
    ]);
  });

  it('a null exchange still merges to HL (unchanged SQL-parity behaviour)', () => {
    const { groups } = aggregateRowsInJs([
      row({ exchange: null as unknown as string }),
      row({ exchange: 'HL' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].exchange).toBe('HL');
    expect(groups[0].cnt).toBe(2);
  });
});

describe('why NUL and not a printable character', () => {
  it('a printable separator WOULD merge two distinct tuples — the failure this prevents', () => {
    // Proves the constant is load-bearing, not cosmetic: with `|` these two distinct
    // (coin, timeframe) tuples both encode to "HL|BTC|ETH|1h|BUY" and collapse.
    const a = ['HL', 'BTC|ETH', '1h', 'BUY'];
    const b = ['HL', 'BTC', 'ETH|1h', 'BUY'];
    expect(a.join('|')).toBe(b.join('|'));            // collision under `|`
    expect(a.join(STAT_GROUP_KEY_SEP)).not.toBe(b.join(STAT_GROUP_KEY_SEP)); // safe under NUL
  });

  it('no realistic field value can contain the separator', () => {
    const realistic = ['HL', 'BINANCE', 'BTC', 'ETH', 'HYPE', '1h', '4h', '15m', '1d', 'BUY', 'SELL', 'HOLD'];
    for (const v of realistic) expect(v.includes(STAT_GROUP_KEY_SEP)).toBe(false);
  });
});
