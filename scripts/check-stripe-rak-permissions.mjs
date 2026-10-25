#!/usr/bin/env node
// @ts-check
/**
 * check-stripe-rak-permissions.mjs — every Stripe request this repo makes is covered by the
 * permissions of the server's restricted key.
 *
 * OPS-NODE-SECURITY-FLOOR-W1 / CH3 R0.
 *
 * THE BUG CLASS. A restricted key is checked per request, so a request its permissions do not
 * cover fails only when it runs: for a checkout or a portal session, in front of the customer who
 * asked for it; and the payment-method lookup in src/lib/stripe.ts is fail-open by contract, so a
 * 403 there costs the attribution with nothing but a log line. Nothing compared the code's
 * requests with the key before a deploy, so the first sign of a missing permission would have been
 * a customer. This compares them on every deploy.
 *
 * WHERE A CALL'S REQUEST COMES FROM: the installed SDK. Each resource method names its verb and
 * path in its own source (`this._makeRequest('POST', `/v1/customers/${id}`)`). The gate builds a
 * client offline (a placeholder string, no key, no request) and reads every method's request back.
 * It finds calls in the tracked .ts/.js files under scan.roots with the TypeScript parser: a call
 * is a property chain ending in a resource and method the SDK has
 * (`client.checkout.sessions.retrieve(`), whatever the receiver is called. Comments and strings
 * are not code, so neither counts.
 *
 * WHAT IT ASSERTS (against ops/stripe-rak-permissions.json):
 *   (a) every SDK call's request has a row in `endpoints`; an unmapped one is INDETERMINATE (find
 *       it in the permissions reference, then add the row);
 *   (b) every `expand` is an array of string literals in the call itself, and every field of every
 *       path has a row in `expand_fields`; anything else is INDETERMINATE;
 *   (c) every raw `api.stripe.com/v1/…` URL is declared in `raw_calls` with its verb; an undeclared
 *       one is INDETERMINATE;
 *   (d) every permission (a)–(c) need is in `key.granted`, a write grant covering the read of the
 *       same resource; a missing one is FAIL, naming the permission and each call that needs it;
 *   (e) a Stripe client's resource taken as a value (aliased, destructured, a computed key, a
 *       method passed uncalled) is INDETERMINATE: the calls made through it cannot be seen.
 * Vacuity: the SDK surface must be the real one (a size floor, and three methods must read back
 * their known requests), and the anchor file must contribute at least one call.
 *
 * NO NETWORK, NO KEY. `key.granted` mirrors the live key; the CH3 R4 smoke matrix
 * (src/scripts/stripe-rak-smoke.ts) is the live check of both.
 *
 * Usage:
 *   node scripts/check-stripe-rak-permissions.mjs --self-test
 *   node scripts/check-stripe-rak-permissions.mjs
 *   node scripts/check-stripe-rak-permissions.mjs --sync   # rewrite `derived`, then check
 *
 * `derived` records where each request is made. The check reports drift from it
 * (STRIPE_RAK_SITES_DRIFT=<n>) and never fails on it; --sync rewrites it.
 *
 * Verdict: exactly one terminal `STRIPE_RAK_PERMISSIONS_VERDICT=PASS|FAIL|INDETERMINATE`. Callers
 * gate on the TOKEN, not the code. A verified violation outranks an undecidable call:
 * FAIL > INDETERMINATE > PASS.
 * Exit: 0 = PASS · 1 = FAIL · 3 = INDETERMINATE.
 */

import { readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CODES = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };
const MANIFEST_FILE = join(ROOT, 'ops/stripe-rak-permissions.json');
const CODE_FILE = /\.(ts|mts|cts|tsx|js|mjs|cjs|jsx)$/;
const TEXT_FILE = /\.(sh|bash|py)$/;
const PLACEHOLDER = 'introspection-only-no-request'; // not key-shaped: a client built with it sends nothing
const MIN_SURFACE = 400; // stripe 22.0.1 reads back 561 methods (2026-10-25); far fewer is not that SDK
/** Methods whose requests are known. The real surface must read these back, or the reader is broken. */
const KNOWN = {
  'customers.search': 'GET /v1/customers/search',
  'checkout.sessions.retrieve': 'GET /v1/checkout/sessions/{}',
  'customers.createBalanceTransaction': 'POST /v1/customers/{}/balance_transactions',
};
const REQUEST = /^(GET|POST|DELETE) (\/v[12](?:\/[A-Za-z0-9_.{}-]+)+)$/;
const PERMISSION = /^[a-z][a-z0-9_]*_(?:read|write)$/;
const MAKE_REQUEST = /_makeRequest\(\s*['"]([A-Z]+)['"]\s*,\s*(?:`([^`]*)`|'([^']*)'|"([^"]*)")/;
const STRIPE_URL = /api\.stripe\.com(\/v[12]\/[A-Za-z0-9_.{}$/-]*)/;

/** Placeholders, query and trailing slash normalised: `/v1/customers/${id}/?x=1` → `/v1/customers/{}`. */
export function normPath(p) {
  return p
    .replace(/\$\{[^}]*\}|\$[A-Za-z_]\w*/g, '{}')
    .replace(/\{[^}]*\}/g, '{}')
    .replace(/[?#].*$/, '')
    .replace(/(.)\/+$/, '$1');
}

/** `POST /v1/customers/{customer}` → `POST /v1/customers/{}`; anything that is not a request → null. */
export function normRequest(s) {
  if (typeof s !== 'string') return null;
  const m = /^\s*([A-Z]+)\s+(\S+)\s*$/.exec(s);
  const r = m ? `${m[1]} ${normPath(m[2])}` : '';
  return REQUEST.test(r) ? r : null;
}

const readOf = (p) => p.slice(0, -'_write'.length) + '_read';
const writeOf = (p) => p.slice(0, -'_read'.length) + '_write';

/** A grant covers its own permission, and a write grant covers the read of the same resource. */
export function covers(granted, permission) {
  return granted.has(permission) || (permission.endsWith('_read') && granted.has(writeOf(permission)));
}

/** The smallest grant set covering `needed`: a resource whose write is needed needs no read. */
export function minimalGrants(needed) {
  return [...needed].filter((p) => !(p.endsWith('_read') && needed.has(writeOf(p)))).sort();
}

export function verdictOf(res) {
  if (res.fail.length) return 'FAIL';
  if (res.indeterminate.length || res.scanned === 0) return 'INDETERMINATE';
  return 'PASS';
}

// ── manifest ─────────────────────────────────────────────────────────────────

/** Parse and check the manifest. Anything malformed is a refusal: the gate cannot judge against it. */
export function loadManifest(text) {
  let m;
  try {
    m = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: `the manifest is not JSON: ${err instanceof Error ? err.message : err}` };
  }
  const bad = (reason) => ({ ok: false, reason: `the manifest is malformed: ${reason}` });
  const list = (x) => (x === undefined ? [] : Array.isArray(x) ? x : null);
  if (!m || typeof m !== 'object' || Array.isArray(m)) return bad('not an object');
  const granted = m.key?.granted;
  if (!Array.isArray(granted) || !granted.length || !granted.every((p) => PERMISSION.test(p))) {
    return bad('key.granted must be a non-empty list of permission ids');
  }
  if (!Array.isArray(m.endpoints) || !m.endpoints.length) return bad('endpoints must be a non-empty list');
  const endpoints = new Map();
  for (const [i, e] of m.endpoints.entries()) {
    const r = normRequest(e?.request);
    if (!r || !PERMISSION.test(e?.permission ?? '')) return bad(`endpoints[${i}] needs a request ("VERB /v1/…") and a permission id`);
    if (endpoints.has(r)) return bad(`endpoints[${i}] repeats ${r}`);
    endpoints.set(r, e.permission);
  }
  const f = m.expand_fields;
  if (!f || typeof f !== 'object' || Array.isArray(f) || !Object.values(f).every((p) => typeof p === 'string' && PERMISSION.test(p))) {
    return bad('expand_fields must map field names to permission ids');
  }
  const raw = list(m.raw_calls);
  const notStripe = list(m.not_stripe);
  if (!raw || !notStripe) return bad('raw_calls and not_stripe must be lists');
  const rawCalls = [];
  for (const [i, r] of raw.entries()) {
    const req = normRequest(r?.request);
    if (!req || typeof r?.file !== 'string' || !r.file) return bad(`raw_calls[${i}] needs a file and a request`);
    rawCalls.push({ file: r.file, request: req });
  }
  for (const [i, n] of notStripe.entries()) {
    if (typeof n?.file !== 'string' || typeof n?.text !== 'string' || typeof n?.reason !== 'string' || !n.reason.trim()) {
      return bad(`not_stripe[${i}] needs a file, the matched text and a reason`);
    }
  }
  const s = m.scan;
  const roots = list(s?.roots);
  const exclude = list(s?.exclude);
  const getters = list(s?.client_getters);
  if (!roots?.length || !exclude || !getters || typeof s?.anchor !== 'string' || !s.anchor) {
    return bad('scan needs roots, exclude, client_getters and an anchor');
  }
  return {
    ok: true,
    doc: m,
    granted: new Set(granted),
    endpoints,
    fields: new Map(Object.entries(f)),
    rawCalls,
    notStripe: notStripe.map((n) => ({ file: n.file, text: n.text, reason: n.reason })),
    roots,
    exclude: new Set(exclude),
    getters: new Set(getters),
    anchor: s.anchor,
  };
}

// ── the SDK's surface ────────────────────────────────────────────────────────

/** Every resource method on a Stripe client → its request, read from the method's own source. */
export function sdkSurface(client) {
  const surface = new Map(); // 'checkout.sessions.retrieve' → 'GET /v1/checkout/sessions/{}'
  const unparsed = new Set(); // methods whose request could not be read
  const seen = new WeakSet([client]); // every resource points back at the client
  const walk = (obj, path) => {
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (k.startsWith('_') || !v || typeof v !== 'object' || seen.has(v)) continue;
      seen.add(v);
      const proto = Object.getPrototypeOf(v);
      if (proto && typeof v._makeRequest === 'function') {
        for (const name of Object.getOwnPropertyNames(proto)) {
          const fn = Object.getOwnPropertyDescriptor(proto, name)?.value;
          if (name === 'constructor' || typeof fn !== 'function') continue;
          const key = [...path, k, name].join('.');
          const hit = MAKE_REQUEST.exec(Function.prototype.toString.call(fn));
          const req = hit ? normRequest(`${hit[1]} ${hit[2] ?? hit[3] ?? hit[4]}`) : null;
          if (req) surface.set(key, req);
          else unparsed.add(key);
        }
      }
      if (path.length < 4) walk(v, [...path, k]);
    }
  };
  walk(client, []);
  return { surface, unparsed, top: new Set([...surface.keys(), ...unparsed].map((key) => key.split('.')[0])) };
}

/** Why a surface is not the real SDK's, or null: a reader that finds too little, or misreads a known method, is broken. */
export function surfaceProblem(sdk, floor = MIN_SURFACE, known = KNOWN) {
  if (sdk.surface.size < floor) return `the SDK read back ${sdk.surface.size} methods (floor ${floor}): the reader no longer understands it`;
  for (const [k, want] of Object.entries(known)) {
    if (sdk.surface.get(k) !== want) return `${k} read back ${sdk.surface.get(k) ?? 'nothing'}, not ${want}: the reader misreads the SDK`;
  }
  return null;
}

/** The stripe package this repo installs, built offline. */
function loadSdk() {
  try {
    const req = createRequire(join(ROOT, 'package.json'));
    const mod = req('stripe');
    const Ctor = typeof mod === 'function' ? mod : (mod.default ?? mod.Stripe);
    let version = null;
    for (let d = dirname(req.resolve('stripe')); d !== dirname(d) && !version; d = dirname(d)) {
      const f = join(d, 'package.json');
      const pkg = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
      if (pkg?.name === 'stripe') version = pkg.version;
    }
    return { ok: true, sdk: sdkSurface(new Ctor(PLACEHOLDER)), version };
  } catch (err) {
    return { ok: false, reason: `the stripe package could not be loaded offline: ${err instanceof Error ? err.message : err}` };
  }
}

function loadTs() {
  try {
    return { ok: true, ts: createRequire(join(ROOT, 'package.json'))('typescript') };
  } catch (err) {
    return { ok: false, reason: `typescript could not be loaded (npm ci installs it): ${err instanceof Error ? err.message : err}` };
  }
}

// ── the scan ─────────────────────────────────────────────────────────────────

const BUILT_IN_PIECES = 'a Stripe URL built in pieces: the request it makes cannot be read';

/**
 * Every Stripe request one code file makes, from its syntax tree:
 * { calls, expands, raws, unclear }, each item { file, line, text, … }. `text` is what a
 * `not_stripe` entry names: a call's callee, or the code that was flagged.
 */
export function scanCode(ts, file, text, sdk, getters) {
  const kind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX
    : /\.[mc]?ts$/.test(file) ? ts.ScriptKind.TS
      : /\.jsx$/.test(file) ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const found = { calls: [], expands: [], raws: [], unclear: [] };
  const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const textOf = (n) => n.getText(sf).replace(/\s*\n\s*/g, '');
  const unclear = (n, why, t = textOf(n)) => found.unclear.push({ file, line: lineOf(n), text: t, why });
  const ASSIGN = new Set([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.BarBarEqualsToken]);

  const syntax = sf.parseDiagnostics?.[0];
  if (syntax) {
    found.unclear.push({
      file,
      line: sf.getLineAndCharacterOfPosition(syntax.start ?? 0).line + 1,
      text: '(syntax error)',
      why: `the file does not parse (${ts.flattenDiagnosticMessageText(syntax.messageText, ' ')}), so its calls cannot be read`,
    });
  }

  const unwrap = (n) => {
    while (n && (ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n) || ts.isAsExpression(n)
      || ts.isTypeAssertionExpression(n) || ts.isAwaitExpression(n) || ts.isSatisfiesExpression(n))) n = n.expression;
    return n;
  };
  const isMember = (n) => !!n && (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n));
  /** The static name a member access reads (`a.b`, `a['b']`), or null for a computed key. */
  const nameOf = (n) => {
    if (ts.isPropertyAccessExpression(n)) return n.name.text;
    const k = n.argumentExpression;
    return k && ts.isStringLiteralLike(k) ? k.text : null;
  };
  const propName = (p) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) ? p.name.text : null);
  /** `a.b['c'].d` → ['a', 'b', 'c', 'd']. The walk stops at anything that is not a static name, such as a call. */
  const chainOf = (n) => {
    const names = [];
    for (let cur = unwrap(n); cur;) {
      if (isMember(cur)) {
        const name = nameOf(cur);
        if (name === null) break;
        names.unshift(name);
        cur = unwrap(cur.expression);
      } else {
        if (ts.isIdentifier(cur)) names.unshift(cur.text);
        else if (cur.kind === ts.SyntaxKind.ThisKeyword) names.unshift('this');
        break;
      }
    }
    return names;
  };

  // Pass A: the names this file binds to the stripe constructor, and to a client.
  const ctors = new Set();
  const clients = new Set();
  const localGetters = new Set();
  const isStripeSpecifier = (n) => !!n && ts.isStringLiteralLike(n) && n.text === 'stripe';
  const isStripeModule = (n) => {
    n = unwrap(n);
    return !!n && ts.isCallExpression(n) && isStripeSpecifier(n.arguments[0])
      && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'));
  };
  const isCtorRef = (n) => {
    n = unwrap(n);
    if (!n) return false;
    if (ts.isIdentifier(n)) return ctors.has(n.text);
    if (!isMember(n) || !['default', 'Stripe'].includes(nameOf(n) ?? '')) return false;
    const base = unwrap(n.expression);
    return (ts.isIdentifier(base) && ctors.has(base.text)) || isStripeModule(base);
  };
  const isClient = (n) => {
    n = unwrap(n);
    if (!n) return false;
    if (ts.isIdentifier(n)) return clients.has(n.text);
    if (ts.isPropertyAccessExpression(n)) return n.expression.kind === ts.SyntaxKind.ThisKeyword && clients.has(n.name.text);
    if (ts.isNewExpression(n)) return isCtorRef(n.expression);
    if (ts.isCallExpression(n)) {
      if (isStripeModule(n.expression) || isCtorRef(n.expression)) return true; // require('stripe')(key), Stripe(key)
      const c = chainOf(n.expression);
      return c.length > 0 && (getters.has(c[c.length - 1]) || localGetters.has(c[c.length - 1]));
    }
    return false;
  };
  const typeIsClient = (t) => {
    if (!t) return false;
    if (ts.isUnionTypeNode(t) || ts.isIntersectionTypeNode(t)) return t.types.some(typeIsClient);
    if (ts.isParenthesizedTypeNode(t)) return typeIsClient(t.type);
    return ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName) && ctors.has(t.typeName.text); // `Stripe`, never `Stripe.Customer`
  };
  const visitCtors = (n) => {
    if (ts.isImportDeclaration(n) && isStripeSpecifier(n.moduleSpecifier) && n.importClause) {
      const c = n.importClause;
      if (c.name) ctors.add(c.name.text);
      const b = c.namedBindings;
      if (b && ts.isNamespaceImport(b)) ctors.add(b.name.text);
      if (b && ts.isNamedImports(b)) for (const el of b.elements) ctors.add(el.name.text);
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)
      && isStripeSpecifier(n.moduleReference.expression)) {
      ctors.add(n.name.text);
    } else if (ts.isVariableDeclaration(n) && n.initializer) {
      if (ts.isIdentifier(n.name) && (isStripeModule(n.initializer) || isCtorRef(n.initializer))) ctors.add(n.name.text);
      else if (ts.isObjectBindingPattern(n.name) && isStripeModule(n.initializer)) {
        for (const el of n.name.elements) if (ts.isIdentifier(el.name)) ctors.add(el.name.text);
      }
    }
    ts.forEachChild(n, visitCtors);
  };
  const visitClients = (n) => {
    if ((ts.isVariableDeclaration(n) || ts.isPropertyDeclaration(n) || ts.isParameter(n))
      && n.name && (ts.isIdentifier(n.name) || ts.isPrivateIdentifier(n.name))) {
      if (typeIsClient(n.type) || (n.initializer && isClient(n.initializer))) clients.add(n.name.text);
      const f = n.initializer && unwrap(n.initializer);
      if (f && (ts.isArrowFunction(f) || ts.isFunctionExpression(f)) && typeIsClient(f.type)) localGetters.add(n.name.text);
    } else if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name && ts.isIdentifier(n.name) && typeIsClient(n.type)) {
      localGetters.add(n.name.text);
    } else if (ts.isBinaryExpression(n) && ASSIGN.has(n.operatorToken.kind) && isClient(n.right)) {
      const l = unwrap(n.left);
      if (ts.isIdentifier(l)) clients.add(l.text);
      else if (ts.isPropertyAccessExpression(l) && l.expression.kind === ts.SyntaxKind.ThisKeyword) clients.add(l.name.text);
    }
    ts.forEachChild(n, visitClients);
  };
  visitCtors(sf);
  for (let size = -1; size !== clients.size + localGetters.size;) { // a getter declared below its first use
    size = clients.size + localGetters.size;
    visitClients(sf);
  }

  // Pass B: the requests.
  const matched = new Set(); // call nodes that are Stripe requests
  const attached = new Set(); // `expand` properties written in a Stripe call's own arguments
  const attachExpands = (call, method, record) => {
    for (const a of call.arguments) {
      const arg = unwrap(a);
      if (!arg || !ts.isObjectLiteralExpression(arg)) continue;
      for (const p of arg.properties) {
        if (propName(p) !== 'expand') continue;
        attached.add(p);
        if (!record) continue;
        const v = ts.isPropertyAssignment(p) ? unwrap(p.initializer) : null;
        if (v && ts.isArrayLiteralExpression(v) && v.elements.every((e) => ts.isStringLiteralLike(e))) {
          for (const e of v.elements) found.expands.push({ file, line: lineOf(e), text: textOf(call.expression), method, path: e.text });
        } else {
          unclear(p, `the \`expand\` of ${method} is not a list of string literals`, textOf(call.expression));
        }
      }
    }
  };
  const onCall = (n) => {
    const names = chainOf(n.expression);
    const last = names[names.length - 1];
    if (names.length >= 2 && last === 'rawRequest') {
      matched.add(n);
      const [verb, path] = n.arguments.map(unwrap);
      const request = verb && path && ts.isStringLiteralLike(verb) && ts.isStringLiteralLike(path) ? normRequest(`${verb.text} ${path.text}`) : null;
      if (request) found.calls.push({ file, line: lineOf(n), text: textOf(n.expression), method: 'rawRequest', request });
      else unclear(n, 'a rawRequest whose verb and path are not string literals', textOf(n.expression));
      attachExpands(n, 'rawRequest', true);
      return;
    }
    for (let k = Math.min(names.length, 5); k >= 2; k--) {
      const key = names.slice(-k).join('.');
      if (sdk.surface.has(key)) {
        matched.add(n);
        found.calls.push({ file, line: lineOf(n), text: textOf(n.expression), method: key, request: sdk.surface.get(key) });
        attachExpands(n, key, true);
        return;
      }
      if (sdk.unparsed.has(key)) {
        matched.add(n);
        unclear(n, `${key} is an SDK method whose request the gate cannot read`, textOf(n.expression));
        attachExpands(n, key, false);
        return;
      }
    }
    if (names.length >= 2 && names[names.length - 2] === 'expand' && ['push', 'unshift', 'splice', 'concat'].includes(last)) {
      unclear(n, 'an `expand` list changed after it was written: the request it shapes cannot be read', textOf(n.expression));
    }
  };
  const onLiteral = (n) => {
    const s = ts.isTemplateExpression(n) ? n.head.text + n.templateSpans.map((sp) => `{}${sp.literal.text}`).join('') : n.text;
    if (!s.includes('api.stripe.com')) return;
    const re = new RegExp(STRIPE_URL.source, 'g');
    let any = false;
    for (let m; (m = re.exec(s));) {
      any = true;
      found.raws.push({ file, line: lineOf(n), text: textOf(n), path: normPath(m[1]) });
    }
    if (!any) unclear(n, BUILT_IN_PIECES);
  };
  /** `client.<resource>` must be the head of a call the scan read; anything else hides the calls made through it. */
  const onClientMember = (n) => {
    const name = nameOf(n);
    if (name === null) return unclear(n, 'a computed key on the Stripe client: the calls made through it cannot be read');
    if (!sdk.top.has(name)) return;
    let top = n;
    for (let p = top.parent; p && p.expression === top && (isMember(p) || ts.isNonNullExpression(p) || ts.isParenthesizedExpression(p)); p = top.parent) top = p;
    const p = top.parent;
    if (p && ts.isCallExpression(p) && p.expression === top && matched.has(p)) return;
    unclear(n, `\`${textOf(top)}\` takes a Stripe resource as a value: the calls made through it cannot be read`, textOf(top));
  };
  const onDestructure = (n) => {
    for (const el of n.name.elements) {
      const key = el.propertyName
        ? (ts.isIdentifier(el.propertyName) || ts.isStringLiteralLike(el.propertyName) ? el.propertyName.text : null)
        : (ts.isIdentifier(el.name) ? el.name.text : null);
      if (el.dotDotDotToken || key === null || sdk.top.has(key)) {
        return unclear(n, 'a Stripe resource destructured from the client: the calls made through it cannot be read');
      }
    }
  };
  const visit = (n) => {
    if (ts.isCallExpression(n)) onCall(n);
    else if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && propName(n) === 'expand' && !attached.has(n)) {
      unclear(n, 'an `expand` outside a Stripe call\'s own arguments: the request it shapes cannot be read');
    } else if (ts.isBinaryExpression(n) && ASSIGN.has(n.operatorToken.kind) && isMember(unwrap(n.left)) && nameOf(unwrap(n.left)) === 'expand') {
      unclear(n.left, 'an `expand` set after the params were written: the request it shapes cannot be read');
    } else if (ts.isStringLiteralLike(n) || ts.isTemplateExpression(n)) onLiteral(n);
    else if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer && isClient(n.initializer)) onDestructure(n);
    if (isMember(n) && isClient(n.expression)) onClientMember(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** A shell or Python file names a request only in a URL; a whole-line `#` comment is not code. */
export function scanText(file, text) {
  const found = { calls: [], expands: [], raws: [], unclear: [] };
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (line.startsWith('#') || !line.includes('api.stripe.com')) return;
    const re = new RegExp(STRIPE_URL.source, 'g');
    let any = false;
    for (let m; (m = re.exec(line));) {
      any = true;
      found.raws.push({ file, line: i + 1, text: line, path: normPath(m[1]) });
    }
    if (!any) found.unclear.push({ file, line: i + 1, text: line, why: BUILT_IN_PIECES });
  });
  return found;
}

/** Scan every file the manifest covers. `files` is [{ file, text }] with repo-relative paths. */
export function scanFiles(ts, files, sdk, man) {
  const scan = { calls: [], expands: [], raws: [], unclear: [], files: files.length, code: 0, text: 0, excluded: 0 };
  for (const { file, text } of files) {
    if (man.exclude.has(file)) {
      scan.excluded++;
      continue;
    }
    let found;
    if (CODE_FILE.test(file)) {
      scan.code++;
      found = scanCode(ts, file, text, sdk, man.getters);
    } else if (TEXT_FILE.test(file)) {
      scan.text++;
      found = scanText(file, text);
    } else continue;
    for (const k of ['calls', 'expands', 'raws', 'unclear']) scan[k].push(...found[k]);
  }
  return scan;
}

// ── judging the scan ─────────────────────────────────────────────────────────

const siteOf = (x) => `${x.file}:${x.line}`;

/**
 * Map every request the scan found to a permission and judge it against the key.
 * { fail, indeterminate, notes, needed: Map(permission → [{ why, site }]), kept, scanned, required }.
 */
export function evaluate(scan, man) {
  const fail = [];
  const indeterminate = [];
  const notes = [];
  const needed = new Map();
  const kept = { calls: [], expands: [], raws: [] };
  const usedNotStripe = new Set();
  const usedRaw = new Set();
  let scanned = 0;
  let anchorCalls = 0;
  const quiet = (x) => {
    const i = man.notStripe.findIndex((n) => n.file === x.file && n.text === x.text);
    if (i < 0) return false;
    usedNotStripe.add(i);
    return true;
  };
  const undecided = (why, x) => indeterminate.push({ why, site: siteOf(x), text: x.text });
  const need = (permission, why, x) => {
    if (!needed.has(permission)) needed.set(permission, []);
    needed.get(permission).push({ why, site: siteOf(x) });
  };

  for (const c of scan.calls) {
    if (quiet(c)) continue;
    scanned++;
    if (c.file === man.anchor) anchorCalls++;
    const permission = man.endpoints.get(c.request);
    if (!permission) {
      undecided(`${c.method} sends ${c.request}, which has no row in endpoints`, c);
      continue;
    }
    need(permission, `${c.method} → ${c.request}`, c);
    kept.calls.push({ ...c, permission });
  }
  for (const x of scan.expands) {
    if (quiet(x)) continue;
    scanned++;
    const perms = new Set();
    let mapped = true;
    x.path.split('.').forEach((field, i) => {
      if (i === 0 && field === 'data') return; // the list cursor, not an object
      const p = man.fields.get(field);
      if (p) perms.add(p);
      else {
        mapped = false;
        undecided(`expand "${x.path}" (${x.method}): the field "${field}" has no row in expand_fields`, x);
      }
    });
    for (const p of perms) need(p, `expand ${x.path} (${x.method})`, x);
    if (mapped) kept.expands.push({ ...x, permissions: [...perms].sort() });
  }
  for (const r of scan.raws) {
    if (quiet(r)) continue;
    scanned++;
    const decls = man.rawCalls.filter((d) => d.file === r.file && d.request.split(' ')[1] === r.path);
    if (!decls.length) {
      undecided(`a raw request to ${r.path} is not declared in raw_calls (the code does not name its verb)`, r);
      continue;
    }
    for (const d of decls) {
      usedRaw.add(d);
      const permission = man.endpoints.get(d.request);
      if (!permission) {
        undecided(`the raw request ${d.request} has no row in endpoints`, r);
        continue;
      }
      need(permission, `raw ${d.request}`, r);
      kept.raws.push({ file: r.file, request: d.request, permission });
    }
  }
  for (const u of scan.unclear) if (!quiet(u)) undecided(u.why, u);

  for (const [permission, uses] of [...needed].sort(([a], [b]) => a.localeCompare(b))) {
    if (!covers(man.granted, permission)) fail.push({ permission, uses });
  }
  if (anchorCalls === 0) {
    indeterminate.push({ why: `the anchor ${man.anchor} contributed no Stripe call, so the scan is not seeing the code`, site: man.anchor, text: '' });
  }
  man.notStripe.forEach((n, i) => {
    notes.push(usedNotStripe.has(i) ? `not Stripe: ${n.file} \`${n.text}\` — ${n.reason}` : `the not_stripe entry ${n.file} \`${n.text}\` matches nothing: remove it`);
  });
  for (const d of man.rawCalls) if (!usedRaw.has(d)) notes.push(`the raw_calls row ${d.file} ${d.request} matches nothing: remove it`);
  return { fail, indeterminate, notes, needed, kept, scanned, required: minimalGrants(new Set(needed.keys())) };
}

/** Grants no request needs: report-only, a least-privilege hint. */
export function unusedGrants(granted, needed) {
  return [...granted].filter((g) => ![...needed].some((p) => p === g || (p.endsWith('_read') && writeOf(p) === g))).sort();
}

// ── `derived`: where each request is made ───────────────────────────────────

const sortKeys = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));

/** What the code asks for, file by file. No line numbers and no timestamps, so it changes only when the calls do. */
export function derive(kept, required) {
  const bump = (sites, file) => {
    sites[file] = (sites[file] ?? 0) + 1;
  };
  const calls = {};
  const expands = {};
  const raw = {};
  for (const c of kept.calls) bump((calls[c.method] ??= { request: c.request, permission: c.permission, sites: {} }).sites, c.file);
  for (const x of kept.expands) bump((expands[x.path] ??= { permissions: x.permissions, sites: {} }).sites, x.file);
  for (const r of kept.raws) bump((raw[r.request] ??= { permission: r.permission, sites: {} }).sites, r.file);
  const tidy = (o) => sortKeys(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { ...v, sites: sortKeys(v.sites) }])));
  return { required: [...required], calls: tidy(calls), expands: tidy(expands), raw: tidy(raw) };
}

/** How many entries of the stored `derived` differ from a fresh one. */
export function driftOf(stored, fresh) {
  const s = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  let n = JSON.stringify(s.required ?? null) === JSON.stringify(fresh.required) ? 0 : 1;
  for (const section of ['calls', 'expands', 'raw']) {
    const a = s[section] && typeof s[section] === 'object' ? s[section] : {};
    const b = fresh[section];
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) n++;
  }
  return n;
}

/** JSON as the manifest is written: two-space indent, a flat row inside a list on one line, a short list of scalars on one line. */
export function serialize(value, indent = '') {
  const inner = `${indent}  `;
  const scalar = (v) => v === null || typeof v !== 'object';
  if (scalar(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    const one = `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
    if (value.every(scalar) && indent.length + one.length <= 100) return one;
    return `[\n${value.map((v) => inner + serialize(v, inner)).join(',\n')}\n${indent}]`;
  }
  const entries = Object.entries(value);
  if (!entries.length) return '{}';
  if (indent.length >= 4 && entries.every(([, v]) => scalar(v))) {
    return `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ')} }`;
  }
  return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${serialize(v, inner)}`).join(',\n')}\n${indent}}`;
}

// ── one check, from its inputs ──────────────────────────────────────────────

/** `src/a.ts:1`, `src/a.ts:9`, `src/b.ts:4` → `src/a.ts:1,9 · src/b.ts:4`. */
function fmtSites(sites) {
  const byFile = new Map();
  for (const s of sites) {
    const i = s.lastIndexOf(':');
    const [file, line] = i > 0 && /^\d+$/.test(s.slice(i + 1)) ? [s.slice(0, i), s.slice(i + 1)] : [s, ''];
    if (!byFile.has(file)) byFile.set(file, []);
    if (line) byFile.get(file).push(line);
  }
  return [...byFile].map(([f, lines]) => (lines.length ? `${f}:${lines.join(',')}` : f)).join(' · ');
}

/**
 * The whole judgement, from the manifest text, the SDK's surface, the parser and the files: everything a
 * run reads from disk comes in as an argument, so the self-test drives this same function.
 * { verdict, out: [{ to, line }], man, scan, res, derived, drift }.
 */
export function check({ manifestText, sdk, ts, files, version = null, floor = MIN_SURFACE, known = KNOWN }) {
  const out = [];
  const say = (line) => out.push({ to: 'out', line });
  const warn = (line) => out.push({ to: 'err', line });
  const man = loadManifest(manifestText);
  if (!man.ok) {
    warn(`? ${man.reason}`);
    return { verdict: 'INDETERMINATE', out };
  }
  say(`  stripe SDK ${version ?? '(version unread)'} — ${sdk.surface.size} methods read back their request (${sdk.unparsed.size} could not be)`);
  const problem = surfaceProblem(sdk, floor, known);
  if (problem) {
    warn(`? ${problem}`);
    return { verdict: 'INDETERMINATE', out, man };
  }
  const scan = scanFiles(ts, files, sdk, man);
  const res = evaluate(scan, man);
  const verdict = verdictOf(res);
  const derived = derive(res.kept, res.required);
  const drift = driftOf(man.doc.derived, derived);
  const suppressed = res.notes.filter((n) => n.startsWith('not Stripe:')).length;
  say(`STRIPE_RAK_SCAN files=${scan.files} code=${scan.code} text=${scan.text} excluded=${scan.excluded} calls=${scan.calls.length} expands=${scan.expands.length} raw=${scan.raws.length} not_stripe=${suppressed}`);
  const failed = new Set(res.fail.map((f) => f.permission));
  for (const [permission, uses] of [...res.needed].sort(([a], [b]) => a.localeCompare(b))) {
    const via = man.granted.has(permission) ? '' : ` (covered by ${writeOf(permission)})`;
    if (failed.has(permission)) warn(`✖ ${permission} — the key does not grant it, and the code needs it:`);
    else say(`✓ ${permission}${via}`);
    const byWhy = new Map();
    for (const u of uses) byWhy.set(u.why, [...(byWhy.get(u.why) ?? []), u.site]);
    for (const [why, sites] of byWhy) (failed.has(permission) ? warn : say)(`    ${why} · ${fmtSites(sites)}`);
  }
  const byWhy = new Map();
  for (const x of res.indeterminate) byWhy.set(x.why, [...(byWhy.get(x.why) ?? []), x]);
  for (const [why, xs] of byWhy) {
    warn(`? ${why}`);
    for (const x of xs) warn(`    ${x.site}${x.text ? `  ${x.text}` : ''}`);
  }
  for (const n of res.notes) say(`  note: ${n}`);
  const unused = unusedGrants(man.granted, new Set(res.needed.keys()));
  say(`STRIPE_RAK_REQUIRED=${res.required.join(',')}`);
  say(`STRIPE_RAK_UNUSED_GRANTS=${unused.length ? unused.join(',') : 'none'}`);
  say(`STRIPE_RAK_SITES_DRIFT=${drift}${drift ? ' (run with --sync and commit ops/stripe-rak-permissions.json)' : ''}`);
  return { verdict, out, man, scan, res, derived, drift };
}

// ── self-test ────────────────────────────────────────────────────────────────

const SELF_TEST_MIN_CHECKS = 75;

/** A client built like the SDK's: resources whose methods name their request in their own source, each pointing back at the client. */
function fakeClient() {
  class Base {
    _makeRequest() {
      throw new Error('the self-test never sends a request');
    }
  }
  class Customers extends Base {
    search(p) { return this._makeRequest('GET', '/v1/customers/search', p); }
    update(id, p) { return this._makeRequest('POST', `/v1/customers/${id}`, p); }
    createBalanceTransaction(id, p) { return this._makeRequest('POST', `/v1/customers/${id}/balance_transactions`, p); }
    helper() { return null; }
  }
  class CheckoutSessions extends Base {
    create(p) { return this._makeRequest('POST', '/v1/checkout/sessions', p); }
    list(p) { return this._makeRequest('GET', "/v1/checkout/sessions", p); }
    retrieve(id, p) { return this._makeRequest('GET', `/v1/checkout/sessions/${id}`, p); }
  }
  class PortalSessions extends Base { create(p) { return this._makeRequest('POST', '/v1/billing_portal/sessions', p); } }
  class Refunds extends Base { create(p) { return this._makeRequest('POST', '/v1/refunds', p); } }
  class Events extends Base { list(p) { return this._makeRequest('GET', '/v1/events', p); } }
  class PaymentIntents extends Base { retrieve(id, p) { return this._makeRequest('GET', `/v1/payment_intents/${id}`, p); } }
  class Charges extends Base { list(p) { return this._makeRequest('GET', '/v1/charges', p); } }
  class Subscriptions extends Base { retrieve(id, p) { return this._makeRequest('GET', `/v1/subscriptions/${id}`, p); } }
  class Invoices extends Base { retrieve(id, p) { return this._makeRequest('GET', `/v1/invoices/${id}`, p); } }
  class WebhookEndpoints extends Base { list(p) { return this._makeRequest('GET', '/v1/webhook_endpoints', p); } }
  class Files extends Base { list(p) { return this._makeRequest('GET', '/v1/files', p); } }
  const client = {
    customers: new Customers(),
    checkout: { sessions: new CheckoutSessions() },
    billingPortal: { sessions: new PortalSessions() },
    refunds: new Refunds(),
    events: new Events(),
    paymentIntents: new PaymentIntents(),
    charges: new Charges(),
    subscriptions: new Subscriptions(),
    invoices: new Invoices(),
    webhookEndpoints: new WebhookEndpoints(),
    files: new Files(),
    webhooks: { constructEvent() { return null; } }, // a local helper, not a resource
    _api: new Refunds(), // `_`-prefixed: internal
  };
  client.customers.stripe = client;
  return client;
}

const ST_ANCHOR = 'src/lib/stripe.ts';
const ST_MANIFEST = {
  key: { granted: ['charge_read', 'checkout_session_write', 'customer_portal_write', 'customer_write', 'invoice_read', 'payment_intent_read', 'subscription_read', 'webhook_write'] },
  endpoints: [
    { request: 'GET /v1/customers/search', permission: 'customer_read' },
    { request: 'POST /v1/customers/{id}', permission: 'customer_write' },
    { request: 'POST /v1/customers/{customer}/balance_transactions', permission: 'customer_write' },
    { request: 'POST /v1/checkout/sessions', permission: 'checkout_session_write' },
    { request: 'GET /v1/checkout/sessions', permission: 'checkout_session_read' },
    { request: 'GET /v1/checkout/sessions/{session}', permission: 'checkout_session_read' },
    { request: 'POST /v1/billing_portal/sessions', permission: 'customer_portal_write' },
    { request: 'POST /v1/refunds', permission: 'refund_write' },
    { request: 'GET /v1/refunds', permission: 'refund_read' },
    { request: 'GET /v1/payment_intents/{intent}', permission: 'payment_intent_read' },
    { request: 'GET /v1/charges', permission: 'charge_read' },
    { request: 'GET /v1/subscriptions/{id}', permission: 'subscription_read' },
    { request: 'GET /v1/invoices/{id}', permission: 'invoice_read' },
    { request: 'GET /v1/webhook_endpoints', permission: 'webhook_read' },
  ],
  expand_fields: { customer: 'customer_read', default_payment_method: 'payment_method_read', latest_charge: 'charge_read', payment_intent: 'payment_intent_read', subscription: 'subscription_read' },
  raw_calls: [{ file: 'ops/declared.mjs', request: 'GET /v1/webhook_endpoints' }],
  not_stripe: [],
  scan: { roots: ['src', 'scripts', 'ops'], exclude: [], anchor: ST_ANCHOR, client_getters: ['getStripeClient'] },
};
const ST_HEAD = "import Stripe from 'stripe';\nconst stripe = new Stripe('placeholder');\n";
const ST_CLEAN = `${ST_HEAD}export async function clean(id: string, sub: { events: string[] }) {
  await stripe.customers.search({ query: 'email:"a"' });
  await stripe.customers
    .update(id, { metadata: {} });
  await stripe.checkout.sessions.retrieve(id, { expand: ['customer', 'subscription'] });
  await stripe.paymentIntents.retrieve(id, { expand: ['latest_charge'] });
  // stripe.refunds.create({}) in a comment is not a call
  const s = 'stripe.refunds.create({})';
  return sub.events.includes(s);
}
`;

function selfTest() {
  let ran = 0;
  const fails = [];
  const check1 = (name, fn) => {
    ran++;
    let ok = false;
    try {
      ok = fn() === true;
    } catch (err) {
      ok = false;
    }
    if (!ok) fails.push(name);
  };
  const t = loadTs();
  if (!t.ok) {
    console.error(`✖ self-test cannot run: ${t.reason}`);
    return 'INDETERMINATE';
  }
  const ts = t.ts;
  const sdk = sdkSurface(fakeClient());
  const manifest = (patch = {}) => JSON.stringify({ ...ST_MANIFEST, ...patch });
  const go = (extra = [], patch = {}, opts = {}) => check({ manifestText: manifest(patch), sdk, ts, files: [{ file: ST_ANCHOR, text: ST_CLEAN }, ...extra], floor: 1, ...opts });
  const body = (code) => `${ST_HEAD}export async function t(id: string, fields: string[], name: string, verb: string, path: string, fn: () => void) {\n${code}\n}\n`;
  const r = (code, patch) => go([{ file: 'src/t.ts', text: body(code) }], patch);
  const v = (code, patch) => r(code, patch).verdict;
  /** INDETERMINATE for the stated reason, never for another. */
  const undecided = (x, re) => x.verdict === 'INDETERMINATE' && (x.res
    ? x.res.indeterminate.some((i) => re.test(i.why))
    : x.out.some((o) => re.test(o.line)));
  const u = (code, re, patch) => undecided(r(code, patch), re);
  const fails1 = (x, permission) => x.verdict === 'FAIL' && x.res.fail.some((f) => f.permission === permission);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // reading the SDK
  check1('surface: a single-quoted path is read', () => sdk.surface.get('customers.search') === 'GET /v1/customers/search');
  check1('surface: a template path reads its placeholder as {}', () => sdk.surface.get('customers.update') === 'POST /v1/customers/{}');
  check1('surface: a double-quoted path is read', () => sdk.surface.get('checkout.sessions.list') === 'GET /v1/checkout/sessions');
  check1('surface: a nested namespace is walked', () => sdk.surface.get('billingPortal.sessions.create') === 'POST /v1/billing_portal/sessions');
  check1('surface: a method naming no request is unparsed, never guessed', () => sdk.unparsed.has('customers.helper') && !sdk.surface.has('customers.helper'));
  check1('surface: an internal `_` key is skipped', () => ![...sdk.surface.keys()].some((k) => k.startsWith('_')));
  check1("surface: a resource's back-reference to the client is not walked", () => ![...sdk.surface.keys()].some((k) => k.includes('stripe.')));
  check1('surface: the webhooks helper is not a resource', () => !sdk.top.has('webhooks'));
  check1('surface: a surface below the real floor is a problem', () => surfaceProblem(sdk) !== null);
  check1('surface: a known method read back wrong is a problem', () => surfaceProblem(sdk, 1, { 'customers.search': 'POST /v1/customers/search' }) !== null);
  check1('surface: the fake passes floor 1 with the known methods', () => surfaceProblem(sdk, 1) === null);
  check1('normRequest: placeholders and a trailing slash', () => normRequest('POST /v1/customers/{customer}/') === 'POST /v1/customers/{}');
  check1('normRequest: a query is dropped; a bad verb or path is refused', () => normRequest('GET /v1/x?y=1') === 'GET /v1/x' && normRequest('FETCH /v1/x') === null && normRequest('GET v1/x') === null);
  check1('normPath: shell and template variables read as {}', () => normPath('/v1/customers/$ID') === '/v1/customers/{}' && normPath('/v1/c/${id}/x') === '/v1/c/{}/x');
  check1('covers: a write grant covers the read', () => covers(new Set(['customer_write']), 'customer_read') === true);
  check1('covers: a read grant never covers the write', () => covers(new Set(['customer_read']), 'customer_write') === false);
  check1('minimalGrants: a needed write drops its read', () => same(minimalGrants(new Set(['customer_read', 'customer_write', 'charge_read'])), ['charge_read', 'customer_write']));

  // a clean file
  const clean = go();
  check1('clean: PASS', () => clean.verdict === 'PASS');
  check1('clean: required is the smallest grant set', () => same(clean.res.required, ['charge_read', 'checkout_session_read', 'customer_write', 'payment_intent_read', 'subscription_read']));
  check1('clean: a comment, a string and sub.events.includes are not calls', () => clean.scan.calls.length === 4);
  check1('clean: a callee split across lines reads as one name', () => clean.scan.calls.some((c) => c.text === 'stripe.customers.update'));
  check1('clean: grants nothing needs are reported', () => clean.out.some((o) => o.line === 'STRIPE_RAK_UNUSED_GRANTS=customer_portal_write,invoice_read,webhook_write'));

  // (a) mapping, (d) permissions
  check1('a: a request with no endpoints row is INDETERMINATE', () => u('await stripe.events.list({});', /has no row in endpoints/));
  check1('a: an SDK method whose request cannot be read is INDETERMINATE', () => u('stripe.customers.helper();', /whose request the gate cannot read/));
  check1('d: a request the key lacks is FAIL, naming the permission', () => fails1(r('await stripe.refunds.create({ amount: 1 });'), 'refund_write'));
  check1('d: FAIL outranks INDETERMINATE', () => {
    const x = r('await stripe.refunds.create({});\nawait stripe.events.list({});');
    return x.verdict === 'FAIL' && x.res.indeterminate.length > 0;
  });

  // (b) expand
  check1('b: an expansion the key cannot read is FAIL', () => fails1(r("await stripe.subscriptions.retrieve(id, { expand: ['default_payment_method'] });"), 'payment_method_read'));
  check1('b: an unknown expand field is INDETERMINATE', () => u("await stripe.subscriptions.retrieve(id, { expand: ['plan'] });", /"plan" has no row in expand_fields/));
  check1('b: a non-literal expand is INDETERMINATE', () => u('await stripe.subscriptions.retrieve(id, { expand: fields });', /not a list of string literals/));
  check1('b: a spread inside expand is INDETERMINATE', () => u('await stripe.subscriptions.retrieve(id, { expand: [...fields] });', /not a list of string literals/));
  check1('b: an expand written outside the call is INDETERMINATE', () => u("const opts = { expand: ['customer'] };\nawait stripe.checkout.sessions.retrieve(id, opts);", /outside a Stripe call's own arguments/));
  check1('b: an expand set after the fact is INDETERMINATE', () => u("const opts: any = {};\nopts.expand = ['customer'];\nawait stripe.checkout.sessions.retrieve(id, opts);", /set after the params were written/));
  check1('b: an expand list changed after the fact is INDETERMINATE', () => u("const opts = { limit: 1, more: [] as string[] };\nopts.more.push('x');\nlet e: any; e.expand.push('customer');", /list changed after it was written/));
  check1('b: every field of a dotted path needs its read', () => {
    const x = r("await stripe.invoices.retrieve(id, { expand: ['payment_intent.latest_charge'] });");
    return x.verdict === 'PASS' && x.res.needed.has('payment_intent_read') && x.res.needed.has('charge_read');
  });
  check1('b: a leading data. needs nothing', () => {
    const x = r("await stripe.charges.list({ expand: ['data.customer'] });");
    return x.verdict === 'PASS' && x.res.needed.has('customer_read') && x.res.indeterminate.length === 0;
  });

  // (c) raw REST
  const raw = (file, text, patch) => go([{ file, text }], patch);
  check1('c: an undeclared raw URL is INDETERMINATE', () => undecided(raw('scripts/x.mjs', "await fetch('https://api.stripe.com/v1/balance');"), /not declared in raw_calls/));
  check1('c: a declared raw URL is judged by its row', () => raw('ops/declared.mjs', "await fetch('https://api.stripe.com/v1/webhook_endpoints?limit=100');").verdict === 'PASS');
  check1('c: a declared raw URL the key lacks is FAIL', () => fails1(raw('ops/r.mjs', "await fetch('https://api.stripe.com/v1/refunds?limit=1');", { raw_calls: [{ file: 'ops/r.mjs', request: 'GET /v1/refunds' }] }), 'refund_read'));
  check1('c: a template URL reads its placeholder as {}', () => {
    const x = raw('ops/declared.mjs', 'await fetch(`https://api.stripe.com/v1/webhook_endpoints/${id}`);');
    return undecided(x, /not declared in raw_calls/) && x.scan.raws.some((w) => w.path === '/v1/webhook_endpoints/{}');
  });
  check1('c: a Stripe URL built in pieces is INDETERMINATE', () => undecided(raw('scripts/p.mjs', "const base = 'https://api.stripe.com';\nawait fetch(base + '/v1/balance');"), /built in pieces/));
  check1('c: a shell URL is read and a # line is not', () => {
    const x = scanText('ops/x.sh', '# curl https://api.stripe.com/v1/refunds\ncurl -s https://api.stripe.com/v1/balance');
    return x.raws.length === 1 && x.raws[0].path === '/v1/balance' && x.unclear.length === 0;
  });
  check1('c: rawRequest with literals is a request', () => fails1(r("await stripe.rawRequest('POST', '/v1/refunds', {});"), 'refund_write'));
  check1('c: rawRequest without literals is INDETERMINATE', () => u('await stripe.rawRequest(verb, path, {});', /not string literals/));

  // calls on any receiver
  check1('calls: getStripeClient() as the receiver', () => fails1(r('await getStripeClient().refunds.create({});'), 'refund_write'));
  check1('calls: await and a chained helper still find the request', () => {
    const x = r('await (await getStripeClient()).charges.list({ limit: 1 }).autoPagingEach(fn);');
    return x.verdict === 'PASS' && x.scan.calls.some((c) => c.method === 'charges.list');
  });
  check1("calls: require('stripe')(key) is a client", () => undecided(go([{ file: 'src/cjs.js', text: "const stripe = require('stripe')('k');\nconst c = stripe.customers;" }]), /takes a Stripe resource as a value/));

  // (e) a resource taken as a value
  check1('e: an aliased resource is INDETERMINATE', () => u('const c = stripe.customers;\nawait c.search({});', /takes a Stripe resource as a value/));
  check1('e: a destructured resource is INDETERMINATE', () => u('const { customers } = stripe;', /destructured from the client/));
  check1('e: a computed key on the client is INDETERMINATE', () => u('await (stripe as any)[name].search({});', /computed key on the Stripe client/));
  check1('e: an uncalled method is INDETERMINATE', () => u('const f = stripe.customers.search;', /takes a Stripe resource as a value/));
  check1('e: a method called by .call is INDETERMINATE', () => u('await stripe.customers.search.call(stripe.customers, {});', /takes a Stripe resource as a value/));
  check1('e: a resource destructured from a getter is INDETERMINATE', () => u('const { refunds } = getStripeClient();', /destructured from the client/));
  check1('e: a parameter typed as the client is a client', () => u('function f(s: Stripe) { return s.customers; }', /takes a Stripe resource as a value/));
  check1('e: a value typed Stripe.Customer is not a client', () => v('function g(c: Stripe.Customer) { return c.subscriptions; }') === 'PASS');
  check1('e: a local function typed to return the client is a getter', () => u('function mk(): Stripe { return stripe; }\nconst { customers } = mk();', /destructured from the client/));
  check1('e: a client field read through this is a client', () => u('class K { s: Stripe = stripe; go() { return this.s.charges; } }', /`this\.s\.charges` takes a Stripe resource as a value/));

  // not_stripe
  const drive = [{ file: 'src/g.ts', text: 'await drive.files.list({});' }];
  check1('not_stripe: an unmapped non-Stripe call is INDETERMINATE without an entry', () => undecided(go(drive), /files\.list sends GET \/v1\/files, which has no row in endpoints/));
  check1('not_stripe: an entry with its reason quiets that call', () => {
    const x = go(drive, { not_stripe: [{ file: 'src/g.ts', text: 'drive.files.list', reason: 'Google Drive, not Stripe' }] });
    return x.verdict === 'PASS' && x.res.notes.some((n) => n.startsWith('not Stripe: src/g.ts'));
  });
  check1('not_stripe: an entry for another file quiets nothing', () => undecided(go(drive, { not_stripe: [{ file: 'src/h.ts', text: 'drive.files.list', reason: 'Google Drive' }] }), /has no row in endpoints/));
  check1('not_stripe: an entry that matches nothing is a note', () => {
    const x = go([], { not_stripe: [{ file: 'src/none.ts', text: 'x.files.list', reason: 'stale' }] });
    return x.verdict === 'PASS' && x.res.notes.some((n) => n.includes('matches nothing'));
  });

  // the manifest
  check1('manifest: a not_stripe entry without a reason is refused', () => loadManifest(manifest({ not_stripe: [{ file: 'a', text: 'b', reason: ' ' }] })).ok === false);
  check1('manifest: two rows for one request are refused', () => loadManifest(manifest({ endpoints: [...ST_MANIFEST.endpoints, { request: 'POST /v1/customers/{customer}', permission: 'customer_write' }] })).ok === false);
  check1('manifest: a malformed permission id is refused', () => loadManifest(manifest({ endpoints: [{ request: 'GET /v1/charges', permission: 'Charge-Read' }] })).ok === false);
  check1('manifest: an empty grant list is refused', () => loadManifest(manifest({ key: { granted: [] } })).ok === false);
  check1('manifest: a manifest that is not JSON makes the check INDETERMINATE', () => undecided(check({ manifestText: '{', sdk, ts, files: [], floor: 1 }), /the manifest is not JSON/));

  // vacuity
  check1('vacuity: an anchor with no call is INDETERMINATE', () => undecided(check({ manifestText: manifest(), sdk, ts, files: [{ file: 'ops/declared.mjs', text: "await fetch('https://api.stripe.com/v1/webhook_endpoints');" }], floor: 1 }), /contributed no Stripe call/));
  check1('vacuity: an excluded anchor is not scanned', () => undecided(go([], { scan: { ...ST_MANIFEST.scan, exclude: [ST_ANCHOR] } }), /contributed no Stripe call/));
  check1('vacuity: an SDK surface below the floor is INDETERMINATE', () => undecided(check({ manifestText: manifest(), sdk, ts, files: [{ file: ST_ANCHOR, text: ST_CLEAN }] }), /read back \d+ methods \(floor 400\)/));
  check1('vacuity: no request at all is never a pass', () => verdictOf({ fail: [], indeterminate: [], scanned: 0 }) === 'INDETERMINATE');
  check1('syntax: a file that does not parse is INDETERMINATE', () => undecided(go([{ file: 'src/bad.ts', text: 'const = ;' }]), /does not parse/));

  // derived
  check1('derived: each request records its permission and its files', () => clean.derived.calls['checkout.sessions.retrieve']?.permission === 'checkout_session_read' && clean.derived.calls['customers.search']?.sites[ST_ANCHOR] === 1);
  check1('derived: a stored copy equal to a fresh one has no drift', () => driftOf(JSON.parse(JSON.stringify(clean.derived)), clean.derived) === 0);
  check1('derived: an empty stored copy drifts', () => clean.drift > 0);
  check1('derived: two runs derive the same text', () => serialize(go().derived) === serialize(clean.derived));
  check1('serialize: round-trips, a row inside a list on one line', () => {
    const doc = { a: [{ k: 1, v: 'x' }], b: { c: ['p', 'q'] }, d: {} };
    const s = serialize(doc);
    return same(JSON.parse(s), doc) && s.includes('    { "k": 1, "v": "x" }') && s.includes('"c": ["p", "q"]');
  });

  if (ran < SELF_TEST_MIN_CHECKS) fails.push(`only ${ran} check(s) ran (floor ${SELF_TEST_MIN_CHECKS})`);
  if (fails.length) {
    console.error(`✖ self-test FAILED (${fails.length} of ${ran}):`);
    fails.forEach((x) => console.error('   - ' + x));
    return 'FAIL';
  }
  console.log(`✓ self-test: ${ran} checks — SDK reader, request rows (a), expand (b), raw URLs (c), grants (d), resources as values (e), not_stripe, manifest refusals, vacuity, derived.`);
  return 'PASS';
}

// ── main ─────────────────────────────────────────────────────────────────────

function emit(verdict) {
  console.log(`STRIPE_RAK_PERMISSIONS_VERDICT=${verdict}`);
  process.exitCode = CODES[verdict]; // never process.exit(): a queued pipe write would lose the token
}

/** One run, start to verdict. */
async function run(argv) {
  const stray = argv.filter((a) => a !== '--self-test' && a !== '--sync');
  if (stray.length) {
    console.error(`✖ unknown argument(s): ${stray.join(' ')} (usage: [--self-test | --sync])`);
    return 'INDETERMINATE';
  }
  if (argv.includes('--self-test')) return selfTest();
  const st = selfTest();
  if (st !== 'PASS') return st; // a broken detector must never green-light the scan

  const t = loadTs();
  const s = loadSdk();
  for (const x of [t, s]) {
    if (!x.ok) {
      console.error(`✖ ${x.reason}`);
      return 'INDETERMINATE';
    }
  }
  if (!existsSync(MANIFEST_FILE)) {
    console.error(`✖ the manifest is missing at ${MANIFEST_FILE} — cannot decide, refusing to pass`);
    return 'INDETERMINATE';
  }
  const manifestText = readFileSync(MANIFEST_FILE, 'utf8');
  const man = loadManifest(manifestText);
  if (!man.ok) {
    console.error(`✖ ${man.reason}`);
    return 'INDETERMINATE';
  }
  const tracked = execFileSync('git', ['ls-files', '-z', '--', ...man.roots], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    .split('\0')
    .filter((f) => CODE_FILE.test(f) || TEXT_FILE.test(f));
  const files = tracked.map((file) => ({ file, text: readFileSync(join(ROOT, file), 'utf8') }));
  const inputs = { sdk: s.sdk, ts: t.ts, files, version: s.version };
  let result = check({ ...inputs, manifestText });

  if (argv.includes('--sync') && result.derived) {
    const text = `${serialize({ ...result.man.doc, derived: result.derived })}\n`;
    if (text === manifestText) console.log('✓ --sync: `derived` already matches the code');
    else {
      writeFileSync(`${MANIFEST_FILE}.tmp`, text);
      renameSync(`${MANIFEST_FILE}.tmp`, MANIFEST_FILE);
      console.log('✓ --sync: rewrote `derived` in ops/stripe-rak-permissions.json — commit it');
      result = check({ ...inputs, manifestText: text });
    }
  }
  for (const o of result.out) (o.to === 'err' ? console.error : console.log)(o.line);
  if (result.verdict === 'PASS') {
    console.log(`✓ Stripe key permissions: ${result.scan.calls.length} SDK call(s), ${result.scan.expands.length} expansion(s) and ${result.scan.raws.length} raw request(s) are covered by the key's ${result.man.granted.size} grants.`);
  }
  return result.verdict;
}

async function main(argv) {
  let verdict;
  try {
    verdict = await run(argv);
  } catch (err) {
    // git missing, a tracked file deleted in the working tree, …: the scan did not happen.
    console.error(`✖ the check could not run: ${err instanceof Error ? err.message : err}`);
    verdict = 'INDETERMINATE';
  }
  emit(verdict);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2));
