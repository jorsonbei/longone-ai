#!/usr/bin/env python3
"""
HFCD Trading V1.27 Gold Settlement Anchor Calibration.

V1.26 proved the V1.24 real-minute replay used the wrong holding window, but a
fixed 20:00 UTC close-to-close anchor still did not reconstruct V1.22 closely
enough. V1.27 does not tune Q/trailing. It calibrates where the V1.22 daily
front-close/next-close values live inside the real Databento minute feed and
separates three cases:

1. Daily lineage: V1.22 front_close must exactly match Databento ohlcv-1d.
2. Settlement proxy: nearest minute price to the daily close/next close.
3. Fixed anchor: a systematic time-of-day anchor learned from rolling trades.

Only if a systematic fixed anchor is good enough should later minute-level
Q/trailing experiments be considered statistically meaningful.
"""

from __future__ import annotations

import csv
import json
import os
import math
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


VERSION = "HFCD_Trading_V1_27_GoldSettlementAnchorCalibration"
ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v1_27_gold_settlement_anchor_calibration"
V22_DIR = ROOT / "outputs" / "hfcd_trading_v1_22_gold_execution_qdrift_replay"
V26_DIR = ROOT / "outputs" / "hfcd_trading_v1_26_gold_close_to_close_minute_alignment"
V16_DAILY = ROOT / "outputs" / "hfcd_trading_v1_16_gold_full_acquisition" / "hfcd_trading_v1_16_gc_ohlcv_1d_history.csv"
V22_HOLDOUT = V22_DIR / "hfcd_trading_v1_22_holdout_trades.csv"
V22_ROLLING = V22_DIR / "hfcd_trading_v1_22_rolling_trades.csv"
V26_FEED = V26_DIR / "hfcd_trading_v1_26_minute_alignment.csv"
V26_RECON = V26_DIR / "hfcd_trading_v1_26_reconstruction.csv"

FROZEN_VARIANT = "q_soft_reduce_floor_1p10"
FROZEN_FRICTION = "l2_estimated"


@dataclass(frozen=True)
class Config:
    exact_price_tolerance: float = 0.05
    settlement_price_tolerance: float = 1.00
    fixed_anchor_max_minutes_away: int = 240
    fixed_anchor_grid_minutes: int = 5
    settlement_window_start_hour: int = 18
    settlement_window_end_next_hour: int = 3


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
    if df.empty:
        return {
            "matched_trades": 0,
            "pnl_corr": 0.0,
            "sign_match": 0.0,
            "mean_abs_diff": 999.0,
            "median_abs_diff": 999.0,
            "metrics": metrics([]),
        }
    diff = pd.to_numeric(df[pnl_col], errors="coerce") - pd.to_numeric(df["v1_22_original_pnl"], errors="coerce")
    return {
        "matched_trades": int(len(df)),
        "pnl_corr": safe_corr(df["v1_22_original_pnl"], df[pnl_col]),
        "sign_match": sign_match(df["v1_22_original_pnl"], df[pnl_col]),
        "mean_abs_diff": float(diff.abs().mean()),
        "median_abs_diff": float(diff.abs().median()),
        "metrics": metrics(pd.to_numeric(df[pnl_col], errors="coerce").fillna(0.0).astype(float).tolist()),
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


def load_daily() -> pd.DataFrame:
    if not V16_DAILY.exists():
        raise FileNotFoundError(V16_DAILY)
    daily = pd.read_csv(V16_DAILY)
    daily["date"] = pd.to_datetime(daily["ts_event"], errors="coerce", utc=True).dt.date.astype(str)
    for col in ["open", "high", "low", "close", "volume"]:
        daily[col] = pd.to_numeric(daily[col], errors="coerce")
    return daily.sort_values(["symbol", "date"]).reset_index(drop=True)


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def get_historical_client() -> Any | None:
    load_env_file(ROOT / ".env.local")
    load_env_file(ROOT / ".dev.vars")
    key = os.environ.get("DATABENTO_API_KEY")
    if not key:
        return None
    import databento as db  # type: ignore

    return db.Historical(key=key)


def attach_daily_lineage(trades: pd.DataFrame, daily: pd.DataFrame) -> tuple[pd.DataFrame, dict[str, Any]]:
    daily_by_symbol = {symbol: g.sort_values("date").reset_index(drop=True) for symbol, g in daily.groupby("symbol")}
    all_daily = daily.sort_values(["date", "symbol"]).reset_index(drop=True)
    rows: list[dict[str, Any]] = []
    for _, trade in trades.iterrows():
        symbol = str(trade["front_symbol"])
        signal_date = pd.Timestamp(trade["date"]).date().isoformat()
        expected_exit = float(trade["front_close"]) * (1.0 + float(trade["front_ret_next"]))
        g = daily_by_symbol.get(symbol, pd.DataFrame())
        entry_matches = g[g["date"] == signal_date].copy()
        entry_idx = int(entry_matches.index[0]) if not entry_matches.empty else -1
        entry_daily_close = float(entry_matches["close"].iloc[0]) if not entry_matches.empty else math.nan
        exit_date = ""
        exit_symbol = symbol
        exit_daily_close = math.nan
        exit_source = "missing"
        same_symbol_next_diff = math.nan
        if entry_idx >= 0 and entry_idx + 1 < len(g):
            next_row = g.iloc[entry_idx + 1]
            exit_date = str(next_row["date"])
            exit_symbol = str(next_row["symbol"])
            exit_daily_close = float(next_row["close"])
            exit_source = "next_daily_row"
            same_symbol_next_diff = exit_daily_close - expected_exit
        if math.isnan(exit_daily_close) or abs(exit_daily_close - expected_exit) > 1e-6:
            future = all_daily[all_daily["date"] > signal_date].copy()
            if not future.empty:
                future["abs_diff"] = (future["close"] - expected_exit).abs()
                exact = future[future["abs_diff"] <= 1e-6].copy()
                if not exact.empty:
                    next_row = exact.sort_values(["date", "symbol"]).iloc[0]
                    exit_date = str(next_row["date"])
                    exit_symbol = str(next_row["symbol"])
                    exit_daily_close = float(next_row["close"])
                    exit_source = "exact_close_cross_contract"
                elif math.isnan(exit_daily_close):
                    next_row = future.sort_values(["abs_diff", "date", "symbol"]).iloc[0]
                    exit_date = str(next_row["date"])
                    exit_symbol = str(next_row["symbol"])
                    exit_daily_close = float(next_row["close"])
                    exit_source = "nearest_future_close_cross_contract"
        rows.append(
            {
                "trade_id": int(trade["trade_id"]),
                "signal_date": signal_date,
                "source_split": trade["source_split"],
                "fold": trade["fold"],
                "front_symbol": symbol,
                "exit_symbol": exit_symbol,
                "v1_22_front_close": float(trade["front_close"]),
                "daily_entry_close": entry_daily_close,
                "daily_entry_close_diff": entry_daily_close - float(trade["front_close"]) if not math.isnan(entry_daily_close) else math.nan,
                "exit_daily_date": exit_date,
                "v1_22_expected_exit_close": expected_exit,
                "daily_exit_close": exit_daily_close,
                "daily_exit_close_diff": exit_daily_close - expected_exit if not math.isnan(exit_daily_close) else math.nan,
                "exit_source": exit_source,
                "same_symbol_next_close_diff": same_symbol_next_diff,
                "roll_detected": exit_symbol != symbol,
            }
        )
    lineage = pd.DataFrame(rows)
    entry_exact = (lineage["daily_entry_close_diff"].abs() <= 1e-9).mean() if not lineage.empty else 0.0
    exit_exact = (lineage["daily_exit_close_diff"].abs() <= 1e-6).mean() if not lineage.empty else 0.0
    audit = {
        "selected_trade_count": int(len(lineage)),
        "entry_daily_exact_match_rate": float(entry_exact),
        "exit_daily_exact_match_rate": float(exit_exact),
        "max_abs_entry_daily_diff": float(lineage["daily_entry_close_diff"].abs().max()) if not lineage.empty else 999.0,
        "max_abs_exit_daily_diff": float(lineage["daily_exit_close_diff"].abs().max()) if not lineage.empty else 999.0,
        "roll_detected_count": int(lineage["roll_detected"].sum()) if not lineage.empty else 0,
    }
    return lineage, audit


def load_minute_feed() -> pd.DataFrame:
    if not V26_FEED.exists():
        raise FileNotFoundError(V26_FEED)
    feed = pd.read_csv(V26_FEED)
    feed["timestamp"] = pd.to_datetime(feed["timestamp"], errors="coerce", utc=True)
    for col in ["trade_id", "close", "mid_price", "volume"]:
        feed[col] = pd.to_numeric(feed[col], errors="coerce")
    feed = feed.dropna(subset=["timestamp", "trade_id", "close"]).copy()
    feed["trade_id"] = feed["trade_id"].astype(int)
    feed["minute_of_day"] = feed["timestamp"].dt.hour * 60 + feed["timestamp"].dt.minute
    return feed.sort_values(["trade_id", "timestamp"]).reset_index(drop=True)


def search_window_for_date(date_str: str, cfg: Config) -> tuple[pd.Timestamp, pd.Timestamp]:
    start = pd.Timestamp(date_str, tz="UTC") + pd.Timedelta(hours=cfg.settlement_window_start_hour)
    end = pd.Timestamp(date_str, tz="UTC") + pd.Timedelta(days=1, hours=cfg.settlement_window_end_next_hour)
    return start, end


def normalize_extra_minutes(raw: pd.DataFrame, *, trade_id: int, symbol: str) -> pd.DataFrame:
    if raw.empty:
        return pd.DataFrame()
    out = raw.copy()
    ts_col = "ts_event" if "ts_event" in out.columns else out.columns[0]
    out["timestamp"] = pd.to_datetime(out[ts_col], errors="coerce", utc=True)
    for col in ["open", "high", "low", "close", "volume"]:
        out[col] = pd.to_numeric(out.get(col), errors="coerce")
    out = out.dropna(subset=["timestamp", "close"]).sort_values("timestamp").drop_duplicates("timestamp")
    out["trade_id"] = trade_id
    out["symbol"] = symbol
    out["mid_price"] = out["close"]
    out["minute_of_day"] = out["timestamp"].dt.hour * 60 + out["timestamp"].dt.minute
    return out[["timestamp", "trade_id", "symbol", "open", "high", "low", "close", "volume", "mid_price", "minute_of_day"]]


def fetch_extra_leg_window(client: Any | None, *, trade_id: int, symbol: str, daily_date: str, cfg: Config) -> pd.DataFrame:
    cache_dir = OUT_DIR / "cache_extra_legs"
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / f"ohlcv_1m_{trade_id}_{symbol}_{daily_date}.csv"
    if cache_path.exists() and cache_path.stat().st_size > 0:
        try:
            cached = pd.read_csv(cache_path)
            return normalize_extra_minutes(cached, trade_id=trade_id, symbol=symbol)
        except Exception:
            return pd.DataFrame()
    if client is None:
        return pd.DataFrame()
    start, end = search_window_for_date(daily_date, cfg)
    try:
        data = client.timeseries.get_range(
            dataset="GLBX.MDP3",
            schema="ohlcv-1m",
            symbols=[symbol],
            stype_in="raw_symbol",
            start=start.isoformat(),
            end=end.isoformat(),
        )
        raw = data.to_df().reset_index()
        raw.to_csv(cache_path, index=False)
        return normalize_extra_minutes(raw, trade_id=trade_id, symbol=symbol)
    except Exception:
        return pd.DataFrame()


def build_leg_feeds(lineage: pd.DataFrame, base_feed: pd.DataFrame, cfg: Config) -> tuple[dict[tuple[int, str], pd.DataFrame], list[dict[str, Any]]]:
    client = get_historical_client()
    leg_feeds: dict[tuple[int, str], pd.DataFrame] = {}
    audit_rows: list[dict[str, Any]] = []
    for _, row in lineage.iterrows():
        tid = int(row["trade_id"])
        base = base_feed[base_feed["trade_id"] == tid].copy()
        entry_symbol = str(row["front_symbol"])
        exit_symbol = str(row["exit_symbol"])
        entry_feed = base[base["symbol"] == entry_symbol].copy() if "symbol" in base.columns else base.copy()
        if entry_feed.empty:
            entry_feed = base.copy()
        exit_feed = base[base["symbol"] == exit_symbol].copy() if "symbol" in base.columns else pd.DataFrame()
        exit_fetch_status = "base_feed"
        if exit_feed.empty:
            exit_feed = fetch_extra_leg_window(client, trade_id=tid, symbol=exit_symbol, daily_date=str(row["exit_daily_date"]), cfg=cfg)
            exit_fetch_status = "extra_fetch" if not exit_feed.empty else "missing_exit_leg_feed"
        leg_feeds[(tid, "entry")] = entry_feed
        leg_feeds[(tid, "exit")] = exit_feed
        audit_rows.append(
            {
                "trade_id": tid,
                "entry_symbol": entry_symbol,
                "exit_symbol": exit_symbol,
                "roll_detected": bool(row["roll_detected"]),
                "entry_rows": int(len(entry_feed)),
                "exit_rows": int(len(exit_feed)),
                "exit_fetch_status": exit_fetch_status,
            }
        )
    return leg_feeds, audit_rows


def find_settlement_proxy(g: pd.DataFrame, *, daily_date: str, target_price: float, cfg: Config, label: str) -> dict[str, Any]:
    if g.empty or not daily_date or math.isnan(target_price):
        return {
            f"{label}_settlement_found": False,
            f"{label}_settlement_search_mode": "missing_input",
        }
    start, end = search_window_for_date(daily_date, cfg)
    sub = g[(g["timestamp"] >= start) & (g["timestamp"] <= end)].copy()
    search_mode = "settlement_window"
    if sub.empty:
        # Some expiring contracts are very sparse. Use a broader but labelled
        # fallback so it cannot be mistaken for a tradable fixed anchor.
        day0 = pd.Timestamp(daily_date, tz="UTC") - pd.Timedelta(hours=6)
        day1 = pd.Timestamp(daily_date, tz="UTC") + pd.Timedelta(days=2)
        sub = g[(g["timestamp"] >= day0) & (g["timestamp"] <= day1)].copy()
        search_mode = "date_extended_fallback"
    if sub.empty:
        sub = g.copy()
        search_mode = "full_trade_window_fallback"
    sub["price_diff"] = (sub["close"] - target_price).abs()
    row = sub.sort_values(["price_diff", "timestamp"]).iloc[0]
    ts = pd.Timestamp(row["timestamp"])
    price = float(row["close"])
    price_diff = float(abs(price - target_price))
    return {
        f"{label}_settlement_found": True,
        f"{label}_settlement_search_mode": search_mode,
        f"{label}_settlement_timestamp": ts.isoformat(),
        f"{label}_settlement_time_utc": ts.strftime("%H:%M"),
        f"{label}_settlement_minute_of_day": int(ts.hour * 60 + ts.minute),
        f"{label}_settlement_price": price,
        f"{label}_settlement_target": float(target_price),
        f"{label}_settlement_price_diff": price_diff,
        f"{label}_settlement_exact": price_diff <= cfg.exact_price_tolerance,
        f"{label}_settlement_within_1pt": price_diff <= cfg.settlement_price_tolerance,
        f"{label}_settlement_volume": float(row.get("volume", 0.0) or 0.0),
    }


def reconstruct_settlement_proxy(
    trades: pd.DataFrame,
    lineage: pd.DataFrame,
    leg_feeds: dict[tuple[int, str], pd.DataFrame],
    cfg: Config,
) -> pd.DataFrame:
    trade_lookup = {int(row["trade_id"]): row for _, row in trades.iterrows()}
    lineage_lookup = {int(row["trade_id"]): row for _, row in lineage.iterrows()}
    rows: list[dict[str, Any]] = []
    for tid in sorted(trade_lookup):
        if tid not in trade_lookup or tid not in lineage_lookup:
            continue
        trade = trade_lookup[tid]
        meta = lineage_lookup[tid]
        entry_g = leg_feeds.get((tid, "entry"), pd.DataFrame())
        exit_g = leg_feeds.get((tid, "exit"), pd.DataFrame())
        entry = find_settlement_proxy(
            entry_g,
            daily_date=str(meta["signal_date"]),
            target_price=float(meta["v1_22_front_close"]),
            cfg=cfg,
            label="entry",
        )
        exit_ = find_settlement_proxy(
            exit_g,
            daily_date=str(meta["exit_daily_date"]),
            target_price=float(meta["v1_22_expected_exit_close"]),
            cfg=cfg,
            label="exit",
        )
        if not entry.get("entry_settlement_found") or not exit_.get("exit_settlement_found"):
            continue
        notional = float(trade["notional_usd"])
        fee = float(trade["fee_rate"]) * notional
        entry_price = float(entry["entry_settlement_price"])
        exit_price = float(exit_["exit_settlement_price"])
        settlement_return = exit_price / entry_price - 1.0 if entry_price else 0.0
        settlement_pnl = notional * settlement_return - fee
        rows.append(
            {
                "trade_id": tid,
                "source_split": trade["source_split"],
                "fold": trade["fold"],
                "signal_date": meta["signal_date"],
                "exit_daily_date": meta["exit_daily_date"],
                "front_symbol": trade["front_symbol"],
                "exit_symbol": meta["exit_symbol"],
                "roll_detected": bool(meta["roll_detected"]),
                "v1_22_original_pnl": float(trade["pnl_usd"]),
                "v1_22_front_close": float(meta["v1_22_front_close"]),
                "v1_22_expected_exit_close": float(meta["v1_22_expected_exit_close"]),
                "notional_usd_effective": notional,
                "fee_usd": fee,
                "settlement_proxy_return": settlement_return,
                "settlement_proxy_pnl": settlement_pnl,
                "settlement_proxy_pnl_diff": settlement_pnl - float(trade["pnl_usd"]),
                **entry,
                **exit_,
            }
        )
    return pd.DataFrame(rows)


def rounded_minute(minute: int, step: int) -> int:
    return int(round(minute / step) * step) % 1440


def time_label(minute: int) -> str:
    minute %= 1440
    return f"{minute // 60:02d}:{minute % 60:02d}"


def timestamp_for_anchor(daily_date: str, minute: int) -> pd.Timestamp:
    base = pd.Timestamp(daily_date, tz="UTC")
    # Settlement-like anchors after midnight usually belong to the next UTC date
    # of the daily session.
    if minute < 6 * 60:
        base += pd.Timedelta(days=1)
    return base + pd.Timedelta(minutes=int(minute))


def price_at_fixed_anchor(g: pd.DataFrame, *, daily_date: str, minute: int, cfg: Config, label: str) -> dict[str, Any]:
    if g.empty or not daily_date:
        return {f"{label}_fixed_found": False, f"{label}_fixed_reason": "missing_input"}
    target_ts = timestamp_for_anchor(daily_date, minute)
    start = target_ts - pd.Timedelta(minutes=cfg.fixed_anchor_max_minutes_away)
    end = target_ts + pd.Timedelta(minutes=cfg.fixed_anchor_max_minutes_away)
    sub = g[(g["timestamp"] >= start) & (g["timestamp"] <= end)].copy()
    if sub.empty:
        return {
            f"{label}_fixed_found": False,
            f"{label}_fixed_reason": "no_minute_near_anchor",
            f"{label}_fixed_anchor_timestamp": target_ts.isoformat(),
        }
    sub["time_diff_minutes"] = (sub["timestamp"] - target_ts).abs().dt.total_seconds() / 60.0
    row = sub.sort_values(["time_diff_minutes", "timestamp"]).iloc[0]
    ts = pd.Timestamp(row["timestamp"])
    return {
        f"{label}_fixed_found": True,
        f"{label}_fixed_reason": "matched",
        f"{label}_fixed_anchor_timestamp": target_ts.isoformat(),
        f"{label}_fixed_timestamp": ts.isoformat(),
        f"{label}_fixed_time_diff_minutes": float(row["time_diff_minutes"]),
        f"{label}_fixed_price": float(row["close"]),
    }


def reconstruct_fixed_anchor(
    trades: pd.DataFrame,
    lineage: pd.DataFrame,
    leg_feeds: dict[tuple[int, str], pd.DataFrame],
    cfg: Config,
    anchor_minute: int,
) -> pd.DataFrame:
    trade_lookup = {int(row["trade_id"]): row for _, row in trades.iterrows()}
    lineage_lookup = {int(row["trade_id"]): row for _, row in lineage.iterrows()}
    rows: list[dict[str, Any]] = []
    for tid in sorted(trade_lookup):
        if tid not in trade_lookup or tid not in lineage_lookup:
            continue
        trade = trade_lookup[tid]
        meta = lineage_lookup[tid]
        entry_g = leg_feeds.get((tid, "entry"), pd.DataFrame())
        exit_g = leg_feeds.get((tid, "exit"), pd.DataFrame())
        entry = price_at_fixed_anchor(entry_g, daily_date=str(meta["signal_date"]), minute=anchor_minute, cfg=cfg, label="entry")
        exit_ = price_at_fixed_anchor(exit_g, daily_date=str(meta["exit_daily_date"]), minute=anchor_minute, cfg=cfg, label="exit")
        if not entry.get("entry_fixed_found") or not exit_.get("exit_fixed_found"):
            continue
        notional = float(trade["notional_usd"])
        fee = float(trade["fee_rate"]) * notional
        entry_price = float(entry["entry_fixed_price"])
        exit_price = float(exit_["exit_fixed_price"])
        ret = exit_price / entry_price - 1.0 if entry_price else 0.0
        pnl = notional * ret - fee
        rows.append(
            {
                "trade_id": tid,
                "source_split": trade["source_split"],
                "fold": trade["fold"],
                "signal_date": meta["signal_date"],
                "exit_daily_date": meta["exit_daily_date"],
                "front_symbol": trade["front_symbol"],
                "exit_symbol": meta["exit_symbol"],
                "roll_detected": bool(meta["roll_detected"]),
                "anchor_minute_of_day": anchor_minute,
                "anchor_time_utc": time_label(anchor_minute),
                "v1_22_original_pnl": float(trade["pnl_usd"]),
                "v1_22_front_close": float(meta["v1_22_front_close"]),
                "v1_22_expected_exit_close": float(meta["v1_22_expected_exit_close"]),
                "fixed_anchor_return": ret,
                "fixed_anchor_pnl": pnl,
                "fixed_anchor_pnl_diff": pnl - float(trade["pnl_usd"]),
                "entry_price_basis": entry_price - float(meta["v1_22_front_close"]),
                "exit_price_basis": exit_price - float(meta["v1_22_expected_exit_close"]),
                **entry,
                **exit_,
            }
        )
    return pd.DataFrame(rows)


def candidate_anchor_minutes(proxy: pd.DataFrame, cfg: Config) -> list[int]:
    minutes: set[int] = set()
    for label in ["entry", "exit"]:
        col = f"{label}_settlement_minute_of_day"
        diff = f"{label}_settlement_price_diff"
        if col in proxy.columns:
            usable = proxy[pd.to_numeric(proxy[diff], errors="coerce").fillna(999.0) <= cfg.settlement_price_tolerance]
            for value in usable[col].dropna().astype(int):
                minutes.add(rounded_minute(int(value), cfg.fixed_anchor_grid_minutes))
    # Add a broad evening/midnight grid so the result is not constrained to the
    # oracle proxy timestamps.
    for minute in list(range(18 * 60, 24 * 60, cfg.fixed_anchor_grid_minutes)) + list(
        range(0, 4 * 60, cfg.fixed_anchor_grid_minutes)
    ):
        minutes.add(minute)
    return sorted(minutes)


def evaluate_fixed_anchors(
    trades: pd.DataFrame,
    lineage: pd.DataFrame,
    leg_feeds: dict[tuple[int, str], pd.DataFrame],
    proxy: pd.DataFrame,
    cfg: Config,
) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    recon_by_anchor: dict[int, pd.DataFrame] = {}
    rolling_ids = set(trades[trades["source_split"] == "rolling"]["trade_id"].astype(int).tolist())
    holdout_ids = set(trades[trades["source_split"] == "holdout"]["trade_id"].astype(int).tolist())
    for minute in candidate_anchor_minutes(proxy, cfg):
        recon = reconstruct_fixed_anchor(trades, lineage, leg_feeds, cfg, minute)
        recon_by_anchor[minute] = recon
        rolling = recon[recon["trade_id"].isin(rolling_ids)] if not recon.empty else pd.DataFrame()
        holdout = recon[recon["trade_id"].isin(holdout_ids)] if not recon.empty else pd.DataFrame()
        all_audit = reconstruction_audit(recon, "fixed_anchor_pnl")
        rolling_audit = reconstruction_audit(rolling, "fixed_anchor_pnl")
        holdout_audit = reconstruction_audit(holdout, "fixed_anchor_pnl")
        rows.append(
            {
                "anchor_minute_of_day": minute,
                "anchor_time_utc": time_label(minute),
                "all_matched": all_audit["matched_trades"],
                "all_pnl_corr": all_audit["pnl_corr"],
                "all_sign_match": all_audit["sign_match"],
                "all_mean_abs_diff": all_audit["mean_abs_diff"],
                "all_net_pnl": all_audit["metrics"]["net_pnl_usd"],
                "rolling_matched": rolling_audit["matched_trades"],
                "rolling_pnl_corr": rolling_audit["pnl_corr"],
                "rolling_sign_match": rolling_audit["sign_match"],
                "rolling_mean_abs_diff": rolling_audit["mean_abs_diff"],
                "rolling_net_pnl": rolling_audit["metrics"]["net_pnl_usd"],
                "holdout_matched": holdout_audit["matched_trades"],
                "holdout_pnl_corr": holdout_audit["pnl_corr"],
                "holdout_sign_match": holdout_audit["sign_match"],
                "holdout_mean_abs_diff": holdout_audit["mean_abs_diff"],
                "holdout_net_pnl": holdout_audit["metrics"]["net_pnl_usd"],
            }
        )
    cand = pd.DataFrame(rows)
    if cand.empty:
        return cand, pd.DataFrame(), {}
    cand["rolling_score"] = (
        cand["rolling_pnl_corr"].fillna(0.0) * 100.0
        + cand["rolling_sign_match"].fillna(0.0) * 25.0
        - cand["rolling_mean_abs_diff"].fillna(999.0)
        + cand["rolling_matched"].fillna(0.0) * 0.1
    )
    best = cand.sort_values(["rolling_score", "rolling_matched"], ascending=[False, False]).iloc[0]
    best_minute = int(best["anchor_minute_of_day"])
    best_recon = recon_by_anchor.get(best_minute, pd.DataFrame())
    best_summary = best.to_dict()
    best_summary["selection_basis"] = "best rolling_score; holdout is out-of-sample check"
    return cand, best_recon, best_summary


def settlement_time_distribution(proxy: pd.DataFrame, cfg: Config) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for label in ["entry", "exit"]:
        time_col = f"{label}_settlement_time_utc"
        diff_col = f"{label}_settlement_price_diff"
        if time_col not in proxy.columns:
            continue
        usable = proxy[pd.to_numeric(proxy[diff_col], errors="coerce").fillna(999.0) <= cfg.settlement_price_tolerance]
        counts = usable[time_col].value_counts().head(20)
        for time_utc, count in counts.items():
            rows.append({"side": label, "time_utc": time_utc, "count": int(count)})
    return rows


def create_plot(proxy: pd.DataFrame, best_fixed: pd.DataFrame, candidates: pd.DataFrame, summary: dict[str, Any], path: Path) -> None:
    import matplotlib.pyplot as plt

    fig, axes = plt.subplots(2, 2, figsize=(14, 9))
    if not proxy.empty:
        ordered = proxy.sort_values(["signal_date", "trade_id"])
        axes[0, 0].plot(np.cumsum(ordered["v1_22_original_pnl"]), label="V1.22 daily")
        axes[0, 0].plot(np.cumsum(ordered["settlement_proxy_pnl"]), label="Settlement proxy")
        if not best_fixed.empty:
            fixed = best_fixed.sort_values(["signal_date", "trade_id"])
            axes[0, 0].plot(np.cumsum(fixed["fixed_anchor_pnl"]), label=f"Best fixed {summary.get('best_fixed_anchor_time_utc', '')}")
        axes[0, 0].legend()
        axes[0, 1].scatter(ordered["v1_22_original_pnl"], ordered["settlement_proxy_pnl"], s=18, label="settlement proxy")
        if not best_fixed.empty:
            axes[0, 1].scatter(best_fixed["v1_22_original_pnl"], best_fixed["fixed_anchor_pnl"], s=18, alpha=0.65, label="fixed anchor")
        axes[0, 1].axhline(0, color="gray", linewidth=0.8)
        axes[0, 1].axvline(0, color="gray", linewidth=0.8)
        axes[0, 1].legend()
        axes[1, 0].hist(ordered["entry_settlement_price_diff"], bins=20, alpha=0.7, label="entry diff")
        axes[1, 0].hist(ordered["exit_settlement_price_diff"], bins=20, alpha=0.55, label="exit diff")
        axes[1, 0].legend()
    if not candidates.empty:
        top = candidates.sort_values("rolling_score", ascending=False).head(30)
        axes[1, 1].bar(top["anchor_time_utc"], top["holdout_mean_abs_diff"])
        axes[1, 1].tick_params(axis="x", rotation=90)
    axes[0, 0].set_title("Cumulative PnL")
    axes[0, 1].set_title("PnL reconstruction scatter")
    axes[1, 0].set_title("Minute settlement proxy price diff")
    axes[1, 1].set_title("Top fixed anchors: holdout MAE")
    for ax in axes.ravel():
        ax.grid(alpha=0.25)
    fig.tight_layout()
    fig.savefig(path, dpi=180)
    plt.close(fig)


def write_report(summary: dict[str, Any], paths: dict[str, str]) -> None:
    daily = summary["daily_lineage_audit"]
    proxy = summary["settlement_proxy_audit"]
    fixed = summary["fixed_anchor_audit"]
    best = summary["best_fixed_anchor"]
    lines = [
        f"# {VERSION}",
        "",
        "## 定位",
        "",
        "V1.27 只校准黄金日线 close/settlement anchor，不升级策略、不调 Q/trailing。"
        " 目标是判断 V1.22 的日线收益能否被真实分钟 feed 解释，以及是否存在可复用的固定时间 anchor。",
        "",
        "## 1. 日线来源校验",
        "",
        f"- 交易数：{daily['selected_trade_count']}",
        f"- V1.22 entry close 与 Databento ohlcv-1d close 精确匹配率：{daily['entry_daily_exact_match_rate']:.2%}",
        f"- V1.22 next close 与 Databento ohlcv-1d next close 精确匹配率：{daily['exit_daily_exact_match_rate']:.2%}",
        f"- 最大 entry 日线差异：{daily['max_abs_entry_daily_diff']:.6f}",
        f"- 最大 exit 日线差异：{daily['max_abs_exit_daily_diff']:.6f}",
        "",
        "## 2. Settlement proxy 上界",
        "",
        f"- 匹配交易：{proxy['matched_trades']}",
        f"- PnL 相关性：{proxy['pnl_corr']:.3f}",
        f"- 方向一致率：{proxy['sign_match']:.2%}",
        f"- 平均单笔误差：${proxy['mean_abs_diff']:.2f}",
        f"- 中位单笔误差：${proxy['median_abs_diff']:.2f}",
        f"- entry close 1点内命中率：{summary['settlement_proxy_quality']['entry_within_1pt_rate']:.2%}",
        f"- exit close 1点内命中率：{summary['settlement_proxy_quality']['exit_within_1pt_rate']:.2%}",
        "",
        "| version | trades | win_rate | net_pnl | PF | max_dd |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for name, metrics_obj in [
        ("V1.22 daily", summary["v1_22_metrics"]),
        ("Settlement proxy", proxy["metrics"]),
        ("Best fixed anchor", fixed["metrics"]),
    ]:
        lines.append(
            f"| {name} | {metrics_obj.get('trades', 0)} | {metrics_obj.get('win_rate', 0):.2%} | "
            f"${metrics_obj.get('net_pnl_usd', 0):.2f} | {metrics_obj.get('profit_factor', 0):.3f} | ${metrics_obj.get('max_drawdown_usd', 0):.2f} |"
        )
    lines.extend(
        [
            "",
            "## 3. 固定时间 anchor 校准",
            "",
            f"- 训练选择：rolling 样本最高 rolling_score",
            f"- 最佳固定 anchor：{best.get('anchor_time_utc', '-')}",
            f"- Rolling corr / MAE：{best.get('rolling_pnl_corr', 0):.3f} / ${best.get('rolling_mean_abs_diff', 0):.2f}",
            f"- Holdout corr / MAE：{best.get('holdout_pnl_corr', 0):.3f} / ${best.get('holdout_mean_abs_diff', 0):.2f}",
            f"- 全样本 corr / MAE：{fixed['pnl_corr']:.3f} / ${fixed['mean_abs_diff']:.2f}",
            "",
            "## 4. 必答结论",
            "",
            f"1. V1.22 daily close 是否有确定来源？{summary['answers']['daily_close_lineage']}",
            f"2. 分钟 feed 是否含有 settlement proxy？{summary['answers']['minute_contains_settlement_proxy']}",
            f"3. 固定时间 anchor 是否足够重构 V1.22？{summary['answers']['fixed_anchor_is_sufficient']}",
            f"4. 是否允许继续优化 Q/trailing？{summary['answers']['q_trailing_permission']}",
            "",
            f"最终状态：`{summary['status']}`",
            "",
            "## 输出文件",
            "",
        ]
    )
    for label, path in paths.items():
        lines.append(f"- {label}: `{path}`")
    (OUT_DIR / "HFCD_Trading_V1_27_GoldSettlementAnchorCalibration.md").write_text(
        "\n".join(lines) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    cfg = Config()
    trades = load_selected_trades()
    daily = load_daily()
    lineage, lineage_audit = attach_daily_lineage(trades, daily)
    feed = load_minute_feed()
    leg_feeds, leg_feed_audit_rows = build_leg_feeds(lineage, feed, cfg)

    settlement_proxy = reconstruct_settlement_proxy(trades, lineage, leg_feeds, cfg)
    settlement_audit = reconstruction_audit(settlement_proxy, "settlement_proxy_pnl")
    quality = {
        "entry_exact_rate": float(settlement_proxy["entry_settlement_exact"].mean()) if not settlement_proxy.empty else 0.0,
        "exit_exact_rate": float(settlement_proxy["exit_settlement_exact"].mean()) if not settlement_proxy.empty else 0.0,
        "entry_within_1pt_rate": float(settlement_proxy["entry_settlement_within_1pt"].mean()) if not settlement_proxy.empty else 0.0,
        "exit_within_1pt_rate": float(settlement_proxy["exit_settlement_within_1pt"].mean()) if not settlement_proxy.empty else 0.0,
        "median_entry_price_diff": float(settlement_proxy["entry_settlement_price_diff"].median()) if not settlement_proxy.empty else 999.0,
        "median_exit_price_diff": float(settlement_proxy["exit_settlement_price_diff"].median()) if not settlement_proxy.empty else 999.0,
    }
    candidates, best_fixed_recon, best_fixed_anchor = evaluate_fixed_anchors(trades, lineage, leg_feeds, settlement_proxy, cfg)
    fixed_audit = reconstruction_audit(best_fixed_recon, "fixed_anchor_pnl")

    v1_22_metrics = metrics(trades["pnl_usd"].astype(float).tolist())
    settlement_pass = (
        settlement_audit["matched_trades"] >= 60
        and settlement_audit["pnl_corr"] >= 0.98
        and settlement_audit["mean_abs_diff"] <= 5.0
    )
    fixed_anchor_pass = (
        fixed_audit["matched_trades"] >= 60
        and fixed_audit["pnl_corr"] >= 0.90
        and fixed_audit["mean_abs_diff"] <= 25.0
        and float(best_fixed_anchor.get("holdout_pnl_corr", 0.0) or 0.0) >= 0.85
        and float(best_fixed_anchor.get("holdout_mean_abs_diff", 999.0) or 999.0) <= 30.0
    )
    if fixed_anchor_pass:
        status = "gold_fixed_settlement_anchor_calibrated"
        q_permission = "允许；固定时间 anchor 已达到分钟级重构门。"
        candidate_decision = "gold_fixed_settlement_anchor_candidate"
    elif settlement_pass:
        status = "settlement_proxy_validated_fixed_anchor_not_promoted"
        q_permission = "不允许；分钟数据能解释日线 settlement，但固定时间 anchor 仍未达到可交易重构精度。"
        candidate_decision = "watchlist_settlement_proxy_only"
    else:
        status = "settlement_anchor_unresolved"
        q_permission = "不允许；先补更完整分钟/settlement 数据。"
        candidate_decision = "blocked"

    answers = {
        "daily_close_lineage": "是。V1.22 front_close/next_close 与 Databento ohlcv-1d close 完全一致。"
        if lineage_audit["entry_daily_exact_match_rate"] == 1.0 and lineage_audit["exit_daily_exact_match_rate"] == 1.0
        else "不完全一致。",
        "minute_contains_settlement_proxy": "是。分钟 feed 内可找到接近日线 close 的 settlement proxy。"
        if settlement_pass
        else "不充分；部分交易找不到足够接近的分钟 proxy。",
        "fixed_anchor_is_sufficient": "是。固定时间 anchor 已通过重构门。"
        if fixed_anchor_pass
        else "否。最优固定 anchor 仍不能稳定重构 V1.22。",
        "q_trailing_permission": q_permission,
    }

    time_dist_rows = settlement_time_distribution(settlement_proxy, cfg)
    outputs = {
        "lineage": str((OUT_DIR / "hfcd_trading_v1_27_daily_lineage.csv").resolve()),
        "settlement_proxy": str((OUT_DIR / "hfcd_trading_v1_27_settlement_proxy_reconstruction.csv").resolve()),
        "fixed_anchor_candidates": str((OUT_DIR / "hfcd_trading_v1_27_fixed_anchor_candidates.csv").resolve()),
        "best_fixed_anchor_reconstruction": str((OUT_DIR / "hfcd_trading_v1_27_best_fixed_anchor_reconstruction.csv").resolve()),
        "settlement_time_distribution": str((OUT_DIR / "hfcd_trading_v1_27_settlement_time_distribution.csv").resolve()),
        "leg_feed_audit": str((OUT_DIR / "hfcd_trading_v1_27_leg_feed_audit.csv").resolve()),
        "summary_json": str((OUT_DIR / "hfcd_trading_v1_27_summary.json").resolve()),
        "summary_csv": str((OUT_DIR / "hfcd_trading_v1_27_summary.csv").resolve()),
        "report": str((OUT_DIR / "HFCD_Trading_V1_27_GoldSettlementAnchorCalibration.md").resolve()),
        "plot": str((OUT_DIR / "HFCD_Trading_V1_27_GoldSettlementAnchorCalibration.png").resolve()),
    }

    lineage.to_csv(outputs["lineage"], index=False)
    settlement_proxy.to_csv(outputs["settlement_proxy"], index=False)
    candidates.to_csv(outputs["fixed_anchor_candidates"], index=False)
    best_fixed_recon.to_csv(outputs["best_fixed_anchor_reconstruction"], index=False)
    write_csv(Path(outputs["settlement_time_distribution"]), time_dist_rows)
    write_csv(Path(outputs["leg_feed_audit"]), leg_feed_audit_rows)

    summary = {
        "version": VERSION,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "status": status,
        "candidate_decision": candidate_decision,
        "config": {
            "exact_price_tolerance": cfg.exact_price_tolerance,
            "settlement_price_tolerance": cfg.settlement_price_tolerance,
            "fixed_anchor_max_minutes_away": cfg.fixed_anchor_max_minutes_away,
            "fixed_anchor_grid_minutes": cfg.fixed_anchor_grid_minutes,
            "settlement_window": f"{cfg.settlement_window_start_hour}:00 UTC to next-day {cfg.settlement_window_end_next_hour}:00 UTC",
        },
        "daily_lineage_audit": lineage_audit,
        "settlement_proxy_audit": settlement_audit,
        "settlement_proxy_quality": quality,
        "best_fixed_anchor": best_fixed_anchor,
        "fixed_anchor_audit": fixed_audit,
        "v1_22_metrics": v1_22_metrics,
        "answers": answers,
        "outputs": outputs,
    }
    Path(outputs["summary_json"]).write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    pd.DataFrame(
        [
            {
                "version": VERSION,
                "status": status,
                "candidate_decision": candidate_decision,
                "daily_entry_exact_match_rate": lineage_audit["entry_daily_exact_match_rate"],
                "daily_exit_exact_match_rate": lineage_audit["exit_daily_exact_match_rate"],
                "settlement_proxy_corr": settlement_audit["pnl_corr"],
                "settlement_proxy_mae": settlement_audit["mean_abs_diff"],
                "settlement_proxy_sign_match": settlement_audit["sign_match"],
                "best_fixed_anchor_time_utc": best_fixed_anchor.get("anchor_time_utc", ""),
                "best_fixed_anchor_all_corr": fixed_audit["pnl_corr"],
                "best_fixed_anchor_all_mae": fixed_audit["mean_abs_diff"],
                "best_fixed_anchor_holdout_corr": best_fixed_anchor.get("holdout_pnl_corr", 0.0),
                "best_fixed_anchor_holdout_mae": best_fixed_anchor.get("holdout_mean_abs_diff", 999.0),
            }
        ]
    ).to_csv(outputs["summary_csv"], index=False)

    create_plot(settlement_proxy, best_fixed_recon, candidates, summary, Path(outputs["plot"]))
    write_report(summary, outputs)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
