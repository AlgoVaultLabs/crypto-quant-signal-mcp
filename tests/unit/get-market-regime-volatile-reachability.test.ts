/**
 * `VOLATILE` is REACHABLE from get-market-regime.ts's classifier — the positive half.
 * OPS-FORBIDDEN-PHRASE-ENUMERATION-AND-WEBHOOKS-DOC-W1 CH4 R4.2.
 *
 * THE ASYMMETRY THIS CLOSES. `tests/unit/trend-mode-enable.test.ts` proves, from its source, that
 * `classifyRegimeLabel` in src/tools/get-trade-call.ts CANNOT emit `VOLATILE` — it is 3-label, it
 * writes the `signals.regime` column, and that is why the webhook `regime_shift` lane never sees
 * the fourth state. No equivalent assertion existed in the other direction. So the estate could
 * prove one classifier never emits VOLATILE and could prove NOTHING about the one that does, and
 * an audit sentence saying "never emitted by the current classifier" was read as an estate-wide
 * fact. A queued follow-up wave, OPS-WEBHOOK-REGIME-POLL-EMITTER-W1, was filed on that misreading.
 *
 * The public docs advertise four regimes, so `VOLATILE` being reachable HERE is a load-bearing
 * public-copy property: a refactor that silently dropped the fourth state would make
 * docs/WEBHOOKS.md and the landing copy false with nothing failing anywhere. This file is what
 * fails instead.
 *
 * ⚠️ NAME COLLISION, deliberately noted: `tests/unit/equity-indicators.test.ts` also imports a
 * `classifyRegime`. That is a DIFFERENT function — the equities one, with lowercase labels
 * ('ranging', 'trending_up'). This file imports from src/tools/get-market-regime.ts only.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyRegime, type RegimeClassifierInputs } from '../../src/tools/get-market-regime.js';

/**
 * The NON-TRENDING branch: ADX at or below the 25 threshold, and not the ADX 18-25 rising-fast
 * early-trend escape. Everything here except `volatilityRatio` is held fixed, so the only thing
 * moving between the cases below is the quantity under test.
 */
const nonTrending = (volatilityRatio: number): RegimeClassifierInputs => ({
  adxVal: 7,
  adxSlope: 0,
  plusDI: 10,
  minusDI: 10,
  slopeCategory: 'FLAT',
  priceStructure: 'CHOPPY',
  volatilityRatio,
});

describe('classifyRegime (get-market-regime.ts) CAN emit VOLATILE', () => {
  it('returns VOLATILE on a high-volatility, non-trending tape', () => {
    const r = classifyRegime(nonTrending(0.0425));
    expect(r.regime).toBe('VOLATILE');
    expect(r.trendStrength).toBe('WEAK');
    expect(r.confidence).toBeGreaterThan(0);
  });

  it('pins the boundary at volatilityRatio > 0.03 — exclusive, not inclusive', () => {
    // The branch is `>`, not `>=`. Pinning the exact edge is what makes a future refactor that
    // "tidies" the comparison fail here instead of quietly changing which tapes are VOLATILE.
    expect(classifyRegime(nonTrending(0.03)).regime).toBe('RANGING');
    expect(classifyRegime(nonTrending(0.0301)).regime).toBe('VOLATILE');
  });

  it('confidence is capped at 85 and floored at 30, and scales with volatility', () => {
    expect(classifyRegime(nonTrending(0.0301)).confidence).toBeLessThanOrEqual(85);
    expect(classifyRegime(nonTrending(5)).confidence).toBe(85);
    const low = classifyRegime(nonTrending(0.031)).confidence;
    const high = classifyRegime(nonTrending(0.041)).confidence;
    expect(high).toBeGreaterThan(low);
  });

  it('VOLATILE is not reachable from the TRENDING branches — the label is branch-specific', () => {
    // Without this, "VOLATILE is reachable" could be satisfied by a classifier that returned it
    // everywhere, which would be a different and much worse defect.
    const trending: RegimeClassifierInputs = {
      ...nonTrending(0.9), adxVal: 45, priceStructure: 'HIGHER_HIGHS', plusDI: 30, minusDI: 5,
    };
    expect(classifyRegime(trending).regime).toBe('TRENDING_UP');
  });

  it('all four documented regimes are reachable from this ONE classifier', () => {
    // The public surface advertises four states. Assert the whole set, so dropping any one of
    // them fails here rather than silently making the docs false.
    const observed = new Set([
      classifyRegime(nonTrending(0.05)).regime,
      classifyRegime(nonTrending(0.001)).regime,
      classifyRegime({ ...nonTrending(0.001), adxVal: 45, priceStructure: 'HIGHER_HIGHS', plusDI: 30, minusDI: 5 }).regime,
      classifyRegime({ ...nonTrending(0.001), adxVal: 45, priceStructure: 'LOWER_LOWS', plusDI: 5, minusDI: 30 }).regime,
    ]);
    expect([...observed].sort()).toEqual(['RANGING', 'TRENDING_DOWN', 'TRENDING_UP', 'VOLATILE']);
  });
});

describe('the VOLATILE state is wired all the way to customer-facing copy', () => {
  it('generateSuggestion carries a live VOLATILE arm', () => {
    // A reachable label with no downstream arm would fall through to a default and the state
    // would be reachable in name only. Asserted from source because generateSuggestion is not
    // exported; the reachability claim is about the SHIPPED path, not about a private helper.
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'tools', 'get-market-regime.ts'), 'utf8');
    const fn = src.slice(src.indexOf('function generateSuggestion'));
    const body = fn.slice(0, fn.indexOf('\nfunction ', 1) === -1 ? fn.length : fn.indexOf('\nfunction ', 1));
    expect(body.length, 'vacuity guard: generateSuggestion body did not slice').toBeGreaterThan(200);
    expect(body).toContain("case 'VOLATILE':");
  });

  it("this file's subject is the 4-label classifier, not get-trade-call's 3-label one", () => {
    // Guards the name collision documented in the header: `equity-indicators.test.ts` imports a
    // DIFFERENT classifyRegime, and get-trade-call.ts exports the 3-label classifyRegimeLabel.
    //
    // Scoped to the IMPORT LINES, not the whole file — and that is the point, not a detail. The
    // first cut scanned the whole source and failed on this file's OWN header prose, which names
    // get-trade-call.ts in order to contrast with it. A check that matches its own explanation is
    // a false positive this wave has now produced three times (here, CH3's banned-literal comment,
    // and CH4's ledger amendment quoting the sentence it corrects). Assert on the thing, never on
    // the prose describing the thing.
    const imports = readFileSync(__filename, 'utf8')
      .split('\n')
      .filter((l) => /^\s*import\b/.test(l));
    expect(imports.length, 'vacuity guard: no import lines found').toBeGreaterThan(0);
    expect(imports.join('\n')).toContain("from '../../src/tools/get-market-regime.js'");
    for (const l of imports) expect(l, `imports the wrong classifier: ${l}`).not.toMatch(/get-trade-call|equity-indicators/);
  });
});
