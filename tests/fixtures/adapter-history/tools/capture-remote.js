'use strict';
// Remote-body capture for a venue the Mac cannot reach reliably (WEEX times out from this vantage).
// Phase A (--urls): run the adapter DRY to learn the exact request it makes per tf → urls.tsv
// Phase B (--build): the bodies were fetched on the remote vantage at a recorded instant; feed each body to the
//                    SAME adapter with the clock frozen at that instant → R and D scenarios, same format as capture2.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const [WT, VENUE, MODE, DIR] = process.argv.slice(2);
const D = (p) => require(path.join(WT, 'dist', p));
const FILES = { WEEX: ['weex', 'WeexAdapter'] };
const tfs = D('lib/tf-support.js');
const { EVAL_CANDLES } = D('scripts/directional-labeler.js');
const TF_MS = D('lib/pfe-mae.js').TF_MS;
const mod = D(`lib/adapters/${FILES[VENUE][0]}.js`);
const served = (tf) => mod.servedIntervalMs(tf);
(async () => {
  if (MODE === '--urls') {
    const rows = [];
    for (const tf of tfs.CRON_TIMEFRAMES) {
      let url = null;
      globalThis.fetch = async (u) => { url = String(u); return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }); };
      try { await new mod[FILES[VENUE][1]]().getCandles('BTC', tf, Date.now() - 1000); } catch { /* dry */ }
      rows.push([tf, url].join('\t'));
    }
    fs.writeFileSync(path.join(DIR, 'urls.tsv'), rows.join('\n') + '\n');
    console.log(rows.join('\n'));
    return;
  }
  // --build: DIR has manifest.tsv (tf \t code \t rc \t fetchedAtMs) and b/<tf> bodies
  const man = Object.fromEntries(fs.readFileSync(path.join(DIR, 'manifest.tsv'), 'utf8').trim().split('\n').map((l) => { const [tf, code, rc, at] = l.split('\t'); return [tf, { code: +code, rc: +rc, at: +at }]; }));
  const urls = Object.fromEntries(fs.readFileSync(path.join(DIR, 'urls.tsv'), 'utf8').trim().split('\n').map((l) => l.split('\t')));
  const pairs = [];
  const realNow = Date.now;
  for (const tf of tfs.CRON_TIMEFRAMES) {
    const m = man[tf]; const body = fs.readFileSync(path.join(DIR, 'b', tf), 'utf8');
    const s = served(tf), W = EVAL_CANDLES[tf];
    const mk = async (tag, from, to) => {
      globalThis.fetch = async () => new Response(body, { status: m.code, headers: { 'content-type': 'application/json' } });
      Date.now = () => m.at;
      let out = null, err = null;
      try { out = await new mod[FILES[VENUE][1]]().getCandles('BTC', tf, from, undefined, to); } catch (e) { err = String(e.message || e); }
      Date.now = realNow;
      return { tag, venue: VENUE, tf, coin: 'BTC', from, to: to ?? null, calledAt: m.at, requestedMs: TF_MS[tf], servedMs: s, W, error: err,
        output: (out || []).map((c) => ({ ts: c.time, open: c.open })),
        requests: [{ url: urls[tf], method: 'GET', reqBody: null, calledAt: m.at, sentAt: m.at, status: m.code, body, sha256: crypto.createHash('sha256').update(body).digest('hex') }] };
    };
    const R = await mk('R', m.at - (2 * W + 1) * s, undefined);
    const from = m.at - (200 + 2 * W + 6) * s;
    const Dd = await mk('D', from, from + 2 * W * s);
    pairs.push({ pair: `${VENUE}/${tf}`, faithful: tfs.isTimeframeFaithful(VENUE, tf), R, D: Dd });
    console.log(`${VENUE}/${tf} R:${R.output.length}${R.error ? '!' : ''} D:${Dd.output.length}${Dd.error ? '!' : ''}`);
  }
  fs.writeFileSync(path.join(DIR, `${VENUE}.raw.json`), JSON.stringify({ venue: VENUE, capturedBy: 'aoe-1 body, adapter-built request and parse on the Mac (the Mac times out on this venue)', pairs }));
})();
