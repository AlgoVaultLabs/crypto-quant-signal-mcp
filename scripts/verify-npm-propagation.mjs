#!/usr/bin/env node
/**
 * verify-npm-propagation.mjs — OPS-DISTTAG-EVENTUAL-CONSISTENCY-W1 CH2 R4.
 *
 * Run by publish-npm.yml's `Verify dist-tag` step: did the version we just published (or, in
 * `mode: verify-only`, the version package.json says is current) become AVAILABLE on npm?
 *
 * ── WHY A WAIT, AND WHY ONLY ON UNCACHED READS ──────────────────────────────────────────────
 * The step this replaces read the CACHED packument 3× at 20 s intervals and went red on every
 * release from v1.28.0, each time AFTER npm had accepted the upload. Measured: since npm's
 * publish-time malware scanning, a version does not EXIST at registry origin for minutes after
 * `npm publish` returns. Origin `time[v]` landed +249.0 to +307.6 s after the publish returned on
 * all 6 publishing runs from 2026-08-22 to 2026-09-23; it was −0.6 s before that. No endpoint,
 * cached or not, can serve a document that does not exist yet, so the cure is a bounded WAIT.
 * Waiting on a CACHED read is still forbidden: it outlasts a TTL instead of measuring the thing.
 * So every poll goes through scripts/lib/npm-registry-read.mjs, whose two endpoints are measured
 * not to be served from cache (dist-tags unbusted, the version document with a fresh ?cb=).
 *
 * The DEADLINE is NOT defined here. It is publish-npm.yml's `NPM_PROPAGATION_DEADLINE_S`, with its
 * measured basis beside it: one constant, one place. A missing or invalid value REFUSES (exit 1),
 * because a lane whose verification silently fell back to a guess would be the dark-guard class
 * again. Re-tune it from the `NPM_PROPAGATION_SECONDS` series this script emits, never from taste.
 *
 * ── CLASSIFICATION — transport fails OPEN, content fails CLOSED ─────────────────────────────
 *   version doc 200 AND dist-tags.latest == v, within the deadline → both PASS                 exit 0
 *   version doc 200, dist-tags still mismatched at the deadline     → PUBLISHED=PASS · DIST_TAG=FAIL  exit 1
 *   version doc still 404 at the deadline                          → PUBLISHED=FAIL + REASON line   exit 1
 *   an endpoint NEVER definitively read in the whole window (unreachable / non-200-non-404 /
 *   unparseable on every poll)                                      → that one INDETERMINATE,
 *                                                                    exit 0 with ::warning::
 * The verdict is taken from the LAST DEFINITIVE read of each endpoint, never from the last read
 * alone. One network blip on the final poll must not turn 80 definitive "still 404" reads of a
 * version held for review into an INDETERMINATE exit 0 (adversarial review, CH2). Absence is the
 * fail-closed direction, and a full match ends the wait on the very poll that observed it, so a
 * stale definitive read can only ever hold a verdict at FAIL, never promote one to PASS.
 * A version npm accepted but still will not serve at the deadline is FAIL, because npm can hold a
 * version for review or block it, and that must never read as a clean release. Its message says
 * the upload was ACCEPTED, not refused. It points at a NEW `mode: verify-only` dispatch instead of
 * re-publishing: a GitHub Re-run replays the original tag push and would attempt the upload again.
 * No line this script prints ever says "the publish failed".
 *
 * ── TOKENS — one meaning each, each on its own line ─────────────────────────────────────────
 *   NPM_PROPAGATION_DEADLINE_S=<n>       the deadline in force (echoed, so the run log carries it)
 *   NPM_PUBLISH_OUTCOME=<success|skipped|…>   what the publish step did (verify-only → skipped)
 *   NPM_PROPAGATION_SECONDS=<n> | NOT_OBSERVED_WITHIN_<n>S   step start → first full match
 *   NPM_VERSION_REASON=<REASON>          only when there is one; never folded into a verdict
 *   NPM_VERSION_PUBLISHED=PASS|FAIL|INDETERMINATE
 *   DIST_TAG_VERDICT=PASS|FAIL|INDETERMINATE
 * The process ends via process.exitCode, never process.exit(), so the tokens survive a pipe
 * (tests/unit/verdict-exit-path.test.ts).
 */
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDistTags, readVersionDoc } from './lib/npm-registry-read.mjs';

export const POLL_INTERVAL_S = 15;

/** How to re-verify. A Re-run replays the tag push (inputs are empty, so it would upload again). */
export const REVERIFY =
  'start a NEW dispatch with mode: verify-only (gh workflow run publish-npm.yml --ref main -f mode=verify-only) once npm serves it; the Re-run button replays the tag push and would attempt the upload again';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Parse the deadline env. Returns a positive integer number of seconds, or null (refuse). */
export function parseDeadline(raw) {
  if (typeof raw !== 'string' || !/^[1-9]\d{0,5}$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

const isDefinitive = (r) => r && r.ok === true;

/**
 * Classify the LAST read of each endpoint at the end of the wait. Pure; exported for the tests.
 * @param {{version: object|null, distTags: object|null, v: string}} last
 */
export function classify({ version, distTags, v }) {
  let published;
  if (!isDefinitive(version)) published = 'INDETERMINATE';
  else published = version.found ? 'PASS' : 'FAIL';
  let distTag;
  if (!isDefinitive(distTags)) distTag = 'INDETERMINATE';
  else distTag = distTags.latest === v ? 'PASS' : 'FAIL';
  return { published, distTag };
}

/**
 * The poll loop. Every dependency is injected so the tests can drive real time-shaped scenarios
 * (404-then-200, a version held past the deadline, an unreachable registry) in milliseconds.
 */
export async function runVerification({
  pkg,
  version: v,
  deadlineS,
  publishOutcome = '',
  intervalS = POLL_INTERVAL_S,
  readers = { readDistTags, readVersionDoc },
  readerOpts = {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  log = () => {},
}) {
  const lines = [];
  // Streamed as they happen (the CLI passes console.log): a 20-minute wait must not be silent.
  const say = (s) => {
    lines.push(s);
    log(s);
  };
  const t0 = now();
  const elapsedS = () => Math.round((now() - t0) / 1000);
  let lastVersion = null;
  let lastDist = null;
  // The last DEFINITIVE read of each endpoint, and when it happened: what the verdict is taken from.
  let defVersion = null;
  let defVersionAt = null;
  let defDist = null;
  let defDistAt = null;
  let observedAt = null;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    lastVersion = await readers.readVersionDoc(pkg, v, readerOpts);
    lastDist = await readers.readDistTags(pkg, readerOpts);
    if (isDefinitive(lastVersion)) [defVersion, defVersionAt] = [lastVersion, elapsedS()];
    if (isDefinitive(lastDist)) [defDist, defDistAt] = [lastDist, elapsedS()];
    const vs = isDefinitive(lastVersion) ? (lastVersion.found ? `200 found (cf-cache-status ${lastVersion.cacheStatus ?? 'absent'})` : '404 not yet') : `unreadable: ${lastVersion.reason}`;
    const ds = isDefinitive(lastDist) ? `latest=${lastDist.latest} (cf-cache-status ${lastDist.cacheStatus ?? 'absent'})` : `unreadable: ${lastDist.reason}`;
    say(`poll ${attempt} at +${elapsedS()}s: version doc ${vs} · dist-tags ${ds}`);
    if (isDefinitive(lastVersion) && lastVersion.found && isDefinitive(lastDist) && lastDist.latest === v) {
      observedAt = elapsedS();
      break;
    }
    if (elapsedS() + intervalS > deadlineS) break;
    await sleep(intervalS * 1000);
  }

  const { published, distTag } = classify({ version: defVersion, distTags: defDist, v });
  if (defVersion && !isDefinitive(lastVersion)) say(`the final version-doc read was unreadable (${lastVersion?.reason}); the verdict uses the last definitive read, at +${defVersionAt}s`);
  if (defDist && !isDefinitive(lastDist)) say(`the final dist-tags read was unreadable (${lastDist?.reason}); the verdict uses the last definitive read, at +${defDistAt}s`);
  const accepted = publishOutcome === 'success';
  const who = `${pkg}@${v}`;

  if (published === 'FAIL') {
    say(
      accepted
        ? `::error::npm ACCEPTED the upload of ${who} (the publish step's outcome is success), not refused — but the registry still does not serve it after ${deadlineS} s. npm can hold a new version for malware review, or block it. Do NOT re-publish: ${REVERIFY}.`
        : `::error::the registry does not serve ${who} after ${deadlineS} s. No upload ran in this run (publish step outcome: ${publishOutcome || 'n/a'}). If this version was published earlier, npm may still be holding it for review; ${REVERIFY}.`,
    );
  }
  if (published === 'INDETERMINATE') {
    say(`::warning::could not read the version document for ${who} on any poll (${lastVersion?.reason ?? 'no read'}). This is NOT evidence about the publish either way; ${REVERIFY}.`);
  }
  if (distTag === 'FAIL') {
    say(`::error::${who} ${published === 'PASS' ? 'is served' : 'is not served yet'}, and dist-tags.latest is ${defDist.latest}, not ${v}, after ${deadlineS} s.${accepted ? ' The upload was ACCEPTED, not refused.' : ''} Once npm has moved the tag, ${REVERIFY}.`);
  }
  if (distTag === 'INDETERMINATE') {
    say(`::warning::could not read dist-tags for ${pkg} on any poll (${lastDist?.reason ?? 'no read'}). This is NOT evidence about the publish either way.`);
  }
  if (published === 'PASS' && distTag === 'PASS') say(`${who} is served and dist-tags.latest matches — available ${observedAt} s after this step started`);

  say(`NPM_PROPAGATION_DEADLINE_S=${deadlineS}`);
  say(`NPM_PUBLISH_OUTCOME=${publishOutcome || 'n/a'}`);
  say(`NPM_PROPAGATION_SECONDS=${observedAt === null ? `NOT_OBSERVED_WITHIN_${deadlineS}S` : observedAt}`);
  if (published === 'FAIL') say(`NPM_VERSION_REASON=NOT_AVAILABLE_AFTER_${deadlineS}S`);
  say(`NPM_VERSION_PUBLISHED=${published}`);
  say(`DIST_TAG_VERDICT=${distTag}`);

  const exitCode = published === 'FAIL' || distTag === 'FAIL' ? 1 : 0;
  return { lines, exitCode, published, distTag, observedAt };
}

async function main() {
  const deadlineS = parseDeadline(process.env.NPM_PROPAGATION_DEADLINE_S);
  let pkgJson = null;
  try {
    pkgJson = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  } catch { /* refused below */ }
  if (deadlineS === null || !pkgJson?.name || !pkgJson?.version) {
    console.log(`::error::refusing to verify: ${deadlineS === null ? `NPM_PROPAGATION_DEADLINE_S is missing or not a positive integer (${JSON.stringify(process.env.NPM_PROPAGATION_DEADLINE_S ?? null)}) — it is declared in publish-npm.yml beside its measured basis` : 'package.json has no name/version'}. This is a lane configuration defect, not a registry state.`);
    console.log('NPM_VERSION_REASON=CONFIG_INVALID');
    console.log('NPM_VERSION_PUBLISHED=INDETERMINATE');
    console.log('DIST_TAG_VERDICT=INDETERMINATE');
    process.exitCode = 1; // a verification that cannot be configured must not fail open
    return;
  }
  const r = await runVerification({
    pkg: pkgJson.name,
    version: pkgJson.version,
    deadlineS,
    publishOutcome: process.env.NPM_PUBLISH_OUTCOME ?? '',
    log: (s) => console.log(s),
  });
  process.exitCode = r.exitCode;
}

/**
 * Entry guard by REALPATH. A plain `import.meta.url === pathToFileURL(argv[1])` is false whenever the
 * script is reached through a symlink (macOS /var → /private/var, a symlinked checkout), and then
 * main() never runs: the lane step exits 0 having printed NO token, a dark verification. Measured on
 * this script's own CLI test before it shipped.
 */
function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main();
}
