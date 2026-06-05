# SUBMIT — Crunchbase (claimed Organization profile = the entity anchor)

**Status:** 🟡 **READY FOR OPERATOR** (ENTITY-FOOTPRINT-W1 R2). Free, self-serve, **instant publish**. ~20 min.
**Submitter:** Mr.1 (real person account — see decision flag). Public profile stays **brand-only** (the account is not shown publicly).
**Portal:** <https://www.crunchbase.com/add-new> (after registering + social-auth).
**Outcome:** a logged-out-visible `crunchbase.com/organization/<slug>` page with JSON-LD → Google-visible entity anchor + the future Wikidata P2088 source. Then flip `crunchbase` in `landing/_jsonld/entity-urls.json`.

> ⚠️ **DECISION FLAG 1 — private real-identity verification (needs Mr.1's explicit OK).**
> Crunchbase requires registering + **social-authenticating with a PERSONAL LinkedIn or Google account** ("use your own social media as opposed to your company's"). The *public* profile remains brand-only — the personal account is the private verifier, never shown publicly. This satisfies "brand-handle-only publicly" but uses a personal identity privately. **Do not proceed until Mr.1 confirms.**

> ⚠️ **Crunchbase robots.txt blocks ALL AI crawlers** (GPTBot / OAI-SearchBot / PerplexityBot / …). The value here is the **Google-visible entity anchor + future Wikidata P2088 identifier**, NOT a direct LLM-corpus feed. Set expectations accordingly.

---

## Why Crunchbase (probe results, 2026-06-05)
- **Entity anchor:** a claimed Crunchbase org is the single most-referenced free company record on the open web; it seeds Google's Knowledge Graph and is the canonical `P2088` source for a future Wikidata item.
- **Free + instant:** self-serve creation publishes immediately; claiming ("Manage My Company") is a separate verification step.
- **No reviews, no waitlist:** unlike G2/G2DM, there is no editorial queue — the page is live on save.

## Pre-flight (confirm before starting)
1. **Search first** — <https://www.crunchbase.com/textsearch?q=AlgoVault> — to confirm no existing/auto-created record. If one exists, **claim it** (Manage My Company) instead of creating a duplicate.
2. **Logo** ready: the square mark at `https://algovault.com/logo.png` (Crunchbase wants a clean square; PNG ≥ 200×200).
3. **Claim email:** `admin@algovault.com` — the domain MUST match the website (`algovault.com`) for "Manage My Company" verification.
4. **Founder:** AlgoVault operates pseudonymously → **do NOT add a Person/founder** (mirrors the Wikidata `OMIT P112` decision). A company-only record is fine.
5. **HQ:** only enter a location you're comfortable disclosing (the registered jurisdiction). If none is public, leave it region-level or blank — **do not fabricate a city.**

---

## Approved copy (paste-ready — traces to brand-facts.md; "call" not "signal" per the public-prose rule)

**Short description / tagline** (one sentence):
```
AlgoVault Labs develops an MCP (Model Context Protocol) server that provides composite trade-call interpretation for AI agents across cryptocurrency derivatives venues.
```

**Full description** (~115 words — neutral, objective, software/API company; Crunchbase strips ad-copy and anything resembling crypto-scam promotion, so there are no adjectives or numbers here):
```
AlgoVault Labs is a software company building API infrastructure for AI trading agents. Its primary product is an MCP (Model Context Protocol) server that returns a single composite trade call — direction, confidence, and market regime — by combining multiple quantitative factors across cryptocurrency perpetual-futures venues, instead of exposing raw indicators. The same API provides market-regime classification and cross-venue funding-rate comparison. Every trade call is recorded on-chain, Merkle-anchored on the Base network, so the published track record can be independently verified rather than taken on trust. AlgoVault is available over remote HTTPS, as a local stdio server, and through MCP registries, with a free tier and usage-based paid plans. Packages are published on npm and the source organization is on GitHub.
```

**Structured fields:**
| Field | Value |
|---|---|
| Organization name | `AlgoVault Labs` |
| Website | `https://algovault.com` |
| Founded | `2026` |
| Operating status | `Active` |
| Company type | `For Profit` |
| Industries (3–5; include software + fintech) | `Software`, `FinTech`, `Artificial Intelligence`, `Cryptocurrency`, `API` |
| Social — X/Twitter | `https://x.com/AlgoVaultLabs` |
| Social — GitHub (add as a link) | `https://github.com/AlgoVaultLabs` |
| Logo | `https://algovault.com/logo.png` |

---

## Click-by-click (Mr.1)
1. **Register** at crunchbase.com → verify email.
2. **Social-authenticate** with a **personal** LinkedIn or Google account (decision flag 1).
3. Open **<https://www.crunchbase.com/add-new>** → choose **Organization**.
4. Fill: name `AlgoVault Labs`, website `https://algovault.com`, founded `2026`, logo upload, the **short** description, then the **full** description, industries (table above), X + GitHub links, HQ (only if comfortable).
5. **Save** — the page publishes instantly. Note the URL form `crunchbase.com/organization/<slug>`.
6. **Claim it:** profile menu → **Manage My Company** → verify with `admin@algovault.com` (domain-match). Approval can take 1–2 days; the page is already public meanwhile.
7. **Record the permalink** (`/organization/<slug>`) and send it to Code (or paste into status.md) → Code flips `crunchbase` in `landing/_jsonld/entity-urls.json` (null → the permalink) + re-runs `node scripts/generate_jsonld.mjs` so the homepage `sameAs` picks it up.

## Gotchas / pushback to expect
- **Ad-copy stripped.** Crunchbase editors remove superlatives and promotional phrasing. The approved copy above is already neutral — keep it that way.
- **Crypto-scam pattern-matching.** Avoid price-prediction / "guaranteed returns" language entirely (none is present above).
- **Duplicate detection.** If creation is blocked as a duplicate, an auto-record exists → claim it instead.
- **AI-crawler value caveat** (above) — this is a Google/Knowledge-Graph anchor, not an LLM-corpus feed.
