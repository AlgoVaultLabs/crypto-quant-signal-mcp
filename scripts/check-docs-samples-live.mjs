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
 * Usage:
 *   node scripts/check-docs-samples-live.mjs                      # against https://api.algovault.com
 *   node scripts/check-docs-samples-live.mjs --live http://x:3000 # against another base
 *   node scripts/check-docs-samples-live.mjs --self-test          # offline, proves it can fail
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

// ── evaluation ───────────────────────────────────────────────────────────────

export const GATEWAYISH = (s) => s >= 502 && s <= 504;

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
    const failures = GATEWAYISH(observed.status) ? [] : probe.assert(observed);
    results.push({ id: probe.id, source: probe.source, status: observed.status, failures, transportError: null });
    const mark = GATEWAYISH(observed.status) ? '~' : failures.length ? '✗' : '✓';
    console.log(`  ${mark} ${probe.id} ${probe.method} ${probe.path} [${observed.status}] — ${probe.what}`);
  }

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
