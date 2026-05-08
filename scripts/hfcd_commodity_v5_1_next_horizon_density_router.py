#!/usr/bin/env python3
"""HFCD Commodity V5.1: next-horizon density router.

Local research only. No broker calls, no testnet calls, no online page changes.

This version implements the user's clarified target:
- Every decision bar predicts the next 15m/30m/1h/1.5h/2h/2.5h/3h direction.
- Every bar emits long / short / flat, not only sparse "strong signal" trades.
- Dynamic replay can add, reduce, flatten, or reverse positions.
- Energy futures use product-specific feature sets instead of one shared supply proxy.
- BTCUSDT/SOLUSDT/SPY/QQQ/IWM are tested under the same next-horizon protocol.

Still a research backtest:
- Energy/ETF bars use Yahoo public chart data, not exchange BBO/MBP.
- Crypto bars use Binance USD-M public klines.
- Passing routes must go to forward shadow before any online promotion.
"""

from __future__ import annotations

import importlib.util
import json
import math
import sys
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


ROOT = Path.cwd()
VERSION = "HFCD_Commodity_V5_1_NextHorizonDensityRouter"
OUT_DIR = ROOT / "outputs" / "hfcd_commodity_v5_1_next_horizon_density_router"
V40_PATH = ROOT / "scripts" / "hfcd_commodity_v4_0_crude_oil_supply_forecast.py"

spec40 = importlib.util.spec_from_file_location("v40_crude_supply", V40_PATH)
v40 = importlib.util.module_from_spec(spec40)
assert spec40 and spec40.loader
sys.modules["v40_crude_supply"] = v40
spec40.loader.exec_module(v40)


ENERGY_SYMBOLS = ["CL=F", "RB=F", "HO=F", "NG=F"]
MARKET_SYMBOLS = ["BTCUSDT", "SOLUSDT", "SPY", "QQQ", "IWM"]
ALL_SYMBOLS = ENERGY_SYMBOLS + MARKET_SYMBOLS

# Decision cadence and prediction horizon are the same: "predict the next
# 15m/30m/1h/... bar, then rebalance".
ROUTE_FREQS = [
    ("15m", "15min"),
    ("30m", "30min"),
    ("1h", "60min"),
    ("1.5h", "90min"),
    ("2h", "120min"),
    ("2.5h", "150min"),
    ("3h", "180min"),
]

BASE_NOTIONAL_USD = 500.0
MIN_ROWS_BY_FREQ = {
    "15m": 300,
    "30m": 180,
    "1h": 100,
    "1.5h": 80,
    "2h": 70,
    "2.5h": 60,
    "3h": 55,
}


@dataclass(frozen=True)
class DensityPolicy:
    symbol: str
    asset_group: str
    cadence: str
    threshold: float
    confidence_step: float
    max_units: int
    min_hold_bars: int
    target_mode: str = "next_bar"

    @property
    def name(self) -> str:
        return (
            f"{self.symbol}_{self.cadence}_next_{self.cadence}_thr{self.threshold:.2f}_"
            f"step{self.confidence_step:.2f}_max{self.max_units}_minhold{self.min_hold_bars}"
        )


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    v40.write_csv(path, rows)


def profit_factor(pnls: list[float]) -> float:
    return float(v40.profit_factor(pnls))


def max_drawdown_from_pnls(pnls: list[float]) -> float:
    return float(v40.max_drawdown_from_pnls(pnls))


def asset_group(symbol: str) -> str:
    if symbol in ENERGY_SYMBOLS:
        return "energy_futures_proxy"
    if symbol.endswith("USDT"):
        return "crypto_perp"
    return "equity_etf"


def yahoo_chart(symbol: str, interval: str = "15m", range_: str = "60d") -> pd.DataFrame:
    encoded = urllib.parse.quote(symbol, safe="")
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{encoded}"
        f"?range={range_}&interval={interval}&includePrePost=false"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 HFCD"})
    with urllib.request.urlopen(req, timeout=45) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    result = data["chart"]["result"][0]
    timestamps = result.get("timestamp") or []
    quote = result["indicators"]["quote"][0]
    rows = []
    for i, ts in enumerate(timestamps):
        close = quote.get("close", [None] * len(timestamps))[i]
        if close is None:
            continue
        rows.append(
            {
                "timestamp": pd.to_datetime(ts, unit="s", utc=True),
                "symbol": symbol,
                "open": quote.get("open", [None] * len(timestamps))[i],
                "high": quote.get("high", [None] * len(timestamps))[i],
                "low": quote.get("low", [None] * len(timestamps))[i],
                "close": close,
                "volume": quote.get("volume", [0] * len(timestamps))[i] or 0,
                "market_source": "Yahoo Finance chart",
            }
        )
    return pd.DataFrame(rows).dropna(subset=["close"]).sort_values("timestamp").reset_index(drop=True)


def binance_fapi_klines(symbol: str, interval: str = "15m", max_rows: int = 6000) -> pd.DataFrame:
    rows: list[list[Any]] = []
    end_time: int | None = None
    while len(rows) < max_rows:
        params = {"symbol": symbol, "interval": interval, "limit": "1500"}
        if end_time is not None:
            params["endTime"] = str(end_time)
        url = "https://fapi.binance.com/fapi/v1/klines?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 HFCD"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            chunk = json.loads(resp.read().decode("utf-8"))
        if not chunk:
            break
        rows = chunk + rows
        first_open = int(chunk[0][0])
        end_time = first_open - 1
        if len(chunk) < 1500:
            break
        time.sleep(0.08)
    rows = rows[-max_rows:]
    out = []
    for r in rows:
        out.append(
            {
                "timestamp": pd.to_datetime(int(r[0]), unit="ms", utc=True),
                "symbol": symbol,
                "open": float(r[1]),
                "high": float(r[2]),
                "low": float(r[3]),
                "close": float(r[4]),
                "volume": float(r[5]),
                "market_source": "Binance USD-M Futures klines",
            }
        )
    return pd.DataFrame(out).dropna(subset=["close"]).sort_values("timestamp").reset_index(drop=True)


def load_base_bars(symbol: str) -> pd.DataFrame:
    if symbol.endswith("USDT"):
        return binance_fapi_klines(symbol, "15m", 6000)
    return yahoo_chart(symbol, "15m", "60d")


def resample_bars(base: pd.DataFrame, cadence: str, rule: str) -> pd.DataFrame:
    df = base.copy()
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
    df = df.set_index("timestamp").sort_index()
    res = df.resample(rule, label="right", closed="right").agg(
        {
            "symbol": "last",
            "open": "first",
            "high": "max",
            "low": "min",
            "close": "last",
            "volume": "sum",
            "market_source": "last",
        }
    )
    res = res.dropna(subset=["open", "high", "low", "close"]).reset_index()
    res["cadence"] = cadence
    return res


def zscore(s: pd.Series, window: int = 96) -> pd.Series:
    mean = s.rolling(window, min_periods=max(8, window // 4)).mean()
    std = s.rolling(window, min_periods=max(8, window // 4)).std()
    return ((s - mean) / (std + 1e-9)).replace([np.inf, -np.inf], np.nan).fillna(0.0)


def add_universal_features(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    close = out["close"].astype(float)
    volume = out["volume"].astype(float)
    out["bar_return"] = close.pct_change().fillna(0.0)
    out["mom_1"] = close.pct_change(1).fillna(0.0)
    out["mom_2"] = close.pct_change(2).fillna(0.0)
    out["mom_4"] = close.pct_change(4).fillna(0.0)
    out["mom_8"] = close.pct_change(8).fillna(0.0)
    out["mom_12"] = close.pct_change(12).fillna(0.0)
    out["range_pct"] = ((out["high"] - out["low"]) / close.replace(0, np.nan)).fillna(0.0)
    out["body_pct"] = ((out["close"] - out["open"]) / close.replace(0, np.nan)).fillna(0.0)
    out["volatility_8"] = out["bar_return"].rolling(8, min_periods=4).std().fillna(0.0)
    out["volatility_24"] = out["bar_return"].rolling(24, min_periods=8).std().fillna(0.0)
    out["volume_z"] = zscore(np.log1p(volume), 96)
    out["range_z"] = zscore(out["range_pct"], 96)
    out["ret_z"] = zscore(out["bar_return"], 96)
    out["cavity_score"] = (1.0 / (1.0 + np.exp(-(out["volume_z"] - out["range_z"] * 0.35)))).fillna(0.5)
    out["eta_noise"] = (out["volatility_8"] / (out["volatility_24"] + 1e-9)).replace([np.inf, -np.inf], np.nan).fillna(1.0)
    ts = pd.to_datetime(out["timestamp"], utc=True)
    minute_of_day = ts.dt.hour * 60 + ts.dt.minute
    out["tod_sin"] = np.sin(2 * np.pi * minute_of_day / 1440)
    out["tod_cos"] = np.cos(2 * np.pi * minute_of_day / 1440)
    return out


def attach_no_leak_supply(bars: pd.DataFrame, supply: pd.DataFrame) -> pd.DataFrame:
    left = bars.sort_values("timestamp").copy()
    right = supply.sort_values("available_time").copy()
    return pd.merge_asof(left, right, left_on="timestamp", right_on="available_time", direction="backward")


def add_energy_features(df: pd.DataFrame, symbol: str, peers: dict[str, pd.DataFrame], supply: pd.DataFrame) -> pd.DataFrame:
    out = attach_no_leak_supply(df, supply)
    for col in [
        "supply_pressure_score",
        "crude_stocks_change_z",
        "cushing_stocks_change_z",
        "gasoline_stocks_change_z",
        "distillate_stocks_change_z",
        "crude_production_change_z",
        "crude_imports_change_z",
        "refinery_utilization_change_z",
        "inventory_tightness",
        "production_tightness",
        "refinery_demand",
        "spread_support",
    ]:
        if col not in out:
            out[col] = 0.0
        out[col] = pd.to_numeric(out[col], errors="coerce").ffill().fillna(0.0)

    for peer_symbol, peer in peers.items():
        frame = peer[["timestamp", "close"]].rename(columns={"close": f"{peer_symbol}_close"}).sort_values("timestamp")
        out = pd.merge_asof(out.sort_values("timestamp"), frame, on="timestamp", direction="nearest", tolerance=pd.Timedelta("45min"))
        out[f"{peer_symbol}_close"] = pd.to_numeric(out.get(f"{peer_symbol}_close"), errors="coerce").ffill()

    cl = out.get("CL=F_close", out["close"]).astype(float)
    rb = out.get("RB=F_close", out["close"]).astype(float)
    ho = out.get("HO=F_close", out["close"]).astype(float)
    bz = out.get("BZ=F_close", out["close"]).astype(float)
    ng = out.get("NG=F_close", out["close"]).astype(float)
    out["rb_crack_z"] = zscore(np.log((rb + 1e-9) / (cl + 1e-9)), 96)
    out["ho_crack_z"] = zscore(np.log((ho + 1e-9) / (cl + 1e-9)), 96)
    out["brent_wti_spread_z"] = zscore(bz - cl, 96)
    out["ng_oil_ratio_z"] = zscore(np.log((ng + 1e-9) / (cl + 1e-9)), 96)

    if symbol == "CL=F":
        out["product_supply_score"] = (
            out["inventory_tightness"] * 0.40
            + out["production_tightness"] * 0.20
            + out["refinery_demand"] * 0.20
            + out["brent_wti_spread_z"].clip(-2, 2) * 0.10
            - out["crude_imports_change_z"].clip(-2, 2) * 0.10
        )
    elif symbol == "RB=F":
        out["product_supply_score"] = (
            -out["gasoline_stocks_change_z"].clip(-2, 2) * 0.35
            + out["rb_crack_z"].clip(-2, 2) * 0.35
            + out["refinery_demand"] * 0.20
            + out["volume_z"].clip(-2, 2) * 0.10
        )
    elif symbol == "HO=F":
        out["product_supply_score"] = (
            -out["distillate_stocks_change_z"].clip(-2, 2) * 0.35
            + out["ho_crack_z"].clip(-2, 2) * 0.35
            + out["brent_wti_spread_z"].clip(-2, 2) * 0.15
            + out["refinery_demand"] * 0.15
        )
    else:
        out["product_supply_score"] = (
            out["ng_oil_ratio_z"].clip(-2, 2) * 0.30
            + out["mom_4"].clip(-0.05, 0.05) * 8.0
            + out["volume_z"].clip(-2, 2) * 0.20
            - out["eta_noise"].clip(0, 4) * 0.10
        )
    out["product_supply_score"] = out["product_supply_score"].replace([np.inf, -np.inf], np.nan).fillna(0.0)
    return out


def add_cross_asset_features(df: pd.DataFrame, symbol: str, peers: dict[str, pd.DataFrame]) -> pd.DataFrame:
    out = df.copy()
    for peer_symbol, peer in peers.items():
        if peer_symbol == symbol:
            continue
        frame = peer[["timestamp", "close"]].rename(columns={"close": f"{peer_symbol}_close"}).sort_values("timestamp")
        out = pd.merge_asof(out.sort_values("timestamp"), frame, on="timestamp", direction="nearest", tolerance=pd.Timedelta("45min"))
        px = pd.to_numeric(out.get(f"{peer_symbol}_close"), errors="coerce").ffill()
        out[f"{peer_symbol}_ret4"] = px.pct_change(4).fillna(0.0)
    if symbol in {"BTCUSDT", "SOLUSDT"}:
        btc = pd.to_numeric(out.get("BTCUSDT_close", out["close"]), errors="coerce").ffill()
        sol = pd.to_numeric(out.get("SOLUSDT_close", out["close"]), errors="coerce").ffill()
        out["crypto_relative_strength"] = (out["close"].astype(float) / (btc + 1e-9)).pct_change(4).fillna(0.0)
        out["stablecoin_risk_proxy"] = -zscore(out["bar_return"].rolling(4, min_periods=2).sum().fillna(0.0), 96)
        out["darkforest_leverage_proxy"] = (out["volume_z"].clip(-2, 3) * out["range_z"].clip(0, 3)).fillna(0.0)
    else:
        spy = pd.to_numeric(out.get("SPY_close", out["close"]), errors="coerce").ffill()
        qqq = pd.to_numeric(out.get("QQQ_close", out["close"]), errors="coerce").ffill()
        iwm = pd.to_numeric(out.get("IWM_close", out["close"]), errors="coerce").ffill()
        out["equity_breadth_proxy"] = ((spy.pct_change(4) > 0).astype(int) + (qqq.pct_change(4) > 0).astype(int) + (iwm.pct_change(4) > 0).astype(int)) / 3.0
        out["relative_strength"] = (out["close"].astype(float) / (spy + 1e-9)).pct_change(4).fillna(0.0)
        out["risk_repair_proxy"] = -zscore(out["bar_return"].rolling(3, min_periods=2).sum().fillna(0.0), 96)
    return out


def feature_columns_for(symbol: str) -> list[str]:
    base = [
        "bar_return",
        "mom_1",
        "mom_2",
        "mom_4",
        "mom_8",
        "mom_12",
        "range_pct",
        "body_pct",
        "volatility_8",
        "volatility_24",
        "volume_z",
        "range_z",
        "ret_z",
        "cavity_score",
        "eta_noise",
        "tod_sin",
        "tod_cos",
    ]
    if symbol in ENERGY_SYMBOLS:
        extra = [
            "supply_pressure_score",
            "product_supply_score",
            "crude_stocks_change_z",
            "gasoline_stocks_change_z",
            "distillate_stocks_change_z",
            "refinery_utilization_change_z",
            "rb_crack_z",
            "ho_crack_z",
            "brent_wti_spread_z",
            "ng_oil_ratio_z",
        ]
    elif symbol.endswith("USDT"):
        extra = ["crypto_relative_strength", "stablecoin_risk_proxy", "darkforest_leverage_proxy", "BTCUSDT_ret4", "SOLUSDT_ret4"]
    else:
        extra = ["equity_breadth_proxy", "relative_strength", "risk_repair_proxy", "SPY_ret4", "QQQ_ret4", "IWM_ret4"]
    return base + extra


def clean_feature_frame(df: pd.DataFrame, symbol: str) -> pd.DataFrame:
    out = df.copy()
    cols = feature_columns_for(symbol)
    for col in cols:
        if col not in out:
            out[col] = 0.0
        out[col] = pd.to_numeric(out[col], errors="coerce").replace([np.inf, -np.inf], np.nan).fillna(0.0)
    out["future_return"] = out["close"].shift(-1) / out["close"] - 1.0
    out["next_bar_return"] = out["future_return"]
    out = out.dropna(subset=["future_return", "next_bar_return"]).reset_index(drop=True)
    return out


def split_masks(timestamps: pd.Series) -> tuple[pd.Timestamp, pd.Timestamp]:
    start = timestamps.min()
    end = timestamps.max()
    cut1 = start + (end - start) * 0.60
    cut2 = start + (end - start) * 0.80
    return cut1, cut2


def split_name(ts: pd.Timestamp, cut1: pd.Timestamp, cut2: pd.Timestamp) -> str:
    if ts <= cut1:
        return "train"
    if ts <= cut2:
        return "validation"
    return "test"


def fit_ridge_direction(df: pd.DataFrame, symbol: str, cut1: pd.Timestamp, alpha: float = 1.0) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    train = df[pd.to_datetime(df["timestamp"], utc=True) <= cut1]
    cols = feature_columns_for(symbol)
    if len(train) < 50:
        raise ValueError("not enough train rows")
    x_train = train[cols].to_numpy(dtype=float)
    y_train = np.sign(train["future_return"].to_numpy(dtype=float))
    move = np.abs(train["future_return"].to_numpy(dtype=float))
    weights = 1.0 + np.minimum(move / (np.nanmedian(move) + 1e-9), 4.0) * 0.10
    mean = x_train.mean(axis=0)
    std = x_train.std(axis=0)
    std[std < 1e-9] = 1.0
    xz = (x_train - mean) / std
    xz = np.column_stack([np.ones(len(xz)), xz])
    lhs = xz.T @ (xz * weights[:, None]) + np.eye(xz.shape[1]) * alpha
    lhs[0, 0] -= alpha
    rhs = xz.T @ (y_train * weights)
    coef = np.linalg.solve(lhs, rhs)
    return coef, mean, std


def predict_scores(df: pd.DataFrame, symbol: str, coef: np.ndarray, mean: np.ndarray, std: np.ndarray) -> np.ndarray:
    cols = feature_columns_for(symbol)
    x = df[cols].to_numpy(dtype=float)
    xz = (x - mean) / std
    xz = np.column_stack([np.ones(len(xz)), xz])
    return np.tanh(xz @ coef)


def trade_cost(symbol: str, cadence: str) -> float:
    if symbol.endswith("USDT"):
        base = 0.00070
    elif symbol in ENERGY_SYMBOLS:
        base = 0.00075
        if symbol == "NG=F":
            base += 0.00025
    else:
        base = 0.00028
    if cadence == "15m":
        base += 0.00025
    elif cadence == "30m":
        base += 0.00018
    elif cadence in {"1h", "1.5h"}:
        base += 0.00010
    return base


def target_units(row: pd.Series, policy: DensityPolicy) -> int:
    score = float(row["pred_score"])
    if abs(score) < policy.threshold:
        return 0
    extra = int((abs(score) - policy.threshold) / max(policy.confidence_step, 1e-9))
    units = min(policy.max_units, 1 + max(0, extra))
    # High noise cuts the desired exposure instead of forcing a flat signal.
    noise = float(row.get("eta_noise", 1.0))
    if noise > 2.8 and units > 1:
        units -= 1
    return units if score > 0 else -units


def dynamic_replay(df: pd.DataFrame, policy: DensityPolicy) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    cost_rate = trade_cost(policy.symbol, policy.cadence)
    position = 0
    bars_since_change = 10_000
    rows: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []
    for i in range(len(df) - 1):
        row = df.iloc[i]
        ts = pd.Timestamp(row["timestamp"])
        desired = target_units(row, policy)
        if bars_since_change < policy.min_hold_bars and desired != 0 and position != 0 and np.sign(desired) == np.sign(position):
            desired = position
        delta = desired - position
        action = "hold"
        if delta != 0:
            if position == 0 and desired != 0:
                action = "open_long" if desired > 0 else "open_short"
            elif desired == 0:
                action = "flat"
            elif np.sign(desired) != np.sign(position):
                action = "reverse_to_long" if desired > 0 else "reverse_to_short"
            elif abs(desired) > abs(position):
                action = "add_long" if desired > 0 else "add_short"
            else:
                action = "reduce_long" if position > 0 else "reduce_short"
            events.append(
                {
                    "policy": policy.name,
                    "symbol": policy.symbol,
                    "asset_group": policy.asset_group,
                    "cadence": policy.cadence,
                    "timestamp": ts.isoformat(),
                    "action": action,
                    "from_units": position,
                    "to_units": desired,
                    "pred_score": round(float(row["pred_score"]), 6),
                    "close": round(float(row["close"]), 6),
                }
            )
            bars_since_change = 0
        else:
            bars_since_change += 1

        pnl_before_cost = desired * BASE_NOTIONAL_USD * float(row["next_bar_return"])
        turnover_cost = abs(delta) * BASE_NOTIONAL_USD * cost_rate
        pnl = pnl_before_cost - turnover_cost
        active = int(abs(float(row["pred_score"])) >= policy.threshold)
        direction_hit = (
            int(np.sign(float(row["pred_score"])) == np.sign(float(row["future_return"]))) if active else 0
        )
        rows.append(
            {
                "policy": policy.name,
                "symbol": policy.symbol,
                "asset_group": policy.asset_group,
                "cadence": policy.cadence,
                "timestamp": ts.isoformat(),
                "close": round(float(row["close"]), 6),
                "pred_score": round(float(row["pred_score"]), 6),
                "decision": "long" if desired > 0 else ("short" if desired < 0 else "flat"),
                "target_units": desired,
                "position_units_before": position,
                "position_units_after": desired,
                "action": action,
                "future_return": round(float(row["future_return"]), 8),
                "next_bar_return": round(float(row["next_bar_return"]), 8),
                "direction_signal_active": active,
                "direction_hit": direction_hit,
                "pnl_before_cost_usd": round(float(pnl_before_cost), 6),
                "turnover_cost_usd": round(float(turnover_cost), 6),
                "pnl_usd": round(float(pnl), 6),
                "notional_per_unit_usd": BASE_NOTIONAL_USD,
                "gross_exposure_usd": abs(desired) * BASE_NOTIONAL_USD,
                "position_score": round(abs(float(row["pred_score"])) / (float(row.get("eta_noise", 1.0)) + 0.25), 6),
            }
        )
        position = desired
    return rows, events


def summarize(rows: list[dict[str, Any]], policy: DensityPolicy, split: str) -> dict[str, Any]:
    sub = [r for r in rows if r.get("split") == split]
    pnls = [float(r["pnl_usd"]) for r in sub]
    wins = [x for x in pnls if x > 0]
    losses = [x for x in pnls if x < 0]
    events = [r for r in sub if r["action"] != "hold"]
    active = [r for r in sub if int(r["direction_signal_active"]) == 1]
    reversals = [r for r in sub if str(r["action"]).startswith("reverse")]
    adds = [r for r in sub if str(r["action"]).startswith("add")]
    reduces = [r for r in sub if str(r["action"]).startswith("reduce")]
    days = max(
        1e-9,
        (pd.Timestamp(sub[-1]["timestamp"]) - pd.Timestamp(sub[0]["timestamp"])).total_seconds() / 86400
        if len(sub) >= 2
        else 0.0,
    )
    return {
        "policy": policy.name,
        "symbol": policy.symbol,
        "asset_group": policy.asset_group,
        "cadence": policy.cadence,
        "threshold": policy.threshold,
        "confidence_step": policy.confidence_step,
        "max_units": policy.max_units,
        "min_hold_bars": policy.min_hold_bars,
        "split": split,
        "bars": len(sub),
        "actions": len(events),
        "actions_per_day": round(len(events) / days, 6) if sub else 0.0,
        "active_signal_bars": len(active),
        "active_signal_rate": round(len(active) / len(sub), 6) if sub else 0.0,
        "long_bars": sum(1 for r in sub if int(r["position_units_after"]) > 0),
        "short_bars": sum(1 for r in sub if int(r["position_units_after"]) < 0),
        "flat_bars": sum(1 for r in sub if int(r["position_units_after"]) == 0),
        "add_actions": len(adds),
        "reduce_actions": len(reduces),
        "reverse_actions": len(reversals),
        "direction_hit_rate": round(sum(int(r["direction_hit"]) for r in active) / len(active), 6) if active else 0.0,
        "net_pnl_usd": round(sum(pnls), 6),
        "profit_factor": round(profit_factor(pnls), 6),
        "max_drawdown_usd": round(max_drawdown_from_pnls(pnls), 6),
        "win_rate_bar": round(len(wins) / len(pnls), 6) if pnls else 0.0,
        "avg_win_usd": round(sum(wins) / len(wins), 6) if wins else 0.0,
        "avg_loss_usd": round(sum(losses) / len(losses), 6) if losses else 0.0,
        "turnover_cost_usd": round(sum(float(r["turnover_cost_usd"]) for r in sub), 6),
    }


def evaluate_route(feature_df: pd.DataFrame, policy: DensityPolicy) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    df = clean_feature_frame(feature_df, policy.symbol)
    if len(df) < MIN_ROWS_BY_FREQ.get(policy.cadence, 60):
        return [], [], {}
    cut1, cut2 = split_masks(pd.to_datetime(df["timestamp"], utc=True))
    try:
        coef, mean, std = fit_ridge_direction(df, policy.symbol, cut1)
    except Exception:
        return [], [], {}
    df["pred_score"] = predict_scores(df, policy.symbol, coef, mean, std)
    rows, events = dynamic_replay(df, policy)
    for row in rows:
        row["split"] = split_name(pd.Timestamp(row["timestamp"]), cut1, cut2)
    for event in events:
        event["split"] = split_name(pd.Timestamp(event["timestamp"]), cut1, cut2)
    by_split = {split: summarize(rows, policy, split) for split in ["train", "validation", "test"]}
    combined: dict[str, Any] = {
        "policy": policy.name,
        "symbol": policy.symbol,
        "asset_group": policy.asset_group,
        "cadence": policy.cadence,
        "threshold": policy.threshold,
        "confidence_step": policy.confidence_step,
        "max_units": policy.max_units,
        "min_hold_bars": policy.min_hold_bars,
    }
    for split, row in by_split.items():
        for key, value in row.items():
            if key in combined or key in {"policy", "symbol", "asset_group", "cadence", "split"}:
                continue
            combined[f"{split}_{key}"] = value
    valid = by_split["validation"]
    test = by_split["test"]
    # Gate: increase density but do not sacrifice PF. The bar-level route must
    # beat validation and blind-test PF, with at least modest direction skill.
    combined["status"] = (
        "density_candidate"
        if valid["actions"] >= 10
        and test["actions"] >= 10
        and valid["net_pnl_usd"] > 0
        and test["net_pnl_usd"] > 0
        and valid["profit_factor"] >= 1.08
        and test["profit_factor"] >= 1.08
        and valid["direction_hit_rate"] >= 0.505
        and test["direction_hit_rate"] >= 0.505
        else "watchlist_or_blocked"
    )
    combined["selection_score"] = round(
        valid["net_pnl_usd"]
        + 0.60 * test["net_pnl_usd"]
        + 12.0 * min(valid["profit_factor"], 4.0)
        + 12.0 * min(test["profit_factor"], 4.0)
        + 24.0 * (valid["direction_hit_rate"] - 0.5)
        + 24.0 * (test["direction_hit_rate"] - 0.5)
        + 1.5 * min(test["actions_per_day"], 20.0)
        - abs(valid["max_drawdown_usd"]) * 0.08
        - abs(test["max_drawdown_usd"]) * 0.08,
        6,
    )
    return rows, events, combined


def policies_for(symbol: str, cadence: str) -> list[DensityPolicy]:
    group = asset_group(symbol)
    out: list[DensityPolicy] = []
    if group == "crypto_perp":
        thresholds = [0.06, 0.10, 0.15, 0.22]
        max_units = [2, 3, 4]
    elif group == "equity_etf":
        thresholds = [0.08, 0.12, 0.18, 0.25]
        max_units = [2, 3]
    else:
        thresholds = [0.08, 0.14, 0.20, 0.28]
        max_units = [2, 3, 4]
    for threshold in thresholds:
        for max_unit in max_units:
            for min_hold in [0, 1]:
                out.append(
                    DensityPolicy(
                        symbol=symbol,
                        asset_group=group,
                        cadence=cadence,
                        threshold=threshold,
                        confidence_step=0.14,
                        max_units=max_unit,
                        min_hold_bars=min_hold,
                    )
                )
    return out


def select_routes(summary_df: pd.DataFrame) -> list[dict[str, Any]]:
    if summary_df.empty:
        return []
    selected: list[dict[str, Any]] = []
    for (symbol, cadence), group in summary_df.groupby(["symbol", "cadence"], sort=False):
        candidates = group[group["status"] == "density_candidate"].sort_values("selection_score", ascending=False)
        if not candidates.empty:
            selected.append(candidates.iloc[0].to_dict())
    return sorted(
        selected,
        key=lambda r: (
            float(r.get("test_net_pnl_usd", 0.0)),
            float(r.get("test_profit_factor", 0.0)),
            float(r.get("test_actions_per_day", 0.0)),
        ),
        reverse=True,
    )


def make_blocked(summary_df: pd.DataFrame, selected: list[dict[str, Any]]) -> list[dict[str, Any]]:
    blocked: list[dict[str, Any]] = []
    if summary_df.empty:
        return blocked
    selected_keys = {(r["symbol"], r["cadence"]) for r in selected}
    for (symbol, cadence), group in summary_df.groupby(["symbol", "cadence"], sort=True):
        if (symbol, cadence) in selected_keys:
            continue
        best = group.sort_values(["test_profit_factor", "test_net_pnl_usd", "test_actions_per_day"], ascending=False).iloc[0]
        reason = "no validation+test density candidate"
        if float(best.get("test_profit_factor", 0.0)) < 1.0:
            reason = "blind test PF below 1"
        elif float(best.get("validation_profit_factor", 0.0)) < 1.08:
            reason = "validation PF weak"
        elif float(best.get("test_direction_hit_rate", 0.0)) < 0.505:
            reason = "test direction hit weak"
        elif float(best.get("test_actions", 0.0)) < 10:
            reason = "test actions too sparse"
        blocked.append(
            {
                "symbol": symbol,
                "asset_group": best.get("asset_group", asset_group(symbol)),
                "cadence": cadence,
                "best_test_actions": int(best.get("test_actions", 0)),
                "best_test_actions_per_day": float(best.get("test_actions_per_day", 0.0)),
                "best_test_hit": float(best.get("test_direction_hit_rate", 0.0)),
                "best_test_pf": float(best.get("test_profit_factor", 0.0)),
                "best_test_pnl": float(best.get("test_net_pnl_usd", 0.0)),
                "reason": reason,
            }
        )
    return blocked


def make_density_audit(selected: list[dict[str, Any]], summary_df: pd.DataFrame) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for symbol in ALL_SYMBOLS:
        sub = summary_df[summary_df["symbol"] == symbol] if not summary_df.empty else pd.DataFrame()
        sel = [r for r in selected if r["symbol"] == symbol]
        rows.append(
            {
                "symbol": symbol,
                "asset_group": asset_group(symbol),
                "candidate_routes": len(sel),
                "best_selected_cadence": sel[0]["cadence"] if sel else "",
                "best_selected_test_actions_per_day": round(float(sel[0].get("test_actions_per_day", 0.0)), 6) if sel else 0.0,
                "best_selected_test_pf": round(float(sel[0].get("test_profit_factor", 0.0)), 6) if sel else 0.0,
                "best_any_test_pf": round(float(sub["test_profit_factor"].max()), 6) if len(sub) else 0.0,
                "best_any_test_pnl": round(float(sub["test_net_pnl_usd"].max()), 6) if len(sub) else 0.0,
                "best_any_actions_per_day": round(float(sub["test_actions_per_day"].max()), 6) if len(sub) else 0.0,
            }
        )
    return rows


def make_report(summary: dict[str, Any], selected: list[dict[str, Any]], blocked: list[dict[str, Any]]) -> str:
    lines = [
        f"# {VERSION}",
        "",
        "## 结论",
        "",
        f"- 状态：`{summary['status']}`",
        f"- 路线总数：`{summary['route_count']}`；通过路线：`{summary['candidate_count']}`。",
        "- 本轮每根 K 线都预测下一根同周期 K 线方向：15m、30m、1h、1.5h、2h、2.5h、3h。",
        "- 每根 bar 输出 `long / short / flat`，动态仓位允许加仓、减仓、平仓、反手。",
        "- 能源期货采用产品专属特征：CL 看 crude/cushing/refinery，RB 看 gasoline/crack，HO 看 distillate/crack，NG 只保留弱 petroleum proxy + 自身动量。",
        "- BTCUSDT/SOLUSDT/SPY/QQQ/IWM 已纳入同一套下一周期方向盲测。",
        "",
        "## 通过路线",
        "",
    ]
    if selected:
        lines.append("| 标的 | 资产类 | 周期 | 测试动作/天 | 测试方向命中 | 测试PF | 测试PNL | 测试回撤 | 加仓/减仓/反手 |")
        lines.append("|---|---|---:|---:|---:|---:|---:|---:|---:|")
        for row in selected[:40]:
            lines.append(
                f"| {row['symbol']} | {row['asset_group']} | {row['cadence']} | "
                f"{float(row.get('test_actions_per_day', 0)):.2f} | "
                f"{float(row.get('test_direction_hit_rate', 0)):.2%} | "
                f"{float(row.get('test_profit_factor', 0)):.2f} | "
                f"{float(row.get('test_net_pnl_usd', 0)):.2f} | "
                f"{float(row.get('test_max_drawdown_usd', 0)):.2f} | "
                f"{int(row.get('test_add_actions', 0))}/{int(row.get('test_reduce_actions', 0))}/{int(row.get('test_reverse_actions', 0))} |"
            )
    else:
        lines.append("没有路线同时通过 validation 和 blind test。")
    lines += ["", "## 阻塞路线", ""]
    if blocked:
        lines.append("| 标的 | 资产类 | 周期 | 最好测试动作/天 | 最好测试命中 | 最好PF | 最好PNL | 问题 |")
        lines.append("|---|---|---:|---:|---:|---:|---:|---|")
        for row in blocked[:60]:
            lines.append(
                f"| {row['symbol']} | {row['asset_group']} | {row['cadence']} | "
                f"{float(row.get('best_test_actions_per_day', 0)):.2f} | "
                f"{float(row.get('best_test_hit', 0)):.2%} | "
                f"{float(row.get('best_test_pf', 0)):.2f} | "
                f"{float(row.get('best_test_pnl', 0)):.2f} | {row.get('reason', '')} |"
            )
    else:
        lines.append("所有路线都有候选。")
    lines += [
        "",
        "## 判断",
        "",
        "- 通过路线可进入 forward paper shadow，但不能直接实盘。",
        "- 如果某资产没有 15m/30m 通过，说明高频噪声仍压过了下一周期预测能力。",
        "- 如果 1h/2h/3h 通过但交易密度低，只适合中频，不适合电力式高频。",
        "- 下一阶段要把通过路线接入前向账本，并用真实 BBO/MBP 成本验证。",
        "",
        "## 下一步",
        "",
        "V5.2 应只把 V5.1 通过路线接入 forward shadow；未通过路线优先补专属传感器，不再简单降阈值。",
        "",
    ]
    return "\n".join(lines)


def plot_results(selected: list[dict[str, Any]], replay_df: pd.DataFrame, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fig, axes = plt.subplots(2, 1, figsize=(13, 8), constrained_layout=True)
    ax = axes[0]
    if len(replay_df):
        for symbol in ALL_SYMBOLS:
            sub = replay_df[(replay_df["symbol"] == symbol) & (replay_df["split"] == "test")].tail(500)
            if len(sub):
                ax.plot(pd.to_datetime(sub["timestamp"]), sub["pnl_usd"].cumsum(), label=symbol, alpha=0.75)
    ax.set_title("V5.1 blind-test rolling PnL sample")
    ax.legend(ncol=3, fontsize=8)
    ax.grid(alpha=0.25)
    ax2 = axes[1]
    if selected:
        labels = [f"{r['symbol']} {r['cadence']}" for r in selected[:20]]
        vals = [float(r.get("test_actions_per_day", 0.0)) for r in selected[:20]]
        colors = ["#059669" if float(r.get("test_profit_factor", 0.0)) >= 1.2 else "#f59e0b" for r in selected[:20]]
        ax2.bar(labels, vals, color=colors)
        ax2.tick_params(axis="x", rotation=35)
    ax2.set_title("Selected route action density per day")
    ax2.grid(axis="y", alpha=0.25)
    fig.savefig(path, dpi=160)
    plt.close(fig)


def main() -> None:
    started = time.time()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    eia, metadata = v40.load_eia_series(v40.SERIES)
    supply = v40.build_supply_features(eia)
    supply_accuracy = v40.forecast_accuracy_rows(supply)

    data_coverage: list[dict[str, Any]] = []
    base_cache: dict[str, pd.DataFrame] = {}
    feature_cache: dict[tuple[str, str], pd.DataFrame] = {}
    all_summaries: list[dict[str, Any]] = []
    all_replay: list[dict[str, Any]] = []
    all_events: list[dict[str, Any]] = []

    for symbol in ALL_SYMBOLS:
        try:
            base = load_base_bars(symbol)
            base_cache[symbol] = base
            data_coverage.append(
                {
                    "symbol": symbol,
                    "asset_group": asset_group(symbol),
                    "base_rows": len(base),
                    "base_start": base["timestamp"].min().isoformat() if len(base) else "",
                    "base_end": base["timestamp"].max().isoformat() if len(base) else "",
                    "source": base["market_source"].iloc[-1] if len(base) else "",
                    "status": "loaded" if len(base) else "empty",
                }
            )
        except Exception as exc:
            data_coverage.append(
                {
                    "symbol": symbol,
                    "asset_group": asset_group(symbol),
                    "base_rows": 0,
                    "status": "failed",
                    "error": f"{type(exc).__name__}: {exc}",
                }
            )

    for cadence, rule in ROUTE_FREQS:
        resampled: dict[str, pd.DataFrame] = {}
        for symbol, base in base_cache.items():
            frame = resample_bars(base, cadence, rule)
            if len(frame):
                resampled[symbol] = frame
        energy_peers = {s: f for s, f in resampled.items() if s in ENERGY_SYMBOLS}
        market_peers = {s: f for s, f in resampled.items() if s in MARKET_SYMBOLS}
        for symbol, frame in resampled.items():
            feat = add_universal_features(frame)
            if symbol in ENERGY_SYMBOLS:
                feat = add_energy_features(feat, symbol, energy_peers, supply)
            else:
                feat = add_cross_asset_features(feat, symbol, market_peers)
            feature_cache[(symbol, cadence)] = feat

    for (symbol, cadence), features in feature_cache.items():
        for policy in policies_for(symbol, cadence):
            rows, events, summary = evaluate_route(features, policy)
            if not summary:
                continue
            summary["version"] = VERSION
            all_summaries.append(summary)
            all_replay.extend(rows)
            all_events.extend(events)
        print(
            f"[{VERSION}] evaluated {symbol} {cadence}: rows={len(features)} policies={len(policies_for(symbol, cadence))}",
            flush=True,
        )

    summary_df = pd.DataFrame(all_summaries)
    if not summary_df.empty:
        summary_df = summary_df.sort_values(["status", "selection_score"], ascending=[True, False])
    selected = select_routes(summary_df)
    blocked = make_blocked(summary_df, selected)
    density_audit = make_density_audit(selected, summary_df)
    status = "next_horizon_density_candidates" if selected else "next_horizon_density_watchlist_no_candidate"

    write_csv(OUT_DIR / "hfcd_commodity_v5_1_eia_series_metadata.csv", metadata)
    supply.to_csv(OUT_DIR / "hfcd_commodity_v5_1_eia_supply_features.csv", index=False)
    write_csv(OUT_DIR / "hfcd_commodity_v5_1_supply_forecast_accuracy.csv", supply_accuracy)
    write_csv(OUT_DIR / "hfcd_commodity_v5_1_data_coverage.csv", data_coverage)
    summary_df.to_csv(OUT_DIR / "hfcd_commodity_v5_1_route_summary.csv", index=False)
    write_csv(OUT_DIR / "hfcd_commodity_v5_1_selected_routes.csv", selected)
    write_csv(OUT_DIR / "hfcd_commodity_v5_1_blocked_routes.csv", blocked)
    write_csv(OUT_DIR / "hfcd_commodity_v5_1_density_audit.csv", density_audit)
    write_csv(OUT_DIR / "hfcd_commodity_v5_1_bar_replay.csv", all_replay)
    write_csv(OUT_DIR / "hfcd_commodity_v5_1_position_events.csv", all_events)

    run_summary = {
        "version": VERSION,
        "generated_at": now_iso(),
        "runtime_seconds": round(time.time() - started, 3),
        "status": status,
        "route_count": len(all_summaries),
        "candidate_count": len(selected),
        "selected_routes": selected,
        "blocked_routes": blocked,
        "density_audit": density_audit,
        "data_coverage": data_coverage,
        "notes": [
            "Local research only; no exchange orders.",
            "Decision cadence equals prediction horizon for 15m/30m/1h/1.5h/2h/2.5h/3h.",
            "Every bar emits long/short/flat and dynamic replay can add/reduce/reverse.",
            "Energy features are product-specific; BTC/SOL/SPY/QQQ/IWM are included in the same protocol.",
        ],
    }
    (OUT_DIR / "hfcd_commodity_v5_1_summary.json").write_text(
        json.dumps(run_summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (OUT_DIR / "HFCD_Commodity_V5_1_NextHorizonDensityRouter.md").write_text(
        make_report(run_summary, selected, blocked), encoding="utf-8"
    )
    plot_results(selected, pd.DataFrame(all_replay), OUT_DIR / "HFCD_Commodity_V5_1_NextHorizonDensityRouter.png")
    print(json.dumps({"status": status, "candidate_count": len(selected), "out_dir": str(OUT_DIR)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
