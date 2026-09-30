#!/usr/bin/env bash
# OPS-ADAPTER-HISTORY-ANCHOR-W1 CH1 — second-vantage replay of the adapter-recorded requests (read-only public klines).
# One sequential lane per venue host (>= 2 s apart; HL 3 s; WEEX 5 s); lanes run side by side.
set -uo pipefail
IN="$1"; D="$2"; rm -rf "$D"; mkdir -p "$D/b"
lane() {
  local host="$1" gap=2
  case "$host" in *weex*) gap=5;; *hyperliquid*) gap=3;; esac
  awk -F'\t' -v h="$host" '$2==h' "$IN" | while IFS=$'\t' read -r id h method url b64; do
    sleep "$gap"
    if [ "$method" = "POST" ]; then
      code=$(printf '%s' "$b64" | base64 -d | curl -sS -m 25 -X POST -H 'content-type: application/json' --data-binary @- -o "$D/b/$id" -w '%{http_code}' "$url" 2>"$D/b/$id.err"); rc=$?
    else
      code=$(curl -sS -m 25 -o "$D/b/$id" -w '%{http_code}' "$url" 2>"$D/b/$id.err"); rc=$?
    fi
    printf '%s\t%s\t%s\t%s\n' "$id" "$code" "$rc" "$(date -u +%s%3N 2>/dev/null || date -u +%s000)" >> "$D/manifest.$host.tsv"
  done
}
for host in $(cut -f2 "$IN" | sort -u); do lane "$host" & done
wait
cat "$D"/manifest.*.tsv > "$D/manifest.tsv"
echo "done $(wc -l < "$D/manifest.tsv")"
