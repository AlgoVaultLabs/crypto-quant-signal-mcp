#!/usr/bin/env bash
# ads1-amend-gate.sh — EDGE-ADS1-SCORECARD-W1-V3 CH3-A: the pre-read amendment of the ADS-1 registration.
#
# A registration admits ONE amendment (registration §10, "Ordering"), so the amendment is the last change to it and
# this gate proves nothing else moved. Every leg is a function of a TREE ROOT, so --self-test runs the SAME leg code
# on a mutated copy of this tree (the seam is the tree, never the predicate).
#
#   GREEN iff  build   `npm run build && npm run build:knowledge` exit 0 (deploy.yml's order: the suite reads the
#                     knowledge bundle, so a gate that deletes dist/ and skips it reports a false RED)
#          ∧  suite   the full vitest suite → scripts/classify-suite-verdict.mjs → SUITE_VERDICT ∈ {PASS, PASS_AFTER_ISOLATION}
#          ∧  shape   the registration's `## ` heading list is EXACTLY the landed list (§1–§9, each once, in order)
#                     followed by ONE `## 10. Amendment <date> — …` heading and ONE `## Identifiability` heading
#          ∧  diff    `6d43486c:<registration>` → the working copy is PURE INSERTION: one tail hunk after the last
#                     original line that opens with the amendment heading and carries no `## ` heading but that one and
#                     a single `## Identifiability`, plus exactly two interior hunks, both inside
#                     §3, each adding only the one-line `_Superseded by §10 (amendment <date>) — kept for the record._`
#                     pointer and blank lines (a line-range check on the hunk headers, not a grep) — so §1, §2, §4–§9
#                     are byte-identical by construction
#          ∧  literal no `floor0.30-v1` in src/scripts/ads1/ or src/scripts/ads1-scorecard.ts
#          ∧  grandf. the §4c IDENT_GRANDFATHERED map carries no row for the registration
#          ∧  4c      the §4c gate (vitest, `PROCEDURE §4c` block of the stress-test suite) passes on this tree
#          ∧  pin     the ADS-1 pin + lock suites (ads1-scorecard, ads1-spec-lock) pass on this tree
#          ∧  mirror  the vault mirror's `_verify.sh` prints PREREG_MIRROR_VERDICT=PASS
#          ∧  (--post-landing <sha>) <sha> is an ancestor of origin/main AND INTRODUCES the amendment (its copy of the
#                     registration carries one `## <n>. Amendment` heading, its parent's none) AND the vault
#                     status.md carries `AMENDMENT_SHA=<sha>` AND the mirror carries the registration's blob at origin/main
#
# Verdict — exactly one terminal line, the token is the contract (callers gate on the TOKEN, never the code):
#   CH3A_GREEN          exit 0
#   CH3A_RED            exit 1   any leg failed
#   CH3A_INDETERMINATE  exit 3   a tool, the mirror verifier or status.md is missing, or a leg printed no verdict
#
# A committed bash script on purpose (the agent tool shell is zsh: ${PIPESTATUS[0]} is empty there and fails open).
# Here-strings, never `printf | grep -q` under pipefail (grep -q exits early → SIGPIPE → a false miss).
#
# Usage:  scripts/gates/ads1-amend-gate.sh                    (pre-landing)
#         scripts/gates/ads1-amend-gate.sh --post-landing <sha>
#         scripts/gates/ads1-amend-gate.sh --self-test        (8 mutations, each RED, + controls)
set -uo pipefail

REG='audits/ads1-scorecard-preregistration-2026-09-27.md'
REG_COMMIT='6d43486c'
STRESS='tests/unit/preregistration-support-stress-test.test.ts'
POINTER_RE='^_Superseded by §10 \(amendment [0-9]{4}-[0-9]{2}-[0-9]{2}\) — kept for the record\._$'
REQUIRED_TOOLS=(git node npm npx python3 awk grep sed)

log() { printf '[ads1-amend-gate] %s\n' "$*" >&2; }

# ── legs: each prints ONE line — "OK" | "RED <why>" | "IND <why>" ────────────────────────────────────────────

# leg_shape <root> <base-file> — the `## ` heading list is the landed list + exactly the two admitted headings
leg_shape() {
  local f="$1/$REG" n_am n_id cur want nb nc tail2
  [ -r "$f" ] && [ -r "$2" ] || { echo "IND registration-unreadable"; return; }
  n_am="$(grep -cE '^## [0-9]+\. Amendment ' "$f")"
  n_id="$(grep -cE '^## Identifiability$' "$f")"
  [ "$n_am" -eq 1 ] || { echo "RED amendment-headings:$n_am"; return; }
  [ "$n_id" -eq 1 ] || { echo "RED identifiability-headings:$n_id"; return; }
  want="$(grep -E '^## ' "$2")"; cur="$(grep -E '^## ' "$f")"
  nb="$(grep -c . <<<"$want")"; nc="$(grep -c . <<<"$cur")"
  [ "$nc" -eq $((nb + 2)) ] || { echo "RED heading-count:$nc-want-$((nb + 2))"; return; }
  [ "$(head -n "$nb" <<<"$cur")" = "$want" ] || { echo "RED landed-headings-changed"; return; }
  tail2="$(tail -n 2 <<<"$cur")"
  grep -qE '^## 10\. Amendment [0-9]{4}-[0-9]{2}-[0-9]{2} — ' <<<"$(head -n 1 <<<"$tail2")" || { echo "RED amendment-not-11th-heading"; return; }
  [ "$(tail -n 1 <<<"$tail2")" = '## Identifiability' ] || { echo "RED identifiability-not-last-heading"; return; }
  echo OK
}

# leg_diff <root> <base-file>   (base = the registration as landed at REG_COMMIT)
leg_diff() {
  local cur="$1/$REG" base="$2" lines s3 s4
  [ -r "$cur" ] && [ -r "$base" ] || { echo "IND diff-input-unreadable"; return; }
  lines="$(wc -l < "$base" | tr -d ' ')"
  s3="$(grep -nE '^## 3\. ' "$base" | head -n 1 | cut -d: -f1)"
  s4="$(grep -nE '^## 4\. ' "$base" | head -n 1 | cut -d: -f1)"
  [ -n "$s3" ] && [ -n "$s4" ] || { echo "IND base-has-no-section-3-or-4"; return; }
  # the pointer regex reaches awk through ENVIRON, never `-v` (awk -v rewrites the backslash escapes in it)
  git diff --no-index -U0 --no-color -- "$base" "$cur" 2>/dev/null | ADS1_POINTER_RE="$POINTER_RE" awk -v n="$lines" -v s3="$s3" -v s4="$s4" '
    function flush() {
      if (!inh) return
      if (tail) {
        if (first != "amendment") bad = bad " tail-does-not-open-with-the-amendment"
        if (thead != 0) bad = bad " tail-carries-" thead "-foreign-heading(s)"
        if (tid != 1) bad = bad " tail-identifiability-headings:" tid
      }
      else {
        if (ptrs != 1) bad = bad " interior-hunk@" a ":pointers=" ptrs
        if (other) bad = bad " interior-hunk@" a ":foreign-line"
        if (!(a >= s3 && a < s4)) bad = bad " interior-hunk@" a ":outside-section-3"
        interior++
      }
      inh = 0
    }
    /^@@ / {
      flush()
      split($2, o, ","); split($3, w, ",")
      a = substr(o[1], 2) + 0; b = (o[2] == "" ? 1 : o[2] + 0)
      if (b != 0) bad = bad " removes-or-changes-base-line@" a
      inh = 1; tail = (a == n); first = ""; ptrs = 0; other = 0; thead = 0; tid = 0; tam = 0
      next
    }
    inh && /^-/ { bad = bad " removed-line"; next }
    inh && /^\+/ {
      t = substr($0, 2)
      if (tail) {
        if (first == "" && t != "") first = (t ~ /^## 10\. Amendment [0-9]{4}-[0-9]{2}-[0-9]{2} — /) ? "amendment" : "other"
        if (t ~ /^## /) {
          if (t == "## Identifiability") tid++
          else if (t ~ /^## 10\. Amendment [0-9]{4}-[0-9]{2}-[0-9]{2} — / && tam == 0) tam++
          else thead++
        }
      }
      else if (t ~ ENVIRON["ADS1_POINTER_RE"]) ptrs++
      else if (t != "") other = 1
      next
    }
    END {
      flush()
      if (interior != 2) bad = bad " interior-hunks:" interior
      if (bad != "") print "RED" bad; else print "OK"
    }'
}

# leg_literal <root>
leg_literal() {
  local hits
  [ -d "$1/src/scripts/ads1" ] || { echo "IND no-ads1-source"; return; }
  hits="$(grep -rlE 'floor0\.30-v1' "$1/src/scripts/ads1" "$1/src/scripts/ads1-scorecard.ts" 2>/dev/null | wc -l | tr -d ' ')"
  [ "$hits" -eq 0 ] && echo OK || echo "RED v1-literal-in:$hits-file(s)"
}

# leg_grandfather <root>
leg_grandfather() {
  local f="$1/$STRESS" block
  [ -r "$f" ] || { echo "IND stress-test-unreadable"; return; }
  block="$(awk '/^export const IDENT_GRANDFATHERED/{on=1} on{print} on && /^\]\);/{exit}' "$f")"
  [ -n "$block" ] || { echo "IND no-IDENT_GRANDFATHERED-map"; return; }
  if grep -qF "'$REG'" <<<"$block"; then echo "RED registration-still-grandfathered"; else echo OK; fi
}

# vitest_leg <root> <label> <vitest args…> — PASS iff the summary line shows ≥ 1 passed and none failed
vitest_leg() {
  local root="$1" label="$2" out summary; shift 2
  out="$(cd "$root" && npx vitest run "$@" </dev/null 2>&1)"
  summary="$(grep -E '^[[:space:]]+Tests[[:space:]]' <<<"$out" | tail -n 1)"
  [ -n "$summary" ] || { echo "IND $label:no-summary"; return; }
  if grep -qE '[0-9]+ failed' <<<"$summary"; then echo "RED $label:$(tr -s ' ' <<<"$summary" | sed 's/^ //')"; return; fi
  grep -qE '[1-9][0-9]* passed' <<<"$summary" && echo OK || echo "IND $label:nothing-passed"
}
leg_4c() { vitest_leg "$1" 4c "$STRESS" -t 'PROCEDURE §4c'; }
leg_pin() { vitest_leg "$1" pin tests/unit/ads1-scorecard.test.ts tests/unit/ads1-spec-lock.test.ts; }

# leg_mirror <verify.sh> [<registration basename> <blob>]
leg_mirror() {
  local v="$1" out tok row
  [ -r "$v" ] || { echo "IND mirror-verifier-missing"; return; }
  out="$(bash "$v" 2>/dev/null)"
  tok="$(grep -E '^PREREG_MIRROR_VERDICT=' <<<"$out" | tail -n 1 | sed 's/^PREREG_MIRROR_VERDICT=//')"
  case "$tok" in
    PASS) ;;
    FAIL) echo "RED mirror-verdict:FAIL"; return ;;
    *) echo "IND mirror-verdict:${tok:-none}"; return ;;
  esac
  if [ -n "${2:-}" ]; then
    row="$(grep -F "$2|registration|" "$v" | grep -v '^[[:space:]]*#' | tail -n 1)"
    case "$row" in
      "$2|registration|$3|"*) ;;
      *) echo "RED mirror-does-not-carry-the-landed-blob"; return ;;
    esac
  fi
  echo OK
}

# leg_post <gitroot> <sha> <status.md>
leg_post() {
  local root="$1" sha="$2" status="$3" body
  [ -r "$status" ] || { echo "IND status-md-unreadable"; return; }
  git -C "$root" cat-file -e "$sha^{commit}" 2>/dev/null || { echo "IND sha-unknown:$sha"; return; }
  git -C "$root" merge-base --is-ancestor "$sha" origin/main 2>/dev/null || { echo "RED not-on-origin/main"; return; }
  local here before
  here="$(git -C "$root" show "$sha:$REG" 2>/dev/null | grep -cE '^## [0-9]+\. Amendment ')"
  before="$(git -C "$root" show "$sha^:$REG" 2>/dev/null | grep -cE '^## [0-9]+\. Amendment ')"
  [ "${here:-0}" -eq 1 ] && [ "${before:-0}" -eq 0 ] || { echo "RED sha-does-not-introduce-the-amendment($here/$before)"; return; }
  body="$(cat "$status")"
  grep -qF "AMENDMENT_SHA=$sha" <<<"$body" || { echo "RED status-md-lacks-AMENDMENT_SHA=$sha"; return; }
  echo OK
}

# decide <name=leg-line>… → the token; RED outranks INDETERMINATE
decide() {
  local red="" ind="" kv name leg
  for kv in "$@"; do
    name="${kv%%=*}"; leg="${kv#*=}"
    case "$leg" in
      OK) ;;
      RED*) red="$red $name(${leg#RED })" ;;
      *) ind="$ind $name(${leg#IND })" ;;
    esac
  done
  if [ -n "$red" ]; then log "RED:$red${ind:+ (also unverified:$ind)}"; echo CH3A_RED; return 1; fi
  if [ -n "$ind" ]; then log "cannot verify:$ind"; echo CH3A_INDETERMINATE; return 3; fi
  log "every leg passed"
  echo CH3A_GREEN; return 0
}

vault_root() { # the ONE declaration of the vault root (scripts/lib/system-map-path.sh), never a second literal
  local lib="$1/scripts/lib/system-map-path.sh"
  [ -r "$lib" ] || return 1
  # shellcheck source=/dev/null
  (. "$lib" && dirname "$ALGOVAULT_SYSTEM_MAP_PATH")
}

run_gate() {
  local t post="" root vroot tmp
  for t in "${REQUIRED_TOOLS[@]}"; do
    command -v "$t" >/dev/null 2>&1 || { log "required tool '$t' not on PATH"; echo CH3A_INDETERMINATE; exit 3; }
  done
  if [ "${1:-}" = "--post-landing" ]; then
    post="${2:-}"; [ -n "$post" ] || { log "--post-landing needs <sha>"; echo CH3A_INDETERMINATE; exit 3; }
  elif [ -n "${1:-}" ]; then log "unknown argument '$1'"; echo CH3A_INDETERMINATE; exit 3; fi
  root="$(git rev-parse --show-toplevel 2>/dev/null)" || { log "not inside a git checkout"; echo CH3A_INDETERMINATE; exit 3; }
  cd "$root" || { echo CH3A_INDETERMINATE; exit 3; }
  vroot="$(vault_root "$root")" || { log "cannot resolve the vault root"; echo CH3A_INDETERMINATE; exit 3; }
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/ads1-amend-gate.XXXXXX")" || { echo CH3A_INDETERMINATE; exit 3; }
  git show "$REG_COMMIT:$REG" > "$tmp/base.md" 2>/dev/null || { log "cannot read $REG_COMMIT:$REG"; echo CH3A_INDETERMINATE; exit 3; }

  local build suite="" report
  rm -rf dist
  if { npm run build && npm run build:knowledge; } >"$tmp/build.log" 2>&1; then build=OK; else build="RED build-failed"; fi
  if [ "$build" = OK ]; then
    report="$tmp/report.json"
    npx vitest run --reporter=default --reporter=json --outputFile="$report" \
      --reporter=./scripts/vitest-error-shape-reporter.mjs </dev/null >"$tmp/vitest.log" 2>&1 || true
    mv -f .vitest-error-shapes.json "$tmp/shapes.json" 2>/dev/null || true
    suite="$(node scripts/classify-suite-verdict.mjs "$report" --sidecar="$tmp/shapes.json" 2>/dev/null \
      | grep -E '^SUITE_VERDICT=' | tail -n 1 | sed 's/^SUITE_VERDICT=//')"
  fi
  case "$suite" in
    PASS|PASS_AFTER_ISOLATION) suite=OK ;;
    FAIL) suite="RED SUITE_VERDICT=FAIL" ;;
    *) suite="IND SUITE_VERDICT=${suite:-none}" ;;
  esac
  local mirror post_leg=OK
  if [ -n "$post" ]; then
    git fetch origin --quiet 2>/dev/null || log "git fetch failed — using the cached origin/main"
    post_leg="$(leg_post "$root" "$post" "$vroot/status.md")"
    mirror="$(leg_mirror "$vroot/Claude files/repo-preregistrations/_verify.sh" "$(basename "$REG")" "$(git rev-parse "origin/main:$REG" 2>/dev/null)")"
  else
    mirror="$(leg_mirror "$vroot/Claude files/repo-preregistrations/_verify.sh")"
  fi
  local rc
  decide build="$build" suite="$suite" shape="$(leg_shape "$root" "$tmp/base.md")" diff="$(leg_diff "$root" "$tmp/base.md")" \
    literal="$(leg_literal "$root")" grandfather="$(leg_grandfather "$root")" 4c="$(leg_4c "$root")" \
    pin="$(leg_pin "$root")" mirror="$mirror" post="$post_leg"
  rc=$?
  if [ "$rc" -eq 0 ]; then rm -rf "$tmp"; else log "evidence kept: $tmp"; fi
  exit "$rc"
}

self_test() {
  local root tmp tree pass=0 fail=0 cases=0
  root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)" || { echo "ADS1_AMEND_GATE_SELFTEST: FAIL not in a checkout"; exit 1; }
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/ads1-amend-selftest.XXXXXX")" || { echo "ADS1_AMEND_GATE_SELFTEST: FAIL mktemp"; exit 1; }
  trap 'rm -rf "$tmp"' EXIT
  tree="$tmp/tree"
  # The REAL legs run on a copy of this tree (tracked + working-copy files; deps shared read-only).
  mkdir -p "$tree"
  # (node_modules and dist are git-ignored, so neither is listed; deps are then shared read-only by symlink)
  (cd "$root" && git ls-files -co --exclude-standard -z > "$tmp/files.z" && rsync -a --from0 --files-from="$tmp/files.z" ./ "$tree/") || { echo "ADS1_AMEND_GATE_SELFTEST: FAIL tree copy"; exit 1; }
  # the copy is a git INDEX too: suites that enumerate their corpus with `git ls-files` (the population-comparison
  # registry scan inside the §4c block) must see the same file set here as in the checkout
  git -C "$tree" init -q && git -C "$tree" update-index --add -z --stdin < "$tmp/files.z" || { echo "ADS1_AMEND_GATE_SELFTEST: FAIL tree index"; exit 1; }
  ln -s "$root/node_modules" "$tree/node_modules"
  git -C "$root" show "$REG_COMMIT:$REG" > "$tmp/base.md" || { echo "ADS1_AMEND_GATE_SELFTEST: FAIL no base"; exit 1; }
  [ -r "$tree/$REG" ] && [ -r "$tree/$STRESS" ] || { echo "ADS1_AMEND_GATE_SELFTEST: FAIL the tree copy is incomplete"; exit 1; }

  check() { # <name> <want token> <decide args…>
    local name="$1" want="$2" out; shift 2
    out="$(decide "$@" 2>/dev/null)"
    cases=$((cases + 1))
    if [ "$out" = "$want" ]; then pass=$((pass + 1)); echo "SELF-TEST: ok $name"
    else fail=$((fail + 1)); echo "SELF-TEST: FAIL $name (got '$out', want '$want')"; fi
  }
  leg_is() { # <name> <want prefix> <leg line>
    cases=$((cases + 1))
    case "$3" in "$2"*) pass=$((pass + 1)); echo "SELF-TEST: ok $1 ($3)" ;; *) fail=$((fail + 1)); echo "SELF-TEST: FAIL $1 (leg said '$3', want '$2…')" ;; esac
  }
  # mutate <file> <python body over s> — a scoped edit of the tree copy; restore with `restore <file>`
  mutate() { cp "$tree/$1" "$tmp/bak"; python3 - "$tree/$1" "$2" <<'PY'
import sys
p, body = sys.argv[1], sys.argv[2]
s = open(p, encoding='utf-8').read()
ns = {'s': s}
exec(body, ns)
assert ns['s'] != s, 'mutation changed nothing'
open(p, 'w', encoding='utf-8').write(ns['s'])
PY
  }
  restore() { cp "$tmp/bak" "$tree/$1"; }

  local ok_mirror="$tmp/ok/_verify.sh" bad_mirror="$tmp/bad/_verify.sh"
  mkdir -p "$tmp/ok" "$tmp/bad"
  printf 'echo PREREG_MIRROR_VERDICT=PASS\n' > "$ok_mirror"; printf 'echo PREREG_MIRROR_VERDICT=FAIL\n' > "$bad_mirror"
  local G=(build=OK suite=OK)

  # ── controls: the unmutated tree passes every tree leg (proves no leg is vacuously RED)
  local s d l g c p
  s="$(leg_shape "$tree" "$tmp/base.md")"; d="$(leg_diff "$tree" "$tmp/base.md")"; l="$(leg_literal "$tree")"; g="$(leg_grandfather "$tree")"
  c="$(leg_4c "$tree")"; p="$(leg_pin "$tree")"
  leg_is control-shape OK "$s"; leg_is control-diff OK "$d"; leg_is control-literal OK "$l"; leg_is control-grandfather OK "$g"
  leg_is control-4c OK "$c"; leg_is control-pin OK "$p"
  check control-all-green CH3A_GREEN "${G[@]}" shape="$s" diff="$d" literal="$l" grandfather="$g" 4c="$c" pin="$p" mirror="$(leg_mirror "$ok_mirror")" post=OK

  # ── the 8 registered mutations, each through the REAL leg, each RED
  mutate "$REG" "i = s.index('\n## 7. '); j = s.index('\n', i + 5) + 1; s = s[:j] + s[j:].replace('- ', '- (edited) ', 1)"
  check m1-hunk-in-section-7 CH3A_RED "${G[@]}" diff="$(leg_diff "$tree" "$tmp/base.md")"; restore "$REG"

  mutate "$REG" "s = s + '\n## 11. Amendment 2026-10-03 — a second one\n'"
  check m2-second-amendment-heading CH3A_RED "${G[@]}" shape="$(leg_shape "$tree" "$tmp/base.md")"; restore "$REG"

  mutate src/scripts/ads1/spec.ts "s = s + \"\n// 'tau1.0-floor0.30-v1'\n\""
  check m3-surviving-v1-literal CH3A_RED "${G[@]}" literal="$(leg_literal "$tree")"; restore src/scripts/ads1/spec.ts

  mutate "$STRESS" "k = 'export const IDENT_GRANDFATHERED: ReadonlyMap<string, string> = new Map([\n'; s = s.replace(k, k + \"  ['$REG', 'landed 2026-09-27 by EDGE-ADS1-SCORECARD-W1-V2, before §4c existed; restored by the self-test mutation'],\n\", 1)"
  g="$(leg_grandfather "$tree")"; c="$(leg_4c "$tree")"
  leg_is m4-grandfather-leg-red RED "$g"
  leg_is m4-grandfather-row-restored-4c-also-red RED "$c"
  check m4-grandfather-row-restored CH3A_RED "${G[@]}" grandfather="$g" 4c="$c"; restore "$STRESS"

  mutate "$REG" "i = s.index('\n## Identifiability\n'); s = s[:i] + s[i:].replace('| 20.0 |', '| 30.0 |', 1)"
  check m5-4c-bound-misstated CH3A_RED "${G[@]}" 4c="$(leg_4c "$tree")"; restore "$REG"

  mutate "$REG" "i = s.index('\n## 10. Amendment '); j = s.index('ORDER BY s.id\n', i); s = s[:j] + 'ORDER BY s.id DESC\n' + s[j + len('ORDER BY s.id\n'):]"
  check m6-pinned-sql-altered CH3A_RED "${G[@]}" pin="$(leg_pin "$tree")"; restore "$REG"

  check m7-stale-mirror CH3A_RED "${G[@]}" mirror="$(leg_mirror "$bad_mirror")"

  # m9: a re-stated §7 appended after ## Identifiability — invisible to a byte check of §4–§8, caught by the heading
  # list (shape) and by the tail's heading constraint (diff), each on its own
  mutate "$REG" "s = s + '\n## 7. Declared expectations (restated)\n\n- every unit is expected CREDIBLE.\n'"
  leg_is m9-restated-section-shape-red RED "$(leg_shape "$tree" "$tmp/base.md")"
  leg_is m9-restated-section-diff-red RED "$(leg_diff "$tree" "$tmp/base.md")"; restore "$REG"
  # m11: a landed heading renamed (count unchanged) — the shape leg's landed-list comparison alone sees it
  mutate "$REG" "s = s.replace('\n## 7. Declared expectations', '\n## 7. Declared expectations (renamed)', 1)"
  leg_is m11-landed-heading-renamed-shape-red 'RED landed-headings-changed' "$(leg_shape "$tree" "$tmp/base.md")"; restore "$REG"
  # m10: a pointer moved from §3.1 into §7 (still two interior hunks) — only the §3 line-range check can see it
  mutate "$REG" "p = '_Superseded by §10'; i = s.rindex('\n\n' + p, 0, s.index('\n## 4. ')); j = s.index('\n', i + 2); line = s[i + 2:j]; s = s[:i] + s[j:]; k = s.index('\n', s.index('\n## 7. ') + 1); s = s[:k] + '\n\n' + line + s[k:]"
  leg_is m10-pointer-outside-section-3-red 'RED interior-hunk' "$(leg_diff "$tree" "$tmp/base.md")"; restore "$REG"

  # m8 + leg_post controls, HERMETIC: a synthetic repo with an origin/main ref — registration, then the amendment
  local srepo="$tmp/srepo" sreg sam
  mkdir -p "$srepo/$(dirname "$REG")"
  sgc() { GIT_AUTHOR_DATE="@$1 +0000" GIT_COMMITTER_DATE="@$1 +0000" git -C "$srepo" -c user.name=t -c user.email=t@t commit -q -m "$2"; }
  git -C "$srepo" init -q -b main
  printf '## 9. x\n' > "$srepo/$REG"; git -C "$srepo" add "$REG"; sgc 1790000000 registration
  printf '\n## 10. Amendment 2026-10-02 — synthetic\n' >> "$srepo/$REG"; git -C "$srepo" add "$REG"; sgc 1790000100 amendment
  git -C "$srepo" update-ref refs/remotes/origin/main HEAD
  sreg="$(git -C "$srepo" rev-parse HEAD~1)"; sam="$(git -C "$srepo" rev-parse HEAD)"
  printf 'register row … AMENDMENT_SHA=%s\n' "$sam" > "$tmp/status-with.md"; printf 'no amendment line here\n' > "$tmp/status-without.md"
  leg_is control-post-ok OK "$(leg_post "$srepo" "$sam" "$tmp/status-with.md")"
  check m8-sha-absent-from-status CH3A_RED "${G[@]}" post="$(leg_post "$srepo" "$sam" "$tmp/status-without.md")"
  # the status line names the registration commit, so only the introduce-check can refuse it
  printf 'register row … AMENDMENT_SHA=%s\n' "$sreg" > "$tmp/status-reg.md"
  leg_is m8b-registration-commit-is-not-the-amendment 'RED sha-does-not-introduce' "$(leg_post "$srepo" "$sreg" "$tmp/status-reg.md")"

  # ── INDETERMINATE: cannot verify ≠ verified clean
  check ind-mirror-verifier-missing CH3A_INDETERMINATE "${G[@]}" mirror="$(leg_mirror "$tmp/nowhere/_verify.sh")"
  check ind-status-missing CH3A_INDETERMINATE "${G[@]}" post="$(leg_post "$srepo" "$sam" "$tmp/nowhere/status.md")"
  check red-outranks-indeterminate CH3A_RED "${G[@]}" mirror="IND x" diff="RED y"
  # the missing-tool precondition, through the real entry point with a PATH that holds only bash
  ln -s "$(command -v bash)" "$tmp/bash"
  local out rc errtxt
  errtxt="$(env PATH="$tmp" "$tmp/bash" "${BASH_SOURCE[0]}" 2>&1 >/dev/null)"
  out="$(env PATH="$tmp" "$tmp/bash" "${BASH_SOURCE[0]}" 2>/dev/null)"; rc=$?
  cases=$((cases + 1))
  if [ "$out" = CH3A_INDETERMINATE ] && [ "$rc" -eq 3 ] && grep -q "required tool 'git'" <<<"$errtxt"; then
    pass=$((pass + 1)); echo "SELF-TEST: ok missing-tool-indeterminate"
  else fail=$((fail + 1)); echo "SELF-TEST: FAIL missing-tool-indeterminate (got '$out' rc=$rc)"; fi

  if [ "$cases" -lt 27 ]; then echo "ADS1_AMEND_GATE_SELFTEST: FAIL vacuous ($cases cases)"; exit 1; fi
  if [ "$fail" -eq 0 ]; then echo "ADS1_AMEND_GATE_SELFTEST: PASS ($pass checks)"; exit 0; fi
  echo "ADS1_AMEND_GATE_SELFTEST: FAIL ($fail of $cases)"; exit 1
}

# sourceable: when sourced, define the legs and decide() and stop (no gate run)
if (return 0 2>/dev/null); then return 0; fi
if [ "${1:-}" = "--self-test" ]; then self_test; fi
run_gate "$@"
