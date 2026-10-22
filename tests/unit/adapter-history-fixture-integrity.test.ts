/**
 * adapter-history-fixture-integrity.test.ts — OPS-SERVED-CANDLE-TRUTH-W1 (Cowork Q4).
 *
 * tests/fixtures/adapter-history/SHA256SUMS pins every file in that directory. Until this test it was checked only by
 * the OAH chapter gate (scripts/gates/oah-ch1-gate.sh), never by `npm test`. So when ab3b5a82 edited tools/capture.js
 * without a re-stamp, the pin stayed red for four days while CI stayed green.
 *
 * With this test, the next unstamped edit goes red at its own commit:
 *   - every line must match its file (node:crypto, so neither `shasum` nor `sha256sum` is needed);
 *   - the pinned set must EQUAL the directory's file set, in both directions.
 *
 * SHA256SUMS is a corpus WE construct, so an empty or unparseable file is a defect and is refused, never a pass.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = path.resolve(__dirname, '../fixtures/adapter-history');
const SUMS = 'SHA256SUMS';

interface Pin { hash: string; file: string }

/** `shasum -a 256` output: `<64 hex>  <path>` (or ` *<path>`) per line. A line of any other shape throws. */
function parseSums(text: string): Pin[] {
  return text.split('\n').filter((l) => l.length > 0).map((l, i) => {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(l);
    if (!m) throw new Error(`${SUMS} line ${i + 1} is not "<sha256>  <path>": ${JSON.stringify(l)}`);
    return { hash: m[1], file: m[2] };
  });
}

/** Every file under `dir`, relative with POSIX separators, excluding SHA256SUMS itself and dotfiles (.DS_Store). */
function filesUnder(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...filesUnder(dir, r));
    else if (r !== SUMS) out.push(r);
  }
  return out;
}

const sha256 = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/** The whole check over one directory. An empty pin file is refused: it would verify nothing. */
function verify(dir: string): { pinned: number; files: number; mismatched: string[]; unpinned: string[]; missing: string[] } {
  const pins = parseSums(fs.readFileSync(path.join(dir, SUMS), 'utf8'));
  if (pins.length === 0) throw new Error(`${SUMS} is empty: the pin verifies nothing`);
  const files = new Set(filesUnder(dir));
  const pinned = new Set(pins.map((p) => p.file));
  return {
    pinned: pins.length,
    files: files.size,
    mismatched: pins.filter((p) => files.has(p.file) && sha256(path.join(dir, p.file)) !== p.hash).map((p) => p.file),
    unpinned: [...files].filter((f) => !pinned.has(f)).sort(),
    missing: pins.filter((p) => !files.has(p.file)).map((p) => p.file),
  };
}

describe('adapter-history fixtures — SHA256SUMS integrity (runs in npm test, not only in a chapter gate)', () => {
  it('every pinned line matches its file, and the pinned set EQUALS the directory', () => {
    const r = verify(DIR);
    expect(r.mismatched, 'a fixture changed without a re-stamp: re-run `shasum -a 256` for it and commit the line').toEqual([]);
    expect(r.unpinned, 'a fixture file is not pinned in SHA256SUMS').toEqual([]);
    expect(r.missing, 'SHA256SUMS pins a file that no longer exists').toEqual([]);
    expect(r.pinned).toBe(r.files);
    expect(r.pinned).toBeGreaterThan(0);
  });
});

describe('the integrity check can fail (self-test on a corpus this test builds)', () => {
  const made: string[] = [];
  afterAll(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

  function corpus(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-integrity-'));
    made.push(d);
    fs.mkdirSync(path.join(d, 'tools'));
    fs.writeFileSync(path.join(d, 'A.json'), '{"a":1}\n');
    fs.writeFileSync(path.join(d, 'tools/t.js'), 'module.exports = 1;\n');
    const line = (f: string) => `${sha256(path.join(d, f))}  ${f}\n`;
    fs.writeFileSync(path.join(d, SUMS), line('A.json') + line('tools/t.js'));
    return d;
  }

  it('a clean corpus verifies (the self-test is not vacuous)', () => {
    const r = verify(corpus());
    expect(r).toEqual({ pinned: 2, files: 2, mismatched: [], unpinned: [], missing: [] });
  });

  it('an edit without a re-stamp is reported as mismatched (the ab3b5a82 class)', () => {
    const d = corpus();
    fs.appendFileSync(path.join(d, 'tools/t.js'), '// edited\n');
    expect(verify(d).mismatched).toEqual(['tools/t.js']);
  });

  it('an unpinned file and a pinned-but-deleted file are both reported', () => {
    const d = corpus();
    fs.writeFileSync(path.join(d, 'NEW.json'), '{}\n');
    fs.rmSync(path.join(d, 'A.json'));
    const r = verify(d);
    expect(r.unpinned).toEqual(['NEW.json']);
    expect(r.missing).toEqual(['A.json']);
  });

  it('an empty or malformed SHA256SUMS is refused, never a pass', () => {
    const d = corpus();
    fs.writeFileSync(path.join(d, SUMS), '');
    expect(() => verify(d)).toThrow(/empty/);
    fs.writeFileSync(path.join(d, SUMS), 'not-a-hash  A.json\n');
    expect(() => verify(d)).toThrow(/line 1/);
  });
});
