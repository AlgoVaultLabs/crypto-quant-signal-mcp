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

describe('the declared set is true of the repo', () => {
  const declared = declaredSet();

  it('is non-empty — an empty set would make the whole sync a silent no-op', () => {
    expect(declared.length).toBeGreaterThan(0);
  });

  it.each(declared)('$name — exists, carries key "$key", and sits above its refusal floor', (d) => {
    const p = path.join(ROOT, 'ops/monitoring', d.name);
    expect(existsSync(p), `${d.name} is declared for sync but absent from ops/monitoring/`).toBe(true);

    const doc = JSON.parse(readFileSync(p, 'utf8'));
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
  it('every declared file is a .json DECLARATION — never an executable artifact', () => {
    // This is the boundary the whole wave rests on: declarations flow automatically, artifacts
    // do not. A .sh/.py/.mjs entering this list would make an unattended job install privileged
    // code, which CLAUDE.md forbids outright.
    for (const d of declaredSet()) {
      expect(d.name, `${d.name} is not a .json declaration`).toMatch(/\.json$/);
    }
  });
});
