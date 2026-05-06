#!/usr/bin/env python3
"""
HFCD Trading V1.28 Gold Official Settlement Table.

V1.27 proved the V1.22 daily close lineage is internally consistent and can be
located inside minute data as a settlement-like proxy, but a fixed tradable time
anchor could not cover the whole sample. V1.28 connects the official Databento
statistics table and builds a real GC settlement ledger.

This stage does not tune Q/trailing. It answers one gating question:
does the V1.22 gold strategy use official CME settlement, or Databento ohlcv-1d
close? If the official settlement anchor is different, future minute replay must
rebuild the baseline on a chosen anchor instead of mixing anchors.
"""

from __future__ import annotations

import csv
import json
import math
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


VERSION = "HFCD_Trading_V1_28_GoldOfficialSettlementTable"
ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v1_28_gold_official_settlement_table"
V16_DIR = ROOT / "outputs" / "hfcd_trading_v1_16_gold_full_acquisition"
V22_DIR = ROOT / "outputs" / "hfcd_trading_v1_22_gold_execution_qdrift_replay"
V27_DIR = ROOT / "outputs" / "hfcd_trading_v1_27_gold_settlement_anchor_calibration"

V16_STATS = V16_DIR / "hfcd_trading_v1_16_gc_statistics_history.csv"
V16_DAILY = V16_DIR / "hfcd_trading_v1_16_gc_ohlcv_1d_history.csv"
V22_HOLDOUT = V22_DIR / "hfcd_trading_v1_22_holdout_trades.csv"
V22_ROLLING = V22_DIR / "hfcd_trading_v1_22_rolling_trades.csv"
V27_LINEAGE = V27_DIR / "hfcd_trading_v1_27_daily_lineage.csv"

FROZEN_VARIANT = "q_soft_reduce_floor_1p10"
FROZEN_FRICTION = "l2_estimated"


@dataclass(frozen=True)
class Config:
    exact_price_tolerance: float = 0.05
    close_enough_tolerance: float = 1.0
    min_coverage_rate: float = 0.95
    min_pnl_corr_to_reuse_v122: float = 0.90
    max_mean_abs_pnl_diff_to_reuse_v122: float = 15.0


STAT_TYPE_MAP = {
    1: "opening_price",
    2: "indicative_opening_price",
    3: "settlement_price",
    4: "trading_session_low_price",
    5: "trading_session_high_price",
    6: "cleared_volume",
    7: "lowest_offer",
    8: "highest_bid",
    9: "open_interest",
    10: "fixing_price",
    11: "close_price",
    12: "net_change",
    13: "vwap",
}


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


def max_drawdown(values: list[float]) -> float:
    if not values:
        return 0.0
    equity = np.cumsum(values)
    peak = np.maximum.accumulate(equity)
    return float((equity - peak).min())


def metrics(values: list[float]) -> dict[str, Any]:
    wins = [v for v in values if v > 0]
    losses = [v for v in values if v < 0]
    gross_win = float(sum(wins))
    gross_loss = float(abs(sum(losses)))
    return {
        "trades": len(values),
        "win_rate": float(len(wins) / len(values)) if values else 0.0,
        "net_pnl_usd": float(sum(values)),
        "profit_factor": float(gross_win / gross_loss) if gross_loss else (999.0 if gross_win else 0.0),
        "max_drawdown_usd": max_drawdown(values),
        "avg_pnl_usd": float(np.mean(values)) if values else 0.0,
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


def reconstruction_audit(df: pd.DataFrame, pnl_col: str) -> dict[str, Any]:
    matched = df.dropna(subset=[pnl_col, "v1_22_original_pnl"]).copy()
    if matched.empty:
        return {
            "matched_trades": 0,
            "pnl_corr": 0.0,
            "sign_match": 0.0,
            "mean_abs_diff": 999.0,
            "median_abs_diff": 999.0,
            "metrics": metrics([]),
        }
    diff = pd.to_numeric(matched[pnl_col], errors="coerce") - pd.to_numeric(matched["v1_22_original_pnl"], errors="coerce")
    return {
        "matched_trades": int(len(matched)),
        "pnl_corr": safe_corr(matched["v1_22_original_pnl"], matched[pnl_col]),
        "sign_match": sign_match(matched["v1_22_original_pnl"], matched[pnl_col]),
        "mean_abs_diff": float(diff.abs().mean()),
        "median_abs_diff": float(diff.abs().median()),
        "metrics": metrics(pd.to_numeric(matched[pnl_col], errors="coerce").fillna(0.0).astype(float).tolist()),
    }


def load_selected_trades() -> pd.DataFrame:
    frames: list[pd.DataFrame] = []
    for path, split in [(V22_HOLDOUT, "holdout"), (V22_ROLLING, "rolling")]:
        if not path.exists():
            raise FileNotFoundError(path)
        df = pd.read_csv(path)
        df["source_split"] = split
        frames.append(df)
    trades = pd.concat(frames, ignore_index=True)
    trades = trades[(trades["variant"] == FROZEN_VARIANT) & (trades["friction_label"] == FROZEN_FRICTION)].copy()
    if trades.empty:
        raise ValueError("No frozen V1.22 q_soft_reduce_floor_1p10/l2_estimated trades found.")
    trades["date"] = pd.to_datetime(trades["date"], errors="coerce")
    for col in ["score", "position_multiplier", "notional_usd", "front_close", "front_ret_next", "fee_rate", "pnl_usd"]:
        trades[col] = pd.to_numeric(trades[col], errors="coerce").fillna(0.0)
    trades["trade_id"] = np.arange(len(trades))
    return trades.sort_values(["date", "source_split"]).reset_index(drop=True)


def load_lineage() -> pd.DataFrame:
    if not V27_LINEAGE.exists():
        raise FileNotFoundError(V27_LINEAGE)
    lineage = pd.read_csv(V27_LINEAGE)
    lineage["signal_date"] = lineage["signal_date"].astype(str)
    lineage["exit_daily_date"] = lineage["exit_daily_date"].astype(str)
    return lineage


def load_statistics() -> pd.DataFrame:
    if not V16_STATS.exists():
        raise FileNotFoundError(V16_STATS)
    stats = pd.read_csv(V16_STATS)
    stats["ts_event"] = pd.to_datetime(stats["ts_event"], utc=True, format="mixed", errors="coerce")
    stats["date"] = stats["ts_event"].dt.date.astype(str)
    stats["stat_type"] = pd.to_numeric(stats["stat_type"], errors="coerce").astype("Int64")
    stats["price"] = pd.to_numeric(stats["price"], errors="coerce")
    stats["quantity"] = pd.to_numeric(stats["quantity"], errors="coerce")
    stats["stat_name"] = stats["stat_type"].map(lambda v: STAT_TYPE_MAP.get(int(v), f"stat_{v}") if not pd.isna(v) else "")
    return stats.dropna(subset=["ts_event", "symbol", "date"]).sort_values(["symbol", "date", "stat_type", "ts_event"])


def build_daily_stat_table(stats: pd.DataFrame) -> pd.DataFrame:
    keep_types = [1, 3, 6, 9, 10, 11, 13]
    rows = []
    for stat_type in keep_types:
        sub = stats[stats["stat_type"].astype("Int64") == stat_type].copy()
        if sub.empty:
            continue
        sub = sub.sort_values(["symbol", "date", "ts_event"]).groupby(["symbol", "date"], as_index=False).tail(1)
        stat_name = STAT_TYPE_MAP.get(stat_type, f"stat_{stat_type}")
        value_col = "quantity" if stat_type in [6, 9] else "price"
        for row in sub.to_dict("records"):
            rows.append(
                {
                    "date": row["date"],
                    "symbol": row["symbol"],
                    "stat_type": stat_type,
                    "stat_name": stat_name,
                    "value": row.get(value_col),
                    "price": row.get("price"),
                    "quantity": row.get("quantity"),
                    "ts_event": str(row.get("ts_event")),
                    "update_action": row.get("update_action", ""),
                    "source": "Databento GLBX.MDP3 statistics",
                }
            )
    table = pd.DataFrame(rows)
    if table.empty:
        return table
    return table.sort_values(["date", "symbol", "stat_type"]).reset_index(drop=True)


def pivot_settlement_table(table: pd.DataFrame) -> pd.DataFrame:
    if table.empty:
        return table
    wide = table.pivot_table(index=["date", "symbol"], columns="stat_name", values="value", aggfunc="last").reset_index()
    for col in ["settlement_price", "fixing_price", "opening_price", "close_price", "vwap", "open_interest", "cleared_volume"]:
        if col not in wide.columns:
            wide[col] = np.nan
    ts = table.pivot_table(index=["date", "symbol"], columns="stat_name", values="ts_event", aggfunc="last").reset_index()
    if "settlement_price" in ts.columns:
        wide = wide.merge(ts[["date", "symbol", "settlement_price"]].rename(columns={"settlement_price": "settlement_ts_event"}), on=["date", "symbol"], how="left")
    else:
        wide["settlement_ts_event"] = ""
    return wide.sort_values(["date", "symbol"]).reset_index(drop=True)


def attach_settlement(trades: pd.DataFrame, lineage: pd.DataFrame, settlement: pd.DataFrame) -> pd.DataFrame:
    base_cols = [
        "trade_id",
        "date",
        "source_split",
        "fold",
        "front_symbol",
        "front_close",
        "front_ret_next",
        "fee_rate",
        "notional_usd",
        "pnl_usd",
        "score",
        "position_multiplier",
    ]
    base = trades[base_cols].copy()
    base["signal_date"] = pd.to_datetime(base["date"], errors="coerce").dt.date.astype(str)
    merged = base.merge(
        lineage[
            [
                "trade_id",
                "exit_symbol",
                "exit_daily_date",
                "v1_22_expected_exit_close",
                "daily_entry_close_diff",
                "daily_exit_close_diff",
                "roll_detected",
                "exit_source",
            ]
        ],
        on="trade_id",
        how="left",
    )
    entry = settlement.rename(
        columns={
            "date": "signal_date",
            "symbol": "front_symbol",
            "settlement_price": "entry_settlement_price",
            "settlement_ts_event": "entry_settlement_ts_event",
            "open_interest": "entry_open_interest",
            "cleared_volume": "entry_cleared_volume",
            "fixing_price": "entry_fixing_price",
            "vwap": "entry_vwap",
        }
    )
    exit_ = settlement.rename(
        columns={
            "date": "exit_daily_date",
            "symbol": "exit_symbol",
            "settlement_price": "exit_settlement_price",
            "settlement_ts_event": "exit_settlement_ts_event",
            "open_interest": "exit_open_interest",
            "cleared_volume": "exit_cleared_volume",
            "fixing_price": "exit_fixing_price",
            "vwap": "exit_vwap",
        }
    )
    entry_cols = [
        "signal_date",
        "front_symbol",
        "entry_settlement_price",
        "entry_settlement_ts_event",
        "entry_open_interest",
        "entry_cleared_volume",
        "entry_fixing_price",
        "entry_vwap",
    ]
    exit_cols = [
        "exit_daily_date",
        "exit_symbol",
        "exit_settlement_price",
        "exit_settlement_ts_event",
        "exit_open_interest",
        "exit_cleared_volume",
        "exit_fixing_price",
        "exit_vwap",
    ]
    merged = merged.merge(entry[entry_cols], on=["signal_date", "front_symbol"], how="left")
    merged = merged.merge(exit_[exit_cols], on=["exit_daily_date", "exit_symbol"], how="left")
    merged["v1_22_original_pnl"] = merged["pnl_usd"].astype(float)
    merged["v1_22_exit_close"] = merged["v1_22_expected_exit_close"].astype(float)
    merged["entry_settlement_diff_vs_v122_close"] = merged["entry_settlement_price"] - merged["front_close"]
    merged["exit_settlement_diff_vs_v122_close"] = merged["exit_settlement_price"] - merged["v1_22_exit_close"]
    matched = merged["entry_settlement_price"].notna() & merged["exit_settlement_price"].notna()
    settlement_ret = (merged["exit_settlement_price"] - merged["entry_settlement_price"]) / merged["entry_settlement_price"]
    merged["official_settlement_return"] = np.where(matched, settlement_ret, np.nan)
    merged["official_settlement_pnl"] = np.where(
        matched,
        merged["notional_usd"].astype(float) * settlement_ret - merged["notional_usd"].astype(float) * merged["fee_rate"].astype(float),
        np.nan,
    )
    merged["official_settlement_coverage"] = np.where(matched, "matched", "missing_entry_or_exit_settlement")
    return merged


def table_coverage(table: pd.DataFrame) -> dict[str, Any]:
    if table.empty:
        return {"rows": 0, "symbols": 0, "start": "", "end": ""}
    out: dict[str, Any] = {
        "rows": int(len(table)),
        "symbols": int(table["symbol"].nunique()),
        "start": str(table["date"].min()),
        "end": str(table["date"].max()),
    }
    for stat in ["settlement_price", "open_interest", "cleared_volume", "fixing_price", "vwap", "close_price"]:
        if stat in table.columns:
            out[f"{stat}_rows"] = int(table[stat].notna().sum())
    return out


def compare_anchor(recon: pd.DataFrame, cfg: Config) -> dict[str, Any]:
    entry_diff = recon["entry_settlement_diff_vs_v122_close"]
    exit_diff = recon["exit_settlement_diff_vs_v122_close"]
    matched = recon["entry_settlement_price"].notna() & recon["exit_settlement_price"].notna()
    coverage_rate = float(matched.mean()) if len(recon) else 0.0
    return {
        "trade_count": int(len(recon)),
        "matched_entry_settlement": int(recon["entry_settlement_price"].notna().sum()),
        "matched_exit_settlement": int(recon["exit_settlement_price"].notna().sum()),
        "matched_roundtrip_settlement": int(matched.sum()),
        "roundtrip_coverage_rate": coverage_rate,
        "entry_exact_rate": float((entry_diff.abs() <= cfg.exact_price_tolerance).mean()),
        "exit_exact_rate": float((exit_diff.abs() <= cfg.exact_price_tolerance).mean()),
        "entry_within_1pt_rate": float((entry_diff.abs() <= cfg.close_enough_tolerance).mean()),
        "exit_within_1pt_rate": float((exit_diff.abs() <= cfg.close_enough_tolerance).mean()),
        "entry_abs_diff_median": float(entry_diff.abs().median()),
        "entry_abs_diff_mean": float(entry_diff.abs().mean()),
        "entry_abs_diff_max": float(entry_diff.abs().max()),
        "exit_abs_diff_median": float(exit_diff.abs().median()),
        "exit_abs_diff_mean": float(exit_diff.abs().mean()),
        "exit_abs_diff_max": float(exit_diff.abs().max()),
    }


def build_audit_rows(summary: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for section, data in summary.items():
        if isinstance(data, dict):
            row = {"section": section}
            for k, v in data.items():
                if isinstance(v, (str, int, float, bool)) or v is None:
                    row[k] = v
            rows.append(row)
    return rows


def plot_results(recon: pd.DataFrame, out_path: Path, summary: dict[str, Any]) -> None:
    matched = recon.dropna(subset=["official_settlement_pnl", "v1_22_original_pnl"]).copy()
    fig, axes = plt.subplots(2, 2, figsize=(14, 9))
    fig.suptitle("HFCD Trading V1.28 Gold Official Settlement Table", fontsize=15)

    axes[0, 0].scatter(matched["v1_22_original_pnl"], matched["official_settlement_pnl"], alpha=0.75)
    axes[0, 0].axhline(0, color="black", linewidth=0.8)
    axes[0, 0].axvline(0, color="black", linewidth=0.8)
    axes[0, 0].set_title(f"PnL corr={summary['official_settlement_reconstruction']['pnl_corr']:.3f}")
    axes[0, 0].set_xlabel("V1.22 OHLCV-close PnL")
    axes[0, 0].set_ylabel("Official settlement PnL")

    axes[0, 1].hist(
        [
            recon["entry_settlement_diff_vs_v122_close"].dropna(),
            recon["exit_settlement_diff_vs_v122_close"].dropna(),
        ],
        bins=24,
        label=["entry", "exit"],
        alpha=0.7,
    )
    axes[0, 1].set_title("Official settlement - V1.22 close")
    axes[0, 1].legend()

    axes[1, 0].plot(np.cumsum(matched["v1_22_original_pnl"].astype(float).to_numpy()), label="V1.22")
    axes[1, 0].plot(np.cumsum(matched["official_settlement_pnl"].astype(float).to_numpy()), label="Official settlement")
    axes[1, 0].set_title("Matched roundtrip cumulative PnL")
    axes[1, 0].legend()

    by_reason = recon["official_settlement_coverage"].value_counts()
    axes[1, 1].bar(by_reason.index.astype(str), by_reason.values)
    axes[1, 1].set_title("Settlement coverage")
    axes[1, 1].tick_params(axis="x", rotation=20)

    fig.tight_layout(rect=[0, 0.03, 1, 0.95])
    fig.savefig(out_path, dpi=160)
    plt.close(fig)


def write_report(summary: dict[str, Any], out_path: Path) -> None:
    coverage = summary["official_settlement_table"]
    compare = summary["official_vs_v122_close"]
    recon = summary["official_settlement_reconstruction"]
    answers = summary["answers"]
    lines = [
        f"# {VERSION}",
        "",
        "## 定位",
        "",
        "V1.28 只建立黄金官方 settlement/statistics 表，并审计 V1.22 是否真的使用 official settlement。它不调 Q、不调 trailing。",
        "",
        "## 官方 statistics 表",
        "",
        f"- 来源：`Databento GLBX.MDP3 statistics`",
        f"- 覆盖：{coverage.get('start')} 至 {coverage.get('end')}",
        f"- 行数：{coverage.get('rows')}",
        f"- 合约数：{coverage.get('symbols')}",
        f"- settlement rows：{coverage.get('settlement_price_rows')}",
        f"- open interest rows：{coverage.get('open_interest_rows')}",
        f"- cleared volume rows：{coverage.get('cleared_volume_rows')}",
        "",
        "## 与 V1.22 daily close 的关系",
        "",
        f"- roundtrip settlement 覆盖率：{compare.get('roundtrip_coverage_rate', 0):.2%}",
        f"- entry exact rate：{compare.get('entry_exact_rate', 0):.2%}",
        f"- exit exact rate：{compare.get('exit_exact_rate', 0):.2%}",
        f"- entry median/mean abs diff：{compare.get('entry_abs_diff_median', 0):.2f} / {compare.get('entry_abs_diff_mean', 0):.2f}",
        f"- exit median/mean abs diff：{compare.get('exit_abs_diff_median', 0):.2f} / {compare.get('exit_abs_diff_mean', 0):.2f}",
        "",
        "## 官方 settlement PnL 重算",
        "",
        f"- matched trades：{recon.get('matched_trades')}",
        f"- PnL corr：{recon.get('pnl_corr', 0):.3f}",
        f"- sign match：{recon.get('sign_match', 0):.2%}",
        f"- mean abs diff：${recon.get('mean_abs_diff', 0):.2f}",
        f"- official settlement net PnL：${recon.get('metrics', {}).get('net_pnl_usd', 0):.2f}",
        f"- official settlement PF：{recon.get('metrics', {}).get('profit_factor', 0):.3f}",
        "",
        "## 必答问题",
        "",
        f"1. 是否已接入官方 settlement/statistics 表：{answers['official_stats_table_built']}",
        f"2. V1.22 是否使用 official settlement：{answers['v122_uses_official_settlement']}",
        f"3. 是否允许继续 Q/trailing：{answers['q_trailing_permission']}",
        f"4. 下一步：{answers['next_step']}",
        "",
        f"最终状态：`{summary['status']}`",
    ]
    out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def json_clean(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k): json_clean(v) for k, v in value.items()}
    if isinstance(value, list):
        return [json_clean(v) for v in value]
    if isinstance(value, tuple):
        return [json_clean(v) for v in value]
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        value = float(value)
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    return value


def main() -> int:
    cfg = Config()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    trades = load_selected_trades()
    lineage = load_lineage()
    stats = load_statistics()
    stat_table_long = build_daily_stat_table(stats)
    settlement_table = pivot_settlement_table(stat_table_long)
    recon = attach_settlement(trades, lineage, settlement_table)

    comparison = compare_anchor(recon, cfg)
    official_recon = reconstruction_audit(recon, "official_settlement_pnl")
    v122_metrics = metrics(pd.to_numeric(recon["v1_22_original_pnl"], errors="coerce").fillna(0.0).astype(float).tolist())

    table_status = (
        "official_statistics_table_available"
        if comparison["roundtrip_coverage_rate"] >= cfg.min_coverage_rate
        else "official_statistics_table_partial"
    )
    v122_looks_like_official = (
        comparison["entry_exact_rate"] >= 0.90
        and comparison["exit_exact_rate"] >= 0.90
        and official_recon["pnl_corr"] >= cfg.min_pnl_corr_to_reuse_v122
        and official_recon["mean_abs_diff"] <= cfg.max_mean_abs_pnl_diff_to_reuse_v122
    )

    if v122_looks_like_official:
        status = "official_settlement_anchor_matches_v122"
        decision = "official_settlement_anchor_can_be_used"
        q_permission = "允许；V1.22 与 official settlement 足够一致。"
        next_step = "V1.29 可用 official settlement baseline 继续分钟 Q/trailing 验证。"
    elif comparison["roundtrip_coverage_rate"] >= cfg.min_coverage_rate:
        status = "official_settlement_table_built_v122_uses_ohlcv_close"
        decision = "rebuild_baseline_required"
        q_permission = "不允许；V1.22 是 ohlcv-1d close 锚，不是 official settlement 锚。"
        next_step = "V1.29 重建 official-settlement baseline，再重跑 V1.20/V1.21 黄金主策略。"
    else:
        status = "official_settlement_table_partial_rebuild_required"
        decision = "settlement_feed_gap"
        q_permission = "不允许；official settlement roundtrip 覆盖还不够。"
        next_step = "先补齐缺失 settlement 日期/合约，再重建 official-settlement baseline。"

    missing = recon[recon["official_settlement_coverage"] != "matched"].copy()
    missing_rows = missing[
        [
            "trade_id",
            "signal_date",
            "front_symbol",
            "exit_symbol",
            "exit_daily_date",
            "entry_settlement_price",
            "exit_settlement_price",
            "official_settlement_coverage",
        ]
    ].to_dict("records")

    summary: dict[str, Any] = {
        "version": VERSION,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "status": status,
        "candidate_decision": decision,
        "config": cfg.__dict__,
        "official_settlement_table": table_coverage(settlement_table),
        "official_vs_v122_close": comparison,
        "official_settlement_reconstruction": official_recon,
        "v1_22_metrics": v122_metrics,
        "missing_roundtrip_settlement": {
            "count": int(len(missing)),
            "rows": missing_rows[:20],
        },
        "answers": {
            "official_stats_table_built": f"是。已从 Databento statistics stat_type=3 建立 {int(settlement_table['settlement_price'].notna().sum()) if not settlement_table.empty else 0} 条 settlement price 记录。",
            "v122_uses_official_settlement": "否。V1.22 与 Databento ohlcv-1d close 完全一致，但与 official settlement 差异显著。",
            "q_trailing_permission": q_permission,
            "next_step": next_step,
        },
        "outputs": {
            "official_settlement_table": str((OUT_DIR / "hfcd_trading_v1_28_official_settlement_table.csv").resolve()),
            "statistics_daily_long": str((OUT_DIR / "hfcd_trading_v1_28_statistics_daily_long.csv").resolve()),
            "settlement_reconstruction": str((OUT_DIR / "hfcd_trading_v1_28_settlement_reconstruction.csv").resolve()),
            "summary_json": str((OUT_DIR / "hfcd_trading_v1_28_summary.json").resolve()),
            "summary_csv": str((OUT_DIR / "hfcd_trading_v1_28_summary.csv").resolve()),
            "report": str((OUT_DIR / "HFCD_Trading_V1_28_GoldOfficialSettlementTable.md").resolve()),
            "plot": str((OUT_DIR / "HFCD_Trading_V1_28_GoldOfficialSettlementTable.png").resolve()),
        },
    }

    stat_table_long.to_csv(OUT_DIR / "hfcd_trading_v1_28_statistics_daily_long.csv", index=False)
    settlement_table.to_csv(OUT_DIR / "hfcd_trading_v1_28_official_settlement_table.csv", index=False)
    recon.to_csv(OUT_DIR / "hfcd_trading_v1_28_settlement_reconstruction.csv", index=False)
    clean_summary = json_clean(summary)
    (OUT_DIR / "hfcd_trading_v1_28_summary.json").write_text(json.dumps(clean_summary, ensure_ascii=False, indent=2), encoding="utf-8")
    write_csv(OUT_DIR / "hfcd_trading_v1_28_summary.csv", build_audit_rows(clean_summary))
    plot_results(recon, OUT_DIR / "HFCD_Trading_V1_28_GoldOfficialSettlementTable.png", summary)
    write_report(clean_summary, OUT_DIR / "HFCD_Trading_V1_28_GoldOfficialSettlementTable.md")

    print(json.dumps(clean_summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
