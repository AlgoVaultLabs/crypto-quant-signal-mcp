#!/usr/bin/env python3
"""Unit tests for the T1+T2 re-aggregation script.

Three fixtures minimum per spec:
  1. OI-union fixture: mock standard + xyz assets → top-N union includes both
  2. Merge fixture: v2 rows + xyz re-fetch rows → combined replaces NO_DATA stubs
  3. Filter fixture: T1/T2/T3 rows → T1+T2 (both dexes) retained, T3 dropped

Run from repo root:
    python3 -m unittest scripts.tests.test_reaggregate_t1t2
"""
from __future__ import annotations

import csv
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from reaggregate_mode_a_t1t2 import (  # noqa: E402
    _parse_meta_ctx,
    identify_xyz_refetch,
    merge_rows,
    filter_combined,
    resolve_t1_t2,
)


class OIResolutionTests(unittest.TestCase):

    def test_parse_meta_ctx_strips_xyz_prefix(self):
        raw = [
            {"universe": [{"name": "xyz:GOLD"}, {"name": "xyz:SP500"}]},
            [
                {"openInterest": "100.0", "markPx": "2000.0"},  # 200k
                {"openInterest": "10.0", "markPx": "5000.0"},   # 50k
            ],
        ]
        parsed = _parse_meta_ctx(raw, "xyz")
        coins = [a["coin"] for a in parsed]
        self.assertIn("GOLD", coins)
        self.assertIn("SP500", coins)
        for a in parsed:
            self.assertFalse(a["coin"].startswith("xyz:"))
            self.assertEqual(a["dex"], "xyz")

    def test_parse_meta_ctx_standard_keeps_bare_name(self):
        raw = [
            {"universe": [{"name": "BTC"}, {"name": "ETH"}]},
            [
                {"openInterest": "1000.0", "markPx": "70000.0"},
                {"openInterest": "500.0", "markPx": "3500.0"},
            ],
        ]
        parsed = _parse_meta_ctx(raw, "standard")
        self.assertEqual(parsed[0]["coin"], "BTC")
        self.assertEqual(parsed[0]["dex"], "standard")
        self.assertAlmostEqual(parsed[0]["notional_oi"], 70_000_000.0, places=2)

    def test_oi_union_includes_both_dexes(self):
        """Static emulation — no network. Monkey-patch fetch_oi_both_dexes."""
        from reaggregate_mode_a_t1t2 import fetch_oi_both_dexes as real_fetch  # noqa: F401
        import reaggregate_mode_a_t1t2 as mod

        def _mock_fetch():
            return [
                {"coin": "BTC",   "dex": "standard", "notional_oi": 2000e6, "open_interest": 1, "mark_px": 1},
                {"coin": "ETH",   "dex": "standard", "notional_oi": 900e6,  "open_interest": 1, "mark_px": 1},
                {"coin": "HYPE",  "dex": "standard", "notional_oi": 700e6,  "open_interest": 1, "mark_px": 1},
                {"coin": "SP500", "dex": "xyz",      "notional_oi": 450e6,  "open_interest": 1, "mark_px": 1},
                {"coin": "SOL",   "dex": "standard", "notional_oi": 300e6,  "open_interest": 1, "mark_px": 1},
                {"coin": "GOLD",  "dex": "xyz",      "notional_oi": 150e6,  "open_interest": 1, "mark_px": 1},
                {"coin": "XRP",   "dex": "standard", "notional_oi": 100e6,  "open_interest": 1, "mark_px": 1},
            ]

        orig = mod.fetch_oi_both_dexes
        mod.fetch_oi_both_dexes = _mock_fetch
        try:
            t1_t2, dex_of, top = mod.resolve_t1_t2(top_n=5)
            self.assertEqual(top[0]["coin"], "BTC")
            self.assertEqual(top[3]["coin"], "SP500")
            self.assertEqual(dex_of["BTC"], "standard")
            self.assertEqual(dex_of["SP500"], "xyz")
            # top_n=5 → only HYPE, BTC, ETH, SP500, SOL make the union + T1.
            # GOLD (6th by OI) is outside the top 5 and NOT in t1_t2.
            self.assertNotIn("GOLD", t1_t2)
            self.assertIn("BTC", t1_t2)
            self.assertIn("ETH", t1_t2)
            self.assertIn("SP500", t1_t2)
            self.assertIn("SOL", t1_t2)
        finally:
            mod.fetch_oi_both_dexes = orig


class MergeFixtureTests(unittest.TestCase):

    def test_merge_replaces_no_data_stubs(self):
        """v2 has 3 rows: 1 non-NO_DATA (BTC), 1 NO_DATA (xyz GOLD), 1 NO_DATA
        (xyz GOLD different variant). xyz re-fetch has 2 rows for GOLD. After
        merge, combined CSV has 3 rows; the 2 GOLD rows replaced by xyz
        outcomes, BTC untouched."""
        with tempfile.TemporaryDirectory() as tmp:
            v2_csv = os.path.join(tmp, "v2.csv")
            xyz_csv = os.path.join(tmp, "xyz.csv")
            combined = os.path.join(tmp, "combined.csv")

            fields = [
                "signal_id", "variant_id", "timeframe", "direction", "confidence",
                "symbol", "created_at", "outcome_type", "realized_pnl_pct",
                "tp1_hit_ts", "tp2_hit_ts", "sl_hit_ts", "trail_exit_ts", "exit_ts",
                "candles_to_exit", "same_bar_tp1_sl_tie", "coverage_warning",
            ]
            with open(v2_csv, "w", newline="") as fh:
                w = csv.DictWriter(fh, fieldnames=fields)
                w.writeheader()
                w.writerow({**{f: "" for f in fields}, "signal_id": "1", "variant_id": "V0",
                            "timeframe": "15m", "direction": "BUY", "confidence": "75",
                            "symbol": "BTC", "created_at": "1776000000",
                            "outcome_type": "TP1_TP2", "realized_pnl_pct": "0.00500000",
                            "candles_to_exit": "3", "same_bar_tp1_sl_tie": "False",
                            "coverage_warning": "False"})
                w.writerow({**{f: "" for f in fields}, "signal_id": "2", "variant_id": "V0",
                            "timeframe": "15m", "direction": "SELL", "confidence": "72",
                            "symbol": "GOLD", "created_at": "1776100000",
                            "outcome_type": "NO_DATA", "realized_pnl_pct": "0.00000000",
                            "candles_to_exit": "0", "same_bar_tp1_sl_tie": "False",
                            "coverage_warning": "True"})
                w.writerow({**{f: "" for f in fields}, "signal_id": "2", "variant_id": "V1",
                            "timeframe": "15m", "direction": "SELL", "confidence": "72",
                            "symbol": "GOLD", "created_at": "1776100000",
                            "outcome_type": "NO_DATA", "realized_pnl_pct": "0.00000000",
                            "candles_to_exit": "0", "same_bar_tp1_sl_tie": "False",
                            "coverage_warning": "True"})

            with open(xyz_csv, "w", newline="") as fh:
                w = csv.DictWriter(fh, fieldnames=fields)
                w.writeheader()
                w.writerow({**{f: "" for f in fields}, "signal_id": "2", "variant_id": "V0",
                            "timeframe": "15m", "direction": "SELL", "confidence": "72",
                            "symbol": "GOLD", "created_at": "1776100000",
                            "outcome_type": "SL", "realized_pnl_pct": "-0.01140000",
                            "candles_to_exit": "2", "same_bar_tp1_sl_tie": "False",
                            "coverage_warning": "False"})
                w.writerow({**{f: "" for f in fields}, "signal_id": "2", "variant_id": "V1",
                            "timeframe": "15m", "direction": "SELL", "confidence": "72",
                            "symbol": "GOLD", "created_at": "1776100000",
                            "outcome_type": "TP1_TP2", "realized_pnl_pct": "0.01300000",
                            "candles_to_exit": "4", "same_bar_tp1_sl_tie": "False",
                            "coverage_warning": "False"})

            stats = merge_rows(v2_csv, xyz_csv, combined)
            self.assertEqual(stats["n_replaced"], 2)
            self.assertEqual(stats["n_preserved"], 1)

            with open(combined) as fh:
                rows = list(csv.DictReader(fh))
            self.assertEqual(len(rows), 3)
            # BTC untouched
            btc = [r for r in rows if r["symbol"] == "BTC"][0]
            self.assertEqual(btc["outcome_type"], "TP1_TP2")
            # GOLD V0 now SL
            gold_v0 = [r for r in rows if r["symbol"] == "GOLD" and r["variant_id"] == "V0"][0]
            self.assertEqual(gold_v0["outcome_type"], "SL")
            self.assertAlmostEqual(float(gold_v0["realized_pnl_pct"]), -0.0114, places=6)
            # GOLD V1 now TP1_TP2
            gold_v1 = [r for r in rows if r["symbol"] == "GOLD" and r["variant_id"] == "V1"][0]
            self.assertEqual(gold_v1["outcome_type"], "TP1_TP2")

    def test_merge_preserves_real_outcomes_even_when_xyz_row_exists(self):
        """If v2 already has a real outcome (not NO_DATA), the merge MUST NOT
        overwrite it — even if the xyz re-fetch happens to have a row for the
        same (signal_id, variant_id)."""
        with tempfile.TemporaryDirectory() as tmp:
            v2_csv = os.path.join(tmp, "v2.csv")
            xyz_csv = os.path.join(tmp, "xyz.csv")
            combined = os.path.join(tmp, "combined.csv")
            fields = [
                "signal_id", "variant_id", "timeframe", "direction", "confidence",
                "symbol", "created_at", "outcome_type", "realized_pnl_pct",
                "tp1_hit_ts", "tp2_hit_ts", "sl_hit_ts", "trail_exit_ts", "exit_ts",
                "candles_to_exit", "same_bar_tp1_sl_tie", "coverage_warning",
            ]
            with open(v2_csv, "w", newline="") as fh:
                w = csv.DictWriter(fh, fieldnames=fields)
                w.writeheader()
                w.writerow({**{f: "" for f in fields}, "signal_id": "5", "variant_id": "V0",
                            "timeframe": "5m", "direction": "BUY", "confidence": "60",
                            "symbol": "BTC", "created_at": "1776200000",
                            "outcome_type": "TP1_BE", "realized_pnl_pct": "0.00195",
                            "candles_to_exit": "5", "same_bar_tp1_sl_tie": "False",
                            "coverage_warning": "False"})
            with open(xyz_csv, "w", newline="") as fh:
                w = csv.DictWriter(fh, fieldnames=fields)
                w.writeheader()
                w.writerow({**{f: "" for f in fields}, "signal_id": "5", "variant_id": "V0",
                            "timeframe": "5m", "direction": "BUY", "confidence": "60",
                            "symbol": "BTC", "created_at": "1776200000",
                            "outcome_type": "SL", "realized_pnl_pct": "-0.00730",
                            "candles_to_exit": "1", "same_bar_tp1_sl_tie": "False",
                            "coverage_warning": "False"})
            stats = merge_rows(v2_csv, xyz_csv, combined)
            self.assertEqual(stats["n_replaced"], 0)
            self.assertEqual(stats["n_preserved"], 1)
            with open(combined) as fh:
                row = next(csv.DictReader(fh))
            self.assertEqual(row["outcome_type"], "TP1_BE")


class FilterFixtureTests(unittest.TestCase):

    def test_filter_retains_t1_t2_both_dexes_drops_t3(self):
        """Input: T1 BTC, T2 standard SOL, T2 xyz SP500, T3 ZEC, T3 AAPL.
        Filter should keep BTC, SOL, SP500; drop ZEC, AAPL."""
        with tempfile.TemporaryDirectory() as tmp:
            combined = os.path.join(tmp, "combined.csv")
            filtered = os.path.join(tmp, "filtered.csv")
            fields = [
                "signal_id", "variant_id", "timeframe", "direction", "confidence",
                "symbol", "created_at", "outcome_type", "realized_pnl_pct",
                "tp1_hit_ts", "tp2_hit_ts", "sl_hit_ts", "trail_exit_ts", "exit_ts",
                "candles_to_exit", "same_bar_tp1_sl_tie", "coverage_warning",
            ]
            syms = ["BTC", "SOL", "SP500", "ZEC", "AAPL"]
            with open(combined, "w", newline="") as fh:
                w = csv.DictWriter(fh, fieldnames=fields)
                w.writeheader()
                for i, s in enumerate(syms):
                    w.writerow({**{f: "" for f in fields}, "signal_id": str(i),
                                "variant_id": "V0", "timeframe": "15m",
                                "direction": "BUY", "confidence": "70",
                                "symbol": s, "created_at": "1776200000",
                                "outcome_type": "TP1_TP2",
                                "realized_pnl_pct": "0.01",
                                "candles_to_exit": "3",
                                "same_bar_tp1_sl_tie": "False",
                                "coverage_warning": "False"})

            t1_t2 = {"BTC", "ETH", "SOL", "SP500", "HYPE"}
            retained = filter_combined(combined, t1_t2, filtered)
            self.assertEqual(retained, 3)

            with open(filtered) as fh:
                rows = list(csv.DictReader(fh))
            kept = {r["symbol"] for r in rows}
            self.assertEqual(kept, {"BTC", "SOL", "SP500"})

    def test_filter_drops_coverage_warning_and_no_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            combined = os.path.join(tmp, "combined.csv")
            filtered = os.path.join(tmp, "filtered.csv")
            fields = [
                "signal_id", "variant_id", "timeframe", "direction", "confidence",
                "symbol", "created_at", "outcome_type", "realized_pnl_pct",
                "tp1_hit_ts", "tp2_hit_ts", "sl_hit_ts", "trail_exit_ts", "exit_ts",
                "candles_to_exit", "same_bar_tp1_sl_tie", "coverage_warning",
            ]
            with open(combined, "w", newline="") as fh:
                w = csv.DictWriter(fh, fieldnames=fields)
                w.writeheader()
                # Real BTC row — kept
                w.writerow({**{f: "" for f in fields}, "signal_id": "1", "variant_id": "V0",
                            "timeframe": "5m", "direction": "BUY", "confidence": "70",
                            "symbol": "BTC", "outcome_type": "TP1_TP2",
                            "realized_pnl_pct": "0.01", "candles_to_exit": "3",
                            "same_bar_tp1_sl_tie": "False", "coverage_warning": "False"})
                # NO_DATA — dropped
                w.writerow({**{f: "" for f in fields}, "signal_id": "2", "variant_id": "V0",
                            "timeframe": "5m", "direction": "BUY", "confidence": "70",
                            "symbol": "BTC", "outcome_type": "NO_DATA",
                            "realized_pnl_pct": "0.0", "candles_to_exit": "0",
                            "same_bar_tp1_sl_tie": "False", "coverage_warning": "True"})
                # coverage_warning=True — dropped
                w.writerow({**{f: "" for f in fields}, "signal_id": "3", "variant_id": "V0",
                            "timeframe": "5m", "direction": "BUY", "confidence": "70",
                            "symbol": "BTC", "outcome_type": "TP1_TP2",
                            "realized_pnl_pct": "0.005", "candles_to_exit": "3",
                            "same_bar_tp1_sl_tie": "False", "coverage_warning": "True"})
            retained = filter_combined(combined, {"BTC"}, filtered)
            self.assertEqual(retained, 1)


class IdentifyRefetchTests(unittest.TestCase):

    def test_identify_xyz_refetch_finds_only_t1t2_xyz_no_data(self):
        v2_rows = [
            # T1 BTC (standard) — skip
            {"signal_id": "1", "variant_id": "V0", "symbol": "BTC",
             "direction": "BUY", "confidence": "70", "created_at": "1776000000",
             "timeframe": "15m", "outcome_type": "TP1_TP2",
             "realized_pnl_pct": "0.01", "coverage_warning": "False"},
            # T2 standard SOL NO_DATA — skip (not xyz)
            {"signal_id": "2", "variant_id": "V0", "symbol": "SOL",
             "direction": "BUY", "confidence": "60", "created_at": "1776100000",
             "timeframe": "5m", "outcome_type": "NO_DATA",
             "realized_pnl_pct": "0.0", "coverage_warning": "True"},
            # T2 xyz SP500 NO_DATA — include
            {"signal_id": "3", "variant_id": "V0", "symbol": "SP500",
             "direction": "SELL", "confidence": "75", "created_at": "1776200000",
             "timeframe": "15m", "outcome_type": "NO_DATA",
             "realized_pnl_pct": "0.0", "coverage_warning": "True"},
            # Same signal 3, variant V1, also NO_DATA — already represented
            {"signal_id": "3", "variant_id": "V1", "symbol": "SP500",
             "direction": "SELL", "confidence": "75", "created_at": "1776200000",
             "timeframe": "15m", "outcome_type": "NO_DATA",
             "realized_pnl_pct": "0.0", "coverage_warning": "True"},
            # T3 AAPL xyz NO_DATA — skip (not in T1+T2)
            {"signal_id": "4", "variant_id": "V0", "symbol": "AAPL",
             "direction": "BUY", "confidence": "65", "created_at": "1776300000",
             "timeframe": "5m", "outcome_type": "NO_DATA",
             "realized_pnl_pct": "0.0", "coverage_warning": "True"},
        ]
        t1_t2 = {"BTC", "ETH", "SOL", "SP500"}
        dex_of = {"BTC": "standard", "ETH": "standard", "SOL": "standard",
                  "SP500": "xyz"}
        refetch = identify_xyz_refetch(v2_rows, t1_t2, dex_of)
        self.assertEqual(len(refetch), 1)
        self.assertEqual(refetch[0]["symbol"], "SP500")
        self.assertEqual(refetch[0]["signal_id"], 3)


if __name__ == "__main__":
    unittest.main()
