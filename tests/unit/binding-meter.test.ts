/**
 * Unit test for src/lib/binding-meter.ts
 * (OPS-QUOTA-BINDING-METER-AND-CONVERSION-W1 / CH1).
 *
 * `bindingMeter()` is the ONE derivation of "which meter is closest to refusing, and how close".
 * Every activation surface projects from it, so its edge cases are not academic — each one is a
 * rendered number on a caller-visible envelope:
 *
 *   - binding = the HIGHER used/limit ratio
 *   - ties resolve to `monthly` (it does not clear at 00:00 UTC — the more severe statement)
 *   - a meter with a non-finite / non-positive limit is EXCLUDED, never zeroed
 *   - both meters unmetered → `null`, which every consumer must read as "emit nothing", never "0%"
 *   - `used > limit` is a legitimate reading (ratio > 1), NOT an error
 *   - both underlying pairs travel with the binding one, so no consumer re-derives the split
 *   - LEAFNESS: this module value-imports nothing (asserted against its own source)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bindingMeter } from '../../src/lib/binding-meter.js';
import type { MeterReading } from '../../src/types.js';

const ROOT = resolve(__dirname, '..', '..');
const MONTH_RESET = 1_786_000_000_000;
const DAY_RESET = 1_785_900_000_000;

const monthly = (used: number, limit = 200): MeterReading => ({ used, limit, resetAtMs: MONTH_RESET });
const daily = (used: number, limit = 100): MeterReading => ({ used, limit, resetAtMs: DAY_RESET });

describe('bindingMeter — which meter binds', () => {
  it('binds DAILY when the daily ratio is higher (the day-1 caller this wave exists for)', () => {
    // 80/100 daily = 0.80 vs 80/200 monthly = 0.40. The monthly view says "40% used, 120 left";
    // the daily view says "you are one nudge from a wall". The second is the true one.
    const b = bindingMeter(monthly(80), daily(80));
    expect(b).not.toBeNull();
    expect(b!.binding).toBe('daily');
    expect(b!.ratio).toBeCloseTo(0.8, 10);
    expect(b!.used).toBe(80);
    expect(b!.limit).toBe(100);
    expect(b!.remaining).toBe(20);
    expect(b!.resetAtMs).toBe(DAY_RESET);
  });

  it('binds MONTHLY when the monthly ratio is higher', () => {
    const b = bindingMeter(monthly(190), daily(10));
    expect(b!.binding).toBe('monthly');
    expect(b!.ratio).toBeCloseTo(0.95, 10);
    expect(b!.used).toBe(190);
    expect(b!.limit).toBe(200);
    expect(b!.remaining).toBe(10);
    expect(b!.resetAtMs).toBe(MONTH_RESET);
  });

  it('resolves a TIE to monthly — a daily wall clears at 00:00 UTC, a monthly one does not', () => {
    // 100/200 and 50/100 are both exactly 0.50.
    const b = bindingMeter(monthly(100), daily(50));
    expect(b!.ratio).toBeCloseTo(0.5, 10);
    expect(b!.binding).toBe('monthly');
    expect(b!.resetAtMs).toBe(MONTH_RESET);
  });

  it('carries BOTH underlying pairs alongside the binding one', () => {
    // A consumer that had to re-derive the split would be a second derivation of the exact thing
    // this module exists to derive once; one handed only the binding pair could silently drop the
    // other meter from a rendered envelope, which is how the daily meter stayed invisible.
    const b = bindingMeter(monthly(80), daily(90));
    expect(b!.binding).toBe('daily');
    expect(b!.monthly).toEqual({ used: 80, limit: 200, resetAtMs: MONTH_RESET });
    expect(b!.daily).toEqual({ used: 90, limit: 100, resetAtMs: DAY_RESET });
  });

  describe('one meter only', () => {
    it('binds monthly when there is no daily meter at all', () => {
      const b = bindingMeter(monthly(150), undefined);
      expect(b!.binding).toBe('monthly');
      expect(b!.daily).toBeNull();
      expect(b!.monthly).not.toBeNull();
    });

    it('binds DAILY when there is no monthly meter — even at a LOWER absolute ratio', () => {
      // The single-meter case must not fall through to a monthly default. With only a daily meter
      // at 1%, `daily` is still the only honest answer to "what binds".
      const b = bindingMeter(null, daily(1));
      expect(b!.binding).toBe('daily');
      expect(b!.ratio).toBeCloseTo(0.01, 10);
      expect(b!.monthly).toBeNull();
      expect(b!.resetAtMs).toBe(DAY_RESET);
    });
  });

  describe('unmetered tiers are EXCLUDED, never zeroed', () => {
    it('returns null when NEITHER meter is metered', () => {
      // `used / Infinity` is 0, which would render as "0% used" — a claim about a meter that does
      // not exist. Consumers read null as "emit nothing".
      expect(bindingMeter(null, null)).toBeNull();
      expect(bindingMeter(undefined, undefined)).toBeNull();
    });

    it('excludes an Infinity limit (the x402 / internal unmetered tier)', () => {
      expect(bindingMeter({ used: 5, limit: Infinity, resetAtMs: MONTH_RESET }, null)).toBeNull();
      // ...and when the OTHER meter is real, the unmetered one is dropped rather than winning at 0.
      const b = bindingMeter({ used: 5, limit: Infinity, resetAtMs: MONTH_RESET }, daily(30));
      expect(b!.binding).toBe('daily');
      expect(b!.monthly).toBeNull();
    });

    it('excludes a zero or negative limit', () => {
      expect(bindingMeter({ used: 1, limit: 0, resetAtMs: MONTH_RESET }, null)).toBeNull();
      expect(bindingMeter({ used: 1, limit: -5, resetAtMs: MONTH_RESET }, null)).toBeNull();
    });

    it('excludes a NaN limit and a NaN / negative used (default-deny, matching computeTierWarning)', () => {
      expect(bindingMeter({ used: 1, limit: NaN, resetAtMs: MONTH_RESET }, null)).toBeNull();
      expect(bindingMeter({ used: NaN, limit: 200, resetAtMs: MONTH_RESET }, null)).toBeNull();
      expect(bindingMeter({ used: -1, limit: 200, resetAtMs: MONTH_RESET }, null)).toBeNull();
    });
  });

  describe('over the wall', () => {
    it('reports a ratio ABOVE 1 for used > limit — a legitimate reading, not an error', () => {
      // Bonus grants and multi-unit charges land a caller past the wall. Clamping the ratio to 1
      // here would make "at the wall" and "well past it" indistinguishable to every consumer.
      const b = bindingMeter(monthly(250), daily(10));
      expect(b!.binding).toBe('monthly');
      expect(b!.ratio).toBeCloseTo(1.25, 10);
      expect(b!.used).toBe(250);
    });

    it('floors `remaining` at 0 rather than reporting a negative allowance', () => {
      const b = bindingMeter(monthly(250), null);
      expect(b!.remaining).toBe(0);
    });

    it('still binds to the meter that is FURTHEST over, not merely the first over', () => {
      // monthly 210/200 = 1.05, daily 130/100 = 1.30.
      const b = bindingMeter(monthly(210), daily(130));
      expect(b!.binding).toBe('daily');
      expect(b!.ratio).toBeCloseTo(1.3, 10);
    });
  });
});

describe('bindingMeter — LEAFNESS (asserted against this module\'s own source)', () => {
  const SRC = readFileSync(resolve(ROOT, 'src', 'lib', 'binding-meter.ts'), 'utf8');
  // Import lines only — a mention inside the module docblock is not an import, and the header
  // deliberately NAMES `license.ts` and `tier-warning.ts` while explaining why it must not import
  // them. A naive whole-file grep would demand the deletion of the most valuable prose in the file.
  const IMPORT_LINES = SRC.split('\n').filter((l) => /^\s*import\b/.test(l));

  it('the import list is non-empty and was actually extracted (vacuity guard)', () => {
    // Without this, a regex that stopped matching would make every assertion below vacuously true.
    expect(SRC.length).toBeGreaterThan(0);
    expect(IMPORT_LINES.length).toBeGreaterThan(0);
  });

  it('value-imports NOTHING — every import is type-only', () => {
    const valueImports = IMPORT_LINES.filter((l) => !/^\s*import\s+type\b/.test(l));
    expect(valueImports).toEqual([]);
  });

  it('never imports license.ts or tier-warning.ts (both are CONSUMERS — that would cycle)', () => {
    const cyclic = IMPORT_LINES.filter((l) => /['"]\.\/(license|tier-warning)\.js['"]/.test(l));
    expect(cyclic).toEqual([]);
  });

  it('never imports a tool handler', () => {
    const tools = IMPORT_LINES.filter((l) => /['"]\.\.\/tools\//.test(l));
    expect(tools).toEqual([]);
  });
});
