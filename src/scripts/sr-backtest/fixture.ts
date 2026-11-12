// sr-backtest/fixture.ts — EDGE-SR-LEVEL-BACKTEST-W1: the parity fixture, ops/sr-level-parity-fixture.json.
//
// The level-check tool (T2) must serve exactly zone rule Z1. This file is the contract: 200 seeded windows per
// timeframe, each one a seeded synthetic candle history (synth.ts — integer arithmetic, the same bars on every
// platform), an instant, a price and one to three chosen timeframes, with the zones `levelCheck` (zones.ts) serves
// for it. A window carries the generator's inputs and the sha256 of the bars it must produce, never the bars.
//
// A zone is the array [lo, hi, touches, label, round, rank, superStrong, agree]:
//   label W | M | S · round 0 | 1 · rank 1 = nearest · superStrong NONE | PAIR | TRIPLE · agree = the timeframes
//   that hold an overlapping qualifying zone.
import { BT, DAY, M15, TIMEFRAMES, rngOf, tfOf } from './spec.js';
import { sha256 } from './store.js';
import { priceAt } from './engine.js';
import { synthCoin } from './synth.js';
import { levelCheck, type ServedZone } from './zones.js';

export const FIXTURE_PATH = 'ops/sr-level-parity-fixture.json';
export const FIXTURE = Object.freeze({
  windowsPerTimeframe: 200,
  seed: 20261112,
  firstMs: Date.UTC(2022, 0, 1),
  /** History before the instant, in bars of the widest chosen timeframe: seeded in [minBars, maxBars]. */
  minBars: 40,
  maxBars: 320,
  /** Start prices, by window index: around a round number, far from one, and across magnitudes. */
  startPrices: Object.freeze([5_000_000, 1_000_000, 2_503_000, 998_500, 10_020_000]),
});

export interface FixtureWindow {
  id: string;
  /** The chosen timeframes; the first is the window's own. */
  frames: string[];
  walk: { seed: number; key: string; firstMs: number; bars: number; startPrice: number };
  instantMs: number;
  price: number;
  /** sha256 of JSON.stringify of the 15-minute bars as [openMs, open, high, low, close]. */
  barsSha256: string;
  out: Array<{ key: string; atr: number | null; supports: unknown[]; resistances: unknown[]; at: unknown[] }>;
}

const row = (z: ServedZone): unknown[] => [z.lo, z.hi, z.touches, z.label[0], z.round ? 1 : 0, z.rank, z.superStrong, z.agree];

export function fixtureWindow(tfKey: string, i: number): FixtureWindow {
  const own = TIMEFRAMES.findIndex((t) => t.key === tfKey);
  // One, two or three chosen timeframes in turn: the window's own, then its neighbours.
  const chosen = [own, (own + 1) % TIMEFRAMES.length, (own + 2) % TIMEFRAMES.length].slice(0, 1 + (i % 3)).map((k) => TIMEFRAMES[k]);
  const widest = chosen.reduce((a, b) => (b.units > a.units ? b : a));
  const key = `fixture|${tfKey}|${i}`;
  const rnd = rngOf(FIXTURE.seed, key);
  const history = FIXTURE.minBars + Math.floor(rnd() * (FIXTURE.maxBars - FIXTURE.minBars + 1));
  // A whole number of days of 15-minute bars, then an instant at a seeded position of the last day.
  const days = Math.ceil((history * widest.stepMs) / DAY) + 1;
  const bars = days * 96;
  const startPrice = FIXTURE.startPrices[i % FIXTURE.startPrices.length];
  const walk = { seed: FIXTURE.seed, key, firstMs: FIXTURE.firstMs, bars, startPrice };
  const coin = synthCoin(key, walk);
  const instantMs = FIXTURE.firstMs + (bars - Math.floor(rnd() * 96)) * M15;
  const base = coin.frames['15m'];
  const price = priceAt(base, instantMs);
  const served = levelCheck({ price, instantMs, frames: chosen.map((t) => ({ key: t.key, stepMs: tfOf(t.key).stepMs, bars: coin.frames[t.key] })) }, BT);
  return {
    id: `${tfKey}-${String(i).padStart(3, '0')}`,
    frames: chosen.map((t) => t.key),
    walk,
    instantMs,
    price,
    barsSha256: sha256(JSON.stringify(base.map((b) => [b.time, b.open, b.high, b.low, b.close]))),
    out: served.map((f) => ({ key: f.key, atr: f.atr, supports: f.supports.map(row), resistances: f.resistances.map(row), at: f.at.map(row) })),
  };
}

/** The fixture file's exact text: a header, then one window per line. */
export function fixtureText(): string {
  const head = {
    wave: 'EDGE-SR-LEVEL-BACKTEST-W1',
    rule: 'Z1',
    module: 'src/scripts/sr-backtest/zones.ts#levelCheck',
    generator: 'src/scripts/sr-backtest/synth.ts#synthCoin(key, walk) — the 15-minute walk and its UTC-aligned 1h / 4h / 1d aggregates',
    zone: ['lo', 'hi', 'touches', 'label', 'round', 'rank', 'superStrong', 'agree'],
    params: {
      lookbackBars: BT.v0.lookbackBars, pivotK: BT.v0.pivotK, atrPeriod: BT.v0.atrPeriod, mergeAtrMult: BT.v0.mergeAtrMult, minTouches: BT.v0.minTouches,
      minWidthAtr: BT.minWidthAtr, maxServed: BT.maxServed, mediumTouches: BT.mediumTouches, strongTouches: BT.strongTouches,
    },
    windowsPerTimeframe: FIXTURE.windowsPerTimeframe,
  };
  const lines: string[] = [];
  for (const tf of TIMEFRAMES) for (let i = 0; i < FIXTURE.windowsPerTimeframe; i++) lines.push(JSON.stringify(fixtureWindow(tf.key, i)));
  return `{"header":${JSON.stringify(head)},\n"windows":[\n${lines.join(',\n')}\n]}\n`;
}
