/**
 * rounding.ts — SR-ZONES-W2 §0.1. The one outward-rounding helper for served price levels.
 *
 * One step per call, from the response's price: sig = 10^(floor(log10(price)) − 3), four significant figures. With the
 * venue tick t known, step = t × ceil(sig / t); otherwise step = sig. A level's low edge rounds down and its high edge
 * up to a multiple of the step, so a served level always contains the computed one and moves by less than one step.
 *
 * The arithmetic is exact decimal arithmetic on BigInt (a value is int × 10^exp, read from the number's shortest
 * round-trip digits), never a float division: 1.15 / 0.05 is 22.999999999999996 in floats, and a float floor there
 * drops a whole step. So an emitted number carries no float noise and has no more decimals than its step.
 *
 * These helpers move only the edges; callers round at the point they emit, once. What a response then reads from the
 * served edges (the distance and "inside", R7 #3) is served.ts's: rank, side, state, overlaps and the rest stay
 * computed on the unrounded level (§0.2).
 */

/** A decimal value: int × 10^exp. */
interface Decimal {
  readonly int: bigint;
  readonly exp: number;
}

/** A positive rounding step, as an exact decimal and as the number a response carries. */
export interface LevelStep {
  readonly value: number;
  readonly int: bigint;
  readonly exp: number;
}

const pow10 = (n: number): bigint => 10n ** BigInt(n);

/** A finite number's shortest round-trip digits as an exact decimal (String() may use exponent form). */
function toDecimal(x: number): Decimal {
  const [mantissa, e = '0'] = String(x).split('e');
  const negative = mantissa.startsWith('-');
  const [whole, frac = ''] = (negative ? mantissa.slice(1) : mantissa).split('.');
  const digits = BigInt(whole + frac);
  return { int: negative ? -digits : digits, exp: Number(e) - frac.length };
}

/** Plain decimal digits: no exponent, no trailing zeros after the point. */
function decimalString(d: Decimal): string {
  const negative = d.int < 0n;
  const digits = (negative ? -d.int : d.int).toString();
  let s: string;
  if (d.exp >= 0) {
    s = digits + '0'.repeat(d.exp);
  } else {
    const padded = digits.padStart(-d.exp + 1, '0');
    const point = padded.length + d.exp;
    s = `${padded.slice(0, point)}.${padded.slice(point)}`.replace(/\.?0+$/, '');
  }
  return negative && s !== '0' ? `-${s}` : s;
}

function normalize(d: Decimal): Decimal {
  let { int, exp } = d;
  while (int !== 0n && int % 10n === 0n) {
    int /= 10n;
    exp += 1;
  }
  return { int, exp };
}

function stepOf(d: Decimal): LevelStep {
  const n = normalize(d);
  return { value: Number(decimalString(n)), int: n.int, exp: n.exp };
}

const usable = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0;

/**
 * The step for every level of one response, from its price and, when known, the venue's price tick. Null when the price
 * is not a positive finite number (nothing to round to); an unusable tick is treated as unknown.
 */
export function priceLevelStep(price: number, tick: number | null | undefined): LevelStep | null {
  if (!usable(price)) return null;
  // floor(log10(price)) from the exponent of the shortest digits: exact at powers of ten, where Math.log10 can miss.
  const sig: Decimal = { int: 1n, exp: Number(price.toExponential().split('e')[1]) - 3 };
  if (!usable(tick)) return stepOf(sig);
  const t = toDecimal(tick);
  const e = Math.min(sig.exp, t.exp);
  const sigInt = sig.int * pow10(sig.exp - e);
  const tickInt = t.int * pow10(t.exp - e);
  const times = (sigInt + tickInt - 1n) / tickInt; // ceil(sig / t), both positive
  return stepOf({ int: t.int * times, exp: t.exp });
}

function roundTo(x: number, step: LevelStep, up: boolean): number {
  if (!Number.isFinite(x)) return x;
  const d = toDecimal(x);
  const e = Math.min(d.exp, step.exp);
  const xInt = d.int * pow10(d.exp - e);
  const stepInt = step.int * pow10(step.exp - e);
  let q = xInt / stepInt; // truncates toward zero
  if (xInt % stepInt !== 0n) {
    if (up && xInt > 0n) q += 1n;
    if (!up && xInt < 0n) q -= 1n;
  }
  return Number(decimalString({ int: q * step.int, exp: step.exp }));
}

/** The largest multiple of the step at or below x. */
export function roundLevelDown(x: number, step: LevelStep): number {
  return roundTo(x, step, false);
}

/** The smallest multiple of the step at or above x. */
export function roundLevelUp(x: number, step: LevelStep): number {
  return roundTo(x, step, true);
}

/** A served level as plain decimal digits (no exponent), for text that prints it. */
export function formatLevel(x: number): string {
  return Number.isFinite(x) ? decimalString(toDecimal(x)) : String(x);
}

/** The level with its low edge rounded down and its high edge up; every other field, and key order, as given. */
export function roundZoneOutward<Z extends { low: number; high: number }>(zone: Z, step: LevelStep | null): Z {
  if (step === null) return zone;
  return { ...zone, low: roundLevelDown(zone.low, step), high: roundLevelUp(zone.high, step) };
}
