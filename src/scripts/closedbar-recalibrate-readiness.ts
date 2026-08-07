#!/usr/bin/env node
/**
 * closedbar-recalibrate-readiness.ts — OPS-CLOSEDBAR-RECALIBRATE-READINESS-W1
 *
 * The instrument for `OPS-CLOSEDBAR-RECALIBRATE-W{NEXT}`, built BEFORE the decision rather
 * than during it. `SIGNAL-CLOSEDBAR-FLIP-W1` answered Q1=B — flip the basis, change no
 * constants, defer calibration to a wave that would have real post-flip PFE outcomes. Those
 * outcomes are now accruing; this reports them and computes whether there are enough yet.
 *
 * ── Why an instrument wave at all ────────────────────────────────────────────
 * The flip's Step 0 had to reconstruct three things its input report should have carried:
 *   F2  no venue breakdown — the spec's 87.8% floor rate was a Binance/XRP proxy against a
 *       real 78.58%, and the true spread was 2.85%-78.58% ACROSS venues
 *   F5  thresholds sit ON atoms — 10,748 rows at raw=41, 12,873 at raw=-55, so |raw|>54
 *       admits 13,152 while |raw|>55 admits 281: a 47x cliff
 *   F6  an aggregate of 96.2% concealed 67% (4h) to 206% (1d) per timeframe
 * All three are properties of the INSTRUMENT, not the decision. Hence: every statistic is
 * sliced per-timeframe AND per-venue, and any candidate threshold is atom-checked.
 *
 * ── READ-ONLY, and that is gate-enforced ─────────────────────────────────────
 * The only verb this file may use against the database is SELECT. The verification gate
 * strips comment lines and greps the remainder, case-insensitively, for any mutating SQL
 * keyword. An instrument that can mutate what it measures is not an instrument. Retention
 * for `candle_basis_shadow` lives in `nightly-carry-labeler.ts`; nothing here prunes.
 *
 * ── Output contract ──────────────────────────────────────────────────────────
 * Report to STDOUT. The verdict line is ALWAYS LAST and there is EXACTLY ONE of them, so a
 * wrapper can `tail -1` without parsing. Codes: 0=PASS(ready) / 1=FAIL(not ready) /
 * 3=INDETERMINATE(could not evaluate — unreadable config, DB unreachable). 3 is the
 * token-law default for a NEW gate; it is deliberately NOT aligned to check_test_baseline's
 * 2, which is 2 only because it already deployed that code for this meaning.
 *
 *   node dist/scripts/closedbar-recalibrate-readiness.js
 *   node dist/scripts/closedbar-recalibrate-readiness.js --self-test
 *   node dist/scripts/closedbar-recalibrate-readiness.js --candidate=41
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { dbQuery } from '../lib/performance-db.js';
import { runScript } from '../lib/script-lifecycle.js';

export const VERDICT_TOKEN = 'RECALIBRATE_READINESS_VERDICT';
export type Verdict = 'PASS' | 'FAIL' | 'INDETERMINATE';
export const EXIT_FOR: Record<Verdict, number> = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };

// ── config ───────────────────────────────────────────────────────────────────

export interface ThresholdRow { value: number; reason: string }
export interface ReadinessConfig {
  methodology_boundary: { start_utc: string; end_utc: string; status_md_path?: string };
  thresholds: Record<string, ThresholdRow>;
  per_timeframe_matured: Record<string, ThresholdRow | string>;
  atom_detection: { window: number; flat_ratio_max: number };
  accrual_stall: { hours: number };
  alerts: Record<string, Record<string, unknown>>;
}

export function configPath(): string {
  return process.env.RECALIBRATE_CONFIG
    ?? path.resolve(__dirname, '..', '..', 'ops', 'closedbar-recalibrate-config.json');
}

/** Throws on anything unreadable/malformed — the caller maps that to INDETERMINATE. */
export function loadConfig(p: string = configPath()): ReadinessConfig {
  const cfg = JSON.parse(readFileSync(p, 'utf8')) as ReadinessConfig;
  if (!cfg.thresholds || Object.keys(cfg.thresholds).length === 0) {
    throw new Error('config has no thresholds');
  }
  for (const [k, row] of Object.entries(cfg.thresholds)) {
    if (!row || typeof row.value !== 'number' || !row.reason) {
      throw new Error(`threshold ${k} missing value/reason`);
    }
  }
  return cfg;
}

// ── M2: the methodology boundary is an EXCLUSION, not a footnote ──────────────

export interface Boundary { startMs: number; endMs: number; source: string }

/**
 * The flip recorded its boundary as an INTERVAL — the >=2h engine measurement window sits
 * between the engine flip and the bot/seeder changes, so a single instant was never
 * achievable and signals emitted inside it carry MIXED methodology.
 *
 * Parsed from status.md at runtime rather than carried in, because the config's copy can
 * drift from the record. A parse miss falls back to the config and SAYS SO — it never
 * silently proceeds with no exclusion, which would quietly blend the two methodologies.
 */
export function parseBoundaryFromStatusMd(text: string): { start: string; end: string } | null {
  const m = text.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\s*→\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z|\d{2}:\d{2}:\d{2}Z)/);
  if (!m) return null;
  const start = m[1];
  // The record abbreviates the end when it shares the start's date: "10:16:12Z → 12:28:57Z".
  const end = m[2].length > 9 ? m[2] : `${start.slice(0, 10)}T${m[2]}`;
  return { start, end };
}

export function resolveBoundary(cfg: ReadinessConfig, statusMdText: string | null): Boundary {
  if (statusMdText) {
    const parsed = parseBoundaryFromStatusMd(statusMdText);
    if (parsed) {
      return { startMs: Date.parse(parsed.start), endMs: Date.parse(parsed.end), source: 'status.md' };
    }
  }
  return {
    startMs: Date.parse(cfg.methodology_boundary.start_utc),
    endMs: Date.parse(cfg.methodology_boundary.end_utc),
    source: 'config-fallback (status.md unreadable or unparseable)',
  };
}

// ── M3: atom-aware threshold search ──────────────────────────────────────────

export interface HistBin { value: number; count: number }
export interface AtomVerdict {
  flat: boolean;
  atomValue: number | null;
  atomCount: number;
  neighbourhoodMean: number;
  ratio: number;
  reason: string;
}

/**
 * A candidate threshold is a CLIFF EDGE when its neighbourhood contains a mass point.
 *
 * The score space is DISCRETE — fixed indicator ladders x fixed weights — so raw scores pile
 * into atoms and a threshold routinely lands on one. Measured on the live corpus: raw=41
 * carries ~10,748 rows and raw=-55 carries ~12,873, which is why |raw|>54 admits 13,152 rows
 * while |raw|>55 admits 281. A candidate can look like a 96.2% volume match and still be a
 * knife edge, which is exactly what happened to the flip's rejected T=41.
 *
 * Rejected iff any single value within +/-window holds more than flatRatioMax x the mean
 * count of that neighbourhood. The atom's SIZE is named in the reason — "rejected" without
 * the number is not actionable.
 */
export function assessCandidateFlatness(
  hist: HistBin[],
  candidate: number,
  window: number,
  flatRatioMax: number,
): AtomVerdict {
  const near = hist.filter((b) => Math.abs(b.value - candidate) <= window);
  if (near.length === 0) {
    return {
      flat: false, atomValue: null, atomCount: 0, neighbourhoodMean: 0, ratio: 0,
      reason: `no |raw| observations within +/-${window} of ${candidate} — cannot assert flatness over an empty neighbourhood`,
    };
  }
  const total = near.reduce((s, b) => s + b.count, 0);
  const mean = total / near.length;
  let peak = near[0];
  for (const b of near) if (b.count > peak.count) peak = b;
  const ratio = mean > 0 ? peak.count / mean : 0;
  const flat = ratio <= flatRatioMax;
  return {
    flat,
    atomValue: flat ? null : peak.value,
    atomCount: peak.count,
    neighbourhoodMean: Math.round(mean),
    ratio: Number(ratio.toFixed(2)),
    reason: flat
      ? `neighbourhood of ${candidate} (+/-${window}) is flat: peak ${peak.count} vs mean ${Math.round(mean)} = ${ratio.toFixed(2)}x <= ${flatRatioMax}x`
      : `REJECTED — mass point at raw=${peak.value} holds ${peak.count} rows vs neighbourhood mean ${Math.round(mean)} (${ratio.toFixed(2)}x > ${flatRatioMax}x). A threshold here is a cliff edge, not a calibration point.`,
  };
}

// ── M5: the readiness verdict — computed, never judged ───────────────────────

export interface ReadinessFacts {
  maturedTotal: number;
  distinctDays: number;
  perTf: Record<string, number>;
  perVenue: Record<string, number>;
  seededTfs: string[];
  promotedVenues: string[];
}
export interface Check { name: string; ok: boolean; measured: number; required: number; detail: string }

function tfFloor(cfg: ReadinessConfig, tf: string): number | null {
  const row = cfg.per_timeframe_matured[tf];
  if (!row || typeof row === 'string') return null;
  return row.value;
}

export function computeReadiness(facts: ReadinessFacts, cfg: ReadinessConfig): { verdict: Verdict; checks: Check[] } {
  const checks: Check[] = [];
  const need = (k: string) => cfg.thresholds[k].value;

  checks.push({
    name: 'matured_total', ok: facts.maturedTotal >= need('matured_total'),
    measured: facts.maturedTotal, required: need('matured_total'),
    detail: 'total matured post-boundary PFE outcomes',
  });
  checks.push({
    name: 'distinct_utc_days', ok: facts.distinctDays >= need('distinct_utc_days'),
    measured: facts.distinctDays, required: need('distinct_utc_days'),
    detail: 'distinct UTC days with matured post-boundary outcomes',
  });
  for (const tf of facts.seededTfs) {
    const req = tfFloor(cfg, tf);
    if (req === null) continue;   // a TF with no configured floor does not gate
    const got = facts.perTf[tf] ?? 0;
    checks.push({ name: `per_tf:${tf}`, ok: got >= req, measured: got, required: req, detail: `matured outcomes on ${tf}` });
  }
  for (const v of facts.promotedVenues) {
    const req = need('per_venue_matured');
    const got = facts.perVenue[v] ?? 0;
    checks.push({ name: `per_venue:${v}`, ok: got >= req, measured: got, required: req, detail: `matured outcomes on ${v}` });
  }
  // Vacuity: a corpus with no timeframes or no venues means we verified nothing about the
  // shape we exist to report. That is INDETERMINATE, never a pass.
  if (facts.seededTfs.length === 0 || facts.promotedVenues.length === 0) {
    return { verdict: 'INDETERMINATE', checks };
  }
  return { verdict: checks.every((c) => c.ok) ? 'PASS' : 'FAIL', checks };
}

// ── live report ──────────────────────────────────────────────────────────────

function readStatusMd(cfg: ReadinessConfig): string | null {
  try { return readFileSync(cfg.methodology_boundary.status_md_path ?? '', 'utf8'); }
  catch { return null; }
}

async function report(candidate: number | null): Promise<Verdict> {
  let cfg: ReadinessConfig;
  try { cfg = loadConfig(); }
  catch (e) {
    console.log(`config: UNREADABLE — ${(e as Error).message}`);
    return 'INDETERMINATE';
  }

  const b = resolveBoundary(cfg, readStatusMd(cfg));
  const startS = Math.floor(b.startMs / 1000), endS = Math.floor(b.endMs / 1000);
  console.log(`boundary: [${new Date(b.startMs).toISOString()} → ${new Date(b.endMs).toISOString()}] source=${b.source}`);

  const excluded = await dbQuery<{ n: string }>(
    'SELECT count(*) AS n FROM signals WHERE created_at >= $1 AND created_at <= $2', [startS, endS]);
  console.log(`excluded_boundary: ${excluded[0]?.n ?? 0} signals emitted INSIDE the interval — mixed methodology, omitted from every statistic below`);

  const totals = await dbQuery<{ emitted: string; matured: string; days: string }>(
    `SELECT count(*) AS emitted,
            count(*) FILTER (WHERE pfe_return_pct IS NOT NULL) AS matured,
            count(DISTINCT date_trunc('day', to_timestamp(created_at))) AS days
       FROM signals WHERE created_at > $1`, [endS]);
  const maturedTotal = Number(totals[0]?.matured ?? 0);
  const distinctDays = Number(totals[0]?.days ?? 0);
  console.log(`post_boundary: emitted=${totals[0]?.emitted ?? 0} matured=${maturedTotal} distinct_utc_days=${distinctDays}`);

  const tfRows = await dbQuery<{ timeframe: string; emitted: string; matured: string; wins: string }>(
    `SELECT timeframe, count(*) AS emitted,
            count(*) FILTER (WHERE pfe_return_pct IS NOT NULL) AS matured,
            count(*) FILTER (WHERE pfe_return_pct > 0) AS wins
       FROM signals WHERE created_at > $1 GROUP BY timeframe ORDER BY 2 DESC`, [endS]);
  console.log('per_tf:');
  const perTf: Record<string, number> = {};
  for (const r of tfRows) {
    perTf[r.timeframe] = Number(r.matured);
    const m = Number(r.matured), w = Number(r.wins);
    console.log(`  ${r.timeframe.padEnd(4)} emitted=${String(r.emitted).padStart(5)} matured=${String(m).padStart(5)} pfe_wr=${m ? ((100 * w) / m).toFixed(1) + '%' : 'n/a'}`);
  }

  const vRows = await dbQuery<{ exchange: string; emitted: string; matured: string; wins: string }>(
    `SELECT exchange, count(*) AS emitted,
            count(*) FILTER (WHERE pfe_return_pct IS NOT NULL) AS matured,
            count(*) FILTER (WHERE pfe_return_pct > 0) AS wins
       FROM signals WHERE created_at > $1 GROUP BY exchange ORDER BY 3 DESC`, [endS]);
  console.log('per_venue:');
  const perVenue: Record<string, number> = {};
  for (const r of vRows) {
    perVenue[r.exchange] = Number(r.matured);
    const m = Number(r.matured), w = Number(r.wins);
    console.log(`  ${r.exchange.padEnd(9)} emitted=${String(r.emitted).padStart(5)} matured=${String(m).padStart(5)} pfe_wr=${m ? ((100 * w) / m).toFixed(1) + '%' : 'n/a'}`);
  }

  // M4 — directional balance. The flip's contribution was DE-BIASING (mean(raw) -9.82 ->
  // -3.73 while mean|raw| FELL 21.15 -> 16.85), so the signature is a balance shift and a
  // WR-only view would miss it entirely.
  const bal = await dbQuery<{ era: string; buy: string; sell: string; buy_wins: string; sell_wins: string; buy_m: string; sell_m: string }>(
    `SELECT 'post' AS era,
            count(*) FILTER (WHERE signal='BUY') AS buy, count(*) FILTER (WHERE signal='SELL') AS sell,
            count(*) FILTER (WHERE signal='BUY'  AND pfe_return_pct > 0) AS buy_wins,
            count(*) FILTER (WHERE signal='SELL' AND pfe_return_pct > 0) AS sell_wins,
            count(*) FILTER (WHERE signal='BUY'  AND pfe_return_pct IS NOT NULL) AS buy_m,
            count(*) FILTER (WHERE signal='SELL' AND pfe_return_pct IS NOT NULL) AS sell_m
       FROM signals WHERE created_at > $1
     UNION ALL
     SELECT 'pre',
            count(*) FILTER (WHERE signal='BUY'), count(*) FILTER (WHERE signal='SELL'),
            count(*) FILTER (WHERE signal='BUY'  AND pfe_return_pct > 0),
            count(*) FILTER (WHERE signal='SELL' AND pfe_return_pct > 0),
            count(*) FILTER (WHERE signal='BUY'  AND pfe_return_pct IS NOT NULL),
            count(*) FILTER (WHERE signal='SELL' AND pfe_return_pct IS NOT NULL)
       FROM signals WHERE created_at < $2 AND created_at > $2 - 604800`, [endS, startS]);
  console.log('directional_balance:');
  for (const r of bal) {
    const buy = Number(r.buy), sell = Number(r.sell);
    const bm = Number(r.buy_m), sm = Number(r.sell_m);
    console.log(`  ${r.era.padEnd(4)} BUY=${buy} SELL=${sell} ratio=${sell ? (buy / sell).toFixed(1) : 'inf'}:1 ` +
      `buy_pfe_wr=${bm ? ((100 * Number(r.buy_wins)) / bm).toFixed(1) + '%' : 'n/a'} ` +
      `sell_pfe_wr=${sm ? ((100 * Number(r.sell_wins)) / sm).toFixed(1) + '%' : 'n/a'}`);
  }

  if (candidate !== null) {
    const hist = await dbQuery<{ value: string; count: string }>(
      `SELECT round(abs(raw_closed)) AS value, count(*) AS count
         FROM candle_basis_shadow
        WHERE tool='get_trade_call' AND raw_closed IS NOT NULL
          AND abs(raw_closed) BETWEEN $1 AND $2
        GROUP BY 1 ORDER BY 1`,
      [candidate - cfg.atom_detection.window, candidate + cfg.atom_detection.window]);
    const bins: HistBin[] = hist.map((h) => ({ value: Number(h.value), count: Number(h.count) }));
    console.log(`atom_check candidate=${candidate} local_histogram:`);
    for (const bn of bins) console.log(`  |raw|=${String(bn.value).padStart(4)}  ${String(bn.count).padStart(7)}`);
    const a = assessCandidateFlatness(bins, candidate, cfg.atom_detection.window, cfg.atom_detection.flat_ratio_max);
    console.log(`atom_check verdict: ${a.flat ? 'FLAT (usable)' : 'CLIFF EDGE'} — ${a.reason}`);
  }

  const seededTfs = tfRows.map((r) => r.timeframe);
  const promotedVenues = (await dbQuery<{ exchange_id: string }>(
    `SELECT exchange_id FROM venues WHERE status='promoted' ORDER BY 1`)).map((r) => r.exchange_id);
  const { verdict, checks } = computeReadiness(
    { maturedTotal, distinctDays, perTf, perVenue, seededTfs, promotedVenues }, cfg);

  console.log('checks:');
  for (const c of checks) {
    console.log(`  ${c.ok ? 'OK  ' : 'WAIT'} ${c.name.padEnd(22)} ${String(c.measured).padStart(6)} / ${String(c.required).padEnd(6)} — ${c.detail}`);
  }
  const blocking = checks.filter((c) => !c.ok);
  console.log(`summary: ${checks.length - blocking.length}/${checks.length} checks met` +
    (blocking.length ? `; still waiting on ${blocking.slice(0, 6).map((c) => c.name).join(', ')}${blocking.length > 6 ? ` (+${blocking.length - 6})` : ''}` : ''));
  return verdict;
}

// ── self-test: hermetic, vacuity-guarded, two-way ────────────────────────────

function selfTest(): number {
  let fire = 0, nofire = 0, map = 0, fail = 0;
  const check = (label: string, want: unknown, got: unknown) => {
    const ok = JSON.stringify(want) === JSON.stringify(got);
    if (!ok) { fail++; console.log(`  FAIL ${label}\n    want=${JSON.stringify(want)}\n    got =${JSON.stringify(got)}`); }
  };
  const cfg = loadConfig();

  // ── M3: the two MEASURED atoms. If it does not reject both, it does not work.
  const atom41: HistBin[] = [
    { value: 38, count: 520 }, { value: 39, count: 610 }, { value: 40, count: 1282 },
    { value: 41, count: 10748 }, { value: 42, count: 977 }, { value: 43, count: 640 },
  ];
  const a41 = assessCandidateFlatness(atom41, 41, cfg.atom_detection.window, cfg.atom_detection.flat_ratio_max);
  fire++; check('atom raw=41 REJECTED', false, a41.flat);
  map++;  check('atom raw=41 names the value', 41, a41.atomValue);
  map++;  check('atom raw=41 names the size', 10748, a41.atomCount);

  const atom55: HistBin[] = [
    { value: 52, count: 300 }, { value: 53, count: 61 }, { value: 54, count: 104 },
    { value: 55, count: 12873 }, { value: 56, count: 117 }, { value: 57, count: 90 },
  ];
  const a55 = assessCandidateFlatness(atom55, 55, cfg.atom_detection.window, cfg.atom_detection.flat_ratio_max);
  fire++; check('atom raw=-55 REJECTED', false, a55.flat);
  map++;  check('atom raw=-55 names the size', 12873, a55.atomCount);

  // must-not-fire: a genuinely flat neighbourhood must be USABLE, or the check is a blanket no.
  const flat: HistBin[] = [70, 71, 72, 73, 74, 75].map((v) => ({ value: v, count: 500 + v }));
  nofire++; check('flat neighbourhood ACCEPTED', true, assessCandidateFlatness(flat, 72, 6, 3).flat);

  // vacuity: an EMPTY histogram must never report flat — we verified nothing.
  nofire++; check('empty neighbourhood is NOT flat', false, assessCandidateFlatness([], 41, 6, 3).flat);

  // ── M2: boundary parsing, including the abbreviated end the record actually uses.
  map++; check('boundary parsed from the record shape',
    { start: '2026-08-07T10:16:12Z', end: '2026-08-07T12:28:57Z' },
    parseBoundaryFromStatusMd('… boundary: `[2026-08-07T10:16:12Z → 12:28:57Z]` …'));
  map++; check('unparseable status.md yields null', null, parseBoundaryFromStatusMd('no interval here'));
  map++; check('config fallback is LABELLED, never silent', true,
    resolveBoundary(cfg, 'nothing').source.startsWith('config-fallback'));

  // ── M5: verdict + the token->exit-code MAPPING (asserting the token alone is not enough;
  // a sibling gate in this arc passed while its INDETERMINATE mapping had been re-coded to 0).
  map++; check('PASS maps to 0', 0, EXIT_FOR.PASS);
  map++; check('FAIL maps to 1', 1, EXIT_FOR.FAIL);
  map++; check('INDETERMINATE maps to 3', 3, EXIT_FOR.INDETERMINATE);

  const ready: ReadinessFacts = {
    maturedTotal: 999999, distinctDays: 99,
    perTf: Object.fromEntries(Object.keys(cfg.per_timeframe_matured).filter((k) => k !== '_reason').map((k) => [k, 999999])),
    perVenue: { HL: 999999, BINANCE: 999999 },
    seededTfs: Object.keys(cfg.per_timeframe_matured).filter((k) => k !== '_reason'),
    promotedVenues: ['HL', 'BINANCE'],
  };
  nofire++; check('fully-accrued corpus => PASS', 'PASS', computeReadiness(ready, cfg).verdict);
  fire++;   check('one short timeframe => FAIL', 'FAIL',
    computeReadiness({ ...ready, perTf: { ...ready.perTf, '1d': 0 } }, cfg).verdict);
  fire++;   check('one short venue => FAIL', 'FAIL',
    computeReadiness({ ...ready, perVenue: { HL: 999999, BINANCE: 0 } }, cfg).verdict);
  fire++;   check('too few distinct days => FAIL', 'FAIL', computeReadiness({ ...ready, distinctDays: 1 }, cfg).verdict);
  // VACUITY at runtime: an empty TF or venue set means we verified nothing about the very
  // shape this harness exists to report. INDETERMINATE, never a pass.
  fire++;   check('no timeframes => INDETERMINATE', 'INDETERMINATE', computeReadiness({ ...ready, seededTfs: [] }, cfg).verdict);
  fire++;   check('no venues => INDETERMINATE', 'INDETERMINATE', computeReadiness({ ...ready, promotedVenues: [] }, cfg).verdict);

  // ── config integrity: every threshold row carries a reason (the gate greps for this too).
  map++; check('every threshold row has a reason', true,
    Object.values(cfg.thresholds).every((r) => Boolean(r.reason)));
  map++; check('every per-TF floor has a reason', true,
    Object.entries(cfg.per_timeframe_matured).filter(([k]) => k !== '_reason')
      .every(([, r]) => typeof r !== 'string' && Boolean(r.reason)));

  if (fire === 0 || nofire === 0 || map === 0) {
    console.log(`self-test VACUOUS: ${fire} must-fire, ${nofire} must-not-fire, ${map} must-map`);
    return 1;
  }
  if (fail > 0) {
    console.log(`self-test failed: ${fail} failure(s) across ${fire} must-fire, ${nofire} must-not-fire, ${map} must-map`);
    return 1;
  }
  console.log(`self-test passed: ${fire} must-fire, ${nofire} must-not-fire, ${map} must-map (${fire + nofire + map} assertions)`);
  return 0;
}

// ── entrypoint ───────────────────────────────────────────────────────────────

/**
 * Returns the EXIT CODE, and that is load-bearing rather than stylistic: `runScript` exits
 * with `main`'s numeric return value and IGNORES `process.exitCode`. An earlier revision set
 * `process.exitCode` instead, so every self-test failure printed "self-test failed" and then
 * exited 0 — a green exit over a broken gate, which is exactly the verdict-token violation
 * this repo forbids. It was caught by RED-verify, not by review.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.includes('--self-test')) {
    const rc = selfTest();
    process.stdout.write(`${VERDICT_TOKEN}=${rc === 0 ? 'PASS' : 'FAIL'}\n`);
    return rc === 0 ? EXIT_FOR.PASS : EXIT_FOR.FAIL;
  }
  const cArg = argv.find((a) => a.startsWith('--candidate='));
  const candidate = cArg ? Number(cArg.split('=')[1]) : null;

  let verdict: Verdict;
  try {
    verdict = await report(Number.isFinite(candidate as number) ? (candidate as number) : null);
  } catch (e) {
    // Fail CLOSED: an unreachable DB or a malformed row means we could not evaluate, which is
    // never a pass and never a plain failure either.
    console.log(`evaluation error — ${(e as Error).message.slice(0, 200)}`);
    verdict = 'INDETERMINATE';
  }
  process.stdout.write(`${VERDICT_TOKEN}=${verdict}\n`);
  return EXIT_FOR[verdict];
}

if (require.main === module) {
  void runScript('closedbar-recalibrate-readiness', () => main());
}
