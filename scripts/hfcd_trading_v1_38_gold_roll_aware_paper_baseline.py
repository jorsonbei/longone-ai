#!/usr/bin/env python3
"""
HFCD Trading V1.38 Gold Roll-Aware Paper Baseline.

V1.37 closed the executable clean quote coverage gap by allowing a tightly
constrained nearest-active GC contract route only when the original contract
top-of-book was non-executable. This stage freezes that candidate into a
production-style paper baseline:

1. Build a deterministic open/close paper order ledger from real clean bid/ask.
2. Keep roll-aware execution explicitly separated from strict same-contract fills.
3. Preserve V1.37 economics and stress gates without tuning signals, Q exits,
   trailing stops, thresholds, or sizing.
"""

from __future__ import annotations

import json
import math
from datetime import datetime
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


VERSION = "HFCD_Trading_V1_38_GoldRollAwarePaperBaseline"
ROOT = Path.cwd()
V37_DIR = ROOT / "outputs" / "hfcd_trading_v1_37_gold_roll_aware_clean_quote_repair"
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v1_38_gold_roll_aware_paper_baseline"

TRADE_REPLAY = V37_DIR / "hfcd_trading_v1_37_roll_aware_replay.csv"
ROLL_AUDIT = V37_DIR / "hfcd_trading_v1_37_roll_repair_audit.csv"
STRESS_MATRIX = V37_DIR / "hfcd_trading_v1_37_cost_stress_matrix.csv"
SUMMARY_JSON = V37_DIR / "hfcd_trading_v1_37_summary.json"


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


def max_drawdown(values: list[float]) -> float:
    if not values:
        return 0.0
    equity = np.cumsum(values)
    peak = np.maximum.accumulate(equity)
    return float((equity - peak).min())


def metric_block(values: list[float], total_signals: int) -> dict[str, Any]:
    vals = [float(v) for v in values]
    wins = [v for v in vals if v > 0]
    losses = [v for v in vals if v < 0]
    gross_win = float(sum(wins))
    gross_loss = float(abs(sum(losses)))
    return {
        "signals": int(total_signals),
        "executed": int(len(vals)),
        "wins": int(len(wins)),
        "losses": int(len(losses)),
        "win_rate_executed": float(len(wins) / len(vals)) if vals else 0.0,
        "win_rate_all_signals": float(len(wins) / total_signals) if total_signals else 0.0,
        "net_pnl_usd": float(sum(vals)),
        "profit_factor": float(gross_win / gross_loss) if gross_loss > 0 else (999.0 if gross_win > 0 else 0.0),
        "max_drawdown_usd": max_drawdown(vals),
        "gross_win_usd": gross_win,
        "gross_loss_usd": gross_loss,
        "avg_pnl_per_executed_trade_usd": float(np.mean(vals)) if vals else 0.0,
        "avg_pnl_per_signal_usd": float(sum(vals) / total_signals) if total_signals else 0.0,
    }


def load_inputs() -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, dict[str, Any]]:
    for path in [TRADE_REPLAY, ROLL_AUDIT, STRESS_MATRIX, SUMMARY_JSON]:
        if not path.exists():
            raise FileNotFoundError(path)
    trades = pd.read_csv(TRADE_REPLAY)
    audit = pd.read_csv(ROLL_AUDIT)
    stress = pd.read_csv(STRESS_MATRIX)
    summary = json.loads(SUMMARY_JSON.read_text(encoding="utf-8"))
    if not summary.get("gate", {}).get("passed"):
        raise RuntimeError("V1.37 gate has not passed; V1.38 cannot freeze baseline.")
    return trades, audit, stress, summary


def fill_qty(row: pd.Series) -> float:
    entry_px = float(row["entry_ask"])
    if entry_px <= 0:
        return 0.0
    return float(row["notional_usd"] / entry_px)


def build_order_ledger(trades: pd.DataFrame) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    for _, row in trades.iterrows():
        qty = fill_qty(row)
        trade_id = int(row["trade_id_v130"])
        common = {
            "trade_id_v130": trade_id,
            "fold": row.get("fold"),
            "split": row.get("split"),
            "side": row.get("side"),
            "signal_score": float(row.get("score", 0.0)),
            "notional_usd": float(row.get("notional_usd", 0.0)),
            "fee_usd_roundtrip": float(row.get("fee_usd", 0.0)),
            "quantity_oz_proxy": qty,
            "roll_repair_used": bool(row.get("roll_repair_used")),
            "execution_policy": "clean_bid_ask_roll_aware_v1_38",
            "production_mode": "paper_only_no_real_order",
        }
        rows.append(
            {
                **common,
                "order_id": f"v1_38_{trade_id}_open",
                "order_stage": "open",
                "timestamp_utc": row.get("entry_bbo_ts"),
                "signal_date": row.get("date"),
                "selected_symbol": row.get("entry_selected_symbol"),
                "original_symbol": row.get("front_symbol"),
                "route": row.get("entry_route"),
                "route_rank": int(row.get("entry_route_rank", 0)),
                "fill_side": "buy_at_ask",
                "fill_price": float(row.get("entry_ask", 0.0)),
                "mid_price": float(row.get("entry_mid", 0.0)),
                "spread_usd": float(row.get("entry_spread", 0.0)),
                "top_book_size": float(row.get("entry_top_book_size", 0.0)),
                "repair_stage": row.get("entry_repair_stage"),
                "roll_leg_repair_used": bool(row.get("entry_roll_repair_used")),
                "anchor_price_distance_usd": float(row.get("entry_anchor_price_distance_usd", 0.0)),
                "paper_cash_flow_usd": -float(row.get("notional_usd", 0.0)),
                "pnl_usd": 0.0,
            }
        )
        rows.append(
            {
                **common,
                "order_id": f"v1_38_{trade_id}_close",
                "order_stage": "close",
                "timestamp_utc": row.get("exit_bbo_ts"),
                "signal_date": row.get("exit_date"),
                "selected_symbol": row.get("exit_selected_symbol"),
                "original_symbol": row.get("exit_symbol"),
                "route": row.get("exit_route"),
                "route_rank": int(row.get("exit_route_rank", 0)),
                "fill_side": "sell_at_bid",
                "fill_price": float(row.get("exit_bid", 0.0)),
                "mid_price": float(row.get("exit_mid", 0.0)),
                "spread_usd": float(row.get("exit_spread", 0.0)),
                "top_book_size": float(row.get("exit_top_book_size", 0.0)),
                "repair_stage": row.get("exit_repair_stage"),
                "roll_leg_repair_used": bool(row.get("exit_roll_repair_used")),
                "anchor_price_distance_usd": float(row.get("exit_anchor_price_distance_usd", 0.0)),
                "paper_cash_flow_usd": float(row.get("notional_usd", 0.0)) + float(row.get("bbo_bidask_pnl_usd", 0.0)),
                "pnl_usd": float(row.get("bbo_bidask_pnl_usd", 0.0)),
            }
        )
    return pd.DataFrame(rows)


def route_risk_audit(trades: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for label, sub in [
        ("strict_same_contract", trades[~trades["roll_repair_used"].astype(bool)]),
        ("roll_aware_adjacent_contract", trades[trades["roll_repair_used"].astype(bool)]),
    ]:
        pnl = pd.to_numeric(sub["bbo_bidask_pnl_usd"], errors="coerce").fillna(0.0).tolist()
        block = metric_block(pnl, int(len(trades)))
        rows.append(
            {
                "route_bucket": label,
                "trade_count": int(len(sub)),
                "entry_roll_repairs": int(sub.get("entry_roll_repair_used", pd.Series(False, index=sub.index)).astype(bool).sum()),
                "exit_roll_repairs": int(sub.get("exit_roll_repair_used", pd.Series(False, index=sub.index)).astype(bool).sum()),
                "avg_entry_spread": float(pd.to_numeric(sub.get("entry_spread"), errors="coerce").mean()) if len(sub) else 0.0,
                "avg_exit_spread": float(pd.to_numeric(sub.get("exit_spread"), errors="coerce").mean()) if len(sub) else 0.0,
                **block,
            }
        )
    return pd.DataFrame(rows)


def daily_ledger(trades: pd.DataFrame) -> pd.DataFrame:
    df = trades.copy()
    df["exit_date"] = pd.to_datetime(df["exit_date"], errors="coerce").dt.date.astype(str)
    out = (
        df.groupby("exit_date", dropna=False)
        .agg(
            trades=("trade_id_v130", "count"),
            pnl_usd=("bbo_bidask_pnl_usd", "sum"),
            roll_repair_trades=("roll_repair_used", "sum"),
            avg_spread_cost_usd=("bbo_spread_cost_usd", "mean"),
        )
        .reset_index()
        .rename(columns={"exit_date": "date"})
    )
    out["cum_pnl_usd"] = out["pnl_usd"].cumsum()
    return out


def build_config(summary: dict[str, Any]) -> dict[str, Any]:
    return {
        "version": VERSION,
        "mode": "paper_only",
        "source_candidate": "HFCD_Trading_V1_37_GoldRollAwareCleanQuoteRepair",
        "signal_lineage": "V1.29 official-settlement baseline -> V1.31 execution anchor -> V1.37 roll-aware clean quote repair",
        "frozen_rules": {
            "anchor": "next_after_2000_wait240",
            "entry_fill": "buy_at_clean_ask",
            "exit_fill": "sell_at_clean_bid",
            "strict_same_contract_first": True,
            "roll_aware_repair_allowed": True,
            "roll_aware_repair_scope": "dirty_non_executable_leg_only",
            "roll_aware_max_route_rank": 1,
            "roll_aware_max_price_distance_usd": 35.0,
            "roll_aware_max_price_distance_bps": 120.0,
            "dirty_quote_imputation": False,
            "q_or_trailing_tuning": False,
            "position_sizing_tuning": False,
        },
        "notional": {
            "per_trade_notional_usd": 10_000.0,
            "roundtrip_fee_usd": 3.50,
        },
        "promotion_gate_snapshot": summary["gate"],
        "deployment_boundary": {
            "allowed": "paper trading, forward shadow logs, execution cost monitoring",
            "not_allowed": "real money execution without broker/FCM order, margin, risk and compliance integration",
        },
    }


def build_summary(
    trades: pd.DataFrame,
    audit: pd.DataFrame,
    stress: pd.DataFrame,
    v37_summary: dict[str, Any],
    route_audit: pd.DataFrame,
) -> dict[str, Any]:
    total_signals = int(v37_summary["coverage"]["total_signals"])
    pnl = pd.to_numeric(trades["bbo_bidask_pnl_usd"], errors="coerce").fillna(0.0).tolist()
    metrics = metric_block(pnl, total_signals)
    stress_ref = stress[(stress["fee_multiplier"] == 2.0) & (stress["extra_slippage_bps_per_side"] == 1.0)].iloc[0].to_dict()
    route_roll = route_audit[route_audit["route_bucket"] == "roll_aware_adjacent_contract"].iloc[0].to_dict()
    split = {}
    for split_name, sub in trades.groupby("split"):
        split[str(split_name)] = {
            "trades": int(len(sub)),
            "net_pnl_usd": float(sub["bbo_bidask_pnl_usd"].sum()),
            "profit_factor": metric_block(sub["bbo_bidask_pnl_usd"].astype(float).tolist(), total_signals=int(len(sub)))["profit_factor"],
            "roll_repair_trades": int(sub["roll_repair_used"].astype(bool).sum()),
        }
    production_gate_actual = {
        "paper_order_pairs": int(len(trades)),
        "paper_order_rows": int(len(trades) * 2),
        "coverage": float(v37_summary["coverage"]["roll_aware_coverage_of_v131_executed"]),
        "strict_same_anchor_coverage": float(v37_summary["coverage"]["strict_same_anchor_coverage_of_v131_executed"]),
        "roll_repair_trades": int(v37_summary["coverage"]["roll_repair_trades"]),
        "bbo_bidask_net_pnl_usd": float(metrics["net_pnl_usd"]),
        "stress_2x_fee_plus_1bps_net_pnl_usd": float(stress_ref["net_pnl_usd"]),
        "pnl_corr_vs_v131_anchor": float(v37_summary["alignment"]["pnl_corr_vs_v131_anchor"]),
        "sign_match_vs_v131_anchor": float(v37_summary["alignment"]["sign_match_vs_v131_anchor"]),
        "holdout_net_pnl_usd": float(split.get("holdout", {}).get("net_pnl_usd", 0.0)),
        "rolling_net_pnl_usd": float(split.get("rolling", {}).get("net_pnl_usd", 0.0)),
    }
    gate_passed = (
        production_gate_actual["coverage"] >= 0.80
        and production_gate_actual["bbo_bidask_net_pnl_usd"] > 0
        and production_gate_actual["stress_2x_fee_plus_1bps_net_pnl_usd"] > 0
        and production_gate_actual["pnl_corr_vs_v131_anchor"] >= 0.90
        and production_gate_actual["sign_match_vs_v131_anchor"] >= 0.90
        and production_gate_actual["holdout_net_pnl_usd"] > 0
        and production_gate_actual["rolling_net_pnl_usd"] > 0
    )
    return {
        "version": VERSION,
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "status": "gold_roll_aware_paper_baseline_candidate" if gate_passed else "gold_roll_aware_paper_baseline_watchlist",
        "source": {
            "v37_status": v37_summary["status"],
            "v37_decision": v37_summary["decision"],
            "purpose": "freeze roll-aware clean quote repair into a production-style paper order baseline",
            "q_or_trailing_tuning": "not_allowed_in_v1_38",
        },
        "paper_metrics": metrics,
        "stress_reference": clean_json(stress_ref),
        "split": split,
        "route_risk": {
            "roll_aware_adjacent_contract": clean_json(route_roll),
            "audit_rows": int(len(audit)),
            "unmatched_after_v1_38": int((~trades["bbo_mbp_matched"].astype(bool)).sum()),
        },
        "production_gate": {
            "requires": {
                "coverage": ">= 0.80",
                "bbo_bidask_net_pnl_usd": "> 0",
                "stress_2x_fee_plus_1bps_net_pnl_usd": "> 0",
                "pnl_corr_vs_v131_anchor": ">= 0.90",
                "sign_match_vs_v131_anchor": ">= 0.90",
                "rolling_and_holdout_net_pnl": "> 0",
            },
            "actual": production_gate_actual,
            "passed": bool(gate_passed),
        },
        "decision": "freeze_as_gold_roll_aware_paper_baseline" if gate_passed else "keep_v1_37_candidate_until_paper_gate_passes",
        "next_step": (
            "V1.39 should run forward paper shadow mode with this frozen execution config, "
            "recording live quote availability, roll route usage, and realized paper PnL. "
            "Do not tune Q/trailing until the forward paper ledger is accumulated."
        ),
    }


def write_report(summary: dict[str, Any]) -> None:
    metrics = summary["paper_metrics"]
    gate = summary["production_gate"]
    lines = [
        "# HFCD Trading V1.38 Gold Roll-Aware Paper Baseline",
        "",
        "## Purpose",
        "Freeze V1.37 into a deterministic paper-trading baseline. This is an execution and accounting stage only; no signal, Q, trailing, threshold, or sizing parameter was tuned.",
        "",
        "## Result",
        f"- Status: `{summary['status']}`",
        f"- Decision: `{summary['decision']}`",
        f"- Executed trade pairs: {metrics['executed']}",
        f"- Paper order rows: {gate['actual']['paper_order_rows']}",
        f"- Net PnL: ${metrics['net_pnl_usd']:.2f}",
        f"- PF: {metrics['profit_factor']:.3f}",
        f"- Max drawdown: ${metrics['max_drawdown_usd']:.2f}",
        f"- 2x fee + 1bps/side stress net: ${summary['stress_reference']['net_pnl_usd']:.2f}",
        f"- Roll-aware coverage: {gate['actual']['coverage']:.2%}",
        f"- Strict same-anchor coverage: {gate['actual']['strict_same_anchor_coverage']:.2%}",
        f"- Roll-repair trades: {gate['actual']['roll_repair_trades']}",
        "",
        "## Production Boundary",
        "This baseline is suitable for paper trading and forward shadow logging. It is not a real-money execution engine; real deployment still needs broker/FCM order routing, margin, kill-switch and compliance controls.",
        "",
        "## Next Step",
        summary["next_step"],
    ]
    (OUT_DIR / "HFCD_Trading_V1_38_GoldRollAwarePaperBaseline.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_plot(trades: pd.DataFrame, summary: dict[str, Any], route_audit: pd.DataFrame) -> None:
    vals = trades["bbo_bidask_pnl_usd"].astype(float).tolist()
    fig, axes = plt.subplots(2, 2, figsize=(12, 8))
    axes[0, 0].plot(np.cumsum(vals))
    axes[0, 0].set_title("V1.38 cumulative paper PnL")
    axes[0, 1].bar(["base", "stress"], [summary["paper_metrics"]["net_pnl_usd"], summary["stress_reference"]["net_pnl_usd"]])
    axes[0, 1].set_title("Base vs stress net PnL")
    route_audit.plot(kind="bar", x="route_bucket", y="net_pnl_usd", ax=axes[1, 0], legend=False)
    axes[1, 0].set_title("PnL by execution route bucket")
    trades.groupby("split")["bbo_bidask_pnl_usd"].sum().plot(kind="bar", ax=axes[1, 1])
    axes[1, 1].set_title("PnL by split")
    fig.tight_layout()
    fig.savefig(OUT_DIR / "HFCD_Trading_V1_38_GoldRollAwarePaperBaseline.png", dpi=160)
    plt.close(fig)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    trades, audit, stress, v37_summary = load_inputs()
    order_ledger = build_order_ledger(trades)
    route_audit = route_risk_audit(trades)
    daily = daily_ledger(trades)
    config = build_config(v37_summary)
    summary = build_summary(trades, audit, stress, v37_summary, route_audit)

    trades.to_csv(OUT_DIR / "hfcd_trading_v1_38_trade_ledger.csv", index=False)
    order_ledger.to_csv(OUT_DIR / "hfcd_trading_v1_38_paper_orders.csv", index=False)
    route_audit.to_csv(OUT_DIR / "hfcd_trading_v1_38_route_risk_audit.csv", index=False)
    daily.to_csv(OUT_DIR / "hfcd_trading_v1_38_daily_paper_ledger.csv", index=False)
    stress.to_csv(OUT_DIR / "hfcd_trading_v1_38_cost_stress_matrix.csv", index=False)
    (OUT_DIR / "hfcd_trading_v1_38_production_config.json").write_text(json.dumps(clean_json(config), ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT_DIR / "hfcd_trading_v1_38_summary.json").write_text(json.dumps(clean_json(summary), ensure_ascii=False, indent=2), encoding="utf-8")
    pd.DataFrame([summary]).to_csv(OUT_DIR / "hfcd_trading_v1_38_summary.csv", index=False)
    write_report(summary)
    write_plot(trades, summary, route_audit)
    print(json.dumps(clean_json(summary), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
