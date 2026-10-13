#!/usr/bin/env python3
"""detector_envelope.py — OPS-MONITORING-SIGNAL-CONTRACT-W1 CH2, CONSUMER side.

THE HALF THAT ACTUALLY STOPS D3. A producer-side contract alone would have changed nothing about
2026-08-22: `forward_capacity_signal` re-read a marker and forwarded it verbatim, so the refusal
has to live where the forwarding decision is made.

Reads the SAME SoT as the TypeScript producer — `detector-envelope.schema.json` — because the
producer is TS and the consumer is Python, and a shared code module could only ever constrain one
of them.

  decide(envelope, current_run_id, now) -> Decision(action, verdict, reason)

    FORWARD   the envelope is conforming, current, in-age, and its verdict is PASS or FAIL
    REFUSE    something is wrong with the SIGNAL, not with the system it describes

A REFUSAL IS VISIBLE. It resolves to INDETERMINATE and says why; it never resolves to silence, and
it never resolves to FAIL. An operator paged for "we could not measure" is reading a different
page from "we measured and it is bad", and collapsing the two is the defect this wave retires.

Exit: 0 = self-test passed · 1 = self-test failed · 3 = INDETERMINATE (could not run).
Callers gate on the TOKEN `DETECTOR_ENVELOPE_VERDICT=PASS|FAIL|INDETERMINATE`, never the code.
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCHEMA_PATH = Path(os.environ.get(
    "DETECTOR_ENVELOPE_SCHEMA",
    str(Path(__file__).resolve().parent / "detector-envelope.schema.json"),
))

FORWARD = "FORWARD"
REFUSE = "REFUSE"


class Decision:
    __slots__ = ("action", "verdict", "reason")

    def __init__(self, action: str, verdict: str, reason: str) -> None:
        self.action, self.verdict, self.reason = action, verdict, reason

    def __repr__(self) -> str:  # pragma: no cover - diagnostics only
        return f"Decision({self.action}, {self.verdict}, {self.reason!r})"


def load_schema(path: Path = SCHEMA_PATH) -> dict:
    """An unreadable schema is INDETERMINATE, never a permissive default.

    A validator that falls back to "allow everything" when it cannot read its own contract is a
    dark guard: it exits 0 and is indistinguishable from a healthy one.
    """
    return json.loads(path.read_text())


def _parse_iso(ts: str):
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except Exception:
        return None


# ── change_point (OPS-STEPUP-ACTIVATION-W1 CH2) ─────────────────────────────────────────────
# ONE strict grammar, shared character for character with detector-envelope.ts. Not
# `datetime.fromisoformat`: it accepts different strings on the hosts' 3.12 than on an operator's
# 3.9, and JavaScript's Date.parse accepts strings that are not ISO-8601 at all, so either would
# let the two validators disagree about the same bytes. Both sides compare at MILLISECONDS.
# re.ASCII + \Z, not $: Python's \d matches non-ASCII digits and its $ matches before a trailing
# newline; JavaScript's do neither. Without both flags the twins would disagree on those bytes.
_ISO_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))\Z", re.ASCII)
_DAILY_RE = re.compile(r"^\d+(,\d+)*\Z", re.ASCII)
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def _iso_ms(ts):
    """Epoch milliseconds of a strict ISO-8601 instant with an explicit offset, else None."""
    m = _ISO_RE.match(ts) if isinstance(ts, str) else None
    if not m:
        return None
    y, mo, d, h, mi, s, frac, _tz, sign, oh, om = m.groups()
    if int(oh or 0) > 23 or int(om or 0) > 59:
        return None
    try:
        dt = datetime(int(y), int(mo), int(d), int(h), int(mi), int(s), tzinfo=timezone.utc)
    except ValueError:
        return None
    ms = (dt - _EPOCH) // timedelta(milliseconds=1) + int((frac or "0")[:3].ljust(3, "0"))
    off = (int(oh) * 60 + int(om)) * 60000 if sign else 0
    return ms - off if sign == "+" else ms + off


def _jsonish(v) -> str:
    """Render a value the way JSON.stringify does, so both validators print identical reasons."""
    try:
        return json.dumps(v, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        return json.dumps(str(v), ensure_ascii=False)


def _change_point_errors(env: dict, schema: dict) -> list:
    """The `change_point` rule. Called only when the envelope DECLARES one — every other envelope
    is validated exactly as before this rule existed. A schema that does not declare the rule
    refuses only the envelopes that need it (read with .get(), so an older schema copy on a host
    leaves every other adopter byte-identical)."""
    fields = schema.get("change_point_fields")
    rules = schema.get("change_point_rules")
    if not isinstance(fields, list) or not isinstance(rules, dict):
        return ["change_point is declared but this schema has no change_point contract — "
                "a verdict about a change cannot be validated against it"]
    cp = env["change_point"]
    if not isinstance(cp, dict):
        return ["change_point is not an object"]
    errs = ["change_point missing '%s'" % f for f in fields if f not in cp]
    if errs:
        return errs
    at_ms = _iso_ms(cp.get("at"))
    if at_ms is None:
        errs.append("change_point.at %s is not an ISO-8601 instant" % _jsonish(cp.get("at")))
    w = env.get("observation_window")
    if rules.get("window_from_not_before_at") and isinstance(w, dict) and "from" in w:
        from_ms = _iso_ms(w["from"])
        if from_ms is None:
            errs.append("observation_window.from %s is not an ISO-8601 instant" % _jsonish(w["from"]))
        elif at_ms is not None and from_ms < at_ms:
            errs.append("observation_window.from %s is before change_point.at %s — a verdict about a "
                        "change may observe only post-change time" % (w["from"], cp["at"]))
    key = rules.get("evidence_daily_key")
    ev = env.get("evidence")
    if key and isinstance(ev, dict):
        if key not in ev:
            errs.append("evidence.%s missing — a verdict about a change carries its per-day series" % key)
        elif not isinstance(ev[key], str) or not _DAILY_RE.match(ev[key]):
            errs.append("evidence.%s %s is not a per-day series (comma-joined non-negative integers)"
                        % (key, _jsonish(ev[key])))
    return errs


def validate(env, schema: dict) -> list:
    """Every reason this envelope is non-conforming. Empty list = conforming.

    Deliberately mirrors `src/lib/detector-envelope.ts::validateEnvelope` rule for rule; the pair
    is pinned by `tests/unit/detector-envelope.test.ts`, which runs BOTH sides over one shared
    fixture set so the two implementations cannot drift into disagreeing about the same bytes.
    """
    errs = []
    if not isinstance(env, dict):
        return ["envelope is not an object"]
    for f in schema["required_fields"]:
        if f not in env:
            errs.append("missing required field '%s'" % f)
    if "schema_version" in env and env["schema_version"] != schema["schema_version"]:
        errs.append("schema_version %s != %s" % (env["schema_version"], schema["schema_version"]))
    if "verdict" in env and env["verdict"] not in schema["verdict_values"]:
        errs.append("verdict '%s' is not one of %s" % (env["verdict"], "|".join(schema["verdict_values"])))
    if "run_outcome" in env and env["run_outcome"] not in schema["run_outcome_values"]:
        errs.append("run_outcome '%s' is not a declared outcome" % env["run_outcome"])
    # The forcing rule, asserted on the WIRE. A producer that hand-rolls an envelope must not be
    # able to smuggle a conclusion its own run never reached.
    if ("run_outcome" in env and "verdict" in env
            and env["run_outcome"] not in schema["run_outcome_conclusive"]
            and env["verdict"] != "INDETERMINATE"):
        errs.append("run_outcome '%s' is not conclusive, so verdict MUST be INDETERMINATE, not '%s'"
                    % (env["run_outcome"], env["verdict"]))
    if "observation_window" in env:
        w = env["observation_window"]
        if not isinstance(w, dict):
            errs.append("observation_window is not an object")
        else:
            for f in schema["observation_window_fields"]:
                if f not in w:
                    errs.append("observation_window missing '%s'" % f)
    if "evidence" in env:
        ev = env["evidence"]
        rules = schema["evidence_rules"]
        if not isinstance(ev, dict):
            errs.append("evidence is not an object")
        else:
            if len(ev) < rules["min_keys"]:
                errs.append("evidence has %d key(s), fewer than the required %d" % (len(ev), rules["min_keys"]))
            for k, v in ev.items():
                if not isinstance(v, str):
                    continue
                words = len([w for w in v.strip().split() if w])
                if words > rules["max_prose_words"]:
                    errs.append("evidence.%s is %d words — prose about mechanism, not a measured "
                                "value (max %d)" % (k, words, rules["max_prose_words"]))
    # OPTIONAL, ADDITIVE: only an envelope that declares a change point is held to the rule.
    if "change_point" in env:
        errs.extend(_change_point_errors(env, schema))
    return errs


def decide(env, current_run_id, now=None, schema=None) -> Decision:
    """Should this envelope be forwarded to the operator?

    Order matters and is not arbitrary — CONFORMANCE first, then IDENTITY, then AGE, then VERDICT.
    Each check is strictly cheaper and strictly more certain than the next: an envelope we cannot
    parse tells us nothing about whether it is current, and one from the wrong run tells us
    nothing about whether it is fresh. Reporting the LAST failing reason instead of the first
    would name a symptom over a cause.
    """
    schema = schema if schema is not None else load_schema()
    now = now or datetime.now(timezone.utc)

    errs = validate(env, schema)
    if errs:
        return Decision(REFUSE, "INDETERMINATE", "envelope is non-conforming: %s" % "; ".join(errs[:3]))

    # IDENTITY — is this THIS run's signal? `current_run_id` of None means the consumer could not
    # determine the current run, which is itself a non-answer and must not be read as a match.
    if current_run_id is None:
        return Decision(REFUSE, "INDETERMINATE",
                        "consumer could not determine the current run id — cannot confirm this "
                        "signal describes the run it is about to page for")
    if env["run_id"] != current_run_id:
        return Decision(REFUSE, "INDETERMINATE",
                        "run_id %s is not the current run %s — this signal describes an older run"
                        % (env["run_id"], current_run_id))

    # AGE. NOTE: this is NOT the control that would have stopped the 2026-08-22 page — that marker
    # WAS from the most recent run. See `_max_age_doc` in the schema.
    produced = _parse_iso(env["produced_at"])
    if produced is None:
        return Decision(REFUSE, "INDETERMINATE", "produced_at %r is not parseable ISO-8601" % env["produced_at"])
    age = (now - produced).total_seconds()
    if age > schema["max_age_seconds"]:
        return Decision(REFUSE, "INDETERMINATE",
                        "produced_at is %.0fs old, past the %ds bound" % (age, schema["max_age_seconds"]))

    # VERDICT. INDETERMINATE is FORWARDED — visibly, as itself. Suppressing it would recreate the
    # dark-guard failure mode; promoting it to FAIL would page an operator for the wrong thing.
    if env["verdict"] == "INDETERMINATE":
        return Decision(FORWARD, "INDETERMINATE",
                        "the detector could not complete its measurement (run_outcome=%s)" % env["run_outcome"])
    if env["verdict"] == "PASS":
        return Decision(REFUSE, "PASS", "measured clean — nothing to page")
    return Decision(FORWARD, "FAIL", "measured and breaching (run_outcome=%s)" % env["run_outcome"])


def render_body(env, schema=None) -> str:
    """Render an alert body from `evidence` and NOTHING ELSE.

    D2 is structural, not stylistic: the old body asserted "SLO-ordered, so majors were served
    first; the shortfall is the long-tail overflow" — the inverse of what the code does, and it
    was never true. A body built here cannot assert a mechanism, because the only strings it can
    reach are evidence values, and the schema caps those at `max_prose_words`.
    """
    schema = schema if schema is not None else load_schema()
    lines = [
        "%s %s" % (env["verdict"], env["detector"]),
        "run=%s outcome=%s" % (env["run_id"], env["run_outcome"]),
        "window=%s..%s produced=%s" % (env["observation_window"]["from"],
                                       env["observation_window"]["to"], env["produced_at"]),
    ]
    for k in sorted(env["evidence"]):
        lines.append("%s=%s" % (k, env["evidence"][k]))
    return "\n".join(lines)


def _self_test() -> int:
    fails = 0

    def ck(label, got, want):
        nonlocal fails
        ok = got == want
        if not ok:
            fails += 1
        print("  %s %s — got %r, want %r" % ("PASS" if ok else "FAIL", label, got, want))

    try:
        schema = load_schema()
    except Exception as e:
        print("  could not read the schema: %s" % e)
        print("DETECTOR_ENVELOPE_VERDICT=INDETERMINATE")
        return 3

    print("detector_envelope --self-test")
    now = datetime(2026, 8, 22, 6, 53, 19, tzinfo=timezone.utc)

    def env(**over):
        base = {
            "schema_version": 1, "detector": "directional-label-capacity",
            "verdict": "FAIL", "run_id": "r1",
            "run_started_at": "2026-08-22T02:33:26Z", "run_outcome": "complete",
            "produced_at": "2026-08-22T03:20:01Z",
            "observation_window": {"from": "2026-08-22T02:33:26Z", "to": "2026-08-22T03:20:01Z"},
            "evidence": {"unreached_in_danger": "BINANCE,BITGET,BYBIT", "budget_min": 210},
        }
        base.update(over)
        return base

    ck("conforming envelope validates", validate(env(), schema), [])
    ck("a complete+FAIL run forwards", decide(env(), "r1", now, schema).action, FORWARD)
    ck("a stale run_id is REFUSED", decide(env(), "r2", now, schema).action, REFUSE)
    ck("a stale run_id refuses as INDETERMINATE, never FAIL",
       decide(env(), "r2", now, schema).verdict, "INDETERMINATE")
    ck("an unknown current run is REFUSED", decide(env(), None, now, schema).action, REFUSE)
    over_age = env(produced_at="2026-08-21T00:00:00Z")
    ck("an over-age envelope is REFUSED", decide(over_age, "r1", now, schema).action, REFUSE)
    ck("an over-age refusal names the bound",
       "past the" in decide(over_age, "r1", now, schema).reason, True)
    # The forcing rule, on the wire.
    stopped = env(run_outcome="stopped", verdict="FAIL")
    ck("a stopped run claiming FAIL is non-conforming", len(validate(stopped, schema)) > 0, True)
    ck("a stopped run's INDETERMINATE is conforming",
       validate(env(run_outcome="stopped", verdict="INDETERMINATE"), schema), [])
    ck("an INDETERMINATE envelope is FORWARDED, not silenced",
       decide(env(run_outcome="stopped", verdict="INDETERMINATE"), "r1", now, schema).action, FORWARD)
    ck("an INDETERMINATE envelope pages as INDETERMINATE, never FAIL",
       decide(env(run_outcome="stopped", verdict="INDETERMINATE"), "r1", now, schema).verdict, "INDETERMINATE")
    ck("a PASS envelope pages nobody", decide(env(verdict="PASS"), "r1", now, schema).action, REFUSE)
    # D2 — prose in evidence is rejected at the field that exists to prevent it.
    prose = env(evidence={"note": "SLO-ordered, so majors were served first; the shortfall is the long-tail overflow"})
    ck("mechanism prose in evidence is non-conforming", len(validate(prose, schema)) > 0, True)
    ck("the rendered body contains no mechanism prose",
       "long-tail overflow" in render_body(env(), schema), False)
    ck("the rendered body carries the measured values",
       "unreached_in_danger=BINANCE,BITGET,BYBIT" in render_body(env(), schema), True)
    ck("missing required field is caught", len(validate({"verdict": "PASS"}, schema)) > 0, True)
    # change_point (OPS-STEPUP-ACTIVATION-W1 CH2) — the measured case, as data.
    flip = "2026-10-12T11:24:01Z"

    def changed(**over):
        base = env(detector="stepup-activation", run_id="r1", produced_at="2026-08-22T03:20:01Z",
                   observation_window={"from": "2026-10-13T00:00:00Z", "to": "2026-10-20T00:00:00Z"},
                   change_point={"at": flip, "source": "stepup-activation-envelope.json"},
                   evidence={"client_family": "node", "cur": 4, "prior": 15, "drop_pct": 73.3,
                             "daily": "1,0,0,1,0,2,0"})
        base.update(over)
        return base

    ck("(i) a change-attributed FAIL observing only post-change time conforms", validate(changed(), schema), [])
    ck("(i) and forwards as FAIL", decide(changed(), "r1", now, schema).verdict, "FAIL")
    straddle = changed(observation_window={"from": "2026-10-06T00:00:00Z", "to": "2026-10-13T00:00:00Z"})
    ck("(ii) the 2026-10-13 page's week [10-06, 10-13) straddles the flip — refused, with the reason",
       validate(straddle, schema),
       ["observation_window.from 2026-10-06T00:00:00Z is before change_point.at 2026-10-12T11:24:01Z — "
        "a verdict about a change may observe only post-change time"])
    ck("(ii) a refused straddle never pages FAIL — it is INDETERMINATE",
       decide(straddle, "r1", now, schema).verdict, "INDETERMINATE")
    ck("(ii) one millisecond before the change is still before it",
       len(validate(changed(observation_window={"from": "2026-10-12T11:24:00.999Z", "to": "x"}), schema)), 1)
    ck("(ii) an offset is honoured: 13:24:01+02:00 IS the change instant", validate(
        changed(observation_window={"from": "2026-10-12T13:24:01+02:00", "to": "x"}), schema), [])
    no_daily = changed(evidence={"client_family": "node", "cur": 4})
    ck("(iii) a change-attributed verdict without its per-day series is refused",
       validate(no_daily, schema),
       ["evidence.daily missing — a verdict about a change carries its per-day series"])
    ck("(iii) a malformed per-day series is refused",
       len(validate(changed(evidence={"cur": 4, "daily": "1, 2"}), schema)), 1)
    ck("change_point: a missing field is named", validate(changed(change_point={"at": flip}), schema),
       ["change_point missing 'source'"])
    ck("change_point: an unparseable instant is refused, not guessed",
       validate(changed(change_point={"at": "2026-10-12", "source": "x"}), schema),
       ['change_point.at "2026-10-12" is not an ISO-8601 instant'])
    ck("change_point: a trailing newline and a non-ASCII digit are not ISO-8601 (JS agrees)",
       (_iso_ms("2026-10-12T11:24:01Z\n"), _iso_ms("2026-10-12T11:24:0\u0661Z")), (None, None))
    ck("change_point: an envelope WITHOUT one is untouched by the rule (no daily needed)",
       validate(env(evidence={"x": 1}), schema), [])
    legacy = {k: v for k, v in schema.items() if not k.startswith("change_point")}
    ck("change_point: a schema without the contract refuses ONLY change_point envelopes",
       (validate(env(), legacy), len(validate(changed(), legacy))), ([], 1))
    # PINNED LITERALLY. Reading the expectation out of the schema would mean a schema that drops a
    # field silently stops being checked — measured: a mutation removing `run_id` left both this
    # self-test and the TS suite fully green.
    ck("the schema requires EXACTLY the contracted field set",
       sorted(schema["required_fields"]),
       sorted(["schema_version", "detector", "verdict", "run_id", "run_started_at",
               "run_outcome", "produced_at", "observation_window", "evidence"]))

    if fails:
        print("SELF-TEST: %d failing check(s)" % fails)
        print("DETECTOR_ENVELOPE_VERDICT=FAIL")
        return 1
    print("DETECTOR_ENVELOPE_VERDICT=PASS")
    return 0


if __name__ == "__main__":
    sys.exit(_self_test() if "--self-test" in sys.argv else _self_test())
