/**
 * OPS-CLIENT-ATTRIBUTION-W1 (2026-07-31): the UA fixture table.
 *
 * The boundary between "an autonomous agent calling from code" and "a crawler" is the whole
 * point of this wave, so it is pinned as a TABLE of real UA strings covering BOTH directions —
 * including the ambiguous ones — rather than left as a vibe.
 *
 * The defect being closed: `isbot` flags bare SDK UAs (`python-httpx`, `axios`, `undici`,
 * `node`) as crawlers, which is exactly what an ICP agent looks like, so "🟢 Recognized
 * clients" read 0 across a 24h window in which 70 distinct sessions connected (2026-07-31).
 */
import { describe, expect, it } from 'vitest';
import {
  classifyClient,
  normalizeUaForStorage,
  clientNamesOfKind,
  CLIENT_REGISTRY,
  RECOGNIZED_KINDS,
  AUTOMATED_KINDS,
  MAX_UA_LEN,
  type ClientKind,
} from '../src/lib/client-registry.js';
import { classifyTraffic } from '../src/lib/traffic-classifier.js';

/** [User-Agent, expected client name, expected kind, expected is_automated] */
const FIXTURES: ReadonlyArray<readonly [string, string, ClientKind, boolean]> = [
  // ── DIRECTION 1: real agent clients → recognized, NOT automated ──
  ['claude-code/1.2.3', 'claude-code', 'agent_client', false],
  ['Cursor/0.42.3 (darwin-arm64)', 'cursor', 'agent_client', false],
  ['cline/3.1.0', 'cline', 'agent_client', false],
  ['@modelcontextprotocol/sdk 1.12.0', 'mcp-sdk', 'agent_client', false],
  ['mcp-client/0.1', 'mcp-sdk', 'agent_client', false],
  ['langchain/0.2.1 (python)', 'langchain', 'agent_client', false],
  ['llama-index/0.11.0', 'llamaindex', 'agent_client', false],
  ['elizaos/0.1.0', 'elizaos', 'agent_client', false],
  ['agentkit/0.1.0', 'agentkit', 'agent_client', false],

  // ── DIRECTION 1b: BARE SDKs — the ICP shape. THIS IS THE FIX. ──
  ['python-httpx/0.27.0', 'python-httpx', 'bare_sdk', false],
  ['httpx/0.27.0', 'python-httpx', 'bare_sdk', false],
  ['python-requests/2.31.0', 'python-requests', 'bare_sdk', false],
  ['aiohttp/3.9.5', 'aiohttp', 'bare_sdk', false],
  ['axios/1.7.2', 'axios', 'bare_sdk', false],
  ['undici/6.19.2', 'undici', 'bare_sdk', false],
  ['node-fetch/2.6.7', 'node-fetch', 'bare_sdk', false],
  ['node', 'node', 'bare_sdk', false],
  ['node/22.4.0', 'node', 'bare_sdk', false],
  ['okhttp/4.12.0', 'okhttp', 'bare_sdk', false],
  ['Go-http-client/2.0', 'go-http-client', 'bare_sdk', false],
  ['reqwest/0.12.5', 'reqwest', 'bare_sdk', false],
  ['Java/17.0.2', 'java', 'bare_sdk', false],

  // ── DIRECTION 2: genuine crawlers → automated, still ──
  ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'googlebot', 'crawler', true],
  ['Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)', 'bingbot', 'crawler', true],
  ['Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)', 'ahrefsbot', 'crawler', true],
  ['Mozilla/5.0 (compatible; CensysInspect/1.1; +https://about.censys.io/)', 'censys', 'crawler', true],
  ['SomeRandomCrawler/1.0', 'crawler-generic', 'crawler', true],
  ['evil-spider/2.0', 'crawler-generic', 'crawler', true],

  // ── DIRECTION 2b: the named x402 discovery probers → automated, still ──
  ['mako-pulse-prober/1.0', 'mako-pulse-prober', 'crawler', true],
  ['preflight402-probe/0.3', 'preflight402-probe', 'crawler', true],
  ['402explorer/1.0', '402explorer', 'crawler', true],
  ['CoinbaseBazaarDiscovery/1.0', 'coinbase-bazaar-discovery', 'crawler', true],
  ['x402-observer/0.9', 'x402-observer', 'crawler', true],
  ['forum-labs-trust-prober/1.1', 'forum-labs-trust-prober', 'crawler', true],
  ['CarbonMonitor/2.0', 'carbonmonitor', 'crawler', true],

  // ── AMBIGUOUS — a named prober wearing an SDK UA. Crawler MUST win, or the
  //    bare-SDK allow-list would launder every prober that ships axios. ──
  ['CoinbaseBazaarDiscovery/1.0 (axios/1.7.2)', 'coinbase-bazaar-discovery', 'crawler', true],
  ['mako-pulse-prober/1.0 python-httpx/0.27.0', 'mako-pulse-prober', 'crawler', true],
  ['x402-observer/0.9 (node-fetch)', 'x402-observer', 'crawler', true],

  // ── AMBIGUOUS — a real agent that also says "bot". Agent MUST win
  //    ("never drop a real agent" — the ratified bias). ──
  ['claude-code/1.0 (bot mode)', 'claude-code', 'agent_client', false],

  // ── Health checks → automated ──
  ['Mozilla/5.0 (compatible; UptimeRobot/2.0; http://uptimerobot.com/)', 'health-check', 'health_check', true],
  ['ELB-HealthChecker/2.0', 'health-check', 'health_check', true],
  ['kube-probe/1.29', 'health-check', 'health_check', true],

  // ── Browsers → recognized, not automated ──
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', 'browser', 'browser', false],
];

describe('client-registry — UA fixture table (both directions)', () => {
  it('has fixtures for every kind, in both directions (vacuity guard)', () => {
    expect(FIXTURES.length).toBeGreaterThan(30);
    const kinds = new Set(FIXTURES.map(([, , k]) => k));
    for (const k of ['agent_client', 'bare_sdk', 'crawler', 'health_check', 'browser']) {
      expect(kinds).toContain(k);
    }
    // Both directions genuinely represented.
    expect(FIXTURES.some(([, , , a]) => a)).toBe(true);
    expect(FIXTURES.some(([, , , a]) => !a)).toBe(true);
  });

  it.each(FIXTURES)('%s → %s (%s)', (ua, expectedName, expectedKind) => {
    const got = classifyClient(ua);
    expect(got.name).toBe(expectedName);
    expect(got.kind).toBe(expectedKind);
  });

  it.each(FIXTURES)('%s → is_automated as classified', (ua, _name, _kind, expectedAutomated) => {
    expect(classifyTraffic({ ua }).is_automated).toBe(expectedAutomated);
  });

  it('THE FIX: every bare-SDK fixture is NOT automated (was: all flagged by isbot)', () => {
    const sdk = FIXTURES.filter(([, , k]) => k === 'bare_sdk');
    expect(sdk.length).toBeGreaterThan(5);
    for (const [ua] of sdk) expect(classifyTraffic({ ua }).is_automated).toBe(false);
  });

  it('isbot is NOT disabled — an unknown bot-ish UA still classifies automated', () => {
    // Not in the registry at all; must still reach isbot and be caught.
    expect(classifyTraffic({ ua: 'SemrushBot-BA' }).is_automated).toBe(true);
    expect(classifyTraffic({ ua: 'facebookexternalhit/1.1' }).is_automated).toBe(true);
  });

  it('the deliberate boundary: interactive tools stay OUT of bare_sdk', () => {
    for (const ua of ['curl/8.4.0', 'Wget/1.21', 'PostmanRuntime/7.39.0']) {
      expect(classifyClient(ua).kind).not.toBe('bare_sdk');
      expect(classifyTraffic({ ua }).is_automated).toBe(true);
    }
  });

  it('internal tier still wins over everything (subset canary preserved)', () => {
    expect(classifyTraffic({ ua: 'claude-code/1.0', isInternalTier: true })).toEqual({
      is_automated: true,
      reason: 'internal_tier',
    });
  });
});

describe('client-registry — identity + storage hygiene', () => {
  it('an absent UA is unknown; an unmatched UA is other — never guessed', () => {
    expect(classifyClient(null)).toEqual({ name: 'unknown', kind: 'unknown' });
    expect(classifyClient('')).toEqual({ name: 'unknown', kind: 'unknown' });
    expect(classifyClient('   ')).toEqual({ name: 'unknown', kind: 'unknown' });
    expect(classifyClient('Totally-Novel-Client/9')).toEqual({ name: 'other', kind: 'unknown' });
  });

  it('truncates a stored UA and never stores an empty string', () => {
    expect(normalizeUaForStorage(null)).toBeNull();
    expect(normalizeUaForStorage('  ')).toBeNull();
    expect(normalizeUaForStorage('axios/1.7.2')).toBe('axios/1.7.2');
    const long = 'x'.repeat(MAX_UA_LEN + 500);
    expect(normalizeUaForStorage(long)!.length).toBe(MAX_UA_LEN);
  });

  it('registry names are unique per spec and stable slugs', () => {
    for (const s of CLIENT_REGISTRY) {
      expect(s.name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });

  it('RECOGNIZED and AUTOMATED name sets are non-empty and disjoint', () => {
    const rec = clientNamesOfKind(...RECOGNIZED_KINDS);
    const aut = clientNamesOfKind(...AUTOMATED_KINDS);
    expect(rec.length).toBeGreaterThan(0);
    expect(aut.length).toBeGreaterThan(0);
    expect(rec.filter((n) => aut.includes(n))).toEqual([]);
  });

  it('ordering invariant: agent_client precedes crawler precedes bare_sdk', () => {
    const firstIdx = (k: ClientKind) => CLIENT_REGISTRY.findIndex((s) => s.kind === k);
    const lastIdx = (k: ClientKind) => CLIENT_REGISTRY.map((s) => s.kind).lastIndexOf(k);
    expect(lastIdx('agent_client')).toBeLessThan(firstIdx('crawler'));
    expect(lastIdx('crawler')).toBeLessThan(firstIdx('bare_sdk'));
    // browser is matched LAST — nearly every UA above may also carry "Mozilla/5.0".
    expect(lastIdx('bare_sdk')).toBeLessThan(firstIdx('browser'));
  });
});
