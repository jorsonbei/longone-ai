#!/usr/bin/env python3
"""
HFCD Trading V1.33 Gold BBO/MBP Cost Audit.

V1.31 froze the tradable execution anchor and V1.32 rejected fallback
uncovered-anchor repair. This stage keeps the V1.31 executed trade set fixed
and replaces the proxy cost matrix with real BBO/MBP quotes when available:

- entry fill: buy at ask
- exit fill: sell at bid

No signal tuning, Q-exit tuning, trailing, or uncovered-trade imputation is
allowed in this stage.
"""

from __future__ import annotations

import csv
import json
import math
import os
from datetime import datetime
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


VERSION = "HFCD_Trading_V1_33_GoldBboMbpCostAudit"
ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v1_33_gold_bbo_mbp_cost_audit"
CACHE_DIR = OUT_DIR / "cache_bbo_mbp"

V131_DIR = ROOT / "outputs" / "hfcd_trading_v1_31_gold_execution_paper_baseline"
V129_DIR = ROOT / "outputs" / "hfcd_trading_v1_29_gold_official_settlement_baseline_replay"

V131_REPLAY = V131_DIR / "hfcd_trading_v1_31_trade_replay.csv"
V131_SUMMARY = V131_DIR / "hfcd_trading_v1_31_summary.json"
V129_SELECTED_TRADES = V129_DIR / "hfcd_trading_v1_29_selected_trades.csv"

DATASET = "GLBX.MDP3"
FETCH_BBO = os.environ.get("HFCD_V133_FETCH_BBO", "1") == "1"
FETCH_SCHEMA_ORDER = [s.strip() for s in os.environ.get("HFCD_V133_SCHEMA_ORDER", "bbo-1s,mbp-1").split(",") if s.strip()]
MAX_FETCH_LEGS = int(os.environ.get("HFCD_V133_MAX_FETCH_LEGS", "160"))
LOOKBACK_MINUTES = int(os.environ.get("HFCD_V133_LOOKBACK_MINUTES", "2"))
LOOKAHEAD_MINUTES = int(os.environ.get("HFCD_V133_LOOKAHEAD_MINUTES", "10"))
QUOTE_MAX_WAIT_SECONDS = int(os.environ.get("HFCD_V133_QUOTE_MAX_WAIT_SECONDS", "600"))
QUOTE_MAX_SPREAD_ABS = float(os.environ.get("HFCD_V133_QUOTE_MAX_SPREAD_ABS", "2.0"))
QUOTE_MAX_SPREAD_BPS = float(os.environ.get("HFCD_V133_QUOTE_MAX_SPREAD_BPS", "10.0"))
QUOTE_MIN_TOP_BOOK_SIZE = float(os.environ.get("HFCD_V133_QUOTE_MIN_TOP_BOOK_SIZE", "1.0"))


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


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def get_databento_client() -> Any | None:
    if not FETCH_BBO:
        return None
    load_env_file(ROOT / ".env.local")
    load_env_file(ROOT / ".dev.vars")
    key = os.environ.get("DATABENTO_API_KEY")
    if not key:
        return None
    try:
        import databento as db  # type: ignore
    except Exception:
        return None
    return db.Historical(key=key)


def max_drawdown(values: list[float]) -> float:
    if not values:
        return 0.0
    equity = np.cumsum(values)
    peak = np.maximum.accumulate(equity)
    return float((equity - peak).min())


def metric_block(values: list[float], total_signals: int | None = None, executed: int | None = None) -> dict[str, Any]:
    vals = [float(v) for v in values]
    wins = [v for v in vals if v > 0]
    losses = [v for v in vals if v < 0]
    gross_win = float(sum(wins))
    gross_loss = float(abs(sum(losses)))
    denom = len(vals) if total_signals is None else int(total_signals)
    return {
        "signals": denom,
        "executed": len(vals) if executed is None else int(executed),
        "wins": len(wins),
        "losses": len(losses),
        "win_rate_executed": float(len(wins) / len(vals)) if vals else 0.0,
        "win_rate_all_signals": float(len(wins) / denom) if denom else 0.0,
        "net_pnl_usd": float(sum(vals)),
        "profit_factor": float(gross_win / gross_loss) if gross_loss > 0 else (999.0 if gross_win > 0 else 0.0),
        "max_drawdown_usd": max_drawdown(vals),
        "gross_win_usd": gross_win,
        "gross_loss_usd": gross_loss,
        "avg_pnl_per_executed_trade_usd": float(np.mean(vals)) if vals else 0.0,
        "avg_pnl_per_signal_usd": float(sum(vals) / denom) if denom else 0.0,
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


def load_inputs() -> tuple[pd.DataFrame, dict[str, Any]]:
    if not V131_REPLAY.exists():
        raise FileNotFoundError(V131_REPLAY)
    if not V131_SUMMARY.exists():
        raise FileNotFoundError(V131_SUMMARY)
    replay = pd.read_csv(V131_REPLAY)
    with V131_SUMMARY.open("r", encoding="utf-8") as f:
        v131_summary = json.load(f)
    replay["matched"] = replay["matched"].astype(bool)
    for col in [
        "score",
        "official_settlement_pnl",
        "entry_anchor_price",
        "exit_anchor_price",
        "anchor_return",
        "anchor_pnl",
        "anchor_pnl_2x_cost",
        "entry_minutes_away",
        "exit_minutes_away",
    ]:
        replay[col] = pd.to_numeric(replay.get(col), errors="coerce")

    if V129_SELECTED_TRADES.exists():
        v129 = pd.read_csv(V129_SELECTED_TRADES)
        v129 = v129[(v129["variant"] == "official_v1_20_base_floor_1p00") & (v129["official_coverage"] == "matched")].copy()
        v129["date"] = pd.to_datetime(v129["date"], errors="coerce").dt.date.astype(str)
        v129["exit_date"] = pd.to_datetime(v129["exit_date"], errors="coerce").dt.date.astype(str)
        v129 = v129.sort_values(["date", "fold"]).reset_index(drop=True)
        v129["trade_id_v130"] = np.arange(len(v129))
        merge_cols = ["trade_id_v130", "notional_usd", "position_multiplier", "fee_rate", "side"]
        replay = replay.merge(v129[merge_cols], on="trade_id_v130", how="left")
    replay["notional_usd"] = pd.to_numeric(replay.get("notional_usd"), errors="coerce").fillna(10_000.0)
    replay["position_multiplier"] = pd.to_numeric(replay.get("position_multiplier"), errors="coerce").fillna(1.0)
    replay["fee_rate"] = pd.to_numeric(replay.get("fee_rate"), errors="coerce").fillna(0.00035)
    replay["side"] = replay.get("side", "long").fillna("long").astype(str)
    return replay, v131_summary


def anchor_timestamp(date_key: str, anchor_minute: int, minutes_away: float) -> pd.Timestamp:
    base = pd.Timestamp(date_key, tz="UTC")
    day_offset = 1 if int(anchor_minute) < 4 * 60 else 0
    target = base + pd.Timedelta(days=day_offset, minutes=int(anchor_minute))
    if math.isfinite(float(minutes_away)):
        target += pd.Timedelta(minutes=float(minutes_away))
    return target


def normalize_book(raw: pd.DataFrame, symbol: str = "") -> pd.DataFrame:
    if raw is None or raw.empty:
        return pd.DataFrame()
    out = raw.copy()
    # For Databento BBO snapshots, ts_recv is the second/sample timestamp. ts_event
    # can be the last underlying quote event before that sample and may fall just
    # before the execution anchor, causing the selector to skip the correct quote.
    ts_col = "ts_recv" if "ts_recv" in out.columns else ("ts_event" if "ts_event" in out.columns else ("timestamp" if "timestamp" in out.columns else out.columns[0]))
    out["timestamp"] = pd.to_datetime(out[ts_col], errors="coerce", utc=True)
    for col in ["bid_px_00", "ask_px_00", "bid_sz_00", "ask_sz_00"]:
        out[col] = pd.to_numeric(out.get(col), errors="coerce")
    out = out.dropna(subset=["timestamp", "bid_px_00", "ask_px_00"]).copy()
    if out.empty:
        return pd.DataFrame()
    out = out[(out["bid_px_00"] > 0) & (out["ask_px_00"] > 0) & (out["ask_px_00"] >= out["bid_px_00"])].copy()
    if out.empty:
        return pd.DataFrame()
    if "symbol" not in out.columns:
        out["symbol"] = symbol
    out["mid_price"] = (out["bid_px_00"] + out["ask_px_00"]) / 2.0
    out["spread"] = out["ask_px_00"] - out["bid_px_00"]
    out["top_book_size"] = out["bid_sz_00"].fillna(0.0) + out["ask_sz_00"].fillna(0.0)
    keep = ["timestamp", "symbol", "bid_px_00", "ask_px_00", "bid_sz_00", "ask_sz_00", "mid_price", "spread", "top_book_size"]
    return out[keep].sort_values("timestamp").drop_duplicates("timestamp").reset_index(drop=True)


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


class BookStore:
    def __init__(self) -> None:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        self.client = get_databento_client()
        self.fetch_count = 0
        self.loaded: dict[tuple[str, str, str], pd.DataFrame] = {}
        self.fetch_log: list[dict[str, Any]] = []

    def local_exact_candidates(self, symbol: str, date_key: str) -> list[Path]:
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
        return CACHE_DIR / f"{schema.replace('-', '_')}_{symbol}_{stamp}.csv"

    def get_window(self, symbol: str, target: pd.Timestamp) -> tuple[pd.DataFrame, str]:
        key = (symbol, target.strftime("%Y-%m-%d_%H%M"), ",".join(FETCH_SCHEMA_ORDER))
        if key in self.loaded:
            return self.loaded[key], "memory"

        date_key = target.date().isoformat()
        frames: list[pd.DataFrame] = []
        source_parts: list[str] = []
        start = target - pd.Timedelta(minutes=LOOKBACK_MINUTES)
        end = target + pd.Timedelta(minutes=LOOKAHEAD_MINUTES)

        for path in self.local_exact_candidates(symbol, date_key):
            try:
                raw = pd.read_csv(path)
            except Exception:
                continue
            norm = normalize_book(raw, symbol=symbol)
            if not norm.empty:
                part = norm[(norm["timestamp"] >= start) & (norm["timestamp"] <= end)].copy()
                if not part.empty:
                    frames.append(part)
                    source_parts.append(f"local:{path}")

        if not frames and self.client is not None and self.fetch_count < MAX_FETCH_LEGS:
            for schema in FETCH_SCHEMA_ORDER:
                cache = self.cache_file(schema, symbol, target)
                status = "not_requested"
                error = ""
                rows = 0
                if cache.exists() and cache.stat().st_size > 0:
                    try:
                        raw = pd.read_csv(cache)
                        status = "cache"
                    except Exception as exc:
                        raw = pd.DataFrame()
                        status = f"cache_empty_or_invalid:{type(exc).__name__}"
                        error = str(exc)[:500]
                else:
                    try:
                        raw = fetch_range_to_df(self.client, schema=schema, symbol=symbol, start=start, end=end)
                        raw.to_csv(cache, index=False)
                        status = "downloaded"
                        self.fetch_count += 1
                    except Exception as exc:
                        raw = pd.DataFrame()
                        status = f"failed:{type(exc).__name__}"
                        error = str(exc)[:500]
                        self.fetch_count += 1
                norm = normalize_book(raw, symbol=symbol)
                rows = int(len(norm))
                self.fetch_log.append(
                    {
                        "symbol": symbol,
                        "target": target.isoformat(),
                        "schema": schema,
                        "start": start.isoformat(),
                        "end": end.isoformat(),
                        "status": status,
                        "normalized_rows": rows,
                        "error": error,
                    }
                )
                if not norm.empty:
                    frames.append(norm)
                    source_parts.append(f"{schema}:{status}:{cache}")
                    break

        if not frames:
            out = pd.DataFrame()
            self.loaded[key] = out
            return out, "missing_bbo_mbp"
        out = pd.concat(frames, ignore_index=True)
        out = out.sort_values("timestamp").drop_duplicates("timestamp").reset_index(drop=True)
        self.loaded[key] = out
        return out, " | ".join(source_parts)


def select_quote(book: pd.DataFrame, target: pd.Timestamp) -> dict[str, Any]:
    if book.empty:
        return {"status": "missing_bbo_mbp", "seconds_away": math.nan}
    tmp = book[(book["timestamp"] >= target) & (book["timestamp"] <= target + pd.Timedelta(seconds=QUOTE_MAX_WAIT_SECONDS))].copy()
    if tmp.empty:
        return {"status": "no_quote_after_anchor", "seconds_away": math.nan}
    quality = tmp[quote_quality_mask(tmp)].copy()
    if quality.empty:
        first_bad = tmp.sort_values("timestamp").iloc[0]
        seconds_away = float((first_bad["timestamp"] - target).total_seconds())
        return {
            "status": "quote_quality_fail_after_anchor",
            "timestamp": first_bad["timestamp"],
            "seconds_away": seconds_away,
            "bid": float(first_bad["bid_px_00"]),
            "ask": float(first_bad["ask_px_00"]),
            "mid": float(first_bad["mid_price"]),
            "spread": float(first_bad["spread"]),
            "top_book_size": float(first_bad["top_book_size"]),
            "bid_size": float(first_bad["bid_sz_00"]) if not pd.isna(first_bad["bid_sz_00"]) else 0.0,
            "ask_size": float(first_bad["ask_sz_00"]) if not pd.isna(first_bad["ask_sz_00"]) else 0.0,
            "quality_fail_count": int(len(tmp)),
            "max_spread_in_window": float(pd.to_numeric(tmp["spread"], errors="coerce").max()),
            "min_spread_in_window": float(pd.to_numeric(tmp["spread"], errors="coerce").min()),
        }
    first = quality.sort_values("timestamp").iloc[0]
    seconds_away = float((first["timestamp"] - target).total_seconds())
    return {
        "status": "matched",
        "timestamp": first["timestamp"],
        "seconds_away": seconds_away,
        "bid": float(first["bid_px_00"]),
        "ask": float(first["ask_px_00"]),
        "mid": float(first["mid_price"]),
        "spread": float(first["spread"]),
        "top_book_size": float(first["top_book_size"]),
        "bid_size": float(first["bid_sz_00"]) if not pd.isna(first["bid_sz_00"]) else 0.0,
        "ask_size": float(first["ask_sz_00"]) if not pd.isna(first["ask_sz_00"]) else 0.0,
        "quality_fail_count": int(len(tmp) - len(quality)),
        "max_spread_in_window": float(pd.to_numeric(tmp["spread"], errors="coerce").max()),
        "min_spread_in_window": float(pd.to_numeric(tmp["spread"], errors="coerce").min()),
    }


def bbo_trade_replay(replay: pd.DataFrame, store: BookStore) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    executed = replay[replay["matched"]].copy()
    for _, tr in executed.iterrows():
        entry_ts = anchor_timestamp(str(tr["date"]), int(tr["anchor_minute_of_day"]), float(tr["entry_minutes_away"]))
        exit_ts = anchor_timestamp(str(tr["exit_date"]), int(tr["anchor_minute_of_day"]), float(tr["exit_minutes_away"]))
        entry_book, entry_source = store.get_window(str(tr["front_symbol"]), entry_ts)
        exit_book, exit_source = store.get_window(str(tr["exit_symbol"]), exit_ts)
        entry = select_quote(entry_book, entry_ts)
        exit_ = select_quote(exit_book, exit_ts)
        bbo_matched = entry.get("status") == "matched" and exit_.get("status") == "matched"

        notional = float(tr["notional_usd"]) * float(tr["position_multiplier"])
        fee = notional * float(tr["fee_rate"])
        side = str(tr.get("side", "long")).lower()
        bbo_return = math.nan
        bbo_mid_return = math.nan
        bbo_pnl = math.nan
        bbo_pnl_2x_fee = math.nan
        bbo_mid_pnl = math.nan
        bbo_spread_cost = math.nan
        if bbo_matched:
            if side.startswith("short"):
                bbo_return = (entry["bid"] - exit_["ask"]) / entry["bid"]
                bbo_mid_return = (entry["mid"] - exit_["mid"]) / entry["mid"]
            else:
                bbo_return = (exit_["bid"] - entry["ask"]) / entry["ask"]
                bbo_mid_return = (exit_["mid"] - entry["mid"]) / entry["mid"]
            bbo_pnl = notional * bbo_return - fee
            bbo_pnl_2x_fee = notional * bbo_return - 2.0 * fee
            bbo_mid_pnl = notional * bbo_mid_return - fee
            bbo_spread_cost = bbo_mid_pnl - bbo_pnl

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
                "bbo_mbp_matched": bool(bbo_matched),
                "bbo_bidask_return": bbo_return,
                "bbo_mid_return": bbo_mid_return,
                "bbo_bidask_pnl_usd": bbo_pnl,
                "bbo_bidask_pnl_2x_fee_usd": bbo_pnl_2x_fee,
                "bbo_mid_pnl_usd": bbo_mid_pnl,
                "bbo_spread_cost_usd": bbo_spread_cost,
                "pnl_delta_bbo_vs_anchor_usd": bbo_pnl - float(tr["anchor_pnl"]) if bbo_matched else math.nan,
                "pnl_delta_bbo_vs_official_usd": bbo_pnl - float(tr["official_settlement_pnl"]) if bbo_matched else math.nan,
            }
        )
    return pd.DataFrame(rows)


def build_cost_stress(bbo: pd.DataFrame, total_signals: int) -> list[dict[str, Any]]:
    matched = bbo[bbo["bbo_mbp_matched"]].copy()
    if matched.empty:
        return []
    rows: list[dict[str, Any]] = []
    base_notional = pd.to_numeric(matched["notional_usd"], errors="coerce").fillna(0.0)
    base_fee = pd.to_numeric(matched["fee_usd"], errors="coerce").fillna(0.0)
    gross = pd.to_numeric(matched["bbo_bidask_return"], errors="coerce").fillna(0.0) * base_notional
    for fee_mult in [1.0, 2.0]:
        for bps_per_side in [0.0, 0.5, 1.0, 2.0, 3.0, 5.0]:
            extra_slippage = base_notional * (bps_per_side / 10_000.0) * 2.0
            pnl = gross - fee_mult * base_fee - extra_slippage
            block = metric_block(pnl.tolist(), total_signals=total_signals, executed=len(matched))
            rows.append(
                {
                    "scenario": f"bbo_bidask_fee_{fee_mult:g}x_plus_{bps_per_side:g}bps_per_side",
                    "fee_multiplier": fee_mult,
                    "extra_slippage_bps_per_side": bps_per_side,
                    **block,
                }
            )
    return rows


def coverage_audit(bbo: pd.DataFrame) -> pd.DataFrame:
    if bbo.empty:
        return pd.DataFrame()
    out = (
        bbo.groupby(["entry_bbo_status", "exit_bbo_status", "split"], dropna=False)
        .agg(
            count=("trade_id_v130", "size"),
            anchor_pnl_usd=("anchor_pnl", "sum"),
            official_pnl_usd=("official_settlement_pnl", "sum"),
            avg_entry_seconds_away=("entry_seconds_away", "mean"),
            avg_exit_seconds_away=("exit_seconds_away", "mean"),
        )
        .reset_index()
    )
    out["production_handling"] = np.where(
        (out["entry_bbo_status"] == "matched") & (out["exit_bbo_status"] == "matched"),
        "use_real_bid_ask",
        "fallback_to_v131_anchor_until_bbo_source_repaired",
    )
    return out


def split_summary(bbo: pd.DataFrame, total_by_split: dict[str, int]) -> dict[str, Any]:
    rows: dict[str, Any] = {}
    for split in ["rolling", "holdout"]:
        sub = bbo[(bbo["split"] == split) & (bbo["bbo_mbp_matched"])]
        rows[split] = {
            "signals": int(total_by_split.get(split, 0)),
            "bbo_mbp_matched": int(len(sub)),
            "coverage_rate": float(len(sub) / max(1, total_by_split.get(split, 0))),
            "bbo_bidask_net_pnl_usd": float(pd.to_numeric(sub["bbo_bidask_pnl_usd"], errors="coerce").fillna(0.0).sum()),
            "anchor_net_pnl_same_subset_usd": float(pd.to_numeric(sub["anchor_pnl"], errors="coerce").fillna(0.0).sum()),
            "official_net_pnl_same_subset_usd": float(pd.to_numeric(sub["official_settlement_pnl"], errors="coerce").fillna(0.0).sum()),
            "bbo_profit_factor": metric_block(pd.to_numeric(sub["bbo_bidask_pnl_usd"], errors="coerce").fillna(0.0).tolist()).get("profit_factor", 0.0),
        }
    return rows


def build_summary(replay: pd.DataFrame, bbo: pd.DataFrame, stress: list[dict[str, Any]], v131_summary: dict[str, Any]) -> dict[str, Any]:
    v131_executed = replay[replay["matched"]].copy()
    bbo_matched = bbo[bbo["bbo_mbp_matched"]].copy() if not bbo.empty else pd.DataFrame()
    total_signals = int(len(replay))
    total_v131_executed = int(len(v131_executed))
    coverage = float(len(bbo_matched) / total_v131_executed) if total_v131_executed else 0.0
    bbo_metrics = metric_block(pd.to_numeric(bbo_matched["bbo_bidask_pnl_usd"], errors="coerce").fillna(0.0).tolist(), total_signals=total_signals, executed=len(bbo_matched))
    bbo_2x_metrics = metric_block(pd.to_numeric(bbo_matched["bbo_bidask_pnl_2x_fee_usd"], errors="coerce").fillna(0.0).tolist(), total_signals=total_signals, executed=len(bbo_matched))
    anchor_same_subset = metric_block(pd.to_numeric(bbo_matched["anchor_pnl"], errors="coerce").fillna(0.0).tolist(), total_signals=total_signals, executed=len(bbo_matched))
    official_same_subset = metric_block(pd.to_numeric(bbo_matched["official_settlement_pnl"], errors="coerce").fillna(0.0).tolist(), total_signals=total_signals, executed=len(bbo_matched))
    stress_df = pd.DataFrame(stress)
    stress_ref = {}
    if not stress_df.empty:
        ref = stress_df[(stress_df["fee_multiplier"] == 2.0) & (stress_df["extra_slippage_bps_per_side"] == 1.0)]
        if not ref.empty:
            stress_ref = ref.iloc[0].to_dict()

    total_by_split = replay[replay["matched"]].groupby("split").size().to_dict()
    splits = split_summary(bbo, {str(k): int(v) for k, v in total_by_split.items()})
    missing_bbo_anchor_pnl = float(pd.to_numeric(bbo[~bbo["bbo_mbp_matched"]]["anchor_pnl"], errors="coerce").fillna(0.0).sum()) if not bbo.empty else 0.0
    missing_bbo_official_pnl = float(pd.to_numeric(bbo[~bbo["bbo_mbp_matched"]]["official_settlement_pnl"], errors="coerce").fillna(0.0).sum()) if not bbo.empty else 0.0
    quote_quality_fail_trades = int(
        (
            (bbo.get("entry_bbo_status", pd.Series(dtype=str)) == "quote_quality_fail_after_anchor")
            | (bbo.get("exit_bbo_status", pd.Series(dtype=str)) == "quote_quality_fail_after_anchor")
        ).sum()
    ) if not bbo.empty else 0

    gate_actual = {
        "bbo_mbp_coverage_of_v131_executed": coverage,
        "bbo_bidask_net_pnl_usd": bbo_metrics["net_pnl_usd"],
        "bbo_bidask_2x_fee_net_pnl_usd": bbo_2x_metrics["net_pnl_usd"],
        "stress_2x_fee_plus_1bps_net_pnl_usd": stress_ref.get("net_pnl_usd"),
        "pnl_corr_vs_v131_anchor": safe_corr(bbo_matched.get("anchor_pnl", pd.Series(dtype=float)), bbo_matched.get("bbo_bidask_pnl_usd", pd.Series(dtype=float))),
        "sign_match_vs_v131_anchor": sign_match(bbo_matched.get("anchor_pnl", pd.Series(dtype=float)), bbo_matched.get("bbo_bidask_pnl_usd", pd.Series(dtype=float))),
        "mean_abs_pnl_delta_vs_v131_anchor": float(pd.to_numeric(bbo_matched.get("pnl_delta_bbo_vs_anchor_usd", pd.Series(dtype=float)), errors="coerce").abs().mean()) if not bbo_matched.empty else None,
        "rolling_bbo_net_pnl_usd": splits.get("rolling", {}).get("bbo_bidask_net_pnl_usd", 0.0),
        "holdout_bbo_net_pnl_usd": splits.get("holdout", {}).get("bbo_bidask_net_pnl_usd", 0.0),
    }
    gate_passed = (
        coverage >= 0.80
        and gate_actual["bbo_bidask_net_pnl_usd"] > 0
        and gate_actual["bbo_bidask_2x_fee_net_pnl_usd"] > 0
        and (gate_actual["stress_2x_fee_plus_1bps_net_pnl_usd"] or -1) > 0
        and gate_actual["pnl_corr_vs_v131_anchor"] >= 0.90
        and gate_actual["sign_match_vs_v131_anchor"] >= 0.90
        and gate_actual["rolling_bbo_net_pnl_usd"] > 0
        and gate_actual["holdout_bbo_net_pnl_usd"] > 0
    )
    if gate_passed:
        status = "gold_real_bbo_mbp_cost_candidate"
        decision = "promote_bbo_bidask_cost_layer_over_v131_proxy_stress"
    elif coverage < 0.80:
        status = "gold_bbo_mbp_cost_watchlist_insufficient_coverage"
        decision = "keep_v1_31_until_bbo_mbp_coverage_reaches_gate"
    else:
        status = "gold_bbo_mbp_cost_not_promoted_keep_v131"
        decision = "keep_v1_31_skip_uncovered_baseline"

    return {
        "version": VERSION,
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "status": status,
        "source": {
            "baseline": "V1.31 skip-uncovered execution paper baseline",
            "anchor": "next_after_2000_wait240",
            "cost_layer": "real BBO/MBP when available; entry ask and exit bid for long trades",
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
            "q_or_trailing_tuning": "not_allowed_in_v1_33",
        },
        "v131_reference": v131_summary,
        "coverage": {
            "total_signals": total_signals,
            "v131_executed": total_v131_executed,
            "bbo_mbp_matched": int(len(bbo_matched)),
            "bbo_mbp_missing": int(total_v131_executed - len(bbo_matched)),
            "coverage_of_v131_executed": coverage,
            "quote_quality_fail_trades": quote_quality_fail_trades,
            "missing_bbo_anchor_pnl_usd": missing_bbo_anchor_pnl,
            "missing_bbo_official_pnl_usd": missing_bbo_official_pnl,
        },
        "bbo_bidask_metrics": bbo_metrics,
        "bbo_bidask_2x_fee_metrics": bbo_2x_metrics,
        "anchor_same_subset_metrics": anchor_same_subset,
        "official_same_subset_metrics": official_same_subset,
        "alignment": {
            "pnl_corr_vs_v131_anchor": gate_actual["pnl_corr_vs_v131_anchor"],
            "sign_match_vs_v131_anchor": gate_actual["sign_match_vs_v131_anchor"],
            "mean_abs_pnl_delta_vs_v131_anchor": gate_actual["mean_abs_pnl_delta_vs_v131_anchor"],
            "pnl_corr_vs_official": safe_corr(bbo_matched.get("official_settlement_pnl", pd.Series(dtype=float)), bbo_matched.get("bbo_bidask_pnl_usd", pd.Series(dtype=float))),
            "sign_match_vs_official": sign_match(bbo_matched.get("official_settlement_pnl", pd.Series(dtype=float)), bbo_matched.get("bbo_bidask_pnl_usd", pd.Series(dtype=float))),
        },
        "split": splits,
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
            "actual": gate_actual,
            "passed": bool(gate_passed),
        },
        "decision": decision,
        "next_step": "If promoted, freeze V1.33 as the executable cost layer; otherwise expand BBO/MBP coverage or keep V1.31 before any Q/trailing work.",
    }


def create_plot(bbo: pd.DataFrame, summary: dict[str, Any], out: Path) -> None:
    fig, axes = plt.subplots(2, 2, figsize=(14, 9))
    matched = bbo[bbo["bbo_mbp_matched"]].copy() if not bbo.empty else pd.DataFrame()
    if not matched.empty:
        ordered = matched.sort_values(["date", "trade_id_v130"]).reset_index(drop=True)
        axes[0, 0].plot(np.cumsum(ordered["anchor_pnl"]), label="V1.31 anchor")
        axes[0, 0].plot(np.cumsum(ordered["bbo_bidask_pnl_usd"]), label="V1.33 BBO bid/ask")
        axes[0, 0].legend()
        axes[0, 1].hist(ordered["pnl_delta_bbo_vs_anchor_usd"].dropna(), bins=20)
        axes[1, 0].scatter(ordered["anchor_pnl"], ordered["bbo_bidask_pnl_usd"], alpha=0.75)
        lim = max(abs(ordered["anchor_pnl"]).max(), abs(ordered["bbo_bidask_pnl_usd"]).max())
        axes[1, 0].plot([-lim, lim], [-lim, lim], linestyle="--", color="gray")
        spreads = pd.concat([ordered["entry_spread"], ordered["exit_spread"]], ignore_index=True).dropna()
        axes[1, 1].hist(spreads, bins=20)
    axes[0, 0].set_title("Cumulative PnL on BBO-matched subset")
    axes[0, 0].grid(alpha=0.25)
    axes[0, 1].set_title("BBO PnL delta vs V1.31 anchor")
    axes[0, 1].grid(alpha=0.25)
    axes[1, 0].set_title("Anchor vs BBO PnL")
    axes[1, 0].grid(alpha=0.25)
    axes[1, 1].set_title("Observed top-of-book spread")
    axes[1, 1].grid(alpha=0.25)
    fig.suptitle(f"{summary['status']} | BBO coverage {summary['coverage']['coverage_of_v131_executed']:.1%}", y=1.02)
    fig.tight_layout()
    fig.savefig(out, dpi=180, bbox_inches="tight")
    plt.close(fig)


def write_report(summary: dict[str, Any]) -> None:
    cov = summary["coverage"]
    metrics = summary["bbo_bidask_metrics"]
    anchor = summary["anchor_same_subset_metrics"]
    align = summary["alignment"]
    split = summary["split"]
    gate = summary["gate"]
    lines = [
        f"# {VERSION}",
        "",
        "## 定位",
        "",
        "V1.33 只做执行成本层审计：保持 V1.31 的交易集合和执行锚不变，用真实 BBO/MBP 可见买卖盘替代压力矩阵。",
        "本阶段不调信号、不调 Q 动态退出、不调 trailing，也不补未覆盖交易。",
        "",
        "## 结论",
        "",
        f"- 状态：`{summary['status']}`",
        f"- 决策：`{summary['decision']}`",
        f"- V1.31 已执行交易：{cov['v131_executed']}",
        f"- BBO/MBP 完整覆盖：{cov['bbo_mbp_matched']}，覆盖率 {cov['coverage_of_v131_executed']:.2%}",
        f"- 盘口质量失败交易：{cov.get('quote_quality_fail_trades', 0)}（价差或盘口深度不达标，不当作可执行 BBO）",
        f"- BBO bid/ask 净收益：${metrics['net_pnl_usd']:.2f}，PF {metrics['profit_factor']:.3f}，最大回撤 ${metrics['max_drawdown_usd']:.2f}",
        f"- 同子集 V1.31 anchor 净收益：${anchor['net_pnl_usd']:.2f}，PF {anchor['profit_factor']:.3f}",
        f"- 2x fee BBO 净收益：${summary['bbo_bidask_2x_fee_metrics']['net_pnl_usd']:.2f}",
        f"- Anchor vs BBO PnL 相关：{align['pnl_corr_vs_v131_anchor']:.3f}",
        f"- Anchor vs BBO 方向一致：{align['sign_match_vs_v131_anchor']:.2%}",
        "",
        "## 分段结果",
        "",
        f"- rolling BBO 净收益：${split.get('rolling', {}).get('bbo_bidask_net_pnl_usd', 0.0):.2f}，覆盖率 {split.get('rolling', {}).get('coverage_rate', 0.0):.2%}",
        f"- holdout BBO 净收益：${split.get('holdout', {}).get('bbo_bidask_net_pnl_usd', 0.0):.2f}，覆盖率 {split.get('holdout', {}).get('coverage_rate', 0.0):.2%}",
        "",
        "## Gate",
        "",
        f"- passed：{gate['passed']}",
        f"- actual：`{json.dumps(gate['actual'], ensure_ascii=False)}`",
        "",
        "## 解释",
        "",
        "如果 BBO/MBP 覆盖不足，不能把真实盘口成本层晋级，只能继续保留 V1.31 的压力矩阵基线。",
        "如果覆盖足够但 BBO 后收益或相关性不达标，也不能晋级；那说明真实买卖盘成本改变了策略经济性。",
        "本版已加入盘口质量门：bid/ask 必须有效、两边有量、价差不能超过配置阈值；异常宽价差报价只用于审计，不用于成交成本。",
        "",
        "## 输出文件",
        "",
        "- `hfcd_trading_v1_33_bbo_mbp_cost_replay.csv`",
        "- `hfcd_trading_v1_33_bbo_fetch_log.csv`",
        "- `hfcd_trading_v1_33_coverage_audit.csv`",
        "- `hfcd_trading_v1_33_cost_stress_matrix.csv`",
        "- `hfcd_trading_v1_33_summary.json`",
        "- `HFCD_Trading_V1_33_GoldBboMbpCostAudit.png`",
    ]
    (OUT_DIR / "HFCD_Trading_V1_33_GoldBboMbpCostAudit.md").write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    replay, v131_summary = load_inputs()
    store = BookStore()
    bbo = bbo_trade_replay(replay, store)
    stress = build_cost_stress(bbo, total_signals=len(replay))
    coverage = coverage_audit(bbo)
    summary = build_summary(replay, bbo, stress, v131_summary)

    bbo.to_csv(OUT_DIR / "hfcd_trading_v1_33_bbo_mbp_cost_replay.csv", index=False)
    write_csv(OUT_DIR / "hfcd_trading_v1_33_bbo_fetch_log.csv", store.fetch_log)
    coverage.to_csv(OUT_DIR / "hfcd_trading_v1_33_coverage_audit.csv", index=False)
    write_csv(OUT_DIR / "hfcd_trading_v1_33_cost_stress_matrix.csv", stress)
    with (OUT_DIR / "hfcd_trading_v1_33_summary.json").open("w", encoding="utf-8") as f:
        json.dump(clean_json(summary), f, ensure_ascii=False, indent=2)
    write_csv(OUT_DIR / "hfcd_trading_v1_33_summary.csv", [clean_json(summary)])
    create_plot(bbo, summary, OUT_DIR / "HFCD_Trading_V1_33_GoldBboMbpCostAudit.png")
    write_report(summary)
    print(json.dumps(clean_json(summary), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
