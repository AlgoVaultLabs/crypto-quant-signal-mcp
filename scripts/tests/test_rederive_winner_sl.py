#!/usr/bin/env python3
"""Unit tests for Phase 1 — winner-only MAE SL re-derivation.

≥6 fixtures per spec:
  1. SQL grep-guard trips on forbidden keywords
  2. `outcome_return_pct > 0` filter present in q_winners_pooled
  3. Pooled-direction GROUP BY (by timeframe only; no `signal` in GROUP BY)
  4. R_standard_winners.SL < R_standard.SL assertion
  5. Directional sanity assert fires on inverted input
  6. Dex classification regression (from prior tests — verify import surface)
  7. Recipe delta computation

Run from repo root:
    python3 -m unittest scripts.tests.test_rederive_winner_sl
"""
from __future__ import annotations

import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from rederive_winner_sl import (  # noqa: E402
    q_winners_pooled,
    synthesize_r_standard_winners,
    directional_sanity_assert,
    R_STANDARD,
)
from query_mae_pfe_t1t2 import sql_guard, classify_dex  # noqa: E402


class Q1WinnersPooledStructureTests(unittest.TestCase):
    """Verifies the SQL query shape without executing."""

    def setUp(self):
        self.sql = q_winners_pooled("('BTC','ETH','SOL')")

    def test_contains_outcome_return_pct_gt_0(self):
        self.assertRegex(self.sql, r"outcome_return_pct\s*>\s*0")

    def test_group_by_timeframe_only(self):
        """Pooled across direction → no `signal` in GROUP BY."""
        match = re.search(r"GROUP\s+BY\s+([^\n;]+)", self.sql, re.IGNORECASE)
        self.assertIsNotNone(match)
        group_cols = match.group(1).lower()
        self.assertIn("timeframe", group_cols)
        self.assertNotIn("signal", group_cols)

    def test_filters_hl_exchange(self):
        self.assertRegex(self.sql, r"exchange='HL'")

    def test_filters_5m_and_15m_only(self):
        self.assertIn("'5m'", self.sql)
        self.assertIn("'15m'", self.sql)
        # 1h explicitly dropped per spec
        self.assertNotIn("'1h'", self.sql)

    def test_sql_grep_guard_accepts_query(self):
        """The produced SQL must not trip the mutation guard."""
        try:
            sql_guard(self.sql)
        except RuntimeError as e:
            self.fail(f"q_winners_pooled tripped SQL guard: {e}")

    def test_percentile_cont_used_for_mae_percentiles(self):
        """mae_p50/75/80/90 all via PERCENTILE_CONT."""
        for p in ("0.50", "0.75", "0.80", "0.90"):
            self.assertIn(f"PERCENTILE_CONT({p})", self.sql)


class SqlGuardBlockingTests(unittest.TestCase):
    """Mutation keywords must still trip the shared guard."""

    def test_blocks_insert(self):
        with self.assertRaisesRegex(RuntimeError, "SQL guard tripped"):
            sql_guard("INSERT INTO signals VALUES (1)")

    def test_blocks_update(self):
        with self.assertRaisesRegex(RuntimeError, "SQL guard tripped"):
            sql_guard("UPDATE signals SET confidence=99")

    def test_blocks_delete(self):
        with self.assertRaisesRegex(RuntimeError, "SQL guard tripped"):
            sql_guard("DELETE FROM signals")

    def test_blocks_drop(self):
        with self.assertRaisesRegex(RuntimeError, "SQL guard tripped"):
            sql_guard("SELECT 1; DROP TABLE signals")

    def test_blocks_alter(self):
        with self.assertRaisesRegex(RuntimeError, "SQL guard tripped"):
            sql_guard("ALTER TABLE signals ADD COLUMN x int")

    def test_blocks_truncate(self):
        with self.assertRaisesRegex(RuntimeError, "SQL guard tripped"):
            sql_guard("TRUNCATE signals")

    def test_blocks_create(self):
        with self.assertRaisesRegex(RuntimeError, "SQL guard tripped"):
            sql_guard("CREATE TABLE evil AS SELECT * FROM signals")

    def test_blocks_replace(self):
        with self.assertRaisesRegex(RuntimeError, "SQL guard tripped"):
            sql_guard("REPLACE INTO signals VALUES (1)")


class SynthesisTests(unittest.TestCase):
    """R_standard_winners synthesis + sanity assertion."""

    def test_synthesizes_both_timeframes(self):
        rows = [
            {"timeframe": "5m", "n": "458", "mae_p80": "0.9500"},
            {"timeframe": "15m", "n": "180", "mae_p80": "1.7500"},
        ]
        out = synthesize_r_standard_winners(rows)
        self.assertIn("5m", out)
        self.assertIn("15m", out)
        # 5m: SL becomes 0.95% = 0.0095; TP1/TP2 unchanged
        self.assertAlmostEqual(out["5m"]["stopLossPct"], 0.0095, places=6)
        self.assertAlmostEqual(out["5m"]["tp1Pct"], R_STANDARD["5m"]["tp1Pct"], places=9)
        self.assertAlmostEqual(out["5m"]["tp2Pct_V0"], R_STANDARD["5m"]["tp2Pct_V0"], places=9)
        self.assertAlmostEqual(out["5m"]["tp2Pct_V1"], R_STANDARD["5m"]["tp2Pct_V1"], places=9)

    def test_sanity_passes_when_sl_tighter(self):
        """Winner SL 0.0095 < R_standard 0.0127 → passes."""
        rs_winners = {
            "5m":  {"stopLossPct": 0.0095},
            "15m": {"stopLossPct": 0.0175},
        }
        try:
            directional_sanity_assert(rs_winners)
        except AssertionError:
            self.fail("Should pass — winner SL tighter than R_standard")

    def test_sanity_fails_when_sl_equal_or_wider(self):
        rs_winners = {
            "5m":  {"stopLossPct": 0.0127},   # equal — must fail
            "15m": {"stopLossPct": 0.0200},
        }
        with self.assertRaisesRegex(AssertionError, "Directional sanity assert FAILED"):
            directional_sanity_assert(rs_winners)

        rs_winners_wider = {
            "5m":  {"stopLossPct": 0.0150},   # wider than R_standard 0.0127
            "15m": {"stopLossPct": 0.0175},
        }
        with self.assertRaisesRegex(AssertionError, "Directional sanity assert FAILED"):
            directional_sanity_assert(rs_winners_wider)

    def test_synthesis_raises_on_missing_timeframe(self):
        rows = [{"timeframe": "5m", "n": "458", "mae_p80": "0.9500"}]  # no 15m
        with self.assertRaisesRegex(RuntimeError, "no winners row for timeframe 15m"):
            synthesize_r_standard_winners(rows)

    def test_delta_metadata_preserved(self):
        rows = [
            {"timeframe": "5m", "n": "458", "mae_p80": "0.9500"},
            {"timeframe": "15m", "n": "180", "mae_p80": "1.7500"},
        ]
        out = synthesize_r_standard_winners(rows)
        # _delta_pct = new_sl - r_standard_sl
        self.assertAlmostEqual(out["5m"]["_delta_pct"],
                               0.0095 - 0.0127, places=6)
        self.assertAlmostEqual(out["15m"]["_delta_pct"],
                               0.0175 - 0.0221, places=6)
        self.assertEqual(out["5m"]["_n_winners"], 458)
        self.assertEqual(out["15m"]["_n_winners"], 180)


class DexClassificationRegression(unittest.TestCase):
    """Re-verify dex classification still works as imported."""

    def test_btc_is_standard(self):
        self.assertEqual(classify_dex("BTC", {"BTC": "standard"}), "standard")

    def test_sp500_is_xyz(self):
        self.assertEqual(classify_dex("SP500", {"SP500": "xyz"}), "xyz")


if __name__ == "__main__":
    unittest.main()
