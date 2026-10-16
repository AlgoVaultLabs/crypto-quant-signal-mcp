#!/usr/bin/env node
/**
 * check-tool-dispatch-boundary.mjs — ARCH-MCP-CALL-PIPELINE-W1 CH3.
 *
 * ONE PIPELINE, STRUCTURALLY. Every tool call on every channel (MCP, x402 HTTP, okx.ai A2MCP, ACP)
 * dispatches through src/lib/tool-call-pipeline.ts (CH2). That is a convention until something
 * refuses the first bypass, and the prose rule at build-and-runtime.md:75 already proved a
 * convention does not hold: index.ts grew 3.2× under it, and the MCP-vs-twin drift class it was
 * written to prevent shipped three fixes and left an open gap (survey §R3, audit F6).
 *
 * THE RULE. No src/ file other than the pipeline may (a) call a tool-engine entry point, or
 * (b) write a tool-call request_log row (`logRequest` with a registered tool name), unless
 * ops/tool-dispatch-boundary.json carries an allowlist row for that file + symbol WITH A REASON.
 * An unregistered call site FAILS. So does an allowlist row that matches no site: a dead
 * exemption is where the next bypass hides. An engine module may call itself; the pipeline may
 * call anything.
 *
 * WHAT COUNTS AS A CALL — read from the TypeScript AST, never by regex (comments are not nodes):
 *   · a CallExpression whose callee is the engine symbol imported, under any local alias, from the
 *     engine's module — import specifiers are resolved relative to the importing file (`.js` → `.ts`);
 *   · a CallExpression `<namespace>.<symbol>(…)` on a namespace import of the engine module, and —
 *     failing toward noise — ANY `<expr>.<symbol>(…)` whose member is an engine symbol;
 *   · a BARE call of an engine symbol with no import at all (a same-named local function) — also
 *     reported: noise is a line number the operator renames or registers, a miss is a bypass;
 *   · `logRequest({ toolName: '<literal>' … })` where the literal is a tool name or alias read from
 *     src/lib/feature-registry.ts (the ONE registry); a non-literal, shorthand, spread or missing
 *     toolName is UNPROVABLE and therefore reported. A literal that is not a tool name (an
 *     operational row such as a checkout event) is not a site.
 *
 * VERDICT: exactly one terminal `TOOL_DISPATCH_BOUNDARY=PASS|FAIL|INDETERMINATE`.
 * EXIT: 0 PASS · 1 FAIL · 3 INDETERMINATE. Callers gate on the TOKEN; the code is the lever.
 * `process.exitCode`, never a `process.exit` call — a queued pipe write would lose the token
 * (tests/unit/verdict-exit-path.test.ts).
 *
 * INDETERMINATE = "could not judge", raised where the corpus is CONSTRUCTED: the config is missing,
 * malformed, or an allowlist row lacks a ≥25-character reason · the corpus is empty · the pipeline,
 * the registry, the request_log module or an engine module named by the config is absent from the
 * corpus · a corpus file carries parse diagnostics · the registry yields zero tool names · the
 * pipeline itself dispatches to zero engines (a blind detector and a moved pipeline look the same)
 * · `typescript` cannot be loaded — this gate refuses to run degraded, because a regex cannot tell
 * an aliased import's call from a mention of it.
 *
 * DIVERGENCE FROM scripts/check-new-dark-exports.mjs (the spec asked for its import resolution):
 *   · SAME corpus walk — `srcFiles()` from scripts/lib/dark-artifacts.mjs: src/**\/*.ts minus .d.ts,
 *     by readdir not `git ls-files`, so an untracked rogue file is judged before it is committed.
 *   · dark-exports counts identifier OCCURRENCES with the TS scanner and resolves no specifiers;
 *     this gate resolves every relative import specifier to a module path and judges CallExpressions,
 *     because "mentions the identifier" cannot distinguish a dispatch from a type import.
 *   · dark-exports falls back to an order-corrected regex when `typescript` is unavailable; this gate
 *     returns INDETERMINATE instead (see above).
 *   · dark-exports judges NEW declarations against `git merge-base HEAD origin/main`; a boundary is
 *     absolute, so this gate judges the whole working tree and reads no base ref.
 *
 *   node scripts/check-tool-dispatch-boundary.mjs              # the gate   (npm run tool-dispatch:check)
 *   node scripts/check-tool-dispatch-boundary.mjs --self-test  # fixtures + the real artifacts the fixtures bypass
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { srcFiles } from './lib/dark-artifacts.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_REL = 'ops/tool-dispatch-boundary.json';
export const TOKEN = 'TOOL_DISPATCH_BOUNDARY';
export const EXIT = Object.freeze({ PASS: 0, FAIL: 1, INDETERMINATE: 3 });
const MIN_REASON = 25;

/** Resolve `typescript` from THIS module, never from the tree being judged (the tree is data). */
function loadTypescript() {
  try { return createRequire(import.meta.url)('typescript'); } catch { return null; }
}

/** The config is CONSTRUCTED by us, so anything malformed is vacuity, not a fact about src/. */
export function validateConfig(j) {
  if (!j || typeof j !== 'object') return { error: 'config is not an object' };
  if (typeof j.pipeline !== 'string' || !j.pipeline) return { error: 'config.pipeline must name the pipeline module' };
  if (typeof j.registry !== 'string' || !j.registry) return { error: 'config.registry must name the feature-registry module' };
  if (!Array.isArray(j.engines) || j.engines.length === 0) return { error: 'config.engines must be a non-empty array' };
  for (const e of j.engines) {
    if (!e || typeof e.symbol !== 'string' || !e.symbol || typeof e.module !== 'string' || !e.module) {
      return { error: 'every engine row needs { symbol, module }' };
    }
  }
  if (!j.request_log || typeof j.request_log.symbol !== 'string' || typeof j.request_log.module !== 'string') {
    return { error: 'config.request_log needs { symbol, module }' };
  }
  if (!Array.isArray(j.allow)) return { error: 'config.allow must be an array (possibly empty)' };
  for (const a of j.allow) {
    if (!a || typeof a.file !== 'string' || !a.file || typeof a.symbol !== 'string' || !a.symbol) {
      return { error: 'every allow row needs { file, symbol, reason }' };
    }
    if (typeof a.reason !== 'string' || a.reason.trim().length < MIN_REASON) {
      return { error: `allow row ${a.file}#${a.symbol}: reason must be at least ${MIN_REASON} characters` };
    }
  }
  if (j.exit_codes) {
    for (const k of Object.keys(EXIT)) {
      if (j.exit_codes[k] !== EXIT[k]) return { error: `config.exit_codes.${k} disagrees with the gate (${EXIT[k]})` };
    }
  }
  return { cfg: j };
}

export function loadConfig(root = ROOT) {
  const p = join(root, CONFIG_REL);
  if (!existsSync(p)) return { error: `${CONFIG_REL} is missing` };
  try { return validateConfig(JSON.parse(readFileSync(p, 'utf8'))); }
  catch (e) { return { error: `${CONFIG_REL} is not valid JSON: ${e.message}` }; }
}

/** The corpus: every src/**\/*.ts (not .d.ts) as Map<relPath, text> — the sibling gate's walk. */
export function loadCorpus(root = ROOT) {
  const files = new Map();
  for (const f of srcFiles(root)) files.set(f, readFileSync(join(root, f), 'utf8'));
  return files;
}

/**
 * The module paths a relative import specifier could denote. No filesystem: the candidates are
 * compared against the paths the config names, so a fixture corpus resolves exactly like src/.
 */
export function resolveSpecifier(fromFile, spec) {
  if (typeof spec !== 'string' || !spec.startsWith('.')) return [];
  const base = posix.normalize(posix.join(posix.dirname(fromFile), spec));
  const out = new Set([base]);
  if (/\.js$/.test(base)) out.add(base.replace(/\.js$/, '.ts'));
  if (/\.mjs$/.test(base)) out.add(base.replace(/\.mjs$/, '.mts'));
  if (!/\.[cm]?[jt]s$/.test(base)) { out.add(`${base}.ts`); out.add(`${base}/index.ts`); }
  return [...out];
}

/** Tool names + aliases: every object literal carrying a `channels` property is a FeatureSpec. */
export function toolNamesFrom(ts, registryText, registryPath) {
  const names = new Set();
  const sf = ts.createSourceFile(registryPath, registryText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (n) => {
    if (ts.isObjectLiteralExpression(n)) {
      const byName = new Map();
      for (const p of n.properties) {
        if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) byName.set(p.name.text, p.initializer);
      }
      if (byName.has('channels')) {
        const nm = byName.get('name');
        if (nm && ts.isStringLiteral(nm)) names.add(nm.text);
        const al = byName.get('aliases');
        if (al && ts.isArrayLiteralExpression(al)) {
          for (const el of al.elements) if (ts.isStringLiteral(el)) names.add(el.text);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return names;
}

/** null ⇒ this logRequest provably writes a NON-tool row; otherwise why it is a tool row or unprovable. */
function classifyLogRequest(ts, call, toolNames) {
  const arg = call.arguments[0];
  if (!arg) return { via: 'no-arg', detail: 'logRequest() with no argument — nothing to prove' };
  if (!ts.isObjectLiteralExpression(arg)) {
    return { via: 'non-literal', detail: `logRequest(${arg.getText().slice(0, 40)}) — argument is not an object literal; toolName unprovable` };
  }
  let found = null;
  for (const p of arg.properties) {
    if (ts.isSpreadAssignment(p)) return { via: 'spread', detail: 'logRequest({ …spread }) — toolName may arrive through the spread; unprovable' };
    if ((ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && ts.isIdentifier(p.name) && p.name.text === 'toolName') found = p;
  }
  if (!found) return { via: 'no-toolName', detail: 'logRequest({ … }) without a toolName property' };
  if (ts.isShorthandPropertyAssignment(found)) return { via: 'non-literal', detail: 'logRequest({ toolName }) — shorthand, unprovable' };
  const init = found.initializer;
  if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
    return toolNames.has(init.text) ? { via: 'tool-literal', detail: `toolName: '${init.text}' is a registered tool name` } : null;
  }
  return { via: 'non-literal', detail: `toolName: ${init.getText().slice(0, 40)} — not a string literal; unprovable` };
}

/**
 * Pure analysis over a corpus. Returns `{ indeterminate: reason }` or
 * `{ sites, violations, allowed, stale, pipelineSites, toolNames, instrument }`.
 * A site is `{ file, line, symbol, kind: 'engine' | 'request_log', via, detail }`.
 */
export function analyze(files, cfg, ts) {
  if (!ts) return { indeterminate: '`typescript` could not be loaded — refusing to judge with a regex' };
  if (!(files instanceof Map) || files.size === 0) return { indeterminate: 'corpus is empty — nothing under src/ to judge' };
  if (!files.has(cfg.pipeline)) return { indeterminate: `pipeline module ${cfg.pipeline} is not in the corpus` };
  if (!files.has(cfg.registry)) return { indeterminate: `registry module ${cfg.registry} is not in the corpus` };
  if (!files.has(cfg.request_log.module)) return { indeterminate: `request_log module ${cfg.request_log.module} is not in the corpus` };
  for (const e of cfg.engines) {
    if (!files.has(e.module)) return { indeterminate: `engine module ${e.module} (${e.symbol}) is not in the corpus` };
  }

  const toolNames = toolNamesFrom(ts, files.get(cfg.registry), cfg.registry);
  if (toolNames.size === 0) {
    return { indeterminate: `${cfg.registry} yielded zero tool names — the registry parser is blind or the registry is empty` };
  }

  const engineBySymbol = new Map(cfg.engines.map((e) => [e.symbol, e]));
  const LOG = cfg.request_log;
  const sites = [];
  let pipelineSites = 0;

  for (const [file, text] of files) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    if (sf.parseDiagnostics && sf.parseDiagnostics.length) {
      const d = sf.parseDiagnostics[0];
      return { indeterminate: `${file} does not parse: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}` };
    }
    const isPipeline = file === cfg.pipeline;

    // local name → { imported, mods } for named imports; local → mods for namespace imports
    const named = new Map();
    const namespaces = new Map();
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !st.importClause || !ts.isStringLiteral(st.moduleSpecifier)) continue;
      const mods = resolveSpecifier(file, st.moduleSpecifier.text);
      const nb = st.importClause.namedBindings;
      if (!nb) continue;
      if (ts.isNamespaceImport(nb)) namespaces.set(nb.name.text, mods);
      else for (const el of nb.elements) named.set(el.name.text, { imported: (el.propertyName ?? el.name).text, mods });
    }

    const engineFor = (local) => {
      const imp = named.get(local);
      if (imp) {
        const e = engineBySymbol.get(imp.imported);
        return e && imp.mods.includes(e.module) ? { engine: e, via: 'import' } : null;
      }
      const bare = engineBySymbol.get(local);
      return bare ? { engine: bare, via: 'bare' } : null;
    };
    const isLogRequest = (local) => {
      const imp = named.get(local);
      return imp ? imp.imported === LOG.symbol && imp.mods.includes(LOG.module) : local === LOG.symbol;
    };
    const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const push = (s) => { if (isPipeline) pipelineSites++; else sites.push(s); };

    const visit = (n) => {
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        if (ts.isIdentifier(callee)) {
          const hit = engineFor(callee.text);
          if (hit) {
            if (hit.engine.module !== file) {
              push({ file, line: lineOf(n), symbol: hit.engine.symbol, kind: 'engine', via: hit.via, detail: `${callee.text}(…)` });
            }
          } else if (isLogRequest(callee.text) && file !== LOG.module) {
            const r = classifyLogRequest(ts, n, toolNames);
            if (r) push({ file, line: lineOf(n), symbol: LOG.symbol, kind: 'request_log', via: r.via, detail: r.detail });
          }
        } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
          const member = callee.name.text;
          const e = engineBySymbol.get(member);
          if (e) {
            if (e.module !== file) {
              const ns = ts.isIdentifier(callee.expression) ? namespaces.get(callee.expression.text) : undefined;
              push({
                file, line: lineOf(n), symbol: e.symbol, kind: 'engine',
                via: ns && ns.includes(e.module) ? 'namespace' : 'member', detail: `${callee.getText(sf)}(…)`,
              });
            }
          } else if (member === LOG.symbol && file !== LOG.module) {
            const r = classifyLogRequest(ts, n, toolNames);
            if (r) push({ file, line: lineOf(n), symbol: LOG.symbol, kind: 'request_log', via: `member:${r.via}`, detail: r.detail });
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  if (pipelineSites === 0) {
    return { indeterminate: `${cfg.pipeline} dispatches to zero engines — the detector is blind or the pipeline no longer dispatches` };
  }

  const key = (f, s) => `${f}#${s}`;
  const rows = new Map(cfg.allow.map((a) => [key(a.file, a.symbol), { ...a, hits: 0 }]));
  const violations = [];
  const allowed = [];
  for (const s of sites) {
    const row = rows.get(key(s.file, s.symbol));
    if (row) { row.hits++; allowed.push({ ...s, reason: row.reason }); } else violations.push(s);
  }
  const stale = [...rows.values()].filter((r) => r.hits === 0);
  return { sites, violations, allowed, stale, pipelineSites, toolNames, instrument: 'typescript' };
}

// ── self-test ───────────────────────────────────────────────────────────────────────────────
function selfTest() {
  const ts = loadTypescript();
  if (!ts) { console.error('✗ self-test: `typescript` unavailable — cannot exercise the instrument'); return 'INDETERMINATE'; }
  const fails = [];
  let passes = 0;
  const check = (name, cond, extra = '') => {
    if (cond) { passes++; console.log(`  ✓ ${name}`); } else { fails.push(name); console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
  };

  const CFG = validateConfig({
    pipeline: 'src/lib/tool-call-pipeline.ts',
    registry: 'src/lib/feature-registry.ts',
    engines: [{ symbol: 'getTradeSignal', module: 'src/tools/get-trade-call.ts' }],
    request_log: { symbol: 'logRequest', module: 'src/lib/analytics.ts' },
    allow: [],
  }).cfg;
  const BASE = {
    'src/lib/feature-registry.ts':
      "export const FEATURE_REGISTRY = [\n" +
      "  { name: 'get_trade_call', aliases: ['get_trade_signal'], channels: { mcp: true } },\n" +
      "  { name: 'get_market_regime', aliases: [], channels: { mcp: true } },\n];\n",
    'src/tools/get-trade-call.ts':
      'export async function getTradeSignal(input: { coin: string }) {\n  return helper(input);\n}\n' +
      'function helper(i: unknown) { return i; }\n' +
      "export const again = () => getTradeSignal({ coin: 'BTC' }); // own module: not a dispatch\n",
    'src/lib/analytics.ts': 'export function logRequest(entry: Record<string, unknown>): void { void entry; }\n',
    'src/lib/tool-call-pipeline.ts':
      "import { getTradeSignal } from '../tools/get-trade-call.js';\nimport { logRequest } from './analytics.js';\n" +
      'export async function callTool(i: { coin: string }) {\n  const r = await getTradeSignal(i);\n' +
      "  logRequest({ toolName: 'get_trade_call', ...(r as object) });\n  return r;\n}\n",
  };
  const corpus = (extra = {}) => new Map(Object.entries({ ...BASE, ...extra }));
  const withAllow = (rows) => ({ ...CFG, allow: rows });
  const REASON = 'fixture: internal reuse with internal:true, never a caller-facing dispatch';

  // 1 · clean → PASS; a mention in a comment or a string is not a call
  let r = analyze(corpus({ 'src/lib/clean.ts': "// getTradeSignal({ coin: 'X' }) is prose\nexport const s = 'getTradeSignal(';\n" }), CFG, ts);
  check('clean corpus → PASS with zero sites', !r.indeterminate && r.sites.length === 0 && r.violations.length === 0 && r.stale.length === 0, JSON.stringify(r.violations ?? r));
  check("the pipeline's own dispatch is seen (the detector is not blind)", !r.indeterminate && r.pipelineSites >= 1, `pipelineSites=${r.pipelineSites}`);

  // 2 · direct engine call through an ALIASED import → FAIL
  const ROGUE = { 'src/lib/rogue.ts': "import { getTradeSignal as gts } from '../tools/get-trade-call.js';\nexport const f = () => gts({ coin: 'BTC' });\n" };
  r = analyze(corpus(ROGUE), CFG, ts);
  check('aliased import + call → FAIL (1 violation, via import, line 2)',
    r.violations.length === 1 && r.violations[0].via === 'import' && r.violations[0].file === 'src/lib/rogue.ts' && r.violations[0].line === 2,
    JSON.stringify(r.violations));

  // 3 · the same call, allowlisted with a reason → PASS
  r = analyze(corpus(ROGUE), withAllow([{ file: 'src/lib/rogue.ts', symbol: 'getTradeSignal', reason: REASON }]), ts);
  check('allowlisted call → PASS (allowed=1, violations=0, stale=0)', r.violations.length === 0 && r.allowed.length === 1 && r.stale.length === 0);

  // 4 · empty corpus → INDETERMINATE
  r = analyze(new Map(), CFG, ts);
  check('empty corpus → INDETERMINATE', !!r.indeterminate && /empty/.test(r.indeterminate), JSON.stringify(r));

  // 5 · namespace import → FAIL via namespace
  r = analyze(corpus({ 'src/lib/ns.ts': "import * as eng from '../tools/get-trade-call.js';\nexport const g = () => eng.getTradeSignal({ coin: 'ETH' });\n" }), CFG, ts);
  check('namespace import + member call → FAIL via namespace', r.violations.length === 1 && r.violations[0].via === 'namespace', JSON.stringify(r.violations));

  // 6 · bare same-named call with no import → FAIL toward noise
  r = analyze(corpus({ 'src/lib/bare.ts': 'function getTradeSignal(i: unknown) { return i; }\nexport const h = () => getTradeSignal({});\n' }), CFG, ts);
  check('bare same-named call with no import → FAIL via bare (fails toward noise)', r.violations.length === 1 && r.violations[0].via === 'bare');

  // 7 · the engine SYMBOL imported from a NON-engine module is not the engine
  r = analyze(corpus({
    'src/lib/other-mod.ts': 'export const getTradeSignal = (i: unknown) => i;\n',
    'src/lib/uses-other.ts': "import { getTradeSignal } from './other-mod.js';\nexport const k = () => getTradeSignal({});\n",
  }), CFG, ts);
  check('same symbol imported from a non-engine module → not a site', !r.indeterminate && r.sites.length === 0, JSON.stringify(r.sites));

  // 8 · logRequest: tool literal (an ALIAS) → FAIL · non-tool literal → clean · non-literal → FAIL · spread → FAIL
  r = analyze(corpus({ 'src/lib/log1.ts': "import { logRequest } from './analytics.js';\nexport const a = () => logRequest({ toolName: 'get_trade_signal', verdict: 'BUY' });\n" }), CFG, ts);
  check('logRequest with a registered ALIAS literal → FAIL (tool-literal)', r.violations.length === 1 && r.violations[0].kind === 'request_log' && r.violations[0].via === 'tool-literal', JSON.stringify(r.violations));
  r = analyze(corpus({ 'src/lib/log2.ts': "import { logRequest } from './analytics.js';\nexport const b = () => logRequest({ toolName: 'stripe_checkout_completed' });\n" }), CFG, ts);
  check('logRequest with a NON-tool literal → not a site', !r.indeterminate && r.sites.length === 0);
  r = analyze(corpus({ 'src/lib/log3.ts': "import { logRequest as lr } from './analytics.js';\nexport const c = (t: string) => lr({ toolName: t });\n" }), CFG, ts);
  check('aliased logRequest with a non-literal toolName → FAIL (unprovable)', r.violations.length === 1 && r.violations[0].via === 'non-literal');
  r = analyze(corpus({ 'src/lib/log4.ts': "import { logRequest } from './analytics.js';\nexport const d = (e: Record<string, unknown>) => logRequest({ ...e });\n" }), CFG, ts);
  check('logRequest with a spread → FAIL (unprovable)', r.violations.length === 1 && r.violations[0].via === 'spread');

  // 9 · stale allow row → FAIL
  r = analyze(corpus(), withAllow([{ file: 'src/lib/gone.ts', symbol: 'getTradeSignal', reason: REASON }]), ts);
  check('allow row matching no site → FAIL (stale=1, violations=0)', r.stale.length === 1 && r.violations.length === 0);

  // 10 · unparseable file → INDETERMINATE
  r = analyze(corpus({ 'src/lib/broken.ts': 'export const x = {\n' }), CFG, ts);
  check('unparseable corpus file → INDETERMINATE', !!r.indeterminate && /does not parse/.test(r.indeterminate), r.indeterminate);

  // 11 · registry with no FeatureSpec → INDETERMINATE
  r = analyze(corpus({ 'src/lib/feature-registry.ts': 'export const FEATURE_REGISTRY = [];\n' }), CFG, ts);
  check('registry yielding zero tool names → INDETERMINATE', !!r.indeterminate && /zero tool names/.test(r.indeterminate), r.indeterminate);

  // 12 · pipeline that dispatches nothing → INDETERMINATE (blind detector and moved pipeline look alike)
  r = analyze(corpus({ 'src/lib/tool-call-pipeline.ts': 'export const callTool = () => null;\n' }), CFG, ts);
  check('pipeline with zero engine dispatches → INDETERMINATE', !!r.indeterminate && /blind/.test(r.indeterminate), r.indeterminate);

  // 13 · config validation (constructed ⇒ vacuity)
  check('config: a short reason is refused', !!validateConfig({ ...CFG, allow: [{ file: 'a', symbol: 'b', reason: 'too short' }] }).error);
  check('config: empty engines refused', !!validateConfig({ ...CFG, engines: [] }).error);
  check('config: exit codes disagreeing with the gate refused', !!validateConfig({ ...CFG, exit_codes: { PASS: 0, FAIL: 1, INDETERMINATE: 2 } }).error);

  // 14 · specifier resolution
  check('resolveSpecifier maps ../x.js → src/tools/x.ts', resolveSpecifier('src/lib/x402-http-routes.ts', '../tools/get-trade-call.js').includes('src/tools/get-trade-call.ts'));
  check('resolveSpecifier ignores bare package specifiers', resolveSpecifier('src/a.ts', 'zod').length === 0);

  // ── the artifacts the fixtures BYPASS — a hermetic self-test is blind to its own seam ───────
  const real = loadConfig(ROOT);
  check(`real ${CONFIG_REL} loads and validates`, !real.error, real.error);
  if (!real.error) {
    const files = loadCorpus(ROOT);
    check('real corpus is non-empty and contains the pipeline', files.size > 0 && files.has(real.cfg.pipeline), `files=${files.size}`);
    for (const e of real.cfg.engines) {
      const re = new RegExp(`^export\\s+(?:async\\s+)?(?:function|const)\\s+${e.symbol}\\b`, 'm');
      check(`real engine module ${e.module} exports ${e.symbol}`, files.has(e.module) && re.test(files.get(e.module) ?? ''));
    }
    const names = toolNamesFrom(ts, files.get(real.cfg.registry) ?? '', real.cfg.registry);
    check('real registry yields tool names', names.size > 0, `size=${names.size}`);
    const rr = analyze(files, real.cfg, ts);
    check('real corpus analyses to a verdict (not INDETERMINATE)', !rr.indeterminate, rr.indeterminate);
    if (!rr.indeterminate) check('real pipeline dispatches to ≥ 1 engine (the detector sees the real thing)', rr.pipelineSites >= 1, `pipelineSites=${rr.pipelineSites}`);
  }

  if (fails.length) { console.error(`✗ self-test: ${fails.length} of ${passes + fails.length} checks failed: ${fails.join(' | ')}`); return 'FAIL'; }
  console.log(`✓ self-test: ${passes} checks passed (fixtures + the real config, corpus and instrument).`);
  return 'PASS';
}

// ── run ─────────────────────────────────────────────────────────────────────────────────────
function emit(tok) {
  console.log(`${TOKEN}=${tok}`);
  process.exitCode = EXIT[tok];
}

function run() {
  const c = loadConfig(ROOT);
  if (c.error) { console.error(`✗ ${c.error}`); return emit('INDETERMINATE'); }
  const files = loadCorpus(ROOT);
  const r = analyze(files, c.cfg, loadTypescript());
  if (r.indeterminate) { console.error(`✗ ${r.indeterminate}`); return emit('INDETERMINATE'); }

  // POSITIVE per-run output, instrument beside the counts: "found nothing" must never look like "no output".
  console.log(`[tool-dispatch] instrument=${r.instrument} files=${files.size} engines=${c.cfg.engines.length} tool-names=${r.toolNames.size} `
    + `pipeline-sites=${r.pipelineSites} sites=${r.sites.length} allowed=${r.allowed.length} violations=${r.violations.length} stale-rows=${r.stale.length}`);
  for (const a of r.allowed) console.log(`  · allowed ${a.file}:${a.line} ${a.symbol} — ${a.reason.slice(0, 96)}…`);

  if (!r.violations.length && !r.stale.length) {
    console.log(`✓ every tool dispatch and tool-row write outside ${c.cfg.pipeline} is registered with a reason.`);
    return emit('PASS');
  }
  for (const v of r.violations) console.error(`  ✗ ${v.file}:${v.line} ${v.kind} ${v.symbol} (via ${v.via}) — ${v.detail}`);
  if (r.violations.length) console.error(`    Route it through ${c.cfg.pipeline} (callTool), or add a reasoned row to ${CONFIG_REL}.`);
  for (const s of r.stale) console.error(`  ✗ stale allowlist row ${s.file}#${s.symbol} matches no call site — remove it; a dead exemption hides the next bypass.`);
  return emit('FAIL');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.argv.includes('--self-test')) emit(selfTest());
  else run();
}
