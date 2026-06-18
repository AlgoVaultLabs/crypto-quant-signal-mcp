# GEO-REGISTRY-RANK-STARS-CTA-W1 — Probe Record

- **Wave**: GEO-REGISTRY-RANK-STARS-CTA-W1 (content wave — owned-surface star CTA)
- **Date**: 2026-06-18
- **Branch**: `ops/geo-registry-rank-stars-cta-w1` (worktree `cqsm-wt-stars-cta`)
- **Base**: `origin/main` @ `e511b28` (post GEO-REGISTRY-RANK-README-REFRESH-W1)
- **Target ICP**: T1+T2 (META distribution)

---

## R1 — Probes

### 1. shields.io stars badge endpoint — RESOLVES ✅

```
curl -sI "https://img.shields.io/github/stars/AlgoVaultLabs/crypto-quant-signal-mcp?style=social"
→ HTTP 200 | content-type: image/svg+xml;charset=utf-8
```

Body confirms a **real** stars badge (not an error SVG): renders `Stars | 1`, GitHub
icon, links to the repo and `/stargazers`. `style=social` is the canonical
GitHub social-count look. Endpoint live and self-updating (the wave's point).

### 2. README badge row (origin/main @ e511b28)

The existing badge row is **HTML-format**, centered, with five `<a href><img/></a>` entries:

| # | Badge | shields/source |
|---|-------|----------------|
| 1 | npm version | `img.shields.io/npm/v/...` |
| 2 | npm downloads | `img.shields.io/npm/dw/...` |
| 3 | MIT License | `img.shields.io/badge/License-MIT-...` |
| 4 | On-Chain Verified | `img.shields.io/badge/Track_Record-On--Chain_Verified-...` |
| 5 | ERC-8004 Verified Agent | `img.shields.io/badge/ERC--8004-...` |

**Decision (R2):** the spec supplies the badge in markdown form
(`[![…]](…)`). The row is raw HTML inside `<p align="center">`; pasting markdown
into a raw-HTML block risks GitHub rendering it as **literal text**, and would be
stylistically inconsistent with the 5 existing HTML badges. Per the spec's own
"place it consistently with the row's existing markdown/style", the stars badge is
added in the **same HTML form**, appended as the last entry in the row (cleanest
single-line diff, no reordering of existing badges). The shields URL + link target
are byte-identical to the spec string.

Added line:
```html
  <a href="https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp"><img src="https://img.shields.io/github/stars/AlgoVaultLabs/crypto-quant-signal-mcp?style=social" alt="GitHub Repo stars" /></a>
```

### 3. dev.to editorial footer location — HOST-SIDE (R3 → defer, no in-repo edit)

`grep -rn "Built by AlgoVault Labs"` across the repo hits: `landing/*.html` (website
footers), `src/index.ts` + `src/lib/account-handlers.ts` (server HTML), `scripts/render-*.mjs`
(landing renderers), tests, and **`src/scripts/agent-forum-post.ts`** (lines 370, 665).

The only in-repo code that **publishes to dev.to** is `src/scripts/agent-forum-post.ts`
— but it is **not** the "dev.to editorial post footer" the spec describes:

- **Footer-text mismatch.** Spec: the footer "currently ends 'Built by AlgoVault Labs'".
  In-repo `agent-forum-post.ts` footer ends `Built by AlgoVault Labs — signal
  interpretation for AI trading agents.` (different trailing copy).
- **Different pipeline.** `agent-forum-post.ts` is self-described "Automated
  multi-platform **forum marketing**" (Moltbook + Dev.to + Hashnode, 3×/week cron). The
  spec names the "**editorial** pipeline" that "already ships these posts" — that is the
  host-side **AUTOPUB** system (`/opt/algovault-editorial`, Tue/Fri long-form
  dev.to/Medium posts), whose drafter (`drafter.mjs`) lives in the **separate
  `algovault-editorial` repo**, not in `crypto-quant-signal-mcp`. Confirmed by committed
  audits (`KNOWLEDGE-TOOLS-DOCS-W1`, `ACTIVATION-FUNNEL-AUDIT-W1`) that locate the
  editorial drafter host-side.

**Resolution:** the dev.to **editorial** footer is **host-side only** → per R3 the spec
says do **NOT** SSH-edit it this wave; record a **host-side follow-up** note in status.md
for the editorial-pipeline owner.

**Near-miss note (for the architect):** `agent-forum-post.ts` does carry an in-repo
*forum-marketing* footer. It was **deliberately not edited** — it is a behavioral `src/`
change (out of this content wave's "owned-surface copy" scope) and would add the CTA to
Moltbook/Hashnode forum posts too, not just dev.to. If a star CTA is also wanted on the
forum-marketing footer, dispatch a separate wave (`OPS-FORUM-POST-STAR-CTA-W1`-class).

### 4. No-redeploy verification (supports R4)

Spec Context claimed "README … matches deploy `paths-ignore`, no prod restart."
**This mechanism is inaccurate** for the current `deploy.yml`. Actual `origin/main`
`paths-ignore`:
```
activation-funnel/snapshots/**, activation-funnel/README.md,
ops/systemd/**, ops/monitoring/**, LICENSE, glama.json
```
`README.md` / `*.md` / `audits/**` are **not** listed. The "no redeploy" conclusion still
holds, via two **other** mechanisms:

- (a) the Deploy workflow triggers only on `push` to `branches: [main]`;
- (b) push-triggered GHA deploy is **flag-disabled** — `gh run list` returns **zero**
  workflow runs, and the README-refresh `*.md` push to main (`e511b28`) produced **no**
  deploy run. Verified live.

→ No prod rebuild/restart attributable to this wave's push.

---

## Changes shipped

| File | Change | Class |
|------|--------|-------|
| `README.md` | +1 line — GitHub-stars social badge appended to badge row | `*.md` docs / owned-surface copy |
| `audits/GEO-REGISTRY-RANK-STARS-CTA-W1-probe.md` | new (this file) | audit |

`git diff README.md` = **1 insertion**, in the badge `<p>` block only. No
hero / "What's new" / pricing / version change (grep-verified).

## Firewall confirmations (content wave, NOT a release)

- No version bump, no `## [X.Y.Z]` CHANGELOG heading, no `mcp-publisher publish`, no Discussion.
- `system-map.md updated: n-a` — owned-surface copy; no producer/consumer edge.
