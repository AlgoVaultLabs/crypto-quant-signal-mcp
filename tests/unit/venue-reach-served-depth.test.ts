/**
 * tests/unit/venue-reach-served-depth.test.ts — OPS-ALARM-OWNER-DERIVATION-W1 CH1 (Req 10 / AC4).
 *
 * Six adapters are COUNT-LIMITED: BINGX, HTX, PHEMEX, WEEX, WHITEBIT and XT fetch the newest N bars
 * with no start parameter and filter `>= startTime`. For a row older than N × the served step EVERY
 * returned bar passes that filter, and `computePFEMAE` (src/lib/pfe-mae.ts) takes the first bars it
 * is handed — so the row is FILLED from bars days after the signal. The outcome backfill's queue now
 * stops serving a row once it is past its venue's measured reach, which closes that only while the
 * table's reach is no deeper than what the adapter can actually serve.
 *
 * This test EXECUTES each adapter's `getCandles` through a mocked transport, reads the limit and the
 * interval the adapter really REQUESTS, and asserts `reach ≤ limit × served step` for every listed
 * timeframe. Lowering a kline limit, or switching a timeframe to a finer served interval, now fails
 * CI instead of silently reopening misfills.
 *
 * KNOWN EXCEEDANCES — measured 2026-10-10 (R0.2d), pinned SHRINK-ONLY, values untouched (a reach
 * value change is outside this wave): every `2h` row below is served as 1h bars, so its served depth
 * is 1,000 × 1 h = 41.67 d. HTX / PHEMEX / WHITEBIT / XT list 42 d (0.33 d too deep); WEEX lists
 * 83.33 d = 1,000 × 2 h (41.66 d too deep). None held a pending row in its exceedance band at
 * measurement. Remove an entry when the table is corrected; never add one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const captured: { url: string | null } = { url: null };
const answers: Record<string, unknown> = {
  'open-api.bingx.com': { code: 0, data: [] },
  'api.hbdm.com': { status: 'ok', data: [] },
  'api.phemex.com': { code: 0, data: { rows: [] } },
  'api-contract.weex.com': [],
  'whitebit.com': { success: true, result: [] },
  'fapi.xt.com': { returnCode: 0, result: [] },
};

vi.mock('../../src/lib/adapters/_upstream-fetch.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/adapters/_upstream-fetch.js')>()),
  upstreamFetch: vi.fn(async (_cfg: unknown, req: { url: string }) => {
    captured.url = req.url;
    const host = new URL(req.url).hostname;
    const hit = Object.entries(answers).find(([h]) => host === h || host.endsWith(`.${h}`) || host.endsWith(h));
    if (!hit) throw new Error(`no canned answer for ${host}`);
    return hit[1];
  }),
}));

import { getAdapter } from '../../src/lib/exchange-adapter.js';
import { servedCandleStepMs } from '../../src/lib/tf-support.js';
import { VENUE_CANDLE_REACH_DAYS } from '../../src/lib/venue-candle-reach.js';
import type { ExchangeId } from '../../src/types.js';

const COUNT_LIMITED: ExchangeId[] = ['BINGX', 'HTX', 'PHEMEX', 'WEEX', 'WHITEBIT', 'XT'];
/** The request parameter carrying each venue's bar count and bar interval. */
const PARAMS: Record<string, { count: string; interval: string }> = {
  BINGX: { count: 'limit', interval: 'interval' },
  HTX: { count: 'size', interval: 'period' },
  PHEMEX: { count: 'limit', interval: 'resolution' },
  WEEX: { count: 'limit', interval: 'interval' },
  WHITEBIT: { count: 'limit', interval: 'interval' },
  XT: { count: 'limit', interval: 'interval' },
};
const PINNED_EXCEEDANCES = ['HTX 2h', 'PHEMEX 2h', 'WEEX 2h', 'WHITEBIT 2h', 'XT 2h'];
const DAY_MS = 86_400_000;

/** '5m' · '5min' · '1h' · '60min' · '4hour' · '1d' · '1day' · '300' (seconds) → ms. */
function stepMsFromParam(v: string): number {
  const m = /^(\d+)(m|min|h|hour|d|day)?$/.exec(v);
  if (!m) throw new Error(`unparseable interval param ${JSON.stringify(v)}`);
  const n = Number(m[1]);
  switch (m[2]) {
    case 'm': case 'min': return n * 60_000;
    case 'h': case 'hour': return n * 3_600_000;
    case 'd': case 'day': return n * DAY_MS;
    default: return n * 1000; // a bare number is seconds (Phemex `resolution`)
  }
}

async function requestFor(venue: ExchangeId, tf: string): Promise<URL> {
  captured.url = null;
  await getAdapter(venue).getCandles('BTC', tf, Date.now() - 3_600_000);
  if (!captured.url) throw new Error(`${venue} ${tf}: getCandles made no request`);
  return new URL(captured.url);
}

afterEach(() => { captured.url = null; });

describe('Req 10 — count-limited adapters serve at least the table’s reach', () => {
  it.each(COUNT_LIMITED)('%s sends NO start parameter — it is genuinely count-limited', async (venue) => {
    const tf = Object.keys(VENUE_CANDLE_REACH_DAYS[venue])[0];
    const url = await requestFor(venue, tf);
    for (const p of ['startTime', 'start', 'from', 'since', 'start_time', 'begin']) {
      expect(url.searchParams.has(p), `${venue} now passes '${p}' — re-classify it before trusting this test`).toBe(false);
    }
  });

  it('every listed timeframe: the requested interval IS the shipped served step (one derivation)', async () => {
    for (const venue of COUNT_LIMITED) {
      for (const tf of Object.keys(VENUE_CANDLE_REACH_DAYS[venue])) {
        const url = await requestFor(venue, tf);
        expect(stepMsFromParam(url.searchParams.get(PARAMS[venue].interval) ?? ''), `${venue} ${tf}`)
          .toBe(servedCandleStepMs(venue, tf));
      }
    }
  });

  async function exceedances(): Promise<string[]> {
    const out: string[] = [];
    for (const venue of COUNT_LIMITED) {
      for (const [tf, reach] of Object.entries(VENUE_CANDLE_REACH_DAYS[venue])) {
        const url = await requestFor(venue, tf);
        const count = Number(url.searchParams.get(PARAMS[venue].count));
        const step = stepMsFromParam(url.searchParams.get(PARAMS[venue].interval) ?? '');
        expect(count, `${venue} ${tf} count param`).toBeGreaterThan(0);
        if ((reach as number) > (count * step) / DAY_MS + 1e-9) out.push(`${venue} ${tf}`);
      }
    }
    return out.sort();
  }

  it('reach ≤ requested count × served step for every listed pair, except the pinned five', async () => {
    const extra = (await exceedances()).filter((e) => !PINNED_EXCEEDANCES.includes(e));
    expect(extra, 'a table reach deeper than the adapter can serve reopens misfills').toEqual([]);
  });

  it('every pinned exceedance still exists — a corrected one must be REMOVED from the pin', async () => {
    const now = await exceedances();
    expect(PINNED_EXCEEDANCES.filter((e) => !now.includes(e))).toEqual([]);
    expect(PINNED_EXCEEDANCES).toHaveLength(5);
  });
});
