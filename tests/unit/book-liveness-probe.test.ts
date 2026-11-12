/**
 * tests/unit/book-liveness-probe.test.ts — OPS-BOOK-LIVENESS-W2 CH1 (AC1.1).
 *
 * The probe CLI is the canary's only window onto the app's adapters and the emit gate's own predicate.
 * Pinned here: a planted volume-parse defect on a live book reads FROZEN (the floor's old job), a short
 * read is UNREADABLE (never live), the retired venues are excluded by DERIVATION, the sentinel's book
 * choice, one retry, the three row verdicts with bars taken strictly before entry, and the CLI contract
 * (one JSON line then the token; bad args or a throw = INDETERMINATE with no JSON, exit 3).
 */
import { describe, expect, it } from 'vitest';
import { ADMISSION_SOURCES } from '../../src/lib/universe-admission.js';
import { BOOK_LIVENESS_MIN_GENUINE_BARS, BOOK_LIVENESS_WINDOW } from '../../src/lib/book-liveness.js';
import {
  activeVenues, parseProbeArgs, parseProbeRows, retiredVenues, runBookLivenessProbe, VERDICT_TOKEN,
  type ProbeDeps,
} from '../../src/scripts/book-liveness-probe.js';
import type { Candle, ExchangeId } from '../../src/types.js';

const H = 3_600_000;
const NOW = Date.parse('2026-11-12T16:40:00Z');
const FORMING = Date.parse('2026-11-12T16:00:00Z');

/** Hourly bars ending with the forming bar, oldest first; `volumes[i]` is bar i's volume as served. */
function hourly(volumes: unknown[], endOpen = FORMING): Candle[] {
  const first = endOpen - (volumes.length - 1) * H;
  return volumes.map((v, i) => ({ time: first + i * H, open: 1, high: 1, low: 1, close: 1, volume: v as number }));
}
const LIVE_25 = () => hourly(Array(25).fill(3.5));

type Overrides = Partial<{
  universe: (v: ExchangeId) => Promise<ReadonlyArray<{ coin: string; volume24h_usd: number }>>;
  serving: (v: ExchangeId, coin: string, tf: string, start: number) => Promise<ReadonlyArray<Candle>>;
  history: (v: ExchangeId, coin: string, tf: string, start: number, end: number) => Promise<ReadonlyArray<Candle>>;
}>;

/** Every venue lists BTC and serves 25 live hourly bars unless overridden. Calls are recorded. */
function deps(o: Overrides = {}) {
  const calls = { serving: [] as string[], history: [] as Array<[string, string, string, number, number]> };
  const d: ProbeDeps = {
    nowMs: () => NOW,
    fetchVenueUniverse: o.universe ?? (async () => [{ coin: 'BTC', volume24h_usd: 9e9 }, { coin: 'ETH', volume24h_usd: 5e9 }]),
    servingBars: async (v, coin, tf, start) => {
      calls.serving.push(`${v}|${coin}|${tf}`);
      return (o.serving ?? (async () => LIVE_25()))(v, coin, tf, start);
    },
    historyBars: async (v, coin, tf, start, end) => {
      calls.history.push([v, coin, tf, start, end]);
      return (o.history ?? (async () => []))(v, coin, tf, start, end);
    },
  };
  return { d, calls };
}

async function run(argv: string[], d: ProbeDeps) {
  const r = await runBookLivenessProbe(argv, d);
  const json = r.lines.filter((l) => l.startsWith('{'));
  return { ...r, doc: json.length === 1 ? JSON.parse(json[0]) : null, json };
}

describe('AC1.1 — sentinels: a planted volume-parse defect on a live book reads FROZEN', () => {
  const defects: Array<[string, unknown]> = [
    ['an unparseable string volume (thousands separator)', '1,234.5'],
    ['an empty-string volume', ''],
    ['a null volume', null],
    ['a zero volume', 0],
  ];
  for (const [label, bad] of defects) {
    it(`${label} on every bar of BINGX's BTC book → FROZEN; every other venue LIVE`, async () => {
      const { d } = deps({ serving: async (v) => (v === 'BINGX' ? hourly(Array(25).fill(bad)) : LIVE_25()) });
      const r = await run(['--sentinels'], d);
      expect(r.exitCode).toBe(0);
      expect(r.lines.at(-1)).toBe(`${VERDICT_TOKEN}=PASS`);
      const s = new Map((r.doc.sentinels as Array<{ venue: string; state: string; genuine_bars: number }>).map((x) => [x.venue, x]));
      expect(s.get('BINGX')).toMatchObject({ state: 'FROZEN', genuine_bars: 0, coin: 'BTC', book_source: 'universe_btc' });
      for (const [v, x] of s) if (v !== 'BINGX') expect(x.state, v).toBe('LIVE');
    });
  }

  it('a well-formed numeric-string volume is coerced by the gate\'s own Number() and reads LIVE, as the gate would', async () => {
    const { d } = deps({ serving: async (v) => (v === 'OKX' ? hourly(Array(25).fill('12.5')) : LIVE_25()) });
    const r = await run(['--sentinels'], d);
    expect(r.doc.sentinels.find((x: { venue: string }) => x.venue === 'OKX').state).toBe('LIVE');
  });

  it('a defect on half the bars is judged by k: 12 genuine of 24 is LIVE, 11 is FROZEN', async () => {
    const twelve = hourly([...Array(13).fill(0), ...Array(12).fill(2)]);   // last 24: 12 zero + 12 traded
    const eleven = hourly([...Array(14).fill(0), ...Array(11).fill(2)]);   // last 24: 13 zero + 11 traded
    const at = async (bars: Candle[]) => {
      const { d } = deps({ serving: async (v) => (v === 'XT' ? bars : LIVE_25()) });
      return (await run(['--sentinels'], d)).doc.sentinels.find((x: { venue: string }) => x.venue === 'XT');
    };
    expect(await at(twelve)).toMatchObject({ state: 'LIVE', genuine_bars: BOOK_LIVENESS_MIN_GENUINE_BARS, bars: BOOK_LIVENESS_WINDOW });
    expect(await at(eleven)).toMatchObject({ state: 'FROZEN', genuine_bars: BOOK_LIVENESS_MIN_GENUINE_BARS - 1 });
  });
});

describe('AC1.1 — sentinels: a short read is UNREADABLE, never live', () => {
  it(`fewer than ${BOOK_LIVENESS_WINDOW} bars → UNREADABLE with the count, although every bar traded`, async () => {
    const { d } = deps({ serving: async (v) => (v === 'HTX' ? hourly(Array(BOOK_LIVENESS_WINDOW - 1).fill(9)) : LIVE_25()) });
    const r = await run(['--sentinels'], d);
    const htx = r.doc.sentinels.find((x: { venue: string }) => x.venue === 'HTX');
    expect(htx).toMatchObject({ state: 'UNREADABLE', bars: BOOK_LIVENESS_WINDOW - 1, genuine_bars: null });
    expect(htx.reason).toMatch(/short read: 23 of 24 bars/);
  });

  it('bars stamped after now and duplicate open times do not pad a short read', async () => {
    const short = hourly(Array(20).fill(1));
    const padded = [...short, ...short.slice(0, 3), { ...short[0], time: NOW + H }];
    const { d } = deps({ serving: async (v) => (v === 'MEXC' ? padded : LIVE_25()) });
    const mexc = (await run(['--sentinels'], d)).doc.sentinels.find((x: { venue: string }) => x.venue === 'MEXC');
    expect(mexc).toMatchObject({ state: 'UNREADABLE', bars: 20 });
  });

  it('a read refused twice is UNREADABLE and names the refusal; refused once then served is judged', async () => {
    let kucoinCalls = 0;
    const { d, calls } = deps({
      serving: async (v) => {
        if (v === 'GATE') throw new Error('StaleUpstreamWindowError: head 3 bars stale');
        if (v === 'KUCOIN' && kucoinCalls++ === 0) throw new Error('ECONNRESET');
        return LIVE_25();
      },
    });
    const r = await run(['--sentinels'], d);
    const by = (v: string) => r.doc.sentinels.find((x: { venue: string }) => x.venue === v);
    expect(by('GATE')).toMatchObject({ state: 'UNREADABLE', bars: 0 });
    expect(by('GATE').reason).toMatch(/read refused after one retry: StaleUpstreamWindowError: head 3 bars stale/);
    expect(by('KUCOIN').state).toBe('LIVE');
    expect(calls.serving.filter((c) => c.startsWith('GATE|'))).toHaveLength(2);   // exactly one retry
  });
});

describe('AC1.1 — the venue set is derived: the retired venues are excluded', () => {
  it('every non-retired ExchangeId is read once, the retired ones never, and the output names them', async () => {
    const declaredActive = (Object.keys(ADMISSION_SOURCES) as ExchangeId[]).filter((v) => ADMISSION_SOURCES[v].kind !== 'retired');
    expect(retiredVenues()).toEqual(['BITMART', 'EDGEX']);
    expect(activeVenues()).toEqual([...declaredActive].sort());
    const { d, calls } = deps();
    const r = await run(['--sentinels'], d);
    const venues = r.doc.sentinels.map((x: { venue: string }) => x.venue);
    expect(venues).toEqual(activeVenues());
    expect(venues).not.toContain('BITMART');
    expect(venues).not.toContain('EDGEX');
    expect(calls.serving.some((c) => c.startsWith('BITMART|') || c.startsWith('EDGEX|'))).toBe(false);
    expect(r.doc.excluded_retired).toEqual(['BITMART', 'EDGEX']);
    expect(r.doc).toMatchObject({ mode: 'sentinels', timeframe: '1h', predicate: { window: 24, min_genuine_bars: 12 } });
  });

  it('reads the 1h serving window that starts one bar before the oldest of 24 ending with the forming bar', async () => {
    const starts: number[] = [];
    const { d } = deps({ serving: async (_v, _c, tf, start) => { expect(tf).toBe('1h'); starts.push(start); return LIVE_25(); } });
    await run(['--sentinels'], d);
    expect(new Set(starts)).toEqual(new Set([FORMING - 24 * H]));
  });
});

describe('the sentinel book', () => {
  it('BTC when listed; else the highest-volume admitted book; else BTC with the reason', async () => {
    const { d, calls } = deps({
      universe: async (v) => {
        if (v === 'GATE') return [{ coin: 'ETH', volume24h_usd: 1e6 }, { coin: 'SOL', volume24h_usd: 7e6 }, { coin: 'X', volume24h_usd: NaN }];
        if (v === 'WEEX') throw new Error('HTTP 503');
        if (v === 'PHEMEX') return [];
        return [{ coin: 'BTC', volume24h_usd: 1 }];
      },
    });
    const r = await run(['--sentinels'], d);
    const by = (v: string) => r.doc.sentinels.find((x: { venue: string }) => x.venue === v);
    expect(by('GATE')).toMatchObject({ coin: 'SOL', book_source: 'universe_top_volume' });
    expect(by('WEEX')).toMatchObject({ coin: 'BTC', book_source: 'fallback_btc', state: 'LIVE' });
    expect(by('WEEX').reason).toMatch(/universe unreadable \(HTTP 503\), so the book is BTC/);
    expect(by('PHEMEX')).toMatchObject({ coin: 'BTC', book_source: 'fallback_btc' });
    expect(by('PHEMEX').reason).toMatch(/returned no rows/);
    expect(by('BINANCE')).toMatchObject({ coin: 'BTC', book_source: 'universe_btc' });
    expect(calls.serving).toContain('GATE|SOL|1h');
  });
});

describe('AC1.1 — rows: the three verdicts, bars strictly before entry', () => {
  const ENTRY = Date.parse('2026-11-07T07:21:23Z');
  const entrySec = Math.floor(ENTRY / 1000);
  /** 2h bars; the last one opened before entry. `after` bars at/after entry are served too and must be ignored. */
  function twoHourly(volumes: number[], after: number[] = []): Candle[] {
    const lastOpen = Math.floor(ENTRY / (2 * H)) * 2 * H;
    const first = lastOpen - (volumes.length - 1) * 2 * H;
    return [...volumes, ...after].map((v, i) => ({ time: first + i * 2 * H, open: 1, high: 1, low: 1, close: 1, volume: v }));
  }
  const row = (id: number, coin = 'NZDUSD', venue = 'XT', tf = '2h', sec = entrySec) => `${venue}|${coin}|${tf}|${sec}|${id}`;

  it('GATE_MISS: 13 of the 24 bars before entry are zero; FROZE_AFTER: live before, dead after; UNVERIFIABLE: 5 bars', async () => {
    const { d } = deps({
      history: async (_v, coin) => {
        if (coin === 'MISS') return twoHourly([...Array(13).fill(0), ...Array(11).fill(4)]);
        if (coin === 'AFTER') return twoHourly([...Array(24).fill(4)], Array(6).fill(0));
        return twoHourly(Array(5).fill(4));
      },
    });
    const r = await run(['--rows', [row(1, 'MISS'), row(2, 'AFTER'), row(3, 'SHORT')].join(' ')], d);
    expect(r.exitCode).toBe(0);
    expect(r.lines.at(-1)).toBe(`${VERDICT_TOKEN}=PASS`);
    const [miss, after, short] = r.doc.rows;
    expect(miss).toMatchObject({ signal_id: 1, verdict: 'GATE_MISS', pre_bars: 24, genuine_bars: 11 });
    expect(after).toMatchObject({ signal_id: 2, verdict: 'FROZE_AFTER', pre_bars: 24, genuine_bars: 24 });
    expect(short).toMatchObject({ signal_id: 3, verdict: 'UNVERIFIABLE', pre_bars: 5, genuine_bars: null });
    expect(short.reason).toMatch(/5 bar\(s\) before entry, fewer than k=12/);
    expect(miss).toMatchObject({ venue: 'XT', coin: 'MISS', timeframe: '2h', entry: '2026-11-07T07:21:23.000Z' });
  });

  it('a pre-window of k..23 bars is judged, as frozen-window-attribution sets wouldSuppress', async () => {
    const { d } = deps({ history: async () => twoHourly(Array(BOOK_LIVENESS_MIN_GENUINE_BARS).fill(1)) });
    const r = await run(['--rows', row(9)], d);
    expect(r.doc.rows[0]).toMatchObject({ verdict: 'FROZE_AFTER', pre_bars: 12, genuine_bars: 12 });
  });

  it('zero bars AFTER entry never move a verdict — only bars strictly before it count', async () => {
    const { d } = deps({ history: async () => twoHourly([...Array(12).fill(0), ...Array(12).fill(3)], Array(30).fill(0)) });
    expect((await run(['--rows', row(4)], d)).doc.rows[0]).toMatchObject({ verdict: 'FROZE_AFTER', genuine_bars: 12 });
  });

  it('a read refused after one retry is UNVERIFIABLE with the refusal as its reason', async () => {
    let n = 0;
    const { d, calls } = deps({ history: async () => { n++; throw new Error('VenueMarketClosedError: BINGX status 25'); } });
    const r = await run(['--rows', row(5, 'NCSKTGT2USD', 'BINGX', '1h')], d);
    expect(r.doc.rows[0]).toMatchObject({ verdict: 'UNVERIFIABLE', pre_bars: 0 });
    expect(r.doc.rows[0].reason).toMatch(/read refused after one retry: VenueMarketClosedError: BINGX status 25/);
    expect(n).toBe(2);
    expect(calls.history).toHaveLength(2);
  });

  it('one history range per (venue, coin, timeframe) covers every row of the group; output keeps input order', async () => {
    const later = entrySec + 3 * 3600;
    const { d, calls } = deps({ history: async () => twoHourly(Array(30).fill(2), Array(3).fill(2)) });
    const r = await run(['--rows', [row(11, 'A', 'XT', '2h', later), row(10, 'A'), row(12, 'B', 'ASTER', '15m')].join(' ')], d);
    expect(r.doc.rows.map((x: { signal_id: number }) => x.signal_id)).toEqual([11, 10, 12]);
    const xtA = calls.history.filter(([v, c]) => v === 'XT' && c === 'A');
    expect(xtA[0][3]).toBe(ENTRY - (ENTRY % 1000) - 26 * 2 * H);     // the earliest entry minus (W+2) bars
    expect(xtA[0][4]).toBe(later * 1000);                             // through the latest entry
  });

  it('a page that makes no forward progress ends the range (the venue horizon) and the rows are still judged', async () => {
    const { d, calls } = deps({ history: async () => twoHourly(Array(24).fill(2)) });   // same page every call
    const r = await run(['--rows', row(20)], d);
    expect(r.doc.rows[0].verdict).toBe('FROZE_AFTER');
    expect(calls.history.length).toBeLessThanOrEqual(2);
  });
});

describe('the CLI contract', () => {
  it('prints exactly ONE JSON line, then the PASS token', async () => {
    const { d } = deps();
    const r = await run(['--sentinels'], d);
    expect(r.json).toHaveLength(1);
    expect(r.lines).toHaveLength(2);
    expect(r.lines[1]).toBe('BOOK_LIVENESS_PROBE_EMIT=PASS');
  });

  const bad: Array<[string, string[]]> = [
    ['no flag', []],
    ['both flags', ['--sentinels', '--rows', 'XT|A|2h|1762500083|1']],
    ['--rows with no value', ['--rows']],
    ['--rows empty', ['--rows', '  ']],
    ['a malformed row', ['--rows', 'XT|A|2h|1762500083']],
    ['an unknown venue', ['--rows', 'FTX|A|2h|1762500083|1']],
    ['an unknown timeframe', ['--rows', 'XT|A|7h|1762500083|1']],
    ['a quote in a coin', ['--rows', "XT|A'B|2h|1762500083|1"]],
    ['a signal id twice', ['--rows', 'XT|A|2h|1762500083|1 XT|B|2h|1762500083|1']],
    ['an extra argument', ['--sentinels', 'extra']],
  ];
  for (const [label, argv] of bad) {
    it(`bad args (${label}) → INDETERMINATE, exit 3, no JSON`, async () => {
      const { d, calls } = deps();
      const r = await run(argv, d);
      expect(r.exitCode).toBe(3);
      expect(r.json).toHaveLength(0);
      expect(r.lines.at(-1)).toBe('BOOK_LIVENESS_PROBE_EMIT=INDETERMINATE');
      expect(calls.serving).toHaveLength(0);
      expect(calls.history).toHaveLength(0);
    });
  }

  it('an unexpected throw → INDETERMINATE, exit 3, no JSON', async () => {
    const { d } = deps();
    const r = await run(['--sentinels'], { ...d, nowMs: () => { throw new Error('clock unavailable'); } });
    expect(r.exitCode).toBe(3);
    expect(r.json).toHaveLength(0);
    expect(r.lines).toEqual(['[book-liveness-probe] unexpected throw: clock unavailable', 'BOOK_LIVENESS_PROBE_EMIT=INDETERMINATE']);
  });

  it('the parsers are strict and pure', () => {
    expect(parseProbeArgs(['--sentinels'])).toEqual({ mode: 'sentinels' });
    expect(parseProbeRows('XT|USDTRY|2h|1762500083|1321248  ASTER|SYRUP|15m|1762360027|1311028')).toEqual([
      { venue: 'XT', coin: 'USDTRY', timeframe: '2h', entrySec: 1762500083, signalId: 1321248 },
      { venue: 'ASTER', coin: 'SYRUP', timeframe: '15m', entrySec: 1762360027, signalId: 1311028 },
    ]);
    expect(parseProbeRows('HL|xyz:TSLA|1h|1762500083|7')).toEqual([{ venue: 'HL', coin: 'xyz:TSLA', timeframe: '1h', entrySec: 1762500083, signalId: 7 }]);
  });
});
