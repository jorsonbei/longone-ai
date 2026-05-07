#!/usr/bin/env python3
"""HFCD Trading V2.17: ETH-specific property blind test.

V2.15 proved that BTC can benefit from a 10D crypto property gate, while ETH
regressed when it reused the same gate family. V2.17 isolates ETHUSDT and tests
ETH-specific property and maker-cost overlays against the frozen V2.11 ETH 2h
entry set.

This is local research only. It does not modify V2.13/V2.16 forward ledgers,
online pages, account keys, or real orders.
"""

from __future__ import annotations

import csv
import importlib.util
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd


VERSION = "HFCD_Trading_V2_17_ETHSpecificPropertyBlind"
ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v2_17_eth_specific_property_blind"
V15_PATH = ROOT / "scripts" / "hfcd_trading_v2_15_crypto_property_darkforest_historical_blind.py"

SYMBOL = "ETHUSDT"
NOTIONAL_USD = 1000.0
BASELINE_ROUNDTRIP_COST = 0.0012
MAKER_ROUNDTRIP_COST = 0.0004

# User-proposed ETH-specific vector normalized from:
# Q 9, DeltaSigma 13, C 11, Pi 17, Sigma 15, Eta 12, BSigma 11, R 9,
# Tau 2, Omega 12. The provided raw weights sum to 111, so normalize here.
ETH_WEIGHTS = {
    "Q": 9 / 111,
    "DeltaSigma": 13 / 111,
    "C": 11 / 111,
    "Pi": 17 / 111,
    "Sigma": 15 / 111,
    "EtaHealth": 12 / 111,
    "BSigmaHealth": 11 / 111,
    "RHealth": 9 / 111,
    "Tau": 2 / 111,
    "Omega": 12 / 111,
}

STRATEGIES = [
    "baseline",
    "eth_relaxed_property",
    "eth_beta_property",
    "eth_maker_cost",
    "eth_maker_property_combo",
]


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load module: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def number(value: Any, digits: int = 6) -> float:
    try:
        out = float(value)
        if not math.isfinite(out):
            return 0.0
        return round(out, digits)
    except Exception:
        return 0.0


def clamp(value: Any, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, number(value, 12)))


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def rolling_rank(series: pd.Series) -> pd.Series:
    valid = series.dropna()
    if valid.empty:
        return pd.Series([0.5] * len(series), index=series.index)
    return series.rank(pct=True).fillna(0.5)


def load_eth_base(v15: Any) -> tuple[pd.DataFrame, dict[str, Any]]:
    enriched, coverage = v15.load_sensor_enriched_trades()
    eth = enriched[enriched["symbol"] == SYMBOL].copy().reset_index(drop=True)
    total = len(eth) or 1
    eth_cov: dict[str, Any] = {"trades": len(eth)}
    for key, value in coverage.items():
        if key == "trades":
            continue
        if key == "liquidation_history":
            eth_cov[key] = value
        else:
            # V2.15 coverage was full-dataset level. Recount for ETH where possible.
            column_map = {
                "funding_rate": "funding_funding_rate",
                "open_interest": "oi_open_interest",
                "long_short_ratio": "lsr_long_short_ratio",
                "metrics_oi": "metrics_sum_open_interest",
                "l2_book_depth": "book_liquidity_cavity_0p2_usd",
                "stablecoin": "stable_supply_usd",
            }
            col = column_map.get(key)
            eth_cov[key] = int(eth[col].notna().sum()) if col in eth else int(value)
    return eth, eth_cov


def add_eth_vectors(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    out["depth_0p2_usd"] = out.get("book_ask_0p2_notional", 0).fillna(0) + out.get("book_bid_0p2_notional", 0).fillna(0)
    out["depth_1p0_usd"] = out.get("book_ask_1p0_notional", 0).fillna(0) + out.get("book_bid_1p0_notional", 0).fillna(0)
    out["depth_rank"] = rolling_rank(out["depth_0p2_usd"])
    out["funding_abs"] = out.get("funding_funding_rate", pd.Series(0, index=out.index)).abs().fillna(0)
    out["funding_rank"] = rolling_rank(out["funding_abs"])
    out["oi_base"] = out.get("metrics_sum_open_interest", out.get("oi_open_interest", pd.Series(0, index=out.index))).fillna(0)
    out["oi_change_entry"] = out["oi_base"].pct_change().fillna(0).clip(-0.10, 0.10)
    out["lsr_base"] = out.get("metrics_count_long_short_ratio", out.get("lsr_long_short_ratio", pd.Series(1, index=out.index))).fillna(1)
    out["top_lsr_base"] = out.get("metrics_count_toptrader_long_short_ratio", pd.Series(1, index=out.index)).fillna(1)
    out["taker_lsr"] = out.get("metrics_sum_taker_long_short_vol_ratio", pd.Series(1, index=out.index)).fillna(1)
    out["lsr_pressure"] = ((out["lsr_base"] - 1).abs() + (out["top_lsr_base"] - 1).abs()).clip(0, 2)
    out["taker_alignment"] = (1 - (out["taker_lsr"] - 1).abs().clip(0, 1)).fillna(0.5)
    out["stable_change_rank"] = rolling_rank(out.get("stable_change_7d_usd", pd.Series(0, index=out.index)).fillna(0))
    out["imbalance_abs"] = out.get("book_depth_imbalance_0p2", pd.Series(0, index=out.index)).abs().fillna(0).clip(0, 1)

    vectors: list[dict[str, float]] = []
    scores: list[float] = []
    fill_quality: list[float] = []
    for _, row in out.iterrows():
        baseline_score = number(row["score"])
        q_core = number(row["q_core"])
        base_c = number(row["liquidity_cavity"])
        stable = number(row["stable_score"])
        depth_rank = number(row["depth_rank"])
        funding_rank = number(row["funding_rank"])
        oi_change = number(row["oi_change_entry"])
        imbalance = number(row["imbalance_abs"])
        lsr_pressure = number(row["lsr_pressure"])
        taker_alignment = number(row["taker_alignment"])

        c = clamp(base_c * 0.34 + depth_rank * 0.46 + (1 - imbalance) * 0.20)
        pi = clamp(baseline_score * 0.46 + q_core * 0.18 + c * 0.16 + taker_alignment * 0.20)
        q = clamp(q_core * 0.50 + baseline_score * 0.30 + stable * 0.20)
        delta_sigma = clamp(baseline_score * 0.38 + stable * 0.28 + (1 - funding_rank) * 0.12 + taker_alignment * 0.22)
        sigma = clamp(stable * 0.34 + number(row["stable_change_rank"]) * 0.20 + clamp(0.5 + oi_change * 4.5) * 0.24 + taker_alignment * 0.22)
        eta = clamp(number(row["b_sigma"]) * 0.30 + funding_rank * 0.20 + imbalance * 0.22 + lsr_pressure * 0.18 + (1 - taker_alignment) * 0.10)
        b_sigma = clamp(number(row["b_sigma"]) * 0.50 + funding_rank * 0.18 + lsr_pressure * 0.18 + imbalance * 0.14)
        r = clamp(funding_rank * 0.24 + abs(oi_change) * 3.2 * 0.34 + lsr_pressure * 0.24 + (1 - taker_alignment) * 0.18)
        tau = clamp(1 - funding_rank * 0.55 - abs(number(row.get("funding_funding_rate", 0))) * 1100)
        omega = clamp(0.42 + (baseline_score - 0.66) * 1.4 + taker_alignment * 0.18 + stable * 0.12)
        vec = {
            "Q": q,
            "DeltaSigma": delta_sigma,
            "C": c,
            "Pi": pi,
            "Sigma": sigma,
            "Eta": eta,
            "BSigma": b_sigma,
            "R": r,
            "Tau": tau,
            "Omega": omega,
        }
        score = (
            ETH_WEIGHTS["Q"] * q
            + ETH_WEIGHTS["DeltaSigma"] * delta_sigma
            + ETH_WEIGHTS["C"] * c
            + ETH_WEIGHTS["Pi"] * pi
            + ETH_WEIGHTS["Sigma"] * sigma
            + ETH_WEIGHTS["EtaHealth"] * (1 - eta)
            + ETH_WEIGHTS["BSigmaHealth"] * (1 - b_sigma)
            + ETH_WEIGHTS["RHealth"] * (1 - r)
            + ETH_WEIGHTS["Tau"] * tau
            + ETH_WEIGHTS["Omega"] * omega
        )
        vectors.append(vec)
        scores.append(score)
        fill_quality.append(clamp(c * 0.50 + depth_rank * 0.22 + (1 - imbalance) * 0.18 + taker_alignment * 0.10))

    for key in ["Q", "DeltaSigma", "C", "Pi", "Sigma", "Eta", "BSigma", "R", "Tau", "Omega"]:
        out[key] = [number(vec[key]) for vec in vectors]
    out["eth_property_fusion_score"] = [number(score) for score in scores]
    out["eth_maker_fill_quality"] = [number(x) for x in fill_quality]
    return out


def add_strategy_flags(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    out["baseline_open"] = True
    out["eth_relaxed_property_open"] = (
        (out["eth_property_fusion_score"] >= 0.62)
        & (out["Q"] >= (out["min_q"] - 0.03))
        & (out["C"] >= (out["min_cavity"] - 0.04))
        & (out["DeltaSigma"] >= 0.48)
        & (out["Pi"] >= 0.58)
        & (out["BSigma"] <= (out["max_bsigma"] + 0.05))
        & (out["R"] <= 0.92)
    )
    out["eth_beta_property_open"] = (
        (out["eth_property_fusion_score"] >= 0.66)
        & (out["Pi"] >= 0.62)
        & (out["Omega"] >= 0.48)
        & (out["C"] >= 0.34)
        & (out["BSigma"] <= 0.82)
        & (out["R"] <= 0.95)
    )
    out["eth_maker_cost_open"] = out["baseline_open"] & (out["eth_maker_fill_quality"] >= 0.46) & (out["C"] >= 0.34)
    out["eth_maker_property_combo_open"] = (
        out["eth_maker_cost_open"]
        & (out["eth_property_fusion_score"] >= 0.61)
        & (out["Pi"] >= 0.56)
        & (out["BSigma"] <= 0.86)
    )
    return out


def shadow_rows(df: pd.DataFrame) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for _, row in df.iterrows():
        for strategy in STRATEGIES:
            open_col = f"{strategy}_open"
            opened = bool(row[open_col])
            if opened:
                cost = MAKER_ROUNDTRIP_COST if "maker" in strategy else BASELINE_ROUNDTRIP_COST
                net_return = number(row["gross_return"] - cost, 8)
                pnl = number(net_return * NOTIONAL_USD, 6)
                reason = f"{strategy}_pass"
                exit_reason = row["exit_reason"]
            else:
                cost = 0.0
                net_return = 0.0
                pnl = 0.0
                reason = f"{strategy}_gate_failed"
                exit_reason = "not_executed"
            rows.append({
                "split": row["split"],
                "symbol": row["symbol"],
                "strategy": strategy,
                "executed": opened,
                "reason": reason,
                "policy_name": row["policy_name"],
                "entry_ts": row["entry_ts"],
                "exit_ts": row["exit_ts"],
                "entry_price": row["entry_price"],
                "exit_price": row["exit_price"],
                "gross_return": number(row["gross_return"], 8),
                "roundtrip_cost": cost,
                "net_return": net_return,
                "pnl_usd": pnl,
                "exit_reason": exit_reason,
                "baseline_score": row["score"],
                "eth_property_fusion_score": row["eth_property_fusion_score"],
                "eth_maker_fill_quality": row["eth_maker_fill_quality"],
                "Q": row["Q"],
                "DeltaSigma": row["DeltaSigma"],
                "C": row["C"],
                "Pi": row["Pi"],
                "Sigma": row["Sigma"],
                "Eta": row["Eta"],
                "BSigma": row["BSigma"],
                "R": row["R"],
                "Tau": row["Tau"],
                "Omega": row["Omega"],
            })
    return rows


def metrics(rows: list[dict[str, Any]]) -> dict[str, Any]:
    executed = [row for row in rows if row["executed"]]
    pnls = [float(row["pnl_usd"]) for row in executed]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]
    gross_win = sum(wins)
    gross_loss = abs(sum(losses))
    equity = 0.0
    peak = 0.0
    max_dd = 0.0
    for pnl in pnls:
        equity += pnl
        peak = max(peak, equity)
        max_dd = min(max_dd, equity - peak)
    return {
        "candidate_rows": len(rows),
        "trades": len(executed),
        "skipped": len(rows) - len(executed),
        "win_rate": number(len(wins) / len(executed) if executed else 0),
        "net_pnl_usd": number(sum(pnls), 4),
        "gross_profit_usd": number(gross_win, 4),
        "gross_loss_usd": number(gross_loss, 4),
        "profit_factor": number(gross_win / gross_loss if gross_loss else (999.0 if gross_win else 0.0)),
        "max_drawdown_usd": number(max_dd, 4),
        "avg_pnl_usd": number(sum(pnls) / len(executed) if executed else 0),
    }


def summarize(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for split in ["train", "validation", "test", "all"]:
        for strategy in STRATEGIES:
            subset = [r for r in rows if r["strategy"] == strategy]
            if split != "all":
                subset = [r for r in subset if r["split"] == split]
            out.append({"symbol": SYMBOL, "split": split, "strategy": strategy, **metrics(subset)})
    return out


def compare(summary_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    base = {row["split"]: row for row in summary_rows if row["strategy"] == "baseline"}
    rows: list[dict[str, Any]] = []
    for row in summary_rows:
        if row["strategy"] == "baseline":
            continue
        b = base[row["split"]]
        rows.append({
            "symbol": SYMBOL,
            "split": row["split"],
            "strategy": row["strategy"],
            "baseline_trades": b["trades"],
            "variant_trades": row["trades"],
            "trade_delta": row["trades"] - b["trades"],
            "baseline_net_pnl_usd": b["net_pnl_usd"],
            "variant_net_pnl_usd": row["net_pnl_usd"],
            "pnl_delta_usd": number(row["net_pnl_usd"] - b["net_pnl_usd"], 4),
            "baseline_profit_factor": b["profit_factor"],
            "variant_profit_factor": row["profit_factor"],
            "pf_delta": number(row["profit_factor"] - b["profit_factor"], 4),
            "baseline_max_drawdown_usd": b["max_drawdown_usd"],
            "variant_max_drawdown_usd": row["max_drawdown_usd"],
            "drawdown_delta_usd": number(row["max_drawdown_usd"] - b["max_drawdown_usd"], 4),
            "decision": (
                "improved"
                if row["trades"] >= 5
                and row["net_pnl_usd"] >= b["net_pnl_usd"]
                and row["profit_factor"] >= b["profit_factor"]
                else "not_promoted"
            ),
        })
    return rows


def coverage_rows(coverage: dict[str, Any]) -> list[dict[str, Any]]:
    total = coverage["trades"] or 1
    rows: list[dict[str, Any]] = []
    for key, value in coverage.items():
        if key == "trades":
            continue
        if key == "liquidation_history":
            rows.append({
                "sensor": key,
                "covered_rows": int(value.get("rows", 0)),
                "total_trades": total,
                "coverage_rate": 1.0 if value.get("ready") else 0.0,
                "status": "ready" if value.get("ready") else "coverage_insufficient",
                "notes": value.get("source", ""),
            })
        else:
            rows.append({
                "sensor": key,
                "covered_rows": int(value),
                "total_trades": total,
                "coverage_rate": number(int(value) / total),
                "status": "ready" if int(value) == total else "partial",
                "notes": "",
            })
    rows.extend([
        {
            "sensor": "eth_btc_relative_strength",
            "covered_rows": total,
            "total_trades": total,
            "coverage_rate": 1.0,
            "status": "inherited_proxy",
            "notes": "V2.11 ETH head already uses ETH/BTC relative score; V2.17 Omega uses this frozen score proxy.",
        },
        {
            "sensor": "staked_eth_flow_7d",
            "covered_rows": 0,
            "total_trades": total,
            "coverage_rate": 0.0,
            "status": "missing_real_history",
            "notes": "Not present locally; not marked integrated.",
        },
        {
            "sensor": "defi_tvl_change_24h",
            "covered_rows": 0,
            "total_trades": total,
            "coverage_rate": 0.0,
            "status": "missing_real_history",
            "notes": "Not present locally; not marked integrated.",
        },
    ])
    return rows


def select_decision(summary_rows: list[dict[str, Any]], coverage: dict[str, Any]) -> dict[str, Any]:
    validation = {row["strategy"]: row for row in summary_rows if row["split"] == "validation"}
    test = {row["strategy"]: row for row in summary_rows if row["split"] == "test"}
    baseline_v = validation["baseline"]
    baseline_t = test["baseline"]
    candidates = [
        row for name, row in validation.items()
        if name != "baseline"
        and row["trades"] >= 5
        and row["net_pnl_usd"] >= baseline_v["net_pnl_usd"]
        and row["profit_factor"] >= baseline_v["profit_factor"]
    ]
    selected = max(candidates, key=lambda r: (r["net_pnl_usd"], r["profit_factor"]), default=baseline_v)
    selected_test = test[selected["strategy"]]
    promoted = (
        selected["strategy"] != "baseline"
        and selected_test["trades"] >= 5
        and selected_test["net_pnl_usd"] >= baseline_t["net_pnl_usd"]
        and selected_test["profit_factor"] >= baseline_t["profit_factor"]
    )
    return {
        "status": "eth_specific_blind_completed",
        "promote_eth_property_variant": promoted,
        "selected_by_validation": selected["strategy"],
        "validation_selection_reason": "selected_only_if_validation_pnl_and_pf_improved_with_min5_trades",
        "test_result_for_selected": selected_test,
        "baseline_test": baseline_t,
        "liquidation_event_status": "coverage_insufficient" if not coverage["liquidation_history"].get("ready") else "ready",
        "next_step": (
            "Promote selected ETH variant into forward shadow only if test also improves; otherwise keep V2.13 ETH baseline."
            if promoted
            else "Keep ETH on V2.13 baseline; do not apply BTC property gate to ETH."
        ),
    }


def vector_rows(df: pd.DataFrame) -> list[dict[str, Any]]:
    cols = [
        "split", "symbol", "policy_name", "entry_ts", "exit_ts", "score",
        "eth_property_fusion_score", "eth_maker_fill_quality", "Q", "DeltaSigma",
        "C", "Pi", "Sigma", "Eta", "BSigma", "R", "Tau", "Omega",
        "funding_funding_rate", "metrics_sum_open_interest", "lsr_long_short_ratio",
        "metrics_sum_taker_long_short_vol_ratio", "book_liquidity_cavity_0p2_usd",
        "book_depth_imbalance_0p2", "stable_change_7d_usd",
    ]
    return [{col: row.get(col, "") for col in cols} for row in df.to_dict("records")]


def render_report(summary: dict[str, Any], summary_rows: list[dict[str, Any]]) -> str:
    lines = [
        f"# {VERSION}",
        "",
        "## 结论",
        "",
        "- V2.17 只重测 ETHUSDT，不改变 BTC/V2.13/V2.16 前向账本。",
        "- 目标是验证 ETH 是否需要独立 10维物性权重，而不是套 BTC 的物性门。",
        "- 已吸收 ETH 专属权重思路，并把 raw 权重归一化；ETH/BTC 相对强度使用 V2.11 `eth_beta_relative` 冻结分数代理。",
        "- staked ETH flow 与 DeFi TVL 本地没有真实历史表，本轮只做缺口审计，不伪造集成。",
        f"- 验证集选择策略：`{summary['decision']['selected_by_validation']}`。",
        f"- 是否晋升 ETH 物性变体：`{summary['decision']['promote_eth_property_variant']}`。",
        f"- 强平历史：`{summary['decision']['liquidation_event_status']}`。",
        "",
        "## Test Split",
        "",
        "| Strategy | Trades | Win | PnL | PF | DD |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for row in summary_rows:
        if row["split"] == "test":
            lines.append(
                f"| {row['strategy']} | {row['trades']} | {row['win_rate']:.2%} | "
                f"${row['net_pnl_usd']:.2f} | {row['profit_factor']:.3f} | ${row['max_drawdown_usd']:.2f} |"
            )
    lines.extend([
        "",
        "## 判断",
        "",
        "如果 ETH 专属变体不能在 validation 和 test 都改善 PnL/PF 且保持至少 5 笔交易，就不能替代 baseline。",
        "本轮继续把强平历史标记为 coverage insufficient；不能用空强平数据证明 liquidation_event 有效。",
    ])
    return "\n".join(lines) + "\n"


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    v15 = load_module("hfcd_v2_15_for_v17", V15_PATH)
    eth, coverage = load_eth_base(v15)
    eth = add_strategy_flags(add_eth_vectors(eth))
    trades = shadow_rows(eth)
    summary_rows = summarize(trades)
    compare_rows = compare(summary_rows)
    cov_rows = coverage_rows(coverage)
    decision = select_decision(summary_rows, coverage)

    write_csv(OUT_DIR / "hfcd_trading_v2_17_eth_property_vectors.csv", vector_rows(eth))
    write_csv(OUT_DIR / "hfcd_trading_v2_17_eth_shadow_trades.csv", trades)
    write_csv(OUT_DIR / "hfcd_trading_v2_17_eth_strategy_summary.csv", summary_rows)
    write_csv(OUT_DIR / "hfcd_trading_v2_17_eth_comparison.csv", compare_rows)
    write_csv(OUT_DIR / "hfcd_trading_v2_17_eth_sensor_coverage.csv", cov_rows)

    summary = {
        "version": VERSION,
        "created_at": now_iso(),
        "status": decision["status"],
        "no_online_page_change": True,
        "does_not_modify_forward_ledgers": True,
        "source_entry_set": str(v15.V211_DIR / "hfcd_trading_v2_11_selected_trades.csv"),
        "sensor_coverage": cov_rows,
        "decision": decision,
        "test_summary": [row for row in summary_rows if row["split"] == "test"],
        "files": {
            "property_vectors": str(OUT_DIR / "hfcd_trading_v2_17_eth_property_vectors.csv"),
            "shadow_trades": str(OUT_DIR / "hfcd_trading_v2_17_eth_shadow_trades.csv"),
            "strategy_summary": str(OUT_DIR / "hfcd_trading_v2_17_eth_strategy_summary.csv"),
            "comparison": str(OUT_DIR / "hfcd_trading_v2_17_eth_comparison.csv"),
            "coverage": str(OUT_DIR / "hfcd_trading_v2_17_eth_sensor_coverage.csv"),
            "summary": str(OUT_DIR / "hfcd_trading_v2_17_summary.json"),
            "report": str(OUT_DIR / "HFCD_Trading_V2_17_ETHSpecificPropertyBlind.md"),
        },
    }
    (OUT_DIR / "hfcd_trading_v2_17_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT_DIR / "HFCD_Trading_V2_17_ETHSpecificPropertyBlind.md").write_text(render_report(summary, summary_rows), encoding="utf-8")

    print(json.dumps({
        "version": VERSION,
        "status": decision["status"],
        "selected_by_validation": decision["selected_by_validation"],
        "promote_eth_property_variant": decision["promote_eth_property_variant"],
        "liquidation_event_status": decision["liquidation_event_status"],
        "output_dir": str(OUT_DIR),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
