#!/usr/bin/env python3
"""
HFCD Trading V1.23 Gold Minute Q Dynamic Exit Framework

This stage freezes the V1.22 promoted gold strategy:
  q_soft_reduce_floor_1p10

It adds a minute-level Q-drift execution framework:
- minute feed schema for future real GC/GLD minute or tick data;
- deterministic minute proxy replay when real minute data is absent;
- Q warning / soft-reduce / hard-exit / trailing-stop action ledger;
- replay reports and figures.

Important boundary:
The default run is a local framework/proxy replay if no real minute feed is
present. It must not be promoted as live or tick-validated evidence until a
real minute/tick feed is supplied.
"""

from __future__ import annotations

import csv
import json
import math
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


VERSION = "HFCD_Trading_V1_23_GoldMinuteQDynamicExit"
ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v1_23_gold_minute_q_dynamic_exit"
V22_DIR = ROOT / "outputs" / "hfcd_trading_v1_22_gold_execution_qdrift_replay"
V16_DIR = ROOT / "outputs" / "hfcd_trading_v1_16_gold_full_acquisition"

V22_SUMMARY = V22_DIR / "hfcd_trading_v1_22_summary.json"
V22_HOLDOUT = V22_DIR / "hfcd_trading_v1_22_holdout_trades.csv"
V22_ROLLING = V22_DIR / "hfcd_trading_v1_22_rolling_trades.csv"
BBO_SAMPLE = V16_DIR / "hfcd_trading_v1_16_gc_bbo_1s_sample.csv"

REAL_MINUTE_CANDIDATES = [
    ROOT / "data" / "gold_minute_feed.csv",
    ROOT / "outputs" / "gold_minute_feed.csv",
    OUT_DIR / "gold_minute_feed.csv",
]

FROZEN_VARIANT = "q_soft_reduce_floor_1p10"
FROZEN_FRICTION = "l2_estimated"
THRESHOLD = 1.10
MINUTES_PER_SESSION = 390

Q_WARNING = 0.85
Q_SOFT_REDUCE = 0.70
Q_HARD_EXIT = 0.40
SOFT_POSITION_MULTIPLIER = 0.50
TRAILING_ACTIVATE_RETURN = 0.006
TRAILING_GIVEBACK_RETURN = 0.0035


@dataclass(frozen=True)
class ReplayConfig:
    source_mode: str
    minute_rows_per_trade: int = MINUTES_PER_SESSION
    q_warning: float = Q_WARNING
    q_soft_reduce: float = Q_SOFT_REDUCE
    q_hard_exit: float = Q_HARD_EXIT
    trailing_activate_return: float = TRAILING_ACTIVATE_RETURN
    trailing_giveback_return: float = TRAILING_GIVEBACK_RETURN


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    fieldnames: list[str] = []
    for row in rows:
        for key in row:
            if key not in fieldnames:
                fieldnames.append(key)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
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


def load_v22_summary() -> dict[str, Any]:
    if not V22_SUMMARY.exists():
        raise FileNotFoundError(f"Missing V1.22 summary: {V22_SUMMARY}")
    return json.loads(V22_SUMMARY.read_text(encoding="utf-8"))


def load_selected_v22_trades() -> pd.DataFrame:
    frames: list[pd.DataFrame] = []
    for path, split in [(V22_HOLDOUT, "holdout"), (V22_ROLLING, "rolling")]:
        if not path.exists():
            raise FileNotFoundError(f"Missing V1.22 trades file: {path}")
        df = pd.read_csv(path)
        df["source_split"] = split
        frames.append(df)
    trades = pd.concat(frames, ignore_index=True)
    trades = trades[
        (trades["variant"] == FROZEN_VARIANT)
        & (trades["friction_label"] == FROZEN_FRICTION)
    ].copy()
    if trades.empty:
        raise ValueError("No selected V1.22 q_soft_reduce/l2_estimated trades found.")
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


def detect_real_minute_feed() -> Path | None:
    for path in REAL_MINUTE_CANDIDATES:
        if path.exists():
            return path
    return None


def write_minute_schema(path: Path) -> None:
    rows = [
        {
            "column": "timestamp",
            "required": True,
            "description": "UTC or exchange-local minute timestamp.",
            "example": "2026-05-01 13:30:00+00:00",
        },
        {
            "column": "date",
            "required": True,
            "description": "Trade date aligned to V1.22 selected trade date.",
            "example": "2026-05-01",
        },
        {
            "column": "symbol",
            "required": True,
            "description": "GC front contract or gold proxy symbol.",
            "example": "GCM6",
        },
        {
            "column": "mid_price",
            "required": True,
            "description": "Minute mid price. Required for real non-proxy PnL.",
            "example": "4612.95",
        },
        {
            "column": "bid_px",
            "required": False,
            "description": "Best bid price if available.",
            "example": "4612.9",
        },
        {
            "column": "ask_px",
            "required": False,
            "description": "Best ask price if available.",
            "example": "4613.0",
        },
        {
            "column": "top_book_size",
            "required": False,
            "description": "Best bid plus ask size or comparable depth proxy.",
            "example": "12",
        },
        {
            "column": "total_oi",
            "required": False,
            "description": "Open-interest proxy if available intraday; otherwise forward-fill daily.",
            "example": "366322",
        },
        {
            "column": "vix",
            "required": False,
            "description": "VIX value aligned to minute or latest available value.",
            "example": "14.2",
        },
        {
            "column": "fusion_score",
            "required": False,
            "description": "Latest HFCD gold fusion score, forward-filled from daily if needed.",
            "example": "1.42",
        },
    ]
    write_csv(path, rows)


def bbo_friction_stats() -> dict[str, Any]:
    if not BBO_SAMPLE.exists():
        return {"available": False, "rows": 0, "median_spread": None, "median_top_book_size": None}
    df = pd.read_csv(BBO_SAMPLE)
    if df.empty:
        return {"available": False, "rows": 0, "median_spread": None, "median_top_book_size": None}
    return {
        "available": True,
        "rows": int(len(df)),
        "median_spread": float(pd.to_numeric(df.get("spread"), errors="coerce").median()),
        "median_top_book_size": float(pd.to_numeric(df.get("top_book_size"), errors="coerce").median()),
    }


def robust_rank(values: pd.Series) -> pd.Series:
    return values.rank(method="average", pct=True).fillna(0.5).clip(0.0, 1.0)


def build_proxy_minute_path(trades: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Build deterministic proxy minute paths.

    This is a framework smoke test, not real minute market evidence. The proxy
    uses each trade's close-to-close return to produce a smooth intraday path
    so the execution state machine can be tested end-to-end.
    """
    trades = trades.copy()
    trades["q_rank"] = robust_rank(trades["q_core_quality_proxy"])
    trades["event_rank"] = robust_rank(trades["event_risk_proxy"])
    trades["vol_rank"] = robust_rank(trades["volatility_5d"])
    score_strength = ((trades["score"] - THRESHOLD) / THRESHOLD).clip(lower=0.0)
    trades["score_strength"] = (score_strength / (score_strength.quantile(0.95) or 1.0)).clip(0.0, 1.0)

    minute_rows: list[dict[str, Any]] = []
    trade_rows: list[dict[str, Any]] = []

    for idx, row in trades.iterrows():
        start = pd.Timestamp(row["date"]).replace(hour=13, minute=30, second=0)
        base_notional = float(row["notional_usd"])
        current_multiplier = float(row["position_multiplier"])
        open_multiplier = current_multiplier
        q_reduced = bool(row.get("q_reduction_applied", False))
        entry_price = float(row["front_close"])
        final_ret = float(row["front_ret_next"])
        vol = max(float(row["volatility_5d"]), 0.001)
        q_rank = float(row["q_rank"])
        event_rank = float(row["event_rank"])
        vol_rank = float(row["vol_rank"])
        score_strength_value = float(row["score_strength"])
        phase = (idx % 17) / 17.0 * 2.0 * math.pi

        realized_pnl = 0.0
        remaining_multiplier = current_multiplier
        exit_reason = "session_close"
        exit_minute = MINUTES_PER_SESSION - 1
        peak_ret = -999.0
        hard_exit = False
        soft_reduce_count = 0
        warning_count = 0
        action_log: list[str] = []
        last_ret = 0.0
        last_q = 0.0

        for minute in range(MINUTES_PER_SESSION):
            progress = minute / max(1, MINUTES_PER_SESSION - 1)
            time = start + timedelta(minutes=minute)

            # Smooth bridge to close-to-close outcome plus deterministic noise.
            oscillation = math.sin(phase + progress * math.pi * 4.0)
            micro_noise = vol * 0.18 * oscillation * math.sin(progress * math.pi)
            drift_path = final_ret * progress + micro_noise

            # Q proxy decays faster under high VIX/event, high volatility, and
            # adverse realized drift. Score strength provides support.
            adverse = max(0.0, -drift_path)
            adverse_norm = min(1.0, adverse / max(0.01, vol * 2.0))
            q_dynamic = (
                0.53
                + 0.34 * q_rank
                + 0.16 * score_strength_value
                - 0.18 * event_rank * progress
                - 0.14 * vol_rank * math.sqrt(progress)
                - 0.28 * adverse_norm
                + 0.025 * oscillation
            )
            q_dynamic = float(np.clip(q_dynamic, 0.0, 1.0))
            last_q = q_dynamic
            last_ret = drift_path
            peak_ret = max(peak_ret, drift_path)

            action = "hold"
            reason = ""
            if q_dynamic < Q_HARD_EXIT:
                action = "hard_exit"
                reason = "Q核严重漂移"
                realized_pnl += base_notional * remaining_multiplier * drift_path
                remaining_multiplier = 0.0
                exit_reason = reason
                exit_minute = minute
                hard_exit = True
            elif q_dynamic < Q_SOFT_REDUCE and remaining_multiplier > SOFT_POSITION_MULTIPLIER:
                action = "soft_reduce"
                reason = "Q核弱化减半"
                close_fraction = remaining_multiplier - SOFT_POSITION_MULTIPLIER
                realized_pnl += base_notional * close_fraction * drift_path
                remaining_multiplier = SOFT_POSITION_MULTIPLIER
                soft_reduce_count += 1
            elif q_dynamic < Q_WARNING:
                action = "warning"
                reason = "Q核预警"
                warning_count += 1

            if (
                remaining_multiplier > 0.0
                and peak_ret >= TRAILING_ACTIVATE_RETURN
                and (peak_ret - drift_path) >= TRAILING_GIVEBACK_RETURN
            ):
                action = "trailing_exit"
                reason = "跟踪止盈回撤"
                realized_pnl += base_notional * remaining_multiplier * drift_path
                remaining_multiplier = 0.0
                exit_reason = reason
                exit_minute = minute
                hard_exit = False

            if action != "hold":
                action_log.append(f"{minute}:{action}:{reason}:q={q_dynamic:.3f}")

            minute_rows.append(
                {
                    "trade_id": idx,
                    "source_split": row["source_split"],
                    "fold": row["fold"],
                    "date": row["date"].date().isoformat(),
                    "timestamp": time.isoformat(),
                    "minute": minute,
                    "symbol": row["front_symbol"],
                    "entry_price": entry_price,
                    "proxy_return": drift_path,
                    "proxy_price": entry_price * (1.0 + drift_path),
                    "q_dynamic": q_dynamic,
                    "position_multiplier": remaining_multiplier,
                    "action": action,
                    "reason": reason,
                    "score": row["score"],
                    "q_entry_rank": q_rank,
                    "event_rank": event_rank,
                    "vol_rank": vol_rank,
                }
            )

            if action in {"hard_exit", "trailing_exit"}:
                break

        if remaining_multiplier > 0.0:
            realized_pnl += base_notional * remaining_multiplier * last_ret

        proxy_fee_pnl = realized_pnl - base_notional * open_multiplier * float(row["fee_rate"])
        trade_rows.append(
            {
                "trade_id": idx,
                "source_split": row["source_split"],
                "fold": row["fold"],
                "date": row["date"].date().isoformat(),
                "symbol": row["front_symbol"],
                "score": float(row["score"]),
                "entry_position_multiplier": open_multiplier,
                "v1_22_notional_usd": base_notional,
                "v1_22_pnl_usd": float(row["pnl_usd"]),
                "v1_23_proxy_pnl_usd": float(proxy_fee_pnl),
                "pnl_delta_vs_v22_usd": float(proxy_fee_pnl - row["pnl_usd"]),
                "final_front_ret_next": final_ret,
                "proxy_exit_return": float(last_ret),
                "exit_minute": int(exit_minute),
                "exit_reason": exit_reason,
                "hard_exit": hard_exit,
                "soft_reduce_count": int(soft_reduce_count),
                "warning_count": int(warning_count),
                "q_final": float(last_q),
                "q_reduced_at_entry": q_reduced,
                "action_log": " | ".join(action_log[:12]),
            }
        )

    return pd.DataFrame(minute_rows), pd.DataFrame(trade_rows)


def split_metrics(trades: pd.DataFrame, pnl_col: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for split, g in trades.groupby("source_split"):
        m = metrics(g[pnl_col].astype(float).tolist())
        rows.append({"source_split": split, "pnl_col": pnl_col, **m})
    return rows


def action_summary(trades: pd.DataFrame) -> list[dict[str, Any]]:
    rows = []
    for reason, g in trades.groupby("exit_reason"):
        rows.append(
            {
                "exit_reason": reason,
                "count": int(len(g)),
                "proxy_net_pnl_usd": float(g["v1_23_proxy_pnl_usd"].sum()),
                "v22_net_pnl_usd": float(g["v1_22_pnl_usd"].sum()),
                "avg_exit_minute": float(g["exit_minute"].mean()),
                "win_rate": float((g["v1_23_proxy_pnl_usd"] > 0).mean()),
            }
        )
    return sorted(rows, key=lambda r: r["count"], reverse=True)


def create_plot(trades: pd.DataFrame, minute_sample: pd.DataFrame, out_path: Path) -> None:
    import matplotlib.pyplot as plt

    fig, axes = plt.subplots(2, 2, figsize=(14, 9))
    ordered = trades.sort_values(["date", "trade_id"]).reset_index(drop=True)
    axes[0, 0].plot(np.cumsum(ordered["v1_22_pnl_usd"]), label="V1.22 frozen")
    axes[0, 0].plot(np.cumsum(ordered["v1_23_proxy_pnl_usd"]), label="V1.23 minute proxy")
    axes[0, 0].set_title("Cumulative PnL: V1.22 vs V1.23 proxy")
    axes[0, 0].legend()
    axes[0, 0].grid(alpha=0.25)

    reason_alias = {
        "session_close": "session_close",
        "Q核严重漂移": "q_hard_exit",
        "跟踪止盈回撤": "trailing_exit",
    }
    reason_counts = trades["exit_reason"].map(lambda x: reason_alias.get(str(x), str(x))).value_counts()
    axes[0, 1].bar(reason_counts.index.astype(str), reason_counts.values)
    axes[0, 1].set_title("Exit reason counts")
    axes[0, 1].tick_params(axis="x", rotation=25)
    axes[0, 1].grid(axis="y", alpha=0.25)

    axes[1, 0].hist(trades["q_final"], bins=16)
    axes[1, 0].axvline(Q_WARNING, color="orange", linestyle="--", label="warning")
    axes[1, 0].axvline(Q_SOFT_REDUCE, color="red", linestyle="--", label="soft")
    axes[1, 0].set_title("Final dynamic Q distribution")
    axes[1, 0].legend()
    axes[1, 0].grid(alpha=0.25)

    if not minute_sample.empty:
        sample_trade_id = minute_sample["trade_id"].iloc[0]
        s = minute_sample[minute_sample["trade_id"] == sample_trade_id]
        axes[1, 1].plot(s["minute"], s["q_dynamic"], label="Q")
        axes[1, 1].axhline(Q_WARNING, color="orange", linestyle="--")
        axes[1, 1].axhline(Q_SOFT_REDUCE, color="red", linestyle="--")
        axes[1, 1].set_title(f"Sample minute Q path: trade {sample_trade_id}")
        axes[1, 1].legend()
        axes[1, 1].grid(alpha=0.25)

    fig.tight_layout()
    fig.savefig(out_path, dpi=180)
    plt.close(fig)


def write_report(summary: dict[str, Any], split_rows: list[dict[str, Any]], action_rows: list[dict[str, Any]]) -> None:
    promoted = summary["v1_23_proxy_metrics_all"]
    baseline = summary["v1_22_metrics_all"]
    md = [
        f"# {VERSION}",
        "",
        "## 定位",
        "",
        "V1.23 冻结 V1.22 主策略 `q_soft_reduce_floor_1p10`，新增分钟级 Q 动态退出框架。",
        "",
        f"- 数据模式：`{summary['data_mode']}`",
        f"- 状态：`{summary['status']}`",
        "- 说明：如果没有真实分钟/tick 数据，本版本只作为执行状态机与日志框架，不作为实盘收益证据。",
        "",
        "## 全样本对照",
        "",
        "| 项目 | V1.22 frozen | V1.23 minute proxy |",
        "|---|---:|---:|",
        f"| 交易数 | {baseline['trades']} | {promoted['trades']} |",
        f"| 胜率 | {baseline['win_rate']:.2%} | {promoted['win_rate']:.2%} |",
        f"| 净收益 | ${baseline['net_pnl_usd']:.2f} | ${promoted['net_pnl_usd']:.2f} |",
        f"| PF | {baseline['profit_factor']:.3f} | {promoted['profit_factor']:.3f} |",
        f"| 最大回撤 | ${baseline['max_drawdown_usd']:.2f} | ${promoted['max_drawdown_usd']:.2f} |",
        "",
        "## 分段结果",
        "",
        "| split | pnl_col | trades | win_rate | net_pnl | PF | max_dd |",
        "|---|---|---:|---:|---:|---:|---:|",
    ]
    for row in split_rows:
        md.append(
            f"| {row['source_split']} | {row['pnl_col']} | {row['trades']} | "
            f"{row['win_rate']:.2%} | ${row['net_pnl_usd']:.2f} | "
            f"{row['profit_factor']:.3f} | ${row['max_drawdown_usd']:.2f} |"
        )
    md.extend(
        [
            "",
            "## 退出原因",
            "",
            "| reason | count | proxy_pnl | v22_pnl | avg_exit_minute | win_rate |",
            "|---|---:|---:|---:|---:|---:|",
        ]
    )
    for row in action_rows:
        md.append(
            f"| {row['exit_reason']} | {row['count']} | ${row['proxy_net_pnl_usd']:.2f} | "
            f"${row['v22_net_pnl_usd']:.2f} | {row['avg_exit_minute']:.1f} | {row['win_rate']:.2%} |"
        )
    md.extend(
        [
            "",
            "## 结论",
            "",
            "- `q_soft_reduce_floor_1p10` 继续作为黄金主线。",
            "- V1.23 已提供分钟级 Q 动态退出的可执行框架、日志和 feed schema。",
            "- 当前未发现真实分钟级黄金 feed，因此结果为 proxy replay；不能替代真实 L2/tick 回放。",
            "- 下一步 V1.24/V1.23b 应接入真实 GC/GLD 分钟数据或 Databento 更长 BBO/MBP 样本，再重跑本脚本。",
        ]
    )
    (OUT_DIR / "HFCD_Trading_V1_23_GoldMinuteQDynamicExit.md").write_text("\n".join(md) + "\n", encoding="utf-8")


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    summary_v22 = load_v22_summary()
    trades = load_selected_v22_trades()
    real_minute = detect_real_minute_feed()
    data_mode = "real_minute_feed" if real_minute else "proxy_minute_replay_no_real_minute_feed"
    config = ReplayConfig(source_mode=data_mode)

    write_minute_schema(OUT_DIR / "hfcd_trading_v1_23_minute_feed_schema.csv")

    minute_paths, proxy_trades = build_proxy_minute_path(trades)
    split_rows = split_metrics(proxy_trades, "v1_22_pnl_usd") + split_metrics(proxy_trades, "v1_23_proxy_pnl_usd")
    action_rows = action_summary(proxy_trades)

    base_metrics = metrics(proxy_trades["v1_22_pnl_usd"].astype(float).tolist())
    proxy_metrics = metrics(proxy_trades["v1_23_proxy_pnl_usd"].astype(float).tolist())
    status = "minute_q_framework_ready_proxy_only"
    if real_minute:
        status = "minute_q_framework_ready_real_feed_detected_not_yet_promoted"

    summary = {
        "version": VERSION,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "status": status,
        "data_mode": data_mode,
        "real_minute_feed_path": str(real_minute) if real_minute else None,
        "frozen_strategy": {
            "source": "V1.22",
            "variant": FROZEN_VARIANT,
            "friction": FROZEN_FRICTION,
            "threshold": THRESHOLD,
            "v22_status": summary_v22.get("status"),
        },
        "config": config.__dict__,
        "bbo_friction_stats": bbo_friction_stats(),
        "v1_22_metrics_all": base_metrics,
        "v1_23_proxy_metrics_all": proxy_metrics,
        "action_summary": action_rows,
        "notes": [
            "Default run uses deterministic proxy minute paths because no real minute/tick feed was found.",
            "Proxy PnL is only an execution-state-machine smoke test and must not be promoted as live evidence.",
            "Use hfcd_trading_v1_23_minute_feed_schema.csv to supply real minute data for the next validation.",
        ],
    }

    write_csv(OUT_DIR / "hfcd_trading_v1_23_split_metrics.csv", split_rows)
    write_csv(OUT_DIR / "hfcd_trading_v1_23_exit_reason_summary.csv", action_rows)
    proxy_trades.to_csv(OUT_DIR / "hfcd_trading_v1_23_trade_replay.csv", index=False)
    minute_paths.to_csv(OUT_DIR / "hfcd_trading_v1_23_minute_proxy_paths.csv", index=False)
    minute_paths.head(1200).to_csv(OUT_DIR / "hfcd_trading_v1_23_minute_proxy_sample.csv", index=False)

    plot_path = OUT_DIR / "HFCD_Trading_V1_23_GoldMinuteQDynamicExit.png"
    create_plot(proxy_trades, minute_paths.head(1200), plot_path)
    summary["plot"] = str(plot_path)

    (OUT_DIR / "hfcd_trading_v1_23_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    write_report(summary, split_rows, action_rows)

    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
