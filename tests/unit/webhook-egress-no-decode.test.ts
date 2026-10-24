/**
 * OPS-NODE-SECURITY-FLOOR-W1 CH2 R1 — the outbound call to a subscriber URL never
 * decodes the reply and never follows a redirect.
 *
 * egressPost (src/lib/webhook-ssrf.ts) is the one outbound call to a caller-supplied
 * URL. Everything below runs against real local sockets; nothing in the code under
 * test is mocked.
 *   1. Encoded replies (br / gzip / deflate over random bytes) resolve
 *      { ok: true, status: 200 } while every zlib decompressor records 0 calls. The
 *      SAME spies count the platform fetch decoding a br reply — proof they can see.
 *   2. Parity: each reply / failure shape classifies identically through the path this
 *      wave replaced (platform fetch, redirect:'error', pinned dispatcher) and through
 *      egressPost, so no subscriber lifecycle shifts.
 *   3. Source rule (AST): no module importing webhook-ssrf.js references fetch.
 *   4. Surface: egressPost is the only egress export (no egressGet — Q20).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import ts from 'typescript';
import { Agent } from 'undici';
import * as ssrf from '../../src/lib/webhook-ssrf.js';
import { egressPost, type PinnedAddress } from '../../src/lib/webhook-ssrf.js';
import { classifyDeliveryFailure, extractErrorCode, type WebhookFailureClass } from '../../src/lib/webhook-failure-class.js';

const PIN: PinnedAddress = { address: '127.0.0.1', family: 4 };
const BODY = JSON.stringify({ event: 'trade_call', id: 1 });
const HEADERS = { 'Content-Type': 'application/json', 'X-AlgoVault-Event': 'trade_call' };
const RANDOM = crypto.randomBytes(4096);
const VALID_BR = zlib.brotliCompressSync(Buffer.from('x'.repeat(2048)));

// ── decoder spies ───────────────────────────────────────────────────────────

const DECODERS = [
  'createBrotliDecompress', 'createGunzip', 'createInflate', 'createInflateRaw', 'createUnzip', 'createZstdDecompress',
  'brotliDecompress', 'brotliDecompressSync', 'gunzip', 'gunzipSync', 'inflate', 'inflateSync',
  'inflateRaw', 'inflateRawSync', 'unzip', 'unzipSync', 'zstdDecompress', 'zstdDecompressSync',
];

/**
 * Count every zlib decompressor call made while `fn` runs. zlib's exports are
 * configurable but not writable, so the spy is a defineProperty swap, restored in
 * `finally`. A name this runtime lacks (zstd before Node 23.8) is simply not spied.
 */
async function countDecodes(fn: () => Promise<unknown>): Promise<Record<string, number>> {
  const z = zlib as unknown as Record<string, unknown>;
  const saved: [string, PropertyDescriptor][] = [];
  const counts: Record<string, number> = {};
  for (const name of DECODERS) {
    const desc = Object.getOwnPropertyDescriptor(z, name);
    if (!desc || typeof desc.value !== 'function') continue;
    const orig = desc.value as (...a: unknown[]) => unknown;
    counts[name] = 0;
    saved.push([name, desc]);
    Object.defineProperty(z, name, {
      ...desc,
      value: function (this: unknown, ...a: unknown[]) { counts[name] += 1; return orig.apply(this, a); },
    });
  }
  try {
    await fn();
  } finally {
    for (const [name, desc] of saved) Object.defineProperty(z, name, desc);
  }
  return counts;
}

const totalCalls = (c: Record<string, number>): number => Object.values(c).reduce((a, b) => a + b, 0);

// ── local servers ───────────────────────────────────────────────────────────

let plain: http.Server;
let plainPort = 0;
let sink: http.Server;
let sinkHits = 0;
let tlsServer: https.Server;
let tlsPort = 0;
let closedPort = 0;
let certDir = '';
const received: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];

function plainHandler(req: http.IncomingMessage, res: http.ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const url = req.url ?? '/';
    received.push({ url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    if (url === '/hang') return; // never answers → the caller's timeout fires
    if (url === '/reset') { req.socket.destroy(); return; }
    let m = url.match(/^\/encoded\/(br|gzip|deflate)$/);
    if (m) {
      res.writeHead(200, { 'content-encoding': m[1], 'content-type': 'application/octet-stream' });
      res.end(RANDOM);
      return;
    }
    if (url === '/valid-br') { res.writeHead(200, { 'content-encoding': 'br' }); res.end(VALID_BR); return; }
    if (url === '/large') { res.writeHead(200, { 'content-length': String(1 << 20) }); res.end(Buffer.alloc(1 << 20)); return; }
    m = url.match(/^\/status\/(\d{3})$/);
    if (m) {
      const code = Number(m[1]);
      res.writeHead(code, code >= 300 && code < 400 ? { location: `http://127.0.0.1:${sinkPort()}/sink` } : {});
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

function sinkPort(): number {
  return (sink.address() as AddressInfo).port;
}

async function listen(server: http.Server | https.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return (server.address() as AddressInfo).port;
}

async function shut(server: http.Server | https.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** A throwaway self-signed cert, generated per run and deleted afterwards — never committed. */
function selfSignedCert(dir: string): { key: Buffer; cert: Buffer } {
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

beforeAll(async () => {
  plain = http.createServer(plainHandler);
  plainPort = await listen(plain);
  sink = http.createServer((_req, res) => { sinkHits += 1; res.end('sink'); });
  await listen(sink);
  certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-tls-'));
  tlsServer = https.createServer(selfSignedCert(certDir), (req, res) => { req.resume(); req.on('end', () => res.end('ok')); });
  tlsPort = await listen(tlsServer);
  const probe = http.createServer();
  closedPort = await listen(probe);
  await shut(probe); // nothing listens here any more → ECONNREFUSED
});

afterAll(async () => {
  await Promise.all(legacyAgents.map((a) => a.destroy()));
  await shut(plain);
  await shut(sink);
  await shut(tlsServer);
  if (certDir) fs.rmSync(certDir, { recursive: true, force: true });
});

// ── the path this wave replaced, verbatim (webhook-delivery.ts before CH2 R1) ──

const legacyAgents: Agent[] = [];

function legacyPinnedDispatcher(pin: PinnedAddress): Agent {
  const pinnedLookup = (
    _hostname: string,
    opts: { all?: boolean } | undefined,
    cb: (err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void,
  ): void => {
    if (opts?.all) cb(null, [{ address: pin.address, family: pin.family }]);
    else cb(null, pin.address, pin.family);
  };
  const agent = new Agent({ connect: { lookup: pinnedLookup as never } });
  legacyAgents.push(agent);
  return agent;
}

async function legacyPost(url: string, timeoutMs: number): Promise<{ ok: boolean; status: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await globalThis.fetch(url, {
      method: 'POST', headers: HEADERS, body: BODY, signal: controller.signal, redirect: 'error', dispatcher: legacyPinnedDispatcher(PIN),
    } as RequestInit);
    return { ok: res.ok, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

type Outcome = 'ok' | WebhookFailureClass;

/** Classify one attempt exactly as deliverOne / probeOne do. */
async function outcomeOf(post: () => Promise<{ ok: boolean; status: number }>): Promise<Outcome> {
  try {
    const { ok, status } = await post();
    return ok ? 'ok' : classifyDeliveryFailure({ httpStatus: status });
  } catch (err) {
    return classifyDeliveryFailure({ errorCode: extractErrorCode(err) });
  }
}

const post = (url: string, timeoutMs = 5_000) => egressPost(url, { headers: HEADERS, body: BODY, timeoutMs, pin: PIN });

// ── 1. no decode ────────────────────────────────────────────────────────────

describe('egressPost never decodes the reply', () => {
  for (const coding of ['br', 'gzip', 'deflate']) {
    it(`a ${coding}-encoded reply of random bytes → { ok: true, status: 200 } with 0 decoder calls`, async () => {
      let out: { ok: boolean; status: number } | undefined;
      const counts = await countDecodes(async () => { out = await post(`http://127.0.0.1:${plainPort}/encoded/${coding}`); });
      expect(out).toEqual({ ok: true, status: 200 });
      expect(Object.keys(counts)).toEqual(expect.arrayContaining(['createBrotliDecompress', 'createGunzip', 'createInflate']));
      expect(totalCalls(counts), JSON.stringify(counts)).toBe(0);
    });
  }

  it('positive control — the same spies DO count the platform fetch decoding a br reply', async () => {
    const counts = await countDecodes(async () => {
      const res = await globalThis.fetch(`http://127.0.0.1:${plainPort}/valid-br`, { method: 'POST', body: BODY });
      await res.arrayBuffer();
    });
    expect(counts.createBrotliDecompress).toBeGreaterThanOrEqual(1);
  });

  it('asks for identity in place of any caller Accept-Encoding, and sends the body intact', async () => {
    received.length = 0;
    await egressPost(`http://127.0.0.1:${plainPort}/status/200`, {
      headers: { ...HEADERS, 'Accept-Encoding': 'gzip, deflate, br' }, body: BODY, timeoutMs: 5_000, pin: PIN,
    });
    expect(received).toHaveLength(1);
    expect(received[0].headers['accept-encoding']).toBe('identity');
    expect(received[0].headers['content-type']).toBe('application/json');
    expect(received[0].headers['x-algovault-event']).toBe('trade_call');
    expect(received[0].body).toBe(BODY);
  });

  it('a 1 MiB reply resolves without being read (undici dump limit)', async () => {
    const counts = await countDecodes(async () => {
      expect(await post(`http://127.0.0.1:${plainPort}/large`)).toEqual({ ok: true, status: 200 });
    });
    expect(totalCalls(counts)).toBe(0);
  });

  it('closes its pinned dispatcher once the reply is drained — no socket left open', async () => {
    // A dedicated server, so only this test's sockets are counted. The replaced path is the
    // negative control: it never closed its per-delivery Agent, so its socket stayed open.
    const solo = http.createServer((req, res) => { req.resume(); req.on('end', () => res.end('ok')); });
    solo.keepAliveTimeout = 30_000;
    const port = await listen(solo);
    const openSockets = async (withinMs: number): Promise<number> => {
      const deadline = Date.now() + withinMs;
      for (;;) {
        const open = await new Promise<number>((resolve) => solo.getConnections((_e, n) => resolve(n)));
        if (open === 0 || Date.now() >= deadline) return open;
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    try {
      expect(await post(`http://127.0.0.1:${port}/`)).toEqual({ ok: true, status: 200 });
      expect(await openSockets(1_000)).toBe(0);
      expect(await legacyPost(`http://127.0.0.1:${port}/`, 5_000)).toEqual({ ok: true, status: 200 });
      expect(await openSockets(500)).toBe(1);
    } finally {
      await shut(solo);
    }
  });
});

// ── 2. failure-class parity with the replaced path ──────────────────────────

describe('every reply / failure shape classifies as it did before (parity)', () => {
  const rows: { name: string; url: () => string; timeoutMs?: number; want: Outcome }[] = [
    { name: '200', url: () => `http://127.0.0.1:${plainPort}/status/200`, want: 'ok' },
    ...[301, 302, 303, 307, 308].map((code) => ({
      name: `${code} redirect (not followed)`, url: () => `http://127.0.0.1:${plainPort}/status/${code}`, want: 'timeout' as Outcome,
    })),
    { name: '300 (not a redirect status)', url: () => `http://127.0.0.1:${plainPort}/status/300`, want: 'other' },
    { name: '304 (not a redirect status)', url: () => `http://127.0.0.1:${plainPort}/status/304`, want: 'other' },
    { name: '404', url: () => `http://127.0.0.1:${plainPort}/status/404`, want: 'http_4xx' },
    { name: '410', url: () => `http://127.0.0.1:${plainPort}/status/410`, want: 'http_410' },
    { name: '503', url: () => `http://127.0.0.1:${plainPort}/status/503`, want: 'http_5xx' },
    { name: 'timeout (no reply)', url: () => `http://127.0.0.1:${plainPort}/hang`, timeoutMs: 300, want: 'timeout' },
    { name: 'connection reset', url: () => `http://127.0.0.1:${plainPort}/reset`, want: 'conn' },
    { name: 'connection refused', url: () => `http://127.0.0.1:${closedPort}/`, want: 'conn' },
    { name: 'TLS: self-signed certificate', url: () => `https://localhost:${tlsPort}/`, want: 'tls' },
    { name: 'TLS: plain-http peer', url: () => `https://localhost:${plainPort}/status/200`, want: 'tls' },
  ];

  for (const row of rows) {
    it(`${row.name} → ${row.want} through both paths`, async () => {
      const timeoutMs = row.timeoutMs ?? 5_000;
      const before = await outcomeOf(() => legacyPost(row.url(), timeoutMs));
      const now = await outcomeOf(() => post(row.url(), timeoutMs));
      expect({ before, now }).toEqual({ before: row.want, now: row.want });
    });
  }

  it('neither path ever reached a redirect target', () => {
    expect(sinkHits).toBe(0);
  });
});

// ── 3. source rule ──────────────────────────────────────────────────────────

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const SSRF_SPECIFIER = /['"](?:\.{1,2}\/)+(?:[\w.-]+\/)*webhook-ssrf(?:\.js)?['"]/;
const GLOBAL_OBJECTS = new Set(['globalThis', 'global', 'window', 'self']);

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return tsFiles(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') ? [p] : [];
  });
}

/** Line numbers of every reference to fetch: a call, a value, an import binding or a global member. */
function fetchReferences(text: string, fileName: string): number[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines: number[] = [];
  const at = (n: ts.Node): void => { lines.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1); };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'fetch') {
      const p = node.parent;
      const isKey = (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertySignature(p)
        || ts.isMethodSignature(p) || ts.isPropertyDeclaration(p)) && p.name === node;
      const isMember = ts.isPropertyAccessExpression(p) && p.name === node;
      if (isMember) {
        if (ts.isIdentifier(p.expression) && GLOBAL_OBJECTS.has(p.expression.text)) at(node);
      } else if (!isKey) {
        at(node);
      }
    }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === 'fetch') at(node);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

describe('source rule: caller-URL egress goes through egressPost only', () => {
  it('the detector can fail — it flags every fetch form and ignores look-alikes', () => {
    expect(fetchReferences("await fetch('https://x');", 'a.ts')).toHaveLength(1);
    expect(fetchReferences('await globalThis.fetch(u);', 'a.ts')).toHaveLength(1);
    expect(fetchReferences("globalThis['fetch'](u);", 'a.ts')).toHaveLength(1);
    expect(fetchReferences('const f = fetch;', 'a.ts')).toHaveLength(1);
    expect(fetchReferences("import { fetch } from 'undici';", 'a.ts')).toHaveLength(1);
    expect(fetchReferences("// fetch(u)\nconst s = 'fetch(u)'; deps.fetchImpl(u); const o = { fetch: 1 }; client.fetch(u);", 'a.ts')).toHaveLength(0);
  });

  it('no module importing webhook-ssrf.js references fetch (and neither does webhook-ssrf.ts)', () => {
    const files = tsFiles(SRC);
    const importers = files.filter((f) => SSRF_SPECIFIER.test(fs.readFileSync(f, 'utf8')));
    const rel = (f: string): string => path.relative(SRC, f).split(path.sep).join('/');
    expect(importers.map(rel)).toEqual(expect.arrayContaining(['lib/webhook-delivery.ts', 'lib/webhook-api.ts'])); // vacuity guard
    const offenders = [...importers, path.join(SRC, 'lib', 'webhook-ssrf.ts')]
      .flatMap((f) => fetchReferences(fs.readFileSync(f, 'utf8'), f).map((line) => `${rel(f)}:${line}`));
    expect(offenders).toEqual([]);
  });
});

// ── 4. surface ──────────────────────────────────────────────────────────────

describe('egress surface', () => {
  it('egressPost is the only egress export — no egressGet (Q20); egressRequest stays module-private', () => {
    expect(typeof ssrf.egressPost).toBe('function');
    expect(Object.keys(ssrf).filter((k) => /^egress/.test(k))).toEqual(['egressPost']);
    expect('egressGet' in ssrf).toBe(false);
    expect('egressRequest' in ssrf).toBe(false);
  });
});
