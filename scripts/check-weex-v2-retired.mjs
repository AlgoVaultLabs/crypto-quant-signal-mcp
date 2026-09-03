#!/usr/bin/env node
/**
 * check-weex-v2-retired.mjs — OPS-WEEX-PROMOTION-READINESS-W1 CH2.
 *
 * WEEX announced its V2 API sunset (V3 changelog 2026-03-09 and 2026-03-18; docs banner
 * "V2 (Sunsets Sep 30)" with the year absent — working deadline 2026-09-30). This gate
 * refuses a reintroduced V2 call site in owned source.
 *
 * ── WHY THIS IS NOT `grep -rn "capi/v2" src/` ────────────────────────────────────────
 * That is the codified gate-writing bug verbatim: "strip comments before grepping source
 * for a banned construct." The naive form matches `src/scripts/seed-shadow-venues-w3b.ts`,
 * whose `notes:` field records the 2026-05-20 pilot's V2 findings. That string is
 * EVIDENCE. A gate that can only pass by deleting a provenance note is a gate that will
 * be deleted instead, so the banned thing is defined as a V2 CALL, not the text "capi/v2".
 *
 * An exemption ALLOWLIST was considered and rejected: it grows one entry per future
 * historical mention and rots into the defensive-threshold shape this estate already
 * refuses. Distinguishing invocation from mention STRUCTURALLY needs no maintenance.
 *
 * Verdict contract: exactly one terminal `WEEX_V2_RETIRED_VERDICT=PASS|FAIL|INDETERMINATE`.
 * Exit 0=PASS / 1=FAIL / 3=INDETERMINATE (3 is the token-law default for a NEW gate).
 * Callers gate on the TOKEN, never the exit code.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PASS = 'PASS', FAIL = 'FAIL', INDET = 'INDETERMINATE';
const EXIT = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };

/**
 * A V2 CALL, not the substring. Two shapes reach WEEX's V2 API in this repo:
 * a relative path handed to the adapter's `weexGet`, and an absolute URL handed to the
 * seed fetcher's `fetchUniverseJson`. Both are quoted string literals beginning the path.
 */
const CALL_PATTERNS = [
  { re: /(['"`])\/capi\/v2\//, what: "relative V2 path literal (adapter weexGet)" },
  { re: /(['"`])https?:\/\/[^'"`]*weex[^'"`]*\/capi\/v2\//i, what: 'absolute V2 URL literal (seed fetcher)' },
];

/** Strip line and block comments so a mention inside prose is not read as an invocation. */
export function stripComments(src) {
  let out = '', i = 0, mode = 'code', quote = '';
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && d === '/') { mode = 'line'; i += 2; continue; }
      if (c === '/' && d === '*') { mode = 'block'; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') { mode = 'str'; quote = c; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (mode === 'str') {
      if (c === '\\') { out += c + (d ?? ''); i += 2; continue; }
      if (c === quote) { mode = 'code'; }
      out += c; i++; continue;
    }
    if (mode === 'line') { if (c === '\n') { mode = 'code'; out += c; } i++; continue; }
    if (mode === 'block') { if (c === '*' && d === '/') { mode = 'code'; i += 2; } else { if (c === '\n') out += c; i++; } continue; }
  }
  return out;
}

export function findV2Calls(source) {
  const stripped = stripComments(source);
  const hits = [];
  stripped.split('\n').forEach((line, idx) => {
    for (const { re, what } of CALL_PATTERNS) {
      if (re.test(line)) hits.push({ line: idx + 1, what, text: line.trim().slice(0, 120) });
    }
  });
  return hits;
}

function selfTest() {
  const cases = [
    // [label, source, expectedHitCount]
    ['bare call literal', `const r = await weexGet('/capi/v2/market/candles', {});`, 1],
    ['absolute seed URL', `fetchUniverseJson('https://api-contract.weex.com/capi/v2/market/tickers', 'WEEX');`, 1],
    ['LINE comment mention is NOT a call', `// WEEX — /capi/v2/market/tickers (volume_24h)`, 0],
    ['BLOCK comment mention is NOT a call', `/**\n * historical: /capi/v2/market/candles\n */`, 0],
    ['provenance notes STRING is a mention, not a path literal', `notes: '723 perps listed under /capi/v2/market/contracts / 4h funding',`, 0],
    ['v3 call is clean', `await weexGet('/capi/v3/market/klines', {});`, 0],
    ['a call AFTER a comment on the same line is still caught', `foo(); // x\nawait weexGet('/capi/v2/x');`, 1],
  ];
  let failed = 0;
  for (const [label, src, want] of cases) {
    let got;
    try { got = findV2Calls(src).length; } catch (e) { got = `threw ${e.message}`; }
    const ok = got === want;
    if (!ok) failed++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label} — expected ${want}, got ${got}`);
  }
  // Vacuity guard: the corpus here is CONSTRUCTED by us, so an empty one is a defect.
  if (cases.length === 0) { console.log('SELF-TEST: FAIL (corpus empty)'); return 1; }
  console.log(`SELF-TEST: ${failed === 0 ? 'PASS' : `FAIL (${failed})`} — ${cases.length} cases`);
  return failed === 0 ? 0 : 1;
}

function main() {
  if (process.argv.includes('--self-test')) {
    const rc = selfTest();
    const v = rc === 0 ? PASS : FAIL;
    console.log(`WEEX_V2_RETIRED_VERDICT=${v}`);
    process.exit(EXIT[v]);
  }
  let files;
  try {
    files = execFileSync('git', ['ls-files', 'src'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter(f => /\.(ts|mjs|js)$/.test(f));
  } catch (e) {
    console.log(`could not enumerate src/ via git: ${e.message}`);
    console.log(`WEEX_V2_RETIRED_VERDICT=${INDET}`);
    process.exit(EXIT[INDETERMINATE]);
  }
  // Input we were HANDED and could not enumerate is INDETERMINATE; an empty tracked
  // src/ is not a fact about WEEX, it is a broken checkout.
  if (files.length === 0) {
    console.log('git ls-files src/ returned nothing — cannot verify');
    console.log(`WEEX_V2_RETIRED_VERDICT=${INDET}`);
    process.exit(EXIT[INDETERMINATE]);
  }
  const found = [];
  for (const f of files) {
    let src;
    try { src = readFileSync(join(ROOT, f), 'utf8'); } catch { continue; }
    if (!src.includes('/capi/v2/')) continue;
    for (const hit of findV2Calls(src)) found.push({ file: f, ...hit });
  }
  // Positive per-check output — a silent zero is indistinguishable from a dark scan.
  console.log(`[weex-v2-retired] scanned ${files.length} tracked source file(s) under src/`);
  const mentions = files.filter(f => {
    try { return readFileSync(join(ROOT, f), 'utf8').includes('/capi/v2/'); } catch { return false; }
  });
  console.log(`[weex-v2-retired] ${mentions.length} file(s) MENTION /capi/v2/ (comments + provenance strings are allowed)`);
  if (mentions.length) console.log(`[weex-v2-retired]   ${mentions.join(', ')}`);
  if (found.length === 0) {
    console.log('[weex-v2-retired] 0 V2 CALL SITES — WEEX is fully on /capi/v3.');
    console.log(`WEEX_V2_RETIRED_VERDICT=${PASS}`);
    process.exit(EXIT[PASS]);
  }
  console.log(`[weex-v2-retired] ${found.length} V2 CALL SITE(S) remain:`);
  for (const h of found) console.log(`  ${h.file}:${h.line} — ${h.what}\n    ${h.text}`);
  console.log(`WEEX_V2_RETIRED_VERDICT=${FAIL}`);
  process.exit(EXIT[FAIL]);
}

main();
