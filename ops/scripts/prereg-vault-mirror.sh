#!/usr/bin/env bash
# prereg-vault-mirror.sh — OPS-PREREG-VAULT-MIRROR-W1.
#
# ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────
# Pre-registrations live in the REPO (`audits/*preregistration*.md`) — correctly, since they are
# public methodology. But Cowork's mount is the VAULT only, so the PLANNING agent cannot read
# them. A wave whose spec must quote a registration verbatim therefore cannot be written, and
# paraphrasing one from a scheduled task's own prose is exactly the metric-shopping the
# registration exists to forbid.
#
# `audits/EDGE-HOLD-DISCIPLINE-readiness-2026-09-09.md` §2 measured that wall directly: the
# readiness check could not read `audits/hold-decision-preregistration-2026-08-26.md` at all, and
# named the class — *the mirror image of "a commitment stored only in a scheduler is a second
# ledger the executing agent cannot plan against". Same failure, opposite direction.*
#
# ── THE AUTHORITY RULE, WHICH IS THE WHOLE POINT ────────────────────────────────────────────
# THE REPO COPY IS AUTHORITATIVE. THE VAULT COPY IS DERIVED AND READ-ONLY.
# If the two disagree, the repo wins and the consumer REFUSES to quote the mirror. A silently
# stale mirror is WORSE than no mirror: a wave would plan against a superseded registration and
# never know. So every mirrored file carries its source blob SHA, and two verifiers exist —
# this one (repo-side, sees origin/main) and a generated vault-side `_verify.sh` (sees only the
# vault, which is all the planning agent can see).
#
# ── WHY THE DESTINATION IS NOT `audits/` ────────────────────────────────────────────────────
# MEASURED 2026-09-10 on origin/main dee91ff0: repo `audits/` holds 372 files, vault `audits/`
# holds 316, and exactly 2 filenames appear in both — BYTE-IDENTICAL in each case. So the
# hazard is NOT a content clash. It is that vault `audits/` holds
# `EDGE-SCORING-LADDER-W2A-PREREGISTRATION-2026-08-30.md`, a vault-NATIVE, AUTHORITATIVE
# pre-registration that is on NO repo ref. Dropping derived read-only copies into that same
# directory would leave nothing distinguishing "authoritative original" from "derived copy" —
# and the entire value of this mirror is that a reader can tell which is which.
#
# Destination is therefore `Claude files/repo-preregistrations/`. `Claude files/` is also the
# lazy-load quarantine zone (CLAUDE.md Precedence rule 9), so these stay REQUEST-read and never
# enter a session's context automatically.
#
# ── VERDICT ─────────────────────────────────────────────────────────────────────────────────
# Exactly one terminal `PREREG_MIRROR_VERDICT=PASS|FAIL|INDETERMINATE`.
# Exit 0 = PASS · 1 = FAIL · 3 = INDETERMINATE (the token-law default for a NEW gate; this
# script deploys no other code for "could not verify", so there is nothing to stay compatible
# with — see CLAUDE.md's verdict-token law on choosing the code LOCALLY).
#
#   FAIL          a body hash DIFFERS from what its header declares, or the mirror disagrees
#                 with origin/main. Something is definitely wrong and we can see exactly what.
#   INDETERMINATE we could not see: no state file, an unreadable one, a corpus that came back
#                 empty, a local `origin/main` we could not confirm against the remote, an
#                 UNCLASSIFIED candidate, or a mirror older than the declared age bound.
#
# AGE IS PART OF THE TOKEN, NOT A FOOTNOTE. An intact mirror synced three weeks ago must NOT
# read PASS: hash integrity and freshness are different properties and neither may stand in for
# the other. `MAX_AGE_HOURS` is DECLARED, not measured — 168h sits far above any plausible
# quiet stretch (this runs at step 6 of every wave), so it cannot false-fire on a normal week,
# and it decisively catches abandonment. If waves ever go legitimately quiet for longer, this
# firing is the correct alarm and the bound is what should be re-argued.
#
# Usage:
#   prereg-vault-mirror.sh                    # mirror origin/main -> the vault, then verify
#   prereg-vault-mirror.sh mirror
#   prereg-vault-mirror.sh --verify           # read-only: repo-side verification, no writes
#   prereg-vault-mirror.sh --self-test        # hermetic: no vault, no network, no git refs
#   prereg-vault-mirror.sh --prove-self-test  # mutate the logic, prove the self-test goes red
#   prereg-vault-mirror.sh --show-config
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

# SELF-PATH, RESOLVED ONCE AND ABSOLUTE. The load-time refusal can only be reached through a
# REAL invocation, so the self-test re-executes this file — and `"${BASH_SOURCE[0]}"` is
# whatever string the caller typed. MEASURED 2026-09-10 on origin/main: run as
# `bash monitoring-results-sync.sh` from ops/scripts, that re-invocation is a bare name, hits
# `command not found`, and the two refusal assertions fail — a suite green from one directory
# and red from another, which also makes any mutation proof run there VACUOUS. `$HERE` is
# already absolute, so the fix is to project the self-path from it and never from argv.
SELF="$HERE/$(basename "${BASH_SOURCE[0]}")"

# The vault root is PROJECTED from the one declared vault path, never restated — the same
# single-derivation rule, and the same load-time REFUSAL, as its sibling
# `monitoring-results-sync.sh`. An empty path is not a degraded path, it is a DIFFERENT path,
# and this tool writes files.
MAP_PATH_LIB="$REPO/scripts/lib/system-map-path.sh"
if [ ! -r "$MAP_PATH_LIB" ]; then
  echo "  vault path SoT unreadable: $MAP_PATH_LIB" >&2
  echo "PREREG_MIRROR_VERDICT=INDETERMINATE"; exit 3
fi
# shellcheck source=/dev/null
. "$MAP_PATH_LIB"
if [ -z "${ALGOVAULT_SYSTEM_MAP_PATH:-}" ]; then
  echo "  vault path SoT defined no path" >&2
  echo "PREREG_MIRROR_VERDICT=INDETERMINATE"; exit 3
fi
VAULT_ROOT="$(dirname "$ALGOVAULT_SYSTEM_MAP_PATH")"
if [ -z "$VAULT_ROOT" ] || [ ! -d "$VAULT_ROOT" ]; then
  echo "  vault root does not resolve to a directory: [$VAULT_ROOT]" >&2
  echo "PREREG_MIRROR_VERDICT=INDETERMINATE"; exit 3
fi

SOURCE_REPO=${PREREG_MIRROR_SOURCE_REPO:-AlgoVaultLabs/crypto-quant-signal-mcp}
REF=${PREREG_MIRROR_REF:-origin/main}
REMOTE_REF=${PREREG_MIRROR_REMOTE_REF:-refs/heads/main}
SOURCE_DIR=${PREREG_MIRROR_SOURCE_DIR:-audits}
MIRROR_DIR=${PREREG_MIRROR_DEST:-$VAULT_ROOT/Claude files/repo-preregistrations}
STATE_FILE="$MIRROR_DIR/_MIRROR-STATE.json"
VERIFIER="$MIRROR_DIR/_verify.sh"
MAX_AGE_HOURS=${PREREG_MIRROR_MAX_AGE_HOURS:-168}

BODY_BEGINS='<!-- ALGOVAULT-PREREG-MIRROR-BODY-BEGINS -->'

VERDICT=PASS
NOTES=()

note() { NOTES+=("$1"); }
downgrade() { # never upgrade: INDETERMINATE outranks FAIL outranks PASS
  case "$1:$VERDICT" in
    INDETERMINATE:*) VERDICT=INDETERMINATE ;;
    FAIL:PASS)       VERDICT=FAIL ;;
  esac
}

# ── KIND IS ASSIGNED BY A DECLARED RULE, NEVER BY FALLTHROUGH ───────────────────────────────
# Discovery is deliberately WIDE (any `*preregistration*.md`, case-insensitive — the same
# predicate `tests/unit/preregistration-support-stress-test.test.ts` already uses, so the two
# gates cannot disagree about what a pre-registration file is). Classification is deliberately
# NARROW and EXHAUSTIVE: anything the two rules below do not name is UNCLASSIFIED, is NOT
# mirrored, and downgrades the verdict.
#
# That asymmetry is the point. Without it, a future `audits/PREREGISTRATION-TEMPLATE.md` would
# silently join the mirror as a `registration` and a planning agent could quote a TEMPLATE as
# though it bound a study. An unclassified file is a decision somebody has to make, not a
# default this script gets to pick.
classify_kind() { # <basename> -> registration | procedure | UNCLASSIFIED
  case "$1" in
    PREREGISTRATION-PROCEDURE.md) echo procedure; return 0 ;;
  esac
  if printf '%s' "$1" | grep -Eq '^[a-z0-9][a-z0-9-]*-preregistration-[0-9]{4}-[0-9]{2}-[0-9]{2}\.md$'; then
    echo registration; return 0
  fi
  echo UNCLASSIFIED
}

is_candidate() { # <basename> -> 0 if it is a pre-registration file at all
  printf '%s' "$1" | grep -Eiq 'preregistration.*\.md$'
}

# ── THE BYPASSED ARTIFACTS ──────────────────────────────────────────────────────────────────
# A hermetic self-test replaces the git seam and the vault seam, which makes the code BELOW the
# only code no scenario would otherwise execute — and it is the code that decides what a
# planning agent reads as binding. So each piece is a pure function over explicit inputs, and
# the self-test drives every one of them directly with real fixtures.

# Header bytes for one mirrored file. Deterministic given its arguments; prints the header and
# NOTHING else, so `wc -c` on it is the body offset.
render_header() { # <kind> <source_path> <blob> <commit> <synced_at>
  cat <<HDR
<!-- ALGOVAULT-PREREG-MIRROR v1 -->
<!-- DERIVED COPY — READ-ONLY — DO NOT EDIT THIS FILE.                                     -->
<!-- The REPO copy is AUTHORITATIVE. If this file and the repo disagree, THE REPO WINS and  -->
<!-- the consumer MUST REFUSE to quote this file. A hand-edit here is a DEFECT, not an      -->
<!-- update, and _verify.sh reports it as FAIL.                                             -->
<!-- kind:          $1 -->
<!-- source_repo:   $SOURCE_REPO -->
<!-- source_path:   $2 -->
<!-- source_blob:   $3 -->
<!-- source_commit: $4 -->
<!-- synced_at:     $5 -->
<!-- verify:        run _verify.sh in THIS directory before quoting this file -->
$BODY_BEGINS
HDR
}

# Extract a mirrored file's BODY by byte offset and hash it exactly as git would.
#
# BYTE OFFSET, NOT `sed '1,/marker/d'`. MEASURED: sed appends a trailing newline to its last
# line, so a source blob that ends WITHOUT one would hash differently after a round trip and
# every such registration would read FAIL forever. `tail -c` moves bytes and invents nothing.
body_blob() { # <mirror-file> <offset>
  tail -c "+$(( $2 + 1 ))" "$1" | git hash-object --stdin
}

sha256_of() { # <file>
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else return 1; fi
}

# Write <target> from <content-on-stdin> only when it would actually change.
#
# Not an optimisation. The vault is a Google-Drive-synced tree, so an unconditional rewrite of
# ten files on every wave is ten sync events per wave that carry no information — and it would
# also churn mtimes the sibling `check_system_map.sh` gate reasons about.
write_if_different() { # <target>  (content on stdin) -> prints "written" | "unchanged"
  local target="$1" tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/pvm.XXXXXX")" || return 1
  cat > "$tmp"
  if [ -f "$target" ] && cmp -s "$tmp" "$target"; then
    rm -f "$tmp"; echo unchanged; return 0
  fi
  mkdir -p "$(dirname "$target")" || { rm -f "$tmp"; return 1; }
  chmod 644 "$tmp" 2>/dev/null
  mv "$tmp" "$target" || { rm -f "$tmp"; return 1; }
  echo written
}

# ── THE GENERATED VAULT-SIDE VERIFIER ───────────────────────────────────────────────────────
# The planning agent cannot reach the repo, so it cannot run THIS script. It gets a verifier
# that lives beside the mirror and needs nothing but `git hash-object`, `date` and `shasum` —
# all MEASURED present in the vault (which is not a git repository at all; `git hash-object`
# is a pure function and works outside one, returning the identical blob SHA).
#
# THE FILE TABLE IS BAKED IN, so the verifier parses no JSON and needs no jq and no python. It
# is REGENERATED from this one function on every sync (rider b), so any drift in the verifier
# itself self-heals within one wave — which is what makes baking the table safe rather than a
# second source of truth. The repo-side `--verify` asserts the baked table against the JSON, so
# a divergence between the two projections of that single derivation cannot go unreported.
#
# Its ONE coupling to the JSON is its own pinned sha256 — a file cannot contain its own hash —
# and it reads that by grep on a flat top-level key, never by parsing.
emit_verifier() { # <rows on stdin: mirror|kind|blob|offset> <synced_at> <synced_at_epoch> <commit>
  local synced_at="$1" epoch="$2" commit="$3" rows
  rows="$(cat)"
  cat <<VERIFIER
#!/usr/bin/env bash
# _verify.sh — GENERATED by ops/scripts/prereg-vault-mirror.sh (OPS-PREREG-VAULT-MIRROR-W1).
#
# DO NOT EDIT. Regenerated in full on every sync; any hand-edit is overwritten within one wave
# and is reported as a FAIL by the repo-side verifier in the meantime.
#
# WHAT THIS PROVES, AND WHAT IT CANNOT:
#   PROVES    every mirrored body still hashes to the source blob its header declares (so no
#             hand-edit), that this verifier is itself unmodified, and that the last sync is
#             within the declared age bound.
#   CANNOT    reach the repo. It therefore cannot tell you the mirror matches origin/main AS OF
#             NOW — only as of \`synced_at\` below, which the repo-side verifier established at
#             that moment. That is why the age bound is part of the verdict and not a footnote.
#
# PREREG_MIRROR_VERDICT=PASS|FAIL|INDETERMINATE · exit 0/1/3.
set -uo pipefail

HERE="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
STATE="\$HERE/_MIRROR-STATE.json"

SOURCE_COMMIT=$commit
SYNCED_AT=$synced_at
SYNCED_AT_EPOCH=$epoch
MAX_AGE_HOURS=$MAX_AGE_HOURS
BODY_BEGINS='$BODY_BEGINS'

# one row per mirrored file: mirror|kind|source_blob|body_offset_bytes
FILES='
$rows
'

VERDICT=PASS
down() { case "\$1:\$VERDICT" in INDETERMINATE:*) VERDICT=INDETERMINATE ;; FAIL:PASS) VERDICT=FAIL ;; esac; }
fin() { echo "PREREG_MIRROR_VERDICT=\$VERDICT"
        case "\$VERDICT" in PASS) exit 0 ;; FAIL) exit 1 ;; *) exit 3 ;; esac; }

echo "prereg-mirror verifier — vault-side, read-only"
echo "  mirror dir:     \$HERE"
echo "  source commit:  \$SOURCE_COMMIT   (origin/main at sync time)"
echo "  synced at:      \$SYNCED_AT"
echo "  age bound:      \${MAX_AGE_HOURS}h"

command -v git >/dev/null 2>&1 || { echo "  git absent — cannot hash a body" >&2; down INDETERMINATE; fin; }

# ── this verifier's own integrity, pinned in the state file ─────────────────────────────────
if [ ! -r "\$STATE" ]; then
  echo "  state file missing or unreadable: \$STATE" >&2; down INDETERMINATE; fin
fi
pinned="\$(grep -o '"verifier_sha256"[[:space:]]*:[[:space:]]*"[0-9a-f]\{64\}"' "\$STATE" | grep -o '[0-9a-f]\{64\}' | head -1)"
if [ -z "\$pinned" ]; then
  echo "  state file carries no verifier_sha256 — cannot establish this verifier is unmodified" >&2
  down INDETERMINATE; fin
fi
if command -v shasum >/dev/null 2>&1; then mine="\$(shasum -a 256 "\$0" | awk '{print \$1}')"
elif command -v sha256sum >/dev/null 2>&1; then mine="\$(sha256sum "\$0" | awk '{print \$1}')"
else echo "  no sha256 tool — cannot self-check" >&2; down INDETERMINATE; fin; fi
echo "  verifier sha256 pinned: \$pinned"
if [ "\$mine" != "\$pinned" ]; then
  echo "  ✖ THIS VERIFIER HAS BEEN MODIFIED — sha256 \$mine != pinned \$pinned" >&2
  down FAIL; fin
fi
echo "  verifier sha256 actual: \$mine  ✓"

# ── age ─────────────────────────────────────────────────────────────────────────────────────
now="\$(date -u +%s)"
age_h=\$(( (now - SYNCED_AT_EPOCH) / 3600 ))
echo "  age:            \${age_h}h"
if [ "\$age_h" -gt "\$MAX_AGE_HOURS" ]; then
  echo "  ✖ mirror is STALE: \${age_h}h old, bound is \${MAX_AGE_HOURS}h — an intact mirror is not a fresh one" >&2
  down INDETERMINATE
fi
if [ "\$age_h" -lt 0 ]; then
  echo "  ✖ negative age — the clock or the stamp is wrong" >&2; down INDETERMINATE
fi

# ── every body hashes to the blob its header declares ───────────────────────────────────────
checked=0
while IFS='|' read -r m kind blob off; do
  [ -n "\$m" ] || continue
  checked=\$(( checked + 1 ))
  f="\$HERE/\$m"
  if [ ! -r "\$f" ]; then echo "  ✖ MISSING  \$m" >&2; down FAIL; continue; fi
  got="\$(tail -c "+\$(( off + 1 ))" "\$f" | git hash-object --stdin 2>/dev/null)"
  if [ "\$got" != "\$blob" ]; then
    echo "  ✖ HAND-EDIT \$m — body hashes \$got, header declares \$blob" >&2; down FAIL
  else
    echo "  ok  \$kind  \$m"
  fi
done <<ROWS
\$FILES
ROWS

# The corpus is one WE construct — this table is baked by the generator — so an EMPTY table
# means the generator wrote nothing, which is a defect and never a pass over zero items.
if [ "\$checked" -eq 0 ]; then
  echo "  ✖ the file table is EMPTY — this verifier would report success having checked nothing" >&2
  down INDETERMINATE
fi
echo "  checked:        \$checked file(s)"

# ── anything in the directory that the table does not name ──────────────────────────────────
for f in "\$HERE"/*.md; do
  [ -e "\$f" ] || continue
  b="\$(basename "\$f")"
  case "
\$FILES" in
    *"
\$b|"*) : ;;
    *) echo "  ✖ ORPHAN \$b — present in the mirror but named by no row; it may be a retired registration" >&2
       down INDETERMINATE ;;
  esac
done

fin
VERIFIER
}

# One header field, read back from an existing mirror. Used to PRESERVE a file's original
# `synced_at` when its content has not changed — see the note in do_mirror about why a
# per-content stamp and a per-run stamp are different facts.
header_field() { # <mirror-file> <key>
  sed -n "s|^<!-- $2:[[:space:]]*\(.*[^ ]\)[[:space:]]*-->\$|\1|p" "$1" 2>/dev/null | head -1
}

# The state file, written by python3 because it is JSON and hand-rolled JSON is how a quoting
# bug becomes an unreadable ledger. Rows arrive as TSV on stdin.
# ROWS ARRIVE AS A FILE, NOT ON STDIN. `python3 - <<'PY'` binds stdin to the PROGRAM text, so
# `sys.stdin` inside it can never also carry piped data. MEASURED: the first cut piped TSV in and
# python read ZERO rows, so the state file rendered `file_count: 0` while every other assertion
# stayed green -- the vacuity guard in do_mirror is what would have caught it in production, and
# the self-test is what caught it here.
render_state() { # <rows-tsv-file> <ref_commit> <remote_verified> <synced_at> <epoch> <verifier_sha256>
  python3 - "$1" "$2" "$3" "$4" "$5" "$6" "$SOURCE_REPO" "$MAX_AGE_HOURS" <<'PY'
import json, sys
rows_file, ref_commit, remote_verified, synced_at, epoch, vsha, source_repo, max_age = sys.argv[1:9]
files = []
for line in open(rows_file, encoding="utf-8"):
    line = line.rstrip("\n")
    if not line.strip():
        continue
    mirror, kind, source_path, blob, commit, offset, fsynced = line.split("\t")
    files.append({
        "mirror": mirror,
        "kind": kind,
        "source_path": source_path,
        "source_blob": blob,
        "source_commit": commit,
        "body_offset_bytes": int(offset),
        "synced_at": fsynced,
    })
files.sort(key=lambda f: f["mirror"])
doc = {
    "_comment": (
        "GENERATED by ops/scripts/prereg-vault-mirror.sh (OPS-PREREG-VAULT-MIRROR-W1). "
        "DERIVED AND READ-ONLY. The REPO copy of every file listed here is AUTHORITATIVE: if a "
        "mirror and the repo disagree, the repo wins and the consumer REFUSES to quote the "
        "mirror. Run _verify.sh before quoting anything in this directory."
    ),
    "_kind_semantics": {
        "registration": "a pre-registration that BINDS a study. Quotable as the commitment.",
        "procedure": "audits/PREREGISTRATION-PROCEDURE.md — the RULES registrations follow. "
                     "NEVER quotable as the commitment of any particular study.",
    },
    "schema": 1,
    "source_repo": source_repo,
    "source_ref_commit": ref_commit,
    "remote_ref_verified": remote_verified == "true",
    "synced_at": synced_at,
    "synced_at_epoch": int(epoch),
    "max_age_hours": int(max_age),
    "verifier": "_verify.sh",
    "verifier_sha256": vsha,
    "file_count": len(files),
    "files": files,
}
print(json.dumps(doc, indent=2, ensure_ascii=False))
PY
}

# State file -> TSV, for every consumer that is not python. One parser, one place.
state_rows() { # <state-file>
  python3 - "$1" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception as e:
    sys.stderr.write("state file unparseable: %s\n" % e)
    sys.exit(2)
for f in d.get("files", []):
    print("\t".join([str(f.get(k, "")) for k in
                     ("mirror", "kind", "source_path", "source_blob",
                      "source_commit", "body_offset_bytes", "synced_at")]))
PY
}

state_scalar() { # <state-file> <key>
  python3 - "$1" "$2" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    sys.exit(2)
v = d.get(sys.argv[2])
print("" if v is None else ("true" if v is True else "false" if v is False else v))
PY
}

# ── MIRROR ──────────────────────────────────────────────────────────────────────────────────
do_mirror() {
  local commit remote_sha remote_verified=true run_at run_epoch rows tmp vsha n=0 unclassified=0
  commit="$(git -C "$REPO" rev-parse "$REF" 2>/dev/null)"
  if [ -z "$commit" ]; then
    note "mirror: FAILED — cannot resolve $REF in $REPO"; downgrade INDETERMINATE; return
  fi

  # A LOCAL ref is a claim about the remote, not the remote itself. The canonical checkout is
  # known to lag origin/main, and mirroring from a stale ref would stamp a stale commit into
  # every header while the token said PASS. Confirm, or say we could not.
  remote_sha="$(git -C "$REPO" ls-remote origin "$REMOTE_REF" 2>/dev/null | cut -f1 | head -1)"
  if [ -z "$remote_sha" ]; then
    remote_verified=false
    note "mirror: could not reach origin to confirm $REF is current — mirroring from the local ref"
    downgrade INDETERMINATE
  elif [ "$remote_sha" != "$commit" ]; then
    remote_verified=false
    note "mirror: LOCAL $REF ($commit) != remote $REMOTE_REF ($remote_sha) — mirroring the local ref; run git fetch"
    downgrade INDETERMINATE
  fi

  run_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  run_epoch="$(date -u +%s)"
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/pvmrun.XXXXXX")" || {
    note "mirror: FAILED — mktemp"; downgrade INDETERMINATE; return; }
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN

  mkdir -p "$MIRROR_DIR" || { note "mirror: FAILED — cannot create $MIRROR_DIR"; downgrade INDETERMINATE; return; }

  : > "$tmp/rows.tsv"
  : > "$tmp/verifier-rows"

  while read -r blob path; do
    [ -n "$path" ] || continue
    local base kind land target existing_synced offset had
    base="$(basename "$path")"
    is_candidate "$base" || continue
    kind="$(classify_kind "$base")"
    if [ "$kind" = UNCLASSIFIED ]; then
      unclassified=$(( unclassified + 1 ))
      note "mirror: UNCLASSIFIED — $path matches the discovery predicate but neither kind rule; NOT mirrored"
      downgrade INDETERMINATE
      continue
    fi
    land="$(git -C "$REPO" log -1 --format=%H "$REF" -- "$path" 2>/dev/null)"
    [ -n "$land" ] || land="$commit"
    target="$MIRROR_DIR/$base"

    # A hand-edit is a DEFECT, not an update — and it must be REPORTED before it is healed,
    # or re-syncing would quietly destroy the evidence that somebody edited a derived file.
    if [ -f "$target" ]; then
      # The offset comes from the STATE FILE, never from the header: a header cannot carry its
      # own byte length without changing it, so that fact belongs where it can be stated once.
      local decl off_decl got
      decl="$(header_field "$target" source_blob)"
      off_decl="$(state_row_offset "$base")"
      if [ -n "$decl" ] && [ -n "$off_decl" ]; then
        got="$(body_blob "$target" "$off_decl" 2>/dev/null)"
        if [ -n "$got" ] && [ "$got" != "$decl" ]; then
          note "mirror: HAND-EDIT DETECTED in $base — body hashed $got, its header declared $decl; re-synced from $REF"
          downgrade FAIL
        fi
      fi
    fi

    # Preserve the ORIGINAL sync stamp when the content has not moved. `synced_at` in a header
    # answers "when did THIS content come from the repo"; the state file's own `synced_at`
    # answers "when did we last check". Two different facts, and collapsing them would rewrite
    # every file on every wave for no information.
    existing_synced=""
    if [ -f "$target" ] && [ "$(header_field "$target" source_blob)" = "$blob" ]; then
      existing_synced="$(header_field "$target" synced_at)"
    fi
    [ -n "$existing_synced" ] || existing_synced="$run_at"

    render_header "$kind" "$path" "$blob" "$land" "$existing_synced" > "$tmp/hdr"
    offset="$(wc -c < "$tmp/hdr" | tr -d ' ')"
    { cat "$tmp/hdr"; git -C "$REPO" cat-file blob "$blob"; } > "$tmp/candidate"

    had="$(write_if_different "$target" < "$tmp/candidate")" || {
      note "mirror: FAILED — could not write $target"; downgrade INDETERMINATE; continue; }

    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$base" "$kind" "$path" "$blob" "$land" "$offset" "$existing_synced" >> "$tmp/rows.tsv"
    printf '%s|%s|%s|%s\n' "$base" "$kind" "$blob" "$offset" >> "$tmp/verifier-rows"
    n=$(( n + 1 ))
    [ "$had" = written ] && note "mirror: $had  $kind  $base"
  done <<ROWS
$(git -C "$REPO" ls-tree -r "$REF" --format='%(objectname) %(path)' "$SOURCE_DIR/" 2>/dev/null)
ROWS

  # Zero candidates is INDETERMINATE, never PASS. The DISCOVERY PREDICATE is ours: an empty
  # result means either the corpus vanished or our own glob broke, and both need a human. A
  # mirror that reports success having mirrored nothing is the dark-guard class exactly.
  if [ "$n" -eq 0 ]; then
    note "mirror: discovery matched NOTHING under $SOURCE_DIR/ on $REF — corpus gone, or the predicate broke"
    downgrade INDETERMINATE; return
  fi

  # Order: verifier first (its table is baked in), then its sha256, then the state file that
  # pins it. No cycle — a file cannot contain its own hash, so the pin lives one level out.
  local vhad
  vhad="$(sort "$tmp/verifier-rows" | emit_verifier "$run_at" "$run_epoch" "$commit" > "$tmp/verifier" && write_if_different "$VERIFIER" < "$tmp/verifier")" || {
    note "mirror: FAILED — could not write $VERIFIER"; downgrade INDETERMINATE; return; }
  chmod 755 "$VERIFIER" 2>/dev/null
  vsha="$(sha256_of "$VERIFIER")" || { note "mirror: FAILED — no sha256 tool"; downgrade INDETERMINATE; return; }

  render_state "$tmp/rows.tsv" "$commit" "$remote_verified" "$run_at" "$run_epoch" "$vsha" > "$tmp/state.json" || {
    note "mirror: FAILED — could not render the state file"; downgrade INDETERMINATE; return; }
  write_if_different "$STATE_FILE" < "$tmp/state.json" >/dev/null || {
    note "mirror: FAILED — could not write $STATE_FILE"; downgrade INDETERMINATE; return; }

  note "mirror: $n file(s) at $MIRROR_DIR  (ref $REF @ ${commit:0:8}, remote_verified=$remote_verified, verifier $vhad)"
}

# Offset of one mirrored file as the state file records it — the fallback path for a mirror
# written before the header carried its own offset line.
state_row_offset() { # <basename>
  [ -r "$STATE_FILE" ] || return 0
  state_rows "$STATE_FILE" 2>/dev/null | awk -F'\t' -v b="$1" '$1==b {print $6; exit}'
}

# ── VERIFY (repo-side) ──────────────────────────────────────────────────────────────────────
# The half the vault-side verifier structurally cannot do: compare what the mirror CLAIMS
# against what origin/main actually holds right now. Read-only — it writes nothing, ever.
do_verify() {
  local commit rows n=0 vsha pinned age_h now epoch

  if [ ! -r "$STATE_FILE" ]; then
    note "verify: no state file at $STATE_FILE — nothing has been mirrored"; downgrade INDETERMINATE; return
  fi
  rows="$(state_rows "$STATE_FILE" 2>/dev/null)" || {
    note "verify: state file is UNPARSEABLE — handed input we could not read is INDETERMINATE, always"
    downgrade INDETERMINATE; return; }

  commit="$(git -C "$REPO" rev-parse "$REF" 2>/dev/null)"
  if [ -z "$commit" ]; then
    note "verify: cannot resolve $REF — the freshness leg cannot run"; downgrade INDETERMINATE; return
  fi

  # this verifier's own pin
  pinned="$(state_scalar "$STATE_FILE" verifier_sha256)"
  if [ ! -r "$VERIFIER" ]; then
    note "verify: the vault-side verifier is MISSING at $VERIFIER"; downgrade FAIL
  elif [ -z "$pinned" ]; then
    note "verify: state file carries no verifier_sha256"; downgrade INDETERMINATE
  else
    vsha="$(sha256_of "$VERIFIER")" || vsha=""
    if [ -z "$vsha" ]; then
      note "verify: no sha256 tool — cannot check the verifier"; downgrade INDETERMINATE
    elif [ "$vsha" != "$pinned" ]; then
      note "verify: the vault-side verifier has been MODIFIED — sha256 $vsha != pinned $pinned"; downgrade FAIL
    fi
  fi

  # age — an intact mirror is not a fresh one
  epoch="$(state_scalar "$STATE_FILE" synced_at_epoch)"
  now="$(date -u +%s)"
  if [ -z "$epoch" ]; then
    note "verify: state file carries no synced_at_epoch — age is unknowable"; downgrade INDETERMINATE
  else
    age_h=$(( (now - epoch) / 3600 ))
    if [ "$age_h" -gt "$MAX_AGE_HOURS" ]; then
      note "verify: mirror is STALE — ${age_h}h old, bound ${MAX_AGE_HOURS}h"; downgrade INDETERMINATE
    fi
  fi

  # per-file: integrity (body vs its declared blob) + freshness (declared blob vs origin/main)
  while IFS=$'\t' read -r mirror kind source_path blob land offset fsynced; do
    [ -n "$mirror" ] || continue
    n=$(( n + 1 ))
    local f live got
    f="$MIRROR_DIR/$mirror"
    if [ ! -r "$f" ]; then
      note "verify: MISSING mirror — $mirror is named by the state file but not on disk"; downgrade FAIL; continue
    fi
    got="$(body_blob "$f" "$offset" 2>/dev/null)"
    if [ "$got" != "$blob" ]; then
      note "verify: HAND-EDIT — $mirror body hashes $got, header declares $blob"; downgrade FAIL
    fi
    live="$(git -C "$REPO" rev-parse "$REF:$source_path" 2>/dev/null)"
    if [ -z "$live" ]; then
      note "verify: $source_path is GONE from $REF but still mirrored as $mirror — a retired registration must not stay quotable"
      downgrade INDETERMINATE
    elif [ "$live" != "$blob" ]; then
      note "verify: STALE — $mirror pins $blob, $REF:$source_path is now $live"; downgrade FAIL
    fi
    # the baked verifier table must agree with the JSON: one derivation, two projections
    if [ -r "$VERIFIER" ] && ! grep -qF "$mirror|$kind|$blob|$offset" "$VERIFIER"; then
      note "verify: PROJECTION DRIFT — $mirror's row differs between _MIRROR-STATE.json and the verifier's baked table"
      downgrade FAIL
    fi
  done <<ROWS
$rows
ROWS

  # coverage: every candidate on the ref is either mirrored or explicitly unclassified
  local missing=0
  while read -r blob path; do
    [ -n "$path" ] || continue
    local base kind
    base="$(basename "$path")"
    is_candidate "$base" || continue
    kind="$(classify_kind "$base")"
    if [ "$kind" = UNCLASSIFIED ]; then
      note "verify: UNCLASSIFIED — $path matches the discovery predicate but neither kind rule"
      downgrade INDETERMINATE; continue
    fi
    case "
$rows" in
      *"
$base	"*) : ;;
      *) note "verify: NOT MIRRORED — $path is on $REF and classifies as $kind, but no mirror exists"
         missing=$(( missing + 1 )); downgrade FAIL ;;
    esac
  done <<CANDIDATES
$(git -C "$REPO" ls-tree -r "$REF" --format='%(objectname) %(path)' "$SOURCE_DIR/" 2>/dev/null)
CANDIDATES

  # orphans: a .md in the mirror that no row names
  for f in "$MIRROR_DIR"/*.md; do
    [ -e "$f" ] || continue
    local b
    b="$(basename "$f")"
    case "
$rows" in
      *"
$b	"*) : ;;
      *) note "verify: ORPHAN — $b is in the mirror but named by no row"; downgrade INDETERMINATE ;;
    esac
  done

  # The state file is a corpus WE construct. Zero rows means the generator wrote nothing.
  if [ "$n" -eq 0 ]; then
    note "verify: the state file names ZERO files — it would report success having verified nothing"
    downgrade INDETERMINATE; return
  fi
  note "verify: $n mirrored file(s) checked against $REF @ ${commit:0:8} (integrity + freshness + coverage + age + verifier pin)"
}

# ── SELF-TEST ───────────────────────────────────────────────────────────────────────────────
# Hermetic: no origin, no vault writes, no network. Which is exactly why it must also drive the
# artifacts its own seams replace — the generated verifier is RUN here against real fixture
# directories, because a suite that only asserts the text it emitted would prove nothing about
# whether that text works.
self_test() {
  local fails=0 ran=0 tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/pvmst.XXXXXX")" || { echo "SELF-TEST: FAIL (mktemp)"; return 1; }
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN
  t() { ran=$((ran + 1)); if [ "$2" != "$3" ]; then echo "  - $1: expected [$3] got [$2]"; fails=$((fails + 1)); fi; }

  # ── discovery predicate ───────────────────────────────────────────────────────────────────
  t "a dated registration is a candidate"   "$(is_candidate 'hold-decision-preregistration-2026-08-26.md' && echo y || echo n)" "y"
  t "the PROCEDURE is a candidate"          "$(is_candidate 'PREREGISTRATION-PROCEDURE.md' && echo y || echo n)" "y"
  t "an endpoint-truth doc is not"          "$(is_candidate 'OPS-VENUE-SET-RECONCILE-W1-endpoint-truth.md' && echo y || echo n)" "n"
  t "a .json is not, whatever its name"     "$(is_candidate 'hold-decision-preregistration-2026-08-26.json' && echo y || echo n)" "n"

  # ── kind assignment: DECLARED, exhaustive, and UNCLASSIFIED is a real outcome ─────────────
  t "dated file -> registration"      "$(classify_kind 'hold-decision-preregistration-2026-08-26.md')" "registration"
  t "the procedure -> procedure"      "$(classify_kind 'PREREGISTRATION-PROCEDURE.md')"                "procedure"
  # The case this rule exists for. A template is NOT a registration and must never mirror as one.
  t "a TEMPLATE -> UNCLASSIFIED"      "$(classify_kind 'PREREGISTRATION-TEMPLATE.md')"                 "UNCLASSIFIED"
  t "no date -> UNCLASSIFIED"         "$(classify_kind 'hold-decision-preregistration.md')"            "UNCLASSIFIED"
  t "a bad date -> UNCLASSIFIED"      "$(classify_kind 'x-preregistration-26-08-26.md')"               "UNCLASSIFIED"
  t "uppercase dated -> UNCLASSIFIED" "$(classify_kind 'EDGE-LADDER-PREREGISTRATION-2026-08-30.md')"   "UNCLASSIFIED"

  # The nine files that ACTUALLY exist on the ref today, classified through the real rule. A
  # count alone would pass while every file was the wrong kind, so both are asserted.
  local corpus reg proc
  corpus='PREREGISTRATION-PROCEDURE.md
attribution-gate-preregistration-2026-09-04.md
hold-decision-preregistration-2026-08-26.md
sell-attribution-centered-check-preregistration-2026-09-05.md
sell-attribution-collider-control-preregistration-2026-09-05.md
sell-attribution-long-timeframe-check-preregistration-2026-09-09.md
sell-feature-attribution-preregistration-2026-09-04.md
withheld-dwr-preregistration-2026-08-30.md
withheld-dwr-w2-preregistration-2026-09-10.md'
  reg=0; proc=0
  while IFS= read -r b; do
    [ -n "$b" ] || continue
    case "$(classify_kind "$b")" in
      registration) reg=$((reg + 1)) ;;
      procedure)    proc=$((proc + 1)) ;;
    esac
  done <<CORPUS
$corpus
CORPUS
  t "the live corpus classifies 8 registrations" "$reg"  "8"
  t "the live corpus classifies 1 procedure"     "$proc" "1"

  # ── header + byte-exact body round trip ───────────────────────────────────────────────────
  local body blob hdr off got
  printf 'line one\nline two\n' > "$tmp/body.md"
  blob="$(git hash-object "$tmp/body.md")"
  render_header registration 'audits/x-preregistration-2026-01-01.md' "$blob" 'abc1234' '2026-01-01T00:00:00Z' > "$tmp/hdr"
  off="$(wc -c < "$tmp/hdr" | tr -d ' ')"
  cat "$tmp/hdr" "$tmp/body.md" > "$tmp/mirror.md"
  t "the body survives the round trip byte-exact" "$(body_blob "$tmp/mirror.md" "$off")" "$blob"

  # THE CASE `sed '1,/marker/d'` GETS WRONG. sed appends a newline to its last line, so a blob
  # with no trailing newline would hash differently after extraction and read FAIL forever.
  printf 'no trailing newline' > "$tmp/body2.md"
  blob="$(git hash-object "$tmp/body2.md")"
  render_header registration 'audits/y-preregistration-2026-01-01.md' "$blob" 'abc1234' '2026-01-01T00:00:00Z' > "$tmp/hdr2"
  off="$(wc -c < "$tmp/hdr2" | tr -d ' ')"
  cat "$tmp/hdr2" "$tmp/body2.md" > "$tmp/mirror2.md"
  t "a body with NO trailing newline also round-trips" "$(body_blob "$tmp/mirror2.md" "$off")" "$blob"

  t "the header declares the source path"  "$(header_field "$tmp/mirror.md" source_path)" "audits/x-preregistration-2026-01-01.md"
  t "the header declares the blob"         "$(header_field "$tmp/mirror.md" source_blob)" "$(git hash-object "$tmp/body.md")"
  t "the header declares the kind"         "$(header_field "$tmp/mirror.md" kind)"        "registration"
  t "the header declares the sync stamp"   "$(header_field "$tmp/mirror.md" synced_at)"   "2026-01-01T00:00:00Z"
  t "the header carries the READ-ONLY marker" "$(grep -c 'DERIVED COPY — READ-ONLY' "$tmp/mirror.md")" "1"
  t "the header names the repo as authoritative" "$(grep -c 'THE REPO WINS' "$tmp/mirror.md")" "1"

  # ── write_if_different ────────────────────────────────────────────────────────────────────
  t "a first write is written"    "$(printf 'a\n' | write_if_different "$tmp/w.txt")" "written"
  t "an identical write is a no-op" "$(printf 'a\n' | write_if_different "$tmp/w.txt")" "unchanged"
  t "a changed write is written"  "$(printf 'b\n' | write_if_different "$tmp/w.txt")" "written"

  # ── the verdict ladder never upgrades ─────────────────────────────────────────────────────
  local keep="$VERDICT"
  VERDICT=PASS;           downgrade FAIL;          t "PASS downgrades to FAIL"           "$VERDICT" "FAIL"
  downgrade INDETERMINATE;                         t "FAIL downgrades to INDETERMINATE"  "$VERDICT" "INDETERMINATE"
  downgrade FAIL;                                  t "INDETERMINATE is never downgraded" "$VERDICT" "INDETERMINATE"
  VERDICT="$keep"

  # ── the state file: rendered, then read back through the real parsers ─────────────────────
  local st
  st="$tmp/state.json"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    'a-preregistration-2026-01-01.md' registration 'audits/a-preregistration-2026-01-01.md' \
    aaaa111 c0ffee 512 '2026-01-01T00:00:00Z' > "$tmp/rows.tsv"
  render_state "$tmp/rows.tsv" deadbeef true '2026-01-02T00:00:00Z' 1767312000 abc123 > "$st"
  t "the state file is valid JSON"          "$(python3 -c 'import json,sys; json.load(open(sys.argv[1])); print("ok")' "$st" 2>/dev/null)" "ok"
  t "state_scalar reads the ref commit"     "$(state_scalar "$st" source_ref_commit)" "deadbeef"
  t "state_scalar reads the verifier pin"   "$(state_scalar "$st" verifier_sha256)"   "abc123"
  t "state_scalar reads the file count"     "$(state_scalar "$st" file_count)"        "1"
  t "state_rows round-trips the offset"     "$(state_rows "$st" | awk -F'\t' '{print $6}')" "512"
  t "state_rows round-trips the kind"       "$(state_rows "$st" | awk -F'\t' '{print $2}')" "registration"
  t "an unparseable state file REFUSES"     "$(printf 'not json' > "$tmp/bad.json"; state_rows "$tmp/bad.json" >/dev/null 2>&1; echo $?)" "2"
  # The verifier's grep contract: a flat top-level key it can find without a JSON parser.
  t "verifier_sha256 is greppable, unparsed" \
    "$(grep -o '"verifier_sha256"[[:space:]]*:[[:space:]]*"[0-9a-z]*"' "$st" | wc -l | tr -d ' ')" "1"

  # ── THE BYPASSED ARTIFACT: the generated verifier is RUN, not merely emitted ──────────────
  # Everything above tests functions this script calls itself. The verifier is the one artifact
  # nothing here would otherwise execute — and it is the ONLY thing the planning agent runs.
  local fx now_epoch v_out
  fx="$tmp/fixture"; mkdir -p "$fx"
  now_epoch="$(date -u +%s)"
  printf 'REGISTERED CONTENT\n' > "$tmp/fbody.md"
  blob="$(git hash-object "$tmp/fbody.md")"
  render_header registration 'audits/f-preregistration-2026-01-01.md' "$blob" c0ffee '2026-01-01T00:00:00Z' > "$tmp/fhdr"
  off="$(wc -c < "$tmp/fhdr" | tr -d ' ')"
  cat "$tmp/fhdr" "$tmp/fbody.md" > "$fx/f-preregistration-2026-01-01.md"
  printf '%s|%s|%s|%s\n' 'f-preregistration-2026-01-01.md' registration "$blob" "$off" \
    | emit_verifier '2026-09-10T00:00:00Z' "$now_epoch" deadbeef > "$fx/_verify.sh"
  chmod +x "$fx/_verify.sh"
  local fvsha; fvsha="$(sha256_of "$fx/_verify.sh")"
  printf '{"verifier_sha256": "%s"}\n' "$fvsha" > "$fx/_MIRROR-STATE.json"

  v_out="$(bash "$fx/_verify.sh" 2>&1)"
  t "a healthy mirror verifies PASS"        "$(printf '%s' "$v_out" | tail -1)" "PREREG_MIRROR_VERDICT=PASS"
  t "and exits 0"                           "$(bash "$fx/_verify.sh" >/dev/null 2>&1; echo $?)" "0"
  # rider (c): a reader must be able to see WHAT the verdict is a verdict about
  t "the verifier prints its pinned sha"    "$(printf '%s' "$v_out" | grep -c "pinned: $fvsha")" "1"
  t "the verifier prints the sync stamp"    "$(printf '%s' "$v_out" | grep -c '2026-09-10T00:00:00Z')" "1"
  t "the verifier prints the source commit" "$(printf '%s' "$v_out" | grep -c 'deadbeef')" "1"

  # a hand-edit is a DEFECT, and this is the assertion the spec asked to be proven able to fail
  printf 'REGISTERED CONTENT — tampered\n' > "$fx/tmpbody"
  cat "$tmp/fhdr" "$fx/tmpbody" > "$fx/f-preregistration-2026-01-01.md"; rm -f "$fx/tmpbody"
  t "a HAND-EDITED body verifies FAIL"      "$(bash "$fx/_verify.sh" 2>&1 | tail -1)" "PREREG_MIRROR_VERDICT=FAIL"
  t "and exits 1"                           "$(bash "$fx/_verify.sh" >/dev/null 2>&1; echo $?)" "1"
  cat "$tmp/fhdr" "$tmp/fbody.md" > "$fx/f-preregistration-2026-01-01.md"
  t "restoring the body restores PASS"      "$(bash "$fx/_verify.sh" 2>&1 | tail -1)" "PREREG_MIRROR_VERDICT=PASS"

  # a MISSING mirror is FAIL, not a quiet skip
  mv "$fx/f-preregistration-2026-01-01.md" "$tmp/parked.md"
  t "a MISSING mirror verifies FAIL"        "$(bash "$fx/_verify.sh" 2>&1 | tail -1)" "PREREG_MIRROR_VERDICT=FAIL"
  mv "$tmp/parked.md" "$fx/f-preregistration-2026-01-01.md"

  # an ORPHAN — a file the table does not name — is INDETERMINATE, never ignored
  printf 'stray\n' > "$fx/orphan-preregistration-2020-01-01.md"
  t "an ORPHAN file verifies INDETERMINATE" "$(bash "$fx/_verify.sh" 2>&1 | tail -1)" "PREREG_MIRROR_VERDICT=INDETERMINATE"
  rm -f "$fx/orphan-preregistration-2020-01-01.md"

  # a MODIFIED verifier cannot clear itself
  printf '\n# tampered\n' >> "$fx/_verify.sh"
  t "a MODIFIED verifier verifies FAIL"     "$(bash "$fx/_verify.sh" 2>&1 | tail -1)" "PREREG_MIRROR_VERDICT=FAIL"
  printf '%s|%s|%s|%s\n' 'f-preregistration-2026-01-01.md' registration "$blob" "$off" \
    | emit_verifier '2026-09-10T00:00:00Z' "$now_epoch" deadbeef > "$fx/_verify.sh"
  chmod +x "$fx/_verify.sh"

  # AGE IS PART OF THE TOKEN. An INTACT mirror synced long ago must NOT read PASS.
  printf '%s|%s|%s|%s\n' 'f-preregistration-2026-01-01.md' registration "$blob" "$off" \
    | emit_verifier '2026-01-01T00:00:00Z' "$(( now_epoch - (MAX_AGE_HOURS + 24) * 3600 ))" deadbeef > "$fx/_verify.sh"
  chmod +x "$fx/_verify.sh"
  printf '{"verifier_sha256": "%s"}\n' "$(sha256_of "$fx/_verify.sh")" > "$fx/_MIRROR-STATE.json"
  t "an INTACT but STALE mirror is INDETERMINATE" "$(bash "$fx/_verify.sh" 2>&1 | tail -1)" "PREREG_MIRROR_VERDICT=INDETERMINATE"
  t "and exits 3"                                 "$(bash "$fx/_verify.sh" >/dev/null 2>&1; echo $?)" "3"

  # a missing state file leaves the verifier unable to establish its own integrity
  rm -f "$fx/_MIRROR-STATE.json"
  t "no state file -> INDETERMINATE"        "$(bash "$fx/_verify.sh" 2>&1 | tail -1)" "PREREG_MIRROR_VERDICT=INDETERMINATE"

  # VACUITY: a verifier generated over ZERO rows must refuse, not pass over an empty corpus.
  # This table is one WE construct, so empty means the generator wrote nothing.
  local vx="$tmp/vacuous"; mkdir -p "$vx"
  printf '' | emit_verifier '2026-09-10T00:00:00Z' "$now_epoch" deadbeef > "$vx/_verify.sh"
  chmod +x "$vx/_verify.sh"
  printf '{"verifier_sha256": "%s"}\n' "$(sha256_of "$vx/_verify.sh")" > "$vx/_MIRROR-STATE.json"
  t "an EMPTY file table REFUSES"           "$(bash "$vx/_verify.sh" 2>&1 | tail -1)" "PREREG_MIRROR_VERDICT=INDETERMINATE"

  # ── config, derived not restated ──────────────────────────────────────────────────────────
  t "the vault root resolves to a directory"       "$([ -d "$VAULT_ROOT" ] && echo yes || echo no)" "yes"
  t "the mirror lands in the lazy-load zone"       "$(basename "$(dirname "$MIRROR_DIR")")" "Claude files"
  t "the mirror is NOT audits/"                    "$(basename "$MIRROR_DIR")" "repo-preregistrations"
  if [ -z "${SYSTEM_MAP_PATH:-}" ]; then
    t "the declared vault is the AlgoVault planning hub" "$(basename "$VAULT_ROOT")" "AlgoVault MCP"
  fi

  # The load-time refusal cannot be reached by an in-process assertion — it runs before main —
  # so it is driven through a REAL invocation. `--show-config` deliberately, because it touches
  # no git and no network and therefore CANNOT emit this token on a healthy load; the token's
  # presence is evidence of the refusal and of nothing else. The healthy control below is what
  # makes that discriminating rather than merely true.
  # CWD-INDEPENDENT, asserted directly. Proving the mutation above only goes red when the
  # suite happens to be invoked by a bare name, and a proof that depends on how it was
  # called is luck. This asserts the property itself.
  # Parameter expansion, NOT `case`: bash 3.2 (which is what /bin/bash is on this Mac) mis-parses
  # a `case` pattern's `)` inside `$( )` and returns the tail of the expression as a STRING.
  # Measured here — the assertion read back " echo yes ;; *) echo no ;; esac)".
  t "the self-path is absolute" "$([ "${SELF#/}" != "$SELF" ] && echo yes || echo no)" "yes"
  local refuse
  refuse="$(SYSTEM_MAP_PATH="$tmp/no-such-vault/system-map.md" "$SELF" --show-config 2>&1)"
  t "an unresolvable vault root REFUSES" \
    "$(printf '%s' "$refuse" | tail -1)" "PREREG_MIRROR_VERDICT=INDETERMINATE"
  t "and it says WHY" \
    "$(printf '%s' "$refuse" | grep -c 'vault root does not resolve')" "1"
  t "a healthy load emits no refusal token" \
    "$("$SELF" --show-config 2>&1 | grep -c 'PREREG_MIRROR_VERDICT')" "0"

  if [ "$ran" -eq 0 ]; then
    echo "SELF-TEST: FAIL (the suite ran ZERO assertions)"
    echo "PREREG_MIRROR_VERDICT=INDETERMINATE"; return 3
  fi
  if [ "$fails" -gt 0 ]; then
    echo "SELF-TEST: FAIL ($fails of $ran)"
    echo "PREREG_MIRROR_VERDICT=INDETERMINATE"; return 3
  fi
  echo "SELF-TEST: PASS ($ran assertions)"
  echo "PREREG_MIRROR_VERDICT=PASS"
  return 0
}

# ── PROVE THE SELF-TEST CAN FAIL ────────────────────────────────────────────────────────────
# An assertion that has never failed is not an assertion. This breaks one load-bearing line at
# a time and REQUIRES the suite to go red — once per mutation, each aimed at a DIFFERENT leg,
# because a suite that only catches one kind of damage is not covered, it is lucky.
#
# `scripts/selftest-mutation-proof.sh` already exists and parameterises its SUBJECT — but its
# mutation TABLE is hardcoded to that subject's anchors, so it cannot be reused as-is. This
# repo's own rule for that situation is the 3-example threshold (CLAUDE.md: consume verbatim
# until the 3rd consumer, THEN extract), and this is consumer 2. So the table lives here, and
# EXTRACTION IS OWED AT CONSUMER 3: lift the table into a `MUTATION_PROOF_TABLE` file argument
# on the shared prover and point both subjects at it.
#
# EXIT MAPPING IS THE NORMAL ONE, DELIBERATELY UNLIKE THE SHARED PROVER. That script exits
# NON-ZERO on success because its consuming gate reads `[ "$mut" -eq 0 ] -> RED`; that
# inversion falls out of ITS caller's contract, not from a preference. Nothing reads both, so
# per the verdict-token law this picks its code LOCALLY: PROVEN=0, SURVIVED=1, INDETERMINATE=3.
#
#     MUTATION_PROOF_VERDICT=PROVEN | SURVIVED | INDETERMINATE
#
# The mutant is written INTO ops/scripts/, never a tmp dir. MEASURED while building this: a
# mutant in /tmp resolves `$HERE/../..` to a tmp parent, fails the vault-path load guard, and
# exits 3 before a single assertion runs — so every mutation would read "caught" for a reason
# that has nothing to do with the mutation. That is a vacuous proof wearing a green.
prove_self_test() {
  local subject="${BASH_SOURCE[0]}" mutant="$HERE/.pvm-mutant.sh" T
  local total=0 caught=0 survived=0 unanchored=0

  verdict_mp() { echo "MUTATION_PROOF_VERDICT=$1"; }

  command -v sed >/dev/null 2>&1 || { echo "✖ sed absent" >&2; verdict_mp INDETERMINATE; return 3; }
  if [ -e "$mutant" ]; then
    echo "✖ $mutant already exists — refusing to clobber a previous run's leftover" >&2
    verdict_mp INDETERMINATE; return 3
  fi
  T="$(mktemp -d "${TMPDIR:-/tmp}/pvmmp.XXXXXX")" || { echo "✖ mktemp" >&2; verdict_mp INDETERMINATE; return 3; }
  # shellcheck disable=SC2064
  trap "rm -f '$mutant'; rm -rf '$T'" RETURN

  # A healthy baseline is a PRECONDITION. Over a suite that is already red every mutation
  # "passes" for the wrong reason and the whole proof is vacuous.
  cp "$subject" "$mutant"
  if ! bash "$mutant" --self-test >"$T/baseline.log" 2>&1; then
    echo "✖ the UNMUTATED self-test is already failing — a mutation proof over a red suite is vacuous" >&2
    tail -6 "$T/baseline.log" >&2
    verdict_mp INDETERMINATE; return 3
  fi
  echo "  baseline: $(tail -2 "$T/baseline.log" | head -1)"

  # <label>::<sed expression>::<the assertion that MUST go red>
  # Every anchor is a unique substring of the subject; never a line number, which goes stale on
  # the next prose edit.
  local MUTATIONS='
kind-never-unclassified::s|^  echo UNCLASSIFIED$|  echo registration|::a TEMPLATE would mirror as a binding registration
discovery-matches-everything::s|grep -Eiq .preregistration|return 0; grep -Eiq (disabled) x|::any audits/ file would be mirrored
body-offset-off-by-one::s#+$(( $2 + 1 ))#+$(( $2 ))#::every body hash is unasserted
ladder-indeterminate-not-sticky::s|INDETERMINATE:\*) VERDICT=INDETERMINATE ;;|INDETERMINATE:*) : ;;|::"could not verify" could be laundered into FAIL or PASS
write-always-reports-written::s|echo unchanged; return 0|echo written; return 0|::vault churn would be invisible
verifier-ignores-hand-edit::s|if \[ "\\$got" != "\\$blob" \]; then|if false; then|::a hand-edited body reads PASS
verifier-ignores-own-hash::s|if \[ "\\$mine" != "\\$pinned" \]; then|if false; then|::a patched verifier clears itself
verifier-ignores-age::s|if \[ "\\$age_h" -gt "\\$MAX_AGE_HOURS" \]; then|if false; then|::a three-week-old mirror reads PASS
verifier-vacuity-guard-off::s|if \[ "\\$checked" -eq 0 \]; then|if false; then|::a verifier over ZERO files reads PASS
verifier-indeterminate-exits-0::s|FAIL) exit 1 ;; \*) exit 3 ;;|FAIL) exit 1 ;; *) exit 0 ;;|::the token->code map is unasserted
'

  while IFS= read -r row; do
    [ -n "$row" ] || continue
    local label rest expr why
    label="${row%%::*}"; rest="${row#*::}"
    expr="${rest%%::*}"; why="${rest##*::}"
    total=$(( total + 1 ))

    rm -f "$mutant"
    sed "$expr" "$subject" > "$mutant" 2>/dev/null
    chmod +x "$mutant"
    if cmp -s "$subject" "$mutant"; then
      unanchored=$(( unanchored + 1 ))
      echo "  ANCHOR-LOST  $label — the sed anchor matched nothing; the subject has moved under this proof"
      continue
    fi
    if bash "$mutant" --self-test >"$T/out-$total.log" 2>&1; then
      survived=$(( survived + 1 ))
      echo "  SURVIVED     $label — the suite stayed GREEN with the subject broken ($why)"
    else
      caught=$(( caught + 1 ))
      echo "  caught       $label ($why)"
    fi
  done <<MUT
$MUTATIONS
MUT

  echo "[mutation-proof] $caught/$total caught · $survived survived · $unanchored anchors lost"
  if [ "$total" -eq 0 ]; then
    echo "✖ the mutation table is EMPTY — this proof would report success having proven nothing" >&2
    verdict_mp INDETERMINATE; return 3
  fi
  if [ "$unanchored" -ne 0 ]; then verdict_mp INDETERMINATE; return 3; fi
  if [ "$survived" -ne 0 ];   then verdict_mp SURVIVED;      return 1; fi
  verdict_mp PROVEN
  return 0
}

# ── ARGUMENTS ───────────────────────────────────────────────────────────────────────────────
MODE=both
for a in "$@"; do
  case "$a" in
    --self-test)       self_test; exit $? ;;
    --prove-self-test) prove_self_test; exit $? ;;
    --show-config)     printf 'REPO=%s\nREF=%s\nVAULT_ROOT=%s\nMIRROR_DIR=%s\nSTATE_FILE=%s\nVERIFIER=%s\nMAX_AGE_HOURS=%s\n' \
                         "$REPO" "$REF" "$VAULT_ROOT" "$MIRROR_DIR" "$STATE_FILE" "$VERIFIER" "$MAX_AGE_HOURS"; exit 0 ;;
    --verify)          MODE=verify ;;
    mirror|both)       MODE="$a" ;;
    *) echo "unknown argument: $a" >&2; echo "PREREG_MIRROR_VERDICT=INDETERMINATE"; exit 3 ;;
  esac
done

case "$MODE" in
  mirror) do_mirror ;;
  verify) do_verify ;;
  both)   do_mirror; do_verify ;;
esac

for n in "${NOTES[@]:-}"; do [ -n "$n" ] && echo "  $n"; done
echo "PREREG_MIRROR_VERDICT=$VERDICT"
case "$VERDICT" in
  PASS) exit 0 ;;
  FAIL) exit 1 ;;
  *)    exit 3 ;;
esac
