/**
 * alert-copy-claims.test.ts — OPS-HOST-KERNEL-REBOOT-W3 CH3.
 *
 * What stops the regression is a fixture, not a description of it. The centrepiece here is the
 * EXACT pre-fix `kernel-staleness-canary.sh` alert body, pinned as a must-DRIFT case: it told the
 * operator that "boot survival is asserted continuously by scripts/check-boot-readiness.mjs" while
 * that gate was build-time only and ran on no host at all.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  operatorFacingBlocks,
  qualifyingVerb,
  sentences,
  classify,
  corpus,
  scheduledPaths,
  evaluate,
  loadBaseline,
  CONTINUITY_VERBS,
} from '../../scripts/check-alert-copy-claims.mjs';

const ROOT = path.resolve(__dirname, '../..');

/**
 * VERBATIM from ops/monitoring/kernel-staleness-canary.sh before this wave corrected it. Do not
 * "tidy" this string — its value is that it is the real thing that shipped and paged.
 */
const PRE_FIX_BODY = [
  'Action: schedule a reboot. The procedure is validated end-to-end by OPS-HOST-KERNEL-REBOOT-W1',
  '(verify Hetzner console access first, rehearse on aoe-1, then signal-1); boot survival is asserted',
  'continuously by scripts/check-boot-readiness.mjs. recommended_wave: OPS-HOST-KERNEL-REBOOT-W{NEXT}',
].join('\n');

/** Reality fixtures: what the world looked like when that body was false. */
const SCHEDULED = new Set(['ops/monitoring/boot-contract-canary.sh']);
const BUILD_TIME = new Set(['scripts/check-boot-readiness.mjs']);

describe('the regression fixture — the exact body that shipped', () => {
  it('cites the build-time gate with a cadence verb in the SAME sentence', () => {
    const verb = qualifyingVerb(PRE_FIX_BODY, 'scripts/check-boot-readiness.mjs');
    expect(verb).toBe('continuously');
  });

  it('and that path is NOT scheduled — so the claim is a DRIFT', () => {
    expect(classify('scripts/check-boot-readiness.mjs', SCHEDULED, BUILD_TIME)).toBe('BUILD_TIME');
    const verb = qualifyingVerb(PRE_FIX_BODY, 'scripts/check-boot-readiness.mjs');
    const isDrift = Boolean(verb) && classify('scripts/check-boot-readiness.mjs', SCHEDULED, BUILD_TIME) !== 'SCHEDULED';
    expect(isDrift).toBe(true);
  });

  it('fails WITHOUT the fix: the pre-fix body must not be reachable from the live tree', () => {
    // The literal sentence is gone from the shipped canary. If someone reinstates it, this fails.
    const live = readFileSync(path.join(ROOT, 'ops/monitoring/kernel-staleness-canary.sh'), 'utf8');
    expect(live).not.toContain('boot survival is asserted\ncontinuously by scripts/check-boot-readiness.mjs');
  });
});

describe('the corrected body is honest, and provably so', () => {
  const live = readFileSync(path.join(ROOT, 'ops/monitoring/kernel-staleness-canary.sh'), 'utf8');
  const blocks = operatorFacingBlocks(live, 'kernel-staleness-canary.sh');
  const claim = blocks.find((b) => b.includes('Boot survival is asserted'));

  it('still makes a continuity claim — the fix is not deletion', () => {
    expect(claim).toBeDefined();
  });

  it('attributes the cadence to the SCHEDULED canary', () => {
    expect(qualifyingVerb(claim as string, 'ops/monitoring/boot-contract-canary.sh')).toBeTruthy();
  });

  it('and makes NO cadence claim about the build-time gate', () => {
    expect(qualifyingVerb(claim as string, 'scripts/check-boot-readiness.mjs')).toBeNull();
  });

  it('names check-boot-readiness.mjs as build-time explicitly', () => {
    expect(claim as string).toMatch(/BUILD-TIME gate/);
  });
});

describe('sentence-scoped attribution (a character window could not do this)', () => {
  const twoSentences =
    'Asserted continuously by ops/monitoring/boot-contract-canary.sh. scripts/check-boot-readiness.mjs is the BUILD-TIME gate.';

  it('a verb qualifies only its own sentence', () => {
    expect(qualifyingVerb(twoSentences, 'ops/monitoring/boot-contract-canary.sh')).toBe('continuously');
    expect(qualifyingVerb(twoSentences, 'scripts/check-boot-readiness.mjs')).toBeNull();
  });

  it('a bare pointer never qualifies', () => {
    expect(qualifyingVerb('see scripts/check-boot-readiness.mjs for the contract shape', 'scripts/check-boot-readiness.mjs')).toBeNull();
  });

  it('splits on sentence terminators, never on a mid-sentence colon', () => {
    expect(sentences('A is the gate: it proves X. B runs hourly.')).toHaveLength(2);
  });
});

describe('operator-facing extraction excludes documentation', () => {
  it('shell: heredoc yes, # comment no', () => {
    const sh = '# continuously scripts/check-boot-readiness.mjs\ncat <<EOF\nreal body scripts/check-boot-readiness.mjs\nEOF\n';
    const b = operatorFacingBlocks(sh, 'x.sh').join('');
    expect(b).toContain('real body');
    expect(b).not.toContain('# continuously');
  });

  it('python: module and def docstrings are NOT operator-facing', () => {
    const py = [
      '"""Module doc: asserted continuously by scripts/check-boot-readiness.mjs."""',
      'def f():',
      '    """Def doc: continuously scripts/check-boot-readiness.mjs."""',
      '    return 1',
      'BODY = """asserted continuously by scripts/check-boot-readiness.mjs"""',
    ].join('\n');
    const b = operatorFacingBlocks(py, 'x.py');
    expect(b.some((x) => x.includes('Module doc'))).toBe(false);
    expect(b.some((x) => x.includes('Def doc'))).toBe(false);
    expect(b.some((x) => x.includes('asserted continuously by'))).toBe(true);
  });

  it('js: template literal yes, block comment no', () => {
    const mjs = '/* continuously scripts/check-boot-readiness.mjs */\nconst b = `body scripts/check-boot-readiness.mjs`;';
    const b = operatorFacingBlocks(mjs, 'x.mjs').join('');
    expect(b).toContain('body scripts');
    expect(b).not.toContain('/* continuously');
  });
});

describe('the live corpus', () => {
  it('is non-empty and its scan is non-vacuous', () => {
    const files = corpus(ROOT);
    expect(files.length).toBeGreaterThan(10);
    const withBlocks = files.filter((f) => operatorFacingBlocks(readFileSync(f.abs, 'utf8'), f.name).length);
    expect(withBlocks.length).toBeGreaterThan(0);
  });

  it('resolves the scheduled set from the inventory, including this wave\'s canary', () => {
    const sched = scheduledPaths(ROOT);
    expect(sched).not.toBeNull();
    expect(sched!.has('ops/monitoring/boot-contract-canary.sh')).toBe(true);
  });

  it('returns OK — every cadence claim names a scheduled guard', () => {
    expect(evaluate(ROOT).verdict).toBe('OK');
  });

  it('has a parseable baseline, and it is EMPTY by measurement, not by omission', () => {
    const b = loadBaseline(ROOT);
    expect(b).not.toBeNull();
    expect(b!.present).toBe(true);
    expect(b!.keys.size).toBe(0);
  });
});

describe('the verb list is a promise about cadence, not a mention', () => {
  it('contains the verb from the actual incident', () => {
    expect(CONTINUITY_VERBS).toContain('continuously');
  });

  it('does not contain bare pointer words that would flag every cross-reference', () => {
    for (const noise of ['see', 'by', 'in', 'the']) expect(CONTINUITY_VERBS).not.toContain(noise);
  });
});
