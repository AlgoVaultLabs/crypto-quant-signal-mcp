/**
 * tests/unit/admission-verdict.test.ts — OPS-ALARM-OWNER-DERIVATION-W1 CH2 (AC1).
 *
 * A dead book (suppressed on ≥ 24 of 28 days) used to page with a two-branch paragraph telling a
 * human to go and read the venue's contract status. 9 of 9 Aster keys that ever entered the dead set
 * were venue-LIVE: the emit gate was suppressing thin books correctly and every new one paged anyway.
 * Now the canary asks the admission module itself — the ONE step that already reads each venue's own
 * status — and pages only the classes an operator can act on.
 *
 * Pinned here: the class precedence (first match wins), the EWT replay (a thin book whose venue
 * ticker is anchored at its LAST trade, days before the window — K3), and the CLI's contract.
 */
import { describe, expect, it } from 'vitest';
import { classifyDeadBook, type DeadBookInput } from '../../src/lib/universe-admission.js';
import { runAdmissionVerdict, parseDeadKeys, type AdmissionVerdictDeps } from '../../src/scripts/admission-verdict.js';

const H = 3_600_000;
const NOW = Date.parse('2026-10-10T13:05:00Z');
/** 24 hourly bars ending with the bar that opened at 12:00Z on 10-10. */
function bars(volumes: number[] = Array(24).fill(0)): Array<{ time: number; volume: number }> {
  const first = Date.parse('2026-10-09T13:00:00Z');
  return volumes.map((v, i) => ({ time: first + i * H, volume: v }));
}
const LIVE = { admit: true, reason: 'admitted' } as const;

function input(over: Partial<DeadBookInput> = {}): DeadBookInput {
  return {
    venue: 'ASTER', decision: LIVE, statusState: 'ok', circuitOpen: false, mode: 'enforce',
    universeRows: 574, fetchError: null, venueLastTradeMs: null, volume24hUsd: 3.2, bars: bars(),
    barMs: H, nowMs: NOW, ...over,
  };
}

describe('AC1 — classifyDeadBook: precedence, first match wins', () => {
  it('1. STATUS_UNKNOWN — an untrustworthy source never yields VENUE_OFF', () => {
    const off = { admit: false, reason: 'venue_disabled' } as const;
    const cases: Array<[string, Partial<DeadBookInput>]> = [
      ['the fetch threw', { fetchError: 'ECONNRESET', decision: off }],
      ['no fetcher / an empty payload', { universeRows: 0, decision: null }],
      ['status unavailable', { statusState: 'unavailable', decision: off }],
      ['the circuit is open', { circuitOpen: true, decision: off }],
      ['mode legacy', { mode: 'legacy', decision: off }],
      ['no status declared (kind none)', { venue: 'WEEX' }],
      ['a retired venue', { venue: 'BITMART' }],
      ['the status field was absent', { decision: { admit: true, reason: 'admission_field_absent' } }],
      ['no status record at all', { statusState: null }],
    ];
    for (const [why, over] of cases) {
      expect(classifyDeadBook(input(over)).cls, why).toBe('STATUS_UNKNOWN');
    }
  });

  it('venue_disabled under an OPEN CIRCUIT is STATUS_UNKNOWN, never VENUE_OFF', () => {
    const v = classifyDeadBook(input({ circuitOpen: true, decision: { admit: false, reason: 'venue_disabled' } }));
    expect(v.cls).toBe('STATUS_UNKNOWN');
    expect(v.reason).toMatch(/circuit/);
  });

  it('2. VENUE_OFF — the venue says off, or the coin is absent from a non-empty payload', () => {
    expect(classifyDeadBook(input({ decision: { admit: false, reason: 'venue_disabled' } })).cls).toBe('VENUE_OFF');
    const absent = classifyDeadBook(input({ decision: null }));
    expect(absent.cls).toBe('VENUE_OFF');
    expect(absent.reason).toMatch(/absent/);
  });

  it('HL’s OI filter is its declared status: OI 0 (venue_disabled) is VENUE_OFF, not unknown', () => {
    expect(classifyDeadBook(input({ venue: 'HL', statusState: 'not_applicable', decision: { admit: false, reason: 'venue_disabled' } })).cls)
      .toBe('VENUE_OFF');
  });

  it('THE EWT REPLAY: last trade 10-08T18:11Z, outside a 10-10 window, zero-volume bars ⇒ THIN_LIVE', () => {
    const v = classifyDeadBook(input({ venueLastTradeMs: Date.parse('2026-10-08T18:11:48Z'), volume24hUsd: 4.1 }));
    expect(v.cls).toBe('THIN_LIVE');
    expect(v.contradictionCheck).toBe('outside_window');
  });

  it('3. ADAPTER_CONTRADICTION — the venue traded inside the window and the adapter’s bars show nothing', () => {
    const v = classifyDeadBook(input({ venueLastTradeMs: Date.parse('2026-10-10T03:48:08Z') }));
    expect(v.cls).toBe('ADAPTER_CONTRADICTION');
    expect(v.contradictionCheck).toBe('contradiction');
  });

  it('…but a traded bar containing the trade, or one bar either side, is consistent ⇒ THIN_LIVE', () => {
    const at = Date.parse('2026-10-10T03:48:08Z'); // falls in the bar opening 03:00Z = index 14
    for (const k of [13, 14, 15]) {
      const vols = Array(24).fill(0); vols[k] = 2.5;
      const v = classifyDeadBook(input({ venueLastTradeMs: at, bars: bars(vols) }));
      expect(v.cls, `traded bar at index ${k}`).toBe('THIN_LIVE');
      expect(v.contradictionCheck).toBe('consistent');
    }
    const far = Array(24).fill(0); far[2] = 9; // traded, but not within ±1 bar of the venue's trade
    expect(classifyDeadBook(input({ venueLastTradeMs: at, bars: bars(far) })).cls).toBe('ADAPTER_CONTRADICTION');
  });

  it('keys on the ticker’s TIMESTAMP, never its volume (K3: Aster’s 24 h ticker is anchored at the last trade)', () => {
    // A big "24 h volume" with an OLD last trade is still thin and live, and a zero volume with an
    // in-window trade is still a contradiction: the volume field is evidence of nothing here.
    expect(classifyDeadBook(input({ volume24hUsd: 1e9, venueLastTradeMs: Date.parse('2026-10-05T05:20:00Z') })).cls).toBe('THIN_LIVE');
    expect(classifyDeadBook(input({ volume24hUsd: 0, venueLastTradeMs: Date.parse('2026-10-10T03:48:08Z') })).cls).toBe('ADAPTER_CONTRADICTION');
  });

  it('4. THIN_LIVE with contradiction_check=not_evaluable when the venue’s last trade is not observable', () => {
    const v = classifyDeadBook(input({ venueLastTradeMs: null }));
    expect(v.cls).toBe('THIN_LIVE');
    expect(v.contradictionCheck).toBe('not_evaluable');
  });

  it('an adapter that returned NO bars while the venue traded in the last 24 h is a contradiction', () => {
    expect(classifyDeadBook(input({ bars: [], venueLastTradeMs: NOW - 2 * H })).cls).toBe('ADAPTER_CONTRADICTION');
    expect(classifyDeadBook(input({ bars: [], venueLastTradeMs: NOW - 30 * H })).cls).toBe('THIN_LIVE');
  });

  it('an adapter that could not be asked is not evaluable — reported, not paged', () => {
    const v = classifyDeadBook(input({ bars: null, venueLastTradeMs: NOW - 2 * H }));
    expect(v.cls).toBe('THIN_LIVE');
    expect(v.contradictionCheck).toBe('not_evaluable');
  });
});

describe('AC1 — the CLI: one universe fetch per venue, one JSON line, one token', () => {
  function deps(over: Partial<AdmissionVerdictDeps> = {}): AdmissionVerdictDeps & { fetched: string[] } {
    const fetched: string[] = [];
    const rec = {
      venue: 'ASTER', side: 'sot', mode: 'enforce', kind: 'status_field', statusState: 'ok', circuitOpen: false, rows: 3,
      atMs: NOW, decisions: [
        { symbol: 'EWTUSDT', coin: 'EWT', volume24h_usd: 4.1, tickerTsMs: Date.parse('2026-10-08T18:11:48Z'), decision: LIVE },
        { symbol: 'KSTRUSDT', coin: 'KSTR', volume24h_usd: 2, tickerTsMs: Date.parse('2026-10-10T03:48:08Z'), decision: LIVE },
        { symbol: 'TONUSDT', coin: 'TON', volume24h_usd: 9, tickerTsMs: NOW, decision: { admit: false, reason: 'venue_disabled' } },
      ],
    };
    return {
      fetched,
      nowMs: () => NOW,
      fetchVenueUniverse: async (v: string) => { fetched.push(v); return v === 'ASTER' ? [{ coin: 'EWT' }, { coin: 'KSTR' }] : []; },
      lastAdmission: (v: string) => (v === 'ASTER' ? rec : undefined),
      hourlyBars: async (_v: string, coin: string) => (coin === 'KSTR' ? bars(Array(24).fill(0).map((_, i) => (i === 14 ? 1 : 0))) : bars()),
      ...over,
    } as AdmissionVerdictDeps & { fetched: string[] };
  }

  it('parses both key spellings and refuses a malformed one', () => {
    expect(parseDeadKeys('dead:ASTER|EWT ASTER|NVO')).toEqual([
      { key: 'dead:ASTER|EWT', venue: 'ASTER', coin: 'EWT' }, { key: 'dead:ASTER|NVO', venue: 'ASTER', coin: 'NVO' },
    ]);
    expect(parseDeadKeys('ASTER-EWT')).toBeNull();
    expect(parseDeadKeys('')).toBeNull();
  });

  it('classifies every key, fetching each venue ONCE', async () => {
    const d = deps();
    const r = await runAdmissionVerdict(['--keys', 'ASTER|EWT ASTER|KSTR ASTER|TON ASTER|GONE'], d);
    expect(r.exitCode).toBe(0);
    expect(d.fetched).toEqual(['ASTER']);
    expect(r.lines[r.lines.length - 1]).toBe('ADMISSION_VERDICT_EMIT=PASS');
    const out = JSON.parse(r.lines[r.lines.length - 2]);
    const cls = Object.fromEntries(out.keys.map((k: { key: string; class: string }) => [k.key, k.class]));
    expect(cls).toEqual({
      'dead:ASTER|EWT': 'THIN_LIVE', 'dead:ASTER|KSTR': 'THIN_LIVE', 'dead:ASTER|TON': 'VENUE_OFF', 'dead:ASTER|GONE': 'VENUE_OFF',
    });
    const ewt = out.keys.find((k: { key: string }) => k.key === 'dead:ASTER|EWT');
    expect(ewt).toMatchObject({ symbol: 'EWTUSDT', status_state: 'ok', venue_last_trade: '2026-10-08T18:11:48.000Z',
      traded_bars_24h: 0, contradiction_check: 'outside_window' });
  });

  it('a venue whose universe fetch THROWS makes its keys STATUS_UNKNOWN — and only its keys', async () => {
    const r = await runAdmissionVerdict(['--keys', 'XT|EPT ASTER|EWT'], deps({
      fetchVenueUniverse: async (v: string) => { if (v === 'XT') throw new Error('XT 503'); return [{ coin: 'EWT' }]; },
    }));
    const out = JSON.parse(r.lines[r.lines.length - 2]);
    expect(out.keys.map((k: { class: string }) => k.class)).toEqual(['STATUS_UNKNOWN', 'THIN_LIVE']);
    expect(r.exitCode).toBe(0);
  });

  it('a venue with no fetcher (empty universe, nothing recorded) is STATUS_UNKNOWN', async () => {
    const r = await runAdmissionVerdict(['--keys', 'BITMART|X'], deps());
    expect(JSON.parse(r.lines[r.lines.length - 2]).keys[0].class).toBe('STATUS_UNKNOWN');
  });

  it('a fetch that came back EMPTY is STATUS_UNKNOWN even beside a record — never a VENUE_OFF "absent"', async () => {
    const r = await runAdmissionVerdict(['--keys', 'ASTER|GONE'], deps({ fetchVenueUniverse: async () => [] }));
    expect(JSON.parse(r.lines[r.lines.length - 2]).keys[0].class).toBe('STATUS_UNKNOWN');
  });

  it('every key of a known venue gets its bars asked for, once each', async () => {
    const asked: string[] = [];
    await runAdmissionVerdict(['--keys', 'ASTER|EWT ASTER|TON'], deps({
      hourlyBars: async (_v: string, coin: string) => { asked.push(coin); return bars(); },
    }));
    expect(asked).toEqual(['EWT', 'TON']);
  });

  it('a STALE record (from before this run’s fetch) is never trusted', async () => {
    const r = await runAdmissionVerdict(['--keys', 'ASTER|EWT'], deps({
      lastAdmission: () => ({ venue: 'ASTER', side: 'sot', mode: 'enforce', kind: 'status_field', statusState: 'ok', circuitOpen: false,
        rows: 1, atMs: NOW - 10 * 60_000, decisions: [] }),
    }));
    expect(JSON.parse(r.lines[r.lines.length - 2]).keys[0].class).toBe('STATUS_UNKNOWN');
  });

  it('an adapter that throws for the bars leaves the key THIN_LIVE with contradiction_check=not_evaluable', async () => {
    const r = await runAdmissionVerdict(['--keys', 'ASTER|KSTR'], deps({ hourlyBars: async () => { throw new Error('kline 500'); } }));
    const k = JSON.parse(r.lines[r.lines.length - 2]).keys[0];
    expect(k.class).toBe('THIN_LIVE');
    expect(k.contradiction_check).toBe('not_evaluable');
  });

  it('a malformed or missing --keys is INDETERMINATE (exit 3) and prints no JSON', async () => {
    for (const argv of [['--keys', 'nonsense'], ['--keys'], []]) {
      const r = await runAdmissionVerdict(argv, deps());
      expect(r.exitCode, argv.join(' ')).toBe(3);
      expect(r.lines[r.lines.length - 1]).toBe('ADMISSION_VERDICT_EMIT=INDETERMINATE');
      expect(r.lines.some((l) => l.startsWith('{'))).toBe(false);
    }
  });
});
