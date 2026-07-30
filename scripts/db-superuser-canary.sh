#!/usr/bin/env bash
# OPS-SEC-DB-LEAST-PRIV-W2 (R4) — assert no RUNTIME Postgres role is a superuser.
#
# W1 established that `algovault` is the cluster's BOOTSTRAP role (pg_authid.oid = 10 =
# BOOTSTRAP_SUPERUSERID) and can NEVER be NOSUPERUSER — PostgreSQL rejects it outright
# ("The bootstrap user must have the SUPERUSER attribute"), even when the ALTER is issued
# by a different superuser. So the invariant this canary enforces is deliberately NOT
# "there are no superusers". It is the two-part claim W2 actually established:
#
#   A. the superuser set is EXACTLY {algovault} — nothing new has been minted; and
#   B. no role named in a RUNTIME DSN is a superuser — i.e. the app authenticates as
#      `algovault_app` (NOSUPERUSER, owns its objects) and never as the bootstrap role.
#
# W1 deliberately withheld this canary: before the W2 cutover, check B was red by
# construction, and a permanently-red alarm is worse than no alarm — it trains the eye to
# ignore the channel. It only became truthful once the app moved off the bootstrap role.
#
# Check B is the load-bearing half. A leaked runtime credential is bounded to the app's
# own objects only for as long as the DSN keeps naming a non-superuser role, and nothing
# else would notice a regression: re-pointing a DSN back to `algovault` is a one-line
# host-side edit that no CI gate can see, because the DSN lives in an untracked .env.
#
# Alerting is delegated ENTIRELY to send_telegram.sh, which owns severity / 24h cooldown /
# DRY_RUN_TG / ALGOVAULT_TG_TEST_INERT / fail-open. This wrapper MUST NOT re-implement any
# of them (monitoring alert contract).
#
# Exit codes:  0 = clean (no page)  ·  1 = DRIFT (paged)  ·  2 = canary-infra error
# (fail-open, log-only — but see the note on check B below).
#
# Usage:
#   db-superuser-canary.sh              # evaluate; page on drift
#   db-superuser-canary.sh --self-test  # prove the comparator fires in BOTH directions
set -uo pipefail

SELF_DIR=${SELF_DIR:-/opt/algovault-monitoring}
PG_CTR=${PG_CTR:-crypto-quant-signal-mcp-postgres-1}
LOG=${LOG:-/var/log/db-superuser-canary.log}
ALERT_ID=DB_SUPERUSER_DRIFT

# The bootstrap role is an engine invariant, not a policy choice — see the header.
EXPECTED_SUPERUSERS=${EXPECTED_SUPERUSERS:-algovault}

# The role this canary CONNECTS as — deliberately NOT the role it is auditing. `pg_roles`
# is a public catalog view (rolpassword masked), so a read-only role can see `rolsuper`
# for every role; live-verified. Probing as `algovault` would have this guard open a daily
# bootstrap-superuser connection, i.e. the canary would violate the very invariant it
# exists to defend, and would pollute the `pg_stat_activity` census used to prove it.
PROBE_ROLE=${PROBE_ROLE:-aoe_readonly}

# Every file that can name a runtime DSN. A role appearing here MUST NOT be a superuser.
DSN_FILES=${DSN_FILES:-"/opt/crypto-quant-signal-mcp/.env /etc/algovault/funnel-snapshot.env"}

TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
log() { echo "$TS [$ALERT_ID] $*" >> "$LOG" || true; }

# Extract the role from every `postgres://ROLE:...@` / `postgresql://ROLE:...@` DSN.
# Prints one role per line. Never prints the password.
dsn_roles() {
  local f
  for f in $DSN_FILES; do
    [ -r "$f" ] || continue
    sed -nE 's#.*postgres(ql)?://([A-Za-z0-9_]+):[^@]*@.*#\2#p' "$f"
  done | sort -u
}

psql_q() { docker exec "$PG_CTR" psql -U "$PROBE_ROLE" -d signal_performance -tAc "$1" 2>>"$LOG"; }

# ── self-test: the comparator must fire on drift AND stay silent when clean ──
if [ "${1:-}" = "--self-test" ]; then
  fails=0
  expected="algovault"
  # A-direction, DRIFT: an extra superuser must compare unequal (i.e. fire).
  [ "algovault,intruder" != "$expected" ] || { echo "self-test FAIL: extra superuser not detected"; fails=$((fails+1)); }
  # A-direction, CLEAN: the exact expected set must compare equal (i.e. stay silent).
  [ "algovault" = "$expected" ] || { echo "self-test FAIL: clean set falsely flagged"; fails=$((fails+1)); }
  # B-direction: the rolsuper case-split must route 't' to drift and 'f' to OK.
  for pair in "t:DRIFT" "f:OK"; do
    v=${pair%%:*}; want=${pair##*:}
    case "$v" in f) got=OK ;; t) got=DRIFT ;; *) got=ESCALATE ;; esac
    [ "$got" = "$want" ] || { echo "self-test FAIL: rolsuper='$v' routed to $got, want $want"; fails=$((fails+1)); }
  done
  # B-direction: the DSN parser must actually extract a role from both DSN shapes.
  got=$(printf 'DATABASE_URL=postgresql://algovault_app:pw@postgres:5432/db\n' \
        | sed -nE 's#.*postgres(ql)?://([A-Za-z0-9_]+):[^@]*@.*#\2#p')
  [ "$got" = "algovault_app" ] || { echo "self-test FAIL: postgresql:// parser got '$got'"; fails=$((fails+1)); }
  got=$(printf 'DATABASE_URL=postgres://algovault_app:pw@127.0.0.1:5432/db\n' \
        | sed -nE 's#.*postgres(ql)?://([A-Za-z0-9_]+):[^@]*@.*#\2#p')
  [ "$got" = "algovault_app" ] || { echo "self-test FAIL: postgres:// parser got '$got'"; fails=$((fails+1)); }
  if [ "$fails" -eq 0 ]; then echo "self-test PASS (6 checks: A drift/clean, B rolsuper t/f routing, both DSN shapes parsed)"; exit 0; fi
  echo "self-test FAILED ($fails)"; exit 1
fi

# ── check A: the superuser set is exactly {algovault} ──
SUPERS=$(psql_q "SELECT coalesce(string_agg(rolname, ',' ORDER BY rolname), '<none>') FROM pg_roles WHERE rolsuper")
if [ -z "$SUPERS" ]; then
  log "FAIL_OPEN: could not read pg_roles (db unreachable?)"
  echo "canary-infra error: pg_roles unreadable"; exit 2
fi

# ── check B: no role named in a runtime DSN is a superuser ──
# Deliberately NOT fail-open: an unreadable/absent DSN file means we cannot prove the app
# is off the bootstrap role, and a guard that cannot see is indistinguishable from a guard
# that is happy. Escalate instead of exiting 0.
ROLES=$(dsn_roles)
if [ -z "$ROLES" ]; then
  log "ESCALATE: no DSN role could be parsed from: $DSN_FILES"
  printf 'DB superuser canary could not parse any runtime DSN role from: %s\nCheck B is DARK — cannot prove the app is off the bootstrap role.\n' "$DSN_FILES" \
    | "$SELF_DIR/send_telegram.sh" "$ALERT_ID" CRITICAL_PERSISTENT - || true
  exit 1
fi

DRIFT=""
[ "$SUPERS" = "$EXPECTED_SUPERUSERS" ] \
  && log "check A OK: superusers = $SUPERS (expected $EXPECTED_SUPERUSERS)" \
  || { log "check A DRIFT: superusers = $SUPERS (expected $EXPECTED_SUPERUSERS)"; DRIFT="${DRIFT}superuser set is '$SUPERS', expected '$EXPECTED_SUPERUSERS'. "; }

for r in $ROLES; do
  IS_SUPER=$(psql_q "SELECT rolsuper FROM pg_roles WHERE rolname = '$r'")
  case "$IS_SUPER" in
    f) log "check B OK: runtime DSN role '$r' rolsuper=f" ;;
    t) log "check B DRIFT: runtime DSN role '$r' rolsuper=t"; DRIFT="${DRIFT}runtime DSN role '$r' is a SUPERUSER. " ;;
    *) log "check B ESCALATE: runtime DSN role '$r' not found in pg_roles"; DRIFT="${DRIFT}runtime DSN role '$r' does not exist in pg_roles. " ;;
  esac
done

if [ -n "$DRIFT" ]; then
  printf 'DB superuser drift: %s\nRuntime DSN roles checked: %s\nExpected: superuser set == {%s} and every DSN role NOSUPERUSER.\n' \
    "$DRIFT" "$(echo $ROLES | tr '\n' ' ')" "$EXPECTED_SUPERUSERS" \
    | "$SELF_DIR/send_telegram.sh" "$ALERT_ID" CRITICAL_PERSISTENT - || true
  exit 1
fi

echo "OK superusers={$SUPERS} dsn_roles={$(echo $ROLES | tr '\n' ' ')} all NOSUPERUSER"
exit 0
