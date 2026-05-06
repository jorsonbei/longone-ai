#!/usr/bin/env python3
"""
HFCD Trading V1.37 Gold Roll-Aware Clean Quote Repair.

V1.36 proved the remaining gap is not model logic but clean executable quote
coverage. Most remaining dirty legs occur near contract roll / expiry: the
original contract has a visibly broken top-of-book spread, while the next GC
contract has a clean executable market. This stage keeps the V1.31/V1.36 trade
set fixed and only repairs the execution route for non-executable dirty legs.

No signal tuning, Q-exit tuning, trailing, or dirty-quote imputation is allowed.
Roll repair is audited separately from strict same-contract coverage.
"""

from __future__ import annotations

import importlib.util
import json
import math
from datetime import datetime
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


VERSION = "HFCD_Trading_V1_37_GoldRollAwareCleanQuoteRepair"
ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v1_37_gold_roll_aware_clean_quote_repair"
V36_SCRIPT = ROOT / "scripts" / "hfcd_trading_v1_36_gold_clean_quote_targeted_backfill.py"
V36_OUT_DIR = ROOT / "outputs" / "hfcd_trading_v1_36_gold_clean_quote_targeted_backfill"

ROLL_MAX_ROUTE_RANK = 1
ROLL_MAX_PRICE_DIST_USD = 35.0
ROLL_MAX_PRICE_DIST_BPS = 120.0
ROLL_REQUIRE_ORIGINAL_DIRTY = True


def import_module(path: Path, name: str) -> Any:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot import {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


v36 = import_module(V36_SCRIPT, "hfcd_v36_targeted_backfill")
v34 = v36.v34


def clean_json(value: Any) -> Any:
    return v36.clean_json(value)


def write_csv(path: Path, df: pd.DataFrame) -> None:
    df.to_csv(path, index=False)


def side_from_row(row: pd.Series, side: str) -> dict[str, Any]:
    return v36.side_from_existing(row, side)


def original_is_dirty(row: pd.Series, side: str) -> bool:
    return str(row.get(f"{side}_bbo_status")) == "quote_quality_fail_after_anchor"


def roll_candidate(store: Any, row: pd.Series, side: str) -> dict[str, Any] | None:
    original = str(row["front_symbol"] if side == "entry" else row["exit_symbol"])
    target = pd.Timestamp(row[f"{side}_anchor_ts"])
    anchor_price = float(row[f"{side}_anchor_price"])

    candidates: list[dict[str, Any]] = []
    for symbol, route, rank in v36.adjacent_contracts(original):
        if rank == 0 or rank > ROLL_MAX_ROUTE_RANK:
            continue
        book, source = store.get_window(symbol, target)
        result = dict(v36.select_first_clean_quote(book, target))
        result["selected_symbol"] = symbol
        result["route"] = route
        result["route_rank"] = rank
        result["source"] = source
        dist, bps = v36.price_distance(result, anchor_price)
        result["anchor_price_distance_usd"] = dist
        result["anchor_price_distance_bps"] = bps
        result["roll_repair_eligible"] = (
            result.get("status") == "matched"
            and dist <= ROLL_MAX_PRICE_DIST_USD
            and bps <= ROLL_MAX_PRICE_DIST_BPS
        )
        candidates.append(result)

    eligible = [c for c in candidates if c.get("roll_repair_eligible")]
    if not eligible:
        return None
    eligible.sort(
        key=lambda c: (
            int(c.get("route_rank", 999)),
            float(c.get("seconds_away", math.inf)),
            float(c.get("anchor_price_distance_usd", math.inf)),
        )
    )
    best = dict(eligible[0])
    best["accepted"] = True
    best["repair_stage"] = f"roll_aware_{best.get('repair_stage')}"
    best["all_roll_attempts"] = candidates
    return best


def metric_block(values: list[float], total_signals: int) -> dict[str, Any]:
    return v34.metric_block(values, total_signals=total_signals, executed=len(values))


def build_stress(bbo: pd.DataFrame, total_signals: int) -> pd.DataFrame:
    return pd.DataFrame(v36.build_cost_stress(bbo, total_signals=total_signals))


def repair(v36_replay: pd.DataFrame) -> tuple[pd.DataFrame, list[dict[str, Any]], Any]:
    store = v36.TargetedBookStore()
    rows: list[dict[str, Any]] = []
    audit: list[dict[str, Any]] = []
    for _, row in v36_replay.iterrows():
        entry = side_from_row(row, "entry")
        exit_ = side_from_row(row, "exit")
        entry_roll = False
        exit_roll = False

        if not bool(row["bbo_mbp_matched"]):
            if entry.get("status") != "matched" and (not ROLL_REQUIRE_ORIGINAL_DIRTY or original_is_dirty(row, "entry")):
                candidate = roll_candidate(store, row, "entry")
                if candidate is not None:
                    entry = candidate
                    entry_roll = True
            if exit_.get("status") != "matched" and (not ROLL_REQUIRE_ORIGINAL_DIRTY or original_is_dirty(row, "exit")):
                candidate = roll_candidate(store, row, "exit")
                if candidate is not None:
                    exit_ = candidate
                    exit_roll = True

        out = v36.recompute_trade(row, entry, exit_)
        out["entry_roll_repair_used"] = entry_roll
        out["exit_roll_repair_used"] = exit_roll
        out["roll_repair_used"] = bool(entry_roll or exit_roll)
        rows.append(out)

        if entry_roll or exit_roll or not bool(out["bbo_mbp_matched"]):
            audit.append(
                {
                    "trade_id_v130": row.get("trade_id_v130"),
                    "split": row.get("split"),
                    "date": row.get("date"),
                    "exit_date": row.get("exit_date"),
                    "front_symbol": row.get("front_symbol"),
                    "exit_symbol": row.get("exit_symbol"),
                    "entry_roll_repair_used": entry_roll,
                    "exit_roll_repair_used": exit_roll,
                    "bbo_mbp_matched": bool(out["bbo_mbp_matched"]),
                    "entry_selected_symbol": out.get("entry_selected_symbol"),
                    "exit_selected_symbol": out.get("exit_selected_symbol"),
                    "entry_repair_stage": out.get("entry_repair_stage"),
                    "exit_repair_stage": out.get("exit_repair_stage"),
                    "entry_spread": out.get("entry_spread"),
                    "exit_spread": out.get("exit_spread"),
                    "entry_anchor_price_distance_usd": out.get("entry_anchor_price_distance_usd"),
                    "exit_anchor_price_distance_usd": out.get("exit_anchor_price_distance_usd"),
                    "bbo_bidask_pnl_usd": out.get("bbo_bidask_pnl_usd"),
                }
            )
    return pd.DataFrame(rows), audit, store


def split_block(df: pd.DataFrame, total_by_split: dict[str, int]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for split, total in total_by_split.items():
        sub = df[(df["split"] == split) & (df["bbo_mbp_matched"])].copy()
        out[split] = {
            "signals": int(total),
            "matched": int(len(sub)),
            "coverage_rate": float(len(sub) / total) if total else 0.0,
            "bbo_net_pnl_usd": float(sub["bbo_bidask_pnl_usd"].sum()),
            "bbo_profit_factor": metric_block(sub["bbo_bidask_pnl_usd"].dropna().astype(float).tolist(), total)["profit_factor"],
            "roll_repair_trades": int(sub.get("roll_repair_used", pd.Series(False, index=sub.index)).astype(bool).sum()),
        }
    return out


def build_summary(v36_summary: dict[str, Any], repaired: pd.DataFrame, stress: pd.DataFrame, audit: list[dict[str, Any]]) -> dict[str, Any]:
    total_signals = int(v36_summary["coverage"]["total_signals"])
    v131_executed = int(v36_summary["coverage"]["v131_executed"])
    matched = repaired[repaired["bbo_mbp_matched"]].copy()
    roll = matched[matched.get("roll_repair_used", pd.Series(False, index=matched.index)).astype(bool)].copy()
    strict = matched[~matched.get("roll_repair_used", pd.Series(False, index=matched.index)).astype(bool)].copy()
    bbo_metrics = metric_block(matched["bbo_bidask_pnl_usd"].dropna().astype(float).tolist(), total_signals)
    anchor_subset = repaired[repaired["bbo_mbp_matched"]].copy()
    alignment = {
        "pnl_corr_vs_v131_anchor": v34.safe_corr(anchor_subset["bbo_bidask_pnl_usd"], anchor_subset["anchor_pnl"]),
        "sign_match_vs_v131_anchor": v34.sign_match(anchor_subset["bbo_bidask_pnl_usd"], anchor_subset["anchor_pnl"]),
        "mean_abs_pnl_delta_vs_v131_anchor": float((anchor_subset["bbo_bidask_pnl_usd"] - anchor_subset["anchor_pnl"]).abs().mean()),
        "pnl_corr_vs_official": v34.safe_corr(anchor_subset["bbo_bidask_pnl_usd"], anchor_subset["official_settlement_pnl"]),
        "sign_match_vs_official": v34.sign_match(anchor_subset["bbo_bidask_pnl_usd"], anchor_subset["official_settlement_pnl"]),
    }
    total_by_split = repaired.groupby("split").size().astype(int).to_dict()
    stress_ref = stress[(stress["fee_multiplier"] == 2.0) & (stress["extra_slippage_bps_per_side"] == 1.0)].iloc[0].to_dict()
    gate_actual = {
        "roll_aware_coverage_of_v131_executed": float(len(matched) / v131_executed),
        "strict_same_anchor_coverage_of_v131_executed": float(len(strict) / v131_executed),
        "roll_repair_trades": int(len(roll)),
        "bbo_bidask_net_pnl_usd": float(bbo_metrics["net_pnl_usd"]),
        "stress_2x_fee_plus_1bps_net_pnl_usd": float(stress_ref["net_pnl_usd"]),
        "pnl_corr_vs_v131_anchor": alignment["pnl_corr_vs_v131_anchor"],
        "sign_match_vs_v131_anchor": alignment["sign_match_vs_v131_anchor"],
    }
    gate = {
        "requires": {
            "roll_aware_coverage_of_v131_executed": ">= 0.80",
            "bbo_bidask_net_pnl_usd": "> 0",
            "stress_2x_fee_plus_1bps_net_pnl_usd": "> 0",
            "pnl_corr_vs_v131_anchor": ">= 0.90",
            "sign_match_vs_v131_anchor": ">= 0.90",
        },
        "actual": gate_actual,
        "passed": bool(
            gate_actual["roll_aware_coverage_of_v131_executed"] >= 0.80
            and gate_actual["bbo_bidask_net_pnl_usd"] > 0
            and gate_actual["stress_2x_fee_plus_1bps_net_pnl_usd"] > 0
            and gate_actual["pnl_corr_vs_v131_anchor"] >= 0.90
            and gate_actual["sign_match_vs_v131_anchor"] >= 0.90
        ),
    }
    return {
        "version": VERSION,
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "status": "gold_roll_aware_clean_quote_repair_candidate" if gate["passed"] else "gold_roll_aware_clean_quote_repair_watchlist",
        "source": {
            "baseline": "V1.36 targeted clean quote backfill output",
            "repair_method": "roll-aware execution-route repair for dirty non-executable legs only",
            "q_or_trailing_tuning": "not_allowed_in_v1_37",
            "roll_constraints": {
                "max_route_rank": ROLL_MAX_ROUTE_RANK,
                "max_price_dist_usd": ROLL_MAX_PRICE_DIST_USD,
                "max_price_dist_bps": ROLL_MAX_PRICE_DIST_BPS,
                "require_original_dirty": ROLL_REQUIRE_ORIGINAL_DIRTY,
            },
        },
        "coverage": {
            "total_signals": total_signals,
            "v131_executed": v131_executed,
            "v36_matched": int(v36_summary["coverage"]["bbo_mbp_matched"]),
            "roll_aware_matched": int(len(matched)),
            "roll_aware_missing": int(v131_executed - len(matched)),
            "roll_aware_coverage_of_v131_executed": float(len(matched) / v131_executed),
            "strict_same_anchor_matched": int(len(strict)),
            "strict_same_anchor_coverage_of_v131_executed": float(len(strict) / v131_executed),
            "roll_repair_trades": int(len(roll)),
            "newly_roll_repaired_trades": int(len(matched) - int(v36_summary["coverage"]["bbo_mbp_matched"])),
        },
        "bbo_bidask_metrics": bbo_metrics,
        "stress_reference": stress_ref,
        "alignment": alignment,
        "split": split_block(repaired, total_by_split),
        "gate": gate,
        "roll_repair_audit": {
            "audited_rows": len(audit),
            "roll_repaired_rows": int(len(roll)),
            "unmatched_after_repair": int(v131_executed - len(matched)),
        },
        "decision": "promote_roll_aware_execution_candidate" if gate["passed"] else "keep_v1_31_until_clean_quote_coverage_reaches_gate",
    }


def write_report(summary: dict[str, Any]) -> None:
    lines = [
        "# HFCD Trading V1.37 Gold Roll-Aware Clean Quote Repair",
        "",
        "## Purpose",
        "Repair the remaining clean quote gap caused by non-executable near-roll GC contracts. This does not tune signals, Q exits, trailing, thresholds, or position sizing.",
        "",
        "## Result",
        f"- Status: `{summary['status']}`",
        f"- Roll-aware coverage: {summary['coverage']['roll_aware_matched']}/{summary['coverage']['v131_executed']} = {summary['coverage']['roll_aware_coverage_of_v131_executed']:.2%}",
        f"- Strict same-anchor coverage: {summary['coverage']['strict_same_anchor_matched']}/{summary['coverage']['v131_executed']} = {summary['coverage']['strict_same_anchor_coverage_of_v131_executed']:.2%}",
        f"- Roll repaired trades: {summary['coverage']['roll_repair_trades']}",
        f"- BBO bid/ask net PnL: ${summary['bbo_bidask_metrics']['net_pnl_usd']:.2f}",
        f"- BBO bid/ask PF: {summary['bbo_bidask_metrics']['profit_factor']:.3f}",
        f"- 2x fee + 1bps/side stress net: ${summary['stress_reference']['net_pnl_usd']:.2f}",
        f"- Correlation vs V1.31 anchor: {summary['alignment']['pnl_corr_vs_v131_anchor']:.3f}",
        f"- Sign match vs V1.31 anchor: {summary['alignment']['sign_match_vs_v131_anchor']:.2%}",
        "",
        "## Interpretation",
        "The repaired quotes are real clean bid/ask quotes from the nearest active adjacent GC contract. They are reported separately from strict same-contract coverage because this is an execution-route repair, not an original-contract quote fill.",
        "",
        "## Gate",
        f"- Passed: `{summary['gate']['passed']}`",
        f"- Decision: `{summary['decision']}`",
    ]
    (OUT_DIR / "HFCD_Trading_V1_37_GoldRollAwareCleanQuoteRepair.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_plot(summary: dict[str, Any], repaired: pd.DataFrame) -> None:
    matched = repaired[repaired["bbo_mbp_matched"]].copy()
    vals = matched["bbo_bidask_pnl_usd"].astype(float).tolist()
    fig, axes = plt.subplots(2, 2, figsize=(12, 8))
    axes[0, 0].bar(["V1.36", "V1.37 roll-aware"], [summary["coverage"]["v36_matched"], summary["coverage"]["roll_aware_matched"]])
    axes[0, 0].axhline(0.8 * summary["coverage"]["v131_executed"], color="red", linestyle="--", label="80% gate")
    axes[0, 0].set_title("Clean quote coverage")
    axes[0, 0].legend()
    axes[0, 1].bar(["net", "stress"], [summary["bbo_bidask_metrics"]["net_pnl_usd"], summary["stress_reference"]["net_pnl_usd"]])
    axes[0, 1].set_title("BBO bid/ask economics")
    axes[1, 0].plot(np.cumsum(vals) if vals else [])
    axes[1, 0].set_title("Cumulative BBO PnL")
    repaired.groupby("split")["bbo_mbp_matched"].mean().plot(kind="bar", ax=axes[1, 1])
    axes[1, 1].set_title("Coverage by split")
    fig.tight_layout()
    fig.savefig(OUT_DIR / "HFCD_Trading_V1_37_GoldRollAwareCleanQuoteRepair.png", dpi=160)
    plt.close(fig)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    v36_replay = pd.read_csv(V36_OUT_DIR / "hfcd_trading_v1_36_clean_quote_replay.csv")
    with (V36_OUT_DIR / "hfcd_trading_v1_36_summary.json").open("r", encoding="utf-8") as f:
        v36_summary = json.load(f)

    repaired, audit, store = repair(v36_replay)
    stress = build_stress(repaired, total_signals=int(v36_summary["coverage"]["total_signals"]))
    summary = build_summary(v36_summary, repaired, stress, audit)

    write_csv(OUT_DIR / "hfcd_trading_v1_37_roll_aware_replay.csv", repaired)
    write_csv(OUT_DIR / "hfcd_trading_v1_37_roll_repair_audit.csv", pd.DataFrame(audit))
    write_csv(OUT_DIR / "hfcd_trading_v1_37_fetch_log.csv", pd.DataFrame(store.fetch_log))
    write_csv(OUT_DIR / "hfcd_trading_v1_37_cost_stress_matrix.csv", stress)
    pd.DataFrame([summary]).to_csv(OUT_DIR / "hfcd_trading_v1_37_summary.csv", index=False)
    (OUT_DIR / "hfcd_trading_v1_37_summary.json").write_text(json.dumps(clean_json(summary), ensure_ascii=False, indent=2), encoding="utf-8")
    write_report(summary)
    write_plot(summary, repaired)

    print(json.dumps(clean_json(summary), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
