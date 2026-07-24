/**
 * tests/unit/seed-coverage-canary.test.ts — OPS-SEED-PROMOTED-RAMP-W1
 *
 * Unit-pins the pure core of scripts/check-seed-coverage.mjs: every promoted venue
 * must be covered by a fast (<45min) seed line. This is the structural guard that
 * makes the "Seed OUTAGE" producer↔monitor SoT-divergence bug class impossible to
 * silently reintroduce.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — pure ESM canary, no type decls needed for the test.
import { findUncoveredPromoted, fastCoverageForLine, FAST_TFS } from '../../scripts/check-seed-coverage.mjs';

const PROMOTED = ['ASTER', 'BINANCE', 'BINGX', 'BITGET', 'BYBIT', 'GATE', 'HL', 'HTX', 'KUCOIN', 'MEXC', 'OKX', 'PHEMEX'];

// The FIXED crontab (post OPS-SEED-PROMOTED-RAMP-W1): 3m/5m/15m/30m carry
// `--status promoted --exclude HL`; HL rides its own --exchange HL lines.
const FIXED = `
2-59/3 * * * * docker exec c node dist/scripts/seed-signals.js --timeframe 3m --top 15 --status promoted --exclude HL >> /var/log/seed-3m-standard.log 2>&1
1-56/5 * * * * docker exec c node dist/scripts/seed-signals.js --timeframe 5m --status promoted --exclude HL --top 30 --concurrency 1 >> /var/log/seed-orch-5m.log 2>&1
4,19,34,49 * * * * docker exec c node dist/scripts/seed-signals.js --timeframe 15m --status promoted --exclude HL --top 100 --concurrency 1 >> /var/log/seed-orch-15m.log 2>&1
6,36 * * * * docker exec c node dist/scripts/seed-signals.js --timeframe 30m --status promoted --exclude HL --top 100 --concurrency 1 >> /var/log/seed-orch-30m.log 2>&1
1,6,11,16,21,26,31,36,41,46,51,56 * * * * docker exec c node dist/scripts/seed-signals.js --timeframe 5m --top 50 --exchange HL >> /var/log/seed-hl.log 2>&1
53 2 * * * docker exec c node dist/scripts/seed-signals.js --timeframe 1d --exchange-list BINANCE,BYBIT,OKX,BITGET --concurrency 1 >> /var/log/seed-orch-1d.log 2>&1
`;

// The BROKEN crontab (pre-fix): the fast lines hardcode the fast-4 only; the 3m
// catch-all is all-venues but that alone is what starves. Model the real bug:
// only fast-4 + HL on sub-45m lines, the 7 others absent.
const BROKEN = `
1-56/5 * * * * docker exec c node dist/scripts/seed-signals.js --timeframe 5m --exchange-list BINANCE,BYBIT,OKX,BITGET --top 50 --concurrency 1 >> /var/log/seed-orch-5m.log 2>&1
4,19,34,49 * * * * docker exec c node dist/scripts/seed-signals.js --timeframe 15m --exchange-list BINANCE,BYBIT,OKX,BITGET --top 100 --concurrency 1 >> /var/log/seed-orch-15m.log 2>&1
1,6,11,16,21,26,31,36,41,46,51,56 * * * * docker exec c node dist/scripts/seed-signals.js --timeframe 5m --top 50 --exchange HL >> /var/log/seed-hl.log 2>&1
`;

describe('seed-coverage canary — findUncoveredPromoted', () => {
  it('FIXED crontab covers every promoted venue (no gaps)', () => {
    const { uncovered } = findUncoveredPromoted(FIXED, PROMOTED);
    expect(uncovered).toEqual([]);
  });

  it('BROKEN crontab flags exactly the 7 starved venues', () => {
    const { uncovered } = findUncoveredPromoted(BROKEN, PROMOTED);
    expect(uncovered.sort()).toEqual(['ASTER', 'BINGX', 'GATE', 'HTX', 'KUCOIN', 'MEXC', 'PHEMEX']);
  });

  it('`--status promoted --exclude HL` covers all promoted except HL', () => {
    const line = '* * * * * seed-signals.js --timeframe 3m --status promoted --exclude HL --top 15';
    const covered = fastCoverageForLine(line, PROMOTED).sort();
    expect(covered).not.toContain('HL');
    expect(covered).toEqual(PROMOTED.filter((v) => v !== 'HL').sort());
  });

  it('`--exchange HL` line covers HL (so HL is not a false gap)', () => {
    const line = '* * * * * seed-signals.js --timeframe 5m --exchange HL --top 50';
    expect(fastCoverageForLine(line, PROMOTED)).toEqual(['HL']);
  });

  it('`--status shadow` lines contribute zero promoted coverage', () => {
    const line = '* * * * * seed-signals.js --timeframe 5m --status shadow --top 50';
    expect(fastCoverageForLine(line, PROMOTED)).toEqual([]);
  });

  it('a 1h line does NOT count as fast coverage (60min > 45min SLA)', () => {
    const line = '* * * * * seed-signals.js --timeframe 1h --status promoted --exclude HL';
    expect(fastCoverageForLine(line, PROMOTED)).toEqual([]);
    expect(FAST_TFS.has('1h')).toBe(false);
  });

  it('comment lines are ignored', () => {
    const withComment = '# seed-signals.js --timeframe 3m --status promoted\n' + FIXED;
    const { uncovered } = findUncoveredPromoted(withComment, PROMOTED);
    expect(uncovered).toEqual([]);
  });

  it('ramp-proof: a newly-promoted venue is AUTO-covered by --status promoted (zero crontab edit)', () => {
    // The durable property: --status promoted resolves live, so a new promotion is
    // seeded with no crontab change. The canary reflects that — no false failure.
    const withNew = [...PROMOTED, 'NEWVENUE'];
    const { uncovered } = findUncoveredPromoted(FIXED, withNew);
    expect(uncovered).toEqual([]);
  });

  it('regression guard: a hardcoded --exchange-list crontab does NOT auto-cover a new venue', () => {
    // If a future edit reverts the fast lines to a hardcoded list, the canary
    // catches the newly-promoted venue BEFORE the "Seed OUTAGE" alert would fire.
    const hardcoded =
      '1-56/5 * * * * seed-signals.js --timeframe 5m --exchange-list BINANCE,BYBIT,OKX,BITGET --top 50 >> /var/log/seed-orch-5m.log 2>&1';
    const withNew = ['BINANCE', 'BYBIT', 'OKX', 'BITGET', 'NEWVENUE'];
    const { uncovered } = findUncoveredPromoted(hardcoded, withNew);
    expect(uncovered).toEqual(['NEWVENUE']);
  });
});

describe('seed-coverage canary — runtime-faithful gate (OPS-SEED-TF-SKIP-STRAND-HOTFIX-W1 R4)', () => {
  // Closes the exact gap the incident exposed: the canary checked crontab PRESENCE, never the runtime skip.
  // WhiteBIT is on every fast line but the deployed predicate runtime-skips its 3m/5m (→15m); it stays
  // covered via 15m/30m. A venue runtime-skipped on ALL its fast lines must now read UNCOVERED.
  const WB_FAITHFUL = { WHITEBIT: ['15m', '30m'], BINANCE: ['3m', '5m', '15m', '30m'] };

  it('a venue runtime-faithful only on 15m/30m is STILL covered (its 15m line keeps it in-SLA)', () => {
    const covered = fastCoverageForLine(
      '* * * * * seed-signals.js --timeframe 15m --status promoted --exclude HL',
      ['WHITEBIT', 'BINANCE', 'HL'], WB_FAITHFUL,
    );
    expect(covered).toContain('WHITEBIT');
  });

  it('a venue on the 3m/5m lines but runtime-skipped there is NOT counted as covered on those lines', () => {
    for (const tf of ['3m', '5m']) {
      const covered = fastCoverageForLine(
        `* * * * * seed-signals.js --timeframe ${tf} --status promoted --exclude HL`,
        ['WHITEBIT', 'BINANCE', 'HL'], WB_FAITHFUL,
      );
      expect(covered, `${tf} runtime-skips WHITEBIT`).not.toContain('WHITEBIT');
      expect(covered, `${tf} keeps BINANCE`).toContain('BINANCE');
    }
  });

  it('a venue runtime-skipped on EVERY fast line it is scheduled on is flagged UNCOVERED (the real stranding)', () => {
    const cron = ['3m', '5m', '15m', '30m']
      .map((tf) => `* * * * * seed-signals.js --timeframe ${tf} --status promoted --exclude HL`)
      .join('\n');
    const ff = { BINANCE: ['3m', '5m', '15m', '30m'], STRANDED: [] };
    const { uncovered } = findUncoveredPromoted(cron, ['BINANCE', 'STRANDED'], ff);
    expect(uncovered).toEqual(['STRANDED']);
  });

  it('without the faithful map, coverage falls back to presence-only (prior behaviour, fail-open)', () => {
    const covered = fastCoverageForLine(
      '* * * * * seed-signals.js --timeframe 3m --status promoted --exclude HL',
      ['WHITEBIT', 'BINANCE', 'HL'], // no faithful map passed
    );
    expect(covered).toContain('WHITEBIT'); // presence-only — WhiteBIT counted (unaware of runtime skip)
  });
});
