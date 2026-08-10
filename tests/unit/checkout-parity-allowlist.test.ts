/**
 * OPS-CHECKOUT-PARITY-ALLOWLIST-DERIVE-W1 — the checkout-parity allowlist is DERIVED, not copied.
 *
 * `ops/cron/checkout-parity.sh` fired 🛑 CHECKOUT_PARITY_SIGNAL_MCP daily on `docs-src/template.html`
 * — a file that is legitimate, DECLARED output of the deploy-time SoT injector. The alert was right
 * about the fact and wrong about the meaning, which is the kind that gets muted.
 *
 * Root cause: two files independently asserted "which paths does the deploy-time generator
 * rewrite", and only `scripts/snapshot-landing-manifest.json` was the SoT. The hand-mirrored copy in
 * `ops/deploy/checkout-parity.conf` went stale three times across two waves (97fc7ef, 736f257,
 * cf84bc3) — every one of them a commit that added an injector target and left the conf untouched.
 *
 * This file is the standing repo-side guard for the derivation. Before this wave the canary had NO
 * test at all, only its own `--self-test`.
 *
 * Everything here drives the REAL bash — the real conf parser, the real resolver, the real glob
 * matcher — through the script's `CHECKOUT_PARITY_LIB_ONLY` seam. Re-implementing that matching in
 * TypeScript would be a second derivation of the exact fact this wave exists to stop duplicating.
 */
import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Every case spawns bash, which spawns node. Budgets here follow the measured precedent in
 * tests/unit/push-safety.test.ts: under concurrent gates (many checkouts share one pre-push hook)
 * the failures in this class were TIMEOUTS, never assertions.
 */
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

const REPO = resolve(__dirname, '..', '..');
const HELPER = join(REPO, 'scripts', 'injector-target-set.mjs');
const CANARY = join(REPO, 'ops', 'cron', 'checkout-parity.sh');
const CONF = join(REPO, 'ops', 'deploy', 'checkout-parity.conf');
const MANIFEST = join(REPO, 'scripts', 'snapshot-landing-manifest.json');

/**
 * The regression this wave exists for: the targets no static `allow` glob ever covered.
 *
 * NARROWED 2026-08-10 by HOLD-DEEMPHASIS-SWEEP-W1, and the narrowing is the POINT of deriving
 * this set rather than hand-writing it. `docs-src/partials/faq.html` and
 * `docs-src/partials/pricing.html` were named by exactly ONE manifest row — `dtrf-hold-rate` —
 * which retired with the rendered HOLD Rate stat. The injector therefore no longer writes those
 * two files, so they must NOT stay in the parity allowlist: an allowlist entry for a path nothing
 * dirties is a hole that would silently excuse a real foreign edit there.
 *
 * They are kept here as a NEGATIVE assertion below rather than deleted, so that re-adding a
 * docs-src injector row without re-deriving the allowlist fails instead of passing quietly.
 * `docs-src/template.html` still has a live row and stays POSITIVE.
 */
const LEAKED = ['docs-src/template.html'];

/** Named by `dtrf-hold-rate` alone; must LEAVE the derived set now that the row is retired. */
const DERIVED_OUT_AFTER_HOLD_RETIREMENT = [
  'docs-src/partials/faq.html',
  'docs-src/partials/pricing.html',
];

/** Run the helper and return its stdout path list + the single stderr verdict token. */
function derive(manifestPath: string): { paths: string[]; token: string; code: number } {
  const r = spawnSync(process.execPath, [HELPER, '--manifest', manifestPath], { encoding: 'utf8' });
  const tokenLine = (r.stderr || '').split('\n').filter((l) => l.startsWith('INJECTOR_TARGET_SET_VERDICT='));
  expect(tokenLine, 'exactly one verdict token on stderr').toHaveLength(1);
  return {
    paths: (r.stdout || '').split('\n').filter(Boolean),
    token: tokenLine[0].split('=')[1].split(' ')[0],
    code: r.status ?? -1,
  };
}

/**
 * Ask the canary itself whether `dirtyPath` would be reported, using a caller-supplied conf and a
 * service checkout at `base`. Empty stdout ⇒ the path is COVERED (silent); non-empty ⇒ it would be
 * reported and the canary would go RED.
 *
 * `set +u` after the source is load-bearing: the canary sets `-uo pipefail` at the top, sourcing
 * inherits it, and on bash 3.2 — what macOS ships, and where the pre-push gate runs — `"${arr[@]}"`
 * on an EMPTY array is an unbound-variable error that kills the shell (`exit 127`, empty stdout).
 * The uncovered half of the two-way proof IS the empty-derived-set case, so without this the test
 * reads a dead shell as "covered" and the proof inverts. The canary's own live path is unaffected:
 * it expands `"${DERIVED[@]:-}"`, and the `:-` is exactly this guard.
 */
function wouldReport(confPath: string, base: string, dirtyPath: string): string {
  const driver = `
set -o pipefail
CHECKOUT_PARITY_LIB_ONLY=1 source "$1"
set +u
allows=(); while IFS= read -r l; do [ -n "$l" ] && allows+=("$l"); done < <(conf_allows "$2" svc)
rows=();   while IFS= read -r l; do [ -n "$l" ] && rows+=("$l");   done < <(conf_allow_manifests "$2" svc)
derived=()
if [ "\${#rows[@]}" -gt 0 ]; then
  while IFS= read -r l; do [ -n "$l" ] && derived+=("$l"); done < <(resolve_manifest_allows "$3" "\${rows[@]}")
fi
filter_dirty " M $4" "\${allows[@]}" "\${derived[@]}"
`;
  const r = spawnSync('bash', ['-c', driver, 'driver', CANARY, confPath, base, dirtyPath], {
    encoding: 'utf8',
  });
  expect(r.error, 'bash driver spawned').toBeUndefined();
  // A shell that DIED produces empty stdout, which is indistinguishable from "covered" — the exact
  // way this proof silently inverted while being written. Assert the driver actually ran.
  expect(r.status, `bash driver exited ${r.status}: ${r.stderr}`).toBe(0);
  return (r.stdout || '').trim();
}

/** A throwaway service checkout carrying a fixture manifest. */
function fixtureService(claims: unknown[]): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'cparity-allow-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'm.json'), JSON.stringify({ claims }));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('injector target set — derived from the manifest that declares it', () => {
  it('covers the docs-src paths the hand-written allowlist never did', () => {
    const { paths, token, code } = derive(MANIFEST);
    expect(token).toBe('PASS');
    expect(code).toBe(0);
    for (const p of LEAKED) expect(paths, `${p} must be derived`).toContain(p);
  });

  it('DROPS a path whose only manifest row retired — the allowlist narrows with the injector', () => {
    // The two-way half of the proof. HOLD-DEEMPHASIS-SWEEP-W1 retired `dtrf-hold-rate`, the sole
    // row naming these files. A derived allowlist must shrink here; a hand-written one would have
    // kept excusing foreign edits to files the injector no longer touches. If a future wave
    // re-adds a docs-src injector row, this fails and forces the allowlist to be re-derived
    // together with it.
    const { paths } = derive(MANIFEST);
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    for (const p of DERIVED_OUT_AFTER_HOLD_RETIREMENT) {
      const rows = manifest.claims.filter(
        (r: { apply_to_files?: string[] }) => (r.apply_to_files ?? []).includes(p),
      );
      // Guard the guard: this only asserts absence while NO row claims the path.
      expect(rows, `${p} regained a manifest row — re-derive the allowlist`).toHaveLength(0);
      expect(paths, `${p} must NOT be derived once its only row retired`).not.toContain(p);
    }
  });

  it('is non-empty and has not silently collapsed', () => {
    const { paths } = derive(MANIFEST);
    // Step-0 baseline 2026-08-06: 30 claims -> 55 distinct targets. A FLOOR, never an equality —
    // the set grows every time a claim gains a page, and pinning 55 would make that a build break.
    expect(paths.length).toBeGreaterThanOrEqual(50);
    expect(new Set(paths).size).toBe(paths.length); // de-duplicated
  });

  it('is order-independent — a function of our rule, not of iteration order', () => {
    const live = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    const baseline = derive(MANIFEST).paths;

    const dir = mkdtempSync(join(tmpdir(), 'cparity-shuffle-'));
    try {
      // Deterministic reversal + an interleave, so the test cannot flake on a lucky shuffle.
      for (const [name, claims] of [
        ['rev.json', [...live.claims].reverse()],
        ['interleave.json', [...live.claims.filter((_: unknown, i: number) => i % 2), ...live.claims.filter((_: unknown, i: number) => !(i % 2))]],
      ] as [string, unknown[]][]) {
        const p = join(dir, name);
        writeFileSync(p, JSON.stringify({ ...live, claims }));
        expect(derive(p).paths, `${name} must derive the identical sorted set`).toEqual(baseline);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('REFUSES rather than reporting an empty set (fail-closed, both vacuity shapes)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cparity-refuse-'));
    try {
      const cases: [string, string][] = [
        ['missing.json', ''], // never written
        ['bad.json', '{ not json'],
        ['noclaims.json', '{"sot_endpoints":{}}'],
        ['empty.json', '{"claims":[]}'],
        ['zero.json', '{"claims":[{"id":"a","apply_to_files":[]}]}'],
      ];
      for (const [name, body] of cases) {
        const p = join(dir, name);
        if (body) writeFileSync(p, body);
        const r = derive(p);
        expect(r.token, `${name} must refuse`).toBe('INDETERMINATE');
        expect(r.code, `${name} must exit 3`).toBe(3);
        expect(r.paths, `${name} must emit no partial set`).toEqual([]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the allow_manifest row does real work', () => {
  /**
   * The two-way proof. A target declared ONLY in the manifest and matched by NO static glob is
   * silent WITH the `allow_manifest` row and reported WITHOUT it. Without this the row could be
   * inert and every other assertion here would still be green.
   */
  it('covers a manifest-only target with the row, and reports it without the row', () => {
    const svc = fixtureService([{ id: 'synthetic', apply_to_files: ['docs-src/partials/synthetic.html'] }]);
    const confDir = mkdtempSync(join(tmpdir(), 'cparity-conf-'));
    try {
      const withRow = join(confDir, 'with.conf');
      const withoutRow = join(confDir, 'without.conf');
      const statics = ['service  svc  /opt/svc:root:root', 'allow    svc  README.md', 'allow    svc  landing/*.html'].join('\n');
      writeFileSync(withRow, `${statics}\nallow_manifest  svc  scripts/m.json\n`);
      writeFileSync(withoutRow, `${statics}\n`);

      const target = 'docs-src/partials/synthetic.html';
      expect(wouldReport(withRow, svc.dir, target), 'covered by derivation').toBe('');
      expect(wouldReport(withoutRow, svc.dir, target), 'uncovered without the row').toBe(`M ${target}`);

      // …and derivation must not blind the canary to an ordinary source edit.
      expect(wouldReport(withRow, svc.dir, 'src/index.ts')).toBe('M src/index.ts');
      // …while the static superset keeps doing its own job.
      expect(wouldReport(withRow, svc.dir, 'landing/integrations/alpaca.html')).toBe('');
    } finally {
      svc.cleanup();
      rmSync(confDir, { recursive: true, force: true });
    }
  });

  it('the live conf declares the derivation and no longer enumerates the leaked paths', () => {
    // Comments are STRIPPED first. The conf's prose names docs-src/ to record WHY the copy went
    // stale, and that explanation is the most valuable thing in the file — CLAUDE.md's own rule is
    // to strip comments before grepping source for a banned construct, precisely so a gate cannot
    // demand the deletion of its own rationale.
    const rows = readFileSync(CONF, 'utf8')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l) && l.trim() !== '');
    expect(rows.some((l) => /^allow_manifest\s+crypto-quant-signal-mcp\s+scripts\/snapshot-landing-manifest\.json/.test(l))).toBe(true);
    for (const p of LEAKED) {
      expect(rows.some((l) => l.includes(p)), `${p} must be DERIVED, never enumerated`).toBe(false);
    }
    // The static superset is deliberately KEPT — it also covers the `cp landing/*.html` webroot sync.
    expect(rows.filter((l) => /^allow\s+crypto-quant-signal-mcp/.test(l))).toHaveLength(2);
  });
});

describe('both gates self-test cleanly', () => {
  it('the helper: exit 0 and exactly one verdict token', () => {
    const r = spawnSync(process.execPath, [HELPER, '--self-test'], { encoding: 'utf8' });
    const tokens = `${r.stdout}${r.stderr}`.split('\n').filter((l) => l.includes('INJECTOR_TARGET_SET_VERDICT='));
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toContain('=PASS');
    expect(r.status).toBe(0);
  });

  it('the canary: exit 0 and exactly one verdict token', () => {
    const r = spawnSync('bash', [CANARY, '--self-test'], { encoding: 'utf8' });
    const tokens = `${r.stdout}${r.stderr}`.split('\n').filter((l) => l.includes('CHECKOUT_PARITY_VERDICT='));
    expect(tokens, r.stdout + r.stderr).toHaveLength(1);
    expect(tokens[0]).toContain('=PASS');
    expect(r.status).toBe(0);
  });
});
