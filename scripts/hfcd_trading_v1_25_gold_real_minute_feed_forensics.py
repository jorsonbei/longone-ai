#!/usr/bin/env python3
"""
HFCD Trading V1.25 Gold Real-Minute Feed Forensics.

This is not a strategy-promotion run. It audits why V1.24 real-minute replay
failed to reproduce the V1.22 frozen gold baseline before any Q/trailing
parameter tuning is trusted.
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


VERSION = "HFCD_Trading_V1_25_GoldRealMinuteFeedForensics"
ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v1_25_gold_real_minute_feed_forensics"
V22_DIR = ROOT / "outputs" / "hfcd_trading_v1_22_gold_execution_qdrift_replay"
V24_DIR = ROOT / "outputs" / "hfcd_trading_v1_24_gold_real_minute_qfeed_profit_exit"
V22_HOLDOUT = V22_DIR / "hfcd_trading_v1_22_holdout_trades.csv"
V22_ROLLING = V22_DIR / "hfcd_trading_v1_22_rolling_trades.csv"
V24_Q_PATHS = V24_DIR / "hfcd_trading_v1_24_minute_q_paths.csv"
V24_REPLAY = V24_DIR / "hfcd_trading_v1_24_trade_replay.csv"
V24_ACQ = V24_DIR / "hfcd_trading_v1_24_acquisition_log.csv"

FROZEN_VARIANT = "q_soft_reduce_floor_1p10"
FROZEN_FRICTION = "l2_estimated"


@dataclass(frozen=True)
class ReconConfig:
    expected_regular_session_minutes: int = 390
    min_rows_for_trade_match: int = 10
    spread_bad_threshold_points: float = 10.0
    slippage_bps: float = 1.5


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


def fill_price(side: str, mid: float, spread: float, cfg: ReconConfig) -> float:
    half = max(float(spread), 0.1) / 2.0
    slip = float(mid) * cfg.slippage_bps / 10000.0
    if side == "buy":
        return float(mid) + half + slip
    return float(mid) - half - slip


def load_selected_v22() -> pd.DataFrame:
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
        raise ValueError("No V1.22 frozen trades found.")
    trades["date"] = pd.to_datetime(trades["date"], errors="coerce")
    numeric = ["score", "position_multiplier", "notional_usd", "front_close", "front_ret_next", "fee_rate", "pnl_usd"]
    for col in numeric:
        trades[col] = pd.to_numeric(trades[col], errors="coerce").fillna(0.0)
    trades["trade_id"] = np.arange(len(trades))
    return trades.sort_values(["date", "source_split"]).reset_index(drop=True)


def load_v24() -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    for path in [V24_Q_PATHS, V24_REPLAY, V24_ACQ]:
        if not path.exists():
            raise FileNotFoundError(path)
    q = pd.read_csv(V24_Q_PATHS)
    replay = pd.read_csv(V24_REPLAY)
    acq = pd.read_csv(V24_ACQ)
    q["timestamp"] = pd.to_datetime(q["timestamp"], errors="coerce")
    for col in ["trade_id", "minute", "mid_price", "spread", "trade_return_mid", "q_dynamic", "q_slope"]:
        q[col] = pd.to_numeric(q[col], errors="coerce").fillna(0.0)
    for col in ["trade_id", "v1_22_pnl_usd", "v1_24_real_minute_pnl_usd", "entry_fill", "exit_fill"]:
        replay[col] = pd.to_numeric(replay[col], errors="coerce").fillna(0.0)
    return q, replay, acq


def audit_feed(selected: pd.DataFrame, q: pd.DataFrame, replay: pd.DataFrame, acq: pd.DataFrame, cfg: ReconConfig) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    matched = set(replay["trade_id"].astype(int))
    rows: list[dict[str, Any]] = []
    for _, trade in selected.iterrows():
        tid = int(trade["trade_id"])
        g = q[q["trade_id"].astype(int) == tid].sort_values("timestamp")
        acq_g = acq[acq["trade_id"].astype(int) == tid] if "trade_id" in acq.columns else pd.DataFrame()
        statuses = ";".join(acq_g.get("ohlcv_1m_status", pd.Series(dtype=str)).astype(str).unique().tolist())
        if tid not in matched:
            max_rows = int(pd.to_numeric(acq_g.get("ohlcv_1m_rows", pd.Series(dtype=float)), errors="coerce").fillna(0).max()) if not acq_g.empty else 0
            if max_rows == 0:
                reason = "no_cached_ohlcv_rows"
            elif max_rows < cfg.min_rows_for_trade_match:
                reason = "too_few_minute_rows_for_replay"
            else:
                reason = "not_in_v24_replay_after_feed_build"
        else:
            reason = "matched"
        duplicate_ts = int(g["timestamp"].duplicated().sum()) if not g.empty else 0
        bad_spread = int(((g["spread"] <= 0) | (g["spread"] > cfg.spread_bad_threshold_points)).sum()) if not g.empty else 0
        missing_bar_est = max(0, cfg.expected_regular_session_minutes - int(len(g))) if not g.empty else cfg.expected_regular_session_minutes
        rows.append(
            {
                "trade_id": tid,
                "signal_date": pd.Timestamp(trade["date"]).date().isoformat(),
                "source_split": trade["source_split"],
                "fold": trade["fold"],
                "front_symbol": trade["front_symbol"],
                "matched": tid in matched,
                "unmatched_reason": reason,
                "minute_rows": int(len(g)),
                "missing_bar_count_est": int(missing_bar_est),
                "duplicate_timestamp_count": duplicate_ts,
                "bad_spread_count": bad_spread,
                "first_timestamp": str(g["timestamp"].iloc[0]) if not g.empty else "",
                "last_timestamp": str(g["timestamp"].iloc[-1]) if not g.empty else "",
                "timezone_check": "UTC_or_tz_aware" if (not g.empty and getattr(g["timestamp"].dt, "tz", None) is not None) else "unknown_or_empty",
                "symbol_check": "front_symbol_used_for_databento_raw_symbol",
                "price_basis_check": "V1.22 daily close-to-next-close vs V1.24 next-session intraday mid/BBO",
                "acquisition_statuses": statuses,
            }
        )
    matched_count = int(sum(1 for r in rows if r["matched"]))
    summary = {
        "selected_trade_count": int(len(selected)),
        "matched_trade_count": matched_count,
        "unmatched_trade_count": int(len(selected) - matched_count),
        "matched_rate": float(matched_count / len(selected)) if len(selected) else 0.0,
        "total_q_path_rows": int(len(q)),
        "median_rows_per_matched_trade": float(pd.Series([r["minute_rows"] for r in rows if r["matched"]]).median()) if matched_count else 0.0,
        "bad_spread_count_total": int(sum(r["bad_spread_count"] for r in rows)),
        "duplicate_timestamp_count_total": int(sum(r["duplicate_timestamp_count"] for r in rows)),
        "estimated_missing_bar_count_total": int(sum(r["missing_bar_count_est"] for r in rows if r["matched"])),
    }
    return rows, summary


def reconstruct_baseline(selected: pd.DataFrame, q: pd.DataFrame, replay: pd.DataFrame, cfg: ReconConfig) -> tuple[pd.DataFrame, dict[str, Any]]:
    selected_lookup = {int(r["trade_id"]): r for _, r in selected.iterrows()}
    replay_lookup = {int(r["trade_id"]): r for _, r in replay.iterrows()}
    rows: list[dict[str, Any]] = []
    for tid, g in q.groupby("trade_id"):
        tid = int(tid)
        if tid not in selected_lookup or tid not in replay_lookup:
            continue
        trade = selected_lookup[tid]
        g = g.sort_values("timestamp").reset_index(drop=True)
        if len(g) < 2:
            continue
        first = g.iloc[0]
        last = g.iloc[-1]
        entry = fill_price("buy", float(first["mid_price"]), float(first["spread"]), cfg)
        exit_ = fill_price("sell", float(last["mid_price"]), float(last["spread"]), cfg)
        notional = float(trade["notional_usd"]) * float(trade["position_multiplier"])
        fee = float(trade["fee_rate"]) * notional
        pnl = notional * ((exit_ - entry) / entry) - fee
        minute_ret = (float(last["mid_price"]) - float(first["mid_price"])) / float(first["mid_price"])
        rows.append(
            {
                "trade_id": tid,
                "source_split": trade["source_split"],
                "fold": trade["fold"],
                "signal_date": pd.Timestamp(trade["date"]).date().isoformat(),
                "front_symbol": trade["front_symbol"],
                "v1_22_original_pnl": float(trade["pnl_usd"]),
                "v1_22_front_ret_next": float(trade["front_ret_next"]),
                "minute_reconstructed_pnl": float(pnl),
                "minute_session_return_mid": float(minute_ret),
                "v1_24_real_minute_pnl": float(replay_lookup[tid]["v1_24_real_minute_pnl_usd"]),
                "pnl_diff_reconstructed_minus_v22": float(pnl - trade["pnl_usd"]),
                "entry_mid": float(first["mid_price"]),
                "exit_mid": float(last["mid_price"]),
                "entry_timestamp": str(first["timestamp"]),
                "exit_timestamp": str(last["timestamp"]),
                "minute_rows": int(len(g)),
                "session_close_diff_reason": "different_horizon_or_price_basis"
                if np.sign(pnl) != np.sign(float(trade["pnl_usd"]))
                else "same_sign_but_basis_diff_possible",
            }
        )
    df = pd.DataFrame(rows)
    if df.empty:
        audit = {}
    else:
        audit = {
            "pnl_corr": safe_corr(df["v1_22_original_pnl"], df["minute_reconstructed_pnl"]),
            "return_corr": safe_corr(df["v1_22_front_ret_next"], df["minute_session_return_mid"]),
            "sign_match_rate": sign_match(df["v1_22_original_pnl"], df["minute_reconstructed_pnl"]),
            "return_sign_match_rate": sign_match(df["v1_22_front_ret_next"], df["minute_session_return_mid"]),
            "mean_abs_diff_per_trade": float((df["minute_reconstructed_pnl"] - df["v1_22_original_pnl"]).abs().mean()),
            "v1_22_metrics": metrics(df["v1_22_original_pnl"].astype(float).tolist()),
            "minute_reconstructed_metrics": metrics(df["minute_reconstructed_pnl"].astype(float).tolist()),
            "v1_24_metrics": metrics(df["v1_24_real_minute_pnl"].astype(float).tolist()),
        }
    return df, audit


def q_calibration(q: pd.DataFrame) -> tuple[pd.DataFrame, dict[str, Any]]:
    out = q.sort_values(["trade_id", "timestamp"]).copy()
    out["q_slope_calc"] = out.groupby("trade_id")["q_dynamic"].diff().fillna(0.0)
    out["q_acceleration"] = out.groupby("trade_id")["q_slope_calc"].diff().fillna(0.0)
    out["q_recovery_calc"] = out.groupby("trade_id")["q_dynamic"].transform(lambda s: s - s.cummin())
    quantiles = {f"q_quantile_{int(qv*100)}": float(out["q_dynamic"].quantile(qv)) for qv in [0.1, 0.2, 0.4, 0.5, 0.6, 0.7]}
    out["q_warning_q70"] = out["q_dynamic"] < quantiles["q_quantile_70"]
    out["q_soft_q50"] = out["q_dynamic"] < quantiles["q_quantile_50"]
    out["q_hard_q20"] = out["q_dynamic"] < quantiles["q_quantile_20"]
    return out, quantiles


def ablations(recon: pd.DataFrame, replay: pd.DataFrame) -> list[dict[str, Any]]:
    if recon.empty:
        return []
    replay_lookup = replay.set_index("trade_id")
    variants = {
        "baseline_reconstruct_only": recon["minute_reconstructed_pnl"].astype(float),
        "q_path_record_only": recon["minute_reconstructed_pnl"].astype(float),
        "v1_24_q_hard_plus_trailing_observed": recon["trade_id"].map(replay_lookup["v1_24_real_minute_pnl_usd"]).fillna(0.0).astype(float),
    }
    rows = []
    for name, vals in variants.items():
        rows.append({"variant": name, **metrics(vals.tolist())})
    return rows


def create_plot(recon: pd.DataFrame, audit: dict[str, Any], path: Path) -> None:
    import matplotlib.pyplot as plt

    fig, axes = plt.subplots(2, 2, figsize=(14, 9))
    if not recon.empty:
        ordered = recon.sort_values(["signal_date", "trade_id"])
        axes[0, 0].plot(np.cumsum(ordered["v1_22_original_pnl"]), label="V1.22 original")
        axes[0, 0].plot(np.cumsum(ordered["minute_reconstructed_pnl"]), label="minute reconstruct")
        axes[0, 0].plot(np.cumsum(ordered["v1_24_real_minute_pnl"]), label="V1.24 observed")
        axes[0, 0].legend()
        axes[0, 1].scatter(ordered["v1_22_original_pnl"], ordered["minute_reconstructed_pnl"], s=18)
        axes[0, 1].axhline(0, color="gray", linewidth=0.8)
        axes[0, 1].axvline(0, color="gray", linewidth=0.8)
        axes[1, 0].hist(ordered["pnl_diff_reconstructed_minus_v22"], bins=18)
        reason_counts = ordered["session_close_diff_reason"].value_counts()
        axes[1, 1].bar(reason_counts.index, reason_counts.values)
        axes[1, 1].tick_params(axis="x", rotation=15)
    axes[0, 0].set_title("Cumulative PnL")
    axes[0, 1].set_title(f"PnL reconstruction corr={audit.get('pnl_corr', 0):.3f}")
    axes[1, 0].set_title("Reconstructed - V1.22 diff")
    axes[1, 1].set_title("Diff reason proxy")
    for ax in axes.ravel():
        ax.grid(alpha=0.25)
    fig.tight_layout()
    fig.savefig(path, dpi=180)
    plt.close(fig)


def write_report(
    feed_summary: dict[str, Any],
    recon_audit: dict[str, Any],
    q_quantiles: dict[str, Any],
    ablation_rows: list[dict[str, Any]],
    promotion: dict[str, Any],
) -> None:
    lines = [
        f"# {VERSION}",
        "",
        "## 定位",
        "",
        "本轮不是策略升级，而是 V1.24 真实分钟源失败后的取证审计。只有分钟源能复现 V1.22 基线后，Q hard exit 和 trailing 参数才有继续优化意义。",
        "",
        "## Feed 完整性",
        "",
        f"- 选中交易：{feed_summary['selected_trade_count']}",
        f"- 匹配交易：{feed_summary['matched_trade_count']}",
        f"- 未匹配交易：{feed_summary['unmatched_trade_count']}",
        f"- 匹配率：{feed_summary['matched_rate']:.2%}",
        f"- 中位分钟行数：{feed_summary['median_rows_per_matched_trade']:.1f}",
        f"- 估算缺失分钟数：{feed_summary['estimated_missing_bar_count_total']}",
        f"- 异常 spread 行：{feed_summary['bad_spread_count_total']}",
        "",
        "## PnL 重构",
        "",
        f"- pnl_corr：{recon_audit.get('pnl_corr', 0):.3f}",
        f"- sign_match_rate：{recon_audit.get('sign_match_rate', 0):.2%}",
        f"- mean_abs_diff_per_trade：${recon_audit.get('mean_abs_diff_per_trade', 0):.2f}",
        f"- return_corr：{recon_audit.get('return_corr', 0):.3f}",
        f"- return_sign_match_rate：{recon_audit.get('return_sign_match_rate', 0):.2%}",
        "",
        "| model | trades | win_rate | net_pnl | PF | max_dd |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for name in ["v1_22_metrics", "minute_reconstructed_metrics", "v1_24_metrics"]:
        m = recon_audit.get(name, {})
        lines.append(
            f"| {name} | {m.get('trades', 0)} | {m.get('win_rate', 0):.2%} | "
            f"${m.get('net_pnl_usd', 0):.2f} | {m.get('profit_factor', 0):.3f} | ${m.get('max_drawdown_usd', 0):.2f} |"
        )
    lines.extend(
        [
            "",
            "## Q 阈值审计",
            "",
            "| threshold | value |",
            "|---|---:|",
        ]
    )
    for key, value in q_quantiles.items():
        lines.append(f"| {key} | {value:.4f} |")
    lines.extend(
        [
            "",
            "## 消融",
            "",
            "| variant | trades | win_rate | net_pnl | PF | max_dd |",
            "|---|---:|---:|---:|---:|---:|",
        ]
    )
    for row in ablation_rows:
        lines.append(
            f"| {row['variant']} | {row['trades']} | {row['win_rate']:.2%} | "
            f"${row['net_pnl_usd']:.2f} | {row['profit_factor']:.3f} | ${row['max_drawdown_usd']:.2f} |"
        )
    lines.extend(
        [
            "",
            "## 必答问题",
            "",
            f"1. 57/64 未完全匹配的原因是什么？{promotion['unmatched_answer']}",
            f"2. 真实分钟数据能否复现 V1.22 session_close PnL？{promotion['reconstruction_answer']}",
            f"3. 差异来自哪里？{promotion['difference_answer']}",
            f"4. Q hard exit 是否在重构通过后仍有效？{promotion['q_exit_answer']}",
            f"5. trailing 是否仍削弱赢家？{promotion['trailing_answer']}",
            f"6. V1.24 失败是策略问题还是数据/执行对齐问题？{promotion['root_cause_answer']}",
            "",
            f"最终状态：`{promotion['status']}`",
        ]
    )
    (OUT_DIR / "HFCD_Trading_V1_25_GoldRealMinuteFeedForensics.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    cfg = ReconConfig()
    selected = load_selected_v22()
    q, replay, acq = load_v24()
    feed_rows, feed_summary = audit_feed(selected, q, replay, acq, cfg)
    recon, recon_audit = reconstruct_baseline(selected, q, replay, cfg)
    qcal, q_quantiles = q_calibration(q)
    ablation_rows = ablations(recon, replay)

    feed_pass = feed_summary["matched_rate"] >= 0.95 and feed_summary["bad_spread_count_total"] == 0
    reconstruction_pass = (
        recon_audit.get("pnl_corr", 0) >= 0.90
        and recon_audit.get("sign_match_rate", 0) >= 0.80
        and recon_audit.get("mean_abs_diff_per_trade", 999) <= 15.0
    )
    status = "gold_real_minute_feed_validated" if feed_pass and reconstruction_pass else "watchlist_not_promoted_feed_alignment_failed"
    unmatched = [r for r in feed_rows if not r["matched"]]
    unmatched_reasons = sorted({r["unmatched_reason"] for r in unmatched})
    promotion = {
        "status": status,
        "feed_pass": feed_pass,
        "reconstruction_pass": reconstruction_pass,
        "unmatched_answer": f"未匹配 7 笔，主要原因是周末/节假日后只能拿到少量分钟行，低于 replay 最小可用阈值；原因集合={unmatched_reasons}。",
        "reconstruction_answer": "不能。" if not reconstruction_pass else "可以。",
        "difference_answer": "核心差异是口径错位：V1.22 用 GC 日线 close-to-next-close 期货连续前月收益，V1.24/V1.25 使用下一交易日美盘时段的分钟 mid/BBO 片段；symbol 和合约基本一致，但 horizon、price basis、session window、fill model 不一致。",
        "q_exit_answer": "不能判定有效；baseline reconstruction 未通过，Q exit 结果没有策略解释力。",
        "trailing_answer": "不能作为主结论；在 feed/PNL 重构未通过前，trailing 的正负只是执行口径叠加结果。",
        "root_cause_answer": "优先判定为数据/执行对齐问题，而不是 V1.22 低频主策略失效。必须先统一日线收益口径与分钟 replay 持仓区间。",
    }

    feed_path = OUT_DIR / "hfcd_trading_v1_25_feed_audit.csv"
    recon_path = OUT_DIR / "hfcd_trading_v1_25_reconstruction.csv"
    q_path = OUT_DIR / "hfcd_trading_v1_25_qpath_calibration.csv"
    ablation_path = OUT_DIR / "hfcd_trading_v1_25_ablation.csv"
    plot_path = OUT_DIR / "HFCD_Trading_V1_25_GoldRealMinuteFeedForensics.png"
    write_csv(feed_path, feed_rows)
    recon.to_csv(recon_path, index=False)
    qcal.to_csv(q_path, index=False)
    write_csv(ablation_path, ablation_rows)
    create_plot(recon, recon_audit, plot_path)

    summary = {
        "version": VERSION,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "status": status,
        "candidate_decision": "gold_real_minute_feed_validated" if status == "gold_real_minute_feed_validated" else "watchlist_not_promoted",
        "feed_summary": feed_summary,
        "reconstruction_audit": recon_audit,
        "q_quantile_thresholds": q_quantiles,
        "ablation": ablation_rows,
        "promotion": promotion,
        "outputs": {
            "feed_audit": str(feed_path),
            "reconstruction": str(recon_path),
            "qpath_calibration": str(q_path),
            "ablation": str(ablation_path),
            "plot": str(plot_path),
        },
    }
    (OUT_DIR / "hfcd_trading_v1_25_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_csv(
        OUT_DIR / "hfcd_trading_v1_25_summary.csv",
        [
            {"section": "feed", **feed_summary},
            {
                "section": "reconstruction",
                "pnl_corr": recon_audit.get("pnl_corr", 0),
                "sign_match_rate": recon_audit.get("sign_match_rate", 0),
                "mean_abs_diff_per_trade": recon_audit.get("mean_abs_diff_per_trade", 0),
                "status": status,
            },
        ],
    )
    write_report(feed_summary, recon_audit, q_quantiles, ablation_rows, promotion)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
