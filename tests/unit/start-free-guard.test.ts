import { describe, it, expect, beforeEach, vi } from 'vitest';
import { startFree, type DeferredSignupDeps, type StartFreeSignal } from '../../src/lib/deferred-signup.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * OPS-AUDIT-REMEDIATION-HIGH-W1 · Ch2 · SEC-05.
 *
 * POST /api/start-free was unauthenticated AND unrate-limited, and minted an av_free_ key per
 * call — each with its own 100-call/month quota, so a loop bought unlimited free quota. Every
 * call also drove a live getTradeSignal (venue REST + DB writes) and a full free_keys
 * scan+delete, making the same loop an amplification vector.
 *
 * The generator rule: a credential-issuing helper MUST take a caller identity and bound on it.
 */
describe('startFree — issuance is bounded by caller identity (SEC-05)', () => {
  const makeDeps = (over: Partial<DeferredSignupDeps> = {}): DeferredSignupDeps => ({
    mintEphemeral: vi.fn(async () => 'av_free_' + '0'.repeat(24)),
    recordAttribution: vi.fn(),
    getSignal: vi.fn(async (): Promise<StartFreeSignal> => ({ asset: 'BTC', timeframe: '1h', verdict: 'BUY', confidence: 61 })),
    merge: vi.fn(async () => 'av_free_merged'),
    ...over,
  });

  it('passes the caller identity through to the mint helper', async () => {
    const deps = makeDeps();
    await startFree({ ip_hash: 'hash_caller_a' }, deps);
    // The regression: the route never passed ip_hash, so the mint had nothing to bound on.
    expect(deps.mintEphemeral).toHaveBeenCalledWith(null, 'hash_caller_a');
  });

  it('propagates the issuance-cap refusal instead of returning a key', async () => {
    const capErr = Object.assign(new Error('cap'), { code: 'EPHEMERAL_MINT_CAP' });
    const deps = makeDeps({ mintEphemeral: vi.fn(async () => { throw capErr; }) });
    await expect(startFree({ ip_hash: 'hash_over_cap' }, deps)).rejects.toThrow('cap');
  });

  it('does NOT compute a live trade signal on the anonymous path', async () => {
    // The shipped getSignal must read the warmed grid, never getTradeSignal.
    // Strip BLOCK comments as well as line comments: the fix's own JSDoc names the call it
    // replaced, so a comment-blind check matches its own explanation and fails on a correct tree.
    const src = readFileSync(resolve(ROOT, 'src/lib/deferred-signup.ts'), 'utf8');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    expect(code).toContain('getGridSnapshot()');
    expect(code).not.toContain('getTradeSignal(');
    expect(code).not.toMatch(/^import .*get-trade-call/m);
  });

  it('an empty grid yields an absent signal — it never falls back to a live call', async () => {
    const { _setSnapshotForTest } = await import('../../src/lib/cross-asset-grid.js');
    _setSnapshotForTest([]);
    const { defaultDeferredSignupDeps } = await import('../../src/lib/deferred-signup.js');
    const sig = await defaultDeferredSignupDeps.getSignal();
    expect(sig).toEqual({ asset: 'BTC', timeframe: '1h', verdict: null, confidence: null });
    _setSnapshotForTest(null);
  });

  it('serves the demo verdict from the warmed grid when the BTC/1h cell is present', async () => {
    const { _setSnapshotForTest } = await import('../../src/lib/cross-asset-grid.js');
    _setSnapshotForTest([
      { coin: 'ETH', timeframe: '1h', signal: 'SELL', confidence: 51, exchange: 'BINANCE', regime: 'TRENDING' },
      { coin: 'BTC', timeframe: '1h', signal: 'BUY', confidence: 72, exchange: 'BINANCE', regime: 'TRENDING' },
    ] as never);
    const { defaultDeferredSignupDeps } = await import('../../src/lib/deferred-signup.js');
    const sig = await defaultDeferredSignupDeps.getSignal();
    expect(sig.verdict).toBe('BUY');
    expect(sig.confidence).toBe(72);
    _setSnapshotForTest(null);
  });
});

describe('mintEphemeralKey — bounded on identity (SEC-05 generator)', () => {
  beforeEach(async () => {
    const { _resetEphemeralMintBoundForTest } = await import('../../src/lib/free-keys-store.js');
    _resetEphemeralMintBoundForTest();
  });

  it('refuses an unidentifiable caller rather than minting unbounded', async () => {
    const { mintEphemeralKey, EphemeralMintQuotaError } = await import('../../src/lib/free-keys-store.js');
    await expect(mintEphemeralKey(null, null)).rejects.toBeInstanceOf(EphemeralMintQuotaError);
    await expect(mintEphemeralKey(null, '')).rejects.toBeInstanceOf(EphemeralMintQuotaError);
  });

  it('the route wires the limiter and the identity', () => {
    const idx = readFileSync(resolve(ROOT, 'src/index.ts'), 'utf8');
    const start = idx.indexOf("app.post('/api/start-free'");
    expect(start).toBeGreaterThan(-1);
    const body = idx.slice(start, idx.indexOf('\n  });', start));
    expect(idx).toContain('const startFreeLimiter = rateLimit(');
    expect(idx.slice(start - 400, start)).toContain('startFreeLimiter');
    expect(body).toContain('ip_hash:');
    // The cap must surface as 429, not a 500.
    expect(body).toContain('EPHEMERAL_MINT_CAP');
    expect(body).toContain('429');
  });
});
