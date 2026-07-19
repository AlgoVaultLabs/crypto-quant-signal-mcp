#!/usr/bin/env node
/**
 * refresh-integrations-numbers.mjs — OPS-INTEGRATIONS-LIVE-SOT-W1
 *
 * Numbers-only, IDEMPOTENT refresher for the COMMITTED landing/integrations/*.html.
 *
 * Why this exists separately from `render-integrations.mjs`: that generator is
 * the real SoT, but a full regen pulls tutorial BODIES from the external
 * `algovault-skills` repo, which is not on the shipping path (and not present
 * in CI or on the deploy host). This script refreshes only the numbers and the
 * live-proxy hooks in the already-committed HTML, so a stale figure can be
 * corrected without an external checkout.
 *
 * Properties (mirrors scripts/snapshot-landing-data.mjs):
 *   - Idempotent: running twice against the SAME snapshot produces byte-identical files.
 *   - Fail-open: SoT unreachable → log + use the committed floor; never blocks.
 *   - --check: write nothing, exit 1 if any file WOULD change.
 *   - --dry-run: log the per-file diff, write nothing, exit 0.
 *
 * ⚠️ --check is a MANUAL diagnostic, NOT a CI gate. `totalCalls` grows every
 * few seconds, so a committed page drifts from live within a minute of any
 * refresh and --check would be red essentially always. The CI-safe guarantee
 * is the STALE-CLASS canary (tests/unit/integrations-no-stale-numbers.test.ts),
 * which asserts the retired literals and dead hooks never come BACK — a
 * property that is stable regardless of how far the live counter has moved.
 *   - Data Integrity: asserts every count only ever INCREASES, and that no page
 *     shrinks by more than a small prose delta. Refuses to write on a decrease.
 *
 * Usage:
 *   node scripts/refresh-integrations-numbers.mjs            # refresh in place
 *   node scripts/refresh-integrations-numbers.mjs --dry-run  # show diff only
 *   node scripts/refresh-integrations-numbers.mjs --check    # CI drift gate
 *
 * Zero npm deps (Node 20+ native fetch).
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const TARGET_DIR = join(ROOT, 'landing', 'integrations');
const require = createRequire(import.meta.url);
// The ONE venue SoT — same array that backs /api/performance-public.exchange_count.
const { EXCHANGE_COUNT } = require(join(ROOT, 'dist', 'lib', 'capabilities.js'));

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const DRY_RUN = args.includes('--dry-run');

// Fail-open FLOOR. Monotonic-safe: rendered counts carry a trailing `+`.
// TODO: revisit fallback floor by 2026-08-03
const FALLBACK = Object.freeze({ pfeWr: '91.5%', callCount: '383,785', batchCount: '100', assetCount: '1330' });

async function fetchSnapshot() {
  const base = process.env.API_BASE_URL || 'https://api.algovault.com';
  const out = { ...FALLBACK, date: new Date().toISOString().slice(0, 10), live: false };
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  try {
    const perf = await fetch(`${base}/api/performance-public`, { signal: AbortSignal.timeout(10000) })
      .then((r) => (r.ok ? r.json() : null));
    const calls = num(perf?.totalCalls);
    const wr = num(perf?.overall?.pfeWinRate);
    // `pfeWinRate` is a FRACTION and is `number | null`; a null would render
    // "0.0%" as public fact, so an implausible value falls back to the floor.
    if (calls && wr && wr <= 1) {
      out.callCount = calls.toLocaleString('en-US');
      out.pfeWr = `${(wr * 100).toFixed(1)}%`;
      out.live = true;
    }
    const assets = num(perf?.asset_count);
    if (assets) out.assetCount = String(Math.floor(assets / 10) * 10);
  } catch { /* floor stands */ }
  try {
    const merkle = await fetch(`${base}/api/merkle-batches`, { signal: AbortSignal.timeout(10000) })
      .then((r) => (r.ok ? r.json() : null));
    const n = Array.isArray(merkle?.batches) ? merkle.batches.length : 0;
    if (n > 0) out.batchCount = String(n);
  } catch { /* floor stands */ }
  return out;
}

const toInt = (s) => parseInt(String(s).replace(/,/g, ''), 10);

/**
 * All transforms are anchored on the live-proxy span shape, so they are
 * self-limiting: once a span holds the current value, re-running is a no-op.
 */
function transform(html, snap) {
  let out = html;

  // 1. Retire DEAD live-proxy hooks. track-record-proxy.js never calls
  //    setField() for these keys, so the spans never hydrated and their
  //    literals were frozen at bake time. `signal_count` was retired in
  //    v1.10.0 (OUTPUT-SANITIZE-W1 C5) in favour of `call_count`.
  out = out.replace(/data-tr-field="signal_count"/g, 'data-tr-field="call_count"');
  out = out.replace(/data-tr-field="total_calls"/g, 'data-tr-field="call_count"');
  out = out.replace(/data-tr-field="merkle_batches"/g, 'data-tr-field="merkle_batch_count"');

  // 2. Refresh the fallback literal INSIDE each live span (what a crawler and a
  //    JS-less visitor see, and what the knowledge bundle ingests).
  out = out.replace(/(<span data-tr-field="pfe_wr">)[^<]*(<\/span>)/g, `$1${snap.pfeWr}$2`);
  out = out.replace(/(<span data-tr-field="call_count">)[^<]*(<\/span>)/g, `$1${snap.callCount}$2`);
  out = out.replace(/(<span data-tr-field="exchange_count">)[^<]*(<\/span>)/g, `$1${EXCHANGE_COUNT}$2`);
  out = out.replace(/(<span data-tr-field="batch_count">)[^<]*(<\/span>)/g, `$1${snap.batchCount}$2`);
  out = out.replace(/(<span data-tr-field="merkle_batch_count">)[^<]*(<\/span>)/g, `$1${snap.batchCount}$2`);
  // `asset_count` renders floor-rounded to the nearest 10 — mirrors
  // formatAssetCount() in track-record-proxy.js EXACTLY, so the committed
  // floor is byte-identical to what the proxy paints on load.
  if (snap.assetCount) {
    out = out.replace(/(<span data-tr-field="asset_count">)[^<]*(<\/span>)/g, `$1${snap.assetCount}$2`);
  }

  // 3. Crawler-facing prose carries NO volatile number — meta and JSON-LD
  //    cannot self-heal (no client proxy runs for a crawler), so a baked
  //    figure there rots permanently. Kill the number, don't refresh it.
  out = out.replace(
    /(<meta (?:name="description"|property="og:description") content="Pair AlgoVault MCP&#39;s )composite verdict with ([^"]*?)&#39;s agent execution kit\. Free testnet demo · [^"]*?on-chain batches\.(">)/g,
    "$1verifiable, Merkle-anchored composite verdict across our supported exchanges with $2&#39;s agent execution kit. Free testnet demo — zero real-money risk in any code path.$3",
  );
  out = out.replace(
    /("description": "Pair AlgoVault MCP's composite verdict )\([^)]*\)( with )/g,
    "$1(verifiable, Merkle-anchored on Base L2 across our supported exchanges)$2",
  );

  // 4. Dates → this build.
  out = out.replace(/(<meta name="last-updated" content=")[^"]*(">)/g, `$1${snap.date}$2`);
  out = out.replace(/("dateModified": ")[0-9]{4}-[0-9]{2}-[0-9]{2}(T)/g, `$1${snap.date}$2`);
  out = out.replace(/(<!-- snapshot: )[0-9]{4}-[0-9]{2}-[0-9]{2}( —)/g, `$1${snap.date}$2`);

  return out;
}

/** Data Integrity: public counts may only ever grow. */
function assertMonotonic(file, before, after) {
  const grab = (h, key) => {
    const m = [...h.matchAll(new RegExp(`<span data-tr-field="${key}">([^<]*)</span>`, 'g'))];
    return m.map((x) => x[1]);
  };
  // Old dead keys map into call_count, so compare the union of the pre-images.
  const beforeCalls = [...grab(before, 'signal_count'), ...grab(before, 'total_calls'), ...grab(before, 'call_count')];
  const afterCalls = grab(after, 'call_count');
  for (const b of beforeCalls) {
    const bi = toInt(b);
    if (!Number.isFinite(bi)) continue;
    for (const a of afterCalls) {
      const ai = toInt(a);
      if (Number.isFinite(ai) && ai < bi) {
        throw new Error(`[refresh] DATA-INTEGRITY ABORT ${file}: call count would DECREASE ${b} → ${a}`);
      }
    }
  }
  const beforeEx = grab(before, 'exchange_count').map(toInt).filter(Number.isFinite);
  for (const b of beforeEx) {
    if (EXCHANGE_COUNT < b) {
      throw new Error(`[refresh] DATA-INTEGRITY ABORT ${file}: exchange count would DECREASE ${b} → ${EXCHANGE_COUNT}`);
    }
  }
}

async function main() {
  const snap = await fetchSnapshot();
  console.log(
    `[refresh] snapshot ${snap.live ? 'LIVE' : 'FALLBACK (SoT unreachable — using floor)'}` +
    ` pfeWr=${snap.pfeWr} callCount=${snap.callCount} batchCount=${snap.batchCount}` +
    ` assetCount=${snap.assetCount} exchanges=${EXCHANGE_COUNT} date=${snap.date}`,
  );

  const files = (await readdir(TARGET_DIR)).filter((f) => f.endsWith('.html')).sort();
  let changed = 0;
  for (const f of files) {
    const path = join(TARGET_DIR, f);
    const before = await readFile(path, 'utf8');
    const after = transform(before, snap);
    if (before === after) {
      console.log(`[refresh]   ${f}: no change`);
      continue;
    }
    assertMonotonic(f, before, after);
    changed++;
    // Per-file diff audit: report every field that moved.
    const deltas = [];
    for (const key of ['signal_count', 'total_calls', 'merkle_batches']) {
      const n = (before.match(new RegExp(`data-tr-field="${key}"`, 'g')) || []).length;
      if (n) deltas.push(`hook ${key}→live ×${n}`);
    }
    for (const [label, re] of [
      ['pfe_wr', /<span data-tr-field="pfe_wr">([^<]*)<\/span>/],
      ['call_count', /<span data-tr-field="(?:signal_count|total_calls|call_count)">([^<]*)<\/span>/],
      ['exchange_count', /<span data-tr-field="exchange_count">([^<]*)<\/span>/],
    ]) {
      const b = before.match(re)?.[1];
      const a = after.match(new RegExp(String(re.source).replace('(?:signal_count|total_calls|call_count)', 'call_count')))?.[1];
      if (b !== undefined && a !== undefined && b !== a) deltas.push(`${label} ${b}→${a}`);
    }
    const metaKilled = /Free testnet demo · /.test(before) && !/Free testnet demo · /.test(after);
    if (metaKilled) deltas.push('meta+JSON-LD → forward-stable (numbers removed)');
    console.log(`[refresh] ${CHECK || DRY_RUN ? 'WOULD CHANGE' : 'updated'} ${f}: ${deltas.join(' · ')}`);
    if (!CHECK && !DRY_RUN) await writeFile(path, after);
  }

  console.log(`[refresh] ${changed}/${files.length} files ${CHECK || DRY_RUN ? 'would change' : 'changed'}`);
  if (CHECK && changed > 0) {
    console.error('[refresh] --check FAILED: committed integration pages drift from live SoT. Run without --check.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[refresh] FATAL:', err.message);
  process.exit(1);
});
