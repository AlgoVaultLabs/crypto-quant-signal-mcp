# Index-Presence Diagnosis — FIX-GEMINI-GOOGLE-INDEX-PRESENCE-W1

**Date:** 2026-06-15 · **Author:** Code · **Mode:** read-only-forensic-first (doubles as the Plan-Mode endpoint-truth artifact)
**Target ICP tier(s):** META (eligibility infra — gates citation for all tiers)

## TL;DR

The **live site is healthy and crawlable** (apex 200, real content, clean robots, valid 34-URL sitemap, www→apex 301). The gap is exactly what the prompt predicted: **Google's index holds a STALE parked-domain snapshot** of `www.algovault.com`, and **no GSC property is verified**, so Google has never been told to recrawl. Index presence is the binary gate for Gemini/AIO citation.

Two surprises that **reduce scope** vs the prompt:
1. **IndexNow is already fully shipped** (prior wave AI-CRAWLER-ACCESS-W2) — key file live, ping script wired into every deploy. → Verify + trigger, do not rebuild.
2. **apex-vs-www and robots are already clean** — www 301→apex, live robots == committed byte-for-byte (no Cloudflare edge-injection). → No redirect/robots fix needed.

One blocker vs the prompt: **no Cloudflare API token is available to Code** → GSC verification uses the prompt's stated HTML-tag fallback, not DNS-TXT.

---

## Per-engine index presence (verified 2026-06-15)

| Engine (gates) | Index presence today | Crawlability | Action |
|---|---|---|---|
| **Google → Gemini / AI Overviews** | ✗ **Not indexed with real content.** `site:algovault.com` top hit is the stale broker/parking snapshot ("pricing information within 24 business hours… domain experts… quote form") under `www.`; rest is Wikipedia "vault/Algo" noise. | ✅ Googlebot + Google-Extended `Allow: /`; apex 200; sitemap valid | GSC verify + sitemap submit + URL-Inspection "Request indexing" (manual sign-in). No general-page submission API exists (Indexing API is JobPosting/BroadcastEvent only) — confirmed, not invented. |
| **Bing → ChatGPT** | ✗ Not meaningfully indexed | ✅ Bingbot `Allow: /`; IndexNow key live | **IndexNow already shipped + pinged** (auto). Bing Webmaster = import-from-GSC (manual, 1 click). |
| **Brave → Claude** | n/a (crawler-driven, no submission tool) | ✅ Covered by `User-agent: *  Allow: /` (no BraveBot-specific block); apex 200 | None — confirm-only. Crawlable. |

**Third-party properties index fine** (proves the domain itself is the gap, not the brand): `glama.ai/mcp/servers/AlgoVaultLabs/...`, `dev.to/algovaultlabs/...` both surface on a brand query; `algovault.com` does not (except the stale snapshot).

---

## Endpoint-truth table (claim | reality | resolution)

| Spec primitive | Claim | Reality (probed) | Resolution |
|---|---|---|---|
| Code checkout | `/Users/tank/crypto-quant-signal-mcp` | That path is the **STALE mirror** (HEAD 74507f3 / 2026-05-30 / v1.18.2, no `deploy-direct.sh`). Canonical is **`/Users/tank/code/crypto-quant-signal-mcp`** (HEAD 883a8ad / v1.20.1, robots+sitemap byte-match live). | Inline-fix: use `~/code/...`. |
| `landing/robots.txt` live | "confirm live; ~40 AI crawlers" | 200, content-length 3108 = **byte-identical to committed**; Googlebot/Bingbot/ClaudeBot/Google-Extended + ~40 UAs `Allow: /`; only `/dashboard*` + `/.well-known/` disallowed. **No CF edge-injection** (prior memory now stale). | ✅ No change. |
| `sitemap.xml` live | "exists, 25→33 slugs" | 200, text/xml, **well-formed, 34 `<loc>`** (GEO-CONTENT-W1 already took it 26→34). Declared in robots. | ✅ No change. |
| apex vs www | "verify both serve AlgoVault; www parking page would poison index" | apex 200 real site (0 parking markers, canonical present); **www 301→apex** (single canonical host already). | ✅ Already resolved — no redirect to add. |
| IndexNow key + POST + deploy hook | "generate key, host it, POST, add post-deploy hook" | **ALREADY EXISTS** (AI-CRAWLER-ACCESS-W2 R3): `landing/f62bee9b71c607de0659c5edd5caae43.txt` live (content==filename), `scripts/indexnow-ping.mjs` (fail-open POST → `api.indexnow.org/indexnow`, reads live sitemap), wired at `deploy-direct.sh:87-90`. | Verify + trigger ping. Do **not** rebuild. |
| Cloudflare API token (DNS-TXT path) | "available (Zone.DNS:Edit + Zone.Zone:Read)" | **ABSENT** from canonical cred store: `~/.config/algovault/admin.env` (mode 600) holds only `ADMIN_KEY`; no `cloudflare.env`, no CF env vars. | Use prompt's stated **HTML-tag fallback** (Code-placed in `landing/index.html`). DNS-TXT only if operator adds the record in Cloudflare dashboard or supplies a scoped CF token. |
| IndexNow endpoint | `https://api.indexnow.org/indexnow` | Host resolves; reachable. | ✅ Real. |

---

## Crawl-hygiene sweep — all 34 sitemap `<loc>` (verified 2026-06-15)

- **HTTP 200: 34/34.** No non-200, no redirects on canonical URLs.
- **`noindex`: 0/34.** No `noindex` in body, no `X-Robots-Tag` header on any page.
- **Canonical tags: 27/34 had them.** Gaps:
  - 5 **HTML pages** missing a self-referential canonical → **FIXED this wave**: `/track-record` (function-rendered, `src/index.ts` `getPerformanceDashboardHtml`), `/docs`, `/verify`, `/terms`, `/privacy` (static `landing/*.html`).
  - 2 are `/llms.txt` + `/llms-full.txt` — **plain-text files; canonical link is HTML-only, correctly N/A** (not a defect).
- **`<lastmod>`**: range 2026-05-15 → 2026-06-15 (8 newest = GEO-CONTENT-W1 pages). Honest — left as-is (lastmod must reflect real modification; not artificially bumped).

---

## What Code did automatically this wave

1. **Diagnosis** — this document.
2. **Canonical hygiene** — added `<link rel="canonical">` to the 5 HTML pages above.
3. **IndexNow** — triggered a fresh ping submitting the current 34 URLs to Bing/Yandex/Seznam (flushes the stale snapshot on the Bing/ChatGPT substrate). Deploy hook continues to ping on every future deploy.
4. **Deploy** — committed + pushed to origin/main, deployed via `scripts/deploy-direct.sh` (GHA down per account-flag), post-deploy verified canonical live on all 5.

## Remaining (manual, irreducible sign-ins — batched for operator)

GSC + Bing require a one-time sign-in. **Recommended path (no Cloudflare token needed):**

1. **Google Search Console** ([search.google.com/search-console](https://search.google.com/search-console)) as **admin@algovault.com** → **Add property → URL prefix → `https://algovault.com/`** → choose **"HTML tag"** verification → copy the `<meta name="google-site-verification" content="…">` tag → **paste it back to Code** (Code places it in `landing/index.html` `<head>`, redeploys, you click **Verify**).
   - *Alternative:* a **Domain** property gives broader coverage but requires a **DNS TXT** record — Code cannot place it (no CF token); you'd add it in the Cloudflare dashboard yourself, or hand Code a scoped CF token.
2. GSC → **Sitemaps** → submit `https://algovault.com/sitemap.xml`.
3. GSC → **URL Inspection** → `https://algovault.com/` → **Request Indexing** (repeat for `/track-record`, `/best-mcp-servers-crypto-trading` + the other head pages).
4. **Bing Webmaster Tools** ([bing.com/webmasters](https://www.bing.com/webmasters)) as **admin@algovault.com** → **Import from GSC** → confirm sitemap imported.

## Re-verify (+7–14d)

Re-run `site:algovault.com` per engine + the 4-engine GEO-probe eligibility line; record the delta in `status.md`. **Success:** Google `site:` returns AlgoVault pages (not Wikipedia/broker noise) and the GEO probe flips **gemini ✓**.
