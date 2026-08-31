/**
 * tests/unit/upstream-weight-budget.test.ts — OPS-HL-RATELIMITER-W2
 *
 * Unit suite for the cross-process weight ledger (`src/lib/upstream-weight-budget.ts`)
 * and the HL `weightFor` mapper (`src/lib/adapters/hyperliquid.ts`).
 *
 * Design under test (per audits/OPS-HL-RATELIMITER-W2-endpoint-truth.md §10):
 *   - File-ledger token bucket: { windowStartMs, used, ... } at ledgerPath,
 *     guarded by an O_EXCL lockfile (stale-steal). Window rolls on the minute
 *     boundary (used resets to 0).
 *   - interactive: throws UpstreamRateLimitError when used+weight > ceiling.
 *   - batch: waits for the window to roll (up to maxBatchWaitMs), then returns
 *     a SKIP (WeightBudgetSkipError) — never the user-facing rate-limit throw.
 *     interactiveReserve keeps batch from starving interactive.
 *   - AsyncLocalStorage class context: default = interactive; runAsBatch() flips it.
 *
 * `now` and the batch `sleep` are injected so timing is deterministic with no
 * global clock mocking. Lock-contention retry uses real (tiny) setTimeout so the
 * 20-way race serialises without advancing the injected clock.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  WeightBudget,
  WeightBudgetSkipError,
  currentWeightClass,
  runAsBatch,
} from '../../src/lib/upstream-weight-budget.js';
import { weightFor } from '../../src/lib/adapters/hyperliquid.js';
import { UpstreamRateLimitError } from '../../src/lib/errors.js';

const tmpFiles: string[] = [];

interface Clock {
  t: number;
}

function makeBudget(overrides: Record<string, unknown> = {}): {
  budget: WeightBudget;
  clock: Clock;
  ledgerPath: string;
  lockPath: string;
} {
  const id = `wb-test-${process.pid}-${tmpFiles.length}-${Math.floor(Math.random() * 1e9)}`;
  const ledgerPath = path.join(os.tmpdir(), `${id}.json`);
  const lockPath = path.join(os.tmpdir(), `${id}.lock`);
  tmpFiles.push(ledgerPath, lockPath);
  // Default window start at minute 1 (60_000) so we have a clean boundary to cross.
  const clock: Clock = { t: 60_000 };
  const budget = new WeightBudget({
    venue: 'Hyperliquid',
    ledgerPath,
    lockPath,
    ceilingPerMin: 1000,
    interactiveReserve: 300,
    maxBatchWaitMs: 300_000,
    now: () => clock.t,
    // Injected batch sleep: advance the injected clock instead of real-time waiting.
    sleep: async (ms: number) => {
      clock.t += ms;
    },
    log: () => {},
    ...overrides,
  });
  return { budget, clock, ledgerPath, lockPath };
}

afterEach(() => {
  for (const f of tmpFiles) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* ignore */
    }
  }
  tmpFiles.length = 0;
});

describe('WeightBudget — window roll', () => {
  it('accumulates used within a window and resets to 0 on the next minute boundary', async () => {
    const { budget, clock } = makeBudget();
    await budget.acquire(500, 'batch');
    expect(budget._readLedger().used).toBe(500);

    // Still inside the same minute window → accumulates.
    clock.t = 60_000 + 59_000;
    await budget.acquire(200, 'batch');
    expect(budget._readLedger().used).toBe(700);

    // Cross into the next minute window → used resets, then this acquire counts.
    clock.t = 120_000;
    await budget.acquire(100, 'batch');
    expect(budget._readLedger().used).toBe(100);
  });
});

describe('WeightBudget — batch waits then proceeds', () => {
  it('a batch acquire that does not fit waits for the window to roll, then succeeds', async () => {
    const { budget, clock } = makeBudget();
    // Fill batch lane to its cap (ceiling - reserve = 700).
    await budget.acquire(700, 'batch');
    expect(budget._readLedger().used).toBe(700);

    // Next batch acquire (300) would exceed the 700 batch cap → must wait for roll.
    // Injected sleep advances the clock past the boundary; after roll it fits.
    await budget.acquire(300, 'batch');
    // After the roll, only the second acquire's weight is counted.
    expect(budget._readLedger().used).toBe(300);
    // The clock advanced into a later window (waited ~ up to a full window).
    expect(clock.t).toBeGreaterThanOrEqual(120_000);
  });
});

describe('WeightBudget — interactive reserve', () => {
  it('batch cannot consume the interactive reserve, but interactive can use the full ceiling', async () => {
    const { budget } = makeBudget();
    // Batch fills to its cap (700). The remaining 300 is reserved for interactive.
    await budget.acquire(700, 'batch');
    expect(budget._readLedger().used).toBe(700);

    // Interactive may use up to the full ceiling (1000): 700 + 300 = 1000 OK.
    await budget.acquire(300, 'interactive');
    expect(budget._readLedger().used).toBe(1000);
  });

  it('interactive can acquire even when batch has filled its cap (reserve protects it)', async () => {
    const { budget } = makeBudget();
    await budget.acquire(700, 'batch');
    // A 200-weight interactive call still fits within the reserve.
    await expect(budget.acquire(200, 'interactive')).resolves.toBeUndefined();
    expect(budget._readLedger().used).toBe(900);
  });
});

describe('WeightBudget — interactive throw', () => {
  it('throws a typed UpstreamRateLimitError with retryAfterSeconds when ceiling is exceeded', async () => {
    const { budget, clock } = makeBudget();
    // At 30s into the window, fill to ceiling via interactive.
    clock.t = 60_000 + 30_000;
    await budget.acquire(1000, 'interactive');

    let thrown: unknown;
    try {
      await budget.acquire(1, 'interactive');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(UpstreamRateLimitError);
    const err = thrown as UpstreamRateLimitError;
    expect(err.exchange).toBe('Hyperliquid');
    expect(err.code).toBe('UPSTREAM_RATE_LIMIT');
    // 30s left in the minute window → retryAfterSeconds ≈ 30.
    expect(err.retryAfterSeconds).toBe(30);
  });
});

describe('WeightBudget — batch SKIP under chronic saturation', () => {
  it('throws WeightBudgetSkipError (not a user throw) when a batch weight can never fit', async () => {
    const { budget } = makeBudget({ maxBatchWaitMs: 300_000 });
    // 800 > batch cap (700) → never fits even in a fresh window → SKIP after maxBatchWait.
    let thrown: unknown;
    try {
      await budget.acquire(800, 'batch');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(WeightBudgetSkipError);
    expect(thrown).not.toBeInstanceOf(UpstreamRateLimitError);
    const err = thrown as WeightBudgetSkipError;
    expect(err.venue).toBe('Hyperliquid');
    expect(err.weight).toBe(800);
  });
});

describe('WeightBudget — concurrent lock contention', () => {
  it('20 concurrent acquires through one ledger do not lose updates', async () => {
    // Share ONE ledger/lock across 20 separate WeightBudget instances (simulating
    // 20 cross-process callers). Fixed clock (no window roll); real tiny lock-retry.
    const id = `wb-race-${process.pid}-${Math.floor(Math.random() * 1e9)}`;
    const ledgerPath = path.join(os.tmpdir(), `${id}.json`);
    const lockPath = path.join(os.tmpdir(), `${id}.lock`);
    tmpFiles.push(ledgerPath, lockPath);

    const mk = () =>
      new WeightBudget({
        venue: 'Hyperliquid',
        ledgerPath,
        lockPath,
        ceilingPerMin: 100_000, // high ceiling so all 20 fit (testing lock, not rejection)
        interactiveReserve: 0,
        now: () => 60_000, // fixed → no roll
        log: () => {},
      });

    const N = 20;
    const W = 7;
    await Promise.all(Array.from({ length: N }, () => mk().acquire(W, 'batch')));

    const finalUsed = mk()._readLedger().used;
    expect(finalUsed).toBe(N * W); // 140 — zero lost updates
  });
});

describe('WeightBudget — stale lock steal', () => {
  it('steals a lock whose mtime is older than staleLockMs and proceeds', async () => {
    const { budget, lockPath } = makeBudget({ staleLockMs: 2_000 });
    // Plant a stale lockfile with an old mtime (10s ago in wall-clock terms).
    fs.writeFileSync(lockPath, 'pid=999999\n');
    const old = Date.now() / 1000 - 10;
    fs.utimesSync(lockPath, old, old);

    // acquire must steal the stale lock rather than hang.
    await budget.acquire(50, 'batch');
    expect(budget._readLedger().used).toBe(50);
  });
});

describe('weightFor — HL body → weight mapper', () => {
  it('maps metaAndAssetCtxs and predictedFundings to base weight 20', () => {
    expect(weightFor({ type: 'metaAndAssetCtxs' })).toBe(20);
    expect(weightFor({ type: 'metaAndAssetCtxs', dex: 'xyz' })).toBe(20);
    expect(weightFor({ type: 'predictedFundings' })).toBe(20);
  });

  it('maps candleSnapshot to 20 + ceil(items/60) using the weightHint (100 candles → 22)', () => {
    expect(weightFor({ type: 'candleSnapshot', req: {} }, 100)).toBe(22);
    expect(weightFor({ type: 'candleSnapshot', req: {} }, 60)).toBe(21);
    expect(weightFor({ type: 'candleSnapshot', req: {} }, 1)).toBe(21);
    expect(weightFor({ type: 'candleSnapshot', req: {} }, 168)).toBe(23);
  });

  it('maps fundingHistory to 20 + ceil(items/20)', () => {
    expect(weightFor({ type: 'fundingHistory' }, 100)).toBe(25);
    expect(weightFor({ type: 'fundingHistory' }, 20)).toBe(21);
  });

  it('maps the weight-2 endpoint class', () => {
    for (const type of [
      'l2Book',
      'allMids',
      'clearinghouseState',
      'orderStatus',
      'spotClearinghouseState',
      'exchangeStatus',
    ]) {
      expect(weightFor({ type })).toBe(2);
    }
  });

  it('defaults unknown body types to 20 (never under-count)', () => {
    expect(weightFor({ type: 'someFutureEndpoint' })).toBe(20);
    expect(weightFor({})).toBe(20);
  });
});

describe('weight class context (AsyncLocalStorage)', () => {
  it('defaults to interactive outside any runAsBatch scope', () => {
    expect(currentWeightClass()).toBe('interactive');
  });

  it('reports batch inside runAsBatch and restores interactive after', async () => {
    expect(currentWeightClass()).toBe('interactive');
    const seen = await runAsBatch(async () => {
      return currentWeightClass();
    });
    expect(seen).toBe('batch');
    expect(currentWeightClass()).toBe('interactive');
  });
});

// OPS-BAND-OUTCOME-WIRE-W1 R1 — the read-only headroom projection.
//
// `batchHeadroom()` exists so an advisory caller can skip a request it can predict will stall on
// `acquire()`'s 300 s batch wait. It must answer for the CURRENT window; the third case below is
// the one that makes it live in this class at all, because `_readLedger()` deliberately does not
// roll and `windowMs` is private, so no external reader could get it right.
describe('WeightBudget — batchHeadroom (advisory, roll-aware)', () => {
  it('is the full ceiling−reserve on an untouched ledger, and never the raw ceiling', () => {
    const { budget } = makeBudget(); // ceiling 1000, reserve 300
    expect(budget.batchHeadroom()).toBe(700);
  });

  it('decreases by batch usage only — interactive usage does not consume batch headroom', async () => {
    const { budget } = makeBudget();
    await budget.acquire(200, 'batch');
    expect(budget.batchHeadroom()).toBe(500);
    await budget.acquire(100, 'interactive');
    // `used` is now 300, but the batch cap is measured against batchUsed, which is still 200.
    expect(budget._readLedger().used).toBe(300);
    expect(budget.batchHeadroom()).toBe(500);
  });

  it('reports the FULL cap once the window has rolled, even though the ledger still holds the closed window', async () => {
    const { budget, clock } = makeBudget();
    await budget.acquire(700, 'batch'); // saturate the batch lane
    expect(budget.batchHeadroom()).toBe(0);

    // Cross the minute boundary WITHOUT acquiring. `roll()` only fires inside `acquire()`, so the
    // on-disk ledger still carries the closed window's 700. A naive reader would report a
    // saturated lane for a window that is in fact empty — that false negative is what this guards.
    clock.t += 60_000;
    expect(budget._readLedger().batchUsed).toBe(700); // the stale ledger, unchanged on disk
    expect(budget.batchHeadroom()).toBe(700); // …but the CURRENT window is empty
  });

  it('floors at 0 rather than going negative', async () => {
    const { budget } = makeBudget({ ceilingPerMin: 1000, interactiveReserve: 300 });
    await budget.acquire(700, 'batch');
    // Interactive may exceed the batch cap (it is capped at the full ceiling), which would drive
    // a naive `cap − batchUsed` below zero if it read `used`.
    await budget.acquire(300, 'interactive');
    expect(budget.batchHeadroom()).toBe(0);
    expect(budget.batchHeadroom()).toBeGreaterThanOrEqual(0);
  });
});
