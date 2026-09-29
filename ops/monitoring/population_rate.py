#!/usr/bin/env python3
"""population_rate.py — OPS-ALARM-SINGLE-DERIVATION-W1 CH1.

THE ONE DERIVATION FOR AN ALARM RATE OVER A SINGLE POPULATION.

Sibling, deliberately separate: `population_comparison.py` owns a rate compared ACROSS two
populations (mix-matched null, per-cluster aggregation, identifiability refusal) and carries a
schema, a TypeScript binding and a shared fixture corpus that both bindings must reproduce. This
module is the single-population case — counts in, one rate out — which has no second arm, no
comparator and no TypeScript consumer, so bolting it onto that contract would make the schema lie
about what it covers. Two same-shaped modules encoding DIFFERENT purposes are a sanctioned
single-derivation exception, paired by these reciprocal notes (see population_comparison.py).

── WHAT THIS EXISTS TO PREVENT ──────────────────────────────────────────────────────────────────
`regime-budget-starvation-canary.py` paged "Interactive upstream budget is refusing PAID calls"
every night on 203 / 3,920: 203 Hyperliquid `BUDGET_CEILING` throws by ANY caller (189 from an
internal scan, 14 from a nightly labeler, 0 from the tool it named) divided by `get_market_regime`
calls on EVERY venue — two populations, one quotient, and a label neither query measured. A rate
whose numerator is not a subset of its denominator is not a small error; it is a different
quantity wearing the name of the one asked for.

── THE CONTRACT ─────────────────────────────────────────────────────────────────────────────────
  * `build_sql` emits ONE statement — `count(*) FILTER (WHERE <event>)` and `count(*)` over ONE
    `FROM` and ONE `WHERE`. The numerator is a subset of the denominator BY CONSTRUCTION.
  * `measure(run_sql, spec)` executes exactly that builder through an injected seam and parses the
    rows strictly: a row it cannot parse is raised, never guessed at.
  * `evaluate(counts, max_per_100, min_den)` decides, in this order, and the order IS the contract:
        1. num < 0 or num > den  → INDETERMINATE  instrument_defect
        2. den == 0              → INDETERMINATE  empty_population
        3. rate > max            → FAIL           rate_above_tolerance   (at ANY volume)
        4. den < min_den         → INDETERMINATE  below_floor
        5. otherwise             → PASS           within_tolerance
    A breach is information at any volume; a quiet CLEAN window cannot earn a green.
  * `bounded_fraction(num, den, label)` renders "N of D" and REFUSES num > den — the
    "29 of the last 28 days" line is unwritable through it.
  * `PopulationCounts` is constructed only here (`scripts/check-ratio-derivation.py` fails a
    construction anywhere else in scope): a caller that could build counts by hand could bypass
    `measure` and re-introduce two populations with a valid-looking object.

Verdict token: `POPULATION_RATE_VERDICT=PASS|FAIL|INDETERMINATE`, exit 0/1/3 (the token-law
default for a NEW gate). Callers gate on the TOKEN, never the exit code.

    population_rate.py --self-test     # hermetic; no DB, no network
"""
from __future__ import annotations

import re
import sys
from typing import Callable, NamedTuple, Sequence

PASS, FAIL, INDET = "PASS", "FAIL", "INDETERMINATE"
EXIT_FOR = {PASS: 0, FAIL: 1, INDET: 3}
TOKEN = "POPULATION_RATE_VERDICT"

_INT = re.compile(r"^\d+$")


class InstrumentDefect(ValueError):
    """A count pair that cannot describe one population (num > den, or negative)."""


class RateSpec(NamedTuple):
    """One population, one event, one window. `group_by` splits the SAME statement into rows; it
    never introduces a second population. (NamedTuple, not a dataclass: a dataclass with postponed
    annotations crashes on Python 3.9 when the module is loaded by path, which is how every test
    and every sibling canary's self-test loads it.)"""
    table: str
    population_where: str
    event_where: str
    window_where: str
    group_by: tuple = ()
    label: str = ""


class PopulationCounts(NamedTuple):
    """Counts for one population (or one group of it). Rates are derived here and only here."""
    label: str
    group: tuple
    numerator: int
    denominator: int

    @property
    def per_100(self) -> "float | None":
        # None when the denominator is zero: a rate of zero and an absent rate are different facts.
        if self.denominator <= 0:
            return None
        return self.numerator * 100.0 / self.denominator


class RateVerdict(NamedTuple):
    verdict: str
    reason: str
    per_100: "float | None"
    counts: PopulationCounts


def _fragment(name: str, value: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be a non-empty SQL fragment")
    if ";" in value:
        raise ValueError(f"{name} may not contain ';' — the rate is ONE statement")
    return value.strip()


def build_sql(table: str, population_where: str, event_where: str,
              group_by: Sequence[str], window_where: str) -> str:
    """ONE statement: numerator and denominator over one FROM and one WHERE. PURE."""
    table = _fragment("table", table)
    population_where = _fragment("population_where", population_where)
    event_where = _fragment("event_where", event_where)
    window_where = _fragment("window_where", window_where)
    groups = [_fragment("group_by", g) for g in (group_by or ())]
    select_groups = "".join(f"{g}, " for g in groups)
    sql = (
        f"SELECT {select_groups}"
        f"count(*) FILTER (WHERE {event_where}), count(*) "
        f"FROM {table} WHERE ({population_where}) AND ({window_where})"
    )
    if groups:
        keys = ", ".join(groups)
        sql += f" GROUP BY {keys} ORDER BY {keys}"
    return sql + ";"


def parse_counts(raw: str, spec: RateSpec) -> "list[PopulationCounts]":
    """Parse `psql -tA -F'|'` rows. Raises ValueError on any malformed row — input we were handed
    and could not parse is INDETERMINATE for the caller, never a pass."""
    width = len(spec.group_by) + 2
    out: list[PopulationCounts] = []
    for line in (raw or "").splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split("|")
        if len(parts) != width:
            raise ValueError(f"expected {width} fields, got {len(parts)}: {line[:80]!r}")
        num_s, den_s = parts[-2].strip(), parts[-1].strip()
        if not (_INT.match(num_s) and _INT.match(den_s)):
            raise ValueError(f"non-integer count in {line[:80]!r}")
        out.append(PopulationCounts(spec.label, tuple(p.strip() for p in parts[:-2]),
                                    int(num_s), int(den_s)))
    return out


def measure(run_sql: Callable[[str], str], spec: RateSpec) -> "list[PopulationCounts]":
    """Execute THE builder through the injected seam. Nothing else may produce counts."""
    sql = build_sql(spec.table, spec.population_where, spec.event_where, spec.group_by,
                    spec.window_where)
    return parse_counts(run_sql(sql), spec)


def counts_for(rows: "Sequence[PopulationCounts]", group: tuple, label: str = "") -> PopulationCounts:
    """The row for `group`, or an EMPTY population when the statement emitted none for it. A GROUP BY
    omits a group with no rows at all, and that absence must reach `evaluate` as `empty_population`
    — never as a missing key a caller papers over with a hand-built zero."""
    for c in rows:
        if tuple(c.group) == tuple(group):
            return c
    return PopulationCounts(label, tuple(group), 0, 0)


def evaluate(counts: PopulationCounts, max_per_100: float, min_den: int) -> RateVerdict:
    """The whole decision. ORDER IS LOAD-BEARING — see the module docstring."""
    num, den = counts.numerator, counts.denominator
    if num < 0 or den < 0 or num > den:
        return RateVerdict(INDET, "instrument_defect", None, counts)
    if den == 0:
        return RateVerdict(INDET, "empty_population", None, counts)
    per_100 = counts.per_100
    if per_100 > max_per_100:
        return RateVerdict(FAIL, "rate_above_tolerance", per_100, counts)
    if den < min_den:
        return RateVerdict(INDET, "below_floor", per_100, counts)
    return RateVerdict(PASS, "within_tolerance", per_100, counts)


def bounded_fraction(num: int, den: int, label: str = "") -> str:
    """"N of D <label>". Refuses a numerator larger than its own denominator."""
    if num < 0 or den < 0 or num > den:
        raise InstrumentDefect(f"{num} of {den} {label}".strip()
                               + " — a numerator cannot exceed its own denominator")
    return f"{num} of {den} {label}".strip()


def share_text(counts: PopulationCounts, label: str = "") -> str:
    """"N of D <label> (x.xx%)" through `bounded_fraction`, so a share can never read >100%."""
    base = bounded_fraction(counts.numerator, counts.denominator, label)
    rate = counts.per_100
    return base if rate is None else f"{base} ({rate:.2f}%)"


# ─────────────────────────────── self-test ───────────────────────────────

def self_test() -> int:
    failures: list[str] = []
    passed = 0

    def check_one(name: str, fn) -> None:
        # An assertion that RAISES is not an assertion — it would abort the suite instead of
        # reporting FAIL, converting "proven able to fail" into "crashes".
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

    def raises(fn, exc=ValueError) -> bool:
        try:
            fn()
        except exc:
            return True
        return False

    def ev(num, den, max_per_100=1.0, min_den=2030):
        v = evaluate(PopulationCounts("t", (), num, den), max_per_100, min_den)
        return (v.verdict, v.reason)

    # The constructed corpus. In --self-test WE build it, so an empty one is a defect in the test.
    decision_cases = [
        ("29 of 28 is an instrument defect, not a rate", ev(29, 28), (INDET, "instrument_defect")),
        ("a negative count is an instrument defect", ev(-1, 28), (INDET, "instrument_defect")),
        ("an empty population is INDETERMINATE, not a division by zero", ev(0, 0), (INDET, "empty_population")),
        ("a breach at LOW volume still FAILs", ev(60, 1000), (FAIL, "rate_above_tolerance")),
        ("a breach at HIGH volume FAILs", ev(100, 3000), (FAIL, "rate_above_tolerance")),
        ("a clean LOW-volume window is INDETERMINATE, never PASS", ev(0, 1000), (INDET, "below_floor")),
        ("a clean high-volume window PASSes", ev(0, 3000), (PASS, "within_tolerance")),
        ("exactly at the tolerance is not a breach", ev(30, 3000), (PASS, "within_tolerance")),
        ("one refusal above the tolerance is a breach", ev(31, 3000), (FAIL, "rate_above_tolerance")),
    ]
    if not decision_cases:
        print("  SELF-TEST: INDETERMINATE — the decision corpus is empty, so nothing below is evidence")
        print(f"{TOKEN}={INDET}")
        return EXIT_FOR[INDET]

    # ── exit-code mapping, asserted explicitly: a sibling gate once asserted tokens but never the
    # token→code MAPPING, so re-coding INDETERMINATE to 0 left it fully green.
    check_one("PASS maps to 0", lambda: EXIT_FOR[PASS] == 0)
    check_one("FAIL maps to 1", lambda: EXIT_FOR[FAIL] == 1)
    check_one("INDETERMINATE maps to 3", lambda: EXIT_FOR[INDET] == 3)

    for name, got, want in decision_cases:
        check_one(name, lambda got=got, want=want: got == want)

    # ── build_sql: ONE statement over ONE population — the bypassed artifact, asserted by shape.
    sql = build_sql("request_log", "tool_name='get_market_regime'", "verdict='E'", (), "ts > 1")
    check_one("one SELECT — the numerator is not a second query",
              lambda: len(re.findall(r"\bSELECT\b", sql)) == 1)
    check_one("one FROM — one population", lambda: len(re.findall(r"\bFROM\b", sql)) == 1)
    check_one("the event is a FILTER on the same rows",
              lambda: "count(*) FILTER (WHERE verdict='E')" in sql)
    check_one("population and window share ONE WHERE",
              lambda: "WHERE (tool_name='get_market_regime') AND (ts > 1)" in sql)
    grouped = build_sql("t", "a=1", "b=2", ("venue",), "c=3")
    check_one("grouping splits rows, it does not add a population",
              lambda: "GROUP BY venue ORDER BY venue" in grouped
              and len(re.findall(r"\bFROM\b", grouped)) == 1)
    check_one("a second statement is refused",
              lambda: raises(lambda: build_sql("t", "a=1; DROP TABLE x", "b", (), "c")))
    check_one("an empty fragment is refused", lambda: raises(lambda: build_sql("t", "", "b", (), "c")))

    # ── measure: the seam must execute THE builder, and the parser must refuse what it cannot read.
    spec = RateSpec(table="request_log", population_where="tool_name='x'", event_where="v='E'",
                    window_where="ts > 1", group_by=("slice",), label="regime")
    seen: list[str] = []

    def stub(sql_text: str) -> str:
        seen.append(sql_text)
        return "paid|2|2800\nfree|9|145\n"

    got = measure(stub, spec)
    check_one("the seam receives exactly build_sql(spec)",
              lambda: seen == [build_sql(spec.table, spec.population_where, spec.event_where,
                                         spec.group_by, spec.window_where)])
    check_one("grouped rows parse into counts",
              lambda: [(c.group, c.numerator, c.denominator) for c in got]
              == [(("paid",), 2, 2800), (("free",), 9, 145)])
    check_one("a short row is refused, never read as the wrong column",
              lambda: raises(lambda: parse_counts("2|2800\n", spec)))
    check_one("a non-integer count is refused", lambda: raises(lambda: parse_counts("paid|x|3\n", spec)))
    check_one("blank lines are not rows", lambda: parse_counts("\n\n", spec) == [])
    check_one("an absent group is an empty population, not a missing key",
              lambda: counts_for(got, ("internal",), "regime") == PopulationCounts("regime", ("internal",), 0, 0)
              and evaluate(counts_for(got, ("internal",)), 1.0, 10).reason == "empty_population")

    # ── bounded_fraction / share_text: "29 of the last 28" is unwritable.
    check_one("N of D renders", lambda: bounded_fraction(28, 28, "days") == "28 of 28 days")
    check_one("29 of 28 is refused",
              lambda: raises(lambda: bounded_fraction(29, 28, "days"), InstrumentDefect))
    check_one("a share reads its rate through the same bound",
              lambda: share_text(PopulationCounts("t", (), 3, 12), "calls") == "3 of 12 calls (25.00%)")
    check_one("a share over an empty population has no rate",
              lambda: share_text(PopulationCounts("t", (), 0, 0), "calls") == "0 of 0 calls")
    check_one("per_100 is None on an empty denominator, never 0",
              lambda: PopulationCounts("t", (), 0, 0).per_100 is None)

    def raising_is_caught() -> bool:
        # Proves check_one reports a raising subject as FAIL rather than aborting the suite.
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
    print("usage: population_rate.py --self-test   (a library; canaries import it)")
    print(f"{TOKEN}={INDET}")
    return EXIT_FOR[INDET]


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
