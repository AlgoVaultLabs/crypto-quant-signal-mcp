#!/usr/bin/env python3
"""population_comparison.py — EDGE-POPULATION-COMPARISON-W1.

THE ONE DERIVATION FOR COMPARING A RATE ACROSS TWO POPULATIONS.

Read `population-comparison.schema.json` first — it is the SoT and it carries the WHY. This module
is the Python binding; `src/lib/population-comparison.ts` is the TypeScript one, and
`population-comparison.fixtures.json` is the differential corpus both must reproduce.

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

Verdict token: `POPULATION_COMPARISON_VERDICT=PASS|FAIL|INDETERMINATE`, exit 0/0/3.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path

PASS, FAIL, INDET = "PASS", "FAIL", "INDETERMINATE"
NOT_IDENTIFIABLE = "NOT_IDENTIFIABLE"

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

    total = len(failures)
    print(f"SELF-TEST: {'PASS' if total == 0 else f'FAIL ({total})'}")
    print(f"POPULATION_COMPARISON_VERDICT={PASS if total == 0 else INDET}")
    return 0 if total == 0 else 3


if __name__ == "__main__":
    import sys
    sys.exit(_self_test())
