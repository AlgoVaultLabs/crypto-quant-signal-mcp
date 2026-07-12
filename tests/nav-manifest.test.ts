// NAV-PLATFORM-GENERATOR-W1 CH1 — nav model shape-freezing tests.
//
// The nav model is the single source every surface (desktop bar + mobile drawer, static +
// function-rendered) derives from. These tests freeze the model contract CH2–CH4 build on and
// pin the drift traps (unmapped channel / unlabelled tool throw; equities held; alias absent).
import { describe, it, expect } from 'vitest';
import {
  buildNavModel,
  navModelHrefs,
  slug,
  FEATURED_TOOLS,
  NAV_EXCLUDED_CHANNELS,
  type NavDropdown,
  type NavModel,
} from '../src/lib/nav-manifest.js';
import {
  FEATURE_REGISTRY,
  allToolNames,
  publicToolNames,
  type FeatureSpec,
} from '../src/lib/feature-registry.js';

const model = (): NavModel => buildNavModel();
const platform = (): NavDropdown =>
  model().groups.find((g): g is NavDropdown => g.kind === 'dropdown' && g.label === 'Platform')!;
const trackRecord = (): NavDropdown =>
  model().groups.find((g): g is NavDropdown => g.kind === 'dropdown' && g.label === 'Track Record')!;
const col = (title: string) => platform().columns!.find((c) => c.title === title)!;

// A synthetic enabled FeatureSpec (for the drift-trap tests) — minimal, all channels off by default.
const feat = (over: Partial<FeatureSpec> & { name: string }): FeatureSpec => ({
  name: over.name,
  aliases: over.aliases ?? [],
  channels: { mcp: false, httpX402: false, bot: false, webhook: false, a2mcp: false, acp: false, ...over.channels },
  quota: over.quota ?? { unit: 'per-call', holdFree: false },
  x402: over.x402 ?? null,
  descriptionRef: over.descriptionRef ?? 'X',
  enabled: over.enabled ?? true,
  ...(over.publicListing !== undefined ? { publicListing: over.publicListing } : {}),
});

describe('CH1 AC-a — public tool count = allToolNames() minus alias + equities-HOLD', () => {
  it('publicToolNames() = 6 canonical (equities excluded, no aliases)', () => {
    expect(publicToolNames()).toEqual([
      'get_trade_call',
      'get_market_regime',
      'scan_funding_arb',
      'scan_trade_calls',
      'chat_knowledge',
      'search_knowledge',
    ]);
  });
  it('equals every enabled, publicListing≠false canonical spec', () => {
    const expected = FEATURE_REGISTRY.filter((f) => f.enabled && f.publicListing !== false).map((f) => f.name);
    expect(publicToolNames()).toEqual(expected);
  });
  it('is allToolNames() minus aliases minus the two equities (HOLD)', () => {
    const canonicalNonEquity = allToolNames()
      .filter((n) => FEATURE_REGISTRY.some((f) => f.name === n)) // drop aliases (only canonical names)
      .filter((n) => !n.startsWith('get_equity_')); // drop the HELD equities
    expect(publicToolNames()).toEqual(canonicalNonEquity);
  });
});

describe('CH1 AC-b — the get_trade_signal alias never appears in the nav', () => {
  it('no href or label references the alias', () => {
    const s = JSON.stringify(model());
    expect(s).not.toContain('get_trade_signal');
    expect(navModelHrefs()).not.toContain('https://algovault.com/tools#get-trade-signal');
  });
});

describe('CH1 AC-c — no equities-internal / outcome_* leakage', () => {
  it('the serialized model contains no equity or outcome/phase-e fields', () => {
    const s = JSON.stringify(model()).toLowerCase();
    for (const forbidden of ['equity', 'get_equity', 'outcome_return_pct', 'outcome_price', 'phase e']) {
      expect(s).not.toContain(forbidden);
    }
  });
  it('the Tools column features exactly the first FEATURED_TOOLS public tools', () => {
    const items = col('Tools').items;
    expect(items).toHaveLength(FEATURED_TOOLS);
    expect(items.map((i) => i.href)).toEqual(
      publicToolNames()
        .slice(0, FEATURED_TOOLS)
        .map((n) => `https://algovault.com/tools#${slug(n)}`),
    );
    expect(col('Tools').more).toEqual({ label: 'See all tools', href: 'https://algovault.com/tools' });
  });
});

describe('CH1 AC-d — an unmapped, non-excluded channel key THROWS (drift trap)', () => {
  it('a reached registry channel with no CHANNEL_NAV mapping fails the build', () => {
    const synthetic = [feat({ name: 'get_trade_call', channels: { mcp: true, discord: true } as any })];
    expect(() => buildNavModel(synthetic)).toThrow(/discord/);
  });
  it('the excluded rails (a2mcp/acp) do NOT throw and never surface in Channels', () => {
    const labels = col('Channels').items.map((i) => i.label);
    expect(labels).toEqual(['MCP Server', 'REST API', 'Webhooks', 'Telegram Bot']);
    expect(NAV_EXCLUDED_CHANNELS).toEqual(['a2mcp', 'acp']);
    // a rail-only reach must not add a Channels item
    expect(() => buildNavModel([feat({ name: 'get_trade_call', channels: { a2mcp: true, acp: true } as any })])).not.toThrow();
  });
  it('a public tool with no TOOL_LABELS entry also throws (label coverage trap)', () => {
    expect(() => buildNavModel([feat({ name: 'brand_new_tool', channels: { mcp: true } })])).toThrow(/brand_new_tool/);
  });
});

describe('CH1 AC-e — model shape is stable (snapshot)', () => {
  it('buildNavModel() matches the frozen snapshot', () => {
    expect(model()).toMatchSnapshot();
  });
});

describe('CH1 — confirmed 7-item top bar + absolute hrefs (A6)', () => {
  it('groups = Platform▾, Track Record▾, How it works, Pricing, Docs, Account (+ Signup CTA = 7)', () => {
    expect(model().groups.map((g) => g.label)).toEqual([
      'Platform',
      'Track Record',
      'How it works',
      'Pricing',
      'Docs',
      'Account',
    ]);
    expect(model().cta).toEqual({ label: 'Signup', href: 'https://api.algovault.com/welcome' });
  });
  it('Platform is a 3-column mega-menu: Tools / Channels / Ecosystem', () => {
    expect(platform().columns!.map((c) => c.title)).toEqual(['Tools', 'Channels', 'Ecosystem']);
    expect(platform().items).toBeUndefined();
  });
  it('Track Record is a simple dropdown: Live Dashboard + Verify (Verify stays reachable — no data-loss)', () => {
    expect(trackRecord().items!.map((i) => [i.label, i.href])).toEqual([
      ['Live Dashboard', 'https://algovault.com/track-record'],
      ['Verify', 'https://algovault.com/verify'],
    ]);
    expect(trackRecord().columns).toBeUndefined();
  });
  it('every emitted href is absolute (apex or api) — none relative', () => {
    for (const h of navModelHrefs()) {
      expect(h).toMatch(/^https:\/\/(algovault\.com|api\.algovault\.com|t\.me)/);
    }
  });
  it('Account + Signup use the api host (apex /account + /welcome 404 on the apex allowlist)', () => {
    const hrefs = navModelHrefs();
    expect(hrefs).toContain('https://api.algovault.com/account');
    expect(hrefs).toContain('https://api.algovault.com/welcome');
  });
});
