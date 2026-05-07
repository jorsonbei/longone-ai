#!/usr/bin/env python3
"""HFCD Trading V2.15: Crypto Property + DarkForest historical blind test.

This script does not select new entry points. It replays the frozen V2.11
BTC/ETH selected trades and overlays three shadow variants:

1. baseline: unchanged V2.11 trade list and taker cost
2. property_vector: 10D property vector gate using historical sensors
3. maker_cost: baseline entry points filtered by historical L2 execution quality
4. liquidation_event: only evaluated if real historical liquidation coverage exists

It is local research only. It does not modify V2.13/V2.14 forward ledgers, online
pages, account keys, or real orders.
"""

from __future__ import annotations

import csv
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd


VERSION = "HFCD_Trading_V2_15_CryptoPropertyDarkForestHistoricalBlind"
ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v2_15_crypto_property_darkforest_historical_blind"
V211_DIR = ROOT / "outputs" / "hfcd_trading_v2_11_crypto_robust_selector_1h_2h"
V24_DIR = ROOT / "outputs" / "hfcd_trading_v2_4_crypto_true_sensor_history"
V27_DIR = ROOT / "outputs" / "hfcd_trading_v2_7_crypto_extended_l2_sensor_audit"

NOTIONAL_USD = 1000.0
BASELINE_ROUNDTRIP_COST = 0.0012
MAKER_ROUNDTRIP_COST = 0.0004
SYMBOLS = ["BTCUSDT", "ETHUSDT"]

PROPERTY_WEIGHTS = {
    "BTCUSDT": {
        "Q": 0.12,
        "DeltaSigma": 0.14,
        "C": 0.10,
        "Pi": 0.15,
        "Sigma": 0.16,
        "EtaHealth": 0.10,
        "BSigmaHealth": 0.10,
        "RHealth": 0.08,
        "Tau": 0.03,
        "Omega": 0.02,
    },
    "ETHUSDT": {
        "Q": 0.10,
        "DeltaSigma": 0.13,
        "C": 0.10,
        "Pi": 0.18,
        "Sigma": 0.15,
        "EtaHealth": 0.12,
        "BSigmaHealth": 0.10,
        "RHealth": 0.07,
        "Tau": 0.03,
        "Omega": 0.02,
    },
}


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


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


def sigmoid(x: float) -> float:
    try:
        return 1.0 / (1.0 + math.exp(-x))
    except OverflowError:
        return 0.0 if x < 0 else 1.0


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def as_ts(series: pd.Series) -> pd.Series:
    return pd.to_datetime(series, utc=True, errors="coerce")


def load_csv(path: Path) -> pd.DataFrame:
    if not path.exists():
        return pd.DataFrame()
    return pd.read_csv(path)


def prep_asof(df: pd.DataFrame, ts_col: str = "ts") -> pd.DataFrame:
    if df.empty:
        return df
    out = df.copy()
    out["timestamp"] = as_ts(out[ts_col])
    return out.dropna(subset=["timestamp"]).sort_values(["symbol", "timestamp"])


def add_sensor_prefix(df: pd.DataFrame, prefix: str, keep: list[str]) -> pd.DataFrame:
    if df.empty:
        return df
    cols = ["symbol", "timestamp", *[col for col in keep if col in df.columns]]
    out = df[cols].copy()
    rename = {col: f"{prefix}_{col}" for col in out.columns if col not in {"symbol", "timestamp"}}
    return out.rename(columns=rename)


def merge_asof_by_symbol(base: pd.DataFrame, sensor: pd.DataFrame) -> pd.DataFrame:
    if sensor.empty:
        return base
    chunks: list[pd.DataFrame] = []
    for symbol, chunk in base.groupby("symbol", sort=False):
        left = chunk.sort_values("entry_time").copy()
        right = sensor[sensor["symbol"] == symbol].sort_values("timestamp").copy()
        if right.empty:
            chunks.append(left)
            continue
        merged = pd.merge_asof(
            left,
            right,
            left_on="entry_time",
            right_on="timestamp",
            by="symbol",
            direction="backward",
        )
        chunks.append(merged.drop(columns=["timestamp"], errors="ignore"))
    return pd.concat(chunks, ignore_index=True)


def load_trade_base() -> pd.DataFrame:
    trades = pd.read_csv(V211_DIR / "hfcd_trading_v2_11_selected_trades.csv")
    selected = pd.read_csv(V211_DIR / "hfcd_trading_v2_11_selected.csv")
    keep_policy = selected[["symbol", "threshold", "min_q", "min_cavity", "max_bsigma", "stop_loss", "take_profit"]]
    trades = trades.merge(keep_policy, on="symbol", how="left", suffixes=("", "_policy"))
    trades["entry_time"] = as_ts(trades["entry_ts"])
    trades["exit_time"] = as_ts(trades["exit_ts"])
    return trades.sort_values(["symbol", "entry_time"]).reset_index(drop=True)


def load_sensor_enriched_trades() -> tuple[pd.DataFrame, dict[str, Any]]:
    base = load_trade_base()

    funding = add_sensor_prefix(
        prep_asof(load_csv(V24_DIR / "hfcd_trading_v2_4_funding_history.csv")),
        "funding",
        ["funding_rate"],
    )
    oi = add_sensor_prefix(
        prep_asof(load_csv(V24_DIR / "hfcd_trading_v2_4_open_interest_history.csv")),
        "oi",
        ["open_interest", "open_interest_value_usd"],
    )
    lsr = add_sensor_prefix(
        prep_asof(load_csv(V24_DIR / "hfcd_trading_v2_4_long_short_ratio_history.csv")),
        "lsr",
        ["long_short_ratio", "long_account", "short_account"],
    )
    metrics = add_sensor_prefix(
        prep_asof(load_csv(V27_DIR / "hfcd_trading_v2_7_metrics_5m.csv")),
        "metrics",
        [
            "count_long_short_ratio",
            "count_toptrader_long_short_ratio",
            "sum_open_interest",
            "sum_open_interest_value",
            "sum_taker_long_short_vol_ratio",
            "sum_toptrader_long_short_ratio",
        ],
    )
    book = add_sensor_prefix(
        prep_asof(load_csv(V27_DIR / "hfcd_trading_v2_7_book_depth_5m.csv")),
        "book",
        [
            "ask_0p2_notional",
            "bid_0p2_notional",
            "ask_1p0_notional",
            "bid_1p0_notional",
            "depth_imbalance_0p2",
            "depth_imbalance_1p0",
            "liquidity_cavity_0p2_usd",
            "liquidity_cavity_1p0_usd",
        ],
    )
    stable = load_csv(V27_DIR / "hfcd_trading_v2_7_stablecoin_supply_history.csv")
    if not stable.empty:
        stable["entry_date"] = pd.to_datetime(stable["date"], errors="coerce").dt.date
        stable_daily = stable.groupby("entry_date", as_index=False).agg(
            stable_supply_usd=("supply_usd", "sum"),
            stable_change_1d_usd=("supply_change_1d_usd", "sum"),
            stable_change_7d_usd=("supply_change_7d_usd", "sum"),
        )
    else:
        stable_daily = pd.DataFrame()

    out = base
    for sensor in [funding, oi, lsr, metrics, book]:
        out = merge_asof_by_symbol(out, sensor)
    out["entry_date"] = out["entry_time"].dt.date
    if not stable_daily.empty:
        out = out.merge(stable_daily, on="entry_date", how="left")

    liq = load_csv(V24_DIR / "hfcd_trading_v2_4_liquidation_history.csv")
    liq_coverage = {
        "rows": int(len(liq)),
        "ready": bool(len(liq) > 0),
        "source": str(V24_DIR / "hfcd_trading_v2_4_liquidation_history.csv"),
    }
    coverage = {
        "trades": int(len(out)),
        "funding_rate": int(out["funding_funding_rate"].notna().sum()) if "funding_funding_rate" in out else 0,
        "open_interest": int(out["oi_open_interest"].notna().sum()) if "oi_open_interest" in out else 0,
        "long_short_ratio": int(out["lsr_long_short_ratio"].notna().sum()) if "lsr_long_short_ratio" in out else 0,
        "metrics_oi": int(out["metrics_sum_open_interest"].notna().sum()) if "metrics_sum_open_interest" in out else 0,
        "l2_book_depth": int(out["book_liquidity_cavity_0p2_usd"].notna().sum()) if "book_liquidity_cavity_0p2_usd" in out else 0,
        "stablecoin": int(out["stable_supply_usd"].notna().sum()) if "stable_supply_usd" in out else 0,
        "liquidation_history": liq_coverage,
    }
    return out, coverage


def rolling_rank(series: pd.Series) -> pd.Series:
    valid = series.dropna()
    if valid.empty:
        return pd.Series([0.5] * len(series), index=series.index)
    return series.rank(pct=True).fillna(0.5)


def add_property_vectors(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    out["depth_0p2_usd"] = out.get("book_ask_0p2_notional", 0).fillna(0) + out.get("book_bid_0p2_notional", 0).fillna(0)
    out["depth_1p0_usd"] = out.get("book_ask_1p0_notional", 0).fillna(0) + out.get("book_bid_1p0_notional", 0).fillna(0)
    out["depth_rank"] = out.groupby("symbol")["depth_0p2_usd"].transform(rolling_rank)
    out["funding_abs"] = out.get("funding_funding_rate", pd.Series(0, index=out.index)).abs().fillna(0)
    out["funding_rank"] = out.groupby("symbol")["funding_abs"].transform(rolling_rank)
    out["oi_base"] = out.get("metrics_sum_open_interest", out.get("oi_open_interest", pd.Series(0, index=out.index))).fillna(0)
    out["oi_change_entry"] = out.groupby("symbol")["oi_base"].pct_change().fillna(0).clip(-0.08, 0.08)
    out["lsr_base"] = out.get("metrics_count_long_short_ratio", out.get("lsr_long_short_ratio", pd.Series(1, index=out.index))).fillna(1)
    out["top_lsr_base"] = out.get("metrics_count_toptrader_long_short_ratio", pd.Series(1, index=out.index)).fillna(1)
    out["lsr_pressure"] = ((out["lsr_base"] - 1).abs() + (out["top_lsr_base"] - 1).abs()).clip(0, 2)
    out["stable_change_rank"] = rolling_rank(out.get("stable_change_7d_usd", pd.Series(0, index=out.index)).fillna(0))
    out["imbalance_abs"] = out.get("book_depth_imbalance_0p2", pd.Series(0, index=out.index)).abs().fillna(0).clip(0, 1)

    vectors: list[dict[str, float]] = []
    scores: list[float] = []
    for _, row in out.iterrows():
        symbol = str(row["symbol"])
        baseline_score = number(row["score"])
        q = clamp(row["q_core"])
        c = clamp(number(row["liquidity_cavity"]) * 0.45 + number(row["depth_rank"]) * 0.55)
        delta_sigma = clamp(number(row["stable_score"]) * 0.45 + baseline_score * 0.35 + (1 - number(row["funding_rank"])) * 0.20)
        pi = clamp(baseline_score * 0.55 + number(row["q_core"]) * 0.20 + number(row["liquidity_cavity"]) * 0.25)
        sigma = clamp(number(row["stable_score"]) * 0.45 + number(row["stable_change_rank"]) * 0.25 + clamp(0.5 + number(row["oi_change_entry"]) * 5) * 0.20 + (1 - number(row["imbalance_abs"])) * 0.10)
        # Entry-time noise proxy only. Do not use gross_return/exit data here.
        eta = clamp(
            number(row["b_sigma"]) * 0.35
            + number(row["funding_rank"]) * 0.20
            + number(row["imbalance_abs"]) * 0.25
            + number(row["lsr_pressure"]) * 0.20
        )
        b_sigma = clamp(number(row["b_sigma"]) * 0.55 + number(row["funding_rank"]) * 0.20 + number(row["lsr_pressure"]) * 0.15 + number(row["imbalance_abs"]) * 0.10)
        r = clamp(number(row["funding_rank"]) * 0.30 + abs(number(row["oi_change_entry"])) * 3.0 * 0.35 + number(row["lsr_pressure"]) * 0.35)
        tau = clamp(1 - number(row["funding_rank"]) * 0.65 - abs(number(row["funding_funding_rate"])) * 1500)
        omega = 0.55 if symbol == "BTCUSDT" else clamp(0.45 + (number(row["score"]) - 0.66) * 1.8)
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
        w = PROPERTY_WEIGHTS[symbol]
        score = (
            w["Q"] * vec["Q"]
            + w["DeltaSigma"] * vec["DeltaSigma"]
            + w["C"] * vec["C"]
            + w["Pi"] * vec["Pi"]
            + w["Sigma"] * vec["Sigma"]
            + w["EtaHealth"] * (1 - vec["Eta"])
            + w["BSigmaHealth"] * (1 - vec["BSigma"])
            + w["RHealth"] * (1 - vec["R"])
            + w["Tau"] * vec["Tau"]
            + w["Omega"] * vec["Omega"]
        )
        vectors.append(vec)
        scores.append(score)
    for key in ["Q", "DeltaSigma", "C", "Pi", "Sigma", "Eta", "BSigma", "R", "Tau", "Omega"]:
        out[key] = [number(vec[key]) for vec in vectors]
    out["property_fusion_score"] = [number(score) for score in scores]
    return out


def sensor_rows(df: pd.DataFrame, coverage: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    liquidation_ready = bool(coverage["liquidation_history"]["ready"])
    for _, row in df.iterrows():
        rows.append({
            "split": row["split"],
            "symbol": row["symbol"],
            "entry_ts": row["entry_ts"],
            "funding_rate": number(row.get("funding_funding_rate", 0), 10),
            "funding_extreme_rank": number(row.get("funding_rank", 0)),
            "open_interest": number(row.get("metrics_sum_open_interest", row.get("oi_open_interest", 0))),
            "oi_change_entry": number(row.get("oi_change_entry", 0)),
            "long_short_ratio": number(row.get("lsr_base", 1)),
            "top_long_short_ratio": number(row.get("top_lsr_base", 1)),
            "long_short_pressure": number(row.get("lsr_pressure", 0)),
            "taker_long_short_vol_ratio": number(row.get("metrics_sum_taker_long_short_vol_ratio", 1)),
            "depth_0p2_usd": number(row.get("depth_0p2_usd", 0)),
            "depth_1p0_usd": number(row.get("depth_1p0_usd", 0)),
            "depth_rank": number(row.get("depth_rank", 0)),
            "depth_imbalance_0p2": number(row.get("book_depth_imbalance_0p2", 0)),
            "stable_supply_usd": number(row.get("stable_supply_usd", 0)),
            "stable_change_1d_usd": number(row.get("stable_change_1d_usd", 0)),
            "stable_change_7d_usd": number(row.get("stable_change_7d_usd", 0)),
            "liquidation_history_ready": liquidation_ready,
            "liquidation_lookback_notional_usd": 0.0,
            "liquidation_status": "ready" if liquidation_ready else "coverage_insufficient",
        })
    return rows


def add_shadow_flags(df: pd.DataFrame, coverage: dict[str, Any]) -> pd.DataFrame:
    out = df.copy()
    out["baseline_open"] = True
    out["property_vector_open"] = (
        (out["property_fusion_score"] >= 0.66)
        & (out["DeltaSigma"] >= 0.52)
        & (out["Q"] >= out["min_q"])
        & (out["C"] >= out["min_cavity"])
        & (out["BSigma"] <= out["max_bsigma"])
        & (out["R"] <= 0.85)
    )
    fill_quality = (
        out["C"] * 0.55
        + (1 - out["imbalance_abs"]) * 0.25
        + out["depth_rank"] * 0.20
    ).clip(0, 1)
    out["maker_fill_quality"] = fill_quality
    out["maker_cost_open"] = out["baseline_open"] & (fill_quality >= 0.58) & (out["C"] >= out["min_cavity"])
    out["liquidation_event_open"] = False
    out["liquidation_coverage_ready"] = bool(coverage["liquidation_history"]["ready"])
    return out


def variant_rows(df: pd.DataFrame, coverage: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for _, row in df.iterrows():
        for variant in ["baseline", "property_vector", "maker_cost", "liquidation_event"]:
            open_col = {
                "baseline": "baseline_open",
                "property_vector": "property_vector_open",
                "maker_cost": "maker_cost_open",
                "liquidation_event": "liquidation_event_open",
            }[variant]
            opened = bool(row[open_col])
            if variant == "liquidation_event" and not coverage["liquidation_history"]["ready"]:
                reason = "coverage_insufficient_liquidation_history"
            elif opened:
                reason = f"{variant}_pass"
            else:
                reason = f"{variant}_gate_failed"

            if not opened:
                pnl = 0.0
                net_return = 0.0
                executed = False
                cost = 0.0
            else:
                cost = MAKER_ROUNDTRIP_COST if variant == "maker_cost" else BASELINE_ROUNDTRIP_COST
                net_return = number(row["gross_return"] - cost, 8)
                pnl = number(net_return * NOTIONAL_USD, 6)
                executed = True
            rows.append({
                "split": row["split"],
                "symbol": row["symbol"],
                "strategy": variant,
                "executed": executed,
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
                "exit_reason": row["exit_reason"] if executed else "not_executed",
                "baseline_score": row["score"],
                "property_fusion_score": row["property_fusion_score"],
                "maker_fill_quality": number(row["maker_fill_quality"]),
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
    dd = 0.0
    for pnl in pnls:
        equity += pnl
        peak = max(peak, equity)
        dd = min(dd, equity - peak)
    return {
        "candidate_rows": len(rows),
        "trades": len(executed),
        "skipped": len(rows) - len(executed),
        "win_rate": number(len(wins) / len(executed) if executed else 0.0),
        "net_pnl_usd": number(sum(pnls), 4),
        "gross_profit_usd": number(gross_win, 4),
        "gross_loss_usd": number(gross_loss, 4),
        "profit_factor": number(gross_win / gross_loss if gross_loss > 0 else (999.0 if gross_win > 0 else 0.0)),
        "max_drawdown_usd": number(dd, 4),
        "avg_pnl_usd": number(sum(pnls) / len(executed) if executed else 0.0),
    }


def summarize_variants(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for symbol in [*SYMBOLS, "ALL"]:
        for split in ["train", "validation", "test", "all"]:
            for strategy in ["baseline", "property_vector", "maker_cost", "liquidation_event"]:
                subset = [r for r in rows if r["strategy"] == strategy]
                if symbol != "ALL":
                    subset = [r for r in subset if r["symbol"] == symbol]
                if split != "all":
                    subset = [r for r in subset if r["split"] == split]
                m = metrics(subset)
                out.append({"symbol": symbol, "split": split, "strategy": strategy, **m})
    return out


def comparison_rows(summary_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    base = {
        (row["symbol"], row["split"]): row
        for row in summary_rows
        if row["strategy"] == "baseline"
    }
    rows: list[dict[str, Any]] = []
    for row in summary_rows:
        if row["strategy"] == "baseline" or row["symbol"] == "ALL":
            continue
        b = base.get((row["symbol"], row["split"]))
        if not b:
            continue
        rows.append({
            "symbol": row["symbol"],
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
                and row["net_pnl_usd"] > b["net_pnl_usd"]
                and row["profit_factor"] > b["profit_factor"]
                else ("same_as_baseline" if row["trades"] == b["trades"] and row["net_pnl_usd"] == b["net_pnl_usd"] else "not_promoted")
            ),
        })
    return rows


def coverage_rows(coverage: dict[str, Any]) -> list[dict[str, Any]]:
    total = coverage["trades"] or 1
    rows = []
    for key, value in coverage.items():
        if key == "liquidation_history":
            rows.append({
                "sensor": key,
                "covered_rows": value["rows"],
                "total_trades": total,
                "coverage_rate": 1.0 if value["ready"] else 0.0,
                "status": "ready" if value["ready"] else "coverage_insufficient",
                "notes": value["source"],
            })
        elif key != "trades":
            rows.append({
                "sensor": key,
                "covered_rows": int(value),
                "total_trades": total,
                "coverage_rate": number(int(value) / total),
                "status": "ready" if int(value) == total else "partial",
                "notes": "",
            })
    return rows


def status_from_summary(summary_rows: list[dict[str, Any]], coverage: dict[str, Any]) -> dict[str, Any]:
    test = [r for r in summary_rows if r["split"] == "test" and r["symbol"] in SYMBOLS]
    baseline = {r["symbol"]: r for r in test if r["strategy"] == "baseline"}
    improved: list[str] = []
    regressed: list[str] = []
    for r in test:
        if r["strategy"] in {"property_vector", "maker_cost"}:
            b = baseline.get(r["symbol"])
            if not b or r["trades"] < 5:
                regressed.append(f"{r['symbol']}:{r['strategy']}:sample_under5")
                continue
            if r["net_pnl_usd"] >= b["net_pnl_usd"] and r["profit_factor"] >= b["profit_factor"]:
                improved.append(f"{r['symbol']}:{r['strategy']}")
            else:
                regressed.append(f"{r['symbol']}:{r['strategy']}")
    return {
        "status": "historical_blind_completed",
        "promote_to_v2_13": False,
        "promote_reason": "do_not_promote_until_shadow_variant_improves_test_pf_or_pnl_for_each_symbol",
        "improved_test_variants": improved,
        "regressed_or_under_sampled_test_variants": regressed,
        "liquidation_event_status": "coverage_insufficient" if not coverage["liquidation_history"]["ready"] else "ready",
        "next_step": "Keep V2.13 as main forward ledger; use V2.15 results to decide whether V2.14 should be scheduled as shadow only.",
    }


def render_report(summary: dict[str, Any], table_rows: list[dict[str, Any]]) -> str:
    lines = [
        f"# {VERSION}",
        "",
        "## 结论",
        "",
        "- V2.15 使用 V2.11 冻结入场样本做历史盲测，不重新挑选参数。",
        "- 对照策略：baseline、10维物性版、Maker 成本版、强平事件版。",
        f"- 强平历史：`{summary['decision']['liquidation_event_status']}`。",
        f"- 是否替代 V2.13 主前向账本：`{summary['decision']['promote_to_v2_13']}`。",
        "",
        "## Test Split 核心结果",
        "",
        "| Symbol | Strategy | Trades | Win | PnL | PF | DD |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for row in table_rows:
        if row["split"] == "test" and row["symbol"] in SYMBOLS:
            lines.append(
                f"| {row['symbol']} | {row['strategy']} | {row['trades']} | "
                f"{row['win_rate']:.2%} | ${row['net_pnl_usd']:.2f} | "
                f"{row['profit_factor']:.3f} | ${row['max_drawdown_usd']:.2f} |"
            )
    lines.extend([
        "",
        "## 判断",
        "",
        "如果 10维物性版或 Maker 成本版不能在 test split 同时改善 PnL/PF 或至少降低回撤，不能替代 V2.13，只能继续作为 shadow。",
        "强平事件版本轮不做收益判断，因为历史清算文件为空；必须先补 CoinGlass/Coinalyze/Tardis 等真实历史清算数据。",
    ])
    return "\n".join(lines) + "\n"


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    enriched, coverage = load_sensor_enriched_trades()
    enriched = add_shadow_flags(add_property_vectors(enriched), coverage)
    trade_rows = variant_rows(enriched, coverage)
    summary_rows = summarize_variants(trade_rows)
    compare_rows = comparison_rows(summary_rows)
    cov_rows = coverage_rows(coverage)
    darkforest_rows = sensor_rows(enriched, coverage)
    decision = status_from_summary(summary_rows, coverage)

    vector_cols = [
        "split", "symbol", "policy_name", "entry_ts", "exit_ts", "score",
        "property_fusion_score", "maker_fill_quality", "Q", "DeltaSigma", "C",
        "Pi", "Sigma", "Eta", "BSigma", "R", "Tau", "Omega",
        "funding_funding_rate", "metrics_sum_open_interest", "lsr_long_short_ratio",
        "book_liquidity_cavity_0p2_usd", "book_depth_imbalance_0p2",
        "stable_change_7d_usd",
    ]
    vectors = [
        {col: row.get(col, "") for col in vector_cols}
        for row in enriched.to_dict("records")
    ]

    write_csv(OUT_DIR / "hfcd_trading_v2_15_property_vectors.csv", vectors)
    write_csv(OUT_DIR / "hfcd_trading_v2_15_darkforest_sensors.csv", darkforest_rows)
    write_csv(OUT_DIR / "hfcd_trading_v2_15_shadow_trades.csv", trade_rows)
    write_csv(OUT_DIR / "hfcd_trading_v2_15_summary.csv", summary_rows)
    write_csv(OUT_DIR / "hfcd_trading_v2_15_strategy_summary.csv", summary_rows)
    write_csv(OUT_DIR / "hfcd_trading_v2_15_comparison.csv", compare_rows)
    write_csv(OUT_DIR / "hfcd_trading_v2_15_sensor_coverage.csv", cov_rows)

    summary = {
        "version": VERSION,
        "created_at": now_iso(),
        "status": decision["status"],
        "no_online_page_change": True,
        "does_not_modify_v2_13_main_ledger": True,
        "source_entry_set": str(V211_DIR / "hfcd_trading_v2_11_selected_trades.csv"),
        "sensor_coverage": cov_rows,
        "decision": decision,
        "test_summary": [row for row in summary_rows if row["split"] == "test" and row["symbol"] in SYMBOLS],
        "files": {
            "property_vectors": str(OUT_DIR / "hfcd_trading_v2_15_property_vectors.csv"),
            "darkforest_sensors": str(OUT_DIR / "hfcd_trading_v2_15_darkforest_sensors.csv"),
            "shadow_trades": str(OUT_DIR / "hfcd_trading_v2_15_shadow_trades.csv"),
            "summary": str(OUT_DIR / "hfcd_trading_v2_15_summary.csv"),
            "strategy_summary": str(OUT_DIR / "hfcd_trading_v2_15_strategy_summary.csv"),
            "comparison": str(OUT_DIR / "hfcd_trading_v2_15_comparison.csv"),
            "coverage": str(OUT_DIR / "hfcd_trading_v2_15_sensor_coverage.csv"),
            "report": str(OUT_DIR / "HFCD_Trading_V2_15_CryptoPropertyDarkForestHistoricalBlind.md"),
        },
    }
    (OUT_DIR / "hfcd_trading_v2_15_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT_DIR / "HFCD_Trading_V2_15_CryptoPropertyDarkForestHistoricalBlind.md").write_text(
        render_report(summary, summary_rows),
        encoding="utf-8",
    )
    print(json.dumps({
        "version": VERSION,
        "status": decision["status"],
        "promote_to_v2_13": decision["promote_to_v2_13"],
        "liquidation_event_status": decision["liquidation_event_status"],
        "output_dir": str(OUT_DIR),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
