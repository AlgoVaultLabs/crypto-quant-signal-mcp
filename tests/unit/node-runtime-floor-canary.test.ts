/**
 * OPS-NODE-SECURITY-FLOOR-W1 CH2 R5 — the node_runtime_floor canary, pinned from outside.
 *
 * `ops/monitoring/node-runtime-floor-canary.py` runs from root's crontab on signal-1 and aoe-1.
 * Its `--self-test` drives every leg through a fake root, but a hermetic self-test is blind to
 * exactly what its own seam replaces: it never runs `main()`, so the token print, the exit-code
 * map, the paging argv, the state file and the result record are only ever exercised HERE — by
 * running the shipped file against a fake root (NODE_RUNTIME_ROOT), file:// floor sources, a stub
 * docker on PATH and a stub send_telegram.sh that writes down what it heard.
 *
 * Three more facts live outside the canary, and nothing else would notice them drift:
 *   · its floor derivation is a second copy of floorFromIndex() in
 *     scripts/check-runtime-node-security.mjs — parity on the same index fixtures;
 *   · the registry's ci-floating rows mirror every node-version line in .github/workflows/*.yml;
 *   · its container rows mirror docker-compose.yml's Node-built services and their FROM major.
 *
 * SPAWN BUDGET DECLARED — every block that runs python3 declares `timeout:` in its options
 * argument (scripts/check-test-budget.mjs reads it there, never as a trailing number).
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { floorFromIndex, nodeFromLines, nodeVersionsFromWorkflow } from '../../scripts/check-runtime-node-security.mjs';

const REPO = path.resolve(__dirname, '../..');
const PY = path.join(REPO, 'ops/monitoring/node-runtime-floor-canary.py');
const REGISTRY_FILE = path.join(REPO, 'ops/monitoring/node-runtime-registry.json');
const SRC = readFileSync(PY, 'utf8');
const REGISTRY = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8'));
const TOKEN = 'NODE_RUNTIME_FLOOR_VERDICT';
const TMP = realpathSync(mkdtempSync(path.join(tmpdir(), 'nrf-vitest-')));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

type Row = { id: string; host: string; kind: string; line: number; workflow?: string; node_version?: string; match?: Record<string, string> };

/** YYYY-MM-DD, `offset` whole days from now (UTC) — the canary judges dates against its own clock. */
function day(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

/** Every line that IS a terminal verdict token — anchored at column 0. */
function tokenLines(stdout: string): string[] {
  return stdout.split('\n').filter((l) => l.startsWith(`${TOKEN}=`));
}

/** A Node index both derivations accept: 30 non-security rows per line (18/20/22/24) plus `security`. */
function nodeIndex(security: Array<[string, string]>, extra: unknown[] = [], majors = [18, 20, 22, 24]): unknown[] {
  const rows: unknown[] = [];
  for (const M of majors) for (let p = 0; p < 30; p++) rows.push({ version: `v${M}.0.${p}`, date: '2026-01-01', security: false });
  for (const [version, date] of security) rows.push({ version, date, security: true });
  return [...rows, ...extra];
}

const SECURED = (): Array<[string, string]> => [['v24.22.1', day(-10)], ['v22.23.4', day(-10)]];

/** The committed floor file the canary reads from origin/main — here a file:// fixture. */
function floorFile(): string {
  return JSON.stringify({
    fetched_at: `${day(-1)}T00:00:00Z`,
    revisit_by: day(30),
    floor: { 22: { version: '22.23.4', date: day(-10) }, 24: { version: '24.22.1', date: day(-10) } },
  });
}

/** One registered host binary on signal-1 (the floor-check host), and one ci row it must ignore. */
const WORLD_REGISTRY = {
  floor_check_host: 'signal-1',
  runtimes: [
    { id: 'w-node', host: 'signal-1', kind: 'host-binary', measure: 'exec-version', line: 24, path: '/usr/bin/node' },
    { id: 'w-ci', host: 'ci', kind: 'ci-floating', measure: 'none', line: 24, workflow: '.github/workflows/x.yml', node_version: '24' },
  ],
};

interface WorldOpts {
  node?: string | null; // what /usr/bin/node -v prints; null = no host node at all
  stray?: boolean; // an unregistered node binary at /opt/stray/node
  indexRaw?: string; // the bytes served as the live index
  indexMissing?: boolean; // the live index URL names no file
  registry?: unknown;
  state?: object;
  label?: string;
}

interface World { dir: string; env: NodeJS.ProcessEnv; calls: string; state: string; results: string }

/**
 * A fake root the canary walks as if it were the host: /proc/self/mounts (one ext4 root), one
 * process (pid 100) whose exe is /usr/bin/node, a root crontab line invoking it, and the two floor
 * sources under /srv. Every effect path is redirected into the world's own directory.
 */
function world(name: string, o: WorldOpts = {}): World {
  const dir = path.join(TMP, name);
  const root = path.join(dir, 'root');
  for (const d of ['proc/self', 'proc/100', 'usr/bin', 'etc', 'srv', 'bin']) mkdirSync(path.join(root, d), { recursive: true });
  writeFileSync(path.join(root, 'proc/self/mounts'), '/dev/root / ext4 rw,relatime 0 0\n');
  const exe = path.join(root, 'usr/bin', o.node === null ? 'sleep' : 'node');
  writeFileSync(exe, `#!/bin/sh\necho ${o.node ?? 'v24.22.1'}\n`);
  chmodSync(exe, 0o755);
  symlinkSync(exe, path.join(root, 'proc/100/exe'));
  writeFileSync(path.join(root, 'proc/100/cgroup'), '0::/system.slice/cron.service\n');
  if (o.node !== null) writeFileSync(path.join(root, 'etc/crontab'), 'SHELL=/bin/sh\n17 * * * * root /usr/bin/node /opt/app/monitor.mjs >> /var/log/monitor.log 2>&1\n');
  if (o.stray) {
    mkdirSync(path.join(root, 'opt/stray'), { recursive: true });
    writeFileSync(path.join(root, 'opt/stray/node'), '#!/bin/sh\necho v24.22.1\n');
    chmodSync(path.join(root, 'opt/stray/node'), 0o755);
  }
  writeFileSync(path.join(root, 'srv/index.json'), o.indexRaw ?? JSON.stringify(nodeIndex(SECURED())));
  writeFileSync(path.join(root, 'srv/floor.json'), floorFile());

  const stubs = path.join(dir, 'stubs');
  mkdirSync(stubs);
  writeFileSync(path.join(stubs, 'docker'), '#!/bin/sh\nexit 0\n'); // no images, no containers
  chmodSync(path.join(stubs, 'docker'), 0o755);
  const calls = path.join(dir, 'calls.log');
  const wrapper = path.join(dir, 'send_telegram.sh');
  writeFileSync(wrapper, `#!/bin/sh\n{ printf 'ARGV:'; printf ' [%s]' "$@"; printf '\\nKEYS: %s\\n' "$ALERT_KEYS"; cat; printf '\\n--END--\\n'; } >> '${calls}'\n`);
  chmodSync(wrapper, 0o755);
  const registry = path.join(dir, 'registry.json');
  writeFileSync(registry, JSON.stringify(o.registry ?? WORLD_REGISTRY));
  const state = path.join(dir, 'state', 'node-runtime-floor-canary-state.json');
  if (o.state) {
    mkdirSync(path.dirname(state), { recursive: true });
    writeFileSync(state, JSON.stringify(o.state));
  }
  const results = path.join(dir, 'canary-results.jsonl');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${stubs}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    NODE_RUNTIME_ROOT: root,
    NODE_RUNTIME_INDEX_URL: `file://${root}/srv/${o.indexMissing ? 'absent.json' : 'index.json'}`,
    NODE_RUNTIME_FLOOR_URL: `file://${root}/srv/floor.json`,
    NODE_RUNTIME_FLOOR_STATE: state,
    NODE_RUNTIME_REGISTRY: registry,
    TG_WRAPPER: wrapper,
    CANARY_RESULT_LOG_PATH: results,
    MONITORING_HOST_LABEL: o.label ?? 'signal-1',
  };
  return { dir, env, calls, state, results };
}

/** Run the SHIPPED canary in a world. */
function run(w: World, ...args: string[]) {
  const r = spawnSync('python3', [PY, ...args], { env: w.env, encoding: 'utf8', timeout: 25_000 });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/** What the stub wrapper heard, one entry per invocation. */
function heard(w: World): Array<{ argv: string[]; keys: string; body: string }> {
  if (!existsSync(w.calls)) return [];
  return readFileSync(w.calls, 'utf8').split('\n--END--\n').filter((c) => c.trim()).map((c) => {
    const [argvLine, keysLine, ...body] = c.replace(/^\n/, '').split('\n');
    return { argv: [...argvLine.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]), keys: keysLine.replace(/^KEYS: ?/, ''), body: body.join('\n') };
  });
}

function lastRecord(w: World): Record<string, unknown> | null {
  if (!existsSync(w.results)) return null;
  const lines = readFileSync(w.results, 'utf8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

function pyJson(code: string, ...args: string[]): unknown {
  const r = spawnSync('python3', ['-c', code, ...args], { encoding: 'utf8', timeout: 25_000 });
  if (r.status !== 0) throw new Error(`python3 -c exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

describe('the shipped canary — self-test', () => {
  it('--self-test passes every check and prints exactly one SELF-TEST line', { timeout: 60_000 }, () => {
    const r = spawnSync('python3', [PY, '--self-test'], { encoding: 'utf8', timeout: 55_000 });
    const out = r.stdout ?? '';
    expect(r.status, out + r.stderr).toBe(0);
    expect(out.match(/^SELF-TEST: .*$/gm) ?? []).toHaveLength(1);
    const m = /^SELF-TEST: PASS \((\d+) checks\)$/m.exec(out);
    expect(m, out).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(150);
  });
});

describe('main() — verdict, exit code, paging argv, state and record', () => {
  it('PASS: exit 0, one final token, both alerts cleared, a PASS record from non-empty legs', { timeout: 30_000 }, () => {
    const w = world('pass');
    const r = run(w);
    expect(tokenLines(r.out), r.out + r.err).toEqual([`${TOKEN}=PASS`]);
    expect(r.out.trim().split('\n').pop()).toBe(`${TOKEN}=PASS`);
    expect(r.code).toBe(0);
    expect(heard(w).map((c) => c.argv.slice(0, 2))).toEqual([['--clear', 'NODE_RUNTIME_BEHIND'], ['--clear', 'NODE_RUNTIME_FLOOR_INDETERMINATE']]);
    expect(r.out).toMatch(/^CANARY_RESULT_LOG=line=\d+$/m);
    const rec = lastRecord(w);
    expect(rec).toMatchObject({ host: 'signal-1', canary: 'node_runtime_floor', verdict: 'PASS', exit_code: 0 });
    expect(rec!.metrics).toMatchObject({
      measured: { 'w-node': 'v24.22.1' }, floor_source: 'index+committed', keys_total: 0,
      legs: { pids: 1, node_processes: 1, disk_node_binaries: 1, node_refs: 1 },
    });
    expect(JSON.parse(readFileSync(w.state, 'utf8'))).toMatchObject({ last_verdict: 'PASS', last_behind_keys: [], indeterminate_since: null });
  });

  it('BEHIND: exit 1, one CRITICAL_PERSISTENT page keyed behind + overdue, Action line names {NEXT}', { timeout: 30_000 }, () => {
    const w = world('behind', { node: 'v24.21.0' });
    const r = run(w);
    expect(tokenLines(r.out), r.out + r.err).toEqual([`${TOKEN}=FAIL`]);
    expect(r.code).toBe(1);
    const h = heard(w);
    expect(h).toHaveLength(2);
    expect(h[0].argv).toEqual(['NODE_RUNTIME_BEHIND', 'CRITICAL_PERSISTENT', '-']);
    expect(h[0].keys.split(' ').sort()).toEqual(['behind:24.22.1', 'overdue:24.22.1']);
    const body = h[0].body.trim().split('\n');
    expect(body[0]).toBe('🛑 NODE_RUNTIME_BEHIND');
    expect(h[0].body).toContain('BEHIND: w-node is on Node v24.21.0, below the security floor 24.22.1');
    expect(body[body.length - 1]).toBe('Action: dispatch OPS-NODE-SECURITY-FLOOR-W{NEXT} via Cowork → Claude Code');
    expect(h[1].argv.slice(0, 2)).toEqual(['--clear', 'NODE_RUNTIME_FLOOR_INDETERMINATE']);
    expect(lastRecord(w)).toMatchObject({ verdict: 'FAIL', exit_code: 1 });
    expect(JSON.parse(readFileSync(w.state, 'utf8')).last_behind_keys).toEqual(['behind:24.22.1', 'overdue:24.22.1']);
  });

  it('UNREGISTERED: a node binary with no registry row FAILs under a host-scoped key', { timeout: 30_000 }, () => {
    const w = world('stray', { stray: true });
    const r = run(w);
    expect(tokenLines(r.out), r.out + r.err).toEqual([`${TOKEN}=FAIL`]);
    expect(r.code).toBe(1);
    expect(heard(w)[0].keys).toBe('unregistered:signal-1:/opt/stray/node');
  });

  it('INDETERMINATE: an unusable live index exits 3, pages nothing, clears only the IND alert', { timeout: 30_000 }, () => {
    const w = world('ind', { indexRaw: 'not json' });
    const r = run(w);
    expect(tokenLines(r.out), r.out + r.err).toEqual([`${TOKEN}=INDETERMINATE`]);
    expect(r.code).toBe(3);
    expect(r.out).toContain('INDETERMINATE the live floor is unavailable (the index is not JSON');
    expect(heard(w).map((c) => c.argv.slice(0, 2))).toEqual([['--clear', 'NODE_RUNTIME_FLOOR_INDETERMINATE']]);
    expect(lastRecord(w)).toMatchObject({ verdict: 'INDETERMINATE', exit_code: 3 });
    expect(JSON.parse(readFileSync(w.state, 'utf8')).indeterminate_since).toBe(day(0));
  });

  it('the 3rd consecutive INDETERMINATE day pages NODE_RUNTIME_FLOOR_INDETERMINATE keyed since:<date>', { timeout: 30_000 }, () => {
    const since = day(-2);
    const w = world('ind3', { indexMissing: true, state: { indeterminate_since: since, last_verdict: 'INDETERMINATE', last_behind_keys: [] } });
    const r = run(w);
    expect(tokenLines(r.out), r.out + r.err).toEqual([`${TOKEN}=INDETERMINATE`]);
    const h = heard(w);
    expect(h).toHaveLength(1);
    expect(h[0].argv).toEqual(['NODE_RUNTIME_FLOOR_INDETERMINATE', 'CRITICAL_PERSISTENT', '-']);
    expect(h[0].keys).toBe(`since:${since}`);
    const body = h[0].body.trim().split('\n');
    expect(body[0]).toBe('🛑 NODE_RUNTIME_FLOOR_INDETERMINATE');
    expect(h[0].body).toContain(`INDETERMINATE for 3 consecutive days (since ${since})`);
    expect(body[body.length - 1]).toBe('Action: dispatch OPS-NODE-RUNTIME-FLOOR-CANARY-W{NEXT} via Cowork → Claude Code');
  });

  it('a registry it cannot use is INDETERMINATE, never a vacuous PASS', { timeout: 30_000 }, () => {
    const w = world('noreg', { registry: { floor_check_host: 'signal-1', runtimes: [] } });
    const r = run(w);
    expect(tokenLines(r.out), r.out + r.err).toEqual([`${TOKEN}=INDETERMINATE`]);
    expect(r.code).toBe(3);
    expect(r.out).toContain('the registry has no `runtimes` rows');
  });

  it('an unknown host label is INDETERMINATE', { timeout: 30_000 }, () => {
    const w = world('mars', { label: 'mars' });
    const r = run(w);
    expect(tokenLines(r.out), r.out + r.err).toEqual([`${TOKEN}=INDETERMINATE`]);
    expect(r.code).toBe(3);
    expect(r.out).toContain("the host label 'mars'");
  });

  it('--dry-run judges every leg but pages, clears, records and writes nothing', { timeout: 30_000 }, () => {
    const w = world('dry', { node: 'v24.21.0' });
    const r = run(w, '--dry-run');
    expect(tokenLines(r.out), r.out + r.err).toEqual([`${TOKEN}=FAIL`]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('dry-run: would page NODE_RUNTIME_BEHIND keys=behind:24.22.1 overdue:24.22.1');
    expect(heard(w)).toEqual([]);
    expect(existsSync(w.state)).toBe(false);
    expect(existsSync(w.results)).toBe(false);
  });

  it('aoe-1 under the REAL registry is enumeration only: nothing measured, no floor fetched, PASS', { timeout: 30_000 }, () => {
    // The index URL names no file: a run that fetched it would read INDETERMINATE.
    const w = world('aoe1', { node: null, indexMissing: true, label: 'aoe-1', registry: REGISTRY });
    const r = run(w);
    expect(tokenLines(r.out), r.out + r.err).toEqual([`${TOKEN}=PASS`]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('note registry row aoe-1-bdir-harness names image node:20-bookworm-slim, which is not on this host');
    expect(lastRecord(w)).toMatchObject({ host: 'aoe-1', verdict: 'PASS', metrics: { measured: {}, floor_source: 'none' } });
  });
});

describe('floor derivation parity — the canary and the gate derive the same floor from every index', () => {
  type Line24 = { version: string; date: string };
  // [name, index, the outcome both must reach, line 24's floor when it is ok]
  const CASES: Array<[string, unknown, boolean, Line24?]> = [
    ['a normal index; 24.100.0 outranks 24.22.1 numerically', nodeIndex([['v24.22.1', '2026-10-20'], ['v24.9.0', '2026-05-01'], ['v24.100.0', '2026-12-01'], ['v22.23.4', '2026-10-20']]), true, { version: '24.100.0', date: '2026-12-01' }],
    ['v-less versions count; rc tags, nulls and bare strings are skipped', nodeIndex([['24.30.0', '2026-10-21']], [null, 'v24.0.0', { version: 'v24.31.0-rc.1', date: '2026-10-22', security: true }]), true, { version: '24.30.0', date: '2026-10-21' }],
    ['a line with no security release floors to null', nodeIndex([['v24.22.1', '2026-10-20']]), true, { version: '24.22.1', date: '2026-10-20' }],
    ['not an array', { rows: nodeIndex(SECURED()) }, false],
    ['fewer than 100 release rows', nodeIndex(SECURED()).slice(-60), false],
    ['no security release at all', nodeIndex([]), false],
    ['no line at or above 24', nodeIndex([['v22.23.4', '2026-10-20']], [], [18, 20, 22, 23]), false],
    ['a security row with no valid date', nodeIndex([['v24.22.1', 'yesterday']]), false],
    ['a numeric date', nodeIndex([['v24.22.1', '2026-10-20']], [{ version: 'v24.22.2', date: 20261021, security: true }]), false],
    ['a date wrapped in an array', nodeIndex([['v24.22.1', '2026-10-20']], [{ version: 'v24.22.2', date: ['2026-10-21'], security: true }]), false],
    ['a non-boolean security field', nodeIndex([['v24.22.1', '2026-10-20']], [{ version: 'v24.1.0', date: '2026-01-01', security: 'true' }]), false],
  ];

  it('agrees on every case, and each case reaches the outcome it was written for', { timeout: 60_000 }, () => {
    CASES.forEach(([name, idx, ok, line24], i) => {
      const file = path.join(TMP, `parity-${i}.json`);
      writeFileSync(file, JSON.stringify(idx));
      const r = spawnSync('python3', [PY, '--derive-floor', file], { encoding: 'utf8', timeout: 25_000 });
      expect(r.status, `${name}: ${r.stderr}`).toBe(0);
      const js = floorFromIndex(idx);
      expect(JSON.parse(r.stdout), name).toEqual(js);
      expect(js.ok, name).toBe(ok);
      if (ok) expect(js.floor['24'], name).toEqual(line24);
      else expect(js.reason, name).toMatch(/\S/);
    });
    expect(CASES.filter((c) => c[2]).length).toBeGreaterThanOrEqual(3);
    expect(CASES.filter((c) => !c[2]).length).toBeGreaterThanOrEqual(6);
  });
});

describe('the registry — validated by the canary itself, and a mirror of the repo', () => {
  const VALIDATE = [
    'import importlib.util, json, sys',
    'spec = importlib.util.spec_from_file_location("nrf", sys.argv[1])',
    'm = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(m)',
    'doc = json.load(open(sys.argv[2], encoding="utf-8"))',
    'out = {}',
    'for h in m.HOSTS:',
    '    reg, err = m.validate_registry(doc, h)',
    '    out[h] = {"err": err, "mine": [r["id"] for r in reg["mine"]] if reg else []}',
    'print(json.dumps(out))',
  ].join('\n');

  it("validates for signal-1 and aoe-1 through the canary's own validator", { timeout: 30_000 }, () => {
    const out = pyJson(VALIDATE, PY, REGISTRY_FILE) as Record<string, { err: string | null; mine: string[] }>;
    expect(out['signal-1']).toEqual({ err: null, mine: REGISTRY.runtimes.filter((r: Row) => r.host === 'signal-1').map((r: Row) => r.id) });
    expect(out['aoe-1']).toEqual({ err: null, mine: ['aoe-1-bdir-harness'] });
  });

  it('its ci-floating rows are exactly the node-version lines of .github/workflows/*.yml', () => {
    const dir = path.join(REPO, '.github/workflows');
    const found = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort().flatMap((f) =>
      nodeVersionsFromWorkflow(readFileSync(path.join(dir, f), 'utf8')).map((v: { file: boolean; value: string }) => ({ workflow: `.github/workflows/${f}`, ...v })));
    // A node-version-file line names no version a registry row can hold: decide it, never skip it.
    expect(found.filter((v) => v.file)).toEqual([]);
    const declared = [...new Set(found.map((v) => `${v.workflow}|${v.value}`))].sort();
    expect(declared.length).toBeGreaterThanOrEqual(7);
    const ci = REGISTRY.runtimes.filter((r: Row) => r.kind === 'ci-floating');
    expect(ci.map((r: Row) => `${r.workflow}|${r.node_version}`).sort()).toEqual(declared);
    for (const r of ci) expect(r.line, r.id).toBe(Number(/^(\d+)/.exec(r.node_version ?? '')?.[1]));
  });

  it("its container rows are exactly docker-compose.yml's Node-built services, on their FROM major", () => {
    const compose = yaml.load(readFileSync(path.join(REPO, 'docker-compose.yml'), 'utf8')) as {
      name?: string; services: Record<string, { build?: string | { context?: string; dockerfile?: string } }>;
    };
    // No top-level `name:`: the compose project is the deploy checkout's directory name.
    expect(compose.name).toBeUndefined();
    expect(readFileSync(path.join(REPO, '.github/workflows/deploy.yml'), 'utf8')).toMatch(/cd \/opt\/crypto-quant-signal-mcp\b/);
    const built = Object.entries(compose.services).flatMap(([service, s]) => {
      if (!s.build) return [];
      const b = typeof s.build === 'string' ? { context: s.build, dockerfile: undefined } : s.build;
      const froms = nodeFromLines(readFileSync(path.join(REPO, b.context ?? '.', b.dockerfile ?? 'Dockerfile'), 'utf8'));
      return froms.length ? [{ service, majors: [...new Set(froms.map((f: { tag: string | null }) => Number(/^(\d+)/.exec(f.tag ?? '')?.[1])))] }] : [];
    });
    expect(built.length).toBeGreaterThanOrEqual(2);
    const rows = REGISTRY.runtimes.filter((r: Row) => r.kind === 'container');
    expect(rows.map((r: Row) => r.match?.compose_service).sort()).toEqual(built.map((b) => b.service).sort());
    for (const b of built) {
      const row = rows.find((r: Row) => r.match?.compose_service === b.service);
      expect(row?.match?.compose_project, b.service).toBe('crypto-quant-signal-mcp');
      expect(b.majors, b.service).toEqual([row?.line]);
    }
  });
});

describe('alert vocabulary', () => {
  it('both alert ids are declared page-on-change on both hosts, owned by this canary', () => {
    const reg = JSON.parse(readFileSync(path.join(REPO, 'ops/monitoring/alert-registry.json'), 'utf8'));
    for (const id of ['NODE_RUNTIME_BEHIND', 'NODE_RUNTIME_FLOOR_INDETERMINATE']) {
      const row = reg.alerts.find((a: { alert_id: string }) => a.alert_id === id);
      expect(row, id).toMatchObject({ owner: 'ops/monitoring/node-runtime-floor-canary.py', page_on: 'change', adopted: true });
      expect([...row.hosts].sort()).toEqual(['aoe-1', 'signal-1']);
      expect(SRC).toContain(`"${id}", "CRITICAL_PERSISTENT"`);
    }
  });

  it('the next-wave names are templates, never a hardcoded number', () => {
    expect(SRC).toContain('BEHIND_WAVE = "OPS-NODE-SECURITY-FLOOR-W{NEXT}"');
    expect(SRC).toContain('IND_WAVE = "OPS-NODE-RUNTIME-FLOOR-CANARY-W{NEXT}"');
    expect(SRC).not.toMatch(/OPS-NODE-RUNTIME-FLOOR-CANARY-W\d/);
  });
});
