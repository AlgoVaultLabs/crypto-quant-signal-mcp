/**
 * OPS-MONITORING-SIGNAL-CONTRACT-W1 CH2 — the DETECTOR_ENVELOPE contract, both sides.
 *
 * AC2.1 is "validated from BOTH TS and Python; neither side can emit a non-conforming signal",
 * and the only way to assert that honestly is to run BOTH implementations over ONE fixture set
 * and require identical answers. Two validators that were merely each tested alone would drift
 * into disagreeing about the same bytes, and the disagreement would surface as a production page
 * that one side thinks is fine.
 *
 * SPAWN BUDGET DECLARED — and unlike CH1's census test, this one earns it: the cross-language
 * block shells out to `python3`. `scripts/check-test-budget.mjs` flags spawning blocks only, so
 * the budget goes on the blocks that spawn and nowhere else. (Ratified 2026-08-22 Q4.)
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import {
  buildEnvelope,
  isConforming,
  loadSchema,
  validateEnvelope,
  schemaPath,
  _resetSchemaCacheForTest,
  type DetectorEnvelope,
} from '../../src/lib/detector-envelope.js';

const REPO = path.resolve(__dirname, '../..');
const PY = path.join(REPO, 'ops/monitoring/detector_envelope.py');

/** The 2026-08-22 incident, as data. `stopped`, 46.6 of 210 minutes, 4 of 17 venues reached. */
const INCIDENT = {
  detector: 'directional-label-capacity',
  runId: 'dwr-2026-08-22T02:33:26Z',
  runStartedAt: '2026-08-22T02:33:26Z',
  runOutcome: 'stopped',
  producedAt: '2026-08-22T03:20:01Z',
  observationWindow: { from: '2026-08-22T02:33:26Z', to: '2026-08-22T03:20:01Z' },
  evidence: {
    unreached_in_danger: 'BINANCE,BITGET,BYBIT',
    venues_reached: 4,
    venues_total: 17,
    elapsed_min: 46.6,
    budget_min: 210,
  },
};

beforeEach(() => { _resetSchemaCacheForTest(); });

describe('DETECTOR_ENVELOPE — the producer cannot state a conclusion its run did not reach', () => {
  it('forces INDETERMINATE when the run outcome is not conclusive, even if the caller says FAIL', () => {
    const env = buildEnvelope({ ...INCIDENT, verdict: 'FAIL' });
    expect(env.verdict).toBe('INDETERMINATE');
    // The truncation is not hidden — only the unearned conclusion is removed.
    expect(env.run_outcome).toBe('stopped');
    expect(env.evidence.venues_reached).toBe(4);
  });

  it('defaults an omitted verdict to INDETERMINATE, never to PASS', () => {
    const env = buildEnvelope({ ...INCIDENT, runOutcome: 'complete' });
    expect(env.verdict).toBe('INDETERMINATE');
  });

  it('lets a genuinely-complete run keep its FAIL — the fix must not silence real shortfalls', () => {
    const env = buildEnvelope({ ...INCIDENT, runOutcome: 'global-budget', verdict: 'FAIL' });
    expect(env.verdict).toBe('FAIL');
  });

  it('rejects a hand-rolled envelope that smuggles a conclusion past buildEnvelope', () => {
    const smuggled = { ...buildEnvelope({ ...INCIDENT }), verdict: 'FAIL' as const };
    const errs = validateEnvelope(smuggled);
    expect(errs.join(' ')).toContain('is not conclusive');
  });
});

describe('DETECTOR_ENVELOPE — evidence carries measurements, never mechanism prose', () => {
  it('rejects the exact D2 sentence when it arrives through evidence', () => {
    const env = buildEnvelope({
      ...INCIDENT,
      evidence: { note: 'SLO-ordered, so majors were served first; the shortfall is the long-tail overflow' },
    });
    expect(isConforming(env)).toBe(false);
    expect(validateEnvelope(env).join(' ')).toContain('prose about mechanism');
  });

  it('accepts short scalar values and an empty-ish string', () => {
    expect(isConforming(buildEnvelope({ ...INCIDENT, evidence: { lag_h: 27.9, venue: 'BINANCE' } }))).toBe(true);
  });

  it('rejects an evidence object with no keys at all', () => {
    expect(isConforming(buildEnvelope({ ...INCIDENT, evidence: {} }))).toBe(false);
  });
});

describe('DETECTOR_ENVELOPE — required shape', () => {
  const full = () => buildEnvelope({ ...INCIDENT }) as unknown as Record<string, unknown>;

  /**
   * PINNED LITERALLY, NOT READ FROM THE SCHEMA. The first version of this block iterated
   * `loadSchema().required_fields`, so deleting a field from the schema simply stopped the test
   * checking it — the assertion derived its expectation from the thing it was supposed to pin,
   * and a mutation dropping `run_id` left the whole suite GREEN. Caught by the prove-it-can-fail
   * step, which is the entire reason that step exists.
   */
  const REQUIRED = [
    'schema_version', 'detector', 'verdict', 'run_id', 'run_started_at',
    'run_outcome', 'produced_at', 'observation_window', 'evidence',
  ];

  it('the schema requires EXACTLY these fields — the set itself is the contract', () => {
    expect([...loadSchema().required_fields].sort()).toEqual([...REQUIRED].sort());
  });

  it('names every missing required field', () => {
    for (const f of REQUIRED) {
      const partial = full();
      delete partial[f];
      expect(validateEnvelope(partial).join(' ')).toContain(`missing required field '${f}'`);
    }
  });

  it('rejects a non-object and a wrong schema_version', () => {
    expect(validateEnvelope(null).length).toBeGreaterThan(0);
    expect(validateEnvelope([]).length).toBeGreaterThan(0);
    expect(validateEnvelope({ ...full(), schema_version: 99 }).join(' ')).toContain('schema_version 99');
  });

  it('requires both observation_window bounds', () => {
    const e = full();
    e.observation_window = { from: '2026-08-22T02:33:26Z' };
    expect(validateEnvelope(e).join(' ')).toContain("observation_window missing 'to'");
  });
});

describe('DETECTOR_ENVELOPE — the TS and Python validators agree, byte for byte', () => {
  /** Ask the Python side to validate the same JSON and report conformance. */
  function pyValidate(env: unknown): { ok: boolean; errs: string[] } {
    const code = [
      'import json,sys',
      `sys.path.insert(0, ${JSON.stringify(path.dirname(PY))})`,
      'import detector_envelope as d',
      'env=json.load(sys.stdin)',
      'print(json.dumps(d.validate(env, d.load_schema())))',
    ].join('\n');
    const r = spawnSync('python3', ['-c', code], { input: JSON.stringify(env), encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`python3 failed: ${r.stderr}`);
    const errs = JSON.parse(r.stdout.trim());
    return { ok: errs.length === 0, errs };
  }

  const CASES: Array<[string, unknown]> = [
    ['conforming', buildEnvelope({ ...INCIDENT, runOutcome: 'complete', verdict: 'FAIL' })],
    ['stopped forced to INDETERMINATE', buildEnvelope({ ...INCIDENT, verdict: 'FAIL' })],
    ['smuggled conclusion', { ...buildEnvelope({ ...INCIDENT }), verdict: 'FAIL' }],
    ['mechanism prose in evidence', buildEnvelope({ ...INCIDENT, evidence: { note: 'SLO-ordered, so majors were served first; the shortfall is the long-tail overflow' } })],
    ['empty evidence', buildEnvelope({ ...INCIDENT, evidence: {} })],
    ['undeclared run_outcome', { ...buildEnvelope({ ...INCIDENT }), run_outcome: 'exploded' }],
    ['bad verdict value', { ...buildEnvelope({ ...INCIDENT }), verdict: 'MAYBE' }],
    ['not an object', 'nope'],
    ['missing a required field', (() => { const e = buildEnvelope({ ...INCIDENT }) as unknown as Record<string, unknown>; delete e.run_id; return e; })()],
  ];

  it.each(CASES)('both sides return the same conformance for: %s', (_label, env) => {
    const ts = isConforming(env);
    const py = pyValidate(env);
    expect(py.ok).toBe(ts);
    // Every spawning block in this file needs its own budget; the 5,000ms default is calibrated
    // for pure-function assertions and a cold python3 start blows it on a loaded CI runner.
  }, 20_000);

  it('both sides read the SAME schema file — one SoT, not two copies', () => {
    expect(schemaPath()).toBe(path.join(REPO, 'ops/monitoring/detector-envelope.schema.json'));
    const r = spawnSync('python3', ['-c', [
      'import sys,json',
      `sys.path.insert(0, ${JSON.stringify(path.dirname(PY))})`,
      'import detector_envelope as d',
      'print(str(d.SCHEMA_PATH))',
    ].join('\n')], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(path.resolve(r.stdout.trim())).toBe(path.resolve(schemaPath()));
  }, 20_000);

  it('the Python consumer self-test passes and prints its token', () => {
    const r = spawnSync('python3', [PY, '--self-test'], { encoding: 'utf8' });
    expect(r.stdout).toContain('DETECTOR_ENVELOPE_VERDICT=PASS');
    expect(r.status).toBe(0);
  }, 20_000);
});

describe('DETECTOR_ENVELOPE — a schema it cannot read is INDETERMINATE, not permissive', () => {
  it('throws rather than defaulting to "allow everything"', () => {
    expect(() => loadSchema('/nonexistent/detector-envelope.schema.json')).toThrow();
  });
});

describe('DETECTOR_ENVELOPE — the incident replay, as the regression anchor', () => {
  it('the 2026-08-22 run cannot produce a capacity verdict', () => {
    const env: DetectorEnvelope = buildEnvelope({ ...INCIDENT, verdict: 'FAIL' });
    expect(env.verdict).toBe('INDETERMINATE');
    expect(isConforming(env)).toBe(true);
    // est_venue_min_short=26 may still be REPORTED — it is a measurement. What it may no longer
    // do is arrive labelled as a structural capacity conclusion.
    const withNumber = buildEnvelope({ ...INCIDENT, verdict: 'FAIL', evidence: { ...INCIDENT.evidence, est_venue_min_short: 26 } });
    expect(withNumber.verdict).toBe('INDETERMINATE');
    expect(withNumber.evidence.est_venue_min_short).toBe(26);
  });
});
