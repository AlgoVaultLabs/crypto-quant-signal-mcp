'use strict';
// One TSV row per fixture request (from the sanitized fixtures): id \t host \t method \t url \t base64(body)
const fs = require('fs'), path = require('path');
const [FIX, OUT, SKIP_VENUES] = process.argv.slice(2);
const skip = new Set((SKIP_VENUES || '').split(',').filter(Boolean));
const rows = [];
for (const v of ['ASTER','BINANCE','BINGX','BITGET','BYBIT','GATE','HL','HTX','KUCOIN','MEXC','OKX','PHEMEX','WEEX','WHITEBIT','XT']) {
  if (skip.has(v)) continue;
  const j = JSON.parse(fs.readFileSync(path.join(FIX, v + '.json'), 'utf8'));
  const scen = []; for (const p of j.pairs) scen.push(p.R, p.D); for (const s of j.extras || []) scen.push(s);
  for (const s of scen) s.requests.forEach((r, i) => rows.push([`${s.venue}__${s.tf}__${s.tag}__${i}`, new URL(r.url).host, r.method || 'GET', r.url, Buffer.from(r.reqBody || '').toString('base64')].join('\t')));
}
fs.writeFileSync(OUT, rows.join('\n') + '\n'); console.log(rows.length);
