# CRYPTO-EDGE-METRIC-W1 — R0 provenance/schema probe (endpoint-truth)

Read-only forensic wave. **Structural / schema / code-provenance facts only — NO win-rate, edge, or sample numbers** (those are INTERNAL and live in the private vault artifact `CRYPTO-EDGE-METRIC-W1-2026-07-02.md`).

Probe path: `docker exec … psql` (read-only) + `curl` public GET + repo file reads. Date: 2026-07-02.

## R0.b — the `/track-record` "Directional Accuracy" card — provenance
- **It is NOT a separate number.** `src/index.ts:3620` renders one card: `label = "PFE Win Rate"`, `value id="pfe-wr"` (populated client-side from `/api/performance-public` `overall.pfeWinRate`), and **sub-label `"Directional Accuracy"`**. So the page presents the **PFE Win Rate value labeled as "Directional Accuracy."**
- `landing/llms.txt:13` ("PFE (directional-accuracy) win rate") and the `/track-record` JSON-LD (`src/index.ts:3542`, `measurementTechnique` = PFE) likewise **equate PFE win rate with directional accuracy.**
- **Finding (for the remediation, not this wave):** the audit `CRYPTO-PFE-BENCHMARK-AUDIT-W1` established that PFE win rate is a peak-favorable-excursion base rate; realized directional accuracy is materially different. Labeling the PFE value "Directional Accuracy" (card sub-label + llms.txt + JSON-LD) is a factuality exposure. No separate hardcoded/fabricated number exists — the misrepresentation is the **label**, not an unsourced value. `/api/performance-public` has **no** `directionalAccuracy` field (confirmed live: keys = totalCalls, period, overall, byCallType, byTimeframe, byAsset, byExchange, byTier, recentSignals, methodology, totalHolds, holdsByTier, hold_rate, asset_count, exchange_count, timeframe_count, shadow_venue_count).

## R0.a — existing validation (April Mode-A gate)
- April 2026 ran **five Mode A backtest iterations** (v1–v4, `experiments/crypto-quant-signal/` + `experiments/quant-trading-server/`); status: **recipe-space "formally exhausted," net EV ≤ 0**, HL execution **frozen 2026-04-18** (`Old Status/Status April 2026.md`).
- Gate to re-open (verbatim): *"AOE produces (tf, variant, conf-gate) cell with net EV > 0 after fees + stress, n ≥ 50, 1-σ CI > 0, on a 30-day walk-forward-validated cohort."*
- Speculative per-coin candidates cited (ZEC-1h n=21, ZEC-15m n=31, TAO-1h n=28, MON-5m n=37) all carry an **overfitting caveat + out-of-sample requirement** and are **n<50** — never validated.
- **AOE scope note:** the AOE loop re-tunes MCP signal-scoring weights (not a tradeable-PnL backtester; order-path/executor is a separate TLC system). No post-April Mode-A cell has cleared the gate.

## Schema (from the crypto audit; re-confirmed)
`signals` has `signal`, `confidence` (INT 0-100), `timeframe`, `coin`, `exchange`, `regime`, `pfe_return_pct`, `mae_return_pct`, `outcome_return_pct` (INTERNAL), `created_at`. Realized direction = sign of `outcome_return_pct`; the always-long/short benchmark = share with `outcome_return_pct > 0` per cell. **0 fictional primitives** → no HALT.

## Harness additions (R5)
`src/scripts/calibration-audit.ts` gains a statistically-honest edge layer (pure, unit-tested): `wilsonInterval`, `normalCdf`, `excessZP` (one-sided vs benchmark), `benjaminiHochberg` (FDR), `bonferroni`, `edgeMetricReport` (benchmark-excess + Wilson CI + FDR + **walk-forward** train/holdout), and `loadCryptoEdgeCells` (read-only per-cell loader). `--asset crypto --edge` prints the corrected cell table. Numeric results → vault.

## Read-only note (AC1)
`signals` is a **live append-only** production table; `count(*)` drifts upward during any audit regardless of reads. Read-only proof = *zero write/DDL statements* (only `\d`/`SELECT`/`curl` GET / file reads); the small count delta is live production.
