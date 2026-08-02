#!/usr/bin/env bash
# checkout-parity.sh — OPS-HOST-DEPLOY-PROVENANCE-ROLLOUT-W1
#
# Daily: for every git-checkout service on this host, is HEAD a commit anyone else can see, is
# the working tree what the ref says it is, and is every file owned by a uid that exists?
#
# ── Why this is a SECOND canary and not a wider bot-deploy-parity ─────────────
# `bot-deploy-parity.sh` verifies a tree that ops/scripts/host-deploy.sh PLACED, against a
# per-file lockfile that tool wrote from the commit. These three services are placed by git
# (GHA for signal-MCP, host pulls for the others), so `git` itself is the lockfile — asking it
# is cheaper and cannot drift from the thing it describes. Same verdict-token contract, same
# fail-closed discipline, different evidence source.
#
# ── The three checks, and why each one is here ───────────────────────────────
#   HEAD_UNMERGED   HEAD is not an ancestor of origin/main -> prod is running a commit that
#                   exists in no shared ref. Exactly the 2026-08-02 state that let a later rsync
#                   delete a module nobody could recover from a branch.
#   TREE_DIRTY      a tracked file differs from HEAD, outside the declared allowlist. On
#                   signal-MCP the build-time SoT injector makes README.md + landing/*.html dirty
#                   on EVERY deploy by design; those are declared in checkout-parity.conf, so
#                   this check stays credible instead of firing daily and being muted.
#   FOREIGN_UID     a file owned by a uid that does not exist on this box. Measured 2026-08-02:
#                   113 such files under crypto-quant-signal-mcp — a CI-DEPLOYED repo. That is
#                   the proof the deploy trigger was never the issue; a hand `rsync -a` from a
#                   macOS checkout reaches a CI-deployed tree just as easily.
#
# Verdict-token contract (CLAUDE.md): exactly ONE terminal
# CHECKOUT_PARITY_VERDICT=PASS|FAIL|INDETERMINATE; callers gate on the TOKEN. Codes 0=PASS /
# 1=FAIL / 3=INDETERMINATE — 3 is the token-law default for a NEW gate. check_test_baseline.sh
# is 2 only because it already deployed 2; nothing maps between the two spaces. Do not align.
#
# Fails CLOSED: an unreadable config, or a configured path that is not a git repo, is
# INDETERMINATE — never a pass. A guard that cannot read its own inputs and exits 0 is
# indistinguishable from a healthy one.
set -uo pipefail

CONF=${CHECKOUT_PARITY_CONF:-/opt/crypto-quant-signal-mcp/ops/deploy/checkout-parity.conf}
TG=${CHECKOUT_PARITY_TG:-/opt/algovault-monitoring/send_telegram.sh}
# `git` refuses a repo it does not own ("detected dubious ownership") and that refusal is
# indistinguishable from "not a repo" — which is precisely how Step 0's first sweep mis-classified
# two services. Bypass it explicitly rather than inherit the ambiguity.
GIT=(git -c safe.directory=*)

verdict() { echo "CHECKOUT_PARITY_VERDICT=$1"; exit "$2"; }

# ── config parsing ──────────────────────────────────────────────────────────
conf_services() { grep -vE '^[[:space:]]*#' "$1" 2>/dev/null | awk '$1=="service"{print $2"|"$3}' | grep -v '^$'; }
# Per-service `allow` rows, plus the stamp this wave writes into every asserted checkout.
# DEPLOYED_SHA is untracked by construction in all three, so it is allowed GLOBALLY rather than
# repeated as a row per service — a fact that is true of every service by definition is not a
# per-service declaration, and copying it three times invites the copies to diverge. The canary
# reported it on all three on its first post-stamp run, which is the check working: the tool's
# own output is still output.
conf_allows()   {
  grep -vE '^[[:space:]]*#' "$1" 2>/dev/null | awk -v s="$2" '$1=="allow" && $2==s {print $3}'
  printf 'DEPLOYED_SHA\n'
}

# ── alert routing: one id per service, one templated wave per id ─────────────
alert_id_for() {
  case "$1" in
    crypto-quant-signal-mcp) printf 'CHECKOUT_PARITY_SIGNAL_MCP';;
    algovault-editorial)     printf 'CHECKOUT_PARITY_EDITORIAL';;
    algovault-blog-assets)   printf 'CHECKOUT_PARITY_BLOG_ASSETS';;
    *)                       printf 'CHECKOUT_PARITY_UNKNOWN_SERVICE';;
  esac
}
recommended_wave_for() {
  case "$1" in
    CHECKOUT_PARITY_SIGNAL_MCP)       printf 'OPS-CHECKOUT-PARITY-SIGNAL-MCP-W{NEXT}';;
    CHECKOUT_PARITY_EDITORIAL)        printf 'OPS-CHECKOUT-PARITY-EDITORIAL-W{NEXT}';;
    CHECKOUT_PARITY_BLOG_ASSETS)      printf 'OPS-CHECKOUT-PARITY-BLOG-ASSETS-W{NEXT}';;
    CHECKOUT_PARITY_UNKNOWN_SERVICE)  printf 'OPS-CHECKOUT-PARITY-CONFIG-W{NEXT}';;
  esac
}

alert() {   # <service> <body>
  local svc="$1"; shift
  local aid; aid=$(alert_id_for "$svc")
  local wave; wave=$(recommended_wave_for "$aid")
  printf '🛑 %s\n\n%s\n\nService: %s\nConfig: %s\n\nAction: dispatch %s via Cowork → Claude Code\n' \
    "$aid" "$*" "$svc" "$CONF" "$wave" \
    | "$TG" "$aid" CRITICAL_PERSISTENT - || true
}

# ── dirty-tree filter, factored out so --self-test can drive it hermetically ─
# <porcelain-output> <allow-glob…> -> the porcelain lines that are NOT allowed
filter_dirty() {
  local porcelain="$1"; shift
  local line path allowed g
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    path=${line:3}
    allowed=0
    for g in "$@"; do
      [ -z "$g" ] && continue
      # shellcheck disable=SC2254  # $g is a glob by design
      case "$path" in $g) allowed=1; break;; esac
    done
    [ "$allowed" -eq 0 ] && printf '%s\n' "$line"
  done <<< "$porcelain"
  return 0
}

# ── --self-test: hermetic, no host, no git, vacuity-guarded ─────────────────
self_test() {
  local pass=0 fire=0 nofire=0 map=0 fail=0
  local tmp; tmp=$(mktemp -d "${TMPDIR:-/tmp}/cparity.XXXXXX") || return 3
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN
  check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else echo "  FAIL $1: expected '$2' got '$3'"; fail=1; fi; }

  cat > "$tmp/c" <<'EOF'
# a comment saying: service notreal /opt/notreal:root:root
service  svc-a  /opt/a:root:root
allow    svc-a  README.md
allow    svc-a  landing/*.html
service  svc-b  /opt/b:algovault:algovault
EOF
  map=$((map+1)); check "service parse" "svc-a|/opt/a:root:root svc-b|/opt/b:algovault:algovault " "$(conf_services "$tmp/c" | tr '\n' ' ')"
  map=$((map+1)); check "allow parse (scoped) + the global stamp row" "README.md landing/*.html DEPLOYED_SHA " "$(conf_allows "$tmp/c" svc-a | tr '\n' ' ')"
  map=$((map+1)); check "allows do not leak across services" "DEPLOYED_SHA " "$(conf_allows "$tmp/c" svc-b | tr '\n' ' ')"
  map=$((map+1)); check "the stamp is allowed everywhere by construction" "DEPLOYED_SHA " "$(conf_allows "$tmp/c" never-configured | tr '\n' ' ')"
  map=$((map+1)); check "a commented service is not parsed" "" "$(conf_services "$tmp/c" | grep notreal || true)"
  map=$((map+1)); check "waves are distinct per id" "distinct" \
    "$([ "$(recommended_wave_for CHECKOUT_PARITY_SIGNAL_MCP)" != "$(recommended_wave_for CHECKOUT_PARITY_EDITORIAL)" ] && echo distinct || echo shared)"
  map=$((map+1)); check "wave stays templated" "yes" \
    "$(recommended_wave_for CHECKOUT_PARITY_SIGNAL_MCP | grep -q 'W{NEXT}$' && echo yes || echo no)"

  local porcelain=' M README.md
 M landing/index.html
 M src/index.ts
?? stray.txt'
  # must-fire: a real source change is NOT covered by the injector allowlist
  fire=$((fire+1)); check "unallowed dirty file is reported by NAME" " M src/index.ts
?? stray.txt" "$(filter_dirty "$porcelain" 'README.md' 'landing/*.html')"
  # must-fire: with NO allowlist, everything is reported — the allowlist is doing real work
  fire=$((fire+1)); check "no allowlist -> all 4 reported" "4" "$(filter_dirty "$porcelain" '' | grep -c .)"
  # must-not-fire: the injector's own output is silent when declared
  nofire=$((nofire+1)); check "declared injector output is silent" "" \
    "$(filter_dirty ' M README.md
 M landing/faq.html' 'README.md' 'landing/*.html')"
  nofire=$((nofire+1)); check "a clean tree is silent" "" "$(filter_dirty '' 'README.md')"

  if [ "$fire" -eq 0 ] || [ "$nofire" -eq 0 ] || [ "$map" -eq 0 ]; then
    echo "self-test VACUOUS: $fire must-fire, $nofire must-not-fire, $map must-map"; return 3
  fi
  [ "$fail" -eq 0 ] || { echo "self-test FAILED across $fire must-fire, $nofire must-not-fire, $map must-map"; return 1; }
  echo "self-test passed: $fire must-fire, $nofire must-not-fire, $map must-map ($pass assertions)"
  return 0
}

[ "${1:-}" = "--self-test" ] && { self_test; exit $?; }

# ── live run ────────────────────────────────────────────────────────────────
[ -r "$CONF" ] || { echo "config unreadable: $CONF"; verdict INDETERMINATE 3; }
SERVICES=$(conf_services "$CONF")
[ -n "$SERVICES" ] || { echo "config declares no services — nothing would be verified"; verdict INDETERMINATE 3; }

FAILED=0
N_SVC=0
while IFS= read -r row; do
  [ -z "$row" ] && continue
  SVC=${row%%|*}
  REST=${row#*|}
  DIR=${REST%%:*}
  OWNER=${REST#*:}
  N_SVC=$((N_SVC + 1))

  echo "  ── $SVC ($DIR)"
  if ! "${GIT[@]}" -C "$DIR" rev-parse --git-dir >/dev/null 2>&1; then
    echo "     not a git repository — cannot assert provenance"
    verdict INDETERMINATE 3
  fi

  HEAD=$("${GIT[@]}" -C "$DIR" rev-parse --short HEAD 2>/dev/null)
  "${GIT[@]}" -C "$DIR" fetch -q origin 2>/dev/null || echo "     WARNING: fetch failed; ancestry judged against a possibly-stale origin/main"
  ORIGIN=$("${GIT[@]}" -C "$DIR" rev-parse --short origin/main 2>/dev/null || echo 'none')

  # CHECK 1 — HEAD_UNMERGED
  if "${GIT[@]}" -C "$DIR" merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
    echo "     CHECK HEAD_UNMERGED:  ok       (HEAD=$HEAD, origin/main=$ORIGIN)"
  else
    echo "     CHECK HEAD_UNMERGED:  BREACH   (HEAD=$HEAD is not an ancestor of origin/main=$ORIGIN)"
    FAILED=1
    alert "$SVC" "HEAD $HEAD is NOT an ancestor of origin/main ($ORIGIN): this service is running a commit that exists in no shared ref.
That is the 2026-08-02 state — code live in production and on no branch, one rsync away from being deleted with nobody able to recover it from a ref.
Merge or reset it to a shared commit."
  fi

  # CHECK 2 — TREE_DIRTY, modulo the declared allowlist
  mapfile -t ALLOWS < <(conf_allows "$CONF" "$SVC")
  PORCELAIN=$("${GIT[@]}" -C "$DIR" status --porcelain 2>/dev/null)
  N_DIRTY=$(printf '%s' "$PORCELAIN" | grep -c . || true)
  UNALLOWED=$(filter_dirty "$PORCELAIN" "${ALLOWS[@]:-}")
  N_UNALLOWED=$(printf '%s' "$UNALLOWED" | grep -c . || true)
  echo "     CHECK TREE_DIRTY:     $N_UNALLOWED unallowed  ($N_DIRTY dirty, ${#ALLOWS[@]} allow rule(s))"
  if [ "$N_UNALLOWED" -gt 0 ]; then
    printf '%s\n' "$UNALLOWED" | sed 's/^/       /'
    FAILED=1
    alert "$SVC" "$N_UNALLOWED tracked file(s) differ from HEAD outside the declared allowlist:
$(printf '%s' "$UNALLOWED" | head -20)
Either the host was edited directly, or a legitimate host-side generator needs an \`allow\` row in checkout-parity.conf with its reason."
  fi

  # CHECK 3 — FOREIGN_UID
  N_FOREIGN=$(find "$DIR" -uid 501 2>/dev/null | wc -l | tr -d ' ')
  echo "     CHECK FOREIGN_UID:    $N_FOREIGN  (expected owner $OWNER)"
  if [ "$N_FOREIGN" -gt 0 ]; then
    FAILED=1
    alert "$SVC" "$N_FOREIGN file(s) owned by uid 501, which does not exist on this host.
That is a macOS uid preserved by \`rsync -a\` from the operator's machine. Expected owner: $OWNER.
Fix: chown -R $OWNER $DIR (and re-deploy through the proper path so it does not recur)."
  fi
done <<< "$SERVICES"

echo "  services asserted: $N_SVC"
[ "$N_SVC" -eq 0 ] && { echo "no service rows evaluated"; verdict INDETERMINATE 3; }
[ "$FAILED" -eq 0 ] && verdict PASS 0 || verdict FAIL 1
