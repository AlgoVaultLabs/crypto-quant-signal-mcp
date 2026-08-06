/**
 * verdict-reasoning-consistency.test.ts — SIGNAL-REASONING-PROJECTION-W1-V2 R5 + R6.
 *
 * The generator-level fix. Four contradictions shipped in public before this file
 * existed — a BUY at 62% narrated "no clear direction"; SOL and DOGE with opposite-signed
 * open interest emitting BYTE-IDENTICAL prose; a HOLD opening "upward bias" over its own
 * bearish factor; `oi_change_pct` carrying a verdict `direction` while entering no score.
 * Fixing those four instances would have been a lane fix. This asserts the PROPERTY they
 * each violated, over a generated corpus, so the class cannot come back.
 *
 * ── Verdict token ────────────────────────────────────────────────────────────
 * Prints exactly one terminal `REASONING_CONSISTENCY_VERDICT=PASS|FAIL|INDETERMINATE`.
 * INDETERMINATE is 3 — the token-law default for a NEW gate. It is deliberately NOT
 * `check_test_baseline.sh`'s 2: that script uses 2 only because 2 was already deployed
 * there for this meaning, nothing reads both code spaces, and one meaning with two codes
 * inside a single script is the real footgun.
 *
 * ── Vacuity ──────────────────────────────────────────────────────────────────
 * This test CONSTRUCTS its corpus, so an empty corpus is a defect of the test, not a
 * fact about the world — it REFUSES rather than reporting a pass over nothing.
 */
import { describe, it, expect, afterAll } from 'vitest';
import {
  buildFactorLedger,
  renderVerdictReasoning,
  unbackedProseNumbers,
  collectPayloadNumbers,
  FUNDING_HISTORY_TOO_SHORT,
  REASONING_MAX_CHARS,
  REASONING_SENTENCE_COUNT,
  PRICE_CHANGE_WINDOW_HOURS,
  type FactorLedger,
  type FactorLedgerInput,
} from '../../src/lib/verdict-factors.js';
import { FUNDING_Z_WINDOW_DAYS } from '../../src/lib/funding-window.js';

const WEIGHTS = { rsi: 0.30, ema: 0.10, funding: 0.25, oi: 0.15, volume: 0.20 };

/** Mirrors the engine's own ladders so the corpus is score vectors, not invented numbers. */
const fundingScoreOf = (ann: number) => (ann < -4.38 ? 80 : ann < 0 ? 40 : ann > 8.76 ? -80 : ann > 4.38 ? -40 : 0);
const oiScoreOf = (pc: number) => (pc > 0.02 ? 60 : pc > 0 ? 20 : pc < -0.02 ? -60 : pc < 0 ? -20 : 0);

type Case = { name: string; input: FactorLedgerInput; call: string; confidence: number };

/**
 * A combinatorial sweep over every axis that can change a sentence: the two funding
 * reads (z-bucket vs annualized ladder) INDEPENDENTLY, since their disagreement is a
 * real live state; both regime/EMA agreement modes; the amplifier on and off; OI present,
 * absent, and both signs; and the `<20`-sample funding case.
 */
function corpus(): Case[] {
  const out: Case[] = [];
  const rates = [-0.00011581, -0.00006641, -0.00006032, -0.00001397, 0, 0.00003135, 0.0008];
  const states = ['NORMAL', 'ELEVATED', 'EXTREME'] as const;
  const regimes = ['TRENDING_UP', 'TRENDING_DOWN', 'RANGING'] as const;
  const emas = [100, 0, -100];
  const raws = [55, 23, 0, -25, -60];
  const ois: Array<number | undefined> = [2.53, -0.41, undefined];
  const zs: Array<number | null> = [-2.1, -0.8, 0.4, 2.7, null];

  let n = 0;
  for (const regime of regimes) {
    for (const ema of emas) {
      for (let k = 0; k < rates.length; k++) {
        const rate = rates[k];
        const state = states[k % states.length];
        const z = zs[k % zs.length];
        const raw = raws[(k + emas.indexOf(ema)) % raws.length];
        const oi = ois[k % ois.length];
        const squeeze = k % 2 === 0;
        const pc = [0.03, 0.005, 0, -0.01, -0.03][k % 5];
        const ann = rate * 3 * 365;
        n += 1;
        out.push({
          name: `${regime}/ema${ema}/rate${rate}/${state}/z${z}/raw${raw}`,
          call: raw > 40 ? 'BUY' : raw < -40 ? 'SELL' : 'HOLD',
          confidence: Math.min(Math.round((Math.abs(raw) / 89) * 100), 100),
          input: {
            coin: 'TESTC',
            scores: {
              rsiScore: [100, 40, 0, -40, -100][k % 5],
              emaScore: ema,
              fundingScore: fundingScoreOf(ann),
              oiScore: oiScoreOf(pc),
              volumeScore: [-70, -30, 10, 50, 100][k % 5],
              hurstVal: [0.40, 0.50, 0.60, null, 0.62][k % 5],
              squeezeActive: squeeze,
            },
            weights: WEIGHTS,
            outcome: { rawScore: raw },
            regime,
            indicators: {
              funding_rate: rate,
              funding_state: state,
              ...(oi === undefined ? {} : { oi_change_pct: oi, oi_change_window: '24h' }),
              volume_24h: 1_144_569_969,
              trend_persistence: (['LOW', 'MEDIUM', 'HIGH'] as const)[k % 3],
              breakout_pending: squeeze ? 'IMMINENT' : 'INACTIVE',
            },
            gates: { fundingZScore: z, fundingWindowDays: FUNDING_Z_WINDOW_DAYS },
          },
        });
      }
    }
  }
  expect(n).toBeGreaterThan(0);
  return out;
}

const CASES = corpus();
const failures: string[] = [];

/** Record rather than throw, so ONE run reports every property that broke. */
function check(cond: boolean, msg: string) {
  if (!cond) failures.push(msg);
  expect(cond, msg).toBe(true);
}

/** The rendered subject each factor speaks under. */
const SUBJECTS: Record<string, RegExp> = {
  funding_state: /\bfunding at\b/i,
  price_change_24h: /\bprice is\b/i,
  regime: /\bregime is\b/i,
  trend_persistence: /\btrend persistence\b/i,
  breakout_pending: /\bvolatility\b/i,
  oi_change_pct: /\bopen interest is\b/i,
  volume_24h: /\b24h volume is\b/i,
};

/**
 * Attribute every `→ bullish|bearish` arrow to the factor it actually describes, by
 * POSITION: an arrow belongs to the nearest subject that precedes it and is not
 * separated from it by another subject.
 *
 * Two earlier detectors failed here and both reported PASS against a build that
 * genuinely emitted `open interest is +2.4% … → bullish`:
 *   1. `subject[^.]*→ (bullish|bearish)` — `[^.]*` cannot cross the decimal point in
 *      `+2.4%`, so it never matched a clause carrying a value.
 *   2. splitting clauses on `/\.\s+|\s+and\s+/` — the frame "context only and not a
 *      verdict input" contains its own " and ", which cut the arrow off from its subject.
 * Positional attribution has no dependency on prose punctuation, which is the property
 * that makes it survive the next copy edit.
 */
function clauseAttributions(prose: string): Array<{ factor: string; arrow: string | null }> {
  const hits: Array<{ factor: string; at: number }> = [];
  for (const [factor, re] of Object.entries(SUBJECTS)) {
    const g = new RegExp(re.source, 'gi');
    let m: RegExpExecArray | null;
    while ((m = g.exec(prose)) !== null) hits.push({ factor, at: m.index });
  }
  hits.sort((a, b) => a.at - b.at);

  const arrows: Array<{ dir: string; at: number }> = [];
  const ga = /→\s*(bullish|bearish)/gi;
  let a: RegExpExecArray | null;
  while ((a = ga.exec(prose)) !== null) arrows.push({ dir: a[1].toLowerCase(), at: a.index });

  return hits.map((h, i) => {
    const nextSubjectAt = hits[i + 1]?.at ?? prose.length;
    const owned = arrows.find((x) => x.at > h.at && x.at < nextSubjectAt);
    return { factor: h.factor, arrow: owned ? owned.dir : null };
  });
}

/** Every factor name the prose actually mentions, by its rendered subject. */
function namedFactors(prose: string, ledger: FactorLedger): string[] {
  const named = new Set(clauseAttributions(prose).map((a) => a.factor));
  return ledger.rows.filter((r) => named.has(r.factor)).map((r) => r.factor);
}

describe('R5 — the prose can only ever say what the ledger says', () => {
  it('the corpus is non-empty and exercises every axis (VACUITY GUARD)', () => {
    // The test builds this corpus, so empty means the TEST is broken. Refuse.
    expect(CASES.length).toBeGreaterThanOrEqual(60);
    const ledgers = CASES.map((c) => buildFactorLedger(c.input));
    expect(ledgers.some((l) => l.counterweight !== null), 'no case produced a counterweight').toBe(true);
    expect(ledgers.some((l) => l.counterweight === null), 'every case produced a counterweight').toBe(true);
    expect(ledgers.some((l) => l.netDirection === 'bullish')).toBe(true);
    expect(ledgers.some((l) => l.netDirection === 'bearish')).toBe(true);
    expect(ledgers.some((l) => l.rows.some((r) => !r.contributes))).toBe(true);
    expect(ledgers.some((l) => l.rows.some((r) => r.humanFrame.includes(FUNDING_HISTORY_TOO_SHORT))), 'no <20-sample funding case').toBe(true);
    expect(ledgers.some((l) => l.strippedRemainder.count > 0)).toBe(true);
  });

  it('R5.1/R5.2 — every named factor exists in the ledger, with its direction, and contributes', () => {
    // VACUITY GUARD, and it earned its place immediately: the first version of this
    // assertion passed a deliberate RED-VERIFY that removed the `contributes` check from
    // the renderer entirely. It was checking a rule no case exercised, because no
    // non-contributing DIRECTIONAL row ever reached the prose. Counting them here means
    // the arrow-suppression rule is proven live rather than assumed.
    let nonContributingRendered = 0;
    for (const c of CASES) {
      const ledger = buildFactorLedger(c.input);
      const prose = renderVerdictReasoning(ledger, c.call, c.confidence);
      for (const { factor, arrow } of clauseAttributions(prose)) {
        const row = ledger.rows.find((r) => r.factor === factor);
        check(!!row, `${c.name}: prose names "${factor}" which is not in the ledger: ${prose}`);
        if (!row) continue;
        if (!row.contributes && row.direction !== 'neutral') nonContributingRendered += 1;
        if (arrow === null) continue;
        // A direction ARROW is a causal claim. It may appear only for a row that
        // actually moved the score — the `oi_change_pct → bullish` defect verbatim.
        check(row.contributes, `${c.name}: non-contributing "${factor}" rendered with a direction arrow: ${prose}`);
        check(arrow === row.direction, `${c.name}: "${factor}" arrow ${arrow} ≠ ledger ${row.direction}: ${prose}`);
      }
    }
    expect(
      nonContributingRendered,
      'VACUOUS: no case rendered a non-contributing row that HAS a direction, so the arrow-suppression rule was never exercised',
    ).toBeGreaterThan(0);
  });

  it('R5.3 — netDirection never contradicts the call', () => {
    for (const c of CASES) {
      const ledger = buildFactorLedger(c.input);
      if (c.call === 'BUY') check(ledger.netDirection === 'bullish', `${c.name}: BUY with net ${ledger.netDirection}`);
      if (c.call === 'SELL') check(ledger.netDirection === 'bearish', `${c.name}: SELL with net ${ledger.netDirection}`);
    }
  });

  it('R5.4 — one counterweight sentence iff there is a counterweight, and no fabricated conviction cap', () => {
    for (const c of CASES) {
      const ledger = buildFactorLedger(c.input);
      const prose = renderVerdictReasoning(ledger, c.call, c.confidence);
      const against = (prose.match(/Against:/g) ?? []).length;
      check(against === (ledger.counterweight ? 1 : 0), `${c.name}: ${against} "Against:" vs counterweight=${!!ledger.counterweight}: ${prose}`);
      // CH1.5 measured that regime enters NEITHER the verdict NOR the confidence —
      // `VerdictGateInputs` has no regime field and the thresholds are per-timeframe.
      // So any "caps conviction" claim is fabricated by construction.
      check(!/cap(s|ping)? (the )?conviction/i.test(prose), `${c.name}: fabricated conviction cap: ${prose}`);
      // The driver and the objection can never be the same row.
      if (ledger.counterweight) {
        const cw = ledger.counterweight;
        const firstSentence = prose.split('. ')[0];
        check(!firstSentence.includes(cw.value) || cw.value === '', `${c.name}: counterweight also narrated as the driver: ${prose}`);
      }
    }
  });

  it('R5.5 — exactly 3 sentences, <=280 chars, ". "-delimited so the card renderer is untouched', () => {
    for (const c of CASES) {
      const prose = renderVerdictReasoning(buildFactorLedger(c.input), c.call, c.confidence);
      const sentences = prose.split('. ');
      check(sentences.length === REASONING_SENTENCE_COUNT, `${c.name}: ${sentences.length} sentences: ${prose}`);
      check(prose.length <= REASONING_MAX_CHARS, `${c.name}: ${prose.length} chars > ${REASONING_MAX_CHARS}: ${prose}`);
      check(prose.endsWith('.'), `${c.name}: no terminal period: ${prose}`);
      check(!prose.includes('..'), `${c.name}: doubled period: ${prose}`);
    }
  });

  it('R5.6 — every number in the prose is reproducible from the ledger it describes', () => {
    for (const c of CASES) {
      const ledger = buildFactorLedger(c.input);
      const prose = renderVerdictReasoning(ledger, c.call, c.confidence);
      // The payload a real caller sees: the public indicators plus the stripped-remainder
      // count that D7 requires the prose to be able to name.
      const payload = collectPayloadNumbers({ indicators: c.input.indicators, stripped: ledger.strippedRemainder });
      const unbacked = unbackedProseNumbers(prose, payload, [FUNDING_Z_WINDOW_DAYS, PRICE_CHANGE_WINDOW_HOURS]);
      check(unbacked.length === 0, `${c.name}: unsourced numbers ${JSON.stringify(unbacked)}: ${prose}`);
    }
  });

  it('R5.7 — no component score, coefficient, or outcome field ever reaches the string', () => {
    // Token-anchored, not substring. A bare /rsi/i matches inside "pe(rsi)stence" and a
    // bare /0\.25/ matches inside a legitimate "-0.2500%" funding rate — both would fail
    // this gate on correct output, and a gate that cries wolf is one that gets deleted.
    const banned = [
      /outcome_return/i,
      /outcome_price/i,
      /\brsi\b/i,
      /\bhurst\b/i,
      /z[\s-]?score/i,
      /\bpts?\b/i,
      /(?<![\d.])0\.(30|25|20|15|10)(?![\d])/, // a bare weight coefficient
    ];
    for (const c of CASES) {
      const prose = renderVerdictReasoning(buildFactorLedger(c.input), c.call, c.confidence);
      for (const re of banned) check(!re.test(prose), `${c.name}: matched banned ${re}: ${prose}`);
    }
  });

  it('R5.8 — a <20-sample funding row is never "neutral" AND never "no factor cleared its threshold"', () => {
    let seen = 0;
    for (const c of CASES) {
      const ledger = buildFactorLedger(c.input);
      if (!ledger.rows.some((r) => r.humanFrame.includes(FUNDING_HISTORY_TOO_SHORT))) continue;
      seen += 1;
      const prose = renderVerdictReasoning(ledger, c.call, c.confidence);
      // Both phrasings assert a MEASUREMENT that was never taken. "Normal" claims a
      // distribution we do not have; "no factor cleared its threshold" claims the
      // factors were checked. Over an unmeasured row they are the same false claim.
      check(!/funding[^.]*\bnormal\b/i.test(prose), `${c.name}: unmeasured funding called normal: ${prose}`);
      check(!/no factor cleared its threshold/i.test(prose), `${c.name}: unmeasured funding reported as measured-and-flat: ${prose}`);
    }
    expect(seen, 'VACUITY: no <20-sample case reached this assertion').toBeGreaterThan(0);
  });
});

describe('R6 — non-discrimination: different inputs, different prose', () => {
  // The exact live pair. SOL (OI +2.53%) and DOGE (OI -0.41%) returned byte-identical
  // reasoning on 2026-08-06 — opposite-signed open interest, 4x different funding, same
  // sentence. Asserted on the POSITIVE rendered output, never on absence-of-failure.
  const base = (coin: string, rate: number, oi: number): FactorLedgerInput => ({
    coin,
    scores: { rsiScore: 0, emaScore: -100, fundingScore: fundingScoreOf(rate * 3 * 365), oiScore: oiScoreOf(-0.01), volumeScore: -30, hurstVal: 0.60, squeezeActive: true },
    weights: WEIGHTS,
    outcome: { rawScore: -25 },
    regime: 'TRENDING_DOWN',
    indicators: {
      funding_rate: rate, funding_state: 'NORMAL', oi_change_pct: oi, oi_change_window: '24h',
      volume_24h: 1_144_569_969, trend_persistence: 'HIGH', breakout_pending: 'IMMINENT',
    },
    gates: { fundingZScore: -0.8, fundingWindowDays: FUNDING_Z_WINDOW_DAYS },
  });

  it('SOL and DOGE render DIFFERENT strings (the byte-identical defect, pinned)', () => {
    const sol = renderVerdictReasoning(buildFactorLedger(base('SOL', -0.00006032, 2.53)), 'HOLD', 28);
    const doge = renderVerdictReasoning(buildFactorLedger(base('DOGE', -0.00001397, -0.41)), 'HOLD', 28);
    // Positive assertion: each string is shown to contain its OWN asset's measured value.
    expect(sol).toContain('-0.0060%');
    expect(sol).toContain('SOL');
    expect(doge).toContain('-0.0014%');
    expect(doge).toContain('DOGE');
    check(sol !== doge, `SOL and DOGE rendered identically: ${sol}`);
  });

  it('a change in ANY single factor value changes the string', () => {
    const ref = renderVerdictReasoning(buildFactorLedger(base('SOL', -0.00006032, 2.53)), 'HOLD', 28);
    const variants: Array<[string, FactorLedgerInput]> = [
      ['funding rate', base('SOL', -0.00019, 2.53)],
      ['regime', { ...base('SOL', -0.00006032, 2.53), regime: 'RANGING', scores: { ...base('SOL', -0.00006032, 2.53).scores, emaScore: 0 } }],
      ['breakout', { ...base('SOL', -0.00006032, 2.53), scores: { ...base('SOL', -0.00006032, 2.53).scores, squeezeActive: false }, indicators: { ...base('SOL', -0.00006032, 2.53).indicators, breakout_pending: 'INACTIVE' } }],
      ['net direction', { ...base('SOL', -0.00006032, 2.53), outcome: { rawScore: 25 } }],
    ];
    for (const [label, v] of variants) {
      const got = renderVerdictReasoning(buildFactorLedger(v), 'HOLD', 28);
      check(got !== ref, `changing ${label} produced identical prose: ${got}`);
    }
  });
});

// ── The single terminal verdict token ──
afterAll(() => {
  const vacuous = CASES.length === 0;
  const verdict = vacuous ? 'INDETERMINATE' : failures.length === 0 ? 'PASS' : 'FAIL';
  if (failures.length) for (const f of failures) console.error(`  ✗ ${f}`);
  console.log(`REASONING_CONSISTENCY_VERDICT=${verdict}`);
  // 0=PASS / 1=FAIL / 3=INDETERMINATE. 3, not 2: token-law default for a NEW gate.
  if (vacuous) process.exitCode = 3;
});
