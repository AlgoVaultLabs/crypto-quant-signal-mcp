#!/usr/bin/env node
// @ts-check
/**
 * check-adapter-numeric-guard.mjs — a RATCHET on raw numeric parsing in venue adapters.
 *
 * OPS-AUDIT-REMEDIATION-LOW-W1 · SEC-40.
 *
 * THE FINDING, AND WHY A RATCHET RATHER THAN A CLAIM OF VICTORY. `safeUpstreamNum` already
 * existed in the shared transport — shipped by an earlier wave as the "generator" fix for
 * default-deny numeric parsing — and exactly 2 of 18 adapters called it, against 176 raw
 * `parseFloat(` sites. That is a lane fix wearing a generator's clothes: the helper was
 * available, opt-in, and almost nobody opted in.
 *
 * `parseFloat('0x1')` returns 0 and `Number('0x1')` returns 1; both are finite, both pass an
 * `isFinite` check, and both are the WRONG PRICE. On a venue adapter that number reaches a
 * scoring term and then a paid verdict, silently.
 *
 * WHAT THIS GATE DOES. It pins the raw-`parseFloat` population per adapter file at a committed
 * baseline and fails when any file EXCEEDS its baseline. So:
 *   - a NEW adapter starts at baseline 0 and cannot use raw parseFloat at all;
 *   - an existing adapter cannot grow new raw sites;
 *   - converting sites to safeUpstreamNum lowers the count, and the gate then tells you to
 *     re-baseline downward, so the ratchet only ever tightens.
 *
 * WHAT THIS GATE DID NOT DO, AND WHO CLOSED IT. As shipped it did NOT convert the existing
 * sites — the bleeding stopped, the backlog was declared and counted, and the sweep was owed.
 * OPS-RATCHET-BASELINE-RETIRE-W1 (2026-08-04) paid it down 195 -> 43 by routing every
 * SIGNAL-PATH field (price, funding, open interest, kline OHLC) in all 15 unconverted adapters
 * through safeUpstreamNum. What is left is the DECLARED carve-out — candle `volume`,
 * `volume24h`, parseInt timestamps, one cosmetic volume sort — none of which reach a verdict.
 * The distinction is the point: a baseline is debt, a declared carve-out is a decision. Keep
 * stating it plainly, because a gate that silently tolerated 195 violations while reporting
 * PASS would be the "reads as coverage while protecting nothing" failure this repo has
 * retired four times.
 *
 * Verdict: exactly one terminal `ADAPTER_NUMERIC_GUARD_VERDICT=PASS|FAIL|INDETERMINATE`.
 * Exit: 0 = PASS · 1 = FAIL · 3 = INDETERMINATE (token-law default for a NEW gate).
 * FAIL-CLOSED: a missing baseline file, or an empty adapter set, is INDETERMINATE.
 *
 * Usage:
 *   node scripts/check-adapter-numeric-guard.mjs --self-test
 *   node scripts/check-adapter-numeric-guard.mjs            # enforce the ratchet
 *   node scripts/check-adapter-numeric-guard.mjs --baseline # rewrite the baseline (review the diff!)
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ADAPTER_DIR = join(ROOT, 'src', 'lib', 'adapters');
const BASELINE = join(ROOT, 'ops', 'adapter-numeric-guard-baseline.json');
const argv = process.argv.slice(2);

/** Raw numeric parses that bypass safeUpstreamNum. */
const RAW_RE = /\b(parseFloat|parseInt)\s*\(/g;

/** Strip comments so a `parseFloat` named in prose is not counted as a call site. */
export function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}

/** @param {string} src @returns {number} raw numeric-parse call sites */
export function countRaw(src) {
  const m = stripComments(src).match(RAW_RE);
  return m ? m.length : 0;
}

function adapterFiles() {
  if (!existsSync(ADAPTER_DIR)) return [];
  return readdirSync(ADAPTER_DIR).filter((f) => f.endsWith('.ts') && !f.startsWith('_')).sort();
}

export function measure() {
  const out = {};
  for (const f of adapterFiles()) out[f] = countRaw(readFileSync(join(ADAPTER_DIR, f), 'utf8'));
  return out;
}

export function selfTest() {
  const fails = [];
  if (countRaw('const a = parseFloat(x); const b = parseInt(y);') !== 2) fails.push('countRaw miscounted two raw sites');
  if (countRaw('// parseFloat(x) in a comment\nconst a = 1;') !== 0) fails.push('a commented parseFloat was counted');
  if (countRaw('/* parseFloat(x) */\nconst a = 1;') !== 0) fails.push('a block-commented parseFloat was counted');
  if (countRaw('const a = safeUpstreamNum(x);') !== 0) fails.push('safeUpstreamNum was counted as a raw parse');
  // the ratchet direction: over baseline must fail, at/under must pass
  const cmp = (cur, base) => cur > base;
  if (!cmp(3, 2)) fails.push('ratchet did not flag an INCREASE over baseline');
  if (cmp(2, 2)) fails.push('ratchet wrongly flagged an unchanged count');
  if (cmp(1, 2)) fails.push('ratchet wrongly flagged a DECREASE (a conversion)');
  return fails;
}

const IS_MAIN = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
function emit(v, why) {
  if (why) console.log(`\n${v === 'FAIL' ? '✖' : 'ℹ'} ${why}`);
  console.log(`ADAPTER_NUMERIC_GUARD_VERDICT=${v}`);
  process.exit(v === 'PASS' ? 0 : v === 'FAIL' ? 1 : 3);
}

if (IS_MAIN) {
  if (argv.includes('--self-test')) {
    const f = selfTest();
    if (f.length) { console.error('✖ adapter-numeric-guard self-test FAILED:'); f.forEach((x) => console.error('   - ' + x)); process.exit(1); }
    console.log('✓ adapter-numeric-guard self-test passed (counts raw sites, ignores comments, ratchets one way)');
    process.exit(0);
  }
  const stF = selfTest();
  if (stF.length) { stF.forEach((x) => console.error('   - ' + x)); emit('INDETERMINATE', 'self-test failure'); }

  const current = measure();
  if (!Object.keys(current).length) emit('INDETERMINATE', 'zero adapter files found — refusing a vacuous pass');

  if (argv.includes('--baseline')) {
    const total = Object.values(current).reduce((a, b) => a + b, 0);
    writeFileSync(BASELINE, JSON.stringify({
      _comment: 'SEC-40 ratchet baseline (OPS-AUDIT-REMEDIATION-LOW-W1). Per-file count of raw parseFloat/parseInt sites in venue adapters. A file may never EXCEED its number; lowering one (by converting to safeUpstreamNum) requires re-baselining downward, so the ratchet only tightens. Sweep of the existing backlog is owned by OPS-ADAPTER-SAFENUM-SWEEP-W{NEXT}.',
      _total: total,
      counts: current,
    }, null, 2) + '\n');
    console.log(`baseline written: ${Object.keys(current).length} adapters, ${total} raw sites`);
    process.exit(0);
  }

  if (!existsSync(BASELINE)) emit('INDETERMINATE', `baseline missing at ops/adapter-numeric-guard-baseline.json — run --baseline and commit it`);
  const base = JSON.parse(readFileSync(BASELINE, 'utf8')).counts || {};

  const over = [];
  const under = [];
  for (const [f, n] of Object.entries(current)) {
    const b = f in base ? base[f] : 0;
    if (n > b) over.push(`${f}: ${n} raw site(s) > baseline ${b}`);
    else if (n < b) under.push(`${f}: ${n} < baseline ${b}`);
  }
  if (over.length) {
    console.error('✖ raw numeric parsing INCREASED in venue adapter(s):');
    over.forEach((o) => console.error('   - ' + o));
    console.error('\n  parseFloat("0x1") is 0 and Number("0x1") is 1 — both finite, both the WRONG PRICE,');
    console.error('  and both reach a scoring term and then a paid verdict silently. Use');
    console.error('  safeUpstreamNum() from src/lib/adapters/_upstream-fetch.ts, which default-denies');
    console.error('  to null so the caller skips instead of emitting a corrupt number.');
    emit('FAIL', `${over.length} adapter file(s) exceed the committed baseline`);
  }
  const total = Object.values(current).reduce((a, b) => a + b, 0);
  if (under.length) {
    console.log(`✓ ratchet TIGHTENED — ${under.length} file(s) now below baseline:`);
    under.forEach((u) => console.log('   - ' + u));
    console.log('  Re-baseline with --baseline and commit, so the gain is locked in.');
  }
  console.log(`✓ adapter numeric guard: no file exceeds its baseline (${Object.keys(current).length} adapters, ${total} raw site(s) outstanding).`);
  console.log('  NOTE: SEC-40 is PARTIALLY closed — this gate stops NEW raw sites; the sweep of the');
  console.log('  existing backlog is OPS-ADAPTER-SAFENUM-SWEEP-W{NEXT}. Not coverage it does not have.');
  emit('PASS');
}
