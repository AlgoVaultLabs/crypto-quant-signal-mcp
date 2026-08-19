#!/usr/bin/env node
/**
 * check-docs-samples-live.mjs — DOCS-SAMPLE-EXECUTABLE-W1 CH2.
 *
 * THE CLASS THIS RETIRES. `https://algovault.com/docs` told every non-MCP integrator that the MCP
 * Streamable-HTTP transport "needs a 3-step handshake before tools/call". That stopped being true
 * when OPS-MCP-SESSION-RESILIENCE-W1 made the transport stateless, and nobody revisited the
 * sentence. It read as "REST here is hard", and it produced a real support email.
 *
 * The reason it could rot for months is the part worth fixing. `build_docs.mjs --check` compares
 * BYTES: a partial may assert anything at all and the check is green so long as the rendered page
 * matches its source. Nothing in this repo had ever EXECUTED a docs code sample. Meanwhile
 * `check-mcp-stateless.mjs:41` machine-asserts that a SESSIONLESS call succeeds, post-deploy, on
 * every push — the literal contradiction of the docs sentence, passing green beside it.
 *
 * So this gate makes the docs corpus a TEST corpus: samples are extracted from `docs-src/` and run
 * against the live API, and divergence fails.
 *
 * ── Extraction is by METHOD + PATH, never by host string ──────────────────────
 * Two of the seven HTTP-calling blocks are PATH-ONLY — `verify.html` ships bare
 * `GET /api/verify-signal?signalId=<ID>` and `GET /api/merkle-batches`, with no host. An extractor
 * keyed on `api.algovault.com` silently drops both, INCLUDING P5's own source block, and an
 * earlier draft's vacuity guard ("the extractor returns >= 5 blocks") passes at exactly 5 while
 * shipping a 4-probe corpus with a green self-test. A count cannot tell "found everything" from
 * "found five of six". The guard therefore asserts that every declared probe RESOLVES BY ENDPOINT,
 * so a dropped block names itself.
 *
 * ── Contract ─────────────────────────────────────────────────────────────────
 * Verdict: exactly one terminal `DOCS_SAMPLES_LIVE_VERDICT=PASS|FAIL|INDETERMINATE`.
 * Exit: 0 = PASS · 1 = FAIL · 3 = INDETERMINATE (the token-law default for a NEW gate;
 * `check-monitoring-schedules.mjs:74` is the precedent — deliberately NOT
 * `check_test_baseline.sh`'s 2, which is 2 only because it already deployed 2).
 * Callers gate on the TOKEN, never the bare exit code.
 *
 * FAIL-OPEN ON TRANSPORT, FAIL-CLOSED ON CONTENT:
 *   · network error / timeout            -> INDETERMINATE. Never FAIL.
 *   · any probe returning 502/503/504    -> INDETERMINATE. A 5xx is the GATEWAY answering, not the
 *     app. This branch is a hard-won lesson from `check-mcp-stateless.mjs:99-101`: wired
 *     post-deploy, that canary fired ~1.6s after the SSH step, got 502 on all three probes, and
 *     read it as a regression.
 *   · a PARSED response missing a documented key -> FAIL. That is real divergence.
 *
 * VACUITY GUARD AT CONSTRUCTION: we build the corpus from a tree we author, so a probe that fails
 * to resolve means the extractor broke — INDETERMINATE, never PASS.
 *
 * ── P7: the PARAMETER TABLES, not the code samples ────────────────────────────
 * DOCS-PARAM-SCHEMA-PROJECTION-W1. P1–P5 prove the docs SAMPLES run. They said nothing about the
 * parameter tables beside them, and those had drifted further than the prose ever did: the page
 * listed FIVE venues for `get_trade_call` where `tools/list` published SEVENTEEN, and named `1h`
 * as scan's timeframe default where the server defaulted to `15m`. Both were hand-typed, so
 * `build_docs --check` — a byte compare of page against source — was green throughout.
 *
 * `build_docs` now PROJECTS those rows from the same declaration the Zod schemas are built from,
 * which closes the gap at compile time. P7 closes the remaining one: that the page WE PUBLISHED
 * still matches the schema THE SERVER SERVES. A projection cannot catch a page that was never
 * rebuilt, or a deploy that shipped a different build than the docs were generated from.
 *
 * P7 asserts by IDENTITY, never by count, in both directions — a count cannot tell "17 rendered,
 * 17 live, matching" from "17 rendered, 17 live, two swapped" — and every failure names the
 * offending venue, parameter or default. Same rule that retired the `>= 5 blocks` guard above.
 * It also asserts COMPLETENESS: a served parameter with no documented row fails, because a table
 * that silently omits a parameter is the same defect as one that misstates it.
 *
 * Usage:
 *   node scripts/check-docs-samples-live.mjs                      # against https://api.algovault.com
 *   node scripts/check-docs-samples-live.mjs --live http://x:3000 # against another base
 *   node scripts/check-docs-samples-live.mjs --self-test          # offline, proves it can fail
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';
import { realpathSync } from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PARTIALS = join(ROOT, 'docs-src', 'partials');

/** `--live <baseUrl>` (shape borrowed from check-scan-digest-parity.mjs:35-38). */
export function resolveBase(argv = process.argv) {
  const i = argv.indexOf('--live');
  const v = i >= 0 ? argv[i + 1] : undefined;
  return (v && !v.startsWith('--') ? v : process.env.DOCS_SAMPLES_BASE || 'https://api.algovault.com').replace(/\/$/, '');
}

const TIMEOUT_MS = Number(process.env.DOCS_SAMPLES_TIMEOUT_MS || 30000);
const ACCEPT_BOTH = 'application/json, text/event-stream';

// ── extraction ───────────────────────────────────────────────────────────────

const ENTITIES = [[/&gt;/g, '>'], [/&lt;/g, '<'], [/&quot;/g, '"'], [/&#39;/g, "'"], [/&hellip;/g, '…'], [/&amp;/g, '&']];
export function decodeEntities(s) {
  return ENTITIES.reduce((acc, [re, ch]) => acc.replace(re, ch), s);
}

/** Every `<pre><code>…</code></pre>` body in an HTML partial, entity-decoded. */
export function codeBlocks(html) {
  return [...html.matchAll(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/g)].map((m) => decodeEntities(m[1]));
}

/**
 * HTTP calls in one code block, keyed on METHOD + PATH.
 *
 * Handles both documented forms:
 *   · curl, host-qualified — `curl -sS -X POST https://api.algovault.com/api/search … -d '{…}'`
 *   · bare verb + path     — `GET /api/merkle-batches`   (verify.html ships two of these)
 */
export function httpCallsIn(block) {
  const calls = [];

  // (a) curl invocations. `-X <VERB>` when present, else GET.
  for (const m of block.matchAll(/curl\b[\s\S]*?(?=\n\s*\n|$)/g)) {
    const cmd = m[0];
    const url = cmd.match(/https?:\/\/[^\s'"\\]+/);
    if (!url) continue;
    let path;
    try { path = new URL(url[0]).pathname; } catch { continue; }
    if (!/^\/(api|x402|mcp|health)/.test(path)) continue;
    const verb = cmd.match(/-X\s+([A-Z]+)/);
    const body = cmd.match(/-d\s+'([\s\S]*?)'/);
    calls.push({ method: verb ? verb[1] : 'GET', path, body: body ? body[1].trim() : null });
  }

  // (b) bare `VERB /path` lines — the form a host-keyed extractor drops.
  for (const m of block.matchAll(/^\s*(GET|POST|PUT|DELETE)\s+(\/[^\s<]*)/gm)) {
    calls.push({ method: m[1], path: m[2].split('?')[0], body: null });
  }
  return calls;
}

/** The whole docs corpus: every HTTP call in every partial, with provenance. */
export function extractCorpus(dir = PARTIALS) {
  if (!existsSync(dir)) return { error: `docs-src partials directory is missing: ${dir}` };
  const files = readdirSync(dir).filter((f) => f.endsWith('.html')).sort();
  if (files.length === 0) return { error: `no partials found in ${dir} — we author this tree, so empty means the walk broke` };
  const calls = [];
  for (const f of files) {
    for (const block of codeBlocks(readFileSync(join(dir, f), 'utf8'))) {
      for (const c of httpCallsIn(block)) calls.push({ ...c, source: f });
    }
  }
  return { calls };
}

// ── the probe corpus ─────────────────────────────────────────────────────────

/**
 * Each probe names the endpoint it must RESOLVE to in the extracted corpus. That identity — not a
 * block count — is the vacuity guard.
 *
 * DEFERRED, with the reason stated rather than silently dropped:
 *   · the x402 TypeScript sample (`channel-rest-api.html`) needs a funded Base wallet. A
 *     402-quote-only probe is a named follow-up.
 *   · the webhook sample (`channel-webhooks.html`) needs a real `av_live_` key, which would put a
 *     live credential in CI — a separate decision.
 * Everything below is KEYLESS by construction, so this gate never needs a secret.
 */
export const PROBES = [
  {
    id: 'P1', method: 'POST', path: '/mcp', source: 'channel-mcp.html',
    what: 'one-shot tools/call — no handshake, no session id',
    accept: ACCEPT_BOTH,
    assert(res) {
      const f = [];
      if (res.status !== 200) f.push(`status ${res.status} != 200`);
      const text = res.json?.result?.content?.[0]?.text;
      if (typeof text !== 'string') { f.push('no result.content[0].text — the one-shot call did not return a tool result'); return f; }
      let verdict;
      try { verdict = JSON.parse(text); } catch { f.push('result.content[0].text is not JSON — the documented double-parse is wrong'); return f; }
      for (const k of ['call', 'confidence', 'regime', 'price']) {
        if (!(k in verdict)) f.push(`verdict is missing documented key \`${k}\``);
      }
      return f;
    },
  },
  {
    id: 'P2', method: 'POST', path: '/mcp', source: 'channel-mcp.html',
    what: 'the documented Accept gotcha is real',
    accept: 'application/json',              // deliberately only one of the two
    derivedFrom: 'P1',
    assert(res) {
      const f = [];
      if (res.json?.error?.code !== -32000) f.push(`expected JSON-RPC -32000, got ${JSON.stringify(res.json?.error?.code)}`);
      if (!String(res.json?.error?.message || '').includes('Not Acceptable')) {
        f.push(`error message does not mention "Not Acceptable": ${JSON.stringify(res.json?.error?.message)}`);
      }
      return f;
    },
  },
  {
    id: 'P3', method: 'POST', path: '/api/search', source: 'tools-worked-examples.html',
    what: 'documented /api/search response keys',
    assert(res) {
      const f = [];
      if (res.status !== 200) f.push(`status ${res.status} != 200`);
      for (const k of ['query', 'total_results', 'results', '_algovault']) {
        if (!res.json || !(k in res.json)) f.push(`response is missing documented key \`${k}\``);
      }
      return f;
    },
  },
  {
    id: 'P4', method: 'POST', path: '/api/chat', source: 'tools-worked-examples.html',
    what: 'documented /api/chat response keys, with the model id READ FROM THE SAMPLE',
    assert(res) {
      const f = [];
      if (res.status !== 200) f.push(`status ${res.status} != 200`);
      if (res.json?.code === 'INVALID_MODEL') {
        f.push(`the model id in the docs sample is rejected: ${JSON.stringify(res.json)} — the sample has rotted`);
        return f;
      }
      for (const k of ['question', 'answer', 'citations', 'model']) {
        if (!res.json || !(k in res.json)) f.push(`response is missing documented key \`${k}\``);
      }
      return f;
    },
  },
  {
    id: 'P5', method: 'GET', path: '/api/merkle-batches', source: 'verify.html',
    what: 'documented merkle-batches SHAPE',
    assert(res) {
      const f = [];
      if (res.status !== 200) f.push(`status ${res.status} != 200`);
      const b = res.json?.batches;
      if (!Array.isArray(b)) { f.push('response is not an object carrying a `batches` array (a bare array would be the pre-2026-08 shape)'); return f; }
      // 🛑 SHAPE ONLY. NEVER assert `batches.length`. That array is LIMIT-capped at 100 while
      // `batch_count` is the population (131 when this shipped, and it moved 130 -> 131 inside one
      // working session). CLAUDE.md: "Never aggregate over a LIMIT-capped collection." A length
      // assertion here goes red the day the page size changes and stays green while the population
      // diverges — the same array whose `.length` once published "100 merkle batches" against 109.
      if (b.length === 0) return f; // an empty page is a fact about the chain, not a docs defect
      for (const k of ['batch_id', 'merkle_root', 'signal_count', 'tx_hash', 'block_number', 'published_at', 'basescanUrl']) {
        if (!(k in b[0])) f.push(`batch row is missing documented key \`${k}\``);
      }
      return f;
    },
  },
];

/** A probe resolves when the corpus contains a call with its METHOD + PATH. */
export function resolveProbes(calls, probes = PROBES) {
  return probes.map((p) => ({
    probe: p,
    match: calls.find((c) => c.method === p.method && c.path === p.path) || null,
  }));
}

// ── P7: rendered parameter tables vs the live tool schema ────────────────────

const DOCS_HTML = join(ROOT, 'landing', 'docs.html');
const TOOL_PARAM_SCHEMA_DIST = join(ROOT, 'dist', 'lib', 'tool-param-schema.js');

/**
 * The `<section id="…">` slice for one tool, then its FIRST table — the Parameters table.
 *
 * Scoping to the first table matters: `get-trade-call` also ships Response-Fields and `_receipts`
 * tables built from the same `.param-row` class, and a whole-section scan would read `timeframe`
 * the RESPONSE field as `timeframe` the parameter and then "prove" a documented parameter exists
 * that the table never listed.
 */
export function paramsTableFor(html, anchor) {
  const si = html.indexOf(`<section id="${anchor}"`);
  if (si === -1) return null;
  const nextSection = html.indexOf('<section id="', si + 1);
  const section = html.slice(si, nextSection === -1 ? undefined : nextSection);
  const ti = section.indexOf('<table ');
  if (ti === -1) return null;
  const te = section.indexOf('</table>', ti);
  return te === -1 ? null : section.slice(ti, te);
}

/**
 * Every documented parameter row for one tool: its name, the enum values rendered into it (null
 * when the row is hand-authored and non-enum), and the default chip's machine-readable value.
 */
export function renderedParamsFor(html, anchor) {
  const table = paramsTableFor(html, anchor);
  if (table === null) return null;
  const rows = [];
  for (const m of table.matchAll(/<tr class="param-row"([^>]*)>([\s\S]*?)<\/tr>/g)) {
    const attrs = m[1];
    const cells = m[2];
    const name = (cells.match(/<td>([A-Za-z][A-Za-z0-9_]*)<\/td>/) || [])[1];
    if (!name) continue;
    const projected = /data-schema-param="/.test(attrs);
    const values = projected ? [...cells.matchAll(/data-enum-value="([^"]+)"/g)].map((x) => x[1]) : null;
    const dflt = (attrs.match(/data-schema-default="([^"]*)"/) || [])[1] ?? null;
    rows.push({ name, values, default: dflt });
  }
  return rows;
}

/** Read the published page + the compiled tool→partial map. Both are artifacts we generate. */
export function loadRendered(htmlPath = DOCS_HTML, distPath = TOOL_PARAM_SCHEMA_DIST) {
  if (!existsSync(htmlPath)) return { error: `landing/docs.html is missing (${htmlPath}) — run \`node scripts/build_docs.mjs\`` };
  if (!existsSync(distPath)) return { error: `${distPath} not found — run \`npm run build\` (tsc) first` };
  return { html: readFileSync(htmlPath, 'utf8'), distPath };
}

/**
 * Pure comparison of the RENDERED table against the SERVED schema, per tool.
 *
 * `rendered` : { [tool]: [{ name, values|null, default|null }] }  (from the published page)
 * `live`     : { [tool]: inputSchema.properties }                 (from a live tools/list)
 *
 * Returns a flat list of human-readable failures, each NAMING what diverged. Both directions are
 * checked — a value on the page but not in the schema is as wrong as the reverse, and a count
 * check would see neither.
 */
export function compareSchemaProjection(rendered, live) {
  const failures = [];
  const setDiff = (a, b) => a.filter((x) => !b.includes(x));

  for (const [tool, rows] of Object.entries(rendered)) {
    const props = live[tool];
    if (!props) { failures.push(`${tool}: documented on /docs but absent from live tools/list`); continue; }
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));

    for (const row of rows) {
      const prop = props[row.name];
      if (!prop) { failures.push(`${tool}.${row.name}: documented on /docs but the live schema has no such parameter`); continue; }
      if (row.values === null) continue;  // hand-authored non-enum row: completeness only

      const liveEnum = Array.isArray(prop.enum) ? prop.enum : null;
      if (!liveEnum) { failures.push(`${tool}.${row.name}: /docs renders a fixed value list but the live schema declares no enum`); continue; }
      const missing = setDiff(liveEnum, row.values);
      const extra = setDiff(row.values, liveEnum);
      if (missing.length) failures.push(`${tool}.${row.name}: /docs is MISSING ${missing.length} accepted value(s): ${missing.join(', ')}`);
      if (extra.length) failures.push(`${tool}.${row.name}: /docs advertises ${extra.length} value(s) the server REJECTS: ${extra.join(', ')}`);

      const liveDefault = prop.default === undefined ? null : String(prop.default);
      if ((row.default ?? null) !== liveDefault) {
        failures.push(`${tool}.${row.name}: /docs shows default ${row.default === null ? '(none)' : `\`${row.default}\``} but the server defaults to ${liveDefault === null ? '(none)' : `\`${liveDefault}\``}`);
      }
    }

    // COMPLETENESS — a served parameter nobody documented. `assetClass` shipped undocumented for
    // months; without this leg the next one does too, and every other assertion still passes.
    for (const name of Object.keys(props)) {
      if (!byName[name]) failures.push(`${tool}.${name}: served by the live schema but has NO row on /docs`);
    }
  }
  return failures;
}

/**
 * The RESPONSE-field table for one tool — the first table after its "Response Fields" heading.
 *
 * Scoped past the heading on purpose: the PARAMETER table sits above it in the same section and
 * uses the same `.param-row` class, so an unscoped read would assert request params exist in a
 * response. `get-trade-call` also carries `_receipts` and `_algovault.auth` tables BELOW this one;
 * they document nested shapes, and only the top-level envelope belongs to this leg.
 */
export function responseFieldsFor(html, anchor) {
  const si = html.indexOf(`<section id="${anchor}"`);
  if (si === -1) return null;
  const nextSection = html.indexOf('<section id="', si + 1);
  const section = html.slice(si, nextSection === -1 ? undefined : nextSection);
  const hi = section.indexOf('>Response Fields<');
  if (hi === -1) return null;
  const ti = section.indexOf('<table ', hi);
  if (ti === -1) return null;
  const te = section.indexOf('</table>', ti);
  if (te === -1) return null;
  const rows = [];
  for (const m of section.slice(ti, te).matchAll(/<tr class="param-row"([^>]*)>([\s\S]*?)<\/tr>/g)) {
    const name = (m[2].match(/<td>([A-Za-z_][A-Za-z0-9_]*)<\/td>/) || [])[1];
    if (name) rows.push({ name, optional: /data-field-optional/.test(m[1]) });
  }
  return rows;
}

/**
 * Compare the documented envelope against a live response.
 *
 * REQUIRED fields must be present. OPTIONAL ones (`data-field-optional`) are legitimately absent —
 * `reasoning` is suppressed by `includeReasoning: false`, and `closest_tradeable` / `also_see` ship
 * only on a HOLD. Asserting their presence would redden this leg on the first BUY verdict of the
 * day, and a leg that fails on healthy output gets quarantined within a week. Their DECLARATION is
 * still checked: an optional row must be marked, so silently making a required field optional to
 * dodge a failure shows up as a docs edit rather than a passing gate.
 */
export function compareEnvelope(tool, documented, live) {
  const failures = [];
  if (!documented || documented.length === 0) return [`${tool}: no Response Fields table could be read from /docs`];
  const present = new Set(Object.keys(live || {}));
  const missing = documented.filter((f) => !f.optional && !present.has(f.name)).map((f) => f.name);
  if (missing.length) {
    failures.push(`${tool}: /docs documents ${missing.length} response field(s) the live call did not return: ${missing.join(', ')}`);
  }
  return failures;
}

/**
 * THE ERROR CONTRACT, declared as data so the exemption is visible.
 *
 * Each row carries the SHAPE it arrives in, because they differ and that difference is the whole
 * reason the docs section exists: `-32602` is HTTP 200 + `result.isError` with the code as TEXT and
 * NO `error` object, while the auth codes are structured `error.code`. A leg that asserted one
 * shape for all of them would have "verified" a contract nobody can consume.
 */
export const ERROR_CONTRACT = [
  {
    code: -32602,
    shape: 'result.isError',
    what: 'invalid enum value',
    // A venue outside the public 15 — the refusal CH1 shipped.
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_trade_call', arguments: { coin: 'BTC', exchange: 'EDGEX' } } },
    accept: ACCEPT_BOTH,
  },
  {
    code: -32003,
    shape: 'error.code',
    what: 'well-formed but unissued API key',
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    accept: ACCEPT_BOTH,
    headers: { Authorization: 'Bearer av_live_000000000000000000000000' },
  },
  {
    code: -32000,
    shape: 'http406',
    what: 'incomplete Accept header',
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    accept: 'application/json',
  },
  {
    code: -32004,
    shape: 'error.code',
    what: 'credential store unreachable',
    // DECLARED, not silently skipped. -32004 fires only when the upstream key store is unreachable,
    // which cannot be induced from outside — and faking it would mean asserting against a stub, i.e.
    // proving nothing about production. An exemption without a reason is INDETERMINATE, so the
    // reason lives here in the gate's own data rather than in a comment a reader has to find.
    documentedOnly: 'not reproducible on demand — requires an upstream credential-store outage; inducing one is not a test',
  },
];

/** Every `code` the rendered error table publishes. Identity source for the error leg. */
export function renderedErrorCodes(html) {
  const si = html.indexOf('<section id="tools-errors"');
  if (si === -1) return null;
  const nextSection = html.indexOf('<section id="', si + 1);
  const section = html.slice(si, nextSection === -1 ? undefined : nextSection);
  const codes = [];
  for (const m of section.matchAll(/<tr class="param-row"[^>]*><td>(-?\d+|HTTP \d+)<\/td>/g)) {
    codes.push(m[1].startsWith('HTTP') ? -32000 : Number(m[1]));
  }
  return codes;
}

/** Classify one observed error response against the shape its contract row declares. */
export function classifyErrorShape(row, observed) {
  const failures = [];
  const j = observed.json;
  if (row.shape === 'http406') {
    if (observed.status !== 406) failures.push(`${row.code} (${row.what}): expected HTTP 406, got ${observed.status}`);
    if (j?.error?.code !== row.code) failures.push(`${row.code} (${row.what}): expected error.code ${row.code}, got ${j?.error?.code}`);
    return failures;
  }
  if (row.shape === 'error.code') {
    if (j?.error?.code !== row.code) {
      failures.push(`${row.code} (${row.what}): expected a JSON-RPC error object with code ${row.code}, got ${j?.error ? `code ${j.error.code}` : 'no error object'}`);
    }
    return failures;
  }
  // result.isError — the shape the first draft of the docs got wrong.
  if (j?.error) failures.push(`${row.code} (${row.what}): arrived as a JSON-RPC error object, but /docs documents it as result.isError`);
  if (j?.result?.isError !== true) failures.push(`${row.code} (${row.what}): expected result.isError === true, got ${j?.result?.isError}`);
  const text = j?.result?.content?.[0]?.text ?? '';
  if (!String(text).includes(String(row.code))) failures.push(`${row.code} (${row.what}): code not present in result.content[0].text`);
  return failures;
}

/** One live POST to /mcp. Returns `{status, json}`; throws only on transport, which main() catches. */
async function callLive(base, body, accept, headers = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Accept: accept, ...headers },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let json = null;
    try { json = parseSse(text); } catch { /* non-JSON body */ }
    return { status: r.status, json };
  } finally {
    clearTimeout(t);
  }
}

/** Fetch the live tool list. Returns `{ tools }`, `{ transportError }` or `{ status }` for a 5xx. */
async function fetchLiveTools(base) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Accept: ACCEPT_BOTH },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }),
    });
    if (UNOBSERVABLE(r.status)) return { status: r.status };
    const text = await r.text();
    let json;
    try { json = parseSse(text); } catch { return { transportError: `tools/list returned unparseable body (${r.status})` }; }
    const tools = json?.result?.tools;
    if (!Array.isArray(tools)) return { transportError: `tools/list returned no tools array (${r.status})` };
    return { tools };
  } finally {
    clearTimeout(t);
  }
}

// ── evaluation ───────────────────────────────────────────────────────────────

export const GATEWAYISH = (s) => s >= 502 && s <= 504;

/**
 * 429 is fail-OPEN, for the same reason 502 is: we did not observe the documented behaviour.
 *
 * Measured 2026-08-19 — this gate calls the documented `/api/chat` sample on EVERY deploy, and the
 * free monthly chat quota is 10. Enough runs in a month and the endpoint answers
 * `CHAT_QUOTA_EXHAUSTED`, at which point P4 reports the docs as diverged on every subsequent
 * deploy. The endpoint is healthy; the gate ran out of its own quota. Reporting that as divergence
 * is a false accusation of exactly the kind the gateway branch already exists to prevent — the
 * documented keys cannot be present in a response that was never produced.
 *
 * 🛑 The remedy is NOT a quota-exempt key for the canary. An instrument that is exempt from the
 * limits it runs under stops measuring the thing callers experience, and the exemption then hides
 * a real quota regression. Fail open, stay honest, keep the INDETERMINATE visible in CI.
 */
export const QUOTA_REFUSAL = (s) => s === 429;

/** Every status where the app answered but the documented behaviour was NOT exercised. */
export const UNOBSERVABLE = (s) => GATEWAYISH(s) || QUOTA_REFUSAL(s);

/**
 * Pure classifier over observed results. Exported so `--self-test` drives the REAL logic with
 * synthetic inputs rather than a hand-written stand-in.
 */
export function classify(results) {
  const transport = results.filter((r) => r.transportError);
  if (transport.length) {
    return { verdict: 'INDETERMINATE', why: `transport: ${transport.map((r) => `${r.id} ${r.transportError}`).join('; ')}` };
  }
  const gateway = results.filter((r) => GATEWAYISH(r.status));
  if (gateway.length) {
    return { verdict: 'INDETERMINATE', why: `gateway/app not up: ${gateway.map((r) => `${r.id}=${r.status}`).join(', ')} — a 5xx is the gateway answering, not divergence` };
  }
  const quota = results.filter((r) => QUOTA_REFUSAL(r.status));
  if (quota.length) {
    return { verdict: 'INDETERMINATE', why: `rate-limited, documented behaviour not exercised: ${quota.map((r) => `${r.id}=429`).join(', ')} — this gate consumes a real quota on every deploy; the endpoint is fine` };
  }
  const failed = results.filter((r) => r.failures.length);
  if (failed.length) {
    return { verdict: 'FAIL', why: failed.map((r) => `${r.id} (${r.source}): ${r.failures.join(' · ')}`).join('\n  ') };
  }
  return { verdict: 'PASS', why: `${results.length} documented sample(s) executed and matched` };
}

function parseSse(text) {
  const line = text.split('\n').find((l) => l.startsWith('data:'));
  return line ? JSON.parse(line.slice(5).trim()) : JSON.parse(text);
}

async function run1(base, probe, match) {
  const url = `${base}${probe.path}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const headers = { Accept: probe.accept || 'application/json' };
    const init = { method: probe.method, signal: ctrl.signal, headers };
    if (probe.method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      // The BODY comes from the docs sample, never from this file — that is what makes P4's model
      // id a documented fact under test rather than a constant the gate carries.
      init.body = match?.body ?? '{}';
    }
    const r = await fetch(url, init);
    const text = await r.text();
    let json = null;
    try { json = parseSse(text); } catch { /* non-JSON body */ }
    return { status: r.status, json };
  } finally {
    clearTimeout(t);
  }
}

// ── self-test ────────────────────────────────────────────────────────────────

export function selfTest() {
  let passed = 0;
  const failed = [];
  const check = (label, actual, expected) => {
    if (actual === expected) { passed += 1; console.log(`  ✓ ${label}: ${actual}`); }
    else { failed.push(label); console.log(`  ✗ ${label}: expected ${expected}, got ${actual}`); }
  };
  const R = (over) => ({ id: 'Px', source: 'x.html', status: 200, failures: [], transportError: null, ...over });

  // Proven-fallible: a synthetic divergence MUST fail, a synthetic 503 MUST NOT.
  check('a clean set is PASS', classify([R()]).verdict, 'PASS');
  check('a missing documented key is FAIL', classify([R({ failures: ['verdict is missing documented key `confidence`'] })]).verdict, 'FAIL');
  check('a 503 is INDETERMINATE, not FAIL', classify([R({ status: 503 })]).verdict, 'INDETERMINATE');
  check('a 429 is INDETERMINATE — the gate ran out of quota, the docs did not diverge',
    classify([R({ status: 429 })]).verdict, 'INDETERMINATE');
  check('a 429 beside a content failure still reads INDETERMINATE — we observed nothing',
    classify([R({ status: 429, failures: ['missing key'] })]).verdict, 'INDETERMINATE');
  check('a 502 is INDETERMINATE', classify([R({ status: 502 })]).verdict, 'INDETERMINATE');
  check('a 504 is INDETERMINATE', classify([R({ status: 504 })]).verdict, 'INDETERMINATE');
  check('a network error is INDETERMINATE', classify([R({ transportError: 'ECONNREFUSED' })]).verdict, 'INDETERMINATE');
  check('transport wins over content — a blip never reads as divergence',
    classify([R({ transportError: 'timeout', failures: ['missing key'] })]).verdict, 'INDETERMINATE');

  // The per-probe assertions, driven with synthetic responses.
  const P = Object.fromEntries(PROBES.map((p) => [p.id, p]));
  const ok1 = { status: 200, json: { result: { content: [{ text: JSON.stringify({ call: 'HOLD', confidence: 6, regime: 'RANGING', price: 1 }) }] } } };
  check('P1 accepts a complete verdict', P.P1.assert(ok1).length, 0);
  const missing = JSON.parse(JSON.stringify(ok1));
  missing.json.result.content[0].text = JSON.stringify({ call: 'HOLD', regime: 'RANGING', price: 1 });
  check('P1 flags a verdict missing `confidence`', P.P1.assert(missing).length, 1);
  check('P2 accepts the documented -32000', P.P2.assert({ status: 200, json: { error: { code: -32000, message: 'Not Acceptable: …' } } }).length, 0);
  check('P2 flags a served response (gotcha no longer real)', P.P2.assert({ status: 200, json: { result: {} } }).length, 2);
  check('P3 flags a missing key', P.P3.assert({ status: 200, json: { query: 'q', results: [], _algovault: {} } }).length, 1);
  check('P4 flags INVALID_MODEL loudly', P.P4.assert({ status: 400, json: { code: 'INVALID_MODEL' } }).length, 2);
  check('P5 rejects a BARE array (the pre-2026-08 shape)', P.P5.assert({ status: 200, json: [] }).length, 1);
  check('P5 accepts an object with batches + all 7 row keys', P.P5.assert({
    status: 200,
    json: { batches: [{ batch_id: 1, merkle_root: 'r', signal_count: 2, tx_hash: 't', block_number: 3, published_at: 'p', basescanUrl: 'u' }] },
  }).length, 0);
  check('P5 never asserts a LENGTH — a 100-row capped page is clean', P.P5.assert({
    status: 200,
    json: { batch_count: 131, batches: Array.from({ length: 100 }, () => ({ batch_id: 1, merkle_root: 'r', signal_count: 2, tx_hash: 't', block_number: 3, published_at: 'p', basescanUrl: 'u' })) },
  }).length, 0);

  // ── the BYPASSED SEAM ──────────────────────────────────────────────────────
  // Every scenario above replaces the extractor, so nothing has exercised it. Assert IDENTITY, not
  // a count: a host-keyed extractor returns exactly 5 blocks and drops P5, so ">= 5" passes while
  // the corpus is missing the endpoint this wave had to correct.
  const corpus = extractCorpus();
  if (corpus.error) { failed.push(`bypassed artifact: ${corpus.error}`); console.log(`  ✗ bypassed artifact: ${corpus.error}`); }
  else {
    const resolved = resolveProbes(corpus.calls);
    for (const { probe, match } of resolved) {
      check(`bypassed artifact: ${probe.id} resolves to ${probe.method} ${probe.path}`, !!match, true);
    }
    // NEGATIVE CASE — prove the identity guard would have caught the host-keyed drop.
    const hostKeyed = corpus.calls.filter((c) => c.source !== 'verify.html');
    const dropped = resolveProbes(hostKeyed).filter((r) => !r.match).map((r) => r.probe.id);
    check('a host-keyed extractor FAILS the identity guard (naming P5)', dropped.join(','), 'P5');
  }

  // ── P7 — proven fallible on every direction it claims to check ─────────────
  // Identity, never count: each negative case below keeps the CARDINALITY unchanged where it can,
  // so a length assertion would pass every one of them.
  const LIVE3 = { get_trade_call: { exchange: { type: 'string', enum: ['HL', 'BINANCE', 'WHITEBIT'] } } };
  const row = (over) => [{ name: 'exchange', values: ['HL', 'BINANCE', 'WHITEBIT'], default: null, ...over }];

  check('P7 accepts an exactly-matching set', compareSchemaProjection({ get_trade_call: row({}) }, LIVE3).length, 0);
  check('P7 is ORDER-INDEPENDENT — a set, not a sequence',
    compareSchemaProjection({ get_trade_call: row({ values: ['WHITEBIT', 'HL', 'BINANCE'] }) }, LIVE3).length, 0);

  const missOne = compareSchemaProjection({ get_trade_call: row({ values: ['HL', 'BINANCE'] }) }, LIVE3);
  check('P7 FAILS on a missing venue', missOne.length, 1);
  check('P7 NAMES the missing venue', /MISSING 1 accepted value\(s\): WHITEBIT$/.test(missOne[0] || ''), true);

  // Same LENGTH as the live enum, one member swapped — the case a count check cannot see at all.
  const swapped = compareSchemaProjection({ get_trade_call: row({ values: ['HL', 'BINANCE', 'BOGUSVENUE'] }) }, LIVE3);
  check('P7 FAILS a same-LENGTH swapped set (a count check would pass this)', swapped.length, 2);
  check('P7 names the missing side', swapped.some((f) => f.includes('MISSING') && f.includes('WHITEBIT')), true);
  check('P7 names the rejected side', swapped.some((f) => f.includes('REJECTS') && f.includes('BOGUSVENUE')), true);

  const dflt = compareSchemaProjection(
    { scan_trade_calls: [{ name: 'timeframe', values: ['1h', '15m'], default: '1h' }] },
    { scan_trade_calls: { timeframe: { type: 'string', enum: ['1h', '15m'], default: '15m' } } },
  );
  check('P7 FAILS a stale DEFAULT even when the value set matches', dflt.length, 1);
  check('P7 names both defaults', /shows default `1h`.*defaults to `15m`/.test(dflt[0] || ''), true);

  check('P7 FAILS a served parameter with no documented row', compareSchemaProjection(
    { get_trade_call: row({}) },
    { get_trade_call: { exchange: LIVE3.get_trade_call.exchange, assetClass: { type: 'string', enum: ['perp'] } } },
  ).length, 1);
  check('P7 FAILS a documented parameter the server does not serve',
    compareSchemaProjection({ get_trade_call: [...row({}), { name: 'ghost', values: null, default: null }] }, LIVE3).length, 1);

  // ── the BYPASSED SEAM, again ───────────────────────────────────────────────
  // Every case above hands `compareSchemaProjection` a hand-built object, so nothing has yet run
  // the REAL extractor over the REAL published page — exactly the blind spot that let a host-keyed
  // corpus extractor ship green. Drive it, and assert the ARTIFACT, not just the classifier.
  const rend = loadRendered();
  if (rend.error) { failed.push(`bypassed artifact: ${rend.error}`); console.log(`  ✗ bypassed artifact: ${rend.error}`); }
  else {
    const gtc = renderedParamsFor(rend.html, 'get-trade-call');
    const scan = renderedParamsFor(rend.html, 'scan-trade-calls');
    check('bypassed artifact: get_trade_call parameter table is readable', Array.isArray(gtc) && gtc.length > 0, true);
    const ex = (gtc || []).find((r) => r.name === 'exchange');
    check('bypassed artifact: the exchange row is PROJECTED, not hand-typed', Array.isArray(ex && ex.values), true);
    // Scoped to the FIRST table: `timeframe` is also a RESPONSE field on this page, so a
    // whole-section scan would read response rows as parameters and then fail P7's completeness
    // leg against a schema that never had them. The sentinel is `price` — a response field that is
    // categorically not a parameter, and one the row-name regex definitely matches. An earlier
    // draft used `_receipts`, which reads as the more obvious choice and is WORSE: the leading
    // underscore falls outside that regex, so the assertion could never have fired and passed
    // happily with the scoping deliberately broken. Measured, not reasoned about.
    check('bypassed artifact: the response-field tables are NOT read as parameters',
      (gtc || []).some((r) => r.name === 'price'), false);
    // Per-tool differences survive the round trip. DOCS-SUPPORT-ANSWERS-AND-PUBLIC-VENUE-SCOPE-W1
    // made the VENUE sets equal by derivation — scan was always the promoted universe and the other
    // tools narrowed to it — so a strict-subset check now reddens on correct code. Two assertions
    // replace it: the venue sets must be EQUAL (the new invariant, and the whole point of that
    // wave), and the TIMEFRAME sets must still differ, which is what actually proves the projection
    // renders per tool rather than flattening every table to one set.
    const sx = (scan || []).find((r) => r.name === 'exchange');
    const venuesEqual = !!(ex && sx) && ex.values.length === sx.values.length
      && ex.values.every((v) => sx.values.includes(v));
    check('bypassed artifact: scan_trade_calls venues === get_trade_call venues (equal by derivation)', venuesEqual, true);
    const gtcTf = (gtc || []).find((r) => r.name === 'timeframe');
    const rgmTf = (renderedParamsFor(rend.html, 'get-market-regime') || []).find((r) => r.name === 'timeframe');
    const perToolDiffers = !!(gtcTf && rgmTf) && rgmTf.values.length < gtcTf.values.length
      && rgmTf.values.every((v) => gtcTf.values.includes(v));
    check('bypassed artifact: get_market_regime timeframes remain a STRICT SUBSET — tables render per tool', perToolDiffers, true);
  }

  // ── P7-ENV — proven fallible on the required/optional split ────────────────
  const DOC = [{ name: 'call', optional: false }, { name: 'confidence', optional: false }, { name: 'reasoning', optional: true }];
  check('P7-ENV accepts a complete response', compareEnvelope('t', DOC, { call: 'BUY', confidence: 7, reasoning: 'x' }).length, 0);
  check('P7-ENV accepts a response missing an OPTIONAL field — a BUY has no closest_tradeable',
    compareEnvelope('t', DOC, { call: 'BUY', confidence: 7 }).length, 0);
  const envMiss = compareEnvelope('t', DOC, { call: 'BUY', reasoning: 'x' });
  check('P7-ENV FAILS on a missing REQUIRED field', envMiss.length, 1);
  check('P7-ENV NAMES the missing field', /did not return: confidence$/.test(envMiss[0] || ''), true);
  check('P7-ENV treats an unreadable table as a failure, never as agreement', compareEnvelope('t', [], {}).length, 1);

  // ── P7-ERR — proven fallible, including the WRONG-SHAPE case ───────────────
  const R602 = ERROR_CONTRACT.find((r) => r.code === -32602);
  const R003 = ERROR_CONTRACT.find((r) => r.code === -32003);
  const ok602 = { status: 200, json: { result: { isError: true, content: [{ text: 'MCP error -32602: Input validation error' }] } } };
  check('P7-ERR accepts -32602 in its documented result.isError shape', classifyErrorShape(R602, ok602).length, 0);
  // THE case this leg exists for: the same code arriving in the OTHER shape. The first draft of the
  // docs described exactly this, and a caller following it reads a failure as a success.
  const wrong = classifyErrorShape(R602, { status: 200, json: { error: { code: -32602, message: 'x' } } });
  // Assert the MESSAGES, not the count. An earlier draft expected 2 and got 3 — a guessed number
  // that says nothing about whether the right thing was detected, and the exact habit the P5 leg
  // above exists to break.
  check('P7-ERR FAILS a -32602 presented as a JSON-RPC error object (the wrong-shape case)', wrong.length > 0, true);
  check('P7-ERR says WHICH shape /docs documents', wrong.some((f) => /documents it as result.isError/.test(f)), true);
  check('P7-ERR also notes result.isError was not set', wrong.some((f) => /expected result.isError === true/.test(f)), true);
  check('P7-ERR FAILS a -32602 that returned a normal verdict (gotcha no longer real)',
    classifyErrorShape(R602, { status: 200, json: { result: { content: [{ text: '{}' }] } } }).length, 2);
  check('P7-ERR accepts -32003 as a structured error object', classifyErrorShape(R003, { status: 200, json: { error: { code: -32003 } } }).length, 0);
  check('P7-ERR FAILS -32003 arriving as result.isError — shapes are per-code, not global',
    classifyErrorShape(R003, { status: 200, json: { result: { isError: true, content: [{ text: '-32003' }] } } }).length, 1);
  check('P7-ERR declares its one exemption WITH a reason — an undeclared skip is INDETERMINATE',
    ERROR_CONTRACT.filter((r) => r.documentedOnly).every((r) => typeof r.documentedOnly === 'string' && r.documentedOnly.length > 20), true);

  // ── the BYPASSED SEAM for both new legs ────────────────────────────────────
  const rend2 = loadRendered();
  if (rend2.error) { failed.push(`bypassed artifact: ${rend2.error}`); console.log(`  ✗ bypassed artifact: ${rend2.error}`); }
  else {
    const gtcFields = responseFieldsFor(rend2.html, 'get-trade-call') || [];
    const scanFields = responseFieldsFor(rend2.html, 'scan-trade-calls') || [];
    check('bypassed artifact: get_trade_call response fields are readable', gtcFields.length > 0, true);
    check('bypassed artifact: scan_trade_calls response fields are readable', scanFields.length > 0, true);
    // The optional MARKS are the load-bearing half — without them this leg reddens on a BUY verdict.
    check('bypassed artifact: the three conditional fields are MARKED optional',
      ['reasoning', 'closest_tradeable', 'also_see'].every((n) => gtcFields.find((f) => f.name === n)?.optional === true), true);
    // Scoped past the heading: a parameter name must NOT appear as a response field.
    check('bypassed artifact: the PARAMETER table is not read as the response envelope',
      scanFields.some((f) => f.name === 'topN'), false);
    const codes = renderedErrorCodes(rend2.html) || [];
    check('bypassed artifact: the rendered error table publishes every contract code',
      [...codes].sort((a, b) => a - b).join(','), [...ERROR_CONTRACT.map((r) => r.code)].sort((a, b) => a - b).join(','));
  }

  console.log(`SELF-TEST: ${failed.length === 0 ? 'PASS' : 'FAIL'} (${passed} passed, ${failed.length} failed)`);
  return failed.length === 0 ? 0 : 1;
}

// ── main ─────────────────────────────────────────────────────────────────────

const EXIT_FOR = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };

function emit(verdict, why) {
  if (verdict !== 'PASS') console.error(`  ${why}`);
  else console.log(`  ${why}`);
  console.log(`DOCS_SAMPLES_LIVE_VERDICT=${verdict}`);
  process.exit(EXIT_FOR[verdict]);
}

async function main() {
  const base = resolveBase();
  const corpus = extractCorpus();
  if (corpus.error) emit('INDETERMINATE', corpus.error);

  const resolved = resolveProbes(corpus.calls);
  const unresolved = resolved.filter((r) => !r.match);
  if (unresolved.length) {
    // Vacuity at CONSTRUCTION: we author docs-src/, so a probe that cannot be found means the
    // extractor broke — never "the docs are clean".
    emit('INDETERMINATE', `corpus extraction did not resolve: ${unresolved.map((r) => `${r.probe.id} (${r.probe.method} ${r.probe.path}, expected in ${r.probe.source})`).join('; ')}`);
  }

  console.log(`docs-samples-live: ${base} · ${corpus.calls.length} HTTP call(s) extracted from docs-src/ · ${resolved.length} probe(s) resolved by endpoint`);

  const results = [];
  for (const { probe, match } of resolved) {
    let observed;
    try {
      observed = await run1(base, probe, match);
    } catch (e) {
      results.push({ id: probe.id, source: probe.source, status: 0, failures: [], transportError: e?.message || String(e) });
      continue;
    }
    const failures = UNOBSERVABLE(observed.status) ? [] : probe.assert(observed);
    results.push({ id: probe.id, source: probe.source, status: observed.status, failures, transportError: null });
    const mark = UNOBSERVABLE(observed.status) ? '~' : failures.length ? '✗' : '✓';
    console.log(`  ${mark} ${probe.id} ${probe.method} ${probe.path} [${observed.status}] — ${probe.what}`);
  }

  // ── P7 — the published parameter tables against the served schema ──────────
  const loaded = loadRendered();
  if (loaded.error) emit('INDETERMINATE', `P7: ${loaded.error}`);
  const schemaMod = await import(pathToFileURL(loaded.distPath).href);

  const rendered = {};
  const unreadable = [];
  for (const [tool, partial] of Object.entries(schemaMod.TOOL_DOCS_PARTIAL)) {
    const rows = renderedParamsFor(loaded.html, partial);
    if (rows === null || rows.length === 0) { unreadable.push(`${tool} (section #${partial})`); continue; }
    rendered[tool] = rows;
  }
  // VACUITY AT CONSTRUCTION: landing/docs.html is an artifact WE generate, so a tool whose table we
  // cannot read means the generator or this extractor broke — never "the docs agree".
  if (unreadable.length) {
    emit('INDETERMINATE', `P7: no parameter table could be read for ${unreadable.join('; ')} — landing/docs.html is ours, so this is a broken extractor or a stale build, not agreement`);
  }
  const enumRows = Object.values(rendered).flat().filter((r) => r.values !== null).length;
  if (enumRows === 0) {
    emit('INDETERMINATE', 'P7: zero projected enum parameters found in landing/docs.html — the projection did not render, so there is nothing to compare');
  }

  const liveTools = await fetchLiveTools(base).catch((e) => ({ transportError: e?.message || String(e) }));
  const P7 = { id: 'P7', source: 'landing/docs.html', status: 200, failures: [], transportError: null };
  if (liveTools.transportError) {
    P7.transportError = liveTools.transportError;
    P7.status = 0;
  } else if (liveTools.status) {
    P7.status = liveTools.status;   // 502/503/504 — the gateway answering, not divergence
  } else {
    const live = Object.fromEntries(liveTools.tools.map((t) => [t.name, (t.inputSchema && t.inputSchema.properties) || {}]));
    P7.failures = compareSchemaProjection(rendered, live);
  }
  results.push(P7);
  const p7mark = P7.transportError || GATEWAYISH(P7.status) ? '~' : P7.failures.length ? '✗' : '✓';
  console.log(`  ${p7mark} P7 POST /mcp tools/list [${P7.status}] — ${enumRows} projected enum param(s) on /docs match the served schema`);

  // ── P7-ENV — the documented response envelope against a live response ──────
  // DOCS-SUPPORT-ANSWERS-AND-PUBLIC-VENUE-SCOPE-W1 CH2. A paying integrator had to email to learn
  // what `scan_trade_calls` returns, because the partial documented 7 request params and ZERO
  // response fields. Now that it documents them, a rename must fail the day it diverges.
  const ENVELOPE = [
    { tool: 'get_trade_call', anchor: 'get-trade-call', body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_trade_call', arguments: { coin: 'BTC', timeframe: '1h' } } } },
    { tool: 'scan_trade_calls', anchor: 'scan-trade-calls', body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'scan_trade_calls', arguments: { topN: 5, timeframe: '1h', limit: 3 } } } },
  ];
  const documented = {};
  for (const e of ENVELOPE) {
    const rows = responseFieldsFor(loaded.html, e.anchor);
    // Vacuity at CONSTRUCTION again: landing/docs.html is ours, so an unreadable table means the
    // generator or this extractor broke — never "the envelope agrees".
    if (!rows || rows.length === 0) {
      emit('INDETERMINATE', `P7-ENV: no Response Fields table could be read for ${e.tool} (section #${e.anchor}) — landing/docs.html is ours, so this is a broken extractor or a stale build`);
    }
    documented[e.tool] = rows;
  }

  const envRes = { id: 'P7-ENV', source: 'landing/docs.html', status: 200, failures: [], transportError: null };
  for (const e of ENVELOPE) {
    let obs;
    try {
      obs = await callLive(base, e.body, ACCEPT_BOTH);
    } catch (err) {
      envRes.transportError = err?.message || String(err);
      envRes.status = 0;
      break;
    }
    if (UNOBSERVABLE(obs.status)) { envRes.status = obs.status; break; }
    let payload = null;
    try { payload = JSON.parse(obs.json?.result?.content?.[0]?.text ?? 'null'); } catch { /* unparseable */ }
    if (!payload) { envRes.failures.push(`${e.tool}: live response carried no parseable tool payload`); continue; }
    envRes.failures.push(...compareEnvelope(e.tool, documented[e.tool], payload));
  }
  results.push(envRes);
  const envMark = envRes.transportError || UNOBSERVABLE(envRes.status) ? '~' : envRes.failures.length ? '✗' : '✓';
  const envCount = Object.values(documented).flat().length;
  console.log(`  ${envMark} P7-ENV POST /mcp tools/call [${envRes.status}] — ${envCount} documented response field(s) present on a live response`);

  // ── P7-ERR — every documented error code, each against ITS OWN shape ───────
  const renderedCodes = renderedErrorCodes(loaded.html);
  if (!renderedCodes || renderedCodes.length === 0) {
    emit('INDETERMINATE', 'P7-ERR: no error codes could be read from the rendered #tools-errors table — the section is ours, so this is a broken extractor or a stale build');
  }
  const errRes = { id: 'P7-ERR', source: 'landing/docs.html', status: 200, failures: [], transportError: null };

  // Identity both ways, before any network call: a code documented with no contract row cannot be
  // verified, and a contract row missing from the docs is a rule nobody published.
  const contractCodes = ERROR_CONTRACT.map((r) => r.code);
  for (const c of renderedCodes) if (!contractCodes.includes(c)) errRes.failures.push(`${c}: documented on /docs but absent from the gate's ERROR_CONTRACT — unverifiable`);
  for (const c of contractCodes) if (!renderedCodes.includes(c)) errRes.failures.push(`${c}: in the gate's ERROR_CONTRACT but not documented on /docs`);

  for (const row of ERROR_CONTRACT) {
    if (row.documentedOnly) {
      console.log(`  · ${row.code} documented-only — ${row.documentedOnly}`);
      continue;
    }
    let obs;
    try {
      obs = await callLive(base, row.body, row.accept, row.headers);
    } catch (err) {
      errRes.transportError = err?.message || String(err);
      errRes.status = 0;
      break;
    }
    if (UNOBSERVABLE(obs.status)) { errRes.status = obs.status; break; }
    errRes.failures.push(...classifyErrorShape(row, obs));
  }
  results.push(errRes);
  const errMark = errRes.transportError || UNOBSERVABLE(errRes.status) ? '~' : errRes.failures.length ? '✗' : '✓';
  const live = ERROR_CONTRACT.filter((r) => !r.documentedOnly).length;
  console.log(`  ${errMark} P7-ERR POST /mcp [${errRes.status}] — ${renderedCodes.length} documented code(s), ${live} reproduced live against their own shape`);

  const { verdict, why } = classify(results);
  emit(verdict, why);
}

/**
 * TEST-IMPORTABLE ENTRYPOINT (CLAUDE.md: "make entrypoints test-importable"). Real paths on both
 * sides — `resolve(argv[1])` does not follow symlinks while `fileURLToPath` does, and on macOS
 * (/tmp -> /private/tmp) that mismatch makes the guard false, so the script exits 0 having run
 * nothing and printed nothing: a dark guard at a green exit code. The imported path emits no
 * verdict token, because a seam that can print a verdict is a bypass on the instrument.
 */
const realOrSelf = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
if (process.argv[1] && realOrSelf(process.argv[1]) === realOrSelf(fileURLToPath(import.meta.url))) {
  if (process.argv.includes('--self-test')) process.exit(selfTest());
  main();
}
