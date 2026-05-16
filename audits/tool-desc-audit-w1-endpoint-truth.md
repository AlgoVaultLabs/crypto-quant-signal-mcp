# TOOL-DESC-AUDIT-W1 — Plan Mode endpoint-truth

**Wave**: TOOL-DESC-AUDIT-W1 (Tier 1 Standard, Single session)
**Risk marker**: 4 — version identifier cited in >1 place
**Probe time**: 2026-05-16
**Code checkout**: `/Users/tank/crypto-quant-signal-mcp/` (HEAD = `b760af1`)

---

## Identifier-diff table

| # | Identifier | R-section value (spec) | AC-section value (spec) | Live source-of-truth probe | Reality | Diff? |
|---|---|---|---|---|---|---|
| 1 | `package.json .version` | `1.13.0` | bump to `1.13.1` | `jq -r '.version' package.json` | **`1.13.1`** | **Y — sibling-wave drift** |
| 2 | `server.json .version` | matches package.json | matches package.json | `jq -r '.version' server.json` | **`1.13.1`** | **Y — sibling-wave drift** |
| 3 | `landing/manifest.json .version` | matches package.json | matches package.json | `jq -r '.version' landing/manifest.json` | **FILE DOES NOT EXIST** | **Y — fictional path** |
| 4 | `CHANGELOG.md` highest entry | `## [1.13.0]` | new `## [1.13.1]` above | `grep -m1 '^## \[' CHANGELOG.md` | **`## [1.13.1] - 2026-05-16`** | **Y — sibling-wave drift** |

---

## Ambiguous-dep flags

### Flag (a) — Code checkout state

| Probe | Result |
|---|---|
| `git status --short` (clean tree?) | **Clean** (no untracked / uncommitted) |
| `git log -3 --oneline` | `b760af1 chore(release): v1.13.1 — republish README from NPM-readme-DRAFT.md SoT` <br> `9379327 chore(deploy): always --force-recreate to defend against env_file race` <br> `6b4c6e4 feat(erc-8004): v1.13.0 — ERC-8004 Verified Agent on Base` |
| Latest tag | `v1.13.1` |
| `git rev-list -n 1 v1.13.0` | `6b4c6e45d05d34c614098838efc9624767e8259a` ✅ matches spec's cited commit |
| HEAD == v1.13.0 tag? | **NO** — HEAD is 1 commit ahead at `b760af1` (the v1.13.1 README republish from ERC-8004-W1) |
| `b760af1` source-file impact | `CHANGELOG.md`, `README.md`, `package.json`, `server.json` only — **NO `src/` changes** |
| Vault `system-map.md` `Last touched` row | Confirms `b760af1` = ERC-8004-W1 / v1.13.1 README republish (no edge mutation) |

**Resolution**: Code's checkout is at the correct rolling tip, NOT at `6b4c6e4`. The spec assumed `6b4c6e4` (v1.13.0) was the latest but a sibling wave moved the world. `b760af1` is a README-only republish — does NOT touch `src/index.ts` tool descriptions, so it does NOT collide with this wave's scope.

### Flag (b) — Live tools/list baseline

| Probe | Result |
|---|---|
| Spec's verbatim probe (`POST /mcp` with `tools/list`, no init) | **`{"error":{"code":-32000,"message":"Bad Request: Server not initialized"}}`** |
| Cause | MCP streamable-HTTP transport requires `initialize` → session-id header → `notifications/initialized` → then `tools/list`. Spec's curl skips the handshake. |
| Working probe (fixed inline) | `POST initialize` → extract `Mcp-Session-Id` header → `POST notifications/initialized` → `POST tools/list` with session header |
| Live tools count | **4** (get_trade_call, get_trade_signal, scan_funding_arb, get_market_regime) |
| Baseline captured | `audits/tool-desc-audit-w1-baseline-tools-list-2026-05-16.json` (8.4 KB) ✅ |

**Live description lengths** (current):
- `get_trade_call`: 236 chars — `Returns a composite BUY/SELL/HOLD trade call for a perpetual on Binance / Hyperliquid / Bybit / OKX / Bitget. Combines RSI(14), EMA(9/21) crossover, funding rate, OI momentum, and volume into a weighted score with confidence percentage.`
- `get_trade_signal`: 341 chars — `[TRADE_CALL_DESCRIPTION] + (Alias for get_trade_call since v1.10.0 …)` suffix.
- `scan_funding_arb`: 148 chars — `Scans cross-venue funding rate differences between Hyperliquid, Binance, and Bybit. Returns top arbitrage opportunities …`
- `get_market_regime`: 192 chars — `Classifies the current market regime (TRENDING_UP, TRENDING_DOWN, RANGING, VOLATILE) for a Hyperliquid perp using ADX(14…)`
  - **Stale claim flagged**: "for a Hyperliquid perp" — but per `src/lib/venue-coverage.ts` the regime classifier supports 5 venues (TIER 1+2). Description does NOT reflect actual coverage.

---

## Spec-vs-reality resolution proposal

Per CLAUDE.md Plan Mode rules: 1 fictional primitive + 2 stale premises = below ≥3 ARCHITECT-HALT threshold. Fix inline + flag in status.md. **Three inline adjustments proposed:**

### Adjustment 1 — Version bump targets `1.13.1 → 1.13.2`, not `1.13.0 → 1.13.1`

**Reason**: `1.13.1` is already shipped (commit `b760af1`, published to npm `2026-05-16`, `curl https://registry.npmjs.org/crypto-quant-signal-mcp | jq -r '."dist-tags".latest'` = `1.13.1`). Per CLAUDE.md WIS `version-bump-sibling-wave-drift-mid-execution`, bump from the live value.

**Impact**: every spec reference to `1.13.1` in R5 / AC6 / AC7 / AC10 / GitHub Discussion title / CHANGELOG entry / X post / dev.to / cache-refresh notice → becomes `1.13.2`.

### Adjustment 2 — Drop `landing/manifest.json` from version-bump sites

**Reason**: file does not exist at the spec-cited path. `find . -name 'manifest.json'` returns only `./manifest.json` (root), which is the LobeHub catalog manifest with its own independent versioning lineage (per CLAUDE.md WIS `lobehub-manifest-version-lineage-is-separate-flag-on-version-bump` — spec explicitly excludes it).

**Impact**: version-bump sites reduce to `package.json` + `server.json` + `CHANGELOG.md` (3 not 4). AC6 amends to drop the `landing/manifest.json` row.

### Adjustment 3 — Verification gate curl uses MCP session-init handshake

**Reason**: spec's `curl … --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` returns "Server not initialized" because MCP streamable-HTTP requires `initialize` → session-id header → `notifications/initialized` → then `tools/list`. Confirmed live.

**Impact**: AC7 / AC8 verification commands replaced with the 3-step session-init pattern (already proven working in baseline capture above). Documented in `audits/tool-desc-audit-w1-endpoint-truth.md` for reuse.

---

## system-map.md edge enumeration (this wave's touch)

Per Plan Mode rule "list every `system-map.md` row that the wave will modify":

- `crypto-quant-signal-mcp` component card → MCP tool descriptions are part of its public surface. **Edge ROW: no change** (descriptions tighten, but the producer→consumer edge to "MCP clients (Claude Desktop / Cursor / Cline)" is unchanged).
- `Last touched` line at top of system-map.md → **bump to `TOOL-DESC-AUDIT-W1`** in same commit (per SYSTEM-MAP-ENFORCEMENT-W1 C2 pre-commit hook freshness window).
- No new component, no removed component, no new external integration, no new producer/consumer edge.

**Final status.md line**: `system-map.md updated: n-a` (no edge mutation; `Last touched` bump is timestamp-only).

---

## Plan Mode exit gate

Awaiting architect approval token: **`TOOL-DESC-AUDIT-W1 Plan Mode APPROVED. Proceed R2.`**

If approved as proposed, R2 executes against v1.13.1 baseline and bumps to v1.13.2 across `package.json` + `server.json` + `CHANGELOG.md` only.

```
PLAN_MODE_GREEN — identifier diff: 4/4 Y; live baseline captured to audits/tool-desc-audit-w1-baseline-tools-list-2026-05-16.json (4 tools); 3 inline adjustments proposed (version bump → 1.13.2 / drop landing/manifest.json / curl session-init); ready for R2.
```
