#!/usr/bin/env python3
"""
HFCD Trading V1.34 Gold BBO/MBP Coverage Repair.

V1.33 proved that clean BBO/MBP quotes preserve the V1.31 execution edge,
but coverage was too low. V1.34 keeps the V1.31 trade set and anchor fixed,
then repairs the cost layer by looking for the first quality quote after the
anchor inside a bounded non-optimizing wait window.

No signal tuning, Q-exit tuning, trailing, or uncovered-trade imputation is
allowed in this stage.
"""

from __future__ import annotations

import csv
import importlib.util
import json
import math
import os
from datetime import datetime
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


VERSION = "HFCD_Trading_V1_34_GoldBboMbpCoverageRepair"
ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v1_34_gold_bbo_mbp_coverage_repair"
CACHE_DIR = OUT_DIR / "cache_bbo_mbp"
V33_SCRIPT = ROOT / "scripts" / "hfcd_trading_v1_33_gold_bbo_mbp_cost_audit.py"

DATASET = "GLBX.MDP3"
FETCH_BBO = os.environ.get("HFCD_V134_FETCH_BBO", "1") == "1"
FETCH_SCHEMA_ORDER = [s.strip() for s in os.environ.get("HFCD_V134_SCHEMA_ORDER", "bbo-1s,mbp-1").split(",") if s.strip()]
MAX_FETCH_LEGS = int(os.environ.get("HFCD_V134_MAX_FETCH_LEGS", "240"))
LOOKBACK_MINUTES = int(os.environ.get("HFCD_V134_LOOKBACK_MINUTES", "5"))
LOOKAHEAD_MINUTES = int(os.environ.get("HFCD_V134_LOOKAHEAD_MINUTES", "65"))
QUOTE_MAX_WAIT_SECONDS = int(os.environ.get("HFCD_V134_QUOTE_MAX_WAIT_SECONDS", "3600"))
QUOTE_MAX_SPREAD_ABS = float(os.environ.get("HFCD_V134_QUOTE_MAX_SPREAD_ABS", "2.0"))
QUOTE_MAX_SPREAD_BPS = float(os.environ.get("HFCD_V134_QUOTE_MAX_SPREAD_BPS", "10.0"))
QUOTE_MIN_TOP_BOOK_SIZE = float(os.environ.get("HFCD_V134_QUOTE_MIN_TOP_BOOK_SIZE", "1.0"))


def import_v33() -> Any:
    spec = importlib.util.spec_from_file_location("hfcd_v33_bbo_cost", V33_SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot import {V33_SCRIPT}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


v33 = import_v33()


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


def metric_block(values: list[float], total_signals: int | None = None, executed: int | None = None) -> dict[str, Any]:
    return v33.metric_block(values, total_signals=total_signals, executed=executed)


def safe_corr(a: pd.Series, b: pd.Series) -> float:
    return v33.safe_corr(a, b)


def sign_match(a: pd.Series, b: pd.Series) -> float:
    return v33.sign_match(a, b)


def max_drawdown(values: list[float]) -> float:
    return v33.max_drawdown(values)


def get_databento_client() -> Any | None:
    if not FETCH_BBO:
        return None
    v33.load_env_file(ROOT / ".env.local")
    v33.load_env_file(ROOT / ".dev.vars")
    key = os.environ.get("DATABENTO_API_KEY")
    if not key:
        return None
    try:
        import databento as db  # type: ignore
    except Exception:
        return None
    return db.Historical(key=key)


def quote_quality_mask(book: pd.DataFrame) -> pd.Series:
    if book.empty:
        return pd.Series(dtype=bool)
    mid = pd.to_numeric(book["mid_price"], errors="coerce")
    spread = pd.to_numeric(book["spread"], errors="coerce")
    top_size = pd.to_numeric(book["top_book_size"], errors="coerce").fillna(0.0)
    spread_bps = 10_000.0 * spread / mid.replace(0.0, np.nan)
    return (
        (pd.to_numeric(book["bid_px_00"], errors="coerce") > 0)
        & (pd.to_numeric(book["ask_px_00"], errors="coerce") > pd.to_numeric(book["bid_px_00"], errors="coerce"))
        & (spread > 0)
        & (spread <= QUOTE_MAX_SPREAD_ABS)
        & (spread_bps <= QUOTE_MAX_SPREAD_BPS)
        & (top_size >= QUOTE_MIN_TOP_BOOK_SIZE)
    ).fillna(False)


def repair_stage(seconds: float) -> str:
    if not math.isfinite(seconds):
        return "missing"
    if seconds <= 600:
        return "first_clean_after_anchor_10m"
    if seconds <= 1800:
        return "first_clean_after_anchor_30m"
    if seconds <= 3600:
        return "first_clean_after_anchor_60m"
    return "outside_window"


def fetch_range_to_df(client: Any, schema: str, symbol: str, start: pd.Timestamp, end: pd.Timestamp) -> pd.DataFrame:
    data = client.timeseries.get_range(
        dataset=DATASET,
        schema=schema,
        symbols=[symbol],
        stype_in="raw_symbol",
        start=start.isoformat(),
        end=end.isoformat(),
    )
    df = data.to_df()
    if df is None or df.empty:
        return pd.DataFrame()
    return df.reset_index()


class RepairBookStore:
    def __init__(self) -> None:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        self.client = get_databento_client()
        self.fetch_count = 0
        self.loaded: dict[tuple[str, str], pd.DataFrame] = {}
        self.fetch_log: list[dict[str, Any]] = []

    def local_candidates(self, symbol: str, date_key: str) -> list[Path]:
        patterns = [
            f"outputs/**/bbo_1s_{symbol}_{date_key}.csv",
            f"outputs/**/bbo_1s_{symbol}_{date_key}_*.csv",
            f"outputs/**/mbp_1_{symbol}_{date_key}.csv",
            f"outputs/**/mbp_1_{symbol}_{date_key}_*.csv",
        ]
        found: list[Path] = []
        for pattern in patterns:
            found.extend(ROOT.glob(pattern))
        return sorted({p for p in found if p.exists() and p.stat().st_size > 0})

    def cache_file(self, schema: str, symbol: str, target: pd.Timestamp) -> Path:
        stamp = target.strftime("%Y-%m-%d_%H%M")
        return CACHE_DIR / f"{schema.replace('-', '_')}_{symbol}_{stamp}_wide.csv"

    def get_window(self, symbol: str, target: pd.Timestamp) -> tuple[pd.DataFrame, str]:
        key = (symbol, target.strftime("%Y-%m-%d_%H%M"))
        if key in self.loaded:
            return self.loaded[key], "memory"

        date_key = target.date().isoformat()
        start = target - pd.Timedelta(minutes=LOOKBACK_MINUTES)
        end = target + pd.Timedelta(minutes=LOOKAHEAD_MINUTES)
        frames: list[pd.DataFrame] = []
        sources: list[str] = []

        for path in self.local_candidates(symbol, date_key):
            try:
                raw = pd.read_csv(path)
            except Exception:
                continue
            norm = v33.normalize_book(raw, symbol=symbol)
            if norm.empty:
                continue
            part = norm[(norm["timestamp"] >= start) & (norm["timestamp"] <= end)].copy()
            if not part.empty:
                frames.append(part)
                sources.append(f"local:{path}")

        if self.client is not None and self.fetch_count < MAX_FETCH_LEGS:
            for schema in FETCH_SCHEMA_ORDER:
                cache = self.cache_file(schema, symbol, target)
                raw = pd.DataFrame()
                status = "not_requested"
                error = ""
                if cache.exists() and cache.stat().st_size > 0:
                    try:
                        raw = pd.read_csv(cache)
                        status = "cache"
                    except Exception as exc:
                        status = f"cache_invalid:{type(exc).__name__}"
                        error = str(exc)[:500]
                else:
                    try:
                        raw = fetch_range_to_df(self.client, schema=schema, symbol=symbol, start=start, end=end)
                        raw.to_csv(cache, index=False)
                        status = "downloaded"
                        self.fetch_count += 1
                    except Exception as exc:
                        status = f"failed:{type(exc).__name__}"
                        error = str(exc)[:500]
                        self.fetch_count += 1
                norm = v33.normalize_book(raw, symbol=symbol)
                self.fetch_log.append(
                    {
                        "symbol": symbol,
                        "target": target.isoformat(),
                        "schema": schema,
                        "start": start.isoformat(),
                        "end": end.isoformat(),
                        "status": status,
                        "normalized_rows": int(len(norm)),
                        "error": error,
                    }
                )
                if not norm.empty:
                    part = norm[(norm["timestamp"] >= start) & (norm["timestamp"] <= end)].copy()
                    if not part.empty:
                        frames.append(part)
                        sources.append(f"{schema}:{status}:{cache}")
                        break

        if not frames:
            out = pd.DataFrame()
            self.loaded[key] = out
            return out, "missing_bbo_mbp"

        out = pd.concat(frames, ignore_index=True)
        out = out.sort_values("timestamp").drop_duplicates("timestamp").reset_index(drop=True)
        self.loaded[key] = out
        return out, " | ".join(sources)


def select_first_clean_quote(book: pd.DataFrame, target: pd.Timestamp) -> dict[str, Any]:
    if book.empty:
        return {"status": "missing_bbo_mbp", "seconds_away": math.nan, "repair_stage": "missing"}
    after = book[(book["timestamp"] >= target) & (book["timestamp"] <= target + pd.Timedelta(seconds=QUOTE_MAX_WAIT_SECONDS))].copy()
    if after.empty:
        return {"status": "no_quote_after_anchor", "seconds_away": math.nan, "repair_stage": "missing"}

    quality = after[quote_quality_mask(after)].copy()
    if quality.empty:
        first_bad = after.sort_values("timestamp").iloc[0]
        seconds = float((first_bad["timestamp"] - target).total_seconds())
        return {
            "status": "quote_quality_fail_after_anchor",
            "timestamp": first_bad["timestamp"],
            "seconds_away": seconds,
            "repair_stage": "dirty_observable_only",
            "bid": float(first_bad["bid_px_00"]),
            "ask": float(first_bad["ask_px_00"]),
            "mid": float(first_bad["mid_price"]),
            "spread": float(first_bad["spread"]),
            "top_book_size": float(first_bad["top_book_size"]),
            "quality_fail_count": int(len(after)),
            "max_spread_in_window": float(pd.to_numeric(after["spread"], errors="coerce").max()),
            "min_spread_in_window": float(pd.to_numeric(after["spread"], errors="coerce").min()),
        }

    first = quality.sort_values("timestamp").iloc[0]
    seconds = float((first["timestamp"] - target).total_seconds())
    return {
        "status": "matched",
        "timestamp": first["timestamp"],
        "seconds_away": seconds,
        "repair_stage": repair_stage(seconds),
        "bid": float(first["bid_px_00"]),
        "ask": float(first["ask_px_00"]),
        "mid": float(first["mid_price"]),
        "spread": float(first["spread"]),
        "top_book_size": float(first["top_book_size"]),
        "bid_size": float(first["bid_sz_00"]) if not pd.isna(first["bid_sz_00"]) else 0.0,
        "ask_size": float(first["ask_sz_00"]) if not pd.isna(first["ask_sz_00"]) else 0.0,
        "quality_fail_count": int(len(after) - len(quality)),
        "max_spread_in_window": float(pd.to_numeric(after["spread"], errors="coerce").max()),
        "min_spread_in_window": float(pd.to_numeric(after["spread"], errors="coerce").min()),
    }


def replay_with_repaired_quotes(replay: pd.DataFrame, store: RepairBookStore) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    for _, tr in replay[replay["matched"]].copy().iterrows():
        entry_ts = v33.anchor_timestamp(str(tr["date"]), int(tr["anchor_minute_of_day"]), float(tr["entry_minutes_away"]))
        exit_ts = v33.anchor_timestamp(str(tr["exit_date"]), int(tr["anchor_minute_of_day"]), float(tr["exit_minutes_away"]))
        entry_book, entry_source = store.get_window(str(tr["front_symbol"]), entry_ts)
        exit_book, exit_source = store.get_window(str(tr["exit_symbol"]), exit_ts)
        entry = select_first_clean_quote(entry_book, entry_ts)
        exit_ = select_first_clean_quote(exit_book, exit_ts)
        matched = entry.get("status") == "matched" and exit_.get("status") == "matched"

        notional = float(tr["notional_usd"]) * float(tr["position_multiplier"])
        fee = notional * float(tr["fee_rate"])
        side = str(tr.get("side", "long")).lower()
        bbo_return = math.nan
        bbo_pnl = math.nan
        bbo_2x = math.nan
        bbo_mid_pnl = math.nan
        if matched:
            if side.startswith("short"):
                bbo_return = (entry["bid"] - exit_["ask"]) / entry["bid"]
                mid_return = (entry["mid"] - exit_["mid"]) / entry["mid"]
            else:
                bbo_return = (exit_["bid"] - entry["ask"]) / entry["ask"]
                mid_return = (exit_["mid"] - entry["mid"]) / entry["mid"]
            bbo_pnl = notional * bbo_return - fee
            bbo_2x = notional * bbo_return - 2.0 * fee
            bbo_mid_pnl = notional * mid_return - fee

        rows.append(
            {
                "trade_id_v130": int(tr["trade_id_v130"]),
                "fold": tr["fold"],
                "split": tr["split"],
                "date": tr["date"],
                "exit_date": tr["exit_date"],
                "front_symbol": tr["front_symbol"],
                "exit_symbol": tr["exit_symbol"],
                "score": float(tr["score"]),
                "side": side,
                "notional_usd": notional,
                "fee_usd": fee,
                "anchor_pnl": float(tr["anchor_pnl"]),
                "anchor_pnl_2x_cost": float(tr["anchor_pnl_2x_cost"]),
                "official_settlement_pnl": float(tr["official_settlement_pnl"]),
                "entry_anchor_ts": entry_ts.isoformat(),
                "exit_anchor_ts": exit_ts.isoformat(),
                "entry_bbo_status": entry.get("status"),
                "exit_bbo_status": exit_.get("status"),
                "entry_repair_stage": entry.get("repair_stage"),
                "exit_repair_stage": exit_.get("repair_stage"),
                "entry_bbo_source": entry_source,
                "exit_bbo_source": exit_source,
                "entry_bbo_ts": entry.get("timestamp"),
                "exit_bbo_ts": exit_.get("timestamp"),
                "entry_seconds_away": entry.get("seconds_away"),
                "exit_seconds_away": exit_.get("seconds_away"),
                "entry_bid": entry.get("bid"),
                "entry_ask": entry.get("ask"),
                "entry_mid": entry.get("mid"),
                "entry_spread": entry.get("spread"),
                "entry_top_book_size": entry.get("top_book_size"),
                "entry_quality_fail_count": entry.get("quality_fail_count"),
                "entry_max_spread_in_window": entry.get("max_spread_in_window"),
                "entry_min_spread_in_window": entry.get("min_spread_in_window"),
                "exit_bid": exit_.get("bid"),
                "exit_ask": exit_.get("ask"),
                "exit_mid": exit_.get("mid"),
                "exit_spread": exit_.get("spread"),
                "exit_top_book_size": exit_.get("top_book_size"),
                "exit_quality_fail_count": exit_.get("quality_fail_count"),
                "exit_max_spread_in_window": exit_.get("max_spread_in_window"),
                "exit_min_spread_in_window": exit_.get("min_spread_in_window"),
                "bbo_mbp_matched": bool(matched),
                "bbo_bidask_return": bbo_return,
                "bbo_bidask_pnl_usd": bbo_pnl,
                "bbo_bidask_pnl_2x_fee_usd": bbo_2x,
                "bbo_mid_pnl_usd": bbo_mid_pnl,
                "bbo_spread_cost_usd": bbo_mid_pnl - bbo_pnl if matched else math.nan,
                "pnl_delta_bbo_vs_anchor_usd": bbo_pnl - float(tr["anchor_pnl"]) if matched else math.nan,
                "pnl_delta_bbo_vs_official_usd": bbo_pnl - float(tr["official_settlement_pnl"]) if matched else math.nan,
            }
        )
    return pd.DataFrame(rows)


def build_cost_stress(bbo: pd.DataFrame, total_signals: int) -> list[dict[str, Any]]:
    matched = bbo[bbo["bbo_mbp_matched"]].copy()
    if matched.empty:
        return []
    base_notional = pd.to_numeric(matched["notional_usd"], errors="coerce").fillna(0.0)
    base_fee = pd.to_numeric(matched["fee_usd"], errors="coerce").fillna(0.0)
    gross = pd.to_numeric(matched["bbo_bidask_return"], errors="coerce").fillna(0.0) * base_notional
    rows: list[dict[str, Any]] = []
    for fee_mult in [1.0, 2.0]:
        for bps_per_side in [0.0, 0.5, 1.0, 2.0, 3.0, 5.0]:
            pnl = gross - fee_mult * base_fee - base_notional * (bps_per_side / 10_000.0) * 2.0
            rows.append(
                {
                    "scenario": f"repaired_bbo_fee_{fee_mult:g}x_plus_{bps_per_side:g}bps_per_side",
                    "fee_multiplier": fee_mult,
                    "extra_slippage_bps_per_side": bps_per_side,
                    **metric_block(pnl.tolist(), total_signals=total_signals, executed=len(matched)),
                }
            )
    return rows


def build_stage_audit(bbo: pd.DataFrame) -> pd.DataFrame:
    if bbo.empty:
        return pd.DataFrame()
    stage = bbo.copy()
    stage["stage_pair"] = stage["entry_repair_stage"].fillna("missing") + " -> " + stage["exit_repair_stage"].fillna("missing")
    return (
        stage.groupby(["bbo_mbp_matched", "stage_pair", "split"], dropna=False)
        .agg(
            count=("trade_id_v130", "size"),
            anchor_pnl_usd=("anchor_pnl", "sum"),
            bbo_pnl_usd=("bbo_bidask_pnl_usd", "sum"),
            official_pnl_usd=("official_settlement_pnl", "sum"),
            avg_entry_wait_sec=("entry_seconds_away", "mean"),
            avg_exit_wait_sec=("exit_seconds_away", "mean"),
        )
        .reset_index()
    )


def build_summary(replay: pd.DataFrame, bbo: pd.DataFrame, stress: list[dict[str, Any]], v131_summary: dict[str, Any]) -> dict[str, Any]:
    v131_executed = replay[replay["matched"]].copy()
    matched = bbo[bbo["bbo_mbp_matched"]].copy()
    total_signals = int(len(replay))
    total_v131 = int(len(v131_executed))
    coverage = float(len(matched) / total_v131) if total_v131 else 0.0

    bbo_metrics = metric_block(pd.to_numeric(matched["bbo_bidask_pnl_usd"], errors="coerce").fillna(0.0).tolist(), total_signals, len(matched))
    bbo_2x_metrics = metric_block(pd.to_numeric(matched["bbo_bidask_pnl_2x_fee_usd"], errors="coerce").fillna(0.0).tolist(), total_signals, len(matched))
    anchor_same = metric_block(pd.to_numeric(matched["anchor_pnl"], errors="coerce").fillna(0.0).tolist(), total_signals, len(matched))
    official_same = metric_block(pd.to_numeric(matched["official_settlement_pnl"], errors="coerce").fillna(0.0).tolist(), total_signals, len(matched))

    stress_ref: dict[str, Any] = {}
    stress_df = pd.DataFrame(stress)
    if not stress_df.empty:
        ref = stress_df[(stress_df["fee_multiplier"] == 2.0) & (stress_df["extra_slippage_bps_per_side"] == 1.0)]
        if not ref.empty:
            stress_ref = ref.iloc[0].to_dict()

    split: dict[str, Any] = {}
    total_by_split = v131_executed.groupby("split").size().to_dict()
    for name in ["rolling", "holdout"]:
        sub = matched[matched["split"] == name]
        signals = int(total_by_split.get(name, 0))
        split[name] = {
            "signals": signals,
            "matched": int(len(sub)),
            "coverage_rate": float(len(sub) / signals) if signals else 0.0,
            "bbo_net_pnl_usd": float(pd.to_numeric(sub["bbo_bidask_pnl_usd"], errors="coerce").fillna(0.0).sum()),
            "anchor_same_subset_net_pnl_usd": float(pd.to_numeric(sub["anchor_pnl"], errors="coerce").fillna(0.0).sum()),
            "official_same_subset_net_pnl_usd": float(pd.to_numeric(sub["official_settlement_pnl"], errors="coerce").fillna(0.0).sum()),
            "bbo_profit_factor": metric_block(pd.to_numeric(sub["bbo_bidask_pnl_usd"], errors="coerce").fillna(0.0).tolist()).get("profit_factor", 0.0),
        }

    stage_counts = bbo[["entry_repair_stage", "exit_repair_stage", "bbo_mbp_matched"]].value_counts(dropna=False).reset_index(name="count").to_dict("records")
    quality_fail_trades = int(
        (
            (bbo.get("entry_bbo_status", pd.Series(dtype=str)) == "quote_quality_fail_after_anchor")
            | (bbo.get("exit_bbo_status", pd.Series(dtype=str)) == "quote_quality_fail_after_anchor")
        ).sum()
    )
    missing_trades = int(total_v131 - len(matched))
    actual = {
        "bbo_mbp_coverage_of_v131_executed": coverage,
        "bbo_bidask_net_pnl_usd": bbo_metrics["net_pnl_usd"],
        "bbo_bidask_2x_fee_net_pnl_usd": bbo_2x_metrics["net_pnl_usd"],
        "stress_2x_fee_plus_1bps_net_pnl_usd": stress_ref.get("net_pnl_usd"),
        "pnl_corr_vs_v131_anchor": safe_corr(matched.get("anchor_pnl", pd.Series(dtype=float)), matched.get("bbo_bidask_pnl_usd", pd.Series(dtype=float))),
        "sign_match_vs_v131_anchor": sign_match(matched.get("anchor_pnl", pd.Series(dtype=float)), matched.get("bbo_bidask_pnl_usd", pd.Series(dtype=float))),
        "mean_abs_pnl_delta_vs_v131_anchor": float(pd.to_numeric(matched.get("pnl_delta_bbo_vs_anchor_usd", pd.Series(dtype=float)), errors="coerce").abs().mean()) if not matched.empty else None,
        "rolling_bbo_net_pnl_usd": split["rolling"]["bbo_net_pnl_usd"],
        "holdout_bbo_net_pnl_usd": split["holdout"]["bbo_net_pnl_usd"],
    }
    gate_passed = (
        coverage >= 0.80
        and actual["bbo_bidask_net_pnl_usd"] > 0
        and actual["bbo_bidask_2x_fee_net_pnl_usd"] > 0
        and (actual["stress_2x_fee_plus_1bps_net_pnl_usd"] or -1) > 0
        and actual["pnl_corr_vs_v131_anchor"] >= 0.90
        and actual["sign_match_vs_v131_anchor"] >= 0.90
        and actual["rolling_bbo_net_pnl_usd"] > 0
        and actual["holdout_bbo_net_pnl_usd"] > 0
    )
    if gate_passed:
        status = "gold_bbo_mbp_coverage_repair_candidate"
        decision = "promote_repaired_bbo_mbp_cost_layer"
    elif coverage < 0.80:
        status = "gold_bbo_mbp_coverage_repair_watchlist_insufficient_coverage"
        decision = "keep_v1_31_until_clean_bbo_mbp_coverage_reaches_gate"
    else:
        status = "gold_bbo_mbp_coverage_repair_not_promoted_keep_v131"
        decision = "keep_v1_31_skip_uncovered_baseline"

    return {
        "version": VERSION,
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "status": status,
        "source": {
            "baseline": "V1.31 skip-uncovered execution paper baseline",
            "repair_method": "first quality quote after frozen anchor; no price optimization",
            "dataset": DATASET,
            "schemas_requested": FETCH_SCHEMA_ORDER,
            "lookback_minutes": LOOKBACK_MINUTES,
            "lookahead_minutes": LOOKAHEAD_MINUTES,
            "quote_max_wait_seconds": QUOTE_MAX_WAIT_SECONDS,
            "quote_quality": {
                "max_spread_abs_usd": QUOTE_MAX_SPREAD_ABS,
                "max_spread_bps": QUOTE_MAX_SPREAD_BPS,
                "min_top_book_size": QUOTE_MIN_TOP_BOOK_SIZE,
            },
            "q_or_trailing_tuning": "not_allowed_in_v1_34",
        },
        "v131_reference": v131_summary,
        "coverage": {
            "total_signals": total_signals,
            "v131_executed": total_v131,
            "bbo_mbp_matched": int(len(matched)),
            "bbo_mbp_missing": missing_trades,
            "coverage_of_v131_executed": coverage,
            "quote_quality_fail_trades": quality_fail_trades,
        },
        "bbo_bidask_metrics": bbo_metrics,
        "bbo_bidask_2x_fee_metrics": bbo_2x_metrics,
        "anchor_same_subset_metrics": anchor_same,
        "official_same_subset_metrics": official_same,
        "alignment": {
            "pnl_corr_vs_v131_anchor": actual["pnl_corr_vs_v131_anchor"],
            "sign_match_vs_v131_anchor": actual["sign_match_vs_v131_anchor"],
            "mean_abs_pnl_delta_vs_v131_anchor": actual["mean_abs_pnl_delta_vs_v131_anchor"],
            "pnl_corr_vs_official": safe_corr(matched.get("official_settlement_pnl", pd.Series(dtype=float)), matched.get("bbo_bidask_pnl_usd", pd.Series(dtype=float))),
            "sign_match_vs_official": sign_match(matched.get("official_settlement_pnl", pd.Series(dtype=float)), matched.get("bbo_bidask_pnl_usd", pd.Series(dtype=float))),
        },
        "split": split,
        "repair_stage_counts": clean_json(stage_counts),
        "stress_reference": stress_ref,
        "gate": {
            "requires": {
                "bbo_mbp_coverage_of_v131_executed": ">= 0.80",
                "bbo_bidask_net_pnl_usd": "> 0",
                "bbo_bidask_2x_fee_net_pnl_usd": "> 0",
                "stress_2x_fee_plus_1bps_net_pnl_usd": "> 0",
                "pnl_corr_vs_v131_anchor": ">= 0.90",
                "sign_match_vs_v131_anchor": ">= 0.90",
                "rolling_and_holdout_bbo_net_pnl": "> 0",
            },
            "actual": actual,
            "passed": bool(gate_passed),
        },
        "decision": decision,
        "next_step": "If coverage still fails, repair raw contract/time-source coverage before Q/trailing. If gate passes, freeze V1.34 as executable cost baseline.",
    }


def create_plot(bbo: pd.DataFrame, summary: dict[str, Any], out: Path) -> None:
    fig, axes = plt.subplots(2, 2, figsize=(14, 9))
    matched = bbo[bbo["bbo_mbp_matched"]].copy()
    if not matched.empty:
        ordered = matched.sort_values(["date", "trade_id_v130"]).reset_index(drop=True)
        axes[0, 0].plot(np.cumsum(ordered["anchor_pnl"]), label="V1.31 anchor")
        axes[0, 0].plot(np.cumsum(ordered["bbo_bidask_pnl_usd"]), label="V1.34 repaired BBO")
        axes[0, 0].legend()
        axes[0, 1].hist(ordered["pnl_delta_bbo_vs_anchor_usd"].dropna(), bins=20)
        axes[1, 0].scatter(ordered["anchor_pnl"], ordered["bbo_bidask_pnl_usd"], alpha=0.75)
        lim = max(abs(ordered["anchor_pnl"]).max(), abs(ordered["bbo_bidask_pnl_usd"]).max())
        axes[1, 0].plot([-lim, lim], [-lim, lim], linestyle="--", color="gray")
        waits = pd.concat([ordered["entry_seconds_away"], ordered["exit_seconds_away"]], ignore_index=True).dropna()
        axes[1, 1].hist(waits / 60.0, bins=20)
    axes[0, 0].set_title("Cumulative PnL on repaired BBO subset")
    axes[0, 1].set_title("Repaired BBO PnL delta vs V1.31")
    axes[1, 0].set_title("Anchor vs repaired BBO PnL")
    axes[1, 1].set_title("Execution wait minutes")
    for ax in axes.flat:
        ax.grid(alpha=0.25)
    fig.suptitle(f"{summary['status']} | coverage {summary['coverage']['coverage_of_v131_executed']:.1%}", y=1.02)
    fig.tight_layout()
    fig.savefig(out, dpi=180, bbox_inches="tight")
    plt.close(fig)


def write_report(summary: dict[str, Any]) -> None:
    cov = summary["coverage"]
    m = summary["bbo_bidask_metrics"]
    a = summary["anchor_same_subset_metrics"]
    align = summary["alignment"]
    split = summary["split"]
    lines = [
        f"# {VERSION}",
        "",
        "## 定位",
        "",
        "V1.34 只修真实盘口成本层覆盖率：保持 V1.31 交易集合和冻结锚点不变，从锚点后向前寻找首个质量合格 BBO/MBP。",
        "本阶段不调信号、不调 Q 动态退出、不调 trailing，也不补未覆盖交易。",
        "",
        "## 结论",
        "",
        f"- 状态：`{summary['status']}`",
        f"- 决策：`{summary['decision']}`",
        f"- V1.31 已执行交易：{cov['v131_executed']}",
        f"- V1.34 合格 BBO/MBP 覆盖：{cov['bbo_mbp_matched']}，覆盖率 {cov['coverage_of_v131_executed']:.2%}",
        f"- 盘口质量失败交易：{cov['quote_quality_fail_trades']}",
        f"- repaired BBO bid/ask 净收益：${m['net_pnl_usd']:.2f}，PF {m['profit_factor']:.3f}，最大回撤 ${m['max_drawdown_usd']:.2f}",
        f"- 同子集 V1.31 anchor 净收益：${a['net_pnl_usd']:.2f}，PF {a['profit_factor']:.3f}",
        f"- 2x fee + 1bps/side 净收益：${summary['stress_reference'].get('net_pnl_usd', 0.0):.2f}",
        f"- Anchor vs repaired BBO PnL 相关：{align['pnl_corr_vs_v131_anchor']:.3f}",
        f"- Anchor vs repaired BBO 方向一致：{align['sign_match_vs_v131_anchor']:.2%}",
        "",
        "## 分段结果",
        "",
        f"- rolling BBO 净收益：${split.get('rolling', {}).get('bbo_net_pnl_usd', 0.0):.2f}，覆盖率 {split.get('rolling', {}).get('coverage_rate', 0.0):.2%}",
        f"- holdout BBO 净收益：${split.get('holdout', {}).get('bbo_net_pnl_usd', 0.0):.2f}，覆盖率 {split.get('holdout', {}).get('coverage_rate', 0.0):.2%}",
        "",
        "## Gate",
        "",
        f"- passed：{summary['gate']['passed']}",
        f"- actual：`{json.dumps(summary['gate']['actual'], ensure_ascii=False)}`",
        "",
        "## 解释",
        "",
        "V1.34 使用的是首个合格盘口，不挑最优价，因此不会把覆盖修复变成事后择价。",
        "如果覆盖率仍未达到 80%，不能晋级；下一步应修原始合约/时间源覆盖，而不是调 Q/trailing。",
        "",
        "## 输出文件",
        "",
        "- `hfcd_trading_v1_34_bbo_mbp_repaired_replay.csv`",
        "- `hfcd_trading_v1_34_bbo_fetch_log.csv`",
        "- `hfcd_trading_v1_34_coverage_by_stage.csv`",
        "- `hfcd_trading_v1_34_cost_stress_matrix.csv`",
        "- `hfcd_trading_v1_34_summary.json`",
        "- `HFCD_Trading_V1_34_GoldBboMbpCoverageRepair.png`",
    ]
    (OUT_DIR / "HFCD_Trading_V1_34_GoldBboMbpCoverageRepair.md").write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    replay, v131_summary = v33.load_inputs()
    store = RepairBookStore()
    repaired = replay_with_repaired_quotes(replay, store)
    stress = build_cost_stress(repaired, total_signals=len(replay))
    stage = build_stage_audit(repaired)
    summary = build_summary(replay, repaired, stress, v131_summary)

    repaired.to_csv(OUT_DIR / "hfcd_trading_v1_34_bbo_mbp_repaired_replay.csv", index=False)
    write_csv(OUT_DIR / "hfcd_trading_v1_34_bbo_fetch_log.csv", store.fetch_log)
    stage.to_csv(OUT_DIR / "hfcd_trading_v1_34_coverage_by_stage.csv", index=False)
    write_csv(OUT_DIR / "hfcd_trading_v1_34_cost_stress_matrix.csv", stress)
    with (OUT_DIR / "hfcd_trading_v1_34_summary.json").open("w", encoding="utf-8") as f:
        json.dump(clean_json(summary), f, ensure_ascii=False, indent=2)
    write_csv(OUT_DIR / "hfcd_trading_v1_34_summary.csv", [clean_json(summary)])
    create_plot(repaired, summary, OUT_DIR / "HFCD_Trading_V1_34_GoldBboMbpCoverageRepair.png")
    write_report(summary)
    print(json.dumps(clean_json(summary), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
