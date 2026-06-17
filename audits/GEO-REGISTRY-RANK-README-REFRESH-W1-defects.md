# GEO-REGISTRY-RANK-README-REFRESH-W1 — R1 Probe & Defect Inventory

**Probed:** 2026-06-17 · **Base:** worktree off `origin/main` (`82baa6d`) · **Branch:** `ops/geo-registry-rank-readme-refresh-w1`
**Status:** ✅ **R1 HALT resolved (architect A1–A4, 2026-06-17) → 2-line forward-stability fix APPLIED in worktree; grep-gate GREEN.** Awaiting Mr.1 README eyeball before R7 push.

---

## TL;DR

The live `origin/main` `README.md` is **already ~95% on-brand**. The prompt's defect inventory describes an **older README snapshot** (the Glama-rendered / vault-mirror copy the prompt itself warned was stale). Every quoted "offending line" in the spec is **absent** from live source. Two of the AC's three required proof mechanisms (the two canaries) **do not exist / do not target the README**. The genuine remaining work is **2 prose lines** (a venue count + a timeframe count). Surfacing per FACTUALITY LAW + Plan-Mode `≥3 fictional → HALT` + `≥3 grep-mismatch → HALT`.

---

## A. Drift table — prompt-claimed defect vs. live `origin/main` reality

| # | Prompt claim (quoted) | `grep -n` against live README | Verdict |
|---|---|---|---|
| 1 | Hero = "The **call intelligence layer** for AI trading agents" | **0 hits.** Live hero (L10) = "AlgoVault is the **brain layer** for AI trading agents…" | ❌ already canonical |
| 2 | "intelligence layer" / "powerful" / "seamless" / "robust" / "cutting-edge" present | `grep -niE` → **0 occurrences** | ❌ already clean (AC#1 met) |
| 3 | "290+ assets" ×4 | **0 hits** (`290` absent). Pricing table says "All 740+" (firewalled, snapshot-line) | ❌ not present |
| 4 | "three exchanges (HL, Binance, Bybit)" | **0 hits.** Integration table already lists Binance / OKX / Bybit / Bitget | ❌ already current |
| 5 | "90%+ directional accuracy across 900+ trade calls" | **0 hits** (`900`, `accuracy` absent) | ❌ not present |
| 6 | "~84% HOLD" | **0 hits.** HOLD rate appears once, in a `data-tr-field="hold_rate"` snapshot span (98.9 fallback) | ❌ not present |
| 7 | WR%/accuracy figures baked in prose | `grep -nE '\b\d{2}(\.\d+)?%'` → **0** (all `data-tr-field` spans break digit-`%` adjacency) | ❌ already anchored |

**Conclusion:** all 6 quoted offending strings are fictional against live source → **≥3 grep-mismatch HALT trigger** (CLAUDE.md Plan-Mode rule: `<file>:<line>` → `grep -n`, ≥3 mismatches = HALT).

---

## B. Genuine remaining defects (the ONLY real in-scope work)

Found via the TDQS forward-stability regex `\b\d+\+?\s*(exchanges?|assets?|venues?|timeframes?)\b` + a broader digit-near-capability sweep:

| Line | Live text | Class | Fix |
|---|---|---|---|
| **L10** (hero) | `…returns verdict, confidence, and regime across **5 perp venues**.` | volatile venue count | → `across major crypto perpetual venues` |
| **L172** (Tools intro) | `Every asset works across **all 11 timeframes** (\`1m\` → \`1d\`) on **5 perp venues**.` | volatile timeframe + venue counts | → `across every timeframe from \`1m\` to \`1d\`, on major crypto perpetual venues` |

Rationale: matches the canonical qualitative phrasing TDQS-W1 shipped to tool descriptions ("across major crypto perpetual venues") and satisfies R4 ("no 'three'/'five' hardcoded count that re-goes-stale"). The `1m → 1d` **range** is a fixed param domain (not a volatile count — same exemption the TDQS canary documents for `1-100`), so it is retained.

### Firewall conflict (flag, do NOT fix — R5)
| **L254** ("What's new in v1.20.1") | `…aggregate cross-venue funding sentiment for stocks, indices, commodities, and FX **across all 5 venues**.` | volatile venue count **inside the firewalled release-history section** |

This line matches the volatile-count regex but lives in the **"What's new" section R5 explicitly forbids touching**. No canary actually flags it (forward-stability canary scans only `tool-descriptions.ts`; numerical-fact-density canary does not exist — see §C). Leaving it as-is is consistent with the firewall; flagging for the architect.

### Out-of-AC-scope notes (no change proposed)
- **"Skills (20 …)" (L182/187)** — a skills count, NOT in the AC's enumerated volatile-count set (asset/exchange/timeframe/WR%/accuracy/HOLD%); the table itself is build-injected (`<!-- BUILD:README_SKILLS_TABLE -->`). Left unchanged.
- **`data-tr-field` fallback literals** (pfe_wr 91.3, total_calls 134,276 — live is 91.6 / 243,416) — **auto-injected on deploy** by `scripts/snapshot-landing-data.mjs`; the README's own SoT comment says "Do NOT hand-edit the numbers." Left to the snapshot mechanism (refreshes at next release).
- **Pricing table** ("All 5", "All 740+", "All 11") — firewalled (R5) + snapshot-line-table managed.

---

## C. Fictional / mislocated spec primitives (FACTUALITY)

| Cited primitive | Reality | Resolution |
|---|---|---|
| `lib/check-numerical-fact-density.mjs` (R-context, R7, **AC**) | **Does not exist** — no `lib/` dir; `git log --all` shows it never existed in this repo; absent from every `~/code` clone; not wired in `package.json`. (Also cited in CLAUDE.md as if present.) | **AC unsatisfiable as written.** Need architect call (see Q2). |
| Forward-stability canary "run … against the README" (R-context, AC) | Canary **exists** at `tests/unit/tool-description-forward-stability.test.ts` but imports `src/tool-descriptions.js` and scans **tool-description strings, not the README**. It will pass, but proves nothing about README. | Only its two regexes are reusable; applied them by `grep` (§A/§B). |
| `snapshot-landing-manifest.json` (Method, R1) | Exists at **`scripts/snapshot-landing-manifest.json`** (not repo root). | Minor mislocation — resolved inline. |
| README defect inventory (Objective) | Stale snapshot (see §A). | Re-derived live. |

**Snapshot mechanism (confirmed working for README):** `scripts/snapshot-landing-manifest.json` already routes 4 README claims (`pfe_wr`, `total_calls`, `merkle_batches`, `hold_rate`) via `data-tr-field` spans, injected on every Hetzner deploy + at `prepublishOnly`. The SoT also exposes `exchange_count` / `timeframe_count` / `asset_count` accessors (currently landing-only) — so a snapshot marker for venue/timeframe counts is *technically possible*, but R4 mandates **qualitative** phrasing for capability counts, so §B uses qualitative (no new injected span).

---

## D. Live probes (evidence)

- **`/api/performance-public`** (sanity): `pfeWinRate 0.9159` (91.6%), `totalCalls 243,416`, `hold_rate 98.9`, `exchange_count 5`, `timeframe_count 11`, `asset_count 858`.
- **`tools/list`** (stateless, no session-id): **9 tools** — `get_trade_call`, `get_trade_signal` (alias), `get_market_regime`, `scan_funding_arb`, `scan_trade_calls`, `get_equity_call`, `get_equity_regime`, `chat_knowledge`, `search_knowledge`. `get_trade_call` is the free primary. Equity tools are **live on the wire with public TDQS descriptions**.
- **Tools section alignment (R4):** current README Tools list already leads with `get_trade_call` and mirrors TDQS wording. It **omits the two equity tools** — consistent with the standing "equities = public-copy HOLD" decision from ELIZAOS/LLAMAHUB waves. See Q3.
- **Data integrity:** `grep -niE 'outcome_return_pct|phase[ -]?e'` → **0** in README. PFE WR is the only public win-rate. ✅

---

## E. Architect resolutions (Mr.1, 2026-06-17) + what was applied

- **A1 (scope):** PROCEED with the 2-line fix (do NOT close as already-satisfied). Drop both counts. **Applied:**
  - **L10:** `…across 5 perp venues` → `…across major crypto perpetual venues`
  - **L172:** `Every asset works across all 11 timeframes (\`1m\` → \`1d\`) on 5 perp venues.` → `Every asset works across the full supported timeframe range, on major crypto perpetual venues.`
- **A2 (AC proof):** ACCEPT grep-based proof; `lib/check-numerical-fact-density.mjs` requirement **dropped from AC** (spec error — aspirational CLAUDE.md text, not present in repo). Gate = 3 greps vs `README.md`: (1) forbidden-word, (2) `\b\d+\+?\s*(exchanges?|assets?|venues?|timeframes?)\b`, (3) WR%/accuracy. Do NOT build the fictional canary; do NOT bolt the TDQS canary onto README this wave → **deferred to `OPS-FWD-STABILITY-CANARY-README-W1`** (must skip the "What's new" firewall region — a real design task).
- **A3 (equities):** KEEP equities OUT. `get_equity_call`/`get_equity_regime` are public-copy HOLD (Mr.1 2026-06-08, Databento engine); HOLD overrides R4's "align to tools/list" (= crypto/public subset only). **No equity tools added.** Tools section already leads with the free primary `get_trade_call` + mirrors TDQS wording — no bullet changes needed.
- **A4 (firewall):** LEAVE L254 (`"...across all 5 venues"` in "What's new in v1.20.1"). Firewall wins; dated historical entry, self-ages-out on the 3-minor window roll. **Flagged for the next RELEASE wave's "What's new" curation** (status.md + this audit). No firewall exception this wave.

### Gate result (post-fix, vs `README.md`)
1. forbidden-word grep → **0** ✓
2. volatile-count regex → only **L254** (firewall-exempt per A4); editable prose **clean** ✓
3. WR%/accuracy regex → **0** ✓
- `git diff` = **2 lines** (L10 + L172); firewall sections byte-unchanged ✓

## F. Side finding — `1m`-enum vs. 3m-latency-floor (FACTUALITY, out of THIS wave's scope)

Architect premise in A1: *"1m signals are rejected on latency, floor = 3m."* But the **live `tools/list` enum advertises `1m`**: `get_trade_call.inputSchema.properties.timeframe.enum = ["1m","3m","5m","15m","30m","1h","2h","4h","8h","12h","1d"]`, and the param `description` says *"Candle timeframe, 1m to 1d."* If the engine truly rejects `1m`, the **TDQS tool-description copy is factually wrong** (advertises an unsupported bound). The chosen README phrasing ("full supported timeframe range") is correct under **either** reading, so README is unaffected — but the `src/tool-descriptions.ts` `timeframe` param desc + the enum itself are a **separate factuality item** for a tool-description/engine wave (out of scope here; README-only). Also noted: `get_trade_call` exchange enum carries **17 venues** (5 only for scan tools) — reinforces qualitative "major crypto perpetual venues".
