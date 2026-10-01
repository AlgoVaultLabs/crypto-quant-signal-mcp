#!/usr/bin/env python3
"""population_comparison.py — EDGE-POPULATION-COMPARISON-W1.

THE ONE DERIVATION FOR COMPARING A RATE ACROSS TWO POPULATIONS.

Read `population-comparison.schema.json` first — it is the SoT and it carries the WHY. This module
is the ONLY binding of the derivation: the two JS gates that need it
(`scripts/check-population-comparison.mjs`, `tests/unit/preregistration-support-stress-test.test.ts`)
reach it by subprocess through `--declarations`, never through a second formula. An earlier version
of this paragraph named a TypeScript binding (`src/lib/population-comparison.ts`) and a differential
corpus (`population-comparison.fixtures.json`); neither has ever existed on main. One TypeScript
port of `Arm.attainable_pp` does live outside this module — `frechetAttainablePp` in
`src/scripts/ads1/core.ts`, with no parity test — and is recorded against its owning wave rather
than gated here (OPS-PREREG-IDENTIFIABILITY-GATE-W1).

── WHAT THIS EXISTS TO PREVENT ──────────────────────────────────────────────────────────────────
A rate compared across two populations reports `Δ = Δengine − Δcomparator`. That is a statement
about the thing under test ONLY IF `Δcomparator` is zero by construction. Measured 2026-09-02 on
`signals`: `always_short` moved **+2.97pp** between arms, which alone explained most of a −5.08pp
"regression" with ZERO engine change.

**THE LAW WAS FOLLOWED, NOT BROKEN.** `CLAUDE.md`'s Benchmark-before-publish mandates edge against
the naive baselines *on the same rows* — which controls the market WITHIN an arm and is silent on
BETWEEN arms. A correctly-followed rule producing the defect is worse than a violated one, because
compliance is false assurance and review cannot catch it. That is why this is a derivation with a
refusal in it and not another sentence in the manual.

── THE REFUSAL IS THE POINT ─────────────────────────────────────────────────────────────────────
`compare_arms` REFUSES rather than repairs. An arm's excess over its own mix-matched null is bounded
by its marginals: at BUY share 0.9947 the engine cannot deviate from `pStar` by more than ±0.5pp no
matter what it does. Measured attainable widths: **1.06pp (v1) vs 38.93pp (v2)** — 36.7×, against a
declared floor of 3.0pp. A floor wider than an arm's ENTIRE attainable range means that arm cannot
influence the verdict, so the "cross-arm delta" was a single-arm level test wearing a delta's
clothes. No comparator repair fixes that; only a refusal is honest.

── …AND IT BELONGS AT DECLARATION, NOT AT READOUT (OPS-PREREG-IDENTIFIABILITY-GATE-W1) ───────────
`compare_arms` refused that floor on 2026-09-02, two days AFTER it was declared and only because a
false rollback page forced a look. The refusal never needed an outcome: `Arm.attainable_pp` is
exactly `200·min(q, 1−q, u, 1−u)` on the binarised table (u = the arm's up-share), so the side share
alone bounds it — `attainable_bound_from_share(q) = 200·min(q, 1−q)` pp, with equality whenever u
lies between min(q, 1−q) and max(q, 1−q). A share is a CARDINALITY, which a pre-registration may
probe before it lands (audits/PREREGISTRATION-PROCEDURE.md §1), so `declaration_identifiability`
decides "can this declared floor ever be reached?" before any data exists, and refuses only what
the readout refusal above would also refuse: the bound is never below the attainable width.

Verdict token: `POPULATION_COMPARISON_VERDICT=PASS|FAIL|INDETERMINATE`, exit 0/0/3.
`--declarations` is a computation, not a gate: one JSON document on stdout, exit 0 when the input
parsed (NOT_IDENTIFIABLE is a result, not an error) and 3 when it did not.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path

PASS, FAIL, INDET = "PASS", "FAIL", "INDETERMINATE"
NOT_IDENTIFIABLE = "NOT_IDENTIFIABLE"
IDENTIFIABLE = "IDENTIFIABLE"

# A declared floor is refused only when it exceeds the bound by more than float noise: 1 − 0.9 is
# 0.0999…98 in binary, so a 20pp floor on a 90/10 arm must not read as unreachable. Equality
# passes, exactly as `compare_arms`'s `floor > narrow` lets it.
DECLARATION_EPS_PP = 1e-9

SCHEMA_PATH = Path(os.environ.get(
    "POPULATION_COMPARISON_SCHEMA",
    str(Path(__file__).resolve().parent / "population-comparison.schema.json")))


def load_schema(path: Path = SCHEMA_PATH) -> dict:
    """An unreadable schema is INDETERMINATE, never a permissive default. A validator that falls
    back to 'allow everything' when it cannot read its own contract is a dark guard."""
    return json.loads(path.read_text())


class Arm:
    """One population's COUNTS, and every rate derived from them here.

    Counts in, rates out — a producer that ships a rate it alone computed is a second derivation
    nothing can check. Rates are None when the denominator is zero: a rate of zero and an absent
    rate are different facts.
    """

    __slots__ = ("label", "scored", "engine_wins", "long_wins", "short_wins", "buy_side")

    def __init__(self, label: str, scored: int, engine_wins: int, long_wins: int,
                 short_wins: int, buy_side: int) -> None:
        self.label = label
        self.scored = int(scored)
        self.engine_wins = int(engine_wins)
        self.long_wins = int(long_wins)
        self.short_wins = int(short_wins)
        self.buy_side = int(buy_side)

    # ── marginals, over ALL_SCORED (zero-return rows are in the denominator, in no win bucket) ──
    @property
    def q(self) -> float | None:
        return None if self.scored == 0 else self.buy_side / self.scored

    @property
    def p_long(self) -> float | None:
        return None if self.scored == 0 else self.long_wins / self.scored

    @property
    def p_short(self) -> float | None:
        return None if self.scored == 0 else self.short_wins / self.scored

    @property
    def p_hat(self) -> float | None:
        return None if self.scored == 0 else self.engine_wins / self.scored

    @property
    def p_star(self) -> float | None:
        """The MIX-MATCHED NULL: what a coin flip emitting THIS arm's side mix scores on THESE rows.

        The only comparator that controls for both the world and the arm's own mix. Its sibling
        `max(p_long, p_short)` is selection-coupled — it silently changes which quantity it names
        as the up-rate crosses 0.5.
        """
        if self.scored == 0:
            return None
        return self.q * self.p_long + (1 - self.q) * self.p_short

    @property
    def excess_pp(self) -> float | None:
        if self.scored == 0:
            return None
        return 100.0 * (self.p_hat - self.p_star)

    @property
    def attainable_pp(self) -> float | None:
        """Width of the excess range the marginals permit — Fréchet, on the binarised {up, not-up}
        table. Deliberately the CONSERVATIVE (wider) bound rather than the tighter 3-outcome one, so
        a refusal computed from it is never over-eager: it refuses less often than a tight bound
        would, and every refusal it does make is sound."""
        if self.scored == 0:
            return None
        q, pl = self.q, self.p_long
        d_max = min(q * (1 - pl), (1 - q) * pl)
        d_min = max(-q * pl, -(1 - q) * (1 - pl))
        return 100.0 * 2.0 * (d_max - d_min)

    def as_dict(self) -> dict:
        return {"label": self.label, "scored": self.scored, "engine_wins": self.engine_wins,
                "long_wins": self.long_wins, "short_wins": self.short_wins,
                "buy_side": self.buy_side}


class Comparison:
    __slots__ = ("verdict", "reason", "evidence")

    def __init__(self, verdict: str, reason: str, evidence: dict) -> None:
        self.verdict, self.reason, self.evidence = verdict, reason, evidence

    def __repr__(self) -> str:  # pragma: no cover - diagnostics only
        return f"Comparison({self.verdict}, {self.reason!r})"


def validate_declaration(decl: dict, schema: dict) -> list[str]:
    """Structural conformance of a declared comparison. Errors, never exceptions."""
    errs: list[str] = []
    for f in schema["required_fields"]:
        if f not in decl:
            errs.append(f"missing required field: {f}")
    if decl.get("purpose") not in schema["purpose_values"]:
        errs.append(f"purpose {decl.get('purpose')!r} not in {schema['purpose_values']}")
    basis = decl.get("basis")
    if basis in schema["banned_basis"]:
        errs.append(
            f"basis {basis!r} is BANNED: it is a marginal of the outcome distribution, so "
            f"subtracting it relocates the coupling rather than removing it")
    elif decl.get("purpose") == "EFFECT_CLAIM" and basis not in schema["basis_values"]:
        errs.append(f"EFFECT_CLAIM basis must be one of {schema['basis_values']}, got {basis!r}")
    if decl.get("denominator_convention") != schema["denominator_convention"]:
        errs.append(f"denominator_convention must be {schema['denominator_convention']!r}")
    if decl.get("purpose") == "EFFECT_CLAIM" and decl.get("aggregation") != "PER_CLUSTER":
        errs.append(
            "an EFFECT_CLAIM must aggregate PER_CLUSTER — pooling a rate across days weights the "
            "busiest day, and measured 2026-09-02 that FLIPPED THE SIGN (-1.25pp pooled vs "
            "+0.21pp unweighted daily mean)")
    return errs


def compare_arms(a: Arm, b: Arm, declared_floor_pp: float, schema: dict | None = None,
                 min_clusters: int | None = None, n_clusters: int | None = None) -> Comparison:
    """Compare two arms — or REFUSE, which is the whole point of this function.

    Order matters and is not arbitrary: EMPTINESS first (a rate with no denominator is not a rate),
    then IDENTIFIABILITY (a floor an arm cannot reach makes that arm inert), then POWER. Each check
    is strictly cheaper and strictly more certain than the next, and reporting the LAST failing
    reason instead of the FIRST would name a symptom over a cause.
    """
    schema = schema if schema is not None else load_schema()
    floor = abs(float(declared_floor_pp))
    ev: dict = {"arm_a": a.label, "arm_b": b.label,
                "scored_a": a.scored, "scored_b": b.scored,
                "declared_floor_pp": floor}

    if a.scored == 0 or b.scored == 0:
        return Comparison(INDET, "an arm has no scored rows — a rate with no denominator "
                                 "is not a rate", ev)

    ev["attainable_pp_a"] = round(a.attainable_pp, 4)
    ev["attainable_pp_b"] = round(b.attainable_pp, 4)
    ev["excess_pp_a"] = round(a.excess_pp, 4)
    ev["excess_pp_b"] = round(b.excess_pp, 4)
    ev["q_a"], ev["q_b"] = round(a.q, 4), round(b.q, 4)
    # DIAGNOSTIC ONLY — emitted so the coupling is visible, never used to gate.
    ev["diagnostic_max_naive_drift_pp"] = round(
        100.0 * (max(b.p_long, b.p_short) - max(a.p_long, a.p_short)), 4)
    ev["diagnostic_p_star_drift_pp"] = round(100.0 * (b.p_star - a.p_star), 4)

    narrow = min(a.attainable_pp, b.attainable_pp)
    ev["min_attainable_pp"] = round(narrow, 4)
    ev["capacity_ratio"] = round(max(a.attainable_pp, b.attainable_pp) / narrow, 2) if narrow else None
    if floor > narrow:
        return Comparison(
            INDET,
            f"{NOT_IDENTIFIABLE}: declared floor {floor:.2f}pp exceeds the narrower arm's ENTIRE "
            f"attainable excess range ({narrow:.2f}pp), so that arm cannot influence the verdict — "
            f"this is a single-arm level test wearing a delta's clothes, not a comparison", ev)

    floor_clusters = min_clusters if min_clusters is not None else schema["min_clusters"]
    if n_clusters is None or n_clusters < floor_clusters:
        return Comparison(INDET, f"under-clustered: {n_clusters} < {floor_clusters} required "
                                 f"(the day is the independence unit, not the row)", ev)

    delta = b.excess_pp - a.excess_pp
    ev["delta_excess_pp"] = round(delta, 4)
    if delta < -floor:
        return Comparison(FAIL, f"excess fell {abs(delta):.2f}pp, past the declared "
                                f"{floor:.2f}pp floor", ev)
    return Comparison(PASS, f"excess delta {delta:+.2f}pp within the {floor:.2f}pp floor", ev)


# ─────────────── declaration-time identifiability (OPS-PREREG-IDENTIFIABILITY-GATE-W1) ───────────────

def _is_number(x) -> bool:
    # bool is an int subclass; a JSON `true` is not a share.
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def attainable_bound_from_share(q) -> float | None:
    """Upper bound on `Arm.attainable_pp` from the side share ALONE, in pp (the unit of
    `attainable_pp`, so callers compare like with like).

    `attainable_pp` = 200·min(q, 1−q, u, 1−u) on the binarised {up, not-up} table, so
    200·min(q, 1−q) bounds it for EVERY up-share u, with equality whenever u lies in
    [min(q, 1−q), max(q, 1−q)]. Symmetric in q ↔ 1−q: pass the BUY share or the minority share,
    the answer is the same. Ties only narrow the true range, so it stays an upper bound.

    None for anything that is not a share in [0, 1] — a caller treats None as INDETERMINATE,
    never as a bound of zero (which would refuse every floor and look like a verdict).
    """
    if not _is_number(q) or q < 0.0 or q > 1.0:
        return None
    return 100.0 * 2.0 * min(q, 1.0 - q)


def declaration_identifiability(floor_pp, shares) -> dict:
    """Can a DECLARED floor ever be reached? Decided from cardinalities only, before any outcome.

    `shares`: the side share of EVERY arm the floor constrains (one for a single-arm excess, two for
    a cross-arm delta). The binding arm is the narrowest — a floor wider than one arm's whole range
    leaves that arm inert, which is the 2026-09-02 defect. The floor is taken as a magnitude, as
    `compare_arms` takes it.

    Returns {verdict, reason, floor_pp, bound_pp, bounds_pp, binding_index}. Malformed input is
    INDETERMINATE with the reason — never a verdict, because a refusal computed from garbage would
    read exactly like a real one.
    """
    out = {"verdict": INDET, "reason": "", "floor_pp": None, "bound_pp": None,
           "bounds_pp": [], "binding_index": None}
    if not _is_number(floor_pp):
        out["reason"] = f"declared floor is not a finite number: {floor_pp!r}"
        return out
    floor = abs(float(floor_pp))
    out["floor_pp"] = floor
    if not isinstance(shares, list) or not shares:
        out["reason"] = "no arm share was declared — a floor must name the share it was sized against"
        return out
    bounds = []
    for i, s in enumerate(shares):
        b = attainable_bound_from_share(s)
        if b is None:
            out["reason"] = f"arm {i}: side share {s!r} is not a number in [0, 1]"
            return out
        bounds.append(b)
    narrow = min(bounds)
    idx = bounds.index(narrow)
    out.update(bounds_pp=bounds, bound_pp=narrow, binding_index=idx)
    if floor > narrow + DECLARATION_EPS_PP:
        out["verdict"] = NOT_IDENTIFIABLE
        out["reason"] = (f"{NOT_IDENTIFIABLE}: declared floor {floor:.2f}pp exceeds 2m = {narrow:.2f}pp, "
                         f"the most the narrowest arm (index {idx}) can ever show — refuse the floor "
                         f"and restate the test (e.g. within the arm)")
    else:
        out["verdict"] = IDENTIFIABLE
        out["reason"] = f"declared floor {floor:.2f}pp is within 2m = {narrow:.2f}pp"
    return out


def run_declarations(text: str) -> tuple[int, dict]:
    """The `--declarations` contract, as a pure function so the self-test exercises the exact parser
    the JS gates reach (a hermetic self-test is blind to whatever its seam replaces).

    In:  {"declarations": [{"id": <str>, "floor_pp": <number>, "shares": [<number>, ...]}, ...]}
    Out: (0, {"results": [{"id", "verdict", "reason", "floor_pp", "bound_pp", "bounds_pp",
                           "binding_index"}, ...]})  — or (3, {"error": <why>}) when unparseable.
    """
    try:
        doc = json.loads(text)
    except (ValueError, TypeError) as e:
        return 3, {"error": f"input is not JSON: {e}"}
    decls = doc.get("declarations") if isinstance(doc, dict) else None
    if not isinstance(decls, list):
        return 3, {"error": "input must be an object carrying a 'declarations' list"}
    results = []
    for i, d in enumerate(decls):
        if not isinstance(d, dict) or "floor_pp" not in d or "shares" not in d:
            return 3, {"error": f"declaration {i} must be an object with floor_pp and shares"}
        r = declaration_identifiability(d["floor_pp"], d["shares"])
        r["id"] = d.get("id", i)
        results.append(r)
    return 0, {"results": results}


# ─────────────────────────────── self-test ───────────────────────────────

def _self_test() -> int:
    failures: list[str] = []

    def check(label: str, cond: bool) -> None:
        if cond:
            print(f"  ok   {label}")
        else:
            print(f"  FAIL {label}")
            failures.append(label)

    schema = load_schema()

    # The REAL 2026-09-02 arms, as COUNTS. Counts only — pp figures are INTERNAL and this repo
    # is public. These reproduce the incident exactly, so the suite is anchored on the defect.
    v1 = Arm("verdict_rule_version=1", scored=28144, engine_wins=13332,
             long_wins=13324, short_wins=14500, buy_side=27995)
    v2 = Arm("verdict_rule_version=2", scored=14519, engine_wins=6539,
             long_wins=6488, short_wins=7910, buy_side=11693)

    # 1. the derivation reproduces the measured incident
    check(f"v1 excess ~ +0.01pp (got {v1.excess_pp:+.3f})", abs(v1.excess_pp - 0.01) < 0.06)
    check(f"v1 attainable ~ 1.06pp (got {v1.attainable_pp:.2f})", abs(v1.attainable_pp - 1.06) < 0.15)
    check(f"v2 attainable ~ 38.9pp (got {v2.attainable_pp:.2f})", abs(v2.attainable_pp - 38.9) < 2.0)
    check("capacity ratio is order-30x, not order-1x", v2.attainable_pp / v1.attainable_pp > 20)

    # 2. THE LOAD-BEARING REFUSAL — the exact declared floor from the incident
    c = compare_arms(v1, v2, declared_floor_pp=3.0, schema=schema, n_clusters=100)
    check("floor 3.0pp on these arms ⇒ INDETERMINATE / NOT_IDENTIFIABLE",
          c.verdict == INDET and NOT_IDENTIFIABLE in c.reason)
    check("the refusal names both the floor and the measured range",
          "3.00pp" in c.reason and "1.0" in c.reason)

    # 3. …and it is NOT a blanket refusal — a floor inside both ranges is evaluated
    c2 = compare_arms(v1, v2, declared_floor_pp=0.5, schema=schema, n_clusters=100)
    check("a floor INSIDE both attainable ranges is actually evaluated",
          c2.verdict in (PASS, FAIL) and NOT_IDENTIFIABLE not in c2.reason)

    # 4. INDETERMINATE never folds to PASS
    check("under-clustered ⇒ INDETERMINATE",
          compare_arms(v1, v2, 0.5, schema, n_clusters=3).verdict == INDET)
    check("empty arm ⇒ INDETERMINATE",
          compare_arms(v1, Arm("empty", 0, 0, 0, 0, 0), 0.5, schema, n_clusters=100).verdict == INDET)

    # 5. the banned bases are REFUSED by the validator, from the schema's own list
    base = {"schema_version": 1, "comparison_id": "x", "purpose": "EFFECT_CLAIM",
            "basis": "MIX_MATCHED_NULL", "denominator_convention": "ALL_SCORED",
            "aggregation": "PER_CLUSTER", "arms": [], "declared_floor_pp": 1.0,
            "verdict": INDET}
    check("a conforming EFFECT_CLAIM declaration validates", validate_declaration(base, schema) == [])
    for banned in schema["banned_basis"]:
        d = dict(base, basis=banned)
        if not validate_declaration(d, schema):
            check(f"banned basis {banned} is refused", False)
    check("every banned basis is refused",
          all(validate_declaration(dict(base, basis=b), schema) for b in schema["banned_basis"]))
    check("MAX_NAIVE specifically is refused (the 2026-09-02 basis)",
          any("BANNED" in e for e in validate_declaration(dict(base, basis="MAX_NAIVE"), schema)))
    check("POOLED aggregation is refused for an EFFECT_CLAIM",
          any("PER_CLUSTER" in e for e in
              validate_declaration(dict(base, aggregation="POOLED_UNSTRATIFIED"), schema)))
    check("an OPERATIONAL_BOUND may pool",
          validate_declaration(dict(base, purpose="OPERATIONAL_BOUND", basis="PRIOR_WINDOW_RATE",
                                    aggregation="POOLED_UNSTRATIFIED"), schema) == []
          or all("PER_CLUSTER" not in e for e in
                 validate_declaration(dict(base, purpose="OPERATIONAL_BOUND",
                                           basis="MIX_MATCHED_NULL",
                                           aggregation="POOLED_UNSTRATIFIED"), schema)))

    # 6. THE BYPASSED ARTIFACT — nothing above reads the schema FILE's own coherence, and a
    #    schema whose banned list drifts from its basis list would silently permit the defect.
    check("schema: no value is both a legal basis and a banned one",
          not (set(schema["basis_values"]) & set(schema["banned_basis"])))
    check("schema: MAX_NAIVE is in the banned list", "MAX_NAIVE" in schema["banned_basis"])
    check("schema: the identifiability rule is declared as data",
          "attainable_pp" in schema.get("identifiability_rule", ""))
    check("schema: denominator convention is pinned",
          schema["denominator_convention"] == "ALL_SCORED")

    # 7. THE DECLARATION-TIME BOUND, property-tested against `Arm.attainable_pp` in BOTH directions.
    #    `>=` everywhere catches a bound that shrank; `==` on the equality region catches one that
    #    grew — asserting only `>=` would let `300·min(q, 1−q)` pass while refusing nothing it should.
    #    Built from COUNTS through the real `Arm`, never from a re-typed formula.
    n_grid = 10_000
    qs = sorted({i / 100 for i in range(101)} | {0.0, 0.0053, 0.5, 0.9947, 1.0})
    us = [i / 100 for i in range(101)]
    exceed = in_region = region_miss = points = 0
    for q in qs:
        buys = round(q * n_grid)
        bound = attainable_bound_from_share(buys / n_grid)
        lo, hi = min(buys, n_grid - buys), max(buys, n_grid - buys)
        for u in us:
            ups = round(u * n_grid)
            ap = Arm("grid", n_grid, 0, ups, n_grid - ups, buys).attainable_pp
            points += 1
            if bound is None or ap > bound + DECLARATION_EPS_PP:
                exceed += 1
            if lo <= ups <= hi:
                in_region += 1
                if bound is None or abs(ap - bound) > DECLARATION_EPS_PP:
                    region_miss += 1
    check("the grid carries q in {0, 0.0053, 0.5, 0.9947, 1}",
          all(x in qs for x in (0.0, 0.0053, 0.5, 0.9947, 1.0)))
    check(f"bound >= Arm.attainable_pp at every grid point ({points} points, {exceed} exceed)",
          points > 10_000 and exceed == 0)
    check(f"bound == Arm.attainable_pp on the equality region ({in_region} points, {region_miss} miss)",
          in_region > 1_000 and region_miss == 0)

    # 8. The bound is symmetric and refuses non-shares rather than inventing a zero.
    check("bound is symmetric in q <-> 1-q",
          abs(attainable_bound_from_share(0.0053) - attainable_bound_from_share(1 - 0.0053)) < 1e-12)
    check("bound of a non-share is None, never 0",
          all(attainable_bound_from_share(x) is None
              for x in (-0.01, 1.01, float("nan"), float("inf"), True, "0.5", None)))

    # 9. TRIGGER A, refused at DECLARATION — the shape `compare_arms` refused at readout above,
    #    decided here from the share alone, before a single outcome existed.
    t_a = declaration_identifiability(3.0, [0.0053])
    check(f"trigger A (m = 0.0053, floor 3.0pp) => NOT_IDENTIFIABLE, bound 1.06pp "
          f"(got {t_a['verdict']}, {t_a['bound_pp']})",
          t_a["verdict"] == NOT_IDENTIFIABLE and t_a["bound_pp"] is not None
          and abs(t_a["bound_pp"] - 1.06) < 1e-9)
    t_counts = declaration_identifiability(3.0, [v1.q])
    check("…and from the incident's own COUNTS, not only the rounded share",
          t_counts["verdict"] == NOT_IDENTIFIABLE)
    cross = declaration_identifiability(3.0, [v2.q, v1.q])
    check("a cross-arm floor binds on the NARROWER arm (v1, index 1)",
          cross["verdict"] == NOT_IDENTIFIABLE and cross["binding_index"] == 1)
    check("a floor inside the bound is IDENTIFIABLE (m = 0.2, floor 3.0pp)",
          declaration_identifiability(3.0, [0.2])["verdict"] == IDENTIFIABLE)
    check("floor == bound passes, as in compare_arms",
          declaration_identifiability(1.06, [0.0053])["verdict"] == IDENTIFIABLE)
    check("float noise at equality never refuses (20pp on a 90/10 arm, 1-0.9 = 0.0999…98)",
          declaration_identifiability(20.0, [0.9])["verdict"] == IDENTIFIABLE)
    check("the floor is a magnitude, as compare_arms takes it",
          declaration_identifiability(-3.0, [0.0053])["verdict"] == NOT_IDENTIFIABLE)
    check("malformed input is INDETERMINATE, never a verdict",
          all(declaration_identifiability(f, s)["verdict"] == INDET
              for f, s in ((3.0, []), (3.0, [1.5]), (3.0, [True]), ("3", [0.2]),
                           (float("nan"), [0.2]), (3.0, "0.2"), (None, [0.2]))))

    # 10. "Never refuses what the readout would accept": wherever the declaration refuses, the
    #     readout's own attainable width is ALSO below the floor. Implied by section 7; asserted
    #     directly because it is the property the procedure promises its authors.
    contradictions = 0
    for f in (0.5, 1.0, 1.06, 3.0, 10.0, 50.0):
        for q in qs:
            buys = round(q * n_grid)
            refused = declaration_identifiability(f, [buys / n_grid])["verdict"] == NOT_IDENTIFIABLE
            for u in us[::5]:
                ups = round(u * n_grid)
                ap = Arm("grid", n_grid, 0, ups, n_grid - ups, buys).attainable_pp
                if refused and not ap < f:
                    contradictions += 1
    check(f"every declaration-time refusal is also a readout-time refusal ({contradictions} contradict)",
          contradictions == 0)

    # 11. THE SEAM BOTH JS GATES CALL — the `--declarations` parser, through the same pure function.
    code, doc = run_declarations(json.dumps({"declarations": [
        {"id": "trigger-A", "floor_pp": 3.0, "shares": [0.0053]},
        {"id": "valid", "floor_pp": 3.0, "shares": [0.2]}]}))
    check("--declarations: well-formed input exits 0 and keeps ids and order",
          code == 0 and [r["id"] for r in doc["results"]] == ["trigger-A", "valid"]
          and [r["verdict"] for r in doc["results"]] == [NOT_IDENTIFIABLE, IDENTIFIABLE])
    check("--declarations: unparseable input exits 3 (INDETERMINATE), never 0",
          all(run_declarations(t)[0] == 3 for t in
              ("not json", "[]", '{"declarations": 1}', '{"declarations": [{"floor_pp": 3}]}')))

    total = len(failures)
    print(f"SELF-TEST: {'PASS' if total == 0 else f'FAIL ({total})'}")
    print(f"POPULATION_COMPARISON_VERDICT={PASS if total == 0 else INDET}")
    return 0 if total == 0 else 3


if __name__ == "__main__":
    import sys
    if sys.argv[1:] == ["--declarations"]:
        _code, _doc = run_declarations(sys.stdin.read())
        print(json.dumps(_doc))
        sys.exit(_code)
    sys.exit(_self_test())
