# RUNBOOK — Feature Registry (the single Source of Truth for MCP features)

Canonical runbook for the AlgoVault feature registry and its drift canary. Created by
**FEATURE-REGISTRY-SOT-W1** (2026-06-08). North-star: *MCP is the single Source of Truth
for features. Every channel (HTTP API / x402, TG bot, webhook) DERIVES its surface from one
registry, and a drift canary fails the build if any channel falls out of sync.*

---

## The SoT

`src/lib/feature-registry.ts` — `FEATURE_REGISTRY: FeatureSpec[]`, one entry per canonical
tool. Data + types ONLY (imports no runtime handlers → no cycle). Each `FeatureSpec`:

| field | meaning |
|---|---|
| `name` | canonical MCP tool name |
| `aliases[]` | back-compat names that resolve to this feature (e.g. `get_trade_signal` → `get_trade_call`) |
| `channels` | `{ mcp, httpX402, bot, webhook }` booleans — which channels expose it TODAY |
| `botCommand?` / `webhookEvent?` | TG command / webhook event type, if any |
| `quota` | `{ unit, holdFree }` — `per-call` / `per-non-hold` / `per-non-hold-min1` / `rate-limited` |
| `x402` | `{ basePriceUsd, perUnitUsd? }` or `null` (not priced) |
| `descriptionRef` | key into `tool-descriptions.ts` |
| `enabled` | feature flag |

Helpers: `getFeature(nameOrAlias)` (alias→FeatureSpec), `allToolNames()` (canonical + aliases =
the live `tools/list` set), `projectCapabilities()` (public-safe projection, one entry per
callable name; emits ZERO internal fields).

## What derives from it (the channels)

| Channel | Derives | Where |
|---|---|---|
| MCP `server.tool` registration | iterates `allToolNames()` | `src/index.ts` createServer() (CH2) |
| `GET /capabilities` | `projectCapabilities()` | `src/index.ts` (CH2) — the registry's LIVE projection |
| x402 `TOOL_PRICING` | canonical + alias keys from the `x402` column | `src/lib/x402.ts` (CH3) |
| x402 `effectivePrice()` | alias-resolved via `getFeature()` | `src/lib/x402.ts` (CH3) |
| webhook `VALID_EVENTS` | webhook-flagged tools' `webhookEvent` via `webhookEventTypes()` | `src/lib/webhook-api.ts` (FEATURE-PARITY-CHANNELS-W1 CH1) |
| webhook `scan_digest` | scheduled producer scans + delivers per cadence bucket | `src/lib/scan-digest-scheduler.ts` (CH2) |
| TG bot surface | `channels.bot` set → bot-side `BOT_TOOL_SURFACE` map (alert types + `/scan`, `/scanwatch`) | `algovault-bot` `capabilities.py` (CH3/CH4) — A1: command names are bot-side, NOT in `/capabilities` |

### The `get_trade_call` / `get_trade_signal` nuance (READ BEFORE editing x402)

`get_trade_call` (canonical, v1.10.0) and `get_trade_signal` (back-compat alias) are the SAME
handler. Their x402 treatment is deliberately asymmetric and **ratified**:

- **`TOOL_PRICING` carries BOTH** (price-RESOLUTION): a payment proof for either name resolves to
  $0.02 (CH3 closed the canonical-key gap — pre-CH3 only the alias had a key).
- **The GATED + Bazaar-discoverable set is `HTTP_TOOLS` = `get_trade_signal` only** (NOT
  `get_trade_call`): ratified Cowork **A2 (2026-05-29)** — `get_trade_call` is intentionally FREE
  (free-tier generosity) + non-discoverable. The MCP x402 gate keys off `HTTP_TOOLS`
  (`index.ts` `isPricedTool`), NOT `effectivePrice`, so a free caller still calls `get_trade_call`
  for free; the canonical price key only lets a *voluntary* canonical-name proof verify.

⚠️ **Do NOT derive `HTTP_TOOLS` from the registry's canonical `httpX402` names** — that would swap
`get_trade_signal`→`get_trade_call` in the gated set, un-gating the paid tool AND gating the free
one (a non-additive payment-surface break). `HTTP_TOOLS` stays alias-keyed; the canary's STATIC
check enforces parity by ALIAS-RESOLVING it back to the canonical registry set.

---

## The drift canary — `scripts/check-feature-registry-drift.mjs`

Two complementary modes (each checks what its execution context can reach):

| Mode | Network | Asserts | Used by |
|---|---|---|---|
| `--check` | none (imports dist) | (1) projection names == `allToolNames()`; (2) `TOOL_PRICING` derives canonical+alias, unpriced absent; (3) `HTTP_TOOLS` alias-resolved == registry `httpX402`; (4) projection leaks no internal fields; (5) webhook `VALID_EVENTS` == registry webhook-flagged `webhookEvent` set (FEATURE-PARITY-CHANNELS-W1 CH5; `/capabilities` omits `webhookEvent` per A1, so the webhook-event parity lives in `--check`, not `--live`) | CI pre-deploy gate (`deploy.yml`), `prepublishOnly`, `npm run registry:drift:check` |
| `--live <baseUrl>` | HTTP only (dist-free) | (A) live `tools/list` (3-step handshake) == `/capabilities` names; (B) each live `/x402/<tool>` 402 price == `/capabilities` x402 price (404 = priced-but-not-gated canonical, skipped) | weekly host cron, post-deploy verify |

Flags: `--alert` (with `--live`) feeds the contract body to `send_telegram.sh` on confirmed drift;
`--simulate-drift` injects a ghost tool (`--live`) or a ghost webhook event (`--check`) to prove detection (non-destructive). The bot has its own by-construction parity test (`algovault-bot` `tests/test_capabilities_parity.py`): its registered command surface must cover the `/capabilities` bot-flagged set.

**Exit codes:** `0` in-sync OR fail-open (unreachable); `1` drift; `2` fatal (bad usage / dist
missing in `--check`).

**Fail-open:** in `--live`, a network/unreachable error logs + exits 0 (never pages on a blip).
Only a REACHABLE-but-mismatched surface is drift.

### CI gate (wired)

- `.github/workflows/deploy.yml` runs `node scripts/check-feature-registry-drift.mjs --check` after
  the `build_landing --check` guard (dist built earlier in the job) — blocks a bad push BEFORE the
  SSH-deploy.
- `prepublishOnly` runs `--check` before any `npm publish`.

### Host cron (LIVE, weekly, off-`:00`)

Runs on the Hetzner host (so it can reach `send_telegram.sh`). The `--live` mode is dist-free, so
it needs only node + network. Weekly, off-`:00`, non-colliding with website-drift (Mon 12:00) and
pg-maint (1st 04:23):

**✅ INSTALLED 2026-06-08** (root crontab on `204.168.185.24`; host node = `/usr/bin/node` v20.20.2)
— targets the container's published loopback port `http://localhost:3000` (no TLS/DNS/CF dependency;
the canary checks app-route parity — `tools/list` / `/capabilities` / `/x402` — not the Caddy edge):

```cron
# FEATURE-REGISTRY-SOT-W1 CH4 — weekly registry<->channel drift canary
37 5 * * 1 cd /opt/crypto-quant-signal-mcp && /usr/bin/node scripts/check-feature-registry-drift.mjs --live http://localhost:3000 --alert >> /var/log/algovault-monitoring-feature-registry-drift.log 2>&1
```

(For an EXTERNAL-path variant that also exercises Caddy/CF, swap the target for
`https://api.algovault.com` — but loopback is preferred for a parity canary, since a CF/TLS blip
should not fail-open-silence a real registry drift.)

If host node is ever removed, run the LIVE check via the container's node and pipe a drift to the
host wrapper (the container cannot reach the host `send_telegram.sh` path itself):

```cron
37 5 * * 1 docker exec crypto-quant-signal-mcp-mcp-server-1 node scripts/check-feature-registry-drift.mjs --live http://localhost:3000 >> /var/log/algovault-monitoring-feature-registry-drift.log 2>&1 || /opt/algovault-monitoring/send_telegram.sh FEATURE_REGISTRY_DRIFT CRITICAL_PERSISTENT - <<< "$(tail -20 /var/log/algovault-monitoring-feature-registry-drift.log)"
```

---

## Responding to a `🛑 FEATURE_REGISTRY_DRIFT` alert

The alert names the drifted surface(s). The fix is always **at the registry generator**, never the
lane:

1. `git pull` + read the alert's mismatch lines (`tools/list MISSING ...`, `/x402/<t> price ... != ...`).
2. Reconcile the **registry** (`src/lib/feature-registry.ts`) and the channel:
   - A tool appears in one but not the other → add/remove the `FeatureSpec` (registration + projection auto-follow).
   - An x402 price mismatch → fix the registry `x402.basePriceUsd` (TOOL_PRICING auto-derives).
   - A gated-route mismatch → reconcile `HTTP_TOOLS` (remember the alias-keying for `get_trade_call`).
3. `npm run registry:drift:check` (must rc=0) + `npm test` (x402 suite + `feature-registry` + `x402-registry-derive`).
4. Commit → push → deploy → `node scripts/check-feature-registry-drift.mjs --live https://api.algovault.com` rc=0.
5. The alert's `OPS-FEATURE-REGISTRY-DRIFT-W{NEXT}` template resolves at send-time from status.md; close the loop with a status.md GREEN entry of that wave class so the next fire's cooldown/resolver stays accurate.

The alert obeys the standard `send_telegram.sh` contract: severity `CRITICAL_PERSISTENT` only, 24h
cooldown per `alert_id`, fail-open, `DRY_RUN_TG` for smokes.

---

## Adding / changing a feature (the one-place edit)

Edit `FEATURE_REGISTRY` only. MCP registration, `/capabilities`, and (for priced features)
`TOOL_PRICING` + `effectivePrice` all derive automatically. The canary fails CI if you forget a
companion surface (e.g. a new gated route's `HTTP_TOOLS` entry, or a `BAZAAR_ROUTES` declaration).
Pricing a deferred feature (scanner/equity, currently `x402:null`) = set its `x402` object; for a
NEW gated/discoverable route also add the `HTTP_TOOLS` entry + a `BAZAAR_ROUTES` spec.

**Tests:** `tests/feature-registry.test.ts` (registry == reality), `tests/x402-registry-derive.test.ts`
(CH3 derive parity + the A2/A3 invariants), the full `tests/x402-*.test.ts` suite.
