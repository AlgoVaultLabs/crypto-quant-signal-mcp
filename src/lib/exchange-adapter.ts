/**
 * Exchange adapter factory — all tools call through this,
 * never raw API fetch calls. Supports HL + Binance adapters.
 *
 * getAdapter()           → HyperliquidAdapter (backward compatible)
 * getAdapter('HL')       → HyperliquidAdapter
 * getAdapter('BINANCE')  → BinanceAdapter
 */
import type { Candle, ExchangeAdapter, ExchangeId } from '../types.js';
import { accountPage } from './adapters/_history-plan.js';
import { servedCandleStepMs } from './tf-support.js';
import { HEAD_STALE_BARS } from './serving-windows.js';
import { StaleUpstreamWindowError } from './errors.js';
import { HyperliquidAdapter } from './adapters/hyperliquid.js';
import { BinanceAdapter } from './adapters/binance.js';
import { BybitAdapter } from './adapters/bybit.js';
import { OKXAdapter } from './adapters/okx.js';
import { BitgetAdapter } from './adapters/bitget.js';
import { AsterAdapter } from './adapters/aster.js';
import { EdgeXAdapter } from './adapters/edgex.js';
import { GateAdapter } from './adapters/gateio.js';
import { MEXCAdapter } from './adapters/mexc.js';
import { KuCoinAdapter } from './adapters/kucoin.js';
import { PhemexAdapter } from './adapters/phemex.js';
import { BingxAdapter } from './adapters/bingx.js';
import { HTXAdapter } from './adapters/htx.js';
import { WeexAdapter } from './adapters/weex.js';
import { BitmartAdapter } from './adapters/bitmart.js';
import { XtAdapter } from './adapters/xt.js';
import { WhitebitAdapter } from './adapters/whitebit.js';

const adapters = new Map<ExchangeId, ExchangeAdapter>();

export type ServingWindowVerdict =
  | { stale: false }
  | { stale: true; headGapBars: number; headStaleBars: number; newestBarAt: number };

/**
 * OPS-SERVED-CANDLE-TRUTH-W1 CH1. The universal serving post-condition, pure. Account the bars a serving read returned
 * on the step the venue actually serves, and call the window stale when its head gap exceeds HEAD_STALE_BARS[tf]. The
 * ceiling is calibrated over the whole admitted universe; see src/lib/serving-windows.ts. A page that ended before
 * its window even began is the stalest case of all, so when the window holds no bar the returned bars are accounted
 * on their own. No bars, an unknown step or an unjudged timeframe is never stale: INSUFFICIENT_CANDLES and the
 * venue's own error own those.
 */
export function servingWindowVerdict(p: {
  bars: ReadonlyArray<{ time: number }>;
  servedStepMs: number | null;
  timeframe: string;
  startTime: number;
  nowMs: number;
}): ServingWindowVerdict {
  const headStaleBars = Object.hasOwn(HEAD_STALE_BARS, p.timeframe) ? HEAD_STALE_BARS[p.timeframe] : undefined;
  if (headStaleBars === undefined || p.servedStepMs == null || !(p.servedStepMs > 0)) return { stale: false };
  const past = p.bars.filter((c) => c.time <= p.nowMs);
  if (past.length === 0) return { stale: false };
  const ts = past.map((c) => ({ ts: c.time }));
  const oldest = Math.min(...past.map((c) => c.time));
  const facts = accountPage({ bars: ts, servedStepMs: p.servedStepMs, from: Math.min(p.startTime, oldest), to: null, nowMs: p.nowMs });
  const headGapBars = facts.headGapBars ?? 0;
  if (headGapBars <= headStaleBars) return { stale: false };
  return { stale: true, headGapBars, headStaleBars, newestBarAt: Math.max(...past.map((c) => c.time)) };
}

/**
 * The seam guard: wrap ONE adapter instance's `getCandles` so that every SERVING read (no `endTime`) is judged by
 * `servingWindowVerdict` and a stale window is refused with StaleUpstreamWindowError before any consumer sees it.
 * The guard does arithmetic on the returned bars only and makes zero extra requests. It returns the adapter's own
 * array (identity and its `meta` preserved). History reads pass straight through. It lives here, outside the adapter
 * modules, because an adapter may not import tf-support (the require cycle; see _history-plan.ts).
 */
function guardServingReads(adapter: ExchangeAdapter, venue: ExchangeId): ExchangeAdapter {
  const read = adapter.getCandles.bind(adapter);
  adapter.getCandles = async (coin, interval, startTime, dex, endTime): Promise<Candle[]> => {
    const bars = await read(coin, interval, startTime, dex, endTime);
    if (endTime !== undefined) return bars;
    const v = servingWindowVerdict({ bars, servedStepMs: servedCandleStepMs(venue, interval), timeframe: interval, startTime, nowMs: Date.now() });
    if (v.stale) {
      throw new StaleUpstreamWindowError({ coin, exchange: venue, timeframe: interval, newestBarAt: v.newestBarAt, headGapBars: v.headGapBars, headStaleBars: v.headStaleBars });
    }
    return bars;
  };
  return adapter;
}

export function getAdapter(exchange?: ExchangeId): ExchangeAdapter {
  const id = exchange || 'HL';
  let adapter = adapters.get(id);
  if (!adapter) {
    switch (id) {
      case 'BINANCE':
        adapter = new BinanceAdapter();
        break;
      case 'BYBIT':
        adapter = new BybitAdapter();
        break;
      case 'OKX':
        adapter = new OKXAdapter();
        break;
      case 'BITGET':
        adapter = new BitgetAdapter();
        break;
      case 'ASTER':
        adapter = new AsterAdapter();
        break;
      case 'EDGEX':
        adapter = new EdgeXAdapter();
        break;
      case 'GATE':
        adapter = new GateAdapter();
        break;
      case 'MEXC':
        adapter = new MEXCAdapter();
        break;
      case 'KUCOIN':
        adapter = new KuCoinAdapter();
        break;
      case 'PHEMEX':
        adapter = new PhemexAdapter();
        break;
      case 'BINGX':
        adapter = new BingxAdapter();
        break;
      case 'HTX':
        adapter = new HTXAdapter();
        break;
      case 'WEEX':
        adapter = new WeexAdapter();
        break;
      case 'BITMART':
        adapter = new BitmartAdapter();
        break;
      case 'XT':
        adapter = new XtAdapter();
        break;
      case 'WHITEBIT':
        adapter = new WhitebitAdapter();
        break;
      case 'HL':
      default:
        adapter = new HyperliquidAdapter();
        break;
    }
    adapters.set(id, guardServingReads(adapter, id));
  }
  return adapter;
}

export function setAdapter(adapter: ExchangeAdapter): void {
  adapters.set('HL', adapter);
}

export type { ExchangeAdapter };
