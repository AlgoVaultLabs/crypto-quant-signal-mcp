// tests/fixtures/regime-diag/synth-study.ts — EDGE-REGIME-DIAG-W1: what only the harness tests need.
//
// A small synthetic study, a single-member zip writer, the generator of the core-parity fixture and §4.1's
// aggregation check. No real market data. Nothing here is part of a run: the harness never imports this file.
import { deflateRawSync } from 'node:zlib';
import { aggregate, type Grid } from '../../../src/scripts/regime-diag/archive.js';
import { MIN_MS, type Span, type Win } from '../../../src/scripts/regime-diag/diag-spec.js';
import { parityCalls } from '../../../src/scripts/regime-diag/parity.js';
import { synthGrid } from '../../../src/scripts/regime-diag/synth.js';

/**
 * A small synthetic study: 130 days, three positions. The second starts on day 30 and lacks one minute; the
 * third has no archive at all.
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
function crc32(buf: Buffer): number {
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

/** The text of the core-parity fixture, written now from the list the harness replays. */
export const parityFixtureText = (): string =>
  `${JSON.stringify({ what: 'EDGE-REGIME-DIAG-W1 core-parity fixture: synthetic series, served(c, tf, t) per instant', key: 'core-parity', t0Ms: Date.UTC(2021, 0, 1), minutes: 130 * 1440, calls: parityCalls() }, null, 1)}\n`;

/** A strict decimal, as the harness reads one. */
const DECIMAL = /^\d+(\.\d+)?$/;

/**
 * §4.1's check: venue-format `min`-minute klines against the aggregate of the 1 m grid. A kline whose bar
 * lacks a 1 m row, or lies off the grid, is skipped and counted. Prices must agree exactly, volume to 1e-9.
 */
export function aggregationParity(g: Grid, min: number, klineCsv: string): { compared: number; skipped: number; mismatches: number } {
  const b = aggregate(g, min);
  const r = { compared: 0, skipped: 0, mismatches: 0 };
  for (const raw of klineCsv.split('\n')) {
    const f = raw.trimEnd().split(',');
    if (f.length < 6 || !f.slice(0, 6).every((x) => DECIMAL.test(x))) continue;
    let ts = Number(f[0]);
    if (ts > 1e14) ts = Math.floor(ts / 1000);
    const k = (ts - g.span.t0Ms) / (min * MIN_MS);
    if (!Number.isInteger(k) || k < 0 || k >= b.nb || b.cnt[k] !== min) { r.skipped++; continue; }
    r.compared++;
    const v = Number(f[5]);
    const same = b.O[k] === Number(f[1]) && b.H[k] === Number(f[2]) && b.L[k] === Number(f[3]) && b.C[k] === Number(f[4]) && Math.abs(b.V[k] - v) <= 1e-9 * Math.max(1, Math.abs(v));
    if (!same) r.mismatches++;
  }
  return r;
}
