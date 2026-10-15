#!/usr/bin/env node
// @ts-check
/**
 * check-paid-route-validation.mjs — no paid route serves an unvalidated body, and no
 * adapter reads a venue field that venue does not return.
 *
 * OPS-AUDIT-REMEDIATION-MEDIUM-W1 / Ch3. Both findings are the same shape: a contract
 * that was enforced in ONE lane and silently skipped in another.
 *
 *   SEC-09 — the okx.ai /a2mcp/* POST routes handed req.body straight to the core dispatch,
 *   which did zero validation (blind casts only). The published JSON Schema bounds were
 *   enforced on /mcp and /x402/* and skipped here, so a paying partner posting
 *   {"coin":"BTC","timeframe":"7h"} got a verdict computed on 4h candles but LABELLED 7h.
 *
 *   SEC-11 — the Aster adapter read prevDayPx from `prevClosePrice`, a Binance SPOT-only
 *   field its perp ticker never returns. `?? 0` made it silently 0, so the 15%-weight
 *   momentum term scored a constant 0 on a promoted venue with nothing logged.
 *
 * WHAT IT ASSERTS:
 *   R1  Every rail's tool call — the `callTool({ … input: … })` sites in the paid rails
 *       (ARCH-MCP-CALL-PIPELINE-W1 CH2: src/lib/x402-http-routes.ts, src/lib/okx-a2mcp.ts,
 *       src/channels/acp/seller-worker.ts) — passes an input that is NEVER `req.body`, however
 *       cast. The pipeline's `ValidatedToolInput` brand is minted only at the validators, but a
 *       raw `req.body` is `any` and slips every brand, which is why this gate stays as the
 *       backstop (Q-PIPE-1 condition 2). Zero rail call sites is a scan that verified nothing →
 *       INDETERMINATE, never PASS (vacuity guard where the corpus is CONSTRUCTED).
 *   R2  Every 24h-ticker field an adapter reads exists in that venue's RECORDED live key
 *       set (ops/venue-ticker-keys.json). Venues with no recording are REPORTED, never
 *       silently passed — an unrecorded venue is unverified coverage, not clean coverage.
 *
 * Usage:
 *   node scripts/check-paid-route-validation.mjs --self-test
 *   node scripts/check-paid-route-validation.mjs
 *
 * Verdict: exactly one terminal `PAID_ROUTE_VALIDATION_VERDICT=PASS|FAIL|INDETERMINATE`.
 * Exit: 0 = PASS · 1 = FAIL · 3 = INDETERMINATE (scanned nothing / no rail call sites / no recordings).
 */

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, basename } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const KEYS_FILE = 'ops/venue-ticker-keys.json';

/** The paid rails — the files whose `callTool(` sites R1 judges. A rail added without a row here is unscanned, so the list is asserted non-empty and every entry must exist. */
export const RAIL_FILES = ['src/lib/x402-http-routes.ts', 'src/lib/okx-a2mcp.ts', 'src/channels/acp/seller-worker.ts'];

/** Literal-aware comment stripper — see check-webhook-idempotency.mjs for why a regex is unsafe. */
export function stripComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  let mode = 'code';
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (mode === 'code') {
      if (c === '/' && d === '*') { mode = 'block'; i += 2; out += ' '; continue; }
      if (c === '/' && d === '/') { mode = 'line'; i += 2; continue; }
      if (c === "'" || c === '"' || c === '`') { mode = c; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (mode === 'block') {
      if (c === '*' && d === '/') { mode = 'code'; i += 2; } else { if (c === '\n') out += '\n'; i++; }
      continue;
    }
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += '\n'; i++; } else i++;
      continue;
    }
    if (c === '\\') { out += c + (d ?? ''); i += 2; continue; }
    if (c === mode) { mode = 'code'; out += c; i++; continue; }
    out += c; i++;
  }
  return out;
}

/**
 * Every `callTool({ … })` site in `src`, with the text of its `input:` property.
 * The object literal is walked brace-aware so a nested `ctx: { … }` cannot swallow the scan.
 */
export function findCallToolSites(src) {
  const sites = [];
  const code = stripComments(src);
  const re = /\bcallTool\s*\(\s*\{/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let close = open;
    for (; close < code.length; close++) {
      if (code[close] === '{') depth++;
      else if (code[close] === '}') { depth--; if (depth === 0) break; }
    }
    const body = code.slice(open + 1, close);
    const inputMatch = /(^|[,{\s])input\s*:\s*([^,}]+)/.exec(body);
    const shorthand = /(^|[,{\s])input\s*(,|$)/m.test(body);
    sites.push({ snippet: code.slice(m.index, close + 1).replace(/\s+/g, ' ').slice(0, 120), input: inputMatch ? inputMatch[2].trim() : (shorthand ? 'input' : null) });
  }
  return sites;
}

/** R1 — a rail call that reaches the pipeline with a body the gate never saw. */
export function findUnvalidatedPaidHandlers(src) {
  const hits = [];
  for (const site of findCallToolSites(src)) {
    // The validator's output is the ONLY sanctioned input. A raw `req.body` (however cast) is
    // exactly the SEC-09 shape; an `input:` we cannot read is reported too, never assumed clean.
    if (site.input === null) {
      hits.push({ rule: 'R1', detail: 'callTool call site has no readable `input:` property — the gate cannot see what reaches the pipeline', snippet: site.snippet });
    } else if (/\breq\s*\.\s*body\b/.test(site.input)) {
      hits.push({ rule: 'R1', detail: 'callTool receives req.body directly — the schema gate is bypassed', snippet: site.snippet });
    }
  }
  return hits;
}

/**
 * R2 — every `ticker.<field>` an adapter reads must exist in that venue's recorded live
 * key set. `recordings` maps adapter basename → array of live keys.
 */
export function findPhantomTickerFields(fileName, src, recordings) {
  const hits = [];
  const venue = basename(fileName, '.ts');
  const keys = recordings[venue];
  const code = stripComments(src);
  const read = new Set();
  const re = /\bticker\s*\.\s*([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(code)) !== null) read.add(m[1]);
  if (read.size === 0) return { hits, status: 'no-ticker-reads', venue };
  if (!keys) return { hits, status: 'unrecorded', venue };
  for (const field of read) {
    if (!keys.includes(field)) {
      hits.push({ rule: 'R2', detail: `adapter reads ticker.${field}, absent from ${venue}'s recorded live key set`, snippet: `ticker.${field}` });
    }
  }
  return { hits, status: 'checked', venue };
}

// ── fixtures ──────────────────────────────────────────────────────────────────
const DIRTY_R1 = [
  "const o = await callTool({ tool: ht, input: (req.body ?? {}) as ValidatedToolInput, channel: 'a2mcp', license: X402_LICENSE });",
  "await callTool({ tool, input: req.body, channel: 'httpX402', license, ctx: { sessionId, ipHash } });",
  "await callTool({ tool, channel: 'httpX402', license, input: req.body as never });",
];
const CLEAN_R1 = [
  "const o = await callTool({ tool: ht, input: gate.input, channel: 'a2mcp', license: X402_LICENSE });",
  "const call = await callTool({\n  tool,\n  input,\n  channel: 'httpX402',\n  license,\n  ctx: { sessionId, ipHash, isAutomated: authenticity.is_automated },\n});",
  "const outcome = await callTool({ tool: httpTool, input, channel: 'acp', license: ACP_X402_LICENSE });",
  "// prose: callTool({ tool, input: req.body, channel: 'httpX402', license })\nconst x = 1;",
];
const R2_RECORDINGS = { demo: ['symbol', 'lastPrice', 'openPrice'] };
const DIRTY_R2 = ['const p = safeUpstreamNum(ticker.prevClosePrice) ?? 0;'];
const CLEAN_R2 = ['const p = safeUpstreamNum(ticker.openPrice) ?? safeUpstreamNum(ticker.lastPrice);'];

function selfTest() {
  const fails = [];
  if (!DIRTY_R1.length || !CLEAN_R1.length || !DIRTY_R2.length || !CLEAN_R2.length || !RAIL_FILES.length) {
    console.error('✖ self-test corpus is empty — refusing to report a pass');
    return 'INDETERMINATE';
  }
  for (const f of DIRTY_R1) if (!findUnvalidatedPaidHandlers(f).length) fails.push(`MISSED R1: ${f.slice(0, 70)}`);
  for (const f of CLEAN_R1) if (findUnvalidatedPaidHandlers(f).length) fails.push(`FALSE POSITIVE R1: ${f.slice(0, 70)}`);
  // The site counter itself: a clean fixture must be SEEN (0 sites would make "no finding" vacuous).
  for (const f of CLEAN_R1.slice(0, 3)) if (findCallToolSites(f).length !== 1) fails.push(`SITE COUNT: expected 1 callTool site in ${f.slice(0, 50)}`);
  if (findCallToolSites(CLEAN_R1[3]).length !== 0) fails.push('SITE COUNT: a commented-out call must not count as a site');
  for (const f of DIRTY_R2) if (!findPhantomTickerFields('demo.ts', f, R2_RECORDINGS).hits.length) fails.push(`MISSED R2: ${f.slice(0, 70)}`);
  for (const f of CLEAN_R2) if (findPhantomTickerFields('demo.ts', f, R2_RECORDINGS).hits.length) fails.push(`FALSE POSITIVE R2: ${f.slice(0, 70)}`);
  // An unrecorded venue must be reported, never counted as clean.
  const un = findPhantomTickerFields('nosuchvenue.ts', DIRTY_R2[0], R2_RECORDINGS);
  if (un.status !== 'unrecorded') fails.push('an unrecorded venue was not reported as unrecorded');
  if (fails.length) {
    console.error('✖ self-test FAILED:');
    fails.forEach((f) => console.error('   - ' + f));
    return 'FAIL';
  }
  console.log(`✓ self-test: ${DIRTY_R1.length + DIRTY_R2.length} known-bad fixtures flagged, ${CLEAN_R1.length + CLEAN_R2.length} clean fixtures passed, site counter + unrecorded-venue path reported.`);
  return 'PASS';
}

function verdictAndExit(v) {
  console.log(`PAID_ROUTE_VALIDATION_VERDICT=${v}`);
  process.exit(v === 'PASS' ? 0 : v === 'FAIL' ? 1 : 3);
}

if (argv.includes('--self-test')) verdictAndExit(selfTest());

const st = selfTest();
if (st !== 'PASS') verdictAndExit(st);

let files;
try {
  files = execFileSync('git', ['ls-files', 'src'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
} catch (err) {
  console.error(`✖ could not enumerate src/: ${err instanceof Error ? err.message : err}`);
  verdictAndExit('INDETERMINATE');
}
if (!files.length) {
  console.error('✖ scanned 0 source files — refusing to report a pass');
  verdictAndExit('INDETERMINATE');
}
for (const rail of RAIL_FILES) {
  if (!files.includes(rail)) {
    console.error(`✖ rail file ${rail} is not in the tree — R1's corpus is incomplete`);
    verdictAndExit('INDETERMINATE');
  }
}

let recordings = {};
const keysPath = join(ROOT, KEYS_FILE);
if (!existsSync(keysPath)) {
  console.error(`✖ ${KEYS_FILE} is missing — R2 cannot be evaluated`);
  verdictAndExit('INDETERMINATE');
}
try {
  recordings = JSON.parse(readFileSync(keysPath, 'utf8')).venues ?? {};
} catch (err) {
  console.error(`✖ ${KEYS_FILE} is unreadable: ${err instanceof Error ? err.message : err}`);
  verdictAndExit('INDETERMINATE');
}
if (Object.keys(recordings).length === 0) {
  console.error(`✖ ${KEYS_FILE} records zero venues — R2 would verify nothing`);
  verdictAndExit('INDETERMINATE');
}

const findings = [];
const unrecorded = [];
let checkedVenues = 0;
let railCallSites = 0;
for (const f of files) {
  let src;
  try {
    src = readFileSync(join(ROOT, f), 'utf8');
  } catch {
    continue;
  }
  // R1 over EVERY src file (a rail that grows a fourth call site elsewhere is still judged), with
  // the vacuity count taken over the declared rails.
  for (const h of findUnvalidatedPaidHandlers(src)) findings.push({ file: f, ...h });
  if (RAIL_FILES.includes(f)) railCallSites += findCallToolSites(src).length;
  if (f.startsWith('src/lib/adapters/') && !basename(f).startsWith('_')) {
    const r = findPhantomTickerFields(f, src, recordings);
    for (const h of r.hits) findings.push({ file: f, ...h });
    if (r.status === 'unrecorded') unrecorded.push(r.venue);
    if (r.status === 'checked') checkedVenues++;
  }
}

// Vacuity guard at the corpus we construct: zero rail call sites means R1 judged nothing.
if (railCallSites === 0) {
  console.error(`✖ R1 found 0 callTool call sites across the ${RAIL_FILES.length} rail file(s) — the scan verified nothing`);
  verdictAndExit('INDETERMINATE');
}

// No silent caps: say exactly which venues this run did NOT verify.
if (unrecorded.length) {
  console.log(`ℹ R2 coverage: ${checkedVenues} venue(s) verified against a live recording; ${unrecorded.length} NOT recorded and therefore unverified: ${unrecorded.sort().join(', ')}`);
}

if (findings.length) {
  console.error(`✖ ${findings.length} finding(s) across ${files.length} file(s):`);
  for (const h of findings) console.error(`   - ${h.file}  [${h.rule}] ${h.detail}`);
  verdictAndExit('FAIL');
}

console.log(`✓ paid-route validation: ${railCallSites} rail callTool site(s) take gate-validated input (never req.body); ${checkedVenues} adapter(s) read only fields their venue actually returns.`);
verdictAndExit('PASS');
