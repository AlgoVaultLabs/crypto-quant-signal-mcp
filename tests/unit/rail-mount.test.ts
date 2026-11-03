/**
 * OPS-A2MCP-SERVED-TRUTH-W1 CH2-A (A2) — rail-mount: the self-healing mount for an HTTP payment rail.
 *
 * Pins, against a REAL Express app (no supertest — a listening server + the platform fetch):
 *   - not ready → GET and POST both get 503 + Retry-After + X-Rail-State, and the paid handler
 *     registered behind the dispatcher NEVER runs (the dispatcher never calls next() for its prefix);
 *   - requests outside the prefix pass straight through;
 *   - two failed init attempts then success → served, delegating to the returned middleware, with
 *     ZERO unhandledRejection events (the app installs no handler — every promise is .catch'd);
 *   - the backoff schedule (1, 5, 15, 60 min, then hourly) with ±20 % jitter.
 *
 * OPS-AUDIT-REMEDIATION-HIGH-W2-R2 CH1 (RT-01) adds:
 *   - ownership by the OKX matcher's own normalization, case-insensitively, on every method: a dark
 *     dispatcher answers 503 to every spelling of a prefix path, and `normalizeRailPath` is pinned
 *     byte-equal to `@okxweb3/x402-core`'s own `normalizePath` over a variant corpus;
 *   - the verified-payment marker: written only when the middleware calls `next()` with no error for a
 *     request its own `requiresPayment()` prices, per rail, never by a throwing predicate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express, { type Express, type Request, type RequestHandler } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { x402HTTPResourceServer } from '@okxweb3/x402-core/server';
import {
  createRailDispatcher,
  backoffFor,
  hasVerifiedPayment,
  jitteredDelay,
  normalizeRailPath,
  RAIL_MOUNT_BACKOFF_MS,
  type RailMountTimers,
  type RailPaymentGate,
} from '../../src/lib/rail-mount.js';
import { servedState, _resetRailServedStateForTest } from '../../src/lib/rail-served-state.js';

const ATTEMPT_TIMEOUT_MS = 30_000;

/**
 * Manual timer queue: nothing fires until the test says so. rail-mount schedules two kinds of timer
 * on it — the per-attempt timeout (30 s) and the retry — so the helpers address them separately.
 */
function manualTimers(nowMs = Date.parse('2026-10-13T06:00:00.000Z')) {
  const queue: Array<{ fn: () => void; ms: number }> = [];
  const retries = () => queue.filter((q) => q.ms !== ATTEMPT_TIMEOUT_MS);
  const t: RailMountTimers & {
    queue: typeof queue;
    retries(): Array<{ fn: () => void; ms: number }>;
    fireRetry(): void;
    fireTimeout(): void;
  } = {
    queue,
    retries,
    setTimeout: (fn, ms) => { queue.push({ fn, ms }); return queue.length; },
    now: () => nowMs,
    random: () => 0.5, // jitter factor 1.0
    fireRetry: () => {
      const i = queue.findIndex((q) => q.ms !== ATTEMPT_TIMEOUT_MS);
      if (i >= 0) queue.splice(i, 1)[0].fn();
    },
    fireTimeout: () => {
      const i = queue.findIndex((q) => q.ms === ATTEMPT_TIMEOUT_MS);
      if (i >= 0) queue.splice(i, 1)[0].fn();
    },
  };
  return t;
}

async function listen(app: Express): Promise<{ base: string; server: Server }> {
  const server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('rail-mount — dispatcher in front of the paid handlers', () => {
  let server: Server | undefined;
  let unhandled: unknown[];
  const onUnhandled = (e: unknown) => { unhandled.push(e); };

  beforeEach(() => {
    _resetRailServedStateForTest();
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
  });
  afterEach(async () => {
    process.off('unhandledRejection', onUnhandled);
    _resetRailServedStateForTest();
    if (server) await new Promise((r) => server!.close(r));
    server = undefined;
  });

  it('not ready → 503 + Retry-After + X-Rail-State on GET and POST; the handler behind it NEVER runs', async () => {
    const app = express();
    const timers = manualTimers();
    let handlerRuns = 0;
    const h = createRailDispatcher({
      rail: 'a2mcp', prefix: '/a2mcp', mode: 'live', routes: 1, timers,
      init: async () => { throw new Error('OKX getSupported failed: 401'); },
    });
    app.all('/a2mcp/*', h.dispatch);
    app.get('/a2mcp/get_trade_call', (_q, r) => { handlerRuns++; r.json({ paid: false }); });
    app.post('/a2mcp/get_trade_call', (_q, r) => { handlerRuns++; r.json({ paid: false }); });
    app.get('/health', (_q, r) => r.json({ ok: true }));
    await h.firstAttempt;
    const l = await listen(app); server = l.server;

    for (const method of ['GET', 'POST']) {
      const res = await fetch(`${l.base}/a2mcp/get_trade_call`, { method, headers: { 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
      expect(res.status).toBe(503);
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(res.headers.get('x-rail-state')).toBe('initializing; since=2026-10-13T06:00:00.000Z');
      const body = await res.json();
      expect(body.code).toBe('RAIL_INITIALIZING');
    }
    expect(handlerRuns).toBe(0);
    // Outside the prefix: untouched.
    expect((await fetch(`${l.base}/health`)).status).toBe(200);
    expect(servedState().a2mcp.status).toBe('dark');
    expect(timers.retries().length).toBe(1); // the retry is scheduled
    expect(unhandled).toEqual([]);
  });

  it('two failed attempts, then success → served and delegating; zero unhandledRejection events', async () => {
    const app = express();
    const timers = manualTimers();
    let calls = 0;
    const paid: RequestHandler = (req, res, next) => {
      if (req.method === 'POST' && !req.headers['x-payment']) { res.status(402).json({ error: 'Payment required' }); return; }
      next();
    };
    const h = createRailDispatcher({
      rail: 'a2mcp', prefix: '/a2mcp', mode: 'live', routes: 1, timers,
      init: async () => {
        calls++;
        if (calls <= 2) throw new Error(`facilitator down (${calls})`);
        return { middleware: paid, requiresPayment: (req: Request) => req.method === 'POST' };
      },
    });
    app.all('/a2mcp/*', h.dispatch);
    app.post('/a2mcp/get_trade_call', (q, r) => r.json({ served: true, marked: hasVerifiedPayment(q, 'a2mcp') }));
    await h.firstAttempt;
    expect(h.isReady()).toBe(false);
    expect(timers.retries().map((r) => r.ms)).toEqual([RAIL_MOUNT_BACKOFF_MS[0]]);

    timers.fireRetry(); await flush(); await flush();
    expect(h.isReady()).toBe(false);
    expect(timers.retries().map((r) => r.ms)).toEqual([RAIL_MOUNT_BACKOFF_MS[1]]);

    timers.fireRetry(); await flush(); await flush();
    expect(h.isReady()).toBe(true);
    expect(h.attempts()).toBe(3);
    expect(servedState().a2mcp).toMatchObject({ status: 'served', mode: 'live' });

    const l = await listen(app); server = l.server;
    expect((await fetch(`${l.base}/a2mcp/get_trade_call`, { method: 'POST' })).status).toBe(402);
    const paidRes = await fetch(`${l.base}/a2mcp/get_trade_call`, { method: 'POST', headers: { 'x-payment': 'ok' } });
    expect(paidRes.status).toBe(200);
    expect(await paidRes.json()).toEqual({ served: true, marked: true });
    expect(unhandled).toEqual([]);
  });

  it('a synchronous throw from init() is a failed attempt, not a crash', async () => {
    const app = express();
    const timers = manualTimers();
    const h = createRailDispatcher({
      rail: 'a2mcp', prefix: '/a2mcp', mode: 'live', routes: 1, timers,
      init: (() => { throw new Error('sync boom'); }) as unknown as () => Promise<RailPaymentGate>,
    });
    app.all('/a2mcp/*', h.dispatch);
    await h.firstAttempt;
    expect(h.isReady()).toBe(false);
    expect(servedState().a2mcp.reason).toContain('sync boom');
    expect(unhandled).toEqual([]);
  });

  it('a hung init attempt is bounded by the per-attempt timeout', async () => {
    const app = express();
    const timers = manualTimers();
    const h = createRailDispatcher({
      rail: 'a2mcp', prefix: '/a2mcp', mode: 'live', routes: 1, timers, attemptTimeoutMs: ATTEMPT_TIMEOUT_MS,
      init: () => new Promise<RailPaymentGate>(() => { /* never settles */ }),
    });
    app.all('/a2mcp/*', h.dispatch);
    // The only queued timer is the attempt timeout; firing it fails the attempt.
    expect(timers.queue.map((q) => q.ms)).toEqual([ATTEMPT_TIMEOUT_MS]);
    timers.fireTimeout();
    await h.firstAttempt;
    expect(h.isReady()).toBe(false);
    expect(servedState().a2mcp.reason).toContain('timed out after 30000ms');
  });
});

describe('rail-mount — RT-01: ownership by the matcher\'s normalization, and the verified-payment marker', () => {
  let server: Server | undefined;
  let unhandled: unknown[];
  const onUnhandled = (e: unknown) => { unhandled.push(e); };

  beforeEach(() => {
    _resetRailServedStateForTest();
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
  });
  afterEach(async () => {
    process.off('unhandledRejection', onUnhandled);
    _resetRailServedStateForTest();
    if (server) await new Promise((r) => server!.close(r));
    server = undefined;
  });

  /** A ready dispatcher over `gate`, with handlers that report whether THIS request carries the marker. */
  async function readyApp(gate: RailPaymentGate): Promise<string> {
    const app = express();
    const h = createRailDispatcher({ rail: 'a2mcp', prefix: '/a2mcp', mode: 'live', routes: 1, timers: manualTimers(), init: async () => gate });
    await h.firstAttempt;
    expect(h.isReady()).toBe(true);
    app.all('/a2mcp/*', h.dispatch);
    app.all('/a2mcp/get_trade_call', (q, r) => r.json({ a2mcp: hasVerifiedPayment(q, 'a2mcp'), httpX402: hasVerifiedPayment(q, 'httpX402') }));
    const l = await listen(app); server = l.server;
    return l.base;
  }

  it('dark: every spelling of a prefix path is owned — 503 + X-Rail-State on every method; outside the prefix passes through', async () => {
    const app = express();
    const h = createRailDispatcher({
      rail: 'a2mcp', prefix: '/a2mcp', mode: 'live', routes: 1, timers: manualTimers(),
      init: async () => { throw new Error('OKX getSupported failed: 401'); },
    });
    await h.firstAttempt;
    // Registered on EVERY path, so the ownership test itself — not Express's route match — decides.
    app.use(h.dispatch);
    let handlerRuns = 0;
    app.all('*', (_q, r) => { handlerRuns++; r.status(299).json({ passedThrough: true }); });
    const l = await listen(app); server = l.server;

    const owned = [
      '/a2mcp/get_trade_call', '/A2MCP/get_trade_call', '/A2McP/get_trade_call', '/a2mcp/GET_TRADE_CALL',
      '/a2mcp/get_trade_call/', '/a2mcp//get_trade_call', '/%612mcp/get_trade_call', '/a2mcp%2Fget_trade_call',
      '/a2mcp', '/A2MCP/',
    ];
    for (const path of owned) {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']) {
        const res = await fetch(`${l.base}${path}`, { method });
        expect(res.status, `${method} ${path}`).toBe(503);
        expect(res.headers.get('x-rail-state'), `${method} ${path}`).toMatch(/^initializing; since=/);
      }
    }
    for (const path of ['/a2mcpx/get_trade_call', '/health', '/x402/get_trade_call', '/mcp']) {
      expect((await fetch(`${l.base}${path}`, { method: 'POST' })).status, `POST ${path} is not the rail's`).toBe(299);
    }
    expect(handlerRuns).toBe(4);
  });

  it('normalizeRailPath is byte-equal to @okxweb3/x402-core\'s own normalizePath (the matcher behind the dispatcher)', () => {
    const vendor = (x402HTTPResourceServer.prototype as unknown as { normalizePath(p: string): string }).normalizePath;
    expect(typeof vendor).toBe('function');
    const corpus = [
      '/a2mcp/get_trade_call', '/A2MCP/get_trade_call', '/a2mcp/get_trade_call/', '/a2mcp/get_trade_call///',
      '//a2mcp/get_trade_call', '/a2mcp//get_trade_call', '/%612mcp/get_trade_call', '/a2mcp%2Fget_trade_call',
      '/a2mcp\\get_trade_call', '/a2mcp/%E0%A4%A', '/a2mcp/get_trade_call?x=1#y', '/a2mcp/get_trade_call#frag',
      '/', '//', '', '/a2mcp', '/a2mcp/', '/a2mcp/%2e%2e/x', '/a2mcp/%5C%5Cx',
    ];
    for (const p of corpus) expect(normalizeRailPath(p), JSON.stringify(p)).toBe(vendor.call(null, p));
  });

  it('the marker is written ONLY for a next() the middleware gives a request its own requiresPayment() prices', async () => {
    // A middleware that admits everything — as the OKX one does for a free GET ('requiresPayment' false)
    // and for a verified payment — so the only thing distinguishing the two is the predicate.
    const base = await readyApp({ middleware: (_q, _r, next) => next(), requiresPayment: (req) => req.method === 'POST' });
    const paidPost = await (await fetch(`${base}/a2mcp/get_trade_call`, { method: 'POST' })).json();
    expect(paidPost).toEqual({ a2mcp: true, httpX402: false }); // per rail: no other rail's handler may accept it
    const freeGet = await (await fetch(`${base}/a2mcp/get_trade_call`, { headers: { 'x-payment': 'forged' } })).json();
    expect(freeGet).toEqual({ a2mcp: false, httpX402: false });
    expect(unhandled).toEqual([]);
  });

  it('next(err) from the middleware, or a throwing predicate, writes no marker — and nothing escapes as an unhandled rejection', async () => {
    const errBase = await readyApp({ middleware: (_q, _r, next) => next(new Error('facilitator 502')), requiresPayment: () => true });
    expect((await fetch(`${errBase}/a2mcp/get_trade_call`, { method: 'POST' })).status).toBe(500); // Express's error path, no handler
    await new Promise((r) => server!.close(r)); server = undefined;

    const throwBase = await readyApp({ middleware: async (_q, _r, next) => { next(); }, requiresPayment: () => { throw new Error('predicate boom'); } });
    expect(await (await fetch(`${throwBase}/a2mcp/get_trade_call`, { method: 'POST' })).json()).toEqual({ a2mcp: false, httpX402: false });
    await flush();
    expect(unhandled).toEqual([]);
  });
});

describe('rail-mount — backoff schedule', () => {
  it('1, 5, 15, 60 min, then hourly forever', () => {
    expect([1, 2, 3, 4, 5, 9].map(backoffFor)).toEqual([60_000, 300_000, 900_000, 3_600_000, 3_600_000, 3_600_000]);
  });

  it('jitter stays within ±20 % and never below 1 s', () => {
    expect(jitteredDelay(60_000, 0)).toBe(48_000);
    expect(jitteredDelay(60_000, 1)).toBe(72_000);
    expect(jitteredDelay(60_000, 0.5)).toBe(60_000);
    expect(jitteredDelay(100, 0)).toBe(1_000);
  });
});
