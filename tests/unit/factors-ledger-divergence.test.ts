/**
 * factors-ledger-divergence.test.ts — SIGNAL-LEDGER-INTEGRITY-W1 CH5 (Branch B).
 *
 * We ship TWO public arrays that describe the same factor two ways, in the same response:
 * the frozen legacy `_receipts.factors[]` and the corrected `_receipts.factor_ledger[]`.
 * CH1.5 measured Branch B — `factors[].direction` VALUES are asserted in five places
 * (`receipts.test.ts:95,105,106,112,120,125`) and the byte-exact digest arrows are pinned
 * in `scan-digest-enrich.test.ts:112` and `check-scan-digest-parity.mjs:65`, with the
 * Python mirror in lockstep — so correcting it here would re-baseline three gates and a
 * cross-repo file, which CH1.5 forbids in this wave.
 *
 * ── The limitation this gate exists to compensate for, stated plainly ────────────
 * The RIGHT channel for "these two disagree, and here is which one is authoritative" is a
 * declared `outputSchema` with `deprecated: true` on the legacy array. We have none: the
 * live server declares no `outputSchema` on any of its 7 tools (CH1.6, raw `tools/list`,
 * negotiated `2025-06-18`), and per A5 the schema work left this wave entirely —
 * `OPS-MCP-REGISTERTOOL-MIGRATION-W{NEXT}` then `SIGNAL-OUTPUT-SCHEMA-DECLARE-W{NEXT}`.
 * So an agent reading both fields today still has NO machine-readable statement of which
 * is authoritative. That is a real, accepted gap for the length of this wave.
 *
 * What this gate CAN do, and does: make the divergence BOUNDED and EXECUTABLE. The set of
 * fields that may disagree, and the exact condition under which each disagrees, are
 * enumerated below and asserted. A new divergence — or an existing one widening to a new
 * condition — turns this red instead of reaching a caller unannounced. A prose note in an
 * audit file (what V2 shipped) cannot do that; no client reads audit files.
 *
 * Prints one terminal `FACTORS_DIVERGENCE_VERDICT=PASS|FAIL|INDETERMINATE` (INDETERMINATE = 3).
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { formatReceipts, type VerdictContext } from '../../src/lib/receipts.js';
import { buildFactorLedger, type FactorLedgerInput } from '../../src/lib/verdict-factors.js';
import { FUNDING_Z_WINDOW_DAYS } from '../../src/lib/funding-window.js';

const WEIGHTS = { rsi: 0.30, ema: 0.10, funding: 0.25, oi: 0.15, volume: 0.20 };
const failures: string[] = [];
const check = (cond: boolean, msg: string) => {
  if (!cond) failures.push(msg);
  expect(cond, msg).toBe(true);
};

/**
 * The DECLARED divergence set. Every entry is a field that may legitimately disagree
 * between the two arrays, with the reason and the exact condition. Anything not listed
 * here must agree — that is what makes the set bounded rather than open-ended.
 */
const DECLARED_DIVERGENCES: Record<string, { why: string; when: (ctx: Ctx) => boolean }> = {
  // `oi_change_pct` ENTRY DELETED — OPS-RECEIPTS-FACTORS-DIRECTION-FIX-W1.
  //
  // The entry is gone because the DIVERGENCE is gone: `factors[]` now reads `neutral`
  // for any factor feeding no verdict channel, so it agrees with the ledger.
  //
  // It was removed because this file's own "each declared divergence actually OCCURS"
  // assertion went red the moment the fix landed — the assertion working, not failing.
  // A declared exemption that no longer fires is dead weight a future reader treats as
  // a live constraint. Written one wave earlier for exactly this moment.
  funding_state: {
    why: 'factors[] reads the per-asset z-BUCKET (NORMAL ⇒ neutral); the ledger reads the global '
       + 'annualized LADDER, which scores a negative rate contrarian-bullish regardless of bucket.',
    when: (c) => c.state === 'NORMAL' && c.rate !== 0,
  },
};

interface Ctx { rate: number; state: 'NORMAL' | 'ELEVATED' | 'EXTREME'; oi?: number; tp: 'LOW' | 'MEDIUM' | 'HIGH'; bp: 'INACTIVE' | 'IMMINENT'; ema: number }

function pair(c: Ctx) {
  const ann = c.rate * 3 * 365;
  const fundingScore = ann < -4.38 ? 80 : ann < 0 ? 40 : ann > 8.76 ? -80 : ann > 4.38 ? -40 : 0;
  const indicators = {
    funding_rate: c.rate, funding_state: c.state,
    ...(c.oi === undefined ? {} : { oi_change_pct: c.oi, oi_change_window: '24h' }),
    volume_24h: 1e9, trend_persistence: c.tp, breakout_pending: c.bp,
  } as VerdictContext['indicators'] & { volume_24h: number };

  const input: FactorLedgerInput = {
    coin: 'TESTC',
    scores: {
      rsiScore: 0, emaScore: c.ema, fundingScore, oiScore: -20, volumeScore: -30,
      hurstVal: 0.60, squeezeActive: c.bp === 'IMMINENT', rsiVal: 52, avgCandleVol: 1000,
    },
    weights: WEIGHTS,
    outcome: { rawScore: -20 },
    regime: c.ema > 0 ? 'TRENDING_UP' : c.ema < 0 ? 'TRENDING_DOWN' : 'RANGING',
    indicators,
    gates: { fundingZScore: c.state === 'NORMAL' ? -0.8 : -2.1, fundingWindowDays: FUNDING_Z_WINDOW_DAYS },
  };
  const r = formatReceipts(
    { call: 'HOLD', confidence: 20, regime: input.regime, indicators },
    { ledger: buildFactorLedger(input) },
  );
  return { ctx: c, factors: r.factors, ledger: r.factor_ledger! };
}

/** Every combination the two arrays can both express. */
const CASES = (() => {
  const out: ReturnType<typeof pair>[] = [];
  for (const rate of [-0.00011, 0, 0.00008]) {
    for (const state of ['NORMAL', 'ELEVATED', 'EXTREME'] as const) {
      for (const oi of [2.4, -2.4, 0.1, undefined]) {
        for (const bp of ['INACTIVE', 'IMMINENT'] as const) {
          out.push(pair({ rate, state, oi, tp: 'MEDIUM', bp, ema: -100 }));
        }
      }
    }
  }
  return out;
})();

describe('CH5 — the factors[] ↔ factor_ledger[] divergence is BOUNDED', () => {
  it('the corpus is non-empty and exercises every declared divergence (VACUITY GUARD)', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(50);
    for (const [field, d] of Object.entries(DECLARED_DIVERGENCES)) {
      const hits = CASES.filter(({ ctx }) => d.when(ctx));
      check(hits.length > 0, `VACUOUS: no case satisfies the declared condition for "${field}" — it is untested`);
    }
  });

  it('every field NOT in the declared set agrees between the two arrays', () => {
    let compared = 0;
    for (const { ctx, factors, ledger } of CASES) {
      for (const f of factors) {
        const l = ledger.find((x) => x.factor === f.factor);
        if (!l) continue; // a row present in one view only is a shape fact, not a direction one
        compared += 1;
        if (f.direction === l.direction) continue;
        const declared = DECLARED_DIVERGENCES[f.factor];
        check(!!declared, `UNDECLARED divergence on "${f.factor}": factors=${f.direction} ledger=${l.direction}`);
        if (declared) {
          check(
            declared.when(ctx),
            `"${f.factor}" diverged OUTSIDE its declared condition (${JSON.stringify(ctx)}): factors=${f.direction} ledger=${l.direction}`,
          );
        }
      }
    }
    check(compared >= 100, `VACUOUS: only ${compared} field comparisons made`);
  });

  it('each declared divergence actually OCCURS under its condition — the set is not stale', () => {
    // A declared exemption that no longer fires is dead weight that a future reader will
    // treat as a live constraint. If one of these stops diverging, the entry should be
    // deleted, and this assertion is what forces that.
    for (const [field, d] of Object.entries(DECLARED_DIVERGENCES)) {
      const diverged = CASES.some(({ ctx, factors, ledger }) => {
        if (!d.when(ctx)) return false;
        const f = factors.find((x) => x.factor === field);
        const l = ledger.find((x) => x.factor === field);
        return !!f && !!l && f.direction !== l.direction;
      });
      check(diverged, `declared divergence "${field}" never actually occurs — delete the entry or fix the condition`);
    }
  });

  it('the ledger is the authoritative view: only it reports contributes', () => {
    // The substantive difference, asserted rather than described. `factors[]` cannot say
    // whether a row moved the verdict; that is why it is the deprecated view.
    const { factors, ledger } = CASES[0];
    check(factors.every((f) => !('contributes' in f)), 'factors[] gained a contributes field — it is frozen');
    check(ledger.every((l) => typeof l.contributes === 'boolean'), 'a ledger row is missing contributes');
    const oi = ledger.find((l) => l.factor === 'oi_change_pct');
    if (oi) check(oi.contributes === false, 'oi_change_pct must be contributes:false in the ledger');
  });

  it('factors[] is byte-frozen: shape, order and selection unchanged by this wave', () => {
    // The three digest gates assert this from their side and pass UNMODIFIED. Asserted
    // here too so the freeze is visible in the wave that relies on it.
    for (const { factors } of CASES) {
      check(factors.length >= 1 && factors.length <= 3, `factors[] length ${factors.length} outside 1..3`);
      check(factors[0].factor === 'trend_persistence', `factors[0] is "${factors[0].factor}", not trend_persistence`);
      if (factors.length > 1) check(factors[1].factor === 'funding_state', `factors[1] is "${factors[1].factor}"`);
      for (const f of factors) {
        expect(Object.keys(f).sort()).toEqual(['direction', 'factor', 'value']);
      }
    }
  });
});

afterEach((ctx) => {
  if (ctx.task.result?.state === 'fail') failures.push(`test failed: ${ctx.task.name}`);
});

afterAll(() => {
  const vacuous = CASES.length === 0;
  const verdict = vacuous ? 'INDETERMINATE' : failures.length === 0 ? 'PASS' : 'FAIL';
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.log(`FACTORS_DIVERGENCE_VERDICT=${verdict}`);
  if (vacuous) process.exitCode = 3;
});
