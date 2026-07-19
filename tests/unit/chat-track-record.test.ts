/**
 * CHAT-LIVE-SOT-INJECTION-W1 — vitest canary for src/lib/chat-track-record.ts.
 *
 * Locks:
 *   - formatTrackRecordBlock math: fraction→%, comma grouping, trailing `+`,
 *     `[STATIC]` prefix when live:false.
 *   - getLiveTrackRecordBlock fails OPEN to the labelled static floor when the
 *     SoT read throws, and — the wave's spec correction — when the SoT returns
 *     a null win rate or a zero count, which would otherwise publish
 *     "0.0% PFE win rate" / "0 assets" as fact.
 *   - Never throws, never returns empty.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getSignalPerformanceMock = vi.fn();
const getAssetCountMock = vi.fn();

vi.mock('../../src/resources/signal-performance.js', () => ({
  getSignalPerformance: (...args: unknown[]) => getSignalPerformanceMock(...args),
}));

// vi.mock factories are hoisted above module-level consts, so the venue
// fixture has to be hoisted too or the factory sees a TDZ ReferenceError.
const MOCK_VENUES = vi.hoisted(() => [
  { id: 'HL', label: 'Hyperliquid' }, { id: 'BINANCE', label: 'Binance' },
  { id: 'BYBIT', label: 'Bybit' }, { id: 'OKX', label: 'OKX' },
  { id: 'BITGET', label: 'Bitget' }, { id: 'ASTER', label: 'Aster' },
  { id: 'BINGX', label: 'BingX' }, { id: 'GATE', label: 'Gate.io' },
  { id: 'HTX', label: 'HTX' }, { id: 'KUCOIN', label: 'KuCoin' },
  { id: 'MEXC', label: 'MEXC' }, { id: 'PHEMEX', label: 'Phemex' },
]);
vi.mock('../../src/lib/capabilities.js', () => ({
  EXCHANGE_COUNT: MOCK_VENUES.length,
  EXCHANGES: MOCK_VENUES,
  getAssetCount: (...args: unknown[]) => getAssetCountMock(...args),
}));

import {
  formatTrackRecordBlock,
  getLiveTrackRecordBlock,
  STATIC_FALLBACK,
  _resetTrackRecordBlockCache,
  _getTrackRecordBlockCacheState,
} from '../../src/lib/chat-track-record.js';

/** Shape mirrors the fields getLiveTrackRecordBlock actually reads. */
function statsFixture(totalCalls: number | null, pfeWinRate: number | null) {
  return {
    totalCalls,
    overall: { totalCalls, totalEvaluated: 380412, pfeWinRate },
  };
}

const STATIC_BLOCK = formatTrackRecordBlock({ ...STATIC_FALLBACK, live: false });

describe('formatTrackRecordBlock (pure)', () => {
  it('comma-groups integers, renders win rate to one decimal, suffixes counts with +', () => {
    const out = formatTrackRecordBlock({
      totalCalls: 382434,
      pfeWinRatePct: 91.53759608003954,
      exchangeCount: 12,
      assetCount: 1336,
      venueNames: ['Hyperliquid', 'Binance'],
      asOfISO: '2026-07-19T04:05:06.000Z',
      live: true,
    });
    expect(out).toContain('382,434+ signal calls');
    expect(out).toContain('91.5% PFE win rate');
    expect(out).toContain('12 exchanges');
    expect(out).toContain('1,336 assets');
    // asOfISO renders as a bare date, not a full timestamp
    expect(out).toContain('live as of 2026-07-19');
    expect(out).not.toContain('T04:05:06');
    expect(out).toContain('These figures are canonical.');
    expect(out.startsWith('CURRENT TRACK RECORD')).toBe(true);
  });

  it('prefixes [STATIC] and drops the "live" wording when live:false', () => {
    const out = formatTrackRecordBlock({ ...STATIC_FALLBACK, live: false });
    expect(out.startsWith('[STATIC] CURRENT TRACK RECORD')).toBe(true);
    expect(out).toContain('as of 2026-07-19');
    expect(out).not.toContain('live as of');
  });

  it('rounds the win rate half-up to one decimal', () => {
    const out = formatTrackRecordBlock({
      totalCalls: 1,
      pfeWinRatePct: 89.96,
      exchangeCount: 1,
      assetCount: 1,
      venueNames: ['Hyperliquid', 'Binance'],
      asOfISO: '2026-07-19',
      live: true,
    });
    expect(out).toContain('90.0% PFE win rate');
  });

  it('does not comma-group numbers below 1000', () => {
    const out = formatTrackRecordBlock({
      totalCalls: 999,
      pfeWinRatePct: 50,
      exchangeCount: 12,
      assetCount: 999,
      venueNames: ['Hyperliquid', 'Binance'],
      asOfISO: '2026-07-19',
      live: true,
    });
    expect(out).toContain('999+ signal calls');
    expect(out).toContain('999 assets');
  });

  it('STATIC_FALLBACK is a floor at or below the 2026-07-19 live SoT reading', () => {
    // Live on 2026-07-19: 382,434 calls / 91.5% WR / 12 exchanges / 1,336 assets.
    // A floor may not overstate — every count renders with a trailing `+`.
    expect(STATIC_FALLBACK.totalCalls).toBeLessThanOrEqual(382434);
    expect(STATIC_FALLBACK.assetCount).toBeLessThanOrEqual(1336);
    expect(STATIC_FALLBACK.exchangeCount).toBeLessThanOrEqual(12);
    expect(STATIC_FALLBACK.pfeWinRatePct).toBeLessThanOrEqual(91.5);
  });
});

describe('getLiveTrackRecordBlock (fail-open)', () => {
  beforeEach(() => {
    _resetTrackRecordBlockCache();
    getSignalPerformanceMock.mockReset();
    getAssetCountMock.mockReset();
  });
  afterEach(() => {
    _resetTrackRecordBlockCache();
  });

  it('renders live figures from the in-process SoT (fraction → percent)', async () => {
    getSignalPerformanceMock.mockResolvedValue(statsFixture(382434, 0.9153759608003954));
    getAssetCountMock.mockResolvedValue(1336);

    const out = await getLiveTrackRecordBlock();
    expect(out).toContain('382,434+ signal calls');
    expect(out).toContain('91.5% PFE win rate');
    expect(out).toContain('12 exchanges');
    expect(out).toContain('1,336 assets');
    expect(out).not.toContain('[STATIC]');
  });

  it('falls back to the labelled static floor when the SoT read throws', async () => {
    getSignalPerformanceMock.mockRejectedValue(new Error('db down'));
    getAssetCountMock.mockResolvedValue(1336);

    const out = await getLiveTrackRecordBlock();
    expect(out).toBe(STATIC_BLOCK);
    expect(out).toContain('[STATIC]');
  });

  // The spec correction: `overall.pfeWinRate` is `number | null`. `null * 100`
  // is 0, which would publish "0.0% PFE win rate" as an authoritative fact.
  it('falls back rather than publishing 0.0% when the win rate is null', async () => {
    getSignalPerformanceMock.mockResolvedValue(statsFixture(382434, null));
    getAssetCountMock.mockResolvedValue(1336);

    const out = await getLiveTrackRecordBlock();
    expect(out).not.toContain('0.0% PFE win rate');
    expect(out).toBe(STATIC_BLOCK);
  });

  // `getAssetCount()` swallows its own errors and returns 0.
  it('falls back rather than publishing "0 assets" when the asset count is 0', async () => {
    getSignalPerformanceMock.mockResolvedValue(statsFixture(382434, 0.915));
    getAssetCountMock.mockResolvedValue(0);

    const out = await getLiveTrackRecordBlock();
    expect(out).not.toContain('0 assets');
    expect(out).toBe(STATIC_BLOCK);
  });

  it('falls back when totalCalls is zero or missing', async () => {
    getSignalPerformanceMock.mockResolvedValue(statsFixture(0, 0.915));
    getAssetCountMock.mockResolvedValue(1336);
    expect(await getLiveTrackRecordBlock()).toBe(STATIC_BLOCK);

    _resetTrackRecordBlockCache();
    getSignalPerformanceMock.mockResolvedValue(undefined);
    getAssetCountMock.mockResolvedValue(1336);
    expect(await getLiveTrackRecordBlock()).toBe(STATIC_BLOCK);
  });

  it('falls back when the win rate is out of the (0,1] fraction range', async () => {
    // A percent leaking through where a fraction is expected (91.5 not 0.915)
    // must not render as "9150.0%".
    getSignalPerformanceMock.mockResolvedValue(statsFixture(382434, 91.5));
    getAssetCountMock.mockResolvedValue(1336);

    const out = await getLiveTrackRecordBlock();
    expect(out).not.toContain('9150');
    expect(out).toBe(STATIC_BLOCK);
  });

  it('never throws and never returns empty, whatever the SoT does', async () => {
    for (const boom of [
      () => getSignalPerformanceMock.mockRejectedValue(new Error('x')),
      () => getSignalPerformanceMock.mockResolvedValue(null),
      () => getSignalPerformanceMock.mockImplementation(() => { throw new Error('sync'); }),
    ]) {
      _resetTrackRecordBlockCache();
      getSignalPerformanceMock.mockReset();
      getAssetCountMock.mockResolvedValue(1336);
      boom();
      const out = await getLiveTrackRecordBlock();
      expect(typeof out).toBe('string');
      expect(out.length).toBeGreaterThan(0);
    }
  });

  it('caches the formatted block for the TTL — one SoT read across calls', async () => {
    getSignalPerformanceMock.mockResolvedValue(statsFixture(382434, 0.915));
    getAssetCountMock.mockResolvedValue(1336);

    expect(_getTrackRecordBlockCacheState().cached).toBe(false);
    const a = await getLiveTrackRecordBlock();
    const b = await getLiveTrackRecordBlock();
    expect(a).toBe(b);
    expect(getSignalPerformanceMock).toHaveBeenCalledTimes(1);
    const state = _getTrackRecordBlockCacheState();
    expect(state.cached).toBe(true);
    expect(state.ttlMs).toBe(5 * 60 * 1000);
  });

  it('re-reads the SoT once the TTL expires', async () => {
    vi.useFakeTimers();
    try {
      getSignalPerformanceMock.mockResolvedValue(statsFixture(382434, 0.915));
      getAssetCountMock.mockResolvedValue(1336);

      await getLiveTrackRecordBlock();
      expect(getSignalPerformanceMock).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      getSignalPerformanceMock.mockResolvedValue(statsFixture(400000, 0.92));
      const out = await getLiveTrackRecordBlock();

      expect(getSignalPerformanceMock).toHaveBeenCalledTimes(2);
      expect(out).toContain('400,000+ signal calls');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('venue naming (OPS-INTEGRATIONS-LIVE-SOT-W1)', () => {
  beforeEach(() => {
    _resetTrackRecordBlockCache();
    getSignalPerformanceMock.mockReset();
    getAssetCountMock.mockReset();
  });
  afterEach(() => _resetTrackRecordBlockCache());

  it('formatTrackRecordBlock lists the venue names', () => {
    const out = formatTrackRecordBlock({
      totalCalls: 383789, pfeWinRatePct: 91.5, exchangeCount: 3, assetCount: 1330,
      venueNames: ['Hyperliquid', 'Binance', 'KuCoin'], asOfISO: '2026-07-19', live: true,
    });
    expect(out).toContain('Signal venues: Hyperliquid, Binance, KuCoin.');
  });

  it('the live block names all 12 venues, and count === names.length', async () => {
    getSignalPerformanceMock.mockResolvedValue(statsFixture(383789, 0.915));
    getAssetCountMock.mockResolvedValue(1338);

    const out = await getLiveTrackRecordBlock();
    for (const v of MOCK_VENUES) expect(out).toContain(v.label);
    expect(out).toContain('12 exchanges');
    // Single derivation: the rendered count must equal the rendered list length.
    // NB: a venue label can itself contain a period ("Gate.io"), so the list
    // must be bounded by the trailing sentence, not by the first `.`.
    const listed = out
      .split('Signal venues: ')[1]
      .replace(/\. These figures are canonical\.$/, '')
      .split(', ');
    expect(listed).toHaveLength(MOCK_VENUES.length);
    expect(listed).toHaveLength(Number(out.match(/(\d+) exchanges/)![1]));
  });

  it('the STATIC fallback also names the venues (never an empty list)', () => {
    expect(STATIC_FALLBACK.venueNames.length).toBe(MOCK_VENUES.length);
    const out = formatTrackRecordBlock({ ...STATIC_FALLBACK, live: false });
    expect(out).toContain('Signal venues: Hyperliquid, Binance');
    expect(out).toContain('[STATIC]');
  });

  // Gemini/Kraken/Alpaca have integration pages but no adapter and appear in
  // no venue SoT — the chat must never present them as signal venues.
  it('does not name execution-kit-only venues as signal venues', async () => {
    getSignalPerformanceMock.mockResolvedValue(statsFixture(383789, 0.915));
    getAssetCountMock.mockResolvedValue(1338);
    const out = await getLiveTrackRecordBlock();
    for (const notAVenue of ['Gemini', 'Kraken', 'Alpaca']) {
      expect(out).not.toContain(notAVenue);
    }
  });
});
