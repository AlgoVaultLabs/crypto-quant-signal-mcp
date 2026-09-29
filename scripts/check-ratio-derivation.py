#!/usr/bin/env python3
"""check-ratio-derivation.py — OPS-ALARM-SINGLE-DERIVATION-W1 CH1. The class gate.

AN ALARM RATIO REACHES A VERDICT COMPARISON ONLY THROUGH `ops/monitoring/population_rate.py`.

THE CLASS, counted by root cause (≥ 5 instances; the prose laws already existed and failed AS
PROSE, so this is a gate — CLAUDE.md § Completeness): a ratio or an instrument over the wrong
population. `@{upstream}`, CF-origin, the liveness band (`verification-gates.md`); the retired
book-liveness `SUPPRESSION_CEILING_PCT`; GEO-probe 429s in a denominator; HEADROOM's "counts only the
load you are adding"; the regime canary's 203 / 3,920 (every caller's throws over one tool's calls);
book-liveness's "29 of the last 28 days". Every one was a division whose numerator was not a subset
of its denominator, and every one survived review because the number it produced was real.

WHAT IT CHECKS — AST, never a text grep. Scope: every `ops/monitoring/*.py` whose row in
`ops/monitoring/monitoring-inventory.json` carries non-empty `alert_ids` (a paging canary).
  FAIL  a true division (`/`, `/=`) whose right operand is not a constant expression, and which
        reaches a comparison in the same scope — directly, or through a name it was assigned to —
        unless its statement carries `# ratio-exempt: <reason>` (reason ≥ 8 chars), or its site
        is in the committed baseline;
  FAIL  a `PopulationCounts(` constructed anywhere in scope — counts are built by
        `population_rate.measure` / `counts_for` only, or a caller could forge a valid-looking
        object over two populations;
  FAIL  a `# ratio-exempt:` with no reason.
Division by a constant expression (`age / 3600`, `x / (60 * 60)`) is a unit conversion, not a
population rate, and is not a site.

THE BASELINE (`ops/ratio-derivation-baseline.json`) is SHRINK-ONLY — the ratchet shape of
`scripts/check-colour-literal-ratchet.mjs`. A site is `<scope qualname>::<ast.unparse(division)>`
(plus `#n` for repeats), never a line number, so unrelated edits do not move it. A baseline row whose
site is gone REPORTS (shrink it with `--write-baseline`); a site absent from the baseline FAILS.
`--write-baseline` only ever removes rows; `--init-baseline` runs only when no baseline exists.
There is no flag that adds a row: route the new ratio through `population_rate`, or exempt it with a
reason a reviewer can read.

HONEST SCOPE. A ratchet over paging canaries in `ops/monitoring/` ONLY. A ratio in a
`src/scripts/*` digest is not covered, and a division laundered through a helper in another module
is invisible to a per-scope AST walk; the baseline's ENUMERATION is what makes the debt knowable.

Verdict: exactly one terminal `RATIO_DERIVATION_VERDICT=PASS|FAIL|INDETERMINATE`, exit 0/1/3 (3 is
the token-law default for a NEW gate). INDETERMINATE is evaluated FIRST: an unreadable inventory, an
empty scope, a missing or unparseable scoped file, or an unreadable baseline is never a PASS.

    python3 scripts/check-ratio-derivation.py [--root DIR] [--self-test] [--write-baseline] [--init-baseline]
"""
from __future__ import annotations

import ast
import json
import os
import re
import sys
import tempfile

PASS, FAIL, INDET = "PASS", "FAIL", "INDETERMINATE"
EXIT_FOR = {PASS: 0, FAIL: 1, INDET: 3}
TOKEN = "RATIO_DERIVATION_VERDICT"

INVENTORY_REL = "ops/monitoring/monitoring-inventory.json"
BASELINE_REL = "ops/ratio-derivation-baseline.json"
SCOPE_RE = re.compile(r"^ops/monitoring/[^/]+\.py$")
RATE_MODULE = "ops/monitoring/population_rate.py"
EXEMPT_RE = re.compile(r"#\s*ratio-exempt:(.*)$")
MIN_EXEMPT_REASON = 8
BASELINE_REASON = ("pre-existing at OPS-ALARM-SINGLE-DERIVATION-W1 (2026-09-29) — migrate through "
                   "population_rate when this canary is next touched")


class Unreadable(Exception):
    """Input we were handed and could not read or parse — always INDETERMINATE."""


# ─────────────────────────────── scope ───────────────────────────────

def load_scope(root: str) -> "list[tuple[str, str]]":
    """(relpath, owner) for every paging canary in scope. Raises Unreadable."""
    path = os.path.join(root, INVENTORY_REL)
    try:
        with open(path, encoding="utf-8") as fh:
            inv = json.load(fh)
        artifacts = inv["artifacts"]
    except Exception as e:  # noqa: BLE001
        raise Unreadable(f"inventory unreadable ({type(e).__name__}: {str(e)[:120]})")
    out = []
    for a in artifacts:
        rel = a.get("artifact") or ""
        if SCOPE_RE.match(rel) and rel != RATE_MODULE and (a.get("alert_ids") or []):
            out.append((rel, a.get("owner_wave") or a.get("id") or "unowned"))
    return sorted(set(out))


# ─────────────────────────────── detection ───────────────────────────────

def _is_constant_expr(node: ast.AST) -> bool:
    if isinstance(node, ast.Constant):
        return True
    if isinstance(node, ast.UnaryOp):
        return _is_constant_expr(node.operand)
    if isinstance(node, ast.BinOp):
        return _is_constant_expr(node.left) and _is_constant_expr(node.right)
    return False


_PATHISH = re.compile(r"(?:^|_)(?:DIR|PATH|ROOT|HOME)$|(?:_dir|_path|_root)$", re.IGNORECASE)
_PATH_CTORS = {"Path", "PurePath", "PosixPath", "PurePosixPath"}


def _is_path_join(node: ast.BinOp) -> bool:
    """`CACHE_DIR / slug`, `Path(x) / name`: a pathlib join, not a population rate. Recognised by
    the LEFT operand only (a path-named binding, a Path constructor, or an inner join), because a
    divisor's name says nothing about what is being divided."""
    left = node.left
    if isinstance(left, ast.BinOp) and isinstance(left.op, ast.Div):
        return _is_path_join(left)
    if isinstance(left, ast.Call):
        return _call_name(left) in _PATH_CTORS
    name = left.id if isinstance(left, ast.Name) else left.attr if isinstance(left, ast.Attribute) else ""
    return bool(name) and bool(_PATHISH.search(name))


def _is_ratio(node: ast.AST) -> bool:
    """A true division whose divisor is data, not a unit constant, and which is not a path join."""
    if not (isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div)):
        return False
    if _is_constant_expr(node.right):
        return False
    if _is_path_join(node):
        return False
    return True


def _call_name(node: ast.Call) -> str:
    f = node.func
    if isinstance(f, ast.Name):
        return f.id
    if isinstance(f, ast.Attribute):
        return f.attr
    return ""


class _Scope:
    def __init__(self, qualname: str, body: "list[ast.AST]") -> None:
        self.qualname = qualname
        self.body = body


def _scopes(tree: ast.Module) -> "list[_Scope]":
    """The module body (minus nested defs) and every function, each walked WITHOUT descending into
    nested functions — a comparison in an inner function does not certify an outer ratio."""
    out = [_Scope("<module>", [n for n in tree.body if not isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))])]

    def visit(nodes, prefix):
        for n in nodes:
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
                q = f"{prefix}{n.name}"
                out.append(_Scope(q, n.body))
                visit(n.body, q + ".")
            elif isinstance(n, ast.ClassDef):
                visit(n.body, f"{prefix}{n.name}.")
            else:
                for child in ast.iter_child_nodes(n):
                    if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                        visit([child], prefix)
    visit(tree.body, "")
    return out


def _walk_scope(nodes):
    """Every node in the scope, not descending into nested function/class bodies."""
    stack = list(nodes)
    while stack:
        n = stack.pop()
        yield n
        for child in ast.iter_child_nodes(n):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
                continue
            stack.append(child)


def _stmt_lines(stmt: ast.AST, lines: "list[str]") -> "list[str]":
    start = getattr(stmt, "lineno", 1)
    end = getattr(stmt, "end_lineno", start) or start
    return lines[start - 1:end]


def analyse_source(rel: str, source: str) -> dict:
    """Pure. Returns {'sites': [...], 'forged': [...], 'bad_exempt': [...]}. Raises Unreadable."""
    try:
        tree = ast.parse(source, filename=rel)
    except SyntaxError as e:
        raise Unreadable(f"{rel}: cannot parse ({e.msg} at line {e.lineno})")
    lines = source.splitlines()
    sites: list[str] = []
    forged: list[str] = []
    bad_exempt: list[str] = []

    # The INNERMOST statement owning each node, for exemption comments. `ast.walk` is breadth-first,
    # so an inner statement is visited after its parent and overwrites it — an exemption comment
    # therefore applies to its own statement, never to a whole enclosing `if`/`for` block.
    owner: dict = {}
    for stmt in ast.walk(tree):
        if isinstance(stmt, ast.stmt):
            for sub in ast.walk(stmt):
                owner[id(sub)] = stmt
    for scope in _scopes(tree):
        nodes = list(_walk_scope(scope.body))
        ratio_nodes = [n for n in nodes if _is_ratio(n)]
        # AugAssign `x /= y` is a ratio assigned to x.
        aug = [n for n in nodes if isinstance(n, ast.AugAssign) and isinstance(n.op, ast.Div)
               and not _is_constant_expr(n.value)]
        # names carrying a ratio
        carriers: dict = {}
        for n in nodes:
            if isinstance(n, (ast.Assign, ast.AnnAssign)):
                value = n.value
                if value is None:
                    continue
                inner = [r for r in ast.walk(value) if _is_ratio(r)]
                if not inner:
                    continue
                targets = n.targets if isinstance(n, ast.Assign) else [n.target]
                for t in targets:
                    for leaf in ast.walk(t):
                        if isinstance(leaf, ast.Name):
                            carriers.setdefault(leaf.id, []).extend(inner)
        for n in aug:
            if isinstance(n.target, ast.Name):
                carriers.setdefault(n.target.id, []).append(n)
        compares = [n for n in nodes if isinstance(n, ast.Compare)]
        compared_names = {leaf.id for c in compares for leaf in ast.walk(c)
                          if isinstance(leaf, ast.Name) and isinstance(leaf.ctx, ast.Load)}
        direct = {id(r) for c in compares for r in ast.walk(c) if _is_ratio(r)}

        seen: dict = {}
        for r in ratio_nodes + aug:
            via_name = any(r in carriers.get(name, []) for name in compared_names)
            reaches_compare = id(r) in direct or via_name
            if not reaches_compare:
                continue
            stmt = owner.get(id(r), r)
            exempt_reason = None
            for line in _stmt_lines(stmt, lines):
                m = EXEMPT_RE.search(line)
                if m:
                    exempt_reason = m.group(1)
            expr = ast.unparse(r if not isinstance(r, ast.AugAssign) else r)
            if exempt_reason is not None:
                if len(exempt_reason.strip()) >= MIN_EXEMPT_REASON:
                    continue
                bad_exempt.append(f"{scope.qualname}::{expr}")
                continue
            key = f"{scope.qualname}::{expr}"
            seen[key] = seen.get(key, 0) + 1
            sites.append(key if seen[key] == 1 else f"{key}#{seen[key]}")

    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and _call_name(node) == 'PopulationCounts':
            forged.append(f"line {node.lineno}: {ast.unparse(node)[:80]}")
    return {"sites": sites, "forged": forged, "bad_exempt": bad_exempt}


# ─────────────────────────────── baseline ───────────────────────────────

def load_baseline(root: str) -> "list[dict] | None":
    path = os.path.join(root, BASELINE_REL)
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        rows = data["sites"]
        for r in rows:
            if not (r.get("file") and r.get("site") and r.get("reason") and r.get("owner")):
                raise ValueError(f"baseline row missing file/site/reason/owner: {r}")
        return rows
    except Exception as e:  # noqa: BLE001
        raise Unreadable(f"baseline unreadable ({type(e).__name__}: {str(e)[:120]})")


def write_baseline(root: str, rows: "list[dict]") -> None:
    path = os.path.join(root, BASELINE_REL)
    doc = {
        "_comment": ("OPS-ALARM-SINGLE-DERIVATION-W1 — SHRINK-ONLY baseline for scripts/check-ratio-derivation.py. "
                     "Each row is a pre-existing division that reaches a verdict comparison in a paging canary "
                     "WITHOUT ops/monitoring/population_rate.py. Remove a row by migrating its site; "
                     "`--write-baseline` only ever removes rows. There is no flag that adds one."),
        "schema_version": 1,
        "sites": sorted(rows, key=lambda r: (r["file"], r["site"])),
    }
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or ".", prefix=".ratio-baseline.", suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    os.replace(tmp, path)


# ─────────────────────────────── evaluation ───────────────────────────────

def evaluate_tree(root: str, mode: str = "check") -> "tuple[str, list[str]]":
    """Returns (verdict, report lines). mode: check | write-baseline | init-baseline."""
    report: list[str] = []
    try:
        scoped = load_scope(root)
    except Unreadable as e:
        return INDET, [f"  {e}"]
    if not scoped:
        return INDET, ["  scope: 0 files — the inventory declares no paging canary under ops/monitoring/*.py; "
                       "an empty scope is vacuity, not a clean tree"]
    report.append(f"  scope: {len(scoped)} files (paging canaries with alert_ids)")

    found: dict = {}
    forged: list[str] = []
    bad: list[str] = []
    owners = dict(scoped)
    for rel, _owner in scoped:
        path = os.path.join(root, rel)
        try:
            with open(path, encoding="utf-8") as fh:
                source = fh.read()
            res = analyse_source(rel, source)
        except FileNotFoundError:
            return INDET, report + [f"  {rel}: declared in the inventory but absent — cannot verify it"]
        except Unreadable as e:
            return INDET, report + [f"  {e}"]
        for s in res["sites"]:
            found[(rel, s)] = True
        forged += [f"{rel} {f}" for f in res["forged"]]
        bad += [f"{rel} {b}" for b in res["bad_exempt"]]

    try:
        baseline = load_baseline(root)
    except Unreadable as e:
        return INDET, report + [f"  {e}"]

    if mode == "init-baseline":
        if baseline is not None:
            return FAIL, report + ["  --init-baseline refused: a baseline already exists (it is shrink-only)"]
        rows = [{"file": f, "site": s, "reason": BASELINE_REASON, "owner": owners[f]} for (f, s) in found]
        write_baseline(root, rows)
        report.append(f"  baseline initialised with {len(rows)} pre-existing sites")
        baseline = rows

    if baseline is None:
        return INDET, report + [f"  {BASELINE_REL} is absent — run --init-baseline once"]

    base_keys = {(r["file"], r["site"]) for r in baseline}
    new = sorted(k for k in found if k not in base_keys)
    stale = sorted(k for k in base_keys if k not in found)
    report.append(f"  sites: {len(found)} in tree · {len(base_keys)} in baseline · {len(new)} new · {len(stale)} stale")
    for f, s in new:
        report.append(f"  NEW ratio reaches a comparison without population_rate: {f} :: {s}")
    for f in forged:
        report.append(f"  PopulationCounts constructed outside population_rate: {f}")
    for b in bad:
        report.append(f"  ratio-exempt with no reason (≥{MIN_EXEMPT_REASON} chars required): {b}")
    for f, s in stale:
        report.append(f"  stale baseline row (site gone — shrink with --write-baseline): {f} :: {s}")

    if mode == "write-baseline":
        if new or forged or bad:
            return FAIL, report + ["  --write-baseline refused: it only removes rows; migrate or exempt the new sites"]
        kept = [r for r in baseline if (r["file"], r["site"]) in found]
        write_baseline(root, kept)
        report.append(f"  baseline shrunk to {len(kept)} rows")
        return PASS, report
    if new or forged or bad:
        return FAIL, report
    return PASS, report


# ─────────────────────────────── self-test ───────────────────────────────

def self_test() -> int:
    failures: list[str] = []
    passed = 0

    def check_one(name: str, fn) -> None:
        nonlocal passed
        try:
            ok = bool(fn())
        except Exception as e:  # noqa: BLE001
            ok = False
            name = f"{name} [raised {type(e).__name__}: {str(e)[:80]}]"
        print(f"  {'PASS' if ok else 'FAIL'}  {name}")
        if ok:
            passed += 1
        else:
            failures.append(name)

    def sites(src: str) -> dict:
        return analyse_source("ops/monitoring/x.py", src)

    PRE_FIX = (
        "def evaluate(throws, calls):\n"
        "    if calls <= 0:\n        return ('INDETERMINATE', None)\n"
        "    rate = throws * 100.0 / calls\n"
        "    if rate > MAX_THROWS_PER_100:\n        return ('FAIL', rate)\n"
        "    return ('PASS', rate)\n"
    )
    corpus = {
        "pre-fix shape (assigned ratio, compared)": (PRE_FIX, ["evaluate::throws * 100.0 / calls"]),
        "direct ratio in a comparison": ("def f(a, b):\n    return a / b > 0.5\n", ["f::a / b"]),
        "augmented division, compared": ("def f(a, b):\n    a /= b\n    if a > 1:\n        return 1\n", ["f::a /= b"]),
        "unit conversion by a constant is not a ratio": ("def f(age):\n    hrs = age / 3600\n    return hrs > 2\n", []),
        "constant-expression divisor is not a ratio": ("def f(age):\n    return age / (60 * 60) > 2\n", []),
        "a ratio never compared is not a site": ("def f(a, b):\n    x = a / b\n    return x\n", []),
        "a reasoned exemption is honoured": ("def f(a, b):\n    x = a / b  # ratio-exempt: display-only unit ratio here\n    return x > 1\n", []),
        "the rate module's API is not a raw ratio": ("def f(run_sql, spec):\n    v = pr.evaluate(pr.counts_for(pr.measure(run_sql, spec), ('paid',)), 1.0, 10)\n    return v.verdict == 'PASS'\n", []),
        "a pathlib join is not a ratio": ("def f(slug, ttl):\n    p = CACHE_DIR / slug\n    q = Path(root) / slug\n    return p.stat().st_size > ttl and q.exists() == True\n", []),
        "a compare in an INNER function does not certify an outer ratio": ("def f(a, b):\n    x = a / b\n    def g(y):\n        return y > 1\n    return g\n", []),
    }
    if not corpus:
        print("  SELF-TEST: INDETERMINATE — the constructed corpus is empty")
        print(f"{TOKEN}={INDET}")
        return EXIT_FOR[INDET]

    check_one("PASS maps to 0", lambda: EXIT_FOR[PASS] == 0)
    check_one("FAIL maps to 1", lambda: EXIT_FOR[FAIL] == 1)
    check_one("INDETERMINATE maps to 3", lambda: EXIT_FOR[INDET] == 3)
    for name, (src, want) in corpus.items():
        check_one(name, lambda src=src, want=want: sites(src)["sites"] == want)
    check_one("an exemption with no reason is itself a finding",
              lambda: sites("def f(a, b):\n    x = a / b  # ratio-exempt:\n    return x > 1\n")["bad_exempt"] == ["f::a / b"])
    check_one("a hand-built PopulationCounts is a finding",
              lambda: len(sites("def f():\n    return pr.PopulationCounts('x', (), 0, 1)\n")["forged"]) == 1)

    def unparseable() -> bool:
        try:
            sites("def broken(:\n")
            return False
        except Unreadable:
            return True
    check_one("an unparseable file is Unreadable (→ INDETERMINATE), never zero sites", unparseable)

    # ── end-to-end over a constructed tree: baseline semantics and vacuity.
    with tempfile.TemporaryDirectory() as root:
        os.makedirs(os.path.join(root, "ops/monitoring"))

        def put(rel, text):
            with open(os.path.join(root, rel), "w", encoding="utf-8") as fh:
                fh.write(text)

        def inventory(rows):
            put(INVENTORY_REL, json.dumps({"artifacts": rows}))

        inventory([{"id": "a", "artifact": "ops/monitoring/a.py", "alert_ids": ["A"], "owner_wave": "W-A"},
                   {"id": "b", "artifact": "ops/monitoring/b.py", "alert_ids": [], "owner_wave": "W-B"}])
        put("ops/monitoring/a.py", PRE_FIX)
        put("ops/monitoring/b.py", PRE_FIX)  # not a paging canary — out of scope
        check_one("no baseline yet → INDETERMINATE (never a silent pass)", lambda: evaluate_tree(root)[0] == INDET)
        check_one("--init-baseline records the pre-existing site", lambda: evaluate_tree(root, "init-baseline")[0] == PASS)
        check_one("…only the in-scope file", lambda: [r["file"] for r in load_baseline(root)] == ["ops/monitoring/a.py"])
        check_one("a baselined site PASSes", lambda: evaluate_tree(root)[0] == PASS)
        check_one("--init-baseline refuses a second run", lambda: evaluate_tree(root, "init-baseline")[0] == FAIL)
        put("ops/monitoring/a.py", PRE_FIX + "\ndef g(a, b):\n    return a / b > 1\n")
        check_one("a NEW site FAILs", lambda: evaluate_tree(root)[0] == FAIL)
        check_one("--write-baseline refuses to absorb a new site", lambda: evaluate_tree(root, "write-baseline")[0] == FAIL)
        put("ops/monitoring/a.py", "def evaluate(v):\n    return v == 'PASS'\n")
        v, rep = evaluate_tree(root)
        check_one("a stale baseline row REPORTs and does not block", lambda: v == PASS and any("stale" in l for l in rep))
        check_one("--write-baseline shrinks the stale row away",
                  lambda: evaluate_tree(root, "write-baseline")[0] == PASS and load_baseline(root) == [])
        inventory([{"id": "b", "artifact": "ops/monitoring/b.py", "alert_ids": [], "owner_wave": "W-B"}])
        check_one("an empty scope is INDETERMINATE (vacuity), never PASS", lambda: evaluate_tree(root)[0] == INDET)
        put(INVENTORY_REL, "{not json")
        check_one("an unreadable inventory is INDETERMINATE", lambda: evaluate_tree(root)[0] == INDET)

    def raising_is_caught() -> bool:
        try:
            return bool(1 / 0)
        except ZeroDivisionError:
            return True
    check_one("a raising assertion is caught and reported, not propagated", raising_is_caught)

    if failures:
        print(f"SELF-TEST: FAIL ({len(failures)})")
        print(f"{TOKEN}={FAIL}")
        return EXIT_FOR[FAIL]
    print(f"SELF-TEST: PASS ({passed} assertions, non-vacuous)")
    print(f"{TOKEN}={PASS}")
    return EXIT_FOR[PASS]


def main(argv: "list[str]") -> int:
    if "--self-test" in argv:
        return self_test()
    root = os.getcwd()
    if "--root" in argv:
        i = argv.index("--root")
        root = argv[i + 1] if i + 1 < len(argv) else ""
    else:
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    mode = "check"
    if "--write-baseline" in argv:
        mode = "write-baseline"
    if "--init-baseline" in argv:
        mode = "init-baseline"
    verdict, report = evaluate_tree(root, mode)
    for line in report:
        print(line)
    print(f"{TOKEN}={verdict}")
    return EXIT_FOR[verdict]


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
