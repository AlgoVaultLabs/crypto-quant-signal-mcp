/**
 * OPS-SYSTEM-MAP-DIRECTORY-W1 CH5 — `scripts/check-map-edges.mjs`, the bidirectional-consistency
 * gate over the system map (a router plus one card per component).
 *
 * WHAT THE GATE CAN AND CANNOT SEE, asserted here rather than promised in prose:
 *
 *   · A counterpart is recognised ONLY as a backticked §3 id immediately after the flag
 *     (`- [tight] \`aoe\` — …`). Those edges get reciprocity AND id-in-index enforced.
 *   · A backticked §4 surface name is existence-checked; an external has no card, so no
 *     reciprocity exists to check.
 *   · Every other edge is UNRESOLVED DEBT, counted per card in the lock and SHRINK-ONLY. A card
 *     that gains debt FAILs, which is what forces a NEW edge into the grammar.
 *
 * The corpus is the vault (private, absent in CI), so the committed lock carries IDENTIFIERS ONLY
 * and CI verifies the lock. Tests that need the real corpus skip when it is not mounted; the
 * lock-shape and wiring tests run everywhere, because they are repo data.
 *
 * SPAWN BUDGET: every block that shells out declares `{ timeout }` in its OPTIONS argument — the
 * only place scripts/check-test-budget.mjs counts one.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(__dirname, '..', '..');
const GATE = join(ROOT, 'scripts', 'check-map-edges.mjs');
const PATH_LIB = join(ROOT, 'scripts', 'lib', 'system-map-path.sh');
const COMMITTED_LOCK = join(ROOT, 'ops', 'system-map-edges.lock.json');
const MADE: string[] = [];

afterAll(() => MADE.forEach((d) => rmSync(d, { recursive: true, force: true })));

interface CardSpec {
  /** Card file name, e.g. `aoe.md`. */
  file: string;
  consumes?: string[];
  produces?: string[];
  /** Omit a required section, to drive the unparseable-card branch. */
  omitProduces?: boolean;
}
interface CorpusSpec {
  /** §3 rows: [component id, card file]. */
  components: [string, string][];
  /** §4 surface names. */
  surfaces?: string[];
  cards: CardSpec[];
  /** Card files written into system-map/ that §3 does not reference. */
  orphanCards?: string[];
  /** Skip creating the card directory entirely. */
  noCardDir?: boolean;
}

/** Build a router + card directory in a tmp dir; return the ROUTER path (what SYSTEM_MAP_PATH takes). */
function corpus(spec: CorpusSpec): string {
  const dir = mkdtempSync(join(tmpdir(), 'map-edges-'));
  MADE.push(dir);
  const rows = spec.components.map(([id, card]) => `| [\`${id}\`](system-map/${card}) | role | repo |`);
  const surfaces = (spec.surfaces ?? ['Telegram Bot']).map((s) => `| ${s} | role |`);
  writeFileSync(
    join(dir, 'system-map.md'),
    [
      '# map', '', '## 3. Component reference', '',
      '| Component | Role | Repo |', '|---|---|---|', ...rows, '',
      '## 4. External integration reference', '',
      '| Surface | Role |', '|---|---|', ...surfaces, '',
      '## 5. Update protocol', '',
    ].join('\n'),
  );
  if (!spec.noCardDir) {
    const cardDir = join(dir, 'system-map');
    mkdirSync(cardDir);
    for (const c of spec.cards) {
      const body = [
        `# ${c.file.replace(/\.md$/, '')}`, '',
        '## Consumes   ← BACKWARD DEP', '',
        ...(c.consumes ?? ['_No `↑` edge recorded in §2._']), '',
      ];
      if (!c.omitProduces) body.push('## Produces   → FORWARD DEP', '', ...(c.produces ?? ['_No `↓` edge recorded in §2._']), '');
      body.push('---', '', '## Tree (verbatim from §2 — the lossless record)', '', '```text', '- [tight] `aoe` — a tree line that is NOT an edge', '```', '');
      writeFileSync(join(cardDir, c.file), body.join('\n'));
    }
    for (const o of spec.orphanCards ?? []) writeFileSync(join(cardDir, o), '# orphan\n\n## Consumes   ← BACKWARD DEP\n\n## Produces   → FORWARD DEP\n');
  }
  return join(dir, 'system-map.md');
}

interface Run { code: number; out: string; verdict: string; coverage: string; tokens: number; coverageLines: number }

function run(router: string | null, args: string[] = [], lock?: string): Run {
  const r = spawnSync('node', [GATE, ...args, ...(lock ? ['--lock', lock] : [])], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, SYSTEM_MAP_PATH: router ?? join(tmpdir(), 'no-such-map', 'system-map.md') },
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const verdicts = out.split('\n').filter((l) => l.startsWith('MAP_EDGES_VERDICT='));
  const coverages = out.split('\n').filter((l) => l.startsWith('MAP_EDGES_RECIPROCITY_COVERAGE='));
  if (r.status === null || r.status === undefined) {
    throw new Error(`gate produced no exit status (signal=${r.signal ?? 'none'})\n${out}`);
  }
  return {
    code: r.status,
    out,
    verdict: verdicts.at(-1)?.split('=')[1] ?? '',
    coverage: coverages.at(-1)?.split('=')[1] ?? '',
    tokens: verdicts.length,
    coverageLines: coverages.length,
  };
}

/** A corpus whose two components name each other in the grammar, plus an external and a debt edge. */
function consistentCorpus(): string {
  return corpus({
    components: [['aoe', 'aoe.md'], ['landing/', 'landing.md']],
    surfaces: ['Telegram Bot'],
    cards: [
      { file: 'aoe.md', consumes: ['- [tight] `landing/` — a contract'], produces: ['- [tight] `Telegram Bot` — weekly digest', '- [loose] postgres signals (RO) — prose only, no counterpart'] },
      { file: 'landing.md', produces: ['- [tight] `aoe` — a contract'] },
    ],
  });
}

function sync(router: string, lock: string): Run {
  return run(router, ['--sync'], lock);
}

describe('check-map-edges.mjs — contract', () => {
  let lock: string;

  beforeEach(() => {
    const d = mkdtempSync(join(tmpdir(), 'map-edges-lock-'));
    MADE.push(d);
    lock = join(d, 'system-map-edges.lock.json');
  });

  it('--self-test passes, is non-vacuous, and prints exactly one verdict + one coverage line', { timeout: 120_000 }, () => {
    const r = run(null, ['--self-test'], lock);
    expect(r.verdict, r.out).toBe('PASS');
    expect(r.code).toBe(0);
    expect(r.tokens).toBe(1);
    expect(r.coverageLines).toBe(1);
    // A self-test that built no scenarios is the failure mode it exists to prevent.
    const n = /self-test: (\d+) scenario/.exec(r.out)?.[1];
    expect(Number(n ?? 0), r.out).toBeGreaterThanOrEqual(12);
  });

  it('a consistent corpus PASSes, with coverage counting grammar edges only', { timeout: 120_000 }, () => {
    const router = consistentCorpus();
    expect(sync(router, lock).verdict).toBe('PASS');

    const r = run(router, [], lock);
    expect(r.verdict, r.out).toBe('PASS');
    expect(r.code).toBe(0);
    expect(r.tokens).toBe(1);
    expect(r.coverageLines).toBe(1);
    expect(r.coverage).toBe('3/4');  // 2 component edges + 1 external, of 4 edges
  });

  it('a one-sided GRAMMAR edge FAILs and names both ends', { timeout: 120_000 }, () => {
    const router = corpus({
      components: [['aoe', 'aoe.md'], ['landing/', 'landing.md']],
      cards: [
        { file: 'aoe.md', produces: ['- [tight] `landing/` — a contract'] },
        { file: 'landing.md' },
      ],
    });
    const r = run(router, [], lock);
    expect(r.verdict, r.out).toBe('FAIL');
    expect(r.code).toBe(1);
    // The CODE, not just the verdict: with the corpus-side reciprocity check made inert, this
    // case still went FAIL through the lock verifier — one check masking another (measured).
    expect(r.out).toContain('ONE_SIDED');
    expect(r.out).toContain('aoe');
    expect(r.out).toContain('landing/');
  });

  it('a counterpart in neither the §3 index nor the §4 table FAILs', { timeout: 120_000 }, () => {
    const router = corpus({
      components: [['aoe', 'aoe.md']],
      cards: [{ file: 'aoe.md', produces: ['- [tight] `not-a-component` — nope'] }],
    });
    const r = run(router, [], lock);
    expect(r.verdict, r.out).toBe('FAIL');
    expect(r.out).toContain('not-a-component');
  });

  it('an edge line with no coupling flag FAILs', { timeout: 120_000 }, () => {
    const router = corpus({
      components: [['aoe', 'aoe.md']],
      cards: [{ file: 'aoe.md', produces: ['- postgres signals — no flag at all'] }],
    });
    const r = run(router, [], lock);
    expect(r.verdict, r.out).toBe('FAIL');
    expect(r.out.toLowerCase()).toContain('flag');
  });

  it('a card that GAINS debt FAILs — the ratchet is what forces new edges into the grammar', { timeout: 120_000 }, () => {
    const router = consistentCorpus();
    expect(sync(router, lock).verdict).toBe('PASS');

    // Append one more prose edge to aoe.md — debt 1 → 2 on that card.
    const card = join(router.replace(/\.md$/, ''), 'aoe.md');
    writeFileSync(card, `${readFileSync(card, 'utf8').replace('## Produces   → FORWARD DEP\n', '## Produces   → FORWARD DEP\n\n- [tight] another prose edge with no counterpart\n')}`);

    const r = run(router, [], lock);
    expect(r.verdict, r.out).toBe('FAIL');
    expect(r.out.toLowerCase()).toContain('debt');
    // …and --sync must REFUSE to launder it into the lock.
    const before = readFileSync(lock, 'utf8');
    const s = sync(router, lock);
    expect(s.verdict).toBe('FAIL');
    expect(readFileSync(lock, 'utf8'), 'the lock was rewritten over a refused sync').toBe(before);
  });

  it('a STALE lock REPORTS and does not block (the corpus is shared and concurrently edited)', { timeout: 120_000 }, () => {
    const router = consistentCorpus();
    expect(sync(router, lock).verdict).toBe('PASS');

    // The first card of a normalisation wave: one prose edge becomes a grammar edge, mirrored on
    // the other side. Debt SHRINKS and ids move — what a stale lock actually looks like here.
    const dir = router.replace(/\.md$/, '');
    const a = join(dir, 'aoe.md');
    writeFileSync(a, readFileSync(a, 'utf8').replace('- [loose] postgres signals (RO) — prose only, no counterpart', '- [loose] `landing/` — now in the grammar'));
    const b = join(dir, 'landing.md');
    writeFileSync(b, readFileSync(b, 'utf8').replace('## Consumes   ← BACKWARD DEP\n', '## Consumes   ← BACKWARD DEP\n\n- [loose] `aoe` — now in the grammar\n'));

    const r = run(router, [], lock);
    expect(r.verdict, r.out).toBe('PASS');
    expect(r.code).toBe(0);
    expect(r.out.toLowerCase()).toContain('stale');
    expect(r.out).toContain('--sync');
  });

  it('a missing lock is INDETERMINATE, never a pass over an unratcheted corpus', { timeout: 120_000 }, () => {
    const r = run(consistentCorpus(), [], lock);
    expect(r.verdict, r.out).toBe('INDETERMINATE');
    expect(r.code).toBe(3);
    expect(r.coverageLines).toBe(1);
  });

  it('zero cards is INDETERMINATE (vacuity, where the corpus is CONSTRUCTED for us)', { timeout: 120_000 }, () => {
    const router = corpus({ components: [['aoe', 'aoe.md']], cards: [], noCardDir: true });
    const r = run(router, [], lock);
    expect(r.verdict, r.out).toBe('INDETERMINATE');
    expect(r.code).toBe(3);
  });

  it('zero edges parsed from a non-empty corpus is INDETERMINATE', { timeout: 120_000 }, () => {
    const router = corpus({ components: [['aoe', 'aoe.md']], cards: [{ file: 'aoe.md' }] });
    const r = run(router, [], lock);
    expect(r.verdict, r.out).toBe('INDETERMINATE');
    expect(r.code).toBe(3);
  });

  it('a card missing a required section is INDETERMINATE — handed to us and unparseable', { timeout: 120_000 }, () => {
    const router = corpus({
      components: [['aoe', 'aoe.md']],
      cards: [{ file: 'aoe.md', consumes: ['- [tight] `Telegram Bot` — x'], omitProduces: true }],
    });
    const r = run(router, [], lock);
    expect(r.verdict, r.out).toBe('INDETERMINATE');
    expect(r.code).toBe(3);
  });

  it('a §3 row whose card file is missing FAILs, and an unreferenced card file FAILs', { timeout: 120_000 }, () => {
    const missing = run(
      corpus({ components: [['aoe', 'aoe.md'], ['ghost', 'ghost.md']], cards: [{ file: 'aoe.md', produces: ['- [tight] `Telegram Bot` — x'] }] }),
      [], lock,
    );
    expect(missing.verdict, missing.out).toBe('FAIL');
    expect(missing.out).toContain('ghost.md');

    const orphan = run(
      corpus({ components: [['aoe', 'aoe.md']], cards: [{ file: 'aoe.md', produces: ['- [tight] `Telegram Bot` — x'] }], orphanCards: ['stray.md'] }),
      [], lock,
    );
    expect(orphan.verdict, orphan.out).toBe('FAIL');
    expect(orphan.out).toContain('stray.md');
  });
});

describe('check-map-edges.mjs — lock mode (the corpus is unreachable, as in CI)', () => {
  it('verifies the lock alone: consistent → PASS, tampered → FAIL, missing → INDETERMINATE', { timeout: 120_000 }, () => {
    const d = mkdtempSync(join(tmpdir(), 'map-edges-lockmode-'));
    MADE.push(d);
    const lock = join(d, 'lock.json');

    const router = consistentCorpus();
    expect(sync(router, lock).verdict).toBe('PASS');

    const ok = run(null, [], lock);              // SYSTEM_MAP_PATH points at nothing
    expect(ok.verdict, ok.out).toBe('PASS');
    expect(ok.out.toLowerCase()).toContain('lock mode');

    const tampered = JSON.parse(readFileSync(lock, 'utf8'));
    tampered.edges = tampered.edges.filter((e: string) => !e.startsWith('landing/:produces:'));
    writeFileSync(lock, JSON.stringify(tampered, null, 2));
    const bad = run(null, [], lock);
    expect(bad.verdict, bad.out).toBe('FAIL');
    expect(bad.code).toBe(1);

    rmSync(lock);
    const gone = run(null, [], lock);
    expect(gone.verdict, gone.out).toBe('INDETERMINATE');
    expect(gone.code).toBe(3);
  });
});

describe('check-map-edges.mjs — the committed artifacts', () => {
  it('the committed lock exists, parses, and carries zero prose and zero line numbers', { timeout: 60_000 }, () => {
    expect(existsSync(COMMITTED_LOCK), 'ops/system-map-edges.lock.json is missing').toBe(true);
    const lock = JSON.parse(readFileSync(COMMITTED_LOCK, 'utf8'));
    expect(Object.keys(lock).sort()).toEqual(
      ['components', 'debt', 'edges', 'extracted_from_corpus_sha256', 'generated_by', 'surfaces_referenced'],
    );
    expect(lock.extracted_from_corpus_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(lock.generated_by).toBe('scripts/check-map-edges.mjs --sync');
    expect(lock.components.length).toBeGreaterThan(0);
    expect(lock.edges.length).toBeGreaterThan(0);

    const ids = new Set<string>(lock.components);
    const surfaces = new Set<string>(lock.surfaces_referenced);
    for (const e of lock.edges as string[]) {
      // <card>:<direction>:<counterpart | ext:<surface> | debt:<n>>=<flag>
      const m = /^(.+):(consumes|produces):(?:debt:(\d+)|ext:(.+)|(.+))=(tight|loose|documented-only)$/.exec(e);
      expect(m, `edge id is not identifier-shaped: ${e}`).toBeTruthy();
      expect(ids.has(m![1]), `edge id names an unknown card: ${e}`).toBe(true);
      if (m![4]) expect(surfaces.has(m![4])).toBe(true);
      if (m![5]) expect(ids.has(m![5])).toBe(true);
      expect(e).not.toMatch(/:L?\d+:\d+/);   // no line:col coordinates
    }
    for (const [card, n] of Object.entries(lock.debt as Record<string, number>)) {
      expect(ids.has(card)).toBe(true);
      expect(Number.isInteger(n) && n >= 0).toBe(true);
    }
    // Nothing in the lock may be a sentence: every string is an id, a surface, an edge id, the
    // sha, or the generator path. Prose has spaces AND lowercase words; ids are bounded.
    for (const s of JSON.stringify(lock).match(/"[^"]*"/g) ?? []) {
      expect(s.length, `lock string too long to be an identifier: ${s}`).toBeLessThanOrEqual(130);
    }
  });

  it('the gate is wired into deploy.yml as a --self-test + check pair', { timeout: 60_000 }, () => {
    const wf = readFileSync(join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8');
    expect(wf).toContain('node scripts/check-map-edges.mjs --self-test');
    expect(wf).toMatch(/node scripts\/check-map-edges\.mjs\s*$/m);
  });

  it('the pre-commit block, where installed, is REPORT-ONLY', { timeout: 60_000 }, () => {
    const hooks = execFileSync('git', ['config', '--get', 'core.hooksPath'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const hook = join(hooks, 'pre-commit');
    if (!hooks || !existsSync(hook)) return;   // nothing installed here — the installer's own test covers emission
    const text = readFileSync(hook, 'utf8');
    const block = /# >>> algovault map-edges \([^)]*\) >>>[\s\S]*?# <<< algovault map-edges <<</.exec(text);
    if (!block) return;                        // not installed in this checkout
    expect(block[0]).toContain('check-map-edges.mjs');
    expect(block[0], 'the map-edges block must never block a commit').not.toMatch(/\|\|\s*exit 1/);
    // …and it must print its token on EVERY run: a block that is silent when healthy is
    // indistinguishable from one nobody invokes, and this one can never block.
    expect(block[0]).toMatch(/grep -E '\^MAP_EDGES_\(VERDICT\|RECIPROCITY_COVERAGE\)='/);
  });
});

describe.skipIf(!existsSync(readFileSync(PATH_LIB, 'utf8').match(/SYSTEM_MAP_PATH:-([^}]+)\}/)?.[1] ?? '/nonexistent'))(
  'check-map-edges.mjs — the live vault corpus',
  () => {
    it('runs on the real map: one verdict, one coverage line, and it names the edge-less cards', { timeout: 120_000 }, () => {
      const r = run(null, [], COMMITTED_LOCK);
      // SYSTEM_MAP_PATH unset would be ideal, but run() always sets it; use the declared default.
      const declared = readFileSync(PATH_LIB, 'utf8').match(/SYSTEM_MAP_PATH:-([^}]+)\}/)?.[1] ?? '';
      const live = run(declared, [], COMMITTED_LOCK);
      expect(live.tokens).toBe(1);
      expect(live.coverageLines).toBe(1);
      expect(['PASS', 'FAIL', 'INDETERMINATE']).toContain(live.verdict);
      expect(live.verdict, live.out).toBe('PASS');
      expect(live.out).toContain('algovault-editorial-content');
      expect(r.tokens).toBe(1);
    });
  },
);
