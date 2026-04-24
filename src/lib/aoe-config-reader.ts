/**
 * AOE promoted-config reader (cross-repo contract with autonomous-optimizer).
 *
 * Reads Redis keys written by the AOE promote_hourly flow. Per-venue first,
 * global fallback. All reads are gated behind TWO independent env flags so
 * production posture is unchanged until BOTH are flipped:
 *
 *   ALGOVAULT_AOE_CONFIG_SOURCE
 *     default: "hardcoded" — reader returns null; caller uses its static
 *       composite-scorer weights (pre-AOE behaviour).
 *     value:   "redis"     — reader attempts Redis lookup; on hit, returns
 *       the AOE-authored config for the caller to merge.
 *
 *   AOE_PER_VENUE_CONSUMER_ENABLED
 *     default: "true" — per-venue lookup is attempted first, with global
 *       fallback (Path 4 behaviour).
 *     value:   "false" — reader reads ONLY the global key (pre-Path-4
 *       behaviour; instant rollback without redeploy).
 *
 * Redis key contract (Path 4, 2026-04-25)
 * ---------------------------------------
 *   algovault:aoe:recommended_weights:<strategy>            (global)
 *   algovault:aoe:recommended_weights:<venue>:<strategy>    (per-venue)
 *
 * Value shape (JSON):
 *   {
 *     config_id: string,
 *     strategy: string,
 *     weights: Record<string, number>,
 *     published_at: string,     // ISO 8601
 *     source: "aoe-retune",
 *     shadow_stats: { oos_sharpe: number, stability_score: number, pfe_wr: number },
 *     venue: string | null      // null = global; "HL"/"BINANCE"/... per-venue
 *   }
 *
 * See ``src/feedback/promote_flow.py`` in autonomous-optimizer for the
 * publisher side. NEVER includes ``outcome_return_pct`` (Data Integrity LAW).
 *
 * Telemetry
 * ---------
 * The reader emits an ``aoe_config_source`` field in the result object
 * (values: ``"venue:HL"``, ``"venue:BINANCE"``, ... / ``"global"`` /
 * ``"global_fallback"`` / ``"none"``). Callers should surface this in the
 * response's ``_algovault`` block so operators can verify which cohort
 * served a given signal request. Weight values themselves MUST NOT be
 * exposed on public surfaces — they're internal to the quant engine.
 */

import { createClient, type RedisClientType } from 'redis';

const GLOBAL_KEY_TEMPLATE = 'algovault:aoe:recommended_weights:';
const PER_VENUE_KEY_TEMPLATE = 'algovault:aoe:recommended_weights:';
const CACHE_TTL_MS = 60_000; // 60s — local cache to avoid hammering Redis

export type AoeWeights = Record<string, number>;

export interface AoeConfig {
    config_id: string;
    strategy: string;
    weights: AoeWeights;
    published_at: string;
    source: 'aoe-retune';
    shadow_stats: {
        oos_sharpe: number | null;
        stability_score: number | null;
        pfe_wr: number | null;
    };
    venue: string | null;
}

export type ConfigSource =
    | `venue:${string}`
    | 'global'
    | 'global_fallback'
    | 'none';

export interface AoeReadResult {
    config: AoeConfig | null;
    source: ConfigSource;
}

interface CacheEntry {
    result: AoeReadResult;
    expires_at: number;
}

/**
 * Process-lifetime Redis client + local cache. Lazy-instantiated; a failed
 * client instantiation leaves the reader in a degraded "returns null"
 * state rather than throwing, so signal-MCP availability is not dependent
 * on Redis availability (AOE is a secondary signal source; caller's
 * fallback weights must always work).
 */
let _client: RedisClientType | null = null;
let _client_init_failed = false;
const _cache: Map<string, CacheEntry> = new Map();

function _isEnabled(): boolean {
    return process.env.ALGOVAULT_AOE_CONFIG_SOURCE === 'redis';
}

function _isPerVenueEnabled(): boolean {
    // Default TRUE per Path 4 approval. Flip to 'false' for instant
    // rollback to global-only reads without a redeploy.
    const val = (process.env.AOE_PER_VENUE_CONSUMER_ENABLED ?? 'true').toLowerCase();
    return val !== 'false' && val !== '0' && val !== 'no';
}

async function _getClient(): Promise<RedisClientType | null> {
    if (_client_init_failed) return null;
    if (_client && _client.isOpen) return _client;
    try {
        const url = process.env.AOE_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://localhost:6379/0';
        _client = createClient({ url });
        _client.on('error', (_err) => {
            // Silently keep cached state; don't let Redis errors crash
            // the signal-MCP request path.
        });
        await _client.connect();
        return _client;
    } catch {
        _client_init_failed = true;
        _client = null;
        return null;
    }
}

async function _rawRead(key: string): Promise<AoeConfig | null> {
    const client = await _getClient();
    if (!client) return null;
    try {
        const raw = await client.get(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as AoeConfig;
        // Defensive: never trust upstream to have stripped internals.
        // `outcome_return_pct` MUST NEVER appear — if it does, reject the
        // whole payload rather than risk leaking it downstream.
        if ('outcome_return_pct' in (parsed as unknown as Record<string, unknown>)) {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

/**
 * Read the AOE-promoted config for a given (strategy, venue) pair.
 *
 * Resolution order when per-venue is enabled:
 *   1. algovault:aoe:recommended_weights:<venue>:<strategy>
 *   2. algovault:aoe:recommended_weights:<strategy>  (fallback)
 *   3. null (no config; caller uses static weights)
 *
 * When AOE_PER_VENUE_CONSUMER_ENABLED=false, step 1 is skipped (instant
 * rollback to global-only read).
 *
 * When ALGOVAULT_AOE_CONFIG_SOURCE is not "redis" (default), returns
 * ``{config: null, source: 'none'}`` without touching Redis.
 *
 * @param strategy  Strategy key (e.g. "RSI_BULL_1h")
 * @param venue     Exchange venue — "HL" / "BINANCE" / "BYBIT" / "OKX" /
 *                  "BITGET" / null (request global only)
 */
export async function readAoeConfig(
    strategy: string,
    venue: string | null,
): Promise<AoeReadResult> {
    if (!_isEnabled()) {
        return { config: null, source: 'none' };
    }

    // Cache lookup.
    const cacheKey = `${venue ?? '__global__'}:${strategy}`;
    const cached = _cache.get(cacheKey);
    if (cached && cached.expires_at > Date.now()) {
        return cached.result;
    }

    let result: AoeReadResult;

    if (venue && _isPerVenueEnabled()) {
        // Step 1: try per-venue key.
        const perVenueKey = `${PER_VENUE_KEY_TEMPLATE}${venue}:${strategy}`;
        const perVenue = await _rawRead(perVenueKey);
        if (perVenue) {
            result = { config: perVenue, source: `venue:${venue}` };
        } else {
            // Step 2: global fallback.
            const globalKey = `${GLOBAL_KEY_TEMPLATE}${strategy}`;
            const global = await _rawRead(globalKey);
            result = global
                ? { config: global, source: 'global_fallback' }
                : { config: null, source: 'none' };
        }
    } else {
        // Per-venue disabled OR venue is null → only read global key.
        const globalKey = `${GLOBAL_KEY_TEMPLATE}${strategy}`;
        const global = await _rawRead(globalKey);
        result = global
            ? { config: global, source: 'global' }
            : { config: null, source: 'none' };
    }

    _cache.set(cacheKey, {
        result,
        expires_at: Date.now() + CACHE_TTL_MS,
    });
    return result;
}

// ── Test seams ──────────────────────────────────────────────────────────────

/** Clear the local cache. For tests only. */
export function _resetAoeConfigCache(): void {
    _cache.clear();
}

/** Force-close the Redis client + reset init state. For tests only. */
export async function _resetAoeRedisClient(): Promise<void> {
    if (_client && _client.isOpen) {
        try {
            await _client.quit();
        } catch {
            // ignore
        }
    }
    _client = null;
    _client_init_failed = false;
    _cache.clear();
}

/** Introspect the cache size. For tests only. */
export function _getAoeCacheSize(): number {
    return _cache.size;
}
