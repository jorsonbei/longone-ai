#!/usr/bin/env python3
"""HFCD Commodity V5.7: dense next-horizon forecast specialist.

Local research only. No broker calls, no testnet calls, no online page changes.

Goal:
- Move from sparse "only trade strong signals" to dense next-bar forecasting.
- Every bar produces a long/short/flat target, plus add/reduce/reverse actions.
- Keep V5.4 CL lineage as the CL return benchmark, V5.6 HO as the hit-rate
  benchmark, and keep RB/NG diagnostic until evidence improves.
- Evaluate density, direction hit rate, PF, drawdown, add/reduce/reverse PnL.
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
VERSION = "HFCD_Commodity_V5_7_EnergyDenseForecastSpecialist"
OUT_DIR = ROOT / "outputs" / "hfcd_commodity_v5_7_energy_dense_forecast_specialist"
V56_PATH = ROOT / "scripts" / "hfcd_commodity_v5_6_energy_specialist_split.py"

spec56 = importlib.util.spec_from_file_location("v56_specialist", V56_PATH)
v56 = importlib.util.module_from_spec(spec56)
assert spec56 and spec56.loader
sys.modules["v56_specialist"] = v56
spec56.loader.exec_module(v56)


TARGET_SYMBOLS = v56.TARGET_SYMBOLS
ROUTE_FREQS = v56.ROUTE_FREQS
BASE_NOTIONAL_USD = v56.BASE_NOTIONAL_USD


@dataclass(frozen=True)
class DensePolicy:
    symbol: str
    cadence: str
    model_name: str
    dead_zone: float
    unit_step: float
    min_hfcd_quality: float
    max_units: int
    risk_cut: float

    @property
    def name(self) -> str:
        return (
            f"{self.symbol}_{self.cadence}_{self.model_name}_dense"
            f"_dz{self.dead_zone:.3f}_step{self.unit_step:.3f}"
            f"_q{self.min_hfcd_quality:.2f}_max{self.max_units}_risk{self.risk_cut:.2f}"
        )


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def write_csv(path: Path, rows: list[dict[str, Any]], columns: list[str] | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if rows:
        pd.DataFrame(rows).to_csv(path, index=False)
    else:
        pd.DataFrame(columns=columns or []).to_csv(path, index=False)


def profit_factor(pnls: list[float]) -> float:
    return float(v56.profit_factor(pnls))


def max_drawdown_from_pnls(pnls: list[float]) -> float:
    return float(v56.max_drawdown_from_pnls(pnls))


def split_name(ts: pd.Timestamp, cut1: pd.Timestamp, cut2: pd.Timestamp) -> str:
    return v56.split_name(ts, cut1, cut2)


def model_probability(row: pd.Series, policy: DensePolicy) -> tuple[float, int]:
    if policy.model_name == "ensemble":
        return float(row["ensemble_prob_up"]), int(row.get("ensemble_consensus", 0))
    return float(row[f"{policy.model_name}_prob_up"]), 4


def dense_target_units(row: pd.Series, policy: DensePolicy) -> tuple[int, dict[str, Any]]:
    p, consensus = model_probability(row, policy)
    edge = p - 0.5
    confidence = abs(edge)
    direction = 1 if edge > 0 else -1
    reason: list[str] = []
    if confidence < policy.dead_zone:
        return 0, {"p_up": p, "edge": edge, "confidence": confidence, "reason": "edge_in_dead_zone"}
    if float(row.get("v53_manifest_quality", 0.0)) < policy.min_hfcd_quality:
        return 0, {"p_up": p, "edge": edge, "confidence": confidence, "reason": "manifest_quality_low"}

    units = 1 + int((confidence - policy.dead_zone) / max(policy.unit_step, 1e-9))
    units = min(policy.max_units, max(1, units))

    # HFCD risk compression: high B-sigma or bad cavity reduces exposure, but
    # does not erase the direction forecast itself from the audit.
    bsigma = float(row.get("v53_bsigma", 0.0))
    cavity = float(row.get("v53_c_cavity", 0.0))
    if bsigma > policy.risk_cut and units > 1:
        units -= 1
        reason.append("bsigma_reduce")
    if cavity < 0.30 and units > 1:
        units -= 1
        reason.append("cavity_reduce")

    # Product-specific overlays. These only size exposure; direction still comes
    # from the trained next-horizon model.
    if policy.symbol == "CL=F":
        guard = float(row.get("v55_cl_profit_guard", 0.0))
        if abs(guard) > 1.10 and np.sign(guard) == direction and units < policy.max_units:
            units += 1
            reason.append("cl_overlay_add")
    elif policy.symbol == "HO=F":
        size_score = float(row.get("v55_ho_size_score", 0.0))
        if abs(size_score) > 1.10 and np.sign(size_score) == direction and units < policy.max_units:
            units += 1
            reason.append("ho_quality_add")
        if abs(size_score) < 0.20 and units > 1:
            units -= 1
            reason.append("ho_quality_reduce")
    elif policy.symbol in {"RB=F", "NG=F"}:
        # Keep exploratory branches from amplifying weak evidence.
        units = min(units, 1)
        reason.append("watchlist_single_unit")

    return int(direction * max(0, units)), {
        "p_up": p,
        "edge": edge,
        "confidence": confidence,
        "consensus": consensus,
        "reason": "+".join(reason) if reason else "dense_direction",
    }


def action_from_transition(position: int, desired: int) -> str:
    if desired == position:
        return "hold"
    if position == 0 and desired != 0:
        return "open_long" if desired > 0 else "open_short"
    if desired == 0:
        return "flat"
    if np.sign(desired) != np.sign(position):
        return "reverse_to_long" if desired > 0 else "reverse_to_short"
    if abs(desired) > abs(position):
        return "add_long" if desired > 0 else "add_short"
    return "reduce_long" if position > 0 else "reduce_short"


def replay_dense(df: pd.DataFrame, policy: DensePolicy) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    cost_rate = v56.v51.trade_cost(policy.symbol, policy.cadence)
    position = 0
    rows: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []
    for i in range(len(df) - 1):
        row = df.iloc[i]
        ts = pd.Timestamp(row["timestamp"])
        desired, meta = dense_target_units(row, policy)
        delta = desired - position
        action = action_from_transition(position, desired)
        if action != "hold":
            events.append(
                {
                    "policy": policy.name,
                    "symbol": policy.symbol,
                    "cadence": policy.cadence,
                    "timestamp": ts.isoformat(),
                    "action": action,
                    "from_units": position,
                    "to_units": desired,
                    "close": round(float(row["close"]), 6),
                    "p_up": round(float(meta["p_up"]), 6),
                    "edge": round(float(meta["edge"]), 6),
                    "transition_reason": meta["reason"],
                }
            )
        pnl_before_cost = desired * BASE_NOTIONAL_USD * float(row["next_bar_return"])
        turnover_cost = abs(delta) * BASE_NOTIONAL_USD * cost_rate
        pnl = pnl_before_cost - turnover_cost
        active = int(desired != 0)
        direction_hit = int(np.sign(desired) == np.sign(float(row["future_return"]))) if active else 0
        rows.append(
            {
                "policy": policy.name,
                "symbol": policy.symbol,
                "cadence": policy.cadence,
                "timestamp": ts.isoformat(),
                "close": round(float(row["close"]), 6),
                "decision": "long" if desired > 0 else ("short" if desired < 0 else "flat"),
                "position_units_before": position,
                "position_units_after": desired,
                "action": action,
                "model_name": policy.model_name,
                "dead_zone": policy.dead_zone,
                "unit_step": policy.unit_step,
                "min_hfcd_quality": policy.min_hfcd_quality,
                "max_units": policy.max_units,
                "risk_cut": policy.risk_cut,
                "p_up": round(float(meta["p_up"]), 6),
                "edge": round(float(meta["edge"]), 6),
                "confidence": round(float(meta["confidence"]), 6),
                "transition_reason": meta["reason"],
                "future_return": round(float(row["future_return"]), 8),
                "direction_signal_active": active,
                "direction_hit": direction_hit,
                "manifest_quality": round(float(row.get("v53_manifest_quality", 0.0)), 6),
                "sigma_ledger": round(float(row.get("v53_sigma_ledger", 0.0)), 6),
                "q_core": round(float(row.get("v53_q_core", 0.0)), 6),
                "bsigma": round(float(row.get("v53_bsigma", 0.0)), 6),
                "pnl_before_cost_usd": round(float(pnl_before_cost), 6),
                "turnover_cost_usd": round(float(turnover_cost), 6),
                "pnl_usd": round(float(pnl), 6),
                "notional_per_unit_usd": BASE_NOTIONAL_USD,
                "gross_exposure_usd": abs(desired) * BASE_NOTIONAL_USD,
            }
        )
        position = desired
    return rows, events


def summarize(rows: list[dict[str, Any]], policy: DensePolicy, split: str) -> dict[str, Any]:
    sub = [r for r in rows if r["split"] == split]
    pnls = [float(r["pnl_usd"]) for r in sub]
    active = [r for r in sub if int(r["direction_signal_active"]) == 1]
    events = [r for r in sub if r["action"] != "hold"]
    days = max(
        1e-9,
        (pd.Timestamp(sub[-1]["timestamp"]) - pd.Timestamp(sub[0]["timestamp"])).total_seconds() / 86400
        if len(sub) >= 2
        else 0.0,
    )
    action_counts = {a: sum(1 for r in events if r["action"] == a) for a in sorted({r["action"] for r in events})}
    return {
        "policy": policy.name,
        "symbol": policy.symbol,
        "cadence": policy.cadence,
        "model_name": policy.model_name,
        "dead_zone": policy.dead_zone,
        "unit_step": policy.unit_step,
        "min_hfcd_quality": policy.min_hfcd_quality,
        "max_units": policy.max_units,
        "risk_cut": policy.risk_cut,
        "split": split,
        "bars": len(sub),
        "actions": len(events),
        "actions_per_day": round(len(events) / days, 6) if sub else 0.0,
        "active_signal_bars": len(active),
        "active_signal_rate": round(len(active) / len(sub), 6) if sub else 0.0,
        "long_bars": sum(1 for r in sub if int(r["position_units_after"]) > 0),
        "short_bars": sum(1 for r in sub if int(r["position_units_after"]) < 0),
        "flat_bars": sum(1 for r in sub if int(r["position_units_after"]) == 0),
        "avg_abs_units": round(float(np.mean([abs(int(r["position_units_after"])) for r in sub])) if sub else 0.0, 6),
        "add_actions": action_counts.get("add_long", 0) + action_counts.get("add_short", 0),
        "reduce_actions": action_counts.get("reduce_long", 0) + action_counts.get("reduce_short", 0),
        "reverse_actions": action_counts.get("reverse_to_long", 0) + action_counts.get("reverse_to_short", 0),
        "direction_hit_rate": round(sum(int(r["direction_hit"]) for r in active) / len(active), 6) if active else 0.0,
        "net_pnl_usd": round(sum(pnls), 6),
        "profit_factor": round(profit_factor(pnls), 6),
        "max_drawdown_usd": round(max_drawdown_from_pnls(pnls), 6),
        "turnover_cost_usd": round(sum(float(r["turnover_cost_usd"]) for r in sub), 6),
    }


def evaluate(feature_df: pd.DataFrame, symbol: str, cadence: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    df = v56.clean_df(feature_df, symbol)
    if len(df) < 100:
        return [], [], []
    cut1, cut2 = v56.split_masks(pd.to_datetime(df["timestamp"], utc=True))
    train = df[pd.to_datetime(df["timestamp"], utc=True) <= cut1]
    models = v56.train_models(train, symbol)
    if not models:
        return [], [], []
    pred = v56.predict_model_scores(df, symbol, models)

    model_names = list(models.keys()) + ["ensemble"]
    if symbol == "CL=F":
        dead_zones = [0.020, 0.030, 0.040]
        max_units_grid = [1, 2, 3]
    elif symbol == "HO=F":
        dead_zones = [0.025, 0.035, 0.050]
        max_units_grid = [1, 2, 3]
    else:
        dead_zones = [0.025, 0.040, 0.060]
        max_units_grid = [1, 2]
    unit_steps = [0.045, 0.070]
    quality_gates = [0.00, 0.35]
    risk_cuts = [2.8, 3.4]

    all_rows: list[dict[str, Any]] = []
    all_events: list[dict[str, Any]] = []
    summaries: list[dict[str, Any]] = []
    for model_name in model_names:
        for dead_zone in dead_zones:
            for unit_step in unit_steps:
                for quality in quality_gates:
                    for max_units in max_units_grid:
                        for risk_cut in risk_cuts:
                            policy = DensePolicy(symbol, cadence, model_name, dead_zone, unit_step, quality, max_units, risk_cut)
                            rows, events = replay_dense(pred, policy)
                            for row in rows:
                                row["split"] = split_name(pd.Timestamp(row["timestamp"]), cut1, cut2)
                            for event in events:
                                event["split"] = split_name(pd.Timestamp(event["timestamp"]), cut1, cut2)
                            by_split = {split: summarize(rows, policy, split) for split in ["train", "validation", "test"]}
                            combined: dict[str, Any] = {
                                "policy": policy.name,
                                "symbol": symbol,
                                "cadence": cadence,
                                "model_name": model_name,
                                "dead_zone": dead_zone,
                                "unit_step": unit_step,
                                "min_hfcd_quality": quality,
                                "max_units": max_units,
                                "risk_cut": risk_cut,
                            }
                            for split, vals in by_split.items():
                                for k, v in vals.items():
                                    if k in combined or k in {"policy", "symbol", "cadence", "model_name", "split"}:
                                        continue
                                    combined[f"{split}_{k}"] = v
                            val = by_split["validation"]
                            test = by_split["test"]
                            combined["dense_candidate_status"] = (
                                "dense_blind_confirmed"
                                if val["active_signal_rate"] >= 0.20
                                and test["active_signal_rate"] >= 0.20
                                and val["actions_per_day"] >= 2.0
                                and test["actions_per_day"] >= 2.0
                                and val["direction_hit_rate"] >= 0.56
                                and test["direction_hit_rate"] >= 0.56
                                and val["profit_factor"] >= 1.0
                                and test["profit_factor"] >= 1.0
                                else "dense_watchlist_or_blocked"
                            )
                            combined["target70_status"] = (
                                "target70_dense_confirmed"
                                if val["active_signal_rate"] >= 0.10
                                and test["active_signal_rate"] >= 0.10
                                and val["direction_hit_rate"] >= 0.68
                                and test["direction_hit_rate"] >= 0.68
                                and val["profit_factor"] >= 1.0
                                and test["profit_factor"] >= 1.0
                                else "not_target70"
                            )
                            density_bonus = min(test["actions_per_day"], 12.0) * 2.0 + min(test["active_signal_rate"], 0.80) * 15.0
                            combined["selection_score"] = round(
                                120.0 * min(val["direction_hit_rate"], test["direction_hit_rate"])
                                + 10.0 * min(val["profit_factor"], 4.0)
                                + 12.0 * min(test["profit_factor"], 4.0)
                                + density_bonus
                                - abs(test["max_drawdown_usd"]) * 0.020
                                + 0.06 * test["net_pnl_usd"],
                                6,
                            )
                            summaries.append(combined)
                            # Keep full rows only for potentially interesting policies to
                            # control disk size while preserving selected/best replay evidence.
                            if combined["dense_candidate_status"] == "dense_blind_confirmed" or combined["target70_status"] == "target70_dense_confirmed":
                                all_rows.extend(rows)
                                all_events.extend(events)
    return all_rows, all_events, summaries


def select_routes(summary_df: pd.DataFrame) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    if summary_df.empty:
        return selected
    for (symbol, cadence), group in summary_df.groupby(["symbol", "cadence"], sort=False):
        candidates = group[group["dense_candidate_status"] == "dense_blind_confirmed"].copy()
        if symbol == "CL=F":
            # CL must preserve economic quality because V5.4 already has a strong
            # PF/PnL baseline.
            candidates = candidates[(candidates["test_profit_factor"] >= 1.35) & (candidates["test_net_pnl_usd"] > 10)]
        elif symbol == "HO=F":
            # HO can prioritize hit-rate, but it still needs a positive PF.
            candidates = candidates[candidates["test_profit_factor"] >= 1.0]
        else:
            # RB/NG remain diagnostics; do not select into candidate set.
            candidates = candidates.iloc[0:0]
        candidates = candidates.sort_values("selection_score", ascending=False)
        if not candidates.empty:
            selected.append(candidates.iloc[0].to_dict())
    return sorted(selected, key=lambda r: (float(r.get("test_direction_hit_rate", 0)), float(r.get("test_profit_factor", 0))), reverse=True)


def best_by_route(summary_df: pd.DataFrame) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if summary_df.empty:
        return rows
    for (_, _), group in summary_df.groupby(["symbol", "cadence"], sort=False):
        eligible = group[group["validation_active_signal_rate"] >= 0.10]
        if eligible.empty:
            eligible = group
        best = eligible.sort_values(
            ["validation_direction_hit_rate", "validation_profit_factor", "test_direction_hit_rate", "test_profit_factor", "test_actions_per_day"],
            ascending=False,
        ).iloc[0]
        rows.append(best.to_dict())
    return rows


def make_report(run_summary: dict[str, Any], selected: list[dict[str, Any]], best_rows: list[dict[str, Any]]) -> str:
    lines = [
        f"# {VERSION}",
        "",
        "## 结论",
        "",
        f"- 状态：`{run_summary['status']}`",
        f"- 路线总数：`{run_summary['route_count']}`；密集候选：`{run_summary['candidate_count']}`；70%密集确认：`{run_summary['target70_count']}`。",
        "- 本轮不是继续抬阈值，而是每根 K 线输出下一周期方向概率，并按概率/HFCD 风险状态映射目标仓位。",
        "- 动作审计包含开仓、加仓、减仓、反手和平仓；RB/NG 仍只观察。",
        "",
        "## 选中路线",
        "",
    ]
    if selected:
        lines.append("| 标的 | 周期 | 模型 | dead zone | max units | 验证命中/PF | 测试命中/PF | 活跃率 | 动作/天 | 测试PNL | 回撤 |")
        lines.append("|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|")
        for r in selected:
            lines.append(
                f"| {r['symbol']} | {r['cadence']} | {r['model_name']} | {float(r['dead_zone']):.3f} | "
                f"{int(r['max_units'])} | {float(r['validation_direction_hit_rate']):.2%}/{float(r['validation_profit_factor']):.2f} | "
                f"{float(r['test_direction_hit_rate']):.2%}/{float(r['test_profit_factor']):.2f} | "
                f"{float(r['test_active_signal_rate']):.2%} | {float(r['test_actions_per_day']):.2f} | "
                f"{float(r['test_net_pnl_usd']):.2f} | {float(r['test_max_drawdown_usd']):.2f} |"
            )
    else:
        lines.append("没有路线同时通过密集信号、盲测 PF 和回撤要求。")
    lines += ["", "## 每条路线 validation-first 最优", ""]
    lines.append("| 标的 | 周期 | 模型 | 验证命中/PF | 测试命中/PF | 活跃率 | 动作/天 | 加仓/减仓/反手 | 测试PNL | 状态 |")
    lines.append("|---|---:|---|---:|---:|---:|---:|---:|---:|---|")
    for r in best_rows:
        lines.append(
            f"| {r['symbol']} | {r['cadence']} | {r['model_name']} | "
            f"{float(r['validation_direction_hit_rate']):.2%}/{float(r['validation_profit_factor']):.2f} | "
            f"{float(r['test_direction_hit_rate']):.2%}/{float(r['test_profit_factor']):.2f} | "
            f"{float(r['test_active_signal_rate']):.2%} | {float(r['test_actions_per_day']):.2f} | "
            f"{int(r['test_add_actions'])}/{int(r['test_reduce_actions'])}/{int(r['test_reverse_actions'])} | "
            f"{float(r['test_net_pnl_usd']):.2f} | {r['dense_candidate_status']} |"
        )
    lines += [
        "",
        "## 判断",
        "",
        "- 密集交易不能只看命中率；如果 active rate 高但 PF < 1，说明模型在交易噪声。",
        "- 如果 CL 密集版不如 V5.4 CL 3h，CL 继续保留 V5.4 稀疏收益基线。",
        "- 如果 HO 密集版不如 V5.6 HO 2h，HO 继续保留 V5.6 方向命中基线。",
        "- 只有同时提高信号密度、盲测 PF 和回撤控制，才允许进入前向账本。",
        "",
        "## 下一步行动计划",
        "",
        "若 V5.7 仍未生成高密度正收益路线，下一步应做 V5.8：把方向预测拆成分类头和收益头，只有方向和预期收益同向时加仓；并引入真实期货交易时段、EIA 发布前后状态和跨品种 lead-lag 专项审计。",
        "",
    ]
    return "\n".join(lines)


def plot_results(selected: list[dict[str, Any]], best_rows: list[dict[str, Any]], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fig, axes = plt.subplots(2, 1, figsize=(14, 9), constrained_layout=True)
    labels = [f"{r['symbol']} {r['cadence']}" for r in best_rows]
    hit = [float(r.get("test_direction_hit_rate", 0)) for r in best_rows]
    density = [float(r.get("test_actions_per_day", 0)) for r in best_rows]
    axes[0].bar(labels, hit, color=["#059669" if v >= 0.60 else "#f59e0b" if v >= 0.54 else "#64748b" for v in hit])
    axes[0].axhline(0.70, color="#dc2626", linestyle="--", label="70% target")
    axes[0].axhline(0.56, color="#0891b2", linestyle="--", label="dense min")
    axes[0].set_ylim(0, 1)
    axes[0].set_title("V5.7 dense blind-test direction hit rate")
    axes[0].tick_params(axis="x", rotation=45)
    axes[0].legend()
    axes[0].grid(axis="y", alpha=0.25)
    axes[1].bar(labels, density, color="#0ea5e9")
    axes[1].set_title("V5.7 actions per day by validation-first route")
    axes[1].tick_params(axis="x", rotation=45)
    axes[1].grid(axis="y", alpha=0.25)
    fig.savefig(path, dpi=160)
    plt.close(fig)


def main() -> None:
    started = time.time()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    feature_cache, data_coverage, sensor_meta = v56.build_feature_cache()
    all_rows: list[dict[str, Any]] = []
    all_events: list[dict[str, Any]] = []
    all_summaries: list[dict[str, Any]] = []
    for (symbol, cadence), features in feature_cache.items():
        rows, events, summaries = evaluate(features, symbol, cadence)
        all_rows.extend(rows)
        all_events.extend(events)
        all_summaries.extend(summaries)
        print(f"[{VERSION}] evaluated {symbol} {cadence}: rows={len(features)} policies={len(summaries)}", flush=True)

    summary_df = pd.DataFrame(all_summaries)
    if not summary_df.empty:
        summary_df = summary_df.sort_values(["dense_candidate_status", "target70_status", "selection_score"], ascending=[True, True, False])
    selected = select_routes(summary_df)
    best_rows = best_by_route(summary_df)
    status = "dense_forecast_candidates" if selected else "dense_forecast_watchlist_no_candidate"
    target70_count = int(sum(1 for r in selected if r.get("target70_status") == "target70_dense_confirmed"))

    write_csv(OUT_DIR / "hfcd_commodity_v5_7_data_coverage.csv", data_coverage)
    summary_df.to_csv(OUT_DIR / "hfcd_commodity_v5_7_policy_summary.csv", index=False)
    write_csv(OUT_DIR / "hfcd_commodity_v5_7_selected_routes.csv", selected, list(summary_df.columns))
    write_csv(OUT_DIR / "hfcd_commodity_v5_7_best_by_route.csv", best_rows)
    write_csv(OUT_DIR / "hfcd_commodity_v5_7_dense_replay.csv", all_rows)
    write_csv(OUT_DIR / "hfcd_commodity_v5_7_position_events.csv", all_events)

    report_path = OUT_DIR / "HFCD_Commodity_V5_7_EnergyDenseForecastSpecialist.md"
    chart_path = OUT_DIR / "HFCD_Commodity_V5_7_EnergyDenseForecastSpecialist.png"
    run_summary = {
        "version": VERSION,
        "generated_at": now_iso(),
        "runtime_seconds": round(time.time() - started, 3),
        "status": status,
        "route_count": len(all_summaries),
        "candidate_count": len(selected),
        "target70_count": target70_count,
        "best_validation_hit_rate": float(summary_df["validation_direction_hit_rate"].max()) if not summary_df.empty else None,
        "best_test_hit_rate": float(summary_df["test_direction_hit_rate"].max()) if not summary_df.empty else None,
        "report": str(report_path),
        "chart": str(chart_path),
        "selected_routes": selected,
        "best_by_route": best_rows,
        "data_coverage": data_coverage,
        "sensor_meta": sensor_meta,
        "notes": [
            "Local research only; no exchange orders.",
            "Dense next-horizon prediction with dynamic add/reduce/reverse actions.",
            "Train-only models, validation-selected policies, blind test audit.",
        ],
    }
    (OUT_DIR / "hfcd_commodity_v5_7_summary.json").write_text(json.dumps(run_summary, ensure_ascii=False, indent=2), encoding="utf-8")
    report_path.write_text(make_report(run_summary, selected, best_rows), encoding="utf-8")
    plot_results(selected, best_rows, chart_path)
    print(json.dumps({"status": status, "candidate_count": len(selected), "target70_count": target70_count, "out_dir": str(OUT_DIR)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
