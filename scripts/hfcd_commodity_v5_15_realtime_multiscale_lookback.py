#!/usr/bin/env python3
"""HFCD Commodity V5.15: realtime multi-scale lookback.

Local research only. No broker calls, no testnet calls, no online page changes.

V5.15 keeps the electricity-style runtime objective:
- scan the current market state frequently;
- predict multiple future horizons from the current state;
- output long / short / flat / add / reduce / reverse.

This release does not tune thresholds as the main lever. It adds multi-scale
lookback state:
- scan on 1m / 5m bars when data allows;
- compute past 5m/15m/30m/1h/2h/3h/5h/8h/12h/24h context;
- use short/medium/day-context alignment to avoid missing intraday chances
  while still keeping a one-day background field.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


ROOT = Path.cwd()
VERSION = "HFCD_Commodity_V5_15_RealtimeMultiScaleLookback"
OUT_DIR = ROOT / "outputs" / "hfcd_commodity_v5_15_realtime_multiscale_lookback"
V512_PATH = ROOT / "scripts" / "hfcd_commodity_v5_12_realtime_multi_horizon_boost.py"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


v512 = load_module("v512_realtime_boost", V512_PATH)
v511 = v512.v511
v56 = v511.v56
V512_FEATURE_COLUMNS = v512.feature_columns_boost

TARGET_SYMBOLS = v512.TARGET_SYMBOLS
HORIZON_LABELS = v512.HORIZON_LABELS

V513_COLS = [
    "v513_curve_available",
    "v513_curve_backwardation_z",
    "v513_curve_slope_delta_z",
    "v513_curve_volume_ratio_z",
    "v513_inventory_expectation_gap",
    "v513_release_window",
    "v513_post_release_1h",
    "v513_post_release_3h",
    "v513_release_shock_z",
    "v513_weather_trade_pressure",
    "v513_data_quality_score",
    "v513_supply_trade_score",
]

V514_COLS = [
    "v514_pre_eia_window",
    "v514_api_proxy_window",
    "v514_market_implied_expectation_z",
    "v514_api_implied_expectation_z",
    "v514_official_inventory_surprise_z",
    "v514_true_expectation_gap_z",
    "v514_post_eia_15m_shock_z",
    "v514_post_eia_30m_shock_z",
    "v514_post_eia_1h_shock_z",
    "v514_expectation_alignment",
    "v514_expectation_data_quality",
    "v514_expectation_trade_score",
]

LOOKBACK_MINUTES = [5, 15, 30, 60, 120, 180, 300, 480, 720, 1440]
LOOKBACK_LABELS = ["5m", "15m", "30m", "1h", "2h", "3h", "5h", "8h", "12h", "24h"]
V515_COLS: list[str] = []
for _label in LOOKBACK_LABELS:
    V515_COLS.extend(
        [
            f"v515_ret_{_label}",
            f"v515_ret_z_{_label}",
            f"v515_range_{_label}",
            f"v515_volume_z_{_label}",
            f"v515_trend_efficiency_{_label}",
        ]
    )
V515_COLS.extend(
    [
        "v515_short_momentum_stack",
        "v515_medium_momentum_stack",
        "v515_long_context_stack",
        "v515_multiscale_alignment",
        "v515_multiscale_disagreement",
        "v515_multiscale_volatility_regime",
        "v515_multiscale_trade_score",
    ]
)


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def zscore(series: pd.Series, window: int = 96) -> pd.Series:
    return v512.zscore(series, window)


def num(frame: pd.DataFrame, name: str, default: float = 0.0) -> pd.Series:
    if name in frame.columns:
        return pd.to_numeric(frame[name], errors="coerce").replace([np.inf, -np.inf], np.nan).fillna(default)
    return pd.Series(default, index=frame.index, dtype=float)


def any_available(frame: pd.DataFrame, names: list[str]) -> pd.Series:
    out = pd.Series(0.0, index=frame.index, dtype=float)
    for name in names:
        if name in frame.columns:
            out = out.where(out > 0, num(frame, name).abs().gt(1e-12).astype(float))
    return out.clip(0, 1)


def eia_release_flags(timestamps: pd.Series, symbol: str) -> tuple[pd.Series, pd.Series, pd.Series]:
    ts = pd.to_datetime(timestamps, utc=True)
    hour = ts.dt.hour
    weekday = ts.dt.weekday
    if symbol == "NG=F":
        release = ((weekday == 3) & (hour >= 14) & (hour <= 20)).astype(float)
        post1 = ((weekday == 3) & (hour >= 15) & (hour <= 21)).astype(float)
        post3 = ((weekday == 3) & (hour >= 15) & (hour <= 23)).astype(float)
    else:
        release = ((weekday == 2) & (hour >= 14) & (hour <= 20)).astype(float)
        post1 = ((weekday == 2) & (hour >= 15) & (hour <= 21)).astype(float)
        post3 = ((weekday == 2) & (hour >= 15) & (hour <= 23)).astype(float)
    return release, post1, post3


def eia_expectation_windows(timestamps: pd.Series, symbol: str) -> tuple[pd.Series, pd.Series]:
    """Tradable no-leak proxy windows before official EIA releases.

    This is not a survey consensus feed. It measures market-implied expectation
    from pre-release tradable price/curve/volume reaction.
    """
    ts = pd.to_datetime(timestamps, utc=True)
    hour = ts.dt.hour
    weekday = ts.dt.weekday
    if symbol == "NG=F":
        # NG storage is usually Thursday. Use Wednesday evening as proxy for
        # informal/API-style expectation reaction, and Thursday morning as
        # official pre-release market-implied expectation.
        api_proxy = ((weekday == 2) & (hour >= 20) & (hour <= 23)).astype(float)
        pre_eia = ((weekday == 3) & (hour >= 8) & (hour < 14)).astype(float)
    else:
        # Petroleum report is usually Wednesday. API-style private inventory
        # talk is proxied by Tuesday evening reaction; official pre-release
        # expectation is proxied by Wednesday morning market reaction.
        api_proxy = ((weekday == 1) & (hour >= 20) & (hour <= 23)).astype(float)
        pre_eia = ((weekday == 2) & (hour >= 8) & (hour < 14)).astype(float)
    return pre_eia, api_proxy


def rolling_return(close: pd.Series, bars: int) -> pd.Series:
    return pd.to_numeric(close, errors="coerce").pct_change(max(1, bars)).fillna(0.0)


def infer_bars(frame: pd.DataFrame, minutes: int) -> int:
    ts = pd.to_datetime(frame["timestamp"], utc=True)
    diffs = ts.diff().dropna().dt.total_seconds() / 60.0
    if diffs.empty:
        return max(1, minutes // 5)
    base = max(1.0, float(diffs.median()))
    return max(1, int(round(minutes / base)))


def load_finite_contract_curves(mode_cfg: dict[str, Any]) -> tuple[dict[str, pd.DataFrame], list[dict[str, Any]]]:
    """Load front/next contract proxies for the same interval/range as the blind mode."""
    curves: dict[str, pd.DataFrame] = {}
    coverage: list[dict[str, Any]] = []
    interval = str(mode_cfg["interval"])
    range_ = str(mode_cfg["range"])
    tolerance = pd.Timedelta(minutes=12 if interval == "5m" else 3)

    for symbol, legs in getattr(v56, "TERM_STRUCTURE_CONTRACTS", {}).items():
        if symbol not in TARGET_SYMBOLS:
            continue
        leg_frames: dict[str, pd.DataFrame] = {}
        for leg_name, yahoo_symbol in legs.items():
            try:
                frame = v511.yahoo_chart(str(yahoo_symbol), interval, range_)
                keep = frame[["timestamp", "close", "volume"]].rename(
                    columns={
                        "close": f"curve_{leg_name}_close",
                        "volume": f"curve_{leg_name}_volume",
                    }
                )
                leg_frames[leg_name] = keep
                coverage.append(
                    {
                        "mode": mode_cfg["mode"],
                        "symbol": symbol,
                        "sensor": "finite_contract_chain",
                        "leg": leg_name,
                        "yahoo_symbol": yahoo_symbol,
                        "rows": len(keep),
                        "start": keep["timestamp"].min().isoformat() if len(keep) else "",
                        "end": keep["timestamp"].max().isoformat() if len(keep) else "",
                        "status": "loaded" if len(keep) else "empty",
                    }
                )
            except Exception as exc:
                coverage.append(
                    {
                        "mode": mode_cfg["mode"],
                        "symbol": symbol,
                        "sensor": "finite_contract_chain",
                        "leg": leg_name,
                        "yahoo_symbol": yahoo_symbol,
                        "rows": 0,
                        "status": "failed",
                        "error": repr(exc),
                    }
                )
        if "front" not in leg_frames or "next" not in leg_frames:
            continue
        front = leg_frames["front"].sort_values("timestamp")
        nxt = leg_frames["next"].sort_values("timestamp")
        merged = pd.merge_asof(front, nxt, on="timestamp", direction="nearest", tolerance=tolerance).dropna(
            subset=["curve_front_close", "curve_next_close"]
        )
        if merged.empty:
            coverage.append(
                {
                    "mode": mode_cfg["mode"],
                    "symbol": symbol,
                    "sensor": "finite_contract_curve",
                    "rows": 0,
                    "status": "merge_empty",
                }
            )
            continue
        front_close = pd.to_numeric(merged["curve_front_close"], errors="coerce")
        next_close = pd.to_numeric(merged["curve_next_close"], errors="coerce")
        spread = next_close - front_close
        merged["curve_spread_abs"] = spread
        merged["curve_backwardation"] = (front_close - next_close) / (front_close.abs() + 1e-9)
        merged["curve_contango"] = (next_close - front_close) / (front_close.abs() + 1e-9)
        merged["curve_roll_yield_proxy"] = -merged["curve_contango"]
        merged["curve_backwardation_z"] = zscore(merged["curve_backwardation"], 96)
        merged["curve_backwardation_delta_z"] = zscore(merged["curve_backwardation"].diff(), 96)
        merged["curve_volume_ratio_z"] = zscore(
            np.log1p(num(merged, "curve_front_volume")) - np.log1p(num(merged, "curve_next_volume")), 96
        )
        curves[symbol] = merged.sort_values("timestamp").reset_index(drop=True)
        coverage.append(
            {
                "mode": mode_cfg["mode"],
                "symbol": symbol,
                "sensor": "finite_contract_curve",
                "rows": len(merged),
                "start": merged["timestamp"].min().isoformat(),
                "end": merged["timestamp"].max().isoformat(),
                "status": "loaded",
            }
        )
    return curves, coverage


def attach_curve(frame: pd.DataFrame, symbol: str, curves: dict[str, pd.DataFrame], mode: str) -> pd.DataFrame:
    out = frame.copy()
    curve = curves.get(symbol)
    if curve is None or curve.empty:
        for col in [
            "curve_front_close",
            "curve_next_close",
            "curve_spread_abs",
            "curve_backwardation",
            "curve_contango",
            "curve_roll_yield_proxy",
            "curve_backwardation_z",
            "curve_backwardation_delta_z",
            "curve_volume_ratio_z",
        ]:
            if col not in out.columns:
                out[col] = 0.0
        out["v513_curve_available"] = 0.0
        return out
    tolerance = pd.Timedelta(minutes=12 if mode.startswith("5m") else 3)
    left = out.sort_values("timestamp")
    merged = pd.merge_asof(
        left,
        curve.sort_values("timestamp"),
        on="timestamp",
        direction="backward",
        tolerance=tolerance,
        suffixes=("", "_finite"),
    )
    for col in [
        "curve_front_close",
        "curve_next_close",
        "curve_spread_abs",
        "curve_backwardation",
        "curve_contango",
        "curve_roll_yield_proxy",
        "curve_backwardation_z",
        "curve_backwardation_delta_z",
        "curve_volume_ratio_z",
    ]:
        finite_col = f"{col}_finite"
        if finite_col in merged.columns:
            merged[col] = pd.to_numeric(merged[finite_col], errors="coerce").fillna(pd.to_numeric(merged.get(col, 0.0), errors="coerce").fillna(0.0))
            merged = merged.drop(columns=[finite_col])
        elif col not in merged.columns:
            merged[col] = 0.0
        merged[col] = pd.to_numeric(merged[col], errors="coerce").replace([np.inf, -np.inf], np.nan).fillna(0.0)
    merged["v513_curve_available"] = (
        num(merged, "curve_front_close").gt(0) & num(merged, "curve_next_close").gt(0)
    ).astype(float)
    return merged.sort_values("timestamp").reset_index(drop=True)


def add_v513_features(frame: pd.DataFrame, symbol: str) -> pd.DataFrame:
    out = frame.copy()
    release, post1, post3 = eia_release_flags(out["timestamp"], symbol)
    out["v513_release_window"] = release
    out["v513_post_release_1h"] = post1
    out["v513_post_release_3h"] = post3
    ret = pd.to_numeric(out["close"], errors="coerce").pct_change().fillna(0.0)
    out["v513_release_shock_z"] = zscore(ret * (post1 + post3).clip(0, 1), 96)

    if symbol == "CL=F":
        inv = (
            -num(out, "crude_stocks_forecast_revision_z")
            - num(out, "crude_stocks_surprise_z")
            - 0.5 * num(out, "cushing_stocks_forecast_revision_z")
            + 0.35 * num(out, "refinery_inputs_surprise_z")
        )
        weather = num(out, "refinery_demand")
    elif symbol == "RB=F":
        inv = -num(out, "gasoline_stocks_forecast_revision_z") - num(out, "gasoline_stocks_surprise_z")
        weather = num(out, "rb_driving_forecast_pressure") + 0.5 * num(out, "driving_season_pressure")
    elif symbol == "HO=F":
        inv = -num(out, "distillate_stocks_forecast_revision_z") - num(out, "distillate_stocks_surprise_z")
        weather = num(out, "ho_heating_forecast_pressure") + 0.5 * num(out, "heating_season_pressure")
    else:
        inv = -num(out, "ng_storage_surprise_z") - num(out, "ng_storage_change_z") + num(out, "ng_storage_tightness")
        weather = num(out, "ng_weather_forecast_pressure") + 0.5 * num(out, "ng_weather_pressure")

    out["v513_inventory_expectation_gap"] = zscore(inv, 96)
    out["v513_weather_trade_pressure"] = zscore(weather, 96)
    out["v513_curve_backwardation_z"] = zscore(num(out, "curve_backwardation"), 96)
    out["v513_curve_slope_delta_z"] = zscore(num(out, "curve_backwardation").diff(), 96)
    out["v513_curve_volume_ratio_z"] = zscore(num(out, "curve_volume_ratio_z"), 96)

    inv_available = any_available(
        out,
        [
            "crude_stocks_surprise_z",
            "gasoline_stocks_surprise_z",
            "distillate_stocks_surprise_z",
            "ng_storage_surprise_z",
            "crude_stocks_forecast_revision_z",
            "gasoline_stocks_forecast_revision_z",
            "distillate_stocks_forecast_revision_z",
        ],
    )
    weather_available = any_available(
        out,
        [
            "rb_driving_forecast_pressure",
            "ho_heating_forecast_pressure",
            "ng_weather_forecast_pressure",
            "ng_weather_pressure",
            "refinery_demand",
        ],
    )
    volume_available = num(out, "volume").gt(0).astype(float)
    out["v513_data_quality_score"] = (
        0.38 * num(out, "v513_curve_available")
        + 0.26 * inv_available
        + 0.18 * weather_available
        + 0.18 * volume_available
    ).clip(0, 1)

    raw = (
        0.30 * out["v513_inventory_expectation_gap"]
        + 0.24 * out["v513_curve_backwardation_z"]
        + 0.16 * out["v513_curve_slope_delta_z"]
        + 0.14 * out["v513_weather_trade_pressure"]
        - 0.10 * out["v513_release_shock_z"].abs()
        + 0.06 * out["v513_curve_volume_ratio_z"]
    )
    # CL is deliberately non-destructive: V5.13 can tilt or flatten weak CL
    # signals, but it should not override the V5.4/V5.12 core route.
    shrink = 0.55 if symbol == "CL=F" else 1.0
    out["v513_supply_trade_score"] = (raw * shrink * (0.35 + 0.65 * out["v513_data_quality_score"])).clip(-6, 6)

    for col in V513_COLS:
        out[col] = pd.to_numeric(out.get(col, 0.0), errors="coerce").replace([np.inf, -np.inf], np.nan).fillna(0.0)
    return out


def official_inventory_surprise(frame: pd.DataFrame, symbol: str) -> pd.Series:
    if symbol == "CL=F":
        return (
            -num(frame, "crude_stocks_surprise_z")
            - 0.55 * num(frame, "cushing_stocks_surprise_z")
            + 0.25 * num(frame, "refinery_inputs_surprise_z")
        )
    if symbol == "RB=F":
        return -num(frame, "gasoline_stocks_surprise_z") + 0.15 * num(frame, "refinery_inputs_surprise_z")
    if symbol == "HO=F":
        return -num(frame, "distillate_stocks_surprise_z") + 0.10 * num(frame, "refinery_inputs_surprise_z")
    return -num(frame, "ng_storage_surprise_z") - 0.25 * num(frame, "ng_storage_change_z") + 0.20 * num(frame, "ng_storage_tightness")


def add_v514_features(frame: pd.DataFrame, symbol: str) -> pd.DataFrame:
    out = frame.copy()
    pre_eia, api_proxy = eia_expectation_windows(out["timestamp"], symbol)
    out["v514_pre_eia_window"] = pre_eia
    out["v514_api_proxy_window"] = api_proxy

    b15 = infer_bars(out, 15)
    b30 = infer_bars(out, 30)
    b60 = infer_bars(out, 60)
    close = pd.to_numeric(out["close"], errors="coerce").replace(0, np.nan).ffill()
    volume = pd.to_numeric(out.get("volume", 0.0), errors="coerce").fillna(0.0)
    ret15 = rolling_return(close, b15)
    ret30 = rolling_return(close, b30)
    ret60 = rolling_return(close, b60)
    curve_delta = num(out, "curve_backwardation").diff(max(1, b30)).fillna(0.0)
    vol_impulse = np.log1p(volume).diff(max(1, b30)).fillna(0.0)

    pre_pressure = (
        0.46 * zscore(ret60, 288)
        + 0.28 * zscore(curve_delta, 288)
        + 0.16 * zscore(ret30, 288)
        + 0.10 * zscore(vol_impulse, 288)
    )
    api_pressure = (
        0.48 * zscore(ret30, 288)
        + 0.24 * zscore(curve_delta, 288)
        + 0.18 * zscore(vol_impulse, 288)
        + 0.10 * zscore(num(out, "curve_volume_ratio_z"), 288)
    )
    # Carry the latest window signal forward until the next release day. This
    # mimics a tradable expectation ledger instead of only a one-bar pulse.
    out["v514_market_implied_expectation_z"] = zscore((pre_pressure * pre_eia).replace(0, np.nan).ffill().fillna(0.0), 288)
    out["v514_api_implied_expectation_z"] = zscore((api_pressure * api_proxy).replace(0, np.nan).ffill().fillna(0.0), 288)
    out["v514_official_inventory_surprise_z"] = zscore(official_inventory_surprise(out, symbol), 96)
    implied = 0.64 * out["v514_market_implied_expectation_z"] + 0.36 * out["v514_api_implied_expectation_z"]
    out["v514_true_expectation_gap_z"] = (
        out["v514_official_inventory_surprise_z"] - implied
    ).replace([np.inf, -np.inf], np.nan).fillna(0.0).clip(-6, 6)

    post_gate = (num(out, "v513_post_release_1h") + num(out, "v513_post_release_3h")).clip(0, 1)
    out["v514_post_eia_15m_shock_z"] = zscore(ret15 * post_gate, 288)
    out["v514_post_eia_30m_shock_z"] = zscore(ret30 * post_gate, 288)
    out["v514_post_eia_1h_shock_z"] = zscore(ret60 * post_gate, 288)
    out["v514_expectation_alignment"] = np.sign(implied) * np.sign(out["v514_official_inventory_surprise_z"])

    out["v514_expectation_data_quality"] = (
        0.34 * num(out, "v513_curve_available")
        + 0.24 * pre_eia
        + 0.16 * api_proxy
        + 0.16 * any_available(out, ["crude_stocks_surprise_z", "gasoline_stocks_surprise_z", "distillate_stocks_surprise_z", "ng_storage_surprise_z"])
        + 0.10 * num(out, "volume").gt(0).astype(float)
    ).clip(0, 1)

    # The gap score means: if official data is bullish relative to what the
    # market implied, favor follow-through; if the gap is negative, favor shorts.
    # CL is still shrunk to avoid repeating the curve-guard regression.
    shock_follow = (
        0.50 * out["v514_true_expectation_gap_z"]
        + 0.20 * out["v514_post_eia_15m_shock_z"]
        + 0.16 * out["v514_post_eia_30m_shock_z"]
        + 0.08 * out["v514_post_eia_1h_shock_z"]
        + 0.06 * zscore(num(out, "curve_backwardation").diff(), 96)
    )
    shrink = 0.60 if symbol == "CL=F" else 1.0
    out["v514_expectation_trade_score"] = (
        shock_follow * shrink * (0.30 + 0.70 * out["v514_expectation_data_quality"])
    ).clip(-6, 6).fillna(0.0)
    for col in V514_COLS:
        out[col] = pd.to_numeric(out.get(col, 0.0), errors="coerce").replace([np.inf, -np.inf], np.nan).fillna(0.0)
    return out


def add_v515_features(frame: pd.DataFrame, symbol: str, base_minutes: int) -> pd.DataFrame:
    """Add current-time multi-scale context from 5 minutes to 24 hours.

    The decision cadence remains 1m/5m, but the feature window is deliberately
    wider. This separates "how often we scan" from "how much past context we
    use" and matches the user's electricity-model intent.
    """
    out = frame.copy()
    base = max(1, int(base_minutes))
    close = pd.to_numeric(out["close"], errors="coerce").replace(0, np.nan).ffill().bfill()
    high = pd.to_numeric(out.get("high", close), errors="coerce").replace(0, np.nan).ffill().bfill()
    low = pd.to_numeric(out.get("low", close), errors="coerce").replace(0, np.nan).ffill().bfill()
    volume = pd.to_numeric(out.get("volume", 0.0), errors="coerce").replace([np.inf, -np.inf], np.nan).fillna(0.0)
    ret1 = close.pct_change().replace([np.inf, -np.inf], np.nan).fillna(0.0)

    for minutes, label in zip(LOOKBACK_MINUTES, LOOKBACK_LABELS):
        bars = max(1, int(round(minutes / base)))
        stat_window = max(48, min(720, bars * 4))
        lb_ret = (close / close.shift(bars) - 1.0).replace([np.inf, -np.inf], np.nan).fillna(0.0)
        rolling_high = high.rolling(bars, min_periods=max(1, min(3, bars))).max()
        rolling_low = low.rolling(bars, min_periods=max(1, min(3, bars))).min()
        lb_range = ((rolling_high - rolling_low) / (close.abs() + 1e-9)).replace([np.inf, -np.inf], np.nan).fillna(0.0)
        volume_sum = volume.rolling(bars, min_periods=max(1, min(3, bars))).sum()
        path = ret1.abs().rolling(bars, min_periods=max(1, min(3, bars))).sum()

        out[f"v515_ret_{label}"] = lb_ret
        out[f"v515_ret_z_{label}"] = zscore(lb_ret, stat_window)
        out[f"v515_range_{label}"] = lb_range
        out[f"v515_volume_z_{label}"] = zscore(np.log1p(volume_sum), stat_window)
        out[f"v515_trend_efficiency_{label}"] = (lb_ret.abs() / (path + 1e-9)).clip(0, 1).fillna(0.0)

    short_cols = [f"v515_ret_z_{label}" for label in ["5m", "15m", "30m"]]
    medium_cols = [f"v515_ret_z_{label}" for label in ["1h", "2h", "3h", "5h"]]
    long_cols = [f"v515_ret_z_{label}" for label in ["8h", "12h", "24h"]]
    out["v515_short_momentum_stack"] = out[short_cols].mean(axis=1).fillna(0.0)
    out["v515_medium_momentum_stack"] = out[medium_cols].mean(axis=1).fillna(0.0)
    out["v515_long_context_stack"] = out[long_cols].mean(axis=1).fillna(0.0)

    stack = pd.concat(
        [
            out["v515_short_momentum_stack"],
            out["v515_medium_momentum_stack"],
            out["v515_long_context_stack"],
        ],
        axis=1,
    )
    sign_stack = np.sign(stack).replace(0, np.nan)
    out["v515_multiscale_alignment"] = (sign_stack.sum(axis=1).abs() / sign_stack.count(axis=1).clip(lower=1)).fillna(0.0).clip(0, 1)
    out["v515_multiscale_disagreement"] = (1.0 - out["v515_multiscale_alignment"]).clip(0, 1)
    volatility_proxy = (
        0.25 * num(out, "v515_range_15m")
        + 0.25 * num(out, "v515_range_1h")
        + 0.25 * num(out, "v515_range_3h")
        + 0.25 * num(out, "v515_range_24h")
    )
    out["v515_multiscale_volatility_regime"] = zscore(volatility_proxy, 288)
    efficiency = (
        0.35 * num(out, "v515_trend_efficiency_15m")
        + 0.35 * num(out, "v515_trend_efficiency_1h")
        + 0.30 * num(out, "v515_trend_efficiency_3h")
    )
    raw = (
        0.48 * out["v515_short_momentum_stack"]
        + 0.34 * out["v515_medium_momentum_stack"]
        + 0.18 * out["v515_long_context_stack"]
    )
    context_gate = (0.40 + 0.45 * out["v515_multiscale_alignment"] + 0.15 * efficiency).clip(0.20, 1.20)
    noise_penalty = 1.0 / (1.0 + 0.22 * out["v515_multiscale_volatility_regime"].abs())
    out["v515_multiscale_trade_score"] = (raw * context_gate * noise_penalty).clip(-6, 6).fillna(0.0)

    for col in V515_COLS:
        out[col] = pd.to_numeric(out.get(col, 0.0), errors="coerce").replace([np.inf, -np.inf], np.nan).fillna(0.0)
    return out


def load_mode_features_v513(mode_cfg: dict[str, Any]):
    curves, curve_coverage = load_finite_contract_curves(mode_cfg)
    features, coverage, sensor_meta = v512.load_mode_features_boost(mode_cfg)
    out_features: dict[str, pd.DataFrame] = {}
    for symbol, frame in features.items():
        enriched = attach_curve(frame, symbol, curves, str(mode_cfg["mode"]))
        enriched = add_v513_features(enriched, symbol)
        enriched = add_v514_features(enriched, symbol)
        enriched = add_v515_features(enriched, symbol, int(mode_cfg["base_minutes"]))
        enriched = v512.add_v512_features(enriched, symbol)
        out_features[symbol] = enriched
    sensor_meta = dict(sensor_meta)
    sensor_meta["v515_multiscale_lookback"] = {
        "status": "enabled",
        "features": V513_COLS + V514_COLS + V515_COLS,
        "finite_contract_curves": {k: len(v) for k, v in curves.items()},
        "lookback_minutes": LOOKBACK_MINUTES,
        "note": "Scans on 1m/5m bars and computes past 5m..24h context while predicting future 15m..3h horizons.",
    }
    return out_features, coverage + curve_coverage, sensor_meta


def feature_columns_v513(symbol: str) -> list[str]:
    return list(dict.fromkeys(V512_FEATURE_COLUMNS(symbol) + V513_COLS + V514_COLS + V515_COLS))


def signal_state_v513(row: pd.Series, policy) -> dict[str, Any]:
    state = v512.signal_state_boost(row, policy)
    supply = float(row.get("v513_supply_trade_score", 0.0))
    quality = float(row.get("v513_data_quality_score", 0.0))
    expectation = float(row.get("v514_expectation_trade_score", 0.0))
    expectation_quality = float(row.get("v514_expectation_data_quality", 0.0))
    multiscale = float(row.get("v515_multiscale_trade_score", 0.0))
    multiscale_alignment = float(row.get("v515_multiscale_alignment", 0.0))
    multiscale_disagreement = float(row.get("v515_multiscale_disagreement", 0.0))
    overlay = 0.62 * expectation * (0.35 + 0.65 * expectation_quality) + 0.38 * supply * (0.45 + 0.55 * quality)
    overlay_score = 0.011 * float(np.tanh(overlay / 2.0))
    overlay_return = 0.0011 * float(np.tanh(overlay / 2.0))
    multiscale_score = 0.010 * float(np.tanh(multiscale / 2.0))
    multiscale_return = 0.0010 * float(np.tanh(multiscale / 2.0))
    score = 0.66 * float(state["score"]) + 0.20 * overlay_score + 0.14 * multiscale_score
    expected = 0.78 * float(state["expected_return"]) + 0.14 * overlay_return + 0.08 * multiscale_return
    direction = 1 if score >= 0 else -1
    agreement = float(state["agreement"])
    if quality >= 0.55 and abs(supply) >= 0.90 and np.sign(supply) == direction:
        agreement = min(1.0, agreement + 0.06)
    if expectation_quality >= 0.45 and abs(expectation) >= 0.90 and np.sign(expectation) == direction:
        agreement = min(1.0, agreement + 0.07)
    if quality >= 0.45 and abs(supply) >= 1.60 and np.sign(supply) == -direction:
        agreement = max(0.0, agreement - 0.10)
    if expectation_quality >= 0.35 and abs(expectation) >= 1.50 and np.sign(expectation) == -direction:
        agreement = max(0.0, agreement - 0.10)
    if multiscale_alignment >= 0.56 and abs(multiscale) >= 0.90 and np.sign(multiscale) == direction:
        agreement = min(1.0, agreement + 0.08)
    if multiscale_disagreement >= 0.65 and abs(multiscale) >= 1.25:
        agreement = max(0.0, agreement - 0.08)
    if multiscale_alignment >= 0.50 and abs(multiscale) >= 1.60 and np.sign(multiscale) == -direction:
        agreement = max(0.0, agreement - 0.12)
    state.update(
        {
            "score": float(score),
            "direction": int(direction),
            "confidence": float(abs(score)),
            "agreement": float(agreement),
            "expected_return": float(expected),
            "expected_move_bps": float(max(state["expected_move_bps"], abs(expected) * 10000.0)),
            "v513_supply_trade_score": round(supply, 6),
            "v513_data_quality_score": round(quality, 6),
            "v514_expectation_trade_score": round(expectation, 6),
            "v514_expectation_data_quality": round(expectation_quality, 6),
            "v515_multiscale_trade_score": round(multiscale, 6),
            "v515_multiscale_alignment": round(multiscale_alignment, 6),
        }
    )
    return state


def desired_units_v513(row: pd.Series, policy):
    state = signal_state_v513(row, policy)
    quality = float(row.get("v513_data_quality_score", 0.0))
    supply = float(row.get("v513_supply_trade_score", 0.0))
    expectation = float(row.get("v514_expectation_trade_score", 0.0))
    expectation_quality = float(row.get("v514_expectation_data_quality", 0.0))
    multiscale = float(row.get("v515_multiscale_trade_score", 0.0))
    multiscale_alignment = float(row.get("v515_multiscale_alignment", 0.0))
    multiscale_disagreement = float(row.get("v515_multiscale_disagreement", 0.0))
    release = float(row.get("v513_release_window", 0.0))

    if state["confidence"] < policy.dead_zone and state["expected_move_bps"] < policy.min_move_bps + 2.0:
        return 0, {**state, "reason": "dead_zone"}
    if quality < 0.18 and state["confidence"] < policy.dead_zone + 0.020:
        return 0, {**state, "reason": "data_quality_low"}
    if state["agreement"] < policy.min_agreement:
        return 0, {**state, "reason": "horizon_disagreement"}
    if state["expected_move_bps"] < policy.min_move_bps:
        return 0, {**state, "reason": "move_too_small"}
    if float(row.get("v53_manifest_quality", 0.0)) < policy.min_hfcd_quality:
        return 0, {**state, "reason": "hfcd_quality_low"}
    if float(row.get("v53_bsigma", 0.0)) > policy.risk_cut and state["confidence"] < policy.dead_zone + 0.020:
        return 0, {**state, "reason": "bsigma_cut"}
    if release > 0 and abs(float(row.get("v513_release_shock_z", 0.0))) > 2.0 and state["confidence"] < policy.dead_zone + 0.030:
        return 0, {**state, "reason": "eia_release_shock_guard"}
    if quality >= 0.45 and abs(supply) > 1.8 and np.sign(supply) == -state["direction"] and state["confidence"] < policy.dead_zone + 0.025:
        return 0, {**state, "reason": "tradable_data_disagree"}
    if (
        expectation_quality >= 0.35
        and abs(expectation) > 1.6
        and np.sign(expectation) == -state["direction"]
        and state["confidence"] < policy.dead_zone + 0.030
    ):
        return 0, {**state, "reason": "expectation_gap_disagree"}
    if (
        multiscale_disagreement >= 0.72
        and abs(multiscale) > 1.25
        and state["confidence"] < policy.dead_zone + 0.030
    ):
        return 0, {**state, "reason": "multiscale_context_disagree"}

    units = 1
    if state["confidence"] >= policy.dead_zone + 0.018 and state["expected_move_bps"] >= policy.min_move_bps + 3.0:
        units += 1
    if quality >= 0.55 and abs(supply) >= 1.4 and np.sign(supply) == state["direction"]:
        units += 1
    if expectation_quality >= 0.45 and abs(expectation) >= 1.3 and np.sign(expectation) == state["direction"]:
        units += 1
    if multiscale_alignment >= 0.62 and abs(multiscale) >= 1.4 and np.sign(multiscale) == state["direction"]:
        units += 1
    return int(state["direction"] * min(policy.max_units, units)), {**state, "reason": "active"}


def policy_grid_v513(symbol: str, mode: str) -> list[Any]:
    # V5.15 is a multi-scale context run. Keep grid bounded and comparable to V5.12-V5.14.
    if symbol == "CL=F":
        horizon_sets = ["all", "mid"]
        profiles = [(0.009, 0.56, 2.0, 0.04, 2, 3.1), (0.013, 0.64, 4.0, 0.12, 2, 2.7)]
    elif symbol == "HO=F":
        horizon_sets = ["near", "mid", "barbell"]
        profiles = [(0.008, 0.54, 2.0, 0.04, 2, 3.3), (0.012, 0.62, 4.0, 0.10, 3, 2.9)]
    elif symbol == "RB=F":
        horizon_sets = ["near", "mid"]
        profiles = [(0.008, 0.54, 2.0, 0.04, 2, 3.3), (0.012, 0.62, 4.0, 0.10, 2, 2.9)]
    else:
        horizon_sets = ["near", "mid"]
        profiles = [(0.009, 0.56, 2.0, 0.05, 1, 3.5), (0.013, 0.64, 4.0, 0.12, 2, 3.0)]
    out = []
    for horizon_set in horizon_sets:
        for dead_zone, min_agreement, min_move_bps, min_quality, max_units, risk_cut in profiles:
            out.append(
                v511.RealtimePolicy(
                    symbol,
                    mode,
                    horizon_set,
                    dead_zone,
                    min_agreement,
                    min_move_bps,
                    min_quality,
                    max_units,
                    risk_cut,
                )
            )
    return out


def select_routes(summary_df: pd.DataFrame) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    if summary_df.empty:
        return selected
    for _symbol, group in summary_df.groupby("symbol", sort=False):
        candidates = group[
            (group["validation_active_signal_rate"] >= 0.06)
            & (group["test_active_signal_rate"] >= 0.06)
            & (group["validation_direction_hit_rate"] >= 0.60)
            & (group["test_direction_hit_rate"] >= 0.60)
            & (group["validation_profit_factor"] >= 1.15)
            & (group["test_profit_factor"] >= 1.15)
            & (group["test_actions_per_day"] >= 0.60)
        ].copy()
        if not candidates.empty:
            selected.append(candidates.sort_values("selection_score", ascending=False).iloc[0].to_dict())
    return sorted(selected, key=lambda r: (float(r.get("test_direction_hit_rate", 0)), float(r.get("test_profit_factor", 0))), reverse=True)


def make_report(run_summary: dict[str, Any], selected: list[dict[str, Any]], best_rows: list[dict[str, Any]]) -> str:
    lines = [
        f"# {VERSION}",
        "",
        "## 结论",
        "",
        f"- 状态：`{run_summary['status']}`",
        "- V5.15 不继续调阈值；本版验证多尺度历史窗口是否提升当前时刻的多 horizon 方向预测和仓位动作质量。",
        "- 新增：EIA 发布前市场隐含预期、API 发布窗口代理、官方库存 surprise 与发布后 15m/30m/1h 冲击特征。",
        "- 新增：过去 5m/15m/30m/1h/2h/3h/5h/8h/12h/24h 的收益、区间、成交量、趋势效率和多尺度一致性。",
        "- 继承：分钟级有限合约链/期限结构、天气交易压力、数据质量分。",
        "- 仍保持电力模型式结构：1m/5m 当前时刻扫描，同时预测未来 15m/30m/1h/1.5h/2h/2.5h/3h。",
        "- 本版不接前向账本；只有盲测通过路线才允许进入后续 forward shadow。",
        f"- 策略总数：`{run_summary['route_count']}`；候选数：`{run_summary['candidate_count']}`；65%+目标数：`{run_summary['target65_count']}`。",
        "",
        "## 通过候选",
        "",
    ]
    if selected:
        lines.append("| 标的 | horizon组 | 验证命中/PF | 测试命中/PF | 活跃率 | 动作/天 | 加/减/反手 | 测试PNL | 回撤 |")
        lines.append("|---|---|---:|---:|---:|---:|---:|---:|---:|")
        for r in selected:
            lines.append(
                f"| {r['symbol']} | {r['horizon_set']} | "
                f"{float(r['validation_direction_hit_rate']):.2%}/{float(r['validation_profit_factor']):.2f} | "
                f"{float(r['test_direction_hit_rate']):.2%}/{float(r['test_profit_factor']):.2f} | "
                f"{float(r['test_active_signal_rate']):.2%} | {float(r['test_actions_per_day']):.2f} | "
                f"{int(r['test_add_actions'])}/{int(r['test_reduce_actions'])}/{int(r['test_reverse_actions'])} | "
                f"{float(r['test_net_pnl_usd']):.2f} | {float(r['test_max_drawdown_usd']):.2f} |"
            )
    else:
        lines.append("没有路线通过 V5.15 候选门。")
    lines += ["", "## 每个标的最优观察", ""]
    lines.append("| 标的 | horizon组 | 验证命中/PF | 测试命中/PF | 活跃率 | 动作/天 | 测试PNL | 状态 |")
    lines.append("|---|---|---:|---:|---:|---:|---:|---|")
    for r in best_rows:
        lines.append(
            f"| {r['symbol']} | {r['horizon_set']} | "
            f"{float(r['validation_direction_hit_rate']):.2%}/{float(r['validation_profit_factor']):.2f} | "
            f"{float(r['test_direction_hit_rate']):.2%}/{float(r['test_profit_factor']):.2f} | "
            f"{float(r['test_active_signal_rate']):.2%} | {float(r['test_actions_per_day']):.2f} | "
            f"{float(r['test_net_pnl_usd']):.2f} | {r['realtime_mh_status']} |"
        )
    lines += [
        "",
        "## 数据层审计",
        "",
        "- `coverage.csv` 记录每个有限合约链 leg、curve 合并结果、EIA/天气/NG 存储源覆盖状态。",
        "- V5.15 的“预期差”不是外部分析师 consensus；它是由发布前可交易价格、期限结构、成交量和 API 时间窗市场反应构造的 market-implied proxy。",
        "- 多尺度窗口只使用当前时刻以前的数据；长窗口用于背景判断，不代表降低扫描频率。",
        "- 若有限合约链或预期代理覆盖不足，相关特征会降低 `v513_data_quality_score` / `v514_expectation_data_quality`，不会伪造可交易期限结构或预期差。",
        "- 当前历史盲测没有使用未来天气预报，只记录可交易天气压力代理；真正 forecast feed 需要在 forward 阶段单独接入。",
        "",
        "## 下一步行动计划",
        "",
        "如果 V5.15 有路线通过候选门，下一步做 V5.16 只接通过路线的前向影子账本；如果没有通过，下一步应保留 V5.4/V5.6 强路线作为参考，补真实第三方库存预期/API 预期历史、完整连续期货链和可交易天气预报，不继续围绕阈值打转。",
    ]
    return "\n".join(lines) + "\n"


def make_figure(selected: list[dict[str, Any]], best_rows: list[dict[str, Any]], path: Path) -> None:
    rows = selected or best_rows
    if not rows:
        return
    labels = [f"{r['symbol']}\n{r['horizon_set']}" for r in rows]
    hit = [float(r.get("test_direction_hit_rate", 0.0)) for r in rows]
    pf = [min(float(r.get("test_profit_factor", 0.0)), 5.0) / 5.0 for r in rows]
    actions = [min(float(r.get("test_actions_per_day", 0.0)), 12.0) / 12.0 for r in rows]
    x = np.arange(len(labels))
    width = 0.25
    fig, ax = plt.subplots(figsize=(12, 5.5))
    ax.bar(x - width, hit, width, label="test hit rate")
    ax.bar(x, pf, width, label="PF/5 cap")
    ax.bar(x + width, actions, width, label="actions/day/12 cap")
    ax.axhline(0.65, color="tab:green", linestyle="--", linewidth=1, label="65% hit target")
    ax.set_ylim(0, 1)
    ax.set_xticks(x)
    ax.set_xticklabels(labels)
    ax.set_title("V5.15 realtime multi-scale lookback")
    ax.grid(axis="y", alpha=0.25)
    ax.legend()
    fig.tight_layout()
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=160)
    plt.close(fig)


def main() -> None:
    started = datetime.now(timezone.utc)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    v511.load_mode_features = load_mode_features_v513
    v511.feature_columns = feature_columns_v513
    v512.feature_columns_boost = feature_columns_v513
    v511.add_predictions = v512.add_predictions_boost
    v511.signal_state = signal_state_v513
    v511.desired_units = desired_units_v513
    v511.policy_grid = policy_grid_v513

    all_rows: list[dict[str, Any]] = []
    all_events: list[dict[str, Any]] = []
    all_summaries: list[dict[str, Any]] = []
    all_coverage: list[dict[str, Any]] = []
    sensor_meta_by_mode: dict[str, Any] = {}
    latest_signals: list[dict[str, Any]] = []

    for mode_cfg in v511.MODES:
        features, coverage, sensor_meta = v511.load_mode_features(mode_cfg)
        all_coverage.extend(coverage)
        sensor_meta_by_mode[str(mode_cfg["mode"])] = sensor_meta
        for symbol in TARGET_SYMBOLS:
            frame = features.get(symbol)
            if frame is None or frame.empty:
                all_coverage.append({"mode": mode_cfg["mode"], "symbol": symbol, "status": "missing_feature_frame"})
                continue
            rows, events, summaries, model_cov = v511.evaluate_symbol(frame, symbol, mode_cfg)
            all_rows.extend(rows)
            all_events.extend(events)
            all_summaries.extend(summaries)
            all_coverage.extend(model_cov)
            tail = v511.clean_for_model(frame, symbol).tail(1)
            if len(tail):
                latest_signals.append(
                    {
                        "mode": mode_cfg["mode"],
                        "symbol": symbol,
                        "timestamp": pd.Timestamp(tail.iloc[0]["timestamp"]).isoformat(),
                        "close": round(float(tail.iloc[0]["close"]), 6),
                        "rows": len(frame),
                        "v513_data_quality_score": round(float(tail.iloc[0].get("v513_data_quality_score", 0.0)), 6),
                    }
                )

    summary_df = pd.DataFrame(all_summaries)
    selected = select_routes(summary_df) if not summary_df.empty else []
    best = v511.best_by_symbol(summary_df) if not summary_df.empty else []
    target65_count = (
        int(
            (
                (summary_df.get("validation_direction_hit_rate", pd.Series(dtype=float)) >= 0.65)
                & (summary_df.get("test_direction_hit_rate", pd.Series(dtype=float)) >= 0.65)
                & (summary_df.get("validation_profit_factor", pd.Series(dtype=float)) >= 1.30)
                & (summary_df.get("test_profit_factor", pd.Series(dtype=float)) >= 1.30)
            ).sum()
        )
        if not summary_df.empty
        else 0
    )
    run_summary = {
        "version": VERSION,
        "generated_at": now_iso(),
        "status": "realtime_multiscale_lookback_candidates" if selected else "realtime_multiscale_lookback_watchlist_only",
        "route_count": int(len(summary_df)),
        "candidate_count": int(len(selected)),
        "target65_count": target65_count,
        "selected_policies": [r["policy"] for r in selected],
        "modes": v511.MODES,
        "prediction_horizons": HORIZON_LABELS,
        "runtime_sec": round((datetime.now(timezone.utc) - started).total_seconds(), 3),
        "latest_signal_readiness": latest_signals,
        "outputs": {
            "summary_json": str(OUT_DIR / "hfcd_commodity_v5_15_summary.json"),
            "policy_summary_csv": str(OUT_DIR / "hfcd_commodity_v5_15_policy_summary.csv"),
            "selected_routes_csv": str(OUT_DIR / "hfcd_commodity_v5_15_selected_routes.csv"),
            "best_by_symbol_csv": str(OUT_DIR / "hfcd_commodity_v5_15_best_by_symbol.csv"),
            "trade_replay_csv": str(OUT_DIR / "hfcd_commodity_v5_15_trade_replay.csv"),
            "action_events_csv": str(OUT_DIR / "hfcd_commodity_v5_15_action_events.csv"),
            "coverage_csv": str(OUT_DIR / "hfcd_commodity_v5_15_coverage.csv"),
            "report_md": str(OUT_DIR / "HFCD_Commodity_V5_15_RealtimeMultiScaleLookback.md"),
            "figure_png": str(OUT_DIR / "HFCD_Commodity_V5_15_RealtimeMultiScaleLookback.png"),
        },
        "sensor_meta_by_mode": sensor_meta_by_mode,
    }

    (OUT_DIR / "hfcd_commodity_v5_15_summary.json").write_text(json.dumps(run_summary, ensure_ascii=False, indent=2), encoding="utf-8")
    summary_df.to_csv(OUT_DIR / "hfcd_commodity_v5_15_policy_summary.csv", index=False)
    pd.DataFrame(selected).to_csv(OUT_DIR / "hfcd_commodity_v5_15_selected_routes.csv", index=False)
    pd.DataFrame(best).to_csv(OUT_DIR / "hfcd_commodity_v5_15_best_by_symbol.csv", index=False)
    v511.write_csv(OUT_DIR / "hfcd_commodity_v5_15_trade_replay.csv", all_rows)
    v511.write_csv(OUT_DIR / "hfcd_commodity_v5_15_action_events.csv", all_events)
    v511.write_csv(OUT_DIR / "hfcd_commodity_v5_15_coverage.csv", all_coverage)
    (OUT_DIR / "HFCD_Commodity_V5_15_RealtimeMultiScaleLookback.md").write_text(
        make_report(run_summary, selected, best), encoding="utf-8"
    )
    make_figure(selected, best, OUT_DIR / "HFCD_Commodity_V5_15_RealtimeMultiScaleLookback.png")
    print(json.dumps(run_summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
