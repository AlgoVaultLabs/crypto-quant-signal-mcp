// regime-forward/snapshot.ts — EDGE-REGIME-FORWARD-W1: the host read's record, its files, and the rows T5 may score.
//
// The host owed read (ops/monitoring/owed-read-regime-forward-30d.py) wrote three files and recorded their sha256 in
// its PASS record, which monitoring-results-sync.sh brings to the vault's canary-results.jsonl. This module finds that
// record, proves the pulled files are those bytes, and loads the rows under the registration's four filters:
// rule version 2 only, the window only, the four venues and three timeframes only, and no census-panel coin.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { LABELS } from '../regime-diag/diag-spec.js';
import { CALL_COLS, FILES, MUTATE, READ_HOST, READ_ID, RULE_VERSION, SNAP_COLS, TFS, VENUES, inWindow, type Venue } from './forward-spec.js';

export interface OwedRecord { at: string; host: string; verdict: string; files: Record<string, { sha256: string; bytes: number; rows: number }> }

/** The newest `owed_read` record of this read in a canary-results.jsonl text; null when there is none. */
export function findRecord(jsonl: string): OwedRecord | null {
  let found: OwedRecord | null = null;
  for (const line of jsonl.split('\n')) {
    if (!line.includes(READ_ID)) continue;
    let r: { at?: unknown; host?: unknown; canary?: unknown; verdict?: unknown; metrics?: { read_id?: unknown; files?: unknown } };
    try { r = JSON.parse(line); } catch { continue; }
    if (r.canary !== 'owed_read' || r.metrics?.read_id !== READ_ID) continue;
    if (typeof r.at !== 'string' || (found && found.at > r.at)) continue;
    found = { at: r.at, host: String(r.host), verdict: String(r.verdict), files: (r.metrics.files ?? {}) as OwedRecord['files'] };
  }
  return found;
}

/** True when the results log holds any `owed_read` record of this read from `host` (a test seam refuses one: lesson 10). */
export function hasRecordFrom(jsonl: string, host: string): boolean {
  for (const line of jsonl.split('\n')) {
    if (!line.includes(READ_ID)) continue;
    try {
      const r = JSON.parse(line) as { host?: unknown; canary?: unknown; metrics?: { read_id?: unknown } };
      if (r.canary === 'owed_read' && r.metrics?.read_id === READ_ID && r.host === host) return true;
    } catch { /* not a record */ }
  }
  return false;
}

/** Null when the record is `host`'s PASS (the registered read: signal-1) and every file in `dir` hashes to it; else the refusal. */
export function recordRefusal(rec: OwedRecord | null, dir: string, host: string = READ_HOST): string | null {
  if (!rec) return `no owed_read record of ${READ_ID} in the results log`;
  if (rec.verdict !== 'PASS') return `the newest ${READ_ID} record reads ${rec.verdict}, not PASS`;
  if (rec.host !== host) return `the ${READ_ID} record comes from ${rec.host}, not ${host}`;
  for (const f of FILES) {
    const want = rec.files[f]?.sha256;
    if (typeof want !== 'string' || !/^[0-9a-f]{64}$/.test(want)) return `the record carries no sha256 for ${f}`;
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) return `${f} is not in the snapshot directory`;
    const got = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    if (got !== want) return `${f} does not hash to the record (${got.slice(0, 12)} ≠ ${want.slice(0, 12)})`;
  }
  return null;
}

/** One served label: a bar close of one coin × timeframe on one venue. */
export interface SnapRow { venue: Venue; t: number; coin: string; bar: number; label: number; conf: number; vol: number }

/**
 * The sha256 of the one symbol a mutation proof asked a venue for over key A's span (registration §2 E12): its rows
 * and calls are dropped on every venue (`prior_look`), so no bar of it enters a score whatever the venue lists. The
 * symbol is held by its hash only (re-check N2).
 */
export const PRIOR_LOOK_SHA256 = 'cb1ad2119d8fafb69566510ee712661f9f14b83385006ef92aec47f523a38358';
const priorLook = new Map<string, boolean>();
const isPriorLook = (coin: string): boolean => {
  let v = priorLook.get(coin);
  if (v === undefined) { v = crypto.createHash('sha256').update(coin).digest('hex') === PRIOR_LOOK_SHA256; priorLook.set(coin, v); }
  return v;
};

export const DROP_NAMES = ['other_venue', 'other_timeframe', 'rule_version', 'outside_window', 'panel', 'prior_look', 'bad_row'] as const;
export type DropName = (typeof DROP_NAMES)[number];

export interface Loaded {
  /** Rows by `venue|t|coin`, in time order. */
  series: Map<string, SnapRow[]>;
  /** Coins kept per venue, sorted: a coin's position is its index here. */
  coins: Record<Venue, string[]>;
  drops: Record<DropName, number>;
  rows: number;
}

export const seriesKey = (v: Venue, t: number, coin: string): string => `${v}|${t}|${coin}`;

/**
 * Loads the snapshot rows under the registered filters. A dropped row is counted by name and never kept. The panel is
 * the census panel: no row of it is kept, so no bar of it is ever asked for.
 */
export function loadSnapshot(text: string, panel: ReadonlySet<string>): Loaded {
  const lines = text.split('\n');
  if (lines[0] !== SNAP_COLS.join('|')) throw new Error('regime-forward: the snapshot header is not the registered one');
  const drops = Object.fromEntries(DROP_NAMES.map((d) => [d, 0])) as Record<DropName, number>;
  const series = new Map<string, SnapRow[]>();
  const coinSets = Object.fromEntries(VENUES.map((v) => [v, new Set<string>()])) as Record<Venue, Set<string>>;
  let rows = 0;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '') continue;
    const f = lines[i].split('|');
    if (f.length !== SNAP_COLS.length) { drops.bad_row++; continue; }
    const [ex, tfKey, coin, barS, regime, confS, , , , volS, , , rvS] = f;
    if (!(VENUES as readonly string[]).includes(ex)) { drops.other_venue++; continue; }
    const t = TFS.findIndex((x) => x.key === tfKey);
    if (t < 0) { drops.other_timeframe++; continue; }
    if (Number(rvS) !== RULE_VERSION && MUTATE !== 'rule') { drops.rule_version++; continue; }
    const bar = Number(barS);
    if (!Number.isSafeInteger(bar) || (!inWindow(TFS[t], bar) && MUTATE !== 'window')) { drops.outside_window++; continue; }
    if (panel.has(coin) && MUTATE !== 'panel') { drops.panel++; continue; }
    if (isPriorLook(coin)) { drops.prior_look++; continue; }
    const label = (LABELS as readonly string[]).indexOf(regime), conf = Number(confS), vol = Number(volS);
    if (label < 0 || !Number.isFinite(conf) || !Number.isFinite(vol) || !/^[A-Z0-9]{1,24}$/.test(coin)) { drops.bad_row++; continue; }
    const v = ex as Venue, k = seriesKey(v, t, coin);
    let s = series.get(k);
    if (!s) { s = []; series.set(k, s); }
    s.push({ venue: v, t, coin, bar, label, conf, vol });
    coinSets[v].add(coin);
    rows++;
  }
  for (const s of series.values()) s.sort((a, b) => a.bar - b.bar);
  const coins = Object.fromEntries(VENUES.map((v) => [v, [...coinSets[v]].sort()])) as Record<Venue, string[]>;
  return { series, coins, drops, rows };
}

export const readGz = (p: string): string => zlib.gunzipSync(fs.readFileSync(p)).toString('utf8');

/** A labelled get_market_regime call: what a caller received, for the label-parity count only. */
export interface Call { venue: Venue; t: number; coin: string; atMs: number; label: number }

export function loadCalls(text: string, panel: ReadonlySet<string>): { calls: Call[]; dropped: number } {
  const lines = text.split('\n');
  if (lines[0] !== CALL_COLS.join('|')) throw new Error('regime-forward: the calls header is not the registered one');
  const calls: Call[] = [];
  let dropped = 0;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '') continue;
    const [ts, ex, tfKey, asset, regime] = lines[i].split('|');
    const t = TFS.findIndex((x) => x.key === tfKey), atMs = Date.parse(ts), label = (LABELS as readonly string[]).indexOf(regime);
    if (!(VENUES as readonly string[]).includes(ex) || t < 0 || !Number.isFinite(atMs) || label < 0 || panel.has(asset ?? '') || isPriorLook(asset ?? '')) { dropped++; continue; }
    calls.push({ venue: ex as Venue, t, coin: asset, atMs, label });
  }
  return { calls, dropped };
}
