# archived/scripts/

Scripts retired from the active codebase. Restore via `git log --follow --diff-filter=D` if needed.

## molthunt-launch.ts.deprecated

**Archived:** 2026-05-16 during ERC-8004-W1 (Plan-Mode Amendment E → D3).

Experimental script for registering an ERC-8004 agent identity on Base mainnet alongside a Molthunt project launch. Predates the canonical ERC-8004-W1 wave.

**Why archived:**
- References a non-existent function `agentIdOf(address)` on the Identity Registry — the canonical IdentityRegistry v2.0.0 ABI (`erc-8004/erc-8004-contracts/abis/IdentityRegistry.json`) only exposes `ownerOf(uint256)` + `balanceOf(address)`. Calls to `agentIdOf` would revert; the script's try/catch swallows the revert and falls through to a duplicate `register(...)`, with no idempotency guard. Re-running would mint a fresh agentId every invocation.
- Used `FACILITATOR_PRIVATE_KEY` (the gas wallet) as the on-chain agent owner. Per Plan-Mode Step 0.D ratification, AlgoVault's canonical ERC-8004 agent identity is owned by the dedicated `ERC8004_AGENT_OWNER_KEY` (Wallet B) — see `src/scripts/register-erc8004-agent.ts`.
- Built a `data:application/json;base64,...` agent URI from a non-canonical metadata shape (`{ name, description, website, github }`) instead of the spec-canonical shape (`{ type, name, description, image, services[], registrations[], supportedTrust[] }`).
- Status.md grep on 2026-05-16 returned **zero** prior executions of this script (`grep -rn 'molthunt' status.md` → 0 hits) — never wired into production.

**Replacement:** `src/scripts/register-erc8004-agent.ts` (idempotent + canonical JSON shape + dedicated owner wallet + Pinata IPFS pinning + `setAgentURI` follow-up to land canonical-complete registrations[] on-chain).

**Restore command (if you ever need the original Molthunt-launch SIWA flow):**
```bash
git log --follow --diff-filter=D -- src/scripts/molthunt-launch.ts
git show <pre-archive SHA>:src/scripts/molthunt-launch.ts > src/scripts/molthunt-launch.ts
```

The SIWA / Molthunt project-creation flow (lines ~141-243 of the archived file) is independent of the ERC-8004 mint and may be useful in a future Molthunt-republish wave; refactor it to import from `src/lib/erc8004.ts` rather than holding its own ABI copy.
