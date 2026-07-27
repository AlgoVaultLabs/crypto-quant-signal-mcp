#!/usr/bin/env bash
# OPS-HETZNER-DISK-FORENSICS-W1 (2026-07-26) — strictly READ-ONLY disk attribution.
#
# Attributes every GB of a Hetzner host's live `df` used-total to a concrete
# source (docker image layers / build-cache / container json-logs / named
# volumes [Postgres, ClickHouse, Redis, DuckDB] / editorial media / journald /
# apt), and tags each source SAFE / REVIEW / DO-NOT-TOUCH for reclaim triage.
#
# READ-ONLY LAW (THE reason this file exists): this script executes ZERO
# mutating commands. It only reads — df, du, docker system df / inspect / ps,
# read-only psql/clickhouse SELECTs, redis INFO/DBSIZE, journalctl --disk-usage.
# It never reclaims anything; the reclaim commands are PROPOSED in the report
# (audits/DISK-FORENSICS-<date>.md) and executed only by the separate,
# Plan-Mode-gated OPS-HETZNER-DISK-RECLAIM-W1 wave. A self-check
# (assert_read_only) greps THIS file for mutating tokens and aborts if any
# appear, so the read-only contract is enforced at every invocation.
#
# disk-fill autopilot seed: this is the read-only detector seed for the
# `disk-fill` autopilot class named as a future consumer in
# `Claude files/monitoring-runbook.md` (## Postgres-CPU Autopilot →
# "Future autopilot consumers"). A later wave wires its per-source table +
# safety tags into the postgres-cpu-autopilot.py framework
# (extracted to /opt/algovault-monitoring/autopilot-framework.py at the 3rd
# autopilot consumer) as a Detect stage; recovery stays idempotent-only.
#
# Usage:
#   ops/scripts/disk-forensics.sh <ip> [label]   # probe an explicit host
#   ops/scripts/disk-forensics.sh <token>        # resolve <token> via host-map/env
#   ops/scripts/disk-forensics.sh all            # every token in the host-map
#
# Host resolution carries NO hardcoded IPs (this is a PUBLIC repo). A <token>
# resolves via, in order: env DF_HOST_<token>, then a .gitignored host-map at
# ops/scripts/.disk-forensics-hosts ("<token> <ip>" per line; override the path
# with DF_HOST_MAP). Pass a literal <ip> to skip resolution entirely. The role
# deep-probes key off the tokens 204 (signal-MCP: PG+ClickHouse) and 178 (AOE:
# Prefect+Redis); any other token/ip gets the common attribution only.
#
# Env: SSH_KEY (default ~/.ssh/algovault_deploy), SSH_USER (default root).
# Host-side install (ops/scripts/** is deploy paths-ignored): scp to
# /opt/algovault-monitoring/ and run locally to skip the SSH hop.
set -uo pipefail

SSH_KEY="${SSH_KEY:-$HOME/.ssh/algovault_deploy}"
SSH_USER="${SSH_USER:-root}"
SSH_OPTS=(-i "$SSH_KEY" -o ConnectTimeout=20 -o BatchMode=yes)
TS="$(date -u +%FT%TZ)"

# ---------------------------------------------------------------------------
# Read-only self-assert. The token list is written with single-char classes
# (p[r]une, \b[r]m\b, ...) so this file contains NONE of the literal mutating
# tokens, yet the regex still matches any real usage elsewhere in the file.
# ---------------------------------------------------------------------------
assert_read_only() {
  local src="${BASH_SOURCE[0]}" pat
  pat='p[r]une|d[r]op|t[r]uncate|v[a]cuum|f[l]ushall|f[l]ushdb|\b[r]m\b|--fo[r]ce'
  if grep -nEi "$pat" "$src" >/dev/null 2>&1; then
    echo "[$TS] disk-forensics: READ-ONLY SELF-ASSERT FAILED — a mutating token is present:" >&2
    grep -nEi "$pat" "$src" >&2
    exit 3
  fi
}

# Resolve a host token to "label ip" with NO hardcoded IPs (public repo).
# Order: literal <ip> passed as the token -> env DF_HOST_<token> -> .gitignored
# host-map (ops/scripts/.disk-forensics-hosts, "<token> <ip>" per line).
resolve_host() {
  local tok="$1" lbl="${2:-$1}" here map ip envv
  case "$tok" in
    *[0-9].[0-9]*.[0-9]*.[0-9]* | *:*[0-9a-fA-F]:* ) echo "$lbl $tok"; return 0 ;;
  esac
  envv="DF_HOST_${tok}"
  if [ -n "${!envv:-}" ]; then echo "$tok ${!envv}"; return 0; fi
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  map="${DF_HOST_MAP:-$here/.disk-forensics-hosts}"
  if [ -f "$map" ]; then
    ip="$(awk -v k="$tok" '$1==k{print $2; exit}' "$map")"
    [ -n "$ip" ] && { echo "$tok $ip"; return 0; }
  fi
  echo "[$TS] disk-forensics: cannot resolve '$tok' — pass an <ip>, set $envv, or add it to $map" >&2
  return 1
}

# run a read-only remote command; empty on any failure (fail-soft)
rssh() { ssh "${SSH_OPTS[@]}" "${SSH_USER}@${HOST_IP}" "$1" 2>/dev/null; }

# bytes -> human
human() { numfmt --to=iec --suffix=B "${1:-0}" 2>/dev/null || echo "${1:-0}B"; }

# du a remote path in bytes, staying on one filesystem (-x); 0 on miss
du_b() { local v; v="$(rssh "du -sxb '$1' 2>/dev/null | cut -f1")"; echo "${v:-0}"; }

# safety tag from a source label (allow-list; unknown -> REVIEW)
safety_tag() {
  case "$1" in
    *"image layers"*|*"build-cache"*|*json-log*|*journald*|*apt\ cache*|*"old kernels"*) echo "SAFE" ;;
    *ClickHouse*|*editorial*|*research-archive*|*DuckDB*|*"/var/log (other)"*) echo "REVIEW" ;;
    *Postgres*|*Redis*|*oi_snapshots*|*WAL*|*"image layers (referenced)"*) echo "DO-NOT-TOUCH" ;;
    *) echo "REVIEW" ;;
  esac
}

# attribution accumulator: rows as "bytes|label"
ROWS=()
add() { ROWS+=("${1:-0}|$2"); }

render_table() {
  local used="$1" sum=0 b lbl pct tag
  echo
  printf '%-42s %12s %7s  %s\n' "SOURCE" "SIZE" "%USED" "SAFETY"
  printf '%-42s %12s %7s  %s\n' "------" "----" "-----" "------"
  # sort rows by bytes desc
  local sorted; sorted="$(printf '%s\n' "${ROWS[@]}" | sort -t'|' -k1,1 -nr)"
  while IFS='|' read -r b lbl; do
    [ -z "$lbl" ] && continue
    sum=$((sum + b))
    if [ "$used" -gt 0 ]; then pct="$(awk -v a="$b" -v u="$used" 'BEGIN{printf "%.1f",(a/u)*100}')"; else pct="n/a"; fi
    tag="$(safety_tag "$lbl")"
    printf '%-42s %12s %6s%%  %s\n' "$lbl" "$(human "$b")" "$pct" "$tag"
  done <<< "$sorted"
  local resid=$((used - sum))
  echo   "  ----------------------------------------------------------------------"
  printf '%-42s %12s\n' "Σ attributed"            "$(human "$sum")"
  printf '%-42s %12s\n' "df used (target)"         "$(human "$used")"
  printf '%-42s %12s  (unattributed / fs overhead)\n' "residual" "$(human "$resid")"
  if [ "$used" -gt 0 ]; then
    awk -v r="$resid" -v u="$used" 'BEGIN{printf "  reconciliation: residual = %.1f%% of used (target <=~10%%)\n",(r/u)*100}'
  fi
}

# ---------------------------------------------------------------------------
# Probes
# ---------------------------------------------------------------------------
probe_host() {
  local label="$1"
  echo "================================================================================"
  echo "[$TS] disk-forensics :: $label ($HOST_IP)  [READ-ONLY]"
  echo "================================================================================"

  echo "--- identity ---"
  rssh 'echo "host=$(hostname) nproc=$(nproc)"; free -h | awk "NR==2{print \"mem=\"\$2\" used=\"\$3}"'
  echo "--- df -h / ---"
  rssh 'df -h / | tail -1'
  local used; used="$(rssh "df -B1 --output=used / | tail -1 | tr -d ' '")"; used="${used:-0}"

  echo "--- du -x -h -d1 / (top roots) ---"
  rssh 'du -x -h -d1 / 2>/dev/null | sort -h | tail -18'

  # --- docker path-level tiling (precise on-disk bytes) ---
  # Storage-driver-aware: classic docker keeps image+rw layers under
  # /var/lib/docker/overlay2; the containerd snapshotter (Driver=overlayfs)
  # keeps them under /var/lib/containerd (snapshots + content blobs, deduped
  # with build-cache + container rw-layers). Both are real, non-overlapping
  # paths, so adding both tiles the FS with no double-count (one is ~0).
  ROWS=()
  local drv d_over d_cd d_vol d_ctr d_build d_img d_opt d_journal d_varlog d_apt d_root
  drv="$(rssh 'docker info --format "{{.Driver}}" 2>/dev/null')"
  d_over="$(du_b /var/lib/docker/overlay2)"
  d_cd="$(du_b /var/lib/containerd)"
  d_vol="$(du_b /var/lib/docker/volumes)"
  d_ctr="$(du_b /var/lib/docker/containers)"
  d_build="$(du_b /var/lib/docker/buildkit)"
  d_img="$(du_b /var/lib/docker/image)"
  # container json-logs subtotal (subset of the containers dir); logs are
  # NEVER counted by `docker system df`, so this is the usual hidden creep.
  local d_logs
  d_logs="$(rssh "find /var/lib/docker/containers -name '*-json.log' -printf '%s\n' 2>/dev/null | awk '{s+=\$1} END{print s+0}'")"
  d_logs="${d_logs:-0}"
  echo "   (docker storage driver = ${drv:-unknown}; image store = $( [ "${d_cd:-0}" -gt "${d_over:-0}" ] && echo /var/lib/containerd || echo /var/lib/docker/overlay2 ))"

  add "$d_over"  "docker overlay2 image+rw layers"
  add "$d_cd"    "containerd image+snapshot store (layers+cache+rw)"
  add "$d_build" "docker build-cache (buildkit)"
  add "$d_img"   "docker image metadata"
  add "$((d_ctr > d_logs ? d_ctr - d_logs : 0))" "docker container dir (minus json-logs)"
  add "$d_logs"  "docker container json-logs"

  # --- named volumes, labeled by service + tagged ---
  echo "--- docker named volumes (du of each _data) ---"
  local vols vname vbytes vlabel
  vols="$(rssh "ls -1 /var/lib/docker/volumes 2>/dev/null | grep -v '^backingFsBlockDev$'")"
  while IFS= read -r vname; do
    [ -z "$vname" ] && continue
    vbytes="$(du_b "/var/lib/docker/volumes/$vname/_data")"
    printf '   %-52s %s\n' "$vname" "$(human "$vbytes")"
    case "$vname" in
      *clickhouse*|*events_db*)         vlabel="vol: Plausible ClickHouse [$vname]" ;;
      *plausible*db*|*plausible_db*)     vlabel="vol: Plausible Postgres [$vname]" ;;
      *pg*|*postgres*|*pgdata*|*signal*) vlabel="vol: Postgres data [$vname]" ;;
      *redis*)                           vlabel="vol: Redis persistence [$vname]" ;;
      *duckdb*|*bank*)                   vlabel="vol: DuckDB bank [$vname]" ;;
      *archive*|*candidate*|*research*)  vlabel="vol: research-archive [$vname]" ;;
      *)                                 vlabel="vol: other [$vname]" ;;
    esac
    add "$vbytes" "$vlabel"
  done <<< "$vols"
  # de-double-count: volumes already live under /var/lib/docker/volumes, which
  # is NOT added as its own row above (we tiled overlay2/containers/build/image
  # + per-volume). So the per-volume rows replace the single volumes row.

  # --- non-docker roots ---
  d_opt="$(du_b /opt)"
  d_journal="$(rssh "journalctl --disk-usage 2>/dev/null | grep -oE '[0-9.]+[KMGT]?B' | tail -1 | numfmt --from=iec 2>/dev/null")"; d_journal="${d_journal:-0}"
  d_varlog="$(du_b /var/log)"
  d_apt="$(du_b /var/cache/apt)"
  d_root="$(du_b /root)"
  add "$d_opt"     "/opt (repos + editorial media)"
  add "$((d_varlog>d_journal ? d_varlog-d_journal : 0))" "/var/log (other, excl journald)"
  add "$d_journal" "journald (/var/log/journal)"
  add "$d_apt"     "apt cache (/var/cache/apt)"
  add "$d_root"    "/root (home, caches)"

  render_table "$used"

  echo
  echo "--- docker system df -v (RECLAIMABLE breakdown; read-only) ---"
  rssh 'docker system df -v 2>/dev/null | head -80'
  echo "--- images: dangling / unreferenced ---"
  rssh 'RUN=$(docker ps --format "{{.Image}}" | sort -u);
        docker images --format "{{.Repository}}:{{.Tag}} {{.Size}} {{.ID}} {{.CreatedSince}}" |
        while read repo size id created rest; do
          ref="unreferenced"; echo "$RUN" | grep -qF "${repo%%:*}" && ref="referenced";
          case "$repo" in *"<none>"*) ref="DANGLING";; esac;
          printf "   %-52s %-10s %-14s %s\n" "$repo" "$size" "$created" "$ref";
        done'
  echo "--- container json-logs (per container) ---"
  rssh "find /var/lib/docker/containers -name '*-json.log' -exec du -h {} + 2>/dev/null | sort -h | tail -15"
  echo "--- logging driver + rotation ---"
  rssh 'echo "driver=$(docker info --format "{{.LoggingDriver}}" 2>/dev/null)"; cat /etc/docker/daemon.json 2>/dev/null || echo "no /etc/docker/daemon.json (json-file unbounded unless per-container)"'
  echo "--- old kernels ---"
  rssh 'dpkg --list 2>/dev/null | grep -c linux-image | sed "s/^/   installed linux-image packages: /"'
}

# Host-204-only deep probes (signal PG + oi_snapshots + Plausible ClickHouse)
probe_204_pg_ch() {
  echo "--- [204] Postgres: all databases by size ---"
  local U D
  U="$(rssh "docker exec crypto-quant-signal-mcp-postgres-1 env 2>/dev/null | grep -E '^POSTGRES_USER=' | cut -d= -f2")"
  D="$(rssh "docker exec crypto-quant-signal-mcp-postgres-1 env 2>/dev/null | grep -E '^POSTGRES_DB=' | cut -d= -f2")"
  U="${U:-postgres}"; D="${D:-postgres}"
  echo "   (derived POSTGRES_USER=$U POSTGRES_DB=$D)"
  rssh "docker exec crypto-quant-signal-mcp-postgres-1 psql -U '$U' -d '$D' -tA -F'|' -c \"SELECT datname, pg_size_pretty(pg_database_size(datname)) FROM pg_database ORDER BY pg_database_size(datname) DESC;\""
  echo "--- [204] signal_performance: top 15 relations + dead-tuple bloat ---"
  rssh "docker exec crypto-quant-signal-mcp-postgres-1 psql -U '$U' -d '$D' -tA -F'|' -c \"SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) sz, n_live_tup, n_dead_tup FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 15;\""
  echo "--- [204] oi_snapshots (DO-NOT-TOUCH — intentional permanent retention) ---"
  rssh "docker exec crypto-quant-signal-mcp-postgres-1 psql -U '$U' -d '$D' -tA -F'|' -c \"SELECT 'oi_snapshots' t, count(*) rows, pg_size_pretty(pg_total_relation_size('oi_snapshots')) sz FROM oi_snapshots UNION ALL SELECT 'structural_snapshots', count(*), pg_size_pretty(pg_total_relation_size('structural_snapshots')) FROM structural_snapshots;\" 2>/dev/null"
  echo "--- [204] WAL dir + max_wal_size + replication slots ---"
  rssh "docker exec crypto-quant-signal-mcp-postgres-1 sh -c 'du -sh \$PGDATA/pg_wal 2>/dev/null'"
  rssh "docker exec crypto-quant-signal-mcp-postgres-1 psql -U '$U' -d '$D' -tA -c 'SHOW max_wal_size;'"
  rssh "docker exec crypto-quant-signal-mcp-postgres-1 psql -U '$U' -d '$D' -tA -F'|' -c 'SELECT slot_name, active FROM pg_replication_slots;'"
  echo "--- [204] Plausible ClickHouse: on-disk parts by table + TTL ---"
  rssh "docker exec plausible-ce-plausible_events_db-1 du -sh /var/lib/clickhouse 2>/dev/null"
  rssh "docker exec plausible-ce-plausible_events_db-1 clickhouse-client -q \"SELECT database, table, formatReadableSize(sum(bytes_on_disk)) sz, sum(rows) rows FROM system.parts WHERE active GROUP BY database, table ORDER BY sum(bytes_on_disk) DESC LIMIT 15\" 2>/dev/null"
}

# Host-178-only deep probes (Prefect DB location + Redis)
probe_178_prefect_redis() {
  echo "--- [178] Prefect DB location (tunnel target + masked URL) ---"
  rssh "docker inspect aoe-pg-tunnel --format '{{json .Args}}' 2>/dev/null"
  rssh "docker exec aoe-prefect-server printenv 2>/dev/null | grep -iE 'PREFECT_(API_)?DATABASE|PREFECT_SERVER_DATABASE' | sed -E 's#(//)[^@]*@#\\1***:***@#g'"
  echo "--- [178] Redis persistence + keyspace ---"
  rssh "docker exec aoe-redis sh -c 'ls -lah /data 2>/dev/null'"
  rssh "docker exec aoe-redis redis-cli INFO keyspace 2>/dev/null"
  rssh "docker exec aoe-redis redis-cli INFO persistence 2>/dev/null | grep -E 'aof_enabled|aof_last|rdb_last_save|mem_'"
  rssh "docker exec aoe-redis redis-cli DBSIZE 2>/dev/null"
  echo "--- [178] python pycache / venv footprint ---"
  rssh "du -sxh /opt/algovault/autonomous-optimizer 2>/dev/null; find /opt/algovault -type d -name '__pycache__' 2>/dev/null | wc -l | sed 's/^/   __pycache__ dirs: /'"
}

main() {
  assert_read_only
  local targets=()
  case "${1:-}" in
    ""|-h|--help) grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    all) local _map="${DF_HOST_MAP:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.disk-forensics-hosts}"
         [ -f "$_map" ] || { echo "[$TS] 'all' needs the host-map $_map" >&2; exit 2; }
         while read -r _tok _; do case "$_tok" in ""|\#*) ;; *) targets+=("$_tok") ;; esac; done < "$_map" ;;
    *)   targets=("$1") ;;
  esac
  for t in "${targets[@]}"; do
    read -r LBL HOST_IP <<< "$(resolve_host "$t" "${2:-}")" || true
    if [ -z "${HOST_IP:-}" ]; then echo "[$TS] skipping unresolved host '$t'" >&2; continue; fi
    export HOST_IP
    probe_host "$LBL"
    case "$t" in
      204) probe_204_pg_ch ;;
      178) probe_178_prefect_redis ;;
    esac
    echo
  done
  echo "[$TS] disk-forensics: done (READ-ONLY — zero mutating commands executed)."
}
main "$@"
