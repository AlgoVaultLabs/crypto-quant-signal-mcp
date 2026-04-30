# Changelog

All notable changes to `crypto-quant-signal-mcp` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.10.4] - 2026-04-30 — README polish

### Changed

- README "What's new in v1.10.3" trimmed: dropped the internal-context
  "Track-record disambiguation" bullet that exposed the 9-vs-11-timeframes
  nuance ("sub-5m indicators noise-dominated by design"). That nuance lives
  in `brand-facts.md` and on the track-record dashboard where it makes
  sense in-context; it doesn't belong on the public-facing npm/GitHub
  README.

No code or API changes — README-only patch.

## [1.10.3] - 2026-04-30 — Free-tier unlock + Connect-Your-MCP-Client docs

### Changed — Free-tier expansion

- **Free tier now includes all 716 assets and all 11 timeframes** (1m, 3m, 5m,
  15m, 30m, 1h, 2h, 4h, 8h, 12h, 1d). Was previously gated to BTC + ETH on
  15m + 1h only. The 100-calls/month cap remains unchanged as the primary
  upsell trigger; funding-arb top-5 remains the secondary upsell hook
  (paid tiers get unlimited funding-arb results). HOLD calls are still
  always free at every tier.
- `freeGateMessage()` reduced to a no-op — coin/timeframe gating is removed;
  the quota-exhaustion path (`getQuotaExhaustedMessage`) owns the upgrade-
  prompt surface from now on. The legacy `FREE_COINS` / `FREE_TIMEFRAMES`
  constants are kept commented-out as reserved emergency-rate-limit-defense
  switches.
- Zod schema `describe()` for `get_trade_call`'s `timeframe` parameter
  updated from "Free tier: 15m and 1h only" to "Free tier: all 11 timeframes
  available, 100 calls/month" so MCP clients render the correct tier
  capability in their tool-form UIs.

### Added — Connect Your MCP Client docs section

- New `<section id="connect-mcp">` rendered into `landing/docs.html` between
  `<!-- BUILD:mcp-usage:start -->` / `<!-- BUILD:mcp-usage:end -->` markers.
  Source-of-truth: `src/lib/mcp-usage-docs.ts` mirroring the `signup-flow.ts`
  pattern. Surface / Setup / Result table plus per-client `<details>`
  walkthroughs for: Claude Desktop, Cursor, Cline (VSCode), Claude Code,
  Smithery CLI, plain HTTP / curl. Every config snippet was web-verified
  against upstream docs on 2026-04-30 with citations + fetch date in the
  section's footnote so future drift is auditable.
- `scripts/build_landing.mjs` extended to handle multiple BUILD blocks
  (signup-flow + mcp-usage). Idempotent canary preserved (`files=0` on
  second run); `--check` mode reports drift per-block.

### Fixed — Track-record-vs-API-capability disambiguation

- `brand-facts.md §Asset coverage` corrected: previously listed `11 timeframes`
  as a forbidden phrase ("currently 9"), but the canonical Zod enum at
  `src/index.ts` accepts 11. The 9 visible on the public track-record
  dashboard are the cron-seeded subset (5m–1d); 1m/3m calls work via API
  on-demand but don't accrue rolling-window PFE data.
- Track-record dashboard (`/track-record` page) gains an explainer line
  above the "Performance by Timeframe" table clarifying the 9-of-11
  distinction. `landing/llms-full.txt` pricing table gets a coverage
  disclaimer below it.

### Tests

- `tests/unit/license.test.ts` (NEW, 62 tests) — free tier accepts every
  coin + every timeframe; quota / funding-arb caps unchanged.
- `tests/unit/mcp-usage-docs.test.ts` (NEW, 14 tests) — `MCP_USAGE_HTML`
  structural snapshot.
- `tests/unit/copy-consistency.test.ts` (NEW, 113 tests) — grep-guards
  landing surfaces against legacy free-tier-gating phrases and enforces
  "11 timeframes" in canonical files.
- `tests/get-trade-signal.test.ts` — refreshed: was asserting old "throws
  with /Starter/" gating behavior, now asserts SOL/1h and BTC/4h succeed
  on free tier.

### Upgrading from v1.9.x or earlier?

MCP clients (Claude Desktop, Claude.ai custom connectors, Cursor, Cline)
cache the tool list at session start. The free-tier behavior changed in
v1.10.3 — even though no tool was renamed, **refresh your tool list** so
the client picks up the new permissive responses:

- **Claude.ai / Claude Desktop**: Settings → Connectors → AlgoVault →
  toggle off + on (or click "Refresh tools").
- **Cursor / Cline**: restart the MCP server connection from the
  integration panel.

Cached tool responses from before the unlock may still surface "requires
Starter" upgrade hints on free-tier calls. Refreshing fixes it instantly.
The server is backward-compatible — old code that called `get_trade_signal`
with BTC/ETH on 15m/1h continues to work; it now also accepts every other
coin/timeframe combination.

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
