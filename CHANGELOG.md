# Changelog

All notable changes to `crypto-quant-signal-mcp` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.9.0] - 2026-04-15 — Activation patch

Addresses the activation bottleneck identified in
`experiments/crypto-quant-signal/analytics-funnel-snapshot-2026-04-15.md`:
70.5:1 install-to-call ratio, 100% agent one-and-done retention under 1h,
88% of `get_trade_signal` responses returning HOLD (free tier, zero billable
pressure).

### Added — Signal surface expansion

- **L2 — HOLD Rescue.** On a HOLD verdict, `get_trade_signal` responses now
  include `closest_tradeable`: the highest-confidence non-HOLD cell (BUY or
  SELL, confidence ≥ 52) from the pre-computed cross-asset grid, excluding
  the requested `(coin, timeframe)`. Omitted when the grid has no non-HOLD
  cell. This is a data surface, not a trade recommendation.
- **L4 — Next-Calls Hints.** Every response (HOLD and non-HOLD) now includes
  `try_next`: the top-3 highest-confidence non-HOLD cells from the same grid,
  excluding the requested `(coin, timeframe)`. Omitted when the grid is
  empty. Exposes what the scorer currently sees across the grid; agents
  decide execution.
- The grid is computed once per 60-second TTL across 6 assets
  (BTC, ETH, SOL, BNB, XRP, DOGE) × 4 timeframes (5m, 15m, 1h, 4h) = 24
  cells, promise-coalesced, lazy-refresh (no cron, no background worker).
  See `src/lib/cross-asset-grid.ts`.

### Added — Retention analytics

- **L3 — Session Cohort Surfacing.** The `mcp-session-id` header extracted at
  the transport layer is now surfaced in every tool response's
  `_algovault.session_id` field (null under stdio transport). Per-session
  cohort metadata is persisted in a new `agent_sessions` table
  (first_seen, last_seen, call_count, tools_used, tiers_seen) so retention
  cohorts are directly queryable without reconstructing from aggregates.
  Unblocks data-gap #2 from the funnel snapshot.

### Changed

- `package.json` version bumped `1.8.1` → `1.9.0`.
- Eliminated hardcoded `version: '1.x.x'` string literals across
  `src/tools/*.ts` and `src/index.ts`. All envelopes and the HTTP `/health`
  endpoint now read the version from a shared `PKG_VERSION` helper at
  `src/lib/pkg-version.ts`.

### Not in this release

- **L1 — Inline `track_record` surfacing** (re-exposing `signal-performance`
  on every `get_trade_signal` response) is gated on Phase E ✅
  (2026-04-17 ~02:30 UTC) and will ship in a follow-up patch.
- Forum-post cron hardening (Hashnode, Moltbook) shipped on a concurrent
  branch (`harden/agent-forum-post-verify`, now merged).

## [1.8.1] - 2026-04-13

### Changed
- Website branded around 5-exchange support (Hyperliquid, Binance, Bybit, OKX, Bitget).
- README rewritten to highlight multi-exchange coverage and adapter architecture.
- `server.json` bumped to v1.8.1 for the MCP Registry listing.

### Fixed
- Dashboard now reports consistent Trade Calls and Evaluated columns across all three tables.
- Exchange tab highlight updates instantly on click.
- Tier cards respond to exchange/tier filters; removed stale "Tier 1-2 + TradFi" tab.
- HL TradFi coverage limited to top 20 by OI.
- `backfill-outcomes` now passes `dex:'xyz'` for HL TradFi symbols.

### CI
- Auto-publish release post on version bump deploy.
- Use `grep` instead of `node` for version detection on the VPS (no node on host).
- Auto-sync landing pages to the Caddy serve path on deploy.

## [1.8.0] - 2026-04-11

### Added
- Exchange tabs on the public dashboard.
- Enriched tier cards with per-exchange breakdowns.

### Changed
- Methodology page updated to reflect the 5-exchange signal pipeline.

### Fixed
- Unicode rendering in public dashboard copy.
- Monitor treats HTTP 429 as alive; backfill alert threshold raised to 50K.
