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
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
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

/** The declared file set, parsed out of the script itself — the script IS the SoT for it. */
function declaredSet(): { name: string; key: string; min: number }[] {
  const src = readFileSync(SCRIPT, 'utf8');
  const block = /DECLARATIONS=\(([\s\S]*?)\n\)/.exec(src);
  if (!block) throw new Error('could not locate the DECLARATIONS array in the script');
  return [...block[1].matchAll(/"([^"|]+)\|([^"|]+)\|(\d+)"/g)].map((m) => ({
    name: m[1], key: m[2], min: Number(m[3]),
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
