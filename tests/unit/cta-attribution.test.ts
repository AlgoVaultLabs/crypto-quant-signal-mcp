/**
 * LANDING-CONVERSION-TRUST-W1 (architect D3): the funnel event-type split that keeps
 * cold-acquisition landing clicks OUT of the `upgrade_cta_clicked` nudge-conversion stage
 * (CANONICAL_STAGE_ORDER stage 7). Regression guard against anyone "simplifying" the split
 * back to a single event type — which would silently inflate stage 7 with landing traffic.
 */
import { describe, it, expect } from 'vitest';
import { classifyCtaEventType } from '../../src/lib/cta-attribution.js';

describe('cta-attribution — classifyCtaEventType', () => {
  it('routes cold-acquisition landing sources → landing_cta_clicked (NON-stage signal)', () => {
    for (const src of ['landing_hero', 'landing_pricing', 'landing_free']) {
      expect(classifyCtaEventType(src)).toBe('landing_cta_clicked');
    }
  });

  it('routes in-product upgrade-nudge sources → upgrade_cta_clicked (CANONICAL stage 7)', () => {
    for (const src of ['quota', 'soft', 'aha', 'limit', 'tg_start']) {
      expect(classifyCtaEventType(src)).toBe('upgrade_cta_clicked');
    }
  });

  it('defaults absent / empty / prefix-less sources → upgrade_cta_clicked (never silently landing)', () => {
    expect(classifyCtaEventType(undefined)).toBe('upgrade_cta_clicked');
    expect(classifyCtaEventType(null)).toBe('upgrade_cta_clicked');
    expect(classifyCtaEventType('')).toBe('upgrade_cta_clicked');
    expect(classifyCtaEventType('landing')).toBe('upgrade_cta_clicked'); // no trailing "_" → not a landing source
  });

  it('the two populations are distinct so landing traffic cannot inflate the nudge stage', () => {
    expect(classifyCtaEventType('landing_pricing')).not.toBe(classifyCtaEventType('quota'));
  });
});
