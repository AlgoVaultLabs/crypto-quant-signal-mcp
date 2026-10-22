#!/usr/bin/env node
/**
 * gh-run-conclusion.mjs — OPS-XREPO-CI-RED-W1 CH2.
 *
 * THE ONE DERIVATION OF A GITHUB WORKFLOW'S LATEST-RUN CONCLUSION, BOUND TO THE RUN IT NAMES.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────────────────────
 * On 2026-10-03T09:41:03Z the cross-repo CI canary paged `xrepo_ci_red` naming
 * `marketplace-check.yml` run #144 (37017230705). Run #144 had SUCCEEDED. The page joined two
 * reads that nothing asserted were about the same run: the badge's `<title>` said `failing`, and
 * the Actions page's newest row said #144 — whose own status icon, in the same fetch, said
 * success. Measured afterwards (vault audits/OPS-XREPO-CI-RED-W1-endpoint-truth.md §4): GitHub's
 * badge endpoint serves a WRONG state in short episodes (≤ 97 s), on both vantages measured,
 * interleaved with correct responses in the same second, and caches the wrong body per URL. The
 * deploy badge was also wrong for 2h25m on 2026-10-02 while Deploy #1065 had failed, and a
 * DEPLOY_DRIFT page went out calling that lane green (prior N1). Six instances by root cause,
 * four inside 30 days: the class is "an identity-less conclusion treated as a fact about a
 * specific run". A lane fix is forbidden; this module is the generator fix.
 *
 * ── WHAT IT DOES ────────────────────────────────────────────────────────────────────────────
 * Two instruments, one record:
 *   · the badge  …/actions/workflows/<wf>/badge.svg[?branch=<b>]  — conclusion, NO run identity
 *   · the run record: the Actions page row of the newest TERMINAL run — the first <svg> INSIDE
 *     that row's own <a href="/<repo>/actions/runs/<id>"> anchor (R0 D1: an in-progress row's
 *     status svg is `anim-rotate`, and its first octicon is an `octicon-calendar` decoy).
 * They are BOUND by the table below (data, BIND_TABLE). Every consumer projects its verdict from
 * the record by its declared class (verdictFor). A record carries `bound_run` ONLY when the run's
 * own record supports the claim (rows 1, 2, 4) — so a consumer can print "run #N failed" only from
 * a bound run, and a misattributed run line is unwritable.
 *
 *   # badge                 run record      agreement        alerting       blocking       attribution
 *   1 passing               success         AGREE            PASS           PASS           passing
 *   2 failing               failure-class   AGREE            FAIL           FAIL           failing
 *   3 failing               success         DISAGREE         INDETERMINATE  INDETERMINATE  unknown
 *   4 passing               failure-class   DISAGREE         FAIL           FAIL           failing
 *   5 failing               unavailable     UNCORROBORATED   FAIL           INDETERMINATE  unknown
 *   6 passing               unavailable     UNCORROBORATED   PASS           INDETERMINATE  unknown
 *   7 name != row name      —               DISAGREE         INDETERMINATE  INDETERMINATE  unknown
 *   8 unreadable/no status  any             UNREADABLE       INDETERMINATE  INDETERMINATE  unknown
 *   R input refused before any fetch (non-canonical / `.atom`), or an any-ref read whose newest
 *     finished run's ref could not be resolved (ruling Q9)       UNCORROBORATED  INDETERMINATE ×2  unknown
 *
 * THE AMENDED RULE (architect ruling, 2026-10-03): prose never decides. The row's structured icon
 * may VETO a badge RED (row 3) and may RAISE a RED the badge missed (row 4). It may never produce
 * a PASS: every PASS still requires the badge's own `passing`. A GitHub markup change can only make
 * the icon UNMEASURED (rows 5/6 = today's badge-only behaviour, labelled); a success icon on a
 * failed run yields row 3, which feeds the dark streak. Every failure mode self-announces.
 *
 * ── RECOVER ─────────────────────────────────────────────────────────────────────────────────
 * Any non-AGREE outcome re-reads BOTH instruments: GHRC_READS reads in total, GHRC_SPACING_S
 * apart. The first AGREE wins. Otherwise selectSample() decides, and it never discards run-record
 * evidence read inside the window: the newest terminal run read wins, then the more informative
 * agreement (DISAGREE > UNCORROBORATED > UNREADABLE), then a bound (record-confirmed) sample, then
 * the majority badge state, then the latest read. The monotonic floor RISES inside the window, so a
 * stale page that falls back to an older run can never AGREE its way past a failure already read.
 * The span (reads − 1) × spacing is DERIVED from the measured EPISODE_ENVELOPE and the self-test
 * refuses a config whose span does not exceed it.
 *
 * ── THE CACHE-BUSTER — ON (architect ruling Q6, 2026-10-04) ────────────────────────────────
 * The canary's header says "NO CACHE-BUSTER, DELIBERATELY" because a daily read is far slower than
 * a 300 s cache. Recover's re-reads are 60 s apart, and the mechanism is now MEASURED: GitHub's
 * origin renders an occasional wrong badge, and a cache in front of the PLAIN URL can capture one
 * and re-serve it — ~10–15 s windows on the Mac path, read off the `Date` header (episode #2: the
 * same `Date: 12:02:06 GMT` on two reads 11 s apart; 2026-10-04: one body `Date: 04:55:15 GMT`
 * re-served at 04:55:20 / :25 / :29). Re-reading a cached body recovers nothing, so every read
 * carries `ghrc_cb=<epoch>-<read#>`, unique per read: busted reads are INDEPENDENT renders, which is
 * what Recover needs. The buster buys independence, NOT correctness — a busted read can still be one
 * wrong origin render (04:55:10Z) — so Recover and the run-record corroborator stay the deciding
 * mechanisms, and the bind table does not change.
 * Adoption criterion (ruling Q6, replacing Q3(b)'s plain-vs-busted equality, which used a plain read
 * — itself possibly the cached wrong body — as ground truth): judge every read against the run
 * record, adopt iff busted errors ≤ plain errors on the same pairs.
 *   · 2026-10-03 15:34–15:35Z (truth #145 37123657814 success): Mac plain 2/30 wrong, busted 0/30;
 *     signal-1 0/30 both.
 *   · 2026-10-04 04:55Z (Mac): plain 3/12 wrong (ONE cached body), busted 1/12 (one origin render),
 *     then busted-only 41/41 right over 150 s.
 * Each samples[] entry records its `ghrc_cb` value and the response `Date` header — the
 * discriminator between a cached body (a stale Date re-served) and an origin glitch (a fresh one).
 *
 * ── ANY REF IS SAME-REF (architect ruling Q9, 2026-10-04 — OPS-XREPO-CI-RED-W1 CH4) ─────────
 * A badge with NO `?branch=` shows the DEFAULT branch (GitHub's docs), while the Actions page with no
 * query lists ALL refs. Read as a pair they described two different runs: measured 2026-10-04T12:22Z,
 * publish-npm.yml's page bound tag run #29 (37201506699, v1.31.1) while the no-param badge described
 * main's #28 (37182060859) — an "AGREE" across two runs, the class this module exists to retire. So for
 * `branch: null` EVERY read (Recover re-reads included): (1) reads the any-ref page and walks to its
 * newest TERMINAL row; (2) takes that row's ref from its own `branch-name` element's `title` (refOfRun —
 * a structured field, the SHORT ref name); (3) reads the badge with `?branch=<ref>` and the page with
 * `?query=branch%3A<ref>`, and binds exactly as a named branch. Measured (Cowork, Mac, 2026-10-04
 * ~12:30Z, cache-busted): `?branch=v1.31.1` passing = #29 success; `?branch=v1.31.0` failing = #27
 * 35852161288; `?branch=v1.30.0` failing = #26 34451023162; `?branch=refs/tags/v1.31.1` and
 * `?branch=v9.9.9` "no status" (the badge takes the short name only); `?query=branch%3Av1.31.1` lists
 * exactly #29. A ref that is missing, unparseable (renders disagree / no title) or outside
 * [A-Za-z0-9._-] (a slash-ref was never measured) binds NOTHING: row R, UNCORROBORATED, reason
 * `ref_missing | ref_unparseable | ref_out_of_vocabulary | ref_page_<guard>`. The record carries
 * `resolved_ref` + `ref_resolution`, and the CLI prints GHRC_RESOLVED_REF / GHRC_REF_REASON — for
 * any-ref reads ONLY. A named-branch read takes the exact pre-Q9 path: its record, its GHRC lines and its
 * fetch sequence are byte-identical — proven against the pre-Q9 module (origin/main 7be6c89a): 144 read
 * scenarios (16 × 3 classes × 3 floor inputs) comparing the record, the GHRC lines, the token, the sleeps AND
 * every fetch call, plus 48 CLI runs through the fixture-dir seam — 0 differences (vault audit
 * OPS-XREPO-CI-RED-W1-endpoint-truth.md §16). The two any-ref guards it adds: a ref page that lags behind
 * the resolved run reads `ref_page_behind` (never an older run on that ref), and Recover's newest-run rule
 * counts the run a read resolved from.
 *
 * ── HONEST SCOPE ────────────────────────────────────────────────────────────────────────────
 *   · Both instruments wrong in the same way at once makes AGREE wrong. Nothing removes that.
 *   · Recency is not this module's question (the canary's XREPO_CI_FRESHNESS owns it).
 *   · This is not a token reader: a green run that verified nothing stays invisible.
 *   · `job_groups_batch` (R0.8) was measured and NOT adopted: undocumented, job-level, blind to
 *     zero-job runs. No code path touches it.
 *
 * ── CONTRACT (frozen at CH2; CH3 + CH4 consume exactly this; ruling Q9 amended --any-ref ONLY) ──
 *   node ops/monitoring/gh-run-conclusion.mjs --repo R --workflow W (--branch B | --any-ref)
 *        [--min-run-id N] --class alerting|blocking|attribution
 *     → GHRC_<FIELD>=<single-line value> lines, GHRC_RECORD=<one-line JSON>, then exactly one
 *       GH_RUN_CONCLUSION_VERDICT=PASS|FAIL|INDETERMINATE  (exit 0 / 1 / 3 via process.exitCode)
 *     (--any-ref adds GHRC_RESOLVED_REF + GHRC_REF_REASON after GHRC_BRANCH; --min-run-id there
 *      floors the ANY-REF page — each page read keeps its own monotonic floor.)
 *   --parse-badge (stdin)      → byte-identical to the canary's parse_badge_status (rc 0/1)
 *   --classify-status <token>  → byte-identical to the canary's classify_status
 *   --parse-page (stdin)       → byte-identical to the canary's parse_runs_page (rc 0/1)
 *   --self-test                → offline, two-way, ends with the same single token line
 *   Fixture mode: XREPO_CI_FIXTURE_DIR (alias GHRC_FIXTURE_DIR) with the canary's exact mangling
 *   (`tr -c 'A-Za-z0-9' '_'`) and extensions (.svg .html .code .ct); read N ≥ 2 uses the highest
 *   `.<ext>.k` ≤ N present (the last step repeats). An absent fixture is HTTP 404, as in the canary.
 *   A fixture row BINDS only if it carries, inside one `id="check_suite_…"` row: the anchor
 *   `<a href="/<owner>/<repo>/actions/runs/<id>">` with the status `<svg class="…">` INSIDE it, and
 *   `<span class="text-bold" >NAME</span> #N:` with NAME equal to the badge's name segment (the text
 *   before the LAST " - " of its <title>). Anything less reads UNCORROBORATED, by design.
 *
 * ── PAGE SHAPES (OPS-XREPO-CI-CANARY-DARK-W2, 2026-10-22) ────────────────────────────────────
 * Between 2026-10-14T16:13:06Z and 16:45:08Z (deploy-drift's last bound read → its first `vacuity`)
 * GitHub rebuilt the Actions workflow page: the run list left the `id="check_suite_…"` rows for JSON in
 * `<script type="application/json" data-target="react-app.embeddedData">`, at
 * payload.workflowRunsRoute.workflowRuns[]. parsePage split on a marker that no longer existed, read 0
 * rows, and all three consumers went unbound for 8 days while the dark page blamed the icon vocabulary.
 * Every page is now routed through EXACTLY ONE declared, measured shape (PAGE_SHAPES):
 *   no shape → page_shape_unknown · both → page_shape_ambiguous · React script whose JSON is unparseable,
 *   carries no workflowRunsRoute, or a workflowRuns that is not an array → page_shape_unparseable · a known
 *   shape with 0 rows → vacuity, which now MEANS "GitHub lists no runs" (an empty React list OMITS
 *   workflowRuns — measured on 5 empty queries) — unless the page contradicts itself (totalCount says runs
 *   exist → page_shape_unparseable) or the SAME read's badge names a conclusion (→ vacuity_badge_has_run:
 *   the badge is the independent witness that tells empty from renamed). Ruling Q1, 2026-10-22.
 * A React run maps to the SAME row object parsePage returns, so the walk, the bind, Recover and BIND_TABLE
 * do not change. Its state comes from STATE_VOCAB (status × conclusion, each with provenance; an unmatched
 * pair stops the walk as state_unmeasured:<status>/<conclusion>), and its identity fails CLOSED unless id,
 * runNumber, workflowName, workflowFilePath and runUrl all name THIS repo's run of THIS workflow. A legacy
 * page reads byte-identically to 963d15ac — pinned against a frozen copy in tests/fixtures.
 * Every string that can reach a record's `reason` maps to exactly ONE class (GUARD_CLASS, ruling Q2):
 *   --guard-class <reason>     → its class, exit 0; `unclassified`, exit 3
 * It is the canary's ONLY source of classes, so the dark page names the remedy this reader measured
 * instead of one guessed from a counter.
 *
 * No REST API host, no network write, no alert dispatch: it is a reader, not an alerter.
 * process.exitCode, NEVER process.exit() — a queued stdout write to a pipe would lose the token.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOKEN = 'GH_RUN_CONCLUSION_VERDICT';
/** 0 = PASS / 1 = FAIL / 3 = INDETERMINATE — the token-law default for a new gate. */
export const EXIT = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };
export const CLASSES = ['alerting', 'blocking', 'attribution'];
export const SCHEMA = 'gh-run-conclusion/1';

/** The measured episode envelope the Recover span must exceed. A number with its instrument. */
export const EPISODE_ENVELOPE = {
  seconds: 97,
  provenance: 'audits/OPS-XREPO-CI-RED-W1-endpoint-truth.md §4.2 (2026-10-03): episode #1 wrong badge reads 11:01:24Z–11:01:55Z, bounded by correct reads at 11:00:51Z and 11:02:28Z; signal-1 curl + Mac curl',
};

/** Recover defaults (architect ruling Q3 = A). Overridable by env; the self-test asserts the span. */
export const RECOVER_DEFAULTS = { reads: 3, spacingS: 60 };

/** Ruling Q6 (2026-10-04): ON — see the header for the mechanism and both adoption proofs. */
export const CACHE_BUSTER = {
  enabled: true,
  param: 'ghrc_cb',
  provenance: 'ruling Q6, 2026-10-04 — criterion: busted errors <= plain errors, judged against the run record. 2026-10-03T15:34-15:35Z (truth #145 37123657814 success): Mac plain 2/30 wrong, busted 0/30; signal-1 0/30 both. 2026-10-04T04:55Z (Mac): plain 3/12 wrong (one cached body, Date 04:55:15 GMT re-served at :20/:25/:29), busted 1/12 (one origin render, 04:55:10Z), then busted-only 41/41 right over 150 s.',
};

const DEFAULT_HOST = 'https://github.com';
const measured = (repo, runId, date, source) => ({ repo, run_id: runId, date, source });

/**
 * The run-row status icon vocabulary — DATA, each entry with its measurement provenance (R0.4).
 * `cls`: success | failure (failure-class) | nonterminal (the walk SKIPS it) |
 *        unbound (terminal, but the badge mapping is UNMEASURED → the walk STOPS).
 * Anything not matched here is UNMEASURED → the walk STOPS. A match needs EVERY listed token.
 */
export const ICON_VOCAB = [
  { state: 'success', cls: 'success', tokens: ['octicon-check-circle-fill', 'color-fg-success'],
    provenance: measured('AlgoVaultLabs/algovault-skills', '37017230705', '2026-10-03', 'estate') },
  { state: 'failure', cls: 'failure', tokens: ['octicon-x-circle-fill', 'color-fg-danger'],
    provenance: measured('AlgoVaultLabs/algovault-skills', '35616111211', '2026-10-03', 'estate'),
    note: 'startup_failure renders the SAME classes (third-party python/cpython 32985274559, measured 2026-10-03); it is failure-class either way' },
  { state: 'cancelled', cls: 'failure', tokens: ['octicon-stop', 'neutral-check'],
    provenance: measured('AlgoVaultLabs/crypto-quant-signal-mcp', '32396625268', '2026-10-03', 'estate'),
    note: 'badge mapping measured: a branch whose runs are all cancelled reads `failing`' },
  { state: 'skipped', cls: 'unbound', tokens: ['octicon-skip', 'neutral-check'],
    provenance: measured('cli/cli', '37049157896', '2026-10-03', 'third-party') },
  { state: 'action_required', cls: 'unbound', tokens: ['octicon-alert', 'color-fg-attention'],
    provenance: measured('python/cpython', '36846804560', '2026-10-03', 'third-party') },
  { state: 'in_progress', cls: 'nonterminal', tokens: ['anim-rotate'],
    provenance: measured('AlgoVaultLabs/crypto-quant-signal-mcp', '37118831402', '2026-10-03', 'estate') },
  { state: 'queued', cls: 'nonterminal', tokens: ['octicon-dot-fill', 'hx_dot-fill-pending-icon'],
    provenance: measured('home-assistant/core', '31118710168', '2026-10-03', 'third-party') },
  { state: 'waiting', cls: 'nonterminal', tokens: ['octicon-clock', 'color-fg-attention'],
    provenance: measured('pytorch/pytorch', '36763852463', '2026-10-03', 'third-party') },
];

/**
 * The React run-state vocabulary — DATA, each (status, conclusion) pair with its measurement provenance
 * (OPS-XREPO-CI-CANARY-DARK-W2 R1.0 §2, vault audits/OPS-XREPO-CI-CANARY-DARK-W2-endpoint-truth.md).
 * Same `state` names and the same four classes as ICON_VOCAB, so one run reads the same class on either
 * shape (the self-test pins it). `conclusion: null` = the key is ABSENT — measured on every non-COMPLETED
 * run (R1.0 P8); a non-COMPLETED run that carries one, or a COMPLETED run that lacks one, is unmeasured.
 * Only the MEASURED non-COMPLETED statuses are non-terminal (ruling): PENDING, REQUESTED or an unseen
 * status is unmeasured and STOPS the walk — it may be the newest failure. TIMED_OUT / NEUTRAL / STALE were
 * searched for and not found (cpython ×3, pytorch), so they stay unmeasured until a real run is.
 */
const RS = (s) => `WORKFLOW_RUN_STATUS_${s}`;
const RC = (c) => `WORKFLOW_RUN_CONCLUSION_${c}`;
export const STATE_VOCAB = [
  { status: RS('COMPLETED'), conclusion: RC('SUCCESS'), state: 'success', cls: 'success',
    provenance: measured('AlgoVaultLabs/algovault-skills', '39605376420', '2026-10-22', 'estate') },
  { status: RS('COMPLETED'), conclusion: RC('FAILURE'), state: 'failure', cls: 'failure',
    provenance: measured('AlgoVaultLabs/crypto-quant-signal-mcp', '39775273085', '2026-10-22', 'estate') },
  { status: RS('COMPLETED'), conclusion: RC('CANCELLED'), state: 'cancelled', cls: 'failure',
    provenance: measured('AlgoVaultLabs/crypto-quant-signal-mcp', '32396625268', '2026-10-22', 'estate'),
    note: 'the run ICON_VOCAB measured cancelled on; badge mapping measured 2026-10-03: a branch whose runs are all cancelled reads `failing`' },
  { status: RS('COMPLETED'), conclusion: RC('STARTUP_FAILURE'), state: 'startup_failure', cls: 'failure',
    provenance: measured('python/cpython', '32985274559', '2026-10-22', 'third-party'),
    note: 'the run ICON_VOCAB measured on 2026-10-03, where it renders the failure icon — failure-class on either shape' },
  { status: RS('COMPLETED'), conclusion: RC('SKIPPED'), state: 'skipped', cls: 'unbound',
    provenance: measured('cli/cli', '39651327538', '2026-10-22', 'third-party') },
  { status: RS('COMPLETED'), conclusion: RC('ACTION_REQUIRED'), state: 'action_required', cls: 'unbound',
    provenance: measured('python/cpython', '39701847845', '2026-10-22', 'third-party') },
  { status: RS('IN_PROGRESS'), conclusion: null, state: 'in_progress', cls: 'nonterminal',
    provenance: measured('python/cpython', '39779295471', '2026-10-22', 'third-party') },
  { status: RS('QUEUED'), conclusion: null, state: 'queued', cls: 'nonterminal',
    provenance: measured('home-assistant/core', '31125004263', '2026-10-22', 'third-party') },
  { status: RS('WAITING'), conclusion: null, state: 'waiting', cls: 'nonterminal',
    provenance: measured('pytorch/pytorch', '38288077815', '2026-10-22', 'third-party') },
];

/**
 * The page shapes this reader can read — DATA (OPS-XREPO-CI-CANARY-DARK-W2 R1.1). A page is routed
 * through EXACTLY ONE: it matches a shape when it carries that shape's marker (in comment-stripped markup
 * where `comments_stripped`). Each id has exactly one reader in SHAPE_READERS (the self-test pins the
 * pairing). The next redesign is one measured entry here, captured from signal-1.
 */
export const PAGE_SHAPES = [
  { id: 'legacy_check_suite_v1', marker: 'id="check_suite_', comments_stripped: true,
    provenance: { date: '2026-10-03', source: 'vault audits/OPS-XREPO-CI-RED-W1-endpoint-truth.md R0.4/R0.7 (112/112 rows, signal-1 + Mac); last served to signal-1 2026-10-14T16:13:06Z (deploy-drift-canary.log, last bound read)' } },
  { id: 'react_embedded_v1', marker: '<script type="application/json" data-target="react-app.embeddedData">', comments_stripped: false,
    route: 'payload.workflowRunsRoute.workflowRuns',
    provenance: { date: '2026-10-22', source: 'vault audits/OPS-XREPO-CI-CANARY-DARK-W2-endpoint-truth.md P5–P13: signal-1 (module curl argv) 6/6 pages, Mac 12:08Z 3/3; first seen by deploy-drift 2026-10-14T16:45:08Z' } },
];

/** The bound-conclusion table — DATA. `bound`: the row may carry a bound_run. */
export const BIND_TABLE = [
  { row: 1, badge: 'passing', record: 'success', agreement: 'AGREE', alerting: 'PASS', blocking: 'PASS', attribution: 'passing', bound: true },
  { row: 2, badge: 'failing', record: 'failure', agreement: 'AGREE', alerting: 'FAIL', blocking: 'FAIL', attribution: 'failing', bound: true },
  { row: 3, badge: 'failing', record: 'success', agreement: 'DISAGREE', alerting: 'INDETERMINATE', blocking: 'INDETERMINATE', attribution: 'unknown', bound: false },
  { row: 4, badge: 'passing', record: 'failure', agreement: 'DISAGREE', alerting: 'FAIL', blocking: 'FAIL', attribution: 'failing', bound: true },
  { row: 5, badge: 'failing', record: 'unavailable', agreement: 'UNCORROBORATED', alerting: 'FAIL', blocking: 'INDETERMINATE', attribution: 'unknown', bound: false },
  { row: 6, badge: 'passing', record: 'unavailable', agreement: 'UNCORROBORATED', alerting: 'PASS', blocking: 'INDETERMINATE', attribution: 'unknown', bound: false },
  { row: 7, badge: 'identity', record: 'any', agreement: 'DISAGREE', alerting: 'INDETERMINATE', blocking: 'INDETERMINATE', attribution: 'unknown', bound: false },
  { row: 8, badge: 'unreadable', record: 'any', agreement: 'UNREADABLE', alerting: 'INDETERMINATE', blocking: 'INDETERMINATE', attribution: 'unknown', bound: false },
  { row: 'R', badge: 'not-read', record: 'refused', agreement: 'UNCORROBORATED', alerting: 'INDETERMINATE', blocking: 'INDETERMINATE', attribution: 'unknown', bound: false },
];

/**
 * The guard → class table — DATA (OPS-XREPO-CI-CANARY-DARK-W2 R1.6, ruling Q2). TOTAL over every string
 * that can reach a record's `reason`: tests/unit/gh-run-conclusion.test.ts enumerates those strings from
 * this file's own syntax tree (templated families expanded by rule) and fails on any it cannot classify.
 * `bound` is never rendered. `ref_page_<g>` takes the class of <g> unless listed exactly.
 * `badge_unreadable` and `record_unavailable` are bind()'s defensive fallbacks — unreachable today
 * (parseBadge and evaluatePage always name a reason), classified so the table stays total.
 */
export const GUARD_CLASSES = ['badge', 'disagree', 'shape', 'identity', 'vocabulary', 'transport', 'monotonic', 'ref', 'input', 'empty', 'pending', 'bound'];
export const GUARD_CLASS = {
  exact: {
    page_shape_unknown: 'shape', page_shape_ambiguous: 'shape', page_shape_unparseable: 'shape', vacuity_badge_has_run: 'shape',
    record_unavailable: 'shape',
    content_type: 'transport',
    icon_unmeasured: 'vocabulary',
    row_identity_unreadable: 'identity',
    monotonic: 'monotonic',
    ref_missing: 'ref', ref_unparseable: 'ref', ref_out_of_vocabulary: 'ref', ref_page_behind: 'ref', ref_page_unavailable: 'ref',
    atom_trap: 'input', non_canonical_repo: 'input', non_canonical_workflow: 'input', non_canonical_branch: 'input', non_canonical_url: 'input', branch_undeclared: 'input',
    vacuity: 'empty',
    no_terminal_row: 'pending',
    badge_unparseable: 'badge', badge_no_status: 'badge', badge_unknown_state: 'badge', badge_unreadable: 'badge',
    badge_failing_record_success: 'disagree', identity_mismatch: 'disagree',
    agree_success: 'bound', agree_failure: 'bound', badge_passing_record_failure: 'bound',
  },
  // A templated family: `${prefix}${tail}`, the tail checked by `tail` (never a bare prefix match).
  families: [
    { prefix: 'http_', tail: /^[A-Za-z0-9]+$/, cls: 'transport' },
    { prefix: 'badge_http_', tail: /^[A-Za-z0-9]+$/, cls: 'badge' },
    { prefix: 'state_unmeasured:', tail: /^[A-Za-z0-9_]+\/[A-Za-z0-9_]+$/, cls: 'vocabulary' },
    { prefix: 'terminal_unbound:', tail: /^[a-z_]+$/, cls: 'vocabulary' },
  ],
  composite: 'ref_page_',
};

/** A reason → its class, or 'unclassified'. Pure; the ONE derivation the canary reads (via --guard-class). */
export function guardClass(reason) {
  if (typeof reason !== 'string' || reason === '') return 'unclassified';
  if (Object.prototype.hasOwnProperty.call(GUARD_CLASS.exact, reason)) return GUARD_CLASS.exact[reason];
  for (const f of GUARD_CLASS.families) if (reason.startsWith(f.prefix) && f.tail.test(reason.slice(f.prefix.length))) return f.cls;
  if (reason.startsWith(GUARD_CLASS.composite)) return guardClass(reason.slice(GUARD_CLASS.composite.length));
  return 'unclassified';
}

/** Recover precedence among non-AGREE samples: the most informative wins, the latest among equals. */
const INFORMATIVENESS = { DISAGREE: 3, UNCORROBORATED: 2, UNREADABLE: 1 };

// ───────────────────────────── pure helpers ─────────────────────────────

const decodeEntities = (s) => String(s)
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&');

/** The canary's fixture mangling, byte for byte: `printf '%s' "$url" | tr -c 'A-Za-z0-9' '_'`. */
export function mangle(url) {
  const out = Buffer.from(String(url), 'utf8');
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    const alnum = (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
    if (!alnum) out[i] = 0x5f;
  }
  return out.toString('latin1');
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKFLOW_RE = /^[A-Za-z0-9_.-]+\.ya?ml$/;
const BRANCH_RE = /^[A-Za-z0-9_./-]+$/;
/**
 * A RESOLVED ref (ruling Q9, 2026-10-04) — the measured vocabulary only. The badge takes the SHORT ref
 * name (`?branch=v1.31.1` → #29; `?branch=refs/tags/v1.31.1` → "no status"), and a ref carrying a
 * slash was never measured, so it is refused rather than guessed (Cowork, Mac, 2026-10-04 ~12:30Z).
 */
const REF_RE = /^[A-Za-z0-9._-]+$/;

/** Refuse anything that would not produce a canonical URL — BEFORE any fetch. Reason code or null. */
export function inputDefect({ repo, workflow, branch }) {
  if (typeof workflow === 'string' && /\.atom$/i.test(workflow)) return 'atom_trap';
  if (typeof repo !== 'string' || !REPO_RE.test(repo)) return 'non_canonical_repo';
  if (typeof workflow !== 'string' || !WORKFLOW_RE.test(workflow)) return 'non_canonical_workflow';
  if (branch !== null && (typeof branch !== 'string' || !BRANCH_RE.test(branch) || branch.includes('..'))) return 'non_canonical_branch';
  return null;
}

export function badgeUrl({ repo, workflow, branch }, host = DEFAULT_HOST) {
  const base = `${host}/${repo}/actions/workflows/${workflow}/badge.svg`;
  return branch === null ? base : `${base}?branch=${branch}`;
}

/** The canonical actions_url() form — the only page URL this module will ever read. */
export function actionsUrl({ repo, workflow, branch }, host = DEFAULT_HOST) {
  const base = `${host}/${repo}/actions/workflows/${workflow}`;
  return branch === null ? base : `${base}?query=branch%3A${branch}`;
}

/** True only for the canonical page form; the `.atom` trap answers 200 text/html and parses to nothing. */
export function isCanonicalActionsUrl(url, host = DEFAULT_HOST) {
  const esc = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${esc}/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/actions/workflows/[A-Za-z0-9_.-]+\\.ya?ml(\\?query=branch%3A[A-Za-z0-9_./-]+)?$`);
  return typeof url === 'string' && !/\.atom(\?|$)/i.test(url) && re.test(url);
}

/** The cache-buster value for one read, and the URL that carries it. Unique per read. */
export const busterValue = (epochS, readNo) => `${epochS}-${readNo}`;
export function bust(url, epochS, readNo) {
  return `${url}${url.includes('?') ? '&' : '?'}${CACHE_BUSTER.param}=${busterValue(epochS, readNo)}`;
}

// ── legacy-compatible parsers (the canary's bash shims delegate here, byte-identical) ──

/** parse_badge_status: last `<title>` (greedy, as sed), the segment after the LAST " - ". */
export function legacyParseBadgeStatus(svg) {
  const flat = String(svg ?? '').replace(/\n/g, ' ');
  const m = /^.*<title>([^<]*)<\/title>.*$/s.exec(flat);
  if (!m || m[1] === '') return null;
  const t = m[1];
  const i = t.lastIndexOf(' - ');
  if (i < 0) return null;
  return t.slice(i + 3);
}

/** classify_status: MEASURED vocabulary only. */
export function legacyClassifyStatus(token) {
  if (token === 'passing') return 'PASS';
  if (token === 'failing') return 'FAIL';
  return 'INDETERMINATE';
}

const POSIX_SPACE = '[ \\t\\n\\v\\f\\r]';
/**
 * parse_runs_page: the NEWEST row's "<run_number>|<run_id>|<iso-start>", else null.
 * OPS-XREPO-CI-CANARY-DARK-W2 R1.5: a React-only page yields the same string from its newest run; a page
 * carrying BOTH shapes refuses; every other page takes the pre-React code below, unchanged byte for byte.
 */
export function legacyParseRunsPage(html) {
  const shapes = pageShapes(html);
  if (shapes.length > 1) return null;
  if (shapes[0] === 'react_embedded_v1') {
    const { route, guard } = reactRoute(html);
    const run = guard ? null : (route.workflowRuns ?? [])[0];
    if (!run || typeof run !== 'object') return null;
    const iso = run.createdAt !== null && typeof run.createdAt === 'object' ? run.createdAt.timestamp : null;
    if (typeof run.id !== 'string' || !/^\d+$/.test(run.id) || !Number.isInteger(run.runNumber) || typeof iso !== 'string' || iso === '') return null;
    return `${run.runNumber}|${run.id}|${iso}`;
  }
  const flat = String(html ?? '').replace(/\n/g, ' ');
  const parts = flat.split('id="check_suite_');
  if (parts.length < 2) return null;
  const row = parts[1];
  const id = (/\/actions\/runs\/([0-9]+)/.exec(row) || [])[1];
  const numM = new RegExp(`Run${POSIX_SPACE}+([0-9]+)${POSIX_SPACE}+of`).exec(row);
  const isoM = /<relative-time[^>]*datetime="[^"]+"/.exec(row);
  const iso = isoM ? isoM[0].replace(/^.*datetime="/, '').replace(/"$/, '') : '';
  if (!id || !numM || !iso) return null;
  return `${numM[1]}|${id}|${iso}`;
}

// ── the structured parsers the bound record uses ──

/** Badge → { title, name, status, state }. state ∈ passing | failing | null (unreadable). */
export function parseBadge(svg) {
  const status = legacyParseBadgeStatus(svg);
  const flat = String(svg ?? '').replace(/\n/g, ' ');
  const m = /^.*<title>([^<]*)<\/title>.*$/s.exec(flat);
  const title = m ? m[1] : null;
  if (status === null) return { title, name: null, status: null, state: null, reason: 'badge_unparseable' };
  const name = decodeEntities(title.slice(0, title.lastIndexOf(' - '))).trim();
  if (status === 'passing' || status === 'failing') return { title, name, status, state: status, reason: null };
  return { title, name, status, state: null, reason: status === 'no status' ? 'badge_no_status' : 'badge_unknown_state' };
}

/** Icon class attribute → the vocabulary entry, or null (UNMEASURED; also when ambiguous). */
export function classifyIcon(classAttr) {
  if (typeof classAttr !== 'string' || classAttr.trim() === '') return null;
  const tokens = new Set(classAttr.trim().split(/\s+/));
  const hits = ICON_VOCAB.filter((e) => e.tokens.every((t) => tokens.has(t)));
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Page → rows, newest first, each keyed off ITS OWN row (never page-global):
 *   { run_id, run_number, name, aria_run_number, started_at, icon_class, state, cls }
 * Every field that decides anything is STRUCTURED: the run id from the anchor href, the status
 * from the anchor-scoped svg, the name AND the run number from the exact-class `text-bold` span and
 * the `#N:` that follows it (R0.7: 112/112 rows). The aria-label's `Run N of` is PROSE: it is kept
 * as forensics (`aria_run_number`) and decides nothing.
 */
export function parsePage(html) {
  // Comments are not markup: a commented-out `id="check_suite_…"` would otherwise mint a phantom
  // row ahead of the real newest one (found by the real-fixture tests, which carry header comments).
  const parts = String(html ?? '').replace(/<!--[\s\S]*?-->/g, '').split('id="check_suite_').slice(1);
  return parts.map((chunk) => {
    const a = /<a\b[^>]*\bhref="\/[^"/]+\/[^"/]+\/actions\/runs\/(\d+)"[^>]*>([\s\S]*?)<\/a>/.exec(chunk);
    const runId = a ? a[1] : null;
    const svg = a ? /<svg\b[^>]*>/.exec(a[2]) : null;
    const iconClass = svg ? ((/\bclass="([^"]*)"/.exec(svg[0]) || [])[1] ?? null) : null;
    const entry = classifyIcon(iconClass);
    const aria = new RegExp(`Run${POSIX_SPACE}+([0-9]+)${POSIX_SPACE}+of`).exec(chunk);
    const nameM = /<span class="text-bold"\s*>([^<]*)<\/span>(\s*#(\d+):)?/.exec(chunk);
    const iso = /<relative-time[^>]*\bdatetime="([^"]+)"/.exec(chunk);
    return {
      run_id: runId,
      run_number: nameM && nameM[3] ? Number(nameM[3]) : null,
      name: nameM ? decodeEntities(nameM[1]).trim() : null,
      aria_run_number: aria ? Number(aria[1]) : null,
      started_at: iso ? iso[1] : null,
      icon_class: iconClass,
      state: entry ? entry.state : 'unmeasured',
      cls: entry ? entry.cls : 'unmeasured',
    };
  });
}

const publicRow = (r) => (r ? { run_id: r.run_id, run_number: r.run_number, name: r.name, started_at: r.started_at, state: r.state } : null);

// ── page shapes (OPS-XREPO-CI-CANARY-DARK-W2) ──

const stripComments = (html) => String(html ?? '').replace(/<!--[\s\S]*?-->/g, '');

/** The ids of every PAGE_SHAPES entry this markup carries the marker of (0, 1 or more). */
export function pageShapes(html) {
  const raw = String(html ?? '');
  const stripped = stripComments(raw);
  return PAGE_SHAPES.filter((s) => (s.comments_stripped ? stripped : raw).includes(s.marker)).map((s) => s.id);
}

/** One (status, conclusion) → its STATE_VOCAB entry, or null (UNMEASURED; also when ambiguous). */
export function classifyState(state) {
  const st = state !== null && typeof state === 'object' ? state : {};
  const absent = st.conclusion === undefined || st.conclusion === null;
  const hits = STATE_VOCAB.filter((e) => e.status === st.status && (e.conclusion === null ? absent : e.conclusion === st.conclusion));
  return hits.length === 1 ? hits[0] : null;
}

/** A vendor token rendered inside a guard: [A-Za-z0-9_] only, bounded, `none` when absent. */
const stateToken = (v) => (v === undefined || v === null ? 'none' : String(v).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 64) || 'none');

/**
 * The React page's ONE workflowRunsRoute, or the shape guard that refuses it. Every embeddedData script is
 * read; exactly one may carry the route (two → ambiguous, none → unparseable).
 */
function reactRoute(html) {
  const re = new RegExp(`${PAGE_SHAPES.find((s) => s.id === 'react_embedded_v1').marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\s\\S]*?)</script>`, 'g');
  const routes = [];
  for (const m of String(html ?? '').matchAll(re)) {
    let data;
    try { data = JSON.parse(m[1]); } catch { continue; }
    const route = data !== null && typeof data === 'object' && data.payload !== null && typeof data.payload === 'object' ? data.payload.workflowRunsRoute : undefined;
    if (route !== null && typeof route === 'object' && !Array.isArray(route)) routes.push(route);
  }
  if (routes.length > 1) return { route: null, guard: 'page_shape_ambiguous' };
  if (routes.length === 0) return { route: null, guard: 'page_shape_unparseable' };
  const route = routes[0];
  if (route.workflowRuns !== undefined && !Array.isArray(route.workflowRuns)) return { route: null, guard: 'page_shape_unparseable' };
  // Ruling Q1 (i): an empty list OMITS workflowRuns (measured) — but a page that ALSO says runs exist is
  // contradicting itself (a renamed key, a lazy-loaded list) and is never read as "GitHub lists no runs".
  // Measured empty pages carry no totalCount at all; any present value other than 0 is that contradiction.
  const runs = route.workflowRuns ?? [];
  if (runs.length === 0 && 'totalCount' in route && route.totalCount !== 0) return { route: null, guard: 'page_shape_unparseable' };
  return { route, guard: null };
}

/**
 * One React run → the SAME row object parsePage returns. Identity fails CLOSED (R1.2): unless the run's
 * own fields name THIS repo's run of THIS workflow, it carries no run id, number, name or start, so it can
 * never bind (row_identity_unreadable) and never feeds the monotonic floor or Leg B's recency.
 */
function reactRow(run, { repo = null, workflow = null } = {}) {
  const r = run !== null && typeof run === 'object' ? run : {};
  const entry = classifyState(r.state);
  const id = r.id;
  const identity = typeof id === 'string' && /^\d+$/.test(id)
    && Number.isInteger(r.runNumber)
    && typeof r.workflowName === 'string' && r.workflowName.trim() !== ''
    && typeof workflow === 'string' && r.workflowFilePath === `.github/workflows/${workflow}`
    && typeof repo === 'string' && typeof r.runUrl === 'string' && r.runUrl.endsWith(`/${repo}/actions/runs/${id}`);
  const started = r.createdAt !== null && typeof r.createdAt === 'object' && typeof r.createdAt.timestamp === 'string' && r.createdAt.timestamp !== '' ? r.createdAt.timestamp : null;
  const st = r.state !== null && typeof r.state === 'object' ? r.state : {};
  return {
    run_id: identity ? id : null,
    run_number: identity ? r.runNumber : null,
    name: identity ? r.workflowName.trim() : null,
    aria_run_number: null,
    started_at: identity ? started : null,
    icon_class: null,
    state: entry ? entry.state : 'unmeasured',
    cls: entry ? entry.cls : 'unmeasured',
    ...(entry ? {} : { unmeasured_reason: `state_unmeasured:${stateToken(st.status)}/${stateToken(st.conclusion)}` }),
  };
}

/** React page → { guard, rows } (newest first, as served). */
export function parseReactPage(html, ctx = {}) {
  const { route, guard } = reactRoute(html);
  if (guard) return { guard, rows: [] };
  return { guard: null, rows: (route.workflowRuns ?? []).map((run) => reactRow(run, ctx)) };
}

/** Exactly one reader per PAGE_SHAPES id (the self-test pins the pairing). */
const SHAPE_READERS = {
  legacy_check_suite_v1: (html) => ({ guard: null, rows: parsePage(html) }),
  react_embedded_v1: (html, ctx) => parseReactPage(html, ctx),
};
export const SHAPE_READER_IDS = Object.keys(SHAPE_READERS);

/**
 * Any page → { shape, guard, rows }, routed through EXACTLY ONE shape. ctx = { repo, workflow }: the
 * React identity check needs them; the legacy reader never reads them, so a legacy read is unchanged.
 */
export function readPage(html, ctx = {}) {
  const hits = pageShapes(html);
  if (hits.length === 0) return { shape: null, guard: 'page_shape_unknown', rows: [] };
  if (hits.length > 1) return { shape: null, guard: 'page_shape_ambiguous', rows: [] };
  return { shape: hits[0], ...SHAPE_READERS[hits[0]](html, ctx) };
}

/** R1.4: the React run's ref is `branch.title`, and its two renders (name, title) must agree. */
function reactRefOfRun(html, runId) {
  const { route, guard } = reactRoute(html);
  if (guard) return { ref: null, reason: 'ref_missing' };
  const run = (route.workflowRuns ?? []).find((r) => r !== null && typeof r === 'object' && r.id === String(runId));
  if (!run || run.branch === null || run.branch === undefined) return { ref: null, reason: 'ref_missing' };
  const b = typeof run.branch === 'object' ? run.branch : {};
  const t = typeof b.title === 'string' ? b.title.trim() : '';
  if (!t || (b.name !== `refs/heads/${t}` && b.name !== `refs/tags/${t}`)) return { ref: null, reason: 'ref_unparseable' };
  if (!REF_RE.test(t) || t.includes('..')) return { ref: null, reason: 'ref_out_of_vocabulary' };
  return { ref: t, reason: null };
}

/**
 * The ref a run row was run on — ruling Q9. Read from the row's own `branch-name` element(s): the
 * `title` attribute is the SHORT ref name (`main`, `v1.31.1`), a structured field, never prose. A row
 * renders it twice (desktop + mobile); they must agree. Returns { ref } or { ref: null, reason }:
 *   ref_missing (no branch-name element in that run's row) · ref_unparseable (no title, or the
 *   renders disagree) · ref_out_of_vocabulary (outside [A-Za-z0-9._-] — a slash-ref is unmeasured).
 * Kept OUT of parsePage on purpose: a named-branch read never calls it, so its output is unchanged.
 */
export function refOfRun(html, runId) {
  const shapes = pageShapes(html);
  if (shapes.length === 1 && shapes[0] === 'react_embedded_v1') return reactRefOfRun(html, runId);
  const parts = String(html ?? '').replace(/<!--[\s\S]*?-->/g, '').split('id="check_suite_').slice(1);
  const chunk = parts.find((c) => {
    const a = /<a\b[^>]*\bhref="\/[^"/]+\/[^"/]+\/actions\/runs\/(\d+)"/.exec(c);
    return a && a[1] === String(runId);
  });
  if (!chunk) return { ref: null, reason: 'ref_missing' };
  const tags = chunk.match(/<a\b[^>]*\bclass="[^"]*\bbranch-name\b[^"]*"[^>]*>/g) ?? [];
  if (tags.length === 0) return { ref: null, reason: 'ref_missing' };
  // `title` exactly — never `data-title` / `aria-title` (\b would match after a '-').
  const titles = tags.map((t) => { const m = /\stitle="([^"]*)"/.exec(t); return m ? decodeEntities(m[1]).trim() : null; });
  if (titles.some((t) => !t) || new Set(titles).size !== 1) return { ref: null, reason: 'ref_unparseable' };
  const ref = titles[0];
  if (!REF_RE.test(ref) || ref.includes('..')) return { ref: null, reason: 'ref_out_of_vocabulary' };
  return { ref, reason: null };
}

/**
 * The terminal walk. Newest-first; SKIP a measured non-terminal row; STOP at an unmeasured or
 * unbound one (it may be the newest failure, so it is never guessed past).
 */
export function newestTerminal(rows) {
  for (const r of rows) {
    if (r.cls === 'nonterminal') continue;
    if (r.cls === 'success' || r.cls === 'failure') return { row: r, reason: null };
    if (r.cls === 'unbound') return { row: null, reason: `terminal_unbound:${r.state}` };
    // A React row names WHICH (status, conclusion) went unmeasured; a legacy row carries no such field.
    return { row: null, reason: r.unmeasured_reason ?? 'icon_unmeasured' };
  }
  return { row: null, reason: 'no_terminal_row' };
}

/**
 * One page read → { http, content_type, bytes, rows_parsed, guard, newest, newest_terminal, terminal }.
 * ctx { repo, workflow } feeds the React identity check (OPS-XREPO-CI-CANARY-DARK-W2); a legacy page never reads it.
 */
export function evaluatePage({ http, body, contentType }, { minRunId = null, repo = null, workflow = null } = {}) {
  const page = { http, content_type: contentType ?? null, bytes: body ? Buffer.byteLength(body) : 0, rows_parsed: 0, guard: null, newest: null, newest_terminal: null, terminal: null };
  if (http !== 200) { page.guard = `http_${http ?? 'none'}`; return page; }
  if (!/html/i.test(contentType ?? '')) { page.guard = 'content_type'; return page; }
  const read = readPage(body, { repo, workflow });
  const rows = read.rows;
  page.rows_parsed = rows.length;
  if (read.guard) { page.guard = read.guard; return page; }
  // A known shape listing zero runs: since ruling Q1 this MEANS "GitHub lists no runs" (class `empty`).
  if (rows.length === 0) { page.guard = 'vacuity'; return page; }
  page.newest = publicRow(rows[0]);
  if (minRunId !== null && rows[0].run_id !== null && BigInt(rows[0].run_id) < BigInt(minRunId)) { page.guard = 'monotonic'; return page; }
  const walk = newestTerminal(rows);
  if (!walk.row) { page.guard = walk.reason; return page; }
  const t = walk.row;
  // Fail CLOSED on identity: a row that cannot say which run it is, by its STRUCTURED fields, never binds.
  if (!t.run_id || !t.name || t.run_number === null) { page.guard = 'row_identity_unreadable'; return page; }
  page.newest_terminal = publicRow(t);
  page.terminal = t;
  return page;
}

/**
 * Bind one badge read + one page read into a table row. Pure.
 * Identity is checked against ANY readable row name, not only a bound one: one workflow page carries
 * one workflow name, so a badge for a different workflow is row 7 even when the walk stopped — it
 * must never reach row 5 and page a badge-only RED for the wrong workflow.
 */
export function bind(badge, page) {
  let tableRow;
  let reason;
  const rowName = page.terminal?.name ?? page.newest?.name ?? null;
  if (badge.state === null) {
    tableRow = 8; reason = badge.reason ?? 'badge_unreadable';
  } else if (rowName !== null && rowName !== badge.name) {
    tableRow = 7; reason = 'identity_mismatch';
  } else if (!page.terminal) {
    tableRow = badge.state === 'failing' ? 5 : 6; reason = page.guard ?? 'record_unavailable';
  } else {
    const rec = page.terminal.cls; // success | failure
    if (badge.state === 'passing' && rec === 'success') { tableRow = 1; reason = 'agree_success'; }
    else if (badge.state === 'failing' && rec === 'failure') { tableRow = 2; reason = 'agree_failure'; }
    else if (badge.state === 'failing' && rec === 'success') { tableRow = 3; reason = 'badge_failing_record_success'; }
    else { tableRow = 4; reason = 'badge_passing_record_failure'; }
  }
  const spec = BIND_TABLE.find((r) => r.row === tableRow);
  return { row: tableRow, agreement: spec.agreement, reason, bound: spec.bound };
}

/** The ONE projection: record × class → the class verdict, straight from the table. */
export function verdictFor(record, cls) {
  if (!CLASSES.includes(cls)) throw new Error(`unknown class ${cls}`);
  const spec = BIND_TABLE.find((r) => r.row === record.row);
  if (!spec) return cls === 'attribution' ? 'unknown' : 'INDETERMINATE';
  return spec[cls];
}

/** Class verdict → the token vocabulary. */
export function tokenFor(record, cls) {
  const v = verdictFor(record, cls);
  if (cls !== 'attribution') return v;
  return v === 'passing' ? 'PASS' : v === 'failing' ? 'FAIL' : 'INDETERMINATE';
}

export function resolveConfig(env = process.env) {
  const int = (v, d) => (v !== undefined && /^\d+$/.test(String(v)) ? Number(v) : d);
  return {
    reads: Math.max(1, int(env.GHRC_READS, RECOVER_DEFAULTS.reads)),
    spacingS: int(env.GHRC_SPACING_S, RECOVER_DEFAULTS.spacingS),
  };
}

/** The derived-span law: (reads − 1) × spacing must exceed the measured episode envelope. */
export function spanCoversEnvelope({ reads, spacingS }) {
  return (reads - 1) * spacingS > EPISODE_ENVELOPE.seconds;
}

// ───────────────────────────── the fetch seam ─────────────────────────────

const DEFAULT_CT = { svg: 'image/svg+xml', html: 'text/html; charset=utf-8' };

/**
 * Fixture transport: the canary's layout, plus `.<ext>.N` for Recover read N ≥ 2. Read N uses the
 * highest `.k` ≤ N that exists (k = 1 is the bare file), so a declared sequence's LAST step repeats —
 * the same semantics as memoryFetch, so one sequence reads identically through both seams.
 */
export function fixtureFetch(dir) {
  return (canonicalUrl, ext, readNo) => {
    const base = path.join(dir, mangle(canonicalUrl));
    const pick = (suffix) => {
      for (let k = readNo; k >= 2; k--) if (existsSync(`${base}.${suffix}.${k}`)) return `${base}.${suffix}.${k}`;
      return `${base}.${suffix}`;
    };
    const bodyPath = pick(ext);
    if (!existsSync(bodyPath)) return { http: 404, body: '', contentType: DEFAULT_CT[ext], date: null };
    const codePath = pick('code');
    const ctPath = pick('ct');
    const http = existsSync(codePath) ? Number(readFileSync(codePath, 'utf8').trim()) : 200;
    const contentType = existsSync(ctPath) ? readFileSync(ctPath, 'utf8').trim() : DEFAULT_CT[ext];
    return { http, body: readFileSync(bodyPath, 'utf8'), contentType, date: null };
  };
}

/**
 * Live transport: curl — the transport proven on signal-1 (R0.6). Never throws. It fetches the URL
 * the read hands it (`fetchUrl`, which carries the cache-buster); the fixture and in-memory seams key
 * on the CANONICAL URL instead, so a buster can never change which fixture a test reads.
 */
export function curlFetch() {
  return (canonicalUrl, _ext, _readNo, fetchUrl) => {
    const url = fetchUrl ?? canonicalUrl;
    let dir = null;
    try {
      dir = mkdtempSync(path.join(tmpdir(), 'ghrc-'));
      const bodyFile = path.join(dir, 'body');
      const hdr = execFileSync('curl', ['-sS', '--max-time', '25', '-D', '-', '-o', bodyFile, '-w', '\n@@HTTP@@%{http_code}', url],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const http = Number((/@@HTTP@@(\d+)\s*$/.exec(hdr) || [])[1] ?? 0);
      const headers = hdr.split(/\r?\n/);
      const h = (name) => {
        const line = [...headers].reverse().find((l) => l.toLowerCase().startsWith(`${name}:`));
        return line ? line.slice(name.length + 1).trim() : null;
      };
      const body = existsSync(bodyFile) ? readFileSync(bodyFile, 'utf8') : '';
      return { http, body, contentType: h('content-type'), date: h('date') };
    } catch (e) {
      return { http: 0, body: '', contentType: null, date: null, error: String(e && e.message).split('\n')[0] };
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  };
}

function defaultFetch(env = process.env) {
  const dir = env.GHRC_FIXTURE_DIR || env.XREPO_CI_FIXTURE_DIR;
  return dir ? fixtureFetch(dir) : curlFetch();
}

/** Synchronous sleep for the live path; tests inject a no-op. */
function sleepSync(seconds) {
  if (seconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

// ───────────────────────────── the read ─────────────────────────────

/**
 * Read both instruments, bind, Recover. Returns the record. Never throws on a GitHub failure.
 * input: { repo, workflow, branch (null = any ref), minRunId?, cls }
 * opts:  { fetchDoc, sleep, reads, spacingS, host, nowIso, nowEpoch, cacheBuster }
 * fetchDoc(canonicalUrl, ext, readNo, fetchUrl): the transport fetches `fetchUrl` (the buster rides
 * on it); fixture and in-memory transports key on `canonicalUrl`.
 */
export function readConclusion(input, opts = {}) {
  const cfg = { ...resolveConfig(opts.env ?? process.env), ...(opts.reads ? { reads: opts.reads } : {}), ...(opts.spacingS !== undefined ? { spacingS: opts.spacingS } : {}) };
  const envSrc = opts.env ?? process.env;
  const host = opts.host ?? (envSrc.GHRC_BADGE_HOST || envSrc.XREPO_CI_BADGE_HOST || DEFAULT_HOST);
  const fetchDoc = opts.fetchDoc ?? defaultFetch(opts.env ?? process.env);
  const sleep = opts.sleep ?? sleepSync;
  const nowIso = opts.nowIso ?? (() => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));
  const branch = input.branch === undefined ? undefined : input.branch;
  const base = {
    schema: SCHEMA, repo: input.repo ?? null, workflow: input.workflow ?? null, branch: branch === undefined ? null : branch,
    class: input.cls ?? null,
    config: { reads: cfg.reads, spacing_s: cfg.spacingS, episode_envelope_s: EPISODE_ENVELOPE.seconds, cache_buster: CACHE_BUSTER.enabled },
  };

  const defect = branch === undefined ? 'branch_undeclared' : inputDefect({ repo: input.repo, workflow: input.workflow, branch });
  if (defect) {
    return finalize({ ...base, badge_url: null, actions_url: null, badge: { http: null, title: null, name: null, state: null }, page: { http: null, content_type: null, bytes: 0, rows_parsed: 0, guard: defect, newest: null, newest_terminal: null }, row: 'R', agreement: 'UNCORROBORATED', reason: defect, reads: 0, samples: [] }, null);
  }
  const bUrl = badgeUrl({ ...input, branch }, host);
  const pUrl = actionsUrl({ ...input, branch }, host);
  if (!isCanonicalActionsUrl(pUrl, host)) {
    return finalize({ ...base, badge_url: bUrl, actions_url: pUrl, badge: { http: null, title: null, name: null, state: null }, page: { http: null, content_type: null, bytes: 0, rows_parsed: 0, guard: 'non_canonical_url', newest: null, newest_terminal: null }, row: 'R', agreement: 'UNCORROBORATED', reason: 'non_canonical_url', reads: 0, samples: [] }, null);
  }

  const samples = [];
  const cands = [];
  let best = null;
  // The monotonic floor RISES inside the window: a later read whose newest run is older than one this
  // window already saw is a stale page, never a fresher answer (it could otherwise AGREE on an older
  // run and launder a record-confirmed failure into PASS). One floor PER PAGE URL: an any-ref read
  // (ruling Q9) reads two pages, and the ref page's newest run is legitimately older than the any-ref
  // page's, so sharing one floor would trip `monotonic` on every resolved read.
  const floors = new Map([[pUrl, input.minRunId ?? null]]);
  const floorOf = (u) => (floors.has(u) ? floors.get(u) : null);
  const raise = (u, page) => {
    const f = floorOf(u);
    if (page.newest?.run_id && (f === null || BigInt(page.newest.run_id) > BigInt(f))) floors.set(u, page.newest.run_id);
  };
  const busterOn = opts.cacheBuster ?? CACHE_BUSTER.enabled;
  const nowEpoch = opts.nowEpoch ?? (() => Math.floor(Date.now() / 1000));
  const anyRef = branch === null;
  for (let readNo = 1; readNo <= cfg.reads; readNo++) {
    if (readNo > 1) sleep(cfg.spacingS);
    // One buster value per read, on EVERY document: every re-read is an independent render (ruling Q6).
    const epoch = nowEpoch();
    const cb = busterOn ? busterValue(epoch, readNo) : null;
    let readB = bUrl;
    let readP = pUrl;
    let resolution;
    if (anyRef) {
      // Ruling Q9: "any ref" is resolved on EVERY read, Recover re-reads included — (1) the any-ref
      // page's newest TERMINAL row, (2) its ref from the row's own branch-name element, (3) both
      // instruments re-read ON that ref and bound exactly as a named branch. Never a cross-run bind.
      const rr = fetchDoc(pUrl, 'html', readNo, cb ? bust(pUrl, epoch, readNo) : pUrl);
      const anyPage = evaluatePage({ http: rr.http, body: rr.body, contentType: rr.contentType }, { minRunId: floorOf(pUrl), repo: input.repo, workflow: input.workflow });
      raise(pUrl, anyPage);
      const src = anyPage.newest_terminal;
      const got = anyPage.terminal ? refOfRun(rr.body, anyPage.terminal.run_id) : { ref: null, reason: `ref_page_${anyPage.guard ?? 'unavailable'}` };
      resolution = { ref: got.ref, reason: got.reason, page_url: pUrl, http: rr.http, cb, date: rr.date ?? null, guard: anyPage.guard, run: src ? { run_id: src.run_id, run_number: src.run_number, state: src.state } : null };
      if (!got.ref) {
        // A ref that cannot be resolved binds NOTHING (never the any-ref badge, which reads the default
        // branch): UNCORROBORATED with a named reason — blocking INDETERMINATE, attribution unknown.
        const bound = { row: 'R', agreement: 'UNCORROBORATED', reason: got.reason, bound: false };
        const sample = {
          read: readNo, at: nowIso(), resolved_ref: null, ref_resolution: resolution,
          badge: { http: null, title: null, name: null, state: null, cb, date: null },
          page: { http: rr.http, content_type: anyPage.content_type, rows_parsed: anyPage.rows_parsed, guard: anyPage.guard, cb, date: rr.date ?? null, newest: anyPage.newest, newest_terminal: anyPage.newest_terminal },
          row: bound.row, agreement: bound.agreement, reason: bound.reason,
        };
        samples.push(sample);
        cands.push({ badge: { title: null, name: null, status: null, state: null }, page: { ...anyPage, terminal: null }, bound, sample, resolution, readB: null, readP: null });
        continue;
      }
      readB = badgeUrl({ ...input, branch: got.ref }, host);
      readP = actionsUrl({ ...input, branch: got.ref }, host);
    }
    const b = fetchDoc(readB, 'svg', readNo, cb ? bust(readB, epoch, readNo) : readB);
    const badge = b.http === 200 ? parseBadge(b.body) : { title: null, name: null, status: null, state: null, reason: `badge_http_${b.http}` };
    const pr = fetchDoc(readP, 'html', readNo, cb ? bust(readP, epoch, readNo) : readP);
    let page = evaluatePage({ http: pr.http, body: pr.body, contentType: pr.contentType }, { minRunId: floorOf(readP), repo: input.repo, workflow: input.workflow });
    raise(readP, page);
    // Ruling Q1 (ii): "GitHub lists no runs" while THIS read's badge names a conclusion is a contradiction —
    // the badge is the independent witness that a run exists, so the empty page is a shape defect.
    if (page.guard === 'vacuity' && (badge.state === 'passing' || badge.state === 'failing')) page = { ...page, guard: 'vacuity_badge_has_run' };
    // Any-ref: the ref page must show (at least) the run the ref was RESOLVED from. A ref page that lags behind
    // it (measured: a page keeps a finished run's in-progress icon ≥ 26 s after completion) would otherwise
    // bind an OLDER run on that ref and could AGREE past a failure this same read just saw → record unavailable.
    if (anyRef && page.terminal && resolution.run?.run_id && BigInt(page.terminal.run_id) < BigInt(resolution.run.run_id)) {
      page = { ...page, guard: 'ref_page_behind', terminal: null, newest_terminal: null };
    }
    const bound = bind(badge, page);
    const sample = {
      read: readNo, at: nowIso(),
      ...(anyRef ? { resolved_ref: resolution.ref, ref_resolution: resolution } : {}),
      badge: { http: b.http, title: badge.title, name: badge.name, state: badge.state, cb, date: b.date ?? null },
      page: { http: pr.http, content_type: page.content_type, rows_parsed: page.rows_parsed, guard: page.guard, cb, date: pr.date ?? null, newest: page.newest, newest_terminal: page.newest_terminal },
      row: bound.row, agreement: bound.agreement, reason: bound.reason,
    };
    samples.push(sample);
    const cand = { badge, page, bound, sample, resolution, readB, readP };
    cands.push(cand);
    if (bound.agreement === 'AGREE') { best = cand; break; }
  }
  best = best ?? selectSample(cands);

  const { badge, page, bound } = best;
  const record = {
    ...base,
    // An unresolved any-ref read never read a badge (badge_url null); the page it did read is the any-ref one.
    badge_url: anyRef ? best.readB : bUrl, actions_url: anyRef ? (best.readP ?? pUrl) : pUrl,
    // Any-ref only (ruling Q9): the ref both instruments were read on, and how it was resolved.
    // Absent on a named-branch record, so a named-branch read is byte-identical to before Q9.
    ...(anyRef ? { resolved_ref: best.resolution?.ref ?? null, ref_resolution: best.resolution ?? null } : {}),
    badge: { http: best.sample.badge.http, title: badge.title, name: badge.name, state: badge.state },
    page: { http: best.sample.page.http, content_type: page.content_type, bytes: page.bytes, rows_parsed: page.rows_parsed, guard: page.guard, newest: page.newest, newest_terminal: page.newest_terminal },
    row: bound.row, agreement: bound.agreement, reason: bound.reason, reads: samples.length, samples,
  };
  return finalize(record, bound.bound ? page.terminal : null, host);
}

/**
 * Recover's choice when no read AGREEd. Never discard run-record evidence read inside the window:
 *   1. the NEWEST terminal run read wins (a newer run outranks an older one, whatever its state);
 *   2. then the more informative agreement (DISAGREE > UNCORROBORATED > UNREADABLE);
 *   3. then a BOUND sample (row 4, record-confirmed) over an unbound one (rows 3 / 7);
 *   4. then the MAJORITY badge state among the window's readable badges (so one glitched badge read
 *      cannot decide a window whose page was unreadable throughout);
 *   5. then the latest read.
 */
export function selectSample(cands) {
  const states = cands.map((c) => c.badge.state).filter((s) => s !== null);
  const tally = states.reduce((m, s) => m.set(s, (m.get(s) ?? 0) + 1), new Map());
  const top = [...tally.entries()].sort((x, y) => y[1] - x[1]);
  const majority = top.length && (top.length === 1 || top[0][1] > top[1][1]) ? top[0][0] : null;
  const newestRun = (c) => {
    // Any-ref (Q9): the run the read RESOLVED from is newest-run evidence too, even when its ref page was
    // unreadable — a newer finished run seen anywhere in the window outranks an older one. Named-branch
    // samples carry no resolution, so their key is exactly the pre-Q9 one.
    const ids = [c.page.terminal?.run_id, c.resolution?.run?.run_id].filter(Boolean).map((x) => BigInt(x));
    return ids.length ? ids.reduce((a, b) => (b > a ? b : a)) : -1n;
  };
  const key = (c, i) => [
    newestRun(c),
    BigInt(INFORMATIVENESS[c.bound.agreement] ?? 0),
    c.bound.bound ? 1n : 0n,
    majority !== null && c.badge.state === majority ? 1n : 0n,
    BigInt(i),
  ];
  let best = 0;
  for (let i = 1; i < cands.length; i++) {
    const a = key(cands[i], i);
    const b = key(cands[best], best);
    for (let k = 0; k < a.length; k++) {
      if (a[k] > b[k]) { best = i; break; }
      if (a[k] < b[k]) break;
    }
  }
  return cands[best];
}

function finalize(record, terminal, host = DEFAULT_HOST) {
  const out = { ...record };
  if (terminal) {
    out.bound_run = {
      run_id: terminal.run_id, run_number: terminal.run_number, name: terminal.name, started_at: terminal.started_at, state: terminal.state,
      url: `${host}/${record.repo}/actions/runs/${terminal.run_id}`,
    };
  }
  out.verdicts = Object.fromEntries(CLASSES.map((c) => [c, verdictFor(out, c)]));
  return out;
}

// ───────────────────────────── CLI ─────────────────────────────

const oneLine = (v) => (v === null || v === undefined ? '' : String(v)).replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');

/** The flat GHRC_* lines a bash consumer reads with sed, never eval. Order is part of the contract. */
export function renderLines(record, cls) {
  const n = record.page?.newest ?? {};
  const t = record.page?.newest_terminal ?? {};
  const b = record.bound_run ?? {};
  const fields = [
    ['REPO', record.repo], ['WORKFLOW', record.workflow], ['BRANCH', record.branch === null ? '*' : record.branch],
    // Any-ref records only (ruling Q9) — a named-branch read prints exactly the pre-Q9 lines.
    ...('resolved_ref' in record ? [['RESOLVED_REF', record.resolved_ref], ['REF_REASON', record.ref_resolution?.reason]] : []),
    ['CLASS', cls],
    ['ROW', record.row], ['AGREEMENT', record.agreement], ['REASON', record.reason], ['VERDICT', verdictFor(record, cls)], ['READS', record.reads],
    ['BADGE_URL', record.badge_url], ['ACTIONS_URL', record.actions_url],
    ['BADGE_HTTP', record.badge?.http], ['BADGE_TITLE', record.badge?.title], ['BADGE_NAME', record.badge?.name], ['BADGE_STATE', record.badge?.state],
    ['PAGE_HTTP', record.page?.http], ['PAGE_CONTENT_TYPE', record.page?.content_type], ['PAGE_ROWS', record.page?.rows_parsed], ['PAGE_GUARD', record.page?.guard], ['PAGE_BYTES', record.page?.bytes],
    ['NEWEST_RUN_ID', n.run_id], ['NEWEST_RUN_NUMBER', n.run_number], ['NEWEST_NAME', n.name], ['NEWEST_STARTED_AT', n.started_at], ['NEWEST_STATE', n.state],
    ['TERMINAL_RUN_ID', t.run_id], ['TERMINAL_RUN_NUMBER', t.run_number], ['TERMINAL_STATE', t.state],
    ['BOUND_RUN_ID', b.run_id], ['BOUND_RUN_NUMBER', b.run_number], ['BOUND_STATE', b.state], ['BOUND_STARTED_AT', b.started_at], ['BOUND_URL', b.url],
  ];
  const lines = fields.map(([k, v]) => `GHRC_${k}=${oneLine(v)}`);
  lines.push(`GHRC_RECORD=${JSON.stringify(record)}`);
  return lines;
}

function parseArgs(argv) {
  const a = { branch: undefined };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    // A value-taking flag with no value (end of argv, or another flag) is a usage error — never a
    // silently dropped guard (an unquoted empty `--min-run-id $LAST` would otherwise lose the floor).
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) { a.unknown = (a.unknown ?? []).concat(`${k} <missing value>`); return undefined; }
      i += 1;
      return v;
    };
    if (k === '--repo') a.repo = next();
    else if (k === '--workflow') a.workflow = next();
    else if (k === '--branch') a.branch = next();
    else if (k === '--any-ref') a.branch = null;
    else if (k === '--min-run-id') a.minRunId = next();
    else if (k === '--class') a.cls = next();
    else a.unknown = (a.unknown ?? []).concat(k);
  }
  return a;
}

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

export function runCli(argv, { stdout = (s) => process.stdout.write(s), stdin = readStdin, readOpts = {} } = {}) {
  const say = (s) => stdout(`${s}\n`);
  if (argv[0] === '--parse-badge') { const v = legacyParseBadgeStatus(stdin()); if (v === null) return 1; stdout(v); return 0; }
  if (argv[0] === '--classify-status') { say(legacyClassifyStatus(argv[1] ?? '')); return 0; }
  if (argv[0] === '--parse-page') { const v = legacyParseRunsPage(stdin()); if (v === null) return 1; stdout(v); return 0; }
  // OPS-XREPO-CI-CANARY-DARK-W2 R1.6: the canary's ONLY source of guard classes.
  if (argv[0] === '--guard-class') { const c = guardClass(argv[1] ?? ''); say(c); return c === 'unclassified' ? EXIT.INDETERMINATE : 0; }
  const a = parseArgs(argv);
  if (!CLASSES.includes(a.cls) || a.unknown || (a.minRunId !== undefined && !/^\d+$/.test(a.minRunId))) {
    say(`  usage: --repo R --workflow W (--branch B | --any-ref) [--min-run-id N] --class ${CLASSES.join('|')}`);
    say(`${TOKEN}=INDETERMINATE`);
    return EXIT.INDETERMINATE;
  }
  const record = readConclusion({ repo: a.repo, workflow: a.workflow, branch: a.branch, minRunId: a.minRunId ?? null, cls: a.cls }, readOpts);
  for (const l of renderLines(record, a.cls)) say(l);
  const tok = tokenFor(record, a.cls);
  say(`${TOKEN}=${tok}`);
  return EXIT[tok];
}

// ───────────────────────────── self-test ─────────────────────────────

/** Real markup, trimmed (captured 2026-10-03; scrubbed). Each row is the shape GitHub renders. */
const SVG_TAG = {
  success: '<svg data-component="Octicon" width="16" height="16" style="margin-top: 2px" class="octicon octicon-check-circle-fill color-fg-success" aria-label="completed successfully: " viewBox="0 0 16 16" version="1.1" role="img">',
  failure: '<svg data-component="Octicon" width="16" height="16" style="margin-top: 2px" class="octicon octicon-x-circle-fill color-fg-danger" aria-label="failed: " viewBox="0 0 16 16" version="1.1" role="img">',
  cancelled: '<svg data-component="Octicon" width="16" height="16" style="margin-top: 2px" class="octicon octicon-stop neutral-check" aria-label="cancelled: " viewBox="0 0 16 16" version="1.1" role="img">',
  skipped: '<svg data-component="Octicon" width="16" height="16" style="margin-top: 2px" class="octicon octicon-skip neutral-check" aria-label="skipped: " viewBox="0 0 16 16" version="1.1" role="img">',
  action_required: '<svg data-component="Octicon" width="16" height="16" style="margin-top: 2px" class="octicon octicon-alert color-fg-attention" aria-label="requires action with the application: " viewBox="0 0 16 16" version="1.1" role="img">',
  in_progress: '<svg aria-label="currently running: " width="100%" height="100%" fill="none" viewBox="0 0 16 16" class="anim-rotate" xmlns="http://www.w3.org/2000/svg">',
  queued: '<svg data-component="Octicon" width="16" height="16" style="margin-top: 2px" class="octicon octicon-dot-fill hx_dot-fill-pending-icon" aria-label="queued: " viewBox="0 0 16 16" version="1.1" role="img">',
  waiting: '<svg data-component="Octicon" width="16" height="16" style="margin-top: 2px" class="octicon octicon-clock color-fg-attention" aria-label="waiting: " viewBox="0 0 16 16" version="1.1" role="img">',
  unknown: '<svg data-component="Octicon" width="16" height="16" class="octicon octicon-hourglass color-fg-muted" role="img">',
};
const ARIA = { success: 'completed successfully', failure: 'failed', cancelled: 'cancelled', skipped: 'skipped', action_required: 'requires action with the application', in_progress: 'currently running', queued: 'queued', waiting: 'waiting', unknown: 'unknown' };

/** One run row, structured like the real thing. `icon` null = a prose-only row. */
export function fixtureRow({ repo = 'AlgoVaultLabs/algovault-skills', runId, runNumber, name = 'Marketplace Health Check', started = '2026-10-02T14:03:41Z', icon = 'success', aria, subtitleNumber, calendarDecoy = true, ref, refTitles }) {
  const iconTag = icon === null ? '' : `<div >     ${SVG_TAG[icon]}<path d="M0 0"></path></svg> </div>`;
  const label = aria ?? `${ARIA[icon] ?? 'completed successfully'}:  Run ${runNumber} of ${name}.`;
  const decoy = calendarDecoy ? '<div class="mr-1"><svg aria-hidden="true" data-component="Octicon" height="16" viewBox="0 0 16 16" version="1.1" width="16" data-view-component="true" class="octicon octicon-calendar"><path d="M0 0"></path></svg></div>' : '';
  // Ruling Q9: the real row renders its ref twice (desktop + mobile) as a branch-name anchor whose
  // `title` is the short ref name (measured 2026-10-04 on publish-npm.yml: #29 v1.31.1, #28 main).
  // Absent unless asked for, so every pre-Q9 fixture renders byte-identically.
  const titles = refTitles ?? (ref === undefined ? [] : [ref, ref]);
  const refAnchors = titles.map((t) => `<a target="_parent" class="d-inline-block branch-name css-truncate css-truncate-target my-0 my-md-1" style="max-width: 200px;"${t === null ? '' : ` title="${t}"`} href="/${repo}/tree/refs/${/^v\d/.test(String(t)) ? 'tags' : 'heads'}/${t}">${t}</a>`).join('\n');
  return `<div class="Box-row js-socket-channel js-updatable-content" id="check_suite_${runId}0" data-channel="SCRUBBED" data-url="/${repo}/actions/workflow-run/${runId}0" data-batched="30000" >
<div class="d-table col-12"><div class="d-table-cell v-align-top col-11 col-md-6 position-relative">
<a href="/${repo}/actions/runs/${runId}" class="d-flex flex-items-center width-full mb-1" aria-label="${label}">${iconTag}
<span class="h4 Link--primary text-bold width-full markdown-title css-truncate css-truncate-target pl-2" style="min-width: 95%">${name}</span></a>
<span class="d-block text-small color-fg-muted mb-1 mb-md-0 tmp-pl-4"><span class="text-bold" >${name}</span> #${subtitleNumber ?? runNumber}: <span class="color-fg-muted">Scheduled</span></span>
<div class="d-block d-md-none text-small tmp-pl-4"><span class="lh-condensed color-fg-muted my-1 pr-2 d-flex" >${decoy}<relative-time datetime="${started}" threshold="PT1H"></relative-time></span></div>
</div>${refAnchors ? `\n${refAnchors}\n` : ''}</div></div>`;
}

/** The page chrome R0.4 measured BEFORE the first row: every trap a page-global parser would hit. */
export const PRE_ROW_CHROME = [
  ...Array(4).fill('<svg aria-hidden="true" class="octicon octicon-alert color-fg-danger" data-show-on-error hidden></svg>'),
  '<svg class="octicon octicon-alert"></svg>',
  ...Array(4).fill('<svg class="octicon octicon-stop"></svg>'),
  ...Array(4).fill('<svg class="octicon octicon-check-circle-fill"></svg>'),
  ...Array(4).fill('<svg class="octicon octicon-alert-fill"></svg>'),
  ...Array(10).fill('<svg class="anim-rotate" aria-label="Loading content..."></svg>'),
].join('\n');

export function fixturePage(rows) {
  return `<html><body><select-panel>${PRE_ROW_CHROME}</select-panel><div class="Box">\n${rows.join('\n')}\n</div></body></html>`;
}
export const fixtureBadge = (name, status) => `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="20"><title>${name} - ${status}</title><g></g></svg>`;

/**
 * One React run, field for field the shape captured 2026-10-22 (tests/fixtures/gh-run-conclusion/
 * page-*-react-20261022.html). `conclusion: null` omits the key, as GitHub does for a non-COMPLETED run.
 */
export function fixtureReactRun({ repo = 'AlgoVaultLabs/algovault-skills', workflow = 'marketplace-check.yml', runId, runNumber, name = 'Marketplace Health Check', started = '2026-10-21T13:08:27Z', status = 'COMPLETED', conclusion = status === 'COMPLETED' ? 'SUCCESS' : null, ref = 'main' } = {}) {
  return {
    name, runNumber, id: runId, workflowFilePath: `.github/workflows/${workflow}`, runUrl: `https://github.com/${repo}/actions/runs/${runId}`,
    title: name, titleHtml: { value: name }, workflowName: name,
    actions: { workflowFileUrl: `/${repo}/actions/runs/${runId}/workflow` },
    description: { primaryText: 'Scheduled', actorName: 'actor', actorUrl: '/actor', actorType: 'WORKFLOW_RUN_ACTOR_TYPE_USER' },
    state: { status: RS(status), ...(conclusion === null ? {} : { conclusion: RC(conclusion) }) },
    createdAt: { timestamp: started, isCurrentYear: true },
    branch: ref === null ? null : { name: `refs/${/^v\d/.test(ref) ? 'tags' : 'heads'}/${ref}`, url: `/${repo}/tree/refs/${/^v\d/.test(ref) ? 'tags' : 'heads'}/${ref}`, title: ref },
    timing: { kind: 'WORKFLOW_RUN_TIMING_KIND_DURATION', text: '1m 9s' }, aliveChannel: 'SCRUBBED',
  };
}

/**
 * A React page around `runs` (undefined = the key ABSENT, as an empty list is served). `route` overrides
 * route fields (e.g. { totalCount: 3 }); `raw` replaces the whole JSON text (e.g. truncated).
 */
export function fixtureReactPage(runs, { route = {}, raw } = {}) {
  const r = { ...(runs === undefined ? {} : { workflowRuns: runs }), aliveChannel: 'SCRUBBED', header: {}, title: 'Workflow runs', totalPages: 1, workflowExists: true, ...(runs === undefined ? {} : { totalCount: runs.length }), ...route };
  const json = raw ?? JSON.stringify({ payload: { workflowRunsRoute: r, workflowsLayoutRoute: {}, repoLayoutRoute: {} }, title: 'Workflow runs', appPayload: {}, meta: {} });
  return `<html><head><meta name="react-app-name" content="actions-workflows"></head><body><react-app app-name="actions-ui"><script type="application/json" data-target="react-app.embeddedData">${json}</script></react-app></body></html>`;
}

/** An in-memory fetch keyed by (url, read). `seq[url]` = [read1, read2, …]; the last repeats. */
export function memoryFetch(seq) {
  return (url, ext, readNo) => {
    const list = seq[url];
    if (!list) return { http: 404, body: '', contentType: DEFAULT_CT[ext], date: null };
    const r = list[Math.min(readNo, list.length) - 1];
    return { http: r.http ?? 200, body: r.body ?? '', contentType: r.contentType ?? DEFAULT_CT[ext], date: null };
  };
}

export function selfTest({ log = (s) => console.log(s) } = {}) {
  let passed = 0;
  let failed = 0;
  const check = (name, ok, detail = '') => {
    try {
      if (ok) { passed++; log(`  ✓ ${name}`); } else { failed++; log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
    } catch (e) { failed++; log(`  ✗ ${name} — threw ${e && e.message}`); }
  };
  const safe = (fn) => { try { return fn(); } catch (e) { return { threw: String(e && e.message) }; } };

  const MC = { repo: 'AlgoVaultLabs/algovault-skills', workflow: 'marketplace-check.yml', branch: 'main' };
  const NAME = 'Marketplace Health Check';
  const B = badgeUrl(MC);
  const P = actionsUrl(MC);
  const noSleep = () => {};
  // host pinned: the fixture keys are github.com URLs, whatever XREPO_CI_BADGE_HOST the caller's env carries.
  const read = (seq, extra = {}, input = MC) => safe(() => readConclusion({ ...input, cls: 'alerting', ...extra }, { fetchDoc: memoryFetch(seq), sleep: noSleep, reads: RECOVER_DEFAULTS.reads, spacingS: RECOVER_DEFAULTS.spacingS, host: DEFAULT_HOST, nowIso: () => '2026-10-03T00:00:00Z' }));
  const page = (...rows) => ({ body: fixturePage(rows) });
  const badge = (status, name = NAME) => ({ body: fixtureBadge(name, status) });
  const r144 = (icon = 'success', extra = {}) => fixtureRow({ runId: '37017230705', runNumber: 144, icon, ...extra });
  const r143 = (icon = 'success') => fixtureRow({ runId: '36878561604', runNumber: 143, icon, started: '2026-10-01T14:43:16Z' });
  const r131 = (icon = 'failure') => fixtureRow({ runId: '35616111211', runNumber: 131, icon, started: '2026-09-21T15:01:35Z' });
  const v = (rec) => `${rec.row}/${rec.agreement}/${CLASSES.map((c) => verdictFor(rec, c)).join(',')}`;

  log('── the configuration law: the Recover span is DERIVED from the measured envelope ──');
  const cfg = resolveConfig();
  check(`(reads − 1) × spacing = ${(cfg.reads - 1) * cfg.spacingS} s > EPISODE_ENVELOPE ${EPISODE_ENVELOPE.seconds} s`, spanCoversEnvelope(cfg), JSON.stringify(cfg));
  check('the envelope carries its instrument (provenance)', /§4\.2/.test(EPISODE_ENVELOPE.provenance) && /curl/.test(EPISODE_ENVELOPE.provenance));
  check('a 30 s spacing would NOT cover the envelope (the law can fail)', !spanCoversEnvelope({ reads: 3, spacingS: 30 }));

  log('── the vocabulary is DATA with provenance; unmeasured is UNMEASURED ──');
  check('every vocabulary entry carries repo + run id + date + estate|third-party', ICON_VOCAB.every((e) => e.provenance && e.provenance.repo && /^\d+$/.test(e.provenance.run_id) && /^\d{4}-\d{2}-\d{2}$/.test(e.provenance.date) && ['estate', 'third-party'].includes(e.provenance.source)));
  check('success icon', classifyIcon('octicon octicon-check-circle-fill color-fg-success')?.state === 'success');
  check('failure icon', classifyIcon('octicon octicon-x-circle-fill color-fg-danger')?.state === 'failure');
  check('cancelled is failure-class', classifyIcon('octicon octicon-stop neutral-check')?.cls === 'failure');
  check('in_progress = class exactly anim-rotate, non-terminal', classifyIcon('anim-rotate')?.cls === 'nonterminal');
  check('queued / waiting are non-terminal', classifyIcon('octicon octicon-dot-fill hx_dot-fill-pending-icon')?.cls === 'nonterminal' && classifyIcon('octicon octicon-clock color-fg-attention')?.cls === 'nonterminal');
  check('skipped / action_required are UNBOUND (badge mapping unmeasured)', classifyIcon('octicon octicon-skip neutral-check')?.cls === 'unbound' && classifyIcon('octicon octicon-alert color-fg-attention')?.cls === 'unbound');
  check('ONE token is not enough (both must be present)', classifyIcon('octicon octicon-check-circle-fill') === null && classifyIcon('octicon octicon-x-circle-fill') === null);
  check('the chrome trap icon is not a state', classifyIcon('octicon octicon-alert color-fg-danger') === null);
  check('an unknown icon is UNMEASURED', classifyIcon('octicon octicon-hourglass color-fg-muted') === null && classifyIcon('') === null && classifyIcon(null) === null);

  log('── the bound-conclusion table, every row × class ──');
  const today = read({ [B]: [badge('failing')], [P]: [page(r144('success'), r143())] });
  check('row 1: passing + success → AGREE, PASS/PASS/passing, bound', v(read({ [B]: [badge('passing')], [P]: [page(r144())] })) === '1/AGREE/PASS,PASS,passing');
  check('row 2: failing + failure → AGREE, FAIL/FAIL/failing', v(read({ [B]: [badge('failing')], [P]: [page(r131('failure'))] })) === '2/AGREE/FAIL,FAIL,failing');
  check('row 3 (TODAY): failing + success → DISAGREE, INDET/INDET/unknown', v(today) === '3/DISAGREE/INDETERMINATE,INDETERMINATE,unknown', v(today));
  check('row 4: passing + failure → DISAGREE, FAIL/FAIL/failing (record-confirmed)', v(read({ [B]: [badge('passing')], [P]: [page(r131('failure'))] })) === '4/DISAGREE/FAIL,FAIL,failing');
  check('row 5: failing + unavailable → UNCORROBORATED, FAIL/INDET/unknown', v(read({ [B]: [badge('failing')], [P]: [{ http: 503 }] })) === '5/UNCORROBORATED/FAIL,INDETERMINATE,unknown');
  check('row 6: passing + unavailable → UNCORROBORATED, PASS/INDET/unknown', v(read({ [B]: [badge('passing')], [P]: [{ http: 503 }] })) === '6/UNCORROBORATED/PASS,INDETERMINATE,unknown');
  check('row 7: badge name ≠ row name → DISAGREE, INDET/INDET/unknown', v(read({ [B]: [badge('passing', 'Some Other Workflow')], [P]: [page(r144())] })) === '7/DISAGREE/INDETERMINATE,INDETERMINATE,unknown');
  check('row 8: no status → UNREADABLE', v(read({ [B]: [badge('no status')], [P]: [page(r144())] })) === '8/UNREADABLE/INDETERMINATE,INDETERMINATE,unknown');
  check('row 8: badge HTTP 404 → UNREADABLE', v(read({ [P]: [page(r144())] })) === '8/UNREADABLE/INDETERMINATE,INDETERMINATE,unknown');
  check('row 8: badge with no title → UNREADABLE', v(read({ [B]: [{ body: '<svg></svg>' }], [P]: [page(r144())] })) === '8/UNREADABLE/INDETERMINATE,INDETERMINATE,unknown');

  log('── bound_run: present ONLY when the run record supports the claim ──');
  check('TODAY (row 3) carries NO bound_run', today && !('bound_run' in today));
  check('TODAY ends after GHRC_READS reads, every sample recorded', today.reads === RECOVER_DEFAULTS.reads && today.samples.length === RECOVER_DEFAULTS.reads);
  const sep21 = read({ [B]: [badge('failing')], [P]: [page(r131('failure'))] });
  check('2026-09-21 replay binds run 35616111211', sep21.bound_run?.run_id === '35616111211' && sep21.bound_run?.run_number === 131 && sep21.reads === 1);
  check('row 5 and row 6 never bind', !('bound_run' in read({ [B]: [badge('failing')], [P]: [{ http: 503 }] })) && !('bound_run' in read({ [B]: [badge('passing')], [P]: [{ http: 503 }] })));

  log('── prose never decides; the icon is anchor-scoped ──');
  const lying = r144('failure', { aria: 'completed successfully:  Run 144 of Marketplace Health Check.' });
  check('aria says "completed successfully", icon says failure → failure', read({ [B]: [badge('failing')], [P]: [page(lying)] }).row === 2);
  const proseOnly = fixtureRow({ runId: '37017230705', runNumber: 144, icon: null, aria: 'completed successfully:  Run 144 of Marketplace Health Check.' });
  const po = read({ [B]: [badge('failing')], [P]: [page(proseOnly)] });
  check('a prose-only row is UNMEASURED → UNCORROBORATED', po.agreement === 'UNCORROBORATED' && po.page.guard === 'icon_unmeasured', `${po.agreement}/${po.page.guard}`);
  const ip = fixtureRow({ runId: '37123657814', runNumber: 145, icon: 'in_progress', started: '2026-10-03T12:40:55Z' });
  const ipRows = parsePage(fixturePage([ip]));
  check('in-progress row: anim-rotate read, NOT the octicon-calendar decoy', ipRows[0]?.state === 'in_progress', ipRows[0]?.icon_class);
  check('the page chrome (alert/stop/check/alert-fill/anim-rotate ×27) is never a row', parsePage(fixturePage([r144()])).length === 1);
  check('a COMMENTED-OUT check_suite_ never mints a phantom row ahead of the real newest one', (() => { const rows = parsePage(`<!-- old <div id="check_suite_1"> -->${fixturePage([r144()])}`); return rows.length === 1 && rows[0].run_id === '37017230705'; })());

  log('── the terminal walk ──');
  const walked = read({ [B]: [badge('passing')], [P]: [page(ip, r144())] });
  check('a measured non-terminal newest row is SKIPPED; #144 binds', walked.row === 1 && walked.bound_run?.run_id === '37017230705' && walked.page.newest?.state === 'in_progress');
  const queued = fixtureRow({ runId: '37123657999', runNumber: 146, icon: 'queued' });
  check('queued and waiting are skipped too', read({ [B]: [badge('passing')], [P]: [page(queued, fixtureRow({ runId: '37123657998', runNumber: 145, icon: 'waiting' }), r144())] }).row === 1);
  const unk = fixtureRow({ runId: '37123657814', runNumber: 145, icon: 'unknown' });
  const stopped = read({ [B]: [badge('passing')], [P]: [page(unk, r144())] });
  check('an UNMEASURED icon STOPS the walk (never guessed past) → UNCORROBORATED', stopped.agreement === 'UNCORROBORATED' && stopped.page.guard === 'icon_unmeasured');
  const sk = read({ [B]: [badge('failing')], [P]: [page(fixtureRow({ runId: '37123657814', runNumber: 145, icon: 'skipped' }), r131())] });
  check('a skipped newest row STOPS the walk with a named reason', sk.page.guard === 'terminal_unbound:skipped' && sk.row === 5);
  check('action_required STOPS the walk', read({ [B]: [badge('failing')], [P]: [page(fixtureRow({ runId: '37123657814', runNumber: 145, icon: 'action_required' }))] }).page.guard === 'terminal_unbound:action_required');
  check('only non-terminal rows → no_terminal_row', read({ [B]: [badge('passing')], [P]: [page(ip)] }).page.guard === 'no_terminal_row');

  log('── identity ──');
  check('the identity span is the EXACT-class text-bold span, not the h4 title', parsePage(fixturePage([r144()]))[0]?.name === NAME);
  check('the run number is the STRUCTURED #N:, never the aria prose (aria says 144, #N: says 143 → 143)', read({ [B]: [badge('passing')], [P]: [page(r144('success', { subtitleNumber: 143 }))] }).bound_run?.run_number === 143);
  check('a row with no #N: cannot bind (identity fails CLOSED)', read({ [B]: [badge('passing')], [P]: [page(r144().replace(/ #144:/, ''))] }).page.guard === 'row_identity_unreadable');
  check('identity is checked even when the walk STOPS: a wrong-workflow failing badge is row 7, never a badge-only RED', read({ [B]: [badge('failing', 'Deploy to Hetzner')], [P]: [page(fixtureRow({ runId: '37123657814', runNumber: 145, icon: 'unknown' }))] }).row === 7);
  check('a row with no identity span cannot bind', read({ [B]: [badge('passing')], [P]: [page(r144().replace('<span class="text-bold" >', '<span class="x" >'))] }).page.guard === 'row_identity_unreadable');
  check('entities decode symmetrically (badge "A &amp; B" == row "A &amp; B")', read({ [B]: [badge('passing', 'A &amp; B')], [P]: [page(fixtureRow({ runId: '1', runNumber: 1, name: 'A &amp; B' }))] }).row === 1);

  log('── guards: each UNCORROBORATED with a named reason ──');
  // OPS-XREPO-CI-CANARY-DARK-W2: a 200 carrying NEITHER shape's marker is no longer "zero rows" — it is
  // a page this reader has no declared shape for (the 2026-10-14 redesign read as `vacuity` for 8 days).
  check('a 200 with bytes and NO known shape → page_shape_unknown (never vacuity)', read({ [B]: [badge('passing')], [P]: [{ body: '<html><body><div class="blankslate">There are no workflow runs yet.</div></body></html>' }] }).page.guard === 'page_shape_unknown');
  check('content-type: a 200 that is not HTML', read({ [B]: [badge('passing')], [P]: [{ body: fixturePage([r144()]), contentType: 'application/atom+xml' }] }).page.guard === 'content_type');
  check('monotonic: a run id older than --min-run-id', read({ [B]: [badge('passing')], [P]: [page(r144())] }, { minRunId: '37117281597' }).page.guard === 'monotonic');
  check('monotonic: an equal-or-newer run id passes', read({ [B]: [badge('passing')], [P]: [page(r144())] }, { minRunId: '37017230705' }).row === 1);
  const atom = read({ [B]: [badge('passing')], [P]: [page(r144())] }, {}, { ...MC, workflow: 'w.yml.atom' });
  check('the .atom trap is refused BEFORE any fetch, reason atom_trap', atom.row === 'R' && atom.agreement === 'UNCORROBORATED' && atom.reason === 'atom_trap' && atom.reads === 0);
  check('row R (refused input) is INDETERMINATE / INDETERMINATE / unknown — a refused input never pages', CLASSES.map((c) => verdictFor(atom, c)).join(',') === 'INDETERMINATE,INDETERMINATE,unknown');
  check('a non-canonical repo is refused', read({}, {}, { ...MC, repo: 'o/a b' }).reason === 'non_canonical_repo');
  check('an undeclared branch is refused, never inferred', read({}, {}, { repo: MC.repo, workflow: MC.workflow }).reason === 'branch_undeclared');
  check('isCanonicalActionsUrl refuses the .atom page and accepts the canonical form', !isCanonicalActionsUrl('https://github.com/o/a/actions/workflows/w.yml.atom') && isCanonicalActionsUrl(P) && isCanonicalActionsUrl(actionsUrl({ ...MC, branch: null })));
  check('any-ref URLs carry no branch filter', badgeUrl({ ...MC, branch: null }).endsWith('/badge.svg') && actionsUrl({ ...MC, branch: null }).endsWith('/marketplace-check.yml'));

  log('── Recover ──');
  const conv = read({ [B]: [badge('failing'), badge('passing')], [P]: [page(r144())] });
  check('DISAGREE then AGREE converges at read 2, both samples recorded', conv.row === 1 && conv.reads === 2 && conv.samples.length === 2 && conv.samples[0].row === 3);
  const r5 = read({ [B]: [badge('failing')], [P]: [{ http: 503 }, page(r144())] });
  check('row 5 re-reads too, and ends in row 3, NOT a FAIL', r5.samples[0].row === 5 && r5.row === 3 && verdictFor(r5, 'alerting') === 'INDETERMINATE', `${r5.samples.map((s) => s.row).join('>')}`);
  const launder = read({ [B]: [badge('passing')], [P]: [page(r131()), { http: 503 }] });
  check('a later page outage never launders a record-confirmed failure (row 4 survives a later row 6)', launder.row === 4 && verdictFor(launder, 'alerting') === 'FAIL', `${launder.samples.map((s) => s.row).join('>')}`);
  const floorCase = read({ [B]: [badge('passing')], [P]: [page(r144('failure')), page(r143())] });
  check('the floor RISES inside the window: a stale page falling back to an older run never AGREEs past a failure (row 4 stays)', floorCase.row === 4 && floorCase.samples[1].page.guard === 'monotonic', `${floorCase.samples.map((x) => `${x.row}:${x.page.guard}`).join('>')}`);
  const r4r7 = read({ [B]: [badge('passing'), badge('passing', 'Deploy to Hetzner')], [P]: [page(r131())] });
  check('a bound row 4 outranks a later unbound row 7 (a renamed-badge glitch never silences a confirmed failure)', r4r7.row === 4 && r4r7.samples.map((x) => x.row).join('>') === '4>7>7');
  const newer = read({ [B]: [badge('passing'), badge('failing')], [P]: [page(r131()), page(r144(), r131())] });
  check('the NEWEST terminal run read wins: a newer success outranks an older failure (row 3, no RED)', newer.row === 3 && verdictFor(newer, 'alerting') === 'INDETERMINATE');
  const ppf = read({ [B]: [badge('passing'), badge('passing'), badge('failing')], [P]: [{ http: 503 }] });
  check('page down all window: badge passing,passing,failing → majority passing → row 6 (one glitch never pages)', ppf.row === 6, ppf.samples.map((x) => x.row).join('>'));
  const ffp = read({ [B]: [badge('failing'), badge('failing'), badge('passing')], [P]: [{ http: 503 }] });
  check('page down all window: badge failing,failing,passing → majority failing → row 5', ffp.row === 5, ffp.samples.map((x) => x.row).join('>'));
  let slept = 0;
  safe(() => readConclusion({ ...MC, cls: 'alerting' }, { fetchDoc: memoryFetch({ [B]: [badge('failing')], [P]: [page(r144())] }), sleep: (s) => { slept += s; }, reads: 3, spacingS: 60, host: DEFAULT_HOST }));
  check('a persistent DISAGREE stops at GHRC_READS, sleeping (reads − 1) × spacing via the INJECTED sleep', slept === 120, `slept ${slept}`);
  check('AGREE on read 1 never re-reads (the green path costs nothing)', read({ [B]: [badge('passing')], [P]: [page(r144())] }).reads === 1);

  log('── any ref (ruling Q9): resolved to the newest finished run\'s OWN ref, both instruments read ON it ──');
  {
    const NPM = { repo: 'AlgoVaultLabs/crypto-quant-signal-mcp', workflow: 'publish-npm.yml', branch: null };
    const NN = 'Publish to npm';
    const P0 = actionsUrl(NPM);
    const B0 = badgeUrl(NPM);
    const rb = (ref) => badgeUrl({ ...NPM, branch: ref });
    const rp = (ref) => actionsUrl({ ...NPM, branch: ref });
    const row = (runId, runNumber, icon, ref, extra = {}) => fixtureRow({ repo: NPM.repo, runId, runNumber, name: NN, icon, ref, ...extra });
    const t29 = (icon = 'success') => row('37201506699', 29, icon, 'v1.31.1');
    const m28 = (icon = 'success') => row('37182060859', 28, icon, 'main');
    const t27 = (icon = 'failure') => row('35852161288', 27, icon, 'v1.31.0');
    const rd = (seq, extra = {}) => {
      const seen = [];
      const inner = memoryFetch(seq);
      const r = safe(() => readConclusion({ ...NPM, cls: 'blocking', ...extra }, { fetchDoc: (u, e, n, f) => { seen.push({ u, n, f }); return inner(u, e, n, f); }, sleep: noSleep, reads: RECOVER_DEFAULTS.reads, spacingS: RECOVER_DEFAULTS.spacingS, host: DEFAULT_HOST, nowEpoch: () => 1791116558 }));
      return { r, seen };
    };
    const ok = rd({ [P0]: [page(t29(), m28(), t27())], [rb('v1.31.1')]: [badge('passing', NN)], [rp('v1.31.1')]: [page(t29())] });
    check('refOfRun reads the branch-name title of THAT run\'s row (#29 → v1.31.1, #28 → main)', refOfRun(fixturePage([t29(), m28()]), '37201506699').ref === 'v1.31.1' && refOfRun(fixturePage([t29(), m28()]), '37182060859').ref === 'main');
    check('the newest finished run #29 on v1.31.1 → row 1 AGREE, resolved_ref v1.31.1, bound #29', ok.r.row === 1 && ok.r.resolved_ref === 'v1.31.1' && ok.r.bound_run?.run_id === '37201506699' && ok.r.reads === 1, `${ok.r.row}/${ok.r.resolved_ref}`);
    check('…the badge and page actually read are the REF\'s (?branch=v1.31.1, ?query=branch%3Av1.31.1)', ok.r.badge_url === rb('v1.31.1') && ok.r.actions_url === rp('v1.31.1'));
    check('…and the no-param badge (the DEFAULT branch) is NEVER requested', ok.seen.every((x) => x.u !== B0), JSON.stringify(ok.seen.map((x) => x.u)));
    const failedTag = rd({ [P0]: [page(t29('failure'), m28())], [B0]: [badge('passing', NN)], [rb('v1.31.1')]: [badge('failing', NN)], [rp('v1.31.1')]: [page(t29('failure'))] });
    check('a failed tag run after a green main: row 2 AGREE FAIL bound to the TAG run — never the cross-run row 4', failedTag.r.row === 2 && failedTag.r.agreement === 'AGREE' && verdictFor(failedTag.r, 'blocking') === 'FAIL' && failedTag.r.bound_run?.run_number === 29, `${failedTag.r.row}/${failedTag.r.agreement}`);
    const ip30 = row('37209999999', 30, 'in_progress', 'main');
    const skip = rd({ [P0]: [page(ip30, t29(), m28())], [rb('v1.31.1')]: [badge('passing', NN)], [rp('v1.31.1')]: [page(t29())] });
    check('an in-progress newest any-ref row is skipped: the ref is the newest FINISHED run\'s (v1.31.1)', skip.r.row === 1 && skip.r.resolved_ref === 'v1.31.1');
    check('one floor PER PAGE: the ref page\'s newest (#29) is older than the any-ref page\'s (#30) and is NOT `monotonic`', skip.r.page.guard === null);
    const miss = rd({ [P0]: [page(row('37201506699', 29, 'success', undefined))] });
    check('no branch-name element → UNCORROBORATED, reason ref_missing, blocking INDETERMINATE, nothing bound', miss.r.row === 'R' && miss.r.agreement === 'UNCORROBORATED' && miss.r.reason === 'ref_missing' && verdictFor(miss.r, 'blocking') === 'INDETERMINATE' && !('bound_run' in miss.r) && miss.r.resolved_ref === null, `${miss.r.row}/${miss.r.reason}`);
    check('…an unresolved ref re-reads (Recover) and never reads a badge at all', miss.r.reads === RECOVER_DEFAULTS.reads && miss.seen.every((x) => x.u === P0) && miss.r.badge_url === null);
    const slash = rd({ [P0]: [page(row('37201506699', 29, 'success', undefined, { refTitles: ['feature/x', 'feature/x'] }))] });
    check('a slash-ref (unmeasured) → ref_out_of_vocabulary', slash.r.reason === 'ref_out_of_vocabulary' && slash.r.row === 'R');
    const split = rd({ [P0]: [page(row('37201506699', 29, 'success', undefined, { refTitles: ['v1.31.1', 'v1.31.0'] }))] });
    check('two renders of the ref that disagree → ref_unparseable', split.r.reason === 'ref_unparseable');
    const untitled = rd({ [P0]: [page(row('37201506699', 29, 'success', undefined, { refTitles: [null, null] }))] });
    check('a branch-name element with no title → ref_unparseable', untitled.r.reason === 'ref_unparseable');
    const down = rd({ [P0]: [{ http: 503 }] });
    check('an any-ref page outage → ref_page_http_503 (UNCORROBORATED)', down.r.reason === 'ref_page_http_503' && down.r.agreement === 'UNCORROBORATED');
    const stop = rd({ [P0]: [page(row('37201506699', 29, 'unknown', 'v1.31.1'))] });
    check('an any-ref walk that STOPS resolves nothing (ref_page_icon_unmeasured)', stop.r.reason === 'ref_page_icon_unmeasured');
    const moving = rd({ [P0]: [page(t27()), page(t29(), t27())], [rb('v1.31.0')]: [badge('passing', NN)], [rp('v1.31.0')]: [page(t27())], [rb('v1.31.1')]: [badge('passing', NN)], [rp('v1.31.1')]: [page(t29())] });
    check('the ref is re-resolved on EVERY read, Recover included (v1.31.0 row 4 → v1.31.1 row 1 AGREE)', moving.r.samples.map((x) => `${x.resolved_ref}:${x.row}`).join('>') === 'v1.31.0:4>v1.31.1:1' && moving.r.resolved_ref === 'v1.31.1', moving.r.samples.map((x) => `${x.resolved_ref}:${x.row}`).join('>'));
    const cbOf = (x) => new URL(x.f).searchParams.get('ghrc_cb');
    check('every document of a resolved read (any-ref page, ref badge, ref page) carries THE read\'s ghrc_cb', moving.seen.length === 6 && moving.seen.every((x) => cbOf(x) === `1791116558-${x.n}`), JSON.stringify(moving.seen.map(cbOf)));
    check('each sample records how its ref was resolved (run, reason, page cb + Date)', moving.r.samples.every((x) => x.ref_resolution && 'date' in x.ref_resolution && x.ref_resolution.cb && x.ref_resolution.run?.run_id));
    const m30f = row('37209999998', 30, 'failure', 'main');
    const m30ip = row('37209999998', 30, 'in_progress', 'main');
    const lag = rd({ [P0]: [page(m30f, t29(), m28())], [rb('main')]: [badge('passing', NN)], [rp('main')]: [page(m30ip, m28())] });
    check('a ref page LAGGING behind the resolved run (#30 failed; the main page still shows it running) never binds the older #28 → ref_page_behind, INDETERMINATE', lag.r.agreement === 'UNCORROBORATED' && lag.r.page.guard === 'ref_page_behind' && verdictFor(lag.r, 'blocking') === 'INDETERMINATE' && !('bound_run' in lag.r), `${lag.r.row}/${lag.r.page.guard}/${lag.r.bound_run?.run_number}`);
    const newerUnread = rd({ [P0]: [page(t27()), page(t29(), t27())], [rb('v1.31.0')]: [badge('passing', NN)], [rp('v1.31.0')]: [page(t27())], [rb('v1.31.1')]: [badge('passing', NN)], [rp('v1.31.1')]: [{ http: 503 }] });
    check('Recover: a NEWER finished run resolved in a later read outranks an older bound one even when its ref page was unreadable (#29 > #27 → no FAIL on the stale #27)', newerUnread.r.reads === 3 && newerUnread.r.resolved_ref === 'v1.31.1' && verdictFor(newerUnread.r, 'blocking') === 'INDETERMINATE', `${newerUnread.r.samples.map((x) => `${x.resolved_ref}:${x.row}`).join('>')} → ${newerUnread.r.row}`);
    const decoy = fixturePage([t29().replace(/ title="v1\.31\.1"/g, ' data-title="evil" title="v1.31.1"')]);
    check('refOfRun reads `title` exactly — a data-title decoy is never the ref', refOfRun(decoy, '37201506699').ref === 'v1.31.1');
    check('…and a branch-name with ONLY a data-title is ref_unparseable', refOfRun(fixturePage([t29().replace(/ title="v1\.31\.1"/g, ' data-title="v1.31.1"')]), '37201506699').reason === 'ref_unparseable');
    const named = read({ [B]: [badge('passing')], [P]: [page(r144())] });
    check('a NAMED-branch record carries no resolved_ref / ref_resolution (byte-identical to pre-Q9)', !('resolved_ref' in named) && !('ref_resolution' in named) && named.samples.every((x) => !('resolved_ref' in x)));
    check('…and its GHRC lines carry no RESOLVED_REF line', !renderLines(named, 'alerting').some((l) => l.startsWith('GHRC_RESOLVED_REF=')));
    check('an any-ref record prints GHRC_RESOLVED_REF + GHRC_REF_REASON', renderLines(ok.r, 'blocking').includes('GHRC_RESOLVED_REF=v1.31.1') && renderLines(miss.r, 'blocking').includes('GHRC_REF_REASON=ref_missing'));
  }

  log('── page shapes (OPS-XREPO-CI-CANARY-DARK-W2): every page through EXACTLY ONE declared shape ──');
  {
    const rr = (o = {}) => fixtureReactRun({ runId: '39605376420', runNumber: 163, ...o });
    const rp = (runs, opts) => ({ body: fixtureReactPage(runs, opts) });
    const g = (seq, extra) => read(seq, extra).page.guard;
    check('PAGE_SHAPES: two measured entries, each with a date + source, each with exactly one reader', PAGE_SHAPES.length === 2 && PAGE_SHAPES.every((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.provenance?.date) && s.provenance?.source && typeof s.marker === 'string') && PAGE_SHAPES.map((s) => s.id).join() === SHAPE_READER_IDS.join());
    check('a React page routes to react_embedded_v1, a check_suite page to legacy_check_suite_v1', pageShapes(fixtureReactPage([rr()])).join() === 'react_embedded_v1' && pageShapes(fixturePage([r144()])).join() === 'legacy_check_suite_v1');
    const ok = read({ [B]: [badge('passing')], [P]: [rp([rr()])] });
    check('row 1 from a React page: AGREE, bound #163 39605376420, started_at = createdAt', ok.row === 1 && ok.bound_run?.run_id === '39605376420' && ok.bound_run?.run_number === 163 && ok.bound_run?.started_at === '2026-10-21T13:08:27Z', `${ok.row}/${ok.page?.guard}`);
    check('row 2 from a React page: FAILURE → AGREE FAIL, bound', read({ [B]: [badge('failing')], [P]: [rp([rr({ conclusion: 'FAILURE' })])] }).row === 2);
    check('row 4 from a React page: badge passing + FAILURE → FAIL, record-confirmed', read({ [B]: [badge('passing')], [P]: [rp([rr({ conclusion: 'FAILURE' })])] }).row === 4);
    check('CANCELLED and STARTUP_FAILURE are failure-class (as on the legacy icons)', read({ [B]: [badge('failing')], [P]: [rp([rr({ conclusion: 'CANCELLED' })])] }).row === 2 && read({ [B]: [badge('failing')], [P]: [rp([rr({ conclusion: 'STARTUP_FAILURE' })])] }).row === 2);
    check('the same state reads the same class on either shape (STATE_VOCAB ∩ ICON_VOCAB)', STATE_VOCAB.every((s) => { const i = ICON_VOCAB.find((e) => e.state === s.state); return !i || i.cls === s.cls; }));
    check('every STATE_VOCAB entry carries repo + run id + date + estate|third-party; non-COMPLETED entries carry NO conclusion', STATE_VOCAB.every((e) => e.provenance?.repo && /^\d+$/.test(e.provenance.run_id) && /^\d{4}-\d{2}-\d{2}$/.test(e.provenance.date) && ['estate', 'third-party'].includes(e.provenance.source) && ((e.status === RS('COMPLETED')) === (e.conclusion !== null))));
    check('ambiguous: a React page that ALSO carries a check_suite row → page_shape_ambiguous', g({ [B]: [badge('passing')], [P]: [{ body: fixtureReactPage([rr()]).replace('</body>', `${r144()}</body>`) }] }) === 'page_shape_ambiguous');
    check('two embeddedData scripts that BOTH carry the run route → page_shape_ambiguous', g({ [B]: [badge('passing')], [P]: [{ body: fixtureReactPage([rr()]).replace('</body>', `${/<script[\s\S]*<\/script>/.exec(fixtureReactPage([rr()]))[0]}</body>`) }] }) === 'page_shape_ambiguous');
    check('truncated JSON → page_shape_unparseable', g({ [B]: [badge('passing')], [P]: [rp(undefined, { raw: JSON.stringify({ payload: { workflowRunsRoute: { workflowRuns: [rr()] } } }).slice(0, 120) })] }) === 'page_shape_unparseable');
    check('a React payload with no workflowRunsRoute → page_shape_unparseable', g({ [B]: [badge('passing')], [P]: [rp(undefined, { raw: JSON.stringify({ payload: { allWorkflowRunsRoute: { workflowRuns: [rr()] } } }) })] }) === 'page_shape_unparseable');
    check('a workflowRuns that is not an array → page_shape_unparseable', g({ [B]: [badge('passing')], [P]: [rp(undefined, { route: { workflowRuns: { 0: rr() } } })] }) === 'page_shape_unparseable');
    check('Q1: workflowRuns ABSENT (how GitHub encodes an empty list) + a badge with no conclusion → vacuity (GitHub lists no runs)', g({ [B]: [badge('no status')], [P]: [rp(undefined)] }) === 'vacuity');
    check('Q1 (i): workflowRuns absent while totalCount says 3 → page_shape_unparseable', g({ [B]: [badge('no status')], [P]: [rp(undefined, { route: { totalCount: 3 } })] }) === 'page_shape_unparseable');
    check('Q1 (i): an EMPTY array while totalCount says 3 → page_shape_unparseable', g({ [B]: [badge('no status')], [P]: [rp([], { route: { totalCount: 3 } })] }) === 'page_shape_unparseable');
    check('Q1 (i): workflowRuns absent with totalCount 0 → vacuity', g({ [B]: [badge('no status')], [P]: [rp(undefined, { route: { totalCount: 0 } })] }) === 'vacuity');
    const vb = read({ [B]: [badge('passing')], [P]: [rp(undefined)] });
    check('Q1 (ii): an empty page while the SAME read\'s badge says passing → vacuity_badge_has_run (row 6, never a bind)', vb.page.guard === 'vacuity_badge_has_run' && vb.row === 6 && vb.reason === 'vacuity_badge_has_run' && !('bound_run' in vb), `${vb.row}/${vb.page.guard}`);
    check('Q1 (ii): …and when it says failing → vacuity_badge_has_run, row 5', (() => { const x = read({ [B]: [badge('failing')], [P]: [rp(undefined)] }); return x.page.guard === 'vacuity_badge_has_run' && x.row === 5; })());
    log('  · the walk');
    check('IN_PROGRESS / QUEUED / WAITING newest runs are SKIPPED (no conclusion key); the finished run binds', read({ [B]: [badge('passing')], [P]: [rp([rr({ runId: '39605376423', runNumber: 166, status: 'IN_PROGRESS' }), rr({ runId: '39605376422', runNumber: 165, status: 'QUEUED' }), rr({ runId: '39605376421', runNumber: 164, status: 'WAITING' }), rr()])] }).bound_run?.run_id === '39605376420');
    const pend = read({ [B]: [badge('passing')], [P]: [rp([rr({ runId: '39605376421', runNumber: 164, status: 'PENDING' }), rr()])] });
    check('ruling: an UNMEASURED status (PENDING) STOPS the walk → state_unmeasured:<status>/none, never guessed past', pend.page.guard === `state_unmeasured:${RS('PENDING')}/none` && pend.row === 6, pend.page.guard);
    const tmo = read({ [B]: [badge('failing')], [P]: [rp([rr({ conclusion: 'TIMED_OUT' }), rr({ runId: '39605376419', runNumber: 162 })])] });
    check('an unknown conclusion (TIMED_OUT, unmeasured) → state_unmeasured, row 5 — the walk stops at it', tmo.page.guard === `state_unmeasured:${RS('COMPLETED')}/${RC('TIMED_OUT')}` && tmo.row === 5, tmo.page.guard);
    check('a non-COMPLETED run that CARRIES a conclusion is unmeasured', read({ [B]: [badge('passing')], [P]: [rp([rr({ status: 'IN_PROGRESS', conclusion: 'SUCCESS' })])] }).page.guard === `state_unmeasured:${RS('IN_PROGRESS')}/${RC('SUCCESS')}`);
    check('a COMPLETED run with NO conclusion is unmeasured', read({ [B]: [badge('passing')], [P]: [rp([rr({ conclusion: null })])] }).page.guard === `state_unmeasured:${RS('COMPLETED')}/none`);
    check('a vendor string with odd characters is rendered inside [A-Za-z0-9_] only', (() => { const x = read({ [B]: [badge('passing')], [P]: [rp([{ ...rr(), state: { status: 'X Y"<z>', conclusion: 'a/b' } }])] }); return x.page.guard === 'state_unmeasured:X_Y__z_/a_b'; })());
    check('SKIPPED newest run → terminal_unbound:skipped (the walk stops)', read({ [B]: [badge('failing')], [P]: [rp([rr({ conclusion: 'SKIPPED' }), rr({ runId: '39605376419', runNumber: 162, conclusion: 'FAILURE' })])] }).page.guard === 'terminal_unbound:skipped');
    check('ACTION_REQUIRED → terminal_unbound:action_required', read({ [B]: [badge('failing')], [P]: [rp([rr({ conclusion: 'ACTION_REQUIRED' })])] }).page.guard === 'terminal_unbound:action_required');
    check('only in-flight runs → no_terminal_row', read({ [B]: [badge('passing')], [P]: [rp([rr({ status: 'IN_PROGRESS' })])] }).page.guard === 'no_terminal_row');
    log('  · identity fails CLOSED');
    const idg = (run) => read({ [B]: [badge('passing')], [P]: [rp([run])] }).page.guard;
    const { workflowFilePath: _wfp, ...noPath } = rr();
    check('drop workflowFilePath → row_identity_unreadable', idg(noPath) === 'row_identity_unreadable');
    check('another workflow\'s file path → row_identity_unreadable', idg({ ...rr(), workflowFilePath: '.github/workflows/deploy.yml' }) === 'row_identity_unreadable');
    check('a runUrl for another repo → row_identity_unreadable', idg({ ...rr(), runUrl: 'https://github.com/o/other/actions/runs/39605376420' }) === 'row_identity_unreadable');
    check('a runUrl naming another run id → row_identity_unreadable', idg({ ...rr(), runUrl: 'https://github.com/AlgoVaultLabs/algovault-skills/actions/runs/1' }) === 'row_identity_unreadable');
    check('a NUMERIC id (unmeasured form) → row_identity_unreadable', idg({ ...rr(), id: 39605376420 }) === 'row_identity_unreadable');
    check('a runNumber that is not an integer → row_identity_unreadable', idg({ ...rr(), runNumber: '163' }) === 'row_identity_unreadable');
    check('an empty workflowName → row_identity_unreadable', idg({ ...rr(), workflowName: '  ' }) === 'row_identity_unreadable');
    check('the badge names another workflow than workflowName → row 7 (DISAGREE)', read({ [B]: [badge('passing', 'Deploy to Hetzner')], [P]: [rp([rr()])] }).row === 7);
    check('an identity-failed newest row never feeds the monotonic floor or Leg B (no newest run id)', read({ [B]: [badge('passing')], [P]: [rp([noPath])] }, { minRunId: '99999999999' }).page.newest?.run_id === null);
    check('monotonic on a React page: a newest run older than --min-run-id', read({ [B]: [badge('passing')], [P]: [rp([rr()])] }, { minRunId: '39605376421' }).page.guard === 'monotonic');
    log('  · any ref on the React shape (ruling Q9, R1.4)');
    const NPM = { repo: 'AlgoVaultLabs/crypto-quant-signal-mcp', workflow: 'publish-npm.yml', branch: null };
    const nr = (o) => fixtureReactRun({ repo: NPM.repo, workflow: NPM.workflow, name: 'Publish to npm', ...o });
    const t29 = nr({ runId: '37201506699', runNumber: 29, ref: 'v1.31.1', started: '2026-10-04T12:15:56Z' });
    const m28 = nr({ runId: '37182060859', runNumber: 28, ref: 'main' });
    const anyPg = fixtureReactPage([t29, m28]);
    check('refOfRun reads branch.title of THAT run (#29 → v1.31.1, #28 → main)', refOfRun(anyPg, '37201506699').ref === 'v1.31.1' && refOfRun(anyPg, '37182060859').ref === 'main');
    check('branch: null → ref_missing', refOfRun(fixtureReactPage([{ ...t29, branch: null }]), '37201506699').reason === 'ref_missing');
    check('name and title disagree (two renders) → ref_unparseable', refOfRun(fixtureReactPage([{ ...t29, branch: { ...t29.branch, name: 'refs/tags/v1.31.0' } }]), '37201506699').reason === 'ref_unparseable');
    check('a slash ref → ref_out_of_vocabulary', refOfRun(fixtureReactPage([{ ...t29, branch: { name: 'refs/heads/feature/x', title: 'feature/x' } }]), '37201506699').reason === 'ref_out_of_vocabulary');
    const anyRec = safe(() => readConclusion({ ...NPM, cls: 'blocking' }, { fetchDoc: memoryFetch({ [actionsUrl(NPM)]: [{ body: anyPg }], [badgeUrl({ ...NPM, branch: 'v1.31.1' })]: [badge('passing', 'Publish to npm')], [actionsUrl({ ...NPM, branch: 'v1.31.1' })]: [{ body: fixtureReactPage([t29]) }] }), sleep: noSleep, reads: 3, spacingS: 60, host: DEFAULT_HOST }));
    check('an any-ref read on React pages resolves v1.31.1 and binds #29, row 1', anyRec.row === 1 && anyRec.resolved_ref === 'v1.31.1' && anyRec.bound_run?.run_id === '37201506699', `${anyRec.row}/${anyRec.reason}`);
    log('  · --parse-page on the React shape (R1.5)');
    check('--parse-page: the React newest run → "<n>|<id>|<iso>"', legacyParseRunsPage(fixtureReactPage([rr()])) === '163|39605376420|2026-10-21T13:08:27Z');
    check('--parse-page refuses an empty React list, a page with both shapes, and a numeric id', legacyParseRunsPage(fixtureReactPage(undefined)) === null && legacyParseRunsPage(fixtureReactPage([rr()]).replace('</body>', `${r144()}</body>`)) === null && legacyParseRunsPage(fixtureReactPage([{ ...rr(), id: 1 }])) === null);
  }

  log('── GUARD_CLASS (ruling Q2): every reason → exactly one class; --guard-class is the canary\'s only source ──');
  {
    const want = {
      shape: ['page_shape_unknown', 'page_shape_ambiguous', 'page_shape_unparseable', 'vacuity_badge_has_run'],
      transport: ['http_503', 'http_0', 'http_none', 'content_type'],
      vocabulary: ['icon_unmeasured', `state_unmeasured:${RS('PENDING')}/none`, 'terminal_unbound:skipped'],
      identity: ['row_identity_unreadable'], monotonic: ['monotonic'],
      ref: ['ref_missing', 'ref_unparseable', 'ref_out_of_vocabulary', 'ref_page_behind', 'ref_page_unavailable'],
      input: ['atom_trap', 'non_canonical_repo', 'non_canonical_workflow', 'non_canonical_branch', 'non_canonical_url', 'branch_undeclared'],
      empty: ['vacuity', 'ref_page_vacuity'], pending: ['no_terminal_row'],
      badge: ['badge_unparseable', 'badge_no_status', 'badge_unknown_state', 'badge_http_404'],
      disagree: ['badge_failing_record_success', 'identity_mismatch'],
      bound: ['agree_success', 'agree_failure', 'badge_passing_record_failure'],
    };
    const miss = Object.entries(want).flatMap(([c, xs]) => xs.filter((x) => guardClass(x) !== c).map((x) => `${x}→${guardClass(x)}≠${c}`));
    check('every ruling string maps to its ruled class (composites included)', miss.length === 0, miss.join(' '));
    check('GUARD_CLASSES is exactly the ruled set, and every table class is in it', GUARD_CLASSES.join() === 'badge,disagree,shape,identity,vocabulary,transport,monotonic,ref,input,empty,pending,bound' && [...Object.values(GUARD_CLASS.exact), ...GUARD_CLASS.families.map((f) => f.cls)].every((c) => GUARD_CLASSES.includes(c)));
    check('a composite takes its INNER class: ref_page_icon_unmeasured → vocabulary, ref_page_http_503 → transport', guardClass('ref_page_icon_unmeasured') === 'vocabulary' && guardClass('ref_page_http_503') === 'transport');
    check('unknown, empty, non-string and malformed-family reasons are `unclassified`', guardClass('brand_new_guard') === 'unclassified' && guardClass('') === 'unclassified' && guardClass(null) === 'unclassified' && guardClass('http_') === 'unclassified' && guardClass('state_unmeasured:x') === 'unclassified' && guardClass('ref_page_brand_new') === 'unclassified');
    let o1 = ''; const c1 = runCli(['--guard-class', 'vacuity'], { stdout: (s) => { o1 += s; } });
    let o2 = ''; const c2 = runCli(['--guard-class', 'brand_new_guard'], { stdout: (s) => { o2 += s; } });
    let o3 = ''; const c3 = runCli(['--guard-class'], { stdout: (s) => { o3 += s; } });
    check('--guard-class vacuity → "empty", exit 0; an unknown reason → "unclassified", exit 3; no argument → unclassified, exit 3', o1 === 'empty\n' && c1 === 0 && o2 === 'unclassified\n' && c2 === EXIT.INDETERMINATE && o3 === 'unclassified\n' && c3 === EXIT.INDETERMINATE);
  }

  log('── the fetch seam: canary-identical fixture mangling ──');
  check('mangle = tr -c A-Za-z0-9 _', mangle('https://github.com/o/a/actions/workflows/w.yml?query=branch%3Amain') === 'https___github_com_o_a_actions_workflows_w_yml_query_branch_3Amain');
  check('mangle works per BYTE (a multi-byte char → one _ per byte)', mangle('é') === '__');
  check('the buster URL form: ghrc_cb=<epoch>-<read#>', bust('https://x/y?query=a', 1, 2) === 'https://x/y?query=a&ghrc_cb=1-2' && bust('https://x/y', 1, 3) === 'https://x/y?ghrc_cb=1-3');
  check('ruling Q6: the cache-buster ships ON', CACHE_BUSTER.enabled === true);
  {
    // A recording transport around the in-memory seam: what URL did each read ACTUALLY request?
    const seen = [];
    const inner = memoryFetch({ [B]: [badge('failing')], [P]: [page(r144())] });
    const rec = (u, ext, n, fetchUrl) => { seen.push({ u, n, fetchUrl }); return inner(u, ext, n, fetchUrl); };
    const r = safe(() => readConclusion({ ...MC, cls: 'alerting' }, { fetchDoc: rec, sleep: noSleep, reads: 3, spacingS: 60, host: DEFAULT_HOST, nowEpoch: () => 1791100000 }));
    const cbOf = (x) => (new URL(x.fetchUrl).searchParams.get('ghrc_cb'));
    check('while ON, EVERY badge and page read carries a ghrc_cb (3 reads × 2 documents)', seen.length === 6 && seen.every((x) => cbOf(x)), JSON.stringify(seen.map(cbOf)));
    check('…unique per read: no document is ever re-requested with the same value', [B, P].every((u) => new Set(seen.filter((x) => x.u === u).map(cbOf)).size === 3));
    check('…and the buster never changes which fixture is read (the seam keys on the canonical URL)', seen.every((x) => x.u === B || x.u === P) && r.row === 3);
    check('every sample records its ghrc_cb and the response Date header (the cached-vs-origin discriminator)', Array.isArray(r.samples) && r.samples.every((x) => x.badge.cb && x.page.cb && 'date' in x.badge && 'date' in x.page));
    const off = [];
    safe(() => readConclusion({ ...MC, cls: 'alerting' }, { fetchDoc: (u, e, n, f) => { off.push(f); return inner(u, e, n, f); }, sleep: noSleep, reads: 1, host: DEFAULT_HOST, cacheBuster: false }));
    check('with the buster OFF a read requests the canonical URL unchanged', off.length === 2 && off[0] === B && off[1] === P);
  }

  log('── legacy shims: byte-identical to the canary ──');
  check('parse_badge_status passing', legacyParseBadgeStatus('<svg><title>Marketplace Health Check - passing</title></svg>') === 'passing');
  check('parse_badge_status: name with " - " takes the LAST segment', legacyParseBadgeStatus('<svg><title>Build - Deploy - passing</title></svg>') === 'passing');
  check('parse_badge_status refuses no title / no separator', legacyParseBadgeStatus('<svg></svg>') === null && legacyParseBadgeStatus('<svg><title>whatever</title></svg>') === null);
  check('classify_status maps only the measured tokens', legacyClassifyStatus('passing') === 'PASS' && legacyClassifyStatus('failing') === 'FAIL' && legacyClassifyStatus('no status') === 'INDETERMINATE' && legacyClassifyStatus('brand new github word') === 'INDETERMINATE');
  const ROW_SCHED = '<div id="check_suite_1"><a href="/o/a/actions/runs/35616111211" aria-label="failed:  Run 131 of Marketplace Health Check."></a><relative-time     datetime="2026-09-21T15:01:35Z"></relative-time><relative-time datetime="2026-09-21T15:01:35Z"></relative-time></div><div id="check_suite_0"><a href="/o/a/actions/runs/35512179431" aria-label="completed successfully:  Run 130 of Marketplace Health Check."></a><relative-time datetime="2026-09-20T12:59:25Z"></relative-time></div>';
  check('parse_runs_page: the NEWEST row', legacyParseRunsPage(ROW_SCHED) === '131|35616111211|2026-09-21T15:01:35Z');
  check('parse_runs_page refuses a page with no rows', legacyParseRunsPage('<html><body><div class="blankslate">none</div></body></html>') === null);

  log('── the CLI: flat lines, one record, exactly one token, exit by token ──');
  let out = '';
  const rc = runCli(['--repo', MC.repo, '--workflow', MC.workflow, '--branch', 'main', '--class', 'alerting'], { stdout: (s) => { out += s; }, readOpts: { fetchDoc: memoryFetch({ [B]: [badge('failing')], [P]: [page(r144())] }), sleep: noSleep, host: DEFAULT_HOST } });
  const lines = out.trimEnd().split('\n');
  check('TODAY via the CLI: INDETERMINATE, exit 3', rc === EXIT.INDETERMINATE && lines[lines.length - 1] === `${TOKEN}=INDETERMINATE`);
  check('exactly one token line', lines.filter((l) => l.startsWith(`${TOKEN}=`)).length === 1);
  check('GHRC_AGREEMENT / GHRC_ROW / empty GHRC_BOUND_RUN_ID', lines.includes('GHRC_AGREEMENT=DISAGREE') && lines.includes('GHRC_ROW=3') && lines.includes('GHRC_BOUND_RUN_ID='));
  check('GHRC_RECORD is one line of JSON', (() => { const l = lines.find((x) => x.startsWith('GHRC_RECORD=')); return !!l && JSON.parse(l.slice(12)).row === 3; })());
  check('every GHRC_ value is a single line', lines.every((l) => !/[\r\t]/.test(l)));
  let out2 = '';
  const rc2 = runCli(['--repo', MC.repo, '--workflow', MC.workflow, '--branch', 'main', '--class', 'attribution'], { stdout: (s) => { out2 += s; }, readOpts: { fetchDoc: memoryFetch({ [B]: [badge('passing')], [P]: [page(r131())] }), sleep: noSleep, host: DEFAULT_HOST } });
  check('attribution row 4: GHRC_VERDICT=failing, token FAIL, exit 1', rc2 === EXIT.FAIL && out2.includes('GHRC_VERDICT=failing\n') && out2.endsWith(`${TOKEN}=FAIL\n`));
  let out3 = '';
  const rc3 = runCli(['--repo', MC.repo, '--class', 'nonsense'], { stdout: (s) => { out3 += s; } });
  check('a malformed invocation is INDETERMINATE, never a pass', rc3 === EXIT.INDETERMINATE && out3.endsWith(`${TOKEN}=INDETERMINATE\n`));
  let out4 = '';
  const rc4 = runCli(['--repo', MC.repo, '--workflow', MC.workflow, '--branch', 'main', '--class', 'alerting', '--min-run-id'], { stdout: (s) => { out4 += s; }, readOpts: { fetchDoc: memoryFetch({ [B]: [badge('passing')], [P]: [page(r144())] }), sleep: noSleep, host: DEFAULT_HOST } });
  check('a dangling --min-run-id is a usage error (INDETERMINATE), never a silently dropped floor', rc4 === EXIT.INDETERMINATE && out4.endsWith(`${TOKEN}=INDETERMINATE\n`) && !out4.includes('GHRC_ROW='));
  check('token→exit mapping', EXIT.PASS === 0 && EXIT.FAIL === 1 && EXIT.INDETERMINATE === 3);

  const total = passed + failed;
  log(`self-test: ${passed} passed, ${failed} failed`);
  // WE build this corpus, so a near-empty run means the suite built nothing. REFUSE.
  if (total < 160) { log(`  ✗ only ${total} checks ran — vacuity guard (measured 162 at OPS-XREPO-CI-CANARY-DARK-W2)`); return 'INDETERMINATE'; }
  return failed > 0 ? 'FAIL' : 'PASS';
}

// ───────────────────────────── main ─────────────────────────────

const realOrSelf = (p) => { try { return realpathSync(p); } catch { return p; } };
const isMain = !!process.argv[1] && realOrSelf(path.resolve(process.argv[1])) === realOrSelf(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const argv = process.argv.slice(2);
    if (argv[0] === '--self-test') {
      const tok = selfTest();
      console.log(`${TOKEN}=${tok}`);
      process.exitCode = EXIT[tok];
    } else {
      process.exitCode = runCli(argv);
    }
  } catch (e) {
    // Never die without a token: process death with no verdict is the one outcome the token law forbids.
    console.log(`  fatal: ${e && e.message}`);
    console.log(`${TOKEN}=INDETERMINATE`);
    process.exitCode = EXIT.INDETERMINATE;
  }
}
