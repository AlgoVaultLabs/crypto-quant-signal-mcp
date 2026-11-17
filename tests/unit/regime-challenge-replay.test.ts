// tests/unit/regime-challenge-replay.test.ts — EDGE-REGIME-CHALLENGE-R1-W1 CH1: the challenger replays
// (AC1.1 parity: at the served value a challenger is the served rule, label for label, on T3's core-parity fixture
// and on synthetic series; AC1.2: break C1's copy → red). Nothing here reads an archive.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { L_DOWN, L_UP, NO_LABEL } from '../../src/scripts/regime-diag/diag-spec.js';
import { buildFrames, parseCensus, type Frame } from '../../src/scripts/regime-diag/frame.js';
import { PARITY_FIXTURE } from '../../src/scripts/regime-diag/parity.js';
import { CANDIDATES, SERVED_DIAL, dialRefusal, type Dial } from '../../src/scripts/regime-challenge/challenge-spec.js';
import * as replay from '../../src/scripts/regime-challenge/challenger-replay.js';
import { SYN_CENSUS_TEXT, SYN_HOLD, SYN_SPAN, synFullLoad } from '../fixtures/regime-challenge/synth-challenge.js';

const REPO = path.resolve(__dirname, '../..');
const FIXTURE = fs.readFileSync(path.join(REPO, PARITY_FIXTURE), 'utf8');
const dialOf = (id: string): Dial => CANDIDATES.find((c) => c.id === id)?.dial as Dial;
const C1_7 = dialOf('C1.7'), C1_10 = dialOf('C1.10'), C2 = dialOf('C2');
const trending = (l: number): boolean => l === L_UP || l === L_DOWN;
// One setImmediate per test lets the worker answer vitest between long synchronous tests (the measurement behind
// this hook is in tests/unit/regime-diag-guard.test.ts).
afterEach(() => new Promise<void>((done) => { setImmediate(done); }));

async function mutated<T>(lever: string, fn: (m: typeof replay) => T): Promise<T> {
  process.env.REGIME_DIAG_MUTATE = lever;
  vi.resetModules();
  try {
    return fn(await import('../../src/scripts/regime-challenge/challenger-replay.js'));
  } finally {
    delete process.env.REGIME_DIAG_MUTATE;
    vi.resetModules();
  }
}

/** The parity the guard of a run asks for: the copy at the served period answers every fixture call as the core did. */
const parityHolds = (m: typeof replay): void => {
  const r = m.checkChallengerParity(FIXTURE);
  expect([r.ok, r.mismatches, r.reason]).toEqual([true, 0, 'ok']);
  expect(r.calls).toBe(70);
};

describe('regime-challenge: a challenger at the served value is the served rule', () => {
  let f: Frame, cols: replay.ChallengerCols;
  beforeAll(() => {
    f = buildFrames(SYN_SPAN, [SYN_HOLD], parseCensus(SYN_CENSUS_TEXT), synFullLoad, { outcomes: false, seed: 'challenge-replay-test' })[0];
    cols = replay.challengerColumns(f, synFullLoad, [SERVED_DIAL, C1_7, C1_10, C2]);
  }, 300_000);

  it('AC1.1 parity on T3\'s core-parity fixture: every call, label and confidence', { timeout: 60_000 }, () => {
    parityHolds(replay);
  });

  it('a fixture the copy disagrees with, or one that holds no call, is not parity', { timeout: 60_000 }, () => {
    const moved = replay.checkChallengerParity(FIXTURE.replace(/"confidence": (\d+)/, (_, c: string) => `"confidence": ${Number(c) + 1}`));
    expect([moved.ok, moved.mismatches]).toEqual([false, 1]);
    expect(moved.reason).toMatch(/differs from the served rule on 1 of 70 fixture calls/);
    const empty = replay.checkChallengerParity(JSON.stringify({ ...JSON.parse(FIXTURE), calls: [] }));
    expect([empty.ok, empty.calls]).toEqual([false, 0]);
    expect(empty.reason).toMatch(/holds no call to replay/);
    expect(replay.checkChallengerParity('not json').ok).toBe(false);
  });

  it('AC1.2 break C1\'s copy → red; restored, green', { timeout: 60_000 }, async () => {
    await expect(mutated('c1copy', (m) => parityHolds(m))).rejects.toThrow(/to deeply equal/);
    parityHolds(replay);
  });

  it('AC1.1 parity on a synthetic series: C1 at period 14 is the served column, row for row and close for close', { timeout: 60_000 }, () => {
    const lab = cols.labs[0];
    let rows = 0, trend = 0;
    for (let r = 0; r < f.has.length; r++) {
      if (!f.has[r]) { expect(lab.lab[r]).toBe(NO_LABEL); continue; }
      rows++;
      if (trending(f.S.lab[r])) trend++;
      if (lab.lab[r] !== f.S.lab[r] || lab.conf[r] !== f.S.conf[r]) throw new Error(`row ${r}: the copy reads ${lab.lab[r]}/${lab.conf[r]}, the served rule ${f.S.lab[r]}/${f.S.conf[r]}`);
    }
    expect(rows).toBeGreaterThan(1000);
    expect(trend).toBeGreaterThan(100);
    // the per-closed-bar series: every close of the window the served series has, with the same label and confidence
    let closes = 0;
    f.coins.forEach((c, i) => c.series.forEach((s, t) => {
      const q = cols.series[0][i][t];
      for (let j = 1; j <= s.nb; j++) {
        const inside = j * s.tf.min >= f.win.lo && j * s.tf.min < f.win.hi;
        if (!inside || !s.ok[j]) { expect(q.ok[j]).toBe(0); continue; }
        closes++;
        if (!q.ok[j] || q.label[j] !== s.label[j] || q.conf[j] !== s.conf[j]) throw new Error(`${s.tf.key} close ${j}: the copy differs from the served series`);
      }
      // the close and the volatility ratio are the served series' own: no dial of this round changes them
      expect(q.close).toBe(s.close);
      expect(q.vol).toBe(s.vol);
    }));
    expect(closes).toBeGreaterThan(1000);
    expect(cols.calls).toBe(rows + closes);
  });

  it('C1 at 7 and at 10 is another rule: the dial moves labels, and only where the ADX is read', { timeout: 60_000 }, () => {
    for (const d of [1, 2]) {
      let differs = 0;
      for (let r = 0; r < f.has.length; r++) if (f.has[r] && (cols.labs[d].lab[r] !== f.S.lab[r] || cols.labs[d].conf[r] !== f.S.conf[r])) differs++;
      expect(differs).toBeGreaterThan(100);
    }
  });

  it('AC1.1 parity, C2: the served rule where the structure is neither HIGHER_HIGHS nor LOWER_LOWS; elsewhere only the direction differs', { timeout: 60_000 }, () => {
    const lab = cols.labs[3];
    let neutral = 0, structured = 0, flipped = 0;
    for (let r = 0; r < f.has.length; r++) {
      if (!f.has[r]) continue;
      const same = lab.lab[r] === f.S.lab[r] && lab.conf[r] === f.S.conf[r];
      if (f.structure[r] === 0) {
        neutral++;
        if (!same) throw new Error(`row ${r}: C2 differs from the served rule on a row with no price structure`);
        continue;
      }
      structured++;
      if (same) continue;
      // the one difference allowed: a TRENDING row whose side ±DI reads the other way — or, on an exact ±DI tie,
      // the core's own non-trending branch (MARKET-REGIME-DIRECTION-SYMMETRY-W1)
      if (!trending(f.S.lab[r])) throw new Error(`row ${r}: C2 differs on a row the served rule does not call TRENDING`);
      if (trending(lab.lab[r])) {
        expect(lab.conf[r]).toBe(f.S.conf[r]);
        expect(lab.lab[r]).toBe(f.plusDI[r] > f.minusDI[r] ? L_UP : L_DOWN);
        flipped++;
      } else expect(f.plusDI[r]).toBe(f.minusDI[r]);
    }
    expect(neutral).toBeGreaterThan(100);
    expect(structured).toBeGreaterThan(100);
    expect(flipped).toBeGreaterThan(0);
  });

  it('a challenger changes one dial: a rule that changes two is refused', { timeout: 60_000 }, () => {
    for (const c of CANDIDATES) if (c.dial) expect(dialRefusal(c.dial)).toBeNull();
    const two: Dial = { adxPeriod: 7, direction: 'di' };
    expect(dialRefusal(two)).toMatch(/changes one dial/);
    expect(() => replay.verdictOf([], 100, two)).toThrow(/changes one dial/);
  });
});
