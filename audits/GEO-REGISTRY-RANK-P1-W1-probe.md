# GEO-REGISTRY-RANK-P1-W1 — Probe (R1)

**Date:** 2026-06-17 · **Base:** origin/main `b6dccfd` · live probes (no stale-mirror anchors).

## R1a — repo-root `glama.json`
`curl https://raw.githubusercontent.com/AlgoVaultLabs/crypto-quant-signal-mcp/main/glama.json`
→ **HTTP 404 — absent.** The separate `Prompt/glama-server-listing-claim-fix.md` session did NOT
ship it. → **R3 creates it.** (The in-repo `.well-known/glama.json` is the CONNECTOR claim, a
different mechanism — left untouched.)

## R1b — repo-root LICENSE detection
`gh api repos/AlgoVaultLabs/crypto-quant-signal-mcp/license` → **404 Not Found — no LICENSE
detected.** `package.json` `"license"` = **MIT** (already correct). README has a license mention
but GitHub/Glama licensee detection requires a real `LICENSE` file. → **R2 adds standard MIT text.**
This is the installability unblock (Glama: no detected license ⇒ "cannot be installed").

## R1c — GitHub repo About
`gh repo view --json homepageUrl,repositoryTopics`:
- homepage = **`https://algovault.com`** ✓ (ALREADY SET — a prior wave populated it; the 2026-06-04
  audit's "empty" finding is stale).
- topics (11, all accurate): `ai-agents, base, crypto, defi, funding-rate, mcp,
  model-context-protocol, perpetual-futures, trading, trading-signals, x402`.
→ **AC already satisfied** (homepage + ≥6 accurate topics). **R5 = verify + light augment**: add the
two true, high-value suggested topics still missing — `hyperliquid` (default regime venue) + `quant`
(quant signal tool). Existing accurate topics preserved (`--add-topic`, no prune).

## R1d — Glama machine-readable listing state
`curl https://glama.ai/api/mcp/v1/servers/AlgoVaultLabs/crypto-quant-signal-mcp`:
`license=null, quality=null, security=null, installable=null, claimed=null` (listing exists;
nothing assessed). Consistent with the UI "cannot be installed / license F / not tested /
Unclaimed" — the missing LICENSE is the gate. Clears on next sweep after LICENSE + glama.json land.

## R1e — Dockerfile COPY/ADD + deploy paths-ignore
`git show origin/main:Dockerfile | grep '^COPY|^ADD'`: COPYs `package*.json tsconfig.json`, `src/`,
`scripts/build-knowledge-json.mjs`, `audits/`, `landing/integrations/`, `README.md`, `CHANGELOG.md`,
`landing/*`, `scripts/fetchers/`, etc. **Neither `LICENSE` nor `glama.json` is COPYed** → not
runtime. (LICENSE still ships in the npm tarball automatically.) Dockerfile is known-good — prod
rebuilt from it successfully on every deploy, incl. the GEO-REGISTRY-RANK-TDQS-W1 deploy earlier
today (2026-06-17); no build break.

Deploy workflow = `.github/workflows/deploy.yml`. Current `paths-ignore` (narrow — NOT the CLAUDE.md
baseline): `activation-funnel/snapshots/**`, `activation-funnel/README.md`, `ops/systemd/**`,
`ops/monitoring/**`. → **R4 adds `LICENSE` + `glama.json`** so future edits to these non-runtime root
files don't trigger a pointless prod rebuild. (NB: GitHub Actions is currently flagged-off for this
account — push-triggered deploys do not fire at all — so this push triggers no redeploy regardless;
paths-ignore is the durable correctness fix for when Actions re-enables.)

## Scope decision
- R2 LICENSE: **add** (absent). R3 glama.json: **add** (absent). R4 paths-ignore: **add both**.
- R5 About: **already set** → augment topics with `hyperliquid` + `quant` only; verify.
- Out of scope (firewalled to a permission-gated wave): README hero/body (stale off-brand framing +
  volatile counts). The human Glama CLAIM (Mr.1 signs in as AlgoVaultFi → Claim) is the only
  irreducible manual step, gated on glama.json being live.
