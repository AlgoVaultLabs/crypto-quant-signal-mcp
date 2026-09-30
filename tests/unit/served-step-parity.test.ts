/**
 * served-step-parity.test.ts — OPS-ADAPTER-HISTORY-ANCHOR-W1 CH2 (OAH-Q3).
 * Each adapter's module-local `servedIntervalMs` is the LEAF; `src/lib/tf-support.ts` projects it
 * (`servedCandleStepMs`, EDGE-LABELER-RACE-WINDOW-V2-W1). They are ONE lookup only if a test says so. This
 * test runs in a CHILD process, against the compiled dist, in the PRODUCTION import order (exchange-adapter
 * first, as the server and both labelers load it). That order is the one where an adapter importing tf-support
 * would be handed `undefined` by the require cycle, so a silent requested-step fallback shows up here.
 * LRW CH2 landed the projection on origin/main (c553578c, 2026-09-30) before this chapter was committed, so
 * the SKIPPED_PRE_LRW branch the ruling allowed is closed: a missing projection now FAILS (the child still
 * names it, for the diagnosis). It never asserts against another worktree.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const CHILD = String.raw`
const path = require('path');
const root = process.argv[1];
require(path.join(root, 'dist/lib/exchange-adapter.js'));
const tf = require(path.join(root, 'dist/lib/tf-support.js'));
const files = { HL: 'hyperliquid', BINANCE: 'binance', BYBIT: 'bybit', OKX: 'okx', BITGET: 'bitget', ASTER: 'aster', EDGEX: 'edgex', GATE: 'gateio', MEXC: 'mexc', KUCOIN: 'kucoin', PHEMEX: 'phemex', BINGX: 'bingx', HTX: 'htx', WEEX: 'weex', BITMART: 'bitmart', XT: 'xt', WHITEBIT: 'whitebit' };
const tfs = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d'];
if (typeof tf.servedCandleStepMs !== 'function') { console.log('PARITY: SKIPPED_PRE_LRW'); process.exit(0); }
const bad = [];
let n = 0;
for (const [v, f] of Object.entries(files)) {
  const leaf = require(path.join(root, 'dist/lib/adapters', f + '.js')).servedIntervalMs;
  for (const t of tfs) { n++; const a = tf.servedCandleStepMs(v, t), b = leaf(t); if (b != null && a !== b) bad.push(v + '/' + t + ':' + a + '!=' + b); }
}
console.log(bad.length ? 'PARITY: FAIL ' + bad.join(' ') : 'PARITY: PASS ' + n);
`;

describe('servedCandleStepMs projects the adapters\' own servedIntervalMs (OAH-Q3)', () => {
  it('holds for 17 venues × 11 timeframes in the production import order', { timeout: 60_000 }, () => {
    expect(fs.existsSync(path.join(ROOT, 'dist/lib/tf-support.js')), 'run `npm run build` first — this test reads dist/').toBe(true);
    const r = spawnSync(process.execPath, ['-e', CHILD, ROOT], { encoding: 'utf8', timeout: 50_000 });
    expect(r.status, r.stderr).toBe(0);
    const line = r.stdout.trim().split('\n').pop() ?? '';
    expect(line).toBe('PARITY: PASS 187');
  });
});
