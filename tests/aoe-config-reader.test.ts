/**
 * R8 (Path 4 — 2026-04-25): unit tests for the additive AOE per-venue
 * config reader. Validates the FEATURE-FLAG gating + resolution order
 * (per-venue → global → none). Uses a stubbed Redis client so no live
 * Redis is required.
 *
 * Coverage:
 * 1. ALGOVAULT_AOE_CONFIG_SOURCE default ("hardcoded") → reader never
 *    touches Redis, always returns {config: null, source: 'none'}.
 * 2. With flag "redis" + per-venue hit → source = "venue:HL".
 * 3. With flag "redis" + per-venue miss + global hit → source = "global_fallback".
 * 4. With flag "redis" + both miss → source = "none", config = null.
 * 5. AOE_PER_VENUE_CONSUMER_ENABLED=false → per-venue key is NEVER read;
 *    only global key is consulted (instant rollback to pre-Path-4 behaviour).
 * 6. Null venue + per-venue enabled → only global key is consulted
 *    (source = "global").
 * 7. Payload containing outcome_return_pct is REJECTED (returns null) —
 *    CLAUDE.md Data Integrity LAW defensive layer on the consumer side.
 * 8. Cache hit returns the same result without re-reading Redis.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the redis client module BEFORE importing the reader so the reader's
// `createClient` gets the mock.
const mockGet = vi.fn<(key: string) => Promise<string | null>>();
const mockConnect = vi.fn();
const mockQuit = vi.fn();

vi.mock('redis', () => ({
    createClient: vi.fn(() => ({
        connect: mockConnect,
        quit: mockQuit,
        on: vi.fn(),
        get: mockGet,
        get isOpen() { return true; },
    })),
}));

import {
    readAoeConfig,
    _resetAoeConfigCache,
    _resetAoeRedisClient,
    _getAoeCacheSize,
} from '../src/lib/aoe-config-reader.js';

const VALID_HL = JSON.stringify({
    config_id: 'hl-cfg-1', strategy: 'RSI_BULL_1h',
    weights: { rsi: 0.4, ema: 0.1, funding: 0.3, oi: 0.2 },
    published_at: '2026-04-25T00:00:00Z', source: 'aoe-retune',
    shadow_stats: { oos_sharpe: 1.5, stability_score: 0.7, pfe_wr: 0.55 },
    venue: 'HL',
});
const VALID_GLOBAL = JSON.stringify({
    config_id: 'global-cfg-1', strategy: 'RSI_BULL_1h',
    weights: { rsi: 0.3, ema: 0.1, funding: 0.25, oi: 0.35 },
    published_at: '2026-04-25T00:00:00Z', source: 'aoe-retune',
    shadow_stats: { oos_sharpe: 1.2, stability_score: 0.6, pfe_wr: 0.52 },
    venue: null,
});

describe('readAoeConfig — feature-flag gating + resolution order', () => {
    beforeEach(async () => {
        await _resetAoeRedisClient();
        _resetAoeConfigCache();
        mockGet.mockReset();
        mockConnect.mockReset();
        delete process.env.ALGOVAULT_AOE_CONFIG_SOURCE;
        delete process.env.AOE_PER_VENUE_CONSUMER_ENABLED;
    });

    afterEach(() => {
        delete process.env.ALGOVAULT_AOE_CONFIG_SOURCE;
        delete process.env.AOE_PER_VENUE_CONSUMER_ENABLED;
    });

    it('returns none without touching Redis when outer flag is default', async () => {
        const r = await readAoeConfig('RSI_BULL_1h', 'HL');
        expect(r).toEqual({ config: null, source: 'none' });
        expect(mockGet).not.toHaveBeenCalled();
    });

    it('returns none without touching Redis when outer flag is explicitly hardcoded', async () => {
        process.env.ALGOVAULT_AOE_CONFIG_SOURCE = 'hardcoded';
        const r = await readAoeConfig('RSI_BULL_1h', 'HL');
        expect(r).toEqual({ config: null, source: 'none' });
        expect(mockGet).not.toHaveBeenCalled();
    });

    it('per-venue hit returns venue:HL source', async () => {
        process.env.ALGOVAULT_AOE_CONFIG_SOURCE = 'redis';
        mockGet.mockImplementation(async (k: string) =>
            k === 'algovault:aoe:recommended_weights:HL:RSI_BULL_1h' ? VALID_HL : null);
        const r = await readAoeConfig('RSI_BULL_1h', 'HL');
        expect(r.source).toBe('venue:HL');
        expect(r.config?.venue).toBe('HL');
        expect(r.config?.weights.rsi).toBe(0.4);
    });

    it('per-venue miss + global hit returns global_fallback source', async () => {
        process.env.ALGOVAULT_AOE_CONFIG_SOURCE = 'redis';
        mockGet.mockImplementation(async (k: string) =>
            k === 'algovault:aoe:recommended_weights:RSI_BULL_1h' ? VALID_GLOBAL : null);
        const r = await readAoeConfig('RSI_BULL_1h', 'HL');
        expect(r.source).toBe('global_fallback');
        expect(r.config?.venue).toBeNull();
    });

    it('both miss returns {config: null, source: none}', async () => {
        process.env.ALGOVAULT_AOE_CONFIG_SOURCE = 'redis';
        mockGet.mockResolvedValue(null);
        const r = await readAoeConfig('RSI_BULL_1h', 'HL');
        expect(r).toEqual({ config: null, source: 'none' });
    });

    it('AOE_PER_VENUE_CONSUMER_ENABLED=false skips per-venue key entirely (instant rollback)', async () => {
        process.env.ALGOVAULT_AOE_CONFIG_SOURCE = 'redis';
        process.env.AOE_PER_VENUE_CONSUMER_ENABLED = 'false';
        mockGet.mockImplementation(async (k: string) =>
            k === 'algovault:aoe:recommended_weights:RSI_BULL_1h' ? VALID_GLOBAL : null);
        const r = await readAoeConfig('RSI_BULL_1h', 'HL');
        expect(r.source).toBe('global');
        // Verify we NEVER queried the per-venue key.
        const keysQueried = mockGet.mock.calls.map((c) => c[0]);
        expect(keysQueried).not.toContain('algovault:aoe:recommended_weights:HL:RSI_BULL_1h');
    });

    it('null venue + per-venue enabled reads only global key', async () => {
        process.env.ALGOVAULT_AOE_CONFIG_SOURCE = 'redis';
        mockGet.mockImplementation(async (k: string) =>
            k === 'algovault:aoe:recommended_weights:RSI_BULL_1h' ? VALID_GLOBAL : null);
        const r = await readAoeConfig('RSI_BULL_1h', null);
        expect(r.source).toBe('global');
        const keysQueried = mockGet.mock.calls.map((c) => c[0]);
        expect(keysQueried).toEqual(['algovault:aoe:recommended_weights:RSI_BULL_1h']);
    });

    it('rejects payload containing outcome_return_pct (defensive)', async () => {
        process.env.ALGOVAULT_AOE_CONFIG_SOURCE = 'redis';
        const LEAKED = JSON.stringify({
            config_id: 'leak', strategy: 'RSI_BULL_1h',
            weights: { rsi: 1.0 }, published_at: '2026-04-25T00:00:00Z',
            source: 'aoe-retune',
            shadow_stats: { oos_sharpe: null, stability_score: null, pfe_wr: null },
            venue: 'HL',
            outcome_return_pct: 0.012345, // leaked!
        });
        mockGet.mockImplementation(async (k: string) =>
            k === 'algovault:aoe:recommended_weights:HL:RSI_BULL_1h' ? LEAKED : null);
        const r = await readAoeConfig('RSI_BULL_1h', 'HL');
        // Poisoned payload rejected → falls through to global (also null in
        // this setup) → source = 'none'.
        expect(r.source).toBe('none');
        expect(r.config).toBeNull();
    });

    it('caches reads within the 60s TTL', async () => {
        process.env.ALGOVAULT_AOE_CONFIG_SOURCE = 'redis';
        mockGet.mockImplementation(async (k: string) =>
            k === 'algovault:aoe:recommended_weights:HL:RSI_BULL_1h' ? VALID_HL : null);
        const r1 = await readAoeConfig('RSI_BULL_1h', 'HL');
        expect(r1.source).toBe('venue:HL');
        const callsAfterFirst = mockGet.mock.calls.length;
        // Second read — cache hit; no new Redis calls.
        const r2 = await readAoeConfig('RSI_BULL_1h', 'HL');
        expect(r2.source).toBe('venue:HL');
        expect(mockGet.mock.calls.length).toBe(callsAfterFirst);
        expect(_getAoeCacheSize()).toBe(1);
    });
});
