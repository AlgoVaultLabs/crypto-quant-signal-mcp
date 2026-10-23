// OPS-SERVED-CANDLE-TRUTH-W1 Q11: one Aster live-price fixture — the 1m trade_call@100 kline page and the asset
// context (premiumIndex, openInterest, 24hr ticker), read back to back with the shipped adapter's own request shapes.
// Read-only public endpoints. It re-reads (≤ 20 times, 6 s apart) until the kline snapshot's newest close differs
// from the ticker's last price: the class the fixture exists to show (/fapi/v1/klines is a snapshot refreshed every
// ~70–90 s, so its close lags the last trade).
//   node tests/fixtures/adapter-history/tools/capture-aster-live.js tests/fixtures/adapter-history/ASTER-LIVE-PRICE.json
'use strict';
const fs = require('fs');
const M = 60_000;
const BASE = 'https://fapi.asterdex.com';
const get = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return { body: await r.json(), xCache: r.headers.get('x-cache') };
};
(async () => {
  for (let attempt = 1; attempt <= 20; attempt++) {
    const calledAt = Date.now();
    const from = calledAt - 100 * M;
    const kUrl = `${BASE}/fapi/v1/klines?symbol=BTCUSDT&interval=1m&startTime=${from}&limit=200`;
    const pUrl = `${BASE}/fapi/v1/premiumIndex?symbol=BTCUSDT`;
    const oUrl = `${BASE}/fapi/v1/openInterest?symbol=BTCUSDT`;
    const tUrl = `${BASE}/fapi/v1/ticker/24hr?symbol=BTCUSDT`;
    const k = await get(kUrl);
    const tickerAt = Date.now();
    const [p, o, t] = await Promise.all([get(pUrl), get(oUrl), get(tUrl)]);
    const newest = k.body[k.body.length - 1];
    const close = Number(newest[4]);
    const last = Number(t.body.lastPrice);
    console.log(`attempt ${attempt}: newest ${new Date(newest[0]).toISOString()} forming ${new Date(Math.floor(calledAt / M) * M).toISOString()} close ${close} lastPrice ${last} closeTime age ms ${calledAt - t.body.closeTime} x-cache ${k.xCache}`);
    if (close !== last) {
      const out = {
        wave: 'OPS-SERVED-CANDLE-TRUTH-W1 Q11',
        note: 'ASTER (declared SNAPSHOT_KLINE venue): its 1m kline page and its asset context, read back to back from the Mac vantage. The newest kline close differs from the 24hr ticker lastPrice (the last trade); closeTime is that trade\'s time.',
        coin: 'BTC', tf: '1m', from, calledAt, tickerAt, klineXCache: k.xCache,
        kline: { url: kUrl, body: k.body },
        premiumIndex: { url: pUrl, body: p.body },
        openInterest: { url: oUrl, body: o.body },
        ticker: { url: tUrl, body: t.body },
      };
      fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1) + '\n');
      return;
    }
    await new Promise((r) => setTimeout(r, 6_000));
  }
  console.error('no read in 20 showed a snapshot close apart from the last trade');
  process.exitCode = 3;
})().catch((e) => { console.error(e); process.exitCode = 3; });
