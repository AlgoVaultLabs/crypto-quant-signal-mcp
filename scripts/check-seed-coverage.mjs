#!/usr/bin/env node
/**
 * scripts/check-seed-coverage.mjs — OPS-SEED-PROMOTED-RAMP-W1 coverage canary.
 *
 * Guards the producer↔monitor single-source-of-truth invariant that the daily
 * "Seed OUTAGE" alert exposed: the monitor pages any `promoted` venue whose
 * seed_heartbeats max-age ≥ 45min, but the producer's per-TF cron lines used to
 * hardcode `--exchange-list BINANCE,BYBIT,OKX,BITGET`, so newly-promoted venues
 * (MEXC, PHEMEX, …) were never seeded on a sub-45min line and lapsed.
 *
 * INVARIANT: every promoted venue must be covered by ≥1 crontab seed line whose
 * --timeframe is "fast" (∈ {3m,5m,15m,30m} — all < the 45min SLA). If a future
 * edit reverts the promoted lines to a hardcoded list (dropping a venue), this
 * fails LOUDLY (exit 1) at CI/deploy — BEFORE the 9pm TG alert would fire.
 *
 * The pure core (`findUncoveredPromoted`) is unit-tested with synthetic input; the
 * thin CLI reads the live crontab (`crontab -l`, or --crontab-file) and the
 * promoted set (--promoted CSV, supplied by the box wrapper from the venues table).
 *
 * Usage:
 *   scripts/check-seed-coverage.mjs --promoted "ASTER,BINANCE,…,PHEMEX" [--crontab-file <path>]
 */

/** Timeframes that refresh comfortably inside the monitor's 45-min SLA. */
export const FAST_TFS = new Set(['3m', '5m', '15m', '30m']);

/** The `--exchange ALL` shorthand (and the seeder's no-flag default) = the 5 original promoted venues. */
const EXCHANGE_ALL = ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET'];

function csv(v) {
  return (v || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
}

/**
 * Given ONE crontab line + the promoted set, return the set of promoted venues it
 * seeds at a FAST timeframe (empty if the line is not a fast seed line). Pure.
 */
export function fastCoverageForLine(line, promoted, faithfulFast = null) {
  if (!/seed-signals(\.js|\.ts)?\b/.test(line)) return [];
  const tf = (line.match(/--timeframe\s+(\S+)/) || [])[1];
  if (!tf || !FAST_TFS.has(tf)) return [];

  const promotedSet = new Set(promoted.map((v) => v.toUpperCase()));
  const exclude = new Set(csv((line.match(/--exclude\s+(\S+)/) || [])[1]));

  let covered;
  const exList = line.match(/--exchange-list\s+(\S+)/);
  const exOne = line.match(/--exchange\s+(\S+)/);
  const status = (line.match(/--status\s+(\S+)/) || [])[1];

  if (exList) {
    covered = csv(exList[1]);
  } else if (exOne) {
    covered = exOne[1].toUpperCase() === 'ALL' ? [...EXCHANGE_ALL] : [exOne[1].toUpperCase()];
  } else if (status === 'shadow') {
    covered = []; // shadow venues are not promoted
  } else {
    // `--status promoted`, `--status all`, or no selector (all non-retired):
    // every promoted venue is in scope.
    covered = [...promotedSet];
  }

  let scheduled = covered.filter((v) => promotedSet.has(v) && !exclude.has(v));
  // OPS-SEED-TF-SKIP-STRAND-HOTFIX-W1 (R4): crontab PRESENCE ≠ real coverage — the deployed faithful-skip
  // predicate can runtime-skip a venue's fast TF (WhiteBIT 3m/5m→15m). When the caller supplies the
  // per-venue faithful-FAST map (computed from the in-container predicate), a venue counts as covered on
  // THIS line only if the predicate KEEPS it at this TF. Absent the map, fall back to presence-only.
  if (faithfulFast) {
    scheduled = scheduled.filter((v) => (faithfulFast[v] || faithfulFast[v.toUpperCase()] || []).includes(tf));
  }
  return scheduled;
}

/**
 * Return the promoted venues NOT covered by any fast (<45min) seed line. Pure.
 * @returns {{ uncovered: string[], covered: string[] }}
 */
export function findUncoveredPromoted(crontabText, promoted, faithfulFast = null) {
  const promotedU = promoted.map((v) => v.toUpperCase());
  const coveredSet = new Set();
  for (const line of crontabText.split('\n')) {
    if (line.trimStart().startsWith('#')) continue; // skip comments
    for (const v of fastCoverageForLine(line, promotedU, faithfulFast)) coveredSet.add(v);
  }
  const uncovered = promotedU.filter((v) => !coveredSet.has(v));
  return { uncovered, covered: [...coveredSet].sort() };
}

// ── CLI (runs only when invoked directly) ──────────────────────────────────────
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const promoted = csv(arg('--promoted'));
  if (promoted.length === 0) {
    console.error('ERROR: --promoted "<CSV of promoted venue ids>" is required (from the venues table).');
    process.exit(2);
  }
  // OPS-SEED-TF-SKIP-STRAND-HOTFIX-W1 (R4): optional per-venue faithful-FAST map (JSON {VENUE:[tf,…]}),
  // computed by the box wrapper from the IN-CONTAINER predicate, so coverage = scheduled AND runtime-faithful.
  let faithfulFast = null;
  const ff = arg('--faithful-fast');
  if (ff) {
    try { faithfulFast = JSON.parse(ff); }
    catch { console.error('WARN: --faithful-fast is not valid JSON; falling back to presence-only coverage.'); }
  }
  let crontabText;
  const file = arg('--crontab-file');
  if (file) {
    const { readFileSync } = await import('node:fs');
    crontabText = readFileSync(file, 'utf8');
  } else {
    const { execSync } = await import('node:child_process');
    crontabText = execSync('crontab -l', { encoding: 'utf8' });
  }
  const { uncovered, covered } = findUncoveredPromoted(crontabText, promoted, faithfulFast);
  if (uncovered.length > 0) {
    console.error(
      `SEED COVERAGE FAIL: ${uncovered.length} promoted venue(s) have NO fast (<45min)${faithfulFast ? ' runtime-FAITHFUL' : ''} seed line: ` +
        `[${uncovered.join(', ')}]. Producer↔monitor SoT divergence — a promoted venue is not being seeded ` +
        `within the 45m freshness SLA (the "Seed OUTAGE" bug class)` +
        `${faithfulFast ? ' — either no fast line, or every fast line is runtime-skipped by the faithful-skip predicate' : ''}. ` +
        `Covered: [${covered.join(', ')}].`,
    );
    process.exit(1);
  }
  console.log(`seed-coverage OK: all ${promoted.length} promoted venues covered by a fast${faithfulFast ? ' runtime-faithful' : ''} seed line [${covered.join(', ')}]`);
}
