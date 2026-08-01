// FIX-CONVICTION-CALL-POSTS-W1 — the weekly market-insight post, both branches.
//
// This exercises the REAL composer that production calls, run through the REAL moderation
// strip and the REAL publish gate. That combination is the point: the defect this wave
// fixes (two blank CTA labels) was in published copy that no test ever looked at, and it
// would have survived any test that checked the composer alone.
//
// The setup fixture is the same golden one the Python-parity test uses, so the per-setup
// blocks here are the same bytes Telegram subscribers receive.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { composeMarketInsightPost, type MarketInsightScan } from '../src/lib/market-insight-post.js';
import { checkForumPost, MIN_BODY_WORDS } from '../src/lib/forum-post-gate.js';
import { stripExternalUrlsForModeration } from '../src/lib/forum-post-content.js';
import type { RenderableScanCall } from '../src/lib/scan-digest.js';

const GOLDEN = JSON.parse(
  readFileSync(path.join(__dirname, 'fixtures', 'scan-showcase-golden.json'), 'utf8'),
) as { setups: RenderableScanCall[]; assetCount: number; venueCount: number };

const KEEP = { keepCanonicalDomain: 'algovault.com', keepHosts: ['t.me'] };
const CTA = [
  '🛰 Want this on your coins automatically? Set a standing scan: [t.me/algovaultofficialbot](https://t.me/algovaultofficialbot)',
  '📊 See the full verified track record: [algovault.com/track-record](https://algovault.com/track-record?src=devto)',
].join('\n');

/** Mirrors the wrapper `generateMarketInsight` puts around the composed body. */
function fullPost(title: string, body: string): string {
  return `${title}

Live from AlgoVault's engine:

${body}

⚠️ This is call interpretation, not financial advice. AlgoVault helps AI agents analyze — execution decisions are theirs.

${CTA}`;
}

function gateOf(title: string, body: string) {
  const raw = fullPost(title, body);
  return { raw, shipped: stripExternalUrlsForModeration(raw, KEEP), ...checkForumPost({
    title, rawContent: raw, strippedContent: stripExternalUrlsForModeration(raw, KEEP),
  }) };
}

const WITH_SETUPS: MarketInsightScan = {
  setups: GOLDEN.setups, assetCount: GOLDEN.assetCount, venueCount: GOLDEN.venueCount, probeVenue: 'HL',
};
const QUIET: MarketInsightScan = { setups: [], assetCount: 900, venueCount: 9, probeVenue: 'HL' };

describe('weekly market-insight post — digest branch', () => {
  it('PASSES the publish gate end to end', () => {
    const p = composeMarketInsightPost(WITH_SETUPS, 'Aug 2026', null);
    const g = gateOf(p.title, p.body);
    expect(g.failures).toEqual([]);
    expect(g.ok).toBe(true);
    expect(p.kind).toBe('digest');
  });

  it('shows REAL conviction percentages, and never claims "high conviction"', () => {
    const p = composeMarketInsightPost(WITH_SETUPS, 'Aug 2026', null);
    expect(p.body).toMatch(/58% conviction/);
    expect(p.body).toMatch(/51% conviction/);
    // The retired title asserted high conviction over whatever the engine returned —
    // including a 35%-confidence HOLD. That phrasing must never come back.
    expect(`${p.title}\n${p.body}`).not.toMatch(/high[- ]conviction/i);
  });

  it('carries only BUY/SELL setups — a HOLD is not a setup', () => {
    const p = composeMarketInsightPost(WITH_SETUPS, 'Aug 2026', null);
    expect(p.body).not.toMatch(/— HOLD/);
  });

  it('the title states LIVE counts, not literals', () => {
    const p = composeMarketInsightPost(WITH_SETUPS, 'Aug 2026', null);
    expect(p.title).toContain(`${GOLDEN.assetCount} assets`);
    expect(p.title).toContain(`${GOLDEN.venueCount} venues`);
  });

  it('emits the CTAs EXACTLY once — the renderer must not add its own', () => {
    // The shared renderer appends a Telegram "/scanwatch" CTA by default. The post passes
    // cta:null and supplies its own block; forgetting that would print CTAs twice.
    const p = composeMarketInsightPost(WITH_SETUPS, 'Aug 2026', null);
    const { shipped } = gateOf(p.title, p.body);
    expect(shipped.match(/t\.me\/algovaultofficialbot\)/g) ?? []).toHaveLength(1);
    expect(shipped).not.toContain('/scanwatch');
  });
});

describe('weekly market-insight post — quiet-week branch', () => {
  it('renders an honest quiet-week post that PASSES the gate (never a manufactured setup)', () => {
    const p = composeMarketInsightPost(QUIET, 'Aug 2026', 'RANGING');
    expect(p.kind).toBe('quiet');
    const g = gateOf(p.title, p.body);
    expect(g.failures).toEqual([]);
    expect(g.ok).toBe(true);
  });

  it('clears the word floor — the quiet branch is the shortest post we ever publish', () => {
    // If any post type is going to trip G1 it is this one, so pin the margin explicitly
    // rather than discovering it in production on a quiet Friday.
    const p = composeMarketInsightPost(QUIET, 'Aug 2026', 'RANGING');
    const { shipped } = gateOf(p.title, p.body);
    expect(shipped.split(/\s+/).filter(Boolean).length).toBeGreaterThan(MIN_BODY_WORDS);
  });

  it('states the real counts and does NOT invent setups', () => {
    const p = composeMarketInsightPost(QUIET, 'Aug 2026', 'RANGING');
    expect(p.body).toContain('scanned 900 assets across 9 venues');
    expect(p.body).toMatch(/no fresh directional setups/i);
    expect(p.body).not.toMatch(/🟢|🔴/);
  });

  it('scopes the regime claim to the NAMED venue, never to "the market"', () => {
    const p = composeMarketInsightPost(QUIET, 'Aug 2026', 'RANGING');
    expect(p.body).toContain('across the HL universe was RANGING');
  });

  it('says so plainly when regime could not be measured — no guessing', () => {
    const p = composeMarketInsightPost(QUIET, 'Aug 2026', null);
    expect(p.body).toContain('Regime data was not available');
    expect(p.body).not.toMatch(/RANGING|TRENDING/);
  });
});
