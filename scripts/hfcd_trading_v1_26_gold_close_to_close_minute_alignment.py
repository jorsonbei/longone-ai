#!/usr/bin/env python3
"""
HFCD Trading V1.26 Gold Close-to-Close Minute Alignment.

This is a data/holding-window validation run, not a strategy upgrade. V1.22
scores trades on daily front-close to next-front-close returns. V1.24 replayed
only a next-session intraday minute slice. V1.26 downloads or reuses real
Databento GC 1-minute bars for the full close-to-next-close holding window and
tests whether minute replay can reconstruct the frozen V1.22 PnL.
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
from pandas.errors import EmptyDataError


VERSION = "HFCD_Trading_V1_26_GoldCloseToCloseMinuteAlignment"
ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v1_26_gold_close_to_close_minute_alignment"
V22_DIR = ROOT / "outputs" / "hfcd_trading_v1_22_gold_execution_qdrift_replay"
V24_DIR = ROOT / "outputs" / "hfcd_trading_v1_24_gold_real_minute_qfeed_profit_exit"
V25_DIR = ROOT / "outputs" / "hfcd_trading_v1_25_gold_real_minute_feed_forensics"
V22_HOLDOUT = V22_DIR / "hfcd_trading_v1_22_holdout_trades.csv"
V22_ROLLING = V22_DIR / "hfcd_trading_v1_22_rolling_trades.csv"
V24_REPLAY = V24_DIR / "hfcd_trading_v1_24_trade_replay.csv"
V25_SUMMARY = V25_DIR / "hfcd_trading_v1_25_summary.json"

DATASET = "GLBX.MDP3"
FROZEN_VARIANT = "q_soft_reduce_floor_1p10"
FROZEN_FRICTION = "l2_estimated"


@dataclass(frozen=True)
class Config:
    max_trades: int = int(os.environ.get("HFCD_V126_MAX_TRADES", "64"))
    anchor_time_utc: str = os.environ.get("HFCD_V126_ANCHOR_TIME_UTC", "20:00")
    max_offset_days: int = int(os.environ.get("HFCD_V126_MAX_OFFSET_DAYS", "5"))
    min_close_to_close_rows: int = int(os.environ.get("HFCD_V126_MIN_CTC_ROWS", "720"))
    slippage_bps: float = float(os.environ.get("HFCD_V126_SLIPPAGE_BPS", "1.5"))
    cache_only: bool = os.environ.get("HFCD_V126_CACHE_ONLY", "0") == "1"


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
    numeric_cols = [
        "score",
        "position_multiplier",
        "notional_usd",
        "front_close",
        "front_ret_next",
        "fee_rate",
        "pnl_usd",
    ]
    for col in numeric_cols:
        trades[col] = pd.to_numeric(trades[col], errors="coerce").fillna(0.0)
    trades["trade_id"] = np.arange(len(trades))
    return trades.sort_values(["date", "source_split"]).reset_index(drop=True)


def get_historical_client() -> Any | None:
    load_env_file(ROOT / ".env.local")
    load_env_file(ROOT / ".dev.vars")
    key = os.environ.get("DATABENTO_API_KEY")
    if not key:
        return None
    import databento as db  # type: ignore

    return db.Historical(key=key)


def cache_read(path: Path) -> pd.DataFrame:
    if not path.exists() or path.stat().st_size == 0:
        return pd.DataFrame()
    try:
        return pd.read_csv(path)
    except EmptyDataError:
        return pd.DataFrame()


def fetch_range_to_df(client: Any, *, symbol: str, start: str, end: str) -> pd.DataFrame:
    data = client.timeseries.get_range(
        dataset=DATASET,
        schema="ohlcv-1m",
        symbols=[symbol],
        stype_in="raw_symbol",
        start=start,
        end=end,
    )
    df = data.to_df()
    if df is None or df.empty:
        return pd.DataFrame()
    return df.copy().reset_index()


def normalize_ohlcv(raw: pd.DataFrame, trade: pd.Series, start: str, end: str, offset_days: int) -> pd.DataFrame:
    if raw.empty:
        return pd.DataFrame()
    out = raw.copy()
    ts_col = "ts_event" if "ts_event" in out.columns else out.columns[0]
    out["timestamp"] = pd.to_datetime(out[ts_col], errors="coerce").dt.floor("min")
    for col in ["open", "high", "low", "close", "volume"]:
        out[col] = pd.to_numeric(out.get(col), errors="coerce")
    out = out.dropna(subset=["timestamp", "close"]).sort_values("timestamp").drop_duplicates("timestamp")
    if out.empty:
        return pd.DataFrame()
    out["trade_id"] = int(trade["trade_id"])
    out["signal_date"] = pd.Timestamp(trade["date"]).date().isoformat()
    out["source_split"] = trade["source_split"]
    out["fold"] = trade["fold"]
    out["symbol"] = str(trade["front_symbol"])
    out["window_start"] = start
    out["window_end"] = end
    out["offset_days"] = offset_days
    out["mid_price"] = out["close"]
    out["spread_proxy"] = (out["high"] - out["low"]).abs().replace(0, np.nan).fillna(0.0)
    out["bar_return"] = out["mid_price"].pct_change().fillna(0.0)
    out["minute"] = np.arange(len(out))
    return out[
        [
            "timestamp",
            "trade_id",
            "signal_date",
            "source_split",
            "fold",
            "symbol",
            "window_start",
            "window_end",
            "offset_days",
            "open",
            "high",
            "low",
            "close",
            "volume",
            "mid_price",
            "spread_proxy",
            "bar_return",
            "minute",
        ]
    ]


def ctc_bounds(signal_date: pd.Timestamp, cfg: Config, offset_days: int) -> tuple[str, str]:
    start_date = signal_date.date().isoformat()
    end_date = (signal_date + pd.Timedelta(days=offset_days)).date().isoformat()
    return f"{start_date}T{cfg.anchor_time_utc}", f"{end_date}T{cfg.anchor_time_utc}"


def fetch_or_load_window(client: Any | None, trade: pd.Series, cfg: Config, cache_dir: Path) -> tuple[pd.DataFrame, list[dict[str, Any]]]:
    symbol = str(trade["front_symbol"])
    signal_date = pd.Timestamp(trade["date"]).date().isoformat()
    logs: list[dict[str, Any]] = []
    best_feed = pd.DataFrame()
    best_rows = -1

    for offset_days in range(1, cfg.max_offset_days + 1):
        start, end = ctc_bounds(pd.Timestamp(trade["date"]), cfg, offset_days)
        safe_key = f"{symbol}_{signal_date}_to_plus{offset_days}_{cfg.anchor_time_utc.replace(':', '')}"
        cache_path = cache_dir / f"ohlcv_1m_ctc_{safe_key}.csv"
        status = "cache_miss"
        raw = pd.DataFrame()
        error = ""
        try:
            if cache_path.exists():
                raw = cache_read(cache_path)
                status = "cache"
            elif cfg.cache_only:
                status = "cache_only_missing"
            elif client is None:
                status = "missing_databento_api_key"
            else:
                raw = fetch_range_to_df(client, symbol=symbol, start=start, end=end)
                raw.to_csv(cache_path, index=False)
                status = "downloaded"
        except Exception as exc:
            status = f"failed:{type(exc).__name__}"
            error = str(exc)[:180]
            raw = pd.DataFrame()

        feed = normalize_ohlcv(raw, trade, start, end, offset_days)
        rows = int(len(feed))
        logs.append(
            {
                "trade_id": int(trade["trade_id"]),
                "signal_date": signal_date,
                "source_split": trade["source_split"],
                "fold": trade["fold"],
                "symbol": symbol,
                "offset_days": offset_days,
                "window_start": start,
                "window_end": end,
                "status": status,
                "rows": rows,
                "first_timestamp": str(feed["timestamp"].iloc[0]) if rows else "",
                "last_timestamp": str(feed["timestamp"].iloc[-1]) if rows else "",
                "error": error,
                "cache_path": str(cache_path),
            }
        )
        if rows > best_rows:
            best_feed = feed
            best_rows = rows
        if rows >= cfg.min_close_to_close_rows:
            return feed, logs
    return best_feed, logs


def build_minute_feed(trades: pd.DataFrame, cfg: Config) -> tuple[pd.DataFrame, list[dict[str, Any]], str | None]:
    cache_dir = OUT_DIR / "cache_ctc"
    cache_dir.mkdir(parents=True, exist_ok=True)
    client = get_historical_client()
    frames: list[pd.DataFrame] = []
    logs: list[dict[str, Any]] = []
    for _, trade in trades.head(cfg.max_trades).iterrows():
        feed, trade_logs = fetch_or_load_window(client, trade, cfg, cache_dir)
        logs.extend(trade_logs)
        if not feed.empty:
            frames.append(feed)
    if not frames:
        return pd.DataFrame(), logs, None
    feed_all = pd.concat(frames, ignore_index=True)
    path = OUT_DIR / "hfcd_trading_v1_26_minute_alignment.csv"
    feed_all.to_csv(path, index=False)
    return feed_all, logs, str(path.resolve())


def reconstruct(trades: pd.DataFrame, feed: pd.DataFrame, cfg: Config) -> tuple[pd.DataFrame, dict[str, Any], list[dict[str, Any]]]:
    lookup = {int(r["trade_id"]): r for _, r in trades.iterrows()}
    rows: list[dict[str, Any]] = []
    audit_rows: list[dict[str, Any]] = []
    for tid, g in feed.groupby("trade_id"):
        tid = int(tid)
        if tid not in lookup:
            continue
        trade = lookup[tid]
        g = g.sort_values("timestamp").reset_index(drop=True)
        if len(g) < 2:
            audit_rows.append({"trade_id": tid, "matched": False, "unmatched_reason": "too_few_rows", "rows": int(len(g))})
            continue
        entry = g.iloc[0]
        exit_ = g.iloc[-1]
        entry_mid = float(entry["mid_price"])
        exit_mid = float(exit_["mid_price"])
        notional = float(trade["notional_usd"])
        fee = float(trade["fee_rate"]) * notional
        minute_return_mid = (exit_mid / entry_mid - 1.0) if entry_mid else 0.0
        minute_mid_pnl = notional * minute_return_mid - fee
        entry_slip = entry_mid * cfg.slippage_bps / 10000.0
        exit_slip = exit_mid * cfg.slippage_bps / 10000.0
        execution_entry = entry_mid + entry_slip
        execution_exit = exit_mid - exit_slip
        minute_execution_return = execution_exit / execution_entry - 1.0 if execution_entry else 0.0
        minute_execution_pnl = notional * minute_execution_return - fee
        front_close_anchor_return = exit_mid / float(trade["front_close"]) - 1.0 if float(trade["front_close"]) else 0.0
        front_close_anchor_pnl = notional * front_close_anchor_return - fee
        entry_basis_points = entry_mid - float(trade["front_close"])
        exit_expected_close = float(trade["front_close"]) * (1.0 + float(trade["front_ret_next"]))
        exit_basis_points = exit_mid - exit_expected_close
        rows.append(
            {
                "trade_id": tid,
                "source_split": trade["source_split"],
                "fold": trade["fold"],
                "signal_date": pd.Timestamp(trade["date"]).date().isoformat(),
                "front_symbol": trade["front_symbol"],
                "window_start": str(g["window_start"].iloc[0]),
                "window_end": str(g["window_end"].iloc[0]),
                "offset_days": int(g["offset_days"].iloc[0]),
                "minute_rows": int(len(g)),
                "entry_timestamp": str(entry["timestamp"]),
                "exit_timestamp": str(exit_["timestamp"]),
                "v1_22_original_pnl": float(trade["pnl_usd"]),
                "v1_22_front_ret_next": float(trade["front_ret_next"]),
                "v1_22_front_close": float(trade["front_close"]),
                "v1_22_expected_exit_close": exit_expected_close,
                "minute_entry_mid": entry_mid,
                "minute_exit_mid": exit_mid,
                "entry_basis_points": entry_basis_points,
                "exit_basis_points": exit_basis_points,
                "entry_basis_bps": entry_basis_points / float(trade["front_close"]) * 10000.0 if float(trade["front_close"]) else 0.0,
                "exit_basis_bps": exit_basis_points / exit_expected_close * 10000.0 if exit_expected_close else 0.0,
                "minute_return_mid": minute_return_mid,
                "minute_mid_pnl": minute_mid_pnl,
                "minute_execution_pnl": minute_execution_pnl,
                "front_close_anchor_pnl": front_close_anchor_pnl,
                "pnl_diff_mid_minus_v22": minute_mid_pnl - float(trade["pnl_usd"]),
                "pnl_diff_anchor_minus_v22": front_close_anchor_pnl - float(trade["pnl_usd"]),
            }
        )
        audit_rows.append(
            {
                "trade_id": tid,
                "matched": True,
                "unmatched_reason": "matched",
                "rows": int(len(g)),
                "offset_days": int(g["offset_days"].iloc[0]),
                "entry_basis_abs": abs(entry_basis_points),
                "exit_basis_abs": abs(exit_basis_points),
            }
        )

    recon = pd.DataFrame(rows)
    if recon.empty:
        audit = {}
    else:
        v24_metrics = {}
        if V24_REPLAY.exists():
            v24 = pd.read_csv(V24_REPLAY)
            if "trade_id" in v24.columns and "v1_24_real_minute_pnl_usd" in v24.columns:
                v24 = v24[["trade_id", "v1_24_real_minute_pnl_usd"]].copy()
                v24["trade_id"] = pd.to_numeric(v24["trade_id"], errors="coerce").fillna(-1).astype(int)
                v24["v1_24_real_minute_pnl_usd"] = pd.to_numeric(v24["v1_24_real_minute_pnl_usd"], errors="coerce").fillna(0.0)
                joined = recon.merge(v24, on="trade_id", how="inner")
                v24_metrics = metrics(joined["v1_24_real_minute_pnl_usd"].astype(float).tolist()) if not joined.empty else {}
        audit = {
            "matched_trades": int(len(recon)),
            "pnl_corr_mid": safe_corr(recon["v1_22_original_pnl"], recon["minute_mid_pnl"]),
            "pnl_corr_front_close_anchor": safe_corr(recon["v1_22_original_pnl"], recon["front_close_anchor_pnl"]),
            "return_corr_mid": safe_corr(recon["v1_22_front_ret_next"], recon["minute_return_mid"]),
            "sign_match_mid": sign_match(recon["v1_22_original_pnl"], recon["minute_mid_pnl"]),
            "sign_match_front_close_anchor": sign_match(recon["v1_22_original_pnl"], recon["front_close_anchor_pnl"]),
            "mean_abs_diff_mid": float((recon["minute_mid_pnl"] - recon["v1_22_original_pnl"]).abs().mean()),
            "mean_abs_diff_front_close_anchor": float((recon["front_close_anchor_pnl"] - recon["v1_22_original_pnl"]).abs().mean()),
            "median_abs_entry_basis_points": float(recon["entry_basis_points"].abs().median()),
            "median_abs_exit_basis_points": float(recon["exit_basis_points"].abs().median()),
            "v1_22_metrics": metrics(recon["v1_22_original_pnl"].astype(float).tolist()),
            "minute_mid_metrics": metrics(recon["minute_mid_pnl"].astype(float).tolist()),
            "minute_execution_metrics": metrics(recon["minute_execution_pnl"].astype(float).tolist()),
            "front_close_anchor_metrics": metrics(recon["front_close_anchor_pnl"].astype(float).tolist()),
            "v1_24_matched_metrics": v24_metrics,
        }
    return recon, audit, audit_rows


def summarize_fetch_logs(logs: list[dict[str, Any]], trades: pd.DataFrame, recon: pd.DataFrame, cfg: Config) -> dict[str, Any]:
    selected = set(trades.head(cfg.max_trades)["trade_id"].astype(int).tolist())
    matched = set(recon["trade_id"].astype(int).tolist()) if not recon.empty else set()
    per_trade_rows: dict[int, int] = {}
    per_trade_status: dict[int, str] = {}
    for row in logs:
        tid = int(row["trade_id"])
        rows = int(row["rows"])
        if rows > per_trade_rows.get(tid, -1):
            per_trade_rows[tid] = rows
            per_trade_status[tid] = str(row["status"])
    unmatched = sorted(selected - matched)
    return {
        "selected_trade_count": len(selected),
        "matched_trade_count": len(matched),
        "unmatched_trade_count": len(unmatched),
        "matched_rate": float(len(matched) / len(selected)) if selected else 0.0,
        "unmatched_trade_ids": unmatched,
        "median_rows_per_matched_trade": float(recon["minute_rows"].median()) if not recon.empty else 0.0,
        "min_rows_per_matched_trade": int(recon["minute_rows"].min()) if not recon.empty else 0,
        "max_rows_per_matched_trade": int(recon["minute_rows"].max()) if not recon.empty else 0,
        "anchor_time_utc": cfg.anchor_time_utc,
        "min_close_to_close_rows": cfg.min_close_to_close_rows,
        "attempt_count": len(logs),
        "best_status_counts": pd.Series(list(per_trade_status.values())).value_counts().to_dict() if per_trade_status else {},
    }


def create_plot(recon: pd.DataFrame, audit: dict[str, Any], path: Path) -> None:
    import matplotlib.pyplot as plt

    fig, axes = plt.subplots(2, 2, figsize=(14, 9))
    if not recon.empty:
        ordered = recon.sort_values(["signal_date", "trade_id"])
        axes[0, 0].plot(np.cumsum(ordered["v1_22_original_pnl"]), label="V1.22 original")
        axes[0, 0].plot(np.cumsum(ordered["minute_mid_pnl"]), label="V1.26 close-to-close minute")
        axes[0, 0].plot(np.cumsum(ordered["front_close_anchor_pnl"]), label="V1.26 front-close anchored")
        axes[0, 0].legend()
        axes[0, 1].scatter(ordered["v1_22_original_pnl"], ordered["minute_mid_pnl"], s=18, label="minute mid")
        axes[0, 1].scatter(ordered["v1_22_original_pnl"], ordered["front_close_anchor_pnl"], s=18, alpha=0.65, label="front-close anchor")
        axes[0, 1].axhline(0, color="gray", linewidth=0.8)
        axes[0, 1].axvline(0, color="gray", linewidth=0.8)
        axes[0, 1].legend()
        axes[1, 0].hist(ordered["pnl_diff_mid_minus_v22"], bins=18, alpha=0.75, label="minute mid - V1.22")
        axes[1, 0].hist(ordered["pnl_diff_anchor_minus_v22"], bins=18, alpha=0.55, label="anchor - V1.22")
        axes[1, 0].legend()
        axes[1, 1].hist(ordered["entry_basis_bps"], bins=18, alpha=0.75, label="entry basis bps")
        axes[1, 1].hist(ordered["exit_basis_bps"], bins=18, alpha=0.55, label="exit basis bps")
        axes[1, 1].legend()
    axes[0, 0].set_title("Cumulative PnL")
    axes[0, 1].set_title(f"PnL corr mid={audit.get('pnl_corr_mid', 0):.3f}")
    axes[1, 0].set_title("PnL reconstruction difference")
    axes[1, 1].set_title("Minute vs daily close basis")
    for ax in axes.ravel():
        ax.grid(alpha=0.25)
    fig.tight_layout()
    fig.savefig(path, dpi=180)
    plt.close(fig)


def load_v25_reference() -> dict[str, Any]:
    if not V25_SUMMARY.exists():
        return {}
    try:
        return json.loads(V25_SUMMARY.read_text(encoding="utf-8"))
    except Exception:
        return {}


def write_report(feed_summary: dict[str, Any], audit: dict[str, Any], promotion: dict[str, Any]) -> None:
    v24 = audit.get("v1_24_matched_metrics", {})
    lines = [
        f"# {VERSION}",
        "",
        "## 定位",
        "",
        "V1.26 只做持仓窗口对齐验证：V1.22 是日线 front close 到下一日 front close，V1.24 是下一交易日日内切片。"
        " 本轮用真实 Databento `ohlcv-1m` 扩展到完整 close-to-next-close 窗口，判断分钟 replay 是否能重建 V1.22。",
        "",
        "## Feed 覆盖",
        "",
        f"- 选中交易：{feed_summary['selected_trade_count']}",
        f"- 匹配交易：{feed_summary['matched_trade_count']}",
        f"- 匹配率：{feed_summary['matched_rate']:.2%}",
        f"- 未匹配 trade_id：{feed_summary['unmatched_trade_ids']}",
        f"- anchor：{feed_summary['anchor_time_utc']} UTC",
        f"- 中位分钟行数：{feed_summary['median_rows_per_matched_trade']:.1f}",
        f"- 行数范围：{feed_summary['min_rows_per_matched_trade']} - {feed_summary['max_rows_per_matched_trade']}",
        "",
        "## 重构质量",
        "",
        f"- minute mid pnl_corr：{audit.get('pnl_corr_mid', 0):.3f}",
        f"- minute mid sign_match：{audit.get('sign_match_mid', 0):.2%}",
        f"- minute mid mean_abs_diff：${audit.get('mean_abs_diff_mid', 0):.2f}",
        f"- front-close anchored pnl_corr：{audit.get('pnl_corr_front_close_anchor', 0):.3f}",
        f"- front-close anchored sign_match：{audit.get('sign_match_front_close_anchor', 0):.2%}",
        f"- front-close anchored mean_abs_diff：${audit.get('mean_abs_diff_front_close_anchor', 0):.2f}",
        f"- 入口基差中位数：{audit.get('median_abs_entry_basis_points', 0):.2f} points",
        f"- 出口基差中位数：{audit.get('median_abs_exit_basis_points', 0):.2f} points",
        "",
        "| model | trades | win_rate | net_pnl | PF | max_dd |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for key, name in [
        ("v1_22_metrics", "V1.22 matched"),
        ("minute_mid_metrics", "V1.26 minute close-to-close"),
        ("front_close_anchor_metrics", "V1.26 front-close anchored"),
        ("minute_execution_metrics", "V1.26 minute + slippage"),
    ]:
        m = audit.get(key, {})
        lines.append(
            f"| {name} | {m.get('trades', 0)} | {m.get('win_rate', 0):.2%} | "
            f"${m.get('net_pnl_usd', 0):.2f} | {m.get('profit_factor', 0):.3f} | ${m.get('max_drawdown_usd', 0):.2f} |"
        )
    if v24:
        lines.append(
            f"| V1.24 session-slice matched | {v24.get('trades', 0)} | {v24.get('win_rate', 0):.2%} | "
            f"${v24.get('net_pnl_usd', 0):.2f} | {v24.get('profit_factor', 0):.3f} | ${v24.get('max_drawdown_usd', 0):.2f} |"
        )
    lines.extend(
        [
            "",
            "## 必答问题",
            "",
            f"1. 是否使用 close-to-next-close 分钟窗口？{promotion['used_close_to_close_answer']}",
            f"2. 是否比 V1.24 session slice 更接近 V1.22？{promotion['better_than_v24_answer']}",
            f"3. 剩余不一致来自哪里？{promotion['remaining_mismatch_answer']}",
            f"4. 是否允许继续优化 Q/trailing？{promotion['q_trailing_answer']}",
            "",
            f"最终状态：`{promotion['status']}`",
        ]
    )
    (OUT_DIR / "HFCD_Trading_V1_26_GoldCloseToCloseMinuteAlignment.md").write_text(
        "\n".join(lines) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    cfg = Config()
    selected = load_selected_trades()
    feed, fetch_logs, feed_path = build_minute_feed(selected, cfg)
    recon, audit, audit_rows = reconstruct(selected.head(cfg.max_trades), feed, cfg)
    feed_summary = summarize_fetch_logs(fetch_logs, selected, recon, cfg)
    v25_ref = load_v25_reference()
    v25_recon = v25_ref.get("reconstruction_audit", {}) if isinstance(v25_ref, dict) else {}

    feed_pass = feed_summary["matched_rate"] >= 0.95 and feed_summary["median_rows_per_matched_trade"] >= cfg.min_close_to_close_rows
    reconstruction_pass = (
        audit.get("pnl_corr_mid", 0.0) >= 0.90
        and audit.get("sign_match_mid", 0.0) >= 0.80
        and audit.get("mean_abs_diff_mid", 999.0) <= 25.0
    )
    v25_corr = float(v25_recon.get("pnl_corr", 0.0) or 0.0)
    v25_mae = float(v25_recon.get("mean_abs_diff_per_trade", 999.0) or 999.0)
    better_than_v24 = audit.get("pnl_corr_mid", 0.0) > v25_corr and audit.get("mean_abs_diff_mid", 999.0) < v25_mae
    status = (
        "gold_close_to_close_minute_feed_validated"
        if feed_pass and reconstruction_pass
        else "watchlist_not_promoted_close_to_close_alignment_failed"
    )
    promotion = {
        "status": status,
        "feed_pass": feed_pass,
        "reconstruction_pass": reconstruction_pass,
        "better_than_v24_session_slice": better_than_v24,
        "used_close_to_close_answer": "是。窗口使用信号日 20:00 UTC 到下一有效交易日 20:00 UTC；周末/节假日自动扩大 offset。",
        "better_than_v24_answer": "是。" if better_than_v24 else "还不能确认。",
        "remaining_mismatch_answer": "主要是日线 close/settlement 与 Databento 分钟 close 的时间锚不完全一致、连续前月映射与原始合约分钟数据差异、以及分钟 bar 无真实 settlement。",
        "q_trailing_answer": "允许进入下一步。" if reconstruction_pass else "不允许；先修复分钟收益重构，否则 Q/trailing 结论仍无统计意义。",
    }

    recon_path = OUT_DIR / "hfcd_trading_v1_26_reconstruction.csv"
    fetch_log_path = OUT_DIR / "hfcd_trading_v1_26_fetch_log.csv"
    feed_audit_path = OUT_DIR / "hfcd_trading_v1_26_feed_audit.csv"
    plot_path = OUT_DIR / "HFCD_Trading_V1_26_GoldCloseToCloseMinuteAlignment.png"
    recon.to_csv(recon_path, index=False)
    write_csv(fetch_log_path, fetch_logs)
    write_csv(feed_audit_path, audit_rows)
    create_plot(recon, audit, plot_path)

    summary = {
        "version": VERSION,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "status": status,
        "candidate_decision": "gold_close_to_close_minute_feed_validated" if status == "gold_close_to_close_minute_feed_validated" else "watchlist_not_promoted",
        "config": {
            "anchor_time_utc": cfg.anchor_time_utc,
            "max_trades": cfg.max_trades,
            "max_offset_days": cfg.max_offset_days,
            "min_close_to_close_rows": cfg.min_close_to_close_rows,
            "slippage_bps": cfg.slippage_bps,
            "cache_only": cfg.cache_only,
        },
        "feed_summary": feed_summary,
        "reconstruction_audit": audit,
        "v25_session_slice_reference": v25_recon,
        "promotion": promotion,
        "outputs": {
            "minute_alignment": feed_path,
            "reconstruction": str(recon_path),
            "fetch_log": str(fetch_log_path),
            "feed_audit": str(feed_audit_path),
            "plot": str(plot_path),
            "report": str(OUT_DIR / "HFCD_Trading_V1_26_GoldCloseToCloseMinuteAlignment.md"),
        },
    }
    (OUT_DIR / "hfcd_trading_v1_26_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    write_csv(
        OUT_DIR / "hfcd_trading_v1_26_summary.csv",
        [
            {"section": "feed", **feed_summary, "status": status},
            {
                "section": "reconstruction",
                "pnl_corr_mid": audit.get("pnl_corr_mid", 0.0),
                "sign_match_mid": audit.get("sign_match_mid", 0.0),
                "mean_abs_diff_mid": audit.get("mean_abs_diff_mid", 0.0),
                "pnl_corr_front_close_anchor": audit.get("pnl_corr_front_close_anchor", 0.0),
                "mean_abs_diff_front_close_anchor": audit.get("mean_abs_diff_front_close_anchor", 0.0),
                "status": status,
            },
        ],
    )
    write_report(feed_summary, audit, promotion)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
