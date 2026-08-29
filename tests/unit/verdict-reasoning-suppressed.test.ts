/**
 * OPS-BOOK-LIVENESS-EXPLAIN-HOLD-W1 R3 — the caller is TOLD the call was withheld.
 *
 * ── What went wrong, and why a test is the right shape for it ─────────────────
 *
 * The emit-time book-liveness gate went ENFORCING 2026-08-29 03:25:45Z. From that moment it
 * withheld real directional calls, and the caller was never told: the explanation lived only in
 * `scoreAdjustments`, an INTERNAL array read by two telemetry consumers and present on no
 * response. Measured live on `EPT|4h|XT` while enforcing:
 *
 *   call "HOLD", confidence 67
 *   reasoning "... Price is flat over 24h ... Turns directional if funding normalises."
 *
 * Two defects, and the second is the worse one:
 *   (1) the withholding is unexplained; and
 *   (2) `confidence` is the WITHHELD call's conviction, so "HOLD at 67" reads as a strong HOLD
 *       when the truth is a strong SELL we did not emit — and slot 3 then states, affirmatively,
 *       that the call is not currently directional. That is not an omission, it is FALSE.
 *
 * A suppression explained only in telemetry is not explained. These assertions exist so the
 * explanation cannot silently regress the way it silently never existed.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  buildFactorLedger,
  renderVerdictReasoning,
  collectPayloadNumbers,
  unbackedProseNumbers,
  REASONING_MAX_CHARS,
  REASONING_SENTENCE_COUNT,
  type FactorLedgerInput,
} from '../../src/lib/verdict-factors.js';
import {
  BOOK_LIVENESS_WINDOW,
  BOOK_LIVENESS_MIN_GENUINE_BARS,
} from '../../src/lib/book-liveness.js';
import { deriveVerdict, type VerdictGateInputs, type VerdictScoreInputs } from '../../src/tools/get-trade-call.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEIGHTS = { rsi: 0.30, ema: 0.10, funding: 0.25, oi: 0.15, volume: 0.20 };
const FUNDING_Z_WINDOW_DAYS = 14;

/** The live pin, injected exactly as `get-trade-call.ts` injects it. */
const PIN = { minGenuineBars: BOOK_LIVENESS_MIN_GENUINE_BARS, window: BOOK_LIVENESS_WINDOW };

/**
 * `EPT|4h|XT` — the measured reproduction. A bearish net that clears the SELL threshold on a
 * frozen book, i.e. exactly the state the gate withholds.
 */
const eptInput: FactorLedgerInput = {
  coin: 'EPT',
  scores: { rsiScore: -40, emaScore: 0, fundingScore: -40, oiScore: 0, volumeScore: -70, hurstVal: 0.50, squeezeActive: false },
  weights: WEIGHTS,
  outcome: { rawScore: -59.6 },
  regime: 'RANGING',
  indicators: { funding_rate: 0.02, funding_state: 'NORMAL', volume_24h: 1908522, trend_persistence: 'MEDIUM', breakout_pending: 'INACTIVE' },
  gates: { fundingZScore: null, fundingWindowDays: FUNDING_Z_WINDOW_DAYS },
};

/** `USOIL|5m|HTX` — a CLOSED underlying whose book is also frozen. Both conditions, live. */
const oilInput: FactorLedgerInput = {
  coin: 'USOIL',
  scores: { rsiScore: 0, emaScore: -100, fundingScore: 0, oiScore: 20, volumeScore: 10, hurstVal: 0.50, squeezeActive: false },
  weights: WEIGHTS,
  outcome: { rawScore: -60 },
  regime: 'TRENDING_DOWN',
  indicators: { funding_rate: 0, funding_state: 'NORMAL', oi_change_pct: -29.81, oi_change_window: '24h', volume_24h: 3064870, trend_persistence: 'MEDIUM', breakout_pending: 'INACTIVE' },
  gates: { fundingZScore: null, fundingWindowDays: FUNDING_Z_WINDOW_DAYS },
};

const eptLedger = buildFactorLedger(eptInput);
const oilLedger = buildFactorLedger(oilInput);

const deadBook = (confidence = 67) =>
  renderVerdictReasoning(eptLedger, 'HOLD', confidence, { suppressedSide: 'SELL', suppressionPin: PIN });
const closedAndSuppressed = (confidence = 61) =>
  renderVerdictReasoning(oilLedger, 'HOLD', confidence, { marketClosed: true, suppressedSide: 'SELL', suppressionPin: PIN });

// ───────────────────── the explanation reaches the caller ─────────────────────

describe('R3 — a suppressed HOLD explains itself on the WIRE, not only in telemetry', () => {
  it('the dead-book case names the withholding, the side, and whose confidence the number is', () => {
    const s = deadBook();
    expect(s).toMatch(/Book not trading/);
    expect(s).toContain('the SELL (confidence 67) was withheld');
  });

  it('the closed-market case says WITHHELD, not merely "provisional"', () => {
    const s = closedAndSuppressed();
    expect(s).toContain('Underlying market closed and the book is not trading');
    expect(s).toContain('the SELL (confidence 61) was withheld until it reopens');
    // The pre-existing caveat describes a read that was still EMITTED. Reusing it here would
    // keep the defect under new wording.
    expect(s).not.toContain('this read is provisional');
  });

  it('a BUY is named as a BUY — the side is the withheld call, never the emitted HOLD', () => {
    const s = renderVerdictReasoning(eptLedger, 'HOLD', 44, { suppressedSide: 'BUY', suppressionPin: PIN });
    expect(s).toContain('the BUY (confidence 44) was withheld');
    expect(s).not.toContain('SELL');
  });

  it('AC — the exact reproduction: what the caller receives is no longer silent', () => {
    // Before this wave `reasoning` matched none of these on a suppressed response.
    const s = deadBook();
    expect(s).toMatch(/Book not trading/);
    expect(s).toMatch(/withheld/);
  });
});

// ───────────────────── Q1: slot 3 stops asserting a falsehood ─────────────────────

describe('R3 (architect Q1) — the resume condition is TRUE, not merely present', () => {
  it('the dead-book flip sentence points at the book, not at funding', () => {
    expect(deadBook()).toContain('Resumes once the book trades again');
  });

  it('the closed-market flip sentence points at the market reopening', () => {
    expect(closedAndSuppressed()).toContain('Resumes when the underlying market reopens');
  });

  it('THE REGRESSION: a suppressed HOLD never claims it is not directional', () => {
    // Measured live pre-fix: "Turns directional if funding normalises" over a withheld SELL at
    // confidence 67. Funding normalising would change nothing — the book is the binding
    // condition. Both ordinary flip forms are forbidden in this state.
    for (const s of [deadBook(), closedAndSuppressed()]) {
      expect(s).not.toMatch(/Turns directional if/);
      expect(s).not.toMatch(/Flips to HOLD if/);
      expect(s).not.toMatch(/Becomes actionable/);
    }
  });
});

// ───────────────────── the pin is DERIVED, never typed ─────────────────────

describe('R3 — the pin is rendered from the constants, so it cannot go stale', () => {
  it('the live string quotes the live constants', () => {
    expect(deadBook()).toContain(`under ${BOOK_LIVENESS_MIN_GENUINE_BARS} of the last ${BOOK_LIVENESS_WINDOW} bars`);
  });

  it('change the constant in the fixture and the string FOLLOWS (a literal would fail here)', () => {
    const s = renderVerdictReasoning(eptLedger, 'HOLD', 67, {
      suppressedSide: 'SELL',
      suppressionPin: { minGenuineBars: 9, window: 18 },
    });
    expect(s).toContain('under 9 of the last 18 bars carried volume');
    expect(s).not.toContain(`under ${BOOK_LIVENESS_MIN_GENUINE_BARS} of the last ${BOOK_LIVENESS_WINDOW}`);
  });

  it('no pin supplied ⇒ NUMBER-FREE, never a fabricated one (fail-safe)', () => {
    const s = renderVerdictReasoning(eptLedger, 'HOLD', 67, { suppressedSide: 'SELL' });
    expect(s).toContain('too few recent bars carried volume');
    expect(s).not.toMatch(/under \d+ of the last \d+/);
    // Still explains the withholding — losing the pin must not lose the explanation.
    expect(s).toContain('the SELL (confidence 67) was withheld');
  });

  it('THE THRESHOLD FORM IS DELIBERATE (architect Q3) — no observed bar count is printed', () => {
    // `barsExamined` is `min(candles, N)` and can legitimately be k..N-1, so a literal N beside
    // an OBSERVED count would be false on exactly those books. The threshold form is true on
    // every book by construction.
    expect(deadBook()).toContain(`under ${BOOK_LIVENESS_MIN_GENUINE_BARS} of the last ${BOOK_LIVENESS_WINDOW}`);
  });

  it('the CALLER injects the real constants — a literal in get-trade-call.ts fails this', () => {
    // The renderer holds zero imports by design, so production correctness lives at the call
    // site. Assert the wiring, not just the leaf: a unit test calling a helper directly cannot
    // prove anything CALLS it correctly.
    const src = readFileSync(resolve(HERE, '../../src/tools/get-trade-call.ts'), 'utf8');
    expect(src).toMatch(/suppressionPin:\s*\{\s*minGenuineBars:\s*BOOK_LIVENESS_MIN_GENUINE_BARS,\s*window:\s*BOOK_LIVENESS_WINDOW\s*\}/);
    expect(src).not.toMatch(/suppressionPin:\s*\{\s*minGenuineBars:\s*\d/);
  });

  it('THE WIRING ITSELF — `suppressedSide` actually reaches the renderer', () => {
    // Found by deliberately breaking it: deleting this one line at the call site left EVERY
    // leaf assertion above green while production went back to silent HOLDs. That is the
    // precise failure mode this wave exists to fix, so it gets its own assertion rather than
    // relying on tests that construct the opts object themselves.
    const src = readFileSync(resolve(HERE, '../../src/tools/get-trade-call.ts'), 'utf8');
    expect(src).toMatch(/renderVerdictReasoning\([\s\S]{0,400}?suppressedSide:\s*liveVerdict\.suppressedSide/);
  });
});

// ───────────────────── the renderer's own invariants still hold ─────────────────────

describe('R3 — the suppressed branch obeys every invariant the gate pins', () => {
  /**
   * Each case carries the payload the CALLER would emit alongside it — `indicators` plus its own
   * `confidence`. That pairing is the point: `confidence` is a real emitted field, so quoting it
   * in prose is backed; quoting any OTHER number would not be. An earlier draft passed one
   * fixed payload to every case and the number gate caught it, which is the gate working.
   */
  const CASES: Array<[string, string, Record<string, unknown>]> = [
    ['dead book', deadBook(), { indicators: eptInput.indicators, confidence: 67 }],
    ['closed + suppressed', closedAndSuppressed(), { indicators: oilInput.indicators, confidence: 61 }],
    ['BUY withheld', renderVerdictReasoning(eptLedger, 'HOLD', 44, { suppressedSide: 'BUY', suppressionPin: PIN }), { indicators: eptInput.indicators, confidence: 44 }],
    ['no pin', renderVerdictReasoning(eptLedger, 'HOLD', 67, { suppressedSide: 'SELL' }), { indicators: eptInput.indicators, confidence: 67 }],
  ];

  it('the corpus is non-empty and covers both suppressed states (VACUITY GUARD)', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(4);
    expect(CASES.some(([, s]) => s.includes('Book not trading'))).toBe(true);
    expect(CASES.some(([, s]) => s.includes('until it reopens'))).toBe(true);
  });

  it('the number gate is NON-VACUOUS — an unbacked figure is actually caught', () => {
    // Prove the assertion below can fail: 999 is in no payload and no allowed constant.
    const unbacked = unbackedProseNumbers('the SELL (confidence 999) was withheld', [67], [BOOK_LIVENESS_WINDOW]);
    expect(unbacked).toEqual(['999']);
  });

  it(`exactly ${REASONING_SENTENCE_COUNT} sentences, <=${REASONING_MAX_CHARS} chars`, () => {
    for (const [name, s] of CASES) {
      expect(s.split('. '), `${name}: sentence count`).toHaveLength(REASONING_SENTENCE_COUNT);
      expect(s.length, `${name}: ${s.length} chars — the Telegram bot cuts at ${REASONING_MAX_CHARS}`)
        .toBeLessThanOrEqual(REASONING_MAX_CHARS);
    }
  });

  it('every number in the prose is reproducible from the response or the injected pin', () => {
    for (const [name, s, emitted] of CASES) {
      const payload = collectPayloadNumbers(emitted);
      const unbacked = unbackedProseNumbers(s, payload, [
        FUNDING_Z_WINDOW_DAYS,
        BOOK_LIVENESS_MIN_GENUINE_BARS,
        BOOK_LIVENESS_WINDOW,
        24, // PRICE_CHANGE_WINDOW_HOURS
      ]);
      expect(unbacked, `${name}: unbacked ${JSON.stringify(unbacked)} in "${s}"`).toEqual([]);
    }
  });

  it('the >280 fallback DEGRADES SLOT 1 and can never delete the explanation', () => {
    // The pre-existing ladder replaces slot 2. On a suppressed response slot 2 IS the
    // explanation, so both branches are now guarded and a long response degrades slot 1
    // instead. Force it with a ledger whose driver sentence is long.
    const longCoin = 'X'.repeat(120);
    const long = renderVerdictReasoning(
      buildFactorLedger({ ...eptInput, coin: longCoin }), 'HOLD', 67,
      { suppressedSide: 'SELL', suppressionPin: PIN },
    );
    expect(long.length).toBeLessThanOrEqual(REASONING_MAX_CHARS);
    expect(long).toContain('the SELL (confidence 67) was withheld');
    expect(long).toContain('Resumes once the book trades again');
    expect(long.split('. ')).toHaveLength(REASONING_SENTENCE_COUNT);
  });
});

// ───────────────────── nothing else moved ─────────────────────

describe('R3 — the unsuppressed paths are byte-identical', () => {
  it('closed market with NO suppression keeps its exact pre-wave sentence', () => {
    const s = renderVerdictReasoning(oilLedger, 'HOLD', 10, { marketClosed: true });
    expect(s).toContain('Underlying market closed, so candles are capped synthetic pricing and this read is provisional');
    expect(s).not.toMatch(/withheld/);
  });

  it('an ordinary verdict is unchanged — no suppression vocabulary leaks in', () => {
    const s = renderVerdictReasoning(eptLedger, 'HOLD', 67, {});
    expect(s).not.toMatch(/withheld|Book not trading|Resumes/);
  });

  it('suppressedSide null/undefined are both "nothing was suppressed"', () => {
    const base = renderVerdictReasoning(eptLedger, 'HOLD', 67, {});
    expect(renderVerdictReasoning(eptLedger, 'HOLD', 67, { suppressedSide: null })).toBe(base);
    expect(renderVerdictReasoning(eptLedger, 'HOLD', 67, { suppressedSide: undefined })).toBe(base);
  });
});

// ───────── architect Q2: the structured field REPLACES the string-prefix derivation ─────────

const scores = (dir: 'buy' | 'sell'): VerdictScoreInputs =>
  dir === 'buy'
    ? { rsiScore: 90, emaScore: 90, fundingScore: 90, oiScore: 90, volumeScore: 90 }
    : { rsiScore: -90, emaScore: -90, fundingScore: -90, oiScore: -90, volumeScore: -90 };

const gates = (over: Partial<VerdictGateInputs> = {}): VerdictGateInputs => ({
  fundingZScore: null,
  fundingRateAnnualized: 0,
  hurstVal: null,
  squeezeActive: false,
  r4Thresholds: { buyPenaltyZ: 2.5, sellSofteningZ: -2.5 } as VerdictGateInputs['r4Thresholds'],
  buyThreshold: 40,
  sellThreshold: 55,
  ...over,
});

describe('R2 (architect Q2) — `suppressedSide` is EQUIVALENT to the prefix it replaced', () => {
  /**
   * `emit_suppressions` and `hold_decisions` were switched from
   * `scoreAdjustments.some(a => a.startsWith('Book not trading'))` to `suppressedSide !== null`.
   * The relaxation was granted on condition the equivalence is PROVEN, not asserted — so this
   * sweeps every adjustment branch that can push a note and checks the biconditional on each.
   */
  const PREFIX = 'Book not trading';
  const sweep = () => {
    const out: Array<{ name: string; v: ReturnType<typeof deriveVerdict> }> = [];
    for (const dir of ['buy', 'sell'] as const) {
      for (const bookLive of [true, false, undefined]) {
        for (const fundingZScore of [null, -2.1, 2.7, -1.8]) {
          for (const hurstVal of [null, 0.40, 0.60]) {
            for (const squeezeActive of [false, true]) {
              for (const fundingRateAnnualized of [0, 5.2, -5.2]) {
                const g = gates({ bookLive, fundingZScore, hurstVal, squeezeActive, fundingRateAnnualized });
                out.push({
                  name: `${dir}/live=${bookLive}/z=${fundingZScore}/h=${hurstVal}/sq=${squeezeActive}/ann=${fundingRateAnnualized}`,
                  v: deriveVerdict(scores(dir), g),
                });
              }
            }
          }
        }
      }
    }
    return out;
  };
  const ALL = sweep();

  it('the sweep is non-empty and actually reaches BOTH sides of the biconditional', () => {
    expect(ALL.length).toBeGreaterThanOrEqual(200);
    expect(ALL.some((c) => c.v.suppressedSide !== null), 'no case suppressed').toBe(true);
    expect(ALL.some((c) => c.v.suppressedSide === null), 'every case suppressed').toBe(true);
  });

  it('suppressedSide !== null ⇔ a "Book not trading" note is present, on EVERY case', () => {
    for (const { name, v } of ALL) {
      const byPrefix = v.scoreAdjustments.some((a) => a.startsWith(PREFIX));
      expect(v.suppressedSide !== null, `${name}: field=${v.suppressedSide} prefix=${byPrefix}`).toBe(byPrefix);
    }
  });

  it('NO OTHER adjustment can produce that prefix — the equivalence is structural', () => {
    // If a future funding/Hurst/squeeze note ever began with these words, the two derivations
    // would diverge silently. They cannot, and this is what says so.
    for (const { name, v } of ALL) {
      const hits = v.scoreAdjustments.filter((a) => a.startsWith(PREFIX));
      expect(hits.length, `${name}: ${hits.length} notes carry the prefix`).toBeLessThanOrEqual(1);
      if (v.suppressedSide === null) {
        expect(v.scoreAdjustments.some((a) => a.includes(PREFIX)), `${name}`).toBe(false);
      }
    }
  });

  it('the withheld side is the call the threshold chose, and rawScore/confidence are untouched', () => {
    const buy = deriveVerdict(scores('buy'), gates({ bookLive: false }));
    const sell = deriveVerdict(scores('sell'), gates({ bookLive: false }));
    expect(buy.suppressedSide).toBe('BUY');
    expect(sell.suppressedSide).toBe('SELL');
    expect(buy.signal).toBe('HOLD');
    expect(sell.signal).toBe('HOLD');
    // Confidence semantics are the 2026-08-26 HOLD-capture corpus's dependency — unchanged.
    expect(buy.confidence).toBe(deriveVerdict(scores('buy'), gates({ bookLive: true })).confidence);
    expect(buy.rawScore).toBe(deriveVerdict(scores('buy'), gates({ bookLive: true })).rawScore);
  });

  it('an already-HOLD verdict suppresses nothing — the field stays null', () => {
    const flat: VerdictScoreInputs = { rsiScore: 0, emaScore: 0, fundingScore: 0, oiScore: 0, volumeScore: 0 };
    expect(deriveVerdict(flat, gates({ bookLive: false })).suppressedSide).toBeNull();
  });

  it('the two telemetry consumers now read the FIELD, not the prefix', () => {
    const src = readFileSync(resolve(HERE, '../../src/tools/get-trade-call.ts'), 'utf8');
    expect(src).toContain('liveVerdict.suppressedSide !== null');
    expect(src).not.toMatch(/liveVerdict\.scoreAdjustments\.some\(\(a\) => a\.startsWith\('Book not trading'\)\)/);
  });
});
