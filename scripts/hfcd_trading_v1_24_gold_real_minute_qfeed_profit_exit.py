#!/usr/bin/env python3
"""
HFCD Trading V1.24 Gold Real Minute Q Feed Profit Preserving Exit.

This script freezes the V1.22 gold strategy q_soft_reduce_floor_1p10 and
validates the V1.23 minute-Q exit framework against real minute/BBO-derived
feeds where available. It is local replay only and never places orders.
"""

from __future__ import annotations

import csv
import json
import os
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


VERSION = "HFCD_Trading_V1_24_GoldRealMinuteQFeed_ProfitPreservingExit"
ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v1_24_gold_real_minute_qfeed_profit_exit"
V22_DIR = ROOT / "outputs" / "hfcd_trading_v1_22_gold_execution_qdrift_replay"
V23_DIR = ROOT / "outputs" / "hfcd_trading_v1_23_gold_minute_q_dynamic_exit"
V22_HOLDOUT = V22_DIR / "hfcd_trading_v1_22_holdout_trades.csv"
V22_ROLLING = V22_DIR / "hfcd_trading_v1_22_rolling_trades.csv"
V23_REPLAY = V23_DIR / "hfcd_trading_v1_23_trade_replay.csv"
V23_SCHEMA = V23_DIR / "hfcd_trading_v1_23_minute_feed_schema.csv"

DATASET = "GLBX.MDP3"
FROZEN_VARIANT = "q_soft_reduce_floor_1p10"
FROZEN_FRICTION = "l2_estimated"
THRESHOLD = 1.10


@dataclass(frozen=True)
class Config:
    max_trades: int = int(os.environ.get("HFCD_V124_MAX_TRADES", "64"))
    max_bbo_sessions: int = int(os.environ.get("HFCD_V124_MAX_BBO_SESSIONS", "1"))
    session_start: str = os.environ.get("HFCD_V124_SESSION_START", "13:30")
    session_end: str = os.environ.get("HFCD_V124_SESSION_END", "20:00")
    q_warning: float = float(os.environ.get("HFCD_V124_Q_WARNING", "0.85"))
    q_soft_reduce: float = float(os.environ.get("HFCD_V124_Q_SOFT", "0.70"))
    q_hard_exit: float = float(os.environ.get("HFCD_V124_Q_HARD", "0.40"))
    hard_confirm_minutes: int = int(os.environ.get("HFCD_V124_HARD_CONFIRM_MINUTES", "10"))
    q_health_for_winner_run: float = float(os.environ.get("HFCD_V124_Q_WINNER_RUN", "0.75"))
    trailing_activate_return: float = float(os.environ.get("HFCD_V124_TRAIL_ACTIVATE", "0.008"))
    trailing_giveback_return: float = float(os.environ.get("HFCD_V124_TRAIL_GIVEBACK", "0.005"))
    min_minutes_before_trailing: int = int(os.environ.get("HFCD_V124_MIN_TRAIL_MINUTES", "120"))
    latency_minutes: int = int(os.environ.get("HFCD_V124_LATENCY_MINUTES", "1"))
    slippage_bps: float = float(os.environ.get("HFCD_V124_SLIPPAGE_BPS", "1.5"))
    shock_multiplier: float = float(os.environ.get("HFCD_V124_SHOCK_MULTIPLIER", "2.0"))


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


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


def robust_rank(values: pd.Series) -> pd.Series:
    return values.rank(method="average", pct=True).fillna(0.5).clip(0.0, 1.0)


def load_selected_trades() -> pd.DataFrame:
    frames: list[pd.DataFrame] = []
    for path, split in [(V22_HOLDOUT, "holdout"), (V22_ROLLING, "rolling")]:
        if not path.exists():
            raise FileNotFoundError(f"Missing V1.22 trade file: {path}")
        df = pd.read_csv(path)
        df["source_split"] = split
        frames.append(df)
    trades = pd.concat(frames, ignore_index=True)
    trades = trades[(trades["variant"] == FROZEN_VARIANT) & (trades["friction_label"] == FROZEN_FRICTION)].copy()
    if trades.empty:
        raise ValueError("No frozen V1.22 q_soft_reduce_floor_1p10/l2_estimated trades found.")
    trades["date"] = pd.to_datetime(trades["date"], errors="coerce")
    numeric_cols = [
        "score",
        "position_multiplier",
        "notional_usd",
        "front_close",
        "front_ret_next",
        "fee_rate",
        "pnl_usd",
        "q_core_quality_proxy",
        "event_risk_proxy",
        "volatility_5d",
    ]
    for col in numeric_cols:
        trades[col] = pd.to_numeric(trades[col], errors="coerce").fillna(0.0)
    trades["trade_id"] = np.arange(len(trades))
    trades["q_rank"] = robust_rank(trades["q_core_quality_proxy"])
    trades["event_rank"] = robust_rank(trades["event_risk_proxy"])
    trades["vol_rank"] = robust_rank(trades["volatility_5d"])
    strength = ((trades["score"] - THRESHOLD) / THRESHOLD).clip(lower=0.0)
    denom = float(strength.quantile(0.95)) or 1.0
    trades["score_strength"] = (strength / denom).clip(0.0, 1.0)
    return trades.sort_values(["date", "source_split"]).reset_index(drop=True)


def load_v23_proxy() -> pd.DataFrame:
    if not V23_REPLAY.exists():
        return pd.DataFrame()
    df = pd.read_csv(V23_REPLAY)
    if "trade_id" not in df.columns:
        return pd.DataFrame()
    return df


def load_schema() -> list[str]:
    if not V23_SCHEMA.exists():
        return []
    schema = pd.read_csv(V23_SCHEMA)
    if "column" not in schema.columns:
        return []
    return schema["column"].astype(str).tolist()


def session_bounds(signal_date: pd.Timestamp, cfg: Config, offset_days: int = 1) -> tuple[str, str, str]:
    session_date = (signal_date + pd.Timedelta(days=offset_days)).date().isoformat()
    return session_date, f"{session_date}T{cfg.session_start}", f"{session_date}T{cfg.session_end}"


def get_historical_client() -> Any:
    load_env_file(ROOT / ".env.local")
    load_env_file(ROOT / ".dev.vars")
    key = os.environ.get("DATABENTO_API_KEY")
    if not key:
        raise RuntimeError("DATABENTO_API_KEY missing.")
    import databento as db  # type: ignore

    return db.Historical(key=key)


def fetch_range_to_df(client: Any, *, schema: str, symbol: str, start: str, end: str) -> pd.DataFrame:
    data = client.timeseries.get_range(
        dataset=DATASET,
        schema=schema,
        symbols=[symbol],
        stype_in="raw_symbol",
        start=start,
        end=end,
    )
    df = data.to_df()
    if df is None or df.empty:
        return pd.DataFrame()
    return df.copy().reset_index()


def normalize_bbo(raw: pd.DataFrame, symbol: str, session_date: str) -> pd.DataFrame:
    if raw.empty:
        return pd.DataFrame()
    out = raw.copy()
    ts_col = "ts_event" if "ts_event" in out.columns else out.columns[0]
    out["timestamp"] = pd.to_datetime(out[ts_col], errors="coerce")
    out["date"] = session_date
    out["symbol"] = symbol
    for col in ["bid_px_00", "ask_px_00", "bid_sz_00", "ask_sz_00"]:
        if col in out.columns:
            out[col] = pd.to_numeric(out[col], errors="coerce")
    out["bid_px"] = out.get("bid_px_00", np.nan)
    out["ask_px"] = out.get("ask_px_00", np.nan)
    out["bid_size"] = out.get("bid_sz_00", np.nan)
    out["ask_size"] = out.get("ask_sz_00", np.nan)
    out["mid_price"] = (out["bid_px"] + out["ask_px"]) / 2.0
    out["spread"] = out["ask_px"] - out["bid_px"]
    return out[["timestamp", "date", "symbol", "bid_px", "ask_px", "bid_size", "ask_size", "mid_price", "spread"]].dropna(subset=["timestamp"])


def aggregate_bbo_to_minute(bbo: pd.DataFrame) -> pd.DataFrame:
    if bbo.empty:
        return pd.DataFrame()
    tmp = bbo.copy()
    tmp["minute_ts"] = pd.to_datetime(tmp["timestamp"], errors="coerce").dt.floor("min")
    grouped = tmp.groupby("minute_ts").agg(
        bid_px=("bid_px", "last"),
        ask_px=("ask_px", "last"),
        bid_size=("bid_size", "median"),
        ask_size=("ask_size", "median"),
        mid_price=("mid_price", "last"),
        spread=("spread", "median"),
    )
    return grouped.reset_index().rename(columns={"minute_ts": "timestamp"})


def normalize_ohlcv_to_feed(
    raw: pd.DataFrame,
    bbo_minute: pd.DataFrame,
    trade: pd.Series,
    session_date: str,
) -> pd.DataFrame:
    if raw.empty:
        return pd.DataFrame()
    out = raw.copy()
    ts_col = "ts_event" if "ts_event" in out.columns else out.columns[0]
    out["timestamp"] = pd.to_datetime(out[ts_col], errors="coerce").dt.floor("min")
    out["date"] = session_date
    out["signal_date"] = pd.Timestamp(trade["date"]).date().isoformat()
    out["trade_id"] = int(trade["trade_id"])
    out["source_split"] = trade["source_split"]
    out["fold"] = trade["fold"]
    out["symbol"] = str(trade["front_symbol"])
    for col in ["open", "high", "low", "close", "volume"]:
        out[col] = pd.to_numeric(out[col], errors="coerce")
    out = out.dropna(subset=["timestamp", "close"]).sort_values("timestamp")
    if out.empty:
        return pd.DataFrame()
    out["mid_price"] = out["close"]
    out["bid_px"] = np.nan
    out["ask_px"] = np.nan
    out["bid_size"] = np.nan
    out["ask_size"] = np.nan
    out["spread"] = np.nan
    if not bbo_minute.empty:
        out = out.merge(bbo_minute, on="timestamp", how="left", suffixes=("", "_bbo"))
        for col in ["mid_price", "bid_px", "ask_px", "bid_size", "ask_size", "spread"]:
            bbo_col = f"{col}_bbo"
            if bbo_col in out.columns:
                out[col] = out[bbo_col].combine_first(out[col])
                out = out.drop(columns=[bbo_col])
    out["mid_price"] = out["mid_price"].fillna(out["close"])
    # If BBO was unavailable for a minute, keep a conservative synthetic spread.
    synth_spread = (out["high"] - out["low"]).abs().replace(0, np.nan).fillna(0.5).clip(lower=0.1)
    out["spread"] = out["spread"].fillna(synth_spread)
    out["bid_px"] = out["bid_px"].fillna(out["mid_price"] - out["spread"] / 2.0)
    out["ask_px"] = out["ask_px"].fillna(out["mid_price"] + out["spread"] / 2.0)
    out["bid_size"] = out["bid_size"].fillna(1.0)
    out["ask_size"] = out["ask_size"].fillna(1.0)
    out["bar_return"] = out["mid_price"].pct_change().fillna(0.0)
    out["minute"] = np.arange(len(out))
    return out[
        [
            "timestamp",
            "date",
            "signal_date",
            "trade_id",
            "source_split",
            "fold",
            "symbol",
            "mid_price",
            "bid_px",
            "ask_px",
            "bid_size",
            "ask_size",
            "volume",
            "spread",
            "bar_return",
            "open",
            "high",
            "low",
            "close",
            "minute",
        ]
    ]


def build_or_load_real_minute_feed(trades: pd.DataFrame, cfg: Config) -> tuple[pd.DataFrame, list[dict[str, Any]], str | None]:
    explicit = os.environ.get("HFCD_V124_REAL_MINUTE_FEED")
    if explicit and Path(explicit).exists():
        df = pd.read_csv(explicit)
        df["timestamp"] = pd.to_datetime(df["timestamp"], errors="coerce")
        return df, [{"source": "explicit_real_minute_feed", "path": explicit, "rows": int(len(df))}], str(Path(explicit).resolve())

    cache_dir = OUT_DIR / "cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    client = get_historical_client()
    frames: list[pd.DataFrame] = []
    logs: list[dict[str, Any]] = []
    bbo_sessions = 0

    for _, trade in trades.head(cfg.max_trades).iterrows():
        symbol = str(trade["front_symbol"])
        found = False
        for offset in [1, 2, 3, 4, 5]:
            session_date, start, end = session_bounds(trade["date"], cfg, offset_days=offset)
            safe_key = f"{symbol}_{session_date}".replace("/", "_")
            minute_cache = cache_dir / f"ohlcv_1m_{safe_key}.csv"
            bbo_cache = cache_dir / f"bbo_1s_{safe_key}.csv"

            try:
                if minute_cache.exists():
                    raw_minute = pd.read_csv(minute_cache)
                    minute_status = "cache"
                else:
                    raw_minute = fetch_range_to_df(client, schema="ohlcv-1m", symbol=symbol, start=start, end=end)
                    raw_minute.to_csv(minute_cache, index=False)
                    minute_status = "downloaded"
            except Exception as exc:
                raw_minute = pd.DataFrame()
                minute_status = f"failed:{type(exc).__name__}:{str(exc)[:120]}"

            bbo_minute = pd.DataFrame()
            bbo_rows = 0
            bbo_status = "not_requested"
            if bbo_sessions < cfg.max_bbo_sessions:
                try:
                    if bbo_cache.exists():
                        raw_bbo = pd.read_csv(bbo_cache)
                        bbo_status = "cache"
                    else:
                        raw_bbo = fetch_range_to_df(client, schema="bbo-1s", symbol=symbol, start=start, end=end)
                        raw_bbo.to_csv(bbo_cache, index=False)
                        bbo_status = "downloaded"
                    bbo = normalize_bbo(raw_bbo, symbol, session_date)
                    bbo_rows = int(len(bbo))
                    if bbo_rows == 0:
                        mbp_cache = cache_dir / f"mbp_1_{safe_key}.csv"
                        if mbp_cache.exists():
                            raw_bbo = pd.read_csv(mbp_cache)
                            bbo_status = "mbp-1-cache"
                        else:
                            raw_bbo = fetch_range_to_df(client, schema="mbp-1", symbol=symbol, start=start, end=end)
                            raw_bbo.to_csv(mbp_cache, index=False)
                            bbo_status = "mbp-1-downloaded"
                        bbo = normalize_bbo(raw_bbo, symbol, session_date)
                        bbo_rows = int(len(bbo))
                    if bbo_rows:
                        bbo_minute = aggregate_bbo_to_minute(bbo)
                        bbo_sessions += 1
                except Exception as exc:
                    bbo_status = f"failed:{type(exc).__name__}:{str(exc)[:120]}"

            feed = normalize_ohlcv_to_feed(raw_minute, bbo_minute, trade, session_date)
            logs.append(
                {
                    "trade_id": int(trade["trade_id"]),
                    "signal_date": pd.Timestamp(trade["date"]).date().isoformat(),
                    "session_date": session_date,
                    "offset_days": offset,
                    "symbol": symbol,
                    "start": start,
                    "end": end,
                    "ohlcv_1m_status": minute_status,
                    "ohlcv_1m_rows": int(len(feed)),
                    "bbo_1s_status": bbo_status,
                    "bbo_1s_rows": bbo_rows,
                }
            )
            if not feed.empty:
                frames.append(feed)
                found = True
                break
        if not found:
            continue

    if not frames:
        return pd.DataFrame(), logs, None
    feed_all = pd.concat(frames, ignore_index=True)
    path = OUT_DIR / "hfcd_trading_v1_24_minute_q_paths.csv"
    feed_all.to_csv(path, index=False)
    return feed_all, logs, str(path.resolve())


def validate_feed_schema(feed: pd.DataFrame, expected_cols: list[str]) -> dict[str, Any]:
    required = [
        "timestamp",
        "date",
        "symbol",
        "mid_price",
        "bid_px",
        "ask_px",
        "bid_size",
        "ask_size",
        "volume",
        "spread",
        "bar_return",
    ]
    missing = [c for c in required if c not in feed.columns]
    schema_missing = [c for c in expected_cols if c not in feed.columns]
    return {
        "required_missing": missing,
        "v1_23_schema_missing": schema_missing,
        "is_valid": not missing,
    }


def fill_price(action: str, row: pd.Series, cfg: Config, shock: float = 1.0) -> float:
    mid = float(row["mid_price"])
    half_spread = float(row["spread"]) / 2.0 if pd.notna(row["spread"]) else 0.25
    slippage = mid * (cfg.slippage_bps * shock / 10000.0)
    if action == "buy":
        return mid + half_spread + slippage
    return mid - half_spread - slippage


def run_replay(
    trades: pd.DataFrame,
    feed: pd.DataFrame,
    cfg: Config,
    *,
    shock: float = 1.0,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    trade_lookup = {int(row["trade_id"]): row for _, row in trades.iterrows()}
    replay_rows: list[dict[str, Any]] = []
    q_path_rows: list[dict[str, Any]] = []

    for trade_id, path in feed.groupby("trade_id"):
        trade_id = int(trade_id)
        if trade_id not in trade_lookup:
            continue
        trade = trade_lookup[trade_id]
        path = path.sort_values("timestamp").reset_index(drop=True)
        if len(path) < max(cfg.latency_minutes + 2, 10):
            continue
        entry_idx = min(cfg.latency_minutes, len(path) - 1)
        entry = path.iloc[entry_idx]
        entry_fill = fill_price("buy", entry, cfg, shock=shock)
        notional = float(trade["notional_usd"])
        open_multiplier = float(trade["position_multiplier"])
        remaining = open_multiplier
        realized = 0.0
        state = "Q_healthy_hold"
        exit_reason = "session_close"
        exit_minute = int(path["minute"].iloc[-1])
        exit_fill = float(path["mid_price"].iloc[-1])
        q_history: list[float] = []
        time_under_warning = 0
        time_under_soft = 0
        time_under_hard = 0
        q_hard_confirmed = False
        soft_reduce_count = 0
        peak_return = -999.0
        q_recovery = 0.0
        action_log: list[str] = []

        q_rank = float(trade["q_rank"])
        event_rank = float(trade["event_rank"])
        vol_rank = float(trade["vol_rank"])
        score_strength = float(trade["score_strength"])
        rolling_vol = max(float(trade["volatility_5d"]), 0.001)

        for _, row in path.iloc[entry_idx:].iterrows():
            minute = int(row["minute"])
            mid = float(row["mid_price"])
            trade_ret_mid = (mid - entry_fill) / entry_fill if entry_fill else 0.0
            peak_return = max(peak_return, trade_ret_mid)
            progress = (minute - entry_idx) / max(1, int(path["minute"].max()) - entry_idx)
            adverse = max(0.0, -trade_ret_mid)
            adverse_norm = min(1.0, adverse / max(0.01, rolling_vol * 2.0))
            spread_rate = float(row["spread"]) / mid if mid else 0.0
            cavity_penalty = min(0.24, spread_rate * 35.0)
            q_dynamic = (
                0.58
                + 0.36 * q_rank
                + 0.14 * score_strength
                - 0.18 * event_rank * progress
                - 0.12 * vol_rank * np.sqrt(max(progress, 0.0))
                - 0.30 * adverse_norm
                - cavity_penalty
            )
            q_dynamic = float(np.clip(q_dynamic, 0.0, 1.0))
            previous_q = q_history[-1] if q_history else q_dynamic
            q_slope = q_dynamic - previous_q
            q_history.append(q_dynamic)
            if len(q_history) > 1:
                q_recovery = max(q_recovery, q_dynamic - min(q_history))

            if q_dynamic < cfg.q_warning:
                time_under_warning += 1
            if q_dynamic < cfg.q_soft_reduce:
                time_under_soft += 1
            if q_dynamic < cfg.q_hard_exit:
                time_under_hard += 1
            else:
                time_under_hard = 0

            state = "Q_healthy_hold"
            if q_dynamic < cfg.q_warning:
                state = "Q_warning_monitor"
            if q_dynamic < cfg.q_soft_reduce:
                state = "Q_soft_reduce"
            if q_dynamic < cfg.q_hard_exit:
                state = "Q_hard_exit_pending"

            action = "hold"
            if (
                q_dynamic < cfg.q_hard_exit
                and q_slope < 0
                and time_under_hard >= cfg.hard_confirm_minutes
            ):
                exit_fill = fill_price("sell", row, cfg, shock=shock)
                realized += notional * remaining * ((exit_fill - entry_fill) / entry_fill)
                remaining = 0.0
                exit_reason = "Q_hard_exit_confirmed"
                state = "Q_hard_exit_confirmed"
                exit_minute = minute
                q_hard_confirmed = True
                action = "exit"
            elif q_dynamic < cfg.q_soft_reduce and q_slope < 0 and remaining > 0.50:
                exit_fill = fill_price("sell", row, cfg, shock=shock)
                close_fraction = remaining - 0.50
                realized += notional * close_fraction * ((exit_fill - entry_fill) / entry_fill)
                remaining = 0.50
                soft_reduce_count += 1
                state = "Q_soft_reduce"
                action = "soft_reduce"

            profit_lock_ready = (
                q_dynamic < cfg.q_health_for_winner_run
                and minute >= cfg.min_minutes_before_trailing
                and peak_return >= cfg.trailing_activate_return
                and (peak_return - trade_ret_mid) >= cfg.trailing_giveback_return
            )
            if remaining > 0.0 and profit_lock_ready:
                exit_fill = fill_price("sell", row, cfg, shock=shock)
                realized += notional * remaining * ((exit_fill - entry_fill) / entry_fill)
                remaining = 0.0
                exit_reason = "profit_preserving_trailing"
                state = "profit_preserving_trailing"
                exit_minute = minute
                action = "exit"
            elif remaining > 0.0 and peak_return >= cfg.trailing_activate_return:
                state = "profit_lock_monitor"

            q_path_rows.append(
                {
                    "trade_id": trade_id,
                    "timestamp": row["timestamp"],
                    "minute": minute,
                    "state": state,
                    "mid_price": mid,
                    "trade_return_mid": trade_ret_mid,
                    "q_dynamic": q_dynamic,
                    "q_slope": q_slope,
                    "q_recovery": q_recovery,
                    "time_under_q_warning": time_under_warning,
                    "time_under_q_soft": time_under_soft,
                    "time_under_q_hard": time_under_hard,
                    "spread": float(row["spread"]),
                    "remaining_position": remaining,
                    "action": action,
                }
            )
            if action != "hold":
                action_log.append(f"{minute}:{action}:{state}:q={q_dynamic:.3f}:ret={trade_ret_mid:.5f}")
            if remaining <= 0.0:
                break

        if remaining > 0.0:
            last = path.iloc[-1]
            exit_fill = fill_price("sell", last, cfg, shock=shock)
            realized += notional * remaining * ((exit_fill - entry_fill) / entry_fill)
            exit_reason = "session_close"
            state = "session_close"
        realized -= notional * open_multiplier * float(trade["fee_rate"]) * shock

        replay_rows.append(
            {
                "trade_id": trade_id,
                "source_split": trade["source_split"],
                "fold": trade["fold"],
                "signal_date": pd.Timestamp(trade["date"]).date().isoformat(),
                "session_date": str(path["date"].iloc[0]),
                "symbol": trade["front_symbol"],
                "score": float(trade["score"]),
                "entry_fill": entry_fill,
                "exit_fill": exit_fill,
                "exit_minute": exit_minute,
                "exit_state": state,
                "exit_reason": exit_reason,
                "q_hard_confirmed": q_hard_confirmed,
                "q_final": q_history[-1] if q_history else 0.0,
                "q_min": min(q_history) if q_history else 0.0,
                "q_recovery": q_recovery,
                "time_under_q_warning": time_under_warning,
                "time_under_q_soft": time_under_soft,
                "time_under_q_hard": time_under_hard,
                "soft_reduce_count": soft_reduce_count,
                "minute_rows": int(len(path)),
                "v1_22_pnl_usd": float(trade["pnl_usd"]),
                "v1_24_real_minute_pnl_usd": float(realized),
                "pnl_delta_vs_v22_usd": float(realized - trade["pnl_usd"]),
                "action_log": " | ".join(action_log[:20]),
                "shock_multiplier": shock,
            }
        )

    return pd.DataFrame(replay_rows), pd.DataFrame(q_path_rows)


def summarize_exits(replay: pd.DataFrame) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if replay.empty:
        return rows
    for reason, group in replay.groupby("exit_reason"):
        rows.append(
            {
                "exit_reason": reason,
                "count": int(len(group)),
                "v1_24_net_pnl_usd": float(group["v1_24_real_minute_pnl_usd"].sum()),
                "v1_22_net_pnl_usd": float(group["v1_22_pnl_usd"].sum()),
                "win_rate": float((group["v1_24_real_minute_pnl_usd"] > 0).mean()),
                "avg_exit_minute": float(group["exit_minute"].mean()),
                "q_hard_confirmed_count": int(group["q_hard_confirmed"].sum()),
            }
        )
    return sorted(rows, key=lambda r: r["count"], reverse=True)


def split_rows(replay: pd.DataFrame, pnl_col: str) -> list[dict[str, Any]]:
    if replay.empty:
        return []
    rows: list[dict[str, Any]] = []
    for split, group in replay.groupby("source_split"):
        rows.append({"source_split": split, "pnl_col": pnl_col, **metrics(group[pnl_col].astype(float).tolist())})
    return rows


def create_plot(replay: pd.DataFrame, q_paths: pd.DataFrame, path: Path) -> None:
    import matplotlib.pyplot as plt

    fig, axes = plt.subplots(2, 2, figsize=(14, 9))
    if not replay.empty:
        ordered = replay.sort_values(["signal_date", "trade_id"]).reset_index(drop=True)
        axes[0, 0].plot(np.cumsum(ordered["v1_22_pnl_usd"]), label="V1.22 frozen")
        axes[0, 0].plot(np.cumsum(ordered["v1_24_real_minute_pnl_usd"]), label="V1.24 real minute")
        axes[0, 0].legend()
    axes[0, 0].set_title("Cumulative PnL")
    axes[0, 0].grid(alpha=0.25)

    if not replay.empty:
        counts = replay["exit_reason"].value_counts()
        axes[0, 1].bar(counts.index, counts.values)
        axes[0, 1].tick_params(axis="x", rotation=18)
    axes[0, 1].set_title("Exit state counts")
    axes[0, 1].grid(axis="y", alpha=0.25)

    if not q_paths.empty:
        sample_id = int(q_paths["trade_id"].iloc[0])
        sample = q_paths[q_paths["trade_id"] == sample_id]
        axes[1, 0].plot(sample["minute"], sample["q_dynamic"], label=f"trade {sample_id}")
        axes[1, 0].axhline(0.85, color="orange", linestyle="--")
        axes[1, 0].axhline(0.70, color="red", linestyle="--")
        axes[1, 0].axhline(0.40, color="black", linestyle="--")
        axes[1, 0].legend()
    axes[1, 0].set_title("Sample Q path")
    axes[1, 0].grid(alpha=0.25)

    if not replay.empty:
        axes[1, 1].hist(replay["pnl_delta_vs_v22_usd"], bins=18)
    axes[1, 1].set_title("PnL delta vs V1.22")
    axes[1, 1].grid(alpha=0.25)
    fig.tight_layout()
    fig.savefig(path, dpi=180)
    plt.close(fig)


def write_report(summary: dict[str, Any], exit_rows: list[dict[str, Any]], split_metrics_rows: list[dict[str, Any]]) -> None:
    base = summary["v1_22_matched_metrics"]
    v23 = summary["v1_23_proxy_matched_metrics"]
    v24 = summary["v1_24_real_minute_metrics"]
    shock = summary["v1_24_2x_cost_shock_metrics"]
    lines = [
        f"# {VERSION}",
        "",
        "## 结论",
        "",
        f"- 状态：`{summary['status']}`",
        f"- 真实分钟 feed：`{summary['real_minute_feed_path']}`",
        f"- 匹配交易：{summary['matched_trade_count']} / {summary['requested_trade_count']}",
        f"- 分钟行数：{summary['minute_rows']}",
        "",
        "## V1.22 / V1.23 / V1.24 对比",
        "",
        "| 指标 | V1.22 frozen | V1.23 proxy matched | V1.24 real minute | V1.24 2x cost shock |",
        "|---|---:|---:|---:|---:|",
        f"| trades | {base['trades']} | {v23['trades']} | {v24['trades']} | {shock['trades']} |",
        f"| win_rate | {base['win_rate']:.2%} | {v23['win_rate']:.2%} | {v24['win_rate']:.2%} | {shock['win_rate']:.2%} |",
        f"| net_pnl | ${base['net_pnl_usd']:.2f} | ${v23['net_pnl_usd']:.2f} | ${v24['net_pnl_usd']:.2f} | ${shock['net_pnl_usd']:.2f} |",
        f"| PF | {base['profit_factor']:.3f} | {v23['profit_factor']:.3f} | {v24['profit_factor']:.3f} | {shock['profit_factor']:.3f} |",
        f"| max_dd | ${base['max_drawdown_usd']:.2f} | ${v23['max_drawdown_usd']:.2f} | ${v24['max_drawdown_usd']:.2f} | ${shock['max_drawdown_usd']:.2f} |",
        "",
        "## 退出原因",
        "",
        "| reason | count | V1.24 pnl | V1.22 pnl | win_rate | avg_exit_minute |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for row in exit_rows:
        lines.append(
            f"| {row['exit_reason']} | {row['count']} | ${row['v1_24_net_pnl_usd']:.2f} | "
            f"${row['v1_22_net_pnl_usd']:.2f} | {row['win_rate']:.2%} | {row['avg_exit_minute']:.1f} |"
        )
    lines.extend(
        [
            "",
            "## 分段指标",
            "",
            "| split | pnl_col | trades | win_rate | net_pnl | PF | max_dd |",
            "|---|---|---:|---:|---:|---:|---:|",
        ]
    )
    for row in split_metrics_rows:
        lines.append(
            f"| {row['source_split']} | {row['pnl_col']} | {row['trades']} | {row['win_rate']:.2%} | "
            f"${row['net_pnl_usd']:.2f} | {row['profit_factor']:.3f} | ${row['max_drawdown_usd']:.2f} |"
        )
    lines.extend(
        [
            "",
            "## 必答审计",
            "",
            f"1. 是否使用真实分钟数据，而非 proxy？{'是' if summary['real_minute_feed_path'] else '否'}。",
            f"2. Q hard exit 是否继续压缩亏损？{summary['audit_answers']['q_hard_exit_loss_compression']}",
            f"3. trailing 是否不再削掉大赢家？{summary['audit_answers']['trailing_preserves_winners']}",
            f"4. PF / DD / net PnL 是否优于或接近 V1.22？{summary['audit_answers']['near_or_better_than_v22']}",
            f"5. 2x fee / slippage shock 是否仍为正？{summary['audit_answers']['shock_positive']}",
            f"6. 是否可升级为 gold_real_minute_q_exit_candidate？{summary['candidate_decision']}",
            "",
            "## 频率边界",
            "",
            "分钟级 feed 增加的是执行、减仓和平仓检查频率，不等于自动产生更多独立入场信号。黄金 V1.22/V1.24 的主信号仍是低频宏观/物性信号；如果强行每分钟开新仓，通常是在交易噪声，不是在提升模型能力。",
        ]
    )
    (OUT_DIR / "HFCD_Trading_V1_24_GoldRealMinuteQFeed_ProfitPreservingExit.md").write_text(
        "\n".join(lines) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    cfg = Config()
    schema_cols = load_schema()
    selected = load_selected_trades().head(cfg.max_trades).copy()
    try:
        feed, acquisition_logs, feed_path = build_or_load_real_minute_feed(selected, cfg)
    except Exception as exc:
        feed = pd.DataFrame()
        acquisition_logs = [{"status": "real_minute_feed_failed", "error": f"{type(exc).__name__}: {str(exc)[:240]}"}]
        feed_path = None

    schema_check = validate_feed_schema(feed, schema_cols) if not feed.empty else {"is_valid": False, "required_missing": []}
    if feed.empty or not schema_check["is_valid"] or not feed_path:
        summary = {
            "version": VERSION,
            "generated_at": datetime.now().isoformat(timespec="seconds"),
            "status": "proxy_warning_real_minute_feed_missing",
            "real_minute_feed_path": feed_path,
            "schema_check": schema_check,
            "acquisition_log": acquisition_logs,
            "notes": ["No valid real minute feed was available; V1.24 is not promotable."],
        }
        write_csv(OUT_DIR / "hfcd_trading_v1_24_acquisition_log.csv", acquisition_logs)
        (OUT_DIR / "hfcd_trading_v1_24_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return

    replay, q_paths = run_replay(selected, feed, cfg, shock=1.0)
    shock_replay, _ = run_replay(selected, feed, cfg, shock=cfg.shock_multiplier)
    v23 = load_v23_proxy()
    if not replay.empty and not v23.empty:
        v23_matched = v23[v23["trade_id"].isin(replay["trade_id"])]
    else:
        v23_matched = pd.DataFrame()

    v22_metrics = metrics(replay["v1_22_pnl_usd"].astype(float).tolist()) if not replay.empty else metrics([])
    v23_metrics = metrics(v23_matched["v1_23_proxy_pnl_usd"].astype(float).tolist()) if "v1_23_proxy_pnl_usd" in v23_matched else metrics([])
    v24_metrics = metrics(replay["v1_24_real_minute_pnl_usd"].astype(float).tolist()) if not replay.empty else metrics([])
    shock_metrics = metrics(shock_replay["v1_24_real_minute_pnl_usd"].astype(float).tolist()) if not shock_replay.empty else metrics([])
    exit_rows = summarize_exits(replay)
    split_metrics_rows = (
        split_rows(replay, "v1_22_pnl_usd")
        + split_rows(replay, "v1_24_real_minute_pnl_usd")
        + split_rows(shock_replay, "v1_24_real_minute_pnl_usd")
    )

    q_hard = replay[replay["exit_reason"] == "Q_hard_exit_confirmed"] if not replay.empty else pd.DataFrame()
    trailing = replay[replay["exit_reason"] == "profit_preserving_trailing"] if not replay.empty else pd.DataFrame()
    q_compression = "无 Q hard exit 样本，不能判断"
    if not q_hard.empty:
        q_compression = (
            "是"
            if float(q_hard["v1_24_real_minute_pnl_usd"].sum()) >= float(q_hard["v1_22_pnl_usd"].sum())
            else "否"
        )
    trailing_ok = "无 trailing 样本，不能判断"
    if not trailing.empty:
        trailing_ok = (
            "是"
            if float(trailing["v1_24_real_minute_pnl_usd"].sum()) >= 0.70 * float(trailing["v1_22_pnl_usd"].sum())
            else "否"
        )
    near_or_better = (
        v24_metrics["net_pnl_usd"] >= 0.80 * v22_metrics["net_pnl_usd"]
        and v24_metrics["profit_factor"] >= 0.80 * v22_metrics["profit_factor"]
        and abs(v24_metrics["max_drawdown_usd"]) <= 1.20 * abs(v22_metrics["max_drawdown_usd"] or -1.0)
    )
    shock_positive = shock_metrics["net_pnl_usd"] > 0
    candidate = (
        "yes"
        if replay.shape[0] >= 24 and v24_metrics["net_pnl_usd"] > 0 and shock_positive and near_or_better
        else "watchlist_not_promoted"
    )

    plot_path = OUT_DIR / "HFCD_Trading_V1_24_GoldRealMinuteQFeed_ProfitPreservingExit.png"
    create_plot(replay, q_paths, plot_path)
    replay.to_csv(OUT_DIR / "hfcd_trading_v1_24_trade_replay.csv", index=False)
    q_paths.to_csv(OUT_DIR / "hfcd_trading_v1_24_minute_q_paths.csv", index=False)
    write_csv(OUT_DIR / "hfcd_trading_v1_24_exit_reason_summary.csv", exit_rows)
    write_csv(OUT_DIR / "hfcd_trading_v1_24_acquisition_log.csv", acquisition_logs)
    write_csv(OUT_DIR / "hfcd_trading_v1_24_split_metrics.csv", split_metrics_rows)

    summary_rows = [
        {"model": "V1.22 frozen matched", **v22_metrics},
        {"model": "V1.23 proxy matched", **v23_metrics},
        {"model": "V1.24 real minute", **v24_metrics},
        {"model": "V1.24 real minute 2x cost shock", **shock_metrics},
    ]
    write_csv(OUT_DIR / "hfcd_trading_v1_24_summary.csv", summary_rows)

    summary = {
        "version": VERSION,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "status": "gold_real_minute_q_exit_candidate" if candidate == "yes" else "gold_real_minute_q_exit_watchlist",
        "candidate_decision": candidate,
        "data_mode": "real_minute_feed",
        "real_minute_feed_path": feed_path,
        "schema_check": schema_check,
        "config": cfg.__dict__,
        "requested_trade_count": int(len(selected)),
        "matched_trade_count": int(len(replay)),
        "minute_rows": int(len(feed)),
        "v1_22_matched_metrics": v22_metrics,
        "v1_23_proxy_matched_metrics": v23_metrics,
        "v1_24_real_minute_metrics": v24_metrics,
        "v1_24_2x_cost_shock_metrics": shock_metrics,
        "exit_reason_summary": exit_rows,
        "audit_answers": {
            "q_hard_exit_loss_compression": q_compression,
            "trailing_preserves_winners": trailing_ok,
            "near_or_better_than_v22": "是" if near_or_better else "否",
            "shock_positive": "是" if shock_positive else "否",
        },
        "plot": str(plot_path),
    }
    (OUT_DIR / "hfcd_trading_v1_24_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_report(summary, exit_rows, split_metrics_rows)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
