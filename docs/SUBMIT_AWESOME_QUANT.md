# SUBMIT — wilsonfreitas/awesome-quant (Trading & Backtesting)

**Status:** 🟢 **SUBMIT THIS WEEK** (2 of ≤2 PRs this ISO week — DEV-CITATION-SURFACES-W1 R4).
**Submitter:** Mr.1, from the brand account (`AlgoVaultFi` / AlgoVaultLabs org).
**List:** [wilsonfreitas/awesome-quant](https://github.com/wilsonfreitas/awesome-quant) · 26.6k★ · the canonical quant-tooling list (T2 algo-trader audience).

## Why this list (probe results, 2026-06-04)
- **Active + fast-merging:** last merged PR 2026-05-30 (5 days before probe); only ~13 open PRs / 28 open issues+PRs → low backlog, quick reviews.
- **Channel = PR (open):** standard fork → edit `README.md` → PR.
- **Audience = the T2 beachhead:** quant/algo traders. Hosted/commercial entries already exist (`DeepAlpha` → deepalphabot.com, `QuantOracle` → quantoracle.dev), so a hosted signal API is in-bounds.
- **Not already listed:** 0 `algovault` hits in the live README (2026-06-04).

## The exact entry to add
```
- [AlgoVault](https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp) - `TypeScript` - MCP server returning composite crypto trade verdicts (direction, confidence, regime) across 5 perpetual-futures venues, with cross-venue funding-rate arbitrage and an on-chain Merkle-verified track record. Free tier.
```
- Format matches the list: `- [Name](url) - \`Language\` - description.` Language tag `` `TypeScript` `` (most entries are `Python`; TS is accurate here).
- Library-shaped, non-promotional, no drifting numbers.

## Where it goes
Section **`## Trading & Backtesting`** (anchor `#trading-backtesting`). The subsection adds **newest entries at the top** (current order: `income-desk`, `AI Quant Agents`, `TradeSight`, …, not strict alpha). **Insert as the first bullet under `## Trading & Backtesting`.**

## Click-by-click (Mr.1)
1. Signed in as **AlgoVaultFi**, open <https://github.com/wilsonfreitas/awesome-quant> → **Fork**.
2. Edit `README.md` → find `## Trading & Backtesting`.
3. Add the entry line as the first bullet under that heading. Match the `- [..](..) - \`Lang\` - ..` punctuation exactly (note the trailing period).
4. Commit to branch `add-algovault`: `Add AlgoVault to Trading & Backtesting`.
5. Open a PR against `wilsonfreitas/awesome-quant:main`.

## PR title + body
**Title:** `Add AlgoVault to Trading & Backtesting`

**Body:**
> Adds **AlgoVault** (`crypto-quant-signal-mcp`) to **Trading & Backtesting**.
>
> An MCP server that returns composite crypto trade verdicts — direction, confidence, and market regime — across 5 perpetual-futures venues, plus cross-venue funding-rate arbitrage. Built for AI agents and quant workflows; the protocol is the API (no SDK).
>
> What makes it list-worthy:
> - **Real install base + active maintenance** — published on npm with a regular release cadence: https://www.npmjs.com/package/crypto-quant-signal-mcp
> - **Verifiable track record** — every call is Merkle-anchored on Base L2 and independently checkable on-chain: https://algovault.com/track-record
> - **Free tier** — 200 calls/month (100/day), no card.
>
> Repo: https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp · format-matched, no drifting numbers. Thanks!

## Maintainer pushback to expect
- **"Is this open-source or a hosted service?"** It's an open MCP server (MIT, `npx`-runnable) with an optional hosted endpoint — same shape as the existing `DeepAlpha`/`QuantOracle` hosted entries.
- **"Language tag?"** TypeScript is correct (Node/`@modelcontextprotocol/sdk`).
- **Curation bar.** This list is more selective than the MCP lists — lead with the verifiable track record + npm cadence, keep the blurb factual (done).
