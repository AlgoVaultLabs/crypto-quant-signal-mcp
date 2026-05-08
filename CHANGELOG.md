# Changelog

All notable changes to `crypto-quant-signal-mcp` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.10.8] - 2026-05-08 — Telegram bot launch + per-user attribution loop

### Added

- **`/api/bot/validate-key` (server-internal HTTP).** New `GET` endpoint
  at `src/index.ts` returns `{valid, customer_id, tier}` for a Stripe-
  backed API key. Two-flag firewall via the existing internal-bypass env
  (`BOT_INTERNAL_BYPASS_ENABLED` outer + `X-AlgoVault-Internal-Key`
  header matching `ALGOVAULT_INTERNAL_BYPASS_KEY` inner). Consumed
  exclusively by the public Telegram bot
  (`github.com/AlgoVaultLabs/algovault-bot`) over loopback. **NOT
  exposed via the MCP transport** — `tools/list` still returns 3 tools
  (`get_trade_call`, `scan_funding_arb`, `get_market_regime`).
- **`/welcome` page deep-link button.** Post-Stripe-checkout, the
  welcome page now shows a "📱 Connect @algovaultofficialbot" button
  that opens `https://t.me/algovaultofficialbot?start=auth_<api_key>`.
  One click binds the user's Telegram chat to their subscription;
  bot-side tier-aware quota gate honors paid tiers (no 100/mo cap on
  the bot for Starter/Pro/Enterprise).
- **`tier: 'internal'` 4th license tier.** Recognized via the
  `X-AlgoVault-Internal-Key` header (`src/lib/license.ts`). Quota
  counter is bypassed (no tick); `request_log.license_tier` records
  `'internal'` and the new `is_bot_internal` boolean column for
  attribution. 10 vitest cases in `tests/license-internal-bypass.test.ts`.
- **`request_log.is_bot_internal BOOLEAN`** column. Idempotent
  `ALTER TABLE ADD COLUMN IF NOT EXISTS` migration in
  `src/lib/analytics.ts` for both Postgres and SQLite backends; existing
  rows default to false.
- **`src/lib/bot-auth.ts`** (NEW). `checkBotInternalAuth(headers)`
  helper for server-internal `/api/bot/*` endpoints. 8 vitest cases.
- **`src/lib/welcome-page.ts`** (NEW). Extracted `getWelcomePageHtml`
  from `src/index.ts` — pure module, importable in tests without
  triggering `app.listen(port)`. 5 vitest cases for button rendering +
  URL encoding + DOM ordering.

### Changed

- **`monitor.js` consecutive-fail tracking** + 4× exp-backoff on
  exchange health checks. Suppresses transient-blip alert spam
  (1-cycle outages) while keeping persistent-failure escalation
  intact. (Shipped 2026-05-05, included in this release tag.)

### Notes

- Public response shape, MCP tool list, and free-tier behavior
  unchanged from v1.10.6 / v1.10.7.
- Companion bot repo: `github.com/AlgoVaultLabs/algovault-bot` (BOT-W1
  + BOT-W2). Not bundled with this npm package — discovered via the
  `/welcome` button or directly at
  [@algovaultofficialbot](https://t.me/algovaultofficialbot).
- `BOT_INTERNAL_BYPASS_ENABLED` + `ALGOVAULT_INTERNAL_BYPASS_KEY` env
  vars are deployment-side; not required for `npx`-installed stdio
  usage of this package. Server-side defaults to `false` so the new
  endpoints are inert unless explicitly enabled.

## [1.10.7] - 2026-05-06 — README hero refresh + track-record image embed

### Changed

- README hero rebuilt around the live track-record image
  (`docs/screenshots/track-record-2026-05-06.png`, 2468×528 PNG, 90.0% PFE
  Win Rate across 74,733 trade calls, 26 Merkle batches anchored on Base
  L2). New `algovault.com` + `algovault.com/track-record` links surfaced
  prominently. Snapshot KPI line uses `<span data-tr-field="…">` tags so
  `algovault.com` can live-replace; npm renders the snapshot value as-is.
- Snapshot baseline refreshed from prior `89.4%+` / `60,000+` / `v1.10.3`
  to current `90.0%` / `74,733` / `v1.10.7`. All snapshot lines marked
  `<!-- SNAPSHOT-LINE -->` for future refetch.
- Documentation-only release. No API, schema, or tool changes.
  `_algovault.version` envelope bumps to `1.10.7`. Public response shape
  unchanged. Free-tier behavior unchanged.

## [1.10.6] - 2026-05-02 — README link fix (npm view 404s)

### Fixed

- All 28 relative-path links in README.md (Integrations + Skills tables) now
  point to absolute URLs at `https://github.com/AlgoVaultLabs/algovault-skills/blob/main/...`.
  Previous relative paths (`docs/integrations/<exchange>.md`,
  `examples/<exchange>/demo.mjs`, `skills/<slug>/SKILL.md`) resolved to 404s
  on both GitHub (the files live in the `algovault-skills` repo, not this
  one) and on npmjs.com (npm renders relative links against
  `https://www.npmjs.com/package/<pkg>/<rel>`). Display text unchanged —
  the rendered tables look identical; only the click-target URLs are fixed.
- No code or API changes; metadata-only patch release.

## [1.10.5] - 2026-04-30 — Shadow-seed 1m + 3m + grid re-sizing

### Added — Shadow-mode 1m + 3m signal seeding

- New cron entries for 1m (every minute, top-5 by call-count universe) and
  3m (every 3 minutes, top-20 universe) signals. Signals land in the
  `signals` table and accrue PFE/MAE outcomes via the existing backfill
  pipeline. The eval window for both is "12 candles" (12 minutes for 1m,
  36 minutes for 3m), matching the established `≤15m → 12 candles` rule.
- Shadow-mode filter on `/api/performance-public.byTimeframe`: 1m and 3m
  keys are stripped from the response unless the env flag
  `SHADOW_REVEAL_TIMEFRAMES` (comma-list) explicitly reveals them. After
  2 weeks of accumulation, Mr.1 reviews the data via the Sunday Telegram
  digest and flips the env if the timeframe clears the public-track-record
  bar (PFE WR ≥ 85% AND samples ≥ 3,000).
- New `--restricted-universe N` flag on `seed-signals.ts` + a
  `getRestrictedUniverse(N)` resolver that pulls the top-N coins by
  historical call-count from `byAsset` aggregation. Used by 1m + 3m crons
  to bound CPX22 load.
- New `src/scripts/shadow-digest-weekly.ts` runs Sunday 00:00 UTC, queries
  the prior 7 days of 1m/3m signals, posts a Telegram digest with PFE WR,
  sample size, top/bottom performers per coin, and PASS/FAIL/INSUFFICIENT_DATA
  verdict per timeframe.
- New `docs/SHADOW_SEED_DECISION_RUNBOOK.md` documents the public-flip + rollback
  recipes for after 2026-05-14 decision day.

### Changed — Cross-asset grid re-sized

- `GRID_TIMEFRAMES` re-sized from the v1.9.0 logarithmic ladder
  `['5m', '15m', '1h', '4h']` (24-cell grid) to
  `['1m', '3m', '5m', '15m', '30m', '1h', '2h']` (42-cell grid). Drops 4h
  (rank #6 with 2,124 calls) and adds 1m/3m/30m/2h based on empirical call
  distribution from `byAsset.count` rankings.
- New slow-grid circuit breaker: if 3 consecutive grid refreshes each
  exceed 30s, the breaker opens for 1 hour and the grid temporarily
  collapses to the v1.9.0 fallback set. Telegram WARNING on every trip.
- `GRID_CONCURRENCY` unchanged at 6 (peak ~12 simultaneous HL roundtrips,
  76% rate-limit headroom preserved).

### Changed — Track-record dashboard copy hygiene

- Removed three blocks of stale/redundant copy from the public
  `/track-record` page: (1) the "9 of 11 timeframes / sub-5m noise-dominated"
  disambiguation paragraph (it's premature given the empirical test now
  underway and would be wrong copy if 1m/3m pass), (2) the Methodology
  "Note" paragraph about directional entry calls (redundant with the
  PFE Win Rate definition above it), (3) the first two sentences of the
  bottom italic disclaimer (redundant with the removed Methodology Note);
  the financial-advice + past-performance sentences are preserved verbatim
  for legal cover.

### Tests

- `tests/unit/shadow-seed-restricted-universe.test.ts` (NEW, 7 tests) —
  resolver + cache + fallback behavior.
- `tests/unit/grid-circuit-breaker.test.ts` (NEW, 9 tests) — re-sized grid
  shape + circuit breaker open/close.
- `tests/unit/shadow-mode-filter.test.ts` (NEW, 7 tests) — env-driven
  filter behavior across 1m/3m + non-shadow timeframes.
- `tests/unit/shadow-digest-format.test.ts` (NEW, 6 tests) — digest
  formatter + PASS/FAIL/INSUFFICIENT_DATA verdict thresholds.
- `tests/cross-asset-grid.test.ts` updated — 24-cell expectations re-pegged
  to 42-cell new shape.
- `tests/unit/cross-asset-grid-backoff.test.ts` updated — failure-ratio
  thresholds re-scaled to 42-cell baseline.

### Upgrading

No code changes required. The `byTimeframe` aggregation stays at 9 keys
(5m–1d) until Mr.1 flips the public reveal env. Existing MCP clients
calling `get_trade_call` for 1m or 3m have always worked (the API enum
already accepted them); the only change is that those calls will now
warm faster on top-5 / top-20 assets via the new grid.

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
