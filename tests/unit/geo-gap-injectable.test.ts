/**
 * OPS-AUTOPUB-ALERT-INJECTOR-BRANDFACTS-W1 C3 — auto-injection eligibility.
 *
 * REGRESSION UNDER TEST (2026-07-21): `productFitOf` returns 1.0 for any query ABSENT from
 * `product_fit`. GEO-TARGET-DIGEST-REDESIGN-W1 set `product_fit: {}` because misfits were
 * DROPPED rather than down-weighted — so every query scored `1.0 >= inject_threshold` and
 * became auto-injectable, including the ones that wave had just dropped. A
 * `best-python-backtester` gap row was written `injectable=true` for 2026-W30 and would have
 * been auto-injected into the editorial calendar, git-pushed, and published.
 *
 * The guarantee: membership of the `target_set` SoT — not `product_fit` — decides whether a
 * query may be auto-injected. A dropped query therefore cannot re-arm this path.
 */
import { describe, it, expect } from 'vitest';
import { isInjectable } from '../../src/lib/geo-gap-list.js';

type Obj = Parameters<typeof isInjectable>[0];

const THRESHOLD = 0.5;

/** Objective with a target_set SoT present (the post-Wave-1 shape: product_fit deliberately {}). */
const withTargetSet = {
  product_fit: {},
  inject_threshold: THRESHOLD,
  target_set: {
    'trade-call-not-data': { tier: 'A', target_mode: 'owned' },
    'altfins-alternative': { tier: 'A', target_mode: 'earned' },
    'brand-presence-query': { tier: 'B', target_mode: 'owned' },
    'algovault-exists': { tier: 'measure_only', target_mode: 'measure_only' },
  },
} as unknown as Obj;

describe('isInjectable — target_set membership gates auto-injection', () => {
  it('THE REGRESSION: a DROPPED query is not injectable even though product_fit defaults to 1.0', () => {
    // best-python-backtester was dropped by Wave 1: absent from product_fit AND from target_set.
    // Pre-fix this returned true (1.0 >= 0.5) and armed a duplicate-publish loop.
    expect(isInjectable(withTargetSet, 'best-python-backtester', THRESHOLD)).toBe(false);
    expect(isInjectable(withTargetSet, 'python-quant-for-ai', THRESHOLD)).toBe(false);
  });

  it('a classified TARGET query stays injectable', () => {
    expect(isInjectable(withTargetSet, 'trade-call-not-data', THRESHOLD)).toBe(true);
    expect(isInjectable(withTargetSet, 'brand-presence-query', THRESHOLD)).toBe(true);
  });

  it('a measure_only query is never injectable (either field)', () => {
    expect(isInjectable(withTargetSet, 'algovault-exists', THRESHOLD)).toBe(false);

    const tierOnly = {
      ...withTargetSet,
      target_set: { q: { tier: 'measure_only', target_mode: 'owned' } },
    } as unknown as Obj;
    expect(isInjectable(tierOnly, 'q', THRESHOLD)).toBe(false);

    const modeOnly = {
      ...withTargetSet,
      target_set: { q: { tier: 'A', target_mode: 'measure_only' } },
    } as unknown as Obj;
    expect(isInjectable(modeOnly, 'q', THRESHOLD)).toBe(false);
  });

  it('an unknown query is not injectable when a target_set SoT exists (default-deny)', () => {
    expect(isInjectable(withTargetSet, 'never-heard-of-this', THRESHOLD)).toBe(false);
  });

  it('back-compat: with NO target_set, falls through to product_fit alone', () => {
    const legacy = {
      product_fit: { 'misfit-query': 0.15, 'good-query': 1.0 },
      inject_threshold: THRESHOLD,
    } as unknown as Obj;
    expect(isInjectable(legacy, 'misfit-query', THRESHOLD)).toBe(false); // 0.15 < 0.5
    expect(isInjectable(legacy, 'good-query', THRESHOLD)).toBe(true);
    expect(isInjectable(legacy, 'unlisted', THRESHOLD)).toBe(true); // defaults to 1.0
  });

  it('target_set membership does not override a genuine product_fit down-weight', () => {
    // Both gates must pass: being a target is necessary, not sufficient.
    const downWeighted = {
      product_fit: { 'trade-call-not-data': 0.2 },
      inject_threshold: THRESHOLD,
      target_set: { 'trade-call-not-data': { tier: 'A', target_mode: 'owned' } },
    } as unknown as Obj;
    expect(isInjectable(downWeighted, 'trade-call-not-data', THRESHOLD)).toBe(false);
  });
});
