/**
 * OPS-ACTIVATION-LEAK-FIX-W1 CH2 — unit tests for the `mcp_tools_list` funnel
 * event. Pure: an injected recorder spy + module-state reset between tests; no
 * DB, no network. Covers per-session dedup (LRU), the identity_tier projection,
 * the missing-session guard, and the fail-open contract.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  recordMcpToolsListEvent,
  shouldEmitToolsList,
  _resetToolsListForTest,
} from '../src/lib/tools-list-event.js';

afterEach(() => {
  _resetToolsListForTest();
  vi.restoreAllMocks();
});

describe('tools-list-event — recordMcpToolsListEvent', () => {
  it('emits once per session with the exact mcp_tools_list payload + identity_tier', () => {
    const rec = vi.fn();
    const fired = recordMcpToolsListEvent(
      { sessionId: 'tok-abc', licenseTier: 'free', identityTier: 'token' },
      rec,
    );
    expect(fired).toBe(true);
    expect(rec).toHaveBeenCalledTimes(1);
    expect(rec).toHaveBeenCalledWith({
      eventType: 'mcp_tools_list',
      sessionId: 'tok-abc',
      licenseTier: 'free',
      meta: { identity_tier: 'token' },
    });
  });

  it('dedups subsequent tools/list for the SAME session (one row/session)', () => {
    const rec = vi.fn();
    expect(recordMcpToolsListEvent({ sessionId: 's1', licenseTier: 'free', identityTier: 'fallback' }, rec)).toBe(true);
    expect(recordMcpToolsListEvent({ sessionId: 's1', licenseTier: 'free', identityTier: 'fallback' }, rec)).toBe(false);
    expect(recordMcpToolsListEvent({ sessionId: 's1', licenseTier: 'free', identityTier: 'fallback' }, rec)).toBe(false);
    expect(rec).toHaveBeenCalledTimes(1);
  });

  it('emits separately for DISTINCT sessions', () => {
    const rec = vi.fn();
    recordMcpToolsListEvent({ sessionId: 's1', licenseTier: 'free', identityTier: 'token' }, rec);
    recordMcpToolsListEvent({ sessionId: 's2', licenseTier: 'free', identityTier: 'anon' }, rec);
    expect(rec).toHaveBeenCalledTimes(2);
    expect(rec.mock.calls[1][0].meta).toEqual({ identity_tier: 'anon' });
  });

  it('does NOT emit when sessionId is missing (null/undefined/empty)', () => {
    const rec = vi.fn();
    expect(recordMcpToolsListEvent({ sessionId: null, licenseTier: 'free', identityTier: 'anon' }, rec)).toBe(false);
    expect(recordMcpToolsListEvent({ sessionId: undefined, licenseTier: 'free', identityTier: 'anon' }, rec)).toBe(false);
    expect(recordMcpToolsListEvent({ sessionId: '', licenseTier: 'free', identityTier: 'anon' }, rec)).toBe(false);
    expect(rec).not.toHaveBeenCalled();
  });

  it('is fail-open: a throwing recorder never propagates (returns false)', () => {
    const rec = vi.fn(() => {
      throw new Error('db down');
    });
    expect(() =>
      recordMcpToolsListEvent({ sessionId: 's-throw', licenseTier: 'free', identityTier: 'token' }, rec),
    ).not.toThrow();
  });

  it('shouldEmitToolsList returns true once then false (raw dedup primitive)', () => {
    expect(shouldEmitToolsList('x')).toBe(true);
    expect(shouldEmitToolsList('x')).toBe(false);
    expect(shouldEmitToolsList('y')).toBe(true);
  });
});
