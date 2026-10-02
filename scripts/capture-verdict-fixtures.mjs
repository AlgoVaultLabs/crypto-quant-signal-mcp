#!/usr/bin/env node
/**
 * OPS-SUITE-VERDICT-NESTED-KEY-W1 — regenerate tests/fixtures/verdict-channel/ from REAL runs.
 *
 * The verdict gate's fixtures are CAPTURED, never transcribed: each pair is what the real JSON
 * reporter and the real error-shape reporter wrote for a real failing test. That rule was a
 * recipe in a comment; this script is the recipe, so a schema change regenerates every pair the
 * same way instead of hand-editing one.
 *
 * WHY THE NESTED CASES EXIST. Every fixture before this wave was a TOP-LEVEL test, and that is the
 * one shape on which a rendered-name join happens to work. The corpus could not contain the bug:
 * a timeout inside a `describe` (nearly every test in this repo) missed its sidecar entry and read
 * FAIL, and a `beforeAll` failing inside a `describe` was invisible and read PASS. A gate whose
 * corpus cannot contain a defect cannot detect it — so the nested shapes are captured here, and
 * the classifier's self-test refuses to run on a corpus without them.
 *
 * Usage:  node scripts/capture-verdict-fixtures.mjs        (npm run suite:capture-fixtures)
 *
 * Do NOT run this while a vitest suite is running in the same checkout: the sources are written
 * under tests/ for the duration of the capture (vitest's `include` is anchored there), and are
 * removed again before the script exits.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(REPO, 'tests/fixtures/verdict-channel');
const CAPTURE_REL = 'tests/fixtures/verdict-channel/__capture__';
const CAPTURE = join(REPO, CAPTURE_REL);

const SOURCES = {
  'timeout.test.ts': `import { it } from 'vitest';
it('a test that exceeds its own budget', async () => { await new Promise((r) => setTimeout(r, 5000)); }, 250);
`,
  'assertion.test.ts': `import { it, expect } from 'vitest';
it('a test whose assertion is genuinely wrong', () => { expect(1).toBe(2); });
`,
  'collection-error.test.ts': `import './this-module-does-not-exist.js';
import { it } from 'vitest';
it('is never collected', () => {});
`,
  'nested-timeout.test.ts': `import { describe, it } from 'vitest';
describe('an outer suite', () => {
  describe('an inner suite', () => {
    it('a nested test that exceeds its own budget', async () => { await new Promise((r) => setTimeout(r, 5000)); }, 250);
  });
});
`,
  'nested-assertion.test.ts': `import { describe, it, expect } from 'vitest';
describe('an outer suite', () => {
  describe('an inner suite', () => {
    it('a nested test whose assertion is genuinely wrong', () => { expect(1).toBe(2); });
  });
});
`,
  'nested-hook-failure.test.ts': `import { describe, it, beforeAll, expect } from 'vitest';
describe('an outer suite', () => {
  beforeAll(() => { throw new Error('setup exploded'); });
  it('a test that never gets to run', () => { expect(1).toBe(1); });
});
`,
  'nested-hook-timeout.test.ts': `import { describe, it, beforeAll, expect } from 'vitest';
describe('an outer suite', () => {
  beforeAll(async () => { await new Promise((r) => setTimeout(r, 5000)); }, 250);
  it('a test that never gets to run', () => { expect(1).toBe(1); });
});
`,
  'nested-timeout-beside-hook-failure.test.ts': `import { describe, it, afterAll } from 'vitest';
describe('an outer suite', () => {
  afterAll(() => { throw new Error('teardown exploded'); });
  it('a nested test that exceeds its own budget', async () => { await new Promise((r) => setTimeout(r, 5000)); }, 250);
});
`,
};

// label -> the source files run together for it.
export const FIXTURE_SET = {
  'timeout-only': ['timeout.test.ts'],
  'assertion-only': ['assertion.test.ts'],
  mixed: ['assertion.test.ts', 'timeout.test.ts'],
  'collection-error': ['collection-error.test.ts'],
  'nested-timeout': ['nested-timeout.test.ts'],
  'nested-assertion': ['nested-assertion.test.ts'],
  'nested-hook-failure': ['nested-hook-failure.test.ts'],
  'nested-hook-timeout': ['nested-hook-timeout.test.ts'],
  'nested-timeout-beside-hook-failure': ['nested-timeout-beside-hook-failure.test.ts'],
};

/** Strip the capture machine's checkout path everywhere, so a pair keys identically on any runner. */
export function scrub(raw) {
  const repo = REPO.split('\\').join('/').replace(/\/+$/, '');
  return raw.split(`file://${repo}/`).join('').split(`${repo}/`).join('');
}

function capture(label, files) {
  const tmp = mkdtempSync(join(tmpdir(), `verdict-capture-${label}-`));
  const report = join(tmp, 'report.json');
  const shapes = join(tmp, 'shapes.json');
  try {
    execFileSync(
      'npx',
      [
        'vitest', 'run',
        ...files.map((f) => `${CAPTURE_REL}/${f}`),
        '--reporter=json', `--outputFile=${report}`,
        '--reporter=./scripts/vitest-error-shape-reporter.mjs',
      ],
      { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, VITEST_ERROR_SHAPE_OUT: shapes } },
    );
  } catch {
    // Every capture is a failing run by design; vitest exits non-zero and the artifacts are the point.
  }
  for (const [src, ext] of [[report, 'report'], [shapes, 'shapes']]) {
    const body = scrub(readFileSync(src, 'utf8'));
    JSON.parse(body); // refuse to commit anything the scrub broke
    writeFileSync(join(FIXTURES, `${label}.${ext}.json`), body.endsWith('\n') ? body : `${body}\n`);
  }
  rmSync(tmp, { recursive: true, force: true });
}

function main() {
  mkdirSync(CAPTURE, { recursive: true });
  try {
    for (const [name, body] of Object.entries(SOURCES)) writeFileSync(join(CAPTURE, name), body);
    for (const [label, files] of Object.entries(FIXTURE_SET)) {
      capture(label, files);
      console.log(`captured ${label}`);
    }
  } finally {
    rmSync(CAPTURE, { recursive: true, force: true });
  }
}

if (process.argv[1] && process.argv[1].endsWith('capture-verdict-fixtures.mjs')) main();
