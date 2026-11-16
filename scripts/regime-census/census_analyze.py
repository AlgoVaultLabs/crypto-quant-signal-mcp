#!/usr/bin/env python3
"""census_analyze.py — EDGE-REGIME-CENSUS-W1: who really calls get_market_regime, for what, with which brackets.

    python3 -I scripts/regime-census/census_analyze.py --in <pull-dir> [--out <dir>]
    python3 -I scripts/regime-census/census_analyze.py --self-test

Reads the pull's directory (scripts/regime-census/census-pull.sh: pull.json + botkey/regime/checks/watches.csv),
refuses anything whose sha256 does not match the manifest or whose pull verdict is not PASS, and writes
regime-census-<pull date>.json (the `t3_weights` block ARC-REGIME-ACCURACY T3 registers) and the .md report.

LANES (CH1 rulings, 2026-11-16)
  BOT        license_tier internal AND client_name python-httpx (the restated bot key). Its MIX is weighted by
             PEOPLE: each non-blocked chat holding a regime watch (alert_type regime|both) votes once, timeframes
             under 1h mapped to 1h as the bot does. Its polls give cadence and next tool only.
  OWN        every other internal caller.
  SYNTHETIC  a non-internal caller with any is_automated row (classifyTraffic) on ANY tool in the window — the extract's
             caller_automated, bool_or over the caller's all-tools rows in SQL. Reported, never weighted.
  EXTERNAL   every other non-internal caller.
  A caller is the census key (md5 of the keyed ip_hash and client_name, computed on the host), per lane.

ONE VOTE PER CALLER. Each caller's coin / timeframe / venue shares sum to 1; a lane's mix is the mean over its
callers. "Regime calls" are get_market_regime rows (they carry the coin); every one is demand, served or refused.
Venue shares come only from rows with an exchange. scan_market_regimes is reported, never weighted.

THE REGISTERED FALLBACK (fixed before any pull):
  coins/timeframes  EXTERNAL if >= 30 callers with >= 3 regime calls; else BOT (people) on the same floor (>= 30
                    people); else equal over W4's 8 coins x {1h, 4h, 1d} on Binance.
  shapes            >= 50 external checks carrying stop AND target -> their histogram over T3's 9 shapes, else equal.
  holds             >= 50 external checks carrying a stop or a target -> their histogram, else equal over
                    {0.5, 4, 8, 24, 72} h. The 0.25 h hold joins iff >= 10% of the chosen hold mass is <= 0.25 h.
  panel             W4's 8, then the chosen lane's top Binance coins until 30 coins or 95% of its Binance weight.
  Checks matching the deploy-time docs-sample canary are removed first (CANARY_TEXT); internal checks never exist.

REGIME_CENSUS_VERDICT=PASS (every dimension from its primary source) | FALLBACK (a registered fallback fired) |
INDETERMINATE (exit 3: missing, altered, empty or unparseable input; a non-PASS pull). PASS and FALLBACK exit 0.
CUSTODY. The analyzer refuses (INDETERMINATE) unless its own file is the blob at the pull's code SHA
(git hash-object vs git rev-parse <code_sha>:scripts/regime-census/census_analyze.py) — a rule edited after the pull
cannot run under the landed SHA's name — and refuses an --out inside the repository (public), the pull's own rule.
The JSON records the analyzer blob it ran.

Mutation hook, for the self-test's own proof ONLY: REGIME_CENSUS_MUTATE=call_weighting | no_canary_filter is read
inside --self-test; a real --in run with it set is refused (INDETERMINATE) and every result records "mutate": null.
"""
from __future__ import annotations

import contextlib
import csv
import datetime as dt
import hashlib
import io
import json
import math
import os
import re
import subprocess
import sys
import tempfile
from collections import Counter, defaultdict

MUTATE_ENV = "REGIME_CENSUS_MUTATE"
_MUTATE = ""  # set only by self_test(); a real run refuses the env var (main)
VERDICT_KEY = "REGIME_CENSUS_VERDICT"
ANALYZER_REPO_PATH = "scripts/regime-census/census_analyze.py"
# git location variables a hook exports; -C must win over them (git-and-worktrees rule)
_GIT_LOCATION_ENV = ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_QUARANTINE_PATH",
                     "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES")

W4_COINS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB", "SUI", "1000PEPE"]
T3_TIMEFRAMES = ["1h", "4h", "1d"]
# (id, stop, target, kind): pct = percent of price; sigma = multiples of sigma_H = sigma_1h_pct * sqrt(hold_hours)
SHAPES = [
    ("0.5/0.75", 0.5, 0.75, "pct"), ("1/2", 1.0, 2.0, "pct"), ("2.5/5", 2.5, 5.0, "pct"), ("5/10", 5.0, 10.0, "pct"),
    ("1s/2s", 1.0, 2.0, "sigma"), ("0.5/0.5", 0.5, 0.5, "pct"), ("1s/1s", 1.0, 1.0, "sigma"),
    ("1/0.5", 1.0, 0.5, "pct"), ("1s/0.5s", 1.0, 0.5, "sigma"),
]
HOLDS = [0.25, 0.5, 4.0, 8.0, 24.0, 72.0]
BASE_HOLDS = [0.5, 4.0, 8.0, 24.0, 72.0]
CALLER_FLOOR = 30
CALLS_PER_CALLER = 3
CHECKS_FLOOR = 50
SHORT_HOLD_H = 0.25
SHORT_HOLD_SHARE = 0.10
PANEL_MAX = 30
PANEL_COVER = 0.95
NEXT_TOOL_WINDOW_S = 1800
BOT_CLIENT = "python-httpx"
REGIME_TOOL = "get_market_regime"
SCAN_TOOL = "scan_market_regimes"
# The deploy-time docs-sample canary (scripts/check-docs-samples-live.mjs, every deploy, keyless from the CI runner)
# logs two check shapes, both at the default 8 h hold: P9 (the documented sample) and P7-ENV (the envelope probe).
CANARY_SIGNATURES = {
    "P9": {"leverage": 5.0, "stop": 2.0},
    "P7-ENV": {"leverage": None, "stop": None},
}
CANARY_TEXT = ("keyless, coin BTC, side long, size_usd 10000, hold 8 h, no target_pct, and either leverage 5 + stop_pct 2 "
               "(P9) or no leverage + no stop_pct (P7-ENV) — the deploy-time docs samples, scripts/check-docs-samples-live.mjs")
FILES = ["botkey.csv", "regime.csv", "checks.csv", "watches.csv"]
PRIVACY_RE = re.compile(r"v2:[0-9a-f]{8}|Mozilla/|caller_ref")
QUANTILES = [0.1, 0.25, 0.5, 0.75, 0.9]


class Indeterminate(Exception):
    """Input that cannot be verified or parsed — never a result."""


# ── parsing ───────────────────────────────────────────────────────────────────────────────────────────────────

def _bool(s: str, what: str) -> bool:
    v = s.strip().lower()
    if v in ("t", "true", "1"):
        return True
    if v in ("f", "false", "0"):
        return False
    raise Indeterminate(f"{what}: not a boolean: {s!r}")


def _num(s: str, what: str) -> float | None:
    v = s.strip()
    if v == "":
        return None
    if not re.fullmatch(r"[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?", v):
        raise Indeterminate(f"{what}: not a number: {s!r}")
    return float(v)


def _ts(s: str, what: str) -> float:
    try:
        return dt.datetime.strptime(s.strip(), "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=dt.timezone.utc).timestamp()
    except ValueError as e:
        raise Indeterminate(f"{what}: not an ISO timestamp: {s!r}") from e


def _read(path: str, need: list[str]) -> list[dict[str, str]]:
    with open(path, newline="", encoding="utf-8") as fh:
        rd = csv.DictReader(fh)
        missing = [c for c in need if c not in (rd.fieldnames or [])]
        if missing:
            raise Indeterminate(f"{os.path.basename(path)}: missing column(s) {missing}")
        rows = list(rd)
    for i, r in enumerate(rows):
        if None in r or any(v is None for v in r.values()):
            raise Indeterminate(f"{os.path.basename(path)}: row {i + 2} has the wrong number of fields")
    return rows


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _git(repo: str, *args: str) -> str:
    env = {k: v for k, v in os.environ.items() if k not in _GIT_LOCATION_ENV}
    try:
        r = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, env=env, timeout=60)
    except (OSError, subprocess.SubprocessError) as e:
        raise Indeterminate(f"git {args[0]} could not run: {e}") from e
    if r.returncode != 0:
        raise Indeterminate(f"git {' '.join(args)} failed: {r.stderr.strip()[:200]}")
    return r.stdout.strip()


def verify_code(code_sha: str, analyzer_path: str, repo: str) -> str:
    """The analyzer's own blob, refused unless it is the blob at the pull's code SHA."""
    if not isinstance(code_sha, str) or not re.fullmatch(r"[0-9a-f]{40}", code_sha):
        raise Indeterminate(f"code_sha {code_sha!r} is not a commit id")
    mine = _git(repo, "hash-object", "--", analyzer_path)
    landed = _git(repo, "rev-parse", "--verify", "--quiet", f"{code_sha}:{ANALYZER_REPO_PATH}")
    if mine != landed:
        raise Indeterminate(f"this analyzer (blob {mine[:12]}) is not the one at code_sha {code_sha[:12]} (blob {landed[:12]})")
    return mine


def out_inside_repo(out_dir: str, repo: str) -> bool:
    """The pull's containment rule: refuse an output directory at or below the repository's top level."""
    root = os.path.realpath(_git(repo, "rev-parse", "--show-toplevel"))
    out = os.path.realpath(out_dir)
    return out == root or out.startswith(root + os.sep)


def load(in_dir: str) -> dict:
    """The verified, parsed pull. Raises Indeterminate on anything it cannot vouch for."""
    mpath = os.path.join(in_dir, "pull.json")
    try:
        with open(mpath, encoding="utf-8") as fh:
            man = json.load(fh)
    except (OSError, ValueError) as e:
        raise Indeterminate(f"pull.json unreadable: {e}") from e
    if man.get("pull_verdict") != "PASS":
        raise Indeterminate(f"pull verdict is {man.get('pull_verdict')!r}, not PASS")
    files = man.get("files") or {}
    inputs = {"pull.json": sha256_file(mpath)}
    for f in FILES:
        p = os.path.join(in_dir, f)
        if f not in files or not os.path.isfile(p):
            raise Indeterminate(f"{f} missing from the pull")
        got = sha256_file(p)
        if got != files[f].get("sha256"):
            raise Indeterminate(f"{f} sha256 {got[:12]} does not match the manifest")
        inputs[f] = got

    bk = _read(os.path.join(in_dir, "botkey.csv"), ["bot_keys", "bot_rows"])
    if len(bk) != 1:
        raise Indeterminate(f"botkey.csv has {len(bk)} rows, not 1")
    botkey = {"bot_keys": int(_num(bk[0]["bot_keys"], "bot_keys") or 0), "bot_rows": int(_num(bk[0]["bot_rows"], "bot_rows") or 0)}

    need = ["ts", "tool_name", "caller", "internal", "client_name", "is_automated", "caller_automated", "coin", "timeframe", "exchange",
            "regime", "verdict", "next_tool", "next_gap_s"]
    regime = []
    for i, r in enumerate(_read(os.path.join(in_dir, "regime.csv"), need)):
        w = f"regime.csv row {i + 2}"
        if not r["caller"].strip() or not r["tool_name"].strip():
            raise Indeterminate(f"{w}: empty caller or tool")
        regime.append({
            "ts": _ts(r["ts"], w), "tool": r["tool_name"].strip(), "caller": r["caller"].strip(),
            "internal": _bool(r["internal"], w), "client": r["client_name"].strip(), "auto": _bool(r["is_automated"], w),
            "caller_auto": _bool(r["caller_automated"], w),
            "coin": r["coin"].strip().upper(), "tf": r["timeframe"].strip(), "ex": r["exchange"].strip().upper(),
            "regime": r["regime"].strip(), "verdict": r["verdict"].strip(), "next_tool": r["next_tool"].strip(),
            "next_gap_s": _num(r["next_gap_s"], w),
        })
    if not regime:
        raise Indeterminate("regime.csv holds no rows — the corpus is empty")

    cneed = ["channel", "keyless", "coin", "side", "size_usd", "leverage", "hold_hours", "timeframe", "stop_pct",
             "target_pct", "sigma_1h_pct"]
    checks = []
    for i, r in enumerate(_read(os.path.join(in_dir, "checks.csv"), cneed)):
        w = f"checks.csv row {i + 2}"
        checks.append({
            "channel": r["channel"].strip(), "keyless": _bool(r["keyless"], w), "coin": r["coin"].strip().upper(),
            "side": r["side"].strip().lower(), "size_usd": _num(r["size_usd"], w), "leverage": _num(r["leverage"], w),
            "hold_h": _num(r["hold_hours"], w), "tf": r["timeframe"].strip(), "stop": _num(r["stop_pct"], w),
            "target": _num(r["target_pct"], w), "sigma_1h": _num(r["sigma_1h_pct"], w),
        })

    watches = []
    for i, r in enumerate(_read(os.path.join(in_dir, "watches.csv"), ["chat_n", "blocked", "coin", "timeframe", "exchange", "alert_type"])):
        w = f"watches.csv row {i + 2}"
        watches.append({"chat": int(_num(r["chat_n"], w) or 0), "blocked": _bool(r["blocked"], w),
                        "coin": r["coin"].strip().upper(), "tf": r["timeframe"].strip(), "ex": r["exchange"].strip().upper(),
                        "alert_type": r["alert_type"].strip()})
    return {"manifest": man, "inputs": inputs, "botkey": botkey, "regime": regime, "checks": checks, "watches": watches}


# ── the derivations ───────────────────────────────────────────────────────────────────────────────────────────

def lane_of(row: dict) -> str:
    if row["internal"]:
        return "BOT" if row["client"] == BOT_CLIENT else "OWN"
    return "SYNTHETIC" if row["caller_auto"] else "EXTERNAL"


def vote_mix(groups: dict) -> dict:
    """One vote per voter: each voter's category shares sum to 1; the mix is the mean over voters with any value."""
    voters = {v: vals for v, vals in groups.items() if vals}
    if not voters:
        return {}
    mix: dict = defaultdict(float)
    if _MUTATE == "call_weighting":  # the defect the one-vote test exists to catch
        pooled = Counter(x for vals in voters.values() for x in vals)
        total = sum(pooled.values())
        for k, m in pooled.items():
            mix[k] = m / total
    else:
        for vals in voters.values():
            c = Counter(vals)
            for k, m in c.items():
                mix[k] += m / len(vals) / len(voters)
    return dict(sorted(mix.items(), key=lambda kv: (-kv[1], kv[0])))


def regime_tf(tf: str) -> str:
    """The bot's own mapping for a regime poll (algovault-bot alert_engine.py): 1h/4h/1d stay, finer maps to 1h."""
    return tf if tf in T3_TIMEFRAMES else "1h"


def nearest_shape(stop: float, target: float, sigma_1h: float | None, hold_h: float | None) -> str:
    best: tuple | None = None
    for sid, s, t, kind in SHAPES:
        if kind == "sigma":
            if not sigma_1h or sigma_1h <= 0 or not hold_h or hold_h <= 0:
                continue  # a sigma form is concrete only with the check's own sigma_H
            sh = sigma_1h * math.sqrt(hold_h)
            s, t = s * sh, t * sh
        d = math.hypot(math.log(stop / s), math.log(target / t))
        if best is None or d < best[0] - 1e-12:
            best = (d, sid)
    return best[1]


def nearest_hold(h: float, candidates: list) -> float:
    return min(candidates, key=lambda c: (abs(math.log(h / c)), c))


def weighted_quantiles(pairs: list) -> dict:
    """pairs: (value, weight). Lower weighted quantile at each of QUANTILES."""
    if not pairs:
        return {}
    pairs = sorted(pairs)
    total = sum(w for _, w in pairs)
    out = {}
    for q in QUANTILES:
        acc = 0.0
        for v, w in pairs:
            acc += w
            if acc >= q * total - 1e-12:
                out[f"p{int(q * 100)}"] = v
                break
    return out


def canary_kind(c: dict) -> str | None:
    """Which docs-sample canary signature a check matches, or None."""
    if _MUTATE == "no_canary_filter":
        return None
    if not (c["keyless"] and c["coin"] == "BTC" and c["side"] == "long" and c["size_usd"] == 10000.0
            and c["hold_h"] == 8.0 and c["target"] is None):
        return None
    for kind, sig in CANARY_SIGNATURES.items():
        if c["leverage"] == sig["leverage"] and c["stop"] == sig["stop"]:
            return kind
    return None


def analyze(data: dict) -> dict:
    regime = data["regime"]
    gmr = [r for r in regime if r["tool"] == REGIME_TOOL]
    if not gmr:
        raise Indeterminate("no get_market_regime row in the corpus")
    binance_served = {r["coin"] for r in gmr if r["ex"] == "BINANCE" and r["regime"] and r["coin"]}

    def fold(c: str) -> str:
        if c and not c.startswith("1000") and ("1000" + c) in binance_served:
            return "1000" + c
        return c

    folds = sorted({c for c in {r["coin"] for r in gmr} if c and fold(c) != c})
    by_voter: dict = defaultdict(list)
    for r in gmr:
        by_voter[(lane_of(r), r["caller"])].append(r)
    scans: dict = defaultdict(list)
    for r in regime:
        if r["tool"] == SCAN_TOOL:
            scans[(lane_of(r), r["caller"])].append(r)

    lanes: dict = {}
    for lane in ("BOT", "OWN", "EXTERNAL", "SYNTHETIC"):
        voters = {v: rows for v, rows in by_voter.items() if v[0] == lane}
        cadence_pairs = []
        for rows in voters.values():
            per_pair: dict = defaultdict(list)
            for r in sorted(rows, key=lambda x: x["ts"]):
                per_pair[(fold(r["coin"]), r["tf"])].append(r["ts"])
            meds = []
            for ts in per_pair.values():
                gaps = sorted(b - a for a, b in zip(ts, ts[1:]))
                if gaps:
                    n = len(gaps)
                    meds.append(gaps[n // 2] if n % 2 else (gaps[n // 2 - 1] + gaps[n // 2]) / 2)
            cadence_pairs += [(m, 1.0 / len(meds)) for m in meds]
        nxt = {v: [r["next_tool"] if r["next_tool"] and r["next_gap_s"] is not None and r["next_gap_s"] <= NEXT_TOOL_WINDOW_S
                   else "none" for r in rows] for v, rows in voters.items()}
        scan_voters = {v: rows for v, rows in scans.items() if v[0] == lane}
        lanes[lane] = {
            "callers": len(voters),
            "callers_ge3": sum(1 for rows in voters.values() if len(rows) >= CALLS_PER_CALLER),
            "calls": sum(len(rows) for rows in voters.values()),
            # refused = an ERR_* verdict; unstamped = served before the exchange/regime/verdict stamp existed
            # (2026-08-31T16:11Z, CH1 P4) — neither a refusal nor a label, reported apart
            "refused_calls": sum(1 for rows in voters.values() for r in rows if r["verdict"].startswith("ERR_")),
            "unstamped_calls": sum(1 for rows in voters.values() for r in rows if not r["verdict"] and not r["regime"]),
            "clients": dict(sorted(Counter(rows[0]["client"] or "unknown" for rows in voters.values()).items(), key=lambda kv: (-kv[1], kv[0]))),
            "mix": {
                "coin": vote_mix({v: [fold(r["coin"]) for r in rows if r["coin"]] for v, rows in voters.items()}),
                "timeframe": vote_mix({v: [r["tf"] for r in rows if r["tf"]] for v, rows in voters.items()}),
                "venue": vote_mix({v: [r["ex"] for r in rows if r["ex"]] for v, rows in voters.items()}),
            },
            "cadence_s": dict(weighted_quantiles(cadence_pairs), pairs=len(cadence_pairs)),
            "next_tool_30m": vote_mix(nxt),
            "scan_market_regimes": {
                "calls": sum(len(rows) for rows in scan_voters.values()), "callers": len(scan_voters),
                "timeframe": vote_mix({v: [r["tf"] for r in rows if r["tf"]] for v, rows in scan_voters.items()}),
                "venue": vote_mix({v: [r["ex"] for r in rows if r["ex"]] for v, rows in scan_voters.items()}),
            },
        }

    # BOT people weights: one vote per non-blocked chat holding a regime watch
    active: dict = defaultdict(list)
    blocked = set()
    for w in data["watches"]:
        if w["alert_type"] not in ("regime", "both"):
            continue
        if w["blocked"]:
            blocked.add(w["chat"])
        else:
            active[w["chat"]].append(w)
    lanes["BOT"]["people"] = {
        "active_chats": len(active), "blocked_chats": len(blocked),
        "watches": sum(len(v) for v in active.values()),
        "flag": None if active else "BOT_LANE_NOT_PEOPLE_WEIGHTED",
        "mix": {
            "coin": vote_mix({k: [fold(w["coin"]) for w in v] for k, v in active.items()}),
            "timeframe": vote_mix({k: [regime_tf(w["tf"]) for w in v] for k, v in active.items()}),
            "venue": vote_mix({k: [w["ex"] for w in v] for k, v in active.items()}),
        },
        "source": "current snapshot of bot watchlists (alert_type regime|both), not a 90-day history",
    }

    # the registered fallback — coins and timeframes
    ext_floor = lanes["EXTERNAL"]["callers_ge3"]
    bot_floor = len(active)
    if ext_floor >= CALLER_FLOOR:
        branch, mix = "EXTERNAL", lanes["EXTERNAL"]["mix"]
    elif bot_floor >= CALLER_FLOOR:
        branch, mix = "BOT", lanes["BOT"]["people"]["mix"]
    else:
        branch, mix = "EQUAL", None
    if mix is None:
        panel = list(W4_COINS)
        coins = {c: 1 / len(W4_COINS) for c in W4_COINS}
        tfs = {t: 1 / len(T3_TIMEFRAMES) for t in T3_TIMEFRAMES}
        cover = None
    else:
        cmix = mix["coin"]
        bweight = sum(w for c, w in cmix.items() if c in binance_served)
        if bweight <= 0:
            raise Indeterminate(f"the {branch} lane carries no Binance coin weight")
        panel = list(W4_COINS)
        covered = sum(cmix.get(c, 0.0) for c in panel if c in binance_served)
        for c, w in sorted(((c, w) for c, w in cmix.items() if c in binance_served and c not in panel), key=lambda kv: (-kv[1], kv[0])):
            if len(panel) >= PANEL_MAX or covered >= PANEL_COVER * bweight - 1e-12:
                break
            panel.append(c)
            covered += w
        psum = sum(cmix.get(c, 0.0) for c in panel)
        coins = {c: cmix.get(c, 0.0) / psum for c in panel}
        tsum = sum(mix["timeframe"].get(t, 0.0) for t in T3_TIMEFRAMES)
        if tsum <= 0:
            raise Indeterminate(f"the {branch} lane carries no 1h/4h/1d weight")
        tfs = {t: mix["timeframe"].get(t, 0.0) / tsum for t in T3_TIMEFRAMES}
        cover = covered / bweight

    # brackets
    checks = data["checks"]
    kinds = [canary_kind(c) for c in checks]
    canary = [c for c, k in zip(checks, kinds) if k]
    ext = [c for c, k in zip(checks, kinds) if not k]
    shape_elig = [c for c in ext if c["stop"] and c["target"] and c["stop"] > 0 and c["target"] > 0]
    hold_elig = [c for c in ext if (c["stop"] and c["stop"] > 0) or (c["target"] and c["target"] > 0)]
    shape_hist = Counter(nearest_shape(c["stop"], c["target"], c["sigma_1h"], c["hold_h"]) for c in shape_elig)
    shape_branch = "HISTOGRAM" if len(shape_elig) >= CHECKS_FLOOR else "EQUAL"
    shapes = ({sid: shape_hist.get(sid, 0) / len(shape_elig) for sid, *_ in SHAPES} if shape_branch == "HISTOGRAM"
              else {sid: 1 / len(SHAPES) for sid, *_ in SHAPES})
    hold_branch = "HISTOGRAM" if len(hold_elig) >= CHECKS_FLOOR else "EQUAL"
    if hold_branch == "HISTOGRAM":
        short_share = sum(1 for c in hold_elig if c["hold_h"] is not None and c["hold_h"] <= SHORT_HOLD_H) / len(hold_elig)
        cand = HOLDS if short_share >= SHORT_HOLD_SHARE - 1e-12 else BASE_HOLDS
        hh = Counter(nearest_hold(c["hold_h"], cand) for c in hold_elig if c["hold_h"])
        n = sum(hh.values())
        holds = {f"{h:g}": hh.get(h, 0) / n for h in cand}
    else:
        short_share = 0.0  # equal mass over BASE_HOLDS: none of it is <= 0.25 h
        cand = BASE_HOLDS
        holds = {f"{h:g}": 1 / len(cand) for h in cand}

    branches = {"coins_timeframes": branch, "shapes": shape_branch, "holds": hold_branch}
    verdict = "PASS" if branches == {"coins_timeframes": "EXTERNAL", "shapes": "HISTOGRAM", "holds": "HISTOGRAM"} else "FALLBACK"
    man = data["manifest"]
    return {
        "schema": "regime-census-v1",
        "wave": "EDGE-REGIME-CENSUS-W1",
        "verdict": verdict,
        "branches": branches,
        "window": {"start": man.get("window_start"), "end": man.get("window_end"), "days": man.get("window_days")},
        "pull_at": man.get("pull_at"),
        "code_sha": man.get("code_sha"),
        "analyzer_blob": data.get("analyzer_blob"),
        "mutate": _MUTATE or None,
        "inputs_sha256": data["inputs"],
        "botkey": data["botkey"],
        "rules": {
            "bot_key": "license_tier internal AND client_name python-httpx",
            "synthetic": "non-internal caller with any is_automated row on any tool in the window",
            "caller_key": "left(md5('regime-census-v1:' || ip_hash || '|' || client_name), 12), computed on the host",
            "regime_calls": REGIME_TOOL,
            "floors": {"callers": CALLER_FLOOR, "calls_per_caller": CALLS_PER_CALLER, "checks": CHECKS_FLOOR,
                       "short_hold_share": SHORT_HOLD_SHARE},
            "panel": {"max": PANEL_MAX, "cover": PANEL_COVER},
            "next_tool_window_s": NEXT_TOOL_WINDOW_S,
            "canary": CANARY_TEXT,
            "coin_folds": folds,
        },
        "lanes": lanes,
        "brackets": {
            "checks": len(checks), "canary_removed": len(canary),
            "canary_removed_by_signature": {k: sum(1 for x in kinds if x == k) for k in CANARY_SIGNATURES}, "external": len(ext),
            "shape_eligible": len(shape_elig), "hold_eligible": len(hold_elig),
            "hold_at_default_8h": sum(1 for c in ext if c["hold_h"] == 8.0),
            "channels": dict(sorted(Counter(c["channel"] for c in ext).items())),
            "shape_histogram": {sid: shape_hist.get(sid, 0) for sid, *_ in SHAPES},
            "hold_histogram": {f"{h:g}": sum(1 for c in hold_elig if c["hold_h"] and nearest_hold(c["hold_h"], HOLDS) == h) for h in HOLDS},
            "short_hold_share": short_share,
        },
        "t3_weights": {
            "branch": branch, "venue": "BINANCE", "panel": panel, "panel_cover": cover,
            "coins": coins, "timeframes": tfs, "shapes": shapes, "holds": holds,
            "shapes_branch": shape_branch, "holds_branch": hold_branch,
        },
    }


# ── output ────────────────────────────────────────────────────────────────────────────────────────────────────

def _round(x):
    if isinstance(x, float):
        return round(x, 6)
    if isinstance(x, dict):
        return {k: _round(v) for k, v in x.items()}
    if isinstance(x, list):
        return [_round(v) for v in x]
    return x


def privacy_defect(text: str) -> str | None:
    m = PRIVACY_RE.search(text)
    return m.group(0) if m else None


def _top(mix: dict, n: int = 12) -> str:
    return ", ".join(f"{k} {v * 100:.1f}%" for k, v in list(mix.items())[:n]) or "—"


def render_md(res: dict, json_name: str, json_sha: str) -> str:
    t, b, ln = res["t3_weights"], res["brackets"], res["lanes"]
    o = [f"# Regime census — {res['pull_at']}", "",
         "**VAULT-ONLY.** Internal measurement for ARC-REGIME-ACCURACY T3; no figure here is public copy.", "",
         f"- `REGIME_CENSUS_VERDICT={res['verdict']}` · branches: coins/timeframes **{t['branch']}**, shapes **{t['shapes_branch']}**, holds **{t['holds_branch']}**",
         f"- JSON: `{json_name}` · sha256 `{json_sha}` · analyzer blob `{res['analyzer_blob']}`",
         f"- Window {res['window']['start']} → {res['window']['end']} ({res['window']['days']} d) · code `{res['code_sha']}`",
         f"- Bot key re-measured: {res['botkey']['bot_keys']} caller keys, {res['botkey']['bot_rows']} rows", "",
         "## Lanes (get_market_regime, one vote per caller)", "",
         "| Lane | Callers | ≥3 calls | Calls | Refused (ERR_*) | Unstamped | Coins (top) | Timeframes | Venues |", "|---|---|---|---|---|---|---|---|---|"]
    for lane in ("EXTERNAL", "BOT", "OWN", "SYNTHETIC"):
        L = ln[lane]
        o.append(f"| {lane} | {L['callers']} | {L['callers_ge3']} | {L['calls']} | {L['refused_calls']} | {L['unstamped_calls']} | {_top(L['mix']['coin'], 8)} | {_top(L['mix']['timeframe'])} | {_top(L['mix']['venue'], 6)} |")
    p = ln["BOT"]["people"]
    o += ["", f"BOT by people: {p['active_chats']} active chats ({p['blocked_chats']} blocked, reported apart), {p['watches']} watches"
          f"{' · ' + p['flag'] if p['flag'] else ''}. Coins {_top(p['mix']['coin'], 8)} · timeframes {_top(p['mix']['timeframe'])} · venues {_top(p['mix']['venue'])}. {p['source']}.", "",
          "## Cadence and next tool", "", "| Lane | Cadence p10 / p50 / p90 (s) | Pairs | Next call ≤ 30 min |", "|---|---|---|---|"]
    for lane in ("EXTERNAL", "BOT", "OWN", "SYNTHETIC"):
        c = ln[lane]["cadence_s"]
        o.append(f"| {lane} | {c.get('p10', '—')} / {c.get('p50', '—')} / {c.get('p90', '—')} | {c['pairs']} | {_top(ln[lane]['next_tool_30m'], 6)} |")
    o += ["", "## scan_market_regimes (reported, not weighted)", "", "| Lane | Calls | Callers | Timeframes | Venues |", "|---|---|---|---|---|"]
    for lane in ("EXTERNAL", "BOT", "OWN", "SYNTHETIC"):
        s = ln[lane]["scan_market_regimes"]
        o.append(f"| {lane} | {s['calls']} | {s['callers']} | {_top(s['timeframe'])} | {_top(s['venue'], 6)} |")
    o += ["", "## Brackets (pre_trade_checks)", "",
          f"- {b['checks']} checks; canary removed {b['canary_removed']} ({res['rules']['canary']}); {b['external']} external",
          f"- carrying stop AND target: {b['shape_eligible']} (floor {CHECKS_FLOOR}) · carrying a stop or a target: {b['hold_eligible']} (floor {CHECKS_FLOOR}) · at the 8 h default hold: {b['hold_at_default_8h']}",
          f"- shape histogram: {', '.join(f'{k} {v}' for k, v in b['shape_histogram'].items())}",
          f"- hold histogram (eligible): {', '.join(f'{k} h {v}' for k, v in b['hold_histogram'].items())} · share ≤ 0.25 h of the chosen mass: {b['short_hold_share']:.3f}", "",
          "## t3_weights", "",
          f"- branch **{t['branch']}**, venue {t['venue']}, panel {len(t['panel'])} coins" + (f" covering {t['panel_cover'] * 100:.1f}% of the lane's Binance weight" if t["panel_cover"] is not None else ""),
          f"- coins: {', '.join(f'{k} {v * 100:.2f}%' for k, v in t['coins'].items())}",
          f"- timeframes: {', '.join(f'{k} {v * 100:.1f}%' for k, v in t['timeframes'].items())}",
          f"- shapes ({t['shapes_branch']}): {', '.join(f'{k} {v * 100:.1f}%' for k, v in t['shapes'].items())}",
          f"- holds ({t['holds_branch']}): {', '.join(f'{k} h {v * 100:.1f}%' for k, v in t['holds'].items())}", ""]
    return "\n".join(o)


def run(in_dir: str, out_dir: str, code: tuple | None = None) -> tuple[str, dict | None, str | None]:
    """→ (verdict, result, json path). Writes nothing unless the verdict is PASS or FALLBACK.
    code = (analyzer file, repo dir) for the custody checks; default: this file in its own checkout."""
    analyzer_path, repo = code or (os.path.abspath(__file__), os.path.dirname(os.path.abspath(__file__)))
    try:
        if out_inside_repo(out_dir, repo):
            raise Indeterminate(f"--out {os.path.realpath(out_dir)} is inside the repository (public): census figures stay private")
        data = load(in_dir)
        data["analyzer_blob"] = verify_code(data["manifest"].get("code_sha"), analyzer_path, repo)
        res = _round(analyze(data))
    except Indeterminate as e:
        print(f"[census-analyze] cannot verify: {e}", file=sys.stderr)
        return "INDETERMINATE", None, None
    day = (res["pull_at"] or "unknown")[:10]
    text = json.dumps(res, indent=2, ensure_ascii=False) + "\n"
    leak = privacy_defect(text)
    if leak:
        print(f"[census-analyze] refusing to write: a raw identifier pattern {leak!r} is in the result", file=sys.stderr)
        return "INDETERMINATE", None, None
    os.makedirs(out_dir, exist_ok=True)
    jpath = os.path.join(out_dir, f"regime-census-{day}.json")
    with open(jpath, "w", encoding="utf-8") as fh:
        fh.write(text)
    jsha = sha256_file(jpath)
    md = render_md(res, os.path.basename(jpath), jsha)
    if privacy_defect(md):
        os.remove(jpath)
        print("[census-analyze] refusing to write: a raw identifier pattern is in the report", file=sys.stderr)
        return "INDETERMINATE", None, None
    with open(os.path.join(out_dir, f"regime-census-{day}.md"), "w", encoding="utf-8") as fh:
        fh.write(md)
    return res["verdict"], res, jpath


# ── self-test (hermetic: synthetic fixtures, no host, no database) ───────────────────────────────────────────

_BASE = int(dt.datetime(2026, 9, 1, tzinfo=dt.timezone.utc).timestamp())


def _iso(t: float) -> str:
    return dt.datetime.fromtimestamp(t, tz=dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _R(t, caller, tool=REGIME_TOOL, internal=False, client="openai", auto=False, coin="BTC", tf="4h", ex="BINANCE",
       regime="RANGING", next_tool="", next_gap="", verdict=None):
    # column 6 (caller_automated) is filled by _fixture the way SQL does: bool_or over the caller's rows
    return [_iso(_BASE + t), tool, caller, "t" if internal else "f", client, "t" if auto else "f", "?", coin, tf, ex, regime,
            ("OK" if regime else "ERR_UNKNOWN") if verdict is None else verdict, next_tool, str(next_gap)]


def _C(stop=None, target=None, hold=8.0, keyless=False, coin="ETH", side="short", size=500.0, lev=None, sigma=1.0):
    f = lambda v: "" if v is None else repr(float(v))
    return ["2026-11-02 00:00:00+00", "mcp", "abc", "t" if keyless else "f", coin, side, f(size), f(lev), f(hold), "4h",
            f(stop), f(target), f(sigma)]


def _fixture(root: str, regime_rows, checks_rows=(), watch_rows=(), pull_verdict="PASS", botkey=("1", "10"), tamper=None,
             code_sha="0" * 40, automated_elsewhere=()) -> str:
    """automated_elsewhere: callers with an is_automated row on a tool the extract does not carry (e.g. get_trade_call)."""
    d = tempfile.mkdtemp(dir=root)
    auto = {r[2] for r in regime_rows if len(r) > 5 and r[5] == "t"} | set(automated_elsewhere)
    regime_rows = [r[:6] + ["t" if r[2] in auto else "f"] + r[7:] if len(r) > 6 and r[6] == "?" else r for r in regime_rows]
    heads = {
        "botkey.csv": ["bot_keys", "bot_rows", "first_ts", "last_ts"],
        "regime.csv": ["ts", "tool_name", "caller", "internal", "client_name", "is_automated", "caller_automated", "coin", "timeframe", "exchange", "regime", "verdict", "next_tool", "next_gap_s"],
        "checks.csv": ["checked_at", "channel", "caller", "keyless", "coin", "side", "size_usd", "leverage", "hold_hours", "timeframe", "stop_pct", "target_pct", "sigma_1h_pct"],
        "watches.csv": ["chat_n", "blocked", "coin", "timeframe", "exchange", "alert_type"],
    }
    body = {"botkey.csv": [list(botkey) + ["x", "y"]], "regime.csv": regime_rows, "checks.csv": checks_rows, "watches.csv": watch_rows}
    files = {}
    for f, h in heads.items():
        p = os.path.join(d, f)
        with open(p, "w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh, lineterminator="\n")
            w.writerow(h)
            w.writerows(body[f])
        files[f] = {"sha256": sha256_file(p), "rows": len(body[f])}
    man = {"pull_at": "2026-11-16T04:00:00.000Z", "window_start": "2026-08-18T04:00:00.000Z", "window_end": "2026-11-16T04:00:00.000Z",
           "window_days": 90, "code_sha": code_sha, "pull_verdict": pull_verdict, "files": files}
    with open(os.path.join(d, "pull.json"), "w", encoding="utf-8") as fh:
        json.dump(man, fh)
    if tamper:
        tamper(d)
    return d


def _ext_callers(n: int, calls: int = 3, prefix: str = "e", coin: str = "BTC") -> list:
    return [_R(i * 60 + k * 3600, f"{prefix}{i}", coin=coin) for i in range(n) for k in range(calls)]


def _chats(n: int, blocked: bool = False, start: int = 1) -> list:
    return [[str(start + i), "1" if blocked else "0", "SOL", "15m", "BINANCE", "regime"] for i in range(n)]


def _git_commit(repo: str, msg: str) -> str:
    if not os.path.isdir(os.path.join(repo, ".git")):
        _git(repo, "init", "-q")
    _git(repo, "add", "-A")
    _git(repo, "-c", "user.name=census-selftest", "-c", "user.email=selftest@invalid", "-c", "commit.gpgsign=false",
         "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", msg)
    return _git(repo, "rev-parse", "HEAD")


def self_test() -> int:
    global _MUTATE
    _MUTATE = os.environ.get(MUTATE_ENV, "")
    cases = 0
    fails = []

    def check(name, got, want):
        nonlocal cases
        cases += 1
        # results are rounded to 6 dp before they are written, so a float compares within 1e-5
        ok = (abs(got - want) < 1e-5) if isinstance(want, float) and isinstance(got, (int, float)) else got == want
        if not ok:
            fails.append(f"{name}: got {got!r} want {want!r}")

    with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as repo:
        # A throwaway repo whose commit `good` holds THIS analyzer at its canonical path and whose commit `bad` holds an
        # edited copy: the real code check (git hash-object vs git rev-parse <sha>:<path>) runs against it.
        me = os.path.abspath(__file__)
        rel = os.path.join(repo, *ANALYZER_REPO_PATH.split("/"))
        os.makedirs(os.path.dirname(rel))
        with open(me, "rb") as src, open(rel, "wb") as dst:
            dst.write(src.read())
        good = _git_commit(repo, "good")
        with open(rel, "a", encoding="utf-8") as fh:
            fh.write("# edited after the pull\n")
        bad = _git_commit(repo, "bad")
        code = (me, repo)

        def fx(*a, **k):
            k.setdefault("code_sha", good)
            return _fixture(root, *a, **k)

        def go(d):
            return run(d, os.path.join(d, "out"), code=code)

        # 1. lane split: bot key, other internal, automated external, external
        rows = [_R(0, "b0", internal=True, client=BOT_CLIENT), _R(10, "o0", internal=True, client="node"),
                _R(20, "x0", auto=False), _R(30, "x0", auto=True), _R(40, "x0"), _R(50, "e0")]
        v, res, _ = go(fx(rows))
        check("lane split verdict", v, "FALLBACK")
        if res:
            for lane, n in (("BOT", 1), ("OWN", 1), ("SYNTHETIC", 1), ("EXTERNAL", 1)):
                check(f"lane split {lane} callers", res["lanes"][lane]["callers"], n)
            check("all rows of an automated caller are SYNTHETIC", res["lanes"]["SYNTHETIC"]["calls"], 3)
            check("SYNTHETIC never weighted (coins come from the fallback)", res["t3_weights"]["branch"], "EQUAL")
        v, res, _ = go(fx([_R(0, "g0"), _R(60, "g0"), _R(0, "e9")], automated_elsewhere={"g0"}))
        if res:
            check("a caller automated only on get_trade_call is SYNTHETIC", res["lanes"]["SYNTHETIC"]["calls"], 2)
            check("... and leaves EXTERNAL", res["lanes"]["EXTERNAL"]["callers"], 1)

        # 2. one vote per caller: a 1,000-call caller and a 1-call caller weigh the same
        rows = [_R(k * 60, "big", coin="BTC") for k in range(1000)] + [_R(5, "small", coin="ETH")]
        v, res, _ = go(fx(rows))
        if res:
            m = res["lanes"]["EXTERNAL"]["mix"]["coin"]
            check("one vote: BTC share", m.get("BTC", 0.0), 0.5)
            check("one vote: ETH share", m.get("ETH", 0.0), 0.5)
        else:
            check("one vote fixture verdict", v, "FALLBACK")

        # 3. next tool: within 30 min counts, beyond is none, no next call is none
        rows = [_R(0, "n0", next_tool="get_trade_call", next_gap="1799.5"), _R(4000, "n0", next_tool="scan_trade_calls", next_gap="1800.001"),
                _R(9000, "n0")]
        v, res, _ = go(fx(rows))
        if res:
            nt = res["lanes"]["EXTERNAL"]["next_tool_30m"]
            check("next tool within window", nt.get("get_trade_call", 0.0), 1 / 3)
            check("next tool beyond window and absent are none", nt.get("none", 0.0), 2 / 3)
            check("beyond-window tool not counted", nt.get("scan_trade_calls", 0.0), 0.0)

        # 4. shape and hold mapping
        check("shape 0.5/0.75", nearest_shape(0.5, 0.75, None, None), "0.5/0.75")
        check("shape 1/2 without sigma", nearest_shape(1.0, 2.0, None, None), "1/2")
        check("shape sigma form made concrete by sigma_H", nearest_shape(2.0, 4.0, 1.0, 4.0), "1s/2s")
        check("same bracket without sigma maps to a fixed shape", nearest_shape(2.0, 4.0, None, None), "2.5/5")
        check("shape 1/0.5", nearest_shape(1.0, 0.5, None, None), "1/0.5")
        check("shape 0.5/0.5", nearest_shape(0.5, 0.5, None, None), "0.5/0.5")
        check("shape 1s/0.5s", nearest_shape(3.0, 1.5, 1.5, 4.0), "1s/0.5s")
        check("hold 0.3 h -> 0.25", nearest_hold(0.3, HOLDS), 0.25)
        check("hold 6 h -> 8", nearest_hold(6.0, HOLDS), 8.0)
        check("hold 0.3 h without the 0.25 bin -> 0.5", nearest_hold(0.3, BASE_HOLDS), 0.5)

        # 5. the three registered branches, at the floor
        bin8 = [_R(9_000 + i, f"w{i}", coin=c) for i, c in enumerate(W4_COINS)]
        v, res, _ = go(fx(_ext_callers(30) + bin8))
        check("EXTERNAL fires at 30 callers with >= 3 calls", res and res["t3_weights"]["branch"], "EXTERNAL")
        v, res, _ = go(fx(_ext_callers(29) + bin8, watch_rows=_chats(30)))
        check("BOT fires on 30 people when EXTERNAL is short", res and res["t3_weights"]["branch"], "BOT")
        if res:
            check("BOT timeframes mapped as the bot polls (15m -> 1h)", res["t3_weights"]["timeframes"]["1h"], 1.0)
        v, res, _ = go(fx(_ext_callers(29) + bin8, watch_rows=_chats(29) + _chats(5, blocked=True, start=100)))
        check("EQUAL when both lanes are short (blocked chats are not people)", res and res["t3_weights"]["branch"], "EQUAL")
        if res:
            check("EQUAL coins are W4's 8 at 1/8", res["t3_weights"]["coins"].get("SUI"), 1 / 8)
            check("blocked chats reported apart", res["lanes"]["BOT"]["people"]["blocked_chats"], 5)

        # 6. the panel: W4's 8 then top Binance coins, until 30 coins or 95% of the lane's Binance weight
        many = [_R(i * 7, f"p{i}", coin=f"C{i:02d}") for i in range(40)] + _ext_callers(30)
        v, res, _ = go(fx(many))
        if res:
            check("panel stops at 30 coins", len(res["t3_weights"]["panel"]), 30)
            check("panel starts with W4's 8", res["t3_weights"]["panel"][:8], W4_COINS)
            check("t3 coin weights sum to 1", sum(res["t3_weights"]["coins"].values()), 1.0)
        v, res, _ = go(fx(_ext_callers(30) + [_R(1, "q0", coin="ETH")]))
        if res:
            check("panel stops at 95% cover", res["t3_weights"]["panel"], W4_COINS)

        # 7. coin folding: PEPE joins 1000PEPE only because 1000PEPE is served on Binance
        rows = _ext_callers(30) + [_R(3, "f0", coin="1000PEPE"), _R(4, "f1", coin="PEPE", ex="HL")]
        v, res, _ = go(fx(rows))
        if res:
            check("coin fold recorded", res["rules"]["coin_folds"], ["PEPE"])
            check("folded coin carries both votes", res["lanes"]["EXTERNAL"]["mix"]["coin"].get("1000PEPE", 0.0), 2 / 32)

        # 8. venue shares only from rows with an exchange; refused calls are demand
        rows = [_R(0, "v0", ex=""), _R(10, "v0", ex="", regime=""), _R(20, "v1", ex="HL")]
        v, res, _ = go(fx(rows))
        if res:
            check("venue from stamped rows only", res["lanes"]["EXTERNAL"]["mix"]["venue"], {"HL": 1.0})
            check("refused calls counted as demand", res["lanes"]["EXTERNAL"]["refused_calls"], 1)
        rows = [_R(0, "s0", ex="", regime="", verdict=""), _R(10, "s0", regime="", verdict="ERR_TIER_LIMIT_REACHED"), _R(20, "s0")]
        v, res, _ = go(fx(rows))
        if res:
            check("an unstamped served row is not refused", res["lanes"]["EXTERNAL"]["refused_calls"], 1)
            check("unstamped rows reported apart", res["lanes"]["EXTERNAL"]["unstamped_calls"], 1)
            check("coins count every call", res["lanes"]["EXTERNAL"]["mix"]["coin"], {"BTC": 1.0})

        # 9. cadence: per caller x (coin, timeframe), median gap; each caller sums to one
        rows = [_R(k * 3600, "c0") for k in range(4)] + [_R(k * 60, "c1", coin="ETH") for k in range(3)] + [_R(k * 600, "c1", coin="SOL") for k in range(3)]
        v, res, _ = go(fx(rows))
        if res:
            cad = res["lanes"]["EXTERNAL"]["cadence_s"]
            check("cadence pairs", cad["pairs"], 3)
            check("cadence p50 weighted by caller", cad["p50"], 600.0)
            check("cadence p90", cad["p90"], 3600.0)

        # 10. brackets: canary removed and counted; floors count only checks carrying the quantity
        canary = [_C(stop=2.0, keyless=True, coin="BTC", side="long", size=10000.0, lev=5.0) for _ in range(38)]
        envp = [_C(keyless=True, coin="BTC", side="long", size=10000.0) for _ in range(7)]
        near = [_C(stop=2.0, keyless=True, coin="BTC", side="long", size=10000.0, lev=5.0, hold=4.0)]  # a real hold: kept
        bare = [_C() for _ in range(84)]
        v, res, _ = go(fx(_ext_callers(30), checks_rows=canary + envp + near + bare))
        if res:
            check("canary rows removed", res["brackets"]["canary_removed"], 45)
            check("canary removed per signature", res["brackets"]["canary_removed_by_signature"], {"P9": 38, "P7-ENV": 7})
            check("external checks", res["brackets"]["external"], 85)
            check("default-hold checks do not reach the hold floor", res["t3_weights"]["holds_branch"], "EQUAL")
            check("equal holds over five, no 0.25 h", sorted(res["t3_weights"]["holds"]), ["0.5", "24", "4", "72", "8"])
            check("verdict FALLBACK when a fallback fired", res["verdict"], "FALLBACK")
        both = [_C(stop=1.0, target=2.0, hold=4.0) for _ in range(45)] + [_C(stop=0.25, target=0.25, hold=0.25, sigma=None) for _ in range(5)]
        v, res, _ = go(fx(_ext_callers(30), checks_rows=both))
        if res:
            check("50 stop+target checks -> shape histogram", res["t3_weights"]["shapes_branch"], "HISTOGRAM")
            check("50 bracketed checks -> hold histogram", res["t3_weights"]["holds_branch"], "HISTOGRAM")
            check("0.25 h joins at exactly 10% of the hold mass", res["t3_weights"]["holds"].get("0.25"), 0.1)
            check("verdict PASS when every dimension is primary", res["verdict"], "PASS")
        v, res, _ = go(fx(_ext_callers(30), checks_rows=both[:49] + [_C(stop=1.0)]))
        if res:
            check("49 stop+target checks -> equal shapes", res["t3_weights"]["shapes_branch"], "EQUAL")
            check("a stop alone counts toward the hold floor", res["t3_weights"]["holds_branch"], "HISTOGRAM")
            check("0.25 h does not join under 10%", "0.25" in res["t3_weights"]["holds"], False)

        # 11. INDETERMINATE: empty, unparseable, altered, a non-PASS pull
        check("empty extract", go(fx([]))[0], "INDETERMINATE")
        check("unparseable boolean", go(fx([_R(0, "u0")[:3] + ["maybe"] + _R(0, "u0")[4:]]))[0], "INDETERMINATE")
        check("unparseable number", go(fx([_R(0, "u0", next_gap="0x1")]))[0], "INDETERMINATE")
        def _garble(d):
            with open(os.path.join(d, "regime.csv"), "a", encoding="utf-8") as fh:
                fh.write("tampered\n")
        check("sha256 mismatch", go(fx(_ext_callers(1), tamper=_garble))[0], "INDETERMINATE")
        check("pull not PASS", go(fx(_ext_callers(1), pull_verdict="INDETERMINATE"))[0], "INDETERMINATE")
        check("no manifest", run(os.path.join(root, "absent"), os.path.join(root, "absent-out"))[0], "INDETERMINATE")

        # 13. the mutation hook acts only inside --self-test: a real --in run with it set is INDETERMINATE
        d = fx(_ext_callers(30))
        saved = os.environ.get("REGIME_CENSUS_MUTATE")
        try:
            os.environ["REGIME_CENSUS_MUTATE"] = "call_weighting"
            out = io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
                rc = main(["--in", d, "--out", os.path.join(d, "m1")], code=code)
            check("a real run with the mutation hook set is INDETERMINATE", out.getvalue().strip().splitlines()[-1], f"{VERDICT_KEY}=INDETERMINATE")
            check("... exit 3", rc, 3)
            os.environ.pop("REGIME_CENSUS_MUTATE")
            out = io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
                rc = main(["--in", d, "--out", os.path.join(d, "m2")], code=code)
            check("the same run without it completes", out.getvalue().strip().splitlines()[-1], f"{VERDICT_KEY}=FALLBACK")
        finally:
            if saved is None:
                os.environ.pop("REGIME_CENSUS_MUTATE", None)
            else:
                os.environ["REGIME_CENSUS_MUTATE"] = saved
        v, res, path = go(fx(_ext_callers(30)))
        if res:
            check("a real result records no mutation", res["mutate"], None)
            check("the JSON names the analyzer blob it ran", res["analyzer_blob"], _git(repo, "hash-object", "--", me))

        # 14. the analyzer checks itself against the pull's code SHA
        check("an analyzer that differs from the code_sha blob is INDETERMINATE", go(fx(_ext_callers(30), code_sha=bad))[0], "INDETERMINATE")
        check("a code_sha that is not a commit is INDETERMINATE", go(fx(_ext_callers(30), code_sha="f" * 40))[0], "INDETERMINATE")
        check("a malformed code_sha is INDETERMINATE", go(fx(_ext_callers(30), code_sha="HEAD"))[0], "INDETERMINATE")

        # 15. no --out inside the repository (public): the pull's containment rule
        d = fx(_ext_callers(30))
        check("out-dir inside the repo is INDETERMINATE", run(d, os.path.join(repo, "audits"), code=code)[0], "INDETERMINATE")
        check("out-dir at the repo root is INDETERMINATE", run(d, repo, code=code)[0], "INDETERMINATE")
        check("nothing was written into the repo", os.path.exists(os.path.join(repo, "audits")), False)

        # 12. the privacy guard refuses a raw identifier pattern
        check("privacy guard: keyed ip hash", privacy_defect('{"x": "v2:0123abcd"}'), "v2:0123abcd")
        check("privacy guard: user agent", privacy_defect("Mozilla/5.0"), "Mozilla/")
        check("privacy guard: clean", privacy_defect('{"caller": "3f2a"}'), None)
        v, res, path = go(fx(_ext_callers(30)))
        if path:
            with open(path, encoding="utf-8") as fh:
                check("written JSON is clean", privacy_defect(fh.read()), None)

    floor = 78
    if cases < floor:
        print(f"[census-analyze] self-test ran {cases} checks, floor {floor}", file=sys.stderr)
        print("REGIME_CENSUS_SELFTEST_VERDICT=INDETERMINATE")
        return 3
    if fails:
        for f in fails:
            print(f"[census-analyze] self-test FAIL: {f}", file=sys.stderr)
        print("REGIME_CENSUS_SELFTEST_VERDICT=FAIL")
        return 1
    print(f"[census-analyze] self-test: {cases} checks", file=sys.stderr)
    print("REGIME_CENSUS_SELFTEST_VERDICT=PASS")
    return 0


def main(argv: list, code: tuple | None = None) -> int:
    if "--self-test" in argv:
        return self_test()
    if os.environ.get(MUTATE_ENV):
        print(f"[census-analyze] refusing: {MUTATE_ENV} is a self-test hook and acts only inside --self-test", file=sys.stderr)
        print(f"{VERDICT_KEY}=INDETERMINATE")
        return 3
    try:
        i = argv.index("--in")
        in_dir = argv[i + 1]
    except (ValueError, IndexError):
        print("usage: census_analyze.py --in <pull-dir> [--out <dir>] | --self-test", file=sys.stderr)
        print(f"{VERDICT_KEY}=INDETERMINATE")
        return 3
    out_dir = argv[argv.index("--out") + 1] if "--out" in argv and argv.index("--out") + 1 < len(argv) else in_dir
    verdict, res, jpath = run(in_dir, out_dir, code=code)
    if res and jpath:
        print(f"REGIME_CENSUS_JSON={jpath}")
        print(f"REGIME_CENSUS_JSON_SHA256={sha256_file(jpath)}")
        t = res["t3_weights"]
        L = res["lanes"]
        print(f"[census-analyze] EXTERNAL callers={L['EXTERNAL']['callers']} ge3={L['EXTERNAL']['callers_ge3']} · "
              f"SYNTHETIC={L['SYNTHETIC']['callers']} · BOT people={L['BOT']['people']['active_chats']} · OWN={L['OWN']['callers']}", file=sys.stderr)
        print(f"[census-analyze] branches coins/timeframes={t['branch']} shapes={t['shapes_branch']} holds={t['holds_branch']} "
              f"panel={len(t['panel'])} checks={res['brackets']['checks']} canary_removed={res['brackets']['canary_removed']}", file=sys.stderr)
    print(f"{VERDICT_KEY}={verdict}")
    return 3 if verdict == "INDETERMINATE" else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
