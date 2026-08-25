#!/usr/bin/env node
/**
 * check-token-resolution.mjs — DESIGN-ACCOUNT-THEME-TOKENS-W1 R4.
 *
 * Asserts, PER HOST, that a page's design tokens actually resolve:
 *
 *   (1) every custom property a page CONSUMES resolves — from the page itself, OR from a
 *       stylesheet the page LINKS **whose load that page's CSP permits on that host**;
 *   (2) the inverse — every stylesheet a page LINKS is permitted by that page's CSP.
 *
 * ── Why the CSP clause is the whole point ───────────────────────────────────
 * A gate that only asks "is this token defined SOMEWHERE" PASSES the page that shipped this
 * defect. `/account` links the canonical design loader, that stylesheet is healthy (200, 36751 B,
 * a :root block with all ten tokens in brand oklch), and the page consumes exactly those tokens.
 * Every "is it defined" question answers yes. The page still rendered WHITE, because the policy
 * it serves itself with refused to load the file:
 *
 *     style-src 'self' 'unsafe-inline' https://fonts.googleapis.com
 *
 * `algovault.com` is cross-origin from `api.algovault.com`, so every token fell back to nothing:
 * `background: var(--bg)` painted the browser default white and `color: var(--fg-3)` painted
 * near-black labels on a hardcoded dark bar. Every hardcoded value rendered; every tokenised one
 * did not. **The gate must model the CSP or it cannot see this class at all.**
 *
 * ── Why PER HOST ────────────────────────────────────────────────────────────
 * The same page, same code, same CSP resolves DIFFERENTLY by origin: on `algovault.com` the
 * stylesheet is `'self'` and every token resolves; on `api.algovault.com` it is cross-origin and
 * none do. A single-host gate would have reported this page green on the apex and never looked at
 * the host where it was actually broken — which is also the only host `/account` is served from
 * (it is apex-404). Host is an input, not an assumption.
 *
 * ── Clause (2) is not redundant ─────────────────────────────────────────────
 * Clause (1) only inspects stylesheets that a token happens to depend on. Clause (2) catches the
 * NEXT CSP tightening: a linked stylesheet that becomes forbidden is a defect the moment it
 * happens, whether or not a token currently traces through it.
 *
 *   node scripts/check-token-resolution.mjs             # gate
 *   node scripts/check-token-resolution.mjs --self-test # two-way, vacuity-guarded
 *
 * Codes: 0=PASS / 1=FAIL / 3=INDETERMINATE (token-law default for a NEW gate).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { globSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const SELF = url.fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '..');
const TOKEN = 'TOKEN_RESOLUTION_VERDICT';
const CODES = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };

function verdict(v, why) {
  process.stdout.write(`${TOKEN}=${v}${why ? ` — ${why}` : ''}\n`);
  process.exit(CODES[v]);
}

/** Hosts every Express-rendered page is served from. Both are real; neither is hypothetical. */
export const HOSTS = ['https://algovault.com', 'https://api.algovault.com'];

// ─────────────────────────────── CSP evaluation ──────────────────────────────

/** Parse a CSP header string into {directive: [source, ...]}. */
export function parseCsp(header) {
  const out = {};
  for (const part of String(header).split(';')) {
    const bits = part.trim().split(/\s+/).filter(Boolean);
    if (!bits.length) continue;
    out[bits[0].toLowerCase()] = bits.slice(1);
  }
  return out;
}

/**
 * Would `styleUrl` be permitted to load on a page served from `pageOrigin`?
 * Implements the subset of CSP that matters here: 'self', exact origins, and the
 * style-src-elem → style-src fallback the browser actually applied in the live error.
 */
export function cspAllowsStylesheet(csp, styleUrl, pageOrigin) {
  const sources = csp['style-src-elem'] ?? csp['style-src'] ?? csp['default-src'] ?? null;
  if (sources === null) return { allowed: true, why: 'no style-src/default-src — unrestricted' };

  let target;
  try {
    target = new URL(styleUrl, pageOrigin);
  } catch {
    return { allowed: false, why: `unparseable stylesheet URL ${styleUrl}` };
  }
  const targetOrigin = target.origin;
  const isSelf = targetOrigin === new URL(pageOrigin).origin;

  for (const raw of sources) {
    const s = raw.replace(/^'|'$/g, '');
    if (s === 'self' && isSelf) return { allowed: true, why: `'self' (${targetOrigin})` };
    if (s === '*') return { allowed: true, why: 'wildcard' };
    if (s.startsWith('http')) {
      try {
        if (new URL(s).origin === targetOrigin) return { allowed: true, why: `explicit ${s}` };
      } catch { /* not an origin token */ }
    }
  }
  return {
    allowed: false,
    why: `${targetOrigin} not permitted by [${sources.join(' ')}] for a page on ${new URL(pageOrigin).origin}`,
  };
}

// ───────────────────────────── source extraction ─────────────────────────────

/** Strip comments so a token NAMED in prose is never mistaken for a definition or a use. */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '');

export function consumedTokens(src) {
  // `var(--x)` WITH a fallback cannot fail closed, so it is not a resolution requirement.
  return new Set([...strip(src).matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/gi)].map((m) => m[1]));
}
export function definedTokens(src) {
  return new Set([...strip(src).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
}
export function linkedStylesheets(src) {
  return [...strip(src).matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi)]
    .map((m) => /href=["']([^"']+)["']/i.exec(m[0])?.[1])
    .filter(Boolean);
}

/**
 * Resolve a linked stylesheet href to a repo file so tokens can be read WITHOUT the network.
 * The canonical design CSS is repo-resident at landing/_design/, served from the apex docroot.
 */
export function localFileForHref(repoRoot, href) {
  let pathname;
  try {
    pathname = href.startsWith('http') ? new URL(href).pathname : href;
  } catch {
    return null;
  }
  const candidate = path.join(repoRoot, 'landing', pathname.replace(/^\//, ''));
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * Remove `//` line comments from a window of source.
 *
 * Deliberately narrow: it runs on a window that is a chain of string concatenations, where the
 * only `//` occurring inside a string literal is a URL scheme separator and is therefore always
 * preceded by a colon. Guarding that one case is sufficient here and keeps this readable; a full
 * tokenizer would be more machinery than this window justifies.
 */
export function stripLineComments(src) {
  return src
    .split('\n')
    .map((line) => {
      const m = line.match(/(^|[^:])\/\//);
      if (!m) return line;
      return line.slice(0, m.index + m[1].length);
    })
    .join('\n');
}

/**
 * The CSP the Express middleware sets, read from source — never hand-copied.
 *
 * COMMENTS ARE STRIPPED FIRST, and that is not tidiness — it is the fix for a measured failure.
 * 2026-08-25 (CONTACT-ANTISPAM-AND-REPLY-TO-W1 CH2): a wave added an explanatory comment inside
 * this `setHeader` call containing an ordinary English phrase in double quotes. The scraper
 * ingested it as a policy fragment and produced
 *
 *     default-src 'self'; just in casestyle-src 'self' 'unsafe-inline' https://...
 *
 * so `style-src` became `casestyle-src`, the directive silently VANISHED from the parsed policy,
 * every page fell back to `default-src 'self'`, and this fail-closed gate blocked the deploy
 * with 15 findings describing a CSP nobody had written. The policy on the wire was correct the
 * whole time — the instrument was wrong, and it was confidently, specifically wrong.
 *
 * Same class as `scripts/check-canaries-wired.mjs` stripping comments before deciding what
 * counts as an invocation, and as the CLAUDE.md rule that a ban-grep must not read a docblock
 * quoting the banned construct. The direction is inverted here — a comment INJECTED content
 * rather than tripping a ban — but the remedy is identical: the scanner must see code, not prose.
 *
 * Still by design: only DOUBLE-quoted literals are read, because that is the convention the call
 * site uses. A single-quoted segment stays invisible, which is why the call site now carries a
 * standing note saying so.
 */
export function extractExpressCsp(indexSrc) {
  const i = indexSrc.indexOf("'Content-Security-Policy'");
  if (i === -1) return null;
  // Concatenated string literals up to the closing paren of setHeader.
  const seg = stripLineComments(indexSrc.slice(i, i + 2500));
  const parts = [...seg.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  const joined = parts.join('');
  return joined.includes('default-src') ? joined : null;
}

// ──────────────────────────────── the gate ───────────────────────────────────

export function analyse(repoRoot) {
  const indexPath = path.join(repoRoot, 'src', 'index.ts');
  if (!fs.existsSync(indexPath)) {
    return { status: 'INDETERMINATE', why: `src/index.ts not found under ${repoRoot}` };
  }
  const csp = extractExpressCsp(fs.readFileSync(indexPath, 'utf8'));
  if (!csp) return { status: 'INDETERMINATE', why: 'could not extract the Content-Security-Policy from src/index.ts' };
  const parsed = parseCsp(csp);

  const files = globSync('src/**/*.ts', { cwd: repoRoot }).map((p) => p.split(path.sep).join('/')).sort();
  const findings = [];
  const pages = [];

  for (const rel of files) {
    const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    if (!/<\/body>/i.test(src)) continue; // not a full page renderer
    const consumed = consumedTokens(src);
    const links = linkedStylesheets(src);
    if (consumed.size === 0 && links.length === 0) continue;

    const own = definedTokens(src);
    pages.push(rel);

    for (const host of HOSTS) {
      // Clause (2): every linked stylesheet must be permitted on this host.
      const usable = [];
      for (const href of links) {
        const v = cspAllowsStylesheet(parsed, href, host);
        if (!v.allowed) {
          findings.push({ rel, host, kind: 'FORBIDDEN_STYLESHEET', detail: `${href} — ${v.why}` });
        } else {
          usable.push(href);
        }
      }

      // Clause (1): every consumed token must resolve from the page or a PERMITTED stylesheet.
      const reachable = new Set(own);
      for (const href of usable) {
        const local = localFileForHref(repoRoot, href);
        if (!local) continue; // e.g. Google Fonts — permitted, but defines no design tokens
        for (const t of definedTokens(fs.readFileSync(local, 'utf8'))) reachable.add(t);
      }
      for (const t of consumed) {
        if (!reachable.has(t)) {
          findings.push({ rel, host, kind: 'UNRESOLVED_TOKEN', detail: `${t} is consumed but resolves from nothing this page can load` });
        }
      }
    }
  }

  if (pages.length === 0) {
    return { status: 'INDETERMINATE', why: 'ZERO token-consuming pages found — this repo has several, so the scan is broken' };
  }
  return { status: 'PASS', findings, pages, csp };
}

function main(argv) {
  const rootIdx = argv.indexOf('--root');
  const root = rootIdx === -1 ? REPO_ROOT : path.resolve(argv[rootIdx + 1] || '.');
  const res = analyse(root);
  if (res.status !== 'PASS') verdict(res.status, res.why);

  if (res.findings.length > 0) {
    for (const f of res.findings) console.error(`[token-resolution] ${f.kind} ${f.rel} @ ${f.host}\n    ${f.detail}`);
    verdict('FAIL', `${res.findings.length} finding(s) across ${res.pages.length} page(s) × ${HOSTS.length} host(s)`);
  }
  console.log(`[token-resolution] ${res.pages.length} page(s) verified on ${HOSTS.length} host(s): ${res.pages.join(', ')}`);
  verdict('PASS', `every consumed token resolves through a CSP-permitted source on both hosts`);
}

// ───────────────────────────────── self-test ─────────────────────────────────

function selfTest() {
  const fails = [];
  let produce = 0, refuse = 0, map = 0;
  const EXPECTED_CODES = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'token-resolution.'));

  const CSP_BLOCKED = `"default-src 'self'; " + "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "`;
  const CSP_FIXED = `"default-src 'self'; " + "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://algovault.com; "`;
  const indexTs = (cspExpr) => `res.setHeader(\n  'Content-Security-Policy',\n  ${cspExpr},\n);\n`;
  const pageTs = (body) => `export const p = \`<html><head>${body}</head><body></body></html>\`;`;

  const mkRoot = (name, files) => {
    const r = path.join(tmp, name);
    for (const [rel, body] of Object.entries(files)) {
      const p = path.join(r, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body);
    }
    return r;
  };
  const run = (root) => {
    const r = spawnSync(process.execPath, [SELF, '--root', root], { encoding: 'utf8' });
    const line = ((r.stdout || '') + (r.stderr || '')).split('\n').find((l) => l.startsWith(`${TOKEN}=`)) || '';
    return { token: line.split('=')[1]?.split(' ')[0] || '', code: r.status ?? -1, err: r.stderr || '' };
  };
  const expect = (label, got, want) => { if (got !== want) fails.push(`${label}: expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`); };
  const expectVerdict = (label, r, token) => { expect(`${label} token`, r.token, token); expect(`${label} code`, r.code, EXPECTED_CODES[token]); };

  const CSS = ':root{--bg: oklch(0.16 0.012 265); --fg-3: oklch(0.58 0.01 265);}';
  const LINK = '<link rel="stylesheet" href="https://algovault.com/_design/algovault-design.css">';

  try {
    // ── must-refuse: THE shipped defect — token defined, stylesheet healthy, CSP blocks it ──
    refuse += 1;
    const blocked = run(mkRoot('blocked', {
      'src/index.ts': indexTs(CSP_BLOCKED),
      'src/lib/page.ts': pageTs(`${LINK}<style>body{background:var(--bg);color:var(--fg-3)}</style>`),
      'landing/_design/algovault-design.css': CSS,
    }));
    expectVerdict('CSP-blocked stylesheet FAILS', blocked, 'FAIL');
    expect('names UNRESOLVED_TOKEN', /UNRESOLVED_TOKEN/.test(blocked.err), true);
    expect('names FORBIDDEN_STYLESHEET', /FORBIDDEN_STYLESHEET/.test(blocked.err), true);
    // ...and names the host it fails on, not just the page.
    expect('names the api host', /api\.algovault\.com/.test(blocked.err), true);

    refuse += 1;
    expectVerdict('token defined nowhere at all FAILS', run(mkRoot('nodef', {
      'src/index.ts': indexTs(CSP_FIXED),
      'src/lib/page.ts': pageTs('<style>body{background:var(--nope)}</style>'),
    })), 'FAIL');

    refuse += 1;
    expectVerdict('no page renderers at all ⇒ INDETERMINATE (vacuity)', run(mkRoot('vac', {
      'src/index.ts': indexTs(CSP_FIXED),
      'src/lib/helper.ts': 'export const x = 1;',
    })), 'INDETERMINATE');

    refuse += 1;
    expectVerdict('unextractable CSP ⇒ INDETERMINATE', run(mkRoot('nocsp', {
      'src/index.ts': 'export const nothing = 1;',
      'src/lib/page.ts': pageTs('<style>body{background:var(--bg)}</style>'),
    })), 'INDETERMINATE');

    // ── must-produce: the three genuinely-correct shapes ────────────────────
    produce += 1;
    expectVerdict('CSP permits the origin ⇒ resolves on BOTH hosts', run(mkRoot('fixed', {
      'src/index.ts': indexTs(CSP_FIXED),
      'src/lib/page.ts': pageTs(`${LINK}<style>body{background:var(--bg);color:var(--fg-3)}</style>`),
      'landing/_design/algovault-design.css': CSS,
    })), 'PASS');

    produce += 1;
    expectVerdict('page defines its own tokens inline', run(mkRoot('inline', {
      'src/index.ts': indexTs(CSP_BLOCKED),
      'src/lib/page.ts': pageTs('<style>:root{--bg:#0d1117}body{background:var(--bg)}</style>'),
    })), 'PASS');

    produce += 1;
    // A fallback var() cannot fail closed, so it is not a resolution requirement. The fixture
    // MUST also carry an in-scope page: a corpus of nothing-but-fallbacks is legitimately empty,
    // and the vacuity guard rightly refuses it — which is what the first draft of this case hit.
    expectVerdict('var() WITH a fallback is not a requirement', run(mkRoot('fallback', {
      'src/index.ts': indexTs(CSP_BLOCKED),
      'src/lib/fallback-page.ts': pageTs('<style>body{font-family:var(--font-text, system-ui)}</style>'),
      'src/lib/real-page.ts': pageTs('<style>:root{--bg:#0d1117}body{background:var(--bg)}</style>'),
    })), 'PASS');

    // ── must-produce: a COMMENT must never contribute to the extracted policy ──
    //
    // The live regression, pinned. CONTACT-ANTISPAM-AND-REPLY-TO-W1 CH2 added a comment inside
    // the setHeader call carrying an ordinary English phrase in double quotes; this scraper
    // spliced it into the policy, `style-src` became `casestyle-src`, and the gate blocked a
    // deploy over a CSP nobody had written. Asserted at the EXTRACTOR rather than end-to-end,
    // because that is the function that was wrong.
    produce += 1;
    const withComment = indexTs(
      `"default-src 'self'; " +\n  // a directive added "just in case" is threat surface\n  "style-src 'self' https://fonts.googleapis.com; "`,
    );
    expect(
      'a double-quoted phrase in a comment does NOT enter the policy',
      extractExpressCsp(withComment),
      "default-src 'self'; style-src 'self' https://fonts.googleapis.com; ",
    );

    produce += 1;
    expect(
      'stripLineComments leaves a URL scheme separator alone',
      stripLineComments('const a = "https://x.test/a.css"; // trailing note'),
      'const a = "https://x.test/a.css"; ',
    );

    // Proven able to fail: the UNSTRIPPED extraction really does corrupt the directive, so the
    // assertion above is not vacuously true of any input.
    produce += 1;
    const unstripped = [...withComment.slice(withComment.indexOf("'Content-Security-Policy'")).matchAll(/"([^"]*)"/g)]
      .map((m) => m[1]).join('');
    expect('without the strip, style-src IS corrupted', /casestyle-src/.test(unstripped), true);

    // ── must-map ────────────────────────────────────────────────────────────
    map += 1;
    expect('self is host-relative: apex allows apex', cspAllowsStylesheet(parseCsp("style-src 'self'"), 'https://algovault.com/a.css', 'https://algovault.com').allowed, true);
    map += 1;
    expect('self is host-relative: api REFUSES apex', cspAllowsStylesheet(parseCsp("style-src 'self'"), 'https://algovault.com/a.css', 'https://api.algovault.com').allowed, false);
    map += 1;
    expect('style-src-elem overrides style-src', cspAllowsStylesheet(parseCsp("style-src https://algovault.com; style-src-elem 'self'"), 'https://algovault.com/a.css', 'https://api.algovault.com').allowed, false);
    map += 1;
    expect('falls back to default-src', cspAllowsStylesheet(parseCsp("default-src 'self'"), 'https://algovault.com/a.css', 'https://api.algovault.com').allowed, false);
    map += 1;
    // A token named only in a COMMENT is neither consumed nor defined.
    expect('comments stripped before extraction', consumedTokens('/* uses var(--ghost) */ body{color:var(--real)}').has('--ghost'), false);
    map += 1;
    expect('fallback var() not counted as consumed', consumedTokens('body{color:var(--x, #fff)}').size, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (produce === 0 || refuse === 0 || map === 0) {
    process.stdout.write(`${TOKEN}=INDETERMINATE — self-test VACUOUS: ${produce}/${refuse}/${map}\n`);
    process.exit(CODES.INDETERMINATE);
  }
  if (fails.length) {
    process.stdout.write(`${TOKEN}=FAIL — self-test ${fails.length} failure(s): ${fails.join(' | ')}\n`);
    process.exit(CODES.FAIL);
  }
  process.stdout.write(`${TOKEN}=PASS — self-test ${produce} must-produce, ${refuse} must-refuse, ${map} must-map\n`);
  process.exit(CODES.PASS);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) selfTest();
  else main(argv);
}
