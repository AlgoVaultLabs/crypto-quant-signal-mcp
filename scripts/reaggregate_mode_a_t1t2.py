#!/usr/bin/env python3
"""
Reaggregate Mode A v2 filtered to T1+T2 (BTC/ETH + HL top-20 OI union across
standard AND xyz dexes).

Extends Mode A v2 by:
  1. Resolving T1+T2 by calling HL public `metaAndAssetCtxs` for both
     standard and xyz dexes, unioning by notional OI, taking top 20 (+ T1).
  2. Identifying NO_DATA signals in v2 rows.csv where symbol ∈ T1_T2 AND
     dex == 'xyz' — these were stubbed because v1/v2 candle fetches lacked
     the `xyz:` prefix.
  3. Re-fetching HL 5m candles for those (coin, day) pairs using
     `req.coin = "xyz:<COIN>"` (mirrors the production HL adapter).
  4. Replaying the re-fetched signals via v2's `replay_variant` across all
     four recipe variants (V0 / V1 / V2 / V3).
  5. Merging new real outcomes over the NO_DATA stubs in v2 rows.csv,
     producing a combined rows CSV (original v2 CSV untouched; script asserts
     the SHA256 pre/post).
  6. Filtering to T1+T2 AND non-NO_DATA AND non-coverage_warning, then
     re-aggregating the 16-cell matrix via v2's `aggregate_cell`.
  7. Producing per-cell delta table vs the v2 full-cohort.

READ-ONLY on production DB + endpoints. Stdlib only. Runs from a laptop
(the VPS IP is HL-rate-limited per v1 caveat).

Usage:
    python3 reaggregate_mode_a_t1t2.py \\
        [--v2-rows-csv /tmp/mode_a_laptop_v2/rows.csv] \\
        [--v2-summary-json /tmp/mode_a_laptop_v2/summary.json] \\
        [--out-dir /tmp/mode_a_t1t2] \\
        [--xyz-cache-dir /tmp/hl_candles_xyz] \\
        [--top-n 20]
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import asdict
from datetime import datetime, timezone, timedelta
from typing import Dict, List, Optional, Set, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from backtest_hl_lanes_mode_a import (  # noqa: E402
    Candle, Signal, SignalOutcome,
    FEE_TAKER_ROUND_TRIP, FEE_STRESS,
    LANE_RECIPES as V1_RECIPES,
    confidence_band,
)
from backtest_hl_lanes_mode_a_v2 import (  # noqa: E402
    VARIANTS, VARIANT_LABEL, TRAIL_PCT,
    replay_variant,
    aggregate_cell,
    rank_cells,
    OUTCOME_ORDER, WIN_TYPES,
)

HL_URL = "https://api.hyperliquid.xyz/info"
HL_RATE_LIMIT_DELAY = 0.25   # 4 req/s — well under the 20 req/s cap
MIN_BAR_COMPLETENESS = 0.90
CANDLE_INTERVAL = "5m"
CANDLE_INTERVAL_SECONDS = 300


# ----------------------------------------------------------------------
# Phase 1 — OI resolution across both dexes
# ----------------------------------------------------------------------
def _hl_post(body: dict, attempt: int = 0, timeout: int = 15) -> object:
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        HL_URL, data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
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
    """Convert (meta, ctxs) to [{coin, dex, oi, mark_px, notional_oi}].

    For xyz, strip the 'xyz:' prefix on coin names (bare symbols are used
    throughout the codebase; the xyz: prefix is only for candle API calls).
    """
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


def fetch_oi_both_dexes() -> List[Dict]:
    """Return merged standard + xyz assets sorted by notional_oi desc.
    If a coin exists on both dexes (rare), keep both rows so the caller can
    see each dex's entry; the union-top-20 selection will surface the higher-OI
    entry naturally."""
    std_raw = _hl_post({"type": "metaAndAssetCtxs"})
    xyz_raw = _hl_post({"type": "metaAndAssetCtxs", "dex": "xyz"})
    assets = _parse_meta_ctx(std_raw, "standard") + _parse_meta_ctx(xyz_raw, "xyz")
    assets = [a for a in assets if a["notional_oi"] > 0]
    assets.sort(key=lambda a: -a["notional_oi"])
    return assets


def resolve_t1_t2(top_n: int = 20) -> Tuple[Set[str], Dict[str, str], List[Dict]]:
    """Return (t1_t2_set, dex_of, top_n_assets_list)."""
    assets = fetch_oi_both_dexes()
    t1 = {"BTC", "ETH"}
    top_union: List[Dict] = []
    seen: Set[str] = set()
    for a in assets:
        if a["coin"] in seen:
            continue
        seen.add(a["coin"])
        top_union.append(a)
        if len(top_union) >= top_n:
            break
    t1_t2 = t1 | {a["coin"] for a in top_union}
    dex_of: Dict[str, str] = {}
    for a in top_union:
        dex_of[a["coin"]] = a["dex"]
    # T1 is standard by construction
    dex_of.setdefault("BTC", "standard")
    dex_of.setdefault("ETH", "standard")
    return t1_t2, dex_of, top_union


# ----------------------------------------------------------------------
# Phase 3 — xyz candle fetch
# ----------------------------------------------------------------------
def _utc_day_bounds_ms(day_utc: datetime) -> Tuple[int, int]:
    start = day_utc.replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=timezone.utc)
    end = start + timedelta(days=1)
    return int(start.timestamp() * 1000), int(end.timestamp() * 1000) - 1


def xyz_cache_path(cache_dir: str, coin: str, day_utc: datetime) -> str:
    return os.path.join(cache_dir, f"hl_candles_xyz_{coin}_{day_utc.strftime('%Y%m%d')}.json")


def fetch_xyz_candles_for_day(cache_dir: str, coin: str, day_utc: datetime) -> List[Candle]:
    """Fetch 5m bars for an xyz perp on the given UTC day. Uses the
    `xyz:${coin}` prefix per HL adapter convention."""
    path = xyz_cache_path(cache_dir, coin, day_utc)
    if os.path.exists(path) and os.path.getsize(path) > 0:
        with open(path) as fh:
            raw = json.load(fh)
    else:
        start_ms, end_ms = _utc_day_bounds_ms(day_utc)
        body = {
            "type": "candleSnapshot",
            "req": {
                "coin": f"xyz:{coin}",
                "interval": CANDLE_INTERVAL,
                "startTime": start_ms,
                "endTime": end_ms,
            },
        }
        try:
            raw = _hl_post(body)
        except urllib.error.HTTPError as e:
            sys.stderr.write(f"[xyz-fetch] xyz:{coin} {day_utc:%Y-%m-%d}: HTTP {e.code}\n")
            raw = []
        os.makedirs(cache_dir, exist_ok=True)
        with open(path, "w") as fh:
            json.dump(raw, fh)
        time.sleep(HL_RATE_LIMIT_DELAY)
    if not isinstance(raw, list):
        return []
    return [Candle(
        t_ms=int(r["t"]),
        o=float(r["o"]), h=float(r["h"]),
        l=float(r["l"]), c=float(r["c"]),
    ) for r in raw if isinstance(r, dict)]


def xyz_candles_for_signal_window(
    cache_dir: str, coin: str, start_ts: int, max_hold_seconds: int,
) -> Tuple[List[Candle], bool]:
    start_dt = datetime.fromtimestamp(start_ts, tz=timezone.utc)
    end_dt = datetime.fromtimestamp(start_ts + max_hold_seconds, tz=timezone.utc)
    days: List[datetime] = []
    cur = start_dt.replace(hour=0, minute=0, second=0, microsecond=0)
    end_day = end_dt.replace(hour=0, minute=0, second=0, microsecond=0)
    while cur <= end_day:
        days.append(cur)
        cur += timedelta(days=1)
    all_bars: List[Candle] = []
    for d in days:
        try:
            all_bars.extend(fetch_xyz_candles_for_day(cache_dir, coin, d))
        except Exception as e:
            sys.stderr.write(f"[xyz-fetch] {coin} {d:%Y-%m-%d}: {e}\n")
    start_ms = start_ts * 1000
    end_ms = (start_ts + max_hold_seconds) * 1000
    windowed = [b for b in all_bars if start_ms <= b.t_ms <= end_ms]
    windowed.sort(key=lambda b: b.t_ms)
    expected = max(max_hold_seconds // CANDLE_INTERVAL_SECONDS + 1, 1)
    coverage_warning = (len(windowed) / expected) < MIN_BAR_COMPLETENESS
    return windowed, coverage_warning


# ----------------------------------------------------------------------
# Phase 2 — identify xyz re-fetch list
# ----------------------------------------------------------------------
def load_v2_rows(path: str) -> List[Dict[str, str]]:
    with open(path) as fh:
        return list(csv.DictReader(fh))


def identify_xyz_refetch(
    v2_rows: List[Dict[str, str]],
    t1_t2: Set[str],
    dex_of: Dict[str, str],
) -> List[Dict]:
    """Return distinct (signal_id, symbol, direction, confidence, created_at,
    entry_price, timeframe) tuples where symbol ∈ T1_T2 AND dex == 'xyz' AND
    at least one variant row is NO_DATA. (NO_DATA is variant-independent —
    all 4 variants will agree on NO_DATA when candles are missing.)"""
    signal_keys: Dict[int, Dict] = {}
    for row in v2_rows:
        sym = row["symbol"]
        if sym not in t1_t2:
            continue
        if dex_of.get(sym) != "xyz":
            continue
        if row["outcome_type"] != "NO_DATA":
            continue
        sid = int(row["signal_id"])
        if sid in signal_keys:
            continue
        signal_keys[sid] = {
            "signal_id": sid,
            "symbol": sym,
            "direction": row["direction"],
            "confidence": int(row["confidence"]),
            "created_at": int(row["created_at"]),
            "timeframe": row["timeframe"],
        }
    return sorted(signal_keys.values(), key=lambda r: r["signal_id"])


# ----------------------------------------------------------------------
# Phase 4 — replay re-fetched signals
# ----------------------------------------------------------------------
def load_entry_price(v2_rows: List[Dict[str, str]], signal_id: int) -> float:
    """Look up entry_price from the v2 rows (any variant works — same signal)."""
    for row in v2_rows:
        if int(row["signal_id"]) == signal_id:
            # v2 CSV doesn't have entry_price column — look it up in signals.csv
            raise RuntimeError("use load_signals_map instead")
    raise KeyError(signal_id)


def load_signals_map(signals_csv: str) -> Dict[int, Dict]:
    """Load the full signals CSV into a {signal_id: row} map for entry_price lookup."""
    out: Dict[int, Dict] = {}
    with open(signals_csv) as fh:
        for row in csv.DictReader(fh):
            out[int(row["id"])] = row
    return out


def replay_xyz_signals(
    refetch_list: List[Dict],
    signals_map: Dict[int, Dict],
    xyz_cache_dir: str,
    out_csv: str,
) -> Tuple[int, Dict[str, int]]:
    """Replay each re-fetched signal across all 4 variants. Return
    (rows_written, coverage_warnings_by_coin_day)."""
    coverage_warnings: Dict[str, int] = {}
    rows_written = 0
    with open(out_csv, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow([
            "signal_id", "variant_id", "timeframe", "direction", "confidence",
            "symbol", "created_at", "outcome_type", "realized_pnl_pct",
            "tp1_hit_ts", "tp2_hit_ts", "sl_hit_ts", "trail_exit_ts", "exit_ts",
            "candles_to_exit", "same_bar_tp1_sl_tie", "coverage_warning",
        ])
        for i, refetch in enumerate(refetch_list):
            if i % 100 == 0 and i > 0:
                print(f"       replayed {i}/{len(refetch_list)}")
            sig_row = signals_map.get(refetch["signal_id"])
            if not sig_row:
                sys.stderr.write(f"[replay] signal {refetch['signal_id']} not in signals_map\n")
                continue
            entry_price = float(sig_row["entry_price"])
            signal = Signal(
                signal_id=refetch["signal_id"],
                coin=refetch["symbol"],
                direction=refetch["direction"],
                entry_price=entry_price,
                confidence=refetch["confidence"],
                created_at=refetch["created_at"],
                timeframe=refetch["timeframe"],
                pfe_return_pct=None, mae_pct=None, regime=None,
            )
            recipe = V1_RECIPES[signal.timeframe]
            max_hold_seconds = int(recipe["maxHoldCandles"]) * int(recipe["tf_seconds"])
            bars, cov_warn = xyz_candles_for_signal_window(
                xyz_cache_dir, signal.coin, signal.created_at, max_hold_seconds,
            )
            day_key = datetime.fromtimestamp(signal.created_at, tz=timezone.utc).strftime("%Y%m%d")
            if cov_warn:
                coverage_warnings[f"{signal.coin}_{day_key}"] = len(bars)

            for vid, vspec in VARIANTS[signal.timeframe].items():
                o = replay_variant(signal, bars, recipe, vspec,
                                   tie_sl_first=True, coverage_warning=cov_warn)
                trail_ts = ""
                if o.outcome_type == "TP1_TRAIL":
                    trail_ts = o.sl_hit_ts or ""
                    sl_ts_csv = ""
                else:
                    sl_ts_csv = o.sl_hit_ts or ""
                w.writerow([
                    o.signal_id, vid, o.timeframe, o.direction, o.confidence,
                    o.symbol, o.created_at, o.outcome_type,
                    f"{o.realized_pnl_pct:.8f}",
                    o.tp1_hit_ts or "", o.tp2_hit_ts or "",
                    sl_ts_csv, trail_ts, o.exit_ts or "",
                    o.candles_to_exit, o.same_bar_tp1_sl_tie, o.coverage_warning,
                ])
                rows_written += 1
    return rows_written, coverage_warnings


# ----------------------------------------------------------------------
# Phase 5 — merge
# ----------------------------------------------------------------------
def sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            buf = fh.read(1 << 16)
            if not buf:
                break
            h.update(buf)
    return h.hexdigest()


def merge_rows(
    v2_csv: str, xyz_rows_csv: str, combined_csv: str,
) -> Dict:
    """Merge xyz real-outcome rows over NO_DATA stubs in v2 CSV. Assert that
    v2 CSV SHA is unchanged pre/post."""
    v2_sha_pre = sha256_of(v2_csv)
    # Build xyz rows lookup: (signal_id, variant_id) → row
    xyz_lookup: Dict[Tuple[int, str], Dict[str, str]] = {}
    with open(xyz_rows_csv) as fh:
        for row in csv.DictReader(fh):
            xyz_lookup[(int(row["signal_id"]), row["variant_id"])] = row

    replaced = 0
    preserved = 0
    with open(v2_csv) as ih, open(combined_csv, "w", newline="") as oh:
        reader = csv.DictReader(ih)
        fieldnames = reader.fieldnames
        writer = csv.DictWriter(oh, fieldnames=fieldnames)
        writer.writeheader()
        for row in reader:
            key = (int(row["signal_id"]), row["variant_id"])
            if (row["outcome_type"] == "NO_DATA"
                    and key in xyz_lookup
                    and xyz_lookup[key]["outcome_type"] != "NO_DATA"):
                writer.writerow({k: xyz_lookup[key].get(k, "") for k in fieldnames})
                replaced += 1
            else:
                writer.writerow(row)
                preserved += 1

    v2_sha_post = sha256_of(v2_csv)
    assert v2_sha_pre == v2_sha_post, \
        f"v2 CSV mutated during merge! pre={v2_sha_pre[:12]} post={v2_sha_post[:12]}"

    return {
        "v2_sha": v2_sha_pre,
        "n_replaced": replaced,
        "n_preserved": preserved,
        "n_xyz_new_rows": len(xyz_lookup),
    }


# ----------------------------------------------------------------------
# Phase 6 — filter + aggregate
# ----------------------------------------------------------------------
def filter_combined(
    combined_csv: str, t1_t2: Set[str], filtered_csv: str,
) -> int:
    """Filter combined CSV to T1+T2, non-NO_DATA, non-coverage-warning.
    Returns count of retained rows."""
    retained = 0
    with open(combined_csv) as ih, open(filtered_csv, "w", newline="") as oh:
        reader = csv.DictReader(ih)
        writer = csv.DictWriter(oh, fieldnames=reader.fieldnames)
        writer.writeheader()
        for row in reader:
            if row["symbol"] not in t1_t2:
                continue
            if row["outcome_type"] == "NO_DATA":
                continue
            if row["coverage_warning"] in ("True", "true", "1"):
                continue
            writer.writerow(row)
            retained += 1
    return retained


def rows_to_outcomes(rows: List[Dict[str, str]]) -> List[SignalOutcome]:
    outcomes = []
    for row in rows:
        try:
            outcomes.append(SignalOutcome(
                signal_id=int(row["signal_id"]),
                symbol=row["symbol"],
                timeframe=row["timeframe"],
                direction=row["direction"],
                confidence=int(row["confidence"]),
                created_at=int(row["created_at"]),
                entry_price=0.0,  # not used in aggregation
                outcome_type=row["outcome_type"],
                realized_pnl_pct=float(row["realized_pnl_pct"]),
                tp1_hit_ts=int(row["tp1_hit_ts"]) if row.get("tp1_hit_ts") else None,
                tp2_hit_ts=int(row["tp2_hit_ts"]) if row.get("tp2_hit_ts") else None,
                sl_hit_ts=int(row["sl_hit_ts"]) if row.get("sl_hit_ts") else None,
                exit_ts=int(row["exit_ts"]) if row.get("exit_ts") else None,
                candles_to_exit=int(row["candles_to_exit"]),
                same_bar_tp1_sl_tie=(row.get("same_bar_tp1_sl_tie") in ("True", "true", "1")),
                coverage_warning=(row.get("coverage_warning") in ("True", "true", "1")),
            ))
        except (ValueError, KeyError) as e:
            sys.stderr.write(f"[rows_to_outcomes] skipping malformed row: {e}\n")
    return outcomes


def aggregate_16_cells(outcomes: List[SignalOutcome], variant_ids: List[str]) -> Dict[Tuple[str, str, str], Dict]:
    cells: Dict[Tuple[str, str, str], Dict] = {}
    for tf in ("5m", "15m"):
        for vid in variant_ids:
            outs = [o for o in outcomes if o.timeframe == tf]
            # This will be filtered by variant_id at the call site — we get
            # already-filtered outcomes per variant here.
            for gate in ("all", "conf70"):
                if gate == "conf70":
                    outs_g = [o for o in outs if o.confidence >= 70]
                else:
                    outs_g = outs
                cells[(tf, vid, gate)] = aggregate_cell(outs_g)
    return cells


def aggregate_by_variant(
    outcomes_by_variant: Dict[str, List[SignalOutcome]],
) -> Dict[Tuple[str, str, str], Dict]:
    cells: Dict[Tuple[str, str, str], Dict] = {}
    for vid, outs in outcomes_by_variant.items():
        for tf in ("5m", "15m"):
            outs_tf = [o for o in outs if o.timeframe == tf]
            for gate in ("all", "conf70"):
                if gate == "conf70":
                    outs_g = [o for o in outs_tf if o.confidence >= 70]
                else:
                    outs_g = outs_tf
                cells[(tf, vid, gate)] = aggregate_cell(outs_g)
    return cells


# ----------------------------------------------------------------------
# Orchestration
# ----------------------------------------------------------------------
def run(args) -> int:
    os.makedirs(args.out_dir, exist_ok=True)
    os.makedirs(args.xyz_cache_dir, exist_ok=True)

    print("[1/7] resolving T1+T2 universe (OI across both dexes)")
    t1_t2, dex_of, top_assets = resolve_t1_t2(args.top_n)
    print(f"       top {args.top_n} union + T1 = {len(t1_t2)} symbols")
    ts = datetime.now(tz=timezone.utc).strftime("%Y%m%d_%H%M")
    universe_snap = {
        "timestamp": datetime.now(tz=timezone.utc).isoformat(),
        "top_n": args.top_n,
        "t1": ["BTC", "ETH"],
        "t2_ranked": [{"coin": a["coin"], "dex": a["dex"],
                       "notional_oi_usd": round(a["notional_oi"], 2),
                       "open_interest": a["open_interest"],
                       "mark_px": a["mark_px"]} for a in top_assets],
        "t1_t2_symbols": sorted(list(t1_t2)),
        "dex_of": dex_of,
        "source": "hyperliquid.xyz/info metaAndAssetCtxs (standard + xyz)",
    }
    universe_path = os.path.join(args.out_dir, f"t1_t2_universe_{ts}.json")
    with open(universe_path, "w") as fh:
        json.dump(universe_snap, fh, indent=2)
    print(f"       snapshot → {universe_path}")
    for a in top_assets[:20]:
        print(f"       {a['coin']:>10} ({a['dex']:>8}) ${a['notional_oi']/1e6:.1f}M")

    print("[2/7] loading v2 rows + identifying xyz re-fetch list")
    v2_rows = load_v2_rows(args.v2_rows_csv)
    print(f"       loaded {len(v2_rows)} v2 rows")
    refetch_list = identify_xyz_refetch(v2_rows, t1_t2, dex_of)
    distinct_symbols = sorted({r["symbol"] for r in refetch_list})
    print(f"       xyz re-fetch: {len(refetch_list)} distinct signals across "
          f"{len(distinct_symbols)} symbols: {distinct_symbols}")
    refetch_meta_path = os.path.join(args.out_dir, "xyz_refetch_list.json")
    with open(refetch_meta_path, "w") as fh:
        json.dump({"n_signals": len(refetch_list),
                   "symbols": distinct_symbols,
                   "sample": refetch_list[:5]}, fh, indent=2)

    print("[3/7] re-fetching xyz candles + replaying")
    signals_map = load_signals_map(args.signals_csv)
    xyz_rows_csv = os.path.join(args.out_dir, "xyz_rows.csv")
    rows_written, coverage_warnings = replay_xyz_signals(
        refetch_list, signals_map, args.xyz_cache_dir, xyz_rows_csv,
    )
    print(f"       wrote {rows_written} xyz variant-rows → {xyz_rows_csv}")
    print(f"       coverage warnings: {len(coverage_warnings)} (coin_day)")

    print("[4/7] merging xyz rows over v2 NO_DATA stubs")
    combined_csv = os.path.join(args.out_dir, "combined_rows.csv")
    merge_stats = merge_rows(args.v2_rows_csv, xyz_rows_csv, combined_csv)
    print(f"       replaced {merge_stats['n_replaced']} NO_DATA stubs; "
          f"preserved {merge_stats['n_preserved']} other rows")
    print(f"       v2 CSV SHA unchanged: {merge_stats['v2_sha'][:16]}")

    print("[5/7] filtering combined to T1+T2 non-NO_DATA non-coverage")
    filtered_csv = os.path.join(args.out_dir, "t1t2_rows.csv")
    retained = filter_combined(combined_csv, t1_t2, filtered_csv)
    print(f"       retained {retained} rows in filtered CSV")

    print("[6/7] aggregating 16 cells on T1+T2 subset")
    filtered_rows = load_v2_rows(filtered_csv)
    outcomes_by_variant: Dict[str, List[SignalOutcome]] = {"V0": [], "V1": [], "V2": [], "V3": []}
    for row in filtered_rows:
        vid = row["variant_id"]
        if vid not in outcomes_by_variant:
            continue
        outcomes_by_variant[vid].extend(rows_to_outcomes([row]))
    cells = aggregate_by_variant(outcomes_by_variant)

    ranked = rank_cells(cells)
    print("       Top 5 cells by net × √n_valid:")
    for key, score, stats in ranked[:5]:
        if stats.get("n_valid", 0) == 0:
            continue
        tf, vid, gate = key
        print(f"         {tf:>3} {vid} {gate:>6} n={stats['n_valid']:>4} "
              f"WR={stats['outcome_wr_pct']:>5.2f}% net={stats['net_avg_pnl_pct']:>+7.4f}% "
              f"score={score:>+7.4f}")

    print("[7/7] loading v2 full-cohort summary for delta")
    with open(args.v2_summary_json) as fh:
        v2_summary = json.load(fh)
    v2_cells = v2_summary.get("cells", {})

    delta_rows = []
    for key, stats in cells.items():
        v2_key = f"{key[0]}|{key[1]}|{key[2]}"
        v2 = v2_cells.get(v2_key, {})
        if stats.get("n_valid", 0) == 0 or v2.get("n_valid", 0) == 0:
            delta_rows.append({
                "tf": key[0], "variant": key[1], "gate": key[2],
                "t1t2_n": stats.get("n_valid", 0),
                "full_cohort_n": v2.get("n_valid", 0),
                "t1t2_net_pct": stats.get("net_avg_pnl_pct"),
                "full_cohort_net_pct": v2.get("net_avg_pnl_pct"),
                "delta_net_pp": None,
                "n_ratio": None,
            })
            continue
        delta_net = stats["net_avg_pnl_pct"] - v2["net_avg_pnl_pct"]
        n_ratio = stats["n_valid"] / v2["n_valid"]
        delta_rows.append({
            "tf": key[0], "variant": key[1], "gate": key[2],
            "t1t2_n": stats["n_valid"],
            "full_cohort_n": v2["n_valid"],
            "t1t2_net_pct": round(stats["net_avg_pnl_pct"], 4),
            "full_cohort_net_pct": round(v2["net_avg_pnl_pct"], 4),
            "delta_net_pp": round(delta_net, 4),
            "n_ratio": round(n_ratio, 3),
        })

    # Verdict
    positive = [r for r in ranked if r[1] > 0 and r[2].get("n_valid", 0) >= 50]
    verdict = {"state": "FAIL", "winner": None, "runner_up": None}
    if positive:
        top = positive[0]
        verdict["winner"] = {
            "tf": top[0][0], "variant": top[0][1], "gate": top[0][2],
            "n_valid": top[2]["n_valid"],
            "net_avg_pnl_pct": top[2]["net_avg_pnl_pct"],
            "score": top[1],
        }
        if len(positive) > 1:
            second = positive[1]
            ratio = top[1] / second[1] if second[1] > 0 else float("inf")
            verdict["runner_up"] = {
                "tf": second[0][0], "variant": second[0][1], "gate": second[0][2],
                "n_valid": second[2]["n_valid"],
                "net_avg_pnl_pct": second[2]["net_avg_pnl_pct"],
                "score": second[1],
                "ratio_winner_over": round(ratio, 3),
            }
            verdict["state"] = "CLEAR" if ratio >= 2.0 else "MARGINAL"
        else:
            verdict["state"] = "CLEAR"

    underpowered = [
        {"tf": k[0], "variant": k[1], "gate": k[2], "n_valid": stats.get("n_valid", 0)}
        for k, stats in cells.items()
        if 0 < stats.get("n_valid", 0) < 50
    ]

    summary = {
        "universe_snapshot_path": universe_path,
        "refetch": {
            "n_signals": len(refetch_list),
            "distinct_symbols": distinct_symbols,
            "n_rows_written": rows_written,
            "coverage_warnings": coverage_warnings,
        },
        "merge": merge_stats,
        "filter_retained": retained,
        "cells": {f"{k[0]}|{k[1]}|{k[2]}": v for k, v in cells.items()},
        "ranking": [
            {"tf": k[0], "variant": k[1], "gate": k[2],
             "score": round(s, 4),
             "n_valid": stats.get("n_valid", 0),
             "net_avg_pnl_pct": stats.get("net_avg_pnl_pct"),
             "outcome_wr_pct": stats.get("outcome_wr_pct")}
            for (k, s, stats) in ranked
        ],
        "delta_vs_v2_full_cohort": delta_rows,
        "underpowered_cells_n_lt_50": underpowered,
        "verdict": verdict,
        "t1_t2": sorted(list(t1_t2)),
        "dex_of": dex_of,
    }
    summary_path = os.path.join(args.out_dir, "summary.json")
    with open(summary_path, "w") as fh:
        json.dump(summary, fh, indent=2, default=str)
    print(f"       wrote summary → {summary_path}")

    return 0


def main():
    ap = argparse.ArgumentParser(description="Mode A v2 re-aggregation filtered to T1+T2")
    ap.add_argument("--v2-rows-csv", default="/tmp/mode_a_laptop_v2/rows.csv")
    ap.add_argument("--v2-summary-json", default="/tmp/mode_a_laptop_v2/summary.json")
    ap.add_argument("--signals-csv", default="/tmp/mode_a_laptop/signals.csv")
    ap.add_argument("--out-dir", default="/tmp/mode_a_t1t2")
    ap.add_argument("--xyz-cache-dir", default="/tmp/hl_candles_xyz")
    ap.add_argument("--top-n", type=int, default=20)
    args = ap.parse_args()
    sys.exit(run(args))


if __name__ == "__main__":
    main()
