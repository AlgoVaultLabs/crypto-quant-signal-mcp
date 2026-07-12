# endpoint-truth.md — SELFHOST-PLAUSIBLE-CE-AND-CF-ORIGIN-SHIELD

**Probed:** 2026-07-12 · **Verdict:** 🛑 HALT — awaiting architect answers (D0–D5) before ANY state mutation.
**Session:** single sequential · worktree `.claude/worktrees/selfhost-plausible-ce` off `origin/main@41cbeb4`.
**Prod box:** `ssh -i ~/.ssh/algovault_deploy root@204.168.185.24` (reachable, BatchMode OK).

---

## Gate 0 — box size (spec flagged CONFLICT; live probe decisive)

| Source | Claim | Reality (live) |
|---|---|---|
| CLAUDE.md | CPX42 8 vCPU / 16 GB | **CONFIRMED** |
| system-map §Infra (L220/L281) | `2 × CPX22` (4 GB) | **STALE / WRONG** |
| memory `project_hetzner_oom_swap` | "3.8 GB box" (2026-06-04) | **STALE** (pre-resize) |

Live: `hostnamectl` = `AlgoVault-MCP`, Ubuntu 24.04.3, x86-64 VM · `nproc` = **8** · `free -h` total **15 Gi**, free 3.2 Gi, **available 11 Gi**, buff/cache 9.3 Gi · swap **4.0 Gi** (60 Mi used) · `df / ` = 301 G total, **224 G free** (23% used).
Docker: `crypto-quant-signal-mcp-mcp-server-1` (127.0.0.1:3000, **902 MiB**), `…-postgres-1` (127.0.0.1:5432, postgres:16-alpine, 1.126 GiB), `…-facilitator-1` (4022, 26 MiB). Loopback **8000 / 8123 / 9000 all free**. ClickHouse prereqs: SSE4.2 (x86-64 ✓), ≥2 GB (11 Gi avail ✓).

➡ **D1 resolves toward co-locate** (mem_limit-capped): 11 Gi available, MCP uses <1 GB. Headroom is NOT tight → separate CAX11 unnecessary. Ratify in D1.

---

## Endpoint-truth table — `claim | reality | resolution`

| # | Spec primitive | Probe | Reality | Resolution |
|---|---|---|---|---|
| 1 | Host Caddy `/etc/caddy/Caddyfile`, host systemd | `ls` + `systemctl is-active` | 5492 B, root:root, **active** | ✅ as spec |
| 2 | `plausible.algovault.com` free | `dig +short` | **empty (NXDOMAIN)** | ✅ free for A4 |
| 3 | `api.algovault.com` cert/proxy method | `dig` + Caddyfile read | resolves to **CF IPs 172.67.187.95 / 104.21.64.189 = PROXIED (orange)**; Caddyfile has **NO `tls` block** → Caddy auto-LE (HTTP-01 through CF) | D2 — replicate for plausible |
| 4 | apex `algovault.com` render of `/` | Caddyfile + `dig` | apex PROXIED (same CF IPs); `/` served by **static `file_server` from `/var/www/algovault`** (catch-all `handle`, `Cache-Control max-age=60`). `/skills`, `/integrations`, `/integrations/*` → `reverse_proxy localhost:3000` (Express, in-image `landing/*.html`) | A6 target is dual-surface; **re-grep post-NAV-generator** |
| 5 | Existing Plausible tag = no-op `plausible.io/js/script.js`, no account | `grep` + `curl` script | **FALSE.** Live tag = `<script async src="https://plausible.io/js/pa-RwGaS0xWrfzs4vNSkMOAX.js">` + `plausible.init()`, **no `data-domain`**. Script returns **HTTP 200, application/javascript, 6040 B**. Classic `script.js` form **absent**. | 🛑 **D0 premise conflict** |
| 6 | Tag location (spec implies 1 canonical source) | `grep -rl` | present in **24 landing files** (index, skills, glossary, integrations, verify, how-it-works, docs, faq + 16 `integrations/*`) | A6 = 24-file (or 1 generator) swap, deferred |
| 7 | `docs/PLAUSIBLE_EVENTS.md` custom events | `cat` | 4 events: `Signup Click`, `Plan Selection`, `Skill Install Click`, `Integration View` (+ optional GEO goals). Origin = **WEBSITE-REFRESH-W1 C6**, script ID "provided by architect mid-execution"; dashboard `plausible.io/algovault.com` | A7 recreate as CE goals |
| 8 | Cache endpoints exist + cache-safe | `curl -sD-` ×3 | `/api/performance-public`, `/api/merkle-batches`, `/api/erc-8004-reputation` → **HTTP/2 200**, `application/json`, **NO Set-Cookie**, `cf-cache-status: DYNAMIC` (uncached), no `Cache-Control`/`Vary` | ✅ cache-safe candidates (B) |
| 9 | Scraper `46.59.32.60` | `dig -x` + `whois` | rDNS `h-46-59-32-60.A1283.priv.bahnhof.se`; **Bahnhof AB, AS8473, route 46.59.0.0/17, country SE**, mnt BAHNHOF-NCC = **Swedish residential ISP line** (not datacenter/partner signature) | D4 — present to Mr.1 |
| 10 | Prod MCP healthy, `tools/list` = 9 | stateless streamable-HTTP handshake to `api.algovault.com/mcp` | init 200, **stateless (no session-id)**, **tools/list = 9**: get_trade_call, get_trade_signal, get_market_regime, scan_funding_arb, scan_trade_calls, get_equity_call, get_equity_regime, chat_knowledge, search_knowledge | ✅ baseline captured for post-deploy AC |
| 11 | Plausible CE **v3.2.1** clone `-b v3.2.1` from `community-edition` | `git ls-remote` | community-edition pins versions as **BRANCHES** (`refs/heads/v3.2.1` = HEAD `ec6c4da`), **no tags**; `-b v3.2.1` resolves to the branch → **clone command VALID**. Matching app release = **tag `v3.2.1` on `plausible/analytics`** (`e4f5a87`). v3.2.1 = **latest** CE (not stale). | ✅ not a fictional primitive |
| 12 | CE install / env list | WebFetch community-edition | `compose.yml` + `compose.override.yml`; **required** `BASE_URL`, `SECRET_KEY_BASE` (≥64-byte, `openssl rand -base64 48`); **optional** `HTTP_PORT` (default 80), `HTTPS_PORT` (default 443). `fix-low-resources` branch informs A2 low-mem. **Read the on-box `compose.yml` for the authoritative DB/ClickHouse env at execution — do not invent.** | ✅ |
| 13 | CVE-2026-8467 / GHSA-55hg-8qxv-qj4p | web-verify | **CONFIRMED** — Phoenix Storybook RCE (template injection); v3.2.1 removes `/storybook`; "update ASAP". Mitigation: **block `/storybook` in reverse proxy** | add `/storybook` deny to Caddy vhost (defense-in-depth) |
| 14 | Cloudflare token available to Code (Zone.DNS:Edit) | `admin.env` key inventory | `~/.config/algovault/admin.env` = **only `ADMIN_KEY`** (75 B). **No CF token locally.** | 🛑 **D5 gap — A4/B/C all need a CF token or dashboard** |

---

## Factuality corrections (drift caught pre-mutation)

1. **PREMISE (D0):** Spec Objective — *"current Plausible tag is a no-op → plausible.io, no account, 0 pageviews"* — is falsified. A **live Plausible Cloud site** (`plausible.io/algovault.com`, script `pa-RwGaS0xWrfzs4vNSkMOAX`, HTTP 200) was **deliberately installed by the architect** during WEBSITE-REFRESH-W1 C6 and is already tracking pageviews/bounce/outbound across 24 pages. This is a **migration off Plausible Cloud → self-hosted CE**, not a first install. Whether Cloud is a paid/trial sub (cost we'd eliminate — still a valid reason to self-host) or an expired trial (data now rejected) changes the framing and the historical-data-export question. **Do not encode the "no-op/no-account" rationale.**
2. **system-map §Infra STALE:** "2 × CPX22 (4 GB)" contradicts the live 16 GB / 8 vCPU box. The wave's Map-Anchor edit must also **correct the box size** (not only add the PLAUSIBLE node).
3. **AC grep drift:** AC says `grep -o 'src="[^"]*script.js"'` and "`data-domain` intact". Current tag ends in `pa-…js` (not `script.js`) and has **no `data-domain`**. Post-migration the CE snippet (classic `…/js/script.js` + `data-domain="algovault.com"`) WILL satisfy `script.js` and will **add** `data-domain` (not "keep intact"). Re-word the AC to: *`plausible.io` gone → `plausible.algovault.com/js/script.js` present; `data-domain="algovault.com"` present.*
4. **A6 scope:** not a 1-line swap — 24 files today, or 1 generator source post-NAV-PLATFORM-GENERATOR-W1. Blocked (see below).

---

## B — cache-rule readiness
All 3 endpoints: 200, JSON, **no Set-Cookie**, currently DYNAMIC. Recommend one Cache Rule: match the 3 paths → `set_cache_settings` eligible + `edge_ttl` 30–60 s, **cache 2xx only**. Pre-finalize check at execution: confirm response body is caller-independent (public aggregate; the `x-algovault-track-token` in `access-control-allow-headers` is a funnel-attribution side-effect, not response variance) — a quick two-caller body-diff before committing the rule.

## C / D4 — scraper
`46.59.32.60` = Bahnhof AB (AS8473) Swedish **residential** line, Chrome-UA-spoofing, ~36k/24h (62%), origin-direct (0.18% cache). **Note the synergy:** it hammers the 3 hot **cacheable** endpoints, so **the B cache rule likely absorbs most of its origin load** — the single Free-plan rate-limit rule may be better held in reserve. Present WHOIS to Mr.1; rate-limit only on go, scoped to the abusive path pattern (not the zone).

## D5 — Cloudflare execution gap
No CF token in `admin.env`. **A4 (DNS record) — which the spec assumed was in-scope with the existing Zone.DNS:Edit token — cannot be executed locally.** All three CF-side actions (A4 DNS, B cache rule, C rate-limit) need either a handed-over scoped token or dashboard execution.

## A6 — DEFERRED (blocker confirmed)
`NAV-PLATFORM-GENERATOR-W1` is **absent from the git log (all branches) and status.md** → not merged/deployed. Per operator instruction: do **A1–A5, B, C, A7, A8 first**; do **A6 LAST**, after `git pull` latest `origin/main` into this worktree + **re-grep the freshly-generated landing tree** (the tag likely collapses from 24 files to 1 generator source).

---

## Proposed execution order (on approval)
Gate-0 ✅ → **[D0–D5 answers]** → A1 clone v3.2.1 branch + `.env` (loopback 8000) → A2 `compose.override.yml` (ClickHouse mem_limit, read on-box compose.yml first) → A3 `up -d` + admin user + site + `/storybook` deny → A4 DNS (token/dashboard per D5) → A5 Caddy vhost + validate + reload → A7 goals → A8 runbook (commit in worktree) → B cache rule → C conditional rate-limit → status.md + system-map (correct box size + add PLAUSIBLE node) → **A6 last** (post NAV-generator pull + re-grep) → `scp status.md` monitoring host.
