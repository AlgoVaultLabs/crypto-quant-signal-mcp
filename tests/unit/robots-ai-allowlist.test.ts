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
  // --- GEO-WELLKNOWN-DISCOVERY-W1 ---
  CATALOG_MEDIA_TYPE_PREFIX,
  CATALOG_URL,
  EXPIRES_MIN_DAYS,
  LINK_REL_API_CATALOG,
  SECURITY_TXT_URL,
  evaluateApexLinkAndSignal,
  evaluateCatalogDocument,
  evaluateCatalogHeadLink,
  evaluateCatalogHref,
  evaluateCatalogRedirect,
  evaluateMcpProbe,
  evaluateSecurityTxt,
  hasRelApiCatalog,
  parseSseData,
} from '../../scripts/check-robots-ai-allowlist.mjs';
import {
  DOCUMENTS,
  WELL_KNOWN_DIR,
  buildApiCatalog,
  buildSecurityTxt,
  checkApiCatalogShape,
  checkSecurityTxtShape,
  computeExpires,
  formatExpires,
  readEndpointsFromSource,
  readNumberConstFromSource,
  readStringConstFromSource,
} from '../../scripts/generate-wellknown.mjs';
import {
  API_CATALOG_ENDPOINTS,
  API_CATALOG_URL,
  API_CATALOG_CONTENT_TYPE,
  API_CATALOG_LINK_HEADER,
  SECURITY_TXT_EXPIRY_DAYS,
} from '../../src/lib/ai-crawler-allowlist.js';

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

/**
 * GEO-WELLKNOWN-DISCOVERY-W1 — the /.well-known/ discovery documents.
 *
 * Every W1 and W2 fixture above is untouched; these are additions.
 *
 * EVERY FIXTURE ASSERTS ITS BRANCH'S DISTINCT `reason` STRING, not just the verdict. That is
 * the W1 BREAK-4 finding made structural: two branches returning the same verdict are
 * indistinguishable to a verdict-only assertion, so a deliberate break can stay green while the
 * logic is wrong. The reason string is what makes "every new branch reachable by exactly one
 * fixture" a checkable claim rather than a hope.
 */
const DAY = 86400000;
const NOW = Date.parse('2026-08-30T00:00:00Z');
const inDays = (n: number) => new Date(NOW + n * DAY).toISOString().slice(0, 19) + 'Z';
const goodSecTxt = (expires: string) =>
  `# TEMPLATE.\nContact: https://algovault.com/contact\nExpires: ${expires}\nPreferred-Languages: en\n`;
const goodCatalog = JSON.stringify({
  linkset: [{ anchor: API_CATALOG_URL, item: [{ href: 'https://algovault.com/api/merkle-batches' }] }],
});
const LINKSET_CT = 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"';

describe('W1 — /.well-known/ discovery documents', () => {
  // --- R5.1-R5.5 security.txt --------------------------------------------------------------
  it('R5.1 security.txt missing -> RED, naming the 404', () => {
    const r = evaluateSecurityTxt(404, 'text/plain', '', NOW);
    expect(r.verdict).toBe('RED');
    expect(r.reasons[0]).toContain('returned HTTP 404, expected 200');
  });

  it('R5.2 security.txt present but Expires absent -> RED', () => {
    const r = evaluateSecurityTxt(200, 'text/plain', 'Contact: https://algovault.com/contact\n', NOW);
    expect(r.verdict).toBe('RED');
    expect(r.reasons[0]).toContain('requires an Expires field; none present');
  });

  it('R5.3 Expires 10 days out -> RED (proves the 30-day margin, not merely expiry)', () => {
    const r = evaluateSecurityTxt(200, 'text/plain', goodSecTxt(inDays(10)), NOW);
    expect(r.verdict).toBe('RED');
    expect(r.reasons[0]).toContain(`under the ${EXPIRES_MIN_DAYS}d renewal margin`);
  });

  it('R5.4 Expires 200 days out -> GREEN', () => {
    const r = evaluateSecurityTxt(200, 'text/plain', goodSecTxt(inDays(200)), NOW);
    expect(r.verdict).toBe('GREEN');
    expect(r.reasons).toHaveLength(0);
    expect(r.lines[0]).toContain('200d left');
  });

  it('R5.5 Expires unparseable -> INDETERMINATE, never RED', () => {
    const r = evaluateSecurityTxt(200, 'text/plain', goodSecTxt('next-tuesday'), NOW);
    expect(r.verdict).toBe('INDETERMINATE');
    expect(r.reasons[0]).toContain('could not be parsed as a date');
  });

  it('an ALREADY-PAST Expires is RED on its own branch, distinct from the margin branch', () => {
    const r = evaluateSecurityTxt(200, 'text/plain', goodSecTxt(inDays(-5)), NOW);
    expect(r.verdict).toBe('RED');
    expect(r.reasons[0]).toContain('has already passed');
  });

  it('a wrong media type is RED before the body is even read', () => {
    const r = evaluateSecurityTxt(200, 'application/json', goodSecTxt(inDays(200)), NOW);
    expect(r.verdict).toBe('RED');
    expect(r.reasons[0]).toContain('content-type must start "text/plain"');
  });

  it('a missing Contact is RED on its own branch', () => {
    const r = evaluateSecurityTxt(200, 'text/plain', `Expires: ${inDays(200)}\n`, NOW);
    expect(r.verdict).toBe('RED');
    expect(r.reasons[0]).toContain('requires a Contact field');
  });

  // --- R5.6-R5.8 api-catalog ---------------------------------------------------------------
  it('R5.6 catalog served as application/json -> RED (proves media-type checking)', () => {
    const r = evaluateCatalogDocument(200, 'application/json', goodCatalog);
    expect(r.verdict).toBe('RED');
    expect(r.reasons[0]).toContain(`must start "${CATALOG_MEDIA_TYPE_PREFIX}"`);
  });

  it('R5.6b catalog served with NO content-type at all -> RED (Caddy\'s measured default)', () => {
    const r = evaluateCatalogDocument(200, undefined, goodCatalog);
    expect(r.verdict).toBe('RED');
    expect(r.reasons[0]).toContain('got "(none)"');
  });

  it('R5.7 a catalog href that 404s -> RED, naming the dead endpoint', () => {
    const r = evaluateCatalogHref('https://algovault.com/api/gone', 404);
    expect(r.verdict).toBe('RED');
    expect(r.reasons[0]).toContain('the catalog names a dead endpoint');
  });

  it('R5.8 catalog with an empty item array -> RED', () => {
    const body = JSON.stringify({ linkset: [{ anchor: API_CATALOG_URL, item: [] }] });
    const r = evaluateCatalogDocument(200, LINKSET_CT, body);
    expect(r.verdict).toBe('RED');
    expect(r.reasons[0]).toContain('a catalog naming no API is decorative');
  });

  it('a valid catalog is GREEN and hands back every href for liveness probing', () => {
    const body = JSON.stringify({
      linkset: [{
        anchor: API_CATALOG_URL,
        item: [{ href: 'https://a/1' }, { href: 'https://a/2' }],
        'service-doc': [{ href: 'https://a/docs', type: 'text/html' }],
      }],
    });
    const r = evaluateCatalogDocument(200, LINKSET_CT, body);
    expect(r.verdict).toBe('GREEN');
    expect(r.hrefs.map((h: { href: string }) => h.href)).toEqual([
      'https://a/1', 'https://a/2', 'https://a/docs',
    ]);
  });

  it('a catalog body that is not JSON -> RED on its own branch', () => {
    const r = evaluateCatalogDocument(200, LINKSET_CT, '<html>nope</html>');
    expect(r.verdict).toBe('RED');
    expect(r.reasons[0]).toContain('did not parse as JSON');
  });

  it('a catalog with no linkset[0] -> RED on its own branch', () => {
    const r = evaluateCatalogDocument(200, LINKSET_CT, JSON.stringify({ linkset: [] }));
    expect(r.verdict).toBe('RED');
    expect(r.reasons[0]).toContain('carries no linkset[0] context object');
  });

  it('a 404 catalog -> RED before any media-type or body reasoning', () => {
    const r = evaluateCatalogDocument(404, LINKSET_CT, goodCatalog);
    expect(r.verdict).toBe('RED');
    expect(r.reasons[0]).toContain('the catalog is not published');
  });

  // --- R5.9 HEAD Link ----------------------------------------------------------------------
  it('R5.9 HEAD without the Link header -> RED', () => {
    const r = evaluateCatalogHeadLink(undefined);
    expect(r.verdict).toBe('RED');
    expect(r.reasons[0]).toContain('RFC 9727 §2 requires a Link header');
  });

  it('R5.9b HEAD with a Link header carrying the WRONG relation -> RED on a distinct branch', () => {
    const r = evaluateCatalogHeadLink('</style.css>; rel="stylesheet"');
    expect(r.verdict).toBe('RED');
    expect(r.reasons[0]).toContain('carries no api-catalog relation');
  });

  it('HEAD with the correct Link header -> GREEN', () => {
    expect(evaluateCatalogHeadLink(API_CATALOG_LINK_HEADER).verdict).toBe('GREEN');
  });

  it('rel matching is RFC 8288-shaped: quoted, bare and case-insensitive all match', () => {
    expect(hasRelApiCatalog('</x>; rel="api-catalog"')).toBe(true);
    expect(hasRelApiCatalog('</x>; rel=api-catalog')).toBe(true);
    expect(hasRelApiCatalog('</x>; REL="API-CATALOG"')).toBe(true);
    expect(hasRelApiCatalog('</x>; rel="service-doc"')).toBe(false);
  });

  // --- R5.10 apex dual header --------------------------------------------------------------
  it('R5.10 apex missing Link while Content-Signal present -> RED', () => {
    const r = evaluateApexLinkAndSignal(undefined, CONTENT_SIGNAL_VALUE, CONTENT_SIGNAL_VALUE);
    expect(r.verdict).toBe('RED');
    expect(r.reasons[0]).toContain('carries no Link header');
  });

  it('R5.10b apex Link present but Content-Signal DISPLACED -> RED (the inverse regression)', () => {
    const r = evaluateApexLinkAndSignal(API_CATALOG_LINK_HEADER, '', CONTENT_SIGNAL_VALUE);
    expect(r.verdict).toBe('RED');
    expect(r.reasons[0]).toContain('displaced the W2 Content-Signal header');
  });

  it('apex with a CHANGED Content-Signal value -> RED on its own branch', () => {
    const r = evaluateApexLinkAndSignal(API_CATALOG_LINK_HEADER, 'ai-train=no', CONTENT_SIGNAL_VALUE);
    expect(r.verdict).toBe('RED');
    expect(r.reasons[0]).toContain('expected "search=yes, ai-input=yes, ai-train=yes"');
  });

  it('apex with a Link carrying the wrong relation -> RED on its own branch', () => {
    const r = evaluateApexLinkAndSignal('</x>; rel="preload"', CONTENT_SIGNAL_VALUE, CONTENT_SIGNAL_VALUE);
    expect(r.verdict).toBe('RED');
    expect(r.reasons[0]).toContain('apex Link header carries no api-catalog relation');
  });

  it('apex with BOTH headers present and correct -> GREEN', () => {
    const r = evaluateApexLinkAndSignal(API_CATALOG_LINK_HEADER, CONTENT_SIGNAL_VALUE, CONTENT_SIGNAL_VALUE);
    expect(r.verdict).toBe('GREEN');
  });

  // --- R5.11 api-host redirect -------------------------------------------------------------
  it('R5.11 api-host catalog returning 200 instead of 301 -> RED', () => {
    const r = evaluateCatalogRedirect(200, null);
    expect(r.verdict).toBe('RED');
    expect(r.reasons[0]).toContain(`expected a 301 to ${CATALOG_URL}`);
  });

  it('R5.11b api-host catalog 301-ing to the WRONG target -> RED on a distinct branch', () => {
    const r = evaluateCatalogRedirect(301, 'https://algovault.com/docs');
    expect(r.verdict).toBe('RED');
    expect(r.reasons[0]).toContain('redirect target is "https://algovault.com/docs"');
  });

  it('api-host 301 to the canonical -> GREEN, and a cache-buster query does not break it', () => {
    expect(evaluateCatalogRedirect(301, CATALOG_URL).verdict).toBe('GREEN');
    expect(evaluateCatalogRedirect(301, `${CATALOG_URL}?cb=123`).verdict).toBe('GREEN');
  });

  // --- the /mcp probe: SSE framing + result-not-error ---------------------------------------
  it('parseSseData pulls the payload out of an SSE frame, and returns null without one', () => {
    expect(parseSseData('event: message\ndata: {"a":1}\n\n')).toBe('{"a":1}');
    expect(parseSseData('{"a":1}')).toBeNull();
  });

  it('a healthy SSE-framed initialize -> GREEN (a plain JSON.parse would have failed here)', () => {
    const body = 'event: message\ndata: ' + JSON.stringify({
      jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'x', version: '1.28.2' } },
    }) + '\n\n';
    const r = evaluateMcpProbe('https://api.algovault.com/mcp', 200, body);
    expect(r.verdict).toBe('GREEN');
    expect(r.lines[0]).toContain('server v1.28.2');
  });

  it('a 200 carrying a JSON-RPC error -> RED (the decorative-pointer case in a success code)', () => {
    const body = 'data: ' + JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'nope' } });
    const r = evaluateMcpProbe('https://api.algovault.com/mcp', 200, body);
    expect(r.verdict).toBe('RED');
    expect(r.reasons[0]).toContain('the JSON-RPC envelope carries error "nope"');
  });

  it('a 200 with neither result nor error -> RED on its own branch', () => {
    const r = evaluateMcpProbe('https://api.algovault.com/mcp', 200, 'data: {"jsonrpc":"2.0","id":1}');
    expect(r.verdict).toBe('RED');
    expect(r.reasons[0]).toContain('neither result nor error');
  });

  it('a non-200 from initialize -> RED naming the status', () => {
    const r = evaluateMcpProbe('https://api.algovault.com/mcp', 406, '');
    expect(r.verdict).toBe('RED');
    expect(r.reasons[0]).toContain('answered HTTP 406 to a JSON-RPC initialize');
  });

  it('a 200 with an empty or unparseable payload -> INDETERMINATE, never RED', () => {
    expect(evaluateMcpProbe('h', 200, '').verdict).toBe('INDETERMINATE');
    expect(evaluateMcpProbe('h', 200, 'data: not-json').verdict).toBe('INDETERMINATE');
    expect(evaluateMcpProbe('h', 200, 'data: not-json').reasons[0]).toContain('did not parse as JSON');
  });

  // --- generator: pure builders + shape checks ---------------------------------------------
  it('computeExpires is pure and lands exactly SECURITY_TXT_EXPIRY_DAYS out', () => {
    expect(computeExpires(new Date('2026-01-01T00:00:00Z'), 180)).toBe('2026-06-30T00:00:00Z');
    expect(SECURITY_TXT_EXPIRY_DAYS).toBe(180);
  });

  it('formatExpires emits RFC 9116-shaped ISO 8601 with seconds precision and no milliseconds', () => {
    expect(formatExpires(new Date('2026-01-02T03:04:05.678Z'))).toBe('2026-01-02T03:04:05Z');
  });

  it('the generated security.txt carries no mailto and no Encryption, and names the generator', () => {
    const body = buildSecurityTxt(inDays(180));
    expect(body).not.toMatch(/mailto:/i);
    expect(body).not.toMatch(/^Encryption:/mi);
    expect(body).toContain('TEMPLATE.');
    expect(body).toContain('generate-wellknown.mjs');
  });

  it('the generated catalog never leaks the gate-only probe key into the document', () => {
    const doc = buildApiCatalog([...API_CATALOG_ENDPOINTS], API_CATALOG_URL);
    expect(doc).not.toContain('probe');
    expect(JSON.parse(doc).linkset[0]['service-desc']).toBeUndefined();
  });

  it('the source reader recovers the SoT endpoint set byte-for-byte from the .ts text', () => {
    // The gate and the generator both run on a host with no TypeScript loader, so this text
    // reader IS the interface. If it drifts from the typed constant the document and the probe
    // set silently disagree — which is the whole reason it is one reader and not two.
    const src = readFileSync(join(REPO_ROOT, 'src', 'lib', 'ai-crawler-allowlist.ts'), 'utf8');
    const read = readEndpointsFromSource(src);
    expect(read).toEqual(API_CATALOG_ENDPOINTS.map((e) => ({ ...e })));
    expect(readStringConstFromSource(src, 'API_CATALOG_URL')).toBe(API_CATALOG_URL);
    expect(readNumberConstFromSource(src, 'SECURITY_TXT_EXPIRY_DAYS')).toBe(SECURITY_TXT_EXPIRY_DAYS);
  });

  it('an empty read is vacuity, not a default: the reader returns [] rather than guessing', () => {
    expect(readEndpointsFromSource('nothing here')).toEqual([]);
    expect(readStringConstFromSource('nothing here', 'API_CATALOG_URL')).toBe('');
    expect(readNumberConstFromSource('nothing here', 'SECURITY_TXT_EXPIRY_DAYS')).toBeNull();
  });

  it('exactly one endpoint is probed by POST, it is /mcp, and no billable tool is named', () => {
    const nonGet = API_CATALOG_ENDPOINTS.filter((e) => e.probe !== 'GET');
    expect(nonGet).toHaveLength(1);
    expect(nonGet[0].href).toBe('https://api.algovault.com/mcp');
    expect(nonGet[0].probe).toBe('mcp-initialize');
    const gateSrc = readFileSync(join(REPO_ROOT, 'scripts', 'check-robots-ai-allowlist.mjs'), 'utf8');
    // The guardrail, asserted rather than trusted to a comment: a daily unattended canary must
    // never call a billable tool, because that would make it a producer of the data it watches.
    for (const tool of ['get_trade_call', 'scan_trade_calls', 'get_market_regime', 'scan_funding_arb']) {
      expect(gateSrc).not.toContain(`"${tool}"`);
      expect(gateSrc).not.toContain(`'${tool}'`);
    }
    expect(gateSrc).toContain("method: 'initialize'");
  });

  // --- the COMMITTED artifacts (bypassed-seam assertions) -----------------------------------
  it('both committed documents exist at the path the deploy renders to', () => {
    for (const name of DOCUMENTS) {
      expect(existsSync(join(WELL_KNOWN_DIR, name))).toBe(true);
    }
    expect(DOCUMENTS).toEqual(['security.txt', 'api-catalog']);
  });

  it('the committed security.txt passes its SHAPE check — freshness is the live gate\'s job', () => {
    // Deliberately NOT asserting the committed Expires is >30d out: that would key a
    // calendar-triggered failure to commit date, in a pre-push hook shared by ~74 checkouts.
    const body = readFileSync(join(WELL_KNOWN_DIR, 'security.txt'), 'utf8');
    expect(checkSecurityTxtShape(body).reasons).toEqual([]);
    expect(body).not.toMatch(/mailto:/i);
    expect(body).not.toMatch(/^Encryption:/mi);
  });

  it('the committed api-catalog passes its shape check and matches the SoT endpoint set', () => {
    const body = readFileSync(join(WELL_KNOWN_DIR, 'api-catalog'), 'utf8');
    expect(checkApiCatalogShape(body).reasons).toEqual([]);
    const doc = JSON.parse(body);
    expect(doc.linkset[0].anchor).toBe(API_CATALOG_URL);
    const inDoc = [
      ...doc.linkset[0].item.map((l: { href: string }) => l.href),
      ...doc.linkset[0]['service-doc'].map((l: { href: string }) => l.href),
    ];
    expect(inDoc).toEqual(API_CATALOG_ENDPOINTS.map((e) => e.href));
  });

  it('the Caddyfile declares the media type and the Link header the gate asserts live', () => {
    // Caddyfile is in deploy.yml paths-ignore, so the committed copy is applied by SSH and can
    // legitimately lag the running one. This locks the COMMITTED copy; the live gate locks the
    // RUNNING one. Neither closes it alone — the same split W2 recorded for Content-Signal.
    const caddy = readFileSync(join(REPO_ROOT, 'Caddyfile'), 'utf8');
    expect(caddy).toContain('application/linkset+json; profile=');
    expect(caddy).toContain('rfc-editor.org/info/rfc9727');
    expect(caddy).toContain('rel=\\"api-catalog\\"');
    expect(caddy).toContain('redir * https://algovault.com/.well-known/api-catalog 301');
    // No invented relation anywhere on the surface (R3.1).
    expect(caddy).not.toMatch(/rel=\\?"llms/i);
  });

  it('deploy.yml renders the documents and carries a GREPPABLE failure token', () => {
    const dep = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8');
    expect(dep).toContain('generate-wellknown.mjs --out /var/www/algovault/.well-known');
    expect(dep).toContain('mkdir -p /var/www/algovault/.well-known');
    expect(dep).toContain('WELLKNOWN_RENDER_FAILED');
  });

  it('the gate URLs point at the apex canonical', () => {
    expect(SECURITY_TXT_URL).toBe(`${APEX_ORIGIN}/.well-known/security.txt`);
    expect(CATALOG_URL).toBe(API_CATALOG_URL);
    expect(API_CATALOG_CONTENT_TYPE.startsWith(CATALOG_MEDIA_TYPE_PREFIX)).toBe(true);
    expect(LINK_REL_API_CATALOG).toBe('api-catalog');
  });

  it('robots.txt still permits the discovery directory it now has documents in', () => {
    // The W2 narrowing is what makes this wave meaningful; if it regressed, these documents are
    // published into a directory crawlers are told to skip.
    expect(resolveForAgent(parseRobots(LIVE_ROBOTS), 'GPTBot', '/.well-known/security.txt').verdict).toBe('allowed');
    expect(resolveForAgent(parseRobots(LIVE_ROBOTS), 'GPTBot', '/.well-known/api-catalog').verdict).toBe('allowed');
    expect(resolveForAgent(parseRobots(LIVE_ROBOTS), '*', '/.well-known/acme-challenge/x').verdict).toBe('disallowed');
  });

  it('combineVerdicts still folds a document RED over an otherwise-green run', () => {
    const green = { verdict: 'GREEN', lines: [], reasons: [] };
    const red = evaluateSecurityTxt(404, 'text/plain', '', NOW);
    expect(combineVerdicts([green, red]).verdict).toBe('RED');
    expect(combineVerdicts([green, evaluateSecurityTxt(200, 'text/plain', goodSecTxt('nope'), NOW)]).verdict)
      .toBe('INDETERMINATE');
    expect(VERDICT_EXIT.INDETERMINATE).toBe(3);
  });
});
