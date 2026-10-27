/**
 * GROWTH-AGENT-SIGNIN-OAUTH-W1 CH1 — the ONE declaration of Anthropic's published egress.
 * `stepup-readout.py` builds its set A from `anthropicEgressNetworks()` in-container, so the
 * network list must equal the readout's retired `160.79.104..111` loop exactly (SET_A_UNCHANGED).
 */
import { beforeEach, describe, expect, it } from 'vitest';

const egress = await import('../../src/lib/platform-egress.js');
const { hashIp } = await import('../../src/lib/analytics.js');

describe('isAnthropicEgressIp — 160.79.104.0/21 edges', () => {
  it.each([
    ['160.79.103.255', false],
    ['160.79.104.0', true],
    ['160.79.107.42', true],
    ['160.79.111.255', true],
    ['160.79.112.0', false],
    ['::ffff:160.79.104.1', true],
    ['::ffff:160.79.112.1', false],
    ['2600:1f18::1', false],
    ['not-an-ip', false],
    ['', false],
  ])('%s → %s', (ip, want) => {
    expect(egress.isAnthropicEgressIp(ip)).toBe(want);
  });

  it('null / undefined are outside', () => {
    expect(egress.isAnthropicEgressIp(null)).toBe(false);
    expect(egress.isAnthropicEgressIp(undefined)).toBe(false);
  });
});

describe('set A is unchanged by the move', () => {
  beforeEach(() => { process.env.ALGOVAULT_IP_HASH_KEY = 'k'.repeat(32); });

  it('the networks are exactly the retired 104..111 loop, in order', () => {
    const loop: string[] = [];
    for (let i = 104; i <= 111; i++) loop.push('160.79.' + i + '.0');
    expect(egress.anthropicEgressNetworks()).toEqual(loop);
    expect(egress.anthropicEgressNetworks().every((n) => egress.isAnthropicEgressIp(n))).toBe(true);
  });

  it('isAnthropicEgressHash matches set A and nothing else', () => {
    expect(egress.isAnthropicEgressHash(hashIp('160.79.109.0'))).toBe(true);
    expect(egress.isAnthropicEgressHash(hashIp('160.79.112.0'))).toBe(false);
    expect(egress.isAnthropicEgressHash(null)).toBe(false);
  });

  it('refuses, never throws, without an ip-hash key', () => {
    const h = hashIp('160.79.104.0');
    delete process.env.ALGOVAULT_IP_HASH_KEY;
    expect(() => egress.isAnthropicEgressHash(h)).not.toThrow();
    expect(egress.isAnthropicEgressHash(h)).toBe(false);
  });
});
