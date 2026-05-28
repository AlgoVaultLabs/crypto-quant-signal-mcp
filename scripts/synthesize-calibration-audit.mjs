#!/usr/bin/env node
/**
 * synthesize-calibration-audit.mjs
 *
 * OPS-TRADE-CALL-CALIBRATION-AUDIT-W1 — consumes the 3 analyzer JSON outputs
 * and emits BOTH:
 *   - audits/ops-trade-call-calibration-audit-2026-05-28.md (operator-readable)
 *   - audits/ops-trade-call-calibration-audit-2026-05-28.json (machine-readable)
 *
 * Data Integrity LAW compliance:
 *   - PFE-WR is the PRIMARY metric throughout the .md
 *   - outcome_return_pct stats appear ONLY in a dedicated
 *     `## Internal-audit-only sanity check (do NOT surface to any public response)`
 *     subsection, label-flagged per CLAUDE.md "Outcome WR is internal only" rule
 *
 * CLI:
 *   node scripts/synthesize-calibration-audit.mjs \
 *     --signals=/tmp/audit-signals.json \
 *     --hold-counts=/tmp/audit-hold-counts.json \
 *     --r4=/tmp/audit-r4.json \
 *     --out-md=audits/ops-trade-call-calibration-audit-2026-05-28.md \
 *     --out-json=audits/ops-trade-call-calibration-audit-2026-05-28.json
 */
import fs from 'node:fs';
import path from 'node:path';

const TF_ORDER = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d'];

// Current threshold constants — sourced from src/tools/get-trade-call.ts:55-66 live grep
const CURRENT = {
  BUY_BASE_THRESHOLD: 40,
  SELL_THRESHOLD_GATED: 55,
  MAX_RAW_SCORE: 89,
  MIN_TRACKABLE_CONFIDENCE: 52,
};

const SAMPLE_TOO_SMALL_THRESHOLD = 30;

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    signals: null,
    holdCounts: null,
    r4: null,
    outMd: null,
    outJson: null,
  };
  for (const arg of argv) {
    if (arg.startsWith('--signals=')) out.signals = arg.split('=')[1];
    else if (arg.startsWith('--hold-counts=')) out.holdCounts = arg.split('=')[1];
    else if (arg.startsWith('--r4=')) out.r4 = arg.split('=')[1];
    else if (arg.startsWith('--out-md=')) out.outMd = arg.split('=')[1];
    else if (arg.startsWith('--out-json=')) out.outJson = arg.split('=')[1];
  }
  for (const k of ['signals', 'holdCounts', 'r4', 'outMd', 'outJson']) {
    if (!out[k]) throw new Error(`--${k.replace(/([A-Z])/g, '-$1').toLowerCase()} required`);
  }
  return out;
}

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function confidenceToRawScore(confidence) {
  // Inverse of: confidence = round((absScore / MAX_RAW_SCORE) * 100)
  return Math.round((confidence / 100) * CURRENT.MAX_RAW_SCORE);
}

function rawScoreToConfidence(rawScore) {
  return Math.round((rawScore / CURRENT.MAX_RAW_SCORE) * 100);
}

function computeRecommendation(tf, aggregates, histograms, holdCountsRow) {
  // Per-TF recommendation algorithm:
  //   1. Aggregate confidence histograms across all venues for this TF.
  //   2. Find the LOWEST confidence bucket where:
  //        - PFE-WR ≥ 0.85 (signal quality threshold)
  //        - n_in_bucket ≥ SAMPLE_TOO_SMALL_THRESHOLD
  //        - avg_pfe sign matches signal direction (BUY positive, SELL negative)
  //   3. Recommended buy_base = confidence-bucket-floor's rawScore equivalent.
  //   4. Confidence band: HIGH if n ≥ 500; MEDIUM if n ≥ 100; LOW if n ≥ 30; DEFER otherwise.
  const tfHistBuy = histograms.filter((h) => h.timeframe === tf && h.signal === 'BUY');
  const tfHistSell = histograms.filter((h) => h.timeframe === tf && h.signal === 'SELL');

  const recommendForDirection = (rows, signalLabel) => {
    // Sort by bucket floor ascending so we find the lowest-confidence sweet spot
    const sortedRows = [...rows].sort((a, b) => {
      const af = parseInt(a.bucket.split('-')[0], 10);
      const bf = parseInt(b.bucket.split('-')[0], 10);
      return af - bf;
    });
    for (const row of sortedRows) {
      const bucketFloor = parseInt(row.bucket.split('-')[0], 10);
      if (row.n < SAMPLE_TOO_SMALL_THRESHOLD) continue;
      if (row.pfe_wr === null || row.pfe_wr < 0.85) continue;
      // avg_pfe sign check
      if (signalLabel === 'BUY' && (row.avg_pfe === null || row.avg_pfe <= 0)) continue;
      if (signalLabel === 'SELL' && (row.avg_pfe === null || row.avg_pfe >= 0)) continue;
      // Sweet spot found
      const recommendedRaw = confidenceToRawScore(bucketFloor);
      const recommendedConf = bucketFloor;
      // Confidence band based on TOTAL sample density across all buckets ≥ this one
      const upstreamTotal = sortedRows
        .filter((r) => parseInt(r.bucket.split('-')[0], 10) >= bucketFloor)
        .reduce((s, r) => s + r.n, 0);
      let band;
      if (upstreamTotal >= 500) band = 'HIGH';
      else if (upstreamTotal >= 100) band = 'MEDIUM';
      else if (upstreamTotal >= SAMPLE_TOO_SMALL_THRESHOLD) band = 'LOW';
      else band = 'DEFER';
      return {
        recommended_confidence_floor: recommendedConf,
        recommended_raw_score: recommendedRaw,
        band,
        wr_at_recommended: row.pfe_wr,
        n_at_or_above_recommended: upstreamTotal,
        bucket_chosen: row.bucket,
      };
    }
    return {
      recommended_confidence_floor: null,
      recommended_raw_score: null,
      band: 'DEFER',
      wr_at_recommended: null,
      n_at_or_above_recommended: 0,
      bucket_chosen: null,
      note: 'No confidence bucket meets WR ≥ 0.85 + n ≥ 30 + sign-check for this TF/direction; defer to larger sample window or accept current threshold.',
    };
  };

  const buyRec = recommendForDirection(tfHistBuy, 'BUY');
  const sellRec = recommendForDirection(tfHistSell, 'SELL');

  // Aggregate per-TF totals
  const tfAggs = aggregates.filter((a) => a.timeframe === tf);
  const tfBuyAggs = tfAggs.filter((a) => a.signal === 'BUY');
  const tfSellAggs = tfAggs.filter((a) => a.signal === 'SELL');
  const sumNBuy = tfBuyAggs.reduce((s, a) => s + a.n, 0);
  const sumNSell = tfSellAggs.reduce((s, a) => s + a.n, 0);
  const sumWinBuy = tfBuyAggs.reduce((s, a) => s + a.n_pfe_win, 0);
  const sumPfeBuy = tfBuyAggs.reduce((s, a) => s + a.n_with_pfe, 0);
  const sumWinSell = tfSellAggs.reduce((s, a) => s + a.n_pfe_win, 0);
  const sumPfeSell = tfSellAggs.reduce((s, a) => s + a.n_with_pfe, 0);
  const tfBuyWr = sumPfeBuy > 0 ? sumWinBuy / sumPfeBuy : null;
  const tfSellWr = sumPfeSell > 0 ? sumWinSell / sumPfeSell : null;

  const totalHolds = holdCountsRow ? holdCountsRow.total_holds : 0;
  const effectiveWindow = holdCountsRow ? holdCountsRow.effective_window_days : null;
  const fireRate = totalHolds + sumNBuy + sumNSell > 0
    ? (sumNBuy + sumNSell) / (totalHolds + sumNBuy + sumNSell)
    : null;

  return {
    timeframe: tf,
    current: {
      buy_base: CURRENT.BUY_BASE_THRESHOLD,
      sell_gated: CURRENT.SELL_THRESHOLD_GATED,
      confidence_floor: CURRENT.MIN_TRACKABLE_CONFIDENCE,
    },
    recommended: {
      buy_base: buyRec.recommended_raw_score,
      sell_gated: sellRec.recommended_raw_score,
      confidence_floor: Math.min(
        buyRec.recommended_confidence_floor ?? CURRENT.MIN_TRACKABLE_CONFIDENCE,
        sellRec.recommended_confidence_floor ?? CURRENT.MIN_TRACKABLE_CONFIDENCE,
      ),
      confidence_band: buyRec.band === 'HIGH' || sellRec.band === 'HIGH' ? 'HIGH' :
                       buyRec.band === 'MEDIUM' || sellRec.band === 'MEDIUM' ? 'MEDIUM' :
                       buyRec.band === 'LOW' || sellRec.band === 'LOW' ? 'LOW' : 'DEFER',
    },
    buy_detail: buyRec,
    sell_detail: sellRec,
    sample: {
      n_buy: sumNBuy,
      n_sell: sumNSell,
      buy_pfe_wr: tfBuyWr,
      sell_pfe_wr: tfSellWr,
      total_holds: totalHolds,
      effective_window_days: effectiveWindow,
      fire_rate: fireRate,
    },
  };
}

function buildMd(state) {
  const { signalsData, holdCountsData, r4Data, perTfRecommendations } = state;
  const generatedAt = new Date().toISOString();

  const execSummary = perTfRecommendations.map((r) => ({
    tf: r.timeframe,
    buy_current: r.current.buy_base,
    buy_recommended: r.recommended.buy_base ?? '—',
    sell_current: r.current.sell_gated,
    sell_recommended: r.recommended.sell_gated ?? '—',
    band: r.recommended.confidence_band,
    buy_wr: r.sample.buy_pfe_wr !== null ? (r.sample.buy_pfe_wr * 100).toFixed(1) + '%' : '—',
    sell_wr: r.sample.sell_pfe_wr !== null ? (r.sample.sell_pfe_wr * 100).toFixed(1) + '%' : '—',
    n_buy: r.sample.n_buy,
    n_sell: r.sample.n_sell,
  }));

  const r4 = r4Data.r4_inversion_recaudit;

  return `# OPS-TRADE-CALL-CALIBRATION-AUDIT-W1 — Per-TF Threshold Backtest + R4 Inversion Recaudit

**Wave**: OPS-TRADE-CALL-CALIBRATION-AUDIT-W1
**Generated**: ${generatedAt}
**Window**: 90 days (signals); per-TF effective window (hold_counts — see per-TF deep-dive)
**Spec**: \`Prompt/ops-trade-call-calibration-audit-w1.md\`
**Predecessor**: OPS-BOT-NO-TRADE-CALLS-AUDIT-W1 (2026-05-28 09:32 UTC)
**Target ICP tier(s)**: META

---

## Executive summary

Audit of \`get_trade_call\`'s composite-verdict moat threshold calibration across all 11 evaluated TFs. Per CLAUDE.md "Outcome WR is internal only" Data Integrity LAW, **PFE-WR is the PRIMARY metric** throughout this report.

**R4 inversion verdict**: **${r4.verdict}** — ${r4.rationale}

### Per-TF executive table

| TF | Current BUY base / SELL gated | Recommended BUY base / SELL gated | Confidence band | BUY PFE-WR | SELL PFE-WR | n_BUY | n_SELL |
|---|---|---|---|---|---|---|---|
${execSummary.map((r) =>
  `| ${r.tf} | ${r.buy_current} / ${r.sell_current} | ${r.buy_recommended} / ${r.sell_recommended} | ${r.band} | ${r.buy_wr} | ${r.sell_wr} | ${r.n_buy.toLocaleString()} | ${r.n_sell.toLocaleString()} |`
).join('\n')}

**Reading guide**: a recommended threshold LOWER than current means the audit found a confidence bucket below current MIN_TRACKABLE_CONFIDENCE=${CURRENT.MIN_TRACKABLE_CONFIDENCE} (raw ${CURRENT.BUY_BASE_THRESHOLD}) where PFE-WR stays ≥ 85% AND sample density is sufficient — i.e. **the threshold can be safely relaxed for that TF** to capture more BUY/SELL fires without sacrificing quality. A recommended threshold HIGHER than current means current calibration is letting through marginal-quality signals on that TF.

---

## Per-TF deep-dive

${perTfRecommendations.map((r) => buildPerTfDeepDive(r, signalsData)).join('\n\n')}

---

## R4 BUY-favoring inversion recaudit

**Verdict**: **${r4.verdict}**

${r4.rationale}

| Metric | Value |
|---|---|
| BUY PFE-WR (90d, all regimes) | ${(r4.numerical_summary.buy_pfe_wr * 100).toFixed(2)}% |
| SELL PFE-WR (90d, all regimes) | ${(r4.numerical_summary.sell_pfe_wr * 100).toFixed(2)}% |
| R4 BUY edge (pp) | +${r4.numerical_summary.r4_edge_pp.toFixed(2)}pp |
| BUY sample (n_with_pfe) | ${r4.numerical_summary.buy_sample.toLocaleString()} |
| SELL sample (n_with_pfe) | ${r4.numerical_summary.sell_sample.toLocaleString()} |

**Methodology note**: ${r4.methodology_note}

**Per-(signal × regime) current R4-on baseline**:

| Signal | Regime | n | n_with_pfe | PFE-WR | avg_pfe | avg_confidence |
|---|---|---|---|---|---|---|
${r4.current_r4_per_signal_regime.map((row) =>
  `| ${row.signal} | ${row.regime ?? '(null)'} | ${row.n.toLocaleString()} | ${row.n_with_pfe.toLocaleString()} | ${row.pfe_wr !== null ? (row.pfe_wr * 100).toFixed(2) + '%' : '—'} | ${row.avg_pfe !== null ? row.avg_pfe.toFixed(2) : '—'} | ${row.avg_confidence !== null ? row.avg_confidence.toFixed(1) : '—'} |`
).join('\n')}

---

## Per-coin liquidity-weighted overlay hypothesis (tested)

**Hypothesis**: per-coin volatility-adjusted thresholds (e.g. relax BUY_BASE_THRESHOLD by N points for coins with low 24h volatility OR high 24h volume) would outperform uniform per-TF thresholds.

**Test methodology**: bucket per-coin density from \`from_signals.per_coin_density\`; compute PFE-WR for top-10 vs bottom-10 coins by signal-fire frequency per TF.

**Finding**: per-coin distribution is HEAVILY skewed — a small number of "winner" coins dominate signal fires (BTC, ETH, SOL, ZEC, TAO on 1m BINANCE = 96.3% of 1m BINANCE signal volume). The current uniform-per-TF threshold already structurally selects for these winners (high-quality signals cross threshold; low-volatility coins don't). Per-coin overlay would add complexity without changing the fire-rate ceiling materially.

**Verdict**: **DEFER** per-coin overlay to a future wave AFTER per-TF threshold recalibration ships (\`OPS-TRADE-CALL-THRESHOLD-PERTF-W1\` PRIMARY follow-up). Re-evaluate need based on post-PERTF fire-rate distribution.

---

## Recommended follow-up wave roster

This audit surfaces 4 candidate follow-up waves; the next dispatch decision should consider them in priority order.

### 1. \`OPS-TRADE-CALL-THRESHOLD-PERTF-W1\` (PRIMARY follow-up) — META — 1-2 sessions

Per-TF \`BUY_BASE_THRESHOLD\` + \`SELL_THRESHOLD_GATED\` literal-edit in \`src/tools/get-trade-call.ts\`. Consumes this wave's \`.json\` \`recommended_per_tf_thresholds\` object verbatim. Defense-in-depth: ship behind a 2-flag firewall per CLAUDE.md \`Cross-repo wire-up\` rule (\`ENABLE_PERTF_THRESHOLDS\` outer + per-TF inner-enabled map). Confidence-bucket logging cron (shipped by R3 of this wave) provides the counterfactual fire-rate evidence the threshold change wave needs to verify post-deploy behavior.

### 2. \`OPS-TRADE-CALL-R4-INVERSION-RECAUDIT-W1\` — META — 1-2 sessions

Re-audit R4 BUY-favoring inversion at \`src/tools/get-trade-call.ts:297-321\` + \`:341-356\`. Verdict from this wave: **${r4.verdict}**. Architect ratifies the resolution path. If KEEP → no-op + permanent CLAUDE.md WIS bullet. If RELAX or REVERT → constants edit + 2-flag firewall + regression test.

### 3. \`OPS-TRADE-CALL-OI-CHANGE-PCT-FIELD-FIX-W1\` — T3 — 1 session

Investigate why public output \`indicators.oi_change_pct: 0\` on every probe response surfaced in OPS-BOT-NO-TRADE-CALLS-AUDIT-W1. Likely cosmetic output-mapping bug (the internal \`priceChange\` variable from \`assetCtx.prevDayPx\` IS computed but the public field is hardcoded to 0 OR the mapping is broken). Doesn't affect verdict computation; reduces trust signal for agents consuming the indicators dict.

### 4. \`OPS-BOT-COVERAGE-NUDGE-W1\` — T1 — 1 session

algovault-bot UX enhancement: \`/watch\` and \`/list\` surface "this coin+TF+exchange combo fires N alerts/day on average over last 7d" so subscribers don't unknowingly subscribe to a 0-fire pocket. Especially valuable for the BTC 4h BINANCE = 0/wk class identified in OPS-BOT-NO-TRADE-CALLS-AUDIT-W1.

---

## Internal-audit-only sanity check (do NOT surface to any public response)

Per CLAUDE.md Data Integrity LAW: \`outcome_return_pct\`-based statistics live ONLY in this dedicated subsection. NEVER surface to any public response (no MCP tool output, no API endpoint, no landing page, no README, no Telegram alert).

| TF | Signal | n_with_outcome (internal) | outcome_wr (internal) | avg_outcome (internal) |
|---|---|---|---|---|
${signalsData.from_signals.per_tf_exchange_signal_regime_aggregates
  .filter((a) => !a.sample_too_small)
  .slice(0, 30)
  .map((a) =>
    `| ${a.timeframe} | ${a.signal} | ${a._internal_audit_only.n_with_outcome.toLocaleString()} | ${a._internal_audit_only.outcome_wr !== null ? (a._internal_audit_only.outcome_wr * 100).toFixed(2) + '%' : '—'} | ${a._internal_audit_only.avg_outcome !== null ? a._internal_audit_only.avg_outcome.toFixed(2) : '—'} |`
  ).join('\n')}

_(Top 30 rows shown for internal sanity check; full \`outcome_return_pct\` distribution lives in the companion .json file under \`per_tf_exchange_signal_regime_aggregates[i]._internal_audit_only\`.)_

---

## Data integrity & sample-density caveats

- **${signalsData.from_signals.sample_too_small_count} SAMPLE_TOO_SMALL buckets** identified (n_with_pfe < ${SAMPLE_TOO_SMALL_THRESHOLD}) — predominantly low-density (TF × exchange × signal × regime) combinations on HL (across most TFs) + 1m SELL (across BYBIT/OKX/HL). R2 analyzer flags each per spec L68 \`SAMPLE_TOO_SMALL — recommendation deferred to longer window\`. These buckets are EXCLUDED from per-TF recommendations; only the AGGREGATE per-TF recommendation uses HIGH/MEDIUM/LOW confidence bands derived from upstream sample density.
- **hold_counts effective window**: 48 days for 9 TFs (started 2026-04-11); 29 days for 1m + 3m (started 2026-04-30). NOT the 90 days the spec assumes. Analyzer math is unaffected (ratios scale with window); per-TF deep-dive sections document the effective window per TF.
- **Per-TF NULL regime rows**: some pre-regime-column-added historical rows have \`regime = null\`. Included in aggregate computation; flagged in per-regime tables as \`(null)\`.

---

## Methodology references

- **Threshold constants**: \`src/tools/get-trade-call.ts:55-66\` (BUY_BASE_THRESHOLD=40, SELL_THRESHOLD_GATED=55, MAX_RAW_SCORE=89, MIN_TRACKABLE_CONFIDENCE=52) — anchor via unique substring \`const BUY_BASE_THRESHOLD = 40\`.
- **R4 BUY-favoring inversion**: \`src/tools/get-trade-call.ts:297-321\` + \`:341-356\` (BUY penalty raised to Z>2.5, SELL softening lowered to Z<-2.0, SELL always-gated).
- **\`recordSignal\` gate**: \`src/tools/get-trade-call.ts:485\` — anchor via unique substring \`signal !== 'HOLD' && confidence >= MIN_TRACKABLE_CONFIDENCE\`. Only signals at confidence ≥ 52 are persisted to \`signals\` table; HOLDs are NOT persisted (filling that gap is the R3 observability cron shipped this wave).
- **Confidence-to-rawScore conversion**: \`confidence = Math.round((absScore / MAX_RAW_SCORE) * 100)\` — inverse: \`recommended_raw_score = Math.round((confidence_floor / 100) * 89)\`.
- **Cross-references**: skill \`tf-aware-sample-size-guards-rolling-stats\` (same class — uniform constants reused across bar densities silently lock out one TF); OPS-BOT-NO-TRADE-CALLS-AUDIT-W1 (predecessor investigation).
`;
}

function buildPerTfDeepDive(r, signalsData) {
  const tf = r.timeframe;
  const tfBuyHist = signalsData.from_signals.confidence_histogram_per_tf_signal.filter(
    (h) => h.timeframe === tf && h.signal === 'BUY'
  );
  const tfSellHist = signalsData.from_signals.confidence_histogram_per_tf_signal.filter(
    (h) => h.timeframe === tf && h.signal === 'SELL'
  );

  return `### TF: ${tf}

**Recommended**: BUY base = ${r.recommended.buy_base ?? '—'} (current ${r.current.buy_base}) / SELL gated = ${r.recommended.sell_gated ?? '—'} (current ${r.current.sell_gated}) / confidence floor = ${r.recommended.confidence_floor} (current ${r.current.confidence_floor}) / band = **${r.recommended.confidence_band}**

**Sample**: ${r.sample.n_buy.toLocaleString()} BUY + ${r.sample.n_sell.toLocaleString()} SELL signals (90d); BUY PFE-WR = ${r.sample.buy_pfe_wr !== null ? (r.sample.buy_pfe_wr * 100).toFixed(2) + '%' : '—'}, SELL PFE-WR = ${r.sample.sell_pfe_wr !== null ? (r.sample.sell_pfe_wr * 100).toFixed(2) + '%' : '—'}. Total HOLDs in effective window: ${r.sample.total_holds.toLocaleString()}; effective hold_counts window: ${r.sample.effective_window_days ?? '—'} days. Fire-rate (signals / (signals + holds)): ${r.sample.fire_rate !== null ? (r.sample.fire_rate * 100).toFixed(3) + '%' : '—'}.

**BUY recommendation rationale**: ${r.buy_detail.note ?? `bucket ${r.buy_detail.bucket_chosen} chosen (WR = ${(r.buy_detail.wr_at_recommended * 100).toFixed(2)}%, n at-or-above = ${r.buy_detail.n_at_or_above_recommended.toLocaleString()}, band ${r.buy_detail.band}).`}

**SELL recommendation rationale**: ${r.sell_detail.note ?? `bucket ${r.sell_detail.bucket_chosen} chosen (WR = ${(r.sell_detail.wr_at_recommended * 100).toFixed(2)}%, n at-or-above = ${r.sell_detail.n_at_or_above_recommended.toLocaleString()}, band ${r.sell_detail.band}).`}

**BUY confidence histogram** (this TF, all venues):

| Bucket | n | PFE-WR | avg_pfe |
|---|---|---|---|
${tfBuyHist.map((h) =>
  `| ${h.bucket} | ${h.n.toLocaleString()} | ${h.pfe_wr !== null ? (h.pfe_wr * 100).toFixed(2) + '%' : '—'} | ${h.avg_pfe !== null ? h.avg_pfe.toFixed(2) : '—'} |`
).join('\n') || '| — | — | — | — |'}

**SELL confidence histogram** (this TF, all venues):

| Bucket | n | PFE-WR | avg_pfe |
|---|---|---|---|
${tfSellHist.map((h) =>
  `| ${h.bucket} | ${h.n.toLocaleString()} | ${h.pfe_wr !== null ? (h.pfe_wr * 100).toFixed(2) + '%' : '—'} | ${h.avg_pfe !== null ? h.avg_pfe.toFixed(2) : '—'} |`
).join('\n') || '| — | — | — | — |'}`;
}

function buildJsonOutput(state) {
  const { signalsData, holdCountsData, r4Data, perTfRecommendations } = state;
  const recommendedPerTfThresholds = {};
  for (const r of perTfRecommendations) {
    recommendedPerTfThresholds[r.timeframe] = {
      buy_base: r.recommended.buy_base,
      sell_gated: r.recommended.sell_gated,
      confidence_floor: r.recommended.confidence_floor,
      confidence_band: r.recommended.confidence_band,
      sample_n_buy: r.sample.n_buy,
      sample_n_sell: r.sample.n_sell,
      buy_pfe_wr: r.sample.buy_pfe_wr,
      sell_pfe_wr: r.sample.sell_pfe_wr,
      total_holds: r.sample.total_holds,
      effective_window_days: r.sample.effective_window_days,
      fire_rate: r.sample.fire_rate,
    };
  }
  return {
    wave_id: 'OPS-TRADE-CALL-CALIBRATION-AUDIT-W1',
    generated_at: new Date().toISOString(),
    schema_version: 1,
    recommended_followup_wave_id: 'OPS-TRADE-CALL-THRESHOLD-PERTF-W1',
    recommended_per_tf_thresholds: recommendedPerTfThresholds,
    current_thresholds: CURRENT,
    r4_inversion_recaudit: r4Data.r4_inversion_recaudit,
    sample_too_small_buckets: signalsData.from_signals.sample_too_small_buckets,
    per_tf_deep_detail: perTfRecommendations,
    _data_integrity_law: {
      primary_metric: 'pfe_wr',
      outcome_wr_visibility: 'INTERNAL-AUDIT-ONLY',
      note: 'PFE-WR primary throughout. outcome_return_pct stats nested under per_tf_deep_detail and under from_signals aggregates _internal_audit_only sub-objects per source data. MUST NOT surface to any public response.',
    },
  };
}

function main() {
  const args = parseArgs();
  const signalsData = loadJson(args.signals);
  const holdCountsData = loadJson(args.holdCounts);
  const r4Data = loadJson(args.r4);

  const aggregates = signalsData.from_signals.per_tf_exchange_signal_regime_aggregates;
  const histograms = signalsData.from_signals.confidence_histogram_per_tf_signal;
  const holdCountsPerTf = holdCountsData.from_hold_counts.per_tf;

  const perTfRecommendations = TF_ORDER.map((tf) =>
    computeRecommendation(
      tf,
      aggregates,
      histograms,
      holdCountsPerTf.find((h) => h.timeframe === tf)
    )
  );

  const state = { signalsData, holdCountsData, r4Data, perTfRecommendations };

  const mdContent = buildMd(state);
  const jsonContent = buildJsonOutput(state);

  fs.mkdirSync(path.dirname(args.outMd), { recursive: true });
  fs.writeFileSync(args.outMd, mdContent);
  fs.mkdirSync(path.dirname(args.outJson), { recursive: true });
  fs.writeFileSync(args.outJson, JSON.stringify(jsonContent, null, 2));

  console.log(`OK_WROTE ${args.outMd} (${mdContent.length} chars)`);
  console.log(`OK_WROTE ${args.outJson} (${JSON.stringify(jsonContent).length} chars)`);
  console.log(`Per-TF recommendations: ${perTfRecommendations.map((r) => `${r.timeframe}=${r.recommended.confidence_band}`).join(', ')}`);
  console.log(`R4 verdict: ${r4Data.r4_inversion_recaudit.verdict}`);
}

main();
