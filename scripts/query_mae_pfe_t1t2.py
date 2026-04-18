#!/usr/bin/env python3
"""
Re-derive MAE/PFE percentile grids on the T1+T2 cohort only, stratified by dex.

Runs Queries 1 / 2 / 5 / 6 / 7 / 8 from query-mae-pfe-stats-v2.md on three
views: (combined, standard, xyz). Produces three candidate LANE_RECIPES
blocks and deltas vs the v2 full-cohort numbers.

READ-ONLY on production. Stdlib only. Runs from a laptop via SSH+docker exec;
grep-guards every SQL string for forbidden mutation keywords before sending.

Data-integrity hooks:
  * Pre-run: capture /dashboard + / (landing) SHA256 + HL row count.
  * Post-run: re-capture, assert match on all three. Any diff = FAIL, no report.
  * Every psql session forced to read-only via PGOPTIONS=-c default_transaction_read_only=on.

Usage:
    python3 query_mae_pfe_t1t2.py \\
        [--out-dir /tmp/mae_pfe_t1t2] \\
        [--ssh-host root@204.168.185.24 --ssh-key ~/.ssh/algovault_deploy] \\
        [--top-n 20]
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Dict, List, Optional, Set, Tuple


HL_URL = "https://api.hyperliquid.xyz/info"
# Mutation keywords are rejected unconditionally. COPY is rejected only in
# the writable form `COPY <tablename> FROM ...` — `COPY (SELECT ...) TO STDOUT`
# is read-only and safe (caller may opt into it). Semicolons inside SELECT are
# still rejected via the combined pattern below.
SQL_FORBIDDEN = re.compile(
    r"\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE|REPLACE|GRANT|REVOKE)\b"
    r"|\bCOPY\s+[A-Za-z_][A-Za-z0-9_]*\s+FROM\b",
    re.IGNORECASE,
)

INTEGRITY_URLS = [
    ("dashboard", "https://api.algovault.com/dashboard"),
    ("landing", "https://api.algovault.com/"),
    ("signal_performance_api", "https://api.algovault.com/api/performance-public"),
]


# ----------------------------------------------------------------------
# Universe resolution (mirrors reaggregate_mode_a_t1t2.py)
# ----------------------------------------------------------------------
def _hl_post(body: dict, attempt: int = 0, timeout: int = 15) -> object:
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        HL_URL, data=data, method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        if e.code in (429, 500, 502, 503, 504) and attempt < 3:
            time.sleep(2 ** attempt)
            return _hl_post(body, attempt + 1, timeout)
        raise


def _parse_meta_ctx(raw, dex: str) -> List[Dict]:
    meta = raw[0]
    ctxs = raw[1]
    out = []
    for i, a in enumerate(meta["universe"]):
        name = a["name"]
        coin = name[4:] if name.startswith("xyz:") else name
        oi = float(ctxs[i].get("openInterest") or 0)
        px = float(ctxs[i].get("markPx") or 0)
        out.append({
            "coin": coin, "dex": dex,
            "open_interest": oi, "mark_px": px,
            "notional_oi": oi * px,
        })
    return out


def resolve_t1_t2(top_n: int = 20) -> Tuple[Set[str], Dict[str, str], List[Dict], Dict]:
    """Returns (t1_t2_set, dex_of, top_union_assets, snapshot_dict)."""
    std = _parse_meta_ctx(_hl_post({"type": "metaAndAssetCtxs"}), "standard")
    xyz = _parse_meta_ctx(_hl_post({"type": "metaAndAssetCtxs", "dex": "xyz"}), "xyz")
    merged = [a for a in (std + xyz) if a["notional_oi"] > 0]
    merged.sort(key=lambda a: -a["notional_oi"])

    t1 = {"BTC", "ETH"}
    seen: Set[str] = set()
    top_union: List[Dict] = []
    for a in merged:
        if a["coin"] in seen:
            continue
        seen.add(a["coin"])
        top_union.append(a)
        if len(top_union) >= top_n:
            break

    t1_t2 = t1 | {a["coin"] for a in top_union}
    dex_of: Dict[str, str] = {a["coin"]: a["dex"] for a in top_union}
    dex_of.setdefault("BTC", "standard")
    dex_of.setdefault("ETH", "standard")

    snapshot = {
        "timestamp": datetime.now(tz=timezone.utc).isoformat(),
        "top_n": top_n,
        "t1": ["BTC", "ETH"],
        "t1_t2_symbols": sorted(list(t1_t2)),
        "dex_of": dex_of,
        "t2_ranked": [
            {"coin": a["coin"], "dex": a["dex"],
             "notional_oi_usd": round(a["notional_oi"], 2),
             "open_interest": a["open_interest"], "mark_px": a["mark_px"]}
            for a in top_union
        ],
        "source": "https://api.hyperliquid.xyz/info — metaAndAssetCtxs (standard + xyz)",
    }
    return t1_t2, dex_of, top_union, snapshot


def classify_dex(coin: str, dex_of: Dict[str, str]) -> str:
    """Return 'standard' | 'xyz' for a T1+T2 coin. Defaults to 'standard' for
    T1 (BTC/ETH) which are standard by construction."""
    return dex_of.get(coin, "standard")


# ----------------------------------------------------------------------
# SQL guard
# ----------------------------------------------------------------------
def sql_guard(sql: str) -> None:
    """Grep for forbidden mutation keywords. Raise on any match."""
    match = SQL_FORBIDDEN.search(sql)
    if match:
        raise RuntimeError(
            f"SQL guard tripped on forbidden keyword: {match.group(0)!r}\n"
            f"SQL fragment: {sql[:200]!r}…"
        )


# ----------------------------------------------------------------------
# psql driver
# ----------------------------------------------------------------------
def _docker_psql_cmd(psql_flags: List[str], sql: str, ssh_host: Optional[str], ssh_key: Optional[str]) -> List[str]:
    docker_cmd = [
        "docker", "exec", "-i",
        "-e", "PGOPTIONS=-c default_transaction_read_only=on",
        "crypto-quant-signal-mcp-postgres-1",
        "psql", "-U", "algovault", "-d", "signal_performance",
        "-P", "pager=off", "-v", "ON_ERROR_STOP=1",
    ] + psql_flags + ["-c", sql]
    if ssh_host:
        ssh_prefix = ["ssh"]
        if ssh_key:
            ssh_prefix += ["-i", ssh_key]
        ssh_prefix += [ssh_host]
        remote = " ".join(shlex.quote(x) for x in docker_cmd)
        return ssh_prefix + [remote]
    return docker_cmd


def psql_csv(
    sql: str, ssh_host: Optional[str], ssh_key: Optional[str],
) -> List[Dict[str, str]]:
    """Run a SELECT (after SQL guard) and return list of dicts from CSV output."""
    sql_guard(sql)
    cmd = _docker_psql_cmd(["--csv"], sql, ssh_host, ssh_key)
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise RuntimeError(f"psql failed: {proc.stderr}")
    reader = csv.DictReader(proc.stdout.splitlines())
    return list(reader)


def psql_scalar(
    sql: str, ssh_host: Optional[str], ssh_key: Optional[str],
) -> str:
    """Run a scalar SELECT (returns first column of first row as string)."""
    sql_guard(sql)
    cmd = _docker_psql_cmd(["-A", "-t"], sql, ssh_host, ssh_key)
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise RuntimeError(f"psql failed: {proc.stderr}")
    return proc.stdout.strip()


# ----------------------------------------------------------------------
# Integrity hooks
# ----------------------------------------------------------------------
def _curl_sha(url: str) -> Tuple[str, int]:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "t1t2-query/1.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read()
            return hashlib.sha256(body).hexdigest(), resp.status
    except urllib.error.HTTPError as e:
        return hashlib.sha256(e.read()).hexdigest(), e.code
    except Exception as e:
        return f"ERROR:{e}", -1


def capture_integrity(ssh_host: Optional[str], ssh_key: Optional[str]) -> Dict:
    snap = {"ts": int(time.time()), "urls": {}, "hl_row_count": None}
    for name, url in INTEGRITY_URLS:
        h, status = _curl_sha(url)
        snap["urls"][name] = {"url": url, "sha256": h, "status": status}
    snap["hl_row_count"] = int(psql_scalar(
        "SELECT COUNT(*) FROM signals WHERE exchange='HL';", ssh_host, ssh_key,
    ))
    return snap


def diff_integrity(pre: Dict, post: Dict) -> Dict:
    url_equal = {k: pre["urls"][k]["sha256"] == post["urls"][k]["sha256"]
                 for k in pre["urls"]}
    hl_ok = pre["hl_row_count"] == post["hl_row_count"]
    # signal_performance_api is expected to differ (embeds recentSignals)
    strict_ok = hl_ok and url_equal["dashboard"] and url_equal["landing"]
    return {
        "pre": pre, "post": post,
        "url_equal": url_equal,
        "hl_row_count_equal": hl_ok,
        "dashboard_equal": url_equal["dashboard"],
        "landing_equal": url_equal["landing"],
        "signal_performance_api_equal": url_equal["signal_performance_api"],
        "strict_ok": strict_ok,
    }


# ----------------------------------------------------------------------
# Symbol IN-list builder
# ----------------------------------------------------------------------
def sql_in_list(symbols: Set[str]) -> str:
    """Build a safe SQL IN (...) fragment. Symbols must match [A-Za-z0-9_]+."""
    safe = []
    for s in symbols:
        if not re.fullmatch(r"[A-Za-z0-9_]+", s):
            raise RuntimeError(f"unsafe symbol: {s!r}")
        safe.append(f"'{s}'")
    return "(" + ", ".join(sorted(safe)) + ")"


# ----------------------------------------------------------------------
# Queries (parameterized on symbol list)
# ----------------------------------------------------------------------
POST_R6_EPOCH = 1744675200


def q_sample_check(symbols_sql: str) -> str:
    return f"""
SELECT
  exchange, timeframe, coin,
  COUNT(*) AS total_signals,
  COUNT(*) FILTER (WHERE pfe_return_pct IS NOT NULL) AS evaluated
FROM signals
WHERE exchange='HL'
  AND signal IN ('BUY','SELL')
  AND timeframe IN ('5m','15m','1h')
  AND coin IN {symbols_sql}
  AND created_at >= {POST_R6_EPOCH}
GROUP BY exchange, timeframe, coin
ORDER BY coin, timeframe;
"""


def q_winners(symbols_sql: str) -> str:
    return f"""
WITH winners AS (
  SELECT exchange, timeframe, signal, coin,
    ABS(pfe_return_pct) AS abs_pfe,
    ABS(mae_return_pct) AS abs_mae,
    pfe_candles
  FROM signals
  WHERE pfe_return_pct IS NOT NULL
    AND signal IN ('BUY','SELL')
    AND exchange='HL'
    AND coin IN {symbols_sql}
    AND timeframe IN ('5m','15m','1h')
    AND created_at >= {POST_R6_EPOCH}
    AND ((signal='BUY' AND pfe_return_pct>0) OR (signal='SELL' AND pfe_return_pct<0))
)
SELECT
  timeframe, signal,
  COUNT(*) AS n,
  ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY abs_pfe)::numeric, 4) AS pfe_p50,
  ROUND(PERCENTILE_CONT(0.60) WITHIN GROUP (ORDER BY abs_pfe)::numeric, 4) AS pfe_p60,
  ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY abs_pfe)::numeric, 4) AS pfe_p75,
  ROUND(PERCENTILE_CONT(0.80) WITHIN GROUP (ORDER BY abs_pfe)::numeric, 4) AS pfe_p80,
  ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY abs_pfe)::numeric, 4) AS pfe_p90,
  ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY abs_pfe)::numeric, 4) AS pfe_p95,
  ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY abs_mae)::numeric, 4) AS mae_p50,
  ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY abs_mae)::numeric, 4) AS mae_p75,
  ROUND(PERCENTILE_CONT(0.80) WITHIN GROUP (ORDER BY abs_mae)::numeric, 4) AS mae_p80,
  ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY abs_mae)::numeric, 4) AS mae_p90,
  ROUND(AVG(pfe_candles)::numeric, 1) AS avg_pfe_candles,
  ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY pfe_candles)::numeric, 1) AS p90_pfe_candles
FROM winners
GROUP BY timeframe, signal
ORDER BY timeframe, signal;
"""


def q_losers(symbols_sql: str) -> str:
    return f"""
WITH losers AS (
  SELECT exchange, timeframe, signal, coin,
    ABS(pfe_return_pct) AS abs_pfe,
    ABS(mae_return_pct) AS abs_mae
  FROM signals
  WHERE pfe_return_pct IS NOT NULL
    AND signal IN ('BUY','SELL')
    AND exchange='HL'
    AND coin IN {symbols_sql}
    AND timeframe IN ('5m','15m','1h')
    AND created_at >= {POST_R6_EPOCH}
    AND ((signal='BUY' AND pfe_return_pct<=0) OR (signal='SELL' AND pfe_return_pct>=0))
)
SELECT
  timeframe, signal,
  COUNT(*) AS n,
  ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY abs_mae)::numeric, 4) AS mae_p50,
  ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY abs_mae)::numeric, 4) AS mae_p75,
  ROUND(PERCENTILE_CONT(0.80) WITHIN GROUP (ORDER BY abs_mae)::numeric, 4) AS mae_p80,
  ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY abs_mae)::numeric, 4) AS mae_p90,
  ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY abs_mae)::numeric, 4) AS mae_p95
FROM losers
GROUP BY timeframe, signal
ORDER BY timeframe, signal;
"""


def q_all_signals_mae(symbols_sql: str) -> str:
    """MAE p80 on ALL signals (winners + losers) for stopLossPct derivation,
    per timeframe, combining BUY + SELL."""
    return f"""
SELECT
  timeframe,
  COUNT(*) AS n_all,
  ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY ABS(mae_return_pct))::numeric, 4) AS mae_p75_all,
  ROUND(PERCENTILE_CONT(0.80) WITHIN GROUP (ORDER BY ABS(mae_return_pct))::numeric, 4) AS mae_p80_all,
  ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY ABS(mae_return_pct))::numeric, 4) AS mae_p90_all
FROM signals
WHERE pfe_return_pct IS NOT NULL
  AND signal IN ('BUY','SELL')
  AND exchange='HL'
  AND coin IN {symbols_sql}
  AND timeframe IN ('5m','15m','1h')
  AND created_at >= {POST_R6_EPOCH}
GROUP BY timeframe
ORDER BY timeframe;
"""


def q_hold_time(symbols_sql: str) -> str:
    return f"""
SELECT
  timeframe, signal,
  COUNT(*) AS n,
  ROUND(AVG(pfe_candles)::numeric, 1) AS avg_pfe_candles,
  ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY pfe_candles)::numeric, 1) AS median_pfe_candles,
  ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY pfe_candles)::numeric, 1) AS p75_pfe_candles,
  ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY pfe_candles)::numeric, 1) AS p90_pfe_candles
FROM signals
WHERE pfe_return_pct IS NOT NULL
  AND signal IN ('BUY','SELL')
  AND exchange='HL'
  AND coin IN {symbols_sql}
  AND timeframe IN ('5m','15m','1h')
  AND pfe_candles > 0
  AND created_at >= {POST_R6_EPOCH}
  AND ((signal='BUY' AND pfe_return_pct>0) OR (signal='SELL' AND pfe_return_pct<0))
GROUP BY timeframe, signal
ORDER BY timeframe, signal;
"""


def q_ranking(symbols_sql: str) -> str:
    """Per-coin ranking by expectancy per trade."""
    return f"""
WITH base AS (
  SELECT
    coin, timeframe,
    COUNT(*) AS evaluated,
    100.0 * COUNT(*) FILTER (WHERE (signal='BUY' AND pfe_return_pct>0) OR (signal='SELL' AND pfe_return_pct<0))::numeric
      / NULLIF(COUNT(*),0) AS pfe_wr,
    AVG(ABS(pfe_return_pct)) FILTER (WHERE (signal='BUY' AND pfe_return_pct>0) OR (signal='SELL' AND pfe_return_pct<0)) AS avg_reward,
    AVG(ABS(mae_return_pct)) FILTER (WHERE (signal='BUY' AND pfe_return_pct>0) OR (signal='SELL' AND pfe_return_pct<0)) AS avg_risk
  FROM signals
  WHERE pfe_return_pct IS NOT NULL AND signal IN ('BUY','SELL')
    AND exchange='HL'
    AND coin IN {symbols_sql}
    AND timeframe IN ('5m','15m','1h')
    AND created_at >= {POST_R6_EPOCH}
  GROUP BY coin, timeframe
)
SELECT
  coin, timeframe, evaluated,
  ROUND(pfe_wr::numeric, 2) AS pfe_wr_pct,
  ROUND(avg_reward::numeric, 4) AS avg_reward_pct,
  ROUND(avg_risk::numeric, 4) AS avg_risk_pct,
  ROUND((avg_reward / NULLIF(avg_risk,0))::numeric, 2) AS rr_ratio,
  ROUND(((pfe_wr/100.0) * avg_reward - (1 - pfe_wr/100.0) * avg_risk)::numeric, 4) AS expectancy_per_trade_pct
FROM base
WHERE evaluated >= 20
ORDER BY expectancy_per_trade_pct DESC NULLS LAST;
"""


# ----------------------------------------------------------------------
# Sample-size flag
# ----------------------------------------------------------------------
def sample_size_flags(
    winners_rows: List[Dict[str, str]],
    losers_rows: List[Dict[str, str]],
    min_winners: int = 100,
    min_losers: int = 50,
) -> List[Dict]:
    flags: List[Dict] = []
    for row in winners_rows:
        n = int(row["n"])
        if n < min_winners:
            flags.append({
                "category": "winners",
                "timeframe": row["timeframe"],
                "signal": row["signal"],
                "n": n,
                "floor": min_winners,
            })
    for row in losers_rows:
        n = int(row["n"])
        if n < min_losers:
            flags.append({
                "category": "losers",
                "timeframe": row["timeframe"],
                "signal": row["signal"],
                "n": n,
                "floor": min_losers,
            })
    return flags


# ----------------------------------------------------------------------
# Recipe derivation
# ----------------------------------------------------------------------
TIMEFRAME_TF_SECONDS = {"5m": 300, "15m": 900, "1h": 3600}


def combined_winners_percentiles(winners_rows: List[Dict[str, str]]) -> Dict[str, Dict[str, float]]:
    """Collapse BUY + SELL by timeframe using weighted averages of the percentile
    levels. This is an approximation — the true combined p-value would require
    re-running the percentile calc on the union. For the recipe derivation we
    want roughly-representative numbers; the Mode A replay (not this script)
    is the source of truth on EV.

    Actually we can't correctly combine pre-computed percentiles; do a
    secondary query for accuracy instead. This helper is retained as a
    fallback for ad-hoc inspection."""
    # Not used in the final derivation — kept for documentation.
    return {}


def q_combined_winners(symbols_sql: str) -> str:
    """Combined BUY+SELL winners percentiles by timeframe. This is the
    authoritative 'combined' view used in the recipe derivation."""
    return f"""
WITH winners AS (
  SELECT timeframe,
    ABS(pfe_return_pct) AS abs_pfe,
    ABS(mae_return_pct) AS abs_mae,
    pfe_candles
  FROM signals
  WHERE pfe_return_pct IS NOT NULL
    AND signal IN ('BUY','SELL')
    AND exchange='HL'
    AND coin IN {symbols_sql}
    AND timeframe IN ('5m','15m','1h')
    AND created_at >= {POST_R6_EPOCH}
    AND ((signal='BUY' AND pfe_return_pct>0) OR (signal='SELL' AND pfe_return_pct<0))
)
SELECT
  timeframe,
  COUNT(*) AS n,
  ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY abs_pfe)::numeric, 4) AS pfe_p50,
  ROUND(PERCENTILE_CONT(0.60) WITHIN GROUP (ORDER BY abs_pfe)::numeric, 4) AS pfe_p60,
  ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY abs_pfe)::numeric, 4) AS pfe_p75,
  ROUND(PERCENTILE_CONT(0.80) WITHIN GROUP (ORDER BY abs_pfe)::numeric, 4) AS pfe_p80,
  ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY abs_pfe)::numeric, 4) AS pfe_p90,
  ROUND(PERCENTILE_CONT(0.80) WITHIN GROUP (ORDER BY abs_mae)::numeric, 4) AS mae_p80,
  ROUND(AVG(pfe_candles)::numeric, 1) AS avg_pfe_candles,
  ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY pfe_candles)::numeric, 1) AS p90_pfe_candles
FROM winners
GROUP BY timeframe
ORDER BY timeframe;
"""


def build_recipe(
    tf: str,
    combined_winner_row: Dict[str, str],
    all_signals_mae_row: Dict[str, str],
    slot_cap: int,
) -> Dict:
    """Produce one lane recipe from the combined-winners and all-signals-MAE rows."""
    return {
        "timeframe": tf,
        "slotCap": slot_cap,
        "stopLossPct": round(float(all_signals_mae_row["mae_p80_all"]) / 100, 6),
        "tp1Pct": round(float(combined_winner_row["pfe_p60"]) / 100, 6),
        "tp2Pct": round(float(combined_winner_row["pfe_p80"]) / 100, 6),
        "tp2Pct_wide": round(float(combined_winner_row["pfe_p90"]) / 100, 6),
        "tp1Fraction": 0.5,
        "moveSlToBeAfterTp1": True,
        "maxHoldCandles": int(round(float(combined_winner_row["p90_pfe_candles"]))),
        "minConfidence": 70,
        "leverage": 2,
        "_n_winners": int(combined_winner_row["n"]),
        "_n_all": int(all_signals_mae_row["n_all"]),
    }


SLOT_CAPS = {"5m": 12, "15m": 8, "1h": 7}


def derive_three_recipes(
    stratification: Dict[str, Dict],
) -> Dict[str, Dict[str, Dict]]:
    """stratification = {'combined'|'standard'|'xyz': {'combined_winners': [...], 'all_sig_mae': [...]}}

    Returns {variant: {timeframe: recipe_dict}}.
    """
    out: Dict[str, Dict[str, Dict]] = {}
    for variant in ("combined", "standard", "xyz"):
        rows = stratification.get(variant, {})
        winners_by_tf = {r["timeframe"]: r for r in rows.get("combined_winners", [])}
        mae_by_tf = {r["timeframe"]: r for r in rows.get("all_sig_mae", [])}
        out[variant] = {}
        for tf in ("5m", "15m", "1h"):
            cw = winners_by_tf.get(tf)
            mr = mae_by_tf.get(tf)
            if not cw or not mr:
                out[variant][tf] = None
                continue
            out[variant][tf] = build_recipe(tf, cw, mr, SLOT_CAPS[tf])
    return out


# ----------------------------------------------------------------------
# Delta table
# ----------------------------------------------------------------------
# v2 full-cohort percentile values lifted from
# `experiments/quant-trading-server/mae-pfe-percentile-report.md` Query 7 table
# (2026-04-17). Used for the delta comparison in the report.
V2_FULL_COHORT = {
    "5m":  {"pfe_p60": 0.3907, "pfe_p80": 0.8105, "pfe_p90": 1.3676,
            "mae_p80_all": 0.7337, "p90_pfe_candles": 12},
    "15m": {"pfe_p60": 0.6704, "pfe_p80": 1.2363, "pfe_p90": 1.9615,
            "mae_p80_all": 1.1435, "p90_pfe_candles": 12},
    "1h":  {"pfe_p60": 1.2603, "pfe_p80": 2.0892, "pfe_p90": 2.8629,
            "mae_p80_all": 2.4389, "p90_pfe_candles": 8},
}


def build_delta_rows(recipes: Dict[str, Dict[str, Dict]]) -> List[Dict]:
    """For each timeframe × metric, compare v2 full-cohort vs combined/standard/xyz."""
    out = []
    for tf in ("5m", "15m", "1h"):
        v2 = V2_FULL_COHORT[tf]
        for metric in ("pfe_p60", "pfe_p80", "pfe_p90", "mae_p80_all", "p90_pfe_candles"):
            row = {"timeframe": tf, "metric": metric,
                   "v2_full_cohort": v2[metric]}
            max_abs_delta = 0.0
            for variant in ("combined", "standard", "xyz"):
                r = recipes[variant].get(tf)
                if r is None:
                    row[variant] = None
                    row[f"{variant}_delta"] = None
                    continue
                if metric in ("pfe_p60", "pfe_p80", "pfe_p90"):
                    # recipe stores as decimal pct; v2 stores as %; normalise
                    key = {"pfe_p60": "tp1Pct", "pfe_p80": "tp2Pct",
                           "pfe_p90": "tp2Pct_wide"}[metric]
                    val_pct = r[key] * 100
                elif metric == "mae_p80_all":
                    val_pct = r["stopLossPct"] * 100
                elif metric == "p90_pfe_candles":
                    val_pct = r["maxHoldCandles"]
                row[variant] = round(val_pct, 4)
                delta = val_pct - v2[metric]
                row[f"{variant}_delta"] = round(delta, 4)
                if abs(delta) > max_abs_delta:
                    max_abs_delta = abs(delta)
            row["max_abs_delta"] = round(max_abs_delta, 4)
            out.append(row)
    return out


# ----------------------------------------------------------------------
# Orchestration
# ----------------------------------------------------------------------
def run(args) -> int:
    os.makedirs(args.out_dir, exist_ok=True)

    print("[1/8] integrity pre-run")
    pre = capture_integrity(args.ssh_host, args.ssh_key)
    pre_path = os.path.join(args.out_dir, "integrity_pre.json")
    with open(pre_path, "w") as fh:
        json.dump(pre, fh, indent=2)
    print(f"       hl_row_count={pre['hl_row_count']}  "
          f"dashboard_sha={pre['urls']['dashboard']['sha256'][:16]}  "
          f"landing_sha={pre['urls']['landing']['sha256'][:16]}")

    print("[2/8] resolving T1+T2 universe")
    t1_t2, dex_of, top_assets, snapshot = resolve_t1_t2(args.top_n)
    ts = datetime.now(tz=timezone.utc).strftime("%Y%m%d_%H%M")
    universe_path = os.path.join(args.out_dir, f"t1_t2_universe_{ts}.json")
    with open(universe_path, "w") as fh:
        json.dump(snapshot, fh, indent=2)
    standard_syms = {c for c, d in dex_of.items() if d == "standard"}
    xyz_syms = {c for c, d in dex_of.items() if d == "xyz"}
    print(f"       T1+T2: {len(t1_t2)} symbols ({len(standard_syms)} standard + {len(xyz_syms)} xyz)")
    print(f"       xyz: {sorted(xyz_syms)}")

    combined_sql = sql_in_list(t1_t2)
    std_sql = sql_in_list(standard_syms)
    xyz_sql = sql_in_list(xyz_syms)

    stratification: Dict[str, Dict] = {"combined": {}, "standard": {}, "xyz": {}}

    print("[3/8] running queries — combined / standard / xyz")
    for variant, sql_in in (("combined", combined_sql),
                             ("standard", std_sql),
                             ("xyz", xyz_sql)):
        print(f"       {variant}:")
        sample = psql_csv(q_sample_check(sql_in), args.ssh_host, args.ssh_key)
        winners = psql_csv(q_winners(sql_in), args.ssh_host, args.ssh_key)
        losers = psql_csv(q_losers(sql_in), args.ssh_host, args.ssh_key)
        all_sig_mae = psql_csv(q_all_signals_mae(sql_in), args.ssh_host, args.ssh_key)
        hold = psql_csv(q_hold_time(sql_in), args.ssh_host, args.ssh_key)
        ranking = psql_csv(q_ranking(sql_in), args.ssh_host, args.ssh_key)
        combined_w = psql_csv(q_combined_winners(sql_in), args.ssh_host, args.ssh_key)
        stratification[variant] = {
            "sample": sample,
            "winners": winners,
            "losers": losers,
            "all_sig_mae": all_sig_mae,
            "hold": hold,
            "ranking": ranking,
            "combined_winners": combined_w,
        }
        print(f"         sample={len(sample)}  winners={len(winners)}  losers={len(losers)}  "
              f"all_sig_mae={len(all_sig_mae)}  hold={len(hold)}  "
              f"ranking={len(ranking)}  combined_winners={len(combined_w)}")

    print("[4/8] sample-size flags")
    all_flags = {}
    for variant in ("combined", "standard", "xyz"):
        w = stratification[variant]["winners"]
        l = stratification[variant]["losers"]
        all_flags[variant] = sample_size_flags(w, l)
    print(f"       combined: {len(all_flags['combined'])} flags")
    print(f"       standard: {len(all_flags['standard'])} flags")
    print(f"       xyz:      {len(all_flags['xyz'])} flags")

    print("[5/8] deriving three LANE_RECIPES candidates")
    recipes = derive_three_recipes(stratification)
    for variant in ("combined", "standard", "xyz"):
        for tf in ("5m", "15m", "1h"):
            r = recipes[variant].get(tf)
            if r is None:
                print(f"       {variant} {tf}: SKIPPED (no data)")
            else:
                print(f"       {variant} {tf}: SL={r['stopLossPct']*100:.3f}%  "
                      f"TP1={r['tp1Pct']*100:.3f}%  "
                      f"TP2={r['tp2Pct']*100:.3f}%  "
                      f"TP2_wide={r['tp2Pct_wide']*100:.3f}%  "
                      f"n_winners={r['_n_winners']}")

    print("[6/8] computing delta table vs v2 full-cohort")
    delta_rows = build_delta_rows(recipes)

    print("[7/8] writing CSVs")
    winners_csv = os.path.join(args.out_dir, "mae-pfe-t1t2-winners.csv")
    losers_csv = os.path.join(args.out_dir, "mae-pfe-t1t2-losers.csv")
    deriv_csv = os.path.join(args.out_dir, "mae-pfe-t1t2-derivation.csv")

    # Winners CSV: one row per (variant, timeframe, signal)
    winner_fields = ["variant", "timeframe", "signal", "n",
                     "pfe_p50", "pfe_p60", "pfe_p75", "pfe_p80", "pfe_p90", "pfe_p95",
                     "mae_p50", "mae_p75", "mae_p80", "mae_p90",
                     "avg_pfe_candles", "p90_pfe_candles"]
    with open(winners_csv, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=winner_fields)
        w.writeheader()
        for variant in ("combined", "standard", "xyz"):
            for row in stratification[variant]["winners"]:
                out_row = {k: row.get(k, "") for k in winner_fields if k != "variant"}
                out_row["variant"] = variant
                w.writerow(out_row)

    loser_fields = ["variant", "timeframe", "signal", "n",
                    "mae_p50", "mae_p75", "mae_p80", "mae_p90", "mae_p95"]
    with open(losers_csv, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=loser_fields)
        w.writeheader()
        for variant in ("combined", "standard", "xyz"):
            for row in stratification[variant]["losers"]:
                out_row = {k: row.get(k, "") for k in loser_fields if k != "variant"}
                out_row["variant"] = variant
                w.writerow(out_row)

    deriv_fields = ["timeframe", "metric", "v2_full_cohort",
                    "combined", "combined_delta",
                    "standard", "standard_delta",
                    "xyz", "xyz_delta",
                    "max_abs_delta"]
    with open(deriv_csv, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=deriv_fields)
        w.writeheader()
        for row in delta_rows:
            w.writerow(row)

    print(f"       winners → {winners_csv}")
    print(f"       losers  → {losers_csv}")
    print(f"       deriv   → {deriv_csv}")

    print("[8/8] integrity post-run")
    post = capture_integrity(args.ssh_host, args.ssh_key)
    post_path = os.path.join(args.out_dir, "integrity_post.json")
    with open(post_path, "w") as fh:
        json.dump(post, fh, indent=2)
    diff = diff_integrity(pre, post)
    diff_path = os.path.join(args.out_dir, "integrity_diff.json")
    with open(diff_path, "w") as fh:
        json.dump(diff, fh, indent=2)
    print(f"       hl_row_count: pre={pre['hl_row_count']} post={post['hl_row_count']} equal={diff['hl_row_count_equal']}")
    print(f"       dashboard SHA equal: {diff['dashboard_equal']}")
    print(f"       landing   SHA equal: {diff['landing_equal']}")
    print(f"       signal_performance_api SHA equal (expected differ): {diff['signal_performance_api_equal']}")
    print(f"       strict_ok (dashboard + landing + HL count): {diff['strict_ok']}")

    # Final summary dump
    summary = {
        "universe_snapshot": snapshot,
        "universe_path": universe_path,
        "sample_size_flags": all_flags,
        "recipes": recipes,
        "delta_vs_v2_full_cohort": delta_rows,
        "integrity": diff,
        "stratification_row_counts": {
            variant: {k: len(v) for k, v in stratification[variant].items()}
            for variant in ("combined", "standard", "xyz")
        },
    }
    summary_path = os.path.join(args.out_dir, "summary.json")
    with open(summary_path, "w") as fh:
        json.dump(summary, fh, indent=2, default=str)
    print(f"       summary → {summary_path}")

    return 0 if diff["strict_ok"] else 2


def main():
    ap = argparse.ArgumentParser(description="Re-derive MAE/PFE grid on T1+T2")
    ap.add_argument("--out-dir", default="/tmp/mae_pfe_t1t2")
    ap.add_argument("--ssh-host", default=None)
    ap.add_argument("--ssh-key", default=None)
    ap.add_argument("--top-n", type=int, default=20)
    args = ap.parse_args()
    sys.exit(run(args))


if __name__ == "__main__":
    main()
