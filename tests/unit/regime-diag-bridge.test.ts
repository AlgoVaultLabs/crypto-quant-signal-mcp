// EDGE-REGIME-DIAG-BRIDGE-W1 — the regime-diag statistics bridge never waits on end-of-input.
//
// On 2026-11-16 one `bounds` child of the bridge sat for an hour blocked in `read()` on stdin, inside
// `json.load(sys.stdin)`, which returns only at end-of-input; nothing was queued at either end. The request is
// now framed: argv carries its exact UTF-8 length (`--bytes <n>`), and `prims.py` reads exactly n bytes, answers
// and exits. These tests write a framed request and keep stdin OPEN, so a bridge that still waits for
// end-of-input cannot answer them.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { BRIDGE_TIMEOUT_MS, PRIMS_PY, REPO, callTimeoutMs, prims, type BridgeTimeouts, type Op } from '../../src/scripts/regime-diag/prims.js';

const SPAWN = 60_000;
/** AC1: the reply must arrive inside this window while stdin stays open. */
const REPLY_MS = 10_000;

interface Talk { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; answered: boolean; ms: number }

/**
 * Starts `python3 -I <script> --bytes <declared>`, writes `body`, and leaves stdin OPEN unless `end`. Resolves when
 * the child exits, or kills it after `ms` and resolves with `answered: false`.
 */
function talk(body: Buffer, declared: number, { end = false, ms = REPLY_MS, script = path.join(REPO, PRIMS_PY) } = {}): Promise<Talk> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn('python3', ['-I', script, '--bytes', String(declared)], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [], err: Buffer[] = [];
    let answered = true;
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.stdin.on('error', () => undefined);
    const timer = setTimeout(() => { answered = false; child.kill('SIGKILL'); }, ms);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      child.stdin.destroy();
      resolve({ code, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), answered, ms: Date.now() - t0 });
    });
    child.stdin.write(body);
    if (end) child.stdin.end();
  });
}

const frame = (req: unknown): Buffer => Buffer.from(JSON.stringify(req), 'utf8');

/** A W2-sized `bounds` request: 8 series x 10,000 replicates. */
function w2Bounds(): { req: { ops: Array<{ op: 'bounds'; alpha: number; series: number[][] }> }; expected: Array<[number, number]> } {
  const series = Array.from({ length: 8 }, (_, k) => Array.from({ length: 10_000 }, (_, i) => ((i * 7919 + k * 104_729) % 10_000) / 10_000 - 0.5));
  // nearest-rank one-sided bounds at alpha = 0.025 over 10,000 distinct values: the 250th smallest and the 250th largest
  const expected = series.map((s) => { const o = s.slice().sort((a, b) => a - b); return [o[249], o[o.length - 250]] as [number, number]; });
  return { req: { ops: [{ op: 'bounds', alpha: 0.025, series }] }, expected };
}

describe('regime-diag bridge: a framed request is answered without end-of-input (AC1)', () => {
  it('AC1 a small framed request, stdin left open: the reply arrives in <= 10 s', { timeout: SPAWN }, async () => {
    const body = frame({ ops: [{ op: 'bounds', alpha: 0.025, series: [Array.from({ length: 100 }, (_, i) => 100 - i)] }, { op: 'floor' }] });
    const r = await talk(body, body.length);
    expect({ answered: r.answered, code: r.code, stderr: r.stderr }).toEqual({ answered: true, code: 0, stderr: '' });
    expect(JSON.parse(r.stdout)).toEqual({ out: [[[3, 98]], 50] });
    expect(r.ms).toBeLessThanOrEqual(REPLY_MS);
  });

  it('AC1 a W2-sized bounds request (8 x 10,000), multi-byte text in the request, stdin left open: the reply arrives in <= 10 s', { timeout: SPAWN }, async () => {
    const { req, expected } = w2Bounds();
    // a non-ASCII label: the declared length is UTF-8 bytes, never UTF-16 code units
    const body = frame({ ops: [...req.ops, { op: 'seeds', label: 'é—регим', arms: ['a'] }] });
    expect(body.length).toBeGreaterThan(JSON.stringify({ ops: [...req.ops, { op: 'seeds', label: 'é—регим', arms: ['a'] }] }).length);
    const r = await talk(body, body.length);
    expect({ answered: r.answered, code: r.code, stderr: r.stderr }).toEqual({ answered: true, code: 0, stderr: '' });
    const out = (JSON.parse(r.stdout) as { out: unknown[] }).out;
    expect(out[0]).toEqual(expected);
    expect(out[1]).toEqual([expect.any(Number)]);
    expect(r.ms).toBeLessThanOrEqual(REPLY_MS);
  });
});

describe('regime-diag bridge: a truncated request is a failure, never a reply (AC2)', () => {
  it('AC2 fewer bytes than declared at end-of-input: non-zero exit, "truncated request" on stderr, nothing on stdout', { timeout: SPAWN }, async () => {
    const body = frame({ ops: [{ op: 'floor' }] });
    const r = await talk(body, body.length + 10, { end: true });
    expect(r.answered).toBe(true);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/truncated request/);
    expect(r.stdout).toBe('');
  });
});

// ── the bounded call, against stubs ───────────────────────────────────────────────────────────────────────────

const STUB = path.join(REPO, 'tests/fixtures/regime-diag-bridge/stub-prims.py');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'regime-diag-bridge-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A repository whose `scripts/regime-diag/prims.py` is the stub, in `mode`. */
function stubRepo(mode: 'hang-then-answer' | 'hang-always' | 'truncated'): string {
  const repo = fs.mkdtempSync(path.join(tmp, `${mode}-`)), dir = path.join(repo, 'scripts/regime-diag');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(STUB, path.join(dir, 'prims.py'));
  fs.writeFileSync(path.join(dir, 'mode'), mode);
  return repo;
}
/** The requests the stub received, in call order. */
const received = (repo: string): Buffer[] => {
  const dir = path.join(repo, 'scripts/regime-diag');
  return fs.readdirSync(dir).filter((f) => /^call-\d+\.req$/.test(f)).sort((a, b) => parseInt(a.slice(5), 10) - parseInt(b.slice(5), 10)).map((f) => fs.readFileSync(path.join(dir, f)));
};
/** Every op bounded at `ms`. */
const every = (ms: number): BridgeTimeouts => Object.fromEntries(Object.keys(BRIDGE_TIMEOUT_MS).map((k) => [k, ms])) as unknown as BridgeTimeouts;
/** Runs `f` with process.stderr captured; returns its lines and f's result or error. */
function captured<T>(f: () => T): { lines: string[]; value?: T; error?: Error } {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write);
  try { return { lines, value: f() }; } catch (e) { return { lines, error: e as Error }; } finally { spy.mockRestore(); }
}
const BOUNDS: Op = { op: 'bounds', alpha: 0.025, series: [[3, 1, 2]] };
const T = 2_000;

describe('regime-diag bridge: every call is bounded (AC2)', () => {
  it('the bound is per op: perm 3,600 s, every other op 300 s; a batch takes its longest op\'s', () => {
    expect(BRIDGE_TIMEOUT_MS).toEqual({ seeds: 300_000, bounds: 300_000, kish: 300_000, bh: 300_000, attainable: 300_000, perm: 3_600_000, floor: 300_000 });
    const perm: Op = { op: 'perm', levels: [0, 1], wins: [0, 1], clusters: [0, 1], B: 10, seed: 1 };
    expect(callTimeoutMs([BOUNDS])).toBe(300_000);
    expect(callTimeoutMs([{ op: 'floor' }, BOUNDS, { op: 'kish', sizes: [[1]] }])).toBe(300_000);
    expect(callTimeoutMs([perm])).toBe(3_600_000);
    expect(callTimeoutMs([BOUNDS, perm, { op: 'floor' }])).toBe(3_600_000);
    expect(callTimeoutMs([BOUNDS], { ...every(50), bounds: 70 })).toBe(70);
    // an op the table does not name is bounded by the table's longest; python then refuses it
    expect(callTimeoutMs([{ op: 'nope' } as never])).toBe(3_600_000);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => callTimeoutMs([BOUNDS], { ...every(50), floor: bad })).toThrow(/positive whole number/);
  });

  it('AC2 hang-then-answer: one re-issue line on stderr, then the reply; the re-issued request is byte-identical', { timeout: SPAWN }, () => {
    const repo = stubRepo('hang-then-answer');
    const r = captured(() => prims([BOUNDS], repo, every(T)));
    expect(r.error).toBeUndefined();
    expect(r.value).toEqual(['answer:bounds']);
    expect(r.lines).toHaveLength(1);
    const m = /^regime-diag: bridge re-issued bounds after (\d+) ms\n$/.exec(r.lines[0]);
    expect(m, r.lines[0]).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(T);
    const reqs = received(repo);
    expect(reqs).toHaveLength(2);
    expect(reqs[1].equals(reqs[0])).toBe(true);
    expect(JSON.parse(reqs[0].toString('utf8'))).toEqual({ ops: [BOUNDS] });
  });

  it('AC2 a batch is bounded by its longest op, and the re-issue line names every op', { timeout: SPAWN }, () => {
    const repo = stubRepo('hang-then-answer');
    const perm: Op = { op: 'perm', levels: [0, 1], wins: [0, 1], clusters: [0, 1], B: 10, seed: 1 };
    const r = captured(() => prims([{ op: 'floor' }, perm], repo, { ...every(300), perm: T }));
    expect(r.value).toEqual(['answer:floor', 'answer:perm']);
    const m = /^regime-diag: bridge re-issued floor,perm after (\d+) ms\n$/.exec(r.lines.join(''));
    expect(m, r.lines.join('')).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(T);
  });

  it('AC2 hang-always: re-issued once, then "timed out twice"; never a third call', { timeout: SPAWN }, () => {
    const repo = stubRepo('hang-always');
    const r = captured(() => prims([BOUNDS], repo, every(T)));
    expect(r.value).toBeUndefined();
    expect(r.error?.message).toBe('regime-diag: the primitives bridge timed out twice (bounds)');
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/^regime-diag: bridge re-issued bounds after \d+ ms\n$/);
    const reqs = received(repo);
    expect(reqs).toHaveLength(2);
    expect(reqs[1].equals(reqs[0])).toBe(true);
  });

  it('AC2 a truncated request: prims() throws at once, without parsing the reply on stdout and without a re-issue', { timeout: SPAWN }, () => {
    const repo = stubRepo('truncated');
    // the stub prints a well-formed reply before it fails: a bridge that parsed stdout would return ['answer:floor']
    const r = captured(() => prims([{ op: 'floor' }], repo, every(T)));
    expect(r.value).toBeUndefined();
    expect(r.error?.message).toMatch(/truncated request/);
    expect((r.error as NodeJS.ErrnoException & { status?: number }).status).toBe(1);
    expect(r.lines).toEqual([]);
    expect(received(repo)).toHaveLength(1);
  });
});
