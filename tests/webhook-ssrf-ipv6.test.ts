/**
 * OPS-WEBHOOK-SSRF-IP-PIN-W1 (SECURITY-FIX-X402-WEBHOOK-W1 Stream B) — WH-02/WH-05.
 *
 * The SSRF block-class matrix for the IPv6 SSRF bypasses the prior `classifyIpv6`
 * regex missed:
 *   - WH-02: hex-form IPv4-mapped IPv6 (`::ffff:7f00:1` = 127.0.0.1). WHATWG `URL`
 *            normalizes the dotted `[::ffff:127.0.0.1]` → hex `[::ffff:7f00:1]`,
 *            so the dotted-only regex was dead for any URL-sourced host.
 *   - WH-05: NAT64 `64:ff9b::/96` embeds an IPv4 that escaped classification.
 * Fix: classify on the PARSED address (expand `::`, read the embedded v4 from the
 * last 32 bits) and run `classifyIpv4` on the embedded address.
 *
 * MUST NOT regress legit public IPv6 (no false-positive).
 */
import { describe, it, expect } from 'vitest';
import { classifyIpv6, classifyIp, assertEgressAllowed, EgressBlockedError } from '../src/lib/webhook-ssrf.js';

describe('classifyIpv6: IPv4-mapped (hex + dotted), IPv4-compatible, NAT64', () => {
  it('blocks hex-form IPv4-mapped IPv6 embedding an internal v4 (WH-02)', () => {
    // ::ffff:7f00:1 = 127.0.0.1 (loopback); ::ffff:a00:1 = 10.0.0.1 (private)
    expect(classifyIpv6('::ffff:7f00:1').blocked, '::ffff:7f00:1 (127.0.0.1)').toBe(true);
    expect(classifyIpv6('::ffff:7f00:1').isLoopback).toBe(true);
    expect(classifyIpv6('::ffff:a00:1').blocked, '::ffff:a00:1 (10.0.0.1)').toBe(true);
    // 169.254.169.254 (cloud metadata) in hex IPv4-mapped form = ::ffff:a9fe:a9fe
    expect(classifyIpv6('::ffff:a9fe:a9fe').blocked, '::ffff:a9fe:a9fe (169.254.169.254)').toBe(true);
  });

  it('still blocks the dotted IPv4-mapped form (no regression)', () => {
    expect(classifyIpv6('::ffff:10.0.0.1').blocked).toBe(true);
    expect(classifyIpv6('::ffff:127.0.0.1').blocked).toBe(true);
    expect(classifyIpv6('::ffff:127.0.0.1').isLoopback).toBe(true);
  });

  it('blocks NAT64 64:ff9b::/96 embedding an internal v4 (WH-05)', () => {
    // 64:ff9b::7f00:1 = NAT64(127.0.0.1); 64:ff9b::a00:1 = NAT64(10.0.0.1)
    expect(classifyIpv6('64:ff9b::7f00:1').blocked, '64:ff9b::7f00:1 (127.0.0.1)').toBe(true);
    expect(classifyIpv6('64:ff9b::a00:1').blocked, '64:ff9b::a00:1 (10.0.0.1)').toBe(true);
    expect(classifyIpv6('64:ff9b::a9fe:a9fe').blocked, '64:ff9b::a9fe:a9fe (169.254.169.254)').toBe(true);
    // dotted NAT64 too
    expect(classifyIpv6('64:ff9b::10.0.0.1').blocked).toBe(true);
  });

  it('blocks IPv4-compatible (deprecated) `::a.b.c.d` embedding an internal v4', () => {
    // ::7f00:1 = ::127.0.0.1 (deprecated IPv4-compatible)
    expect(classifyIpv6('::7f00:1').blocked, '::7f00:1 (127.0.0.1)').toBe(true);
    expect(classifyIpv6('::a00:1').blocked, '::a00:1 (10.0.0.1)').toBe(true);
  });

  it('keeps blocking the existing internal IPv6 classes', () => {
    expect(classifyIpv6('::1').blocked).toBe(true);
    expect(classifyIpv6('::1').isLoopback).toBe(true);
    expect(classifyIpv6('::').blocked).toBe(true);
    expect(classifyIpv6('fe80::1').blocked).toBe(true);
    expect(classifyIpv6('fc00::1').blocked).toBe(true);
    expect(classifyIpv6('fd12:3456::1').blocked).toBe(true);
  });

  it('does NOT false-positive a legit public IPv6 (Cloudflare/Google DNS)', () => {
    expect(classifyIpv6('2606:4700:4700::1111').blocked, 'Cloudflare 1.1.1.1 v6').toBe(false);
    expect(classifyIpv6('2001:4860:4860::8888').blocked, 'Google 8.8.8.8 v6').toBe(false);
    expect(classifyIpv6('2620:fe::fe').blocked, 'Quad9 v6').toBe(false);
    // A normal-looking public address that merely STARTS with 64: but is not the
    // NAT64 well-known prefix must remain public.
    expect(classifyIpv6('64:ff9c::1').blocked, '64:ff9c:: (not NAT64 64:ff9b)').toBe(false);
  });

  it('embedded PUBLIC v4 in a mapped/NAT64 wrapper stays public (only internal embedded blocks)', () => {
    // ::ffff:0808:0808 = ::ffff:8.8.8.8 (public)
    expect(classifyIpv6('::ffff:808:808').blocked, '::ffff:8.8.8.8 (public)').toBe(false);
    // 64:ff9b::0808:0808 = NAT64(8.8.8.8) (public embedded → public)
    expect(classifyIpv6('64:ff9b::808:808').blocked, 'NAT64(8.8.8.8)').toBe(false);
  });
});

describe('assertEgressAllowed: literal IPv6 bypass URLs are rejected (WH-02 end-to-end)', () => {
  // These are the exact URLs that previously passed the sync guard at registration
  // AND the early-return in resolveAndAssertEgress (literal IP → no DNS).
  it('rejects WHATWG-normalized + hex IPv4-mapped + NAT64 literal-host URLs', () => {
    for (const url of [
      'https://[::ffff:7f00:1]/x',       // hex 127.0.0.1
      'https://[::ffff:a00:1]/x',        // hex 10.0.0.1
      'https://[::ffff:127.0.0.1]/x',    // dotted → URL normalizes to ::ffff:7f00:1
      'https://[::ffff:10.0.0.1]/x',     // the security-canary's RED case
      'https://[64:ff9b::7f00:1]/x',     // NAT64 127.0.0.1
      'https://[64:ff9b::a00:1]/x',      // NAT64 10.0.0.1
    ]) {
      expect(() => assertEgressAllowed(url), url).toThrow(EgressBlockedError);
    }
  });

  it('still allows a legit public IPv6 literal host', () => {
    expect(() => assertEgressAllowed('https://[2606:4700:4700::1111]/x')).not.toThrow();
  });
});

describe('classifyIp: dispatches v6 strings through the hardened classifier', () => {
  it('routes hex IPv4-mapped + NAT64 through classifyIpv6 and blocks', () => {
    expect(classifyIp('::ffff:7f00:1')?.blocked).toBe(true);
    expect(classifyIp('64:ff9b::a00:1')?.blocked).toBe(true);
    expect(classifyIp('2606:4700:4700::1111')?.blocked).toBe(false);
    expect(classifyIp('hooks.example.com')).toBeNull(); // hostname → not an IP
  });
});
