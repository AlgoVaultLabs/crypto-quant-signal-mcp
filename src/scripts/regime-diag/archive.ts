// regime-diag/archive.ts — EDGE-REGIME-DIAG-W1: the venue's monthly 1 m kline archives, read into a minute grid.
//
// Registration §3: files `<COIN>USDT-1m-<YYYY-MM>.zip`, rows kept when open_time is a whole minute of the grid and
// O/H/L/C > 0. Two stores, the overlay resolved first (§2 D7). No network: fetching is not this module's job.
// §4.1: 1 m rows are aggregated to UTC-aligned bars — open first, high max, low min, close last, volume sum.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { FIRST_MONTH, LAST_MONTH, MIN_MS, type Span } from './diag-spec.js';

export const sha256 = (data: string | Buffer): string => crypto.createHash('sha256').update(data).digest('hex');

export function months(first = FIRST_MONTH, last = LAST_MONTH): string[] {
  const out: string[] = [];
  let [y, m] = first.split('-').map(Number);
  const [ly, lm] = last.split('-').map(Number);
  while (y < ly || (y === ly && m <= lm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

/** The single member of a zip archive (stored or deflated). Throws, reason named, on anything else. */
export function unzipSingle(buf: Buffer): Buffer {
  let i = buf.length - 22;
  while (i >= 0 && buf.readUInt32LE(i) !== 0x06054b50) i--;
  if (i < 0) throw new Error('zip: no end-of-central-directory record');
  if (buf.readUInt16LE(i + 10) !== 1) throw new Error(`zip: ${buf.readUInt16LE(i + 10)} members, expected 1`);
  const cd = buf.readUInt32LE(i + 16);
  if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error('zip: bad central directory');
  const method = buf.readUInt16LE(cd + 10);
  const csize = buf.readUInt32LE(cd + 20);
  const usize = buf.readUInt32LE(cd + 24);
  const lho = buf.readUInt32LE(cd + 42);
  if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error('zip: bad local header');
  const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
  const data = buf.subarray(start, start + csize);
  if (method !== 8 && method !== 0) throw new Error(`zip: unsupported method ${method}`);
  const out = method === 8 ? inflateRawSync(data) : Buffer.from(data);
  if (out.length !== usize) throw new Error('zip: size mismatch');
  return out;
}

export interface Grid {
  span: Span;
  O: Float64Array; H: Float64Array; L: Float64Array; C: Float64Array; V: Float64Array;
  has: Uint8Array;
  /** miss[i] = absent minutes in [0, i). */
  miss: Int32Array;
  first: number; last: number;
  counts: { months: number; rows: number; rejected: number; dups: number; gapsInside: number };
}

export function emptyGrid(span: Span): Grid {
  const f = (): Float64Array => new Float64Array(span.n).fill(NaN);
  return { span, O: f(), H: f(), L: f(), C: f(), V: f(), has: new Uint8Array(span.n), miss: new Int32Array(span.n + 1), first: -1, last: -1,
    counts: { months: 0, rows: 0, rejected: 0, dups: 0, gapsInside: 0 } };
}

/** A strict decimal: the archives are downloaded data, so nothing reaches `Number` unchecked. */
const DECIMAL = /^\d+(\.\d+)?$/;

/** One kline row into the grid. Open time in ms, or in µs (the venue's 2025+ files): anything above 1e14 is µs. */
export function putRow(g: Grid, fields: string[]): void {
  g.counts.rows++;
  for (let k = 0; k < 6; k++) if (!DECIMAL.test(fields[k] ?? '')) { g.counts.rejected++; return; }
  let ts = Number(fields[0]);
  if (ts > 1e14) ts = Math.floor(ts / 1000);
  const f = (ts - g.span.t0Ms) / MIN_MS;
  const i = Math.round(f);
  const o = Number(fields[1]), h = Number(fields[2]), l = Number(fields[3]), c = Number(fields[4]);
  if (!(Math.abs(f - i) <= 1e-6) || i < 0 || i >= g.span.n || !(o > 0 && h > 0 && l > 0 && c > 0)) { g.counts.rejected++; return; }
  if (g.has[i]) g.counts.dups++;
  g.O[i] = o; g.H[i] = h; g.L[i] = l; g.C[i] = c; g.V[i] = Number(fields[5]); g.has[i] = 1;
}

/** Closes the grid: the missing-minute prefix, the first and last present minute, the gaps between them. */
export function finishGrid(g: Grid): Grid {
  g.first = -1; g.last = -1;
  for (let i = 0; i < g.span.n; i++) {
    g.miss[i + 1] = g.miss[i] + (g.has[i] ? 0 : 1);
    if (g.has[i]) { if (g.first < 0) g.first = i; g.last = i; }
  }
  g.counts.gapsInside = g.first < 0 ? 0 : g.miss[g.last + 1] - g.miss[g.first];
  return g;
}

/** Reads kline csv text (a header line starting `open_time` is skipped) into the grid. */
export function putCsv(g: Grid, text: string): void {
  const lines = text.split('\n');
  for (let k = 0; k < lines.length; k++) {
    const ln = lines[k].trimEnd();
    if (ln.length === 0 || (k === 0 && ln.startsWith('open_time'))) continue;
    putRow(g, ln.split(','));
  }
}

export function buildGrid(span: Span, zipFiles: readonly string[]): Grid {
  const g = emptyGrid(span);
  for (const zp of zipFiles) {
    g.counts.months++;
    putCsv(g, unzipSingle(fs.readFileSync(zp)).toString('latin1'));
  }
  return finishGrid(g);
}

/** Every minute of [a, b) is present. */
export const noGap = (g: Grid, a: number, b: number): boolean => a >= 0 && b <= g.span.n && a <= b && g.miss[b] === g.miss[a];

export interface Bars { min: number; nb: number; O: Float64Array; H: Float64Array; L: Float64Array; C: Float64Array; V: Float64Array; cnt: Int32Array }

/** §4.1: bars of `min` minutes aligned to the grid origin (a UTC midnight). `cnt` is the minutes present in the bar. */
export function aggregate(g: Grid, min: number): Bars {
  const nb = Math.floor(g.span.n / min);
  const f = (): Float64Array => new Float64Array(nb).fill(NaN);
  const b: Bars = { min, nb, O: f(), H: f(), L: f(), C: f(), V: new Float64Array(nb), cnt: new Int32Array(nb) };
  for (let k = 0; k < nb; k++) {
    let hi = -Infinity, lo = Infinity, vol = 0, cnt = 0, o = NaN, c = NaN;
    for (let i = k * min; i < (k + 1) * min; i++) {
      if (!g.has[i]) continue;
      if (cnt === 0) o = g.O[i];
      c = g.C[i];
      if (g.H[i] > hi) hi = g.H[i];
      if (g.L[i] < lo) lo = g.L[i];
      vol += g.V[i];
      cnt++;
    }
    if (cnt > 0) { b.O[k] = o; b.H[k] = hi; b.L[k] = lo; b.C[k] = c; b.V[k] = vol; }
    b.cnt[k] = cnt;
  }
  return b;
}

// ── the two archive stores ──────────────────────────────────────────────────────────────────────────────────────

export interface ArchiveStore { cache: string; overlay: string }
export const archiveName = (coin: string, interval: string, ym: string): string => `${coin}USDT-${interval}-${ym}.zip`;

/** The overlay copy when there is one, else the cached copy, else null (§2 D7). */
export function resolveArchive(store: ArchiveStore, coin: string, interval: string, ym: string): { file: string; source: 'overlay' | 'cache' } | null {
  const name = archiveName(coin, interval, ym);
  if (fs.existsSync(path.join(store.overlay, name))) return { file: path.join(store.overlay, name), source: 'overlay' };
  if (fs.existsSync(path.join(store.cache, name))) return { file: path.join(store.cache, name), source: 'cache' };
  return null;
}

export const coinArchives = (store: ArchiveStore, coin: string): string[] =>
  months().map((ym) => resolveArchive(store, coin, '1m', ym)).filter((r): r is NonNullable<typeof r> => r !== null).map((r) => r.file);

export interface ArchiveManifest { interval: '1m'; first: string; last: string; files: Array<{ name: string; source: 'overlay' | 'cache'; bytes: number; sha256: string }> }

/** Every 1 m archive the panel resolves to, with its bytes and sha256. Deterministic: same stores, same text. */
export function buildArchiveManifest(store: ArchiveStore, panel: readonly string[]): ArchiveManifest {
  const files: ArchiveManifest['files'] = [];
  for (const coin of panel) {
    for (const ym of months()) {
      const r = resolveArchive(store, coin, '1m', ym);
      if (!r) continue;
      const buf = fs.readFileSync(r.file);
      files.push({ name: path.basename(r.file), source: r.source, bytes: buf.length, sha256: sha256(buf) });
    }
  }
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { interval: '1m', first: FIRST_MONTH, last: LAST_MONTH, files };
}
export const archiveManifestText = (m: ArchiveManifest): string => `${JSON.stringify(m, null, 1)}\n`;
