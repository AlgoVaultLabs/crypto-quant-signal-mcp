#!/usr/bin/env python3
"""Unit tests for the HL lanes Mode A replay engine.

Run from repo root:
    python3 -m unittest scripts.tests.test_replay_engine
"""
from __future__ import annotations

import os
import sys
import unittest

# Allow running the tests by loading the script as a sibling module.
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from backtest_hl_lanes_mode_a import (  # noqa: E402
    Candle,
    Signal,
    replay_signal,
)


# Minimal recipe used across fixtures. All pct are decimals (1% = 0.01).
RECIPE_5M = {
    "stopLossPct": 0.01,
    "tp1Pct": 0.005,
    "tp2Pct": 0.01,
    "maxHoldCandles": 3,
    "tp1Fraction": 0.5,
    "moveSlToBeAfterTp1": True,
    "minConfidence": 52,
    "tf_seconds": 300,  # 5 minutes
}


def _signal(direction="BUY", entry=100.0, ts=1_776_000_000, tf="5m") -> Signal:
    return Signal(
        signal_id=1,
        coin="BTC",
        direction=direction,
        entry_price=entry,
        confidence=70,
        created_at=ts,
        timeframe=tf,
        pfe_return_pct=None,
        mae_pct=None,
        regime=None,
    )


def _bar(minute_offset: int, o: float, h: float, l: float, c: float, base_ts=1_776_000_000) -> Candle:
    return Candle(
        t_ms=(base_ts + minute_offset * 60) * 1000,
        o=o, h=h, l=l, c=c,
    )


class ReplayEngineTests(unittest.TestCase):
    """6 fixtures covering every outcome branch."""

    def test_clean_sl_long(self):
        """BUY hits SL on bar 2, no TP1 touched."""
        signal = _signal(direction="BUY", entry=100.0)
        # SL at 99.0, TP1 at 100.5. Bar 2 wicks low to 98.5.
        bars = [
            _bar(0, 100.0, 100.1, 99.5, 99.8),
            _bar(1, 99.8, 100.0, 99.6, 99.7),
            _bar(2, 99.7, 99.9, 98.5, 98.9),  # SL hit
        ]
        out = replay_signal(signal, bars, RECIPE_5M, tie_sl_first=True)
        self.assertEqual(out.outcome_type, "SL")
        self.assertAlmostEqual(out.realized_pnl_pct, -0.01, places=6)
        self.assertIsNotNone(out.sl_hit_ts)
        self.assertIsNone(out.tp1_hit_ts)
        self.assertFalse(out.same_bar_tp1_sl_tie)

    def test_clean_tp1_tp2_long(self):
        """BUY hits TP1 bar 1, TP2 bar 2. Blended = 0.5×0.005 + 0.5×0.01 = 0.0075."""
        signal = _signal(direction="BUY", entry=100.0)
        bars = [
            _bar(0, 100.0, 100.4, 99.9, 100.3),  # no fill
            _bar(1, 100.3, 100.6, 100.2, 100.5),  # TP1 at 100.5
            _bar(2, 100.5, 101.2, 100.4, 101.0),  # TP2 at 101.0
        ]
        out = replay_signal(signal, bars, RECIPE_5M, tie_sl_first=True)
        self.assertEqual(out.outcome_type, "TP1_TP2")
        self.assertAlmostEqual(out.realized_pnl_pct, 0.0075, places=6)
        self.assertIsNotNone(out.tp1_hit_ts)
        self.assertIsNotNone(out.tp2_hit_ts)

    def test_same_bar_tp1_sl_tie_long_pessimistic(self):
        """BUY on a volatile bar that crossed both TP1 and SL — default SL-first."""
        signal = _signal(direction="BUY", entry=100.0)
        bars = [
            _bar(0, 100.0, 100.6, 99.8, 100.2),   # TP1 but no SL (wick didn't cross SL)
            _bar(1, 100.2, 100.7, 98.9, 99.5),    # wick high = 100.7 (≥ 100.5 TP1 target — but TP1 already hit) and low = 98.9 (< 99 SL when SL has moved to BE 100). Because TP1 is already filled on bar 0, bar 1's low 98.9 is below BE 100 → exits as TP1_BE. Not a tie test — adjust.
        ]
        # Rebuild: we want TP1 and SL to both cross on the SAME bar before TP1 is ever
        # hit. So bar 0 must contain both.
        bars = [
            _bar(0, 100.0, 100.7, 98.9, 99.5),   # h=100.7 ≥ TP1 100.5; l=98.9 ≤ SL 99
        ]
        out = replay_signal(signal, bars, RECIPE_5M, tie_sl_first=True)
        self.assertEqual(out.outcome_type, "SL")
        self.assertAlmostEqual(out.realized_pnl_pct, -0.01, places=6)
        self.assertTrue(out.same_bar_tp1_sl_tie)

    def test_same_bar_tp1_sl_tie_long_optimistic(self):
        """Same bar, TP1-fills-first (sensitivity pass)."""
        signal = _signal(direction="BUY", entry=100.0)
        bars = [
            _bar(0, 100.0, 100.7, 98.9, 99.5),
            _bar(1, 99.5, 99.9, 99.0, 99.3),   # remaining at runner with BE at 100 — low=99.0 < 100 → scratches runner
        ]
        out = replay_signal(signal, bars, RECIPE_5M, tie_sl_first=False)
        self.assertEqual(out.outcome_type, "TP1_BE")
        # TP1 leg = 0.5 × 0.005 = 0.0025; BE leg = 0 × 0.5 = 0
        self.assertAlmostEqual(out.realized_pnl_pct, 0.0025, places=6)
        self.assertTrue(out.same_bar_tp1_sl_tie)

    def test_time_exit_positive_long(self):
        """BUY never hits TP1 or SL; time-exit on positive close."""
        signal = _signal(direction="BUY", entry=100.0)
        bars = [
            _bar(0, 100.0, 100.2, 99.8, 100.1),
            _bar(1, 100.1, 100.3, 100.0, 100.2),
            _bar(2, 100.2, 100.4, 100.1, 100.3),  # last bar, close = 100.3
        ]
        out = replay_signal(signal, bars, RECIPE_5M, tie_sl_first=True)
        self.assertEqual(out.outcome_type, "TIME_POSITIVE")
        self.assertAlmostEqual(out.realized_pnl_pct, 0.003, places=6)

    def test_time_exit_negative_long(self):
        """BUY drifts negative but never hits SL; time-exit on negative close."""
        signal = _signal(direction="BUY", entry=100.0)
        bars = [
            _bar(0, 100.0, 100.2, 99.8, 99.9),
            _bar(1, 99.9, 100.1, 99.7, 99.8),
            _bar(2, 99.8, 99.9, 99.6, 99.7),
        ]
        out = replay_signal(signal, bars, RECIPE_5M, tie_sl_first=True)
        self.assertEqual(out.outcome_type, "TIME_NEGATIVE")
        self.assertAlmostEqual(out.realized_pnl_pct, -0.003, places=6)

    def test_tp1_then_be_long(self):
        """BUY hits TP1, then the runner is stopped at BE."""
        signal = _signal(direction="BUY", entry=100.0)
        bars = [
            _bar(0, 100.0, 100.6, 99.9, 100.5),  # TP1 hit at 100.5
            _bar(1, 100.5, 100.7, 99.5, 99.8),   # low 99.5 < BE 100 → runner stopped at BE
        ]
        out = replay_signal(signal, bars, RECIPE_5M, tie_sl_first=True)
        self.assertEqual(out.outcome_type, "TP1_BE")
        # TP1 leg = 0.5 × 0.005 = 0.0025; runner BE = 0
        self.assertAlmostEqual(out.realized_pnl_pct, 0.0025, places=6)

    def test_clean_tp1_tp2_short(self):
        """SELL mirror: favorable = price down. TP1=99.5, TP2=99.0, SL=101."""
        signal = _signal(direction="SELL", entry=100.0)
        bars = [
            _bar(0, 100.0, 100.1, 99.4, 99.5),   # TP1 at 99.5 (low hits)
            _bar(1, 99.5, 99.8, 98.8, 99.0),     # TP2 at 99.0
        ]
        out = replay_signal(signal, bars, RECIPE_5M, tie_sl_first=True)
        self.assertEqual(out.outcome_type, "TP1_TP2")
        self.assertAlmostEqual(out.realized_pnl_pct, 0.0075, places=6)

    def test_no_data_returns_no_data(self):
        signal = _signal(direction="BUY", entry=100.0)
        out = replay_signal(signal, [], RECIPE_5M, tie_sl_first=True)
        self.assertEqual(out.outcome_type, "NO_DATA")
        self.assertAlmostEqual(out.realized_pnl_pct, 0.0, places=6)
        self.assertTrue(out.coverage_warning)


if __name__ == "__main__":
    unittest.main()
