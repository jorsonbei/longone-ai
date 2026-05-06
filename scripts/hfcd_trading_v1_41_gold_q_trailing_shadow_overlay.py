#!/usr/bin/env python3
"""HFCD Trading V1.41 - Gold Q/Trailing shadow overlay.

This is intentionally a sidecar replay:
- V1.38 remains the execution baseline.
- V1.40 continues collecting forward ledger data.
- Q-drift and trailing exits are evaluated only where existing minute replay
  evidence can be matched to V1.38 trades.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v1_41_gold_q_trailing_shadow_overlay"

V38_DIR = ROOT / "outputs" / "hfcd_trading_v1_38_gold_roll_aware_paper_baseline"
V23_DIR = ROOT / "outputs" / "hfcd_trading_v1_23_gold_minute_q_dynamic_exit"
V24_DIR = ROOT / "outputs" / "hfcd_trading_v1_24_gold_real_minute_qfeed_profit_exit"

V38_LEDGER = V38_DIR / "hfcd_trading_v1_38_trade_ledger.csv"
V23_REPLAY = V23_DIR / "hfcd_trading_v1_23_trade_replay.csv"
V24_REPLAY = V24_DIR / "hfcd_trading_v1_24_trade_replay.csv"


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        if isinstance(value, float) and math.isnan(value):
            return default
        return float(value)
    except Exception:
        return default


def _profit_factor(pnls: pd.Series) -> float:
    gross_profit = float(pnls[pnls > 0].sum())
    gross_loss = abs(float(pnls[pnls < 0].sum()))
    if gross_loss == 0:
        return float("inf") if gross_profit > 0 else 0.0
    return gross_profit / gross_loss


def _max_drawdown(pnls: pd.Series) -> float:
    if pnls.empty:
        return 0.0
    equity = pnls.cumsum()
    running_peak = equity.cummax()
    drawdown = equity - running_peak
    return float(drawdown.min())


def _fmt_usd(value: float) -> str:
    return f"${value:,.2f}"


def _read_required_csv(path: Path) -> pd.DataFrame:
    if not path.exists():
        raise FileNotFoundError(f"missing required input: {path}")
    return pd.read_csv(path)


def _prepare_v38() -> pd.DataFrame:
    df = _read_required_csv(V38_LEDGER).copy()
    required = {"trade_id_v130", "split", "date", "score", "bbo_bidask_pnl_usd"}
    missing = sorted(required - set(df.columns))
    if missing:
        raise ValueError(f"V1.38 ledger missing columns: {missing}")

    df["date_key"] = pd.to_datetime(df["date"]).dt.date.astype(str)
    df["score_key"] = pd.to_numeric(df["score"], errors="coerce").round(6)
    df["split_key"] = df["split"].astype(str)
    df["baseline_v38_pnl_usd"] = pd.to_numeric(df["bbo_bidask_pnl_usd"], errors="coerce").fillna(0.0)
    return df.sort_values(["date_key", "trade_id_v130"]).reset_index(drop=True)


def _prepare_v24() -> pd.DataFrame:
    if not V24_REPLAY.exists():
        return pd.DataFrame()
    df = pd.read_csv(V24_REPLAY).copy()
    required = {"source_split", "signal_date", "score", "v1_24_real_minute_pnl_usd"}
    missing = sorted(required - set(df.columns))
    if missing:
        raise ValueError(f"V1.24 replay missing columns: {missing}")

    df["date_key"] = pd.to_datetime(df["signal_date"]).dt.date.astype(str)
    df["score_key"] = pd.to_numeric(df["score"], errors="coerce").round(6)
    df["split_key"] = df["source_split"].astype(str)
    df = df.drop_duplicates(["date_key", "score_key", "split_key"], keep="first")
    keep = [
        "date_key",
        "score_key",
        "split_key",
        "trade_id",
        "symbol",
        "entry_fill",
        "exit_fill",
        "exit_minute",
        "exit_state",
        "exit_reason",
        "q_hard_confirmed",
        "q_final",
        "q_min",
        "q_recovery",
        "time_under_q_warning",
        "time_under_q_soft",
        "time_under_q_hard",
        "soft_reduce_count",
        "minute_rows",
        "v1_24_real_minute_pnl_usd",
        "pnl_delta_vs_v22_usd",
    ]
    existing = [c for c in keep if c in df.columns]
    return df[existing].rename(columns={c: f"v24_{c}" for c in existing if c not in {"date_key", "score_key", "split_key"}})


def _prepare_v23() -> pd.DataFrame:
    if not V23_REPLAY.exists():
        return pd.DataFrame()
    df = pd.read_csv(V23_REPLAY).copy()
    required = {"source_split", "date", "score", "v1_23_proxy_pnl_usd"}
    missing = sorted(required - set(df.columns))
    if missing:
        raise ValueError(f"V1.23 replay missing columns: {missing}")

    df["date_key"] = pd.to_datetime(df["date"]).dt.date.astype(str)
    df["score_key"] = pd.to_numeric(df["score"], errors="coerce").round(6)
    df["split_key"] = df["source_split"].astype(str)
    df = df.drop_duplicates(["date_key", "score_key", "split_key"], keep="first")
    keep = [
        "date_key",
        "score_key",
        "split_key",
        "trade_id",
        "symbol",
        "exit_minute",
        "exit_reason",
        "hard_exit",
        "soft_reduce_count",
        "warning_count",
        "q_final",
        "q_reduced_at_entry",
        "entry_position_multiplier",
        "v1_23_proxy_pnl_usd",
        "pnl_delta_vs_v22_usd",
    ]
    existing = [c for c in keep if c in df.columns]
    return df[existing].rename(columns={c: f"v23_{c}" for c in existing if c not in {"date_key", "score_key", "split_key"}})


def _contains(row: pd.Series, columns: list[str], needle: str) -> bool:
    needle = needle.lower()
    for column in columns:
        value = str(row.get(column, "")).lower()
        if needle in value:
            return True
    return False


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    if isinstance(value, float) and math.isnan(value):
        return False
    return str(value).strip().lower() in {"1", "true", "yes", "y"}


def _build_overlay() -> pd.DataFrame:
    base = _prepare_v38()
    v24 = _prepare_v24()
    v23 = _prepare_v23()

    merged = base.copy()
    if not v24.empty:
        merged = merged.merge(v24, on=["date_key", "score_key", "split_key"], how="left")
    if not v23.empty:
        merged = merged.merge(v23, on=["date_key", "score_key", "split_key"], how="left")

    overlay_rows: list[dict[str, Any]] = []
    for _, row in merged.iterrows():
        has_v24 = not pd.isna(row.get("v24_v1_24_real_minute_pnl_usd"))
        has_v23 = not pd.isna(row.get("v23_v1_23_proxy_pnl_usd"))

        if has_v24:
            overlay_source = "v1_24_real_minute"
            overlay_pnl = _safe_float(row.get("v24_v1_24_real_minute_pnl_usd"))
            overlay_exit_reason = str(row.get("v24_exit_reason", ""))
            overlay_exit_state = str(row.get("v24_exit_state", ""))
            overlay_exit_minute = row.get("v24_exit_minute")
            q_triggered = _truthy(row.get("v24_q_hard_confirmed")) or _contains(
                row, ["v24_exit_reason", "v24_exit_state"], "q"
            ) or _contains(row, ["v24_exit_reason", "v24_exit_state"], "Q")
            trailing_triggered = _contains(row, ["v24_exit_reason", "v24_exit_state"], "trailing")
            q_final = row.get("v24_q_final")
            q_min = row.get("v24_q_min")
            minute_rows = row.get("v24_minute_rows")
        elif has_v23:
            overlay_source = "v1_23_proxy_minute"
            overlay_pnl = _safe_float(row.get("v23_v1_23_proxy_pnl_usd"))
            overlay_exit_reason = str(row.get("v23_exit_reason", ""))
            overlay_exit_state = "proxy_exit"
            overlay_exit_minute = row.get("v23_exit_minute")
            q_triggered = _truthy(row.get("v23_hard_exit")) or _contains(row, ["v23_exit_reason"], "q") or _contains(
                row, ["v23_exit_reason"], "Q"
            )
            trailing_triggered = _contains(row, ["v23_exit_reason"], "trailing")
            q_final = row.get("v23_q_final")
            q_min = None
            minute_rows = None
        else:
            overlay_source = "baseline_only_no_minute_overlay"
            overlay_pnl = _safe_float(row.get("baseline_v38_pnl_usd"))
            overlay_exit_reason = "no_matched_minute_replay"
            overlay_exit_state = "baseline_carried"
            overlay_exit_minute = None
            q_triggered = False
            trailing_triggered = False
            q_final = None
            q_min = None
            minute_rows = None

        baseline_pnl = _safe_float(row.get("baseline_v38_pnl_usd"))
        delta = overlay_pnl - baseline_pnl
        if overlay_source == "baseline_only_no_minute_overlay":
            verdict = "no_overlay_data"
        elif delta > 1e-9:
            verdict = "overlay_better"
        elif delta < -1e-9:
            verdict = "overlay_worse"
        else:
            verdict = "overlay_equal"

        overlay_rows.append(
            {
                "trade_id_v130": row.get("trade_id_v130"),
                "fold": row.get("fold"),
                "split": row.get("split"),
                "date": row.get("date"),
                "exit_date": row.get("exit_date"),
                "entry_selected_symbol": row.get("entry_selected_symbol"),
                "exit_selected_symbol": row.get("exit_selected_symbol"),
                "entry_route": row.get("entry_route"),
                "exit_route": row.get("exit_route"),
                "score": row.get("score"),
                "baseline_v38_pnl_usd": baseline_pnl,
                "overlay_source": overlay_source,
                "overlay_exit_state": overlay_exit_state,
                "overlay_exit_reason": overlay_exit_reason,
                "overlay_exit_minute": overlay_exit_minute,
                "overlay_pnl_usd": overlay_pnl,
                "overlay_delta_vs_v38_usd": delta,
                "overlay_verdict": verdict,
                "q_triggered": bool(q_triggered),
                "trailing_triggered": bool(trailing_triggered),
                "q_final": q_final,
                "q_min": q_min,
                "minute_rows": minute_rows,
                "bbo_mbp_matched": row.get("bbo_mbp_matched"),
                "entry_bbo_status": row.get("entry_bbo_status"),
                "exit_bbo_status": row.get("exit_bbo_status"),
            }
        )

    return pd.DataFrame(overlay_rows)


def _summarize(df: pd.DataFrame) -> dict[str, Any]:
    covered = df[df["overlay_source"] != "baseline_only_no_minute_overlay"].copy()
    q_rows = covered[covered["q_triggered"]].copy()
    trailing_rows = covered[covered["trailing_triggered"]].copy()

    baseline_pnl = df["baseline_v38_pnl_usd"]
    overlay_pnl = df["overlay_pnl_usd"]
    covered_base = covered["baseline_v38_pnl_usd"] if not covered.empty else pd.Series(dtype=float)
    covered_overlay = covered["overlay_pnl_usd"] if not covered.empty else pd.Series(dtype=float)

    coverage_rate = len(covered) / len(df) if len(df) else 0.0
    covered_delta = float(covered["overlay_delta_vs_v38_usd"].sum()) if len(covered) else 0.0
    q_delta = float(q_rows["overlay_delta_vs_v38_usd"].sum()) if len(q_rows) else 0.0
    trailing_delta = float(trailing_rows["overlay_delta_vs_v38_usd"].sum()) if len(trailing_rows) else 0.0

    # This is a shadow-only gate: promotion requires high direct coverage and
    # non-degrading covered overlay evidence. Otherwise V1.38 remains primary.
    promotable = coverage_rate >= 0.80 and covered_delta >= 0 and len(covered) >= 30
    status = "shadow_overlay_watchlist" if promotable else "shadow_overlay_do_not_promote"
    decision = "keep_v38_primary_collect_forward_ledger"
    if promotable:
        decision = "eligible_for_v142_parameterized_shadow_not_live"

    return {
        "version": "V1.41",
        "name": "GoldQTrailingShadowOverlay",
        "status": status,
        "decision": decision,
        "input_baseline": str(V38_LEDGER),
        "input_real_minute_overlay": str(V24_REPLAY) if V24_REPLAY.exists() else None,
        "input_proxy_minute_overlay": str(V23_REPLAY) if V23_REPLAY.exists() else None,
        "v40_untouched": True,
        "trades": int(len(df)),
        "baseline_net_pnl_usd": float(baseline_pnl.sum()),
        "baseline_profit_factor": _profit_factor(baseline_pnl),
        "baseline_max_drawdown_usd": _max_drawdown(baseline_pnl),
        "full_shadow_net_pnl_usd": float(overlay_pnl.sum()),
        "full_shadow_profit_factor": _profit_factor(overlay_pnl),
        "full_shadow_max_drawdown_usd": _max_drawdown(overlay_pnl),
        "direct_overlay_coverage_count": int(len(covered)),
        "direct_overlay_coverage_rate": float(coverage_rate),
        "covered_baseline_net_pnl_usd": float(covered_base.sum()) if len(covered) else 0.0,
        "covered_overlay_net_pnl_usd": float(covered_overlay.sum()) if len(covered) else 0.0,
        "covered_overlay_delta_vs_v38_usd": covered_delta,
        "covered_baseline_profit_factor": _profit_factor(covered_base) if len(covered) else 0.0,
        "covered_overlay_profit_factor": _profit_factor(covered_overlay) if len(covered) else 0.0,
        "q_triggered_count": int(len(q_rows)),
        "q_triggered_delta_vs_v38_usd": q_delta,
        "q_triggered_overlay_net_pnl_usd": float(q_rows["overlay_pnl_usd"].sum()) if len(q_rows) else 0.0,
        "q_triggered_baseline_net_pnl_usd": float(q_rows["baseline_v38_pnl_usd"].sum()) if len(q_rows) else 0.0,
        "trailing_triggered_count": int(len(trailing_rows)),
        "trailing_triggered_delta_vs_v38_usd": trailing_delta,
        "trailing_overlay_net_pnl_usd": float(trailing_rows["overlay_pnl_usd"].sum()) if len(trailing_rows) else 0.0,
        "trailing_baseline_net_pnl_usd": float(trailing_rows["baseline_v38_pnl_usd"].sum()) if len(trailing_rows) else 0.0,
        "overlay_source_counts": df["overlay_source"].value_counts().to_dict(),
        "overlay_verdict_counts": df["overlay_verdict"].value_counts().to_dict(),
        "method_warning": (
            "V1.41 is a shadow overlay. V1.24/V1.23 minute replays are matched to V1.38 "
            "by split/date/rounded score; unmatched trades carry the V1.38 baseline. "
            "This must not replace V1.38 or V1.40 forward audit."
        ),
    }


def _exit_reason_summary(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return pd.DataFrame()
    group_cols = ["overlay_source", "overlay_exit_reason"]
    summary = (
        df.groupby(group_cols)
        .agg(
            trades=("trade_id_v130", "count"),
            baseline_pnl_usd=("baseline_v38_pnl_usd", "sum"),
            overlay_pnl_usd=("overlay_pnl_usd", "sum"),
            overlay_delta_vs_v38_usd=("overlay_delta_vs_v38_usd", "sum"),
            q_triggered=("q_triggered", "sum"),
            trailing_triggered=("trailing_triggered", "sum"),
        )
        .reset_index()
        .sort_values(["overlay_source", "overlay_delta_vs_v38_usd"], ascending=[True, False])
    )
    return summary


def _write_report(summary: dict[str, Any], exit_summary: pd.DataFrame) -> None:
    md = OUT_DIR / "HFCD_Trading_V1_41_GoldQTrailingShadowOverlay.md"
    lines = [
        "# HFCD Trading V1.41 Gold Q/Trailing Shadow Overlay",
        "",
        "## 定位",
        "",
        "V1.41 是 V1.38 的独立旁路副本测试，不影响 V1.40 forward ledger audit，也不替代 V1.38 生产候选基线。",
        "",
        "本轮只回答：已有真实分钟/代理分钟证据下，Q 熔断和 trailing 对 V1.38 收益是增益还是拖累。",
        "",
        "## 核心结果",
        "",
        f"- 状态：`{summary['status']}`",
        f"- 决策：`{summary['decision']}`",
        f"- V1.38 基线净收益：{_fmt_usd(summary['baseline_net_pnl_usd'])}",
        f"- V1.41 full-shadow 净收益：{_fmt_usd(summary['full_shadow_net_pnl_usd'])}",
        f"- 直接分钟覆盖：{summary['direct_overlay_coverage_count']} / {summary['trades']} ({summary['direct_overlay_coverage_rate']:.1%})",
        f"- 覆盖子集增量：{_fmt_usd(summary['covered_overlay_delta_vs_v38_usd'])}",
        f"- Q 触发次数：{summary['q_triggered_count']}，Q 触发增量：{_fmt_usd(summary['q_triggered_delta_vs_v38_usd'])}",
        f"- Trailing 触发次数：{summary['trailing_triggered_count']}，Trailing 触发增量：{_fmt_usd(summary['trailing_triggered_delta_vs_v38_usd'])}",
        "",
        "## 解释",
        "",
        "如果覆盖不足或覆盖子集增量为负，本轮只能说明该 Q/trailing 版本不能晋级，不能说明 Q/trailing 思路永久无效。",
        "原因是 V1.41 没有重新下载更长分钟路径，也没有调参数；它只是把已有 V1.23/V1.24 证据挂到 V1.38 副本上做审计。",
        "",
        "## 退出原因汇总",
        "",
    ]
    if exit_summary.empty:
        lines.append("无退出原因数据。")
    else:
        display_cols = [
            "overlay_source",
            "overlay_exit_reason",
            "trades",
            "baseline_pnl_usd",
            "overlay_pnl_usd",
            "overlay_delta_vs_v38_usd",
            "q_triggered",
            "trailing_triggered",
        ]
        table = exit_summary[display_cols].copy()
        for col in ["baseline_pnl_usd", "overlay_pnl_usd", "overlay_delta_vs_v38_usd"]:
            table[col] = table[col].map(lambda x: f"{_safe_float(x):.2f}")
        lines.append("| " + " | ".join(display_cols) + " |")
        lines.append("| " + " | ".join(["---"] * len(display_cols)) + " |")
        for _, row in table.iterrows():
            lines.append("| " + " | ".join(str(row[col]) for col in display_cols) + " |")
    lines += [
        "",
        "## 下一步",
        "",
        "V1.40 继续自动积累前向 quote / roll route / paper PnL。V1.41 不接入定时任务。",
        "只有当前向账本和分钟覆盖都足够时，才进入 V1.42 参数化 shadow；仍不直接上线 Q/trailing。",
        "",
    ]
    md.write_text("\n".join(lines), encoding="utf-8")


def _write_plot(df: pd.DataFrame, summary: dict[str, Any]) -> None:
    png = OUT_DIR / "HFCD_Trading_V1_41_GoldQTrailingShadowOverlay.png"
    fig, axes = plt.subplots(2, 2, figsize=(13, 8))
    fig.suptitle("HFCD Trading V1.41 Gold Q/Trailing Shadow Overlay", fontsize=14, fontweight="bold")

    axes[0, 0].plot(df["baseline_v38_pnl_usd"].cumsum().values, label="V1.38 baseline", linewidth=2)
    axes[0, 0].plot(df["overlay_pnl_usd"].cumsum().values, label="V1.41 shadow", linewidth=2)
    axes[0, 0].set_title("Cumulative PnL")
    axes[0, 0].legend()
    axes[0, 0].grid(alpha=0.25)

    source_counts = df["overlay_source"].value_counts()
    axes[0, 1].bar(source_counts.index.astype(str), source_counts.values)
    axes[0, 1].set_title("Overlay source coverage")
    axes[0, 1].tick_params(axis="x", rotation=25)
    axes[0, 1].grid(axis="y", alpha=0.25)

    trigger_labels = ["Q trigger", "Trailing trigger"]
    trigger_values = [summary["q_triggered_delta_vs_v38_usd"], summary["trailing_triggered_delta_vs_v38_usd"]]
    axes[1, 0].bar(trigger_labels, trigger_values, color=["#b85656", "#4f8fcf"])
    axes[1, 0].axhline(0, color="black", linewidth=0.8)
    axes[1, 0].set_title("Trigger delta vs V1.38")
    axes[1, 0].grid(axis="y", alpha=0.25)

    covered = df[df["overlay_source"] != "baseline_only_no_minute_overlay"]
    if not covered.empty:
        axes[1, 1].scatter(covered["baseline_v38_pnl_usd"], covered["overlay_pnl_usd"], alpha=0.75)
        lim = max(abs(covered["baseline_v38_pnl_usd"]).max(), abs(covered["overlay_pnl_usd"]).max()) * 1.1
        axes[1, 1].plot([-lim, lim], [-lim, lim], linestyle="--", color="gray")
        axes[1, 1].set_xlim(-lim, lim)
        axes[1, 1].set_ylim(-lim, lim)
    axes[1, 1].set_title("Covered trades: overlay vs baseline")
    axes[1, 1].set_xlabel("V1.38 baseline PnL")
    axes[1, 1].set_ylabel("Overlay PnL")
    axes[1, 1].grid(alpha=0.25)

    plt.tight_layout()
    fig.savefig(png, dpi=180)
    plt.close(fig)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    overlay = _build_overlay()
    summary = _summarize(overlay)
    exit_summary = _exit_reason_summary(overlay)

    overlay.to_csv(OUT_DIR / "hfcd_trading_v1_41_overlay_trade_replay.csv", index=False)
    exit_summary.to_csv(OUT_DIR / "hfcd_trading_v1_41_exit_reason_summary.csv", index=False)
    pd.DataFrame([summary]).to_csv(OUT_DIR / "hfcd_trading_v1_41_summary.csv", index=False)
    (OUT_DIR / "hfcd_trading_v1_41_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    _write_report(summary, exit_summary)
    _write_plot(overlay, summary)

    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
