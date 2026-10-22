// OPS-SERVED-CANDLE-TRUTH-W1 CH1 — contract-suite scenario S, captured THROUGH the shipped adapters.
// One scenario per distinct serving window the product asks for (src/lib/serving-windows.ts SERVING_WINDOWS), on every
// faithful (venue, tf) of the replay venues: from = now − window, no endTime, exactly the read a serving consumer makes.
// BITGET and OKX are absent: their S scenarios run on the synthetic venue (tests/harness/adapter-history-synthetic.ts).
// The window spans are derived as tests/harness/serving-spans.ts derives them; the contract test re-derives the set
// and fails on any window missing here or present here but no longer declared.
// Sanitized by sanitize.js (trim + replay proof) into SERVING.json, once every scenario is captured.
// Read-only public klines. Pacing as capture.js: >= 1.0 s global, >= 2 s per venue (HL 3 s, WEEX 5 s). No retries.
//   node tests/fixtures/adapter-history/tools/capture-serving.js "$PWD" tests/fixtures/adapter-history "$(git rev-parse HEAD)" [VENUE,...] [--merge]
// With VENUE,... alone it writes SERVING.<venues>.partial.json. With --merge it recaptures those venues INTO SERVING.json
// (their scenarios replaced, every other venue kept byte-for-byte) and records the recapture in the file's header.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { FILES, makeReplay, sanitizeScenario } = require('./sanitize.js');

const [WT, FIX, SHA, ONLY, MODE] = process.argv.slice(2);
const MERGE = MODE === '--merge';
if (MODE !== undefined && !MERGE) throw new Error(`capture-serving: unknown mode ${MODE}`);
if (MERGE && !ONLY) throw new Error('capture-serving: --merge needs the venues to recapture');
const D = (p) => require(path.join(WT, 'dist', p));
const tfs = D('lib/tf-support.js');
const { TIMEFRAMES } = D('lib/capabilities.js');
const { servingWindowsFor } = D('lib/serving-windows.js');
const { VENUE_FETCH_CONFIGS } = D('lib/adapters/_upstream-fetch.js');
const TF_MS = D('lib/pfe-mae.js').TF_MS;

const SYNTHETIC = new Set(['BITGET', 'OKX']);
const universe = JSON.parse(fs.readFileSync(path.join(FIX, 'UNIVERSE.json'), 'utf8'));
const VENUES = universe.promoted.filter((v) => !SYNTHETIC.has(v) && (!ONLY || ONLY.split(',').includes(v)));
const served = (v, tf) => D(`lib/adapters/${FILES[v][0]}.js`).servedIntervalMs(tf);
const adapterOf = (v) => D(`lib/adapters/${FILES[v][0]}.js`)[FILES[v][1]];

/** tests/harness/serving-spans.ts, in the capture's own runtime. */
function servingSpans(tf, servedStepMs) {
  const seen = new Map();
  for (const w of servingWindowsFor(tf)) {
    const spanMs = w.bars * (w.unit === 'served' ? (servedStepMs ?? TF_MS[tf]) : TF_MS[tf]);
    seen.set(spanMs, seen.has(spanMs) ? `${seen.get(spanMs)}+${w.consumer}@${w.bars}` : `${w.consumer}@${w.bars}`);
  }
  return [...seen].map(([spanMs, label]) => ({ label, spanMs }));
}

let log = [];
let curVenue = null;
const lastAtVenue = {};
let lastAt = 0;
const gapFor = (u) => (/weex/i.test(u) ? 5000 : /hyperliquid/i.test(u) ? 3000 : 2000);
const hostKey = (u) => { try { return new URL(u).host; } catch { return u; } };
const realFetch = globalThis.fetch;
const pacedFetch = async (url, init) => {
  const u = String(url);
  const calledAt = Date.now();
  const h = hostKey(u);
  const wait = Math.max((lastAtVenue[h] || 0) + gapFor(u), lastAt + 1000) - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastAt = lastAtVenue[h] = Date.now();
  const sentAt = Date.now();
  // upstreamFetch arms its abort timer BEFORE it calls fetch, so the pacing wait above would spend it: WEEX's 5 s gap
  // against its 4 s timeout aborted every back-to-back request. In production nothing waits inside fetch, so the
  // request gets the venue's own timeout from the moment it is actually sent.
  const sentInit = { ...init, signal: AbortSignal.timeout(VENUE_FETCH_CONFIGS[curVenue].timeoutMs) };
  try {
    const res = await realFetch(url, sentInit);
    const text = await res.clone().text();
    log.push({ url: u, method: (init && init.method) || 'GET', reqBody: init && init.body ? String(init.body) : null, calledAt, sentAt, status: res.status, body: text });
    return res;
  } catch (e) {
    log.push({ url: u, method: (init && init.method) || 'GET', reqBody: init && init.body ? String(init.body) : null, calledAt, sentAt, status: 0, error: String((e && e.message) || e), body: null });
    throw e;
  }
};
const isHlMarketListing = (r) => /hyperliquid/i.test(r.url) && /"type":"metaAndAssetCtxs"/.test(r.reqBody || '');

async function scenario(v, tf, label, spanMs) {
  log = [];
  curVenue = v;
  globalThis.fetch = pacedFetch;
  const calledAt = Date.now();
  const from = calledAt - spanMs;
  let out = null, err = null;
  try { out = await new (adapterOf(v))().getCandles('BTC', tf, from); } catch (e) { err = String((e && e.message) || e); }
  globalThis.fetch = realFetch;
  return {
    tag: 'S', window: label, spanMs, venue: v, tf, coin: 'BTC', from, to: null, calledAt, requestedMs: TF_MS[tf], servedMs: served(v, tf),
    W: null, error: err,
    output: (out || []).map((c) => ({ ts: c.time, open: c.open })),
    requests: log.filter((r) => !isHlMarketListing(r)).map((r) => ({ ...r, sha256: r.body == null ? null : crypto.createHash('sha256').update(r.body).digest('hex') })),
  };
}

(async () => {
  // Capture every scenario first, then prove each by replay. The replay runs the shipped adapter, so it spends the
  // same local weight budget (src/lib/upstream-weight-budget.ts) as the capture does: interleaved, the two together
  // passed Hyperliquid's interactive ceiling and the capture recorded the budget's own refusals as venue errors.
  const raws = [];
  for (const v of VENUES) {
    for (const tf of TIMEFRAMES) {
      if (!tfs.isTimeframeFaithful(v, tf)) continue;
      for (const { label, spanMs } of servingSpans(tf, served(v, tf))) {
        const raw = await scenario(v, tf, label, spanMs);
        raws.push(raw);
        process.stderr.write(`captured ${v}/${tf}/S@${label} ${raw.output.length}${raw.error ? ` ! ${raw.error.slice(0, 80)}` : ''}\n`);
      }
    }
  }
  const replay = makeReplay(WT);
  const scenarios = [];
  const report = [];
  for (const raw of raws) {
    const { scenario: s, row } = await sanitizeScenario(replay, raw);
    scenarios.push(s);
    report.push(row);
    process.stderr.write(`${row.id} ${s.output.length}${s.error ? ` ! ${s.error.slice(0, 80)}` : ''} [${row.mode}]\n`);
  }
  const firstAt = (ss) => new Date(Math.min(...ss.map((s) => s.calledAt))).toISOString();
  let file;
  if (MERGE) {
    const prev = JSON.parse(fs.readFileSync(path.join(FIX, 'SERVING.json'), 'utf8'));
    const absent = VENUES.filter((v) => !prev.venues.includes(v));
    if (absent.length) throw new Error(`capture-serving: --merge: ${absent.join(',')} not in SERVING.json`);
    // Each venue keeps its place in the file; a recaptured venue's block is this capture's, every other is kept as is.
    const merged = prev.venues.flatMap((v) => (VENUES.includes(v) ? scenarios : prev.scenarios).filter((s) => s.venue === v));
    const { scenarios: _old, recaptures = [], ...head } = prev;
    file = { ...head, capturedAt: firstAt(merged), recaptures: [...recaptures, { venues: VENUES, originMainSha: SHA, capturedAt: firstAt(scenarios) }], scenarios: merged };
  } else {
    file = {
      wave: 'OPS-SERVED-CANDLE-TRUTH-W1',
      note: 'Contract-suite scenario S: every serving window SERVING_WINDOWS declares, on every faithful (venue, tf) of the replay venues, read through the shipped adapter with no endTime (one scenario per distinct window span). BITGET and OKX run S on the synthetic venue instead. Sanitized by sanitize.js.',
      originMainSha: SHA,
      capturedAt: firstAt(scenarios),
      capturedBy: 'mac: capture-serving.js through the shipped adapters',
      venues: VENUES,
      scenarios,
    };
  }
  const out = path.join(FIX, ONLY && !MERGE ? `SERVING.${ONLY.replace(/,/g, '_')}.partial.json` : 'SERVING.json');
  fs.writeFileSync(out, JSON.stringify(file));
  const bad = report.filter((r) => r.mode !== 'trimmed');
  const errored = scenarios.filter((s) => s.error).map((s) => `${s.venue}/${s.tf}/S@${s.window}`);
  process.stderr.write(`done: ${scenarios.length} scenarios, ${report.length - bad.length} trimmed, other ${JSON.stringify(bad)}, errored ${JSON.stringify(errored)} -> ${out}\n`);
})();
