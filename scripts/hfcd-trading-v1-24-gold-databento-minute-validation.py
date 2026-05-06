#!/usr/bin/env python3
"""
HFCD Trading V1.24 Gold Databento Minute Validation

Goal:
- Freeze V1.22 gold strategy q_soft_reduce_floor_1p10.
- Replace V1.23 proxy minute paths with real Databento GC ohlcv-1m where
  available for the next-session window after each selected daily signal.
- Download one bounded longer bbo-1s sample to improve execution-cavity
  calibration without pulling uncontrolled L2 history.

This is still local research/paper validation. It does not place orders.
"""

from __future__ import annotations

import csv
import json
import os
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


VERSION = "HFCD_Trading_V1_24_GoldDatabentoMinuteValidation"
ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v1_24_gold_databento_minute_validation"
V22_DIR = ROOT / "outputs" / "hfcd_trading_v1_22_gold_execution_qdrift_replay"
V22_HOLDOUT = V22_DIR / "hfcd_trading_v1_22_holdout_trades.csv"
V22_ROLLING = V22_DIR / "hfcd_trading_v1_22_rolling_trades.csv"

DATASET = "GLBX.MDP3"
FROZEN_VARIANT = "q_soft_reduce_floor_1p10"
FROZEN_FRICTION = "l2_estimated"
THRESHOLD = 1.10
DEFAULT_SESSION_START = "13:30"
DEFAULT_SESSION_END = "20:00"
DEFAULT_MAX_TRADES = 64
DEFAULT_MAX_BBO_SESSIONS = 1

Q_WARNING = 0.85
Q_SOFT_REDUCE = 0.70
Q_HARD_EXIT = 0.40
SOFT_POSITION_MULTIPLIER = 0.50
TRAILING_ACTIVATE_RETURN = 0.006
TRAILING_GIVEBACK_RETURN = 0.0035


@dataclass(frozen=True)
class Config:
    max_trades: int
    max_bbo_sessions: int
    session_start: str
    session_end: str
    q_warning: float = Q_WARNING
    q_soft_reduce: float = Q_SOFT_REDUCE
    q_hard_exit: float = Q_HARD_EXIT
    trailing_activate_return: float = TRAILING_ACTIVATE_RETURN
    trailing_giveback_return: float = TRAILING_GIVEBACK_RETURN


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


def load_selected_trades() -> pd.DataFrame:
    frames: list[pd.DataFrame] = []
    for path, split in [(V22_HOLDOUT, "holdout"), (V22_ROLLING, "rolling")]:
        if not path.exists():
            raise FileNotFoundError(f"Missing V1.22 selected trade file: {path}")
        df = pd.read_csv(path)
        df["source_split"] = split
        frames.append(df)
    trades = pd.concat(frames, ignore_index=True)
    trades = trades[
        (trades["variant"] == FROZEN_VARIANT)
        & (trades["friction_label"] == FROZEN_FRICTION)
    ].copy()
    if trades.empty:
        raise ValueError("No V1.22 q_soft_reduce/l2_estimated selected trades found.")
    trades["date"] = pd.to_datetime(trades["date"])
    for col in [
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
    ]:
        trades[col] = pd.to_numeric(trades[col], errors="coerce").fillna(0.0)
    return trades.sort_values(["date", "source_split"]).reset_index(drop=True)


def session_bounds(signal_date: pd.Timestamp, cfg: Config) -> tuple[str, str, str]:
    # Daily signal uses front_ret_next, so intraday validation starts on the
    # next calendar day. Missing weekend/holiday sessions are recorded as no data.
    session_date = (signal_date + pd.Timedelta(days=1)).date().isoformat()
    return (
        session_date,
        f"{session_date}T{cfg.session_start}",
        f"{session_date}T{cfg.session_end}",
    )


def get_historical_client() -> Any:
    load_env_file(ROOT / ".env.local")
    load_env_file(ROOT / ".dev.vars")
    key = os.environ.get("DATABENTO_API_KEY")
    if not key:
        raise RuntimeError("DATABENTO_API_KEY missing in local environment.")
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
    df = df.copy().reset_index()
    return df


def normalize_ohlcv(df: pd.DataFrame, trade: pd.Series, session_date: str) -> pd.DataFrame:
    if df.empty:
        return df
    out = df.copy()
    ts_col = "ts_event" if "ts_event" in out.columns else out.columns[0]
    out["timestamp"] = pd.to_datetime(out[ts_col], errors="coerce")
    out["date"] = session_date
    out["signal_date"] = pd.Timestamp(trade["date"]).date().isoformat()
    out["trade_id"] = int(trade.name)
    out["source_split"] = trade["source_split"]
    out["fold"] = trade["fold"]
    out["symbol"] = trade["front_symbol"]
    for col in ["open", "high", "low", "close", "volume"]:
        if col in out.columns:
            out[col] = pd.to_numeric(out[col], errors="coerce")
    out = out.dropna(subset=["timestamp", "close"]).sort_values("timestamp")
    if out.empty:
        return out
    entry_close = float(out["close"].iloc[0])
    out["entry_minute_close"] = entry_close
    out["minute_return"] = (out["close"] / entry_close) - 1.0
    out["minute"] = np.arange(len(out))
    return out[
        [
            "trade_id",
            "source_split",
            "fold",
            "signal_date",
            "date",
            "timestamp",
            "minute",
            "symbol",
            "open",
            "high",
            "low",
            "close",
            "volume",
            "entry_minute_close",
            "minute_return",
        ]
    ]


def normalize_bbo(df: pd.DataFrame, symbol: str, session_date: str) -> pd.DataFrame:
    if df.empty:
        return df
    out = df.copy()
    ts_col = "ts_event" if "ts_event" in out.columns else out.columns[0]
    out["timestamp"] = pd.to_datetime(out[ts_col], errors="coerce")
    out["date"] = session_date
    out["symbol"] = symbol
    for col in ["bid_px_00", "ask_px_00", "bid_sz_00", "ask_sz_00"]:
        if col in out.columns:
            out[col] = pd.to_numeric(out[col], errors="coerce")
    if {"bid_px_00", "ask_px_00"}.issubset(out.columns):
        out["spread"] = out["ask_px_00"] - out["bid_px_00"]
        out["mid_price"] = (out["ask_px_00"] + out["bid_px_00"]) / 2.0
    if {"bid_sz_00", "ask_sz_00"}.issubset(out.columns):
        out["top_book_size"] = out["ask_sz_00"] + out["bid_sz_00"]
    keep = [
        "date",
        "timestamp",
        "symbol",
        "bid_px_00",
        "ask_px_00",
        "bid_sz_00",
        "ask_sz_00",
        "spread",
        "mid_price",
        "top_book_size",
    ]
    return out[[c for c in keep if c in out.columns]].dropna(subset=["timestamp"])


def robust_rank(values: pd.Series) -> pd.Series:
    return values.rank(method="average", pct=True).fillna(0.5).clip(0.0, 1.0)


def fetch_real_minute_data(trades: pd.DataFrame, cfg: Config) -> tuple[pd.DataFrame, pd.DataFrame, list[dict[str, Any]]]:
    cache_dir = OUT_DIR / "cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    client = get_historical_client()
    minute_frames: list[pd.DataFrame] = []
    bbo_frames: list[pd.DataFrame] = []
    logs: list[dict[str, Any]] = []
    bbo_sessions = 0

    for idx, trade in trades.head(cfg.max_trades).iterrows():
        session_date, start, end = session_bounds(trade["date"], cfg)
        symbol = str(trade["front_symbol"])
        safe_key = f"{symbol}_{session_date}".replace("/", "_")
        minute_cache = cache_dir / f"ohlcv_1m_{safe_key}.csv"
        bbo_cache = cache_dir / f"bbo_1s_{safe_key}.csv"

        if minute_cache.exists():
            raw_minute = pd.read_csv(minute_cache)
            minute_status = "cache"
        else:
            try:
                raw_minute = fetch_range_to_df(client, schema="ohlcv-1m", symbol=symbol, start=start, end=end)
                raw_minute.to_csv(minute_cache, index=False)
                minute_status = "downloaded"
            except Exception as exc:
                raw_minute = pd.DataFrame()
                minute_status = f"failed:{type(exc).__name__}:{str(exc)[:140]}"

        minute = normalize_ohlcv(raw_minute, trade, session_date)
        if not minute.empty:
            minute_frames.append(minute)

        bbo_rows = 0
        bbo_status = "not_requested"
        if bbo_sessions < cfg.max_bbo_sessions:
            if bbo_cache.exists():
                raw_bbo = pd.read_csv(bbo_cache)
                bbo_status = "cache"
            else:
                try:
                    raw_bbo = fetch_range_to_df(client, schema="bbo-1s", symbol=symbol, start=start, end=end)
                    raw_bbo.to_csv(bbo_cache, index=False)
                    bbo_status = "downloaded"
                except Exception as exc:
                    raw_bbo = pd.DataFrame()
                    bbo_status = f"failed:{type(exc).__name__}:{str(exc)[:140]}"
            bbo = normalize_bbo(raw_bbo, symbol, session_date)
            bbo_rows = int(len(bbo))
            if bbo_rows:
                bbo_frames.append(bbo)
                bbo_sessions += 1

        logs.append(
            {
                "trade_id": int(idx),
                "source_split": trade["source_split"],
                "fold": trade["fold"],
                "signal_date": pd.Timestamp(trade["date"]).date().isoformat(),
                "session_date": session_date,
                "symbol": symbol,
                "start": start,
                "end": end,
                "ohlcv_1m_status": minute_status,
                "ohlcv_1m_rows": int(len(minute)),
                "bbo_1s_status": bbo_status,
                "bbo_1s_rows": bbo_rows,
            }
        )

    minute_all = pd.concat(minute_frames, ignore_index=True) if minute_frames else pd.DataFrame()
    bbo_all = pd.concat(bbo_frames, ignore_index=True) if bbo_frames else pd.DataFrame()
    return minute_all, bbo_all, logs


def simulate_real_minute_replay(trades: pd.DataFrame, minute: pd.DataFrame) -> pd.DataFrame:
    trades = trades.copy()
    trades["q_rank"] = robust_rank(trades["q_core_quality_proxy"])
    trades["event_rank"] = robust_rank(trades["event_risk_proxy"])
    trades["vol_rank"] = robust_rank(trades["volatility_5d"])
    score_strength = ((trades["score"] - THRESHOLD) / THRESHOLD).clip(lower=0.0)
    trades["score_strength"] = (score_strength / (score_strength.quantile(0.95) or 1.0)).clip(0.0, 1.0)

    trade_lookup = {int(i): row for i, row in trades.iterrows()}
    rows: list[dict[str, Any]] = []
    for trade_id, path in minute.groupby("trade_id"):
        if int(trade_id) not in trade_lookup:
            continue
        trade = trade_lookup[int(trade_id)]
        path = path.sort_values("timestamp").reset_index(drop=True)
        if path.empty:
            continue
        base_notional = float(trade["notional_usd"])
        open_multiplier = float(trade["position_multiplier"])
        remaining = open_multiplier
        q_rank = float(trade["q_rank"])
        event_rank = float(trade["event_rank"])
        vol_rank = float(trade["vol_rank"])
        score_strength_value = float(trade["score_strength"])

        realized_pnl = 0.0
        peak_ret = -999.0
        exit_reason = "session_close"
        exit_minute = int(path["minute"].iloc[-1])
        action_log: list[str] = []
        last_ret = 0.0
        last_q = 0.0
        soft_reduce_count = 0
        warning_count = 0

        for _, m in path.iterrows():
            minute_index = int(m["minute"])
            total_minutes = max(int(path["minute"].max()), 1)
            progress = minute_index / total_minutes
            ret = float(m["minute_return"])
            last_ret = ret
            peak_ret = max(peak_ret, ret)
            adverse = max(0.0, -ret)
            rolling_vol = max(float(trade["volatility_5d"]), 0.001)
            adverse_norm = min(1.0, adverse / max(0.01, rolling_vol * 2.0))
            micro_range = 0.0
            close = float(m["close"])
            if close:
                micro_range = abs(float(m["high"]) - float(m["low"])) / close
            q_dynamic = (
                0.55
                + 0.34 * q_rank
                + 0.16 * score_strength_value
                - 0.18 * event_rank * progress
                - 0.14 * vol_rank * np.sqrt(progress)
                - 0.30 * adverse_norm
                - 0.12 * min(1.0, micro_range / max(rolling_vol, 1e-6))
            )
            q_dynamic = float(np.clip(q_dynamic, 0.0, 1.0))
            last_q = q_dynamic

            action = "hold"
            reason = ""
            if q_dynamic < Q_HARD_EXIT:
                action = "hard_exit"
                reason = "Q核严重漂移"
                realized_pnl += base_notional * remaining * ret
                remaining = 0.0
                exit_reason = reason
                exit_minute = minute_index
            elif q_dynamic < Q_SOFT_REDUCE and remaining > SOFT_POSITION_MULTIPLIER:
                action = "soft_reduce"
                reason = "Q核弱化减半"
                close_fraction = remaining - SOFT_POSITION_MULTIPLIER
                realized_pnl += base_notional * close_fraction * ret
                remaining = SOFT_POSITION_MULTIPLIER
                soft_reduce_count += 1
            elif q_dynamic < Q_WARNING:
                warning_count += 1

            if (
                remaining > 0.0
                and peak_ret >= TRAILING_ACTIVATE_RETURN
                and (peak_ret - ret) >= TRAILING_GIVEBACK_RETURN
            ):
                action = "trailing_exit"
                reason = "跟踪止盈回撤"
                realized_pnl += base_notional * remaining * ret
                remaining = 0.0
                exit_reason = reason
                exit_minute = minute_index

            if action != "hold":
                action_log.append(f"{minute_index}:{action}:{reason}:q={q_dynamic:.3f}:ret={ret:.5f}")

            if action in {"hard_exit", "trailing_exit"}:
                break

        if remaining > 0.0:
            realized_pnl += base_notional * remaining * last_ret
        realized_pnl -= base_notional * open_multiplier * float(trade["fee_rate"])

        rows.append(
            {
                "trade_id": int(trade_id),
                "source_split": trade["source_split"],
                "fold": trade["fold"],
                "signal_date": pd.Timestamp(trade["date"]).date().isoformat(),
                "session_date": str(path["date"].iloc[0]),
                "symbol": trade["front_symbol"],
                "score": float(trade["score"]),
                "v1_22_pnl_usd": float(trade["pnl_usd"]),
                "v1_24_real_minute_pnl_usd": float(realized_pnl),
                "pnl_delta_vs_v22_usd": float(realized_pnl - trade["pnl_usd"]),
                "entry_position_multiplier": open_multiplier,
                "exit_reason": exit_reason,
                "exit_minute": exit_minute,
                "q_final": last_q,
                "warning_count": int(warning_count),
                "soft_reduce_count": int(soft_reduce_count),
                "action_log": " | ".join(action_log[:12]),
                "minute_rows": int(len(path)),
                "session_return": float(path["minute_return"].iloc[-1]),
                "front_ret_next_daily": float(trade["front_ret_next"]),
            }
        )
    return pd.DataFrame(rows)


def split_metrics(df: pd.DataFrame, pnl_col: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if df.empty:
        return rows
    for split, g in df.groupby("source_split"):
        rows.append({"source_split": split, "pnl_col": pnl_col, **metrics(g[pnl_col].astype(float).tolist())})
    return rows


def action_summary(df: pd.DataFrame) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if df.empty:
        return rows
    for reason, g in df.groupby("exit_reason"):
        rows.append(
            {
                "exit_reason": reason,
                "count": int(len(g)),
                "real_minute_net_pnl_usd": float(g["v1_24_real_minute_pnl_usd"].sum()),
                "v22_net_pnl_usd": float(g["v1_22_pnl_usd"].sum()),
                "avg_exit_minute": float(g["exit_minute"].mean()),
                "win_rate": float((g["v1_24_real_minute_pnl_usd"] > 0).mean()),
            }
        )
    return sorted(rows, key=lambda x: x["count"], reverse=True)


def bbo_stats(bbo: pd.DataFrame) -> dict[str, Any]:
    if bbo.empty:
        return {"rows": 0, "median_spread": None, "median_top_book_size": None, "median_half_spread_rate": None}
    median_mid = float(pd.to_numeric(bbo.get("mid_price"), errors="coerce").median())
    median_spread = float(pd.to_numeric(bbo.get("spread"), errors="coerce").median())
    depth = float(pd.to_numeric(bbo.get("top_book_size"), errors="coerce").median())
    half_rate = float(median_spread / (2.0 * median_mid)) if median_mid else None
    return {
        "rows": int(len(bbo)),
        "first_ts": str(bbo["timestamp"].min()) if "timestamp" in bbo else "",
        "latest_ts": str(bbo["timestamp"].max()) if "timestamp" in bbo else "",
        "median_mid_price": median_mid,
        "median_spread": median_spread,
        "median_top_book_size": depth,
        "median_half_spread_rate": half_rate,
    }


def create_plot(trades: pd.DataFrame, minute: pd.DataFrame, out: Path) -> None:
    import matplotlib.pyplot as plt

    fig, axes = plt.subplots(2, 2, figsize=(14, 9))
    if not trades.empty:
        ordered = trades.sort_values(["signal_date", "trade_id"]).reset_index(drop=True)
        axes[0, 0].plot(np.cumsum(ordered["v1_22_pnl_usd"]), label="V1.22 daily")
        axes[0, 0].plot(np.cumsum(ordered["v1_24_real_minute_pnl_usd"]), label="V1.24 real minute")
        axes[0, 0].legend()
    axes[0, 0].set_title("Matched-trade cumulative PnL")
    axes[0, 0].grid(alpha=0.25)

    if not trades.empty:
        counts = trades["exit_reason"].replace({"Q核严重漂移": "q_hard_exit", "跟踪止盈回撤": "trailing_exit"}).value_counts()
        axes[0, 1].bar(counts.index.astype(str), counts.values)
    axes[0, 1].set_title("Exit reasons")
    axes[0, 1].tick_params(axis="x", rotation=20)
    axes[0, 1].grid(axis="y", alpha=0.25)

    if not minute.empty:
        sample_id = minute["trade_id"].iloc[0]
        s = minute[minute["trade_id"] == sample_id]
        axes[1, 0].plot(s["minute"], s["minute_return"])
        axes[1, 0].set_title(f"Real minute return sample trade {sample_id}")
    axes[1, 0].grid(alpha=0.25)

    if not trades.empty:
        axes[1, 1].hist(trades["q_final"], bins=14)
        axes[1, 1].axvline(Q_WARNING, linestyle="--", color="orange")
        axes[1, 1].axvline(Q_SOFT_REDUCE, linestyle="--", color="red")
    axes[1, 1].set_title("Final Q distribution")
    axes[1, 1].grid(alpha=0.25)

    fig.tight_layout()
    fig.savefig(out, dpi=180)
    plt.close(fig)


def write_report(summary: dict[str, Any], split_rows: list[dict[str, Any]], action_rows: list[dict[str, Any]]) -> None:
    matched = summary["matched_metrics"]
    base = summary["matched_v22_metrics"]
    lines = [
        f"# {VERSION}",
        "",
        "## 定位",
        "",
        "V1.24 用 Databento `ohlcv-1m` 替换 V1.23 的代理分钟路径；同时拉取受控 `bbo-1s` 样本，用于真实盘口摩擦审计。",
        "",
        f"- 状态：`{summary['status']}`",
        f"- 匹配交易数：{summary['matched_trade_count']} / {summary['requested_trade_count']}",
        f"- 分钟行数：{summary['minute_rows']}",
        f"- BBO 行数：{summary['bbo_stats']['rows']}",
        "",
        "## 匹配交易对照",
        "",
        "| 指标 | V1.22 daily | V1.24 real minute |",
        "|---|---:|---:|",
        f"| trades | {base['trades']} | {matched['trades']} |",
        f"| win_rate | {base['win_rate']:.2%} | {matched['win_rate']:.2%} |",
        f"| net_pnl | ${base['net_pnl_usd']:.2f} | ${matched['net_pnl_usd']:.2f} |",
        f"| PF | {base['profit_factor']:.3f} | {matched['profit_factor']:.3f} |",
        f"| max_dd | ${base['max_drawdown_usd']:.2f} | ${matched['max_drawdown_usd']:.2f} |",
        "",
        "## 分段结果",
        "",
        "| split | pnl_col | trades | win_rate | net_pnl | PF | max_dd |",
        "|---|---|---:|---:|---:|---:|---:|",
    ]
    for row in split_rows:
        lines.append(
            f"| {row['source_split']} | {row['pnl_col']} | {row['trades']} | {row['win_rate']:.2%} | "
            f"${row['net_pnl_usd']:.2f} | {row['profit_factor']:.3f} | ${row['max_drawdown_usd']:.2f} |"
        )
    lines.extend(
        [
            "",
            "## 退出原因",
            "",
            "| reason | count | real_minute_pnl | v22_pnl | avg_exit_minute | win_rate |",
            "|---|---:|---:|---:|---:|---:|",
        ]
    )
    for row in action_rows:
        lines.append(
            f"| {row['exit_reason']} | {row['count']} | ${row['real_minute_net_pnl_usd']:.2f} | "
            f"${row['v22_net_pnl_usd']:.2f} | {row['avg_exit_minute']:.1f} | {row['win_rate']:.2%} |"
        )
    lines.extend(
        [
            "",
            "## 判断",
            "",
            "- 如果匹配交易数不足，V1.24 只证明数据接入和执行框架，不证明收益稳定。",
            "- 分钟级操作只会增加执行/退出机会，不会自动增加宏观入场信号数量。",
            "- 下一步需要扩大匹配日期和更长 BBO/MBP 覆盖，再决定是否把分钟 Q 退出并入主线。",
        ]
    )
    (OUT_DIR / "HFCD_Trading_V1_24_GoldDatabentoMinuteValidation.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    cfg = Config(
        max_trades=int(os.environ.get("HFCD_V124_MAX_TRADES", DEFAULT_MAX_TRADES)),
        max_bbo_sessions=int(os.environ.get("HFCD_V124_MAX_BBO_SESSIONS", DEFAULT_MAX_BBO_SESSIONS)),
        session_start=os.environ.get("HFCD_V124_SESSION_START", DEFAULT_SESSION_START),
        session_end=os.environ.get("HFCD_V124_SESSION_END", DEFAULT_SESSION_END),
    )
    selected = load_selected_trades()
    requested = selected.head(cfg.max_trades).copy()

    minute, bbo, logs = fetch_real_minute_data(requested, cfg)
    replay = simulate_real_minute_replay(requested, minute) if not minute.empty else pd.DataFrame()
    split_rows: list[dict[str, Any]] = []
    action_rows: list[dict[str, Any]] = []

    if not replay.empty:
        split_rows = split_metrics(replay, "v1_22_pnl_usd") + split_metrics(replay, "v1_24_real_minute_pnl_usd")
        action_rows = action_summary(replay)
        base_metrics = metrics(replay["v1_22_pnl_usd"].astype(float).tolist())
        matched_metrics = metrics(replay["v1_24_real_minute_pnl_usd"].astype(float).tolist())
    else:
        base_metrics = metrics([])
        matched_metrics = metrics([])

    minute.to_csv(OUT_DIR / "hfcd_trading_v1_24_gc_ohlcv_1m_matched.csv", index=False)
    bbo.to_csv(OUT_DIR / "hfcd_trading_v1_24_gc_bbo_1s_extended_sample.csv", index=False)
    replay.to_csv(OUT_DIR / "hfcd_trading_v1_24_real_minute_trade_replay.csv", index=False)
    write_csv(OUT_DIR / "hfcd_trading_v1_24_acquisition_log.csv", logs)
    write_csv(OUT_DIR / "hfcd_trading_v1_24_split_metrics.csv", split_rows)
    write_csv(OUT_DIR / "hfcd_trading_v1_24_exit_reason_summary.csv", action_rows)

    plot_path = OUT_DIR / "HFCD_Trading_V1_24_GoldDatabentoMinuteValidation.png"
    create_plot(replay, minute, plot_path)

    summary = {
        "version": VERSION,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "status": "real_minute_validation_partial" if not replay.empty else "real_minute_download_no_matched_replay",
        "dataset": DATASET,
        "config": cfg.__dict__,
        "frozen_strategy": {
            "source": "V1.22",
            "variant": FROZEN_VARIANT,
            "friction": FROZEN_FRICTION,
            "threshold": THRESHOLD,
        },
        "requested_trade_count": int(len(requested)),
        "matched_trade_count": int(len(replay)),
        "minute_rows": int(len(minute)),
        "bbo_stats": bbo_stats(bbo),
        "matched_v22_metrics": base_metrics,
        "matched_metrics": matched_metrics,
        "action_summary": action_rows,
        "plot": str(plot_path),
        "notes": [
            "V1.24 uses real Databento ohlcv-1m where available for selected V1.22 trade sessions.",
            "BBO/MBP coverage is still bounded to avoid uncontrolled data cost.",
            "Minute-level execution can improve exits and sizing, but it does not create more daily macro entry signals by itself.",
        ],
    }
    (OUT_DIR / "hfcd_trading_v1_24_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    write_report(summary, split_rows, action_rows)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
