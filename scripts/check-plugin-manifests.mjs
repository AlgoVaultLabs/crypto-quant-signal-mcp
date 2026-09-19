#!/usr/bin/env node
/**
 * OPS-CURSOR-PLUGIN-MANIFESTS-W1 R5 — validate our committed plugin manifests against their
 * vendor's LIVE published schemas, and keep the derived Cursor manifest in lockstep with them.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────────
 *
 * `crypto-quant-signal-mcp` shipped no plugin manifest of any kind, so every Cursor surface was
 * closed to us by our own omission rather than by a gatekeeper. Writing the files opens them. The
 * DELIVERABLE, though, is not "a Cursor listing" — it is "our manifests are validated against
 * their vendors' live schemas in CI". `server.json`, `manifest.json` (DXT) and
 * `lobehub-manifest.json` have no such gate today; three future waves inherit this shape by
 * swapping only the schema URLs and the document list.
 *
 * ── THE SOFT-404, WHICH IS THE WHOLE REASON STEP 2 EXISTS ───────────────────────────────────
 *
 * 🛑 A schema gate that checks the STATUS CODE passes against a marketing homepage.
 *
 * Measured 2026-09-19: `https://cursor.com/schemas/cursor-plugin/plugin.json` returns
 * **HTTP 200**, `content-type: text/html; charset=utf-8`, **132233 bytes** — it is the Cursor
 * homepage (`<title>Cursor - The best way to code with AI</title>`), served by a Next.js
 * catch-all. `res.ok` is true. `res.status === 200` is true. Any gate that stopped there would
 * then hand 132 KB of HTML to a JSON parser, catch the throw, and — in the shape this class of
 * bug usually takes — treat "no schema, no errors" as a clean validation.
 *
 * So `readSchemaResponse()` below is the guard, and it asserts THREE things before anything is
 * validated: 2xx, `content-type` starting `application/json`, and a body that parses to an
 * object. Any of them failing is INDETERMINATE — the gate verified nothing — and never PASS.
 * The self-test feeds it the real soft-404 shape (200 + text/html) and asserts INDETERMINATE.
 *
 * This is a forward-guard for every future schema gate, not a repair: the URLs we actually ship
 * against (`agent-plugins.org`) return real JSON. The trap is what a sibling wave would hit.
 *
 * ── THE THREE MANIFESTS, AND WHY ONLY TWO ARE SCHEMA-GATED ──────────────────────────────────
 *
 *   plugin.json                  Agent Plugins manifest — THE SINGLE SOURCE OF TRUTH.
 *                                Schema-validated against agent-plugins.org.
 *   mcp.json                     Agent Plugins MCP config. Schema-validated.
 *   .cursor-plugin/plugin.json   GENERATED PROJECTION of plugin.json, for cursor.directory.
 *                                NOT schema-validated — the Cursor-proprietary format has no
 *                                published JSON Schema — so it is gated by DERIVATION EQUALITY.
 *
 * The derived file is not a second source of truth; it is one source plus a projection, which is
 * CLAUDE.md's single-derivation rule ("compute a derived classification ONCE; every consumer
 * projects from that one value"). It exists because of a measured gap, not a preference:
 * cursor.directory's ingester (`cursor/community-plugins`, `apps/cursor/src/lib/github-plugin/
 * parse.ts:318-323`) reads its manifest from `.plugin/plugin.json`, `.cursor-plugin/plugin.json`,
 * `.claude-plugin/plugin.json` or `.cursor-plugin/marketplace.json` — and BREAKS on the first
 * hit. Root `plugin.json` is on none of those paths, so without this file the directory listing
 * would read `version: "1.0.0"` (parse.ts:608) and `description: "<repo> plugin for Cursor"`
 * (parse.ts:607) no matter what root `plugin.json` said. The curated marketplace is invite-only
 * by its own published policy, so the directory is realistically the listing we get.
 *
 * It also neutralises the one thing Cursor's documentation leaves UNSTATED — precedence when a
 * repo carries both a root `plugin.json` and a `.cursor-plugin/plugin.json`. We assert no
 * precedence rule; derivation makes the two agree on every shared field, so whichever the client
 * picks, the reader sees the same plugin. Make it not matter rather than guess.
 *
 * ── `logo` IS NOT AN AGENT PLUGINS FIELD, AND THAT IS NOT AN OVERSIGHT ──────────────────────
 *
 * `plugin.schema.json` is CLOSED (`additionalProperties: false`) and its property set is exactly
 * `$schema · name · version · description · author · homepage · repository · license · keywords ·
 * extensions`. There is no `logo`. The `logo` field documented on cursor.com sits under
 * *"Every **Cursor Plugin** requires a `.cursor-plugin/plugin.json` manifest file"* — the
 * proprietary half of that page. So `logo` lives ONLY in the derived file, which is also the only
 * place any measured consumer reads it from (parse.ts:589). Putting it in root `plugin.json`
 * would have been invalid AND unread.
 *
 * `extensions` would have been the standard-sanctioned slot, and it is real — but Cursor publishes
 * no reverse-domain namespace for it, and inventing `com.cursor.*` would be a fabricated
 * identifier. Not a fallback. Do not revisit.
 *
 * ── TOKEN LAW ───────────────────────────────────────────────────────────────────────────────
 *
 *   node scripts/check-plugin-manifests.mjs              # live gate (network), READ-ONLY
 *   node scripts/check-plugin-manifests.mjs --sync       # regenerate the derived manifest
 *   node scripts/check-plugin-manifests.mjs --self-test  # two-way, vacuity-guarded, no network
 *
 *   PLUGIN_MANIFESTS_VERDICT=PASS|FAIL|INDETERMINATE     0 / 1 / 3
 *
 * 3 is the token-law default for a NEW gate (CLAUDE.md § Verification gate patterns) — this
 * script deploys no other code for "could not verify", so there is nothing to diverge from.
 * Callers gate on the TOKEN, never on the bare exit code.
 *
 * 🛑 THE DEFAULT RUN NEVER WRITES. A gate that silently repaired its own subject would report a
 * pass having hidden the drift it exists to surface — the read path FAILs and prints the
 * remediation; only `--sync` writes. `--sync` then RE-VERIFIES what it wrote, so it cannot
 * launder a corpus that fails the invariant (the shape `scripts/check-map-edges.mjs --sync`
 * already deploys).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

import { BAKED_VENUE_COUNT, hasBakedVenueCount } from './lib/baked-venue-count.mjs';
import { parseToolNames } from './lib/mcp-tools-list.mjs';

export const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

export const TOKEN = 'PLUGIN_MANIFESTS_VERDICT';

/** 0=PASS / 1=FAIL / 3=INDETERMINATE. ONE meaning, ONE code, chosen locally. */
export const EXIT = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };

/**
 * SINGLE DERIVATION of every path and URL this gate touches. Written once, projected everywhere;
 * the `$schema` literals inside the manifests are asserted EQUAL to these rather than restated.
 */
export const PLUGIN_MANIFEST = 'plugin.json';
export const MCP_MANIFEST = 'mcp.json';
export const CURSOR_MANIFEST = '.cursor-plugin/plugin.json';
export const SHIPPED_MANIFESTS = [PLUGIN_MANIFEST, MCP_MANIFEST, CURSOR_MANIFEST];

export const PLUGIN_SCHEMA_URL = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
export const MCP_SCHEMA_URL = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

import { CURSOR_MANIFEST_KEYS, LOGO_PATH, deriveCursorManifest, derivationDrift, serializeCursorManifest } from './lib/cursor-manifest.mjs';

export { CURSOR_MANIFEST_KEYS, LOGO_PATH, deriveCursorManifest, derivationDrift, serializeCursorManifest };

const UA = 'algovault-plugin-manifests-gate/1.0 (+https://algovault.com)';
const TIMEOUT_MS = 20000;

// ── the soft-404 guard ────────────────────────────────────────────────────────────────────────

/**
 * Turn a schema HTTP response into a parsed schema, or null.
 *
 * THE ONLY FUNCTION IN THIS FILE THAT THE SOFT-404 CAN REACH. All three assertions are load
 * bearing and each one alone is insufficient:
 *   - status 2xx        — a real 404 page is not a schema
 *   - content-type JSON — the soft-404 answers 200 with text/html, so status alone passes it
 *   - body parses to an OBJECT — a JSON content-type over a truncated or array body is not one
 *
 * null ⇒ INDETERMINATE at every call site. There is no branch on which an unreadable schema
 * becomes a pass.
 */
export function readSchemaResponse({ status, contentType, body }) {
  if (typeof status !== 'number' || status < 200 || status >= 300) return null;
  if (!String(contentType ?? '').toLowerCase().trim().startsWith('application/json')) return null;
  try {
    const doc = JSON.parse(String(body));
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : null;
  } catch {
    return null;
  }
}

// ── validation ────────────────────────────────────────────────────────────────────────────────

/**
 * Validate one document against one JSON Schema, returning error STRINGS (empty = valid).
 *
 * `ajv/dist/2020` is the draft-2020-12 entry point — both vendor schemas declare
 * `"$schema": "https://json-schema.org/draft/2020-12/schema"`, and ajv's default export is
 * draft-07, which would reject `$defs`/`oneOf` composition or silently mis-handle it. ajv is
 * already a dependency of this repo, so nothing was added for this gate.
 *
 * `strict: false` because the vendor schemas carry `description` beside `const` and other
 * annotations ajv's strict mode warns about — their document, not ours, and a warning is not a
 * validity finding. `allErrors` so one run names every violation instead of the first.
 */
export function validateDoc(schema, doc) {
  try {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validate = ajv.compile(schema);
    if (validate(doc)) return [];
    return (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ''}`);
  } catch (err) {
    // A schema we could not COMPILE is not a document we validated. Surface it as a violation
    // named for what it is, so it can never read as "validated, clean".
    return [`schema did not compile: ${err?.message ?? String(err)}`];
  }
}

// ── the decision ──────────────────────────────────────────────────────────────────────────────

/**
 * Decide from already-observed inputs. Pure, so every branch below is reachable from the
 * self-test without a network, a filesystem or a clock.
 *
 * ORDERING IS THE CONTRACT. Every "we could not look" case is evaluated BEFORE any "we looked and
 * it is wrong" case, so a degraded network can never be reported as a clean manifest, and a real
 * defect can never be masked by an unrelated outage.
 *
 * `null` for `plugin` / `mcp` / `pkg` means handed-and-unparseable ⇒ INDETERMINATE, always.
 * `cursorOnDisk` is the ONE deliberate exception and the reasoning is recorded rather than
 * assumed: that file is OUR OWN OUTPUT, not input handed to us by the world. A generator that
 * only ever emits valid JSON cannot produce an unparseable one, so unparseable there means a hand
 * edit — which is precisely the drift this check exists for. Calling it "could not verify" would
 * be weaker than the truth we actually have.
 */
export function decide(o) {
  const reasons = [];
  const ind = (msg) => {
    reasons.push(msg);
    return { verdict: 'INDETERMINATE', reasons };
  };

  // 1 — the committed inputs.
  if (!o.plugin) return ind(`could not read or parse ${PLUGIN_MANIFEST} — the gate verified nothing`);
  if (!o.mcp) return ind(`could not read or parse ${MCP_MANIFEST} — the gate verified nothing`);
  if (!o.pkg) return ind('could not read or parse package.json — the gate verified nothing');

  // 2 — the published schemas. THE SOFT-404 LANDS HERE.
  if (!o.pluginSchema) return ind(`${PLUGIN_SCHEMA_URL} did not answer 2xx application/json with a parseable object — refusing to "validate" against nothing`);
  if (!o.mcpSchema) return ind(`${MCP_SCHEMA_URL} did not answer 2xx application/json with a parseable object — refusing to "validate" against nothing`);

  // 3 — the live origin, and whether we could stat the logo.
  if (o.liveTools === null) return ind(`could not read tools/list from ${o.mcp?.mcpServers?.[Object.keys(o.mcp.mcpServers ?? {})[0]]?.url ?? 'the declared MCP url'} — the gate verified nothing`);
  if (o.logoExists === null) return ind(`could not stat ${LOGO_PATH} — the gate verified nothing`);

  let verdict = 'PASS';
  const fail = (msg) => {
    verdict = 'FAIL';
    reasons.push(msg);
  };

  // 4 — schema validity of the two standard manifests.
  const pluginErrors = o.validate(o.pluginSchema, o.plugin);
  if (pluginErrors.length) fail(`${PLUGIN_MANIFEST} is not valid against the published schema: ${pluginErrors.join('; ')}`);
  const mcpErrors = o.validate(o.mcpSchema, o.mcp);
  if (mcpErrors.length) fail(`${MCP_MANIFEST} is not valid against the published schema: ${mcpErrors.join('; ')}`);

  // 5 — version lockstep. plugin.json is the FOURTH member of the versioned-companion family.
  if (o.plugin.version !== o.pkg.version) {
    fail(`version lockstep broken — package.json=${o.pkg.version} ${PLUGIN_MANIFEST}=${o.plugin.version}`);
  }

  // 6 — the declared url really answers MCP. A parse that succeeded but found nothing is a dead
  // server behind a live manifest, which is worse than an unreachable one because it looks fine.
  if (o.liveTools.length === 0) {
    fail('the url declared in mcp.json answered MCP but advertised ZERO tools');
  }

  // 7 — public copy. The HELD list forbids a baked venue count on EVERY surface; plugin.json's
  // description is public copy and reaches the Cursor listing verbatim.
  if (hasBakedVenueCount(o.plugin.description)) {
    fail(`${PLUGIN_MANIFEST}.description carries a baked venue count (${JSON.stringify(String(o.plugin.description).match(BAKED_VENUE_COUNT)[0])}) — the public-copy HELD list forbids one`);
  }

  // 8 — R3's invariant, ENFORCED rather than trusted. A manifest absent from files[] never
  // reaches an npm consumer, and nothing else in the estate would notice.
  const files = Array.isArray(o.pkg.files) ? o.pkg.files : [];
  const missing = SHIPPED_MANIFESTS.filter((f) => !files.includes(f));
  if (missing.length) fail(`absent from package.json files[], so npm consumers never receive them: ${missing.join(', ')}`);

  // 9 — the derivation. NEVER regenerated here; the read path reports, `--sync` repairs.
  const drift = derivationDrift(o.plugin, o.cursorOnDisk, o.logoPath ?? LOGO_PATH);
  if (o.cursorOnDisk === null) {
    fail(`${CURSOR_MANIFEST} is missing or unparseable — run \`npm run cursor:manifest:sync\``);
  } else if (drift.length) {
    fail(`${CURSOR_MANIFEST} has drifted from its derivation — run \`npm run cursor:manifest:sync\`: ${drift.join('; ')}`);
  }

  // 10 — the logo actually resolves. A relative path is rewritten to a raw.githubusercontent URL,
  // so a missing file is a broken image on the public listing and nothing reports it.
  if (o.logoExists === false) {
    fail(`${CURSOR_MANIFEST}.logo names ${o.logoPath ?? LOGO_PATH}, which is not in the repo — the listing would render a broken image`);
  }

  if (verdict === 'PASS') {
    reasons.push(
      `${PLUGIN_MANIFEST} + ${MCP_MANIFEST} valid against their published schemas; ` +
        `version ${o.plugin.version} in lockstep with package.json; ` +
        `the declared url serves ${o.liveTools.length} tools; ` +
        `description carries no venue count; all ${SHIPPED_MANIFESTS.length} manifests in files[]; ` +
        `${CURSOR_MANIFEST} matches its derivation; ${o.logoPath ?? LOGO_PATH} resolves`,
    );
  }
  return { verdict, reasons };
}

// ── the fetch / filesystem seam ───────────────────────────────────────────────────────────────

function readJson(rel) {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));
  } catch {
    return null;
  }
}

async function getSchema(target) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(target, { signal: ctl.signal, headers: { 'User-Agent': UA, Accept: 'application/json' } });
    const body = await res.text();
    return readSchemaResponse({ status: res.status, contentType: res.headers.get('content-type'), body });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function getLiveTools(mcpUrl) {
  if (typeof mcpUrl !== 'string' || !mcpUrl) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) return null;
    return parseToolNames(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function logoResolves(logoPath) {
  try {
    return statSync(path.join(ROOT, logoPath)).isFile();
  } catch (err) {
    return err?.code === 'ENOENT' ? false : null;
  }
}

async function observe() {
  const plugin = readJson(PLUGIN_MANIFEST);
  const mcp = readJson(MCP_MANIFEST);
  const pkg = readJson('package.json');
  const cursorOnDisk = existsSync(path.join(ROOT, CURSOR_MANIFEST)) ? readJson(CURSOR_MANIFEST) : null;

  const [pluginSchema, mcpSchema] = await Promise.all([getSchema(PLUGIN_SCHEMA_URL), getSchema(MCP_SCHEMA_URL)]);
  if (!pluginSchema) console.error(`? ${PLUGIN_SCHEMA_URL}`);
  if (!mcpSchema) console.error(`? ${MCP_SCHEMA_URL}`);

  const servers = mcp?.mcpServers ?? {};
  const first = Object.keys(servers)[0];
  const liveTools = await getLiveTools(servers[first]?.url);
  if (liveTools === null) console.error('? tools/list from the url declared in mcp.json');

  return { plugin, mcp, pkg, cursorOnDisk, pluginSchema, mcpSchema, liveTools, logoExists: logoResolves(LOGO_PATH), validate: validateDoc };
}

// ── --sync ────────────────────────────────────────────────────────────────────────────────────

/**
 * Regenerate the derived manifest, then RE-VERIFY what was written.
 *
 * `--sync` may never launder a corpus that fails the invariant. It refuses outright when root
 * `plugin.json` is unreadable — there is nothing to project from — and after writing it re-runs
 * the full live decision, so a sync that "succeeds" while leaving the gate red is impossible.
 */
async function sync() {
  const plugin = readJson(PLUGIN_MANIFEST);
  if (!plugin) {
    console.error(`✗ --sync REFUSES: cannot read or parse ${PLUGIN_MANIFEST} — there is nothing to project from.`);
    console.log(`${TOKEN}=INDETERMINATE`);
    return EXIT.INDETERMINATE;
  }
  const bytes = serializeCursorManifest(deriveCursorManifest(plugin));
  const dest = path.join(ROOT, CURSOR_MANIFEST);
  const before = existsSync(dest) ? readFileSync(dest, 'utf8') : null;
  if (before === bytes) {
    console.log(`[plugin-manifests] --sync: ${CURSOR_MANIFEST} is already current — not rewritten`);
  } else {
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, bytes);
    console.log(`[plugin-manifests] --sync: wrote ${CURSOR_MANIFEST} (${bytes.length} B) from ${PLUGIN_MANIFEST}`);
  }
  return main([]);
}

// ── self-test ─────────────────────────────────────────────────────────────────────────────────
//
// Assertions NEVER raise: a broken subject must print SELF-TEST: FAIL, because an assertion that
// aborts the suite converts "proven able to fail" into "crashes".

let selfTestPass = 0;
let selfTestFail = 0;

function check(label, actual, expected) {
  let a;
  try {
    a = JSON.stringify(actual);
  } catch (err) {
    a = `<threw: ${err?.message}>`;
  }
  const e = JSON.stringify(expected);
  if (a === e) selfTestPass += 1;
  else {
    selfTestFail += 1;
    console.error(`  ✗ ${label}: expected ${e}, got ${a}`);
  }
}

/** The real soft-404, verbatim in shape: 200, text/html, the Cursor homepage. */
export const SOFT_404 = {
  status: 200,
  contentType: 'text/html; charset=utf-8',
  body: '<!DOCTYPE html><html lang="en"><head><title>Cursor - The best way to code with AI</title>',
};

function selfTest() {
  // VACUITY GUARD AT CONSTRUCTION — here WE build the corpus, so empty means the test built
  // nothing, which is a defect in the test. REFUSE. (At runtime the world builds it, and the
  // correct verdict over an unreachable world is INDETERMINATE, handled in `decide`.)
  const PLUGIN = {
    $schema: PLUGIN_SCHEMA_URL,
    name: 'crypto-quant-signal-mcp',
    version: '1.30.0',
    description: 'Composite BUY/SELL/HOLD verdicts for crypto perpetual futures.',
    author: { name: 'AlgoVault Labs', url: 'https://algovault.com' },
    homepage: 'https://algovault.com',
    repository: 'https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp',
    license: 'MIT',
    keywords: ['mcp', 'trading'],
  };
  const MCP = { $schema: MCP_SCHEMA_URL, mcpServers: { algovault: { type: 'streamable-http', url: 'https://api.algovault.com/mcp' } } };
  const PKG = { version: '1.30.0', files: [...SHIPPED_MANIFESTS, 'dist'] };
  const TOOLS = ['get_trade_call', 'get_track_record'];

  // Fixture SCHEMAS, small and real — they exercise the ajv wiring without restating the vendor's
  // 1805/3408-byte documents, which would be a second copy going stale on their release cadence.
  const CLOSED_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: { $schema: { type: 'string' }, name: { type: 'string' }, version: { type: 'string' }, description: { type: 'string' }, author: { type: 'object' }, homepage: { type: 'string' }, repository: { type: 'string' }, license: { type: 'string' }, keywords: { type: 'array' } },
    required: ['$schema', 'name'],
    additionalProperties: false,
  };
  const MCP_FIXTURE_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: { $schema: { type: 'string' }, mcpServers: { type: 'object', additionalProperties: { $ref: '#/$defs/server' } } },
    required: ['$schema', 'mcpServers'],
    additionalProperties: false,
    $defs: { server: { type: 'object', properties: { type: { const: 'streamable-http' }, url: { type: 'string' } }, required: ['type', 'url'], additionalProperties: false } },
  };

  const CURSOR = deriveCursorManifest(PLUGIN);
  const base = {
    plugin: PLUGIN, mcp: MCP, pkg: PKG, cursorOnDisk: CURSOR,
    pluginSchema: CLOSED_SCHEMA, mcpSchema: MCP_FIXTURE_SCHEMA,
    liveTools: TOOLS, logoExists: true, validate: validateDoc,
  };
  const with_ = (o) => ({ ...base, ...o });

  if (Object.keys(PLUGIN).length === 0 || TOOLS.length === 0 || SHIPPED_MANIFESTS.length === 0 || Object.keys(CURSOR).length === 0) {
    console.error('✗ self-test corpus is empty — refusing to report a result over nothing.');
    console.log(`${TOKEN}=INDETERMINATE`);
    return EXIT.INDETERMINATE;
  }

  // 1 — the happy path.
  check('a consistent corpus ⇒ PASS', decide(base).verdict, 'PASS');
  check('the PASS line names the tool count', decide(base).reasons.some((r) => r.includes('serves 2 tools')), true);

  // 2 — THE SOFT-404. The reason step 2 exists at all, asserted on the real response shape.
  check('soft-404 (200 + text/html) ⇒ readSchemaResponse null', readSchemaResponse(SOFT_404), null);
  check('soft-404 schema ⇒ INDETERMINATE, NEVER PASS', decide(with_({ pluginSchema: null })).verdict, 'INDETERMINATE');
  check('the mcp schema soft-404 ⇒ INDETERMINATE too', decide(with_({ mcpSchema: null })).verdict, 'INDETERMINATE');
  check('a real 404 ⇒ null', readSchemaResponse({ status: 404, contentType: 'application/json', body: '{}' }), null);
  check('a 200 JSON body that is an ARRAY ⇒ null', readSchemaResponse({ status: 200, contentType: 'application/json', body: '[]' }), null);
  check('a 200 JSON content-type over truncated JSON ⇒ null', readSchemaResponse({ status: 200, contentType: 'application/json', body: '{"type":' }), null);
  check('a missing content-type ⇒ null', readSchemaResponse({ status: 200, contentType: null, body: '{}' }), null);
  check('a real schema response ⇒ the parsed object', readSchemaResponse({ status: 200, contentType: 'application/json; charset=utf-8', body: '{"title":"Agent Plugins Manifest"}' }), { title: 'Agent Plugins Manifest' });
  check('content-type casing and padding do not defeat it', readSchemaResponse({ status: 200, contentType: '  APPLICATION/JSON ', body: '{"a":1}' }), { a: 1 });

  // 3 — handed-and-unparseable is INDETERMINATE, always.
  check('unreadable plugin.json ⇒ INDETERMINATE', decide(with_({ plugin: null })).verdict, 'INDETERMINATE');
  check('unreadable mcp.json ⇒ INDETERMINATE', decide(with_({ mcp: null })).verdict, 'INDETERMINATE');
  check('unreadable package.json ⇒ INDETERMINATE', decide(with_({ pkg: null })).verdict, 'INDETERMINATE');
  check('unreachable origin ⇒ INDETERMINATE, never FAIL', decide(with_({ liveTools: null })).verdict, 'INDETERMINATE');
  check('un-stat-able logo ⇒ INDETERMINATE', decide(with_({ logoExists: null })).verdict, 'INDETERMINATE');

  // A FAIL fixture that mutates `plugin` ALSO drifts the derivation, so `verdict === 'FAIL'`
  // alone passes for the wrong reason — measured: deleting the baked-count check outright left
  // this suite fully green. Every FAIL assertion below therefore pins its CAUSE as well, and any
  // fixture that edits `plugin` re-derives `cursorOnDisk` so only one cause is in play.
  const because = (o, needle) => decide(o).reasons.some((r) => r.includes(needle));
  const withPlugin = (plugin) => with_({ plugin, cursorOnDisk: deriveCursorManifest(plugin) });

  // 4 — schema validity, both directions, through the REAL ajv.
  check('a valid plugin.json ⇒ no errors', validateDoc(CLOSED_SCHEMA, PLUGIN), []);
  check('`logo` at the top level is REJECTED by the closed schema', validateDoc(CLOSED_SCHEMA, { ...PLUGIN, logo: 'logo.png' }).length > 0, true);
  check('the rejection NAMES the offending property', validateDoc(CLOSED_SCHEMA, { ...PLUGIN, logo: 'logo.png' }).join(' ').includes('logo'), true);
  check('a missing $schema is REJECTED (it is required, not optional)', validateDoc(CLOSED_SCHEMA, { name: 'x' }).length > 0, true);
  check('an invalid plugin.json ⇒ FAIL', decide(withPlugin({ ...PLUGIN, logo: 'logo.png' })).verdict, 'FAIL');
  check('…and the FAIL is ATTRIBUTED to the schema, not to something else', because(withPlugin({ ...PLUGIN, logo: 'logo.png' }), 'not valid against the published schema'), true);
  check('a type-less mcp server is REJECTED', validateDoc(MCP_FIXTURE_SCHEMA, { $schema: MCP_SCHEMA_URL, mcpServers: { a: { url: 'https://x/mcp' } } }).length > 0, true);
  check('our streamable-http entry is ACCEPTED', validateDoc(MCP_FIXTURE_SCHEMA, MCP), []);
  check('a type-less mcp.json ⇒ FAIL', decide(with_({ mcp: { $schema: MCP_SCHEMA_URL, mcpServers: { a: { url: 'https://x/mcp' } } } })).verdict, 'FAIL');
  check('…attributed to mcp.json', because(with_({ mcp: { $schema: MCP_SCHEMA_URL, mcpServers: { a: { url: 'https://x/mcp' } } } }), `${MCP_MANIFEST} is not valid`), true);
  check('an uncompilable schema is a VIOLATION, never a silent pass', validateDoc({ type: 'object', properties: { a: { $ref: '#/$defs/nope' } } }, { a: 1 }).length > 0, true);

  // 5 — version lockstep, both directions.
  check('versions in lockstep ⇒ PASS', decide(base).verdict, 'PASS');
  check('desynced versions ⇒ FAIL', decide(with_({ pkg: { ...PKG, version: '1.30.1' } })).verdict, 'FAIL');
  check('…attributed to version lockstep', because(with_({ pkg: { ...PKG, version: '1.30.1' } }), 'version lockstep broken'), true);
  check('the FAIL names BOTH versions', decide(with_({ pkg: { ...PKG, version: '1.30.1' } })).reasons.some((r) => r.includes('1.30.1') && r.includes('1.30.0')), true);

  // 6 — the live origin.
  check('zero advertised tools ⇒ FAIL (a dead server behind a live manifest)', decide(with_({ liveTools: [] })).verdict, 'FAIL');
  check('…attributed to the zero tool count', because(with_({ liveTools: [] }), 'advertised ZERO tools'), true);

  // 7 — the baked-count rule, both directions, through the SHARED predicate.
  check('a clean description does NOT fire', hasBakedVenueCount(PLUGIN.description), false);
  check('the shipped description does NOT fire', hasBakedVenueCount('Composite BUY/SELL/HOLD verdicts for crypto perpetual futures — cross-venue signal interpretation, funding-rate arbitrage scanning, market-regime detection, and an on-chain-anchored track record. Built for AI agents.'), false);
  check('"across 5 perp venues" fires', hasBakedVenueCount('across 5 perp venues'), true);
  const BAKED = { ...PLUGIN, description: 'verdicts across 12 venues' };
  check('a baked count ⇒ FAIL', decide(withPlugin(BAKED)).verdict, 'FAIL');
  check('…attributed to the BAKED COUNT and nothing else', because(withPlugin(BAKED), 'baked venue count'), true);
  check('…and the FAIL quotes the offending substring', because(withPlugin(BAKED), '12 venues'), true);

  // 8 — files[], the R3 invariant.
  check('all three manifests in files[] ⇒ PASS', decide(base).verdict, 'PASS');
  for (const f of SHIPPED_MANIFESTS) {
    check(`${f} absent from files[] ⇒ FAIL`, decide(with_({ pkg: { ...PKG, files: PKG.files.filter((x) => x !== f) } })).verdict, 'FAIL');
  }
  check('a files-less package.json ⇒ FAIL naming all three', decide(with_({ pkg: { version: '1.30.0' } })).reasons.some((r) => SHIPPED_MANIFESTS.every((f) => r.includes(f))), true);
  check('…attributed to files[]', because(with_({ pkg: { ...PKG, files: [] } }), 'absent from package.json files[]'), true);

  // 9 — THE DERIVATION. Every projected field must be able to fail independently, or a projection
  // could silently stop projecting and only the unasserted fields would drift.
  check('a matching derivation ⇒ no drift', derivationDrift(PLUGIN, CURSOR), []);
  for (const k of Object.keys(CURSOR)) {
    check(`a hand-edited \`${k}\` is DETECTED`, derivationDrift(PLUGIN, { ...CURSOR, [k]: 'TAMPERED' }).some((d) => d.startsWith(`${k}:`)), true);
  }
  check('an EXTRA hand-added key is detected', derivationDrift(PLUGIN, { ...CURSOR, displayName: 'Nope' }).some((d) => d.startsWith('displayName:')), true);
  check('a missing derived manifest ⇒ FAIL', decide(with_({ cursorOnDisk: null })).verdict, 'FAIL');
  check('the missing-file FAIL prints the remediation', decide(with_({ cursorOnDisk: null })).reasons.some((r) => r.includes('cursor:manifest:sync')), true);
  check('a drifted derived manifest ⇒ FAIL', decide(with_({ cursorOnDisk: { ...CURSOR, description: 'hand-edited' } })).verdict, 'FAIL');
  check('the drift FAIL prints the remediation', decide(with_({ cursorOnDisk: { ...CURSOR, description: 'hand-edited' } })).reasons.some((r) => r.includes('cursor:manifest:sync')), true);
  check('the derivation carries `logo`, which root plugin.json cannot', CURSOR.logo, LOGO_PATH);
  check('the derivation does NOT carry $schema (the Cursor format publishes none)', '$schema' in CURSOR, false);

  // 10 — SERIALIZATION IDEMPOTENCE. A key-order-unstable generator would rewrite the file on
  // alternate runs and make the drift check unreadable, so byte-stability is asserted directly.
  check('serialization is byte-stable across two derivations', serializeCursorManifest(deriveCursorManifest(PLUGIN)) === serializeCursorManifest(deriveCursorManifest(PLUGIN)), true);
  check('serialization is byte-stable under a shuffled input key order', serializeCursorManifest(deriveCursorManifest(PLUGIN)) === serializeCursorManifest(deriveCursorManifest(Object.fromEntries(Object.entries(PLUGIN).reverse()))), true);
  // The concrete regression this guards: someone rewrites `deriveCursorManifest` as
  // `{ ...plugin, logo }`, which LOOKS equivalent and is not — it inherits the input's key order
  // AND smuggles `$schema` into a file whose format publishes none. Assert the emitted key list.
  check('the derivation emits an EXPLICIT, fixed key list', Object.keys(CURSOR), CURSOR_MANIFEST_KEYS);
  check('a spread-based derivation would be caught by that list', Object.keys({ ...PLUGIN, logo: LOGO_PATH })[0] === 'name', false);
  check('serialization ends in exactly one newline', /[^\n]\n$/.test(serializeCursorManifest(CURSOR)), true);

  // 11 — the logo.
  check('a missing logo file ⇒ FAIL', decide(with_({ logoExists: false })).verdict, 'FAIL');
  check('…attributed to the logo', because(with_({ logoExists: false }), `.logo names ${LOGO_PATH}`), true);
  check('the logo FAIL says the listing would break', decide(with_({ logoExists: false })).reasons.some((r) => r.includes('broken image')), true);

  // 12 — ORDERING. An unreachable schema must win over a real defect, or a degraded network gets
  // reported as a manifest error and someone "fixes" a manifest that was never wrong.
  check('unreachable schema BEATS a version desync', decide(with_({ pluginSchema: null, pkg: { ...PKG, version: '9.9.9' } })).verdict, 'INDETERMINATE');
  check('unreachable origin BEATS a drifted derivation', decide(with_({ liveTools: null, cursorOnDisk: null })).verdict, 'INDETERMINATE');

  // 13 — the identifiers are derived once and never restated as second literals.
  check('the manifests agree with their $schema constants', [PLUGIN.$schema, MCP.$schema], [PLUGIN_SCHEMA_URL, MCP_SCHEMA_URL]);
  check('SHIPPED_MANIFESTS is exactly the three files', SHIPPED_MANIFESTS, ['plugin.json', 'mcp.json', '.cursor-plugin/plugin.json']);

  // 14 — TOKEN → EXIT-CODE MAPPING. Asserting the token alone once left a sibling gate fully green
  // after its INDETERMINATE mapping was re-coded to 0; assert the map itself.
  check('PASS ⇒ 0', EXIT.PASS, 0);
  check('FAIL ⇒ 1', EXIT.FAIL, 1);
  check('INDETERMINATE ⇒ 3', EXIT.INDETERMINATE, 3);

  const total = selfTestPass + selfTestFail;
  if (total === 0) {
    console.error('✗ self-test ran ZERO assertions — refusing to report a pass.');
    console.log(`${TOKEN}=INDETERMINATE`);
    return EXIT.INDETERMINATE;
  }
  if (selfTestFail > 0) {
    console.error(`✗ SELF-TEST: FAIL (${selfTestFail}) — ${selfTestFail} of ${total} assertion(s) failed.`);
    console.log(`${TOKEN}=FAIL`);
    return EXIT.FAIL;
  }
  console.log(
    `✓ self-test passed — ${total} assertions across 14 scenarios ` +
      '(soft-404, vacuity, schema validity both ways, lockstep, live origin, baked count, files[], ' +
      'derivation per-field, serialization idempotence, logo, ordering, token→exit map).',
  );
  console.log(`${TOKEN}=PASS`);
  return EXIT.PASS;
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--self-test')) return selfTest();
  if (argv.includes('--sync')) return sync();

  const result = decide(await observe());
  for (const r of result.reasons) {
    console.log(`${result.verdict === 'PASS' ? '✓' : result.verdict === 'FAIL' ? '✗' : '?'} ${r}`);
  }
  console.log(`${TOKEN}=${result.verdict}`);
  return EXIT[result.verdict];
}

main().then(
  (code) => process.exit(code),
  (err) => {
    // The one outcome the token law forbids is dying with no token at all.
    console.error(`✗ unhandled: ${err?.stack ?? err}`);
    console.log(`${TOKEN}=INDETERMINATE`);
    process.exit(EXIT.INDETERMINATE);
  },
);
