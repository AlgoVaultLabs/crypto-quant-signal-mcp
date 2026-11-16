// regime-diag/synth.ts — EDGE-REGIME-DIAG-W1: synthetic 1 m series for the harness tests. No real market data.
//
// A seeded log walk through named segments (drift and volatility per minute), written as venue-format kline rows,
// and a single-member zip writer so a test can build the archive files the harness reads.
import { deflateRawSync } from 'node:zlib';
import { emptyGrid, finishGrid, putCsv, type Grid } from './archive.js';
import { rngFor } from './rng.js';
import { MIN_MS, type Span, type Win } from './diag-spec.js';

/** Per-minute log drift and log volatility, held for `minutes`. */
export interface Segment { minutes: number; drift: number; vol: number }

/** Segments that visit every label at the 1h timeframe: a rise, a quiet range, a fall, a violent range. */
export const SEGMENTS: readonly Segment[] = Object.freeze([
  { minutes: 6 * 1440, drift: 0.00004, vol: 0.0006 },
  { minutes: 5 * 1440, drift: 0, vol: 0.0004 },
  { minutes: 6 * 1440, drift: -0.00004, vol: 0.0006 },
  { minutes: 4 * 1440, drift: 0, vol: 0.006 },
]);

/** Venue-format kline rows (open time in ms) for grid minutes [from, to); `holes` are minutes left out. */
export function synthCsv(span: Span, key: string, opts: { segments?: readonly Segment[]; from?: number; to?: number; holes?: ReadonlySet<number>; p0?: number } = {}): string {
  const segs = opts.segments ?? SEGMENTS;
  const from = opts.from ?? 0;
  const to = opts.to ?? span.n;
  const rnd = rngFor(`synth|${key}`);
  const gauss = (): number => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  const lines: string[] = [];
  let lp = Math.log(opts.p0 ?? 100);
  let si = 0, left = segs[0].minutes;
  // The walk always starts at grid minute 0, so a slice [from, to) is the same series as the whole.
  for (let i = 0; i < to; i++) {
    if (left === 0) { si = (si + 1) % segs.length; left = segs[si].minutes; }
    left--;
    const s = segs[si];
    const o = Math.exp(lp);
    lp += s.drift + s.vol * gauss();
    const c = Math.exp(lp);
    const hi = Math.max(o, c) * (1 + Math.abs(gauss()) * s.vol * 0.4);
    const lo = Math.min(o, c) * (1 - Math.abs(gauss()) * s.vol * 0.4);
    const v = 1 + rnd() * 9;
    if (i < from || opts.holes?.has(i)) continue;
    const t = span.t0Ms + i * MIN_MS;
    lines.push(`${t},${o.toFixed(8)},${hi.toFixed(8)},${lo.toFixed(8)},${c.toFixed(8)},${v.toFixed(5)},${t + MIN_MS - 1},0,0,0,0,0`);
  }
  return `${lines.join('\n')}\n`;
}

export function synthGrid(span: Span, key: string, opts: Parameters<typeof synthCsv>[2] = {}): Grid {
  const g = emptyGrid(span);
  putCsv(g, synthCsv(span, key, opts));
  return finishGrid(g);
}

/**
 * A small synthetic study for the harness tests: 130 days, three positions. The second starts on day 30 and
 * lacks one minute; the third has no archive at all.
 */
export const SYNTH_SPAN: Span = Object.freeze({ t0Ms: Date.UTC(2021, 0, 1), n: 130 * 1440 });
export const SYNTH_FIT: Win = Object.freeze({ name: 'fit', lo: 0, hi: 115 * 1440 });
export const SYNTH_HOLDOUT: Win = Object.freeze({ name: 'holdout', lo: 115 * 1440, hi: 130 * 1440 });
export const SYNTH_HOLE = 100_000;
export const SYNTH_CENSUS_TEXT = JSON.stringify({ t3_weights: { panel: ['SYNA', 'SYNB', 'SYNC'], coins: { SYNA: 0.5, SYNB: 0.3, SYNC: 0.2 }, timeframes: { '1h': 0.2, '4h': 0.5, '1d': 0.3 } } });
export function synthLoad(pos: number): { g: Grid | null; noArchive: number } {
  if (pos === 0) return { g: synthGrid(SYNTH_SPAN, 'study|A'), noArchive: 0 };
  if (pos === 1) return { g: synthGrid(SYNTH_SPAN, 'study|B', { from: 30 * 1440, holes: new Set([SYNTH_HOLE]), p0: 40 }), noArchive: 1 };
  return { g: null, noArchive: 5 };
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip archive with one deflated member — the shape of the venue's monthly kline files. */
export function zipSingle(name: string, data: Buffer): Buffer {
  const nm = Buffer.from(name, 'utf8');
  const z = deflateRawSync(data);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(z.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nm.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(z.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nm.length, 28);
  central.writeUInt32LE(0, 42);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + nm.length, 12); end.writeUInt32LE(30 + nm.length + z.length, 16);
  return Buffer.concat([local, nm, z, central, nm, end]);
}
