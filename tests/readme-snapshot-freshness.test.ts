/**
 * OPS-README-GIT-CHANNEL-PRODUCER-W1 CH2 R4 — the git-channel band gate.
 *
 * These cases drive the SAME pure `evaluate()` the shipped `--check` calls, so the asserted
 * decision and the shipped decision cannot drift. The gate's own `--self-test` covers the same
 * ground plus the artifacts its fixture seam bypasses; this file is what makes the contract fail
 * in CI and in the pre-push test gate, where nobody has to remember to run a script.
 *
 * The three real claims and their real bands are asserted against the REAL manifest at the
 * bottom: a suite that only ever sees synthetic claims is blind to the manifest losing a row,
 * which is the failure this gate exists to notice.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error — .mjs sibling with no type declarations; the exports are plain JS.
import {
  evaluate,
  mapCode,
  BANDS,
  parseLiteral,
  extractCommitted,
  captureGroupCount,
  loadReadmeClaims,
} from '../scripts/check-readme-snapshot-freshness.mjs';

const REPO = resolve(__dirname, '..');

/** A README-targeting claim as `evaluate` sees it, after fact-gathering. */
function claim(id: string, committed: string[], over: Record<string, unknown> = {}) {
  return {
    id,
    accessor: 'x',
    format: 'integer',
    sot: 'performance',
    find_pattern: '(a)[^<]+(b)',
    captureGroups: 2,
    committed,
    raw: {},
    ...over,
  };
}

function facts(claims: unknown[], live: Record<string, string | null>, over: Record<string, unknown> = {}) {
  return {
    claims,
    readme: '<fixture>',
    liveByClaim: new Map(Object.entries(live)),
    sotReachable: true,
    ...over,
  };
}

describe('README snapshot freshness — band gate', () => {
  it('IN-BAND: a fresh bake of every claim class PASSES', () => {
    const r = evaluate(
      facts(
        [
          claim('dtrf-readme-total-calls', ['640,000']),
          claim('dtrf-readme-merkle-batches', ['152']),
          claim('dtrf-pfe-wr', ['91.4%']),
        ],
        {
          'dtrf-readme-total-calls': '646,509',
          'dtrf-readme-merkle-batches': '153',
          'dtrf-pfe-wr': '91.4',
        },
      ),
    );
    expect(r.token).toBe('PASS');
    expect(r.findings.every((f: any) => f.level === 'ok')).toBe(true);
  });

  it('FLOOR BREACH: a frozen counter below 90% of live FAILS and names field, committed and live', () => {
    // The exact live shape on 2026-09-10: committed 508,268 against live 646,509.
    const r = evaluate(
      facts([claim('dtrf-readme-total-calls', ['508,268'])], { 'dtrf-readme-total-calls': '646,509' }),
    );
    expect(r.token).toBe('FAIL');
    const f = r.findings.find((x: any) => x.level === 'fail');
    expect(f.message).toContain('dtrf-readme-total-calls');
    expect(f.message).toContain('508,268');
    expect(f.message).toContain('646,509');
    expect(f.message).toContain('FROZEN');
  });

  it('CEILING BREACH: a monotonic counter ABOVE live FAILS — it cannot go backwards', () => {
    const r = evaluate(
      facts([claim('dtrf-readme-merkle-batches', ['200'])], { 'dtrf-readme-merkle-batches': '153' }),
    );
    expect(r.token).toBe('FAIL');
    expect(r.findings.find((x: any) => x.level === 'fail').message).toContain('EXCEEDS');
  });

  it('pfe_wr OVER-band: the 0.3pp overstatement this wave exists for FAILS', () => {
    const r = evaluate(facts([claim('dtrf-pfe-wr', ['91.7%'])], { 'dtrf-pfe-wr': '91.4' }));
    expect(r.token).toBe('FAIL');
    const f = r.findings.find((x: any) => x.level === 'fail');
    expect(f.message).toContain('OVERSTATES');
    expect(f.message).toContain('0.30pp');
  });

  it('pfe_wr UNDER-band: a rate that has fallen behind in the OTHER direction also FAILS', () => {
    const r = evaluate(facts([claim('dtrf-pfe-wr', ['90.9%'])], { 'dtrf-pfe-wr': '91.4' }));
    expect(r.token).toBe('FAIL');
    expect(r.findings.find((x: any) => x.level === 'fail').message).toContain('understates');
  });

  it('pfe_wr AT the tolerance passes — the band is inclusive and immune to the last bit', () => {
    expect(evaluate(facts([claim('dtrf-pfe-wr', ['91.65%'])], { 'dtrf-pfe-wr': '91.4' })).token).toBe('PASS');
    expect(evaluate(facts([claim('dtrf-pfe-wr', ['91.15%'])], { 'dtrf-pfe-wr': '91.4' })).token).toBe('PASS');
  });

  it('UNREACHABLE SoT: INDETERMINATE with REMOTE scope, and it maps to exit 0', () => {
    const r = evaluate(facts([claim('dtrf-pfe-wr', ['91.7%'])], {}, { sotReachable: false }));
    expect(r.token).toBe('INDETERMINATE');
    expect(r.scope).toBe('remote');
    // Fail-OPEN, inheriting the injector's own contract. The TOKEN is what callers gate on; the
    // code is downgraded so network weather never takes the publish lane down.
    expect(mapCode(r.token, r.scope)).toBe(0);
  });

  it('an unreachable SoT WINS over a would-be breach — a breach we cannot confirm is not a breach', () => {
    const r = evaluate(
      facts([claim('dtrf-readme-total-calls', ['1'])], {}, { sotReachable: false }),
    );
    expect(r.token).toBe('INDETERMINATE');
  });

  it('an unreadable README is LOCAL indeterminacy and fails CLOSED at exit 3', () => {
    const r = evaluate({ claims: [], readme: null, liveByClaim: new Map(), sotReachable: true });
    expect(r.token).toBe('INDETERMINATE');
    expect(r.scope).toBe('local');
    expect(mapCode(r.token, r.scope)).toBe(3);
  });

  it('an EMPTY README-claim corpus FAILS — the manifest is a config we author, not a fact', () => {
    const r = evaluate(facts([], {}));
    expect(r.token).toBe('FAIL');
    expect(r.findings[0].message).toContain('EMPTY');
  });

  it('a README-targeting claim with NO declared band FAILS, naming the claim', () => {
    const r = evaluate(facts([claim('dtrf-unbanded', ['1'])], { 'dtrf-unbanded': '1' }));
    expect(r.token).toBe('FAIL');
    expect(r.findings.find((x: any) => x.level === 'fail').message).toContain('dtrf-unbanded');
  });

  it('a claim whose managed span has VANISHED from README FAILS', () => {
    const r = evaluate(facts([claim('dtrf-pfe-wr', [])], { 'dtrf-pfe-wr': '91.4' }));
    expect(r.token).toBe('FAIL');
    expect(r.findings.find((x: any) => x.level === 'fail').message).toContain('ZERO literals');
  });

  it('the token→exit-code mapping is asserted, not merely the token', () => {
    // Re-coding a mapping to 0 has silently made a whole suite green before; the token alone is
    // not the contract.
    expect(mapCode('PASS')).toBe(0);
    expect(mapCode('FAIL')).toBe(1);
    expect(mapCode('INDETERMINATE', 'local')).toBe(3);
    expect(mapCode('INDETERMINATE', 'remote')).toBe(0);
  });
});

describe('helpers the fixture seam would otherwise bypass', () => {
  it('extractCommitted slices the VALUE out of a (head)VALUE(tail) pattern', () => {
    expect(
      extractCommitted('<span data-tr-field="pfe_wr">91.4%</span>', '(data-tr-field="pfe_wr"[^>]*>)[^<]+(<)'),
    ).toEqual(['91.4%']);
  });

  it('extractCommitted finds EVERY occurrence — README carries each claim twice', () => {
    const two = '<span data-tr-field="pfe_wr">91.4%</span> ... <span data-tr-field="pfe_wr">91.4%</span>';
    expect(extractCommitted(two, '(data-tr-field="pfe_wr"[^>]*>)[^<]+(<)')).toHaveLength(2);
  });

  it('parseLiteral strips thousands separators and a trailing percent', () => {
    expect(parseLiteral('646,509')).toBe(646509);
    expect(parseLiteral('91.4%')).toBe(91.4);
    expect(Number.isFinite(parseLiteral('ninety one'))).toBe(false);
  });

  it('captureGroupCount counts groups by construction, not by counting parens', () => {
    expect(captureGroupCount('(a)[^<]+(b)')).toBe(2);
    expect(captureGroupCount('(?:a)[^<]+(b)')).toBe(1);
  });
});

describe('the REAL manifest — what the synthetic cases above cannot see', () => {
  const manifest = JSON.parse(readFileSync(resolve(REPO, 'scripts/snapshot-landing-manifest.json'), 'utf8'));
  const readme = readFileSync(resolve(REPO, 'README.md'), 'utf8');
  const real = loadReadmeClaims(manifest, REPO, readme);

  it('the corpus is NON-EMPTY (a vacuous sweep must never read as a clean one)', () => {
    expect(real.length).toBeGreaterThan(0);
  });

  it('EVERY README-targeting claim has a declared band — a new one fails here on arrival', () => {
    // Enumeration, not detection. This is the assertion that makes a fourth manifest claim
    // announce itself instead of being silently unwatched.
    const unbanded = real.filter((c: any) => !BANDS.has(c.id)).map((c: any) => c.id);
    expect(unbanded, `README claims with no band in check-readme-snapshot-freshness.mjs`).toEqual([]);
  });

  it('every declared band still corresponds to a live manifest claim', () => {
    const ids = new Set(real.map((c: any) => c.id));
    const orphaned = [...BANDS.keys()].filter((id) => !ids.has(id as string));
    expect(orphaned, 'BANDS entries whose manifest claim is gone').toEqual([]);
  });

  it('every README claim matches the (head)VALUE(tail) shape this gate reads', () => {
    expect(real.map((c: any) => c.captureGroups)).toEqual(real.map(() => 2));
  });

  it('every README claim extracts at least one committed literal that PARSES', () => {
    for (const c of real) {
      expect(c.committed.length, `${c.id} matched nothing in README.md`).toBeGreaterThan(0);
      for (const t of c.committed) expect(Number.isFinite(parseLiteral(t)), `${c.id}: ${t}`).toBe(true);
    }
  });
});
