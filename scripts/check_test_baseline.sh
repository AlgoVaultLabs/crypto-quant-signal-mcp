#!/usr/bin/env bash
# OPS-VITEST-SUITE-REPAIR-W1 / C4 — local test-baseline regression gate.
#
# Runs the full vitest suite (`vitest run`) AND the node:test canaries (the
# landing/design/geo `.test.mjs` files run via `node --test` in deploy.yml),
# then diffs the failing-FILE set against the committed baseline at
# audits/test-baseline-known-failures.txt. Exits 1 if ANY NEW failure appears
# (a regression) — this substitutes for the absent push-triggered CI greenness
# gate (deploys go via scripts/deploy-direct.sh; push-triggered GHA is flagged
# off). Sibling installer: scripts/install_test_gate_hook.sh wires this into
# .git/hooks/pre-push (composably).
#
# CONTRACT  [settled by OPS-TEST-GATE-RECONCILE-W1]
#   Every gate run prints EXACTLY ONE terminal machine-readable line:
#       TEST_GATE_VERDICT=PASS | FAIL | INDETERMINATE
#   Never absent, never more than one. Callers MUST read the TOKEN, not just the exit
#   code, and a chapter/CI verdict requires TEST_GATE_VERDICT=PASS.
#
#   exit 0  — PASS:          the suite ran and no new failure appeared vs the baseline.
#   exit 1  — FAIL:          at least one NEW failing file/runner vs the baseline.
#   exit 2  — INDETERMINATE: the gate COULD NOT VERIFY — the suite never ran, so
#                            NOTHING was checked. Distinct from 1 so "a test regressed"
#                            and "the gate is broken" are never confused. The installed
#                            hook is `… || exit 1`, so both block.
#
#   ⚠ THESE ARE DELIBERATELY *NOT* THE MONITORING EXIT CODES. Do not "align" them.
#   `postgres-cpu-autopilot.py` uses 0=silent / 1=escalate / 2=critical-bypass /
#   3=framework-error, where `2` means something else entirely. This script is a
#   git-hook / CI gate — a different domain with ZERO shared callers: nothing reads both
#   code spaces and no wrapper maps between them. So the cost of cross-domain divergence
#   is ~0, while two codes for ONE meaning *inside this script* is a live footgun.
#   OPS-TEST-GATE-FAILOPEN-W1 briefly introduced `3` on that symmetry argument; `2` was
#   already deployed for the same meaning, so `2` wins and `3` is retired.
#
# MODES  (env)
#   ALGOVAULT_TEST_GATE=block  (default) — 0 / 1 / 2 exactly as above.
#   ALGOVAULT_TEST_GATE=warn             — THE one fail-open lever and the documented
#                                          operator opt-out. It downgrades the exit CODE
#                                          to 0 but NEVER the token, so a degraded run
#                                          stays visibly degraded; the ungated push is
#                                          recorded in the fail-open ledger.
#                                          There is no `--hook` flag: the installed hook
#                                          already blocks on any non-zero, so a flag with
#                                          no consumer would be dead config.
#   ALGOVAULT_TEST_GATE_AUTOINSTALL=0    — disable the `npm ci` auto-recovery below.
#
# NOTHING FAILS OPEN SILENTLY. Missing node/npx/jq, an unrecoverable dependency state, a
# GENUINE compile error, an unusable report path (mktemp) and an unparseable vitest
# report are ALL "the gate verified nothing" ⇒ INDETERMINATE / exit 2, with the banner
# and (when the push is actually allowed) the ledger row.
#   [OPS-TEST-GATE-MKTEMP-PORTABILITY-W1 hard-failed the two report-path cases;
#    OPS-TEST-GATE-RECONCILE-W1 closed the remaining soft ones. Pinned by
#    tests/unit/test-gate-report-path.test.ts.]
#
#   ⚠ THE ONE BEHAVIOUR CHANGE + ITS REVERSAL LEVER. A cold checkout (no node_modules)
#   with autoinstall OFF now BLOCKS a push where it previously did not. That is only
#   acceptable because FAILOPEN-VISIBILITY-W1 shipped `ALGOVAULT_TEST_GATE_AUTOINSTALL`
#   in the same arc, so the cold case can self-heal instead of wedging. If auto-recovery
#   proves unreliable in practice the answer is `ALGOVAULT_TEST_GATE=warn` — NOT
#   re-widening fail_open() back to exit 0.
#
# OPS-TEST-GATE-FAILOPEN-VISIBILITY-W1 (2026-07-18) — fail-open used to be a
# single stderr line, so a checkout whose node_modules was 17 days stale pushed
# UNGATED for weeks without anyone noticing. Two changes, neither of which
# relaxes the compile-error policy:
#   1. RECOVER the recoverable class. A build that fails ONLY on TS2307
#      "Cannot find module" for packages that are declared-but-not-installed is
#      stale node_modules, not a code defect — `npm ci` once, rebuild, then run
#      the suite for real. A genuine compile error still fails open (it surfaces
#      via build/deploy, per the original policy).
#   2. Make every remaining fail-open UNMISSABLE and AUDITABLE — banner + an
#      append to $GIT_COMMON_DIR/algovault-test-gate-failopen.log, which the next
#      GREEN run reports and clears. A ledger nobody reads would be theatre.
#
# IDEMPOTENT — read-only against the repo (only writes /tmp logs + the gitignored
# dist/). Safe to run repeatedly; accepts a no-op `--check` flag.
#
# CONCURRENCY  [OPS-PARALLEL-SESSION-CAPACITY-W2 / Ch1]
#   This gate runs in EVERY checkout — 89 worktrees share one pre-push hook — so N
#   sessions pushing at once means N simultaneous full suites. Two consequences are
#   handled here; per-test budgets are Ch2's and the shared-SQLite races Ch3's.
#
#   1. WORKER CAP. vitest's default is `availableParallelism()-1` = 11 forks on this
#      12-core box: every gate assumes it owns the machine. MEASURED, n=3 clean runs
#      per arm with contaminated runs rejected — 11 workers: 32 s / 12 procs /
#      1.52 GB · 6: 32 s / 7 procs / 0.90 GB · 5: 36.5 s (+14 %) · 4: 44 s (+38 %) ·
#      3: 56 s (+75 %). 6 is the largest-for-free point: zero wall cost, -42 %
#      processes, -41 % RSS. Not a taste — total per-slot work is ~176 s against a
#      ~32 s floor set by the single slowest FILE (session-drift.test.ts is 34 s
#      ALONE), so the crossover sits at 176/32 ~= 5.5 and any cap below 6 trades
#      wall-clock for memory.
#      Set via VITEST_MAX_FORKS rather than --maxWorkers: it wins the same
#      precedence slot (poolOptions.forks.maxForks), and a future vitest that drops
#      the name silently ignores an unknown ENV VAR whereas an unknown CLI FLAG
#      throws CACError before any report is written — which would hard-block
#      `git push` in all 89 checkouts at once. Same cap, softer failure.
#      CI is deliberately NOT capped (deploy.yml's bare `npx vitest run`): it runs
#      on a 2-4 vCPU runner and has never had 11 workers to begin with.
#   2. PER-RUN LOG DIR. The five log paths were FIXED names directly under $TMPDIR,
#      so two concurrent gates overwrote each other's diagnostics last-writer-wins —
#      which is why three simultaneous failures naming three different file sets were
#      so hard to read. They now live in a per-run directory, KEPT on
#      FAIL/INDETERMINATE (hard_fail points the operator at it) and REMOVED on PASS
#      (nothing to diagnose, and unbounded per-run residue is what Ch3 is cleaning).
set -uo pipefail

# ── DECLARED CONTRACT VERSION  [OPS-GATE-STALENESS-ASSERT-W1] ──────────────────
#
# Read by the shared pre-push `gate-staleness` block, which cannot otherwise tell that
# the copy it is about to run is current. The hook is ONE shared file, but it invokes
# "$(git rev-parse --show-toplevel)/scripts/check_test_baseline.sh" — so the SCRIPT is
# per-worktree, and a checkout that has not rebased keeps running its own stale copy.
# Measured 2026-08-07: 24 of 43 worktrees still ran the pre-577a268 vacuous predicate.
#
# CONTRACT 1 guarantees:
#   * report_usable() is NON-VACUOUS — an explicit boolean over a non-zero result count,
#     never `jq -e` on a bare container (which exits 0 for [], {}, "" and 0).
#   * the predicates are SOURCEABLE — sourcing this file loads them and returns before
#     the gate body, so a fixture can assert report_usable + map_code without the suite.
#
# BUMP THIS when the contract changes, and raise `minimum_contract` in
# ops/gate-staleness-config.json in the SAME commit. Staleness then becomes visible for
# free — which is the whole point of the marker.
ALGOVAULT_TEST_GATE_CONTRACT=1

BASELINE_FILE="audits/test-baseline-known-failures.txt"

# The measured free cap. Overridable for experiments, but VALIDATED below: `0` means
# zero workers and vitest then HANGS FOREVER (tinypool), and this invocation carries
# no timeout inside a hook shared by every checkout.
GATE_MAX_WORKERS="${ALGOVAULT_GATE_MAX_WORKERS:-6}"
# Resolved BEFORE the first possible verdict() call, so warn-mode is honoured even on
# the earliest failure path (the `cd` below).
MODE="${ALGOVAULT_TEST_GATE:-block}"
# macOS exports TMPDIR WITH a trailing slash; strip it so composed paths don't
# contain a cosmetic `//` (it shows up in every log path this script prints).
TMP="${TMPDIR:-/tmp}"
TMP="${TMP%/}"

# ── test-importable entrypoint  [OPS-TEST-GATE-VACUITY-W1] ────────────────────
#
# The shell equivalent of CLAUDE.md's `if require.main === module` law: SOURCING this
# file loads the pure predicates ONLY — the gate body never runs — so `report_usable`
# can be exercised against fixtures without invoking the suite.
#
# This exists because the alternative was worse. The spec proposed an env lever that
# substitutes the report body (ALGOVAULT_TEST_GATE_REPORT); that would be a bypass which
# prints PASS, i.e. a silent green path on the one instrument every other gate's evidence
# depends on — the exact shape this arc exists to eliminate. `ALGOVAULT_TEST_GATE=warn`
# stays the ONLY sanctioned bypass, and it is loud: it downgrades the exit CODE while
# still printing the real token.
#
# `return` outside a function is valid only in a sourced context, so the probe is
# self-checking rather than a guess about how we were invoked.
if (return 0 2>/dev/null); then TEST_GATE_SOURCED=1; else TEST_GATE_SOURCED=0; fi

info() { echo "[test-gate] $*"; }
warn() { echo "[test-gate] WARNING: $*" >&2; }

# ── per-run log directory  [OPS-PARALLEL-SESSION-CAPACITY-W2 / Ch1] ────────────
#
# `XXXXXX` MUST be TERMINAL: BSD/macOS mktemp does not substitute it when a suffix
# follows, so `foo.XXXXXX.log` yields a file named LITERALLY that — and once such a
# leftover exists the NEXT mktemp exits 1 with empty stdout. This repo has been bitten
# by that twice; the report-dir path below carries the same rule for the same reason.
#
# Falls back to $TMP (the old shared location) rather than dying: a gate that cannot
# make a temp dir should still run the suite, just without collision-isolated logs.
# Skipped when SOURCED: a fixture harness that only wants the predicates must not leave a
# temp dir behind on every call. verdict()/cleanup_logdir_on_pass() both read ${LOGDIR:-}
# defensively, so an empty value is safe.
if [ "${TEST_GATE_SOURCED:-0}" = "1" ]; then
  LOGDIR=""
else
  LOGDIR="$(mktemp -d "$TMP/test-gate-run.XXXXXX" 2>/dev/null)" || LOGDIR=""
  if [ -z "$LOGDIR" ] || [ ! -d "$LOGDIR" ]; then
    LOGDIR="$TMP"
    warn "could not create a per-run log dir under $TMP — falling back to shared log names."
  fi
fi

# ── the ONE place a verdict is emitted  [OPS-TEST-GATE-RECONCILE-W1] ───────────
#
# Single-derivation: token → exit code is mapped here and nowhere else, and every
# terminal path goes through verdict(). That is what makes "exactly one
# TEST_GATE_VERDICT line per run" structural rather than a convention the next
# early-return has to remember.
#
# `2` (not 3) for INDETERMINATE: `2` is what main already deployed for "could not
# verify", and one meaning must not acquire a second code. See the docblock for why
# the monitoring 0/1/2/3 convention deliberately does NOT apply in this domain.
map_code() {  # $1 = token, $2 = mode → echoes the exit code
  local c
  case "$1" in
    PASS)          c=0 ;;
    FAIL)          c=1 ;;
    INDETERMINATE) c=2 ;;
    *)             echo 2; return 0 ;;
  esac
  # warn downgrades the CODE, never the token.
  if [ "$c" -ne 0 ] && [ "${2:-block}" = "warn" ]; then c=0; fi
  echo "$c"
}

# Logs are a DIAGNOSTIC, so their lifetime is a function of the verdict, not of the
# process exiting: dropped on PASS (nothing to read, and per-run residue would
# accumulate forever), kept on FAIL/INDETERMINATE where hard_fail/fail_open have just
# told the operator to go read them. A blanket `trap ... EXIT` cleanup would delete
# the file the failure message points at — which is why it is deliberately not one.
# Never touches $TMP itself, so the fallback path above cannot wipe the shared dir.
cleanup_logdir_on_pass() {  # $1 = token
  [ "$1" = "PASS" ] || return 0
  [ -n "${LOGDIR:-}" ] && [ "$LOGDIR" != "$TMP" ] && [ -d "$LOGDIR" ] || return 0
  rm -rf "$LOGDIR"
}

verdict() {  # $1 = PASS|FAIL|INDETERMINATE
  local token="$1" code
  case "$token" in
    PASS|FAIL|INDETERMINATE) ;;
    *) warn "internal: unknown verdict token '$token' — reporting INDETERMINATE."; token=INDETERMINATE ;;
  esac
  code="$(map_code "$token" "$MODE")"
  if [ "$token" != "PASS" ] && [ "$MODE" = "warn" ]; then
    warn "ALGOVAULT_TEST_GATE=warn → $token downgraded to exit 0. Nothing is blocked."
  fi
  if [ "$token" != "PASS" ] && [ -n "${LOGDIR:-}" ] && [ "$LOGDIR" != "$TMP" ]; then
    echo "[test-gate] diagnostics for THIS run: $LOGDIR" >&2
  fi
  cleanup_logdir_on_pass "$token"
  echo "TEST_GATE_VERDICT=$token"
  exit "$code"
}

# ── pure decision helpers (driven directly by --self-test) ─────────────────────
# Side-effect-free so the self-test exercises the REAL logic rather than a copy —
# a self-test against a copy proves nothing about the shipped path.
# A report is usable only if it carries AT LEAST ONE result. `jq -e` is falsy for
# `null` and `false` ONLY, so an EMPTY ARRAY is truthy — and a vitest run that
# collected zero test files writes exactly `{"testResults":[]}` while exiting 1,
# an exit code the `|| true` on the runner line discards. So the plain
# `jq -e '.testResults'` accepted that report, CURRENT_FAILS came back empty, and
# the gate printed PASS having verified NOTHING — the same dark-guard shape as the
# 2026-07-29 mktemp incident this branch was hardened for, one layer in.
# (REVENUE-METER-TRUTH-W6 Step 0B. "Verified nothing" is not "verified clean": an
# empty report is INDETERMINATE, which `hard_fail` below renders as exit 2.)
report_usable() {  # $1 = report path
  [ -n "${1:-}" ] && [ -f "$1" ] && jq -e '(.testResults // []) | length > 0' "$1" >/dev/null 2>&1
}
compute_new_fails() {  # $1 = baseline set, $2 = current failing set
  comm -13 <(printf '%s\n' "$1") <(printf '%s\n' "$2") | grep -vE '^[[:space:]]*$' || true
}
decide_verdict() {  # $1 = new-failure set, $2 = node:test failure marker
  if [ -n "${1:-}" ] || [ -n "${2:-}" ]; then echo FAIL; else echo PASS; fi
}

# ── partial-run ratchet + failure-evidence ledger  [OPS-TEST-GATE-VACUITY-W1] ──
#
# The defect that started this arc was found because a ~5,000-test suite finished in 51
# seconds and somebody refused to believe it. An EMPTY report is now caught by
# report_usable; a PARTIAL one is the adjacent hazard, and nothing detected it.
#
# REPORT-ONLY, deliberately. It cannot distinguish a legitimate subset invocation
# (`vitest run tests/unit`) or a wave that genuinely deletes tests from a real partial
# run, so it states BOTH numbers and lets the human decide. Promotion to blocking is a
# named follow-up gated on the observed false-positive rate — the same mode-1/mode-2
# shape as the session-drift detector.

RATCHET_DROP_FRACTION="${ALGOVAULT_TEST_GATE_RATCHET_FRACTION:-0.75}"

gate_common_dir() {  # the shared, never-committed state dir; env var is unset above by design
  git rev-parse --git-common-dir 2>/dev/null || echo ".git"
}

# The counter is KEYED, never global. 40+ worktrees run different branches and different
# subsets against ONE $GIT_COMMON_DIR; a single shared count would be written by all of
# them and the ratchet would fire constantly on other people's runs. Key = branch when we
# have one, else the worktree path — sanitised to a flat filename.
count_key() {
  local raw
  raw="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
  [ -z "$raw" ] || [ "$raw" = "HEAD" ] && raw="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  printf '%s' "$raw" | tr '/ ' '__' | tr -cd 'A-Za-z0-9._-'
}

report_total_tests() {  # $1 = report path → total test count, or empty when unreadable
  jq -r '[.testResults[]?.assertionResults[]?] | length' "$1" 2>/dev/null
}

# Pure decision helper, driven directly by --self-test.
ratchet_verdict() {  # $1 = observed, $2 = prior, $3 = fraction → OK | DROP | NO_PRIOR
  local obs="${1:-}" prior="${2:-}" frac="${3:-0.75}"
  [ -z "$prior" ] && { echo NO_PRIOR; return 0; }
  [ -z "$obs" ] && { echo NO_PRIOR; return 0; }
  awk -v o="$obs" -v p="$prior" -v f="$frac" \
      'BEGIN { if (p > 0 && o < p * f) print "DROP"; else print "OK" }'
}

# ── the sourcing boundary  [OPS-TEST-GATE-VACUITY-W1] ─────────────────────────
# Everything ABOVE is a pure predicate or a decision helper; everything BELOW runs the
# gate. A caller that sourced us gets the former and none of the latter, so a fixture can
# assert `report_usable` + `map_code` — the token AND its exit code — without the suite.
# Keep new predicates above this line and new gate logic below it.
if [ "${TEST_GATE_SOURCED:-0}" = "1" ]; then return 0; fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
# Was `exit 0` — a 9th silent fail-open. If we cannot even locate the repo root then
# nothing was verified, and the caller must hear that rather than read a pass.
cd "$REPO_ROOT" || { warn "cannot cd to repo root — nothing was verified."; verdict INDETERMINATE; }

# CRITICAL: when invoked from a git hook (pre-push), git exports GIT_DIR /
# GIT_INDEX_FILE / GIT_WORK_TREE / GIT_PREFIX / GIT_COMMON_DIR / GIT_QUARANTINE_PATH
# into the environment. Tests that spawn `git` subprocesses (e.g.
# tests/unit/check-system-map.test.ts, which inits temp git repos and runs
# `git -C <tmpdir> commit`) would inherit them and operate on the WRONG repo —
# the env GIT_DIR overrides even `git -C` → the temp-repo setup fails → false
# regressions that would block EVERY push. Scrub them so the suite runs in a
# clean git env (REPO_ROOT was already resolved above, before this point).
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX GIT_COMMON_DIR \
      GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_QUARANTINE_PATH \
      GIT_NAMESPACE GIT_REFLOG_ACTION 2>/dev/null || true

# (BASELINE_FILE / MODE / TMP / info / warn are declared above the `cd`, so the
#  earliest failure path can already emit a verdict.)

# ── OPS-TEST-GATE-FAILOPEN-VISIBILITY-W1 — loud + auditable fail-open ──────────
#
# The gate is allowed to fail OPEN so tooling breakage never blocks a legit push.
# But "fail open" means NO TEST RAN, and the original single-line stderr warning
# was easy to miss in the middle of push output — so a checkout with stale
# node_modules pushed UNGATED for 17 days without anyone noticing (found
# 2026-07-18; it had already been noted twice in status.md and shrugged off).
#
# Every fail-open now (a) prints an unmissable banner and (b) appends to a ledger
# in $GIT_COMMON_DIR (shared across worktrees, never committed). The ledger is
# READ BACK and surfaced by the next GREEN run — that is what keeps it honest
# rather than a write-only file nobody opens.
FAILOPEN_LOG="$(git rev-parse --git-common-dir 2>/dev/null || echo .git)/algovault-test-gate-failopen.log"

# OPS-TEST-GATE-RECONCILE-W1 — this function keeps its name, its banner and its
# ledger, but no longer decides the exit code: it reports INDETERMINATE and lets
# verdict() map it. In `block` that is exit 2 (the push is stopped); under
# ALGOVAULT_TEST_GATE=warn it is exit 0 (the documented opt-out).
#
# The ledger records UNGATED PUSHES only. A blocked run let nothing through, so it is
# not a ledger event — the invariant main already pinned with "a blocking hard failure
# does NOT write a ledger row", now extended consistently to the soft cases that used
# to be unconditionally exit-0.
fail_open() {
  local reason="$1" sha allowed=no
  [ "$MODE" = "warn" ] && allowed=yes
  sha="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  {
    echo ""
    echo "════════════════════════════════════════════════════════════════════════"
    if [ "$allowed" = yes ]; then
      echo "  ⚠  TEST GATE SKIPPED — THIS PUSH IS UNGATED"
    else
      echo "  ✗  TEST GATE COULD NOT VERIFY — NO TESTS RAN"
    fi
    echo "════════════════════════════════════════════════════════════════════════"
    echo "  reason : $reason"
    if [ "$allowed" = yes ]; then
      echo "  effect : NO tests ran. Nothing was verified. Allowing the push (exit 0)."
      echo "  logged : $FAILOPEN_LOG"
    else
      echo "  effect : NO tests ran. Nothing was verified. BLOCKING (exit 2)."
      echo "  fix    : usually 'npm ci'. Deliberate override: ALGOVAULT_TEST_GATE=warn"
    fi
    echo "════════════════════════════════════════════════════════════════════════"
    echo ""
  } >&2
  if [ "$allowed" = yes ]; then
    printf '%s\t%s\t%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$sha" "$reason" >>"$FAILOPEN_LOG" 2>/dev/null || true
  fi
  verdict INDETERMINATE
}

# Surfaced on the GREEN path: the suite has now actually run, so any previously
# ungated commits are covered — report them once, then clear the ledger.
report_and_clear_failopen_ledger() {
  [ -s "$FAILOPEN_LOG" ] || return 0
  local n; n="$(grep -cE '.' "$FAILOPEN_LOG" 2>/dev/null || true)"; n="${n:-0}"
  {
    echo ""
    echo "[test-gate] NOTE: $n push(es) went UNGATED since the last GREEN gate:"
    sed 's/^/  /' "$FAILOPEN_LOG"
    echo "[test-gate] the suite has now run GREEN, so those commits are covered — clearing the ledger."
    echo ""
  } >&2
  : >"$FAILOPEN_LOG"
}

# ── build-failure classifier ──────────────────────────────────────────────────
#
# Distinguishes the two build-failure classes, which need OPPOSITE responses:
#
#   RECOVERABLE   — every error is TS2307 "Cannot find module 'X'" where X
#                   resolves to a package the manifest declares but node_modules
#                   does not currently satisfy, either because it is NOT INSTALLED
#                   or because it is installed AT A VERSION OUTSIDE THE DECLARED
#                   RANGE. Both are stale node_modules, not a code defect: there is
#                   nothing for a human to fix and the gate can be made meaningful
#                   again by `npm ci`. Failing open here is simply wrong.
#   COMPILE_ERROR — anything else (a non-TS2307 error, a relative-path TS2307, or
#                   a package that is declared AND installed at a version the range
#                   ALLOWS yet is unresolvable). Real compile errors keep the
#                   documented fail-open policy: they surface via build/deploy, not
#                   this gate.
#
# OPS-TEST-GATE-VERSION-MISMATCH-W1 (2026-07-31) added the second RECOVERABLE arm.
# "Is it installed?" and "is the RIGHT one installed?" are different questions, and
# only the first had an answer here. Observed during
# OPS-X402-SCHEME-REGISTRATION-INVARIANT-W1:
#
#   src/lib/builder-code-constants.ts(34,8): error TS2307: Cannot find module
#   '@x402/extensions/builder-code' or its corresponding type declarations.
#
# package.json required `~2.20.0` after OPS-BASE-BUILDER-CODE-W1's bump; the
# checkout held 2.9.0, which ships no `builder-code` subpath. The package was
# declared AND present, so the presence check answered "installed" and the log was
# filed as a genuine compile error — auto-recovery never fired and the operator ran
# `npm ci` by hand. (The gate itself behaved correctly: INDETERMINATE/exit 2 blocked
# the push. Only the classification was wrong.)
#
# Manifest/node_modules roots are overridable so the classifier is unit-testable
# against fixture logs (tests/unit/test-gate-build-classifier.test.ts).
TEST_GATE_MANIFEST="${TEST_GATE_MANIFEST:-package.json}"
TEST_GATE_NODE_MODULES="${TEST_GATE_NODE_MODULES:-node_modules}"

# '@scope/pkg/sub' → '@scope/pkg' · 'pkg/sub' → 'pkg' · './rel' → '' (not a package)
pkg_of_specifier() {
  case "$1" in
    .*|/*) echo "" ;;
    @*)    echo "$1" | cut -d/ -f1,2 ;;
    *)     echo "$1" | cut -d/ -f1 ;;
  esac
}

# ── minimal semver, deliberately NOT rented from node_modules ─────────────────
#
# This code runs precisely when node_modules is suspect, so resolving `semver`
# out of it to diagnose it would be circular — and `semver` is not a declared
# dependency of this repo anyway. What is implemented here is exactly the range
# grammar package.json actually uses (`^X.Y.Z`, `~X.Y.Z`, `X.Y.Z`); everything
# else answers `unknown` rather than guessing. See version_satisfies().

# Strict `X.Y.Z` → "X Y Z". Partials ('2', '2.9'), prereleases, build metadata
# and anything non-numeric → "" (undecidable). Padding a partial would be a
# guess: npm reads '1.2' as the RANGE >=1.2.0 <1.3.0, not as the version 1.2.0.
ver_norm() {
  printf '%s' "${1:-}" | awk '
    /^[0-9]+\.[0-9]+\.[0-9]+$/ { split($0, f, "."); printf "%s %s %s", f[1]+0, f[2]+0, f[3]+0 }'
}

# Compare two normalised triples → -1 | 0 | 1.
#
# NUMERIC per component, never lexical: as strings "9" sorts ABOVE "20" and "10"
# sorts BELOW "2".
#
# Which direction actually bites was measured, not assumed. Mutating this to a
# string compare and re-running the suite leaves the live 2.9.0-vs-~2.20.0 pair on
# RECOVERABLE anyway (both bounds compare wrong, and the two errors cancel) — so
# that pair does NOT pin this. What flips is a HEALTHY install: 1.10.0 against
# ^1.2.0 reads as below the lower bound and gets condemned as stale, reinstalling
# on every build. tests/unit/test-gate-build-classifier.test.ts carries the guard
# on that case for exactly this reason.
ver_cmp() {
  local -a A B; local i
  read -r -a A <<<"$1"; read -r -a B <<<"$2"
  for i in 0 1 2; do
    [ "${A[i]}" -lt "${B[i]}" ] && { echo -1; return 0; }
    [ "${A[i]}" -gt "${B[i]}" ] && { echo 1; return 0; }
  done
  echo 0
}

# Does installed version $1 satisfy declared range $2? → yes | no | unknown
#
# `unknown` is a first-class answer, not a failure. The caller acts ONLY on a
# proven `no`, so an undecidable range (npm:/git:/file: aliases, dist-tags,
# compound `>=x <y` or `||` ranges, wildcards, prereleases) keeps the settled
# COMPILE_ERROR behaviour instead of triggering a reinstall on a hunch.
version_satisfies() {
  local v="$1" range="$2" op base bv vv M m p uM um up
  vv="$(ver_norm "$v")"
  [ -n "$vv" ] || { echo unknown; return 0; }

  # Trim surrounding whitespace before matching.
  range="${range#"${range%%[![:space:]]*}"}"
  range="${range%"${range##*[![:space:]]}"}"

  case "$range" in
    ''|'*'|x|X)      echo yes;     return 0 ;;  # any version is in range
    *[[:space:]]*)   echo unknown; return 0 ;;  # compound: '>=1.0.0 <2.0.0'
    *'|'*)           echo unknown; return 0 ;;  # alternation: '^1 || ^2'
    *:*)             echo unknown; return 0 ;;  # npm:/git:/file: alias or URL
  esac

  case "$range" in
    '^'*)    op=caret; base="${range#^}"  ;;
    '~'*)    op=tilde; base="${range#\~}" ;;
    '='*)    op=eq;    base="${range#=}"  ;;
    [0-9]*)  op=eq;    base="$range"      ;;
    *)       echo unknown; return 0 ;;          # >=, <, -, x-ranges, dist-tags
  esac

  bv="$(ver_norm "$base")"
  [ -n "$bv" ] || { echo unknown; return 0; }

  # Every supported operator shares the same inclusive lower bound.
  [ "$(ver_cmp "$vv" "$bv")" -lt 0 ] && { echo no; return 0; }
  [ "$op" = eq ] && { [ "$(ver_cmp "$vv" "$bv")" -eq 0 ] && echo yes || echo no; return 0; }

  read -r M m p <<<"$bv"
  if [ "$op" = tilde ]; then                       # ~X.Y.Z → <X.(Y+1).0
    uM="$M"; um=$((m + 1)); up=0
  elif [ "$M" -gt 0 ]; then                        # ^X.Y.Z → <(X+1).0.0
    uM=$((M + 1)); um=0; up=0
  elif [ "$m" -gt 0 ]; then                        # ^0.Y.Z → <0.(Y+1).0
    uM=0; um=$((m + 1)); up=0
  else                                             # ^0.0.Z → <0.0.(Z+1)
    uM=0; um=0; up=$((p + 1))
  fi
  [ "$(ver_cmp "$vv" "$uM $um $up")" -lt 0 ] && echo yes || echo no
}

classify_build_log() {
  local log="$1" errs total ts2307 spec pkg range installed
  [ -f "$log" ] || { echo "COMPILE_ERROR"; return 0; }
  errs="$(grep -E "error TS[0-9]+:" "$log" 2>/dev/null || true)"
  # A build that failed without emitting a single TS error is not a dependency
  # problem (OOM, tsc crash, bad tsconfig) → treat as COMPILE_ERROR (fail open).
  [ -n "$errs" ] || { echo "COMPILE_ERROR"; return 0; }

  total="$(printf '%s\n' "$errs" | grep -cE "error TS[0-9]+:" || true)"
  ts2307="$(printf '%s\n' "$errs" | grep -cE "error TS2307:" || true)"
  # Numeric compare, never string — `wc`/`grep -c` pad with whitespace on BSD.
  [ "${total:-0}" -eq "${ts2307:-0}" ] || { echo "COMPILE_ERROR"; return 0; }

  while IFS= read -r spec; do
    [ -n "$spec" ] || continue
    pkg="$(pkg_of_specifier "$spec")"
    # Relative/absolute import that cannot resolve = a real code defect.
    [ -n "$pkg" ] || { echo "COMPILE_ERROR"; return 0; }
    # Not declared anywhere = a real defect (or a missing dependency entry).
    # An unreadable/malformed manifest yields an empty range and lands here too.
    range="$(jq -r --arg p "$pkg" \
      '(.dependencies[$p] // .devDependencies[$p] // .optionalDependencies[$p]) // empty' \
      "$TEST_GATE_MANIFEST" 2>/dev/null || true)"
    [ -n "$range" ] || { echo "COMPILE_ERROR"; return 0; }
    # Declared and absent from disk = the classic stale install.
    [ -d "$TEST_GATE_NODE_MODULES/$pkg" ] || continue
    # Declared AND on disk: still recoverable, but ONLY on a PROVEN range
    # violation — the installed copy predates a manifest bump and cannot offer
    # what the code imports, which is exactly what `npm ci` fixes. A missing
    # version, an unreadable package.json or an undecidable range all answer
    # something other than `no`, so "cannot tell" keeps the settled
    # COMPILE_ERROR verdict rather than reinstalling on a hunch.
    installed="$(jq -r '.version // empty' \
      "$TEST_GATE_NODE_MODULES/$pkg/package.json" 2>/dev/null || true)"
    [ "$(version_satisfies "$installed" "$range")" = no ] \
      || { echo "COMPILE_ERROR"; return 0; }
  done < <(printf '%s\n' "$errs" | sed -n "s/.*Cannot find module '\([^']*\)'.*/\1/p" | sort -u)

  echo "RECOVERABLE"
}

# Test/debug entrypoint: classify a build log and exit. Keeps the classifier
# drivable from a unit test without running a build or a push.
if [ "${1:-}" = "--classify-build-log" ]; then
  command -v jq >/dev/null 2>&1 || { echo "jq required" >&2; exit 2; }
  classify_build_log "${2:?usage: $0 --classify-build-log <build.log>}"
  # DELIBERATELY token-free: this is a debug/test entrypoint whose STDOUT *is* the
  # classification, read directly by tests/unit/test-gate-build-classifier.test.ts.
  # The one-verdict-line contract governs GATE runs and --self-test, not this probe.
  exit 0
fi

# ── --self-test (hermetic: never runs the real suite) ──────────────────────────
#
# Drives the REAL pure helpers above, so a green self-test says something about the
# shipped decision path rather than about a copy of it.
if [ "${1:-}" = "--self-test" ]; then
  command -v jq >/dev/null 2>&1 || { echo "✖ self-test needs jq on PATH"; echo "TEST_GATE_VERDICT=INDETERMINATE"; exit 2; }
  st_dir="$(mktemp -d "$TMP"/test-gate-selftest.XXXXXX)" || { echo "✖ self-test could not mktemp -d"; echo "TEST_GATE_VERDICT=INDETERMINATE"; exit 2; }
  trap 'rm -rf "$st_dir"' EXIT
  printf '{"testResults":[{"name":"/r/tests/a.test.ts","status":"passed"}]}' > "$st_dir/good.json"
  printf 'not json at all'                                                   > "$st_dir/garbage.json"
  # What vitest writes when it collected ZERO test files: well-formed, parseable,
  # and empty. Truthy to a bare `jq -e`, which is how a gate over nothing read green.
  printf '{"testResults":[]}'                                                > "$st_dir/empty.json"

  st_fails=(); st_fire=0; st_nofire=0; st_map=0

  # must-map: the token→exit-code mapping IS the contract, so it is asserted directly
  # rather than merely implied by the token assertions.
  #
  # This corpus exists because the deliberate-breakage step found it missing in
  # OPS-TEST-GATE-FAILOPEN-W1: with only token assertions, re-coding the INDETERMINATE
  # mapping to 0 — precisely the defect this arc exists to fix — left the self-test
  # fully green. A self-test that cannot catch the regression it was written for is
  # decoration.
  chk_map() {  # $1 = label, $2 = expected code, $3 = token, $4 = mode
    st_map=$((st_map + 1))
    local got; got="$(map_code "$3" "$4")"
    if [ "$2" = "$got" ]; then echo "    ✓ must-map: $1 ⇒ exit $got"
    else st_fails+=("WRONG must-map: $1 — expected exit $2, got $got"); fi
  }
  chk_fire() {  # $1 = case, $2 = expected token, $3 = actual token
    st_fire=$((st_fire + 1))
    if [ "$2" = "$3" ]; then echo "    ✓ must-fire: $1 ⇒ $3/$(map_code "$3" block)"
    else st_fails+=("MISSED must-fire: $1 — expected $2, got $3"); fi
  }
  chk_nofire() {
    st_nofire=$((st_nofire + 1))
    if [ "$2" = "$3" ]; then echo "    ✓ must-not-fire: $1 ⇒ $3/$(map_code "$3" block)"
    else st_fails+=("FALSE POSITIVE must-not-fire: $1 — expected $2, got $3"); fi
  }
  tok_for_report() { if report_usable "${1:-}"; then echo PASS; else echo INDETERMINATE; fi; }

  echo "[test-gate] --self-test (hermetic; no suite is run)"
  chk_fire   "empty report path (mktemp failure)"   INDETERMINATE "$(tok_for_report "")"
  chk_fire   "unparseable report"                   INDETERMINATE "$(tok_for_report "$st_dir/garbage.json")"
  chk_fire   "absent report file"                   INDETERMINATE "$(tok_for_report "$st_dir/nope.json")"
  chk_fire   "empty report (vitest ran ZERO files)" INDETERMINATE "$(tok_for_report "$st_dir/empty.json")"
  chk_fire   "new failure absent from the baseline" FAIL \
             "$(decide_verdict "$(compute_new_fails "tests/known.test.ts" "tests/known.test.ts
tests/brand-new.test.ts")" "")"
  chk_nofire "clean report matching the baseline"   PASS \
             "$(decide_verdict "$(compute_new_fails "tests/known.test.ts" "")" "")"
  chk_nofire "the only failure IS allow-listed"     PASS \
             "$(decide_verdict "$(compute_new_fails "tests/known.test.ts" "tests/known.test.ts")" "")"
  # The POSITIVE side of report_usable, and it is not optional. Every other case
  # driving this predicate is a must-FIRE expecting INDETERMINATE, so before this
  # line `report_usable() { return 1; }` passed the whole self-test green — the
  # predicate could be stubbed dead and nothing here would notice. `good.json` was
  # written at the top of this block and read by nothing until now.
  chk_nofire "populated report IS usable"           PASS "$(tok_for_report "$st_dir/good.json")"

  chk_map "PASS in block mode"          0 PASS          block
  chk_map "FAIL in block mode"          1 FAIL          block
  chk_map "INDETERMINATE in block mode" 2 INDETERMINATE block
  chk_map "FAIL under warn"             0 FAIL          warn
  chk_map "INDETERMINATE under warn"    0 INDETERMINATE warn
  chk_map "PASS is never downgraded"    0 PASS          warn

  # Vacuity guard — a self-test that ran zero assertions prints the same ✓ as one that
  # ran twelve. CLOSEDBAR CH2's PII-guard self-test shipped exactly that way and
  # reported a green "passed (0 must-fire, 0 must-not-fire)".
  # ── ratchet + vacuity predicate, both directions  [OPS-TEST-GATE-VACUITY-W1] ──
  # Assertions are wrapped so a broken subject reports FAIL rather than aborting the
  # suite — "proven able to fail" must produce a VERDICT, not a crash.
  st_eq() {  # $1 = label, $2 = got, $3 = want
    st_map=$((st_map + 1))
    if [ "$2" = "$3" ]; then echo "    ✓ $1 ⇒ $3"; else st_fails+=("$1: got '$2' want '$3'"); fi
  }
  st_eq "ratchet: no prior recorded"        "$(ratchet_verdict 4000 ""    0.75)" "NO_PRIOR"
  st_eq "ratchet: unreadable observed"      "$(ratchet_verdict ""   4000  0.75)" "NO_PRIOR"
  st_eq "ratchet: steady run"               "$(ratchet_verdict 4000 4000  0.75)" "OK"
  st_eq "ratchet: suite GREW"               "$(ratchet_verdict 5000 4000  0.75)" "OK"
  st_eq "ratchet: small dip is not a drop"  "$(ratchet_verdict 3200 4000  0.75)" "OK"
  st_eq "ratchet: PARTIAL run FIRES"        "$(ratchet_verdict 1200 4000  0.75)" "DROP"
  st_eq "ratchet: near-empty run FIRES"     "$(ratchet_verdict 1    4000  0.75)" "DROP"
  st_eq "ratchet: prior 0 cannot divide"    "$(ratchet_verdict 0    0     0.75)" "OK"

  # The vacuity predicate itself — the defect this wave exists for. Token AND code.
  st_vac_dir="$(mktemp -d "$TMP/test-gate-vac.XXXXXX")"
  printf '%s' '{"testResults":[]}'                                  > "$st_vac_dir/empty.json"
  printf '%s' '{"testResults":[{"name":"a","assertionResults":[{}]}]}' > "$st_vac_dir/good.json"
  printf '%s' '{}'                                                  > "$st_vac_dir/nokey.json"
  printf '%s' 'not json'                                            > "$st_vac_dir/junk.json"
  st_tok() { if report_usable "$1"; then echo PASS; else echo INDETERMINATE; fi; }
  for st_f in empty nokey junk; do
    st_eq "vacuity: $st_f report ⇒ token"      "$(st_tok "$st_vac_dir/$st_f.json")"              "INDETERMINATE"
    st_eq "vacuity: $st_f report ⇒ exit code"  "$(map_code "$(st_tok "$st_vac_dir/$st_f.json")" block)" "2"
  done
  st_eq "vacuity: absent report ⇒ token"       "$(st_tok "$st_vac_dir/nope.json")"               "INDETERMINATE"
  st_eq "vacuity: POPULATED report ⇒ token"    "$(st_tok "$st_vac_dir/good.json")"               "PASS"
  st_eq "vacuity: POPULATED report ⇒ exit 0"   "$(map_code "$(st_tok "$st_vac_dir/good.json")" block)" "0"
  st_eq "count_key is non-empty and flat"      "$(count_key | grep -cE '^[A-Za-z0-9._-]+$')"     "1"
  rm -rf "$st_vac_dir"

  if [ "$st_fire" -eq 0 ] || [ "$st_nofire" -eq 0 ] || [ "$st_map" -eq 0 ]; then
    echo "self-test failed: VACUOUS — must-fire=$st_fire must-not-fire=$st_nofire must-map=$st_map (all must be > 0); refusing to report a pass."
    echo "TEST_GATE_VERDICT=INDETERMINATE"
    exit 2
  fi
  if [ "${#st_fails[@]}" -gt 0 ]; then
    echo "self-test failed:"; printf '   - %s\n' "${st_fails[@]}"
    echo "TEST_GATE_VERDICT=FAIL"
    exit 1
  fi
  echo "self-test passed ($st_fire must-fire, $st_nofire must-not-fire, $st_map must-map)"
  echo "TEST_GATE_VERDICT=PASS"
  exit 0
fi

# ── hard fail: the gate could not run the suite ────────────────────────────────
#
# The stricter sibling of fail_open() above, and the one line where the two waves
# that shaped this script disagreed.
#
# fail_open() is for a genuinely INCONCLUSIVE environment the pusher can't fix
# from inside this hook (no node/npx/jq, an unrecoverable dependency state, a
# compile error that surfaces loudly via build/deploy anyway). "The suite did not
# run" is a different class: the gate verified NOTHING, and exiting 0 there is
# indistinguishable from a healthy GREEN — the exact failure mode this gate exists
# to prevent (CLAUDE.md: "installed is not working"; a dark guard exiting 0 must
# still escalate). FAILOPEN-VISIBILITY-W1 made that case LOUD but still exit 0;
# it is now blocking, which is what MKTEMP-PORTABILITY-W1 changed.
#
# Exit 2, not 1, keeps the documented contract honest: 1 == "a test regressed",
# 2 == "the gate itself could not verify". The installed pre-push hook is
# `… || exit 1`, so both block the push identically.
#
# In warn mode it delegates to fail_open() rather than plain `exit 0`, so an
# ungated push lands in the ledger no matter WHICH path let it through — the two
# waves' designs compose here instead of each keeping its own escape hatch.
hard_fail() {
  {
    echo ""
    echo "[test-gate] ================================================================"
    echo "[test-gate] ✗ GATE COULD NOT VERIFY — NO TESTS RAN"
    echo "[test-gate]   $1"
    echo "[test-gate] ================================================================"
  } >&2
  if [ "$MODE" = "warn" ]; then
    fail_open "$1 [hard failure downgraded by ALGOVAULT_TEST_GATE=warn]"
  fi
  echo "[test-gate] push BLOCKED. Fix the toolchain, or override with: ALGOVAULT_TEST_GATE=warn git push" >&2
  verdict INDETERMINATE
}

# ── fail-open preflight: is the toolchain even present? ──
for need in node npx jq; do
  command -v "$need" >/dev/null 2>&1 || fail_open "'$need' not found on PATH — cannot run the suite."
done

# Auto-recovery is on by default; ALGOVAULT_TEST_GATE_AUTOINSTALL=0 disables it,
# and it never runs on CI (CI does its own install) or without a lockfile.
autoinstall_allowed() {
  [ "${ALGOVAULT_TEST_GATE_AUTOINSTALL:-1}" != "0" ] && [ -z "${CI:-}" ] && [ -f package-lock.json ]
}

if [ ! -d node_modules ] || [ ! -x node_modules/.bin/vitest ]; then
  autoinstall_allowed || fail_open "node_modules / vitest missing and auto-recovery is off — run 'npm ci'."
  info "node_modules / vitest missing → recovering with 'npm ci' (once)."
  info "This can take a few minutes; the push is NOT hung."
  npm ci >"$LOGDIR/test-gate-npmci.log" 2>&1 \
    || fail_open "node_modules missing and 'npm ci' recovery FAILED — see $LOGDIR/test-gate-npmci.log. Run 'npm ci' manually."
  [ -x node_modules/.bin/vitest ] \
    || fail_open "'npm ci' completed but node_modules/.bin/vitest is still absent — see $LOGDIR/test-gate-npmci.log."
  info "recovered — dependencies installed."
fi

# ── build artifacts: snapshot-capabilities (--check reads dist/lib/capabilities.js)
#    and the knowledge-flow integration test (reads dist/knowledge/latest.json)
#    both need a fresh build. A failed compile is its own loud signal (it breaks
#    deploy) and is NOT a test regression → fail-open so the gate stays narrowly
#    scoped to test failures and never false-blocks on a build/infra error. ──
#
#    OPS-TEST-GATE-FAILOPEN-VISIBILITY-W1: that fail-open is correct ONLY for a
#    genuine compile error. It was ALSO swallowing "stale node_modules", which is
#    not a code defect at all — so the gate silently skipped every test instead of
#    spending two minutes making itself meaningful again. Classify first, recover
#    the recoverable class, and keep the documented policy for the rest.
run_build() { npm run build >"$LOGDIR/test-gate-build.log" 2>&1; }

if ! run_build; then
  case "$(classify_build_log "$LOGDIR/test-gate-build.log")" in
    RECOVERABLE)
      autoinstall_allowed || fail_open \
        "build failed only on declared-but-uninstalled packages (stale node_modules) and auto-recovery is off — run 'npm ci'."
      info "build failed ONLY on declared-but-uninstalled packages → stale node_modules, not a compile error."
      info "recovering with 'npm ci' (once). This can take a few minutes; the push is NOT hung."
      npm ci >"$LOGDIR/test-gate-npmci.log" 2>&1 \
        || fail_open "stale node_modules and 'npm ci' recovery FAILED — see $LOGDIR/test-gate-npmci.log. node_modules may now be incomplete; run 'npm ci' manually."
      run_build \
        || fail_open "'npm ci' succeeded but the build STILL fails — see $LOGDIR/test-gate-build.log. Treating as a genuine compile error."
      info "recovered — node_modules resynced and the build is clean. Running the suite (the gate is meaningful again)."
      ;;
    *)
      fail_open "npm run build failed with genuine compile error(s) — see $LOGDIR/test-gate-build.log. (Policy unchanged: compile errors surface via build/deploy, not this gate.)"
      ;;
  esac
fi
npm run build:knowledge >"$LOGDIR/test-gate-knowledge.log" 2>&1 \
  || warn "npm run build:knowledge failed — knowledge-flow may not validate (see $LOGDIR/test-gate-knowledge.log)."

# ── run vitest, capture the failing-file set ──
#
# PORTABILITY — the template's `XXXXXX` MUST be the last thing in the name.
# BSD/macOS mktemp does not substitute `XXXXXX` when a suffix follows it, so the
# previous `mktemp "$TMP/test-gate-vitest.XXXXXX.json"` created a file named
# LITERALLY `test-gate-vitest.XXXXXX.json` (GNU mktemp substitutes, so this was
# invisible on ubuntu CI). Once that literal name existed — left by a concurrent
# worktree session, or by an interrupted run — the next mktemp exited 1 with
# EMPTY stdout ("mkstemp failed …: File exists"). With no `set -e` the script
# carried on with an empty path → `npx vitest run --outputFile=` →
# `CACError: option --outputFile <filename/-s> value is missing` → no report →
# the parse check below fired and the gate exited 0 having verified NOTHING
# (observed 2026-07-29, SIGNAL-CLOSEDBAR-SHADOW-W1 CH2).
#
# `mktemp -d` with a TRAILING `XXXXXX` substitutes on both BSD and GNU, and the
# per-run directory keeps a readable `report.json` inside it. The EXIT trap
# removes it even on an interrupted run, so no leftover can poison the next one.
VITEST_DIR="$(mktemp -d "$TMP/test-gate-vitest.XXXXXX" 2>/dev/null)" || VITEST_DIR=""
cleanup_vitest_dir() { [ -n "${VITEST_DIR:-}" ] && rm -rf "$VITEST_DIR"; return 0; }
trap cleanup_vitest_dir EXIT
if [ -z "$VITEST_DIR" ] || [ ! -d "$VITEST_DIR" ]; then
  hard_fail "could not create a temp report dir under $TMP (mktemp -d failed) — vitest was never invoked."
fi
VITEST_JSON="$VITEST_DIR/report.json"
# Cap the fork pool so a gate stops assuming it owns the machine (see CONCURRENCY §1).
# Validate the literal FIRST: `0` yields zero workers and vitest hangs FOREVER with no
# timeout, inside a hook shared by every checkout — a silent machine-wide wedge is a
# far worse failure than refusing to run, so an unusable value is INDETERMINATE.
case "$GATE_MAX_WORKERS" in
  ''|*[!0-9]*|0) hard_fail "ALGOVAULT_GATE_MAX_WORKERS='$GATE_MAX_WORKERS' is not a positive integer — refusing to run (0 would hang vitest forever)." ;;
esac
# VITEST_MIN_FORKS/VITEST_MIN_THREADS are the only inputs that can make min > max, which
# throws RangeError out of tinypool before a single test runs. Neither is set by this
# repo; if the environment carries one, say so rather than dying with a stack trace.
if [ -n "${VITEST_MIN_FORKS:-}${VITEST_MIN_THREADS:-}" ]; then
  warn "VITEST_MIN_FORKS/VITEST_MIN_THREADS set in the environment — they override the gate's cap and can exceed it."
fi
VITEST_MAX_FORKS="$GATE_MAX_WORKERS" \
  npx vitest run --reporter=json --outputFile="$VITEST_JSON" >"$LOGDIR/test-gate-vitest.log" 2>&1 || true
if ! report_usable "$VITEST_JSON"; then
  # Deliberately hard_fail, NOT fail_open: this is the exact branch that let the
  # gate exit 0 having run nothing on 2026-07-29. Cleanup is handled by the trap.
  hard_fail "vitest wrote no parseable report to $VITEST_JSON — see $LOGDIR/test-gate-vitest.log (tail below).
[test-gate]   $(tail -3 "$LOGDIR/test-gate-vitest.log" 2>/dev/null | tr '\n' ' ')"
fi
CURRENT_FAILS="$(jq -r '.testResults[] | select(.status=="failed") | .name' "$VITEST_JSON" \
                 | sed "s#.*/tests/#tests/#" | sort -u)"

# ── R3′: preserve the evidence BEFORE the report dir is cleaned up ─────────────
# Delete on success, preserve on failure. $LOGDIR already survives a non-PASS, but it
# lives under $TMPDIR which the OS reaps; this copy is durable and shared, matching
# algovault-hook-skip.log / algovault-test-gate-failopen.log.
GATE_FAIL_DIR="$(gate_common_dir)/algovault-test-gate-failures"
PRESERVED_REPORT=""
if [ -n "$CURRENT_FAILS" ] && mkdir -p "$GATE_FAIL_DIR" 2>/dev/null; then
  PRESERVED_REPORT="$GATE_FAIL_DIR/$(date -u +%Y%m%dT%H%M%SZ)-$(count_key).json"
  cp "$VITEST_JSON" "$PRESERVED_REPORT" 2>/dev/null \
    && echo "[test-gate] failing report preserved: $PRESERVED_REPORT" >&2 \
    || PRESERVED_REPORT=""
fi

# ── R4: partial-run ratchet — REPORT-ONLY, never changes the verdict ───────────
OBSERVED_TOTAL="$(report_total_tests "$VITEST_JSON")"
COUNT_FILE="$(gate_common_dir)/algovault-test-gate-counts/$(count_key)"
PRIOR_TOTAL=""
[ -f "$COUNT_FILE" ] && PRIOR_TOTAL="$(cat "$COUNT_FILE" 2>/dev/null)"
case "$(ratchet_verdict "$OBSERVED_TOTAL" "$PRIOR_TOTAL" "$RATCHET_DROP_FRACTION")" in
  DROP)
    warn "PARTIAL-RUN RATCHET: this run reported ${OBSERVED_TOTAL} tests; the previous run on this key reported ${PRIOR_TOTAL} (below ${RATCHET_DROP_FRACTION}x). REPORT-ONLY — the verdict is unchanged. A subset invocation and a wave that genuinely deletes tests are indistinguishable from here, so both numbers are stated rather than judged." ;;
  NO_PRIOR)
    info "partial-run ratchet: no prior count for this key — recording ${OBSERVED_TOTAL:-?}." ;;
  *)
    [ -n "$OBSERVED_TOTAL" ] && info "partial-run ratchet: ${OBSERVED_TOTAL} tests (prior ${PRIOR_TOTAL:-none}) — OK." ;;
esac
if [ -n "$OBSERVED_TOTAL" ] && mkdir -p "$(dirname "$COUNT_FILE")" 2>/dev/null; then
  printf '%s\n' "$OBSERVED_TOTAL" > "$COUNT_FILE" 2>/dev/null || true
fi

cleanup_vitest_dir

# ── run the node:test canaries (every tests/**/*.test.mjs that is NOT a vitest
#    file — detected by content so new node:test files are auto-covered) ──
NODE_TEST_FILES=()
while IFS= read -r f; do
  grep -q "from 'vitest'" "$f" 2>/dev/null && continue   # vitest-owned .mjs (e.g. snapshot-capabilities)
  NODE_TEST_FILES+=("$f")
done < <(find tests -name '*.test.mjs' 2>/dev/null | sort)
NODE_FAILS=""
if [ "${#NODE_TEST_FILES[@]}" -gt 0 ]; then
  # SECOND fan-out, same cap. node:test defaults to availableParallelism()-1 (= 11 here)
  # and spawns one PROCESS PER FILE under --test-isolation=process, so these ~23 files
  # are a second 11-wide burst per push. It runs strictly AFTER vitest — sequential, so
  # it never raises the peak — but at N sessions it is N more bursts on the run queue.
  if ! node --test --test-concurrency="$GATE_MAX_WORKERS" "${NODE_TEST_FILES[@]}" >"$LOGDIR/test-gate-nodetest.log" 2>&1; then
    NODE_FAILS="node:test canaries (see $LOGDIR/test-gate-nodetest.log)"
  fi
fi

# ── baseline diff: NEW = current-failing − allow-listed-known-failing ──
BASELINE="$( [ -f "$BASELINE_FILE" ] && grep -vE '^[[:space:]]*#|^[[:space:]]*$' "$BASELINE_FILE" | sort -u || true )"
NEW_FAILS="$(compute_new_fails "$BASELINE" "$CURRENT_FAILS")"
KNOWN_N="$(printf '%s' "$BASELINE" | grep -cE '.' || true)"

# The SAME pure helper the self-test drives, so the shipped decision and the asserted
# decision cannot drift apart.
VERDICT_TOKEN="$(decide_verdict "$NEW_FAILS" "$NODE_FAILS")"

if [ "$VERDICT_TOKEN" = "PASS" ]; then
  # The suite actually ran and is clean → any commits pushed while the gate was
  # failing open are now covered. Surface them once, then clear the ledger.
  report_and_clear_failopen_ledger
  info "GREEN — vitest + node:test pass; no new failures vs baseline (${KNOWN_N} allow-listed)."
  verdict PASS
fi

echo "[test-gate] ✗ NEW test failure(s) vs the committed baseline ($BASELINE_FILE):" >&2
[ -n "$NEW_FAILS" ] && printf '  - %s\n' $NEW_FAILS >&2
[ -n "$NODE_FAILS" ] && echo "  - $NODE_FAILS" >&2
[ "$MODE" = "warn" ] || {
  echo "[test-gate] push BLOCKED. Fix the regression, OR re-run with ALGOVAULT_TEST_GATE=warn to override," >&2
  echo "[test-gate] OR (if genuinely intractable) quarantine it with a ledger row + a line in $BASELINE_FILE." >&2
}
verdict FAIL
