#!/usr/bin/env python3
"""check-threshold-clock.py — OPS-THRESHOLD-CLOCK-W1 (ARC-BOOK-LIVENESS-ALERT-TRUTH T5). The class gate.

A RECALIBRATION CLOCK SHIPS AS AN OWED READ, NEVER AS PROSE.

THE CLASS, measured at 8c50c757 (arc research §7–8): 23 dated revisit clocks in prose across 15 files
under src/, ops/ and scripts/, 21 of them past due on 2026-11-12 (the earliest due 2026-08-02).
A clock kept in prose is a clock nobody runs, and the page that opened the arc is one of the misses:
the book-liveness floor pins' re-measure, due 10-28, never happened, and the pins paged on correct
behaviour. The estate already has the primitive that runs a dated read by itself —
`ops/monitoring/owed-read-runner.py` over `ops/monitoring/owed-reads.json`, hourly, a FAIL pages once —
so the fix is at the generator: the owed read is the only way a clock can ship.

CHECK M — CLOCKS (text). Every `.ts .js .mjs .cjs .py .sh` file under `src/`, `ops/`, `scripts/` (hidden
directories, `node_modules` and `__pycache__` pruned). A clock is a line where the word "revisit" is
followed by "by" and an ISO date, any case — the needle is assembled from fragments below, so this
file can never match it. FAIL a clock that is not in the baseline: register the revisit as an
`owed-reads.json` row and delete the prose date.

CHECK T — THRESHOLDS (AST, never a text grep). Scope = the ratio gate's: every `ops/monitoring/*.py`
whose row in `ops/monitoring/monitoring-inventory.json` carries non-empty `alert_ids` (a paging canary).
A THRESHOLD is a module-level name bound to a numeric literal (a number, a signed number, or constant
arithmetic over numbers such as `6 * 3600`; never a bool), to a container whose leaves are all numeric
literals (dict values, list/tuple/set elements, nested), or — in source order — to a module-level
expression derived from an earlier threshold (`PINS = {v: K * m for v, m in MAX.items()}`: the floor
pins themselves). FAIL a comparison (`<` `<=` `>` `>=`) with an operand that reads a threshold: the
name, a subscript or `.get()` of it, arithmetic over it, either branch of a conditional, a fallback
(`x or N`), or a numeric builtin (int float abs min max round) over it — directly, or through a local
assigned from one in the same scope (the ratio gate's per-scope walk, followed to a fixpoint, so a
chain of locals stays visible; a `for` target over a table's `.items()`/`.values()` is such a local).
A call to anything else is a boundary: `rows = fetch(LOOKBACK)` is data, not a threshold. A parameter
or local of the same name shadows the module name, as Python does.
  EXCEPT  the constant's assignment statement carries `# threshold-revisit: <id>` with `<id>` a
          `reads[].id` in `owed-reads.json` (registered), or `# threshold-exempt: <reason>` with a
          reason of ≥ 8 chars (a bound, not a calibration); a derived threshold inherits the cover of
          its sources when it carries no marker of its own. Markers are COMMENT tokens (tokenize):
          the same words inside a string are not a marker.
  FAIL    every marker in a scoped canary with an unknown id or a short reason — wherever it sits.

THE BASELINE (`ops/threshold-clock-baseline.json`) is SHRINK-ONLY, exactly as
`ops/ratio-derivation-baseline.json`: rows {kind, file, site, reason, owner}. A site key carries no line
number — clock `<file>::<stripped line>`, threshold `<file>::<scope qualname>::<ast.unparse(compare)>`,
`#n` for repeats — so unrelated edits do not move it. A baseline row whose site is gone REPORTS (shrink
it with `--write-baseline`); a site absent from the baseline FAILS. `--write-baseline` only ever removes
rows; `--init-baseline` runs only when no baseline exists. There is no flag that adds a row.

POSITIVE LINES, every run: clocks baselined N (M past due at the run's UTC date) · threshold sites
baselined K · registered R · exempt E, then one PAST DUE line per past-due baselined clock. A past-due
baselined clock is REPORTED, never failed — today's debt is enumerated, never paged.

HONEST SCOPE. Check T covers paging canaries in `ops/monitoring/` ONLY: a threshold in a `src/` module or
a digest is not a site. A threshold laundered through another module, through a function's return
value (`table_for(mode)` returning a table), through any call outside the numeric builtins, or bound
to an env read (`int(os.environ.get("X", "20"))` is not a numeric literal) is invisible to a per-scope
walk; so is a comparison inside a lambda (the ratio gate's walk skips lambda bodies). Check M sees a
clock only when its words and date share one line, and judges the working tree it is pointed at
(untracked files included). The baseline's ENUMERATION is what makes the remaining debt knowable.

Verdict: exactly one terminal `THRESHOLD_CLOCK_VERDICT=PASS|FAIL|INDETERMINATE`, exit 0/1/3 (3 is the
token-law default for a NEW gate). INDETERMINATE is evaluated FIRST: an unreadable inventory, owed-reads
registry or baseline, an absent baseline, an empty scope, or a scoped file that cannot be read or
parsed is never a PASS. `--self-test` prints the same token.

    python3 scripts/check-threshold-clock.py [--root DIR] [--self-test] [--write-baseline] [--init-baseline]
"""
from __future__ import annotations

import ast
import datetime as _dt
import io
import json
import os
import re
import sys
import tempfile
import tokenize

PASS, FAIL, INDET = "PASS", "FAIL", "INDETERMINATE"
EXIT_FOR = {PASS: 0, FAIL: 1, INDET: 3}
TOKEN = "THRESHOLD_CLOCK_VERDICT"
WAVE = "OPS-THRESHOLD-CLOCK-W1"

INVENTORY_REL = "ops/monitoring/monitoring-inventory.json"
OWED_READS_REL = "ops/monitoring/owed-reads.json"
BASELINE_REL = "ops/threshold-clock-baseline.json"
CANARY_SCOPE_RE = re.compile(r"^ops/monitoring/[^/]+\.py$")
CLOCK_ROOTS = ("src", "ops", "scripts")
CLOCK_EXTS = (".ts", ".js", ".mjs", ".cjs", ".py", ".sh")
PRUNED_DIRS = ("node_modules", "__pycache__")

# The needle, assembled from fragments so this file's own source can never match it.
_W_REVISIT, _W_BY = "re" + "visit", "b" + "y"
CLOCK_RE = re.compile(r"\b" + _W_REVISIT + r"\s+" + _W_BY + r"\s+(\d{4}-\d{2}-\d{2})", re.IGNORECASE)

MARK_RE = re.compile(r"#\s*threshold-(revisit|exempt):(.*)$")
MIN_EXEMPT_REASON = 8
ORDERING = (ast.Lt, ast.LtE, ast.Gt, ast.GtE)
NUMERIC_FNS = frozenset({"int", "float", "abs", "min", "max", "round"})
TABLE_VIEWS = frozenset({"items", "values"})


class Unreadable(Exception):
    """Input we were handed and could not read or parse — always INDETERMINATE."""


def _utc_today() -> str:
    return _dt.datetime.now(_dt.timezone.utc).date().isoformat()


# ─────────────────────────────── inputs ───────────────────────────────

def load_inventory(root: str) -> "tuple[list[str], dict]":
    """(paging canaries in Check T's scope, {artifact path: owner}). Raises Unreadable."""
    path = os.path.join(root, INVENTORY_REL)
    try:
        with open(path, encoding="utf-8") as fh:
            artifacts = json.load(fh)["artifacts"]
        owners: dict = {}
        canaries = set()
        for a in artifacts:
            rel = a.get("artifact") or ""
            owners[rel] = a.get("owner_wave") or a.get("id") or "unowned"
            if CANARY_SCOPE_RE.match(rel) and (a.get("alert_ids") or []):
                canaries.add(rel)
    except Exception as e:  # noqa: BLE001
        raise Unreadable(f"inventory unreadable ({type(e).__name__}: {str(e)[:120]})")
    return sorted(canaries), owners


def load_owed_ids(root: str) -> "set[str]":
    """Every `reads[].id` in the owed-read registry. Raises Unreadable."""
    path = os.path.join(root, OWED_READS_REL)
    try:
        with open(path, encoding="utf-8") as fh:
            reads = json.load(fh)["reads"]
        if not isinstance(reads, list):
            raise ValueError("`reads` is not a list")
        ids = set()
        for r in reads:
            ident = r.get("id") if isinstance(r, dict) else None
            if not isinstance(ident, str) or not ident:
                raise ValueError(f"a reads[] row has no id: {str(r)[:80]}")
            ids.add(ident)
        return ids
    except Exception as e:  # noqa: BLE001
        raise Unreadable(f"owed-reads registry unreadable ({type(e).__name__}: {str(e)[:120]})")


def list_clock_files(root: str) -> "list[str]":
    out = []
    for top in CLOCK_ROOTS:
        for dirpath, dirnames, filenames in os.walk(os.path.join(root, top)):
            dirnames[:] = sorted(d for d in dirnames if not d.startswith(".") and d not in PRUNED_DIRS)
            for fn in sorted(filenames):
                if fn.endswith(CLOCK_EXTS):
                    out.append(os.path.relpath(os.path.join(dirpath, fn), root).replace(os.sep, "/"))
    return out


# ─────────────────────────────── Check M — clocks ───────────────────────────────

def scan_clocks(rel: str, text: str) -> "list[tuple[str, str]]":
    """Pure. [(site key, due date)] for every line carrying a dated revisit clock."""
    out = []
    seen: dict = {}
    for line in text.splitlines():
        dates = CLOCK_RE.findall(line)
        if not dates:
            continue
        key = f"{rel}::{line.strip()}"
        seen[key] = seen.get(key, 0) + 1
        out.append((key if seen[key] == 1 else f"{key}#{seen[key]}", min(dates)))
    return out


# ─────────────────────────────── Check T — thresholds ───────────────────────────────

def _numeric_literal(node: ast.AST) -> bool:
    if isinstance(node, ast.Constant):
        return isinstance(node.value, (int, float)) and not isinstance(node.value, bool)
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
        return _numeric_literal(node.operand)
    if isinstance(node, ast.BinOp):
        return _numeric_literal(node.left) and _numeric_literal(node.right)
    return False


def _numeric_container(node: ast.AST) -> bool:
    if isinstance(node, ast.Dict):
        if any(k is None for k in node.keys):  # `**other` — not a literal table
            return False
        parts = node.values
    elif isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        parts = node.elts
    else:
        return False
    return bool(parts) and all(_numeric_literal(p) or _numeric_container(p) for p in parts)


def _refs(node: ast.AST, names: dict) -> frozenset:
    """The threshold roots an expression carries at a VALUE position (see the docstring)."""
    if isinstance(node, ast.Name):
        return names.get(node.id, frozenset()) if isinstance(node.ctx, ast.Load) else frozenset()
    if isinstance(node, ast.Subscript):
        return _refs(node.value, names)
    if isinstance(node, ast.Call):
        f = node.func
        if isinstance(f, ast.Attribute) and (f.attr == "get" or f.attr in TABLE_VIEWS):
            return _refs(f.value, names)
        if isinstance(f, ast.Name) and f.id in NUMERIC_FNS:
            out = frozenset()
            for a in node.args:
                out |= _refs(a, names)
            return out
        return frozenset()
    if isinstance(node, ast.BinOp):
        return _refs(node.left, names) | _refs(node.right, names)
    if isinstance(node, ast.UnaryOp):
        return _refs(node.operand, names)
    if isinstance(node, ast.IfExp):
        return _refs(node.body, names) | _refs(node.orelse, names)
    if isinstance(node, ast.BoolOp):
        out = frozenset()
        for v in node.values:
            out |= _refs(v, names)
        return out
    return frozenset()


def _derived_refs(node: ast.AST, names: dict) -> frozenset:
    """`_refs`, plus the parts of a display or comprehension — how a module-level table is derived."""
    out = _refs(node, names)
    if isinstance(node, ast.Dict):
        parts = list(node.values)
    elif isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        parts = list(node.elts)
    elif isinstance(node, ast.DictComp):
        parts = [node.key, node.value] + [g.iter for g in node.generators]
    elif isinstance(node, (ast.ListComp, ast.SetComp, ast.GeneratorExp)):
        parts = [node.elt] + [g.iter for g in node.generators]
    else:
        parts = []
    for p in parts:
        if p is not None:
            out |= _derived_refs(p, names)
    return out


def _scopes(tree: ast.Module) -> "list[tuple[str, list, ast.AST | None]]":
    """(qualname, body, function node) — the module body (minus defs) and every function, as the
    ratio gate scopes them: a comparison in an inner function does not certify an outer one."""
    out = [("<module>", [n for n in tree.body if not isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))], None)]

    def visit(nodes, prefix):
        for n in nodes:
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
                q = f"{prefix}{n.name}"
                out.append((q, n.body, n))
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
    """Every node in the scope, not descending into nested function/class bodies or lambdas."""
    stack = list(nodes)
    while stack:
        n = stack.pop()
        yield n
        for child in ast.iter_child_nodes(n):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
                continue
            stack.append(child)


def _bindings(node: ast.AST):
    """(targets, value) for every node that binds a name from an expression, else None."""
    if isinstance(node, ast.Assign):
        return node.targets, node.value
    if isinstance(node, (ast.AnnAssign, ast.AugAssign)) and node.value is not None:
        return [node.target], node.value
    if isinstance(node, ast.NamedExpr):
        return [node.target], node.value
    if isinstance(node, (ast.For, ast.AsyncFor, ast.comprehension)):
        return [node.target], node.iter
    return None


def _comment_marks(source: str, rel: str) -> "dict[int, list[tuple[str, str]]]":
    """{line: [(kind, payload)]} for every threshold marker in a COMMENT token. Raises Unreadable."""
    out: dict = {}
    if "threshold-" not in source:  # exact: a marker comment carries this substring
        return out
    try:
        for tok in tokenize.generate_tokens(io.StringIO(source).readline):
            if tok.type == tokenize.COMMENT:
                m = MARK_RE.search(tok.string)
                if m:
                    out.setdefault(tok.start[0], []).append((m.group(1), m.group(2).strip()))
    except (tokenize.TokenError, SyntaxError) as e:
        raise Unreadable(f"{rel}: cannot tokenize ({e})")
    return out


def analyse_canary(rel: str, source: str, owed_ids: "set[str]") -> dict:
    """Pure. {'sites': [(key, [uncovered roots])], 'bad': [...], 'registered': n, 'exempt': n}.
    Raises Unreadable."""
    try:
        tree = ast.parse(source, filename=rel)
    except SyntaxError as e:
        raise Unreadable(f"{rel}: cannot parse ({e.msg} at line {e.lineno})")
    marks = _comment_marks(source, rel)

    # Every marker is judged, wherever it sits: a false registration claim is a finding by itself.
    bad: list = []
    valid_at: dict = {}
    for line, found in sorted(marks.items()):
        for kind, payload in found:
            if kind == "revisit":
                ident = payload.split()[0] if payload.split() else ""
                if ident not in owed_ids:
                    bad.append(f"{rel} line {line}: threshold-revisit id {ident!r} is not a reads[].id in "
                               f"{OWED_READS_REL} — register the revisit there first")
                    continue
                valid_at.setdefault(line, []).append("registered")
            else:
                reason = payload
                if len(reason) < MIN_EXEMPT_REASON:
                    bad.append(f"{rel} line {line}: threshold-exempt reason {reason!r} is shorter than "
                               f"{MIN_EXEMPT_REASON} chars — an exemption names a bound, not a calibration")
                    continue
                valid_at.setdefault(line, []).append("exempt")

    # Module-level thresholds, in source order, so a derivation sees what it derives from.
    module_nodes = [n for n in _walk_scope(_scopes(tree)[0][1]) if isinstance(n, (ast.Assign, ast.AnnAssign))]
    module_nodes.sort(key=lambda n: (n.lineno, n.col_offset))
    consts: dict = {}  # name -> {'sources': frozenset | None, 'cover': str | None}
    for stmt in module_nodes:
        if stmt.value is None:
            continue
        pairs = []
        for t in (stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]):
            if isinstance(t, ast.Name):
                pairs.append((t.id, stmt.value))
            elif isinstance(t, (ast.Tuple, ast.List)) and isinstance(stmt.value, (ast.Tuple, ast.List)) \
                    and len(t.elts) == len(stmt.value.elts):
                pairs += [(e.id, v) for e, v in zip(t.elts, stmt.value.elts) if isinstance(e, ast.Name)]
        own = [c for ln in range(stmt.lineno, (stmt.end_lineno or stmt.lineno) + 1) for c in valid_at.get(ln, [])]
        own_cover = "registered" if "registered" in own else "exempt" if "exempt" in own else None
        for target, value in pairs:
            if target in consts:
                continue
            if _numeric_literal(value) or _numeric_container(value):
                consts[target] = {"sources": None, "cover": own_cover}
                continue
            srcs = _derived_refs(value, {n: frozenset({n}) for n in consts})
            if srcs:
                consts[target] = {"sources": srcs, "cover": own_cover}

    memo: dict = {}

    def cover(name: str):
        if name not in memo:
            c = consts[name]
            got = c["cover"]
            if got is None and c["sources"]:
                inherited = [cover(s) for s in c["sources"]]
                if all(inherited):
                    got = "registered" if "registered" in inherited else "exempt"
            memo[name] = got
        return memo[name]

    sites: list = []
    registered = exempt = 0
    for qualname, body, fn in _scopes(tree):
        nodes = list(_walk_scope(body))
        local = set()
        if fn is not None:
            a = fn.args
            local |= {x.arg for x in a.posonlyargs + a.args + a.kwonlyargs}
            local |= {x.arg for x in (a.vararg, a.kwarg) if x is not None}
            local |= {n.id for n in nodes if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store)}
            local -= {g for n in nodes if isinstance(n, ast.Global) for g in n.names}
        visible = {n: frozenset({n}) for n in consts if n not in local}

        # Locals assigned from a threshold carry it — followed to a fixpoint, so chains stay visible.
        carriers: dict = {}
        changed = True
        while changed:
            changed = False
            names = {**visible, **carriers}
            for n in nodes:
                b = _bindings(n)
                if b is None:
                    continue
                roots = _refs(b[1], names)
                if not roots:
                    continue
                for t in b[0]:
                    for leaf in [x.id for x in ast.walk(t) if isinstance(x, ast.Name)]:
                        if not roots <= carriers.get(leaf, frozenset()):
                            carriers[leaf] = carriers.get(leaf, frozenset()) | roots
                            changed = True
        names = {**visible, **carriers}

        compares = [n for n in nodes if isinstance(n, ast.Compare) and any(isinstance(op, ORDERING) for op in n.ops)]
        compares.sort(key=lambda n: (n.lineno, n.col_offset))
        seen: dict = {}
        for c in compares:
            roots = frozenset()
            for operand in [c.left, *c.comparators]:
                roots |= _refs(operand, names)
            if not roots:
                continue
            covers = {r: cover(r) for r in roots}
            uncovered = sorted(r for r, v in covers.items() if v is None)
            if not uncovered:
                if "registered" in covers.values():
                    registered += 1
                else:
                    exempt += 1
                continue
            key = f"{rel}::{qualname}::{ast.unparse(c)}"
            seen[key] = seen.get(key, 0) + 1
            sites.append((key if seen[key] == 1 else f"{key}#{seen[key]}", uncovered))
    return {"sites": sites, "bad": bad, "registered": registered, "exempt": exempt}


# ─────────────────────────────── baseline ───────────────────────────────

def load_baseline(root: str) -> "list[dict] | None":
    path = os.path.join(root, BASELINE_REL)
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            rows = json.load(fh)["sites"]
        for r in rows:
            if r.get("kind") not in ("clock", "threshold"):
                raise ValueError(f"baseline row with no clock/threshold kind: {str(r)[:120]}")
            if not (r.get("file") and r.get("site") and r.get("reason") and r.get("owner")):
                raise ValueError(f"baseline row missing file/site/reason/owner: {str(r)[:120]}")
            if not r["site"].startswith(r["file"] + "::"):
                raise ValueError(f"baseline site does not start with its file: {str(r)[:120]}")
        return rows
    except Exception as e:  # noqa: BLE001
        raise Unreadable(f"baseline unreadable ({type(e).__name__}: {str(e)[:120]})")


def write_baseline(root: str, rows: "list[dict]") -> None:
    path = os.path.join(root, BASELINE_REL)
    doc = {
        "_comment": (f"{WAVE} — SHRINK-ONLY baseline for scripts/check-threshold-clock.py. Each row is "
                     "pre-existing debt: a dated revisit clock kept in prose (kind=clock), or a paging-canary "
                     "comparison against a module-level numeric threshold with no self-running revisit "
                     "(kind=threshold). Retire a clock by registering it as an ops/monitoring/owed-reads.json "
                     "row; retire a threshold with `# threshold-revisit: <id>` or a reasoned "
                     "`# threshold-exempt:` on its assignment. `--write-baseline` only ever removes rows. "
                     "There is no flag that adds one."),
        "schema_version": 1,
        "sites": sorted(rows, key=lambda r: (r["kind"], r["file"], r["site"])),
    }
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or ".", prefix=".threshold-clock-baseline.", suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    os.replace(tmp, path)


# ─────────────────────────────── evaluation ───────────────────────────────

def evaluate_tree(root: str, mode: str = "check", today: "str | None" = None) -> "tuple[str, list[str]]":
    """Returns (verdict, report lines). mode: check | write-baseline | init-baseline."""
    today = today or _utc_today()
    report: list = []
    try:
        canaries, owners = load_inventory(root)
        owed_ids = load_owed_ids(root)
    except Unreadable as e:
        return INDET, [f"  {e}"]
    clock_files = list_clock_files(root)
    if not clock_files:
        return INDET, ["  clock scope: 0 files under src/ ops/ scripts/ — an empty scope is vacuity, not a clean tree"]
    if not canaries:
        return INDET, ["  canary scope: 0 files — the inventory declares no paging canary under ops/monitoring/*.py; "
                       "an empty scope is vacuity, not a clean tree"]
    report.append(f"  scope: {len(clock_files)} clock files under src/ ops/ scripts/ ({' '.join(CLOCK_EXTS)}) · "
                  f"{len(canaries)} paging canaries (Check T: alert_ids non-empty) · {len(owed_ids)} owed-read ids")

    clocks: dict = {}
    for rel in clock_files:
        try:
            with open(os.path.join(root, rel), encoding="utf-8") as fh:
                text = fh.read()
        except (OSError, UnicodeDecodeError) as e:
            return INDET, report + [f"  {rel}: unreadable ({type(e).__name__}) — cannot verify it"]
        for key, due in scan_clocks(rel, text):
            clocks[key] = (rel, due)

    thresholds: dict = {}
    bad: list = []
    registered = exempt = 0
    for rel in canaries:
        try:
            with open(os.path.join(root, rel), encoding="utf-8") as fh:
                source = fh.read()
            res = analyse_canary(rel, source, owed_ids)
        except FileNotFoundError:
            return INDET, report + [f"  {rel}: declared in the inventory but absent — cannot verify it"]
        except (OSError, UnicodeDecodeError) as e:
            return INDET, report + [f"  {rel}: unreadable ({type(e).__name__}) — cannot verify it"]
        except Unreadable as e:
            return INDET, report + [f"  {e}"]
        for key, roots in res["sites"]:
            thresholds[key] = (rel, roots)
        bad += res["bad"]
        registered += res["registered"]
        exempt += res["exempt"]

    try:
        baseline = load_baseline(root)
    except Unreadable as e:
        return INDET, report + [f"  {e}"]

    if mode == "init-baseline":
        if baseline is not None:
            return FAIL, report + ["  --init-baseline refused: a baseline already exists (it is shrink-only)"]
        rows = [{"kind": "clock", "file": f, "site": k, "owner": owners.get(f, "unowned"),
                 "reason": (f"pre-existing dated revisit clock at {WAVE} ({today}) — retire it by registering "
                            "the revisit as an ops/monitoring/owed-reads.json row and deleting the prose date")}
                for k, (f, _due) in clocks.items()]
        rows += [{"kind": "threshold", "file": f, "site": k, "owner": owners.get(f, "unowned"),
                  "reason": (f"pre-existing paging-canary threshold at {WAVE} ({today}) — register its revisit "
                             "(# threshold-revisit: <owed-reads id>) or exempt it with a reason when this canary "
                             "is next touched")}
                 for k, (f, _roots) in thresholds.items()]
        write_baseline(root, rows)
        report.append(f"  baseline initialised with {len(clocks)} clocks + {len(thresholds)} threshold sites")
        try:
            baseline = load_baseline(root)
        except Unreadable as e:
            return INDET, report + [f"  {e}"]

    if baseline is None:
        return INDET, report + [f"  {BASELINE_REL} is absent — run --init-baseline once"]

    clock_base = {r["site"] for r in baseline if r["kind"] == "clock"}
    threshold_base = {r["site"] for r in baseline if r["kind"] == "threshold"}
    new_clocks = sorted(k for k in clocks if k not in clock_base)
    new_thresholds = sorted(k for k in thresholds if k not in threshold_base)
    stale = sorted(k for k in clock_base if k not in clocks) + sorted(k for k in threshold_base if k not in thresholds)
    baselined_clocks = sorted(k for k in clocks if k in clock_base)
    past_due = [k for k in baselined_clocks if clocks[k][1] < today]
    report.append(f"  clocks baselined {len(baselined_clocks)} ({len(past_due)} past due at {today} UTC) · "
                  f"threshold sites baselined {sum(1 for k in thresholds if k in threshold_base)} · "
                  f"registered {registered} · exempt {exempt}")
    report.append(f"  clocks: {len(clocks)} in tree · {len(clock_base)} in baseline · {len(new_clocks)} new · "
                  f"{sum(1 for k in clock_base if k not in clocks)} stale")
    report.append(f"  thresholds: {len(thresholds)} in tree · {len(threshold_base)} in baseline · "
                  f"{len(new_thresholds)} new · {sum(1 for k in threshold_base if k not in thresholds)} stale")
    for k in past_due:
        report.append(f"  PAST DUE (reported, never failed): {k} — due {clocks[k][1]}")
    for k in new_clocks:
        report.append(f"  NEW dated revisit clock: {k} — a clock kept in prose is a clock nobody runs; register "
                      f"the revisit as an {OWED_READS_REL} row (owed-read-runner.py runs it, a FAIL pages once) "
                      "and delete the prose date")
    for k in new_thresholds:
        report.append(f"  NEW threshold with no self-running revisit: {k} — compares against "
                      f"{', '.join(thresholds[k][1])}; on the constant's assignment put `# threshold-revisit: <id>` "
                      f"(register the revisit as an {OWED_READS_REL} row) or `# threshold-exempt: <reason>` "
                      f"(≥{MIN_EXEMPT_REASON} chars: a bound, not a calibration)")
    for b in bad:
        report.append(f"  bad threshold marker: {b}")
    for k in stale:
        report.append(f"  stale baseline row (site gone — shrink with --write-baseline): {k}")

    findings = new_clocks or new_thresholds or bad
    if mode == "write-baseline":
        if findings:
            return FAIL, report + ["  --write-baseline refused: it only removes rows; register, exempt or delete the new sites"]
        kept = [r for r in baseline if r["site"] in (clocks if r["kind"] == "clock" else thresholds)]
        write_baseline(root, kept)
        report.append(f"  baseline shrunk to {len(kept)} rows")
        return PASS, report
    return (FAIL if findings else PASS), report


# ─────────────────────────────── self-test ───────────────────────────────

def self_test() -> int:
    failures: list = []
    passed = 0

    def check_one(label: str, fn) -> None:
        nonlocal passed
        try:
            ok = bool(fn())
        except Exception as e:  # noqa: BLE001
            ok = False
            label = f"{label} [raised {type(e).__name__}: {str(e)[:80]}]"
        print(f"  {'PASS' if ok else 'FAIL'}  {label}")
        if ok:
            passed += 1
        else:
            failures.append(label)

    # A planted clock, assembled from fragments so this file never carries one.
    def clock(date: str, lead: str = "# TODO: ") -> str:
        return f"{lead}{_W_REVISIT} {_W_BY} {date} - re-tune this pin"

    OWED = {"real-read"}

    def t(src: str) -> dict:
        return analyse_canary("ops/monitoring/x.py", src, OWED)

    def keys(src: str) -> list:
        return [k for k, _roots in t(src)["sites"]]

    TABLE = 'T = {"A": 1.0, "_DEFAULT": 2.0}\n'
    corpus_t = {
        "a module pin compared directly": ("PIN = 7\ndef f(x):\n    return x > PIN\n",
                                           ["ops/monitoring/x.py::f::x > PIN"]),
        "a module pin compared at module level": ("PIN = 7\nif PIN >= 3:\n    pass\n",
                                                  ["ops/monitoring/x.py::<module>::PIN >= 3"]),
        "constant arithmetic is a numeric literal": ("MAX_AGE_S = 6 * 3600\ndef f(age):\n    return age > MAX_AGE_S\n",
                                                     ["ops/monitoring/x.py::f::age > MAX_AGE_S"]),
        "a subscript of a numeric table": (TABLE + "def f(v, x):\n    return x > T[v]\n",
                                           ["ops/monitoring/x.py::f::x > T[v]"]),
        "a .get() of a numeric table": (TABLE + "def f(v, x):\n    return x >= T.get(v, T['_DEFAULT'])\n",
                                        ["ops/monitoring/x.py::f::x >= T.get(v, T['_DEFAULT'])"]),
        "through a local assigned from one": (TABLE + "def f(v, x):\n    cap = T.get(v, 1.0)\n    if x > cap:\n        return 1\n",
                                              ["ops/monitoring/x.py::f::x > cap"]),
        "through a chain of locals (fixpoint)": (TABLE + "def f(v, x):\n    cap = T[v]\n    lim = cap * 2\n    return x > lim\n",
                                                 ["ops/monitoring/x.py::f::x > lim"]),
        "a for target over a table's items": (TABLE + "def f(x):\n    for v, cap in T.items():\n        if x > cap:\n            return v\n",
                                              ["ops/monitoring/x.py::f::x > cap"]),
        "a module-level derivation is still the pin (the floor-pins shape)": (
            'M = {"A": 10, "B": 4}\nK = 3\nP = {v: K * m for v, m in M.items()}\n'
            "def f(v, n, pins=None):\n    pins = P if pins is None else pins\n    return n > pins.get(v, 0)\n",
            ["ops/monitoring/x.py::f::n > pins.get(v, 0)"]),
        "repeats are numbered, never line-keyed": ("PIN = 7\ndef f(x):\n    a = x > PIN\n    b = x > PIN\n    return a and b\n",
                                                   ["ops/monitoring/x.py::f::x > PIN", "ops/monitoring/x.py::f::x > PIN#2"]),
        "equality is not a threshold comparison": ("PIN = 7\ndef f(x):\n    return x == PIN\n", []),
        "a string constant is not a pin": ('NAME = "x"\ndef f(a):\n    return a > NAME\n', []),
        "a bool is not a numeric literal": ("ON = True\ndef f(a):\n    return a > ON\n", []),
        "a mixed table is not a numeric table": ('C = {"n": 3, "label": "x"}\ndef f(a):\n    return a > C["n"]\n', []),
        "a call result is a boundary, not a threshold": ("PIN = 7\ndef f():\n    rows = fetch(PIN)\n    return len(rows) > 0\n", []),
        "a parameter shadows the module pin": ("PIN = 7\ndef f(PIN, x):\n    return x > PIN\n", []),
        "a local never compared is not a site": ("PIN = 7\ndef f(x):\n    y = PIN\n    return y\n", []),
        "a registered pin passes": ("PIN = 7  # threshold-revisit: real-read\ndef f(x):\n    return x > PIN\n", []),
        "a reasoned exemption passes": ("PIN = 7  # threshold-exempt: protocol bound, not a calibration\ndef f(x):\n    return x > PIN\n", []),
        "a derivation of a registered table inherits its cover": (
            'M = {"A": 10}  # threshold-revisit: real-read\nP = {v: 3 * m for v, m in M.items()}\n'
            "def f(v, n):\n    return n > P[v]\n", []),
        "registering a derivation does not cover its source table": (
            'M = {"A": 10}\nP = {v: 3 * m for v, m in M.items()}  # threshold-revisit: real-read\nQ = P\n'
            "def f(v, n):\n    return n > M[v]\n", ["ops/monitoring/x.py::f::n > M[v]"]),
        "a marker on a multi-line table's inner line covers the table": (
            'T = {\n    "A": 1.0,  # threshold-exempt: protocol bound, not a calibration\n}\ndef f(x):\n    return x > T["A"]\n', []),
    }
    if not corpus_t:
        print("  SELF-TEST: INDETERMINATE — the constructed corpus is empty")
        print(f"{TOKEN}={INDET}")
        return EXIT_FOR[INDET]

    check_one("PASS maps to 0", lambda: EXIT_FOR[PASS] == 0)
    check_one("FAIL maps to 1", lambda: EXIT_FOR[FAIL] == 1)
    check_one("INDETERMINATE maps to 3", lambda: EXIT_FOR[INDET] == 3)

    # ── Check M, both ways.
    check_one("M: a planted clock is a site, with its date",
              lambda: scan_clocks("src/a.ts", "x\n" + clock("2027-01-01", "// TODO: ") + "\n")
              == [("src/a.ts::" + clock("2027-01-01", "// TODO: "), "2027-01-01")])
    check_one("M: any case, and the TODO(...) form",
              lambda: len(scan_clocks("a.py", clock("2026-01-02").upper() + "\n" + "TODO(" + clock("2026-01-03", "") + ")\n")) == 2)
    check_one("M: identical lines are numbered, not line-keyed",
              lambda: [k for k, _ in scan_clocks("a.sh", clock("2026-01-01") + "\n" + "  " + clock("2026-01-01") + "\n")]
              == ["a.sh::" + clock("2026-01-01"), "a.sh::" + clock("2026-01-01") + "#2"])
    check_one("M: a revisit with no ISO date is not a clock",
              lambda: scan_clocks("a.py", f"# {_W_REVISIT} {_W_BY} next week\n# {_W_REVISIT}-{_W_BY} 2026-01-01\n") == [])

    def own_source_is_clean() -> bool:
        with open(os.path.abspath(__file__), encoding="utf-8") as fh:
            return scan_clocks("self", fh.read()) == []
    check_one("M: this gate's own source carries no clock (the needle is built from fragments)", own_source_is_clean)

    # ── Check T, both ways.
    for label, (src, want) in corpus_t.items():
        check_one(f"T: {label}", lambda src=src, want=want: keys(src) == want)
    check_one("T: a registered site is counted as registered",
              lambda: t("PIN = 7  # threshold-revisit: real-read\ndef f(x):\n    return x > PIN\n")["registered"] == 1)
    check_one("T: an exempt site is counted as exempt",
              lambda: t("PIN = 7  # threshold-exempt: protocol bound, not a calibration\ndef f(x):\n    return x > PIN\n")["exempt"] == 1)
    check_one("T: an unknown owed-read id is a finding AND leaves the site uncovered",
              lambda: (lambda r: len(r["bad"]) == 1 and len(r["sites"]) == 1)(
                  t("PIN = 7  # threshold-revisit: no-such-read\ndef f(x):\n    return x > PIN\n")))
    check_one("T: an empty owed-read id is a finding",
              lambda: len(t("PIN = 7  # threshold-revisit:\ndef f(x):\n    return x > PIN\n")["bad"]) == 1)
    check_one("T: a short exemption reason is a finding",
              lambda: len(t("PIN = 7  # threshold-exempt: short\ndef f(x):\n    return x > PIN\n")["bad"]) == 1)
    check_one("T: a marker inside a string is not a marker",
              lambda: t('DOC = "# threshold-revisit: no-such-read"\n')["bad"] == [])

    def unparseable() -> bool:
        try:
            t("def broken(:\n")
            return False
        except Unreadable:
            return True
    check_one("T: an unparseable canary is Unreadable (→ INDETERMINATE), never zero sites", unparseable)

    # ── end-to-end over a constructed tree: INDETERMINATE first, baseline semantics, vacuity.
    with tempfile.TemporaryDirectory() as root:
        def put(rel, text):
            os.makedirs(os.path.dirname(os.path.join(root, rel)), exist_ok=True)
            with open(os.path.join(root, rel), "w", encoding="utf-8") as fh:
                fh.write(text)

        def inventory(rows):
            put(INVENTORY_REL, json.dumps({"artifacts": rows}))

        PAGING = {"id": "a", "artifact": "ops/monitoring/a.py", "alert_ids": ["A"], "owner_wave": "W-A"}
        QUIET = {"id": "b", "artifact": "ops/monitoring/b.py", "alert_ids": [], "owner_wave": "W-B"}
        CANARY = "PIN = 7\ndef f(x):\n    return x > PIN\n"
        inventory([PAGING, QUIET])
        put(OWED_READS_REL, json.dumps({"reads": [{"id": "real-read"}]}))
        check_one("an empty clock scope is INDETERMINATE (vacuity), never PASS",
                  lambda: (lambda v: v[0] == INDET and any("clock scope: 0 files" in ln for ln in v[1]))(evaluate_tree(root)))
        put("ops/monitoring/a.py", CANARY)
        put("ops/monitoring/b.py", CANARY)  # not a paging canary — out of Check T's scope
        put("src/x.ts", "// " + clock("2026-01-01", "TODO: ") + "\n// " + clock("2027-01-01", "TODO: ") + "\n")
        put("scripts/y.sh", "echo ok\n")
        day = "2026-11-12"
        check_one("no baseline yet → INDETERMINATE (never a silent pass)", lambda: evaluate_tree(root, today=day)[0] == INDET)
        check_one("--init-baseline seeds every current site", lambda: evaluate_tree(root, "init-baseline", day)[0] == PASS)
        check_one("…2 clocks + 1 threshold, only the paging canary's",
                  lambda: sorted((r["kind"], r["file"]) for r in load_baseline(root))
                  == [("clock", "src/x.ts"), ("clock", "src/x.ts"), ("threshold", "ops/monitoring/a.py")])
        check_one("…attributed to the inventory owner, else unowned",
                  lambda: {r["file"]: r["owner"] for r in load_baseline(root)} == {"src/x.ts": "unowned", "ops/monitoring/a.py": "W-A"})
        v, rep = evaluate_tree(root, today=day)
        check_one("a baselined tree PASSes and reports the past-due clock without failing",
                  lambda: v == PASS and any("(1 past due at 2026-11-12 UTC)" in ln for ln in rep)
                  and sum("PAST DUE" in ln for ln in rep) == 1)
        check_one("--init-baseline refuses a second run", lambda: evaluate_tree(root, "init-baseline", day)[0] == FAIL)
        put("scripts/y.sh", "echo ok\n" + clock("2027-02-02") + "\n")
        check_one("M: a NEW clock FAILs", lambda: evaluate_tree(root, today=day)[0] == FAIL)
        check_one("--write-baseline refuses to absorb a new clock", lambda: evaluate_tree(root, "write-baseline", day)[0] == FAIL)
        put("scripts/y.sh", "echo ok\n")
        put("ops/monitoring/a.py", CANARY + "NEW_PIN = 9\ndef g(x):\n    return x < NEW_PIN\n")
        check_one("T: a NEW threshold FAILs", lambda: evaluate_tree(root, today=day)[0] == FAIL)
        put("ops/monitoring/a.py", CANARY + "NEW_PIN = 9  # threshold-revisit: real-read\ndef g(x):\n    return x < NEW_PIN\n")
        check_one("T: …and PASSes once registered as an owed read", lambda: evaluate_tree(root, today=day)[0] == PASS)
        put("ops/monitoring/a.py", "def f(x):\n    return x\n")
        put("src/x.ts", "// " + clock("2027-01-01", "TODO: ") + "\n")
        v, rep = evaluate_tree(root, today=day)
        check_one("a gone site REPORTs as stale and does not block",
                  lambda: v == PASS and sum("stale baseline row" in ln for ln in rep) == 2)
        check_one("--write-baseline drops exactly the gone rows",
                  lambda: evaluate_tree(root, "write-baseline", day)[0] == PASS
                  and [(r["kind"], r["file"]) for r in load_baseline(root)] == [("clock", "src/x.ts")])
        inventory([QUIET])
        check_one("an empty canary scope is INDETERMINATE (vacuity), never PASS", lambda: evaluate_tree(root, today=day)[0] == INDET)
        inventory([PAGING, QUIET])
        put(OWED_READS_REL, "{not json")
        check_one("an unreadable owed-reads registry is INDETERMINATE", lambda: evaluate_tree(root, today=day)[0] == INDET)
        put(OWED_READS_REL, json.dumps({"reads": [{"id": "real-read"}]}))
        put(BASELINE_REL, "{not json")
        check_one("an unreadable baseline is INDETERMINATE", lambda: evaluate_tree(root, today=day)[0] == INDET)
        put(INVENTORY_REL, "{not json")
        check_one("an unreadable inventory is INDETERMINATE", lambda: evaluate_tree(root, today=day)[0] == INDET)

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
