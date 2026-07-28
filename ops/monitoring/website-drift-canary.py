#!/usr/bin/env python3
# website-drift-canary.py — OPS-DASHBOARD-DRIFT-CANARY-W1 (2026-05-24)
# Audits algovault.com pages against /api/performance-public + /api/merkle-batches.
# Per-row drift compute via per-metric-class tolerance contract.
# Telegram alerts via /opt/algovault-monitoring/send_telegram.sh (OPS-MONITORING-TG-W1 wrapper).
# DRY_RUN_TG=1 env honored (passed through to wrapper).
# Fail-open: exit 0 on any per-row failure (logged, NOT bounced to caller cron).

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import yaml

MANIFEST_PATH = os.environ.get("MANIFEST_PATH", "/opt/algovault-monitoring/website-drift-manifest.yaml")
CACHE_DIR = Path(os.environ.get("CACHE_DIR", "/var/cache/website-drift-canary"))
CACHE_TTL_SEC = int(os.environ.get("CACHE_TTL_SEC", "300"))  # 5 min
WRAPPER = os.environ.get("TG_WRAPPER", "/opt/algovault-monitoring/send_telegram.sh")
HTTP_TIMEOUT = 20
AUDIT_DOC_REF = "audits/OPS-DASHBOARD-DRIFT-CANARY-W1-endpoint-truth.md"

# OPS-DRIFT-CANARY-EXTRACTION-FAILURE-GUARD (2026-06-22): when a set-based extractor
# returns EMPTY against a non-empty SoT, route the alert to a canary-pattern fix, NOT the
# row's data-fix wave (which would mis-direct the operator to "fix the dashboard" when the
# dashboard is fine and the canary regex went stale). Template form per CLAUDE.md
# (resolved at send-time by send_telegram.sh resolve_template()).
EXTRACTION_FAILURE_WAVE = "OPS-DRIFT-CANARY-PATTERN-FIX-W{NEXT}"

VENUE_NORMALIZE = {"HYPERLIQUID": "HL"}  # alias used in venue-list EXACT_SET matching

# OPS-MERKLE-DRIFT-TOLERANCE-W1 (2026-06-29) — MONOTONIC-COUNTER GENERATOR GUARD.
# A cumulative counter that physically only ever GROWS renders on the page as a
# deploy-baked static fallback that NECESSARILY lags the live SoT between deploys.
# EXACT/BAND on such a counter false-fires on the normal lag (the 2026-06-29
# HOMEPAGE_MERKLE_COUNT/HIW_MERKLE "79 vs SoT 80" alert). Root cause: those two
# .batches|length rows were left EXACT when OPS-LANDING-AUTO-ALIGN-W1 (2026-05-25)
# flipped the .totalCalls rows to FLOOR — a manual sweep that missed two rows.
#
# This guard AUTO-CORRECTS any REGISTERED monotonic accessor (the signatures below)
# or any `monotonic: true` row: a non-FLOOR tag is detected at manifest load,
# coerced to FLOOR for the run (Recover), and raised as a CONFIG_VIOLATION (Alert).
# SCOPE (honest framing): this is an ALLOWLIST guard — it protects the registered
# accessors, NOT every conceivable future cumulative counter. A brand-new accessor
# left EXACT still false-fires on the normal lag (it fails toward NOISE, not silence,
# so it self-announces) until registered. Growth-history auto-detection of an
# unregistered monotonic counter is tracked by OPS-DRIFT-CANARY-MONOTONIC-DETECTOR-W1.
# Extend by adding the (sot_endpoint, sot_jq) of a new cumulative accessor below,
# OR by setting `monotonic: true` on the manifest row.
#
# Matching is HOST- and WHITESPACE-agnostic (_canon_sig): the manifest uses both the
# apex (algovault.com) and api. subdomain, and jq spacing varies, so we canonicalize
# both halves before comparison rather than string-equality on the raw absolute URL.
MONOTONIC_SOT_SIGNATURES = {
    # `.batches | length` was RETIRED here by OPS-FRESHNESS-SOURCE-TRUTH-W1 C3.6: no manifest
    # row reads it any more, and leaving it registered kept the direct-observe loop fetching a
    # capped value forever (`MONOTONIC_DIRECT_OBSERVE … = 100`) — dead config of exactly the
    # kind this wave exists to remove. Its stale HWM entry ages out via STATE_PRUNE_DAYS.
    # OPS-FRESHNESS-SOURCE-TRUTH-W1 C3.6 (2026-07-28): `.batch_count` is the SCALAR
    # count field and supersedes `.batches | length` (which reads a 100-row CAPPED
    # projection — see ARRAY_LENGTH_CAP_ACCESSORS). Registered here in the SAME commit
    # that flips the rows, because dropping the old accessor WITHOUT registering the new
    # one would silently lose the FLOOR coercion and re-introduce the 2026-06-29
    # false-fire class (page baked N, SoT grows to N+1, EXACT -> fire).
    ("https://api.algovault.com/api/merkle-batches", ".batch_count"),
    ("https://api.algovault.com/api/performance-public", ".totalCalls"),
}
CONFIG_VIOLATION_ALERT_ID = "WEBSITE_DRIFT_MANIFEST_CONFIG_VIOLATION"
CONFIG_VIOLATION_WAVE = "OPS-DRIFT-CANARY-CONFIG-FIX-W{NEXT}"

# ─────────── OPS-FRESHNESS-SOURCE-TRUTH-W1 (2026-07-28) ───────────
# FAIL-CLOSED FRESHNESS-SOURCE INVARIANT.
#
# A freshness alarm may only measure the producer it names. A `FRESH` row that derives
# its measured value from `claim_pattern` (a page scrape) is measuring the page's BAKE
# cadence, not the producer's cadence, so it silently degenerates into
# `max(bake_gap, producer_gap) > T` under a label naming only the producer. It then
# fires on healthy producers and cannot discriminate the two conditions.
#
# Why fail-CLOSED here when the rest of this script is fail-open: a mis-sourced alarm is
# worse than no alarm, because it burns operator trust. The 2026-07-27 fire sent the
# operator to investigate a merkle publisher with a 100/100 record. Exit 3 =
# framework-error (matches the postgres-autopilot exit-code contract).
FRESHNESS_LINT_EXIT = 3
FRESHNESS_LINT_ALERT_ID = "WEBSITE_DRIFT_FRESHNESS_SOURCE_INVALID"
FRESHNESS_LINT_WAVE = "OPS-DRIFT-CANARY-CONFIG-FIX-W{NEXT}"
RECOMMENDED_WAVE_RE = re.compile(r"^OPS-[A-Z0-9-]+-W\{NEXT\}$")

# ARRAY-LENGTH-vs-SCALAR-COUNT GENERATOR GUARD (A4 rider).
# `.<array> | length` counts what the endpoint CHOSE TO SERIALIZE, not what exists. When
# the payload also exposes an explicit scalar count, the array form is a paginated/capped
# PROJECTION and reading it under-reports — monotonically and forever, once the cap binds.
# Concretely: /api/merkle-batches caps .batches at 100 while .batch_count was 109, so
# three rows claimed "100 merkle batches" and the canary could not see it (page 100 vs
# SoT 100 — both sides read the same capped array).
# The lint is payload-driven, NOT an allowlist: for accessor `.X | length` it looks for a
# sibling scalar count by naming convention and flags a MISMATCH. That generalizes to any
# future row on any endpoint.
ARRAY_LENGTH_ACCESSOR_RE = re.compile(r"^\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\|\s*length\s*$")


def scalar_count_candidates(array_name: str):
    """Sibling root keys that would hold the TRUE count for `.<array_name> | length`.

    Covers the array name AND its de-pluralized stem, because the count field routinely
    disagrees in number with the collection it counts: /api/merkle-batches serves the array
    as `batches` but the count as `batch_count` (singular). Missing that is how a
    naming-convention lint silently passes the exact row it exists to catch — the
    --self-test case 6 fixture is that row.
    """
    stems = [array_name]
    for suffix in ("ies", "es", "s"):
        if array_name.endswith(suffix) and len(array_name) > len(suffix):
            stems.append(array_name[: -len(suffix)] + ("y" if suffix == "ies" else ""))
            break
    out = []
    for stem in stems:
        out += [f"{stem}_count", f"total_{stem}", f"{stem}Count", f"total{stem.capitalize()}"]
    return tuple(dict.fromkeys(out + ["count", "total"]))


def _canon_endpoint(url: str) -> str:
    """Host-agnostic endpoint key: lowercase, drop scheme + leading www./api., strip trailing /."""
    s = (url or "").strip().lower()
    s = re.sub(r"^https?://", "", s)
    s = re.sub(r"^(www\.|api\.)", "", s)
    return s.rstrip("/")


def _canon_jq(jq: str) -> str:
    """Whitespace-agnostic jq key: jq treats '.batches|length' == '.batches | length'."""
    return re.sub(r"\s+", "", jq or "")


def _canon_sig(endpoint: str, jq: str):
    return (_canon_endpoint(endpoint), _canon_jq(jq))


def _norm_iso_minute(v):
    """Normalise a timestamp (any of the shapes both sides of a bake produce) to
    'YYYY-MM-DD HH:MM' in UTC. Returns None when unparseable.

    Accepts: '2026-07-25T00:05:04.390Z', '2026-07-25 00:05 UTC', '2026-07-25 00:05:04 UTC',
    '2026-07-25T00:05:04+00:00', '2026-07-25 00:05'.
    """
    if v is None:
        return None
    raw = str(v).strip()
    if not raw:
        return None
    cand = raw.replace("Z", "+00:00").replace(" UTC", "+00:00")
    # Strip fractional seconds — publish jitter, never drift.
    cand = re.sub(r"\.\d+(?=[+-]\d{2}:\d{2}$|$)", "", cand)
    for attempt in (cand, cand.replace(" ", "T")):
        try:
            dt = datetime.fromisoformat(attempt)
        except ValueError:
            continue
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M")
    return None


# How far from its declared minute a run may be and still draw a FRESH verdict.
OFF_SCHEDULE_WINDOW_MIN = int(os.environ.get("FRESH_OFF_SCHEDULE_WINDOW_MIN", "30"))


def _fresh_sot_off_schedule(row, manifest, now_dt=None) -> bool:
    """True when this is a `freshness_source: sot` FRESH row being sampled outside the
    window its absolute-age threshold was derived for.

    Returns False (i.e. "verdict is valid") for every other row type, when the manifest
    declares no canary minute, or when FRESH_OFF_SCHEDULE_WINDOW_MIN=0 disables the guard —
    so this can only ever SUPPRESS a fire that the scheduled run would still make.
    """
    if row.get("tolerance_type") != "FRESH" or row.get("freshness_source") != "sot":
        return False
    declared = (manifest or {}).get("canary_run_minute_utc")
    if not isinstance(declared, int) or OFF_SCHEDULE_WINDOW_MIN <= 0:
        return False
    now_dt = now_dt or datetime.now(timezone.utc)
    now_min = now_dt.hour * 60 + now_dt.minute
    delta = abs(now_min - declared) % 1440
    return min(delta, 1440 - delta) > OFF_SCHEDULE_WINDOW_MIN


def _breach_streak_path(alert_id: str) -> Path:
    """Per-alert consecutive-breach counter. Lives beside the monotonic HWM state (a
    PERSISTENT dir), not in the TTL'd CACHE_DIR, so a cache wipe cannot reset the streak."""
    return Path(MONOTONIC_STATE_PATH).parent / f"breach-streak-{alert_id}.count"


def update_breach_streak(alert_id: str, breached: bool) -> int:
    """Advance/reset the consecutive-breach streak for `alert_id`; return the new streak.

    Fail-soft: an unreadable/unwritable state file degrades to "this run counts as 1", which
    means a required streak of N>1 will not fire on a broken state dir. That is the correct
    direction for a self-healing producer — see consecutive_breaches_required.
    """
    p = _breach_streak_path(alert_id)
    if not breached:
        try:
            p.unlink(missing_ok=True)
        except OSError as exc:
            log(f"BREACH_STREAK_CLEAR_FAILED: {alert_id} err={exc}")
        return 0
    prev = 0
    try:
        if p.exists():
            prev = int(p.read_text(encoding="utf-8").strip() or "0")
    except (OSError, ValueError) as exc:
        log(f"BREACH_STREAK_READ_FAILED: {alert_id} err={exc} — treating as 0")
        prev = 0
    streak = prev + 1
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(str(streak), encoding="utf-8")
    except OSError as exc:
        log(f"BREACH_STREAK_WRITE_FAILED: {alert_id} err={exc}")
    return streak


def _coerce_numeric(s, like):
    """Coerce a numeric-looking string `s` to int/float matching `like`'s type; else return s."""
    if isinstance(s, (int, float)):
        return s
    try:
        return int(str(s).replace(",", "")) if isinstance(like, int) and not isinstance(like, bool) else float(s)
    except (ValueError, TypeError):
        return s


def _is_sig_collision(raw_endpoints):
    """True when >1 distinct CANONICAL host collapsed to one sig (apex vs api. is NOT a
    collision — they canonicalize to the same backend value)."""
    return len({_canon_endpoint(h) for h in (raw_endpoints or ())}) > 1


def _hwm_reset_match(jq, tokens):
    """True if a MONOTONIC_HWM_RESET token matches this JQ ACCESSOR ('all' = full wipe). Matched
    against the jq only — never the endpoint/host — so 'api'/'algovault' can't reset everything."""
    jq_l = str(jq).lower()
    return "all" in tokens or any(t in jq_l for t in tokens)


# Normalized signature set, computed once at import — what is_monotonic_counter() checks.
_MONOTONIC_CANON = {_canon_sig(ep, jq) for (ep, jq) in MONOTONIC_SOT_SIGNATURES}

# OPS-DRIFT-CANARY-MONOTONIC-DETECTOR-W1 (2026-06-29) — CROSS-RUN MONOTONIC DETECTORS.
# Closes two gaps the OPS-MERKLE-DRIFT-TOLERANCE-W1 adversarial review found:
#   (1) BLIND WINDOW — FLOOR compares the live SoT against the STALE deploy-baked page
#       floor, so a real regression that stays >= the last-deploy snapshot is missed
#       (page baked 80, live grew to 120, 30 un-published -> SoT 90; 90<80 -> no fire).
#       We persist a per-(endpoint,jq) SoT HIGH-WATER-MARK across runs and fire a true
#       monotonic-invariant-break alert when current SoT < recorded peak, independent of
#       the page floor (deduped against a same-run FLOOR break to avoid double-alert).
#   (2) STRUCTURAL FALSE-NEGATIVE — the W1 guard is an allowlist; a NEW cumulative
#       counter left EXACT reproduces the merkle bug class. We track growth-history for
#       UNREGISTERED EXACT numeric rows and raise a REPORT-ONLY (DRY_RUN-gated)
#       SUSPECTED_UNREGISTERED_MONOTONIC nudge once a value grows monotonically.
# State lives in a PERSISTENT dir (NOT CACHE_DIR, which is TTL'd + wiped) so the HWM
# survives cache clears — matching the .alert-state convention.
MONOTONIC_STATE_PATH = os.environ.get(
    "MONOTONIC_STATE_PATH", "/opt/algovault-monitoring/.drift-canary-state/monotonic-state.json")
HISTORY_CAP = 6           # per-signature observed-value ring kept in state
SUSPECT_MIN_RUNS = 4      # consecutive non-decreasing samples (with net growth) to flag
REGRESSION_CONFIRM_RUNS = 2  # consecutive INDEPENDENT below-peak runs before a regression is
                             # CONFIRMED (a single transient/partial SoT read is NOT enough —
                             # runbook "TG fires only on sustained drift"). Independence is
                             # ENFORCED (not just assumed): process skips a re-run within the SoT
                             # cache window (min_gap_sec) so a cached read can't double-count.
                             # NOTE: a consecutive streak resets on any at/above-peak read, so a
                             # FLAPPING counter (regressed every other run) does not confirm — by
                             # design (we alert on SUSTAINED drift, not a flap).
MONOTONIC_REGRESSION_ALERT_ID = "WEBSITE_DRIFT_MONOTONIC_REGRESSION"
MONOTONIC_REGRESSION_WAVE = "OPS-DRIFT-CANARY-MONOTONIC-REGRESSION-W{NEXT}"
SUSPECTED_MONOTONIC_ALERT_ID = "WEBSITE_DRIFT_SUSPECTED_UNREGISTERED_MONOTONIC"
# OPS-DRIFT-CANARY-MONOTONIC-PROMOTE-W1 (2026-06-29) — promotion-readiness hardening.
SPIKE_FACTOR = 4              # a new-peak candidate > SPIKE_FACTOR × last_value is logged as an
                             # implausible jump (forensic); the peak is locked only by 2-run
                             # persistence (a transient spike never becomes the HWM) regardless.
STATE_PRUNE_DAYS = 90        # evict a state entry not updated in this many days (bounded file)
STATE_RESET_ALERT_ID = "WEBSITE_DRIFT_MONOTONIC_STATE_RESET"  # HWM store wiped/corrupted


def log(msg: str) -> None:
    print(f"[{datetime.now(timezone.utc).isoformat(timespec='seconds')}] {msg}", flush=True)


def fetch_cached(url: str, slug: str) -> str:
    """Curl-style fetch with mtime-based local cache. Returns body text."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = CACHE_DIR / slug
    if path.exists() and (time.time() - path.stat().st_mtime) < CACHE_TTL_SEC:
        return path.read_text(encoding="utf-8", errors="replace")
    req = urllib.request.Request(url, headers={"User-Agent": "website-drift-canary/1.0 (+ops-monitoring)"})
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
        body = resp.read().decode("utf-8", errors="replace")
    path.write_text(body, encoding="utf-8")
    return body


def slug_for_page(url: str) -> str:
    s = url.replace("https://", "").replace("/", "_").replace("?", "_").rstrip("_")
    return f"page_{s or 'root'}.html"


def slug_for_api(url: str) -> str:
    s = url.replace("https://", "").replace("/", "_").replace("?", "_").rstrip("_")
    return f"api_{s}.json"


def jq_query(json_text: str, query: str):
    """Run `jq -r` against json_text; returns parsed value (number/string/list/dict)."""
    proc = subprocess.run(
        ["jq", query], input=json_text, text=True, capture_output=True, check=True
    )
    raw = proc.stdout.strip()
    # Try JSON parse; fall back to string
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        # jq -r returns raw strings; try numeric coercion
        try:
            return float(raw) if "." in raw or "e" in raw.lower() else int(raw)
        except ValueError:
            return raw


def extract_from_page(body: str, pattern: str, method: str):
    """Apply regex per extract_method. Returns scalar OR set, depending on method."""
    if method == "regex_first_match":
        m = re.search(pattern, body)
        return m.group(1) if m else None
    if method == "regex_max_match":
        ms = re.findall(pattern, body)
        return max(int(m) for m in ms) if ms else None
    if method == "regex_min_match":
        ms = re.findall(pattern, body)
        return min(int(m) for m in ms) if ms else None
    if method == "regex_all_matches_set":
        return set(re.findall(pattern, body))
    if method == "regex_all_matches_set_upper":
        raw_set = set(re.findall(pattern, body))
        normalized = {VENUE_NORMALIZE.get(s.upper(), s.upper()) for s in raw_set}
        return normalized
    if method == "regex_all_matches_set_lower":
        return {s.lower() for s in re.findall(pattern, body)}
    if method == "regex_first_match_iso_to_epoch":
        m = re.search(pattern, body)
        if not m:
            return None
        raw = m.group(1).strip()
        # Accept multiple date formats: "2026-05-09T18:00:00Z", "2026-05-24T00:05:07.682Z",
        # "2026-05-09 18:00 UTC", "2026-05-09 18:00:00 UTC", "2026-05-09 18:00".
        candidates = [
            raw.replace("Z", "+00:00"),
            raw.replace(" UTC", "+00:00"),
            raw.replace(" UTC", ":00+00:00") if raw.count(":") == 1 else raw.replace(" UTC", "+00:00"),
        ]
        for cand in candidates:
            try:
                dt = datetime.fromisoformat(cand)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return (datetime.now(timezone.utc) - dt).total_seconds() / 86400.0
            except ValueError:
                continue
        return None
    raise ValueError(f"unknown extract_method: {method}")


def apply_transform(value, transform_expr):
    """Evaluate transform DSL on extracted value. Keeps a safe minimal DSL."""
    if transform_expr is None or value is None:
        return value
    # Minimal DSL — explicit allowlist over eval() for safety
    if transform_expr == "int(match)":
        return int(value)
    if transform_expr == "float(match)":
        return float(value)
    if transform_expr == 'int(match.replace(",",""))':
        return int(str(value).replace(",", ""))
    if transform_expr == "days_since_iso(match)":
        # value is already days (per regex_first_match_iso_to_epoch)
        return float(value)
    # Set transforms handled in extract_method; transform passes through
    if transform_expr.startswith("set("):
        return value  # already a set from extract
    raise ValueError(f"unknown transform: {transform_expr}")


def fetch_sot(row, api_cache: dict):
    """Fetch + jq the SoT API value. Caches per-API-endpoint within one canary run."""
    endpoint = row["sot_endpoint"]
    # OPS-FRESHNESS-SOURCE-TRUTH-W1: a LOCAL producer's SoT is a heartbeat file on this
    # host, not an HTTP endpoint. Read it directly rather than via urllib — file:// through
    # urlopen() carries HTTP-shaped assumptions (headers, caching) that buy nothing here.
    # A MISSING file returns None, which the FRESH branch reports without firing: that is
    # the CLAUDE.md bootstrap rule (report-not-page for a never-attempted producer).
    if endpoint.startswith("file://"):
        p = Path(endpoint[len("file://"):])
        try:
            body = p.read_text(encoding="utf-8").strip()
        except FileNotFoundError:
            log(f"SOT_FILE_ABSENT: {p} — producer has never stamped (bootstrap; not firing)")
            return None
        except OSError as exc:
            log(f"SOT_FILE_UNREADABLE: {p} err={exc}")
            return None
        if not body:
            log(f"SOT_FILE_EMPTY: {p}")
            return None
        return jq_query(body, row["sot_jq"])
    if endpoint == "SELF_REFERENCE":
        # In-page self-reference: jq path is actually a count-grep against the page body
        return None  # handled in compute_drift
    if endpoint not in api_cache:
        api_cache[endpoint] = fetch_cached(endpoint, slug_for_api(endpoint))
    return jq_query(api_cache[endpoint], row["sot_jq"])


def compute_drift(row, page_value, sot_value, page_body):
    """Returns dict {fires, page, sot, drift, extraction_failure}.

    extraction_failure is True when a set-based extractor matched NOTHING while the SoT is
    non-empty — almost always a stale claim_pattern (page markup changed), not real data
    loss. It still fires (the rare genuine total-loss case also needs a human) but routes to
    a canary-pattern fix instead of the row's data-fix wave.
    """
    ttype = row["tolerance_type"]
    tval = row.get("tolerance_value", 0)
    alert_id = row["alert_id"]
    extraction_failure = False

    if ttype == "EXACT":
        # Coerce a numeric-looking page string to match a numeric SoT: a future EXACT count
        # row missing `transform: int(match)` would otherwise compare '5' != 5 and false-fire
        # forever (OPS-DRIFT-CANARY-MONOTONIC-PROMOTE-W1). A genuinely non-numeric page value
        # stays a string and still fires on a real mismatch.
        pv = _coerce_numeric(page_value, sot_value) if isinstance(sot_value, (int, float)) else page_value
        fires = pv != sot_value
        drift = f"{pv} vs SoT {sot_value}; diff {(pv - sot_value) if isinstance(pv, (int, float)) and isinstance(sot_value, (int, float)) else 'N/A'}"
    elif ttype == "EXACT_ISO_MINUTE":
        # OPS-FRESHNESS-SOURCE-TRUTH-W1 (2026-07-28): compare two timestamps that are the
        # SAME INSTANT rendered in different formats — the page bakes "2026-07-25 00:05 UTC"
        # while the SoT serves "2026-07-25T00:05:04.390Z". Normalise both to UTC
        # minute-precision before comparing; seconds/fractions are publish jitter, not drift.
        # A separate tolerance_type (not EXACT) so the 20+ existing numeric EXACT rows are
        # untouched by this normalisation.
        pn, sn = _norm_iso_minute(page_value), _norm_iso_minute(sot_value)
        if pn is None or sn is None:
            fires = True
            drift = (f"unparseable timestamp — page={page_value!r} (norm {pn!r}) vs "
                     f"SoT={sot_value!r} (norm {sn!r}); verify claim_pattern/sot_jq before "
                     f"assuming drift")
        else:
            fires = pn != sn
            drift = f"page '{pn}' vs SoT '{sn}' ({'MATCH' if not fires else 'DRIFT'})"
    elif ttype == "FLOOR":
        # Page claims "X+" (≥ X); fires when SoT actually dropped below X.
        if not isinstance(sot_value, (int, float)):
            # Null / non-numeric SoT: the SoT endpoint is broken or returned null.
            # The prior EXACT branch surfaced this (page != None); don't let FLOOR
            # silently swallow it (OPS-MERKLE-DRIFT-TOLERANCE-W1 red-team finding 2).
            fires = True
            drift = (f"page floor {page_value} vs SoT {sot_value!r} — non-numeric/null SoT; "
                     f"the SoT endpoint may be broken (verify the API, not the page)")
        else:
            fires = isinstance(page_value, (int, float)) and sot_value < page_value
            drift = f"page floor {page_value} vs SoT {sot_value}; floor {'HOLDS' if not fires else 'BROKEN'}"
    elif ttype == "BAND":
        if not isinstance(sot_value, (int, float)):
            # Null / non-numeric SoT: endpoint broken or returned null. Don't silently pass
            # (OPS-DRIFT-CANARY-MONOTONIC-DETECTOR-W1 — mirrors the FLOOR null branch).
            fires = True
            drift = (f"page {page_value} vs SoT {sot_value!r} — non-numeric/null SoT; "
                     f"the SoT endpoint may be broken (verify the API, not the page)")
        elif not isinstance(page_value, (int, float)):
            fires = False
            drift = f"non-numeric page ({page_value}); skipping (page-extraction issue)"
        else:
            diff = abs(page_value - sot_value)
            fires = diff > tval
            drift = f"{page_value}% vs SoT {sot_value:.3f}%; |diff|={diff:.3f}pp ({'≤' if not fires else '>'} {tval}pp band)"
    elif ttype == "EXACT_SET":
        page_set = page_value if isinstance(page_value, set) else set()
        sot_set = set(sot_value) if isinstance(sot_value, list) else set()
        if isinstance(page_value, set) and not page_set and sot_set:
            extraction_failure = True
            fires = True
            drift = (
                f"page_set EMPTY but SoT has {len(sot_set)} item(s) {sorted(sot_set)} — "
                f"extractor matched nothing; claim_pattern likely STALE (verify page markup) "
                f"before assuming data loss"
            )
        else:
            fires = page_set != sot_set
            missing_from_page = sot_set - page_set
            extra_on_page = page_set - sot_set
            drift = (
                f"page_set={sorted(page_set)}; sot_set={sorted(sot_set)}; "
                f"missing_from_page={sorted(missing_from_page)}; extra_on_page={sorted(extra_on_page)}"
            )
    elif ttype == "EXACT_SUBSTRING_LOWER":
        # SoT (single string) must appear in page-extracted set (already lowercased)
        page_set = page_value if isinstance(page_value, set) else set()
        sot_str = str(sot_value).lower()
        if isinstance(page_value, set) and not page_set and sot_str and sot_str != "null":
            extraction_failure = True
            fires = True
            drift = (
                f"page_set EMPTY but SoT expects substring '{sot_str}' — extractor matched "
                f"nothing; claim_pattern likely STALE (verify page markup) before assuming data loss"
            )
        else:
            fires = sot_str not in page_set
            drift = f"sot_lower='{sot_str}'; page_set={sorted(page_set)}; substring {'PRESENT' if not fires else 'ABSENT'}"
    elif ttype == "FRESH":
        # OPS-FRESHNESS-SOURCE-TRUTH-W1 (2026-07-28) — SOURCE SELECTION IS THE FIX.
        # Before: this branch ALWAYS compared page_value (days since the page-scraped
        # literal) against the threshold, and discarded sot_value even though fetch_sot()
        # had already retrieved it. That made the row measure the page's BAKE cadence and
        # blame the producer. freshness_source now selects the measured value explicitly;
        # the fail-closed lint guarantees the key is present on every FRESH row.
        src = row.get("freshness_source")
        measured = sot_value if src == "sot" else page_value
        label = "producer_age" if src == "sot" else "page_bake_age"
        if not isinstance(measured, (int, float)) or isinstance(measured, bool):
            fires = False
            drift = f"non-numeric days from {src or 'unspecified'} source ({measured}); skipping"
        else:
            fires = measured > tval
            drift = (f"{label}={measured:.3f}d vs threshold {tval}d "
                     f"(source={src}, {'fresh' if not fires else 'STALE'})")
    else:
        fires = False
        drift = f"unknown tolerance_type: {ttype}"

    # SELF_REFERENCE override (the single live code path for self-ref rows; the former
    # unreachable EXACT/SELF_REFERENCE elif above was dead — single-derivation, W1-PROMOTE).
    if row.get("sot_endpoint") == "SELF_REFERENCE":
        h3_count = len(re.findall(r'<h3 class="text-white font-semibold text-sm flex-1">', page_body))
        try:
            fires = int(page_value) != h3_count
            drift = f"hero claim {page_value} vs <h3> card count {h3_count}"
        except (ValueError, TypeError):
            fires = False
            drift = f"self-ref extract failed: page_value={page_value}"

    return {"fires": fires, "page": page_value, "sot": sot_value, "drift": drift,
            "extraction_failure": extraction_failure}


def build_alert_body(row, result) -> str:
    """Per OPS-MONITORING-TELEGRAM-INTEGRATION-W1 contract body shape."""
    alert_id = row["alert_id"]
    if result.get("extraction_failure"):
        # Honest framing: the canary read NOTHING; the page is probably fine and the regex
        # went stale. Route to a canary-pattern fix, and tell the operator to verify first.
        return (
            f"🛑 {alert_id} [EXTRACTION_FAILURE]\n"
            f"Condition: canary extractor matched NOTHING on {row['page_url']} while SoT is non-empty\n"
            f"State: {result['drift']}\n"
            f"Likely cause: page markup changed → STALE canary claim_pattern, NOT data loss. "
            f"VERIFY the live page before assuming an outage.\n"
            f"Action: dispatch {EXTRACTION_FAILURE_WAVE} via Cowork → Claude Code\n"
            f"Audit shape: {AUDIT_DOC_REF}\n"
            f"Source log: /var/log/website-drift-canary.log"
        )
    wave = row.get("recommended_wave", "unspecified")
    # A PRODUCER-LIVENESS row has no page_url — name the producer's SoT instead. `row[...]`
    # here threw KeyError for SNAPSHOT_INJECTOR_HEARTBEAT_FRESH, which meant the row logged
    # DRIFT_FIRE and then died in the generic per-row except before call_wrapper() — an alert
    # that computes correctly and is never SENT. Found by the R4.3 negative gate; it would
    # have silenced the one row that guards a fail-open producer.
    subject = row.get("page_url") or row.get("sot_endpoint") or "the producer SoT"
    return (
        f"🛑 {alert_id}\n"
        f"Condition: {row['tolerance_type']} tolerance exceeded on {subject}\n"
        f"State: {result['drift']}\n"
        f"Action: dispatch {wave} via Cowork → Claude Code\n"
        f"Audit shape: {AUDIT_DOC_REF}\n"
        f"Source log: /var/log/website-drift-canary.log"
    )


def call_wrapper(alert_id: str, body: str) -> None:
    """Pipe body via stdin to wrapper. Wrapper honors DRY_RUN_TG env from our env."""
    try:
        subprocess.run(
            [WRAPPER, alert_id, "CRITICAL_PERSISTENT", "-"],
            input=body, text=True, timeout=15, check=False,
        )
    except Exception as exc:  # fail-open: log + continue
        log(f"FAILED_WRAPPER_CALL: alert_id={alert_id} err={exc}")


def is_monotonic_counter(row) -> bool:
    """True when the row's SoT is a cumulative counter that only ever grows.

    Identified by an explicit (sot_endpoint, sot_jq) allowlist of known cumulative
    accessors, OR by an opt-in `monotonic: true` row flag (forward seam for new
    accessors). Deliberately TIGHT: a fixed-cardinality count like .exchange_count
    (5) or .timeframe_count (11) is NOT monotonic and stays EXACT — we DO want a
    fire if the page says 5 but the SoT says 6.
    """
    if row.get("monotonic") is True:
        return True
    return _canon_sig(row.get("sot_endpoint"), row.get("sot_jq")) in _MONOTONIC_CANON


def validate_and_autocorrect_manifest(rows):
    """Generator guard: a monotonic-grow counter MUST use tolerance_type FLOOR.

    Detect -> Recover (coerce the offending row's tolerance_type to FLOOR IN PLACE for
    this run, so the false-positive is suppressed even before the manifest source is
    hand-fixed) -> caller Alerts. Returns a list of (alert_id, original_tolerance_type)
    for every row coerced. After a correctly-configured manifest loads, returns [].
    """
    violations = []
    for row in rows:
        if is_monotonic_counter(row) and row.get("tolerance_type") != "FLOOR":
            violations.append((row.get("alert_id", "UNNAMED"), row.get("tolerance_type")))
            row["tolerance_type"] = "FLOOR"
    return violations


def lint_freshness_rows(rows, canary_run_minute=None, producer_fire_minute=None):
    """FAIL-CLOSED lint for FRESH rows + the recommended_wave regression guard.

    Returns a list of "<alert_id>: <reason>" strings. NON-EMPTY => caller exits
    FRESHNESS_LINT_EXIT. Pure (no network, no clock) so --self-test can drive it both ways.

    Rules:
      1. A FRESH row MUST carry freshness_source: 'sot' | 'page'.
      2. freshness_source: 'page' MUST also name a non-empty bake_producer (the process
         that refreshes the literal), so the row documents WHOSE cadence it measures.
      3. freshness_source: 'sot' MUST carry sot_endpoint + sot_jq + producer_cadence_hours,
         and satisfy the CADENCE-COHERENCE band:
             run_offset_h/24  <  tolerance_value  <  (producer_cadence_h + run_offset_h)/24
         Below the band the alarm fires on a healthy producer every run; at/above the upper
         bound a fully missed production cycle can never trip it. This is what stops a
         future cron move from silently blinding the alarm — move the cron, the lint fails.
      4. recommended_wave MUST be template form OPS-<CLASS>-W{NEXT} (CLAUDE.md). Pure
         REGRESSION guard: all 28 rows were already compliant when this shipped.
    """
    violations = []
    for row in rows:
        aid = row.get("alert_id", "UNNAMED")

        rec = row.get("recommended_wave")
        if rec is not None and not RECOMMENDED_WAVE_RE.match(str(rec)):
            violations.append(f"{aid}: recommended_wave '{rec}' is not template form OPS-<CLASS>-W{{NEXT}}")

        if row.get("tolerance_type") != "FRESH":
            continue

        src = row.get("freshness_source")
        if src not in ("sot", "page"):
            violations.append(
                f"{aid}: tolerance_type FRESH requires freshness_source: 'sot' (measure the "
                f"producer) or an explicit 'page' + bake_producer; got {src!r}")
            continue

        if src == "page":
            if not str(row.get("bake_producer") or "").strip():
                violations.append(
                    f"{aid}: freshness_source 'page' requires a non-empty bake_producer naming "
                    f"the process that refreshes the literal")
            continue

        # src == "sot"
        missing = [k for k in ("sot_endpoint", "sot_jq") if not str(row.get(k) or "").strip()]
        if missing:
            violations.append(f"{aid}: freshness_source 'sot' requires {', '.join(missing)}")
            continue

        cadence_h = row.get("producer_cadence_hours")
        tval = row.get("tolerance_value")
        if not isinstance(cadence_h, (int, float)) or cadence_h <= 0:
            violations.append(f"{aid}: freshness_source 'sot' requires a positive producer_cadence_hours")
            continue
        if not isinstance(tval, (int, float)) or tval <= 0:
            violations.append(f"{aid}: FRESH tolerance_value must be a positive number of days")
            continue

        # Cadence coherence. run_offset = canary run minute - producer fire minute, wrapped
        # into [0,24h). Manifest-level defaults, overridable PER ROW because not every
        # producer fires at the same minute: merkle publishes at :05, the snapshot injector
        # at :39. Using one global producer minute for both would compute the wrong offset
        # and then "enforce" a band that does not describe either producer.
        fire_min = row.get("producer_fire_minute_utc", producer_fire_minute)
        if canary_run_minute is None or fire_min is None:
            continue
        offset_h = ((canary_run_minute - fire_min) % 1440) / 60.0
        # missed_cycles_tolerated widens the UPPER bound. 1 (default) = a single missed
        # production cycle must trip the alarm. >1 is legitimate for a SELF-HEALING producer
        # whose one-off miss is not an incident (the next scheduled run repairs it) — the
        # same principle as consecutive_breaches_required. It must be DECLARED, so the
        # tolerance is a stated policy rather than a number that quietly exceeds the band.
        missed = row.get("missed_cycles_tolerated", 1)
        if not isinstance(missed, int) or missed < 1:
            violations.append(f"{aid}: missed_cycles_tolerated must be an integer >= 1")
            continue
        lo, hi = offset_h / 24.0, (cadence_h * missed + offset_h) / 24.0
        if not (lo < tval < hi):
            violations.append(
                f"{aid}: tolerance_value {tval}d is OUTSIDE the cadence-coherence band "
                f"({lo:.4f}, {hi:.4f}) for producer_cadence_hours={cadence_h} × "
                f"missed_cycles_tolerated={missed} at run_offset={offset_h:.3f}h — the alarm "
                f"would either fire on a healthy producer or never catch a missed cycle")
    return violations


def lint_array_length_accessors(rows, payloads):
    """GENERATOR guard (A4): reject `.<array> | length` when the payload exposes a scalar count.

    `payloads` maps sot_endpoint -> parsed payload dict (only endpoints already fetched;
    absent endpoints are skipped, so this can never bounce the run on a network failure).
    Pure + fixture-drivable. Returns a list of "<alert_id>: <reason>" strings.

    Flags only a genuine MISMATCH (array length != scalar count), i.e. the cap is actually
    binding. An uncapped endpoint where the two agree is left alone — no busywork.
    """
    violations = []
    for row in rows:
        m = ARRAY_LENGTH_ACCESSOR_RE.match(str(row.get("sot_jq") or ""))
        if not m:
            continue
        payload = payloads.get(row.get("sot_endpoint"))
        if not isinstance(payload, dict):
            continue
        arr = payload.get(m.group(1))
        if not isinstance(arr, list):
            continue
        for cand in scalar_count_candidates(m.group(1)):
            scalar = payload.get(cand)
            if isinstance(scalar, (int, float)) and not isinstance(scalar, bool) and scalar != len(arr):
                violations.append(
                    f"{row.get('alert_id', 'UNNAMED')}: sot_jq '{row.get('sot_jq')}' counts a CAPPED "
                    f"projection ({len(arr)}) while the payload exposes '{cand}' = {scalar} — use the "
                    f"scalar count field (and register it in MONOTONIC_SOT_SIGNATURES if cumulative)")
                break
    return violations


def build_freshness_lint_body(violations) -> str:
    """Operator-action-required body for a fail-closed freshness/config lint reject."""
    return (
        f"🛑 {FRESHNESS_LINT_ALERT_ID}\n"
        f"Condition: website-drift-manifest.yaml FAILED the fail-closed freshness-source lint — "
        f"the canary REFUSED to run (exit {FRESHNESS_LINT_EXIT}). Website drift is UNMONITORED "
        f"until the manifest is fixed.\n"
        f"State: {len(violations)} violation(s): " + "; ".join(violations[:6]) + "\n"
        f"Action: dispatch {FRESHNESS_LINT_WAVE} via Cowork → Claude Code\n"
        f"Audit shape: audits/OPS-FRESHNESS-SOURCE-TRUTH-W1-endpoint-truth.md\n"
        f"Source log: /var/log/website-drift-canary.log"
    )


def build_config_violation_body(violations) -> str:
    """Operator-action-required body for a monotonic-counter manifest misconfig.

    Same contract shape as build_alert_body (header, condition, state, action wave,
    audit ref, source log). Routed to a canary-CONFIG fix wave (persist the manifest),
    NOT a page/data-fix wave — the page is fine; the manifest tolerance class is wrong.
    """
    rows_desc = "; ".join(f"{aid} (was {bad})" for aid, bad in violations)
    return (
        f"🛑 {CONFIG_VIOLATION_ALERT_ID}\n"
        f"Condition: monotonic-grow counter row(s) configured non-FLOOR in "
        f"website-drift-manifest.yaml — EXACT/BAND on a cumulative counter false-fires "
        f"on the normal deploy-baked-snapshot lag\n"
        f"State: {len(violations)} row(s) auto-coerced to FLOOR for this run: {rows_desc}\n"
        f"Action: dispatch {CONFIG_VIOLATION_WAVE} via Cowork → Claude Code "
        f"(persist tolerance_type: FLOOR in the manifest)\n"
        f"Audit shape: {AUDIT_DOC_REF}\n"
        f"Source log: /var/log/website-drift-canary.log"
    )


def _update_history(history, current, cap=HISTORY_CAP):
    h = list(history or [])
    h.append(current)
    return h[-cap:]


def is_suspected_monotonic(history, min_runs=SUSPECT_MIN_RUNS) -> bool:
    """True when the last `min_runs` observations are INTEGER, non-decreasing, AND net grew.

    The INTEGER requirement is intrinsic (not just the EXACT-tag gate in main()): a cumulative
    counter is integer-valued; a percentage / ratio is fractional and is rejected here even if
    it happens to climb monotonically (e.g. a warming-up WR%). Excludes a CONSTANT
    (fixed-cardinality count: net growth 0) and a FLUCTUATING value (not non-decreasing).
    bool is excluded (Python True/False are ints).
    """
    nums = [v for v in (history or []) if isinstance(v, (int, float)) and not isinstance(v, bool)]
    if len(nums) < min_runs:
        return False
    window = nums[-min_runs:]
    if not all(float(v).is_integer() for v in window):
        return False
    non_decreasing = all(window[i] <= window[i + 1] for i in range(len(window) - 1))
    net_growth = window[-1] > window[0]
    return non_decreasing and net_growth


def _iso_gap_sec(a, b):
    """Absolute seconds between two ISO timestamps, or None if either is unparseable."""
    try:
        da = datetime.fromisoformat(str(a).replace("Z", "+00:00"))
        db = datetime.fromisoformat(str(b).replace("Z", "+00:00"))
        if da.tzinfo is None:
            da = da.replace(tzinfo=timezone.utc)
        if db.tzinfo is None:
            db = db.replace(tzinfo=timezone.utc)
        return abs((db - da).total_seconds())
    except (ValueError, TypeError):
        return None


def _update_confirmed_peak(entry, current):
    """Admit a new HIGH to the peak only after a 1-run confirmation (SINGLE-RUN SPIKE REJECTION).

    `hwm` = the confirmed peak (None until first confirmed); `pending_peak` = an unconfirmed
    new-high candidate. A NEW high is held in pending_peak for one run; it is admitted to hwm
    only if the NEXT run is >= it (so a transient single-run high never locks).

    HONEST SEMANTICS (do not oversell): for a strictly-GROWING counter (.totalCalls,
    .batches|length grow every run) the next value is always >= the prior candidate, so hwm
    tracks the *previous run's value* — it lags live growth by ~1 confirmed step and each hwm
    is effectively a single observation. KNOWN BLIND SPOTS (acceptable for a REPORT-ONLY
    backstop; the primary regression controls are the FLOOR over-claim check + the on-chain↔
    dashboard equality canary): (1) a regression smaller than one growth-step at a brand-new
    peak is invisible and can re-confirm downward (a real 1-run-high then drop is treated as a
    spike); (2) bootstrap that opens on a sustained LOW seeds a depressed peak. The detector
    reliably catches the realistic threat for these append-only counters: a LARGE sustained
    drop well below the lagging peak.
    """
    hwm = entry.get("hwm")
    pending = entry.get("pending_peak")
    if hwm is None:
        if isinstance(pending, (int, float)) and current >= pending:
            entry["hwm"] = pending                                  # candidate persisted -> confirm
            entry["pending_peak"] = current if current > pending else None
        else:
            entry["pending_peak"] = current                        # (re)seed candidate; stays unconfirmed
    elif current > hwm:
        if isinstance(pending, (int, float)) and current >= pending:
            entry["hwm"] = pending                                  # new high persisted -> promote
            entry["pending_peak"] = current if current > entry["hwm"] else None
        else:
            entry["pending_peak"] = current                        # new-high candidate, await confirm
    else:
        entry["pending_peak"] = None                               # at/below confirmed peak -> abandon


def process_monotonic_observations(state, observations, floor_break_sigs, now_iso, min_gap_sec=0):
    """PURE cross-run detector core (no IO). Mutates `state` in place; returns alert dicts.

    state: {canon_sig -> entry}; observations: {canon_sig -> {value, registered,
    numeric_unregistered, pages, collision?}}; floor_break_sigs: canon_sigs whose FLOOR row
    already fired this run; min_gap_sec: a run within this many seconds of an entry's last
    update is a NON-INDEPENDENT re-run (same cached SoT) and is skipped so it can't
    double-count toward the 2-run confirmation (0 disables — used by unit tests).
    Returns [{kind:'regression'|'suspect'|'spike_log', sig, ...}]; regression is
    confirmation-gated (>=REGRESSION_CONFIRM_RUNS consecutive, independent below-peak runs) +
    once-per-incident; the peak is spike-rejecting (see _update_confirmed_peak for the honest
    semantics + the documented blind spots — this is a report-only forensic backstop).
    """
    alerts = []
    for sig, obs in observations.items():
        current = obs.get("value")
        if not isinstance(current, (int, float)) or isinstance(current, bool):
            continue
        if obs.get("collision"):
            continue  # >1 distinct SoT host collapsed to this sig — value untrustworthy (main logged it)
        registered = bool(obs.get("registered"))
        entry = state.get(sig)
        if entry is None:
            # Bootstrap: seed an UNCONFIRMED peak (hwm=None) so a first-run spike can't poison
            # the peak; the regression check stays dormant until the peak confirms (run 2+).
            state[sig] = {"hwm": None, "pending_peak": current, "last_value": current,
                          "history": [current], "registered": registered, "runs": 1,
                          "below_peak_streak": 0, "regression_reported": False,
                          "suspect_reported": False,
                          "first_seen": now_iso, "last_updated": now_iso}
            continue
        # Skip a NON-INDEPENDENT re-run (within the SoT cache window): it reads the SAME cached
        # body, so counting it would falsely satisfy the 2-run confirmation on one physical read.
        if min_gap_sec:
            _gap = _iso_gap_sec(entry.get("last_updated"), now_iso)
            if _gap is not None and _gap < min_gap_sec:
                continue
        prev_hwm = entry.get("hwm")  # the CONFIRMED peak BEFORE this run's update
        # Forensic only: flag an implausible single-run jump (still gated by 2-run persistence).
        last_value = entry.get("last_value")
        if isinstance(last_value, (int, float)) and last_value > 0 and current > last_value * SPIKE_FACTOR:
            alerts.append({"kind": "spike_log", "sig": sig, "current": current, "last_value": last_value})
        # (1) HWM regression — registered only; CONFIRMATION-gated + ONCE-per-incident;
        #     deduped vs a same-run FLOOR break; checked against the CONFIRMED peak.
        below_peak = (registered and isinstance(prev_hwm, (int, float))
                      and current < prev_hwm and sig not in floor_break_sigs)
        if below_peak:
            entry["below_peak_streak"] = int(entry.get("below_peak_streak", 0)) + 1
            if entry["below_peak_streak"] >= REGRESSION_CONFIRM_RUNS and not entry.get("regression_reported"):
                alerts.append({"kind": "regression", "sig": sig, "current": current,
                               "hwm": prev_hwm, "runs_below": entry["below_peak_streak"],
                               "pages": obs.get("pages")})
                entry["regression_reported"] = True
        else:
            entry["below_peak_streak"] = 0
            entry["regression_reported"] = False
        # Update the confirmed peak (spike-rejecting) + history/bookkeeping.
        _update_confirmed_peak(entry, current)
        entry["history"] = _update_history(entry.get("history"), current)
        entry["last_value"] = current
        entry["registered"] = registered
        entry["runs"] = int(entry.get("runs", 0)) + 1
        entry["last_updated"] = now_iso
        # (2) Suspected unregistered monotonic — numeric EXACT rows only; ONCE-per-incident.
        if obs.get("numeric_unregistered") and not registered and is_suspected_monotonic(entry["history"]):
            if not entry.get("suspect_reported"):
                alerts.append({"kind": "suspect", "sig": sig, "current": current,
                               "history": list(entry["history"]), "pages": obs.get("pages")})
                entry["suspect_reported"] = True
        else:
            entry["suspect_reported"] = False  # growth broke / registered now — allow re-flag
    return alerts


def _parse_monotonic_state_file(p):
    with open(p, "r", encoding="utf-8") as f:
        data = json.load(f)
    out = {}
    for e in data.get("entries", []):
        # Skip a malformed / partially-written entry (no endpoint or jq) so it cleanly
        # re-bootstraps instead of becoming a permanent ('endpoint', None) zombie.
        if not isinstance(e, dict) or not e.get("endpoint") or not e.get("jq"):
            continue
        out[(e["endpoint"], e["jq"])] = {k: v for k, v in e.items() if k not in ("endpoint", "jq")}
    return out


def load_monotonic_state(path):
    """Load persistent {canon_sig -> entry}. Returns (state, wipe_detected).

    Genuine first run (no file + no .bak) => ({}, False). But if the main file is MISSING or
    CORRUPT while a .bak exists, the data-integrity HWM store was WIPED — restore from .bak and
    flag it so main can alert (the reset itself is an operator-action event, not silent).
    """
    bak = f"{path}.bak"
    try:
        return _parse_monotonic_state_file(path), False
    except FileNotFoundError:
        if os.path.exists(bak):
            try:
                restored = _parse_monotonic_state_file(bak)
                log(f"MONOTONIC_STATE_WIPE: {path} missing, restored {len(restored)} entries from .bak")
                return restored, True
            except Exception as exc:
                log(f"MONOTONIC_STATE_BACKUP_UNREADABLE: {exc} — starting fresh")
                return {}, True
        return {}, False  # genuine first run
    except Exception as exc:
        if os.path.exists(bak):
            try:
                restored = _parse_monotonic_state_file(bak)
                log(f"MONOTONIC_STATE_CORRUPT: {path} unparseable ({exc}), restored {len(restored)} from .bak")
                return restored, True
            except Exception as exc2:
                log(f"MONOTONIC_STATE_LOAD_FAILED: main+backup unreadable ({exc2}) — fresh")
                return {}, True
        log(f"MONOTONIC_STATE_LOAD_FAILED: {exc} — starting fresh (fail-open)")
        return {}, True  # corrupt with no backup = a data-loss/reset-class event


def save_monotonic_state(path, state, now_dt=None):
    """Atomically persist (tmp + os.replace) after rotating a single .bak (wipe-recovery
    source) and pruning entries not updated in STATE_PRUNE_DAYS. Fail-open: log + continue."""
    try:
        now_dt = now_dt or datetime.now(timezone.utc)
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        # Prune stale entries so the file stays bounded across manifest churn.
        pruned = 0
        for key in list(state.keys()):
            lu = state[key].get("last_updated")
            try:
                if lu:
                    dt = datetime.fromisoformat(str(lu).replace("Z", "+00:00"))
                    if dt.tzinfo is None:
                        dt = dt.replace(tzinfo=timezone.utc)
                    if (now_dt - dt).days > STATE_PRUNE_DAYS:
                        del state[key]
                        pruned += 1
            except (ValueError, TypeError):
                pass
        if pruned:
            log(f"MONOTONIC_STATE_PRUNED: {pruned} entries not updated in > {STATE_PRUNE_DAYS}d")
        # Rotate the prior good file to .bak BEFORE overwriting (wipe-recovery source).
        if os.path.exists(path):
            try:
                shutil.copy2(path, f"{path}.bak")
            except Exception as exc:
                log(f"MONOTONIC_STATE_BACKUP_FAILED: {exc}")
        entries = []
        for (ep, jq), e in sorted(state.items(), key=lambda kv: (str(kv[0][0]), str(kv[0][1]))):
            row = {"endpoint": ep, "jq": jq}
            row.update(e)
            entries.append(row)
        tmp = f"{path}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"version": 1, "entries": entries}, f, indent=2, sort_keys=True)
        os.replace(tmp, path)
    except Exception as exc:
        log(f"MONOTONIC_STATE_SAVE_FAILED: {exc} (fail-open)")


def build_monotonic_regression_body(alert) -> str:
    ep, jq = alert["sig"]
    pages = ", ".join(sorted(p for p in (alert.get("pages") or []) if p)) or "n/a"
    return (
        f"🛑 {MONOTONIC_REGRESSION_ALERT_ID}\n"
        f"Condition: a monotonic-grow SoT counter REGRESSED below its recorded all-time peak "
        f"for {alert.get('runs_below', '?')} consecutive runs (true monotonic-invariant break — "
        f"caught independent of the deploy-baked page floor)\n"
        f"State: SoT[{ep} | {jq}] now {alert['current']} < peak {alert['hwm']} (pages: {pages}). "
        f"VERIFY real data loss vs. a sustained-but-legitimate baseline change (if legitimate, "
        f"accept the new baseline: run with MONOTONIC_HWM_RESET='{jq}' — or 'all').\n"
        f"Action: dispatch {MONOTONIC_REGRESSION_WAVE} via Cowork → Claude Code\n"
        f"Audit shape: {AUDIT_DOC_REF}\n"
        f"Source log: /var/log/website-drift-canary.log"
    )


def build_state_reset_body(restored, entries_now) -> str:
    return (
        f"🛑 {STATE_RESET_ALERT_ID}\n"
        f"Condition: the monotonic HWM state store ({MONOTONIC_STATE_PATH}) was MISSING or "
        f"CORRUPT — restored {restored} entries from .bak this run\n"
        f"State: the data-integrity high-water-mark memory was reset; a regression that "
        f"occurred around the wipe may have re-bootstrapped at a depressed value. VERIFY the "
        f"registered counters ({entries_now} sigs now tracked) against their on-chain/SoT truth.\n"
        f"Action: dispatch {MONOTONIC_REGRESSION_WAVE} via Cowork → Claude Code\n"
        f"Audit shape: {AUDIT_DOC_REF}\n"
        f"Source log: /var/log/website-drift-canary.log"
    )


def build_suspected_monotonic_body(alert) -> str:
    ep, jq = alert["sig"]
    pages = ", ".join(sorted(p for p in (alert.get("pages") or []) if p)) or "n/a"
    return (
        f"🛑 {SUSPECTED_MONOTONIC_ALERT_ID}\n"
        f"Condition: an UNREGISTERED EXACT counter grew monotonically over "
        f"{len(alert.get('history', []))} runs — looks like a cumulative counter mistagged "
        f"EXACT (the 2026-06-29 merkle bug class), which will false-fire on the normal lag\n"
        f"State: SoT[{ep} | {jq}] history {alert.get('history')} (pages: {pages}). If cumulative, "
        f"register it (MONOTONIC_SOT_SIGNATURES or `monotonic: true`) + set tolerance_type: FLOOR.\n"
        f"Action: dispatch {CONFIG_VIOLATION_WAVE} via Cowork → Claude Code\n"
        f"Audit shape: {AUDIT_DOC_REF}\n"
        f"Source log: /var/log/website-drift-canary.log"
    )


def main() -> int:
    log(f"START website-drift-canary manifest={MANIFEST_PATH} DRY_RUN_TG={os.environ.get('DRY_RUN_TG', '0')}")
    try:
        with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
            manifest = yaml.safe_load(f)
    except Exception as exc:
        log(f"FAILED_MANIFEST_LOAD: {exc} — exit 0 (fail-open)")
        return 0

    rows = manifest.get("rows", [])
    log(f"MANIFEST_LOADED rows={len(rows)}")

    # OPS-FRESHNESS-SOURCE-TRUTH-W1: FAIL-CLOSED freshness-source + cadence-coherence lint.
    # Runs BEFORE any probe. Unlike every other failure path in this script, a violation
    # REFUSES to run (exit 3) — a mis-sourced freshness alarm is worse than no alarm.
    # The two minutes are manifest-declared so moving either cron without moving the
    # threshold fails the lint instead of silently blinding the alarm.
    lint_violations = lint_freshness_rows(
        rows,
        canary_run_minute=manifest.get("canary_run_minute_utc"),
        producer_fire_minute=manifest.get("producer_fire_minute_utc"),
    )
    if lint_violations:
        for v in lint_violations:
            log(f"FRESHNESS_LINT_REJECT: {v}")
        log(f"FRESHNESS_LINT_FAILED violations={len(lint_violations)} — REFUSING to run, "
            f"exit {FRESHNESS_LINT_EXIT} (fail-CLOSED by design)")
        call_wrapper(FRESHNESS_LINT_ALERT_ID, build_freshness_lint_body(lint_violations))
        return FRESHNESS_LINT_EXIT
    log(f"FRESHNESS_LINT_OK fresh_rows="
        f"{sum(1 for r in rows if r.get('tolerance_type') == 'FRESH')}")

    # Generator guard: monotonic-grow counters MUST be FLOOR. Detect -> Recover (coerce
    # to FLOOR for this run) -> Alert (one cooldown-gated config-violation TG). Dormant on
    # a correctly-configured manifest (returns []). Makes the 2026-06-29 merkle false-fire
    # class structurally impossible to silently re-introduce.
    config_violations = validate_and_autocorrect_manifest(rows)
    for aid, bad in config_violations:
        log(f"CONFIG_AUTOCORRECT: {aid} monotonic counter had tolerance_type={bad} -> "
            f"coerced to FLOOR for this run; persist the manifest fix")
    if config_violations:
        call_wrapper(CONFIG_VIOLATION_ALERT_ID, build_config_violation_body(config_violations))

    api_cache = {}
    fires_count = 0
    suppressed_no_fire = 0
    extract_failures = 0
    set_extract_failures = 0
    observations = {}         # canon_sig -> {value, registered, numeric_unregistered, pages}
    floor_break_sigs = set()  # canon_sigs whose FLOOR row fired this run (HWM dedupe)

    for idx, row in enumerate(rows, 1):
        alert_id = row.get("alert_id", f"ROW_{idx}_UNNAMED")
        try:
            # OPS-FRESHNESS-SOURCE-TRUTH-W1: a PRODUCER-LIVENESS row has no page — its
            # measured value comes entirely from the producer's own SoT. Declaring no
            # page_url is what marks it, instead of pointing it at an unrelated page with a
            # dummy always-matching claim_pattern just to satisfy the loop.
            if not row.get("page_url"):
                page_body, page_value = "", None
            else:
                page_body = fetch_cached(row["page_url"], slug_for_page(row["page_url"]))
                raw = extract_from_page(page_body, row["claim_pattern"], row["extract_method"])
                if raw is None:
                    log(f"EXTRACT_NONE: {alert_id} pattern did not match page")
                    extract_failures += 1
                    continue
                page_value = apply_transform(raw, row.get("transform"))
            sot_value = fetch_sot(row, api_cache)
            result = compute_drift(row, page_value, sot_value, page_body)
            tg_fires_flag = bool(row.get("tg_fires", False))
            # OPS-DRIFT-CANARY-MONOTONIC-DETECTOR-W1: record numeric-SoT observations for
            # the cross-run HWM (blind-window) + growth (unregistered) detectors.
            # OPS-FRESHNESS-SOURCE-TRUTH-W1: a FRESH/sot row's sot_value is an AGE IN DAYS —
            # a measurement that oscillates (0.03 just after a publish, ~1.0 just before the
            # next), not a cumulative counter. Feeding it to the monotonic HWM detector makes
            # the peak climb toward the cycle maximum and then treats every healthy fresh
            # reading as a "regression below peak", manufacturing report-only noise that would
            # page the moment MONOTONIC_REGRESSION_TG is promoted. Observed live: a days-since
            # float landed in the HWM store and logged monotonic_spikes=1.
            if (row.get("sot_endpoint") not in (None, "SELF_REFERENCE")
                    and isinstance(sot_value, (int, float))
                    and not (row.get("tolerance_type") == "FRESH"
                             and row.get("freshness_source") == "sot")):
                csig = _canon_sig(row.get("sot_endpoint"), row.get("sot_jq"))
                _reg = is_monotonic_counter(row)
                obs = observations.get(csig)
                if obs is None:
                    obs = {"value": sot_value, "registered": _reg, "numeric_unregistered": False,
                           "pages": set(), "raw_endpoints": set()}
                    observations[csig] = obs
                obs["value"] = sot_value
                obs["registered"] = obs["registered"] or _reg
                if row.get("tolerance_type") == "EXACT" and not _reg:
                    obs["numeric_unregistered"] = True
                obs["pages"].add(row.get("page_url"))
                obs["raw_endpoints"].add(row.get("sot_endpoint"))
                if row.get("tolerance_type") == "FLOOR" and result["fires"]:
                    floor_break_sigs.add(csig)
            if result.get("extraction_failure"):
                # Empty set-extract vs non-empty SoT: stale-pattern (likely) or total loss.
                # Alert with honest framing instead of a misleading "all data missing" drift.
                if tg_fires_flag:
                    set_extract_failures += 1
                    log(f"EXTRACTION_FAILURE: {alert_id} :: {result['drift']}")
                    call_wrapper(alert_id, build_alert_body(row, result))
                else:
                    suppressed_no_fire += 1
                    log(f"EXTRACTION_FAILURE_NO_TG: {alert_id} (tg_fires=false) :: {result['drift']}")
            elif result["fires"] and _fresh_sot_off_schedule(row, manifest):
                # OPS-FRESHNESS-SOURCE-TRUTH-W1 — OFF-SCHEDULE SAMPLE GUARD.
                # An absolute-age threshold is only meaningful at the sample time it was
                # derived for. MERKLE_PUBLISH_LIVENESS at 0.5d is healthy-at-00:57 (~0.036d)
                # but a HEALTHY producer legitimately reads 0.54d by ~12:05 UTC, so any
                # ad-hoc daytime run would page on a perfectly good publisher — the exact
                # disease this wave exists to cure. Report the measurement, never fire it.
                # The threshold itself is unchanged (architect-ratified); this only refuses
                # to draw a verdict from an out-of-window sample.
                suppressed_no_fire += 1
                log(f"FRESH_OFF_SCHEDULE_REPORT_ONLY: {alert_id} :: {result['drift']} "
                    f"— run is outside the declared sampling window "
                    f"(canary_run_minute_utc={manifest.get('canary_run_minute_utc')}); "
                    f"threshold is only valid at the scheduled minute, so NOT firing")
            elif result["fires"]:
                # OPS-FRESHNESS-SOURCE-TRUTH-W1: optional consecutive-breach requirement.
                # A row guarding a SELF-HEALING producer (the daily snapshot injector) must
                # not page on a one-day transient — the next scheduled run repairs it. Rows
                # guarding a producer whose miss is itself the incident (MERKLE_PUBLISH_
                # LIVENESS) leave this unset and stay single-fire.
                need = row.get("consecutive_breaches_required", 1)
                need = need if isinstance(need, int) and need > 1 else 1
                streak = update_breach_streak(alert_id, True) if need > 1 else 1
                if streak < need:
                    suppressed_no_fire += 1
                    log(f"DRIFT_SUSTAIN_PENDING: {alert_id} breach {streak}/{need} consecutive "
                        f"— not firing yet (self-healing producer; next run decides) :: {result['drift']}")
                elif tg_fires_flag:
                    fires_count += 1
                    log(f"DRIFT_FIRE: {alert_id} :: {result['drift']}"
                        + (f" [sustained {streak}/{need}]" if need > 1 else ""))
                    call_wrapper(alert_id, build_alert_body(row, result))
                else:
                    log(f"DRIFT_NO_TG: {alert_id} (tg_fires=false) :: {result['drift']}")
                    suppressed_no_fire += 1
            else:
                if isinstance(row.get("consecutive_breaches_required"), int) and \
                        row["consecutive_breaches_required"] > 1:
                    update_breach_streak(alert_id, False)
                log(f"PASS: {alert_id} :: {result['drift']}")
        except subprocess.CalledProcessError as exc:
            log(f"FAILED_JQ: {alert_id} stderr={exc.stderr.strip() if exc.stderr else ''}")
            extract_failures += 1
        except Exception as exc:
            log(f"FAILED_ROW: {alert_id} err={type(exc).__name__}: {exc}")
            extract_failures += 1

    # OPS-FRESHNESS-SOURCE-TRUTH-W1 (A4 generator rider): array-length-vs-scalar-count lint.
    # Runs AFTER the row loop so it can use payloads already fetched (zero extra requests).
    # REPORT + cooldown-gated config alert, NOT fail-closed: unlike a mis-sourced FRESH row,
    # an under-counting row still alerts in the right direction — it just under-reports — and
    # bouncing the whole canary over it would trade a small wrong number for no monitoring.
    try:
        parsed_payloads = {}
        for ep, body in api_cache.items():
            try:
                parsed_payloads[ep] = json.loads(body)
            except (json.JSONDecodeError, TypeError):
                continue
        cap_violations = lint_array_length_accessors(rows, parsed_payloads)
        for v in cap_violations:
            log(f"ARRAY_LENGTH_CAP_VIOLATION: {v}")
        if cap_violations:
            call_wrapper(CONFIG_VIOLATION_ALERT_ID, build_config_violation_body(
                [(v.split(":", 1)[0], "array-length vs scalar count") for v in cap_violations]))
        else:
            log("ARRAY_LENGTH_CAP_LINT_OK: no capped-projection accessors")
    except Exception as exc:
        log(f"ARRAY_LENGTH_CAP_LINT_FAILED: {type(exc).__name__}: {exc} (fail-open)")

    # Cross-run monotonic detectors (blind-window HWM + unregistered-growth). Fail-open:
    # any error here must NOT bounce the cron or lose the per-row results already logged.
    # Both detectors ship REPORT-ONLY first (DRY_RUN-first principle); the operator promotes
    # to live TG via env once a clean baseline is observed. Live-promotion hardening
    # (spike-rejection, ack/reset, state-wipe alert, sig-collision guard) is the scope of
    # OPS-DRIFT-CANARY-MONOTONIC-PROMOTE-W1.
    monotonic_regressions = 0
    monotonic_suspects = 0
    monotonic_spikes = 0
    try:
        # Decouple registered-counter observation from page-row extraction: a SoT regression
        # that coincides with a page-markup change (common joint deploy failure) must still be
        # checked. Fetch any REGISTERED signature the row loop didn't already observe.
        for raw_ep, raw_jq in MONOTONIC_SOT_SIGNATURES:
            csig = _canon_sig(raw_ep, raw_jq)
            if csig in observations:
                continue
            try:
                if raw_ep not in api_cache:
                    api_cache[raw_ep] = fetch_cached(raw_ep, slug_for_api(raw_ep))
                val = jq_query(api_cache[raw_ep], raw_jq)
                if isinstance(val, (int, float)) and not isinstance(val, bool):
                    observations[csig] = {"value": val, "registered": True, "numeric_unregistered": False,
                                          "pages": set(), "raw_endpoints": {raw_ep}}
                    log(f"MONOTONIC_DIRECT_OBSERVE: {csig} = {val} (page rows absent/failed this run)")
            except Exception as exc:
                log(f"MONOTONIC_DIRECT_FETCH_FAILED: {raw_ep} {raw_jq} :: {type(exc).__name__}: {exc}")

        now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
        # Sig-collision guard: >1 distinct CANONICAL SoT host collapsed to one canon sig =>
        # untrustworthy merged value; skip it. Compare CANONICAL hosts (not raw strings): apex
        # vs api. canonicalize to the same host and serve the same backend value, so that is NOT
        # a collision (a raw-string compare would falsely silence the detector for a legit
        # multi-host counter). No real collision in the current manifest (SoT = api.algovault.com).
        for _csig, _obs in observations.items():
            if _is_sig_collision(_obs.get("raw_endpoints")):
                _obs["collision"] = True
                log(f"MONOTONIC_SIG_COLLISION: {_csig} maps to >1 SoT host "
                    f"{sorted(str(h) for h in _obs['raw_endpoints'])} — skipping (untrustworthy merge)")
        mono_state, state_wiped = load_monotonic_state(MONOTONIC_STATE_PATH)
        # Operator-ack baseline reset: accept a legitimate counter drop by clearing the peak so
        # it re-confirms at the new baseline (run once with MONOTONIC_HWM_RESET='<jq-substr>'|'all').
        reset_spec = os.environ.get("MONOTONIC_HWM_RESET", "").strip()
        if reset_spec:
            # Match a token against the JQ ACCESSOR only (the alert body suggests the jq, e.g.
            # '.totalCalls') — NOT the endpoint/host, so a token like 'api'/'algovault' can't
            # collaterally reset every counter. 'all' is the explicit full wipe.
            tokens = [t.strip().lower() for t in reset_spec.split(",") if t.strip()]
            for key in list(mono_state.keys()):
                if _hwm_reset_match(key[1], tokens):
                    mono_state[key].update({"hwm": None, "pending_peak": None,
                                            "below_peak_streak": 0, "regression_reported": False})
                    log(f"MONOTONIC_HWM_RESET: {key} peak cleared (operator-ack: accepting a new baseline)")
        mono_alerts = process_monotonic_observations(
            mono_state, observations, floor_break_sigs, now_iso,
            min_gap_sec=int(os.environ.get("MONOTONIC_MIN_GAP_SEC", str(CACHE_TTL_SEC))))
        save_monotonic_state(MONOTONIC_STATE_PATH, mono_state)
        regression_tg = os.environ.get("MONOTONIC_REGRESSION_TG", "0") == "1"  # report-only first; promote when stable
        suspect_tg = os.environ.get("MONOTONIC_SUSPECT_TG", "0") == "1"        # report-only first
        if state_wiped:
            log(f"MONOTONIC_STATE_RESET: HWM store was wiped/corrupt — restored from .bak ({len(mono_state)} sigs)")
            if regression_tg:
                call_wrapper(STATE_RESET_ALERT_ID, build_state_reset_body(len(mono_state), len(mono_state)))
        for a in mono_alerts:
            if a["kind"] == "spike_log":
                monotonic_spikes += 1
                log(f"MONOTONIC_SPIKE_SUSPECTED: {a['sig']} current={a['current']} > {SPIKE_FACTOR}× "
                    f"last_value={a['last_value']} (peak still gated by 2-run persistence — not locked)")
            elif a["kind"] == "regression":
                monotonic_regressions += 1
                log(f"MONOTONIC_REGRESSION_CONFIRMED: {a['sig']} current={a['current']} < peak={a['hwm']} "
                    f"over {a.get('runs_below')} runs")
                if regression_tg:
                    call_wrapper(MONOTONIC_REGRESSION_ALERT_ID, build_monotonic_regression_body(a))
                else:
                    log(f"MONOTONIC_REGRESSION_REPORT_ONLY: {a['sig']} (set MONOTONIC_REGRESSION_TG=1 to alert)")
            else:
                monotonic_suspects += 1
                if suspect_tg:
                    log(f"SUSPECTED_UNREGISTERED_MONOTONIC: {a['sig']} history={a['history']}")
                    call_wrapper(SUSPECTED_MONOTONIC_ALERT_ID, build_suspected_monotonic_body(a))
                else:
                    log(f"SUSPECTED_UNREGISTERED_MONOTONIC_REPORT_ONLY: {a['sig']} history={a['history']} "
                        f"(set MONOTONIC_SUSPECT_TG=1 to alert)")
    except Exception as exc:
        log(f"MONOTONIC_DETECTOR_FAILED: {type(exc).__name__}: {exc} (fail-open)")

    log(
        f"END website-drift-canary fires={fires_count} set_extract_failures={set_extract_failures} "
        f"suppressed_no_tg={suppressed_no_fire} extract_failures={extract_failures} "
        f"monotonic_regressions={monotonic_regressions} monotonic_suspects={monotonic_suspects} "
        f"monotonic_spikes={monotonic_spikes} total_rows={len(rows)}"
    )
    return 0


def self_test() -> int:
    """Hermetic scenario suite for the OPS-FRESHNESS-SOURCE-TRUTH-W1 invariants.

    No network, no wrapper, no state writes. Mirrors the --self-test flag shape shipped by
    webhook-delivery-canary.py (OPS-WEBHOOK-DELIVERY-AUTO-DISABLED-W1 C5) — 2nd sighting, so
    adopted in place rather than extracted to a shared harness (CLAUDE.md 3-example rule).

    Exists because ops/monitoring/** is paths-ignored and website-drift-canary.py has NO repo
    copy at all: the artifact that actually runs is this host file, so a repo unit test could
    never gate it. Every case asserts BOTH directions.
    """
    failures, checks = [], 0

    def check(name, got, want):
        nonlocal checks
        checks += 1
        if got != want:
            failures.append(f"{name}: got {got!r} want {want!r}")

    OK_SOT = {"alert_id": "A", "tolerance_type": "FRESH", "freshness_source": "sot",
              "sot_endpoint": "https://x/api", "sot_jq": ".t", "producer_cadence_hours": 24,
              "tolerance_value": 0.5, "recommended_wave": "OPS-FOO-W{NEXT}"}
    # Canary at minute 57, producer at minute 5 -> offset 0.867h -> band (0.0361, 1.0361).
    M = {"canary_run_minute": 57, "producer_fire_minute": 5}

    # 1. freshness_source present/absent — the core fail-closed rule, both directions.
    check("sot row accepted", lint_freshness_rows([dict(OK_SOT)], **M), [])
    missing = dict(OK_SOT); missing.pop("freshness_source")
    check("FRESH without freshness_source rejected",
          len(lint_freshness_rows([missing], **M)), 1)

    # 2. page source requires bake_producer, both directions.
    pg = dict(OK_SOT); pg["freshness_source"] = "page"
    check("page without bake_producer rejected", len(lint_freshness_rows([dict(pg)], **M)), 1)
    pg_ok = dict(pg); pg_ok["bake_producer"] = "ops/cron/snapshot-landing-daily.sh"
    check("page with bake_producer accepted", lint_freshness_rows([pg_ok], **M), [])

    # 3. CADENCE COHERENCE — must reject exactly today's bug (tolerance 2d, cadence 24h)
    #    and accept the replacement (0.5d).
    old = dict(OK_SOT); old["tolerance_value"] = 2
    check("today's row (2d/24h) rejected", len(lint_freshness_rows([old], **M)), 1)
    check("new row (0.5d/24h) accepted", lint_freshness_rows([dict(OK_SOT)], **M), [])
    lo = dict(OK_SOT); lo["tolerance_value"] = 0.01   # below run_offset -> fires while healthy
    check("sub-offset threshold rejected", len(lint_freshness_rows([lo], **M)), 1)

    # 4. recommended_wave regression guard, both directions.
    bad_w = dict(OK_SOT); bad_w["recommended_wave"] = "OPS-FOO-W1"
    check("hardcoded W1 rejected", len(lint_freshness_rows([bad_w], **M)), 1)

    # 5. Non-FRESH rows are untouched by the freshness lint.
    check("non-FRESH row ignored", lint_freshness_rows(
        [{"alert_id": "B", "tolerance_type": "EXACT", "recommended_wave": "OPS-B-W{NEXT}"}], **M), [])

    # 6. ARRAY-LENGTH CAP lint — fails on the pre-C3.6 shape, passes on the fixed shape.
    capped = {"batches": [{"i": n} for n in range(100)], "batch_count": 109}
    check("capped .batches|length flagged", len(lint_array_length_accessors(
        [{"alert_id": "C", "sot_endpoint": "e", "sot_jq": ".batches | length"}], {"e": capped})), 1)
    check("scalar .batch_count clean", lint_array_length_accessors(
        [{"alert_id": "C", "sot_endpoint": "e", "sot_jq": ".batch_count"}], {"e": capped}), [])
    uncapped = {"batches": [{"i": n} for n in range(7)], "batch_count": 7}
    check("uncapped array not flagged", lint_array_length_accessors(
        [{"alert_id": "C", "sot_endpoint": "e", "sot_jq": ".batches | length"}], {"e": uncapped}), [])

    # 7. FRESH now reads the SoT when freshness_source: sot (the semantic fix), and still
    #    reads the page when 'page'. Same row, same inputs, opposite verdicts.
    stale_page, fresh_sot = 3.0, 0.036
    r = dict(OK_SOT)
    check("sot source ignores a stale page bake",
          compute_drift(r, stale_page, fresh_sot, "")["fires"], False)
    check("page source still sees the stale bake",
          compute_drift({**r, "freshness_source": "page"}, stale_page, fresh_sot, "")["fires"], True)
    check("sot source fires on a genuinely late producer",
          compute_drift(r, 0.0, 3.0, "")["fires"], True)

    # 8. EXACT_ISO_MINUTE normalisation — same instant, different render = MATCH.
    iso = {"alert_id": "D", "tolerance_type": "EXACT_ISO_MINUTE"}
    check("bake vs SoT same minute matches",
          compute_drift(iso, "2026-07-25 00:05 UTC", "2026-07-25T00:05:04.390Z", "")["fires"], False)
    check("bake 3 days behind drifts",
          compute_drift(iso, "2026-07-25 00:05 UTC", "2026-07-28T00:05:04.390Z", "")["fires"], True)
    check("unparseable timestamp fires loudly",
          compute_drift(iso, "soon", "2026-07-28T00:05:04.390Z", "")["fires"], True)

    # 9. _norm_iso_minute accepts every shape both sides actually produce.
    for raw in ("2026-07-25T00:05:04.390Z", "2026-07-25 00:05 UTC", "2026-07-25 00:05:04 UTC",
                "2026-07-25T00:05:04+00:00", "2026-07-25 00:05"):
        check(f"norm({raw})", _norm_iso_minute(raw), "2026-07-25 00:05")
    check("norm(garbage)", _norm_iso_minute("nope"), None)

    # 9b. Per-row producer minute + declared missed-cycle tolerance (the heartbeat row's
    #     producer fires at :39, not the manifest-level :05).
    hb = {"alert_id": "HB", "tolerance_type": "FRESH", "freshness_source": "sot",
          "sot_endpoint": "file:///tmp/hb", "sot_jq": ".", "producer_cadence_hours": 24,
          "producer_fire_minute_utc": 39, "missed_cycles_tolerated": 2,
          "tolerance_value": 1.5, "recommended_wave": "OPS-FOO-W{NEXT}"}
    check("heartbeat row (offset 0.3h, 2 cycles, 1.5d) accepted",
          lint_freshness_rows([dict(hb)], **M), [])
    check("same row with 1 cycle tolerated is rejected (1.5d > band)",
          len(lint_freshness_rows([{**hb, "missed_cycles_tolerated": 1}], **M)), 1)
    # Discriminating pair: with the row-level :39 the band is (0.0125, 1.0125); falling back
    # to the manifest-level :05 it is (0.0361, 1.0361). 0.02 is inside the FIRST only, so
    # these two assertions together prove the row-level minute is genuinely consulted.
    check("row-level producer minute IS used (0.02 inside the :39 band)",
          lint_freshness_rows([{**hb, "missed_cycles_tolerated": 1,
                                "tolerance_value": 0.02}], **M), [])
    hb_no_override = {k: v for k, v in hb.items() if k != "producer_fire_minute_utc"}
    check("without the override the global :05 band rejects the same 0.02",
          len(lint_freshness_rows([{**hb_no_override, "missed_cycles_tolerated": 1,
                                    "tolerance_value": 0.02}], **M)), 1)
    check("missed_cycles_tolerated must be >=1",
          len(lint_freshness_rows([{**hb, "missed_cycles_tolerated": 0}], **M)), 1)

    # 10. OFF-SCHEDULE SAMPLE GUARD — a healthy-but-old reading must not page on an ad-hoc
    #     daytime run, and must still be judged normally at the scheduled minute.
    MF = {"canary_run_minute_utc": 57}
    at_0057 = datetime(2026, 7, 28, 0, 57, tzinfo=timezone.utc)
    at_1300 = datetime(2026, 7, 28, 13, 0, tzinfo=timezone.utc)
    check("on-schedule run draws a verdict",
          _fresh_sot_off_schedule(dict(OK_SOT), MF, at_0057), False)
    check("off-schedule run is report-only",
          _fresh_sot_off_schedule(dict(OK_SOT), MF, at_1300), True)
    check("guard ignores page-sourced rows",
          _fresh_sot_off_schedule({**OK_SOT, "freshness_source": "page"}, MF, at_1300), False)
    check("guard ignores non-FRESH rows",
          _fresh_sot_off_schedule({"tolerance_type": "EXACT"}, MF, at_1300), False)
    check("guard inert without a declared minute",
          _fresh_sot_off_schedule(dict(OK_SOT), {}, at_1300), False)
    # Midnight wrap: 00:30 is 33min from :57 the previous day -> still outside a 30min window,
    # but 01:20 vs :57 is 23min -> inside. Proves the modular distance, not naive subtraction.
    check("wrap-around distance is modular",
          _fresh_sot_off_schedule(dict(OK_SOT), MF,
                                  datetime(2026, 7, 28, 1, 20, tzinfo=timezone.utc)), False)

    # 10b. REGRESSION: an alert body must be buildable for a page-less producer-liveness row.
    #      This threw KeyError('page_url'), so the row logged DRIFT_FIRE and then died in the
    #      per-row except BEFORE call_wrapper — a computed alert that is never sent, in the
    #      one row guarding a fail-open producer. Caught by the R4.3 negative gate.
    hb_fire = {"alert_id": "SNAPSHOT_INJECTOR_HEARTBEAT_FRESH", "tolerance_type": "FRESH",
               "freshness_source": "sot", "sot_endpoint": "file:///var/lib/x/heartbeat",
               "recommended_wave": "OPS-FOO-W{NEXT}"}
    body = build_alert_body(hb_fire, {"fires": True, "drift": "producer_age=3.000d", "page": None,
                                      "sot": 3.0, "extraction_failure": False})
    check("page-less row builds an alert body", "file:///var/lib/x/heartbeat" in body, True)
    check("page-less alert body names the alert", "SNAPSHOT_INJECTOR_HEARTBEAT_FRESH" in body, True)
    body2 = build_alert_body({**hb_fire, "page_url": "https://algovault.com/verify"},
                             {"fires": True, "drift": "d", "page": 1, "sot": 2,
                              "extraction_failure": False})
    check("a row WITH a page still names the page", "https://algovault.com/verify" in body2, True)

    # 10c. The retired capped accessor must be GONE from the registry, and the scalar present.
    check("dead .batches|length signature retired",
          _canon_sig("https://api.algovault.com/api/merkle-batches", ".batches | length")
          in _MONOTONIC_CANON, False)

    # 11. The monotonic FLOOR coercion must survive the C3.6 accessor flip — otherwise the
    #     2026-06-29 false-fire class silently returns.
    check("new .batch_count accessor is registered monotonic", is_monotonic_counter(
        {"sot_endpoint": "https://api.algovault.com/api/merkle-batches",
         "sot_jq": ".batch_count"}), True)

    for f in failures:
        log(f"SELF_TEST_FAIL: {f}")
    log(f"SELF_TEST {'PASS' if not failures else 'FAIL'} checks={checks} failures={len(failures)}")
    return 1 if failures else 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="website drift canary")
    parser.add_argument("--self-test", action="store_true",
                        help="run the hermetic invariant suite and exit")
    a = parser.parse_args()
    if a.self_test:
        sys.exit(self_test())
    sys.exit(main())
