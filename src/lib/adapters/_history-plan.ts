/**
 * _history-plan.ts — OPS-ADAPTER-HISTORY-ANCHOR-W1 CH2. The ONE planner and the ONE page accounting for venue
 * candle history (pure; no I/O; no venue name; imports nothing at runtime).
 *
 * Why it exists: an adapter that derived its history page span from the REQUESTED timeframe while the venue
 * served a finer candle (Bitget 2h→1H, 8h→6H) asked for a page that could never reach `from` — a hole
 * generator in every consumer's candle input. The fix is a derivation rule, not a lane patch:
 *   - a page span is `pageCap × servedStepMs`, where servedStepMs is the adapter's OWN module-local
 *     `servedIntervalMs(tf)` (the leaf `src/lib/tf-support.ts` projects). NEVER import tf-support here or in an
 *     adapter: tf-support imports every adapter, so the require cycle hands the importing venue `undefined` and
 *     the projection silently falls back to the REQUESTED step (measured, OAH-Q3);
 *   - the page facts (front gap, holes, head gap, out-of-range, off-grid) are computed ONCE, here, and every
 *     consumer projects from them (single-derivation) instead of re-deriving gaps from bars.
 *
 * Page facts (OAH-Q4). Phase comes from the data (open_0 mod s): UTC+8 pairs (OKX 12H/1D, Bitget 6H/12H/1D,
 * HTX 1day) open off the epoch grid, so ceil(t/s)·s is wrong there.
 *   window        [from, to) when `to` is given, else [from, now] (the forming slot may be present, never required)
 *   frontGapBars  served slots between e_first (first slot ≥ from) and open_0
 *   gapSlots      holes inside [open_0, last in-window open]
 *   headGapBars   closed slots after the last in-window open up to e_last
 *   outOfRangeBars bars outside the window (reported, never dropped: OAH-Q5 keeps the returned bars unchanged)
 *
 * Carrier (OAH-Q2): a NON-enumerable `meta` property on the array the adapter returns — JSON bytes and deep
 * equality are unchanged, `src/types.ts` is untouched. A COPY of the page (`slice()`, spread, `map`) carries no
 * meta: read it from the page the adapter returned; `historyMetaOf(copy)` is `undefined` = unknown, never zero.
 */

export interface PageFacts {
  returned: number;
  inWindow: number;
  outOfRangeBars: number;
  offGridBars: number;
  expectedSlots: number;
  emptyWindow: boolean;
  frontGapBars: number | null;
  gapSlots: number;
  headGapBars: number | null;
}

export interface HistoryMeta extends PageFacts {
  /** The window was covered completely: no front gap, hole, head gap or off-grid bar (!incompleteWindow). */
  complete: boolean;
  servedStepMs: number;
  from: number;
  to: number | null;
  /** 'R' = the recent-endpoint page the routing guard accepted; 'F' = the history-endpoint fallback. */
  branch: 'R' | 'F';
  /** OAH-Q5: the history page held nothing at or after `from`, so the adapter returned the recent page instead.
   *  The bars are unchanged this wave; this flag is how a consumer can tell. */
  substitutedNewest: boolean;
}

const mod = (a: number, m: number) => ((a % m) + m) % m;

/** Account one returned page against its window, on the served grid. `declaredPhaseMs` only when the window
 *  holds no bar (then nothing in the data can say where the grid sits). */
export function accountPage(p: {
  bars: ReadonlyArray<{ ts: number }>;
  servedStepMs: number;
  from: number;
  to: number | null;
  nowMs: number;
  declaredPhaseMs?: number;
}): PageFacts {
  const s = p.servedStepMs;
  const inW = (t: number) => (p.to != null ? t >= p.from && t < p.to : t >= p.from && t <= p.nowMs);
  const times = [...new Set(p.bars.map((b) => b.ts))].sort((a, b) => a - b);
  const win = times.filter(inW);
  const outOfRangeBars = p.bars.length - p.bars.filter((b) => inW(b.ts)).length;
  const phase = win.length > 0 ? mod(win[0], s) : (p.declaredPhaseMs ?? 0);
  const offGridBars = win.filter((t) => mod(t - phase, s) !== 0).length;
  const eFirst = p.from + mod(phase - p.from, s);
  const eLast = p.to != null
    ? p.to - 1 - mod(p.to - 1 - phase, s)
    : p.nowMs - s - mod(p.nowMs - s - phase, s);
  const expectedSlots = eLast >= eFirst ? Math.floor((eLast - eFirst) / s) + 1 : 0;
  if (win.length === 0) {
    return { returned: p.bars.length, inWindow: 0, outOfRangeBars, offGridBars: 0, expectedSlots, emptyWindow: true, frontGapBars: null, gapSlots: 0, headGapBars: null };
  }
  const onGrid = win.filter((t) => mod(t - phase, s) === 0);
  const first = onGrid[0] ?? win[0];
  const last = onGrid[onGrid.length - 1] ?? win[win.length - 1];
  return {
    returned: p.bars.length,
    inWindow: win.length,
    outOfRangeBars,
    offGridBars,
    expectedSlots,
    emptyWindow: false,
    frontGapBars: Math.max(0, Math.round((first - eFirst) / s)),
    gapSlots: Math.max(0, Math.round((last - first) / s) + 1 - onGrid.length),
    headGapBars: Math.max(0, Math.round((eLast - last) / s)),
  };
}

/** A window the page did not cover completely. */
export function incompleteWindow(f: PageFacts): boolean {
  return f.emptyWindow ? f.expectedSlots > 0 : (f.frontGapBars ?? 0) > 0 || f.gapSlots > 0 || f.offGridBars > 0 || (f.headGapBars ?? 0) > 0;
}

/**
 * The history pages that cover [from, to) on the served grid, oldest first. Each page is anchored so that it
 * STARTS at or before `from` of its own span: its exclusive end is `start + pageCap × servedStepMs`. A venue
 * whose history endpoint is end-anchored (Bitget `endTime`, OKX `after`) is asked for that end.
 */
export function planHistoryPages(p: { servedStepMs: number; from: number; to: number; pageCap: number }): { start: number; end: number }[] {
  if (!(p.servedStepMs > 0) || !(p.pageCap > 0) || !(p.to > p.from)) return [];
  const span = p.pageCap * p.servedStepMs;
  const pages: { start: number; end: number }[] = [];
  for (let start = p.from; start < p.to; start += span) pages.push({ start, end: start + span });
  return pages;
}

/** The exclusive end of ONE history page anchored on `from`: the first page of planHistoryPages (one derivation). */
export function historyPageEnd(p: { servedStepMs: number; from: number; pageCap: number }): number {
  const first = planHistoryPages({ servedStepMs: p.servedStepMs, from: p.from, to: p.from + 1, pageCap: p.pageCap })[0];
  if (!first) throw new Error(`historyPageEnd: no page for servedStepMs=${p.servedStepMs} pageCap=${p.pageCap}`);
  return first.end;
}

/** Attach meta as a non-enumerable, read-only property. Returns the same array (identity preserved). */
export function attachMeta<T extends unknown[]>(page: T, meta: HistoryMeta): T & { readonly meta?: HistoryMeta } {
  Object.defineProperty(page, 'meta', { value: Object.freeze({ ...meta }), enumerable: false, writable: false, configurable: true });
  return page as T & { readonly meta?: HistoryMeta };
}

/** The meta of the page an adapter returned; `undefined` for a copy or an adapter that reports none. */
export function historyMetaOf(page: readonly unknown[] | null | undefined): HistoryMeta | undefined {
  if (!page) return undefined;
  const d = Object.getOwnPropertyDescriptor(page, 'meta');
  return d && !d.enumerable ? (d.value as HistoryMeta) : undefined;
}

/** The adapter-side helper: account the page it is about to return and attach the result. */
export function withHistoryMeta<T extends { time: number }[]>(
  page: T,
  p: { servedStepMs: number; from: number; to: number | undefined; nowMs: number; branch: 'R' | 'F'; substitutedNewest: boolean },
): T & { readonly meta?: HistoryMeta } {
  const facts = accountPage({ bars: page.map((c) => ({ ts: c.time })), servedStepMs: p.servedStepMs, from: p.from, to: p.to ?? null, nowMs: p.nowMs });
  return attachMeta(page, { ...facts, complete: !incompleteWindow(facts), servedStepMs: p.servedStepMs, from: p.from, to: p.to ?? null, branch: p.branch, substitutedNewest: p.substitutedNewest });
}
