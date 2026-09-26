/**
 * tests/unit/caller-tags.test.ts — OPS-UPSTREAM-ACQUISITION-ACCOUNTING-W1 CH1.
 *
 * One name, one lane, one spender. Pins: the registered builders; K3 (the `backfill` split), K4 (the
 * untagged interactive paths now named), K5 (lane-specific seed tags); the type-level REQUIREMENT of a
 * caller name; the `unattributed:<entrypoint>` default; class preservation against origin/main; and the
 * CALLER_TAG gate passing over the real tree.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import ts from 'typescript';
import {
  seedCallerTag, seedLane, processScopedTag, x402CallerTag, PID1_ENTRYPOINT,
} from '../../src/lib/caller-tags.js';
import { entrypointName, processEntrypoint } from '../../src/lib/runtime.js';
import {
  runAsCaller, runAsBatch, runAsInteractive, currentCaller, currentWeightClass, unattributedCaller,
} from '../../src/lib/upstream-weight-budget.js';
import { parseArgs } from '../../src/scripts/seed-signals.js';
// @ts-expect-error — plain .mjs gate module, no type declarations
import { runCheck } from '../../scripts/check-caller-tags.mjs';

const ROOT = process.cwd();

type Site = { file: string; line: number; helper: string; class: string; kind?: string; names?: string[]; base?: string; eps: string[] };
function realSites(): Site[] {
  const r = runCheck(ROOT);
  expect(r.result, 'the gate produced no analysis over the real tree').toBeTruthy();
  return r.result.sites as Site[];
}

// The 37 seed-signals crontab arg shapes live on signal-1 (measured 2026-09-26, timeframe and --top/--concurrency
// values elided). Their lane must be distinct per (tf, lane) — K5.
const CRONTAB_SHAPES: string[][] = [
  ['--exchange', 'HL'],
  ['--top', '50', '--exchange', 'HL'],
  ['--exchange-list', 'WEEX', '--top', '20'],
  ['--status', 'promoted', '--exclude', 'HL,WEEX', '--concurrency', '1'],
  ['--status', 'promoted', '--exclude', 'HL,WEEX', '--top', '100', '--concurrency', '1'],
  ['--top', '15', '--status', 'promoted', '--exclude', 'HL,WEEX', '--concurrency', '2'],
  ['--top', '100', '--status', 'shadow'],
  ['--exchange-list', 'BINANCE,BYBIT,OKX,BITGET', '--concurrency', '1'],
];

describe('seedCallerTag — seed:<tf>:<lane> (K5)', () => {
  it('maps every crontab shape to its lane, mirroring parseArgs precedence', () => {
    const lane = (a: string[]) => seedLane(parseArgs(['--timeframe', '5m', ...a]));
    expect(lane(CRONTAB_SHAPES[0])).toBe('hl');
    expect(lane(CRONTAB_SHAPES[1])).toBe('hl');
    expect(lane(CRONTAB_SHAPES[2])).toBe('weex');
    expect(lane(CRONTAB_SHAPES[3])).toBe('promoted');
    expect(lane(CRONTAB_SHAPES[4])).toBe('promoted');
    expect(lane(CRONTAB_SHAPES[5])).toBe('promoted');
    expect(lane(CRONTAB_SHAPES[6])).toBe('shadow');
    expect(lane(CRONTAB_SHAPES[7])).toBe('list-binance-bitget-bybit-okx');
    expect(lane([])).toBe('default');
  });

  it('K5 FIXED: at one timeframe the HL, promoted, shadow and WEEX lanes no longer share a tag', () => {
    const tags = new Set([CRONTAB_SHAPES[0], CRONTAB_SHAPES[2], CRONTAB_SHAPES[3], CRONTAB_SHAPES[6]]
      .map((a) => seedCallerTag(parseArgs(['--timeframe', '5m', ...a]))));
    expect(tags).toEqual(new Set(['seed:5m:hl', 'seed:5m:weex', 'seed:5m:promoted', 'seed:5m:shadow']));
  });

  it('an explicit --exchange override wins over --status, exactly as parseArgs resolves the venue set', () => {
    expect(seedLane(parseArgs(['--timeframe', '1h', '--exchange', 'HL', '--status', 'promoted']))).toBe('hl');
  });

  it('the runtime seam tags the whole seed run seed:<tf>:<lane> in the BATCH class', async () => {
    const seen = await runAsBatch(async () => ({ caller: currentCaller(), cls: currentWeightClass() }),
      seedCallerTag(parseArgs(['--timeframe', '30m', '--exchange', 'HL'])));
    expect(seen).toEqual({ caller: 'seed:30m:hl', cls: 'batch' });
  });
});

describe('processScopedTag / x402CallerTag — unique per entrypoint by construction', () => {
  it('is bare in PID 1 (every existing PID-1 tag keeps its value) and @<entrypoint> elsewhere', () => {
    expect(PID1_ENTRYPOINT).toBe('index');
    expect(processScopedTag('signal_perf_backfill', 'index')).toBe('signal_perf_backfill');
    expect(processScopedTag('signal_perf_backfill', 'seed-signals')).toBe('signal_perf_backfill@seed-signals');
    expect(processScopedTag('grid_warmer', 'index')).toBe('grid_warmer');
    expect(x402CallerTag('get_trade_signal', 'index')).toBe('x402:get_trade_signal');
    expect(x402CallerTag('get_trade_signal', 'seller-worker')).toBe('x402:get_trade_signal@seller-worker');
  });
});

describe('entrypoint name + the unattributed:<entrypoint> default (item 5)', () => {
  it('derives the basename with the extension stripped, and never throws', () => {
    expect(entrypointName('/app/dist/index.js')).toBe('index');
    expect(entrypointName('/app/dist/scripts/seed-signals.js')).toBe('seed-signals');
    expect(entrypointName('C:\\app\\dist\\scripts\\monitor.js')).toBe('monitor');
    expect(entrypointName('src/scripts/backfill-outcomes.ts')).toBe('backfill-outcomes');
    expect(entrypointName(undefined)).toBe('unknown-entrypoint');
    expect(entrypointName('')).toBe('unknown-entrypoint');
  });

  it('a no-context acquisition is attributed to unattributed:<this process>, never to a shared "unknown"', () => {
    expect(unattributedCaller('oi-snapshot-sampler')).toBe('unattributed:oi-snapshot-sampler');
    expect(currentCaller()).toBe(`unattributed:${processEntrypoint()}`);
    expect(currentCaller()).not.toBe('unknown');
  });
});

describe('class preservation — tags moved, classes did not', () => {
  it('runAsCaller never changes the class it runs in (so every NEW runAsCaller wrapper is class-neutral)', async () => {
    expect(await runAsCaller('x', async () => currentWeightClass())).toBe('interactive');
    expect(await runAsBatch(() => runAsCaller('x', async () => currentWeightClass()), 'outer')).toBe('batch');
    expect(await runAsInteractive(() => runAsCaller('x', async () => currentWeightClass()), 'outer')).toBe('interactive');
  });

  it('a named inner wrapper overrides the caller but keeps the class it sets', async () => {
    expect(await runAsBatch(async () => currentCaller(), 'inner')).toBe('inner');
    expect(await runAsCaller('outer', () => runAsBatch(async () => [currentCaller(), currentWeightClass()], 'outer')))
      .toEqual(['outer', 'batch']);
  });

  // Helper kinds per file, measured on origin/main 2dcafc2a (pre-wave) with the same gate's --manifest.
  const PRE_WAVE: Record<string, Record<string, number>> = {
    'src/index.ts': { runAsCaller: 9, runAsBatch: 3 },
    'src/lib/band-outcome-lane.ts': { runAsBatch: 1 },
    'src/lib/cross-asset-grid.ts': { runAsBatch: 1 },
    'src/lib/x402-http-routes.ts': { runAsCaller: 1 },
    'src/resources/signal-performance.ts': { runAsBatch: 1 },
    'src/scripts/backfill-directional-labels.ts': { runAsBatch: 1, runAsCaller: 1 },
    'src/scripts/backfill-hold-decision-labels.ts': { runAsBatch: 1 },
    'src/scripts/backfill-outcomes.ts': { runAsBatch: 1, runAsCaller: 1 },
    'src/scripts/frozen-window-attribution.ts': { runAsCaller: 1 },
    'src/scripts/seed-signals.ts': { runAsBatch: 1 },
  };
  // The only sites this wave ADDS — both runAsCaller (class-neutral, asserted above).
  const ADDED: Record<string, Record<string, number>> = {
    'src/scripts/backfill-funding-episodes.ts': { runAsCaller: 1 },
    'src/scripts/monitor.ts': { runAsCaller: 1 },
  };

  it('every pre-wave class-setting site survives unchanged; the only additions are class-neutral', () => {
    const now: Record<string, Record<string, number>> = {};
    for (const s of realSites()) { now[s.file] ??= {}; now[s.file][s.helper] = (now[s.file][s.helper] ?? 0) + 1; }
    expect(now).toEqual({ ...PRE_WAVE, ...ADDED });
    for (const f of Object.keys(ADDED)) for (const h of Object.keys(ADDED[f])) expect(h).toBe('runAsCaller');
  });
});

describe('K3 / K4 fixed on the real tree', () => {
  it('K3: no site emits `backfill`; the two halves have unique names, one entrypoint each', () => {
    const sites = realSites();
    expect(sites.flatMap((s) => s.names ?? [])).not.toContain('backfill');
    const cron = sites.filter((s) => s.names?.includes('backfill_outcomes_cron'));
    const srv = sites.filter((s) => s.names?.includes('backfill_outcomes_server'));
    expect(new Set(cron.map((s) => s.file))).toEqual(new Set(['src/scripts/backfill-outcomes.ts']));
    expect(new Set(srv.map((s) => s.file))).toEqual(new Set(['src/index.ts']));
    for (const s of [...cron, ...srv]) expect(s.eps).toHaveLength(1);
  });

  it('K4: the carry labeler\'s interactive child (backfill-funding-episodes) and monitor.ts are named, class unchanged', () => {
    const sites = realSites();
    const named = (file: string, name: string) => sites.find((s) => s.file === file && s.names?.includes(name));
    const fe = named('src/scripts/backfill-funding-episodes.ts', 'funding_episodes_backfill');
    const mon = named('src/scripts/monitor.ts', 'monitor');
    expect(fe?.helper).toBe('runAsCaller');
    expect(mon?.helper).toBe('runAsCaller');
    expect(named('src/scripts/backfill-hold-decision-labels.ts', 'hold_decision_labeler')?.helper).toBe('runAsBatch');
    expect(named('src/scripts/frozen-window-attribution.ts', 'frozen_window_attribution')?.helper).toBe('runAsCaller');
  });

  it('the CALLER_TAG gate passes over the real tree', () => {
    const r = runCheck(ROOT);
    expect(r.lines.join('\n')).toMatch(/no name is shared by two entrypoints/);
    expect(r.verdict).toBe('PASS');
  });
});

describe('a caller name is REQUIRED at the type level (item 1)', () => {
  it('an untagged runAsBatch / runAsInteractive does not compile (TS2554)', () => {
    const probe = path.join(ROOT, 'src', '__caller_required_probe__.ts');
    const code = [
      "import { runAsBatch, runAsInteractive } from './lib/upstream-weight-budget.js';",
      'void runAsBatch(async () => 1);',
      'void runAsInteractive(async () => 1);',
      "void runAsBatch(async () => 1, 'named');",
    ].join('\n');
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.Node16, moduleResolution: ts.ModuleResolutionKind.Node16,
      strict: true, noEmit: true, skipLibCheck: true, types: ['node'],
    };
    const host = ts.createCompilerHost(options);
    const orig = { getSourceFile: host.getSourceFile, fileExists: host.fileExists, readFile: host.readFile };
    host.getSourceFile = (f, lang, ...rest) => f === probe ? ts.createSourceFile(f, code, lang) : orig.getSourceFile.call(host, f, lang, ...rest);
    host.fileExists = (f) => f === probe || orig.fileExists.call(host, f);
    host.readFile = (f) => f === probe ? code : orig.readFile.call(host, f);
    const program = ts.createProgram([probe], options, host);
    const diags = program.getSemanticDiagnostics(program.getSourceFile(probe));
    const lines = diags.map((d) => d.file!.getLineAndCharacterOfPosition(d.start!).line + 1);
    expect(diags.map((d) => d.code)).toEqual([2554, 2554]); // the two untagged calls, and ONLY those
    expect(lines).toEqual([2, 3]);
  }, 60_000);
});
