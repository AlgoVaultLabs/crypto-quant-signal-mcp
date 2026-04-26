# Plausible Custom Goals — LLM Referrer Tracking (GEO)

WEBSITE-REFRESH-W1 C7 ships the GEO foundations (`llms.txt`, AI-crawler allowlist, Schema.org markup, quotable Claim blocks). Plausible's pageviews + outbound clicks track automatically. The 2 custom goals below need **one-time configuration** at <https://plausible.io/algovault.com/settings/goals> (~2 min total) to start measuring AI-driven conversion from day 1.

This is separate from `docs/PLAUSIBLE_EVENTS.md` (which covers the in-page conversion funnel). These goals catch **upstream attribution** — when a user lands on algovault.com after asking ChatGPT/Claude/Perplexity/Gemini about AI trading agents, we want to know.

## Goal 1 — "AI Referrer (Direct Land)"

**Type:** Pageview filtered by referrer host

**Plausible config:**
- Settings → Goals → New Goal → **Pageview**
- Goal name: `AI Referrer (Direct Land)`
- Page URL: `*` (any page)
- **Referrer filter:** matches `*chatgpt.com|*chat.openai.com|*claude.ai|*perplexity.ai|*gemini.google.com|*copilot.microsoft.com|*you.com|*duckduckgo.com|*kagi.com`

**What it measures:** Sessions that arrive on algovault.com from an AI search/chat engine. Sets the baseline conversion funnel for AI-attributed traffic.

## Goal 2 — "AI Campaign UTM"

**Type:** Pageview filtered by UTM source

**Plausible config:**
- Settings → Goals → New Goal → **Pageview**
- Goal name: `AI Campaign UTM`
- Page URL: `*`
- **UTM filter:** `utm_source` matches `ai-overview|chatgpt|claude|perplexity|gemini|copilot`

**What it measures:** Tagged-link clicks from any future AI-specific marketing campaigns we run (cross-posts to AI-focused communities, sponsored prompts in AI tools, etc.). Differentiates from organic AI referrers (Goal 1).

## Why both goals?

- Goal 1 captures **organic** — users who got an AI-rendered answer that mentioned AlgoVault and clicked through. This is the GEO win condition (we got cited).
- Goal 2 captures **paid/intentional** — outbound campaigns we run targeting the AI surface. Lets us measure ROI on those campaigns separately from organic citation.

## Verification

After configuration, test by:

1. Open <https://plausible.io/algovault.com> live view.
2. In a separate browser tab, visit `https://algovault.com/?utm_source=chatgpt&utm_medium=test&utm_campaign=geo-goal-test`.
3. Confirm the pageview registers + the `AI Campaign UTM` goal fires within 10 seconds.

Or for Goal 1: open algovault.com from a chat with an AI tool (ChatGPT desktop client, claude.ai chat panel) — the referrer should match the Goal 1 filter.

## Reporting cadence

- Weekly: review `AI Referrer (Direct Land)` totals + landing page distribution. Identify which AI tool drives most traffic.
- Monthly: cross-reference with Schema.org Rich Results test (`https://search.google.com/test/rich-results?url=https://algovault.com/skills`) to validate that the structured data we ship for citation is being indexed.

## See also

- `docs/PLAUSIBLE_EVENTS.md` — 4 in-page conversion funnel events (Signup Click / Plan Selection / Skill Install Click / Integration View).
- `landing/llms.txt` + `landing/llms-full.txt` — the canonical entry points AI crawlers consume to understand AlgoVault's offering.
- `landing/robots.txt` — explicit allowlist for 30+ AI crawlers across US/Western/Chinese vendors.
