/**
 * OPS-DRIFT-CANARY-INVOCATION-FIX-W1 — the shared served-page region checker.
 *
 * What is pinned here that the helper's own `--self-test` cannot pin:
 *
 *  1. THE PAGE SET IS DERIVED, NOT DECLARED. The test recomputes the marker-bearing set from the
 *     repo independently and requires the helper to agree. A hardcoded array — the stale-count
 *     class this repo has laws against — fails the moment a page is added or removed.
 *
 *  2. BOTH CANARIES CONSUME THE ONE HELPER. A second inline implementation (a re-introduced
 *     `docker exec … build_X --check`, or a bespoke curl loop) fails. Comments are stripped
 *     first: both canaries' docblocks deliberately QUOTE the historical buggy invocation so the
 *     next reader knows not to restore it, and a naive grep would demand deleting the most
 *     valuable lines in the file.
 *
 *  3. THE INVENTORY ROWS MATCH THE COMMITTED BYTES and the schedules satisfy the boundary rule.
 *
 * Every case here drives the helper through INJECTED seams (fetch + canonical resolver), so no
 * test touches the network. The artifacts those seams bypass — URL derivation, region extraction,
 * the docker argv — are asserted directly, both here and in the helper's own `--self-test`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative, sep } from 'node:path';
import {
  REGIONS,
  derivePageSet,
  urlForPage,
  extractRegion,
  buildCanonicalDockerArgv,
  runCheck,
  formatSummary,
  selfTest,
  EXIT,
  VERDICT_KEY,
} from '../../ops/monitoring/served-region-check.mjs';
import { NAV_START, NAV_END, DESKTOP_SIG, listHtml } from '../../scripts/build_nav.mjs';
import { ANALYTICS_START, isExcluded } from '../../scripts/build_analytics.mjs';

const ROOT = resolve(__dirname, '../..');
const NAV_CANARY = resolve(ROOT, 'ops/cron/nav-drift-canary.sh');
const ANA_CANARY = resolve(ROOT, 'ops/cron/analytics-drift-canary.sh');
const HELPER_REL = 'ops/monitoring/served-region-check.mjs';
const INVENTORY = resolve(ROOT, 'ops/monitoring/monitoring-inventory.json');

/** Strip `#` comment lines — a mention in a comment is not an invocation. */
const stripComments = (src: string) =>
  src
    .split('\n')
    .filter((l) => !/^[[:space:]]*#/.test(l) && !/^\s*#/.test(l))
    .join('\n');

const canonical = 'CANON-REGION';
const navHtml = (body: string) => `<html>${NAV_START}\n${body}\n${NAV_END}</html>`;
const stubCanon = async () => ({ region: canonical, transport: 'test' });
const stubPages = [
  { rel: 'landing/a.html', relFromLanding: 'a.html', url: 'https://x/a' },
  { rel: 'landing/b.html', relFromLanding: 'b.html', url: 'https://x/b' },
];
const fetchFrom = (map: Record<string, string>) => async (url: string) => {
  if (!(url in map)) throw new Error('injected network failure');
  return { ok: true, status: 200, text: async () => map[url] } as any;
};

// ── 1. the page set is DERIVED ───────────────────────────────────────────────────────────
describe('derived page set (a hardcoded array must fail)', () => {
  /** Recompute the expected set here, independently of the helper. */
  function expectedSet(region: 'nav' | 'analytics'): string[] {
    const landing = resolve(ROOT, 'landing');
    const out: string[] = [];
    for (const file of listHtml(landing)) {
      const relFromLanding = relative(landing, file);
      const html = readFileSync(file, 'utf8');
      if (isExcluded(relFromLanding)) continue;
      const carries =
        region === 'nav'
          ? html.includes(NAV_START) || html.includes(DESKTOP_SIG)
          : true; // analytics: TOTAL coverage over non-excluded content pages
      if (carries) out.push(relative(ROOT, file));
    }
    return out.sort();
  }

  it('nav set matches an independent recomputation and is non-empty', () => {
    const got = derivePageSet('nav', ROOT).map((p) => p.rel).sort();
    expect(got.length).toBeGreaterThan(0);
    expect(got).toEqual(expectedSet('nav'));
  });

  it('analytics set matches an independent recomputation and is a superset of nav', () => {
    const nav = derivePageSet('nav', ROOT).map((p) => p.rel);
    const ana = derivePageSet('analytics', ROOT).map((p) => p.rel).sort();
    expect(ana).toEqual(expectedSet('analytics'));
    for (const p of nav) expect(ana).toContain(p);
  });

  it('the helper source declares NO literal page/URL list', () => {
    const src = readFileSync(resolve(ROOT, HELPER_REL), 'utf8');
    // A hardcoded page list would look like an array of .html paths or of site URLs.
    const literalHtmlList = /\[\s*(['"`])[^'"`]*\.html\1\s*,/.test(src);
    const literalUrlList = /\[\s*(['"`])https:\/\/algovault\.com\/[^'"`]*\1\s*,/.test(src);
    expect(literalHtmlList).toBe(false);
    expect(literalUrlList).toBe(false);
  });

  it('URL derivation is total and injective over the derived set', () => {
    for (const region of ['nav', 'analytics'] as const) {
      const urls = derivePageSet(region, ROOT).map((p) => p.url);
      for (const u of urls) expect(u).toMatch(/^https:\/\/algovault\.com\//);
      expect(new Set(urls).size).toBe(urls.length);
    }
  });

  it('URL derivation handles index, nested and nested-index', () => {
    expect(urlForPage('index.html')).toBe('https://algovault.com/');
    expect(urlForPage('verify.html')).toBe('https://algovault.com/verify');
    expect(urlForPage(['integrations', 'binance.html'].join(sep))).toBe(
      'https://algovault.com/integrations/binance',
    );
    expect(urlForPage(['foo', 'index.html'].join(sep))).toBe('https://algovault.com/foo');
  });
});

// ── 2. offender classes stay distinct ────────────────────────────────────────────────────
describe('drifted vs missingMarker remain distinguishable', () => {
  it('a drifted served region counts as drifted ONLY', async () => {
    const r = await runCheck({
      region: 'nav', pages: stubPages, canonicalResolver: stubCanon,
      fetchImpl: fetchFrom({ 'https://x/a': navHtml(canonical), 'https://x/b': navHtml('SOMETHING ELSE') }),
    });
    expect(r.verdict).toBe('FAIL');
    expect(r.drifted).toEqual(['https://x/b']);
    expect(r.missingMarker).toEqual([]);
  });

  it('a served page with its markers deleted counts as missingMarker ONLY', async () => {
    const r = await runCheck({
      region: 'nav', pages: stubPages, canonicalResolver: stubCanon,
      fetchImpl: fetchFrom({ 'https://x/a': navHtml(canonical), 'https://x/b': '<html>markers gone</html>' }),
    });
    expect(r.verdict).toBe('FAIL');
    expect(r.drifted).toEqual([]);
    expect(r.missingMarker).toEqual(['https://x/b']);
  });

  it('extractRegion undoes exactly applyRegion\'s newline convention', () => {
    expect(extractRegion(navHtml('BODY'), NAV_START, NAV_END)).toEqual({ marked: true, inner: 'BODY' });
    expect(extractRegion('nothing', NAV_START, NAV_END)).toEqual({ marked: false, inner: null });
    expect(extractRegion(`${NAV_END}x${NAV_START}`, NAV_START, NAV_END)).toEqual({ marked: false, inner: null });
  });
});

// ── 3 + 4. never a clean pass over an unobserved corpus ──────────────────────────────────
describe('INDETERMINATE, never PASS', () => {
  it('a fetch failure is INDETERMINATE and is counted', async () => {
    const r = await runCheck({
      region: 'nav', pages: stubPages, canonicalResolver: stubCanon,
      fetchImpl: fetchFrom({ 'https://x/a': navHtml(canonical) }),
    });
    expect(r.verdict).toBe('INDETERMINATE');
    expect(r.fetchFailed).toHaveLength(1);
    expect(r.verdict).not.toBe('PASS');
  });

  it('zero derived pages is INDETERMINATE (a corpus WE construct — vacuity refuses)', async () => {
    const r = await runCheck({ region: 'nav', pages: [], canonicalResolver: stubCanon, fetchImpl: fetchFrom({}) });
    expect(r.verdict).toBe('INDETERMINATE');
    expect(r.pagesChecked).toBe(0);
  });

  it('an unavailable canonical render is INDETERMINATE', async () => {
    const r = await runCheck({
      region: 'nav', pages: stubPages, fetchImpl: fetchFrom({}),
      canonicalResolver: async () => ({ error: 'no render' }),
    });
    expect(r.verdict).toBe('INDETERMINATE');
  });

  it('a clean run PASSes and reports a non-zero page count', async () => {
    const r = await runCheck({
      region: 'nav', pages: stubPages, canonicalResolver: stubCanon,
      fetchImpl: fetchFrom({ 'https://x/a': navHtml(canonical), 'https://x/b': navHtml(canonical) }),
    });
    expect(r.verdict).toBe('PASS');
    expect(r.pagesChecked).toBe(2);
  });

  it('the summary always carries pages_checked — a zero-page run can never read like a clean one', async () => {
    const clean = await runCheck({
      region: 'nav', pages: stubPages, canonicalResolver: stubCanon,
      fetchImpl: fetchFrom({ 'https://x/a': navHtml(canonical), 'https://x/b': navHtml(canonical) }),
    });
    const empty = await runCheck({ region: 'nav', pages: [], canonicalResolver: stubCanon, fetchImpl: fetchFrom({}) });
    expect(formatSummary('nav', clean)).toMatch(/pages_checked=2\/2/);
    expect(formatSummary('nav', empty)).toMatch(/pages_checked=0\/0/);
    expect(formatSummary('nav', clean)).not.toEqual(formatSummary('nav', empty));
  });

  it('the token -> exit-code mapping is 0/1/3', () => {
    expect([EXIT.PASS, EXIT.FAIL, EXIT.INDETERMINATE]).toEqual([0, 1, 3]);
    expect(VERDICT_KEY).toBe('SERVED_REGION_VERDICT');
  });

  it('the helper self-test passes and is non-vacuous', async () => {
    const lines: string[] = [];
    const r = await selfTest((s: string) => lines.push(s));
    expect(r.ok).toBe(true);
    expect(r.checks).toBeGreaterThan(10);
    expect(r.failures).toBe(0);
  });
});

// ── 5. both canaries consume the ONE helper ──────────────────────────────────────────────
describe('both canaries consume the shared helper', () => {
  const canaries: Array<[string, string, string]> = [
    ['nav', NAV_CANARY, 'nav'],
    ['analytics', ANA_CANARY, 'analytics'],
  ];

  it.each(canaries)('%s canary invokes the shared checker with its region', (_n, file, region) => {
    const code = stripComments(readFileSync(file, 'utf8'));
    expect(code).toContain(HELPER_REL);
    expect(code).toContain(`--region="$REGION"`);
    expect(code).toContain(`REGION="${region}"`);
  });

  /**
   * The ban targets IMPLEMENTATION SHAPES, never bare literals.
   *
   * A first draft asserted the marker literals were absent and failed on both canaries — because
   * the alert BODY legitimately tells the operator the page "is missing its <!-- NAV:START/END -->
   * markers". That is user-facing copy, not a second implementation, and banning the literal would
   * have forced deleting the most useful sentence in the alert. Same trap the repo already
   * records for comment-quoting gates: match what the code DOES, not what it MENTIONS.
   */
  /**
   * Match INVOCATION POSITION, not the bare token: a command runs at the start of a line or after
   * `$(`, `|`, `&&`, `;`. Anywhere else it is prose.
   *
   * This regex is the general fix for a trap that bit three separate assertions in this file
   * while it was being written — every one of them a ban-grep firing on operator-facing ALERT
   * COPY rather than on code. The alert bodies deliberately name `<!-- NAV:START/END -->`,
   * `renderSiteNav()`, and `docker exec` because an operator reading the page needs to know which
   * model drifted and what was tried. Stripping comments is not enough when the mentions live in
   * string literals; the durable rule is to match what the code DOES.
   */
  const invocation = (cmd: string) => new RegExp(String.raw`(?:^|\$\(|\||&&|;)\s*${cmd}\b`, 'm');

  it.each(canaries)('%s canary carries NO second inline implementation', (_n, file) => {
    const code = stripComments(readFileSync(file, 'utf8'));
    // The retired invocation, in any position.
    expect(code).not.toMatch(/docker\s+exec[^\n]*build_(nav|analytics)\.mjs/);
    // A bespoke fetch loop, a container call, or inline JS — the three ways to re-implement it.
    expect(code).not.toMatch(invocation(String.raw`curl`));
    expect(code).not.toMatch(invocation(String.raw`wget`));
    expect(code).not.toMatch(invocation(String.raw`docker\s+exec`));
    expect(code).not.toMatch(invocation(String.raw`node\s+-e`));
    // Region EXTRACTION done in the shell (sed/awk range over the markers).
    expect(code).not.toMatch(/(sed|awk)[^\n]*:START[^\n]*:END/);
    // Exactly one reference to the shared checker: the HELPER assignment.
    expect(code.match(/served-region-check\.mjs/g) ?? []).toHaveLength(1);
  });

  it.each(canaries)('%s canary gates on the VERDICT TOKEN, not the exit code', (_n, file) => {
    const code = stripComments(readFileSync(file, 'utf8'));
    expect(code).toContain('SERVED_REGION_VERDICT=');
    expect(code).toMatch(/case\s+"\$VERDICT"/);
    // Every branch of the case must terminate with an explicit exit; none may be a silent 0.
    for (const want of ['exit 0', 'exit 1', 'exit 3']) expect(code).toContain(want);
  });

  it.each(canaries)('%s canary keeps the POSITIONAL send_telegram form and the W{NEXT} template', (_n, file) => {
    const code = stripComments(readFileSync(file, 'utf8'));
    expect(code).toMatch(/"\$SEND"\s+"\$ALERT_ID"\s+CRITICAL_PERSISTENT\s+-/);
    expect(code).toMatch(/OPS-[A-Z-]+-W\{NEXT\}/);
    // A literal wave number here would be a hardcoded recommended_wave (forbidden).
    expect(code).not.toMatch(/Recommended wave:\s*OPS-[A-Z-]+-W\d+/);
  });

  it.each(canaries)('%s canary escalates an unusable guard instead of exiting 0', (_n, file) => {
    const code = stripComments(readFileSync(file, 'utf8'));
    expect(code).toContain('INDETERMINATE: shared checker unreadable');
    expect(code).toMatch(/if \[ ! -r "\$HELPER" \]/);
  });
});

// ── 6. inventory ─────────────────────────────────────────────────────────────────────────
describe('monitoring inventory rows', () => {
  const inv = JSON.parse(readFileSync(INVENTORY, 'utf8'));
  const rows: any[] = [];
  (function walk(n: any) {
    if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === 'object') {
      if (typeof n.artifact === 'string') rows.push(n);
      Object.values(n).forEach(walk);
    }
  })(inv);
  const byArtifact = (a: string) => rows.find((r) => r.artifact === a);
  const rule = JSON.parse(readFileSync(resolve(ROOT, 'ops/monitoring/schedule-boundary-rule.json'), 'utf8'));

  const targets = [
    'ops/cron/nav-drift-canary.sh',
    'ops/cron/analytics-drift-canary.sh',
    HELPER_REL,
  ];

  it.each(targets)('%s has a row whose sha256 matches the committed bytes', (artifact) => {
    const row = byArtifact(artifact);
    expect(row, `no inventory row for ${artifact}`).toBeTruthy();
    const actual = createHash('sha256').update(readFileSync(resolve(ROOT, artifact))).digest('hex');
    expect(row.sha256).toBe(actual);
  });

  it.each(targets)('%s is installed, with no stale pending_since', (artifact) => {
    const row = byArtifact(artifact);
    expect(row.install_state).toBe('installed');
    expect(row.pending_since ?? null).toBeNull();
  });

  it.each(['ops/cron/nav-drift-canary.sh', 'ops/cron/analytics-drift-canary.sh'])(
    '%s declares an installed_at registry (the installer refuses a row without one)',
    (artifact) => {
      const row = byArtifact(artifact);
      expect(Array.isArray(row.installed_at)).toBe(true);
      expect(row.installed_at.length).toBeGreaterThan(0);
      for (const e of row.installed_at) {
        expect(typeof e.host).toBe('string');
        expect(typeof e.path).toBe('string');
      }
    },
  );

  it.each(['ops/cron/nav-drift-canary.sh', 'ops/cron/analytics-drift-canary.sh'])(
    '%s schedule satisfies the off-:00 boundary rule',
    (artifact) => {
      const row = byArtifact(artifact);
      const minutes = String(row.schedule).split(/\s+/)[0].split(',').flatMap((m: string) => {
        expect(m).toMatch(/^\d+$/); // these two are single-minute schedules by design
        return [Number(m)];
      });
      for (const m of minutes) {
        // offset = distance to the NEAREST :00 in BOTH directions (the rule's own semantics)
        expect(Math.min(m, 60 - m)).toBeGreaterThanOrEqual(rule.min_offset_minutes);
      }
    },
  );

  /**
   * Assert the note CORRECTS the false claim — not that the words are absent.
   *
   * A first draft asserted /swallows rc=1/ was gone and failed, correctly: the rewritten note
   * QUOTES the old claim in order to invert it, which is the whole point of a correction. An
   * absence test would have forced deleting the correction to satisfy the test — the same defect
   * as a ban-grep that fires on its own explanatory docblock.
   */
  /**
   * Generator-level, not lane-level: this wave's own new row shipped WITHOUT `repo_resident` and
   * was the only checkout-resident row missing it. `check_hash_drift` skips such rows on purpose
   * — on the host, host_path IS the repo copy, so both sides of that comparison come from one
   * checkout and reporting them in-sync is (its own docstring) "a lie by construction". Asserting
   * it here makes the omission unwritable rather than merely noticed once.
   */
  it('every checkout-resident row declares repo_resident (HASH_DRIFT would otherwise lie)', () => {
    const offenders = rows
      .filter((r) => String(r.host_path ?? '').startsWith('/opt/crypto-quant-signal-mcp'))
      .filter((r) => r.repo_resident !== true)
      .map((r) => `${r.id} (${r.host_path})`);
    expect(offenders).toEqual([]);
  });

  it('the corrected notes record the inversion rather than repeating the false claim', () => {
    for (const a of ['ops/cron/nav-drift-canary.sh', 'ops/cron/analytics-drift-canary.sh']) {
      const notes = String(byArtifact(a).notes ?? '');
      expect(notes.length).toBeGreaterThan(0);
      // The correction must be explicit …
      expect(notes).toMatch(/INVERTED/);
      expect(notes).toMatch(/EXCEPT rc=1/);
      // … and must name the deeper served-vs-built defect the invocation fix alone could not reach.
      expect(notes).toMatch(/\/var\/www\/algovault/);
      expect(notes).toContain('served-region-check.mjs');
      // The stale UNBLOCK/FOLLOW-UP debt markers must be gone — this wave IS the follow-up.
      expect(notes).not.toMatch(/UNBLOCK:/);
      expect(notes).not.toMatch(/FOLLOW-UP:\s*OPS-DRIFT-CANARY-INVOCATION-FIX/);
      expect(notes).not.toMatch(/BLOCKED, not neglected/);
    }
  });
});

// ── 7. the docker transport's argv (the seam no hermetic case executes) ──────────────────
describe('canonical render transport', () => {
  it('builds the venue-slo-tiers-shaped docker argv', () => {
    expect(buildCanonicalDockerArgv('ctr', 'lib/site-nav.js', 'renderSiteNav')).toEqual([
      'exec', 'ctr', 'node', '-e',
      'process.stdout.write(require("/app/dist/lib/site-nav.js").renderSiteNav())',
    ]);
  });

  it('each region points at its own compiled module + render fn (one derivation, two configs)', () => {
    expect(REGIONS.nav.distModule).toBe('lib/site-nav.js');
    expect(REGIONS.nav.renderFn).toBe('renderSiteNav');
    expect(REGIONS.analytics.distModule).toBe('lib/analytics-snippet.js');
    expect(REGIONS.analytics.renderFn).toBe('renderAnalyticsSnippet');
    expect(REGIONS.nav.start).toBe(NAV_START);
    expect(REGIONS.analytics.start).toBe(ANALYTICS_START);
  });
});
