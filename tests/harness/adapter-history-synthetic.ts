/**
 * adapter-history-synthetic.ts — OPS-ADAPTER-HISTORY-ANCHOR-W1 CH2: the parametric Bitget / OKX venue.
 *
 * The captured replay (adapter-history-model.ts) can only answer the requests the shipped adapter made at
 * capture time; CH2 re-anchors the Bitget/OKX history request, so those two venues are answered by this
 * model instead. The model is NOT assumed: `tests/unit/adapter-history-synthetic-fidelity.test.ts` proves it
 * reproduces, open-time for open-time, every Bitget/OKX page in the fixtures (recent, deep, pre-listing,
 * deeper, served-step controls, off-grid boundary probes). Its semantics, each measured from two vantages
 * (vault endpoint-truth §3, fixtures MODEL-PROBES.json):
 *   Bitget /market/candles        newest ≤ limit bars with open in [slot(startTime), startTime + 90 d) and
 *                                 open ≤ now (the forming bar included); at most 90 d of bars; ascending
 *   Bitget /market/history-candles newest ≤ limit (≤ 200, else code 40053) CLOSED bars whose close ≤ endTime;
 *                                 ascending
 *   OKX /market/candles           newest ≤ limit bars with open > before (strict), forming included; DESC
 *   OKX /market/history-candles   newest ≤ limit bars with open < after (strict), forming included; DESC
 *   OKX '8H'                      code 51000 "Parameter bar error"
 *   every endpoint                bars only at or after the instrument's listing slot; grid phase per token
 *                                 (UTC+8 tokens: Bitget 6H/12H/1D, OKX 12H/1D)
 */

import { parseIntervalToken } from '../../src/lib/served-interval.js';

const DAY = 86_400_000;
const H = 3_600_000;

const PHASE: Record<string, Record<string, number>> = {
  BITGET: { '6H': 4 * H, '12H': 4 * H, '1D': 16 * H },
  OKX: { '12H': 4 * H, '1D': 16 * H },
};

export interface SyntheticInstrument { listingMs: number }

const mod = (a: number, m: number) => ((a % m) + m) % m;

/** The slot (open time) containing t on a grid of `step` with `phase`. */
const slotOf = (t: number, step: number, phase: number) => t - mod(t - phase, step);

function price(ts: number): string[] {
  const base = 100 + (Math.floor(ts / 60_000) % 997) / 10;
  const o = base.toFixed(1);
  return [o, (base + 1).toFixed(1), (base - 1).toFixed(1), (base + 0.5).toFixed(1)];
}

/** The newest `limit` bar opens t on the grid with lo ≤ t ≤ hi and t at or after the listing slot, ascending.
 *  Generated backwards from hi, so a far-past `lo` costs nothing. */
function newest(hi: number, lo: number, step: number, phase: number, listingMs: number, limit: number): number[] {
  const floor = Math.max(lo, slotOf(listingMs, step, phase));
  const out: number[] = [];
  for (let t = slotOf(hi, step, phase); t >= floor && out.length < limit; t -= step) out.push(t);
  return out.reverse();
}

export class SyntheticVenue {
  readonly venue: 'BITGET' | 'OKX';
  private readonly nowMs: () => number;
  private readonly instrument: (symbol: string) => SyntheticInstrument;

  constructor(venue: 'BITGET' | 'OKX', nowMs: () => number, instrument: (symbol: string) => SyntheticInstrument) {
    this.venue = venue;
    this.nowMs = nowMs;
    this.instrument = instrument;
  }

  /** The upstreamFetch stand-in: parse the adapter's own request, answer like the venue. */
  answer(url: string): unknown {
    const u = new URL(url);
    const q = u.searchParams;
    return this.venue === 'BITGET' ? this.bitget(u.pathname, q) : this.okx(u.pathname, q);
  }

  private bitget(path: string, q: URLSearchParams): unknown {
    const tok = q.get('granularity') ?? '';
    const step = parseIntervalToken(tok);
    if (step == null) return { code: '40034', msg: 'Parameter granularity error', data: null };
    const phase = PHASE.BITGET[tok] ?? 0;
    const { listingMs } = this.instrument(q.get('symbol') ?? '');
    const now = this.nowMs();
    const limit = Number(q.get('limit') ?? 100);
    const row = (t: number) => [String(t), ...price(t), '1', '1'];
    if (path.endsWith('/market/candles')) {
      const start = Number(q.get('startTime'));
      const hi = Math.min(now, start + 90 * DAY - 1);
      const cap = Math.min(limit, Math.floor((90 * DAY) / step));
      return { code: '00000', msg: 'success', data: newest(hi, slotOf(start, step, phase), step, phase, listingMs, cap).map(row) };
    }
    if (path.endsWith('/market/history-candles')) {
      if (limit > 200) throw new Error('Bitget API 400: Bad Request'); // venue answers HTTP 400 code 40053
      const end = Number(q.get('endTime'));
      const closedBy = Math.min(end, now); // a bar is served once CLOSED, and only if it closes by endTime
      return { code: '00000', msg: 'success', data: newest(closedBy - step, -Infinity, step, phase, listingMs, limit).map(row) };
    }
    throw new Error(`synthetic Bitget: unmodelled path ${path}`);
  }

  private okx(path: string, q: URLSearchParams): unknown {
    const tok = q.get('bar') ?? '';
    if (tok === '8H') return { code: '51000', msg: 'Parameter bar error', data: [] };
    const step = parseIntervalToken(tok);
    if (step == null) return { code: '51000', msg: 'Parameter bar error', data: [] };
    const phase = PHASE.OKX[tok] ?? 0;
    const { listingMs } = this.instrument(q.get('instId') ?? '');
    const now = this.nowMs();
    const limit = Number(q.get('limit') ?? 100);
    const row = (t: number) => [String(t), ...price(t), '1', '1', '1', '1'];
    const desc = (ts: number[]) => ts.reverse().map(row);
    if (path.endsWith('/market/candles')) {
      const before = Number(q.get('before'));
      return { code: '0', msg: '', data: desc(newest(now, before + 1, step, phase, listingMs, limit)) };
    }
    if (path.endsWith('/market/history-candles')) {
      const after = Number(q.get('after'));
      return { code: '0', msg: '', data: desc(newest(Math.min(after - 1, now), -Infinity, step, phase, listingMs, limit)) };
    }
    throw new Error(`synthetic OKX: unmodelled path ${path}`);
  }
}

/** The listing instants the fixtures need: the two young coins of the E scenarios (measured at capture, pinned
 *  in MODEL-PROBES.json); every other symbol is long listed. */
export function listingFromProbes(mp: { bitgetListingMs: number; okxListingMs: number }): (symbol: string) => SyntheticInstrument {
  return (symbol) => ({
    listingMs: /PONS/.test(symbol) ? mp.bitgetListingMs : /FLOCK/.test(symbol) ? mp.okxListingMs : Date.UTC(2019, 0, 1),
  });
}
