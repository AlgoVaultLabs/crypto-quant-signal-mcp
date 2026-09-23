#!/usr/bin/env bash
# ops/cron/xrepo-ci-conclusion-canary.sh — OPS-MARKETPLACE-CANARY-REPAIR-W1 (2026-08-06)
#
# WHY THIS EXISTS. `algovault-skills`'s Marketplace Health Check — the only automated
# watcher of AlgoVault's public distribution surface — failed FORTY consecutive runs
# (2026-06-27 → 2026-08-05) and alerted nobody. Two independent reasons:
#   1. it asserted a protocol contract the server deliberately abandoned (fixed in CH2), and
#   2. its own alert step resolved both Telegram secrets to empty and `exit 0`'d — dark by
#      construction, because that repo holds no Telegram credentials at all.
# Nothing else was watching, because `ops/monitoring/monitoring-inventory.json` models HOST
# artifacts and a GitHub Actions workflow in a SECOND repo sits outside it entirely.
#
# ARCHITECT RULING: do NOT duplicate bot credentials into a second repo. Watch it from here
# instead, and alert through the existing, proven send_telegram.sh. One mechanism, one place
# credentials live. This also subsumes the separate "cross-repo CI visibility" work.
#
# NO TOKEN, AND NOW NO REST BUDGET EITHER (OPS-XREPO-CI-CANARY-DARK-W1, 2026-08-21).
# ─────────────────────────────────────────────────────────────────────────────────────────────
# The original reader called `api.github.com/repos/.../actions/workflows/<wf>/runs`. That
# endpoint is UNAUTHENTICATED 60/hr PER IP, shared with everything else egressing this box, and
# signal-1's budget is drained. Measured over this canary's whole life: it read a real conclusion
# on TWO days. Its INDETERMINATE streaks ran 3 (08-08), 5 (08-12→14) and 6 (08-15 →), and on
# 2026-08-21 09:41:02Z it correctly paged the operator to say it was dark.
#
# The fix is NOT a credential. The 9th probe — "does the underlying tool ALREADY do this?" —
# found that it does:
#
#     https://github.com/<owner>/<repo>/actions/workflows/<wf>/badge.svg?branch=<branch>
#
# MEASURED 2026-08-21 in one shell ON signal-1: `api.github.com` → HTTP 403 (rate limited) while
# the badge → HTTP 200 carrying the conclusion in its <title>. The two are metered SEPARATELY, so
# the badge is immune to the drain BY CONSTRUCTION rather than by anyone fixing the drain. This is
# the same migration `/opt/mcp-spec-watcher/watch.sh` already made on this host, away from
# api.github.com and onto a CDN-served feed, for this exact reason.
#
# A NARROW TOKEN WAS REJECTED and the reason is worth keeping: this file's own contract said a
# canary that needs a credential is one that dies when the credential expires — which is the class
# of failure it exists to catch. That argument is still correct, and the badge means we never have
# to weigh it. Moving the canary to aoe-1 (which has budget) was also rejected: that budget is a
# stable difference, not a standing guarantee, and it would split one alert path across two hosts.
#
# THE BADGE ANSWERS A DIFFERENT QUESTION THAN REST DID — SO THE BRANCH IS DECLARED, NOT INFERRED.
# ─────────────────────────────────────────────────────────────────────────────────────────────
# REST with `?status=completed&per_page=1` returned the newest completed run on ANY branch. The
# badge returns the latest run on ONE branch. Swapping one for the other silently would be the
# "confident number for the WRONG QUANTITY" defect this repo has now recorded three times, so the
# branch is a REQUIRED 4th field on every watch row and a row missing it REFUSES. The watch list
# is a corpus WE construct, so a malformed row is a config defect, never a fact about the world.
#
# BADGE VOCABULARY — MEASURED, never assumed. Every token below was observed live 2026-08-21:
#   passing     ← latest run conclusion = success
#   failing     ← latest run conclusion = failure  ... AND ALSO = cancelled (measured: the badge
#                 collapses every non-success terminal state into `failing`). Accepted: for a
#                 health canary "the workflow did not succeed" is the operator-actionable fact.
#   no status   ← the workflow has no runs on that branch
#   HTTP 404    ← the workflow file or the repo does not exist
# ANY token outside that set is INDETERMINATE with the raw title logged — never a laundered PASS.
# If GitHub ever changes the badge markup this canary goes DARK and says so, which is the correct
# direction to fail.
#
# NO CACHE-BUSTER, DELIBERATELY. The badge is served `cache-control: max-age=300, private`. The
# CLAUDE.md rule is that a CDN-cached VERIFICATION read is controlled by a cache-buster or a
# pinned SHA — and its corollary is that a fetch cadence far longer than the TTL does not need one
# at all. This cron is DAILY (86400s) against a 300s TTL, so a buster here would be pure churn.
#
# Contract (Claude files/monitoring-runbook.md ## Operator-action-required alert contract):
# ships ONLY the pure alert branch. send_telegram.sh OWNS the severity gate, the 24h-per-
# alert_id cooldown, the recommended-wave resolver and its own fail-open.
#
# FAIL-OPEN, per the ops/cron convention: an infra error logs and exits 0 rather than
# bouncing the cron. The VERDICT TOKEN still tells the truth in that case — INDETERMINATE,
# never a laundered PASS — so a caller reading the token can tell "all watched workflows are
# green" from "I could not find out" (CLAUDE.md verdict-token law).
#
# Suggested crontab (daily, off-:00 per snapshot-sampler discipline): 41 9 * * *
#
# THE CRON SLOT DOES NOT ORDER ITSELF AFTER THE WATCHED JOB, AND IT NEVER COULD.
# ─────────────────────────────────────────────────────────────────────────────────────────────
# This block used to say `marketplace-check.yml runs at 08:00 UTC, so 09:41 leaves it time to
# finish`. That is what the workflow DECLARES; it is not what GitHub DOES. Measured across runs
# #93–#132 (2026-09-22): the job dispatched between 08:36 and 09:13 up to 2026-08-26, and between
# **11:46 and 20:08 UTC** from 2026-08-27 — an 8.4-hour spread, 3–6 h AFTER this canary runs. So
# on 2026-09-22 at 09:41Z the newest completed run was #131 from 15:01Z the previous day, 18h39m
# old, and it was reported as current; #132 passed at 13:19Z on the same SHA, hours later.
#
# GitHub documents this: "The `schedule` event can be delayed during periods of high loads of
# GitHub Actions workflow runs. High load times include the start of every hour… To decrease the
# chance of delay, schedule your workflow to run at a different time of the hour."
# — docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
# (read 2026-09-22). The observed spread is 8.4 h wide, so NO fixed offset survives; moving this
# cron is the lane fix and it is refused. The generator fix is to stop depending on the ordering:
# every conclusion now carries its own RECENCY, measured below.
#
# TWO FRESHNESS LEGS, SPLIT BY BLAST RADIUS (OPS-XREPO-CI-CONCLUSION-FRESHNESS-W1-V2, 2026-09-23).
# ─────────────────────────────────────────────────────────────────────────────────────────────
#   Leg A — schedule expiry.  github.com/<repo>/commits/<branch>.atom
#           A STABLE machine contract: `application/atom+xml; charset=utf-8`. Catches the
#           catastrophic case — a public repo with 60 days of no activity has its scheduled
#           workflows DISABLED by GitHub, after which the badge freezes on its last state and
#           this canary would read `passing` forever with nothing running behind it.
#   Leg B — run recency.      the Actions HTML page (added by CH3)
#           FRAGILE product UI. Catches the nuisance case — a red that is hours stale.
#
# The split is the point: if the HTML page's markup rots, Leg B degrades to UNKNOWN and says so,
# while the silent-forever blind spot stays closed on the atom contract.
#
# REST IS PERMANENTLY OUT, AND THIS IS THE MEASUREMENT THAT CLOSED IT. `api.github.com` is
# 60/hr/IP unauthenticated and signal-1's budget is not merely low — it is re-drained WITHIN 37
# SECONDS of every hourly reset (140 samples across the 2026-09-22 14:45:02Z reset: remaining 0 →
# 1 at +17 s → 0 at +37 s). The canary's own REST-era log agrees: at this exact 09:41 slot,
# 2026-08-07→08-21, it read a conclusion on 2 of 15 runs and got HTTP 403 on the other 13. A leg
# on that budget would be dark on day one. Do not reintroduce one; the self-test refuses it.
#
# ⛔ THE `.atom` TRAP — measured 2026-09-22, and it is silent:
#       github.com/<repo>/actions/workflows/<wf>.atom  -> HTTP 200, content-type: text/html
#       github.com/<repo>/actions.atom                 -> HTTP 406
# There is NO Actions-runs feed. "Simplifying" Leg B to an atom URL returns 200 with a non-empty
# body that parses to nothing. A 200 is not a contract — assert the content type (CH3 does).
#
# On the SECOND row's cadence (OPS-CI-MAIN-WRITER-HARDEN-W1, 2026-08-21): regenerate-landing.yml
# is event-driven (repository_dispatch from algovault-skills), not scheduled, so no clock offset
# can be "after it finishes". That is fine and is worth stating so nobody later tunes the cron
# hoping to fix it: this canary reads the LATEST run, never an in-flight one, so the only thing
# the schedule governs is DETECTION LATENCY — a red regeneration is surfaced within 24h rather
# than at the moment it happens. Given that workflow fired 12 times in the four months to
# 2026-08-21, 24h is far inside the window in which it would otherwise have gone unnoticed
# indefinitely: before this row, nothing watched it at all.
#
# Self-test: `bash ops/cron/xrepo-ci-conclusion-canary.sh --self-test`
set -uo pipefail

SEND="${XREPO_CI_SEND:-/opt/algovault-monitoring/send_telegram.sh}"
LOG="${XREPO_CI_LOG:-/var/log/xrepo-ci-conclusion-canary.log}"
BADGE_HOST="${XREPO_CI_BADGE_HOST:-https://github.com}"
STATE="${XREPO_CI_STATE:-/var/lib/algovault-monitoring/xrepo-ci-indet-streak}"

# Leg A. GitHub disables a public repo's scheduled workflows after 60 days of no repository
# activity; 55 gives five daily runs of warning before that happens.
EXPIRY_WARN_DAYS="${XREPO_CI_EXPIRY_WARN_DAYS:-55}"
EXPIRY_DISABLE_DAYS="${XREPO_CI_EXPIRY_DISABLE_DAYS:-60}"

# The freshness ledger. `/var/lib`, NOT the monitoring dir: an unregistered file beside the
# installed artifacts is exactly what the reconciler's ORPHAN check exists to catch
# (`declaration-sync-heartbeat` precedent). One line per row per run, so a leg that silently
# stopped running is visible in the ledger rather than inferred from silence.
LEDGER="${XREPO_CI_LEDGER:-/var/lib/algovault-monitoring/xrepo-ci-freshness.jsonl}"

# Leg B. A run is STALE past `cadence x STALE_MULTIPLE`, DERIVED from the row's own declared
# cadence and never a literal (the SYNC_LIVENESS rule). 2 is measured, not chosen: the longest
# observed gap between runs of the watched job is 34.1 h (#105->#106) and the oldest the latest
# run has ever been at this cron slot is 24.8 h (2026-08-27), so 48 h leaves 23.2 h of headroom
# while 36 h would leave 1.9 h over the longest real gap.
STALE_MULTIPLE="${XREPO_CI_STALE_MULTIPLE:-2}"

# DECLARED watch list. Adding a workflow is a row here, not a code change.
# Format: <owner/repo>|<workflow-file>|<human label>|<branch>|<cadence-seconds | "event-driven">
# `${VAR-default}` NOT `${VAR:-default}`: an EXPLICITLY EMPTY watch list is a config
# defect and must reach the refusal below, whereas `:-` would silently substitute the
# default and report a confident all-clear over a list someone had just emptied.
# regenerate-landing.yml is the ONE CI writer of this repo's `main` (enumerated 2026-08-21 across
# all 6 workflows; publish-npm.yml's `git push` hit is a comment). It commits regenerated landing
# surfaces AND README.md — the canonical npm-README SoT — and OPS-CI-MAIN-WRITER-HARDEN-W1 gave it
# a bounded rebase-retry so it survives losing the race. What that hardening CANNOT make safe is a
# genuine rebase conflict: it aborts and fails the run, deliberately, because auto-resolving would
# risk authored release copy. This row is what makes that refusal LOUD. Without it the fix would
# fail loudly into an empty room — the same shape as the 40 unnoticed red runs that produced this
# script in the first place, one repo over.
# The 4th field is the BRANCH and it is REQUIRED — see the header on why it may not be inferred.
#
# The 5th field is the watched job's DECLARED CADENCE, and it is an ENUM, not a number: a positive
# integer of seconds, or the literal `event-driven`. Row 2 is `repository_dispatch` and has no
# cadence at all, so a numeric-only field would have broken it on the day it shipped. `event-driven`
# means freshness is `N/A` for that row: it can never fire `xrepo_ci_stale`, and that exemption is
# DECLARED rather than emergent — the same reasoning as `reconcile_exempt_reason` on the hostless
# `docs-samples-live-canary` row and `sync_exempt_reason` on the registry row, both of which record
# the same lesson: unmarked, it would read as coverage and deliver none.
#
# A row missing the field, or carrying anything else, REFUSES — this list is a corpus WE construct,
# so a malformed row is a config defect, never a fact about the world.
WATCHED="${XREPO_CI_WATCHED-AlgoVaultLabs/algovault-skills|marketplace-check.yml|Marketplace Health Check|main|86400
AlgoVaultLabs/crypto-quant-signal-mcp|regenerate-landing.yml|Landing Regeneration|main|event-driven}"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG" >/dev/null 2>&1 || true; }
verdict() { echo "XREPO_CI_VERDICT=$1"; }

# A SECOND token line, never folded into the first. Three consumers already read
# `XREPO_CI_VERDICT=` and its vocabulary is a contract; freshness is a different question with a
# different vocabulary, so a caller gates on whichever one it actually cares about.
freshness() { echo "XREPO_CI_FRESHNESS=$1"; }

# ── PURE FUNCTIONS ───────────────────────────────────────────────────────────────────────────
# These are the pieces the self-test's fetch seam BYPASSES, so they are extracted and asserted
# directly. A hermetic self-test is structurally blind to exactly what its own seam replaces —
# that is a paid-for law in this repo, not a style preference.

badge_url() { printf '%s/%s/actions/workflows/%s/badge.svg?branch=%s' "$BADGE_HOST" "$1" "$2" "$3"; }

# The human-facing page for a RED alert. Deterministic, needs no API call — which is the whole
# point: the alert stays actionable even though we no longer hold a run id or a run URL.
actions_url() { printf '%s/%s/actions/workflows/%s?query=branch%%3A%s' "$BADGE_HOST" "$1" "$2" "$3"; }

# Leg A's transport. Same host as the badge, so it inherits the badge's metering rather than the
# REST budget — that is the whole reason this leg exists on this URL.
atom_url() { printf '%s/%s/commits/%s.atom' "$BADGE_HOST" "$1" "$2"; }

# The clock, as ONE seam. A canary that cannot be replayed at a chosen instant cannot have its
# incident re-run from fixtures, and this one now has to be (the 2026-09-22 18h39m replay). It can
# only move time, never a verdict: every threshold below is still evaluated normally against it.
now_epoch() {
  local n="${XREPO_CI_NOW:-}"
  if [ -z "$n" ]; then date -u +%s; return 0; fi
  case "$n" in
    ''|*[!0-9]*) iso_epoch "$n" ;;
    *) printf '%s' "$n" ;;
  esac
}

# ISO-8601 Zulu -> epoch seconds, on BOTH date(1) dialects: GNU on the hosts, BSD on the operator's
# Mac where the self-test runs. Prints nothing and returns 1 on an unparseable stamp, so a caller
# can tell "could not read the time" from "the time is old" — they are different verdicts.
iso_epoch() {
  local s="$1" e=""
  e=$(date -u -d "$s" +%s 2>/dev/null) || e=""
  if [ -z "$e" ]; then e=$(date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$s" +%s 2>/dev/null) || e=""; fi
  [ -n "$e" ] || return 1
  printf '%s' "$e"
}

# Seconds -> `18h39m`, the form an operator reads in a page body. Days for anything past 48 h.
human_age() {
  local s="$1"
  [ "$s" -ge 0 ] 2>/dev/null || { printf 'unknown'; return 0; }
  if [ "$s" -ge 172800 ]; then printf '%dd%dh' $(( s / 86400 )) $(( s % 86400 / 3600 ))
  else printf '%dh%02dm' $(( s / 3600 )) $(( s % 3600 / 60 )); fi
}

# The 5th watch-row field. A positive integer of seconds, or the literal `event-driven`. Anything
# else — including an empty field, a zero, or a negative — is a config defect.
valid_cadence() {
  case "${1:-}" in
    event-driven) return 0 ;;
    ''|*[!0-9]*)  return 1 ;;
    *) [ "$1" -gt 0 ] 2>/dev/null && return 0 || return 1 ;;
  esac
}

# Aggregate per-row freshness into the one terminal token. `N/A` rows are DROPPED rather than
# treated as a value: row 2 is permanently `N/A` by declaration, so counting it would make MIXED
# the steady state and the token would carry no information. Nothing left after the drop is itself
# `N/A` — there was nothing to be fresh about.
aggregate_freshness() {
  local v first="" mixed=0 seen=0
  for v in "$@"; do
    [ -n "$v" ] || continue
    [ "$v" = "N/A" ] && continue
    seen=$((seen + 1))
    if [ -z "$first" ]; then first="$v"; elif [ "$v" != "$first" ]; then mixed=1; fi
  done
  if [ "$seen" -eq 0 ]; then printf 'N/A'
  elif [ "$mixed" -eq 1 ]; then printf 'MIXED'
  else printf '%s' "$first"; fi
}

# One ledger line per row per run. A leg that stops running leaves a gap here rather than silence,
# which is the difference between "measured healthy" and "not measured at all".
ledger_append() { # <repo> <wf> <branch> <leg> <transport> <state> <age_s> <verdict> [run_id]
  local dir extra=""; dir=$(dirname "$LEDGER")
  [ -d "$dir" ] || mkdir -p "$dir" 2>/dev/null || return 0
  # Leg B records the run id it parsed, because that is what the monotonic guard reads back on the
  # next run. A guard whose memory lives only in RAM cannot catch a latch that persists.
  [ -n "${9:-}" ] && extra=",\"run_id\":\"$9\""
  printf '{"ts":"%s","repo":"%s","wf":"%s","branch":"%s","leg":"%s","transport":"%s","state":"%s","age_s":%s,"verdict":"%s"%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$3" "$4" "$5" "$6" "${7:-null}" "$8" "$extra" >> "$LEDGER" 2>/dev/null || true
}

# ── LEG B'S PARSER — STRUCTURED FIELDS ONLY, NEVER THE PROSE ─────────────────────────────────
# Measured on the live page 2026-09-22, one run row carries:
#   href="/<repo>/actions/runs/35732680339"                     <- structured (the run id)
#   aria-label="completed successfully:  Run 132 of <name>."    <- the NUMBER is structured;
#                                                                  the CONCLUSION is PROSE
#   <relative-time datetime="2026-09-22T13:19:07Z">             <- structured (run START)
#
# CLAUDE.md: "MATCH ON THE STRUCTURED FIELD, NOT THE PROSE." `completed successfully` / `failed`
# is human-facing copy on a product UI, so it may NEVER become a verdict here — the conclusion
# stays badge-only. Consequences, all of them good: a GitHub markup change can degrade freshness
# to UNKNOWN but can never flip a verdict, and the `api.github.com`-free guard keeps its intent
# rather than only its letter.
#
# Fields are read PER ROW, keyed off the run anchor. A global "first datetime on the page" would
# read a neighbouring row's value the moment GitHub reorders anything — the latch the monotonic
# guard exists to catch, arriving silently.
parse_runs_page() { # <html> -> "<run_number>|<run_id>|<iso-start>" for the NEWEST row, else 1
  local flat row id num iso
  flat=$(printf '%s' "$1" | tr '\n' ' ')
  row=$(printf '%s' "$flat" | sed 's/id="check_suite_/\
@@ROW@@/g' | grep '^@@ROW@@' | head -1)
  [ -n "$row" ] || return 1
  id=$(printf '%s' "$row" | grep -oE '/actions/runs/[0-9]+' | head -1 | sed 's|.*/||')
  num=$(printf '%s' "$row" | grep -oE 'Run[[:space:]]+[0-9]+[[:space:]]+of' | head -1 | grep -oE '[0-9]+')
  iso=$(printf '%s' "$row" | grep -oE '<relative-time[^>]*datetime="[^"]+"' | head -1 | sed -e 's/.*datetime="//' -e 's/"$//')
  [ -n "$id" ] && [ -n "$num" ] && [ -n "$iso" ] || return 1
  printf '%s|%s|%s' "$num" "$id" "$iso"
}

# The monotonic guard's memory. Run numbers only ever increase for a workflow, so a parse that
# hands back an OLDER run than the one already recorded has latched onto the wrong element — a
# failure mode that otherwise looks exactly like a legitimately quiet workflow.
ledger_last_run_id() { # <repo> <wf> <branch> -> last recorded run id, or empty
  [ -r "$LEDGER" ] || return 0
  grep -F "\"repo\":\"$1\",\"wf\":\"$2\",\"branch\":\"$3\",\"leg\":\"B\"" "$LEDGER" 2>/dev/null \
    | grep -oE '"run_id":"[0-9]+"' | tail -1 | grep -oE '[0-9]+' || true
}

# The feed-level <updated> is the FIRST one in the document; every later occurrence belongs to an
# entry. Refuses rather than guessing when the feed carries none.
parse_atom_updated() {
  local t
  # `grep -o | head -1`, never a greedy `sed` capture: `.*<updated>` would match up to the LAST
  # occurrence and hand back an entry's timestamp under the feed's name.
  t=$(printf '%s' "$1" | tr '\n' ' ' | grep -oE '<updated>[^<]+</updated>' | head -1 | sed -e 's/<updated>//' -e 's/<\/updated>//')
  [ -n "$t" ] || return 1
  printf '%s' "$t"
}

# Extract the status token from the badge SVG's <title>. GitHub renders it as
# "<workflow name> - <status>", and a workflow NAME may itself contain " - ", so take the LAST
# segment, never the second one.
parse_badge_status() {
  local svg t
  svg=$(printf '%s' "$1" | tr '\n' ' ')
  t=$(printf '%s' "$svg" | sed -n 's/.*<title>\([^<]*\)<\/title>.*/\1/p' | head -1)
  [ -n "$t" ] || return 1
  case "$t" in
    *" - "*) printf '%s' "${t##* - }" ;;
    *) return 1 ;;
  esac
}

# MEASURED vocabulary only. Anything else is INDETERMINATE — the fail-safe direction.
classify_status() {
  case "$1" in
    passing)     echo PASS ;;
    failing)     echo FAIL ;;
    "no status") echo INDETERMINATE ;;
    *)           echo INDETERMINATE ;;
  esac
}

# ── THE ONE NETWORK SEAM ─────────────────────────────────────────────────────────────────────
# Writes the body to $2 and echoes the HTTP status. XREPO_CI_FIXTURE_DIR replaces the fetch for
# the self-test ONLY; it can never manufacture a PASS, because the verdict still comes from
# parse_badge_status + classify_status running on the bytes it returns.
#
# One seam for THREE transports (badge SVG, Leg A atom, Leg B HTML), because a second fetcher is a
# second place a fixture can diverge from the live path. `$4` is the fixture extension only — the
# live branch is identical for all three, and the CONTENT TYPE is captured for every one of them
# so a caller can refuse a body whose type is not what the URL promised (the `.atom` trap).
fetch_doc() { # <url> <body_out> <hdr_out> <fixture-ext>  -> echoes the HTTP code
  local url="$1" out="$2" hdr="$3" ext="$4" fx
  : > "$hdr" 2>/dev/null || true
  if [ -n "${XREPO_CI_FIXTURE_DIR:-}" ]; then
    fx="$XREPO_CI_FIXTURE_DIR/$(printf '%s' "$url" | tr -c 'A-Za-z0-9' '_')"
    if [ -f "$fx.$ext" ]; then
      cat "$fx.$ext" > "$out"
      # A fixture may declare its own content-type; absent one, the transport's real default.
      if [ -f "$fx.ct" ]; then printf 'content-type: %s\n' "$(cat "$fx.ct")" > "$hdr"
      else printf 'content-type: %s\n' "$(default_ct "$ext")" > "$hdr"; fi
      cat "$fx.code" 2>/dev/null || echo 200
    else : > "$out"; echo 404; fi
    return 0
  fi
  curl -sS --max-time 25 -D "$hdr" -o "$out" -w '%{http_code}' "$url" 2>/dev/null || echo 000
}

default_ct() {
  case "$1" in
    svg)  printf 'image/svg+xml' ;;
    atom) printf 'application/atom+xml; charset=utf-8' ;;
    *)    printf 'text/html; charset=utf-8' ;;
  esac
}

# Kept as its own name because the badge is the CONCLUSION source and nothing else may become one.
fetch_badge() {
  local url="$1" out="$2" hdr rc
  hdr=$(mktemp "${TMPDIR:-/tmp}/xrepohdr.XXXXXX") || { echo 000; return 0; }
  rc=$(fetch_doc "$url" "$out" "$hdr" svg)
  rm -f "$hdr" 2>/dev/null || true
  printf '%s\n' "$rc"
}

# ── LEG A — SCHEDULE EXPIRY, ON A STABLE MACHINE CONTRACT ────────────────────────────────────
# GitHub, verbatim (docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-
# workflows, read 2026-09-22): "In a public repository, scheduled workflows are automatically
# disabled when no repository activity has occurred in 60 days."
#
# When that happens the badge does not go red or blank — it FREEZES on its last rendered state.
# A conclusion-reader with no recency bound then reports `passing` every day, forever, with
# nothing running behind it. That is the silent half of this canary's own bug class, and it is
# why this leg rides `application/atom+xml` rather than the product-UI HTML that Leg B must use.
#
# Only a repo carrying at least one SCHEDULED watch row can expire this way, so the population is
# derived from the 5th field and never hardcoded: a repo whose every row is `event-driven` is
# unaffected by the 60-day rule and must not warn.
#
# FAIL-SOFT: a non-200, an unparseable feed or an unreadable timestamp makes that repo UNKNOWN.
# It never fires, never suppresses a conclusion, and never feeds the dark streak — the worst case
# is exactly today's behaviour.
# ── LEG B — RUN RECENCY, ON A FRAGILE SURFACE, BEHIND THREE GUARDS ───────────────────────────
# The badge says WHAT the latest run concluded and cannot say WHEN. Only the Actions HTML page
# carries that timestamp — 425 KB of product UI, with no machine contract of any kind. So this leg
# is deliberately NOT load-bearing: the catastrophic case (a disabled schedule) is Leg A's on the
# atom contract, and everything here only buys the nuisance fix, a red that is hours stale.
#
# Three guards, each a named law, and every one of them degrades to UNKNOWN rather than to a value:
#   vacuity       a 200 with bytes that yields ZERO rows is a PARSER failure, never "no runs"
#   monotonic     a run id older than the one we last recorded means the parser latched wrong
#   content-type  a 200 is not a contract — `<wf>.atom` answers 200 with text/html
#
# UNKNOWN feeds the existing 3-run `xrepo_ci_dark` streak, so a rotted parser announces itself
# within three days instead of going quiet. Sets: LEGB_STATE, LEGB_REASON, LEGB_NUM, LEGB_ID,
# LEGB_ISO, LEGB_AGE.
leg_b_check() { # <repo> <wf> <branch> <cadence>
  LEGB_STATE=""; LEGB_REASON=""; LEGB_NUM=""; LEGB_ID=""; LEGB_ISO=""; LEGB_AGE=""
  local repo="$1" wf="$2" branch="$3" cadence="$4"
  local body hdr url http ct parsed last now bound
  url=$(actions_url "$repo" "$wf" "$branch")
  # Guard 3a — the URL itself. The page is only ever fetched through actions_url(); an `.atom`
  # suffix on a workflow returns 200 text/html and parses to nothing, so the form is asserted
  # rather than assumed by whoever edits this next.
  case "$url" in
    *.atom)
      LEGB_STATE=UNKNOWN; LEGB_REASON="refusing a .atom URL — there is no Actions runs feed, and that URL answers 200 with text/html"
      return 0 ;;
    *"/actions/workflows/$wf?query=branch%3A$branch") ;;
    *)
      LEGB_STATE=UNKNOWN; LEGB_REASON="URL is not the actions_url() form: $url"
      return 0 ;;
  esac
  body=$(mktemp "${TMPDIR:-/tmp}/xrepopage.XXXXXX") || { LEGB_STATE=UNKNOWN; LEGB_REASON="no temp file"; return 0; }
  hdr=$(mktemp "${TMPDIR:-/tmp}/xrepopageh.XXXXXX") || { rm -f "$body"; LEGB_STATE=UNKNOWN; LEGB_REASON="no temp file"; return 0; }
  http=$(fetch_doc "$url" "$body" "$hdr" html)
  ct=$(grep -i '^content-type:' "$hdr" 2>/dev/null | head -1 | tr -d '\r' | sed 's/^[Cc]ontent-[Tt]ype:[[:space:]]*//')
  if [ "$http" != "200" ]; then
    LEGB_STATE=UNKNOWN; LEGB_REASON="HTTP $http"
  else
    case "$ct" in
      *html*) # Guard 3b — the content type must be what the URL promised.
        parsed=$(parse_runs_page "$(cat "$body" 2>/dev/null || true)") || parsed=""
        if [ -z "$parsed" ]; then
          # Guard 1 — vacuity. WE pointed the parser at this page, so "nothing parsed" is a defect
          # in the parser or in the markup, never a fact about how many runs exist.
          LEGB_STATE=UNKNOWN; LEGB_REASON="200 with $(wc -c < "$body" | tr -d ' ') bytes parsed ZERO run rows"
        else
          LEGB_NUM=${parsed%%|*}; LEGB_ID=$(printf '%s' "$parsed" | cut -d'|' -f2); LEGB_ISO=${parsed##*|}
          last=$(ledger_last_run_id "$repo" "$wf" "$branch")
          if [ -n "$last" ] && [ "$LEGB_ID" -lt "$last" ] 2>/dev/null; then
            # Guard 2 — monotonic. Run ids only grow; a smaller one is a latch, not a quiet job.
            LEGB_STATE=UNKNOWN; LEGB_REASON="parsed run id $LEGB_ID is older than the recorded $last — the parser latched onto the wrong element"
            LEGB_NUM=""; LEGB_ID=""; LEGB_ISO=""
          elif ! now=$(iso_epoch "$LEGB_ISO"); then
            LEGB_STATE=UNKNOWN; LEGB_REASON="run timestamp '$LEGB_ISO' did not parse"
          else
            LEGB_AGE=$(( $(now_epoch) - now ))
            if [ "$cadence" = "event-driven" ]; then
              LEGB_STATE="N/A"
            else
              bound=$(( cadence * STALE_MULTIPLE ))
              if [ "$LEGB_AGE" -gt "$bound" ]; then LEGB_STATE=STALE; else LEGB_STATE=FRESH; fi
            fi
          fi
        fi ;;
      *) LEGB_STATE=UNKNOWN; LEGB_REASON="served '$ct', not HTML — a 200 is not a contract" ;;
    esac
  fi
  [ -n "$LEGB_STATE" ] || LEGB_STATE=UNKNOWN
  # THE DECLARED EXEMPTION OUTRANKS THE TRANSPORT. An `event-driven` row has no cadence, so there
  # is no bound to evaluate and no such thing as a stale run for it — that is true whether the page
  # parsed or not. Its metadata is a bonus for the RED body; its freshness is `N/A` either way, and
  # a failed fetch on it must never feed the dark streak for a measurement nobody asked for.
  [ "$cadence" = "event-driven" ] && LEGB_STATE="N/A"
  ledger_append "$repo" "$wf" "$branch" B html "${LEGB_REASON:-OK}" "${LEGB_AGE:-null}" "$LEGB_STATE" "$LEGB_ID"
  rm -f "$body" "$hdr" 2>/dev/null || true
}

leg_a_checks() { # reads SCHED_REPOS (one `repo|branch|wf` per line, deduped by repo)
  LEGA_CHECKED=0; LEGA_UNKNOWN=0; LEGA_EXPIRING=0; LEGA_DETAIL=""
  local body hdr REPO BRANCH WF URL HTTP CT FEED UPD UPD_EPOCH NOW AGE AGE_D DISABLE_ON
  [ -n "${SCHED_REPOS:-}" ] || { echo "  · Leg A (schedule expiry): no scheduled watch row — not applicable"; return 0; }
  body=$(mktemp "${TMPDIR:-/tmp}/xrepoatom.XXXXXX") || return 0
  hdr=$(mktemp "${TMPDIR:-/tmp}/xrepoatomh.XXXXXX") || { rm -f "$body"; return 0; }
  NOW=$(now_epoch)
  while IFS='|' read -r REPO BRANCH WF; do
    [ -n "${REPO:-}" ] || continue
    LEGA_CHECKED=$((LEGA_CHECKED + 1))
    URL=$(atom_url "$REPO" "$BRANCH")
    HTTP=$(fetch_doc "$URL" "$body" "$hdr" atom)
    CT=$(grep -i '^content-type:' "$hdr" 2>/dev/null | head -1 | tr -d '\r' | sed 's/^[Cc]ontent-[Tt]ype:[[:space:]]*//')
    if [ "$HTTP" != "200" ]; then
      echo "  ? Leg A ($REPO@$BRANCH): commits feed HTTP $HTTP — repo activity UNKNOWN"
      log "LEGA_UNKNOWN $REPO@$BRANCH — atom HTTP $HTTP"
      ledger_append "$REPO" "$WF" "$BRANCH" A atom "HTTP_$HTTP" null UNKNOWN
      LEGA_UNKNOWN=$((LEGA_UNKNOWN + 1)); continue
    fi
    # A 200 is not a contract. `…/<workflow>.atom` answers 200 with text/html, so a feed reader
    # that trusts the status code parses a web page and finds nothing.
    case "$CT" in
      *atom*|*xml*) ;;
      *)
        echo "  ? Leg A ($REPO@$BRANCH): commits feed served '$CT', not atom — repo activity UNKNOWN"
        log "LEGA_UNKNOWN $REPO@$BRANCH — content-type '$CT'"
        ledger_append "$REPO" "$WF" "$BRANCH" A atom "BAD_CONTENT_TYPE" null UNKNOWN
        LEGA_UNKNOWN=$((LEGA_UNKNOWN + 1)); continue ;;
    esac
    FEED=$(cat "$body" 2>/dev/null || true)
    if ! UPD=$(parse_atom_updated "$FEED") || ! UPD_EPOCH=$(iso_epoch "$UPD"); then
      echo "  ? Leg A ($REPO@$BRANCH): commits feed carried no readable <updated> — repo activity UNKNOWN"
      log "LEGA_UNKNOWN $REPO@$BRANCH — feed had no parseable <updated>"
      ledger_append "$REPO" "$WF" "$BRANCH" A atom "UNPARSEABLE" null UNKNOWN
      LEGA_UNKNOWN=$((LEGA_UNKNOWN + 1)); continue
    fi
    AGE=$((NOW - UPD_EPOCH)); AGE_D=$((AGE / 86400))
    DISABLE_ON=$(date -u -d "@$((UPD_EPOCH + EXPIRY_DISABLE_DAYS * 86400))" +%Y-%m-%d 2>/dev/null \
      || date -u -r "$((UPD_EPOCH + EXPIRY_DISABLE_DAYS * 86400))" +%Y-%m-%d 2>/dev/null || echo unknown)
    if [ "$AGE_D" -gt "$EXPIRY_WARN_DAYS" ]; then
      echo "  x Leg A ($REPO@$BRANCH): last repo activity $UPD — ${AGE_D}d ago, scheduled workflows disable on $DISABLE_ON"
      log "LEGA_EXPIRING $REPO@$BRANCH age=${AGE_D}d disable_on=$DISABLE_ON"
      ledger_append "$REPO" "$WF" "$BRANCH" A atom OK "$AGE" EXPIRING
      LEGA_EXPIRING=$((LEGA_EXPIRING + 1))
      # REMEDIATION WITHOUT AN INVOCATION, DELIBERATELY. This canary's own gate greps the WHOLE
      # file — comments and strings included — for any repo-mutating command, and that gate is the
      # control that proves Q3=A ("detect and alert, never mutate", no keepalive). A copy-pasteable
      # CLI line here would trip it, so the body names the UI path an operator can follow from a
      # phone and the CLI form lives in the runbook. The gate stays strict; the operator still
      # knows exactly what to do.
      LEGA_DETAIL="$LEGA_DETAIL
- $REPO (branch $BRANCH): last activity $UPD — ${AGE_D}d ago
  GitHub disables this repo's scheduled workflows on $DISABLE_ON (${EXPIRY_DISABLE_DAYS}d of inactivity).
  After that the badge FREEZES on its last state and this canary would read it as current.
  Fix: land any commit in $REPO, or re-enable it at
  GitHub -> $REPO -> Actions -> $WF -> \"Enable workflow\".
  CLI form: Claude files/monitoring-runbook.md, Cross-repo CI conclusion canary."
    else
      echo "  + Leg A ($REPO@$BRANCH): last repo activity $UPD — ${AGE_D}d ago, disable date $DISABLE_ON"
      log "LEGA_OK $REPO@$BRANCH age=${AGE_D}d"
      ledger_append "$REPO" "$WF" "$BRANCH" A atom OK "$AGE" FRESH
    fi
  done <<EOF
$(printf '%s\n' "$SCHED_REPOS")
EOF
  rm -f "$body" "$hdr" 2>/dev/null || true
}

run_checks() {
  CHECKED=0; RED=0; INDET=0; RED_DETAIL=""
  SCHED_REPOS=""; ROW_FRESHNESS=""; LEGB_UNKNOWN=0; STALE_ROWS=0; STALE_DETAIL=""
  local body; body=$(mktemp "${TMPDIR:-/tmp}/xrepo.XXXXXX")
  local REPO WF LABEL BRANCH CADENCE URL HTTP SVG STATUS CLASS ROW_META
  while IFS='|' read -r REPO WF LABEL BRANCH CADENCE; do
    [ -n "${REPO:-}" ] || continue
    CHECKED=$((CHECKED + 1))
    # A row we authored ourselves that is missing its branch is a CONFIG defect, and the corpus
    # is one we construct — so refuse rather than infer a default branch and report on a quantity
    # nobody declared.
    if [ -z "${BRANCH:-}" ]; then
      echo "  x ${LABEL:-$WF} ($REPO): watch row has NO BRANCH field — config defect, refusing"
      log "INDETERMINATE $REPO/$WF — watch row missing required branch field"
      INDET=$((INDET + 1)); continue
    fi
    # Same reasoning, one field along: the cadence is what every freshness bound is DERIVED from,
    # so inferring it would mean bounding a run's age against a number nobody declared.
    if ! valid_cadence "${CADENCE:-}"; then
      echo "  x ${LABEL:-$WF} ($REPO@$BRANCH): watch row has NO CADENCE field (got '${CADENCE:-}') — config defect, refusing"
      log "INDETERMINATE $REPO/$WF@$BRANCH — watch row cadence field invalid: '${CADENCE:-}'"
      INDET=$((INDET + 1)); continue
    fi
    # Leg A's population, derived from the declaration rather than hardcoded. One probe per repo:
    # the 60-day rule is a property of the REPO, not of each workflow in it.
    if [ "$CADENCE" != "event-driven" ]; then
      case "
$SCHED_REPOS" in
        *"
$REPO|"*) ;;
        *) SCHED_REPOS="$SCHED_REPOS
$REPO|$BRANCH|$WF" ;;
      esac
    fi
    # Per-row freshness, measured by Leg B. `event-driven` is N/A BY DECLARATION: it has no
    # cadence, so no bound exists and inventing one would page on a job behaving exactly as
    # designed. It still gets its run metadata, which is what a RED body needs.
    leg_b_check "$REPO" "$WF" "$BRANCH" "$CADENCE"
    ROW_FRESHNESS="$ROW_FRESHNESS $LEGB_STATE"
    ROW_META=""
    if [ -n "$LEGB_ID" ]; then
      ROW_META="
  run #$LEGB_NUM ($LEGB_ID) started $LEGB_ISO — $(human_age "$LEGB_AGE") ago
  $BADGE_HOST/$REPO/actions/runs/$LEGB_ID"
    else
      # The line is NEVER omitted. An operator must not have to re-derive the age of the thing he
      # is being paged about, and "no line" reads as "nobody thought about it".
      ROW_META="
  freshness unavailable (${LEGB_REASON:-unknown})"
    fi
    case "$LEGB_STATE" in
      UNKNOWN) LEGB_UNKNOWN=$((LEGB_UNKNOWN + 1)); echo "  ? $LABEL ($REPO@$BRANCH): run recency UNKNOWN — ${LEGB_REASON:-unknown}" ;;
      STALE)   echo "  x $LABEL ($REPO@$BRANCH): newest run #$LEGB_NUM started $LEGB_ISO — $(human_age "$LEGB_AGE") ago, over the ${STALE_MULTIPLE}x${CADENCE}s bound" ;;
      "N/A")   # no `;;&` — this file's self-test runs on bash 3.2, where that is a syntax error
               if [ -n "$LEGB_ID" ]; then
                 echo "  · $LABEL ($REPO@$BRANCH): event-driven, freshness N/A — newest run #$LEGB_NUM started $LEGB_ISO"
               else
                 echo "  · $LABEL ($REPO@$BRANCH): event-driven, freshness N/A — run metadata unavailable (${LEGB_REASON:-unknown})"
               fi ;;
      *)       echo "  + $LABEL ($REPO@$BRANCH): newest run #$LEGB_NUM started $LEGB_ISO — $(human_age "$LEGB_AGE") ago, within the ${STALE_MULTIPLE}x${CADENCE}s bound" ;;
    esac
    URL=$(badge_url "$REPO" "$WF" "$BRANCH")
    HTTP=$(fetch_badge "$URL" "$body")
    if [ "$HTTP" != "200" ]; then
      log "INDETERMINATE $REPO/$WF@$BRANCH — badge HTTP $HTTP"
      echo "  ? $LABEL ($REPO@$BRANCH): badge HTTP $HTTP — cannot verify"
      INDET=$((INDET + 1)); continue
    fi
    SVG=$(cat "$body" 2>/dev/null || true)
    if ! STATUS=$(parse_badge_status "$SVG"); then
      log "INDETERMINATE $REPO/$WF@$BRANCH — badge markup did not parse"
      echo "  ? $LABEL ($REPO@$BRANCH): badge markup did not parse — cannot verify"
      INDET=$((INDET + 1)); continue
    fi
    CLASS=$(classify_status "$STATUS")
    case "$CLASS" in
      PASS)
        echo "  + $LABEL ($REPO@$BRANCH): latest run = $STATUS"
        log "OK $REPO/$WF@$BRANCH $STATUS"
        # Green AND stale is the case nothing could see before: the badge is reporting a run old
        # enough that the schedule behind it may have stopped. A DISTINCT alert id, because the
        # wrapper cools down per id and riding `xrepo_ci_dark` would let one suppress the other.
        if [ "$LEGB_STATE" = "STALE" ]; then
          STALE_ROWS=$((STALE_ROWS + 1))
          STALE_DETAIL="$STALE_DETAIL
- $REPO/$WF (branch $BRANCH): badge says $STATUS, but its newest run is $(human_age "$LEGB_AGE") old
  run #$LEGB_NUM ($LEGB_ID) started $LEGB_ISO — the declared cadence is ${CADENCE}s
  $BADGE_HOST/$REPO/actions/runs/$LEGB_ID
  $(actions_url "$REPO" "$WF" "$BRANCH")"
        fi ;;
      FAIL)
        echo "  x $LABEL ($REPO@$BRANCH): latest run = $STATUS"
        log "RED $REPO/$WF@$BRANCH $STATUS"
        RED=$((RED + 1))
        RED_DETAIL="$RED_DETAIL
- $REPO/$WF (branch $BRANCH): $STATUS$ROW_META
  $(actions_url "$REPO" "$WF" "$BRANCH")" ;;
      *)
        echo "  ? $LABEL ($REPO@$BRANCH): badge says '$STATUS' — not a conclusion, cannot verify"
        log "INDETERMINATE $REPO/$WF@$BRANCH status='$STATUS'"
        INDET=$((INDET + 1)) ;;
    esac
  done <<EOF
$(printf '%s\n' "$WATCHED")
EOF
  rm -f "$body" 2>/dev/null || true
}

# ── ALERT BODIES ─────────────────────────────────────────────────────────────────────────────
# REAL newlines, never `%0A` (OPS-XREPO-CI-CANARY-DARK-W1). send_telegram.sh does its own
# `--data-urlencode "text=${BODY}"`, so a body carrying `%0A` is DOUBLE-encoded and Telegram
# prints the escape literally. Measured on the delivered body 2026-08-21:
#   09:41:02Z [xrepo_ci_dark] FIRED: HTTP 200 body=🟡 AlgoVault Alert%0A%0Across-repo CI canary…
# This was the ONLY host caller still using `%0A`; the other ~30 all pipe real newlines. Only a
# REAL delivery could expose it — the fire-path proof stops at SUPPRESSED_TEST_CONTEXT, before
# rendering — which is why the self-test now asserts the rendered BODY and not just the verdict.
red_body() {
  local n="$1" detail="$2" noun="workflows are"
  [ "$n" -eq 1 ] && noun="workflow is"
  printf '%s\n\n%s cross-repo CI %s RED%s\n\nAction: dispatch OPS-XREPO-CI-RED-W{NEXT}\nSource: ops/cron/xrepo-ci-conclusion-canary.sh' \
    "🟡 AlgoVault Alert" "$n" "$noun" "$detail"
}

dark_body() {
  # $2 names WHICH reader went dark. It defaults to the badge wording this alert has always
  # carried, so the pre-existing assertions read the same body they always did — but a Leg B
  # parser rot must never page with a sentence about the badge's <title>, which is the class of
  # false diagnosis that costs the next operator an hour.
  local cause="${2:-badge}" detail
  case "$cause" in
    legb) detail="The conclusion reader (the badge) is fine; the RUN RECENCY leg is not. That leg
parses the Actions HTML page, which is product UI with no machine contract, so
GitHub changing its markup degrades it to UNKNOWN by design. Check the page shape
against parse_runs_page(), or accept the loss of recency until it is re-fitted —
Leg A (commits/<branch>.atom) still covers the schedule-expiry case meanwhile." ;;
    *)    detail="It is dark, not green — no workflow conclusion has been read.
The reader is the GitHub Actions badge endpoint, which is NOT metered by the
REST API budget, so a rate limit is no longer a plausible cause: check
that github.com is reachable from this host and that the badge markup still
carries its <title>." ;;
  esac
  printf '%s\n\n%s\n' "🟡 AlgoVault Alert" \
"cross-repo CI canary has been UNABLE TO VERIFY for $1 consecutive runs.
$detail

Action: dispatch OPS-XREPO-CI-CANARY-DARK-W{NEXT}
Source: ops/cron/xrepo-ci-conclusion-canary.sh"
}

# Green badge + stale run. The one case nothing in the estate could see before this wave.
stale_body() {
  local n="$1" detail="$2" noun="workflows are"
  [ "$n" -eq 1 ] && noun="workflow is"
  printf '%s\n\n%s watched %s GREEN ON A STALE RUN%s\n\n%s\n\nAction: dispatch OPS-XREPO-CI-STALE-W{NEXT}\nSource: ops/cron/xrepo-ci-conclusion-canary.sh' \
    "🟡 AlgoVault Alert" "$n" "$noun" "$detail" \
"A badge reports the LAST run, with no date attached. Past twice its declared cadence
that is no longer evidence the job is still running — a disabled schedule, a deleted
cron or a silently unregistered workflow all render as a green badge forever."
}

# Leg A's page. A distinct alert id, deliberately: the wrapper cools down PER alert id, so folding
# this into `xrepo_ci_dark` would let an unrelated dark streak suppress the one page that warns
# before a watched schedule stops existing. Precedent: `SOT_PARITY_SUSTAINED_DRIFT`.
expiry_body() {
  local n="$1" detail="$2" noun="repositories are"
  [ "$n" -eq 1 ] && noun="repository is"
  printf '%s\n\n%s watched %s about to have scheduled workflows AUTO-DISABLED for inactivity%s\n\n%s\n\nAction: dispatch OPS-XREPO-CI-SCHEDULE-EXPIRY-W{NEXT}\nSource: ops/cron/xrepo-ci-conclusion-canary.sh' \
    "🟡 AlgoVault Alert" "$n" "$noun" "$detail" \
"GitHub: \"In a public repository, scheduled workflows are automatically disabled
when no repository activity has occurred in 60 days.\" Once that happens the badge
freezes on its last state and this canary would read it as current — so the alert
is the only thing standing between a dead schedule and a permanent false green."
}

fire() {
  local id="$1" body="$2"
  if [ -x "$SEND" ]; then
    # POSITIONAL, per send_telegram.sh's documented contract
    # (`<alert_id> <severity> [body_file|-]`) — corrected 2026-08-21 by
    # OPS-CI-MAIN-WRITER-HARDEN-W1 after BOTH alerts had been dark since this script's first
    # commit: the env-var form left `$2` unset, the wrapper died on `severity required`, and the
    # fail-open tail swallowed it into a log nobody reads.
    printf '%s' "$body" | "$SEND" "$id" "CRITICAL_PERSISTENT" - >/dev/null 2>&1 \
      || log "send_telegram.sh failed (fail-open)"
  else
    log "send_telegram.sh not executable at $SEND — alert NOT sent (fail-open)"
    echo "  ! alerter missing at $SEND — a $id condition went unannounced"
  fi
}

main() {
  # Every terminal path emits BOTH tokens. A missing freshness line would be a third state —
  # "the script ran but said nothing about recency" — indistinguishable from an old build.
  command -v curl >/dev/null 2>&1 || { log "curl missing — cannot verify"; freshness UNKNOWN; verdict INDETERMINATE; exit 0; }

  run_checks

  if [ "$CHECKED" -eq 0 ]; then
    # We build this list, so an empty one is a defect in the config, not a fact about
    # the world — refuse rather than report a confident all-clear over nothing.
    echo "  x watch list is EMPTY — nothing was checked"
    log "INDETERMINATE empty watch list"
    freshness N/A
    verdict INDETERMINATE; exit 0
  fi

  # Leg A runs on EVERY path, including the RED one: a repo can be both red today and about to
  # lose its schedule, and the second fact does not become less true because the first fired.
  leg_a_checks
  if [ "${LEGA_EXPIRING:-0}" -gt 0 ]; then
    fire "xrepo_ci_schedule_expiry" "$(expiry_body "$LEGA_EXPIRING" "$LEGA_DETAIL")"
  fi
  freshness "$(aggregate_freshness $ROW_FRESHNESS)"

  # A green badge over a stale run is reported on EVERY path, including the red one: two rows can
  # disagree, and the stale one does not stop being stale because a sibling is red.
  if [ "${STALE_ROWS:-0}" -gt 0 ]; then
    fire "xrepo_ci_stale" "$(stale_body "$STALE_ROWS" "$STALE_DETAIL")"
    log "STALE rows=$STALE_ROWS — escalated"
  fi

  if [ "$RED" -gt 0 ]; then
    fire "xrepo_ci_red" "$(red_body "$RED" "$RED_DETAIL")"
    verdict FAIL; exit 0
  fi

  # A canary that cannot answer must not be quietly content. CLAUDE.md: a dark guard
  # exiting 0 is indistinguishable from a healthy one, so persistent INDETERMINATE
  # escalates on its own rather than waiting to be noticed — which is precisely what
  # nobody did for the 40 runs that motivated this script.
  # ONE streak, two causes. A run counts as unverified when a CONCLUSION could not be read, and
  # now also when the run-recency leg could not answer: a parser that rots must announce itself
  # rather than degrade quietly forever. The body names which reader went dark; the verdict token
  # still reports only what the CONCLUSION reader saw, so a Leg B failure can never turn a
  # verified-green run into INDETERMINATE.
  if [ "$INDET" -gt 0 ] || [ "${LEGB_UNKNOWN:-0}" -gt 0 ]; then
    local STREAK CAUSE=badge
    [ "$INDET" -eq 0 ] && CAUSE=legb
    STREAK=$(cat "$STATE" 2>/dev/null || echo 0)
    case "$STREAK" in ''|*[!0-9]*) STREAK=0 ;; esac
    STREAK=$((STREAK + 1))
    echo "$STREAK" > "$STATE" 2>/dev/null || true
    echo "  checked $CHECKED workflow(s): $INDET indeterminate, $RED red, ${LEGB_UNKNOWN:-0} recency-unknown (consecutive unverified runs: $STREAK)"
    if [ "$STREAK" -ge 3 ]; then
      fire "xrepo_ci_dark" "$(dark_body "$STREAK" "$CAUSE")"
      log "DARK streak=$STREAK cause=$CAUSE — escalated"
    fi
    if [ "$INDET" -gt 0 ]; then verdict INDETERMINATE; else verdict PASS; fi
    exit 0
  fi

  echo 0 > "$STATE" 2>/dev/null || true
  echo "  checked $CHECKED workflow(s): all green"
  verdict PASS; exit 0
}

# ── SELF-TEST ────────────────────────────────────────────────────────────────────────────────
self_test() {
  local tmp fails=0 checks=0 out
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/xrepotest.XXXXXX") || { echo "XREPO_CI_VERDICT=INDETERMINATE"; exit 3; }
  # An assertion that RAISES is not an assertion — every check reports FAIL and continues.
  ck() { checks=$((checks + 1)); if [ "$2" != "$3" ]; then echo "  ✗ $1 (got '$2' want '$3')"; fails=$((fails + 1)); fi; }
  ckc() { checks=$((checks + 1)); case "$2" in *"$3"*) ;; *) echo "  ✗ $1 ('$2' does not contain '$3')"; fails=$((fails + 1)) ;; esac; }
  ckn() { checks=$((checks + 1)); case "$2" in *"$3"*) echo "  ✗ $1 ('$2' MUST NOT contain '$3')"; fails=$((fails + 1)) ;; *) ;; esac; }

  echo "SELF-TEST: pure functions (the pieces the fetch seam bypasses)"
  ck "badge_url shape" "$(BADGE_HOST=https://github.com badge_url o/r wf.yml main)" \
     "https://github.com/o/r/actions/workflows/wf.yml/badge.svg?branch=main"
  ck "actions_url shape" "$(BADGE_HOST=https://github.com actions_url o/r wf.yml main)" \
     "https://github.com/o/r/actions/workflows/wf.yml?query=branch%3Amain"
  ck "parse passing"   "$(parse_badge_status '<svg><title>Marketplace Health Check - passing</title></svg>')" "passing"
  ck "parse failing"   "$(parse_badge_status '<svg><title>Postgres test lane - failing</title></svg>')" "failing"
  ck "parse no status" "$(parse_badge_status '<svg><title>Postgres test lane - no status</title></svg>')" "no status"
  # A workflow NAME containing " - " must not fool the split — take the LAST segment.
  ck "parse name with dash" "$(parse_badge_status '<svg><title>Build - Deploy - passing</title></svg>')" "passing"
  ck "parse refuses markup with no title" "$(parse_badge_status '<svg></svg>' || echo REFUSED)" "REFUSED"
  ck "parse refuses title with no separator" "$(parse_badge_status '<svg><title>whatever</title></svg>' || echo REFUSED)" "REFUSED"
  ck "classify passing"   "$(classify_status passing)"     "PASS"
  ck "classify failing"   "$(classify_status failing)"     "FAIL"
  ck "classify no status" "$(classify_status 'no status')" "INDETERMINATE"
  ck "classify unmeasured token is INDETERMINATE, never PASS" "$(classify_status 'brand new github word')" "INDETERMINATE"

  echo "SELF-TEST: rendered ALERT BODIES (a verdict assertion cannot see a mis-rendered body)"
  local rb db RN
  RN=$'Alert\n'
  rb=$(red_body 1 "
- o/r (branch main): failing
  https://github.com/o/r/actions/workflows/wf.yml?query=branch%3Amain")
  db=$(dark_body 6)
  ckn "red body has NO literal %0A"  "$rb" '%0A'
  ckn "dark body has NO literal %0A" "$db" '%0A'
  ckc "red body has a real newline"  "$rb" "$RN"
  ckc "dark body has a real newline" "$db" "$RN"
  ck  "red body pluralises 1 correctly" "$(red_body 1 '' | sed -n '3p')" "1 cross-repo CI workflow is RED"
  ck  "red body pluralises 2 correctly" "$(red_body 2 '' | sed -n '3p')" "2 cross-repo CI workflows are RED"
  ckc "red body names the actions page" "$rb" "query=branch%3Amain"
  ckc "dark body carries the streak"    "$db" "6 consecutive runs"
  # The dark body must no longer blame a rate limit — the reader is not metered by that budget.
  ckn "dark body no longer blames the REST budget" "$db" "60/hr"

  echo "SELF-TEST: end-to-end through the fetch seam"
  mkfx() { # <url> <status-token> [http-code]
    local f; f="$tmp/fx/$(printf '%s' "$1" | tr -c 'A-Za-z0-9' '_')"
    mkdir -p "$tmp/fx"
    printf '<svg><title>Some Workflow - %s</title></svg>' "$2" > "$f.svg"
    printf '%s' "${3:-200}" > "$f.code"
  }
  # A mock alerter that enforces the SAME positional refusal the real wrapper does, so a
  # regression to the env-var form FAILS this proof instead of passing it silently.
  cat > "$tmp/send.sh" <<'MOCK'
#!/usr/bin/env bash
: "${1:?alert_id required}"
: "${2:?severity required}"
body=$([ "${3:--}" = "-" ] && cat || cat "$3")
printf '%s|%s|%s\n' "$1" "$2" "$body" >> "$MOCK_SINK"
MOCK
  chmod +x "$tmp/send.sh"

  # Leg A / Leg B fixtures. The feed-level <updated> differs from the entry-level one on purpose:
  # a parser that takes the LAST match would read the entry and be wrong by years.
  mkatom() { # <url> <feed-updated-iso> [http-code] [content-type]
    local f; f="$tmp/fx/$(printf '%s' "$1" | tr -c 'A-Za-z0-9' '_')"
    mkdir -p "$tmp/fx"
    printf '<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Recent Commits</title><updated>%s</updated><entry><id>x</id><updated>2019-03-04T05:06:07Z</updated></entry></feed>' "$2" > "$f.atom"
    printf '%s' "${3:-200}" > "$f.code"
    if [ -n "${4:-}" ]; then printf '%s' "$4" > "$f.ct"; fi
  }

  # A run row as GitHub actually renders it, captured 2026-09-22. Two `<relative-time>` elements
  # per row and an OLDER row underneath, both on purpose: a parser that takes "the first datetime
  # on the page" or "the last row" passes a one-row fixture and fails live.
  mkpage() { # <url> <run_number> <run_id> <iso> [http-code] [content-type] [dispatch]
    local f lbl; f="$tmp/fx/$(printf '%s' "$1" | tr -c 'A-Za-z0-9' '_')"
    mkdir -p "$tmp/fx"
    if [ -n "${7:-}" ]; then lbl="completed successfully:  Run $2 of Regenerate Landing from Manifests. manifest-changed"
    else lbl="completed successfully:  Run $2 of Some Workflow."; fi
    {
      printf '<html><body><div class="Box">'
      printf '<div class="Box-row" id="check_suite_%s01" data-url="/x/actions/workflow-run/%s01">' "$2" "$2"
      printf '<a href="/o/x/actions/runs/%s" aria-label="%s"><span>Some Workflow</span></a>' "$3" "$lbl"
      printf '<span>#%s: <span>Scheduled</span></span>' "$2"
      printf '<relative-time     datetime="%s"     threshold="PT1H"></relative-time>' "$4"
      printf '<relative-time     datetime="%s"></relative-time>' "$4"
      printf '<a class="branch-name" title="main">main</a></div>'
      printf '<div class="Box-row" id="check_suite_%s00"><a href="/o/x/actions/runs/%s" aria-label="failed:  Run %s of Some Workflow."></a>' "$2" "$(( $3 - 7 ))" "$(( $2 - 1 ))"
      printf '<relative-time datetime="2019-03-04T05:06:07Z"></relative-time></div>'
      printf '</div></body></html>'
    } > "$f.html"
    printf '%s' "${5:-200}" > "$f.code"
    if [ -n "${6:-}" ]; then printf '%s' "$6" > "$f.ct"; fi
  }
  mkpage_norows() { # <url> — a 200 with real bytes and no run rows at all
    local f; f="$tmp/fx/$(printf '%s' "$1" | tr -c 'A-Za-z0-9' '_')"
    mkdir -p "$tmp/fx"
    printf '<html><body><div class="blankslate"><h3>There are no workflow runs yet.</h3></div></body></html>' > "$f.html"
    printf '200' > "$f.code"
  }

  run_case() { # <watched> <expect-verdict>
    MOCK_SINK="$tmp/sink" XREPO_CI_FIXTURE_DIR="$tmp/fx" XREPO_CI_WATCHED="$1" \
      XREPO_CI_SEND="$tmp/send.sh" XREPO_CI_LOG="$tmp/log" XREPO_CI_STATE="$tmp/streak" \
      XREPO_CI_LEDGER="$tmp/ledger.jsonl" XREPO_CI_NOW="${CASE_NOW:-}" \
      bash "$0" 2>&1
  }
  local CASE_NOW=""

  local A="https://github.com/o/a/actions/workflows/w.yml/badge.svg?branch=main"
  local B="https://github.com/o/b/actions/workflows/w.yml/badge.svg?branch=main"
  local ATOM_A="https://github.com/o/a/commits/main.atom"
  local ATOM_B="https://github.com/o/b/commits/main.atom"
  # FIXTURE DATA gains the 5th field; every assertion line below is unchanged.
  local ROWS="o/a|w.yml|Alpha|main|86400
o/b|w.yml|Beta|main|86400"
  local PAGE_A="https://github.com/o/a/actions/workflows/w.yml?query=branch%3Amain"
  local PAGE_B="https://github.com/o/b/actions/workflows/w.yml?query=branch%3Amain"
  # Keep both repos' activity and both rows' runs recent in the shared cases, so BOTH legs are
  # exercised on every one of them and neither can become the reason a pre-existing assertion
  # passes. A fixture that makes a leg silently unavailable would make these cases vacuous.
  local RECENT ACTIVE
  ACTIVE=$(date -u -d '-3 days' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-3d +%Y-%m-%dT%H:%M:%SZ)
  RECENT=$(date -u -d '-2 hours' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-2H +%Y-%m-%dT%H:%M:%SZ)
  mkatom "$ATOM_A" "$ACTIVE"; mkatom "$ATOM_B" "$ACTIVE"
  mkpage "$PAGE_A" 132 35732680339 "$RECENT"; mkpage "$PAGE_B" 132 35732680339 "$RECENT"

  : > "$tmp/sink"; echo 0 > "$tmp/streak"
  mkfx "$A" passing; mkfx "$B" passing
  out=$(run_case "$ROWS")
  ckc "all-green run reports PASS" "$out" "XREPO_CI_VERDICT=PASS"
  ckc "all-green run emits POSITIVE per-row output, not absence-of-alert" "$out" "+ Alpha (o/a@main): latest run = passing"
  ck  "all-green run fires nothing" "$(wc -l < "$tmp/sink" | tr -d ' ')" "0"
  ck  "all-green run resets the streak" "$(cat "$tmp/streak")" "0"

  : > "$tmp/sink"; echo 0 > "$tmp/streak"
  mkfx "$B" failing
  out=$(run_case "$ROWS")
  ckc "one-failing run reports FAIL" "$out" "XREPO_CI_VERDICT=FAIL"
  ckc "one-failing run FIRES with the right id and severity" "$(cat "$tmp/sink")" "xrepo_ci_red|CRITICAL_PERSISTENT|"
  ckc "the fired body names the workflow" "$(cat "$tmp/sink")" "o/b/w.yml (branch main): failing"
  ckn "the fired body has no literal %0A" "$(cat "$tmp/sink")" '%0A'

  : > "$tmp/sink"; echo 2 > "$tmp/streak"
  mkfx "$B" 'no status'
  out=$(run_case "$ROWS")
  ckc "no-status run reports INDETERMINATE" "$out" "XREPO_CI_VERDICT=INDETERMINATE"
  ckc "3rd consecutive indeterminate ESCALATES" "$(cat "$tmp/sink")" "xrepo_ci_dark|CRITICAL_PERSISTENT|"
  ck  "streak advanced to 3" "$(cat "$tmp/streak")" "3"

  : > "$tmp/sink"; echo 0 > "$tmp/streak"
  mkfx "$B" passing 404
  out=$(run_case "$ROWS")
  ckc "HTTP 404 is INDETERMINATE, never FAIL" "$out" "XREPO_CI_VERDICT=INDETERMINATE"
  ckc "HTTP 404 says so per-row" "$out" "badge HTTP 404"

  : > "$tmp/sink"; echo 0 > "$tmp/streak"
  mkfx "$B" passing
  out=$(run_case "o/a|w.yml|Alpha|main|86400
o/b|w.yml|Beta")
  ckc "a watch row with NO BRANCH refuses" "$out" "watch row has NO BRANCH field"
  ckc "a watch row with NO BRANCH yields INDETERMINATE" "$out" "XREPO_CI_VERDICT=INDETERMINATE"

  out=$(run_case "")
  ckc "an EMPTY watch list refuses rather than reporting all-clear" "$out" "watch list is EMPTY"
  ckc "an EMPTY watch list yields INDETERMINATE" "$out" "XREPO_CI_VERDICT=INDETERMINATE"

  echo "SELF-TEST: the 5th watch-row field (cadence) — an ENUM we construct, so it REFUSES"
  ck "valid_cadence accepts seconds"        "$(valid_cadence 86400 && echo OK)"        "OK"
  ck "valid_cadence accepts event-driven"   "$(valid_cadence event-driven && echo OK)" "OK"
  ck "valid_cadence refuses empty"          "$(valid_cadence '' || echo REFUSED)"      "REFUSED"
  ck "valid_cadence refuses a word"         "$(valid_cadence weekly || echo REFUSED)"  "REFUSED"
  ck "valid_cadence refuses zero"           "$(valid_cadence 0 || echo REFUSED)"       "REFUSED"
  ck "valid_cadence refuses a negative"     "$(valid_cadence -1 || echo REFUSED)"      "REFUSED"

  : > "$tmp/sink"; echo 0 > "$tmp/streak"
  out=$(run_case "o/a|w.yml|Alpha|main")
  ckc "a 4-field watch row refuses"              "$out" "watch row has NO CADENCE field"
  ckc "a 4-field watch row yields INDETERMINATE" "$out" "XREPO_CI_VERDICT=INDETERMINATE"
  out=$(run_case "o/a|w.yml|Alpha|main|weekly")
  ckc "a non-enum cadence refuses identically"   "$out" "watch row has NO CADENCE field (got 'weekly')"
  ckc "a non-enum cadence yields INDETERMINATE"  "$out" "XREPO_CI_VERDICT=INDETERMINATE"

  echo "SELF-TEST: freshness aggregation (row 2 is permanently N/A, so the rule is load-bearing)"
  ck "aggregate {} is N/A"                "$(aggregate_freshness)"                 "N/A"
  ck "aggregate {N/A} is N/A"             "$(aggregate_freshness N/A)"             "N/A"
  ck "aggregate {FRESH,N/A} is FRESH"     "$(aggregate_freshness FRESH N/A)"       "FRESH"
  ck "aggregate {N/A,STALE} is STALE"     "$(aggregate_freshness N/A STALE)"       "STALE"
  ck "aggregate {FRESH,STALE} is MIXED"   "$(aggregate_freshness FRESH STALE)"     "MIXED"
  ck "aggregate {FRESH,FRESH} is FRESH"   "$(aggregate_freshness FRESH FRESH)"     "FRESH"
  ck "aggregate {UNKNOWN,N/A} is UNKNOWN" "$(aggregate_freshness UNKNOWN N/A)"     "UNKNOWN"

  echo "SELF-TEST: Leg A — schedule expiry on the atom contract"
  ck "atom_url shape" "$(BADGE_HOST=https://github.com atom_url o/r main)" \
     "https://github.com/o/r/commits/main.atom"
  ck "parse_atom_updated takes the FEED-level stamp, not an entry's" \
     "$(parse_atom_updated '<feed><updated>2026-08-30T04:13:31Z</updated><entry><updated>2019-03-04T05:06:07Z</updated></entry></feed>')" \
     "2026-08-30T04:13:31Z"
  ck "parse_atom_updated refuses a feed with none" \
     "$(parse_atom_updated '<feed><title>x</title></feed>' || echo REFUSED)" "REFUSED"
  ck "iso_epoch parses a Zulu stamp on both date dialects" "$(iso_epoch 2026-09-21T15:01:35Z)" "1790002895"
  ck "iso_epoch refuses garbage" "$(iso_epoch 'not a date' || echo REFUSED)" "REFUSED"
  ck "human_age renders hours and minutes" "$(human_age 67175)" "18h39m"
  ck "human_age renders days past 48h"     "$(human_age 5270400)" "61d0h"

  # AC3 — 61 days of inactivity on a repo that HAS a scheduled row.
  : > "$tmp/sink"; echo 0 > "$tmp/streak"
  mkfx "$A" passing; mkfx "$B" passing
  mkatom "$ATOM_A" 2026-07-01T00:00:00Z; mkatom "$ATOM_B" 2026-08-29T00:00:00Z
  CASE_NOW=2026-08-31T12:00:00Z
  out=$(run_case "$ROWS")
  ckc "61d of inactivity FIRES xrepo_ci_schedule_expiry" "$(cat "$tmp/sink")" "xrepo_ci_schedule_expiry|CRITICAL_PERSISTENT|"
  ckc "the expiry body names the age"                    "$(cat "$tmp/sink")" "61d ago"
  ckc "the expiry body names the disable date"           "$(cat "$tmp/sink")" "disable"
  ckc "the expiry body names the remediation"            "$(cat "$tmp/sink")" "Actions -> w.yml -> \"Enable workflow\""
  ckc "the expiry body offers the land-a-commit remedy"  "$(cat "$tmp/sink")" "land any commit in o/a"
  ck  "it fires ONCE even though two repos were checked" "$(grep -c 'xrepo_ci_schedule_expiry' "$tmp/sink" | tr -d ' ')" "1"
  ckc "the conclusion verdict is untouched by Leg A"     "$out" "XREPO_CI_VERDICT=PASS"

  # AC4 — 10 days: no fire, and no false attribution.
  : > "$tmp/sink"; echo 0 > "$tmp/streak"
  mkatom "$ATOM_A" 2026-08-21T00:00:00Z; mkatom "$ATOM_B" 2026-08-21T00:00:00Z
  CASE_NOW=2026-08-31T12:00:00Z
  out=$(run_case "$ROWS")
  ck  "10d of inactivity fires NOTHING" "$(grep -c 'xrepo_ci_schedule_expiry' "$tmp/sink" | tr -d ' ')" "0"
  ckc "10d of inactivity still reports POSITIVE per-repo output" "$out" "+ Leg A (o/a@main): last repo activity 2026-08-21T00:00:00Z — 10d ago"

  # AC5 — an event-driven-only repo can NEVER warn: the 60-day rule does not apply to it, and the
  # exclusion is derived from the declared cadence rather than from a hardcoded repo name.
  : > "$tmp/sink"; echo 0 > "$tmp/streak"
  mkatom "$ATOM_A" 2019-01-01T00:00:00Z; mkatom "$ATOM_B" 2019-01-01T00:00:00Z
  CASE_NOW=2026-08-31T12:00:00Z
  out=$(run_case "o/a|w.yml|Alpha|main|event-driven
o/b|w.yml|Beta|main|event-driven")
  ck  "an event-driven-only watch list never warns about expiry" "$(grep -c 'xrepo_ci_schedule_expiry' "$tmp/sink" | tr -d ' ')" "0"
  ckc "and it says so rather than staying silent" "$out" "Leg A (schedule expiry): no scheduled watch row — not applicable"
  ckc "an all-event-driven run aggregates to N/A" "$out" "XREPO_CI_FRESHNESS=N/A"

  # AC6 — fail-soft. A 403 on the atom leg degrades THAT leg and nothing else.
  : > "$tmp/sink"; echo 0 > "$tmp/streak"
  mkatom "$ATOM_A" 2026-07-01T00:00:00Z 403; mkatom "$ATOM_B" 2026-07-01T00:00:00Z 403
  CASE_NOW=2026-08-31T12:00:00Z
  out=$(run_case "$ROWS")
  ckc "atom HTTP 403 reports UNKNOWN for that repo" "$out" "commits feed HTTP 403 — repo activity UNKNOWN"
  ck  "atom HTTP 403 fires nothing"                 "$(wc -l < "$tmp/sink" | tr -d ' ')" "0"
  ckc "atom HTTP 403 leaves the conclusion verdict byte-identical" "$out" "XREPO_CI_VERDICT=PASS"
  ck  "atom HTTP 403 does NOT feed the dark streak" "$(cat "$tmp/streak")" "0"

  # The `.atom` trap, on Leg A's own transport: 200 with text/html must not be read as a feed.
  : > "$tmp/sink"; echo 0 > "$tmp/streak"
  mkatom "$ATOM_A" 2026-07-01T00:00:00Z 200 'text/html; charset=utf-8'
  mkatom "$ATOM_B" 2026-09-20T00:00:00Z
  CASE_NOW=2026-08-31T12:00:00Z
  out=$(run_case "$ROWS")
  ckc "a 200 that is not atom is UNKNOWN, never a parsed feed" "$out" "not atom — repo activity UNKNOWN"
  ck  "a mistyped 200 fires nothing" "$(grep -c 'xrepo_ci_schedule_expiry' "$tmp/sink" | tr -d ' ')" "0"
  CASE_NOW=""

  echo "SELF-TEST: Leg B — run recency parsed from the Actions page, STRUCTURED FIELDS ONLY"
  local ROW_SCHED ROW_DISPATCH
  ROW_SCHED='<div id="check_suite_1"><a href="/o/a/actions/runs/35616111211" aria-label="failed:  Run 131 of Marketplace Health Check."></a><relative-time     datetime="2026-09-21T15:01:35Z"></relative-time><relative-time datetime="2026-09-21T15:01:35Z"></relative-time></div><div id="check_suite_0"><a href="/o/a/actions/runs/35512179431" aria-label="completed successfully:  Run 130 of Marketplace Health Check."></a><relative-time datetime="2026-09-20T12:59:25Z"></relative-time></div>'
  ROW_DISPATCH='<div id="check_suite_9"><a href="/o/b/actions/runs/29813826072" aria-label="completed successfully:  Run 12 of Regenerate Landing from Manifests. manifest-changed"></a><relative-time datetime="2026-07-21T08:19:17Z"></relative-time></div>'
  ck "parses the NEWEST row of a scheduled workflow" "$(parse_runs_page "$ROW_SCHED")" "131|35616111211|2026-09-21T15:01:35Z"
  ck "parses a repository_dispatch label shape too"  "$(parse_runs_page "$ROW_DISPATCH")" "12|29813826072|2026-07-21T08:19:17Z"
  ck "vacuity: a page with no run rows REFUSES rather than reporting zero runs" \
     "$(parse_runs_page '<html><body><div class="blankslate">There are no workflow runs yet.</div></body></html>' || echo REFUSED)" "REFUSED"
  ck "vacuity: an empty body REFUSES" "$(parse_runs_page '' || echo REFUSED)" "REFUSED"
  # A row missing ANY structured field is a parse failure, never a partially-filled answer.
  ck "a row with no datetime REFUSES" \
     "$(parse_runs_page '<div id="check_suite_1"><a href="/o/a/actions/runs/9" aria-label="failed:  Run 1 of X."></a></div>' || echo REFUSED)" "REFUSED"
  ck "a row with no run id REFUSES" \
     "$(parse_runs_page '<div id="check_suite_1"><a aria-label="failed:  Run 1 of X."></a><relative-time datetime="2026-01-01T00:00:00Z"></relative-time></div>' || echo REFUSED)" "REFUSED"

  # AC12/AC13 — the bound is DERIVED from the row's own declared cadence, never a literal.
  : > "$tmp/sink"; : > "$tmp/ledger.jsonl"; echo 0 > "$tmp/streak"
  mkfx "$A" passing; mkfx "$B" passing
  mkatom "$ATOM_A" 2026-09-20T00:00:00Z; mkatom "$ATOM_B" 2026-09-20T00:00:00Z
  mkpage "$PAGE_A" 131 35616111211 2026-09-18T00:00:00Z; mkpage "$PAGE_B" 132 35732680339 2026-09-22T08:00:00Z
  CASE_NOW=2026-09-22T09:41:00Z
  out=$(run_case "$ROWS")
  ckc "a GREEN badge over a run older than 2x cadence FIRES xrepo_ci_stale" "$(cat "$tmp/sink")" "xrepo_ci_stale|CRITICAL_PERSISTENT|"
  ckc "the stale body carries the age"      "$(cat "$tmp/sink")" "4d9h old"
  ckc "the stale body carries the run URL"  "$(cat "$tmp/sink")" "/actions/runs/35616111211"
  ck  "it fires ONCE for one stale row"     "$(grep -c 'xrepo_ci_stale' "$tmp/sink" | tr -d ' ')" "1"
  ckc "the fresh row reports FRESH, not stale" "$out" "+ Beta (o/b@main): newest run #132 started 2026-09-22T08:00:00Z"
  ckc "one stale and one fresh row aggregate to MIXED" "$out" "XREPO_CI_FRESHNESS=MIXED"
  ckc "a stale run does NOT change the conclusion verdict" "$out" "XREPO_CI_VERDICT=PASS"

  : > "$tmp/sink"; : > "$tmp/ledger.jsonl"; echo 0 > "$tmp/streak"
  mkpage "$PAGE_A" 132 35732680339 2026-09-22T08:00:00Z
  out=$(run_case "$ROWS")
  ck  "a run inside the bound fires NOTHING" "$(wc -l < "$tmp/sink" | tr -d ' ')" "0"
  ckc "and reports FRESH"                    "$out" "XREPO_CI_FRESHNESS=FRESH"
  ckc "and stays PASS"                       "$out" "XREPO_CI_VERDICT=PASS"
  ck  "a verified run resets the streak"     "$(cat "$tmp/streak")" "0"

  # AC14 — the declared exemption. An event-driven row cannot be stale HOWEVER old its last run.
  : > "$tmp/sink"; : > "$tmp/ledger.jsonl"; echo 0 > "$tmp/streak"
  mkpage "$PAGE_A" 12 29813826072 2019-03-04T05:06:07Z 200 '' dispatch
  out=$(run_case "o/a|w.yml|Alpha|main|event-driven
o/b|w.yml|Beta|main|86400")
  ck  "an event-driven row NEVER fires xrepo_ci_stale, whatever its age" "$(grep -c 'xrepo_ci_stale' "$tmp/sink" | tr -d ' ')" "0"
  ckc "an event-driven row reports N/A and still names its newest run"   "$out" "event-driven, freshness N/A — newest run #12 started 2019-03-04T05:06:07Z"
  ckc "N/A drops out of the aggregate rather than making it MIXED"       "$out" "XREPO_CI_FRESHNESS=FRESH"

  # AC19/AC20/AC22 — the enriched RED body, and the conclusion NEVER coming from the HTML.
  : > "$tmp/sink"; : > "$tmp/ledger.jsonl"; echo 0 > "$tmp/streak"
  mkfx "$A" failing; mkfx "$B" passing
  mkpage "$PAGE_A" 131 35616111211 2026-09-21T15:01:35Z
  mkpage "$PAGE_B" 132 35732680339 2026-09-22T08:00:00Z
  CASE_NOW=2026-09-22T09:41:00Z
  out=$(run_case "$ROWS")
  ckc "a RED body names the run number and id"    "$(cat "$tmp/sink")" "run #131 (35616111211)"
  ckc "a RED body says STARTED, the quantity the page actually carries" "$(cat "$tmp/sink")" "started 2026-09-21T15:01:35Z"
  ckc "a RED body carries the human age — the 2026-09-22 incident, replayed" "$(cat "$tmp/sink")" "18h39m ago"
  ckc "a RED body carries the run URL"            "$(cat "$tmp/sink")" "/actions/runs/35616111211"
  ckc "a RED body carries the actions-page URL"   "$(cat "$tmp/sink")" "query=branch%3Amain"
  # The page fixture's aria-label says "completed successfully" while the badge says failing. The
  # verdict must follow the BADGE: a product-UI string may never decide a conclusion.
  ckc "the conclusion comes from the badge, never from the page's prose" "$out" "XREPO_CI_VERDICT=FAIL"
  ckc "and the alert fired is the RED one"        "$(cat "$tmp/sink")" "xrepo_ci_red|CRITICAL_PERSISTENT|"

  # AC15 — vacuity end to end: a 200 with bytes and zero rows is a PARSER failure.
  : > "$tmp/sink"; : > "$tmp/ledger.jsonl"; echo 0 > "$tmp/streak"
  mkfx "$A" passing; mkfx "$B" passing
  mkpage_norows "$PAGE_A"
  out=$(run_case "$ROWS")
  ckc "a 200 that parses ZERO rows is UNKNOWN"        "$out" "parsed ZERO run rows"
  ckn "a 200 that parses zero rows never says FRESH"  "$out" "XREPO_CI_FRESHNESS=FRESH"
  ckc "and it never launders into a verified green"   "$out" "XREPO_CI_FRESHNESS=MIXED"
  ck  "a vacuous parse fires nothing on its own"      "$(wc -l < "$tmp/sink" | tr -d ' ')" "0"
  ck  "a vacuous parse DOES feed the unverified streak" "$(cat "$tmp/streak")" "1"

  # AC16 — monotonic. Run ids only grow; a smaller one means the parser latched onto something else.
  : > "$tmp/sink"; : > "$tmp/ledger.jsonl"; echo 0 > "$tmp/streak"
  mkpage "$PAGE_A" 132 35732680339 2026-09-22T08:00:00Z
  CASE_NOW=2026-09-22T09:41:00Z
  out=$(run_case "$ROWS")
  ckc "the ledger records the run id it parsed" "$(cat "$tmp/ledger.jsonl")" '"run_id":"35732680339"'
  mkpage "$PAGE_A" 131 35616111211 2026-09-21T15:01:35Z
  out=$(run_case "$ROWS")
  ckc "a run id OLDER than the recorded one is UNKNOWN" "$out" "is older than the recorded 35732680339"
  ckn "a regressed run id never yields a freshness value" "$out" "XREPO_CI_FRESHNESS=FRESH"

  # AC17 — the `.atom` trap, end to end: 200 + text/html + a body that parses to nothing.
  : > "$tmp/sink"; : > "$tmp/ledger.jsonl"; echo 0 > "$tmp/streak"
  mkpage "$PAGE_A" 132 35732680339 2026-09-22T08:00:00Z
  mkpage_norows "$PAGE_B"
  out=$(run_case "$ROWS")
  ckc "the .atom trap shape (200 text/html, no rows) is UNKNOWN, never an empty success" "$out" "parsed ZERO run rows"
  ck  "and it refuses a .atom URL outright" "$(XREPO_CI_FIXTURE_DIR= LEGB_STATE=; leg_b_check o/a w.yml.atom main 86400 >/dev/null 2>&1; printf '%s' "$LEGB_STATE")" "UNKNOWN"

  # AC18 — three consecutive recency-unknowns escalate, naming the leg that went dark.
  : > "$tmp/sink"; : > "$tmp/ledger.jsonl"; echo 1 > "$tmp/streak"
  mkfx "$A" passing; mkfx "$B" passing
  mkpage "$PAGE_A" 132 35732680339 2026-09-22T08:00:00Z 404
  mkpage "$PAGE_B" 132 35732680339 2026-09-22T08:00:00Z 404
  out=$(run_case "$ROWS")
  ck  "the 2nd consecutive recency-unknown stays SILENT" "$(wc -l < "$tmp/sink" | tr -d ' ')" "0"
  ck  "and advances the streak"                          "$(cat "$tmp/streak")" "2"
  out=$(run_case "$ROWS")
  ckc "the 3rd consecutive recency-unknown ESCALATES"     "$(cat "$tmp/sink")" "xrepo_ci_dark|CRITICAL_PERSISTENT|"
  ckc "and the dark body names the RECENCY leg, not the badge" "$(cat "$tmp/sink")" "the RUN RECENCY leg is not"
  ckn "and it does not blame the badge markup"            "$(cat "$tmp/sink")" "badge markup still"
  ckc "a recency-only failure keeps the conclusion verdict PASS" "$out" "XREPO_CI_VERDICT=PASS"
  CASE_NOW=""

  echo "SELF-TEST: the two declarations of the watch list agree"
  # The pipe-delimited default here and `watches[]` in the monitoring inventory are two statements
  # of one fact. On a HOST there is no checkout, so this asserts what it can reach and says which
  # one it took; CI always has the file, and tests/unit/xrepo-ci-canary.test.ts forces this branch.
  local INV
  INV="${XREPO_CI_INVENTORY:-$(dirname "$0")/../monitoring/monitoring-inventory.json}"
  if [ -r "$INV" ] && command -v python3 >/dev/null 2>&1; then
    local INV_ROWS SCRIPT_ROWS
    INV_ROWS=$(python3 - "$INV" <<'PY'
import json, sys
rows = json.load(open(sys.argv[1]))["artifacts"]
row = next(r for r in rows if r["id"] == "xrepo-ci-conclusion-canary")
for w in row["watches"]:
    print("%s|%s|%s|%s|%s" % (w["repo"], w["workflow"], w["label"], w.get("branch", ""), w.get("cadence_seconds", "")))
PY
)
    SCRIPT_ROWS=$(printf '%s\n' "$WATCHED" | sed '/^[[:space:]]*$/d')
    ck "the inventory watches[] and the script default agree, cadence included" \
       "$(printf '%s\n' "$INV_ROWS" | LC_ALL=C sort)" "$(printf '%s\n' "$SCRIPT_ROWS" | LC_ALL=C sort)"
  else
    echo "  · inventory parity SKIPPED (no readable $INV) — asserted in CI by tests/unit/xrepo-ci-canary.test.ts"
  fi

  echo "SELF-TEST: the shipped script never calls api.github.com"
  # Scan the executable body but CUT the self-test itself first: this assertion's own grep
  # pattern is executable text, so a naive scan would count itself and never be able to pass.
  ck "the reader never calls the REST API" \
     "$(grep -v '^ *#' "$0" | sed '/^self_test()/,$d' | grep -c 'api\.github\.com' | tr -d ' ')" "0"

  rm -rf "$tmp" 2>/dev/null || true
  # Vacuity guard: this suite must never report a pass having asserted nothing.
  if [ "$checks" -lt 30 ]; then
    echo "  ✗ only $checks checks ran — vacuity guard"; fails=$((fails + 1))
  fi
  # The self-test emits BOTH token lines, exactly as a live run does — a caller that gates on the
  # pair must be able to gate on this run too. It measured no live row, so its freshness is `N/A`
  # BY CONSTRUCTION, which is the same value the aggregation rule gives an empty set. It is never
  # `FRESH`: a suite may not report a recency it did not measure.
  if [ "$fails" -gt 0 ]; then
    echo "SELF-TEST: FAIL — $fails of $checks"
    freshness N/A; verdict FAIL; exit 1
  fi
  echo "SELF-TEST: PASS — $checks assertions"
  freshness N/A; verdict PASS; exit 0
}

if [ "${1:-}" = "--self-test" ]; then self_test; fi
main
