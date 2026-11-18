// tests/unit/regime-forward-guard.test.ts — EDGE-REGIME-FORWARD-W1: the read's guard, its store, its seal and the run.
//
// Every run here is in a sandbox repository with a bare origin, on synthetic venues, with its home in a temporary
// directory: no test reads or writes the registered read's home, and `main()` (the only printer of the token) never
// runs. The order a read must keep — nothing fetched or scored before not_before, the registration landed and its
// pins whole, the census and the host record bound by sha256, the floors logged, every bar fetched and verified and
// every post-seal write rehearsed before the seal, nothing asked after it, and one read only — is a refusal with a
// test here. The CH3 audit's reproductions (ZZ1–ZZ9, vault audits/EDGE-REGIME-FORWARD-W1-log.md) are the F-tests.
// lesson 14: imported first — the homes resolve under the suite's own directory, fetch throws (isolate.ts)
import '../fixtures/regime-forward/isolate.js';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import inspector from 'node:inspector';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CALL_COLS, CENSUS_SHA256, FILES, NOT_BEFORE_MS, REGISTRATION, SEAM_HOST, SEAM_MARK, SERVED_FINGERPRINT, SNAP_COLS, TFS, VENUES, W0_MS, type Venue } from '../../src/scripts/regime-forward/forward-spec.js';
import { FLOORS, LOG, RESULT, SEAL, claimSeal, clockRefusal, forwardHome, homeRefusal, insideByIdentity, leverRefusal, log, rehearse, seamHomeRefusal } from '../../src/scripts/regime-forward/forward-guard.js';
import { censusRefusalFor, forwardRun, isPinnedSource, sourceRefusal, type Seam } from '../../src/scripts/regime-forward/forward-run.js';
import { MANIFEST, STORE } from '../../src/scripts/regime-forward/bar-store.js';
import { RateLimitedError, UnreachedError, pagesOf, restSource, spanOf, type BarSource } from '../../src/scripts/regime-forward/venue-bars.js';
import { pinsOf } from '../../src/scripts/sr-backtest/guard.js';
import { SYNTH_COINS, SYNTH_PANEL, candlesOf, priorLookSymbol, snapLine, synthBars, synthCoin, synthRows, synthServedTree } from '../fixtures/regime-forward/synth.js';
import { PRINTER, SERVED_FILES, fingerprintOf } from '../../src/scripts/regime-forward/served-fingerprint.js';
import { REAL_HOMEDIR, TEST_HOMEDIR } from '../fixtures/regime-forward/isolate.js';

afterEach(() => new Promise<void>((done) => { setImmediate(done); }));

/** Coin tokens come only from the synthetic generator (R6). */
const C1 = SYNTH_COINS[0], C2 = SYNTH_COINS[1];
const REPO = path.resolve(__dirname, '../..');
const RUN_FILE = path.join(REPO, 'src/scripts/regime-forward/forward-run.ts');
const sha = (b: Buffer | string): string => crypto.createHash('sha256').update(b).digest('hex');
const git = (repo: string, ...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const LABEL_NAMES = ['RANGING', 'TRENDING_UP', 'TRENDING_DOWN', 'VOLATILE'];
const OPTS: Seam['opts'] = { B: 99, shuffleB: 49, permB: 49, seeds: { a4Boot: 1, a4Shuffle: 2, a5Boot: 3, a5Shuffle: 4, mono: 5 }, floorClusters: 20 };
const PANEL = SYNTH_PANEL;
const PRIOR = priorLookSymbol();
/** The sandbox's served tree and the values a seam judges it by: its own fingerprint, under this process's printer. */
const SERVED_TREE = synthServedTree();
const SERVED_WANT = { fingerprint: fingerprintOf((f) => SERVED_TREE[f]).sha256, printer: PRINTER };
const NOW = NOT_BEFORE_MS + 3_600_000;

interface Call { v: Venue; coin: string; t: number; start: number; end: number; sealed: boolean; maxClose: number }
interface World {
  dir: string; repo: string; census: string; snap: string; results: string; home: string; calls: Call[]; seam: Seam; now: number;
  /** A venue answer that is an error for these pairs (a plain Error: the venue's answer, stored). */
  failCoin?: (v: Venue, coin: string, t: number) => boolean;
  /** Throws instead of answering (a rate limit, an unreachable venue). */
  raise?: (c: Call, n: number) => Error | null;
}

function world(opts: { push?: boolean; at?: string; caller?: string; panel?: string[] } = {}): World {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regime-forward-guard-'));
  const repo = path.join(dir, 'repo');
  git(dir, 'init', '-q', '--bare', '--initial-branch=main', 'origin.git');
  git(dir, 'init', '-q', '--initial-branch=main', 'repo');
  for (const [k, v] of [['user.email', 'sandbox@example.invalid'], ['user.name', 'sandbox'], ['commit.gpgsign', 'false'], ['core.hooksPath', path.join(dir, 'no-hooks')]]) git(repo, 'config', k, v);
  git(repo, 'remote', 'add', 'origin', path.join(dir, 'origin.git'));
  fs.writeFileSync(path.join(repo, 'README.md'), 'sandbox\n');
  fs.mkdirSync(path.join(repo, 'audits'));
  // review RV1: the served files the guard reads are the synthetic tree's, pinned here — never this checkout's
  for (const [f, t] of Object.entries(SERVED_TREE)) { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), t); }
  const pinRows = ['README.md', ...SERVED_FILES].map((f) => `| \`${f}\` | \`${sha(fs.readFileSync(path.join(repo, f)))}\` |`);
  fs.writeFileSync(path.join(repo, REGISTRATION), ['# sandbox registration', '', '| artifact | sha256 |', '|---|---|', ...pinRows, ''].join('\n'));
  git(repo, 'add', 'README.md', REGISTRATION, ...Object.keys(SERVED_TREE)); git(repo, 'commit', '-q', '-m', 'registration');
  if (opts.push !== false) git(repo, 'push', '-q', '-u', 'origin', 'main');

  const census = path.join(dir, 'census.json');
  fs.writeFileSync(census, JSON.stringify({ t3_weights: { panel: opts.panel ?? [PANEL], coins: { [PANEL]: 1 }, timeframes: { '1h': 0.5, '4h': 0.3, '1d': 0.2 } } }));
  const snap = path.join(dir, 'snap');
  fs.mkdirSync(snap);
  const lines = [SNAP_COLS.join('|')];
  for (const v of VENUES) for (const [pos, coin] of [...SYNTH_COINS, PANEL].entries()) for (let t = 0; t < TFS.length; t++) {
    for (const r of synthRows(v, t, coin, synthBars(v, t, pos), 'agree')) lines.push(snapLine({ venue: v, tf: TFS[t].key, coin, bar: r.bar, label: r.label, conf: r.conf, at: opts.at ?? SEAM_MARK }));
  }
  // E12: the symbol §3 drops as prior_look, on every venue — dropped by name, never planned or asked
  for (const v of VENUES) for (const r of synthRows(v, 0, PRIOR, synthBars(v, 0, 7), 'agree')) lines.push(snapLine({ venue: v, tf: TFS[0].key, coin: PRIOR, bar: r.bar, label: r.label, conf: r.conf, at: opts.at ?? SEAM_MARK }));
  fs.writeFileSync(path.join(snap, FILES[0]), zlib.gzipSync(`${lines.join('\n')}\n`));
  fs.writeFileSync(path.join(snap, FILES[1]), 'exchange|timeframe|bar_close_ms\n');
  fs.writeFileSync(path.join(snap, FILES[2]), `${CALL_COLS.join('|')}\n2026-11-20T01:00:00Z|BINANCE|1h|${C1}|${LABEL_NAMES[1]}|BUY|paid|${opts.caller ?? SEAM_MARK}\n`);
  const results = path.join(dir, 'canary-results.jsonl');
  writeRecord(results, snap, 'PASS');

  const w = { dir, repo, census, snap, results, home: path.join(dir, 'home', 'regime-forward'), calls: [], now: NOW } as unknown as World;
  const source: BarSource = async (v, coin, tf, start, end) => {
    const t = TFS.findIndex((x) => x.key === tf.key), pos = [...SYNTH_COINS, PANEL].indexOf(coin);
    const cs = candlesOf(v, t, synthBars(v, t, pos)).filter((c) => c.time >= start && c.time < end);
    const call: Call = { v, coin, t, start, end, sealed: fs.existsSync(path.join(w.home, SEAL)), maxClose: cs.reduce((m, c) => Math.max(m, c.time + tf.min * 60_000), 0) };
    w.calls.push(call);
    const e = w.raise?.(call, w.calls.filter((c) => c.v === v).length);
    if (e) throw e;
    if (w.failCoin?.(v, coin, t)) throw new Error('the venue answered an error');
    return cs;
  };
  w.seam = { home: w.home, now: () => w.now, source, opts: OPTS, censusSha256: sha(fs.readFileSync(census)), fetch: false, served: SERVED_WANT };
  return w;
}

function writeRecord(results: string, snap: string, verdict: string, host = SEAM_HOST): void {
  const files = Object.fromEntries(FILES.map((f) => [f, { sha256: sha(fs.readFileSync(path.join(snap, f))), bytes: 0, rows: 0 }]));
  fs.writeFileSync(results, `${JSON.stringify({ at: '2026-12-30T08:27:10Z', host, canary: 'owed_read', verdict, exit_code: 0, metrics: { read_id: 'regime-forward-30d', files } })}\n`);
}

const runOf = (w: World): ReturnType<typeof forwardRun> => forwardRun({ repo: w.repo, censusFile: w.census, snapshotDir: w.snap, resultsLog: w.results, seam: w.seam });
const legs = (w: World): string[] => fs.readFileSync(path.join(w.home, LOG), 'utf8').trim().split('\n').map((l) => JSON.parse(l).leg as string);
const lines = (w: World): Array<Record<string, unknown>> => fs.readFileSync(path.join(w.home, LOG), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const result = (r: { file: string | null }): any => JSON.parse(fs.readFileSync(r.file as string, 'utf8')); // eslint-disable-line @typescript-eslint/no-explicit-any
const byVenue = (res: any, v: Venue): any => res.venues.find((x: { venue: string }) => x.venue === v); // eslint-disable-line @typescript-eslint/no-explicit-any
/** Every file under a directory, by relative path, with its bytes' sha256. */
const tree = (d: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (p: string): void => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const q = path.join(p, e.name); if (e.isDirectory()) walk(q); else out[path.relative(d, q)] = sha(fs.readFileSync(q)); } };
  if (fs.existsSync(d)) walk(d);
  return out;
};

describe('one read, in the registered order', () => {
  it('fetches every bar before the seal, asks nothing after it, scores four venues and writes its result in the home only (F16)', async () => {
    const w = world();
    const r = await runOf(w);
    expect([r.verdict, r.reason]).toEqual(['PASS', 'ok']);
    // labels that follow key A on every venue: A4 reads PASS on each (A5's state is whatever the swings give)
    expect(r.line).toMatch(/^REGIME_FORWARD_VERDICT=BINANCE:A4=PASS,A5=(PASS|FAIL|INDETERMINATE);BYBIT:A4=PASS,A5=\w+;OKX:A4=PASS,A5=\w+;BITGET:A4=PASS,A5=\w+$/);
    expect(r.file).toBe(path.join(w.home, RESULT));
    const res = result(r);
    expect([res.study, res.line, res.parity.calls]).toEqual(['injected', r.line, 1]);
    expect(res.drops.panel).toBeGreaterThan(0);
    expect(w.calls.some((c) => c.coin === PANEL)).toBe(false);
    expect(res.drops.prior_look).toBeGreaterThan(0);
    expect(w.calls.some((c) => c.coin === PRIOR)).toBe(false);
    // one request per coin × timeframe, every one of them made while no seal existed
    expect(w.calls.length).toBe(VENUES.length * SYNTH_COINS.length * TFS.length);
    expect(w.calls.filter((c) => c.sealed)).toEqual([]);
    expect(legs(w)).toEqual(['floors', 'bars', 'rehearsal', 'rehearsal', 'seal', 'result']);
    // the manifest the bars leg logged is the one on disk, and the seal and the result carry it
    const barsLine = lines(w).find((l) => l.leg === 'bars') as { sha256: string };
    expect(barsLine.sha256).toBe(sha(fs.readFileSync(path.join(w.home, MANIFEST))));
    expect(JSON.parse(fs.readFileSync(path.join(w.home, SEAL), 'utf8')).bars_manifest_sha256).toBe(barsLine.sha256);
    expect(res.bars_manifest_sha256).toBe(barsLine.sha256);
    expect(fs.existsSync(path.join(w.home, FLOORS))).toBe(true);
    expect(git(w.repo, 'status', '--porcelain')).toBe('');
  }, 120_000);

  it('F1 (ZZ1): a second run after the read is refused at once — the result, floors, log and store byte-identical, nothing asked', async () => {
    const w = world();
    expect((await runOf(w)).verdict).toBe('PASS');
    const before = tree(w.home), n = w.calls.length;
    const r = await runOf(w);
    expect([r.verdict, r.reason]).toEqual(['REFUSED', 'the seal exists: T5 has been read']);
    expect(tree(w.home)).toEqual(before);
    expect(JSON.parse(fs.readFileSync(path.join(w.home, RESULT), 'utf8')).line).toBe(result({ file: path.join(w.home, RESULT) }).line);
    expect(w.calls.length).toBe(n);
  }, 120_000);

  it('before not_before nothing is read, fetched or written (clock)', async () => {
    const w = world();
    w.now = NOT_BEFORE_MS - 1;
    const r = await runOf(w);
    expect(r.verdict).toBe('REFUSED');
    expect(r.reason).toMatch(/before not_before 2026-12-30T08:00:00.000Z/);
    expect(w.calls).toEqual([]);
    expect(fs.existsSync(w.home)).toBe(false);
  });
});

describe('each guard leg refuses before the seal', () => {
  const refusedBeforeSeal = async (w: World, re: RegExp, verdict = 'REFUSED'): Promise<void> => {
    const r = await runOf(w);
    expect(r.verdict).toBe(verdict);
    expect(r.reason).toMatch(re);
    expect(fs.existsSync(path.join(w.home, SEAL))).toBe(false);
  };

  it('a registration that is not on origin/main', async () => { const w = world({ push: false }); await refusedBeforeSeal(w, /not on origin\/main/); expect(w.calls).toEqual([]); });

  it('a pinned file that differs from its pin', async () => {
    const w = world();
    fs.writeFileSync(path.join(w.repo, 'README.md'), 'edited\n');
    await refusedBeforeSeal(w, /pinned README\.md differs/);
    expect(w.calls).toEqual([]);
  });

  /** Appends a dated amendment re-pinning `f` to its present bytes, and lands it on the sandbox's origin. */
  const repin = (w: World, f: string): void => {
    fs.appendFileSync(path.join(w.repo, REGISTRATION), `\n## Amendment\n\n| \`${f}\` | \`${sha(fs.readFileSync(path.join(w.repo, f)))}\` |\n`);
    git(w.repo, 'add', REGISTRATION, f); git(w.repo, 'commit', '-q', '-m', 'amendment'); git(w.repo, 'push', '-q', 'origin', 'main');
  };
  const aliasIn = (w: World, f: string): void => {
    const p = path.join(w.repo, f), t = fs.readFileSync(p, 'utf8'), u = t.replace('const TRADFI_ALIASES: Record<string, string> = {', `const TRADFI_ALIASES: Record<string, string> = {\n  ${synthCoin(21)}: '${synthCoin(22)}',`);
    expect(u).not.toBe(t); fs.writeFileSync(p, u);
  };

  it('RV1, FP: an alias added to a served file and re-pinned by an amendment → REFUSED (registration), the fingerprint moved', async () => {
    const w = world();
    aliasIn(w, 'src/lib/adapters/okx.ts'); repin(w, 'src/lib/adapters/okx.ts');
    await refusedBeforeSeal(w, /source fingerprint .* differs from the registered/);
    expect(w.calls).toEqual([]);
  });

  it('RV1, FP: a statement that writes a map the functions read, re-pinned → REFUSED; an unrelated function, re-pinned → read on', async () => {
    const w = world(), f = 'src/lib/adapters/binance.ts';
    fs.appendFileSync(path.join(w.repo, f), `\nObject.assign(SYMBOL_OVERRIDES, { ${synthCoin(21)}: '${synthCoin(22)}' });\n`); repin(w, f);
    await refusedBeforeSeal(w, /source fingerprint .* differs/);
    const u = world();
    fs.appendFileSync(path.join(u.repo, f), '\nexport function unrelated3(): number { return 3; }\n'); repin(u, f);
    fs.rmSync(u.census);
    await refusedBeforeSeal(u, /census file is absent/, 'INDETERMINATE'); // past the registration leg
  });

  it('PRN: another printer over served files byte-identical to their pins → read on; over a re-pinned alias → REFUSED as a printer mismatch', async () => {
    const w = world();
    w.seam = { ...w.seam, served: { ...SERVED_WANT, printer: 'p-other' } };
    fs.rmSync(w.census);
    await refusedBeforeSeal(w, /census file is absent/, 'INDETERMINATE');
    const u = world();
    u.seam = { ...u.seam, served: { ...SERVED_WANT, printer: 'p-other' } };
    aliasIn(u, 'src/lib/adapters/okx.ts'); repin(u, 'src/lib/adapters/okx.ts');
    await refusedBeforeSeal(u, /printer .* is not the registered p-other.*printer mismatch/);
  });

  it('a census that is not the pinned one', async () => {
    const w = world();
    fs.appendFileSync(w.census, ' ');
    await refusedBeforeSeal(w, /census does not hash/);
  });

  it('a snapshot file that is not the bytes the host recorded', async () => {
    const w = world();
    fs.appendFileSync(path.join(w.snap, FILES[1]), 'x\n');
    await refusedBeforeSeal(w, /runs\.psv does not hash/);
  });

  it('a host read that did not PASS reads INDETERMINATE', async () => {
    const w = world();
    writeRecord(w.results, w.snap, 'INDETERMINATE');
    await refusedBeforeSeal(w, /not PASS/, 'INDETERMINATE');
  });

  it('a home inside the repository', async () => {
    const w = world();
    w.seam = { ...w.seam, home: path.join(w.repo, 'audits', 'home') };
    await refusedBeforeSeal(w, /inside the repository/);
    expect(fs.existsSync(path.join(w.repo, 'audits', 'home'))).toBe(false);
  });

  it('a home that reaches the repository through a link (identity, not spelling)', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'regime-forward-link-'));
    fs.symlinkSync(REPO, path.join(d, 'r'));
    expect(insideByIdentity(path.join(d, 'r', 'tmp', 'home'), REPO)).toBe(true);
    expect(homeRefusal(path.join(d, 'r', 'tmp', 'home'), REPO)).toMatch(/inside the repository/);
    expect(homeRefusal(path.join(d, 'home'), REPO)).toBeNull();
  });

  it('a result name that is a link fails the rehearsal, and nothing is sealed', async () => {
    const w = world();
    fs.mkdirSync(w.home, { recursive: true });
    fs.symlinkSync(path.join(w.dir, 'elsewhere.json'), path.join(w.home, RESULT));
    await refusedBeforeSeal(w, /symbolic link/);
    expect(fs.existsSync(path.join(w.dir, 'elsewhere.json'))).toBe(false);
  });

  it('the harness refuses to run as a copy: only the pinned source in the repository is the registered read', () => {
    expect(isPinnedSource(path.join(REPO, 'src/scripts/regime-forward/forward-run.ts'), REPO)).toBe(true);
    expect(isPinnedSource(path.join(REPO, 'dist/scripts/regime-forward/forward-run.js'), REPO)).toBe(false);
  });

  /** A scratch tree whose forward-run.ts is a link to this checkout's (re-check N4); never a git repository. */
  const linkedTree = (): string => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'regime-forward-linked-'));
    fs.mkdirSync(path.join(t, 'src/scripts/regime-forward'), { recursive: true });
    fs.symlinkSync(RUN_FILE, path.join(t, 'src/scripts/regime-forward/forward-run.ts'));
    return t;
  };

  it('N4: the read judges only the checkout that runs it — a tree linking to the running forward-run.ts is refused, by real path and identity', () => {
    expect(sourceRefusal(RUN_FILE, REPO)).toBeNull();
    const t = linkedTree();
    expect(isPinnedSource(RUN_FILE, t)).toBe(true); // the file check alone is satisfied by the link
    expect(sourceRefusal(RUN_FILE, t)).toMatch(/judges only the checkout that runs it/);
    const alias = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'regime-forward-alias-')), 'repo');
    fs.symlinkSync(REPO, alias); // the same checkout under another spelling is the same checkout
    expect(sourceRefusal(RUN_FILE, alias)).toBeNull();
    expect(sourceRefusal(path.join(REPO, 'dist/scripts/regime-forward/forward-run.js'), REPO)).toMatch(/pinned source|checkout that runs/);
  });

  it('N4: a run without a seam over a tree linking to the running forward-run.ts → REFUSED at source, logged, nothing else read', async () => {
    const t = linkedTree(), home = forwardHome();
    try {
      const r = await forwardRun({ repo: t, censusFile: path.join(t, 'census.json'), snapshotDir: t, resultsLog: path.join(t, 'results.jsonl') });
      expect(r.verdict).toBe('REFUSED');
      expect(r.reason).toMatch(/judges only the checkout that runs it/);
      expect(fs.readFileSync(path.join(home, LOG), 'utf8').trim().split('\n').map((l) => JSON.parse(l).leg)).toEqual(['source']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true }); // under the suite's own directory (isolate.ts)
    }
  });
});

describe('F2 (ZZ7): a test seam never reads the registered inputs', () => {
  it('the registered census → REFUSED; the registered read takes only it', () => {
    expect(censusRefusalFor(CENSUS_SHA256, sha('a seam census'))).toBe('a test seam never reads the registered census');
    expect(censusRefusalFor(CENSUS_SHA256, CENSUS_SHA256)).toBe('a test seam never reads the registered census');
    expect(censusRefusalFor(sha('a seam census'), sha('a seam census'))).toBeNull();
    expect(censusRefusalFor(CENSUS_SHA256, null)).toBeNull();
    expect(censusRefusalFor(sha('a seam census'), null)).toBe('the census does not hash to its pin');
  });

  it('RV1: a seam judging by the registered served fingerprint → REFUSED (registration), nothing asked', async () => {
    const w = world();
    w.seam = { ...w.seam, served: { fingerprint: SERVED_FINGERPRINT, printer: PRINTER } };
    const r = await runOf(w);
    expect([r.verdict, r.reason]).toEqual(['REFUSED', 'a test seam never judges by the registered served fingerprint']);
    expect(w.calls).toEqual([]);
  });

  it('a signal-1 record of this read in the results log → REFUSED, nothing asked, nothing sealed', async () => {
    const w = world();
    fs.appendFileSync(w.results, `${JSON.stringify({ at: '2026-12-30T07:00:00Z', host: 'signal-1', canary: 'owed_read', verdict: 'INDETERMINATE', metrics: { read_id: 'regime-forward-30d' } })}\n`);
    const r = await runOf(w);
    expect([r.verdict, r.reason]).toEqual(['REFUSED', 'a test seam never reads a signal-1 record of this read']);
    expect(w.calls).toEqual([]);
    expect(fs.existsSync(path.join(w.home, SEAL))).toBe(false);
  });

  it('the registered home, a home under it or one holding it → REFUSED before anything is written', async () => {
    // forwardHome() resolves under the suite's own directory (isolate.ts), never the real one, mutated or not
    const reg = forwardHome();
    expect(path.relative(TEST_HOMEDIR, reg).startsWith('..')).toBe(false);
    expect(path.relative(REAL_HOMEDIR, reg).startsWith('..')).toBe(true);
    expect(seamHomeRefusal(reg)).toMatch(/registered home/);
    expect(seamHomeRefusal(path.join(reg, 'sub'))).toMatch(/registered home/);
    expect(seamHomeRefusal(path.dirname(reg))).toMatch(/registered home/);
    expect(seamHomeRefusal(fs.mkdtempSync(path.join(os.tmpdir(), 'regime-forward-other-')))).toBeNull();
    // an existing home with a file in it: a run that wrote anything into it would change its tree (re-check R1)
    fs.mkdirSync(reg, { recursive: true });
    fs.writeFileSync(path.join(reg, 'existing.txt'), 'a file the run must not touch\n');
    const was = tree(reg), w = world();
    w.seam = { ...w.seam, home: reg };
    const r = await runOf(w);
    expect([r.verdict, r.reason]).toEqual(['REFUSED', 'a test seam never uses the registered home']);
    expect(tree(reg)).toEqual(was);
    expect(fs.existsSync(path.join(reg, SEAL))).toBe(false);
    expect(w.calls).toEqual([]);
  });

  it('R3: a seam given the network source → REFUSED before anything is written; fetch never called', async () => {
    const w = world(), f = vi.spyOn(globalThis, 'fetch');
    w.seam = { ...w.seam, source: restSource() };
    const r = await runOf(w);
    expect([r.verdict, r.reason]).toEqual(['REFUSED', 'a test seam never uses the network source']);
    expect(fs.existsSync(w.home)).toBe(false);
    expect(f).not.toHaveBeenCalled();
    f.mockRestore();
  });

  it('R3: the registered snapshot under a relabelled host — rows as the host read writes them, a sandbox PASS record — → REFUSED (load), nothing asked or sealed', async () => {
    for (const w of [world({ at: String(W0_MS + 60_000) }), world({ caller: '0123456789ab' })]) {
      expect(fs.readFileSync(w.results, 'utf8')).toContain(`"host":"${SEAM_HOST}"`);
      const r = await runOf(w);
      expect([r.verdict, r.reason]).toEqual(['REFUSED', 'a test seam reads only a synthetic snapshot: a row or a call does not carry the seam mark']);
      expect(legs(w)).toEqual(['load']);
      expect(w.calls).toEqual([]);
      expect(fs.existsSync(path.join(w.home, SEAL))).toBe(false);
    }
  });

  it('R3: a census that names no panel → REFUSED (census), nothing asked', async () => {
    const w = world({ panel: [] });
    const r = await runOf(w);
    expect([r.verdict, r.reason]).toEqual(['REFUSED', 'the census names no panel: its coins would be fetched and scored']);
    expect(legs(w)).toEqual(['census']);
    expect(w.calls).toEqual([]);
  });
});

describe('F3 (ZZ2): the run log is written through no link and no second name', () => {
  it('run.log planted as a symbolic link into the repository: REFUSED, the target never written, no seal, nothing asked', async () => {
    const w = world();
    fs.mkdirSync(w.home, { recursive: true });
    const target = path.join(w.repo, 'audits', 'zz-planted.log');
    fs.symlinkSync(target, path.join(w.home, LOG));
    const r = await runOf(w);
    expect(r.verdict).toBe('REFUSED');
    expect(r.reason).toMatch(/run\.log refused: run\.log is a symbolic link/);
    expect(fs.existsSync(target)).toBe(false);
    expect(git(w.repo, 'status', '--porcelain')).toBe('');
    expect(fs.existsSync(path.join(w.home, SEAL))).toBe(false);
    expect(w.calls).toEqual([]);
  }, 120_000);

  it('run.log with a second name: REFUSED, the other name untouched, no seal', async () => {
    const w = world();
    fs.mkdirSync(w.home, { recursive: true });
    const other = path.join(w.dir, 'other-name.log');
    fs.writeFileSync(other, 'untouched\n');
    fs.linkSync(other, path.join(w.home, LOG));
    const r = await runOf(w);
    expect(r.verdict).toBe('REFUSED');
    expect(r.reason).toMatch(/run\.log has 2 names/);
    expect(fs.readFileSync(other, 'utf8')).toBe('untouched\n');
    expect(fs.existsSync(path.join(w.home, SEAL))).toBe(false);
  }, 120_000);

  it('log() itself refuses a link, a directory and a second name, and never throws', () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), 'regime-forward-log-'));
    expect(log(h, { leg: 'x' })).toBeNull();
    fs.rmSync(path.join(h, LOG));
    fs.symlinkSync(path.join(h, 'target'), path.join(h, LOG));
    expect(log(h, { leg: 'x' })).toMatch(/symbolic link/);
    expect(fs.existsSync(path.join(h, 'target'))).toBe(false);
    fs.rmSync(path.join(h, LOG));
    fs.mkdirSync(path.join(h, LOG));
    expect(log(h, { leg: 'x' })).toMatch(/not a regular file/);
  });
});

describe('F4 (ZZ3): a bridge failure in the label floors is leg floors, before any request', () => {
  it('python3 failing: INDETERMINATE, leg floors logged, no seal, nothing asked', async () => {
    const w = world();
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'regime-forward-pyfail-'));
    fs.writeFileSync(path.join(bin, 'python3'), '#!/bin/sh\necho "test stub: python3 unavailable" >&2\nexit 1\n', { mode: 0o755 });
    const old = process.env.PATH;
    process.env.PATH = `${bin}:${old}`;
    let r: Awaited<ReturnType<typeof forwardRun>>;
    try { r = await runOf(w); } finally { process.env.PATH = old; }
    expect(r.verdict).toBe('INDETERMINATE');
    expect(legs(w)).toEqual(['floors']);
    expect(lines(w)[0].ok).toBe(false);
    expect(fs.existsSync(path.join(w.home, SEAL))).toBe(false);
    expect(w.calls).toEqual([]);
  }, 120_000);
});

describe('F5 (ZZ4): every bar asked opens inside key A\'s span and closes at or before its end', () => {
  it('no requested bar closes after W1 + 14 bars (so none after not_before), none opens before W0 − 14 bars', async () => {
    const w = world();
    expect((await runOf(w)).verdict).toBe('PASS');
    for (const c of w.calls) {
      const s = spanOf(c.v, TFS[c.t]);
      expect([c.start, c.end]).toEqual([s.startMs, s.endMs]);
      expect(c.maxClose).toBeLessThanOrEqual(W0_MS + 30 * 86_400_000 + 14 * TFS[c.t].min * 60_000);
      expect(c.maxClose).toBeLessThanOrEqual(NOT_BEFORE_MS);
    }
  }, 120_000);
});

describe('F6 (ZZ5): a coin whose request fails at one timeframe is dropped whole', () => {
  it('failing at 4h only and failing at every timeframe give the same A4 rows and A5 runs', async () => {
    const wA = world(); wA.failCoin = (v, coin, t) => v === 'BYBIT' && coin === C1 && t === 1;
    const wB = world(); wB.failCoin = (v, coin) => v === 'BYBIT' && coin === C1;
    const [rA, rB] = [await runOf(wA), await runOf(wB)];
    expect([rA.verdict, rB.verdict]).toEqual(['PASS', 'PASS']);
    const a = result(rA), b = result(rB);
    expect([a.bars.BYBIT.failed, b.bars.BYBIT.failed]).toEqual([1, 1]);
    expect(byVenue(a, 'BYBIT').A4.eff).toBe(byVenue(b, 'BYBIT').A4.eff);
    expect(byVenue(a, 'BYBIT').A5.eff).toBe(byVenue(b, 'BYBIT').A5.eff);
    expect(byVenue(a, 'BYBIT').descriptive.flipflops).toEqual(byVenue(b, 'BYBIT').descriptive.flipflops);
    // the coin's 1h request succeeded in A and its bars are on disk, yet nothing of it is scored
    expect(wA.calls.some((c) => c.v === 'BYBIT' && c.coin === C1 && c.t === 0)).toBe(true);
  }, 240_000);
});

describe('F8 (ZZ9): a fault while the seal record is written', () => {
  it('is logged as leg seal and never thrown past the read; the seal stays claimed', async () => {
    const w = world();
    // the seal record is the read's one fsync: every fsync of the run fails as the disk would
    const spy = vi.spyOn(fs, 'fsyncSync').mockImplementation(() => { throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' }); });
    let r: Awaited<ReturnType<typeof forwardRun>>;
    try { r = await runOf(w); } finally { spy.mockRestore(); }
    expect(r.verdict).toBe('INDETERMINATE');
    expect(r.reason).toMatch(/^after the seal: the seal record: EIO/);
    expect(legs(w).slice(-1)).toEqual(['seal']);
    expect(lines(w).slice(-1)[0].ok).toBe(false);
    expect(fs.existsSync(path.join(w.home, SEAL))).toBe(true);
    expect(w.calls.filter((c) => c.sealed)).toEqual([]);
  }, 120_000);

  it('claimSeal: a second claim is refused unclaimed; a fault after the exclusive create is claimed with its reason', () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), 'regime-forward-seal-'));
    expect(claimSeal(h, { n: 1 })).toEqual({ claimed: true, reason: null });
    expect(claimSeal(h, { n: 2 })).toEqual({ claimed: false, reason: 'the seal exists: T5 has been read' });
    expect(JSON.parse(fs.readFileSync(path.join(h, SEAL), 'utf8')).n).toBe(1);
  });
});

describe('F16: every bar before the seal; a rate limit or an unreachable venue spends nothing', () => {
  it('a 429 on BINANCE stops BINANCE at once, the others finish, nothing is sealed; a run before its Retry-After asks it nothing; after it, the read resumes and completes', async () => {
    const w = world();
    const until = NOW + 120_000;
    w.raise = (c, n) => (c.v === 'BINANCE' && n === 5 ? new RateLimitedError('BINANCE', until, 'BINANCE HTTP 429: no request to it before …') : null);
    const r1 = await runOf(w);
    expect(r1.verdict).toBe('INDETERMINATE');
    expect(r1.reason).toMatch(/^before the seal: BINANCE HTTP 429/);
    expect(r1.reason).toContain(new Date(until).toISOString());
    expect(fs.existsSync(path.join(w.home, SEAL))).toBe(false);
    expect(w.calls.filter((c) => c.v === 'BINANCE')).toHaveLength(5);
    for (const v of VENUES.filter((x) => x !== 'BINANCE')) expect(w.calls.filter((c) => c.v === v)).toHaveLength(SYNTH_COINS.length * TFS.length);
    expect(legs(w)).toEqual(['floors', 'bars']);

    w.raise = undefined;
    const n1 = w.calls.length;
    w.now = until - 1;
    const r2 = await runOf(w);
    expect(r2.verdict).toBe('INDETERMINATE');
    expect(w.calls.slice(n1).filter((c) => c.v === 'BINANCE')).toEqual([]);
    expect(w.calls.length).toBe(n1); // the other venues' answers are in the store: nothing is asked again

    w.now = until;
    const r3 = await runOf(w);
    expect(r3.verdict).toBe('PASS');
    // only BINANCE's unanswered pairs were asked: 12 pairs, 4 answered before the 429
    expect(w.calls.slice(n1).map((c) => c.v)).toEqual(Array(SYNTH_COINS.length * TFS.length - 4).fill('BINANCE'));
    expect(w.calls.filter((c) => c.sealed)).toEqual([]);
  }, 240_000);

  it('an unreachable venue leaves the seal unclaimed (INDETERMINATE) and a later run resumes', async () => {
    const w = world();
    w.raise = (c) => (c.v === 'OKX' ? new UnreachedError('OKX', 'OKX unreached after three tries: down') : null);
    const r = await runOf(w);
    expect(r.verdict).toBe('INDETERMINATE');
    expect(r.reason).toMatch(/^before the seal: OKX unreached/);
    expect(fs.existsSync(path.join(w.home, SEAL))).toBe(false);
    w.raise = undefined;
    expect((await runOf(w)).verdict).toBe('PASS');
  }, 240_000);

  it('a store file that is not the read\'s refuses the read before the seal', async () => {
    const w = world();
    w.raise = (c) => (c.v === 'OKX' ? new UnreachedError('OKX', 'down') : null);
    await runOf(w);
    const f = path.join(w.home, STORE, 'BYBIT', '1h', `${C1}.json`);
    const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    fs.writeFileSync(f, JSON.stringify({ ...s, fetched_at_ms: NOT_BEFORE_MS - 1 }));
    w.raise = undefined;
    const r = await runOf(w);
    expect([r.verdict, r.reason]).toEqual(['REFUSED', `before the seal: ${path.join(STORE, 'BYBIT', '1h', `${C1}.json`)} was fetched before not_before`]);
    expect(fs.existsSync(path.join(w.home, SEAL))).toBe(false);
  }, 240_000);
});

describe('after the seal', () => {
  it('a venue with more than 5 % of its coins without bars reads INDETERMINATE on both answers; the read still completes', async () => {
    const w = world();
    w.failCoin = (v, coin) => v === 'BYBIT' && coin === C1;
    const r = await runOf(w);
    expect(r.verdict).toBe('PASS');
    expect(r.line).toMatch(/BYBIT:A4=INDETERMINATE,A5=INDETERMINATE/);
    const res = result(r);
    expect(res.bars.BYBIT.failed).toBe(1);
    expect(byVenue(res, 'BYBIT').A4.cause).toMatch(/^BARS_UNAVAILABLE: 1 of 4/);
  }, 120_000);

  it('a statistic that cannot be computed reads INDETERMINATE, leg score, and the seal stays claimed', async () => {
    const w = world();
    w.seam = { ...w.seam, opts: { ...w.seam.opts, shuffleB: -1 } }; // A5 cannot size its shuffle store: a throw inside T3's code
    const r = await runOf(w);
    expect(r.verdict).toBe('INDETERMINATE');
    expect(r.reason).toMatch(/^after the seal: /);
    expect(legs(w).slice(-2)).toEqual(['seal', 'score']);
    expect(fs.existsSync(path.join(w.home, SEAL))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(w.home, RESULT), 'utf8'))).toEqual({ rehearsal: 2 }); // the rehearsal's, never a result
    expect(w.calls.filter((c) => c.sealed)).toEqual([]);
  }, 120_000);
});

describe('the pieces the order rests on', () => {
  it('the clock refuses before not_before and passes at it (clock)', () => {
    expect(clockRefusal(NOT_BEFORE_MS - 1)).toMatch(/before not_before/);
    expect(clockRefusal(NOT_BEFORE_MS)).toBeNull();
  });

  it('the test-only lever, when set, refuses every read', () => {
    expect(leverRefusal('', '')).toBeNull();
    expect(leverRefusal('clock', '')).toMatch(/REGIME_FORWARD_MUTATE=clock/);
    expect(leverRefusal('', 'keyseq')).toMatch(/REGIME_DIAG_MUTATE=keyseq/);
  });

  it('the seal is claimed once (seal)', () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), 'regime-forward-seal-'));
    expect(claimSeal(h, { n: 1 }).claimed).toBe(true);
    expect(claimSeal(h, { n: 2 })).toEqual({ claimed: false, reason: 'the seal exists: T5 has been read' });
    expect(JSON.parse(fs.readFileSync(path.join(h, SEAL), 'utf8')).n).toBe(1);
  });

  it('the rehearsal replaces the result twice and appends the log twice, and refuses a hard-linked log', () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), 'regime-forward-rehearse-'));
    expect(rehearse(h)).toBeNull();
    expect(fs.readFileSync(path.join(h, RESULT), 'utf8')).toBe('{"rehearsal":2}\n');
    fs.linkSync(path.join(h, LOG), path.join(h, 'second-name'));
    expect(rehearse(h)).toMatch(/run\.log has 2 names/);
  });
});

/**
 * F9's scope (ruling 23:14, N5): the modules T5 owns or freezes — its own, ops/ and T3's core it calls. A served
 * module (src/lib) and whatever it reaches are the guard's to judge at the read, by their pins: never this test's
 * (arc lesson 15), so another wave's refactor of an adapter cannot turn this suite red.
 */
const F9_SCOPE = /^(src\/scripts\/regime-forward\/|src\/scripts\/regime-diag\/|scripts\/regime-diag\/|ops\/)/;
const unpinnedInScope = (called: Iterable<string>, pins: ReadonlyMap<string, string>): string[] => [...called].filter((m) => F9_SCOPE.test(m) && !pins.has(m)).sort();

describe('F9: every repository module the read calls into is pinned (built from a trace, not from reading)', () => {
  it('N5: its scope is the modules T5 owns or freezes — a new src/lib module reached by a symbol function is the guard\'s; an unpinned T5 or T3 module is red', () => {
    const pins = new Map([['src/scripts/regime-forward/forward-run.ts', 'x'], ['src/lib/adapters/okx.ts', 'y']]);
    expect(unpinnedInScope(['src/scripts/regime-forward/forward-run.ts', 'src/lib/adapters/okx.ts', 'src/lib/adapters/_norm.ts'], pins)).toEqual([]);
    expect(unpinnedInScope(['src/scripts/regime-forward/planted.ts', 'src/scripts/regime-diag/planted.ts', 'ops/monitoring/planted.py', 'src/lib/planted.ts'], pins))
      .toEqual(['ops/monitoring/planted.py', 'src/scripts/regime-diag/planted.ts', 'src/scripts/regime-forward/planted.ts']);
  });

  it('a read traced by V8 call counts: each module with a function run during it has a pin in §10', async () => {
    const session = new inspector.Session();
    session.connect();
    const post = (m: string, p: object = {}): Promise<any> => new Promise((res, rej) => session.post(m, p, (e, r) => (e ? rej(e) : res(r)))); // eslint-disable-line @typescript-eslint/no-explicit-any
    const w = world();
    let cov: { result: Array<{ url: string; functions: Array<{ ranges: Array<{ count: number }> }> }> };
    try {
      await post('Profiler.enable');
      await post('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
      await post('Profiler.takePreciseCoverage'); // the counters start at the read: module loading is not a call of the read
      const r = await runOf(w);
      expect(r.verdict).toBe('PASS');
      // the network door's pure half, which a seam read does not reach: the pager and the adapters' symbol maps
      for (const v of VENUES) for (const tf of TFS) { const sp = spanOf(v, tf); pagesOf(v, C1, tf, sp.startMs, sp.endMs); }
      cov = await post('Profiler.takePreciseCoverage');
    } finally {
      await post('Profiler.stopPreciseCoverage').catch(() => undefined);
      session.disconnect();
    }
    const called = new Set<string>();
    for (const s of cov.result) {
      const file = s.url.startsWith('file://') ? new URL(s.url).pathname : s.url;
      if (!file.startsWith(`${REPO}/`) || file.includes('/node_modules/')) continue;
      const rel = path.relative(REPO, file);
      if (!/^(src|scripts|ops)\//.test(rel)) continue;
      if (s.functions.some((f) => f.ranges[0].count > 0)) called.add(rel);
    }
    const pins = pinsOf(fs.readFileSync(path.join(REPO, REGISTRATION), 'utf8'));
    expect(called.size).toBeGreaterThan(10); // the trace saw the read: T5's and T3's modules (and the served ones, out of scope)
    for (const m of ['src/scripts/regime-forward/forward-run.ts', 'src/scripts/regime-forward/venue-bars.ts', 'src/scripts/regime-diag/guard.ts', 'src/scripts/regime-diag/bars.ts']) expect(called.has(m), m).toBe(true);
    expect(unpinnedInScope(called, pins)).toEqual([]);
  }, 180_000);
});
