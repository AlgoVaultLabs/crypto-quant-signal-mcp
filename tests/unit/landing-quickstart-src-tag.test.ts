// LANDING-QUICKSTART-SRC-TAG-W1 — the landing quickstart URL carries `?src=landing`, and the
// repo-side surfaces stay BARE.
//
// WHY BOTH HALVES ARE ONE TEST. `?src` OUTRANKS Referer in classifySource, so the tag is only
// correct on a page we serve ourselves. A registry that renders README.md or server.json would
// inherit `?src=landing` and its traffic would be misattributed to our own landing page — the
// failure is silent (a plausible-looking number in the scoreboard), which is exactly why the
// positive presence and the negative absence are pinned together rather than drifting apart.
//
// SCOPE IS THE `#quickstart` SECTION, not the whole page. The `#developers` config block keeps
// the bare URL on purpose: it is a copy-paste config sample for a developer who is already here,
// not an acquisition door, and tagging it would attribute a second visit to the first.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ATTRIBUTION_SOURCES, classifySource } from '../../src/lib/attribution-sources.js';

const R = (...p: string[]) => join(process.cwd(), ...p);
const INDEX = readFileSync(R('landing', 'index.html'), 'utf8');

const TAGGED = 'https://api.algovault.com/mcp?src=landing';
/** A connect URL with NO query at all — the `(?![?&\w])` guard keeps a tagged URL out. */
const BARE_RE = /https:\/\/api\.algovault\.com\/mcp(?![?&\w])/g;

/** The two `#quickstart` sections (desktop artboard + its id-stripped mobile twin). */
function quickstartSections(html: string): string[] {
  const tags = [...html.matchAll(/<\/?section\b[^>]*>/g)].map((m) => ({ s: m.index!, e: m.index! + m[0].length, t: m[0] }));
  const stack: { s: number; t: string }[] = [];
  const out: string[] = [];
  for (const { s, e, t } of tags) {
    if (t.startsWith('</')) { const st = stack.pop(); if (st) out.push(html.slice(st.s, e)); }
    else stack.push({ s, t });
  }
  // The COPY affordance is what identifies the quickstart section on BOTH artboards: the mobile
  // twin carries no id (HTML id-uniqueness), so an id-based selector would find only one of two.
  return out.filter((sec) => sec.includes('data-av-copy-src'));
}

describe('LANDING-QUICKSTART-SRC-TAG-W1 — landing quickstart is tagged', () => {
  it('declares `landing` as a first-class attribution slug that classifySource resolves', () => {
    expect(ATTRIBUTION_SOURCES).toContain('landing');
    const c = classifySource({ srcParam: 'landing' });
    expect(c.source).toBe('landing');
    expect(c.confidence).toBe('deterministic');
    // Not the direct/unknown residual — see mediumForSource's non-exhaustive switch.
    expect(c.medium).toBe('referral');
  });

  it('tags every MCP URL inside #quickstart, on both artboards, and nothing else on the page', () => {
    const secs = quickstartSections(INDEX);
    expect(secs).toHaveLength(2); // desktop + mobile twin
    for (const sec of secs) {
      expect(sec.match(BARE_RE)).toBeNull();
      expect((sec.match(/https:\/\/api\.algovault\.com\/mcp\?src=landing/g) ?? []).length).toBe(2);
    }
    // EXPECT_TAG, measured at Step 0: 2 per artboard × 2 artboards.
    expect((INDEX.match(/https:\/\/api\.algovault\.com\/mcp\?src=landing/g) ?? []).length).toBe(4);
    // The two survivors are the #developers config sample, one per artboard.
    expect((INDEX.match(BARE_RE) ?? []).length).toBe(2);
    for (const m of INDEX.matchAll(BARE_RE)) {
      expect(INDEX.slice(Math.max(0, m.index! - 160), m.index!)).toContain('Remote — Streamable HTTP');
    }
  });

  it('leaves the COPY button copying the DISPLAYED node — attribute stays a bare marker', () => {
    // The handler reads `[data-av-copy-src]`.textContent, so the tag propagates with zero handler
    // change; a VALUE in this attribute would be a second derivation of the same URL.
    expect((INDEX.match(/data-av-copy-src=""/g) ?? []).length).toBe(2);
    expect(INDEX.match(/data-av-copy-src="[^"]+"/)).toBeNull();
    const displayed = [...INDEX.matchAll(/data-av-copy-src="[^"]*"[^>]*>([^<]*)/g)].map((m) => m[1].trim());
    expect(displayed).toEqual([TAGGED, TAGGED]);
  });
});

describe('LANDING-QUICKSTART-SRC-TAG-W1 — repo-side surfaces stay bare', () => {
  // A `?src` tag outranks Referer, so these must never carry one: registries and package pages
  // render this content verbatim and their arrivals would be laundered into our own channel.
  const BARE_SURFACES = ['README.md', 'server.json'];
  it.each(BARE_SURFACES)('%s carries no ?src= tag on any connect URL', (rel) => {
    expect(readFileSync(R(rel), 'utf8')).not.toMatch(/api\.algovault\.com\/mcp\?src=/);
  });

  it('the shared mcp-clients SoT is NOT tagged with `landing` (the substitution is landing-scoped)', () => {
    // landing/integrations/<slug>.html renders from this same SoT and keeps `?src=docs`.
    expect(readFileSync(R('src', 'lib', 'integrations-data', 'mcp-clients.ts'), 'utf8')).not.toContain('src=landing');
  });
});
