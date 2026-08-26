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
import { readFileSync as realReadFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  buildEnvelope,
  isConforming,
  loadSchema,
  validateEnvelope,
  schemaPath,
  EMBEDDED_SCHEMA,
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

  // The budget must sit in the OPTIONS ARG, not as a trailing number: check-test-budget.mjs
  // reads `timeout:` out of the text BEFORE the callback, so `it(name, fn, 20_000)` declares
  // nothing as far as the gate is concerned and the block silently inherits the 5,000ms default.
  it('both sides read the SAME schema file — one SoT, not two copies', { timeout: 20_000 }, () => {
    expect(schemaPath()).toBe(path.join(REPO, 'ops/monitoring/detector-envelope.schema.json'));
    const r = spawnSync('python3', ['-c', [
      'import sys,json',
      `sys.path.insert(0, ${JSON.stringify(path.dirname(PY))})`,
      'import detector_envelope as d',
      'print(str(d.SCHEMA_PATH))',
    ].join('\n')], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(path.resolve(r.stdout.trim())).toBe(path.resolve(schemaPath()));
  });

  it('the Python consumer self-test passes and prints its token', { timeout: 20_000 }, () => {
    const r = spawnSync('python3', [PY, '--self-test'], { encoding: 'utf8' });
    expect(r.stdout).toContain('DETECTOR_ENVELOPE_VERDICT=PASS');
    expect(r.status).toBe(0);
  });
});

describe('DETECTOR_ENVELOPE — a schema it cannot read is INDETERMINATE, not permissive', () => {
  it('throws rather than defaulting to "allow everything"', () => {
    expect(() => loadSchema('/nonexistent/detector-envelope.schema.json')).toThrow();
  });
});

/**
 * OPS-DETECTOR-ENVELOPE-RUNTIME-W1 — THE PIN.
 *
 * `/app/ops` does not exist in the runtime image, so `loadSchema()` falls back to
 * `EMBEDDED_SCHEMA` there. That is only defensible while the mirror IS the SoT rather than a
 * second opinion about it, and prose cannot hold that — this block is the control. It runs in CI
 * and in the pre-push gate, so a schema edit that is not mirrored cannot be pushed at all, which
 * is a stronger guarantee than the rebuild trigger a `Dockerfile` COPY would have needed (and
 * which GitHub Actions cannot express surgically: `!` negation is valid only in `paths`, and
 * `paths` and `paths-ignore` cannot be combined for one event).
 */
describe('DETECTOR_ENVELOPE — the embedded mirror is pinned to the SoT, field for field', () => {
  const sot = JSON.parse(realReadFileSync(schemaPath(), 'utf8')) as Record<string, unknown>;
  /** Contract keys only — `_comment` / `_generator` / `_*_doc` are documentation, not contract. */
  const contractKeys = Object.keys(sot).filter((k) => !k.startsWith('_'));

  it('carries EXACTLY the SoT contract keys — no more, and critically no fewer', () => {
    // The "fewer" half is the one that matters: a wave adding a field to the JSON and not here
    // would otherwise leave the container silently validating against the older contract.
    expect([...Object.keys(EMBEDDED_SCHEMA)].sort()).toEqual([...contractKeys].sort());
  });

  it.each(
    Object.keys(JSON.parse(realReadFileSync(schemaPath(), 'utf8')) as Record<string, unknown>)
      .filter((k) => !k.startsWith('_')),
  )('mirrors the SoT value of %s', (key) => {
    expect((EMBEDDED_SCHEMA as unknown as Record<string, unknown>)[key]).toEqual(sot[key]);
  });

  // PROVE THE PIN CAN FAIL. An assertion nobody has watched go red is a decoration; this walks a
  // deliberately-mutated mirror through the same comparison the block above runs.
  it('the pin is not vacuous — a mutated mirror is rejected by both halves', () => {
    const drifted = { ...EMBEDDED_SCHEMA, max_age_seconds: 999 } as unknown as Record<string, unknown>;
    expect(drifted.max_age_seconds).not.toEqual(sot.max_age_seconds);

    const truncated = { ...EMBEDDED_SCHEMA } as unknown as Record<string, unknown>;
    delete truncated.observation_window_fields;
    expect([...Object.keys(truncated)].sort()).not.toEqual([...contractKeys].sort());
  });

  it('is frozen, so no consumer can mutate the contract for every later caller', () => {
    expect(Object.isFrozen(EMBEDDED_SCHEMA)).toBe(true);
  });
});

/**
 * THE CONTAINER CONDITION, PINNED AS A FACT.
 *
 * The mirror exists because `/app/ops` does not. That is a property of the Dockerfile, not of
 * anyone's memory of it, so it is asserted here — anchored on a line-start `COPY` so this very
 * comment cannot satisfy the grep (the recorded false-positive shape, see the Dockerfile's own
 * note about the retired `COPY ops/closedbar-recalibrate-config.json`).
 */
describe('DETECTOR_ENVELOPE — the runtime image really has no ops/ tree', () => {
  it('the Dockerfile COPYs no ops/ path, which is why the SoT cannot be read in prod', () => {
    const dockerfile = realReadFileSync(path.join(REPO, 'Dockerfile'), 'utf8');
    const copies = dockerfile.split('\n').filter((l) => /^COPY\s+ops\//.test(l));
    expect(copies).toEqual([]);
  });

  it('and the SoT path is inside that absent tree', () => {
    expect(path.relative(REPO, schemaPath()).startsWith('ops/')).toBe(true);
  });
});

/**
 * The DEFAULT-path fallback, exercised.
 *
 * The seam replaces NODE'S FILESYSTEM and nothing of ours: the catch, the errno discrimination,
 * the one-shot announcement and the mirror substitution are all real code running here. Kept LAST
 * in the file and torn down explicitly, because a `doMock` leaks forward across describe blocks.
 */
describe('DETECTOR_ENVELOPE — an absent SoT is answered by the mirror, loudly', () => {
  const REAL = schemaPath();

  async function withFsThatFails(
    fail: (f: string) => Error | string,
    fn: (m: typeof import('../../src/lib/detector-envelope.js')) => void | Promise<void>,
  ): Promise<void> {
    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        readFileSync: (f: unknown, ...rest: unknown[]) => {
          if (typeof f === 'string' && path.resolve(f) === path.resolve(REAL)) {
            const r = fail(f);
            if (r instanceof Error) throw r;
            return r;
          }
          return (actual.readFileSync as unknown as (...a: unknown[]) => unknown)(f, ...rest);
        },
      };
    });
    try {
      const mod = await import('../../src/lib/detector-envelope.js');
      mod._resetSchemaCacheForTest();
      await fn(mod);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  }

  const enoent = (f: string): Error => {
    const e = new Error(`ENOENT: no such file or directory, open '${f}'`) as NodeJS.ErrnoException;
    e.code = 'ENOENT';
    return e;
  };

  it('substitutes the mirror, says so once, and still builds a CONFORMING envelope', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await withFsThatFails(enoent, (m) => {
        expect(m.loadSchema()).toEqual(m.EMBEDDED_SCHEMA);
        // Silence here would be the dark-guard shape: a substitution nobody can see in a log.
        expect(spy.mock.calls.flat().join(' ')).toContain('using the embedded mirror');
        // Announced ONCE per process, not once per call — the cache makes the second call free.
        const before = spy.mock.calls.length;
        m.loadSchema();
        expect(spy.mock.calls.length).toBe(before);

        const env = m.buildEnvelope({ ...INCIDENT, runOutcome: 'complete', verdict: 'FAIL' });
        expect(m.isConforming(env)).toBe(true);
        expect(env.verdict).toBe('FAIL');
        // And the forcing rule survives the substitution — this is the whole point of the module.
        expect(m.buildEnvelope({ ...INCIDENT, verdict: 'FAIL' }).verdict).toBe('INDETERMINATE');
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('a MALFORMED SoT still THROWS — only ABSENCE is answered by the mirror', async () => {
    await withFsThatFails(() => '{ this is not json', (m) => {
      expect(() => m.loadSchema()).toThrow();
    });
  });

  it('a non-ENOENT read failure still THROWS rather than being papered over', async () => {
    await withFsThatFails((f) => {
      const e = new Error(`EACCES: permission denied, open '${f}'`) as NodeJS.ErrnoException;
      e.code = 'EACCES';
      return e;
    }, (m) => {
      expect(() => m.loadSchema()).toThrow(/EACCES/);
    });
  });
});
