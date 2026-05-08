#!/usr/bin/env python3
"""HFCD Commodity V4.1: crude oil intraday sensor density.

Local research only. No online page changes, broker calls, testnet calls, or
real orders.

V4.1 keeps the V4.0 official EIA supply layer and adds intraday tradable
proxies:
- CL/RB/HO product crack spread pressure.
- Brent-WTI spread pressure.
- EIA release-window event intensity.
- Volume shock and short momentum timing.

Purpose:
- Increase signal density without lowering thresholds blindly.
- Re-test CL/USO/XLE on 30m, 1h, and 1d.
"""

from __future__ import annotations

import importlib.util
import json
import math
import sys
import time
from dataclasses import asdict
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


ROOT = Path.cwd()
VERSION = "HFCD_Commodity_V4_1_CrudeIntradaySensors"
OUT_DIR = ROOT / "outputs" / "hfcd_commodity_v4_1_crude_intraday_sensors"
V40_PATH = ROOT / "scripts" / "hfcd_commodity_v4_0_crude_oil_supply_forecast.py"

spec = importlib.util.spec_from_file_location("v40_crude_supply", V40_PATH)
v40 = importlib.util.module_from_spec(spec)
assert spec and spec.loader
sys.modules["v40_crude_supply"] = v40
spec.loader.exec_module(v40)

INTRADAY_TICKERS = ["CL=F", "BZ=F", "RB=F", "HO=F"]
INTERVAL_TOLERANCE = {"30m": pd.Timedelta(minutes=80), "1h": pd.Timedelta(minutes=140), "1d": pd.Timedelta(days=3)}


def safe_n(value: Any, digits: int = 6) -> float:
    try:
        out = float(value)
        if not math.isfinite(out):
            return 0.0
        return round(out, digits)
    except Exception:
        return 0.0


def fetch_aux_bars(interval: str) -> tuple[dict[str, pd.DataFrame], list[dict[str, Any]]]:
    frames: dict[str, pd.DataFrame] = {}
    coverage: list[dict[str, Any]] = []
    for symbol in INTRADAY_TICKERS:
        try:
            frame = v40.yahoo_chart(symbol, interval)
            frame = frame[["timestamp", "close"]].rename(columns={"close": f"{symbol}_close"})
            frames[symbol] = frame
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


def merge_intraday_sensors(base: pd.DataFrame, interval: str) -> tuple[pd.DataFrame, list[dict[str, Any]]]:
    out = base.sort_values("timestamp").copy()
    frames, coverage = fetch_aux_bars(interval)
    tolerance = INTERVAL_TOLERANCE[interval]
    for symbol, frame in frames.items():
        out = pd.merge_asof(
            out.sort_values("timestamp"),
            frame.sort_values("timestamp"),
            on="timestamp",
            direction="nearest",
            tolerance=tolerance,
        )

    for col in ["CL=F_close", "BZ=F_close", "RB=F_close", "HO=F_close"]:
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
    out["spread_pressure_score"] = (
        0.24 * out["rb_crack_z"].fillna(0.0)
        + 0.24 * out["ho_crack_z"].fillna(0.0)
        + 0.15 * out["rb_crack_mom_z"].fillna(0.0)
        + 0.15 * out["ho_crack_mom_z"].fillna(0.0)
        + 0.12 * out["brent_wti_spread_intraday_z"].fillna(0.0)
        + 0.10 * out["brent_wti_spread_intraday_mom_z"].fillna(0.0)
    ).clip(-4, 4).apply(lambda x: 2 * v40.sigmoid(float(x)) - 1)
    out["event_pressure_score"] = (
        out["eia_event_window"].fillna(0.0)
        * np.sign(out["supply_pressure_score"].fillna(0.0))
        * (0.45 + 0.12 * out["volume_shock_z"].clip(-2, 2).fillna(0.0))
    ).clip(-1, 1)
    out["intraday_sensor_score"] = (
        0.62 * out["spread_pressure_score"].fillna(0.0)
        + 0.24 * out["event_pressure_score"].fillna(0.0)
        + 0.14 * out["volume_shock_z"].clip(-2, 2).fillna(0.0) / 2.0
    ).clip(-1, 1)
    out["hfcd_score_v4_0_fast"] = out["hfcd_score_fast"]
    out["hfcd_score_fast"] = (
        0.50 * out["supply_pressure_score"].fillna(0.0)
        + 0.20 * out["fast_timing_score"].fillna(0.0)
        + 0.30 * out["intraday_sensor_score"].fillna(0.0)
    ).clip(-1, 1)
    return out, coverage


def policies_for_v41(symbol: str, interval: str) -> list[Any]:
    if interval == "30m":
        holds = [4, 8]
        stops = [0.009]
        takes = [0.016, 0.026]
    elif interval == "1h":
        holds = [4, 8]
        stops = [0.012, 0.018]
        takes = [0.026, 0.040]
    else:
        holds = [1, 3]
        stops = [0.012, 0.020]
        takes = [0.024, 0.040]
    thresholds = [0.20, 0.28, 0.36, 0.44]
    out = []
    for use_fast in [False, True]:
        for threshold in thresholds:
            for hold in holds:
                for stop in stops:
                    for take in takes:
                        if take <= stop:
                            continue
                        out.append(v40.Policy(symbol, interval, threshold, hold, stop, take, use_fast))
    return out


def make_v41_report(summary: dict[str, Any], selected: list[dict[str, Any]], v40_compare: list[dict[str, Any]]) -> str:
    lines = [
        f"# {VERSION}",
        "",
        "## 结论",
        "",
        f"- 状态：`{summary['status']}`",
        f"- 路线总数：`{summary['route_count']}`；候选路线：`{summary['candidate_count']}`。",
        "- 新增传感器：`RB/HO crack spread`、`Brent-WTI`、`EIA release window`、`volume shock`。",
        "- 仍然没有改线上页面、没有 broker/testnet 调用、没有真实下单。",
        "",
        "## V4.1 选中路线",
        "",
    ]
    if selected:
        lines.append("| 标的 | 频率 | 模式 | 验证PF | 测试PF | 测试PNL | 测试交易数 |")
        lines.append("|---|---:|---|---:|---:|---:|---:|")
        for row in selected[:20]:
            mode = "供给+日内传感器" if row["use_fast_timing"] else "纯供给"
            lines.append(
                f"| {row['symbol']} | {row['interval']} | {mode} | "
                f"{row.get('validation_profit_factor', 0):.2f} | {row.get('test_profit_factor', 0):.2f} | "
                f"{row.get('test_net_pnl_usd', 0):.2f} | {int(row.get('test_trades', 0))} |"
            )
    else:
        lines.append("没有路线同时通过 validation 和 blind test。")
    lines += [
        "",
        "## 与 V4.0 的关系",
        "",
    ]
    if v40_compare:
        lines.append("| 标的 | 频率 | V4.0测试PF | V4.0测试PNL |")
        lines.append("|---|---:|---:|---:|")
        for row in v40_compare:
            lines.append(
                f"| {row.get('symbol')} | {row.get('interval')} | "
                f"{float(row.get('test_profit_factor', 0)):.2f} | {float(row.get('test_net_pnl_usd', 0)):.2f} |"
            )
    else:
        lines.append("未发现 V4.0 选中路线文件。")
    lines += [
        "",
        "## 判断",
        "",
        "- 如果 30m / 1h 的候选交易数明显增加且测试 PF 不退化，才适合接前向账本。",
        "- 如果只提升了 XLE/USO 的日线结果，说明供给预测有效但还没有达到“每天多次”的目标。",
        "- 下一步不应直接上线，应做 V4.2 forward paper shadow，持续记录日内传感器可用性和真实滑点代理。",
        "",
    ]
    return "\n".join(lines)


def plot_v41(selected: list[dict[str, Any]], feature_samples: pd.DataFrame, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fig, axes = plt.subplots(2, 1, figsize=(12, 8), constrained_layout=True)
    ax = axes[0]
    if not feature_samples.empty:
        sample = feature_samples[feature_samples["symbol"] == "CL=F"].copy()
        if len(sample):
            ax.plot(pd.to_datetime(sample["timestamp"]), sample["supply_pressure_score"], label="supply", alpha=0.7)
            ax.plot(pd.to_datetime(sample["timestamp"]), sample["intraday_sensor_score"], label="intraday", alpha=0.7)
            ax.plot(pd.to_datetime(sample["timestamp"]), sample["hfcd_score_fast"], label="combined", alpha=0.9)
    ax.set_title("CL intraday sensor overlay sample")
    ax.legend()
    ax.grid(alpha=0.25)

    ax2 = axes[1]
    if selected:
        labels = [f"{r['symbol']} {r['interval']}" for r in selected[:12]]
        values = [float(r.get("test_net_pnl_usd", 0.0)) for r in selected[:12]]
        ax2.bar(labels, values, color=["#059669" if v >= 0 else "#dc2626" for v in values])
        ax2.tick_params(axis="x", rotation=35)
    ax2.set_title("V4.1 selected route blind-test PnL")
    ax2.grid(axis="y", alpha=0.25)
    fig.savefig(path, dpi=160)
    plt.close(fig)


def main() -> None:
    started = time.time()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    eia, metadata = v40.load_eia_series(v40.SERIES)
    supply = v40.build_supply_features(eia)
    forecast_rows = v40.forecast_accuracy_rows(supply)

    all_summaries: list[dict[str, Any]] = []
    all_trades: list[dict[str, Any]] = []
    feature_samples: list[dict[str, Any]] = []
    data_coverage: list[dict[str, Any]] = []
    sensor_coverage: list[dict[str, Any]] = []

    for symbol, config in v40.MARKET_ROUTES.items():
        for interval in config["intervals"]:
            try:
                bars = v40.yahoo_chart(symbol, interval)
                base_features = v40.add_market_features(bars, supply)
                feature_df, coverage = merge_intraday_sensors(base_features, interval)
                sensor_coverage.extend([{**row, "target_symbol": symbol} for row in coverage])
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
                    "feature_rows": len(feature_df),
                    "start": feature_df["timestamp"].min().isoformat() if len(feature_df) else "",
                    "end": feature_df["timestamp"].max().isoformat() if len(feature_df) else "",
                    "intraday_sensor_nonnull": int(feature_df["intraday_sensor_score"].notna().sum()),
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
                        "spread_pressure_score",
                        "event_pressure_score",
                        "intraday_sensor_score",
                        "hfcd_score_v4_0_fast",
                        "hfcd_score_fast",
                        "rb_crack",
                        "ho_crack",
                        "brent_wti_spread_intraday",
                        "supply_regime",
                    ]
                ]
                .tail(200)
                .to_dict("records")
            )

            for policy in policies_for_v41(symbol, interval):
                trades, summary = v40.evaluate_policy(feature_df, policy)
                if not summary:
                    continue
                summary["version"] = VERSION
                all_summaries.append(summary)
                all_trades.extend(trades)

    summary_df = pd.DataFrame(all_summaries)
    if not summary_df.empty:
        summary_df = summary_df.sort_values(["status", "selection_score"], ascending=[True, False])

    selected: list[dict[str, Any]] = []
    for (symbol, interval), group in summary_df.groupby(["symbol", "interval"], sort=False):
        candidates = group[group["status"] == "supply_signal_candidate"].sort_values("selection_score", ascending=False)
        if not candidates.empty:
            selected.append(candidates.iloc[0].to_dict())
    selected = sorted(selected, key=lambda r: (float(r.get("test_net_pnl_usd", 0.0)), float(r.get("test_profit_factor", 0.0))), reverse=True)

    v40_selected_path = ROOT / "outputs" / "hfcd_commodity_v4_0_crude_oil_supply_forecast" / "hfcd_commodity_v4_0_selected_routes.csv"
    v40_compare = pd.read_csv(v40_selected_path).to_dict("records") if v40_selected_path.exists() else []

    status = "crude_intraday_signal_candidate" if selected else "research_watchlist_no_intraday_promotion"

    v40.write_csv(OUT_DIR / "hfcd_commodity_v4_1_eia_series_metadata.csv", metadata)
    supply.to_csv(OUT_DIR / "hfcd_commodity_v4_1_eia_supply_features.csv", index=False)
    v40.write_csv(OUT_DIR / "hfcd_commodity_v4_1_supply_forecast_accuracy.csv", forecast_rows)
    v40.write_csv(OUT_DIR / "hfcd_commodity_v4_1_data_coverage.csv", data_coverage)
    v40.write_csv(OUT_DIR / "hfcd_commodity_v4_1_intraday_sensor_coverage.csv", sensor_coverage)
    v40.write_csv(OUT_DIR / "hfcd_commodity_v4_1_market_feature_samples.csv", feature_samples)
    summary_df.to_csv(OUT_DIR / "hfcd_commodity_v4_1_policy_summary.csv", index=False)
    v40.write_csv(OUT_DIR / "hfcd_commodity_v4_1_selected_routes.csv", selected)
    v40.write_csv(OUT_DIR / "hfcd_commodity_v4_1_trading_signals.csv", all_trades)

    run_summary = {
        "version": VERSION,
        "generated_at": v40.now_iso(),
        "runtime_seconds": round(time.time() - started, 3),
        "status": status,
        "candidate_count": len(selected),
        "route_count": len(all_summaries),
        "selected_routes": selected,
        "v4_0_selected_routes": v40_compare,
        "data_coverage": data_coverage,
        "sensor_coverage": sensor_coverage,
        "notes": [
            "Local research only; no real orders.",
            "V4.1 increases signal density with crack spread, Brent-WTI, event-window, and volume shock sensors.",
            "Yahoo public futures/ETF bars are market proxies, not exchange-grade execution data.",
        ],
    }
    (OUT_DIR / "hfcd_commodity_v4_1_summary.json").write_text(
        json.dumps(run_summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (OUT_DIR / "HFCD_Commodity_V4_1_CrudeIntradaySensors.md").write_text(
        make_v41_report(run_summary, selected, v40_compare),
        encoding="utf-8",
    )
    plot_v41(selected, pd.DataFrame(feature_samples), OUT_DIR / "HFCD_Commodity_V4_1_CrudeIntradaySensors.png")

    print(json.dumps({"status": status, "candidate_count": len(selected), "out_dir": str(OUT_DIR)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
