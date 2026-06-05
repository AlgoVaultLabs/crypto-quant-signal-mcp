# Wikidata — DEFERRED (ready-to-execute artifact; NO item created yet)

**Status:** 🔴 **DEFERRED, not skipped** (ENTITY-FOOTPRINT-W1 R5). This document is the trigger + skeleton + deletion-resistance plan. **Do NOT create the item until the trigger fires.**
**Decision (Mr.1, pre-dispatch):** creating a self-promotional company item now = same-day deletion + a permanent public "self-promotion" record + an active policy-reform risk. We ship the runbook instead of the item.

> **Property/item IDs below are from the ENTITY-FOOTPRINT-W1 deep-research probe (live Wikidata API, 2026-06-05).** Because the item is created later (possibly months out), **re-verify each ID at execution time** — open `https://www.wikidata.org/wiki/Property:P<NNN>` / `.../wiki/Q<NNN>` and confirm the label still matches. Stable, high-confidence IDs (P31 instance-of, P856 official-website, P571 inception, P178 developer, P1448 official-name) rarely move; the rest re-confirm before use.

---

## 1. Trigger (re-evaluate quarterly, or immediately on press)
Create the item **only when ALL hold:**
- **≥ 2–3 substantial, INDEPENDENT articles ABOUT AlgoVault** exist — genuine third-party journalism/analysis, **NOT** interviews, press releases, sponsored posts, or listicles we placed ourselves.
- Those sources are durable (established outlets, not link-rot blogs).
- Re-check **quarterly** (calendar) or whenever a press mention lands.

Until then: the listed `sameAs` profiles (Crunchbase, X, GitHub, npm) carry the entity layer. **`wikidata` stays `null` in `landing/_jsonld/entity-urls.json`** and is added **only after** the item exists *and survives* a deletion window.

---

## 2. Verified property skeleton (execute in ONE sitting — see §3)

### Primary: company item
| Property | Value | Notes |
|---|---|---|
| `P31` instance of | `Q1058914` | company. (Re-confirm the Q-label at execution.) |
| `P1448` official name | `AlgoVault Labs` | |
| `P571` inception | `2026` | attach a reference (P973 / Crunchbase / site) |
| `P856` official website | `https://algovault.com` | |
| `P452` industry | software / fintech | use the live industry Q-items at execution |
| `P17` country / `P159` headquarters | *operator — only if disclosed* | omit if pseudonymous jurisdiction is not public |
| `P2088` Crunchbase ID | `<organization/slug>` | **identification, NOT notability** (carries the "does not imply notability" tag) |
| `P2037` GitHub username | `AlgoVaultLabs` | identification-not-notability |
| `P2002` X/Twitter username | `AlgoVaultLabs` | identification-not-notability |
| `P1320` OpenCorporates ID | `<if registered>` | identification-not-notability |
| `P4264` LinkedIn company ID | `<if exists>` | identification-not-notability |
| ~~`P112` founder~~ | **OMIT** | AlgoVault operates pseudonymously — do not attach a person |

### Alternative: product item (if a company item is too thin to survive)
| Property | Value | Notes |
|---|---|---|
| `P31` instance of | `Q7397` | software |
| `P178` developer | `AlgoVault Labs` | |
| `P8262` npm package | `crypto-quant-signal-mcp` | |
| `P2037` GitHub username | `AlgoVaultLabs` | |

A software/product item often clears the bar more easily than a company item (npm + GitHub are concrete, verifiable identifiers).

---

## 3. Deletion-resistance checklist (do ALL, in one sitting)
- [ ] **Complete the item in one sitting** — a half-built stub invites speedy deletion.
- [ ] **Neutral description, ≤ 12 words** (e.g. "MCP server and API providing composite trade-call interpretation for AI agents"). No adjectives, no marketing.
- [ ] **Attach references (`P973` / reference-URL) at creation** — every notability-bearing claim cited inline, not later.
- [ ] **No self-referential cluster** — do not create + cross-link a web of AlgoVault items in one session (reads as link-farming).
- [ ] **Affiliation disclosure** via `{{PaidContributions}}` on the talk page — **org name only**; a pseudonymous account is acceptable on Wikidata, but undisclosed paid editing is not.
- [ ] Use the **product item** (Q7397) path if the company item looks thin.

---

## 4. The no-go record (why NOT now — keep for the audit trail)
- **Self-created company items without ≥2–3 substantial independent articles are deleted same-day.** The Crunchbase `P2088`, X `P2002`, and OpenCorporates `P1320` identifiers all carry explicit **"does not imply notability"** tags on Wikidata — they identify, they do not justify existence.
- A **pending policy reform** would ban self-creation of company items outright.
- A **failed undeletion request leaves a permanent, public "self-promotion" record** attached to the brand — strictly worse than never creating the item.
- Therefore: **ship this artifact + the trigger, not the item.** `sameAs` gets the Wikidata URL **only after** the item exists and survives.
