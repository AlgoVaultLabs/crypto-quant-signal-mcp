#!/usr/bin/env node
// @ts-check
/**
 * check-kb-reachability.mjs — a documented surface must RESOLVE.
 *
 * OPS-KNOWLEDGE-BUNDLE-HOLD-PROMISE-W1 (CH3).
 *
 * WHY THIS EXISTS. Every published AlgoVault artifact that names a tool or a route is a promise an
 * AI agent will act on, and nothing in the build asserted that the named thing still exists. Four
 * defects were found BY HAND on 2026-08-21 — three real, one a false alarm — and the hand search
 * missed a fourth live surface that a different gate caught by accident (landing/tools.html, which
 * projects the same descriptions onto a public page). A class found by hand recurs; this makes it
 * enumerable.
 *
 * WHAT IT DOES **NOT** DO, and who owns those instead. This gate is reachability ONLY. It does not
 * re-implement:
 *   - snapshot WELL-FORMEDNESS + the superseded_by resolvability rule → check-shape-snapshot-integrity.mjs
 *   - the free-HOLD pricing claim                                     → tests/unit/no-free-hold-promise.test.ts
 *                                                                       + scripts/check-hold-billing-claims.mjs
 *   - baked counts / win-rate figures in descriptions                 → tests/unit/tool-description-forward-stability.test.ts
 * Those were all read before this was written (the 9th probe). Each covers a class this one does
 * not, and none of them asks whether a documented surface RESOLVES. A second copy of a check
 * nobody watches is worse than no check.
 *
 * THREE REFERENCE CLASSES, all ENUMERATED FROM THE ARTIFACTS — never a hardcoded list, so a new
 * tool, route or snapshot self-reports:
 *   1. `response_shapes[].endpoint` naming an MCP tool  ⇒ that tool is in the live tool set.
 *   2. `response_shapes[].endpoint` naming an HTTP route ⇒ that route is declared (offline) and
 *      does not 404 (--live).
 *   3. every tool name referenced inside any published DESCRIPTION ⇒ in the live tool set. The
 *      description surfaces are themselves enumerated: the bundle, lobehub-manifest.json, the
 *      landing /tools index, and the src SoT.
 *
 * TWO MODES, AND THE SPLIT IS THE WHOLE POINT (R3, decided on evidence, not preference).
 * `OPS-JSONLD-DEPLOY-GATE-W1` established that a LIVE-FETCHING check cannot be a fail-close deploy
 * gate: its result moves between the write and the check, so wiring it fail-close breaks every
 * deploy. That lesson is not re-learned here.
 *   --offline (default) — deterministic, network-free, FAIL-CLOSE in deploy.yml. Resolves against
 *                         DECLARED sources in-repo: the tool set from the compiled feature registry
 *                         + equity flag, the route set from `app.<method>('literal')` across src/**
 *                         PLUS the dynamically-mounted x402 family expanded from HTTP_TOOLS, plus
 *                         the committed static landing pages. Dynamic mounting is why a literal
 *                         grep alone would report six phantom misses.
 *   --live              — the network assertions. NON-BLOCKING, scheduled. A route answering 401 or
 *                         403 is REACHABLE: it exists and is telling you so. Only 404/410 or a
 *                         resolution failure is unreachable. That distinction is D4's lesson paid
 *                         forward — /api/performance-shadow was reported as a fictional endpoint on
 *                         the strength of a 404 read from the WRONG HOST; it answers 401 on the API
 *                         host and its contract was truthful all along.
 *
 * VERDICT. Exactly one terminal `KB_REACHABILITY_VERDICT=PASS|FAIL|INDETERMINATE`.
 * Exit 0 = PASS · 1 = FAIL · 3 = INDETERMINATE — the token-law default for a NEW gate. Do NOT
 * "align" it with check_test_baseline.sh's 2, which is 2 only because it already deployed 2.
 *
 * INDETERMINATE IS FOR STRUCTURAL BLINDNESS, and it is fail-closed: an unreadable bundle, an empty
 * tool set, an empty route set, or (in --live) an unreachable host. Every individual surface prints
 * its own verdict, so a run that verified nothing can never look like a run that verified
 * everything — and the summary prints the COUNT of each class beside the token, because a zero
 * result with no corpus size beside it is indistinguishable from a clean sweep.
 *
 * Usage:
 *   node scripts/check-kb-reachability.mjs --self-test
 *   node scripts/check-kb-reachability.mjs [--offline]
 *   node scripts/check-kb-reachability.mjs --live
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = 'KB_REACHABILITY_VERDICT';
const argv = process.argv.slice(2);

/* ────────────────────────────── pure core (unit-testable) ────────────────────────────── */

/** A tool-shaped identifier. Anchored on the verb prefixes the registry actually uses. */
export const TOOL_RE = /\b(?:get|scan|chat|search)_[a-z0-9_]+\b/g;

/**
 * Pull tool references out of free text.
 * @param {string} text
 * @returns {string[]} unique, in first-seen order
 */
export function extractToolRefs(text) {
  return [...new Set(String(text ?? '').match(TOOL_RE) ?? [])];
}

/**
 * Normalise a documented path for comparison with a declared route.
 * Strips the origin, the query, a trailing slash, and collapses BOTH express params (`:id`) and
 * doc placeholders (`<tool>`, `{id}`) to one token so `/x402/<tool>` meets `/x402/:tool`.
 * @param {string} p
 */
export function normalizePath(p) {
  let s = String(p ?? '').trim();
  s = s.replace(/^https?:\/\/[^/]+/i, '');
  s = s.replace(/[?#].*$/, '');
  s = s.replace(/<[^>]+>|\{[^}]+\}|:[A-Za-z_][\w]*/g, ':p');
  s = s.replace(/\.html$/i, '');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s || '/';
}

/**
 * Classify one documented endpoint string into the reference(s) it makes.
 *
 * Endpoint strings are free text written by humans across 15 months, so this is deliberately
 * permissive about SHAPE and strict about what it will call a claim. An endpoint may make BOTH a
 * tool and a route claim (`MCP tool scan_trade_calls + Streamable-HTTP /mcp + POST /x402 ...`).
 * @param {string} endpoint
 * @returns {{ tools: string[], paths: string[] }}
 */
export function classifyEndpoint(endpoint) {
  const ep = String(endpoint ?? '');
  /** @type {string[]} */ const tools = [];
  /** @type {string[]} */ const paths = [];

  // `tools/call name=search_knowledge (MCP)` — a TOOL reference. Handled before path extraction,
  // because otherwise `tools/call` yields a phantom `/call` route (measured: it did).
  for (const m of ep.matchAll(/tools\/call\s+name=([a-z0-9_]+)/gi)) tools.push(m[1]);

  const namesATool = /\bMCP\s+(?:tool|tools|resource)\b/i.test(ep);
  // A bare identifier as the whole endpoint is a tool too (`scan_trade_calls`).
  const bare = /^[a-z][a-z0-9_]*$/.test(ep.trim()) && /_/.test(ep.trim());
  if (namesATool || bare) tools.push(...extractToolRefs(ep));

  // Route claims: every path-looking token — but three things must be removed FIRST, each of
  // which measurably produced a phantom route on the real corpus:
  //   `tools/call name=x` / `tools/list`  -> would yield `/call`, `/list`
  //   `algovault://venues`, `mcp://...`   -> a NON-HTTP resource URI; `//venues` is not a route
  const stripped = ep
    .replace(/tools\/(?:call|list)(?:\s+name=[a-z0-9_]+)?/gi, ' ')
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s)]*/gi, (u) => (/^https?:/i.test(u) ? u : ' '));
  for (const m of stripped.matchAll(/(?:https?:\/\/[^\s/]+)?(\/[A-Za-z0-9_\-/:<>{}.]*)/g)) {
    const p = normalizePath(m[1]);
    if (p === '/' && !/https?:\/\//i.test(m[0])) continue; // a bare "/" inside prose is not a route
    paths.push(p);
  }
  const originM = ep.match(/https?:\/\/([^\s/]+)/i);
  const methodM = ep.match(/\b(GET|POST|PUT|DELETE|PATCH)\b/);
  return {
    tools: [...new Set(tools)],
    paths: [...new Set(paths)],
    origin: originM ? originM[1] : null,
    method: methodM ? methodM[1] : null,
  };
}

/**
 * Does a documented path resolve against the declared route set?
 * @param {Set<string>} declared @param {string} p
 */
export function routeResolves(declared, p) {
  if (declared.has(p)) return 'declared';
  const asParam = p.replace(/\/[^/]*:p[^/]*/g, '/:p');
  for (const d of declared) {
    if (d.replace(/:[A-Za-z_][\w]*/g, ':p') === asParam) return 'declared';
    // A DECLARED param route matches a CONCRETE documented path: `/x402/:tool` covers
    // `/x402/get_trade_call`. Without this direction an explicitly-mounted alias reads as a miss.
    const rx = new RegExp('^' + d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z_][\w]*/g, '[^/]+') + '$');
    if (rx.test(p)) return 'declared';
  }
  // A path that is a proper PREFIX of a declared route is a route FAMILY, not a concrete route —
  // `POST /x402 (not listed — free tool)` names the rail, not an endpoint. Resolved, but returned
  // as its own kind so the output says `family` and never silently claims a concrete match.
  for (const d of declared) if (d.startsWith(p + '/')) return 'family';
  return false;
}

/**
 * A LIVE HTTP status is REACHABLE unless it says the thing is not there.
 * 401/403 mean "exists, and you may not" — treating them as absence is exactly the D4 mistake.
 * @param {number|null} status
 */
export function statusIsReachable(status) {
  if (status === null) return null;          // could not ask — INDETERMINATE, never a pass
  return status !== 404 && status !== 410;
}

/* ────────────────────────────── corpus (impure) ────────────────────────────── */

function readJson(p) { return JSON.parse(readFileSync(p, 'utf8')); }

function walkTs(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkTs(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Declared HTTP routes: literal registrations + the dynamically-mounted x402 family + statics. */
async function declaredRoutes() {
  const routes = new Set();
  for (const f of walkTs(join(ROOT, 'src'))) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\b(?:app|router)\.(?:get|post|put|delete|patch|all)\(\s*['"`]([^'"`]+)['"`]/g)) {
      routes.add(normalizePath(m[1]));
    }
    // Some routes are DECLARED AS DATA and mounted from that declaration — the x402 canonical-name
    // alias is `routePath: '/x402/get_trade_call'` in a table, never an `app.post('literal')`. A
    // scan that only knows the call form reports a live route as missing.
    for (const m of src.matchAll(/\broutePath\s*:\s*['"`](\/[^'"`]+)['"`]/g)) routes.add(normalizePath(m[1]));
  }
  // x402 routes are mounted from a LIST at runtime (`app.get(routePath, …)` in
  // mountX402HttpRoutes), so no literal exists to grep. Expanding the same list is the single
  // derivation — re-deriving the paths by hand here would drift the moment a tool is priced.
  try {
    const mod = await import(pathToFileURL(join(ROOT, 'dist', 'lib', 'x402-http-routes.js')).href);
    for (const t of mod.HTTP_TOOLS ?? []) routes.add(`/x402/${t}`);
    routes.add('/x402/:p');
  } catch { /* reported by the vacuity guard below if it leaves the set empty */ }
  // Committed static pages served by Caddy from landing/.
  const landing = join(ROOT, 'landing');
  if (existsSync(landing)) {
    for (const f of readdirSync(landing)) {
      if (f.endsWith('.html')) routes.add(normalizePath('/' + f));
    }
    routes.add('/');
  }
  return routes;
}

/** The tool set the server would actually serve, given this environment. */
async function liveToolSet() {
  const mod = await import(pathToFileURL(join(ROOT, 'dist', 'lib', 'equities', 'equity-tools-flag.js')).href);
  return new Set(mod.liveMcpToolNames(process.env));
}

/**
 * Every PUBLISHED description surface, enumerated.
 * landing/tools.html is on this list deliberately: it carried both dangling referrals and was
 * found by `build_landing --check`, not by the hand audit that produced this wave.
 */
function descriptionSurfaces(bundle) {
  /** @type {{surface:string, text:string}[]} */ const out = [];
  for (const t of bundle.tools ?? []) out.push({ surface: `bundle.tools[${t.name}]`, text: JSON.stringify(t) });
  const lobehub = join(ROOT, 'lobehub-manifest.json');
  if (existsSync(lobehub)) {
    for (const a of readJson(lobehub).api ?? []) {
      out.push({ surface: `lobehub-manifest.api[${a.name}]`, text: String(a.description ?? '') });
    }
  }
  const tools = join(ROOT, 'landing', 'tools.html');
  if (existsSync(tools)) {
    const html = readFileSync(tools, 'utf8');
    for (const m of html.matchAll(/<p class="tools-card-desc">([\s\S]*?)<\/p>/g)) {
      out.push({ surface: 'landing/tools.html', text: m[1] });
    }
  }
  const sot = join(ROOT, 'src', 'tool-descriptions.ts');
  if (existsSync(sot)) {
    const src = readFileSync(sot, 'utf8');
    for (const m of src.matchAll(/export const (\w*DESCRIPTION\w*)\s*=\s*\n?\s*'([^']*)'/g)) {
      out.push({ surface: `src/tool-descriptions.ts:${m[1]}`, text: m[2] });
    }
  }
  return out;
}

/**
 * Which host serves a documented path.
 *
 * D4's lesson, made structural. The dispatch called /api/performance-shadow "a fictional endpoint"
 * on the strength of a 404 — read from algovault.com, the LANDING host, which serves no /api at
 * all. On api.algovault.com it answers 401. An origin written in the endpoint always wins; absent
 * one, the API prefixes go to the API host and everything else to the landing host.
 * @param {string} p @param {string|null} origin
 */
export function hostFor(p, origin) {
  if (origin) return origin;
  return /^\/(api|mcp|x402|knowledge|account|capabilities)\b/.test(p) ? 'api.algovault.com' : 'algovault.com';
}

async function probe(url) {
  try {
    const r = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(12_000) });
    return r.status;
  } catch { return null; }
}

/* ────────────────────────────── self-test ────────────────────────────── */

export function selfTest() {
  const fails = [];
  const eq = (label, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) fails.push(`${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };

  eq('MCP tool endpoint yields the tool', classifyEndpoint('MCP tool get_equity_call').tools, ['get_equity_call']);
  eq('a bare identifier is a tool', classifyEndpoint('scan_trade_calls').tools, ['scan_trade_calls']);
  eq('tools/call name= is a TOOL, not a /call route', classifyEndpoint('tools/call name=search_knowledge (MCP) — auth state').tools, ['search_knowledge']);
  eq('...and yields NO phantom route', classifyEndpoint('tools/call name=search_knowledge (MCP) — auth state').paths, []);
  eq('an HTTP endpoint yields its path', classifyEndpoint('GET /api/performance-shadow').paths, ['/api/performance-shadow']);
  eq('an absolute URL loses its origin', classifyEndpoint('GET https://api.algovault.com/api/erc-8004-reputation').paths, ['/api/erc-8004-reputation']);
  eq('a mixed endpoint yields BOTH claims',
    (() => { const c = classifyEndpoint('MCP tool scan_trade_calls + Streamable-HTTP /mcp'); return [c.tools, c.paths]; })(),
    [['scan_trade_calls'], ['/mcp']]);
  eq('prose naming no tool and no route claims nothing',
    (() => { const c = classifyEndpoint('_algovault (MCP tool response envelope metadata block) — auth state'); return c.paths; })(), []);

  eq('placeholder meets express param', routeResolves(new Set(['/x402/:p']), normalizePath('/x402/<tool>')), 'declared');
  eq('a real miss is a miss', routeResolves(new Set(['/api/a']), '/api/b'), false);
  eq('a declared PARAM route covers a concrete path', routeResolves(new Set(['/x402/:tool']), '/x402/get_trade_call'), 'declared');
  eq('a prefix of declared routes resolves as a FAMILY, labelled', routeResolves(new Set(['/x402/get_trade_call']), '/x402'), 'family');
  eq('tools/list yields no phantom /list route', classifyEndpoint('POST /mcp (tools/list routing contract)').paths, ['/mcp']);
  eq('a non-HTTP resource URI is not a route', classifyEndpoint('MCP resource algovault://venues — formatVenueForResource()').paths, []);
  eq('.html normalises to its clean route', normalizePath('/docs.html'), '/docs');

  // D4's lesson, encoded: existence-with-refusal is REACHABLE.
  eq('401 is reachable', statusIsReachable(401), true);
  eq('403 is reachable', statusIsReachable(403), true);
  eq('200 is reachable', statusIsReachable(200), true);
  eq('404 is NOT reachable', statusIsReachable(404), false);
  eq('410 is NOT reachable', statusIsReachable(410), false);
  eq('no answer is INDETERMINATE, never a pass', statusIsReachable(null), null);

  eq('description scan finds a dangling ref', extractToolRefs('for US stocks use get_equity_call'), ['get_equity_call']);
  eq('description scan is empty on clean copy', extractToolRefs('Read-only, live exchange APIs.'), []);
  eq('an /api path defaults to the API host', hostFor('/api/performance-shadow', null), 'api.algovault.com');
  eq('a rendered page defaults to the LANDING host', hostFor('/verify', null), 'algovault.com');
  eq('an origin in the endpoint always wins', hostFor('/verify', 'algovault.com'), 'algovault.com');
  eq('the method is captured for the mutate-safety rule', classifyEndpoint('POST /api/signup-email').method, 'POST');
  return fails;
}

/* ────────────────────────────── run ────────────────────────────── */

function emit(v, why, detail) {
  if (why) console.log(`\n${v === 'FAIL' ? '✖' : v === 'PASS' ? '✓' : 'ℹ'} ${why}`);
  if (detail) console.log(detail);
  console.log(`${GATE}=${v}`);
  process.exit(v === 'PASS' ? 0 : v === 'FAIL' ? 1 : 3);
}

const IS_MAIN = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) {
  if (argv.includes('--self-test')) {
    const f = selfTest();
    if (f.length) { console.error('✖ kb-reachability self-test FAILED:'); f.forEach((x) => console.error('   - ' + x)); process.exit(1); }
    console.log('✓ kb-reachability self-test passed (27 assertions: classification incl. the tools/call phantom-route trap, path normalisation, express-param matching, and the 401-is-reachable rule D4 paid for)');
    process.exit(0);
  }

  const st = selfTest();
  if (st.length) { st.forEach((x) => console.error('   - ' + x)); emit('INDETERMINATE', 'self-test failure — the gate cannot vouch for itself'); }

  const live = argv.includes('--live');
  const BUNDLE = join(ROOT, 'dist', 'knowledge', 'latest.json');
  if (!existsSync(BUNDLE)) emit('INDETERMINATE', `bundle not built at ${BUNDLE} — run \`npm run build:knowledge\` (INDETERMINATE, not PASS: nothing was verified)`);

  let bundle;
  try { bundle = readJson(BUNDLE); }
  catch (e) { emit('INDETERMINATE', `bundle is unreadable: ${e.message} — input we were handed and could not parse is always INDETERMINATE`); }

  const tools = await liveToolSet();
  const routes = await declaredRoutes();
  // Vacuity: this corpus is one WE construct, so empty means the scan broke, never that all is well.
  if (!tools.size) emit('INDETERMINATE', 'the live tool set resolved to ZERO — every tool assertion would pass vacuously');
  if (!routes.size) emit('INDETERMINATE', 'the declared route set resolved to ZERO — every route assertion would pass vacuously');
  const shapes = bundle.response_shapes ?? [];
  if (!shapes.length) emit('INDETERMINATE', 'the bundle declares ZERO response_shapes — nothing to verify');

  const fails = [];
  const unchecked = [];
  let okTool = 0, okRoute = 0, okDesc = 0;
  const liveStatus = new Map();

  // LIVE probing is GET-ONLY and side-effect-free, by construction.
  //
  // A canary must never POST to a live endpoint — `POST /api/signup-email` would create a signup
  // every run. And OPTIONS is NOT a usable substitute: measured 2026-08-21, api.algovault.com
  // answers `204` to OPTIONS on EVERY path including `/zzz-nope`, because CORS middleware replies
  // before routing. An instrument that returns the same answer for a real route and a nonexistent
  // one is structurally incapable of the question, and would have manufactured a confident PASS.
  // So a non-GET route keeps its OFFLINE evidence and is printed as not-live-probed.
  if (live) {
    for (const sh of shapes) {
      const c = classifyEndpoint(sh.endpoint);
      if (c.method && c.method !== 'GET') continue;
      for (const p of c.paths) {
        if (p.includes(':p') || routeResolves(routes, p) === 'family') continue; // template / family root
        const key = `${hostFor(p, c.origin)}${p}`;
        if (!liveStatus.has(key)) liveStatus.set(key, await probe(`https://${key}`));
      }
    }
  }

  for (const s of shapes) {
    const cls = classifyEndpoint(s.endpoint);
    const { tools: refs, paths } = cls;
    for (const t of refs) {
      if (tools.has(t)) { okTool++; console.log(`  PASS  tool   ${t}  (documented by "${s.endpoint}")`); }
      else fails.push(`class 1 — response_shapes["${s.endpoint}"] documents MCP tool \`${t}\`, absent from the live tool set {${[...tools].join(', ')}}`);
    }
    for (const p of paths) {
      const how = routeResolves(routes, p);
      const key = `${hostFor(p, cls.origin)}${p}`;
      if (live && liveStatus.has(key)) {
        const reach = statusIsReachable(liveStatus.get(key) ?? null);
        if (reach === null) { unchecked.push(`class 2 — ${key} (from "${s.endpoint}"): host did not answer`); continue; }
        if (!reach) { fails.push(`class 2 — response_shapes["${s.endpoint}"] documents ${key}, which returns ${liveStatus.get(key)}`); continue; }
        okRoute++; console.log(`  PASS  route  ${key}  (live ${liveStatus.get(key)})`);
        continue;
      }
      if (live && !how) { unchecked.push(`class 2 — ${key} (from "${s.endpoint}"): not live-probed (${cls.method && cls.method !== 'GET' ? cls.method + ' route — probing would mutate state' : 'template or family root'}) AND not declared offline`); continue; }
      if (how) {
        okRoute++;
        const why = live ? `not live-probed (${cls.method && cls.method !== 'GET' ? cls.method + ' — a canary must not mutate state' : 'template/family'}); declared in src/**`
                         : (how === 'family' ? 'route FAMILY — a prefix of declared routes, not a concrete endpoint' : 'declared in src/**');
        console.log(`  PASS  route  ${p}  (${why})`);
      } else fails.push(`class 2 — response_shapes["${s.endpoint}"] documents ${p}, declared nowhere in src/** and not a committed landing page`);
    }
  }

  for (const { surface, text } of descriptionSurfaces(bundle)) {
    for (const t of extractToolRefs(text)) {
      if (tools.has(t)) { okDesc++; }
      else fails.push(`class 3 — ${surface} refers an agent to \`${t}\`, absent from the live tool set`);
    }
  }
  console.log(`  PASS  descriptions  ${okDesc} tool reference(s) across ${descriptionSurfaces(bundle).length} published description surface(s) all resolve`);

  const summary = `  checked: ${okTool} tool endpoint(s) · ${okRoute} route(s) · ${okDesc} description reference(s) · corpus ${shapes.length} response_shapes, ${tools.size} live tools, ${routes.size} declared routes · mode ${live ? 'LIVE' : 'OFFLINE'}`;

  if (fails.length) {
    console.error(`✖ ${fails.length} unreachable documented surface(s):`);
    for (const f of fails) console.error(`   - ${f}`);
    emit('FAIL', `${fails.length} finding(s)`, summary);
  }
  if (unchecked.length) {
    console.error(`ℹ ${unchecked.length} surface(s) could NOT be checked — reported, never counted as clean:`);
    for (const u of unchecked) console.error(`   - ${u}`);
    emit('INDETERMINATE', `${unchecked.length} surface(s) unverifiable in this run`, summary);
  }
  emit('PASS', 'every documented tool, route and description reference resolves', summary);
}
