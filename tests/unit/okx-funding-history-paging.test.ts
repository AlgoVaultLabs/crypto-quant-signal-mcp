import { describe, it, expect, vi, beforeEach } from 'vitest';

// OPS-BDIR-V3-PANEL-READINESS-W1 CH1 — OKX `getFundingHistory` must return EVERY retained record
// newer than `startTime`, not just the first page.
//
// The mock below encodes OKX's `/api/v5/public/funding-rate-history` semantics AS MEASURED against
// the live API on 2026-09-26 (BTC-USDT-SWAP), not as assumed:
//   * `before=C` → up to `limit` records with fundingTime STRICTLY greater than C, the ones CLOSEST
//     to C (i.e. the OLDEST records after the cursor), returned newest-first.
//     Measured: before=now−400d → 06-22T08Z..07-25T08Z (the oldest retained page);
//               before=07-25T08Z → 07-25T16Z..08-27T16Z;
//               before=now−2d    → the 6 newer records only.
//   * no cursor → the NEWEST `limit` records, newest-first.
// The pre-fix adapter sent one `before: startTime` request, so any window holding more than 100
// records came back as its oldest 100 — which is why OKX rows in funding_rates_hist trailed real
// time by ~60 days from the 2026-07-05 seed onward.

const H = 3_600_000;
const EIGHT_H = 8 * H;
const SYN_END = 1_790_400_000_000; // the newest retained print
const N = 290; // ~96 days of 8h prints — the retention measured on 2026-09-26
const SYN_START = SYN_END - (N - 1) * EIGHT_H;

type Mode = 'finite' | 'endless' | 'stuck';
let mode: Mode = 'finite';
let failOnCall = Number.POSITIVE_INFINITY; // 0-based call index that throws
const calls: string[] = [];

function recordsNewerThan(cursor: number, limit: number): number[] {
  const out: number[] = [];
  if (mode === 'endless') {
    // an unbounded future grid: there is ALWAYS another full page after any cursor
    const first = Math.floor(cursor / EIGHT_H) * EIGHT_H + EIGHT_H;
    for (let i = 0; i < limit; i++) out.push(first + i * EIGHT_H);
    return out;
  }
  for (let t = SYN_START; t <= SYN_END && out.length < limit; t += EIGHT_H) if (t > cursor) out.push(t);
  return out;
}

vi.mock('../../src/lib/adapters/_upstream-fetch.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/adapters/_upstream-fetch.js')>()),
  VENUE_FETCH_CONFIGS: { OKX: {} },
  upstreamFetch: vi.fn(async (_cfg: unknown, req: { url: string }) => {
    const idx = calls.length;
    calls.push(req.url);
    if (idx >= failOnCall) throw new Error('simulated transport failure');
    const u = new URL(req.url);
    const limit = Number(u.searchParams.get('limit') ?? 100);
    const before = u.searchParams.get('before');
    let times: number[];
    if (mode === 'stuck') {
      times = recordsNewerThan(SYN_START - 1, limit); // ignores the cursor: the same page forever
    } else if (before !== null) {
      times = recordsNewerThan(Number(before), limit);
    } else {
      const all = recordsNewerThan(-1, Number.MAX_SAFE_INTEGER);
      times = all.slice(-limit);
    }
    const data = [...times].reverse().map((t) => ({
      instId: 'BTC-USDT-SWAP', fundingRate: '0.0001', realizedRate: '0.0001', fundingTime: String(t),
    }));
    return { code: '0', msg: '', data };
  }),
}));

import {
  OKXAdapter,
  OKX_FUNDING_HISTORY_MAX_PAGES,
  _setOkxFundingPageDelayForTest,
} from '../../src/lib/adapters/okx.js';

beforeEach(() => {
  calls.length = 0;
  mode = 'finite';
  failOnCall = Number.POSITIVE_INFINITY;
  // optional call: against the PRE-fix module (no seam yet) the suite must fail on BEHAVIOUR —
  // 100 records instead of 290 — not on a missing export (the recorded red run depends on it)
  _setOkxFundingPageDelayForTest?.(0);
});

const isStrictlyAscending = (xs: number[]): boolean => xs.every((x, i) => i === 0 || x > xs[i - 1]);

describe('OKXAdapter.getFundingHistory — forward paging past the first 100 records', () => {
  it('returns every retained record newer than startTime when the window spans several pages', async () => {
    const out = await new OKXAdapter().getFundingHistory('BTC', SYN_START - 1);
    expect(out).toHaveLength(N);
    expect(out[0].time).toBe(SYN_START);
    expect(out[out.length - 1].time).toBe(SYN_END); // the NEWEST print — the one the old code never reached
    expect(isStrictlyAscending(out.map((p) => p.time))).toBe(true);
  });

  it('a checkpoint 2 intervals back returns the newest records in ONE request (steady state unchanged)', async () => {
    const out = await new OKXAdapter().getFundingHistory('BTC', SYN_END - 2 * EIGHT_H - 1);
    expect(out.map((p) => p.time)).toEqual([SYN_END - 2 * EIGHT_H, SYN_END - EIGHT_H, SYN_END]);
    expect(calls).toHaveLength(1);
  });

  it('the first request is byte-identical to the pre-fix request (instId, before=startTime, limit=100)', async () => {
    const startTime = SYN_END - 24 * H; // a scan_funding_arb-style 24h window: <= 100 records
    await new OKXAdapter().getFundingHistory('BTC', startTime);
    expect(calls).toHaveLength(1);
    const u = new URL(calls[0]);
    expect(`${u.origin}${u.pathname}`).toBe('https://www.okx.com/api/v5/public/funding-rate-history');
    expect([...u.searchParams.entries()]).toEqual([
      ['instId', 'BTC-USDT-SWAP'], ['before', String(startTime)], ['limit', '100'],
    ]);
  });

  it('stops at the page bound on an endless history and returns a contiguous run from startTime', async () => {
    mode = 'endless';
    const startTime = SYN_START - 1;
    const out = await new OKXAdapter().getFundingHistory('BTC', startTime);
    expect(calls).toHaveLength(OKX_FUNDING_HISTORY_MAX_PAGES);
    expect(out).toHaveLength(OKX_FUNDING_HISTORY_MAX_PAGES * 100);
    const ts = out.map((p) => p.time);
    expect(ts[0]).toBeGreaterThan(startTime);
    // contiguous: no hole a later checkpoint run (MAX(ts) − 2 intervals) could never refill
    expect(ts.every((t, i) => i === 0 || t - ts[i - 1] === EIGHT_H)).toBe(true);
  });

  it('a page that makes no forward progress ends the walk instead of looping', async () => {
    mode = 'stuck';
    const out = await new OKXAdapter().getFundingHistory('BTC', SYN_START - 1);
    expect(calls).toHaveLength(2);
    expect(out).toHaveLength(100);
    expect(new Set(out.map((p) => p.time)).size).toBe(out.length);
  });

  it('a failure on a later page returns the contiguous prefix already collected', async () => {
    failOnCall = 1;
    const out = await new OKXAdapter().getFundingHistory('BTC', SYN_START - 1);
    expect(out).toHaveLength(100);
    expect(out[0].time).toBe(SYN_START);
    expect(isStrictlyAscending(out.map((p) => p.time))).toBe(true);
  });

  it('a failure on the first page still returns [] (the adapter never throws)', async () => {
    failOnCall = 0;
    await expect(new OKXAdapter().getFundingHistory('BTC', SYN_START - 1)).resolves.toEqual([]);
  });

  it('the page bound covers OKX retention at the densest (1h) funding interval', () => {
    // 96 days retained (measured 2026-09-26) × 24 prints/day = 2,304 records = 24 full pages.
    expect(OKX_FUNDING_HISTORY_MAX_PAGES * 100).toBeGreaterThanOrEqual(96 * 24);
  });
});
