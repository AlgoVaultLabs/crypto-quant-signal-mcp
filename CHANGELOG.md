# Changelog

All notable changes to `crypto-quant-signal-mcp` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
