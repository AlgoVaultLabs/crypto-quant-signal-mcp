#!/usr/bin/env node
/**
 * check-readme-links.mjs — RELEASE-v1.28.0-AND-README-LINK-GATE-W1 CH1 R1a.
 *
 * Asserts: every http(s) URL and every image source in `README.md` resolves to something a reader
 * can actually see.
 *
 * ── The bug class ───────────────────────────────────────────────────────────
 * `README.md` IS the npm shopfront — it is what an integrator lands on first, and it is rendered
 * verbatim on npmjs.com and on the GitHub repo front page. No gate has ever read a link or an
 * image in it. Measured 2026-08-19/20/21: the Smithery badge at `README.md:37` returned **500 on
 * three consecutive days**, so the front page of the package served a broken image to every
 * visitor, and nothing anywhere could notice.
 *
 * The deeper asymmetry this closes is not the badge. THREE gates already scan this file —
 * `check-claim-coverage.mjs`, `check-mcp-client-copy.mjs`, `check-live-numeric-claims.mjs` — and
 * every one of them was wired into `deploy.yml` and NONE into `prepublishOnly`. So `npm publish`
 * shipped a README that no gate had read. R1d promotes all three; this file adds the dimension
 * none of them covered.
 *
 * ── What this gate CANNOT see, stated so nobody over-trusts it ──────────────
 * A soft-404. Measured on the same Smithery listing this wave removes: both
 * `smithery.ai/server/@algovault/…` and `…/server/algovault/…` return **HTTP 200** while rendering
 * `404: Server Not Found or Removed`. A status-code checker passes that link. Body assertions are
 * a different corpus and a different wave — see the Out-of-scope note in status.md. Naming the
 * limit is worth more than implying coverage this does not have.
 *
 * ── FAIL vs INDETERMINATE: the boundary is TRANSPORT, not the digit ─────────
 * Fail CLOSED on content, OPEN on transport. A 4xx/5xx from a reachable host is a broken link.
 * DNS failure, timeout and connection reset are somebody else's outage, not our defect.
 *
 * `429` sits on that line and it is the one that matters, because getting it wrong is how a gate
 * becomes flaky enough to be ignored. Measured during this wave's own Step-0 sweep of the real
 * corpus: `github.com/AlgoVaultLabs/algovault-skills/blob/main/examples/maf/demo.py` answered
 * **429 on HEAD and on GET**, while a sibling URL answered 429 on HEAD and **200** on GET, in the
 * same run, seconds apart. Treating that as FAIL would red a deploy for a third-party throttle on
 * links that are demonstrably fine. So the whole rate-limit/overload class —
 * `408 / 425 / 429 / 503`, plus ANY response carrying `Retry-After` — retries once and then
 * reports INDETERMINATE. A STABLE `403` or `405` is a different thing entirely: it is a permanent,
 * reproducible answer, so it stays an allowlist entry with a measured reason.
 *
 * ── The allowlist is a DECISION LIST ────────────────────────────────────────
 * Keyed by exact URL, every entry carrying a `reason`. An entry without one is INDETERMINATE, not
 * a silent pass — the estate's standing convention, because an exemption whose justification lives
 * nowhere gets inherited forever by waves that never knew why.
 *
 *   node scripts/check-readme-links.mjs             # live gate (network)
 *   node scripts/check-readme-links.mjs --self-test # two-way, vacuity-guarded, no network egress
 *
 * Codes: 0=PASS / 1=FAIL / 3=INDETERMINATE (token-law default for a NEW gate; do NOT "align" it
 * with check_test_baseline.sh's 2, which is 2 only because it already deployed 2).
 *
 * Callers gate on the TOKEN, never the bare exit code.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const TOKEN = 'README_LINKS_VERDICT';

/** A real browser UA. Several hosts answer 403 to the default fetch agent and 200 to this. */
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const TIMEOUT_MS = 15000;

/**
 * A `Retry-After` is attacker-ish input from our point of view: a hostile or merely careless header
 * ("3600") would stall CI for an hour. Honour it, but never past this.
 */
const RETRY_AFTER_CAP_MS = 5000;

/**
 * Statuses that mean "ask again later", not "this link is broken".
 *
 * 408 request-timeout · 425 too-early · 429 rate-limited · 503 unavailable. Anything carrying a
 * `Retry-After` header joins them regardless of status, because that header IS the server saying so.
 */
const TRANSPORT_STATUSES = new Set([408, 425, 429, 503]);

/**
 * Expected non-200s, keyed by exact URL. EVERY entry carries a measured `reason`.
 *
 * Both of these were measured on the live corpus 2026-08-21, and both are STABLE — reproducible on
 * every probe, not a throttle. That is what separates them from the transport class above.
 */
export const EXPECTED_STATUS = new Map([
  [
    'https://www.npmjs.com/package/crypto-quant-signal-mcp',
    { status: 403, reason: 'npmjs.com answers 403 to datacenter/CI egress and to non-browser agents; measured 403 on HEAD and GET 2026-08-21. The package page is fine in a browser — the registry API (registry.npmjs.org) is the machine-readable surface and is separately asserted by the release gate.' },
  ],
  [
    'https://api.algovault.com/mcp',
    { status: 405, reason: 'the MCP endpoint is POST-only, so a HEAD/GET correctly answers 405 Method Not Allowed. Measured 405 on both verbs 2026-08-21. A 200 here would mean the transport had started answering idempotent verbs, which is itself worth noticing.' },
  ],
]);

/**
 * Every http(s) URL a reader could follow or an image a reader could see.
 *
 * Pure, and exported, so the self-test exercises the REAL extractor rather than a hand-written
 * fixture shape this function has never emitted. Covers all five constructs the file actually
 * uses: `<img src>`, `<a href>`, markdown images, markdown links, and bare URLs in prose.
 *
 * Trailing punctuation is trimmed because a URL at the end of a sentence ("see https://x.dev.")
 * would otherwise be probed with the full stop attached and 404.
 *
 * @param {string} md
 * @returns {string[]} unique http(s) URLs, sorted for a stable report
 */
export function extractUrls(md) {
  const out = new Set();
  const add = (u) => {
    if (typeof u !== 'string') return;
    const trimmed = u.trim().replace(/[.,;:)\]}'"]+$/, '');
    if (/^https?:\/\/\S/.test(trimmed)) out.add(trimmed);
  };
  for (const m of md.matchAll(/<img\s[^>]*src=["']([^"']+)["']/gi)) add(m[1]);
  for (const m of md.matchAll(/<a\s[^>]*href=["']([^"']+)["']/gi)) add(m[1]);
  for (const m of md.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) add(m[1]);
  for (const m of md.matchAll(/\[[^\]]*\]\(([^)\s]+)/g)) add(m[1]);
  for (const m of md.matchAll(/https?:\/\/[^\s)<>"'`\]]+/g)) add(m[0]);
  return [...out].sort();
}

/** Count only the image constructs, for the report's own legibility. */
export function countImages(md) {
  return (
    [...md.matchAll(/<img\s[^>]*src=["']([^"']+)["']/gi)].length +
    [...md.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)].length
  );
}

/**
 * The whole verdict rule for ONE probed URL, as a pure function of what came back.
 *
 * Extracted deliberately: this is the code the network seam would otherwise hide, and a hermetic
 * self-test is structurally blind to exactly what its own seam replaces. Here the seam is `probe`,
 * and this — the part that DECIDES — is called directly by both.
 *
 * @param {string} u
 * @param {{status:number|null, retryAfter:string|null, networkError:string|null}} r
 * @returns {{verdict:'OK'|'FAIL'|'INDETERMINATE', note:string}}
 */
export function classify(u, r) {
  const allow = EXPECTED_STATUS.get(u);
  if (allow && !allow.reason) {
    return { verdict: 'INDETERMINATE', note: `allowlisted with no reason — an exemption without a stated reason is not a pass` };
  }
  if (r.networkError) {
    return { verdict: 'INDETERMINATE', note: `transport: ${r.networkError} — a third party being unreachable is not our defect` };
  }
  if (allow && r.status === allow.status) {
    return { verdict: 'OK', note: `expected ${allow.status} — ${allow.reason}` };
  }
  if (r.status == null) {
    return { verdict: 'INDETERMINATE', note: 'no status returned' };
  }
  if (r.retryAfter != null || TRANSPORT_STATUSES.has(r.status)) {
    return { verdict: 'INDETERMINATE', note: `HTTP ${r.status}${r.retryAfter != null ? ` (Retry-After: ${r.retryAfter})` : ''} — rate-limit/overload class, not a broken link` };
  }
  if (r.status >= 400) {
    return { verdict: 'FAIL', note: `HTTP ${r.status}` };
  }
  return { verdict: 'OK', note: `HTTP ${r.status}` };
}

/** Parse a `Retry-After` (delta-seconds or HTTP-date) into ms, capped. Never throws. */
export function retryAfterMs(header) {
  if (header == null) return 0;
  const secs = Number(String(header).trim());
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, RETRY_AFTER_CAP_MS);
  const when = Date.parse(String(header));
  if (Number.isFinite(when)) return Math.min(Math.max(0, when - Date.now()), RETRY_AFTER_CAP_MS);
  return 0;
}

/** HEAD, falling back to GET. Returns a plain record; never throws. */
async function fetchOnce(u) {
  for (const method of ['HEAD', 'GET']) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(u, {
        method,
        redirect: 'follow',
        headers: { 'user-agent': UA, accept: '*/*' },
        signal: ctl.signal,
      });
      clearTimeout(timer);
      const rec = { status: res.status, retryAfter: res.headers.get('retry-after'), networkError: null };
      // A HEAD rejection is often the server disliking the verb, not the resource. Only retry with
      // GET when HEAD looks unhappy; a healthy HEAD is the answer.
      if (method === 'HEAD' && res.status >= 400) continue;
      return rec;
    } catch (err) {
      clearTimeout(timer);
      if (method === 'GET') {
        const msg = err && err.name === 'AbortError' ? `timeout after ${TIMEOUT_MS}ms` : String(err?.cause?.code ?? err?.message ?? err);
        return { status: null, retryAfter: null, networkError: msg };
      }
    }
  }
  // HEAD 4xx'd and GET was attempted above; re-probe with GET for its real status.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(u, { method: 'GET', redirect: 'follow', headers: { 'user-agent': UA, accept: '*/*' }, signal: ctl.signal });
    clearTimeout(timer);
    return { status: res.status, retryAfter: res.headers.get('retry-after'), networkError: null };
  } catch (err) {
    clearTimeout(timer);
    const msg = err && err.name === 'AbortError' ? `timeout after ${TIMEOUT_MS}ms` : String(err?.cause?.code ?? err?.message ?? err);
    return { status: null, retryAfter: null, networkError: msg };
  }
}

/** Probe one URL, retrying ONCE through the transport class. */
export async function probe(u, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  let rec = await fetchOnce(u);
  const first = classify(u, rec);
  const isTransport = rec.networkError != null || rec.retryAfter != null || (rec.status != null && TRANSPORT_STATUSES.has(rec.status));
  if (first.verdict === 'INDETERMINATE' && isTransport) {
    await sleep(retryAfterMs(rec.retryAfter) || 1000);
    rec = await fetchOnce(u);
  }
  return { url: u, ...rec, ...classify(u, rec) };
}

/**
 * Run the gate over a corpus.
 *
 * VACUITY GUARD AT CONSTRUCTION. Zero extracted URLs means the extractor found nothing in a file
 * that demonstrably has links — the corpus was built wrong, and reporting PASS over it would be a
 * gate verifying nothing. INDETERMINATE, never PASS.
 */
export async function run(md, probeFn = probe) {
  const urls = extractUrls(md);
  if (urls.length === 0) {
    return { verdict: 'INDETERMINATE', rows: [], reason: 'zero URLs extracted — the corpus is empty, which for a README with links means the extractor is broken, not that the file is clean' };
  }
  const rows = [];
  for (const u of urls) rows.push(await probeFn(u));
  const fails = rows.filter((r) => r.verdict === 'FAIL');
  const indet = rows.filter((r) => r.verdict === 'INDETERMINATE');
  const verdict = fails.length > 0 ? 'FAIL' : indet.length > 0 ? 'INDETERMINATE' : 'PASS';
  return { verdict, rows, reason: null };
}

const EXIT = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };

function report(result, md) {
  for (const r of result.rows) {
    const glyph = r.verdict === 'OK' ? '✓' : r.verdict === 'FAIL' ? '✗' : '?';
    if (r.verdict === 'OK' && !EXPECTED_STATUS.has(r.url)) continue;
    console.log(`  ${glyph} ${r.url} — ${r.note}`);
  }
  for (const r of result.rows.filter((x) => x.verdict === 'FAIL')) {
    console.error(`✗ BROKEN: ${r.url} — ${r.note}`);
  }
  for (const r of result.rows.filter((x) => x.verdict === 'INDETERMINATE')) {
    console.error(`? UNVERIFIED: ${r.url} — ${r.note}`);
  }
  if (result.reason) console.error(`? ${result.reason}`);
  const ok = result.rows.filter((r) => r.verdict === 'OK').length;
  console.log(
    `${result.verdict === 'PASS' ? '✓' : result.verdict === 'FAIL' ? '✗' : '?'} README links: ${result.rows.length} URL(s) probed (${countImages(md)} image construct(s)), ${ok} reachable, ${result.rows.filter((r) => r.verdict === 'FAIL').length} broken, ${result.rows.filter((r) => r.verdict === 'INDETERMINATE').length} unverified.`,
  );
}

// ── self-test ────────────────────────────────────────────────────────────────
//
// Every scenario runs against a REAL local http server, so `fetchOnce`, the HEAD→GET fallback, the
// header read and the retry loop all execute for real. The only thing the self-test replaces is
// the remote host — which is the one thing it cannot own.
//
// Assertions NEVER raise: a broken subject must print `SELF-TEST: FAIL`, because an assertion that
// aborts the suite converts "proven able to fail" into "crashes".

let selfTestPass = 0;
let selfTestFail = 0;

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    selfTestPass += 1;
  } else {
    selfTestFail += 1;
    console.error(`  ✗ ${label}: expected ${e}, got ${a}`);
  }
}

async function selfTest() {
  const routes = {
    '/ok': { status: 200 },
    '/gone': { status: 500 },
    '/forbidden': { status: 403 },
    '/throttled': { status: 429 },
    '/retry-after': { status: 200, headers: { 'retry-after': '1' } },
    '/hostile-retry-after': { status: 503, headers: { 'retry-after': '3600' } },
    '/head-hates-me': { status: 405, getStatus: 200 },
  };
  const server = http.createServer((req, res) => {
    const r = routes[req.url];
    if (!r) return res.writeHead(404).end();
    const status = req.method === 'GET' && r.getStatus ? r.getStatus : r.status;
    res.writeHead(status, r.headers ?? {});
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // VACUITY GUARD AT CONSTRUCTION — the fixture corpus must not be empty. Here WE build it, so
    // empty means the test built nothing, which is a defect in the test. Refuse.
    const corpus = `# t\n[a](${base}/ok)\n<img src="${base}/gone" />\n`;
    if (extractUrls(corpus).length === 0) {
      console.error('✗ self-test corpus is empty — refusing to report a result over nothing.');
      console.log(`${TOKEN}=INDETERMINATE`);
      return EXIT.INDETERMINATE;
    }

    // 1 — the extractor sees all five constructs, and trims trailing punctuation.
    const all = extractUrls(
      `<img src="https://a.test/i.png"> <a href="https://b.test/">b</a> ![x](https://c.test/c.png) [y](https://d.test/y) bare https://e.test/e.`,
    );
    check('extractor: five constructs', all, [
      'https://a.test/i.png',
      'https://b.test/',
      'https://c.test/c.png',
      'https://d.test/y',
      'https://e.test/e',
    ]);
    check('image constructs counted', countImages('<img src="https://a/i.png"> ![x](https://c/c.png) [y](https://d/y)'), 2);

    // 2 — MUST-FIRE: a synthetic 500 FAILS, and the report NAMES the offending URL.
    const failRun = await run(`![b](${base}/gone)`);
    check('500 ⇒ FAIL', failRun.verdict, 'FAIL');
    check('500 names the URL', failRun.rows.filter((r) => r.verdict === 'FAIL').map((r) => r.url), [`${base}/gone`]);

    // 3 — MUST-NOT-FIRE: an allowlisted 403 PASSES.
    EXPECTED_STATUS.set(`${base}/forbidden`, { status: 403, reason: 'self-test fixture' });
    const allowRun = await run(`[a](${base}/forbidden)`);
    check('allowlisted 403 ⇒ PASS', allowRun.verdict, 'PASS');

    // 4 — an allowlist entry with NO reason is INDETERMINATE, not a silent pass.
    EXPECTED_STATUS.set(`${base}/forbidden`, { status: 403, reason: '' });
    const noReason = await run(`[a](${base}/forbidden)`);
    check('allowlisted without a reason ⇒ INDETERMINATE', noReason.verdict, 'INDETERMINATE');
    EXPECTED_STATUS.delete(`${base}/forbidden`);

    // 5 — THE Q5 BOUNDARY: a 429 is INDETERMINATE, never FAIL. This is the assertion that keeps a
    // third-party throttle from redding a deploy, and it is the reason this gate can be trusted.
    const throttled = await run(`[a](${base}/throttled)`, (u) => probe(u, () => Promise.resolve()));
    check('429 ⇒ INDETERMINATE (not FAIL)', throttled.verdict, 'INDETERMINATE');

    // 6 — a `Retry-After` makes even a 200 transport-class, and the honoured delay is CAPPED.
    const ra = await run(`[a](${base}/retry-after)`, (u) => probe(u, () => Promise.resolve()));
    check('Retry-After present ⇒ INDETERMINATE', ra.verdict, 'INDETERMINATE');
    check('Retry-After 3600s capped', retryAfterMs('3600'), RETRY_AFTER_CAP_MS);
    check('Retry-After garbage ⇒ 0', retryAfterMs('not-a-number'), 0);
    check('Retry-After absent ⇒ 0', retryAfterMs(null), 0);

    // 7 — HEAD 405 + GET 200 is a healthy link. Servers that dislike HEAD are common.
    const headHater = await run(`[a](${base}/head-hates-me)`);
    check('HEAD 405 → GET 200 ⇒ PASS', headHater.verdict, 'PASS');

    // 8 — VACUITY: a corpus with no URLs is INDETERMINATE, never PASS.
    const empty = await run('# nothing here at all\n');
    check('empty extraction ⇒ INDETERMINATE', empty.verdict, 'INDETERMINATE');

    // 9 — transport failure (nothing listening) is INDETERMINATE, never FAIL.
    const dead = await run('[a](http://127.0.0.1:1/nope)', (u) => probe(u, () => Promise.resolve()));
    check('connection refused ⇒ INDETERMINATE', dead.verdict, 'INDETERMINATE');

    // 10 — the classifier itself, called directly on records the seam would otherwise hide.
    check('classify 200', classify('https://x.test', { status: 200, retryAfter: null, networkError: null }).verdict, 'OK');
    check('classify 301', classify('https://x.test', { status: 301, retryAfter: null, networkError: null }).verdict, 'OK');
    check('classify 404', classify('https://x.test', { status: 404, retryAfter: null, networkError: null }).verdict, 'FAIL');
    check('classify 500', classify('https://x.test', { status: 500, retryAfter: null, networkError: null }).verdict, 'FAIL');
    check('classify 503', classify('https://x.test', { status: 503, retryAfter: null, networkError: null }).verdict, 'INDETERMINATE');
    check('classify 408', classify('https://x.test', { status: 408, retryAfter: null, networkError: null }).verdict, 'INDETERMINATE');
    check('classify 425', classify('https://x.test', { status: 425, retryAfter: null, networkError: null }).verdict, 'INDETERMINATE');
    check('classify DNS failure', classify('https://x.test', { status: null, retryAfter: null, networkError: 'ENOTFOUND' }).verdict, 'INDETERMINATE');

    // 11 — every shipped allowlist entry carries a reason. An exemption list that has quietly lost
    // its justifications is the failure mode this assertion exists for.
    for (const [u, e] of EXPECTED_STATUS) {
      check(`allowlist entry has a reason: ${u}`, typeof e.reason === 'string' && e.reason.length > 20, true);
    }

    // 12 — TOKEN → EXIT-CODE MAPPING. Asserting the token alone left a sibling gate fully green
    // after its INDETERMINATE mapping was re-coded to 0; assert the map itself.
    check('PASS ⇒ 0', EXIT.PASS, 0);
    check('FAIL ⇒ 1', EXIT.FAIL, 1);
    check('INDETERMINATE ⇒ 3', EXIT.INDETERMINATE, 3);
  } finally {
    await new Promise((r) => server.close(r));
  }

  const total = selfTestPass + selfTestFail;
  if (total === 0) {
    console.error('✗ self-test ran ZERO assertions — refusing to report a pass.');
    console.log(`${TOKEN}=INDETERMINATE`);
    return EXIT.INDETERMINATE;
  }
  if (selfTestFail > 0) {
    console.error(`✗ self-test: ${selfTestFail} of ${total} assertion(s) FAILED.`);
    console.log(`${TOKEN}=FAIL`);
    return EXIT.FAIL;
  }
  console.log(`✓ self-test passed — ${total} assertions across 12 scenarios (must-fire, must-not-fire, vacuity, transport boundary, token→exit map).`);
  console.log(`${TOKEN}=PASS`);
  return EXIT.PASS;
}

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();

  const readme = path.join(ROOT, 'README.md');
  let md;
  try {
    md = fs.readFileSync(readme, 'utf8');
  } catch (err) {
    // Input we were HANDED and could not read is always INDETERMINATE.
    console.error(`✗ cannot read ${readme}: ${err.message}`);
    console.log(`${TOKEN}=INDETERMINATE`);
    return EXIT.INDETERMINATE;
  }
  const result = await run(md);
  report(result, md);
  console.log(`${TOKEN}=${result.verdict}`);
  return EXIT[result.verdict];
}

main().then(
  (code) => process.exit(code),
  (err) => {
    // The one outcome the token law forbids is dying with no token at all.
    console.error(`✗ unhandled: ${err?.stack ?? err}`);
    console.log(`${TOKEN}=INDETERMINATE`);
    process.exit(EXIT.INDETERMINATE);
  },
);
