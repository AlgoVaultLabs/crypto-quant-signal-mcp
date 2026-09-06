#!/usr/bin/env bash
# intent-classification-readout.sh — FUNNEL-TRUTH-AND-PAID-ATTRIBUTION-W1 CH1 R5.
#
# READ-ONLY. Prints the `/signup?plan=` intent split — `browser` / `unknown` / `bot` — since the
# CH1 deploy, beside the PRE-WAVE baseline it has to be compared against.
#
# ── WHY THIS IS A SCRIPT AND NOT A PROMISE ──────────────────────────────────────────────────
# CH1's whole claim is that the funnel's top stage was an unclassified request count. The number
# that settles it is a `GROUP BY classification` over `signup_attribution`, and the wave that
# ships the columns is the wave that owes the readout — a "we will look in 7 days" line is how a
# measurement becomes a wave nobody dispatches. Every figure the status entry quotes comes from
# here, so a later reader can re-run it rather than trust a transcription.
#
# ── THE BASELINE IS PRINTED BESIDE THE RESULT, DELIBERATELY ─────────────────────────────────
# A post-deploy split alone is uninterpretable. The pre-wave population is measured and fixed:
# over the 28d window ending 2026-09-05, 268 rows — 113 `isbot`-flagged (42.2 %), 150
# browser-shaped UAs (56.0 %), 5 empty-UA. The 150 are the cohort the STRICT `Accept` rule has to
# bite on, and "did it?" is answerable only against that denominator. Comparing a delta across
# two different instruments is not a delta, so the baseline is stated with its instrument
# (`isbot@5.1.44` over the stored `user_agent`) rather than left implicit.
#
# ── READ THE `unknown` ROW AS A RESIDUAL, NOT AS NOISE ──────────────────────────────────────
# `unknown` is fail-open by design (Build Rule 5): no positive bot signal, so it still gets the
# 303 and still mints a Session. It is the honest size of what this wave did NOT close, and it is
# reported rather than folded into either side.
#
# Usage:  ops/scripts/intent-classification-readout.sh [--since <ISO-date>] [--host <ssh-target>]
#
# Defaults to the CH1 deploy date and the signal-1 host. Nothing here writes: no INSERT, no
# ALTER, no cron, no alert. Safe to run at any time, including during serving hours — the queries
# are indexed on `created_at` and touch a table with hundreds of rows, not millions.

set -uo pipefail

SINCE="${SINCE:-2026-09-07}"
HOST="${ALGOVAULT_SIGNAL_HOST:-root@204.168.185.24}"
SSH_KEY="${ALGOVAULT_SSH_KEY:-$HOME/.ssh/algovault_deploy}"
PG_CONTAINER="${PG_CONTAINER:-crypto-quant-signal-mcp-postgres-1}"

while [ $# -gt 0 ]; do
  case "$1" in
    --since) SINCE="${2:?--since needs a date}"; shift 2 ;;
    --host)  HOST="${2:?--host needs an ssh target}"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

echo "── /signup intent classification ─────────────────────────────────────────────"
echo "since:      $SINCE"
echo "host:       $HOST"
echo
echo "PRE-WAVE BASELINE (28d to 2026-09-05, instrument: isbot@5.1.44 over stored user_agent)"
echo "  total 268  ·  isbot-flagged 113 (42.2%)  ·  browser-shaped UA 150 (56.0%)  ·  empty UA 5"
echo "  Plausible counted 3 human pricing-CTA clicks in the same window."
echo

# One SSH invocation, one heredoc. Natural single quotes inside `psql -c` — no nested-quote
# mangling, and no `docker exec … node -e` (whose module resolution and quoting both break here).
ssh -o ConnectTimeout=20 -o BatchMode=yes -i "$SSH_KEY" "$HOST" 'bash -s' <<EOF
PGU=\$(docker exec "$PG_CONTAINER" printenv POSTGRES_USER)
# ONE failed query must not be laundered into a PASS. \`psql\` exits non-zero on a SQL error, but
# nothing propagates that out of a function call, so a broken query prints its ERROR to stderr
# and the readout still ends "PASS" — which is precisely the shape a readout must never have:
# "could not compute" reading as "computed, and it is zero". Count failures explicitly and carry
# the count out through the remote exit status.
QFAIL=0
q() {
  docker exec "$PG_CONTAINER" psql -q -v ON_ERROR_STOP=1 -U "\$PGU" -d signal_performance -tA -F'|' -c "\$1" \
    || QFAIL=\$((QFAIL + 1))
}

echo "BY CLASSIFICATION (since $SINCE)"
q "SELECT coalesce(classification,'(pre-CH1 null)')||' | '||count(*)||' | '||
          round(100.0*count(*)/nullif(sum(count(*)) OVER (),0),1)||'%'
   FROM signup_attribution WHERE created_at >= '$SINCE'
   GROUP BY classification ORDER BY count(*) DESC;"

echo
echo "BY UA CLASS (since $SINCE)"
q "SELECT coalesce(ua_class,'(pre-CH1 null)')||' | '||coalesce(classification,'-')||' | '||count(*)
   FROM signup_attribution WHERE created_at >= '$SINCE'
   GROUP BY ua_class, classification ORDER BY count(*) DESC LIMIT 25;"

echo
echo "BY DAY (since $SINCE)"
# GROUP BY the raw day expression, never the SELECT's ordinal: ordinal 1 here is the whole
# concatenated string, which CONTAINS the aggregates — PG rejects it with "aggregate functions
# are not allowed in GROUP BY", and the error is easy to miss under a heading that then prints
# nothing at all.
q "SELECT to_char(date_trunc('day', created_at),'YYYY-MM-DD')||' | browser='||
          count(*) FILTER (WHERE classification='browser')||' unknown='||
          count(*) FILTER (WHERE classification='unknown')||' bot='||
          count(*) FILTER (WHERE classification='bot')||' unclassified='||
          count(*) FILTER (WHERE classification IS NULL)
   FROM signup_attribution WHERE created_at >= '$SINCE'
   GROUP BY date_trunc('day', created_at)
   ORDER BY date_trunc('day', created_at);"

echo
echo "CHECKOUT ABANDONED (funnel_events, since $SINCE)"
q "SELECT coalesce(meta_json::json->>'classification','(none)')||' | '||count(*)
   FROM funnel_events WHERE event_type='checkout_abandoned' AND ts >= '$SINCE'
   GROUP BY coalesce(meta_json::json->>'classification','(none)')
   ORDER BY count(*) DESC;"

exit \$QFAIL
EOF

rc=$?
echo
if [ "$rc" -ne 0 ]; then
  # An unreachable host — or ANY failed query, which the remote block carries out as its exit
  # status — is INDETERMINATE, never a zero split. "Could not see" and "saw nothing" are the two
  # things a readout must never merge: a broken query prints its ERROR to stderr and leaves its
  # heading empty, which reads exactly like a clean "no bots found". Measured here on the first
  # live run, where a `GROUP BY 1` over an aggregate-bearing expression failed and the script
  # still printed PASS.
  echo "INTENT_READOUT_VERDICT=INDETERMINATE (host unreachable or $rc quer(y|ies) failed)"
  exit 3
fi
echo "INTENT_READOUT_VERDICT=PASS"
exit 0
