#!/usr/bin/env bash
# wave-history-build.sh — OPS-HOST-KERNEL-REBOOT-W5 CH2.
#
# THE ONE DERIVATION of "which waves have already shipped", as host consumers see it.
#
# ── THE BUG CLASS THIS RETIRES ──────────────────────────────────────────────────────────────
# Every host consumer that answers "what has already shipped" — send_telegram.sh's
# resolve_template() (`OPS-<CLASS>-W{NEXT}` -> W<max GREEN + 1>), decision-gate-orphan-canary.py's
# `status_md_entry` retirement trigger, recommendation-drift-canary.py's highest-GREEN scan — read
# `/var/lib/algovault-monitoring/status.md`, the copy monitoring-results-sync.sh pushes. Since trim
# policy v3 (trim-status-config.md, 2026-08-12) that file is OPEN WAVES ONLY: a closed GREEN wave
# is archived to `Old Status/` the moment it closes. The resolver was searching for exactly the
# records the policy removes. MEASURED 2026-10-02 over the 108 templated classes in this repo:
# host status.md resolves 1; status.md ∪ AOE-status.md ∪ Old Status/Status *.md resolves 21.
# The KERNEL_STALENESS page that morning shipped `OPS-HOST-KERNEL-REBOOT-W{NEXT}` verbatim — the
# second consecutive page of that class to do so — while W1..W4 sat GREEN in the archive.
#
# ── WHY HERE ────────────────────────────────────────────────────────────────────────────────
# Only the vault side sees the whole ledger, and monitoring-results-sync.sh already runs at
# CLAUDE.md execution-flow step 6 of EVERY wave. So the corpus is derived ONCE, here, and pushed;
# consumers read `status.md ∪ wave-history.md` with their EXISTING predicate unchanged. Trim
# policy v3 is untouched — making a Cowork skill's trim load-bearing for host alerting, or
# re-bloating the working set, were both rejected. Headings only: every consumer reads `### `
# lines, so the ~7.5 MB of entry bodies stays in the vault (minimise the data).
#
# ── SOURCES ARE READ FROM THE TRIM'S OWN SoT, NEVER A SECOND LITERAL GLOB ─────────────────
# trim-status-config.md declares where history lives: `## STATUS_FILE`, `## ARCHIVE_DIR`,
# `## ARCHIVE_FILENAME_PATTERN` and the `## SPLIT_FILES` table. A literal `Old Status/Status *.md`
# here would be a duplicated fact that goes stale the day the trim renames anything.
#
# ── OUTPUT ──────────────────────────────────────────────────────────────────────────────────
# Every `^### ` line of every source, VERBATIM, de-duplicated on the FULL line (two headings that
# differ by one character are two records), behind a generated `<!-- … -->` header naming the
# generator, the UTC time, and each source's sha256 + heading count. No header line starts with
# `### `, so no consumer predicate can match the header.
#
# ── VERDICT — the vacuity guard sits where the corpus is CONSTRUCTED ───────────────────────
#   WAVE_HISTORY_VERDICT=PASS            exit 0   written, re-read, counts verified
#   WAVE_HISTORY_VERDICT=FAIL            exit 1   zero headings across every source, or the written
#                                                 file's heading count != the de-duplicated union,
#                                                 or < status.md's own (unique) count
#   WAVE_HISTORY_VERDICT=INDETERMINATE   exit 3   config unreadable / a section missing / an unknown
#                                                 pattern placeholder / a DECLARED source absent / a
#                                                 source present but unparseable (NUL byte, not UTF-8)
# Input we were HANDED and could not parse is INDETERMINATE, always. The output file is written
# to `<out>.tmp` and renamed only on PASS, so a non-PASS run never replaces a good corpus.
#
# Usage:
#   wave-history-build.sh --out <path> [--vault <dir>] [--config <path>]
#   wave-history-build.sh --self-test        # hermetic: fixture vault in a temp dir
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
SELF="$HERE/$(basename "${BASH_SOURCE[0]}")"

# ── the pure core: one python program, two modes ────────────────────────────────────────────
#   build  <vault> <config> <out>
#   verify <out> <expected_union> <status_unique>     (the artifact check, reachable on its own so
#                                                      the self-test can drive it with a doctored file)
core() {
  python3 - "$@" <<'PY'
import datetime, hashlib, os, re, sys

EXIT = {"PASS": 0, "FAIL": 1, "INDETERMINATE": 3}
MONTHS = ("January|February|March|April|May|June|July|August|September|October|November|"
          "December")
PLACEHOLDERS = {"Month": "(?:%s)" % MONTHS, "Year": "[0-9]{4}"}

def done(verdict, notes):
    for n in notes:
        print("  " + n)
    print("WAVE_HISTORY_VERDICT=" + verdict)
    sys.exit(EXIT[verdict])

def headings(text):
    return [l.rstrip("\r") for l in text.split("\n") if l.startswith("### ")]

def verify(out, expected, status_unique, notes):
    """Re-read what was WRITTEN and count it. The in-memory list is not the artifact."""
    try:
        with open(out, encoding="utf-8") as fh:
            got = headings(fh.read())
    except Exception as e:  # noqa: BLE001
        notes.append("verify: cannot re-read %s: %s" % (out, e))
        return "FAIL"
    notes.append("verify: %s holds %d heading(s), %d distinct; expected %d; status.md unique %d"
                 % (out, len(got), len(set(got)), expected, status_unique))
    if expected <= 0 or len(got) == 0:
        notes.append("verify: ZERO headings — a corpus that says nothing has shipped is a lie")
        return "FAIL"
    if len(got) != expected or len(set(got)) != expected:
        notes.append("verify: written heading count != de-duplicated union")
        return "FAIL"
    if len(got) < status_unique:
        notes.append("verify: fewer headings than status.md alone carries")
        return "FAIL"
    return "PASS"

def section(text, name):
    """Body of `## NAME` up to the next `## `; None when the section is absent."""
    lines, out, on = text.split("\n"), [], False
    for l in lines:
        if l.startswith("## "):
            if on:
                break
            on = l[3:].strip() == name
            continue
        if on:
            out.append(l)
    return None if not on and not out else out

def first_value(text, name, notes):
    body = section(text, name)
    vals = [l.strip() for l in (body or []) if l.strip()]
    if not vals:
        notes.append("config: section `## %s` is missing or empty" % name)
        return None
    return vals[0]

def safe_rel(p):
    return p and not os.path.isabs(p) and ".." not in p.replace("\\", "/").split("/")

def build(vault, cfg, out):
    notes = []
    try:
        with open(cfg, encoding="utf-8") as fh:
            ctext = fh.read()
    except Exception as e:  # noqa: BLE001
        done("INDETERMINATE", ["config unreadable: %s: %s" % (cfg, e)])
    status_file = first_value(ctext, "STATUS_FILE", notes)
    archive_dir = first_value(ctext, "ARCHIVE_DIR", notes)
    pattern = first_value(ctext, "ARCHIVE_FILENAME_PATTERN", notes)
    split_body = section(ctext, "SPLIT_FILES")
    split = []
    for l in split_body or []:
        m = re.match(r"^\|\s*`([^`]+)`\s*\|", l)
        if m and m.group(1) not in split:
            split.append(m.group(1))
    if split_body is None or not split:
        notes.append("config: `## SPLIT_FILES` is missing or declares no live file")
    if None in (status_file, archive_dir, pattern) or not split:
        done("INDETERMINATE", notes)
    for p in [status_file, archive_dir] + split:
        if not safe_rel(p):
            done("INDETERMINATE", notes + ["config: %r is not a vault-relative path" % p])
    unknown = [ph for ph in re.findall(r"<([^>]+)>", pattern) if ph not in PLACEHOLDERS]
    if unknown:
        done("INDETERMINATE", notes + ["config: ARCHIVE_FILENAME_PATTERN %r carries unknown "
                                       "placeholder(s) %s" % (pattern, unknown)])
    # Literal segments are re.escape()d; only the two known placeholders become regex.
    arx = re.compile("^" + "".join(
        PLACEHOLDERS[part[1:-1]] if re.fullmatch(r"<[^>]+>", part) else re.escape(part)
        for part in re.split(r"(<[^>]+>)", pattern)) + "$")

    # status file first, then the split files in table order, then the archive in name order.
    declared = [status_file] + [s for s in split if s != status_file]
    adir = os.path.join(vault, archive_dir)
    if not os.path.isdir(adir):
        done("INDETERMINATE", notes + ["declared ARCHIVE_DIR %s is not a directory" % adir])
    archives = sorted(f for f in os.listdir(adir) if arx.match(f))
    skipped = sorted(f for f in os.listdir(adir) if f.endswith(".md") and not arx.match(f))
    sources = [(p, os.path.join(vault, p)) for p in declared] + \
              [(os.path.join(archive_dir, f), os.path.join(adir, f)) for f in archives]

    union, seen, meta, status_unique = [], set(), [], 0
    for rel, path in sources:
        if not os.path.isfile(path):
            done("INDETERMINATE", notes + ["declared source absent: %s" % path])
        raw = open(path, "rb").read()
        if b"\x00" in raw:
            done("INDETERMINATE", notes + ["source unparseable (NUL byte): %s" % path])
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as e:
            done("INDETERMINATE", notes + ["source unparseable (not UTF-8): %s: %s" % (path, e)])
        hs = headings(text)
        if rel == status_file:
            status_unique = len(set(hs))
        meta.append((rel, hashlib.sha256(raw).hexdigest(), len(hs)))
        for h in hs:
            if h not in seen:
                seen.add(h)
                union.append(h)
        notes.append("source: %-40s sha256=%s headings=%d" % (rel, meta[-1][1][:16], len(hs)))
    notes.append("archive: %d file(s) match %r; %d other .md file(s) in %s NOT read: %s"
                 % (len(archives), pattern, len(skipped), archive_dir, ", ".join(skipped) or "-"))
    if not union:
        done("FAIL", notes + ["ZERO headings across %d source(s)" % len(sources)])

    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    head = ["<!-- wave-history.md — GENERATED by ops/scripts/wave-history-build.sh "
            "(crypto-quant-signal-mcp). Never hand-edited: re-run the generator. -->",
            "<!-- generated_at: %s -->" % now,
            "<!-- corpus: every `### ` heading of the sources below, verbatim, de-duplicated on "
            "the full line. Read as status.md ∪ wave-history.md by host consumers. -->"]
    head += ["<!-- source: %s sha256=%s headings=%d -->" % m for m in meta]
    head += ["<!-- headings: %d -->" % len(union)]
    tmp = out + ".tmp"
    os.makedirs(os.path.dirname(os.path.abspath(out)) or ".", exist_ok=True)
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write("\n".join(head + union) + "\n")
    v = verify(tmp, len(union), status_unique, notes)
    if v != "PASS":
        os.remove(tmp)
        done(v, notes + ["nothing written: %s is untouched" % out])
    os.replace(tmp, out)
    notes.append("wrote %s: %d heading(s) from %d source(s) (status.md unique %d)"
                 % (out, len(union), len(sources), status_unique))
    done("PASS", notes)

mode = sys.argv[1]
if mode == "build":
    build(*sys.argv[2:5])
elif mode == "verify":
    n = []
    done(verify(sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), n), n)
PY
}

self_test() {
  local tmp checks=0 fails=0 out rc
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/whb.XXXXXX")" || { echo "SELF_TEST_VERDICT=INDETERMINATE"; return 3; }
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN
  ck() { checks=$((checks + 1)); if [ "$2" != "$3" ]; then echo "  ✗ $1: expected [$3] got [$2]"; fails=$((fails + 1)); fi; }
  run() { out="$("$SELF" "$@" 2>&1)"; rc=$?; }
  tok() { printf '%s\n' "$out" | grep -o 'WAVE_HISTORY_VERDICT=[A-Z]*' | tail -1; }

  # ── a fixture vault shaped like the real one ─────────────────────────────────────────────
  local V="$tmp/vault" W="$tmp/wave-history.md"
  mkdir -p "$V/Old Status"
  cat > "$V/trim-status-config.md" <<'CFG'
# Trim Status — fixture
## STATUS_FILE
status.md

## ARCHIVE_DIR
Old Status

## ARCHIVE_FILENAME_PATTERN
Status <Month> <Year>.md

## KEEP_RULES
- noise that must not be read as a source

## SPLIT_FILES

| Live file | Owns | Match rule |
|---|---|---|
| `AOE-status.md` | AOE | wave ID matches `^(OPS-)?AOE-` |
| `status.md` | everything else | default |

## KEEP_WINDOW_DAYS
7
CFG
  # status.md as trim policy v3 leaves it: OPEN waves only, plus one heading ALSO archived.
  printf '%s\n' '# status' \
    '### 2026-10-02 08:00 UTC — OPS-FIXTURE-REBOOT-W5 (Target ICP tier(s): META) — ⏳ open' \
    'body line mentioning OPS-FIXTURE-REBOOT-W9 GREEN, which is NOT a heading' \
    '### 2026-09-30 — OPS-SHARED-W1 — ✅ GREEN' > "$V/status.md"
  printf '%s\n' '### 2026-09-28 — AOE-FIXTURE-W2 — ✅ GREEN `aoe`' > "$V/AOE-status.md"
  printf '%s\n' '# Status August 2026' \
    '### 2026-08-27 — OPS-FIXTURE-REBOOT-W3 (Target ICP tier(s): META) — ✅ GREEN' \
    '### 2026-09-12 — OPS-FIXTURE-REBOOT-W4 (Target ICP tier(s): META) — ✅ GREEN' \
    '### 2026-09-30 — OPS-SHARED-W1 — ✅ GREEN' \
    '### 2026-09-30 — OPS-SHARED-W1 — ✅ GREEN ' > "$V/Old Status/Status August 2026.md"
  printf '%s\n' '### 2026-07-01 — OPS-DECOY-W9 — ✅ GREEN' > "$V/Old Status/Marketing-ARCHIVE-2026-07-17.md"
  printf '%s\n' '### 2026-07-01 — OPS-SMARCH-W9 — ✅ GREEN' > "$V/Old Status/Status Smarch 2026.md"

  # ── PASS: the real corpus shape ───────────────────────────────────────────────────────────
  run --out "$W" --vault "$V"
  ck "a well-formed vault builds"                        "$(tok)" "WAVE_HISTORY_VERDICT=PASS"
  ck "PASS exits 0"                                      "$rc" "0"
  ck "an ARCHIVE-only GREEN heading is in the corpus"    "$(grep -c '^### .*OPS-FIXTURE-REBOOT-W4.*GREEN' "$W")" "1"
  ck "a SPLIT_FILES heading is in the corpus"            "$(grep -c '^### .*AOE-FIXTURE-W2' "$W")" "1"
  ck "an open status.md heading is in the corpus"        "$(grep -c '^### .*OPS-FIXTURE-REBOOT-W5' "$W")" "1"
  ck "an archive file NOT matching the pattern is NOT read" "$(grep -c 'OPS-DECOY-W9' "$W")" "0"
  ck "a bad <Month> is NOT read"                         "$(grep -c 'OPS-SMARCH-W9' "$W")" "0"
  ck "a body line is never a heading"                    "$(grep -c 'OPS-FIXTURE-REBOOT-W9' "$W")" "0"
  ck "a heading in two sources appears ONCE (full-line dedupe)" \
     "$(grep -cx '### 2026-09-30 — OPS-SHARED-W1 — ✅ GREEN' "$W")" "1"
  ck "a near-duplicate (one trailing char) is a SECOND record" \
     "$(grep -cx '### 2026-09-30 — OPS-SHARED-W1 — ✅ GREEN ' "$W")" "1"
  ck "heading count == de-duplicated union (2+1+4-1)"   "$(grep -c '^### ' "$W")" "6"
  ck "headings are VERBATIM (backticks, emoji, em dash)" \
     "$(grep -cxF '### 2026-09-28 — AOE-FIXTURE-W2 — ✅ GREEN `aoe`' "$W")" "1"
  ck "no header line can match a consumer predicate"     "$(grep -v '^### ' "$W" | grep -vc '^<!-- .* -->$')" "0"
  ck "the header names the generator"                    "$(grep -c 'GENERATED by ops/scripts/wave-history-build.sh' "$W")" "1"
  ck "the header carries the UTC generation time"        "$(grep -cE '^<!-- generated_at: [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z -->$' "$W")" "1"
  ck "the header carries each source's real sha256"      "$(grep -c "source: Old Status/Status August 2026.md sha256=$(shasum -a 256 "$V/Old Status/Status August 2026.md" | cut -c1-64) headings=4" "$W")" "1"
  ck "…and its heading count, for every source (3)"      "$(grep -c '^<!-- source: ' "$W")" "3"
  # The consumer's OWN predicate, unchanged, now finds the archived history (send_telegram.sh).
  ck "the resolver predicate over the corpus reaches W4" \
     "$(grep -ohE '^### .*OPS-FIXTURE-REBOOT-W[0-9]+.*GREEN' "$W" | grep -oE 'OPS-FIXTURE-REBOOT-W[0-9]+' | grep -oE '[0-9]+$' | sort -n | tail -1)" "4"

  # ── a non-PASS build never replaces a good corpus ─────────────────────────────────────────
  printf 'GOOD CORPUS\n' > "$tmp/good.md"
  cp "$V/trim-status-config.md" "$tmp/cfg.bak"
  awk '/^## SPLIT_FILES/{skip=1;next} /^## /{skip=0} !skip' "$tmp/cfg.bak" > "$V/trim-status-config.md"
  run --out "$tmp/good.md" --vault "$V"
  ck "a config missing SPLIT_FILES is INDETERMINATE"     "$(tok)" "WAVE_HISTORY_VERDICT=INDETERMINATE"
  ck "INDETERMINATE exits 3"                             "$rc" "3"
  ck "…and the existing corpus is untouched"             "$(cat "$tmp/good.md")" "GOOD CORPUS"
  ck "…and no .tmp is left behind"                       "$(ls "$tmp" | grep -c 'good.md.tmp')" "0"
  cp "$tmp/cfg.bak" "$V/trim-status-config.md"

  sed 's/^Status <Month> <Year>.md$/Status <Month> <Year> <Quarter>.md/' "$tmp/cfg.bak" > "$V/trim-status-config.md"
  run --out "$W" --vault "$V"
  ck "an unknown pattern placeholder is INDETERMINATE"   "$(tok)" "WAVE_HISTORY_VERDICT=INDETERMINATE"
  cp "$tmp/cfg.bak" "$V/trim-status-config.md"

  mv "$V/AOE-status.md" "$tmp/aoe.bak"
  run --out "$W" --vault "$V"
  ck "a DECLARED split file that is absent is INDETERMINATE" "$(tok)" "WAVE_HISTORY_VERDICT=INDETERMINATE"
  mv "$tmp/aoe.bak" "$V/AOE-status.md"

  printf '### 2026-06-01 — OPS-NUL-W1 — ✅ GREEN\0\n' > "$V/Old Status/Status June 2026.md"
  run --out "$W" --vault "$V"
  ck "a source with a NUL byte is INDETERMINATE (handed, unparseable)" "$(tok)" "WAVE_HISTORY_VERDICT=INDETERMINATE"
  printf '### 2026-06-01 — OPS-LATIN1-W1 \xe9\n' > "$V/Old Status/Status June 2026.md"
  run --out "$W" --vault "$V"
  ck "a source that is not UTF-8 is INDETERMINATE"       "$(tok)" "WAVE_HISTORY_VERDICT=INDETERMINATE"
  rm -f "$V/Old Status/Status June 2026.md"

  run --vault "$V"
  ck "no --out is INDETERMINATE, never a write to a default" "$(tok)" "WAVE_HISTORY_VERDICT=INDETERMINATE"

  # ── FAIL: zero headings anywhere ─────────────────────────────────────────────────────────
  local E="$tmp/empty"; mkdir -p "$E/Old Status"; cp "$tmp/cfg.bak" "$E/trim-status-config.md"
  printf '# nothing\n' > "$E/status.md"; printf '# nothing\n' > "$E/AOE-status.md"
  run --out "$tmp/empty.md" --vault "$E"
  ck "zero headings across every source is FAIL"        "$(tok)" "WAVE_HISTORY_VERDICT=FAIL"
  ck "FAIL exits 1"                                      "$rc" "1"
  ck "…and nothing is written"                           "$([ -e "$tmp/empty.md" ] && echo y || echo n)" "n"

  # ── the ARTIFACT check, driven directly with a doctored file ─────────────────────────────
  # The build path can only reach verify() with a file it just wrote correctly, so a hermetic
  # build suite is structurally blind to the check that guards against a truncated write.
  run --out "$W" --vault "$V"
  out="$(core verify "$W" 6 2 2>&1)"; rc=$?
  ck "verify accepts the file it was built from"        "$(tok)" "WAVE_HISTORY_VERDICT=PASS"
  grep -v 'OPS-FIXTURE-REBOOT-W4' "$W" > "$tmp/truncated.md"
  out="$(core verify "$tmp/truncated.md" 6 2 2>&1)"; rc=$?
  ck "a TRUNCATED corpus fails verify"                  "$(tok)" "WAVE_HISTORY_VERDICT=FAIL"
  ck "…with exit 1"                                     "$rc" "1"
  out="$(core verify "$W" 6 7 2>&1)"; rc=$?
  ck "a corpus smaller than status.md alone fails verify" "$(tok)" "WAVE_HISTORY_VERDICT=FAIL"
  cat "$W" "$W" > "$tmp/doubled.md"
  out="$(core verify "$tmp/doubled.md" 6 2 2>&1)"; rc=$?
  ck "a corpus with duplicated headings fails verify"   "$(tok)" "WAVE_HISTORY_VERDICT=FAIL"

  # ── vacuity guard on the suite itself ─────────────────────────────────────────────────────
  if [ "$checks" -lt 35 ]; then
    echo "  ✗ VACUITY: only $checks checks ran (floor 35)"
    echo "SELF_TEST_VERDICT=INDETERMINATE"; return 3
  fi
  if [ "$fails" -gt 0 ]; then
    echo "SELF-TEST: FAIL ($fails of $checks)"; echo "SELF_TEST_VERDICT=FAIL"; return 1
  fi
  echo "SELF-TEST: PASS ($checks checks)"; echo "SELF_TEST_VERDICT=PASS"; return 0
}

OUT="" VAULT="" CONFIG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --self-test) self_test; exit $? ;;
    --out)    OUT="${2:-}"; shift 2 ;;
    --vault)  VAULT="${2:-}"; shift 2 ;;
    --config) CONFIG="${2:-}"; shift 2 ;;
    *) echo "  unknown argument: $1" >&2; echo "WAVE_HISTORY_VERDICT=INDETERMINATE"; exit 3 ;;
  esac
done
if [ -z "$OUT" ]; then
  echo "  --out <path> is required (this tool never writes to a default location)"
  echo "WAVE_HISTORY_VERDICT=INDETERMINATE"; exit 3
fi
if [ -z "$VAULT" ]; then
  # Projected from the ONE declared vault path, exactly as monitoring-results-sync.sh does — never
  # restated. A missing lib or an empty projection REFUSES rather than degrading to "".
  MAP_PATH_LIB="$REPO/scripts/lib/system-map-path.sh"
  if [ ! -r "$MAP_PATH_LIB" ]; then
    echo "  vault path SoT unreadable: $MAP_PATH_LIB"; echo "WAVE_HISTORY_VERDICT=INDETERMINATE"; exit 3
  fi
  # shellcheck source=/dev/null
  . "$MAP_PATH_LIB"
  VAULT="$(dirname "${ALGOVAULT_SYSTEM_MAP_PATH:-}")"
fi
if [ -z "$VAULT" ] || [ ! -d "$VAULT" ]; then
  echo "  vault root does not resolve to a directory: [$VAULT]"; echo "WAVE_HISTORY_VERDICT=INDETERMINATE"; exit 3
fi
core build "$VAULT" "${CONFIG:-$VAULT/trim-status-config.md}" "$OUT"
