'use strict';
// Write UNIVERSE.json, UNSERVABLE.json, CONTROLS.json, MODEL-PROBES.json into the fixture dir.
const fs = require('fs'), path = require('path');
const [WT, MACDIR, FIX, VENUES_READ_AT] = process.argv.slice(2);
const D = (p) => require(path.join(WT, 'dist', p));
const tfs = D('lib/tf-support.js');
const TF_MS = D('lib/pfe-mae.js').TF_MS;
const FILES = { ASTER: 'aster', BINANCE: 'binance', BINGX: 'bingx', BITGET: 'bitget', BYBIT: 'bybit', GATE: 'gateio', HL: 'hyperliquid', HTX: 'htx', KUCOIN: 'kucoin', MEXC: 'mexc', OKX: 'okx', PHEMEX: 'phemex', WEEX: 'weex', WHITEBIT: 'whitebit', XT: 'xt' };
const promoted = Object.keys(FILES);
const pairs = [];
for (const v of promoted) {
  const served = D(`lib/adapters/${FILES[v]}.js`).servedIntervalMs;
  for (const tf of tfs.CRON_TIMEFRAMES) {
    const faithful = tfs.isTimeframeFaithful(v, tf);
    const s = served(tf);
    if (s == null) continue; // not in the adapter's map: refused before any request (OPS-SERVED-CANDLE-TRUTH-W1 CH2)
    if (faithful || s !== TF_MS[tf]) pairs.push({ pair: `${v}/${tf}`, faithful, servedMs: s, requestedMs: TF_MS[tf] });
  }
}
const w = (f, o) => fs.writeFileSync(path.join(FIX, f), JSON.stringify(o, null, 1) + '\n');
w('UNIVERSE.json', {
  wave: 'OPS-ADAPTER-HISTORY-ANCHOR-W1',
  note: 'OAH-Q9: active promoted venues × faithful cron timeframes (isTimeframeFaithful), plus the served≠requested pairs outside that set (captured for REACH, not in the contract universe). The promoted set is read from the venues table (a lifecycle read, not a label) and pinned here; BITMART and EDGEX are retired and excluded.',
  promotedReadAt: VENUES_READ_AT,
  promoted,
  retiredExcluded: ['BITMART', 'EDGEX'],
  cronTimeframes: [...tfs.CRON_TIMEFRAMES],
  pairs,
});
w('UNSERVABLE.json', {
  wave: 'OPS-SERVED-CANDLE-TRUTH-W1',
  note: "Emptied in OPS-SERVED-CANDLE-TRUTH-W1 CH2. Its two pairs (OKX/8h: code 51000; BYBIT/8h: an empty list) left their adapters' interval maps, so getCandles refuses them with TimeframeUnservedError before any request and isTimeframeFaithful reports them unfaithful; their R/D captures left the fixtures with them (the last tree holding them: 809301a8). A pair the venue will not serve is removed from the adapter map, never declared here: the contract suite's served-map truth test fails on a mapped timeframe with no captured evidence. The file stays because the live canary reads it (adapter-history-contiguity --expect {reach, unservable}).",
  pairs: [],
});
const ex = JSON.parse(fs.readFileSync(path.join(MACDIR, 'EXTRAS.raw.json'), 'utf8'));
w('CONTROLS.json', {
  wave: 'OPS-ADAPTER-HISTORY-ANCHOR-W1',
  note: "The venue's own history page anchored on the SERVED step for a window the adapter returned incomplete. When it covers the window, the incompleteness is the adapter's (C1), not the venue's reach. Captured on the Mac next to the adapter capture.",
  controls: ex.controls.map((c) => ({ tag: 'CONTROL', pair: c.pair, scenario: c.scenario, from: c.from, to: c.to, servedMs: c.servedMs, parser: c.parser, url: c.url, calledAt: c.calledAt, status: c.status, json: c.body ? JSON.parse(c.body) : null })),
});
w('MODEL-PROBES.json', {
  wave: 'OPS-ADAPTER-HISTORY-ANCHOR-W1',
  note: "Raw boundary probes (off-grid endTime/startTime/after/before, Bitget's 90-day /candles window) for the CH2 synthetic Bitget/OKX venue; not read by the CH1 suite.",
  bitgetListingMs: ex.bitgetListing, okxListingMs: ex.okxListing,
  probes: ex.probes.map((p) => ({ pair: p.pair, url: p.url, calledAt: p.calledAt, status: p.status, json: p.body ? JSON.parse(p.body) : null })),
});
console.log('universe pairs', pairs.length, 'faithful', pairs.filter((p) => p.faithful).length, 'controls', ex.controls.length, 'probes', ex.probes.length);
