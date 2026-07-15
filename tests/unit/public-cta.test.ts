/**
 * OPS-PUBLIC-API-CONVERT-NUDGE-W1 — unit contract for the single-derivation
 * `_algovault` conversion CTA formatter (src/lib/public-cta.ts).
 *
 * Locks: (a) exactly the 4 approved keys, (b) exact approved copy (verbatim,
 * Mr.1 2026-07-15), (c) pure-function invariants (fresh object, idempotent, no
 * shared mutable state), (d) Data Integrity LAW canary — NO internal metrics
 * (outcome_return_pct / outcome_price / Phase-E win rate / equities) at any
 * depth or in the serialized block.
 *
 * Snapshot artifact: audits/public-cta-shape-snapshot-2026-07-15.json
 */
import { describe, it, expect } from 'vitest';
import { buildPublicCtaBlock, type PublicCtaBlock } from '../../src/lib/public-cta.js';

const APPROVED = {
  brand: 'The Brain Layer for AI Trading Agents',
  note: 'Building an agent? Get a free API key — higher limits, all tools, x402 pay-per-call.',
  get_started: 'https://algovault.com/#pricing',
  docs: 'https://algovault.com/docs.html',
} as const;

const APPROVED_KEYS = ['brand', 'docs', 'get_started', 'note'];

// Data Integrity LAW: none of these may appear as a key OR substring anywhere
// inside the CTA block (it carries brand + generic CTA + public URLs only).
const FORBIDDEN_RE = /outcome_return_pct|outcome_price|phase[_ ]?e|win.?rate|equit/i;

describe('buildPublicCtaBlock — approved copy contract', () => {
  it('returns exactly the 4 approved keys, no more, no less', () => {
    const block = buildPublicCtaBlock();
    expect(Object.keys(block).sort()).toEqual(APPROVED_KEYS);
  });

  it('emits the approved copy verbatim (all 4 keys, exact strings)', () => {
    const block = buildPublicCtaBlock();
    expect(block).toEqual(APPROVED);
  });

  it('brand / note / URLs match each approved value exactly', () => {
    const block = buildPublicCtaBlock();
    expect(block.brand).toBe('The Brain Layer for AI Trading Agents');
    expect(block.note).toBe(
      'Building an agent? Get a free API key — higher limits, all tools, x402 pay-per-call.',
    );
    expect(block.get_started).toBe('https://algovault.com/#pricing');
    expect(block.docs).toBe('https://algovault.com/docs.html');
  });

  it('URLs are absolute https public URLs (cross-host safe — no relative /docs.html)', () => {
    const block = buildPublicCtaBlock();
    for (const url of [block.get_started, block.docs]) {
      expect(url.startsWith('https://algovault.com/')).toBe(true);
    }
  });
});

describe('buildPublicCtaBlock — Data Integrity LAW canary', () => {
  it('no forbidden internal-metric token appears in any key', () => {
    const block = buildPublicCtaBlock() as Record<string, unknown>;
    const offenders = Object.keys(block).filter((k) => FORBIDDEN_RE.test(k));
    expect(offenders).toEqual([]);
  });

  it('no forbidden internal-metric token appears in the serialized block', () => {
    expect(FORBIDDEN_RE.test(JSON.stringify(buildPublicCtaBlock()))).toBe(false);
  });

  it('every value is a string (no numeric metric could sneak in)', () => {
    const block = buildPublicCtaBlock() as Record<string, unknown>;
    for (const v of Object.values(block)) {
      expect(typeof v).toBe('string');
    }
  });
});

describe('buildPublicCtaBlock — pure-function invariants', () => {
  it('is idempotent — same output on repeated calls', () => {
    expect(buildPublicCtaBlock()).toEqual(buildPublicCtaBlock());
  });

  it('returns a FRESH object each call (spread-safe, no shared mutable state)', () => {
    const a = buildPublicCtaBlock();
    const b = buildPublicCtaBlock();
    expect(a).not.toBe(b);
    // Mutating one copy must not leak into a later call.
    (a as PublicCtaBlock).brand = 'MUTATED';
    expect(buildPublicCtaBlock().brand).toBe('The Brain Layer for AI Trading Agents');
  });

  it('spreads cleanly into a host response without clobbering existing fields', () => {
    const merged = { existing: 1, _algovault: buildPublicCtaBlock() };
    expect(merged.existing).toBe(1);
    expect(merged._algovault).toEqual(APPROVED);
  });
});
