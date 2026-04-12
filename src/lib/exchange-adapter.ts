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
