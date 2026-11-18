// tests/fixtures/regime-forward/non-coin-words.ts — EDGE-REGIME-FORWARD-W1: the committed allowlist of the words in
// this wave's tests and fixtures that have a venue symbol's shape and are not coins (re-check N7). The R6 check
// refuses every other such word outside the generator's reserved form, in any position. This wave owns the list;
// it is read from here, never from a served file.
export const NON_COIN_WORDS: ReadonlySet<string> = new Set([
  // venues and the quote side of an instrument
  'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'HYPERLIQUID', 'USDT', 'USDC', 'SWAP', 'FUTURES',
  // labels, sides, verdicts and the host read's row values
  'RANGING', 'TRENDING', 'VOLATILE', 'BUY', 'HOLD', 'SELL', 'PASS', 'FAIL', 'REFUSED', 'INDETERMINATE', 'UNDEFINED',
  'OK', 'EXTERNAL', 'MODERATE', 'WEAK', 'NEUTRAL', 'MARK', 'COMPLETE', 'PARTIAL',
  // the names of answers, audit findings, waves, windows and test coins of the registration and its audits
  'A4', 'A5', 'C1', 'C2', 'CH3', 'E12', 'FP', 'PRN', 'RV1', 'T3', 'T5', 'V8', 'W0', 'W1', 'Z0',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'F13', 'F15', 'F16',
  'N4', 'N5', 'N6', 'N7', 'R1', 'R2', 'R3', 'R4', 'R6',
  'ZZ1', 'ZZ2', 'ZZ3', 'ZZ4', 'ZZ5', 'ZZ6', 'ZZ7', 'ZZ9',
  // constants and names of the wave's own code and tests, and the generator's prefix
  'ATR', 'CASES', 'EDGE', 'EIO', 'EXTRA', 'FILES', 'FIRST', 'FLOORS', 'FORWARD', 'HOME', 'LOG', 'MANIFEST', 'NOW', 'OPTS',
  'OWED', 'PANEL', 'PERIOD', 'PRINTER', 'PRIOR', 'REG', 'REGIME', 'REGISTRATION', 'REPO', 'RESULT', 'ROOT', 'SEAL', 'STORE',
  'TFS', 'TREE', 'VENUES', 'WANT', 'WAVE', 'T5Q',
  // general abbreviations
  'HTTP', 'ID', 'IN', 'JSON', 'PATH', 'PI', 'README', 'RPC', 'URL', 'UTC',
]);
