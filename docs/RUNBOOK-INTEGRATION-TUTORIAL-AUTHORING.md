# RUNBOOK — Authoring an integration tutorial

`INTEGRATIONS-TUTORIAL-COPY-SWEEP-V2-W1` (2026-08-06).

Three tutorial pages authored on 2026-08-05 shipped with **every** copy defect the five older
pages already had, because they were written by copying an existing page. There is no shared
template in this repo to fix, so the authoring convention is the producer — this file is it.

Read this before adding or editing a tutorial. `scripts/check-mcp-client-copy.mjs` enforces the
first three rules and will fail CI; the rest are conventions the gate cannot see.

---

## 1. Find the real source — never edit the rendered HTML

`landing/integrations/<slug>.html` is **generated**. Editing it produces a fix that the next
render silently reverts, and the page will look correct in review right up until someone re-runs
the generator.

| Tutorial kind | Source of truth |
|---|---|
| **MCP clients** (`claude-desktop`, `cursor`, `cline`, `claude-code`, `smithery`, `codex`, `kimi`, `glm-zcode`) | `docs/integrations/mcp-clients/<slug>.md` — **this repo** |
| **Exchange kits** (`binance`, `okx`, `bybit`, `bitget`, `gemini`, `kraken`, `alpaca`, `hyperliquid`, `aster`, `bingx`, `kucoin`, `gateio`) | `docs/integrations/<slug>.md` in **`algovault-skills`** (separate repo) |
| **Agent frameworks** (`langchain`, `llamaindex`, `maf`, `crewai`) | `docs/integrations/<slug>.md` in **`algovault-skills`** |

`scripts/render-integrations.mjs` `getSrcPath()` routes per slug: MCP clients resolve locally,
everything else resolves under `--source` (default `~/git/algovault-skills`).

**The exchange-kit and framework tutorials also have a real template** —
`algovault-skills/docs/integrations/_template.md`. A defect copied from it reaches every future
page of that kind, so fix the template in the same change.

### The producer repo has its own gate — and its own trap

`algovault-skills` now carries `scripts/check-brand-copy.mjs` plus a **vendored copy**
of this repo's `ops/brand-forbidden-phrases.json` and a copy of its `.sha256`. Both
repos enforce the same blocklist.

- **Re-vendor BOTH files together**, never hand-edit the copy. `ops/brand-forbidden-phrases.json.sha256`
  here is the ONE canonical hash; the skills copy records none of its own, because a
  second recorded hash is a second thing that can drift.
- After changing the canonical file: re-stamp
  (`shasum -a 256 ops/brand-forbidden-phrases.json | awk '{print $1}' > ops/brand-forbidden-phrases.json.sha256`),
  copy both files across, and run the parity test in each repo.
- The blocklist stores a **pattern**, not a literal list. Add a phrase *class*, not
  today's bad string.
- **Nothing auto-renders.** `dispatch-landing-rebuild.yml` in the skills repo fires only
  on `skills/manifest.json` and `integrations/manifest.json` — a `docs/integrations/**`
  edit triggers no rebuild at all. Push skills first, then re-render here, so the
  committed HTML traces to a published commit rather than to a local working tree.

### Two skills checkouts exist — use the one the renderer reads

`render-integrations.mjs` defaults to `~/git/algovault-skills`. A second checkout at
`~/code/algovault-skills` also exists and has been observed divergent and dirty.
Rendering with `--source` pointed at the wrong one produces materially different HTML.
Confirm with `git -C <path> rev-parse --short HEAD` before rendering — and use
`git -c safe.directory='*'`, because a bare `rev-parse` refuses a repo it does not own
and reports "not a repo", which has mis-classified real checkouts before.

## 2. Run the whole generator chain, in order

```bash
node scripts/render-integrations.mjs
node scripts/build_nav.mjs
node scripts/build_analytics.mjs
node scripts/build_asset_versions.mjs
```

`render-integrations.mjs` emits **bare** pages — it strips the nav region, the analytics region
and the asset `?v=` cache-bust that the later generators inject. Running it alone turns
`build_nav`, `build_analytics` and `build_asset_versions` red across ~25 files, and the failure
looks like three unrelated canaries rather than "you ran the generators out of order".

## 3. Copy rules the gate enforces (CI will fail)

- **No screenshot placeholders.** `> *Screenshot placeholder — …*` blockquotes that were never
  going to become screenshots. Ship prose or ship an image; do not ship a promise.
- **Never frame the Telegram bot as support.** `@algovaultofficialbot` is a product surface, not
  a support channel we have committed to. Naming it as a *product* is fine
  (`Get free trade calls in Telegram via @algovaultofficialbot`); naming it as *support* is not.
  Close each page on an action-verb CTA instead.
  *(A real support pointer may land later — `/contact` is live — but it is an unratified copy
  decision. Do not add one on your own initiative.)*
- **No live-numbers note.** `Live numbers refresh in-page from <api URL>` is internal plumbing
  leaking into user copy. **KEEP** `Config verified <date> against <vendor-doc-URL>` — that is the
  registry's `verifiedAt`/`source` trust signal and it belongs on the page.

## 4. Conventions the gate cannot see

- **Keep the `?src=` tag on connect URLs.** `https://api.algovault.com/mcp?src=docs` is
  deliberate: it drives `by_source` acquisition bucketing, and
  `scripts/check-attribution-src-coverage.mjs` fails CI on any untagged connection URL. The
  `X-AlgoVault-Track-Token` header is a *different* mechanism (funnel dedup) and is not a
  substitute. Do not "clean up" the query string.
- **Track token matches the slug** — `X-AlgoVault-Track-Token: int-<slug>` on every config path.
  `smithery` is the documented exception: it shows only the `@smithery/cli` install and carries no
  raw connect URL, so it has no token by design.
- **The free tier has TWO caps: `200 calls/month` AND `100 calls/day`.** Both are real and
  enforced independently — a call is refused when either is exhausted, and the daily window is a
  UTC calendar day resetting at 00:00 UTC. State whichever the reader needs; stating only one is
  fine, stating a wrong number is not. _(Until 2026-08-09 this rule read "per-day phrasing is
  forbidden — never write `20 calls/day`", and the blocklist enforced it at severity HIGH. Ruling
  R-B introduced the daily cap, so the ban's premise died and the `per-day-quota` phrase class was
  retired with it. The history is kept because the ban is still quoted in older tutorials.)_
- **Never write that HOLD is free.** Every successful verdict is one metered call on both the
  subscription quota and the x402 rail, HOLD included (ruling R-A). This one IS blocklist-enforced
  at severity HIGH (`free-hold-promise` in `ops/brand-forbidden-phrases.json`), and it is the
  expensive mistake to make: roughly 99% of verdicts are holds, so "HOLDs are free" misstates
  almost the entire bill. The correct phrasing is "quota is counted per call, regardless of verdict" (HOLD-DEEMPHASIS-SWEEP-W1, 2026-08-10: the older "every verdict counts, HOLD included" phrasing was retired from every public surface — do not reintroduce it).
- **Numbers get a `data-tr-field` span**, not a literal. A bare figure rots; a span hydrates from
  `/api/performance-public` and its baked value is refreshed at deploy.
- **Build Rule 9** (Design.md §10): ≤20 words per sentence, no "powerful/seamless/robust/
  cutting-edge", every section closes on an action-verb CTA.

## 5. Before you push

```bash
node scripts/check-mcp-client-copy.mjs          # MCP_CLIENT_COPY_VERDICT=PASS
node scripts/check-attribution-src-coverage.mjs --check
node scripts/build_landing.mjs --check
```

Then run **every** `run:` command in `.github/workflows/deploy.yml` locally — not the subset you
judge relevant. The previous wave failed a deploy on the secret-scan gate for exactly that reason.
