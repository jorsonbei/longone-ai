#!/usr/bin/env python3
"""
HFCD Trading V1.29 Gold Official Settlement Baseline Replay.

V1.28 showed that the V1.22 gold line used Databento ohlcv-1d close, not the
official CME settlement price. This stage rebuilds the V1.20/V1.21 gold
baseline on the official settlement anchor and reruns only signal-threshold /
execution-size variants. It does not tune Q dynamic exits or trailing stops.
"""

from __future__ import annotations

import csv
import json
import math
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


VERSION = "HFCD_Trading_V1_29_GoldOfficialSettlementBaselineReplay"
ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v1_29_gold_official_settlement_baseline_replay"
V18_DIR = ROOT / "outputs" / "hfcd_trading_v1_18_gold_walk_forward"
V21_DIR = ROOT / "outputs" / "hfcd_trading_v1_21_gold_pf_win_lift"
V28_DIR = ROOT / "outputs" / "hfcd_trading_v1_28_gold_official_settlement_table"

DAILY_FEATURE_PATH = V18_DIR / "hfcd_trading_v1_18_daily_feature_table.csv"
OFFICIAL_SETTLEMENT_PATH = V28_DIR / "hfcd_trading_v1_28_official_settlement_table.csv"
V21_COMPARISON_PATH = V21_DIR / "hfcd_trading_v1_21_variant_comparison.csv"

NOTIONAL_USD = 10_000.0
BASE_FEE_RATE = 0.00035


@dataclass(frozen=True)
class Variant:
    name: str
    threshold: float
    sizing_mode: str = "fixed"
    sizing_gamma: float = 1.0
    sizing_cap: float = 1.0
    vix_guard_quantile: float | None = None
    q_guard_quantile: float | None = None
    min_holdout_trades: int = 20
    promotable: bool = True


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


def json_clean(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k): json_clean(v) for k, v in value.items()}
    if isinstance(value, list):
        return [json_clean(v) for v in value]
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating, float)):
        v = float(value)
        return v if math.isfinite(v) else None
    if pd.isna(value) if not isinstance(value, (str, bytes, bool, type(None))) else False:
        return None
    return value


def max_drawdown(pnls: list[float]) -> float:
    if not pnls:
        return 0.0
    equity = np.cumsum(pnls)
    peak = np.maximum.accumulate(equity)
    return float((equity - peak).min())


def metrics(pnls: list[float]) -> dict[str, Any]:
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]
    gross_win = float(sum(wins))
    gross_loss = float(abs(sum(losses)))
    return {
        "trades": len(pnls),
        "win_rate": float(len(wins) / len(pnls)) if pnls else 0.0,
        "net_pnl_usd": float(sum(pnls)),
        "profit_factor": float(gross_win / gross_loss) if gross_loss > 0 else (999.0 if gross_win > 0 else 0.0),
        "max_drawdown_usd": max_drawdown(pnls),
        "avg_pnl_usd": float(np.mean(pnls)) if pnls else 0.0,
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


def load_daily_features() -> pd.DataFrame:
    if not DAILY_FEATURE_PATH.exists():
        raise FileNotFoundError(f"Missing daily feature table: {DAILY_FEATURE_PATH}")
    daily = pd.read_csv(DAILY_FEATURE_PATH)
    daily["date"] = pd.to_datetime(daily["date"], errors="coerce")
    daily = daily.sort_values("date").reset_index(drop=True)
    required = ["sensor_gate", "sensor_fusion_score", "front_close", "front_ret_next", "front_symbol"]
    missing = [c for c in required if c not in daily.columns]
    if missing:
        raise ValueError(f"Missing required daily feature columns: {missing}")
    daily["sensor_gate"] = daily["sensor_gate"].astype(bool)
    numeric_cols = [
        "sensor_fusion_score",
        "front_close",
        "front_ret_next",
        "volatility_5d",
        "momentum_3d",
        "vix_delta_3d",
        "dollar_delta_3d",
        "total_oi_delta_3d",
        "curve_roll_yield_mean",
    ]
    for col in numeric_cols:
        if col not in daily.columns:
            daily[col] = 0.0
        daily[col] = pd.to_numeric(daily[col], errors="coerce").fillna(0.0)

    vol = daily["volatility_5d"].replace(0.0, np.nan).fillna(float(daily["volatility_5d"].median()) or 1e-6)
    oi_lift = 1.0 + np.maximum(0.0, daily["total_oi_delta_3d"])
    daily["q_core_quality_proxy"] = np.exp(-np.abs(daily["momentum_3d"]) / (vol + 1e-9)) * oi_lift
    daily["event_risk_proxy"] = daily["vix_delta_3d"]
    daily["exit_date"] = daily["date"].shift(-1)
    daily["exit_symbol"] = daily["front_symbol"].shift(-1)
    daily["ohlcv_exit_close"] = daily["front_close"].shift(-1)
    daily["roll_detected"] = daily["front_symbol"] != daily["exit_symbol"]

    candidates = daily[daily["sensor_gate"] & daily["front_ret_next"].notna() & daily["exit_date"].notna()].copy()
    return candidates.reset_index(drop=True)


def load_official_settlements() -> pd.DataFrame:
    if not OFFICIAL_SETTLEMENT_PATH.exists():
        raise FileNotFoundError(f"Missing V1.28 official settlement table: {OFFICIAL_SETTLEMENT_PATH}")
    st = pd.read_csv(OFFICIAL_SETTLEMENT_PATH)
    st["date"] = pd.to_datetime(st["date"], errors="coerce")
    for col in ["settlement_price", "open_interest", "cleared_volume", "fixing_price"]:
        if col in st.columns:
            st[col] = pd.to_numeric(st[col], errors="coerce")
        else:
            st[col] = np.nan
    if "settlement_ts_event" not in st.columns:
        st["settlement_ts_event"] = ""
    return st.dropna(subset=["date", "symbol"]).sort_values(["date", "symbol"]).reset_index(drop=True)


def attach_official_returns(candidates: pd.DataFrame, settlements: pd.DataFrame) -> pd.DataFrame:
    entry = settlements.rename(
        columns={
            "date": "date",
            "symbol": "front_symbol",
            "settlement_price": "entry_settlement_price",
            "settlement_ts_event": "entry_settlement_ts_event",
            "open_interest": "entry_open_interest",
            "cleared_volume": "entry_cleared_volume",
            "fixing_price": "entry_fixing_price",
        }
    )
    exit_ = settlements.rename(
        columns={
            "date": "exit_date",
            "symbol": "exit_symbol",
            "settlement_price": "exit_settlement_price",
            "settlement_ts_event": "exit_settlement_ts_event",
            "open_interest": "exit_open_interest",
            "cleared_volume": "exit_cleared_volume",
            "fixing_price": "exit_fixing_price",
        }
    )
    entry_cols = [
        "date",
        "front_symbol",
        "entry_settlement_price",
        "entry_settlement_ts_event",
        "entry_open_interest",
        "entry_cleared_volume",
        "entry_fixing_price",
    ]
    exit_cols = [
        "exit_date",
        "exit_symbol",
        "exit_settlement_price",
        "exit_settlement_ts_event",
        "exit_open_interest",
        "exit_cleared_volume",
        "exit_fixing_price",
    ]
    out = candidates.merge(entry[entry_cols], on=["date", "front_symbol"], how="left")
    out = out.merge(exit_[exit_cols], on=["exit_date", "exit_symbol"], how="left")
    matched = out["entry_settlement_price"].notna() & out["exit_settlement_price"].notna()
    out["official_settlement_return"] = np.where(
        matched,
        (out["exit_settlement_price"] - out["entry_settlement_price"]) / out["entry_settlement_price"],
        np.nan,
    )
    out["official_coverage"] = np.where(matched, "matched", "missing_entry_or_exit_settlement")
    out["ohlcv_return"] = out["front_ret_next"].astype(float)
    out["official_vs_ohlcv_return_diff"] = out["official_settlement_return"] - out["ohlcv_return"]
    out["trade_id"] = np.arange(len(out))
    return out


def variants() -> list[Variant]:
    return [
        Variant("official_v1_20_base_floor_1p00", threshold=1.00),
        Variant("official_balanced_floor_1p10", threshold=1.10),
        Variant("official_floor_1p15", threshold=1.15),
        Variant("official_floor_1p20", threshold=1.20),
        Variant("official_strict_watchlist_floor_1p25", threshold=1.25, min_holdout_trades=18),
        Variant(
            "official_confidence_sizing_audit_floor_1p10",
            threshold=1.10,
            sizing_mode="score_power",
            sizing_gamma=1.0,
            sizing_cap=1.25,
            promotable=False,
        ),
        Variant("official_q_core_guard_audit_floor_1p10", threshold=1.10, q_guard_quantile=0.10, promotable=False),
        Variant("official_vix_event_guard_audit_floor_1p00", threshold=1.00, vix_guard_quantile=0.95, promotable=False),
    ]


def position_multiplier(score: float, variant: Variant) -> float:
    if variant.sizing_mode == "fixed":
        return 1.0
    strength = max(0.0, (score - variant.threshold) / max(variant.threshold, 1e-9))
    if variant.sizing_mode == "score_power":
        return min(variant.sizing_cap, max(0.35, (1.0 + strength) ** variant.sizing_gamma))
    return 1.0


def materialize_variant(train: pd.DataFrame, variant: Variant) -> dict[str, Any]:
    return {
        **asdict(variant),
        "vix_guard_value": None
        if variant.vix_guard_quantile is None
        else float(train["event_risk_proxy"].quantile(variant.vix_guard_quantile)),
        "q_guard_value": None
        if variant.q_guard_quantile is None
        else float(train["q_core_quality_proxy"].quantile(variant.q_guard_quantile)),
    }


def run_variant(data: pd.DataFrame, config: dict[str, Any], fold: str, fee_rate: float) -> list[dict[str, Any]]:
    variant = Variant(
        name=str(config["name"]),
        threshold=float(config["threshold"]),
        sizing_mode=str(config["sizing_mode"]),
        sizing_gamma=float(config["sizing_gamma"]),
        sizing_cap=float(config["sizing_cap"]),
        vix_guard_quantile=config.get("vix_guard_quantile"),
        q_guard_quantile=config.get("q_guard_quantile"),
        min_holdout_trades=int(config.get("min_holdout_trades", 20)),
        promotable=bool(config.get("promotable", True)),
    )
    rows: list[dict[str, Any]] = []
    q_guard_value = config.get("q_guard_value")
    vix_guard_value = config.get("vix_guard_value")
    for _, row in data.iterrows():
        if row.get("official_coverage") != "matched":
            continue
        score = float(row.get("sensor_fusion_score", 0.0) or 0.0)
        if score < variant.threshold:
            continue
        if vix_guard_value is not None and float(row.get("event_risk_proxy", 0.0) or 0.0) > float(vix_guard_value):
            continue
        if q_guard_value is not None and float(row.get("q_core_quality_proxy", 0.0) or 0.0) < float(q_guard_value):
            continue
        multiplier = position_multiplier(score, variant)
        notional = NOTIONAL_USD * multiplier
        official_return = float(row["official_settlement_return"])
        official_pnl = official_return * notional - notional * fee_rate
        ohlcv_pnl = float(row["ohlcv_return"]) * notional - notional * fee_rate
        rows.append(
            {
                "fold": fold,
                "date": str(row["date"].date()),
                "exit_date": str(row["exit_date"].date()),
                "variant": variant.name,
                "promotable": variant.promotable,
                "threshold": variant.threshold,
                "sizing_mode": variant.sizing_mode,
                "q_guard_quantile": variant.q_guard_quantile,
                "q_guard_value": q_guard_value,
                "vix_guard_quantile": variant.vix_guard_quantile,
                "vix_guard_value": vix_guard_value,
                "side": "long",
                "score": score,
                "position_multiplier": multiplier,
                "notional_usd": notional,
                "front_symbol": row["front_symbol"],
                "exit_symbol": row["exit_symbol"],
                "roll_detected": bool(row["roll_detected"]),
                "front_close": float(row["front_close"]),
                "ohlcv_exit_close": float(row["ohlcv_exit_close"]),
                "entry_settlement_price": float(row["entry_settlement_price"]),
                "exit_settlement_price": float(row["exit_settlement_price"]),
                "official_settlement_return": official_return,
                "ohlcv_return": float(row["ohlcv_return"]),
                "official_vs_ohlcv_return_diff": float(row["official_vs_ohlcv_return_diff"]),
                "fee_rate": fee_rate,
                "official_settlement_pnl": official_pnl,
                "ohlcv_pnl": ohlcv_pnl,
                "pnl_delta_vs_ohlcv": official_pnl - ohlcv_pnl,
                "q_core_quality_proxy": float(row.get("q_core_quality_proxy", 0.0) or 0.0),
                "event_risk_proxy": float(row.get("event_risk_proxy", 0.0) or 0.0),
                "volatility_5d": float(row.get("volatility_5d", 0.0) or 0.0),
                "entry_open_interest": row.get("entry_open_interest"),
                "exit_open_interest": row.get("exit_open_interest"),
                "official_coverage": row.get("official_coverage"),
            }
        )
    return rows


def evaluate_split(data: pd.DataFrame, variant: Variant) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    split = int(len(data) * 0.60)
    calibration = data.iloc[:split].copy()
    holdout = data.iloc[split:].copy()
    config = materialize_variant(calibration, variant)
    cal_trades = run_variant(calibration, config, "calibration", BASE_FEE_RATE)
    holdout_trades = run_variant(holdout, config, "holdout", BASE_FEE_RATE)
    holdout_stress = run_variant(holdout, config, "holdout_stress_2x_fee", BASE_FEE_RATE * 2.0)
    report = {
        **config,
        "calibration_start": str(calibration["date"].iloc[0].date()),
        "calibration_end": str(calibration["date"].iloc[-1].date()),
        "holdout_start": str(holdout["date"].iloc[0].date()),
        "holdout_end": str(holdout["date"].iloc[-1].date()),
        **{f"calibration_{k}": v for k, v in metrics([float(t["official_settlement_pnl"]) for t in cal_trades]).items()},
        **{f"holdout_{k}": v for k, v in metrics([float(t["official_settlement_pnl"]) for t in holdout_trades]).items()},
        **{f"holdout_stress2x_{k}": v for k, v in metrics([float(t["official_settlement_pnl"]) for t in holdout_stress]).items()},
        "holdout_ohlcv_net_pnl_usd": float(sum(float(t["ohlcv_pnl"]) for t in holdout_trades)),
        "holdout_pnl_delta_vs_ohlcv": float(sum(float(t["pnl_delta_vs_ohlcv"]) for t in holdout_trades)),
    }
    return report, holdout_trades, holdout_stress


def evaluate_rolling(data: pd.DataFrame, variant: Variant) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    train_len = 252
    test_len = 63
    step = 63
    folds: list[dict[str, Any]] = []
    trades: list[dict[str, Any]] = []
    stress_trades: list[dict[str, Any]] = []
    for fold_no, start in enumerate(range(0, max(len(data) - train_len - test_len + 1, 0), step), start=1):
        train = data.iloc[start : start + train_len].copy()
        test = data.iloc[start + train_len : start + train_len + test_len].copy()
        if len(train) < train_len or len(test) < test_len:
            continue
        config = materialize_variant(train, variant)
        test_trades = run_variant(test, config, f"rolling_test_{fold_no}", BASE_FEE_RATE)
        test_stress = run_variant(test, config, f"rolling_test_{fold_no}_stress_2x_fee", BASE_FEE_RATE * 2.0)
        m = metrics([float(t["official_settlement_pnl"]) for t in test_trades])
        sm = metrics([float(t["official_settlement_pnl"]) for t in test_stress])
        trades.extend(test_trades)
        stress_trades.extend(test_stress)
        folds.append(
            {
                "fold_no": fold_no,
                "test_start": str(test["date"].iloc[0].date()),
                "test_end": str(test["date"].iloc[-1].date()),
                "variant": variant.name,
                "trades": m["trades"],
                "win_rate": m["win_rate"],
                "net_pnl_usd": m["net_pnl_usd"],
                "profit_factor": m["profit_factor"],
                "max_drawdown_usd": m["max_drawdown_usd"],
                "stress2x_net_pnl_usd": sm["net_pnl_usd"],
                "stress2x_profit_factor": sm["profit_factor"],
                "positive_fold": bool(m["net_pnl_usd"] > 0),
                "ohlcv_net_pnl_usd": float(sum(float(t["ohlcv_pnl"]) for t in test_trades)),
                "pnl_delta_vs_ohlcv": float(sum(float(t["pnl_delta_vs_ohlcv"]) for t in test_trades)),
            }
        )
    rolling_metrics = metrics([float(t["official_settlement_pnl"]) for t in trades])
    rolling_stress = metrics([float(t["official_settlement_pnl"]) for t in stress_trades])
    summary = {
        **{f"rolling_{k}": v for k, v in rolling_metrics.items()},
        **{f"rolling_stress2x_{k}": v for k, v in rolling_stress.items()},
        "rolling_positive_fold_rate": float(np.mean([f["positive_fold"] for f in folds])) if folds else 0.0,
        "rolling_folds": len(folds),
        "rolling_ohlcv_net_pnl_usd": float(sum(float(t["ohlcv_pnl"]) for t in trades)),
        "rolling_pnl_delta_vs_ohlcv": float(sum(float(t["pnl_delta_vs_ohlcv"]) for t in trades)),
    }
    return folds, trades, stress_trades, summary


def candidate_coverage(data: pd.DataFrame) -> dict[str, Any]:
    out = {
        "candidate_rows": int(len(data)),
        "matched_rows": int((data["official_coverage"] == "matched").sum()),
        "coverage_rate": float((data["official_coverage"] == "matched").mean()) if len(data) else 0.0,
        "start": str(data["date"].min().date()) if len(data) else "",
        "end": str(data["date"].max().date()) if len(data) else "",
    }
    for threshold in [1.0, 1.1, 1.15, 1.2, 1.25, 1.3]:
        sub = data[data["sensor_fusion_score"] >= threshold]
        out[f"rows_score_ge_{str(threshold).replace('.', 'p')}"] = int(len(sub))
        out[f"matched_score_ge_{str(threshold).replace('.', 'p')}"] = int((sub["official_coverage"] == "matched").sum())
    matched = data[data["official_coverage"] == "matched"].copy()
    out["official_vs_ohlcv_return_corr"] = safe_corr(matched["ohlcv_return"], matched["official_settlement_return"])
    out["official_vs_ohlcv_sign_match"] = sign_match(matched["ohlcv_return"], matched["official_settlement_return"])
    out["official_vs_ohlcv_mean_abs_return_diff"] = float(matched["official_vs_ohlcv_return_diff"].abs().mean()) if len(matched) else None
    out["missing_rows"] = int((data["official_coverage"] != "matched").sum())
    return out


def load_v21_reference() -> dict[str, dict[str, Any]]:
    if not V21_COMPARISON_PATH.exists():
        return {}
    df = pd.read_csv(V21_COMPARISON_PATH)
    return {str(row["name"]): row.to_dict() for _, row in df.iterrows()}


def build_plot(variant_rows: list[dict[str, Any]], selected_trades: list[dict[str, Any]], out_path: Path) -> None:
    vc = pd.DataFrame(variant_rows)
    trades = pd.DataFrame(selected_trades)
    fig, axes = plt.subplots(2, 2, figsize=(14, 9))
    fig.suptitle("HFCD Trading V1.29 Gold Official Settlement Baseline", fontsize=16, fontweight="bold")

    ax = axes[0, 0]
    if not vc.empty:
        vc.plot.bar(x="name", y=["holdout_net_pnl_usd", "rolling_net_pnl_usd"], ax=ax)
        ax.set_title("Official settlement PnL by variant")
        ax.tick_params(axis="x", rotation=45)
        ax.axhline(0, color="black", lw=0.8)

    ax = axes[0, 1]
    if not vc.empty:
        vc.plot.bar(x="name", y=["holdout_profit_factor", "rolling_profit_factor"], ax=ax, color=["#377eb8", "#4daf4a"])
        ax.set_title("Profit factor by variant")
        ax.tick_params(axis="x", rotation=45)
        ax.axhline(1.0, color="red", lw=0.8, ls="--")

    ax = axes[1, 0]
    if not trades.empty:
        trades["date"] = pd.to_datetime(trades["date"])
        trades = trades.sort_values("date")
        trades["cum_official"] = trades["official_settlement_pnl"].cumsum()
        trades["cum_ohlcv"] = trades["ohlcv_pnl"].cumsum()
        ax.plot(trades["date"], trades["cum_official"], label="official settlement")
        ax.plot(trades["date"], trades["cum_ohlcv"], label="ohlcv close", alpha=0.7)
        ax.set_title("Selected baseline cumulative PnL")
        ax.legend()

    ax = axes[1, 1]
    if not trades.empty:
        ax.scatter(trades["ohlcv_pnl"], trades["official_settlement_pnl"], alpha=0.7)
        mn = min(trades["ohlcv_pnl"].min(), trades["official_settlement_pnl"].min())
        mx = max(trades["ohlcv_pnl"].max(), trades["official_settlement_pnl"].max())
        ax.plot([mn, mx], [mn, mx], color="red", ls="--", lw=1)
        ax.set_xlabel("ohlcv PnL")
        ax.set_ylabel("official settlement PnL")
        ax.set_title("PnL anchor drift")

    plt.tight_layout()
    fig.savefig(out_path, dpi=160)
    plt.close(fig)


def write_report(summary: dict[str, Any], out_path: Path) -> None:
    best = summary["selected_variant"]
    lines = [
        f"# {VERSION}",
        "",
        "## 结论",
        "",
        f"- 状态：`{summary['status']}`",
        f"- 候选结论：`{summary['candidate_decision']}`",
        f"- 附件判断：{summary['attachment_assessment']}",
        f"- 官方 settlement 覆盖率：{summary['coverage']['coverage_rate']:.2%}",
        f"- 官方 settlement 与原 OHLCV 收益相关：{summary['coverage']['official_vs_ohlcv_return_corr']:.3f}",
        f"- 官方 settlement 与原 OHLCV 方向一致：{summary['coverage']['official_vs_ohlcv_sign_match']:.2%}",
        "",
        "## 选中基线",
        "",
        f"- 名称：`{best['name']}`",
        f"- Holdout：交易 {best['holdout_trades']}，胜率 {best['holdout_win_rate']:.2%}，净收益 ${best['holdout_net_pnl_usd']:.2f}，PF {best['holdout_profit_factor']:.3f}",
        f"- Rolling：交易 {best['rolling_trades']}，胜率 {best['rolling_win_rate']:.2%}，净收益 ${best['rolling_net_pnl_usd']:.2f}，PF {best['rolling_profit_factor']:.3f}",
        f"- 2x fee holdout：净收益 ${best['holdout_stress2x_net_pnl_usd']:.2f}，PF {best['holdout_stress2x_profit_factor']:.3f}",
        "",
        "## 必答问题",
        "",
    ]
    for key, answer in summary["answers"].items():
        lines.append(f"- **{key}**：{answer}")
    lines += [
        "",
        "## 关键限制",
        "",
        "- 本轮只重建官方 settlement 口径的 baseline，不允许把 Q 动态退出或 trailing 当成升级证据。",
        "- 由于 official settlement 与原 OHLCV close 存在显著差异，旧的 V1.20/V1.21 指标不能直接复用。",
        "- 如需进入分钟级执行层，下一步必须基于 V1.29 的官方 settlement baseline 重新定义执行锚。",
    ]
    out_path.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    daily = load_daily_features()
    settlements = load_official_settlements()
    official_data = attach_official_returns(daily, settlements)
    coverage = candidate_coverage(official_data)

    official_data_out = official_data.copy()
    for col in ["date", "exit_date"]:
        official_data_out[col] = pd.to_datetime(official_data_out[col]).dt.date.astype(str)
    official_data_out.to_csv(OUT_DIR / "hfcd_trading_v1_29_official_feature_table.csv", index=False)

    split_rows: list[dict[str, Any]] = []
    rolling_rows: list[dict[str, Any]] = []
    rolling_folds: list[dict[str, Any]] = []
    selected_holdout: list[dict[str, Any]] = []
    selected_rolling: list[dict[str, Any]] = []
    selected_variant_name = ""
    v21_ref = load_v21_reference()

    for variant in variants():
        split_report, holdout_trades, _holdout_stress = evaluate_split(official_data, variant)
        folds, rolling_trades, _rolling_stress, rolling_summary = evaluate_rolling(official_data, variant)
        row = {
            "name": variant.name,
            "promotable": variant.promotable,
            **split_report,
            **rolling_summary,
        }
        ref_name = {
            "official_v1_20_base_floor_1p00": "v1_20_base_floor_1p00",
            "official_balanced_floor_1p10": "balanced_pf_win_floor_1p10",
            "official_strict_watchlist_floor_1p25": "strict_pf_watchlist_floor_1p25",
            "official_confidence_sizing_audit_floor_1p10": "confidence_sizing_audit_floor_1p10",
            "official_q_core_guard_audit_floor_1p10": "q_core_guard_audit_floor_1p10",
            "official_vix_event_guard_audit_floor_1p00": "vix_event_guard_audit_floor_1p00",
        }.get(variant.name)
        if ref_name and ref_name in v21_ref:
            ref = v21_ref[ref_name]
            row["v21_holdout_net_pnl_usd"] = float(ref.get("holdout_net_pnl_usd", 0.0))
            row["v21_holdout_profit_factor"] = float(ref.get("holdout_profit_factor", 0.0))
            row["v21_rolling_net_pnl_usd"] = float(ref.get("rolling_net_pnl_usd", 0.0))
            row["v21_rolling_profit_factor"] = float(ref.get("rolling_profit_factor", 0.0))
            row["delta_holdout_pnl_vs_v21_ohlcv"] = row["holdout_net_pnl_usd"] - row["v21_holdout_net_pnl_usd"]
            row["delta_rolling_pnl_vs_v21_ohlcv"] = row["rolling_net_pnl_usd"] - row["v21_rolling_net_pnl_usd"]
        split_rows.append(row)
        rolling_rows.extend(rolling_trades)
        rolling_folds.extend(folds)

    split_df = pd.DataFrame(split_rows)
    promotable = split_df[split_df["promotable"].astype(bool)].copy()
    promotable["quality_score"] = (
        (promotable["holdout_net_pnl_usd"] > 0).astype(float)
        + (promotable["rolling_net_pnl_usd"] > 0).astype(float)
        + np.minimum(promotable["holdout_profit_factor"], 3.0) / 3.0
        + np.minimum(promotable["rolling_profit_factor"], 3.0) / 3.0
        + promotable["rolling_positive_fold_rate"].fillna(0.0)
        - (promotable["holdout_trades"] < promotable["min_holdout_trades"]).astype(float)
    )
    selected = promotable.sort_values(["quality_score", "holdout_profit_factor", "rolling_profit_factor"], ascending=False).iloc[0].to_dict()
    selected_variant_name = str(selected["name"])
    selected_variant = next(v for v in variants() if v.name == selected_variant_name)
    _, selected_holdout, _ = evaluate_split(official_data, selected_variant)
    _, selected_rolling, _, _ = evaluate_rolling(official_data, selected_variant)
    selected_trades = selected_rolling + selected_holdout

    sample_ok = selected["holdout_trades"] >= selected["min_holdout_trades"] and selected["rolling_trades"] >= 30
    candidate_ok = (
        bool(sample_ok)
        and selected["holdout_net_pnl_usd"] > 0
        and selected["rolling_net_pnl_usd"] > 0
        and selected["holdout_profit_factor"] > 1.20
        and selected["rolling_profit_factor"] > 1.10
        and selected["holdout_stress2x_net_pnl_usd"] > 0
        and coverage["coverage_rate"] >= 0.95
    )
    status = "gold_official_settlement_baseline_candidate" if candidate_ok else "watchlist_official_settlement_baseline_not_promoted"
    decision = "promote_v129_baseline_for_next_execution_anchor" if candidate_ok else "keep_as_watchlist_rebuild_or_collect_more_settlement_data"

    variant_rows = split_df.to_dict("records")
    write_csv(OUT_DIR / "hfcd_trading_v1_29_variant_comparison.csv", variant_rows)
    write_csv(OUT_DIR / "hfcd_trading_v1_29_rolling_folds.csv", rolling_folds)
    write_csv(OUT_DIR / "hfcd_trading_v1_29_rolling_trades.csv", rolling_rows)
    write_csv(OUT_DIR / "hfcd_trading_v1_29_selected_trades.csv", selected_trades)
    split_df.to_csv(OUT_DIR / "hfcd_trading_v1_29_summary.csv", index=False)

    attachment_assessment = (
        "有价值，但不能采用其中的动态 settlement proxy / Q+Trailing 路线；"
        "应采用其更严谨的 official settlement bridge 结论，并在 V1.29 重建 baseline。"
    )
    summary = {
        "version": VERSION,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "status": status,
        "candidate_decision": decision,
        "attachment_assessment": attachment_assessment,
        "coverage": coverage,
        "selected_variant": json_clean(selected),
        "variant_count": len(variant_rows),
        "variants": json_clean(variant_rows),
        "answers": {
            "附件是否有价值": "有。它正确指出 V1.27 的核心不是继续调退出，而是必须先处理 settlement anchor。",
            "是否继续追动态 settlement proxy": "否。V1.28 已证明 official settlement 与 OHLCV close 差异显著，proxy 只能解释旧基线，不能当可部署锚。",
            "是否已基于 official settlement 重建黄金 baseline": "是。V1.29 已用 V1.28 官方 settlement 表重算 V1.20/V1.21 风格信号。",
            "是否允许 Q/trailing 优化": "仍不允许。本轮只解决官方结算锚下的主策略基线。",
            "下一步": "若 V1.29 candidate 成立，再做 official-settlement 口径的执行锚；否则先补更长 official settlement / 可执行 anchor 数据。",
        },
        "outputs": {
            "official_feature_table": str(OUT_DIR / "hfcd_trading_v1_29_official_feature_table.csv"),
            "variant_comparison": str(OUT_DIR / "hfcd_trading_v1_29_variant_comparison.csv"),
            "rolling_folds": str(OUT_DIR / "hfcd_trading_v1_29_rolling_folds.csv"),
            "rolling_trades": str(OUT_DIR / "hfcd_trading_v1_29_rolling_trades.csv"),
            "selected_trades": str(OUT_DIR / "hfcd_trading_v1_29_selected_trades.csv"),
            "summary_csv": str(OUT_DIR / "hfcd_trading_v1_29_summary.csv"),
            "summary_json": str(OUT_DIR / "hfcd_trading_v1_29_summary.json"),
            "report": str(OUT_DIR / "HFCD_Trading_V1_29_GoldOfficialSettlementBaselineReplay.md"),
            "figure": str(OUT_DIR / "HFCD_Trading_V1_29_GoldOfficialSettlementBaselineReplay.png"),
        },
    }

    (OUT_DIR / "hfcd_trading_v1_29_summary.json").write_text(
        json.dumps(json_clean(summary), ensure_ascii=False, indent=2, allow_nan=False),
        encoding="utf-8",
    )
    build_plot(variant_rows, selected_trades, OUT_DIR / "HFCD_Trading_V1_29_GoldOfficialSettlementBaselineReplay.png")
    write_report(summary, OUT_DIR / "HFCD_Trading_V1_29_GoldOfficialSettlementBaselineReplay.md")
    print(json.dumps(json_clean({"status": status, "candidate_decision": decision, "selected_variant": selected_variant_name, "coverage": coverage}), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
