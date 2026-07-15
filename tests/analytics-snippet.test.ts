/**
 * OPS-ANALYTICS-TAG-SINGLE-SOURCE-W1 CH1 — freeze the analytics-snippet SoT.
 *
 * (a) byte-exact contract — the emitted block === the live first-party tag,
 *     seeded from Step-0 grep of origin/main (proxy-wave form);
 * (b) live-page anchor — the SoT must be a verbatim substring of a real committed
 *     landing page (holds before CH3 as the inline tag, and after CH3 as the
 *     injected region), so the SoT can never silently drift from what ships;
 * (c) no-legacy canary — no `data-domain`, no `plausible.io`, no
 *     `plausible.algovault.com` (dropped per architect Q2 + the first-party pivot).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  renderAnalyticsSnippet,
  ANALYTICS_SCRIPT_SRC,
  ANALYTICS_EVENT_ENDPOINT,
} from '../src/lib/analytics-snippet.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The exact live tag block (landing/index.html, proxy-wave first-party form).
const LIVE_TAG = [
  '<!-- Privacy-friendly analytics by Plausible -->',
  '<script async src="/js/insights.js"></script>',
  '<script>',
  '  window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};',
  '  plausible.init({endpoint:"/pa/event"})',
  '</script>',
].join('\n');

describe('analytics-snippet SoT — byte-exact contract', () => {
  it('renders the exact live first-party tag block', () => {
    expect(renderAnalyticsSnippet()).toBe(LIVE_TAG);
  });

  it('path constants match the proxy-wave values', () => {
    expect(ANALYTICS_SCRIPT_SRC).toBe('/js/insights.js');
    expect(ANALYTICS_EVENT_ENDPOINT).toBe('/pa/event');
  });

  it('is deterministic (single-derivation, no per-call variance)', () => {
    expect(renderAnalyticsSnippet()).toBe(renderAnalyticsSnippet());
  });

  it('projects the constants into the emitted block (single source)', () => {
    const out = renderAnalyticsSnippet();
    expect(out).toContain(`src="${ANALYTICS_SCRIPT_SRC}"`);
    expect(out).toContain(`endpoint:"${ANALYTICS_EVENT_ENDPOINT}"`);
  });
});

describe('analytics-snippet SoT — no legacy host / attribute (Q2 drop data-domain)', () => {
  it('carries no data-domain, no legacy plausible host', () => {
    const out = renderAnalyticsSnippet();
    expect(out).not.toContain('data-domain');
    expect(out).not.toContain('plausible.io');
    expect(out).not.toContain('plausible.algovault.com');
  });
});

describe('analytics-snippet SoT — live-page anchor (must match a real committed page)', () => {
  it('is a verbatim substring of landing/index.html (before CH3 = inline tag; after = injected region)', () => {
    const html = readFileSync(join(REPO_ROOT, 'landing', 'index.html'), 'utf8');
    expect(html.includes(renderAnalyticsSnippet())).toBe(true);
  });
});
