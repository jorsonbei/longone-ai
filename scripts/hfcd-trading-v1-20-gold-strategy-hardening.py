#!/usr/bin/env python3
"""
HFCD Trading V1.20 Gold Strategy Hardening

This stage takes the positive V1.18 gold sensor-fusion lineage and applies a
stricter validation protocol:
- lineage-locked sensor_fusion_score candidates only;
- one frozen strategy selected on the first 60% and tested on the final 40%;
- fixed-config rolling validation for the frozen strategy;
- adaptive re-selection kept as an overfit audit, not as the promotion path;
- double-fee stress testing and explicit promotion gates.

It does not download new data and does not place orders.
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


VERSION = "HFCD_Trading_V1_20_GoldStrategyHardening"
ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v1_20_gold_strategy_hardening"
V18_DIR = ROOT / "outputs" / "hfcd_trading_v1_18_gold_walk_forward"
DAILY_FEATURE_PATH = V18_DIR / "hfcd_trading_v1_18_daily_feature_table.csv"
V18_SUMMARY_PATH = V18_DIR / "hfcd_trading_v1_18_summary.json"
NOTIONAL_USD = 10_000.0
BASE_FEE_RATE = 0.00035


@dataclass(frozen=True)
class StrategyConfig:
    policy: str
    threshold: float
    direction_mode: str
    volatility_cap_quantile: float | None
    volatility_cap_value: float | None = None


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
    return float((equity - peak).min()) if len(equity) else 0.0


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
    for col in ["sensor_gate", "front_ret_next", "front_close", "sensor_fusion_score", "baseline_score"]:
        if col not in daily.columns:
            raise ValueError(f"Missing required column in V1.18 features: {col}")
    daily["sensor_gate"] = daily["sensor_gate"].astype(bool)
    daily["volatility_5d"] = pd.to_numeric(daily.get("volatility_5d", 0.0), errors="coerce").fillna(0.0)
    daily["front_ret_next"] = pd.to_numeric(daily["front_ret_next"], errors="coerce")
    return daily[daily["sensor_gate"] & daily["front_ret_next"].notna()].copy().reset_index(drop=True)


def candidate_configs() -> list[StrategyConfig]:
    """Lineage-locked candidates.

    V1.18 passed through `sensor_fusion_score`. V1.20 is a hardening step for
    that lineage, not a broad model-selection tournament. Letting the selector
    switch back to `baseline_score` creates a small-sample overfit and destroys
    the point of this stage.
    """
    configs: list[StrategyConfig] = []
    thresholds = [0.50, 0.75, 1.00, 1.25, 1.50, 1.75, 2.00]
    direction_modes = ["long_short", "long_only", "short_only"]
    for threshold in thresholds:
        for direction_mode in direction_modes:
            configs.append(StrategyConfig("sensor_fusion_score", threshold, direction_mode, None))
    return configs


def materialize_config(train: pd.DataFrame, config: StrategyConfig) -> StrategyConfig:
    cap_value = None
    if config.volatility_cap_quantile is not None:
        cap_value = float(train["volatility_5d"].quantile(config.volatility_cap_quantile))
    return StrategyConfig(
        policy=config.policy,
        threshold=config.threshold,
        direction_mode=config.direction_mode,
        volatility_cap_quantile=config.volatility_cap_quantile,
        volatility_cap_value=cap_value,
    )


def run_config(data: pd.DataFrame, config: StrategyConfig, fold: str, fee_rate: float) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for _, row in data.iterrows():
        score = float(row.get(config.policy, 0.0) or 0.0)
        if abs(score) < config.threshold:
            continue
        if config.volatility_cap_value is not None and float(row.get("volatility_5d", 0.0) or 0.0) > config.volatility_cap_value:
            continue
        side = 1 if score > 0 else -1
        if config.direction_mode == "long_only" and side < 0:
            continue
        if config.direction_mode == "short_only" and side > 0:
            continue
        ret_next = float(row["front_ret_next"])
        pnl = side * ret_next * NOTIONAL_USD - NOTIONAL_USD * fee_rate
        rows.append(
            {
                "fold": fold,
                "date": str(row["date"].date()),
                "front_symbol": row.get("front_symbol", ""),
                "next_symbol": row.get("next_symbol", ""),
                "policy": config.policy,
                "threshold": config.threshold,
                "direction_mode": config.direction_mode,
                "volatility_cap_quantile": config.volatility_cap_quantile,
                "volatility_cap_value": config.volatility_cap_value,
                "side": "long" if side > 0 else "short",
                "score": score,
                "front_close": float(row["front_close"]),
                "front_ret_next": ret_next,
                "fee_rate": fee_rate,
                "pnl_usd": pnl,
                "volatility_5d": float(row.get("volatility_5d", 0.0) or 0.0),
                "total_oi_delta_3d": row.get("total_oi_delta_3d"),
                "curve_roll_yield_mean": row.get("curve_roll_yield_mean"),
                "dollar_delta_3d": row.get("dollar_delta_3d"),
                "vix_delta_3d": row.get("vix_delta_3d"),
            }
        )
    return rows


def score_config(normal_metrics: dict[str, Any], stress_metrics: dict[str, Any]) -> float:
    if normal_metrics["trades"] < 8:
        return -1e9 + normal_metrics["trades"]
    stability_floor = min(normal_metrics["net_pnl_usd"], stress_metrics["net_pnl_usd"])
    drawdown_penalty = 0.25 * abs(normal_metrics["max_drawdown_usd"])
    pf_bonus = 75.0 * min(normal_metrics["profit_factor"], 3.0)
    trade_bonus = min(normal_metrics["trades"], 80) * 2.0
    return float(stability_floor - drawdown_penalty + pf_bonus + trade_bonus)


def select_config(train: pd.DataFrame) -> tuple[StrategyConfig, dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
    evaluated: list[dict[str, Any]] = []
    best: tuple[float, StrategyConfig, dict[str, Any], dict[str, Any]] | None = None
    for raw_config in candidate_configs():
        config = materialize_config(train, raw_config)
        normal_trades = run_config(train, config, "train", BASE_FEE_RATE)
        stress_trades = run_config(train, config, "train_stress_2x_fee", BASE_FEE_RATE * 2)
        normal_metrics = metrics([float(t["pnl_usd"]) for t in normal_trades])
        stress_metrics = metrics([float(t["pnl_usd"]) for t in stress_trades])
        rank = score_config(normal_metrics, stress_metrics)
        evaluated.append(
            {
                **asdict(config),
                "rank_score": rank,
                **{f"train_{k}": v for k, v in normal_metrics.items()},
                **{f"stress2x_{k}": v for k, v in stress_metrics.items()},
            }
        )
        if best is None or rank > best[0]:
            best = (rank, config, normal_metrics, stress_metrics)
    assert best is not None
    return best[1], best[2], best[3], evaluated


def rolling_walk_forward(daily: pd.DataFrame) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    train_len = 252
    test_len = 63
    step = 63
    folds: list[dict[str, Any]] = []
    trades: list[dict[str, Any]] = []
    evaluated_all: list[dict[str, Any]] = []
    fold_no = 0
    for start in range(0, max(len(daily) - train_len - test_len + 1, 0), step):
        fold_no += 1
        train = daily.iloc[start : start + train_len].copy()
        test = daily.iloc[start + train_len : start + train_len + test_len].copy()
        if len(train) < train_len or len(test) < test_len:
            continue
        config, train_metrics, stress_metrics, evaluated = select_config(train)
        for row in evaluated:
            row["fold_no"] = fold_no
        evaluated_all.extend(evaluated)
        test_trades = run_config(test, config, f"rolling_test_{fold_no}", BASE_FEE_RATE)
        test_stress = run_config(test, config, f"rolling_test_{fold_no}_stress_2x_fee", BASE_FEE_RATE * 2)
        test_metrics = metrics([float(t["pnl_usd"]) for t in test_trades])
        test_stress_metrics = metrics([float(t["pnl_usd"]) for t in test_stress])
        trades.extend(test_trades)
        folds.append(
            {
                "fold_no": fold_no,
                "train_start": str(train["date"].iloc[0].date()),
                "train_end": str(train["date"].iloc[-1].date()),
                "test_start": str(test["date"].iloc[0].date()),
                "test_end": str(test["date"].iloc[-1].date()),
                **asdict(config),
                **{f"train_{k}": v for k, v in train_metrics.items()},
                **{f"train_stress2x_{k}": v for k, v in stress_metrics.items()},
                **{f"test_{k}": v for k, v in test_metrics.items()},
                **{f"test_stress2x_{k}": v for k, v in test_stress_metrics.items()},
            }
        )
    return folds, trades, evaluated_all


def fixed_config_rolling(
    daily: pd.DataFrame, config: StrategyConfig
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    train_len = 252
    test_len = 63
    step = 63
    folds: list[dict[str, Any]] = []
    trades: list[dict[str, Any]] = []
    stress_trades: list[dict[str, Any]] = []
    stress_positive = 0
    for fold_no, start in enumerate(range(0, max(len(daily) - train_len - test_len + 1, 0), step), start=1):
        test = daily.iloc[start + train_len : start + train_len + test_len].copy()
        if len(test) < test_len:
            continue
        test_trades = run_config(test, config, f"fixed_rolling_test_{fold_no}", BASE_FEE_RATE)
        test_stress = run_config(test, config, f"fixed_rolling_test_{fold_no}_stress_2x_fee", BASE_FEE_RATE * 2)
        test_metrics = metrics([float(t["pnl_usd"]) for t in test_trades])
        stress_metrics = metrics([float(t["pnl_usd"]) for t in test_stress])
        if stress_metrics["net_pnl_usd"] > 0:
            stress_positive += 1
        trades.extend(test_trades)
        stress_trades.extend(test_stress)
        folds.append(
            {
                "fold_no": fold_no,
                "test_start": str(test["date"].iloc[0].date()),
                "test_end": str(test["date"].iloc[-1].date()),
                **asdict(config),
                **{f"test_{k}": v for k, v in test_metrics.items()},
                **{f"test_stress2x_{k}": v for k, v in stress_metrics.items()},
            }
        )
    aggregate = metrics([float(t["pnl_usd"]) for t in trades])
    stress_aggregate = metrics([float(t["pnl_usd"]) for t in stress_trades])
    positive = sum(1 for row in folds if float(row.get("test_net_pnl_usd", 0.0)) > 0)
    status = "fixed_rolling_candidate_pass"
    if not (
        aggregate["net_pnl_usd"] > 0
        and aggregate["profit_factor"] > 1.05
        and stress_aggregate["net_pnl_usd"] > 0
        and stress_aggregate["profit_factor"] > 1.0
        and positive >= max(1, int(np.ceil(len(folds) * 0.50)))
        and stress_positive >= max(1, int(np.ceil(len(folds) * 0.40)))
    ):
        status = "fixed_rolling_watchlist"
    summary = {
        "fold_count": len(folds),
        "positive_fold_count": positive,
        "stress2x_positive_fold_count": stress_positive,
        "positive_fold_rate": float(positive / len(folds)) if folds else 0.0,
        "stress2x_positive_fold_rate": float(stress_positive / len(folds)) if folds else 0.0,
        "aggregate_metrics": aggregate,
        "stress2x_aggregate_metrics": stress_aggregate,
        "status": status,
    }
    return folds, trades, stress_trades, summary


def frozen_holdout(daily: pd.DataFrame) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    split = int(len(daily) * 0.60)
    calibration = daily.iloc[:split].copy()
    holdout = daily.iloc[split:].copy()
    config, train_metrics, stress_metrics, evaluated = select_config(calibration)
    holdout_trades = run_config(holdout, config, "frozen_holdout", BASE_FEE_RATE)
    holdout_stress = run_config(holdout, config, "frozen_holdout_stress_2x_fee", BASE_FEE_RATE * 2)
    holdout_metrics = metrics([float(t["pnl_usd"]) for t in holdout_trades])
    holdout_stress_metrics = metrics([float(t["pnl_usd"]) for t in holdout_stress])
    freeze_status = "frozen_candidate_pass"
    if not (
        holdout_metrics["net_pnl_usd"] > 0
        and holdout_metrics["profit_factor"] > 1.05
        and holdout_metrics["trades"] >= 20
        and holdout_stress_metrics["net_pnl_usd"] > 0
    ):
        freeze_status = "watchlist_not_frozen"
    report = {
        "calibration_start": str(calibration["date"].iloc[0].date()),
        "calibration_end": str(calibration["date"].iloc[-1].date()),
        "holdout_start": str(holdout["date"].iloc[0].date()),
        "holdout_end": str(holdout["date"].iloc[-1].date()),
        "selected_config": asdict(config),
        "calibration_metrics": train_metrics,
        "calibration_stress2x_metrics": stress_metrics,
        "holdout_metrics": holdout_metrics,
        "holdout_stress2x_metrics": holdout_stress_metrics,
        "freeze_status": freeze_status,
    }
    return report, holdout_trades, evaluated


def summarize_rolling(folds: list[dict[str, Any]], trades: list[dict[str, Any]]) -> dict[str, Any]:
    fold_positive = [row for row in folds if float(row.get("test_net_pnl_usd", 0.0)) > 0]
    all_metrics = metrics([float(t["pnl_usd"]) for t in trades])
    stress_positive = [row for row in folds if float(row.get("test_stress2x_net_pnl_usd", 0.0)) > 0]
    pass_status = "rolling_candidate_pass"
    if not (
        all_metrics["net_pnl_usd"] > 0
        and all_metrics["profit_factor"] > 1.05
        and len(fold_positive) >= max(1, int(np.ceil(len(folds) * 0.50)))
        and len(stress_positive) >= max(1, int(np.ceil(len(folds) * 0.40)))
    ):
        pass_status = "rolling_watchlist"
    return {
        "fold_count": len(folds),
        "positive_fold_count": len(fold_positive),
        "stress2x_positive_fold_count": len(stress_positive),
        "positive_fold_rate": float(len(fold_positive) / len(folds)) if folds else 0.0,
        "stress2x_positive_fold_rate": float(len(stress_positive) / len(folds)) if folds else 0.0,
        "aggregate_metrics": all_metrics,
        "status": pass_status,
    }


def make_plot(folds: list[dict[str, Any]], rolling_trades: list[dict[str, Any]], frozen_trades: list[dict[str, Any]]) -> str:
    try:
        import matplotlib.pyplot as plt  # type: ignore
    except Exception:
        return ""
    if not folds:
        return ""
    fig, axes = plt.subplots(2, 2, figsize=(13, 8))
    fold_df = pd.DataFrame(folds)
    axes[0, 0].bar(fold_df["fold_no"], fold_df["test_net_pnl_usd"], label="normal fee")
    axes[0, 0].bar(fold_df["fold_no"], fold_df["test_stress2x_net_pnl_usd"], alpha=0.55, label="2x fee")
    axes[0, 0].axhline(0, color="black", linewidth=0.8)
    axes[0, 0].set_title("Rolling Fold Test PnL")
    axes[0, 0].legend()

    if rolling_trades:
        rt = pd.DataFrame(rolling_trades).sort_values("date")
        axes[0, 1].plot(pd.to_datetime(rt["date"]), rt["pnl_usd"].cumsum(), label="rolling")
    if frozen_trades:
        ft = pd.DataFrame(frozen_trades).sort_values("date")
        axes[0, 1].plot(pd.to_datetime(ft["date"]), ft["pnl_usd"].cumsum(), label="frozen holdout")
    axes[0, 1].set_title("Cumulative PnL")
    axes[0, 1].legend()

    axes[1, 0].scatter(fold_df["test_trades"], fold_df["test_profit_factor"], c=fold_df["test_net_pnl_usd"], cmap="RdYlGn")
    axes[1, 0].axhline(1.05, color="gray", linestyle="--", linewidth=0.8)
    axes[1, 0].set_xlabel("test trades")
    axes[1, 0].set_ylabel("test PF")
    axes[1, 0].set_title("Fold PF vs Trade Count")

    selected = fold_df["threshold"].astype(str) + " / " + fold_df["direction_mode"].astype(str)
    axes[1, 1].barh(range(len(fold_df)), fold_df["test_net_pnl_usd"])
    axes[1, 1].set_yticks(range(len(fold_df)))
    axes[1, 1].set_yticklabels(selected)
    axes[1, 1].set_title("Selected Configs")
    fig.tight_layout()
    out = OUT_DIR / "HFCD_Trading_V1_20_GoldStrategyHardening.png"
    fig.savefig(out, dpi=160)
    plt.close(fig)
    return str(out)


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    daily = load_daily_features()
    folds, rolling_trades, evaluated = rolling_walk_forward(daily)
    frozen_report, frozen_trades, frozen_evaluated = frozen_holdout(daily)
    fixed_config = StrategyConfig(**frozen_report["selected_config"])
    fixed_folds, fixed_trades, fixed_stress_trades, fixed_summary = fixed_config_rolling(daily, fixed_config)
    rolling_summary = summarize_rolling(folds, rolling_trades)
    plot_path = make_plot(fixed_folds or folds, fixed_trades or rolling_trades, frozen_trades)

    write_csv(OUT_DIR / "hfcd_trading_v1_20_rolling_folds.csv", folds)
    write_csv(OUT_DIR / "hfcd_trading_v1_20_rolling_trades.csv", rolling_trades)
    write_csv(OUT_DIR / "hfcd_trading_v1_20_adaptive_rolling_folds.csv", folds)
    write_csv(OUT_DIR / "hfcd_trading_v1_20_adaptive_rolling_trades.csv", rolling_trades)
    write_csv(OUT_DIR / "hfcd_trading_v1_20_fixed_rolling_folds.csv", fixed_folds)
    write_csv(OUT_DIR / "hfcd_trading_v1_20_fixed_rolling_trades.csv", fixed_trades)
    write_csv(OUT_DIR / "hfcd_trading_v1_20_fixed_rolling_stress2x_trades.csv", fixed_stress_trades)
    write_csv(OUT_DIR / "hfcd_trading_v1_20_evaluated_configs.csv", evaluated)
    write_csv(OUT_DIR / "hfcd_trading_v1_20_frozen_holdout_trades.csv", frozen_trades)
    write_csv(OUT_DIR / "hfcd_trading_v1_20_frozen_evaluated_configs.csv", frozen_evaluated)
    (OUT_DIR / "hfcd_trading_v1_20_frozen_strategy_config.json").write_text(
        json.dumps(frozen_report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    v18_summary = json.loads(V18_SUMMARY_PATH.read_text(encoding="utf-8")) if V18_SUMMARY_PATH.exists() else {}
    final_status = "gold_strategy_hardened_candidate"
    if fixed_summary["status"] != "fixed_rolling_candidate_pass" or frozen_report["freeze_status"] != "frozen_candidate_pass":
        final_status = "gold_strategy_watchlist_needs_more_validation"
    summary = {
        "version": VERSION,
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "mode": "local_gold_strategy_hardening_not_deployed_not_live_trading",
        "input_daily_rows": int(len(daily)),
        "source_v18_status": v18_summary.get("status"),
        "source_v18_sensor_delta_usd": v18_summary.get("sensor_vs_baseline_test_delta_usd"),
        "lineage_lock": "sensor_fusion_score_only",
        "adaptive_selector_audit": rolling_summary,
        "fixed_config_rolling": fixed_summary,
        "frozen_holdout": frozen_report,
        "plot": plot_path,
        "status": final_status,
        "promotion_rule": [
            "fixed selected config rolling aggregate net_pnl > 0 and PF > 1.05",
            "fixed selected config rolling 2x fee aggregate net_pnl > 0 and PF > 1.0",
            "fixed selected config has at least 50% rolling folds positive",
            "fixed selected config has at least 40% rolling folds positive under 2x fee stress",
            "frozen holdout net_pnl > 0, PF > 1.05, trades >= 20, and 2x fee net_pnl > 0",
        ],
    }
    (OUT_DIR / "hfcd_trading_v1_20_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    md = [
        f"# {VERSION}",
        "",
        "## 定位",
        "",
        "V1.20 基于 V1.18 已经转正的黄金传感器结果做策略固化验证。它不下载新数据、不下单，只判断黄金策略是否能从 bounded pass 升级为可冻结候选。",
        "",
        "## 验证协议",
        "",
        "- 滚动 walk-forward：252 个可用交易日训练，63 个可用交易日测试，每 63 日滚动一次。",
        "- 只固化 V1.18 已验证的 `sensor_fusion_score` 血统，不允许 baseline 反向抢占。",
        "- 每个 fold 只用训练段选择 `threshold / direction`。",
        "- 加入 2x fee stress，避免手续费轻微变化就击穿策略。",
        "- 冻结验证：前 60% 选一个配置，后 40% 完全冻结测试。",
        "",
        "## 固定配置滚动结果",
        "",
        f"- fold_count: {fixed_summary['fold_count']}",
        f"- positive_fold_rate: {fixed_summary['positive_fold_rate']:.3f}",
        f"- stress2x_positive_fold_rate: {fixed_summary['stress2x_positive_fold_rate']:.3f}",
        f"- aggregate_net_pnl_usd: {fixed_summary['aggregate_metrics']['net_pnl_usd']:.2f}",
        f"- aggregate_profit_factor: {fixed_summary['aggregate_metrics']['profit_factor']:.3f}",
        f"- stress2x_aggregate_net_pnl_usd: {fixed_summary['stress2x_aggregate_metrics']['net_pnl_usd']:.2f}",
        f"- stress2x_aggregate_profit_factor: {fixed_summary['stress2x_aggregate_metrics']['profit_factor']:.3f}",
        f"- fixed_rolling_status: {fixed_summary['status']}",
        "",
        "## 自适应重选审计",
        "",
        f"- adaptive_selector_net_pnl_usd: {rolling_summary['aggregate_metrics']['net_pnl_usd']:.2f}",
        f"- adaptive_selector_profit_factor: {rolling_summary['aggregate_metrics']['profit_factor']:.3f}",
        f"- adaptive_selector_status: {rolling_summary['status']}",
        "",
        "这项审计说明：黄金线当前不适合每个季度频繁重选参数，应该优先使用冻结血统配置。",
        "",
        "## 冻结配置",
        "",
        f"- selected_config: `{frozen_report['selected_config']}`",
        f"- holdout_net_pnl_usd: {frozen_report['holdout_metrics']['net_pnl_usd']:.2f}",
        f"- holdout_profit_factor: {frozen_report['holdout_metrics']['profit_factor']:.3f}",
        f"- holdout_trades: {frozen_report['holdout_metrics']['trades']}",
        f"- holdout_stress2x_net_pnl_usd: {frozen_report['holdout_stress2x_metrics']['net_pnl_usd']:.2f}",
        f"- freeze_status: {frozen_report['freeze_status']}",
        "",
        "## 结论",
        "",
        f"- final_status: {final_status}",
        "",
        "如果 V1.20 未达到 `gold_strategy_hardened_candidate`，不要把黄金策略接入线上自动交易；应继续补更长 L2、保证金历史或修正出入场门。",
    ]
    (OUT_DIR / "HFCD_Trading_V1_20_GoldStrategyHardening.md").write_text("\n".join(md) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"out_dir={OUT_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
