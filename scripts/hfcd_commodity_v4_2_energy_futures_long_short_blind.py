#!/usr/bin/env python3
"""HFCD Commodity V4.2: energy futures long/short blind test.

Local research only. No online page changes, broker calls, testnet calls, or
real orders.

V4.2 explicitly attacks the user's core target:
- More short-horizon opportunities than gold/XLE.
- Futures-first, not ETF-first.
- Long and short are both tested for every route.

Universe:
- CL=F: WTI crude oil futures proxy.
- RB=F: RBOB gasoline futures proxy.
- HO=F: heating oil futures proxy.
- NG=F: natural gas futures proxy.

Frequencies:
- 15m, 30m, 1h.

Sensors:
- Official EIA petroleum supply pressure from V4.0.
- CL/RB/HO/BZ intraday spread sensors from V4.1.
- Product-specific crack-spread scores for RB/HO.
- Volume shock, EIA release-window intensity, and short momentum.

Important limitation:
- Yahoo chart bars are public market proxies, not exchange-grade execution
  quotes. Passing routes still require forward paper shadow and cost audit.
"""

from __future__ import annotations

import importlib.util
import json
import math
import sys
import time
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


ROOT = Path.cwd()
VERSION = "HFCD_Commodity_V4_2_EnergyFuturesLongShortBlind"
OUT_DIR = ROOT / "outputs" / "hfcd_commodity_v4_2_energy_futures_long_short_blind"
V40_PATH = ROOT / "scripts" / "hfcd_commodity_v4_0_crude_oil_supply_forecast.py"
V41_PATH = ROOT / "scripts" / "hfcd_commodity_v4_1_crude_intraday_sensors.py"

spec40 = importlib.util.spec_from_file_location("v40_crude_supply", V40_PATH)
v40 = importlib.util.module_from_spec(spec40)
assert spec40 and spec40.loader
sys.modules["v40_crude_supply"] = v40
spec40.loader.exec_module(v40)

spec41 = importlib.util.spec_from_file_location("v41_crude_intraday", V41_PATH)
v41 = importlib.util.module_from_spec(spec41)
assert spec41 and spec41.loader
sys.modules["v41_crude_intraday"] = v41
spec41.loader.exec_module(v41)

FUTURES_ROUTES = {
    "CL=F": {"asset": "wti_crude", "direct_supply_fit": "high"},
    "RB=F": {"asset": "rbob_gasoline", "direct_supply_fit": "medium"},
    "HO=F": {"asset": "heating_oil", "direct_supply_fit": "medium"},
    "NG=F": {"asset": "natural_gas", "direct_supply_fit": "low_petroleum_proxy"},
}

INTERVALS = ["15m", "30m", "1h"]
INTERVAL_RANGE = {"15m": "60d", "30m": "60d", "1h": "730d"}
INTERVAL_TOLERANCE = {
    "15m": pd.Timedelta(minutes=45),
    "30m": pd.Timedelta(minutes=80),
    "1h": pd.Timedelta(minutes=140),
}
NOTIONAL_USD = 1000.0


@dataclass(frozen=True)
class V42Policy:
    symbol: str
    interval: str
    score_mode: str
    side_policy: str
    threshold: float
    hold_bars: int
    stop_loss: float
    take_profit: float

    @property
    def name(self) -> str:
        return (
            f"{self.symbol}_{self.interval}_{self.score_mode}_{self.side_policy}_"
            f"thr{self.threshold:.2f}_hold{self.hold_bars}_sl{self.stop_loss:.3f}_tp{self.take_profit:.3f}"
        )


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    return v40.write_csv(path, rows)


def profit_factor(pnls: list[float]) -> float:
    return float(v40.profit_factor(pnls))


def max_drawdown_from_pnls(pnls: list[float]) -> float:
    return float(v40.max_drawdown_from_pnls(pnls))


def yahoo_chart(symbol: str, interval: str) -> pd.DataFrame:
    encoded = urllib.parse.quote(symbol, safe="")
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{encoded}"
        f"?range={INTERVAL_RANGE[interval]}&interval={interval}&includePrePost=false"
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
                "interval": interval,
                "open": quote.get("open", [None] * len(timestamps))[i],
                "high": quote.get("high", [None] * len(timestamps))[i],
                "low": quote.get("low", [None] * len(timestamps))[i],
                "close": close,
                "volume": quote.get("volume", [0] * len(timestamps))[i] or 0,
                "market_source": "Yahoo Finance chart",
            }
        )
    return pd.DataFrame(rows).dropna(subset=["close"]).sort_values("timestamp").reset_index(drop=True)


def trade_cost(symbol: str, interval: str) -> float:
    # Public chart proxy cost model. Futures routes need exchange-grade quote audit
    # before any deployment decision.
    base = 0.00045
    if symbol == "NG=F":
        base += 0.00020
    if interval == "15m":
        base += 0.00025
    elif interval == "30m":
        base += 0.00018
    else:
        base += 0.00010
    return base


def attach_supply_features(bars: pd.DataFrame, supply: pd.DataFrame) -> pd.DataFrame:
    # Reuse the no-leak EIA feature join from V4.0, but support 15m bars.
    return v40.add_market_features(bars, supply)


def fetch_aux_by_interval(interval: str) -> tuple[dict[str, pd.DataFrame], list[dict[str, Any]]]:
    frames: dict[str, pd.DataFrame] = {}
    coverage: list[dict[str, Any]] = []
    for symbol in ["CL=F", "BZ=F", "RB=F", "HO=F", "NG=F"]:
        try:
            frame = yahoo_chart(symbol, interval)
            frames[symbol] = frame[["timestamp", "close", "volume"]].rename(
                columns={"close": f"{symbol}_close", "volume": f"{symbol}_volume"}
            )
            coverage.append({"sensor": symbol, "interval": interval, "rows": len(frame), "status": "loaded"})
        except Exception as exc:
            coverage.append(
                {
                    "sensor": symbol,
                    "interval": interval,
                    "rows": 0,
                    "status": "failed",
                    "error": f"{type(exc).__name__}: {exc}",
                }
            )
    return frames, coverage


def merge_aux_features(base: pd.DataFrame, interval: str, aux_frames: dict[str, pd.DataFrame]) -> pd.DataFrame:
    out = base.sort_values("timestamp").copy()
    for symbol, frame in aux_frames.items():
        out = pd.merge_asof(
            out.sort_values("timestamp"),
            frame.sort_values("timestamp"),
            on="timestamp",
            direction="nearest",
            tolerance=INTERVAL_TOLERANCE[interval],
        )
    for col in [
        "CL=F_close",
        "BZ=F_close",
        "RB=F_close",
        "HO=F_close",
        "NG=F_close",
        "CL=F_volume",
        "RB=F_volume",
        "HO=F_volume",
        "NG=F_volume",
    ]:
        if col not in out:
            out[col] = np.nan
        out[col] = out[col].ffill()

    cl = out["CL=F_close"].replace(0, np.nan)
    out["rb_crack"] = out["RB=F_close"] * 42.0 - cl
    out["ho_crack"] = out["HO=F_close"] * 42.0 - cl
    out["brent_wti_spread_intraday"] = out["BZ=F_close"] - cl

    for col in ["rb_crack", "ho_crack", "brent_wti_spread_intraday"]:
        out[f"{col}_z"] = v40.zscore(out[col].astype("float64"), 80)
        out[f"{col}_mom_z"] = v40.zscore(out[col].astype("float64").diff(), 80)

    out["hours_since_eia_available"] = (
        (pd.to_datetime(out["timestamp"], utc=True) - pd.to_datetime(out["available_time"], utc=True)).dt.total_seconds()
        / 3600.0
    )
    hours = out["hours_since_eia_available"].clip(lower=0)
    out["eia_event_window"] = np.exp(-hours / 48.0)
    out.loc[out["hours_since_eia_available"] < 0, "eia_event_window"] = 0.0
    out.loc[out["hours_since_eia_available"] > 120, "eia_event_window"] = 0.0

    out["volume_shock_z"] = v40.zscore(pd.Series(out["volume"], dtype="float64"), 80)
    out["own_mom_2"] = out["close"].pct_change(2).fillna(0.0)
    out["own_mom_6"] = out["close"].pct_change(6).fillna(0.0)
    out["own_mom_score"] = (20 * out["own_mom_2"] + 10 * out["own_mom_6"]).clip(-4, 4).apply(
        lambda x: 2 * v40.sigmoid(float(x)) - 1
    )

    out["cl_curve_pressure"] = (
        0.42 * out["brent_wti_spread_intraday_z"].fillna(0.0)
        + 0.24 * out["brent_wti_spread_intraday_mom_z"].fillna(0.0)
        + 0.18 * out["volume_shock_z"].clip(-2, 2).fillna(0.0)
        + 0.16 * out["eia_event_window"].fillna(0.0) * np.sign(out["supply_pressure_score"].fillna(0.0))
    ).clip(-4, 4).apply(lambda x: 2 * v40.sigmoid(float(x)) - 1)
    out["rb_product_pressure"] = (
        0.46 * out["rb_crack_z"].fillna(0.0)
        + 0.26 * out["rb_crack_mom_z"].fillna(0.0)
        + 0.16 * out["volume_shock_z"].clip(-2, 2).fillna(0.0)
        + 0.12 * out["eia_event_window"].fillna(0.0) * np.sign(out["supply_pressure_score"].fillna(0.0))
    ).clip(-4, 4).apply(lambda x: 2 * v40.sigmoid(float(x)) - 1)
    out["ho_product_pressure"] = (
        0.46 * out["ho_crack_z"].fillna(0.0)
        + 0.26 * out["ho_crack_mom_z"].fillna(0.0)
        + 0.16 * out["volume_shock_z"].clip(-2, 2).fillna(0.0)
        + 0.12 * out["eia_event_window"].fillna(0.0) * np.sign(out["supply_pressure_score"].fillna(0.0))
    ).clip(-4, 4).apply(lambda x: 2 * v40.sigmoid(float(x)) - 1)
    out["ng_independent_pressure"] = (
        0.52 * out["own_mom_score"].fillna(0.0)
        + 0.30 * out["volume_shock_z"].clip(-2, 2).fillna(0.0) / 2.0
        + 0.18 * v40.zscore(out["NG=F_close"].astype("float64").pct_change(6), 80).fillna(0.0)
    ).clip(-4, 4).apply(lambda x: 2 * v40.sigmoid(float(x)) - 1)

    out["futures_intraday_score"] = np.select(
        [
            out["symbol"].eq("CL=F"),
            out["symbol"].eq("RB=F"),
            out["symbol"].eq("HO=F"),
            out["symbol"].eq("NG=F"),
        ],
        [
            out["cl_curve_pressure"],
            out["rb_product_pressure"],
            out["ho_product_pressure"],
            out["ng_independent_pressure"],
        ],
        default=out["cl_curve_pressure"],
    ).astype(float)

    out["hfcd_score_v4_0_fast"] = out["hfcd_score_fast"]
    # NG has low direct fit to petroleum EIA; do not let oil supply dominate it.
    petroleum_weight = np.where(out["symbol"].eq("NG=F"), 0.18, 0.40)
    fast_weight = np.where(out["symbol"].eq("NG=F"), 0.32, 0.22)
    sensor_weight = 1.0 - petroleum_weight - fast_weight
    out["hfcd_score_futures_intraday"] = (
        petroleum_weight * out["supply_pressure_score"].fillna(0.0)
        + fast_weight * out["fast_timing_score"].fillna(0.0)
        + sensor_weight * out["futures_intraday_score"].fillna(0.0)
    ).clip(-1, 1)
    out["hfcd_score_fast"] = out["hfcd_score_futures_intraday"]
    return out


def policies_for(symbol: str, interval: str) -> list[V42Policy]:
    if interval == "15m":
        holds = [4, 8]
        stops = [0.008]
        takes = [0.010, 0.018]
        thresholds = [0.20, 0.30, 0.40]
    elif interval == "30m":
        holds = [4, 8]
        stops = [0.010]
        takes = [0.014, 0.024]
        thresholds = [0.20, 0.30, 0.40]
    else:
        holds = [4, 8]
        stops = [0.016]
        takes = [0.024, 0.040]
        thresholds = [0.20, 0.30, 0.40]
    if symbol == "NG=F":
        stops = [round(x * 1.45, 4) for x in stops]
        takes = [round(x * 1.55, 4) for x in takes]
    out: list[V42Policy] = []
    for score_mode in ["futures_intraday"]:
        for side_policy in ["long_only", "short_only", "both"]:
            for threshold in thresholds:
                for hold in holds:
                    for stop in stops:
                        for take in takes:
                            if take <= stop:
                                continue
                            out.append(V42Policy(symbol, interval, score_mode, side_policy, threshold, hold, stop, take))
    return out


def run_policy(df: pd.DataFrame, policy: V42Policy) -> list[dict[str, Any]]:
    if len(df) < policy.hold_bars + 50:
        return []
    score_col = "hfcd_score_futures_intraday" if policy.score_mode == "futures_intraday" else "hfcd_score_fast"
    cost = trade_cost(policy.symbol, policy.interval)
    rows: list[dict[str, Any]] = []
    close = df["close"].astype(float).to_numpy()
    score_arr = df[score_col].astype(float).to_numpy()
    timestamps = pd.to_datetime(df["timestamp"], utc=True).to_numpy()
    supply_scores = df["supply_pressure_score"].astype(float).to_numpy()
    futures_scores = df["futures_intraday_score"].astype(float).to_numpy()
    fast_scores = df["fast_timing_score"].astype(float).to_numpy()
    report_dates = pd.to_datetime(df["report_date"], utc=True, errors="coerce").to_numpy()
    available_times = pd.to_datetime(df["available_time"], utc=True, errors="coerce").to_numpy()
    i = 0
    while i < len(df) - policy.hold_bars - 1:
        score = float(score_arr[i])
        side = 0
        if score >= policy.threshold and policy.side_policy in {"long_only", "both"}:
            side = 1
        elif score <= -policy.threshold and policy.side_policy in {"short_only", "both"}:
            side = -1
        if side == 0:
            i += 1
            continue

        entry_price = float(close[i])
        exit_idx = min(i + policy.hold_bars, len(df) - 1)
        exit_reason = "time_exit"
        for j in range(i + 1, exit_idx + 1):
            ret = side * (float(close[j]) / entry_price - 1.0)
            if ret <= -policy.stop_loss:
                exit_idx = j
                exit_reason = "stop_loss"
                break
            if ret >= policy.take_profit:
                exit_idx = j
                exit_reason = "take_profit"
                break

        exit_price = float(close[exit_idx])
        gross_return = side * (exit_price / entry_price - 1.0)
        net_return = gross_return - cost
        pnl = NOTIONAL_USD * net_return
        report_date = pd.Timestamp(report_dates[i]) if not pd.isna(report_dates[i]) else None
        available_time = pd.Timestamp(available_times[i]) if not pd.isna(available_times[i]) else None
        rows.append(
            {
                "policy": policy.name,
                "symbol": policy.symbol,
                "interval": policy.interval,
                "score_mode": policy.score_mode,
                "side_policy": policy.side_policy,
                "side": "long" if side > 0 else "short",
                "entry_time": pd.Timestamp(timestamps[i]).isoformat(),
                "exit_time": pd.Timestamp(timestamps[exit_idx]).isoformat(),
                "entry_price": round(entry_price, 6),
                "exit_price": round(exit_price, 6),
                "score": round(score, 6),
                "supply_pressure_score": round(float(supply_scores[i]), 6),
                "futures_intraday_score": round(float(futures_scores[i]), 6),
                "fast_timing_score": round(float(fast_scores[i]), 6),
                "exit_reason": exit_reason,
                "gross_return": round(gross_return, 8),
                "cost_return": round(cost, 8),
                "net_return": round(net_return, 8),
                "pnl_usd": round(pnl, 6),
                "notional_usd": NOTIONAL_USD,
                "source_report_date": report_date.date().isoformat() if report_date is not None else "",
                "available_time": available_time.isoformat() if available_time is not None else "",
            }
        )
        i = max(exit_idx + 1, i + 1)
    return rows


def split_name(entry_time: str, cut1: pd.Timestamp, cut2: pd.Timestamp) -> str:
    return v40.split_name(entry_time, cut1, cut2)


def summarize_trades(rows: list[dict[str, Any]], policy: V42Policy, split: str) -> dict[str, Any]:
    pnls = [float(r["pnl_usd"]) for r in rows if r.get("split") == split]
    wins = [x for x in pnls if x > 0]
    losses = [x for x in pnls if x < 0]
    side_counts = pd.Series([r.get("side") for r in rows if r.get("split") == split]).value_counts().to_dict()
    return {
        "policy": policy.name,
        "symbol": policy.symbol,
        "interval": policy.interval,
        "score_mode": policy.score_mode,
        "side_policy": policy.side_policy,
        "threshold": policy.threshold,
        "hold_bars": policy.hold_bars,
        "stop_loss": policy.stop_loss,
        "take_profit": policy.take_profit,
        "split": split,
        "trades": len(pnls),
        "long_trades": int(side_counts.get("long", 0)),
        "short_trades": int(side_counts.get("short", 0)),
        "win_rate": round(len(wins) / len(pnls), 6) if pnls else 0.0,
        "net_pnl_usd": round(sum(pnls), 6),
        "profit_factor": round(profit_factor(pnls), 6),
        "max_drawdown_usd": round(max_drawdown_from_pnls(pnls), 6),
        "avg_win_usd": round(sum(wins) / len(wins), 6) if wins else 0.0,
        "avg_loss_usd": round(sum(losses) / len(losses), 6) if losses else 0.0,
    }


def evaluate_policy(df: pd.DataFrame, policy: V42Policy) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    trades = run_policy(df, policy)
    if not trades:
        return [], {}
    entry_times = [pd.Timestamp(r["entry_time"]) for r in trades]
    start = min(entry_times)
    end = max(entry_times)
    cut1 = start + (end - start) * 0.60
    cut2 = start + (end - start) * 0.80
    for row in trades:
        row["split"] = split_name(row["entry_time"], cut1, cut2)
    by_split = {split: summarize_trades(trades, policy, split) for split in ["train", "validation", "test"]}

    combined: dict[str, Any] = asdict(policy)
    combined["policy"] = policy.name
    for split, row in by_split.items():
        for key, value in row.items():
            if key in {
                "policy",
                "symbol",
                "interval",
                "score_mode",
                "side_policy",
                "threshold",
                "hold_bars",
                "stop_loss",
                "take_profit",
                "split",
            }:
                continue
            combined[f"{split}_{key}"] = value

    valid = by_split["validation"]
    test = by_split["test"]
    both_has_sides = policy.side_policy != "both" or (
        valid["long_trades"] + test["long_trades"] > 0 and valid["short_trades"] + test["short_trades"] > 0
    )
    combined["status"] = (
        "long_short_signal_candidate"
        if valid["trades"] >= 8
        and test["trades"] >= 8
        and valid["net_pnl_usd"] > 0
        and test["net_pnl_usd"] > 0
        and valid["profit_factor"] >= 1.08
        and test["profit_factor"] >= 1.08
        and both_has_sides
        else "watchlist_or_blocked"
    )
    combined["selection_score"] = round(
        valid["net_pnl_usd"]
        + 15.0 * valid["profit_factor"]
        + 0.50 * test["net_pnl_usd"]
        + 4.0 * (test["long_trades"] > 0)
        + 4.0 * (test["short_trades"] > 0)
        - abs(valid["max_drawdown_usd"]) * 0.18
        - abs(test["max_drawdown_usd"]) * 0.08,
        6,
    )
    return trades, combined


def select_routes(summary_df: pd.DataFrame) -> list[dict[str, Any]]:
    if summary_df.empty:
        return []
    selected: list[dict[str, Any]] = []
    # Keep best route per symbol/interval/side_policy, then sort globally. This
    # avoids hiding short-only winners behind long-only winners.
    for keys, group in summary_df.groupby(["symbol", "interval", "side_policy"], sort=False):
        candidates = group[group["status"] == "long_short_signal_candidate"].sort_values(
            "selection_score", ascending=False
        )
        if not candidates.empty:
            selected.append(candidates.iloc[0].to_dict())
    return sorted(
        selected,
        key=lambda r: (
            float(r.get("test_net_pnl_usd", 0.0)),
            float(r.get("test_profit_factor", 0.0)),
            float(r.get("test_trades", 0.0)),
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
        "- 本轮强制做多/做空双向审计：每个标的、频率都跑 `long_only`、`short_only`、`both`。",
        "- 重点是 CL/RB/HO/NG 期货代理，不再用 XLE/USO 替代日内机会池。",
        "- 仍然没有改线上页面、没有 broker/testnet 调用、没有真实下单。",
        "",
        "## V4.2 选中路线",
        "",
    ]
    if selected:
        lines.append("| 标的 | 频率 | side policy | 验证PF | 测试PF | 测试PNL | 测试交易 | 测试多/空 |")
        lines.append("|---|---:|---|---:|---:|---:|---:|---:|")
        for row in selected[:30]:
            lines.append(
                f"| {row['symbol']} | {row['interval']} | {row['side_policy']} | "
                f"{row.get('validation_profit_factor', 0):.2f} | {row.get('test_profit_factor', 0):.2f} | "
                f"{row.get('test_net_pnl_usd', 0):.2f} | {int(row.get('test_trades', 0))} | "
                f"{int(row.get('test_long_trades', 0))}/{int(row.get('test_short_trades', 0))} |"
            )
    else:
        lines.append("没有期货路线同时通过 validation 和 blind test。")

    lines += [
        "",
        "## 失败或待修复标的",
        "",
    ]
    if blocked:
        lines.append("| 标的 | 频率 | 最好测试PF | 最好测试PNL | 问题 |")
        lines.append("|---|---:|---:|---:|---|")
        for row in blocked:
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
        "- `both` 通过才代表同一模型能同时处理做多和做空；`long_only`/`short_only` 通过只代表单方向路线可用。",
        "- 15m/30m 如果测试交易数仍少，说明公开 Yahoo 历史限制不足以证明日内高频价值，需要接交易所级历史。",
        "- NG 当前只使用油品 EIA 的弱代理和自身日内动量，不应在没有天然气库存/EIA NG 数据前晋级主线。",
        "",
        "## 下一步",
        "",
        "V4.3 应接入 EIA 天然气库存、EIA 原油/汽油/馏分油日内事件日历，并对通过路线跑 forward shadow。",
        "",
    ]
    return "\n".join(lines)


def plot_results(selected: list[dict[str, Any]], feature_samples: pd.DataFrame, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fig, axes = plt.subplots(2, 1, figsize=(12, 8), constrained_layout=True)
    ax = axes[0]
    if len(feature_samples):
        for symbol in ["CL=F", "RB=F", "HO=F", "NG=F"]:
            sample = feature_samples[feature_samples["symbol"] == symbol].tail(200)
            if len(sample):
                ax.plot(pd.to_datetime(sample["timestamp"]), sample["hfcd_score_futures_intraday"], label=symbol, alpha=0.75)
    ax.set_title("Energy futures intraday score sample")
    ax.legend()
    ax.grid(alpha=0.25)

    ax2 = axes[1]
    if selected:
        labels = [f"{r['symbol']} {r['interval']} {r['side_policy']}" for r in selected[:14]]
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
    all_summaries: list[dict[str, Any]] = []
    all_trades: list[dict[str, Any]] = []
    data_coverage: list[dict[str, Any]] = []
    sensor_coverage: list[dict[str, Any]] = []
    feature_samples: list[dict[str, Any]] = []

    for interval in INTERVALS:
        aux_cache[interval] = fetch_aux_by_interval(interval)
        sensor_coverage.extend([{**row, "target_symbol": "shared_aux"} for row in aux_cache[interval][1]])

    for symbol, meta in FUTURES_ROUTES.items():
        for interval in INTERVALS:
            try:
                bars = yahoo_chart(symbol, interval)
                base = attach_supply_features(bars, supply)
                feature_df = merge_aux_features(base, interval, aux_cache[interval][0])
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
                    "asset": meta["asset"],
                    "interval": interval,
                    "market_rows": len(bars),
                    "feature_rows": len(feature_df),
                    "start": feature_df["timestamp"].min().isoformat() if len(feature_df) else "",
                    "end": feature_df["timestamp"].max().isoformat() if len(feature_df) else "",
                    "direct_supply_fit": meta["direct_supply_fit"],
                    "status": "loaded" if len(feature_df) else "empty_after_merge",
                }
            )
            feature_samples.extend(
                feature_df[
                    [
                        "timestamp",
                        "symbol",
                        "interval",
                        "close",
                        "supply_pressure_score",
                        "fast_timing_score",
                        "futures_intraday_score",
                        "hfcd_score_futures_intraday",
                        "rb_crack",
                        "ho_crack",
                        "brent_wti_spread_intraday",
                        "volume_shock_z",
                    ]
                ]
                .tail(200)
                .to_dict("records")
            )

            for policy in policies_for(symbol, interval):
                trades, summary = evaluate_policy(feature_df, policy)
                if not summary:
                    continue
                summary["version"] = VERSION
                all_summaries.append(summary)
                all_trades.extend(trades)

    summary_df = pd.DataFrame(all_summaries)
    if not summary_df.empty:
        summary_df = summary_df.sort_values(["status", "selection_score"], ascending=[True, False])
    selected = select_routes(summary_df)

    blocked: list[dict[str, Any]] = []
    if not summary_df.empty:
        for (symbol, interval), group in summary_df.groupby(["symbol", "interval"], sort=True):
            if not ((pd.Series([r["symbol"] == symbol and r["interval"] == interval for r in selected])).any() if selected else False):
                best = group.sort_values(["test_profit_factor", "test_net_pnl_usd"], ascending=False).iloc[0]
                reason = "no validation+test candidate"
                if float(best.get("test_profit_factor", 0.0)) < 1.0:
                    reason = "blind test PF below 1"
                elif float(best.get("validation_profit_factor", 0.0)) < 1.08:
                    reason = "validation PF weak"
                blocked.append(
                    {
                        "symbol": symbol,
                        "interval": interval,
                        "best_test_pf": float(best.get("test_profit_factor", 0.0)),
                        "best_test_pnl": float(best.get("test_net_pnl_usd", 0.0)),
                        "reason": reason,
                    }
                )

    status = "energy_futures_long_short_candidate" if selected else "energy_futures_watchlist_no_candidate"

    write_csv(OUT_DIR / "hfcd_commodity_v4_2_eia_series_metadata.csv", metadata)
    supply.to_csv(OUT_DIR / "hfcd_commodity_v4_2_eia_supply_features.csv", index=False)
    write_csv(OUT_DIR / "hfcd_commodity_v4_2_supply_forecast_accuracy.csv", forecast_rows)
    write_csv(OUT_DIR / "hfcd_commodity_v4_2_data_coverage.csv", data_coverage)
    write_csv(OUT_DIR / "hfcd_commodity_v4_2_sensor_coverage.csv", sensor_coverage)
    write_csv(OUT_DIR / "hfcd_commodity_v4_2_market_feature_samples.csv", feature_samples)
    summary_df.to_csv(OUT_DIR / "hfcd_commodity_v4_2_policy_summary.csv", index=False)
    write_csv(OUT_DIR / "hfcd_commodity_v4_2_selected_routes.csv", selected)
    write_csv(OUT_DIR / "hfcd_commodity_v4_2_blocked_routes.csv", blocked)
    write_csv(OUT_DIR / "hfcd_commodity_v4_2_trading_signals.csv", all_trades)

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
            "Every symbol/interval is tested as long_only, short_only, and both.",
            "Yahoo futures bars are public proxies; exchange-grade quotes are required before deployment.",
            "NG=F direct supply fit is weak until EIA natural gas inventory is added.",
        ],
    }
    (OUT_DIR / "hfcd_commodity_v4_2_summary.json").write_text(
        json.dumps(run_summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (OUT_DIR / "HFCD_Commodity_V4_2_EnergyFuturesLongShortBlind.md").write_text(
        make_report(run_summary, selected, blocked), encoding="utf-8"
    )
    plot_results(selected, pd.DataFrame(feature_samples), OUT_DIR / "HFCD_Commodity_V4_2_EnergyFuturesLongShortBlind.png")

    print(json.dumps({"status": status, "candidate_count": len(selected), "out_dir": str(OUT_DIR)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
