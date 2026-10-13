/**
 * OPS-A2MCP-SERVED-TRUTH-W1 CH1 R1 — the one runtime served-state per paid rail.
 *
 * Ruling R-1 (SERVED, NOT CONFIGURED): consumers read what the MOUNT reported. These pin the
 * contract the nudge relies on: unreported = not served, mode-qualified served, one log line per
 * transition (never per repeated mark), and a read side callers cannot mutate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PAID_RAILS,
  markServed,
  markDark,
  servedState,
  isRailServed,
  _resetRailServedStateForTest,
} from '../../src/lib/rail-served-state.js';

describe('rail-served-state', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    _resetRailServedStateForTest();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { logSpy.mockRestore(); _resetRailServedStateForTest(); });

  it('covers exactly the three paid rails, all UNREPORTED before any mount — and unreported is NOT served', () => {
    expect([...PAID_RAILS].sort()).toEqual(['a2mcp', 'acp', 'httpX402']);
    const s = servedState();
    for (const r of PAID_RAILS) {
      expect(s[r].status).toBe('unreported');
      expect(isRailServed(s, r)).toBe(false);
    }
  });

  it('markServed → served (mode recorded); markDark → dark with its reason', () => {
    markServed('a2mcp', { mode: 'live', routes: 5 });
    expect(servedState().a2mcp).toMatchObject({ status: 'served', mode: 'live', reason: 'mounted mode=live routes=5' });
    markDark('a2mcp', 'live-mount failed: OKX getSupported failed: 401');
    const e = servedState().a2mcp;
    expect(e.status).toBe('dark');
    expect(e.mode).toBeUndefined();
    expect(e.reason).toBe('live-mount failed: OKX getSupported failed: 401');
  });

  it('isRailServed: a mode-qualified check refuses a different mode (stub is not live)', () => {
    markServed('a2mcp', { mode: 'stub', routes: 5 });
    const s = servedState();
    expect(isRailServed(s, 'a2mcp')).toBe(true);
    expect(isRailServed(s, 'a2mcp', 'stub')).toBe(true);
    expect(isRailServed(s, 'a2mcp', 'live')).toBe(false);
  });

  it('logs ONE line per transition, in the greppable form; a repeated identical mark is silent', () => {
    markDark('httpX402', 'off');
    markDark('httpX402', 'off');
    markServed('httpX402', { mode: 'cdp', routes: 7 });
    markServed('httpX402', { mode: 'cdp', routes: 7 });
    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    expect(lines).toEqual([
      '[rail-served-state] httpX402=dark reason=off',
      '[rail-served-state] httpX402=served reason=mounted mode=cdp routes=7',
    ]);
  });

  it('a mode change while served is a transition (stub → live logs again)', () => {
    markServed('a2mcp', { mode: 'stub' });
    markServed('a2mcp', { mode: 'live' });
    expect(logSpy).toHaveBeenCalledTimes(2);
  });

  it('servedState() is a snapshot: mutating it does not change the record', () => {
    markServed('acp', { mode: 'live' });
    const snap = servedState() as unknown as Record<string, { status: string }>;
    snap.acp.status = 'dark';
    expect(servedState().acp.status).toBe('served');
  });

  it('rails are independent: marking one leaves the others untouched', () => {
    markServed('httpX402', { mode: 'cdp' });
    expect(servedState().a2mcp.status).toBe('unreported');
    expect(servedState().acp.status).toBe('unreported');
  });
});
