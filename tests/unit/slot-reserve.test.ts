/**
 * tests/unit/slot-reserve.test.ts — OPS-HL-SCAN-SLOT-RESERVE-W1 CH1.
 *
 * The time-shaped reserve, the two-tier stand-down and the interactive wait, at production scale
 * (C 1150 · R 450 · Y 160 · Y_b 73 ⇒ slot batch cap 540, stand-down sub-cap 467, interactive room ≥ 610).
 * Pinned, each proven able to fail (mutation record in the vault evidence):
 *   - load-time validation refuses an unknown name, a paying caller and an out-of-range Y_b — and disables, never throws;
 *   - the env overrides (HL_WEIGHT_SLOT_RESERVE / HL_WEIGHT_SLOT_STANDDOWN_BAND) parse strictly;
 *   - the sub-cap refuses exactly the stand-down attempts that fail 467 and pass 540, and counts exactly those;
 *   - non-stand-down batch callers are refused only by 540; other interactive callers keep the full ceiling;
 *   - funding_episodes_backfill waits slot windows out, and every wait is recorded (window_caller.waits AND a
 *     rate_limit_events `wait` row, class interactive) — also when it then throws;
 *   - one slot_standdown line per stand-down batch name per slot window, zeros included; none at Y = 0;
 *   - fail-open: an error in the slot rule ⇒ today's decision + one slot_reserve_failopen line per window;
 *   - a slot refusal never produces a skip; batchHeadroom() reads the same slot-aware cap;
 *   - Y = 0 ⇒ byte-identical to BOTH goldens; Y = 160 over the synthetic production corpus holds every cap, and no
 *     interactive caller outside the stand-down list throws more than in the pre-wave golden.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const rle = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('../../src/lib/rate-limit-events.js', () => ({ recordRateLimitEvent: (...a: unknown[]) => { rle.calls.push(a); } }));

import {
  WeightBudget, WeightBudgetSkipError, runAsCaller, validateSlotReserve, isPayingToolCaller, type SlotReserveConfig,
} from '../../src/lib/upstream-weight-budget.js';
import { UpstreamRateLimitError } from '../../src/lib/errors.js';
import { HL_SLOT_RESERVE_DEFAULTS, HL_SLOT_RESERVE, hlSlotReserveFromEnv, slotWtFromEnv } from '../../src/lib/venue-budget-registry.js';
import { replay, replayEvents, buildProdCorpus, sha256Json, summarizeTrace, PROD_CONFIG } from '../fixtures/weight-budget-replay.js';

const C = 1150, R = 450;
const T_SLOT = Date.UTC(2026, 9, 3, 1, 0, 0);          // 01:00 — a slot window
const T_PLAIN = Date.UTC(2026, 9, 3, 1, 1, 0);         // 01:01 — not one
const BF3 = ['backfill_outcomes_server', 'backfill_outcomes_cron', 'signal_perf_backfill'];
const FEB = 'funding_episodes_backfill';
const SLOT: SlotReserveConfig = HL_SLOT_RESERVE_DEFAULTS;
const Y0: SlotReserveConfig = { ...HL_SLOT_RESERVE_DEFAULTS, extraReserveWt: 0 };

const dirs: string[] = [];
beforeEach(() => { rle.calls.length = 0; });
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function tmp(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-slot-')); dirs.push(d); return d; }

type Line = Record<string, unknown>;
type Clock = { t: number };
function mk(dir: string, clock: Clock, logs: string[], extra: Record<string, unknown> = {}) {
  return new WeightBudget({
    venue: 'Hyperliquid', ledgerPath: path.join(dir, 'algovault-hl-test-weight.json'), lockPath: path.join(dir, 'algovault-hl-test-weight.lock'),
    ceilingPerMin: C, interactiveReserve: R, windowMs: 60_000, maxBatchWaitMs: 300_000, staleLockMs: 60_000, lockRetryMs: 1,
    now: () => clock.t, sleep: async (ms: number) => { clock.t += ms; }, log: (l: string) => logs.push(l), slotReserve: SLOT, ...extra,
  });
}
const parse = (logs: string[], event: string): Line[] => logs.map((l) => JSON.parse(l) as Line).filter((x) => x.event === event);
async function settle(p: Promise<void>): Promise<string> {
  try { await p; return 'ok'; }
  catch (e) { return e instanceof UpstreamRateLimitError ? 'throw' : e instanceof WeightBudgetSkipError ? 'skip' : `error:${(e as Error).message}`; }
}
const as = (caller: string, b: WeightBudget, w: number, cls: 'batch' | 'interactive') => settle(runAsCaller(caller, () => b.acquire(w, cls)));
/** Roll every open window so its lines are emitted (the next acquire two minutes later). */
async function rollOut(b: WeightBudget, clock: Clock) { clock.t += 120_000; await as('roll_trigger', b, 1, 'batch'); }
const standdown = (logs: string[], ws: number) => parse(logs, 'slot_standdown').filter((l) => l.window_start === new Date(ws).toISOString());

describe('load-time validation (CH1 §4) — refuses, disables, never throws', () => {
  const v = (cfg: SlotReserveConfig | undefined, windowMs = 60_000) => validateSlotReserve(cfg, C, R, windowMs);
  it('the HL declaration is valid and active; absent or Y = 0 is inactive', () => {
    expect(v(SLOT)).toEqual({ ok: true, active: true });
    expect(v(undefined)).toEqual({ ok: true, active: false });
    expect(v(Y0)).toEqual({ ok: true, active: false });
  });
  it('an unknown stand-down name is refused (a typo would stand down nobody)', () => {
    const r = v({ ...SLOT, standDown: { batch: ['backfill_outcome_server'], interactive: [] } });
    expect(r.ok).toBe(false); expect((r as { reason: string }).reason).toMatch(/not a known caller literal/);
  });
  it('every paying-tool caller is refused, in either list, including any x402 tag', () => {
    for (const n of ['scan_trade_calls', 'get_market_regime', 'get_trade_call', 'scan_funding_arb', 'get_trade_signal', 'x402:get_trade_call', 'x402:scan_trade_calls@seed-signals']) {
      expect(isPayingToolCaller(n)).toBe(true);
      for (const lists of [{ batch: [n], interactive: [] }, { batch: [], interactive: [n] }]) {
        const r = v({ ...SLOT, standDown: lists });
        expect(r.ok, n).toBe(false); expect((r as { reason: string }).reason).toMatch(/paying-tool caller/);
      }
    }
    for (const n of [...BF3, FEB]) expect(isPayingToolCaller(n)).toBe(false);
  });
  it('Y_b must lie in [0, C − R − Y]; Y must fit C − R; minutes and windowMs must be well-formed', () => {
    expect(v({ ...SLOT, standDownBandWt: 540 })).toEqual({ ok: true, active: true });   // = C − R − Y (full stand-down boundary)
    expect(v({ ...SLOT, standDownBandWt: 0 })).toEqual({ ok: true, active: true });
    for (const yb of [541, -1, 73.5, Number.NaN]) expect(v({ ...SLOT, standDownBandWt: yb }).ok, String(yb)).toBe(false);
    for (const y of [701, -5, 1.5, Number.NaN]) expect(v({ ...SLOT, extraReserveWt: y }).ok, String(y)).toBe(false);
    for (const minutes of [[], [60], [0, 0], [-1], [1.5]]) expect(v({ ...SLOT, minutes }).ok, JSON.stringify(minutes)).toBe(false);
    expect(v({ ...SLOT, standDown: { batch: [FEB], interactive: [FEB] } }).ok).toBe(false);
    expect(v(SLOT, 7_000).ok).toBe(false); expect(v(SLOT, 10_000).ok).toBe(true);
  });
  it('a bad declaration disables the reserve with ONE loud line, and decisions are today\'s', async () => {
    const dir = tmp(); const clock = { t: T_SLOT }; const logs: string[] = [];
    const b = mk(dir, clock, logs, { slotReserve: { ...SLOT, standDownBandWt: 999 } });
    const dis = parse(logs, 'slot_reserve_disabled');
    expect(dis).toHaveLength(1); expect(dis[0]).toMatchObject({ venue: 'Hyperliquid' }); expect(String(dis[0].reason)).toMatch(/standDownBandWt 999/);
    expect(await as('get_market_regime', b, 600, 'interactive')).toBe('ok');
    expect(await as('backfill_outcomes_server', b, 100, 'batch')).toBe('ok');        // 700 ≤ 700: today's cap in a slot window
    await rollOut(b, clock);
    expect(parse(logs, 'slot_standdown')).toHaveLength(0);
  });
});

describe('HL env overrides (R1) — strict, default-deny', () => {
  it('unset → 160 / 73 with the declared closed lists; the module-level HL config equals it under a clean env', () => {
    const c = hlSlotReserveFromEnv({});
    expect([c.extraReserveWt, c.standDownBandWt, [...c.minutes]]).toEqual([160, 73, [0, 30]]);
    expect([...c.standDown.batch]).toEqual(BF3); expect([...c.standDown.interactive]).toEqual([FEB]);
    if (process.env.HL_WEIGHT_SLOT_RESERVE === undefined && process.env.HL_WEIGHT_SLOT_STANDDOWN_BAND === undefined) expect(HL_SLOT_RESERVE).toEqual(c);
  });
  it('HL_WEIGHT_SLOT_RESERVE=0 disables everything; overrides apply; a malformed value disables loudly', () => {
    expect(validateSlotReserve(hlSlotReserveFromEnv({ HL_WEIGHT_SLOT_RESERVE: '0' }), C, R, 60_000)).toEqual({ ok: true, active: false });
    const o = hlSlotReserveFromEnv({ HL_WEIGHT_SLOT_RESERVE: '200', HL_WEIGHT_SLOT_STANDDOWN_BAND: ' 50 ' });
    expect([o.extraReserveWt, o.standDownBandWt]).toEqual([200, 50]);
    expect(validateSlotReserve(o, C, R, 60_000)).toEqual({ ok: true, active: true });
    for (const env of [{ HL_WEIGHT_SLOT_RESERVE: 'abc' }, { HL_WEIGHT_SLOT_RESERVE: '-5' }, { HL_WEIGHT_SLOT_RESERVE: '1e2' }, { HL_WEIGHT_SLOT_STANDDOWN_BAND: '600' }]) {
      expect(validateSlotReserve(hlSlotReserveFromEnv(env), C, R, 60_000).ok, JSON.stringify(env)).toBe(false);
    }
    expect([slotWtFromEnv(undefined, 7), slotWtFromEnv('', 7), slotWtFromEnv('12', 7)]).toEqual([7, 7, 12]);
    expect(Number.isNaN(slotWtFromEnv('0x10', 7))).toBe(true);
  });
});

describe('slot admission (CH1 §3) — the two-tier rule on the same used + w operand', () => {
  it('the sub-cap refuses exactly the stand-down attempt that fails 467 and passes 540 — and counts exactly it', async () => {
    const dir = tmp(); const clock = { t: T_SLOT }; const logs: string[] = [];
    const b = mk(dir, clock, logs);
    expect(await as('get_market_regime', b, 446, 'interactive')).toBe('ok');      // used 446
    expect(await as('backfill_outcomes_server', b, 21, 'batch')).toBe('ok');      // 467 ≤ 467
    expect(b._readLedger().used).toBe(467);
    expect(await as('signal_perf_backfill', b, 1, 'batch')).toBe('ok');           // 468 > 467 ≤ 540 → waits, admitted at 01:01
    await rollOut(b, clock);
    expect(standdown(logs, T_SLOT).map((l) => [l.caller, l.refusals])).toEqual([['backfill_outcomes_server', 0], ['backfill_outcomes_cron', 0], ['signal_perf_backfill', 1]]);
    const w = parse(logs, 'window').find((l) => l.window_start === new Date(T_SLOT).toISOString())!;
    expect([w.used, w.batch_used, w.waits]).toEqual([467, 21, 1]);
  });
  it('the other batch callers fill the Y_b band and are refused only by 540 (never counted as sub-cap refusals)', async () => {
    const dir = tmp(); const clock = { t: T_SLOT }; const logs: string[] = [];
    const b = mk(dir, clock, logs);
    expect(await as('get_market_regime', b, 446, 'interactive')).toBe('ok');
    expect(await as('backfill_outcomes_server', b, 21, 'batch')).toBe('ok');      // 467
    expect(await as('seed:5m:hl', b, 73, 'batch')).toBe('ok');                    // 540 ≤ 540 — the band
    expect(b._readLedger().used).toBe(540);
    expect(await as('seed:15m:hl', b, 1, 'batch')).toBe('ok');                    // 541 > 540 → waits (not a sub-cap refusal)
    expect(clock.t).toBe(T_PLAIN);                                                   // it waited for the roll
    await rollOut(b, clock);
    expect(standdown(logs, T_SLOT).map((l) => l.refusals)).toEqual([0, 0, 0]);     // zeros are emitted, never omitted
    const w = parse(logs, 'window').find((l) => l.window_start === new Date(T_SLOT).toISOString())!;
    expect([w.used, w.batch_used, w.waits]).toEqual([540, 94, 1]);
  });
  it('a stand-down attempt refused by BOTH caps is not a sub-cap refusal', async () => {
    const dir = tmp(); const clock = { t: T_SLOT }; const logs: string[] = [];
    const b = mk(dir, clock, logs);
    expect(await as('get_market_regime', b, 540, 'interactive')).toBe('ok');
    expect(await as('backfill_outcomes_cron', b, 1, 'batch')).toBe('ok');         // 541 > 540: waits
    expect(clock.t).toBe(T_PLAIN);
    await rollOut(b, clock);
    expect(standdown(logs, T_SLOT).map((l) => l.refusals)).toEqual([0, 0, 0]);
  });
  it('outside slot windows the stand-down callers have today\'s cap (700)', async () => {
    const dir = tmp(); const clock = { t: T_PLAIN }; const logs: string[] = [];
    const b = mk(dir, clock, logs);
    expect(await as('get_market_regime', b, 600, 'interactive')).toBe('ok');
    expect(await as('backfill_outcomes_server', b, 100, 'batch')).toBe('ok');
    expect(b._readLedger()).toMatchObject({ windowStartMs: T_PLAIN, used: 700, waits: 0 });
    expect(b._readLedger().slotRefusals).toBeUndefined();
  });
  it('every other interactive caller keeps the full ceiling in a slot window (≥ 610 of room above the batch cap)', async () => {
    const dir = tmp(); const clock = { t: T_SLOT }; const logs: string[] = [];
    const b = mk(dir, clock, logs);
    expect(await as('seed:5m:hl', b, 540, 'batch')).toBe('ok');
    expect(await as('scan_trade_calls', b, 610, 'interactive')).toBe('ok');       // 1150 ≤ C
    expect(await as('scan_trade_calls', b, 1, 'interactive')).toBe('throw');      // today's ceiling
  });
});

describe('funding_episodes_backfill waits slot windows out (CH1 §3, SCOPE DELTA)', () => {
  it('waits, acquires in the next window, and the wait is recorded in window_caller.waits AND rate_limit_events', async () => {
    const dir = tmp(); const clock = { t: T_SLOT + 25_000 }; const logs: string[] = [];
    const b = mk(dir, clock, logs);
    expect(await as(FEB, b, 20, 'interactive')).toBe('ok');
    expect(clock.t).toBe(T_PLAIN);                                                   // it slept to the roll
    await rollOut(b, clock);
    const wc = parse(logs, 'window_caller').filter((l) => l.caller === FEB);
    expect(wc.find((l) => l.window_start === new Date(T_SLOT).toISOString())).toMatchObject({ class: 'interactive', weight: 0, grants: 0, waits: 1 });
    expect(wc.find((l) => l.window_start === new Date(T_PLAIN).toISOString())).toMatchObject({ class: 'interactive', weight: 20, grants: 1, waits: 0 });
    expect(parse(logs, 'window').find((l) => l.window_start === new Date(T_SLOT).toISOString())).toMatchObject({ waits: 1, interactive_used: 0 });
    expect(rle.calls).toEqual([['Hyperliquid', 'wait', null, 'interactive', 35_000, FEB]]);
    expect(parse(logs, 'batch_wait')).toHaveLength(0);                               // batch_wait stays batch-only
  });
  it('a FEB call that waited and then hits the ceiling leaves its wait row, then the throw row', async () => {
    const dir = tmp(); const logs: string[] = [];
    const clock = { t: T_SLOT + 30_000 };
    const filler = mk(dir, clock, logs);
    const b = mk(dir, clock, logs, {
      sleep: async (ms: number) => { clock.t += ms; await as('get_market_regime', filler, 1140, 'interactive'); },
    });
    expect(await as(FEB, b, 20, 'interactive')).toBe('throw');
    expect(rle.calls.map((c) => [c[1], c[3], c[5]])).toEqual([['wait', 'interactive', FEB], ['throw', 'interactive', FEB]]);
  });
  it('outside slot windows FEB is today\'s interactive caller (no wait, no rows)', async () => {
    const dir = tmp(); const clock = { t: Date.UTC(2026, 9, 3, 1, 7, 10) }; const logs: string[] = [];
    const b = mk(dir, clock, logs);
    expect(await as(FEB, b, 20, 'interactive')).toBe('ok');
    expect(b._readLedger()).toMatchObject({ interactiveUsed: 20, waits: 0 });
    expect(rle.calls).toEqual([]);
  });
});

describe('slot_standdown lines (CH1 §6)', () => {
  it('one flat line per stand-down batch name per slot window, declared order, exact keys, zeros included; none elsewhere', async () => {
    const dir = tmp(); const clock = { t: T_SLOT - 60_000 + 5_000 }; const logs: string[] = [];
    const b = mk(dir, clock, logs);
    for (const t of [T_SLOT - 55_000, T_SLOT + 5_000, T_PLAIN + 5_000]) { clock.t = t; await as('seed:5m:hl', b, 10, 'batch'); }
    await rollOut(b, clock);
    const sd = parse(logs, 'slot_standdown');
    expect(sd).toHaveLength(3);
    expect(sd.map((l) => l.window_start)).toEqual(Array(3).fill(new Date(T_SLOT).toISOString()));
    expect(sd.map((l) => l.caller)).toEqual(BF3);
    expect(Object.keys(sd[0])).toEqual(['tag', 'event', 'venue', 'window_start', 'caller', 'refusals']);
    expect(sd.every((l) => l.refusals === 0 && l.tag === 'upstream-weight-budget' && l.venue === 'Hyperliquid')).toBe(true);
  });
  it('Y = 0: no slot_standdown line, no ledger slot record, and the 700 cap in slot windows', async () => {
    const dir = tmp(); const clock = { t: T_SLOT }; const logs: string[] = [];
    const b = mk(dir, clock, logs, { slotReserve: Y0 });
    expect(await as('get_market_regime', b, 600, 'interactive')).toBe('ok');
    expect(await as('backfill_outcomes_server', b, 100, 'batch')).toBe('ok');
    expect(b._readLedger().slotRefusals).toBeUndefined();
    await rollOut(b, clock);
    expect(parse(logs, 'slot_standdown')).toHaveLength(0);
    expect(parse(logs, 'slot_reserve_disabled')).toHaveLength(0);                    // Y = 0 is a silent OFF, not a fault
  });
});

describe('fail-open (CH1 §5) and the no-skip guarantee', () => {
  it('an error in the slot rule ⇒ today\'s decision for that call + ONE slot_reserve_failopen line per window', async () => {
    const dir = tmp(); const clock = { t: T_SLOT }; const logs: string[] = [];
    const b = mk(dir, clock, logs, { slotFaultInjectForTest: () => { throw new Error('injected'); } });
    expect(await as('get_market_regime', b, 600, 'interactive')).toBe('ok');
    expect(await as('backfill_outcomes_server', b, 50, 'batch')).toBe('ok');       // 650 > 467: admitted on today's 700
    expect(await as('seed:5m:hl', b, 50, 'batch')).toBe('ok');                     // 700 ≤ 700
    clock.t = T_SLOT + 30 * 60_000;                                                  // the next slot window
    expect(await as('signal_perf_backfill', b, 10, 'batch')).toBe('ok');
    const fo = parse(logs, 'slot_reserve_failopen');
    expect(fo.map((l) => l.window_start)).toEqual([new Date(T_SLOT).toISOString(), new Date(T_SLOT + 1_800_000).toISOString()]);
    expect(fo[0]).toMatchObject({ venue: 'Hyperliquid', error: 'injected' });
  });
  it('a slot refusal past the deadline waits ONE more window instead of skipping', async () => {
    const dir = tmp(); const clock = { t: T_SLOT + 10_000 }; const logs: string[] = [];
    const b = mk(dir, clock, logs, { maxBatchWaitMs: 0 });
    expect(await as('get_market_regime', b, 540, 'interactive')).toBe('ok');
    expect(await as('seed:5m:hl', b, 50, 'batch')).toBe('ok');                     // 590 > 540, ≤ 700: slot refusal → waits → 01:01
    expect(clock.t).toBe(T_PLAIN);
    expect(parse(logs, 'batch_skip')).toHaveLength(0);
  });
  it('today\'s refusal past the deadline still skips, exactly as before', async () => {
    const dir = tmp(); const clock = { t: T_PLAIN + 10_000 }; const logs: string[] = [];
    const b = mk(dir, clock, logs, { maxBatchWaitMs: 0 });
    expect(await as('get_market_regime', b, 700, 'interactive')).toBe('ok');
    expect(await as('seed:5m:hl', b, 1, 'batch')).toBe('skip');
  });
});

describe('batchHeadroom() reads the same slot-aware cap (R6)', () => {
  it('540 / 467 in a slot window by caller, 700 outside', async () => {
    const dir = tmp(); const clock = { t: T_SLOT }; const logs: string[] = [];
    const b = mk(dir, clock, logs);
    expect(await as('seed:5m:hl', b, 100, 'batch')).toBe('ok');
    expect(runAsCaller('seed:15m:hl', () => b.batchHeadroom())).toBe(440);
    expect(runAsCaller('backfill_outcomes_cron', () => b.batchHeadroom())).toBe(367);
    clock.t = T_PLAIN;
    expect(runAsCaller('backfill_outcomes_cron', () => b.batchHeadroom())).toBe(700);
  });
});

describe('replay — Y = 0 identity (both goldens) and Y = 160 over the synthetic production corpus (R7)', () => {
  class BudgetY0 extends WeightBudget { constructor(o: ConstructorParameters<typeof WeightBudget>[0]) { super({ ...o, slotReserve: Y0 }); } }
  class BudgetY160 extends WeightBudget { constructor(o: ConstructorParameters<typeof WeightBudget>[0]) { super({ ...o, slotReserve: SLOT }); } }
  const golden1 = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/weight-budget-replay.golden.json'), 'utf8'));
  const golden2 = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/weight-budget-replay-slot.golden.json'), 'utf8'));

  it('Y = 0 is byte-identical to weight-budget-replay.golden.json', async () => {
    const trace = await replay(BudgetY0 as never, runAsCaller);
    expect(trace.results).toEqual(golden1.results);
    expect(trace.windowLines).toEqual(golden1.windowLines);
  });
  it('Y = 0 reproduces the pre-wave (8deaf4da) production-corpus golden byte for byte', { timeout: 60_000 }, async () => {
    expect(golden2.generated_from).toMatch(/^8deaf4da /);
    const corpus = buildProdCorpus();
    expect(sha256Json(corpus)).toBe(golden2.corpus_sha256);
    const trace = await replayEvents(BudgetY0 as never, runAsCaller, { corpus });
    expect(summarizeTrace(trace)).toEqual(golden2.summary);
    expect(sha256Json(trace)).toBe(golden2.trace_sha256);
  });
  it('Y = 160 holds every cap, waits FEB out, emits the stand-down lines, and charges no paying caller', { timeout: 60_000 }, async () => {
    const trace = await replayEvents(BudgetY160 as never, runAsCaller);
    const isSlot = (ms: number) => [0, 30].includes(new Date(ms).getUTCMinutes());
    const winOf = (ms: number) => Math.floor(ms / 60_000) * 60_000;
    // every admission, read from the ledger right after it: used + w ≤ 540 in a slot window, ≤ 467 for the stand-down callers
    let slotAdmissions = 0, sdSlotAdmissions = 0;
    for (const r of trace.results) {
      if (r.outcome !== 'ok' || r.cls !== 'batch' || !isSlot(winOf(r.tEnd))) continue;
      const used = (r.ledgerAfter as { used: number }).used;
      slotAdmissions++; expect(used, `slot admission #${r.i} ${r.caller}`).toBeLessThanOrEqual(C - R - 160);
      if (BF3.includes(r.caller)) { sdSlotAdmissions++; expect(used, `stand-down admission #${r.i} ${r.caller}`).toBeLessThanOrEqual(C - R - 160 - 73); }
    }
    expect(slotAdmissions).toBeGreaterThan(50); expect(sdSlotAdmissions).toBeGreaterThan(20);   // the corpus exercises both caps
    const windows = parse(trace.logs, 'window'); const callers = parse(trace.logs, 'window_caller'); const sd = parse(trace.logs, 'slot_standdown');
    const slotWindows = windows.filter((w) => isSlot(Date.parse(String(w.window_start))));
    expect(slotWindows.length).toBe(5);
    for (const w of windows) expect(w.used as number).toBeLessThanOrEqual(C);
    for (const w of slotWindows) {
      expect(w.batch_used as number).toBeLessThanOrEqual(540);
      const rows = callers.filter((c) => c.window_start === w.window_start);
      expect(rows.filter((c) => BF3.includes(String(c.caller)) && c.class === 'batch').reduce((a, c) => a + (c.weight as number), 0)).toBeLessThanOrEqual(467);
      expect(rows.filter((c) => c.caller === FEB).reduce((a, c) => a + (c.weight as number), 0)).toBe(0);
      expect(sd.filter((l) => l.window_start === w.window_start).map((l) => l.caller)).toEqual(BF3);
    }
    expect(sd.reduce((a, l) => a + (l.refusals as number), 0)).toBeGreaterThan(0);
    // FEB never acquires in a slot window; its 02:30 waits are recorded in both places
    expect(trace.results.filter((r) => r.caller === FEB && r.outcome === 'ok' && isSlot(winOf(r.tEnd)))).toHaveLength(0);
    const feb0230 = callers.find((c) => c.caller === FEB && c.window_start === '2026-10-03T02:30:00.000Z');
    expect((feb0230?.waits as number) ?? 0).toBeGreaterThan(0);
    expect(rle.calls.filter((c) => c[1] === 'wait' && c[3] === 'interactive' && c[5] === FEB).length).toBe(feb0230?.waits);
    // no interactive caller outside the stand-down list throws more than in the pre-wave golden; nothing skips
    const s = summarizeTrace(trace);
    for (const [caller, n] of Object.entries(s.interactive_throws_by_caller)) {
      if (caller === FEB) continue;
      expect(n, caller).toBeLessThanOrEqual((golden2.summary.interactive_throws_by_caller as Record<string, number>)[caller] ?? 0);
    }
    expect(s.outcomes.skip ?? 0).toBe(0);
    expect(PROD_CONFIG.ceilingPerMin).toBe(C);
  });
});
