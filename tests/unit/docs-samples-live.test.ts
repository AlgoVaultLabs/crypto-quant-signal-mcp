/**
 * DOCS-SAMPLE-EXECUTABLE-W1 CH2 — the gate that executes the docs.
 *
 * Source-assertion + CLI-driving suite (hence `tests/unit/`), and it proves three separate things:
 * that the extractor finds every probe BY ENDPOINT, that the classifier maps each verdict to the
 * right EXIT CODE, and that the identity guard would have caught the one drop that a block COUNT
 * cannot see.
 *
 * 🛑 THE EXIT MAPPING IS ASSERTED, NOT JUST THE TOKEN. A prior gate in this repo asserted verdict
 * tokens but never the token→code mapping, so re-coding INDETERMINATE to 0 left it fully green.
 * The two CLI cases below run the real script against a local stub server and read the real status.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROBES,
  extractCorpus,
  resolveProbes,
  httpCallsIn,
  codeBlocks,
  decodeEntities,
  classify,
  resolveBase,
} from '../../scripts/check-docs-samples-live.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATE = join(ROOT, 'scripts', 'check-docs-samples-live.mjs');

/**
 * ASYNC on purpose — `execFileSync` blocks this process's event loop, and the stub server below
 * lives in THIS process. The child then waits forever for a reply the blocked loop can never send:
 * a deadlock that looks exactly like a hung gate. (Measured: the child sat at 60s having printed
 * only its header line, and the gate itself was innocent.) `execFile` keeps the loop free.
 */
function runGate(args: string[] = []): Promise<{ status: number; out: string }> {
  return new Promise((res) => {
    execFile('node', [GATE, ...args], { cwd: ROOT, encoding: 'utf8' }, (err, stdout, stderr) => {
      const e = err as (Error & { code?: number }) | null;
      res({ status: e?.code ?? 0, out: `${stdout}${stderr}` });
    });
  });
}

/** A stub API the gate can be pointed at with `--live`, so the CLI paths are exercised for real. */
function stub(handler: (url: string) => { status: number; body: unknown }): Promise<{ base: string; server: Server }> {
  return new Promise((res) => {
    const server = createServer((req, rep) => {
      const { status, body } = handler(req.url ?? '');
      rep.writeHead(status, { 'Content-Type': 'application/json' });
      rep.end(JSON.stringify(body));
    });
    server.listen(0, '127.0.0.1', () => res({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }));
  });
}

describe('the self-test', () => {
  it('exits 0 and exercises the REAL extractor against real docs-src/', async () => {
    const { status, out } = await runGate(['--self-test']);
    expect(out).toContain('SELF-TEST: PASS');
    expect(status).toBe(0);
    // A hermetic self-test is blind to exactly what its own seam replaces, so it must assert the
    // bypassed artifact too — here, that every probe resolves against the real tree.
    for (const p of PROBES) expect(out).toContain(`bypassed artifact: ${p.id} resolves to`);
  });

  it('proves the identity guard catches the host-keyed drop, by name', async () => {
    expect((await runGate(['--self-test'])).out).toContain('a host-keyed extractor FAILS the identity guard (naming P5)');
  });
});

describe('extraction is by METHOD + PATH, never by host string', () => {
  const corpus = extractCorpus() as { calls: Array<{ method: string; path: string; source: string }> };

  it('resolves all five probes individually — asserted by endpoint, never as a count', () => {
    // A COUNT is what an earlier draft asserted ("the extractor returns >= 5 blocks"). Under a
    // host-keyed extractor that drops both verify.html blocks, the count is exactly 5 and the
    // assertion passes while P5 is silently absent.
    for (const { probe, match } of resolveProbes(corpus.calls)) {
      expect(match, `${probe.id} (${probe.method} ${probe.path}) did not resolve — expected in ${probe.source}`).toBeTruthy();
    }
  });

  it('finds the PATH-ONLY blocks that carry no host — the ones a host key drops', () => {
    // verify.html ships `GET /api/verify-signal?signalId=<ID>` and `GET /api/merkle-batches`,
    // neither with api.algovault.com anywhere in the block.
    const fromVerify = corpus.calls.filter((c) => c.source === 'verify.html');
    expect(fromVerify.map((c) => `${c.method} ${c.path}`).sort()).toEqual([
      'GET /api/merkle-batches',
      'GET /api/verify-signal',
    ]);
    const raw = readFileSync(join(ROOT, 'docs-src/partials/verify.html'), 'utf8');
    expect(raw).not.toContain('api.algovault.com/api/merkle-batches'); // genuinely path-only
  });

  it('a host-keyed extractor drops P5 — the negative case, run through the REAL resolver', () => {
    const hostKeyed = corpus.calls.filter((c) => c.source !== 'verify.html');
    const dropped = resolveProbes(hostKeyed).filter((r) => !r.match).map((r) => r.probe.id);
    expect(dropped).toEqual(['P5']);
    // …and the count it would have reported is exactly the threshold the old guard accepted.
    expect(hostKeyed.length).toBeGreaterThanOrEqual(5);
  });

  it('parses both documented call forms', () => {
    expect(httpCallsIn("curl -sS -X POST https://api.algovault.com/api/search -d '{\"q\":1}'"))
      .toEqual([{ method: 'POST', path: '/api/search', body: '{"q":1}' }]);
    expect(httpCallsIn('GET /api/merkle-batches')).toEqual([{ method: 'GET', path: '/api/merkle-batches', body: null }]);
    expect(codeBlocks('<pre><code class="x">GET /api/z</code></pre>')).toEqual(['GET /api/z']);
    expect(decodeEntities('a &gt; b &amp; c')).toBe('a > b & c');
  });

  it('P4 takes its model id from the SAMPLE, not from the gate', () => {
    // The whole point of inheritor #1: when the model is retired the sample 400s and the gate goes
    // red the day it breaks. A model id hardcoded here would keep passing.
    const gateSrc = readFileSync(GATE, 'utf8');
    expect(gateSrc).not.toMatch(/claude-[a-z]+-\d/);
    const chat = resolveProbes(extractCorpus().calls).find((r) => r.probe.id === 'P4')!;
    expect(chat.match!.body).toContain('claude-haiku-4-5-20251001');
  });
});

describe('the verdict/exit contract', () => {
  it('declares 0=PASS / 1=FAIL / 3=INDETERMINATE — the token-law default for a NEW gate', () => {
    expect(readFileSync(GATE, 'utf8')).toMatch(/EXIT_FOR\s*=\s*\{\s*PASS:\s*0,\s*FAIL:\s*1,\s*INDETERMINATE:\s*3\s*\}/);
  });

  it('classifies transport and gateway failures OPEN, content failures CLOSED', () => {
    const R = (o: object) => ({ id: 'Px', source: 'x', status: 200, failures: [] as string[], transportError: null, ...o });
    expect(classify([R({})]).verdict).toBe('PASS');
    expect(classify([R({ failures: ['missing key'] })]).verdict).toBe('FAIL');
    for (const s of [502, 503, 504]) expect(classify([R({ status: s })]).verdict).toBe('INDETERMINATE');
    expect(classify([R({ transportError: 'ECONNREFUSED' })]).verdict).toBe('INDETERMINATE');
    // A blip must never read as divergence, even when a content failure is also present.
    expect(classify([R({ transportError: 'timeout', failures: ['missing key'] })]).verdict).toBe('INDETERMINATE');
  });

  it('resolves --live, and falls back to the production base', () => {
    expect(resolveBase(['node', 'x', '--live', 'http://localhost:9'])).toBe('http://localhost:9');
    expect(resolveBase(['node', 'x'])).toBe('https://api.algovault.com');
    expect(resolveBase(['node', 'x', '--live'])).toBe('https://api.algovault.com'); // dangling flag
  });
});

describe('the CLI maps each verdict to the right EXIT CODE (end to end, against a stub)', () => {
  let divergent: { base: string; server: Server };
  let unavailable: { base: string; server: Server };

  beforeAll(async () => {
    // Every endpoint answers 200 with a well-formed-but-DIVERGENT payload: P1's verdict is missing
    // `confidence`, which is precisely the documented-key drift this gate exists to catch.
    divergent = await stub(() => ({
      status: 200,
      body: { result: { content: [{ text: JSON.stringify({ call: 'HOLD', regime: 'RANGING', price: 1 }) }] } },
    }));
    unavailable = await stub(() => ({ status: 503, body: { error: 'upstream not ready' } }));
  });
  afterAll(() => { divergent?.server.close(); unavailable?.server.close(); });

  it('a documented key going missing → FAIL, exit 1', async () => {
    const { status, out } = await runGate(['--live', divergent.base]);
    expect(out).toContain('DOCS_SAMPLES_LIVE_VERDICT=FAIL');
    expect(out).toMatch(/missing documented key/);
    expect(status).toBe(1);
  });

  it('a 503 everywhere → INDETERMINATE, exit 3 — the gate fails OPEN on transport', async () => {
    // The lesson behind this branch: check-mcp-stateless.mjs fired 1.6s post-deploy, got 502 on
    // every probe, and read it as a regression. A deploy must not be failed by a container that is
    // still coming up.
    const { status, out } = await runGate(['--live', unavailable.base]);
    expect(out).toContain('DOCS_SAMPLES_LIVE_VERDICT=INDETERMINATE');
    expect(status).toBe(3);
    expect(status).not.toBe(1); // stated explicitly: never FAIL
  });

  it('emits exactly ONE terminal verdict token per run', async () => {
    const { out } = await runGate(['--live', unavailable.base]);
    expect(out.match(/DOCS_SAMPLES_LIVE_VERDICT=[A-Z]+/g)).toHaveLength(1);
  });
});
