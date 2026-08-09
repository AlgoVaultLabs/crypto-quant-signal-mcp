#!/usr/bin/env bash
# host-deploy.sh — OPS-BOT-DEPLOY-PROVENANCE-W1 (L1)
#
# Deploy an explicit COMMITTED SHA to a Hetzner host. Generic and parameterized, because R0
# measured that 7 substantive live services under /opt are not git checkouts and NOT ONE of the
# 16 records which commit it is running. This is the primitive; the per-service rollout is
# OPS-HOST-DEPLOY-PROVENANCE-ROLLOUT-W{NEXT}.
#
# ── The incident this exists to make impossible ──────────────────────────────
# 2026-08-02. `dispatch_schedule.py` reached prod by a hand `rsync` from a worktree; the module
# was on NO branch (`git merge-base --is-ancestor` → NO). Hours later a full-tree `rsync` from a
# SHARED checkout — sitting on an unrelated branch — shipped that tree to the same host, restored
# July-9 files and DELETED the module. The bot silently reverted to its old scheduler. Nothing
# detected it; an unrelated liveness probe tripped over it 90 minutes later by luck of timing.
#
# Two properties would each have prevented it, and both are enforced here:
#   1. a deploy REFUSES a ref that is not an ancestor of origin/main  (the first rsync)
#   2. a deploy ships a RESOLVED COMMIT, never a working directory     (the second rsync)
#
# ── Why not a whole-directory atomic swap ────────────────────────────────────
# /opt/algovault-bot holds `.venv` — 5021 files, 171M — alongside the source, and the units run
# `/opt/algovault-bot/.venv/bin/python`. Swapping the directory would delete the interpreter.
# So the swap is PER-ENTRY over the manifest's `deploy` lines; anything not in the archive is
# untouched by construction. Persistent state lives in /var/lib/algovault-bot and is never in
# scope here.
#
# Usage:
#   ops/scripts/host-deploy.sh --repo ~/code/algovault-bot --ref origin/main \
#       --host root@204.168.185.24 --dest /opt/algovault-bot \
#       --manifest ops/deploy/algovault-bot.manifest \
#       --owner algovault-bot:algovault-bot \
#       --units algovault-bot.service,algovault-bot-cron.timer
#   …plus --force-unmerged for a genuine emergency (logs loudly, stamps the deploy unmerged so
#   the parity canary ALERTS on it — an escape hatch that hides its own use is how this recurs).
set -uo pipefail

SSH_KEY=${SSH_KEY:-$HOME/.ssh/algovault_deploy}
REPO="" REF="origin/main" HOST="" DEST="" MANIFEST="" OWNER="" UNITS="" FORCE_UNMERGED=0 DRY_RUN=0

die() { echo "host-deploy: $*" >&2; exit 1; }
say() { printf '[host-deploy] %s\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2;;
    --ref) REF="$2"; shift 2;;
    --host) HOST="$2"; shift 2;;
    --dest) DEST="$2"; shift 2;;
    --manifest) MANIFEST="$2"; shift 2;;
    --owner) OWNER="$2"; shift 2;;
    --units) UNITS="$2"; shift 2;;
    --force-unmerged) FORCE_UNMERGED=1; shift;;
    --dry-run) DRY_RUN=1; shift;;
    --self-test) shift; SELF_TEST=1;;
    *) die "unknown argument: $1";;
  esac
done

# ── manifest parsing (shared with the parity canary; keep the format in sync) ─
manifest_paths() {   # <manifest> <verb>
  grep -vE '^[[:space:]]*#' "$1" 2>/dev/null \
    | awk -v verb="$2" '$1 == verb { print $2 }' \
    | grep -v '^$'
}

if [ "${SELF_TEST:-0}" = "1" ]; then
  # Hermetic: parsing only, no repo, no host. Two-way and vacuity-guarded.
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/hostdeploy.XXXXXX") || exit 3
  trap 'rm -rf "$tmp"' EXIT
  cat > "$tmp/m" <<'EOF'
# a comment mentioning: deploy notreal
deploy  src              # reason
deploy  pyproject.toml   # reason
ignore  .venv            # reason
EOF
  fire=0 nofire=0 fail=0
  got_deploy=$(manifest_paths "$tmp/m" deploy | tr '\n' ' ')
  got_ignore=$(manifest_paths "$tmp/m" ignore | tr '\n' ' ')
  nofire=$((nofire+1)); [ "$got_deploy" = "src pyproject.toml " ] || { echo "FAIL deploy parse: '$got_deploy'"; fail=1; }
  nofire=$((nofire+1)); [ "$got_ignore" = ".venv " ] || { echo "FAIL ignore parse: '$got_ignore'"; fail=1; }
  # must-fire: a commented line must NOT be parsed as an entry — a mention is not a declaration,
  # the same rule check-canaries-wired.mjs applies for the same reason.
  fire=$((fire+1)); case "$got_deploy" in *notreal*) echo "FAIL comment was parsed as an entry"; fail=1;; esac
  fire=$((fire+1)); [ -z "$(manifest_paths "$tmp/m" bogus)" ] || { echo "FAIL unknown verb returned entries"; fail=1; }
  if [ "$fire" -eq 0 ] || [ "$nofire" -eq 0 ]; then
    echo "self-test VACUOUS: $fire must-fire, $nofire must-not-fire"; exit 3
  fi
  [ "$fail" -eq 0 ] || { echo "self-test FAILED"; exit 1; }
  echo "self-test passed: $fire must-fire, $nofire must-not-fire"
  exit 0
fi

[ -n "$REPO" ] || die "--repo is required"
[ -n "$HOST" ] || die "--host is required"
[ -n "$DEST" ] || die "--dest is required"
[ -n "$MANIFEST" ] || die "--manifest is required"
# `git rev-parse --git-dir`, NOT `[ -d "$REPO/.git" ]`: in a git WORKTREE `.git` is a FILE, so
# the directory test rejects every worktree — and worktree-first is the mandated workflow here,
# so that check would have pushed people straight back to hand-rsync. Caught by R4's
# reconstruction, which necessarily runs from a scratch worktree.
git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || die "--repo $REPO is not a git repository or worktree"
[ -f "$MANIFEST" ] || die "--manifest $MANIFEST not found"

mapfile_paths=$(manifest_paths "$MANIFEST" deploy)
[ -n "$mapfile_paths" ] || die "manifest declares no 'deploy' paths — refusing to deploy nothing"

# ── 1. resolve the ref, and REFUSE anything not on origin/main ───────────────
git -C "$REPO" fetch -q origin 2>/dev/null || say "WARNING: git fetch failed; ancestry is judged against a possibly-stale origin/main"
SHA=$(git -C "$REPO" rev-parse --verify "${REF}^{commit}" 2>/dev/null) \
  || die "cannot resolve ref '$REF' in $REPO"
SHORT=$(git -C "$REPO" rev-parse --short "$SHA")

UNMERGED=false
if ! git -C "$REPO" merge-base --is-ancestor "$SHA" origin/main 2>/dev/null; then
  UNMERGED=true
  if [ "$FORCE_UNMERGED" -ne 1 ]; then
    cat >&2 <<EOF
host-deploy: REFUSED — $SHORT ($REF) is NOT an ancestor of origin/main.

  Deploying it would put code on $HOST that exists in no shared ref, which is exactly how
  2026-08-02 happened: the module was live in production and on no branch, so the next
  full-tree rsync deleted it and nothing noticed.

  Fix: merge it first.
      git -C $REPO checkout main && git -C $REPO merge --no-ff $REF && git -C $REPO push
  Then re-run this command (the default --ref origin/main will pick it up).

  Genuine emergency: --force-unmerged. It proceeds, logs loudly, and stamps the deploy
  unmerged so the parity canary ALERTS until a merged deploy replaces it.
EOF
    exit 1
  fi
  say "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  say "!! --force-unmerged: deploying $SHORT which is NOT on origin/main."
  say "!! The parity canary will report SHA_UNMERGED until a merged deploy replaces it."
  say "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
fi

TS=$(date -u +%Y%m%dT%H%M%SZ)
say "repo=$REPO ref=$REF sha=$SHORT unmerged=$UNMERGED host=$HOST dest=$DEST"
say "deploy paths: $(echo "$mapfile_paths" | tr '\n' ' ')"
[ "$DRY_RUN" -eq 1 ] && { say "--dry-run: resolved and validated, nothing shipped"; exit 0; }

# ── 2. materialize THE COMMIT (never a working tree) into a staging dir ──────
STAGE="$DEST/.deploy-staging-$TS"
# shellcheck disable=SC2086  # word-splitting of the manifest path list is intended
git -C "$REPO" archive --format=tar "$SHA" -- $mapfile_paths \
  | ssh -i "$SSH_KEY" "$HOST" "set -euo pipefail; mkdir -p '$STAGE' && tar -x -C '$STAGE'" \
  || die "git archive | tar failed — nothing was swapped"

ssh -i "$SSH_KEY" "$HOST" "set -euo pipefail
  # 3. ownership is set at the DESTINATION, before anything is swapped in. \`rsync -a\` from a
  #    developer's Mac is what left 106 files owned by uid 501 — a uid that does not exist on
  #    this box. That class dies here.
  ${OWNER:+chown -R '$OWNER' '$STAGE'}
  find '$STAGE' -type d -exec chmod 755 {} +
  find '$STAGE' -type f -exec chmod u+rw,go+r {} +

  for p in $(echo "$mapfile_paths" | tr '\n' ' '); do
    src=\"$STAGE/\$p\"
    dst=\"$DEST/\$p\"
    [ -e \"\$src\" ] || { echo \"host-deploy: staged \$p missing — aborting before any swap\"; exit 1; }
    # 4. back up, then swap PER ENTRY. Everything not in the manifest (.venv, DEPLOYED_AT,
    #    .pytest_cache) is untouched because it was never in the archive.
    if [ -e \"\$dst\" ]; then
      rm -rf \"\$dst.bak.PROVENANCE-$TS\"
      cp -a \"\$dst\" \"\$dst.bak.PROVENANCE-$TS\"
      # The backup is a \`cp -a\`, which PRESERVES ownership — so it inherits whatever
      # contamination the outgoing tree had (measured: 101 files owned by uid 501, a uid that
      # does not exist on this box). Chown it too, or the deploy root never reaches zero
      # foreign-owned files and the uid-501 class survives inside its own backups.
      ${OWNER:+chown -R '$OWNER' \"\$dst.bak.PROVENANCE-$TS\"}
      rm -rf \"\$dst.swapout-$TS\"
      mv \"\$dst\" \"\$dst.swapout-$TS\"
    fi
    mv \"\$src\" \"\$dst\"
    rm -rf \"\$dst.swapout-$TS\"
  done
  rm -rf '$STAGE'
" || die "swap failed on $HOST — check for .swapout-$TS leftovers before retrying"

# ── 5. dependency sync ONLY when pyproject changed ──────────────────────────
if echo "$mapfile_paths" | grep -qx 'pyproject.toml'; then
  NEW_PP=$(git -C "$REPO" show "$SHA:pyproject.toml" | shasum -a 256 | cut -d' ' -f1)
  OLD_PP=$(ssh -i "$SSH_KEY" "$HOST" "cat '$DEST/.pyproject.sha' 2>/dev/null" || true)
  if [ "$NEW_PP" != "$OLD_PP" ]; then
    say "pyproject.toml changed — syncing dependencies"
    # Prefer uv, fall back to the venv's OWN pip, and FAIL if neither exists. The first draft
    # ran `uv sync` and, on not finding uv, echoed a warning and carried on — a silent no-op
    # that would leave the venv stale after a real dependency change and break the bot at
    # import time with a green deploy log. Measured on this host: uv is not installed at all;
    # the venv is `/usr/bin/python3 -m venv` and ships pip. A dep sync that cannot run must
    # stop the deploy, not narrate its own failure.
    ssh -i "$SSH_KEY" "$HOST" "set -euo pipefail
      cd '$DEST'
      if command -v uv >/dev/null 2>&1; then
        uv sync --frozen 2>&1 | tail -3
      elif [ -x '$DEST/.venv/bin/pip' ]; then
        '$DEST/.venv/bin/pip' install -e . --quiet --disable-pip-version-check 2>&1 | tail -3
      else
        echo 'host-deploy: no uv and no .venv/bin/pip — cannot sync dependencies'; exit 1
      fi" || die "dependency sync FAILED — the tree is deployed but the venv may be stale; fix and re-run"
    ssh -i "$SSH_KEY" "$HOST" "printf '%s' '$NEW_PP' > '$DEST/.pyproject.sha'"
  else
    say "pyproject.toml unchanged — skipping dependency sync"
  fi

  # Post-condition: the package the units actually execute must still import. A deploy that
  # lands files and leaves an unimportable package is the failure this whole wave is about,
  # just with a different cause.
  ssh -i "$SSH_KEY" "$HOST" "cd '$DEST' && ./.venv/bin/python -c 'import algovault_bot' 2>&1 | tail -2" \
    && say "post-check: algovault_bot imports" \
    || die "post-check FAILED: algovault_bot does not import after deploy — investigate before trusting this deploy"
fi

# ── 6. L2: stamp WHAT is running, not just when ─────────────────────────────
# `remote` is recorded so the parity canary can ask the origin for the current head WITHOUT a
# clone — the host has no checkout of this repo, and giving it one would just be a second tree
# to drift.
REMOTE=$(git -C "$REPO" remote get-url origin 2>/dev/null || echo unknown)
ssh -i "$SSH_KEY" "$HOST" "cat > '$DEST/DEPLOYED_SHA' <<STAMP
sha=$SHA
short=$SHORT
ref=$REF
remote=$REMOTE
deployed_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
deployed_at_epoch=$(date -u +%s)
unmerged=$UNMERGED
tool=ops/scripts/host-deploy.sh
STAMP
date -u +%s > '$DEST/DEPLOYED_AT'"

# The per-file hash lockfile the canary verifies against. Written from the COMMIT, so it is a
# statement about the ref, not a re-read of whatever landed — hashing the host tree here would
# make the canary tautological (it would only ever confirm the tree matches itself).
git -C "$REPO" archive --format=tar "$SHA" -- $mapfile_paths \
  | tar -tvf - 2>/dev/null >/dev/null || die "could not re-read the archive for the lockfile"
LOCK=$(mktemp "${TMPDIR:-/tmp}/deploy-lock.XXXXXX") || die "mktemp failed"
trap 'rm -f "$LOCK"' EXIT
while IFS= read -r f; do
  [ -n "$f" ] || continue
  printf '%s  %s\n' "$(git -C "$REPO" show "$SHA:$f" | shasum -a 256 | cut -d' ' -f1)" "$f"
done < <(git -C "$REPO" ls-tree -r --name-only "$SHA" -- $mapfile_paths) | sort -k2 > "$LOCK"
say "lockfile: $(grep -c . "$LOCK") files hashed from $SHORT"
scp -q -i "$SSH_KEY" "$LOCK" "$HOST:$DEST/DEPLOYED_MANIFEST.sha256"

# ── 7. restart the units, then verify ───────────────────────────────────────
if [ -n "$UNITS" ]; then
  ssh -i "$SSH_KEY" "$HOST" "set -uo pipefail
    systemctl daemon-reload
    for u in \$(echo '$UNITS' | tr ',' ' '); do systemctl restart \"\$u\" || echo \"WARN: restart \$u failed\"; done
    sleep 2
    for u in \$(echo '$UNITS' | tr ',' ' '); do printf '  %-34s %s\n' \"\$u\" \"\$(systemctl is-active \"\$u\")\"; done"
fi

say "deployed $SHORT to $HOST:$DEST (unmerged=$UNMERGED)"
ssh -i "$SSH_KEY" "$HOST" "cat '$DEST/DEPLOYED_SHA'" | sed 's/^/  /'
