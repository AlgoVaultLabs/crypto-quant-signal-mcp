#!/usr/bin/env bash
#
# deploy-direct.sh — manual SSH deploy of origin/main onto the live MCP server,
# for when GitHub Actions can't fire (account flag / Actions incident / API
# rate-limit). It is a one-command re-run of .github/workflows/deploy.yml's
# on-host SSH block — nothing more. First proven by DEPLOY-DIRECT-HETZNER-W1
# (2026-06-06) when the AlgoVaultFi account flag suspended Actions and left the
# host stuck at 13cbddb while the HL cache-stampede fix (c840be7) sat on origin.
#
# The image rebuilds ON the host (Dockerfile Stage 1 runs `npm ci`/`npm run
# build` inside the build context), so this only needs to land *source* —
# the local working tree / dist/ is irrelevant.
#
#   Usage:
#     scripts/deploy-direct.sh                # full deploy: git reset -> snapshot
#                                             # -> Caddy sync -> rebuild + recreate
#                                             # mcp-server -> verify
#     scripts/deploy-direct.sh --verify-only  # post-deploy checks only (no mutation)
#     scripts/deploy-direct.sh --help
#
#   SSH endpoint is read from the CLAUDE.md canonical values below, each
#   overridable by env var (DEPLOY_HOST / DEPLOY_USER / DEPLOY_KEY). On-host
#   identifiers (deploy dir, container + service names) are pinned constants
#   matching the canonical Hetzner layout.
#
#   Two deliberate differences from deploy.yml (see
#   audits/DEPLOY-DIRECT-HETZNER-W1-endpoint-truth.md §3):
#     DEV-1  the version-change release-post block (agent-forum-post) is NOT
#            replicated — it is a release-pipeline side-effect, out of scope for
#            a server deploy, and it depends on the very GitHub that is down.
#     DEV-2  the container recreate is service-scoped + --no-deps
#            (`up -d --build --force-recreate --no-deps mcp-server`) so postgres
#            and the facilitator are never bounced. deploy.yml force-recreates
#            all services; here only mcp-server carries the code delta.
#
set -euo pipefail

# ── canonical SSH endpoint (CLAUDE.md), env-overridable ────────────────────────
DEPLOY_HOST="${DEPLOY_HOST:-204.168.185.24}"
DEPLOY_USER="${DEPLOY_USER:-root}"
DEPLOY_KEY="${DEPLOY_KEY:-$HOME/.ssh/algovault_deploy}"

SSH=(ssh -i "$DEPLOY_KEY" -o ConnectTimeout=20 -o BatchMode=yes
     -o StrictHostKeyChecking=accept-new "${DEPLOY_USER}@${DEPLOY_HOST}")

c() { printf '\n\033[1;36m[deploy-direct]\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31m[deploy-direct FATAL]\033[0m %s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

# ── full deploy: deploy.yml on-host SSH block, steps 1-11 (release-post omitted) ──
remote_deploy() {
  c "deploying to ${DEPLOY_USER}@${DEPLOY_HOST}:/opt/crypto-quant-signal-mcp …"
  "${SSH[@]}" bash -s <<'REMOTE'
set -e
cd /opt/crypto-quant-signal-mcp

OLD_VERSION=$(grep -m1 '"version"' package.json | sed 's/.*: *"//;s/".*//' || echo "0.0.0")
echo "[dd] OLD_VERSION=$OLD_VERSION"

# Hardened pull (deploy.yml): fetch + reset + clean always converges on
# origin/main regardless of local divergence / stray untracked files.
echo "[dd] === git fetch + reset --hard origin/main + clean ==="
git fetch origin
git reset --hard origin/main
git clean -fd
git log --oneline -1

# build-time SoT snapshot injection (fail-open): re-inject live track-record
# literals into landing/*.html fallbacks. Runs after pull, before Caddy sync.
echo "[dd] === snapshot-landing-data (fail-open) ==="
node scripts/snapshot-landing-data.mjs >> /var/log/algovault-snapshot-landing.log 2>&1 \
  || echo "snapshot-landing failed; continuing fail-open"

# sync static landing pages + assets to the Caddy serve path
echo "[dd] === Caddy sync ==="
cp landing/*.html /var/www/algovault/ 2>/dev/null && echo "html synced" || echo "no html"
mkdir -p /var/www/algovault/_design
cp -r landing/_design/* /var/www/algovault/_design/ 2>/dev/null && echo "_design synced" || echo "no _design"
mkdir -p /var/www/algovault/js
cp -r landing/js/* /var/www/algovault/js/ 2>/dev/null && echo "js synced" || echo "no js"
mkdir -p /var/www/algovault/assets
cp -r landing/assets/* /var/www/algovault/assets/ 2>/dev/null && echo "assets synced" || echo "no assets"
cp landing/*.txt /var/www/algovault/ 2>/dev/null && echo "txt synced" || echo "no txt"
cp landing/sitemap.xml /var/www/algovault/ 2>/dev/null && echo "sitemap synced" || echo "no sitemap"

# IndexNow ping (fail-open) — notifies Bing/Yandex/etc the sitemap changed
echo "[dd] === indexnow ping (fail-open) ==="
node scripts/indexnow-ping.mjs >> /var/log/algovault-indexnow.log 2>&1 \
  || echo "indexnow ping failed; continuing fail-open"

# idempotent .env feature-flag appends (grep-guarded: only append if the key is
# absent, so any architect-flipped value is preserved). No-op on a warm host.
echo "[dd] === idempotent .env appends (no-op if key present) ==="
for KV in 'ENABLE_PERTF_THRESHOLDS=0' \
          'ENABLE_PERTF_1M=0' 'ENABLE_PERTF_3M=0' 'ENABLE_PERTF_5M=0' \
          'ENABLE_PERTF_15M=0' 'ENABLE_PERTF_30M=0' 'ENABLE_PERTF_1H=0' \
          'ENABLE_PERTF_2H=0' 'ENABLE_PERTF_4H=0' 'ENABLE_PERTF_8H=0' \
          'ENABLE_PERTF_12H=0' 'ENABLE_PERTF_1D=0' \
          'ENABLE_R4_RELAX=0' 'R4_RELAX_DIRECTION=sell-revert' \
          'X402_FACILITATOR=legacy' 'BAZAAR_DISCOVERABLE=false'; do
  KEY="${KV%%=*}"
  if ! grep -q "^${KEY}=" /opt/crypto-quant-signal-mcp/.env 2>/dev/null; then
    echo "$KV" >> /opt/crypto-quant-signal-mcp/.env
    echo "appended $KV"
  fi
done

# DEV-2: rebuild the image from source ON the host and recreate ONLY mcp-server.
# --build picks up the new source; --force-recreate defends the env_file race;
# --no-deps leaves postgres + facilitator untouched (no DB bounce).
echo "[dd] === docker compose up -d --build --force-recreate --no-deps mcp-server ==="
docker compose up -d --build --force-recreate --no-deps mcp-server
docker compose ps
echo "[dd] === DEPLOY DONE ==="
REMOTE
}

# ── post-deploy verification (read-only; safe to re-run any time) ──────────────
remote_verify() {
  c "verifying ${DEPLOY_USER}@${DEPLOY_HOST} …"
  "${SSH[@]}" bash -s <<'REMOTE'
set -e
MCP_CTR=crypto-quant-signal-mcp-mcp-server-1
PG_CTR=crypto-quant-signal-mcp-postgres-1
MCP_URL=http://127.0.0.1:3000/mcp
# EQUITY-TOOLS-DARK-RETIRE-W1: the live tools/list count tracks EQUITY_TOOLS_ENABLED
# (default OFF → 7 crypto tools; ON → 9 incl. get_equity_call + get_equity_regime).
# Derive from the running container's flag so this verify matches whatever is deployed.
_EQ=$(docker exec crypto-quant-signal-mcp-mcp-server-1 printenv EQUITY_TOOLS_ENABLED 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
if [ "$_EQ" = "1" ] || [ "$_EQ" = "true" ]; then EXPECTED_TOOLS=9; else EXPECTED_TOOLS=7; fi
FAIL=0

# 1) wait-for-healthy
echo "[verify] wait-for-healthy (node -e ok, up to 40s)"
HEALTHY=0
for i in $(seq 1 20); do
  if docker exec "$MCP_CTR" node -e "console.log('ok')" >/dev/null 2>&1; then
    echo "[verify] container healthy after attempt $i"; HEALTHY=1; break
  fi
  sleep 2
done
[ "$HEALTHY" = "1" ] || { echo "[verify] FAIL: container never healthy in 40s"; FAIL=1; }

# 2) c840be7 proof module present
echo "[verify] coalesced-cache.js + runtime.js present (c840be7 proof)"
if docker exec "$MCP_CTR" ls /app/dist/lib/coalesced-cache.js /app/dist/lib/runtime.js >/dev/null 2>&1; then
  echo "[verify] OK — coalesced-cache.js + runtime.js present"
else
  echo "[verify] FAIL — coalesced-cache.js / runtime.js missing"; FAIL=1
fi

# 3) /mcp 3-step handshake -> tools/list == EXPECTED_TOOLS
echo "[verify] /mcp tools/list handshake"
SID=$(curl -s -D - -o /dev/null -X POST "$MCP_URL" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"deploy-direct","version":"1"}}}' \
  | tr -d '\r' | awk -F': ' 'tolower($1)=="mcp-session-id"{print $2}')
curl -s -X POST "$MCP_URL" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H "Mcp-Session-Id: $SID" -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null
TOOLS=$(curl -s -X POST "$MCP_URL" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H "Mcp-Session-Id: $SID" -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}')
N=$(printf '%s' "$TOOLS" | node -e "var raw=require('fs').readFileSync(0,'utf8');var line=raw.split('\n').find(function(l){return l.indexOf('data:')===0});var body=line?line.replace(/^data:\s*/,''):raw;var j=JSON.parse(body);console.log(((j.result||{}).tools||[]).length)")
if [ "$N" = "$EXPECTED_TOOLS" ]; then echo "[verify] OK — tools/list = $N"; else echo "[verify] FAIL — tools/list = $N (expected $EXPECTED_TOOLS)"; FAIL=1; fi

# 4) C4 HL-throw gate (informational print — operator reads the collapse)
echo "[verify] HL rate-limit throws (rate_limit_events):"
docker exec "$PG_CTR" psql -U algovault -d signal_performance -t -c \
  "SELECT to_char(date_trunc('minute', ts),'HH24:MI') AS minute, count(*) FROM rate_limit_events WHERE venue='Hyperliquid' AND kind='throw' AND ts > now() - interval '15 minutes' GROUP BY 1 ORDER BY 1"
docker exec "$PG_CTR" psql -U algovault -d signal_performance -t -c \
  "SELECT 'HL throws last 15m = ' || count(*) FROM rate_limit_events WHERE venue='Hyperliquid' AND kind='throw' AND ts > now() - interval '15 minutes'"

# 5) get_trade_call BTC on HL -> exchange should be 'HL' (not a Binance fallback)
echo "[verify] get_trade_call BTC exchange=HL (HL-scored vs Binance-fallback):"
CALL=$(curl -s -X POST "$MCP_URL" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H "Mcp-Session-Id: $SID" -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_trade_call","arguments":{"coin":"BTC","exchange":"HL"}}}')
printf '%s' "$CALL" | node -e "var raw=require('fs').readFileSync(0,'utf8');var line=raw.split('\n').find(function(l){return l.indexOf('data:')===0});var body=line?line.replace(/^data:\s*/,''):raw;var j=JSON.parse(body);var txt=(((j.result||{}).content||[])[0]||{}).text||'{}';var r=JSON.parse(txt);console.log('[verify]   exchange='+r.exchange+' call='+r.call+' confidence='+r.confidence+' coin='+r.coin)" \
  || echo "[verify]   (could not parse get_trade_call result)"

[ "$FAIL" = "0" ] && echo "[verify] === ALL ASSERTIONS GREEN ===" || { echo "[verify] === VERIFY FAILED ==="; exit 1; }
REMOTE
}

case "${1:-}" in
  --help|-h)      usage ;;
  --verify-only)  remote_verify ;;
  "")             remote_deploy; remote_verify ;;
  *)              die "unknown arg: $1 (try --help)" ;;
esac
