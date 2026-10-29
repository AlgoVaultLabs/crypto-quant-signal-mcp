/**
 * asset-class-totality.ts — OPS-ASSET-CLASS-TOTALITY-W1. The asset-class engine's census and its
 * daily two-way check.
 *
 *   node dist/scripts/asset-class-totality.js --census [--out <path>]
 *   node dist/scripts/asset-class-totality.js --check
 *
 * Both read every ACTIVE field venue live (`getActivePromotedVenueIds` — retired venues such as
 * BitMart/EdgeX are skipped, never counted as a failed fetch) through the engine's own detectors and
 * build the engine's own snapshot, so the census can only ever describe what serving does.
 *
 *  --census  writes the raw venue records (`[native, tag]` per instrument) to
 *            `tests/fixtures/asset-class-census.json`, the offline corpus the engine's tests run on,
 *            and prints the ledger verdict. A failed venue fetch writes nothing.
 *  --check   adds the two-way tier check against the live `/api/performance-public`:
 *              · a Tier-2/4 (coin, venue) row the engine classes TradFi;
 *              · a Tier-3 coin the engine classes CRYPTO on every venue it was called on.
 *            Run daily by `ops/monitoring/tier-misclassification-canary.sh` in the app container.
 *
 * Verdict (the LAST stdout line): `ASSET_CLASS_TOTALITY_VERDICT=PASS|FAIL|INDETERMINATE`, exit
 * 0/1/3. FAIL = any lost instrument, bare collision, unmapped tag, or tier↔class mismatch — one
 * `FAIL <kind> venue=… tag=… action=…` line each. INDETERMINATE = a venue fetch failed or the
 * public endpoint could not be read or parsed: nothing was verified, so nothing may page. Callers
 * gate on the TOKEN, never the exit code.
 */
import { renameSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  assetClassIn,
  buildAssetClassSnapshot,
  collectVenueRecords,
  FIELD_VENUES,
  type AssetClassSnapshot,
  type VenueRecord,
} from '../lib/asset-class-detection.js';
import type { FieldVenue } from '../lib/market-sessions-constants.js';
import { runAsBatch } from '../lib/upstream-weight-budget.js';
import { runScript } from '../lib/script-lifecycle.js';
import type { ExchangeId } from '../types.js';

export const VERDICT_TOKEN = 'ASSET_CLASS_TOTALITY_VERDICT';
export type TotalityVerdict = 'PASS' | 'FAIL' | 'INDETERMINATE';
const EXIT: Record<TotalityVerdict, number> = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };

export const DEFAULT_CENSUS_PATH = path.resolve(__dirname, '..', '..', 'tests', 'fixtures', 'asset-class-census.json');
const PERFORMANCE_PUBLIC_URL = 'https://algovault.com/api/performance-public';

export interface TierView { tier?: number; count?: number }
/** The slice of `/api/performance-public` the tier check reads. */
export interface PerformancePublicTiers {
  byAsset?: Record<string, TierView>;
  byExchange?: Record<string, { byAsset?: Record<string, TierView> }>;
}
export interface TotalityResult { verdict: TotalityVerdict; lines: string[] }

const sample = (xs: readonly string[], n = 6): string => xs.slice(0, n).join(',') + (xs.length > n ? `,…(+${xs.length - n})` : '');

/**
 * Pure: the verdict over a built snapshot. `perf` is the public endpoint's tiers for `--check`,
 * `null` when that read failed (⇒ INDETERMINATE), or `'skip'` for the census (no tier check).
 */
export function evaluateTotality(snap: AssetClassSnapshot, perf: PerformancePublicTiers | null | 'skip'): TotalityResult {
  const L = snap.ledger;
  const lines: string[] = [];
  for (const [v, x] of Object.entries(L.venues)) {
    lines.push(`venue=${v} tradfi=${x.tradfi} crypto=${x.crypto} lost=${x.lost} collisions=${x.collisions} shadowed=${x.shadowed} denied=${x.denied}`);
  }
  lines.push(`conflicts=${L.conflicts.length} (informational: the own record / first venue is kept)`);

  const undetermined: string[] = [];
  if (Object.keys(L.venues).length === 0) undetermined.push('INDETERMINATE no venue records were read');
  if (L.failed.length > 0) undetermined.push(`INDETERMINATE fetch-failed venues=${L.failed.join(',')}`);

  const fails: string[] = [];
  for (const x of L.lost) {
    fails.push(`FAIL lost venue=${x.venue} native=${x.native} expected=${x.expected} got=${x.got ?? 'null'} action=its own coin no longer reaches its record; check the ${x.venue} keying`);
  }
  for (const x of L.collisions) {
    fails.push(`FAIL collision venue=${x.venue} bare=${x.bare} natives=${x.natives.join(',')} action=two ${x.venue} instruments share one bare; fix the ${x.venue} keying`);
  }
  for (const x of L.unmapped) {
    fails.push(`FAIL unmapped venue=${x.venue} tag=${JSON.stringify(x.tag)} n=${x.natives.length} natives=${sample(x.natives)} action=add a VENUE_TAG_CLASS row for ${x.venue} ${JSON.stringify(x.tag)}`);
  }

  if (perf === null) {
    undetermined.push('INDETERMINATE performance-public unreadable (tier check not run)');
  } else if (perf !== 'skip') {
    const byEx = perf.byExchange ?? {};
    if (!perf.byAsset || Object.keys(perf.byAsset).length === 0 || Object.keys(byEx).length === 0) {
      undetermined.push('INDETERMINATE performance-public has no byAsset/byExchange (tier check not run)');
    } else {
      for (const [ex, e] of Object.entries(byEx)) {
        for (const [coin, a] of Object.entries(e.byAsset ?? {})) {
          if (a.tier !== 2 && a.tier !== 4) continue;
          const c = assetClassIn(snap, coin, ex as ExchangeId);
          if (c && c !== 'CRYPTO') {
            fails.push(`FAIL tier-not3-tradfi venue=${ex} coin=${coin} tier=${a.tier} class=${c} n=${a.count ?? 0} action=the venue records ${coin} as ${c}; its tier must follow`);
          }
        }
      }
      for (const [coin, a] of Object.entries(perf.byAsset)) {
        if (a.tier !== 3) continue;
        const venues = Object.keys(byEx).filter((ex) => byEx[ex].byAsset?.[coin]);
        if (venues.length > 0 && venues.every((ex) => assetClassIn(snap, coin, ex as ExchangeId) === 'CRYPTO')) {
          fails.push(`FAIL tier3-crypto coin=${coin} venues=${sample(venues)} n=${a.count ?? 0} action=every venue calling ${coin} records it as crypto; its tier must follow`);
        }
      }
    }
  }

  const verdict: TotalityVerdict = undetermined.length > 0 ? 'INDETERMINATE' : fails.length > 0 ? 'FAIL' : 'PASS';
  lines.push(...undetermined, ...fails, `${VERDICT_TOKEN}=${verdict}`);
  return { verdict, lines };
}

/** Census fixture body: one `[native, tag]` per line, natives sorted, so a refresh diffs cleanly. */
export function renderCensus(records: Partial<Record<FieldVenue, readonly VenueRecord[]>>, skipped: readonly string[], generatedAt: string): string {
  const venues = FIELD_VENUES.filter((v) => records[v]).map((v) => {
    const rows = [...records[v]!].sort((a, b) => (a.native < b.native ? -1 : a.native > b.native ? 1 : 0));
    return `    ${JSON.stringify(v)}: [\n${rows.map((r) => `      ${JSON.stringify([r.native, r.tag])}`).join(',\n')}\n    ]`;
  });
  return `{\n  "generated_at": ${JSON.stringify(generatedAt)},\n  "generator": "node dist/scripts/asset-class-totality.js --census",\n` +
    `  "skipped_retired": ${JSON.stringify(skipped)},\n  "venues": {\n${venues.join(',\n')}\n  }\n}\n`;
}

async function collectActive(): Promise<{ records: Partial<Record<FieldVenue, VenueRecord[]>>; failed: FieldVenue[]; skipped: FieldVenue[] }> {
  // Dynamic: venue-store pulls the DB layer, which the pure evaluator above must not.
  const { getActivePromotedVenueIds } = await import('../lib/venue-store.js');
  const active = new Set<string>(await getActivePromotedVenueIds());
  const skipped = FIELD_VENUES.filter((v) => !active.has(v));
  const { records, failed } = await collectVenueRecords(new Set(skipped));
  return { records, failed, skipped };
}

async function fetchPerformancePublic(): Promise<PerformancePublicTiers | null> {
  try {
    const res = await fetch(PERFORMANCE_PUBLIC_URL, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    return (await res.json()) as PerformancePublicTiers;
  } catch {
    return null;
  }
}

export async function runTotality(argv: readonly string[]): Promise<TotalityResult> {
  const mode = argv.includes('--census') ? 'census' : argv.includes('--check') ? 'check' : null;
  if (!mode) return { verdict: 'INDETERMINATE', lines: ['usage: asset-class-totality --census [--out <path>] | --check', `${VERDICT_TOKEN}=INDETERMINATE`] };
  const { records, failed, skipped } = await collectActive();
  const snap = buildAssetClassSnapshot(records, failed);
  const head = `mode=${mode} skipped_retired=${skipped.join(',') || 'none'}`;
  if (mode === 'census') {
    const r = evaluateTotality(snap, 'skip');
    if (failed.length === 0) {
      const outIdx = argv.indexOf('--out');
      const out = outIdx >= 0 && argv[outIdx + 1] ? path.resolve(argv[outIdx + 1]) : DEFAULT_CENSUS_PATH;
      const tmp = `${out}.tmp-${process.pid}`;
      writeFileSync(tmp, renderCensus(records, skipped, new Date().toISOString()));
      renameSync(tmp, out); // never truncate the tracked fixture in place
      return { verdict: r.verdict, lines: [head, `census written: ${out}`, ...r.lines] };
    }
    return { verdict: r.verdict, lines: [head, 'census NOT written (a venue fetch failed)', ...r.lines] };
  }
  const r = evaluateTotality(snap, await fetchPerformancePublic());
  return { verdict: r.verdict, lines: [head, ...r.lines] };
}

if (require.main === module) {
  void runScript('asset-class-totality', async () => {
    let r: TotalityResult;
    try {
      r = await runAsBatch(() => runTotality(process.argv.slice(2)), 'asset-class-totality');
    } catch (e) {
      r = { verdict: 'INDETERMINATE', lines: [`INDETERMINATE unexpected error: ${e instanceof Error ? e.message : String(e)}`, `${VERDICT_TOKEN}=INDETERMINATE`] };
    }
    for (const line of r.lines) console.log(line);
    return EXIT[r.verdict];
  });
}
