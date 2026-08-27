#!/usr/bin/env node
/**
 * check-external-origin-csp.mjs — SEO-SITE-NAME-AND-PREFERRED-SOURCES-W1 R3.
 *
 * Asserts, in both directions, that the CSP served to the static landing surfaces and the
 * external origins those surfaces actually reference are the same set:
 *
 *   FORWARD  every external `<script src>`, `<iframe src>` and `<link rel=stylesheet href>` in
 *            landing/**\/*.html is permitted by the directive that governs it (with the
 *            browser's real fallback chain to default-src);
 *   REVERSE  every external origin the CSP names in a scanned directive is referenced by
 *            something in that corpus — or is a DECLARED exemption with a reason.
 *
 * ── WHY THIS CLASS NEEDS A GATE ─────────────────────────────────────────────
 * A CSP refusal is SILENT. Google's Add-to-Preferred-Sources button is an iframe minted by
 * news.google.com/swg/js/v1/publisher.js; under the policy that shipped before this wave the
 * script was refused by script-src, the iframes fell back to default-src 'self', and the flow
 * XHR was refused by connect-src. The button did not degrade — it did not render AT ALL, with a
 * perfectly green HTML diff. That is the same shape as the /account white-page defect that
 * produced check-token-resolution.mjs: every "is it defined somewhere" question answers yes and
 * the page is still broken, because the policy it serves itself with refuses the load.
 *
 * The reverse direction is the other half of the same fact and is what keeps the policy honest:
 * an origin allowed for an embed we have since deleted is threat surface bought for nothing.
 *
 * ── SINGLE DERIVATION ───────────────────────────────────────────────────────
 * `parseCsp` is IMPORTED from scripts/check-token-resolution.mjs, not reimplemented. Two CSP
 * parsers in one repo is a divergence waiting to happen, and that file is another wave's gate —
 * this one only reads its export and changes nothing about it.
 *
 * ── WHY THE DEFAULT MODE IS STATIC ──────────────────────────────────────────
 * The deploy lane must be deterministic and network-free, like every other canary wired into
 * deploy.yml. The default mode reads the CSP from the committed Caddyfile — which IS the source
 * of truth for what the apex serves — and scans the committed corpus. `--live` adds the leg that
 * needs the network: fetch the served header and assert it equals the committed one. That is the
 * repo's established split (check-feature-registry-drift, check-rank-metrics-parity and
 * check-scan-digest-parity all run STATIC in deploy.yml with a LIVE half on a host cron), and it
 * is why a wobbly network can never block a deploy here.
 *
 * ── WHY THE CADDYFILE AND NOT src/index.ts ──────────────────────────────────
 * There are TWO policies in this repo. The Express middleware at src/index.ts serves the
 * function-rendered pages and is already modelled by check-token-resolution.mjs. The Caddyfile
 * `algovault.com { handle { … } }` block serves every static landing page — Express never touches
 * those responses. This gate owns the second one; nothing owned it before.
 *
 *   node scripts/check-external-origin-csp.mjs             # gate (static, network-free)
 *   node scripts/check-external-origin-csp.mjs --live      # + assert the served header matches
 *   node scripts/check-external-origin-csp.mjs --self-test # two-way, vacuity-guarded
 *
 * Codes: 0=OK / 1=DRIFT / 3=INDETERMINATE (the token-law default for a NEW gate).
 * Callers gate on EXTERNAL_ORIGIN_CSP_VERDICT, never on the exit code alone.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { parseCsp } from './check-token-resolution.mjs';

const REPO_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const TOKEN = 'EXTERNAL_ORIGIN_CSP_VERDICT';
const CODES = { OK: 0, DRIFT: 1, INDETERMINATE: 3 };
const PAGE_ORIGIN = 'https://algovault.com';
const LIVE_URL = 'https://algovault.com/';

function verdict(v, lines = []) {
  for (const l of lines) console.log(l);
  console.log(`${TOKEN}=${v}`);
  return CODES[v];
}

// ─────────────────────────── CSP extraction (Caddyfile) ───────────────────────────

/**
 * Pull the apex static policy out of the Caddyfile. Anchored on the directive name plus a
 * double-quoted literal, the same shape check-token-resolution.mjs uses for src/index.ts —
 * and, like that one, it must never scrape a quoted phrase out of a COMMENT, so comment lines
 * are dropped before the search. Returns null when it cannot find exactly one.
 */
export function extractCaddyCsp(caddySrc) {
  const code = String(caddySrc)
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  const hits = [...code.matchAll(/header\s+Content-Security-Policy\s+"([^"]+)"/g)].map((m) => m[1]);
  return hits.length === 1 ? hits[0] : null;
}

// ─────────────────────────── CSP evaluation (generalised) ───────────────────────────

/**
 * The fallback chain a browser really walks, per element kind. `-elem` first because that is
 * what actually governs a <script>/<link> element when present; then the base directive; then
 * default-src. frame-src falls back to child-src before default-src.
 */
const CHAIN = {
  script: ['script-src-elem', 'script-src', 'default-src'],
  frame: ['frame-src', 'child-src', 'default-src'],
  style: ['style-src-elem', 'style-src', 'default-src'],
};

export function cspAllowsUrl(csp, targetUrl, kind, pageOrigin = PAGE_ORIGIN) {
  const chainKey = CHAIN[kind];
  if (!chainKey) return { allowed: false, why: `unknown element kind ${kind}`, directive: null };
  let directive = null;
  let sources = null;
  for (const d of chainKey) {
    if (csp[d]) { directive = d; sources = csp[d]; break; }
  }
  if (sources === null) return { allowed: true, why: 'no governing directive — unrestricted', directive: null };

  let target;
  try { target = new URL(targetUrl, pageOrigin); } catch {
    return { allowed: false, why: `unparseable URL ${targetUrl}`, directive };
  }
  const isSelf = target.origin === new URL(pageOrigin).origin;
  for (const raw of sources) {
    const s = raw.replace(/^'|'$/g, '');
    if (s === 'self' && isSelf) return { allowed: true, why: `'self'`, directive };
    if (s === '*') return { allowed: true, why: 'wildcard', directive };
    if (s.startsWith('http')) {
      try { if (new URL(s).origin === target.origin) return { allowed: true, why: `explicit ${s}`, directive }; }
      catch { /* not an origin token */ }
    }
  }
  return { allowed: false, why: `${target.origin} not in ${directive}`, directive };
}

// ─────────────────────────── corpus ───────────────────────────

/** Every .html under landing/, recursively. */
export function listLandingHtml(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.html')) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

/**
 * External (absolute http/https, non-self) subresource references in one page.
 * `<link>` counts ONLY as rel=stylesheet: preconnect/dns-prefetch/preload/icon are hints or
 * other directives, and treating a preconnect as a style load would manufacture DRIFT on a
 * healthy page. That distinction is measured, not assumed — the landing head carries two
 * fonts preconnects beside the one real stylesheet link.
 */
export function extractExternalRefs(html, file) {
  const refs = [];
  const push = (kind, src) => {
    if (!/^https?:\/\//i.test(src)) return;
    try { if (new URL(src).origin === new URL(PAGE_ORIGIN).origin) return; } catch { return; }
    refs.push({ kind, src, file });
  };
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) push('script', m[1]);
  for (const m of html.matchAll(/<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) push('frame', m[1]);
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\brel\s*=\s*["']?stylesheet\b/i.test(tag)) continue;
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (href) push('style', href[1]);
  }
  return refs;
}

/** Origins a directive names, minus keywords and schemes. */
export function directiveOrigins(sources = []) {
  const out = [];
  for (const raw of sources) {
    const s = raw.replace(/^'|'$/g, '');
    if (!s.startsWith('http')) continue;
    try { out.push(new URL(s).origin); } catch { /* not an origin */ }
  }
  return out;
}

// ─────────────────────────── the gate ───────────────────────────

function runCheck({ repoRoot = REPO_ROOT, live = false } = {}) {
  const findings = [];
  let cfg;
  let caddy;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'ops/external-origin-csp-config.json'), 'utf8'));
    caddy = fs.readFileSync(path.join(repoRoot, 'Caddyfile'), 'utf8');
  } catch (e) {
    return { status: 'INDETERMINATE', findings: [`could not read the Caddyfile or the config: ${e.message}`] };
  }
  const header = extractCaddyCsp(caddy);
  if (!header) {
    return { status: 'INDETERMINATE', findings: ['could not extract exactly one Content-Security-Policy from the Caddyfile'] };
  }
  const csp = parseCsp(header);

  let files;
  try { files = listLandingHtml(path.join(repoRoot, 'landing')); }
  catch (e) { return { status: 'INDETERMINATE', findings: [`could not read the landing corpus: ${e.message}`] }; }
  // Empty input we were HANDED is a fact; an empty corpus here means the walker broke, which is
  // a defect in the gate. Refuse rather than report a pass over nothing.
  if (files.length === 0) {
    return { status: 'INDETERMINATE', findings: ['landing/ produced zero HTML files — the corpus walker is broken'] };
  }

  // ── FORWARD ──
  let refCount = 0;
  const corpus = [];
  for (const f of files) {
    const html = fs.readFileSync(f, 'utf8');
    corpus.push(html);
    for (const ref of extractExternalRefs(html, path.relative(repoRoot, f))) {
      refCount++;
      const r = cspAllowsUrl(csp, ref.src, ref.kind);
      if (!r.allowed) {
        findings.push(`FORWARD ${ref.file}: <${ref.kind}> ${ref.src} — ${r.why}. It will be refused SILENTLY.`);
      }
    }
  }
  const corpusText = corpus.join('\n');

  // ── REVERSE ──
  const exempt = new Map((cfg.reverse_exemptions ?? []).map((r) => [`${r.directive} ${r.origin}`, r.reason]));
  let originCount = 0;
  for (const d of cfg.scanned_directives ?? []) {
    for (const origin of directiveOrigins(csp[d])) {
      originCount++;
      if (exempt.has(`${d} ${origin}`)) continue;
      if (!corpusText.includes(origin)) {
        findings.push(`REVERSE ${d} allows ${origin}, which nothing in landing/**/*.html references. Remove it, or declare it in ops/external-origin-csp-config.json with a reason.`);
      }
    }
  }
  if (refCount === 0 || originCount === 0) {
    return { status: 'INDETERMINATE', findings: [`vacuous run: ${refCount} external refs, ${originCount} CSP origins — the extractors are broken`] };
  }

  const lines = [
    `[external-origin-csp] ${files.length} page(s) · ${refCount} external subresource ref(s) · ${originCount} CSP origin(s) across ${(cfg.scanned_directives ?? []).join(', ')}`,
  ];
  return { status: findings.length ? 'DRIFT' : 'OK', findings, lines, header, live };
}

async function liveHeaderCheck(committedHeader) {
  let res;
  try { res = await fetch(LIVE_URL, { redirect: 'follow' }); }
  catch (e) { return { status: 'INDETERMINATE', why: `could not fetch ${LIVE_URL}: ${e.message}` }; }
  const served = res.headers.get('content-security-policy');
  if (!served) return { status: 'INDETERMINATE', why: `${LIVE_URL} served no Content-Security-Policy header` };
  if (served.trim() !== committedHeader.trim()) {
    return { status: 'DRIFT', why: `served header != committed Caddyfile.\n  served   : ${served}\n  committed: ${committedHeader}` };
  }
  return { status: 'OK', why: 'served header is byte-identical to the committed Caddyfile' };
}

// ─────────────────────────── self-test ───────────────────────────

const CADDY_OK = `
algovault.com {
    # a COMMENT containing "a quoted phrase" must never be scraped into the policy
    handle {
        header Content-Security-Policy "default-src 'self'; script-src 'self' https://cdn.example.com; frame-src 'self' https://embed.example.com; style-src 'self' https://fonts.googleapis.com; connect-src 'self'"
    }
}
`;
const PAGE_OK = `<html><head>
<script src="https://cdn.example.com/t.js"></script>
<link rel="preconnect" href="https://fonts.gstatic.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">
</head><body><iframe src="https://embed.example.com/w"></iframe></body></html>`;

function scenario(name, { caddy, pages, config }) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'eocsp-'));
  fs.writeFileSync(path.join(dir, 'Caddyfile'), caddy);
  fs.mkdirSync(path.join(dir, 'ops'));
  fs.writeFileSync(path.join(dir, 'ops/external-origin-csp-config.json'), JSON.stringify(config));
  fs.mkdirSync(path.join(dir, 'landing'));
  for (const [f, html] of Object.entries(pages)) {
    const p = path.join(dir, 'landing', f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, html);
  }
  const r = runCheck({ repoRoot: dir });
  fs.rmSync(dir, { recursive: true, force: true });
  return { name, ...r };
}

const BASE_CFG = {
  scanned_directives: ['script-src', 'frame-src', 'style-src', 'connect-src'],
  reverse_exemptions: [],
};

function selfTest() {
  const cases = [];
  const expect = (name, got, want) => cases.push({ name, got, want, ok: got === want });

  // must-PASS: the healthy shape
  expect('healthy corpus', scenario('ok', { caddy: CADDY_OK, pages: { 'a.html': PAGE_OK }, config: BASE_CFG }).status, 'OK');

  // must-REFUSE 1 — FORWARD: the shipped defect. A third-party embed the policy does not allow.
  expect(
    'forward: script origin missing from script-src',
    scenario('fwd', {
      caddy: CADDY_OK.replace(' https://cdn.example.com;', ';'),
      pages: { 'a.html': PAGE_OK },
      config: BASE_CFG,
    }).status,
    'DRIFT',
  );

  // must-REFUSE 2 — FORWARD: an iframe with NO frame-src declared falls back to default-src 'self'.
  // This is the exact trap the wave shipped against: declaring nothing is not declaring 'anything'.
  expect(
    'forward: iframe falls back to default-src self',
    scenario('fwd2', {
      caddy: CADDY_OK.replace(/frame-src[^;]*; /, ''),
      pages: { 'a.html': PAGE_OK },
      config: BASE_CFG,
    }).status,
    'DRIFT',
  );

  // must-REFUSE 3 — REVERSE: an origin allowed for an embed that no longer exists.
  expect(
    'reverse: allowed origin nothing references',
    scenario('rev', {
      caddy: CADDY_OK,
      pages: { 'a.html': PAGE_OK.replace(/<iframe[^>]*><\/iframe>/, '') },
      config: BASE_CFG,
    }).status,
    'DRIFT',
  );

  // must-PASS: the same removal, DECLARED with a reason, is not drift.
  expect(
    'reverse: declared exemption suppresses it',
    scenario('rev-ex', {
      caddy: CADDY_OK,
      pages: { 'a.html': PAGE_OK.replace(/<iframe[^>]*><\/iframe>/, '') },
      config: { ...BASE_CFG, reverse_exemptions: [{ directive: 'frame-src', origin: 'https://embed.example.com', reason: 'fixture' }] },
    }).status,
    'OK',
  );

  // must-PASS: a preconnect is a HINT, not a stylesheet load. Treating it as one would
  // manufacture DRIFT on the real landing head, which carries two fonts preconnects.
  expect(
    'preconnect is not a stylesheet load',
    scenario('pre', {
      caddy: CADDY_OK,
      pages: { 'a.html': PAGE_OK.replace('<link rel="preconnect" href="https://fonts.gstatic.com">', '<link rel="preconnect" href="https://never-allowed.example.com">') },
      config: BASE_CFG,
    }).status,
    'OK',
  );

  // must-REFUSE 4 — INDETERMINATE, not a pass: an unextractable policy.
  expect(
    'unextractable CSP is INDETERMINATE',
    scenario('indet', { caddy: 'algovault.com {\n  handle { file_server }\n}\n', pages: { 'a.html': PAGE_OK }, config: BASE_CFG }).status,
    'INDETERMINATE',
  );

  // must-REFUSE 5 — INDETERMINATE: an empty corpus is a broken walker, never a pass over nothing.
  //
  // ASSERT THE REASON, NOT JUST THE STATUS. Proving this suite could fail found that deleting
  // the zero-files guard outright left every scenario GREEN — the later `refCount === 0` vacuity
  // guard caught the same fixture and returned the same token, so the dedicated guard was
  // covered by nothing. Two guards for two different shapes (a walker that finds no files vs
  // extractors that find nothing in files that exist) need two distinguishable messages, and the
  // self-test has to read them or one of them is decoration.
  const emptyRun = scenario('empty', { caddy: CADDY_OK, pages: {}, config: BASE_CFG });
  expect('empty corpus is INDETERMINATE', emptyRun.status, 'INDETERMINATE');
  expect(
    'empty corpus blames the WALKER, not the extractors',
    /corpus walker is broken/.test(emptyRun.findings.join(' ')) ? 'yes' : `no: ${emptyRun.findings.join(' ')}`,
    'yes',
  );

  // must-REFUSE 6 — the OTHER vacuity shape: files exist, extractors find nothing in them.
  const inertRun = scenario('inert', { caddy: CADDY_OK, pages: { 'a.html': '<html><body>no subresources</body></html>' }, config: BASE_CFG });
  expect('a corpus with zero external refs is INDETERMINATE', inertRun.status, 'INDETERMINATE');
  expect(
    'zero-refs blames the EXTRACTORS, not the walker',
    /vacuous run/.test(inertRun.findings.join(' ')) ? 'yes' : `no: ${inertRun.findings.join(' ')}`,
    'yes',
  );

  // The comment-scraping trap check-token-resolution.mjs paid for: a double-quoted phrase in a
  // COMMENT must not reach the policy.
  expect(
    'comment quotes are not scraped into the policy',
    extractCaddyCsp(CADDY_OK)?.startsWith("default-src 'self'") ? 'OK' : 'DRIFT',
    'OK',
  );

  // Token -> exit-code mapping is asserted too. A self-test that checks only the token stays
  // green when the mapping is re-coded, which is how a fail-open ships.
  expect('mapping OK->0', String(CODES.OK), '0');
  expect('mapping DRIFT->1', String(CODES.DRIFT), '1');
  expect('mapping INDETERMINATE->3', String(CODES.INDETERMINATE), '3');

  const failed = cases.filter((c) => !c.ok);
  for (const c of cases) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : ` — expected ${c.want}, got ${c.got}`}`);
  if (cases.length < 14) {
    console.log(`  vacuity: only ${cases.length} scenarios — the suite built nothing`);
    return verdict('INDETERMINATE');
  }
  console.log(`  ${cases.length - failed.length}/${cases.length} scenarios as expected`);
  return failed.length ? verdict('DRIFT', ['SELF-TEST: FAIL']) : verdict('OK', ['SELF-TEST: PASS']);
}

// ─────────────────────────── main ───────────────────────────

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(url.fileURLToPath(import.meta.url));
if (isMain) {
  if (process.argv.includes('--self-test')) {
    process.exit(selfTest());
  }
  const live = process.argv.includes('--live');
  const r = runCheck({ live });
  if (r.status === 'INDETERMINATE') {
    process.exit(verdict('INDETERMINATE', r.findings.map((f) => `[external-origin-csp] ${f}`)));
  }
  const lines = [...(r.lines ?? []), ...r.findings.map((f) => `  ✗ ${f}`)];
  if (live) {
    const lr = await liveHeaderCheck(r.header);
    lines.push(`[external-origin-csp] --live: ${lr.why}`);
    if (lr.status === 'INDETERMINATE') process.exit(verdict('INDETERMINATE', lines));
    if (lr.status === 'DRIFT') r.findings.push('LIVE served header != committed Caddyfile');
  }
  process.exit(verdict(r.findings.length ? 'DRIFT' : 'OK', lines));
}
