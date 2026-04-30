/**
 * Unit tests for SHADOW-SEED-W1 weekly digest formatter.
 *
 * Mocks the DB layer + telegram, asserts:
 *   - Digest formatter produces the expected message shape
 *   - PASS verdict requires PFE WR ≥85% AND samples ≥3000
 *   - FAIL verdict on low PFE WR
 *   - INSUFFICIENT_DATA on samples below threshold
 *   - Top/bottom performer lists exclude coins with <5 samples
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/performance-db.js', () => ({
  dbQuery: vi.fn(),
  closeDb: vi.fn(),
}));

vi.mock('../../src/lib/telegram.js', () => ({
  sendDigest: vi.fn().mockResolvedValue(true),
}));

import { buildDigest } from '../../src/scripts/shadow-digest-weekly.js';
import { dbQuery } from '../../src/lib/performance-db.js';

interface SignalRow {
  coin: string;
  signal: 'BUY' | 'SELL' | 'HOLD';
  pfe_return_pct: number | null;
}

function genWinning(coin: string, n: number, signal: 'BUY' | 'SELL'): SignalRow[] {
  return Array.from({ length: n }, () => ({
    coin,
    signal,
    pfe_return_pct: signal === 'BUY' ? 1.2 : -1.2,
  }));
}

function genLosing(coin: string, n: number, signal: 'BUY' | 'SELL'): SignalRow[] {
  return Array.from({ length: n }, () => ({
    coin,
    signal,
    pfe_return_pct: signal === 'BUY' ? -1.2 : 1.2,
  }));
}

describe('SHADOW-SEED-W1: weekly digest builder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders message with expected sections + verdict for both shadow timeframes', async () => {
    const fixture1m = [...genWinning('BTC', 90, 'BUY'), ...genLosing('BTC', 10, 'BUY')];
    const fixture3m = [...genWinning('ETH', 90, 'SELL'), ...genLosing('ETH', 10, 'SELL')];
    vi.mocked(dbQuery)
      .mockResolvedValueOnce(fixture1m as any)
      .mockResolvedValueOnce(fixture3m as any);

    const { text, sections, perTfVerdicts } = await buildDigest();
    expect(text).toMatch(/SHADOW-SEED WEEKLY DIGEST/);
    expect(text).toMatch(/1m/);
    expect(text).toMatch(/3m/);
    expect(text).toMatch(/Decision threshold/);
    expect(perTfVerdicts['1m']).toBeDefined();
    expect(perTfVerdicts['3m']).toBeDefined();
    expect(sections.length).toBeGreaterThan(5);
  });

  it('verdict=PASS when PFE WR ≥85% AND samples ≥3000', async () => {
    const winning = genWinning('BTC', 2700, 'BUY');
    const losing = genLosing('BTC', 300, 'BUY');
    const fixture = [...winning, ...losing]; // 90% WR over 3000 samples
    vi.mocked(dbQuery).mockResolvedValue(fixture as any);

    const { perTfVerdicts } = await buildDigest();
    expect(perTfVerdicts['1m']).toBe('PASS');
    expect(perTfVerdicts['3m']).toBe('PASS');
  });

  it('verdict=FAIL when PFE WR <85% (even with sufficient samples)', async () => {
    const winning = genWinning('BTC', 2400, 'BUY');
    const losing = genLosing('BTC', 600, 'BUY');
    const fixture = [...winning, ...losing]; // 80% WR — below 85% threshold
    vi.mocked(dbQuery).mockResolvedValue(fixture as any);

    const { perTfVerdicts } = await buildDigest();
    expect(perTfVerdicts['1m']).toBe('FAIL');
    expect(perTfVerdicts['3m']).toBe('FAIL');
  });

  it('verdict=INSUFFICIENT_DATA when samples <3000', async () => {
    const winning = genWinning('BTC', 100, 'BUY');
    vi.mocked(dbQuery).mockResolvedValue(winning as any);

    const { perTfVerdicts } = await buildDigest();
    expect(perTfVerdicts['1m']).toBe('INSUFFICIENT_DATA');
    expect(perTfVerdicts['3m']).toBe('INSUFFICIENT_DATA');
  });

  it('top performers exclude coins with <5 samples', async () => {
    const fixture = [
      ...genWinning('BTC', 100, 'BUY'),
      ...genWinning('ETH', 50, 'SELL'),
      ...genWinning('THINSAMPLE', 3, 'BUY'),
    ];
    vi.mocked(dbQuery).mockResolvedValue(fixture as any);

    const { text } = await buildDigest();
    expect(text).toMatch(/BTC/);
    expect(text).toMatch(/ETH/);
    expect(text).not.toMatch(/THINSAMPLE/);
  });

  it('handles empty signal table gracefully', async () => {
    vi.mocked(dbQuery).mockResolvedValue([]);
    const { perTfVerdicts, text } = await buildDigest();
    expect(perTfVerdicts['1m']).toBe('INSUFFICIENT_DATA');
    expect(perTfVerdicts['3m']).toBe('INSUFFICIENT_DATA');
    expect(text).toMatch(/0 samples/);
  });
});
