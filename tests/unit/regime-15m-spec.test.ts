// tests/unit/regime-15m-spec.test.ts — EDGE-REGIME-15M-BACKTEST-W1 CH1: the sibling's registered constants, its pin
// list (test (d): the pin list equals the directory's listing) and the closure the registration pins. Nothing here
// reads a file another wave edits: src/lib is reached, never opened, and its pins are checked against T3's frozen
// registration.
import '../fixtures/regime-15m/isolate.js';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALPHA, B_BOOT, FIT, REGIME_AGAINST_MIN_CONFIDENCE, SEED, SPAN, TFS } from '../../src/scripts/regime-diag/diag-spec.js';
import * as spec from '../../src/scripts/regime-15m/r15-spec.js';
import { RUN_STATS } from '../../src/scripts/regime-15m/r15-stats.js';
import { runtimeClosure } from '../fixtures/regime-15m/closure.js';

const REPO = path.resolve(__dirname, '../..');
const DIR = 'src/scripts/regime-15m';

describe('regime-15m: the registered constants', () => {
  it('15m reads 100 bars, exported once; 1h, 4h and 1d are T3\'s', () => {
    expect(spec.REGIME_15M_WINDOW_BARS).toBe(100);
    expect(spec.TF15).toEqual({ key: '15m', min: 15, n: 100 });
    expect(spec.TIMEFRAMES.map((t) => [t.key, t.min, t.n])).toEqual([['15m', 15, 100], ...TFS.map((t) => [t.key, t.min, t.n])]);
    expect(TFS.map((t) => t.n)).toEqual([168, 42, 100]);
    // exported once: no other file of the directory spells the number as a window
    for (const f of fs.readdirSync(path.join(REPO, DIR)).filter((x) => x !== 'r15-spec.ts')) {
      expect(fs.readFileSync(path.join(REPO, DIR, f), 'utf8'), f).not.toMatch(/REGIME_15M_WINDOW_BARS\s*=/);
    }
  });

  it('the rows are T3\'s fit window, and the grid ends with it: no 2026 bar', () => {
    expect([spec.STUDY_SPAN.t0Ms, spec.STUDY_SPAN.n]).toEqual([SPAN.t0Ms, FIT.hi]);
    expect(spec.STUDY_WIN).toEqual(FIT);
    expect(new Date(spec.STUDY_SPAN.t0Ms).toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(new Date(spec.WINDOW_END_MS).toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect([spec.FIRST_MONTH, spec.LAST_MONTH]).toEqual(['2024-01', '2025-12']);
  });

  it('inherits T3\'s seed, resample count, alpha and confidence line by name', () => {
    expect([spec.STUDY_SEED, spec.BOOT, spec.STUDY_ALPHA, spec.D1_MIN_CONFIDENCE]).toEqual([SEED, B_BOOT, ALPHA, REGIME_AGAINST_MIN_CONFIDENCE]);
    expect([spec.RETENTION, spec.KEY_FLOOR_PP]).toEqual([0.5, 3.0]);
  });

  it('every seed arm is this study\'s own: prefixed, distinct, never one of T3\'s', () => {
    const arms = ['main', 'check:OKX', 'twin:OKX'].flatMap((run) => RUN_STATS.map((s) => spec.armOf(run, s)));
    expect(new Set(arms).size).toBe(arms.length);
    for (const a of arms) expect(a).toMatch(/^r15\|[^|]+\|[^|]+\|bootstrap$/);
    expect(arms.some((a) => /^(fit|holdout)\|/.test(a))).toBe(false);
    expect(RUN_STATS).toEqual(['A4.15m', 'D1.15m', 'A4.1h', 'D1.1h', 'A4.4h', 'D1.4h', 'A4.1d', 'D1.1d', 'A4.15m-1h', 'D1.15m-1h', 'key.CEILING.15m', 'key.NO_LAG.15m']);
  });

  it('the check venues and their resolutions are the registered ones', () => {
    expect(spec.CHECK_VENUES).toEqual(['BYBIT', 'OKX', 'BITGET']);
    expect(spec.CHECK_RESOLUTION_MIN).toEqual({ BYBIT: 1, OKX: 3, BITGET: 3 });
  });
});

describe('regime-15m: the pin list (test d) and the closure', () => {
  it('the pin list equals readdirSync of the sibling directory, sorted', () => {
    expect([...spec.SIBLING_FILES]).toEqual(fs.readdirSync(path.join(REPO, DIR)).sort());
  });

  it('pins every sibling file, T3\'s harness modules the read loads, the served rule\'s files T3 pinned, the bridge and T3\'s registration', () => {
    const closure = runtimeClosure(REPO, `${DIR}/r15-run.ts`, ['src/lib/']);
    const harness = closure.filter((f) => f.startsWith('src/scripts/regime-diag/'));
    // every T3 harness module the read loads is pinned, and nothing of the harness is pinned that it does not load
    expect(spec.CLOSURE_FILES.filter((f) => f.startsWith('src/scripts/regime-diag/'))).toEqual(harness);
    // the library files are T3's §10 pins for the served rule, but venue-fees.ts: no module of the read loads it (the
    // fee is T3's registered constant, and neither A4 nor Δ1 reads it)
    const lib = spec.CLOSURE_FILES.filter((f) => f.startsWith('src/lib/'));
    const t3Lib = [...fs.readFileSync(path.join(REPO, spec.T3_REGISTRATION), 'utf8').matchAll(/^\| `(src\/lib\/[^`]+)` \| `[0-9a-f]{64}` \|/gm)].map((m) => m[1]);
    expect(t3Lib).toContain('src/lib/market-regime-core.ts');
    expect(lib).toEqual(t3Lib.filter((f) => f !== 'src/lib/venue-fees.ts'));
    // every library file the sibling or the harness imports is pinned
    const reached = closure.filter((f) => f.startsWith('src/lib/'));
    expect(reached).toContain('src/lib/market-regime-core.ts');
    for (const f of reached) expect(lib, f).toContain(f);
    // the bridge's script and its two statistics modules, and T3's registration (the skeleton tables)
    expect(spec.CLOSURE_FILES).toEqual(expect.arrayContaining(['scripts/regime-diag/prims.py', 'src/scripts/cluster-perm-stats.py', 'ops/monitoring/population_comparison.py', spec.T3_REGISTRATION]));
    for (const f of spec.PINNED_REPO_FILES) expect(fs.existsSync(path.join(REPO, f)), f).toBe(true);
    expect(spec.PINNED_REPO_FILES).toEqual([...spec.SIBLING_FILES.map((f) => `${DIR}/${f}`), ...spec.CLOSURE_FILES]);
    expect(spec.INPUT_PINS).toEqual([spec.CENSUS_PIN, spec.ARCHIVES_PIN, spec.T3_FIT_PIN, spec.CHECK_PIN]);
  });

  it('the read never loads the fetcher: no file of the read\'s closure asks a venue for the check bars', () => {
    const closure = runtimeClosure(REPO, `${DIR}/r15-run.ts`, ['src/lib/']);
    expect(closure).not.toContain(`${DIR}/r15-fetch.ts`);
    // the fetcher is the only sibling file outside the read's closure
    expect(spec.SIBLING_FILES.filter((f) => !closure.includes(`${DIR}/${f}`))).toEqual(['r15-fetch.ts']);
  });

  it('no figure in the sibling: no venue symbol is spelled in its source (the panel comes from the census at run time)', () => {
    // The suite never lists the panel either: its names stay in the vault. A spelled symbol (<COIN>USDT, <COIN>-USDT,
    // <COIN>_USDT) is the shape a hard-coded coin takes; the code builds every symbol from the census.
    for (const f of spec.SIBLING_FILES) {
      const src = fs.readFileSync(path.join(REPO, DIR, f), 'utf8');
      expect(src.match(/['"`][A-Z0-9]{2,12}[-_]?USDT/g), f).toBeNull();
    }
  });
});
