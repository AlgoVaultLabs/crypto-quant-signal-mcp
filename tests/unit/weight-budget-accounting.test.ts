/**
 * tests/unit/weight-budget-accounting.test.ts — OPS-UPSTREAM-ACQUISITION-ACCOUNTING-W1 CH2.
 *
 * Per-caller acquisition accounting. The ledger already knew every granted weight and discarded who
 * asked; a per-venue SIDECAR now records (caller, class) → {weight, grants, waits, skips, throws} in the
 * SAME critical section that mutates `used`, and each window roll emits flat `window_caller` lines.
 *
 * Pins, each proven able to fail: the Σ invariant (Σ weight == used, per class == batchUsed /
 * interactiveUsed) across two instances AND two real OS processes in one window on the grant, wait,
 * skip and throw paths; admission byte-identical to the pre-wave implementation (replay against a
 * golden produced from origin/main 2dcafc2a); fail-open under injected faults; `_overflow` carrying
 * weight past the key cap; the flat line's exact key order; and the census regex (HEADROOM K11)
 * matching `window` and never `window_caller`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  WeightBudget, WeightBudgetSkipError, runAsCaller, callerSidecarPath,
} from '../../src/lib/upstream-weight-budget.js';
import { UpstreamRateLimitError } from '../../src/lib/errors.js';
import { replay, CONFIG as REPLAY_CONFIG } from '../fixtures/weight-budget-replay.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function tmp(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-acct-')); dirs.push(d); return d; }

type Line = Record<string, unknown>;
function mk(dir: string, clock: { t: number }, logs: string[], extra: Record<string, unknown> = {}) {
  return new WeightBudget({
    venue: 'Test', ledgerPath: path.join(dir, 'algovault-test-weight.json'), lockPath: path.join(dir, 'algovault-test-weight.lock'),
    ceilingPerMin: 100, interactiveReserve: 40, windowMs: 60_000, maxBatchWaitMs: 30_000, staleLockMs: 60_000, lockRetryMs: 1,
    now: () => clock.t, sleep: async (ms: number) => { clock.t += ms; }, log: (l: string) => logs.push(l), ...extra,
  });
}
const parse = (logs: string[], event: string): Line[] => logs.map((l) => JSON.parse(l) as Line).filter((x) => x.event === event);
async function settle(p: Promise<void>): Promise<string> {
  try { await p; return 'ok'; }
  catch (e) { return e instanceof UpstreamRateLimitError ? 'throw' : e instanceof WeightBudgetSkipError ? 'skip' : `error:${(e as Error).message}`; }
}
/** Assert the Σ invariant for every closed window present in the logs. Returns the windows checked. */
function assertInvariant(logs: string[]): number {
  const windows = parse(logs, 'window'); const callers = parse(logs, 'window_caller');
  expect(windows.length).toBeGreaterThan(0);
  for (const w of windows) {
    const rows = callers.filter((c) => c.window_start === w.window_start && c.venue === w.venue);
    const sum = (cls: string | null, k: string) => rows.filter((r) => cls === null || r.class === cls).reduce((a, r) => a + (r[k] as number), 0);
    expect(sum(null, 'weight'), `Σ weight == used @ ${w.window_start}`).toBe(w.used);
    expect(sum('batch', 'weight'), `Σ batch == batch_used @ ${w.window_start}`).toBe(w.batch_used);
    expect(sum('interactive', 'weight'), `Σ interactive == interactive_used @ ${w.window_start}`).toBe(w.interactive_used);
    expect(sum(null, 'waits')).toBe(w.waits);
    expect(sum(null, 'skips')).toBe(w.skips);
    expect(sum(null, 'throws')).toBe(w.throws);
    for (const r of rows) expect(r.accounting_errors).toBe(0);
  }
  return windows.length;
}

describe('Σ invariant — two instances sharing one ledger, one window, all four paths', () => {
  it('grant, wait, skip and throw are all attributed, and Σ matches the ledger exactly', async () => {
    const dir = tmp(); const clock = { t: 1_790_400_000_000 }; const logs: string[] = [];
    // The batch cap is on TOTAL `used` (interactive included): used + w <= ceiling − reserve (= 60).
    // t0 is minute-aligned, so a batch wait sleeps a full window before re-trying.
    const a = mk(dir, clock, logs, { maxBatchWaitMs: 90_000 }); const b = mk(dir, clock, logs, { maxBatchWaitMs: 90_000 });
    const outcomes = [
      await settle(runAsCaller('seed:5m:hl', () => a.acquire(25, 'batch'))),            // grant: used 25
      await settle(runAsCaller('get_trade_call', () => b.acquire(30, 'interactive'))),   // grant: used 55
      await settle(runAsCaller('seed:5m:promoted', () => a.acquire(4, 'batch'))),         // grant: used 59 ≤ 60
      await settle(runAsCaller('backfill_outcomes_cron', () => b.acquire(10, 'batch'))), // 69 > 60 → WAIT, then GRANT in the next window
      await settle(runAsCaller('scan_trade_calls', () => a.acquire(95, 'interactive'))),  // 10 + 95 > 100 → THROW
      await settle(runAsCaller('band_outcome_backfill', () => b.acquire(70, 'batch'))),   // 70 > the 60 batch cap, always → waits to 90 s → SKIP
    ];
    clock.t += 120_000;
    await runAsCaller('roll_trigger', () => a.acquire(1, 'batch'));                     // rolls the last window
    expect(outcomes).toEqual(['ok', 'ok', 'ok', 'ok', 'throw', 'skip']);
    const kinds = parse(logs, 'window_caller').reduce((acc, r) => ({ ...acc, grants: acc.grants + (r.grants as number), waits: acc.waits + (r.waits as number), skips: acc.skips + (r.skips as number), throws: acc.throws + (r.throws as number) }), { grants: 0, waits: 0, skips: 0, throws: 0 });
    expect(kinds.grants).toBeGreaterThan(0); expect(kinds.waits).toBeGreaterThan(0); expect(kinds.skips).toBeGreaterThan(0); expect(kinds.throws).toBeGreaterThan(0);
    expect(assertInvariant(logs)).toBeGreaterThanOrEqual(2);
    const names = new Set(parse(logs, 'window_caller').map((r) => r.caller));
    for (const n of ['seed:5m:hl', 'get_trade_call', 'seed:5m:promoted', 'backfill_outcomes_cron', 'scan_trade_calls', 'band_outcome_backfill']) expect(names.has(n)).toBe(true);
  });
});

describe('Σ invariant — two REAL OS processes in one window', () => {
  // Spawns two tsx children (429 ms isolated); the explicit budget absorbs full-suite spawn contention.
  it('concurrent child processes contend on the lock; every granted weight is attributed', { timeout: 60_000 }, () => {
    const dir = tmp(); const T = 1_790_400_000_000;
    const repo = process.cwd();
    const child = (caller: string, cls: string, n: number) => `
      const { WeightBudget, runAsCaller } = require(${JSON.stringify(path.join(repo, 'src/lib/upstream-weight-budget.ts'))});
      const b = new WeightBudget({ venue: 'Test', ledgerPath: ${JSON.stringify(path.join(dir, 'algovault-test-weight.json'))},
        lockPath: ${JSON.stringify(path.join(dir, 'algovault-test-weight.lock'))}, ceilingPerMin: 100000, interactiveReserve: 40000,
        windowMs: 60000, maxBatchWaitMs: 10, staleLockMs: 60000, lockRetryMs: 1, now: () => ${T}, sleep: async () => {}, log: () => {} });
      (async () => { for (let i = 0; i < ${n}; i++) { try { await runAsCaller(${JSON.stringify(caller)}, () => b.acquire(1 + (i % 7), ${JSON.stringify(cls)})); } catch {} } })();`;
    const tsx = path.join(repo, 'node_modules/.bin/tsx');
    // Two processes launched concurrently via a shell so they genuinely overlap on the O_EXCL lock.
    const f1 = path.join(dir, 'c1.cts'); const f2 = path.join(dir, 'c2.cts');
    fs.writeFileSync(f1, child('proc_one', 'batch', 150)); fs.writeFileSync(f2, child('proc_two', 'interactive', 150));
    const r = spawnSync('bash', ['-c', `VITEST=1 "${tsx}" "${f1}" & VITEST=1 "${tsx}" "${f2}" & wait`], { encoding: 'utf8', timeout: 60_000 });
    expect(r.status, r.stderr).toBe(0);
    // Roll the window in-process and read the emitted lines.
    const logs: string[] = [];
    const roller = mk(dir, { t: T + 60_000 }, logs, { ceilingPerMin: 100000, interactiveReserve: 40000 });
    return runAsCaller('roll_trigger', () => roller.acquire(1, 'batch')).then(() => {
      const w = parse(logs, 'window')[0]; const rows = parse(logs, 'window_caller');
      const exp = Array.from({ length: 150 }, (_, i) => 1 + (i % 7)).reduce((a, x) => a + x, 0);
      expect(w.used).toBe(2 * exp);
      expect(rows.find((x) => x.caller === 'proc_one')?.weight).toBe(exp);
      expect(rows.find((x) => x.caller === 'proc_two')?.weight).toBe(exp);
      expect(rows.find((x) => x.caller === 'proc_one')?.grants).toBe(150);
      assertInvariant(logs);
    });
  }, 90_000);
});

describe('admission is byte-identical to the pre-wave implementation (replay vs golden)', () => {
  it('every grant, wait, skip and throw — and every existing window line — matches origin/main 2dcafc2a', async () => {
    const golden = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/weight-budget-replay.golden.json'), 'utf8'));
    expect(golden.config).toEqual(REPLAY_CONFIG);
    const trace = await replay(WeightBudget as never, runAsCaller);
    expect(trace.results).toEqual(golden.results);
    expect(trace.windowLines).toEqual(golden.windowLines); // the `window` line, byte for byte
    const tally = new Set(golden.results.map((r: { outcome: string }) => r.outcome.split(':')[0]));
    expect(tally).toEqual(new Set(['ok', 'throw', 'skip'])); // and waits: 73 golden calls advanced the clock
    expect(golden.results.filter((r: { tAfter: number; tBefore: number }) => r.tAfter > r.tBefore).length).toBeGreaterThan(0);
  });

  it('the replay also satisfies the Σ invariant on every one of its windows', async () => {
    const dir = tmp(); const logs: string[] = [];
    const Spy = class extends (WeightBudget as unknown as new (o: Record<string, unknown>) => WeightBudget) {
      constructor(o: Record<string, unknown>) { super({ ...o, log: (l: string) => { logs.push(l); (o.log as (l: string) => void)(l); } }); }
    };
    await replay(Spy as never, runAsCaller, dir);
    expect(assertInvariant(logs)).toBeGreaterThan(50);
  });
});

describe('fail-open — an accounting fault never changes admission and never throws', () => {
  it('an UNWRITABLE sidecar: decisions still match the golden; the shortfall is left for UNATTRIB_PCT', async () => {
    const golden = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/weight-budget-replay.golden.json'), 'utf8'));
    const Faulty = class extends (WeightBudget as unknown as new (o: Record<string, unknown>) => WeightBudget) {
      constructor(o: Record<string, unknown>) {
        const bad = path.join(path.dirname(o.ledgerPath as string), 'sidecar-is-a-directory');
        fs.mkdirSync(bad, { recursive: true });
        super({ ...o, callersPath: bad }); // read → EISDIR, write → EISDIR: every accounting call faults
      }
    };
    const trace = await replay(Faulty as never, runAsCaller);
    expect(trace.results).toEqual(golden.results);
    expect(trace.windowLines).toEqual(golden.windowLines);
  });

  it('a CORRUPT sidecar is counted in accounting_errors and later weight is still attributed', async () => {
    const dir = tmp(); const clock = { t: 1_790_400_000_000 }; const logs: string[] = [];
    const a = mk(dir, clock, logs);
    await runAsCaller('before', () => a.acquire(10, 'batch'));
    fs.writeFileSync(callerSidecarPath(path.join(dir, 'algovault-test-weight.json')), '{not json');
    await runAsCaller('after', () => a.acquire(7, 'batch'));
    clock.t += 60_000;
    await runAsCaller('roll_trigger', () => a.acquire(1, 'batch'));
    const rows = parse(logs, 'window_caller'); const w = parse(logs, 'window')[0];
    expect(w.used).toBe(17);
    expect(rows.find((r) => r.caller === 'after')?.weight).toBe(7);
    expect(rows.every((r) => (r.accounting_errors as number) >= 1)).toBe(true);
    const named = rows.reduce((s, r) => s + (r.weight as number), 0);
    expect(w.used as number - named).toBe(10); // the lost weight is a visible shortfall, never re-attributed
  });
});

describe('_overflow carries weight past the key cap', () => {
  it('Σ still equals used with more distinct callers than the cap allows', async () => {
    const dir = tmp(); const clock = { t: 1_790_400_000_000 }; const logs: string[] = [];
    const a = mk(dir, clock, logs, { ceilingPerMin: 100000, interactiveReserve: 40000, callerKeyCap: 4 });
    for (let i = 0; i < 10; i++) await runAsCaller(`caller_${i}`, () => a.acquire(3, 'batch'));
    clock.t += 60_000;
    await runAsCaller('roll_trigger', () => a.acquire(1, 'batch'));
    const rows = parse(logs, 'window_caller');
    expect(rows.find((r) => r.caller === '_overflow')?.weight).toBe(18); // 6 callers × 3 past the cap of 4
    expect(rows.filter((r) => !String(r.caller).startsWith('_')).length).toBe(4);
    assertInvariant(logs);
  });
});

describe('the window_caller line — flat, fixed key order, invisible to the census regex', () => {
  const K11 = /\{"tag":"upstream-weight-budget","event":"window","venue":"Hyperliquid"[^}]*\}/;

  it('keys come out in exactly the declared order, with no nested object', async () => {
    const dir = tmp(); const clock = { t: 1_790_400_000_000 }; const logs: string[] = [];
    const a = mk(dir, clock, logs);
    await runAsCaller('x', () => a.acquire(5, 'batch'));
    clock.t += 60_000;
    await runAsCaller('roll_trigger', () => a.acquire(1, 'batch'));
    const line = logs.find((l) => l.includes('"event":"window_caller"'))!;
    expect(Object.keys(JSON.parse(line))).toEqual(['tag', 'event', 'venue', 'window_start', 'caller', 'class', 'weight', 'grants', 'waits', 'skips', 'throws', 'accounting_errors']);
    expect(line).not.toMatch(/:\{/);
  });

  it('HEADROOM K11 regex matches a real window line and never a window_caller line', () => {
    const win = JSON.stringify({ tag: 'upstream-weight-budget', event: 'window', venue: 'Hyperliquid', window_start: '2026-09-26T00:00:00.000Z', used: 1, batch_used: 1, interactive_used: 0, waits: 0, skips: 0, throws: 0 });
    const wc = JSON.stringify({ tag: 'upstream-weight-budget', event: 'window_caller', venue: 'Hyperliquid', window_start: '2026-09-26T00:00:00.000Z', caller: 'x', class: 'batch', weight: 1, grants: 1, waits: 0, skips: 0, throws: 0, accounting_errors: 0 });
    expect(win).toMatch(K11);
    expect(wc).not.toMatch(K11);
  });

  it('the sidecar lives beside the ledger and the ledger file keys are untouched', async () => {
    const dir = tmp(); const clock = { t: 1_790_400_000_000 }; const logs: string[] = [];
    const ledger = path.join(dir, 'algovault-test-weight.json');
    const a = mk(dir, clock, logs);
    await runAsCaller('x', () => a.acquire(5, 'batch'));
    expect(callerSidecarPath('/tmp/algovault-hl-weight.json')).toBe('/tmp/algovault-hl-weight.callers.json');
    expect(Object.keys(JSON.parse(fs.readFileSync(ledger, 'utf8')))).toEqual(['windowStartMs', 'used', 'batchUsed', 'interactiveUsed', 'waits', 'skips', 'throws']);
    expect(fs.existsSync(callerSidecarPath(ledger))).toBe(true);
  });
});
