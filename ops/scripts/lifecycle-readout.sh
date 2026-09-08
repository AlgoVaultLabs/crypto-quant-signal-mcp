#!/usr/bin/env bash
# ops/scripts/lifecycle-readout.sh — IDENTITY-LIFECYCLE-W3 CH2 R2. READ-ONLY operator readout.
#
# Prints the per-step shadow table and one tri-state verdict. It MUTATES NOTHING: no flip, no
# rollback, no ledger write. `ops/cron/lifecycle-readout.sh` is the deciding half, and the two are
# separated so an operator can look at the numbers without any chance of causing a send.
#
#   LIFECYCLE_READOUT_VERDICT=PASS|FAIL|INDETERMINATE  ->  exit 0 | 1 | 3
#   FAIL is reserved for DUPLICATES, which are structurally impossible while the ledger's
#   UNIQUE(recipient_id, step, period_key) holds — so a FAIL here means that constraint is gone.
set -uo pipefail
CTR="${LIFECYCLE_APP_CTR:-crypto-quant-signal-mcp-mcp-server-1}"
TAG="[lifecycle-readout]"
if ! docker inspect -f '{{.State.Running}}' "$CTR" 2>/dev/null | grep -q true; then
  echo "$TAG LIFECYCLE_READOUT_VERDICT=INDETERMINATE container $CTR is not running — nothing was read"
  exit 3
fi
OUT="$(docker exec "$CTR" node dist/scripts/lifecycle-readout.js --report 2>&1)"; RC=$?
printf '%s\n' "$OUT"
TOKEN="$(printf '%s\n' "$OUT" | sed -n 's/.*LIFECYCLE_READOUT_VERDICT=\([A-Z]*\).*/\1/p' | tail -1)"
case "$TOKEN" in
  PASS) exit 0 ;;
  FAIL) exit 1 ;;
  INDETERMINATE) exit 3 ;;
  *) echo "$TAG LIFECYCLE_READOUT_VERDICT=INDETERMINATE no token in output (rc=$RC)"; exit 3 ;;
esac
