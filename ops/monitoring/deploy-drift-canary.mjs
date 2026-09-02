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
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export const VERDICTS = /** @type {const} */ ([
  'DRIFT_NONE',
  'DRIFT_NONE_NON_DEPLOYING',
  'DRIFT_RECOVERABLE',
  'DRIFT_BLOCKED_OWNED',
  'DRIFT_BLOCKED_MINE',
  'DRIFT_INDETERMINATE',
]);

/** Verdicts that must NOT page. Folded in main(); the `--clear` adopter runs for all of them. */
export const HEALTHY_VERDICTS = new Set(['DRIFT_NONE', 'DRIFT_NONE_NON_DEPLOYING']);

/* ───────────────── 4a-bis. is this delta even capable of deploying? ─────────────────
 *
 * OPS-DEPLOY-DRIFT-VERDICT-LEG-W1 CH1. `.github/workflows/deploy.yml` carries `paths-ignore`.
 * A push touching ONLY those paths creates NO workflow run at all — so prod can never equal
 * main, and the pre-fix canary paged forever about a condition no deploy would ever resolve.
 *
 * NOT hypothetical: `aad0e26` (ops/monitoring/** only) has ZERO Deploy runs and sat as the tip
 * of main 03:34→04:04 UTC on 2026-08-21 — exactly BEHIND_GRACE_MS. It was rescued by an
 * unrelated commit landing at 04:04, not by anything working.
 *
 * THE AGGREGATE TEST IS SOUND, and the reason is worth stating: GitHub evaluates paths-ignore
 * per PUSH, not per commit. If every file in the aggregate prodSha..mainHead diff is ignored,
 * then every individual push's file set in that range is a SUBSET of it and is also entirely
 * ignored — so no run fired for any of them. A mixed delta means some push carried a
 * non-ignored file, so a run fired, and that is the ordinary path.
 *
 * THIS LEG FAILS TOWARD PAGING, ALWAYS. Every "I do not understand this" returns null, never
 * true. A false `true` SUPPRESSES a real page, which is the one outcome worse than today's
 * uninformative one.
 *
 * It deliberately does NOT own "an ops/monitoring/** change landed but was never installed on
 * the host". That is HASH_DRIFT / ORPHAN and it belongs to monitoring-inventory-reconcile.py.
 * Two guards for one property is how they end up disagreeing.
 */

/**
 * Extract the `paths-ignore:` list from deploy.yml WITHOUT a YAML dependency (this file imports
 * node builtins only, by design — it runs from /opt with no node_modules).
 *
 * Returns null rather than [] on anything it does not recognise: an empty list would read as
 * "nothing is ignored", which silently disables the whole leg while looking healthy.
 */
export function parsePathsIgnore(yamlText) {
  if (typeof yamlText !== 'string' || !yamlText.includes('paths-ignore:')) return null;
  const lines = yamlText.split('\n');
  const start = lines.findIndex((l) => /^\s*paths-ignore:\s*$/.test(l));
  if (start < 0) return null; // inline-array form (`paths-ignore: [a, b]`) is NOT handled — say so
  const keyIndent = lines[start].search(/\S/);
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (/^\s*$/.test(raw)) continue;
    const indent = raw.search(/\S/);
    if (indent <= keyIndent) break;            // dedented out of the block
    const t = raw.trim();
    if (t.startsWith('#')) continue;           // a comment inside the list
    if (!t.startsWith('- ')) return null;      // something we do not understand -> refuse
    let v = t.slice(2).trim();
    const q = v[0];
    if (q === "'" || q === '"') {
      const end = v.lastIndexOf(q);
      if (end <= 0) return null;
      v = v.slice(1, end);
    } else {
      v = v.split('#')[0].trim();              // trailing comment on an unquoted scalar
    }
    if (!v) return null;
    out.push(v);
  }
  return out.length ? out : null;
}

/**
 * Does one path match one GitHub filter pattern? Returns null for any pattern shape this does
 * not implement, so an unknown pattern can never be read as "ignored".
 *
 * Implemented: literals, `*` (within a segment), `**` (across segments). NOT implemented:
 * `!` negation, `?`, `[...]` character classes, `{a,b}` braces — all of which would change the
 * answer and none of which appear in this repo's list today.
 */
export function matchesPattern(path, pattern) {
  if (/[!?[\]{}]/.test(pattern)) return null;
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') { re += '.*'; i++; if (pattern[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else re += c.replace(/[.+^$()|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`).test(path);
}

/**
 * Is EVERY changed file ignored? true / false / null (could not determine).
 *
 * @param {string[]|null} changedFiles aggregate prodSha..mainHead file list
 * @param {string[]|null} pathsIgnore  the list read from deploy.yml at the pinned mainHead
 */
export function isNonDeployingDelta(changedFiles, pathsIgnore) {
  if (!Array.isArray(changedFiles) || !Array.isArray(pathsIgnore) || !pathsIgnore.length) return null;
  // An EMPTY file list is not "everything is ignored" — it means the diff could not be built
  // (two differing SHAs always differ in at least one file). Vacuity, decided at construction.
  if (!changedFiles.length) return null;
  for (const f of changedFiles) {
    let ignored = false;
    for (const pat of pathsIgnore) {
      const m = matchesPattern(f, pat);
      if (m === null) return null; // a pattern we cannot evaluate poisons the whole answer
      if (m) { ignored = true; break; }
    }
    if (!ignored) return false;    // one deploying file is enough
  }
  return true;
}

export const BADGE_URL =
  'https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/actions/workflows/deploy.yml/badge.svg?branch=main';

/**
 * Advance the drift latch for one repo. PURE — no clock, no I/O, so the self-test can execute the
 * exact code main() runs rather than a paraphrase of it.
 *
 * Returns `{ ledger, behindMs, deltaKey }`. `behindMs` is how long THIS delta has been observed,
 * and it is 0 when provenance was unreadable — see the block in main() for the incident.
 */
export function advanceDriftLatch({ ledger, repoName, prodSha, mainHead, now }) {
  const key = `${repoName}:drift`;
  const deltaKey = prodSha && mainHead ? `${prodSha}..${mainHead}` : null;
  if (deltaKey === null) {
    // Observed no delta. Neither start a clock nor reset one: "could not look" must not
    // manufacture an age, and must not wipe a real stuck deploy's accumulated one.
    return { ledger, behindMs: 0, deltaKey: null };
  }
  const prev = ledger[key];
  const firstSeenMs = prev && prev.deltaKey === deltaKey ? prev.firstSeenMs : now;
  return {
    ledger: { ...ledger, [key]: { firstSeenMs, deltaKey } },
    behindMs: now - firstSeenMs,
    deltaKey,
  };
}

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
  const { prodSha, mainHead, suiteVerdict, laneHealth = null, nonDeploying = null,
    graphTouchers = [], sessionCommits = [] } = f;

  // Provenance we could not read is INDETERMINATE, never "in sync". Assuming sync on a missing
  // measurement is how a stale deploy hides: the canary would go quiet precisely when the thing
  // it measures stopped reporting.
  if (!prodSha || !mainHead) return { verdict: 'DRIFT_INDETERMINATE', reason: 'provenance unreadable' };

  if (prodSha === mainHead) return { verdict: 'DRIFT_NONE', reason: 'in sync' };

  // CH1. Checked BEFORE any lane reasoning: a delta that cannot trigger a deploy is not drift,
  // and asking "why is the lane red" about it would be answering a question nobody asked. Only
  // an explicit `true` suppresses; false and null both fall through to the ordinary path.
  if (nonDeploying === true) {
    return {
      verdict: 'DRIFT_NONE_NON_DEPLOYING',
      reason: 'every file in prod..main is paths-ignore\u0027d in deploy.yml — no run was ever created, so prod CANNOT catch up and this is not drift',
    };
  }

  if (suiteVerdict === 'PASS' || suiteVerdict === 'PASS_AFTER_ISOLATION') {
    return { verdict: 'DRIFT_RECOVERABLE', reason: `main green (${suiteVerdict}), prod behind` };
  }

  if (suiteVerdict !== 'FAIL') {
    // INDETERMINATE, or no per-SHA run verdict available. Still an unknown, and it is still
    // never laundered into a green or a blame — but it no longer has to be CONTENTLESS.
    //
    // laneHealth is the deploy workflow's LATEST run on main. It is deliberately a separate
    // field from suiteVerdict, and it is NOT bound to mainHead: the badge carries no SHA
    // (measured — the only hex in that SVG is path/animation data). So it enriches the REASON
    // and can never reach DRIFT_RECOVERABLE, which is the one verdict decideRecovery() acts on.
    const caveat = nonDeploying === null ? '; could not determine whether the delta deploys' : '';
    if (laneHealth === 'failing') {
      return {
        verdict: 'DRIFT_INDETERMINATE',
        reason: `deploy lane RED — the latest Deploy run on main did not pass${caveat}`,
        cause: 'lane-red',
        next: 'gh run list --workflow "Deploy to Hetzner" --limit 3',
      };
    }
    if (laneHealth === 'passing') {
      return {
        verdict: 'DRIFT_INDETERMINATE',
        reason: `deploy lane GREEN but prod is behind — a run may be in flight, or a deploy succeeded without advancing prod${caveat}`,
        cause: 'lane-green-prod-behind',
        next: 'gh run list --workflow "Deploy to Hetzner" --limit 3   # if the newest run is green and OLDER than main, prod did not take the deploy',
      };
    }
    return {
      verdict: 'DRIFT_INDETERMINATE',
      reason: `deploy lane health unreadable${caveat}`,
      cause: 'lane-unknown',
      next: 'curl -sS "https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/actions/workflows/deploy.yml/badge.svg?branch=main" | grep -o "<title>[^<]*"',
    };
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

  /* ── OPS-DEPLOY-DRIFT-VERDICT-LEG-W1 ─────────────────────────────────────────────────── */

  // THE SAFETY PROPERTY. laneHealth is the newest run on the BRANCH and carries no SHA, so it
  // must never reach DRIFT_RECOVERABLE — the one verdict decideRecovery() acts on. Enumerated
  // over every lane value AND every nonDeploying value, because a property asserted on one
  // sample is a sample, not a property.
  let recoverableLeak = 0;
  for (const lh of [null, 'passing', 'failing', 'unknown', 'weird-new-state']) {
    for (const nd of [null, true, false]) {
      if (classifyDrift({ ...base, laneHealth: lh, nonDeploying: nd }).verdict === 'DRIFT_RECOVERABLE') recoverableLeak++;
    }
  }
  t('no lane/delta combination can ever reach DRIFT_RECOVERABLE', recoverableLeak, 0);
  // ...and the ONLY thing that still can is a per-SHA green, which production never supplies.
  t('a per-SHA green still does (pure classifier keeps its contract)',
    classifyDrift({ ...base, suiteVerdict: 'PASS', laneHealth: 'failing' }).verdict, 'DRIFT_RECOVERABLE');

  t('a non-deploying delta is not drift',
    classifyDrift({ ...base, nonDeploying: true }).verdict, 'DRIFT_NONE_NON_DEPLOYING');
  t('non-deploying wins over a red lane (it was never asked to deploy)',
    classifyDrift({ ...base, nonDeploying: true, laneHealth: 'failing' }).verdict, 'DRIFT_NONE_NON_DEPLOYING');
  t('a red lane names the cause', classifyDrift({ ...base, laneHealth: 'failing' }).cause, 'lane-red');
  t('a green lane + behind prod is escalate-worthy, not silent',
    classifyDrift({ ...base, laneHealth: 'passing' }).cause, 'lane-green-prod-behind');
  t('an unreadable lane stays honest', classifyDrift({ ...base, laneHealth: 'unknown' }).cause, 'lane-unknown');
  t('an undetermined delta says so, it does not go quiet',
    /could not determine whether the delta deploys/.test(classifyDrift({ ...base, laneHealth: 'failing', nonDeploying: null }).reason), true);
  t('a determined-deploying delta adds no caveat',
    /could not determine/.test(classifyDrift({ ...base, laneHealth: 'failing', nonDeploying: false }).reason), false);

  t('badge: passing', parseBadgeTitle('<title>Deploy to Hetzner - passing</title>'), 'passing');
  t('badge: failing', parseBadgeTitle('<title>Deploy to Hetzner - failing</title>'), 'failing');
  t('badge: no status is UNKNOWN, never a pass', parseBadgeTitle('<title>Deploy to Hetzner - no status</title>'), 'unknown');
  t('badge: unparseable is UNKNOWN, never a pass', parseBadgeTitle('<svg></svg>'), 'unknown');

  // paths-ignore parsing, against the REAL shape of deploy.yml (comments interleaved, quoted).
  const yaml = ['on:', '  push:', '    branches: [main]', '    paths-ignore:',
    "      - 'ops/monitoring/**'", '      # a comment inside the list', "      - 'LICENSE'",
    '      - Caddyfile', '', 'concurrency:', '  group: x'].join('\n');
  t('paths-ignore parses past interleaved comments', parsePathsIgnore(yaml), ['ops/monitoring/**', 'LICENSE', 'Caddyfile']);
  t('an absent block is null, never []', parsePathsIgnore('on:\n  push:\n'), null);
  t('the inline-array form is REFUSED, not silently misread', parsePathsIgnore('    paths-ignore: [a, b]\n'), null);

  // The two fixtures below are REAL history, and they are the whole point of CH1.
  const IGN = ['ops/monitoring/**', 'LICENSE', 'Caddyfile'];
  t('aad0e26 (ops/monitoring only, ZERO deploy runs) is non-deploying',
    isNonDeployingDelta(['ops/monitoring/alert-registry.json', 'ops/monitoring/monitoring-inventory.json'], IGN), true);
  t('2c3a6ea (an audits/ doc) DOES deploy — and it is what stranded prod',
    isNonDeployingDelta(['audits/RELEASE-v1.28.0-W1-endpoint-truth.md'], IGN), false);
  t('one deploying file in a mixed delta is enough',
    isNonDeployingDelta(['ops/monitoring/a.json', 'src/index.ts'], IGN), false);
  t('an empty diff is INCONCLUSIVE, never "all ignored"', isNonDeployingDelta([], IGN), null);
  t('an unreadable paths-ignore is INCONCLUSIVE', isNonDeployingDelta(['ops/monitoring/a.json'], null), null);
  t('a pattern shape we do not implement is INCONCLUSIVE, never ignored',
    isNonDeployingDelta(['a'], ['a{b,c}']), null);
  t('** does not leak across a sibling prefix', matchesPattern('ops/monitoring-x/a', 'ops/monitoring/**'), false);
  t('* does not cross a slash', matchesPattern('a/b/c', 'a/*'), false);

  // The rendered BODY, not just the verdict.
  const body = renderAlertBody({
    repo: 'crypto-quant-signal-mcp', verdict: classifyDrift({ ...base, laneHealth: 'failing' }),
    prodSha: 'a'.repeat(40), mainHead: 'b'.repeat(40), behindMs: 60 * 60 * 1000, laneHealth: 'failing',
  });
  t('body carries the lane AND its binding caveat', /deploy lane \(latest run on main, NOT necessarily this sha\): failing/.test(body), true);
  t('body carries the operator\u0027s next command', /next: gh run list --workflow "Deploy to Hetzner"/.test(body), true);
  t('body uses REAL newlines, never %0A', body.includes('%0A'), false);
  t('body still leads with the repo', body.split('\n')[0], '🚨 deploy drift — crypto-quant-signal-mcp');

  // ── the drift latch, keyed on the DELTA (OPS-DEPLOY-DRIFT-PROPAGATION-WINDOW-W1) ──────────
  const P0 = 'a'.repeat(40), P1 = 'b'.repeat(40), M1 = 'c'.repeat(40), M2 = 'd'.repeat(40);
  const T = 1e12, HALF_HOUR = 30 * 60 * 1000;
  const latch = (ledger, prodSha, mainHead, now) =>
    advanceDriftLatch({ ledger, repoName: 'r', prodSha, mainHead, now });

  const l1 = latch({}, P0, M1, T);
  t('a newly observed delta starts its own clock at zero', l1.behindMs, 0);
  const l2 = latch(l1.ledger, P0, M1, T + HALF_HOUR);
  t('the SAME delta accumulates — a genuinely stuck deploy still ages', l2.behindMs, HALF_HOUR);
  t('...and past the grace it may page', l2.behindMs > BEHIND_GRACE_MS, false);
  const l2b = latch(l1.ledger, P0, M1, T + HALF_HOUR + 1);
  t('...strictly past the grace, it pages', l2b.behindMs > BEHIND_GRACE_MS, true);

  // THE INCIDENT, 2026-09-02: an unreadable-provenance run at 11:43 started a clock that a
  // four-minute-old delta inherited at 12:13 and paged on, reporting a false "behind: 30m".
  const unread = latch({}, P0, null, T);
  t('🛑 unreadable provenance observes NO delta and starts NO clock', unread.behindMs, 0);
  t('...and writes no latch at all', JSON.stringify(unread.ledger), '{}');
  const afterUnread = latch(unread.ledger, P0, M1, T + HALF_HOUR);
  t('🛑 THE REGRESSION: a real delta seen later does NOT inherit that clock', afterUnread.behindMs, 0);
  t('...so it cannot page on its first observation', afterUnread.behindMs > BEHIND_GRACE_MS, false);

  // main advancing is a NEW delta — the clock restarts, it does not carry over.
  const l3 = latch(l2.ledger, P0, M2, T + HALF_HOUR + 1000);
  t('main advancing resets the clock — a new delta is newly behind', l3.behindMs, 0);
  const l4 = latch(l2.ledger, P1, M1, T + HALF_HOUR + 1000);
  t('prod advancing resets it too', l4.behindMs, 0);

  // ...but an unreadable run must NOT wipe a real stuck deploy's accumulated age.
  const keep = latch(l2.ledger, P0, null, T + HALF_HOUR + 1000);
  t('🛑 an unreadable run PRESERVES an existing latch, never resets it',
    keep.ledger['r:drift'].firstSeenMs, T);
  const resumed = latch(keep.ledger, P0, M1, T + HALF_HOUR + 2000);
  t('...so the stuck delta resumes its real age and still pages',
    resumed.behindMs > BEHIND_GRACE_MS, true);

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
    // Declared per repo, never assumed for all of them. algovault-bot deliberately has NEITHER:
    // it has its own deploy path and its own workflow, and inventing a paths-ignore story for
    // it here would be fiction. Absent => those legs stay null and the repo keeps today's
    // behaviour exactly.
    laneBadge: BADGE_URL,
    deployPathsIgnore: true,
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
 * The deploy-lane health leg — token-free, and NOT bound to a SHA.
 *
 * WHAT THIS REPLACED, AND WHY NOT A TOKEN. The old readSuiteVerdict() called
 * `actions/runs?per_page=1` with NO workflow_id, NO head_sha and NO branch filter — the newest
 * run of ANY workflow on ANY ref. Measured 2026-08-21: at 13:25 that was `Publish to npm
 * 81cf4f0 failure`, an npm failure with nothing to do with whether prod can deploy; at
 * 17:03:47Z two runs shared one timestamp so the winner was arbitrary. Handing THAT a token
 * would have bought confident wrong blame, which is strictly worse than the honest null it
 * returned. So the fix is not a credential — it is a correctly scoped, unmetered source.
 *
 * The badge is metered separately from api.github.com. Measured on signal-1 while REST
 * `core.remaining` was 0/60: badge HTTP 200. Same trick as OPS-XREPO-CI-CANARY-DARK-W1, and
 * the same trap it names — `cancelled` renders as `failing`.
 *
 * THE BINDING IS LOOSE AND THE NAME SAYS SO. The badge reports the newest run on the BRANCH; it
 * carries no SHA (measured — the only hex in that SVG is path and animation data). It is
 * therefore `laneHealth`, never `suiteVerdict`, and classifyDrift can never turn it into
 * DRIFT_RECOVERABLE. That is asserted by a test, not left to this comment.
 *
 * @returns {'passing'|'failing'|'unknown'}
 */
export function parseBadgeTitle(svg) {
  const m = /<title>([^<]*)<\/title>/.exec(String(svg ?? ''));
  if (!m) return 'unknown';
  const state = m[1].split(' - ').pop().trim().toLowerCase();
  if (state === 'passing') return 'passing';
  if (state === 'failing') return 'failing';   // `cancelled` also renders here — deliberate
  return 'unknown';                            // 'no status', 'unknown', anything new
}

export function readDeployLaneHealth(url = BADGE_URL) {
  const r = sh('curl', ['-sS', '-m', '20', '-H', 'Cache-Control: no-cache', url]);
  if (!r.ok || !r.out) return 'unknown';
  return parseBadgeTitle(r.out);
}

/* ─────────────── the local, unmetered source for "does this delta deploy?" ─────────────── */

export const MIRROR = '/var/lib/algovault-monitoring/cqsm-mirror.git';

/**
 * A blob-filtered BARE mirror, refreshed per run. Git protocol, so no REST budget; measured
 * 2.7 MB for this repo, and `git diff --name-only` needs trees, not blobs.
 *
 * NEVER fetch into /opt/crypto-quant-signal-mcp. That is a live deploy root (its HEAD is the
 * deployed SHA), and an unattended job does not mutate deploy state — detect, alert, escalate.
 * This mirror is the canary's OWN state, which is why it gets its own inventory row.
 */
export function ensureMirror(remote, path = MIRROR) {
  if (existsSync(`${path}/HEAD`)) {
    const f = sh('git', ['--git-dir', path, 'fetch', '--quiet', 'origin', '+refs/heads/*:refs/heads/*']);
    return f.ok ? { ok: true, mode: 'fetch' } : { ok: false, err: `fetch failed: ${f.err ?? ''}`.trim() };
  }
  try { mkdirSync(dirname(path), { recursive: true }); } catch { /* non-fatal */ }
  const c = sh('git', ['clone', '--filter=blob:none', '--bare', '--quiet', remote, path]);
  return c.ok ? { ok: true, mode: 'clone' } : { ok: false, err: `clone failed: ${c.err ?? ''}`.trim() };
}

/** Aggregate changed-file list, or null. --no-renames keeps it deterministic and blob-free. */
export function changedFilesBetween(a, b, path = MIRROR) {
  const r = sh('git', ['--git-dir', path, 'diff', '--no-renames', '--name-only', a, b]);
  if (!r.ok) return null;
  const files = r.out.split('\n').filter(Boolean);
  return files.length ? files : null; // two differing SHAs always differ in >=1 file
}

/**
 * deploy.yml's paths-ignore, read AT THE PINNED mainHead SHA.
 *
 * Never hardcode the list — a duplicated fact that goes stale silently, and this repo already
 * deleted one paths-ignore enumeration from CLAUDE.md for exactly that. And never read it by
 * ref form: a CDN-cached raw read is controlled by a cache-buster or a pinned SHA. mainHead is
 * already in hand, so it is pinned and the cache question does not arise.
 */
export function readPathsIgnoreAt(sha) {
  if (!/^[0-9a-f]{40}$/.test(String(sha ?? ''))) return null;
  const r = sh('curl', ['-sS', '-m', '20',
    `https://raw.githubusercontent.com/AlgoVaultLabs/crypto-quant-signal-mcp/${sha}/.github/workflows/deploy.yml`]);
  if (!r.ok || !r.out) return null;
  return parsePathsIgnore(r.out);
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

/**
 * The alert BODY, as a pure function so --self-test can assert the rendered text and not merely
 * the verdict. Reverting a format string once left all nine action-verdict assertions on a
 * sibling canary GREEN while the body it shipped was misleading — which is exactly how a
 * misleading body survives every gate.
 *
 * REAL NEWLINES, NEVER %0A. send_telegram.sh does its own --data-urlencode, and that wrapper is
 * frozen (OPS-XREPO-CI-CANARY-DARK-W1 D2 shipped a body rendering literal `%0A` to the operator).
 */
export function renderAlertBody({ repo, verdict, prodSha, mainHead, behindMs, laneHealth }) {
  const lines = [
    `🚨 deploy drift — ${repo}`,
    `verdict: ${verdict.verdict}`,
    `prod: ${prodSha ?? 'UNKNOWN'}`,
    `main: ${mainHead ?? 'UNKNOWN'}`,
    `behind: ${Math.round(behindMs / 60000)}m`,
    `reason: ${verdict.reason}`,
  ];
  if (verdict.owner) lines.push(`owner: ${verdict.owner}`);
  if (laneHealth) {
    // The caveat is IN THE BODY, not just in a source comment. An operator told the binding is
    // loose can act on it; one who is not will over-trust a green lane. The badge reports the
    // newest run on main, which need not be main's CURRENT head.
    lines.push(`deploy lane (latest run on main, NOT necessarily this sha): ${laneHealth}`);
  }
  if (verdict.next) lines.push(`next: ${verdict.next}`);
  return lines.join('\n');
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

    // Both legs are consulted ONLY when prod is behind; in-sync short-circuits before either
    // costs a network round-trip.
    const behind = Boolean(prodSha && mainHead && prodSha !== mainHead);
    let nonDeploying = null;
    let laneHealth = null;
    if (behind && repo.deployPathsIgnore) {
      const mir = ensureMirror(repo.remote);
      if (!mir.ok) log(`${repo.name}: mirror unavailable (${mir.err}) — non-deploying test INCONCLUSIVE`);
      else nonDeploying = isNonDeployingDelta(changedFilesBetween(prodSha, mainHead), readPathsIgnoreAt(mainHead));
    }
    if (behind && repo.laneBadge) laneHealth = readDeployLaneHealth(repo.laneBadge);

    const verdict = classifyDrift({
      prodSha,
      mainHead,
      // suiteVerdict is a PER-SHA verdict and nothing on this host can produce one, so it stays
      // null in production. It is NOT dead code: it is the only input that can yield
      // DRIFT_RECOVERABLE, the only verdict decideRecovery() acts on. Keeping it null here is
      // what makes auto-recovery unreachable BY CONSTRUCTION rather than by luck, and the pure
      // classifier keeps its full graded contract for the tests.
      suiteVerdict: null,
      laneHealth,
      nonDeploying,
      failingFiles: [],
      graphTouchers: [],
      sessionCommits: [],
    });

    // Per-check positive output. A guard that prints nothing when healthy is indistinguishable
    // from a guard that never ran.
    log(`${repo.name}: prod=${prodSha ? prodSha.slice(0, 7) : 'UNKNOWN'} main=${mainHead ? mainHead.slice(0, 7) : 'UNKNOWN'} lane=${laneHealth ?? 'n-a'} nonDeploying=${nonDeploying === null ? 'unknown' : nonDeploying} -> ${verdict.verdict} (${verdict.reason})`);

    if (HEALTHY_VERDICTS.has(verdict.verdict)) {
      // Clear any drift latch: recovery and health are not events. NON_DEPLOYING clears it too —
      // a latch left standing would keep a resolved page's behind-clock running.
      if (next[`${repo.name}:drift`]) next = { ...next, [`${repo.name}:drift`]: undefined };
      if (verdict.verdict !== 'DRIFT_NONE' && worst === 'DRIFT_NONE') worst = verdict.verdict;
      continue;
    }
    worst = verdict.verdict;

    // ── Persistence latch, keyed on the DELTA — not merely on the repo ──────────────────────
    //
    // 🛑 THE DEFECT THIS RETIRES, measured 2026-09-02. The latch used to key on the repo alone
    // and clear only on a HEALTHY verdict, so `behindMs` answered "how long has this repo been
    // non-healthy" while the alert body and decideRecovery() both read it as "how long has prod
    // been behind THIS main". Those are different questions the moment the delta changes, and a
    // run that could not read provenance at all — which observes NO delta — was starting the
    // clock for one:
    //
    //   11:43  prod=86dd6a0  main=UNKNOWN   INDETERMINATE (provenance unreadable)  ← clock starts
    //   12:13  prod=86dd6a0  main=3a1f791   INDETERMINATE                          ← inherits it
    //                                       -> behind: 30m -> PAGED
    //
    // main advanced at ~12:09 and the deploy completed 12:15, so the delta was FOUR MINUTES old.
    // The `behind: 30m` printed in that page was false, inherited from an observation that knew
    // nothing about any delta. Simulated over the full log: 36 of 68 INDETERMINATE runs had their
    // (prod,main) pair gone by the very next run — transient propagation — while 26 persisted and
    // remain genuine. This keys the clock to the delta so only the 26 can page.
    //
    // An unreadable-provenance run neither STARTS nor RESETS a clock. "Could not look" is not
    // "looked and prod is behind", and it must not manufacture an age; equally it must not wipe a
    // real stuck deploy's accumulated one. It simply cannot page.
    const latch = advanceDriftLatch({ ledger: next, repoName: repo.name, prodSha, mainHead, now });
    next = latch.ledger;
    const behindMs = latch.behindMs;

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
      const body = renderAlertBody({ repo: repo.name, verdict, prodSha, mainHead, behindMs, laneHealth });
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
  if (HEALTHY_VERDICTS.has(worst)) {
    const cleared = sh('sh', ['-c', `${WRAP} --clear DEPLOY_DRIFT 'deploy drift verdict=${worst}' </dev/null || true`]);
    log(`deploy-drift: healthy — clear dispatched (ok=${cleared.ok})`);
  }

  console.log(`DRIFT_VERDICT=${worst}`);
  return 0; // detection never fails the scheduler — it REFUSES, it does not THROW
}

if (process.argv[1] && process.argv[1].endsWith('deploy-drift-canary.mjs')) {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) process.exit(selfTest());
  process.exit(main());
}
