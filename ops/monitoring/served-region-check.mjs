#!/usr/bin/env node
// ops/monitoring/served-region-check.mjs — OPS-DRIFT-CANARY-INVOCATION-FIX-W1
//
// THE ONE served-page region checker. Consumed by ops/cron/nav-drift-canary.sh and
// ops/cron/analytics-drift-canary.sh; a third region canary gets this shape for free.
//
// ── WHY THIS EXISTS (the defect class it retires) ────────────────────────────────────────
// Both drift canaries ran `docker exec <app-ctr> node scripts/build_X.mjs --check`. That is
// "inspect the BUILT artifact when the stated subject is the SERVED artifact", and it fails
// three ways at once:
//
//   1. The image ships no `scripts/build_nav.mjs` (measured 2026-08-12: /app/scripts/ holds
//      exactly fetchers/, funnel-by-channel.mjs, refresh-knowledge-pages.mjs).
//   2. Even a working in-container run inspects /app — but Caddy serves the landing pages from
//      the HOST webroot /var/www/algovault, so it would read the wrong bytes.
//   3. 10 of the 36 nav pages are not in the image at all, so they were structurally uncheckable.
//
// And the recorded root cause was INVERTED. `nav-drift-canary.sh:41` read `[ "$RC" -ne 1 ]`,
// which swallows everything EXCEPT rc=1 — while node's MODULE_NOT_FOUND throw exits exactly 1.
// Measured on signal-1 2026-08-12 under ALGOVAULT_TG_TEST_INERT=1: the canary reached its DRIFT
// branch and called send_telegram.sh, logging
//   `DRIFT: served nav region out of sync with the model. … Cannot find module '/app/scripts/build_nav.mjs'`
// So installing it would not have been a dark guard — it would have FALSE-PAGED every week with a
// body blaming "a host-side manual edit of the deployed HTML". The inventory note said the
// opposite; it is corrected in the same commit as this file.
//
// The fix is the shape the sibling docs-drift-canary already proved: FETCH THE SERVED PAGE.
//
// ── WHAT IT GUARDS ───────────────────────────────────────────────────────────────────────
// The unique coverage is post-deploy mutation of the webroot, which is NOT hypothetical:
// ops/cron/snapshot-landing-daily.sh:124 runs `cp landing/*.html /var/www/algovault/` daily at
// 00:39 UTC. CI already covers the git-resident path three times over (deploy.yml,
// prepublishOnly, tests/build-nav.test.ts), so this canary adds nothing there and everything here.
//
// ── SINGLE DERIVATION (the load-bearing property) ────────────────────────────────────────
// The canonical region comes from ONE function — renderSiteNav() / renderAnalyticsSnippet() —
// reached over one of two TRANSPORTS, never re-implemented:
//   * host  : require($REPO/dist/lib/<mod>.js)              — preferred when usable
//   * docker: docker exec <ctr> node -e require(/app/dist/lib/<mod>.js)  (the shape at
//             ops/monitoring/venue-slo-tiers-drift-canary.sh:29)
// Measured 2026-08-12: the host checkout's dist/ is a STALE April 10 artifact and carries no
// dist/lib/site-nav.js at all, so the docker transport is what actually runs on signal-1. The
// chosen transport is printed on every run — never assumed.
//
// The page set is DERIVED from the repo's marker-bearing files, never a hardcoded array: a
// hand-maintained page list is the stale-count class this repo has laws against.
//
// ── CONTRACT ─────────────────────────────────────────────────────────────────────────────
// Exactly one terminal SERVED_REGION_VERDICT=PASS|FAIL|INDETERMINATE line. Callers gate on the
// TOKEN, never the exit code.
//   0 = PASS           every served region matches the canonical render
//   1 = FAIL           >=1 drifted or missing-marker served page
//   3 = INDETERMINATE  could not render, could not fetch, or checked zero pages
// 3 is the token-law default for a NEW gate (matches ops/scripts/install-monitoring-artifact.sh).
//
//   node ops/monitoring/served-region-check.mjs --region=nav
//   node ops/monitoring/served-region-check.mjs --region=analytics
//   node ops/monitoring/served-region-check.mjs --self-test
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';

// Single-derivation: markers + the desktop signature + the recursive lister are IMPORTED from the
// injectors that own them. Re-declaring any of these here would be a second source of truth.
import { NAV_START, NAV_END, DESKTOP_SIG, listHtml } from '../../scripts/build_nav.mjs';
import { ANALYTICS_START, ANALYTICS_END, isExcluded } from '../../scripts/build_analytics.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '..', '..');
export const VERDICT_KEY = 'SERVED_REGION_VERDICT';
export const EXIT = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };

/**
 * The two region configurations. `shouldCarry` mirrors each injector's OWN coverage law:
 *  - nav       (build_nav.mjs:81-84)  marked, or carrying the desktop signature (the escape hatch)
 *  - analytics (build_analytics.mjs:88-90) TOTAL coverage — every non-excluded content page
 */
export const REGIONS = {
  nav: {
    start: NAV_START,
    end: NAV_END,
    distModule: 'lib/site-nav.js',
    renderFn: 'renderSiteNav',
    shouldCarry: (html, relFromLanding) =>
      !isExcluded(relFromLanding) && (html.includes(NAV_START) || html.includes(DESKTOP_SIG)),
  },
  analytics: {
    start: ANALYTICS_START,
    end: ANALYTICS_END,
    distModule: 'lib/analytics-snippet.js',
    renderFn: 'renderAnalyticsSnippet',
    shouldCarry: (_html, relFromLanding) => !isExcluded(relFromLanding),
  },
};

/**
 * Map a landing-relative path to its served URL.
 * `x.html` -> `/x`; `a/b.html` -> `/a/b`; `index.html` -> `/`; `a/index.html` -> `/a`.
 * Validated 2026-08-12 at 90/90 HTTP 200 across both regions' full derived sets.
 */
export function urlForPage(relFromLanding, origin = 'https://algovault.com') {
  let p = relFromLanding.split(path.sep).join('/').replace(/\.html$/, '');
  if (p === 'index') return `${origin}/`;
  p = p.replace(/\/index$/, '');
  return `${origin}/${p}`;
}

/**
 * Extract the region between the markers, undoing exactly what applyRegion() writes:
 *   START + "\n" + region + "\n" + END
 * so `inner` is directly comparable to the canonical render.
 */
export function extractRegion(html, start, end) {
  const s = html.indexOf(start);
  const e = html.indexOf(end);
  if (s === -1 || e === -1 || e < s) return { marked: false, inner: null };
  let inner = html.slice(s + start.length, e);
  if (inner.startsWith('\n')) inner = inner.slice(1);
  if (inner.endsWith('\n')) inner = inner.slice(0, -1);
  return { marked: true, inner };
}

/**
 * The page set the repo says MUST carry this region. Derived — never an array literal.
 *
 * `origin` is threaded through rather than defaulted here: stamping the default origin at
 * derivation time made the caller's `origin` option a SILENT NO-OP (runCheck's `p.url ?? …` found
 * a url already present and never recomputed it). That is the "a flag that quietly does nothing
 * is worse than no flag" class, and it is not cosmetic — it made the force-fire smoke pass
 * vacuously against a deliberately wrong origin, i.e. it defeated the one check that proves this
 * guard can fire at all. Found 2026-08-12 by running that smoke on the host.
 */
export function derivePageSet(regionName, root = REPO_ROOT, origin = 'https://algovault.com') {
  const cfg = REGIONS[regionName];
  if (!cfg) throw new Error(`unknown region ${regionName}`);
  const landing = path.join(root, 'landing');
  const out = [];
  for (const file of listHtml(landing)) {
    const relFromLanding = path.relative(landing, file);
    const html = fs.readFileSync(file, 'utf8');
    if (!cfg.shouldCarry(html, relFromLanding)) continue;
    out.push({ rel: path.relative(root, file), relFromLanding, url: urlForPage(relFromLanding, origin) });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * The docker transport's argv, as a pure function so the self-test can assert its SHAPE without a
 * daemon — the seam a hermetic suite would otherwise be blind to.
 */
export function buildCanonicalDockerArgv(container, distModule, renderFn) {
  const abs = `/app/dist/${distModule}`;
  return ['exec', container, 'node', '-e', `process.stdout.write(require(${JSON.stringify(abs)}).${renderFn}())`];
}

const execFileAsync = (cmd, args, opts) =>
  new Promise((resolve) =>
    execFile(cmd, args, opts, (err, stdout, stderr) =>
      resolve({ err, stdout: stdout ?? '', stderr: stderr ?? '' }),
    ),
  );

/**
 * Resolve the canonical region from the ONE render function. Host transport first (cheaper, no
 * daemon), docker second. Returns { region, transport } or { error }.
 */
export async function resolveCanonical(regionName, opts = {}) {
  const cfg = REGIONS[regionName];
  const { root = REPO_ROOT, container = 'crypto-quant-signal-mcp-mcp-server-1', dockerBin = 'docker' } = opts;

  const hostMod = path.join(root, 'dist', cfg.distModule);
  if (fs.existsSync(hostMod)) {
    try {
      const require = createRequire(import.meta.url);
      const mod = require(hostMod);
      const region = mod[cfg.renderFn]();
      if (typeof region === 'string' && region.length > 0) return { region, transport: `host-dist:${hostMod}` };
    } catch {
      /* fall through to docker — a stale or partial host dist/ must never be fatal */
    }
  }

  const argv = buildCanonicalDockerArgv(container, cfg.distModule, cfg.renderFn);
  const { err, stdout } = await execFileAsync(dockerBin, argv, { maxBuffer: 8 * 1024 * 1024, timeout: 30_000 });
  if (err || !stdout) {
    return { error: `canonical render unavailable (host dist/ unusable; docker exec failed: ${err?.message ?? 'empty output'})` };
  }
  return { region: stdout, transport: `docker-exec:${container}` };
}

/** Fetch with bounded retries. Returns { html } or { error }. */
async function fetchPage(url, { fetchImpl = fetch, retries = 2, timeoutMs = 20_000 } = {}) {
  let last = 'unknown';
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetchImpl(url, {
        redirect: 'follow',
        headers: { 'user-agent': 'algovault-served-region-canary' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        last = `HTTP ${res.status}`;
      } else {
        const html = await res.text();
        if (html && html.length > 0) return { html };
        last = 'empty body';
      }
    } catch (e) {
      last = e?.message ?? String(e);
    }
    if (i < retries) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  return { error: last };
}

/**
 * Run the check. Pure-ish: every external edge (fetch, canonical resolution) is injectable so the
 * suite can drive the failure branches, and the artifacts those seams bypass (URL derivation,
 * region extraction, docker argv) are asserted separately in --self-test.
 */
export async function runCheck(opts = {}) {
  const {
    region: regionName = 'nav',
    root = REPO_ROOT,
    origin = 'https://algovault.com',
    fetchImpl = fetch,
    canonicalResolver = resolveCanonical,
    concurrency = 6,
    pages: injectedPages,
  } = opts;

  const cfg = REGIONS[regionName];
  if (!cfg) return { verdict: 'INDETERMINATE', reason: `unknown region '${regionName}'`, pagesChecked: 0, pagesExpected: 0, drifted: [], missingMarker: [], fetchFailed: [], transport: 'none' };

  const pages = (injectedPages ?? derivePageSet(regionName, root, origin)).map((p) => ({
    ...p,
    url: p.url ?? urlForPage(p.relFromLanding, origin),
  }));
  const pagesExpected = pages.length;

  // Vacuity: the landing tree is a corpus WE construct, so an empty derived set means the
  // derivation broke (wrong root / wrong marker) — we were supposed to fill it. That is vacuity,
  // and it REFUSES. (Contrast the runtime-corpus case, where empty is a fact implying PASS.)
  if (pagesExpected === 0) {
    return { verdict: 'INDETERMINATE', reason: `derived page set is EMPTY for region '${regionName}' under ${root} — the derivation, not the site, is broken`, pagesChecked: 0, pagesExpected: 0, drifted: [], missingMarker: [], fetchFailed: [], transport: 'none' };
  }

  const canon = await canonicalResolver(regionName, opts);
  if (canon.error) {
    return { verdict: 'INDETERMINATE', reason: canon.error, pagesChecked: 0, pagesExpected, drifted: [], missingMarker: [], fetchFailed: [], transport: 'none' };
  }

  const drifted = [];
  const missingMarker = [];
  const fetchFailed = [];
  let checked = 0;

  const queue = [...pages];
  const worker = async () => {
    for (;;) {
      const page = queue.shift();
      if (!page) return;
      const got = await fetchPage(page.url, { fetchImpl });
      if (got.error) {
        fetchFailed.push(`${page.url} (${got.error})`);
        continue;
      }
      checked++;
      const { marked, inner } = extractRegion(got.html, cfg.start, cfg.end);
      if (!marked) missingMarker.push(page.url);
      else if (inner !== canon.region) drifted.push(page.url);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, pages.length)) }, worker));

  // A fetch failure means we did not observe what we were sent to observe. Never a clean pass —
  // and never a silent one either: the count below makes a partial run visibly partial.
  let verdict;
  let reason;
  if (fetchFailed.length > 0) {
    verdict = 'INDETERMINATE';
    reason = `${fetchFailed.length} page(s) unfetchable: ${fetchFailed.slice(0, 3).join('; ')}`;
  } else if (checked === 0) {
    verdict = 'INDETERMINATE';
    reason = 'checked zero pages';
  } else if (drifted.length > 0 || missingMarker.length > 0) {
    verdict = 'FAIL';
    reason = `${drifted.length} drifted, ${missingMarker.length} missing-marker`;
  } else {
    verdict = 'PASS';
    reason = 'every served region matches the canonical render';
  }

  return { verdict, reason, pagesChecked: checked, pagesExpected, drifted, missingMarker, fetchFailed, transport: canon.transport };
}

/** Render the positive per-run line. A count of pages checked is MANDATORY: a run that silently
 *  checked zero must never read identically to a clean one. */
export function formatSummary(regionName, r) {
  return (
    `region=${regionName} pages_checked=${r.pagesChecked}/${r.pagesExpected} ` +
    `drifted=${r.drifted.length} missing_marker=${r.missingMarker.length} ` +
    `fetch_failed=${r.fetchFailed.length} render_path=${r.transport} — ${r.reason}`
  );
}

// ── self-test ────────────────────────────────────────────────────────────────────────────
export async function selfTest(log = console.log) {
  let checks = 0;
  let failures = 0;
  // Wrapped so a broken subject REPORTS rather than aborting the suite: an assertion that raises
  // is not an assertion.
  const ck = (name, actual, expected) => {
    checks++;
    let ok;
    try {
      ok = JSON.stringify(actual) === JSON.stringify(expected);
    } catch {
      ok = false;
    }
    if (!ok) {
      failures++;
      log(`  ✗ ${name}: got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
    }
  };

  // — URL derivation (a seam-bypassed artifact: no scenario below fetches a real URL) —
  ck('url index -> /', urlForPage('index.html'), 'https://algovault.com/');
  ck('url top-level', urlForPage('verify.html'), 'https://algovault.com/verify');
  ck('url nested', urlForPage('integrations/binance.html'), 'https://algovault.com/integrations/binance');
  ck('url nested index', urlForPage('foo/index.html'), 'https://algovault.com/foo');

  // — region extraction, incl. applyRegion's newline convention —
  ck('extract strips applyRegion newlines', extractRegion(`a${NAV_START}\nBODY\n${NAV_END}b`, NAV_START, NAV_END), { marked: true, inner: 'BODY' });
  ck('extract unmarked', extractRegion('no markers here', NAV_START, NAV_END), { marked: false, inner: null });
  ck('extract inverted markers', extractRegion(`${NAV_END}x${NAV_START}`, NAV_START, NAV_END), { marked: false, inner: null });

  // — docker argv shape (the transport no hermetic scenario executes) —
  ck('docker argv', buildCanonicalDockerArgv('ctr', 'lib/site-nav.js', 'renderSiteNav'), [
    'exec', 'ctr', 'node', '-e',
    'process.stdout.write(require("/app/dist/lib/site-nav.js").renderSiteNav())',
  ]);

  // — the derived page set is real, non-empty, and NOT a literal —
  const navPages = derivePageSet('nav');
  const anaPages = derivePageSet('analytics');
  ck('nav page set non-empty', navPages.length > 0, true);
  ck('analytics page set non-empty', anaPages.length > 0, true);
  ck('analytics set is a superset of nav', navPages.every((p) => anaPages.some((q) => q.rel === p.rel)), true);
  // The origin override must REACH the derived urls. It did not once, which made the force-fire
  // smoke pass against a deliberately wrong origin — a dead flag defeating the fire-proof itself.
  ck(
    'origin override reaches the derived set (not a dead flag)',
    derivePageSet('nav', REPO_ROOT, 'https://example.test').every((p) => p.url.startsWith('https://example.test/')),
    true,
  );

  const canonical = 'CANON';
  const okHtml = `<html>${NAV_START}\n${canonical}\n${NAV_END}</html>`;
  const stubPages = [
    { rel: 'landing/a.html', relFromLanding: 'a.html', url: 'https://x/a' },
    { rel: 'landing/b.html', relFromLanding: 'b.html', url: 'https://x/b' },
  ];
  const stubCanon = async () => ({ region: canonical, transport: 'self-test' });
  const mkFetch = (map) => async (url) => {
    const body = map[url];
    if (body === undefined) throw new Error('injected network failure');
    return { ok: true, status: 200, text: async () => body };
  };

  // — must-PASS —
  let r = await runCheck({ region: 'nav', pages: stubPages, canonicalResolver: stubCanon, fetchImpl: mkFetch({ 'https://x/a': okHtml, 'https://x/b': okHtml }) });
  ck('clean run PASS', [r.verdict, r.pagesChecked], ['PASS', 2]);

  // — must-FAIL: drifted vs missingMarker stay DISTINCT (collapsing them loses the signal) —
  const drift = `<html>${NAV_START}\nOTHER\n${NAV_END}</html>`;
  r = await runCheck({ region: 'nav', pages: stubPages, canonicalResolver: stubCanon, fetchImpl: mkFetch({ 'https://x/a': okHtml, 'https://x/b': drift }) });
  ck('drift => FAIL, counted as drifted only', [r.verdict, r.drifted.length, r.missingMarker.length], ['FAIL', 1, 0]);

  r = await runCheck({ region: 'nav', pages: stubPages, canonicalResolver: stubCanon, fetchImpl: mkFetch({ 'https://x/a': okHtml, 'https://x/b': '<html>markers deleted</html>' }) });
  ck('missing marker => FAIL, counted as missingMarker only', [r.verdict, r.drifted.length, r.missingMarker.length], ['FAIL', 0, 1]);

  // — must-INDETERMINATE —
  r = await runCheck({ region: 'nav', pages: stubPages, canonicalResolver: stubCanon, fetchImpl: mkFetch({ 'https://x/a': okHtml }), });
  ck('fetch failure => INDETERMINATE, never PASS', [r.verdict, r.fetchFailed.length], ['INDETERMINATE', 1]);

  r = await runCheck({ region: 'nav', pages: [], canonicalResolver: stubCanon, fetchImpl: mkFetch({}) });
  ck('zero pages => INDETERMINATE, never PASS', [r.verdict, r.pagesChecked], ['INDETERMINATE', 0]);

  r = await runCheck({ region: 'nav', pages: stubPages, canonicalResolver: async () => ({ error: 'no render' }), fetchImpl: mkFetch({}) });
  ck('canonical unavailable => INDETERMINATE', r.verdict, 'INDETERMINATE');

  // — the token -> exit-code MAPPING itself (re-coding it must not stay green) —
  ck('exit mapping', [EXIT.PASS, EXIT.FAIL, EXIT.INDETERMINATE], [0, 1, 3]);

  // — the summary always carries a page count —
  ck('summary carries pages_checked', /pages_checked=\d+\/\d+/.test(formatSummary('nav', r)), true);

  if (failures > 0) {
    log(`SELF-TEST: FAIL (${failures} of ${checks})`);
    return { ok: false, checks, failures };
  }
  log(`✓ served-region-check self-test: ${checks} checks passed (url derivation, region extraction, docker argv, derived page sets, PASS/FAIL/INDETERMINATE branches, token→exit mapping)`);
  return { ok: true, checks, failures };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const argv = process.argv.slice(2);
  const emit = (verdict, line) => {
    console.log(line);
    console.log(`${VERDICT_KEY}=${verdict}`); // exactly one terminal token line
    process.exit(EXIT[verdict]);
  };

  if (argv.includes('--self-test')) {
    const { ok, checks, failures } = await selfTest();
    emit(ok ? 'PASS' : 'FAIL', `self-test checks=${checks} failures=${failures}`);
  }

  const regionArg = (argv.find((a) => a.startsWith('--region=')) || '').split('=')[1];
  if (!regionArg || !REGIONS[regionArg]) {
    emit('INDETERMINATE', `usage: served-region-check.mjs --region=${Object.keys(REGIONS).join('|')} [--self-test]`);
  }

  let result;
  try {
    result = await runCheck({
      region: regionArg,
      root: process.env.SERVED_REGION_REPO || REPO_ROOT,
      origin: process.env.SERVED_REGION_ORIGIN || 'https://algovault.com',
      container: process.env.SERVED_REGION_APP_CTR || 'crypto-quant-signal-mcp-mcp-server-1',
    });
  } catch (e) {
    // Process death with no token is the ONE outcome the token law forbids.
    emit('INDETERMINATE', `unhandled error: ${e?.message ?? String(e)}`);
  }

  const summary = formatSummary(regionArg, result);
  const detail = [
    result.drifted.length ? `  drifted:\n    ${result.drifted.join('\n    ')}` : '',
    result.missingMarker.length ? `  missing markers:\n    ${result.missingMarker.join('\n    ')}` : '',
    result.fetchFailed.length ? `  unfetchable:\n    ${result.fetchFailed.join('\n    ')}` : '',
  ].filter(Boolean).join('\n');
  emit(result.verdict, detail ? `${summary}\n${detail}` : summary);
}
