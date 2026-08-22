/**
 * OPS-MONITORING-SIGNAL-CONTRACT-W1 CH1 — the census parser's two-way battery.
 *
 * The census decides whether CH2 happens at all, so its parser has to be able to say BOTH "this
 * detector conforms" and "this one does not" on fixtures — a scorer that only ever returns one
 * answer would size the wave by construction.
 *
 * NO SPAWN BUDGET IS DECLARED, DELIBERATELY. `scripts/check-test-budget.mjs` flags blocks that
 * SPAWN A PROCESS; every case here is a pure function over a string fixture. Attaching a budget
 * anyway would be cargo-culting a rule without its trigger. (Ratified 2026-08-22 with the CH1
 * spec correction.)
 *
 * The fixtures are deliberately the SHAPES measured on the live tree, not invented ones:
 *   · `BAD_*` reproduces `directional-label-freshness.py`'s forward path — the detector that
 *     generated this wave;
 *   · `EXIT_CODE_ONLY` reproduces `postgres-cpu-autopilot.py`'s named-constant exit contract,
 *     which an earlier revision of the scorer DROPPED entirely.
 */
import { describe, expect, it } from 'vitest';
import {
  emitsAnOperatorSignal,
  proseLiterals,
  scoreDetector,
  scoreEvidence,
  scoreRunIdentity,
  scoreRunOutcome,
  scoreVerdict,
  summarisesAProducerRun,
  NOT_A_DETECTOR,
} from '../../scripts/monitoring-census.mjs';

/** The known-good shape: token + INDETERMINATE, run identity, outcome read, rendered evidence. */
const GOOD = [
  '# Exit: 0 = evaluated (PASS, or FAIL with the alert sent) · 3 = INDETERMINATE',
  'run_id = sys.argv[1]',
  'produced_at = datetime.now(timezone.utc).isoformat()',
  'r = subprocess.run(cmd, capture_output=True)',
  'outcome = "complete" if r.returncode == 0 else "stopped"',
  'body = f"venue={v} lag={lag}h slo={slo}h outcome={outcome}"',
  'subprocess.run([wrapper, "MY_ALERT", "CRITICAL_PERSISTENT", "-"], input=body)',
  'print("MY_VERDICT=INDETERMINATE")',
].join('\n');

/** The known-bad shape — `forward_capacity_signal`, reduced to its load-bearing lines. */
const BAD = [
  'lines = Path(log_path).read_text().splitlines()[-6000:]',
  'marker = next((l for l in lines if "[capacity-shortfall]" in l), None)',
  'body = "\\n".join([',
  '    "🛑 DIRECTIONAL_LABEL_CAPACITY_SHORTFALL",',
  '    "The nightly labeler could not keep every venue inside its tier SLO within the budget",',
  '    "(SLO-ordered, so majors were served first; the shortfall is the long-tail overflow).",',
  '    detail])',
  'subprocess.run([wrapper, "DIRECTIONAL_LABEL_CAPACITY_SHORTFALL", "CRITICAL_PERSISTENT", "-"], input=body)',
].join('\n');

const EXIT_CODE_ONLY = [
  'EXIT_SILENT = 0',
  'EXIT_ESCALATE = 1',
  'EXIT_CRITICAL_BYPASS = 2',
  'EXIT_FRAMEWORK_ERROR = 3',
].join('\n');

describe('monitoring-census — the parser scores a known-good detector as passing', () => {
  it('scores all four properties as pass on the good fixture', () => {
    const s = scoreDetector(GOOD);
    expect(s.verdict.state).toBe('pass');
    expect(s.run_outcome.state).toBe('pass');
    expect(s.run_identity.state).toBe('pass');
    expect(s.evidence.state).toBe('pass');
  });

  it('records the STRONGEST verdict form as `token`, not merely as passing', () => {
    expect(scoreVerdict(GOOD).form).toBe('token');
  });
});

describe('monitoring-census — the parser scores a known-bad detector as failing', () => {
  it('fails all four properties on the forward_capacity_signal fixture', () => {
    const s = scoreDetector(BAD);
    expect(s.verdict.state).toBe('fail');
    expect(s.run_outcome.state).toBe('fail');
    expect(s.run_identity.state).toBe('fail');
    expect(s.evidence.state).toBe('fail');
  });

  it('cites the exact line of the hardcoded mechanism prose (AC1.2 needs <file>:<line>)', () => {
    const p = proseLiterals(BAD);
    // BOTH mechanism sentences are prose; the real body carries two, and finding only one would
    // mean the scanner stops at the first match.
    expect(p.length).toBe(2);
    expect(p.map((x) => x.literal).join(' ')).toContain('long-tail overflow');
    // The citation anchors on the FIRST offending line, which is what a reader needs to open.
    expect(scoreEvidence(BAD).line).toBe(p[0].line);
    expect(scoreEvidence(BAD).reason).toContain('2 hardcoded mechanism sentence');
  });

  it('names WHICH identity component is missing, not just that it failed', () => {
    expect(scoreRunIdentity(BAD).reason).toContain('run_id');
    expect(scoreRunIdentity(BAD).reason).toContain('produced_at');
  });
});

describe('monitoring-census — `verdict` is distinguishability, but the FORM is recorded', () => {
  it('accepts a named-constant exit contract as passing', () => {
    expect(scoreVerdict(EXIT_CODE_ONLY).state).toBe('pass');
  });

  it('scores it `exit-code-only`, NEVER laundered as `token`', () => {
    // An exit code is lossy through `|| true`, cron wrappers and pipelines. Counting it as
    // passing keeps the sizing gate honest; recording the distinction stops CH2 treating a
    // weaker mechanism as equivalent.
    expect(scoreVerdict(EXIT_CODE_ONLY).form).toBe('exit-code-only');
  });

  it('fails a token that never names a third state', () => {
    const s = scoreVerdict('print("MY_VERDICT=PASS")');
    expect(s.state).toBe('fail');
    expect(s.form).toBe('token-without-third-state');
  });
});

describe('monitoring-census — `run_outcome` has a reachable n-a branch', () => {
  it('is n-a for a detector that measures live state and summarises no run', () => {
    const live = 'code = requests.get(url).status_code';
    expect(summarisesAProducerRun(live)).toBe(false);
    expect(scoreRunOutcome(live).state).toBe('n-a');
  });

  it('is fail — not n-a — for a detector that reads a producer log without its outcome', () => {
    expect(summarisesAProducerRun(BAD)).toBe(true);
    expect(scoreRunOutcome(BAD).state).toBe('fail');
  });
});

describe('monitoring-census — "is a detector" is derived from behaviour, not a hand-list', () => {
  it('admits an artifact that calls the alert transport', () => {
    expect(emitsAnOperatorSignal(BAD)).toBe(true);
  });

  it('admits an artifact whose operator signal IS its documented exit contract', () => {
    // postgres-cpu-autopilot.py never touches the transport and is unambiguously a detector.
    expect(emitsAnOperatorSignal(EXIT_CODE_ONLY)).toBe(true);
  });

  it('rejects an artifact that only MENTIONS the transport in a comment', () => {
    // A filename in prose is documentation, not a call — the same lesson check-alert-registry
    // records after a comment manufactured a phantom alert id.
    expect(emitsAnOperatorSignal('# escalation routes via send_telegram.sh')).toBe(false);
  });

  it('keeps the test-harness exclusions as DATA carrying a reason, never as prose', () => {
    for (const name of ['test-directional-label-freshness.py', 'test-website-drift-canary.py']) {
      expect(NOT_A_DETECTOR.has(name)).toBe(true);
      expect(NOT_A_DETECTOR.get(name)).toMatch(/pages nobody/);
    }
  });
});
