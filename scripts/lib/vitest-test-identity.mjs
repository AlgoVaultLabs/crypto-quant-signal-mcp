/**
 * OPS-SUITE-VERDICT-NESTED-KEY-W1 — the ONE derivation of "which test is this".
 *
 * WHY THIS FILE EXISTS. `classify-suite-verdict.mjs` joins two channels on a test's identity:
 * vitest's JSON report (what failed) and the error-shape sidecar (why it failed). Each side used to
 * build that identity itself, and the two derivations disagreed twice, both times silently:
 *
 *   FILE  `0fed536e` — the reporter wrote `path.relative(REPO, p)` while the classifier stripped a
 *         REPO prefix, so a fixture captured on a laptop missed on the CI runner.
 *   NAME  2026-10-02 — the reporter wrote vitest's `TestCase.fullName`, which joins suites with
 *         " > ", while the JSON report's `fullName` joins `ancestorTitles` with " ". Every test
 *         inside a `describe` missed — which in this repo is nearly every test. Measured on
 *         vitest 3.2.4: `cli-api` `TestCase.fullName` vs the JSON reporter's
 *         `[...ancestorTitles, t.name].join(" ")`.
 *
 * Both times a miss fell through to the string channel, the JSON message for a timeout is the
 * opaque `STACK_TRACE_ERROR`, and the safe default called it a regression. The gate was right
 * about everything except which test it was looking at.
 *
 * So identity is no longer a string either side composes. It is a TITLE PATH — the array of
 * suite names from the module down to the entity, taken from the same `task.suite` chain both
 * vitest renderers walk — and ONE function turns (kind, file, path) into a key. Neither channel
 * joins strings, so there is no separator left to disagree about. As a side effect the key stops
 * being ambiguous: `describe('a b') > it('c')` and `describe('a') > it('b c')` both rendered as
 * "a b c" under the space join, and are now distinct.
 *
 * Leaf module on purpose: the reporter runs inside vitest and the classifier runs after it, and
 * neither should import the other to learn what a test is.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const KIND_TEST = 'test';
export const KIND_SUITE = 'suite';

/**
 * Repo-relative + forward-slashed when the path is inside the repo; otherwise left as given.
 * The ONE path normalisation — the reporter writes it, the classifier reads with it.
 */
export function normFile(p) {
  if (!p) return '<unknown>';
  let s = String(p).split('\\').join('/');
  const repo = REPO.split('\\').join('/').replace(/\/+$/, '');
  if (s.startsWith(`${repo}/`)) s = s.slice(repo.length + 1);
  return s;
}

/** A title path is a non-empty array of strings. Anything else cannot be keyed. */
export function isTitlePath(v) {
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string');
}

/**
 * JSON-reporter `assertionResults[]` record -> title path, or null when the record carries no
 * structure (a hand-built report, or a future vitest that renamed the fields). Null is never
 * guessed around: the caller treats an unkeyable failure as UNJOINED, not as a match.
 */
export function titlePathOfAssertion(a) {
  if (!Array.isArray(a?.ancestorTitles) || typeof a?.title !== 'string') return null;
  if (!a.ancestorTitles.every((x) => typeof x === 'string')) return null;
  return [...a.ancestorTitles, a.title];
}

/**
 * vitest reporter-API entity (TestCase / TestSuite) -> title path: its own name, then each parent
 * suite's, stopping at the module. `parent` is built from `task.suite`, the same chain the JSON
 * reporter walks for `ancestorTitles`, so both channels derive from one source.
 */
export function titlePathOfEntity(entity) {
  const path = [];
  for (let e = entity, depth = 0; e && e.type !== 'module' && depth < 1000; e = e.parent, depth++) {
    path.unshift(typeof e.name === 'string' ? e.name : '');
  }
  return path;
}

/** The join key. Built in exactly one place, from structure, never from a rendered name. */
export function testKey(kind, file, titlePath) {
  return `${normFile(file)}::${kind}::${JSON.stringify(titlePath)}`;
}

/** Prefix shared by every suite-level key of one file — suite failures are looked up per file. */
export function suiteKeyPrefix(file) {
  return `${normFile(file)}::${KIND_SUITE}::`;
}

/** Human-readable rendering for log lines only. Never used as a key. */
export function displayName(titlePath) {
  return isTitlePath(titlePath) ? titlePath.join(' > ') : '<suite>';
}
