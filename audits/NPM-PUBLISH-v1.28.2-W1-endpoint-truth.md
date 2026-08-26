# NPM-PUBLISH-v1.28.2-W1 — Endpoint-Truth (Plan-Mode Step 0)

**Probed:** 2026-08-26 (live `tools/list` · live routes · v1.28.1 tag tree · lockstep gate executed · guardrail regex run over the REAL corpus) · **Verdict:** 🟡 **AMBER — executable as a PATCH, but the Binance-claim AC is UNSATISFIABLE as written** and needs one ruling. 0 fictional primitives. 4 spec premises confirmed exactly; 1 AC falsified.

## Worktree / baseline

`/Users/tank/code/.worktrees/crypto-quant-signal-mcp/npm-publish-v1282` @ `origin/main` **`40eb00f`**, `npm ci` clean.

| Surface | Measured | Spec said | ✓ |
|---|---|---|---|
| `package.json` · `server.json` · `packages[0]` · `manifest.json` · npm `latest` · `/health` | **1.28.1** ×6 | 1.28.1 | ✅ |
| `lobehub-manifest.json` | **28** | 28 | ✅ |
| `v1.28.1..main` | **33 commits · 149 files · 29 `src/`** | 33 / 149 / 29 | ✅ |
| files in the npm `files[]` set touched | **only `README.md`, `+2/−2`** | same | ✅ |
| `/integrations/binance-agent-os` | **200** | 200 | ✅ |

The `+2/−2` is confirmed **entirely injector-owned**: the sole README change across all 33 commits is the SNAPSHOT-LINE `total_calls` literal `134,276 → 508,268` inside already-bound `data-tr-field` spans. **The spec's core premise holds: zero Agent OS content currently reaches an npm, Registry, DXT or LobeHub reader.**

## 🛑 R0.2 — PATCH is CORRECT. Measured, not assumed.

Route sets extracted from `src/index.ts` at the **v1.28.1 tag tree** versus `origin/main`:

| | count |
|---|---|
| routes at `v1.28.1` | **69** |
| routes at `main` | **69** |
| **added** | **0** |
| **removed** | **0** |

Both routes the spec flagged existed at v1.28.1: `get('/contact')`, `post('/contact')`, `get('/account')`, `post('/account/portal')`, `post('/account/recover-key')`, `post('/account/referrals')`, `post('/account/referrals/payout-address')`. No route is registered outside `index.ts` in the range. `CONTACT-ANTISPAM-AND-REPLY-TO-W1` **hardened an existing form**, exactly as the spec suspected. Live: `/contact` 200, `/account` 200.

`tools/list` unchanged and matching the spec's stated shape exactly — 7 tools; `get_trade_call`/`get_trade_signal` 5 params, `scan_trade_calls` 11, `get_market_regime` 3, `chat_knowledge`/`search_knowledge`/`scan_funding_arb` 2; `exchange` enum 15.

**⇒ PATCH v1.28.2. No minor trigger. No HALT on this question.**

## 🛑 R0.3 — the README table is NOT in the lockstep, and the finding is sharper than that

`scripts/check-integrations-registry-lockstep.mjs` enumerates **six** surfaces, and every one is `src/` or `landing/`:

1. `src/lib/integrations-data/exchange-kits.ts` · 2. `scripts/render-integrations.mjs` `EXCHANGES` · 3. `src/index.ts` `INTEGRATION_EXCHANGES` · 4. `landing/integrations/<slug>.html` · 5. `landing/sitemap.xml` · 6. `landing/integrations.html` + `landing/docs.html`

**`README.md` is not among them.** The gate is currently **GREEN** — `[lockstep] exchange-kits=13 render=13 route=13 rendered=25 sitemap=25`, all six agree — and it stays green whether or not the README row is added.

**But the interesting measurement is the set difference:**

| set | count | members |
|---|---|---|
| lockstep kits | **13** | binance, **binance-agent-os**, okx, bybit, bitget, gemini, kraken, alpaca, hyperliquid, aster, bingx, kucoin, gateio |
| README exchange-kit rows | **12** | Binance, OKX, Bybit, Bitget, Hyperliquid, Aster, BingX, KuCoin, Gemini, Kraken, Alpaca, Gate.io |

The README table carries **12 of 13 — every kit except `binance-agent-os`**. `binance-agent-os` is *already* a registered kit on all six gated surfaces; the README is the one surface that never learned about it, and it is the one surface no gate watches. So the row is a **copy choice made here**, not a gate requirement — and adding it restores 13/13 on an ungated surface.

## R0.4 — no fabricated link

| artifact | state |
|---|---|
| `docs/integrations/exchange-kits/binance-agent-os.md` | ✅ committed, 8,058 B |
| `examples/binance-agent-os/` | 🛑 **ABSENT** — `examples/` contains only `governance-handoff` |
| live page | ✅ 200 |

Table shape is `\| # \| Exchange \| Tutorial \| Demo \| Mirror \|`. **The Demo cell must be left empty** — there is no demo to link.

## 🛑 THE ONE RULING NEEDED — the Binance-claim AC is unsatisfiable as written

The AC requires the canonical regex to return **0 across CHANGELOG, README, Discussion and X**. Run over the real corpus, it returns **2**, and **both are pre-existing copy this wave does not author**:

| file | line | text | branch |
|---|---|---|---|
| `README.md` | **:134** | *"…every **official** exchange Agent Trade Kit — no SDK, no wrapper."* | `\bofficial\b` |
| `CHANGELOG.md` | **:444** | *"OKX announced ICE **partnership** for tokenized NYSE stocks targeting H2 2026"* — under `## [1.11.0] - 2026-05-15` | `\bpartner` |

Neither is a claim about AlgoVault and Binance. The README line describes **exchanges' own** official kits (true, and it is the sentence that introduces the very table this wave edits). The CHANGELOG line is a **third-party market-news note about OKX and ICE**, in a historical release entry from May.

**The spec's own drafted blocks are clean** — boundaried **0**, unboundaried **1** (the `algovaultofficialbot` CTA), exactly as the spec predicted. The `\b` fix is verified correct. The spec ran the grep against its own copy but not against the incumbent corpus, which is the same omission it warns about one paragraph earlier.

Satisfying the AC literally would require editing correct pre-existing README copy **and rewriting CHANGELOG history**, which is an append-only record.

## Classification — re-derived from `status.md` (2026-08-24 06:56 → now)

**EXTERNAL (2):**

| Wave | Placement |
|---|---|
| `BINANCE-AGENT-OS-TRUTH-AND-PAGE-W1` + `-GEO-AND-SUBMISSIONS-W2` — the **pairing** only | README row + nested recap + CHANGELOG + Discussion + X |
| `CONTACT-ANTISPAM-AND-REPLY-TO-W1` | CHANGELOG `### Fixed` only |

**`EXTERNAL-SURFACE-PARITY-W1` → INTERNAL** (the spec left this to me). All three chapters are gate machinery: CH3 `82a20f8` = a published-surface registry + canary + test; CH1 `ccae861` = widening `check-claim-coverage.mjs` + a ratchet file; CH2 `9c7dce5` = binding frozen numbers to producers. Its only `README.md` touch is the injector-owned `total_calls` refresh above — a number the `39 0 * * *` cron would have rewritten anyway. **No user-visible surface changed**, so no CHANGELOG line.

**INTERNAL (19 further waves)** — `OPS-DETECTOR-ENVELOPE-RUNTIME-W1`, `OPS-HOLD-DECISION-CAPTURE-W1`, `OPS-DIGEST-MERKLE-ANCHOR-W1`, `EDGE-SELL-RESOLUTION-ASYMMETRY-W1`, `EDGE-DWR-REFRESH-W1`, `AOE-RETUNE-IDEMPOTENCY-W1` ×2, `AOE-GATE-CANDIDATE-ARM-W1` ×2, `AOE-CELL-DEFINITION-W1`, `OPS-AOE-APPROVED-QUEUE-W1`, `OPS-AOE-APPROVED-CAUSE-RENDER-W1`, `OPS-AOE-DEPLOY-CONFIRM-W1`, `OPS-AOE-DIGEST-DWR-W2`, `OPS-X402-SETTLEMENT-RECONCILER-W1`, `OPS-REACHABILITY-AND-XREPO-INSTALL-W1` (+ ADDENDUM), `OPS-SOT-PARITY-PHASE-AND-NOTIFY-RECORD-W1`, and both `BINANCE-AGENT-OS-*` waves' internal mechanics. This status entry is their only release record.

_(`EDGE-CARRY-TURNOVER-BENCHMARK-W1` at 05:55 predates the v1.28.1 publish at 06:56 and is outside the window.)_

## R0.5 / R0.6 / R0.7

- **HELD + guardrail pre-grep on every drafted block:** HELD set **0** · venue count **0** · internal wave IDs **0** · PR#254 / skills-hub / fork **0** · Binance-claim regex (boundaried) **0**.
- **JWT:** no token file present — must `logout && login github` at R5a, publish within seconds.
- **Identifier diff:** `1.28.2` appears **0 times** in all six target files; tag `v1.28.2` does not exist. No mismatch, no HALT.

## Summary

The spec is accurate on every anchor it re-probed, and its two riskiest questions both resolve cleanly: **PATCH is right** (69→69 routes, zero added) and **no link needs fabricating** (the demo is genuinely absent). R0.3 is more useful than expected — `binance-agent-os` is already a registered kit on all six gated surfaces, and the README is the single ungated surface that omits it, which is precisely why this row is the durable lever.

The one blocker is the AC's own guardrail: measured against the real corpus it can never return 0, because two pre-existing and factually correct sentences match it. That needs an architect ruling before I write any public copy.
