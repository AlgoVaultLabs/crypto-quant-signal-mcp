#!/usr/bin/env node
/**
 * OPS-SMITHERY-PUBLISH-LANE-W1 R2 — assert the Smithery catalogue agrees with our live origin.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────────
 *
 * Smithery stores a SNAPSHOT of an MCP server's tool list, taken when the server is published,
 * and never revisits it. `algovault/crypto-quant-signal-mcp` was submitted 2026-04-10 and never
 * republished, so for five months the listing advertised 3 tools and a description reading
 * "across 5 perp venues" while the origin served 8 tools. The listing is ranked in Smithery's
 * search, so that is not a dormant page — it is what an agent reads at selection time.
 *
 * A one-off republish resets the clock and the same drift returns on the next release. The
 * generator-level fix is that EVERY tag which publishes a version also re-scans Smithery, and
 * the lane fails closed when it cannot. This script is the "and then verify" half of that: the
 * re-scan is fired by `.github/workflows/publish-npm.yml`, and this gate is what decides whether
 * it actually took.
 *
 * ── IT IS A GENERAL PRIMITIVE, DELIBERATELY ─────────────────────────────────────────────────
 *
 * "Assert a remote catalogue agrees with our live origin" is not a Smithery-shaped problem. The
 * same three-fetch shape — read our version, read what we actually serve, read what the
 * catalogue believes — retires LobeHub drift, MCP Registry drift and DXT manifest drift. The
 * pure functions below are split from the fetch seam so a sibling gate can reuse them by
 * swapping only `fetchSmitheryListing`.
 *
 * ── TOKEN LAW ───────────────────────────────────────────────────────────────────────────────
 *
 *   node scripts/check-smithery-sync.mjs              # live gate (network)
 *   node scripts/check-smithery-sync.mjs --self-test  # two-way, vacuity-guarded, no network
 *
 *   SMITHERY_SYNC_VERDICT=PASS|FAIL|INDETERMINATE     0 / 1 / 3
 *
 * 3 is the token-law default for a NEW gate (CLAUDE.md § Verification gate patterns). Callers
 * gate on the TOKEN, never on the bare exit code.
 *
 * ── THE SECOND TOKEN, AND WHY ONE WAS NOT ENOUGH ────────────────────────────────────────────
 *
 * This gate reads a PUBLIC endpoint, so it runs with or without a credential. That is a feature
 * — a missing key must never suppress detection of real drift — but it creates a trap: with one
 * token, `exit 0` would encode both "we re-scanned and the listing agrees" and "we could not
 * re-scan and the stale listing happens to agree". That is exactly what the verdict-token law
 * forbids, and the second reading is the dangerous one: a missing key would ride silently on an
 * unchanged tool set and surface only at the next release that changes tools.
 *
 * So the lane emits a SECOND, independent line naming what the re-scan actually did:
 *
 *   SMITHERY_RESCAN=OK | SKIPPED_NO_CREDENTIAL | FAILED | NOT_ATTEMPTED
 *
 * This script never re-scans — it only verifies — so standalone it always prints
 * `NOT_ATTEMPTED`, which is the honest value. The workflow prints its own authoritative
 * `SMITHERY_RESCAN=` line AFTER this script's output, so a `grep … | tail -1` in the lane
 * always reads the lane's own state and never this one.
 *
 * `decideLaneOutcome()` below is the two-token matrix, exported so the lane's behaviour is
 * asserted HERE, in a self-test that can run it, rather than only in YAML nobody executes.
 *
 * ── MEASURED, SO NOBODY REDISCOVERS IT ──────────────────────────────────────────────────────
 *
 * `api.smithery.ai` sits behind Cloudflare and answers **403 error 1010 `browser_signature_banned`
 * to Python-urllib's default user-agent** (measured 2026-09-18). `curl` and Node's `fetch`
 * (undici) both answer 200 — verified on the same route, in the same minute, from the same
 * host. This gate therefore sets an explicit, identifiable UA: not to evade anything, but so
 * that if the ban ever widens, the log says which agent was refused instead of reading as an
 * auth failure. A 403 here is classified INDETERMINATE for the same reason.
 */
import path from 'node:path';
import url from 'node:url';

export const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

export const TOKEN = 'SMITHERY_SYNC_VERDICT';
export const RESCAN_TOKEN = 'SMITHERY_RESCAN';

/** 0=PASS / 1=FAIL / 3=INDETERMINATE. ONE meaning, ONE code, chosen locally. */
export const EXIT = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };

/**
 * SINGLE DERIVATION of the qualified name. Every URL below projects from this one value, and
 * the URL-encoded form is never written as a second literal.
 *
 * ⚠️ Do not grep for this string loosely. `algovault/crypto-quant-signal-mcp` is also a
 * SUBSTRING of the Hetzner path `/opt/algovault/crypto-quant-signal-mcp`, which appears in
 * unrelated files and has nothing to do with the registry slug.
 */
export const QUALIFIED_NAME = 'algovault/crypto-quant-signal-mcp';

export const SMITHERY_SERVER_URL = `https://api.smithery.ai/servers/${encodeURIComponent(QUALIFIED_NAME)}`;
export const HEALTH_URL = 'https://api.algovault.com/health';
export const MCP_URL = 'https://api.algovault.com/mcp';

/**
 * 🛑 THE VERIFICATION READ MUST CARRY A CACHE-BUSTER. This is not hygiene; without it this gate
 * fails a CORRECT re-scan on every single release.
 *
 * Measured 2026-09-18, immediately after a re-scan returned `status: SUCCESS` with
 * `Capabilities found: 8 tools`: a bare `GET /servers/{q}` still served the FIVE-MONTH-OLD
 * 3-tool snapshot, while the same URL with `?cb=<epoch>` served 8. The response carries
 *
 *   cache-control: public, max-age=60, s-maxage=14400, stale-while-revalidate=86400
 *
 * — a FOUR-HOUR shared-cache TTL with a 24h stale-while-revalidate window. The lane re-scans and
 * verifies seconds apart, so a bare read is guaranteed to observe the pre-re-scan body and would
 * print FAIL on a listing that had just been repaired: an instrument returning a confident ALARM,
 * which is the failure mode that survives review because the number it returns is real.
 *
 * This is the same law as "a CDN-cached raw read is controlled by a cache-buster or a pinned SHA,
 * NEVER by the ref form" (CLAUDE.md § Verification gate patterns) in a new substrate. The control
 * is the buster, so it is a function, derived once, and the `no-cache` request header is belt to
 * its braces — a request header cannot invalidate a SHARED cache on its own.
 */
export const listingReadUrl = (now = Date.now()) => `${SMITHERY_SERVER_URL}?cb=${now}`;

const UA = 'algovault-smithery-sync-gate/1.0 (+https://algovault.com)';
const TIMEOUT_MS = 20000;

/**
 * The baked-venue-count predicate.
 *
 * The public-copy HELD list forbids a hardcoded venue count on every surface, and that count is
 * the defect this wave repairs — the incumbent Smithery description reads "across 5 perp venues"
 * while real coverage has moved. Word-boundaried on both ends so `cross-venue` (no count) and
 * `4h timeframes` (a timeframe token, not a count) stay clean. Verified against the incumbent
 * string before shipping; both directions are asserted in the self-test.
 */
export const BAKED_VENUE_COUNT = /\b\d+\s*(perp|perpetual|derivatives?)?\s*venues?\b/i;

export function hasBakedVenueCount(description) {
  return BAKED_VENUE_COUNT.test(String(description ?? ''));
}

// ── pure parsers, split from the fetch seam ───────────────────────────────────────────────────
//
// A hermetic self-test is structurally blind to exactly what its own seam replaces, so the three
// response readers live out here as pure functions and are asserted directly. Each returns null
// for "handed something I could not parse", which the caller maps to INDETERMINATE — never to a
// clean result.

/** `{"status":"ok",…,"version":"1.30.0"}` → `"1.30.0"`, or null. */
export function parseHealthVersion(body) {
  try {
    const v = JSON.parse(String(body)).version;
    return typeof v === 'string' && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * The MCP response body, which may be SSE-framed.
 *
 * The remote transport runs STATELESS (`sessionIdGenerator: undefined`), so there is no
 * `Mcp-Session-Id` and its absence is CORRECT — this reader never asserts on one. What it must
 * handle is the framing: `content-type: text/event-stream` bodies arrive as `event: message\n
 * data: {…}`, and a plain `application/json` body arrives bare. Branch on the shape, never on an
 * assumption.
 */
export function parseToolNames(body) {
  const raw = String(body ?? '');
  let json = raw;
  if (/^data: /m.test(raw)) {
    const frames = raw.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
    if (frames.length === 0) return null;
    json = frames[0];
  }
  try {
    const tools = JSON.parse(json)?.result?.tools;
    if (!Array.isArray(tools)) return null;
    const names = tools.map((t) => t?.name).filter((n) => typeof n === 'string');
    return names.length === tools.length ? names.slice().sort() : null;
  } catch {
    return null;
  }
}

/**
 * The Smithery listing.
 *
 * ⚠️ `GET /servers/{qualifiedName}` returns exactly: connections, deploymentUrl, description,
 * displayName, iconUrl, prompts, qualifiedName, remote, resources, security, tools. It does NOT
 * carry `createdAt` or `useCount` — those are UI-only, and a gate keyed on either would read
 * `undefined` forever without ever failing. Read only what the endpoint actually serves.
 */
export function parseSmitheryListing(body) {
  try {
    const d = JSON.parse(String(body));
    if (!Array.isArray(d?.tools)) return null;
    const names = d.tools.map((t) => t?.name).filter((n) => typeof n === 'string');
    if (names.length !== d.tools.length) return null;
    return { tools: names.slice().sort(), description: typeof d.description === 'string' ? d.description : '' };
  } catch {
    return null;
  }
}

// ── the decision ──────────────────────────────────────────────────────────────────────────────

const setDiff = (a, b) => a.filter((x) => !b.includes(x));

/**
 * Decide the content verdict from three already-fetched observations.
 *
 * `null` for any observation means "handed it, could not parse / could not reach" — always
 * INDETERMINATE, never FAIL, per the vacuity law: empty-vs-unparseable is the line.
 *
 * A live tool list of length ZERO is also INDETERMINATE rather than a vacuous PASS. The origin
 * was supposed to fill that corpus; if it served nothing there is nothing to agree about, and
 * comparing empty to empty would report a clean catalogue for a dead server.
 */
export function decide({ health, live, listing }) {
  const reasons = [];
  if (health === null) {
    reasons.push('could not read a version from the origin /health — the gate verified nothing');
    return { verdict: 'INDETERMINATE', reasons };
  }
  if (live === null) {
    reasons.push('could not parse tools/list from the live origin — the gate verified nothing');
    return { verdict: 'INDETERMINATE', reasons };
  }
  if (live.length === 0) {
    reasons.push('the live origin served ZERO tools — nothing to compare, refusing a vacuous pass');
    return { verdict: 'INDETERMINATE', reasons };
  }
  if (listing === null) {
    reasons.push('could not read the Smithery listing — the gate verified nothing');
    return { verdict: 'INDETERMINATE', reasons };
  }

  let verdict = 'PASS';
  const missing = setDiff(live, listing.tools);
  const extra = setDiff(listing.tools, live);
  if (live.length !== listing.tools.length || missing.length > 0 || extra.length > 0) {
    verdict = 'FAIL';
    reasons.push(
      `tool sets diverge — origin serves ${live.length} [${live.join(', ')}], ` +
        `Smithery advertises ${listing.tools.length} [${listing.tools.join(', ')}]` +
        (missing.length ? `; absent from the listing: ${missing.join(', ')}` : '') +
        (extra.length ? `; advertised but not served: ${extra.join(', ')}` : ''),
    );
  }
  if (hasBakedVenueCount(listing.description)) {
    verdict = 'FAIL';
    reasons.push(
      `the listing description carries a baked venue count (${JSON.stringify(
        listing.description.match(BAKED_VENUE_COUNT)[0],
      )}) — the public-copy HELD list forbids one on every surface`,
    );
  }
  if (verdict === 'PASS') {
    reasons.push(
      `origin v${health} serves ${live.length} tools and Smithery advertises the same set; ` +
        'description carries no venue count',
    );
  }
  return { verdict, reasons };
}

/**
 * The lane's two-token matrix, exported so it is asserted by a self-test that RUNS it rather
 * than only described in YAML that nothing exercises pre-merge.
 *
 * `level` is the GitHub annotation level; `exit` is the step's exit code.
 *
 *   any            × FAIL           → 1, error   (content drift is a real defect, always)
 *   any            × INDETERMINATE  → 0, warning (verified nothing; npm already published)
 *   OK             × PASS           → 0, quiet
 *   SKIPPED_*      × PASS           → 0, warning (correct BY LUCK, not by verification)
 *   NOT_ATTEMPTED  × PASS           → 0, warning (same reasoning as SKIPPED)
 *   FAILED         × PASS           → 1, error   (a 4xx/5xx from an ATTEMPTED re-scan is a real
 *                                                 defect even when the listing happens to agree)
 *   anything unrecognised           → 1, error   (a missing token is never a pass)
 */
export const RESCAN_STATES = ['OK', 'SKIPPED_NO_CREDENTIAL', 'FAILED', 'NOT_ATTEMPTED'];

export function decideLaneOutcome(rescan, sync) {
  if (sync === 'FAIL') return { exit: 1, level: 'error' };
  if (sync === 'INDETERMINATE') return { exit: 0, level: 'warning' };
  if (sync !== 'PASS') return { exit: 1, level: 'error' };
  if (rescan === 'OK') return { exit: 0, level: 'quiet' };
  if (rescan === 'SKIPPED_NO_CREDENTIAL' || rescan === 'NOT_ATTEMPTED') return { exit: 0, level: 'warning' };
  return { exit: 1, level: 'error' };
}

// ── the fetch seam ────────────────────────────────────────────────────────────────────────────

async function getText(target, init = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(target, {
      ...init,
      signal: ctl.signal,
      headers: { 'User-Agent': UA, ...(init.headers ?? {}) },
    });
    const text = await res.text();
    return { status: res.status, text };
  } catch (err) {
    return { status: null, text: '', error: err?.message ?? String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function observe() {
  const h = await getText(HEALTH_URL);
  const health = h.status === 200 ? parseHealthVersion(h.text) : null;
  if (health === null) console.error(`? /health: ${h.status ?? h.error}`);

  const m = await getText(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  const live = m.status === 200 ? parseToolNames(m.text) : null;
  if (live === null) console.error(`? tools/list: ${m.status ?? m.error}`);

  const s = await getText(listingReadUrl(), { headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' } });
  const listing = s.status === 200 ? parseSmitheryListing(s.text) : null;
  if (listing === null) console.error(`? Smithery listing: ${s.status ?? s.error}`);

  return { health, live, listing };
}

// ── self-test ─────────────────────────────────────────────────────────────────────────────────
//
// Assertions NEVER raise: a broken subject must print SELF-TEST: FAIL, because an assertion that
// aborts the suite converts "proven able to fail" into "crashes".

let selfTestPass = 0;
let selfTestFail = 0;

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) selfTestPass += 1;
  else {
    selfTestFail += 1;
    console.error(`  ✗ ${label}: expected ${e}, got ${a}`);
  }
}

/** The real incumbent Smithery description, verbatim — the string this gate exists to reject. */
export const INCUMBENT_DESCRIPTION =
  'The Brain Layer for AI Trading Agents — one MCP call returns a composite trade verdict ' +
  '(direction, confidence, regime) across 5 perp venues, plus cross-venue funding-rate arb scans ' +
  'and market-regime reads. On-chain Merkle-verified track record. Free tier, no card.';

function selfTest() {
  // VACUITY GUARD AT CONSTRUCTION — here WE build the corpus, so empty means the test built
  // nothing, which is a defect in the test. Refuse. (At runtime the world builds it, and the
  // correct verdict over an unreachable world is INDETERMINATE, handled in `decide`.)
  const EIGHT = [
    'chat_knowledge', 'get_market_regime', 'get_track_record', 'get_trade_call',
    'get_trade_signal', 'scan_funding_arb', 'scan_trade_calls', 'search_knowledge',
  ];
  const THREE = ['get_market_regime', 'get_trade_signal', 'scan_funding_arb'];
  const CLEAN_DESC = 'Composite BUY/SELL/HOLD verdicts for crypto perpetual futures.';
  const scenarios = [
    { health: '1.30.0', live: EIGHT, listing: { tools: EIGHT, description: CLEAN_DESC } },
    { health: '1.30.0', live: EIGHT, listing: { tools: THREE, description: CLEAN_DESC } },
  ];
  if (scenarios.length === 0 || EIGHT.length === 0 || THREE.length === 0) {
    console.error('✗ self-test corpus is empty — refusing to report a result over nothing.');
    console.log(`${RESCAN_TOKEN}=NOT_ATTEMPTED`);
    console.log(`${TOKEN}=INDETERMINATE`);
    return EXIT.INDETERMINATE;
  }

  // 1 — the happy path, and the FAIL it must be able to produce.
  check('equal sets + clean description ⇒ PASS', decide(scenarios[0]).verdict, 'PASS');
  check('8 vs 3 ⇒ FAIL', decide(scenarios[1]).verdict, 'FAIL');
  check(
    'the FAIL names BOTH sets',
    decide(scenarios[1]).reasons.some((r) => r.includes('origin serves 8') && r.includes('Smithery advertises 3')),
    true,
  );

  // 2 — same COUNT, different NAMES. A count-only comparison reads this as clean, which is the
  // whole reason the contract says "counts equal AND the name sets equal".
  const renamed = THREE.slice(0, 2).concat('get_trade_call').sort();
  check(
    'same count, different names ⇒ FAIL',
    decide({ health: '1.30.0', live: THREE, listing: { tools: renamed, description: CLEAN_DESC } }).verdict,
    'FAIL',
  );

  // 3 — the three unreachable/unparseable branches. Handed-and-unreadable is INDETERMINATE.
  check('health unreadable ⇒ INDETERMINATE', decide({ health: null, live: EIGHT, listing: scenarios[0].listing }).verdict, 'INDETERMINATE');
  check('tools/list unparseable ⇒ INDETERMINATE', decide({ health: '1.30.0', live: null, listing: scenarios[0].listing }).verdict, 'INDETERMINATE');
  check('Smithery unreachable ⇒ INDETERMINATE', decide({ health: '1.30.0', live: EIGHT, listing: null }).verdict, 'INDETERMINATE');
  check('zero live tools ⇒ INDETERMINATE, never a vacuous PASS', decide({ health: '1.30.0', live: [], listing: { tools: [], description: CLEAN_DESC } }).verdict, 'INDETERMINATE');

  // 4 — the baked-count rule, both directions, against the REAL incumbent string.
  check('the incumbent description FIRES the baked-count rule', hasBakedVenueCount(INCUMBENT_DESCRIPTION), true);
  check('the replacement copy does NOT fire it', hasBakedVenueCount(
    'Composite BUY/SELL/HOLD verdicts for crypto perpetual futures — cross-venue signal ' +
    'interpretation, funding-rate arbitrage scanning, market-regime detection, and an ' +
    'on-chain-anchored track record. Built for AI agents.',
  ), false);
  check('"12 venues" fires', hasBakedVenueCount('supports 12 venues today'), true);
  check('"8 perpetual venues" fires', hasBakedVenueCount('8 perpetual venues'), true);
  check('"3 derivatives venues" fires', hasBakedVenueCount('3 derivatives venues'), true);
  check('"cross-venue" alone does NOT fire', hasBakedVenueCount('cross-venue funding scans'), false);
  check('"4h timeframes" does NOT fire (a timeframe is not a count)', hasBakedVenueCount('4h timeframes'), false);
  check('a venue with no count does NOT fire', hasBakedVenueCount('one perp venue story'), false);
  check(
    'a baked count FAILs even when the tool sets agree',
    decide({ health: '1.30.0', live: EIGHT, listing: { tools: EIGHT, description: INCUMBENT_DESCRIPTION } }).verdict,
    'FAIL',
  );

  // 5 — THE BYPASSED ARTIFACTS. These parsers are what the fetch seam replaces, so nothing else
  // in this suite would ever execute them. Push real response shapes through each one.
  check('health parser reads the version', parseHealthVersion('{"status":"ok","server":"crypto-quant-signal-mcp","version":"1.30.0","stripe":true}'), '1.30.0');
  check('health parser on garbage ⇒ null', parseHealthVersion('<html>502</html>'), null);
  check('health parser on a version-less body ⇒ null', parseHealthVersion('{"status":"ok"}'), null);
  check(
    'tools parser reads an SSE-FRAMED body (the live framing)',
    parseToolNames('event: message\ndata: {"result":{"tools":[{"name":"b"},{"name":"a"}]},"jsonrpc":"2.0","id":2}\n\n'),
    ['a', 'b'],
  );
  check(
    'tools parser reads a BARE JSON body too',
    parseToolNames('{"result":{"tools":[{"name":"a"}]},"jsonrpc":"2.0","id":2}'),
    ['a'],
  );
  check('tools parser on a JSON-RPC error ⇒ null', parseToolNames('{"error":{"code":-32000},"jsonrpc":"2.0","id":2}'), null);
  check('tools parser on garbage ⇒ null', parseToolNames('not json at all'), null);
  check(
    'listing parser reads tools + description',
    parseSmitheryListing('{"qualifiedName":"x","description":"d","tools":[{"name":"t2"},{"name":"t1"}]}'),
    { tools: ['t1', 't2'], description: 'd' },
  );
  check('listing parser tolerates a missing description', parseSmitheryListing('{"tools":[]}'), { tools: [], description: '' });
  check('listing parser on a tools-less body ⇒ null', parseSmitheryListing('{"qualifiedName":"x"}'), null);
  check('listing parser on a Cloudflare HTML 403 ⇒ null', parseSmitheryListing('<html>error 1010</html>'), null);

  // 6 — THE TWO-TOKEN MATRIX. All five ratified rows, both directions, plus the unrecognised
  // case. Asserted here because the lane's YAML is not executed pre-merge by anything.
  check('OK × PASS ⇒ 0, quiet', decideLaneOutcome('OK', 'PASS'), { exit: 0, level: 'quiet' });
  check('SKIPPED_NO_CREDENTIAL × PASS ⇒ 0, WARNING (correct by luck, never silent)', decideLaneOutcome('SKIPPED_NO_CREDENTIAL', 'PASS'), { exit: 0, level: 'warning' });
  check('NOT_ATTEMPTED × PASS ⇒ 0, warning', decideLaneOutcome('NOT_ATTEMPTED', 'PASS'), { exit: 0, level: 'warning' });
  check('FAILED × PASS ⇒ 1, error (an attempted re-scan that failed is a real defect)', decideLaneOutcome('FAILED', 'PASS'), { exit: 1, level: 'error' });
  for (const r of RESCAN_STATES) {
    check(`${r} × INDETERMINATE ⇒ 0, warning`, decideLaneOutcome(r, 'INDETERMINATE'), { exit: 0, level: 'warning' });
    check(`${r} × FAIL ⇒ 1, error`, decideLaneOutcome(r, 'FAIL'), { exit: 1, level: 'error' });
  }
  check('a MISSING token is never a pass', decideLaneOutcome('OK', ''), { exit: 1, level: 'error' });
  check('an unrecognised token is never a pass', decideLaneOutcome('OK', 'GREEN'), { exit: 1, level: 'error' });
  check('an unrecognised RESCAN state with PASS is never quiet', decideLaneOutcome('WAT', 'PASS'), { exit: 1, level: 'error' });

  // 7 — TOKEN → EXIT-CODE MAPPING. Asserting the token alone once left a sibling gate fully
  // green after its INDETERMINATE mapping was re-coded to 0; assert the map itself.
  check('PASS ⇒ 0', EXIT.PASS, 0);
  check('FAIL ⇒ 1', EXIT.FAIL, 1);
  check('INDETERMINATE ⇒ 3', EXIT.INDETERMINATE, 3);

  // 8 — the identifier is derived ONCE and encoded, never written as a second literal.
  check('the server URL is derived from QUALIFIED_NAME', SMITHERY_SERVER_URL.endsWith('/algovault%2Fcrypto-quant-signal-mcp'), true);

  // 9 — THE CACHE-BUSTER, asserted because a missing one fails a CORRECT re-scan every release.
  // Measured: the listing endpoint serves s-maxage=14400, and the lane verifies seconds after it
  // re-scans. A bare read there is an instrument that returns a confident ALARM.
  check('the verification read carries a cache-buster', /[?&]cb=\d+$/.test(listingReadUrl(1758182400000)), true);
  check('the buster is derived from the canonical URL', listingReadUrl(7).startsWith(`${SMITHERY_SERVER_URL}?`), true);
  check('two reads do not share a buster value', listingReadUrl(1) === listingReadUrl(2), false);

  const total = selfTestPass + selfTestFail;
  if (total === 0) {
    console.error('✗ self-test ran ZERO assertions — refusing to report a pass.');
    console.log(`${RESCAN_TOKEN}=NOT_ATTEMPTED`);
    console.log(`${TOKEN}=INDETERMINATE`);
    return EXIT.INDETERMINATE;
  }
  if (selfTestFail > 0) {
    console.error(`✗ SELF-TEST: FAIL (${selfTestFail}) — ${selfTestFail} of ${total} assertion(s) failed.`);
    console.log(`${RESCAN_TOKEN}=NOT_ATTEMPTED`);
    console.log(`${TOKEN}=FAIL`);
    return EXIT.FAIL;
  }
  console.log(
    `✓ self-test passed — ${total} assertions across 8 scenarios ` +
      '(must-fire, must-not-fire, vacuity, seam parsers, two-token matrix, token→exit map).',
  );
  console.log(`${RESCAN_TOKEN}=NOT_ATTEMPTED`);
  console.log(`${TOKEN}=PASS`);
  return EXIT.PASS;
}

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();

  const result = decide(await observe());
  for (const r of result.reasons) {
    console.log(`${result.verdict === 'PASS' ? '✓' : result.verdict === 'FAIL' ? '✗' : '?'} ${r}`);
  }
  // This script VERIFIES; it never re-scans. NOT_ATTEMPTED is the honest value, and the lane
  // prints its own authoritative line after this one.
  console.log(`${RESCAN_TOKEN}=NOT_ATTEMPTED`);
  console.log(`${TOKEN}=${result.verdict}`);
  return EXIT[result.verdict];
}

main().then(
  (code) => process.exit(code),
  (err) => {
    // The one outcome the token law forbids is dying with no token at all.
    console.error(`✗ unhandled: ${err?.stack ?? err}`);
    console.log(`${RESCAN_TOKEN}=NOT_ATTEMPTED`);
    console.log(`${TOKEN}=INDETERMINATE`);
    process.exit(EXIT.INDETERMINATE);
  },
);
