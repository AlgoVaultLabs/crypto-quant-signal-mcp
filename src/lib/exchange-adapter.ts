/**
 * Exchange adapter factory — all tools call through this,
 * never raw API fetch calls. Supports HL + Binance adapters.
 *
 * getAdapter()           → HyperliquidAdapter (backward compatible)
 * getAdapter('HL')       → HyperliquidAdapter
 * getAdapter('BINANCE')  → BinanceAdapter
 */
import type { ExchangeAdapter, ExchangeId } from '../types.js';
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

const adapters = new Map<ExchangeId, ExchangeAdapter>();

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
      case 'HL':
      default:
        adapter = new HyperliquidAdapter();
        break;
    }
    adapters.set(id, adapter);
  }
  return adapter;
}

export function setAdapter(adapter: ExchangeAdapter): void {
  adapters.set('HL', adapter);
}

export type { ExchangeAdapter };
