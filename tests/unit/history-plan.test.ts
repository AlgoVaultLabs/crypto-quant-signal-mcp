/**
 * history-plan.test.ts — OPS-ADAPTER-HISTORY-ANCHOR-W1 CH2: src/lib/adapters/_history-plan.ts, every branch.
 * The planner and the page accounting are the ONE derivation the adapters' meta, the contract suite and the
 * canary read, so each branch is pinned here: the served-step page span, the non-integer ratio pair (8h served
 * as 6H), a UTC+8 phase pair (Bitget 6H opens at 04/10/16/22Z), the recent (no `to`) and range windows, the empty
 * window, off-grid bars, and the meta carrier (non-enumerable; a copy carries none — unknown, never zero).
 */
import { describe, it, expect } from 'vitest';
import {
  accountPage, attachMeta, historyMetaOf, historyPageEnd, incompleteWindow, planHistoryPages, withHistoryMeta,
  type HistoryMeta,
} from '../../src/lib/adapters/_history-plan.js';

const H = 3_600_000;
const bars = (from: number, n: number, step: number) => Array.from({ length: n }, (_, i) => ({ ts: from + i * step }));

describe('planHistoryPages / historyPageEnd — the page span is pageCap × the SERVED step', () => {
  it('Bitget 2h served as 1H: one page of 200 served bars spans 200 h, not 400 h', () => {
    expect(historyPageEnd({ servedStepMs: H, from: 0, pageCap: 200 })).toBe(200 * H);
  });
  it('8h served as 6H (non-integer ratio): the span is 1200 h and pages tile [from, to) without gaps', () => {
    const pages = planHistoryPages({ servedStepMs: 6 * H, from: 0, to: 3000 * H, pageCap: 200 });
    expect(pages).toEqual([{ start: 0, end: 1200 * H }, { start: 1200 * H, end: 2400 * H }, { start: 2400 * H, end: 3600 * H }]);
    for (let i = 1; i < pages.length; i++) expect(pages[i].start).toBe(pages[i - 1].end);
  });
  it('degenerate inputs plan nothing', () => {
    expect(planHistoryPages({ servedStepMs: 0, from: 0, to: 10, pageCap: 200 })).toEqual([]);
    expect(planHistoryPages({ servedStepMs: H, from: 0, to: 10, pageCap: 0 })).toEqual([]);
    expect(planHistoryPages({ servedStepMs: H, from: 10, to: 10, pageCap: 200 })).toEqual([]);
  });
});

describe('accountPage — phase from the data, facts on the served grid (OAH-Q4)', () => {
  const s = 6 * H;
  const phase = 4 * H; // Bitget 6H opens at 04/10/16/22Z
  const from = 10 * s + 1_000; // off-grid
  const eFirst = 10 * s + phase; // the first 6H slot at or after `from` on the UTC+8 grid

  it('a complete range window: no gaps, nothing out of range', () => {
    const a = accountPage({ bars: bars(eFirst, 4, s), servedStepMs: s, from, to: from + 4 * s, nowMs: from + 100 * s });
    expect(a).toMatchObject({ inWindow: 4, expectedSlots: 4, frontGapBars: 0, gapSlots: 0, headGapBars: 0, outOfRangeBars: 0, offGridBars: 0, emptyWindow: false });
    expect(incompleteWindow(a)).toBe(false);
  });
  it('front gap, hole and head gap are each counted in served slots', () => {
    const b = [{ ts: eFirst + 2 * s }, { ts: eFirst + 4 * s }, { ts: eFirst + 5 * s }]; // slots 0,1 missing; slot 3 a hole; 6,7 missing
    const a = accountPage({ bars: b, servedStepMs: s, from, to: from + 8 * s, nowMs: from + 100 * s });
    expect(a).toMatchObject({ frontGapBars: 2, gapSlots: 1, headGapBars: 2, expectedSlots: 8 });
    expect(incompleteWindow(a)).toBe(true);
  });
  it('bars outside the window are reported, never dropped (OAH-Q5)', () => {
    const b = [{ ts: eFirst - s }, ...bars(eFirst, 2, s), { ts: eFirst + 10 * s }];
    const a = accountPage({ bars: b, servedStepMs: s, from, to: from + 2 * s, nowMs: from + 100 * s });
    expect(a).toMatchObject({ returned: 4, inWindow: 2, outOfRangeBars: 2 });
  });
  it('an off-grid bar breaks C1 step fidelity', () => {
    const a = accountPage({ bars: [{ ts: eFirst }, { ts: eFirst + s / 2 }, { ts: eFirst + s }], servedStepMs: s, from, to: from + 2 * s, nowMs: from + 100 * s });
    expect(a.offGridBars).toBe(1);
    expect(incompleteWindow(a)).toBe(true);
  });
  it('a window with no bar: empty, facts unknown (null), phase from the declaration', () => {
    const a = accountPage({ bars: [], servedStepMs: s, from, to: from + 3 * s, nowMs: from + 100 * s, declaredPhaseMs: phase });
    expect(a).toMatchObject({ emptyWindow: true, inWindow: 0, frontGapBars: null, headGapBars: null, expectedSlots: 3 });
    expect(incompleteWindow(a)).toBe(true);
    const none = accountPage({ bars: [], servedStepMs: s, from, to: from + 1, nowMs: from + 100 * s });
    expect(none.expectedSlots).toBe(0); // no slot opens in a 1 ms window off the grid
    expect(incompleteWindow(none)).toBe(false);
  });
  it('the recent window (no `to`) expects every CLOSED slot; the forming slot is allowed, never required', () => {
    const now = eFirst + 3 * s + 60_000; // slot eFirst+3s is forming
    const closed = accountPage({ bars: bars(eFirst, 3, s), servedStepMs: s, from, to: null, nowMs: now });
    expect(closed).toMatchObject({ expectedSlots: 3, headGapBars: 0, inWindow: 3 });
    const withForming = accountPage({ bars: bars(eFirst, 4, s), servedStepMs: s, from, to: null, nowMs: now });
    expect(withForming).toMatchObject({ headGapBars: 0, inWindow: 4, outOfRangeBars: 0 });
  });
  it('the non-integer ratio pair (8h served 6H) on a UTC+8 grid: the old 1600 h anchor leaves a 400 h front gap', () => {
    const old = accountPage({ bars: bars(eFirst + 400 * H / 1, 200, s).filter((b) => (b.ts - phase) % s === 0), servedStepMs: s, from, to: from + 8 * s, nowMs: from + 10_000 * H });
    expect(old.emptyWindow).toBe(true); // the page starts 400 h past a 48 h window
  });
});

describe('the meta carrier (OAH-Q2) — non-enumerable, and a copy is unknown, never zero', () => {
  const page = [{ time: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 }, { time: H, open: 1, high: 1, low: 1, close: 1, volume: 1 }];
  const withMeta = withHistoryMeta([...page], { servedStepMs: H, from: 0, to: 2 * H, nowMs: 10 * H, branch: 'F', substitutedNewest: false });

  it('the page the adapter returned carries its meta', () => {
    const m = historyMetaOf(withMeta) as HistoryMeta;
    expect(m).toMatchObject({ branch: 'F', substitutedNewest: false, servedStepMs: H, inWindow: 2, frontGapBars: 0, complete: true });
    const gappy = historyMetaOf(withHistoryMeta([page[1]], { servedStepMs: H, from: 0, to: 2 * H, nowMs: 10 * H, branch: 'F', substitutedNewest: false }));
    expect(gappy).toMatchObject({ frontGapBars: 1, complete: false });
  });
  it('JSON bytes and deep equality are unchanged by the meta', () => {
    expect(JSON.stringify(withMeta)).toBe(JSON.stringify(page));
    expect(withMeta).toEqual(page);
    expect(Object.keys(withMeta)).toEqual(['0', '1']);
  });
  it('a copy carries no meta: historyMetaOf(page.slice()) and historyMetaOf([...page]) are undefined', () => {
    expect(historyMetaOf(withMeta.slice())).toBeUndefined();
    expect(historyMetaOf([...withMeta])).toBeUndefined();
    expect(historyMetaOf(withMeta.map((c) => c))).toBeUndefined();
  });
  it('no page, or an enumerable `meta` someone else set, is not adapter meta', () => {
    expect(historyMetaOf(null)).toBeUndefined();
    expect(historyMetaOf(undefined)).toBeUndefined();
    const forged = Object.assign([1, 2], { meta: { substitutedNewest: true } });
    expect(historyMetaOf(forged)).toBeUndefined();
  });
  it('attachMeta is identity-preserving, read-only, and re-attachable by the adapter only through attachMeta', () => {
    const arr: number[] = [1];
    const out = attachMeta(arr, historyMetaOf(withMeta) as HistoryMeta);
    expect(out).toBe(arr);
    expect(() => { (out as unknown as { meta: unknown }).meta = 1; }).toThrow();
    attachMeta(arr, { ...(historyMetaOf(withMeta) as HistoryMeta), branch: 'R' });
    expect(historyMetaOf(arr)?.branch).toBe('R');
  });
});
