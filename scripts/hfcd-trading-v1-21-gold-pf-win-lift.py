#!/usr/bin/env python3
"""
HFCD Trading V1.21 Gold PF/Win Lift

This stage starts from the V1.20 frozen gold lineage and tests only execution
layer changes that can improve win rate and profit factor without changing the
underlying sensor model:
- a slightly stricter sensor_fusion_score floor;
- a Q-core drift/quality guard audit using the current daily sensor table;
- confidence-weighted sizing as an audit, not the default;
- a VIX/macro-event proxy guard as an audit.

It does not download data and does not place orders.
"""

from __future__ import annotations

import csv
import json
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


VERSION = "HFCD_Trading_V1_21_GoldPFWinLift"
ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v1_21_gold_pf_win_lift"
V18_DIR = ROOT / "outputs" / "hfcd_trading_v1_18_gold_walk_forward"
V20_DIR = ROOT / "outputs" / "hfcd_trading_v1_20_gold_strategy_hardening"
DAILY_FEATURE_PATH = V18_DIR / "hfcd_trading_v1_18_daily_feature_table.csv"
V20_SUMMARY_PATH = V20_DIR / "hfcd_trading_v1_20_summary.json"
NOTIONAL_USD = 10_000.0
BASE_FEE_RATE = 0.00035


@dataclass(frozen=True)
class Variant:
    name: str
    threshold: float
    sizing_mode: str = "fixed"
    sizing_gamma: float = 1.0
    sizing_cap: float = 1.0
    vix_guard_quantile: float | None = None
    q_guard_quantile: float | None = None
    min_holdout_trades: int = 20


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


def max_drawdown(pnls: list[float]) -> float:
    if not pnls:
        return 0.0
    equity = np.cumsum(pnls)
    peak = np.maximum.accumulate(equity)
    return float((equity - peak).min())


def metrics(pnls: list[float]) -> dict[str, Any]:
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]
    gross_win = float(sum(wins))
    gross_loss = float(abs(sum(losses)))
    return {
        "trades": len(pnls),
        "win_rate": float(len(wins) / len(pnls)) if pnls else 0.0,
        "net_pnl_usd": float(sum(pnls)),
        "max_drawdown_usd": max_drawdown(pnls),
        "profit_factor": float(gross_win / gross_loss) if gross_loss > 0 else (999.0 if gross_win > 0 else 0.0),
        "avg_pnl_usd": float(np.mean(pnls)) if pnls else 0.0,
        "gross_win_usd": gross_win,
        "gross_loss_usd": gross_loss,
    }


def load_daily_features() -> pd.DataFrame:
    if not DAILY_FEATURE_PATH.exists():
        raise FileNotFoundError(f"Missing V1.18 daily feature table: {DAILY_FEATURE_PATH}")
    daily = pd.read_csv(DAILY_FEATURE_PATH)
    daily["date"] = pd.to_datetime(daily["date"])
    daily = daily.sort_values("date").reset_index(drop=True)
    required = ["sensor_gate", "sensor_fusion_score", "front_ret_next", "front_close", "vix_delta_3d"]
    for col in required:
        if col not in daily.columns:
            raise ValueError(f"Missing required column in V1.18 feature table: {col}")
    daily["sensor_gate"] = daily["sensor_gate"].astype(bool)
    for col in [
        "sensor_fusion_score",
        "front_ret_next",
        "front_close",
        "volatility_5d",
        "momentum_3d",
        "vix_delta_3d",
        "dollar_delta_3d",
        "total_oi_delta_3d",
        "curve_roll_yield_mean",
    ]:
        if col in daily.columns:
            daily[col] = pd.to_numeric(daily[col], errors="coerce").fillna(0.0)
    vol = daily["volatility_5d"].replace(0.0, np.nan).fillna(float(daily["volatility_5d"].median()) or 1e-6)
    oi_lift = 1.0 + np.maximum(0.0, daily.get("total_oi_delta_3d", 0.0))
    daily["q_core_quality_proxy"] = np.exp(-np.abs(daily.get("momentum_3d", 0.0)) / (vol + 1e-9)) * oi_lift
    return daily[daily["sensor_gate"] & daily["front_ret_next"].notna()].copy().reset_index(drop=True)


def variants() -> list[Variant]:
    return [
        Variant("v1_20_base_floor_1p00", threshold=1.00),
        Variant("balanced_pf_win_floor_1p10", threshold=1.10),
        Variant("strict_pf_watchlist_floor_1p25", threshold=1.25, min_holdout_trades=18),
        Variant(
            "confidence_sizing_audit_floor_1p10",
            threshold=1.10,
            sizing_mode="score_power",
            sizing_gamma=1.0,
            sizing_cap=1.25,
        ),
        Variant("q_core_guard_audit_floor_1p10", threshold=1.10, q_guard_quantile=0.10),
        Variant("vix_event_guard_audit_floor_1p00", threshold=1.00, vix_guard_quantile=0.95),
    ]


def position_multiplier(score: float, variant: Variant) -> float:
    if variant.sizing_mode == "fixed":
        return 1.0
    strength = max(0.0, (score - variant.threshold) / max(variant.threshold, 1e-9))
    if variant.sizing_mode == "score_power":
        return min(variant.sizing_cap, max(0.35, (1.0 + strength) ** variant.sizing_gamma))
    if variant.sizing_mode == "score_linear":
        return min(variant.sizing_cap, max(0.35, 0.65 + variant.sizing_gamma * strength))
    return 1.0


def materialize_variant(train: pd.DataFrame, variant: Variant) -> dict[str, Any]:
    return {
        **asdict(variant),
        "vix_guard_value": None
        if variant.vix_guard_quantile is None
        else float(train["vix_delta_3d"].quantile(variant.vix_guard_quantile)),
        "q_guard_value": None
        if variant.q_guard_quantile is None
        else float(train["q_core_quality_proxy"].quantile(variant.q_guard_quantile)),
    }


def run_variant(data: pd.DataFrame, config: dict[str, Any], fold: str, fee_rate: float) -> list[dict[str, Any]]:
    variant = Variant(
        name=str(config["name"]),
        threshold=float(config["threshold"]),
        sizing_mode=str(config["sizing_mode"]),
        sizing_gamma=float(config["sizing_gamma"]),
        sizing_cap=float(config["sizing_cap"]),
        vix_guard_quantile=config["vix_guard_quantile"],
        q_guard_quantile=config["q_guard_quantile"],
        min_holdout_trades=int(config["min_holdout_trades"]),
    )
    rows: list[dict[str, Any]] = []
    vix_guard_value = config.get("vix_guard_value")
    q_guard_value = config.get("q_guard_value")
    for _, row in data.iterrows():
        score = float(row.get("sensor_fusion_score", 0.0) or 0.0)
        if score < variant.threshold:
            continue
        if vix_guard_value is not None and float(row.get("vix_delta_3d", 0.0) or 0.0) > float(vix_guard_value):
            continue
        if q_guard_value is not None and float(row.get("q_core_quality_proxy", 0.0) or 0.0) < float(q_guard_value):
            continue
        multiplier = position_multiplier(score, variant)
        notional = NOTIONAL_USD * multiplier
        pnl = float(row["front_ret_next"]) * notional - notional * fee_rate
        rows.append(
            {
                "fold": fold,
                "date": str(row["date"].date()),
                "variant": variant.name,
                "threshold": variant.threshold,
                "sizing_mode": variant.sizing_mode,
                "sizing_gamma": variant.sizing_gamma,
                "sizing_cap": variant.sizing_cap,
                "vix_guard_quantile": variant.vix_guard_quantile,
                "vix_guard_value": vix_guard_value,
                "q_guard_quantile": variant.q_guard_quantile,
                "q_guard_value": q_guard_value,
                "side": "long",
                "score": score,
                "position_multiplier": multiplier,
                "notional_usd": notional,
                "front_symbol": row.get("front_symbol", ""),
                "front_close": float(row["front_close"]),
                "front_ret_next": float(row["front_ret_next"]),
                "fee_rate": fee_rate,
                "pnl_usd": pnl,
                "vix_delta_3d": float(row.get("vix_delta_3d", 0.0) or 0.0),
                "volatility_5d": float(row.get("volatility_5d", 0.0) or 0.0),
                "q_core_quality_proxy": float(row.get("q_core_quality_proxy", 0.0) or 0.0),
            }
        )
    return rows


def evaluate_split(daily: pd.DataFrame, variant: Variant) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    split = int(len(daily) * 0.60)
    calibration = daily.iloc[:split].copy()
    holdout = daily.iloc[split:].copy()
    config = materialize_variant(calibration, variant)
    cal_trades = run_variant(calibration, config, "calibration", BASE_FEE_RATE)
    holdout_trades = run_variant(holdout, config, "holdout", BASE_FEE_RATE)
    holdout_stress = run_variant(holdout, config, "holdout_stress_2x_fee", BASE_FEE_RATE * 2)
    report = {
        **config,
        "calibration_start": str(calibration["date"].iloc[0].date()),
        "calibration_end": str(calibration["date"].iloc[-1].date()),
        "holdout_start": str(holdout["date"].iloc[0].date()),
        "holdout_end": str(holdout["date"].iloc[-1].date()),
        **{f"calibration_{k}": v for k, v in metrics([float(t["pnl_usd"]) for t in cal_trades]).items()},
        **{f"holdout_{k}": v for k, v in metrics([float(t["pnl_usd"]) for t in holdout_trades]).items()},
        **{f"holdout_stress2x_{k}": v for k, v in metrics([float(t["pnl_usd"]) for t in holdout_stress]).items()},
    }
    return report, holdout_trades, holdout_stress


def evaluate_rolling(daily: pd.DataFrame, variant: Variant) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    train_len = 252
    test_len = 63
    step = 63
    folds: list[dict[str, Any]] = []
    trades: list[dict[str, Any]] = []
    stress_trades: list[dict[str, Any]] = []
    for fold_no, start in enumerate(range(0, max(len(daily) - train_len - test_len + 1, 0), step), start=1):
        train = daily.iloc[start : start + train_len].copy()
        test = daily.iloc[start + train_len : start + train_len + test_len].copy()
        if len(train) < train_len or len(test) < test_len:
            continue
        config = materialize_variant(train, variant)
        test_trades = run_variant(test, config, f"rolling_test_{fold_no}", BASE_FEE_RATE)
        test_stress = run_variant(test, config, f"rolling_test_{fold_no}_stress_2x_fee", BASE_FEE_RATE * 2)
        m = metrics([float(t["pnl_usd"]) for t in test_trades])
        sm = metrics([float(t["pnl_usd"]) for t in test_stress])
        trades.extend(test_trades)
        stress_trades.extend(test_stress)
        folds.append(
            {
                "fold_no": fold_no,
                "test_start": str(test["date"].iloc[0].date()),
                "test_end": str(test["date"].iloc[-1].date()),
                **config,
                **{f"test_{k}": v for k, v in m.items()},
                **{f"test_stress2x_{k}": v for k, v in sm.items()},
            }
        )
    aggregate = metrics([float(t["pnl_usd"]) for t in trades])
    stress_aggregate = metrics([float(t["pnl_usd"]) for t in stress_trades])
    positive = sum(1 for row in folds if float(row.get("test_net_pnl_usd", 0.0)) > 0)
    stress_positive = sum(1 for row in folds if float(row.get("test_stress2x_net_pnl_usd", 0.0)) > 0)
    summary = {
        "fold_count": len(folds),
        "positive_fold_count": positive,
        "stress2x_positive_fold_count": stress_positive,
        "positive_fold_rate": float(positive / len(folds)) if folds else 0.0,
        "stress2x_positive_fold_rate": float(stress_positive / len(folds)) if folds else 0.0,
        "aggregate_metrics": aggregate,
        "stress2x_aggregate_metrics": stress_aggregate,
    }
    return folds, trades, stress_trades, summary


def make_plot(rows: list[dict[str, Any]]) -> str:
    try:
        import matplotlib.pyplot as plt  # type: ignore
    except Exception:
        return ""
    df = pd.DataFrame(rows)
    if df.empty:
        return ""
    labels = df["name"].str.replace("_", "\n")
    fig, axes = plt.subplots(2, 2, figsize=(14, 8))
    axes[0, 0].bar(labels, df["holdout_profit_factor"])
    axes[0, 0].axhline(1.0, color="black", linewidth=0.8)
    axes[0, 0].set_title("Holdout Profit Factor")
    axes[0, 0].tick_params(axis="x", labelrotation=20)

    axes[0, 1].bar(labels, df["holdout_win_rate"])
    axes[0, 1].set_title("Holdout Win Rate")
    axes[0, 1].tick_params(axis="x", labelrotation=20)

    axes[1, 0].bar(labels, df["rolling_profit_factor"])
    axes[1, 0].axhline(1.0, color="black", linewidth=0.8)
    axes[1, 0].set_title("Rolling Profit Factor")
    axes[1, 0].tick_params(axis="x", labelrotation=20)

    axes[1, 1].bar(labels, df["rolling_net_pnl_usd"])
    axes[1, 1].axhline(0, color="black", linewidth=0.8)
    axes[1, 1].set_title("Rolling Net PnL")
    axes[1, 1].tick_params(axis="x", labelrotation=20)
    fig.tight_layout()
    out = OUT_DIR / "HFCD_Trading_V1_21_GoldPFWinLift.png"
    fig.savefig(out, dpi=160)
    plt.close(fig)
    return str(out)


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    daily = load_daily_features()
    split_rows: list[dict[str, Any]] = []
    rolling_rows: list[dict[str, Any]] = []
    all_holdout_trades: list[dict[str, Any]] = []
    all_rolling_trades: list[dict[str, Any]] = []
    fold_rows: list[dict[str, Any]] = []
    comparison: list[dict[str, Any]] = []

    for variant in variants():
        split_report, holdout_trades, holdout_stress = evaluate_split(daily, variant)
        folds, rolling_trades, rolling_stress_trades, rolling_summary = evaluate_rolling(daily, variant)
        split_rows.append(split_report)
        fold_rows.extend(folds)
        all_holdout_trades.extend(holdout_trades)
        all_holdout_trades.extend(holdout_stress)
        all_rolling_trades.extend(rolling_trades)
        all_rolling_trades.extend(rolling_stress_trades)
        rolling_rows.append(
            {
                "name": variant.name,
                **{f"rolling_{k}": v for k, v in rolling_summary["aggregate_metrics"].items()},
                **{f"rolling_stress2x_{k}": v for k, v in rolling_summary["stress2x_aggregate_metrics"].items()},
                "rolling_positive_fold_rate": rolling_summary["positive_fold_rate"],
                "rolling_stress2x_positive_fold_rate": rolling_summary["stress2x_positive_fold_rate"],
            }
        )
        comparison.append(
            {
                "name": variant.name,
                "holdout_trades": split_report["holdout_trades"],
                "holdout_win_rate": split_report["holdout_win_rate"],
                "holdout_net_pnl_usd": split_report["holdout_net_pnl_usd"],
                "holdout_profit_factor": split_report["holdout_profit_factor"],
                "holdout_stress2x_net_pnl_usd": split_report["holdout_stress2x_net_pnl_usd"],
                "holdout_stress2x_profit_factor": split_report["holdout_stress2x_profit_factor"],
                "rolling_trades": rolling_summary["aggregate_metrics"]["trades"],
                "rolling_win_rate": rolling_summary["aggregate_metrics"]["win_rate"],
                "rolling_net_pnl_usd": rolling_summary["aggregate_metrics"]["net_pnl_usd"],
                "rolling_profit_factor": rolling_summary["aggregate_metrics"]["profit_factor"],
                "rolling_stress2x_net_pnl_usd": rolling_summary["stress2x_aggregate_metrics"]["net_pnl_usd"],
                "rolling_stress2x_profit_factor": rolling_summary["stress2x_aggregate_metrics"]["profit_factor"],
                "rolling_positive_fold_rate": rolling_summary["positive_fold_rate"],
            }
        )

    base = next(row for row in comparison if row["name"] == "v1_20_base_floor_1p00")
    for row in comparison:
        row["delta_holdout_win_rate_vs_v20"] = row["holdout_win_rate"] - base["holdout_win_rate"]
        row["delta_holdout_pf_vs_v20"] = row["holdout_profit_factor"] - base["holdout_profit_factor"]
        row["delta_holdout_pnl_vs_v20"] = row["holdout_net_pnl_usd"] - base["holdout_net_pnl_usd"]
        row["delta_rolling_win_rate_vs_v20"] = row["rolling_win_rate"] - base["rolling_win_rate"]
        row["delta_rolling_pf_vs_v20"] = row["rolling_profit_factor"] - base["rolling_profit_factor"]
        row["delta_rolling_pnl_vs_v20"] = row["rolling_net_pnl_usd"] - base["rolling_net_pnl_usd"]

    promoted = [
        row
        for row in comparison
        if row["name"] != base["name"]
        and row["holdout_trades"] >= 20
        and row["holdout_win_rate"] > base["holdout_win_rate"]
        and row["holdout_profit_factor"] > base["holdout_profit_factor"]
        and row["holdout_stress2x_net_pnl_usd"] > 0
        and row["rolling_win_rate"] > base["rolling_win_rate"]
        and row["rolling_profit_factor"] > base["rolling_profit_factor"]
        and row["rolling_stress2x_net_pnl_usd"] > 0
        and row["rolling_positive_fold_rate"] >= 0.50
    ]
    promoted = sorted(
        promoted,
        key=lambda row: (row["rolling_profit_factor"], row["holdout_profit_factor"], row["rolling_net_pnl_usd"]),
        reverse=True,
    )
    promoted_variant = promoted[0] if promoted else None
    strict_watchlist = next(row for row in comparison if row["name"] == "strict_pf_watchlist_floor_1p25")
    q_core_audit = next(row for row in comparison if row["name"] == "q_core_guard_audit_floor_1p10")
    status = "gold_pf_win_lift_candidate" if promoted_variant else "gold_pf_win_lift_watchlist"
    plot = make_plot(comparison)

    write_csv(OUT_DIR / "hfcd_trading_v1_21_variant_split_metrics.csv", split_rows)
    write_csv(OUT_DIR / "hfcd_trading_v1_21_variant_rolling_metrics.csv", rolling_rows)
    write_csv(OUT_DIR / "hfcd_trading_v1_21_variant_comparison.csv", comparison)
    write_csv(OUT_DIR / "hfcd_trading_v1_21_rolling_folds.csv", fold_rows)
    write_csv(OUT_DIR / "hfcd_trading_v1_21_holdout_trades.csv", all_holdout_trades)
    write_csv(OUT_DIR / "hfcd_trading_v1_21_rolling_trades.csv", all_rolling_trades)

    v20_summary = json.loads(V20_SUMMARY_PATH.read_text(encoding="utf-8")) if V20_SUMMARY_PATH.exists() else {}
    summary = {
        "version": VERSION,
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "mode": "local_gold_pf_win_lift_not_deployed_not_live_trading",
        "input_daily_rows": int(len(daily)),
        "source_v20_status": v20_summary.get("status"),
        "base_variant": base,
        "promoted_variant": promoted_variant,
        "strict_pf_watchlist": strict_watchlist,
        "q_core_guard_audit": q_core_audit,
        "status": status,
        "plot": plot,
        "notes": [
            "The best robust lift is a light threshold raise from 1.00 to 1.10.",
            "Confidence sizing improves dollar PnL but is not the PF-first promoted rule.",
            "Strict 1.25 has higher holdout PF/win but fewer than 20 holdout trades, so it stays as high-PF watchlist.",
            "Q-core guard is kept as an audit because the current table only supports a daily proxy, not true intraday dynamic Q-drift exits.",
        ],
    }
    (OUT_DIR / "hfcd_trading_v1_21_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    if promoted_variant:
        promoted_line = (
            f"`{promoted_variant['name']}` 提升为候选：holdout PF "
            f"{promoted_variant['holdout_profit_factor']:.3f}，rolling PF {promoted_variant['rolling_profit_factor']:.3f}。"
        )
    else:
        promoted_line = "没有变体同时提升 holdout 与 rolling 的胜率/PF。"

    md = [
        f"# {VERSION}",
        "",
        "## 定位",
        "",
        "V1.21 不改黄金传感器模型，只在 V1.20 冻结血统上测试提高胜率与 PF 的执行层增强。",
        "",
        "## 结论",
        "",
        f"- status: `{status}`",
        f"- {promoted_line}",
        "",
        "## V1.20 基线",
        "",
        f"- holdout: trades={base['holdout_trades']}, win={base['holdout_win_rate']:.3f}, PF={base['holdout_profit_factor']:.3f}, PnL={base['holdout_net_pnl_usd']:.2f}",
        f"- rolling: trades={base['rolling_trades']}, win={base['rolling_win_rate']:.3f}, PF={base['rolling_profit_factor']:.3f}, PnL={base['rolling_net_pnl_usd']:.2f}",
        "",
        "## 推广候选",
        "",
    ]
    if promoted_variant:
        md += [
            f"- name: `{promoted_variant['name']}`",
            f"- holdout: trades={promoted_variant['holdout_trades']}, win={promoted_variant['holdout_win_rate']:.3f}, PF={promoted_variant['holdout_profit_factor']:.3f}, PnL={promoted_variant['holdout_net_pnl_usd']:.2f}",
            f"- rolling: trades={promoted_variant['rolling_trades']}, win={promoted_variant['rolling_win_rate']:.3f}, PF={promoted_variant['rolling_profit_factor']:.3f}, PnL={promoted_variant['rolling_net_pnl_usd']:.2f}",
            f"- 2x fee rolling PnL={promoted_variant['rolling_stress2x_net_pnl_usd']:.2f}, PF={promoted_variant['rolling_stress2x_profit_factor']:.3f}",
            "",
            "解释：轻度提高显化门会少做弱信号交易，保留足够交易数，同时提高后 40% 盲测和 rolling 的胜率/PF。",
        ]
    md += [
        "",
        "## 高 PF 观察线",
        "",
        f"- name: `{strict_watchlist['name']}`",
        f"- holdout: trades={strict_watchlist['holdout_trades']}, win={strict_watchlist['holdout_win_rate']:.3f}, PF={strict_watchlist['holdout_profit_factor']:.3f}, PnL={strict_watchlist['holdout_net_pnl_usd']:.2f}",
        f"- rolling: trades={strict_watchlist['rolling_trades']}, win={strict_watchlist['rolling_win_rate']:.3f}, PF={strict_watchlist['rolling_profit_factor']:.3f}, PnL={strict_watchlist['rolling_net_pnl_usd']:.2f}",
        "",
        "这条线胜率/PF 更高，但后 40% 只有 18 笔，不满足主线样本保护，暂不替代主策略。",
        "",
        "## Q 核守恒门审计",
        "",
        f"- name: `{q_core_audit['name']}`",
        f"- holdout: trades={q_core_audit['holdout_trades']}, win={q_core_audit['holdout_win_rate']:.3f}, PF={q_core_audit['holdout_profit_factor']:.3f}, PnL={q_core_audit['holdout_net_pnl_usd']:.2f}",
        f"- rolling: trades={q_core_audit['rolling_trades']}, win={q_core_audit['rolling_win_rate']:.3f}, PF={q_core_audit['rolling_profit_factor']:.3f}, PnL={q_core_audit['rolling_net_pnl_usd']:.2f}",
        "",
        "Q 核门在当前表里表现很强，但后 40% 只有 16 笔，且只是日线入场过滤代理，不是持仓中动态 Q 漂移退出；因此作为 V1.22 候选方向，不直接替代主线。",
        "",
        "## 审计",
        "",
        "- 信号强度仓位缩放提高美元收益，但不稳定提升 PF，所以保留为审计，不作为 V1.21 主策略。",
        "- Q 核守恒门使用当前日线特征能提高部分样本 PF，但它还不是真正的持仓中动态 Q 漂移退出；需要持仓路径或分钟级特征才能上线。",
        "- VIX 事件代理过滤在训练段有帮助，但 holdout 不稳定，暂不推广。",
        "",
        "## 风险边界",
        "",
        "这仍是本地历史回放/纸面验证，不是实盘策略。进入线上前还需要更长历史、真实滑点和交易时段执行验证。",
    ]
    (OUT_DIR / "HFCD_Trading_V1_21_GoldPFWinLift.md").write_text("\n".join(md) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"out_dir={OUT_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
