#!/usr/bin/env bash
# bot-deploy-parity.sh — OPS-BOT-DEPLOY-PROVENANCE-W1 (L3)
#
# Daily: does the live /opt/algovault-bot tree still match the commit it was deployed from, and
# is that commit still a sane thing to be running?
#
# ── Why this exists ──────────────────────────────────────────────────────────
# 2026-08-02: a full-tree rsync from a stale shared checkout DELETED dispatch_schedule.py from
# the running bot. Prod silently reverted to its old scheduler. Nothing detected it — it
# surfaced 90 minutes later only because an unrelated liveness probe happened to be armed. This
# canary is the detection that was missing; `MISSING` is literally that failure.
#
# ── How it verifies without a git checkout ───────────────────────────────────
# The host has no clone of the bot repo, and giving it one would just be a second tree to
# drift. Instead `host-deploy.sh` writes DEPLOYED_MANIFEST.sha256 — per-file hashes taken FROM
# THE COMMIT, not from the host — and this compares the live tree against it. Hashing the host
# tree at deploy time would have made this tautological: it would only ever confirm the tree
# matches itself.
#
# The deployed path set comes from ops/deploy/algovault-bot.manifest, the SAME file host-deploy
# reads. Inferring it instead is how a parity check invents phantom findings: `audits/` and
# `hooks/` are tracked but deliberately not deployed, and a naive comparison reports both as
# MISSING on its first run.
#
# Verdict-token contract (CLAUDE.md): exactly ONE terminal
# BOT_DEPLOY_PARITY_VERDICT=PASS|FAIL|INDETERMINATE, and callers gate on the TOKEN. Codes are
# 0=PASS / 1=FAIL / 3=INDETERMINATE — 3 is the token-law default for a NEW gate.
# check_test_baseline.sh is 2 only because it already deployed 2 for that meaning; these two
# code spaces are deliberately different and nothing maps between them. Do not "align" them.
#
# Fails CLOSED: an unreadable manifest, stamp or lockfile is INDETERMINATE, never a pass — a
# guard that cannot read its own inputs and exits 0 is indistinguishable from a healthy one,
# which is the exact defect that made monitoring-inventory-reconcile.py log
# INVENTORY_LOAD_FAILED and exit 0 on its first unattended run.
set -uo pipefail

DEST=${BOT_DEPLOY_DEST:-/opt/algovault-bot}
MANIFEST=${BOT_DEPLOY_MANIFEST:-/opt/crypto-quant-signal-mcp/ops/deploy/algovault-bot.manifest}
TG=${BOT_DEPLOY_TG:-/opt/algovault-monitoring/send_telegram.sh}
STAMP="$DEST/DEPLOYED_SHA"
LOCK="$DEST/DEPLOYED_MANIFEST.sha256"
# A deploy older than this that is also behind origin/main escalates from report to alert.
BEHIND_ESCALATE_DAYS=${BOT_DEPLOY_BEHIND_DAYS:-14}

verdict() { echo "BOT_DEPLOY_PARITY_VERDICT=$1"; exit "$2"; }

# ── shared manifest parser — keep in sync with ops/scripts/host-deploy.sh ────
manifest_paths() {   # <manifest> <verb>
  grep -vE '^[[:space:]]*#' "$1" 2>/dev/null \
    | awk -v verb="$2" '$1 == verb { print $2 }' \
    | grep -v '^$'
}

# ── alert routing: ONE id, ONE remedy. Templated, never a literal wave ───────
recommended_wave_for() {
  case "$1" in
    BOT_DEPLOY_TREE_DIVERGED) printf 'OPS-BOT-DEPLOY-DIVERGENCE-W{NEXT}';;
    BOT_DEPLOY_SHA_UNMERGED)  printf 'OPS-BOT-DEPLOY-UNMERGED-W{NEXT}';;
  esac
}

alert() {   # <alert_id> <body>
  local aid="$1"; shift
  local wave; wave=$(recommended_wave_for "$aid")
  printf '🛑 %s\n\n%s\n\nHost tree: %s\nStamp: %s\n\nAction: dispatch %s via Cowork → Claude Code\n' \
    "$aid" "$*" "$DEST" "$STAMP" "$wave" \
    | "$TG" "$aid" CRITICAL_PERSISTENT - || true
}

# ── --self-test: hermetic, no host, no network, vacuity-guarded ─────────────
self_test() {
  local pass=0 fire=0 nofire=0 map=0 fail=0
  local tmp; tmp=$(mktemp -d "${TMPDIR:-/tmp}/parity.XXXXXX") || return 3
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN
  check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else echo "  FAIL $1: expected '$2' got '$3'"; fail=1; fi; }

  cat > "$tmp/m" <<'EOF'
# a comment saying: deploy notreal
deploy  src
deploy  pyproject.toml
ignore  .venv
EOF
  map=$((map+1)); check "deploy parse"  "src pyproject.toml " "$(manifest_paths "$tmp/m" deploy | tr '\n' ' ')"
  map=$((map+1)); check "ignore parse"  ".venv "              "$(manifest_paths "$tmp/m" ignore | tr '\n' ' ')"
  map=$((map+1)); check "comment is not an entry" "" "$(manifest_paths "$tmp/m" deploy | grep notreal || true)"
  map=$((map+1)); check "waves are distinct per id" "distinct" \
    "$([ "$(recommended_wave_for BOT_DEPLOY_TREE_DIVERGED)" != "$(recommended_wave_for BOT_DEPLOY_SHA_UNMERGED)" ] && echo distinct || echo shared)"
  # grep, not a `case` — a `*)` arm inside "$( … )" closes the substitution early, which is how
  # this assertion first "failed" against correct code.
  map=$((map+1)); check "wave stays templated" "yes" \
    "$(recommended_wave_for BOT_DEPLOY_TREE_DIVERGED | grep -q 'W{NEXT}$' && echo yes || echo no)"
  map=$((map+1)); check "a literal wave number would be caught" "no" \
    "$(printf 'OPS-THING-W3' | grep -q 'W{NEXT}$' && echo yes || echo no)"

  # A tiny fixture tree exercising all three file-level checks at once.
  mkdir -p "$tmp/t/src"
  printf 'alpha\n' > "$tmp/t/src/keep.py"
  printf 'CHANGED\n' > "$tmp/t/src/drift.py"
  printf 'stray\n'   > "$tmp/t/src/orphan.py"
  {
    printf '%s  src/keep.py\n'    "$(printf 'alpha\n'    | shasum -a 256 | cut -d' ' -f1)"
    printf '%s  src/drift.py\n'   "$(printf 'original\n' | shasum -a 256 | cut -d' ' -f1)"
    printf '%s  src/deleted.py\n' "$(printf 'gone\n'     | shasum -a 256 | cut -d' ' -f1)"
  } | sort -k2 > "$tmp/t/lock"

  local res; res=$(compare_tree "$tmp/t" "$tmp/t/lock" "src")
  fire=$((fire+1)); check "MISSING detected by NAME"    "src/deleted.py" "$(echo "$res" | awk '$1=="MISSING"{print $2}')"
  fire=$((fire+1)); check "HASH_DRIFT detected by NAME" "src/drift.py"   "$(echo "$res" | awk '$1=="HASH_DRIFT"{print $2}')"
  fire=$((fire+1)); check "ORPHAN detected by NAME"     "src/orphan.py"  "$(echo "$res" | awk '$1=="ORPHAN"{print $2}')"

  # must-not-fire: a tree that matches its lockfile exactly yields nothing at all.
  mkdir -p "$tmp/c/src"; printf 'alpha\n' > "$tmp/c/src/keep.py"
  printf '%s  src/keep.py\n' "$(printf 'alpha\n' | shasum -a 256 | cut -d' ' -f1)" | sort -k2 > "$tmp/c/lock"
  nofire=$((nofire+1)); check "clean tree is silent" "" "$(compare_tree "$tmp/c" "$tmp/c/lock" "src")"
  nofire=$((nofire+1)); check "clean tree counts 1 verified" "1" "$(compare_tree "$tmp/c" "$tmp/c/lock" "src" --count)"

  if [ "$fire" -eq 0 ] || [ "$nofire" -eq 0 ] || [ "$map" -eq 0 ]; then
    echo "self-test VACUOUS: $fire must-fire, $nofire must-not-fire, $map must-map"; return 3
  fi
  [ "$fail" -eq 0 ] || { echo "self-test FAILED across $fire must-fire, $nofire must-not-fire, $map must-map"; return 1; }
  echo "self-test passed: $fire must-fire, $nofire must-not-fire, $map must-map ($pass assertions)"
  return 0
}

# ── the comparison, factored out so --self-test can drive it hermetically ────
# <root> <lockfile> <deploy-paths…> [--count] -> lines of "<KIND> <relpath>", or a verified count
compare_tree() {
  local root="$1" lock="$2"; shift 2
  local want_count=0 paths=() ignores=()
  for a in "$@"; do
    case "$a" in
      --count) want_count=1;;
      --ignore=*) ignores+=("${a#--ignore=}");;
      *) paths+=("$a");;
    esac
  done

  local live; live=$(mktemp) || return 3
  local expect; expect=$(mktemp) || return 3
  # shellcheck disable=SC2064
  trap "rm -f '$live' '$expect'" RETURN

  ( cd "$root" 2>/dev/null || exit 0
    for p in "${paths[@]}"; do
      [ -e "$p" ] || continue
      find "$p" -type f ! -name '*.pyc' ! -path '*__pycache__*' ! -name '*.bak.*' ! -name '*.swapout-*' 2>/dev/null
    done ) | sort > "$live"

  # `ignore` entries apply INSIDE deploy paths too, as path prefixes — not just at top level.
  # The live run surfaced why: `pip install -e .` generates src/algovault_bot.egg-info/*, which
  # is a real build artifact and a genuine ORPHAN by the letter of the check. Declaring it here
  # keeps ONE list governing both consumers, instead of a second hard-coded skip list drifting
  # inside the canary.
  if [ ${#ignores[@]} -gt 0 ]; then
    local keep; keep=$(mktemp) || return 3
    cp "$live" "$keep"
    for ig in "${ignores[@]}"; do
      grep -v -- "^${ig}\(/\|$\)" "$keep" > "$keep.n" 2>/dev/null && mv "$keep.n" "$keep"
    done
    mv "$keep" "$live"
  fi
  sort -k2 "$lock" | awk '{print $2}' > "$expect"

  if [ "$want_count" -eq 1 ]; then grep -c . "$live"; return 0; fi

  comm -13 "$live" "$expect" | sed 's/^/MISSING /'
  comm -23 "$live" "$expect" | sed 's/^/ORPHAN /'
  while IFS= read -r f; do
    local want have
    want=$(awk -v f="$f" '$2==f {print $1}' "$lock")
    have=$(cd "$root" && shasum -a 256 "$f" 2>/dev/null | cut -d' ' -f1)
    [ -n "$want" ] && [ -n "$have" ] && [ "$want" != "$have" ] && echo "HASH_DRIFT $f"
  done < <(comm -12 "$live" "$expect")
  return 0
}

[ "${1:-}" = "--self-test" ] && { self_test; exit $?; }

# ── live run ────────────────────────────────────────────────────────────────
[ -r "$MANIFEST" ] || { echo "manifest unreadable: $MANIFEST"; verdict INDETERMINATE 3; }
[ -r "$STAMP" ]    || { echo "no deploy stamp at $STAMP — this host has never been deployed by ops/scripts/host-deploy.sh, so parity cannot be judged"; verdict INDETERMINATE 3; }
[ -r "$LOCK" ]     || { echo "no lockfile at $LOCK — cannot verify the tree against its commit"; verdict INDETERMINATE 3; }

DEPLOY_PATHS=$(manifest_paths "$MANIFEST" deploy)
# Same file, second verb — the canary and host-deploy.sh must never disagree about scope.
IGNORE_ARGS=$(manifest_paths "$MANIFEST" ignore | sed 's/^/--ignore=/' | tr '\n' ' ')
[ -n "$DEPLOY_PATHS" ] || { echo "manifest declares no deploy paths — nothing would be verified"; verdict INDETERMINATE 3; }

SHA=$(awk -F= '$1=="sha"{print $2}' "$STAMP")
SHORT=$(awk -F= '$1=="short"{print $2}' "$STAMP")
UNMERGED=$(awk -F= '$1=="unmerged"{print $2}' "$STAMP")
REMOTE=$(awk -F= '$1=="remote"{print $2}' "$STAMP")
DEPLOY_EPOCH=$(awk -F= '$1=="deployed_at_epoch"{print $2}' "$STAMP")
[ -n "$SHA" ] || { echo "stamp has no sha= line"; verdict INDETERMINATE 3; }

# shellcheck disable=SC2086
FINDINGS=$(compare_tree "$DEST" "$LOCK" $DEPLOY_PATHS $IGNORE_ARGS)
# shellcheck disable=SC2086
N_VERIFIED=$(compare_tree "$DEST" "$LOCK" $DEPLOY_PATHS $IGNORE_ARGS --count)
N_LOCKED=$(grep -c . "$LOCK")

n_missing=$(echo "$FINDINGS" | grep -c '^MISSING '  || true)
n_orphan=$(echo "$FINDINGS"  | grep -c '^ORPHAN '   || true)
n_drift=$(echo "$FINDINGS"   | grep -c '^HASH_DRIFT ' || true)

# POSITIVE per-check output naming measured counts — asserting absence-of-alert is the
# anti-pattern this repo has been bitten by repeatedly.
echo "  deployed sha:  $SHORT (unmerged=$UNMERGED)"
echo "  CHECK MISSING:     $n_missing  (of $N_LOCKED files in the lockfile)"
[ "$n_missing" -gt 0 ] && echo "$FINDINGS" | grep '^MISSING '    | sed 's/^/    /'
echo "  CHECK ORPHAN:      $n_orphan  ($N_VERIFIED files live under the deploy paths)"
[ "$n_orphan"  -gt 0 ] && echo "$FINDINGS" | grep '^ORPHAN '     | sed 's/^/    /'
echo "  CHECK HASH_DRIFT:  $n_drift"
[ "$n_drift"   -gt 0 ] && echo "$FINDINGS" | grep '^HASH_DRIFT ' | sed 's/^/    /'
echo "  CHECK SHA_UNMERGED: $([ "$UNMERGED" = "true" ] && echo 'BREACH — deployed from a ref that is not on origin/main' || echo 'ok')"

# SHA_BEHIND without a clone: ask the origin for its head. Reports "not current", not a commit
# distance — counting commits needs the object graph, and a number this host cannot compute
# honestly is worse than the fact it can.
BEHIND="unknown"
if [ -n "$REMOTE" ] && [ "$REMOTE" != "unknown" ] && command -v git >/dev/null 2>&1; then
  HEAD_SHA=$(git ls-remote "$REMOTE" refs/heads/main 2>/dev/null | awk '{print $1}')
  if [ -n "$HEAD_SHA" ]; then
    [ "$HEAD_SHA" = "$SHA" ] && BEHIND="current" || BEHIND="not-at-head(origin/main=${HEAD_SHA:0:7})"
  fi
fi
AGE_DAYS=$([ -n "$DEPLOY_EPOCH" ] && echo $(( ( $(date -u +%s) - DEPLOY_EPOCH ) / 86400 )) || echo "?")
echo "  CHECK SHA_BEHIND:   $BEHIND  (deployed ${AGE_DAYS}d ago)"

FAILED=0
if [ "$n_missing" -gt 0 ] || [ "$n_drift" -gt 0 ]; then
  FAILED=1
  alert BOT_DEPLOY_TREE_DIVERGED "The live tree no longer matches the commit it was deployed from ($SHORT).
MISSING: $n_missing   HASH_DRIFT: $n_drift   ORPHAN: $n_orphan
$(echo "$FINDINGS" | grep -E '^(MISSING|HASH_DRIFT) ' | head -20)

A MISSING file is what happened on 2026-08-02: a full-tree rsync from a stale checkout deleted
dispatch_schedule.py and the bot silently reverted its scheduler.
Redeploy with: ops/scripts/host-deploy.sh --repo <bot> --ref origin/main …"
fi
if [ "$UNMERGED" = "true" ]; then
  FAILED=1
  alert BOT_DEPLOY_SHA_UNMERGED "Prod is running $SHORT, deployed with --force-unmerged: it is NOT an ancestor of origin/main.
Code that exists in no shared ref is one rsync away from being deleted with nobody noticing.
Merge it and redeploy from origin/main."
fi
if [ "$BEHIND" != "current" ] && [ "$BEHIND" != "unknown" ] && [ "$AGE_DAYS" != "?" ] && [ "$AGE_DAYS" -gt "$BEHIND_ESCALATE_DAYS" ]; then
  echo "  NOTE: behind origin/main for ${AGE_DAYS}d (> ${BEHIND_ESCALATE_DAYS}d) — reported, not paged"
fi

[ "$FAILED" -eq 0 ] && verdict PASS 0 || verdict FAIL 1
