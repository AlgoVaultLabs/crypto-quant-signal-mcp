/**
 * OPS-MONITORING-INVENTORY-HOST-SYNC-W1 — the declaration-sync contract, guarded in-repo.
 *
 * `ops/monitoring/declaration-sync.sh` runs UNATTENDED ON TWO HOSTS and replaces the files the
 * reconciler reads. Its dangerous failure mode is not crashing — it is succeeding against the
 * wrong premise: a declared filename that no longer exists, a required key that was renamed, or
 * a refusal floor that has drifted above the live value and will reject a perfectly good file.
 *
 * None of those are visible on the host until the sync has already been silently wrong, and the
 * host has no test harness. So the premises are asserted HERE, against the committed files, where
 * a wrong one fails a push instead of a production sync.
 *
 * The runtime behaviour (fetch / validate / atomic swap) is covered by the script's own
 * `--self-test`, which this file also runs — a gate whose own logic is broken must never be
 * allowed to report on a corpus.
 */
import {
  describe, it, expect, beforeAll, afterAll,
} from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  readFileSync, existsSync, statSync, mkdtempSync, mkdirSync, writeFileSync,
  chmodSync, rmSync, readdirSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'ops/monitoring/declaration-sync.sh');
const INVENTORY = path.join(ROOT, 'ops/monitoring/monitoring-inventory.json');

function run(...args: string[]): { out: string; code: number } {
  try {
    return { out: execFileSync('bash', [SCRIPT, ...args], { encoding: 'utf8' }), code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, code: err.status ?? 1 };
  }
}

/**
 * The declared file set, parsed out of the script itself — the script IS the SoT for it.
 *
 * The 4th field (host scope) was added by OPS-DECLARATION-SYNC-YAML-W1 and is REQUIRED: the regex
 * will not match a 3-field row, so an entry written in the old shape fails the vacuity guard below
 * rather than being silently parsed with an undefined scope and synced everywhere.
 */
function declaredSet(): { name: string; key: string; min: number; scope: string }[] {
  const src = readFileSync(SCRIPT, 'utf8');
  const block = /DECLARATIONS=\(([\s\S]*?)\n\)/.exec(src);
  if (!block) throw new Error('could not locate the DECLARATIONS array in the script');
  return [...block[1].matchAll(/"([^"|]+)\|([^"|]+)\|(\d+)\|([^"]+)"/g)].map((m) => ({
    name: m[1], key: m[2], min: Number(m[3]), scope: m[4].trim(),
  }));
}

describe('declaration-sync — verdict contract', () => {
  it('is committed executable (cron invokes it directly on both hosts)', () => {
    expect(existsSync(SCRIPT)).toBe(true);
    // eslint-disable-next-line no-bitwise
    expect(statSync(SCRIPT).mode & 0o111, 'script must carry an exec bit').toBeGreaterThan(0);
  });

  it('--self-test passes, is not vacuous, and prints exactly ONE terminal verdict token', () => {
    const r = run('--self-test');
    const tokens = r.out.split('\n').filter((l) => l.startsWith('DECLARATION_SYNC_VERDICT='));
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toBe('DECLARATION_SYNC_VERDICT=UNCHANGED');
    expect(r.code).toBe(0);
    const m = /self-test: (\d+) checks passed/.exec(r.out);
    expect(m, 'the self-test must report how many checks it ran').not.toBeNull();
    expect(Number(m![1]), 'a self-test reporting ~0 checks is vacuous').toBeGreaterThan(10);
  });
});

/**
 * Parse a declaration by EXTENSION, exactly as the script's `validate_body` does.
 *
 * YAML goes through `python3 -c` + PyYAML rather than a node dependency: it adds nothing to
 * package.json, and — more usefully — it is the SAME parser the host runs, so a body this test
 * accepts cannot be one the host's validator rejects. A node YAML library would be a second
 * implementation of the parse, free to disagree with the one that actually gates production.
 */
function loadDeclaration(p: string): Record<string, unknown> {
  if (!/\.ya?ml$/i.test(p)) return JSON.parse(readFileSync(p, 'utf8'));
  const out = execFileSync(
    'python3',
    ['-c', 'import sys,json,yaml;json.dump(yaml.safe_load(open(sys.argv[1],encoding="utf-8")),sys.stdout)', p],
    { encoding: 'utf8' },
  );
  return JSON.parse(out);
}

describe('the declared set is true of the repo', () => {
  const declared = declaredSet();

  it('is non-empty — an empty set would make the whole sync a silent no-op', () => {
    expect(declared.length).toBeGreaterThan(0);
  });

  it.each(declared)('$name — exists, carries key "$key", and sits above its refusal floor', (d) => {
    const p = path.join(ROOT, 'ops/monitoring', d.name);
    expect(existsSync(p), `${d.name} is declared for sync but absent from ops/monitoring/`).toBe(true);

    const doc = loadDeclaration(p);
    expect(doc[d.key], `${d.name}: required top-level key "${d.key}" is absent — the host sync would refuse every fetch`).toBeDefined();

    if (d.min > 0) {
      const n = Object.keys(doc[d.key]).length;
      // The floor must stay BELOW the live value. If a file legitimately shrinks past its floor,
      // the sync starts refusing a healthy declaration and the hosts silently freeze — the floor
      // is a truncation guard, never a policy minimum.
      expect(n, `${d.name}: live count ${n} is at/below the refusal floor ${d.min} — the sync would reject this healthy file`).toBeGreaterThan(d.min);
    }
  });

  it('covers monitoring-inventory.json — the file the reconciler actually reads', () => {
    expect(declared.map((d) => d.name)).toContain('monitoring-inventory.json');
  });
});

describe('registration', () => {
  const rows = JSON.parse(readFileSync(INVENTORY, 'utf8')).artifacts as Record<string, unknown>[];
  const row = rows.find((r) => r.id === 'declaration-sync');

  it('has an inventory row — an unregistered host artifact is exactly what this wave retires', () => {
    expect(row, 'no inventory row with id "declaration-sync"').toBeTruthy();
    expect(row!.artifact).toBe('ops/monitoring/declaration-sync.sh');
  });

  it('enumerates BOTH hosts in installed_at (a two-host artifact tracked on one host forks)', () => {
    const hosts = (row!.installed_at as { host: string }[]).map((e) => e.host).sort();
    expect(hosts).toEqual(['aoe-1', 'signal-1']);
  });

  it('its recorded sha256 matches the committed bytes', async () => {
    const { createHash } = await import('node:crypto');
    const actual = createHash('sha256').update(readFileSync(SCRIPT)).digest('hex');
    expect(row!.sha256, 'inventory sha256 is stale — re-stamp it in the same commit as the edit').toBe(actual);
  });

  it('names a TEMPLATED recommended wave, never a literal W<N>', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).toMatch(/OPS-[A-Z-]+-W\{NEXT\}/);
    expect(/RECOMMENDED_WAVE=['"]?OPS-[A-Z-]+-W\d/.test(src), 'a hardcoded wave number is forbidden').toBe(false);
  });
});

describe('SOT_PARITY config — REPORT-first must be a property, not a claim', () => {
  // These assertions started life inside monitoring-inventory-reconcile.py's --self-test, where
  // they read the file via REPO_ROOT. That is correct in a checkout and resolves to `/ops/...`
  // on a host, so the self-test crashed with FileNotFoundError on BOTH production boxes — the
  // exact REPO_ROOT defect that file's own docstring records. They belong here: a committed file
  // is a repo-side corpus, and that self-test's contract is hermetic.
  const cfg = JSON.parse(
    readFileSync(path.join(ROOT, 'ops/monitoring/sot-parity-config.json'), 'utf8'),
  );

  it('ships enforcement=report — a checker on a transport with known lag must not block', () => {
    expect(cfg.enforcement).toBe('report');
  });

  it('records a NUMERIC promotion criterion, so report→block is countable not a vibe', () => {
    expect(cfg._promotion_criterion, 'no promotion criterion recorded').toBeTruthy();
    expect(/\d+/.test(cfg._promotion_criterion), 'the criterion states no number').toBe(true);
  });

  it('names the SoT it compares against over https', () => {
    expect(String(cfg.sot_url)).toMatch(/^https:\/\//);
    expect(String(cfg.sot_url)).toContain('ops/monitoring/monitoring-inventory.json');
  });
});

describe('the auto-install prohibition is structurally respected', () => {
  // BROADENED 2026-08-10 by OPS-DECLARATION-SYNC-YAML-W1: `.json` -> a DATA-format allowlist.
  //
  // The boundary this protects is "inert data flows automatically, executable code never does".
  // `.json` was standing in for that, and it was a fine proxy right up to the moment a YAML
  // declaration needed syncing — at which point the proxy would have blocked the fix while the
  // actual invariant was never in question. So the invariant is now stated directly, in both
  // directions: an allowlist of data formats AND an explicit refusal of executable extensions.
  // Asserting the denylist separately matters — an allowlist alone silently permits whatever a
  // future edit adds to it, and "we widened the allowlist" is exactly how `.sh` would arrive.
  const DATA_FORMATS = /\.(json|ya?ml)$/;
  const EXECUTABLE = /\.(sh|bash|py|mjs|cjs|js|ts|rb|pl|php|exe)$/i;

  it('every declared file is an inert DATA declaration (.json / .yaml)', () => {
    for (const d of declaredSet()) {
      expect(d.name, `${d.name} is not a recognised data-declaration format`).toMatch(DATA_FORMATS);
    }
  });

  it('no declared file is executable code — the prohibition, stated as itself', () => {
    // A .sh/.py/.mjs here would make an unattended job install privileged code on two hosts,
    // which CLAUDE.md forbids outright. The inventory carries three `kind: test` .py artifacts on
    // the host precisely so this is not hypothetical: they are host-installed, they are NOT here,
    // and the derived-coverage check below is required to keep exempting them for that reason.
    for (const d of declaredSet()) {
      expect(d.name, `${d.name} is executable code and must never be auto-installed`)
        .not.toMatch(EXECUTABLE);
    }
  });
});

/**
 * THE GENERATOR FIX (OPS-DECLARATION-SYNC-YAML-W1).
 *
 * Everything above asserts that the declared set is TRUE. Nothing asserted it was COMPLETE — so
 * the set was maintained by memory, and memory lost. Measured at Step 0: FIVE host-consumed
 * in-repo declarations had no sync path at all, and only three were the YAML this wave is named
 * for. `venue-slo-tiers.json` and `OPS-SEED-ORCHESTRATOR-W1-baseline.json` are JSON and had simply
 * never been added — which is the whole argument for deriving coverage instead of adding a format:
 * a hand-maintained set drifts in whatever shape nobody happens to be thinking about.
 *
 * So completeness is now DERIVED from the inventory — the SoT that already enumerates every host
 * artifact — and asserted here. Adding a host declaration without wiring the sync fails the build.
 *
 * The set stays hand-written IN THE SCRIPT on purpose: a separate config file would itself be a
 * declaration needing a sync, the recursion declaration-sync exists to end. Deriving the
 * REQUIREMENT in-repo while leaving the RUNTIME set self-contained keeps both properties.
 */
describe('the declared set is COMPLETE against the inventory, not just correct', () => {
  type Row = {
    id: string; kind: string; artifact?: string; host_path?: string;
    repo?: string; repo_resident?: boolean; sync_exempt_reason?: string;
  };
  const rows: Row[] = JSON.parse(readFileSync(INVENTORY, 'utf8')).artifacts;
  const base = (p?: string) => (p ? path.basename(p) : '');

  /** Why this row is NOT required to be synced, or null when it IS required. Structural only. */
  function exemption(r: Row): string | null {
    if (r.kind === 'executable') return 'executable artifact — auto-install forbidden';
    if (/\.(sh|py|mjs|cjs|js|rb|pl)$/i.test(base(r.host_path))) {
      return 'host file is executable code — auto-install forbidden';
    }
    if (r.repo) return `owned by repo=${r.repo} — not in this checkout`;
    if (r.repo_resident) return 'repo_resident — the host consumes it from its git checkout';
    if (!r.artifact || r.artifact.startsWith('external:')) return 'no in-repo artifact';
    if (!existsSync(path.join(ROOT, r.artifact))) return `artifact absent: ${r.artifact}`;
    if (!r.host_path || r.host_path === 'n-a') return 'no host copy exists';
    // Escape hatch for a genuine judgement call — on the ROW, with a reason, never in prose.
    if (r.sync_exempt_reason) return `declared: ${r.sync_exempt_reason}`;
    return null;
  }

  const required = rows.filter((r) => exemption(r) === null);
  const declared = declaredSet().map((d) => d.name);

  it('the derived requirement is non-empty (vacuity guard)', () => {
    // WE build this corpus from a file we author, so empty means the derivation broke — a defect
    // in the test, not a fact about the world. Refuse rather than report a pass over nothing.
    expect(required.length, 'the required set derived to EMPTY — the predicate is broken').
      toBeGreaterThanOrEqual(8);
  });

  it('every host-consumed in-repo declaration is in the declared set', () => {
    const missing = required
      .filter((r) => !declared.includes(base(r.host_path)))
      .map((r) => `${r.id} (${base(r.host_path)}) <- ${r.artifact}`);
    expect(
      missing,
      'These inventory rows are host-consumed in-repo declarations with NO sync path. Add each to '
        + 'DECLARATIONS in ops/monitoring/declaration-sync.sh as <file>|<required-key>|<floor>, or '
        + 'record a `sync_exempt_reason` on the row if it genuinely must not be auto-synced:\n  '
        + missing.join('\n  '),
    ).toEqual([]);
  });

  it('every EXEMPT row is exempt for a structural or declared reason — never by omission', () => {
    // The other half. Without this, the check above is satisfiable by weakening `exemption()`.
    for (const r of rows) {
      const why = exemption(r);
      if (why === null) continue;
      expect(why.length, `${r.id} has an empty exemption reason`).toBeGreaterThan(10);
      if (why.startsWith('declared: ')) {
        expect(r.sync_exempt_reason!.length, `${r.id}: sync_exempt_reason is not substantive`)
          .toBeGreaterThan(25);
      }
    }
  });

  it('nothing is declared that the inventory does not know about', () => {
    // Reverse direction: a declared file with no inventory row is an artifact this repo installs
    // on two hosts while the registry that governs host artifacts has never heard of it.
    const known = new Set(rows.map((r) => base(r.host_path)));
    const orphans = declared.filter((n) => !known.has(n));
    expect(orphans, `declared but absent from the inventory: ${orphans.join(', ')}`).toEqual([]);
  });

  it('every entry declares a host scope drawn from the labels the inventory knows', () => {
    // The scope decides what each host installs. An unknown label starves a host silently (the
    // file is declared, matches nobody, and is never written) — indistinguishable from healthy.
    const known = new Set<string>();
    for (const r of rows) for (const e of (r as { installed_at?: { host: string }[] }).installed_at ?? []) {
      if (e.host) known.add(e.host);
    }
    expect(known.size, 'the inventory declares no host labels at all').toBeGreaterThanOrEqual(2);
    for (const d of declaredSet()) {
      expect(d.scope.length, `${d.name} has an empty host scope`).toBeGreaterThan(0);
      if (d.scope === '*') continue;
      for (const label of d.scope.split(',').map((s) => s.trim())) {
        expect(known.has(label), `${d.name} is scoped to unknown host label '${label}'`).toBe(true);
      }
    }
  });

  it('a host-specific declaration is NOT scoped to every host', () => {
    // The measured regression this wave shipped and then fixed: syncing signal-only canary configs
    // to aoe-1 turned all five into `CHECK ORPHAN: BREACH` there within a minute, because that box
    // reads none of them. `*` must mean "every host genuinely consumes this", never "unsure".
    const signalOnly = [
      'website-drift-manifest.yaml', 'postgres-cpu-autopilot-registry.yaml',
      'recommendation-drift-manifest.yaml', 'venue-slo-tiers.json',
      'OPS-SEED-ORCHESTRATOR-W1-baseline.json',
    ];
    for (const name of signalOnly) {
      const d = declaredSet().find((x) => x.name === name);
      expect(d, `${name} left the declared set`).toBeTruthy();
      expect(d!.scope, `${name} must stay host-scoped — '*' plants it as an ORPHAN elsewhere`)
        .not.toBe('*');
    }
  });

  it('reports its own breadth, so a silent narrowing is visible', () => {
    const exempt = rows.length - required.length;
    // eslint-disable-next-line no-console
    console.log(
      `  declaration-sync coverage: ${required.length} required / ${declared.length} declared / `
        + `${exempt} structurally exempt of ${rows.length} inventory rows`,
    );
    expect(declared.length).toBeGreaterThanOrEqual(required.length);
  });
});

/**
 * OPS-MONITORING-INVENTORY-RESTORE-W1 R3 — a sync that CANNOT RUN must be as audible as one that
 * failed.
 *
 * The script was fail-closed per ROW (every non-200, parse failure, key/floor refusal and size
 * collapse alerts) but not per PROCESS: each precondition below exited INDETERMINATE 3 without
 * ever calling alert(), so the sync could be completely dead while nothing paged. Exit code and
 * token are unchanged; what these assert is that the verdict is now DELIVERED.
 *
 * The dispatching spec named FOUR preconditions. There are FIVE — `mktemp -d` is the one it did
 * not list, and it is the realistic one: a full or read-only /tmp stops the sync dead.
 */
describe('R3 — every precondition that ends the run ALERTS before exiting 3', () => {
  const TMP = mkdtempSync(path.join(tmpdir(), 'declsync-r3-'));
  const TG = path.join(TMP, 'tg.sh');
  const RECORD = path.join(TMP, 'tg.out');
  const DEST = path.join(TMP, 'dest');

  beforeAll(() => {
    mkdirSync(DEST, { recursive: true });
    // A recording stand-in for send_telegram.sh. The wrapper still OWNS severity, cooldown and
    // DRY_RUN — this only proves the consumer reaches it, and with what.
    writeFileSync(TG, `#!/bin/sh\ncat >> "${RECORD}"\necho "TG-CALL id=$1 sev=$2" >> "${RECORD}"\n`);
    chmodSync(TG, 0o755);
  });
  afterAll(() => rmSync(TMP, { recursive: true, force: true }));

  /** A real PATH minus exactly ONE binary — the honest simulation of "it is not installed". */
  function pathWithout(binary: string): string {
    const dir = path.join(TMP, `path-no-${binary}`);
    mkdirSync(dir, { recursive: true });
    for (const src of ['/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
      if (!existsSync(src)) continue;
      for (const entry of readdirSync(src)) {
        if (entry === binary) continue;
        const link = path.join(dir, entry);
        if (!existsSync(link)) {
          try { symlinkSync(path.join(src, entry), link); } catch { /* dup/perm — harmless */ }
        }
      }
    }
    return dir;
  }

  function attempt(env: Record<string, string>): { out: string; code: number; calls: number; sev: string } {
    writeFileSync(RECORD, '');
    let out = ''; let code = 0;
    try {
      out = execFileSync('bash', [SCRIPT], {
        encoding: 'utf8',
        env: {
          ...process.env,
          ALGOVAULT_TG_TEST_INERT: '1',
          DECLARATION_SYNC_TG: TG,
          DECLARATION_SYNC_LOG: path.join(TMP, 'log'),
          DECLARATION_SYNC_HEARTBEAT: path.join(TMP, 'hb'),
          DECLARATION_SYNC_DEST_DIR: DEST,
          ...env,
        },
      });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; status?: number };
      out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
      code = err.status ?? 1;
    }
    const rec = existsSync(RECORD) ? readFileSync(RECORD, 'utf8') : '';
    return {
      out,
      code,
      calls: (rec.match(/TG-CALL/g) ?? []).length,
      sev: /TG-CALL id=\S+ sev=(\S+)/.exec(rec)?.[1] ?? '',
    };
  }

  // Each case is (label, env that breaks exactly one precondition, the phrase the body must carry).
  const CASES: [string, () => Record<string, string>, string][] = [
    ['curl missing', () => ({ PATH: pathWithout('curl') }), 'curl is not installed'],
    ['python3 missing', () => ({ PATH: pathWithout('python3') }), 'python3 is not installed'],
    ['dest dir absent', () => ({ DECLARATION_SYNC_DEST_DIR: path.join(TMP, 'nope') }), 'does not exist'],
    ['mktemp fails', () => ({ TMPDIR: path.join(TMP, 'nope') }), 'cannot create a work dir'],
  ];

  for (const [label, envFor, phrase] of CASES) {
    it(`${label} -> INDETERMINATE 3 AND an alert`, () => {
      const r = attempt(envFor());
      expect(r.out, 'the terminal token is the contract, never the bare exit code')
        .toContain('DECLARATION_SYNC_VERDICT=INDETERMINATE');
      expect(r.code, 'INDETERMINATE is 3 — the token-law default for this gate').toBe(3);
      expect(r.calls, `${label} exited silently — this is the whole defect R3 closes`).toBe(1);
      expect(r.sev, 'severity is the wrapper contract, not a local invention').toBe('CRITICAL_PERSISTENT');
      expect(r.out).toContain(phrase);
    });
  }

  // PyYAML is the 5th path and needs a python3 that imports everything EXCEPT yaml.
  it('PyYAML missing -> INDETERMINATE 3 AND an alert', () => {
    const dir = path.join(TMP, 'path-no-yaml');
    mkdirSync(dir, { recursive: true });
    const realPy = execFileSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).trim();
    const shim = path.join(dir, 'python3');
    writeFileSync(shim, `#!/bin/sh\nif [ "$1" = "-c" ]; then case "$2" in *yaml*) exit 1;; esac; fi\nexec ${realPy} "$@"\n`);
    chmodSync(shim, 0o755);
    const r = attempt({ PATH: `${dir}:${process.env.PATH}` });
    expect(r.out).toContain('DECLARATION_SYNC_VERDICT=INDETERMINATE');
    expect(r.code).toBe(3);
    expect(r.calls).toBe(1);
    expect(r.sev).toBe('CRITICAL_PERSISTENT');
    expect(r.out).toContain('PyYAML is unavailable');
  });

  it('stamps the ATTEMPT heartbeat BEFORE the precondition that ends the run', () => {
    // The ordering IS the feature. Stamped after the preconditions, an INDETERMINATE exit would be
    // indistinguishable from a cron that never fired — and telling those apart is the entire point
    // of R4's liveness check downstream.
    const r = attempt({ DECLARATION_SYNC_DEST_DIR: path.join(TMP, 'nope') });
    expect(r.code).toBe(3);
    const hb = readFileSync(path.join(TMP, 'hb'), 'utf8');
    expect(hb, 'no attempt_at — a dead-on-arrival run must still record that it attempted')
      .toMatch(/attempt_at=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
    expect(hb, 'the terminal verdict must be recorded too, or wedged reads as never-ran')
      .toContain('verdict=INDETERMINATE');
  });

  it('the --self-test writes NEITHER the heartbeat NOR the log (it must stay hermetic)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'declsync-hermetic-'));
    const hb = path.join(dir, 'hb');
    const log = path.join(dir, 'log');
    execFileSync('bash', [SCRIPT, '--self-test'], {
      encoding: 'utf8',
      env: { ...process.env, DECLARATION_SYNC_HEARTBEAT: hb, DECLARATION_SYNC_LOG: log },
    });
    expect(existsSync(hb), 'the hermetic suite must never stamp a liveness heartbeat').toBe(false);
    expect(existsSync(log), 'the hermetic suite must never write the operational log').toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * R3 — the LOG destination is DECLARED in the committed file.
 *
 * Before this wave the only record of a run went wherever the crontab redirect happened to send
 * stdout: an UNCOMMITTED destination, so the committed script described none of its own history.
 */
describe('R3 — LOG= is declared, matching the sibling convention', () => {
  const SIBLINGS = [
    'ops/monitoring/stripe-webhook-events-canary.sh',
    'ops/monitoring/closedbar-w1-liveness.sh',
    'ops/monitoring/send_telegram.sh',
  ];

  it('declares a LOG= under /var/log, in the shape its siblings use', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    const m = /^LOG=.*$/m.exec(src);
    expect(m, 'no LOG= line — the sync\'s history would live only in an uncommitted crontab redirect')
      .toBeTruthy();
    expect(m![0]).toMatch(/^LOG=\$\{DECLARATION_SYNC_LOG:-\/var\/log\/[a-z0-9.-]+\.log\}$/);
  });

  it('the siblings it claims to match really do declare one (no vacuous convention)', () => {
    // A convention asserted against zero real examples is not a convention. If these siblings ever
    // drop their LOG=, this claim must fail rather than quietly become decoration.
    for (const rel of SIBLINGS) {
      const src = readFileSync(path.join(ROOT, rel), 'utf8');
      expect(/^LOG=/m.test(src), `${rel} no longer declares a LOG=`).toBe(true);
    }
  });

  it('the declared path is the one both crontabs already redirect to', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).toContain('LOG=${DECLARATION_SYNC_LOG:-/var/log/declaration-sync.log}');
  });
});

/**
 * OPS-MONITORING-INVENTORY-RESTORE-W1 R4/R6 — the reconciler's own `--self-test` is invoked by
 * NOTHING.
 *
 * Measured at e82f888: no test and no workflow ran `monitoring-inventory-reconcile.py --self-test`,
 * so its ~150 assertions — including every SOT_PARITY and SYNC_LIVENESS case — only ever ran when
 * a human remembered to. A suite nobody runs is the dark-guard class this estate has been bitten
 * by repeatedly, one level up: not a guard that cannot fire, but a guard whose own tests cannot.
 */
describe('the reconciler self-test actually runs in CI', () => {
  const RECONCILER = path.join(ROOT, 'ops/monitoring/monitoring-inventory-reconcile.py');

  it('passes, and reports a non-vacuous check count', () => {
    let out = '';
    try {
      out = execFileSync('python3', [RECONCILER, '--self-test'], { encoding: 'utf8' });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      throw new Error(`reconciler --self-test FAILED:\n${err.stdout ?? ''}${err.stderr ?? ''}`);
    }
    const m = /SELF_TEST (PASS|FAIL) checks=(\d+) failures=(\d+)/.exec(out);
    expect(m, 'no terminal SELF_TEST summary line').toBeTruthy();
    expect(m![1]).toBe('PASS');
    expect(Number(m![3])).toBe(0);
    // A vacuity floor, not an exact count: the suite grows, and pinning the number would make
    // every added assertion a failing test.
    expect(Number(m![2]), 'the suite reported suspiciously few checks').toBeGreaterThan(100);
  });

  it('SYNC_LIVENESS is wired into the drift set and the positive per-run output', () => {
    const src = readFileSync(RECONCILER, 'utf8');
    // Registered as a real finding key, not merely defined.
    expect(src).toMatch(/"SYNC_LIVENESS": \(sync_liveness_result or \{\}\)\.get\("findings"/);
    // In the drift set: a stopped sync is operator-action-required, not a standing report.
    const driftBlock = /drift_keys = \(([\s\S]*?)\)\n/.exec(src);
    expect(driftBlock, 'could not locate drift_keys').toBeTruthy();
    expect(driftBlock![1]).toContain('SYNC_LIVENESS');
    // Positive output on EVERY run — silence must never be the pass signal.
    expect(src).toContain('log(f"SYNC_LIVENESS {row[\'host\']} {row[\'verdict\']} ');
  });

  it('the liveness bound is DERIVED, never a hardcoded literal', () => {
    const src = readFileSync(RECONCILER, 'utf8');
    expect(src).toContain('bound = cadence * SYNC_LIVENESS_MISSED_CYCLES');
    // The multiplier is a declared policy constant (like PENDING_STALE_DAYS); the BOUND is not.
    expect(src).toMatch(/SYNC_LIVENESS_MISSED_CYCLES = max\(1, int\(os\.environ\.get\(/);
    // And the derivation must genuinely read the schedule — proven end-to-end by the Python
    // suite's "the derived bound TRACKS the schedule" case, which fails if this becomes a literal.
    expect(src).toContain('def derive_cadence_minutes(expr)');
  });
});
