#!/usr/bin/env -S uv run --script
# /// script
# requires-python = "==3.12.*"
# dependencies = ["numpy==2.5.4"]
# ///
"""DECISION-CALL-V2-W4 CH1 — the pre-registered no-edge odds calibration study.

Every operational choice is fixed in the vault pre-registration
`audits/DECISION-CALL-V2-W4-preregistration.md` (Section B, items B1–B14); the
section tags below (`B4`, `B9`, …) point at the item each block implements.
Nothing here is served: the odds are logged by CH2, never returned (spec §0).

Run (from the repo root):

  uv run --script scripts/odds-calibration-study.py --stage fixtures --fixtures-dir tests/fixtures/odds-calibration
  uv run --script scripts/odds-calibration-study.py --stage dryrun  --out-dir <scratch> ...
  uv run --script scripts/odds-calibration-study.py --stage holdout --out-ts src/lib/pre-trade-odds-calibration.ts ...

Verdict token: ODDS_STUDY_VERDICT=PASS|FAIL|INDETERMINATE (exit 0|1|3).
  PASS          the stage completed and wrote its outputs (a field may still be uncalibrated)
  FAIL          a self-test or a parity golden failed — the code is wrong, stop
  INDETERMINATE an input could not be obtained or verified (download, checksum, eligibility,
                pre-registration seal) — nothing was scored

The archives are untrusted data: they live in their own cache directory, are opened
read-only by zipfile/numpy and are never executed or imported.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import os
import sys
import time
import traceback
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

# ---------------------------------------------------------------------------------
# Constants fixed by the pre-registration (Section A + B)
# ---------------------------------------------------------------------------------
VERSION = "odds-v1"
SEED = 20261105                                    # Section A
COINS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB", "SUI", "1000PEPE"]   # Section A order
SYMBOL = {c: f"{c}USDT" for c in COINS}
MAINT = {                                          # Section C — Bybit tier-1 maintenance rates
    "BTC": 0.0033, "ETH": 0.0033, "SOL": 0.005, "XRP": 0.005,
    "DOGE": 0.0075, "BNB": 0.0067, "SUI": 0.009, "1000PEPE": 0.01,
}
# Section A bracket cells: (stop, target) in percent, or ('s', k) = k·σ_H
BRACKET_PAIRS = [(0.5, 0.75), (1.0, 2.0), (2.5, 5.0), (5.0, 10.0), ("sigma", (1.0, 2.0))]
HOLDS_H = [0.5, 4.0, 8.0, 24.0, 72.0]
LEVERAGES = [10, 20, 50]
LIQ_HOLDS_H = [4.0, 24.0, 72.0]
N_PER_CELL = 5000                                   # Section A
HIST_MINUTES = 15 * 1440                            # B5 — ≥ 15 days of history
SIGMA_BARS = 168                                    # B4 — serving-windows.ts CANDLE_COUNTS['1h']
ATR_PERIOD = 14                                     # B4 — indicators.ts::atr(…, 14)
ATR_RANGE_PER_SIGMA = math.sqrt(8.0 / math.pi)      # B4 — pre-trade-calc.ts
RECAL_BINS = 20                                     # B9
RELIAB_BINS = 10                                    # B11
BM_SERIES_CAP = 5000                                # B8
BM_RATIO_SATURATION = 2000.0                        # B8
T0 = np.datetime64("2024-01-01T00:00")              # B2
DATA_END_EXCL = np.datetime64("2026-11-01T00:00")   # B1  (T_END = 2026-10-31T23:59)
ARCHIVE_URL = "https://data.binance.vision/data/futures/um/monthly/klines/{sym}/1m/{sym}-1m-{ym}.zip"
DEFAULT_CACHE = Path.home() / ".cache" / "algovault" / "odds-calibration-study"


def minute_index(ts: str) -> int:
    return int((np.datetime64(ts) - T0) // np.timedelta64(1, "m"))


GRID_N = minute_index(str(DATA_END_EXCL))           # 1,490,400
HOURS_N = GRID_N // 60

# B5 / B13 windows: (first minute index, last minute index inclusive, window id for the RNG)
WINDOWS = {
    "fit":       (minute_index("2024-01-01T00:00"), minute_index("2026-01-01T00:00") - 1, 0),
    "holdout":   (minute_index("2026-01-01T00:00"), minute_index("2026-11-01T00:00") - 1, 1),
    "dry_fit":   (minute_index("2024-01-01T00:00"), minute_index("2025-01-01T00:00") - 1, 2),
    "dry_score": (minute_index("2025-01-01T00:00"), minute_index("2026-01-01T00:00") - 1, 3),
}
STAGES = {
    # stage: (fit window, score window, months needed)
    "dryrun":  ("dry_fit", "dry_score", ("2024-01", "2025-12")),
    "holdout": ("fit", "holdout", ("2024-01", "2026-10")),
}


class Indeterminate(Exception):
    """An input could not be obtained or verified. Nothing was scored."""


class SelfTestFailure(Exception):
    """The code disagrees with itself or with a production golden. Stop."""


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def log(msg: str) -> None:
    print(f"[{utc_now()}] {msg}", flush=True)


# ---------------------------------------------------------------------------------
# B1 — corpus: download + checksum
# ---------------------------------------------------------------------------------
def months_between(first: str, last: str) -> list[str]:
    y, m = map(int, first.split("-"))
    ly, lm = map(int, last.split("-"))
    out = []
    while (y, m) <= (ly, lm):
        out.append(f"{y:04d}-{m:02d}")
        m += 1
        if m == 13:
            y, m = y + 1, 1
    return out


def _fetch(url: str, dest: Path) -> None:
    tmp = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": "algovault-odds-calibration-study/1"})
    with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    os.replace(tmp, dest)


def ensure_archive(sym: str, ym: str, cache: Path) -> tuple[Path, str]:
    """Return (zip path, sha256) after verifying the zip against Binance's .CHECKSUM (B1)."""
    url = ARCHIVE_URL.format(sym=sym, ym=ym)
    zp = cache / f"{sym}-1m-{ym}.zip"
    cp = cache / f"{sym}-1m-{ym}.zip.CHECKSUM"
    for attempt in (1, 2):
        try:
            if not zp.exists():
                _fetch(url, zp)
            if not cp.exists():
                _fetch(url + ".CHECKSUM", cp)
        except Exception as e:  # noqa: BLE001 — any transport failure is INDETERMINATE
            if attempt == 2:
                raise Indeterminate(f"download failed for {sym} {ym}: {e!r}") from e
            continue
        expected = cp.read_text().split()[0].strip().lower()
        actual = sha256_file(zp)
        if actual == expected:
            return zp, actual
        # a corrupt cached zip: drop it once and refetch
        zp.unlink(missing_ok=True)
        cp.unlink(missing_ok=True)
        if attempt == 2:
            raise Indeterminate(f"checksum mismatch for {sym} {ym}: expected {expected} got {actual}")
    raise Indeterminate(f"unreachable: {sym} {ym}")


def load_month(zp: Path) -> np.ndarray:
    """Parse one monthly zip → float64 array (n, 5): open_time_ms, open, high, low, close (B1)."""
    with zipfile.ZipFile(zp) as z:
        names = [n for n in z.namelist() if n.lower().endswith(".csv")]
        if len(names) != 1:
            raise Indeterminate(f"{zp.name}: expected one CSV member, found {z.namelist()}")
        raw = z.read(names[0])
    nl = raw.find(b"\n")
    first = raw[: nl if nl >= 0 else len(raw)]
    skip = 1 if first.lstrip().startswith(b"open_time") else 0
    arr = np.loadtxt(io.BytesIO(raw), delimiter=",", usecols=(0, 1, 2, 3, 4), skiprows=skip, ndmin=2)
    if arr.shape[0] == 0:
        raise Indeterminate(f"{zp.name}: no rows")
    t = arr[:, 0]
    if np.nanmax(t) > 1e14:          # microsecond timestamps → milliseconds
        arr[:, 0] = np.floor(t / 1000.0)
    return arr


# ---------------------------------------------------------------------------------
# B2 — minute grid
# ---------------------------------------------------------------------------------
def build_grid(month_arrays: list[np.ndarray]) -> dict:
    O = np.full(GRID_N, np.nan)
    H = np.full(GRID_N, np.nan)
    L = np.full(GRID_N, np.nan)
    C = np.full(GRID_N, np.nan)
    rows = rejected = dups = 0
    t0_ms = float((T0 - np.datetime64("1970-01-01T00:00")) // np.timedelta64(1, "ms"))
    for arr in month_arrays:
        rows += arr.shape[0]
        idx_f = (arr[:, 0] - t0_ms) / 60000.0
        idx = np.rint(idx_f)
        bad = (np.abs(idx_f - idx) > 1e-6) | (idx < 0) | (idx >= GRID_N) | ~np.isfinite(idx)
        rejected += int(bad.sum())
        idx = idx[~bad].astype(np.int64)
        vals = arr[~bad, 1:5]
        # keep the LAST row of a duplicate index, explicitly (B2)
        rev_idx = idx[::-1]
        _, first_pos_in_rev = np.unique(rev_idx, return_index=True)
        keep = (len(idx) - 1 - first_pos_in_rev)
        dups += int(len(idx) - len(keep))
        # a duplicate across months (index already filled) also counts
        dups += int(np.isfinite(O[idx[keep]]).sum())
        O[idx[keep]] = vals[keep, 0]
        H[idx[keep]] = vals[keep, 1]
        L[idx[keep]] = vals[keep, 2]
        C[idx[keep]] = vals[keep, 3]
    present = np.isfinite(O) & np.isfinite(H) & np.isfinite(L) & np.isfinite(C) & (O > 0) & (H > 0) & (L > 0) & (C > 0)
    for a in (O, H, L, C):
        a[~present] = np.nan
    return {"O": O, "H": H, "L": L, "C": C, "present": present,
            "counts": {"rows": rows, "rejected": rejected, "dups": dups, "gaps": int((~present).sum())}}


# ---------------------------------------------------------------------------------
# B3 — hourly bars · B4 — production σ
# ---------------------------------------------------------------------------------
def hourly_bars(g: dict) -> dict:
    O2 = g["O"].reshape(HOURS_N, 60)
    H2 = g["H"].reshape(HOURS_N, 60)
    L2 = g["L"].reshape(HOURS_N, 60)
    C2 = g["C"].reshape(HOURS_N, 60)
    pm = g["present"].reshape(HOURS_N, 60)
    hp = pm.any(axis=1)
    rows = np.arange(HOURS_N)
    first = np.argmax(pm, axis=1)
    last = 59 - np.argmax(pm[:, ::-1], axis=1)
    ho = np.where(hp, O2[rows, first], np.nan)
    hc = np.where(hp, C2[rows, last], np.nan)
    hh = np.where(hp, np.max(np.where(pm, H2, -np.inf), axis=1), np.nan)
    hl = np.where(hp, np.min(np.where(pm, L2, np.inf), axis=1), np.nan)
    return {"O": ho, "H": hh, "L": hl, "C": hc, "present": hp}


def atr_wilder_sequential(highs, lows, closes, period: int = ATR_PERIOD):
    """Mirror of indicators.ts::atr — the production estimator, step for step (B4).

    TR from the second bar on; seed = sum of the first `period` TRs / period; then
    atr = (atr·(period−1) + tr) / period. Returns None below period+1 bars.
    """
    n = len(highs)
    if n < period + 1:
        return None
    trs = []
    for i in range(1, n):
        tr = max(highs[i] - lows[i], abs(highs[i] - closes[i - 1]), abs(lows[i] - closes[i - 1]))
        trs.append(tr)
    atr_val = 0.0
    for i in range(period):
        atr_val += trs[i]
    atr_val /= period
    for i in range(period, len(trs)):
        atr_val = (atr_val * (period - 1) + trs[i]) / period
    return atr_val


def wilder_weights(nbars: int = SIGMA_BARS, period: int = ATR_PERIOD) -> np.ndarray:
    """Closed-form weights of the Wilder recursion over a window of `nbars` bars (B4).

    The recursion is linear: with r = (period−1)/period and T = nbars−1−period steps,
    atr = seed·r^T + Σ_j tr_{period+j}·r^(T−1−j)/period, seed = mean of the first `period` TRs.
    """
    ntr = nbars - 1
    r = (period - 1) / period
    tail = ntr - period
    w = np.empty(ntr)
    w[:period] = r ** tail / period
    j = np.arange(tail)
    w[period:] = r ** (tail - 1 - j) / period
    return w


def atr_windows(hb: dict) -> np.ndarray:
    """ATR(14) over the 168 bars ending at each hour J (NaN when any bar is absent) (B4)."""
    H, L, C, hp = hb["H"], hb["L"], hb["C"], hb["present"]
    tr = np.maximum.reduce([H[1:] - L[1:], np.abs(H[1:] - C[:-1]), np.abs(L[1:] - C[:-1])])
    w = wilder_weights()
    win = sliding_window_view(tr, SIGMA_BARS - 1)           # row m ↔ bars m+1 … m+167 ↔ window end J = m+167
    atr = win @ w
    valid = sliding_window_view(hp, SIGMA_BARS).all(axis=1)  # bars J−167 … J all present
    out = np.full(HOURS_N, np.nan)
    out[SIGMA_BARS - 1:] = np.where(valid, atr, np.nan)
    return out


def sigma1h_grid(g: dict, atr_h: np.ndarray) -> np.ndarray:
    """sigma_1h at every minute: atr(last closed hour) / entry open / √(8/π) (B4)."""
    i = np.arange(GRID_N)
    J = i // 60 - 1
    atr_at = np.where(J >= 0, atr_h[np.maximum(J, 0)], np.nan)
    with np.errstate(invalid="ignore", divide="ignore"):
        ratio = atr_at / g["O"]
    s = ratio / ATR_RANGE_PER_SIGMA
    s[~np.isfinite(s) | (s <= 0)] = np.nan
    return s


# ---------------------------------------------------------------------------------
# B7 — liquidation distance (pre-trade-calc.ts::liquidationDistance)
# ---------------------------------------------------------------------------------
def liq_dist(side_long, leverage, m):
    margin = 1.0 / leverage - m
    return np.where(side_long, margin / (1.0 - m), margin / (1.0 + m))


# ---------------------------------------------------------------------------------
# B8 — no-edge Brownian odds (calib.py::bm_probs, adaptive truncation)
# ---------------------------------------------------------------------------------
_erfc = np.frompyfunc(math.erfc, 1, 1)


def norm_cdf(x: np.ndarray) -> np.ndarray:
    return 0.5 * _erfc(-np.asarray(x, dtype=float) / math.sqrt(2.0)).astype(float)


def bm_probs(a: np.ndarray, b: np.ndarray, sH: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """P(time-out) and P(target first within the hold) for driftless BM in log price (B8).

    Barriers +a (target) and −b (stop), variance sH² over the hold, L = a+b, e_n = exp(−n²π²sH²/2L²):
      S  = Σ_{n odd} (4/nπ)·sin(nπb/L)·e_n
      up = b/L − Σ_{n≥1} (2/nπ)(−1)^{n+1}·sin(nπb/L)·e_n
    Truncated at N = min(5000, ⌈2.4·L/sH⌉ + 20); L/sH > 2000 → S = 1, up = 0.
    """
    a = np.asarray(a, float); b = np.asarray(b, float); sH = np.asarray(sH, float)
    L = a + b
    ratio = L / sH
    surv = np.ones_like(L)
    up = np.zeros_like(L)
    active = ratio <= BM_RATIO_SATURATION
    if not active.any():
        return surv, up
    La, ba, sa, ra = L[active], b[active], sH[active], ratio[active]
    N_i = np.minimum(BM_SERIES_CAP, np.ceil(2.4 * ra).astype(np.int64) + 20)
    Nmax = int(N_i.max())
    x = ba / La
    coef = (np.pi ** 2) * (sa ** 2) / (2.0 * La ** 2)
    s_acc = np.zeros_like(La)
    u_acc = np.zeros_like(La)
    step = 512
    for n0 in range(1, Nmax + 1, step):
        n = np.arange(n0, min(n0 + step, Nmax + 1), dtype=float)[None, :]
        mask = n <= N_i[:, None]
        e = np.exp(-coef[:, None] * n ** 2)
        s = np.sin(n * np.pi * x[:, None])
        odd = (n % 2 == 1)
        s_acc += np.sum(np.where(odd & mask, (4.0 / (n * np.pi)) * s * e, 0.0), axis=1)
        sign = np.where(odd, 1.0, -1.0)
        u_acc += np.sum(np.where(mask, (2.0 / (n * np.pi)) * sign * s * e, 0.0), axis=1)
    surv[active] = np.clip(s_acc, 0.0, 1.0)
    up[active] = np.clip(x - u_acc, 0.0, 1.0)
    return surv, up


def log_barriers(side_long, s, t):
    """Log-price barriers from fractional stop s and target t (B8)."""
    a = np.where(side_long, np.log1p(t), -np.log1p(-t))
    b = np.where(side_long, -np.log1p(-s), np.log1p(s))
    return a, b


def liq_log_distance(side_long, d):
    return np.where(side_long, -np.log1p(-d), np.log1p(d))


# ---------------------------------------------------------------------------------
# B6 — labels from the 1 m path
# ---------------------------------------------------------------------------------
def first_touch_labels(H, L, i0, up_level, dn_level, hold_bars: int, chunk: int):
    """First-touch scan over bars i0 … i0+hold_bars−1 (entry bar included) (B6).

    Returns (none_touched, up_first, dn_first, both_same_bar, hold_gap); exactly one of the first
    four is true per entry. A NaN (gap) bar cannot touch.
    """
    n = len(i0)
    none = np.zeros(n, bool); upf = np.zeros(n, bool); dnf = np.zeros(n, bool)
    both = np.zeros(n, bool); gap = np.zeros(n, bool)
    offs = np.arange(hold_bars, dtype=np.int64)[None, :]
    for c0 in range(0, n, chunk):
        sl = slice(c0, min(c0 + chunk, n))
        idx2 = i0[sl, None] + offs
        hs = H[idx2]; ls = L[idx2]
        with np.errstate(invalid="ignore"):
            up_hit = hs >= up_level[sl, None] if up_level is not None else np.zeros_like(hs, bool)
            dn_hit = ls <= dn_level[sl, None] if dn_level is not None else np.zeros_like(ls, bool)
        any_up = up_hit.any(axis=1); any_dn = dn_hit.any(axis=1)
        fu = np.where(any_up, np.argmax(up_hit, axis=1), hold_bars)
        fd = np.where(any_dn, np.argmax(dn_hit, axis=1), hold_bars)
        gap[sl] = np.isnan(hs).any(axis=1) | np.isnan(ls).any(axis=1)
        none[sl] = ~any_up & ~any_dn
        both[sl] = any_up & any_dn & (fu == fd)
        upf[sl] = any_up & (fu < fd)
        dnf[sl] = any_dn & (fd < fu)
    return none, upf, dnf, both, gap


# ---------------------------------------------------------------------------------
# B5 — eligibility and sampling
# ---------------------------------------------------------------------------------
def cell_catalog() -> list[dict]:
    cells = []
    k = 0
    for pair in BRACKET_PAIRS:
        for h in HOLDS_H:
            if pair[0] == "sigma":
                ks, kt = pair[1]
                cells.append({"k": k, "kind": "bracket", "cell_id": f"b:{ks:g}s/{kt:g}s:h{h:g}", "hold_h": h,
                              "stop_pct": None, "target_pct": None, "stop_sigma": ks, "target_sigma": kt, "leverage": None})
            else:
                s, t = pair
                cells.append({"k": k, "kind": "bracket", "cell_id": f"b:{s:g}/{t:g}:h{h:g}", "hold_h": h,
                              "stop_pct": s, "target_pct": t, "stop_sigma": None, "target_sigma": None, "leverage": None})
            k += 1
    for li, lev in enumerate(LEVERAGES):
        for hi, h in enumerate(LIQ_HOLDS_H):
            cells.append({"k": 100 + 3 * li + hi, "kind": "liq", "cell_id": f"liq:{lev}x:h{h:g}", "hold_h": h,
                          "stop_pct": None, "target_pct": None, "stop_sigma": None, "target_sigma": None, "leverage": lev})
    return cells


def eligible_minutes(win, g, sig1h, cell) -> tuple[np.ndarray, int]:
    lo, hi, _w = win
    hold_bars = int(round(cell["hold_h"] * 60))
    i = np.arange(lo, hi + 1)
    ok = (i >= HIST_MINUTES) & g["present"][i] & np.isfinite(sig1h[i]) & (i + hold_bars - 1 <= hi)
    guard_hits = 0
    if cell["kind"] == "bracket" and cell["stop_sigma"] is not None:
        sH = sig1h[i] * math.sqrt(cell["hold_h"])
        with np.errstate(invalid="ignore"):
            g_ok = cell["target_sigma"] * sH < 1.0
        guard_hits = int((ok & ~g_ok).sum())
        ok &= g_ok
    return i[ok], guard_hits


def sample_entries(win, coin_idx: int, cell, elig: np.ndarray):
    _lo, _hi, w = win
    if len(elig) < N_PER_CELL:
        raise Indeterminate(f"window {w} coin {COINS[coin_idx]} cell {cell['cell_id']}: only {len(elig)} eligible minutes")
    rng = np.random.default_rng([SEED, w, coin_idx, cell["k"]])
    i0 = rng.choice(elig, size=N_PER_CELL, replace=False)
    side_long = rng.integers(0, 2, size=N_PER_CELL) == 1
    return i0, side_long


# ---------------------------------------------------------------------------------
# Study core — one window, one coin, all cells → per-row records
# ---------------------------------------------------------------------------------
def run_window(stage_label: str, win, g, sig1h, cells, coin_idx: int, chunk: int, elig_log: list) -> dict:
    """Return per-cell row arrays for one (window, coin)."""
    H, L, O = g["H"], g["L"], g["O"]
    out = {}
    for cell in cells:
        elig, guard_hits = eligible_minutes(win, g, sig1h, cell)
        elig_log.append({"window": stage_label, "coin": COINS[coin_idx], "cell_id": cell["cell_id"],
                         "eligible": int(len(elig)), "sigma_guard_hits": guard_hits})
        i0, side_long = sample_entries(win, coin_idx, cell, elig)
        P0 = O[i0]
        s1 = sig1h[i0]
        sH = s1 * math.sqrt(cell["hold_h"])
        hold_bars = int(round(cell["hold_h"] * 60))
        if cell["kind"] == "bracket":
            if cell["stop_sigma"] is not None:
                s = cell["stop_sigma"] * sH
                t = cell["target_sigma"] * sH
            else:
                s = np.full(N_PER_CELL, cell["stop_pct"] / 100.0)
                t = np.full(N_PER_CELL, cell["target_pct"] / 100.0)
            up_level = np.where(side_long, P0 * (1.0 + t), P0 * (1.0 + s))
            dn_level = np.where(side_long, P0 * (1.0 - s), P0 * (1.0 - t))
            none, upf, dnf, both, gap = first_touch_labels(H, L, i0, up_level, dn_level, hold_bars, chunk)
            a, b = log_barriers(side_long, s, t)
            p_timeout, p_target = bm_probs(a, b, sH)
            target_first = np.where(side_long, upf, dnf)
            out[cell["cell_id"]] = {
                "i0": i0, "side_long": side_long, "sH": sH,
                "scored": ~both, "double_touch": both, "hold_gap": gap,
                "y_timeout": none.astype(float), "y_target_first": target_first.astype(float),
                "p_timeout": p_timeout, "p_target_first": p_target,
            }
        else:
            m = MAINT[COINS[coin_idx]]
            d = liq_dist(side_long, float(cell["leverage"]), m)
            liq_level = np.where(side_long, P0 * (1.0 - d), P0 * (1.0 + d))
            up_level = np.where(side_long, np.nan, liq_level)   # short: liquidation is ABOVE
            dn_level = np.where(side_long, liq_level, np.nan)   # long: liquidation is BELOW
            none, upf, dnf, both, gap = first_touch_labels(H, L, i0, up_level, dn_level, hold_bars, chunk)
            touched = upf | dnf
            d_ln = liq_log_distance(side_long, d)
            v = d_ln / sH
            p_liq = np.clip(2.0 * norm_cdf(-v), 0.0, 1.0)
            out[cell["cell_id"]] = {
                "i0": i0, "side_long": side_long, "sH": sH,
                "scored": np.ones(N_PER_CELL, bool), "double_touch": np.zeros(N_PER_CELL, bool), "hold_gap": gap,
                "y_liq": touched.astype(float), "p_liq": p_liq, "v_liq": v,
            }
    return out


# ---------------------------------------------------------------------------------
# B9–B12 — recalibration, climatology, scores, pass
# ---------------------------------------------------------------------------------
def q3(x: float) -> Decimal:
    return Decimal(repr(float(x))).quantize(Decimal("0.001"), rounding=ROUND_HALF_UP)


def fit_recalibration(v_fit: np.ndarray, y_fit: np.ndarray) -> dict:
    edges = np.quantile(v_fit, np.arange(1, RECAL_BINS) / RECAL_BINS, method="linear")
    bins = np.searchsorted(edges, v_fit, side="right")
    values = np.full(RECAL_BINS, np.nan)
    n_fit = np.zeros(RECAL_BINS, np.int64)
    for j in range(RECAL_BINS):
        sel = bins == j
        n_fit[j] = int(sel.sum())
        if n_fit[j] > 0:
            values[j] = float(y_fit[sel].mean())
    return {"edges": edges, "values": values, "n_fit": n_fit}


def apply_recalibration(rc: dict, v: np.ndarray) -> tuple[np.ndarray, int]:
    bins = np.searchsorted(rc["edges"], v, side="right")
    mapped = rc["values"][bins]
    unreachable_hits = int(np.isnan(mapped).sum())
    return mapped, unreachable_hits


def reliability(p: np.ndarray, y: np.ndarray) -> list[dict]:
    order = np.argsort(p, kind="stable")
    blocks = np.array_split(order, RELIAB_BINS)
    out = []
    for blk in blocks:
        n = int(len(blk))
        pm = float(p[blk].mean()) if n else float("nan")
        ym = float(y[blk].mean()) if n else float("nan")
        out.append({"n": n, "p_mean": pm, "y_mean": ym, "gap_pp": (pm - ym) * 100.0 if n else float("nan")})
    return out


def ece_pp(bins: list[dict]) -> float:
    N = sum(b["n"] for b in bins)
    return float(sum(b["n"] / N * abs(b["gap_pp"]) for b in bins if b["n"]))


def brier(p: np.ndarray, y: np.ndarray) -> float:
    return float(np.mean((p - y) ** 2))


def score_field(field: str, fit_rows: dict, score_rows: dict, cells: list[dict], score_win) -> dict:
    """Fit on fit_rows, score score_rows once; returns the field block of the results (B9–B12)."""
    ykey = {"timeout": "y_timeout", "target_first": "y_target_first", "liquidation": "y_liq"}[field]
    pkey = {"timeout": "p_timeout", "target_first": "p_target_first", "liquidation": "p_liq"}[field]
    vkey = {"timeout": "p_timeout", "target_first": "p_target_first", "liquidation": "v_liq"}[field]
    kind = "liq" if field == "liquidation" else "bracket"
    my_cells = [c for c in cells if c["kind"] == kind]
    lo, hi, _w = score_win
    window_minutes = hi - lo + 1

    def pooled(rows: dict, key: str, cell_ids: list[str]) -> np.ndarray:
        parts = []
        for cid in cell_ids:
            for coin in COINS:
                r = rows[coin][cid]
                parts.append(np.asarray(r[key])[r["scored"]])
        return np.concatenate(parts) if parts else np.zeros(0)

    cell_ids = [c["cell_id"] for c in my_cells]
    v_fit = pooled(fit_rows, vkey, cell_ids)
    y_fit = pooled(fit_rows, ykey, cell_ids)
    rc = fit_recalibration(v_fit, y_fit)

    indeterminate_causes = []
    cell_out = []
    p_bm_all, p_rc_all, y_all = [], [], []
    for c in my_cells:
        cid = c["cell_id"]
        yf = np.concatenate([fit_rows[coin][cid][ykey][fit_rows[coin][cid]["scored"]] for coin in COINS])
        clim = float(yf.mean()) if len(yf) else float("nan")
        ys, pbm, vs = [], [], []
        n_dt = n_gap = 0
        for coin in COINS:
            r = score_rows[coin][cid]
            sc = r["scored"]
            ys.append(r[ykey][sc]); pbm.append(r[pkey][sc]); vs.append(r[vkey][sc])
            n_dt += int(r["double_touch"].sum()); n_gap += int(r["hold_gap"].sum())
        y = np.concatenate(ys); p_bm = np.concatenate(pbm); v = np.concatenate(vs)
        p_rc, unreachable = apply_recalibration(rc, v)
        if unreachable:
            indeterminate_causes.append(f"{cid}: {unreachable} hold-out rows fell in a recalibration bin with no fit rows")
        n = int(len(y))
        if n == 0:
            indeterminate_causes.append(f"{cid}: no scored rows")
            b_bm = b_rc = b_cl = float("nan")
        else:
            b_bm = brier(p_bm, y); b_rc = brier(p_rc, y); b_cl = brier(np.full(n, clim), y)
        if not all(math.isfinite(x) for x in (b_bm, b_rc, b_cl)):
            indeterminate_causes.append(f"{cid}: non-finite Brier")
            rc3 = cl3 = None; le = False
        else:
            rc3, cl3 = q3(b_rc), q3(b_cl); le = rc3 <= cl3
        hold_bars = int(round(c["hold_h"] * 60))
        cell_out.append({
            "cell_id": cid, "hold_h": c["hold_h"], "stop_pct": c["stop_pct"], "target_pct": c["target_pct"],
            "stop_sigma": c["stop_sigma"], "target_sigma": c["target_sigma"], "leverage": c["leverage"],
            "n": n, "n_double_touch": n_dt, "n_hold_gap": n_gap,
            "max_nonoverlapping_holds_per_coin": window_minutes // hold_bars,
            "base_rate_fit": clim, "y_mean_holdout": float(y.mean()) if n else float("nan"),
            "p_bm_mean_holdout": float(p_bm.mean()) if n else float("nan"),
            "p_recal_mean_holdout": float(p_rc.mean()) if n else float("nan"),
            "brier_bm": b_bm, "brier_recal": b_rc, "brier_clim": b_cl,
            "brier_recal_3": str(rc3) if rc3 is not None else None, "brier_clim_3": str(cl3) if cl3 is not None else None,
            "recal_le_clim": bool(le),
        })
        p_bm_all.append(p_bm); p_rc_all.append(p_rc); y_all.append(y)
    P_bm = np.concatenate(p_bm_all); P_rc = np.concatenate(p_rc_all); Y = np.concatenate(y_all)
    if len(Y) < RELIAB_BINS:
        indeterminate_causes.append("fewer pooled rows than reliability bins")
        rel_rc = rel_bm = []
        ece_rc = ece_bm = float("nan")
    else:
        rel_rc = reliability(P_rc, Y); rel_bm = reliability(P_bm, Y)
        ece_rc = ece_pp(rel_rc); ece_bm = ece_pp(rel_bm)
    for b in rel_rc + rel_bm:
        b["gap_pp_3"] = str(q3(b["gap_pp"])) if math.isfinite(b["gap_pp"]) else None
    # B12 — the single derivation of the verdict
    failed = []
    if indeterminate_causes or not math.isfinite(ece_rc):
        verdict, detail, passed = "indeterminate", "; ".join(indeterminate_causes) or "non-finite ECE", False
    else:
        if q3(ece_rc) > Decimal("2.000"):
            failed.append(f"pooled recalibrated ECE {q3(ece_rc)} pp > 2.000")
        bad_bins = [i for i, b in enumerate(rel_rc) if b["n"] >= 1000 and abs(q3(b["gap_pp"])) > Decimal("5.000")]
        if bad_bins:
            failed.append("reliability bins beyond ±5 pp: " + ", ".join(f"#{i}({rel_rc[i]['gap_pp_3']} pp)" for i in bad_bins))
        bad_cells = [c["cell_id"] for c in cell_out if not c["recal_le_clim"]]
        if bad_cells:
            failed.append("recalibrated Brier above climatology in: " + ", ".join(bad_cells))
        passed = not failed
        verdict = "calibrated" if passed else "uncalibrated"
        detail = "all three clauses hold" if passed else "; ".join(failed)
    return {
        "pass": passed, "verdict": verdict, "verdict_detail": detail,
        "recal_input": "d_over_sigma_h" if field == "liquidation" else "p_bm",
        "n_fit_rows": int(len(y_fit)), "n_holdout_rows": int(len(Y)),
        "ece_pp": ece_rc, "ece_pp_3": str(q3(ece_rc)) if math.isfinite(ece_rc) else None,
        "ece_pp_bm": ece_bm, "ece_pp_bm_3": str(q3(ece_bm)) if math.isfinite(ece_bm) else None,
        "recal_bins": [{"lo": None if j == 0 else float(rc["edges"][j - 1]),
                        "hi": None if j == RECAL_BINS - 1 else float(rc["edges"][j]),
                        "value": None if np.isnan(rc["values"][j]) else float(rc["values"][j]),
                        "n_fit": int(rc["n_fit"][j])} for j in range(RECAL_BINS)],
        "reliability": rel_rc, "reliability_bm": rel_bm, "cells": cell_out,
    }


# ---------------------------------------------------------------------------------
# Self-tests (run at every start; a failure is FAIL, exit 1)
# ---------------------------------------------------------------------------------
def self_tests() -> list[str]:
    notes = []
    # (1) liquidation goldens from tests/unit/pre-trade-calc.test.ts
    d_long = float(liq_dist(np.array([True]), 20.0, 0.004)[0])
    d_short = float(liq_dist(np.array([False]), 20.0, 0.004)[0])
    if abs(d_long - 0.046185) > 5e-7 or abs(d_short - 0.045817) > 5e-7:
        raise SelfTestFailure(f"liquidation golden: long {d_long} short {d_short}")
    notes.append(f"liquidation golden 20x m=0.004: long {d_long:.6f} short {d_short:.6f}")
    # (2) Wilder weights == sequential recursion on random windows
    rng = np.random.default_rng(7)
    worst = 0.0
    for _ in range(25):
        n = SIGMA_BARS
        c = 100.0 * np.exp(np.cumsum(rng.normal(0, 0.01, n)))
        h = c * (1 + np.abs(rng.normal(0, 0.004, n)))
        l = c * (1 - np.abs(rng.normal(0, 0.004, n)))
        seq = atr_wilder_sequential(list(h), list(l), list(c))
        tr = np.maximum.reduce([h[1:] - l[1:], np.abs(h[1:] - c[:-1]), np.abs(l[1:] - c[:-1])])
        vec = float(tr @ wilder_weights())
        worst = max(worst, abs(seq - vec))
    if worst > 1e-12:
        raise SelfTestFailure(f"Wilder vectorisation drift {worst}")
    notes.append(f"Wilder closed-form vs sequential, 25 windows: max |Δ| = {worst:.2e}")
    # (3) bm_probs: S + up + down = 1; symmetric barriers; limits
    a = rng.uniform(0.002, 0.2, 2000); b = rng.uniform(0.002, 0.2, 2000); sH = rng.uniform(0.0005, 0.3, 2000)
    S, up = bm_probs(a, b, sH); _S2, down = bm_probs(b, a, sH)
    res = np.abs(S + up + down - 1.0).max()
    if res > 1e-9:
        raise SelfTestFailure(f"bm_probs partition residual {res}")
    S_sym, up_sym = bm_probs(a, a, sH)
    sym = np.abs(up_sym - (1 - S_sym) / 2).max()
    if sym > 1e-9:
        raise SelfTestFailure(f"bm_probs symmetry residual {sym}")
    S0, up0 = bm_probs(np.array([0.05]), np.array([0.05]), np.array([1e-6]))
    S1, up1 = bm_probs(np.array([0.05]), np.array([0.03]), np.array([50.0]))
    if abs(S0[0] - 1) > 1e-12 or abs(up0[0]) > 1e-12 or abs(S1[0]) > 1e-9 or abs(up1[0] - 0.03 / 0.08) > 1e-9:
        raise SelfTestFailure(f"bm_probs limits: {S0} {up0} {S1} {up1}")
    notes.append(f"bm_probs partition max residual {res:.2e}; symmetry {sym:.2e}; σ→0 and σ→∞ limits ok")
    # (4) Φ via erfc
    if abs(float(norm_cdf(np.array([0.0]))[0]) - 0.5) > 1e-15 or abs(float(norm_cdf(np.array([1.959963984540054]))[0]) - 0.975) > 1e-12:
        raise SelfTestFailure("norm_cdf")
    notes.append("norm_cdf(0)=0.5, norm_cdf(1.96)=0.975 ok")
    # (5) the emitter's recalibration text: exact round trip, and both refusals fire (two-way)
    for x in (2.523944459795622e-28, 5.717648576819556e-15, 0.1, 0.9999999999716436, 1.0 - 2.0 ** -53, 0.0):
        if float(_ts_exact(x)) != x:
            raise SelfTestFailure(f"_ts_exact round trip {x!r}")
    good = [{"lo": None, "hi": 0.0, "value": None, "n_fit": 0}, {"lo": 0.0, "hi": 5.717648576819556e-15, "value": 0.00047, "n_fit": 9},
            {"lo": 5.717648576819556e-15, "hi": None, "value": 0.5, "n_fit": 3}]
    _recal_bin_texts("self-test", good)
    for bad, why in (([dict(good[0]), {**good[1], "hi": 0.0}, {**good[2], "lo": 0.0}], "collapsed bin"),
                     ([dict(good[0]), dict(good[1]), {**good[2], "lo": 6.9e-8}], "unshared edge")):
        try:
            _recal_bin_texts("self-test", bad)
        except Indeterminate:
            continue
        raise SelfTestFailure(f"_recal_bin_texts accepted a {why}")
    notes.append("recalibration text: exact round trip; collapsed bin and unshared edge both refused")
    return notes


# ---------------------------------------------------------------------------------
# Fixtures for the TypeScript parity test (spec §5.2)
# ---------------------------------------------------------------------------------
def emit_fixtures(fixtures_dir: Path) -> list[Path]:
    fixtures_dir.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng([SEED, 9001])
    vectors = []
    for label, vol, drift, price_level in [
        ("btc-like-calm", 0.003, 0.0, 65000.0), ("eth-like", 0.006, 0.0002, 3200.0), ("sol-like-trending", 0.009, 0.0008, 150.0),
        ("doge-like-noisy", 0.012, -0.0005, 0.12), ("pepe-like-micro-price", 0.015, 0.0, 0.0091), ("flat-then-spike", 0.002, 0.0, 1.0),
    ]:
        n = SIGMA_BARS
        r = rng.normal(drift, vol, n)
        if label == "flat-then-spike":
            r[120:124] = [0.03, -0.025, 0.02, -0.015]
        c = price_level * np.exp(np.cumsum(r))
        o = np.concatenate([[price_level], c[:-1]])
        h = np.maximum(o, c) * (1 + np.abs(rng.normal(0, vol / 2, n)))
        l = np.minimum(o, c) * (1 - np.abs(rng.normal(0, vol / 2, n)))
        atr_val = atr_wilder_sequential(list(h), list(l), list(c))
        tr = np.maximum.reduce([h[1:] - l[1:], np.abs(h[1:] - c[:-1]), np.abs(l[1:] - c[:-1])])
        atr_closed = float(tr @ wilder_weights())          # the estimator the study applies (atr_windows)
        if abs(atr_closed - atr_val) > 1e-9:
            raise SelfTestFailure(f"fixture {label}: closed-form ATR {atr_closed} vs sequential {atr_val}")
        entry_price = float(c[-1] * (1 + rng.normal(0, vol / 4)))
        ratio = atr_val / entry_price
        s1 = ratio / ATR_RANGE_PER_SIGMA
        vectors.append({
            "label": label, "period": ATR_PERIOD, "bars": n,
            "highs": [float(x) for x in h], "lows": [float(x) for x in l], "closes": [float(x) for x in c],
            "entryPrice": entry_price, "atr14": float(atr_val), "atr14Closed": atr_closed, "volatilityRatio": float(ratio),
            "sigma1h": float(s1), "sigmaH": {f"{hh:g}": float(s1 * math.sqrt(hh)) for hh in HOLDS_H},
        })
    sigma_doc = {
        "_generated_by": "scripts/odds-calibration-study.py --stage fixtures (DECISION-CALL-V2-W4 CH1)",
        "_contract": "atr(highs, lows, closes, 14) from src/lib/indicators.ts must equal atr14 (sequential mirror) AND atr14Closed "
                     "(the closed-form Wilder weights the study applies) within 1e-9; "
                     "sigma1hFromVolatilityRatio(atr14 / entryPrice) must equal sigma1h within 1e-9; "
                     "sigmaH[h] = sigma1h * sqrt(h). Synthetic series, independent of any kline archive.",
        "atrRangePerSigma": ATR_RANGE_PER_SIGMA, "vectors": vectors,
    }
    rows = []
    for coin in COINS:
        for lev in LEVERAGES:
            for side in ("long", "short"):
                d = float(liq_dist(np.array([side == "long"]), float(lev), MAINT[coin])[0])
                rows.append({"coin": coin, "side": side, "leverage": lev, "maintenanceRate": MAINT[coin], "d": d,
                             "dLn": float(liq_log_distance(np.array([side == "long"]), np.array([d]))[0]),
                             "liquidationPriceFactor": (1 - d) if side == "long" else (1 + d)})
    for side in ("long", "short"):
        d = float(liq_dist(np.array([side == "long"]), 20.0, 0.004)[0])
        rows.append({"coin": "golden", "side": side, "leverage": 20, "maintenanceRate": 0.004, "d": d,
                     "dLn": float(liq_log_distance(np.array([side == "long"]), np.array([d]))[0]),
                     "liquidationPriceFactor": (1 - d) if side == "long" else (1 + d)})
    liq_doc = {
        "_generated_by": "scripts/odds-calibration-study.py --stage fixtures (DECISION-CALL-V2-W4 CH1)",
        "_contract": "liquidationDistance(side, leverage, maintenanceRate) from src/lib/pre-trade-calc.ts must equal d within 1e-9; "
                     "liquidationMaintenanceRate('BYBIT', m) must equal m (Bybit adds no fee). Rates: vault pre-registration Section C.",
        "exchange": "BYBIT", "maintenanceRates": MAINT, "rows": rows,
    }
    p1 = fixtures_dir / "sigma-vectors.json"; p2 = fixtures_dir / "liquidation-grid.json"
    p1.write_text(json.dumps(sigma_doc, indent=2) + "\n")
    p2.write_text(json.dumps(liq_doc, indent=2) + "\n")
    return [p1, p2]


# ---------------------------------------------------------------------------------
# Emitters — results JSON → TypeScript module / markdown report
# ---------------------------------------------------------------------------------
def _clean(x):
    """Recursively turn non-finite floats into null and numpy scalars into Python scalars."""
    if isinstance(x, dict):
        return {k: _clean(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [_clean(v) for v in x]
    if isinstance(x, (np.floating, float)):
        xf = float(x)
        return xf if math.isfinite(xf) else None
    if isinstance(x, (np.integer,)):
        return int(x)
    if isinstance(x, (np.bool_,)):
        return bool(x)
    return x


def _ts_num(x, nd: int) -> str:
    if x is None or (isinstance(x, float) and not math.isfinite(x)):
        return "null"
    return format(float(x), f".{nd}f")


def _ts_exact(x) -> str:
    """A recalibration number as the shortest text that parses back to the SAME float64 (Python repr).

    A TypeScript numeric literal parses correctly rounded, so the consumer bins with the doubles the
    hold-out was scored with. The 6-dp form it replaces collapsed distinct edges (target_first's
    5.7e-15 and 6.9e-8 both printed 0.000000), which re-binned rows the scoring never saw that way.
    """
    if x is None:
        return "null"
    xf = float(x)
    if not math.isfinite(xf):
        raise Indeterminate(f"recalibration number {x!r} is not finite")
    t = repr(xf)
    if float(t) != xf:
        raise Indeterminate(f"recalibration number {xf!r} does not round-trip through its text {t!r}")
    return t


def _recal_bin_texts(field: str, bins: list[dict]) -> list[tuple[str, str, str]]:
    """The emitted (lo, hi, value) texts of one field's bins, checked AS PARSED BACK from the text.

    Every bin holding fit rows must be reachable under lo <= v < hi (a null edge is ±inf), and each
    bin's hi must be the next bin's lo. Any failure is INDETERMINATE, raised before any output exists.
    """
    texts = [(_ts_exact(b["lo"]), _ts_exact(b["hi"]), _ts_exact(b["value"])) for b in bins]
    for j, ((lo_t, hi_t, _v), b) in enumerate(zip(texts, bins)):
        lo = -math.inf if lo_t == "null" else float(lo_t)
        hi = math.inf if hi_t == "null" else float(hi_t)
        if b["n_fit"] > 0 and not lo < hi:
            raise Indeterminate(f"{field} recalibration bin {j} holds {b['n_fit']} fit rows but its emitted "
                                f"edges [{lo_t}, {hi_t}) can never match")
        if j + 1 < len(texts) and hi_t != texts[j + 1][0]:
            raise Indeterminate(f"{field} recalibration bins {j} and {j + 1} do not share an edge "
                                f"({hi_t} vs {texts[j + 1][0]})")
    return texts


def _ts_str(s: str) -> str:
    return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'"


def _ts_dec(s) -> str:
    return "null" if s is None else s   # already a 3-dp decimal string


def _ts_key(k: str) -> str:
    return k if k.isidentifier() else _ts_str(k)


def emit_ts(res: dict) -> str:
    prov = res["provenance"]
    o = []
    o.append("/**")
    o.append(" * GENERATED FILE — DO NOT EDIT BY HAND.")
    o.append(" * Produced by scripts/odds-calibration-study.py --stage holdout (DECISION-CALL-V2-W4 CH1).")
    o.append(" * tests/unit/pre-trade-odds-calibration.test.ts seals this file's sha256 against")
    o.append(" * tests/fixtures/odds-calibration/generated.sha256; a hand edit fails that test (AC1.3).")
    o.append(" * Re-running the committed script on the same archives reproduces these bytes (AC1.2).")
    o.append(" *")
    o.append(" * INTERNAL ONLY. The no-edge odds are computed and logged by CH2, never served (spec §0).")
    o.append(" * Pre-registration (every definition, fixed before any data read): vault")
    o.append(f" * audits/DECISION-CALL-V2-W4-preregistration.md, sha256 {prov['preregistration_sha256']}.")
    o.append(" * Fit window and hold-out window, scored once, are recorded in `provenance`.")
    o.append(" */")
    o.append("")
    o.append(f"export const ODDS_VERSION = {_ts_str(VERSION)} as const;")
    o.append("")
    o.append("export type OddsField = 'timeout' | 'target_first' | 'liquidation';")
    o.append("export type OddsVerdict = 'calibrated' | 'uncalibrated' | 'indeterminate';")
    o.append("export type OddsRecalInput = 'p_bm' | 'd_over_sigma_h';")
    o.append("export type OddsStage = 'dryrun' | 'holdout';")
    o.append("")
    o.append("/** One of 20 equal-count recalibration bins fitted on the fit window (B9): lo ≤ v < hi; a null edge is ±∞.")
    o.append(" *  `value` is the fit-window mean label of the bin (null when no fit row fell in it — unreachable by construction).")
    o.append(" *  lo, hi and value are the study's float64s printed round-trip exact, so this table bins as the hold-out was scored. */")
    o.append("export interface OddsRecalBin {")
    o.append("  readonly lo: number | null;")
    o.append("  readonly hi: number | null;")
    o.append("  readonly value: number | null;")
    o.append("  readonly nFit: number;")
    o.append("}")
    o.append("")
    o.append("/** One of 10 equal-count reliability bins over the pooled hold-out (B11). gapPp = (pMean − yMean)·100, 3 dp half-up. */")
    o.append("export interface OddsReliabilityBin {")
    o.append("  readonly n: number;")
    o.append("  readonly pMean: number;")
    o.append("  readonly yMean: number;")
    o.append("  readonly gapPp: number;")
    o.append("}")
    o.append("")
    o.append("/** Hold-out scores of one cell (B11/B12). brierRecal3 / brierClim3 are the 3-dp half-up comparison values;")
    o.append(" *  recalLeClim is brierRecal3 ≤ brierClim3, derived once in Python. maxNonOverlappingHolds bounds the")
    o.append(" *  independent-hold count per coin behind `n` (rows are overlapping holds of one path). */")
    o.append("export interface OddsCellScore {")
    for k, t in [("cellId", "string"), ("holdH", "number"), ("stopPct", "number | null"), ("targetPct", "number | null"),
                 ("stopSigma", "number | null"), ("targetSigma", "number | null"), ("leverage", "number | null"),
                 ("n", "number"), ("nDoubleTouch", "number"), ("nHoldGap", "number"), ("maxNonOverlappingHolds", "number"),
                 ("baseRateFit", "number"), ("yMeanHoldout", "number"), ("pBmMeanHoldout", "number"), ("pRecalMeanHoldout", "number"),
                 ("brierBm", "number"), ("brierRecal", "number"), ("brierClim", "number"),
                 ("brierRecal3", "number"), ("brierClim3", "number"), ("recalLeClim", "boolean")]:
        o.append(f"  readonly {k}: {t};")
    o.append("}")
    o.append("")
    o.append("export interface OddsFieldCalibration {")
    for k, t in [("pass", "boolean"), ("verdict", "OddsVerdict"), ("verdictDetail", "string"), ("recalInput", "OddsRecalInput"),
                 ("nFitRows", "number"), ("nHoldoutRows", "number"), ("ecePp", "number"), ("ecePpBm", "number"),
                 ("recalBins", "readonly OddsRecalBin[]"), ("reliability", "readonly OddsReliabilityBin[]"),
                 ("reliabilityBm", "readonly OddsReliabilityBin[]"), ("cells", "readonly OddsCellScore[]")]:
        o.append(f"  readonly {k}: {t};")
    o.append("}")
    o.append("")
    o.append("export interface OddsWindow {")
    o.append("  readonly start: string;")
    o.append("  readonly end: string;")
    o.append("}")
    o.append("")
    o.append("export interface OddsArchiveChecksum {")
    o.append("  readonly file: string;")
    o.append("  readonly sha256: string;")
    o.append("}")
    o.append("")
    o.append("export interface OddsProvenance {")
    for k, t in [("version", "typeof ODDS_VERSION"), ("stage", "OddsStage"), ("preregistrationSha256", "string"),
                 ("archiveManifestSha256", "string"), ("archiveCount", "number"),
                 ("archiveChecksums", "readonly OddsArchiveChecksum[]"), ("dataRange", "OddsWindow"),
                 ("fitWindow", "OddsWindow"), ("holdoutWindow", "OddsWindow"), ("coins", "readonly string[]"),
                 ("maintenanceRates", "Readonly<Record<string, number>>"), ("seed", "number"),
                 ("entriesPerCoinPerCell", "number"), ("sigmaBars1h", "number"), ("atrPeriod", "number"),
                 ("recalBins", "number"), ("reliabilityBins", "number"), ("passRule", "string")]:
        o.append(f"  readonly {k}: {t};")
    o.append("}")
    o.append("")
    o.append("export interface OddsCalibration {")
    o.append("  readonly fields: {")
    o.append("    readonly timeout: OddsFieldCalibration;")
    o.append("    readonly target_first: OddsFieldCalibration;")
    o.append("    readonly liquidation: OddsFieldCalibration;")
    o.append("  };")
    o.append("  readonly provenance: OddsProvenance;")
    o.append("}")
    o.append("")
    o.append("export const ODDS_CALIBRATION: OddsCalibration = {")
    o.append("  fields: {")
    for field in ("timeout", "target_first", "liquidation"):
        f = res["fields"][field]
        o.append(f"    {field}: {{")
        o.append(f"      pass: {'true' if f['pass'] else 'false'},")
        o.append(f"      verdict: {_ts_str(f['verdict'])},")
        o.append(f"      verdictDetail: {_ts_str(f['verdict_detail'])},")
        o.append(f"      recalInput: {_ts_str(f['recal_input'])},")
        o.append(f"      nFitRows: {f['n_fit_rows']},")
        o.append(f"      nHoldoutRows: {f['n_holdout_rows']},")
        o.append(f"      ecePp: {_ts_dec(f['ece_pp_3'])},")
        o.append(f"      ecePpBm: {_ts_dec(f['ece_pp_bm_3'])},")
        o.append("      recalBins: [")
        for (lo_t, hi_t, v_t), b in zip(_recal_bin_texts(field, f["recal_bins"]), f["recal_bins"]):
            o.append(f"        {{ lo: {lo_t}, hi: {hi_t}, value: {v_t}, nFit: {b['n_fit']} }},")
        o.append("      ],")
        for key, name in (("reliability", "reliability"), ("reliability_bm", "reliabilityBm")):
            o.append(f"      {name}: [")
            for b in f[key]:
                o.append(f"        {{ n: {b['n']}, pMean: {_ts_num(b['p_mean'], 6)}, yMean: {_ts_num(b['y_mean'], 6)}, gapPp: {_ts_dec(b['gap_pp_3'])} }},")
            o.append("      ],")
        o.append("      cells: [")
        for c in f["cells"]:
            o.append("        {")
            o.append(f"          cellId: {_ts_str(c['cell_id'])}, holdH: {c['hold_h']:g}, stopPct: {_ts_num(c['stop_pct'], 2) if c['stop_pct'] is not None else 'null'}, "
                     f"targetPct: {_ts_num(c['target_pct'], 2) if c['target_pct'] is not None else 'null'}, "
                     f"stopSigma: {_ts_num(c['stop_sigma'], 1) if c['stop_sigma'] is not None else 'null'}, "
                     f"targetSigma: {_ts_num(c['target_sigma'], 1) if c['target_sigma'] is not None else 'null'}, "
                     f"leverage: {c['leverage'] if c['leverage'] is not None else 'null'},")
            o.append(f"          n: {c['n']}, nDoubleTouch: {c['n_double_touch']}, nHoldGap: {c['n_hold_gap']}, maxNonOverlappingHolds: {c['max_nonoverlapping_holds_per_coin']},")
            o.append(f"          baseRateFit: {_ts_num(c['base_rate_fit'], 6)}, yMeanHoldout: {_ts_num(c['y_mean_holdout'], 6)}, "
                     f"pBmMeanHoldout: {_ts_num(c['p_bm_mean_holdout'], 6)}, pRecalMeanHoldout: {_ts_num(c['p_recal_mean_holdout'], 6)},")
            o.append(f"          brierBm: {_ts_num(c['brier_bm'], 4)}, brierRecal: {_ts_num(c['brier_recal'], 4)}, brierClim: {_ts_num(c['brier_clim'], 4)}, "
                     f"brierRecal3: {_ts_dec(c['brier_recal_3'])}, brierClim3: {_ts_dec(c['brier_clim_3'])}, recalLeClim: {'true' if c['recal_le_clim'] else 'false'},")
            o.append("        },")
        o.append("      ],")
        o.append("    },")
    o.append("  },")
    o.append("  provenance: {")
    o.append(f"    version: {_ts_str(VERSION)},")
    o.append(f"    stage: {_ts_str(prov['stage'])},")
    o.append(f"    preregistrationSha256: {_ts_str(prov['preregistration_sha256'])},")
    o.append(f"    archiveManifestSha256: {_ts_str(prov['archive_manifest_sha256'])},")
    o.append(f"    archiveCount: {prov['archive_count']},")
    o.append("    archiveChecksums: [")
    for line in res["archives"]:
        sha, fname = line.split()
        o.append(f"      {{ file: {_ts_str(fname)}, sha256: {_ts_str(sha)} }},")
    o.append("    ],")
    for k, src in (("dataRange", "data_range"), ("fitWindow", "fit_window"), ("holdoutWindow", "score_window")):
        o.append(f"    {k}: {{ start: {_ts_str(prov[src]['start'])}, end: {_ts_str(prov[src]['end'])} }},")
    o.append("    coins: [" + ", ".join(_ts_str(c) for c in COINS) + "],")
    o.append("    maintenanceRates: { " + ", ".join(f"{_ts_key(c)}: {MAINT[c]:g}" for c in COINS) + " },")
    o.append(f"    seed: {SEED},")
    o.append(f"    entriesPerCoinPerCell: {N_PER_CELL},")
    o.append(f"    sigmaBars1h: {SIGMA_BARS},")
    o.append(f"    atrPeriod: {ATR_PERIOD},")
    o.append(f"    recalBins: {RECAL_BINS},")
    o.append(f"    reliabilityBins: {RELIAB_BINS},")
    o.append(f"    passRule: {_ts_str(prov['pass_rule'])},")
    o.append("  },")
    o.append("};")
    o.append("")
    return "\n".join(o)


def _f(x, nd=4):
    return "—" if x is None or (isinstance(x, float) and not math.isfinite(x)) else format(float(x), f".{nd}f")


def emit_md(res: dict) -> str:
    prov = res["provenance"]
    stage = prov["stage"]
    o = []
    o.append(f"# DECISION-CALL-V2-W4 — calibration report (CH1, stage `{stage}`)")
    o.append("")
    o.append("**INTERNAL. Vault-only figures.** Labels are mechanical over observed prices (first barrier touched, liquidation touch, time-out); "
             "they are quarantined from every published track-record table and nothing here is served (spec §0). "
             f"Pre-registration `audits/DECISION-CALL-V2-W4-preregistration.md` sha256 `{prov['preregistration_sha256']}`; "
             "every definition below is its Section B. Generated by `scripts/odds-calibration-study.py`; not hand-edited.")
    o.append("")
    o.append(f"- Fit window: {prov['fit_window']['start']} → {prov['fit_window']['end']} · scored window: {prov['score_window']['start']} → {prov['score_window']['end']} (scored once)")
    o.append(f"- Coins: {', '.join(COINS)} · entries per (coin, cell): {N_PER_CELL} · seed {SEED} · σ: production ATR(14) over {SIGMA_BARS} closed 1 h bars ÷ entry open ÷ √(8/π)")
    o.append(f"- Archives: {prov['archive_count']} monthly zips, every sha256 equal to Binance's `.CHECKSUM`; manifest digest `{prov['archive_manifest_sha256']}` (every checksum: `provenance.archiveChecksums` in the generated module and the evidence file)")
    o.append(f"- Pass rule (Section A): {prov['pass_rule']}")
    o.append("- Rows are overlapping holds of one price path, not independent draws; `max non-overlap/coin` is the number of non-overlapping holds the scored window can hold per coin — the effective independent count is at most 8× that.")
    o.append("")
    o.append("## Verdicts")
    o.append("")
    o.append("| field | verdict | pass | recal ECE (pp) | BM ECE (pp) | worst recal bin gap (pp) | cells recal ≤ clim | hold-out rows | detail |")
    o.append("|---|---|---|---|---|---|---|---|---|")
    for field in ("timeout", "target_first", "liquidation"):
        f = res["fields"][field]
        worst = max((abs(b["gap_pp"]) for b in f["reliability"] if math.isfinite(b["gap_pp"])), default=float("nan"))
        k = sum(1 for c in f["cells"] if c["recal_le_clim"])
        o.append(f"| {field} | **{f['verdict']}** | {'✅' if f['pass'] else '❌'} | {f['ece_pp_3'] or '—'} | {f['ece_pp_bm_3'] or '—'} | {_f(worst, 3)} | {k}/{len(f['cells'])} | {f['n_holdout_rows']:,} | {f['verdict_detail']} |")
    o.append("")
    for field in ("timeout", "target_first", "liquidation"):
        f = res["fields"][field]
        o.append(f"## Field `{field}` — recalibration input `{f['recal_input']}`")
        o.append("")
        o.append("### Per cell (hold-out)")
        o.append("")
        o.append("| cell | n | double-touch excl. | hold gaps | max non-overlap/coin | fit base rate | realized | mean p BM | mean p recal | Brier BM | Brier recal | Brier clim | recal ≤ clim (3 dp) |")
        o.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
        for c in f["cells"]:
            o.append(f"| `{c['cell_id']}` | {c['n']:,} | {c['n_double_touch']:,} | {c['n_hold_gap']:,} | {c['max_nonoverlapping_holds_per_coin']:,} | {_f(c['base_rate_fit'])} | {_f(c['y_mean_holdout'])} | {_f(c['p_bm_mean_holdout'])} | {_f(c['p_recal_mean_holdout'])} | {_f(c['brier_bm'])} | {_f(c['brier_recal'])} | {_f(c['brier_clim'])} | {'✅' if c['recal_le_clim'] else '❌'} {c['brier_recal_3']} vs {c['brier_clim_3']} |")
        o.append("")
        o.append("### Reliability — recalibrated forecast (pass input) · 10 equal-count bins")
        o.append("")
        o.append("| bin | n | mean p | mean y | gap (pp) | within ±5 pp |")
        o.append("|---|---|---|---|---|---|")
        for i, b in enumerate(f["reliability"]):
            ok = "✅" if (b["n"] < 1000 or (b["gap_pp_3"] is not None and abs(Decimal(b["gap_pp_3"])) <= Decimal("5.000"))) else "❌"
            o.append(f"| {i} | {b['n']:,} | {_f(b['p_mean'])} | {_f(b['y_mean'])} | {b['gap_pp_3']} | {ok} |")
        o.append("")
        o.append(f"Recalibrated ECE = **{f['ece_pp_3']} pp** (≤ 2.000 required). BM ECE = {f['ece_pp_bm_3']} pp (information only).")
        o.append("")
        o.append("### Reliability — raw BM forecast (information only)")
        o.append("")
        o.append("| bin | n | mean p | mean y | gap (pp) |")
        o.append("|---|---|---|---|---|")
        for i, b in enumerate(f["reliability_bm"]):
            o.append(f"| {i} | {b['n']:,} | {_f(b['p_mean'])} | {_f(b['y_mean'])} | {b['gap_pp_3']} |")
        o.append("")
        o.append("### Recalibration bins (fit window) — `lo ≤ v < hi` → value")
        o.append("")
        o.append("| bin | lo | hi | value | n fit |")
        o.append("|---|---|---|---|---|")
        for j, b in enumerate(f["recal_bins"]):
            o.append(f"| {j} | {'−∞' if b['lo'] is None else _f(b['lo'], 6)} | {'+∞' if b['hi'] is None else _f(b['hi'], 6)} | {_f(b['value'], 6)} | {b['n_fit']:,} |")
        o.append("")
    o.append("## Corpus and eligibility")
    o.append("")
    o.append("| coin | rows parsed | rejected | duplicates | gap minutes | gap share |")
    o.append("|---|---|---|---|---|---|")
    for coin in COINS:
        g = res["grid"][coin]
        o.append(f"| {coin} | {g['rows']:,} | {g['rejected']:,} | {g['dups']:,} | {g['gaps']:,} | {100.0 * g['gaps'] / GRID_N:.3f} % |")
    o.append("")
    el = res["eligibility"]
    o.append(f"Eligible minutes per (window, coin, cell): min {min(e['eligible'] for e in el):,}, max {max(e['eligible'] for e in el):,} "
             f"(each ≥ {N_PER_CELL} or the run is INDETERMINATE). σ-guard (`2σ_H < 1`) hits: {sum(e['sigma_guard_hits'] for e in el):,}.")
    o.append("")
    o.append("## Maintenance rates (Section C, Bybit tier-1)")
    o.append("")
    o.append("| coin | m |")
    o.append("|---|---|")
    for coin in COINS:
        o.append(f"| {coin} | {MAINT[coin]:g} |")
    o.append("")
    return "\n".join(o)


# ---------------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------------
def run_study(args) -> int:
    stage = args.stage
    fit_name, score_name, (m_first, m_last) = STAGES[stage]
    fit_win, score_win = WINDOWS[fit_name], WINDOWS[score_name]
    started = utc_now()
    t_start = time.time()
    log(f"stage={stage} fit={fit_name} score={score_name} months={m_first}..{m_last}")

    # --- pre-registration seal check (B13) -------------------------------------------
    prereg_sha = sha256_file(Path(args.preregistration))
    seal = Path(args.preregistration_seal).read_text().split()[0].strip().lower()
    if prereg_sha != seal:
        raise Indeterminate(f"pre-registration sha {prereg_sha} != sealed {seal}: the registration was edited; stop")
    log(f"pre-registration sha256 {prereg_sha} == sealed fixture")

    # --- B1 download + checksum ------------------------------------------------------
    cache = Path(args.cache); cache.mkdir(parents=True, exist_ok=True)
    months = months_between(m_first, m_last)
    jobs = [(SYMBOL[c], ym) for c in COINS for ym in months]
    archives = {}
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        for (sym, ym), (zp, sha) in zip(jobs, ex.map(lambda j: ensure_archive(j[0], j[1], cache), jobs)):
            archives[(sym, ym)] = (zp, sha)
    manifest_lines = [f"{sha}  {sym}-1m-{ym}.zip" for (sym, ym), (_zp, sha) in sorted(archives.items())]
    manifest_sha = sha256_bytes(("\n".join(manifest_lines) + "\n").encode())
    log(f"{len(archives)} archives verified against .CHECKSUM; manifest sha256 {manifest_sha}")
    t_dl = utc_now()

    # --- B2–B4 per coin grids and σ --------------------------------------------------
    cells = cell_catalog()
    grids = {}; sig = {}; grid_counts = {}
    for ci, coin in enumerate(COINS):
        arrs = [load_month(archives[(SYMBOL[coin], ym)][0]) for ym in months]
        g = build_grid(arrs)
        hb = hourly_bars(g)
        atr_h = atr_windows(hb)
        s1 = sigma1h_grid(g, atr_h)
        grids[coin] = g; sig[coin] = s1; grid_counts[coin] = g["counts"]
        log(f"{coin}: rows {g['counts']['rows']:,} gaps {g['counts']['gaps']:,} dups {g['counts']['dups']:,} rejected {g['counts']['rejected']:,}; "
            f"σ defined at {int(np.isfinite(s1).sum()):,} minutes")
    t_parse = utc_now()

    # --- B5–B8 entries, labels, odds — fit window then score window -------------------
    elig_log: list = []
    fit_rows = {}; score_rows = {}
    for ci, coin in enumerate(COINS):
        fit_rows[coin] = run_window(fit_name, fit_win, grids[coin], sig[coin], cells, ci, args.chunk, elig_log)
        log(f"{coin}: fit-window labels done")
    for ci, coin in enumerate(COINS):
        score_rows[coin] = run_window(score_name, score_win, grids[coin], sig[coin], cells, ci, args.chunk, elig_log)
        log(f"{coin}: score-window labels done")
    t_labels = utc_now()

    # --- B9–B12 ---------------------------------------------------------------------
    def wdesc(win):
        lo, hi, _ = win
        return {"start": str(T0 + np.timedelta64(lo, "m"))[:16] + "Z", "end": str(T0 + np.timedelta64(hi, "m"))[:16] + "Z"}

    pass_rule = ("recalibrated ECE <= 2.000 pp pooled over the field's cells; every reliability bin with n >= 1000 within +-5.000 pp; "
                 "recalibrated Brier <= climatology in every cell at 3 dp (equal counts)")
    res = {
        "odds_version": VERSION,
        "provenance": {
            "stage": stage, "preregistration_sha256": prereg_sha, "archive_manifest_sha256": manifest_sha,
            "archive_count": len(archives), "data_range": {"start": "2024-01-01T00:00Z", "end": "2026-10-31T23:59Z"},
            "fit_window": wdesc(fit_win), "score_window": wdesc(score_win), "coins": COINS, "maintenance_rates": MAINT,
            "seed": SEED, "entries_per_coin_per_cell": N_PER_CELL, "sigma_bars_1h": SIGMA_BARS, "atr_period": ATR_PERIOD,
            "pass_rule": pass_rule,
        },
        "fields": {},
        "grid": grid_counts,
        "eligibility": elig_log,
        "archives": manifest_lines,
    }
    for field in ("timeout", "target_first", "liquidation"):
        res["fields"][field] = score_field(field, fit_rows, score_rows, cells, score_win)
        f = res["fields"][field]
        log(f"{field}: verdict={f['verdict']} ECE_recal={f['ece_pp_3']} ECE_bm={f['ece_pp_bm_3']} rows={f['n_holdout_rows']:,}")
    finished = utc_now()

    # --- outputs ---------------------------------------------------------------------
    out_dir = Path(args.out_dir) if args.out_dir else None
    if out_dir:
        out_dir.mkdir(parents=True, exist_ok=True)
    ts_text = emit_ts(res)
    ts_sha = sha256_bytes(ts_text.encode())
    paths = {}
    if args.out_ts:
        Path(args.out_ts).write_text(ts_text); paths["ts"] = args.out_ts
    elif out_dir:
        (out_dir / "pre-trade-odds-calibration.ts").write_text(ts_text); paths["ts"] = str(out_dir / "pre-trade-odds-calibration.ts")
    seal_line = f"{ts_sha}  src/lib/pre-trade-odds-calibration.ts\n"
    if args.out_seal:
        Path(args.out_seal).write_text(seal_line); paths["seal"] = args.out_seal
    elif out_dir:
        (out_dir / "generated.sha256").write_text(seal_line); paths["seal"] = str(out_dir / "generated.sha256")
    json_text = json.dumps(_clean(res), indent=1, allow_nan=False) + "\n"
    md_text = emit_md(res) + "\n"
    for key, flag, name, text in (("json", args.out_json, "results.json", json_text), ("md", args.out_md, "calibration.md", md_text),
                                  ("archives", args.out_archives, "archives.sha256", "\n".join(manifest_lines) + "\n")):
        if flag:
            Path(flag).write_text(text); paths[key] = flag
        elif out_dir:
            (out_dir / name).write_text(text); paths[key] = str(out_dir / name)

    # --- run record (for the evidence file) --------------------------------------------
    script_sha = sha256_file(Path(__file__))
    rec = []
    rec.append(f"### Run record — stage `{stage}` ({'THE single hold-out scoring' if stage == 'holdout' else 'dry run on seen data'})")
    rec.append("")
    rec.append("| item | value |")
    rec.append("|---|---|")
    rec.append(f"| started | {started} |")
    rec.append(f"| archives verified | {t_dl} ({len(archives)} zips, manifest sha256 `{manifest_sha}`) |")
    rec.append(f"| grids + σ built | {t_parse} |")
    rec.append(f"| labels + odds done | {t_labels} |")
    rec.append(f"| scored, finished | {finished} (wall {time.time() - t_start:,.0f} s) |")
    rec.append(f"| fit window | {res['provenance']['fit_window']['start']} → {res['provenance']['fit_window']['end']} |")
    rec.append(f"| scored window | {res['provenance']['score_window']['start']} → {res['provenance']['score_window']['end']} |")
    rec.append(f"| script sha256 | `{script_sha}` |")
    rec.append(f"| pre-registration sha256 | `{prereg_sha}` (== sealed fixture) |")
    rec.append(f"| generated module sha256 | `{ts_sha}` |")
    rec.append(f"| numpy | {np.__version__} · python {sys.version.split()[0]} |")
    for field in ("timeout", "target_first", "liquidation"):
        f = res["fields"][field]
        rec.append(f"| {field} | {f['verdict']} · recal ECE {f['ece_pp_3']} pp · BM ECE {f['ece_pp_bm_3']} pp · cells recal≤clim {sum(1 for c in f['cells'] if c['recal_le_clim'])}/{len(f['cells'])} |")
    rec.append(f"| outputs | {', '.join(f'{k}: `{v}`' for k, v in paths.items())} |")
    rec_text = "\n".join(rec) + "\n"
    if args.run_record:
        Path(args.run_record).write_text(rec_text); paths["run_record"] = args.run_record
    elif out_dir:
        (out_dir / "run-record.md").write_text(rec_text)
    print(rec_text)
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stage", choices=["fixtures", "dryrun", "holdout"], help="dryrun | holdout (fixtures: alias of --emit-fixtures)")
    ap.add_argument("--emit-fixtures", metavar="DIR", help="write the synthetic TypeScript-parity fixtures into DIR and exit")
    ap.add_argument("--cache", default=str(DEFAULT_CACHE), help="archive cache (untrusted data; its own directory)")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--chunk", type=int, default=1000, help="entries per 2-D gather (memory bound)")
    ap.add_argument("--preregistration", help="vault pre-registration file (its sha256 is recorded)")
    ap.add_argument("--preregistration-seal", help="repo fixture holding the sealed sha256")
    ap.add_argument("--fixtures-dir", help="--stage fixtures: where to write the parity vectors")
    ap.add_argument("--out-dir", help="default directory for every output not given explicitly")
    ap.add_argument("--out-ts"); ap.add_argument("--out-seal"); ap.add_argument("--out-json")
    ap.add_argument("--out-md"); ap.add_argument("--out-archives"); ap.add_argument("--run-record")
    args = ap.parse_args(argv)
    try:
        for note in self_tests():
            log(f"self-test ok: {note}")
        fixtures_dir = args.emit_fixtures or (args.fixtures_dir if args.stage == "fixtures" else None)
        if fixtures_dir:
            for p in emit_fixtures(Path(fixtures_dir)):
                log(f"fixture written: {p} sha256 {sha256_file(p)}")
        elif args.stage not in ("dryrun", "holdout"):
            ap.error("give --emit-fixtures DIR, or --stage dryrun|holdout")
        else:
            if not (args.preregistration and args.preregistration_seal):
                ap.error("--preregistration and --preregistration-seal are required")
            if not (args.out_dir or (args.out_ts and args.out_seal and args.out_json and args.out_md)):
                ap.error("give --out-dir or every --out-* path")
            run_study(args)
    except Indeterminate as e:
        print(f"INDETERMINATE: {e}", file=sys.stderr)
        print("ODDS_STUDY_VERDICT=INDETERMINATE")
        return 3
    except SelfTestFailure as e:
        print(f"SELF-TEST FAILED: {e}", file=sys.stderr)
        print("ODDS_STUDY_VERDICT=FAIL")
        return 1
    except Exception:  # noqa: BLE001 — any other failure is a code defect
        traceback.print_exc()
        print("ODDS_STUDY_VERDICT=FAIL")
        return 1
    print("ODDS_STUDY_VERDICT=PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
