/**
 * SCAN-TRADE-CALLS-W1 C4 — webhook `top:N` asset selector.
 *
 * Covers: POST-time token validation matrix (findMalformedAssetToken),
 * token-aware subscriptionMatches with pre-resolved top-sets (D1), token+coin
 * mix, shadow-venue / resolution-failure fail-quiet non-match, and the
 * plain-coin regression (behavior byte-identical to pre-C4 for non-token subs).
 */
import { describe, it, expect } from 'vitest';
import { findMalformedAssetToken } from '../../src/lib/webhook-api.js';
import { subscriptionMatches, type DetectedEvent } from '../../src/lib/webhook-events.js';
import type { WebhookSubscription } from '../../src/lib/webhooks-store.js';

function makeSub(p: Partial<WebhookSubscription>): WebhookSubscription {
  return {
    id: 1,
    url: 'https://example.com/hook',
    secret: 'sec',
    events: ['trade_call'],
    assets: null,
    timeframes: null,
    min_confidence: null,
    tier: 'free',
    owner_key: 'k',
    active: true,
    consecutive_failures: 0,
    created_at: 0,
    last_delivered_at: null,
    ...p,
  };
}

function makeEvent(coin: string, exchange = 'BINANCE'): DetectedEvent {
  return {
    type: 'trade_call',
    eventId: 'evt-1',
    data: { type: 'trade_call', coin, timeframe: '15m', exchange, call: 'BUY', confidence: 80, created_at: 0 },
  };
}

describe('findMalformedAssetToken — POST validation matrix', () => {
  it('rejects malformed top: tokens', () => {
    expect(findMalformedAssetToken(['top:0'])).toBe('top:0');
    expect(findMalformedAssetToken(['top:101'])).toBe('top:101');
    expect(findMalformedAssetToken(['top:abc'])).toBe('top:abc');
    expect(findMalformedAssetToken(['top:'])).toBe('top:');
    expect(findMalformedAssetToken(['BTC', 'top:200'])).toBe('top:200');
  });
  it('accepts valid top:N tokens and plain coins (and mixes)', () => {
    expect(findMalformedAssetToken(['top:1'])).toBeNull();
    expect(findMalformedAssetToken(['top:100'])).toBeNull();
    expect(findMalformedAssetToken(['top:25'])).toBeNull();
    expect(findMalformedAssetToken(['BTC', 'ETH', 'top:10'])).toBeNull();
    expect(findMalformedAssetToken(['BTC'])).toBeNull();
  });
});

describe('subscriptionMatches — top:N token resolution (D1 pre-resolved sets)', () => {
  const topSets = new Map<number, Set<string>>([[10, new Set(['BTC', 'ETH', 'SOL'])]]);

  it('matches when the event coin is in the resolved top-N set', () => {
    expect(subscriptionMatches(makeSub({ assets: ['top:10'] }), makeEvent('BTC'), topSets)).toBe(true);
  });
  it('does not match when the event coin is outside the top-N set', () => {
    expect(subscriptionMatches(makeSub({ assets: ['top:10'] }), makeEvent('DOGE'), topSets)).toBe(false);
  });
  it('token + coin mix matches on either entry', () => {
    const sub = makeSub({ assets: ['SOL', 'top:10'] });
    expect(subscriptionMatches(sub, makeEvent('SOL'), new Map())).toBe(true); // plain coin (no token resolution needed)
    expect(subscriptionMatches(sub, makeEvent('ETH'), topSets)).toBe(true); // via token
    expect(subscriptionMatches(sub, makeEvent('XRP'), topSets)).toBe(false); // neither
  });
  it('shadow-venue event never matches a token (resolver returns empty map)', () => {
    expect(subscriptionMatches(makeSub({ assets: ['top:10'] }), makeEvent('BTC', 'ASTER'), new Map())).toBe(false);
  });
  it('resolution failure (token N absent) → non-matching, fail-quiet', () => {
    expect(subscriptionMatches(makeSub({ assets: ['top:10'] }), makeEvent('BTC'), new Map())).toBe(false);
  });
  it('undefined topSets → token non-matching (never throws)', () => {
    expect(subscriptionMatches(makeSub({ assets: ['top:10'] }), makeEvent('BTC'))).toBe(false);
  });
});

describe('subscriptionMatches — plain-coin regression (byte-identical to pre-C4)', () => {
  it('exact coin match unchanged; no topSets argument needed', () => {
    expect(subscriptionMatches(makeSub({ assets: ['BTC'] }), makeEvent('BTC'))).toBe(true);
    expect(subscriptionMatches(makeSub({ assets: ['BTC'] }), makeEvent('ETH'))).toBe(false);
  });
  it('null assets = all assets (matches any coin)', () => {
    expect(subscriptionMatches(makeSub({ assets: null }), makeEvent('WHATEVER'))).toBe(true);
  });
  it('timeframe and min_confidence filters still apply', () => {
    expect(subscriptionMatches(makeSub({ assets: ['BTC'], timeframes: ['1h'] }), makeEvent('BTC'))).toBe(false);
    expect(subscriptionMatches(makeSub({ assets: ['BTC'], min_confidence: 90 }), makeEvent('BTC'))).toBe(false);
  });
});
