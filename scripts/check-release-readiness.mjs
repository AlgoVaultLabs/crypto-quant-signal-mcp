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
 *
 * ── BRANCH SEMANTICS ARE DECLARED PER ENTRY, NEVER INFERRED ─────────────────────────────────
 * A badge reports the newest run on ONE branch when `?branch=` is given, and the newest run on ANY
 * ref when it is not. A tag-push run carries the TAG as its branch, so `?branch=main` structurally
 * cannot see a release run — measured 2026-10-03: publish-npm.yml at `?branch=main` reports run
 * 32990545311, a manual dispatch from 2026-08-26, and `?branch=main&event=push` reads "no status".
 * So every entry states `branch` explicitly: a branch name, or `null` meaning "latest run on any
 * ref". An entry whose `branch` key is ABSENT refuses (INDETERMINATE). The shared xrepo canary
 * deliberately refuses an undeclared branch; this script is the one place that declares one.
 *
 * ── VERDICT CONTRACT ────────────────────────────────────────────────────────────────────────
 *   RELEASE_READINESS_VERDICT=PASS           exit 0   every listed workflow reads `passing`
 *   RELEASE_READINESS_VERDICT=FAIL           exit 1   ≥1 reads `failing` (cancelled renders so too)
 *   RELEASE_READINESS_VERDICT=INDETERMINATE  exit 3   none failing, ≥1 unreadable / "no status"
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
 *
 * Usage:
 *   node scripts/check-release-readiness.mjs              # read the live badges
 *   node scripts/check-release-readiness.mjs --self-test  # every state, both directions, offline
 */
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseBadgeTitle } from '../ops/monitoring/deploy-drift-canary.mjs';

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

/** The badge URL — the one piece the fetch seam bypasses, so the self-test asserts its shape. */
export function badgeUrl(e) {
  const base = `${BADGE_HOST}/${e.repo}/actions/workflows/${e.workflow}/badge.svg`;
  return e.branch === null ? base : `${base}?branch=${encodeURIComponent(e.branch)}`;
}

export function branchLabel(e) {
  return e.branch === null ? 'any ref' : `branch ${e.branch}`;
}

/** One fetched badge → one row verdict. Pure. */
export function classifyRead({ http, body, error }) {
  if (error) return { verdict: 'INDETERMINATE', state: 'unreachable', detail: String(error) };
  if (http !== 200) return { verdict: 'INDETERMINATE', state: 'unreadable', detail: `badge HTTP ${http}` };
  const state = parseBadgeTitle(body);
  if (state === 'passing') return { verdict: 'PASS', state, detail: 'passing' };
  if (state === 'failing') return { verdict: 'FAIL', state, detail: 'failing' };
  return { verdict: 'INDETERMINATE', state: 'unknown', detail: 'badge reads "no status" or carries no parseable state' };
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

async function liveFetch(url) {
  try {
    const res = await fetch(url, {
      headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'algovault-release-readiness' },
      signal: AbortSignal.timeout(20_000),
    });
    return { http: res.status, body: await res.text() };
  } catch (e) {
    return { error: e && (e.cause?.code || e.name || e.message) };
  }
}

/** The whole gate, with the fetch injected. Returns { lines, verdict, exit }. */
export async function evaluate(table = RELEASE_BLOCKING_WORKFLOWS, fetchFn = liveFetch) {
  const lines = [];
  const rows = [];
  for (const e of table) {
    const defect = entryDefect(e);
    const name = e && typeof e.workflow === 'string' ? e.workflow : '<malformed entry>';
    if (defect) {
      rows.push({ workflow: name, verdict: 'INDETERMINATE' });
      lines.push(`  ? ${name}: REFUSED — ${defect}`);
      continue;
    }
    const url = badgeUrl(e);
    const r = classifyRead(await fetchFn(url));
    rows.push({ workflow: e.workflow, verdict: r.verdict });
    const glyph = r.verdict === 'PASS' ? '+' : r.verdict === 'FAIL' ? 'x' : '?';
    lines.push(`  ${glyph} ${e.workflow} (${e.repo}, ${branchLabel(e)}): ${r.detail} — ${url}`);
  }
  const agg = aggregate(rows);
  lines.push(`  ${agg.reason}`);
  lines.push(`RELEASE_READINESS_RED=${agg.red.length ? agg.red.join(',') : 'none'}`);
  lines.push(`${TOKEN}=${agg.verdict}`);
  return { lines, verdict: agg.verdict, red: agg.red, exit: EXIT[agg.verdict] };
}

// ───────────────────────────────────────────────────────────────────────────────────────────────

const svg = (state) => `<svg xmlns="http://www.w3.org/2000/svg"><title>Some Workflow - ${state}</title></svg>`;

/** A fetch seam keyed by URL. Anything not registered is a network error — never a pass. */
function fixtureFetch(map) {
  return async (url) => (Object.prototype.hasOwnProperty.call(map, url) ? map[url] : { error: 'ENOTFOUND (unregistered fixture)' });
}

async function selfTest() {
  let passed = 0;
  let failed = 0;
  const check = (name, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
  };
  const PV = RELEASE_BLOCKING_WORKFLOWS.find((e) => e.workflow === 'publish-lane-preverify.yml');
  const NPM = RELEASE_BLOCKING_WORKFLOWS.find((e) => e.workflow === 'publish-npm.yml');

  console.log('── the allow-list and the URLs the fetch seam bypasses ──');
  check('the allow-list declares exactly the two release-blocking workflows', RELEASE_BLOCKING_WORKFLOWS.length === 2 && !!PV && !!NPM);
  check('every shipped entry is well-formed', RELEASE_BLOCKING_WORKFLOWS.every((e) => entryDefect(e) === null));
  check('pre-verify is read on main', PV && badgeUrl(PV) === 'https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/actions/workflows/publish-lane-preverify.yml/badge.svg?branch=main', PV && badgeUrl(PV));
  check('publish-npm is read with NO branch filter (the only form that sees a tag-push run)', NPM && badgeUrl(NPM) === 'https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/actions/workflows/publish-npm.yml/badge.svg', NPM && badgeUrl(NPM));
  check('an entry with NO branch key refuses', entryDefect({ repo: 'o/r', workflow: 'w.yml' }) !== null);
  check('an entry with an empty branch refuses', entryDefect({ repo: 'o/r', workflow: 'w.yml', branch: '' }) !== null);
  check('an entry with branch null is a declaration, not a defect', entryDefect({ repo: 'o/r', workflow: 'w.yml', branch: null }) === null);

  console.log('── one badge → one row, through the SHARED parser (deploy-drift-canary.mjs) ──');
  check('passing is PASS', classifyRead({ http: 200, body: svg('passing') }).verdict === 'PASS');
  check('failing is FAIL', classifyRead({ http: 200, body: svg('failing') }).verdict === 'FAIL');
  check('"no status" is INDETERMINATE, never PASS', classifyRead({ http: 200, body: svg('no status') }).verdict === 'INDETERMINATE');
  check('a brand-new GitHub word is INDETERMINATE, never PASS', classifyRead({ http: 200, body: svg('flaky-ish') }).verdict === 'INDETERMINATE');
  check('markup with no title is INDETERMINATE', classifyRead({ http: 200, body: '<svg></svg>' }).verdict === 'INDETERMINATE');
  check('HTTP 404 is INDETERMINATE, never FAIL', classifyRead({ http: 404, body: svg('failing') }).verdict === 'INDETERMINATE');
  check('a network error is INDETERMINATE', classifyRead({ error: 'ETIMEDOUT' }).verdict === 'INDETERMINATE');

  console.log('── the whole gate, end to end through the fetch seam ──');
  const both = (pv, npm) => fixtureFetch({ [badgeUrl(PV)]: pv, [badgeUrl(NPM)]: npm });
  const ok = { http: 200, body: svg('passing') };
  const red = { http: 200, body: svg('failing') };
  const none = { http: 200, body: svg('no status') };
  const cases = [
    ['both passing', both(ok, ok), 'PASS', 'none'],
    ['pre-verify failing', both(red, ok), 'FAIL', 'publish-lane-preverify.yml'],
    ['publish-npm failing', both(ok, red), 'FAIL', 'publish-npm.yml'],
    ['both failing — today, measured 2026-10-03', both(red, red), 'FAIL', 'publish-lane-preverify.yml,publish-npm.yml'],
    ['one "no status", one passing', both(none, ok), 'INDETERMINATE', 'none'],
    ['one failing outranks one unreachable', both(red, { error: 'ECONNRESET' }), 'FAIL', 'publish-lane-preverify.yml'],
    ['everything unreachable', fixtureFetch({}), 'INDETERMINATE', 'none'],
  ];
  for (const [name, fetchFn, want, wantRed] of cases) {
    const r = await evaluate(RELEASE_BLOCKING_WORKFLOWS, fetchFn);
    const text = r.lines.join('\n');
    check(`${name} → ${want}`, r.verdict === want && r.exit === EXIT[want], `${r.verdict}/${r.exit}`);
    check(`${name} → RED names exactly ${wantRed}`, text.includes(`RELEASE_READINESS_RED=${wantRed}\n`), text.split('\n').find((l) => l.startsWith('RELEASE_READINESS_RED=')));
    check(`${name} → the token is the LAST line`, r.lines[r.lines.length - 1] === `${TOKEN}=${want}`);
  }
  {
    const r = await evaluate(RELEASE_BLOCKING_WORKFLOWS, both(ok, red));
    const npmLine = r.lines.find((l) => l.includes('publish-npm.yml ('));
    check('a red row names its workflow, branch semantics and URL', !!npmLine && npmLine.startsWith('  x ') && npmLine.includes('any ref') && npmLine.includes(badgeUrl(NPM)), npmLine);
  }

  console.log('── vacuity: a corpus WE construct, so empty or malformed REFUSES ──');
  {
    const r = await evaluate([], fixtureFetch({}));
    check('an EMPTY allow-list is INDETERMINATE, never PASS', r.verdict === 'INDETERMINATE');
    const m = await evaluate([{ repo: 'o/r', workflow: 'w.yml' }], fixtureFetch({}));
    check('an entry that does not declare its branch is INDETERMINATE and says why', m.verdict === 'INDETERMINATE' && m.lines.some((l) => l.includes('does not DECLARE its branch')));
  }

  console.log('── the token→exit mapping (a self-test of tokens alone cannot see a re-coded exit) ──');
  check('PASS → 0, FAIL → 1, INDETERMINATE → 3', EXIT.PASS === 0 && EXIT.FAIL === 1 && EXIT.INDETERMINATE === 3);

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
  (async () => {
    try {
      if (process.argv.slice(2).includes('--self-test')) {
        process.exitCode = await selfTest();
      } else {
        console.log('─── release readiness: the release-blocking workflows (allow-list of two) ───');
        const r = await evaluate();
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
  })();
}
