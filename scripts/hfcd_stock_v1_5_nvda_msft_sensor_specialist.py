#!/usr/bin/env python3
"""HFCD Stock V1.5: NVDA/MSFT specialist sensor blind test.

Offline research only. This script does not touch Worker/D1, online pages,
broker APIs, or real orders.

Scope:
- NVDA and MSFT.
- 15m, 30m, 1h, 2h, 3h.
- long_only and short_only are tested separately.

New versus V1.4:
- Adds stock-specific proxy sensors for earnings/event shocks, macro shock,
  options-gamma/OI pressure, and sector flow.
- Keeps those fields explicitly labeled as proxy-only. They are useful for
  blind-test filtering, but are not a substitute for real earnings calendar,
  macro calendar, or OPRA/options-chain data.
"""

from __future__ import annotations

import csv
import json
import math
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

import hfcd_stock_v1_0_directional_edge_blind as v10
import hfcd_stock_v1_2_direction_sensor_upgrade as v12
import hfcd_stock_v1_4_bigtech_long_short_blind as v14


VERSION = "HFCD_Stock_V1_5_NVDA_MSFT_SensorSpecialist"
ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "outputs" / "hfcd_stock_v1_5_nvda_msft_sensor_specialist"
RAW_DIR = OUT_DIR / "raw_yahoo_chart"

TARGET_SYMBOLS = ["NVDA", "MSFT"]
SENSOR_SYMBOLS = ["SPY", "QQQ", "^VIX", "SOXX", "XLK"]
CADENCES = ["15m", "30m", "1h", "2h", "3h"]
SIDE_POLICIES = ["long_only", "short_only"]
NOTIONAL_USD = 1000.0

SPECIALIST_FEATURES = [
    "idiosyncratic_ret_1",
    "idiosyncratic_ret_4",
    "earnings_gap_proxy",
    "earnings_drift_proxy",
    "macro_calendar_proxy",
    "gamma_oi_pressure_proxy",
    "sector_flow_long_proxy",
    "sector_flow_short_proxy",
    "large_cap_beta_proxy",
    "event_direction_long_proxy",
    "event_direction_short_proxy",
    "liquidity_stress_proxy",
]
FEATURES = list(dict.fromkeys(v12.FEATURES + SPECIALIST_FEATURES))


@dataclass(frozen=True)
class Policy:
    symbol: str
    cadence: str
    side_policy: str
    score_floor: float
    edge_floor: float
    hold_bars: int
    stop_atr: float
    take_atr: float
    min_cavity: float
    min_eta_health: float
    max_event_risk: float
    min_gamma_health: float
    session_policy: str

    @property
    def name(self) -> str:
        return (
            f"{self.symbol}_{self.cadence}_{self.side_policy}_"
            f"score{self.score_floor:.2f}_edge{self.edge_floor:.4f}_"
            f"hold{self.hold_bars}_sl{self.stop_atr:.1f}_tp{self.take_atr:.1f}_"
            f"event{self.max_event_risk:.2f}_gamma{self.min_gamma_health:.2f}_{self.session_policy}"
        )


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def n(value: Any, digits: int = 6) -> float:
    return v10.n(value, digits)


def sigmoid_series(x: pd.Series) -> pd.Series:
    arr = pd.to_numeric(x, errors="coerce").replace([np.inf, -np.inf], 0.0).fillna(0.0).to_numpy(dtype=float)
    arr = np.clip(arr, -60.0, 60.0)
    return pd.Series(1.0 / (1.0 + np.exp(-arr)), index=x.index)


def write_csv(path: Path, rows: list[dict[str, Any]], headers: list[str] | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = headers or sorted({key for row in rows for key in row.keys()})
    if not fields:
        path.write_text("", encoding="utf-8")
        return
    priority = ["symbol", "cadence", "side_policy", "policy_name", "split", "entry_ts", "signal_ts"]
    fields = [x for x in priority if x in fields] + [x for x in fields if x not in priority]
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def fetch_yahoo_15m(symbol: str) -> pd.DataFrame:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    old_raw_dir = v12.RAW_DIR
    try:
        v12.RAW_DIR = RAW_DIR
        return v12.fetch_yahoo_15m(symbol)
    finally:
        v12.RAW_DIR = old_raw_dir


def safe_enrich(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    if out["volume"].fillna(0).sum() <= 0:
        out["volume"] = 1.0
    return v10.enrich(out)


def build_base_datasets(coverage: list[dict[str, Any]]) -> dict[tuple[str, str], pd.DataFrame]:
    symbols = sorted(set(TARGET_SYMBOLS + SENSOR_SYMBOLS))
    base: dict[str, pd.DataFrame] = {}
    for symbol in symbols:
        try:
            df = fetch_yahoo_15m(symbol)
            base[symbol] = df
            coverage.append(
                {
                    "symbol": symbol,
                    "source": "yahoo_chart_15m",
                    "rows": len(df),
                    "first_ts": df["timestamp"].min().isoformat() if len(df) else "",
                    "last_ts": df["timestamp"].max().isoformat() if len(df) else "",
                    "status": "ok" if len(df) >= 300 else "coverage_low",
                    "data_mode": "real_public_yahoo_chart",
                }
            )
        except Exception as exc:
            coverage.append({"symbol": symbol, "source": "yahoo_chart_15m", "rows": 0, "status": f"error:{exc}"})

    datasets: dict[tuple[str, str], pd.DataFrame] = {}
    for symbol, df in base.items():
        for cadence in CADENCES:
            try:
                out = safe_enrich(v10.resample_ohlcv(df, cadence))
                datasets[(symbol, cadence)] = out
                coverage.append(
                    {
                        "symbol": symbol,
                        "cadence": cadence,
                        "source": "yahoo_chart_15m_resampled",
                        "rows": len(out),
                        "first_ts": out["timestamp"].min().isoformat() if len(out) else "",
                        "last_ts": out["timestamp"].max().isoformat() if len(out) else "",
                        "status": "ok" if len(out) >= 90 else "coverage_low",
                        "data_mode": "real_public_yahoo_chart_resampled",
                    }
                )
            except Exception as exc:
                coverage.append({"symbol": symbol, "cadence": cadence, "source": "resample_enrich", "rows": 0, "status": f"error:{exc}"})

    for proxy_name in ["earnings_calendar", "cpi_fomc_calendar", "options_gamma_oi"]:
        coverage.append(
            {
                "symbol": "GLOBAL",
                "source": proxy_name,
                "rows": 0,
                "status": "proxy_only_not_true_feed",
                "data_mode": "derived_from_price_volume_vix_sector_not_promotable_as_true_sensor",
            }
        )
    return datasets


def add_specialist_features(df: pd.DataFrame, symbol: str, cadence: str, datasets: dict[tuple[str, str], pd.DataFrame]) -> pd.DataFrame:
    out = v12.add_sensor_features(df, symbol, cadence, datasets).copy()
    scale = out["atr_pct"].clip(lower=0.0001)
    qqq = out.get("qqq_ret_1", 0.0)
    sector = out.get("sector_ret_1", 0.0)
    out["idiosyncratic_ret_1"] = (out["ret_1"] - 0.55 * qqq - 0.45 * sector).replace([np.inf, -np.inf], 0.0).fillna(0.0)
    out["idiosyncratic_ret_4"] = (
        out["ret_4"] - 0.55 * out.get("qqq_ret_4", 0.0) - 0.45 * out.get("sector_ret_4", 0.0)
    ).replace([np.inf, -np.inf], 0.0).fillna(0.0)

    gap_strength = (out.get("gap_abs", 0.0) / scale.shift(1).fillna(scale)).replace([np.inf, -np.inf], 0.0).fillna(0.0)
    volume_strength = out["volume_ratio"].rolling(3, min_periods=1).max().fillna(1.0)
    out["earnings_gap_proxy"] = (sigmoid_series(gap_strength - 1.35) * sigmoid_series(volume_strength - 1.35)).clip(0.0, 1.0)
    drift_strength = (out["idiosyncratic_ret_4"].abs() / (scale * 2.2)).replace([np.inf, -np.inf], 0.0).fillna(0.0)
    out["earnings_drift_proxy"] = (out["earnings_gap_proxy"] * sigmoid_series(drift_strength - 0.45)).clip(0.0, 1.0)

    vix_component = (out.get("vix_ret_1", 0.0).abs() / 0.035).clip(0.0, 2.0)
    market_component = (
        out.get("spy_ret_1", 0.0).abs() / 0.0045 + out.get("qqq_ret_1", 0.0).abs() / 0.0055
    ).replace([np.inf, -np.inf], 0.0).fillna(0.0)
    out["macro_calendar_proxy"] = sigmoid_series(vix_component + market_component - 1.6).clip(0.0, 1.0)

    compression = (scale.rolling(32, min_periods=8).median() / scale).replace([np.inf, -np.inf], 0.0).fillna(1.0).clip(0.0, 6.0)
    relative_impulse = (out["relative_qqq_4"].abs() + out["relative_sector_4"].abs()) / (scale * 2.0)
    out["gamma_oi_pressure_proxy"] = sigmoid_series(compression * out["volume_ratio"].clip(0.0, 5.0) * relative_impulse - 2.2).clip(0.0, 1.0)

    out["sector_flow_long_proxy"] = sigmoid_series(out.get("sector_ret_4", 0.0) / (scale * 1.5)).clip(0.0, 1.0)
    out["sector_flow_short_proxy"] = sigmoid_series(-out.get("sector_ret_4", 0.0) / (scale * 1.5)).clip(0.0, 1.0)
    out["large_cap_beta_proxy"] = sigmoid_series((out.get("qqq_ret_4", 0.0) + out.get("spy_ret_4", 0.0)) / (scale * 2.0)).clip(0.0, 1.0)
    out["event_direction_long_proxy"] = sigmoid_series(out["idiosyncratic_ret_1"] / scale + out["sector_flow_long_proxy"] - 0.8).clip(0.0, 1.0)
    out["event_direction_short_proxy"] = sigmoid_series(-out["idiosyncratic_ret_1"] / scale + out["sector_flow_short_proxy"] - 0.8).clip(0.0, 1.0)
    out["liquidity_stress_proxy"] = (
        0.35 * out["macro_calendar_proxy"]
        + 0.25 * out["earnings_drift_proxy"]
        + 0.25 * out["gamma_oi_pressure_proxy"]
        + 0.15 * (1.0 - out["hfcd_bsigma_health"])
    ).clip(0.0, 1.0)
    out["event_risk_proxy"] = (
        0.45 * out["event_risk_proxy"] + 0.25 * out["macro_calendar_proxy"] + 0.20 * out["earnings_gap_proxy"] + 0.10 * out["liquidity_stress_proxy"]
    ).clip(0.0, 1.0)
    return out.replace([np.inf, -np.inf], 0.0).fillna(0.0)


def fit_ridge(train: pd.DataFrame) -> dict[str, Any]:
    usable = train.dropna(subset=FEATURES + ["future_return"]).copy()
    if len(usable) < 55:
        return {"available": False, "reason": "insufficient_train_rows", "train_rows": int(len(usable))}
    x = usable[FEATURES].astype(float).replace([np.inf, -np.inf], 0.0).fillna(0.0).to_numpy()
    y = usable["future_return"].astype(float).to_numpy()
    mean = x.mean(axis=0)
    std = x.std(axis=0)
    std[std == 0] = 1.0
    z = (x - mean) / std
    design = np.column_stack([np.ones(len(z)), z])
    alpha = 8.0
    reg = np.eye(design.shape[1]) * alpha
    reg[0, 0] = 0.0
    beta = np.linalg.pinv(design.T @ design + reg) @ design.T @ y
    pred = design @ beta
    return {
        "available": True,
        "features": FEATURES,
        "mean": mean.tolist(),
        "std": std.tolist(),
        "beta": beta.tolist(),
        "mae": float(np.mean(np.abs(pred - y))),
        "train_rows": int(len(usable)),
    }


def apply_model(df: pd.DataFrame, model: dict[str, Any]) -> pd.DataFrame:
    out = df.copy()
    if not model.get("available"):
        out["predicted_return"] = 0.0
    else:
        x = out[FEATURES].astype(float).replace([np.inf, -np.inf], 0.0).fillna(0.0).to_numpy()
        mean = np.array(model["mean"], dtype=float)
        std = np.array(model["std"], dtype=float)
        beta = np.array(model["beta"], dtype=float)
        z = (x - mean) / std
        design = np.column_stack([np.ones(len(z)), z])
        out["predicted_return"] = design @ beta

    scale = out["atr_pct"].clip(lower=0.0001).astype(float) * 0.85
    pred_long = out["predicted_return"].div(scale).map(v10.sigmoid)
    pred_short = (-out["predicted_return"]).div(scale).map(v10.sigmoid)
    event_long = out["event_direction_long_proxy"]
    event_short = out["event_direction_short_proxy"]
    gamma_health = 1.0 - out["gamma_oi_pressure_proxy"] * 0.45

    out["long_score"] = (
        0.40 * pred_long
        + 0.11 * out["hfcd_cavity"]
        + 0.08 * out["hfcd_eta_health"]
        + 0.08 * out["hfcd_bsigma_health"]
        + 0.07 * out["trend_efficiency"]
        + 0.09 * out["sector_flow_long_proxy"]
        + 0.06 * event_long
        + 0.05 * out["large_cap_beta_proxy"]
        + 0.06 * gamma_health
    ).clip(0.0, 1.0)
    out["short_score"] = (
        0.40 * pred_short
        + 0.11 * out["hfcd_cavity"]
        + 0.08 * out["hfcd_eta_health"]
        + 0.08 * out["hfcd_bsigma_health"]
        + 0.07 * out["trend_efficiency"]
        + 0.09 * out["sector_flow_short_proxy"]
        + 0.06 * event_short
        + 0.05 * (1.0 - out["large_cap_beta_proxy"])
        + 0.06 * gamma_health
    ).clip(0.0, 1.0)
    return out


def forecast_edge(row: pd.Series, symbol: str, side: str, model_mae: float) -> dict[str, float]:
    predicted_side_return = float(row["predicted_return"]) if side == "long" else -float(row["predicted_return"])
    base_cost = v10.BASE_COST.get(symbol, 0.00030)
    spread_slip = base_cost + 0.050 * float(row["atr_pct"])
    noise = max(0.00025, min(0.0045, 0.24 * model_mae + 0.10 * float(row["atr_pct"])))
    event_buffer = 0.00040 * float(row.get("event_risk_proxy", 0.0))
    stress_buffer = 0.00030 * float(row.get("liquidity_stress_proxy", 0.0))
    edge = predicted_side_return - spread_slip - noise - event_buffer - stress_buffer
    return {
        "predicted_side_return": predicted_side_return,
        "cost_pct": spread_slip,
        "noise_buffer_pct": noise,
        "event_buffer_pct": event_buffer,
        "stress_buffer_pct": stress_buffer,
        "forecast_edge_pct": edge,
    }


def split_label(i: int, n_rows: int) -> str:
    return v10.split_label(i, n_rows)


def build_policies(symbol: str, cadence: str, side_policy: str) -> list[Policy]:
    score_floors = [0.60, 0.64] if side_policy == "long_only" else [0.62, 0.66]
    edge_floors = [0.0, 0.00025]
    holds = {
        "15m": [2],
        "30m": [2],
        "1h": [1, 2],
        "2h": [1],
        "3h": [1],
    }[cadence]
    exits = [(1.05, 1.8), (1.3, 2.3)]
    max_events = [0.76]
    min_gamma_healths = [0.40]
    session_policies = ["allow_close_avoid_open"]
    policies: list[Policy] = []
    for score_floor in score_floors:
        for edge_floor in edge_floors:
            for hold in holds:
                for stop_atr, take_atr in exits:
                    for max_event in max_events:
                        for min_gamma in min_gamma_healths:
                            for session_policy in session_policies:
                                policies.append(
                                    Policy(
                                        symbol=symbol,
                                        cadence=cadence,
                                        side_policy=side_policy,
                                        score_floor=score_floor,
                                        edge_floor=edge_floor,
                                        hold_bars=hold,
                                        stop_atr=stop_atr,
                                        take_atr=take_atr,
                                        min_cavity=0.28,
                                        min_eta_health=0.20,
                                        max_event_risk=max_event,
                                        min_gamma_health=min_gamma,
                                        session_policy=session_policy,
                                    )
                                )
    return policies


def decide_signal(row: pd.Series, policy: Policy, model_mae: float) -> tuple[str, dict[str, float], str]:
    if float(row["hfcd_cavity"]) < policy.min_cavity:
        return "", {}, "cavity_below_floor"
    if float(row["hfcd_eta_health"]) < policy.min_eta_health:
        return "", {}, "eta_health_below_floor"
    if float(row["event_risk_proxy"]) > policy.max_event_risk:
        return "", {}, "event_risk_above_floor"
    gamma_health = 1.0 - float(row.get("gamma_oi_pressure_proxy", 0.0)) * 0.45
    if gamma_health < policy.min_gamma_health:
        return "", {}, "gamma_oi_pressure_above_floor"
    if policy.session_policy == "avoid_open_close" and (float(row["opening_risk"]) > 0 or float(row["closing_risk"]) > 0):
        return "", {}, "session_open_close_block"
    if policy.session_policy == "allow_close_avoid_open" and float(row["opening_risk"]) > 0:
        return "", {}, "session_open_block"

    side = "long" if policy.side_policy == "long_only" else "short"
    edge = forecast_edge(row, policy.symbol, side, model_mae)
    score = float(row["long_score"] if side == "long" else row["short_score"])
    direction_proxy = float(row["event_direction_long_proxy"] if side == "long" else row["event_direction_short_proxy"])
    if score < policy.score_floor:
        return "", edge, "score_below_floor"
    if edge["forecast_edge_pct"] < policy.edge_floor:
        return "", edge, "forecast_edge_below_floor"
    if direction_proxy < 0.38:
        return "", edge, "event_direction_proxy_not_confirmed"
    return side, edge, f"{side}_specialist_edge_confirmed"


def simulate(df: pd.DataFrame, policy: Policy, model: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    rows = df.reset_index(drop=True)
    trades: list[dict[str, Any]] = []
    gates: list[dict[str, Any]] = []
    if len(rows) < 80 or not model.get("available"):
        return trades, gates
    model_mae = float(model.get("mae", 0.001))
    i = 32
    cooldown_until = -1
    while i < len(rows) - policy.hold_bars - 2:
        if i <= cooldown_until:
            i += 1
            continue
        row = rows.iloc[i]
        split = split_label(i, len(rows))
        side, edge, reason = decide_signal(row, policy, model_mae)
        if side or (split != "train" and i % 20 == 0):
            gates.append(
                {
                    "policy_name": policy.name,
                    "symbol": policy.symbol,
                    "cadence": policy.cadence,
                    "side_policy": policy.side_policy,
                    "split": split,
                    "signal_ts": row["timestamp"].isoformat(),
                    "gate_ok": bool(side),
                    "gate_reason": reason,
                    "chosen_side": side,
                    "predicted_return": n(row.get("predicted_return"), 8),
                    "predicted_side_return": n(edge.get("predicted_side_return", 0.0), 8),
                    "forecast_edge_pct": n(edge.get("forecast_edge_pct", 0.0), 8),
                    "event_risk_proxy": n(row.get("event_risk_proxy"), 6),
                    "earnings_gap_proxy": n(row.get("earnings_gap_proxy"), 6),
                    "macro_calendar_proxy": n(row.get("macro_calendar_proxy"), 6),
                    "gamma_oi_pressure_proxy": n(row.get("gamma_oi_pressure_proxy"), 6),
                    "sector_ret_1": n(row.get("sector_ret_1"), 6),
                    "score": n(row.get("long_score" if policy.side_policy == "long_only" else "short_score"), 6),
                }
            )
        if not side:
            i += 1
            continue

        entry_i = i + 1
        entry_row = rows.iloc[entry_i]
        entry = float(entry_row["open"])
        atr = float(row["atr"])
        sl = entry - policy.stop_atr * atr if side == "long" else entry + policy.stop_atr * atr
        tp = entry + policy.take_atr * atr if side == "long" else entry - policy.take_atr * atr
        exit_i = min(entry_i + policy.hold_bars, len(rows) - 1)
        exit_px = float(rows.iloc[exit_i]["close"])
        exit_reason = "hold_expired"
        ambiguous = False
        for j in range(entry_i, min(entry_i + policy.hold_bars + 1, len(rows))):
            bar = rows.iloc[j]
            high = float(bar["high"])
            low = float(bar["low"])
            if side == "long":
                hit_sl, hit_tp = low <= sl, high >= tp
                if hit_sl and hit_tp:
                    exit_i, exit_px, exit_reason, ambiguous = j, sl, "stop_loss_ambiguous", True
                    break
                if hit_sl:
                    exit_i, exit_px, exit_reason = j, sl, "stop_loss"
                    break
                if hit_tp:
                    exit_i, exit_px, exit_reason = j, tp, "take_profit"
                    break
            else:
                hit_sl, hit_tp = high >= sl, low <= tp
                if hit_sl and hit_tp:
                    exit_i, exit_px, exit_reason, ambiguous = j, sl, "stop_loss_ambiguous", True
                    break
                if hit_sl:
                    exit_i, exit_px, exit_reason = j, sl, "stop_loss"
                    break
                if hit_tp:
                    exit_i, exit_px, exit_reason = j, tp, "take_profit"
                    break

        gross = v10.side_return(side, entry, exit_px)
        realized_cost = float(edge.get("cost_pct", v10.BASE_COST.get(policy.symbol, 0.00030)))
        net = gross - realized_cost
        trades.append(
            {
                "version": VERSION,
                "policy_name": policy.name,
                "symbol": policy.symbol,
                "cadence": policy.cadence,
                "side_policy": policy.side_policy,
                "side": side,
                "split": split,
                "signal_ts": row["timestamp"].isoformat(),
                "entry_ts": entry_row["timestamp"].isoformat(),
                "exit_ts": rows.iloc[exit_i]["timestamp"].isoformat(),
                "entry_price": n(entry, 6),
                "exit_price": n(exit_px, 6),
                "gross_return": n(gross, 8),
                "cost_return": n(realized_cost, 8),
                "net_return": n(net, 8),
                "pnl_usd": n(NOTIONAL_USD * net, 6),
                "forecast_edge_pct": n(edge.get("forecast_edge_pct", 0.0), 8),
                "event_risk_proxy": n(row.get("event_risk_proxy"), 6),
                "gamma_oi_pressure_proxy": n(row.get("gamma_oi_pressure_proxy"), 6),
                "exit_reason": exit_reason,
                "intrabar_ambiguous": ambiguous,
            }
        )
        cooldown_until = exit_i
        i = exit_i + 1
    return trades, gates


def metrics(trades: list[dict[str, Any]]) -> dict[str, Any]:
    return v10.metrics(trades)


def min_trade_floor(cadence: str, split: str) -> int:
    if cadence in {"15m", "30m"}:
        return 8 if split == "train" else 4
    if cadence == "1h":
        return 5 if split == "train" else 3
    return 3 if split == "train" else 2


def route_status(row: dict[str, Any]) -> str:
    if (
        row["train_trades"] >= min_trade_floor(row["cadence"], "train")
        and row["validation_trades"] >= min_trade_floor(row["cadence"], "validation")
        and row["test_trades"] >= min_trade_floor(row["cadence"], "test")
        and row["train_net_pnl_usd"] > 0
        and row["validation_net_pnl_usd"] > 0
        and row["test_net_pnl_usd"] > 0
        and row["train_profit_factor"] >= 1.05
        and row["validation_profit_factor"] >= 1.25
        and row["test_profit_factor"] >= 1.25
        and row["validation_win_rate"] >= 0.50
        and row["test_win_rate"] >= 0.50
    ):
        return "stock_v1_5_online_paper_candidate"
    if (
        row["validation_trades"] >= min_trade_floor(row["cadence"], "validation")
        and row["test_trades"] >= min_trade_floor(row["cadence"], "test")
        and row["validation_net_pnl_usd"] > 0
        and row["test_net_pnl_usd"] > 0
        and row["test_profit_factor"] >= 1.15
    ):
        return "validation_test_watchlist"
    if row["test_trades"] >= min_trade_floor(row["cadence"], "test") and row["test_net_pnl_usd"] > 0:
        return "test_positive_watchlist"
    return "blocked"


def selection_score(row: dict[str, Any]) -> float:
    return (
        min(float(row["train_profit_factor"]), 6.0) * 14.0
        + min(float(row["validation_profit_factor"]), 6.0) * 34.0
        + min(float(row["test_profit_factor"]), 6.0) * 26.0
        + float(row["train_net_pnl_usd"]) * 0.12
        + float(row["validation_net_pnl_usd"]) * 0.45
        + float(row["test_net_pnl_usd"]) * 0.32
        + float(row["validation_win_rate"]) * 22.0
        + float(row["test_win_rate"]) * 20.0
        - abs(float(row["validation_max_drawdown_usd"])) * 0.08
        - abs(float(row["test_max_drawdown_usd"])) * 0.08
    )


def summarize(policy: Policy, trades: list[dict[str, Any]], model: dict[str, Any]) -> dict[str, Any]:
    split_metrics = {split: metrics([t for t in trades if t["split"] == split]) for split in ["train", "validation", "test"]}
    row: dict[str, Any] = {
        **asdict(policy),
        "policy_name": policy.name,
        "model_available": bool(model.get("available")),
        "model_train_rows": int(model.get("train_rows", 0)),
        "model_mae": n(model.get("mae", 0.0), 8),
    }
    for split, m in split_metrics.items():
        for key, value in m.items():
            row[f"{split}_{key}"] = value
    row["status"] = route_status(row)
    row["selection_score"] = n(selection_score(row), 4)
    return row


def select_best(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    for symbol in TARGET_SYMBOLS:
        for side_policy in SIDE_POLICIES:
            group = [r for r in rows if r["symbol"] == symbol and r["side_policy"] == side_policy]
            group.sort(
                key=lambda r: (
                    3
                    if r["status"] == "stock_v1_5_online_paper_candidate"
                    else (2 if r["status"] == "validation_test_watchlist" else (1 if r["status"] == "test_positive_watchlist" else 0)),
                    float(r["selection_score"]),
                    float(r["test_net_pnl_usd"]),
                    float(r["test_profit_factor"]),
                ),
                reverse=True,
            )
            if group:
                selected.append(dict(group[0]))
    return selected


def build_plot(selected: list[dict[str, Any]], path: Path) -> bool:
    try:
        if not selected:
            return False
        labels = [f"{r['symbol']} {r['cadence']} {r['side_policy'].replace('_only','')}" for r in selected]
        train = [float(r["train_net_pnl_usd"]) for r in selected]
        val = [float(r["validation_net_pnl_usd"]) for r in selected]
        test = [float(r["test_net_pnl_usd"]) for r in selected]
        x = np.arange(len(labels))
        fig, ax = plt.subplots(figsize=(11, 6))
        fig.patch.set_facecolor("#111111")
        ax.set_facecolor("#111111")
        ax.bar(x - 0.24, train, width=0.24, label="train", color="#64748b")
        ax.bar(x, val, width=0.24, label="validation", color="#38bdf8")
        ax.bar(x + 0.24, test, width=0.24, label="test", color=["#34d399" if v > 0 else "#fb7185" for v in test])
        ax.axhline(0, color="#dddddd", linewidth=0.8)
        ax.set_xticks(x)
        ax.set_xticklabels(labels, rotation=20, ha="right", color="#dddddd")
        ax.tick_params(colors="#dddddd")
        for spine in ax.spines.values():
            spine.set_color("#555555")
        ax.legend(facecolor="#111111", edgecolor="#555555", labelcolor="#dddddd")
        ax.set_title(VERSION, color="#ffffff")
        fig.tight_layout()
        fig.savefig(path, facecolor=fig.get_facecolor(), dpi=160)
        plt.close(fig)
        return True
    except Exception:
        return False


def render_report(summary: dict[str, Any]) -> str:
    lines = [
        f"# {VERSION}",
        "",
        f"Generated: `{summary['generated_at']}`",
        "",
        "## 决策",
        "",
        f"- `{summary['decision']}`",
        f"- `deployment_allowed`: `{str(summary['deployment_allowed']).lower()}`",
        f"- candidate_count: `{summary['candidate_count']}`",
        "- 本阶段只做 NVDA/MSFT 历史盲测，不直接触碰线上账本。",
        "- 财报日、CPI/FOMC、期权 Gamma/OI 当前均为代理传感器；没有真实外部数据前不能把它们当真实传感器宣传。",
        "",
        "## 每个标的/方向最优路线",
        "",
    ]
    for row in summary["selected_routes"]:
        lines.append(
            f"- `{row['symbol']}` `{row['side_policy']}` -> `{row['cadence']}` status=`{row['status']}`；"
            f"train PnL={row['train_net_pnl_usd']} PF={row['train_profit_factor']} trades={row['train_trades']}；"
            f"val PnL={row['validation_net_pnl_usd']} PF={row['validation_profit_factor']} trades={row['validation_trades']}；"
            f"test PnL={row['test_net_pnl_usd']} PF={row['test_profit_factor']} trades={row['test_trades']}。"
        )
    if summary["candidate_routes"]:
        lines.extend(["", "## 允许接入线上模拟交易", ""])
        for row in summary["candidate_routes"]:
            lines.append(f"- `{row['symbol']}` `{row['cadence']}` `{row['side_policy']}`")
    lines.extend(["", "## 下一步", "", summary["next_action"]])
    return "\n".join(lines) + "\n"


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    coverage: list[dict[str, Any]] = []
    datasets = build_base_datasets(coverage)

    summaries: list[dict[str, Any]] = []
    trades_all: list[dict[str, Any]] = []
    gates_all: list[dict[str, Any]] = []
    models: list[dict[str, Any]] = []

    for symbol in TARGET_SYMBOLS:
        for cadence in CADENCES:
            print(f"[{utc_now()}] testing {symbol} {cadence} long/short", flush=True)
            df0 = datasets.get((symbol, cadence))
            if df0 is None or len(df0) < 90:
                coverage.append({"symbol": symbol, "cadence": cadence, "source": "target_route", "rows": 0, "status": "missing_or_low"})
                continue
            df = add_specialist_features(df0, symbol, cadence, datasets)
            train_end = int(len(df) * 0.60)
            model = fit_ridge(df.iloc[:train_end].copy())
            df = apply_model(df, model)
            for side_policy in SIDE_POLICIES:
                models.append(
                    {
                        "symbol": symbol,
                        "cadence": cadence,
                        "side_policy": side_policy,
                        "model_available": bool(model.get("available")),
                        "model_train_rows": int(model.get("train_rows", 0)),
                        "model_mae": n(model.get("mae", 0.0), 8),
                        "features": ",".join(FEATURES),
                        "true_options_gamma_oi_available": False,
                        "true_earnings_calendar_available": False,
                        "true_macro_calendar_available": False,
                    }
                )
                for policy in build_policies(symbol, cadence, side_policy):
                    trades, gates = simulate(df, policy, model)
                    trades_all.extend(trades)
                    gates_all.extend(gates)
                    summaries.append(summarize(policy, trades, model))

    selected = select_best(summaries)
    selected_names = {r["policy_name"] for r in selected}
    selected_trades = [t for t in trades_all if t["policy_name"] in selected_names]
    candidates = [r for r in selected if r["status"] == "stock_v1_5_online_paper_candidate"]
    watchlist = [r for r in selected if r["status"] in {"validation_test_watchlist", "test_positive_watchlist"}]
    decision = "stock_v1_5_online_paper_ready" if candidates else ("stock_v1_5_watchlist_only" if watchlist else "stock_v1_5_blocked")
    png_path = OUT_DIR / "HFCD_Stock_V1_5_NVDA_MSFT_SensorSpecialist.png"
    figure_generated = build_plot(selected, png_path)
    permission_rows = [
        {
            "symbol": r["symbol"],
            "cadence": r["cadence"],
            "side_policy": r["side_policy"],
            "allowed": bool(r["status"] == "stock_v1_5_online_paper_candidate"),
            "status": r["status"],
            "train_pnl_usd": r["train_net_pnl_usd"],
            "validation_pnl_usd": r["validation_net_pnl_usd"],
            "test_pnl_usd": r["test_net_pnl_usd"],
            "test_profit_factor": r["test_profit_factor"],
        }
        for r in selected
    ]
    output_files = {
        "summary": str(OUT_DIR / "hfcd_stock_v1_5_summary.json"),
        "route_summary": str(OUT_DIR / "hfcd_stock_v1_5_route_summary.csv"),
        "selected_routes": str(OUT_DIR / "hfcd_stock_v1_5_selected_routes.csv"),
        "selected_trades": str(OUT_DIR / "hfcd_stock_v1_5_selected_trades.csv"),
        "gate_audit": str(OUT_DIR / "hfcd_stock_v1_5_gate_audit.csv"),
        "model_audit": str(OUT_DIR / "hfcd_stock_v1_5_model_audit.csv"),
        "data_coverage": str(OUT_DIR / "hfcd_stock_v1_5_data_coverage.csv"),
        "permission_matrix": str(OUT_DIR / "hfcd_stock_v1_5_direction_permission_matrix.csv"),
        "report": str(OUT_DIR / "HFCD_Stock_V1_5_NVDA_MSFT_SensorSpecialist.md"),
        "figure": str(png_path),
    }
    summary = {
        "version": VERSION,
        "generated_at": utc_now(),
        "decision": decision,
        "promotion_status": "candidate_for_online_paper" if candidates else "blocked",
        "deployment_allowed": bool(candidates),
        "online_or_broker_touched": False,
        "data_mode": "yahoo_public_intraday_plus_vix_sector_proxy_plus_earnings_macro_gamma_proxy_local_blind",
        "target_symbols": TARGET_SYMBOLS,
        "cadences": CADENCES,
        "side_policies": SIDE_POLICIES,
        "candidate_count": len(candidates),
        "watchlist_count": len(watchlist),
        "candidate_routes": candidates,
        "selected_routes": selected,
        "permission_matrix": permission_rows,
        "quality_gates": {
            "train_validation_test_required": True,
            "forecast_edge_gate_used": True,
            "train_only_model_fit": True,
            "vix_sensor_used": True,
            "sector_sensor_used": True,
            "earnings_calendar_true_feed_used": False,
            "cpi_fomc_true_calendar_used": False,
            "options_gamma_oi_true_feed_used": False,
            "proxy_sensors_not_promotable_as_true_feeds": True,
            "figure_generated": figure_generated,
        },
        "output_files": output_files,
        "next_action": (
            "If V1.5 produces a candidate, add only that route to online stock paper trading. "
            "If not, keep current V1.4 online routes and next acquire true earnings calendar, macro calendar, "
            "and options chain/OI data instead of tuning proxy thresholds."
        ),
    }

    write_csv(OUT_DIR / "hfcd_stock_v1_5_route_summary.csv", summaries)
    write_csv(OUT_DIR / "hfcd_stock_v1_5_selected_routes.csv", selected)
    write_csv(OUT_DIR / "hfcd_stock_v1_5_selected_trades.csv", selected_trades)
    write_csv(OUT_DIR / "hfcd_stock_v1_5_gate_audit.csv", gates_all)
    write_csv(OUT_DIR / "hfcd_stock_v1_5_model_audit.csv", models)
    write_csv(OUT_DIR / "hfcd_stock_v1_5_data_coverage.csv", coverage)
    write_csv(OUT_DIR / "hfcd_stock_v1_5_direction_permission_matrix.csv", permission_rows)
    (OUT_DIR / "hfcd_stock_v1_5_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT_DIR / "HFCD_Stock_V1_5_NVDA_MSFT_SensorSpecialist.md").write_text(render_report(summary), encoding="utf-8")

    print(json.dumps({
        "version": VERSION,
        "decision": decision,
        "candidate_count": len(candidates),
        "watchlist_count": len(watchlist),
        "selected_routes": [
            {
                "symbol": r["symbol"],
                "cadence": r["cadence"],
                "side_policy": r["side_policy"],
                "status": r["status"],
                "train_pnl": r["train_net_pnl_usd"],
                "validation_pnl": r["validation_net_pnl_usd"],
                "test_pnl": r["test_net_pnl_usd"],
                "test_pf": r["test_profit_factor"],
            }
            for r in selected
        ],
        "output_dir": str(OUT_DIR),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
