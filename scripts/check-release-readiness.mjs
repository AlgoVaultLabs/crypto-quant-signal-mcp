#!/usr/bin/env node
/**
 * check-release-readiness.mjs — OPS-PREVERIFY-RED-UNREAD-W1 CH1 R3.
 *
 * IS THE PUBLISH LANE GREEN ENOUGH TO WRITE A RELEASE SPEC?
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────────────────────
 * publish-lane-preverify.yml went red on 2026-08-31 and stayed red for 49 consecutive runs, and
 * three releases (v1.29.0, v1.30.0, v1.31.0) were tagged straight through it. Its header declared
 * "the named red step IS the operator signal" — a control whose only consumer was a human opening
 * a browser tab. Nothing enumerated it, nothing delivered it, nothing blocked on it. This gate is
 * the BLOCKING half: Version-Bump-SOP.md § 2 runs `npm run release:readiness` before a release
 * spec is written, so a red lane refuses the bump even when nobody read the alert. The DELIVERY
 * half is the `publish-lane-preverify.yml` row in ops/cron/xrepo-ci-conclusion-canary.sh WATCHED.
 *
 * ── HONEST SCOPE — AN ALLOW-LIST OF TWO WORKFLOWS ───────────────────────────────────────────
 * It reads the CONCLUSION BADGE of exactly the workflows in RELEASE_BLOCKING_WORKFLOWS below. It
 * catches a REGISTERED red. It does not and cannot prove a release will succeed: a lane step that
 * no listed workflow rehearses is invisible to it (measured: publish-npm.yml's `Verify dist-tag`
 * failed on v1.29.0–v1.31.0 while the pre-verify rehearsal has no such step). Anything it cannot
 * read — unreachable, non-200, "no status", markup it cannot parse, a table entry that does not
 * declare its branch — falls toward INDETERMINATE (exit 3), never toward PASS.
 * Since OPS-XREPO-CI-RED-W1 CH4 (2026-10-04, ruling Q11): a PASS now requires the badge and the newest finished run's own status on the Actions page to agree, both read on that run's own ref; each row names that run and its ref.
 *
 * Two limits of reading a BADGE, stated so nobody mistakes them for coverage:
 *   · A badge carries a conclusion, not a token. publish-lane-preverify.yml maps its own
 *     INDETERMINATE (an unreachable live source) to a passing job with a ::warning::, so a green
 *     badge can be a run that verified nothing. The next scheduled run re-reads it; this gate
 *     cannot tell the two apart without an authenticated API call it deliberately does not make.
 *   · publish-npm.yml turns green ONLY through a successful publish-npm run, and today the only
 *     run that can produce one is a release — npm refuses to republish an existing version, so a
 *     re-run or a dispatch at the same version reds again. While its last run is red this gate
 *     says FAIL by design, and a release spec cannot be written past it. Clearing that is the
 *     owner's half: a publish-npm path that re-verifies the CURRENT version without publishing
 *     (Owner: OPS-DISTTAG-EVENTUAL-CONSISTENCY-W1, which owns the Verify dist-tag defect that made
 *     v1.29.0–v1.31.0 red). Measured 2026-10-03; recorded so the block reads as a decision.
 *     Corrected 2026-10-04 (OPS-XREPO-CI-RED-W1 CH4): a verify-only dispatch (#28 37182060859,
 *     2026-10-04T06:11Z) turned it green; and under ruling Q9 the row reads the newest FINISHED run
 *     on any ref, on that run's own ref, so after a release it binds that tag release's own run
 *     (#29 37201506699, v1.31.1).
 *
 * ── BRANCH SEMANTICS ARE DECLARED PER ENTRY, NEVER INFERRED ─────────────────────────────────
 * A badge reports the newest run on ONE branch when `?branch=` is given, and the newest run on ANY
 * ref when it is not. A tag-push run carries the TAG as its branch, so `?branch=main` structurally
 * cannot see a release run — measured 2026-10-03: publish-npm.yml at `?branch=main` reports run
 * 32990545311, a manual dispatch from 2026-08-26, and `?branch=main&event=push` reads "no status".
 * So every entry states `branch` explicitly: a branch name, or `null` meaning "latest run on any
 * ref". An entry whose `branch` key is ABSENT refuses (INDETERMINATE). The shared xrepo canary
 * deliberately refuses an undeclared branch; this script is the one place that declares one.
 * Corrected 2026-10-04 (OPS-XREPO-CI-RED-W1 CH4): a badge with no `?branch=` shows the DEFAULT
 * branch (GitHub's docs; measured 2026-10-04), not the newest run on any ref. `branch: null` still
 * means "any ref", now implemented truthfully: each read resolves the newest finished run's ref
 * from its Actions-page row and reads BOTH the badge (`?branch=<ref>`) and the page
 * (`?query=branch%3A<ref>`) on that ref; a ref that cannot be resolved is INDETERMINATE.
 *
 * ── VERDICT CONTRACT ────────────────────────────────────────────────────────────────────────
 *   RELEASE_READINESS_VERDICT=PASS           exit 0   every listed workflow reads `passing`
 *   RELEASE_READINESS_VERDICT=FAIL           exit 1   ≥1 reads `failing` (cancelled renders so too)
 *   RELEASE_READINESS_VERDICT=INDETERMINATE  exit 3   none failing, ≥1 unreadable / "no status"
 * Corrected 2026-10-04 (OPS-XREPO-CI-RED-W1 CH4): PASS / FAIL / INDETERMINATE now come from the
 * bound record (ops/monitoring/gh-run-conclusion.mjs, class `blocking`): PASS = every row AGREEs on
 * success; FAIL = a row whose run's own record failed (bind rows 2 and 4 — including a passing badge
 * over a failed run); INDETERMINATE = an unreadable badge or run record, the two naming different
 * workflows, a failing badge over a successful run, or an any-ref ref that cannot be resolved.
 * FAIL outranks INDETERMINATE: a measured red is actionable whatever else could not be read.
 * Before the token it prints one line per workflow and `RELEASE_READINESS_RED=<workflows>` — a
 * single aggregate FAIL that does not say WHICH workflow is red is a summary an operator misreads.
 * Callers gate on the TOKEN. 3 is the token-law default for a new gate.
 *
 * ── NOT IN prepublishOnly, BY DESIGN ────────────────────────────────────────────────────────
 * prepublishOnly is the pre-verify rehearsal's own corpus, and a gate that reads a live badge inside
 * the publish lane would red the lane on a GitHub CDN hiccup. It is a pre-flight a release wave runs,
 * like `release:divergence` (tests/unit/shipped-set-divergence.test.ts pins that precedent).
 *
 * ── EXIT ────────────────────────────────────────────────────────────────────────────────────
 * process.exitCode, NEVER process.exit(): a queued stdout write to a pipe is discarded by
 * process.exit(), and the token is the last line written. That exact defect is what kept the
 * pre-verify red unread — its rehearsal emitted PASS into a pipe and exited before it arrived.
 *
 * The badge body is cached `max-age=300, private`, so a conclusion can be up to ~5 minutes old.
 * Corrected 2026-10-04 (OPS-XREPO-CI-RED-W1 CH4): every read is now cache-busted (`ghrc_cb`), and a
 * non-agreeing read is re-checked (3 reads, 60 s apart) before it decides.
 *
 * Usage:
 *   node scripts/check-release-readiness.mjs              # read the live badges
 *   node scripts/check-release-readiness.mjs --self-test  # every state, both directions, offline
 */
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  readConclusion,
  verdictFor,
  curlFetch,
  memoryFetch,
  fixtureRow,
  fixturePage,
  fixtureBadge,
  badgeUrl as moduleBadgeUrl,
  actionsUrl,
  RECOVER_DEFAULTS,
  BIND_TABLE,
} from '../ops/monitoring/gh-run-conclusion.mjs';

const TOKEN = 'RELEASE_READINESS_VERDICT';
const BADGE_HOST = 'https://github.com';

/** 0=PASS / 1=FAIL / 3=INDETERMINATE. ONE meaning, ONE code, chosen locally. */
export const EXIT = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };

/**
 * THE ALLOW-LIST. Adding a release-blocking workflow is a row here — with its branch semantics
 * DECLARED. `branch: null` is a declaration ("latest run on any ref"), not an omission.
 */
export const RELEASE_BLOCKING_WORKFLOWS = [
  {
    repo: 'AlgoVaultLabs/crypto-quant-signal-mcp',
    workflow: 'publish-lane-preverify.yml',
    branch: 'main',
    why: 'rehearses the publish lane (injector + docs rebuild + the literal prepublishOnly + npm pack) daily and on every lane-touching push to main; a red here means the next release fails at the same step',
  },
  {
    repo: 'AlgoVaultLabs/crypto-quant-signal-mcp',
    workflow: 'publish-npm.yml',
    branch: null,
    // Corrected 2026-10-04 (OPS-XREPO-CI-RED-W1 CH4): the no-param badge reads the DEFAULT branch; under ruling Q9 this row resolves the newest finished run's ref and reads both instruments on it.
    why: 'the release lane itself — it runs on tag pushes, whose runs carry the TAG as their branch, so only the any-ref badge sees the last release; red means the last release did not finish its lane',
  },
];

/** Refuse a table entry that does not declare what it reads. Returns a reason or null. */
export function entryDefect(e) {
  if (!e || typeof e !== 'object') return 'entry is not an object';
  if (typeof e.repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(e.repo)) return 'entry has no owner/repo';
  if (typeof e.workflow !== 'string' || !/^[\w.-]+\.ya?ml$/.test(e.workflow)) return 'entry has no workflow file';
  if (!Object.prototype.hasOwnProperty.call(e, 'branch')) return 'entry does not DECLARE its branch (a name, or null for any ref)';
  if (e.branch !== null && (typeof e.branch !== 'string' || e.branch.trim() === '')) return 'entry branch must be a non-empty name or null';
  return null;
}

/**
 * The DECLARED badge URL — what the allow-list says this row watches. For a named branch it is
 * exactly the URL the module reads (the self-test asserts the equality); for `branch: null` it is
 * the any-ref declaration, and the module reads `?branch=<resolved ref>` beneath it (ruling Q9).
 */
export function badgeUrl(e) {
  const base = `${BADGE_HOST}/${e.repo}/actions/workflows/${e.workflow}/badge.svg`;
  return e.branch === null ? base : `${base}?branch=${encodeURIComponent(e.branch)}`;
}

export function branchLabel(e) {
  return e.branch === null ? 'any ref' : `branch ${e.branch}`;
}

/**
 * The LIVE read options — EVERY one pinned (architect-ratified), so a stale GHRC_FIXTURE_DIR /
 * XREPO_CI_FIXTURE_DIR / GHRC_READS / GHRC_BADGE_HOST export can never redirect a release gate: an
 * explicit curl transport (never the env-selected default), an explicit host, the module's Recover
 * defaults, and an EMPTY env. The module's real sleep is left in place — Recover's spacing is the point.
 */
export function liveReadOpts() {
  return { fetchDoc: curlFetch(), host: 'https://github.com', reads: RECOVER_DEFAULTS.reads, spacingS: RECOVER_DEFAULTS.spacingS, env: {} };
}

const GLYPH = { PASS: '+', FAIL: 'x', INDETERMINATE: '?' };
const ROW_R = BIND_TABLE.find((r) => r.row === 'R');

/** Human detail per bind row. Decides nothing: the verdict is verdictFor(record, 'blocking'). */
const DETAIL = {
  1: () => 'passing',
  2: () => 'failing',
  3: () => 'badge failing, but the run record says success',
  4: () => 'badge passing, but the run record says failed',
  5: () => 'badge failing, but the run record is unavailable',
  6: () => 'badge passing, but the run record is unavailable',
  7: () => 'the badge and the run page name different workflows',
  8: (rec) => {
    const http = rec.badge?.http;
    if (http === 0 || http === null || http === undefined) return 'badge unreachable';
    if (http !== 200) return `badge HTTP ${http}`;
    return 'badge reads "no status" or carries no parseable state';
  },
  R: (rec, e) => (e && e.branch === null && String(rec.reason).startsWith('ref_')
    ? "the newest finished run's ref could not be resolved"
    : 'refused before any read'),
};

/** One bound record → one row: the verdict (class `blocking`, straight from the table) + its detail. */
export function classifyRecord(record, e) {
  const verdict = verdictFor(record, 'blocking');
  const d = DETAIL[record.row];
  const detail = record.threw ? `the read threw (${record.threw}) — nothing was verified` : d ? d(record, e) : `unrecognised bind row ${record.row}`;
  return { verdict, detail };
}

/**
 * The row line. The prefix (glyph, workflow, repo, branch semantics, detail, URL) is the pre-CH4
 * shape; the tail is the bound record, and carries `agreement=` exactly once:
 *   bound (rows 1, 2, 4)  · agreement=<A> · run #<N> (<id>) on <ref>
 *   otherwise             · agreement=<A> · reason=<reason>[ on <resolved ref>  (any-ref, when resolved)]
 * A run is named ONLY from bound_run, so an unbound row can never print a run it did not bind.
 */
export function rowLine(e, record) {
  const { verdict, detail } = classifyRecord(record, e);
  const anyRef = e.branch === null;
  // An any-ref read whose ref could not be resolved never read a badge (badge_url null): name the page it
  // DID read, never the declared no-param badge URL (which shows the DEFAULT branch, not any ref).
  const url = record.badge_url ?? (anyRef && record.actions_url ? `${record.actions_url} (badge not read: ref unresolved)` : badgeUrl(e));
  const b = record.bound_run;
  const tail = b
    ? ` · run #${b.run_number} (${b.run_id}) on ${anyRef ? (record.resolved_ref ?? 'an unresolved ref') : e.branch}`
    : ` · reason=${record.reason}${anyRef && record.resolved_ref ? ` on ${record.resolved_ref}` : ''}`;
  return `  ${GLYPH[verdict] ?? '?'} ${e.workflow} (${e.repo}, ${branchLabel(e)}): ${detail} — ${url} · agreement=${record.agreement}${tail}`;
}

/** Rows → one verdict. FAIL outranks INDETERMINATE outranks PASS. Zero rows REFUSES. */
export function aggregate(rows) {
  const red = rows.filter((r) => r.verdict === 'FAIL').map((r) => r.workflow);
  const unread = rows.filter((r) => r.verdict === 'INDETERMINATE').map((r) => r.workflow);
  if (rows.length === 0) return { verdict: 'INDETERMINATE', red, unread, reason: 'the allow-list is EMPTY — this gate verified nothing' };
  if (red.length) return { verdict: 'FAIL', red, unread, reason: `${red.length} release-blocking workflow(s) RED: ${red.join(', ')}` };
  if (unread.length) return { verdict: 'INDETERMINATE', red, unread, reason: `could not read ${unread.join(', ')}` };
  return { verdict: 'PASS', red, unread, reason: `all ${rows.length} release-blocking workflow(s) passing` };
}

/** Set for the duration of --self-test: a read with no injected options there would go LIVE (60 s sleeps). */
let selfTestRunning = false;

/**
 * The whole gate. Every row is read through the ONE module (readConclusion, class `blocking`) and its
 * verdict projected by verdictFor — no badge or page is parsed here. Synchronous, because the read is.
 * `readOpts` omitted = the pinned live options. Returns { lines, verdict, red, exit, rows }.
 */
export function evaluate(table = RELEASE_BLOCKING_WORKFLOWS, readOpts, read = readConclusion) {
  if (readOpts === undefined && read === readConclusion && selfTestRunning) throw new Error('evaluate() without injected read options inside --self-test — that read would go LIVE');
  const opts = readOpts ?? liveReadOpts();
  const lines = [];
  const rows = [];
  for (const e of table) {
    const defect = entryDefect(e);
    const name = e && typeof e.workflow === 'string' ? e.workflow : '<malformed entry>';
    if (defect) {
      // Refused before any read — bind row R (input refused before any fetch), straight from the table.
      const refused = { row: 'R', agreement: ROW_R.agreement, reason: 'entry_refused' };
      const line = `  ? ${name}: REFUSED — ${defect} · agreement=${refused.agreement} · reason=${refused.reason}`;
      rows.push({ workflow: name, verdict: verdictFor(refused, 'blocking'), record: refused, line, threw: false });
      lines.push(line);
      continue;
    }
    let record;
    let threw = false;
    try {
      record = read({ ...e, cls: 'blocking' }, opts);
    } catch (err) {
      // The module never throws on a GitHub failure; a throw is a defect, and it verified nothing.
      // Contained to its row (INDETERMINATE), so a measured red elsewhere still reads FAIL.
      threw = true;
      record = { row: null, agreement: 'UNREADABLE', reason: 'read_threw', threw: String(err && err.message).split('\n')[0] };
    }
    const verdict = verdictFor(record, 'blocking');
    const line = rowLine(e, record);
    rows.push({ workflow: e.workflow, verdict, record, line, threw });
    lines.push(line);
  }
  const agg = aggregate(rows);
  lines.push(`  ${agg.reason}`);
  lines.push(`RELEASE_READINESS_RED=${agg.red.length ? agg.red.join(',') : 'none'}`);
  lines.push(`${TOKEN}=${agg.verdict}`);
  return { lines, verdict: agg.verdict, red: agg.red, exit: EXIT[agg.verdict], rows };
}

// ───────────────────────────────────────────────────────────────────────────────────────────────

/** Fixture rows are named like the badge — a row binds only when its name equals the badge's name. */
const WF = 'Some Workflow';
const svg = (state) => fixtureBadge(WF, state);

/**
 * Fixture run identities. publish-npm's are the measured pair (2026-10-04: #29 on tag v1.31.1,
 * #28 on main); pre-verify's is a synthetic fixture id.
 */
const PV_RUN = { runId: '37190000412', runNumber: 412 };
const TAG = 'v1.31.1';
const NPM_TAG_RUN = { runId: '37201506699', runNumber: 29 };
const NPM_MAIN_RUN = { runId: '37182060859', runNumber: 28 };

/** Every self-test read: in memory, no sleep, EMPTY env, host and Recover pinned. Never the network. */
const fixtureOpts = (seq) => ({ fetchDoc: memoryFetch(seq), sleep: () => {}, env: {}, host: 'https://github.com', reads: RECOVER_DEFAULTS.reads, spacingS: RECOVER_DEFAULTS.spacingS });

/** A named-branch lane, keyed by the module's CANONICAL urls: one badge read + one run page read. */
const namedLane = (e, badgeRead, pageRead) => ({ [moduleBadgeUrl(e)]: [badgeRead], [actionsUrl(e)]: [pageRead] });

/** An any-ref lane (ruling Q9): the any-ref page, then the badge and the page ON the resolved ref. */
const anyRefLane = (e, ref, anyPageRead, badgeRead, refPageRead) => ({
  [actionsUrl(e)]: [anyPageRead],
  [moduleBadgeUrl({ ...e, branch: ref })]: [badgeRead],
  [actionsUrl({ ...e, branch: ref })]: [refPageRead],
});

function selfTest() {
  let passed = 0;
  let failed = 0;
  // An assertion that RAISES is not an assertion: a thunk that throws is a FAIL with its message.
  const check = (name, ok, detail = '') => {
    let v = false;
    let why = detail;
    try { v = !!(typeof ok === 'function' ? ok() : ok); } catch (e) { v = false; why = `threw ${e && e.message}`; }
    if (v) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${why ? ` — ${why}` : ''}`); }
  };
  const PV = RELEASE_BLOCKING_WORKFLOWS.find((e) => e.workflow === 'publish-lane-preverify.yml');
  const NPM = RELEASE_BLOCKING_WORKFLOWS.find((e) => e.workflow === 'publish-npm.yml');
  const THREW = (e) => ({ lines: [`  self-test: evaluate threw ${e && e.message}`], verdict: 'THREW', red: [], exit: -1, rows: [] });
  const allRowLines = [];
  const gate = (table, opts) => {
    let r;
    try { r = evaluate(table, opts); } catch (e) { r = THREW(e); }
    allRowLines.push(...r.rows.map((x) => x.line));
    return r;
  };
  const read1 = (e, seq) => { try { return readConclusion({ ...e, cls: 'blocking' }, fixtureOpts(seq)); } catch (err) { return { row: 'THREW', agreement: 'THREW', reason: String(err && err.message) }; } };
  const vOf = (rec) => (rec.row === 'THREW' ? 'THREW' : verdictFor(rec, 'blocking'));
  const lineOf = (r, wf) => (r.rows.find((x) => x.workflow === wf) || {}).line ?? '';
  const noThrow = (r) => r.rows.length > 0 && r.rows.every((x) => !x.threw);

  const page = (...rows) => ({ body: fixturePage(rows) });
  const badge = (status, name = WF) => ({ body: fixtureBadge(name, status) });
  const pvRow = (icon) => fixtureRow({ repo: PV.repo, ...PV_RUN, name: WF, icon, ref: 'main' });
  const tagRow = (icon) => fixtureRow({ repo: NPM.repo, ...NPM_TAG_RUN, name: WF, icon, ref: TAG });
  const mainRow = (icon) => fixtureRow({ repo: NPM.repo, ...NPM_MAIN_RUN, name: WF, icon, ref: 'main' });
  const PVL = (b, icon) => namedLane(PV, b, page(pvRow(icon)));
  const NPML = (b, icon) => anyRefLane(NPM, TAG, page(tagRow(icon), mainRow('success')), b, page(tagRow(icon)));

  selfTestRunning = true;
  try {
    console.log('── the allow-list and the URLs the fetch seam bypasses ──');
    check('the allow-list declares exactly the two release-blocking workflows', RELEASE_BLOCKING_WORKFLOWS.length === 2 && !!PV && !!NPM);
    check('every shipped entry is well-formed', RELEASE_BLOCKING_WORKFLOWS.every((e) => entryDefect(e) === null));
    check('pre-verify is read on main', PV && badgeUrl(PV) === 'https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/actions/workflows/publish-lane-preverify.yml/badge.svg?branch=main', PV && badgeUrl(PV));
    // Corrected 2026-10-04 (OPS-XREPO-CI-RED-W1 CH4): the label below is kept byte-identical (ruling Q10). The URL it
    // pins is the DECLARED one; a no-param badge shows the DEFAULT branch, and under ruling Q9 the read resolves the newest
    // finished run's ref and reads ?branch=<ref> + ?query=branch%3A<ref> instead.
    check('publish-npm is read with NO branch filter (the only form that sees a tag-push run)', NPM && badgeUrl(NPM) === 'https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/actions/workflows/publish-npm.yml/badge.svg', NPM && badgeUrl(NPM));
    check('an entry with NO branch key refuses', entryDefect({ repo: 'o/r', workflow: 'w.yml' }) !== null);
    check('an entry with an empty branch refuses', entryDefect({ repo: 'o/r', workflow: 'w.yml', branch: '' }) !== null);
    check('an entry with branch null is a declaration, not a defect', entryDefect({ repo: 'o/r', workflow: 'w.yml', branch: null }) === null);
    check('the DECLARED URL of every shipped entry is the module\'s canonical badge URL (named: the URL read; any-ref: the base it refines)', () => RELEASE_BLOCKING_WORKFLOWS.every((e) => badgeUrl(e) === moduleBadgeUrl(e)));
    {
      // The one piece no fixture can exercise: the LIVE options. Assert the bypassed artifact itself.
      const lo = liveReadOpts();
      check('the LIVE read is pinned: curl transport, https://github.com, the module\'s Recover defaults, an EMPTY env, the real sleep', () => lo.host === 'https://github.com'
        && lo.reads === RECOVER_DEFAULTS.reads && lo.spacingS === RECOVER_DEFAULTS.spacingS && RECOVER_DEFAULTS.reads === 3 && RECOVER_DEFAULTS.spacingS === 60
        && lo.env && typeof lo.env === 'object' && Object.keys(lo.env).length === 0 && !('sleep' in lo)
        && typeof lo.fetchDoc === 'function' && String(lo.fetchDoc) === String(curlFetch()), JSON.stringify({ ...lo, fetchDoc: typeof lo.fetchDoc, env: `${Object.keys(lo.env ?? {}).length} key(s)` })); // never the env VALUES — a regression must not print secrets
      check('inside --self-test, a gate read with no injected options REFUSES instead of going live', () => { try { evaluate([]); return false; } catch (e) { return /would go LIVE/.test(e.message); } });
      {
        // The DEFAULT path of evaluate() (no injected options) under a POISONED environment: every stale export a
        // fixture session could leave behind. A spy stands in for the reader, so nothing goes live; it then drives
        // the REAL readConclusion with the options evaluate() handed it (transport swapped for a recorder).
        const POISON = { GHRC_FIXTURE_DIR: '/nonexistent-fx', XREPO_CI_FIXTURE_DIR: '/nonexistent-fx', GHRC_READS: '1', GHRC_SPACING_S: '0', GHRC_BADGE_HOST: 'https://example.invalid', XREPO_CI_BADGE_HOST: 'https://example.invalid' };
        const saved = Object.fromEntries(Object.keys(POISON).map((k) => [k, process.env[k]]));
        Object.assign(process.env, POISON);
        let handed = null;
        const seen = [];
        let rec = null;
        try {
          evaluate([PV], undefined, (input, opts) => {
            handed = opts;
            rec = readConclusion(input, { ...opts, fetchDoc: (u, x, n, f) => { seen.push(f ?? u); return { http: 404, body: '', contentType: null, date: null }; }, sleep: () => {} });
            return rec;
          });
        } finally {
          for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        }
        check('the DEFAULT evaluate() path hands the reader the pinned live options (curl, github.com, 3 × 60 s, env {})', () => !!handed && handed.host === 'https://github.com'
          && handed.reads === 3 && handed.spacingS === 60 && Object.keys(handed.env).length === 0 && String(handed.fetchDoc) === String(curlFetch()));
        check('…and under a poisoned env the read still targets github.com with 3 reads, never a fixture dir or another host', () => seen.length === 6
          && seen.every((u) => u.startsWith('https://github.com/')) && rec?.config?.reads === 3 && rec?.config?.spacing_s === 60, JSON.stringify({ n: seen.length, first: seen[0], cfg: rec?.config }));
      }
    }

    console.log('── one badge → one row, through the ONE module (gh-run-conclusion.mjs) ──');
    const one = (b, p) => read1(PV, namedLane(PV, b, p));
    check('passing is PASS', () => vOf(one(badge('passing'), page(pvRow('success')))) === 'PASS');
    check('failing is FAIL', () => vOf(one(badge('failing'), page(pvRow('failure')))) === 'FAIL');
    check('"no status" is INDETERMINATE, never PASS', () => { const r = one(badge('no status'), page(pvRow('success'))); return r.row === 8 && vOf(r) === 'INDETERMINATE'; });
    check('a brand-new GitHub word is INDETERMINATE, never PASS', () => { const r = one(badge('flaky-ish'), page(pvRow('success'))); return r.row === 8 && vOf(r) === 'INDETERMINATE'; });
    check('markup with no title is INDETERMINATE', () => { const r = one({ body: '<svg></svg>' }, page(pvRow('success'))); return r.row === 8 && vOf(r) === 'INDETERMINATE'; });
    check('HTTP 404 is INDETERMINATE, never FAIL', () => { const r = one({ http: 404, body: svg('failing') }, page(pvRow('failure'))); return r.row === 8 && vOf(r) === 'INDETERMINATE'; });
    check('a network error is INDETERMINATE', () => { const r = one({ http: 0 }, { http: 0 }); return r.row === 8 && vOf(r) === 'INDETERMINATE'; });

    console.log('── every bind row under class `blocking` (the badge is corroborated by the run\'s OWN record) ──');
    {
      const r1 = one(badge('passing'), page(pvRow('success')));
      check('row 1 — passing badge + successful run: AGREE, PASS, bound, decided on read 1', () => r1.row === 1 && r1.agreement === 'AGREE' && vOf(r1) === 'PASS' && r1.bound_run?.run_id === PV_RUN.runId && r1.reads === 1, `${r1.row}/${r1.agreement}/${r1.reads}`);
      const r2 = one(badge('failing'), page(pvRow('failure')));
      check('row 2 — failing badge + failed run: AGREE, FAIL, bound to that run', () => r2.row === 2 && r2.agreement === 'AGREE' && vOf(r2) === 'FAIL' && r2.bound_run?.run_number === PV_RUN.runNumber, `${r2.row}/${r2.agreement}`);
      const r3 = one(badge('failing'), page(pvRow('success')));
      check('row 3 — failing badge over a SUCCESSFUL run: DISAGREE, INDETERMINATE, nothing bound', () => r3.row === 3 && r3.agreement === 'DISAGREE' && vOf(r3) === 'INDETERMINATE' && !('bound_run' in r3), `${r3.row}/${r3.agreement}`);
      check('…a non-agreeing read is re-checked: all RECOVER_DEFAULTS.reads reads are taken before it decides', () => r3.reads === RECOVER_DEFAULTS.reads && r3.samples.length === RECOVER_DEFAULTS.reads, `reads ${r3.reads}`);
      const r4 = one(badge('passing'), page(pvRow('failure')));
      check('row 4 — PASSING badge over a FAILED run: DISAGREE, FAIL, bound to the failed run', () => r4.row === 4 && r4.agreement === 'DISAGREE' && vOf(r4) === 'FAIL' && r4.bound_run?.state === 'failure', `${r4.row}/${r4.agreement}`);
      const r5 = one(badge('failing'), { http: 503 });
      check('row 5 — failing badge, run record unavailable (badge-only): UNCORROBORATED, INDETERMINATE', () => r5.row === 5 && r5.agreement === 'UNCORROBORATED' && vOf(r5) === 'INDETERMINATE', `${r5.row}/${r5.agreement}`);
      const r6 = one(badge('passing'), { http: 503 });
      check('row 6 — passing badge, run record unavailable (badge-only): INDETERMINATE — a badge alone is never a PASS', () => r6.row === 6 && r6.agreement === 'UNCORROBORATED' && vOf(r6) === 'INDETERMINATE', `${r6.row}/${r6.agreement}`);
      const r6u = one(badge('passing'), page(pvRow('unknown')));
      check('row 6 — passing badge over an UNMEASURED run icon: INDETERMINATE (the walk stops, never guesses)', () => r6u.row === 6 && vOf(r6u) === 'INDETERMINATE' && r6u.reason === 'icon_unmeasured', `${r6u.row}/${r6u.reason}`);
      const r7 = one(badge('passing', 'Other Workflow'), page(pvRow('success')));
      check('row 7 — the badge and the run page name different workflows: DISAGREE, INDETERMINATE', () => r7.row === 7 && r7.reason === 'identity_mismatch' && vOf(r7) === 'INDETERMINATE', `${r7.row}/${r7.reason}`);
      const r8 = one(badge('no status'), page(pvRow('failure')));
      check('row 8 — an unreadable badge over a FAILED run: UNREADABLE, INDETERMINATE (never FAIL from prose)', () => r8.row === 8 && r8.agreement === 'UNREADABLE' && vOf(r8) === 'INDETERMINATE', `${r8.row}/${r8.agreement}`);
    }

    console.log('── the whole gate, end to end through the fetch seam ──');
    const both = (pv, npm) => fixtureOpts({ ...pv, ...npm });
    const PVS = { ok: PVL(badge('passing'), 'success'), red: PVL(badge('failing'), 'failure'), none: PVL(badge('no status'), 'success') };
    const NPMS = { ok: NPML(badge('passing'), 'success'), red: NPML(badge('failing'), 'failure'), down: { [actionsUrl(NPM)]: [{ http: 0 }] } };
    const cases = [
      ['both passing', both(PVS.ok, NPMS.ok), 'PASS', 'none'],
      ['pre-verify failing', both(PVS.red, NPMS.ok), 'FAIL', 'publish-lane-preverify.yml'],
      ['publish-npm failing', both(PVS.ok, NPMS.red), 'FAIL', 'publish-npm.yml'],
      ['both failing — today, measured 2026-10-03', both(PVS.red, NPMS.red), 'FAIL', 'publish-lane-preverify.yml,publish-npm.yml'],
      ['one "no status", one passing', both(PVS.none, NPMS.ok), 'INDETERMINATE', 'none'],
      ['one failing outranks one unreachable', both(PVS.red, NPMS.down), 'FAIL', 'publish-lane-preverify.yml'],
      ['everything unreachable', fixtureOpts({}), 'INDETERMINATE', 'none'],
    ];
    for (const [name, opts, want, wantRed] of cases) {
      const r = gate(RELEASE_BLOCKING_WORKFLOWS, opts);
      const text = r.lines.join('\n');
      check(`${name} → ${want}`, r.verdict === want && r.exit === EXIT[want] && noThrow(r), `${r.verdict}/${r.exit}`);
      check(`${name} → RED names exactly ${wantRed}`, text.includes(`RELEASE_READINESS_RED=${wantRed}\n`), text.split('\n').find((l) => l.startsWith('RELEASE_READINESS_RED=')));
      check(`${name} → the token is the LAST line`, r.lines[r.lines.length - 1] === `${TOKEN}=${want}`);
    }
    {
      const r = gate(RELEASE_BLOCKING_WORKFLOWS, both(PVS.ok, NPMS.red));
      const npmLine = r.lines.find((l) => l.includes('publish-npm.yml ('));
      check('a red row names its workflow, branch semantics and URL', !!npmLine && npmLine.startsWith('  x ') && npmLine.includes('any ref') && npmLine.includes(badgeUrl(NPM)), npmLine);
    }
    {
      const r = gate(RELEASE_BLOCKING_WORKFLOWS, both(PVS.ok, NPMS.ok));
      const pvLine = lineOf(r, PV.workflow);
      const npmLine = lineOf(r, NPM.workflow);
      check('each row line names ITS run and ITS ref (pre-verify #412 on main; publish-npm #29 on the RESOLVED tag)', pvLine.includes(`· agreement=AGREE · run #${PV_RUN.runNumber} (${PV_RUN.runId}) on main`) && npmLine.includes(`· agreement=AGREE · run #${NPM_TAG_RUN.runNumber} (${NPM_TAG_RUN.runId}) on ${TAG}`), `${pvLine} | ${npmLine}`);
      check('…and the URL each row prints is the badge it READ (publish-npm: ?branch=<resolved ref>)', pvLine.includes(`— ${moduleBadgeUrl(PV)} ·`) && npmLine.includes(`— ${moduleBadgeUrl({ ...NPM, branch: TAG })} ·`), npmLine);
    }

    console.log('── bind rows 3–8 through the whole gate (class `blocking`) ──');
    {
      const r4 = gate(RELEASE_BLOCKING_WORKFLOWS, both(PVL(badge('passing'), 'failure'), NPMS.ok));
      const l4 = lineOf(r4, PV.workflow);
      check('row 4 (passing badge, FAILED run) → FAIL, and RED names the workflow', r4.verdict === 'FAIL' && r4.exit === EXIT.FAIL && noThrow(r4) && r4.lines.includes('RELEASE_READINESS_RED=publish-lane-preverify.yml'), r4.lines.slice(-2).join(' | '));
      check('…its line is a red line naming the failed run it was bound to', l4.startsWith('  x ') && l4.includes(`· agreement=DISAGREE · run #${PV_RUN.runNumber} (${PV_RUN.runId}) on main`), l4);
      const r3 = gate(RELEASE_BLOCKING_WORKFLOWS, both(PVL(badge('failing'), 'success'), NPMS.ok));
      check('row 3 (failing badge over a successful run) → INDETERMINATE, RED none, no run named', r3.verdict === 'INDETERMINATE' && r3.lines.includes('RELEASE_READINESS_RED=none') && noThrow(r3) && lineOf(r3, PV.workflow).includes('· agreement=DISAGREE · reason=badge_failing_record_success') && !lineOf(r3, PV.workflow).includes('run #'), lineOf(r3, PV.workflow));
      const r5 = gate(RELEASE_BLOCKING_WORKFLOWS, both(namedLane(PV, badge('failing'), { http: 503 }), NPMS.ok));
      check('row 5 (badge-only failing) → INDETERMINATE through the gate', r5.verdict === 'INDETERMINATE' && noThrow(r5) && lineOf(r5, PV.workflow).includes('· agreement=UNCORROBORATED · reason=http_503'), lineOf(r5, PV.workflow));
      const r6 = gate(RELEASE_BLOCKING_WORKFLOWS, both(namedLane(PV, badge('passing'), { http: 503 }), NPMS.ok));
      check('row 6 (badge-only passing) → INDETERMINATE through the gate — never PASS', r6.verdict === 'INDETERMINATE' && r6.exit === EXIT.INDETERMINATE && noThrow(r6) && lineOf(r6, PV.workflow).startsWith('  ? '), lineOf(r6, PV.workflow));
      const r7 = gate(RELEASE_BLOCKING_WORKFLOWS, both(PVL(badge('passing', 'Other Workflow'), 'success'), NPMS.ok));
      check('row 7 (identity mismatch) → INDETERMINATE through the gate', r7.verdict === 'INDETERMINATE' && noThrow(r7) && lineOf(r7, PV.workflow).includes('reason=identity_mismatch'), lineOf(r7, PV.workflow));
      const r8 = gate(RELEASE_BLOCKING_WORKFLOWS, both(PVL(badge('no status'), 'failure'), NPMS.ok));
      check('row 8 (unreadable badge) → INDETERMINATE through the gate', r8.verdict === 'INDETERMINATE' && noThrow(r8) && lineOf(r8, PV.workflow).includes('· agreement=UNREADABLE · reason=badge_no_status'), lineOf(r8, PV.workflow));
    }

    console.log('── any ref (ruling Q9): publish-npm resolves the newest finished run\'s OWN ref ──');
    {
      const ok = gate(RELEASE_BLOCKING_WORKFLOWS, both(PVS.ok, NPMS.ok));
      const rec = (ok.rows.find((x) => x.workflow === NPM.workflow) || {}).record || {};
      check('the resolved ref is named in the row line (on v1.31.1) and carried on the record', lineOf(ok, NPM.workflow).includes(` on ${TAG}`) && rec.resolved_ref === TAG, lineOf(ok, NPM.workflow));
      // A failed TAG run after a green main, with the no-param (DEFAULT-branch) badge reading passing.
      const seen = [];
      const mem = memoryFetch({ ...PVS.ok, ...NPML(badge('failing'), 'failure'), [moduleBadgeUrl(NPM)]: [badge('passing')] });
      const tagFail = gate(RELEASE_BLOCKING_WORKFLOWS, { ...fixtureOpts({}), fetchDoc: (u, ...a) => { seen.push(u); return mem(u, ...a); } });
      const lt = lineOf(tagFail, NPM.workflow);
      check('a failed TAG run after a green main → FAIL, RED names publish-npm.yml', tagFail.verdict === 'FAIL' && noThrow(tagFail) && tagFail.lines.includes('RELEASE_READINESS_RED=publish-npm.yml'), tagFail.lines.slice(-2).join(' | '));
      check('…bound to the TAG run: #29 (37201506699) on v1.31.1, agreement=AGREE', lt.startsWith('  x ') && lt.includes(`· agreement=AGREE · run #${NPM_TAG_RUN.runNumber} (${NPM_TAG_RUN.runId}) on ${TAG}`), lt);
      check('…and the no-param (DEFAULT-branch) badge is never requested', seen.length > 0 && !seen.includes(moduleBadgeUrl(NPM)), JSON.stringify(seen));
      // An any-ref row whose newest finished run carries no ref binds NOTHING.
      const unres = gate(RELEASE_BLOCKING_WORKFLOWS, both(PVS.ok, { [actionsUrl(NPM)]: [page(fixtureRow({ repo: NPM.repo, ...NPM_TAG_RUN, name: WF, icon: 'success' }))] }));
      const lu = lineOf(unres, NPM.workflow);
      check('an unresolvable ref → INDETERMINATE, RED none', unres.verdict === 'INDETERMINATE' && unres.exit === EXIT.INDETERMINATE && noThrow(unres) && unres.lines.includes('RELEASE_READINESS_RED=none'), unres.lines.slice(-2).join(' | '));
      check('…its line says why (reason=ref_missing), names no run and no ref', lu.startsWith('  ? ') && lu.includes('· agreement=UNCORROBORATED · reason=ref_missing') && !lu.includes('run #') && !/ on \S+$/.test(lu), lu);
      // Resolved, but not bound: the ref is still named beside the reason.
      const dis = gate(RELEASE_BLOCKING_WORKFLOWS, both(PVS.ok, NPML(badge('failing'), 'success')));
      check('a resolved-but-unbound any-ref row names its ref beside the reason (row 3 on v1.31.1)', dis.verdict === 'INDETERMINATE' && noThrow(dis) && lineOf(dis, NPM.workflow).endsWith(`· agreement=DISAGREE · reason=badge_failing_record_success on ${TAG}`), lineOf(dis, NPM.workflow));
    }

    console.log('── containment: a read that THROWS verified nothing, and never hides a measured red ──');
    {
      const mem = memoryFetch({ ...PVS.ok, ...NPMS.red });
      const boom = gate(RELEASE_BLOCKING_WORKFLOWS, { ...fixtureOpts({}), fetchDoc: (u, ...a) => { if (u === moduleBadgeUrl(PV)) throw new Error('fixture transport exploded'); return mem(u, ...a); } });
      const lb = lineOf(boom, PV.workflow);
      check('a throwing read is its row\'s INDETERMINATE; the measured red elsewhere still reads FAIL', boom.verdict === 'FAIL' && boom.lines.includes('RELEASE_READINESS_RED=publish-npm.yml') && boom.rows.some((x) => x.threw && x.verdict === 'INDETERMINATE'), boom.lines.join(' | '));
      check('…and its line names the throw (reason=read_threw)', lb.startsWith('  ? ') && lb.includes('· agreement=UNREADABLE · reason=read_threw') && lb.includes('fixture transport exploded'), lb);
    }

    console.log('── vacuity: a corpus WE construct, so empty or malformed REFUSES ──');
    {
      const r = gate([], fixtureOpts({}));
      check('an EMPTY allow-list is INDETERMINATE, never PASS', r.verdict === 'INDETERMINATE');
      const seen = [];
      const mem = memoryFetch({});
      const m = gate([{ repo: 'o/r', workflow: 'w.yml' }], { ...fixtureOpts({}), fetchDoc: (u, ...a) => { seen.push(u); return mem(u, ...a); } });
      check('an entry that does not declare its branch is INDETERMINATE and says why', m.verdict === 'INDETERMINATE' && m.lines.some((l) => l.includes('does not DECLARE its branch')));
      check('…it is refused BEFORE any read (no document fetched)', seen.length === 0, JSON.stringify(seen));
    }

    console.log('── every row line carries the bound record ──');
    check(`every row line this self-test produced (${allRowLines.length}) carries exactly one 'agreement='`, allRowLines.length >= 30 && allRowLines.every((l) => l.split('agreement=').length === 2), allRowLines.find((l) => l.split('agreement=').length !== 2));

    console.log('── the token→exit mapping (a self-test of tokens alone cannot see a re-coded exit) ──');
    check('PASS → 0, FAIL → 1, INDETERMINATE → 3', EXIT.PASS === 0 && EXIT.FAIL === 1 && EXIT.INDETERMINATE === 3);
  } finally {
    selfTestRunning = false;
  }

  const total = passed + failed;
  console.log(`self-test: ${passed} passed, ${failed} failed`);
  if (total === 0) {
    // WE build this corpus, so zero assertions means the self-test built nothing. REFUSE.
    console.log(`${TOKEN}=INDETERMINATE`);
    return EXIT.INDETERMINATE;
  }
  if (failed > 0) {
    console.log(`${TOKEN}=FAIL`);
    return EXIT.FAIL;
  }
  console.log(`${TOKEN}=PASS`);
  return EXIT.PASS;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────

// realpath on BOTH sides: import.meta.url is already resolved and argv[1] is not, so a path
// through a symlink (macOS /tmp -> /private/tmp) would match neither branch and exit 0, tokenless.
const realOrSelf = (p) => { try { return realpathSync(p); } catch { return p; } };
const isMain = !!process.argv[1] && realOrSelf(path.resolve(process.argv[1])) === realOrSelf(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    if (process.argv.slice(2).includes('--self-test')) {
      process.exitCode = selfTest();
    } else {
      console.log('─── release readiness: the release-blocking workflows (allow-list of two) ───');
      console.log(`  each row binds the badge to the newest finished run's own record (gh-run-conclusion.mjs, class blocking); a non-agreeing read is re-checked — ${RECOVER_DEFAULTS.reads} reads, ${RECOVER_DEFAULTS.spacingS} s apart`);
      const r = evaluate();
      for (const l of r.lines) console.log(l);
      process.exitCode = r.exit;
    }
  } catch (e) {
    // Never die without a token — process death with no verdict is the one outcome the token law
    // forbids outright.
    console.log(`  fatal: ${e && e.message}`);
    console.log(`${TOKEN}=INDETERMINATE`);
    process.exitCode = EXIT.INDETERMINATE;
  }
}
