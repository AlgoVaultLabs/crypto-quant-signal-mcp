/**
 * OPS-AUDIT-REMEDIATION-MED-W1 — SV-03 (response size cap) + SV-04 (default-deny
 * numeric parse) on the shared `_upstream-fetch` transport. Generator-level:
 * every DEX adapter (aster/edgex + future) inherits both.
 */
import { describe, it, expect } from 'vitest';
import { MAX_UPSTREAM_BYTES, safeUpstreamNum, readJsonCapped } from '../../src/lib/adapters/_upstream-fetch.js';

describe('SV-04 safeUpstreamNum — default-deny invalid numbers', () => {
  it('accepts valid decimals / scientific / numbers', () => {
    expect(safeUpstreamNum('1.5')).toBe(1.5);
    expect(safeUpstreamNum('-0.5')).toBe(-0.5);
    expect(safeUpstreamNum('.5')).toBe(0.5);
    expect(safeUpstreamNum('1e3')).toBe(1000);
    expect(safeUpstreamNum('  42  ')).toBe(42);
    expect(safeUpstreamNum(7)).toBe(7);
    expect(safeUpstreamNum('0')).toBe(0);
  });
  it('default-denies hex / NaN / Infinity / empty / garbage / non-string → null', () => {
    expect(safeUpstreamNum('0x1')).toBeNull();      // the exact audit case (parseFloat→0, Number→1)
    expect(safeUpstreamNum('NaN')).toBeNull();
    expect(safeUpstreamNum('Infinity')).toBeNull();
    expect(safeUpstreamNum('-Infinity')).toBeNull();
    expect(safeUpstreamNum('')).toBeNull();
    expect(safeUpstreamNum('   ')).toBeNull();
    expect(safeUpstreamNum('1.2.3')).toBeNull();
    expect(safeUpstreamNum('abc')).toBeNull();
    expect(safeUpstreamNum('12px')).toBeNull();
    expect(safeUpstreamNum(null)).toBeNull();
    expect(safeUpstreamNum(undefined)).toBeNull();
    expect(safeUpstreamNum({})).toBeNull();
    expect(safeUpstreamNum(NaN)).toBeNull();
    expect(safeUpstreamNum(Infinity)).toBeNull();
  });
});

describe('SV-03 readJsonCapped — bound untrusted response size', () => {
  it('MAX_UPSTREAM_BYTES is a sane cap (a few MB, far above legit payloads, far below the DoS)', () => {
    expect(MAX_UPSTREAM_BYTES).toBeGreaterThanOrEqual(1 * 1024 * 1024);
    expect(MAX_UPSTREAM_BYTES).toBeLessThanOrEqual(64 * 1024 * 1024);
  });

  it('parses a normal small JSON body', async () => {
    const res = new Response(JSON.stringify({ ok: true, n: 1 }), { headers: { 'content-type': 'application/json' } });
    const out = await readJsonCapped(res, new AbortController(), 'TestVenue');
    expect(out).toEqual({ ok: true, n: 1 });
  });

  it('rejects early on an oversized content-length header', async () => {
    const res = new Response('{}', { headers: { 'content-length': String(MAX_UPSTREAM_BYTES + 1) } });
    await expect(readJsonCapped(res, new AbortController(), 'TestVenue')).rejects.toThrow(/too large.*content-length/);
  });

  it('rejects during streamed read when bytes exceed the cap (content-length absent/lying)', async () => {
    // A stream that emits > MAX_UPSTREAM_BYTES with NO content-length header.
    const chunk = new Uint8Array(1024 * 1024); // 1 MiB
    let emitted = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (emitted > MAX_UPSTREAM_BYTES + 4 * 1024 * 1024) { ctrl.close(); return; }
        emitted += chunk.byteLength;
        ctrl.enqueue(chunk);
      },
    });
    const res = new Response(body);
    await expect(readJsonCapped(res, new AbortController(), 'TestVenue')).rejects.toThrow(/too large.*streamed/);
  });
});
