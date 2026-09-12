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
  scheduledHosts,
  declaredAutomation,
} from '../../scripts/check-alert-copy-claims.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

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

/**
 * ── OPS-HOST-KERNEL-REBOOT-W4 — DIRECTION 2 ──────────────────────────────────────────────────
 * W3 (above) pinned the defect where a body CITES something whose reality it misstates. This is
 * the opposite defect, and the gate W3 shipped was structurally blind to it: a body that never
 * mentions a component the world GAINED. The sentence that shipped —
 *   "(verify Hetzner console access first, rehearse on aoe-1, then signal-1)"
 * — cites no repo path at all, so PATH_RE never saw it, and ALERT_COPY_VERDICT stayed OK for the
 * 15 days between OPS-HOST-AUTO-REBOOT-W1 landing the unattended harness and this wave.
 */
const STALE_REHEARSAL = 'rehearse on aoe-1, then signal-1';

describe('W4 regression: the alert must not instruct a rehearsal that voids an unattended cycle', () => {
  const live = readFileSync(path.join(ROOT, 'ops/monitoring/kernel-staleness-canary.sh'), 'utf8');

  it('the stale rehearsal instruction can no longer reach an operator', () => {
    // Scoped to the OPERATOR-FACING corpus, not the raw file, because that is the actual claim:
    // hand-rebooting aoe-1 resets the running-vs-installed delta, which only a real reboot can
    // reset — destroying one of the two clean unattended cycles gating signal-1's promotion.
    const blocks = operatorFacingBlocks(live, 'kernel-staleness-canary.sh').join('|');
    expect(blocks).not.toContain(STALE_REHEARSAL);
  });

  it('but the file KEEPS the phrase in a provenance comment — history is not erased', () => {
    // CLAUDE.md's correction style: the wrong thing stays visible with its correction beside it,
    // so the next reader learns why the sentence changed instead of rediscovering the incident.
    expect(live).toContain(STALE_REHEARSAL);
    expect(operatorFacingBlocks(live, 'kernel-staleness-canary.sh').join('|')).not.toContain(STALE_REHEARSAL);
  });

  it('and the body names the harness that actually performs the action', () => {
    const blocks = operatorFacingBlocks(live, 'kernel-staleness-canary.sh').join('\n');
    expect(blocks).toContain('ops/monitoring/kernel-auto-reboot.sh');
  });

  it('on EVERY coverage branch, not just the one this host happens to take', () => {
    // decide_action has three branches; a branch that drops the citation is a DRIFT nobody would
    // see until that branch fires on a host in trouble.
    const branches = live.match(/Action:[\s\S]*?ACT/g) ?? [];
    expect(branches.length).toBeGreaterThanOrEqual(3);
    for (const b of branches) expect(b).toContain('ops/monitoring/kernel-auto-reboot.sh');
  });
});

describe('W4: the declaration is real, complete, and matches the live schedule', () => {
  it('KERNEL_STALENESS declares the auto-reboot harness with a non-empty reason', () => {
    const d = declaredAutomation(ROOT);
    expect(d).not.toBeNull();
    const e = d!.entries.find((x) => x.alertId === 'KERNEL_STALENESS');
    expect(e).toBeDefined();
    expect(e!.artifact).toBe('ops/monitoring/kernel-auto-reboot.sh');
    expect(e!.reason ?? '').not.toBe('');
    expect(d!.malformed).toHaveLength(0);
  });

  it('the harness is scheduled on aoe-1 ONLY — the signal-1 firewall, asserted not assumed', () => {
    const m = scheduledHosts(ROOT);
    expect(m).not.toBeNull();
    const on = m!.get('ops/monitoring/kernel-auto-reboot.sh');
    expect(on).toBeDefined();
    expect([...on!].sort()).toEqual(['aoe-1']);
  });

  it('while the alert itself covers both hosts — which is why the body must say which is which', () => {
    const m = scheduledHosts(ROOT);
    expect([...m!.get('ops/monitoring/kernel-staleness-canary.sh')!].sort()).toEqual(['aoe-1', 'signal-1']);
  });
});

describe('W4: direction 2 fires on the defect and stays silent on the fix', () => {
  const mk = (body: string, declare: unknown) => {
    const t = mkdtempSync(path.join(tmpdir(), 'd2-vitest-'));
    mkdirSync(path.join(t, 'ops/monitoring'), { recursive: true });
    writeFileSync(path.join(t, 'ops/monitoring/monitoring-inventory.json'), JSON.stringify({
      artifacts: [
        { artifact: 'ops/monitoring/owner.sh', installed_at: [{ host: 'signal-1', schedule: '0 1 * * *' }] },
        { artifact: 'ops/monitoring/robot.sh', installed_at: [{ host: 'aoe-1', schedule: '7 * * * *' }] },
      ],
    }));
    writeFileSync(path.join(t, 'ops/monitoring/alert-registry.json'), JSON.stringify({
      alerts: [{ alert_id: 'A', owner: 'ops/monitoring/owner.sh', hosts: ['aoe-1', 'signal-1'], related_automation: [declare] }],
    }));
    writeFileSync(path.join(t, 'ops/monitoring/owner.sh'), `#!/usr/bin/env bash\nsend_telegram\ncat <<EOF\n${body}\nEOF\n`);
    return t;
  };
  const DECL = { artifact: 'ops/monitoring/robot.sh', hosts: ['aoe-1'], reason: 'it already does this' };

  it('an uncited declared+scheduled automation is a DRIFT with a ratchet key', () => {
    const t = mk('Action: do it by hand.', DECL);
    const r = evaluate(t);
    expect(r.verdict).toBe('DRIFT');
    expect(r.violations[0].key).toBe('ops/monitoring/owner.sh::ops/monitoring/robot.sh::UNCITED');
    rmSync(t, { recursive: true, force: true });
  });

  it('citing it clears the drift', () => {
    const t = mk('Action: ops/monitoring/robot.sh already handles aoe-1.', DECL);
    expect(evaluate(t).verdict).toBe('OK');
    rmSync(t, { recursive: true, force: true });
  });

  it('a missing reason is INDETERMINATE — mandatory, never a silent pass', () => {
    const t = mk('Action: by hand.', { artifact: 'ops/monitoring/robot.sh', hosts: ['aoe-1'] });
    expect(evaluate(t).verdict).toBe('INDETERMINATE');
    rmSync(t, { recursive: true, force: true });
  });
});

describe('W4: honest scope — the allow-list gap is counted, never silent', () => {
  it('every run reports how many alert rows declare nothing', () => {
    const d2 = evaluate(ROOT).d2;
    expect(d2).toBeDefined();
    expect(d2.totalRows).toBeGreaterThan(0);
    expect(d2.declaredRows).toBeGreaterThanOrEqual(1);
    // The undeclared remainder is a REPORTED gap. Asserting it is non-negative is not the point;
    // asserting the counter EXISTS is — an allow-list whose coverage nobody prints reads clean.
    expect(d2.totalRows - d2.declaredRows).toBeGreaterThanOrEqual(0);
  });
});
