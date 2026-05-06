#!/usr/bin/env python3
"""
HFCD Trading V1.18 Gold Walk-Forward Validation

This is a bounded local validation stage. It compares:
- V1.9 gold ETF long-history heritage baseline.
- V1.16/V1.17 gold sensor fusion on the available 2026-04 -> 2026-05
  Databento GC window.

The key constraint is explicit: current Databento GC history is a short window,
and V1.17 L2 is a bounded sample. This script does not claim live readiness.
"""

from __future__ import annotations

import csv
import json
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


VERSION = "HFCD_Trading_V1_18_GoldWalkForward"
ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v1_18_gold_walk_forward"
V19_DIR = ROOT / "outputs" / "hfcd_trading_v1_9_asset_heritage_selector"
V16_DIR = ROOT / "outputs" / "hfcd_trading_v1_16_gold_full_acquisition"
V17_DIR = ROOT / "outputs" / "hfcd_trading_v1_17_gold_risk_l2_margin"
NOTIONAL_USD = 10_000.0
ROUND_TRIP_FEE_RATE = 0.00035


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    fieldnames: list[str] = []
    for row in rows:
        for key in row:
            if key not in fieldnames:
                fieldnames.append(key)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def load_csv(path: Path) -> pd.DataFrame:
    if not path.exists() or path.stat().st_size == 0:
        return pd.DataFrame()
    return pd.read_csv(path)


def zscore(series: pd.Series, window: int = 10) -> pd.Series:
    mean = series.rolling(window, min_periods=5).mean().shift(1)
    std = series.rolling(window, min_periods=5).std(ddof=0).shift(1)
    return ((series - mean) / std.replace(0, np.nan)).replace([np.inf, -np.inf], np.nan).fillna(0.0)


def max_drawdown(values: list[float]) -> float:
    if not values:
        return 0.0
    equity = np.cumsum(values)
    peak = np.maximum.accumulate(equity)
    dd = equity - peak
    return float(dd.min()) if len(dd) else 0.0


def metrics(pnls: list[float]) -> dict[str, Any]:
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]
    gross_win = sum(wins)
    gross_loss = abs(sum(losses))
    return {
        "trades": len(pnls),
        "win_rate": len(wins) / len(pnls) if pnls else 0.0,
        "net_pnl_usd": float(sum(pnls)),
        "max_drawdown_usd": max_drawdown(pnls),
        "profit_factor": float(gross_win / gross_loss) if gross_loss > 0 else (999.0 if gross_win > 0 else 0.0),
        "avg_pnl_usd": float(np.mean(pnls)) if pnls else 0.0,
    }


def build_gold_feature_table() -> pd.DataFrame:
    term = load_csv(V16_DIR / "hfcd_trading_v1_16_gc_term_structure_roll_yield_history.csv")
    oi = load_csv(V16_DIR / "hfcd_trading_v1_16_gc_daily_oi_candidate_history.csv")
    macro = load_csv(V16_DIR / "hfcd_trading_v1_16_macro_dxy_vix.csv")
    if term.empty:
        return pd.DataFrame()

    term["date"] = pd.to_datetime(term["date"]).dt.date.astype(str)
    front = term[term["symbol"] == term["front_symbol"]].copy()
    front = front.sort_values(["date", "front_symbol"]).drop_duplicates("date", keep="first")
    next_curve = term[term["symbol"] != term["front_symbol"]].sort_values(["date", "days_to_expiry"]).groupby("date").head(1)
    curve_agg = term[term["symbol"] != term["front_symbol"]].groupby("date", as_index=False).agg(
        curve_spread_mean=("spread_to_front", "mean"),
        curve_roll_yield_mean=("roll_yield_proxy", "mean"),
        curve_contracts=("symbol", "count"),
    )

    daily = front[["date", "front_symbol", "front_close", "front_expiration"]].merge(
        next_curve[["date", "symbol", "spread_to_front", "roll_yield_proxy", "days_to_expiry"]].rename(
            columns={
                "symbol": "next_symbol",
                "spread_to_front": "next_spread_to_front",
                "roll_yield_proxy": "next_roll_yield_proxy",
                "days_to_expiry": "next_days_to_expiry",
            }
        ),
        on="date",
        how="left",
    )
    daily = daily.merge(curve_agg, on="date", how="left")

    if not oi.empty:
        oi["date"] = pd.to_datetime(oi["date"]).dt.date.astype(str)
        oi_total = oi.groupby("date", as_index=False).agg(total_oi=("quantity", "sum"), oi_contracts=("symbol", "count"))
        daily = daily.merge(oi_total, on="date", how="left")
        daily = daily.merge(
            oi[["date", "symbol", "quantity"]].rename(columns={"symbol": "front_symbol", "quantity": "front_oi"}),
            on=["date", "front_symbol"],
            how="left",
        )

    if not macro.empty:
        macro = macro.copy()
        macro["date"] = pd.to_datetime(macro["ts"]).dt.date.astype(str)
        macro_wide = macro.pivot_table(index="date", columns="symbol", values="value", aggfunc="last").reset_index()
        daily = daily.merge(macro_wide, on="date", how="left")

    daily = daily.sort_values("date").reset_index(drop=True)
    daily["front_ret_1d"] = daily["front_close"].pct_change()
    daily["front_ret_next"] = daily["front_close"].shift(-1) / daily["front_close"] - 1
    daily["momentum_3d"] = daily["front_close"].pct_change(3)
    daily["momentum_5d"] = daily["front_close"].pct_change(5)
    daily["volatility_5d"] = daily["front_ret_1d"].rolling(5, min_periods=3).std()
    daily["vix_delta_3d"] = daily.get("VIXCLS", pd.Series(index=daily.index, dtype=float)).diff(3)
    daily["dollar_delta_3d"] = daily.get("DTWEXBGS", pd.Series(index=daily.index, dtype=float)).diff(3)
    daily["total_oi_delta_3d"] = daily.get("total_oi", pd.Series(index=daily.index, dtype=float)).pct_change(3)
    daily["front_oi_delta_3d"] = daily.get("front_oi", pd.Series(index=daily.index, dtype=float)).pct_change(3)

    daily["z_momentum_3d"] = zscore(daily["momentum_3d"])
    daily["z_dollar_delta_3d"] = zscore(daily["dollar_delta_3d"])
    daily["z_vix_delta_3d"] = zscore(daily["vix_delta_3d"])
    daily["z_total_oi_delta_3d"] = zscore(daily["total_oi_delta_3d"].fillna(0.0))
    daily["z_curve_roll_yield"] = zscore(daily["curve_roll_yield_mean"].fillna(0.0))

    daily["baseline_score"] = daily["z_momentum_3d"]
    daily["sensor_fusion_score"] = (
        0.42 * daily["z_momentum_3d"]
        - 0.24 * daily["z_dollar_delta_3d"]
        + 0.14 * daily["z_vix_delta_3d"]
        + 0.12 * daily["z_total_oi_delta_3d"]
        + 0.08 * daily["z_curve_roll_yield"]
    )
    daily["sensor_gate"] = (
        daily["front_close"].notna()
        & daily["front_ret_next"].notna()
        & daily["total_oi"].notna()
        & daily["curve_roll_yield_mean"].notna()
    )
    return daily


def run_policy(daily: pd.DataFrame, score_col: str, threshold: float, fold: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for _, row in daily.iterrows():
        score = float(row.get(score_col, 0.0) or 0.0)
        if abs(score) < threshold or not bool(row.get("sensor_gate", False)):
            continue
        side = 1 if score > 0 else -1
        ret_next = float(row["front_ret_next"])
        pnl = side * ret_next * NOTIONAL_USD - NOTIONAL_USD * ROUND_TRIP_FEE_RATE
        rows.append(
            {
                "fold": fold,
                "date": row["date"],
                "front_symbol": row.get("front_symbol", ""),
                "next_symbol": row.get("next_symbol", ""),
                "policy": score_col,
                "threshold": threshold,
                "side": "long" if side > 0 else "short",
                "score": score,
                "front_close": float(row["front_close"]),
                "front_ret_next": ret_next,
                "pnl_usd": pnl,
                "momentum_3d": row.get("momentum_3d"),
                "dollar_delta_3d": row.get("dollar_delta_3d"),
                "vix_delta_3d": row.get("vix_delta_3d"),
                "total_oi_delta_3d": row.get("total_oi_delta_3d"),
                "curve_roll_yield_mean": row.get("curve_roll_yield_mean"),
            }
        )
    return rows


def walk_forward(daily: pd.DataFrame) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    usable = daily[daily["sensor_gate"] & daily["front_ret_next"].notna()].copy()
    if len(usable) < 12:
        return [], []
    split_idx = int(len(usable) * 0.62)
    train = usable.iloc[:split_idx].copy()
    test = usable.iloc[split_idx:].copy()
    thresholds = [0.0, 0.25, 0.50, 0.75, 1.00]
    summary_rows: list[dict[str, Any]] = []
    all_trades: list[dict[str, Any]] = []

    for policy in ["baseline_score", "sensor_fusion_score"]:
        train_candidates = []
        for threshold in thresholds:
            trades = run_policy(train, policy, threshold, "train")
            m = metrics([float(t["pnl_usd"]) for t in trades])
            train_candidates.append((threshold, m, trades))
        best_threshold, train_metrics, train_trades = sorted(
            train_candidates,
            key=lambda item: (item[1]["net_pnl_usd"], item[1]["profit_factor"], item[1]["trades"]),
            reverse=True,
        )[0]
        test_trades = run_policy(test, policy, best_threshold, "test")
        test_metrics = metrics([float(t["pnl_usd"]) for t in test_trades])
        all_trades.extend(train_trades)
        all_trades.extend(test_trades)
        summary_rows.append(
            {
                "policy": policy,
                "selected_threshold": best_threshold,
                "train_start": str(train["date"].iloc[0]),
                "train_end": str(train["date"].iloc[-1]),
                "test_start": str(test["date"].iloc[0]),
                "test_end": str(test["date"].iloc[-1]),
                **{f"train_{k}": v for k, v in train_metrics.items()},
                **{f"test_{k}": v for k, v in test_metrics.items()},
            }
        )
    return summary_rows, all_trades


def make_plot(summary_rows: list[dict[str, Any]], trades: list[dict[str, Any]]) -> str:
    try:
        import matplotlib.pyplot as plt  # type: ignore
    except Exception:
        return ""
    if not trades:
        return ""
    df = pd.DataFrame(trades).sort_values(["policy", "fold", "date"])
    fig, axes = plt.subplots(1, 2, figsize=(12, 4))
    for policy, group in df.groupby("policy"):
        group = group.sort_values("date")
        axes[0].plot(pd.to_datetime(group["date"]), group["pnl_usd"].cumsum(), label=policy)
    axes[0].set_title("Gold V1.18 Cumulative PnL")
    axes[0].legend()
    s = pd.DataFrame(summary_rows)
    x = np.arange(len(s))
    axes[1].bar(x - 0.18, s["test_net_pnl_usd"], width=0.36, label="test net pnl")
    axes[1].bar(x + 0.18, s["test_profit_factor"], width=0.36, label="test PF")
    axes[1].set_xticks(x)
    axes[1].set_xticklabels(s["policy"], rotation=20, ha="right")
    axes[1].set_title("Test Metrics")
    axes[1].legend()
    fig.tight_layout()
    out = OUT_DIR / "HFCD_Trading_V1_18_GoldWalkForward.png"
    fig.savefig(out, dpi=160)
    plt.close(fig)
    return str(out)


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    daily = build_gold_feature_table()
    daily_path = OUT_DIR / "hfcd_trading_v1_18_daily_feature_table.csv"
    daily.to_csv(daily_path, index=False)

    summary_rows, trades = walk_forward(daily)
    write_csv(OUT_DIR / "hfcd_trading_v1_18_strategy_trades.csv", trades)
    write_csv(OUT_DIR / "hfcd_trading_v1_18_walk_forward.csv", summary_rows)

    v19_summary = load_csv(V19_DIR / "hfcd_trading_v1_9_summary.csv")
    v19_gold = v19_summary[v19_summary["asset_class"] == "gold_etf"].to_dict("records")
    l2_summary_path = V17_DIR / "hfcd_trading_v1_17_gold_risk_l2_margin_summary.json"
    l2_summary = json.loads(l2_summary_path.read_text(encoding="utf-8")) if l2_summary_path.exists() else {}
    plot_path = make_plot(summary_rows, trades)

    best_sensor = next((row for row in summary_rows if row["policy"] == "sensor_fusion_score"), {})
    best_base = next((row for row in summary_rows if row["policy"] == "baseline_score"), {})
    sensor_delta = float(best_sensor.get("test_net_pnl_usd", 0.0)) - float(best_base.get("test_net_pnl_usd", 0.0))
    status = "bounded_sensor_pass" if sensor_delta > 0 and float(best_sensor.get("test_profit_factor", 0.0)) > 1.05 else "bounded_watchlist_or_negative"

    summary = {
        "version": VERSION,
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "mode": "bounded_gold_walk_forward_not_deployed",
        "important_scope_note": "V1.16/V1.17 Databento sensor history is short-window only; this is not a multi-year production validation.",
        "daily_feature_rows": int(len(daily)),
        "usable_feature_rows": int((daily.get("sensor_gate", pd.Series(dtype=bool)) & daily.get("front_ret_next", pd.Series(dtype=float)).notna()).sum()) if not daily.empty else 0,
        "v19_gold_long_history_baseline": v19_gold[0] if v19_gold else {},
        "walk_forward": summary_rows,
        "sensor_vs_baseline_test_delta_usd": sensor_delta,
        "status": status,
        "databento_l2_reference": l2_summary.get("databento_l2", {}),
        "plot": plot_path,
    }
    (OUT_DIR / "hfcd_trading_v1_18_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    md_lines = [
        f"# {VERSION}",
        "",
        "## 定位",
        "",
        "V1.18 用现有黄金数据做本地 bounded walk-forward。它回答的问题是：V1.16/V1.17 新增的 GC 期限结构、每日 OI 候选、宏观 DXY/VIX 和 L2 腔体样本，是否值得继续扩展成更长历史。",
        "",
        "## 关键限制",
        "",
        "- V1.9 黄金 ETF 是长历史基线，但 V1.16/V1.17 Databento GC 数据目前只有短窗口。",
        "- V1.17 L2 是 5 分钟 `mbp-10` 样本，只能证明盘口腔体可接入，不能代表长期 L2 回测。",
        "- SPAN 保证金历史仍未取得实际参数文件，因此本轮不把保证金作为交易门。",
        "",
        "## V1.9 黄金长历史基线",
        "",
    ]
    if v19_gold:
        row = v19_gold[0]
        md_lines.extend(
            [
                f"- trades: {row.get('trades')}",
                f"- win_rate: {row.get('win_rate')}",
                f"- net_pnl_usd: {row.get('net_pnl_usd')}",
                f"- test_net_pnl_usd: {row.get('test_net_pnl_usd')}",
                f"- status: {row.get('status')}",
                "",
            ]
        )
    md_lines.extend(["## V1.18 bounded walk-forward", ""])
    for row in summary_rows:
        md_lines.extend(
            [
                f"### {row['policy']}",
                "",
                f"- selected_threshold: {row['selected_threshold']}",
                f"- train: {row['train_start']} -> {row['train_end']}, net={row['train_net_pnl_usd']:.2f}, PF={row['train_profit_factor']:.3f}",
                f"- test: {row['test_start']} -> {row['test_end']}, net={row['test_net_pnl_usd']:.2f}, PF={row['test_profit_factor']:.3f}, win={row['test_win_rate']:.3f}",
                "",
            ]
        )
    md_lines.extend(
        [
            "## 结论",
            "",
            f"- sensor_vs_baseline_test_delta_usd: {sensor_delta:.2f}",
            f"- status: {status}",
            "",
            "如果 `bounded_sensor_pass`，下一步才值得拉更长 Databento GC 历史和 SPAN 保证金文件；如果不是，则先不要扩大付费数据范围，应修正黄金传感器公式或延长低成本日线/OI历史。",
        ]
    )
    (OUT_DIR / "HFCD_Trading_V1_18_GoldWalkForward.md").write_text("\n".join(md_lines) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"out_dir={OUT_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
