// regime-challenge/challenge-r3-screen.ts — EDGE-REGIME-CHALLENGE-R3-W1 (T6, round 3): the alt panel, label-free.
//
// Round 3 reads liquid alts. A coin is in month m's panel iff, at m's start:
//   - rule R3-X calls it an alt (not of the served segment, which keeps the served rules; not an index, a TradFi or an
//     asset-backed contract; not a stablecoin), with the metadata snapshot speaking only for months from the onboard
//     month of the instrument it describes (a reused ticker's earlier archives are an earlier instrument);
//   - it is whole: monthly 1m archives exist for m−1, m and m+1 (round 2's rule);
//   - it is seasoned: its first archived day is at least 30 days before m;
//   - at least 20 of the 30 days before m have a daily row, and their mean quote-asset volume is ≥ 10,000,000 USDT.
// A day missing inside a seasoned window is an archive gap, not zero volume.
//
// This is the one path that reads 2020–23 files before round 3's seal (arc lesson 10), and it reads two columns of a
// daily kline: the open time (col 0, to date the row) and the quote-asset volume (col 7). No price column is read,
// no label and no outcome is computed. The rule's lists name coins, so they live in the vault panel file with the
// table, never in the repository: this module applies whatever lists the file it is given names.
//
//   npx tsx src/scripts/regime-challenge/challenge-r3-screen.ts --listing L --snapshot X --rule R --archives-1d DIR --out FILE
//
// Callers gate on the token: REGIME_CHALLENGE_R3_SCREEN_VERDICT=PASS | REFUSED — <reason> | INDETERMINATE — <reason>
import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from '../sr-backtest/store.js';
import { months, sha256, unzipSingle } from '../regime-diag/archive.js';
import { sealHome } from '../regime-diag/guard.js';
import { linkRefusal, outRefusal, within } from './challenge-guard.js';

export const R3_SCREEN_WAVE = 'EDGE-REGIME-CHALLENGE-R3-W1';
/** Round 3's home under `~/.cache/algovault`: its archives, its store and its outputs (the screen's too). */
export const R3_HOME = 'regime-challenge-r3';
/** The months the screen decides: every month either window of round 3 can read. */
export const SCREEN_MONTHS = Object.freeze({ first: '2020-01', last: '2025-12' });
/** The months a candidate's archives are listed from (spec §3): the bucket holds none before 2020-01. */
export const LISTED_MONTHS = Object.freeze({ first: '2019-09', last: '2025-12' });
export const THRESHOLD_USDT = 10_000_000;
export const TRAILING_DAYS = 30;
export const SEASONING_DAYS = 30;
export const MIN_DAYS_PRESENT = 20;

export interface R3Rule { served: string[]; stable: string[]; assetBacked: string[]; indexAbsent: string[] }
/** What the metadata snapshot says of the instrument a symbol names now, and the month that instrument was onboarded. */
export interface SnapshotRow { contractType: string; underlyingType: string; onboardMonth: string }
export type Snapshot = Readonly<Record<string, SnapshotRow>>;
export type CoinClass = 'served' | 'not_coin' | 'stable' | 'alt';
export type MonthState = Exclude<CoinClass, 'alt'> | 'panel' | 'thin' | 'partial' | 'unseasoned' | 'sparse';

const MULTIPLIER = /^(1000000|100000|10000|1000|1M)(?=[A-Z])/;
/** The base asset a USDT symbol names, with a leading contract multiplier stripped. */
export function nbaseOf(symbol: string): string {
  const base = symbol.endsWith('USDT') ? symbol.slice(0, -4) : symbol;
  const m = MULTIPLIER.exec(base);
  return m ? base.slice(m[0].length) : base;
}

/** Rule R3-X for one symbol in one month, applied in its order: served, not a single crypto coin, stablecoin, alt. */
export function classOf(symbol: string, ym: string, rule: R3Rule, snapshot: Snapshot): CoinClass {
  const b = nbaseOf(symbol);
  if (rule.served.includes(b)) return 'served';
  const s = snapshot[symbol];
  if (s && ym >= s.onboardMonth && (s.contractType !== 'PERPETUAL' || s.underlyingType !== 'COIN')) return 'not_coin';
  if (rule.assetBacked.includes(b) || rule.indexAbsent.includes(b)) return 'not_coin';
  if (rule.stable.includes(b)) return 'stable';
  return 'alt';
}

/**
 * The quote-asset volume of each UTC day of a daily kline CSV. Reads the open time (col 0) and the quote-asset volume
 * (col 7) of each row and nothing else; a header row is skipped. Open times in microseconds are read as such.
 */
export function dayVolumes(csv: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of csv.split('\n')) {
    const cells = line.split(',');
    if (!/^\d+$/.test(cells[0]?.trim() ?? '')) continue;
    let t = Number(cells[0]);
    if (t > 1e14) t = Math.floor(t / 1000);
    out.set(new Date(t).toISOString().slice(0, 10), Number(cells[7]));
  }
  return out;
}

const addMonths = (ym: string, k: number): string => { const i = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1 + k; return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`; };
const dayBefore = (ym: string, k: number): string => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1 - k)).toISOString().slice(0, 10);

export interface ScreenInput {
  /** The months whose state is decided. */
  months: readonly string[];
  /** Per symbol, the months a monthly 1m archive exists for (the bucket listing). */
  archiveMonths: Readonly<Record<string, readonly string[]>>;
  /** Per symbol, its daily quote-asset volume by UTC day (`dayVolumes` of its daily archives). */
  volumes: Readonly<Record<string, ReadonlyMap<string, number>>>;
  rule: R3Rule;
  snapshot: Snapshot;
}

/** The state of one symbol in one month it has an archive for. */
export function stateOf(symbol: string, ym: string, input: ScreenInput): MonthState {
  const c = classOf(symbol, ym, input.rule, input.snapshot);
  if (c !== 'alt') return c;
  const arch = new Set(input.archiveMonths[symbol] ?? []);
  if (!arch.has(addMonths(ym, -1)) || !arch.has(addMonths(ym, 1))) return 'partial';
  const vol = input.volumes[symbol] ?? new Map<string, number>();
  let first: string | null = null;
  for (const d of vol.keys()) if (first === null || d < first) first = d;
  if (first === null || first > dayBefore(ym, SEASONING_DAYS)) return 'unseasoned';
  const got: number[] = [];
  for (let k = 1; k <= TRAILING_DAYS; k++) { const v = vol.get(dayBefore(ym, k)); if (v !== undefined) got.push(v); }
  if (got.length < MIN_DAYS_PRESENT) return 'sparse';
  return got.reduce((a, b) => a + b, 0) / got.length >= THRESHOLD_USDT ? 'panel' : 'thin';
}

/** Every symbol's state in every month of `input.months` it has an archive for. Deterministic: sorted keys. */
export function screen(input: ScreenInput): Record<string, Record<string, MonthState>> {
  const out: Record<string, Record<string, MonthState>> = {};
  for (const s of Object.keys(input.archiveMonths).sort()) {
    const row: Record<string, MonthState> = {};
    const arch = new Set(input.archiveMonths[s]);
    for (const ym of input.months) if (arch.has(ym)) row[ym] = stateOf(s, ym, input);
    out[s] = row;
  }
  return out;
}

// ── the CLI: the vault panel file ─────────────────────────────────────────────────────────────────────────────────

interface Listing { usdt: Record<string, { '1m': Record<string, { zip?: number }> }> }
interface ExchangeInfo { symbols: Array<{ symbol: string; contractType: string; underlyingType: string; onboardDate: number }> }

/** The candidates (spec §3): USDT symbols with no `_`, with a monthly 1m archive in the listed months; their archive months. */
export function candidatesOf(listing: Listing): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [sym, v] of Object.entries(listing.usdt)) {
    if (!sym.endsWith('USDT') || sym.includes('_')) continue;
    const ms = Object.entries(v['1m'] ?? {}).filter(([, f]) => f.zip !== undefined).map(([m]) => m).sort();
    if (ms.some((m) => m >= LISTED_MONTHS.first && m <= LISTED_MONTHS.last)) out[sym] = ms;
  }
  return out;
}

export function snapshotOf(info: ExchangeInfo): Record<string, SnapshotRow> {
  const out: Record<string, SnapshotRow> = {};
  for (const s of info.symbols) out[s.symbol] = { contractType: s.contractType, underlyingType: s.underlyingType, onboardMonth: new Date(s.onboardDate).toISOString().slice(0, 7) };
  return out;
}

const TOKEN = 'REGIME_CHALLENGE_R3_SCREEN_VERDICT';
const REPO = path.resolve(__dirname, '../../..');

/**
 * Why the screen may not write its panel file at `out`, or null. The file names coins, so never inside the
 * repository; and round 2's allow-list (review 1, F5): never in the seal home or an archive store the screen reads,
 * under `~/.cache/algovault` only in round 3's home. It is written in place (a temporary name, then a rename), so
 * neither name may be a link.
 */
export function screenOutRefusal(out: string, archives1d: string, repo = REPO): string | null {
  if (within(out, repo)) return 'the panel file names coins: it is written outside the repository';
  const foreign = outRefusal(out, R3_HOME, sealHome(), { cache: archives1d, overlay: archives1d });
  if (foreign) return foreign;
  return linkRefusal(path.dirname(out), 'the panel file\'s directory', [path.basename(out), `${path.basename(out)}.tmp`]);
}

function main(): void {
  const argv = process.argv.slice(2);
  const VALUED = ['--listing', '--snapshot', '--rule', '--archives-1d', '--out'];
  const val: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!VALUED.includes(argv[i]) || val[argv[i]] !== undefined || argv[i + 1] === undefined || argv[i + 1].startsWith('--')) return finish('INDETERMINATE', `usage: ${VALUED.map((v) => `${v} X`).join(' ')}`);
    val[argv[i]] = path.resolve(argv[i + 1]);
  }
  if (VALUED.some((v) => !val[v])) return finish('INDETERMINATE', `usage: ${VALUED.map((v) => `${v} X`).join(' ')}`);
  const out = val['--out'];
  const refused = screenOutRefusal(out, val['--archives-1d']);
  if (refused) return finish('REFUSED', refused);
  const listingBytes = fs.readFileSync(val['--listing']), snapBytes = fs.readFileSync(val['--snapshot']), ruleBytes = fs.readFileSync(val['--rule']);
  const rule = JSON.parse(ruleBytes.toString('utf8')) as R3Rule;
  const archiveMonths = candidatesOf(JSON.parse(listingBytes.toString('utf8')) as Listing);
  const snapshot = snapshotOf(JSON.parse(snapBytes.toString('utf8')) as ExchangeInfo);
  const decided = months(SCREEN_MONTHS.first, SCREEN_MONTHS.last);
  const volumes: Record<string, Map<string, number>> = {};
  const read: string[] = [];
  for (const [sym, ms] of Object.entries(archiveMonths)) {
    const alt = ms.filter((m) => m >= LISTED_MONTHS.first && m <= LISTED_MONTHS.last && classOf(sym, m, rule, snapshot) === 'alt');
    if (!alt.length) continue;
    const vol = new Map<string, number>();
    for (const m of alt) {
      const name = `${sym}-1d-${m}.zip`, zp = path.join(val['--archives-1d'], name);
      if (!fs.existsSync(zp) || !fs.existsSync(`${zp}.CHECKSUM`)) return finish('INDETERMINATE', `the daily archive ${name} or its .CHECKSUM is absent`);
      const z = fs.readFileSync(zp), [sum, file] = fs.readFileSync(`${zp}.CHECKSUM`, 'utf8').trim().split(/\s+/);
      if (sha256(z) !== sum || file !== name) return finish('REFUSED', `${name} does not match its .CHECKSUM`);
      for (const [d, v] of dayVolumes(unzipSingle(z).toString('latin1'))) vol.set(d, v);
      read.push(`${name} ${sum}`);
    }
    volumes[sym] = vol;
  }
  const table = screen({ months: decided, archiveMonths, volumes, rule, snapshot });
  const text = `${JSON.stringify({
    kind: 'regime-challenge-r3-panel', wave: R3_SCREEN_WAVE,
    rule: { ...rule, threshold_usdt: THRESHOLD_USDT, trailing_days: TRAILING_DAYS, seasoning_days: SEASONING_DAYS, min_days_present: MIN_DAYS_PRESENT },
    inputs: { listing_sha256: sha256(listingBytes), snapshot_sha256: sha256(snapBytes), rule_sha256: sha256(ruleBytes), daily_archives: read.length, daily_archives_sha256: sha256(`${read.sort().join('\n')}\n`) },
    months: SCREEN_MONTHS, snapshot: Object.fromEntries(Object.keys(archiveMonths).filter((s) => snapshot[s]).map((s) => [s, snapshot[s]])),
    archive_months: archiveMonths, table,
  }, null, 1)}\n`;
  writeAtomic(out, text);
  process.stdout.write(`panel_sha256=${sha256(text)}\n`);
  finish('PASS');
}

function finish(verdict: 'PASS' | 'REFUSED' | 'INDETERMINATE', reason = ''): void {
  process.stdout.write(verdict === 'PASS' ? `${TOKEN}=PASS\n` : `${TOKEN}=${verdict} — ${reason}\n`);
  process.exitCode = verdict === 'PASS' ? 0 : verdict === 'REFUSED' ? 1 : 3;
}

if (require.main === module) {
  try { main(); } catch (err) { process.stderr.write(`regime-challenge r3 screen: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`); finish('INDETERMINATE', 'the screen threw'); }
}
