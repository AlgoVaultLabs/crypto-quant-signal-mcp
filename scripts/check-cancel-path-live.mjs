#!/usr/bin/env node
/**
 * check-cancel-path-live.mjs — CANCEL-PATH-CSP-FORM-ACTION-W1 CH3. The live leg of the cancel path.
 *
 * THE GAP IT CLOSES: CH2's gate (scripts/check-form-action-conformance.mjs) reads OUR TREE. It
 * cannot see a CSP edited in Caddy, a header injected by Cloudflare, or Stripe moving its portal
 * host — exactly the changes that would reopen the eight-week outage with every gate green. This
 * canary asks production the one question a paying customer's browser asks: when the account page
 * POSTs to /account/portal, is the answer a same-origin 200 that hands off to the Stripe Billing
 * Portal — and NOT a cross-origin 3xx that Chrome/Safari refuse silently under `form-action 'self'`?
 *
 * VERDICT TABLE (the V2 spec, verbatim in effect):
 *   PASS           200 · text/html · no Location · body carries `<a href="https://billing.stripe.com`
 *   FAIL           any 3xx · any Location · a 200 html with no portal anchor at all · 404/405/410 ·
 *                  a 200 that is not html — the path a customer uses is broken
 *   INDETERMINATE  key unset/unreadable · 400/401 (Stripe customer-search lag) · 403 with
 *                  `cf-mitigated` · 429 · 5xx · a network error / timeout · a 200 whose portal anchor
 *                  is an https host other than billing.stripe.com (a custom-domain switch is not a
 *                  regression) · any other status the table does not name
 *
 * `redirect: 'manual'` IS LOAD-BEARING. Node's fetch FOLLOWS a 303 by default (measured): a regressed
 * prod would then have this canary opening a real portal session on Stripe's host every hour and
 * reporting whatever Stripe answered. The self-test proves the 303 is SEEN and the Location target
 * is never requested.
 *
 * SECRETS: the fixture key is read IN-PROCESS from `/etc/algovault-monitoring/cancel-canary.env`
 * (`CANCEL_CANARY_API_KEY=…`, mode 600 root) — never from argv, never from the environment of a
 * parent. Nothing this script prints, alerts or records carries the key, the portal URL or the
 * session id: it reports the portal anchor's HOST only.
 *
 * ITS OWN STRIPE WRITES (disclosed, deliberate): every run creates one billingPortal session on the
 * fixture customer — ~720/month hourly. The fixture has no subscription and no payment method, so a
 * leaked session grants nothing. Named in its inventory row and the monitoring card.
 *
 * ALERTS — TWO ids, and they are not optional. `CANCEL_PATH_BROKEN` fires on FAIL.
 * `CANCEL_PATH_UNVERIFIED` fires after 24 CONSECUTIVE INDETERMINATE runs (the streak lives in a state
 * file). They are separate ids because send_telegram.sh's fixed 24h per-id cooldown would otherwise
 * let an UNVERIFIED page silence a real BROKEN one. PASS `--clear`s both (announce_resolution: true
 * on both registry rows); a FAIL also clears UNVERIFIED (the path WAS verified — broken) and resets
 * the streak. Fire argv `<ID> CRITICAL_PERSISTENT -` with the body on stdin; clear argv
 * `--clear <ID> <reason>`, mode flag FIRST, stdin closed. Tests use ALGOVAULT_TG_TEST_INERT=1 —
 * never DRY_RUN_TG, which writes the cooldown marker.
 *
 * RESULT LINE: one record per run into /var/lib/algovault-monitoring/canary-results.jsonl via
 * ops/monitoring/canary_result_log.py `append_result` (python3, flock), canary key `cancel_path_live`.
 * A recorder, not a gate: its failure never changes the verdict, the exit code or the alert — but it
 * is never silent either: `CANARY_RESULT_LOG=<path> line=<n>` or `CANARY_RESULT_LOG_FAILED=<why>`.
 *
 * VERDICT: exactly one terminal `CANCEL_PATH_LIVE_VERDICT=PASS|FAIL|INDETERMINATE`, exit 0|1|3, on
 * every path. Callers gate on the TOKEN.
 *
 * USAGE:
 *   node scripts/check-cancel-path-live.mjs --live [https://api.algovault.com]   # host cron, 39 * * * *
 *   node scripts/check-cancel-path-live.mjs --self-test                          # hermetic, three-way
 * Seams (self-test / operator only): CANCEL_CANARY_ENV_FILE · CANCEL_PATH_STATE_FILE ·
 * CANCEL_PATH_TG_WRAPPER · CANARY_RESULT_LOG_PATH. No seam can turn a response into a PASS.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const TOKEN = 'CANCEL_PATH_LIVE_VERDICT';
const CODES = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };
const SELF = url.fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SELF), '..');
const DEFAULT_BASE = 'https://api.algovault.com';
const TIMEOUT_MS = 20_000;
const UNVERIFIED_AFTER = 24;
const IDS = { broken: 'CANCEL_PATH_BROKEN', unverified: 'CANCEL_PATH_UNVERIFIED' };
const CANARY = 'cancel_path_live';
const PORTAL_HOST = 'billing.stripe.com';

const envFile = () => process.env.CANCEL_CANARY_ENV_FILE || '/etc/algovault-monitoring/cancel-canary.env';
const stateFile = () => process.env.CANCEL_PATH_STATE_FILE || '/var/lib/algovault-monitoring/cancel-path-live.state.json';
const wrapper = () => process.env.CANCEL_PATH_TG_WRAPPER || '/opt/algovault-monitoring/send_telegram.sh';

/** The fixture key, read in-process. null when unset or unreadable — never thrown, never printed. */
export function readKey(file = envFile()) {
  try {
    const m = /^CANCEL_CANARY_API_KEY=(\S+)\s*$/m.exec(fs.readFileSync(file, 'utf8'));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Every `<a href="https://…">` host in an html body, lower-cased. */
function anchorHosts(body) {
  const hosts = [];
  for (const m of String(body).matchAll(/<a\b[^>]*\bhref\s*=\s*["'](https:\/\/[^"'\s/?#>]+)/gi)) {
    try { hosts.push(new URL(m[1]).hostname.toLowerCase()); } catch { /* not a URL: not an anchor we can judge */ }
  }
  return hosts;
}

/**
 * The verdict for one response, as a pure function of what came back — so the self-test drives the
 * real table and no seam can reach it. `r` = { status, headers: { get(name) }, body } | { error }.
 */
export function classify(r) {
  if (r.error) return { verdict: 'INDETERMINATE', reason: `network error / timeout (${r.error})` };
  const st = r.status;
  const loc = r.headers.get('location');
  const ctype = String(r.headers.get('content-type') || '').toLowerCase();
  if (st >= 300 && st < 400) return { verdict: 'FAIL', reason: `answered ${st} — a redirect after a form submission; Chrome/Safari refuse a cross-origin one silently` };
  if (loc) return { verdict: 'FAIL', reason: `answered ${st} with a Location header — the handoff must be a same-origin 200 page` };
  if (st === 400 || st === 401) return { verdict: 'INDETERMINATE', reason: `${st} — the fixture customer was not resolved (Stripe customer-search lag), not a verdict on the path` };
  if (st === 403 && r.headers.get('cf-mitigated')) return { verdict: 'INDETERMINATE', reason: '403 cf-mitigated — Cloudflare challenged the canary, not the path' };
  if (st === 429) return { verdict: 'INDETERMINATE', reason: '429 — rate limited' };
  if (st >= 500) return { verdict: 'INDETERMINATE', reason: `${st} — the server could not answer; the path is unverified` };
  if (st === 404 || st === 405 || st === 410) return { verdict: 'FAIL', reason: `${st} — the route a customer posts to is gone` };
  if (st !== 200) return { verdict: 'INDETERMINATE', reason: `${st} — a status the verdict table does not name` };
  if (!ctype.startsWith('text/html')) return { verdict: 'FAIL', reason: `200 but content-type ${ctype || '(none)'} — not the interstitial page` };
  const hosts = anchorHosts(r.body);
  if (hosts.includes(PORTAL_HOST)) return { verdict: 'PASS', reason: `200 text/html, no Location, portal anchor on ${PORTAL_HOST}` };
  if (hosts.length) return { verdict: 'INDETERMINATE', reason: `200 text/html whose portal anchor is on ${hosts[0]}, not ${PORTAL_HOST} — a custom-domain switch is not a regression; confirm and update PORTAL_HOST` };
  return { verdict: 'FAIL', reason: '200 text/html with no https portal anchor — the customer has nowhere to go' };
}

/** POST the account form exactly as the page does. redirect:'manual' — a 3xx is SEEN, never followed. */
export async function probe(base, key, { timeoutMs = TIMEOUT_MS } = {}) {
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/account/portal`, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'algovault-cancel-path-canary/1 (+ops)' },
      body: new URLSearchParams({ api_key: key }).toString(),
    });
    const body = await res.text();
    return { status: res.status, headers: res.headers, body };
  } catch (e) {
    return { error: String((e && (e.name === 'TimeoutError' ? `timeout ${timeoutMs}ms` : e.message)) || e).split('\n')[0] };
  }
}

export function readState(file = stateFile()) {
  try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); return { streak: Number.isInteger(s.indeterminate_streak) ? s.indeterminate_streak : 0 }; } catch { return { streak: 0 }; }
}
export function writeState(state, file = stateFile()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ indeterminate_streak: state.streak, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** Fire: `<ID> CRITICAL_PERSISTENT -`, the body on stdin. A dispatch fault is a typed failure, never a throw. */
export function dispatchAlert(id, body, { wrap = wrapper(), exec = execFileSync } = {}) {
  try { exec(wrap, [id, 'CRITICAL_PERSISTENT', '-'], { input: body, encoding: 'utf8', timeout: 30_000 }); return { ok: true }; } catch (e) { return { ok: false, err: String(e?.message ?? e).split('\n')[0] }; }
}
/** Clear: `--clear <ID> <reason>` — the mode flag FIRST (a reversed argv parses as a fire), stdin closed. */
export function dispatchClear(id, reason, { wrap = wrapper(), exec = execFileSync } = {}) {
  try { exec(wrap, ['--clear', id, reason], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 30_000 }); return { ok: true }; } catch (e) { return { ok: false, err: String(e?.message ?? e).split('\n')[0] }; }
}

/** The alert body, as a pure function (asserted by the self-test). Carries no key, no URL, no session id. */
export function renderBody(id, c, extra = '') {
  const what = id === IDS.broken
    ? 'The account page\'s "Manage billing / cancel" form is answered in a way Chrome/Safari refuse — customers cannot reach the Stripe Billing Portal to cancel.'
    : `The cancel path has been UNVERIFIABLE for ${UNVERIFIED_AFTER}+ consecutive hourly runs — the canary cannot tell whether customers can cancel.`;
  return [
    `${id}`,
    what,
    `verdict: ${c.verdict} — ${c.reason}${extra}`,
    'probe: POST https://api.algovault.com/account/portal as the fixture customer (no subscription, no card)',
    'runbook: CH1 of CANCEL-PATH-CSP-FORM-ACTION-W1 — the handoff must be a 200 same-origin page (src/lib/off-origin-redirect.ts), never a cross-origin 3xx',
    `next: OPS-${id}-FIX-W{NEXT}`,
  ].join('\n');
}

/** One record via the shared python recorder. Never throws; returns the positive log line either way. */
export function recordResult(verdict, metrics) {
  const lib = path.join(REPO, 'ops', 'monitoring');
  const code = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(lib)})`,
    'try:',
    '    import canary_result_log as c',
    '    a = json.loads(sys.stdin.read())',
    "    ok, d = c.append_result(a['canary'], a['verdict'], a['exit_code'], a['metrics'])",
    "    print(json.dumps({'ok': ok, 'detail': d, 'path': c.RESULTS_PATH}))",
    'except Exception as e:',
    "    print(json.dumps({'ok': False, 'detail': 'recorder import/append failed: %s' % type(e).__name__}))",
  ].join('\n');
  try {
    const r = spawnSync('python3', ['-c', code], { input: JSON.stringify({ canary: CANARY, verdict, exit_code: CODES[verdict], metrics }), encoding: 'utf8', timeout: 30_000 });
    const j = JSON.parse(String(r.stdout || '').trim().split('\n').pop() || '{}');
    return j.ok ? `CANARY_RESULT_LOG=${j.path} ${j.detail}` : `CANARY_RESULT_LOG_FAILED=${j.detail || `python3 exit ${r.status}`}`;
  } catch (e) {
    return `CANARY_RESULT_LOG_FAILED=${String(e?.message ?? e).split('\n')[0]}`;
  }
}

/** One live run: probe → classify → state → alerts → record. Returns { verdict, lines }. */
export async function runLive(base, { key = readKey(), wrap = wrapper(), state = stateFile(), record = true } = {}) {
  const lines = [];
  let c;
  let metrics = {};
  if (!key) c = { verdict: 'INDETERMINATE', reason: `fixture key unset or unreadable (${envFile()} — CANCEL_CANARY_API_KEY)` };
  else {
    const t0 = Date.now();
    const r = await probe(base, key);
    c = classify(r);
    metrics = r.error ? { error: 1, ms: Date.now() - t0 } : {
      status: r.status, ms: Date.now() - t0,
      location_present: r.headers.get('location') ? 1 : 0,
      html: String(r.headers.get('content-type') || '').toLowerCase().startsWith('text/html') ? 1 : 0,
      portal_anchor_host: anchorHosts(r.body)[0] || null,
    };
  }
  lines.push(`[cancel-path] ${base}/account/portal → ${c.verdict}: ${c.reason}`);
  const st = readState(state);
  const next = { streak: c.verdict === 'INDETERMINATE' ? st.streak + 1 : 0 };
  const saved = writeState(next, state);
  lines.push(`[cancel-path] indeterminate streak ${next.streak}/${UNVERIFIED_AFTER}${saved ? '' : ' (STATE NOT SAVED — the streak cannot accumulate; check ' + state + ')'}`);
  const act = (label, res) => lines.push(`[cancel-path] ${label}: ${res.ok ? 'dispatched' : `dispatch FAILED (${res.err})`}`);
  if (c.verdict === 'FAIL') {
    act(`fire ${IDS.broken}`, dispatchAlert(IDS.broken, renderBody(IDS.broken, c), { wrap }));
    act(`clear ${IDS.unverified}`, dispatchClear(IDS.unverified, 'cancel path verified (FAIL is a verdict, not unverifiable)', { wrap }));
  } else if (c.verdict === 'PASS') {
    act(`clear ${IDS.broken}`, dispatchClear(IDS.broken, 'cancel path verified: 200 same-origin handoff to the Stripe Billing Portal', { wrap }));
    act(`clear ${IDS.unverified}`, dispatchClear(IDS.unverified, 'cancel path verified again', { wrap }));
  } else if (next.streak >= UNVERIFIED_AFTER) {
    act(`fire ${IDS.unverified}`, dispatchAlert(IDS.unverified, renderBody(IDS.unverified, c, ` (streak ${next.streak})`), { wrap }));
  }
  if (record) lines.push(recordResult(c.verdict, { ...metrics, indeterminate_streak: next.streak }));
  return { verdict: c.verdict, reason: c.reason, lines };
}

// ───────────────────────────── self-test ─────────────────────────────

function fixtureServer() {
  const hits = { followed: 0, posts: 0, lastBody: '' };
  const html = (res, body, extra = {}) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...extra }); res.end(body); };
  const srv = http.createServer((req, res) => {
    let data = '';
    req.on('data', (d) => { data += d; });
    req.on('end', () => {
      const [, kase] = /^\/([^/]+)/.exec(req.url) || [];
      if (req.url.startsWith('/followed')) { hits.followed++; html(res, '<a href="https://billing.stripe.com/p/followed">x</a>'); return; }
      hits.posts++; hits.lastBody = data;
      const port = srv.address().port;
      switch (kase) {
        case 'pass': return html(res, '<meta http-equiv="refresh" content="0;url=https://billing.stripe.com/p/session/test_x"><a href="https://billing.stripe.com/p/session/test_x">Open Stripe Billing Portal →</a>', { 'cache-control': 'no-store' });
        case 'fail-303': res.writeHead(303, { location: `http://127.0.0.1:${port}/followed` }); return res.end();
        case 'fail-location-200': return html(res, '<a href="https://billing.stripe.com/p/x">x</a>', { location: 'https://billing.stripe.com/p/x' });
        case 'fail-noanchor': return html(res, '<p>Opening your billing portal…</p>');
        case 'fail-404': res.writeHead(404, { 'content-type': 'text/html' }); return res.end('not found');
        case 'fail-json': res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"url":"https://billing.stripe.com/p/x"}');
        case 'indet-401': res.writeHead(401, { 'content-type': 'text/html' }); return res.end('no such customer');
        case 'indet-cf': res.writeHead(403, { 'content-type': 'text/html', 'cf-mitigated': 'challenge' }); return res.end('challenge');
        case 'indet-429': res.writeHead(429); return res.end();
        case 'indet-502': res.writeHead(502); return res.end();
        case 'indet-418': res.writeHead(418); return res.end();
        case 'indet-customdomain': return html(res, '<a href="https://billing.algovault.com/p/session/x">Open portal</a>');
        case 'slow': setTimeout(() => html(res, 'late'), 3000); return undefined;
        default: res.writeHead(500); return res.end();
      }
    });
  });
  return { srv, hits };
}

async function selfTest() {
  let pass = 0; const failures = [];
  const t = (name, ok) => { if (ok) pass++; else failures.push(name); };
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cancel-path-st-'));
  const { srv, hits } = fixtureServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = (k) => `http://127.0.0.1:${srv.address().port}/${k}`;
  try {
    // The table, driven through the REAL probe (redirect:'manual') and the REAL classifier.
    const expect = {
      pass: 'PASS',
      'fail-303': 'FAIL', 'fail-location-200': 'FAIL', 'fail-noanchor': 'FAIL', 'fail-404': 'FAIL', 'fail-json': 'FAIL',
      'indet-401': 'INDETERMINATE', 'indet-cf': 'INDETERMINATE', 'indet-429': 'INDETERMINATE', 'indet-502': 'INDETERMINATE',
      'indet-418': 'INDETERMINATE', 'indet-customdomain': 'INDETERMINATE',
    };
    for (const [k, want] of Object.entries(expect)) {
      const got = classify(await probe(base(k), 'av_live_selftest…'));
      t(`${k} → ${want} (got ${got.verdict}: ${got.reason})`, got.verdict === want);
    }
    t("a 303 is SEEN, never followed (redirect:'manual'): the Location target got 0 requests", hits.followed === 0);
    t('the key travels in the form BODY, never the URL', hits.lastBody.startsWith('api_' + 'key=') && hits.lastBody.includes('selftest'));
    const slow = classify(await probe(base('slow'), 'k', { timeoutMs: 300 }));
    t(`a timeout is INDETERMINATE (got ${slow.verdict})`, slow.verdict === 'INDETERMINATE' && /timeout/.test(slow.reason));
    const refused = classify(await probe('http://127.0.0.1:9', 'k', { timeoutMs: 2000 }));
    t(`a refused connection is INDETERMINATE (got ${refused.verdict})`, refused.verdict === 'INDETERMINATE');
    t('an anchor on billing.stripe.com inside a longer page is found', classify({ status: 200, headers: new Headers({ 'content-type': 'text/html' }), body: '<p>x</p><a class="btn" href="https://billing.stripe.com/p/session/y">go</a>' }).verdict === 'PASS');
    t('a lookalike host (billing.stripe.com.evil.example) is not the portal', classify({ status: 200, headers: new Headers({ 'content-type': 'text/html' }), body: '<a href="https://billing.stripe.com.evil.example/p">go</a>' }).verdict !== 'PASS');

    // The key: read from its file in-process; unset/unreadable is INDETERMINATE, never PASS.
    const kf = path.join(tdir, 'cancel-canary.env');
    fs.writeFileSync(kf, 'CANCEL_CANARY_API_KEY=av_live_abc…\n', { mode: 0o600 });
    t('the key is read from its env file', readKey(kf) === 'av_live_abc…');
    t('a missing env file reads as no key', readKey(path.join(tdir, 'absent.env')) === null);

    // The run: state streak, both alert ids, the transport — against a fake wrapper that records what ARRIVED.
    const fake = path.join(tdir, 'wrap.sh');
    fs.writeFileSync(fake, ['#!/bin/sh', 'd=$(dirname "$0")', 'n=$(ls "$d" | grep -c "^call-")', 'mkdir -p "$d/call-$n"', "printf '%s\\n' \"$@\" > \"$d/call-$n/argv\"", 'cat > "$d/call-$n/stdin"', ''].join('\n'), { mode: 0o755 });
    const calls = () => fs.readdirSync(tdir).filter((x) => x.startsWith('call-')).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
      .map((x) => ({ argv: fs.readFileSync(path.join(tdir, x, 'argv'), 'utf8').split('\n').filter(Boolean), stdin: fs.readFileSync(path.join(tdir, x, 'stdin'), 'utf8') }));
    const reset = () => { for (const x of fs.readdirSync(tdir)) if (x.startsWith('call-')) fs.rmSync(path.join(tdir, x), { recursive: true, force: true }); };
    const sf = path.join(tdir, 'state.json');
    const run = (k, key = 'av_live_selftest…') => runLive(base(k), { key, wrap: fake, state: sf, record: false });

    reset();
    const f = await run('fail-303');
    const fc = calls();
    t(`FAIL fires ${IDS.broken} with argv <id> CRITICAL_PERSISTENT - (got ${JSON.stringify(fc[0]?.argv)})`, f.verdict === 'FAIL' && JSON.stringify(fc[0]?.argv) === JSON.stringify([IDS.broken, 'CRITICAL_PERSISTENT', '-']));
    t('the BROKEN body arrives on stdin, names the id, and carries no key, no portal URL, no session id', /^CANCEL_PATH_BROKEN\n/.test(fc[0]?.stdin || '') && !/av_live_|billing\.stripe\.com\/p\/|test_x|\/followed/.test(fc[0]?.stdin || ''));
    t(`FAIL also clears ${IDS.unverified}, --clear FIRST`, JSON.stringify(fc[1]?.argv.slice(0, 2)) === JSON.stringify(['--clear', IDS.unverified]));
    t('a clear reads nothing on stdin', fc[1]?.stdin === '');

    reset();
    for (let i = 1; i < UNVERIFIED_AFTER; i++) await run('indet-502');
    t(`${UNVERIFIED_AFTER - 1} consecutive INDETERMINATE runs page nothing (got ${calls().length} call(s))`, calls().length === 0 && readState(sf).streak === UNVERIFIED_AFTER - 1);
    await run('indet-502');
    const uc = calls();
    t(`the ${UNVERIFIED_AFTER}th consecutive INDETERMINATE fires ${IDS.unverified} — a separate id, so it cannot silence ${IDS.broken}`, uc.length === 1 && uc[0].argv[0] === IDS.unverified && uc[0].argv[1] === 'CRITICAL_PERSISTENT');

    reset();
    const pz = await run('pass');
    const pc = calls();
    t(`PASS clears BOTH ids, --clear first (got ${JSON.stringify(pc.map((x) => x.argv.slice(0, 2)))})`, pz.verdict === 'PASS' && pc.length === 2 && pc.every((x) => x.argv[0] === '--clear') && pc.map((x) => x.argv[1]).sort().join() === [IDS.broken, IDS.unverified].sort().join());
    t('PASS resets the INDETERMINATE streak', readState(sf).streak === 0);

    reset();
    const noKey = await runLive(base('pass'), { key: null, wrap: fake, state: sf, record: false });
    t(`no key → INDETERMINATE, never PASS (got ${noKey.verdict}), and no probe is sent`, noKey.verdict === 'INDETERMINATE' && calls().length === 0);
    t('a wrapper that cannot run is a typed failure, never a throw', dispatchAlert(IDS.broken, 'x', { wrap: path.join(tdir, 'absent.sh') }).ok === false);

    // The recorder: a real append into a temp results file, and its positive line either way.
    const prev = process.env.CANARY_RESULT_LOG_PATH;
    process.env.CANARY_RESULT_LOG_PATH = path.join(tdir, 'results.jsonl');
    const rec = recordResult('PASS', { status: 200 });
    if (prev === undefined) delete process.env.CANARY_RESULT_LOG_PATH; else process.env.CANARY_RESULT_LOG_PATH = prev;
    const recLine = fs.existsSync(path.join(tdir, 'results.jsonl')) ? fs.readFileSync(path.join(tdir, 'results.jsonl'), 'utf8').trim().split('\n').pop() : '';
    t(`the recorder appends one cancel_path_live line and says so (${rec})`, /^CANARY_RESULT_LOG=\S+ line=1$/.test(rec) && JSON.parse(recLine || '{}').canary === CANARY);
  } finally {
    srv.close();
    fs.rmSync(tdir, { recursive: true, force: true });
  }
  if (pass + failures.length === 0) return { verdict: 'INDETERMINATE', detail: 'zero assertions ran', failures };
  return { verdict: failures.length ? 'FAIL' : 'PASS', detail: `${pass} passed, ${failures.length} failed`, failures };
}

// ───────────────────────────── main ─────────────────────────────

function emit(verdict, lines = []) {
  for (const l of lines) console.log(l);
  console.log(`${TOKEN}=${verdict}`);
  process.exitCode = CODES[verdict];
}

async function main(argv) {
  if (argv[0] === '--self-test' && argv.length === 1) {
    let st;
    try { st = await selfTest(); } catch (e) { st = { verdict: 'INDETERMINATE', detail: `self-test threw: ${e && e.message}`, failures: [] }; }
    for (const f of st.failures) console.error(`  ✗ ${f}`);
    console.log(`SELF-TEST: ${st.verdict} (${st.detail})`);
    return emit(st.verdict);
  }
  if (argv[0] === '--live' && argv.length <= 2) {
    const base = argv[1] || DEFAULT_BASE;
    if (!/^https?:\/\/[^/\s]+\/?$/.test(base)) return emit('INDETERMINATE', [`[cancel-path] bad invocation: --live takes an origin, got ${JSON.stringify(base)}`]);
    let r;
    try { r = await runLive(base); } catch (e) { r = { verdict: 'INDETERMINATE', lines: [`[cancel-path] unexpected error: ${e && e.message}`] }; }
    return emit(r.verdict, r.lines);
  }
  return emit('INDETERMINATE', [`[cancel-path] bad invocation: ${JSON.stringify(argv)} — use --live [origin] or --self-test`]);
}

const realOrNull = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
if (Boolean(process.argv[1]) && realOrNull(path.resolve(process.argv[1])) === realOrNull(SELF)) {
  main(process.argv.slice(2)).catch((e) => emit('INDETERMINATE', [`[cancel-path] unexpected error: ${e && e.message}`]));
}
