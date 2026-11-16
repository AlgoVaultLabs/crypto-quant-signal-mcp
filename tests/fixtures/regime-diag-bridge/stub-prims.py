#!/usr/bin/env python3
"""A stand-in for scripts/regime-diag/prims.py, for tests/unit/regime-diag-bridge.test.ts (EDGE-REGIME-DIAG-BRIDGE-W1).

A test copies this file to <tmp>/scripts/regime-diag/prims.py, beside a file `mode`. Each call reads the framed
request exactly as prims.py does (`--bytes <n>`, then n bytes), records it as `call-<k>.req`, then acts on the mode:
  hang-then-answer  the first call hangs; every later call answers
  hang-always       every call hangs
  truncated         a well-formed reply on stdout, then `truncated request` on stderr and exit 1
A hang is a sleep far longer than any test's timeout: the bridge's own timeout ends it. An answer is one string per
op, "answer:<op>". Standard library only.
"""
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    if len(sys.argv) != 3 or sys.argv[1] != "--bytes" or not re.fullmatch(r"[0-9]+", sys.argv[2]):
        raise SystemExit("stub: usage: prims.py --bytes <n>")
    n = int(sys.argv[2])
    data = sys.stdin.buffer.read(n)
    k = 1 + sum(1 for f in os.listdir(HERE) if re.fullmatch(r"call-[0-9]+\.req", f))
    with open(os.path.join(HERE, "call-%d.req" % k), "wb") as f:
        f.write(data)
    with open(os.path.join(HERE, "mode")) as f:
        mode = f.read().strip()
    reply = {"out": ["answer:%s" % o["op"] for o in json.loads(data.decode("utf-8"))["ops"]]}
    if mode == "hang-always" or (mode == "hang-then-answer" and k == 1):
        time.sleep(600)
    json.dump(reply, sys.stdout)
    if mode == "truncated":
        sys.stdout.flush()
        sys.stderr.write("truncated request: 0 of %d bytes before end-of-input\n" % n)
        sys.exit(1)


if __name__ == "__main__":
    main()
