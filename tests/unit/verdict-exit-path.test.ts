/**
 * OPS-PREVERIFY-RED-UNREAD-W1 CH2 (architect ruling Q-B) — a VERDICT TOKEN MUST SURVIVE A PIPE.
 *
 * BUG CLASS. Any verdict-emitting gate that relays output to stdout and terminates with
 * `process.exit()` loses its trailing `<GATE>_VERDICT=` line when stdout is a pipe: pipe writes are
 * asynchronous on POSIX and process.exit() abandons what is still queued (nodejs.org/api/process.html,
 * "A note on process I/O"). A caller that greps the token then reads "no token". It is invisible
 * until the output outgrows the pipe (64 KiB on Linux), and then it is permanent.
 *
 * WHY THIS IS A GATE AND NOT A FOURTH FIX. Three prior fixes each repaired ONE script and left a
 * comment: d5b7e755 (runScript drain, 2026-08-24), 05802215 (check-caller-tags.mjs, 2026-09-22) and
 * f81f7da9 (check-form-action-conformance.mjs, 2026-09-26) — the last two carry the very sentence
 * "never process.exit(): a queued pipe write would lose the token". The fourth instance was
 * scripts/check-publish-lane-preverify.mjs, whose lost token kept publish-lane-preverify.yml red for
 * 51 of 53 runs while every chain segment passed. CLAUDE.md: the 4th same-cause fix MUST make the
 * class structurally impossible. Prose failed three times; this is the gate.
 *
 * THE RULE. A tracked script that emits a `<GATE>_VERDICT=` token may not call `process.exit()`.
 * Set `process.exitCode` and let Node drain stdout and exit on its own.
 *
 * HONEST SCOPE — A RATCHET, NOT A SWEEP. The pre-existing violators are DECLARED in
 * ops/verdict-exit-baseline.json with a per-file count that may only FALL. Measured when this landed,
 * only one script was over the cliff (the pre-verify gate, fixed in the same commit); the rest relay
 * small outputs with ≥13× headroom. So a NEW gate written the old way is refused today, while the
 * existing debt is enumerated and monotone. Entries flagged `piped_consumer: true` are the scripts
 * whose token IS read through a pipe or `$(...)` — the subset a migration tightens first; that list
 * was MEASURED once and recorded so nobody re-derives it.
 *
 * WHAT COUNTS. Corpus = tracked .mjs/.cjs/.js/.ts outside tests/, node_modules/ and dist/, excluding
 * *.d.ts. "Verdict-emitting" = the source mentions `<X>_VERDICT` in CODE (a string, template or
 * identifier — comments are not AST nodes, so prose never qualifies). "Calls process.exit" = a
 * `process.exit(...)` CallExpression. Both are read from the TypeScript AST, never by regex.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

const ROOT = resolve(__dirname, '..', '..');
const BASELINE_PATH = 'ops/verdict-exit-baseline.json';

type Hit = { file: string; exits: number; lines: number[] };
type Entry = { count: number; piped_consumer: boolean; consumer?: string };
type Baseline = { files: Record<string, Entry>; _total: number };

const IN_CORPUS = (p: string) =>
  /\.(mjs|cjs|js|ts)$/.test(p) &&
  !/\.d\.ts$/.test(p) &&
  !/^(tests|node_modules|dist)\//.test(p) &&
  !/\.(test|spec)\.[cm]?[jt]s$/.test(p);

/** Pure: one source text → does it emit a verdict token, and where does it call process.exit? */
function scanSource(file: string, text: string): { verdict: boolean; exitLines: number[] } {
  const kind = file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  let verdict = false;
  const exitLines: number[] = [];
  const visit = (n: ts.Node): void => {
    if (
      (ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isIdentifier(n)) &&
      /[A-Z0-9]_VERDICT/.test(n.text)
    ) verdict = true;
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === 'process' &&
      n.expression.name.text === 'exit'
    ) exitLines.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { verdict, exitLines };
}

/** Pure: scan results + baseline → every way the ratchet can be broken. */
function judge(hits: Hit[], baseline: Baseline) {
  const byFile = new Map(hits.map((h) => [h.file, h]));
  const newViolators = hits.filter((h) => h.exits > 0 && !baseline.files[h.file]);
  const exceeded = hits.filter((h) => baseline.files[h.file] && h.exits > baseline.files[h.file].count);
  const lowered = hits.filter((h) => baseline.files[h.file] && h.exits > 0 && h.exits < baseline.files[h.file].count);
  const stale = Object.keys(baseline.files).filter((f) => !byFile.has(f) || byFile.get(f)!.exits === 0);
  return { newViolators, exceeded, lowered, stale };
}

function scanTree(): { corpus: number; verdictFiles: number; hits: Hit[] } {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean)
    .filter(IN_CORPUS);
  const hits: Hit[] = [];
  for (const file of files) {
    let text: string;
    try { text = readFileSync(join(ROOT, file), 'utf8'); } catch { continue; } // deleted in the working tree
    if (!text.includes('_VERDICT')) continue;
    const r = scanSource(file, text);
    if (r.verdict) hits.push({ file, exits: r.exitLines.length, lines: r.exitLines });
  }
  return { corpus: files.length, verdictFiles: hits.length, hits };
}

const baseline: Baseline = JSON.parse(readFileSync(join(ROOT, BASELINE_PATH), 'utf8'));
const live = scanTree();
const verdictOf = judge(live.hits, baseline);
const where = (h: Hit) => `${h.file}:${h.lines.join(',')}`;

describe('the scanner reads code, not prose', () => {
  it('finds a real process.exit() and ignores one in a comment', () => {
    const src = "// process.exit(1) in prose\n/* process.exit(2) */\nconst T = 'X_VERDICT';\nconsole.log(`${T}=PASS`);\nprocess.exit(0);\n";
    expect(scanSource('a.mjs', src)).toEqual({ verdict: true, exitLines: [5] });
  });

  it('does not treat a _VERDICT mentioned only in a comment as a verdict emitter', () => {
    expect(scanSource('b.mjs', '// prints FOO_VERDICT=PASS\nprocess.exit(0);\n').verdict).toBe(false);
  });

  it('sees through TypeScript syntax and template literals', () => {
    const src = 'const n: number = 1;\nconsole.log(`GATE_VERDICT=${n}`);\nprocess.exitCode = n;\n';
    expect(scanSource('c.ts', src)).toEqual({ verdict: true, exitLines: [] });
  });
});

describe('the judge can fail — every way the ratchet can break is reported', () => {
  const base: Baseline = { _total: 2, files: { 'a.mjs': { count: 2, piped_consumer: false } } };
  it('clean is clean', () => {
    const j = judge([{ file: 'a.mjs', exits: 2, lines: [1, 2] }], base);
    expect([j.newViolators, j.exceeded, j.lowered, j.stale].every((x) => x.length === 0)).toBe(true);
  });
  it('a NEW violator is reported', () => {
    expect(judge([{ file: 'a.mjs', exits: 2, lines: [1, 2] }, { file: 'b.mjs', exits: 1, lines: [9] }], base).newViolators.map((h) => h.file)).toEqual(['b.mjs']);
  });
  it('a baselined file GROWING is reported', () => {
    expect(judge([{ file: 'a.mjs', exits: 3, lines: [1, 2, 3] }], base).exceeded.length).toBe(1);
  });
  it('a baselined file SHRINKING demands the baseline shrink too', () => {
    expect(judge([{ file: 'a.mjs', exits: 1, lines: [1] }], base).lowered.length).toBe(1);
  });
  it('a baselined file that no longer violates (or no longer exists) is STALE', () => {
    expect(judge([{ file: 'a.mjs', exits: 0, lines: [] }], base).stale).toEqual(['a.mjs']);
    expect(judge([], base).stale).toEqual(['a.mjs']);
  });
});

describe('the live tree', () => {
  it('scanned a real corpus — a sweep that searched nothing looks exactly like a clean one', () => {
    console.log(`verdict-exit scan: ${live.corpus} tracked source file(s), ${live.verdictFiles} verdict-emitting, ${live.hits.filter((h) => h.exits > 0).length} calling process.exit()`);
    expect(live.corpus).toBeGreaterThan(500);
    expect(live.verdictFiles).toBeGreaterThan(50);
  });

  it('no NEW verdict-emitting script calls process.exit()', () => {
    expect(
      verdictOf.newViolators.map(where),
      'set `process.exitCode = <code>` and return instead — process.exit() drops a queued pipe write, and the token is the last line written',
    ).toEqual([]);
  });

  it('no baselined script gained a process.exit() call', () => {
    expect(verdictOf.exceeded.map((h) => `${where(h)} (baseline ${baseline.files[h.file].count})`)).toEqual([]);
  });

  it(`the ratchet only tightens — a script that lost exits lowers its count in ${BASELINE_PATH}`, () => {
    expect(verdictOf.lowered.map((h) => `${h.file}: lower count ${baseline.files[h.file].count} -> ${h.exits}`)).toEqual([]);
  });

  it(`an entry whose script no longer violates is DELETED from ${BASELINE_PATH}`, () => {
    expect(verdictOf.stale).toEqual([]);
  });
});

describe(`${BASELINE_PATH} is honest about itself`, () => {
  const entries = Object.entries(baseline.files);

  it('every entry carries a positive count and a boolean piped_consumer', () => {
    for (const [f, e] of entries) {
      expect(Number.isInteger(e.count) && e.count > 0, `${f} count`).toBe(true);
      expect(typeof e.piped_consumer, `${f} piped_consumer`).toBe('boolean');
    }
  });

  it('every piped_consumer names WHERE its token is read through a pipe — enumeration, not detection', () => {
    for (const [f, e] of entries.filter(([, x]) => x.piped_consumer)) {
      expect(typeof e.consumer === 'string' && e.consumer.length > 10, `${f} consumer`).toBe(true);
    }
    expect(entries.some(([, e]) => e.piped_consumer), 'the measured piped subset was recorded').toBe(true);
  });

  it('_total equals the sum of the counts', () => {
    expect(baseline._total).toBe(entries.reduce((s, [, e]) => s + e.count, 0));
  });

  it('the two clean exemplars stay clean and out of the baseline', () => {
    for (const f of ['scripts/check-publish-lane-preverify.mjs', 'scripts/check-release-readiness.mjs']) {
      expect(baseline.files[f], `${f} must never be baselined`).toBeUndefined();
      const h = live.hits.find((x) => x.file === f);
      expect(h, `${f} is no longer verdict-emitting?`).toBeTruthy();
      expect(h!.exits, `${f} calls process.exit()`).toBe(0);
    }
  });
});
