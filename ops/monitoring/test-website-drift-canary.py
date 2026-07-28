#!/usr/bin/env python3
# Regression test for website-drift-canary.py — OPS-DRIFT-CANARY-EXTRACTION-FAILURE-GUARD (2026-06-22).
# Locks the empty-set-extract -> EXTRACTION_FAILURE behavior (vs misleading "all data missing" drift)
# and proves normal drift / pass / scalar paths are unaffected. Run: python3 test-website-drift-canary.py
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "website-drift-canary.py")
spec = importlib.util.spec_from_file_location("wdc_under_test", SRC)
wdc = importlib.util.module_from_spec(spec)
sys.modules["wdc_under_test"] = wdc
spec.loader.exec_module(wdc)

failures = []


def check(name, cond):
    print(("PASS" if cond else "FAIL") + f": {name}")
    if not cond:
        failures.append(name)


def row(alert_id, ttype, **kw):
    base = {
        "alert_id": alert_id,
        "tolerance_type": ttype,
        "page_url": "https://algovault.com/track-record",
        "recommended_wave": "OPS-DASHBOARD-VENUE-DISPLAY-W{NEXT}",
    }
    base.update(kw)
    return base


# 1. EXACT_SET: empty page-set vs non-empty SoT => EXTRACTION_FAILURE (the bug this guard fixes)
r = wdc.compute_drift(row("V", "EXACT_SET"), set(), ["BINANCE", "BYBIT", "HL"], "")
check("EXACT_SET empty-page -> extraction_failure True", r["extraction_failure"] is True)
check("EXACT_SET empty-page -> fires True (still needs a human)", r["fires"] is True)
body = wdc.build_alert_body(row("V", "EXACT_SET"), r)
check("body tagged [EXTRACTION_FAILURE]", "[EXTRACTION_FAILURE]" in body)
check("body routes to canary-pattern-fix wave", "OPS-DRIFT-CANARY-PATTERN-FIX-W{NEXT}" in body)
check("body does NOT route to the data-fix wave", "OPS-DASHBOARD-VENUE-DISPLAY" not in body)
check("body tells operator to VERIFY first", "VERIFY" in body.upper())

# 2. EXACT_SET: genuine drift (both non-empty, differ) => normal fire, NOT extraction_failure
r = wdc.compute_drift(row("V", "EXACT_SET"), {"BINANCE", "BYBIT"}, ["BINANCE", "BYBIT", "HL"], "")
check("EXACT_SET real drift -> extraction_failure False", r["extraction_failure"] is False)
check("EXACT_SET real drift -> fires True", r["fires"] is True)
body = wdc.build_alert_body(row("V", "EXACT_SET"), r)
check("real-drift body uses the row data-fix wave", "OPS-DASHBOARD-VENUE-DISPLAY-W{NEXT}" in body)
check("real-drift body NOT tagged extraction_failure", "[EXTRACTION_FAILURE]" not in body)

# 3. EXACT_SET: exact match => pass
r = wdc.compute_drift(row("V", "EXACT_SET"), {"A", "B"}, ["A", "B"], "")
check("EXACT_SET match -> fires False", r["fires"] is False)
check("EXACT_SET match -> extraction_failure False", r["extraction_failure"] is False)

# 4. EXACT_SET: page non-empty but SoT empty => NOT extraction_failure (page had content)
r = wdc.compute_drift(row("V", "EXACT_SET"), {"A"}, [], "")
check("EXACT_SET page-nonempty/sot-empty -> extraction_failure False", r["extraction_failure"] is False)

# 5. EXACT_SUBSTRING_LOWER: empty page-set vs real SoT string => EXTRACTION_FAILURE
r = wdc.compute_drift(row("C", "EXACT_SUBSTRING_LOWER"), set(), "0xabc", "")
check("SUBSTRING empty-page -> extraction_failure True", r["extraction_failure"] is True)
check("SUBSTRING empty-page -> fires True", r["fires"] is True)

# 6. EXACT_SUBSTRING_LOWER: substring present => pass
r = wdc.compute_drift(row("C", "EXACT_SUBSTRING_LOWER"), {"0xabc", "0xdef"}, "0xabc", "")
check("SUBSTRING present -> fires False", r["fires"] is False)
check("SUBSTRING present -> extraction_failure False", r["extraction_failure"] is False)

# 7. Regression: scalar EXACT path unaffected by the guard
r = wdc.compute_drift(row("N", "EXACT"), 5, 5, "")
check("EXACT scalar match -> fires False", r["fires"] is False and r["extraction_failure"] is False)
r = wdc.compute_drift(row("N", "EXACT"), 4, 5, "")
check("EXACT scalar mismatch -> fires True, not extraction_failure",
      r["fires"] is True and r["extraction_failure"] is False)

# ============================================================================
# 8. MONOTONIC-COUNTER GENERATOR GUARD (OPS-MERKLE-DRIFT-TOLERANCE-W1, 2026-06-29)
# ============================================================================
MERKLE = "https://api.algovault.com/api/merkle-batches"
PERF = "https://api.algovault.com/api/performance-public"

# 8a. Monotonic detection: known cumulative accessors are monotonic
check("merkle .batches|length is monotonic",
      wdc.is_monotonic_counter(row("M", "EXACT", sot_endpoint=MERKLE, sot_jq=".batches | length")) is True)
check(".totalCalls is monotonic",
      wdc.is_monotonic_counter(row("M", "FLOOR", sot_endpoint=PERF, sot_jq=".totalCalls")) is True)
# 8b. `monotonic: true` flag opt-in (forward seam for new accessors)
check("monotonic:true flag forces monotonic",
      wdc.is_monotonic_counter(row("M", "EXACT", sot_endpoint="https://x/new", sot_jq=".newCounter", monotonic=True)) is True)
# 8c. Fixed-cardinality counts are NOT monotonic — they MUST stay EXACT
check(".exchange_count (fixed 5) is NOT monotonic",
      wdc.is_monotonic_counter(row("M", "EXACT", sot_endpoint=PERF, sot_jq=".exchange_count")) is False)
check(".timeframe_count (fixed 11) is NOT monotonic",
      wdc.is_monotonic_counter(row("M", "EXACT", sot_endpoint=PERF, sot_jq=".timeframe_count")) is False)

# 8d. validate_and_autocorrect coerces a monotonic-EXACT row to FLOOR + records it
bad_rows = [
    row("HOMEPAGE_MERKLE_COUNT_DTRF_EXACT", "EXACT", sot_endpoint=MERKLE, sot_jq=".batches | length"),
    row("HOMEPAGE_VENUE_COUNT_EXACT", "EXACT", sot_endpoint=PERF, sot_jq=".exchange_count"),  # must NOT be touched
]
viol = wdc.validate_and_autocorrect_manifest(bad_rows)
check("guard coerced exactly 1 row", len(viol) == 1)
check("guard coerced the MERKLE row", viol and viol[0][0] == "HOMEPAGE_MERKLE_COUNT_DTRF_EXACT")
check("guard recorded original tolerance EXACT", viol and viol[0][1] == "EXACT")
check("merkle row mutated in place to FLOOR", bad_rows[0]["tolerance_type"] == "FLOOR")
check("fixed-count EXACT row left UNTOUCHED", bad_rows[1]["tolerance_type"] == "EXACT")

# 8e. After coercion, the normal lag (page 79 < SoT 80) no longer fires
r = wdc.compute_drift(bad_rows[0], 79, 80, "")
check("coerced merkle FLOOR: page<SoT does NOT fire", r["fires"] is False)
# ...but a genuine SoT regression below the page floor STILL fires (data-integrity intact)
r = wdc.compute_drift(bad_rows[0], 80, 78, "")
check("coerced merkle FLOOR: SoT regression below floor STILL fires", r["fires"] is True)

# 8f. config-violation body shape (operator-action contract)
cbody = wdc.build_config_violation_body(viol)
check("config body has the config-violation header", wdc.CONFIG_VIOLATION_ALERT_ID in cbody)
check("config body routes to the CONFIG-fix wave", "OPS-DRIFT-CANARY-CONFIG-FIX-W{NEXT}" in cbody)
check("config body names the offending alert_id", "HOMEPAGE_MERKLE_COUNT_DTRF_EXACT" in cbody)
check("config body references the audit doc", wdc.AUDIT_DOC_REF in cbody)

# 8g. LOCK-IN: the REAL committed manifest has ZERO monotonic-grow rows tagged non-FLOOR.
# Fails loudly if a future edit re-introduces the merkle bug or mis-tags any new
# cumulative counter. (This is the regression that would have caught the 2026-06-29 fire.)
import yaml  # noqa: E402
REAL_MANIFEST = os.path.join(HERE, "website-drift-manifest.yaml")
with open(REAL_MANIFEST, "r", encoding="utf-8") as _f:
    _real_rows = (yaml.safe_load(_f) or {}).get("rows", [])
_real_viol = wdc.validate_and_autocorrect_manifest(_real_rows)
check(f"REAL manifest: zero monotonic-counter non-FLOOR rows (found {[v[0] for v in _real_viol]})",
      _real_viol == [])

# ============================================================================
# 9. HARDENING from the OPS-MERKLE-DRIFT-TOLERANCE-W1 adversarial verification
# ============================================================================
# 9a. Signature matching is HOST- and WHITESPACE-agnostic (apex vs api., jq spacing)
check("apex-host + no-space jq still matches monotonic",
      wdc.is_monotonic_counter(row("M", "EXACT",
          sot_endpoint="https://algovault.com/api/merkle-batches", sot_jq=".batches|length")) is True)
check("trailing-slash + extra-space jq still matches monotonic",
      wdc.is_monotonic_counter(row("M", "EXACT",
          sot_endpoint="https://api.algovault.com/api/performance-public/", sot_jq=" .totalCalls ")) is True)

# 9b. Null / non-numeric SoT FIRES under FLOOR (red-team finding 2: not a silent pass)
r = wdc.compute_drift(row("F", "FLOOR"), 80, None, "")
check("FLOOR null SoT -> FIRES (not silent pass)", r["fires"] is True)
check("FLOOR null SoT drift flags non-numeric/null",
      "non-numeric" in r["drift"].lower() or "null" in r["drift"].lower())
check("FLOOR garbage SoT -> FIRES", wdc.compute_drift(row("F", "FLOOR"), 80, "garbage", "")["fires"] is True)
# regression guard: numeric FLOOR semantics unchanged by the null branch
check("FLOOR numeric lag (79<80) still PASSES", wdc.compute_drift(row("F", "FLOOR"), 79, 80, "")["fires"] is False)
check("FLOOR numeric breach (78<80 floor) still FIRES", wdc.compute_drift(row("F", "FLOOR"), 80, 78, "")["fires"] is True)
check("FLOOR explicit 0 SoT (wipe) still FIRES", wdc.compute_drift(row("F", "FLOOR"), 80, 0, "")["fires"] is True)

# 9c. Allowlist<->manifest consistency: every registered signature matches >=1 real row
# (catches a dead/typo'd allowlist entry that would silently protect nothing).
for _ep, _jq in wdc.MONOTONIC_SOT_SIGNATURES:
    _canon = wdc._canon_sig(_ep, _jq)
    _hit = any(wdc._canon_sig(rr.get("sot_endpoint"), rr.get("sot_jq")) == _canon for rr in _real_rows)
    check(f"registered signature present in manifest: ({_ep}, {_jq})", _hit)

# ============================================================================
# 10. CROSS-RUN MONOTONIC DETECTORS (OPS-DRIFT-CANARY-MONOTONIC-DETECTOR-W1)
# ============================================================================
SIG_M = ("algovault.com/api/merkle-batches", ".batches|length")   # registered (canon form)
SIG_U = ("algovault.com/api/x", ".someCounter")                   # unregistered numeric


def mobs(sig, value, registered, numeric_unregistered=False, pages=None):
    return {sig: {"value": value, "registered": registered,
                  "numeric_unregistered": numeric_unregistered, "pages": pages or set()}}


# 10a. is_suspected_monotonic discrimination
check("suspect: strictly growing >=4 -> True", wdc.is_suspected_monotonic([10, 11, 12, 13]) is True)
check("suspect: constant -> False", wdc.is_suspected_monotonic([5, 5, 5, 5]) is False)
check("suspect: fluctuating -> False", wdc.is_suspected_monotonic([10, 11, 10, 12]) is False)
check("suspect: < min_runs -> False", wdc.is_suspected_monotonic([10, 11, 12]) is False)
check("suspect: plateau-then-up (net growth) -> True", wdc.is_suspected_monotonic([10, 10, 11, 12]) is True)

# 10b. HWM bootstrap: first obs seeds an UNCONFIRMED peak (hwm=None) — never alerts, can't be poisoned
st = {}
al = wdc.process_monotonic_observations(st, mobs(SIG_M, 80, True), set(), "t1")
check("HWM bootstrap: no alert", al == [])
check("HWM bootstrap: hwm UNCONFIRMED (None)", st[SIG_M]["hwm"] is None)
check("HWM bootstrap: pending_peak=80", st[SIG_M]["pending_peak"] == 80)

# 10c. Peak CONFIRMS only after the value persists a 2nd run (spike rejection)
al = wdc.process_monotonic_observations(st, mobs(SIG_M, 80, True), set(), "t2")
check("HWM confirm: hwm now 80 (2-run persistence)", st[SIG_M]["hwm"] == 80)
check("HWM confirm: no alert", al == [])

# 10d. Regression is CONFIRMATION-gated against the CONFIRMED peak + once-per-incident
al = wdc.process_monotonic_observations(st, mobs(SIG_M, 70, True), set(), "t3a")
check("HWM regression run 1 (streak<confirm): NO alert", not any(a["kind"] == "regression" for a in al))
check("HWM regression: confirmed peak NOT lowered (stays 80)", st[SIG_M]["hwm"] == 80)
check("HWM regression: below_peak_streak=1", st[SIG_M]["below_peak_streak"] == 1)
al = wdc.process_monotonic_observations(st, mobs(SIG_M, 70, True), set(), "t3b")
check("HWM regression run 2 (confirmed): fires once", sum(1 for a in al if a["kind"] == "regression") == 1)
al = wdc.process_monotonic_observations(st, mobs(SIG_M, 70, True), set(), "t3c")
check("HWM regression run 3: once-per-incident, NO re-fire", not any(a["kind"] == "regression" for a in al))
al = wdc.process_monotonic_observations(st, mobs(SIG_M, 90, True), set(), "t3d")
check("HWM recovery (>=peak): streak reset", st[SIG_M]["below_peak_streak"] == 0)
check("HWM recovery: incident cleared", st[SIG_M]["regression_reported"] is False)

# 10d-spike. SPIKE REJECTION: a transient HIGH read never becomes the confirmed peak
sts = {SIG_M: {"hwm": 80, "pending_peak": None, "last_value": 80, "history": [80, 80],
               "registered": True, "runs": 2, "below_peak_streak": 0,
               "regression_reported": False, "suspect_reported": False, "last_updated": "t0"}}
al = wdc.process_monotonic_observations(sts, mobs(SIG_M, 9999, True), set(), "ts1")
check("spike: implausible jump emits a spike_log", any(a["kind"] == "spike_log" for a in al))
check("spike: confirmed peak NOT poisoned (stays 80)", sts[SIG_M]["hwm"] == 80)
al = wdc.process_monotonic_observations(sts, mobs(SIG_M, 80, True), set(), "ts2")
check("spike: next normal read -> no regression (candidate abandoned)",
      not any(a["kind"] == "regression" for a in al))
check("spike: peak still 80", sts[SIG_M]["hwm"] == 80)

# 10e. FLOOR-break dedup: a sig with a same-run FLOOR break NEVER fires HWM (even across confirm window)
st2 = {SIG_M: {"hwm": 85, "pending_peak": None, "last_value": 85, "history": [80, 85],
               "registered": True, "runs": 2, "below_peak_streak": 0, "regression_reported": False}}
al = []
for _t in ("t4a", "t4b", "t4c"):
    al = wdc.process_monotonic_observations(st2, mobs(SIG_M, 70, True), {SIG_M}, _t)
check("HWM regression deduped vs FLOOR break: never fires", not any(a["kind"] == "regression" for a in al))

# 10f. Unregistered counter growing -> suspect ONCE per incident, NEVER a regression
stu = {}
suspect_fires = 0
for i, v in enumerate([10, 11, 12, 13, 14]):
    al = wdc.process_monotonic_observations(stu, mobs(SIG_U, v, False, numeric_unregistered=True), set(), f"tu{i}")
    suspect_fires += sum(1 for a in al if a["kind"] == "suspect")
check("suspect: flagged exactly ONCE across 5 growing runs (once-per-incident)", suspect_fires == 1)
last = wdc.process_monotonic_observations(stu, mobs(SIG_U, 1, False, numeric_unregistered=True), set(), "tu_drop")
check("unregistered DROP: NO regression alert (not registered)",
      not any(a["kind"] == "regression" for a in last))

# 10g. Constant fixed-count (unregistered EXACT) -> never suspect
stc = {}
SIG_C = ("algovault.com/api/performance-public", ".exchange_count")
for i in range(5):
    last = wdc.process_monotonic_observations(stc, mobs(SIG_C, 5, False, numeric_unregistered=True), set(), f"tc{i}")
check("constant fixed-count: never flagged suspect", not any(a["kind"] == "suspect" for a in last))

# 10h. State JSON round-trip preserves the peak (load now returns (state, wipe_detected))
_tf = os.path.join(HERE, "_test_monotonic_state.json")
wdc.save_monotonic_state(_tf, st)
_loaded, _wipe = wdc.load_monotonic_state(_tf)
check("state round-trip preserves hwm", _loaded.get(SIG_M, {}).get("hwm") == st[SIG_M]["hwm"])
check("state round-trip preserves incident fields",
      _loaded.get(SIG_M, {}).get("below_peak_streak") == st[SIG_M].get("below_peak_streak"))
check("fresh load: wipe_detected False", _wipe is False)
os.remove(_tf)
if os.path.exists(_tf + ".bak"):
    os.remove(_tf + ".bak")
check("load_monotonic_state missing file -> ({}, False) genuine first run",
      wdc.load_monotonic_state(os.path.join(HERE, "_does_not_exist.json")) == ({}, False))

# 10i. BAND null/non-numeric SoT FIRES (was a silent pass); in-band still passes
check("BAND null SoT -> FIRES", wdc.compute_drift(row("B", "BAND", tolerance_value=3), 91.8, None, "")["fires"] is True)
check("BAND garbage SoT -> FIRES", wdc.compute_drift(row("B", "BAND", tolerance_value=3), 91.8, "x", "")["fires"] is True)
check("BAND in-band still passes", wdc.compute_drift(row("B", "BAND", tolerance_value=3), 91.8, 91.7, "")["fires"] is False)
check("BAND out-of-band still fires", wdc.compute_drift(row("B", "BAND", tolerance_value=3), 80.0, 91.7, "")["fires"] is True)

# 10j. Suspect integer-guard (percentages intrinsically excluded) + detector fail-open
check("suspect: float/percentage growth -> False (integer guard)",
      wdc.is_suspected_monotonic([61.1, 61.2, 61.3, 61.4]) is False)
check("suspect: integer growth -> True", wdc.is_suspected_monotonic([10, 11, 12, 13]) is True)
check("suspect: bool history -> False", wdc.is_suspected_monotonic([True, True, True, True]) is False)
# process: a non-numeric observation value is skipped (no crash, no entry)
_stn = {}
_al = wdc.process_monotonic_observations(
    _stn, {SIG_M: {"value": None, "registered": True, "numeric_unregistered": False, "pages": set()}}, set(), "tn")
check("process: non-numeric value skipped (no crash, no entry)", _al == [] and SIG_M not in _stn)
# load: corrupt JSON -> {} (fail-open); a malformed entry (no jq) is skipped, valid kept
_cf = os.path.join(HERE, "_test_corrupt_state.json")
with open(_cf, "w") as _h:
    _h.write("{not valid json")
check("load: corrupt file (no backup) -> {} (fail-open)", wdc.load_monotonic_state(_cf)[0] == {})
os.remove(_cf)
if os.path.exists(_cf + ".bak"):
    os.remove(_cf + ".bak")
_mf = os.path.join(HERE, "_test_malformed_state.json")
with open(_mf, "w") as _h:
    _h.write('{"version":1,"entries":[{"endpoint":"a"},{"endpoint":"b","jq":".x","hwm":5}]}')
_ml, _ = wdc.load_monotonic_state(_mf)
check("load: malformed entry skipped, valid entry kept",
      ("b", ".x") in _ml and ("a", None) not in _ml)
os.remove(_mf)

# ============================================================================
# 11. PROMOTION-READINESS HARDENING (OPS-DRIFT-CANARY-MONOTONIC-PROMOTE-W1)
# ============================================================================
# 11a. _update_confirmed_peak: spike rejection + bootstrap-spike self-correction
_e = {"hwm": None, "pending_peak": 999}                 # bootstrap saw a transient HIGH first
wdc._update_confirmed_peak(_e, 80)                       # next read is the real value
check("peak: bootstrap spike re-seeds lower, still unconfirmed", _e["hwm"] is None and _e["pending_peak"] == 80)
wdc._update_confirmed_peak(_e, 80)                       # persists -> confirm
check("peak: confirms at the real (non-spike) value", _e["hwm"] == 80)
_e2 = {"hwm": 80, "pending_peak": None}
wdc._update_confirmed_peak(_e2, 9999)                    # update spike
check("peak: update spike not locked (pending only)", _e2["hwm"] == 80 and _e2["pending_peak"] == 9999)
wdc._update_confirmed_peak(_e2, 80)                      # falls back
check("peak: spike abandoned on fallback", _e2["hwm"] == 80 and _e2["pending_peak"] is None)

# 11b. EXACT numeric coercion (a future EXACT row missing int(match) no longer false-fires)
check("EXACT: numeric-string page '5' == SoT 5 -> no fire", wdc.compute_drift(row("N", "EXACT"), "5", 5, "")["fires"] is False)
check("EXACT: '6' vs SoT 5 -> fires", wdc.compute_drift(row("N", "EXACT"), "6", 5, "")["fires"] is True)
check("EXACT: '1,234' coerces -> matches 1234", wdc.compute_drift(row("N", "EXACT"), "1,234", 1234, "")["fires"] is False)
check("EXACT: non-numeric string still fires on mismatch", wdc.compute_drift(row("N", "EXACT"), "abc", 5, "")["fires"] is True)
check("_coerce_numeric: passes through non-numeric", wdc._coerce_numeric("abc", 5) == "abc")

# 11c. SELF_REFERENCE override is the single live path (dead EXACT/SELF_REFERENCE elif removed)
_sr = {"alert_id": "S", "tolerance_type": "EXACT", "sot_endpoint": "SELF_REFERENCE", "page_url": "u"}
_body = '<h3 class="text-white font-semibold text-sm flex-1">a</h3><h3 class="text-white font-semibold text-sm flex-1">b</h3>'
check("SELF_REFERENCE: hero 2 vs 2 cards -> no fire", wdc.compute_drift(_sr, "2", None, _body)["fires"] is False)
check("SELF_REFERENCE: hero 3 vs 2 cards -> fires", wdc.compute_drift(_sr, "3", None, _body)["fires"] is True)

# 11d. State-wipe: main file gone but .bak present -> restored + wipe flagged
_wf = os.path.join(HERE, "_test_wipe_state.json")
wdc.save_monotonic_state(_wf, {SIG_M: {"hwm": 80, "history": [80], "last_updated": "2026-06-29T00:00:00+00:00"}})
wdc.save_monotonic_state(_wf, {SIG_M: {"hwm": 81, "history": [81], "last_updated": "2026-06-29T00:00:00+00:00"}})  # rotates .bak
os.remove(_wf)                                            # simulate a wipe (main gone, .bak remains)
_rs, _rw = wdc.load_monotonic_state(_wf)
check("wipe: detected when main missing + .bak present", _rw is True)
check("wipe: restored entries from .bak", SIG_M in _rs)
for _p in (_wf, _wf + ".bak", _wf + ".tmp"):
    if os.path.exists(_p):
        os.remove(_p)

# 11e. State pruning: an entry not updated in > STATE_PRUNE_DAYS is evicted on save
from datetime import datetime, timezone, timedelta  # noqa: E402
_pf = os.path.join(HERE, "_test_prune_state.json")
_now = datetime(2026, 6, 29, tzinfo=timezone.utc)
_old_iso = (_now - timedelta(days=wdc.STATE_PRUNE_DAYS + 5)).isoformat()
_fresh_iso = _now.isoformat()
_pstate = {SIG_M: {"hwm": 80, "last_updated": _fresh_iso},
           SIG_U: {"hwm": 5, "last_updated": _old_iso}}
wdc.save_monotonic_state(_pf, _pstate, now_dt=_now)
_pl, _ = wdc.load_monotonic_state(_pf)
check("prune: stale entry evicted", SIG_U not in _pl)
check("prune: fresh entry kept", SIG_M in _pl)
for _p in (_pf, _pf + ".bak", _pf + ".tmp"):
    if os.path.exists(_p):
        os.remove(_p)

# 11f. Sig-collision: a collision-flagged observation is skipped (no alert, no state entry)
_cstate = {}
_cal = wdc.process_monotonic_observations(
    _cstate, {SIG_M: {"value": 70, "registered": True, "numeric_unregistered": False,
                      "pages": set(), "collision": True}}, set(), "tcoll")
check("collision: flagged obs skipped (no alert, no state)", _cal == [] and SIG_M not in _cstate)

# ============================================================================
# 12. 3rd-ROUND ADVERSARIAL FIXES (cache-independence, collision-by-canon-host, reset scoping,
#     body shapes) — OPS-DRIFT-CANARY-MONOTONIC-PROMOTE-W1 review follow-ups
# ============================================================================
# 12a. Collision detection is over CANONICAL hosts: apex + api. same counter = NOT a collision
check("collision: apex + api. same counter -> NO collision (canonical hosts equal)",
      wdc._is_sig_collision({"https://algovault.com/api/merkle-batches",
                             "https://api.algovault.com/api/merkle-batches"}) is False)
check("collision: two genuinely different hosts -> collision",
      wdc._is_sig_collision({"https://a.example.com/x", "https://b.other.com/x"}) is True)
check("collision: single host -> no collision", wdc._is_sig_collision({"https://api.algovault.com/x"}) is False)

# 12b. Reset token scoping: matches the JQ accessor only (not endpoint/host)
check("reset: '.totalcalls' token matches the totalCalls jq", wdc._hwm_reset_match(".totalCalls", ["totalcalls"]) is True)
check("reset: 'api' token does NOT match a jq (no host collateral)", wdc._hwm_reset_match(".totalCalls", ["api"]) is False)
check("reset: 'algovault' token does NOT match a jq", wdc._hwm_reset_match(".batches | length", ["algovault"]) is False)
check("reset: 'all' wipes everything", wdc._hwm_reset_match(".batches | length", ["all"]) is True)
check("reset: jq-substring matches the right counter only",
      wdc._hwm_reset_match(".batches | length", ["batches"]) is True and wdc._hwm_reset_match(".totalCalls", ["batches"]) is False)

# 12c. Non-independent re-run guard (cache-window): a 2nd run within min_gap_sec is skipped
_giso1 = "2026-06-29T12:00:00+00:00"
_giso2 = "2026-06-29T12:02:00+00:00"  # +120s, within a 300s cache window
_gstate = {SIG_M: {"hwm": 100, "pending_peak": None, "last_value": 70, "history": [100, 70],
                   "registered": True, "runs": 2, "below_peak_streak": 1,
                   "regression_reported": False, "suspect_reported": False, "last_updated": _giso1}}
_ga = wdc.process_monotonic_observations(_gstate, mobs(SIG_M, 70, True), set(), _giso2, min_gap_sec=300)
check("cache-independence: re-run within window skipped (streak NOT advanced)",
      _gstate[SIG_M]["below_peak_streak"] == 1 and not any(a["kind"] == "regression" for a in _ga))
# a genuinely independent run (gap > window) DOES advance + confirm
_giso3 = "2026-06-29T12:10:00+00:00"  # +600s from giso1, independent
_gb = wdc.process_monotonic_observations(_gstate, mobs(SIG_M, 70, True), set(), _giso3, min_gap_sec=300)
check("cache-independence: independent run advances streak -> confirms", any(a["kind"] == "regression" for a in _gb))
check("_iso_gap_sec: parses + returns ~120s", abs(wdc._iso_gap_sec(_giso1, _giso2) - 120) < 1)
check("_iso_gap_sec: unparseable -> None", wdc._iso_gap_sec("t1", "t2") is None)

# 12d. Alert body shapes (header + recommended-wave template + audit-ref), mirroring 8f
_rb = wdc.build_monotonic_regression_body({"sig": SIG_M, "current": 70, "hwm": 100, "runs_below": 2, "pages": set()})
check("regression body: header + wave template + audit ref",
      wdc.MONOTONIC_REGRESSION_ALERT_ID in _rb and "OPS-DRIFT-CANARY-MONOTONIC-REGRESSION-W{NEXT}" in _rb and wdc.AUDIT_DOC_REF in _rb)
_sb = wdc.build_suspected_monotonic_body({"sig": SIG_U, "current": 13, "history": [10, 11, 12, 13], "pages": set()})
check("suspect body: header + config-fix wave + audit ref",
      wdc.SUSPECTED_MONOTONIC_ALERT_ID in _sb and "OPS-DRIFT-CANARY-CONFIG-FIX-W{NEXT}" in _sb and wdc.AUDIT_DOC_REF in _sb)
_wb = wdc.build_state_reset_body(2, 2)
check("state-reset body: header + wave + audit ref",
      wdc.STATE_RESET_ALERT_ID in _wb and "W{NEXT}" in _wb and wdc.AUDIT_DOC_REF in _wb)

print()
if failures:
    print(f"RESULT: {len(failures)} FAILED -> {failures}")
    sys.exit(1)
print("RESULT: ALL PASS")
sys.exit(0)
