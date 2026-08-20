/**
 * AUTH-THREE-STATE-W1 CH3 — the conformance gate, and the consumers it keeps honest.
 *
 * Source-assertion suite (hence `tests/unit/`, matching `referral-existence-guard.test.ts`): what
 * is pinned here is that the GATE has teeth and that every consumer branches on the outcome rather
 * than on key-truthiness.
 *
 * 🛑 NO FIXTURE IS EVER WRITTEN INTO `src/`. A test that mutates a shared repo file mid-suite races
 * every other test file the parallel runner has in flight — the writer passes and some unrelated
 * reader flakes, which is the exact failure this repo has already paid for once. The FAIL path is
 * exercised by running the real CLI inside a THROWAWAY git repo in the OS temp dir, so the real
 * exit-code mapping is proven without touching this tree.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  strip,
  stripTypeBlocks,
  runRules,
  isLicenseLiteral,
  hasOutcome,
  isDefectShape,
} from '../../scripts/check-credential-outcome-conformance.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATE = join(ROOT, 'scripts', 'check-credential-outcome-conformance.mjs');
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/**
 * Run the gate CLI; never throws — returns the real status and stdout.
 *
 * `gatePath` matters: the gate resolves its ROOT from its OWN location, not from cwd, so the
 * throwaway-repo cases must invoke the COPY inside the temp tree. Passing the repo's own path with
 * a different cwd silently re-scans this tree — which is what the first version of these two tests
 * did, and they duly reported 305 files and a PASS.
 */
function runGate(args: string[] = [], cwd = ROOT, gatePath = GATE): { status: number; out: string } {
  try {
    const out = execFileSync('node', [gatePath, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('the gate on the real tree', () => {
  it('emits exactly ONE terminal verdict token, and it is PASS at exit 0', () => {
    const { status, out } = runGate();
    const tokens = out.match(/CREDENTIAL_OUTCOME_VERDICT=[A-Z]+/g) ?? [];
    expect(tokens).toEqual(['CREDENTIAL_OUTCOME_VERDICT=PASS']);
    expect(status).toBe(0);
  });

  it('reports its corpus size, so a scan that found nothing cannot read as a clean tree', () => {
    // "Print the CORPUS SIZE beside every zero result" — a sweep that searched nothing looks
    // exactly like a clean one.
    const { out } = runGate();
    expect(out).toMatch(/\d+ tracked src files/);
    expect(out).toMatch(/\d+ LicenseInfo literal\(s\)/);
  });

  it('--self-test passes, and its own fixtures go through the REAL extractors', () => {
    const { status, out } = runGate(['--self-test']);
    expect(out).toContain('SELF-TEST: PASS');
    expect(status).toBe(0);
    // A hermetic self-test is blind to exactly what its seam replaces, so it must also assert the
    // BYPASSED artifact — the parse of real src/.
    expect(out).toContain('bypassed artifact: real src/ parses to a plausible corpus');
  });
});

describe('the gate can FAIL — proven end to end, in a throwaway repo', () => {
  it('a synthetic collapse drives the real CLI to FAIL at exit 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'credgate-'));
    try {
      mkdirSync(join(dir, 'src', 'lib'), { recursive: true });
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      // THE defect shape, verbatim: the object four different realities used to share.
      writeFileSync(
        join(dir, 'src', 'lib', 'collapsed.ts'),
        "export function resolve() {\n  return { tier: 'free', key: null };\n}\n",
      );
      const gate = join(dir, 'scripts', 'check-credential-outcome-conformance.mjs');
      copyFileSync(GATE, gate);
      execSync('git init -q && git add -A', { cwd: dir, stdio: 'ignore' });

      const { status, out } = runGate([], dir, gate);
      expect(out).toContain('CREDENTIAL_OUTCOME_VERDICT=FAIL');
      // The token→EXIT-CODE mapping is asserted, not just the token. A prior gate in this repo
      // asserted verdict tokens but never the mapping, so re-coding INDETERMINATE to 0 left it
      // fully green.
      expect(status).toBe(1);
      expect(out).toMatch(/R2 .*collapsed\.ts/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an EMPTY corpus is INDETERMINATE at exit 3 — fail-closed, never a pass', () => {
    const dir = mkdtempSync(join(tmpdir(), 'credgate-empty-'));
    try {
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      const gate = join(dir, 'scripts', 'check-credential-outcome-conformance.mjs');
      copyFileSync(GATE, gate);
      execSync('git init -q', { cwd: dir, stdio: 'ignore' });
      const { status, out } = runGate([], dir, gate);
      // We CONSTRUCT this list, so empty means the walker broke — the vacuity guard belongs here,
      // at construction, not at observation.
      expect(out).toContain('CREDENTIAL_OUTCOME_VERDICT=INDETERMINATE');
      expect(status).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('declares 0=PASS / 1=FAIL / 3=INDETERMINATE — the token-law default for a NEW gate', () => {
    // 3, deliberately NOT check_test_baseline.sh's 2. That script uses 2 only because it already
    // deployed 2; one meaning, one code, chosen locally.
    expect(src('scripts/check-credential-outcome-conformance.mjs'))
      .toMatch(/EXIT_FOR\s*=\s*\{\s*PASS:\s*0,\s*FAIL:\s*1,\s*INDETERMINATE:\s*3\s*\}/);
  });
});

describe('the extractors discriminate structurally', () => {
  it('a TYPE declaration is not a construction', () => {
    const decl = 'export interface LicenseInfo { tier: LicenseTier; key: string | null; }';
    expect(stripTypeBlocks(decl).includes('tier')).toBe(false);
    // …and the same members as a LITERAL still register.
    expect(isLicenseLiteral("{ tier: 'free', key: null }")).toBe(true);
  });

  it('shorthand and explicit `outcome` both count as stamped', () => {
    expect(hasOutcome("{ tier: 'free', key: null, outcome: 'ABSENT' }")).toBe(true);
    expect(hasOutcome('{ outcome, tier, key }')).toBe(true);
    expect(hasOutcome("{ tier: 'free', key: null }")).toBe(false);
  });

  it('the stripper does not eat real code — the gate reads every rule through it', () => {
    // Over-stripping is the DANGEROUS direction for a gate that asserts absence: every violation
    // inside the deleted span reads as clean and the run prints a confident PASS. The naive
    // two-regex stripper removed 60% of src/index.ts and 64% of src/lib/license.ts, both x402
    // grants included. These are the three constructs that did it.
    expect(strip("const a = { key: null, url: 'https://x.y/z' }; const b = 1;")).toContain('const b = 1');
    expect(strip("const re = /a\\/b/; const b = 1;")).toContain('const b = 1');
    expect(strip("const s = '/*'; const b = 1;")).toContain('const b = 1');
    // …and the real files keep the code the consumer assertions below look for.
    expect(strip(src('src/lib/license.ts'))).toContain("{ tier: 'x402', key: null, outcome: 'RESOLVED' }");
    expect(strip(src('src/index.ts'))).toContain('refuseOwner(res, license');
  });

  it('comments are stripped before every ban-grep', () => {
    // The explanatory prose is the most valuable text in these files; a naive grep would demand
    // its deletion. The gate's own docblock quotes the defect shape verbatim.
    expect(isDefectShape("{ tier: 'free', key: null }")).toBe(true);
    expect(runRules(new Map([['src/x.ts', strip("// return { tier: 'free', key: null };")]]), []).findings).toEqual([]);
  });
});

describe('every consumer branches on the outcome', () => {
  it('the 4 webhook routes route their 401 through refuseOwner, not authRequired', () => {
    const s = strip(src('src/lib/webhook-api.ts'));
    expect((s.match(/if \(!ownerKey\) return refuseOwner\(res, license\);/g) ?? []).length).toBe(4);
    expect(s).not.toMatch(/if \(!ownerKey\) return authRequired\(/);
    // ABSENT/MALFORMED must still get today's message byte-for-byte — nothing a working caller
    // sees may move.
    expect(s).toContain('An API key is required to own a webhook subscription.');
  });

  it('these routes KEEP their 401 — the /mcp 200 rule is not copied here', () => {
    const s = strip(src('src/lib/credential-refusal.ts'));
    expect(s).toMatch(/refuseCredentialHttp[\s\S]*res\.status\(401\)/);
    // …while /mcp answers 200, because a 401 there starts OAuth discovery we do not serve.
    expect(strip(src('src/index.ts'))).toMatch(/res\.status\(200\)\.json\(\{ jsonrpc: '2\.0', id: body\?\.id \?\? null, error: decision\.error \}\)/);
  });

  it('/api/performance-shadow branches too, keeping its own ABSENT message', () => {
    expect(strip(src('src/index.ts'))).toContain("refuseOwner(res, license, 'An API key is required.')");
  });

  it('apiKeyExists projects from the outcome, not from key-presence', () => {
    const s = strip(src('src/lib/account-handlers.ts'));
    expect(s).toContain("credentialOutcomeOf(license) === 'RESOLVED'");
    expect(s).not.toMatch(/license\.key !== null/);
  });

  it('/api/chat refuses BEFORE it meters', () => {
    const s = strip(src('src/index.ts'));
    const route = s.slice(s.indexOf("app.post('/api/chat'"));
    const iRefuse = route.indexOf('refuseCredentialHttp(res, outcome)');
    const iMeter = route.indexOf('chatQuotaApiKey(');
    expect(iRefuse).toBeGreaterThan(-1);
    expect(iRefuse).toBeLessThan(iMeter);
  });

  it('the kill switch reaches the REST surfaces too, so one lever rolls back everything', () => {
    // Otherwise AUTH_STRICT_UNKNOWN=0 would leave REST refusing while /mcp serves — a rollback
    // that only half-rolls-back is worse than none.
    const s = strip(src('src/lib/webhook-api.ts'));
    expect(s).toMatch(/isRefusingOutcome\(outcome\) && isStrictUnknownEnabled\(\)/);
    expect(strip(src('src/index.ts'))).toMatch(/isRefusingOutcome\(outcome\) && isStrictUnknownEnabled\(\)/);
  });
});

describe('x402 is unaffected — checked, not assumed', () => {
  it('the /x402/* paywall still gates on the TIER and never consults the outcome', () => {
    const s = strip(src('src/lib/x402-http-routes.ts'));
    expect(s).toContain("license.tier !== 'x402'");
    expect(s).not.toContain('credentialOutcomeOf');
    expect(s).not.toContain('refuseCredential');
    expect(s).not.toContain('decideRefusal');
  });

  it('an x402 grant is stamped RESOLVED, so the refusal can never reach a paying rail', () => {
    const s = strip(src('src/lib/license.ts'));
    // Both grants — unbound (HTTP/webhook authz) and tool-bound.
    expect((s.match(/\{ tier: 'x402', key: null, outcome: 'RESOLVED' \}/g) ?? []).length).toBe(2);
  });

  it('so do the OTHER paid rails — the inheritors this wave was meant to cover', () => {
    // "Any NEW paid rail calls one resolver, gets the five states, and cannot re-invent the
    // collapse." These two were found BY the gate, not by the spec's list.
    for (const f of ['src/lib/okx-a2mcp.ts', 'src/channels/acp/seller-worker.ts']) {
      expect(strip(src(f)), f).toContain("outcome: 'RESOLVED'");
    }
  });
});
