#!/usr/bin/env python3
"""census_lens.py — OPS-OWED-READ-RUNNER-W1. Run a producer's census SQL VERBATIM over a cohort.

── THE PROBLEM ─────────────────────────────────────────────────────────────────────────────────
A "did this cohort catch up" read needs the producer's OWN census — `backfill-queue-census.js
--emit-sql`, whose queue, maturity, backoff and venue-reach clauses are the single derivation the
outcome-backfill canary already executes — restricted to a handful of (venue, coin) cells. Copying
that SQL and adding a WHERE clause is a second derivation of every clause in it, and the copy goes
stale the first time the emitter changes. So the lens never edits the producer's SQL. It narrows
the RELATION the SQL reads, by name:

    WITH signals AS NOT MATERIALIZED (SELECT * FROM public.signals WHERE <cohort>) <census_sql>

A CTE named `signals` shadows the table in EVERY unqualified reference of the statement — including
a derived table nested inside a scalar sub-select (the census frontier). The relation inside the CTE
is schema-QUALIFIED, which is exactly why it is not shadowed by itself, and exactly why a producer
that ever qualified ITS reference would escape the lens: the runtime parity proof (lens(ALL) equals
the unlensed row, lens(NONE) gives zeros) is what catches that, every run.

── `NOT MATERIALIZED` IS LOAD-BEARING ──────────────────────────────────────────────────────────
PostgreSQL 12+ materializes a CTE that is referenced twice, and the census references `signals`
twice. Measured on signal-1, PG 16.13, 2026-10-18 (OPS-OWED-READ-RUNNER-W1 R0.2): the plain form of
lens(ALL) planned `CTE signals -> Seq Scan rows=1,099,213 width=1201` — the whole 1,336 MB relation
copied into a tuplestore under `work_mem` 4 MB, every run. `NOT MATERIALIZED` inlines it into each
reference instead: same plan shape as the unlensed census, measured parity exact. Because a silent
1.3 GB spill on production every hour is the failure to make impossible rather than merely
unlikely, `plan_guard_sql()` EXPLAINs the lensed statement inside the reading transaction and RAISES
before it executes if any `CTE Scan` node appears.

── WHAT THIS MODULE IS ─────────────────────────────────────────────────────────────────────────
Pure string builders and a pure comparison, plus a hermetic `--self-test`. No database, no network.
Consumers: `owed-read-candle-request-24h.py` (the first owed read); every future cohort read.

    census_lens.py --self-test
"""
from __future__ import annotations

import re
import sqlite3
import sys

# The fill path's venue key: an empty `exchange` is HL. A COPY of `SQL_VENUE_EXPR`
# (src/lib/venue-candle-reach.ts:96) — Python cannot import TypeScript, so the two are pinned equal
# by tests/unit/owed-read-runner.test.ts, and every read run also asserts the producer's emitted
# coin_sql carries this exact text.
VENUE_EXPR = "COALESCE(NULLIF(exchange,''),'HL')"

# Schema-QUALIFIED on purpose: an unqualified name inside the CTE would resolve to the CTE itself.
RELATION = "public.signals"
RELATION_RE = re.compile(r"^[a-z_][a-z0-9_]*\.signals$")

# A cohort key is `<VENUE>|<COIN>`. The grammar admits no quote, space, separator or dollar sign, so a
# key can never close the literal it is quoted into — the quoting below is defence in depth.
KEY_RE = re.compile(r"^[A-Z][A-Z0-9]*\|[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$")

# The lens's head, in ONE place: lens() writes it and plan_guard_sql() recognises it, so the two can
# never disagree about what a lensed statement is. `NOT MATERIALIZED` here is what the plan guard
# proves on every run — remove it and the guard, not a slow plan, is what the next run meets.
CTE_HEAD = "WITH signals AS NOT MATERIALIZED ("

# The plan guard's GUC namespace (custom GUCs need a dot) and its dollar-quote tags.
GUARD_GUC_PREFIX = "owed.plan_"
_GUARD_TAG = "owedguard"
_SQL_TAG = "owedsql"


class LensRefused(ValueError):
    """The lens will not build a statement from this input."""


class _Whole:
    """ALL / NONE sentinels — objects, never strings, so a cohort list can never be mistaken for one."""

    def __init__(self, name: str, predicate: str):
        self.name, self.predicate = name, predicate

    def __repr__(self) -> str:
        return self.name


ALL = _Whole("ALL", "true")
NONE = _Whole("NONE", "false")


def _quote(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def cohort_predicate(keys) -> str:
    """The cohort's WHERE predicate. ALL -> `true`, NONE -> `false`, else `<venue>||'|'||coin IN (…)`."""
    if keys is ALL or keys is NONE:
        return keys.predicate
    if isinstance(keys, (str, bytes)) or not isinstance(keys, (list, tuple)):
        raise LensRefused("keys must be ALL, NONE or a list of '<VENUE>|<COIN>' strings")
    if not keys:
        raise LensRefused("an empty cohort is NONE — say so explicitly")
    bad = [k for k in keys if not isinstance(k, str) or not KEY_RE.match(k)]
    if bad:
        raise LensRefused("key(s) outside the grammar: %r" % (bad[:3],))
    if len(set(keys)) != len(keys):
        raise LensRefused("duplicate cohort key(s)")
    return "%s || '|' || coin IN (%s)" % (VENUE_EXPR, ", ".join(_quote(k) for k in keys))


def lens(sql: str, keys, relation: str = RELATION) -> str:
    """The producer's SQL, verbatim, reading only the cohort's rows of `signals`."""
    if not isinstance(sql, str) or not sql.strip():
        raise LensRefused("no SQL")
    body = sql.strip()
    if re.match(r"(?i)with\b", body):
        raise LensRefused("the SQL already begins with WITH — a second CTE list cannot be prepended")
    if not re.match(r"(?i)select\b", body):
        raise LensRefused("the SQL is not a SELECT")
    if ";" in body:
        raise LensRefused("the SQL carries a statement separator — one statement per call")
    if "$" in body:
        raise LensRefused("the SQL carries a dollar sign — the plan guard dollar-quotes it")
    if not isinstance(relation, str) or not RELATION_RE.match(relation):
        raise LensRefused("the relation must be a schema-qualified `<schema>.signals`")
    return "%sSELECT * FROM %s WHERE %s) %s" % (CTE_HEAD, relation, cohort_predicate(keys), body)


def plan_guard_sql(lensed_sql: str, name: str) -> str:
    """A DO block that EXPLAINs `lensed_sql` (no ANALYZE — nothing executes), records the plan's
    node count and CTE-Scan count in transaction-local GUCs `owed.plan_<name>_nodes` /
    `owed.plan_<name>_cte_scans`, and RAISES if any CTE Scan appears — so, under psql
    `ON_ERROR_STOP`, a materializing plan aborts the session BEFORE the statement runs.

    Read-only safe: EXPLAIN and set_config write nothing. The count is derived ONCE, here; the
    caller only reads the GUCs back."""
    if not re.match(r"^[a-z][a-z0-9_]{0,30}$", name or ""):
        raise LensRefused("guard name outside [a-z][a-z0-9_]*")
    if not isinstance(lensed_sql, str) or "$" in lensed_sql or ";" in lensed_sql:
        raise LensRefused("the guarded SQL must be one statement with no dollar sign")
    if not lensed_sql.startswith(CTE_HEAD):
        raise LensRefused("the guarded SQL is not a lensed statement")
    return (
        "DO $%(g)s$ DECLARE p json; n int; t int; BEGIN "
        "EXECUTE 'EXPLAIN (FORMAT JSON) ' || $%(s)s$%(sql)s$%(s)s$ INTO p; "
        "SELECT count(*) FILTER (WHERE x = 'CTE Scan'), count(*) INTO n, t "
        "FROM jsonb_array_elements_text(jsonb_path_query_array(p::jsonb, 'lax $.**.\"Node Type\"')) AS x; "
        "PERFORM set_config('%(p)s%(name)s_cte_scans', n::text, true); "
        "PERFORM set_config('%(p)s%(name)s_nodes', t::text, true); "
        "IF n > 0 THEN RAISE EXCEPTION 'OWED_READ_PLAN_GUARD: %% CTE Scan node(s) in the %(name)s plan "
        "— refusing to execute it', n; END IF; "
        "END $%(g)s$"
    ) % {"g": _GUARD_TAG, "s": _SQL_TAG, "sql": lensed_sql, "p": GUARD_GUC_PREFIX, "name": name}


def plan_guard_readback_sql(name: str) -> str:
    """One row `<nodes>|<cte_scans>` read from the GUCs plan_guard_sql() set."""
    return ("SELECT current_setting('%(p)s%(n)s_nodes') || '|' || current_setting('%(p)s%(n)s_cte_scans')"
            % {"p": GUARD_GUC_PREFIX, "n": name})


def is_zero_or_null(v) -> bool:
    return v is None or v == "" or v == 0 or v == "0"


def parity_problems(unlensed, lens_all, lens_none) -> list:
    """The runtime proof that the lens narrows the relation and nothing else. Rows are sequences of
    psql -tA fields (or SQLite tuples). Empty list = parity holds.

      * lens(ALL) must equal the unlensed result, row for row, column for column;
      * lens(NONE) must be zero rows, or rows whose every field is zero or NULL (an aggregate over
        nothing) — a non-zero field means some reference escaped the lens."""
    probs = []
    if [list(r) for r in unlensed] != [list(r) for r in lens_all]:
        probs.append("lens(ALL) differs from the unlensed result (%d vs %d row(s))"
                     % (len(lens_all), len(unlensed)))
    leaked = [list(r) for r in lens_none if not all(is_zero_or_null(v) for v in r)]
    if leaked:
        probs.append("lens(NONE) returned non-zero field(s) %r — a reference escaped the lens"
                     % (leaked[:2],))
    return probs


# ── Self-test ────────────────────────────────────────────────────────────────────────────────

# Floor = the measured check count, so removing any scenario trips it.
_SELF_TEST_MIN_CHECKS = 31

COHORT_FIXTURE = ["HL|SKHY", "HL|SPCX", "BINANCE|BTC"]

# The producer's census SHAPE, in SQLite: a count, a filtered count, and a frontier read from a
# derived table nested inside a scalar sub-select — the reference the lens most needs to reach.
CENSUS_FIXTURE_SQL = (
    "SELECT COUNT(*) AS backlog, COUNT(*) FILTER (WHERE created_at <= 50) AS mature, "
    "(SELECT MAX(created_at) FROM (SELECT created_at FROM signals WHERE outcome_price IS NULL "
    "ORDER BY created_at ASC LIMIT 3) q) AS frontier FROM signals WHERE outcome_price IS NULL")
# Same, but one reference QUALIFIED — the escape the NONE parity leg exists to catch.
ESCAPING_FIXTURE_SQL = (
    "SELECT COUNT(*) AS backlog, (SELECT COUNT(*) FROM main.signals) AS escaped FROM signals "
    "WHERE outcome_price IS NULL")
GROUPED_FIXTURE_SQL = (
    "SELECT " + VENUE_EXPR + " AS venue, coin, COUNT(*) FROM signals GROUP BY 1, 2 ORDER BY 1, 2")


def _fixture_db():
    db = sqlite3.connect(":memory:")
    db.execute("CREATE TABLE signals (exchange TEXT, coin TEXT, created_at INTEGER, outcome_price REAL)")
    rows = [("", "SKHY", 10, None), ("HL", "SKHY", 20, None), ("HL", "SPCX", 30, None),
            ("HL", "SPCX", 40, 1.0), ("BINANCE", "BTC", 60, None), ("BYBIT", "BTC", 5, None),
            ("", "DRAM", 70, None), ("HL", "ETH", 80, None)]
    db.executemany("INSERT INTO signals VALUES (?, ?, ?, ?)", rows)
    return db


def self_test() -> int:
    failures, ran = [], []

    def check(name, fn):
        ran.append(name)
        try:
            ok = fn()
        except Exception as e:  # noqa: BLE001 — an assertion that raises is a crash, not a verdict
            failures.append("%s: raised %s: %s" % (name, type(e).__name__, e))
            print("  [FAIL] %s (raised %s)" % (name, type(e).__name__))
            return
        if not ok:
            failures.append(name)
        print("  [%s] %s" % ("ok" if ok else "FAIL", name))

    def refused(fn, why=None):
        # `why` pins WHICH refusal fired: two layered checks can each mask the other's removal.
        try:
            fn()
        except LensRefused as e:
            return why is None or why in str(e)
        return False

    def safe(fn):
        # Fixtures are BUILT through the subject too, so a broken subject must surface as a FAIL in
        # the checks that read the fixture, never as a traceback that aborts the suite.
        try:
            return fn()
        except Exception as e:  # noqa: BLE001
            return "<raised %s: %s>" % (type(e).__name__, e)

    # ── the builder ──
    out = str(safe(lambda: lens(CENSUS_FIXTURE_SQL, COHORT_FIXTURE)))
    check("lens prepends exactly one NOT MATERIALIZED CTE over the qualified relation",
          lambda: out.startswith("WITH signals AS NOT MATERIALIZED (SELECT * FROM public.signals WHERE ")
          and out.count("WITH ") == 1)
    check("lens carries the producer's SQL VERBATIM after the CTE", lambda: out.endswith(" " + CENSUS_FIXTURE_SQL))
    check("lens predicate keys the cohort on the fill path's venue expression",
          lambda: (VENUE_EXPR + " || '|' || coin IN ('HL|SKHY', 'HL|SPCX', 'BINANCE|BTC')") in out)
    check("lens(ALL) is WHERE true", lambda: "public.signals WHERE true) " in lens(CENSUS_FIXTURE_SQL, ALL))
    check("lens(NONE) is WHERE false", lambda: "public.signals WHERE false) " in lens(CENSUS_FIXTURE_SQL, NONE))
    check("the venue expression is the fill path's (empty exchange = HL)",
          lambda: VENUE_EXPR == "COALESCE(NULLIF(exchange,''),'HL')")

    # ── #10: refuses SQL that already begins with WITH (any case, any leading space) ──
    check("refuses SQL beginning with WITH — by the WITH rule, not only as a non-SELECT",
          lambda: refused(lambda: lens("WITH x AS (SELECT 1) SELECT * FROM x", ALL), why="begins with WITH"))
    check("refuses lower-case, indented with",
          lambda: refused(lambda: lens("  with x as (select 1) select 1", ALL), why="begins with WITH"))
    check("refuses a non-SELECT statement", lambda: refused(lambda: lens("DELETE FROM signals", ALL)))
    check("refuses a statement separator", lambda: refused(lambda: lens("SELECT 1; SELECT 2", ALL)))
    check("refuses a dollar sign (the guard dollar-quotes the SQL)", lambda: refused(lambda: lens("SELECT $$x$$", ALL)))
    check("refuses empty SQL", lambda: refused(lambda: lens("   ", ALL)))
    check("refuses an unqualified relation (it would shadow itself)",
          lambda: refused(lambda: lens("SELECT 1", ALL, relation="signals")))

    # ── #11: refuses a key carrying a quote, and every other off-grammar key ──
    check("refuses a key carrying a quote", lambda: refused(lambda: lens("SELECT 1", ["HL|O'X"])))
    check("refuses a key with no venue separator", lambda: refused(lambda: lens("SELECT 1", ["SKHY"])))
    check("refuses a key with a space", lambda: refused(lambda: lens("SELECT 1", ["HL|A B"])))
    check("refuses a lower-case venue", lambda: refused(lambda: lens("SELECT 1", ["hl|SKHY"])))
    check("refuses an empty cohort (NONE must be said explicitly)", lambda: refused(lambda: lens("SELECT 1", [])))
    check("refuses a bare string cohort", lambda: refused(lambda: lens("SELECT 1", "HL|SKHY")))
    check("refuses duplicate keys", lambda: refused(lambda: lens("SELECT 1", ["HL|A", "HL|A"])))
    check("accepts an xyz-style coin and digits", lambda: "'HL|xyz:SKHY'" in lens("SELECT 1", ["HL|xyz:SKHY", "HL|1000PEPE"]))

    # ── #12: SQLite fixture, the nested scalar sub-select ──
    db = _fixture_db()

    def q(sql):
        return safe(lambda: [tuple(r) for r in db.execute(sql).fetchall()])

    unl = q(CENSUS_FIXTURE_SQL)
    all_ = q(lens(CENSUS_FIXTURE_SQL, ALL, relation="main.signals"))
    none = q(lens(CENSUS_FIXTURE_SQL, NONE, relation="main.signals"))
    coh = q(lens(CENSUS_FIXTURE_SQL, COHORT_FIXTURE, relation="main.signals"))
    check("SQLite: lens(ALL) equals the unlensed census, frontier included", lambda: all_ == unl and unl[0][2] == 20)
    check("SQLite: lens(NONE) gives zeros and a NULL frontier", lambda: none == [(0, 0, None)])
    check("SQLite: the cohort reaches the nested frontier (empty exchange counts as HL)",
          lambda: coh == [(4, 3, 30)])
    check("SQLite: parity_problems is clean on the real fixture", lambda: parity_problems(unl, all_, none) == [])
    esc_none = q(lens(ESCAPING_FIXTURE_SQL, NONE, relation="main.signals"))
    check("SQLite: a QUALIFIED reference escapes the lens and NONE parity names it",
          lambda: esc_none == [(0, 8)] and len(parity_problems(q(ESCAPING_FIXTURE_SQL),
                                                              q(lens(ESCAPING_FIXTURE_SQL, ALL, relation="main.signals")),
                                                              esc_none)) == 1)
    g_none = q(lens(GROUPED_FIXTURE_SQL, NONE, relation="main.signals"))
    check("SQLite: a grouped census under NONE is zero rows, and parity accepts that",
          lambda: g_none == [] and parity_problems(q(GROUPED_FIXTURE_SQL),
                                                   q(lens(GROUPED_FIXTURE_SQL, ALL, relation="main.signals")),
                                                   g_none) == [])
    check("parity_problems names an ALL mismatch",
          lambda: len(parity_problems([("1",)], [("2",)], [])) == 1)

    # ── the plan guard's text (the PG behaviour itself is proven live: break #13 on signal-1) ──
    g = str(safe(lambda: plan_guard_sql(lens(CENSUS_FIXTURE_SQL, ALL), "census_all")))
    check("plan guard EXPLAINs without ANALYZE and raises on a CTE Scan",
          lambda: "EXPLAIN (FORMAT JSON) " in g and "ANALYZE" not in g and "IF n > 0 THEN RAISE EXCEPTION" in g
          and "x = 'CTE Scan'" in g)
    check("plan guard records nodes + CTE scans in transaction-local GUCs",
          lambda: "set_config('owed.plan_census_all_cte_scans', n::text, true)" in g
          and "set_config('owed.plan_census_all_nodes', t::text, true)" in g
          and "owed.plan_census_all_nodes" in plan_guard_readback_sql("census_all"))
    check("plan guard refuses a statement that is not lensed (a bare census cannot be guarded)",
          lambda: refused(lambda: plan_guard_sql(CENSUS_FIXTURE_SQL, "x")))

    n = len(ran)
    ok = not failures and n >= _SELF_TEST_MIN_CHECKS
    if n < _SELF_TEST_MIN_CHECKS:
        print("  [FAIL] VACUITY: %d check(s) ran, floor is %d" % (n, _SELF_TEST_MIN_CHECKS))
    print("SELF-TEST: %s (%d check(s) ran, floor %d, %d failure(s))"
          % ("PASS" if ok else "FAIL", n, _SELF_TEST_MIN_CHECKS, len(failures)))
    return 0 if ok else 1


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        sys.exit(self_test())
    print(__doc__.strip().splitlines()[0])
    print("usage: census_lens.py --self-test")
    sys.exit(2)
