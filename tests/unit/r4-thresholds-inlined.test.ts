/**
 * OPS-R4-RELAX-RETIRE-W1 — successor to the deleted `tests/r4-relax-flag.test.ts`.
 *
 * That file pinned the 2-flag firewall's FALLBACK (`getR4Thresholds()` returns
 * `R4_DEFAULTS` unless `ENABLE_R4_RELAX === '1'`). The firewall is gone; what needs
 * pinning now is what survived it:
 *
 *   1. the two constants are exactly the values production ran for its whole life;
 *   2. both gate branches still fire on the same side of the same boundary;
 *   3. the retired env vars are INERT — a stale prod key, or a re-added deploy append,
 *      cannot re-arm the lever, because no code reads them any more.
 *
 * (3) is the load-bearing one. The flag was never deletable by deleting its env keys:
 * two committed deploy writers re-appended them on every deploy. This test is what makes
 * the retirement structural rather than a tidy-up.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  deriveVerdict, R4_THRESHOLDS,
  type VerdictGateInputs, type VerdictScoreInputs,
} from '../../src/tools/get-trade-call.js';

const SRC = join(__dirname, '..', '..', 'src');

/** raw = -83: rsi -30, ema -10, funding -20, oi -9, volume -14. */
const BEARISH: VerdictScoreInputs = {
  rsiScore: -100, emaScore: -100, fundingScore: -80, oiScore: -60, volumeScore: -70,
};
/** raw = +89 (MAX_RAW_SCORE). */
const BULLISH: VerdictScoreInputs = {
  rsiScore: 100, emaScore: 100, fundingScore: 80, oiScore: 60, volumeScore: 100,
};

const gates = (fundingZScore: number | null): VerdictGateInputs => ({
  fundingZScore,
  fundingRateAnnualized: 0,
  hurstVal: null,
  squeezeActive: false,
  r4Thresholds: R4_THRESHOLDS,
  buyThreshold: 40,
  sellThreshold: 55,
});

describe('R4 thresholds — inlined, no longer env-resolved (OPS-R4-RELAX-RETIRE-W1)', () => {
  it('carries exactly the values production ran for its whole ~13-week life', () => {
    expect(R4_THRESHOLDS).toEqual({ buyPenaltyZ: 2.5, sellSofteningZ: -2.0 });
  });

  it('SELL softening fires below -2.0 and NOT at it', () => {
    const below = deriveVerdict(BEARISH, gates(-2.1));
    const at = deriveVerdict(BEARISH, gates(-2.0));
    expect(below.rawScore).toBe(-63); //  -83 + 20
    expect(at.rawScore).toBe(-83); //  untouched
    expect(below.scoreAdjustments.some(a => a.includes('SELL softened 20 pts'))).toBe(true);
    expect(at.scoreAdjustments.some(a => a.includes('SELL softened 20 pts'))).toBe(false);
  });

  it('BUY penalty fires above +2.5 and NOT at it', () => {
    const above = deriveVerdict(BULLISH, gates(2.6));
    const at = deriveVerdict(BULLISH, gates(2.5));
    expect(above.rawScore).toBe(69); //  89 - 20
    expect(at.rawScore).toBe(89); //  untouched
    expect(above.scoreAdjustments.some(a => a.includes('BUY penalized 20 pts'))).toBe(true);
    expect(at.scoreAdjustments.some(a => a.includes('BUY penalized 20 pts'))).toBe(false);
  });

  it('renders the boundaries into user-visible reasoning exactly as before', () => {
    // `${-2.0}` is "-2", not "-2.0" — this is the string production has emitted for 13
    // weeks, so it is part of the byte-identity claim, not cosmetic.
    expect(deriveVerdict(BEARISH, gates(-2.1)).scoreAdjustments).toContain(
      'Funding Z-Score -2.10 (<-2) — extreme short crowding. SELL softened 20 pts.',
    );
    expect(deriveVerdict(BULLISH, gates(2.6)).scoreAdjustments).toContain(
      'Funding Z-Score 2.60 (>+2.5) — extreme crowded longs. BUY penalized 20 pts.',
    );
  });

  describe('the retired env vars are INERT', () => {
    const saved = {
      enabled: process.env.ENABLE_R4_RELAX,
      direction: process.env.R4_RELAX_DIRECTION,
    };
    afterAll(() => {
      if (saved.enabled === undefined) delete process.env.ENABLE_R4_RELAX;
      else process.env.ENABLE_R4_RELAX = saved.enabled;
      if (saved.direction === undefined) delete process.env.R4_RELAX_DIRECTION;
      else process.env.R4_RELAX_DIRECTION = saved.direction;
    });

    it('setting ENABLE_R4_RELAX=1 + R4_RELAX_DIRECTION=sell-revert changes nothing', () => {
      const before = [-2.1, -2.0, 2.6, 2.5].map(z => ({
        sell: deriveVerdict(BEARISH, gates(z)),
        buy: deriveVerdict(BULLISH, gates(z)),
      }));
      process.env.ENABLE_R4_RELAX = '1';
      process.env.R4_RELAX_DIRECTION = 'sell-revert';
      const after = [-2.1, -2.0, 2.6, 2.5].map(z => ({
        sell: deriveVerdict(BEARISH, gates(z)),
        buy: deriveVerdict(BULLISH, gates(z)),
      }));
      expect(after).toEqual(before);
      expect(R4_THRESHOLDS).toEqual({ buyPenaltyZ: 2.5, sellSofteningZ: -2.0 });
    });

    it('no source file under src/ reads either variable', () => {
      // Comments are stripped first: the explanatory block above R4_THRESHOLDS names both
      // variables deliberately, and a naive ban-grep would demand deleting the most
      // valuable lines in that file.
      const offenders: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
          const p = join(dir, entry);
          if (statSync(p).isDirectory()) { walk(p); continue; }
          if (!/\.(ts|mts|cts|js|mjs)$/.test(entry)) continue;
          const code = readFileSync(p, 'utf8')
            .split('\n')
            .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
            .join('\n');
          if (/ENABLE_R4_RELAX|R4_RELAX_DIRECTION|r4-relax-flag/.test(code)) offenders.push(p);
        }
      };
      walk(SRC);
      expect(offenders).toEqual([]);
    });

    it('the ban-scan can actually fail (proves the previous assertion is not vacuous)', () => {
      const stripped = (body: string) =>
        body.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      // a real read is caught…
      expect(/ENABLE_R4_RELAX/.test(stripped("const x = process.env.ENABLE_R4_RELAX;"))).toBe(true);
      // …and a comment naming it is not.
      expect(/ENABLE_R4_RELAX/.test(stripped('// ENABLE_R4_RELAX was retired here'))).toBe(false);
    });
  });
});
