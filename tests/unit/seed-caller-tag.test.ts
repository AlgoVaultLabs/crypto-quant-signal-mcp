/**
 * tests/unit/seed-caller-tag.test.ts — OPS-RATELIMIT-TIDYUP-W1 R1.2
 *
 * The seed wraps its whole run in `runAsBatch(fn, 'seed:' + parseArgs().timeframe)`
 * (seed-signals.ts main()) → every HL rate_limit_events row it emits carries
 * caller='seed:<tf>' in the BATCH class. This closes the deferred attribution gap from
 * OPS-RATELIMIT-CALLER-ATTRIBUTION-W1: the steady-state `unknown` batch waits were
 * exactly these seed rows. Importing parseArgs is safe — seed-signals.ts only runs
 * main() under `require.main === module` (see its bottom guard).
 */
import { describe, it, expect } from 'vitest';
import { parseArgs } from '../../src/scripts/seed-signals.js';
import { runAsBatch, currentCaller, currentWeightClass } from '../../src/lib/upstream-weight-budget.js';

describe('seed caller tag — seed:<tf> in the batch lane (OPS-RATELIMIT-TIDYUP-W1)', () => {
  it('derives the per-timeframe caller from parseArgs (incl. the 15m default)', () => {
    expect(parseArgs(['--timeframe', '8h']).timeframe).toBe('8h');
    expect(parseArgs(['--timeframe', '5m', '--top', '50']).timeframe).toBe('5m');
    expect(parseArgs([]).timeframe).toBe('15m');
  });

  it('the exact main() seam tags caller=seed:<tf>, class=batch (not unknown)', async () => {
    // main(): const seedTf = parseArgs().timeframe; return runAsBatch(fn, 'seed:' + seedTf)
    const seedTf = parseArgs(['--timeframe', '8h']).timeframe;
    const seen = await runAsBatch(
      async () => ({ caller: currentCaller(), cls: currentWeightClass() }),
      'seed:' + seedTf,
    );
    expect(seen).toEqual({ caller: 'seed:8h', cls: 'batch' });
    expect(seen.caller).not.toBe('unknown');
  });

  it('every valid timeframe yields a distinct seed:<tf> tag', async () => {
    for (const tf of ['1m', '5m', '15m', '1h', '8h', '1d']) {
      const seen = await runAsBatch(
        async () => currentCaller(),
        'seed:' + parseArgs(['--timeframe', tf]).timeframe,
      );
      expect(seen).toBe(`seed:${tf}`);
    }
  });
});
