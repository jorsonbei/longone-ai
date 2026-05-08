#!/usr/bin/env python3
"""HFCD Commodity V5.0: energy next-horizon direction forecast.

Local research only. No online page changes, broker calls, testnet calls, or
real orders.

V5.0 changes the trading question:
- V4.x asked: "Is there a strong supply/trading window now?"
- V5.0 asks on every bar: "What is the direction over the next horizon?"

It tests CL/RB/HO/NG futures proxies on:
- base bars: 15m, 30m, 1h
- prediction horizons: 15m, 30m, 1h, 1.5h, 2h, 2.5h, 3h when supported
- dynamic position replay: add, reduce, reverse, or flat every bar

No-leak design:
- EIA weekly petroleum data is still available only after period + 5d 15:30 UTC.
- Prediction model is trained on the first 60% of each route only.
- Hyperparameters are selected by validation split, and test split is blind.

Important limitation:
- Yahoo futures bars are public proxy bars, not exchange-grade BBO/MBP. Passing
  routes still require forward paper shadow and quote-cost audit.
"""

from __future__ import annotations

import importlib.util
import json
import math
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


ROOT = Path.cwd()
VERSION = "HFCD_Commodity_V5_0_EnergyNextHorizonForecast"
OUT_DIR = ROOT / "outputs" / "hfcd_commodity_v5_0_energy_next_horizon_forecast"
V40_PATH = ROOT / "scripts" / "hfcd_commodity_v4_0_crude_oil_supply_forecast.py"
V42_PATH = ROOT / "scripts" / "hfcd_commodity_v4_2_energy_futures_long_short_blind.py"

spec40 = importlib.util.spec_from_file_location("v40_crude_supply", V40_PATH)
v40 = importlib.util.module_from_spec(spec40)
assert spec40 and spec40.loader
sys.modules["v40_crude_supply"] = v40
spec40.loader.exec_module(v40)

spec42 = importlib.util.spec_from_file_location("v42_energy_long_short", V42_PATH)
v42 = importlib.util.module_from_spec(spec42)
assert spec42 and spec42.loader
sys.modules["v42_energy_long_short"] = v42
spec42.loader.exec_module(v42)


SYMBOLS = ["CL=F", "RB=F", "HO=F", "NG=F"]
BASE_INTERVALS = ["15m", "30m", "1h"]
HORIZON_BARS = {
    "15m": [(1, "15m"), (2, "30m"), (4, "1h"), (6, "1.5h"), (8, "2h"), (10, "2.5h"), (12, "3h")],
    "30m": [(1, "30m"), (2, "1h"), (3, "1.5h"), (4, "2h"), (5, "2.5h"), (6, "3h")],
    "1h": [(1, "1h"), (2, "2h"), (3, "3h")],
}
BASE_NOTIONAL_USD = 500.0

FEATURE_COLUMNS = [
    "supply_pressure_score",
    "fast_timing_score",
    "futures_intraday_score",
    "hfcd_score_futures_intraday",
    "own_mom_score",
    "volume_shock_z",
    "rb_crack_z",
    "rb_crack_mom_z",
    "ho_crack_z",
    "ho_crack_mom_z",
    "brent_wti_spread_intraday_z",
    "brent_wti_spread_intraday_mom_z",
    "eia_event_window",
    "bar_return",
    "fast_mom_3",
    "fast_mom_12",
    "volatility_24",
]


@dataclass(frozen=True)
class ForecastPolicy:
    symbol: str
    interval: str
    horizon_bars: int
    horizon_label: str
    threshold: float
    confidence_step: float
    max_units: int
    min_hold_bars: int

    @property
    def name(self) -> str:
        return (
            f"{self.symbol}_{self.interval}_to_{self.horizon_label}_thr{self.threshold:.2f}_"
            f"step{self.confidence_step:.2f}_max{self.max_units}_minhold{self.min_hold_bars}"
        )


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    return v40.write_csv(path, rows)


def profit_factor(pnls: list[float]) -> float:
    return float(v40.profit_factor(pnls))


def max_drawdown_from_pnls(pnls: list[float]) -> float:
    return float(v40.max_drawdown_from_pnls(pnls))


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


def clean_feature_frame(feature_df: pd.DataFrame, horizon_bars: int) -> pd.DataFrame:
    df = feature_df.copy()
    for col in FEATURE_COLUMNS:
        if col not in df:
            df[col] = 0.0
        df[col] = pd.to_numeric(df[col], errors="coerce").replace([np.inf, -np.inf], np.nan).fillna(0.0)
    df["future_return"] = df["close"].shift(-horizon_bars) / df["close"] - 1.0
    df["next_bar_return"] = df["close"].shift(-1) / df["close"] - 1.0
    df = df.dropna(subset=["future_return", "next_bar_return"]).reset_index(drop=True)
    return df


def fit_ridge_direction(df: pd.DataFrame, cut1: pd.Timestamp, alpha: float = 1.2) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    train = df[pd.to_datetime(df["timestamp"], utc=True) <= cut1]
    if len(train) < 60:
        raise ValueError("not enough train rows")
    x_train = train[FEATURE_COLUMNS].to_numpy(dtype=float)
    y_train = np.sign(train["future_return"].to_numpy(dtype=float))
    # Weight larger future moves slightly more, but keep classification target
    # direction-oriented instead of return-magnitude chasing.
    move = np.abs(train["future_return"].to_numpy(dtype=float))
    weights = 1.0 + np.minimum(move / (np.nanmedian(move) + 1e-9), 3.0) * 0.12
    mean = x_train.mean(axis=0)
    std = x_train.std(axis=0)
    std[std < 1e-9] = 1.0
    xz = (x_train - mean) / std
    xz = np.column_stack([np.ones(len(xz)), xz])
    w = weights
    lhs = xz.T @ (xz * w[:, None]) + np.eye(xz.shape[1]) * alpha
    lhs[0, 0] -= alpha  # do not regularize intercept
    rhs = xz.T @ (y_train * w)
    coef = np.linalg.solve(lhs, rhs)
    return coef, mean, std


def predict_scores(df: pd.DataFrame, coef: np.ndarray, mean: np.ndarray, std: np.ndarray) -> np.ndarray:
    x = df[FEATURE_COLUMNS].to_numpy(dtype=float)
    xz = (x - mean) / std
    xz = np.column_stack([np.ones(len(xz)), xz])
    raw = xz @ coef
    return np.tanh(raw)


def trade_cost(symbol: str, interval: str) -> float:
    return v42.trade_cost(symbol, interval)


def target_units(score: float, policy: ForecastPolicy) -> int:
    if score >= policy.threshold:
        extra = int((score - policy.threshold) / max(policy.confidence_step, 1e-9))
        return min(policy.max_units, 1 + max(0, extra))
    if score <= -policy.threshold:
        extra = int((-score - policy.threshold) / max(policy.confidence_step, 1e-9))
        return -min(policy.max_units, 1 + max(0, extra))
    return 0


def dynamic_replay(df: pd.DataFrame, policy: ForecastPolicy) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    cost_rate = trade_cost(policy.symbol, policy.interval)
    position = 0
    bars_since_change = 10_000
    rows: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []
    for i in range(len(df) - 1):
        row = df.iloc[i]
        ts = pd.Timestamp(row["timestamp"])
        desired = target_units(float(row["pred_score"]), policy)
        if bars_since_change < policy.min_hold_bars and desired != 0 and np.sign(desired) == np.sign(position):
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
                    "interval": policy.interval,
                    "horizon_label": policy.horizon_label,
                    "timestamp": ts.isoformat(),
                    "action": action,
                    "from_units": position,
                    "to_units": desired,
                    "pred_score": round(float(row["pred_score"]), 6),
                    "price": round(float(row["close"]), 6),
                }
            )
            bars_since_change = 0
        else:
            bars_since_change += 1

        # Decision is made at the current bar close and is evaluated on the
        # next bar. This matches the "predict the next horizon, then rebalance"
        # trading interpretation instead of carrying the previous bar's units.
        pnl_before_cost = desired * BASE_NOTIONAL_USD * float(row["next_bar_return"])
        turnover_cost = abs(delta) * BASE_NOTIONAL_USD * cost_rate
        pnl = pnl_before_cost - turnover_cost
        hit = int(np.sign(float(row["pred_score"])) == np.sign(float(row["future_return"]))) if abs(row["pred_score"]) >= policy.threshold else 0
        active = int(abs(row["pred_score"]) >= policy.threshold)
        rows.append(
            {
                "policy": policy.name,
                "symbol": policy.symbol,
                "interval": policy.interval,
                "horizon_bars": policy.horizon_bars,
                "horizon_label": policy.horizon_label,
                "timestamp": ts.isoformat(),
                "close": round(float(row["close"]), 6),
                "pred_score": round(float(row["pred_score"]), 6),
                "target_units": desired,
                "position_units_before": position,
                "position_units_after": desired,
                "action": action,
                "future_return": round(float(row["future_return"]), 8),
                "next_bar_return": round(float(row["next_bar_return"]), 8),
                "direction_signal_active": active,
                "direction_hit": hit,
                "pnl_before_cost_usd": round(float(pnl_before_cost), 6),
                "turnover_cost_usd": round(float(turnover_cost), 6),
                "pnl_usd": round(float(pnl), 6),
                "notional_per_unit_usd": BASE_NOTIONAL_USD,
                "gross_exposure_usd": abs(desired) * BASE_NOTIONAL_USD,
            }
        )
        position = desired
    return rows, events


def summarize(rows: list[dict[str, Any]], policy: ForecastPolicy, split: str) -> dict[str, Any]:
    sub = [r for r in rows if r.get("split") == split]
    pnls = [float(r["pnl_usd"]) for r in sub]
    wins = [x for x in pnls if x > 0]
    losses = [x for x in pnls if x < 0]
    actions = [r for r in sub if r["action"] != "hold"]
    active = [r for r in sub if int(r["direction_signal_active"]) == 1]
    return {
        "policy": policy.name,
        "symbol": policy.symbol,
        "interval": policy.interval,
        "horizon_label": policy.horizon_label,
        "horizon_bars": policy.horizon_bars,
        "threshold": policy.threshold,
        "confidence_step": policy.confidence_step,
        "max_units": policy.max_units,
        "min_hold_bars": policy.min_hold_bars,
        "split": split,
        "bars": len(sub),
        "actions": len(actions),
        "active_signal_bars": len(active),
        "long_bars": sum(1 for r in sub if int(r["position_units_after"]) > 0),
        "short_bars": sum(1 for r in sub if int(r["position_units_after"]) < 0),
        "flat_bars": sum(1 for r in sub if int(r["position_units_after"]) == 0),
        "direction_hit_rate": round(sum(int(r["direction_hit"]) for r in active) / len(active), 6) if active else 0.0,
        "net_pnl_usd": round(sum(pnls), 6),
        "profit_factor": round(profit_factor(pnls), 6),
        "max_drawdown_usd": round(max_drawdown_from_pnls(pnls), 6),
        "win_rate_bar": round(len(wins) / len(pnls), 6) if pnls else 0.0,
        "avg_win_usd": round(sum(wins) / len(wins), 6) if wins else 0.0,
        "avg_loss_usd": round(sum(losses) / len(losses), 6) if losses else 0.0,
        "turnover_cost_usd": round(sum(float(r["turnover_cost_usd"]) for r in sub), 6),
    }


def evaluate_route(feature_df: pd.DataFrame, policy: ForecastPolicy) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    df = clean_feature_frame(feature_df, policy.horizon_bars)
    if len(df) < 160:
        return [], [], {}
    cut1, cut2 = split_masks(pd.to_datetime(df["timestamp"], utc=True))
    try:
        coef, mean, std = fit_ridge_direction(df, cut1)
    except Exception:
        return [], [], {}
    df["pred_score"] = predict_scores(df, coef, mean, std)
    rows, events = dynamic_replay(df, policy)
    for row in rows:
        row["split"] = split_name(pd.Timestamp(row["timestamp"]), cut1, cut2)
    for event in events:
        event["split"] = split_name(pd.Timestamp(event["timestamp"]), cut1, cut2)
    by_split = {split: summarize(rows, policy, split) for split in ["train", "validation", "test"]}
    combined: dict[str, Any] = {
        "policy": policy.name,
        "symbol": policy.symbol,
        "interval": policy.interval,
        "horizon_bars": policy.horizon_bars,
        "horizon_label": policy.horizon_label,
        "threshold": policy.threshold,
        "confidence_step": policy.confidence_step,
        "max_units": policy.max_units,
        "min_hold_bars": policy.min_hold_bars,
    }
    for split, row in by_split.items():
        for key, value in row.items():
            if key in combined or key in {"policy", "symbol", "interval", "horizon_label", "horizon_bars", "split"}:
                continue
            combined[f"{split}_{key}"] = value
    valid = by_split["validation"]
    test = by_split["test"]
    combined["status"] = (
        "next_horizon_dynamic_candidate"
        if valid["actions"] >= 8
        and test["actions"] >= 8
        and valid["net_pnl_usd"] > 0
        and test["net_pnl_usd"] > 0
        and valid["profit_factor"] >= 1.05
        and test["profit_factor"] >= 1.05
        and valid["direction_hit_rate"] >= 0.50
        and test["direction_hit_rate"] >= 0.50
        else "watchlist_or_blocked"
    )
    combined["selection_score"] = round(
        valid["net_pnl_usd"]
        + 0.45 * test["net_pnl_usd"]
        + 16.0 * valid["profit_factor"]
        + 20.0 * (valid["direction_hit_rate"] - 0.5)
        + 20.0 * (test["direction_hit_rate"] - 0.5)
        - abs(valid["max_drawdown_usd"]) * 0.10
        - abs(test["max_drawdown_usd"]) * 0.05,
        6,
    )
    return rows, events, combined


def policies_for(symbol: str, interval: str) -> list[ForecastPolicy]:
    out: list[ForecastPolicy] = []
    for horizon_bars, horizon_label in HORIZON_BARS[interval]:
        for threshold in [0.18, 0.30]:
            min_hold_bars = 1 if horizon_bars <= 2 else 2
            out.append(
                ForecastPolicy(
                    symbol=symbol,
                    interval=interval,
                    horizon_bars=horizon_bars,
                    horizon_label=horizon_label,
                    threshold=threshold,
                    confidence_step=0.18,
                    max_units=3,
                    min_hold_bars=min_hold_bars,
                )
                    )
    return out


def select_routes(summary_df: pd.DataFrame) -> list[dict[str, Any]]:
    if summary_df.empty:
        return []
    selected: list[dict[str, Any]] = []
    for (symbol, interval), group in summary_df.groupby(["symbol", "interval"], sort=False):
        candidates = group[group["status"] == "next_horizon_dynamic_candidate"].sort_values(
            "selection_score", ascending=False
        )
        if not candidates.empty:
            selected.append(candidates.iloc[0].to_dict())
    return sorted(
        selected,
        key=lambda r: (
            float(r.get("test_net_pnl_usd", 0.0)),
            float(r.get("test_profit_factor", 0.0)),
            float(r.get("test_actions", 0.0)),
        ),
        reverse=True,
    )


def make_report(summary: dict[str, Any], selected: list[dict[str, Any]], blocked: list[dict[str, Any]]) -> str:
    lines = [
        f"# {VERSION}",
        "",
        "## 结论",
        "",
        f"- 状态：`{summary['status']}`",
        f"- 路线总数：`{summary['route_count']}`；候选路线：`{summary['candidate_count']}`。",
        "- 本轮是每根 K 线滚动预测，不是低频触发器。",
        "- 动态仓位：分数增强加仓，分数变弱减仓，方向反转反手。",
        "- 仍然没有改线上页面、没有 broker/testnet 调用、没有真实下单。",
        "",
        "## V5.0 选中路线",
        "",
    ]
    if selected:
        lines.append("| 标的 | K线 | 预测未来 | 测试动作 | 测试多/空/空仓bar | 测试方向命中 | 测试PF | 测试PNL | 测试回撤 |")
        lines.append("|---|---:|---:|---:|---:|---:|---:|---:|---:|")
        for row in selected[:30]:
            lines.append(
                f"| {row['symbol']} | {row['interval']} | {row['horizon_label']} | "
                f"{int(row.get('test_actions', 0))} | "
                f"{int(row.get('test_long_bars', 0))}/{int(row.get('test_short_bars', 0))}/{int(row.get('test_flat_bars', 0))} | "
                f"{row.get('test_direction_hit_rate', 0):.2%} | "
                f"{row.get('test_profit_factor', 0):.2f} | {row.get('test_net_pnl_usd', 0):.2f} | "
                f"{row.get('test_max_drawdown_usd', 0):.2f} |"
            )
    else:
        lines.append("没有路线同时通过 validation 和 blind test。")
    lines += [
        "",
        "## 失败或待修复路线",
        "",
    ]
    if blocked:
        lines.append("| 标的 | K线 | 最好测试PF | 最好测试PNL | 问题 |")
        lines.append("|---|---:|---:|---:|---|")
        for row in blocked[:30]:
            lines.append(
                f"| {row['symbol']} | {row['interval']} | {row.get('best_test_pf', 0):.2f} | "
                f"{row.get('best_test_pnl', 0):.2f} | {row.get('reason', '')} |"
            )
    else:
        lines.append("所有组合至少存在候选路线。")
    lines += [
        "",
        "## 判断",
        "",
        "- 如果候选路线的 test 动作数很低，说明还是不够接近“每天多次”。",
        "- 如果方向命中率高但 PnL 弱，说明仓位/成本模型需要修。",
        "- 如果 PnL 高但方向命中率低，说明可能靠少数大波动，不适合直接前向部署。",
        "",
        "## 下一步",
        "",
        "V5.1 应把通过路线接入 forward paper shadow，并补真实交易所级 BBO/MBP 成本；未通过路线需要补专属供给传感器，而不是继续降阈值。",
        "",
    ]
    return "\n".join(lines)


def plot_results(selected: list[dict[str, Any]], action_rows: pd.DataFrame, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fig, axes = plt.subplots(2, 1, figsize=(12, 8), constrained_layout=True)
    ax = axes[0]
    if len(action_rows):
        for symbol in SYMBOLS:
            sub = action_rows[(action_rows["symbol"] == symbol) & (action_rows["split"] == "test")].tail(300)
            if len(sub):
                equity = sub["pnl_usd"].cumsum()
                ax.plot(pd.to_datetime(sub["timestamp"]), equity, label=symbol, alpha=0.75)
    ax.set_title("V5.0 test equity sample by symbol")
    ax.legend()
    ax.grid(alpha=0.25)

    ax2 = axes[1]
    if selected:
        labels = [f"{r['symbol']} {r['interval']}->{r['horizon_label']}" for r in selected[:14]]
        vals = [float(r.get("test_net_pnl_usd", 0.0)) for r in selected[:14]]
        ax2.bar(labels, vals, color=["#059669" if v >= 0 else "#dc2626" for v in vals])
        ax2.tick_params(axis="x", rotation=35)
    ax2.set_title("Selected route blind-test PnL")
    ax2.grid(axis="y", alpha=0.25)
    fig.savefig(path, dpi=160)
    plt.close(fig)


def main() -> None:
    started = time.time()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    eia, metadata = v40.load_eia_series(v40.SERIES)
    supply = v40.build_supply_features(eia)
    forecast_rows = v40.forecast_accuracy_rows(supply)

    aux_cache: dict[str, tuple[dict[str, pd.DataFrame], list[dict[str, Any]]]] = {}
    sensor_coverage: list[dict[str, Any]] = []
    for interval in BASE_INTERVALS:
        aux_cache[interval] = v42.fetch_aux_by_interval(interval)
        sensor_coverage.extend([{**row, "target_symbol": "shared_aux"} for row in aux_cache[interval][1]])

    data_coverage: list[dict[str, Any]] = []
    all_summaries: list[dict[str, Any]] = []
    all_bars: list[dict[str, Any]] = []
    all_events: list[dict[str, Any]] = []

    for symbol in SYMBOLS:
        for interval in BASE_INTERVALS:
            try:
                bars = v42.yahoo_chart(symbol, interval)
                base = v42.attach_supply_features(bars, supply)
                features = v42.merge_aux_features(base, interval, aux_cache[interval][0])
            except Exception as exc:
                data_coverage.append(
                    {
                        "symbol": symbol,
                        "interval": interval,
                        "market_rows": 0,
                        "feature_rows": 0,
                        "status": "failed",
                        "error": f"{type(exc).__name__}: {exc}",
                    }
                )
                continue
            data_coverage.append(
                {
                    "symbol": symbol,
                    "interval": interval,
                    "market_rows": len(bars),
                    "feature_rows": len(features),
                    "start": features["timestamp"].min().isoformat() if len(features) else "",
                    "end": features["timestamp"].max().isoformat() if len(features) else "",
                    "status": "loaded" if len(features) else "empty_after_merge",
                }
            )

            for policy in policies_for(symbol, interval):
                rows, events, summary = evaluate_route(features, policy)
                if not summary:
                    continue
                summary["version"] = VERSION
                all_summaries.append(summary)
                all_bars.extend(rows)
                all_events.extend(events)
            print(
                f"[{VERSION}] evaluated {symbol} {interval}: "
                f"rows={len(features)} policies={len(policies_for(symbol, interval))}",
                flush=True,
            )

    summary_df = pd.DataFrame(all_summaries)
    if not summary_df.empty:
        summary_df = summary_df.sort_values(["status", "selection_score"], ascending=[True, False])
    selected = select_routes(summary_df)

    blocked: list[dict[str, Any]] = []
    if not summary_df.empty:
        for (symbol, interval), group in summary_df.groupby(["symbol", "interval"], sort=True):
            has_selected = any(row["symbol"] == symbol and row["interval"] == interval for row in selected)
            if has_selected:
                continue
            best = group.sort_values(["test_profit_factor", "test_net_pnl_usd"], ascending=False).iloc[0]
            reason = "no validation+test candidate"
            if float(best.get("test_profit_factor", 0.0)) < 1.0:
                reason = "blind test PF below 1"
            elif float(best.get("validation_profit_factor", 0.0)) < 1.05:
                reason = "validation PF weak"
            elif float(best.get("test_direction_hit_rate", 0.0)) < 0.50:
                reason = "test direction hit weak"
            blocked.append(
                {
                    "symbol": symbol,
                    "interval": interval,
                    "best_test_pf": float(best.get("test_profit_factor", 0.0)),
                    "best_test_pnl": float(best.get("test_net_pnl_usd", 0.0)),
                    "reason": reason,
                }
            )

    status = "energy_next_horizon_dynamic_candidate" if selected else "energy_next_horizon_watchlist_no_candidate"

    write_csv(OUT_DIR / "hfcd_commodity_v5_0_eia_series_metadata.csv", metadata)
    supply.to_csv(OUT_DIR / "hfcd_commodity_v5_0_eia_supply_features.csv", index=False)
    write_csv(OUT_DIR / "hfcd_commodity_v5_0_supply_forecast_accuracy.csv", forecast_rows)
    write_csv(OUT_DIR / "hfcd_commodity_v5_0_data_coverage.csv", data_coverage)
    write_csv(OUT_DIR / "hfcd_commodity_v5_0_sensor_coverage.csv", sensor_coverage)
    summary_df.to_csv(OUT_DIR / "hfcd_commodity_v5_0_route_summary.csv", index=False)
    write_csv(OUT_DIR / "hfcd_commodity_v5_0_selected_routes.csv", selected)
    write_csv(OUT_DIR / "hfcd_commodity_v5_0_blocked_routes.csv", blocked)
    write_csv(OUT_DIR / "hfcd_commodity_v5_0_bar_replay.csv", all_bars)
    write_csv(OUT_DIR / "hfcd_commodity_v5_0_position_events.csv", all_events)

    run_summary = {
        "version": VERSION,
        "generated_at": now_iso(),
        "runtime_seconds": round(time.time() - started, 3),
        "status": status,
        "route_count": len(all_summaries),
        "candidate_count": len(selected),
        "selected_routes": selected,
        "blocked_routes": blocked,
        "data_coverage": data_coverage,
        "sensor_coverage": sensor_coverage,
        "notes": [
            "Local research only; no real orders.",
            "Every bar receives a next-horizon prediction score.",
            "Dynamic replay can add, reduce, flatten, or reverse positions.",
            "Yahoo bars are public proxies; exchange-grade BBO/MBP costs are required before deployment.",
        ],
    }
    (OUT_DIR / "hfcd_commodity_v5_0_summary.json").write_text(
        json.dumps(run_summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (OUT_DIR / "HFCD_Commodity_V5_0_EnergyNextHorizonForecast.md").write_text(
        make_report(run_summary, selected, blocked), encoding="utf-8"
    )
    plot_results(selected, pd.DataFrame(all_bars), OUT_DIR / "HFCD_Commodity_V5_0_EnergyNextHorizonForecast.png")

    print(json.dumps({"status": status, "candidate_count": len(selected), "out_dir": str(OUT_DIR)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
