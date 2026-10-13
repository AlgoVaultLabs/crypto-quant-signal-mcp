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
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express, { type Express, type RequestHandler } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  createRailDispatcher,
  backoffFor,
  jitteredDelay,
  RAIL_MOUNT_BACKOFF_MS,
  type RailMountTimers,
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
        return paid;
      },
    });
    app.all('/a2mcp/*', h.dispatch);
    app.post('/a2mcp/get_trade_call', (_q, r) => r.json({ served: true }));
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
    expect(await paidRes.json()).toEqual({ served: true });
    expect(unhandled).toEqual([]);
  });

  it('a synchronous throw from init() is a failed attempt, not a crash', async () => {
    const app = express();
    const timers = manualTimers();
    const h = createRailDispatcher({
      rail: 'a2mcp', prefix: '/a2mcp', mode: 'live', routes: 1, timers,
      init: (() => { throw new Error('sync boom'); }) as unknown as () => Promise<RequestHandler>,
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
      init: () => new Promise<RequestHandler>(() => { /* never settles */ }),
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
