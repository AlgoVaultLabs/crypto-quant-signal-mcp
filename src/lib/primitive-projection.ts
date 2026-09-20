/**
 * OPS-EDITORIAL-PRIMITIVE-RESOLUTION-GATE-W1 CH3 — the ONE derivation of `compatible_with`.
 *
 * Every `_algovault.compatible_with` array in this server used to be a hardcoded literal, in five
 * places across `src/tools/`, repeated again in `README.md` and three `docs-src/partials/`. Five
 * places to drift is five places that drifted: the live API handed every caller
 * `["crypto-quant-risk-mcp", "crypto-quant-backtest-mcp"]`, two `0.1.0` "Coming soon" stubs with
 * `bin: null` whose tools are not on `tools/list`, and `/docs` repeated them six times.
 *
 * This module is the only place that decides. `ops/primitive-registry.json` is the corpus, and
 * `scripts/check-primitive-resolution.mjs` is what keeps that corpus honest against npm and the
 * live `tools/list`.
 *
 * ── ALLOW-LIST, NEVER DENY-LIST ─────────────────────────────────────────────────────────────
 * A row is projected only when it is ALL of `kind: npm_package`, `status: live` and
 * `public_nameable: true`. Public API responses are shaped by allow-list (CLAUDE.md § Build
 * rules): a deny-list makes the DEFAULT "publish it", so a row added without thought — a new
 * companion package announced early, a tool renamed — leaks by omission. Under an allow-list the
 * default is silence and a new name has to be argued for.
 *
 * ── `[]` IS THE CORRECT VALUE TODAY, AND IS NOT A BUG TO ROUTE AROUND ───────────────────────
 * Measured 2026-09-19: the projection is EMPTY, because no companion package is live. The three
 * stubs are `status: planned, public_nameable: false`. An empty array is the truthful answer to
 * "what else can consume this object", and `src/types.ts` already types it `string[]`, which
 * admits `[]`. Do not seed a placeholder to make it look populated.
 *
 * ── THE READ IS CACHED, AND ONLY THE DEFAULT PATH IS ────────────────────────────────────────
 * All five call sites build a response envelope on every tool call. A `readFileSync` per request
 * would be a performance regression for a value that changes only when the registry is committed,
 * so the DEFAULT path is memoized.
 *
 * An EXPLICIT path always reads fresh, and that is a correctness property rather than a
 * convenience: a single cache shared across paths returns the first path's answer for every later
 * one, so a caller passing a different registry would silently receive the wrong projection. The
 * first draft of this module had that bug and hid it behind an exported
 * `resetPrimitiveProjectionCache()` test seam — which `dark-artifact-gate.test.ts` then correctly
 * flagged as an export with no non-test consumer. Removing the seam and scoping the cache fixes
 * both: there is nothing to reset, because there is nothing mis-cached.
 *
 * ── A GUARD ON A SERVING PATH REFUSES; IT DOES NOT THROW ────────────────────────────────────
 * An unreadable or malformed registry yields `[]` — the same value as "nothing is nameable" —
 * never an exception that would take down a tool call. That is deliberate and it is safe in ONE
 * direction only: the failure mode is naming too little, never too much. The registry's integrity
 * is asserted where it can be acted on (the CI + pre-commit gate), not in a request handler that
 * has no way to tell a caller the corpus is broken.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** One registry row. Mirrors `ops/primitive-registry.json`'s row schema. */
export interface PrimitiveRow {
  id: string;
  kind: 'npm_package' | 'mcp_tool' | 'http_endpoint';
  name: string;
  invocation: 'cli' | 'library' | 'n_a';
  status: 'live' | 'planned' | 'retired';
  public_nameable: boolean;
  resolves_when?: string;
  owner_wave?: string;
  added?: string;
}

// `__dirname`, not `import.meta.url`: this compiles to CommonJS (tsconfig `module: Node16`), and
// import.meta raises TS1470 there. Same idiom as src/lib/detector-envelope.ts and geo-decide.ts.
// From dist/lib/ that resolves to <repo>/ops/primitive-registry.json — the registry ships in the
// image, alongside dist/, rather than being read from a checkout.
const REGISTRY_PATH = path.resolve(__dirname, '..', '..', 'ops', 'primitive-registry.json');

let cached: string[] | null = null;

/**
 * This package's own name. `compatible_with` answers "what ELSE accepts this object", so the
 * server is excluded from its own companion list.
 *
 * `public_nameable` is NOT the lever for that, and the distinction is load-bearing: this package
 * IS publicly nameable — the install line in every tutorial names it, and CH5's publish-path gate
 * reads the same registry to decide whether a drafted post may say it. Setting the row to
 * `public_nameable: false` to keep it out of this one array would silently forbid the install
 * line. Two different questions, two different predicates, one registry.
 */
const SELF_PACKAGE = 'crypto-quant-signal-mcp';

/** The allow-list predicate, exported so a test can assert it without touching the filesystem. */
export function isPubliclyNameablePackage(row: PrimitiveRow): boolean {
  return row.kind === 'npm_package'
    && row.status === 'live'
    && row.public_nameable === true
    && row.name !== SELF_PACKAGE;
}

/** Project rows → the names a public surface may carry. Pure; sorted for a stable response. */
export function projectCompatibleWith(rows: PrimitiveRow[]): string[] {
  return rows.filter(isPubliclyNameablePackage).map((r) => r.name).sort();
}

/**
 * The names this server may advertise as compatible companions.
 *
 * Returns `[]` rather than throwing when the registry cannot be read — see the header. Callers
 * are per-request envelope builders with nowhere to put an error.
 */
export function compatibleWith(registryPath: string = REGISTRY_PATH): string[] {
  const isDefault = registryPath === REGISTRY_PATH;
  if (isDefault && cached !== null) return cached;
  let names: string[];
  try {
    const doc = JSON.parse(readFileSync(registryPath, 'utf8')) as { primitives?: PrimitiveRow[] };
    names = Array.isArray(doc?.primitives) ? projectCompatibleWith(doc.primitives) : [];
  } catch {
    names = [];
  }
  if (isDefault) cached = names;
  return names;
}
