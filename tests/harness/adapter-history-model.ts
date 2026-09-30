/**
 * adapter-history-model.ts — OPS-ADAPTER-HISTORY-ANCHOR-W1 CH1: the replay venue + the contract's accounting
 * oracle for the adapter history contract (tests/unit/adapter-history-contract.test.ts).
 *
 * The venue model is the captured one. Every scenario in tests/fixtures/adapter-history/<VENUE>.json was
 * captured THROUGH the shipped adapter (its own request URLs, the venue's own bodies, trimmed to the rows
 * the adapter can return), so replaying a scenario feeds the adapter exactly what the live venue answered.
 * A request the capture did not record is a REPLAY_MISS: the adapter changed what it asks for, so the
 * fixture no longer describes it and must be recaptured. Fail closed, never synthesise a body.
 *
 * The accounting in this file defines the contract's page facts. OAH-Q4 settles the definitions:
 *   - phase comes from the data: open_0 mod the served step. Never ceil(t/s)·s, because UTC+8 pairs have a
 *     non-zero phase.
 *   - frontGapBars counts served slots between e_first (the first slot at or after `from`) and open_0.
 *   - gapSlots counts holes inside [open_0, last in-window open].
 *   - headGapBars counts closed slots after the last in-window open, up to e_last.
 *   - outOfRangeBars counts bars outside the window: [from, to) when `to` is given, else [from, now].
 * CH2 moved the accounting into src/lib/adapters/_history-plan.ts (`accountPage`), and this file re-exports it
 * from there, so the contract, the adapters' own meta and the canary all read ONE derivation.
 *
 * Bitget and OKX are answered by the parametric venue in adapter-history-synthetic.ts. CH2 re-anchors their
 * history request, and the capture cannot answer a request it never saw. The model is proven page-for-page
 * against every captured Bitget/OKX page (adapter-history-synthetic-fidelity.test.ts).
 */

import { accountPage, incompleteWindow, type PageFacts } from '../../src/lib/adapters/_history-plan.js';

export { accountPage, type PageFacts };
export type PageAccount = PageFacts;

/** Venues answered by the synthetic model rather than by the capture (the ones CH2 edits). */
export const SYNTHETIC_VENUES: ReadonlySet<string> = new Set(['BITGET', 'OKX']);

export interface Bar { ts: number; open: number }

export interface CapturedRequest {
  url: string;
  method?: string;
  reqBody?: string | null;
  status: number;
  error?: string | null;
  /** The venue's parsed body, trimmed to the rows the adapter can return (see the fixture README). */
  json: unknown;
}

export type ScenarioTag = 'R' | 'D' | 'E' | 'D2';

export interface Scenario {
  tag: ScenarioTag;
  venue: string;
  tf: string;
  coin: string;
  from: number;
  to: number | null;
  calledAt: number;
  requestedMs: number;
  servedMs: number;
  W: number | null;
  error: string | null;
  output: Bar[];
  requests: CapturedRequest[];
  /** How long the capture took from the scenario's start to its last request: the only slack a clock-derived
   *  time parameter can carry on replay (+ 2 s). */
  replayToleranceMs: number;
}

export interface PairFixture { pair: string; faithful: boolean; R: Scenario; D: Scenario }

export interface VenueFixture { venue: string; pairs: PairFixture[]; extras?: Scenario[] }

// ── replay venue ──────────────────────────────────────────────────────────────────────────────────────

/** Query parameters (and JSON-body fields) that encode time. They are compared NUMERICALLY, never dropped: an
 *  anchor the adapter derives from `from`/`to` (Bitget's `endTime`, OKX's `after`) must match the capture
 *  exactly, or a re-anchored adapter would be served the old page and the contract would pass vacuously
 *  (measured: dropping them let a served-step Bitget anchor replay green). Only a value the adapter takes from
 *  the clock can differ, and never by more than the capture took (`Scenario.replayToleranceMs`). */
const TIME_PARAMS = new Set([
  'startTime', 'endTime', 'start', 'end', 'from', 'to', 'before', 'after', 'since', 'start_time', 'end_time',
  'startAt', 'endAt', 'time',
]);

export interface ParsedRequest { key: string; times: Record<string, number> }

export function parseRequest(url: string, reqBody?: string | null): ParsedRequest {
  const u = new URL(url);
  const times: Record<string, number> = {};
  const kept: [string, string][] = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (TIME_PARAMS.has(k)) times[`q.${k}`] = Number(v);
    else kept.push([k, v]);
  }
  kept.sort(([a], [b]) => a.localeCompare(b));
  let body = '';
  if (reqBody) {
    try {
      const j = JSON.parse(reqBody) as Record<string, unknown>;
      const flat: Record<string, unknown> = { ...j };
      if (j.req && typeof j.req === 'object') { delete flat.req; Object.assign(flat, j.req as Record<string, unknown>); }
      const rest: [string, unknown][] = [];
      for (const [k, v] of Object.entries(flat)) {
        if (TIME_PARAMS.has(k)) times[`b.${k}`] = Number(v);
        else rest.push([k, v]);
      }
      body = JSON.stringify(rest.sort(([a], [b]) => a.localeCompare(b)));
    } catch { body = reqBody; }
  }
  return { key: `${u.host}${u.pathname}?${kept.map(([k, v]) => `${k}=${v}`).join('&')}#${body}`, times };
}

/** A time value's tolerance in its own unit: a seconds-valued parameter (< 1e12) gets the tolerance in seconds. */
function timesMatch(want: Record<string, number>, got: Record<string, number>, toleranceMs: number): boolean {
  const keys = new Set([...Object.keys(want), ...Object.keys(got)]);
  for (const k of keys) {
    const a = want[k], b = got[k];
    if (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) {
      if (!(Number.isNaN(a) && Number.isNaN(b))) return false;
      continue;
    }
    const tol = Math.abs(a) < 1e12 ? Math.ceil(toleranceMs / 1000) : toleranceMs;
    if (Math.abs(a - b) > tol) return false;
  }
  return true;
}

export class ReplayMiss extends Error {
  constructor(msg: string) { super(`REPLAY_MISS: ${msg}`); this.name = 'ReplayMiss'; }
}

/** Serves one scenario's captured responses, in capture order, to the adapter's own requests. */
export class ReplayVenue {
  private queue: CapturedRequest[] = [];
  private label = '';
  private toleranceMs = 0;
  served = 0;

  load(s: Scenario): void {
    this.queue = [...s.requests];
    this.label = `${s.venue}/${s.tf}/${s.tag}`;
    this.toleranceMs = s.replayToleranceMs;
    this.served = 0;
  }

  /** The upstreamFetch stand-in: returns the parsed body, or throws what the transport threw. */
  answer(url: string, reqBody?: string | null): unknown {
    const next = this.queue.shift();
    if (!next) throw new ReplayMiss(`${this.label}: adapter made an unrecorded extra request ${url}`);
    const want = parseRequest(next.url, next.reqBody);
    const got = parseRequest(url, reqBody);
    if (want.key !== got.key) throw new ReplayMiss(`${this.label}: adapter asked ${got.key}, capture recorded ${want.key}`);
    if (!timesMatch(want.times, got.times, this.toleranceMs)) {
      throw new ReplayMiss(`${this.label}: adapter asked times ${JSON.stringify(got.times)}, capture recorded ${JSON.stringify(want.times)} (tolerance ${this.toleranceMs} ms)`);
    }
    this.served++;
    if (next.error) throw new Error(next.error);
    if (next.status < 200 || next.status >= 300) throw new Error(`replayed HTTP ${next.status}`);
    return next.json == null ? null : structuredClone(next.json);
  }

  /** Every recorded request must have been consumed: an adapter that now asks for LESS is also a change. */
  drained(): boolean { return this.queue.length === 0; }
}

// ── accounting oracle ────────────────────────────────────────────────────────────────────────────────

/** A window the page did not cover completely (the only shape C1 can take). */
export const incomplete = incompleteWindow;

/**
 * C3 (OAH-Q5): adapter-side substitution. The adapter made a range request (≥ 2 requests: the recent probe,
 * then the history fallback), the window held nothing, and it still returned bars. Every returned bar
 * then sits outside the window: it came from the recent page, not from the window.
 */
export function substitutedNewest(s: Scenario, a: PageAccount): boolean {
  return s.requests.length >= 2 && a.inWindow === 0 && a.returned > 0;
}

// ── the contract: classification of every captured pair (ONE derivation, shared by the suite and the
//    fixture tooling) ─────────────────────────────────────────────────────────────────────────────────

/** OAH-Q1: EDIT = C1 step fidelity (fix) + C3 adapter-side substitution (report via meta). Everything else is
 *  a REACH fact, measured and pinned in REACH.json, never edited by this wave. */
export interface BaselineEntry { venue: string; tf: string; clause: 'C1' | 'C3'; disposition: 'fix' | 'report'; scenarios: string[] }

export interface Control {
  tag: 'CONTROL';
  pair: string;
  scenario: ScenarioTag;
  from: number;
  to: number;
  servedMs: number;
  parser: 'bitget-rows';
  status: number;
  json: unknown;
}

export interface Unservable { pair: string; signature: 'venue-rejects-interval' | 'venue-returns-empty'; reason: string }

/** `synthetic`: the scenario ran against the synthetic venue, so the adapter may legitimately differ from the
 *  capture (CH2 re-anchors it); the differential test owns that comparison. */
export interface RunResult { out: Bar[]; err: string | null; drained: boolean; meta: unknown; synthetic?: boolean }

export type ReachFacts = Pick<PageAccount, 'returned' | 'inWindow' | 'outOfRangeBars' | 'offGridBars' | 'expectedSlots' | 'emptyWindow' | 'frontGapBars' | 'gapSlots' | 'headGapBars'>;

export interface Measurement {
  edit: BaselineEntry[];
  reach: Record<string, Record<string, ReachFacts>>;
  unservable: string[];
  unclassified: string[];
  replayFailures: string[];
}

const CONTROL_ROWS: Record<Control['parser'], (json: unknown) => number[]> = {
  'bitget-rows': (j) => ((j as { data?: string[][] }).data ?? []).map((r) => Number(r[0])),
};

/** Does the venue's own page (anchored on the SERVED step) hold every slot of the window? Then an incomplete
 *  adapter page is the adapter's doing (C1), not the venue's reach. */
export function controlCovers(c: Control): boolean {
  if (c.status !== 200) return false;
  const times = CONTROL_ROWS[c.parser](c.json).sort((a, b) => a - b);
  const a = accountPage({ bars: times.map((ts) => ({ ts, open: 0 })), servedStepMs: c.servedMs, from: c.from, to: c.to, nowMs: c.to });
  return !a.emptyWindow && !incomplete(a);
}

const facts = (a: PageAccount): ReachFacts => ({
  returned: a.returned, inWindow: a.inWindow, outOfRangeBars: a.outOfRangeBars, offGridBars: a.offGridBars,
  expectedSlots: a.expectedSlots, emptyWindow: a.emptyWindow, frontGapBars: a.frontGapBars, gapSlots: a.gapSlots, headGapBars: a.headGapBars,
});

/** A page the adapter returned that carries its own meta saying it substituted the newest page (CH2+). */
const reportsSubstitution = (meta: unknown) => !!meta && (meta as { substitutedNewest?: unknown }).substitutedNewest === true;

/**
 * Measure every fixture. `run` replays one scenario through the adapter and returns what it returned.
 * Deterministic: the result is a pure function of the fixtures and the adapter code.
 */
export async function measure(
  fixtures: readonly VenueFixture[],
  controls: readonly Control[],
  unservable: readonly Unservable[],
  run: (s: Scenario) => Promise<RunResult>,
): Promise<Measurement> {
  const edit = new Map<string, BaselineEntry>();
  const reach: Measurement['reach'] = {};
  const unservableSeen: string[] = [];
  const unclassified: string[] = [];
  const replayFailures: string[] = [];
  const listed = new Map(unservable.map((u) => [u.pair, u]));
  const addEdit = (s: Scenario, clause: BaselineEntry['clause'], disposition: BaselineEntry['disposition']) => {
    const k = `${s.venue}/${s.tf}/${clause}`;
    const e = edit.get(k) ?? { venue: s.venue, tf: s.tf, clause, disposition, scenarios: [] };
    if (!e.scenarios.includes(s.tag)) e.scenarios.push(s.tag);
    e.scenarios.sort();
    edit.set(k, e);
  };
  for (const vf of fixtures) {
    const scenarios: Scenario[] = [];
    for (const p of vf.pairs) scenarios.push(p.R, p.D);
    for (const s of vf.extras ?? []) scenarios.push(s);
    const results = new Map<Scenario, RunResult>();
    for (const s of scenarios) {
      const r = await run(s);
      results.set(s, r);
      const recorded = JSON.stringify(s.output);
      if (!r.drained || (!r.synthetic && JSON.stringify(r.out) !== recorded) || (r.err == null) !== (s.error == null)) {
        replayFailures.push(`${s.venue}/${s.tf}/${s.tag}${r.err ? ` (${r.err})` : ''}`);
      }
    }
    for (const p of vf.pairs) {
      const rR = results.get(p.R)!, rD = results.get(p.D)!;
      const dead = (r: RunResult) => r.err != null || r.out.length === 0;
      if (dead(rR) && dead(rD)) {
        unservableSeen.push(p.pair);
        continue;
      }
      if (listed.has(p.pair)) unclassified.push(`${p.pair}: listed UNSERVABLE but the venue served it`);
    }
    for (const s of scenarios) {
      const pair = `${s.venue}/${s.tf}`;
      if (listed.has(pair) || unservableSeen.includes(pair)) continue;
      const r = results.get(s)!;
      const a = accountPage({ bars: r.out, servedStepMs: s.servedMs, from: s.from, to: s.to, nowMs: s.calledAt });
      (reach[pair] ??= {})[s.tag] = facts(a);
      if (s.tag === 'E') {
        if (substitutedNewest(s, a) && !reportsSubstitution(r.meta)) addEdit(s, 'C3', 'report');
        continue;
      }
      if (s.tag === 'R') continue; // the recent page: C2/C4/front facts are REACH (OAH-Q1)
      if (!incomplete(a)) continue;
      const c = controls.find((x) => x.pair === pair && x.scenario === s.tag);
      if (!c) { unclassified.push(`${pair}/${s.tag}: incomplete window and no control capture`); continue; }
      if (controlCovers(c)) addEdit(s, 'C1', 'fix');
    }
  }
  for (const u of unservable) if (!unservableSeen.includes(u.pair)) unclassified.push(`${u.pair}: listed UNSERVABLE, not observed dead`);
  for (const pair of unservableSeen) if (!listed.has(pair)) unclassified.push(`${pair}: dead pair not listed in UNSERVABLE.json`);
  const sortE = [...edit.values()].sort((a, b) => `${a.venue}/${a.tf}/${a.clause}`.localeCompare(`${b.venue}/${b.tf}/${b.clause}`));
  return { edit: sortE, reach, unservable: unservableSeen.sort(), unclassified, replayFailures };
}
