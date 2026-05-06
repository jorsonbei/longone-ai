#!/usr/bin/env python3
"""
HFCD Trading V1.31 Gold Execution Paper Baseline.

V1.30 found a tradable execution anchor:
    next_after_2000_wait240

This stage freezes that anchor into a production-style paper baseline. It does
not tune signals, Q exits, or trailing stops. It answers three execution-layer
questions:

1. Which signals are executable under the frozen anchor?
2. What happens to PnL under realistic fee/slippage stress?
3. Which signals are skipped because the execution anchor cannot be observed?
"""

from __future__ import annotations

import csv
import json
import math
from datetime import datetime
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


VERSION = "HFCD_Trading_V1_31_GoldExecutionPaperBaseline"
ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v1_31_gold_execution_paper_baseline"
V130_DIR = ROOT / "outputs" / "hfcd_trading_v1_30_gold_tradable_execution_anchor"
V129_DIR = ROOT / "outputs" / "hfcd_trading_v1_29_gold_official_settlement_baseline_replay"

V130_BEST_TRADES = V130_DIR / "hfcd_trading_v1_30_best_anchor_trades.csv"
V130_SUMMARY = V130_DIR / "hfcd_trading_v1_30_summary.json"
V129_SELECTED_TRADES = V129_DIR / "hfcd_trading_v1_29_selected_trades.csv"

NOTIONAL_USD = 10_000.0
BASE_FEE_USD = 3.50


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    fields: list[str] = []
    for row in rows:
        for key in row:
            if key not in fields:
                fields.append(key)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def clean_json(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k): clean_json(v) for k, v in value.items()}
    if isinstance(value, list):
        return [clean_json(v) for v in value]
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating, float)):
        v = float(value)
        return v if math.isfinite(v) else None
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    if pd.isna(value) if not isinstance(value, (str, bytes, bool, type(None))) else False:
        return None
    return value


def max_drawdown(values: list[float]) -> float:
    if not values:
        return 0.0
    equity = np.cumsum(values)
    peak = np.maximum.accumulate(equity)
    return float((equity - peak).min())


def metric_block(values: list[float], total_signals: int | None = None, executed: int | None = None) -> dict[str, Any]:
    vals = [float(v) for v in values]
    wins = [v for v in vals if v > 0]
    losses = [v for v in vals if v < 0]
    gross_win = float(sum(wins))
    gross_loss = float(abs(sum(losses)))
    denom = len(vals) if total_signals is None else int(total_signals)
    return {
        "signals": denom,
        "executed": len(vals) if executed is None else int(executed),
        "wins": len(wins),
        "losses": len(losses),
        "win_rate_executed": float(len(wins) / len(vals)) if vals else 0.0,
        "win_rate_all_signals": float(len(wins) / denom) if denom else 0.0,
        "net_pnl_usd": float(sum(vals)),
        "profit_factor": float(gross_win / gross_loss) if gross_loss > 0 else (999.0 if gross_win > 0 else 0.0),
        "max_drawdown_usd": max_drawdown(vals),
        "gross_win_usd": gross_win,
        "gross_loss_usd": gross_loss,
        "avg_pnl_per_executed_trade_usd": float(np.mean(vals)) if vals else 0.0,
        "avg_pnl_per_signal_usd": float(sum(vals) / denom) if denom else 0.0,
    }


def safe_corr(a: pd.Series, b: pd.Series) -> float:
    tmp = pd.DataFrame({"a": pd.to_numeric(a, errors="coerce"), "b": pd.to_numeric(b, errors="coerce")}).dropna()
    if len(tmp) < 3 or tmp["a"].std() == 0 or tmp["b"].std() == 0:
        return 0.0
    return float(tmp["a"].corr(tmp["b"]))


def sign_match(a: pd.Series, b: pd.Series) -> float:
    tmp = pd.DataFrame({"a": pd.to_numeric(a, errors="coerce"), "b": pd.to_numeric(b, errors="coerce")}).dropna()
    if tmp.empty:
        return 0.0
    return float((np.sign(tmp["a"]) == np.sign(tmp["b"])).mean())


def load_inputs() -> tuple[pd.DataFrame, dict[str, Any]]:
    if not V130_BEST_TRADES.exists():
        raise FileNotFoundError(V130_BEST_TRADES)
    if not V130_SUMMARY.exists():
        raise FileNotFoundError(V130_SUMMARY)
    trades = pd.read_csv(V130_BEST_TRADES)
    with V130_SUMMARY.open("r", encoding="utf-8") as f:
        summary = json.load(f)
    best = summary.get("best_anchor", {})
    if best.get("anchor_name") != "next_after_2000_wait240":
        raise ValueError(f"Unexpected V1.30 anchor: {best.get('anchor_name')}")
    trades["matched"] = trades["matched"].astype(bool)
    for col in [
        "score",
        "anchor_pnl",
        "anchor_pnl_2x_cost",
        "anchor_return",
        "official_settlement_pnl",
        "entry_anchor_volume",
        "exit_anchor_volume",
        "entry_minutes_away",
        "exit_minutes_away",
    ]:
        trades[col] = pd.to_numeric(trades.get(col), errors="coerce")
    return trades, summary


def load_v129_notional() -> dict[str, float]:
    if not V129_SELECTED_TRADES.exists():
        return {"notional_usd": NOTIONAL_USD, "fee_rate": 0.00035, "position_multiplier": 1.0}
    df = pd.read_csv(V129_SELECTED_TRADES)
    df = df[(df.get("variant") == "official_v1_20_base_floor_1p00") & (df.get("official_coverage") == "matched")]
    if df.empty:
        return {"notional_usd": NOTIONAL_USD, "fee_rate": 0.00035, "position_multiplier": 1.0}
    return {
        "notional_usd": float(pd.to_numeric(df["notional_usd"], errors="coerce").dropna().median()),
        "fee_rate": float(pd.to_numeric(df["fee_rate"], errors="coerce").dropna().median()),
        "position_multiplier": float(pd.to_numeric(df["position_multiplier"], errors="coerce").dropna().median()),
    }


def build_trade_replay(trades: pd.DataFrame) -> pd.DataFrame:
    rows = trades.copy()
    rows["v131_execution_decision"] = np.where(rows["matched"], "execute_at_frozen_anchor", "skip_uncovered_anchor")
    rows["v131_skip_reason"] = np.where(
        rows["matched"],
        "",
        "entry=" + rows["entry_anchor_status"].astype(str) + "; exit=" + rows["exit_anchor_status"].astype(str),
    )
    rows["v131_paper_pnl_usd"] = np.where(rows["matched"], rows["anchor_pnl"], 0.0)
    rows["v131_paper_pnl_2x_fee_usd"] = np.where(rows["matched"], rows["anchor_pnl_2x_cost"], 0.0)
    rows["v131_forfeited_official_pnl_usd"] = np.where(rows["matched"], 0.0, rows["official_settlement_pnl"])
    rows["v131_execution_anchor"] = "next_after_2000_wait240"
    rows["v131_unimputed"] = True
    return rows


def cost_matrix(replay: pd.DataFrame, notional: float) -> list[dict[str, Any]]:
    matched = replay[replay["matched"]].copy()
    rows: list[dict[str, Any]] = []
    for fee_mode, pnl_col, fee_multiplier in [
        ("fee_1x", "anchor_pnl", 1.0),
        ("fee_2x", "anchor_pnl_2x_cost", 2.0),
    ]:
        for bps_per_side in [0.0, 0.5, 1.0, 2.0, 3.0, 5.0, 10.0]:
            roundtrip_slippage = notional * (bps_per_side / 10_000.0) * 2.0
            pnl = pd.to_numeric(matched[pnl_col], errors="coerce").fillna(0.0) - roundtrip_slippage
            block = metric_block(pnl.tolist(), total_signals=len(replay), executed=len(matched))
            rows.append(
                {
                    "scenario": f"{fee_mode}_plus_{bps_per_side:g}bps_per_side",
                    "fee_mode": fee_mode,
                    "fee_multiplier": fee_multiplier,
                    "extra_slippage_bps_per_side": bps_per_side,
                    "extra_slippage_usd_roundtrip": roundtrip_slippage,
                    "bbo_mbp_source": "not_available_proxy_stress",
                    **block,
                }
            )
    return rows


def build_uncovered_audit(replay: pd.DataFrame) -> pd.DataFrame:
    uncovered = replay[~replay["matched"]].copy()
    if uncovered.empty:
        return pd.DataFrame()
    status = (
        uncovered.groupby(["entry_anchor_status", "exit_anchor_status", "split"], dropna=False)
        .agg(
            count=("trade_id_v130", "size"),
            official_pnl_at_risk_usd=("official_settlement_pnl", "sum"),
            avg_score=("score", "mean"),
        )
        .reset_index()
    )
    status["production_handling"] = "skip_no_imputation"
    status["required_fix"] = np.where(
        status["entry_anchor_status"].astype(str).str.contains("missing_feed")
        | status["exit_anchor_status"].astype(str).str.contains("missing_feed"),
        "download_or_repair_missing_minute_feed",
        "expand_anchor_window_or_accept_no_trade_day",
    )
    return status


def build_summary(trades: pd.DataFrame, replay: pd.DataFrame, prior_summary: dict[str, Any], notional_info: dict[str, float]) -> dict[str, Any]:
    matched = replay[replay["matched"]].copy()
    uncovered = replay[~replay["matched"]].copy()
    official_all = metric_block(pd.to_numeric(replay["official_settlement_pnl"], errors="coerce").fillna(0.0).tolist())
    exec_base = metric_block(pd.to_numeric(matched["anchor_pnl"], errors="coerce").fillna(0.0).tolist(), total_signals=len(replay), executed=len(matched))
    exec_2x = metric_block(pd.to_numeric(matched["anchor_pnl_2x_cost"], errors="coerce").fillna(0.0).tolist(), total_signals=len(replay), executed=len(matched))

    split_rows: dict[str, Any] = {}
    for split in ["rolling", "holdout"]:
        sub = replay[(replay["split"] == split) & (replay["matched"])]
        split_rows[split] = {
            "signals": int((replay["split"] == split).sum()),
            "executed": int(len(sub)),
            "coverage_rate": float(len(sub) / max(1, (replay["split"] == split).sum())),
            "net_pnl_usd": float(pd.to_numeric(sub["anchor_pnl"], errors="coerce").fillna(0.0).sum()),
            "net_pnl_2x_fee_usd": float(pd.to_numeric(sub["anchor_pnl_2x_cost"], errors="coerce").fillna(0.0).sum()),
            "official_pnl_executed_subset_usd": float(pd.to_numeric(sub["official_settlement_pnl"], errors="coerce").fillna(0.0).sum()),
            "official_pnl_uncovered_usd": float(pd.to_numeric(replay[(replay["split"] == split) & (~replay["matched"])]["official_settlement_pnl"], errors="coerce").fillna(0.0).sum()),
        }

    # The 3 bps/side 2x-fee case is intentionally conservative for a one-contract
    # paper baseline when no BBO/MBP depth file is available.
    stress = pd.DataFrame(cost_matrix(replay, notional_info["notional_usd"]))
    stress_row = stress[(stress["fee_mode"] == "fee_2x") & (stress["extra_slippage_bps_per_side"] == 3.0)].iloc[0].to_dict()

    coverage_rate = float(len(matched) / len(replay)) if len(replay) else 0.0
    gate = {
        "requires": {
            "frozen_anchor": "next_after_2000_wait240",
            "coverage_rate": ">= 0.80",
            "no_imputed_uncovered_trades": True,
            "rolling_and_holdout_net_pnl": "> 0",
            "fee_2x_plus_3bps_per_side_net_pnl": "> 0",
            "pnl_corr_vs_official_executed_subset": ">= 0.90",
            "sign_match_vs_official_executed_subset": ">= 0.90",
        },
        "actual": {
            "coverage_rate": coverage_rate,
            "uncovered_trades": int(len(uncovered)),
            "rolling_net_pnl": split_rows["rolling"]["net_pnl_usd"],
            "holdout_net_pnl": split_rows["holdout"]["net_pnl_usd"],
            "fee_2x_plus_3bps_per_side_net_pnl": float(stress_row["net_pnl_usd"]),
            "pnl_corr_vs_official_executed_subset": safe_corr(matched["official_settlement_pnl"], matched["anchor_pnl"]),
            "sign_match_vs_official_executed_subset": sign_match(matched["official_settlement_pnl"], matched["anchor_pnl"]),
        },
    }
    passed = (
        coverage_rate >= 0.80
        and len(uncovered) > 0
        and split_rows["rolling"]["net_pnl_usd"] > 0
        and split_rows["holdout"]["net_pnl_usd"] > 0
        and float(stress_row["net_pnl_usd"]) > 0
        and gate["actual"]["pnl_corr_vs_official_executed_subset"] >= 0.90
        and gate["actual"]["sign_match_vs_official_executed_subset"] >= 0.90
    )
    # A pass with uncovered trades remains a paper-baseline candidate, not an
    # automatic live strategy promotion.
    status = "gold_execution_paper_baseline_candidate" if passed else "gold_execution_paper_baseline_watchlist"

    return {
        "version": VERSION,
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "status": status,
        "source": {
            "v130_anchor_status": prior_summary.get("status"),
            "v130_best_anchor": prior_summary.get("best_anchor", {}).get("anchor_name"),
            "v130_anchor_time_utc": prior_summary.get("best_anchor", {}).get("anchor_time_utc"),
            "signal_lineage": "V1.29 official-settlement baseline, selected official_v1_20_base_floor_1p00",
        },
        "notional": notional_info,
        "execution_policy": {
            "anchor": "next_after_2000_wait240",
            "action_when_anchor_missing": "skip_uncovered_anchor_no_imputation",
            "q_or_trailing_tuning": "not_allowed_in_v1_31",
            "bbo_mbp_status": "not_available; stress matrix only",
        },
        "signal_counts": {
            "total_signals": int(len(replay)),
            "executed_trades": int(len(matched)),
            "skipped_uncovered": int(len(uncovered)),
            "coverage_rate": coverage_rate,
            "forfeited_official_pnl_usd": float(pd.to_numeric(uncovered["official_settlement_pnl"], errors="coerce").fillna(0.0).sum()),
        },
        "official_all_signals_reference": official_all,
        "execution_base": exec_base,
        "execution_2x_fee": exec_2x,
        "execution_stress_reference": {
            "scenario": stress_row["scenario"],
            "net_pnl_usd": stress_row["net_pnl_usd"],
            "profit_factor": stress_row["profit_factor"],
            "max_drawdown_usd": stress_row["max_drawdown_usd"],
        },
        "split_audit": split_rows,
        "gate": {**gate, "passed": passed},
        "next_step": "V1.32 can either repair the 12 uncovered anchor gaps or attach real BBO/MBP cost data. Q/trailing should remain frozen until one of those is complete.",
    }


def write_report(summary: dict[str, Any], cost_rows: list[dict[str, Any]], uncovered: pd.DataFrame) -> None:
    lines = [
        f"# {VERSION}",
        "",
        "## 定位",
        "",
        "V1.31 把 V1.30 的 `next_after_2000_wait240` 固化成生产级 paper baseline。",
        "本轮不调 Q 动态退出、不调 trailing，也不改变 V1.29/V1.30 的交易信号。",
        "",
        "## 结论",
        "",
        f"- 状态：`{summary['status']}`",
        f"- 总信号：{summary['signal_counts']['total_signals']}，执行：{summary['signal_counts']['executed_trades']}，跳过：{summary['signal_counts']['skipped_uncovered']}",
        f"- 执行覆盖率：{summary['signal_counts']['coverage_rate']:.2%}",
        f"- 跳过交易的官方 settlement 机会成本：${summary['signal_counts']['forfeited_official_pnl_usd']:.2f}",
        f"- 执行净收益：${summary['execution_base']['net_pnl_usd']:.2f}，PF {summary['execution_base']['profit_factor']:.3f}",
        f"- 2x fee 净收益：${summary['execution_2x_fee']['net_pnl_usd']:.2f}，PF {summary['execution_2x_fee']['profit_factor']:.3f}",
        f"- 2x fee + 3bps/side 压力净收益：${summary['execution_stress_reference']['net_pnl_usd']:.2f}，PF {summary['execution_stress_reference']['profit_factor']:.3f}",
        f"- 执行子集与官方 settlement PnL 相关：{summary['gate']['actual']['pnl_corr_vs_official_executed_subset']:.3f}",
        f"- 执行子集方向一致率：{summary['gate']['actual']['sign_match_vs_official_executed_subset']:.2%}",
        "",
        "## 生产规则",
        "",
        "- 如果 entry 或 exit 的冻结锚点不可观测，生产 paper baseline 直接跳过，不做价格插值。",
        "- BBO/MBP 尚未并入，因此真实盘口成本只能以压力矩阵方式审计，不能宣称真实成交回测。",
        "- 这个版本只固化执行层。Q/trailing 仍冻结。",
        "",
        "## 覆盖缺口",
        "",
    ]
    if uncovered.empty:
        lines.append("- 无未覆盖交易。")
    else:
        for _, row in uncovered.iterrows():
            lines.append(
                f"- `{row['entry_anchor_status']}` / `{row['exit_anchor_status']}` / `{row['split']}`："
                f"{int(row['count'])} 笔，官方机会成本 ${row['official_pnl_at_risk_usd']:.2f}，处理：`skip_no_imputation`"
            )
    lines.extend(
        [
            "",
            "## 下一步",
            "",
            "V1.32 优先二选一：",
            "",
            "1. 补齐这 12 笔未覆盖锚点数据，提升执行覆盖率。",
            "2. 接入真实 BBO/MBP 成本表，替代当前压力矩阵。",
            "",
            "在以上任一项完成前，不建议重新优化 Q 动态退出或 trailing。",
        ]
    )
    (OUT_DIR / "HFCD_Trading_V1_31_GoldExecutionPaperBaseline.md").write_text("\n".join(lines), encoding="utf-8")

    cost = pd.DataFrame(cost_rows)
    fig, axes = plt.subplots(2, 2, figsize=(12, 8))
    axes = axes.flatten()

    fee_2x = cost[cost["fee_mode"] == "fee_2x"].sort_values("extra_slippage_bps_per_side")
    axes[0].plot(fee_2x["extra_slippage_bps_per_side"], fee_2x["net_pnl_usd"], marker="o")
    axes[0].axhline(0, color="black", linewidth=1)
    axes[0].set_title("2x fee stress net PnL")
    axes[0].set_xlabel("extra bps per side")
    axes[0].set_ylabel("USD")

    labels = ["official all", "exec base", "2x fee", "2x+3bps"]
    vals = [
        summary["official_all_signals_reference"]["net_pnl_usd"],
        summary["execution_base"]["net_pnl_usd"],
        summary["execution_2x_fee"]["net_pnl_usd"],
        summary["execution_stress_reference"]["net_pnl_usd"],
    ]
    axes[1].bar(labels, vals, color=["#888", "#1f77b4", "#ff7f0e", "#d62728"])
    axes[1].set_title("Net PnL bridge")
    axes[1].tick_params(axis="x", rotation=25)

    split = summary["split_audit"]
    axes[2].bar(["rolling", "holdout"], [split["rolling"]["net_pnl_usd"], split["holdout"]["net_pnl_usd"]])
    axes[2].set_title("Execution PnL by split")

    axes[3].bar(["executed", "skipped"], [summary["signal_counts"]["executed_trades"], summary["signal_counts"]["skipped_uncovered"]], color=["#2ca02c", "#d62728"])
    axes[3].set_title("Coverage")

    fig.tight_layout()
    fig.savefig(OUT_DIR / "HFCD_Trading_V1_31_GoldExecutionPaperBaseline.png", dpi=180)
    plt.close(fig)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    trades, prior_summary = load_inputs()
    notional_info = load_v129_notional()
    replay = build_trade_replay(trades)
    uncovered_audit = build_uncovered_audit(replay)
    cost_rows = cost_matrix(replay, notional_info["notional_usd"])
    summary = build_summary(trades, replay, prior_summary, notional_info)

    replay.to_csv(OUT_DIR / "hfcd_trading_v1_31_trade_replay.csv", index=False)
    uncovered_audit.to_csv(OUT_DIR / "hfcd_trading_v1_31_uncovered_trade_audit.csv", index=False)
    write_csv(OUT_DIR / "hfcd_trading_v1_31_cost_stress_matrix.csv", cost_rows)
    with (OUT_DIR / "hfcd_trading_v1_31_summary.json").open("w", encoding="utf-8") as f:
        json.dump(clean_json(summary), f, ensure_ascii=False, indent=2)
    write_csv(OUT_DIR / "hfcd_trading_v1_31_summary.csv", [summary])
    write_report(summary, cost_rows, uncovered_audit)
    print(json.dumps(clean_json(summary), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
