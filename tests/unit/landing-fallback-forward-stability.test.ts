/**
 * landing-fallback-forward-stability — OPS-FRESHNESS-SOURCE-TRUTH-W1 (2026-07-28)
 *
 * Extends the `tool-description-forward-stability` family from MANIFEST DESCRIPTIONS to
 * LANDING-PAGE FALLBACKS.
 *
 * ## The defect this makes un-shippable
 *
 * `landing/*.html` is served statically by Caddy. Every `data-tr-field` span holds a BAKED
 * literal that a browser replaces with a live value — but a no-JS reader and every LLM
 * crawler read the bake, not the hydrated value. So a baked literal is public copy.
 *
 * `scripts/snapshot-landing-data.mjs` re-bakes the literals it OWNS (one manifest row per
 * claim). A span with NO manifest row is frozen at whatever was committed, forever:
 *
 *   /verify shipped  latest_batch_at = "2026-05-25 00:05 UTC"  (committed 2026-05-25)
 *                    next_batch_in   = "3h 41m"                (a FROZEN countdown)
 *
 * The first was 3 days stale in production on 2026-07-28 and fired
 * VERIFY_LATEST_BATCH_FRESH; the second can NEVER be correct, because a relative countdown
 * baked at build time is wrong one minute later. Both on the page whose entire argument is
 * "we cannot edit history — verify us".
 *
 * ## The rule
 *
 * A `data-tr-field` span may carry a VOLATILE-shaped literal only if the snapshot manifest
 * owns that key. Otherwise the literal must be inert (`&mdash;`) or qualitative.
 *
 * Client-side hydration does NOT license a volatile bake. verify.html DOES hydrate
 * next_batch_in from its own inline script — and that is exactly why the frozen "3h 41m"
 * survived review for two waves. Crawlers never ran it.
 *
 * A bare integer is NOT volatile: `erc8004_agent_id = 44544` is a stable identity, and
 * freezing it is correct. Only shapes that change on a clock are flagged.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LANDING = join(REPO_ROOT, 'landing');

/**
 * Literal shapes that change on a clock, so a frozen copy is guaranteed wrong eventually.
 * Deliberately NOT `\d{2,}` — a bare integer is usually a stable id or a fixed-cardinality
 * count, and flagging it would make this guard noise (its first draft false-flagged
 * erc8004_agent_id).
 */
const VOLATILE_LITERAL_SHAPES: Array<[string, RegExp]> = [
  ['absolute date (YYYY-MM-DD)', /\d{4}-\d{2}-\d{2}/],
  ['clock time (HH:MM)', /\b\d{1,2}:\d{2}\b/],
  ['ordinal / batch reference (#n)', /#\d+/],
  ['relative duration (Nh Nm)', /\b\d+\s*h\s*\d+\s*m\b/],
  ['grouped thousands (a growing counter)', /\b\d{1,3}(?:,\d{3})+\b/],
  ['precise percentage', /\b\d+\.\d+\s*%/],
];

function isVolatile(text: string): string | null {
  for (const [label, re] of VOLATILE_LITERAL_SHAPES) if (re.test(text)) return label;
  return null;
}

/** data-tr-field keys the snapshot injector re-bakes (derived from the manifest, never listed). */
function manifestOwnedKeys(): Set<string> {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, 'scripts', 'snapshot-landing-manifest.json'), 'utf-8'),
  ) as { claims: { id: string; find_pattern: string }[] };
  const owned = new Set<string>();
  for (const claim of manifest.claims) {
    // find_pattern is a regex source string; the key appears as data-tr-field="<key>"
    for (const m of claim.find_pattern.matchAll(/data-tr-field=\\?"([a-z0-9_]+)\\?"/g)) {
      owned.add(m[1]);
    }
  }
  return owned;
}

function landingPages(): { name: string; html: string }[] {
  return readdirSync(LANDING)
    .filter((f) => f.endsWith('.html'))
    .map((name) => ({ name, html: readFileSync(join(LANDING, name), 'utf-8') }));
}

describe('landing fallback forward-stability', () => {
  it('the volatile-shape detector works in BOTH directions', () => {
    // Positive: every shape the wave actually shipped or could ship.
    expect(isVolatile('2026-05-25 00:05 UTC')).toBe('absolute date (YYYY-MM-DD)');
    expect(isVolatile('#45')).toBe('ordinal / batch reference (#n)');
    expect(isVolatile('3h 41m')).toBe('relative duration (Nh Nm)');
    expect(isVolatile('417,673')).toBe('grouped thousands (a growing counter)');
    expect(isVolatile('91.8%')).toBe('precise percentage');
    expect(isVolatile('00:05 UTC')).toBe('clock time (HH:MM)');

    // Negative: the inert/qualitative/stable forms must NOT be flagged, or the guard would
    // reject its own fix and force the volatile literal back in.
    expect(isVolatile('&mdash;')).toBeNull();
    expect(isVolatile('—')).toBeNull();
    expect(isVolatile('daily · 00:05 UTC')).toBe('clock time (HH:MM)'); // still a clock -> needs a row
    expect(isVolatile('44544')).toBeNull(); // stable identity (erc8004_agent_id)
    expect(isVolatile('12')).toBeNull(); // fixed-cardinality count
    expect(isVolatile('')).toBeNull();
  });

  it('the manifest-owned key set is derived, non-empty, and includes the batch family', () => {
    const owned = manifestOwnedKeys();
    expect(owned.size).toBeGreaterThan(5);
    for (const k of ['latest_batch', 'latest_batch_n', 'latest_batch_at', 'merkle_batch_count']) {
      expect(owned, `${k} must be manifest-owned or its literal freezes`).toContain(k);
    }
    // next_batch_in is deliberately NOT owned: a relative countdown cannot be correctly
    // baked at ANY cadence, so it must stay inert rather than gain a manifest row.
    expect(owned).not.toContain('next_batch_in');
  });

  it('no data-tr-field span carries a volatile literal without a manifest row', () => {
    const owned = manifestOwnedKeys();
    const offenders: string[] = [];
    for (const { name, html } of landingPages()) {
      for (const m of html.matchAll(/data-tr-field="([a-z0-9_]+)"[^>]*>([^<]*)</g)) {
        const [, key, raw] = m;
        const value = raw.trim();
        const shape = isVolatile(value);
        if (shape && !owned.has(key)) {
          offenders.push(`landing/${name} → data-tr-field="${key}" = ${JSON.stringify(value)} (${shape})`);
        }
      }
    }
    expect(
      offenders,
      `A landing-page data-tr-field span holds a literal that changes on a clock but has NO ` +
        `scripts/snapshot-landing-manifest.json row, so nothing re-bakes it — it is frozen for ` +
        `every no-JS reader and every LLM crawler. Either add a manifest row (if a live value ` +
        `exists) or make the fallback inert (&mdash;) / qualitative. Client-side hydration does ` +
        `NOT count: crawlers never run it.\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('/verify commits inert fallbacks for the whole latest_batch family', () => {
    const html = readFileSync(join(LANDING, 'verify.html'), 'utf-8');
    for (const key of ['latest_batch', 'latest_batch_n', 'latest_batch_at', 'next_batch_in']) {
      const spans = [...html.matchAll(new RegExp(`data-tr-field="${key}"[^>]*>([^<]*)<`, 'g'))];
      expect(spans.length, `${key} span count (dual-render desktop + mobile)`).toBe(2);
      for (const [, value] of spans) {
        expect(
          isVolatile(value.trim()),
          `committed ${key} fallback ${JSON.stringify(value)} must be inert — a plausible-looking ` +
            `wrong number invites a hand-"fix" and is what ships if the injector never runs`,
        ).toBeNull();
      }
    }
  });
});
