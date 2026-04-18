#!/usr/bin/env python3
"""Unit tests for Mode A v3 — R_standard recipe validation.

Four fixtures per spec:
  1. R_standard SL hit on 5m (BUY)
  2. R_standard TP1 + TP2 V0 on 5m (BUY)
  3. R_standard TP1 + TP2 V1 (widened) on 5m (BUY)
  4. Regression: v2 baseline recipe on a crafted BUY → matches Mode A v2 behaviour
     (proves the parameterization didn't drift the replay engine).

Run from repo root:
    python3 -m unittest scripts.tests.test_replay_engine_v3
"""
from __future__ import annotations

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from backtest_hl_lanes_mode_a import Candle, Signal  # noqa: E402
from backtest_hl_lanes_mode_a_v2 import replay_variant  # noqa: E402
from backtest_hl_lanes_mode_a_v3 import (  # noqa: E402
    R_STANDARD, VARIANTS_V3, _assert_r_standard_values,
)


def _signal(direction="BUY", entry=100.0, ts=1_776_000_000, tf="5m", confidence=70):
    return Signal(
        signal_id=1, coin="TEST", direction=direction, entry_price=entry,
        confidence=confidence, created_at=ts, timeframe=tf,
        pfe_return_pct=None, mae_pct=None, regime=None,
    )


def _bar(mm, o, h, l, c, base_ts=1_776_000_000):
    return Candle(t_ms=(base_ts + mm * 60) * 1000, o=o, h=h, l=l, c=c)


class RStandardAssertionTests(unittest.TestCase):
    """The literal-value assert must pass (matches report §7)."""

    def test_assert_passes_on_correct_values(self):
        try:
            _assert_r_standard_values()
        except AssertionError:
            self.fail("R_STANDARD must match percentile report §7 exactly")

    def test_assert_trips_on_drift(self):
        """Simulate drift by temporarily patching R_STANDARD."""
        orig = R_STANDARD["5m"]["stopLossPct"]
        R_STANDARD["5m"]["stopLossPct"] = 0.0128  # +0.0001 drift
        try:
            with self.assertRaises(AssertionError):
                _assert_r_standard_values()
        finally:
            R_STANDARD["5m"]["stopLossPct"] = orig


class RStandardReplayFixtures(unittest.TestCase):
    """Four core fixtures exercising R_standard replay behaviour."""

    def test_r_standard_sl_hit_5m(self):
        """R_standard 5m BUY: SL=1.27% → entry=100 triggers SL at 98.73."""
        sig = _signal("BUY", entry=100.0, tf="5m")
        recipe = R_STANDARD["5m"]
        vspec = VARIANTS_V3["5m"]["V0"]
        bars = [
            _bar(0, 100.0, 100.3, 99.5, 99.8),
            _bar(1, 99.8, 100.0, 98.6, 98.7),   # low 98.6 < SL 98.73 → SL hit
        ]
        out = replay_variant(sig, bars, recipe, vspec, tie_sl_first=True)
        self.assertEqual(out.outcome_type, "SL")
        self.assertAlmostEqual(out.realized_pnl_pct, -0.0127, places=6)

    def test_r_standard_tp1_tp2_v0_5m(self):
        """R_standard 5m V0: TP1=0.55%, TP2=1.06% → blended 0.5×0.0055 + 0.5×0.0106 = 0.00805."""
        sig = _signal("BUY", entry=100.0, tf="5m")
        recipe = R_STANDARD["5m"]
        vspec = VARIANTS_V3["5m"]["V0"]
        bars = [
            _bar(0, 100.0, 100.60, 99.90, 100.55),   # high 100.60 ≥ TP1 100.55
            _bar(1, 100.55, 101.20, 100.50, 101.10), # high 101.20 ≥ TP2 101.06
        ]
        out = replay_variant(sig, bars, recipe, vspec, tie_sl_first=True)
        self.assertEqual(out.outcome_type, "TP1_TP2")
        self.assertAlmostEqual(out.realized_pnl_pct, 0.00805, places=6)

    def test_r_standard_tp1_tp2_v1_5m(self):
        """R_standard 5m V1 (widened): TP1=0.55%, TP2=1.62% → 0.5×0.0055 + 0.5×0.0162 = 0.01085."""
        sig = _signal("BUY", entry=100.0, tf="5m")
        recipe = R_STANDARD["5m"]
        vspec = VARIANTS_V3["5m"]["V1"]
        bars = [
            _bar(0, 100.0, 100.60, 99.90, 100.55),
            _bar(1, 100.55, 101.30, 100.50, 101.00),
            _bar(2, 101.00, 101.70, 100.90, 101.65),  # TP2 at 101.62
        ]
        out = replay_variant(sig, bars, recipe, vspec, tie_sl_first=True)
        self.assertEqual(out.outcome_type, "TP1_TP2")
        self.assertAlmostEqual(out.realized_pnl_pct, 0.01085, places=6)

    def test_v2_regression_recipe_matches_known_v2_outcome(self):
        """Regression: apply v2 recipe values (SL 1.14%, TP1 0.67%, TP2 1.24% on 15m)
        via the same replay_variant mechanism. Verify a clean TP1_TP2 → blended = 0.5×0.0067
        + 0.5×0.0124 = 0.00955. Proves the replay engine with parameterized recipe
        still behaves like it did in Mode A v2."""
        sig = _signal("BUY", entry=100.0, tf="15m")
        v2_recipe = {
            "timeframe": "15m",
            "stopLossPct": 0.0114,
            "tp1Pct": 0.0067,
            "tp2Pct": 0.0124,
            "tp1Fraction": 0.5,
            "moveSlToBeAfterTp1": True,
            "maxHoldCandles": 12,
            "minConfidence": 52,
            "tf_seconds": 900,
        }
        v2_vspec = {"tp2Pct": 0.0124, "exit_mode": "scale_out_be", "trail_pct": 0.0}
        bars = [
            _bar(0, 100.0, 100.80, 99.90, 100.70),   # TP1 at 100.67
            _bar(1, 100.70, 101.30, 100.60, 101.25), # TP2 at 101.24
        ]
        out = replay_variant(sig, bars, v2_recipe, v2_vspec, tie_sl_first=True)
        self.assertEqual(out.outcome_type, "TP1_TP2")
        self.assertAlmostEqual(out.realized_pnl_pct, 0.00955, places=6)


class VariantsV3ShapeTests(unittest.TestCase):
    """VARIANTS_V3 specifies only V0 and V1; TP2 values pulled from R_STANDARD."""

    def test_v0_tp2_matches_p80(self):
        self.assertAlmostEqual(VARIANTS_V3["5m"]["V0"]["tp2Pct"],
                               R_STANDARD["5m"]["tp2Pct_V0"], places=9)
        self.assertAlmostEqual(VARIANTS_V3["15m"]["V0"]["tp2Pct"],
                               R_STANDARD["15m"]["tp2Pct_V0"], places=9)

    def test_v1_tp2_matches_p90(self):
        self.assertAlmostEqual(VARIANTS_V3["5m"]["V1"]["tp2Pct"],
                               R_STANDARD["5m"]["tp2Pct_V1"], places=9)
        self.assertAlmostEqual(VARIANTS_V3["15m"]["V1"]["tp2Pct"],
                               R_STANDARD["15m"]["tp2Pct_V1"], places=9)

    def test_no_trail_variants(self):
        """Per spec, V2/V3 (trail) are excluded — only V0 + V1."""
        for tf in ("5m", "15m"):
            self.assertEqual(set(VARIANTS_V3[tf].keys()), {"V0", "V1"})
            for vid in ("V0", "V1"):
                self.assertEqual(VARIANTS_V3[tf][vid]["exit_mode"], "scale_out_be")
                self.assertEqual(VARIANTS_V3[tf][vid]["trail_pct"], 0.0)


if __name__ == "__main__":
    unittest.main()
