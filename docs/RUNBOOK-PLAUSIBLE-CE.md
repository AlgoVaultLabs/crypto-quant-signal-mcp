# RUNBOOK — Self-hosted Plausible CE (`plausible.algovault.com`)

**Shipped:** SELFHOST-PLAUSIBLE-CE-AND-CF-ORIGIN-SHIELD-W1 (2026-07-12). **Host:** Hetzner `204.168.185.24` (`/opt/plausible-ce/`).
**Why self-host:** own our first-party human web-analytics, no Plausible Cloud subscription (AGPL-3.0). Replaces the Plausible **Cloud** tag (`plausible.io/js/pa-RwGaS0xWrfzs4vNSkMOAX.js`) that WEBSITE-REFRESH-W1 installed.

> This service is **NOT** in the `crypto-quant-signal-mcp` repo — it lives only on the box at `/opt/plausible-ce/`. This runbook is the source of truth for operating it.

---

## 1. Architecture

```
browser ─► Cloudflare (orange, edge TLS) ─► Caddy :443 (host, LE origin cert) ─► 127.0.0.1:8000 ─► plausible container
                                                                                                    ├─ plausible_db  (postgres:16-alpine, internal)
                                                                                                    └─ plausible_events_db (ClickHouse 24.12, internal, mem_limit 3g)
```

- **Version:** pinned `v3.2.1` (branch clone) — security patch for **CVE-2026-8467 / GHSA-55hg-8qxv-qj4p** (Phoenix Storybook RCE; v3.2.1 removes `/storybook`). Caddy vhost ALSO hard-blocks `/storybook` as defense-in-depth.
- **Reverse-proxy mode:** only `HTTP_PORT=8000` set (NO `HTTPS_PORT`) so Plausible does **not** run its own Let's Encrypt — host Caddy owns TLS. `compose.override.yml` publishes the app to `127.0.0.1:8000` (loopback only) and caps ClickHouse at `mem_limit: 3g` (blast-radius firewall: a ClickHouse spike cannot OOM the prod MCP container).
- **DNS:** `plausible.algovault.com` A → `204.168.185.24`, **proxied (orange)** — CF record id `e9f6bf07aa5f15aed6d1ed294996e761`. Origin IP hidden behind CF.
- **TLS/renewal:** Caddy issues the **origin** LE cert (`CN=plausible.algovault.com`, issuer `Let's Encrypt`). Under CF orange, CF 308-redirects `http://…/.well-known/acme-challenge/…` → https, and **Let's Encrypt follows the redirect**, so CF proxies the challenge to origin Caddy — renewal works under orange (identical to `api.algovault.com`). Clients see CF's edge cert; the origin LE cert is only for the CF→origin (Full/strict) leg.

### Config files on the box (`/opt/plausible-ce/`)
| File | Purpose | Secret? |
|---|---|---|
| `.env` | `BASE_URL=https://plausible.algovault.com`, `SECRET_KEY_BASE` (64-char, `openssl rand -base64 48`), `HTTP_PORT=8000` | **YES — mode 600, never commit/print** |
| `compose.yml` | upstream (unmodified); bundles app + postgres + ClickHouse (low-resources XML already mounted) | no |
| `compose.override.yml` | loopback port bind + ClickHouse `mem_limit: 3g` | no |
| Caddy vhost | in `/etc/caddy/Caddyfile` (host); backups `/etc/caddy/Caddyfile.bak-plausible-<epoch>` | no |

---

## 2. First-time user + site setup (one-time, human-owned)

The first admin account requires a browser + a password the operator sets (agents must not create accounts / set passwords).

1. Open <https://plausible.algovault.com/register>, register **admin@algovault.com** with a password you control (store in 1Password). This first user becomes the instance owner.
2. (Optional lockdown) set `DISABLE_REGISTRATION=true` in `.env` then `docker compose up -d plausible` so no further self-registration is possible (invites still work).
3. Add site: dashboard → **+ Add a website** → domain `algovault.com` (exactly — the beacon's `data-domain` must match). Timezone as desired.
4. Copy the **exact** snippet the site's "Installation" tab shows — it will be `<script defer data-domain="algovault.com" src="https://plausible.algovault.com/js/script.js"></script>` (verify before A6 uses it).
5. Configure the 4 custom-event goals from `docs/PLAUSIBLE_EVENTS.md`: **Signup Click**, **Plan Selection**, **Skill Install Click**, **Integration View** (Settings → Goals → + Add goal → Custom event → exact name). These are the manual-event `window.plausible('<name>', {props})` calls already embedded in the landing pages.

---

## 3. Common operations

### Status / logs
```sh
ssh -i ~/.ssh/algovault_deploy root@204.168.185.24
cd /opt/plausible-ce
docker compose ps
docker compose logs plausible --tail 50
docker stats --no-stream            # confirm plausible_events_db LIMIT stays 3GiB
```

### Upgrade to a new CE version
```sh
cd /opt/plausible-ce
git fetch --all
git checkout <new-version-branch>   # e.g. v3.3.0  (CE pins versions as BRANCHES, not tags)
docker compose pull
docker compose up -d                 # runs `db migrate` on boot
# verify:
curl -sI https://plausible.algovault.com/          # 200/302 + valid TLS
docker compose logs plausible --tail 30
```
Check the CVE/security note on the release first (github.com/plausible/analytics/releases).

### Backup (Postgres + ClickHouse volumes)
```sh
cd /opt/plausible-ce
TS=$(date -u +%Y%m%dT%H%M%SZ)
# Postgres (metadata: users, sites, goals)
docker compose exec -T plausible_db pg_dump -U postgres plausible_db | gzip > /root/plausible-backups/pg-$TS.sql.gz
# ClickHouse (events) — copy the volume
docker run --rm -v plausible-ce_event-data:/data -v /root/plausible-backups:/backup alpine \
  tar czf /backup/clickhouse-$TS.tar.gz -C /data .
# also back up .env (SECRET_KEY_BASE is required to decrypt TOTP secrets) — store in 1Password, NOT on disk in plaintext backups
```
Schedule via host cron; keep ≥14 days. `SECRET_KEY_BASE` loss = TOTP/2FA secrets unreadable.

### Restore
```sh
cd /opt/plausible-ce
# restore .env first (same SECRET_KEY_BASE), then:
docker compose up -d plausible_db plausible_events_db
gunzip -c /root/plausible-backups/pg-<TS>.sql.gz | docker compose exec -T plausible_db psql -U postgres plausible_db
docker run --rm -v plausible-ce_event-data:/data -v /root/plausible-backups:/backup alpine \
  sh -c 'cd /data && tar xzf /backup/clickhouse-<TS>.tar.gz'
docker compose up -d plausible
```

### Add another site (one-manifest-row pattern)
Dashboard → **+ Add a website** → new domain → copy its snippet → drop `<script defer data-domain="<domain>" src="https://plausible.algovault.com/js/script.js"></script>` into that site's `<head>`. No code change to Plausible.

---

## 4. Cloudflare origin-shield cache rule (part B of the wave)

- **Ruleset:** zone `algovault.com` (id `f960d35f73c9dbc76b1ce49795f3b1d7`), phase `http_request_cache_settings`, rule id `54273518da1b4573b16afab2e132cb54`.
- **Match:** `(http.request.uri.path in {"/api/performance-public" "/api/merkle-batches" "/api/erc-8004-reputation"})`
- **Action:** `set_cache_settings` → `cache:true`, `edge_ttl override_origin 45s`, `status_code_ttl` 200–299 = 45s / 300–599 = 0 (2xx-only), `browser_ttl respect_origin`.
- **Effect:** repeat pulls of these 3 public JSON aggregates are served from CF edge (45s), not the MCP container (was 0.18% cache-hit). Verify: 2nd `curl -sI https://algovault.com/api/performance-public` → `cf-cache-status: HIT`.
- **Data integrity:** cached responses are byte-identical to origin; the on-chain↔dashboard equality canary is unaffected (no filtering/transform). Public numbers can lag ≤45s (acceptable; static landing pages already `max-age=60`).

### Scraper `46.59.32.60` (part C — HELD)
Bahnhof AB (AS8473, Sweden, residential line `h-46-59-32-60.A1283.priv.bahnhof.se`); ~36k/24h. Treated as a **conversion lead**, not blocked. The cache rule above absorbs its origin load (it pulls the cacheable public endpoints). The **single Free-plan rate-limit rule is held in reserve** — apply only if origin load persists after caching. To apply later (needs a WAF-scoped token or the dashboard): WAF → Rate limiting rules → scope the expression to the abusive path pattern, not the whole zone.

---

## 5. Troubleshooting

| Symptom | Check |
|---|---|
| `plausible.algovault.com` 502/no-cert | `docker compose ps` (app up on 8000?); `curl -sI http://127.0.0.1:8000` on box; `systemctl status caddy`; Caddy logs `journalctl -u caddy --since '-10min'` |
| Origin cert near expiry | Caddy renews at ~2/3 lifetime; if stuck under orange, temporarily grey the DNS record (proxied:false), let Caddy renew via HTTP-01, re-orange. |
| ClickHouse OOM / eating RAM | `docker stats` — `mem_limit 3g` caps it; the container is OOM-killed & restarted before it can starve the prod MCP box (16Gi total, ~8Gi headroom). Raise `mem_limit` in `compose.override.yml` only with headroom to spare. |
| No pageviews after A6 | DevTools → Network → confirm the page loads `plausible.algovault.com/js/script.js` (not `plausible.io`); confirm site `algovault.com` exists in the dashboard; API/bot traffic is intentionally not counted. |
| Custom events missing | Confirm the 4 goals are configured (§2.5); the manual `window.plausible(...)` onclick calls need the base `script.js` loaded. |

---

## 6. Related
- Custom events: `docs/PLAUSIBLE_EVENTS.md`
- Landing re-point (A6, deferred until NAV-PLATFORM-GENERATOR-W1): swap the 24 `pa-RwGaS0xWrfzs4vNSkMOAX.js` tags → `plausible.algovault.com/js/script.js` + `data-domain="algovault.com"`.
- Fast-follow: `OPS-PLAUSIBLE-FIRSTPARTY-PROXY-W1` (first-party `/js/<renamed>.js` + `/api/event` proxy to beat adblockers — measure the undercount first).
