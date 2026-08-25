/**
 * EDGE-SELL-RESOLUTION-ASYMMETRY-W1 Q3 — a suppression row must carry its ROLLOUT MODE.
 *
 * Both `shadow` and `enforce` write to `emit_suppressions`, by design: one code path produces
 * the shadow-compare rate and the live rate, so they cannot disagree. The cost of that design
 * is that a reader over the read-only pg-tunnel sees identical rows in both stages — and the
 * AOE digest's frozen-book footnote (`autonomous-optimizer`
 * `src/monitoring/dwr_baseline.py::frozen_book_footnote`) hid itself on `count(*) > 0`.
 *
 * That is wrong the instant SHADOW begins: in shadow the verdict is untouched, so the decided
 * set still contains every frozen-book row while the footnote saying so has vanished. The
 * distinction therefore has to live in the DATA, not in a flag someone remembers to flip.
 *
 * These tests assert the mapping in BOTH directions and pin the two structural properties that
 * stop it being silently re-fused: the emit path DERIVES the reason from the live mode, and
 * `recordEmitSuppression` refuses to default it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { suppressionReasonFor } from '../../src/lib/emit-suppressions.js';
import type { BookLivenessMode } from '../../src/lib/book-liveness.js';

const here = dirname(fileURLToPath(import.meta.url));
const readSrc = (rel: string) => readFileSync(resolve(here, '../../src', rel), 'utf8');

describe('suppressionReasonFor — the mode→reason mapping, both directions', () => {
  it('enforce ⇒ frozen_book (an emission was ACTUALLY withheld)', () => {
    expect(suppressionReasonFor('enforce')).toBe('frozen_book');
  });

  it('shadow ⇒ frozen_book_shadow (would have been, had the gate been enforcing)', () => {
    expect(suppressionReasonFor('shadow')).toBe('frozen_book_shadow');
  });

  it('off ⇒ frozen_book_shadow — unreachable (the predicate never runs), never enforce', () => {
    // `off` cannot reach the recorder, but a mapping that fell through to the ENFORCE value
    // would make an accidental call mint a fake "we withheld this" row. Default-deny.
    expect(suppressionReasonFor('off')).toBe('frozen_book_shadow');
  });

  it('the two reasons are DISTINCT — fusing them is the defect this exists to prevent', () => {
    expect(suppressionReasonFor('enforce')).not.toBe(suppressionReasonFor('shadow'));
  });

  it('is total over BookLivenessMode and never returns an unknown reason', () => {
    const modes: BookLivenessMode[] = ['off', 'shadow', 'enforce'];
    for (const m of modes) {
      expect(['frozen_book', 'frozen_book_shadow']).toContain(suppressionReasonFor(m));
    }
  });
});

describe('structural guards — the mapping cannot be bypassed at the call site', () => {
  it('get-trade-call.ts DERIVES the reason from the live mode', () => {
    const src = readSrc('tools/get-trade-call.ts');
    expect(src).toMatch(/recordEmitSuppression\([^)]*suppressionReasonFor\(bookLivenessMode\)/);
  });

  it('get-trade-call.ts never passes a HARDCODED reason literal', () => {
    const src = readSrc('tools/get-trade-call.ts');
    // A literal here would pin every row to one mode and re-open the exact hole.
    expect(src).not.toMatch(/recordEmitSuppression\([^)]*['"]frozen_book(_shadow)?['"]/);
  });

  it('recordEmitSuppression does NOT default `reason` — a default would pick a mode', () => {
    const src = readSrc('lib/emit-suppressions.ts');
    expect(src).not.toMatch(/reason\s*:\s*SuppressionReason\s*=/);
    expect(src).toMatch(/reason\s*:\s*SuppressionReason\s*,/);
  });

  it('the BookLivenessMode import stays TYPE-ONLY (emit-suppressions must have 0 static imports)', () => {
    // The cycle-safety property asserted in emit-suppressions-failopen.test.ts: a value import
    // here would put the emit-path counter back into the documented init cycle.
    const src = readSrc('lib/emit-suppressions.ts');
    expect(src).toMatch(/^import type \{ BookLivenessMode \}/m);
  });
});
