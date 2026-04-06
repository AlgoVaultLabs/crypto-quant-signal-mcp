/**
 * Exchange adapter interface — all tools call through this,
 * never raw API fetch calls. Enables future Binance/Bybit adapters.
 */
import type { ExchangeAdapter } from '../types.js';
import { HyperliquidAdapter } from './adapters/hyperliquid.js';

let defaultAdapter: ExchangeAdapter | null = null;

export function getAdapter(): ExchangeAdapter {
  if (!defaultAdapter) {
    defaultAdapter = new HyperliquidAdapter();
  }
  return defaultAdapter;
}

export function setAdapter(adapter: ExchangeAdapter): void {
  defaultAdapter = adapter;
}

export type { ExchangeAdapter };
