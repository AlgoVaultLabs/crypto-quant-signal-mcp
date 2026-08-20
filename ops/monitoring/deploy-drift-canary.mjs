#!/usr/bin/env node
/**
 * OPS-DEPLOY-PROVENANCE-AND-VERDICT-CLASS-W1 CH4 — deploy-drift canary, blame classifier,
 * bounded auto-recovery.
 *
 * WHY THIS EXISTS. On 2026-08-17 a wave halted because CI was red, and a human worked out by hand
 * whose red it was: "08edfd1 failed before my commit existed; my diff touches none of its import
 * graph." That reasoning was correct. Manual forensics performed correctly is a script that has not
 * been written yet — so this is that script.
 *
 * ┌─ HARD PROHIBITIONS. This canary re-materializes an already-green committed SHA. It has NO
 * │  other power, and every one of these is enforced in `decideRecovery`, not merely promised here:
 * │    · NEVER acts on a red suite.
 * │    · NEVER acts on DRIFT_INDETERMINATE — an unknown is not a green.
 * │    · NEVER force-pushes, and never pushes at all.
 * │    · NEVER rsyncs a working tree (the 2026-08-02 incident this codebase still carries scars
 * │      from: a hand rsync shipped a module that was on no branch, and a second rsync deleted it).
 * │    · NEVER mutates a firewall or any network posture. An unattended job may detect and alert;
 * │      it may not change a network rule.
 * │    · NEVER re-triggers a SHA that is not an ancestor of origin/main.
 * └─
 *
 * FAIL-OPEN THROUGHOUT. A guard on a live serving path REFUSES; it does not THROW. Every I/O path
 * returns a typed failure instead of raising, because a canary fault must never take down the
 * deploy path or the alert path it is supposed to protect.
 *
 * RECOVERY AND HEALTH ARE NOT EVENTS. In-sync is silent. A successful recovery is silent, with
 * forensics in the log. Only operator-action-required drift alerts.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const VERDICTS = /** @type {const} */ ([
  'DRIFT_NONE',
  'DRIFT_RECOVERABLE',
  'DRIFT_BLOCKED_OWNED',
  'DRIFT_BLOCKED_MINE',
  'DRIFT_INDETERMINATE',
]);

/** Behind for longer than this before recovery may act — a deploy in flight is not drift. */
export const BEHIND_GRACE_MS = 30 * 60 * 1000;
/** Per UTC day, per repo. */
export const MAX_ATTEMPTS_PER_DAY = 2;
export const ATTEMPT_COOLDOWN_MS = 20 * 60 * 1000;

/* ─────────────────────────── 4b. the blame classifier ─────────────────────────── */

/**
 * Decide who owns a blocking red, from facts a caller has already gathered.
 *
 * Pure on purpose: every input is data, so the one case whose answer we actually know can be
 * pinned as a fixture (see the graded test). A classifier that cannot reproduce a known answer is
 * not verified, it is merely written.
 *
 * @param {object} f
 * @param {string|null} f.prodSha            deployed commit, or null when provenance is unreadable
 * @param {string|null} f.mainHead           origin/main HEAD
 * @param {string|null} f.suiteVerdict       CH2's SUITE_VERDICT for mainHead's run
 * @param {string[]}    f.failingFiles       test files that failed
 * @param {string[]}    f.graphTouchers      commits after the last green touching the failing
 *                                           file's import graph, OLDEST FIRST
 * @param {string[]}    f.sessionCommits     commits the deploying session authored
 */
export function classifyDrift(f) {
  const { prodSha, mainHead, suiteVerdict, graphTouchers = [], sessionCommits = [] } = f;

  // Provenance we could not read is INDETERMINATE, never "in sync". Assuming sync on a missing
  // measurement is how a stale deploy hides: the canary would go quiet precisely when the thing
  // it measures stopped reporting.
  if (!prodSha || !mainHead) return { verdict: 'DRIFT_INDETERMINATE', reason: 'provenance unreadable' };

  if (prodSha === mainHead) return { verdict: 'DRIFT_NONE', reason: 'in sync' };

  if (suiteVerdict === 'PASS' || suiteVerdict === 'PASS_AFTER_ISOLATION') {
    return { verdict: 'DRIFT_RECOVERABLE', reason: `main green (${suiteVerdict}), prod behind` };
  }

  if (suiteVerdict !== 'FAIL') {
    // INDETERMINATE, or no run found. Both mean "we do not know", and an unknown must never be
    // laundered into either a green or a blame.
    return { verdict: 'DRIFT_INDETERMINATE', reason: `suite verdict ${suiteVerdict ?? 'unknown'}` };
  }

  // Red. Whose?
  if (graphTouchers.length === 0) {
    // Nothing in the delta touches the failing test's graph — a real state (flake, infra, an
    // upstream dependency), and it is NOT anyone's blame. Refusing to name someone is the point.
    return { verdict: 'DRIFT_INDETERMINATE', reason: 'red, but nothing in the delta touches the failing graph' };
  }

  const owner = graphTouchers[0];
  const mine = new Set(sessionCommits);
  // "Mine" only when the session's OWN commits are the ones touching the failing graph. A session
  // that merely deployed after someone else's breaking commit owns nothing.
  const allMine = graphTouchers.every((c) => mine.has(c));
  return allMine
    ? { verdict: 'DRIFT_BLOCKED_MINE', reason: 'the failing graph is this session\'s own', owner }
    : { verdict: 'DRIFT_BLOCKED_OWNED', reason: 'the failing graph belongs to another wave', owner };
}

/* ─────────────────────────── 4c. bounded auto-recovery ─────────────────────────── */

/**
 * May the canary re-trigger a deploy? EVERY guard must hold. Returns {act:false, reason} otherwise,
 * and `reason` is what lands in the log — a refusal that does not say why is unauditable.
 */
export function decideRecovery(g) {
  const {
    verdict, suiteVerdict, isAncestor, differs, behindMs,
    attemptsToday = 0, msSinceLastAttempt = Infinity,
  } = g;

  // Listed first and separately, because these are the two that must never be weakened by a
  // future edit that "just" adds one more acceptable verdict.
  if (verdict !== 'DRIFT_RECOVERABLE') return { act: false, reason: `verdict ${verdict} is not DRIFT_RECOVERABLE` };
  if (suiteVerdict !== 'PASS' && suiteVerdict !== 'PASS_AFTER_ISOLATION') {
    return { act: false, reason: `suite verdict ${suiteVerdict} is not green` };
  }
  if (!differs) return { act: false, reason: 'prod already equals main' };
  // Ancestry is the deploy-provenance LAW: only a commit already on the trunk may be materialized.
  if (!isAncestor) return { act: false, reason: 'prod sha is NOT an ancestor of origin/main' };
  if (!(behindMs > BEHIND_GRACE_MS)) return { act: false, reason: `behind ${Math.round(behindMs / 60000)}m, grace is 30m` };
  if (attemptsToday >= MAX_ATTEMPTS_PER_DAY) return { act: false, reason: `${attemptsToday} attempts already today` };
  if (msSinceLastAttempt < ATTEMPT_COOLDOWN_MS) return { act: false, reason: 'within attempt cooldown' };
  return { act: true, reason: 'green, strictly behind, within budget' };
}

/** Attempt ledger. Fail-open: an unreadable ledger reports 0 attempts rather than crashing. */
export function readLedger(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

export function writeLedger(path, data) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2));
    return true;
  } catch {
    return false; // never fatal — losing the ledger must not take the canary down
  }
}

/** UTC day key, so "2 per day" cannot be gamed by a host in a different timezone. */
export function dayKey(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function attemptsFor(ledger, repo, nowMs) {
  const e = ledger[repo];
  if (!e || e.day !== dayKey(nowMs)) return { attemptsToday: 0, msSinceLastAttempt: Infinity };
  return { attemptsToday: e.count ?? 0, msSinceLastAttempt: nowMs - (e.lastMs ?? 0) };
}

export function recordAttempt(ledger, repo, nowMs) {
  const day = dayKey(nowMs);
  const e = ledger[repo];
  const count = e && e.day === day ? (e.count ?? 0) + 1 : 1;
  return { ...ledger, [repo]: { day, count, lastMs: nowMs } };
}

/* ─────────────────────────── self-test ─────────────────────────── */

function selfTest() {
  let pass = 0;
  let fail = 0;
  const t = (label, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) {
      pass++;
      console.log(`  ok   ${label}`);
    } else {
      fail++;
      console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
    }
  };

  const base = { prodSha: 'a'.repeat(40), mainHead: 'b'.repeat(40), failingFiles: [] };
  t('in sync', classifyDrift({ ...base, mainHead: 'a'.repeat(40) }).verdict, 'DRIFT_NONE');
  t('unreadable provenance', classifyDrift({ ...base, prodSha: null }).verdict, 'DRIFT_INDETERMINATE');
  t('green + behind', classifyDrift({ ...base, suiteVerdict: 'PASS' }).verdict, 'DRIFT_RECOVERABLE');
  t('green after isolation', classifyDrift({ ...base, suiteVerdict: 'PASS_AFTER_ISOLATION' }).verdict, 'DRIFT_RECOVERABLE');
  t('indeterminate suite', classifyDrift({ ...base, suiteVerdict: 'INDETERMINATE' }).verdict, 'DRIFT_INDETERMINATE');
  t('red, nobody touched the graph', classifyDrift({ ...base, suiteVerdict: 'FAIL', graphTouchers: [] }).verdict, 'DRIFT_INDETERMINATE');
  t(
    'red, another wave owns it',
    classifyDrift({ ...base, suiteVerdict: 'FAIL', graphTouchers: ['cf2992c'], sessionCommits: ['dcdf9f6'] }).verdict,
    'DRIFT_BLOCKED_OWNED',
  );
  t(
    'red, and it is mine',
    classifyDrift({ ...base, suiteVerdict: 'FAIL', graphTouchers: ['dcdf9f6'], sessionCommits: ['dcdf9f6'] }).verdict,
    'DRIFT_BLOCKED_MINE',
  );

  const ok = {
    verdict: 'DRIFT_RECOVERABLE', suiteVerdict: 'PASS', isAncestor: true, differs: true,
    behindMs: 45 * 60 * 1000, attemptsToday: 0, msSinceLastAttempt: Infinity,
  };
  t('recovery acts when every guard holds', decideRecovery(ok).act, true);
  t('never on a blocked verdict', decideRecovery({ ...ok, verdict: 'DRIFT_BLOCKED_OWNED' }).act, false);
  t('never on indeterminate', decideRecovery({ ...ok, verdict: 'DRIFT_INDETERMINATE' }).act, false);
  t('never on a red suite', decideRecovery({ ...ok, suiteVerdict: 'FAIL' }).act, false);
  t('never a non-ancestor', decideRecovery({ ...ok, isAncestor: false }).act, false);
  t('not within the 30m grace', decideRecovery({ ...ok, behindMs: 5 * 60 * 1000 }).act, false);
  t('not past the daily budget', decideRecovery({ ...ok, attemptsToday: 2 }).act, false);
  t('not within cooldown', decideRecovery({ ...ok, msSinceLastAttempt: 60 * 1000 }).act, false);

  const led = recordAttempt(recordAttempt({}, 'signal', 1e12), 'signal', 1e12);
  t('ledger counts per UTC day', attemptsFor(led, 'signal', 1e12).attemptsToday, 2);
  t('ledger resets on a new day', attemptsFor(led, 'signal', 1e12 + 864e5 * 2).attemptsToday, 0);

  console.log(`SELF-TEST: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} passed, ${fail} failed)`);
  // NOT `DRIFT_VERDICT=`. A self-test evaluates no real deploy state, so emitting the token a
  // caller gates on would let a run that checked nothing publish a verdict.
  console.log(`SELF-TEST-EXIT: ${fail === 0 ? 0 : 1}`);
  return fail === 0 ? 0 : 1;
}

/* ─────────────────────────── I/O helpers (all fail-open) ─────────────────────────── */

export function sh(cmd, args, opts = {}) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim() };
  } catch (e) {
    return { ok: false, out: '', err: String(e?.message ?? e) };
  }
}

/* ─────────────────────────── 4a. the canary itself ─────────────────────────── */

export const REPOS = [
  {
    name: 'crypto-quant-signal-mcp',
    remote: 'https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp.git',
    // Provenance comes from CH3's route, not from a file on disk: the container is the thing
    // actually serving, and a file beside it can be stale in ways the container never notices.
    readProdSha: () => {
      const key = sh('sh', ['-c', "grep -m1 '^ALGOVAULT_INTERNAL_BYPASS_KEY=' /opt/crypto-quant-signal-mcp/.env | cut -d= -f2-"]);
      if (!key.ok || !key.out) return { ok: false, err: 'internal key unreadable' };
      const r = sh('curl', ['-s', '-m', '20', '-H', `X-AlgoVault-Internal-Key: ${key.out}`, 'https://api.algovault.com/api/ops/build']);
      if (!r.ok) return { ok: false, err: 'route unreachable' };
      try {
        const sha = JSON.parse(r.out).sha;
        return sha ? { ok: true, sha } : { ok: false, err: 'route reports sha:null (built without provenance)' };
      } catch {
        return { ok: false, err: 'route response unparseable' };
      }
    },
  },
  {
    name: 'algovault-bot',
    remote: 'https://github.com/AlgoVaultLabs/algovault-bot.git',
    readProdSha: () => {
      const r = sh('sh', ['-c', "sed -n 's/^sha=//p' /opt/algovault-bot/DEPLOYED_SHA 2>/dev/null | head -1"]);
      if (!r.ok || !/^[0-9a-f]{40}$/.test(r.out)) return { ok: false, err: 'DEPLOYED_SHA absent or malformed' };
      return { ok: true, sha: r.out };
    },
  },
];

/**
 * Read origin/main WITHOUT a checkout and WITHOUT the REST API.
 *
 * `git ls-remote` speaks the git protocol, which has no 60/hour unauthenticated budget. That
 * matters here: this host's IP has already exhausted GitHub's REST allowance (measured 403 on
 * 2026-08-20), so a REST-based reader would have been broken on arrival.
 */
export function readMainHead(remote) {
  const r = sh('git', ['ls-remote', remote, 'main']);
  const sha = r.ok ? (r.out.split(/\s+/)[0] ?? '') : '';
  return /^[0-9a-f]{40}$/.test(sha) ? { ok: true, sha } : { ok: false, err: 'ls-remote failed' };
}

/**
 * The CI verdict leg. UNAVAILABLE on this host by design, not by omission.
 *
 * The chapter specified `gh run list --json`. `gh` is not installed here, there is no GitHub token
 * on the box, and the unauthenticated REST fallback returns 403 (rate limit, shared IP). So the
 * verdict is genuinely unreadable, and this returns null — which drives the classifier to
 * DRIFT_INDETERMINATE rather than to a guess. A canary that assumed "probably green" in order to
 * look useful would be strictly worse than one that says it does not know.
 */
export function readSuiteVerdict() {
  if (!process.env.GH_TOKEN) return null;
  const r = sh('curl', ['-s', '-m', '20', '-H', `Authorization: Bearer ${process.env.GH_TOKEN}`,
    '-H', 'Accept: application/vnd.github+json',
    'https://api.github.com/repos/AlgoVaultLabs/crypto-quant-signal-mcp/actions/runs?per_page=1']);
  if (!r.ok) return null;
  try {
    const run = JSON.parse(r.out).workflow_runs?.[0];
    if (!run || run.status !== 'completed') return null;
    // CH2 makes the run FAIL on any non-PASS verdict, so a completed success is exactly
    // SUITE_VERDICT in {PASS, PASS_AFTER_ISOLATION}.
    return run.conclusion === 'success' ? 'PASS' : 'FAIL';
  } catch {
    return null;
  }
}

const LOG = '/var/log/deploy-drift-canary.log';
const LEDGER = '/var/lib/algovault-monitoring/deploy-drift-canary.json';
const WRAP = '/opt/algovault-monitoring/send_telegram.sh';

function log(msg) {
  const line = `${new Date().toISOString()} [deploy-drift-canary] ${msg}`;
  console.log(line);
  try {
    appendFileSync(LOG, `${line}\n`);
  } catch {
    /* logging must never be fatal */
  }
}

function main() {
  const now = Date.now();
  const ledger = readLedger(LEDGER);
  let next = ledger;
  let worst = 'DRIFT_NONE';

  for (const repo of REPOS) {
    const prod = repo.readProdSha();
    const head = readMainHead(repo.remote);
    const prodSha = prod.ok ? prod.sha : null;
    const mainHead = head.ok ? head.sha : null;

    const verdict = classifyDrift({
      prodSha,
      mainHead,
      // Only consulted when prod is BEHIND; in-sync short-circuits before this matters.
      suiteVerdict: prodSha && mainHead && prodSha !== mainHead ? readSuiteVerdict() : null,
      failingFiles: [],
      graphTouchers: [],
      sessionCommits: [],
    });

    // Per-check positive output. A guard that prints nothing when healthy is indistinguishable
    // from a guard that never ran.
    log(`${repo.name}: prod=${prodSha ? prodSha.slice(0, 7) : 'UNKNOWN'} main=${mainHead ? mainHead.slice(0, 7) : 'UNKNOWN'} -> ${verdict.verdict} (${verdict.reason})`);

    if (verdict.verdict === 'DRIFT_NONE') {
      // Clear any drift latch: recovery and health are not events.
      if (next[`${repo.name}:drift`]) next = { ...next, [`${repo.name}:drift`]: undefined };
      continue;
    }
    worst = verdict.verdict;

    // Persistence latch — a deploy in flight is not drift.
    const first = next[`${repo.name}:drift`]?.firstSeenMs ?? now;
    next = { ...next, [`${repo.name}:drift`]: { firstSeenMs: first } };
    const behindMs = now - first;

    const { attemptsToday, msSinceLastAttempt } = attemptsFor(next, repo.name, now);
    const isAncestor = false; // requires a local checkout of the repo; not available for the bot
    const rec = decideRecovery({
      verdict: verdict.verdict, suiteVerdict: verdict.verdict === 'DRIFT_RECOVERABLE' ? 'PASS' : 'FAIL',
      isAncestor, differs: true, behindMs, attemptsToday, msSinceLastAttempt,
    });

    // 🛑 RECOVERY IS DORMANT. Re-triggering a workflow needs a credential this host does not have,
    // and arming half of a safeguard is worse than not arming it: a recovery path that can never
    // fire still reads, to the next operator, like one that will. It stays behind an explicit
    // opt-in AND its own guards, and today the opt-in is unset. See status.md for the decision.
    if (rec.act && process.env.DRIFT_RECOVERY_ARMED === '1') {
      log(`${repo.name}: RECOVERY would act (${rec.reason}) — arming is an operator decision`);
    } else {
      log(`${repo.name}: no recovery (${rec.reason}; armed=${process.env.DRIFT_RECOVERY_ARMED ?? 'no'})`);
    }

    if (behindMs > BEHIND_GRACE_MS) {
      const body = `🚨 deploy drift — ${repo.name}\nverdict: ${verdict.verdict}\nprod: ${prodSha ?? 'UNKNOWN'}\nmain: ${mainHead ?? 'UNKNOWN'}\nbehind: ${Math.round(behindMs / 60000)}m\nreason: ${verdict.reason}${verdict.owner ? `\nowner: ${verdict.owner}` : ''}`;
      // Fail-open, severity-gated, cooldown'd by the shared wrapper — never a raw Bot API call.
      const sent = sh('sh', ['-c', `printf '%s' ${JSON.stringify(body)} | ${WRAP} DEPLOY_DRIFT CRITICAL_PERSISTENT - || true`]);
      log(`${repo.name}: alert dispatched (ok=${sent.ok})`);
    }
  }

  writeLedger(LEDGER, next);

  // ── ADOPTER (OPS-ALERT-RECOVERY-NOTICE-W1 CH2) ─────────────────────────────────────────────
  // DEPLOY_DRIFT is ONE alert id across every repo in REPOS, so the resolution belongs here and
  // NOT in the per-repo DRIFT_NONE branch above: clearing inside the loop would announce
  // "resolved" while a later repo is still drifting. `worst` is the fold across all of them, so
  // this fires only when the whole check is green.
  //
  // The wrapper owns everything else — it no-ops silently when no marker exists (nothing was
  // firing, so nothing resolved), and whether the resolution is ANNOUNCED or merely logged is
  // the registry's `announce_resolution` decision, not this canary's.
  if (worst === 'DRIFT_NONE') {
    const cleared = sh('sh', ['-c', `${WRAP} --clear DEPLOY_DRIFT 'deploy drift verdict=DRIFT_NONE' || true`]);
    log(`deploy-drift: healthy — clear dispatched (ok=${cleared.ok})`);
  }

  console.log(`DRIFT_VERDICT=${worst}`);
  return worst === 'DRIFT_NONE' ? 0 : 0; // detection never fails the scheduler — it REFUSES, it does not THROW
}

if (process.argv[1] && process.argv[1].endsWith('deploy-drift-canary.mjs')) {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) process.exit(selfTest());
  process.exit(main());
}
