/**
 * runtime.ts — OPS-HL-CACHE-STAMPEDE-GENERATOR-W1 C3
 *
 * Tiny, DEPENDENCY-FREE process-identity predicate, shared by every module that
 * needs the process-boundary gate (performance-db pool sizing, the cross-asset-grid
 * warmer, the HL caches). Extracted out of performance-db.ts so consumers like
 * `asset-tiers.ts` can import it WITHOUT a module-init cycle (performance-db imports
 * asset-tiers). performance-db re-exports it for back-compat (cross-asset-grid imports
 * `isShortLivedScript` from performance-db). Pure (argv passed in) → unit-testable.
 * Codified by the `module-level-warmer-process-boundary-gate` skill.
 */

/** True when running from a short-lived script (`dist/scripts/*` — a cron / CLI /
 *  one-shot), NOT the long-lived server (`dist/index.js`). */
export function isShortLivedScript(scriptPath: string | undefined): boolean {
  return /[\\/]scripts[\\/]/.test(scriptPath ?? '');
}

/**
 * OPS-UPSTREAM-ACQUISITION-ACCOUNTING-W1 CH1 — the process's ENTRYPOINT NAME: the basename of the
 * script node was started with, extension stripped. `node dist/index.js` → `index` (PID 1);
 * `node dist/scripts/seed-signals.js` → `seed-signals`. Pure (path passed in) and total: an absent
 * or empty path yields `unknown-entrypoint`, never a throw — this feeds the weight-budget recorder on
 * the serving path, where a throw would be worse than a vague name.
 */
export function entrypointName(scriptPath: string | undefined): string {
  const base = (scriptPath ?? '').split(/[\\/]/).pop() ?? '';
  const name = base.replace(/\.(?:c|m)?[jt]s$/, '');
  return name.length > 0 ? name : 'unknown-entrypoint';
}

/** This process's entrypoint name, derived ONCE per process (argv[1] does not change). */
const PROCESS_ENTRYPOINT: string = entrypointName(process.argv[1]);
export function processEntrypoint(): string {
  return PROCESS_ENTRYPOINT;
}
