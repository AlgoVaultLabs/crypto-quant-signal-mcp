// tests/fixtures/regime-forward/synth.ts — synthetic venues for the EDGE-REGIME-FORWARD-W1 harness tests.
//
// Prices: a log-sine of 24 bars a cycle per coin × timeframe (each coin shifted), with a little deterministic noise,
// on the venue's own grid. Labels: the key-A phase of the bar a close ends (`agree`), its opposite (`oppose`), or
// TRENDING_UP everywhere (`up`). Nothing here is a production figure or a coin name.
import { createHash } from 'node:crypto';
import type { Candle } from '../../../src/types.js';
import type { Bars } from '../../../src/scripts/regime-diag/archive.js';
import { buildKeyA } from '../../../src/scripts/regime-diag/keys.js';
import { mulberry32 } from '../../../src/scripts/regime-diag/rng.js';
import { L_DOWN, L_RANGING, L_UP } from '../../../src/scripts/regime-diag/diag-spec.js';
import { SNAP_COLS, TFS, inWindow, keyWin, originMs, tfMs, windowEndMs, W0_MS, HISTORY_BARS, type Venue } from '../../../src/scripts/regime-forward/forward-spec.js';
import { PRIOR_LOOK_SHA256, type SnapRow } from '../../../src/scripts/regime-forward/snapshot.js';

export type Mode = 'agree' | 'oppose' | 'up';
/**
 * The one generator of coin tokens in this wave's tests and fixtures (re-check R6, review RV1): the reserved form
 * `T5Q<3 digits>Z`, which no venue lists. The R6 check refuses any other coin-like literal in the tests.
 */
export const SYNTH_COIN_FORM = /^T5Q[0-9]{3}Z$/;
export function synthCoin(i: number): string {
  if (!Number.isInteger(i) || i < 0 || i > 999) throw new Error(`synthCoin: ${i} is not 0..999`);
  return `T5Q${String(i).padStart(3, '0')}Z`;
}
export const SYNTH_COINS: readonly string[] = Object.freeze([1, 2, 3, 4].map(synthCoin));
/** The census-panel coin of a test world. */
export const SYNTH_PANEL = synthCoin(900);
const PERIOD = 24;

/** Bars of one coin × timeframe from the venue origin to W1 + 14 bars, every bar full. */
export function synthBars(v: Venue, t: number, pos: number): Bars {
  const tf = TFS[t], I = tfMs(tf), nb = Math.ceil((windowEndMs(tf) - originMs(v)) / I);
  const rnd = mulberry32(1000 * (pos + 1) + t), f = (): Float64Array => new Float64Array(nb);
  const b: Bars = { min: tf.min, nb, O: f(), H: f(), L: f(), C: f(), V: f(), cnt: new Int32Array(nb) };
  let prev = 100;
  for (let k = 0; k < nb; k++) {
    const c = 100 * Math.exp(0.12 * Math.sin((2 * Math.PI * (k + 5 * pos)) / PERIOD) + 0.004 * (rnd() - 0.5));
    b.O[k] = prev; b.C[k] = c; b.H[k] = Math.max(prev, c) * 1.001; b.L[k] = Math.min(prev, c) * 0.999; b.V[k] = 1; b.cnt[k] = tf.min;
    prev = c;
  }
  return b;
}

export const candlesOf = (v: Venue, t: number, b: Bars): Candle[] =>
  Array.from({ length: b.nb }, (_, k) => ({ time: originMs(v) + k * tfMs(TFS[t]), open: b.O[k], high: b.H[k], low: b.L[k], close: b.C[k], volume: b.V[k] }));

/** The served rows of one coin × timeframe: a label at every close inside the window and its look-ahead. */
export function synthRows(v: Venue, t: number, coin: string, b: Bars, mode: Mode): SnapRow[] {
  const tf = TFS[t], I = tfMs(tf), ka = buildKeyA(b, tf, keyWin(v, tf)), rows: SnapRow[] = [];
  for (let j = 1; j <= b.nb; j++) {
    const bar = originMs(v) + j * I;
    if (!inWindow(tf, bar)) continue;
    const ph = ka.phase[j - 1];
    const agree = ph === 1 ? L_UP : ph === 2 ? L_DOWN : L_RANGING;
    const label = mode === 'up' ? L_UP : mode === 'agree' ? agree : agree === L_UP ? L_DOWN : agree === L_DOWN ? L_UP : L_RANGING;
    rows.push({ venue: v, t, coin, bar, label, conf: 40 + (j % 50), vol: 1 });
  }
  return rows;
}

const LABEL_NAMES = ['RANGING', 'TRENDING_UP', 'TRENDING_DOWN', 'VOLATILE'];

/** One snapshot line in the host read's column order; `at` is its `computed_at` (a seam's world passes SEAM_MARK). */
export function snapLine(r: { venue: string; tf: string; coin: string; bar: number; label: number; conf: number; rv?: number; at?: string }): string {
  const f: Record<(typeof SNAP_COLS)[number], string | number> = {
    exchange: r.venue, timeframe: r.tf, coin: r.coin, bar_close_ms: r.bar, regime: LABEL_NAMES[r.label], confidence: r.conf, trend_strength: 0, adx: 20,
    adx_slope: 0, volatility_ratio: 1, price_structure: 'x', regime_since_ms: r.bar, rule_version: r.rv ?? 2, computed_at: r.at ?? String(r.bar + 60_000),
  };
  return SNAP_COLS.map((c) => f[c]).join('|');
}

/** Key A's history start for a timeframe: the first bar T5 may ask for. */
export const historyStart = (t: number): number => W0_MS - HISTORY_BARS * tfMs(TFS[t]);

/**
 * A synthetic served tree at the served files' paths (review RV1): the four symbol functions, the maps they read, a
 * map they do not, a relative import and σ_bar's constant — built here in the generator's tokens, never read from a
 * checkout, so no test of this wave asserts on a file another wave edits.
 */
export function synthServedTree(): Record<string, string> {
  const [a, b, c, d] = [synthCoin(11), synthCoin(12), synthCoin(13), synthCoin(14)];
  return {
    'src/lib/adapters/binance.ts': [
      `const INTERVAL_MAP: Record<string, string> = { '1h': '1h', '4h': '4h', '1d': '1d' };`,
      `const SYMBOL_OVERRIDES: Record<string, string> = {\n  ${a}: '1000${a}',\n};`,
      `const TRADFI_ALIASES: Record<string, string> = {\n  ${b}: '${c}',\n};`,
      `export function toBinanceSymbol(coin: string): string {\n  const mapped = SYMBOL_OVERRIDES[coin] ?? TRADFI_ALIASES[coin] ?? coin;\n  return mapped + 'USDT';\n}`,
      `export function intervalOf(tf: string): string {\n  return INTERVAL_MAP[tf];\n}`,
    ].join('\n\n') + '\n',
    'src/lib/adapters/bybit.ts': `export function toBybitSymbol(coin: string): string {\n  return coin + 'USDT';\n}\n`,
    'src/lib/adapters/okx.ts': [
      `import { SWAP_SUFFIX } from './suffix.js';`,
      `const TRADFI_ALIASES: Record<string, string> = {\n  ${d}: '${c}',\n};`,
      'export function toOKXInstId(coin: string): string {\n  return `${TRADFI_ALIASES[coin] ?? coin}-${SWAP_SUFFIX}`;\n}',
    ].join('\n\n') + '\n',
    'src/lib/adapters/suffix.ts': `export const SWAP_SUFFIX = 'USDT-SWAP';\n`,
    'src/lib/adapters/bitget.ts': `export function toBitgetSymbol(coin: string): string {\n  return coin + 'USDT';\n}\n`,
    'src/lib/pre-trade-calc.ts': `export const ATR_RANGE_PER_SIGMA = Math.sqrt(8 / Math.PI);\n\nexport function unrelated(): number {\n  return 1;\n}\n`,
  };
}

/**
 * The one symbol §3 drops as `prior_look` (registration §2 E12), recovered from its registered sha256 over the
 * three-letter names: the repository never holds it as a literal.
 */
export function priorLookSymbol(): string {
  const A = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
  for (const x of A) for (const y of A) for (const z of A) if (createHash('sha256').update(x + y + z).digest('hex') === PRIOR_LOOK_SHA256) return x + y + z;
  throw new Error('priorLookSymbol: no three-letter name hashes to the registered sha256');
}
