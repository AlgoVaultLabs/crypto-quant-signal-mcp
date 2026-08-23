/**
 * SIGNAL-AOE-EXPIRY-GATE — `readAoeConfig` has NO importer under `src/`.
 * Folded into OPS-AOE-LIVENESS-W1 CH1 (scope 11).
 *
 * ## What this replaces
 *
 * `src/tools/get-trade-call.ts:148-153` carries a comment warning that the AOE reader
 * "ALREADY implements that path … and it has ZERO consumers today, so `WEIGHTS` is
 * currently code-only … THE DAY IT IS WIRED INTO THE SCORER, weights become runtime-
 * mutable with no deploy and no diff, and this verdict expires WITHOUT ANY CODE CHANGE
 * TO OBSERVE."
 *
 * That is exactly right, and until now it was **prose addressed to whoever happens to
 * read it** — which this project's manual classes as not a control at all. Wiring the
 * reader is ONE import line, and nothing in CI would have noticed. This file is the
 * control; the comment stays as the explanation.
 *
 * ## Why the predicate is the IMPORT GRAPH and not a text grep
 *
 * The obvious check is `grep -rn "aoe-config-reader" src/ | wc -l`, and two dispatches
 * in this arc shipped exactly that as a gate requiring the count to be **0**. Measured
 * on a clean `origin/main`, it reads **2** — both hits are prose comments, at
 * `src/tools/get-trade-call.ts:149` (the very warning above) and
 * `src/lib/performance-db.ts:1176`. One of them lives inside `src/tools/**`, which the
 * same specs forbid editing. So the gate could never print GREEN for anyone, on any
 * tree, ever.
 *
 * A mention is not an import. This scans for the *construct* — an `import … from` or a
 * `require(...)` naming the module — so a comment cannot trip it and a real wiring
 * cannot hide from it. Both directions are self-tested below, so the matcher cannot
 * silently stop matching.
 *
 * ## What a future wave must do instead of deleting this
 *
 * If AOE consumption is ever approved, the wiring wave OWNS this file: it deletes or
 * inverts the assertion **in the same commit** that adds the import, and says so in
 * `status.md`. A green suite must never be reachable with a wired reader and this test
 * still asserting zero.
 *
 * Note the gap this does NOT close, measured 2026-08-23: signal-1 has no
 * `ALGOVAULT_AOE_CONFIG_SOURCE`, no `AOE_REDIS_URL`, no `REDIS_URL` and no Redis at all,
 * and `aoe-redis` is loopback-bound on a different host. An import today would be a
 * permanent no-op. That is `SIGNAL-AOE-REACHABILITY-W{NEXT}`, not this test.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename_ = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename_), '..', '..');
const SRC = join(REPO_ROOT, 'src');
const SKIP_DIR = /(^|[\\/])(node_modules|dist|\.claude)([\\/]|$)/;

/** The module under embargo, matched with or without an extension or path prefix. */
const MODULE = 'aoe-config-reader';

/**
 * An `import`/`export … from` or a dynamic `import()`/`require()` whose specifier names
 * the module. Two alternatives, because the two forms are anchored differently and the
 * self-test below caught the first draft conflating them:
 *
 *   STATIC — a statement, so it is line-anchored. `[^;]` bounds the gap at the statement
 *     terminator, which stops the engine backtracking across a real import into a later
 *     comment that merely names the file (a cross-statement false positive, fixtured below).
 *   DYNAMIC — an expression, so it can appear mid-line (`const m = await import(...)`)
 *     and must NOT be line-anchored. The first draft required a line start for both and
 *     silently missed every dynamic import — the exact way a wiring could have slipped past.
 *
 * A bare mention in prose matches neither, which is the entire point: the substring
 * predicate two dispatches shipped as a gate counts 2 comments and can never read 0.
 */
const SPEC = String.raw`['"\`][^'"\`]*` + MODULE + String.raw`(?:\.[a-z]+)?['"\`]`;
const IMPORT_RE = new RegExp(
  String.raw`(?:^|\n)\s*(?:import|export)\b[^;]{0,200}?from\s*` + SPEC +
    String.raw`|\b(?:import|require)\s*\(\s*` + SPEC,
  'g',
);

function walk(dir: string, acc: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (SKIP_DIR.test(full)) continue;
    if (e.isDirectory()) walk(full, acc);
    else if (e.name.endsWith('.ts') && statSync(full).isFile()) acc.push(full);
  }
  return acc;
}

function importersUnderSrc(): { rel: string; match: string }[] {
  const hits: { rel: string; match: string }[] = [];
  for (const f of walk(SRC)) {
    // The module MUST NOT report itself.
    if (f.endsWith(`${MODULE}.ts`)) continue;
    const src = readFileSync(f, 'utf-8');
    for (const m of src.matchAll(IMPORT_RE)) {
      hits.push({ rel: relative(REPO_ROOT, f), match: m[0].trim().slice(0, 120) });
    }
  }
  return hits;
}

describe('SIGNAL-AOE-EXPIRY-GATE — readAoeConfig stays unwired', () => {
  it('has ZERO import statements under src/', () => {
    const hits = importersUnderSrc();
    expect(
      hits,
      hits.length
        ? `readAoeConfig is now imported under src/ — the AOE weight-promotion path is LIVE and ` +
          `\`WEIGHTS\` is runtime-mutable with no deploy and no diff. If that is intended, the ` +
          `wiring wave owns this test and must update it in the same commit:\n` +
          hits.map((h) => `  ${h.rel}: ${h.match}`).join('\n')
        : '',
    ).toEqual([]);
  });

  it('the module itself is present, so the assertion is not vacuous', () => {
    // A zero that comes from "the file was deleted" says nothing about wiring. This is the
    // corpus guard: the thing we assert nobody imports has to exist to be importable.
    const self = join(SRC, 'lib', `${MODULE}.ts`);
    expect(statSync(self).isFile()).toBe(true);
    expect(readFileSync(self, 'utf-8')).toContain('export async function readAoeConfig');
  });

  it('the ONE legitimate importer — its own test — is real and outside src/', () => {
    // If this ever breaks, the reader has been renamed or the test deleted, and the
    // embargo above would start passing for the wrong reason.
    const t = readFileSync(join(REPO_ROOT, 'tests', 'aoe-config-reader.test.ts'), 'utf-8');
    expect(t).toMatch(IMPORT_RE);
  });

  describe('the matcher, proven in both directions', () => {
    const positives = [
      `import { readAoeConfig } from '../lib/aoe-config-reader.js';`,
      `import {\n  readAoeConfig,\n  type AoeConfig,\n} from '../../lib/aoe-config-reader.js';`,
      `export { readAoeConfig } from './aoe-config-reader.js';`,
      `const m = await import('../lib/aoe-config-reader.js');`,
      `const m = require('./aoe-config-reader');`,
      `import * as aoe from "../lib/aoe-config-reader.js";`,
    ];
    const negatives = [
      `//     \`src/lib/aoe-config-reader.ts\` ALREADY implements that path — Redis`,
      ` * weight promotion (\`src/lib/aoe-config-reader.ts\`), which is runtime-mutable by design`,
      `/** See aoe-config-reader.ts for the contract. */`,
      `const note = 'aoe-config-reader is deliberately unwired';`,
      `import { getTradeCall } from '../tools/get-trade-call.js';`,
      // Cross-statement backtracking: a REAL import followed by a comment naming the
      // embargoed file. `[^;]` in the static branch is what stops this reading as a hit.
      `import { getTradeCall } from '../tools/get-trade-call.js';\n// see ../lib/aoe-config-reader.ts`,
    ];

    it.each(positives)('MATCHES a real import: %s', (s) => {
      expect(new RegExp(IMPORT_RE.source, 'g').test(s)).toBe(true);
    });

    it.each(negatives)('IGNORES a mere mention: %s', (s) => {
      expect(new RegExp(IMPORT_RE.source, 'g').test(s)).toBe(false);
    });

    it('the two REAL comments in src/ today are ignored, and a text grep would not be', () => {
      // The exact bytes that made the substring gate unreachable. Kept as a fixture so the
      // distinction between "mention" and "import" is asserted on live content, not a mock.
      const real = [
        readFileSync(join(SRC, 'tools', 'get-trade-call.ts'), 'utf-8'),
        readFileSync(join(SRC, 'lib', 'performance-db.ts'), 'utf-8'),
      ];
      let mentions = 0;
      for (const src of real) {
        mentions += (src.match(new RegExp(MODULE, 'g')) || []).length;
        expect(new RegExp(IMPORT_RE.source, 'g').test(src)).toBe(false);
      }
      // If this ever reaches 0, the comments were removed and this fixture is stale — but the
      // embargo above still holds, so it downgrades to a documentation nit, never a false pass.
      expect(mentions).toBeGreaterThan(0);
    });
  });
});
