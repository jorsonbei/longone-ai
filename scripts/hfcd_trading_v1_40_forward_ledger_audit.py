#!/usr/bin/env python3
"""
HFCD Trading V1.40 Gold Forward Ledger Audit.

V1.39 runs a scheduled forward paper shadow ledger. V1.40 reads that ledger and
audits forward execution health before any Q-Drift or Trailing overlay is
allowed to influence the frozen V1.38 baseline.

This script does not change strategy parameters. It only summarizes:
1. quote availability and clean/executable quote coverage,
2. roll route usage,
3. forward paper order/PnL accumulation,
4. readiness for a future V1.41 Q-Drift/Trailing shadow overlay.
"""

from __future__ import annotations

import csv
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


VERSION = "HFCD_Trading_V1_40_GoldForwardLedgerAudit"
ROOT = Path.cwd()
V38_DIR = ROOT / "outputs" / "hfcd_trading_v1_38_gold_roll_aware_paper_baseline"
V39_DIR = ROOT / "outputs" / "hfcd_trading_v1_39_gold_forward_paper_shadow"
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v1_40_forward_ledger_audit"

V38_SUMMARY = V38_DIR / "hfcd_trading_v1_38_summary.json"
V39_SUMMARY = V39_DIR / "hfcd_trading_v1_39_summary.json"
V39_CYCLES = V39_DIR / "hfcd_trading_v1_39_shadow_cycles.csv"
V39_QUOTES = V39_DIR / "hfcd_trading_v1_39_quote_availability.csv"
V39_ORDERS = V39_DIR / "hfcd_trading_v1_39_shadow_orders.csv"
V39_ROUTES = V39_DIR / "hfcd_trading_v1_39_roll_route_usage.csv"

SUMMARY_JSON = OUT_DIR / "hfcd_trading_v1_40_summary.json"
SUMMARY_CSV = OUT_DIR / "hfcd_trading_v1_40_summary.csv"
CYCLE_AUDIT_CSV = OUT_DIR / "hfcd_trading_v1_40_cycle_audit.csv"
QUOTE_AUDIT_CSV = OUT_DIR / "hfcd_trading_v1_40_quote_status_audit.csv"
DAY_AUDIT_CSV = OUT_DIR / "hfcd_trading_v1_40_daily_health.csv"
READINESS_CSV = OUT_DIR / "hfcd_trading_v1_40_v141_readiness.csv"
REPORT_MD = OUT_DIR / "HFCD_Trading_V1_40_ForwardLedgerAudit.md"
REPORT_PNG = OUT_DIR / "HFCD_Trading_V1_40_ForwardLedgerAudit.png"

MIN_CYCLES_FOR_LEDGER_HEALTH = 24
MIN_DAYS_FOR_LEDGER_HEALTH = 7
MIN_FORWARD_TRADES_FOR_OVERLAY = 5
MIN_FORWARD_TRADES_FOR_PROMOTION = 20
MIN_CLEAN_QUOTE_RATE = 0.60


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


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
    try:
        if pd.isna(value) and not isinstance(value, (str, bytes, bool, type(None))):
            return None
    except TypeError:
        pass
    return value


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.write_text(json.dumps(clean_json(data), ensure_ascii=False, indent=2), encoding="utf-8")


def read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def read_csv(path: Path) -> pd.DataFrame:
    if not path.exists() or path.stat().st_size == 0:
        return pd.DataFrame()
    return pd.read_csv(path)


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fields: list[str] = []
    for row in rows:
        for key in row.keys():
            if key not in fields:
                fields.append(key)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({field: clean_json(row.get(field, "")) for field in fields})


def profit_factor(values: list[float]) -> float:
    wins = sum(v for v in values if v > 0)
    losses = abs(sum(v for v in values if v < 0))
    if losses == 0:
        return 999.0 if wins > 0 else 0.0
    return float(wins / losses)


def max_drawdown(values: list[float]) -> float:
    if not values:
        return 0.0
    equity = np.cumsum(values)
    peak = np.maximum.accumulate(equity)
    return float((equity - peak).min())


def as_float_series(df: pd.DataFrame, col: str) -> pd.Series:
    if col not in df.columns:
        return pd.Series(dtype=float)
    return pd.to_numeric(df[col], errors="coerce")


def normalize_cycles(cycles: pd.DataFrame) -> pd.DataFrame:
    if cycles.empty:
        return cycles
    out = cycles.copy()
    out["timestamp_utc"] = pd.to_datetime(out.get("timestamp_utc"), errors="coerce", utc=True)
    out["shadow_date"] = pd.to_datetime(out.get("shadow_date"), errors="coerce").dt.date.astype(str)
    for col in ["signals_today", "open_position_count", "cycle_realized_pnl_usd", "cumulative_realized_pnl_usd"]:
        if col in out.columns:
            out[col] = pd.to_numeric(out[col], errors="coerce").fillna(0)
    return out


def normalize_quotes(quotes: pd.DataFrame) -> pd.DataFrame:
    if quotes.empty:
        return quotes
    out = quotes.copy()
    out["recorded_at_utc"] = pd.to_datetime(out.get("recorded_at_utc"), errors="coerce", utc=True)
    out["shadow_date"] = pd.to_datetime(out.get("shadow_date"), errors="coerce").dt.date.astype(str)
    for col in ["spread", "top_book_size", "rows"]:
        if col in out.columns:
            out[col] = pd.to_numeric(out[col], errors="coerce")
    out["is_clean_executable"] = out.get("quote_status", "").astype(str).eq("executable_clean_quote")
    out["is_probe_success"] = out.get("quote_status", "").astype(str).isin(
        ["executable_clean_quote", "quote_not_executable_by_gate"]
    )
    return out


def normalize_orders(orders: pd.DataFrame) -> pd.DataFrame:
    if orders.empty:
        return orders
    out = orders.copy()
    out["timestamp_utc"] = pd.to_datetime(out.get("timestamp_utc"), errors="coerce", utc=True)
    out["signal_date"] = pd.to_datetime(out.get("signal_date"), errors="coerce").dt.date.astype(str)
    if "pnl_usd" in out.columns:
        out["pnl_usd"] = pd.to_numeric(out["pnl_usd"], errors="coerce").fillna(0.0)
    out["is_realized"] = out.get("order_stage", "").astype(str).isin(["close", "realized", "settled"])
    out["is_paper_trade"] = ~out.get("order_stage", "").astype(str).isin(["no_trade", "skip", "blocked"])
    return out


def build_cycle_audit(cycles: pd.DataFrame, quotes: pd.DataFrame, orders: pd.DataFrame) -> list[dict[str, Any]]:
    if cycles.empty:
        return []
    rows: list[dict[str, Any]] = []
    quote_group = quotes.groupby("run_id") if not quotes.empty and "run_id" in quotes.columns else {}
    order_group = orders.groupby("run_id") if not orders.empty and "run_id" in orders.columns else {}
    for _, row in cycles.sort_values("timestamp_utc").iterrows():
        run_id = row.get("run_id", "")
        q = quote_group.get_group(run_id) if hasattr(quote_group, "groups") and run_id in quote_group.groups else pd.DataFrame()
        o = order_group.get_group(run_id) if hasattr(order_group, "groups") and run_id in order_group.groups else pd.DataFrame()
        quote_rows = int(len(q))
        clean_rows = int(q["is_clean_executable"].sum()) if not q.empty and "is_clean_executable" in q.columns else 0
        trade_rows = int(o["is_paper_trade"].sum()) if not o.empty and "is_paper_trade" in o.columns else 0
        realized_rows = int(o["is_realized"].sum()) if not o.empty and "is_realized" in o.columns else 0
        rows.append(
            {
                "run_id": run_id,
                "timestamp_utc": row.get("timestamp_utc"),
                "shadow_date": row.get("shadow_date"),
                "decision": row.get("decision", ""),
                "signals_today": row.get("signals_today", 0),
                "quote_probe_status": row.get("quote_probe_status", ""),
                "quote_rows": quote_rows,
                "clean_executable_quote_rows": clean_rows,
                "clean_executable_quote_rate": clean_rows / quote_rows if quote_rows else 0.0,
                "paper_trade_rows": trade_rows,
                "realized_rows": realized_rows,
                "cycle_realized_pnl_usd": row.get("cycle_realized_pnl_usd", 0.0),
                "open_position_count": row.get("open_position_count", 0),
                "strategy_tuning": row.get("strategy_tuning", ""),
            }
        )
    return rows


def build_quote_audit(quotes: pd.DataFrame) -> list[dict[str, Any]]:
    if quotes.empty:
        return []
    rows: list[dict[str, Any]] = []
    for (symbol, status), g in quotes.groupby(["symbol", "quote_status"], dropna=False):
        spreads = as_float_series(g, "spread").dropna()
        rows.append(
            {
                "symbol": symbol,
                "quote_status": status,
                "rows": int(len(g)),
                "unique_runs": int(g["run_id"].nunique()) if "run_id" in g.columns else 0,
                "avg_spread": float(spreads.mean()) if not spreads.empty else None,
                "median_spread": float(spreads.median()) if not spreads.empty else None,
                "max_spread": float(spreads.max()) if not spreads.empty else None,
                "avg_top_book_size": float(as_float_series(g, "top_book_size").mean()) if "top_book_size" in g.columns else None,
            }
        )
    rows.sort(key=lambda r: (str(r["symbol"]), str(r["quote_status"])))
    return rows


def build_daily_health(cycles: pd.DataFrame, quotes: pd.DataFrame, orders: pd.DataFrame) -> list[dict[str, Any]]:
    if cycles.empty:
        return []
    rows: list[dict[str, Any]] = []
    for day, c in cycles.groupby("shadow_date", dropna=False):
        q = quotes[quotes["shadow_date"] == day] if not quotes.empty and "shadow_date" in quotes.columns else pd.DataFrame()
        o = orders[orders["signal_date"] == day] if not orders.empty and "signal_date" in orders.columns else pd.DataFrame()
        quote_rows = len(q)
        clean_rows = int(q["is_clean_executable"].sum()) if quote_rows and "is_clean_executable" in q.columns else 0
        pnl_values = as_float_series(o, "pnl_usd").dropna().tolist() if not o.empty else []
        rows.append(
            {
                "shadow_date": day,
                "cycles": int(len(c)),
                "quote_rows": int(quote_rows),
                "clean_executable_quote_rows": clean_rows,
                "clean_executable_quote_rate": clean_rows / quote_rows if quote_rows else 0.0,
                "signals_seen": int(as_float_series(c, "signals_today").sum()) if "signals_today" in c.columns else 0,
                "paper_trade_rows": int(o["is_paper_trade"].sum()) if not o.empty and "is_paper_trade" in o.columns else 0,
                "realized_rows": int(o["is_realized"].sum()) if not o.empty and "is_realized" in o.columns else 0,
                "realized_pnl_usd": float(sum(pnl_values)),
                "profit_factor": profit_factor(pnl_values),
                "max_drawdown_usd": max_drawdown(pnl_values),
            }
        )
    rows.sort(key=lambda r: str(r["shadow_date"]))
    return rows


def compute_readiness(
    cycles: pd.DataFrame,
    quotes: pd.DataFrame,
    orders: pd.DataFrame,
    v38_summary: dict[str, Any],
) -> dict[str, Any]:
    unique_days = int(cycles["shadow_date"].nunique()) if not cycles.empty and "shadow_date" in cycles.columns else 0
    cycle_count = int(len(cycles))
    order_count = int(len(orders))
    realized_count = int(orders["is_realized"].sum()) if not orders.empty and "is_realized" in orders.columns else 0
    paper_trade_rows = int(orders["is_paper_trade"].sum()) if not orders.empty and "is_paper_trade" in orders.columns else 0
    quote_rows = int(len(quotes))
    clean_quote_rows = int(quotes["is_clean_executable"].sum()) if not quotes.empty and "is_clean_executable" in quotes.columns else 0
    clean_quote_rate = clean_quote_rows / quote_rows if quote_rows else 0.0
    quote_probe_success_rate = float(quotes["is_probe_success"].mean()) if not quotes.empty and "is_probe_success" in quotes.columns else 0.0
    pnl_values = as_float_series(orders, "pnl_usd").dropna().tolist() if not orders.empty else []
    v38_metrics = v38_summary.get("paper_metrics", {})

    ledger_health_pass = (
        cycle_count >= MIN_CYCLES_FOR_LEDGER_HEALTH
        and unique_days >= MIN_DAYS_FOR_LEDGER_HEALTH
        and clean_quote_rate >= MIN_CLEAN_QUOTE_RATE
    )
    v141_overlay_ready = ledger_health_pass and paper_trade_rows >= MIN_FORWARD_TRADES_FOR_OVERLAY
    v141_promotion_ready = (
        ledger_health_pass
        and realized_count >= MIN_FORWARD_TRADES_FOR_PROMOTION
        and sum(pnl_values) > 0
        and profit_factor(pnl_values) >= float(v38_metrics.get("profit_factor", 999.0)) * 0.8
    )

    if v141_promotion_ready:
        status = "ready_for_v141_overlay_promotion_review"
    elif v141_overlay_ready:
        status = "ready_for_v141_shadow_overlay_only"
    elif cycle_count == 0:
        status = "blocked_no_v139_cycles"
    else:
        status = "warmup_keep_accumulating_forward_ledger"

    return {
        "status": status,
        "ledger_health_pass": ledger_health_pass,
        "v141_overlay_ready": v141_overlay_ready,
        "v141_promotion_ready": v141_promotion_ready,
        "cycle_count": cycle_count,
        "unique_shadow_days": unique_days,
        "quote_rows": quote_rows,
        "clean_executable_quote_rows": clean_quote_rows,
        "clean_executable_quote_rate": clean_quote_rate,
        "quote_probe_success_rate": quote_probe_success_rate,
        "order_rows": order_count,
        "paper_trade_rows": paper_trade_rows,
        "realized_trade_rows": realized_count,
        "realized_pnl_usd": float(sum(pnl_values)),
        "profit_factor": profit_factor(pnl_values),
        "max_drawdown_usd": max_drawdown(pnl_values),
        "requirements": {
            "min_cycles_for_ledger_health": MIN_CYCLES_FOR_LEDGER_HEALTH,
            "min_days_for_ledger_health": MIN_DAYS_FOR_LEDGER_HEALTH,
            "min_clean_quote_rate": MIN_CLEAN_QUOTE_RATE,
            "min_forward_trades_for_overlay": MIN_FORWARD_TRADES_FOR_OVERLAY,
            "min_forward_trades_for_promotion": MIN_FORWARD_TRADES_FOR_PROMOTION,
        },
        "decision": "do_not_tune_q_or_trailing" if not v141_overlay_ready else "allow_v141_shadow_overlay_only",
    }


def write_report(summary: dict[str, Any]) -> None:
    v38 = summary["v38_reference"]
    readiness = summary["readiness"]
    current = summary["current_forward_ledger"]
    lines = [
        f"# {VERSION}",
        "",
        "## 结论",
        "",
        f"- 当前状态：`{readiness['status']}`",
        f"- 当前决策：`{readiness['decision']}`",
        "- 本阶段只审计 V1.39 前向账本，不调整 Q-Drift、Trailing、入场阈值或仓位。",
        "",
        "## V1.38 冻结基线",
        "",
        f"- 净收益：{v38.get('net_pnl_usd', 0):.2f}",
        f"- PF：{v38.get('profit_factor', 0):.3f}",
        f"- 最大回撤：{v38.get('max_drawdown_usd', 0):.2f}",
        f"- 压力测试净收益：{v38.get('stress_net_pnl_usd', 0):.2f}",
        "",
        "## V1.39 前向账本健康",
        "",
        f"- Shadow cycles：{current['cycle_count']}",
        f"- Shadow days：{current['unique_shadow_days']}",
        f"- Quote rows：{current['quote_rows']}",
        f"- Clean executable quote rate：{current['clean_executable_quote_rate']:.2%}",
        f"- Forward paper trade rows：{current['paper_trade_rows']}",
        f"- Realized paper rows：{current['realized_trade_rows']}",
        f"- Realized PnL：{current['realized_pnl_usd']:.2f}",
        "",
        "## V1.41 准入判断",
        "",
        "Q-Drift / Trailing 只能先作为旁路 shadow overlay，不能替换 V1.38 主线。",
        "",
        f"- 账本健康通过：{readiness['ledger_health_pass']}",
        f"- 允许 V1.41 旁路 overlay：{readiness['v141_overlay_ready']}",
        f"- 允许 overlay 晋级复审：{readiness['v141_promotion_ready']}",
        "",
        "## 下一步",
        "",
        "继续让 V1.39 定时 runner 累积前向数据。达到 V1.40 准入要求后，再做 V1.41 Q-Drift / Trailing Shadow Overlay。",
    ]
    REPORT_MD.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_plot(cycles: pd.DataFrame, quotes: pd.DataFrame, orders: pd.DataFrame, readiness: dict[str, Any]) -> None:
    plt.style.use("seaborn-v0_8-whitegrid")
    fig, axes = plt.subplots(2, 2, figsize=(12, 8))
    fig.suptitle("HFCD Trading V1.40 Forward Ledger Audit", fontsize=15, fontweight="bold")

    ax = axes[0, 0]
    if not quotes.empty and "quote_status" in quotes.columns:
        quotes["quote_status"].value_counts().plot(kind="bar", ax=ax, color="#2f6f73")
    ax.set_title("Quote Status Counts")
    ax.set_ylabel("Rows")
    ax.tick_params(axis="x", rotation=30)

    ax = axes[0, 1]
    if not cycles.empty:
        day_counts = cycles.groupby("shadow_date").size()
        day_counts.plot(kind="bar", ax=ax, color="#4c8f5f")
    ax.set_title("Shadow Cycles By Day")
    ax.set_ylabel("Cycles")
    ax.tick_params(axis="x", rotation=30)

    ax = axes[1, 0]
    if not orders.empty and "pnl_usd" in orders.columns:
        pnl = as_float_series(orders, "pnl_usd").fillna(0).cumsum()
        ax.plot(range(1, len(pnl) + 1), pnl, color="#0f766e", linewidth=2)
    ax.set_title("Forward Paper Cumulative PnL")
    ax.set_xlabel("Order rows")
    ax.set_ylabel("USD")

    ax = axes[1, 1]
    labels = ["cycles", "days", "clean quotes", "paper rows"]
    values = [
        readiness["cycle_count"],
        readiness["unique_shadow_days"],
        readiness["clean_executable_quote_rows"],
        readiness["paper_trade_rows"],
    ]
    ax.bar(labels, values, color=["#1f2937", "#374151", "#0f766e", "#f59e0b"])
    ax.set_title(f"Readiness: {readiness['status']}")
    ax.tick_params(axis="x", rotation=20)

    plt.tight_layout(rect=[0, 0, 1, 0.94])
    fig.savefig(REPORT_PNG, dpi=180)
    plt.close(fig)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    v38_summary = read_json(V38_SUMMARY)
    v39_summary = read_json(V39_SUMMARY)
    cycles = normalize_cycles(read_csv(V39_CYCLES))
    quotes = normalize_quotes(read_csv(V39_QUOTES))
    orders = normalize_orders(read_csv(V39_ORDERS))
    routes = read_csv(V39_ROUTES)

    cycle_audit = build_cycle_audit(cycles, quotes, orders)
    quote_audit = build_quote_audit(quotes)
    daily_health = build_daily_health(cycles, quotes, orders)
    readiness = compute_readiness(cycles, quotes, orders, v38_summary)

    write_csv(CYCLE_AUDIT_CSV, cycle_audit)
    write_csv(QUOTE_AUDIT_CSV, quote_audit)
    write_csv(DAY_AUDIT_CSV, daily_health)
    write_csv(READINESS_CSV, [readiness])

    paper_metrics = v38_summary.get("paper_metrics", {})
    stress = v38_summary.get("stress_reference", {})
    current = {
        "cycle_count": readiness["cycle_count"],
        "unique_shadow_days": readiness["unique_shadow_days"],
        "quote_rows": readiness["quote_rows"],
        "clean_executable_quote_rows": readiness["clean_executable_quote_rows"],
        "clean_executable_quote_rate": readiness["clean_executable_quote_rate"],
        "quote_probe_success_rate": readiness["quote_probe_success_rate"],
        "paper_trade_rows": readiness["paper_trade_rows"],
        "realized_trade_rows": readiness["realized_trade_rows"],
        "realized_pnl_usd": readiness["realized_pnl_usd"],
        "profit_factor": readiness["profit_factor"],
        "max_drawdown_usd": readiness["max_drawdown_usd"],
        "roll_route_rows": int(len(routes)) if not routes.empty else 0,
        "latest_cycle": cycle_audit[-1] if cycle_audit else {},
    }
    summary = {
        "version": VERSION,
        "generated_at": utc_now(),
        "status": readiness["status"],
        "source": {
            "v38_summary": str(V38_SUMMARY),
            "v39_summary": str(V39_SUMMARY),
            "v39_cycles": str(V39_CYCLES),
            "v39_quotes": str(V39_QUOTES),
            "v39_orders": str(V39_ORDERS),
        },
        "v38_reference": {
            "net_pnl_usd": paper_metrics.get("net_pnl_usd", 0.0),
            "profit_factor": paper_metrics.get("profit_factor", 0.0),
            "max_drawdown_usd": paper_metrics.get("max_drawdown_usd", 0.0),
            "stress_net_pnl_usd": stress.get("net_pnl_usd", 0.0),
            "stress_profit_factor": stress.get("profit_factor", 0.0),
            "production_gate_passed": v38_summary.get("production_gate", {}).get("passed", False),
        },
        "v39_current_summary": v39_summary.get("current_cycle", {}),
        "current_forward_ledger": current,
        "readiness": readiness,
        "decision": readiness["decision"],
        "next_step": "Keep accumulating V1.39 forward ledger. V1.41 Q-Drift/Trailing must remain shadow-only until forward paper evidence exists.",
    }

    write_json(SUMMARY_JSON, summary)
    write_csv(
        SUMMARY_CSV,
        [
            {
                "version": VERSION,
                "generated_at": summary["generated_at"],
                "status": summary["status"],
                "cycle_count": current["cycle_count"],
                "unique_shadow_days": current["unique_shadow_days"],
                "clean_executable_quote_rate": current["clean_executable_quote_rate"],
                "paper_trade_rows": current["paper_trade_rows"],
                "realized_trade_rows": current["realized_trade_rows"],
                "realized_pnl_usd": current["realized_pnl_usd"],
                "v141_overlay_ready": readiness["v141_overlay_ready"],
                "decision": summary["decision"],
            }
        ],
    )
    write_report(summary)
    write_plot(cycles, quotes, orders, readiness)
    print(json.dumps(clean_json(summary), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
