/**
 * The bare-token second pass: accounting matrix, allowlist, INDETERMINATE, and the CH1 proof.
 * OPS-FORBIDDEN-PHRASE-ENUMERATION-AND-WEBHOOKS-DOC-W1 CH2 R2.5.
 *
 * WHY A SECOND PASS AT ALL. The primary pass can only ever see the phrasings its author
 * anticipated. `retired-tier-quotas` was `\b3,000\s+calls|\b15,000\s+calls`, transcribed from
 * brand-facts.md's wording rather than sampled from the estate, and it reported PASS over
 * `a pull call (Free 100 / Starter 3,000 / Pro 15,000 / Enterprise 100,000)` on a doc linked from
 * every webhook payload. Detection is strictly weaker than enumeration.
 *
 * The single most important assertion in this file is the LAST one in the first block: an
 * un-tiered phrasing that the widened CH1 pattern still cannot see, which the token catches.
 * That is the whole reason CH2 exists, and without it a reader could conclude CH1's tighter regex
 * made this pass redundant.
 *
 * The three accounting categories are exercised on FIXTURES rather than on the live tree, and
 * that is deliberate rather than lazy: the corpus only ever exercises what it happens to contain.
 * Measured 2026-09-08, `negative_context` accounting has ZERO live instances — README's annual
 * recap aged out of the What's-new window — so a suite leaning on the real tree would ship that
 * branch untested and report it covered. The live tree is asserted separately, through the CLI,
 * as the bypassed artifact.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error — .mjs gate script, no type declarations; it is the SUBJECT, not a dependency.
import { bareTokenHits, bareTokenRe, loadPhrases, proveCatchesCh1 } from '../../scripts/check-forbidden-phrases.mjs';

const ROOT = join(__dirname, '..', '..');
const GATE = join(ROOT, 'scripts', 'check-forbidden-phrases.mjs');

type Hit = { id: string; token: string; line: number; by: string | null; excerpt?: string };

/** A phrase entry shaped exactly as `loadPhrases` emits one, so the fixtures cannot drift from the real shape. */
const entry = (over: Record<string, unknown> = {}) => ({
  id: 'fixture',
  pattern: '\\b3,000\\s+calls',
  re: /\b3,000\s+calls/gi,
  negative_context: '[Ss]uperseded|[Rr]etired',
  tokens: [{ token: '3,000', re: bareTokenRe('3,000') }],
  bare_token_allowlist: [{ path: 'landing/llms-full.txt', token: '3,000', reason: 'a real sentence' }],
  ...over,
});

const account = (lines: string[], path = 'docs/x.md', over = {}): Array<string | null> =>
  (bareTokenHits(lines, [entry(over)], path) as Hit[]).map((h) => h.by);

describe('bare-token pass: the accounted / unaccounted matrix', () => {
  it('PATTERN — an occurrence the primary pass already catches needs nothing further', () => {
    expect(account(['Starter includes 3,000 calls a month.'])).toEqual(['pattern']);
  });

  it('NEGATIVE CONTEXT — a line the primary pass already judged and spared is accounted, not re-fired', () => {
    // Re-firing here would demand deletion of the very sentences that RECORD a retirement, and
    // duplicating that judgement in an allowlist row would put one decision in two places.
    expect(account(['Superseded: the 3,000 rung was retired on 2026-08-09.'])).toEqual(['negative_context']);
  });

  it('ALLOWLIST — a reasoned, path-scoped row accounts for it', () => {
    expect(account(['gates >=85% and >=3,000).'], 'landing/llms-full.txt')).toEqual(['allowlist']);
  });

  it('UNACCOUNTED — the same line on a path the allowlist does not name', () => {
    // The allowlist is a statement about a FILE, not a policy about a string.
    expect(account(['gates >=85% and >=3,000).'], 'landing/other.txt')).toEqual([null]);
  });

  it('an allowlist row scoped to a different token does not account for this one', () => {
    const over = { bare_token_allowlist: [{ path: 'docs/x.md', token: '15,000', reason: 'a real sentence' }] };
    expect(account(['a bare 3,000 with no tier word'], 'docs/x.md', over)).toEqual([null]);
  });

  it('THE POINT OF CH2: an un-tiered phrasing the SHIPPED CH1 pattern still cannot see', () => {
    // Read the live pattern rather than restating it — a test that retypes its subject proves
    // only that the author was self-consistent.
    const live = (loadPhrases() as { phrases: Array<{ id: string; pattern: string; tokens: unknown[] }> })
      .phrases.find((p) => p.id === 'retired-tier-quotas')!;
    const UNTIERED = 'We retained the 15,000-call rung for legacy keys.';
    expect(new RegExp(live.pattern, 'gi').test(UNTIERED), 'CH1 pattern unexpectedly matches — rewrite this case').toBe(false);

    const hits = bareTokenHits([UNTIERED], [live], 'landing/llms-full.txt') as Hit[];
    expect(hits.map((h) => h.by)).toEqual([null]);
    expect(hits[0].token).toBe('15,000');
  });
});

describe('bare-token boundaries: measured, not assumed', () => {
  const found = (token: string, line: string): boolean => bareTokenRe(token).test(line);

  it('a figure is not found inside a longer one', () => {
    for (const near of ['Starter 13,000 calls', 'was 3,000,000 rows', 'n=3,0005', 'ratio 3,000.5x']) {
      expect(found('3,000', near), `false positive: ${near}`).toBe(false);
    }
    expect(found('15,000', 'Pro 115,000 calls')).toBe(false);
  });

  it('a token whose left edge is non-word is still found — `\\b` fails here and that is why', () => {
    // \b before `$` asserts the PRECEDING char is a word char, so `\b\$79\b` misses `**$79/yr**`
    // — the exact shape a README release recap uses.
    expect(found('$79', 'Starter was **$79/yr** (~$6.58/mo)')).toBe(true);
    expect(found('$79', 'the price is $799 today')).toBe(false);
    expect(found('$79', 'the price is $79.50 today')).toBe(false);
  });

  it('a sentence-ending period does not hide a token', () => {
    // A naive `(?![\w,.])` right guard swallows this, which is a false NEGATIVE in a gate.
    expect(found('algovault.com/pricing', 'See algovault.com/pricing.')).toBe(true);
    expect(found('algovault.com/pricing', 'See algovault.com/pricing for the ladder.')).toBe(true);
    expect(found('algovault.com/pricing', 'See algovault.com/pricings2 here')).toBe(false);
  });
});

describe('the manifest is a config WE author, so a broken declaration is INDETERMINATE', () => {
  const withEntry = (extra: Record<string, unknown>): { error?: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'fp-bt-'));
    try {
      const f = join(dir, 'p.json');
      writeFileSync(f, JSON.stringify({ phrases: [{ id: 'x', pattern: 'zz', ...extra }] }));
      return loadPhrases(f) as { error?: string };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('an entry declaring neither bare_token nor bare_token_na_reason is REFUSED', () => {
    expect(withEntry({}).error).toBeTruthy();
  });

  it('an UNDECLARED omission is refused, a DECLARED one is accepted', () => {
    expect(withEntry({ bare_token_na_reason: '   ' }).error).toBeTruthy();
    expect(withEntry({ bare_token_na_reason: 'the figure is live elsewhere' }).error).toBeFalsy();
  });

  it('an allowlist row without a reason is REFUSED — an exemption nobody argued for', () => {
    expect(withEntry({ bare_token: ['q'], bare_token_allowlist: [{ path: 'a.md' }] }).error).toBeTruthy();
    expect(withEntry({ bare_token: ['q'], bare_token_allowlist: [{ path: 'a.md', reason: '  ' }] }).error).toBeTruthy();
  });

  it('an allowlist row naming an undeclared token is REFUSED', () => {
    expect(withEntry({
      bare_token: ['q'],
      bare_token_allowlist: [{ path: 'a.md', token: 'not-declared', reason: 'a sentence' }],
    }).error).toBeTruthy();
  });

  it('a malformed bare_token is REFUSED rather than silently enumerating nothing', () => {
    for (const bad of [[], [''], ['ok', 3], 'string-not-array']) {
      expect(withEntry({ bare_token: bad }).error, `accepted ${JSON.stringify(bad)}`).toBeTruthy();
    }
  });
});

describe('every declared phrase carries its bare-token decision', () => {
  it('all entries declare either bare_token or a non-empty bare_token_na_reason', () => {
    const { phrases } = loadPhrases() as { phrases: Array<Record<string, never>> };
    expect(phrases.length).toBeGreaterThan(0); // vacuity guard
    for (const p of phrases as unknown as Array<{ id: string; bare_token?: string[]; bare_token_na_reason?: string }>) {
      const declared = Array.isArray(p.bare_token) || Boolean(p.bare_token_na_reason?.trim());
      expect(declared, `${p.id} declares neither`).toBe(true);
    }
  });

  it('every allowlist row carries a reason that is a sentence, not a label', () => {
    const { phrases } = loadPhrases() as { phrases: Array<{ id: string; bare_token_allowlist?: Array<{ reason: string }> }> };
    const rows = phrases.flatMap((p) => (p.bare_token_allowlist || []).map((a) => [p.id, a] as const));
    for (const [id, a] of rows) {
      expect(a.reason.trim().length, `${id}: reason too short to be a reason`).toBeGreaterThan(40);
    }
  });
});

describe('the CH1 regression proof, and the live tree as the BYPASSED artifact', () => {
  it('restoring the narrow pattern + the pre-fix bytes makes the pass FAIL', () => {
    const r = proveCatchesCh1() as { ok: boolean; detail: string };
    expect(r.ok, r.detail).toBe(true);
    expect(r.detail).toMatch(/UNACCOUNTED/);
  });

  // Everything above replaces the real corpus with fixtures, so a hermetic suite is structurally
  // blind to exactly what its own seam replaces. Drive the real CLI on the real tree.
  const cli = (args: string[]): { out: string; code: number } => {
    try {
      return { out: execFileSync('node', [GATE, ...args], { encoding: 'utf8', cwd: ROOT }), code: 0 };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; status?: number };
      return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, code: err.status ?? -1 };
    }
  };

  it('the REAL tree passes, and the bare-token line PROVES the second pass ran', () => {
    const { out, code } = cli([]);
    expect(out).toMatch(/FORBIDDEN_PHRASE_VERDICT=PASS/);
    expect(code).toBe(0);
    // A pass you cannot tell ran is indistinguishable from a silent no-op — the dark-guard class.
    expect(out, 'no bare-token line: the second pass may not have run at all').toMatch(/bare-token pass: \d+ token\(s\)/);
    expect(out).toMatch(/\d+ unaccounted/);
  });

  it('--prove-catches-ch1 is a standalone verdict a chapter gate can read', () => {
    const { out, code } = cli(['--prove-catches-ch1']);
    expect(out).toMatch(/bare-token CH1 regression proof: HOLDS/);
    expect(out).toMatch(/FORBIDDEN_PHRASE_VERDICT=PASS/);
    expect(code).toBe(0);
  });

  it('--print-targets stays a MACHINE surface — paths only, no bare-token chatter', () => {
    // The second pass prints to stdout in `run()`. If that leaked into --print-targets, the
    // downstream gate that consumes this list would treat a prose line as a file path.
    const { out, code } = cli(['--print-targets']);
    expect(code).toBe(0);
    const lines = out.trim().split('\n');
    expect(lines.length).toBeGreaterThan(100);
    for (const l of lines) expect(l, `non-path line on the machine surface: ${l}`).not.toMatch(/\s/);
  });

  it('the recorded allowlist row still describes a real occurrence — not a stale exemption', () => {
    // An allowlist row that no longer matches anything is dead config that reads as vetted.
    const { phrases } = loadPhrases() as { phrases: Array<{ id: string; bare_token_allowlist?: Array<{ path: string; token?: string }> }> };
    for (const p of phrases) {
      for (const a of p.bare_token_allowlist || []) {
        const text = readFileSync(join(ROOT, a.path), 'utf8');
        const tokens = a.token ? [a.token] : [];
        for (const t of tokens) {
          expect(bareTokenRe(t).test(text), `${p.id} allowlists ${a.path} for ${t}, which no longer occurs there`).toBe(true);
        }
      }
    }
  });
});
