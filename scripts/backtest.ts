#!/usr/bin/env npx tsx
/**
 * Backtest script for crypto-quant-signal-mcp
 *
 * Fetches 90 days of 1h candles from Hyperliquid for BTC and ETH,
 * walks through them chronologically, and applies the EXACT same
 * scoring logic used by the live get_trade_signal tool.
 *
 * Indicators imported directly from src/lib/indicators.ts.
 * Scoring weights replicated verbatim from src/tools/get-trade-signal.ts.
 */

import { fetchCandles } from '../src/lib/hyperliquid.js';
import { rsi, ema, emaLast } from '../src/lib/indicators.js';
import type { Candle } from '../src/types.js';
import fs from 'node:fs';
import path from 'node:path';

// ── Types ──

type Signal = 'BUY' | 'SELL' | 'HOLD';
type EmaCross = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

interface SignalEvent {
  coin: string;
  bar: number;
  timestamp: number;
  signal: Signal;
  confidence: number;
  priceAtSignal: number;
  rsi: number | null;
  emaCross: EmaCross;
  // Look-ahead outcomes
  priceAfter1h: number | null;
  priceAfter4h: number | null;
  priceAfter24h: number | null;
  returnPct1h: number | null;
  returnPct4h: number | null;
  returnPct24h: number | null;
  win1h: boolean | null;
  win4h: boolean | null;
  win24h: boolean | null;
}

interface AssetReport {
  coin: string;
  totalCandles: number;
  totalSignals: number;
  buys: number;
  sells: number;
  holds: number;
  signals: SignalEvent[];
}

interface HorizonStats {
  winRate: number | null;
  avgReturnPct: number;
  count: number;
}

interface BacktestResults {
  runDate: string;
  periodDays: number;
  assets: string[];
  combined: {
    totalSignals: number;
    buys: number;
    sells: number;
    holds: number;
    buyStats: { h1: HorizonStats; h4: HorizonStats; h24: HorizonStats };
    sellStats: { h1: HorizonStats; h4: HorizonStats; h24: HorizonStats };
    overallWinRate1h: number | null;
    overallWinRate4h: number | null;
    overallWinRate24h: number | null;
    sharpeRatio: number | null;
    maxConsecutiveWins: number;
    maxConsecutiveLosses: number;
    bestSignal: { coin: string; signal: Signal; returnPct: number; timestamp: number } | null;
    worstSignal: { coin: string; signal: Signal; returnPct: number; timestamp: number } | null;
  };
  byAsset: Record<string, AssetReport>;
  verdict: string;
  flags: string[];
}

// ── Constants ──

const LOOKBACK = 100;      // candles to feed into indicators
const COINS = ['BTC', 'ETH'];
const INTERVAL = '1h';
const DAYS = 90;

// ── Scoring logic — EXACT copy from src/tools/get-trade-signal.ts ──

function scoreBar(
  closes: number[],
  volumes: number[],
): { signal: Signal; confidence: number; rsiVal: number | null; emaCross: EmaCross } {
  const rsiVal = rsi(closes, 14);
  const ema9Series = ema(closes, 9);
  const ema21Series = ema(closes, 21);

  // EMA crossover detection — verbatim from get-trade-signal.ts lines 54-67
  let emaCross: EmaCross = 'NEUTRAL';
  if (ema9Series && ema21Series && ema9Series.length >= 2) {
    const len = ema9Series.length;
    const curr9 = ema9Series[len - 1];
    const prev9 = ema9Series[len - 2];
    const curr21 = ema21Series[len - 1];
    const prev21 = ema21Series[len - 2];
    if (!isNaN(curr9) && !isNaN(prev9) && !isNaN(curr21) && !isNaN(prev21)) {
      if (curr9 > curr21 && prev9 <= prev21) emaCross = 'BULLISH';
      else if (curr9 < curr21 && prev9 >= prev21) emaCross = 'BEARISH';
      else if (curr9 > curr21) emaCross = 'BULLISH';
      else if (curr9 < curr21) emaCross = 'BEARISH';
    }
  }

  // ── Score each indicator — verbatim weights from get-trade-signal.ts ──

  // RSI score (25% weight) — lines 88-95
  let rsiScore = 0;
  if (rsiVal !== null) {
    if (rsiVal < 30) rsiScore = 80;
    else if (rsiVal < 40) rsiScore = 40;
    else if (rsiVal <= 60) rsiScore = 0;
    else if (rsiVal <= 70) rsiScore = -40;
    else rsiScore = -80;
  }

  // EMA cross score (30% weight) — lines 98-100
  let emaScore = 0;
  if (emaCross === 'BULLISH') emaScore = 100;
  else if (emaCross === 'BEARISH') emaScore = -100;

  // Funding rate score (20% weight) — lines 103-105
  // NOTE: Historical funding rates are NOT available in candle data.
  // In the live tool, funding comes from metaAndAssetCtxs (real-time only).
  // Backtest sets fundingScore = 0 (neutral). This means 20% of the weight
  // is zeroed out. The backtest tests the candle-derived 80% of the model.
  const fundingScore = 0;

  // OI score (15% weight) — lines 108-112
  // NOTE: Same situation — OI is live-only from metaAndAssetCtxs.
  // Backtest sets oiScore = 0 (neutral). 15% of the weight is zeroed out.
  const oiScore = 0;

  // Volume multiplier (10% weight) — lines 115-118
  const avgCandleVol = volumes.reduce((s, v) => s + v, 0) / volumes.length;
  const lastCandleVol = volumes[volumes.length - 1];
  let volumeMultiplier = 1.0;
  if (avgCandleVol > 0 && lastCandleVol > 1.5 * avgCandleVol) {
    volumeMultiplier = 1.1;
  }

  // Weighted sum — line 121
  const rawScore =
    (rsiScore * 0.25 + emaScore * 0.30 + fundingScore * 0.20 + oiScore * 0.15) * volumeMultiplier;

  // Map to signal — lines 124-127
  let signal: Signal;
  if (rawScore > 25) signal = 'BUY';
  else if (rawScore < -25) signal = 'SELL';
  else signal = 'HOLD';

  const confidence = Math.min(Math.round(Math.abs(rawScore)), 100);

  return { signal, confidence, rsiVal, emaCross };
}

// ── Fetch data ──

async function fetchAllCandles(coin: string): Promise<Candle[]> {
  const startTime = Date.now() - DAYS * 24 * 60 * 60 * 1000;
  console.log(`  Fetching ${DAYS}d of ${INTERVAL} candles for ${coin}...`);
  const candles = await fetchCandles(coin, INTERVAL, startTime);
  console.log(`  Got ${candles.length} candles (${(candles.length / 24).toFixed(0)} days)`);
  return candles;
}

// ── Walk candles and generate signals ──

function walkCandles(coin: string, candles: Candle[]): AssetReport {
  const signals: SignalEvent[] = [];

  // Start at bar LOOKBACK so we always have 100 candles of history
  for (let i = LOOKBACK; i < candles.length; i++) {
    const window = candles.slice(i - LOOKBACK, i + 1); // 101 candles: 100 history + current
    const closes = window.map(c => c.close);
    const volumes = window.map(c => c.volume);

    const { signal, confidence, rsiVal, emaCross } = scoreBar(closes, volumes);

    const currentPrice = closes[closes.length - 1];
    const timestamp = candles[i].time;

    // Look ahead for outcomes
    const after1h = i + 1 < candles.length ? candles[i + 1].close : null;
    const after4h = i + 4 < candles.length ? candles[i + 4].close : null;
    const after24h = i + 24 < candles.length ? candles[i + 24].close : null;

    const ret1h = after1h !== null ? ((after1h - currentPrice) / currentPrice) * 100 : null;
    const ret4h = after4h !== null ? ((after4h - currentPrice) / currentPrice) * 100 : null;
    const ret24h = after24h !== null ? ((after24h - currentPrice) / currentPrice) * 100 : null;

    // Win logic: BUY wins if price up, SELL wins if price down
    const isWin = (sig: Signal, ret: number | null): boolean | null => {
      if (ret === null || sig === 'HOLD') return null;
      if (sig === 'BUY') return ret > 0;
      if (sig === 'SELL') return ret < 0;
      return null;
    };

    signals.push({
      coin,
      bar: i,
      timestamp,
      signal,
      confidence,
      priceAtSignal: currentPrice,
      rsi: rsiVal,
      emaCross,
      priceAfter1h: after1h,
      priceAfter4h: after4h,
      priceAfter24h: after24h,
      returnPct1h: ret1h,
      returnPct4h: ret4h,
      returnPct24h: ret24h,
      win1h: isWin(signal, ret1h),
      win4h: isWin(signal, ret4h),
      win24h: isWin(signal, ret24h),
    });
  }

  return {
    coin,
    totalCandles: candles.length,
    totalSignals: signals.length,
    buys: signals.filter(s => s.signal === 'BUY').length,
    sells: signals.filter(s => s.signal === 'SELL').length,
    holds: signals.filter(s => s.signal === 'HOLD').length,
    signals,
  };
}

// ── Stats computation ──

function computeHorizonStats(
  signals: SignalEvent[],
  type: 'BUY' | 'SELL',
  horizon: 'win1h' | 'win4h' | 'win24h',
  retField: 'returnPct1h' | 'returnPct4h' | 'returnPct24h',
): HorizonStats {
  const filtered = signals.filter(s => s.signal === type && s[horizon] !== null);
  if (filtered.length === 0) return { winRate: null, avgReturnPct: 0, count: 0 };

  const wins = filtered.filter(s => s[horizon] === true).length;
  const returns = filtered.map(s => {
    const r = s[retField]!;
    return type === 'SELL' ? -r : r; // SELL profits when price drops
  });

  return {
    winRate: wins / filtered.length,
    avgReturnPct: returns.reduce((a, b) => a + b, 0) / returns.length,
    count: filtered.length,
  };
}

function computeSharpe(signals: SignalEvent[]): number | null {
  // Use 1h returns for all non-HOLD signals that have outcomes
  const returns = signals
    .filter(s => s.signal !== 'HOLD' && s.returnPct1h !== null)
    .map(s => {
      const r = s.returnPct1h!;
      return s.signal === 'SELL' ? -r : r;
    });

  if (returns.length < 2) return null;

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return null;
  // Annualize: ~8760 1h periods per year
  return (mean / stdDev) * Math.sqrt(8760);
}

function computeStreaks(signals: SignalEvent[]): { maxWins: number; maxLosses: number } {
  let maxWins = 0;
  let maxLosses = 0;
  let curWins = 0;
  let curLosses = 0;

  for (const s of signals) {
    if (s.win4h === true) {
      curWins++;
      curLosses = 0;
      if (curWins > maxWins) maxWins = curWins;
    } else if (s.win4h === false) {
      curLosses++;
      curWins = 0;
      if (curLosses > maxLosses) maxLosses = curLosses;
    }
  }
  return { maxWins, maxLosses };
}

function findBestWorst(signals: SignalEvent[]) {
  let best: SignalEvent | null = null;
  let worst: SignalEvent | null = null;
  let bestRet = -Infinity;
  let worstRet = Infinity;

  for (const s of signals) {
    if (s.signal === 'HOLD' || s.returnPct4h === null) continue;
    const adjRet = s.signal === 'SELL' ? -(s.returnPct4h) : s.returnPct4h;
    if (adjRet > bestRet) { bestRet = adjRet; best = s; }
    if (adjRet < worstRet) { worstRet = adjRet; worst = s; }
  }

  return {
    best: best ? { coin: best.coin, signal: best.signal, returnPct: bestRet, timestamp: best.timestamp } : null,
    worst: worst ? { coin: worst.coin, signal: worst.signal, returnPct: worstRet, timestamp: worst.timestamp } : null,
  };
}

// ── Formatting helpers ──

function pct(v: number | null, decimals = 2): string {
  if (v === null) return 'N/A';
  return `${(v * 100).toFixed(decimals)}%`;
}

function pctRaw(v: number, decimals = 2): string {
  return `${v.toFixed(decimals)}%`;
}

function num(v: number | null, decimals = 2): string {
  if (v === null) return 'N/A';
  return v.toFixed(decimals);
}

function padR(s: string, w: number): string {
  return s.padEnd(w);
}

function padL(s: string, w: number): string {
  return s.padStart(w);
}

function printRow(cols: string[], widths: number[]): string {
  return '│ ' + cols.map((c, i) => padR(c, widths[i])).join(' │ ') + ' │';
}

function printSep(widths: number[], ch: '┬' | '┼' | '┴' = '┼'): string {
  const left = ch === '┬' ? '┌' : ch === '┴' ? '└' : '├';
  const right = ch === '┬' ? '┐' : ch === '┴' ? '┘' : '┤';
  return left + widths.map(w => '─'.repeat(w + 2)).join(ch) + right;
}

// ── Main ──

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   crypto-quant-signal-mcp  ·  90-Day Historical Backtest  ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log();
  console.log(`Period: ${DAYS} days of ${INTERVAL} candles`);
  console.log(`Assets: ${COINS.join(', ')}`);
  console.log(`Lookback per bar: ${LOOKBACK} candles`);
  console.log(`Signal weights: RSI 25% · EMA 30% · Funding 20%* · OI 15%* · Volume 10%`);
  console.log(`  * Funding & OI zeroed in backtest (live-only data — 35% of weight inactive)`);
  console.log();

  // Fetch data for all coins
  const assetReports: Record<string, AssetReport> = {};
  const allSignals: SignalEvent[] = [];

  for (const coin of COINS) {
    const candles = await fetchAllCandles(coin);
    const report = walkCandles(coin, candles);
    assetReports[coin] = report;
    allSignals.push(...report.signals);
    console.log(`  ${coin}: ${report.totalSignals} signals (${report.buys} BUY / ${report.sells} SELL / ${report.holds} HOLD)`);
  }

  console.log();

  // ── Combined stats ──
  const allNonHold = allSignals.filter(s => s.signal !== 'HOLD');
  const buys = allSignals.filter(s => s.signal === 'BUY');
  const sells = allSignals.filter(s => s.signal === 'SELL');

  const buyH1 = computeHorizonStats(allSignals, 'BUY', 'win1h', 'returnPct1h');
  const buyH4 = computeHorizonStats(allSignals, 'BUY', 'win4h', 'returnPct4h');
  const buyH24 = computeHorizonStats(allSignals, 'BUY', 'win24h', 'returnPct24h');

  const sellH1 = computeHorizonStats(allSignals, 'SELL', 'win1h', 'returnPct1h');
  const sellH4 = computeHorizonStats(allSignals, 'SELL', 'win4h', 'returnPct4h');
  const sellH24 = computeHorizonStats(allSignals, 'SELL', 'win24h', 'returnPct24h');

  // Overall win rates (non-HOLD)
  const overallWin = (field: 'win1h' | 'win4h' | 'win24h') => {
    const valid = allNonHold.filter(s => s[field] !== null);
    if (valid.length === 0) return null;
    return valid.filter(s => s[field] === true).length / valid.length;
  };

  const sharpe = computeSharpe(allSignals);
  const streaks = computeStreaks(allNonHold);
  const { best, worst } = findBestWorst(allSignals);

  // ── Print tables ──

  // Signal distribution
  console.log('┌─────────────────────────────────────────────┐');
  console.log('│          SIGNAL DISTRIBUTION                │');
  console.log('├─────────────────────────────────────────────┤');
  const totalSig = allSignals.length;
  console.log(`│  Total signals:  ${String(totalSig).padStart(6)}                      │`);
  console.log(`│  BUY:            ${String(buys.length).padStart(6)}  (${pctRaw(buys.length / totalSig * 100, 1).padStart(6)})          │`);
  console.log(`│  SELL:           ${String(sells.length).padStart(6)}  (${pctRaw(sells.length / totalSig * 100, 1).padStart(6)})          │`);
  console.log(`│  HOLD:           ${String(totalSig - buys.length - sells.length).padStart(6)}  (${pctRaw((totalSig - buys.length - sells.length) / totalSig * 100, 1).padStart(6)})          │`);
  console.log('└─────────────────────────────────────────────┘');
  console.log();

  // Win rates table
  const w = [10, 10, 10, 10, 10, 10];
  console.log(printSep(w, '┬'));
  console.log(printRow(['', 'BUY Win%', 'BUY Avg', 'SELL Win%', 'SELL Avg', 'All Win%'], w));
  console.log(printSep(w));
  console.log(printRow([
    '1h',
    pct(buyH1.winRate), pctRaw(buyH1.avgReturnPct),
    pct(sellH1.winRate), pctRaw(sellH1.avgReturnPct),
    pct(overallWin('win1h')),
  ], w));
  console.log(printRow([
    '4h',
    pct(buyH4.winRate), pctRaw(buyH4.avgReturnPct),
    pct(sellH4.winRate), pctRaw(sellH4.avgReturnPct),
    pct(overallWin('win4h')),
  ], w));
  console.log(printRow([
    '24h',
    pct(buyH24.winRate), pctRaw(buyH24.avgReturnPct),
    pct(sellH24.winRate), pctRaw(sellH24.avgReturnPct),
    pct(overallWin('win24h')),
  ], w));
  console.log(printSep(w, '┴'));
  console.log();

  // Key metrics
  console.log('┌─────────────────────────────────────────────┐');
  console.log('│          KEY METRICS                        │');
  console.log('├─────────────────────────────────────────────┤');
  console.log(`│  Sharpe Ratio (annualized): ${padL(num(sharpe), 10)}        │`);
  console.log(`│  Max consecutive wins:      ${padL(String(streaks.maxWins), 10)}        │`);
  console.log(`│  Max consecutive losses:    ${padL(String(streaks.maxLosses), 10)}        │`);
  if (best) {
    console.log(`│  Best signal:  ${best.signal.padEnd(4)} ${best.coin.padEnd(4)} ${pctRaw(best.returnPct).padStart(8)} @ ${new Date(best.timestamp).toISOString().slice(0, 10)}  │`);
  }
  if (worst) {
    console.log(`│  Worst signal: ${worst.signal.padEnd(4)} ${worst.coin.padEnd(4)} ${pctRaw(worst.returnPct).padStart(8)} @ ${new Date(worst.timestamp).toISOString().slice(0, 10)}  │`);
  }
  console.log('└─────────────────────────────────────────────┘');
  console.log();

  // Per-asset breakdown
  for (const coin of COINS) {
    const r = assetReports[coin];
    const coinSignals = r.signals;
    const coinBuyH4 = computeHorizonStats(coinSignals, 'BUY', 'win4h', 'returnPct4h');
    const coinSellH4 = computeHorizonStats(coinSignals, 'SELL', 'win4h', 'returnPct4h');
    const coinSharpe = computeSharpe(coinSignals);
    console.log(`  ${coin}: ${r.buys} BUY (4h win ${pct(coinBuyH4.winRate)}) | ${r.sells} SELL (4h win ${pct(coinSellH4.winRate)}) | Sharpe ${num(coinSharpe)}`);
  }
  console.log();

  // ── Verdict ──
  const flags: string[] = [];
  const wr4h = overallWin('win4h');

  if (wr4h !== null && wr4h < 0.50) {
    flags.push(`⚠️  Overall 4h win rate ${pct(wr4h)} is below 50%`);
  }
  if (sharpe !== null && sharpe < 0) {
    flags.push(`⚠️  Sharpe ratio ${num(sharpe)} is negative — risk-adjusted returns are poor`);
  }
  if (buyH4.winRate !== null && buyH4.winRate < 0.50) {
    flags.push(`⚠️  BUY 4h win rate ${pct(buyH4.winRate)} is below 50%`);
  }
  if (sellH4.winRate !== null && sellH4.winRate < 0.50) {
    flags.push(`⚠️  SELL 4h win rate ${pct(sellH4.winRate)} is below 50%`);
  }

  const hasEdge = (wr4h !== null && wr4h >= 0.50) && (sharpe !== null && sharpe > 0);

  console.log('╔══════════════════════════════════════════════════════════╗');
  if (hasEdge) {
    console.log('║  ✅ VERDICT: This signal configuration HAS a positive   ║');
    console.log('║     edge over the test period.                          ║');
  } else {
    console.log('║  ❌ VERDICT: This signal configuration DOES NOT HAVE a  ║');
    console.log('║     positive edge over the test period.                 ║');
  }
  console.log('╠══════════════════════════════════════════════════════════╣');

  if (flags.length > 0) {
    for (const f of flags) {
      console.log(`║  ${padR(f, 56)}║`);
    }
  }

  // Weight adjustment suggestions when edge is absent
  if (!hasEdge) {
    console.log('║                                                          ║');
    console.log('║  SUGGESTED WEIGHT ADJUSTMENTS:                           ║');
    console.log('║                                                          ║');
    if (buyH4.winRate !== null && sellH4.winRate !== null) {
      if (buyH4.winRate > sellH4.winRate) {
        console.log('║  • BUY signals outperform SELL — consider raising the   ║');
        console.log('║    signal threshold from -25 to -15 (emit fewer SELLs)  ║');
      } else {
        console.log('║  • SELL signals outperform BUY — consider raising the   ║');
        console.log('║    BUY threshold from 25 to 35 (emit fewer BUYs)        ║');
      }
    }
    console.log('║  • 35% of weight (funding + OI) is zeroed in backtest.  ║');
    console.log('║    Live performance with real funding/OI data will       ║');
    console.log('║    differ. Prioritize live tracking before changing      ║');
    console.log('║    weights.                                              ║');
    console.log('║  • Consider increasing EMA weight from 30% to 40% and   ║');
    console.log('║    reducing funding/OI to 10%/10% (these are noisy).    ║');
    console.log('║  • Add an ADX filter: only emit BUY/SELL when ADX > 20  ║');
    console.log('║    to avoid signals in choppy markets.                   ║');
    console.log('║  • Tighten RSI bands: 25/75 instead of 30/70 for        ║');
    console.log('║    higher-conviction entries.                            ║');
  }
  console.log('╚══════════════════════════════════════════════════════════╝');

  // ── Save raw results ──
  const results: BacktestResults = {
    runDate: new Date().toISOString(),
    periodDays: DAYS,
    assets: COINS,
    combined: {
      totalSignals: totalSig,
      buys: buys.length,
      sells: sells.length,
      holds: totalSig - buys.length - sells.length,
      buyStats: { h1: buyH1, h4: buyH4, h24: buyH24 },
      sellStats: { h1: sellH1, h4: sellH4, h24: sellH24 },
      overallWinRate1h: overallWin('win1h'),
      overallWinRate4h: overallWin('win4h'),
      overallWinRate24h: overallWin('win24h'),
      sharpeRatio: sharpe,
      maxConsecutiveWins: streaks.maxWins,
      maxConsecutiveLosses: streaks.maxLosses,
      bestSignal: best,
      worstSignal: worst,
    },
    byAsset: assetReports,
    verdict: hasEdge
      ? 'This signal configuration HAS a positive edge over the test period.'
      : 'This signal configuration DOES NOT HAVE a positive edge over the test period.',
    flags,
  };

  const outPath = path.join(process.cwd(), 'backtest-results.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log();
  console.log(`Raw results saved to: ${outPath}`);
}

main().catch(err => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
