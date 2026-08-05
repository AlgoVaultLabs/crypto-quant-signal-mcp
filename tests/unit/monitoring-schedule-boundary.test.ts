/**
 * OPS-MONITORING-SCHEDULE-SOT-W1 — the off-:00 cron-boundary gate.
 *
 * Two things are pinned here that the gate's own `--self-test` cannot pin:
 *
 *  1. WIRING. The gate must be invoked by CI, and specifically by a workflow that
 *     actually FIRES on a monitoring-only commit. deploy.yml carries
 *     `paths-ignore: ops/monitoring/**`, so wiring the gate solely there would
 *     leave it structurally dark for the exact commit shape it polices.
 *
 *  2. CROSS-LANGUAGE PARITY. The Node gate and the Python reconciler both classify
 *     cron expressions. A `.mjs` module cannot be imported by Python, so "one
 *     derivation" is enforced as: one shared rule FILE + this test, which feeds an
 *     identical corpus to both `--classify` and `--classify-schedule` and requires
 *     byte-identical output. Without it the two would drift to contradiction, which
 *     is the bug class the wave exists to retire.
 */
import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

/**
 * OPS-ZERO-VS-UNKNOWN-W3 (unblock): this file SPAWNS A PROCESS PER ASSERTION — the cross-language
 * parity cases run the Node gate and the Python reconciler once per corpus entry (17 entries), so
 * it is slow BY CONSTRUCTION, not by defect. Under a loaded machine it exceeded vitest's 5s default
 * and failed as a TIMEOUT ("Test timed out in 5000ms" at 5233ms) — which reads exactly like a logic
 * failure and blocked every push to main.
 *
 * File-level, deliberately: a per-`it` third argument is easy to get wrong (an earlier attempt
 * placed it after the closing paren, where it parses as a no-op comma expression and silently does
 * nothing), and every test here pays the same process-spawn cost.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });


const ROOT = resolve(__dirname, '../..');
const GATE = 'scripts/check-monitoring-schedules.mjs';
const RECONCILER = 'ops/monitoring/monitoring-inventory-reconcile.py';
const RULE = 'ops/monitoring/schedule-boundary-rule.json';
const BASELINE = 'audits/monitoring-schedule-baseline.json';

/** Run a command, capturing stdout and the real exit code (never throwing on non-zero). */
function run(cmd: string, args: string[]): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8' }) };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

const node = (...args: string[]) => run('node', args);

describe('check-monitoring-schedules — verdict contract', () => {
  it('prints EXACTLY ONE terminal verdict token, and it is PASS over the live inventory', () => {
    const r = node(GATE);
    const tokens = r.out.split('\n').filter((l) => l.startsWith('MONITORING_SCHEDULE_VERDICT='));
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toBe('MONITORING_SCHEDULE_VERDICT=PASS');
    expect(r.code).toBe(0);
  });

  it('--self-test passes and is not vacuous — it reports a real check count', () => {
    const r = node(GATE, '--self-test');
    expect(r.out).toContain('MONITORING_SCHEDULE_VERDICT=PASS');
    const m = /self-test: (\d+) checks passed/.exec(r.out);
    expect(m, 'self-test must report how many checks it ran').not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(20);
    expect(r.code).toBe(0);
  });

  it('echoes the baselined count on every run so the debt cannot go quiet', () => {
    const r = node(GATE);
    // OPS-RATCHET-BASELINE-RETIRE-W1 emptied the baseline, so the line now takes its
    // RETIRED form. The intent is unchanged and is what this asserts: the count is
    // echoed on EVERY run, in one of exactly two shapes, and zero says so explicitly
    // rather than going silent. Naming a retirement wave at 0 would imply live debt.
    expect(r.out).toMatch(
      /baselined violations: (?:0 — baseline RETIRED \(OPS-RATCHET-BASELINE-RETIRE-W1\); this gate is fully blocking|[1-9]\d* \(retirement: OPS-MONITORING-SCHEDULE-SWEEP-W\{NEXT\}\))/,
    );
  });

  it('emits POSITIVE per-row output for EVERY scanned row, never mere absence-of-violation', () => {
    const out = node(GATE).out;
    expect(out).toMatch(/scanned \d+ schedule\(s\) across \d+ inventory row\(s\)/);

    // This used to probe the three BASELINED ids, which were named only because they were
    // in violation. Retiring the baseline made `recommendation-drift-canary` compliant and
    // it vanished from the output entirely — proving the property was being satisfied by
    // accident. A compliant row now prints a LEGAL line, so assert the real invariant:
    // every scanned row is named, with its verdict and its measured offset.
    const scanned = Number(/scanned (\d+) schedule\(s\)/.exec(out)![1]);
    const named = out
      .split('\n')
      .filter(l => /^\s+[·⚠✗] (LEGAL|ADVISORY|EXEMPT|BASELINED|INDETERMINATE|VIOLATION)\s/.test(l));
    expect(named.length, 'every scanned schedule must produce its own output line').toBe(scanned);

    for (const id of ['recommendation-drift-canary', 'webhook-delivery-canary', 'aoe-shadow-writer-stall-canary']) {
      expect(out, `${id} must be named in the output`).toContain(id);
    }
  });
});

describe('the >=3-minute rule, both directions', () => {
  const classify = (expr: string) => node(GATE, '--classify', expr).out.trim();

  it.each([
    ['27 12 * * 1', 'LEGAL offset=27'],      // the live, post-SEC-48 value
    ['0 12 * * 1', 'VIOLATION offset=0'],    // the stale declaration this wave converged
    ['3 12 * * 1', 'ADVISORY offset=3'],     // forward boundary, inclusive
    ['2 12 * * 1', 'VIOLATION offset=2'],
    ['57 0 * * *', 'LEGAL offset=3'],        // backward boundary, inclusive
    ['58 0 * * *', 'VIOLATION offset=2'],
    ['59 0 * * *', 'VIOLATION offset=1'],
  ])('%s -> %s', (expr, want) => {
    expect(classify(expr)).toBe(want);
  });

  it('measures distance to the NEAREST :00, which is what makes :57 the set ceiling', () => {
    // A forward-only reading would admit :58 and :59 — the two minutes the law most
    // needs to exclude, and the reason the canonical set stops at 57.
    expect(classify('58 0 * * *')).toBe('VIOLATION offset=2');
    expect(classify('57 0 * * *')).toBe('LEGAL offset=3');
  });
});

describe('real cron parsing — ranges, lists, steps', () => {
  const classify = (expr: string) => node(GATE, '--classify', expr).out.trim();

  it('parses carry-scorer-shaped hour ranges and verdicts on the minute alone', () => {
    // `7 0-1,3-23 * * *` is a live expression on the host. The range is in the HOUR
    // field; a regex guess over the whole string would mis-verdict it.
    expect(classify('7 0-1,3-23 * * *')).toBe('ADVISORY offset=7');
  });

  it.each([
    ['13,23,33,43,53 * * * *', 'LEGAL offset=7'],
    ['13,28,43,58 * * * *', 'VIOLATION offset=2'],   // verdicts on its WORST minute
    ['*/5 * * * *', 'VIOLATION offset=0'],
    ['* * * * *', 'VIOLATION offset=0'],
    ['5-9 * * * *', 'ADVISORY offset=5'],
    ['0-5 * * * *', 'VIOLATION offset=0'],
    ['10-50/10 * * * *', 'ADVISORY offset=10'],
    ['@hourly', 'VIOLATION offset=0'],
  ])('%s -> %s', (expr, want) => {
    expect(classify(expr)).toBe(want);
  });

  it.each([
    ['banana'], ['27 12 * *'], ['0 27 12 * * 1'], ['61 12 * * 1'],
    ['30-10 * * * *'], ['*/0 * * * *'], ['@reboot'], [''],
  ])('unparseable %s is UNPARSEABLE, never a silent pass', (expr) => {
    expect(node(GATE, '--classify', expr).out.trim()).toBe('UNPARSEABLE offset=-1');
  });
});

describe('cross-language parity — one rule, two consumers, zero drift', () => {
  const CORPUS = [
    '27 12 * * 1', '0 12 * * 1', '57 0 * * *', '58 0 * * *', '59 0 * * *',
    '3 12 * * 1', '2 12 * * 1', '7 0-1,3-23 * * *', '13,28,43,58 * * * *',
    '13,18,23,28,33,38,43,48,53,58 * * * *', '13,23,33,43,53 * * * *',
    '*/5 * * * *', '* * * * *', '5-9 * * * *', '0-5 * * * *', '10-50/10 * * * *',
    '47 */6 * * *', '19 8 1 * *', '9 7 * * 4', '17 7 * * *', '31 * * * *',
    '@hourly', '@daily', '@weekly', '@reboot',
    'banana', '27 12 * *', '61 12 * * 1', '30-10 * * * *', '*/0 * * * *', '',
  ];

  it('has python3 available — a skipped parity test is exactly the vacuity we forbid', () => {
    expect(run('python3', ['--version']).code).toBe(0);
  });

  it.each(CORPUS)('js and py agree on %j', (expr) => {
    const js = node(GATE, '--classify', expr).out.trim();
    const py = run('python3', [RECONCILER, '--classify-schedule', expr]).out.trim();
    expect(js).not.toBe('');
    expect(py).toBe(js);
  });

  it('the corpus is non-empty and spans every status the classifier can return', () => {
    const seen = new Set(CORPUS.map((e) => node(GATE, '--classify', e).out.trim().split(' ')[0]));
    expect([...seen].sort()).toEqual(['ADVISORY', 'LEGAL', 'UNPARSEABLE', 'VIOLATION']);
  });

  it('neither consumer hardcodes the rule — both read schedule-boundary-rule.json', () => {
    expect(readFileSync(join(ROOT, GATE), 'utf8')).toContain('schedule-boundary-rule.json');
    expect(readFileSync(join(ROOT, RECONCILER), 'utf8')).toContain('schedule-boundary-rule.json');
  });

  it('the boundary predicate is defined ONCE per language and nowhere else (AC12)', () => {
    // Grep the tracked tree for any re-derivation of `min(m, 60 - m)`. Exactly three
    // files may mention it: the two implementations, plus the rule file itself — where
    // it appears in `_offset_semantics` as PROSE, the SoT stating its own contract.
    // A fourth hit is a third derivation and is the drift this wave exists to retire.
    const tracked = run('git', ['grep', '-l', '-e', '60 - m', '-e', '60 - minute', '--', '.']).out
      .split('\n').filter(Boolean).filter((f) => !f.startsWith('tests/'));
    expect(tracked.sort()).toEqual([RECONCILER, RULE, GATE].sort());

    // …and the rule file's mention really is prose, not executable code.
    expect(RULE.endsWith('.json')).toBe(true);
    expect(JSON.parse(readFileSync(join(ROOT, RULE), 'utf8'))._offset_semantics).toContain('60 - m');
  });
});

describe('exemptions live on the row, with a mandatory reason', () => {
  it('the rule file documents the exemption contract', () => {
    const rule = JSON.parse(readFileSync(join(ROOT, RULE), 'utf8'));
    expect(rule._exemption_semantics).toMatch(/reason is MANDATORY/i);
    expect(rule.min_offset_minutes).toBe(3);
    expect(rule.canonical_minutes).toEqual([13, 17, 23, 27, 33, 37, 43, 47, 53, 57]);
  });

  it('every canonical minute actually satisfies the rule it is offered for', () => {
    const rule = JSON.parse(readFileSync(join(ROOT, RULE), 'utf8'));
    for (const m of rule.canonical_minutes as number[]) {
      expect(Math.min(m, 60 - m), `canonical minute ${m}`).toBeGreaterThanOrEqual(rule.min_offset_minutes);
    }
  });
});

describe('the ratchet', () => {
  const baseline = () => JSON.parse(readFileSync(join(ROOT, BASELINE), 'utf8'));
  /**
   * OPS-RATCHET-BASELINE-RETIRE-W1 emptied `entries`. The three tests below used to
   * iterate it, so an empty baseline would make every one of them pass VACUOUSLY —
   * green forever while asserting nothing. Each therefore branches explicitly: the
   * RETIRED state is asserted positively, and the entry-shape rules stay armed for
   * the day someone adds an entry back.
   */
  const isRetired = (b: { entries: unknown[] }) => b.entries.length === 0;

  it('is either RETIRED with a full record, or carries well-formed entries — never silently between', () => {
    const b = baseline();
    expect(Array.isArray(b.entries)).toBe(true);

    if (isRetired(b)) {
      // An empty `entries` is a CLAIM — that the gate is now fully blocking — so it must
      // be owned and evidenced, not just an array someone deleted rows from.
      expect(b.retired_by, 'an emptied baseline must name the wave that retired it').toBeTruthy();
      expect(Array.isArray(b.retirement_record)).toBe(true);
      expect(b.retirement_record.length, 'retirement must record what moved where').toBeGreaterThan(0);
      for (const r of b.retirement_record) {
        expect(r.id, 'retirement row needs an id').toBeTruthy();
        expect(r.from, `${r.id} needs the schedule it moved FROM`).toBeTruthy();
        expect(r.to, `${r.id} needs the schedule it moved TO`).toBeTruthy();
        expect(String(r.why ?? '').length, `${r.id} needs a why`).toBeGreaterThan(20);
      }
      return;
    }

    expect(b.retirement_wave).toBe('OPS-MONITORING-SCHEDULE-SWEEP-W{NEXT}');
    for (const e of b.entries) {
      expect(e.id, 'entry needs an id').toBeTruthy();
      expect(e.schedule, `${e.id} needs the exact violating schedule`).toBeTruthy();
      expect(e.owner_wave, `${e.id} needs an owner to route the fix to`).toBeTruthy();
      expect(String(e.note ?? '').length, `${e.id} needs a note`).toBeGreaterThan(20);
    }
  });

  it('every baselined row genuinely violates — and every RETIRED row genuinely stopped violating', () => {
    const b = baseline();
    const classify = (s: string) => node(GATE, '--classify', s).out.trim();

    if (isRetired(b)) {
      // The retirement record is a claim about cron minutes; check it against the gate's
      // own classifier rather than trusting the prose. This is strictly stronger than the
      // assertion it replaces — it pins BOTH ends of every move.
      for (const r of b.retirement_record) {
        expect(classify(r.from), `${r.id}: the 'from' schedule must be why it was baselined`).toMatch(/^VIOLATION /);
        expect(classify(r.to), `${r.id}: the 'to' schedule must no longer violate`).toMatch(/^(LEGAL|ADVISORY) /);
      }
      return;
    }
    for (const e of b.entries) {
      expect(classify(e.schedule), `${e.id} must actually violate`).toMatch(/^VIOLATION /);
    }
  });

  it('baseline and retirement rows both still match the live inventory', () => {
    const inv = JSON.parse(readFileSync(join(ROOT, 'ops/monitoring/monitoring-inventory.json'), 'utf8'));
    const b = baseline();
    const rowFor = (id: string) => inv.artifacts.find((r: { id: string }) => r.id === id);

    if (isRetired(b)) {
      // The inventory is what the reconciler compares the live crontab against, so a
      // retirement row whose `to` never landed in the inventory would be a lie the
      // reconciler would then report as SCHEDULE_DRIFT on the host.
      for (const r of b.retirement_record) {
        const row = rowFor(r.id);
        expect(row, `${r.id} was retired but is absent from the inventory`).toBeTruthy();
        expect(row.schedule, `${r.id}: inventory must carry the moved-TO schedule`).toBe(r.to);
      }
      return;
    }
    for (const e of b.entries) {
      const row = rowFor(e.id);
      expect(row, `${e.id} is baselined but absent from the inventory — the entry is stale`).toBeTruthy();
      expect(row.schedule).toBe(e.schedule);
    }
  });
});

describe('wiring (AC13/AC13b)', () => {
  it('is invoked by the dedicated monitoring workflow, which FIRES on monitoring-only commits', () => {
    const wf = readFileSync(join(ROOT, '.github/workflows/monitoring-schedules.yml'), 'utf8');
    expect(wf).toContain('node scripts/check-monitoring-schedules.mjs --self-test');
    expect(wf).toContain('node scripts/check-monitoring-schedules.mjs\n');
    // The whole reason this workflow exists: it must trigger on the inventory itself.
    expect(wf).toContain("- 'ops/monitoring/monitoring-inventory.json'");
    expect(wf).toContain("- 'ops/monitoring/schedule-boundary-rule.json'");
    expect(wf).toContain("- 'audits/monitoring-schedule-baseline.json'");
  });

  it('deploy.yml paths-ignore still excludes ops/monitoring — so the extra workflow is REQUIRED', () => {
    // If a future wave removes this ignore, the dedicated workflow becomes redundant
    // rather than load-bearing. Pinning the premise keeps that decision deliberate.
    const dep = readFileSync(join(ROOT, '.github/workflows/deploy.yml'), 'utf8');
    expect(dep).toContain("- 'ops/monitoring/**'");
    expect(dep).toContain('node scripts/check-monitoring-schedules.mjs');
  });

  it('is wired into prepublishOnly', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.prepublishOnly).toContain('node scripts/check-monitoring-schedules.mjs');
  });

  it('is discoverable by the canary-wiring meta-canary', () => {
    const r = node('scripts/check-canaries-wired.mjs');
    expect(r.code).toBe(0);
    expect(r.out).toContain('scripts/check-monitoring-schedules.mjs');
  });

  it('does NOT touch the shared pre-push hook — a 6th block deadlocked ~70 checkouts twice', () => {
    for (const installer of [
      'scripts/install_test_gate_hook.sh',
      'scripts/install_system_map_hook.sh',
      'scripts/install_session_drift_hook.sh',
      'scripts/install_push_safety_hook.sh',
    ]) {
      if (!existsSync(join(ROOT, installer))) continue;
      expect(readFileSync(join(ROOT, installer), 'utf8'), `${installer} must not reference this gate`)
        .not.toContain('check-monitoring-schedules');
    }
  });
});
