/**
 * OPS-SYSTEM-MAP-DIRECTORY-W1 CH5 — `scripts/check-map-edges.mjs`, the bidirectional-consistency
 * gate over the system map (a router plus one card per component).
 * OPS-SYSTEM-MAP-EDGE-TAXONOMY-W1 CH2 — the gate learns the four-form counterpart slot.
 *
 * WHAT THE GATE CAN AND CANNOT SEE, asserted here rather than promised in prose:
 *
 *   · The slot immediately after the coupling flag holds ONE of four forms:
 *       `- [tight] \`aoe\` — …`                 EDGE      a backticked §3 id; reciprocity ENFORCED
 *       `- [tight] @surface \`Telegram Bot\` — …` SURFACE   existence-checked against §4, no reciprocity
 *       `- [tight] @infra …`                     INFRA     no counterpart exists
 *       `- [tight] @internal …`                  INTERNAL  same component, plumbing
 *   · A BARE backticked §4 name is retired (Q-A): it FAILs with the remediation to write @surface.
 *   · Every other line is UNCLASSIFIED DEBT, counted per card in the lock and SHRINK-ONLY. A card
 *     that gains debt FAILs, which is what forces a NEW line into one of the four forms.
 *   · MAP_EDGES_RECIPROCITY_COVERAGE measures reciprocity, so its denominator is EDGE lines only.
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
import { parseEdgeId } from '../../scripts/check-map-edges.mjs';

const ROOT = resolve(__dirname, '..', '..');
const GATE = join(ROOT, 'scripts', 'check-map-edges.mjs');
const PATH_LIB = join(ROOT, 'scripts', 'lib', 'system-map-path.sh');
const COMMITTED_LOCK = join(ROOT, 'ops', 'system-map-edges.lock.json');
/** The two `generated_by` values a lock may carry. Restated here on purpose: this is the contract. */
const GEN_V1 = 'scripts/check-map-edges.mjs --sync';
const GEN_V2 = 'scripts/check-map-edges.mjs --sync (edge-class grammar 2)';
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

/** A one-card corpus whose Produces section holds exactly `produces`. */
function oneCard(produces: string[], surfaces?: string[]): string {
  return corpus({ components: [['aoe', 'aoe.md']], surfaces, cards: [{ file: 'aoe.md', produces }] });
}

interface Run {
  code: number;
  out: string;
  verdict: string;
  coverage: string;
  classes: string;
  tokens: number;
  coverageLines: number;
  classLines: number;
}

function run(router: string | null, args: string[] = [], lock?: string): Run {
  const r = spawnSync('node', [GATE, ...args, ...(lock ? ['--lock', lock] : [])], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, SYSTEM_MAP_PATH: router ?? join(tmpdir(), 'no-such-map', 'system-map.md') },
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const lines = out.split('\n');
  const verdicts = lines.filter((l) => l.startsWith('MAP_EDGES_VERDICT='));
  const coverages = lines.filter((l) => l.startsWith('MAP_EDGES_RECIPROCITY_COVERAGE='));
  const classes = lines.filter((l) => l.startsWith('MAP_EDGES_CLASSES='));
  if (r.status === null || r.status === undefined) {
    throw new Error(`gate produced no exit status (signal=${r.signal ?? 'none'})\n${out}`);
  }
  return {
    code: r.status,
    out,
    verdict: verdicts.at(-1)?.split('=')[1] ?? '',
    coverage: coverages.at(-1)?.split('=')[1] ?? '',
    // The value itself carries `=` (edge=2 surface=1 …), so slice rather than split.
    classes: classes.at(-1)?.slice('MAP_EDGES_CLASSES='.length) ?? '',
    tokens: verdicts.length,
    coverageLines: coverages.length,
    classLines: classes.length,
  };
}

/** Two components naming each other in the grammar, plus one line of every other class. */
function consistentCorpus(): string {
  return corpus({
    components: [['aoe', 'aoe.md'], ['landing/', 'landing.md']],
    surfaces: ['Telegram Bot'],
    cards: [
      {
        file: 'aoe.md',
        consumes: ['- [tight] `landing/` — a contract'],
        produces: [
          '- [tight] @surface `Telegram Bot` — weekly digest',
          '- [loose] postgres signals (RO) — prose only, no counterpart',
          '- [tight] @infra Redis keys — a datastore, nothing component-shaped on the other end',
          '- [tight] @internal a route feeds a table the same component owns',
        ],
      },
      { file: 'landing.md', produces: ['- [tight] `aoe` — a contract'] },
    ],
  });
}
const CONSISTENT_CLASSES = 'edge=2 surface=1 infra=1 internal=1 debt=1';

function sync(router: string, lock: string): Run {
  return run(router, ['--sync'], lock);
}

function freshLock(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  MADE.push(d);
  return join(d, 'system-map-edges.lock.json');
}

describe('check-map-edges.mjs — contract', () => {
  let lock: string;

  beforeEach(() => {
    lock = freshLock('map-edges-lock-');
  });

  it('--self-test passes, is non-vacuous, proves every class both ways, and prints one of each token', { timeout: 120_000 }, () => {
    const r = run(null, ['--self-test'], lock);
    expect(r.verdict, r.out).toBe('PASS');
    expect(r.code).toBe(0);
    expect(r.tokens).toBe(1);
    expect(r.coverageLines).toBe(1);
    expect(r.classLines).toBe(1);
    // A self-test that built no scenarios is the failure mode it exists to prevent.
    const n = /self-test: (\d+) scenario/.exec(r.out)?.[1];
    expect(Number(n ?? 0), r.out).toBeGreaterThanOrEqual(30);
    // …and one that never watched a class FAIL cannot claim to guard it.
    for (const cls of ['edge', 'surface', 'infra', 'internal']) {
      expect(r.out, `class ${cls} not proven in both directions`).toMatch(new RegExp(`\\b${cls}=PASS\\+FAIL\\b`));
    }
  });

  it('a consistent four-form corpus PASSes; coverage counts EDGE lines only', { timeout: 120_000 }, () => {
    const router = consistentCorpus();
    expect(sync(router, lock).verdict).toBe('PASS');

    const r = run(router, [], lock);
    expect(r.verdict, r.out).toBe('PASS');
    expect(r.code).toBe(0);
    expect(r.tokens).toBe(1);
    expect(r.coverageLines).toBe(1);
    expect(r.classLines).toBe(1);
    expect(r.classes).toBe(CONSISTENT_CLASSES);
    // 2 EDGE lines, both mirrored. The surface, infra, internal and debt lines are NOT in the
    // denominator: counting them is the arithmetic that made "82 debt" read as 82 owed items.
    expect(r.coverage).toBe('2/2');
  });

  it('coverage is 0/0 when there is nothing to reciprocate, and counts a one-sided EDGE', { timeout: 120_000 }, () => {
    const none = oneCard(['- [tight] @infra a datastore', '- [tight] @surface `Telegram Bot` — a digest']);
    expect(sync(none, lock).verdict).toBe('PASS');
    const r = run(none, [], lock);
    expect(r.verdict, r.out).toBe('PASS');
    expect(r.coverage).toBe('0/0');
    expect(r.classes).toBe('edge=0 surface=1 infra=1 internal=0 debt=0');

    const oneSided = run(corpus({
      components: [['aoe', 'aoe.md'], ['landing/', 'landing.md']],
      cards: [{ file: 'aoe.md', produces: ['- [tight] `landing/` — a contract', '- [tight] @infra a datastore'] }, { file: 'landing.md' }],
    }), [], freshLock('map-edges-onesided-'));
    expect(oneSided.verdict, oneSided.out).toBe('FAIL');
    expect(oneSided.coverage).toBe('0/1');
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
    const r = run(oneCard(['- [tight] `not-a-component` — nope']), [], lock);
    expect(r.verdict, r.out).toBe('FAIL');
    expect(r.out).toContain('UNKNOWN_COUNTERPART');
    expect(r.out).toContain('not-a-component');
  });

  it('a BARE backticked §4 name is retired: FAIL BARE_SURFACE, with the @surface remediation', { timeout: 120_000 }, () => {
    const r = run(oneCard(['- [tight] `Telegram Bot` — the pre-taxonomy spelling']), [], lock);
    expect(r.verdict, r.out).toBe('FAIL');
    expect(r.out).toContain('BARE_SURFACE');
    expect(r.out).toContain('@surface `Telegram Bot`');
  });

  it('@surface is existence-checked against §4: a non-§4 name FAILs UNKNOWN_SURFACE', { timeout: 120_000 }, () => {
    const r = run(oneCard(['- [tight] @surface `Not A Surface` — nope']), [], lock);
    expect(r.verdict, r.out).toBe('FAIL');
    expect(r.out).toContain('UNKNOWN_SURFACE');
    expect(r.out).toContain('Not A Surface');
  });

  it('a malformed sigil FAILs MALFORMED_SIGIL: @surface with no name, a sigil glued to punctuation', { timeout: 120_000 }, () => {
    for (const line of ['- [tight] @surface no backticks here', '- [tight] @surface', '- [tight] @infra: a colon glued on']) {
      const r = run(oneCard([line]), [], freshLock('map-edges-malformed-'));
      expect(r.verdict, `${line}\n${r.out}`).toBe('FAIL');
      expect(r.out, line).toContain('MALFORMED_SIGIL');
    }
  });

  it('an unknown sigil FAILs UNKNOWN_SIGIL — a typo is never silently debt', { timeout: 120_000 }, () => {
    for (const line of ['- [tight] @infrx a typo', '- [tight] @Surface `Telegram Bot` — wrong case', '- [tight] @internals plural']) {
      const r = run(oneCard([line]), [], freshLock('map-edges-sigil-'));
      expect(r.verdict, `${line}\n${r.out}`).toBe('FAIL');
      expect(r.out, line).toContain('UNKNOWN_SIGIL');
    }
  });

  it('prose that merely starts with an npm scope is not a sigil attempt — it stays debt', { timeout: 120_000 }, () => {
    const router = oneCard(['- [tight] @algovaultlabs/skills ships the plugin']);
    expect(sync(router, lock).verdict).toBe('PASS');
    const r = run(router, [], lock);
    expect(r.verdict, r.out).toBe('PASS');
    expect(r.classes).toBe('edge=0 surface=0 infra=0 internal=0 debt=1');
  });

  it('@infra / @internal with an empty body FAIL EMPTY_BODY', { timeout: 120_000 }, () => {
    for (const line of ['- [tight] @infra', '- [tight] @internal   ']) {
      const r = run(oneCard([line]), [], freshLock('map-edges-empty-'));
      expect(r.verdict, `${line}\n${r.out}`).toBe('FAIL');
      expect(r.out, line).toContain('EMPTY_BODY');
    }
  });

  it('@infra / @internal may not hide a counterpart in the slot: SIGIL_NAMES_COUNTERPART', { timeout: 120_000 }, () => {
    for (const line of ['- [tight] @infra `aoe` — a component edge dressed as infra', '- [tight] @internal `Telegram Bot` — a surface dressed as plumbing']) {
      const r = run(oneCard([line]), [], freshLock('map-edges-hidden-'));
      expect(r.verdict, `${line}\n${r.out}`).toBe('FAIL');
      expect(r.out, line).toContain('SIGIL_NAMES_COUNTERPART');
    }
    // A backticked token that names NOTHING in the router is ordinary prose.
    const router = oneCard(['- [tight] @infra `redis` keys under algovault:*']);
    expect(sync(router, lock).verdict).toBe('PASS');
    expect(run(router, [], lock).classes).toBe('edge=0 surface=0 infra=1 internal=0 debt=0');
  });

  it('a §4 name that itself contains backticks is nameable with a double-backtick span', { timeout: 120_000 }, () => {
    const router = oneCard(
      ['- [tight] @surface ``ElizaOS (`plugin-algovault`)`` — a downstream framework'],
      ['ElizaOS (`plugin-algovault`)'],
    );
    expect(sync(router, lock).verdict).toBe('PASS');
    const r = run(router, [], lock);
    expect(r.verdict, r.out).toBe('PASS');
    expect(r.classes).toBe('edge=0 surface=1 infra=0 internal=0 debt=0');
  });

  it('a §3 id carrying the id separator FAILs RESERVED_ID', { timeout: 120_000 }, () => {
    const r = run(corpus({ components: [['a:b', 'ab.md']], cards: [{ file: 'ab.md', produces: ['- [tight] @infra a datastore'] }] }), [], lock);
    expect(r.verdict, r.out).toBe('FAIL');
    expect(r.out).toContain('RESERVED_ID');
  });

  it('an edge line with no coupling flag FAILs', { timeout: 120_000 }, () => {
    const r = run(oneCard(['- postgres signals — no flag at all']), [], lock);
    expect(r.verdict, r.out).toBe('FAIL');
    expect(r.out.toLowerCase()).toContain('flag');
  });

  it('an unclassified line still counts as debt', { timeout: 120_000 }, () => {
    const router = oneCard(['- [tight] prose one', '- [loose] prose two', '- [tight] @infra a datastore']);
    expect(sync(router, lock).verdict).toBe('PASS');
    const r = run(router, [], lock);
    expect(r.classes).toBe('edge=0 surface=0 infra=1 internal=0 debt=2');
    expect(JSON.parse(readFileSync(lock, 'utf8')).debt.aoe).toBe(2);
  });

  it('a card that GAINS an unclassified line FAILs DEBT_GROWTH — the ratchet forces new lines into a form', { timeout: 120_000 }, () => {
    const router = consistentCorpus();
    expect(sync(router, lock).verdict).toBe('PASS');

    // Append one more prose line to aoe.md — debt 1 → 2 on that card.
    const card = join(router.replace(/\.md$/, ''), 'aoe.md');
    writeFileSync(card, `${readFileSync(card, 'utf8').replace('## Produces   → FORWARD DEP\n', '## Produces   → FORWARD DEP\n\n- [tight] another prose edge with no counterpart\n')}`);

    const r = run(router, [], lock);
    expect(r.verdict, r.out).toBe('FAIL');
    expect(r.out).toContain('DEBT_GROWTH');
    // …and --sync must REFUSE to launder it into the lock.
    const before = readFileSync(lock, 'utf8');
    const s = sync(router, lock);
    expect(s.verdict).toBe('FAIL');
    expect(readFileSync(lock, 'utf8'), 'the lock was rewritten over a refused sync').toBe(before);
  });

  it('a card that gains a CLASSIFIED line is not debt growth — it reports, and --sync accepts it', { timeout: 120_000 }, () => {
    const router = consistentCorpus();
    expect(sync(router, lock).verdict).toBe('PASS');
    const card = join(router.replace(/\.md$/, ''), 'aoe.md');
    writeFileSync(card, `${readFileSync(card, 'utf8').replace('## Produces   → FORWARD DEP\n', '## Produces   → FORWARD DEP\n\n- [tight] @infra a second datastore\n')}`);

    const r = run(router, [], lock);
    expect(r.verdict, r.out).toBe('PASS');
    expect(r.out).not.toContain('DEBT_GROWTH');
    expect(r.out).toContain('CLASS_DRIFT');
    expect(r.classes).toBe('edge=2 surface=1 infra=2 internal=1 debt=1');
    expect(sync(router, lock).verdict).toBe('PASS');
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

  it('the lock is a MULTISET: dropping one of two identical EDGE lines is reported stale', { timeout: 120_000 }, () => {
    const router = corpus({
      components: [['aoe', 'aoe.md'], ['landing/', 'landing.md']],
      cards: [
        { file: 'aoe.md', produces: ['- [tight] `landing/` — the first contract', '- [tight] `landing/` — the second contract'] },
        { file: 'landing.md', consumes: ['- [tight] `aoe` — one mirror covers both'] },
      ],
    });
    expect(sync(router, lock).verdict).toBe('PASS');
    expect(JSON.parse(readFileSync(lock, 'utf8')).edges.filter((e: string) => e === 'aoe:produces:landing/=tight')).toHaveLength(2);

    const a = join(router.replace(/\.md$/, ''), 'aoe.md');
    writeFileSync(a, readFileSync(a, 'utf8').replace('- [tight] `landing/` — the second contract\n', ''));
    const r = run(router, [], lock);
    expect(r.verdict, r.out).toBe('PASS');
    expect(r.out).toMatch(/stale: 0 id\(s\) added, 1 removed/);
  });

  it('a missing lock is INDETERMINATE, never a pass over an unratcheted corpus', { timeout: 120_000 }, () => {
    const r = run(consistentCorpus(), [], lock);
    expect(r.verdict, r.out).toBe('INDETERMINATE');
    expect(r.code).toBe(3);
    expect(r.coverageLines).toBe(1);
    expect(r.classLines).toBe(1);
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
      cards: [{ file: 'aoe.md', consumes: ['- [tight] @surface `Telegram Bot` — x'], omitProduces: true }],
    });
    const r = run(router, [], lock);
    expect(r.verdict, r.out).toBe('INDETERMINATE');
    expect(r.code).toBe(3);
  });

  it('a §3 row whose card file is missing FAILs, and an unreferenced card file FAILs', { timeout: 120_000 }, () => {
    const missing = run(
      corpus({ components: [['aoe', 'aoe.md'], ['ghost', 'ghost.md']], cards: [{ file: 'aoe.md', produces: ['- [tight] @surface `Telegram Bot` — x'] }] }),
      [], lock,
    );
    expect(missing.verdict, missing.out).toBe('FAIL');
    expect(missing.out).toContain('MISSING_CARD');
    expect(missing.out).toContain('ghost.md');

    const orphan = run(
      corpus({ components: [['aoe', 'aoe.md']], cards: [{ file: 'aoe.md', produces: ['- [tight] @surface `Telegram Bot` — x'] }], orphanCards: ['stray.md'] }),
      [], lock,
    );
    expect(orphan.verdict, orphan.out).toBe('FAIL');
    expect(orphan.out).toContain('ORPHAN_CARD');
    expect(orphan.out).toContain('stray.md');
  });

  it('prints exactly one CLASSES line in every mode, including a refused argument', { timeout: 120_000 }, () => {
    const router = consistentCorpus();
    const s = sync(router, lock);
    expect(s.classLines, s.out).toBe(1);
    expect(s.classes).toBe(CONSISTENT_CLASSES);
    for (const r of [run(router, [], lock), run(null, [], lock), run(null, ['--bogus'], lock), run(null, ['--self-test'], lock)]) {
      expect(r.classLines, r.out).toBe(1);
      expect(r.tokens, r.out).toBe(1);
      expect(r.coverageLines, r.out).toBe(1);
    }
    const bad = run(null, ['--bogus'], lock);
    expect(bad.verdict).toBe('INDETERMINATE');
    expect(bad.classes).toBe('unknown');
  });
});

describe('check-map-edges.mjs — lock mode (the corpus is unreachable, as in CI)', () => {
  it('verifies the lock alone: consistent → PASS, tampered → FAIL, missing → INDETERMINATE', { timeout: 120_000 }, () => {
    const lock = freshLock('map-edges-lockmode-');
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

  it('a grammar-2 lock verifies, and its class counts are the SAME derivation as the corpus run', { timeout: 120_000 }, () => {
    const lock = freshLock('map-edges-g2-');
    const router = consistentCorpus();
    const synced = sync(router, lock);
    expect(synced.verdict, synced.out).toBe('PASS');
    const written = JSON.parse(readFileSync(lock, 'utf8'));
    expect(written.generated_by).toBe(GEN_V2);
    expect(written.edges).toContain('aoe:produces:infra:1=tight');
    expect(written.edges).toContain('aoe:produces:internal:1=tight');
    expect(written.edges).toContain('aoe:produces:ext:Telegram Bot=tight');

    const corpusRun = run(router, [], lock);
    const lockRun = run(null, [], lock);
    expect(lockRun.verdict, lockRun.out).toBe('PASS');
    expect(lockRun.classes).toBe(corpusRun.classes);
    expect(lockRun.coverage).toBe(corpusRun.coverage);
  });

  it('rejects a malformed or non-contiguous class id, a disagreeing debt map, and a grammar-1 label on class ids', { timeout: 120_000 }, () => {
    const lock = freshLock('map-edges-tamper-');
    expect(sync(consistentCorpus(), lock).verdict).toBe('PASS');
    const pristine = readFileSync(lock, 'utf8');
    const mutate = (fn: (l: Record<string, any>) => void): Run => {
      const l = JSON.parse(pristine);
      fn(l);
      writeFileSync(lock, JSON.stringify(l, null, 2));
      return run(null, [], lock);
    };
    const swap = (from: string, to: string) => (l: Record<string, any>) => { l.edges = l.edges.map((e: string) => (e === from ? to : e)); };

    for (const [label, fn] of [
      ['non-numeric class index', swap('aoe:produces:infra:1=tight', 'aoe:produces:infra:x=tight')],
      ['zero class index', swap('aoe:produces:infra:1=tight', 'aoe:produces:infra:0=tight')],
      ['zero-padded class index', swap('aoe:produces:internal:1=tight', 'aoe:produces:internal:01=tight')],
      ['non-contiguous class index', swap('aoe:produces:infra:1=tight', 'aoe:produces:infra:2=tight')],
      ['debt map disagrees with the debt ids', (l: Record<string, any>) => { l.debt.aoe = 5; }],
      ['debt map is missing a component', (l: Record<string, any>) => { delete l.debt['landing/']; }],
      ['debt map is not an object', (l: Record<string, any>) => { l.debt = null; }],
      ['grammar-1 label on a lock carrying class ids', (l: Record<string, any>) => { l.generated_by = GEN_V1; }],
    ] as const) {
      const r = mutate(fn as (l: Record<string, any>) => void);
      expect(r.verdict, `${label}\n${r.out}`).not.toBe('PASS');
      expect(r.tokens, label).toBe(1);
    }
  });

  it('accepts the grammar-1 label on a lock with no class ids (the lock CH2 lands against)', { timeout: 120_000 }, () => {
    const lock = freshLock('map-edges-g1-');
    const router = corpus({
      components: [['aoe', 'aoe.md'], ['landing/', 'landing.md']],
      cards: [{ file: 'aoe.md', produces: ['- [tight] `landing/` — x', '- [tight] prose debt'] }, { file: 'landing.md', consumes: ['- [tight] `aoe` — x'] }],
    });
    expect(sync(router, lock).verdict).toBe('PASS');
    const l = JSON.parse(readFileSync(lock, 'utf8'));
    l.generated_by = GEN_V1;
    writeFileSync(lock, JSON.stringify(l, null, 2));
    const r = run(null, [], lock);
    expect(r.verdict, r.out).toBe('PASS');
  });

  it('a lock that parses to null or {} is INDETERMINATE with exactly one token — never a crash', { timeout: 120_000 }, () => {
    const lock = freshLock('map-edges-null-');
    for (const body of ['null', '{}', '[]', '"a string"']) {
      writeFileSync(lock, body);
      for (const r of [run(null, [], lock), run(consistentCorpus(), [], lock)]) {
        expect(r.verdict, `${body}\n${r.out}`).toBe('INDETERMINATE');
        expect(r.code, body).toBe(3);
        expect(r.tokens, body).toBe(1);
        expect(r.classLines, body).toBe(1);
      }
    }
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
    expect(lock.components.length).toBeGreaterThan(0);
    expect(lock.edges.length).toBeGreaterThan(0);

    const ids = new Set<string>(lock.components);
    const surfaces = new Set<string>(lock.surfaces_referenced);
    const debtIds: Record<string, number> = {};
    let classIds = 0;
    for (const e of lock.edges as string[]) {
      const p = parseEdgeId(e);
      expect(p, `edge id is not identifier-shaped: ${e}`).toBeTruthy();
      expect(ids.has(p!.card), `edge id names an unknown card: ${e}`).toBe(true);
      if (p!.kind === 'external') expect(surfaces.has(p!.counterpart!)).toBe(true);
      if (p!.kind === 'component') expect(ids.has(p!.counterpart!)).toBe(true);
      if (p!.kind === 'debt') debtIds[p!.card] = (debtIds[p!.card] ?? 0) + 1;
      if (p!.kind === 'infra' || p!.kind === 'internal') classIds++;
      expect(e).not.toMatch(/:L?\d+:\d+/);   // no line:col coordinates
    }
    // A grammar-1 label is legal only on a lock that carries no class ids.
    expect([GEN_V1, GEN_V2]).toContain(lock.generated_by);
    if (classIds > 0) expect(lock.generated_by).toBe(GEN_V2);
    // The debt map is the ratchet's number; it must be the same count the ids carry.
    expect(Object.keys(lock.debt).sort()).toEqual([...ids].sort());
    for (const [card, n] of Object.entries(lock.debt as Record<string, number>)) {
      expect(n, `debt for ${card}`).toBe(debtIds[card] ?? 0);
    }
    // Nothing in the lock may be a sentence: every string is an id, a surface, an edge id, the
    // sha, or the generator path. Prose has spaces AND lowercase words; ids are bounded.
    for (const s of JSON.stringify(lock).match(/"[^"]*"/g) ?? []) {
      expect(s.length, `lock string too long to be an identifier: ${s}`).toBeLessThanOrEqual(130);
    }
  });

  it('parseEdgeId reads every id form and refuses the malformed ones', { timeout: 60_000 }, () => {
    expect(parseEdgeId('aoe:produces:landing/=tight')).toMatchObject({ card: 'aoe', direction: 'produces', kind: 'component', counterpart: 'landing/', flag: 'tight' });
    expect(parseEdgeId('aoe:consumes:ext:Telegram Bot=loose')).toMatchObject({ kind: 'external', counterpart: 'Telegram Bot', flag: 'loose' });
    expect(parseEdgeId('landing/:produces:infra:3=documented-only')).toMatchObject({ card: 'landing/', kind: 'infra', index: 3 });
    expect(parseEdgeId('aoe:produces:internal:12=tight')).toMatchObject({ kind: 'internal', index: 12 });
    expect(parseEdgeId('Plausible CE:consumes:debt:1=tight')).toMatchObject({ card: 'Plausible CE', kind: 'debt', index: 1 });
    for (const bad of ['aoe:produces:infra:0=tight', 'aoe:produces:internal:01=tight', 'aoe:produces:infra:x=tight',
      'aoe:sideways:x=tight', 'aoe:produces:x=firm', 'aoe:produces:debt:=tight', 'no-separators-at-all']) {
      expect(parseEdgeId(bad), bad).toBeNull();
    }
  });

  it('the gate is wired into deploy.yml as a --self-test + check pair', { timeout: 60_000 }, () => {
    const wf = readFileSync(join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8');
    expect(wf).toContain('node scripts/check-map-edges.mjs --self-test');
    expect(wf).toMatch(/node scripts\/check-map-edges\.mjs\s*$/m);
  });

  it('the pre-commit block, where installed, is REPORT-ONLY', { timeout: 60_000 }, () => {
    // `git config --get` EXITS 1 when the key is unset, so execFileSync THROWS rather than
    // returning '' — and an unset core.hooksPath is the NORMAL state on a CI runner. Measured:
    // this test passed on the workstation (where the key is set) and killed the pre-deploy suite
    // on ubuntu, blocking the deploy. A readback that raises is not an assertion.
    let hooks = '';
    try {
      hooks = execFileSync('git', ['config', '--get', 'core.hooksPath'], { cwd: ROOT, encoding: 'utf8' }).trim();
    } catch {
      hooks = '';
    }
    const hook = hooks ? join(hooks, 'pre-commit') : '';
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
    // SHAPE ONLY (OPS-SYSTEM-MAP-EDGE-TAXONOMY-W1 Q-E). This block runs inside the shared pre-push
    // test gate on every workstation that mounts the vault. The vault is edited by sessions that
    // are not the pusher, so asserting its VERDICT here would turn any card typo into a push
    // refusal for every worktree — while the ratified blocking leg for this corpus is deploy.yml's
    // lock check, and the pre-commit block reports only, precisely because "a blocking verdict must
    // land on someone who can act on it". What IS the pusher's to own: the gate still parses the
    // real map and prints one of each token.
    it('runs on the real map and prints one verdict, one coverage line, one classes line, and the edge-less list', { timeout: 120_000 }, () => {
      const r = run(null, [], COMMITTED_LOCK);
      // SYSTEM_MAP_PATH unset would be ideal, but run() always sets it; use the declared default.
      const declared = readFileSync(PATH_LIB, 'utf8').match(/SYSTEM_MAP_PATH:-([^}]+)\}/)?.[1] ?? '';
      const live = run(declared, [], COMMITTED_LOCK);
      expect(live.tokens, live.out).toBe(1);
      expect(live.coverageLines, live.out).toBe(1);
      expect(live.classLines, live.out).toBe(1);
      expect(['PASS', 'FAIL', 'INDETERMINATE']).toContain(live.verdict);
      expect(live.out).toMatch(/cards with ZERO edges[^\n]*: \S/);
      expect(r.tokens).toBe(1);
    });
  },
);
