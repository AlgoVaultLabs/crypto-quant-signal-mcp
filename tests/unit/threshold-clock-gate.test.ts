/**
 * OPS-THRESHOLD-CLOCK-W1 — a recalibration clock ships as an owed read, never as prose.
 *
 * THE CLASS (ARC-BOOK-LIVENESS-ALERT-TRUTH research §7–8, measured at 8c50c757): 23 dated revisit
 * clocks in prose across src/, ops/ and scripts/, 21 of them past due on 2026-11-12 — and the page
 * that opened the arc is one of the misses (the book-liveness floor pins' 10-28 re-measure). A clock
 * kept in prose is a clock nobody runs. `ops/monitoring/owed-read-runner.py` already runs a dated
 * read by itself and pages once on FAIL, so the generator fix is a gate that makes the owed read
 * the only way a clock can ship.
 *
 * `scripts/check-threshold-clock.py` has two checks:
 *   M  a dated revisit clock in a .ts/.js/.mjs/.cjs/.py/.sh file under src/, ops/ or scripts/;
 *   T  a comparison in a paging canary against a module-level numeric constant (or a subscript /
 *      `.get()` of a module-level numeric container) whose assignment carries no
 *      `# threshold-revisit: <owed-reads id>` and no reasoned `# threshold-exempt:`.
 * Today's sites sit in the SHRINK-ONLY `ops/threshold-clock-baseline.json`: enumerated, never paged.
 *
 * This suite proves the acceptance behaviourally: PASS on the repo (AC1), FAIL on a planted clock in
 * each of the three roots (AC2), the four AC3 cases on a copied paging canary, the shrink-only
 * baseline (AC5), INDETERMINATE before PASS, and a self-test proven able to fail by mutation (AC4).
 *
 * SPAWN BUDGET DECLARED in every block's OPTIONS argument (`scripts/check-test-budget.mjs`).
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const REPO = path.resolve(__dirname, '../..');
const GATE = path.join(REPO, 'scripts/check-threshold-clock.py');
const BASELINE_REL = 'ops/threshold-clock-baseline.json';
const INVENTORY_REL = 'ops/monitoring/monitoring-inventory.json';
const OWED_REL = 'ops/monitoring/owed-reads.json';
const TOKEN = 'THRESHOLD_CLOCK_VERDICT';
const SCOPED_EXT = /\.(ts|js|mjs|cjs|py|sh)$/;
const DATA_FILES = new Set([BASELINE_REL, INVENTORY_REL, OWED_REL]);
// The seeded size of the shrink-only baseline (OPS-THRESHOLD-CLOCK-W1, measured at the wave head).
// These are CEILINGS: a later wave that retires a site shrinks the baseline and stays under them.
const SEEDED_CLOCKS = 23;
const SEEDED_THRESHOLDS = 97;

type Row = { kind: string; file: string; site: string; reason: string; owner: string };

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function tokenLines(stdout: string): string[] {
  return stdout.split('\n').filter((l) => l.startsWith(`${TOKEN}=`));
}

function run(args: string[], gate = GATE) {
  return spawnSync('python3', [gate, ...args], { encoding: 'utf8' });
}

function baselineRows(root = REPO): Row[] {
  return (JSON.parse(readFileSync(path.join(root, BASELINE_REL), 'utf8')) as { sites: Row[] }).sites;
}

/**
 * A temp tree that is the REAL tree for everything either check reads (every scoped source file
 * under src/, ops/, scripts/ plus the inventory, the owed-reads registry and the baseline), so a
 * planted case differs from the passing case by exactly the planted bytes.
 */
function treeCopy(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'threshold-clock-'));
  tmpDirs.push(root);
  for (const top of ['src', 'ops', 'scripts']) {
    cpSync(path.join(REPO, top), path.join(root, top), {
      recursive: true,
      filter: (src) => {
        const base = path.basename(src);
        if (statSync(src).isDirectory()) return !(base.startsWith('.') || base === 'node_modules' || base === '__pycache__');
        const rel = path.relative(REPO, src).split(path.sep).join('/');
        return SCOPED_EXT.test(base) || DATA_FILES.has(rel);
      },
    });
  }
  return root;
}

/** A paging canary in Check T's scope, read from the inventory rather than named by hand. */
function aPagingCanary(): string {
  const inv = JSON.parse(readFileSync(path.join(REPO, INVENTORY_REL), 'utf8')) as {
    artifacts: { artifact?: string; alert_ids?: string[] }[];
  };
  const scoped = inv.artifacts
    .map((a) => ({ rel: a.artifact ?? '', ids: a.alert_ids ?? [] }))
    .filter((a) => /^ops\/monitoring\/[^/]+\.py$/.test(a.rel) && a.ids.length > 0)
    .map((a) => a.rel)
    .sort();
  expect(scoped.length).toBeGreaterThan(10);
  return scoped[0];
}

function aRealOwedReadId(): string {
  const reg = JSON.parse(readFileSync(path.join(REPO, OWED_REL), 'utf8')) as { reads: { id: string }[] };
  expect(reg.reads.length).toBeGreaterThan(0);
  return reg.reads[0].id;
}

describe('the gate on the real tree (AC1, AC5)', () => {
  it('PASSES with one token, exit 0, a non-empty scope for both checks and the positive lines', { timeout: 60_000 }, () => {
    const r = run([]);
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=PASS`]);
    expect(r.status).toBe(0);
    const scope = /scope: (\d+) clock files .* (\d+) paging canaries/.exec(r.stdout);
    expect(scope).not.toBeNull();
    expect(Number(scope![1])).toBeGreaterThan(100);
    expect(Number(scope![2])).toBeGreaterThan(10);
    expect(r.stdout).toMatch(/clocks baselined \d+ \(\d+ past due at \d{4}-\d{2}-\d{2} UTC\) · threshold sites baselined \d+ · registered \d+ · exempt \d+/);
    // the token is the LAST line: one terminal verdict
    expect(r.stdout.trimEnd().split('\n').pop()).toBe(`${TOKEN}=PASS`);
  });

  it('the baseline is exactly the debt in the tree, within its seeded ceilings, and every row is attributed', { timeout: 60_000 }, () => {
    const rows = baselineRows();
    const clocks = rows.filter((r) => r.kind === 'clock');
    const thresholds = rows.filter((r) => r.kind === 'threshold');
    expect(clocks.length + thresholds.length).toBe(rows.length);
    expect(clocks.length).toBeGreaterThan(0);
    expect(clocks.length).toBeLessThanOrEqual(SEEDED_CLOCKS);
    expect(thresholds.length).toBeLessThanOrEqual(SEEDED_THRESHOLDS);
    for (const s of rows) {
      expect(s.site.startsWith(`${s.file}::`)).toBe(true);
      expect(s.site).not.toMatch(/:\d+::/); // a site key never carries a line number
      expect(s.reason.length).toBeGreaterThan(10);
      expect(s.owner).toMatch(/\S/);
    }
    const r = run([]);
    expect(r.stdout).toMatch(/clocks: \d+ in tree · \d+ in baseline · 0 new · 0 stale/);
    expect(r.stdout).toMatch(/thresholds: \d+ in tree · \d+ in baseline · 0 new · 0 stale/);
  });

  it('a past-due baselined clock is REPORTED by name, never failed', { timeout: 60_000 }, () => {
    const r = run([]);
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=PASS`]);
    const due = /\((\d+) past due at/.exec(r.stdout);
    expect(due).not.toBeNull();
    const reported = r.stdout.split('\n').filter((l) => l.includes('PAST DUE (reported, never failed)'));
    expect(reported.length).toBe(Number(due![1]));
  });
});

describe('Check M — a planted prose clock in each root FAILS (AC2)', () => {
  it('the unplanted tree copy PASSES (the control)', { timeout: 60_000 }, () => {
    const r = run(['--root', treeCopy()]);
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=PASS`]);
    expect(r.status).toBe(0);
  });

  const PLANTS: { root: string; file: string; line: string }[] = [
    { root: 'src/', file: 'src/index.ts', line: '// TODO: revisit by 2027-01-01 — re-tune this pin' },
    { root: 'ops/', file: 'ops/monitoring/owed-read-runner.py', line: '# TODO: revisit by 2027-01-01 — re-tune this pin' },
    { root: 'scripts/', file: 'scripts/land.sh', line: '# TODO: revisit by 2027-01-01 — re-tune this pin' },
  ];
  for (const p of PLANTS) {
    it(`FAILS on a planted clock in ${p.root}`, { timeout: 60_000 }, () => {
      const root = treeCopy();
      appendFileSync(path.join(root, p.file), `\n${p.line}\n`);
      const r = run(['--root', root]);
      expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=FAIL`]);
      expect(r.status).toBe(1);
      const finding = r.stdout.split('\n').find((l) => l.includes('NEW dated revisit clock'));
      expect(finding).toBeDefined();
      expect(finding).toContain(p.file);
      expect(finding).toContain('owed-reads.json');
    });
  }
});

describe('Check T — a new pin in a copied paging canary (AC3)', () => {
  const canary = aPagingCanary();
  const realId = aRealOwedReadId();
  const plant = (marker: string) =>
    `\n\nNEW_PIN = 7${marker}\n\n\ndef _planted_pin_check(x):\n    if x > NEW_PIN:\n        return 1\n    return 0\n`;
  const CASES: { name: string; marker: string; want: 'PASS' | 'FAIL'; says?: string }[] = [
    { name: 'no marker FAILS', marker: '', want: 'FAIL', says: 'NEW threshold' },
    { name: 'a real owed-read id PASSES', marker: `  # threshold-revisit: ${realId}`, want: 'PASS' },
    { name: 'an unknown id FAILS', marker: '  # threshold-revisit: no-such-owed-read', want: 'FAIL', says: 'no-such-owed-read' },
    { name: 'a short exemption reason FAILS', marker: '  # threshold-exempt: short', want: 'FAIL', says: 'threshold-exempt' },
    { name: 'a reasoned exemption PASSES', marker: '  # threshold-exempt: protocol bound, not a calibration', want: 'PASS' },
  ];
  for (const c of CASES) {
    it(`NEW_PIN = 7 with \`if x > NEW_PIN:\` — ${c.name}`, { timeout: 60_000 }, () => {
      const root = treeCopy();
      appendFileSync(path.join(root, canary), plant(c.marker));
      const r = run(['--root', root]);
      expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=${c.want}`]);
      expect(r.status).toBe(c.want === 'PASS' ? 0 : 1);
      if (c.says) expect(r.stdout).toContain(c.says);
      if (c.want === 'FAIL' && !c.marker) expect(r.stdout).toContain('x > NEW_PIN');
    });
  }
});

describe('the baseline is SHRINK-ONLY (AC5)', () => {
  it('a removed site REPORTS, and --write-baseline drops exactly that one row', { timeout: 60_000 }, () => {
    const root = treeCopy();
    const before = baselineRows(root);
    const victim = before.find((r) => r.kind === 'clock')!;
    const text = victim.site.slice(victim.file.length + 2);
    const file = path.join(root, victim.file);
    const lines = readFileSync(file, 'utf8').split('\n');
    const at = lines.findIndex((l) => l.trim() === text);
    expect(at).toBeGreaterThanOrEqual(0);
    lines.splice(at, 1);
    writeFileSync(file, lines.join('\n'));

    const reported = run(['--root', root]);
    expect(tokenLines(reported.stdout)).toEqual([`${TOKEN}=PASS`]);
    const stale = reported.stdout.split('\n').filter((l) => l.includes('stale baseline row'));
    expect(stale.length).toBe(1);
    expect(stale[0]).toContain(victim.site);

    const shrunk = run(['--root', root, '--write-baseline']);
    expect(tokenLines(shrunk.stdout)).toEqual([`${TOKEN}=PASS`]);
    const after = baselineRows(root);
    expect(after.length).toBe(before.length - 1);
    expect(after).toEqual(before.filter((r) => r.site !== victim.site));
  });

  it('--write-baseline refuses to absorb a new site, and --init-baseline refuses when a baseline exists', { timeout: 60_000 }, () => {
    const root = treeCopy();
    const before = readFileSync(path.join(root, BASELINE_REL), 'utf8');
    appendFileSync(path.join(root, 'src/index.ts'), '\n// TODO: revisit by 2027-01-01\n');
    const absorb = run(['--root', root, '--write-baseline']);
    expect(tokenLines(absorb.stdout)).toEqual([`${TOKEN}=FAIL`]);
    const init = run(['--root', root, '--init-baseline']);
    expect(tokenLines(init.stdout)).toEqual([`${TOKEN}=FAIL`]);
    expect(readFileSync(path.join(root, BASELINE_REL), 'utf8')).toBe(before);
  });
});

describe('INDETERMINATE is evaluated first and is never a PASS', () => {
  const CASES: { name: string; mutate: (root: string) => void }[] = [
    { name: 'an unreadable owed-reads registry', mutate: (root) => writeFileSync(path.join(root, OWED_REL), '{not json') },
    { name: 'an unreadable baseline', mutate: (root) => writeFileSync(path.join(root, BASELINE_REL), '{not json') },
    { name: 'an absent baseline', mutate: (root) => rmSync(path.join(root, BASELINE_REL)) },
    { name: 'an unreadable inventory', mutate: (root) => writeFileSync(path.join(root, INVENTORY_REL), '{not json') },
    { name: 'a paging canary that does not parse', mutate: (root) => writeFileSync(path.join(root, aPagingCanary()), 'def broken(:\n') },
  ];
  for (const c of CASES) {
    it(`${c.name} → INDETERMINATE, exit 3`, { timeout: 60_000 }, () => {
      const root = treeCopy();
      c.mutate(root);
      const r = run(['--root', root]);
      expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=INDETERMINATE`]);
      expect(r.status).toBe(3);
    });
  }
});

describe('--self-test — hermetic, two-way, and PROVEN able to fail (AC4)', () => {
  it('PASSES with exactly one token', { timeout: 60_000 }, () => {
    const r = run(['--self-test']);
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=PASS`]);
    expect(r.status).toBe(0);
  });

  const src = readFileSync(GATE, 'utf8');
  const MUTATIONS: { name: string; from: string; to: string }[] = [
    { name: 'Check M broken: the clock needle never matches', from: 'CLOCK_RE = re.compile(', to: 'CLOCK_RE = re.compile("(?!x)x" + ' },
    { name: 'Check M broken: a new clock is not judged', from: 'new_clocks = sorted(k for k in clocks if k not in clock_base)', to: 'new_clocks = []' },
    { name: 'Check T broken: ordering comparisons not detected', from: 'ORDERING = (ast.Lt, ast.LtE, ast.Gt, ast.GtE)', to: 'ORDERING = ()' },
    { name: 'Check T broken: the local-carrier walk dropped', from: 'roots = _refs(b[1], names)', to: 'roots = frozenset()' },
    { name: 'Check T broken: a new threshold is not judged', from: 'new_thresholds = sorted(k for k in thresholds if k not in threshold_base)', to: 'new_thresholds = []' },
    { name: 'Check T broken: an unknown owed-read id accepted', from: 'if ident not in owed_ids:', to: 'if False:' },
    { name: 'Check T broken: exemption reason length not required', from: 'len(reason) < MIN_EXEMPT_REASON', to: 'False' },
    { name: 'an empty clock scope reads as PASS', from: '    if not clock_files:\n        return INDET', to: '    if False:\n        return INDET' },
    { name: 'an empty canary scope reads as PASS', from: '    if not canaries:\n        return INDET', to: '    if False:\n        return INDET' },
  ];
  for (const m of MUTATIONS) {
    it(`catches: ${m.name}`, { timeout: 60_000 }, () => {
      expect(src.includes(m.from)).toBe(true);
      const dir = mkdtempSync(path.join(tmpdir(), 'threshold-clock-mut-'));
      tmpDirs.push(dir);
      const file = path.join(dir, 'check-threshold-clock.py');
      writeFileSync(file, src.replace(m.from, m.to));
      const r = run(['--self-test'], file);
      expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=FAIL`]);
      expect(r.status).toBe(1);
    });
  }
});
