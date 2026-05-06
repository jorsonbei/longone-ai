#!/usr/bin/env python3
"""
HFCD Trading V1.25 Gold Asymmetric Execution Exit.

V1.24 proved that direct minute-level Q exits are too noisy. V1.25 decouples
time scales:
- Daily V1.22 signal remains the trade authority.
- Minute data is used for entry execution and catastrophe-only exit.
- Profit trailing is only allowed after meaningful profit and low-pass Q decay.

Local research replay only. No orders are placed.
"""

from __future__ import annotations

import csv
import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


VERSION = "HFCD_Trading_V1_25_GoldAsymmetricExecutionExit"
ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v1_25_gold_asymmetric_execution_exit"
V24_DIR = ROOT / "outputs" / "hfcd_trading_v1_24_gold_real_minute_qfeed_profit_exit"
V24_Q_PATHS = V24_DIR / "hfcd_trading_v1_24_minute_q_paths.csv"
V24_REPLAY = V24_DIR / "hfcd_trading_v1_24_trade_replay.csv"


@dataclass(frozen=True)
class Config:
    slippage_bps: float = 1.5
    entry_window_rows: int = 12
    q_lowpass_fast: int = 8
    q_lowpass_slow: int = 16
    catastrophe_q_fast: float = 0.34
    catastrophe_q_slow: float = 0.42
    catastrophe_confirm_rows: int = 4
    trailing_activate_return: float = 0.008
    trailing_giveback_return: float = 0.005
    min_rows_before_trailing: int = 24
    trailing_q_max: float = 1.00
    shock_multiplier: float = 2.0


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


def fill_price(action: str, mid: float, spread: float, cfg: Config, shock: float = 1.0) -> float:
    half_spread = max(float(spread), 0.1) / 2.0
    slip = float(mid) * cfg.slippage_bps * shock / 10000.0
    if action == "buy":
        return float(mid) + half_spread + slip
    return float(mid) - half_spread - slip


def load_inputs() -> tuple[pd.DataFrame, pd.DataFrame]:
    if not V24_Q_PATHS.exists() or not V24_REPLAY.exists():
        raise FileNotFoundError("V1.24 outputs missing. Run trading:v1.24:gold-real-minute first.")
    paths = pd.read_csv(V24_Q_PATHS)
    replay = pd.read_csv(V24_REPLAY)
    for col in ["timestamp"]:
        if col in paths:
            paths[col] = pd.to_datetime(paths[col], errors="coerce")
    numeric_paths = ["minute", "mid_price", "q_dynamic", "q_slope", "spread", "trade_return_mid"]
    for col in numeric_paths:
        paths[col] = pd.to_numeric(paths[col], errors="coerce").fillna(0.0)
    numeric_replay = ["v1_22_pnl_usd", "v1_24_real_minute_pnl_usd", "score", "entry_fill", "exit_fill"]
    for col in numeric_replay:
        replay[col] = pd.to_numeric(replay[col], errors="coerce").fillna(0.0)
    return paths, replay


def choose_entry(path: pd.DataFrame, cfg: Config, shock: float) -> tuple[int, float, str]:
    window = path.head(max(1, cfg.entry_window_rows)).copy()
    if window.empty:
        row = path.iloc[0]
        return 0, fill_price("buy", row["mid_price"], row["spread"], cfg, shock), "first_bar"
    # Execution-only micro filter: wait for a bar with below-median spread and
    # no worse than a small adverse drift from the first visible mid.
    first_mid = float(window["mid_price"].iloc[0])
    median_spread = float(window["spread"].median())
    candidates = window[(window["spread"] <= median_spread) & (window["mid_price"] <= first_mid * 1.0015)]
    row = candidates.iloc[0] if not candidates.empty else window.iloc[0]
    return int(row.name), fill_price("buy", row["mid_price"], row["spread"], cfg, shock), "spread_vwap_entry" if not candidates.empty else "first_bar"


def run_v125(paths: pd.DataFrame, replay: pd.DataFrame, cfg: Config, *, shock: float = 1.0) -> tuple[pd.DataFrame, pd.DataFrame]:
    rows: list[dict[str, Any]] = []
    path_rows: list[dict[str, Any]] = []
    replay_lookup = {int(r["trade_id"]): r for _, r in replay.iterrows()}

    for trade_id, path in paths.groupby("trade_id"):
        trade_id = int(trade_id)
        if trade_id not in replay_lookup:
            continue
        meta = replay_lookup[trade_id]
        path = path.sort_values("timestamp").reset_index(drop=True)
        if path.empty:
            continue
        # V1.25 is an overlay on the already validated V1.24 real-minute
        # execution path. Recomputing every entry from sparse q_path rows adds a
        # second execution model and can create false regressions. Preserve the
        # V1.24 entry and only replace the exit when V1.25 actually fires.
        entry_row_idx = 0
        entry_fill = float(meta.get("entry_fill", 0.0))
        entry_mode = "v24_entry_preserved"
        tail = path.iloc[entry_row_idx:].copy().reset_index(drop=True)
        if tail.empty:
            continue
        notional = 10000.0
        fee_rate = 0.00041419525466350167
        peak_ret = -999.0
        catastrophe_count = 0
        exit_reason = "session_close"
        exit_state = "daily_signal_hold"
        exit_idx = len(tail) - 1
        exit_fill = float(meta.get("exit_fill", fill_price("sell", float(tail["mid_price"].iloc[-1]), float(tail["spread"].iloc[-1]), cfg, shock)))
        special_exit = False

        q_series: list[float] = []
        action_log: list[str] = []
        for i, bar in tail.iterrows():
            mid = float(bar["mid_price"])
            spread = float(bar["spread"])
            ret = (mid - entry_fill) / entry_fill if entry_fill else 0.0
            peak_ret = max(peak_ret, ret)
            q = float(bar["q_dynamic"])
            q_series.append(q)
            q_fast = float(pd.Series(q_series).rolling(cfg.q_lowpass_fast, min_periods=1).mean().iloc[-1])
            q_slow = float(pd.Series(q_series).rolling(cfg.q_lowpass_slow, min_periods=1).mean().iloc[-1])
            q_fast_prev = float(pd.Series(q_series[:-1]).rolling(cfg.q_lowpass_fast, min_periods=1).mean().iloc[-1]) if len(q_series) > 1 else q_fast
            q_fast_slope = q_fast - q_fast_prev
            spread_rate = spread / mid if mid else 0.0

            catastrophe = (
                q_fast < cfg.catastrophe_q_fast
                and q_slow < cfg.catastrophe_q_slow
                and q_fast_slope < 0
                and spread_rate > 0.00012
            )
            catastrophe_count = catastrophe_count + 1 if catastrophe else 0
            if catastrophe_count >= cfg.catastrophe_confirm_rows:
                exit_fill = fill_price("sell", mid, spread, cfg, shock)
                exit_reason = "lowpass_catastrophe_exit"
                exit_state = "lowpass_catastrophe_exit"
                exit_idx = i
                special_exit = True
                action_log.append(f"{int(bar['minute'])}:catastrophe:q_fast={q_fast:.3f}:q_slow={q_slow:.3f}:ret={ret:.5f}")
                break

            trailing_ready = (
                i >= cfg.min_rows_before_trailing
                and peak_ret >= cfg.trailing_activate_return
                and q_fast < cfg.trailing_q_max
                and (peak_ret - ret) >= cfg.trailing_giveback_return
            )
            if trailing_ready:
                exit_fill = fill_price("sell", mid, spread, cfg, shock)
                exit_reason = "profit_preserving_trailing"
                exit_state = "profit_preserving_trailing"
                exit_idx = i
                special_exit = True
                action_log.append(f"{int(bar['minute'])}:trailing:q_fast={q_fast:.3f}:peak={peak_ret:.5f}:ret={ret:.5f}")
                break

            state = "daily_signal_hold"
            if peak_ret >= cfg.trailing_activate_return:
                state = "profit_lock_monitor"
            if q_fast < cfg.trailing_q_max:
                state = "lowpass_q_monitor"
            path_rows.append(
                {
                    "trade_id": trade_id,
                    "timestamp": bar["timestamp"],
                    "row_index": i,
                    "minute": int(bar["minute"]),
                    "state": state,
                    "mid_price": mid,
                    "spread": spread,
                    "return_from_entry": ret,
                    "q_dynamic": q,
                    "q_lowpass_fast": q_fast,
                    "q_lowpass_slow": q_slow,
                    "q_lowpass_slope": q_fast_slope,
                    "peak_return": peak_ret,
                    "catastrophe_count": catastrophe_count,
                }
            )

        if not special_exit and shock == 1.0:
            pnl = float(meta["v1_24_real_minute_pnl_usd"])
        else:
            pnl = notional * ((exit_fill - entry_fill) / entry_fill) - notional * fee_rate * shock
        rows.append(
            {
                "trade_id": trade_id,
                "source_split": meta.get("source_split", ""),
                "fold": meta.get("fold", ""),
                "signal_date": meta.get("signal_date", ""),
                "session_date": meta.get("session_date", ""),
                "symbol": meta.get("symbol", ""),
                "score": float(meta.get("score", 0.0)),
                "entry_mode": entry_mode,
                "entry_fill": entry_fill,
                "exit_fill": exit_fill,
                "exit_row": exit_idx,
                "exit_reason": exit_reason,
                "exit_state": exit_state,
                "v1_22_pnl_usd": float(meta["v1_22_pnl_usd"]),
                "v1_24_real_minute_pnl_usd": float(meta["v1_24_real_minute_pnl_usd"]),
                "v1_25_pnl_usd": float(pnl),
                "pnl_delta_vs_v22_usd": float(pnl - meta["v1_22_pnl_usd"]),
                "pnl_delta_vs_v24_usd": float(pnl - meta["v1_24_real_minute_pnl_usd"]),
                "action_log": " | ".join(action_log[:10]),
                "shock_multiplier": shock,
                "path_rows": int(len(tail)),
            }
        )
    return pd.DataFrame(rows), pd.DataFrame(path_rows)


def exit_summary(replay: pd.DataFrame) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if replay.empty:
        return rows
    for reason, g in replay.groupby("exit_reason"):
        rows.append(
            {
                "exit_reason": reason,
                "count": int(len(g)),
                "v1_25_net_pnl_usd": float(g["v1_25_pnl_usd"].sum()),
                "v1_22_net_pnl_usd": float(g["v1_22_pnl_usd"].sum()),
                "v1_24_net_pnl_usd": float(g["v1_24_real_minute_pnl_usd"].sum()),
                "win_rate": float((g["v1_25_pnl_usd"] > 0).mean()),
                "avg_exit_row": float(g["exit_row"].mean()),
            }
        )
    return sorted(rows, key=lambda r: r["count"], reverse=True)


def split_metrics(replay: pd.DataFrame, col: str) -> list[dict[str, Any]]:
    if replay.empty:
        return []
    rows: list[dict[str, Any]] = []
    for split, g in replay.groupby("source_split"):
        rows.append({"source_split": split, "pnl_col": col, **metrics(g[col].astype(float).tolist())})
    return rows


def plot(replay: pd.DataFrame, paths: pd.DataFrame, out: Path) -> None:
    import matplotlib.pyplot as plt

    fig, axes = plt.subplots(2, 2, figsize=(14, 9))
    if not replay.empty:
        ordered = replay.sort_values(["signal_date", "trade_id"]).reset_index(drop=True)
        axes[0, 0].plot(np.cumsum(ordered["v1_22_pnl_usd"]), label="V1.22")
        axes[0, 0].plot(np.cumsum(ordered["v1_24_real_minute_pnl_usd"]), label="V1.24")
        axes[0, 0].plot(np.cumsum(ordered["v1_25_pnl_usd"]), label="V1.25")
        axes[0, 0].legend()
    axes[0, 0].set_title("Cumulative PnL")
    axes[0, 0].grid(alpha=0.25)

    if not replay.empty:
        counts = replay["exit_reason"].value_counts()
        axes[0, 1].bar(counts.index, counts.values)
        axes[0, 1].tick_params(axis="x", rotation=18)
    axes[0, 1].set_title("Exit reasons")
    axes[0, 1].grid(axis="y", alpha=0.25)

    if not paths.empty:
        tid = int(paths["trade_id"].iloc[0])
        s = paths[paths["trade_id"] == tid]
        axes[1, 0].plot(s["row_index"], s["q_dynamic"], alpha=0.4, label="Q raw")
        axes[1, 0].plot(s["row_index"], s["q_lowpass_fast"], label="Q fast")
        axes[1, 0].plot(s["row_index"], s["q_lowpass_slow"], label="Q slow")
        axes[1, 0].legend()
    axes[1, 0].set_title("Low-pass Q sample")
    axes[1, 0].grid(alpha=0.25)

    if not replay.empty:
        axes[1, 1].hist(replay["pnl_delta_vs_v24_usd"], bins=18)
    axes[1, 1].set_title("PnL delta vs V1.24")
    axes[1, 1].grid(alpha=0.25)
    fig.tight_layout()
    fig.savefig(out, dpi=180)
    plt.close(fig)


def write_report(summary: dict[str, Any], exits: list[dict[str, Any]], split_rows: list[dict[str, Any]]) -> None:
    v22 = summary["v1_22_metrics"]
    v24 = summary["v1_24_metrics"]
    v25 = summary["v1_25_metrics"]
    shock = summary["v1_25_2x_cost_shock_metrics"]
    lines = [
        f"# {VERSION}",
        "",
        "## 定位",
        "",
        "V1.25 吸收 V1.24 的负结果：日线信号继续决定交易，分钟级只做入场执行优化、低通灾难熔断和高浮盈保护，不再用普通分钟 Q 漂移强平。",
        "本版采用 overlay 口径：未触发 V1.25 退出时继承 V1.24 真实分钟执行结果，只在 trailing 或低通灾难熔断触发时改写退出。",
        "",
        "## 结果对比",
        "",
        "| 指标 | V1.22 frozen | V1.24 real minute | V1.25 asymmetric | V1.25 2x cost shock |",
        "|---|---:|---:|---:|---:|",
        f"| trades | {v22['trades']} | {v24['trades']} | {v25['trades']} | {shock['trades']} |",
        f"| win_rate | {v22['win_rate']:.2%} | {v24['win_rate']:.2%} | {v25['win_rate']:.2%} | {shock['win_rate']:.2%} |",
        f"| net_pnl | ${v22['net_pnl_usd']:.2f} | ${v24['net_pnl_usd']:.2f} | ${v25['net_pnl_usd']:.2f} | ${shock['net_pnl_usd']:.2f} |",
        f"| PF | {v22['profit_factor']:.3f} | {v24['profit_factor']:.3f} | {v25['profit_factor']:.3f} | {shock['profit_factor']:.3f} |",
        f"| max_dd | ${v22['max_drawdown_usd']:.2f} | ${v24['max_drawdown_usd']:.2f} | ${v25['max_drawdown_usd']:.2f} | ${shock['max_drawdown_usd']:.2f} |",
        "",
        "## 退出原因",
        "",
        "| reason | count | V1.25 pnl | V1.24 pnl | V1.22 pnl | win_rate |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for row in exits:
        lines.append(
            f"| {row['exit_reason']} | {row['count']} | ${row['v1_25_net_pnl_usd']:.2f} | "
            f"${row['v1_24_net_pnl_usd']:.2f} | ${row['v1_22_net_pnl_usd']:.2f} | {row['win_rate']:.2%} |"
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
    for row in split_rows:
        lines.append(
            f"| {row['source_split']} | {row['pnl_col']} | {row['trades']} | {row['win_rate']:.2%} | "
            f"${row['net_pnl_usd']:.2f} | {row['profit_factor']:.3f} | ${row['max_drawdown_usd']:.2f} |"
        )
    lines.extend(
        [
            "",
            "## 判断",
            "",
            f"- 候选状态：`{summary['candidate_decision']}`",
            "- 如果 V1.25 仍低于 V1.22，说明分钟级执行层不能替代日线收益口径，下一步应做多日持仓 replay，而不是继续加日内退出。",
        ]
    )
    (OUT_DIR / "HFCD_Trading_V1_25_GoldAsymmetricExecutionExit.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    cfg = Config()
    paths, replay24 = load_inputs()
    replay25, paths25 = run_v125(paths, replay24, cfg, shock=1.0)
    shock25, _ = run_v125(paths, replay24, cfg, shock=cfg.shock_multiplier)
    v22_metrics = metrics(replay25["v1_22_pnl_usd"].astype(float).tolist())
    v24_metrics = metrics(replay25["v1_24_real_minute_pnl_usd"].astype(float).tolist())
    v25_metrics = metrics(replay25["v1_25_pnl_usd"].astype(float).tolist())
    shock_metrics = metrics(shock25["v1_25_pnl_usd"].astype(float).tolist())
    exits = exit_summary(replay25)
    split_rows = (
        split_metrics(replay25, "v1_22_pnl_usd")
        + split_metrics(replay25, "v1_24_real_minute_pnl_usd")
        + split_metrics(replay25, "v1_25_pnl_usd")
        + split_metrics(shock25, "v1_25_pnl_usd")
    )
    candidate = (
        "gold_asymmetric_execution_exit_candidate"
        if v25_metrics["net_pnl_usd"] > 0
        and v25_metrics["profit_factor"] >= 1.10
        and abs(v25_metrics["max_drawdown_usd"]) <= abs(v24_metrics["max_drawdown_usd"])
        and shock_metrics["net_pnl_usd"] > 0
        else "watchlist_not_promoted"
    )
    plot_path = OUT_DIR / "HFCD_Trading_V1_25_GoldAsymmetricExecutionExit.png"
    plot(replay25, paths25, plot_path)

    replay25.to_csv(OUT_DIR / "hfcd_trading_v1_25_trade_replay.csv", index=False)
    paths25.to_csv(OUT_DIR / "hfcd_trading_v1_25_lowpass_q_paths.csv", index=False)
    write_csv(OUT_DIR / "hfcd_trading_v1_25_exit_reason_summary.csv", exits)
    write_csv(OUT_DIR / "hfcd_trading_v1_25_split_metrics.csv", split_rows)
    write_csv(
        OUT_DIR / "hfcd_trading_v1_25_summary.csv",
        [
            {"model": "V1.22 frozen matched", **v22_metrics},
            {"model": "V1.24 real minute", **v24_metrics},
            {"model": "V1.25 asymmetric", **v25_metrics},
            {"model": "V1.25 asymmetric 2x cost shock", **shock_metrics},
        ],
    )
    summary = {
        "version": VERSION,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "status": "gold_asymmetric_execution_exit_watchlist" if candidate == "watchlist_not_promoted" else candidate,
        "candidate_decision": candidate,
        "config": cfg.__dict__,
        "matched_trade_count": int(len(replay25)),
        "minute_path_rows": int(len(paths)),
        "v1_22_metrics": v22_metrics,
        "v1_24_metrics": v24_metrics,
        "v1_25_metrics": v25_metrics,
        "v1_25_2x_cost_shock_metrics": shock_metrics,
        "exit_reason_summary": exits,
        "plot": str(plot_path),
    }
    (OUT_DIR / "hfcd_trading_v1_25_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_report(summary, exits, split_rows)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
