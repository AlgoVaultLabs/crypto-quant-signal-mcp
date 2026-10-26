#!/usr/bin/env bash
#
# scripts/wait-deploy.sh — OPS-WAVE-THROUGHPUT-W1 CH1.
#
# A wave lands once (scripts/land.sh), then waits for the deploy.yml run of the landed SHA with
# ONE call to this script instead of hand-polling `gh run list`.
#
#   bash scripts/wait-deploy.sh <sha>          # <sha> = `git rev-parse HEAD` read AFTER LAND_VERDICT=LANDED
#   bash scripts/wait-deploy.sh --self-test    # hermetic: a stub `gh` on PATH, all four verdicts
#
# Polls every WAIT_DEPLOY_POLL_S (15) for at most WAIT_DEPLOY_MAX_S (540 — under the Bash tool's
# 10-minute cap). Prints the run URL, the duration, and exactly one terminal line:
#
#   DEPLOY_VERDICT=SUCCESS        exit 0
#   DEPLOY_VERDICT=FAILURE        exit 1   the run completed with any conclusion but success
#   DEPLOY_VERDICT=PENDING        exit 2   the run is still going at the deadline — call again
#   DEPLOY_VERDICT=INDETERMINATE  exit 3   no run after WAIT_DEPLOY_NORUN_S (120): paths-ignore
#                                          skipped the push, or `gh` failed. Never treated as fine.
#
# `gh run watch` is not used: it needs a run id and has no deadline.
# Portable to macOS bash 3.2.

set -u

POLL_S="${WAIT_DEPLOY_POLL_S:-15}"
MAX_S="${WAIT_DEPLOY_MAX_S:-540}"
NORUN_S="${WAIT_DEPLOY_NORUN_S:-120}"

verdict() {  # <token> <exit-code>
  printf 'DEPLOY_VERDICT=%s\n' "$1"
  exit "$2"
}

# One poll's answer as one tab-separated line: RUN <status> <conclusion> <url> <seconds> | NONE | BAD.
# Newest run first, as `gh run list` orders them.
parse_runs() {
  node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let runs; try { runs = JSON.parse(s); } catch { return console.log("BAD"); }
      if (!Array.isArray(runs)) return console.log("BAD");
      if (!runs.length) return console.log("NONE");
      const r = runs[0];
      const secs = Math.round((Date.parse(r.updatedAt) - Date.parse(r.createdAt)) / 1000);
      console.log(["RUN", r.status || "-", r.conclusion || "-", r.url || "-", Number.isFinite(secs) ? secs : "-"].join("\t"));
    });'
}

self_test() {
  local dir fails=0 n=0 out tok code
  dir="$(mktemp -d "${TMPDIR:-/tmp}/wait-deploy-selftest.XXXXXX")" || { printf 'WAIT_DEPLOY_SELFTEST=FAIL\n'; exit 1; }
  # The stub answers from WAIT_DEPLOY_STUB, exactly as `gh run list --json …` would.
  cat > "$dir/gh" <<'STUB'
#!/usr/bin/env bash
run='{"databaseId":1,"url":"https://github.com/o/r/actions/runs/1","createdAt":"2026-10-26T10:00:00Z","updatedAt":"2026-10-26T10:08:00Z"'
case "$WAIT_DEPLOY_STUB" in
  success) printf '[%s,"status":"completed","conclusion":"success"}]\n' "$run" ;;
  failure) printf '[%s,"status":"completed","conclusion":"failure"}]\n' "$run" ;;
  pending) printf '[%s,"status":"in_progress","conclusion":""}]\n' "$run" ;;
  none)    printf '[]\n' ;;
  error)   echo 'gh: HTTP 502' >&2; exit 1 ;;
esac
STUB
  chmod +x "$dir/gh"
  # <stub> <expected token> <expected exit>
  for c in 'success SUCCESS 0' 'failure FAILURE 1' 'pending PENDING 2' 'none INDETERMINATE 3' 'error INDETERMINATE 3'; do
    set -- $c
    n=$((n + 1))
    out="$(PATH="$dir:$PATH" WAIT_DEPLOY_STUB="$1" WAIT_DEPLOY_POLL_S=0 WAIT_DEPLOY_MAX_S=0 WAIT_DEPLOY_NORUN_S=0 \
      bash "$0" 0123456789abcdef0123456789abcdef01234567 2>&1)"; code=$?
    tok="$(printf '%s\n' "$out" | tail -1)"
    if [ "$tok" != "DEPLOY_VERDICT=$2" ] || [ "$code" != "$3" ]; then
      fails=$((fails + 1)); printf '  ✖ %s: wanted DEPLOY_VERDICT=%s exit %s, got %s exit %s\n' "$1" "$2" "$3" "$tok" "$code"
    fi
  done
  rm -rf "$dir"
  if [ "$fails" -eq 0 ] && [ "$n" -eq 5 ]; then
    printf 'wait-deploy: self-test passed (%s cases)\n' "$n"; printf 'WAIT_DEPLOY_SELFTEST=PASS\n'; exit 0
  fi
  printf 'wait-deploy: self-test FAILED (%s of %s)\n' "$fails" "$n"; printf 'WAIT_DEPLOY_SELFTEST=FAIL\n'; exit 1
}

case "${1:-}" in
  --self-test) self_test ;;
  -h|--help) sed -n '2,22p' "$0" | sed -e 's/^# \{0,1\}//'; exit 0 ;;
  '') printf '%s\n' "✖ wait-deploy: usage: wait-deploy.sh <sha> | --self-test"; verdict INDETERMINATE 3 ;;
esac

# `gh run list --commit` matches the full head SHA, so resolve anything shorter.
SHA="$1"
case "$SHA" in
  *[!0-9a-f]*|'') SHA="" ;;
esac
if [ "${#SHA}" -ne 40 ]; then
  SHA="$(git rev-parse --verify --quiet "$1^{commit}" 2>/dev/null)" || SHA=""
fi
[ -n "$SHA" ] || { printf '%s\n' "✖ wait-deploy: '$1' is not a commit"; verdict INDETERMINATE 3; }
command -v gh >/dev/null 2>&1 || { printf '%s\n' "✖ wait-deploy: gh is not on PATH"; verdict INDETERMINATE 3; }

START=$SECONDS
SEEN=""      # the last observed run while it was still going: "<status>\t<url>"
LAST_ERR=""
while :; do
  if json="$(gh run list --workflow deploy.yml --commit "$SHA" --json databaseId,status,conclusion,url,createdAt,updatedAt 2>&1)"; then
    line="$(printf '%s' "$json" | parse_runs)"
  else
    line="BAD"; LAST_ERR="$(printf '%s' "$json" | tail -1)"
  fi
  waited=$((SECONDS - START))
  case "$line" in
    RUN*)
      IFS="$(printf '\t')" read -r _ st concl url secs <<EOF
$line
EOF
      if [ "$st" = "completed" ]; then
        printf 'run: %s\nduration: %ss (created → last update)\nconclusion: %s\n' "$url" "$secs" "$concl"
        [ "$concl" = "success" ] && verdict SUCCESS 0
        verdict FAILURE 1
      fi
      SEEN="$st	$url"
      ;;
    *)
      if [ -z "$SEEN" ] && [ "$waited" -ge "$NORUN_S" ]; then
        printf '%s\n' "✖ wait-deploy: no deploy.yml run for $SHA after ${waited}s — paths-ignore skipped the push, or gh failed${LAST_ERR:+ ($LAST_ERR)}"
        verdict INDETERMINATE 3
      fi
      ;;
  esac
  if [ "$waited" -ge "$MAX_S" ]; then
    if [ -n "$SEEN" ]; then
      printf 'run: %s\nwaited: %ss, run still %s — call again\n' "${SEEN#*	}" "$waited" "${SEEN%%	*}"
      verdict PENDING 2
    fi
    verdict INDETERMINATE 3
  fi
  sleep "$POLL_S"
done
