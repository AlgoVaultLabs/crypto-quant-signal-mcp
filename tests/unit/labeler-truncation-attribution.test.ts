/**
 * OPS-DEPLOY-LABELER-WINDOW-W1 CH1 — truncation attribution, both directions.
 *
 * The wave's premise was CORRECTED at Step 0: the SIGTERM is not collateral damage from a
 * container recreate, it is a DELIBERATE preemption at `.github/workflows/deploy.yml:892`,
 * shipped by OPS-LABEL-FRESHNESS-W1 R2 and documented in `graceful-stop.ts`. So attribution is
 * near-certain rather than inferential — and the thing that was actually missing is that nobody
 * COUNTED what the policy cost.
 *
 * Two-way is the whole point here: a truncated fixture must attribute and yield INDETERMINATE, a
 * COMPLETE fixture must produce no truncation record at all, and an unattributable truncation
 * must be labelled unattributable rather than assigned to a deploy on suspicion. The prior wave
 * published a correlation with no base rate; this suite exists so that cannot happen again in
 * code.
 *
 * SPAWN BUDGET DECLARED on every block — each drives the real Python detector via python3.
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(__dirname, '../..');
const PY = path.join(REPO, 'ops/monitoring/labeler_truncation_attribution.py');
const PYDIR = path.dirname(PY);

/** Drive one exported function of the detector and return its JSON result. */
function call(expr: string): unknown {
  const driver = [
    'import importlib.util, json, sys',
    `sys.path.insert(0, ${JSON.stringify(PYDIR)})`,
    `spec = importlib.util.spec_from_file_location('lta', ${JSON.stringify(PY)})`,
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    'import detector_envelope as de',
    `print(json.dumps(${expr}))`,
  ].join('\n');
  const r = spawnSync('python3', ['-c', driver], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`driver failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop() as string);
}

/** The real 2026-08-22 run, reduced to its load-bearing lines. */
const TRUNCATED = [
  '[2026-08-22T02:33:26.139Z] DWR backfill start — 13499 groups over 17 venues (rotation: EDGEX>BITMART) specs=[x] lookback=21d budget=210m/venue<=45m',
  '[venue-summary] EDGEX: groups 7/7 outcome=complete elapsed=0s',
  '[venue-summary] BITMART: groups 63/110 outcome=venue-circuit-break elapsed=522s',
  '[venue-summary] OKX: groups 438/438 outcome=complete elapsed=455s',
  '[venue-summary] HL: groups 214/335 outcome=stopped elapsed=1819s',
  '[graceful-stop] stop requested (SIGTERM) — checkpointing at the next venue/group boundary',
  '[graceful-stop] checkpointed at the HL boundary — remaining venues resume from DB state next run',
  '[2026-08-22T03:20:01.165Z] DONE {"groups":722}',
].join('\n');

const COMPLETE = TRUNCATED
  .split('\n')
  .filter((l) => !l.startsWith('[graceful-stop]'))
  .join('\n');

/** The measured container start from that night: 03:20:24Z, 22.8s after DONE. */
const STARTS = ['2026-08-22T03:20:24+00:00'];
const J = JSON.stringify;

describe('CH1 — a truncated run attributes, and can never be a capacity finding', () => {
  it('detects the truncation and forces INDETERMINATE', { timeout: 30_000 }, () => {
    const env = call(`m.build(m.parse_runs(${J(TRUNCATED)}), ${J(STARTS)}, "2026-08-22T09:00:00Z")`) as Record<string, unknown>;
    expect(env.run_outcome).toBe('stopped');
    expect(env.verdict).toBe('INDETERMINATE');
    // The contract's whole purpose, asserted here rather than assumed.
    expect(env.verdict).not.toBe('FAIL');
  });

  it('attributes to the deploy with a MEASURED delta, not a sentence', { timeout: 30_000 }, () => {
    const env = call(`m.build(m.parse_runs(${J(TRUNCATED)}), ${J(STARTS)}, "2026-08-22T09:00:00Z")`) as any;
    expect(env.evidence.attributed_cause).toBe('deploy-preemption');
    expect(env.evidence.attribution_delta_s).toBe(22);
    expect(env.evidence.attributed_container_start_at).toBe('2026-08-22T03:20:24+00:00');
  });

  it('emits a CONFORMING envelope — the contract is consumed as shipped', { timeout: 30_000 }, () => {
    const errs = call(`de.validate(m.build(m.parse_runs(${J(TRUNCATED)}), ${J(STARTS)}, "2026-08-22T09:00:00Z"), de.load_schema())`);
    expect(errs).toEqual([]);
  });
});

describe('CH1 — a COMPLETE run produces no truncation record at all', () => {
  it('is not truncated, and is PASS', { timeout: 30_000 }, () => {
    const env = call(`m.build(m.parse_runs(${J(COMPLETE)}), ${J(STARTS)}, "2026-08-22T09:00:00Z")`) as any;
    expect(env.run_outcome).toBe('complete');
    expect(env.verdict).toBe('PASS');
    expect(env.evidence.truncation_rate_pct).toBe(0.0);
    expect(env.evidence.attributed_cause).toBe('not-truncated');
  });

  it('is never attributed to a deploy even when a container start is right there', { timeout: 30_000 }, () => {
    const att = call(`m.attribute(m.parse_runs(${J(COMPLETE)})[0], ${J(STARTS)})`) as any;
    expect(att.cause).toBe('not-truncated');
    expect(att.delta_s).toBeNull();
  });
});

describe('CH1 — unattributable is a real answer, never upgraded to a guess', () => {
  it('a truncation with no container start nearby is unattributable-no-recreate', { timeout: 30_000 }, () => {
    const att = call(`m.attribute(m.parse_runs(${J(TRUNCATED)})[0], ${J(['2026-08-22T09:00:00+00:00'])})`) as any;
    expect(att.cause).toBe('unattributable-no-recreate');
    expect(att.cause).not.toBe('deploy-preemption');
  });

  it('NO journal coverage is a DIFFERENT answer from "no deploy"', { timeout: 30_000 }, () => {
    // The two mean opposite things: one says we looked and found nothing, the other says we
    // could not look. Collapsing them is the base-rate error one level up — exactly the mistake
    // the prior wave's "10/10" figure made.
    const noRecords = call(`m.attribute(m.parse_runs(${J(TRUNCATED)})[0], [])`) as any;
    expect(noRecords.cause).toBe('unattributable-no-journal');
    const predates = call(`m.attribute(m.parse_runs(${J(TRUNCATED)})[0], ${J(STARTS)}, 900, "2026-08-23T00:00:00Z")`) as any;
    expect(predates.cause).toBe('unattributable-no-journal');
  });
});

describe('CH1 — the RATE is the finding, not the event', () => {
  it('computes truncation rate and attributed share over the window', { timeout: 30_000 }, () => {
    const two = `${COMPLETE}\n${TRUNCATED.replace(/2026-08-22/g, '2026-08-23')}`;
    const s = call(`m.summarise(m.parse_runs(${J(two)}), ${J(['2026-08-23T03:20:24+00:00'])})`) as any;
    expect(s.n).toBe(2);
    expect(s.truncated).toBe(1);
    expect(s.truncation_rate_pct).toBe(50.0);
    expect(s.attributed_to_deploy).toBe(1);
    expect(s.attributed_share_pct).toBe(100.0);
  });

  it('a parser that finds ZERO runs is INDETERMINATE, never a clean rate', { timeout: 30_000 }, () => {
    // Vacuity guard: an empty corpus means the parser broke, not that the labeler stopped.
    const runs = call(`m.parse_runs("nothing here")`) as unknown[];
    expect(runs).toEqual([]);
    const r = spawnSync('python3', [PY], {
      encoding: 'utf8',
      env: { ...process.env, LTA_LABELER_LOG: '/nonexistent/carry-labeler.log' },
    });
    expect(r.stdout).toContain('DETECTOR_ENVELOPE_VERDICT=INDETERMINATE');
    expect(r.status).toBe(3);
  });
});

describe('CH1 — the detector self-test passes where it lives', () => {
  it('prints its token', { timeout: 30_000 }, () => {
    const r = spawnSync('python3', [PY, '--self-test'], { encoding: 'utf8' });
    expect(r.stdout).toContain('DETECTOR_ENVELOPE_VERDICT=PASS');
    expect(r.status).toBe(0);
  });
});
