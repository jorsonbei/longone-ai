#!/usr/bin/env python3
"""
HFCD Trading V1.32 Gold Anchor Gap Repair.

V1.31 froze the V1.30 execution anchor and skipped 12 uncovered signals without
imputation. This stage tests whether a deterministic fallback anchor ladder can
repair those 12 gaps without degrading the execution baseline.

This is still an execution-layer audit. It does not change the V1.29 signal,
and it does not tune Q/trailing.
"""

from __future__ import annotations

import csv
import importlib.util
import json
import math
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


VERSION = "HFCD_Trading_V1_32_GoldAnchorGapRepair"
ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v1_32_gold_anchor_gap_repair"
V130_SCRIPT = ROOT / "scripts" / "hfcd_trading_v1_30_gold_tradable_execution_anchor.py"
V130_DIR = ROOT / "outputs" / "hfcd_trading_v1_30_gold_tradable_execution_anchor"
V131_DIR = ROOT / "outputs" / "hfcd_trading_v1_31_gold_execution_paper_baseline"
V130_BEST_TRADES = V130_DIR / "hfcd_trading_v1_30_best_anchor_trades.csv"
V131_SUMMARY = V131_DIR / "hfcd_trading_v1_31_summary.json"

PRIMARY_ANCHOR = "next_after_2000_wait240"
FALLBACK_LADDER = [
    "next_after_2025_wait240",
    "next_after_2045_wait240",
    "next_after_2125_wait240",
    "next_after_2130_wait240",
]
NOTIONAL_USD = 10_000.0


def import_v130() -> Any:
    # V1.32 uses existing cached minute windows. Direct refetch of the currently
    # missing future dates was tested to return no Databento rows, so this audit
    # should be deterministic and not spend more API quota by default.
    os.environ.setdefault("HFCD_V130_FETCH_MISSING", "0")
    spec = importlib.util.spec_from_file_location("hfcd_v130_anchor", V130_SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot import {V130_SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["hfcd_v130_anchor"] = module
    spec.loader.exec_module(module)
    return module


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


def metrics(values: list[float], total_signals: int) -> dict[str, Any]:
    vals = [float(v) for v in values]
    wins = [v for v in vals if v > 0]
    losses = [v for v in vals if v < 0]
    gross_win = float(sum(wins))
    gross_loss = float(abs(sum(losses)))
    return {
        "signals": int(total_signals),
        "executed": len(vals),
        "wins": len(wins),
        "losses": len(losses),
        "win_rate_executed": float(len(wins) / len(vals)) if vals else 0.0,
        "win_rate_all_signals": float(len(wins) / total_signals) if total_signals else 0.0,
        "net_pnl_usd": float(sum(vals)),
        "profit_factor": float(gross_win / gross_loss) if gross_loss > 0 else (999.0 if gross_win > 0 else 0.0),
        "max_drawdown_usd": max_drawdown(vals),
        "gross_win_usd": gross_win,
        "gross_loss_usd": gross_loss,
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


def load_v131_summary() -> dict[str, Any]:
    if not V131_SUMMARY.exists():
        return {}
    with V131_SUMMARY.open("r", encoding="utf-8") as f:
        return json.load(f)


def load_primary_best() -> pd.DataFrame:
    if not V130_BEST_TRADES.exists():
        raise FileNotFoundError(V130_BEST_TRADES)
    df = pd.read_csv(V130_BEST_TRADES)
    df["matched"] = df["matched"].astype(bool)
    for col in ["anchor_pnl", "anchor_pnl_2x_cost", "official_settlement_pnl", "score"]:
        df[col] = pd.to_numeric(df.get(col), errors="coerce")
    return df


def load_anchor_frames(v130: Any, anchor_names: list[str]) -> dict[str, pd.DataFrame]:
    trades = v130.load_selected_trades()
    store = v130.MinuteStore()
    specs = {spec.name: spec for spec in v130.build_anchor_specs()}
    out: dict[str, pd.DataFrame] = {}
    for name in anchor_names:
        if name not in specs:
            raise KeyError(f"Anchor spec not found: {name}")
        out[name] = v130.run_anchor(specs[name], trades, store)
    return out


def replay_with_fallback(primary: pd.DataFrame, fallback_frames: dict[str, pd.DataFrame]) -> pd.DataFrame:
    rows: list[pd.Series] = []
    for _, row in primary.sort_values("trade_id_v130").iterrows():
        chosen = row.copy()
        if bool(row["matched"]):
            chosen["resolved_by_anchor"] = PRIMARY_ANCHOR
            chosen["resolution_mode"] = "primary"
            chosen["production_decision"] = "execute_primary_anchor"
        else:
            chosen["resolved_by_anchor"] = "uncovered_skip"
            chosen["resolution_mode"] = "skip"
            chosen["production_decision"] = "skip_no_observable_anchor"
            for name in FALLBACK_LADDER:
                candidate = fallback_frames[name]
                candidate_row = candidate[candidate["trade_id_v130"] == row["trade_id_v130"]].iloc[0].copy()
                if bool(candidate_row["matched"]):
                    chosen = candidate_row
                    chosen["resolved_by_anchor"] = name
                    chosen["resolution_mode"] = "fallback"
                    chosen["production_decision"] = "execute_fallback_anchor_audit_only"
                    break
        rows.append(chosen)
    replay = pd.DataFrame(rows).sort_values(["date", "trade_id_v130"]).reset_index(drop=True)
    return replay


def fallback_ladder_audit(primary: pd.DataFrame, fallback_frames: dict[str, pd.DataFrame]) -> pd.DataFrame:
    uncovered_ids = set(primary.loc[~primary["matched"], "trade_id_v130"].astype(int).tolist())
    rows: list[dict[str, Any]] = []
    for name, frame in fallback_frames.items():
        m = frame[frame["matched"]].copy()
        un = frame[frame["trade_id_v130"].isin(uncovered_ids) & frame["matched"]].copy()
        rows.append(
            {
                "anchor": name,
                "fallback_ladder_order": FALLBACK_LADDER.index(name) + 1,
                "all_matched": int(len(m)),
                "previously_uncovered_matched": int(len(un)),
                "all_net_pnl_usd": float(pd.to_numeric(m["anchor_pnl"], errors="coerce").fillna(0.0).sum()),
                "previously_uncovered_net_pnl_usd": float(pd.to_numeric(un["anchor_pnl"], errors="coerce").fillna(0.0).sum()),
                "all_pnl_corr_vs_official": safe_corr(m["official_settlement_pnl"], m["anchor_pnl"]),
                "all_sign_match_vs_official": sign_match(m["official_settlement_pnl"], m["anchor_pnl"]),
                "all_mean_abs_pnl_diff": float(pd.to_numeric(m["pnl_delta_vs_official"], errors="coerce").abs().mean()) if len(m) else 999.0,
            }
        )
    return pd.DataFrame(rows)


def build_unresolved_audit(replay: pd.DataFrame) -> pd.DataFrame:
    unresolved = replay[~replay["matched"]].copy()
    if unresolved.empty:
        return pd.DataFrame()
    rows = (
        unresolved.groupby(["entry_anchor_status", "exit_anchor_status", "split"], dropna=False)
        .agg(
            count=("trade_id_v130", "size"),
            official_pnl_at_risk_usd=("official_settlement_pnl", "sum"),
            avg_score=("score", "mean"),
        )
        .reset_index()
    )
    rows["remaining_reason"] = np.where(
        rows["entry_anchor_status"].astype(str).str.contains("missing_feed")
        | rows["exit_anchor_status"].astype(str).str.contains("missing_feed"),
        "missing_databento_minute_feed_for_contract_date",
        "contract_has_no_trade_after_anchor_in_ladder",
    )
    return rows


def cost_matrix(replay: pd.DataFrame) -> pd.DataFrame:
    m = replay[replay["matched"]].copy()
    rows: list[dict[str, Any]] = []
    for fee_mode, pnl_col in [("fee_1x", "anchor_pnl"), ("fee_2x", "anchor_pnl_2x_cost")]:
        for bps_per_side in [0.0, 1.0, 2.0, 3.0, 5.0, 10.0]:
            slip = NOTIONAL_USD * (bps_per_side / 10_000.0) * 2.0
            pnl = pd.to_numeric(m[pnl_col], errors="coerce").fillna(0.0) - slip
            rows.append(
                {
                    "scenario": f"{fee_mode}_plus_{bps_per_side:g}bps_per_side",
                    "fee_mode": fee_mode,
                    "extra_slippage_bps_per_side": bps_per_side,
                    "extra_slippage_usd_roundtrip": slip,
                    **metrics(pnl.tolist(), total_signals=len(replay)),
                }
            )
    return pd.DataFrame(rows)


def summarize(primary: pd.DataFrame, replay: pd.DataFrame, v131_summary: dict[str, Any]) -> dict[str, Any]:
    primary_m = primary[primary["matched"]].copy()
    replay_m = replay[replay["matched"]].copy()
    fallback_m = replay[replay["resolution_mode"] == "fallback"].copy()
    unresolved = replay[~replay["matched"]].copy()
    stress = cost_matrix(replay)
    stress_ref = stress[(stress["fee_mode"] == "fee_2x") & (stress["extra_slippage_bps_per_side"] == 3.0)].iloc[0].to_dict()
    fallback_metrics = metrics(pd.to_numeric(fallback_m["anchor_pnl"], errors="coerce").fillna(0.0).tolist(), total_signals=len(fallback_m)) if len(fallback_m) else metrics([], total_signals=0)

    coverage = float(len(replay_m) / len(replay)) if len(replay) else 0.0
    primary_coverage = float(len(primary_m) / len(primary)) if len(primary) else 0.0
    replay_corr = safe_corr(replay_m["official_settlement_pnl"], replay_m["anchor_pnl"])
    replay_sign = sign_match(replay_m["official_settlement_pnl"], replay_m["anchor_pnl"])
    replay_diff = float(pd.to_numeric(replay_m["pnl_delta_vs_official"], errors="coerce").abs().mean()) if len(replay_m) else 999.0

    gate_actual = {
        "coverage_improvement": coverage - primary_coverage,
        "fallback_added_trades": int(len(fallback_m)),
        "fallback_net_pnl_usd": fallback_metrics["net_pnl_usd"],
        "coverage_rate": coverage,
        "pnl_corr_vs_official": replay_corr,
        "sign_match_vs_official": replay_sign,
        "mean_abs_pnl_diff_usd": replay_diff,
        "fee_2x_plus_3bps_per_side_net_pnl": float(stress_ref["net_pnl_usd"]),
        "remaining_unresolved": int(len(unresolved)),
    }
    promoted = (
        gate_actual["fallback_added_trades"] > 0
        and gate_actual["fallback_net_pnl_usd"] > 0
        and gate_actual["pnl_corr_vs_official"] >= 0.90
        and gate_actual["sign_match_vs_official"] >= 0.90
        and gate_actual["mean_abs_pnl_diff_usd"] <= 45.0
        and gate_actual["fee_2x_plus_3bps_per_side_net_pnl"] > 0
    )
    status = "gold_anchor_gap_repair_promoted" if promoted else "gold_anchor_gap_repair_not_promoted_keep_v131"
    return {
        "version": VERSION,
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "status": status,
        "source": {
            "primary_baseline": "V1.31 skip-uncovered execution paper baseline",
            "primary_anchor": PRIMARY_ANCHOR,
            "fallback_ladder": FALLBACK_LADDER,
            "q_or_trailing_tuning": "not_allowed_in_v1_32",
        },
        "primary_v131_reference": {
            "status": v131_summary.get("status"),
            "executed_trades": v131_summary.get("signal_counts", {}).get("executed_trades"),
            "skipped_uncovered": v131_summary.get("signal_counts", {}).get("skipped_uncovered"),
            "net_pnl_usd": v131_summary.get("execution_base", {}).get("net_pnl_usd"),
            "profit_factor": v131_summary.get("execution_base", {}).get("profit_factor"),
            "coverage_rate": v131_summary.get("signal_counts", {}).get("coverage_rate"),
        },
        "fallback_repair_result": {
            "total_signals": int(len(replay)),
            "executed_after_repair": int(len(replay_m)),
            "remaining_unresolved": int(len(unresolved)),
            "fallback_added_trades": int(len(fallback_m)),
            "fallback_net_pnl_usd": fallback_metrics["net_pnl_usd"],
            "fallback_profit_factor": fallback_metrics["profit_factor"],
            "fallback_official_pnl_usd": float(pd.to_numeric(fallback_m["official_settlement_pnl"], errors="coerce").fillna(0.0).sum()),
            "forfeited_official_pnl_remaining_usd": float(pd.to_numeric(unresolved["official_settlement_pnl"], errors="coerce").fillna(0.0).sum()),
        },
        "repaired_execution_metrics": metrics(pd.to_numeric(replay_m["anchor_pnl"], errors="coerce").fillna(0.0).tolist(), total_signals=len(replay)),
        "repaired_execution_2x_fee_metrics": metrics(pd.to_numeric(replay_m["anchor_pnl_2x_cost"], errors="coerce").fillna(0.0).tolist(), total_signals=len(replay)),
        "repaired_execution_stress_reference": {
            "scenario": stress_ref["scenario"],
            "net_pnl_usd": stress_ref["net_pnl_usd"],
            "profit_factor": stress_ref["profit_factor"],
            "max_drawdown_usd": stress_ref["max_drawdown_usd"],
        },
        "official_alignment": {
            "pnl_corr_vs_official": replay_corr,
            "sign_match_vs_official": replay_sign,
            "mean_abs_pnl_diff_usd": replay_diff,
        },
        "gate": {
            "requires_for_fallback_promotion": {
                "fallback_net_pnl": "> 0",
                "pnl_corr_vs_official": ">= 0.90",
                "sign_match_vs_official": ">= 0.90",
                "mean_abs_pnl_diff_usd": "<= 45",
                "fee_2x_plus_3bps_per_side_net_pnl": "> 0",
            },
            "actual": gate_actual,
            "passed": promoted,
        },
        "decision": "keep_v1_31_skip_uncovered_baseline" if not promoted else "use_v1_32_fallback_ladder",
        "next_step": "Fallback repair degraded the anchor if not promoted; move to real BBO/MBP cost data or repair missing feed at source before Q/trailing.",
    }


def write_report(summary: dict[str, Any], ladder: pd.DataFrame, unresolved: pd.DataFrame, stress: pd.DataFrame) -> None:
    lines = [
        f"# {VERSION}",
        "",
        "## 定位",
        "",
        "V1.32 只测试未覆盖锚点修复，不改变交易信号，不调 Q/trailing。",
        "",
        "## 结论",
        "",
        f"- 状态：`{summary['status']}`",
        f"- V1.31 执行：{summary['primary_v131_reference']['executed_trades']}，跳过：{summary['primary_v131_reference']['skipped_uncovered']}",
        f"- V1.32 fallback 补入：{summary['fallback_repair_result']['fallback_added_trades']}，仍未解决：{summary['fallback_repair_result']['remaining_unresolved']}",
        f"- fallback 子集净收益：${summary['fallback_repair_result']['fallback_net_pnl_usd']:.2f}",
        f"- fallback 子集对应官方 settlement PnL：${summary['fallback_repair_result']['fallback_official_pnl_usd']:.2f}",
        f"- 修复后总净收益：${summary['repaired_execution_metrics']['net_pnl_usd']:.2f}，PF {summary['repaired_execution_metrics']['profit_factor']:.3f}",
        f"- 修复后 PnL 相关：{summary['official_alignment']['pnl_corr_vs_official']:.3f}",
        f"- 修复后方向一致率：{summary['official_alignment']['sign_match_vs_official']:.2%}",
        f"- gate：`{summary['gate']['passed']}`",
        "",
        "## 判断",
        "",
    ]
    if summary["gate"]["passed"]:
        lines.append("fallback 阶梯通过，可以替代 V1.31 跳过规则。")
    else:
        lines.append("fallback 阶梯不晋级。它虽然提高覆盖率，但 fallback 子集净收益为负，且整体 PnL 相关降到推广线以下。生产 paper baseline 继续保留 V1.31 的跳过规则。")
    lines.extend(["", "## fallback 锚点审计", ""])
    if ladder.empty:
        lines.append("- 无可审计 fallback。")
    else:
        for _, row in ladder.iterrows():
            lines.append(
                f"- `{row['anchor']}`：补入 {int(row['previously_uncovered_matched'])} 笔，"
                f"补入净收益 ${row['previously_uncovered_net_pnl_usd']:.2f}，"
                f"全体相关 {row['all_pnl_corr_vs_official']:.3f}"
            )
    lines.extend(["", "## 仍未解决缺口", ""])
    if unresolved.empty:
        lines.append("- 无。")
    else:
        for _, row in unresolved.iterrows():
            lines.append(
                f"- `{row['entry_anchor_status']}` / `{row['exit_anchor_status']}` / `{row['split']}`："
                f"{int(row['count'])} 笔，官方机会成本 ${row['official_pnl_at_risk_usd']:.2f}，原因 `{row['remaining_reason']}`"
            )
    lines.extend(
        [
            "",
            "## 下一步",
            "",
            "由于 fallback 未通过，下一步应转向真实 BBO/MBP 成本表，或在数据源层修复缺失 feed。仍不建议调 Q/trailing。",
        ]
    )
    (OUT_DIR / "HFCD_Trading_V1_32_GoldAnchorGapRepair.md").write_text("\n".join(lines), encoding="utf-8")

    fig, axes = plt.subplots(2, 2, figsize=(12, 8))
    axes = axes.flatten()
    labels = ["V1.31 primary", "V1.32 fallback"]
    vals = [
        summary["primary_v131_reference"]["net_pnl_usd"] or 0,
        summary["repaired_execution_metrics"]["net_pnl_usd"],
    ]
    axes[0].bar(labels, vals, color=["#1f77b4", "#ff7f0e"])
    axes[0].set_title("Net PnL")
    axes[0].tick_params(axis="x", rotation=15)

    axes[1].bar(["primary coverage", "fallback coverage"], [summary["primary_v131_reference"]["coverage_rate"] or 0, summary["gate"]["actual"]["coverage_rate"]])
    axes[1].set_title("Coverage")

    if not ladder.empty:
        plot_ladder = ladder.copy()
        axes[2].barh(plot_ladder["anchor"], plot_ladder["previously_uncovered_net_pnl_usd"], color="#2ca02c")
        axes[2].set_title("Fallback subset PnL")
        axes[2].invert_yaxis()

    fee_2x = stress[stress["fee_mode"] == "fee_2x"].sort_values("extra_slippage_bps_per_side")
    axes[3].plot(fee_2x["extra_slippage_bps_per_side"], fee_2x["net_pnl_usd"], marker="o")
    axes[3].axhline(0, color="black", linewidth=1)
    axes[3].set_title("Repaired 2x fee stress")
    axes[3].set_xlabel("extra bps per side")

    fig.tight_layout()
    fig.savefig(OUT_DIR / "HFCD_Trading_V1_32_GoldAnchorGapRepair.png", dpi=180)
    plt.close(fig)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    v130 = import_v130()
    primary = load_primary_best()
    fallback_frames = load_anchor_frames(v130, FALLBACK_LADDER)
    replay = replay_with_fallback(primary, fallback_frames)
    ladder = fallback_ladder_audit(primary, fallback_frames)
    unresolved = build_unresolved_audit(replay)
    stress = cost_matrix(replay)
    summary = summarize(primary, replay, load_v131_summary())

    replay.to_csv(OUT_DIR / "hfcd_trading_v1_32_fallback_trade_replay.csv", index=False)
    ladder.to_csv(OUT_DIR / "hfcd_trading_v1_32_fallback_ladder_audit.csv", index=False)
    unresolved.to_csv(OUT_DIR / "hfcd_trading_v1_32_unresolved_trade_audit.csv", index=False)
    stress.to_csv(OUT_DIR / "hfcd_trading_v1_32_cost_stress_matrix.csv", index=False)
    with (OUT_DIR / "hfcd_trading_v1_32_summary.json").open("w", encoding="utf-8") as f:
        json.dump(clean_json(summary), f, ensure_ascii=False, indent=2)
    write_csv(OUT_DIR / "hfcd_trading_v1_32_summary.csv", [summary])
    write_report(summary, ladder, unresolved, stress)
    print(json.dumps(clean_json(summary), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
