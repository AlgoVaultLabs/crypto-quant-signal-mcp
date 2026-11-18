// tests/unit/regime-forward-spec.test.ts — EDGE-REGIME-FORWARD-W1: one window, one clock, stated once and held equal.
//
// The registration, the harness constants, the host read's constants, its registry row and its inventory row each
// state the window and the clock. This file holds them equal (arc lesson 8: absolute UTC, never relative), runs the
// host read's self-test against its own declared floor (verification-gates: the token, never the exit code), and
// holds this study's own files to their pins. A file another wave edits is the guard's to check at the read, never
// this test's (arc lesson 15): the served code's fingerprint is tested on a synthetic tree built here.
// lesson 14: imported first — the homes resolve under the suite's own directory, fetch throws (isolate.ts)
import '../fixtures/regime-forward/isolate.js';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pinsOf } from '../../src/scripts/sr-backtest/guard.js';
import {
  CALL_COLS, CENSUS_SHA256, EXPIRES_MS, FILES, LOOKAHEAD_BARS, NOT_BEFORE_MS, READ_ID, REGISTRATION, RULE_VERSION, SERVED_FINGERPRINT, SERVED_PRINTER, SNAP_COLS, TFS, VENUES, W0_MS, W1_MS, WAVE, windowEndMs,
} from '../../src/scripts/regime-forward/forward-spec.js';
import { SERVED_FILES, SERVED_NAMES, closureOf, fingerprintOf, firstPinsOf, servedRefusalOf, servedWant } from '../../src/scripts/regime-forward/served-fingerprint.js';
import { SYNTH_COINS, SYNTH_COIN_FORM, SYNTH_PANEL, synthCoin, synthServedTree } from '../fixtures/regime-forward/synth.js';

const ROOT = path.resolve(__dirname, '../..');
const OWED = 'ops/monitoring/owed-read-regime-forward-30d.py';
const read = (f: string): string => fs.readFileSync(path.join(ROOT, f), 'utf8');
const sha256 = (f: string): string => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex');
const iso = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z');
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The host read's constants, as Python itself evaluates them. */
function py(): Row {
  const code = [
    'import importlib.util, json, sys',
    `s = importlib.util.spec_from_file_location("m", ${JSON.stringify(path.join(ROOT, OWED))})`,
    'm = importlib.util.module_from_spec(s); s.loader.exec_module(m)',
    'print(json.dumps({k: getattr(m, k) for k in ("WAVE","READ_ID","W0_MS","W1_MS","LOOKAHEAD_BARS","RULE_VERSION","NOT_BEFORE_S","CALLS_FROM","CALLS_TO","VENUES","FILES","SNAP_COLS","CALL_COLS","PSQL_TIMEOUT_S","OUT_DIR")} | {"predicate": m.predicate(), "tf": [[t, m.window_end_ms(t)] for t, _ in m.TF_MS]}))',
  ].join('\n');
  const r = spawnSync('python3', ['-I', '-c', code], { encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

describe('the window and the clock, in absolute UTC', () => {
  it('W0, W1, not_before and expires_at are the ruled instants', () => {
    expect([iso(W0_MS), iso(W1_MS), iso(NOT_BEFORE_MS), iso(EXPIRES_MS)]).toEqual(['2026-11-16T08:00:00Z', '2026-12-16T08:00:00Z', '2026-12-30T08:00:00Z', '2027-01-13T08:00:00Z']);
  });

  it('not_before is the last daily look-ahead close (W1 + 14 days) and expires_at falls 14 days later', () => {
    expect(NOT_BEFORE_MS).toBe(windowEndMs(TFS[2]));
    expect(windowEndMs(TFS[2]) - W1_MS).toBe(LOOKAHEAD_BARS * 86_400_000);
    expect(EXPIRES_MS - NOT_BEFORE_MS).toBe(14 * 86_400_000);
    expect(RULE_VERSION).toBe(2);
  });

  it('the host read states the same window, clock, files and columns', () => {
    const p = py();
    expect([p.WAVE, p.READ_ID, p.W0_MS, p.W1_MS, p.LOOKAHEAD_BARS, p.RULE_VERSION, p.NOT_BEFORE_S * 1000]).toEqual([WAVE, READ_ID, W0_MS, W1_MS, LOOKAHEAD_BARS, RULE_VERSION, NOT_BEFORE_MS]);
    expect([p.CALLS_FROM, p.CALLS_TO]).toEqual([iso(W0_MS).slice(0, -1), iso(W1_MS).slice(0, -1)]);
    expect([p.VENUES, p.FILES, p.SNAP_COLS, p.CALL_COLS]).toEqual([[...VENUES], [...FILES], [...SNAP_COLS], [...CALL_COLS]]);
    expect(p.tf).toEqual(TFS.map((tf) => [tf.key, windowEndMs(tf)]));
  });

  it('the registration carries the host read\'s literal predicate and the four instants', () => {
    const reg = read(REGISTRATION), p = py();
    expect(reg).toContain(p.predicate);
    for (const ms of [W0_MS, W1_MS, NOT_BEFORE_MS, EXPIRES_MS]) expect(reg).toContain(iso(ms));
    expect(reg).toContain(CENSUS_SHA256);
  });
});

describe('the registry row and the inventory rows', () => {
  const reads = JSON.parse(read('ops/monitoring/owed-reads.json')).reads as Row[];
  const inventory = JSON.parse(read('ops/monitoring/monitoring-inventory.json')).artifacts as Row[];
  const inv = (id: string): Row => inventory.find((r) => r.id === id) as Row;

  it('one registry row, whose clock and anchors are the read\'s own', () => {
    const rows = reads.filter((r) => r.id === READ_ID);
    expect(rows).toHaveLength(1);
    const r = rows[0], p = py();
    expect([r.wave, r.not_before, r.expires_at, r.script]).toEqual([WAVE, iso(NOT_BEFORE_MS), iso(EXPIRES_MS), path.basename(OWED)]);
    expect(r.anchors).toEqual({ w0_ms: W0_MS, w1_ms: W1_MS, lookahead_bars: LOOKAHEAD_BARS, rule_version: RULE_VERSION });
    expect(r.timeout_s).toBeGreaterThan(p.PSQL_TIMEOUT_S);
    expect(r.timeout_s).toBeLessThanOrEqual(1800);
    expect(r.criteria.length).toBeLessThanOrEqual(400);
  });

  it('the host read\'s inventory row is the committed bytes, pending, called by the runner', () => {
    const r = inv('owed-read-regime-forward-30d');
    expect([r.artifact, r.host, r.host_path, r.invoked_by, r.schedule, r.install_state, r.owner_wave]).toEqual([OWED, 'signal-1', `/opt/algovault-monitoring/${path.basename(OWED)}`, 'called-by:owed-read-runner', null, 'pending', WAVE]);
    expect(r.pending_since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.alert_ids).toEqual([]);
    expect(r.sha256, 'inventory sha256 is stale — re-stamp it in the same commit as the edit').toBe(sha256(OWED));
  });

  it('the registry\'s own inventory row carries the registry\'s bytes', () => {
    expect(inv('owed-reads-registry').sha256).toBe(sha256('ops/monitoring/owed-reads.json'));
  });
});

describe('the host read\'s self-test — judged by its token, counted against its own floor', () => {
  it('passes every check it declares', () => {
    const floor = Number(read(OWED).match(/^_SELF_TEST_MIN_CHECKS = (\d+)$/m)?.[1]);
    expect(floor).toBeGreaterThan(0);
    const r = spawnSync('python3', [OWED, '--self-test'], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
    const tokens = (r.stdout ?? '').split('\n').filter((l) => l.startsWith('SELF_TEST_VERDICT='));
    expect(tokens, `${r.stdout}\n${r.stderr}`.slice(-3000)).toHaveLength(1);
    expect(Number(tokens[0].match(/^SELF_TEST_VERDICT=PASS — (\d+) checks /)?.[1])).toBe(floor);
    expect(r.status).toBe(0);
  }, 150_000);
});

describe('this study\'s own files hash to their pins', () => {
  const pins = pinsOf(read(REGISTRATION));
  const own = [...fs.readdirSync(path.join(ROOT, 'src/scripts/regime-forward')).map((f) => `src/scripts/regime-forward/${f}`), OWED];

  it.each(own)('%s', (rel) => {
    expect(pins.get(rel), `${rel} is not pinned`).toBe(sha256(rel));
  });

  it('the census is pinned; every served file is pinned, and the fingerprint and its printer are stated — checked against the code only by the guard, at the read (RV1)', () => {
    expect(pins.get('census:regime-census-2026-11-16.json')).toBe(CENSUS_SHA256);
    for (const f of SERVED_FILES) expect(pins.has(f), f).toBe(true);
    for (const k of Object.keys(SERVED_NAMES) as Array<keyof typeof SERVED_NAMES>) expect(SERVED_FILES as readonly string[]).toContain(SERVED_NAMES[k].file);
    expect(read(REGISTRATION)).toContain(`\`SERVED_FINGERPRINT\` = \`${SERVED_FINGERPRINT}\``);
    expect(read(REGISTRATION)).toContain(`TypeScript printer \`${SERVED_PRINTER}\``);
  });
});

describe('F15, R4, FP: the served code the read uses is fingerprinted by its source, found by name — on a synthetic tree (RV1)', () => {
  const TREE = synthServedTree();
  const B = SERVED_NAMES.BINANCE.file, O = SERVED_NAMES.OKX.file, A = SERVED_NAMES.ATR.file;
  const [a, c, x, y] = [synthCoin(11), synthCoin(13), synthCoin(21), synthCoin(22)];
  const src = (edits: Record<string, string> = {}) => (f: string): string => { const t = edits[f] ?? TREE[f]; if (t === undefined) throw new Error(`no synthetic ${f}`); return t; };
  /** The fingerprint of the synthetic tree with some files replaced. */
  const fp = (edits: Record<string, string> = {}): string => fingerprintOf(src(edits)).sha256;
  const edit = (f: string, from: string | RegExp, to: string): string => { const s = TREE[f], t = s.replace(from, to); expect(t, `${f}: the edit applies`).not.toBe(s); return t; };
  const append = (f: string, text: string): string => `${TREE[f]}\n${text}\n`;

  it('what it covers: each function, the maps it reads and a relative import, found by name — never a declaration it does not read', () => {
    expect(Object.keys(closureOf(B, 'toBinanceSymbol', src())).sort()).toEqual([`${B}#SYMBOL_OVERRIDES`, `${B}#TRADFI_ALIASES`, `${B}#toBinanceSymbol`]);
    expect(Object.keys(closureOf(O, 'toOKXInstId', src())).sort()).toEqual([`${O}#TRADFI_ALIASES`, `${O}#toOKXInstId`, 'src/lib/adapters/suffix.ts#SWAP_SUFFIX']);
    expect(() => closureOf(B, 'noSuchFunction', src())).toThrow(/not a top-level declaration/);
    expect(fingerprintOf(src()).declarations).toBe(9);
  });

  it('an unrelated edit leaves it unchanged: a new function, a comment, a reformatted line, a map the functions do not read, a statement that touches none of it', () => {
    const base = fp();
    expect(fp({ [O]: append(O, 'export function unrelated2(): number { return 1; }\n// a note') })).toBe(base);
    expect(fp({ [B]: edit(B, "'1d': '1d'", "'1d': '1d', '3d': '3d'") })).toBe(base);
    expect(fp({ [B]: edit(B, 'export function toBinanceSymbol(coin: string): string {', '// a comment above it\nexport function toBinanceSymbol(coin: string): string { // and one beside it') })).toBe(base);
    expect(fp({ [B]: edit(B, "return mapped + 'USDT';", "return mapped  +  'USDT' ;") })).toBe(base);
    expect(fp({ [A]: append(A, 'export const UNRELATED_CONSTANT = 2;') })).toBe(base);
    expect(fp({ [B]: append(B, `INTERVAL_MAP['3d'] = '3d';\nconsole.log('loaded');`) })).toBe(base);
  });

  it('an edit to what the read uses moves it: a special case (mutant F15b), an alias added or changed, a suffix, σ_bar\'s constant', () => {
    const base = fp();
    expect(fp({ [B]: edit(B, 'export function toBinanceSymbol(coin: string): string {', `export function toBinanceSymbol(coin: string): string {\n  if (coin === '${x}') return '${y}USDT';`) })).not.toBe(base);
    const added = edit(O, 'const TRADFI_ALIASES: Record<string, string> = {', `const TRADFI_ALIASES: Record<string, string> = {\n  ${x}: '${y}',`);
    expect(fp({ [O]: added })).not.toBe(base);
    expect(fp({ [O]: added.replace(`${x}: '${y}'`, `${x}: '${x}'`) })).not.toBe(fp({ [O]: added }));
    expect(fp({ [B]: edit(B, `${a}: '1000${a}'`, `${a}: '100${a}'`) })).not.toBe(base);
    expect(fp({ [B]: edit(B, "return mapped + 'USDT';", "return mapped + 'USDC';") })).not.toBe(base);
    expect(fp({ 'src/lib/adapters/suffix.ts': "export const SWAP_SUFFIX = 'USDC-SWAP';\n" })).not.toBe(base);
    expect(fp({ [A]: edit(A, 'Math.sqrt(8 / Math.PI)', 'Math.sqrt(8 / Math.PI) * 1.000001') })).not.toBe(base);
  });

  it('FP: a top-level statement that writes a map the functions read moves it — an assignment, a loop, Object.assign, and what such a statement reads', () => {
    const base = fp();
    const assigned = fp({ [B]: append(B, `TRADFI_ALIASES['${x}'] = '${y}';`) });
    const looped = fp({ [B]: append(B, `for (const k of ['${x}', '${y}']) SYMBOL_OVERRIDES[k] = '1000' + k;`) });
    const merged = fp({ [O]: append(O, `Object.assign(TRADFI_ALIASES, { ${x}: '${y}' });`) });
    for (const v of [assigned, looped, merged]) expect(v).not.toBe(base);
    // to a fixed point: the declaration such a statement reads is covered too
    const extra = (v: string): string => append(O, `const EXTRA: Record<string, string> = { ${x}: '${v}' };\nObject.assign(TRADFI_ALIASES, EXTRA);`);
    expect(fp({ [O]: extra(y) })).not.toBe(fp({ [O]: extra(c) }));
    expect(Object.keys(closureOf(O, 'toOKXInstId', src({ [O]: extra(y) })))).toEqual(expect.arrayContaining([`${O}#EXTRA`, `${O}#(statements)`]));
    expect(fingerprintOf(src({ [O]: extra(y) })).declarations).toBe(fingerprintOf(src()).declarations + 1);
  });
});

describe('PRN: the guard\'s served check — bytes first, then the printer, then the fingerprint (pure core, synthetic tree)', () => {
  const TREE = synthServedTree();
  const O = SERVED_NAMES.OKX.file, B = SERVED_NAMES.BINANCE.file;
  const [x, y] = [synthCoin(21), synthCoin(22)];
  const fileSha = (t: string): string => crypto.createHash('sha256').update(t).digest('hex');
  const pinRows = (files: Record<string, string>): string => Object.entries(files).filter(([f]) => (SERVED_FILES as readonly string[]).includes(f)).map(([f, t]) => `| \`${f}\` | \`${fileSha(t)}\` | served |`).join('\n');
  const REG = `| pin | sha256 | role |\n|---|---|---|\n${pinRows(TREE)}\n`;
  const WANT = { fingerprint: fingerprintOf((f) => TREE[f]).sha256, printer: 'p-registered' };
  const check = (tree: Record<string, string>, printer: string, registration = REG, want = WANT): string | null =>
    servedRefusalOf({ registration, sourceOf: (f) => tree[f] ?? null, printer, want });
  const aliased = { ...TREE, [O]: TREE[O].replace('const TRADFI_ALIASES: Record<string, string> = {', `const TRADFI_ALIASES: Record<string, string> = {\n  ${x}: '${y}',`) };
  const unrelated = { ...TREE, [B]: `${TREE[B]}\nexport function unrelated2(): number { return 2; }\n` };
  /** An appended amendment re-pinning a file: the guard's pins keep the last row, the served check reads the first. */
  const repinned = (tree: Record<string, string>, f: string): string => `${REG}\n## Amendment\n\n| \`${f}\` | \`${fileSha(tree[f])}\` | re-pinned |\n`;

  it('byte-identical to its first pins: passes under the registered printer and under any other', () => {
    expect(firstPinsOf(REG).size).toBe(SERVED_FILES.length);
    expect(check(TREE, WANT.printer)).toBeNull();
    expect(check(TREE, 'p-other')).toBeNull();
  });

  it('a re-pinned edit under another printer: refused, naming the printer mismatch', () => {
    expect(check(aliased, 'p-other', repinned(aliased, O))).toMatch(/printer p-other is not the registered p-registered/);
    expect(check(unrelated, 'p-other', repinned(unrelated, B))).toMatch(/printer/);
  });

  it('a re-pinned edit under the registered printer: refused when the fingerprint moves, read when it does not', () => {
    expect(check(aliased, WANT.printer, repinned(aliased, O))).toMatch(/source fingerprint .* differs from the registered/);
    expect(check(unrelated, WANT.printer, repinned(unrelated, B))).toBeNull();
  });

  it('identical bytes under the registered printer but a registered value that is not theirs: refused', () => {
    expect(check(TREE, WANT.printer, REG, { ...WANT, fingerprint: '0'.repeat(64) })).toMatch(/source fingerprint .* differs/);
  });

  it('a served file unpinned, absent, or a closure that cannot be built: refused, never thrown', () => {
    expect(check(TREE, WANT.printer, REG.replace(/^\| `src\/lib\/adapters\/bitget\.ts`.*$/m, ''))).toMatch(/served src\/lib\/adapters\/bitget\.ts is not pinned/);
    const gone = { ...TREE }; delete gone[O];
    expect(check(gone, WANT.printer)).toMatch(/served src\/lib\/adapters\/okx\.ts is missing/);
    const broken = { ...TREE, [O]: TREE[O].replace('export function toOKXInstId', 'export function renamed') };
    expect(check(broken, WANT.printer, repinned(broken, O))).toMatch(/fingerprint: .*not a top-level declaration/);
  });

  it('the registered read judges by the registered values; a test seam never does', () => {
    expect(servedWant(null)).toEqual({ fingerprint: SERVED_FINGERPRINT, printer: SERVED_PRINTER });
    expect(servedWant(WANT)).toEqual(WANT);
    expect(() => servedWant({ fingerprint: SERVED_FINGERPRINT, printer: 'p' })).toThrow(/a test seam never judges by the registered served fingerprint/);
  });
});

describe('R6: every coin token in the harness tests and fixtures comes from the synthetic generator (by construction; RV1)', () => {
  /** The words the harness tests quote that are not coins: venues, labels, verdicts, causes, leg and constant names. */
  const VOCABULARY = new Set([
    'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'HYPERLIQUID', 'RANGING', 'TRENDING_UP', 'TRENDING_DOWN', 'VOLATILE', 'BUY', 'HOLD', 'SELL',
    'PASS', 'FAIL', 'REFUSED', 'INDETERMINATE', 'UNDEFINED', 'NOT_IDENTIFIABLE', 'USDT', 'USDC', 'SWAP', 'FUTURES', 'EIO', 'HOME', 'EDGE',
    'WAVE', 'READ_ID', 'W0_MS', 'W1_MS', 'LOOKAHEAD_BARS', 'RULE_VERSION', 'NOT_BEFORE_S', 'CALLS_FROM', 'CALLS_TO', 'VENUES', 'FILES',
    'SNAP_COLS', 'CALL_COLS', 'PSQL_TIMEOUT_S', 'OUT_DIR', 'MODERATE', 'WEAK', 'NEUTRAL', 'HIGHER_HIGHS', 'MARK', 'COMPLETE', 'PARTIAL',
    'OK', 'EXTERNAL', 'README',
  ]);
  /** Quoted or pipe-delimited capitalised tokens that are neither the reserved synthetic form nor the vocabulary. */
  const coinLike = (text: string): string[] =>
    [...text.matchAll(/(?<=['"`|/])([A-Z][A-Z0-9_]{1,23})(?=['"`|/.-])/g)].map((m) => m[1]).filter((t) => !SYNTH_COIN_FORM.test(t) && !VOCABULARY.has(t));
  const files = (): string[] => fs.readdirSync(path.join(ROOT, 'tests/unit')).filter((f) => f.startsWith('regime-forward-')).map((f) => `tests/unit/${f}`)
    .concat(fs.readdirSync(path.join(ROOT, 'tests/fixtures/regime-forward')).map((f) => `tests/fixtures/regime-forward/${f}`));
  /** The host read's self-test fixture rows, the one fixture outside tests/. */
  const pyFixture = (): string => { const s = read(OWED); return s.slice(s.indexOf('def _fixture('), s.indexOf('def _stub(')); };

  it('no coin-like literal outside the reserved form, in any regime-forward test, fixture or the host read\'s self-test fixture', () => {
    const hits = files().flatMap((f) => coinLike(read(f)).map((t) => `${f}: ${t}`)).concat(coinLike(pyFixture()).map((t) => `${OWED}: ${t}`));
    expect(hits).toEqual([]);
    expect(files().length).toBeGreaterThanOrEqual(6);
  });

  it('the generator\'s form is reserved, and a planted token outside it is found', () => {
    expect(SYNTH_COINS.every((c) => SYNTH_COIN_FORM.test(c)) && SYNTH_COIN_FORM.test(SYNTH_PANEL)).toBe(true);
    expect(() => synthCoin(1000)).toThrow();
    const planted = ['Q', 'W', 'Z'].join('');
    expect(coinLike(`snapLine({ coin: '${planted}' })`)).toEqual([planted]);
    expect(coinLike(`|BINANCE|1h|${planted}|`)).toEqual([planted]);
    expect(coinLike(`snapLine({ coin: '${synthCoin(7)}', venue: 'BINANCE' })`)).toEqual([]);
  });
});
