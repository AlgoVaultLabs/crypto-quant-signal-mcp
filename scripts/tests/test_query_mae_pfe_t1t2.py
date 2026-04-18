#!/usr/bin/env python3
"""Unit tests for the T1+T2 MAE/PFE re-derivation script.

Minimum 4 fixtures per spec:
  1. SQL-grep guard trips on forbidden mutation keywords
  2. dex classification (4 fixtures covering T1, T2 standard, T2 xyz, unknown)
  3. T1+T2 universe snapshot structure
  4. Sample-size flag logic

Run from repo root:
    python3 -m unittest scripts.tests.test_query_mae_pfe_t1t2
"""
from __future__ import annotations

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from query_mae_pfe_t1t2 import (  # noqa: E402
    sql_guard,
    sql_in_list,
    classify_dex,
    sample_size_flags,
    derive_three_recipes,
    build_delta_rows,
    SLOT_CAPS,
    V2_FULL_COHORT,
)


class SqlGuardTests(unittest.TestCase):
    """Any mutation keyword must trip the guard."""

    def test_forbids_insert(self):
        with self.assertRaisesRegex(RuntimeError, "SQL guard tripped"):
            sql_guard("INSERT INTO signals VALUES (...)")

    def test_forbids_update(self):
        with self.assertRaisesRegex(RuntimeError, "SQL guard tripped"):
            sql_guard("UPDATE signals SET confidence = 99")

    def test_forbids_delete(self):
        with self.assertRaisesRegex(RuntimeError, "SQL guard tripped"):
            sql_guard("DELETE FROM signals WHERE id = 1")

    def test_forbids_drop(self):
        with self.assertRaisesRegex(RuntimeError, "SQL guard tripped"):
            sql_guard("SELECT 1; DROP TABLE signals;")

    def test_forbids_truncate(self):
        with self.assertRaisesRegex(RuntimeError, "SQL guard tripped"):
            sql_guard("TRUNCATE signals")

    def test_forbids_alter(self):
        with self.assertRaisesRegex(RuntimeError, "SQL guard tripped"):
            sql_guard("ALTER TABLE signals ADD COLUMN foo INT")

    def test_forbids_create(self):
        with self.assertRaisesRegex(RuntimeError, "SQL guard tripped"):
            sql_guard("CREATE TABLE evil AS SELECT * FROM signals")

    def test_forbids_copy_from(self):
        with self.assertRaisesRegex(RuntimeError, "SQL guard tripped"):
            sql_guard("COPY signals FROM '/tmp/evil.csv'")

    def test_allows_select_only(self):
        try:
            sql_guard("SELECT COUNT(*) FROM signals WHERE exchange='HL'")
        except RuntimeError:
            self.fail("SELECT should be allowed")

    def test_allows_with_cte(self):
        try:
            sql_guard("WITH winners AS (SELECT * FROM signals) SELECT * FROM winners")
        except RuntimeError:
            self.fail("WITH ... SELECT should be allowed")

    def test_allows_copy_to_stdout(self):
        """COPY (SELECT ...) TO STDOUT is allowed — it reads, doesn't write."""
        try:
            sql_guard("COPY (SELECT * FROM signals) TO STDOUT WITH CSV HEADER")
        except RuntimeError:
            self.fail("COPY TO STDOUT should be allowed (read-only)")


class SqlInListTests(unittest.TestCase):
    """The symbol IN-list builder must reject anything outside [A-Za-z0-9_]."""

    def test_builds_quoted_list(self):
        out = sql_in_list({"BTC", "ETH", "SP500"})
        self.assertEqual(out, "('BTC', 'ETH', 'SP500')")

    def test_rejects_injection_attempt(self):
        with self.assertRaisesRegex(RuntimeError, "unsafe symbol"):
            sql_in_list({"BTC", "ETH'; DROP TABLE signals; --"})

    def test_rejects_semicolon(self):
        with self.assertRaisesRegex(RuntimeError, "unsafe symbol"):
            sql_in_list({"BTC;"})

    def test_rejects_space(self):
        with self.assertRaisesRegex(RuntimeError, "unsafe symbol"):
            sql_in_list({"BT C"})


class DexClassificationTests(unittest.TestCase):
    """classify_dex must handle T1, T2 standard, T2 xyz, and unknown."""

    def setUp(self):
        self.dex_of = {
            "BTC": "standard",
            "ETH": "standard",
            "HYPE": "standard",
            "SOL": "standard",
            "SP500": "xyz",
            "GOLD": "xyz",
            "CL": "xyz",
        }

    def test_t1_btc(self):
        self.assertEqual(classify_dex("BTC", self.dex_of), "standard")

    def test_t1_eth(self):
        self.assertEqual(classify_dex("ETH", self.dex_of), "standard")

    def test_t2_standard_hype(self):
        self.assertEqual(classify_dex("HYPE", self.dex_of), "standard")

    def test_t2_xyz_sp500(self):
        self.assertEqual(classify_dex("SP500", self.dex_of), "xyz")

    def test_t2_xyz_gold(self):
        self.assertEqual(classify_dex("GOLD", self.dex_of), "xyz")

    def test_unknown_defaults_standard(self):
        """Unknown coin defaults to 'standard' (classify_dex is only safe for
        T1+T2 symbols; callers are expected to filter to T1+T2 upstream)."""
        self.assertEqual(classify_dex("AAPL", self.dex_of), "standard")


class SampleSizeFlagTests(unittest.TestCase):
    """sample_size_flags correctly identifies underpowered buckets."""

    def test_winners_below_floor_flagged(self):
        winners = [
            {"timeframe": "15m", "signal": "BUY", "n": "50"},   # below 100
            {"timeframe": "15m", "signal": "SELL", "n": "250"}, # above
            {"timeframe": "1h", "signal": "BUY", "n": "15"},    # below
        ]
        losers = []
        flags = sample_size_flags(winners, losers)
        self.assertEqual(len(flags), 2)
        buckets = {(f["timeframe"], f["signal"], f["category"]) for f in flags}
        self.assertIn(("15m", "BUY", "winners"), buckets)
        self.assertIn(("1h", "BUY", "winners"), buckets)
        self.assertNotIn(("15m", "SELL", "winners"), buckets)

    def test_losers_below_floor_flagged(self):
        winners = []
        losers = [
            {"timeframe": "5m", "signal": "BUY", "n": "200"},   # above 50
            {"timeframe": "1h", "signal": "SELL", "n": "10"},   # below
        ]
        flags = sample_size_flags(winners, losers)
        self.assertEqual(len(flags), 1)
        self.assertEqual(flags[0]["category"], "losers")
        self.assertEqual(flags[0]["timeframe"], "1h")

    def test_no_flags_when_all_above_floor(self):
        winners = [{"timeframe": "15m", "signal": "BUY", "n": "500"}]
        losers = [{"timeframe": "15m", "signal": "BUY", "n": "200"}]
        self.assertEqual(sample_size_flags(winners, losers), [])

    def test_custom_floors(self):
        winners = [{"timeframe": "15m", "signal": "BUY", "n": "50"}]
        # With a lower floor, no flag
        self.assertEqual(sample_size_flags(winners, [], min_winners=30), [])
        # With a higher floor, flagged
        self.assertEqual(len(sample_size_flags(winners, [], min_winners=75)), 1)


class RecipeDerivationTests(unittest.TestCase):
    """derive_three_recipes produces the correct LANE_RECIPES structure."""

    def test_derives_all_three_variants(self):
        strat = {}
        for variant in ("combined", "standard", "xyz"):
            strat[variant] = {
                "combined_winners": [
                    {"timeframe": "5m", "n": "800",
                     "pfe_p50": "0.3000", "pfe_p60": "0.4000",
                     "pfe_p75": "0.6000", "pfe_p80": "0.8000",
                     "pfe_p90": "1.2000", "mae_p80": "0.5000",
                     "avg_pfe_candles": "6.0", "p90_pfe_candles": "12.0"},
                    {"timeframe": "15m", "n": "400",
                     "pfe_p50": "0.5000", "pfe_p60": "0.7000",
                     "pfe_p75": "1.0000", "pfe_p80": "1.2000",
                     "pfe_p90": "2.0000", "mae_p80": "0.9000",
                     "avg_pfe_candles": "7.0", "p90_pfe_candles": "12.0"},
                ],
                "all_sig_mae": [
                    {"timeframe": "5m", "n_all": "1000",
                     "mae_p75_all": "0.5000", "mae_p80_all": "0.7000",
                     "mae_p90_all": "1.2000"},
                    {"timeframe": "15m", "n_all": "500",
                     "mae_p75_all": "0.9000", "mae_p80_all": "1.1000",
                     "mae_p90_all": "2.0000"},
                ],
            }
        recipes = derive_three_recipes(strat)
        for variant in ("combined", "standard", "xyz"):
            for tf in ("5m", "15m"):
                r = recipes[variant][tf]
                self.assertIsNotNone(r)
                self.assertEqual(r["timeframe"], tf)
                self.assertEqual(r["slotCap"], SLOT_CAPS[tf])
                self.assertAlmostEqual(r["tp1Fraction"], 0.5)
                self.assertTrue(r["moveSlToBeAfterTp1"])
                self.assertEqual(r["minConfidence"], 70)
                self.assertEqual(r["leverage"], 2)
        # Verify values on combined 5m: tp1 = pfe_p60 = 0.4% → 0.004, etc.
        r = recipes["combined"]["5m"]
        self.assertAlmostEqual(r["tp1Pct"], 0.004, places=6)
        self.assertAlmostEqual(r["tp2Pct"], 0.008, places=6)
        self.assertAlmostEqual(r["tp2Pct_wide"], 0.012, places=6)
        self.assertAlmostEqual(r["stopLossPct"], 0.007, places=6)
        self.assertEqual(r["maxHoldCandles"], 12)

    def test_missing_timeframe_returns_none(self):
        strat = {
            "combined": {
                "combined_winners": [],
                "all_sig_mae": [],
            },
            "standard": {"combined_winners": [], "all_sig_mae": []},
            "xyz": {"combined_winners": [], "all_sig_mae": []},
        }
        recipes = derive_three_recipes(strat)
        self.assertIsNone(recipes["combined"]["5m"])


class DeltaTableTests(unittest.TestCase):
    """build_delta_rows produces a row per (timeframe, metric) with delta cols."""

    def test_delta_shape(self):
        recipes = {
            "combined": {
                "5m": {
                    "timeframe": "5m", "slotCap": 12, "stopLossPct": 0.0073,
                    "tp1Pct": 0.0039, "tp2Pct": 0.0081, "tp2Pct_wide": 0.0137,
                    "tp1Fraction": 0.5, "moveSlToBeAfterTp1": True,
                    "maxHoldCandles": 12, "minConfidence": 70, "leverage": 2,
                    "_n_winners": 1000, "_n_all": 2000,
                },
                "15m": None, "1h": None,
            },
            "standard": {"5m": None, "15m": None, "1h": None},
            "xyz": {"5m": None, "15m": None, "1h": None},
        }
        rows = build_delta_rows(recipes)
        # 3 timeframes × 5 metrics = 15 rows expected
        self.assertEqual(len(rows), 15)
        # Combined 5m pfe_p60 should match exactly (0.39% vs v2 0.3907%)
        r = next(r for r in rows if r["timeframe"] == "5m" and r["metric"] == "pfe_p60")
        self.assertAlmostEqual(r["combined"], 0.39, places=4)
        self.assertAlmostEqual(r["v2_full_cohort"], V2_FULL_COHORT["5m"]["pfe_p60"], places=4)


if __name__ == "__main__":
    unittest.main()
