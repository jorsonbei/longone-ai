#!/usr/bin/env python3
"""HFCD Commodity V5.17: exact lineage scheduler.

Local research only. No broker calls, no testnet calls, no online page changes.

V5.17 deliberately stops rewriting the strong energy routes.

It preserves:
- CL=F V5.4 3h route as the PnL/PF lineage.
- HO=F V5.9 2h route as the hit-rate lineage.

The 1m/5m layer is treated as an execution scheduler only. It can be used for
entry timing, add/reduce/reverse checks, and forward monitoring, but it is not
allowed to redefine the main long/short signal.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


ROOT = Path.cwd()
VERSION = "HFCD_Commodity_V5_17_ExactLineageScheduler"
OUT_DIR = ROOT / "outputs" / "hfcd_commodity_v5_17_exact_lineage_scheduler"

V54_DIR = ROOT / "outputs" / "hfcd_commodity_v5_4_real_exogenous_hit_rate_lift"
V59_DIR = ROOT / "outputs" / "hfcd_commodity_v5_9_energy_sample_density_lift"
V516_DIR = ROOT / "outputs" / "hfcd_commodity_v5_16_lineage_preserved_realtime_scanner"

LINEAGE_SPECS = [
    {
        "lineage_id": "CL_V5_4_3h",
        "source_version": "V5.4",
        "symbol": "CL=F",
        "cadence": "3h",
        "role": "pnl_pf_core",
        "selected_path": V54_DIR / "hfcd_commodity_v5_4_selected_routes.csv",
        "replay_path": V54_DIR / "hfcd_commodity_v5_4_bar_replay.csv",
        "min_test_hit": 0.60,
        "min_test_pf": 1.25,
        "min_test_pnl": 0.0,
        "min_actions_per_day": 1.0,
    },
    {
        "lineage_id": "HO_V5_9_2h",
        "source_version": "V5.9",
        "symbol": "HO=F",
        "cadence": "2h",
        "role": "hit_rate_core",
        "selected_path": V59_DIR / "hfcd_commodity_v5_9_selected_routes.csv",
        "replay_path": V59_DIR / "hfcd_commodity_v5_9_density_replay.csv",
        "min_test_hit": 0.68,
        "min_test_pf": 1.15,
        "min_test_pnl": 0.0,
        "min_actions_per_day": 1.0,
    },
]


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def safe_read_csv(path: Path) -> pd.DataFrame:
    if not path.exists() or path.stat().st_size <= 1:
        return pd.DataFrame()
    return pd.read_csv(path)


def profit_factor(pnls: pd.Series) -> float:
    vals = pd.to_numeric(pnls, errors="coerce").fillna(0.0)
    gross_profit = float(vals[vals > 0].sum())
    gross_loss = float(-vals[vals < 0].sum())
    if gross_loss <= 0:
        return float("inf") if gross_profit > 0 else 0.0
    return gross_profit / gross_loss


def max_drawdown_from_pnls(pnls: pd.Series) -> float:
    vals = pd.to_numeric(pnls, errors="coerce").fillna(0.0).to_numpy()
    if len(vals) == 0:
        return 0.0
    equity = np.cumsum(vals)
    peak = np.maximum.accumulate(equity)
    dd = equity - peak
    return float(dd.min())


def select_exact_lineage(spec: dict[str, Any]) -> tuple[dict[str, Any], pd.DataFrame]:
    selected = safe_read_csv(Path(spec["selected_path"]))
    if selected.empty:
        raise RuntimeError(f"missing selected route: {spec['selected_path']}")
    route = selected[
        (selected["symbol"].astype(str) == spec["symbol"])
        & (selected["cadence"].astype(str) == spec["cadence"])
    ].copy()
    if route.empty:
        raise RuntimeError(f"selected route not found for {spec['lineage_id']}")
    route_row = route.sort_values("selection_score", ascending=False).iloc[0].to_dict()

    replay = safe_read_csv(Path(spec["replay_path"]))
    if replay.empty:
        raise RuntimeError(f"missing replay: {spec['replay_path']}")
    exact = replay[
        (replay["policy"].astype(str) == str(route_row["policy"]))
        & (replay["symbol"].astype(str) == spec["symbol"])
        & (replay["cadence"].astype(str) == spec["cadence"])
    ].copy()
    if exact.empty:
        raise RuntimeError(f"exact replay not found for {spec['lineage_id']}")
    exact["lineage_id"] = spec["lineage_id"]
    exact["source_version"] = spec["source_version"]
    exact["lineage_role"] = spec["role"]
    return route_row, exact


def summarize_exact_replay(spec: dict[str, Any], route_row: dict[str, Any], exact: pd.DataFrame) -> dict[str, Any]:
    out: dict[str, Any] = {
        "version": VERSION,
        "lineage_id": spec["lineage_id"],
        "source_version": spec["source_version"],
        "symbol": spec["symbol"],
        "cadence": spec["cadence"],
        "lineage_role": spec["role"],
        "policy": route_row["policy"],
        "scheduler_role": "1m/5m_execution_check_only",
    }
    for key, value in route_row.items():
        if key not in out:
            out[key] = value

    test_hit = float(route_row.get("test_direction_hit_rate", 0.0))
    test_pf = float(route_row.get("test_profit_factor", 0.0))
    test_pnl = float(route_row.get("test_net_pnl_usd", 0.0))
    actions_per_day = float(route_row.get("test_actions_per_day", 0.0))
    passed = (
        test_hit >= float(spec["min_test_hit"])
        and test_pf >= float(spec["min_test_pf"])
        and test_pnl > float(spec["min_test_pnl"])
        and actions_per_day >= float(spec["min_actions_per_day"])
    )
    out["lineage_pass"] = bool(passed)
    out["lineage_gate"] = (
        f"hit>={spec['min_test_hit']:.2f},pf>={spec['min_test_pf']:.2f},pnl>{spec['min_test_pnl']:.2f},actions/day>={spec['min_actions_per_day']:.2f}"
    )

    for split in ["train", "validation", "test"]:
        sub = exact[exact["split"].astype(str) == split].copy()
        active = sub[pd.to_numeric(sub.get("direction_signal_active", 0), errors="coerce").fillna(0).astype(int) == 1]
        out[f"exact_{split}_bars"] = int(len(sub))
        out[f"exact_{split}_active_signal_bars"] = int(len(active))
        out[f"exact_{split}_direction_hit_rate"] = (
            float(pd.to_numeric(active.get("direction_hit", pd.Series(dtype=float)), errors="coerce").fillna(0).mean()) if len(active) else 0.0
        )
        out[f"exact_{split}_net_pnl_usd"] = float(pd.to_numeric(sub.get("pnl_usd", 0.0), errors="coerce").fillna(0.0).sum())
        out[f"exact_{split}_profit_factor"] = profit_factor(sub.get("pnl_usd", pd.Series(dtype=float)))
        out[f"exact_{split}_max_drawdown_usd"] = max_drawdown_from_pnls(sub.get("pnl_usd", pd.Series(dtype=float)))
    return out


def latest_scheduler_readiness(lineage_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    summary_path = V516_DIR / "hfcd_commodity_v5_16_summary.json"
    if not summary_path.exists():
        return []
    data = json.loads(summary_path.read_text(encoding="utf-8"))
    latest = data.get("latest_signal_readiness", [])
    wanted = {(r["symbol"], r["cadence"]) for r in lineage_rows}
    rows: list[dict[str, Any]] = []
    for item in latest:
        symbol = item.get("symbol")
        if symbol not in {x[0] for x in wanted}:
            continue
        rows.append(
            {
                "version": VERSION,
                "symbol": symbol,
                "mode": item.get("mode"),
                "timestamp": item.get("timestamp"),
                "close": item.get("close"),
                "scheduler_layer": "readiness_only",
                "main_signal_source": "exact_lineage_route",
                "realtime_execution_permission": "allowed_only_if_exact_lineage_has_active_position_or_new_signal",
                "v513_data_quality_score": item.get("v513_data_quality_score", 0.0),
                "v516_lineage_trade_score": item.get("v516_lineage_trade_score", 0.0),
                "v516_lineage_quality_score": item.get("v516_lineage_quality_score", 0.0),
                "note": "1m/5m scanner is not a signal source in V5.17.",
            }
        )
    return rows


def make_report(run_summary: dict[str, Any], lineage_rows: list[dict[str, Any]], scheduler_rows: list[dict[str, Any]]) -> str:
    lines = [
        f"# {VERSION}",
        "",
        "## 结论",
        "",
        f"- 状态：`{run_summary['status']}`",
        "- V5.17 不训练新模型，不重写主信号；它只固化原始强血统。",
        "- CL=F 使用 V5.4 原始 3h 路线作为收益/PF 主线。",
        "- HO=F 使用 V5.9 原始 2h 路线作为命中率主线。",
        "- 1m/5m 只作为执行调度层：检查可执行窗口、加仓、减仓、反手、数据健康，不允许替代主信号。",
        "",
        "## 血统路线",
        "",
        "| 路线 | 来源 | 标的 | 主周期 | 验证命中/PF | 盲测命中/PF | 盲测收益 | 动作/天 | 通过 |",
        "|---|---|---|---:|---:|---:|---:|---:|---|",
    ]
    for r in lineage_rows:
        lines.append(
            f"| {r['lineage_id']} | {r['source_version']} | {r['symbol']} | {r['cadence']} | "
            f"{float(r.get('validation_direction_hit_rate', 0.0)):.2%}/{float(r.get('validation_profit_factor', 0.0)):.2f} | "
            f"{float(r.get('test_direction_hit_rate', 0.0)):.2%}/{float(r.get('test_profit_factor', 0.0)):.2f} | "
            f"{float(r.get('test_net_pnl_usd', 0.0)):.2f} | {float(r.get('test_actions_per_day', 0.0)):.2f} | "
            f"{'yes' if r.get('lineage_pass') else 'no'} |"
        )
    lines += [
        "",
        "## 1m/5m 调度层",
        "",
    ]
    if scheduler_rows:
        lines.append("| 标的 | 模式 | 最新时间 | 价格 | 数据质量 | 说明 |")
        lines.append("|---|---|---|---:|---:|---|")
        for r in scheduler_rows:
            lines.append(
                f"| {r['symbol']} | {r['mode']} | {r['timestamp']} | {float(r.get('close', 0.0)):.4f} | "
                f"{float(r.get('v513_data_quality_score', 0.0)):.2f} | {r['note']} |"
            )
    else:
        lines.append("未找到 V5.16 的 1m/5m readiness 输出；不影响主血统评估。")
    lines += [
        "",
        "## 判断",
        "",
        "- 这一步恢复了之前强数据的统计含义：CL/HO 主线仍是原始 3h/2h 血统，而不是 5m 噪声重算。",
        "- 如果后续要实时运行，应按 V5.17 的方式：主信号由 exact lineage 产生；1m/5m 只负责执行窗口和仓位调整。",
        "- 不应把 V5.16 的高频重算结果接前向账本。",
        "",
        "## 下一步行动计划",
        "",
        "做 V5.18 ExactLineageForwardShadow：只接 V5.17 两条通过血统到前向影子账本。每 1m/5m 刷新一次执行调度，但只有当 CL 3h 或 HO 2h exact lineage 产生信号时才允许开仓、加仓、减仓或反手。",
    ]
    return "\n".join(lines) + "\n"


def make_figure(lineage_rows: list[dict[str, Any]], path: Path) -> None:
    if not lineage_rows:
        return
    labels = [f"{r['symbol']}\n{r['cadence']}" for r in lineage_rows]
    hit = [float(r.get("test_direction_hit_rate", 0.0)) for r in lineage_rows]
    pf = [min(float(r.get("test_profit_factor", 0.0)), 5.0) / 5.0 for r in lineage_rows]
    pnl = [max(0.0, min(float(r.get("test_net_pnl_usd", 0.0)), 150.0)) / 150.0 for r in lineage_rows]
    x = np.arange(len(labels))
    width = 0.25
    fig, ax = plt.subplots(figsize=(10, 5))
    ax.bar(x - width, hit, width, label="blind hit rate")
    ax.bar(x, pf, width, label="PF/5 cap")
    ax.bar(x + width, pnl, width, label="PnL/150 cap")
    ax.axhline(0.65, color="tab:green", linestyle="--", linewidth=1, label="65% hit reference")
    ax.set_ylim(0, 1)
    ax.set_xticks(x)
    ax.set_xticklabels(labels)
    ax.set_title("V5.17 exact lineage scheduler")
    ax.grid(axis="y", alpha=0.25)
    ax.legend()
    fig.tight_layout()
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=160)
    plt.close(fig)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    started = datetime.now(timezone.utc)

    lineage_rows: list[dict[str, Any]] = []
    replay_parts: list[pd.DataFrame] = []
    for spec in LINEAGE_SPECS:
        route_row, exact = select_exact_lineage(spec)
        lineage_rows.append(summarize_exact_replay(spec, route_row, exact))
        replay_parts.append(exact)

    scheduler_rows = latest_scheduler_readiness(lineage_rows)
    pass_count = sum(1 for r in lineage_rows if bool(r.get("lineage_pass")))
    status = "exact_lineage_scheduler_candidates" if pass_count == len(lineage_rows) else "exact_lineage_scheduler_partial"
    run_summary = {
        "version": VERSION,
        "generated_at": now_iso(),
        "status": status,
        "lineage_count": len(lineage_rows),
        "lineage_pass_count": pass_count,
        "scheduler_role": "1m/5m execution scheduler only, not signal source",
        "runtime_sec": round((datetime.now(timezone.utc) - started).total_seconds(), 3),
        "outputs": {
            "summary_json": str(OUT_DIR / "hfcd_commodity_v5_17_summary.json"),
            "lineage_routes_csv": str(OUT_DIR / "hfcd_commodity_v5_17_lineage_routes.csv"),
            "exact_replay_csv": str(OUT_DIR / "hfcd_commodity_v5_17_exact_replay.csv"),
            "scheduler_readiness_csv": str(OUT_DIR / "hfcd_commodity_v5_17_scheduler_readiness.csv"),
            "report_md": str(OUT_DIR / "HFCD_Commodity_V5_17_ExactLineageScheduler.md"),
            "figure_png": str(OUT_DIR / "HFCD_Commodity_V5_17_ExactLineageScheduler.png"),
        },
    }

    (OUT_DIR / "hfcd_commodity_v5_17_summary.json").write_text(json.dumps(run_summary, ensure_ascii=False, indent=2), encoding="utf-8")
    pd.DataFrame(lineage_rows).to_csv(OUT_DIR / "hfcd_commodity_v5_17_lineage_routes.csv", index=False)
    pd.concat(replay_parts, ignore_index=True).to_csv(OUT_DIR / "hfcd_commodity_v5_17_exact_replay.csv", index=False)
    pd.DataFrame(scheduler_rows).to_csv(OUT_DIR / "hfcd_commodity_v5_17_scheduler_readiness.csv", index=False)
    (OUT_DIR / "HFCD_Commodity_V5_17_ExactLineageScheduler.md").write_text(
        make_report(run_summary, lineage_rows, scheduler_rows), encoding="utf-8"
    )
    make_figure(lineage_rows, OUT_DIR / "HFCD_Commodity_V5_17_ExactLineageScheduler.png")
    print(json.dumps(run_summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
