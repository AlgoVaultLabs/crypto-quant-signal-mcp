# ENTITY-FOOTPRINT-W1 — Plan-Mode endpoint-truth

**Wave:** ENTITY-FOOTPRINT-W1 — review-platform listings (G2 + G2DM trio) + Crunchbase + canonical schema.org Organization `@id`/`sameAs` node + Wikidata deferred-trigger artifact.
**Target ICP:** T2+T3. **Class:** EXTERNAL (public structured-data) + operator-executed sign-ups. **Date probed:** 2026-06-05.
**Repo:** `~/code/crypto-quant-signal-mcp` @ `main` `d4bd5f7`, v1.20.0 — the **deployed canonical clone** (vault `experiments/` is a stale mirror per `reference_canonical_repo_clone`). Baseline `git status -s` clean for wave scope (only unrelated untracked `audits/NPM-PUBLISH-*` + `.x402-mainnet-bootstrap.cjs`).

---

## Step 0 — system-map edge-touch enumeration

`grep -niE 'GEO-W1|generate_jsonld|_jsonld|JSON-LD block' system-map.md` → **0 hits.** There is **no distinct `generate_jsonld.mjs` producer edge** mapped; the landing JSON-LD lives inside the existing `landing/* → Caddy` publish edge (shape-unchanged). R1 adds `landing/_jsonld/entity-urls.json` as a **new internal generator input** and makes the Organization node homepage-canonical — **no new/changed producer→consumer edge, no MCP tool, no DB column, no public-response-shape change.** → **`system-map.md updated: n-a`** (confirm at R6; add a last-touched row only if the canonical-node refactor is judged an edge-pattern change).

---

## Spec-primitive probes — `claim | reality | resolution`

| # | Spec primitive | Probe command | Reality | Resolution |
|---|---|---|---|---|
| 1 | `scripts/generate_jsonld.mjs` exists, has `--check` | `ls -la scripts/generate_jsonld.mjs`; read head | ✅ 7728 B. `node scripts/generate_jsonld.mjs` = WRITE (regenerate + write all `landing/*.html`); `--check` = compute-would-be-output, **exit 1 on drift**; exit 2 on fetch error. | Gate's `node scripts/generate_jsonld.mjs --check` is a **real** flag. |
| 2 | Generator entrypoint behaviour | read `scripts/generate_jsonld.mjs` | **Live-fetches** `api.algovault.com/api/performance-public` + `/api/merkle-batches`, renders 5 `_jsonld/*.json.template` → injects `<script type="application/ld+json" data-algovault-jsonld="NAME">` blocks into **every** `landing/*.html` (`FILES_TO_SKIP` empty). `main()` runs at module-load (line 183) → **import = live-fetch** unless guarded. | Refactor: export pure fns (`buildSameAs`, org block builders) + **guard `main()` behind a direct-run check** so the R1 unit test can import without network. |
| 3 | Current Organization block (live committed source) | `grep -A12 'data-algovault-jsonld="Organization"' landing/index.html` | ✅ `name/url/logo/description/foundingDate` + `sameAs:["github","twitter.com"]`. **No `@id`. `twitter.com` not `x.com`. No npm.** sameAs is **hardcoded in the template**. | R1 delta: add `@id`, feed sameAs from config (`github/x/npm`), `twitter.com→x.com`, homepage-only full node. |
| 4 | `landing/_jsonld/entity-urls.json` | `ls landing/_jsonld/entity-urls.json` | ❌ absent. Dir has `application/organization/product/service/website.json.template`. | **CREATE** (R1). |
| 5 | Cross-reference blocks to align | read website/application/service/product templates | `website`→`publisher`, `application`→`author`, `service`→`provider` each embed inline `{"@type":"Organization","name":"AlgoVault Labs","url":...}`. `product`→`{"@type":"Brand",...}` (distinct type). | Align publisher/author/provider → `{"@id":"https://algovault.com/#organization"}`. **Leave `Brand` as-is** (Brand ≠ Organization). |
| 6 | CI JSON-LD guard = `generate_jsonld --check`? | `grep -n generate_jsonld .github/workflows/deploy.yml` | ❌ **No.** deploy.yml runs `build_landing.mjs --check` (L51) + `node --test tests/unit/geo_jsonld_consistency.test.mjs` (L63). Comment (L57-61): numeric fields **NOT byte-pinned** — "commit-time freshness is the numerical refresh seam (developer runs `generate_jsonld.mjs` locally + commits)." | Real CI guard = the **node:test consistency file** (network-free file-reads), NOT `--check`. Keep it green; adjust gate. |
| 7 | consistency-test invariant vs ref-form Org block | read `tests/unit/geo_jsonld_consistency.test.mjs` | Asserts **every** `landing/*.html` has `Product`+`Organization`+`WebSite`(+`Service`+`SoftwareApplication`) `data-algovault-jsonld` blocks that are valid JSON. | Ref-form Org block `{"@context","@id"}` **is valid JSON + keeps the `Organization` marker** → invariant holds. Will **extend** this file to assert homepage=full-node / sub-page=`@id`-ref. |
| 8 | Test runner / `npm test` | `jq .scripts package.json`; `npx vitest run` | `npm test`=`vitest run` (vitest ^3.1.1, no config). **`.test.mjs` node:test files fail to *collect* under vitest** → baseline **16 failed / 1700 passed tests; 21 failed files; EXIT 1.** None entity/Organization-related (chat-engine, knowledge-index, design_w*, snapshot-capabilities, etc. — pre-existing env/live-data/node:test-under-vitest). | New R1 test **must be `.test.ts`** (vitest-collectable). Gate's `npm test && echo GREEN` is **unreachable at baseline** → adjust (run new test in isolation + `node --test` guard + `+0-new-failures`). |
| 9 | Live API reachable (local WRITE feasible?) | `curl -m12 .../performance-public` + `/merkle-batches` | ✅ `totalCalls=154443`, `overall.pfeWinRate=0.9169…` (→ `pfe_wr="91.7"`), `period 2026-04-10→2026-06-05`; merkle `batches[]` present (batch 56). | Local `generate_jsonld.mjs` WRITE works → can render + self-verify locally. Re-WRITE refreshes live numbers in Product/App/WebSite blocks across all pages = **the documented numeric-refresh seam, not scope creep** (visible HTML body untouched; only `<script ld+json>` rewritten). |
| 10 | Brand-facts identifiers (copy SoT) | read `brand-facts.md` | X handle **`https://x.com/AlgoVaultLabs`** (confirms twitter→x); npm `crypto-quant-signal-mcp`; GitHub `github.com/AlgoVaultLabs`; canonical email `admin@algovault.com`; **line 459: `signal/signals` FORBIDDEN in public prose → use `call/calls`** (identifier strings excepted). | sameAs values trace to brand-facts. **Inline copy-fix (below).** |
| 11 | Runbook outputs (R2-R5) | `ls docs/SUBMIT_*.md docs/WIKIDATA*.md` | Only `SUBMIT_AWESOME_{MCP_SERVERS,QUANT,YUZEHAO_MCP}.md` + `SUBMIT_WWW_REDIRECT.md` exist. `SUBMIT_CRUNCHBASE/G2/G2DM` + `WIKIDATA-DEFERRED` absent. | **CREATE** all four. Style precedent: `SUBMIT_AWESOME_MCP_SERVERS.md` (status/submitter header → why-this-channel probe → exact copy → click-by-click → pushback-to-expect). |
| 12 | Gate homepage `@id` grep format | original gate: `grep '"@id": *"https://algovault.com/#organization"'` | My hand-written full node emits `  "@id": "https://algovault.com/#organization",` (colon-space) → matches both the ` *` gate regex and a literal `"@id": "..."` grep. | Compatible. Live-`curl` form is **post-deploy/operator**; local form greps `landing/index.html`. |

---

## Identifier diff (R-section ↔ AC-section ↔ gate)

| Identifier | R-section | AC / gate | brand-facts | Verdict |
|---|---|---|---|---|
| Org `@id` | `https://algovault.com/#organization` | `"@id":"https://algovault.com/#organization"` (AC + gate) | — | ✅ consistent |
| sameAs initial set | `github, x, npm` (others null→excluded) | "github/x/npm initially" | x.com/AlgoVaultLabs · npmjs/crypto-quant-signal-mcp · github.com/AlgoVaultLabs | ✅ consistent |
| entity-urls keys | github/x/npm/crunchbase/g2/capterra/wikidata | — | — | ✅ |
| Crunchbase verify email | `admin@algovault.com` | — | `admin@algovault.com` (canonical) | ✅ consistent |
| G2 portal / G2DM portal / contact | `g2.com/products/new` · `app.g2digitalmarkets.com/get-listed/start` · `listings@g2digitalmarkets.com` | — | — | external; runbook-documented, JS-fields UNVERIFIED-flagged |

No identifier mismatch ≥1 across sections. ✅

---

## Fictional-primitive count & verdict

**Code-side fictional primitives: 0.** Every R1 primitive (generator, `--check`, templates, entity-urls path, consistency guard, live API) probed real. External platform mechanics (G2/G2DM/Crunchbase/Wikidata) are **operator-executed runbook content**, deep-research-verified 2026-06-05 in-spec with JS-gated form fields explicitly UNVERIFIED-flagged — not code primitives this session executes. → **< 3 fictional → PROCEED (no HALT).** Two inline fixes flagged below (≤2 → fix-inline-and-flag per Plan-Mode rule).

### Inline fix #1 — listing-copy `signal→call` (brand-facts line 459)
The R2/R4 approved seeds say "trade-**signal** interpretation" and "**Signals** are recorded on-chain." brand-facts line 459 forbids `signal/signals` in **public-facing prose** (listings are public). The live shipped Organization description already uses "composite **call**-interpretation." → Embedded listing copy will use **"composite trade-call interpretation" / "composite call interpretation"** and **"every call is Merkle-anchored on Base L2 for independent verification"** (identifier strings like the `get_trade_signal` tool alias / `crypto-quant-signal-mcp` package name are exempt and kept verbatim). AC R4 copy-canary ("traces to brand-facts") is thereby satisfied.

### Inline fix #2 — gate adjustment to the real CLI
`npm test && echo GREEN` cannot reach GREEN even at baseline (vitest can't collect the `node:test` `.test.mjs` files; 16 test / 21 file pre-existing failures, EXIT 1). **Adjusted local gate:**

```bash
cd ~/code/crypto-quant-signal-mcp
test -f landing/_jsonld/entity-urls.json \
 && node scripts/generate_jsonld.mjs --check \                                  # after WRITE+commit; live-fetches
 && node --test tests/unit/geo_jsonld_consistency.test.mjs \                    # REAL CI structural guard (node:test)
 && npx vitest run tests/unit/entity-urls-jsonld.test.ts \                      # NEW R1 unit test (null-exclusion + node-on-one-page + refs)
 && grep -q '"@id": "https://algovault.com/#organization"' landing/index.html \
 && ! grep -q 'wikidata.org' landing/index.html \
 && for f in docs/SUBMIT_CRUNCHBASE.md docs/SUBMIT_G2.md docs/SUBMIT_G2DM.md docs/WIKIDATA-DEFERRED.md; do test -f "$f" || exit 1; done \
 && ! grep -iE 'best|leading|revolutionary|cutting-edge|powerful' docs/SUBMIT_G2DM.md | grep -v 'NEVER\|banned\|avoid\|forbidden' \
 && echo "ENTITY_FOOTPRINT_W1_LOCAL_GREEN"
# +0-new-failures: full `npx vitest run` must stay at baseline 16 test / 21 file failures (none in entity/jsonld scope).
# POST-DEPLOY (operator): curl -s https://algovault.com/ | grep '"@id": *"https://algovault.com/#organization"' && ! curl -s https://algovault.com/ | grep wikidata.org
```

---

## Observation (out-of-scope flag, not actioned here)
`product.json.template` + `application.json.template` map `aggregateRating.ratingValue={{pfe_wr}}` / `ratingCount={{total_calls}}` — a win-rate-as-star-rating synthesis that `google-rich-results-2026-deprecated-types` warns risks a Google manual-spam action (aggregateRating must derive from real reviews). **Pre-existing + shipped; stripping it is a Data-Integrity add-before-remove change orthogonal to R1.** → flag as WIS/follow-up, do **not** touch in this wave.

**Verdict: PROCEED with R1–R6.**
