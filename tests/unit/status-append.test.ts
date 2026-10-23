/**
 * status-append.test.ts — OPS-STATUS-INDEX-LEDGER-W1.
 *
 * The status.md writer driven the way a wave drives it: the CLI on an entry file, against a
 * scratch vault (mkdtemp) holding the declared layout — trim-status-config.md, status.md, the
 * Old Status ledgers — and a scratch budget manifest. Nothing here touches the real vault.
 *
 * The one real-world read is the repo's own ops/session-budget.json: the cap the writer judges
 * by must be the declared 40,000 B, not a fixture's.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  makeVault, entryFixture, run, loadBudget, pointerOf, indexRow, cutCell, capOwed, rowHeadBytes, norm, dedupe, ledgerMap, insertIntoLedger,
  splitBlocks, STATUS_FIXTURE, INDEX_START, INDEX_END, ROW_MAX_BYTES, EXIT, Refusal,
} from '../../ops/scripts/status-append.mjs';

const REPO = resolve(__dirname, '..', '..');
const SCRIPT = join(REPO, 'ops', 'scripts', 'status-append.mjs');
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'status-append-test-')));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let seq = 0;
const vault = (opts: { cap?: number; status?: string } = {}) => makeVault(join(ROOT, `v${seq++}`), opts);
const cli = (args: string[], env: NodeJS.ProcessEnv = process.env) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8', timeout: 60_000 });
  return { out: r.stdout ?? '', err: r.stderr ?? '', status: r.status ?? -1 };
};
const token = (s: string) => s.trim().split('\n').pop();
const entry = (v: { vault: string }, heading: string, body?: string) => {
  const f = join(v.vault, `entry-${seq++}.md`);
  writeFileSync(f, entryFixture(heading, body));
  return f;
};
const append = (v: { vault: string; budgetFile: string }, f: string, extra: string[] = []) =>
  cli([f, '--vault', v.vault, '--budget', v.budgetFile, '--now', '2026-10-23T12:00:00Z', ...extra]);
const status = (v: { vault: string }) => readFileSync(join(v.vault, 'status.md'), 'utf8');
const october = (v: { vault: string }) => readFileSync(join(v.vault, 'Old Status', 'Status October 2026.md'), 'utf8');
const snapshot = (v: { vault: string }) => [status(v), ...readdirSync(join(v.vault, 'Old Status')).sort()
  .map((f) => readFileSync(join(v.vault, 'Old Status', f), 'utf8'))];
const lines = (s: string, needle: string) => s.split('\n').filter((l) => l === needle).length;

const H = '2026-10-23 10:00 UTC — OPS-TEST-W1 CH1 — ✅ GREEN: the test entry';

describe('self-test', () => {
  it('prints STATUS_APPEND_SELFTEST=PASS and exits 0', () => {
    const r = cli(['--self-test']);
    expect(token(r.out), r.out + r.err).toBe('STATUS_APPEND_SELFTEST=PASS');
    expect(r.status).toBe(0);
  });
});

describe('append', () => {
  it('writes the entry once to its ledger and leaves status.md an index', () => {
    const v = vault();
    const before = october(v);
    const r = append(v, entry(v, H));
    expect(token(r.out), r.err).toBe('STATUS_APPEND_VERDICT=PASS');
    expect(r.status).toBe(EXIT.PASS);
    expect(lines(october(v), `### ${H}`)).toBe(1);
    // byte-exact: the ledger is the old one plus exactly the inserted block, under the anchor
    expect(october(v).replace(`\n### ${H}\n\nbody line one\n\nsystem-map.md updated: n-a\n`, '')).toBe(before);
    const s = status(v);
    expect(s.split('\n').filter((l) => l.startsWith('### '))).toEqual([]);
    expect(s).toContain('- `2026-10-23 10:00 UTC — OPS-TEST-W1 CH1` — ✅ GREEN: the test entry');
    expect(s.indexOf(INDEX_START)).toBeLessThan(s.indexOf(INDEX_END));
  });

  it('logs one JSON line per write, and none for a dry run', () => {
    const v = vault();
    const snap = snapshot(v);
    expect(token(append(v, entry(v, H), ['--dry-run']).out)).toBe('STATUS_APPEND_VERDICT=PASS');
    expect(snapshot(v)).toEqual(snap);
    expect(existsSync(join(v.vault, 'Claude files', 'status-append.jsonl'))).toBe(false);
    append(v, entry(v, H));
    const log = readFileSync(join(v.vault, 'Claude files', 'status-append.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ mode: 'append', verdict: 'PASS', wave: 'OPS-TEST-W1', inserted: 1, cap: 40000 });
  });

  it('is idempotent, and a changed body becomes an (amended copy), never a drop', () => {
    const v = vault();
    append(v, entry(v, H));
    const once = snapshot(v);
    expect(token(append(v, entry(v, H)).out)).toBe('STATUS_APPEND_VERDICT=PASS');
    expect(snapshot(v)).toEqual(once);
    expect(token(append(v, entry(v, H, 'a corrected body')).out)).toBe('STATUS_APPEND_VERDICT=PASS');
    expect([lines(october(v), `### ${H}`), lines(october(v), `### ${H} (amended copy)`)]).toEqual([1, 1]);
    const twice = snapshot(v);
    const r = append(v, entry(v, H, 'a third body'));
    expect([token(r.out), r.status]).toEqual(['STATUS_APPEND_VERDICT=INDETERMINATE', EXIT.INDETERMINATE]);
    expect(snapshot(v)).toEqual(twice);
  });

  it('refuses a NEW entry whose heading fails the strict grammar, naming the grammar', () => {
    const v = vault();
    const snap = snapshot(v);
    for (const h of ['2026-10-23 — OPS-TEST-W1 CH1 — ✅ GREEN: no time', '2026-10-23 10:00 UTC — OPS-TEST-W1 CH1 — GREEN: no glyph',
      '2026-10-23 10:00 UTC — ops-test-w1 CH1 — ✅ GREEN: lower-case wave', '2026-10-23 10:00 UTC — OPS-TEST-W1 — ✅ GREEN: no step']) {
      const r = append(v, entry(v, h));
      expect(token(r.out), h).toBe('STATUS_APPEND_VERDICT=INDETERMINATE');
      expect(r.err).toContain('### YYYY-MM-DD HH:MM UTC — <WAVE> <step> — <✅|⚠️|🛑|⏭️|⏳> <outcome>');
    }
    expect(snapshot(v)).toEqual(snap);
  });

  it('refuses a wave SPLIT_FILES routes elsewhere (AOE-status.md is not this writer\'s file)', () => {
    const v = vault();
    const r = append(v, entry(v, '2026-10-23 10:00 UTC — AOE-PHASE-W9 CH1 — ✅ GREEN: x'));
    expect(token(r.out)).toBe('STATUS_APPEND_VERDICT=INDETERMINATE');
    expect(r.err).toContain('AOE-status.md');
  });
});

describe('budget (ruling Q1)', () => {
  it('OVER when header + register + the 7-day floor exceed the cap — exit 1, nothing written', () => {
    const v = vault({ cap: 900 });
    const snap = snapshot(v);
    const r = append(v, entry(v, H));
    expect([token(r.out), r.status]).toEqual(['STATUS_APPEND_VERDICT=OVER', EXIT.OVER]);
    expect(r.err).toMatch(/would be \d+ B > cap 900 B/);
    expect(snapshot(v)).toEqual(snap);
  });

  it('trims the window to what fits, never below the floor, never older than 30 days', () => {
    const v = vault();
    const now = new Date('2026-10-23T12:00:00Z');
    const days = Array.from({ length: 40 }, (_, i) => new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10));
    for (const [i, d] of days.entries()) run({ ...v, now, entryText: entryFixture(`${d} 09:00 UTC — OPS-DAY${i}-W1 CH1 — ✅ GREEN: day ${i} ${'x'.repeat(150)}`) });
    const full = run({ ...v, now, dryRun: true });
    expect(full.index_candidates).toBe(30 + 2); // 30 days of OPS-DAY rows + the fixture ledger's two in-window headings
    expect(status(v)).not.toContain('OPS-DAY30-W1');
    writeFileSync(v.budgetFile, JSON.stringify({ files: { 'status.md': full.status_bytes - 1 } }));
    const trimmed = run({ ...v, now });
    expect(trimmed.index_rows).toBe(full.index_rows - 1);
    expect(trimmed.status_bytes).toBeLessThanOrEqual(full.status_bytes - 1);
    expect(trimmed.index_rows).toBeGreaterThanOrEqual(trimmed.index_floor);
    expect(status(v).split('\n').filter((l) => l.startsWith('- `')).every((l) => Buffer.byteLength(l) <= ROW_MAX_BYTES)).toBe(true);
  });

  it('the repo manifest declares the ruled caps', () => {
    const caps = loadBudget();
    expect(caps['status.md']).toBe(40000);
    expect(Object.keys(caps).sort()).toEqual(['AOE-status.md', 'CLAUDE.md', 'status.md']);
  });
});

describe('sweep + self-healing index', () => {
  it('moves a hand-appended `### ` block into its ledger and rebuilds a clobbered index', () => {
    const v = vault();
    append(v, entry(v, H));
    const clobbered = status(v).replace(/<!-- status-append:index:start -->[\s\S]*<!-- status-append:index:end -->/,
      `${INDEX_START}\n- \`stale row\`\n${INDEX_END}`) + '### 2026-10-22 08:00 UTC — OPS-HAND-W1 CH1 — ✅ GREEN: by hand\nhand body\n';
    writeFileSync(join(v.vault, 'status.md'), clobbered);
    const r = cli(['--sweep', '--vault', v.vault, '--budget', v.budgetFile, '--now', '2026-10-23T12:00:00Z']);
    expect(token(r.out), r.err).toBe('STATUS_APPEND_VERDICT=PASS');
    expect(lines(october(v), '### 2026-10-22 08:00 UTC — OPS-HAND-W1 CH1 — ✅ GREEN: by hand')).toBe(1);
    expect(status(v)).not.toContain('stale row');
    expect(status(v)).toContain('- `2026-10-22 08:00 UTC — OPS-HAND-W1 CH1`');
    expect(status(v)).toContain('- `2026-10-23 10:00 UTC — OPS-TEST-W1 CH1`');
    expect(status(v)).not.toMatch(/^### /m);
  });

  it('refuses unbalanced index markers rather than guess where the index ends', () => {
    const v = vault({ status: `${STATUS_FIXTURE}${INDEX_START}\n- \`a row\`\n` });
    const r = cli(['--sweep', '--vault', v.vault, '--budget', v.budgetFile]);
    expect(token(r.out)).toBe('STATUS_APPEND_VERDICT=INDETERMINATE');
  });

  it('refuses an undated stray block (no ledger month to put it in)', () => {
    const v = vault({ status: `${STATUS_FIXTURE}### a heading with no date\nbody\n` });
    expect(token(cli(['--sweep', '--vault', v.vault, '--budget', v.budgetFile]).out)).toBe('STATUS_APPEND_VERDICT=INDETERMINATE');
  });
});

describe('register (ruling Q3)', () => {
  const reg = (state: string, owed: string | null, close: string) => `body\n\nRegister: ${state}${owed ? ` · Owed: ${owed}` : ''} · CLOSE_WHEN: ${close}`;
  const row = (s: string, wave: string) => s.split('\n').filter((l) => l.startsWith(`| \`${wave}\` |`));

  it('inserts, then updates, the entry\'s OWN row; CLOSE_WHEN verbatim; other rows untouched', () => {
    const v = vault();
    const other = row(status(v), 'OPS-OTHER-W1');
    append(v, entry(v, H, reg('OWED', 'the day-7 read', 'on/after 2026-10-30 `x --report` | PASS')));
    expect(row(status(v), 'OPS-TEST-W1')).toEqual(['| `OPS-TEST-W1` | OWED | the day-7 read | on/after 2026-10-30 `x --report` \\| PASS |']);
    append(v, entry(v, '2026-10-23 11:00 UTC — OPS-TEST-W1 CH2 — 🛑 HALTED: Q1 owed', reg('ARCHITECT', null, 'Q1 ruled')));
    expect(row(status(v), 'OPS-TEST-W1')).toEqual(['| `OPS-TEST-W1` | ARCHITECT | entry `2026-10-23 11:00 UTC — OPS-TEST-W1 CH2` | Q1 ruled |']);
    expect(row(status(v), 'OPS-OTHER-W1')).toEqual(other);
    expect(status(v)).toContain('<!-- status-append:register-count -->**1 OWED · 1 ARCHITECT · 1 NOTED · 0 CLOSED** (3 rows)');
  });

  it('caps wave + state + owed at 600 B with a pointer to the entry, CLOSE_WHEN uncapped', () => {
    const v = vault();
    append(v, entry(v, H, reg('OWED', 'o'.repeat(900), 'c'.repeat(800))));
    const r = row(status(v), 'OPS-TEST-W1')[0];
    const cut = r.split(' | c')[0];
    expect(Buffer.byteLength(`${cut} |`)).toBeLessThanOrEqual(600);
    expect(r).toContain('… (full: `2026-10-23 10:00 UTC — OPS-TEST-W1 CH1`)');
    expect(r).toContain(`| ${'c'.repeat(800)} |`);
  });

  it('a cut owed cell closes its open code span and bold run, and keeps its pointer', () => {
    expect(cutCell('ab `cd ef` gh', 8)).toBe('ab `c`');
    expect(cutCell('**bold x** y', 8)).toBe('**bol**');
    expect(cutCell('a \\| b c d', 6)).toBe('a');
    const w = '`OPS-W-W1`';
    const owed = capOwed(w, 'OWED', `**CH3 GREEN** \`${'b'.repeat(900)}\``, 'Register snapshot 2026-10-23');
    expect(rowHeadBytes([w, 'OWED', owed])).toBeLessThanOrEqual(600);
    expect(owed.endsWith('`… (full: `Register snapshot 2026-10-23`)')).toBe(true);
    expect(owed.replace(/ \(full: `[^`]*`\)$/, '').split('`').length % 2).toBe(1);
  });

  it('never sets CLOSED and never touches a NOTED row', () => {
    const v = vault();
    const snap = snapshot(v);
    expect(token(append(v, entry(v, H, reg('CLOSED', null, 'x'))).out)).toBe('STATUS_APPEND_VERDICT=INDETERMINATE');
    expect(token(append(v, entry(v, '2026-10-23 10:00 UTC — OPS-DONE-W1 CH2 — ✅ GREEN: x', reg('OWED', null, 'x'))).out)).toBe('STATUS_APPEND_VERDICT=INDETERMINATE');
    expect(token(append(v, entry(v, H, `${reg('OWED', null, 'a')}\n${reg('OWED', null, 'b')}`)).out)).toBe('STATUS_APPEND_VERDICT=INDETERMINATE');
    expect(snapshot(v)).toEqual(snap);
  });
});

describe('compare-and-swap (ruling Q6)', () => {
  it('a status.md written after it was read is not overwritten; the ledger keeps the entry', () => {
    const v = vault();
    let caught: unknown = null;
    try {
      run({ ...v, now: new Date('2026-10-23T12:00:00Z'), entryText: entryFixture(H),
        hooks: { beforeWrite: ({ layout }: { layout: { statusPath: string } }) => writeFileSync(layout.statusPath, 'a concurrent writer\n') } });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(Refusal);
    expect((caught as Refusal).verdict).toBe('INDETERMINATE');
    expect(status(v)).toBe('a concurrent writer\n');
    expect(lines(october(v), `### ${H}`)).toBe(1);
    expect(readdirSync(v.vault).filter((f) => f.startsWith('.status-append-'))).toEqual([]);
  });
});

describe('ledger parsing (the shapes R0 measured)', () => {
  it('a trim batch note under an entry is not a body difference; a restoration note above it is', () => {
    expect(norm('body\n\n_Appended 2026-10-17 by TRIM-STATUS-018 — 44 entries not previously archived._')).toBe('body');
    const ledger = `${'## Archived entries (newest-first)'}\n\n### 2026-10-23 03:25 UTC — OPS-X-W1 CH3a — 🛑 HALTED: y\nbody\n\n_Appended by a trim._\n\n### 2026-10-17 — TRIM-STATUS-018: z\nz\n`;
    const map = ledgerMap([{ text: ledger }]);
    expect(dedupe(map, '2026-10-23 03:25 UTC — OPS-X-W1 CH3a — 🛑 HALTED: y', '\nbody\n')).toBeNull();
    expect(dedupe(map, '2026-10-23 03:25 UTC — OPS-X-W1 CH3a — 🛑 HALTED: y', '\n_Restored 2026-10-23 08:00 UTC: verbatim._\n\nbody\n'))
      .toBe('2026-10-23 03:25 UTC — OPS-X-W1 CH3a — 🛑 HALTED: y (amended copy)');
  });

  it('inserts under either anchor and keeps every other byte', () => {
    for (const anchor of ['## Archived entries (newest-first)', '## Archived Activity Log']) {
      const old = `# head\n\n${anchor}\n\n_note_\n\n### 2026-04-01 — OLD-W1 a — ✅ x\nold\n`;
      const r = insertIntoLedger(old, [{ heading: '2026-04-02 09:00 UTC — NEW-W1 CH1 — ✅ GREEN: y', body: '\nnew' }]);
      expect(r.text.slice(0, r.pos) + r.text.slice(r.pos + r.insertion.length)).toBe(old);
      expect(splitBlocks(r.text).map((b) => b.heading)).toEqual(['2026-04-02 09:00 UTC — NEW-W1 CH1 — ✅ GREEN: y', '2026-04-01 — OLD-W1 a — ✅ x']);
    }
    expect(() => insertIntoLedger('# no anchor\n', [{ heading: 'h', body: '' }])).toThrow(Refusal);
  });

  it('the pointer is timestamp + wave + step, extended only when two headings share it', () => {
    const a = '2026-10-22 16:52 UTC — OPS-XREPO-CI-CANARY-DARK-W2 CH2 — ✅ GREEN: one';
    const b = '2026-10-22 16:52 UTC — OPS-OTHER-W1 CH1 — ✅ GREEN: two';
    expect(pointerOf(a, [a, b])).toBe('2026-10-22 16:52 UTC — OPS-XREPO-CI-CANARY-DARK-W2 CH2');
    expect(pointerOf('2026-10-23 — TRIM-STATUS-019: archived 24 entries', [])).toBe('2026-10-23 — TRIM-STATUS-019'); // no time, no step: date + wave
    const long = '2026-10-02 15:26 UTC — RETROACTIVE CLOSE (Mr.1): 12 waves ended outside this log — ✅ CLOSED';
    expect(pointerOf(long, [long])).toBe('2026-10-02 15:26 UTC — RETROACTIVE CLOSE (Mr.1): 12 waves ended outside this log');
    expect(Buffer.byteLength(indexRow(`2026-10-23 10:00 UTC — OPS-LONG-W1 CH1 — ✅ ${'界'.repeat(200)}`, '2026-10-23 10:00 UTC — OPS-LONG-W1 CH1'))).toBeLessThanOrEqual(ROW_MAX_BYTES);
  });
});

describe('--report', () => {
  it('prints every files.* size against its cap; OVER names the file', () => {
    const v = vault();
    writeFileSync(v.budgetFile, JSON.stringify({ files: { 'status.md': 40000, 'trim-status-config.md': 10 } }));
    const r = cli(['--report', '--vault', v.vault, '--budget', v.budgetFile]);
    expect(token(r.out)).toBe('STATUS_BUDGET_VERDICT=OVER');
    expect(r.out).toMatch(/status\.md\s+\d+ \/ 40000 B\n/);
    expect(r.out).toMatch(/trim-status-config\.md\s+\d+ \/ 10 B {2}OVER/);
    writeFileSync(v.budgetFile, JSON.stringify({ files: { 'status.md': 40000, 'nope.md': 10 } }));
    expect(token(cli(['--report', '--vault', v.vault, '--budget', v.budgetFile]).out)).toBe('STATUS_BUDGET_VERDICT=INDETERMINATE');
  });
});

describe('vault path', () => {
  it('is projected from SYSTEM_MAP_PATH through scripts/lib/system-map-path.sh', () => {
    const v = vault();
    writeFileSync(join(v.vault, 'system-map.md'), '# fixture\n');
    const f = entry(v, H);
    const r = cli([f, '--budget', v.budgetFile, '--now', '2026-10-23T12:00:00Z'], { ...process.env, SYSTEM_MAP_PATH: join(v.vault, 'system-map.md') });
    expect(token(r.out), r.err).toBe('STATUS_APPEND_VERDICT=PASS');
    expect(lines(october(v), `### ${H}`)).toBe(1);
  });
});
