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
import { AI_CRAWLER_ALLOWLIST, CONTENT_SIGNAL_VALUE } from '../../src/lib/ai-crawler-allowlist.js';
import {
  ALLOWLIST_SOURCE,
  APEX_ORIGIN,
  CF_MANAGED_MARKER,
  LLMS_FORBIDDEN_PATH,
  SURFACES,
  VERDICT_EXIT,
  WELL_KNOWN_BLANKET,
  buildFetchUrl,
  combineVerdicts,
  evaluate,
  evaluateApexSignals,
  evaluateHeader,
  evaluateLlms,
  evaluateRedirect,
  evaluateRobotsReachable,
  parseRobots,
  readAllowlistFromSource,
  readContentSignalFromSource,
  resolveForAgent,
} from '../../scripts/check-robots-ai-allowlist.mjs';

const REPO_ROOT = join(__dirname, '..', '..');
const REPO_ROOT_T = REPO_ROOT;
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

/**
 * GEO-AGENT-DISCOVERY-W2 — every W1 fixture above is unchanged. These are additions.
 *
 * DISCIPLINE THIS BLOCK INHERITS FROM W1'S BREAK-PROOF: W1's `BREAK 4` stayed GREEN because two
 * refusal branches returned the same verdict, so a verdict-only assertion could not tell them
 * apart. Every fixture below therefore asserts the branch's DISTINCT reason string as well as its
 * verdict — that is what makes each branch reachable by exactly one fixture and individually
 * falsifiable.
 */
describe('W2 — agent-discovery layer', () => {
  const SIGNAL = CONTENT_SIGNAL_VALUE;
  const APEX_OK = [
    'User-agent: *',
    `Content-signal: ${SIGNAL}`,
    'Allow: /',
    'Disallow: /dashboard',
    'Disallow: /.well-known/acme-challenge/',
    '',
  ].join('\n');

  describe('apex robots.txt signal checks', () => {
    it('the current committed landing/robots.txt passes both signal checks', () => {
      const r = evaluateApexSignals(LIVE_ROBOTS, SIGNAL);
      expect(r.reasons).toEqual([]);
      expect(r.verdict).toBe('GREEN');
    });

    it('fixture 1 — Content-signal line REMOVED → RED', () => {
      const body = APEX_OK.split('\n').filter((l) => !/^Content-signal:/i.test(l)).join('\n');
      const r = evaluateApexSignals(body, SIGNAL);
      expect(r.verdict).toBe('RED');
      expect(r.reasons).toEqual([expect.stringContaining('LINE ABSENT')]);
    });

    it('fixture 2 — `ai-train=no` → RED (proves VALUE checking, not mere presence)', () => {
      const body = APEX_OK.replace(SIGNAL, 'search=yes, ai-train=no');
      const r = evaluateApexSignals(body, SIGNAL);
      expect(r.verdict).toBe('RED');
      expect(r.reasons).toEqual([expect.stringContaining('VALUE MISMATCH')]);
      expect(r.reasons[0]).toContain('ai-train=no');
    });

    it('fixture 3 — blanket `Disallow: /.well-known/` → RED', () => {
      const body = APEX_OK.replace('Disallow: /.well-known/acme-challenge/', 'Disallow: /.well-known/');
      const r = evaluateApexSignals(body, SIGNAL);
      expect(r.verdict).toBe('RED');
      expect(r.reasons).toEqual([expect.stringContaining('BLANKET')]);
    });

    it('the NARROW acme-challenge form must NOT trip the blanket check (the other direction)', () => {
      expect(APEX_OK).toContain(`Disallow: ${WELL_KNOWN_BLANKET}acme-challenge/`);
      expect(evaluateApexSignals(APEX_OK, SIGNAL).verdict).toBe('GREEN');
    });

    it('an unreadable content-signal SoT is INDETERMINATE, never a pass', () => {
      const r = evaluateApexSignals(APEX_OK, null);
      expect(r.verdict).toBe('INDETERMINATE');
      expect(r.reasons).toEqual([expect.stringContaining('SoT read back EMPTY')]);
    });
  });

  describe('Content-Signal response header', () => {
    it('fixture 4 — header MISSING → RED', () => {
      const r = evaluateHeader(null, SIGNAL);
      expect(r.verdict).toBe('RED');
      expect(r.reasons).toEqual([expect.stringContaining('ABSENT on the apex response')]);
    });

    it('fixture 5 — header PRESENT but value MISMATCHED → RED', () => {
      const r = evaluateHeader('search=yes, ai-train=no', SIGNAL);
      expect(r.verdict).toBe('RED');
      expect(r.reasons).toEqual([expect.stringContaining('VALUE MISMATCH')]);
    });

    it('matching header → GREEN, and surrounding whitespace is tolerated', () => {
      expect(evaluateHeader(SIGNAL, SIGNAL).verdict).toBe('GREEN');
      expect(evaluateHeader(`  ${SIGNAL}  `, SIGNAL).verdict).toBe('GREEN');
    });
  });

  describe('non-apex surfaces', () => {
    it('fixture 6 — robots.txt returning 404 → RED', () => {
      const r = evaluateRobotsReachable('api.algovault.com', 404);
      expect(r.verdict).toBe('RED');
      expect(r.reasons).toEqual([expect.stringContaining('HTTP 404, expected 200')]);
    });

    it('200 → GREEN', () => {
      expect(evaluateRobotsReachable('plausible.algovault.com', 200).verdict).toBe('GREEN');
    });

    it('fixture 8 — a TIMEOUT is INDETERMINATE, not RED (a distinct branch from a 404)', () => {
      // "could not ask" and "asked and got the wrong answer" are not the same fact, and only the
      // second is a regression. The gate reaches this branch through fetchLive's ok:false path.
      const r = combineVerdicts([
        {
          verdict: 'INDETERMINATE',
          lines: ['api.algovault.com/robots.txt: UNREACHABLE'],
          reasons: ['api.algovault.com/robots.txt: fetch failed: AbortError: The operation was aborted'],
        },
      ]);
      expect(r.verdict).toBe('INDETERMINATE');
      expect(r.verdict).not.toBe('RED');
      expect(r.reasons[0]).toContain('fetch failed');
    });
  });

  describe('www redirect assertion (a DISTINCT check kind, not allowlist resolution)', () => {
    it('301 to the apex at the same path → GREEN, query string preserved or not', () => {
      expect(evaluateRedirect('www.algovault.com', 301, `${APEX_ORIGIN}/track-record`, '/track-record').verdict).toBe('GREEN');
      // Measured on the first live run: the gate's own ?cb= cache-buster survives the 301, so a
      // whole-URL comparison false-REDs every run. Origin+pathname is the contract.
      expect(evaluateRedirect('www.algovault.com', 301, `${APEX_ORIGIN}/track-record?cb=9`, '/track-record').verdict).toBe('GREEN');
    });

    it.each([
      ['redirect stops happening (200)', 200, `${APEX_ORIGIN}/track-record`, 'expected a 3xx'],
      ['redirect goes to the wrong path', 301, `${APEX_ORIGIN}/elsewhere`, 'redirect target is'],
      ['redirect goes to another host', 301, 'https://evil.example.com/track-record', 'redirect target is'],
      ['no Location header at all', 301, null, 'redirect target is'],
    ])('%s → RED', (_n, status, loc, reason) => {
      const r = evaluateRedirect('www.algovault.com', status as number, loc as string | null, '/track-record');
      expect(r.verdict).toBe('RED');
      expect(r.reasons).toEqual([expect.stringContaining(reason as string)]);
    });
  });

  describe('llms.txt hygiene', () => {
    it('fixture 7 — a /docs/integrations/ hop → RED, counted', () => {
      const r = evaluateLlms(`- [Binance](${APEX_ORIGIN}/docs/integrations/binance): x`);
      expect(r.verdict).toBe('RED');
      expect(r.reasons).toEqual([expect.stringContaining(`1 occurrence(s) of ${LLMS_FORBIDDEN_PATH}`)]);
    });

    it('the committed llms.txt and llms-full.txt carry ZERO hops', () => {
      for (const f of ['llms.txt', 'llms-full.txt']) {
        const body = readFileSync(join(REPO_ROOT_T, 'landing', f), 'utf8');
        expect(`${f}:${body.split(LLMS_FORBIDDEN_PATH).length - 1}`).toBe(`${f}:0`);
        expect(evaluateLlms(body).verdict).toBe('GREEN');
      }
    });

    it('an EMPTY llms.txt is INDETERMINATE, never a silent pass', () => {
      const r = evaluateLlms('');
      expect(r.verdict).toBe('INDETERMINATE');
      expect(r.reasons).toEqual([expect.stringContaining('EMPTY body')]);
    });
  });

  describe('surface list + verdict folding', () => {
    it('a new host joins by ONE array entry, and all four are declared', () => {
      expect(SURFACES.map((s) => `${s.host}:${s.kind}`)).toEqual([
        'algovault.com:apex',
        'api.algovault.com:robots-200',
        'plausible.algovault.com:robots-200',
        'www.algovault.com:redirect-to-apex',
      ]);
    });

    it('plausible stays under the gate even though W2 writes nothing there', () => {
      // R5 was a no-op — plausible already served the right body. "Already correct" is a state
      // that can regress, so it keeps its assertion.
      expect(SURFACES.some((s) => s.host === 'plausible.algovault.com')).toBe(true);
    });

    it('RED dominates INDETERMINATE dominates GREEN', () => {
      const g = { verdict: 'GREEN', lines: [], reasons: [] };
      const i = { verdict: 'INDETERMINATE', lines: [], reasons: ['x'] };
      const r = { verdict: 'RED', lines: [], reasons: ['y'] };
      expect(combineVerdicts([g, g]).verdict).toBe('GREEN');
      expect(combineVerdicts([g, i]).verdict).toBe('INDETERMINATE');
      expect(combineVerdicts([g, i, r]).verdict).toBe('RED');
      expect(combineVerdicts([]).verdict).toBe('INDETERMINATE');
    });
  });

  /**
   * BUILD-TIME half of the content-signal lockstep. The RUN-TIME half is
   * scripts/check-robots-ai-allowlist.mjs against the live surfaces.
   *
   * NEITHER CLOSES IT ALONE, and that is deliberate: `Caddyfile` is in deploy.yml's paths-ignore,
   * so the committed copy is applied to the host by SSH and can legitimately differ from the
   * running one between a commit and its install. This block proves the COMMITTED artifacts; the
   * live gate proves the RUNNING one. Do not delete either believing the other covers it.
   */
  describe('content-signal single-derivation lockstep (committed artifacts)', () => {
    it("the gate's reader returns EXACTLY the imported constant", () => {
      expect(readContentSignalFromSource(readFileSync(ALLOWLIST_SOURCE, 'utf8'))).toBe(CONTENT_SIGNAL_VALUE);
    });

    it('returns null (⇒ INDETERMINATE) when the literal is absent', () => {
      expect(readContentSignalFromSource('export const SOMETHING_ELSE = 1;')).toBeNull();
      expect(readContentSignalFromSource('')).toBeNull();
    });

    it.each([
      ['landing/robots.txt', 'landing/robots.txt'],
      ['landing/api-robots.txt', 'landing/api-robots.txt'],
    ])('%s carries the constant byte-for-byte', (_n, rel) => {
      const line = readFileSync(join(REPO_ROOT_T, rel), 'utf8')
        .split('\n')
        .find((l) => /^content-signal:/i.test(l));
      expect(line).toBeDefined();
      expect(line!.replace(/^content-signal:\s*/i, '').trim()).toBe(CONTENT_SIGNAL_VALUE);
    });

    it('the committed Caddyfile sets the header on the apex AND api blocks, and NOT on plausible', () => {
      const caddy = readFileSync(join(REPO_ROOT_T, 'Caddyfile'), 'utf8');
      const headers = [...caddy.matchAll(/^\s*header Content-Signal "([^"]*)"/gim)].map((m) => m[1]);
      expect(headers).toHaveLength(2);
      for (const h of headers) expect(h).toBe(CONTENT_SIGNAL_VALUE);
      // plausible.algovault.com's block must carry no content-use declaration: we declared that
      // host has no crawlable content, so a policy over it would be a claim about content that
      // does not exist.
      const plausible = caddy.slice(caddy.indexOf('plausible.algovault.com {'));
      expect(plausible).not.toMatch(/header Content-Signal/i);
    });

    it('no unratified `use=` / content-use DIRECTIVE on any policy surface', () => {
      // Scoped to NON-COMMENT lines. A whole-file grep cannot tell a directive from a mention,
      // and these files deliberately DISCUSS `use=` to record why it is absent — scanning the
      // comments would make the prohibition unwritable-about, which is the invocation-vs-mention
      // trap. `#` opens a comment in both robots.txt (RFC 9309) and the Caddyfile.
      for (const rel of ['landing/robots.txt', 'landing/api-robots.txt', 'Caddyfile']) {
        const directives = readFileSync(join(REPO_ROOT_T, rel), 'utf8')
          .split('\n')
          .map((l) => l.replace(/#.*$/, ''))
          .join('\n');
        expect(`${rel}:${(directives.match(/\buse=/g) ?? []).length}`).toBe(`${rel}:0`);
      }
    });

    it('…and that scan is not vacuous — it still catches a real directive', () => {
      // Proves the comment-stripping above did not disarm the check itself.
      const withDirective = '# talking about use= is fine\nContent-signal: search=yes, use=full\n';
      const stripped = withDirective.split('\n').map((l) => l.replace(/#.*$/, '')).join('\n');
      expect((stripped.match(/\buse=/g) ?? []).length).toBe(1);
    });

    it('api-robots.txt opens with the provenance comment that neutralises its apex copy', () => {
      const body = readFileSync(join(REPO_ROOT_T, 'landing', 'api-robots.txt'), 'utf8');
      const first2 = body.split('\n').slice(0, 2);
      expect(first2[0]).toBe('# Served at https://api.algovault.com/robots.txt');
      expect(first2[1]).toBe('# Its presence at any other path is a deploy artifact and carries no policy.');
    });

    it('api-robots.txt disallows everything EXCEPT the agent-discovery directory', () => {
      const groups = parseRobots(readFileSync(join(REPO_ROOT_T, 'landing', 'api-robots.txt'), 'utf8'));
      expect(resolveForAgent(groups, 'GPTBot', '/').verdict).toBe('disallowed');
      expect(resolveForAgent(groups, 'GPTBot', '/mcp').verdict).toBe('disallowed');
      expect(resolveForAgent(groups, 'GPTBot', '/.well-known/api-catalog').verdict).toBe('allowed');
    });
  });
});
