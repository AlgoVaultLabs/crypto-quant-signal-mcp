// sr-backtest/guard.ts — EDGE-SR-LEVEL-BACKTEST-W1: the outcome step's guard.
//
// The outcome step may run only when (1) the registration is on origin/main, (2) every harness file on disk is the
// file the registration pinned, and (3) the candle store is the store the registration pinned. Anything else is a
// refusal with its reason named — never a run on unregistered code or unregistered candles.
//
// The pins are read from the registration AS IT STANDS ON origin/main (`git show origin/main:<path>`), never from
// the working tree: a local edit of the registration cannot move them.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildManifest, manifestFile, manifestText, readPlan, sha256 } from './store.js';

/** Every file whose bytes decide an outcome. The registration must pin each one. */
export const PINNED_FILES: readonly string[] = Object.freeze([
  'src/scripts/sr-probe/level-v0.ts',
  'src/scripts/sr-probe/store.ts',
  'src/scripts/sr-backtest/spec.ts',
  'src/scripts/sr-backtest/zones.ts',
  'src/scripts/sr-backtest/engine.ts',
  'src/scripts/sr-backtest/store.ts',
  'src/scripts/sr-backtest/guard.ts',
  'src/scripts/sr-backtest/run.ts',
  'scripts/sr-backtest/sr_backtest.py',
  'src/scripts/cluster-perm-stats.py',
  'ops/monitoring/population_comparison.py',
]);

export const storePin = (venue: string): string => `store:manifest-${venue}.json`;

export interface GuardInput {
  /** The checkout the harness runs from. */
  repo: string;
  /** Repo-relative path of the registration. */
  registration: string;
  store: string;
  venue: string;
  /** Files that must be pinned (default: PINNED_FILES). */
  pinned?: readonly string[];
  /** False skips `git fetch` (tests with a local origin still fetch; this is for a caller that just fetched). */
  fetch?: boolean;
}

export interface GuardResult {
  ok: boolean;
  /** 'ok', or why the outcome step is refused. */
  reason: string;
  /** The origin/main commit that last touched the registration. */
  registrationCommit: string | null;
  originMain: string | null;
  manifestSha256: string | null;
  harnessSha256: Record<string, string>;
}

const git = (repo: string, args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** `| \`name\` | \`<sha256>\` |` rows of the registration's pinned-artifact table. */
export function pinsOf(registrationText: string): Map<string, string> {
  const pins = new Map<string, string>();
  for (const m of registrationText.matchAll(/^\|\s*`([^`]+)`\s*\|\s*`([0-9a-f]{64})`\s*\|/gm)) pins.set(m[1], m[2]);
  return pins;
}

export function checkOutcomeGuard(input: GuardInput): GuardResult {
  const out: GuardResult = { ok: false, reason: '', registrationCommit: null, originMain: null, manifestSha256: null, harnessSha256: {} };
  const refuse = (reason: string): GuardResult => ({ ...out, ok: false, reason });
  try {
    if (input.fetch !== false) git(input.repo, ['fetch', '-q', 'origin']);
  } catch {
    return refuse('origin could not be fetched, so the registration cannot be shown to be on origin/main');
  }
  let text: string;
  try {
    out.originMain = git(input.repo, ['rev-parse', '--verify', 'origin/main']);
    text = execFileSync('git', ['-C', input.repo, 'show', `origin/main:${input.registration}`], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    out.registrationCommit = git(input.repo, ['log', '-1', '--format=%H', 'origin/main', '--', input.registration]);
  } catch {
    return refuse(`the registration ${input.registration} is not on origin/main`);
  }
  if (!out.registrationCommit) return refuse(`the registration ${input.registration} is not on origin/main`);
  try {
    git(input.repo, ['merge-base', '--is-ancestor', out.registrationCommit, 'origin/main']);
  } catch {
    return refuse(`the registration commit ${out.registrationCommit} is not an ancestor of origin/main`);
  }

  const pins = pinsOf(text);
  for (const rel of input.pinned ?? PINNED_FILES) {
    const want = pins.get(rel);
    if (!want) return refuse(`the registration does not pin ${rel}`);
    const file = path.join(input.repo, rel);
    if (!fs.existsSync(file)) return refuse(`the pinned file ${rel} is absent`);
    const have = sha256(fs.readFileSync(file));
    out.harnessSha256[rel] = have;
    if (have !== want) return refuse(`${rel} is not the registered file (sha256 ${have.slice(0, 12)}… on disk, ${want.slice(0, 12)}… registered)`);
  }

  const wantStore = pins.get(storePin(input.venue));
  if (!wantStore) return refuse(`the registration does not pin ${storePin(input.venue)}`);
  const mf = manifestFile(input.store, input.venue);
  if (!fs.existsSync(mf)) return refuse(`the store manifest ${mf} is absent`);
  const manifest = fs.readFileSync(mf, 'utf8');
  out.manifestSha256 = sha256(manifest);
  if (out.manifestSha256 !== wantStore) return refuse(`the store manifest is not the registered one (sha256 ${out.manifestSha256.slice(0, 12)}… on disk, ${wantStore.slice(0, 12)}… registered)`);
  const plan = readPlan(input.store, input.venue);
  if (!plan) return refuse('the store plan is absent');
  // The manifest must still describe the candles on disk: re-derive it from the series files.
  if (manifestText(buildManifest(input.store, plan)) !== manifest) return refuse('the candle files no longer match the store manifest');
  if ((JSON.parse(manifest) as { failures: unknown[] }).failures.length !== 0) return refuse('the store manifest lists failed series');
  return { ...out, ok: true, reason: 'ok' };
}
