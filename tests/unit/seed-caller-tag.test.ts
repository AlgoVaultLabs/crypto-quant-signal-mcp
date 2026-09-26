/**
 * tests/unit/seed-caller-tag.test.ts — OPS-RATELIMIT-TIDYUP-W1 R1.2
 *
 * The seed wraps its whole run in `runAsBatch(fn, seedCallerTag(parseArgs()))`
 * (seed-signals.ts main()) → every HL rate_limit_events row it emits carries
 * caller='seed:<tf>:<lane>' in the BATCH class. (OPS-UPSTREAM-ACQUISITION-ACCOUNTING-W1 made the tag
 * lane-specific: the bare 'seed:<tf>' named the HL, promoted, shadow and WEEX lanes at once.) This closes the deferred attribution gap from
 * OPS-RATELIMIT-CALLER-ATTRIBUTION-W1: the steady-state `unknown` batch waits were
 * exactly these seed rows. Importing parseArgs is safe — seed-signals.ts only runs
 * main() under `require.main === module` (see its bottom guard).
 */
import { describe, it, expect } from 'vitest';
import { parseArgs } from '../../src/scripts/seed-signals.js';
import { runAsBatch, currentCaller, currentWeightClass } from '../../src/lib/upstream-weight-budget.js';
import { seedCallerTag } from '../../src/lib/caller-tags.js';

describe('seed caller tag — seed:<tf> in the batch lane (OPS-RATELIMIT-TIDYUP-W1)', () => {
  it('derives the per-timeframe caller from parseArgs (incl. the 15m default)', () => {
    expect(parseArgs(['--timeframe', '8h']).timeframe).toBe('8h');
    expect(parseArgs(['--timeframe', '5m', '--top', '50']).timeframe).toBe('5m');
    expect(parseArgs([]).timeframe).toBe('15m');
  });

  it('the exact main() seam tags caller=seed:<tf>:<lane>, class=batch (never unattributed)', async () => {
    // main(): return runAsBatch(fn, seedCallerTag(parseArgs()))
    const seen = await runAsBatch(
      async () => ({ caller: currentCaller(), cls: currentWeightClass() }),
      seedCallerTag(parseArgs(['--timeframe', '8h', '--exchange', 'HL'])),
    );
    expect(seen).toEqual({ caller: 'seed:8h:hl', cls: 'batch' });
    expect(seen.caller.startsWith('unattributed:')).toBe(false);
  });

  it('every valid timeframe yields a distinct seed:<tf>:<lane> tag', async () => {
    for (const tf of ['1m', '5m', '15m', '1h', '8h', '1d']) {
      const seen = await runAsBatch(
        async () => currentCaller(),
        seedCallerTag(parseArgs(['--timeframe', tf, '--status', 'promoted'])),
      );
      expect(seen).toBe(`seed:${tf}:promoted`);
    }
  });
});
