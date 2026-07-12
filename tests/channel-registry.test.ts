// CHANNEL-HUB-PAGES-GEO-W1 CH1 — channel SoT shape + single-derivation with the nav.
import { describe, it, expect } from 'vitest';
import {
  CHANNELS,
  hostedChannels,
  channelByKey,
  channelHref,
  channelToolCoverage,
  coveredRegistryChannels,
} from '../src/lib/channel-registry.js';
import { buildNavModel, type NavDropdown } from '../src/lib/nav-manifest.js';
import { FEATURE_REGISTRY, publicToolNames } from '../src/lib/feature-registry.js';

const channelsColumn = () =>
  (buildNavModel().groups.find((g): g is NavDropdown => g.kind === 'dropdown' && g.label === 'Platform') as NavDropdown)
    .columns!.find((c) => c.title === 'Channels')!;

describe('CH1 — the 4 channels: 3 hosted + 1 external, confirmed order', () => {
  it('CHANNELS is [mcp, rest-api, webhooks, telegram]', () => {
    expect(CHANNELS.map((c) => c.key)).toEqual(['mcp', 'rest-api', 'webhooks', 'telegram']);
  });
  it('mcp/rest-api/webhooks are hosted (have a slug); telegram is external (externalUrl, no slug)', () => {
    expect(hostedChannels().map((c) => c.key)).toEqual(['mcp', 'rest-api', 'webhooks']);
    for (const c of hostedChannels()) {
      expect(c.slug).toBe(c.key);
      expect(c.externalUrl).toBeUndefined();
    }
    const tg = channelByKey('telegram')!;
    expect(tg.hosted).toBe(false);
    expect(tg.slug).toBeUndefined();
    expect(tg.externalUrl).toBe('https://t.me/algovaultofficialbot');
  });
  it('channelHref: hosted → apex /<slug>; external → its URL', () => {
    expect(channelHref(channelByKey('mcp')!)).toBe('https://algovault.com/mcp');
    expect(channelHref(channelByKey('rest-api')!)).toBe('https://algovault.com/rest-api');
    expect(channelHref(channelByKey('webhooks')!)).toBe('https://algovault.com/webhooks');
    expect(channelHref(channelByKey('telegram')!)).toBe('https://t.me/algovaultofficialbot');
  });
});

describe('CH1 — nav Channels column derives from the SoT (single-derivation)', () => {
  it('nav Channels items === CHANNELS (label + destination), in order', () => {
    const items = channelsColumn().items;
    expect(items.map((i) => [i.label, i.href])).toEqual(CHANNELS.map((c) => [c.label, channelHref(c)]));
  });
  it('repointed off /docs.html anchors → the dedicated hub pages + external Telegram', () => {
    const hrefs = channelsColumn().items.map((i) => i.href);
    expect(hrefs).toEqual([
      'https://algovault.com/mcp',
      'https://algovault.com/rest-api',
      'https://algovault.com/webhooks',
      'https://t.me/algovaultofficialbot',
    ]);
    expect(hrefs.some((h) => h.includes('/docs.html#'))).toBe(false);
  });
  it('the Telegram nav item is flagged external (target/rel added by the renderer)', () => {
    const tg = channelsColumn().items.find((i) => i.label === 'Telegram Bot')!;
    expect(tg.external).toBe(true);
    for (const i of channelsColumn().items.filter((x) => x.label !== 'Telegram Bot')) {
      expect(i.external).toBeUndefined();
    }
  });
});

describe('CH1 — toolCoverage DERIVES from feature-registry channels{} (not hand-listed)', () => {
  it('each channel covers exactly the public tools whose reach-flag is on', () => {
    for (const c of CHANNELS) {
      const expected = FEATURE_REGISTRY.filter(
        (f) => f.enabled && publicToolNames().includes(f.name) && (f.channels as Record<string, boolean>)[c.registryChannel],
      ).map((f) => f.name);
      expect(channelToolCoverage(c)).toEqual(expected);
    }
  });
  it('reach-flag bridge: rest-api→httpX402, mcp→mcp, webhooks→webhook, telegram→bot', () => {
    expect(channelByKey('mcp')!.registryChannel).toBe('mcp');
    expect(channelByKey('rest-api')!.registryChannel).toBe('httpX402');
    expect(channelByKey('webhooks')!.registryChannel).toBe('webhook');
    expect(channelByKey('telegram')!.registryChannel).toBe('bot');
    // rest-api (httpX402) covers the priced signal tools; never the alias, never equities
    const rest = channelToolCoverage(channelByKey('rest-api')!);
    expect(rest).toContain('get_trade_call');
    expect(rest).not.toContain('get_trade_signal');
    expect(rest.some((n) => n.startsWith('get_equity_'))).toBe(false);
  });
  it('no equities-internal / outcome_* leakage in any channel coverage', () => {
    const all = CHANNELS.flatMap((c) => channelToolCoverage(c)).join(' ');
    for (const f of ['get_equity', 'outcome_return_pct', 'outcome_price']) expect(all).not.toContain(f);
  });
});

describe('CH1 — drift trap preserved (a2mcp/acp excluded; reached-unmapped throws)', () => {
  it('coveredRegistryChannels() = {mcp, httpX402, webhook, bot}; excludes rails a2mcp/acp', () => {
    expect([...coveredRegistryChannels()].sort()).toEqual(['bot', 'httpX402', 'mcp', 'webhook']);
    expect(coveredRegistryChannels().has('a2mcp')).toBe(false);
    expect(coveredRegistryChannels().has('acp')).toBe(false);
  });
  it('a NEW reached registry channel with no SoT entry + no exclusion makes buildNavModel THROW', () => {
    const synthetic = FEATURE_REGISTRY.map((f, i) =>
      i === 0 ? { ...f, channels: { ...f.channels, discord: true } as any } : f,
    );
    expect(() => buildNavModel(synthetic)).toThrow(/discord/);
  });
});

describe('CH1 — GEO copy discipline (Data-Integrity)', () => {
  it('every hosted summary is a standalone ≤60-word passage', () => {
    for (const c of hostedChannels()) {
      const words = c.summary.trim().split(/\s+/).length;
      expect(words).toBeGreaterThan(20);
      expect(words).toBeLessThanOrEqual(60);
    }
  });
  it('no baked track-record numbers in channel summaries (WR% / call counts)', () => {
    for (const c of CHANNELS) {
      expect(c.summary).not.toMatch(/\d+(\.\d+)?\s*%/); // no "91.7%"
      expect(c.summary).not.toMatch(/\b\d{3,}\b/); // no baked call counts like "349000"
    }
  });
});
