/**
 * tests/unit/chatgpt-client-profile.test.ts — GROWTH-AGENT-SIGNIN-OAUTH-W4-R2 CH1.
 *
 * ChatGPT's platform profile (`client-registry.ts`, the `openai` entry) decides two things, and this
 * file holds both canaries plus the byte-identity guarantee for every other client:
 *
 *   PLAIN_METADATA_CANARY       — the tools/list ChatGPT is served, from the REAL server factory under a
 *                                 ChatGPT User-Agent, judged against OpenAI's plugin metadata rules.
 *   COMMERCE_RESTRICTED_CANARY  — every commerce surface a ChatGPT call can reach, rendered through its
 *                                 real path, carries no plan, upgrade, price, link, x402 or referral.
 *
 * The rule regexes below are written HERE, independently of `tool-descriptions.ts`'s override table:
 * a canary that imported the generator's own list could only ever agree with it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CLIENT_REGISTRY, DEFAULT_CLIENT_PROFILE, clientProfile, classifyClient } from '../../src/lib/client-registry.js';
import {
  requestContext, trackCall, checkQuota, getUpgradeHint, requestClientProfile,
  _resetCallTrackersForTest, resetLicenseCache,
} from '../../src/lib/license.js';
import { FREE_DAILY_CALLS } from '../../src/lib/plans.js';
import { TierLimitReachedError, buildTierLimitPayload } from '../../src/lib/errors.js';
import { buildQuotaNoticeMessage, buildQuotaSuggestedAction } from '../../src/lib/quota-notice.js';
import { buildChatQuotaNotice } from '../../src/lib/chat-rate-limit.js';
import { withTierWarning, withAuthState } from '../../src/lib/tier-warning.js';
import { runScanTradeCall } from '../../src/tools/scan-trade-calls.js';
import { getTradeSignal } from '../../src/tools/get-trade-call.js';
import { PLAIN_OMITTED_PARAMS } from '../../src/tool-descriptions.js';
import type { AlgoVaultMeta, LicenseInfo } from '../../src/types.js';

const ROOT = join(__dirname, '..', '..');
/** ChatGPT's MCP client UA, as measured on live traffic (GROWTH-AGENT-SIGNIN-OAUTH-W3 evidence). */
const CHATGPT_UA = 'openai-mcp/1.0.0';
/** Every other kind of caller — none declares a profile, so each must be served today's bytes. */
const OTHER_UAS = [
  'claude-ai/0.1.0', 'Claude-User/1.0', 'claude-code/2.0.1', 'Cursor/1.4.2', 'python-httpx/0.27.0',
  'node', 'langchain-mcp-adapters/0.1.0', '@modelcontextprotocol/sdk', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)',
];

function ctx(ua: string | null, license: LicenseInfo = { tier: 'free', key: null }) {
  return { license, sessionId: 'cgp-session', ipHash: 'cgp-iphash', isAutomated: false, userAgent: ua } as never;
}
function asCaller<T>(ua: string | null, fn: () => T, license?: LicenseInfo): T {
  return requestContext.run(ctx(ua, license), fn);
}

interface ListedTool { name: string; description: string; inputSchema: { properties?: Record<string, { description?: string }> } }

/** tools/list from the REAL server factory, built inside the caller's request context as /mcp builds it. */
async function listToolsAs(ua: string | null): Promise<ListedTool[]> {
  const { createSandboxServer } = await import('../../src/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const server = ua === null ? createSandboxServer() : asCaller(ua, () => createSandboxServer());
  const client = new Client({ name: 'chatgpt-client-profile', version: '0.0.0' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverT);
    await client.connect(clientT);
    return (await client.listTools()).tools as unknown as ListedTool[];
  } finally {
    await client.close();
    await server.close();
  }
}

/** Remove every `description` key, leaving the validators — what a projection must not change. */
function stripDescriptions(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripDescriptions);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'description').map(([k, x]) => [k, stripDescriptions(x)]));
  }
  return v;
}

// ── The rules, stated independently of the generator ─────────────────────────────────────────────
const OTHER_AI_PRODUCTS = /\b(claude|anthropic|chatgpt|openai|gpt-?\d\w*|gemini|bard|copilot|perplexity|deepseek|mistral|llama|langchain|llama-?index|crewai|autogen|maf|cursor|windsurf|grok|cohere)\b/i;
// Not `price`: an asset's price is data a tool returns (scan_trade_calls includeReasoning), not pricing.
const METADATA_COMMERCE = /\b(pricing|priced|cost|costs|free|paid|pay|payment|plan|plans|tier|tiers|trial|trials|subscription|subscriptions|subscribe|upgrade|upgrades|quota|quotas|billing|billed|bill|discount|discounts|promo|promotion|starter|pro|enterprise|premium|x402)\b|\$\s?\d/i;
/** Discovery phrases that describe the PRODUCT, never a parameter. */
const PARAM_PADDING = [
  'crypto signal', 'ai trading signal', 'crypto quant', 'mcp tool for trading', 'trading agent', 'btc eth sol signal',
  'multi-exchange', 'cross-venue', 'trend ranging', 'buy sell hold', 'composite verdict', 'verified track record',
  'merkle anchor', 'on-chain verified',
];
const COMMERCE_KEYS = new Set([
  'suggested_upgrade_url', 'upgrade_url', 'recommended_path', 'referral_hint', 'suggested_x402', 'upgrade_hint', 'claim_url', 'claim_hint',
]);
const OUTPUT_COMMERCE = /https?:\/\/|\$\s?\d|\b(subscribe|subscription|upgrade|starter|enterprise|x402|referr\w*|refer a friend|card required|sign ?up|pay per call|claim)\b/i;

/** Every key and string in a rendered output, judged against the restricted-commerce rule. */
function commerceFindings(v: unknown, path = '$'): string[] {
  const out: string[] = [];
  if (typeof v === 'string') {
    if (OUTPUT_COMMERCE.test(v)) out.push(`${path}: "${v}"`);
    // "not available on the current plan" is the ONE plan sentence OpenAI allows.
    for (const m of v.matchAll(/(\w+\s+)?\bplans?\b/gi)) if (!/^current\s+$/i.test(m[1] ?? '')) out.push(`${path}: plan word "${m[0]}"`);
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => out.push(...commerceFindings(x, `${path}[${i}]`)));
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (COMMERCE_KEYS.has(k)) out.push(`${path}.${k}: commerce field present`);
      out.push(...commerceFindings(x, `${path}.${k}`));
    }
  }
  return out;
}

/** Bazaar (Base/USDC) live — the rail fixture tests/x402-nudge.test.ts uses, so x402 would render if allowed. */
const BAZAAR_ENV: Record<string, string | undefined> = {
  X402_NUDGE_ENABLED: '1', X402_FACILITATOR: 'cdp', CDP_API_KEY_ID: 'test-id', CDP_API_KEY_SECRET: 'test-secret',
  BAZAAR_DISCOVERABLE: 'true', X402_NETWORK: 'base-mainnet',
};

let seq = 0;
/** A caller at the daily wall, walled INSIDE `ua`'s context so a keyless caller meters on that context's ip bucket. */
function walled(ua: string | null, keyed: boolean, key = `av_cgp_${++seq}`): LicenseInfo {
  const lic: LicenseInfo = { tier: 'free', key: keyed ? key : null };
  asCaller(ua, () => {
    for (let i = 0; i < FREE_DAILY_CALLS; i++) trackCall(lic);
    expect(checkQuota(lic).allowed, 'fixture must actually be walled').toBe(false);
  }, lic);
  return lic;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('the profile lives on the registry entry, and only there', () => {
  it('ChatGPT resolves to the openai family and carries plain metadata + restricted commerce', () => {
    expect(classifyClient(CHATGPT_UA).name).toBe('openai');
    expect(clientProfile('openai')).toEqual({ metadata: 'plain', commerce: 'restricted' });
    expect(asCaller(CHATGPT_UA, () => requestClientProfile())).toEqual({ metadata: 'plain', commerce: 'restricted' });
  });

  it('every other registry family, unknown, and the no-request path get the default profile', () => {
    for (const s of CLIENT_REGISTRY) if (s.name !== 'openai') expect(clientProfile(s.name), s.name).toBe(DEFAULT_CLIENT_PROFILE);
    expect(clientProfile('unknown')).toBe(DEFAULT_CLIENT_PROFILE);
    expect(clientProfile('other')).toBe(DEFAULT_CLIENT_PROFILE);
    expect(requestClientProfile()).toBe(DEFAULT_CLIENT_PROFILE);
    for (const ua of OTHER_UAS) expect(asCaller(ua, () => requestClientProfile()), ua).toBe(DEFAULT_CLIENT_PROFILE);
  });

  it('no second family test exists anywhere in src — renderers read the profile, never the name', () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(join(ROOT, 'src'));
    expect(files.length, 'the scan must have a corpus').toBeGreaterThan(100);
    const familyTest = /(===|!==|==|!=)\s*['"]openai['"]|['"]openai['"]\s*(===|!==|==|!=)|case\s+['"]openai['"]/;
    const hits = files.filter((f) => familyTest.test(readFileSync(f, 'utf8'))).map((f) => f.slice(ROOT.length + 1));
    expect(hits).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('PLAIN_METADATA_CANARY — the tools/list ChatGPT is served', () => {
  let plain: ListedTool[];
  let dflt: ListedTool[];
  beforeEach(async () => {
    plain ??= await listToolsAs(CHATGPT_UA);
    dflt ??= await listToolsAs(null);
  });

  it('serves all 10 live tools, the same set as every other client', () => {
    expect(plain.map((t) => t.name).sort()).toEqual(dflt.map((t) => t.name).sort());
    expect(plain.length).toBe(10); // DECISION-CALL-V1-W2: + pre_trade_check
  });

  it('names no other AI product — in descriptions, parameter descriptions, parameter names or allowed values', () => {
    for (const t of plain) expect(JSON.stringify({ d: t.description, s: t.inputSchema }), t.name).not.toMatch(OTHER_AI_PRODUCTS);
  });

  it('carries no pricing, plan, tier, trial, quota or billing word', () => {
    for (const t of plain) {
      expect(t.description, t.name).not.toMatch(METADATA_COMMERCE);
      for (const [p, s] of Object.entries(t.inputSchema.properties ?? {})) expect(s.description ?? '', `${t.name}.${p}`).not.toMatch(METADATA_COMMERCE);
    }
  });

  it('each parameter description states only that parameter — no product discovery phrase', () => {
    for (const t of plain) {
      for (const [p, s] of Object.entries(t.inputSchema.properties ?? {})) {
        const d = (s.description ?? '').toLowerCase();
        for (const phrase of PARAM_PADDING) expect(d, `${t.name}.${p} carries "${phrase}"`).not.toContain(phrase);
      }
    }
  });

  it('keeps what the tool returns, read-only, and every sibling route the default names', () => {
    const names = dflt.map((t) => t.name);
    for (const t of plain) {
      const d = dflt.find((x) => x.name === t.name)!;
      expect(t.description, t.name).toMatch(/^(Returns|Screens)\b/);
      expect(t.description, t.name).toMatch(/read-only/i);
      for (const sib of names) {
        if (sib !== t.name && new RegExp(`\\b${sib}\\b`).test(d.description)) expect(t.description, `${t.name} lost its route to ${sib}`).toMatch(new RegExp(`\\b${sib}\\b`));
      }
    }
  });

  it('changes text only — every validator is the default one, minus the declared omissions', () => {
    for (const t of plain) {
      const d = dflt.find((x) => x.name === t.name)!;
      const expected = stripDescriptions(d.inputSchema) as { properties?: Record<string, unknown>; required?: string[] };
      for (const p of PLAIN_OMITTED_PARAMS[t.name] ?? []) {
        expect(expected.properties?.[p], `${t.name}.${p} must exist to be omitted`).toBeDefined();
        delete expected.properties![p];
        if (expected.required) expected.required = expected.required.filter((r) => r !== p);
      }
      expect(stripDescriptions(t.inputSchema), t.name).toEqual(expected);
    }
  });

  it('is a real projection — ChatGPT is not served the default text', () => {
    expect(JSON.stringify(plain)).not.toBe(JSON.stringify(dflt));
  });
});

describe('DEFAULT_BYTE_IDENTICAL — every other client is served today\'s tools/list', () => {
  it('no UA and every other UA family produce one byte-identical list', async () => {
    const base = JSON.stringify(await listToolsAs(null));
    for (const ua of OTHER_UAS) expect(JSON.stringify(await listToolsAs(ua)), ua).toBe(base);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('COMMERCE_RESTRICTED_CANARY — every commerce surface on a ChatGPT call', () => {
  beforeEach(() => { _resetCallTrackersForTest(); resetLicenseCache(); });

  async function mcpWall(ua: string | null, lic: LicenseInfo): Promise<Record<string, unknown>> {
    const { createSandboxServer } = await import('../../src/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const server = asCaller(ua, () => createSandboxServer(), lic);
    const client = new Client({ name: 'chatgpt-wall', version: '0.0.0' });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    await client.connect(c);
    try {
      const r = await requestContext.run(ctx(ua, lic), () =>
        client.callTool({ name: 'get_trade_call', arguments: { coin: 'BTC', timeframe: '1h', exchange: 'BINANCE' } })) as { isError?: boolean; content: { text: string }[] };
      expect(r.isError, 'the walled call must refuse').toBe(true);
      return JSON.parse(r.content[0].text) as Record<string, unknown>;
    } finally {
      await client.close();
      await server.close();
    }
  }

  for (const keyed of [false, true]) {
    it(`the thrown wall through the real MCP pipeline (${keyed ? 'keyed' : 'keyless'}) states usage and return, and sells nothing`, async () => {
      const payload = await mcpWall(CHATGPT_UA, walled(CHATGPT_UA, keyed));
      expect(commerceFindings(payload)).toEqual([]);
      expect(payload.code).toBe('TIER_LIMIT_REACHED');
      expect(payload.usage_display).toBe(`${FREE_DAILY_CALLS}/${FREE_DAILY_CALLS}`);
      expect(payload.limit).toBe('daily');
      expect(typeof payload.resets_at).toBe('string');
      expect(payload.message).toMatch(/Access returns at 00:00 UTC/);
      expect(payload.message).toMatch(/not available on the current plan/);
      expect(payload.suggested_action).toBe('Wait until 00:00 UTC for the daily allowance to reset.');
    });
  }

  it('the same wall for any other client is the open wall, unchanged', async () => {
    const payload = await mcpWall(null, walled(null, true));
    for (const k of ['suggested_upgrade_url', 'recommended_path', 'referral_hint']) expect(payload, k).toHaveProperty(k);
    expect(payload.message).not.toMatch(/not available on the current plan/);
  });

  it('the screener wall (scan_trade_calls, scan_market_regimes share it) sells nothing', async () => {
    const lic = walled(CHATGPT_UA, false);
    const body = await asCaller(CHATGPT_UA, () => runScanTradeCall({}, lic), lic) as unknown as Record<string, unknown>;
    expect(commerceFindings(body)).toEqual([]);
    expect(body.code).toBe('TIER_LIMIT_REACHED');
    expect(body.usage_display).toBe(`${FREE_DAILY_CALLS}/${FREE_DAILY_CALLS}`);
  });

  it('the chat wall sells nothing, and the pipeline passes it the request profile', () => {
    const n = buildChatQuotaNotice('free', { limit: 10, used: 10, resetAt: new Date(Date.UTC(2026, 11, 1)) }, 'restricted');
    expect(commerceFindings(n)).toEqual([]);
    expect(n.message).toMatch(/More chat answers are not available on the current plan until then\./);
    const pipeline = readFileSync(join(ROOT, 'src', 'lib', 'tool-call-pipeline.ts'), 'utf8');
    expect(pipeline).toContain('buildChatQuotaNotice(tier, check, requestClientProfile().commerce)');
  });

  it('the tier warning keeps its usage facts and drops the upgrade URL and the x402 rail', () => {
    const meta = { tool: 'get_trade_call' } as unknown as AlgoVaultMeta;
    const w = { tier: 'free' as const, currentUsage: 190, monthlyLimit: 200, tool: 'get_trade_call', env: BAZAAR_ENV };
    const restricted = asCaller(CHATGPT_UA, () => withTierWarning(meta, w));
    expect(restricted.tier_warning?.level).toBe('hard');
    expect(commerceFindings(restricted)).toEqual([]);
    const open = asCaller(null, () => withTierWarning(meta, w));
    expect(open.tier_warning?.suggested_upgrade_url).toBeTruthy();
  });

  it('the auth block does not offer the claim (signup) link', () => {
    const absent = { tier: 'free' as const, key: null, outcome: 'ABSENT' as const };
    expect(commerceFindings(asCaller(CHATGPT_UA, () => withAuthState({}, absent)))).toEqual([]);
    expect(asCaller(null, () => withAuthState({}, absent))).toHaveProperty('claim_url');
  });

  it('no upgrade hint — neither the capped-results nor the soft-nudge branch', () => {
    const lic: LicenseInfo = { tier: 'free', key: 'av_cgp_hint' };
    for (const c of [{ cappedResults: 5, totalResults: 40 }, { used: 190, total: 200 }]) {
      expect(asCaller(CHATGPT_UA, () => getUpgradeHint(lic, c)), JSON.stringify(c)).toBeUndefined();
      expect(asCaller(null, () => getUpgradeHint(lic, c)), JSON.stringify(c)).toBeTruthy();
    }
  });

  it('the aha referral and aha upgrade nudges are gated on an open profile at both sites', () => {
    const pipeline = readFileSync(join(ROOT, 'src', 'lib', 'tool-call-pipeline.ts'), 'utf8');
    expect(pipeline).toContain("const open = requestClientProfile().commerce === 'open';");
    expect(pipeline).toContain('if (open && aha && refCode && sid && shouldShowAhaReferral(sid)) {');
    expect(pipeline).toContain('} else if (open && isAha) {');
    const scan = readFileSync(join(ROOT, 'src', 'tools', 'scan-trade-calls.ts'), 'utf8');
    expect(scan).toMatch(/requestClientProfile\(\)\.commerce === 'open'\s*\n\s*&& refCode && sid && result\.eligible_non_hold >= SCAN_REFERRAL_MIN_HITS/);
  });

  it('the notice renderer itself: restricted text for both walls and both meters', () => {
    const resetAtMs = Date.UTC(2026, 10, 12);
    for (const wall of ['daily', 'monthly'] as const) {
      const c = { meter: 'calls' as const, used: 20, limit: 20, wall, resetAtMs, nowMs: Date.UTC(2026, 9, 30, 12), referralCode: 'abc123', commerce: 'restricted' as const };
      expect(commerceFindings({ m: buildQuotaNoticeMessage(c), a: buildQuotaSuggestedAction(c) }), wall).toEqual([]);
    }
  });
});

describe('DEFAULT_BYTE_IDENTICAL — outputs for every other client', () => {
  beforeEach(() => { _resetCallTrackersForTest(); resetLicenseCache(); });

  it('an explicit open profile renders the exact pre-wave payload, key order included', async () => {
    const lic = walled(null, true);
    let err: TierLimitReachedError | undefined;
    try { await getTradeSignal({ coin: 'BTC', timeframe: '1h', license: lic }); } catch (e) { err = e as TierLimitReachedError; }
    expect(err).toBeInstanceOf(TierLimitReachedError);
    expect(JSON.stringify(buildTierLimitPayload(err!, { commerce: 'open' }))).toBe(JSON.stringify(buildTierLimitPayload(err!)));
  });

  it('every other UA gets the same screener wall bytes as no UA', async () => {
    const shape = async (ua: string | null) => {
      _resetCallTrackersForTest();
      const lic = walled(ua, true, 'av_cgp_same_key');
      // The rolling period is anchored on the first call's millisecond — the only legitimately varying byte.
      return JSON.stringify(await asCaller(ua, () => runScanTradeCall({}, lic), lic)).replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'T');
    };
    const base = await shape(null);
    for (const ua of OTHER_UAS) expect(await shape(ua), ua).toBe(base);
  });
});
