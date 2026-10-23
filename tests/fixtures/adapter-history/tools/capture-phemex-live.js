// OPS-SERVED-CANDLE-TRUTH-W1 CH3a: one Phemex live-price fixture — the 1h trade_call@100 kline page and the 24hr
// ticker, read back to back with the shipped adapter's own request shapes. Read-only public endpoints.
//   node tests/fixtures/adapter-history/tools/capture-phemex-live.js tests/fixtures/adapter-history/PHEMEX-LIVE-PRICE.json
'use strict';
const fs = require('fs');
const H = 3_600_000;
(async () => {
  const calledAt = Date.now();
  const kUrl = 'https://api.phemex.com/exchange/public/md/v2/kline/last?symbol=BTCUSDT&resolution=3600&limit=1000';
  const tUrl = 'https://api.phemex.com/md/v2/ticker/24hr?symbol=BTCUSDT';
  const k = await (await fetch(kUrl)).json();
  const tickerAt = Date.now();
  const t = await (await fetch(tUrl)).json();
  const from = calledAt - 100 * H;
  k.data.rows = k.data.rows.filter((r) => r[0] * 1000 >= from - 2 * H); // keep only what the window reads: rows opening more than 2 bars before `from` are dropped
  const out = { wave: 'OPS-SERVED-CANDLE-TRUTH-W1 CH3a', note: 'PHEMEX (declared closed-only kline venue): its 1h kline page and its ticker, read back to back from the Mac vantage. The ticker timestamp is ns.', coin: 'BTC', tf: '1h', from, calledAt, tickerAt, kline: { url: kUrl, body: k }, ticker: { url: tUrl, body: t } };
  fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1) + '\n');
  const newest = Math.max(...k.data.rows.map((r) => r[0])) * 1000;
  console.log('rows', k.data.rows.length, 'newest', new Date(newest).toISOString(), 'forming', new Date(Math.floor(calledAt / H) * H).toISOString(), 'ticker age ms', calledAt - t.result.timestamp / 1e6, 'closeRp', t.result.closeRp);
})().catch((e) => { console.error(e); process.exitCode = 3; });
