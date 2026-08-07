/**
 * OPS-CLOSEDBAR-RECALIBRATE-READINESS-W1 — unit tests for the readiness instrument.
 *
 * These pin the three properties the flip's Step 0 had to reconstruct by hand, because a
 * harness that loses any of them puts the recalibration wave back to improvising:
 *   - the atom check REJECTS a candidate adjacent to a mass point (F5)
 *   - every statistic is sliced per-venue as well as per-timeframe (F2)
 *   - the methodology boundary is EXCLUDED, and a parse miss is labelled, never silent (M2)
 */
import { describe, it, expect } from 'vitest';
import {
  assessCandidateFlatness,
  parseBoundaryFromStatusMd,
  resolveBoundary,
  computeReadiness,
  loadConfig,
  EXIT_FOR,
  VERDICT_TOKEN,
  type HistBin,
  type ReadinessFacts,
} from '../../src/scripts/closedbar-recalibrate-readiness.js';

const cfg = loadConfig();
const TFS = Object.keys(cfg.per_timeframe_matured).filter((k) => k !== '_reason');

const fullyAccrued = (): ReadinessFacts => ({
  maturedTotal: 999_999,
  distinctDays: 99,
  perTf: Object.fromEntries(TFS.map((t) => [t, 999_999])),
  perVenue: { HL: 999_999, BINANCE: 999_999 },
  seededTfs: TFS,
  promotedVenues: ['HL', 'BINANCE'],
});

describe('atom-aware threshold search (F5)', () => {
  // The two atoms MEASURED on the live corpus. If the check does not reject both, it does
  // not work — this is an acceptance criterion of the wave, not a nice-to-have.
  it('rejects raw=41 and names the atom size (~10,748 rows)', () => {
    const hist: HistBin[] = [
      { value: 38, count: 520 }, { value: 39, count: 610 }, { value: 40, count: 1282 },
      { value: 41, count: 10_748 }, { value: 42, count: 977 }, { value: 43, count: 640 },
    ];
    const v = assessCandidateFlatness(hist, 41, 6, 3);
    expect(v.flat).toBe(false);
    expect(v.atomValue).toBe(41);
    expect(v.atomCount).toBe(10_748);
    expect(v.reason).toMatch(/cliff edge/i);
    expect(v.reason).toContain('10748');
  });

  it('rejects raw=-55, the 47x cliff one point below SELL_THRESHOLD_GATED', () => {
    const hist: HistBin[] = [
      { value: 52, count: 300 }, { value: 53, count: 61 }, { value: 54, count: 104 },
      { value: 55, count: 12_873 }, { value: 56, count: 117 }, { value: 57, count: 90 },
    ];
    const v = assessCandidateFlatness(hist, 55, 6, 3);
    expect(v.flat).toBe(false);
    expect(v.atomCount).toBe(12_873);
  });

  it('ACCEPTS a genuinely flat neighbourhood — otherwise the check is a blanket refusal', () => {
    const hist: HistBin[] = [70, 71, 72, 73, 74, 75].map((value) => ({ value, count: 500 + value }));
    expect(assessCandidateFlatness(hist, 72, 6, 3).flat).toBe(true);
  });

  it('never reports flat over an EMPTY neighbourhood (vacuity)', () => {
    const v = assessCandidateFlatness([], 41, 6, 3);
    expect(v.flat).toBe(false);
    expect(v.reason).toMatch(/empty neighbourhood/i);
  });
});

describe('methodology boundary is an exclusion (M2)', () => {
  it('parses the abbreviated end the record actually writes', () => {
    expect(parseBoundaryFromStatusMd('boundary: `[2026-08-07T10:16:12Z → 12:28:57Z]`'))
      .toEqual({ start: '2026-08-07T10:16:12Z', end: '2026-08-07T12:28:57Z' });
  });

  it('parses a fully-qualified end too', () => {
    expect(parseBoundaryFromStatusMd('[2026-08-07T10:16:12Z → 2026-08-08T12:28:57Z]'))
      .toEqual({ start: '2026-08-07T10:16:12Z', end: '2026-08-08T12:28:57Z' });
  });

  it('returns null rather than guessing when status.md has no interval', () => {
    expect(parseBoundaryFromStatusMd('no interval anywhere')).toBeNull();
  });

  it('LABELS the config fallback — a silent fallback would blend two methodologies', () => {
    const b = resolveBoundary(cfg, 'nothing parseable');
    expect(b.source).toMatch(/^config-fallback/);
    expect(b.endMs).toBeGreaterThan(b.startMs);
  });

  it('prefers status.md over the config copy when both are available', () => {
    const b = resolveBoundary(cfg, '[2026-09-01T00:00:00Z → 01:00:00Z]');
    expect(b.source).toBe('status.md');
    expect(new Date(b.startMs).toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  // The harness runs INSIDE the container, where /var/lib/algovault-monitoring/status.md does
  // not exist — the first live run proved it by reporting `config-fallback`. So the HOST wrapper
  // reads status.md and passes the interval in, and that path outranks everything.
  it('takes the boundary from the host wrapper when supplied, and labels the source', () => {
    const prev = [process.env.RECALIBRATE_BOUNDARY_START, process.env.RECALIBRATE_BOUNDARY_END];
    process.env.RECALIBRATE_BOUNDARY_START = '2026-10-01T00:00:00Z';
    process.env.RECALIBRATE_BOUNDARY_END = '2026-10-01T02:00:00Z';
    try {
      const b = resolveBoundary(cfg, '[2026-09-01T00:00:00Z → 01:00:00Z]');
      expect(b.source).toBe('status.md (via host wrapper)');
      expect(new Date(b.endMs).toISOString()).toBe('2026-10-01T02:00:00.000Z');
    } finally {
      process.env.RECALIBRATE_BOUNDARY_START = prev[0];
      process.env.RECALIBRATE_BOUNDARY_END = prev[1];
      if (prev[0] === undefined) delete process.env.RECALIBRATE_BOUNDARY_START;
      if (prev[1] === undefined) delete process.env.RECALIBRATE_BOUNDARY_END;
    }
  });

  it('ignores a malformed wrapper boundary rather than trusting it', () => {
    const prev = process.env.RECALIBRATE_BOUNDARY_START;
    process.env.RECALIBRATE_BOUNDARY_START = 'not-a-date';
    process.env.RECALIBRATE_BOUNDARY_END = 'also-not';
    try {
      expect(resolveBoundary(cfg, null).source).toMatch(/^config-fallback/);
    } finally {
      delete process.env.RECALIBRATE_BOUNDARY_END;
      if (prev === undefined) delete process.env.RECALIBRATE_BOUNDARY_START;
      else process.env.RECALIBRATE_BOUNDARY_START = prev;
    }
  });
});

describe('readiness verdict is computed, not judged (M5)', () => {
  it('PASSes only when every check is met', () => {
    expect(computeReadiness(fullyAccrued(), cfg).verdict).toBe('PASS');
  });

  it('FAILs on a single short timeframe — 1d is the binding term', () => {
    const f = fullyAccrued();
    f.perTf['1d'] = 0;
    const r = computeReadiness(f, cfg);
    expect(r.verdict).toBe('FAIL');
    expect(r.checks.find((c) => c.name === 'per_tf:1d')!.ok).toBe(false);
  });

  it('FAILs on a single short venue — this is what makes a venue-blind report impossible (F2)', () => {
    const f = fullyAccrued();
    f.perVenue.BINANCE = 0;
    expect(computeReadiness(f, cfg).verdict).toBe('FAIL');
  });

  it('is INDETERMINATE, never PASS, when the timeframe corpus is empty (vacuity)', () => {
    expect(computeReadiness({ ...fullyAccrued(), seededTfs: [] }, cfg).verdict).toBe('INDETERMINATE');
  });

  it('is INDETERMINATE, never PASS, when the venue corpus is empty (vacuity)', () => {
    expect(computeReadiness({ ...fullyAccrued(), promotedVenues: [] }, cfg).verdict).toBe('INDETERMINATE');
  });

  it('emits a per-venue check for every promoted venue', () => {
    const r = computeReadiness(fullyAccrued(), cfg);
    expect(r.checks.filter((c) => c.name.startsWith('per_venue:'))).toHaveLength(2);
    expect(r.checks.filter((c) => c.name.startsWith('per_tf:')).length).toBeGreaterThan(0);
  });
});

describe('verdict token contract', () => {
  it('maps each verdict to its own exit code — 0/1/3, not aligned to the test gate 2', () => {
    expect(EXIT_FOR).toEqual({ PASS: 0, FAIL: 1, INDETERMINATE: 3 });
  });
  it('names the token exactly once', () => {
    expect(VERDICT_TOKEN).toBe('RECALIBRATE_READINESS_VERDICT');
  });
});

describe('config carries its own justification', () => {
  it('every threshold row has a reason', () => {
    for (const [k, row] of Object.entries(cfg.thresholds)) {
      expect(row.reason, `threshold ${k}`).toBeTruthy();
    }
  });
  it('every per-timeframe floor has a reason', () => {
    for (const [k, row] of Object.entries(cfg.per_timeframe_matured)) {
      if (k === '_reason') continue;
      expect(typeof row === 'string' ? '' : row.reason, `per_tf ${k}`).toBeTruthy();
    }
  });
  it('1d is the binding floor and is not set higher than a week can deliver', () => {
    const oneD = cfg.per_timeframe_matured['1d'];
    expect(typeof oneD).not.toBe('string');
    expect((oneD as { value: number }).value).toBeLessThanOrEqual(30);
  });
});
