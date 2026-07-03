# SUBMIT — punkpeye/awesome-mcp-servers (Finance & Fintech)

**Status:** 🟢 **SUBMIT THIS WEEK** (1 of ≤2 PRs this ISO week — DEV-CITATION-SURFACES-W1 R4).
**Submitter:** Mr.1, from the brand account (`AlgoVaultFi` / AlgoVaultLabs org) — NOT Code's bot account.
**List:** [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers) · 88.5k★ · the most-cited MCP-server list.

## Why this list (probe results, 2026-06-04)
- **Active:** last merged PR 2026-05-27 (8 days before probe); not archived. Not soft-abandoned.
- **Channel = PR (open):** `CONTRIBUTING.md` = standard fork → edit `README.md` → PR. No auto-close, no staff-only, no in-app form.
- **Exact-fit category:** **💰 Finance & Fintech**. A direct peer (`Octodamus/octodamus-core` — crypto BUY/SELL/HOLD oracle, x402, on-chain) already lives there.
- **Not already listed:** `grep -i algovault` over the live README = 0 hits (2026-06-04).

## The exact entry to add
```
- [AlgoVaultLabs/crypto-quant-signal-mcp](https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp) 📇 ☁️ 🏠 🍎 🪟 🐧 - Composite crypto trade verdicts (direction, confidence, regime) across 5 perp venues. Cross-venue funding-rate arbitrage; on-chain Merkle-verified track record. Free tier. `npx crypto-quant-signal-mcp`
```
- Emoji legend (from the list's `## Legend`): 📇 = TypeScript/JS · ☁️ = Cloud Service (remote MCP at `api.algovault.com/mcp`) · 🏠 = Local Service (`npx` stdio) · 🍎🪟🐧 = macOS/Windows/Linux.
- **Forward-stable:** no %, no asset counts (drift-proof). "5 perp venues" matches the approved base blurb.

## Where it goes
Section **`### 💰 Finance & Fintech`** (anchor `#finance--fintech`). The CONTRIBUTING asks for alphabetical order by `owner/name`; `AlgoVaultLabs/…` sorts near the top (before `Logitale/…`). The live section isn't strictly sorted, so: **insert at the top of the Finance & Fintech list, or in alphabetical position — either is accepted in practice.**

## Click-by-click (Mr.1)
1. While signed in as **AlgoVaultFi**, open <https://github.com/punkpeye/awesome-mcp-servers> → **Fork** (to AlgoVaultLabs or AlgoVaultFi).
2. In the fork, edit `README.md` → find `### 💰 <a name="finance--fintech"></a>Finance & Fintech`.
3. Add the entry line above as the first item under that heading (or in `AlgoVaultLabs` alpha position). Match the existing 2-space/`- ` formatting exactly.
4. Commit to a branch `add-algovault-mcp` with message: `docs: add AlgoVaultLabs/crypto-quant-signal-mcp to Finance & Fintech`.
5. Open a PR against `punkpeye/awesome-mcp-servers:main`.

## PR title + body
**Title:** `Add crypto-quant-signal-mcp (AlgoVault) to Finance & Fintech`

**Body:**
> Adds **crypto-quant-signal-mcp** to **💰 Finance & Fintech**.
>
> A composite trade-verdict MCP server: one call returns direction, confidence, and regime across 5 perpetual-futures venues, plus cross-venue funding-rate arbitrage. The track record is Merkle-anchored on Base L2 and independently verifiable on-chain.
>
> - Repo: https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp
> - npm: https://www.npmjs.com/package/crypto-quant-signal-mcp (published; actively maintained — see release cadence)
> - Remote MCP: `https://api.algovault.com/mcp` · Local: `npx crypto-quant-signal-mcp`
> - Free tier (100 calls/month); on-chain verifiable track record at https://algovault.com/track-record
>
> Entry is alphabetically placed, format-matched, and carries no drifting numbers. Thanks for maintaining the list.

## ⚠️ REQUIRED: Glama score badge (automated `glama-check` gate)
This list's `github-actions` bot comments on every new-server PR requiring a **Glama score badge** in the entry (its "listing requirement"). **Include the badge in the INITIAL entry** so the gate passes on submission — don't wait for the bot. Format = repo link, then the badge, then the emoji flags:
```
- [AlgoVaultLabs/crypto-quant-signal-mcp](https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp) [![AlgoVaultLabs/crypto-quant-signal-mcp MCP server](https://glama.ai/mcp/servers/AlgoVaultLabs/crypto-quant-signal-mcp/badges/score.svg)](https://glama.ai/mcp/servers/AlgoVaultLabs/crypto-quant-signal-mcp) 📇 ☁️ 🏠 🍎 🪟 🐧 - Composite crypto trade verdicts (direction, confidence, regime) across 5 perp venues. Cross-venue funding-rate arbitrage; on-chain Merkle-verified track record. Free tier. `npx crypto-quant-signal-mcp`
```
- Glama page (301s to this): `glama.ai/mcp/servers/AlgoVaultLabs/crypto-quant-signal-mcp`. **Caveat:** the badge renders a low **0.5** score — Glama can't "install" a *remote* MCP server (the known `qo8ps65foe` "cannot be installed" cosmetic issue). Raising it = add a Dockerfile *on Glama* (separate optional effort). The badge presence, not its score, is what the bot's step-2 checks.
- **History:** the original 2026-06-05 PR ([#7446](https://github.com/punkpeye/awesome-mcp-servers/pull/7446)) omitted the badge → the bot flagged it → badge added 2026-07-03 (commit `9d54ede` on branch `AlgoVaultFi/awesome-mcp-servers-1:patch-2`).

## Maintainer pushback to expect
- **"Alphabetical order."** If they ask, move the line to strict `owner/name` position.
- **High PR volume (~100+ open).** Merges can take days–weeks; this is normal for an 88k-star list. Do not bump.
- **"Is it real / maintained?"** Point to the npm release cadence + the live on-chain track record.
