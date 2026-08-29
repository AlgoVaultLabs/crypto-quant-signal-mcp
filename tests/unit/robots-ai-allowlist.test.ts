/**
 * Two-way self-test for the live-edge robots.txt allowlist gate.
 *
 * Hermetic — no network. The gate's fetch is the ONE thing this file cannot exercise, so
 * per the "a hermetic self-test is structurally blind to exactly what its own seam
 * replaces" law it also asserts the artifacts the seam bypasses: the URL builder's
 * cache-buster, the allowlist SoT path, and the source reader whose output the live run
 * depends on entirely.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { AI_CRAWLER_ALLOWLIST } from '../../src/lib/ai-crawler-allowlist.js';
import {
  ALLOWLIST_SOURCE,
  CF_MANAGED_MARKER,
  VERDICT_EXIT,
  buildFetchUrl,
  evaluate,
  parseRobots,
  readAllowlistFromSource,
  resolveForAgent,
} from '../../scripts/check-robots-ai-allowlist.mjs';

const REPO_ROOT = join(__dirname, '..', '..');
const LIVE_ROBOTS = readFileSync(join(REPO_ROOT, 'landing', 'robots.txt'), 'utf8');
const ALLOWLIST = [...AI_CRAWLER_ALLOWLIST];

/**
 * Cloudflare's managed-robots.txt prepend, reproduced verbatim in shape from
 * developers.cloudflare.com/bots/additional-configurations/managed-robots-txt/.
 * Casing quirks are deliberate: `User-Agent` with a capital A on the first record and
 * `meta-externalagent` lowercase where our own file carries `Meta-ExternalAgent`.
 */
const CF_PREPEND = `# BEGIN Cloudflare Managed content

User-Agent: *
Content-signal: search=yes, ai-train=no, use=reference
Allow: /

User-agent: Amazonbot
Disallow: /

User-agent: Applebot-Extended
Disallow: /

User-agent: Bytespider
Disallow: /

User-agent: CCBot
Disallow: /

User-agent: ClaudeBot
Disallow: /

User-agent: Google-Extended
Disallow: /

User-agent: GPTBot
Disallow: /

User-agent: meta-externalagent
Disallow: /

# END Cloudflare Managed Content

`;

/** The eight the prepend disallows — the exact regression surface. */
const CF_BLOCKED = [
  'Amazonbot',
  'Applebot-Extended',
  'Bytespider',
  'CCBot',
  'ClaudeBot',
  'Google-Extended',
  'GPTBot',
  'Meta-ExternalAgent',
];

describe('robots.txt AI-crawler allowlist gate', () => {
  describe('fixture 1 — the current committed landing/robots.txt', () => {
    it('resolves GREEN with every allowlisted agent allowed on /', () => {
      const r = evaluate(LIVE_ROBOTS, ALLOWLIST);
      expect(r.reasons).toEqual([]);
      expect(r.verdict).toBe('GREEN');
      expect(r.disallowed).toEqual([]);
      expect(r.lines).toHaveLength(ALLOWLIST.length);
      expect(r.lines.every((l) => l.includes(': allowed'))).toBe(true);
    });

    it('transitively proves every allowlist entry has its OWN group in the file (R2 coupling)', () => {
      const groups = parseRobots(LIVE_ROBOTS);
      for (const agent of ALLOWLIST) {
        const r = resolveForAgent(groups, agent, '/');
        expect(`${agent}:${r.via}`).toBe(`${agent}:exact`);
      }
    });

    it('carries the affirmative Content-signal and no unratified content-use field', () => {
      expect(LIVE_ROBOTS).toContain('Content-signal: search=yes, ai-input=yes, ai-train=yes');
      expect(LIVE_ROBOTS).not.toMatch(/\buse=/);
    });

    it('keeps Content-signal inside the User-agent: * group without splitting it', () => {
      const starGroups = parseRobots(LIVE_ROBOTS).filter((g) => g.agents.includes('*'));
      expect(starGroups).toHaveLength(1);
      expect(starGroups[0].rules.some((r) => r.type === 'allow' && r.path === '/')).toBe(true);
    });

    it('still honours the admin-gated Disallow paths for an unlisted agent', () => {
      const groups = parseRobots(LIVE_ROBOTS);
      expect(resolveForAgent(groups, 'SomeUnknownBot', '/dashboard').verdict).toBe('disallowed');
      expect(resolveForAgent(groups, 'SomeUnknownBot', '/').verdict).toBe('allowed');
    });
  });

  describe('fixture 2 — Cloudflare managed prepend ahead of our file', () => {
    const r = evaluate(CF_PREPEND + LIVE_ROBOTS, ALLOWLIST);

    it('resolves RED', () => {
      expect(r.verdict).toBe('RED');
    });

    it('names every one of the eight disallowed agents', () => {
      expect([...r.disallowed].sort()).toEqual([...CF_BLOCKED].sort());
    });

    it('flags the edge marker independently of the rule resolution', () => {
      expect(r.reasons.some((x) => x.includes(CF_MANAGED_MARKER))).toBe(true);
      expect(evaluate(`# ${CF_MANAGED_MARKER}\n` + LIVE_ROBOTS, ALLOWLIST).verdict).toBe('RED');
    });

    it('prints a DISALLOWED line per blocked agent — the gate is not dark', () => {
      for (const agent of CF_BLOCKED) {
        expect(r.lines).toContain(
          r.lines.find((l) => l.startsWith(`${agent}: DISALLOWED`)) as string,
        );
      }
      expect(r.lines.filter((l) => l.includes(': DISALLOWED'))).toHaveLength(CF_BLOCKED.length);
    });
  });

  describe('fixture 3 — unusable input is INDETERMINATE, never GREEN', () => {
    // Each case asserts its SPECIFIC reason, not just the verdict. Both refusal branches
    // return INDETERMINATE, so a verdict-only assertion stays green when either one is
    // deleted — measured, and exactly the "an assertion that cannot fail is not an
    // assertion" trap. The reason string is what makes these able to fail.
    it.each([
      ['empty body', '', 'empty body'],
      ['whitespace only', '   \n\t\n  ', 'empty body'],
      ['null body', null as unknown as string, 'empty body'],
      ['comments only', '# nothing but a comment\n# and another\n', 'ZERO user-agent groups'],
      [
        'rules with no user-agent group',
        'Sitemap: https://algovault.com/sitemap.xml\nAllow: /\n',
        'ZERO user-agent groups',
      ],
    ])('%s', (_name, body, reason) => {
      const r = evaluate(body, ALLOWLIST);
      expect(r.verdict).toBe('INDETERMINATE');
      expect(r.reasons).toEqual([expect.stringContaining(reason)]);
    });

    it('an EMPTY allowlist is vacuity at construction and REFUSES', () => {
      expect(evaluate(LIVE_ROBOTS, []).verdict).toBe('INDETERMINATE');
      expect(evaluate(LIVE_ROBOTS, undefined as unknown as string[]).verdict).toBe(
        'INDETERMINATE',
      );
    });
  });

  describe('fixture 4 — matching is case-insensitive (RFC 9309 §2.2.1)', () => {
    const CASE_FIXTURE = 'User-agent: *\nAllow: /\n\nUser-agent: meta-externalagent\nDisallow: /\n';

    it('a lowercase Disallow catches a mixed-case allowlist entry', () => {
      const r = evaluate(CASE_FIXTURE, ['Meta-ExternalAgent']);
      expect(r.verdict).toBe('RED');
      expect(r.disallowed).toEqual(['Meta-ExternalAgent']);
    });

    it('and it matched that agent EXACTLY, not via the permissive * fallback', () => {
      // A case-SENSITIVE implementation would miss the group, fall through to `*`, and
      // report allowed/GREEN. `via: exact` is what makes this assertion able to fail.
      const r = resolveForAgent(parseRobots(CASE_FIXTURE), 'Meta-ExternalAgent', '/');
      expect(r.via).toBe('exact');
      expect(r.verdict).toBe('disallowed');
    });
  });

  describe('verdict token → exit-code mapping', () => {
    it('is 0 / 1 / 3 and nothing else', () => {
      expect(VERDICT_EXIT).toEqual({ GREEN: 0, RED: 1, INDETERMINATE: 3 });
    });

    it('maps every reachable verdict to a distinct code', () => {
      const seen = [
        evaluate(LIVE_ROBOTS, ALLOWLIST).verdict,
        evaluate(CF_PREPEND + LIVE_ROBOTS, ALLOWLIST).verdict,
        evaluate('', ALLOWLIST).verdict,
      ].map((v) => VERDICT_EXIT[v as keyof typeof VERDICT_EXIT]);
      expect(seen).toEqual([0, 1, 3]);
      expect(new Set(seen).size).toBe(3);
    });
  });

  describe('artifacts the hermetic seam bypasses', () => {
    it('the allowlist SoT the live gate reads actually exists at the path it resolves', () => {
      expect(existsSync(ALLOWLIST_SOURCE)).toBe(true);
    });

    it('the source reader returns EXACTLY the imported constant — one derivation, not two', () => {
      const fromSource = readAllowlistFromSource(readFileSync(ALLOWLIST_SOURCE, 'utf8'));
      expect(fromSource).toEqual(ALLOWLIST);
      expect(fromSource.length).toBeGreaterThan(0);
    });

    it('the reader ignores commented-out entries rather than harvesting them', () => {
      const src = [
        'export const AI_CRAWLER_ALLOWLIST: readonly string[] = [',
        "  // 'GhostBot' — retired, must not be read back",
        "  'RealBot',",
        '];',
      ].join('\n');
      expect(readAllowlistFromSource(src)).toEqual(['RealBot']);
    });

    it('the reader returns [] (⇒ INDETERMINATE) when the literal is absent', () => {
      expect(readAllowlistFromSource('export const SOMETHING_ELSE = [1];')).toEqual([]);
      expect(readAllowlistFromSource('')).toEqual([]);
    });

    it('the fetch URL carries a cache-buster, so a CDN edge cannot answer a verification read', () => {
      const url = buildFetchUrl(1234567890);
      expect(url).toBe('https://algovault.com/robots.txt?cb=1234567890');
      expect(buildFetchUrl(1)).not.toBe(buildFetchUrl(2));
    });
  });
});
