#!/usr/bin/env node
/**
 * check-form-action-conformance.mjs — CANCEL-PATH-CSP-FORM-ACTION-W1 CH2.
 *
 * THE CLASS THIS RETIRES: a form submission whose handler chain emits a cross-origin 3xx under a
 * restrictive `form-action`. Chrome and Safari apply `form-action` to the WHOLE redirect chain that
 * follows a form submission, so `POST /account/portal` → `303 billing.stripe.com` was refused by the
 * browser SILENTLY — no error page, no navigation — for eight weeks, while every server-side test
 * asserted the 303 as correct. CH1 fixed that lane (src/lib/off-origin-redirect.ts). This gate makes
 * the next instance fail at commit time instead of in a customer's browser.
 *
 * WHAT IT CHECKS, per form (and per submitter's formaction/formmethod), per SERVING ORIGIN:
 *   (i)  the submission target is allowed by that origin's `form-action` list;
 *   (ii) every Location the request can pick up on the way — path-matching `use()` middleware
 *        (params, `*` and RegExp prefixes; routers mounted by name, default export, behind
 *        middleware, from a factory, nested, or as `express()` sub-apps), `param()` callbacks, every
 *        handler of every matching registration — including the arguments we hand a PACKAGE wrapper
 *        (`asyncHandler(fn)`) and what a LOCAL wrapper returns — and the helpers those bodies hand the
 *        response to (as `res`, as `req.res`, or inside an object), scanned ONCE PER CALL SITE with
 *        that site's arguments bound — is provably same-origin, and every own-origin hop is FOLLOWED:
 *        `POST /x` → `303 /signup` → `303 checkout.stripe.com` is refused exactly like a direct 303.
 *        Provably same-origin: a path literal (`'/x'`), a template or `+` chain whose static head is
 *        `/<non-slash>` (`/x?${q}` — but never `/${x}`, which can become `//evil.example`), a relative
 *        / dot-segment / query-only / `back` Location (resolved against the request and followed), a
 *        ternary whose branches all are, an absolute own-origin literal the policy allows (followed
 *        THERE; `'self'` stays the page's origin for the whole chain), or a `const` — resolved by
 *        LEXICAL SCOPE (a parameter, destructured name or hoisted `var` shadows it; a helper parameter
 *        reassigned inside the helper is not the caller's argument), across relative imports and
 *        `export *` barrels, and through const object properties — bound to one of those. Strings are
 *        read as the browser's URL parser reads them: a `\`, a tab or a leading space cannot smuggle
 *        `//host` past these tests. ANYTHING ELSE FAILS as "not provably same-origin". That clause is
 *        what makes the pre-CH1 tree FAIL on `res.redirect(303, portalUrl)`; without it this gate is
 *        decoration. A 307/308 keeps the method; a status the gate cannot read is followed as BOTH.
 *
 * HOW IT READS CODE: the TypeScript compiler's own parser (`typescript`, a devDependency). Four
 * adversarial review rounds (116 reproduced findings; round 4 restricted to COMMON code) retired, in
 * turn, a regex/brace scanner, a file-wide name lookup and a visited-set helper scan; every round-3
 * and round-4 reproduction (and its controls) is kept as a regression tree under
 * tests/fixtures/form-action/regressions/ with its reviewed verdict. Handlers are read as plain
 * functions, controller members (object literals, `export default { save }`, `new C()` instances),
 * `.bind`s, spreads, package-wrapped callbacks, and local factories with their parameters BOUND to the
 * call's arguments (`requireLogin('/login')`). Imports resolve relatively, through `export *`
 * barrels, and through the tree's tsconfig `paths` / `baseUrl` and package.json `imports`. Comments
 * never enter an AST; HTML comments inside literals and in landing/**.html are blanked before
 * scanning (the latter through the shared scripts/lib/strip-comments.mjs). A form attribute or
 * method written as an interpolation is EXPANDED to every value it can take and re-read.
 *
 * POLICIES (two, never merged), via the SHARED readers — this file writes no CSP parser:
 *   - EXPRESS: extractExpressCsp + parseCsp (scripts/check-token-resolution.mjs). A route is served on
 *     https://api.algovault.com always, and on https://algovault.com only where the apex Caddy block
 *     proxies it to Express (`handle`/`route` blocks, single-line and block `@matcher`s incl.
 *     `path_regexp`, site-level `reverse_proxy`). A proxy the reader cannot state as a path set
 *     (`handle_path`, `uri`/`rewrite`, `not`, an undefined matcher) is APEX_MATCHER_UNRESOLVED.
 *   - APEX STATIC: extractCaddyCsp (scripts/check-external-origin-csp.mjs).
 *   A form in src/** renders under EXPRESS on both hosts; a form in landing/**.html is ON THE APEX,
 *   under the apex static policy where Caddy serves its URL and the Express policy where the apex
 *   proxies that URL to the container — both when its URL forms disagree.
 *
 * REPORTED, NOT FAILED (per spec): a GET form with no action / a `#`/`?`-only action (SAME_DOCUMENT),
 * a GET form to a path no registration serves (a static or 404 page — ONLY while every registration
 * was placed), `method="dialog"`.
 *
 * 🛑 DECLARED LIMITS — what this static read does not prove, stated so nobody discovers it:
 *   - PACKAGE code is trusted not to redirect: a package middleware that answers with a redirect
 *     (an OAuth `passport.authenticate('google')` mounted as a form handler) is not read.
 *   - A request (`req`) handed to code the gate cannot resolve is followed best-effort; the RESPONSE
 *     itself escaping into such code is RESPONSE_ESCAPES (INDETERMINATE). A header set dynamically in
 *     a middleware with no 3xx status, then made a redirect by a later handler, is not paired up.
 *   - Script is not executed: an inline <script> or landing/**.js that builds, retargets or submits
 *     a form is SCRIPTED_FORM (INDETERMINATE); JSX forms are JSX_FORM; a template file under src/
 *     holding a form is UNSCANNED_TEMPLATE; an alias the tree's tsconfig / package.json does not map
 *     to a source file is HANDLER_UNRESOLVED (package-shaped ones it does not map are packages).
 *   - A redirect built from the Host header (`https://${req.headers.host}…`) is not provable: FAIL.
 *   - Helper depth ≤ 3 (beyond it the response ESCAPES), hop depth ≤ 4.
 *   The runtime canary (CH3) covers what a static read cannot see — a Caddy edit, a Cloudflare
 *   header, Stripe moving its host.
 *
 * VACUITY IS JUDGED WHERE THE CORPUS IS CONSTRUCTED. INDETERMINATE (exit 3) with a distinct reason:
 *   NO_EXPRESS_CSP · NO_FORM_ACTION_DIRECTIVE (keyed on the DIRECTIVE, never on a null return —
 *   extractExpressCsp reads a fixed 2500-byte window, and ~86 bytes of comment growth inside the
 *   setHeader call drops frame-ancestors/base-uri/form-action/object-src while it still returns
 *   non-null) · NO_APEX_CSP · APEX_CSP_AMBIGUOUS · NO_APEX_PROXY_MAP · APEX_MATCHER_UNRESOLVED ·
 *   NO_FORMS · NO_ROUTES · SOURCE_PARSE_ERROR · NO_MAPPED_HANDLERS; per form: FORM_UNROUTED ·
 *   UNROUTED_UNPLACEABLE · SAME_DOCUMENT_POST · ACTION_ORIGIN_UNRESOLVED · ACTION_UNRESOLVED ·
 *   FORM_ATTRS_INTERPOLATED · FORM_UNPARSED · FORM_NO_SERVING_ORIGIN · SUBMITTER_UNASSOCIATED ·
 *   SCRIPTED_FORM · JSX_FORM · UNSCANNED_TEMPLATE · HANDLER_UNRESOLVED · RESPONSE_ESCAPES ·
 *   HOP_UNROUTED · REDIRECT_CHAIN_TOO_DEEP.
 *

 * VERDICT: exactly one terminal line `FORM_ACTION_CONFORMANCE_VERDICT=PASS|FAIL|INDETERMINATE`,
 * exit 0|1|3 (3 = the token-law default for a new gate), on EVERY path — including a failed import.
 * Callers gate on the TOKEN, never the code. FAIL outranks INDETERMINATE outranks PASS.
 *
 * USAGE:
 *   node scripts/check-form-action-conformance.mjs [--check] [--root <dir>]   # the gate (--check is a real alias)
 *   node scripts/check-form-action-conformance.mjs --self-test [--root <dir>]  # two-way, fixture-driven
 * Read-only, always. Network-free.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { createRequire } from 'node:module';

const TOKEN = 'FORM_ACTION_CONFORMANCE_VERDICT';
const CODES = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };
const SELF = url.fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.resolve(path.dirname(SELF), '..');
const API_ORIGIN = 'https://api.algovault.com';
const APEX_ORIGIN = 'https://algovault.com';
const MAX_HOPS = 4;
const MAX_HELPER_DEPTH = 3;
const VERBS = { get: 'GET', post: 'POST', put: 'PUT', patch: 'PATCH', delete: 'DELETE', all: '*' };
const SRC_EXT = ['.ts', '.tsx', '.mts', '.cts'];
/** Printable markers, never control bytes: MULTI may span segments; SEG stays inside one segment. */
const MULTI = '⟦⟧';
const SEG = '⟦s⟧';
const EXPR = (n) => `⟦${n}⟧`;
const shownOf = (s) => s.replace(/⟦[a-z0-9]*⟧/g, '${…}');
/** A separate express() app with its own listener — not served under the Express policy. */
const SEPARATE_APPS = new Set(['src/facilitator.ts']);

let ts, parseCsp, extractExpressCsp, extractCaddyCsp, stripComments;
/** The corpus of the tree being analysed — constant folding follows relative imports through it. */
let CORPUS = null;
/** The tree's module aliases: tsconfig `baseUrl` + `paths`, package.json `imports`. */
let ALIASES = null;
function loadAliases(root) {
  const out = { baseUrl: null, paths: [], imports: [] };
  const tsc = path.join(root, 'tsconfig.json');
  if (fs.existsSync(tsc)) {
    const parsed = ts.parseConfigFileTextToJson(tsc, fs.readFileSync(tsc, 'utf8'));
    const co = (parsed.config && parsed.config.compilerOptions) || {};
    out.baseUrl = co.baseUrl ? path.posix.normalize(co.baseUrl) : null;
    for (const [k, v] of Object.entries(co.paths || {})) if (Array.isArray(v)) out.paths.push([k, v, out.baseUrl || '.']);
  }
  const pkg = path.join(root, 'package.json');
  if (fs.existsSync(pkg)) {
    try {
      const j = JSON.parse(fs.readFileSync(pkg, 'utf8'));
      for (const [k, v] of Object.entries(j.imports || {})) out.imports.push([k, typeof v === 'string' ? v : v && (v.default || v.import || v.node || v.require) || null]);
    } catch { /* an unreadable package.json maps nothing; its imports then read as unresolved aliases */ }
  }
  return out;
}
/** The source file an ALIAS specifier maps to in this tree (a compiled `dist/` target read back as `src/`), or null. */
function aliasFile(spec) {
  if (!CORPUS || !ALIASES || spec.startsWith('.') || spec.startsWith('node:')) return null;
  const at = (p) => CORPUS.moduleFile('x', './' + path.posix.normalize(p).replace(/^\.\//, ''));
  const match = (pattern, s) => {
    if (!pattern.includes('*')) return pattern === s ? '' : null;
    const [pre, post] = pattern.split('*');
    return s.startsWith(pre) && s.endsWith(post) && s.length >= pre.length + post.length ? s.slice(pre.length, s.length - post.length) : null;
  };
  for (const [k, targets, base] of ALIASES.paths) {
    const m = match(k, spec);
    if (m === null) continue;
    for (const tg of targets) { const f = at(path.posix.join(base, tg.replace('*', m))); if (f) return f; }
  }
  for (const [k, target] of ALIASES.imports) {
    const m = match(k, spec);
    if (m === null || !target || !target.startsWith('.')) continue;
    const t0 = target.replace('*', m).replace(/^\.\//, '');
    for (const cand of [t0, t0.replace(/^(dist|build|lib|out)\//, 'src/')]) { const f = at(cand); if (f) return f; }
  }
  if (ALIASES.baseUrl) { const f = at(path.posix.join(ALIASES.baseUrl, spec)); if (f) return f; }
  return null;
}

async function loadDeps() {
  ({ parseCsp, extractExpressCsp } = await import('./check-token-resolution.mjs'));
  ({ extractCaddyCsp } = await import('./check-external-origin-csp.mjs'));
  ({ stripComments } = await import('./lib/strip-comments.mjs'));
  ts = createRequire(import.meta.url)('typescript');
}

// ───────────────────────────── small helpers ─────────────────────────────

function walk(dir, exts, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, out);
    else if (exts.some((x) => e.name.endsWith(x)) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out.sort();
}

const lineAt = (sf, pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Blank `<!-- … -->` in markup text, preserving offsets. */
const blankHtmlComments = (t) => t.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));

/** Lower-case, drop query/fragment, drop one trailing slash — Express 4's default matching. */
function normPath(p) {
  const bare = String(p).split('?')[0].split('#')[0].toLowerCase();
  return bare.length > 1 && bare.endsWith('/') ? bare.slice(0, -1) : bare;
}
/** Holes in a REGISTERED path (a loop-built `${PREFIX}/${tool}`) match anything, exactly like `*`. */
const routeHolesToStar = (p) => String(p).replaceAll(MULTI, '*').replaceAll(SEG, '*');
const holesToSample = (p) => String(p).replaceAll(SEG, 'x').replaceAll(MULTI, 'x');

/** A route path (`:p`, `:p?`, `*`, `(.*)`, holes) as a regex over concrete paths; `prefix` = Express's `end: false`. */
function routeRegex(routePath, prefix = false) {
  let r = '';
  for (const seg of normPath(routeHolesToStar(routePath)).split('/').slice(1)) {
    if (seg === '') continue;
    if (seg === '*' || seg === '(.*)') { r += '(?:/.*)?'; continue; }
    if (/^:[^/]+\?$/.test(seg)) { r += '(?:/[^/]+)?'; continue; }
    if (seg.startsWith(':')) { r += '/[^/]+'; continue; }
    r += '/' + escRe(seg).replace(/\\\*/g, '.*');
  }
  return prefix ? new RegExp(`^${r}(?:/.*)?$`) : new RegExp(`^${r || '/'}/?$`);
}
/** A path pattern with holes (SEG = one segment's worth, MULTI = anything) as a regex. */
function patternRegex(pattern) {
  const p = normPath(pattern);
  let r = ''; let i = 0;
  while (i < p.length) {
    if (p.startsWith(SEG, i)) { r += '[^/]+'; i += SEG.length; continue; }
    if (p.startsWith(MULTI, i)) { r += '.*'; i += MULTI.length; continue; }
    r += escRe(p[i]); i++;
  }
  return new RegExp(`^${r}/?$`);
}
/** Could a request for `pattern` be served by `routePath` (a string, or a RegExp literal)? Two-way, so holes and params both match. */
function pathMatches(routePath, pattern) {
  if (routePath instanceof RegExp) return routePath.test(holesToSample(String(pattern).split(/[?#]/)[0])) || /⟦/.test(pattern);
  const routeSample = normPath(routeHolesToStar(routePath)).split('/').map((s) => (s.startsWith(':') || s.includes('*') || s === '(.*)' ? 'x' : s)).join('/');
  return routeRegex(routePath).test(normPath(holesToSample(pattern))) || patternRegex(pattern).test(routeSample);
}
/** Does `use(prefix, …)` see a request for `pattern`? Express mounts match `end: false` — params, `*` and RegExps included. */
function prefixMatches(prefix, pattern) {
  if (prefix instanceof RegExp) return prefix.test(holesToSample(String(pattern).split(/[?#]/)[0])) || /⟦/.test(pattern);
  const pre = normPath(routeHolesToStar(prefix));
  if (pre === '/' || pre === '*' || pre === '/*') return true;
  if (routeRegex(prefix, true).test(normPath(holesToSample(pattern)))) return true;
  // A hole in the request path could still land under the prefix: conservative.
  const p = normPath(pattern);
  if (!/⟦/.test(p)) return false;
  const head = p.slice(0, p.indexOf('⟦'));
  const preLit = pre.split(/[:*]/)[0];
  return preLit.startsWith(head) || head.startsWith(preLit);
}
/** A `use()` prefix that every request passes (`/`, `*`). */
const isGlobalPrefix = (p) => typeof p === 'string' && ['/', '*', '/*'].includes(normPath(p));

/** What the browser's URL parser does before resolving a Location: C0/space trimmed, tab/LF/CR removed, `\` read as `/`. */
const urlNormalize = (v) => String(v).replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '').replace(/[\t\n\r]/g, '').replace(/\\/g, '/');
/** Resolve `.` / `..` segments of an absolute path, keeping its query/fragment. */
function resolveDots(p) {
  const i = p.search(/[?#]/);
  const pathPart = i === -1 ? p : p.slice(0, i);
  const rest = i === -1 ? '' : p.slice(i);
  const segs = pathPart.split('/').slice(1); const out = [];
  segs.forEach((seg, k) => {
    const last = k === segs.length - 1;
    if (seg === '.') { if (last) out.push(''); return; }
    if (seg === '..') { out.pop(); if (last) out.push(''); return; }
    out.push(seg);
  });
  return '/' + out.join('/') + rest;
}
/** A bare npm specifier, or a `node:` builtin — package code. `#x`, `@/x`, `~/x` are path ALIASES into our own tree. */
const isNpmSpec = (spec) => /^node:/.test(spec) || (!aliasFile(spec) && /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:\/.*)?$/i.test(spec));
/** A specifier into our own tree: relative, or an alias the tree's tsconfig / package.json maps to a source file. */
const isLocalSpec = (spec) => spec.startsWith('.') || Boolean(aliasFile(spec));
/** A status for a message: NaN means "set, but not to a constant the gate can read". */
const statusLabel = (st) => (Number.isNaN(st) ? '3xx(status not a readable constant)' : String(st));

/** form-action source-expression matching. form-action has NO default-src fallback; callers ensure it exists. */
export function formActionAllows(sources, target, pageOrigin) {
  let t;
  try { t = new URL(target, pageOrigin); } catch { return false; }
  const page = new URL(pageOrigin);
  for (const raw of sources) {
    const s = raw.replace(/^'|'$/g, '');
    if (s === 'none') return false;
    if (s === 'self' && t.origin === page.origin) return true;
    if (s === '*' && /^(https?|wss?):$/.test(t.protocol)) return true;
    if (/^[a-z][a-z0-9+.-]*:$/i.test(s) && t.protocol === s.toLowerCase()) return true;
    const host = /^(?:(https?):\/\/)?(\*\.)?([^/:]+)(?::(\d+))?$/i.exec(s);
    if (host) {
      if (host[1] && `${host[1]}:` !== t.protocol) continue;
      if (!host[1] && t.protocol !== page.protocol && !(page.protocol === 'http:' && t.protocol === 'https:')) continue;
      const hn = host[3].toLowerCase();
      const okHost = host[2] ? t.hostname.endsWith(`.${hn}`) : t.hostname === hn;
      const okPort = host[4] ? t.port === host[4] : t.port === '';
      if (okHost && okPort) return true;
    }
  }
  return false;
}

// ───────────────────────────── Caddy: which Express paths the apex serves ─────────────────────────────

/** Index of the `}` closing the `{` at `open` (Caddy placeholders `{…}` balance on their own). */
function braceEnd(text, open) {
  let d = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') d++;
    else if (text[i] === '}' && --d === 0) return i;
  }
  return -1;
}
const EXPRESS_UPSTREAM = /reverse_proxy\s+(?:[@/]\S*\s+)?(?:https?:\/\/)?(?:localhost|127\.0\.0\.1):3000\b/;

/**
 * Path matchers (regexes) under which the apex site proxies to Express; null = no apex site block.
 * The array carries `.unresolved`: proxy handles whose path set the reader cannot state — a
 * `handle_path` or `uri`/`rewrite` that changes the path Express sees, a `not` / `expression`
 * matcher, an undefined `@name`. The caller turns any of those into INDETERMINATE: dropping one
 * would silently take the apex origin out of the judgement for every path it covers.
 */
export function apexProxiedMatchers(caddySrc) {
  const code = String(caddySrc).split('\n').map((l) => (/^\s*#/.test(l) ? '' : l)).join('\n');
  let block = null;
  for (const m of code.matchAll(/^([^\s#{}][^{}\n]*?)\s*\{\s*$/gm)) {
    const hosts = m[1].split(/[,\s]+/).map((h) => h.replace(/^https?:\/\//, '').replace(/:\d+$/, '').toLowerCase());
    if (hosts.includes('algovault.com')) {
      const open = m.index + m[0].lastIndexOf('{');
      block = code.slice(open + 1, braceEnd(code, open));
      break;
    }
  }
  if (block === null) return null;
  const toRe = (p) => new RegExp(`^${escRe(p.toLowerCase()).replace(/\\\*/g, '.*')}$`);
  const ALL = /^.*$/;
  const out = []; out.unresolved = [];
  const lines = block.split('\n');
  // Brace depth per line: Caddy placeholders `{…}` open and close on one line, so they cancel.
  const delta = (l) => (l.match(/\{/g) || []).length - (l.match(/\}/g) || []).length;
  // A named matcher's body → path regexes, or null when it is not expressible as a path set.
  // header / method / query / host / remote_ip only NARROW a path set: ignoring them over-approximates, which is sound.
  const matcherOf = (bodyLines) => {
    const res = []; let pathy = false;
    for (const raw of bodyLines) {
      const [k, ...rest] = raw.trim().split(/\s+/);
      if (!k) continue;
      if (k === 'path') { pathy = true; res.push(...rest.map(toRe)); }
      else if (k === 'path_regexp') { pathy = true; try { res.push(new RegExp(rest.length > 1 ? rest.slice(1).join(' ') : rest[0], 'i')); } catch { return null; } }
      else if (k === 'not' || k === 'expression') return null;
    }
    return pathy ? res : [ALL];
  };
  const named = new Map(); const blocks = []; const siteProxies = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    const collect = () => { const body = []; let d = delta(lines[i]); while (d > 0 && ++i < lines.length) { d += delta(lines[i]); if (d > 0) body.push(lines[i]); } return body; };
    let m;
    if ((m = /^@([\w-]+)\s*\{$/.exec(l))) { named.set(m[1], matcherOf(collect())); continue; }
    if ((m = /^@([\w-]+)\s+(.+)$/.exec(l))) { named.set(m[1], matcherOf([m[2]])); continue; }
    if ((m = /^(handle|route|handle_path)(?:\s+([^\s{]+))?\s*\{(.*)\}\s*$/.exec(l))) { blocks.push({ kind: m[1], matcher: m[2], body: m[3] }); continue; }
    if ((m = /^(handle|route|handle_path)(?:\s+([^\s{]+))?\s*\{$/.exec(l))) { blocks.push({ kind: m[1], matcher: m[2], body: collect().join('\n') }); continue; }
    if (/^reverse_proxy\b/.test(l) && EXPRESS_UPSTREAM.test(l)) { const tok = l.split(/\s+/)[1]; siteProxies.push(/^[@/*]/.test(tok) ? tok : undefined); }
    if (delta(lines[i]) > 0) collect(); // any other directive block (header, tls, log…): skip it whole
  }
  const matcherPaths = (tok, what) => {
    if (tok === undefined || tok === '*') return [ALL];
    if (!tok.startsWith('@')) return [toRe(tok)];
    const v = named.get(tok.slice(1));
    if (!v) out.unresolved.push(`${what} (matcher ${tok} is ${v === null ? 'not expressible as a path set' : 'undefined'})`);
    return v || [];
  };
  for (const b of blocks) {
    if (!EXPRESS_UPSTREAM.test(b.body)) continue;
    const what = `${b.kind}${b.matcher ? ' ' + b.matcher : ''}`;
    if (b.kind === 'handle_path' || /(^|\n)\s*(uri|rewrite)\b/.test(b.body)) { out.unresolved.push(`${what} (rewrites the path Express sees)`); continue; }
    out.push(...matcherPaths(b.matcher, what));
  }
  for (const tok of siteProxies) out.push(...matcherPaths(tok, 'reverse_proxy'));
  return out;
}

// ───────────────────────────── TypeScript corpus + lexical resolution ─────────────────────────────

class Corpus {
  constructor(root) { this.root = root; this.files = new Map(); }
  sf(rel) {
    if (!this.files.has(rel)) {
      const abs = path.join(this.root, rel);
      if (!fs.existsSync(abs)) { this.files.set(rel, null); return null; }
      const kind = rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
      this.files.set(rel, ts.createSourceFile(rel, fs.readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true, kind));
    }
    return this.files.get(rel);
  }
  parseErrors(rel) { const sf = this.sf(rel); return sf && sf.parseDiagnostics ? sf.parseDiagnostics.length : 0; }
  moduleFile(fromRel, spec) {
    if (!spec.startsWith('.')) return aliasFile(spec); // a tsconfig / package.json alias into our own tree
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec)).replace(/\.(m|c)?js$/, '');
    for (const cand of [...SRC_EXT.map((x) => base + x), ...SRC_EXT.map((x) => `${base}/index${x}`)]) if (this.sf(cand)) return cand;
    return null;
  }
}

const unwrap = (n) => {
  while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n)
    || (ts.isTypeAssertionExpression && ts.isTypeAssertionExpression(n)) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(n)))) n = n.expression;
  return n;
};
/** Source text of a node for a message: one line, bounded. */
const snippet = (n, len) => n.getText(sfOf(n)).replace(/\s+/g, ' ').slice(0, len);
const isStrLit = (n) => Boolean(n) && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n));
const sfOf = (n) => n.getSourceFile();

function bindsName(nameNode, name) {
  if (ts.isIdentifier(nameNode)) return nameNode.text === name;
  if (ts.isObjectBindingPattern(nameNode) || ts.isArrayBindingPattern(nameNode)) {
    return nameNode.elements.some((el) => !ts.isOmittedExpression(el) && bindsName(el.name, name));
  }
  return false;
}

/** `await import('<spec>')` / `require('<spec>')` → '<spec>', else null. */
function dynamicImportSpec(init) {
  let e = unwrap(init);
  if (e && ts.isAwaitExpression(e)) e = unwrap(e.expression);
  if (!e || !ts.isCallExpression(e) || e.arguments.length !== 1 || !isStrLit(unwrap(e.arguments[0]))) return null;
  const isImport = e.expression.kind === ts.SyntaxKind.ImportKeyword;
  const isRequire = ts.isIdentifier(e.expression) && e.expression.text === 'require';
  return isImport || isRequire ? unwrap(e.arguments[0]).text : null;
}

/** The initializer of the const an identifier resolves to — lexically, or through a relative import. */
function constBindingInit(id, depth = 0) {
  const b = resolveIdent(id);
  if (b && b.kind === 'var' && b.isConst && b.init) return b.init;
  if (b && b.kind === 'import' && isLocalSpec(b.spec) && CORPUS && depth < 6) {
    const f = CORPUS.moduleFile(sfOf(id).fileName, b.spec);
    const e = f ? exportOf(CORPUS, f, b.imported) : null;
    if (e && e.kind === 'var' && e.isConst && e.init) return e.init;
  }
  return null;
}
/** A string an expression is provably equal to (literals, consts, templates / `+` of those), or null. */
function constString(expr, depth = 0) {
  const n = unwrap(expr);
  if (!n || depth > 8) return null;
  if (isStrLit(n)) return n.text;
  if (ts.isTemplateExpression(n)) {
    let out = n.head.text;
    for (const sp of n.templateSpans) { const v = constString(sp.expression, depth + 1); if (v === null) return null; out += v + sp.literal.text; }
    return out;
  }
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const a = constString(n.left, depth + 1); const b = a === null ? null : constString(n.right, depth + 1);
    return a === null || b === null ? null : a + b;
  }
  if (ts.isIdentifier(n)) { const init = constBindingInit(n, depth); return init ? constString(init, depth + 1) : null; }
  if (ts.isPropertyAccessExpression(n) || (ts.isElementAccessExpression(n) && isStrLit(unwrap(n.argumentExpression)))) {
    const key = ts.isPropertyAccessExpression(n) ? n.name.text : unwrap(n.argumentExpression).text;
    const base = unwrap(n.expression);
    // A string enum member (`Paths.Account`), declared here or imported.
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(base)) {
      let eb = resolveIdent(base);
      if (eb && eb.kind === 'import' && isLocalSpec(eb.spec) && CORPUS) { const f = CORPUS.moduleFile(sfOf(base).fileName, eb.spec); eb = f ? exportOf(CORPUS, f, eb.imported) : null; }
      if (eb && eb.kind === 'enum') { const mem = eb.decl.members.find((mm) => (ts.isIdentifier(mm.name) || ts.isStringLiteral(mm.name)) && mm.name.text === key); return mem && mem.initializer ? constString(mem.initializer, depth + 1) : null; }
    }
    const obj = constObjectOf(base, depth);
    if (!obj || obj.properties.some((pp) => ts.isSpreadAssignment(pp))) return null;
    const p = obj.properties.find((pp) => ts.isPropertyAssignment(pp) && pp.name && (ts.isIdentifier(pp.name) || ts.isStringLiteral(pp.name)) && pp.name.text === key);
    return p ? constString(p.initializer, depth + 1) : null;
  }
  return null;
}
/** The object literal a const (or a property of one — `ROUTES.account`) provably is, or null. */
function constObjectOf(expr, depth = 0) {
  const n = unwrap(expr);
  if (!n || depth > 8) return null;
  if (ts.isObjectLiteralExpression(n)) return n;
  if (ts.isIdentifier(n)) { if (constMutated(n)) return null; const init = constBindingInit(n, depth); return init ? constObjectOf(init, depth + 1) : null; }
  if (ts.isPropertyAccessExpression(n)) {
    const o = constObjectOf(n.expression, depth + 1);
    if (!o || o.properties.some((pp) => ts.isSpreadAssignment(pp))) return null;
    const p = o.properties.find((pp) => ts.isPropertyAssignment(pp) && pp.name && (ts.isIdentifier(pp.name) || ts.isStringLiteral(pp.name)) && pp.name.text === n.name.text);
    return p ? constObjectOf(p.initializer, depth + 1) : null;
  }
  return null;
}
/**
 * Every number an expression can be — a literal, a const, a ternary / `??` / `||` of those, a helper
 * parameter read through `bound` (or its default when the caller omitted it) — or null (unknown).
 */
function numberSet(expr, bound, depth = 0) {
  const n = unwrap(expr);
  if (!n || depth > 8) return null;
  if (ts.isNumericLiteral(n)) return [Number(n.text)];
  if (ts.isConditionalExpression(n)) { const a = numberSet(n.whenTrue, bound, depth + 1); const b = numberSet(n.whenFalse, bound, depth + 1); return a && b ? [...a, ...b] : null; }
  if (ts.isBinaryExpression(n) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(n.operatorToken.kind)) {
    const a = numberSet(n.left, bound, depth + 1); const b = numberSet(n.right, bound, depth + 1); return a && b ? [...a, ...b] : null;
  }
  if (ts.isIdentifier(n)) {
    const b = resolveIdent(n);
    if (b && b.kind === 'param') {
      const pn = b.fn.parameters[b.index];
      if (bound && bound.has(pn)) { const a = bound.get(pn); return numberSet(a.expr, a.bound, depth + 1); }
      return pn.initializer && !paramReassigned(b.fn, pn) ? numberSet(pn.initializer, null, depth + 1) : null;
    }
    const init = constBindingInit(n, depth);
    return init ? numberSet(init, bound, depth + 1) : null;
  }
  return null;
}
/** One status from a set: the number when there is exactly one, NaN otherwise (followed as BOTH methods). */
const oneStatus = (set) => (set && new Set(set).size === 1 ? set[0] : NaN);
/** A number an expression is provably equal to, else NaN (a status the gate cannot read). */
function constNumber(expr, depth = 0) {
  const n = unwrap(expr);
  if (!n || depth > 8) return NaN;
  if (ts.isNumericLiteral(n)) return Number(n.text);
  if (ts.isIdentifier(n)) { const init = constBindingInit(n, depth); return init ? constNumber(init, depth + 1) : NaN; }
  return NaN;
}
/** Is a const object ever mutated (`X.k = …`, `X[k] = …`, `Object.assign(X, …)`) in its own file? Then it is not its initializer. */
const MUTATED = new Map();
function constMutated(id) {
  const ck = `${sfOf(id).fileName}#${id.text}`;
  if (MUTATED.has(ck)) return MUTATED.get(ck);
  const name = id.text; let hit = false;
  const visit = (n) => {
    if (hit) return;
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const l = unwrap(n.left);
      if ((ts.isPropertyAccessExpression(l) || ts.isElementAccessExpression(l)) && rootIdent(l) && rootIdent(l).text === name) hit = true;
    }
    if (ts.isCallExpression(n) && n.expression.getText(sfOf(n)) === 'Object.assign' && n.arguments[0] && ts.isIdentifier(unwrap(n.arguments[0])) && unwrap(n.arguments[0]).text === name) hit = true;
    if (ts.isDeleteExpression(n) && rootIdent(n.expression) && rootIdent(n.expression).text === name) hit = true;
    ts.forEachChild(n, visit);
  };
  visit(sfOf(id));
  MUTATED.set(ck, hit);
  return hit;
}
/** The array literal a for-of loop iterates, for the loop that binds `id` — or null. */
function forOfBinding(id) {
  for (let n = id.parent; n; n = n.parent) {
    if (ts.isForOfStatement(n) && n.initializer && ts.isVariableDeclarationList(n.initializer)) {
      const d = n.initializer.declarations[0];
      if (d && bindsName(d.name, id.text)) return { decl: d, iterated: n.expression };
    }
    if (ts.isFunctionLike(n)) return null;
  }
  return null;
}
/**
 * Paths a for-of loop variable takes when it iterates a const array literal — of strings, of objects
 * destructured, and of `...X.map((t) => ({ path: `/x/${t}` }))` spreads — with unreadable parts as
 * MULTI holes (`/x402/${t}` → `/x402/⟦⟧`). A loop-built route is then PLACED, not dropped.
 */
function forOfPaths(id) {
  const fb = forOfBinding(id);
  if (!fb) return null;
  let arr = unwrap(fb.iterated);
  if (arr && ts.isIdentifier(arr)) arr = unwrap(constBindingInit(arr));
  if (!arr || !ts.isArrayLiteralExpression(arr)) return null;
  const itemValue = (e0) => {
    const e = unwrap(e0);
    if (!e) return null;
    if (ts.isIdentifier(fb.decl.name)) return renderPath(e);
    if (!ts.isObjectBindingPattern(fb.decl.name) || !ts.isObjectLiteralExpression(e)) return null;
    const bel = fb.decl.name.elements.find((x) => ts.isIdentifier(x.name) && x.name.text === id.text);
    if (!bel) return null;
    const key = bel.propertyName && (ts.isIdentifier(bel.propertyName) || ts.isStringLiteral(bel.propertyName)) ? bel.propertyName.text : bel.name.text;
    const p = e.properties.find((pp) => ts.isPropertyAssignment(pp) && pp.name && (ts.isIdentifier(pp.name) || ts.isStringLiteral(pp.name)) && pp.name.text === key);
    return p ? renderPath(p.initializer) : null;
  };
  const out = [];
  for (const el of arr.elements) {
    if (ts.isSpreadElement(el)) {
      const call = unwrap(el.expression);
      if (!call || !ts.isCallExpression(call) || memberName(call.expression) !== 'map' || !call.arguments[0]) return null;
      const cb = unwrap(call.arguments[0]);
      if (!ts.isArrowFunction(cb) && !ts.isFunctionExpression(cb)) return null;
      const body = ts.isBlock(cb.body) ? cb.body.statements.find((x) => ts.isReturnStatement(x))?.expression : cb.body;
      const v = body ? itemValue(body) : null;
      if (v === null) return null;
      out.push(v); continue;
    }
    const v = itemValue(el);
    if (v === null) return null;
    out.push(v);
  }
  return out;
}

/** Keys of `for (const [k] of Object.entries(X))` / `Object.keys(X)` when X is a readable, unmutated const object. */
function forOfObjectKeys(id) {
  const fb = forOfBinding(id);
  if (!fb) return null;
  const it = unwrap(fb.iterated);
  if (!it || !ts.isCallExpression(it) || !/^Object\.(entries|keys)$/.test(it.expression.getText(sfOf(it))) || !it.arguments[0]) return null;
  const isKey = ts.isIdentifier(fb.decl.name) ? /keys$/.test(it.expression.getText(sfOf(it)))
    : ts.isArrayBindingPattern(fb.decl.name) && fb.decl.name.elements[0] && !ts.isOmittedExpression(fb.decl.name.elements[0]) && ts.isIdentifier(fb.decl.name.elements[0].name) && fb.decl.name.elements[0].name.text === id.text;
  if (!isKey) return null;
  const src = unwrap(it.arguments[0]);
  const obj = src && ts.isIdentifier(src) && !constMutated(src) ? unwrap(constBindingInit(src)) : null;
  if (!obj || !ts.isObjectLiteralExpression(obj)) return null;
  const keys = [];
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) return null;
    if (!p.name || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) return null;
    keys.push(p.name.text);
  }
  return keys;
}

/** The binding a declaration-list statement set gives `name`, if any. */
function declaredInStatements(stmts, name) {
  for (const st of stmts) {
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        // `const { default: express } = await import('express')` binds an IMPORT, exactly like a static one.
        const spec = d.initializer ? dynamicImportSpec(d.initializer) : null;
        if (ts.isIdentifier(d.name) && d.name.text === name) {
          if (spec !== null) return { kind: 'import', spec, imported: '*', from: st };
          return { kind: 'var', decl: d, init: d.initializer, isConst: Boolean(st.declarationList.flags & ts.NodeFlags.Const) };
        }
        if (spec !== null && ts.isObjectBindingPattern(d.name)) {
          for (const el of d.name.elements) {
            if (el.dotDotDotToken || !ts.isIdentifier(el.name) || el.name.text !== name) continue;
            const pn = el.propertyName;
            const imported = !pn ? el.name.text : (ts.isIdentifier(pn) || ts.isStringLiteral(pn)) ? pn.text : null;
            if (imported !== null) return { kind: 'import', spec, imported, from: st };
          }
        }
        if (!ts.isIdentifier(d.name) && bindsName(d.name, name)) return { kind: 'binding' };
      }
    } else if (ts.isFunctionDeclaration(st) && st.name && st.name.text === name) {
      return st.body ? { kind: 'function', fn: st } : { kind: 'binding' };
    } else if (ts.isClassDeclaration(st) && st.name && st.name.text === name) {
      return { kind: 'class', cls: st };
    } else if (ts.isEnumDeclaration(st) && st.name.text === name) {
      return { kind: 'enum', decl: st };
    } else if (ts.isImportDeclaration(st) && st.importClause && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text; const ic = st.importClause;
      if (ic.name && ic.name.text === name) return { kind: 'import', spec, imported: 'default', from: st };
      const nb = ic.namedBindings;
      if (nb && ts.isNamespaceImport(nb) && nb.name.text === name) return { kind: 'import', spec, imported: '*', from: st };
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) if (el.name.text === name) return { kind: 'import', spec, imported: (el.propertyName || el.name).text, from: st };
    }
  }
  return null;
}

/** Does a function body declare `var name` anywhere (not inside a nested function)? */
function hoistsVar(body, name) {
  let hit = false;
  const visit = (n) => {
    if (hit || (n !== body && ts.isFunctionLike(n))) return;
    if (ts.isVariableDeclarationList(n) && !(n.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) && n.declarations.some((d) => bindsName(d.name, name))) { hit = true; return; }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return hit;
}

/** Resolve an identifier to its NEAREST lexical binding (parameters and destructuring shadow outer consts). */
function resolveIdent(id) {
  const name = id.text;
  for (let n = id.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n) && n.parameters) {
      for (let i = 0; i < n.parameters.length; i++) {
        const p = n.parameters[i];
        if (bindsName(p.name, name)) return ts.isIdentifier(p.name) ? { kind: 'param', fn: n, index: i } : { kind: 'binding' };
      }
      if (ts.isFunctionExpression(n) && n.name && n.name.text === name) return { kind: 'function', fn: n };
      // `var` is FUNCTION-scoped: one declared in a nested block (try / if) still shadows an outer const.
      if (n.body && hoistsVar(n.body, name)) return { kind: 'var', isConst: false, init: null };
    }
    if (ts.isCatchClause(n) && n.variableDeclaration && bindsName(n.variableDeclaration.name, name)) return { kind: 'binding' };
    if ((ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n)) && n.initializer && ts.isVariableDeclarationList(n.initializer)
      && n.initializer.declarations.some((d) => bindsName(d.name, name))) return { kind: 'binding' };
    const stmts = ts.isSourceFile(n) || ts.isBlock(n) || ts.isModuleBlock(n) || ts.isCaseClause(n) || ts.isDefaultClause(n) ? n.statements : null;
    if (stmts) { const b = declaredInStatements(stmts, name); if (b) return b; }
  }
  return null;
}

/** A module's export named `name` (or 'default'): { kind: 'function'|'var'|'expr'|'import', … } | null. */
function exportOf(corpus, rel, name, depth = 0) {
  const sf = corpus.sf(rel);
  if (!sf || depth > 6) return null;
  const stars = [];
  for (const st of sf.statements) {
    if (name === 'default' && ts.isExportAssignment(st)) {
      const e = unwrap(st.expression);
      if (ts.isIdentifier(e)) { const own0 = declaredInStatements(sf.statements, e.text); return own0 ? { ...own0, file: rel } : null; }
      return { kind: 'expr', expr: e, file: rel };
    }
    if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) && !st.exportClause) { stars.push(st.moduleSpecifier.text); continue; }
    if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamespaceExport(st.exportClause) && st.exportClause.name.text === name && st.moduleSpecifier) {
      return { kind: 'import', spec: st.moduleSpecifier.text, imported: '*', from: st };
    }
    if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) {
        if (el.name.text !== name) continue;
        const local = (el.propertyName || el.name).text;
        if (st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
          const f = corpus.moduleFile(rel, st.moduleSpecifier.text);
          return f ? exportOf(corpus, f, local, depth + 1) : null;
        }
        const own1 = declaredInStatements(sf.statements, local);
        return own1 ? { ...own1, file: rel } : null;
      }
    }
    const mods = ts.canHaveModifiers && ts.canHaveModifiers(st) ? ts.getModifiers(st) ?? [] : st.modifiers ?? [];
    const isDefault = mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (isDefault && name === 'default' && ts.isFunctionDeclaration(st)) return { kind: 'function', fn: st };
  }
  const own = declaredInStatements(sf.statements, name);
  if (own) return { ...own, file: rel };
  // `export * from './x'` — a barrel re-exports every NAMED export (never `default`) of its target.
  if (name !== 'default') {
    for (const spec of stars) {
      const f = isLocalSpec(spec) ? corpus.moduleFile(rel, spec) : null;
      const e = f ? exportOf(corpus, f, name, depth + 1) : null;
      if (e) return e;
    }
  }
  return null;
}

/**
 * Resolve a handler/middleware expression to the functions that run:
 * { fns: [fnNode], framework: bool, unresolved: string|null }. Package code is `framework` (not ours
 * to read) — but the ARGUMENTS we hand a package (`asyncHandler(fn)`, `rateLimit({ handler })`) are
 * ours and run, so they are resolved; and a LOCAL wrapper's result is what it RETURNS.
 */
function resolveFunctions(corpus, expr, depth = 0) {
  const n = unwrap(expr);
  if (!n || depth > 8) return { fns: [], unresolved: 'resolution depth exceeded' };
  if (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) return { fns: [n] };
  if (ts.isSpreadElement(n)) return resolveFunctions(corpus, n.expression, depth + 1); // app.post(p, ...rules, h)
  if (ts.isArrayLiteralExpression(n)) {
    const parts = n.elements.map((e) => resolveFunctions(corpus, ts.isSpreadElement(e) ? e.expression : e, depth + 1));
    const bad = parts.find((p) => p.unresolved);
    return bad ? bad : { fns: parts.flatMap((p) => p.fns), bounds: parts.flatMap((p) => p.fns.map((_, i) => (p.bounds && p.bounds[i]) || null)), framework: parts.every((p) => p.framework) };
  }
  // `ctrl.save.bind(ctrl)` is `ctrl.save`.
  if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'bind') return resolveFunctions(corpus, n.expression.expression, depth + 1);
  if (ts.isCallExpression(n)) {
    const alias = aliasSpecOf(n.expression);
    if (alias) return { fns: [], unresolved: `\`${snippet(n.expression, 40)}\` is imported through the path alias '${alias}', which the gate does not resolve` };
    const argFns = [];
    const gRoot = rootIdent(n.expression);
    const pkg = isPackageRef(corpus, n.expression) || Boolean(gRoot && !resolveIdent(gRoot));
    // A package is handed config as often as functions: a member read there (`process.env.X`, `cfg.dir`) is a value.
    for (const a of n.arguments) { const r = valueFunctions(corpus, a, depth + 1, !(pkg && (ts.isPropertyAccessExpression(unwrap(a)) || ts.isElementAccessExpression(unwrap(a))))); if (r.unresolved) return r; argFns.push(...r.fns); }
    if (pkg) return argFns.length ? { fns: argFns } : { fns: [], framework: true }; // express.json(), cors()
    const callee = resolveFunctions(corpus, n.expression, depth + 1);
    if (callee.unresolved) return { fns: [], unresolved: `a call to \`${snippet(n.expression, 40)}\`, which the gate cannot read (${callee.unresolved})` };
    // A local FACTORY: what it returns runs with the factory's parameters bound to this call's arguments
    // (`requireLogin('/account/login')`), or to their defaults when omitted.
    const fns = []; const bounds = [];
    for (const f of callee.fns) {
      const fb = new Map();
      (f.parameters || []).forEach((p, i) => {
        if (paramReassigned(f, p)) return;
        if (n.arguments[i]) fb.set(p, { expr: n.arguments[i], bound: null });
        else if (p.initializer) fb.set(p, { expr: p.initializer, bound: null });
      });
      for (const rf of returnedFunctions(corpus, f, depth + 1)) { fns.push(rf); bounds.push(fb); }
    }
    for (const af of argFns) { fns.push(af); bounds.push(null); }
    return fns.length || callee.framework ? { fns, bounds, framework: !fns.length } : { fns: [], unresolved: `a call to \`${snippet(n.expression, 40)}\` that hands over no readable function` };
  }
  if (ts.isIdentifier(n)) {
    const b = resolveIdent(n);
    return fromBinding(corpus, b, n, depth);
  }
  if (ts.isPropertyAccessExpression(n)) {
    if (isPackageRef(corpus, n)) return { fns: [], framework: true };
    const alias = aliasSpecOf(n);
    if (alias) return { fns: [], unresolved: `\`${snippet(n, 40)}\` is imported through the path alias '${alias}', which the gate does not resolve` };
    const m = memberOf(corpus, n.expression, n.name.text, n, depth);
    if (m) return m;
    return { fns: [], unresolved: `\`${snippet(n, 40)}\` could not be read to a function` };
  }
  return { fns: [], unresolved: `\`${snippet(n, 40)}\` could not be read to a function` };
}

/** The class an expression names — a local declaration, or one imported through a relative module. */
function classOf(corpus, expr) {
  const n = unwrap(expr);
  if (!n || !ts.isIdentifier(n)) return null;
  const b = resolveIdent(n);
  if (b && b.kind === 'class') return b.cls;
  if (b && b.kind === 'import' && isLocalSpec(b.spec)) {
    const f = corpus.moduleFile(sfOf(n).fileName, b.spec);
    const e = f ? exportOf(corpus, f, b.imported) : null;
    return e && e.kind === 'class' ? e.cls : null;
  }
  return null;
}
/**
 * What a member read `obj.name` yields when `obj` is readable: an object literal (declared here,
 * imported, or `export default { save }` — methods, properties, shorthands), a namespace import, or a
 * `new C()` instance (a method, or an arrow / function property). null when it is not readable.
 */
function memberOf(corpus, objExpr, name, at, depth) {
  const o = unwrap(objExpr);
  if (!o || !ts.isIdentifier(o) || depth > 8) return null;
  const b = resolveIdent(o);
  if (b && b.kind === 'import' && b.imported === '*' && isLocalSpec(b.spec)) {
    const f = corpus.moduleFile(sfOf(o).fileName, b.spec);
    return f ? fromBinding(corpus, exportOf(corpus, f, name), at, depth) : null;
  }
  let init = null;
  if (b && b.kind === 'var' && b.init) init = b.init;
  if (b && b.kind === 'import' && isLocalSpec(b.spec)) {
    const f = corpus.moduleFile(sfOf(o).fileName, b.spec);
    const e = f ? exportOf(corpus, f, b.imported) : null;
    if (e && e.kind === 'expr') init = e.expr;
    if (e && e.kind === 'var' && e.init) init = e.init;
  }
  const lit = init ? unwrap(init) : null;
  if (!lit) return null;
  if (ts.isObjectLiteralExpression(lit)) {
    const p = lit.properties.find((pp) => pp.name && (ts.isIdentifier(pp.name) || ts.isStringLiteral(pp.name)) && pp.name.text === name);
    if (!p) return null;
    if (ts.isMethodDeclaration(p)) return { fns: [p] };
    if (ts.isPropertyAssignment(p)) return resolveFunctions(corpus, p.initializer, depth + 1);
    if (ts.isShorthandPropertyAssignment(p)) return resolveFunctions(corpus, p.name, depth + 1);
    return null;
  }
  if (ts.isNewExpression(lit)) {
    const cls = classOf(corpus, lit.expression);
    const mem = cls ? cls.members.find((mm) => mm.name && ts.isIdentifier(mm.name) && mm.name.text === name) : null;
    if (mem && ts.isMethodDeclaration(mem) && mem.body) return { fns: [mem] };
    if (mem && ts.isPropertyDeclaration(mem) && mem.initializer) return resolveFunctions(corpus, mem.initializer, depth + 1);
    return null;
  }
  return null;
}

/**
 * The functions a VALUE carries into a call: a function, an object / array of them, a binding to one.
 * A literal, a config scalar, or a global carries none. A binding the gate cannot see through (a
 * parameter, a destructured name, an instance member) is unresolved when handed DIRECTLY to the
 * call (`asyncHandler(controller.portal)` may be a handler) and ignored inside a config object.
 */
function valueFunctions(corpus, expr, depth, direct = true) {
  const n = unwrap(expr);
  if (!n || depth > 8) return { fns: [], unresolved: 'resolution depth exceeded' };
  if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) return { fns: [n] };
  const many = (items) => {
    const fns = [];
    for (const it of items) { const r = valueFunctions(corpus, it, depth + 1, false); if (r.unresolved) return r; fns.push(...r.fns); }
    return { fns };
  };
  if (ts.isArrayLiteralExpression(n)) return many(n.elements.map((e) => (ts.isSpreadElement(e) ? e.expression : e)));
  if (ts.isObjectLiteralExpression(n)) {
    const fns = []; const vals = [];
    for (const p of n.properties) {
      if (ts.isMethodDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) fns.push(p);
      else if (ts.isPropertyAssignment(p)) vals.push(p.initializer);
      else if (ts.isShorthandPropertyAssignment(p)) vals.push(p.name);
      else if (ts.isSpreadAssignment(p)) vals.push(p.expression);
    }
    const r = many(vals);
    return r.unresolved ? r : { fns: [...fns, ...r.fns] };
  }
  const opaque = (why) => (direct ? { fns: [], unresolved: why } : { fns: [] });
  if (ts.isIdentifier(n)) {
    const b = resolveIdent(n);
    if (!b) return { fns: [] }; // a global (`__dirname`, `process`) — never our handler
    if (b.kind === 'function') return { fns: [b.fn] };
    if (b.kind === 'var') return b.init ? valueFunctions(corpus, b.init, depth + 1, false) : { fns: [] };
    if (b.kind === 'import') {
      if (isNpmSpec(b.spec)) return { fns: [] };
      if (!isLocalSpec(b.spec)) return { fns: [], unresolved: `\`${n.text}\` is imported through the path alias '${b.spec}', which the gate does not resolve` };
      const f = corpus.moduleFile(sfOf(n).fileName, b.spec);
      const e = f ? exportOf(corpus, f, b.imported) : null;
      if (!e) return { fns: [], unresolved: `\`${n.text}\` could not be followed into '${b.spec}'` };
      if (e.kind === 'function') return { fns: [e.fn] };
      if (e.kind === 'var') return e.init ? valueFunctions(corpus, e.init, depth + 1, false) : { fns: [] };
      if (e.kind === 'expr') return valueFunctions(corpus, e.expr, depth + 1, false);
      if (e.kind === 'import') { const r = fromBinding(corpus, e, e.from, depth + 1); return r.framework ? { fns: [] } : r; }
      return { fns: [] };
    }
    return opaque(`\`${n.text}\` is a ${b.kind} binding the gate cannot see through — it may carry a handler`);
  }
  if (ts.isCallExpression(n)) { const r = resolveFunctions(corpus, n, depth + 1); return r.unresolved ? opaque(r.unresolved) : { fns: r.fns }; }
  if (ts.isPropertyAccessExpression(n)) {
    if (isPackageRef(corpus, n)) return { fns: [] };
    const root = rootIdent(n);
    if (root && !resolveIdent(root)) return { fns: [] }; // process.env.X, import.meta: a global value, never our handler
    const obj = unwrap(n.expression);
    const init = ts.isIdentifier(obj) ? constBindingInit(obj) : null;
    if (init && ts.isObjectLiteralExpression(unwrap(init))) {
      const lit = unwrap(init);
      const p = lit.properties.find((pp) => (ts.isPropertyAssignment(pp) || ts.isMethodDeclaration(pp) || ts.isShorthandPropertyAssignment(pp)) && pp.name && ts.isIdentifier(pp.name) && pp.name.text === n.name.text);
      if (p) return ts.isMethodDeclaration(p) ? { fns: [p] } : valueFunctions(corpus, ts.isShorthandPropertyAssignment(p) ? p.name : p.initializer, depth + 1, direct);
      if (!lit.properties.some((pp) => ts.isSpreadAssignment(pp))) return { fns: [] }; // reading a key the object does not have
    }
    const r = resolveFunctions(corpus, n, depth + 1);
    return r.unresolved ? opaque(r.unresolved) : { fns: r.fns };
  }
  return { fns: [] };
}

/** Functions a function RETURNS (`(fn) => async (req, res) => …`, `return handler`): what a local wrapper hands Express. */
function returnedFunctions(corpus, fn, depth) {
  const out = [];
  const take = (e) => { const r = valueFunctions(corpus, e, depth + 1, false); if (!r.unresolved) out.push(...r.fns); };
  if (fn.body && !ts.isBlock(fn.body)) take(fn.body);
  const visit = (x) => {
    if (x !== fn.body && ts.isFunctionLike(x)) return;
    if (ts.isReturnStatement(x) && x.expression) take(x.expression);
    ts.forEachChild(x, visit);
  };
  if (fn.body && ts.isBlock(fn.body)) visit(fn.body);
  return out;
}

function fromBinding(corpus, b, at, depth) {
  const what = snippet(at, 40);
  if (!b) return { fns: [], unresolved: `\`${what}\` has no visible declaration` };
  if (b.kind === 'function') return { fns: [b.fn] };
  if (b.kind === 'var') return b.init ? resolveFunctions(corpus, b.init, depth + 1) : { fns: [], unresolved: `\`${what}\` is declared without an initializer` };
  if (b.kind === 'expr') return resolveFunctions(corpus, b.expr, depth + 1);
  if (b.kind === 'import') {
    if (!isLocalSpec(b.spec)) {
      return isNpmSpec(b.spec) ? { fns: [], framework: true }
        : { fns: [], unresolved: `\`${what}\` is imported through the path alias '${b.spec}', which the gate does not resolve` };
    }
    const f = corpus.moduleFile(sfOf(at).fileName, b.spec);
    if (!f) return { fns: [], unresolved: `\`${what}\` imports '${b.spec}', which is not in the tree` };
    const e = exportOf(corpus, f, b.imported);
    if (!e) return { fns: [], unresolved: `\`${what}\` is not exported by ${f}` };
    if (e.kind === 'var' && e.init) return resolveFunctions(corpus, e.init, depth + 1);
    if (e.kind === 'function') return { fns: [e.fn] };
    if (e.kind === 'expr') return resolveFunctions(corpus, e.expr, depth + 1);
    if (e.kind === 'import') return fromBinding(corpus, e, e.from, depth + 1);
    return { fns: [], unresolved: `\`${what}\` could not be read to a function in ${f}` };
  }
  return { fns: [], unresolved: `\`${what}\` is a ${b.kind} binding, not a readable function` };
}

/** The import binding an access/call chain is rooted in, or null. */
function rootImport(expr, depth = 0) {
  let e = unwrap(expr);
  while (e && (ts.isPropertyAccessExpression(e) || ts.isCallExpression(e) || ts.isElementAccessExpression(e) || ts.isNewExpression(e) || ts.isAwaitExpression(e))) e = unwrap(e.expression);
  if (!e || !ts.isIdentifier(e)) return null;
  const b = resolveIdent(e);
  if (b && b.kind === 'import' && isLocalSpec(b.spec) && CORPUS && depth < 3) {
    const f = CORPUS.moduleFile(sfOf(e).fileName, b.spec);
    const ex = f ? exportOf(CORPUS, f, b.imported) : null;
    if (ex && ex.kind === 'var' && ex.isConst && ex.init) { const r = rootImport(ex.init, depth + 1); if (r && isNpmSpec(r.spec)) return r; }
    return b;
  }
  if (b && b.kind === 'import') return b;
  // One step through a const whose initializer is itself rooted in an import: `const upload = multer()`.
  if (b && b.kind === 'var' && b.isConst && b.init && depth < 3) {
    const i = unwrap(b.init);
    if (i && (ts.isCallExpression(i) || ts.isNewExpression(i) || ts.isAwaitExpression(i) || ts.isPropertyAccessExpression(i))) return rootImport(i, depth + 1);
  }
  return null;
}
/** Rooted in a PACKAGE import? Package code is not ours to read (its arguments still are). */
function isPackageRef(corpus, expr) { const b = rootImport(expr); return Boolean(b && isNpmSpec(b.spec)); }
/** Rooted in a path-ALIAS import (`#lib/x`, `@/x`)? That is our own code, under a name the gate does not resolve. */
function aliasSpecOf(expr) { const b = rootImport(expr); return b && !isLocalSpec(b.spec) && !isNpmSpec(b.spec) ? b.spec : null; }

// ───────────────────────────── response tracking + Location extraction ─────────────────────────────

/** Root identifier of an access/call chain: `res.status(303).location(x)` → `res`. */
function rootIdent(n) {
  let e = n;
  while (e) {
    if (ts.isIdentifier(e)) return e;
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isCallExpression(e)
      || ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)) e = e.expression;
    else return null;
  }
  return null;
}
const memberName = (callee) => (ts.isPropertyAccessExpression(callee) ? callee.name.text
  : ts.isElementAccessExpression(callee) && isStrLit(unwrap(callee.argumentExpression)) ? unwrap(callee.argumentExpression).text : null);

/** Status set on the same chain as a Location write (`.status(307).location(x)`): a number, NaN (set, not readable), or null (none). */
function chainStatus(call, bound = null) {
  let e = call.expression;
  while (e && (ts.isPropertyAccessExpression(e) || ts.isCallExpression(e) || ts.isElementAccessExpression(e))) {
    if (ts.isCallExpression(e) && memberName(e.expression) === 'status' && e.arguments[0]) return oneStatus(numberSet(e.arguments[0], bound));
    e = e.expression;
  }
  return null;
}

/** Is parameter `p` of `fn` ever assigned inside `fn`? Then at a Location it is not the caller's argument. */
function paramReassigned(fn, p) {
  if (!ts.isIdentifier(p.name) || !fn.body) return false;
  const name = p.name.text; let hit = false;
  const visit = (n) => {
    if (hit) return;
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      && ts.isIdentifier(unwrap(n.left)) && unwrap(n.left).text === name) {
      const b = resolveIdent(unwrap(n.left));
      if (b && b.kind === 'param' && b.fn === fn) hit = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(fn.body);
  return hit;
}

/** Every name a header-name expression can take (lower-cased), or undefined when it is not a readable constant. */
function headerNames(expr) {
  const n = unwrap(expr);
  const c = constString(n);
  if (c !== null) return [c.toLowerCase()];
  if (ts.isConditionalExpression(n)) { const a = headerNames(n.whenTrue); const b = headerNames(n.whenFalse); return a && b ? [...a, ...b] : undefined; }
  if (ts.isIdentifier(n)) { const keys = forOfObjectKeys(n); if (keys) return keys.map((k) => k.toLowerCase()); }
  return undefined;
}

/**
 * Scan one function for Locations it can emit on the response. `handles` say where the response
 * arrives: `{ index, path }` — parameter `index`, then property `path` (`[]` = the response itself,
 * `['res']` = `req.res`, `['ctx', 'res']` = an object carrying it). `bound` maps THIS function's
 * parameter NODES to the caller's argument expressions.
 * Yields { target, status, file, line, bound }; { unprovable } for a Location it cannot read on a
 * response that may be a 3xx; { escapes } when the response is handed to code it cannot read.
 * `stack` guards RECURSION only: a helper called from two sites is scanned once PER SITE, with that
 * site's arguments — a visited-set made the verdict depend on which call came first.
 */
function scanFunction(corpus, fn, handles, bound, depth, out, stack) {
  if (stack.has(fn)) return;
  stack.add(fn);
  try { scanBody(corpus, fn, handles, bound, depth, out, stack); } finally { stack.delete(fn); }
}
/** Where Express hands a handler the response: `res`, and `req.res` (Express sets it). */
const entryHandles = (resIndex) => [{ index: resIndex, path: [] }, ...(resIndex > 0 ? [{ index: resIndex - 1, path: ['res'] }] : [])];
/** `a.b.c` of a property-access chain rooted in an identifier, as ['a', 'b', 'c'], or null. */
function accessPath(e0) {
  const parts = []; let x = unwrap(e0);
  while (x && ts.isPropertyAccessExpression(x)) { parts.unshift(x.name.text); x = unwrap(x.expression); }
  return x && ts.isIdentifier(x) ? [x.text, ...parts] : null;
}

function scanBody(corpus, fn, handles, bound, depth, out, stack) {
  const sf = sfOf(fn);
  // `res` = names holding the response; `resProps` = access paths that ARE the response (`req.res`, `ctx.res`).
  const res = new Set(); const resProps = new Set();
  const bindPath = (nameNode, pth) => {
    if (ts.isIdentifier(nameNode)) { if (!pth.length) res.add(nameNode.text); else resProps.add([nameNode.text, ...pth].join('.')); return; }
    if (ts.isObjectBindingPattern(nameNode) && pth.length) {
      for (const el of nameNode.elements) {
        const key = el.propertyName && (ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName)) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : null;
        if (key === pth[0]) bindPath(el.name, pth.slice(1));
      }
    }
  };
  for (const h of handles) { const p = fn.parameters && fn.parameters[h.index]; if (p) bindPath(p.name, h.path); }
  const isResExpr = (e0) => {
    const e = unwrap(e0);
    if (!e) return false;
    if (ts.isIdentifier(e)) return res.has(e.text);
    const ap = accessPath(e);
    return Boolean(ap && resProps.has(ap.join('.')));
  };
  const redirectFns = new Set();
  // Aliases: `const r = res`, `const r = ctx.res`, `const { res } = ctx`, `const redirect = res.redirect.bind(res)`.
  const collectAliases = (n) => {
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isObjectBindingPattern(n.name)) {
      const ap = accessPath(n.initializer);
      if (ap) for (const rp of [...resProps]) { const parts = rp.split('.'); if (parts.length > ap.length && parts.slice(0, ap.length).join('.') === ap.join('.')) bindPath(n.name, parts.slice(ap.length)); }
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const init = unwrap(n.initializer);
      if (isResExpr(init)) res.add(n.name.text);
      if (ts.isCallExpression(init) && memberName(init.expression) === 'bind' && ts.isPropertyAccessExpression(init.expression)) {
        const target = init.expression.expression;
        const r = rootIdent(target);
        if (r && res.has(r.text) && memberName(target) === 'redirect') redirectFns.add(n.name.text);
      }
    }
    ts.forEachChild(n, collectAliases);
  };
  if (fn.body) { collectAliases(fn.body); collectAliases(fn.body); }
  if (!res.size && !resProps.size) return;
  const onRes = (expr) => {
    const r = rootIdent(expr);
    if (r && res.has(r.text)) return true;
    for (let x = unwrap(expr); x;) {
      if (ts.isPropertyAccessExpression(x) && isResExpr(x)) return true;
      if (ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x) || ts.isCallExpression(x) || ts.isNonNullExpression(x) || ts.isParenthesizedExpression(x)) x = x.expression; else break;
    }
    return false;
  };
  // Where the response travels in a call's arguments: itself, a path under a name that carries it
  // (`req` → `req.res`), or an object literal that holds either (`{ req, res }`, a const `ctx`).
  const handlesFor = (args) => {
    const hs = []; let carriesRes = false;
    const under = (vp, prefix, i) => { for (const rp of resProps) { const parts = rp.split('.'); if (parts.length > vp.length && parts.slice(0, vp.length).join('.') === vp.join('.')) hs.push({ index: i, path: [...prefix, ...parts.slice(vp.length)] }); } };
    args.forEach((a0, i) => {
      const a = unwrap(a0);
      if (!a) return;
      if (isResExpr(a)) { hs.push({ index: i, path: [] }); carriesRes = true; return; }
      const ap = ts.isIdentifier(a) ? [a.text] : accessPath(a);
      if (ap) under(ap, [], i);
      let lit = a;
      if (ts.isIdentifier(a)) { const b = resolveIdent(a); lit = b && b.kind === 'var' && b.init && ts.isObjectLiteralExpression(unwrap(b.init)) ? unwrap(b.init) : null; }
      if (!lit || !ts.isObjectLiteralExpression(lit)) return;
      for (const p of lit.properties) {
        const key = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null;
        const v = ts.isShorthandPropertyAssignment(p) ? p.name : ts.isPropertyAssignment(p) ? unwrap(p.initializer) : null;
        if (!key || !v) continue;
        if (isResExpr(v)) { hs.push({ index: i, path: [key] }); carriesRes = true; continue; }
        const vp = ts.isIdentifier(v) ? [v.text] : accessPath(v);
        if (vp) under(vp, [key], i);
      }
    });
    return { hs, carriesRes };
  };
  const at = (n) => ({ file: sf.fileName, line: lineAt(sf, n.getStart(sf)) });
  // Every status this function writes on the response. A Location without its own status takes it;
  // several different ones, or one that is not a readable constant, is NaN — the hop is then followed
  // under BOTH methods (a 307/308 keeps POST).
  const statuses = [];
  const collectStatus = (n) => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(unwrap(n.left))
      && unwrap(n.left).name.text === 'statusCode' && onRes(unwrap(n.left).expression)) { const v = numberSet(n.right, bound); if (v) statuses.push(...v); else statuses.push(NaN); }
    if (ts.isCallExpression(n) && (ts.isPropertyAccessExpression(n.expression) || ts.isElementAccessExpression(n.expression)) && onRes(n.expression.expression)) {
      const nm = memberName(n.expression);
      if ((nm === 'status' || nm === 'sendStatus' || nm === 'writeHead') && n.arguments[0]) { const v = numberSet(n.arguments[0], bound); if (v) statuses.push(...v); else statuses.push(NaN); }
    }
    ts.forEachChild(n, collectStatus);
  };
  collectStatus(fn.body || fn);
  const known = [...new Set(statuses.filter((x) => !Number.isNaN(x)))];
  const fnStatus = statuses.some((x) => Number.isNaN(x)) || known.length > 1 ? NaN : known.length === 1 ? known[0] : null;
  const may3xx = statuses.some((x) => Number.isNaN(x) || (x >= 300 && x < 400));
  const statusFor = (n) => { const c = chainStatus(n, bound); return c !== null ? c : fnStatus; };
  const risky = (st) => (st === null ? may3xx : Number.isNaN(st) || (st >= 300 && st < 400));
  // Names holding the REQUEST (whose `.res` is the response): `req.originalUrl` is this request's own path.
  const reqs = [...resProps].filter((p) => /^[\w$]+\.res$/.test(p)).map((p) => p.slice(0, -4));
  const push = (target, status, n) => out.push({ target, status, ...at(n), bound, reqs });
  const headerObject = (arg, n, st, depth2 = 0) => {
    let o = unwrap(arg);
    if (ts.isIdentifier(o)) { const init = constMutated(o) ? null : constBindingInit(o); o = init ? unwrap(init) : null; }
    if (!o || !ts.isObjectLiteralExpression(o)) { if (risky(st)) out.push({ unprovable: `headers \`${snippet(unwrap(arg), 40)}\` are not a readable object literal`, ...at(n) }); return; }
    for (const p of o.properties) {
      // `{ ...BASE_HEADERS, … }`: a spread of a readable, unmutated const object is read, not flagged.
      if (ts.isSpreadAssignment(p) && depth2 < 4 && constObjectOf(p.expression)) { headerObject(p.expression, n, st, depth2 + 1); continue; }
      if (ts.isSpreadAssignment(p)) { if (risky(st)) out.push({ unprovable: 'headers object carries a spread the gate cannot read', ...at(n) }); continue; }
      if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) continue;
      const key = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : p.name && ts.isComputedPropertyName(p.name) ? constString(p.name.expression) : null;
      if (key === null) { if (risky(st)) out.push({ unprovable: 'headers object has a computed key', ...at(n) }); continue; }
      if (key.toLowerCase() === 'location') push(ts.isShorthandPropertyAssignment(p) ? p.name : p.initializer, st ?? 302, n);
    }
  };
  const stringy = (e) => { const u = unwrap(e); return Boolean(u) && (constString(u) !== null || ts.isTemplateExpression(u) || (ts.isBinaryExpression(u) && u.operatorToken.kind === ts.SyntaxKind.PlusToken)); };
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      let callee = n.expression; let args = [...n.arguments];
      // res.redirect.call(res, …) / .apply(res, [ … ])
      const m0 = memberName(callee);
      if ((m0 === 'call' || m0 === 'apply') && (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))) {
        const inner = callee.expression;
        if (memberName(inner) === 'redirect' && onRes(inner.expression)) {
          callee = inner; args = m0 === 'call' ? args.slice(1) : (args[1] && ts.isArrayLiteralExpression(unwrap(args[1])) ? [...unwrap(args[1]).elements] : []);
        }
      }
      const name = memberName(callee);
      const isRes = (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) && onRes(callee.expression);
      if ((isRes && name === 'redirect') || (ts.isIdentifier(callee) && redirectFns.has(callee.text))) {
        if (args.length === 1) push(args[0], 302, n);
        else if (args.length >= 2) {
          const s0 = oneStatus(numberSet(args[0], bound)); const s1 = oneStatus(numberSet(args[1], bound));
          if (!Number.isNaN(s0)) push(args[1], s0, n);                    // (status, url)
          else if (!Number.isNaN(s1)) push(args[0], s1, n);               // legacy (url, status)
          else if (stringy(args[0]) && !stringy(args[1])) push(args[0], NaN, n);
          else push(args[1], NaN, n);                                     // (status the gate cannot read, url)
        }
      } else if (isRes && name === 'location' && args.length >= 1) {
        push(args[0], statusFor(n) ?? 302, n);
      } else if (isRes && (name === 'setHeader' || name === 'set' || name === 'header' || name === 'append') && args.length >= 1) {
        const st = statusFor(n);
        if (args.length >= 2) {
          const names = headerNames(args[0]);
          if (names === undefined) { if (risky(st)) out.push({ unprovable: `a header whose name \`${snippet(unwrap(args[0]), 40)}\` is not a readable constant, on a response that may be a 3xx`, ...at(n) }); }
          else if (names.includes('location')) push(args[1], st ?? 302, n);
        } else headerObject(args[0], n, st);
      } else if (isRes && name === 'writeHead' && args.length >= 2) {
        const last = unwrap(args[args.length - 1]);
        if (!stringy(last)) { const v = numberSet(args[0], bound); headerObject(last, n, v && !v.some((x) => x >= 300 && x < 400) ? 200 : oneStatus(v)); }
      } else if (!isRes) {
        // A helper handed the response (or something carrying it): follow it, binding its parameters to our arguments.
        const { hs, carriesRes } = handlesFor(args);
        const cr = rootIdent(callee);
        const global = cr && !resolveIdent(cr); // console.log(res), JSON.stringify(res): built-ins, never a redirect
        if (hs.length && !global && !isPackageRef(corpus, callee)) {
          let calleeExpr = callee;
          let closure = false;
          if (ts.isIdentifier(callee)) {
            const b = resolveIdent(callee);
            if (b && b.kind === 'param' && b.fn === fn && bound && bound.has(b.fn.parameters[b.index])) calleeExpr = bound.get(b.fn.parameters[b.index]).expr;
            else if (b && b.kind === 'param' && b.fn !== fn) closure = true; // a wrapper's own parameter: its argument is scanned where it is passed
          }
          if (!closure) {
            const r = resolveFunctions(corpus, calleeExpr);
            // The response ITSELF escaping into code the gate cannot read is INDETERMINATE; a request
            // (whose .res is the response) handed to one is followed best-effort — declared in the header.
            if (r.unresolved || (!r.fns.length && !r.framework)) { if (carriesRes) out.push({ escapes: `the response is handed to \`${snippet(callee, 40)}\`, which the gate cannot read${r.unresolved ? ` (${r.unresolved})` : ''}`, ...at(n) }); }
            else if (depth >= MAX_HELPER_DEPTH && r.fns.length) { if (carriesRes) out.push({ escapes: `the response is handed to \`${snippet(callee, 40)}\` beyond the helper depth limit (${MAX_HELPER_DEPTH})`, ...at(n) }); }
            else {
              for (const hf of r.fns) {
                const hb = new Map();
                (hf.parameters || []).forEach((p, i) => { if (args[i] && !paramReassigned(hf, p)) hb.set(p, { expr: args[i], bound }); });
                scanFunction(corpus, hf, hs, hb, depth + 1, out, stack);
              }
            }
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(fn.body || fn);
}

/** `req.get('Referer')`, `req.header('Referrer')`, `req.headers.referer`, `req.headers['referrer']`. */
function isRefererRead(n) {
  const isRef = (s) => /^referr?er$/i.test(s);
  if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ['get', 'header'].includes(n.expression.name.text) && n.arguments[0] && isStrLit(unwrap(n.arguments[0]))) return isRef(unwrap(n.arguments[0]).text);
  if (ts.isPropertyAccessExpression(n) && isRef(n.name.text) && ts.isPropertyAccessExpression(unwrap(n.expression)) && unwrap(n.expression).name.text === 'headers') return true;
  if (ts.isElementAccessExpression(n) && isStrLit(unwrap(n.argumentExpression)) && isRef(unwrap(n.argumentExpression).text) && ts.isPropertyAccessExpression(unwrap(n.expression)) && unwrap(n.expression).name.text === 'headers') return true;
  return false;
}

/**
 * Judge one Location expression answered on origin `cur` for a request to `reqPath`, for a form
 * whose page is on `page` (the origin `'self'` means — fixed for the whole chain, it never follows
 * the hops) → [{ kind: 'ok' } | { kind: 'hop', path, origin } | { kind: 'fail', why }].
 * Strings are read the way the browser's URL parser reads them (`urlNormalize`): a `\`, a tab, or a
 * leading space cannot smuggle `//host` past the same-origin tests. Every own-origin Location —
 * absolute path, path-relative, dot-segment, query-only, `back` — is RESOLVED and FOLLOWED as a hop.
 * A hop into the OTHER own origin (api ↔ apex) is followed there, not taken as terminal.
 */
function judgeTarget(node, bound, cur, sources, depth = 0, page = cur, reqPath = '/', reqs = []) {
  const n = unwrap(node);
  if (!n) return [{ kind: 'fail', why: 'no target expression' }];
  const sf = sfOf(n);
  const refused = (o, v) => ({ kind: 'fail', why: `${shownOf(v)} on ${o} is not allowed by form-action for a page on ${page}` });
  const hopOn = (p, raw) => (formActionAllows(sources, `${cur}/`, page) ? [{ kind: 'hop', path: p, origin: cur }] : [refused(cur, raw)]);
  const reqBase = reqPath.split(/[?#]/)[0];
  const dir = reqBase.replace(/[^/]*$/, '') || '/';
  const dotty = (p) => /(^|\/)\.\.?(\/|$)/.test(p.split(/[?#]/)[0]);
  const fromString = (raw, exact) => {
    const v = urlNormalize(raw);
    if (exact && v === 'back') return formActionAllows(sources, `${page}/`, page) ? [{ kind: 'hop', path: '/', origin: cur }] : [refused(page, v)]; // the Referer, or '/' without one
    const holeAt = v.indexOf('⟦');
    const head = holeAt === -1 ? v : v.slice(0, holeAt);
    if (exact && v === '') return hopOn(reqPath, v);
    if (/^\/(?!\/)/.test(v)) {
      if (!exact && dotty(head)) return [{ kind: 'fail', why: `\`${shownOf(v)}\` has dot-segments ahead of an interpolation — not provably same-origin` }];
      return hopOn(exact ? resolveDots(v) : v, v);
    }
    if (/^[?#]/.test(v)) return hopOn(reqBase + (v.startsWith('?') ? v : ''), v);
    const abs = /^(https?:\/\/[^/?#⟦]+)(?=[/?#]|$)/i.exec(v);
    // An origin is provable only when a delimiter (or the literal's end) closes it before any interpolation.
    if (abs && (exact || /^[/?#]/.test(v.slice(abs[1].length)))) {
      if (!formActionAllows(sources, abs[1], page)) return [{ kind: 'fail', why: `${shownOf(v)} is not allowed by form-action on ${page}` }];
      const o = new URL(abs[1]).origin;
      const rest = v.slice(abs[1].length) || '/';
      if (!exact && dotty(rest.slice(0, rest.indexOf('⟦') === -1 ? rest.length : rest.indexOf('⟦')))) return [{ kind: 'fail', why: `\`${shownOf(v)}\` has dot-segments ahead of an interpolation — not provably same-origin` }];
      return o === cur || o === API_ORIGIN || o === APEX_ORIGIN ? [{ kind: 'hop', path: exact ? resolveDots(rest.startsWith('/') ? rest : '/' + rest) : rest, origin: o }] : [{ kind: 'ok' }];
    }
    // Path-relative: it resolves on `cur` provided no scheme can form before the first '/', '?' or '#'.
    const firstDelim = v.search(/[/?#]/);
    const upto = firstDelim === -1 ? v : v.slice(0, firstDelim);
    const schemeFree = !upto.includes(':') && !upto.includes('⟦') && (holeAt === -1 || (firstDelim !== -1 && firstDelim < holeAt));
    if (schemeFree && !v.startsWith('//')) {
      if (!exact && dotty(head)) return [{ kind: 'fail', why: `\`${shownOf(v)}\` has dot-segments ahead of an interpolation — not provably same-origin` }];
      return hopOn(exact ? resolveDots(dir + v) : dir + v, v);
    }
    return [{ kind: 'fail', why: `\`${shownOf(v)}\` is not provably same-origin` }];
  };
  // `req.originalUrl` / `req.url` / `req.path` are this request's own path; `req.baseUrl` its mount prefix.
  const reqRead = (e) => {
    const u = unwrap(e);
    return u && ts.isPropertyAccessExpression(u) && ts.isIdentifier(unwrap(u.expression)) && reqs.includes(unwrap(u.expression).text) ? u.name.text : null;
  };
  const holeFor = (e) => {
    const u = unwrap(e);
    const c = constString(u);
    if (c !== null) return c;
    const rr = reqRead(u);
    if (rr === 'originalUrl' || rr === 'url' || rr === 'path') return reqBase;
    if (rr === 'baseUrl') return '/' + MULTI;
    return ts.isCallExpression(u) && u.expression.getText(sfOf(u)) === 'encodeURIComponent' ? SEG : MULTI;
  };
  if (isStrLit(n)) return fromString(n.text, true);
  { const rr = reqRead(n); if (rr === 'originalUrl' || rr === 'url' || rr === 'path') return hopOn(reqBase, rr); } // PRG to itself
  // A property of an object handed to a helper / factory (`opts.loginPath`) is that object's property.
  if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(unwrap(n.expression)) && bound) {
    const pb = resolveIdent(unwrap(n.expression));
    const pn = pb && pb.kind === 'param' ? pb.fn.parameters[pb.index] : null;
    const a = pn && bound.has(pn) ? bound.get(pn) : null;
    const lit = a ? (ts.isObjectLiteralExpression(unwrap(a.expr)) ? unwrap(a.expr) : constObjectOf(a.expr)) : null;
    const p = lit ? lit.properties.find((pp) => (ts.isPropertyAssignment(pp) || ts.isShorthandPropertyAssignment(pp)) && pp.name && (ts.isIdentifier(pp.name) || ts.isStringLiteral(pp.name)) && pp.name.text === n.name.text) : null;
    if (p) return judgeTarget(ts.isShorthandPropertyAssignment(p) ? p.name : p.initializer, a.bound, cur, sources, depth + 1, page, reqPath, reqs);
  }
  // A const route map (`ROUTES.thanks`, `ROUTES.account.cancel`) is its string.
  if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) { const c = constString(n); if (c !== null) return fromString(c, true); }
  // The Referer IS `back` — Express 5 deprecates 'back' in favour of `req.get('Referrer') || '/'`.
  if (isRefererRead(n)) return fromString('back', true);
  if (ts.isBinaryExpression(n) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(n.operatorToken.kind)) {
    return [...judgeTarget(n.left, bound, cur, sources, depth + 1, page, reqPath, reqs), ...judgeTarget(n.right, bound, cur, sources, depth + 1, page, reqPath, reqs)];
  }
  if (ts.isTemplateExpression(n)) {
    const parts = n.templateSpans.map((sp) => holeFor(sp.expression));
    const text = n.head.text + n.templateSpans.map((sp, i) => parts[i] + sp.literal.text).join('');
    return fromString(text, !/⟦/.test(parts.join('')));
  }
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const parts = [];
    let e = n;
    while (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) { parts.unshift(unwrap(e.right)); e = unwrap(e.left); }
    parts.unshift(e);
    const rendered = parts.map((p) => (isStrLit(p) ? p.text : holeFor(p)));
    return fromString(rendered.join(''), !/⟦/.test(rendered.join('')));
  }
  if (ts.isConditionalExpression(n)) return [...judgeTarget(n.whenTrue, bound, cur, sources, depth, page, reqPath, reqs), ...judgeTarget(n.whenFalse, bound, cur, sources, depth, page, reqPath, reqs)];
  if (ts.isIdentifier(n) && depth < 6) {
    const b = resolveIdent(n);
    const pnode = b && b.kind === 'param' ? b.fn.parameters[b.index] : null;
    if (pnode && bound && bound.has(pnode)) { const a = bound.get(pnode); return judgeTarget(a.expr, a.bound, cur, sources, depth + 1, page, reqPath, reqs); }
    const init = constBindingInit(n);
    if (init) return judgeTarget(init, bound, cur, sources, depth + 1, page, reqPath, reqs).map((r) => (r.kind === 'fail' ? { ...r, why: `target \`${n.text}\` → ${r.why}` } : r));
    return [{ kind: 'fail', why: `target \`${n.text}\` is not provably same-origin (${b ? `a ${b.kind === 'var' ? 'non-const variable' : b.kind} binding` : 'no visible declaration'})` }];
  }
  return [{ kind: 'fail', why: `target \`${snippet(n, 80)}\` is not provably same-origin` }];
}

// ───────────────────────────── form extraction ─────────────────────────────

/** Read a tag starting at `<` — attribute-aware: `>` inside a quoted value does not end it. */
function readTag(text, start) {
  let i = start + 1;
  while (i < text.length && /[A-Za-z]/.test(text[i])) i++;
  const attrStart = i;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") { const j = text.indexOf(c, i + 1); if (j === -1) return null; i = j + 1; continue; }
    if (c === '>') return { attrs: text.slice(attrStart, i), end: i + 1 };
    i++;
  }
  return null;
}

const ATTR_RE = /([^\s=>"'/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"'`]+)))?/g;
const HOLE_RE = /⟦(\d+)⟧/g;
const attrMap = (s) => {
  const out = {};
  for (const m of s.matchAll(ATTR_RE)) { const k = m[1].toLowerCase(); if (!(k in out)) out[k] = m[2] ?? m[3] ?? m[4] ?? ''; }
  return out;
};

/**
 * A tag's attribute sets. An interpolation that can change WHICH attributes exist (name position,
 * unquoted value) or the METHOD is expanded to every value it can take (`renderHole`: literals,
 * consts, a ternary's branches) and the tag re-read per combination — so `${x ? 'checked' : ''}` is
 * inert, and `id="x"${ACT}` carrying ` action="…"` is SEEN rather than guessed at. One the gate
 * cannot enumerate makes the tag `interpolated`. Holes inside action/formaction values stay as
 * markers (the action pipeline resolves them); holes inside any other quoted value change nothing.
 */
function parseAttrs(s, renderHole = () => null) {
  const relevant = new Set();
  for (const m of s.matchAll(ATTR_RE)) {
    const name = m[1].toLowerCase();
    for (const h of m[1].matchAll(HOLE_RE)) relevant.add(Number(h[1]));
    if (m[4] !== undefined) for (const h of m[4].matchAll(HOLE_RE)) relevant.add(Number(h[1]));
    const q = m[2] ?? m[3];
    if (q !== undefined && (name === 'method' || name === 'formmethod' || name === 'type' || name === 'form')) for (const h of q.matchAll(HOLE_RE)) relevant.add(Number(h[1]));
  }
  if (!relevant.size) return { variants: [attrMap(s)], interpolated: false };
  const holes = [...relevant]; const options = [];
  for (const h of holes) {
    const r = renderHole(h);
    if (!r || !r.length || r.some((x) => /[<>]/.test(x))) return { variants: [attrMap(s)], interpolated: true };
    options.push([...new Set(r)]);
  }
  let combos = [[]];
  for (const o of options) {
    combos = combos.flatMap((c) => o.map((x) => [...c, x]));
    if (combos.length > 64) return { variants: [attrMap(s)], interpolated: true };
  }
  const variants = []; const seen = new Set();
  for (const c of combos) {
    const text = s.replace(HOLE_RE, (mm, i) => { const k = holes.indexOf(Number(i)); return k === -1 ? mm : c[k]; });
    const a = attrMap(text);
    if (Object.keys(a).some((k) => k.includes('⟦')) || ['method', 'formmethod', 'type', 'form'].some((k) => String(a[k] ?? '').includes('⟦'))) return { variants: [attrMap(s)], interpolated: true };
    const key = JSON.stringify([a.action, a.method, a.formaction, a.formmethod, a.form, a.type, a.id]);
    if (!seen.has(key)) { seen.add(key); variants.push(a); }
  }
  return { variants, interpolated: false };
}

const methodOf = (m, fallback = 'GET') => {
  if (m === undefined || m === null) return fallback;
  const v = String(m).toLowerCase();
  if (v === 'post') return 'POST';
  if (v === 'dialog') return 'DIALOG';
  return v ? 'GET' : fallback; // browsers submit any other value as GET
};
const SUBMITTER_RE = /<(button|input)\b/gi;
/** Does this button/input submit its form? `type=button|reset` do not; an input only as submit/image. */
const submits = (tag, a) => (tag === 'button' ? !['button', 'reset'].includes(String(a.type ?? 'submit').toLowerCase()) : ['submit', 'image'].includes(String(a.type ?? '').toLowerCase()));
/** Script that builds, retargets or submits a form — the gate cannot follow script. */
const SCRIPTED_RE = /createElement\(\s*['"`]form['"`]|\.(?:action|formAction|method|formMethod)\s*=(?!=)|setAttribute\(\s*['"`](?:action|formaction|method|formmethod)['"`]|\.requestSubmit\s*\(|\.submit\s*\(\s*\)/g;
const SUBMITTER_ATTR_RE = /<(?:button|input)\b[^>]*?\b(?:formaction|formmethod|form)\s*=/i;
/** Raw source that may hold form markup, escaped or not (`<form` cooks to `<form`): the per-file prefilter. */
const RAW_MARKUP_RE = /(?:<|\\u003c|\\x3c|\\u\{3c\})\s*(?:form|button|input|script)\b/i;
/** Does a text carry anything the form scan must see? */
const formBearing = (t) => /<form\b/i.test(t) || SUBMITTER_ATTR_RE.test(t) || (/<script\b/i.test(t) && new RegExp(SCRIPTED_RE.source).test(t));

/**
 * Every <form> in an HTML-ish text with its submission targets (the form, plus each submitter's
 * formaction/formmethod), the submitters that sit OUTSIDE any form here (a `form="id"` owner, or
 * markup rendered apart from its form), unparseable form tags, and script that drives forms.
 */
export function scanForms(text, renderHole = () => null) {
  const t = blankHtmlComments(text);
  const forms = []; const unparsed = []; const standalone = []; const scripted = [];
  const lower = t.toLowerCase();
  const spans = [];
  for (const m of t.matchAll(/<form\b/gi)) {
    const tag = readTag(t, m.index);
    if (!tag) {
      // A tag that does not close inside this literal: split across array elements, or unterminated.
      const rest = t.slice(m.index + 5);
      if (/^\s*$/.test(rest) || /^[^<]*=/.test(rest)) unparsed.push(m.index);
      continue;
    }
    const { variants, interpolated } = parseAttrs(tag.attrs, renderHole);
    const close = lower.indexOf('</form', tag.end);
    const end = close === -1 ? t.length : close;
    spans.push([m.index, end]);
    const id = interpolated ? null : variants[0].id ?? null;
    const targets = interpolated ? [{ action: null, method: 'GET', via: 'form', interpolated: true }]
      : variants.map((v) => ({ action: v.action ?? null, method: methodOf(v.method), via: 'form', interpolated: false }));
    const inner = t.slice(tag.end, end);
    for (const b of inner.matchAll(SUBMITTER_RE)) {
      const bt = readTag(inner, b.index);
      if (!bt) continue;
      const ba = parseAttrs(bt.attrs, renderHole);
      if (ba.interpolated) { targets.push({ action: null, method: 'GET', via: 'formaction', interpolated: true }); continue; }
      for (const a of ba.variants) {
        if (!submits(b[1].toLowerCase(), a)) continue;
        if (a.form !== undefined && a.form !== id) { standalone.push({ index: tag.end + b.index, formId: a.form, action: a.formaction ?? null, method: a.formmethod ?? null }); continue; }
        if (a.formaction === undefined && a.formmethod === undefined) continue;
        for (const fv of interpolated ? [] : variants) {
          targets.push({ action: a.formaction ?? fv.action ?? null, method: methodOf(a.formmethod, methodOf(fv.method)), via: 'formaction', interpolated: false });
        }
      }
    }
    forms.push({ index: m.index, id, targets });
  }
  for (const b of t.matchAll(SUBMITTER_RE)) {
    if (spans.some(([s0, e0]) => b.index > s0 && b.index < e0)) continue;
    const bt = readTag(t, b.index);
    if (!bt) continue;
    const ba = parseAttrs(bt.attrs, renderHole);
    if (ba.interpolated) { if (/formaction|formmethod|\bform\s*=/i.test(bt.attrs)) standalone.push({ index: b.index, interpolated: true }); continue; }
    for (const a of ba.variants) {
      if (!submits(b[1].toLowerCase(), a)) continue;
      if (a.formaction === undefined && a.formmethod === undefined) continue;
      standalone.push({ index: b.index, formId: a.form ?? null, action: a.formaction ?? null, method: a.formmethod ?? null });
    }
  }
  for (const sm of t.matchAll(/<script\b[^>]*>/gi)) {
    const e = lower.indexOf('</script', sm.index);
    const body = t.slice(sm.index, e === -1 ? t.length : e);
    for (const m of body.matchAll(SCRIPTED_RE)) scripted.push(sm.index + m.index);
  }
  return { forms, unparsed, standalone, scripted };
}

/** String-bearing expressions of a TS file that carry form markup, each rendered ONCE with ⟦n⟧ placeholders and a segment map. */
function literalTexts(sf) {
  const texts = []; const renderedTops = new Set();
  const render = (top, ctx) => {
    const stack = [top];
    while (stack.length) {
      const n = unwrap(stack.pop());
      if (isStrLit(n)) { ctx.segs.push({ off: ctx.text.length, node: n }); ctx.text += n.text; continue; }
      if (ts.isTemplateExpression(n)) {
        ctx.segs.push({ off: ctx.text.length, node: n.head }); ctx.text += n.head.text;
        for (const s of n.templateSpans) {
          ctx.exprs.push(s.expression); ctx.text += EXPR(ctx.exprs.length - 1);
          ctx.segs.push({ off: ctx.text.length, node: s.literal }); ctx.text += s.literal.text;
        }
        continue;
      }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) { stack.push(n.right, n.left); continue; }
      ctx.exprs.push(n); ctx.text += EXPR(ctx.exprs.length - 1);
    }
  };
  const visit = (n) => {
    if (isStrLit(n) || ts.isTemplateExpression(n)) {
      let top = n;
      while (top.parent && ((ts.isBinaryExpression(top.parent) && top.parent.operatorToken.kind === ts.SyntaxKind.PlusToken) || ts.isParenthesizedExpression(top.parent))) top = top.parent;
      if (!renderedTops.has(top)) {
        renderedTops.add(top);
        const ctx = { text: '', exprs: [], segs: [] };
        render(top, ctx);
        if (formBearing(ctx.text)) {
          const lineFor = (i) => {
            let seg = ctx.segs[0];
            for (const sg of ctx.segs) if (sg.off <= i) seg = sg;
            return lineAt(sf, seg.node.getStart(sf)) + (ctx.text.slice(seg.off, i).match(/\n/g) || []).length;
          };
          texts.push({ text: ctx.text, exprs: ctx.exprs, lineFor });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return texts;
}

/**
 * Every string an expression standing in an attribute position can render to, or null when one of
 * them is not knowable. Nested interpolations render as ⟦v⟧ (acceptable only inside a quoted value).
 */
function attrRenderings(expr, depth = 0) {
  const n = unwrap(expr);
  if (!n || depth > 4) return null;
  if (isStrLit(n)) return [n.text];
  const c = constString(n);
  if (c !== null) return [c];
  if (ts.isTemplateExpression(n)) return [n.head.text + n.templateSpans.map((sp) => '⟦v⟧' + sp.literal.text).join('')];
  if (ts.isConditionalExpression(n)) {
    const a = attrRenderings(n.whenTrue, depth + 1); const b = attrRenderings(n.whenFalse, depth + 1);
    return a && b ? [...a, ...b] : null;
  }
  if (ts.isBinaryExpression(n) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(n.operatorToken.kind)) {
    const a = attrRenderings(n.left, depth + 1); const b = attrRenderings(n.right, depth + 1);
    return a && b ? [...a, ...b] : null;
  }
  if (ts.isIdentifier(n)) { const init = constBindingInit(n); return init ? attrRenderings(init, depth + 1) : null; }
  return null;
}

/** JSX forms / submitters in a .tsx file: the gate reads HTML in string literals, not JSX — each is INDETERMINATE. */
function jsxFormSites(sf) {
  const out = [];
  const visit = (n) => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const tag = n.tagName.getText(sf).toLowerCase();
      const names = n.attributes.properties.map((p) => (ts.isJsxAttribute(p) ? p.name.getText(sf).toLowerCase() : '{...}'));
      if (tag === 'form' || ((tag === 'button' || tag === 'input') && names.some((a) => ['formaction', 'formmethod', 'form', '{...}'].includes(a)))) out.push(lineAt(sf, n.getStart(sf)));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
const TEMPLATE_EXT = ['.html', '.htm', '.ejs', '.hbs', '.handlebars', '.pug', '.njk', '.mustache', '.liquid'];

/** Does a middleware rewrite the request method (a hand-rolled method-override)? */
function assignsReqMethod(fn) {
  const p0 = fn.parameters && fn.parameters[0] && ts.isIdentifier(fn.parameters[0].name) ? fn.parameters[0].name.text : null;
  if (!p0 || !fn.body) return false;
  let hit = false;
  const visit = (n) => {
    if (hit) return;
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const l = unwrap(n.left);
      if (ts.isPropertyAccessExpression(l) && l.name.text === 'method' && ts.isIdentifier(unwrap(l.expression)) && unwrap(l.expression).text === p0) hit = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(fn.body);
  return hit;
}

// ───────────────────────────── registrations ─────────────────────────────

/** `Router()` / `express.Router()` → 'router'; `express()` → 'app' (a sub-app when mounted, the root app when not). */
function routerInitKind(init) {
  const e = unwrap(init);
  if (!e || !ts.isCallExpression(e)) return null;
  if (/(^|\.)Router$/.test(e.expression.getText(sfOf(e)))) return 'router';
  const b = ts.isIdentifier(unwrap(e.expression)) ? rootImport(e.expression) : null;
  return b && b.spec === 'express' && (b.imported === 'default' || b.imported === '*') ? 'app' : null;
}

/** The router a `use()` argument mounts — `{ file, name }` of its `Router()` / `express()` declaration — or null. */
function routerRef(corpus, rel, arg, depth = 0) {
  const n = unwrap(arg);
  if (!n || depth > 4) return null;
  const fromDecl = (file, decl, init) => { const k = routerInitKind(init); return k ? { file, name: decl.name.text, kind: k } : null; };
  if (ts.isIdentifier(n)) {
    const b = resolveIdent(n);
    if (b && b.kind === 'var' && b.init) {
      if (routerInitKind(b.init)) return { file: rel, name: n.text, kind: routerInitKind(b.init) };
      if (ts.isCallExpression(unwrap(b.init))) return routerRef(corpus, rel, b.init, depth + 1); // const r = createRouter(deps)
    }
    if (b && b.kind === 'import' && isLocalSpec(b.spec)) {
      const f = corpus.moduleFile(rel, b.spec);
      const e = f ? exportOf(corpus, f, b.imported) : null;
      if (e && e.kind === 'var' && e.init && e.decl && ts.isIdentifier(e.decl.name)) return fromDecl(e.file || f, e.decl, e.init) || (ts.isCallExpression(unwrap(e.init)) ? routerRef(corpus, f, e.init, depth + 1) : null);
    }
    return null;
  }
  if (ts.isCallExpression(n) && !isPackageRef(corpus, n.expression)) {
    // A router FACTORY: `createBillingRouter(deps)` returns a Router() declared inside it.
    const r = resolveFunctions(corpus, n.expression);
    for (const f of r.fns || []) {
      let found = null;
      const visit = (x) => {
        if (found || (x !== f.body && ts.isFunctionLike(x))) return;
        if (ts.isReturnStatement(x) && x.expression && ts.isIdentifier(unwrap(x.expression))) {
          const bb = resolveIdent(unwrap(x.expression));
          if (bb && bb.kind === 'var' && bb.init && routerInitKind(bb.init)) found = { file: sfOf(f).fileName, name: unwrap(x.expression).text, kind: routerInitKind(bb.init) };
        }
        ts.forEachChild(x, visit);
      };
      if (f.body) visit(f.body);
      if (found) return found;
    }
  }
  return null;
}

/** A template / `+` chain path with its unreadable parts as MULTI holes, or null. */
function renderPath(expr) {
  const n = unwrap(expr);
  if (!n) return null;
  const c = constString(n);
  if (c !== null) return c;
  if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map((sp) => (constString(sp.expression) ?? MULTI) + sp.literal.text).join('');
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) return (renderPath(n.left) ?? MULTI) + (renderPath(n.right) ?? MULTI);
  if (ts.isIdentifier(n)) { const init = constBindingInit(n); if (init) return renderPath(init); }
  return null;
}

/** The registered path(s) of a route / use / mount first argument: strings (holes allowed), RegExps — or null when it is not a path the gate can place. */
function pathsOf(a0) {
  const a = unwrap(a0);
  if (!a) return null;
  if (ts.isRegularExpressionLiteral(a)) {
    const m = /^\/([\s\S]*)\/([a-z]*)$/.exec(a.text);
    try { return m ? [new RegExp(m[1], m[2])] : null; } catch { return null; }
  }
  if (ts.isArrayLiteralExpression(a)) {
    const all = [];
    for (const e of a.elements) { const p = pathsOf(e); if (!p) return null; all.push(...p); }
    return all.length ? all : null;
  }
  const c = constString(a);
  if (c !== null) return [c];
  if (ts.isTemplateExpression(a) || (ts.isBinaryExpression(a) && a.operatorToken.kind === ts.SyntaxKind.PlusToken)) { const p = renderPath(a); return p && p.startsWith('/') ? [p] : null; }
  if (ts.isIdentifier(a)) {
    const init = constBindingInit(a);
    if (init) return pathsOf(init);
    const vals = forOfPaths(a);
    if (vals && vals.length) return vals;
  }
  return null;
}

/** Every `<recv>.<verb>(path, …)` / `.route(path).<verb>(…)` / `.use([prefix,] …)` / `.param(name, fn)` in a file. */
function registrationsOf(corpus, rel) {
  const sf = corpus.sf(rel);
  const regs = []; const unanalysable = []; const mounts = []; const routers = new Map();
  const appLike = (recv) => routers.has(recv.text) || /^(app|server|router|\w*Router|\w*App)$/.test(recv.text);
  const visit = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) { const k = routerInitKind(n.initializer); if (k) routers.set(n.name.text, k); }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const verb = n.expression.name.text;
      const recvNode = unwrap(n.expression.expression);
      const args = [...n.arguments];
      const line = lineAt(sf, n.getStart(sf));
      const recv = rootIdent(recvNode);
      if (verb === 'use' && args.length && recv) {
        const prefix = pathsOf(args[0]);
        const prefixes = prefix ?? ['/'];
        const fnArgs = prefix ? args.slice(1) : args;
        const mws = [];
        for (const a of fnArgs) {
          const r = routerRef(corpus, rel, a);
          if (r) mounts.push({ prefixes, router: { file: r.file, name: r.name }, parent: { rel, recv: recv.text }, line });
          else mws.push(a);
        }
        if (mws.length) regs.push({ kind: 'use', rel, sf, line, verb: '*', paths: prefixes, handlers: mws, recv: recv.text, recvId: recv });
      } else if (verb === 'param' && args.length >= 2 && recv && appLike(recv)) {
        const pname = constString(args[0]);
        if (pname === null) unanalysable.push({ rel, line, why: `${recv.text}.param(${snippet(unwrap(args[0]), 30)}, …) — a name the gate cannot read` });
        else regs.push({ kind: 'param', rel, sf, line, verb: '*', paramName: pname, paths: ['/'], handlers: [args[1]], recv: recv.text, recvId: recv });
      } else if (Object.hasOwn(VERBS, verb) && args.length >= 1) {
        // .route('/p').all(mw).post(h): walk the receiver chain down to .route(<path>)
        let chain = recvNode; let routePath = null; let sawRoute = false;
        while (chain && ts.isCallExpression(chain) && ts.isPropertyAccessExpression(chain.expression)) {
          const nm = chain.expression.name.text;
          if (nm === 'route') { sawRoute = true; routePath = pathsOf(chain.arguments[0]); break; }
          if (!Object.hasOwn(VERBS, nm)) break;
          chain = unwrap(chain.expression.expression);
        }
        const placeable = (ps) => ps && ps.length && ps.every((p) => p instanceof RegExp || p.startsWith('/'));
        if (sawRoute) {
          if (placeable(routePath)) regs.push({ kind: 'route', rel, sf, line, verb: VERBS[verb], paths: routePath, handlers: args, recv: recv ? recv.text : null, recvId: recv });
          else unanalysable.push({ rel, line, why: `.route(${snippet(unwrap(chain.arguments[0]), 40)}) — a path the gate cannot place` });
        } else if (args.length >= 2) {
          const paths = pathsOf(args[0]);
          if (placeable(paths)) regs.push({ kind: 'route', rel, sf, line, verb: VERBS[verb], paths, handlers: args.slice(1), recv: recv ? recv.text : null, recvId: recv });
          else if (recv && appLike(recv)) unanalysable.push({ rel, line, why: `${recv.text}.${verb}(${snippet(unwrap(args[0]), 40)}, …) — a path the gate cannot place` });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { regs, unanalysable, mounts, routers };
}

// ───────────────────────────── analysis ─────────────────────────────

export function analyse(root) {
  const lines = [];
  const ind = (reason) => ({ verdict: 'INDETERMINATE', reason, lines });
  const indexPath = path.join(root, 'src', 'index.ts');
  if (!fs.existsSync(indexPath)) return ind('NO_EXPRESS_CSP — src/index.ts not found');
  const expressRaw = extractExpressCsp(fs.readFileSync(indexPath, 'utf8'));
  if (!expressRaw) return ind('NO_EXPRESS_CSP — no Content-Security-Policy literal extractable from src/index.ts');
  const express = parseCsp(expressRaw);
  if (!express['form-action']) return ind('NO_FORM_ACTION_DIRECTIVE — the Express policy parsed without form-action (extractor window truncation, or the directive was removed)');
  const caddyPath = path.join(root, 'Caddyfile');
  const caddySrc = fs.existsSync(caddyPath) ? fs.readFileSync(caddyPath, 'utf8') : '';
  const apexRaw = caddySrc ? extractCaddyCsp(caddySrc) : null;
  if (!apexRaw) {
    const hits = caddySrc.split('\n').filter((l) => !/^\s*#/.test(l) && /header\s+Content-Security-Policy\s+"/.test(l)).length;
    return ind(hits >= 2 ? `APEX_CSP_AMBIGUOUS — ${hits} Content-Security-Policy headers in the Caddyfile; the shared extractor requires exactly one` : 'NO_APEX_CSP — no Content-Security-Policy header extractable from the Caddyfile');
  }
  const apex = parseCsp(apexRaw);
  if (!apex['form-action']) return ind('NO_FORM_ACTION_DIRECTIVE — the apex (Caddyfile) policy parsed without form-action');
  const apexProxied = apexProxiedMatchers(caddySrc);
  if (apexProxied === null) return ind('NO_APEX_PROXY_MAP — no algovault.com site block found in the Caddyfile');
  if (apexProxied.unresolved.length) return ind(`APEX_MATCHER_UNRESOLVED — the apex proxy map cannot be stated for: ${apexProxied.unresolved.join('; ')}`);
  if (apexProxied.length === 0) return ind('NO_APEX_PROXY_MAP — the algovault.com site block proxies nothing to Express; the map the apex checks depend on is empty');
  // Does the apex hand a request for this path (a route path, or a request pattern with holes) to Express?
  const apexServes = (p) => {
    if (p instanceof RegExp) return true;
    const probe = normPath(holesToSample(p)).split('/').map((s) => (s.startsWith(':') || s.includes('*') || s === '(.*)' ? 'x' : s)).join('/');
    return apexProxied.some((re) => re.test(probe));
  };
  const policies = { express: express['form-action'], apex: apex['form-action'] };
  lines.push(`  policy express: form-action ${policies.express.join(' ')} — routes on ${API_ORIGIN}, and on ${APEX_ORIGIN} where Caddy proxies them (${apexProxied.length} apex matcher(s))`);
  lines.push(`  policy apex-static: form-action ${policies.apex.join(' ')} — landing/**.html on ${APEX_ORIGIN}`);

  const corpus = new Corpus(root);
  CORPUS = corpus; MUTATED.clear(); ALIASES = loadAliases(root);
  const rels = (dir, exts) => walk(path.join(root, dir), exts).map((f) => path.relative(root, f).split(path.sep).join('/'));
  const srcFiles = rels('src', SRC_EXT);
  const landingFiles = rels('landing', ['.html']);
  const landingScripts = rels('landing', ['.js', '.mjs']);
  const templates = rels('src', TEMPLATE_EXT);
  const raw = new Map(srcFiles.map((rel) => [rel, fs.readFileSync(path.join(root, rel), 'utf8')]));

  // ── registrations: routes, use() middleware, param() callbacks, router mounts ──
  const regs = []; const unanalysable = []; const mounts = []; const routerKinds = new Map(); const parseErr = [];
  for (const rel of srcFiles) {
    if (SEPARATE_APPS.has(rel)) continue;
    const text = raw.get(rel);
    // A file that only DECLARES a router (`export const api = Router()`) must be read too, or its routes land at the root.
    if (!RAW_MARKUP_RE.test(text) && !/\.(get|post|put|patch|delete|all|use|route|param)\s*\(|\bRouter\s*\(|\bexpress\s*\(/.test(text)) continue;
    if (corpus.parseErrors(rel)) { parseErr.push(rel); continue; }
    const r = registrationsOf(corpus, rel);
    regs.push(...r.regs); unanalysable.push(...r.unanalysable); mounts.push(...r.mounts);
    for (const [name, kind] of r.routers) routerKinds.set(`${rel}#${name}`, kind);
  }
  if (parseErr.length) return ind(`SOURCE_PARSE_ERROR — the TypeScript parser reported errors in ${parseErr.join(', ')}`);
  // A router (or a MOUNTED express() sub-app) is served at the composition of every mount above it.
  const keyOf = (m) => `${m.router.file}#${m.router.name}`;
  const mounted = new Set(mounts.map(keyOf));
  const routerKeys = new Set([...routerKinds].filter(([k, kind]) => kind === 'router' || mounted.has(k)).map(([k]) => k));
  const joinPrefix = (a, b) => (a instanceof RegExp || b instanceof RegExp ? null : (a.replace(/\/$/, '') + (b === '/' ? '' : b)) || '/');
  const prefixesOf = (key, trail = []) => {
    if (trail.includes(key) || trail.length > 6) return null;
    const ms = mounts.filter((m) => keyOf(m) === key);
    if (!ms.length) return null;
    const out = [];
    for (const m of ms) {
      const pk = `${m.parent.rel}#${m.parent.recv}`;
      const parents = routerKeys.has(pk) ? prefixesOf(pk, [...trail, key]) : ['/'];
      if (!parents) return null;
      for (const pp of parents) for (const pre of m.prefixes) { const j = joinPrefix(pp, pre); if (j === null) return null; out.push(j); }
    }
    return out;
  };
  // The receiver of a registration, as the declarations it can be: a local or imported router / app,
  // or — for `function registerBillingRoutes(r) { r.post(…) }` — the router bindings of the arguments
  // at every call site of the enclosing function. null = not placeable (NEVER silently the root).
  const recvKeysOf = (id, depth = 0) => {
    if (!id || depth > 3) return null;
    const b = resolveIdent(id);
    if (!b) return [`${sfOf(id).fileName}#${id.text}`];
    if (b.kind === 'var') return [`${sfOf(b.decl || id).fileName}#${id.text}`];
    if (b.kind === 'import' && isLocalSpec(b.spec)) {
      const f = corpus.moduleFile(sfOf(id).fileName, b.spec);
      const e = f ? exportOf(corpus, f, b.imported) : null;
      return e && e.kind === 'var' && e.decl && ts.isIdentifier(e.decl.name) ? [`${e.file || f}#${e.decl.name.text}`] : null;
    }
    if (b.kind === 'param') {
      const fnNode = b.fn;
      const fnName = fnNode.name && ts.isIdentifier(fnNode.name) ? fnNode.name.text
        : fnNode.parent && ts.isVariableDeclaration(fnNode.parent) && ts.isIdentifier(fnNode.parent.name) ? fnNode.parent.name.text : null;
      if (!fnName) return null;
      const keys = [];
      for (const rel2 of srcFiles) {
        if (!raw.get(rel2).includes(fnName) || corpus.parseErrors(rel2)) continue;
        let bad = false;
        const visit = (x) => {
          if (bad) return;
          if (ts.isCallExpression(x) && ts.isIdentifier(unwrap(x.expression)) && unwrap(x.expression).text === fnName) {
            const target = resolveFunctions(corpus, x.expression);
            if (!target.unresolved && target.fns.includes(fnNode)) {
              const arg = x.arguments[b.index] ? rootIdent(unwrap(x.arguments[b.index])) : null;
              const ks = arg ? recvKeysOf(arg, depth + 1) : null;
              if (!ks) bad = true; else keys.push(...ks);
            }
          }
          ts.forEachChild(x, visit);
        };
        visit(corpus.sf(rel2));
        if (bad) return null;
      }
      return keys.length ? [...new Set(keys)] : null;
    }
    return null;
  };
  const resolved = [];
  for (const r of regs) {
    const keys = r.recvId ? recvKeysOf(r.recvId) : null;
    if (r.recvId && !keys && resolveIdent(r.recvId)) { unanalysable.push({ rel: r.rel, line: r.line, why: `${r.recv} is a router the gate cannot trace to a declaration or a mount` }); continue; }
    const routerKs = (keys || []).filter((k) => routerKeys.has(k));
    const atRoot = !keys || keys.some((k) => !routerKeys.has(k));
    if (atRoot) resolved.push(r);
    let placedAll = true;
    for (const key of routerKs) {
      const pres = prefixesOf(key);
      if (!pres) { unanalysable.push({ rel: r.rel, line: r.line, why: `router ${r.recv} has no mount the gate can place (unmounted, a RegExp prefix, or a cycle)` }); placedAll = false; break; }
      if (r.kind === 'param') { resolved.push(r); continue; }
      const paths = []; let ok = true;
      for (const pre of pres) for (const x of r.paths) { const j = joinPrefix(pre, x); if (j === null) ok = false; else paths.push(j); }
      if (!ok) { unanalysable.push({ rel: r.rel, line: r.line, why: `a RegExp path under router ${r.recv}'s mount prefix` }); placedAll = false; break; }
      resolved.push({ ...r, paths });
    }
    if (!placedAll) continue;
  }
  const routes = resolved.filter((r) => r.kind === 'route');
  const uses = resolved.filter((r) => r.kind === 'use');
  const params = resolved.filter((r) => r.kind === 'param');
  // A method override (the package, or a middleware that rewrites req.method) lets a POST form reach PUT/PATCH/DELETE.
  const methodOverride = srcFiles.some((rel) => /from\s+['"]method-override['"]|require\(\s*['"]method-override['"]\s*\)/.test(raw.get(rel)))
    || uses.some((u) => u.handlers.some((h) => (resolveFunctions(corpus, h).fns || []).some((f) => assignsReqMethod(f))));

  // ── forms, submitters, and what the gate cannot read ──
  const targets = []; const unparsedForms = []; const blockers = [];
  const associate = (rel, source, fileForms, fileStandalone) => {
    for (const st of fileStandalone) {
      const at = `${rel}:${st.line}`;
      if (st.interpolated) { blockers.push({ at, reason: 'FORM_ATTRS_INTERPOLATED', why: 'a submitter outside its form has attributes the gate cannot enumerate' }); continue; }
      if (st.formId !== null && st.formId !== undefined) {
        const owners = fileForms.filter((f) => f.id === st.formId);
        if (!owners.length) { blockers.push({ at, reason: 'SUBMITTER_UNASSOCIATED', why: `form="${st.formId}" names no form the gate can see in this file` }); continue; }
        for (const f of owners) {
          for (const ft of f.targets.filter((x) => x.via === 'form' && !x.interpolated)) {
            const own = st.action !== null;
            targets.push({ action: own ? st.action : ft.action, method: st.method !== null ? methodOf(st.method) : ft.method, via: 'formaction', interpolated: false, file: rel, line: st.line, source, exprs: own ? st.exprs : f.exprs });
          }
        }
        continue;
      }
      if (st.action === null) { blockers.push({ at, reason: 'SUBMITTER_UNASSOCIATED', why: 'a formmethod submitter rendered apart from its form — which form, and so which action, cannot be known' }); continue; }
      // Rendered apart from its form (a nested template, a helper, .map()): the owner's method is unknown, so both.
      for (const m of st.method !== null ? [methodOf(st.method)] : ['GET', 'POST']) {
        targets.push({ action: st.action, method: m, via: st.method !== null ? 'formaction' : 'formaction, owner unknown', interpolated: false, file: rel, line: st.line, source, exprs: st.exprs });
      }
    }
  };
  for (const rel of srcFiles) {
    const text = raw.get(rel);
    if (rel.endsWith('.tsx') && /<\s*(form|button|input)\b/i.test(text)) {
      if (corpus.parseErrors(rel)) return ind(`SOURCE_PARSE_ERROR — the TypeScript parser reported errors in ${rel}`);
      for (const ln of jsxFormSites(corpus.sf(rel))) blockers.push({ at: `${rel}:${ln}`, reason: 'JSX_FORM', why: 'a JSX form or submitter — the gate reads form markup in string literals, not JSX' });
    }
    if (!RAW_MARKUP_RE.test(text)) continue;
    if (corpus.parseErrors(rel)) return ind(`SOURCE_PARSE_ERROR — the TypeScript parser reported errors in ${rel}`);
    const fileForms = []; const fileStandalone = [];
    for (const lt of literalTexts(corpus.sf(rel))) {
      const { forms, unparsed, standalone, scripted } = scanForms(lt.text, (i) => attrRenderings(lt.exprs[i]));
      for (const u of unparsed) unparsedForms.push(`${rel}:${lt.lineFor(u)}`);
      for (const sc of scripted) blockers.push({ at: `${rel}:${lt.lineFor(sc)}`, reason: 'SCRIPTED_FORM', why: 'an inline script builds, retargets or submits a form — the gate cannot follow script' });
      for (const f of forms) {
        fileForms.push({ ...f, exprs: lt.exprs });
        for (const tg of f.targets) targets.push({ ...tg, file: rel, line: lt.lineFor(f.index), source: 'src', exprs: lt.exprs });
      }
      for (const st of standalone) fileStandalone.push({ ...st, line: lt.lineFor(st.index), exprs: lt.exprs });
    }
    associate(rel, 'src', fileForms, fileStandalone);
  }
  for (const rel of landingFiles) {
    const text = stripComments(fs.readFileSync(path.join(root, rel), 'utf8'), rel);
    const { forms, unparsed, standalone, scripted } = scanForms(text);
    const lineFor = (i) => (text.slice(0, i).match(/\n/g) || []).length + 1;
    for (const u of unparsed) unparsedForms.push(`${rel}:${lineFor(u)}`);
    for (const sc of scripted) blockers.push({ at: `${rel}:${lineFor(sc)}`, reason: 'SCRIPTED_FORM', why: 'an inline script builds, retargets or submits a form — the gate cannot follow script' });
    for (const f of forms) for (const tg of f.targets) targets.push({ ...tg, file: rel, line: lineFor(f.index), source: 'landing', exprs: [] });
    associate(rel, 'landing', forms.map((f) => ({ ...f, exprs: [] })), standalone.map((st) => ({ ...st, line: lineFor(st.index), exprs: [] })));
  }
  for (const rel of landingScripts) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const m of text.matchAll(SCRIPTED_RE)) blockers.push({ at: `${rel}:${(text.slice(0, m.index).match(/\n/g) || []).length + 1}`, reason: 'SCRIPTED_FORM', why: 'a served script builds, retargets or submits a form — the gate cannot follow script' });
  }
  for (const rel of templates) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    if (/<form\b/i.test(text) || /^\s*form\b/m.test(text)) blockers.push({ at: rel, reason: 'UNSCANNED_TEMPLATE', why: 'a template file under src/ contains a form, and the gate reads only string literals and landing/**.html' });
  }

  const nSrc = targets.filter((x) => x.source === 'src' && x.via === 'form').length;
  const nLanding = targets.filter((x) => x.source === 'landing' && x.via === 'form').length;
  lines.push(`  corpus: ${nSrc + nLanding} form(s) (src ${nSrc}, landing ${nLanding}), ${targets.length - nSrc - nLanding} formaction button(s) · ${routes.length} route, ${uses.length} use() and ${params.length} param() registration(s) across ${srcFiles.length + landingFiles.length} file(s)`);
  if (unanalysable.length) lines.push(`  · ${unanalysable.length} registration(s) the gate cannot place — an unrouted form or hop is then INDETERMINATE, never a pass: ${unanalysable.map((u) => `${u.rel}:${u.line}`).join(', ')}`);
  if (nSrc + nLanding === 0 && unparsedForms.length === 0 && blockers.length === 0) return ind('NO_FORMS — the form extractor built an empty corpus');
  if (routes.length === 0) return ind('NO_ROUTES — the route extractor built an empty corpus');

  let fails = 0; let indeterminate = 0; let mapped = 0; let needing = 0;
  for (const u of unparsedForms) { indeterminate++; lines.push(`  ? ${u} — FORM_UNPARSED (a <form tag that does not close inside its literal — split across strings, or unterminated)`); }
  for (const b of blockers) { indeterminate++; lines.push(`  ? ${b.at} — ${b.reason}: ${b.why}`); }
  const env = { corpus, routes, uses, params, apexServes, unplaced: unanalysable.length };

  for (const t of targets) {
    const at = `${t.file}:${t.line}`;
    const via = t.via === 'form' ? '' : ` (button ${t.via})`;
    const q = (reason, why) => { indeterminate++; lines.push(`  ? ${at} ${t.method}${t.action ? ' ' + shownOf(t.action) : ''}${via} — ${reason}: ${why}`); };
    if (t.method === 'DIALOG') { lines.push(`  · ${at} method=dialog${via} — closes a dialog, never navigates`); continue; }
    if (t.interpolated) { q('FORM_ATTRS_INTERPOLATED', 'an interpolation stands where an attribute or the method would be, and the gate cannot enumerate its values'); continue; }
    if (t.action === null || t.action === '' || /^[#?]/.test(t.action)) {
      if (t.method === 'GET') { lines.push(`  · ${at} GET ${t.action || '(no action)'}${via} — SAME_DOCUMENT, reported`); continue; }
      q('SAME_DOCUMENT_POST', 'posts back to whichever route rendered it; give it an explicit action'); continue;
    }
    // Interpolations: a const resolved by LEXICAL scope (or through an import), else a hole (one segment for encodeURIComponent).
    const action = t.action.replaceAll('⟦v⟧', MULTI).replace(/⟦(\d+)⟧/g, (_, i) => {
      const e = unwrap(t.exprs[Number(i)]);
      const c = e ? constString(e) : null;
      if (c !== null) return c;
      return e && ts.isCallExpression(e) && e.expression.getText(sfOf(e)) === 'encodeURIComponent' ? SEG : MULTI;
    });
    const shown = shownOf(action);
    if (/^⟦/.test(action) || (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*⟦/i.test(action))) { q('ACTION_ORIGIN_UNRESOLVED', "the action's origin is interpolated and is not a const in scope"); continue; }
    const absolute = /^[a-z][a-z0-9+.-]*:|^\/\//i.test(action);
    if (!absolute && !action.startsWith('/')) { q('ACTION_UNRESOLVED', "a path-relative action depends on the rendering page's URL"); continue; }
    const probe = action.replaceAll(SEG, 'x').replaceAll(MULTI, 'x');
    let abs = null;
    if (absolute) { try { abs = new URL(probe); } catch { q('ACTION_UNRESOLVED', 'unparseable absolute action'); continue; } }
    // Page origins and policies the form renders under. An absolute own-origin action is taken to be
    // rendered on that same origin (the only reason to write one); landing files are judged under both.
    const contexts = [];
    const add = (origin, policy) => contexts.push({ origin, sources: policies[policy], policy });
    if (t.source === 'landing') {
      // Who serves this file decides its policy: Caddy (the apex static CSP) unless the apex proxies its
      // URL to Express (then the container answers it, under the Express CSP). Both when either could.
      const base = '/' + t.file.replace(/^landing\//, '');
      const urls = [base, base.replace(/\.html$/, ''), base.replace(/(^|\/)index\.html$/, '$1') || '/'];
      if (urls.some((u) => !apexServes(u))) add(APEX_ORIGIN, 'apex');
      if (urls.some((u) => apexServes(u))) add(APEX_ORIGIN, 'express');
    }
    else if (abs && (abs.origin === API_ORIGIN || abs.origin === APEX_ORIGIN)) add(abs.origin, 'express');
    else { add(API_ORIGIN, 'express'); add(APEX_ORIGIN, 'express'); }
    // The origin that ANSWERS the submission: the action's own origin when absolute, else the page's.
    const answering = (c) => (abs ? abs.origin : c.origin);
    // (i) the submission itself
    const denied = contexts.filter((c) => !formActionAllows(c.sources, probe, c.origin));
    if (denied.length) { fails++; lines.push(`  ✗ ${at} ${t.method} ${shown}${via} — the submission itself is refused by form-action on ${[...new Set(denied.map((c) => c.origin))].join(', ')}`); continue; }
    if (abs && abs.origin !== API_ORIGIN && abs.origin !== APEX_ORIGIN) { lines.push(`  · ${at} ${t.method} ${shown}${via} — off-origin action allowed by form-action; not an Express route`); continue; }
    const actionPath = abs ? action.slice(abs.origin.length) || '/' : action;
    // (ii) everything that answers it — per method (a method override widens a POST), per serving origin.
    const methods = t.method === 'POST' && methodOverride
      ? ['POST', ...['PUT', 'PATCH', 'DELETE'].filter((m) => routes.some((r) => r.verb === m && r.paths.some((rp) => pathMatches(rp, actionPath))))] : [t.method];
    let verdict = { kind: 'ok', handlers: new Set(), hops: 0 };
    let routedAny = false; const origins = new Set();
    for (const method of methods) {
      const hits = routes.filter((r) => (r.verb === method || r.verb === '*') && r.paths.some((rp) => pathMatches(rp, actionPath)));
      const scoped = uses.filter((u) => u.paths.some((p) => !isGlobalPrefix(p) && prefixMatches(p, actionPath)));
      const routed = hits.length > 0 || scoped.length > 0;
      if (!routed) {
        if (method !== 'GET') { verdict = { kind: 'indeterminate', why: 'FORM_UNROUTED: no Express registration serves it (a missed registration shape must not read as a pass)' }; break; }
        if (env.unplaced) { verdict = { kind: 'indeterminate', why: `UNROUTED_UNPLACEABLE: no registration the gate can place serves it, and ${env.unplaced} registration(s) it cannot place might` }; break; }
      }
      routedAny = routedAny || routed;
      const serving = contexts.filter((c) => answering(c) === API_ORIGIN || apexServes(actionPath));
      if (!serving.length) { if (routed) { verdict = { kind: 'indeterminate', why: 'FORM_NO_SERVING_ORIGIN: no origin this form renders on serves its route' }; break; } continue; }
      for (const c of serving) {
        const v = evaluate(env, method, actionPath, c, 0, new Set(), answering(c));
        if (v.kind !== 'ok') { verdict = v; break; }
        origins.add(answering(c));
        v.handlers.forEach((h) => verdict.handlers.add(h)); verdict.hops += v.hops;
      }
      if (verdict.kind !== 'ok') break;
    }
    if (routedAny) needing++;
    if (verdict.kind === 'fail') { fails++; mapped++; lines.push(`  ✗ ${at} ${t.method} ${shown}${via} — ${verdict.why} — Chrome/Safari refuse a cross-origin redirect after a form submission; answer 200 via src/lib/off-origin-redirect.ts`); }
    else if (verdict.kind === 'indeterminate') { indeterminate++; lines.push(`  ? ${at} ${t.method} ${shown}${via} — ${verdict.why}`); }
    else if (!routedAny) lines.push(`  · ${at} GET ${shown}${via} — no Express registration serves it (a static or 404 page), reported`);
    else { mapped++; lines.push(`  ✓ ${at} ${t.method} ${shown}${via} → ${[...verdict.handlers].join(', ')} on ${[...origins].join(', ')} — ${verdict.hops ? `${verdict.hops} own-origin hop(s) followed, ` : ''}no cross-origin redirect`); }
  }
  lines.push(`  handlers: ${mapped} form target(s) mapped and judged of ${needing} routed`);
  if (fails) return { verdict: 'FAIL', reason: `${fails} form target(s) can be refused by form-action`, lines };
  if (needing > 0 && mapped === 0) return ind(`NO_MAPPED_HANDLERS — 0 of ${needing} routed form target(s) had a readable handler chain`);
  if (indeterminate) return ind(`${indeterminate} form target(s) could not be verified (see '?' lines)`);
  return { verdict: 'PASS', reason: `${mapped} form target(s) verified on 2 policies`, lines };
}

/**
 * Everything that runs for (method, path) answered on origin `cur` — use() middleware, param()
 * callbacks, then routes — judged, hops followed. `ctx.origin` is the PAGE origin and never changes
 * along the chain; `cur` does, so the visited-set is keyed on it. A request the apex does not hand
 * to Express is Caddy's (static / 404). An unrouted own-origin hop is terminal ONLY when every
 * registration was placed — otherwise one the gate could not place might answer it: INDETERMINATE.
 */
function evaluate(env, method, reqPath, ctx, depth, seen, cur = ctx.origin) {
  if (depth > MAX_HOPS) return { kind: 'indeterminate', why: `REDIRECT_CHAIN_TOO_DEEP — more than ${MAX_HOPS} own-origin hops` };
  const key = `${method} ${normPath(reqPath)} @${cur}`;
  if (seen.has(key)) return { kind: 'ok', handlers: new Set(), hops: 0, routed: true };
  seen.add(key);
  if (cur === APEX_ORIGIN && !env.apexServes(reqPath)) return { kind: 'ok', handlers: new Set(), hops: 0, routed: false };
  const routeHits = env.routes.filter((r) => (r.verb === method || r.verb === '*') && r.paths.some((rp) => pathMatches(rp, reqPath)));
  const useHits = env.uses.filter((u) => u.paths.some((p) => prefixMatches(p, reqPath)));
  const routed = routeHits.length > 0 || useHits.some((u) => u.paths.some((p) => !isGlobalPrefix(p) && prefixMatches(p, reqPath)));
  if (!routed && env.unplaced && depth > 0) return { kind: 'indeterminate', why: `HOP_UNROUTED — no registration the gate can place serves ${method} ${shownOf(reqPath)}, and ${env.unplaced} registration(s) it cannot place might` };
  const paramHits = env.params.filter((p) => routeHits.some((r) => r.paths.some((rp) => typeof rp === 'string' && rp.split('/').some((sg) => sg.replace(/\?$/, '') === `:${p.paramName}`))));
  const chain = [...useHits, ...paramHits, ...routeHits];
  const handlers = new Set(); let hops = 0;
  for (const reg of chain) {
    const id = `${reg.rel}:${reg.line}`;
    const fnsAll = [];
    for (const h of reg.handlers) {
      const r = resolveFunctions(env.corpus, h);
      if (r.unresolved) return { kind: 'indeterminate', why: `HANDLER_UNRESOLVED — ${r.unresolved} (${reg.kind === 'use' ? 'use() middleware' : reg.kind === 'param' ? 'param() callback' : 'handler'} at ${id})` };
      r.fns.forEach((f, i) => fnsAll.push({ fn: f, bound: (r.bounds && r.bounds[i]) || new Map() }));
    }
    if (reg.kind === 'route') {
      const last = unwrap(reg.handlers[reg.handlers.length - 1]);
      handlers.add(`${last.getText(reg.sf).replace(/\s+/g, ' ').slice(0, 40)} (${id})`);
    }
    const locs = [];
    // Express passes the response 2nd — also to a param() callback — or 3rd in a 4-parameter error middleware.
    for (const { fn, bound } of fnsAll) scanFunction(env.corpus, fn, entryHandles(reg.kind !== 'param' && fn.parameters && fn.parameters.length === 4 ? 2 : 1), bound, 0, locs, new Set());
    for (const loc of locs) {
      if (loc.unprovable) return { kind: 'fail', why: `${loc.file}:${loc.line}: ${loc.unprovable} — not provably same-origin` };
      if (loc.escapes) return { kind: 'indeterminate', why: `RESPONSE_ESCAPES — ${loc.file}:${loc.line}: ${loc.escapes}` };
      for (const j of judgeTarget(loc.target, loc.bound, cur, ctx.sources, 0, ctx.origin, reqPath, loc.reqs || [])) {
        if (j.kind === 'fail') return { kind: 'fail', why: `${loc.file}:${loc.line} ${statusLabel(loc.status)}: ${j.why}` };
        if (j.kind !== 'hop') continue;
        const st = loc.status;
        // 307/308 keep the method; 301/302/303 become GET; a status the gate cannot read, or a non-3xx, is followed under BOTH.
        const hopMethods = st === 307 || st === 308 ? [method] : st >= 300 && st < 400 ? ['GET'] : ['GET', method];
        const to = j.origin || cur;
        for (const hm of [...new Set(hopMethods)]) {
          const sub = evaluate(env, hm, j.path, ctx, depth + 1, seen, to);
          if (sub.kind === 'fail') return { kind: 'fail', why: `${loc.file}:${loc.line} ${statusLabel(loc.status)} → ${to === cur ? '' : to}${shownOf(j.path)} → ${sub.why}` };
          if (sub.kind === 'indeterminate') return sub;
          if (sub.routed) hops++;
          hops += sub.hops;
        }
      }
    }
  }
  return { kind: 'ok', handlers, hops, routed };
}

// ───────────────────────────── self-test ─────────────────────────────

function selfTest(root) {
  let pass = 0; const failures = [];
  const t = (name, ok) => { if (ok) pass++; else failures.push(name); };
  const fx = (d) => path.join(root, 'tests', 'fixtures', 'form-action', d);
  const cases = [
    ['cross-origin-3xx', 'FAIL', /can be refused/],
    ['same-origin-200', 'PASS', /verified/],
    ['empty-corpus', 'INDETERMINATE', /^NO_FORMS/],
    ['no-form-action-directive', 'INDETERMINATE', /^NO_FORM_ACTION_DIRECTIVE — the Express/],
    ['no-routes', 'INDETERMINATE', /^NO_ROUTES/],
    ['unresolved-handler', 'INDETERMINATE', /^NO_MAPPED_HANDLERS/],
    ['no-express-csp', 'INDETERMINATE', /^NO_EXPRESS_CSP/],
    ['no-apex-csp', 'INDETERMINATE', /^NO_APEX_CSP/],
    ['apex-csp-ambiguous', 'INDETERMINATE', /^APEX_CSP_AMBIGUOUS/],
    ['apex-no-form-action', 'INDETERMINATE', /^NO_FORM_ACTION_DIRECTIVE — the apex/],
    ['apex-no-proxy-map', 'INDETERMINATE', /^NO_APEX_PROXY_MAP/],
    ['fail-matrix', 'FAIL', /can be refused/],
    ['pass-matrix', 'PASS', /verified/],
    ['indeterminate-matrix', 'INDETERMINATE', /could not be verified/],
    ['cross-own-origin', 'FAIL', /can be refused/],
  ];
  const missing = cases.filter(([d]) => !fs.existsSync(fx(d)));
  if (missing.length) return { verdict: 'INDETERMINATE', detail: `fixture tree(s) missing: ${missing.map(([d]) => d).join(', ')} — the self-test built nothing to test` };
  const got = {};
  for (const [d, want, why] of cases) {
    let r;
    try { r = analyse(fx(d)); } catch (e) { r = { verdict: 'THREW', reason: String(e && e.stack), lines: [] }; }
    got[d] = r;
    t(`${d} → ${want} (got ${r.verdict}: ${r.reason})`, r.verdict === want && why.test(r.reason));
  }
  const has = (d, re) => (got[d].lines || []).some((l) => re.test(l));
  const row = (sym, route) => new RegExp(`${sym} \\S+ (POST|GET) ${escRe(route)}(\\s|$)`, 'i');
  // FAIL matrix: every declared check fires on its own row — a check no fixture exercises is unpinned.
  for (const route of ['/f/abs-literal', '/f/location', '/f/setheader', '/f/writehead', '/f/set-object', '/f/wrapped', '/f/rettype',
    '/f/concise', '/f/two-hop', '/f/next', '/f/mw', '/f/regex', '/F/Case', 'https://checkout.stripe.com/pay',
    'https://checkout.stripe.com/const', '/f/btn', '/f/unquoted', '/apx',
    '/f/mw-local', '/f/use-prefix', '/f/shadow', '/f/param-shadow', '/f/hop-apex', '/f/helper', '/f/route-chain', '/f/slash-hole',
    '/f/append', '/f/writehead-var', '/f/alias', '/f/bind', '/f/elem', '/f/call', '/f/star-hop', '/f/hole${…}', '/f/legacy-order', '/f/methods'])
    t(`fail-matrix ✗ ${route}`, has('fail-matrix', row('✗', route)));
  t('fail-matrix: /f/ok (the formaction host form) is verified, not failed', has('fail-matrix', row('✓', '/f/ok')));
  t('cross-origin-3xx: FAIL names the variable target', has('cross-origin-3xx', /✗ \S+ POST \/pay — \S+ 303: target `portalUrl`/));
  // A policy listing both own origins: the chain is followed INTO the sibling origin (never taken as
  // terminal), and the visited-set is keyed on the answering origin (/x/p leads somewhere only on api).
  t('cross-own-origin ✗ a sibling-origin hop is followed to its cross-origin 303', has('cross-own-origin', row('✗', 'https://algovault.com/x/start')));
  t('cross-own-origin ✗ one path visited on both origins is judged on each', has('cross-own-origin', row('✗', 'https://algovault.com/x/loop')));
  t("cross-own-origin ✓ back to the page origin is allowed by 'self' — bound to the PAGE, not the hop", has('cross-own-origin', /✓ \S+ POST https:\/\/algovault\.com\/x\/back .*2 own-origin hop\(s\) followed/));
  t('cross-own-origin ✓ a sibling-origin hop to a 200 is verified', has('cross-own-origin', /✓ \S+ POST https:\/\/algovault\.com\/x\/ok .*1 own-origin hop\(s\) followed/));
  // PASS matrix: correct code must never FAIL (a false FAIL blocks every checkout's commits).
  for (const route of ['/p/chain', '/p/rel', '/p/tpl', '/p/concat', '/p/ternary', '/p/api-abs', '/p/regex', '/p/back', '/p/handoff', '/p/upper',
    '/email/unsubscribe/${…}', '/p/decoy', '/p/json301', '/p/hop', '/p/writehead-rel', '/p/local-const', '/p/const-tpl', '/p/helper-ok', '/p/rate', '/p/limiter-local', '/p/prg'])
    t(`pass-matrix ✓ ${route}`, has('pass-matrix', row('✓', route)));
  t('pass-matrix: a GET form to an unserved path is reported, not failed', has('pass-matrix', /GET \/verify — no Express registration serves it/));
  t('pass-matrix: a GET form with no action is SAME_DOCUMENT', has('pass-matrix', /SAME_DOCUMENT, reported/));
  t('pass-matrix: method=dialog never navigates', has('pass-matrix', /method=dialog/));
  t('pass-matrix: the hop to a 200 route is followed', has('pass-matrix', /\/p\/hop .*1 own-origin hop\(s\) followed/));
  t('pass-matrix: a form commented out inside a literal is not counted', !has('pass-matrix', /\/p\/commented/));
  t('pass-matrix: a + chain of several template parts yields exactly ONE form', (got['pass-matrix'].lines || []).filter((l) => row('✓', '/p/chain').test(l)).length === 1);
  for (const d of ['fail-matrix', 'pass-matrix', 'indeterminate-matrix']) {
    const keys = (got[d].lines || []).filter((l) => /^ {2}[✓✗?·] \S+:\d+ /.test(l)).map((l) => l.split(' — ')[0].replace(/ → .*/, ''));
    t(`${d}: no form target is reported twice`, new Set(keys).size === keys.length);
  }
  // INDETERMINATE matrix: each per-form reason is distinct and reachable.
  for (const reason of ['FORM_UNROUTED', 'SAME_DOCUMENT_POST', 'ACTION_ORIGIN_UNRESOLVED', 'ACTION_UNRESOLVED', 'HANDLER_UNRESOLVED', 'FORM_UNPARSED', 'FORM_ATTRS_INTERPOLATED', 'FORM_NO_SERVING_ORIGIN'])
    t(`indeterminate-matrix reason ${reason}`, has('indeterminate-matrix', new RegExp(`\\? \\S+ .*${reason}`)));
  // An attribute interpolation the gate cannot enumerate (a parameter: `<form ${attrs}>`) is INDETERMINATE…
  t('indeterminate-matrix: FORM_ATTRS_INTERPOLATED fires on the parameter-attributes form',
    (got['indeterminate-matrix'].lines || []).filter((l) => /^\s*\? \S+ .*FORM_ATTRS_INTERPOLATED/.test(l)).length === 1);
  // …while a const that injects action= right after a quoted value (`id="x"${ACT}`) is EXPANDED and judged.
  t('fail-matrix: a const-injected action= after a quoted value is seen and refused', has('fail-matrix', /✗ \S+ POST https:\/\/evil\.example\.com\/x — the submission itself is refused/));
  // A const-resolved FAIL still names the variable the author wrote, on ONE line.
  t('cross-origin-3xx: a const-resolved FAIL names the variable and its initializer on one line',
    has('cross-origin-3xx', /target `portalUrl` → target `await mintSession\(\)` is not provably same-origin/));
  // The regression corpus: every round-3 adversarial reproduction (a fail-open, a false alarm, or its
  // sibling/control), each with its REVIEWED verdict and pinned lines. The floor makes a deleted or
  // emptied corpus fail rather than pass by having nothing to check.
  const regDir = path.join(root, 'tests', 'fixtures', 'form-action', 'regressions');
  const regTrees = fs.existsSync(regDir) ? fs.readdirSync(regDir).filter((x) => fs.existsSync(path.join(regDir, x, 'expect.json'))).sort() : [];
  t(`regression corpus present (${regTrees.length} tree(s), floor 170)`, regTrees.length >= 170);
  for (const x of regTrees) {
    let exp; let r;
    try { exp = JSON.parse(fs.readFileSync(path.join(regDir, x, 'expect.json'), 'utf8')); } catch (e) { t(`regression ${x}: expect.json unreadable (${e && e.message})`, false); continue; }
    try { r = analyse(path.join(regDir, x)); } catch (e) { r = { verdict: 'THREW', reason: String(e && e.message), lines: [] }; }
    const ls = r.lines || [];
    const missing = (exp.has || []).filter((re) => !ls.some((l) => new RegExp(re).test(l)));
    const present = (exp.lacks || []).filter((re) => ls.some((l) => new RegExp(re).test(l)));
    t(`regression ${x} → ${exp.verdict} (got ${r.verdict}: ${r.reason}${missing.length ? `; missing ${missing.join(' | ')}` : ''}${present.length ? `; unexpected ${present.join(' | ')}` : ''})`,
      r.verdict === exp.verdict && !missing.length && !present.length);
  }
  // Pure pieces.
  t("formActionAllows: 'self' allows same origin", formActionAllows(["'self'"], '/x', API_ORIGIN));
  t("formActionAllows: 'self' refuses another origin", !formActionAllows(["'self'"], 'https://billing.stripe.com/p', API_ORIGIN));
  t("formActionAllows: 'none' refuses even same origin", !formActionAllows(["'none'"], '/x', API_ORIGIN));
  t('formActionAllows: explicit origin + wildcard host', formActionAllows(['https://billing.stripe.com'], 'https://billing.stripe.com/p', API_ORIGIN) && formActionAllows(['*.stripe.com'], 'https://billing.stripe.com/p', API_ORIGIN));
  t('scanForms: > inside a quoted attribute does not end the tag', scanForms('<form onsubmit="return a>3" action="/x" method="post">').forms[0]?.targets[0].action === '/x');
  t('scanForms: data-action is not action', scanForms('<form data-action="/no" action="/yes">').forms[0]?.targets[0].action === '/yes');
  t('scanForms: NonNullable<Format… is not a form', scanForms('NonNullable<FormatThing>').forms.length === 0);
  t('scanForms: prose mentioning a <form tag is not FORM_UNPARSED', scanForms('the <form tag is missing').unparsed.length === 0);
  t('pathMatches: a hole after a literal head matches only routes under it', pathMatches('/account/portal', `/account${MULTI}`) && !pathMatches('/signup', `/account${MULTI}`));
  t('pathMatches: :param and * routes', pathMatches('/pay/:plan', '/pay/pro') && pathMatches('/checkout/*', '/checkout/pro') && !pathMatches('/pay/:plan', '/pay'));
  t('apexProxiedMatchers: handle, @matcher, route and a site-address list', (() => {
    const m = apexProxiedMatchers('algovault.com, www.algovault.com {\n @j path /join/*\n handle @j {\n  reverse_proxy http://localhost:3000\n }\n route /r {\n  reverse_proxy 127.0.0.1:3000\n }\n handle /s {\n  file_server\n }\n}\n');
    return m && m.length === 2 && m.some((re) => re.test('/join/start')) && m.some((re) => re.test('/r'));
  })());
  // Bypassed artifacts on the REAL tree: the readers must find the live corpus at all.
  let live;
  try { live = analyse(root); } catch (e) { live = { verdict: 'THREW', reason: String(e && e.message), lines: [] }; }
  if (live.verdict === 'INDETERMINATE' || live.verdict === 'THREW') {
    return { verdict: 'INDETERMINATE', detail: `the live tree is not analysable (${live.verdict}: ${live.reason}); logic assertions: ${pass} passed, ${failures.length} failed`, failures };
  }
  t('live tree: both policies are evaluated', live.lines.filter((l) => l.startsWith('  policy ')).length === 2);
  t('live tree: the /account/portal form is judged', live.lines.some((l) => /[✓✗] src\/lib\/account-handlers\.ts:\d+ POST \/account\/portal/.test(l)));
  if (pass + failures.length === 0) return { verdict: 'INDETERMINATE', detail: 'zero assertions ran' };
  return { verdict: failures.length ? 'FAIL' : 'PASS', detail: `${pass} passed, ${failures.length} failed`, failures };
}

// ───────────────────────────── main ─────────────────────────────

function emit(verdict, reason, lines = []) {
  for (const l of lines) console.log(l);
  if (reason) console.log(`[form-action] ${verdict}: ${reason}`);
  console.log(`${TOKEN}=${verdict}`);
  process.exitCode = CODES[verdict]; // never process.exit(): a queued pipe write would lose the token
}

async function main(argv) {
  let root = DEFAULT_ROOT; let mode = 'check';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') continue;
    if (a === '--self-test') { mode = 'self-test'; continue; }
    if (a === '--root') {
      const v = argv[i + 1];
      if (!v || v.startsWith('-')) return emit('INDETERMINATE', 'bad invocation: --root needs a directory');
      if (!fs.existsSync(v) || !fs.statSync(v).isDirectory()) return emit('INDETERMINATE', `bad invocation: --root ${v} is not a directory`);
      root = path.resolve(v); i++; continue;
    }
    return emit('INDETERMINATE', `bad invocation: unknown argument ${JSON.stringify(a)}`);
  }
  try { await loadDeps(); } catch (e) { return emit('INDETERMINATE', `a shared dependency failed to load (${e && e.message}) — typescript, or a shared CSP / comment-strip module`); }
  if (mode === 'self-test') {
    let st;
    try { st = selfTest(root); } catch (e) { st = { verdict: 'INDETERMINATE', detail: `self-test threw: ${e && e.message}` }; }
    for (const f of st.failures ?? []) console.error(`  ✗ ${f}`);
    console.log(`SELF-TEST: ${st.verdict} (${st.detail})`);
    return emit(st.verdict);
  }
  let r;
  try { r = analyse(root); } catch (e) { r = { verdict: 'INDETERMINATE', reason: `analyse threw: ${e && e.message}`, lines: [] }; }
  console.log(`[form-action] root ${root}`);
  return emit(r.verdict, r.reason, r.lines);
}

// Compare REAL paths: invoked through a symlinked path (macOS /var -> /private/var, a symlinked
// checkout), a plain string compare silently skips main and exits 0 with NO token — a dark gate.
const realOrNull = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
if (Boolean(process.argv[1]) && realOrNull(path.resolve(process.argv[1])) === realOrNull(SELF)) {
  main(process.argv.slice(2)).catch((e) => emit('INDETERMINATE', `unexpected error: ${e && e.message}`));
}
