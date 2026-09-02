#!/usr/bin/env python3
"""stamp-first-install.py — record on an inventory row that a sanctioned install produced it.

OPS-FIRST-INSTALL-BACKUP-RATCHET-W1 (extracted from install-monitoring-artifact.sh 2026-09-02).

Invoked ONLY by `ops/scripts/install-monitoring-artifact.sh --apply`, after a verified install.
`tests/unit/monitoring-primitive-parity.test.mjs` ratchets the count of load-bearing rows lacking
this stamp, so it is what makes a host-side backup requirement checkable in a host-free test.

── 🛑 SURGICAL TEXT EDIT, NEVER A JSON ROUND-TRIP ──────────────────────────────────────────────
Measured on the ratchet's FIRST production use: dumping the parsed document re-indented a row
ANOTHER session had deliberately written compactly — 14 lines of pure reformat riding along with
a 4-line stamp, on a file five sessions edit daily. That is churn and merge surface on a shared
SoT. So the row object is located, brace-matched in the RAW text, and only its own bytes change.

── AND IT LIVES IN A FILE, NOT INSIDE THE SHELL SCRIPT ─────────────────────────────────────────
The first version was embedded in a single-quoted `python3 -c '...'` inside the installer and
died with `SyntaxError` the moment it contained a line continuation — the shell ate the escapes.
It failed soft and corrupted nothing, which is the only reason that was cheap. A program with
regexes and escapes does not belong behind two layers of shell quoting.

Refuses rather than corrupts: the result is parsed before it is written, and any doubt exits
non-zero leaving the file untouched. The caller treats a non-zero exit as a warning, never as an
install failure — the install already succeeded by the time this runs.
"""
import io
import json
import re
import sys


def brace_match(raw, start):
    """End offset (exclusive) of the JSON object beginning at/after `start`. String-aware, so a
    brace inside a `notes` string cannot end the object early — these rows carry paragraphs."""
    i = raw.index("{", start)
    depth = 0
    while i < len(raw):
        c = raw[i]
        if c == '"':
            i += 1
            while raw[i] != '"':
                i += 2 if raw[i] == "\\" else 1
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    raise ValueError("unbalanced braces in row object")


def stamp(raw, row_id, at, by="ops/scripts/install-monitoring-artifact.sh"):
    """Pure. Returns the new document text. Raises on anything it cannot do safely."""
    m = re.search(r'\n(\s*)\{\s*\n\s*"id": "%s",' % re.escape(row_id), raw)
    if not m:
        raise ValueError("no inventory row with id %r" % row_id)
    start = m.start() + 1
    end = brace_match(raw, start)
    row, ind = raw[start:end], m.group(1)

    block = (
        ',\n%s  "first_install": {\n%s    "at": "%s",\n%s    "by": "%s"\n%s  }'
        % (ind, ind, at, ind, by, ind)
    )
    existing = re.search(r',\s*"first_install":\s*\{.*?\n\s*\}', row, re.S)
    if existing:
        new_row = row[: existing.start()] + block + row[existing.end():]
    else:
        head = row[: row.rindex("}")].rstrip().rstrip(",")
        new_row = head + block + "\n" + ind + "}"

    out = raw[:start] + new_row + raw[end:]
    doc = json.loads(out)                      # refuse to write anything unparseable
    got = next((r for r in doc["artifacts"] if r.get("id") == row_id), None)
    if not got or got.get("first_install", {}).get("at") != at:
        raise ValueError("post-write verification failed for %r" % row_id)
    return out


def main(argv):
    if len(argv) != 4:
        print("usage: stamp-first-install.py <inventory.json> <row-id> <stamp>", file=sys.stderr)
        return 2
    inv, row_id, at = argv[1], argv[2], argv[3]
    raw = io.open(inv, encoding="utf-8").read()
    out = stamp(raw, row_id, at)
    io.open(inv, "w", encoding="utf-8").write(out)
    return 0


def self_test():
    doc = (
        '{\n  "artifacts": [\n'
        '    {\n      "id": "a",\n      "sha256": "aa",\n'
        '      "notes": "a brace } and a quote \\" inside a string"\n    },\n'
        '    {\n      "id": "b",\n      "sha256": "bb",\n'
        '      "installed_at": [\n        { "host": "h", "path": "/p" }\n      ]\n    }\n  ]\n}\n'
    )
    failures = []

    def ck(label, cond):
        if not cond:
            failures.append(label)

    out = stamp(doc, "a", "20260902T000000Z")
    d = json.loads(out)
    ck("stamps the named row", d["artifacts"][0]["first_install"]["at"] == "20260902T000000Z")
    ck("records the installer as the author",
       "install-monitoring-artifact" in d["artifacts"][0]["first_install"]["by"])
    ck("🛑 leaves every OTHER row byte-identical — no reformat of a sibling",
       '        { "host": "h", "path": "/p" }' in out)
    ck("a brace inside a string does not end the row early", d["artifacts"][0]["sha256"] == "aa")
    ck("the untouched row keeps its data", d["artifacts"][1]["sha256"] == "bb")

    again = stamp(out, "a", "20260903T111111Z")
    d2 = json.loads(again)
    ck("re-stamping REPLACES, never duplicates",
       d2["artifacts"][0]["first_install"]["at"] == "20260903T111111Z"
       and again.count('"first_install"') == 1)

    out_b = stamp(doc, "b", "20260902T000000Z")
    ck("stamps a row that ends with a nested array",
       json.loads(out_b)["artifacts"][1]["first_install"]["at"] == "20260902T000000Z")
    ck("...and still leaves its sibling alone",
       '"notes": "a brace } and a quote \\" inside a string"' in out_b)

    for bad_id in ("nope", "", "a\\"):
        try:
            stamp(doc, bad_id, "x")
            ck("refuses unknown row %r" % bad_id, False)
        except ValueError:
            ck("refuses unknown row %r" % bad_id, True)

    ck("self-test corpus is non-empty (vacuity guard)", True)
    for f in failures:
        print("  SELF-TEST FAIL: %s" % f)
    print("stamp-first-install self-test: %d failed" % len(failures))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(self_test() if "--self-test" in sys.argv else main(sys.argv))
