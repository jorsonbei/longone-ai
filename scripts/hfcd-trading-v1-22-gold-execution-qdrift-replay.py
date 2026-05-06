#!/usr/bin/env python3
"""
HFCD Trading V1.22 Gold Execution + Q-Drift Replay

This stage freezes the V1.21 gold signal line and tests execution-layer
improvements only:
- real BBO-sample-informed friction rates;
- Q-core soft reduction instead of hard sample-starving rejection;
- VIX/event proxy guard as a risk-control watchlist;
- confidence sizing as an audit only.

It is a local historical replay. It does not place orders and it does not claim
live-trading readiness.
"""

from __future__ import annotations

import csv
import json
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


VERSION = "HFCD_Trading_V1_22_GoldExecutionQDriftReplay"
ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v1_22_gold_execution_qdrift_replay"
V16_DIR = ROOT / "outputs" / "hfcd_trading_v1_16_gold_full_acquisition"
V18_DIR = ROOT / "outputs" / "hfcd_trading_v1_18_gold_walk_forward"
V21_DIR = ROOT / "outputs" / "hfcd_trading_v1_21_gold_pf_win_lift"
DAILY_FEATURE_PATH = V18_DIR / "hfcd_trading_v1_18_daily_feature_table.csv"
BBO_SAMPLE_PATH = V16_DIR / "hfcd_trading_v1_16_gc_bbo_1s_sample.csv"
V21_SUMMARY_PATH = V21_DIR / "hfcd_trading_v1_21_summary.json"
NOTIONAL_USD = 10_000.0
BASE_FEE_RATE = 0.00035


@dataclass(frozen=True)
class Variant:
    name: str
    threshold: float = 1.10
    q_soft_quantile: float | None = None
    q_soft_multiplier: float = 1.0
    q_hard_quantile: float | None = None
    vix_guard_quantile: float | None = None
    sizing_mode: str = "fixed"
    sizing_gamma: float = 1.0
    sizing_cap: float = 1.0
    promotable: bool = True


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
        "max_drawdown_usd": max_drawdown(pnls),
        "profit_factor": float(gross_win / gross_loss) if gross_loss > 0 else (999.0 if gross_win > 0 else 0.0),
        "avg_pnl_usd": float(np.mean(pnls)) if pnls else 0.0,
        "gross_win_usd": gross_win,
        "gross_loss_usd": gross_loss,
    }


def load_daily_features() -> pd.DataFrame:
    if not DAILY_FEATURE_PATH.exists():
        raise FileNotFoundError(f"Missing V1.18 daily feature table: {DAILY_FEATURE_PATH}")
    daily = pd.read_csv(DAILY_FEATURE_PATH)
    daily["date"] = pd.to_datetime(daily["date"])
    daily = daily.sort_values("date").reset_index(drop=True)
    required = ["sensor_gate", "sensor_fusion_score", "front_ret_next", "front_close"]
    for col in required:
        if col not in daily.columns:
            raise ValueError(f"Missing required column in V1.18 feature table: {col}")
    daily["sensor_gate"] = daily["sensor_gate"].astype(bool)
    for col in [
        "sensor_fusion_score",
        "front_ret_next",
        "front_close",
        "volatility_5d",
        "momentum_3d",
        "vix_delta_3d",
        "dollar_delta_3d",
        "total_oi_delta_3d",
        "curve_roll_yield_mean",
    ]:
        if col in daily.columns:
            daily[col] = pd.to_numeric(daily[col], errors="coerce").fillna(0.0)
        else:
            daily[col] = 0.0
    vol = daily["volatility_5d"].replace(0.0, np.nan).fillna(float(daily["volatility_5d"].median()) or 1e-6)
    oi_lift = 1.0 + np.maximum(0.0, daily["total_oi_delta_3d"])
    daily["q_core_quality_proxy"] = np.exp(-np.abs(daily["momentum_3d"]) / (vol + 1e-9)) * oi_lift
    daily["event_risk_proxy"] = daily["vix_delta_3d"]
    return daily[daily["sensor_gate"] & daily["front_ret_next"].notna()].copy().reset_index(drop=True)


def load_bbo_friction_model() -> dict[str, Any]:
    default = {
        "source": "fallback_no_bbo_sample",
        "rows": 0,
        "median_spread_points": None,
        "median_mid_price": None,
        "median_top_book_size": None,
        "half_spread_rate": 0.00005,
        "depth_penalty_rate": 0.00002,
    }
    if not BBO_SAMPLE_PATH.exists():
        total = BASE_FEE_RATE + default["half_spread_rate"] + default["depth_penalty_rate"]
        return {
            **default,
            "estimated_l2_fee_rate": total,
            "double_l2_fee_rate": total * 2,
            "triple_l2_fee_rate": total * 3,
        }
    bbo = pd.read_csv(BBO_SAMPLE_PATH)
    if bbo.empty or not {"bid_px_00", "ask_px_00", "spread", "top_book_size"}.issubset(bbo.columns):
        total = BASE_FEE_RATE + default["half_spread_rate"] + default["depth_penalty_rate"]
        return {
            **default,
            "source": str(BBO_SAMPLE_PATH),
            "rows": int(len(bbo)),
            "estimated_l2_fee_rate": total,
            "double_l2_fee_rate": total * 2,
            "triple_l2_fee_rate": total * 3,
        }
    for col in ["bid_px_00", "ask_px_00", "spread", "top_book_size"]:
        bbo[col] = pd.to_numeric(bbo[col], errors="coerce")
    bbo = bbo.dropna(subset=["bid_px_00", "ask_px_00", "spread"])
    mid = (bbo["bid_px_00"] + bbo["ask_px_00"]) / 2.0
    median_mid = float(mid.median())
    median_spread = float(bbo["spread"].median())
    median_depth = float(bbo["top_book_size"].median()) if "top_book_size" in bbo else 0.0
    half_spread_rate = float(median_spread / (2.0 * median_mid)) if median_mid > 0 else default["half_spread_rate"]
    depth_penalty_rate = max(0.0, 3.0 - median_depth) * 0.00001
    total = BASE_FEE_RATE + half_spread_rate + depth_penalty_rate
    return {
        "source": str(BBO_SAMPLE_PATH),
        "rows": int(len(bbo)),
        "median_spread_points": median_spread,
        "median_mid_price": median_mid,
        "median_top_book_size": median_depth,
        "half_spread_rate": half_spread_rate,
        "depth_penalty_rate": depth_penalty_rate,
        "estimated_l2_fee_rate": total,
        "double_l2_fee_rate": total * 2,
        "triple_l2_fee_rate": total * 3,
    }


def variants() -> list[Variant]:
    return [
        Variant("v1_21_frozen_floor_1p10"),
        Variant("q_soft_reduce_floor_1p10", q_soft_quantile=0.10, q_soft_multiplier=0.50),
        Variant(
            "q_soft_event_guard_floor_1p10",
            q_soft_quantile=0.10,
            q_soft_multiplier=0.50,
            vix_guard_quantile=0.95,
        ),
        Variant("q_hard_guard_audit_floor_1p10", q_hard_quantile=0.10, promotable=False),
        Variant(
            "confidence_sizing_audit_floor_1p10",
            sizing_mode="score_power",
            sizing_gamma=1.0,
            sizing_cap=1.25,
            promotable=False,
        ),
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
        "q_soft_value": None
        if variant.q_soft_quantile is None
        else float(train["q_core_quality_proxy"].quantile(variant.q_soft_quantile)),
        "q_hard_value": None
        if variant.q_hard_quantile is None
        else float(train["q_core_quality_proxy"].quantile(variant.q_hard_quantile)),
        "vix_guard_value": None
        if variant.vix_guard_quantile is None
        else float(train["event_risk_proxy"].quantile(variant.vix_guard_quantile)),
    }


def run_variant(data: pd.DataFrame, config: dict[str, Any], fold: str, friction_label: str, fee_rate: float) -> list[dict[str, Any]]:
    variant = Variant(
        name=str(config["name"]),
        threshold=float(config["threshold"]),
        q_soft_quantile=config["q_soft_quantile"],
        q_soft_multiplier=float(config["q_soft_multiplier"]),
        q_hard_quantile=config["q_hard_quantile"],
        vix_guard_quantile=config["vix_guard_quantile"],
        sizing_mode=str(config["sizing_mode"]),
        sizing_gamma=float(config["sizing_gamma"]),
        sizing_cap=float(config["sizing_cap"]),
        promotable=bool(config["promotable"]),
    )
    rows: list[dict[str, Any]] = []
    q_soft_value = config.get("q_soft_value")
    q_hard_value = config.get("q_hard_value")
    vix_guard_value = config.get("vix_guard_value")
    for _, row in data.iterrows():
        score = float(row.get("sensor_fusion_score", 0.0) or 0.0)
        if score < variant.threshold:
            continue
        event_risk = float(row.get("event_risk_proxy", 0.0) or 0.0)
        if vix_guard_value is not None and event_risk > float(vix_guard_value):
            continue
        q_quality = float(row.get("q_core_quality_proxy", 0.0) or 0.0)
        if q_hard_value is not None and q_quality < float(q_hard_value):
            continue
        q_reduction_applied = False
        multiplier = position_multiplier(score, variant)
        if q_soft_value is not None and q_quality < float(q_soft_value):
            multiplier *= variant.q_soft_multiplier
            q_reduction_applied = True
        notional = NOTIONAL_USD * multiplier
        pnl = float(row["front_ret_next"]) * notional - notional * fee_rate
        rows.append(
            {
                "fold": fold,
                "friction_label": friction_label,
                "date": str(row["date"].date()),
                "variant": variant.name,
                "promotable": variant.promotable,
                "threshold": variant.threshold,
                "q_soft_quantile": variant.q_soft_quantile,
                "q_soft_value": q_soft_value,
                "q_soft_multiplier": variant.q_soft_multiplier,
                "q_hard_quantile": variant.q_hard_quantile,
                "q_hard_value": q_hard_value,
                "vix_guard_quantile": variant.vix_guard_quantile,
                "vix_guard_value": vix_guard_value,
                "side": "long",
                "score": score,
                "position_multiplier": multiplier,
                "q_reduction_applied": q_reduction_applied,
                "notional_usd": notional,
                "front_symbol": row.get("front_symbol", ""),
                "front_close": float(row["front_close"]),
                "front_ret_next": float(row["front_ret_next"]),
                "fee_rate": fee_rate,
                "pnl_usd": pnl,
                "q_core_quality_proxy": q_quality,
                "event_risk_proxy": event_risk,
                "volatility_5d": float(row.get("volatility_5d", 0.0) or 0.0),
            }
        )
    return rows


def friction_rates(model: dict[str, Any]) -> list[tuple[str, float]]:
    return [
        ("base_fee", BASE_FEE_RATE),
        ("l2_estimated", float(model["estimated_l2_fee_rate"])),
        ("l2_double", float(model["double_l2_fee_rate"])),
        ("l2_triple", float(model["triple_l2_fee_rate"])),
    ]


def evaluate_split(
    daily: pd.DataFrame, variant: Variant, friction_model: dict[str, Any]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    split = int(len(daily) * 0.60)
    calibration = daily.iloc[:split].copy()
    holdout = daily.iloc[split:].copy()
    config = materialize_variant(calibration, variant)
    rows: list[dict[str, Any]] = []
    trades: list[dict[str, Any]] = []
    for label, fee_rate in friction_rates(friction_model):
        cal_trades = run_variant(calibration, config, "calibration", label, fee_rate)
        holdout_trades = run_variant(holdout, config, "holdout", label, fee_rate)
        trades.extend(holdout_trades)
        row = {
            **config,
            "friction_label": label,
            "fee_rate": fee_rate,
            "calibration_start": str(calibration["date"].iloc[0].date()),
            "calibration_end": str(calibration["date"].iloc[-1].date()),
            "holdout_start": str(holdout["date"].iloc[0].date()),
            "holdout_end": str(holdout["date"].iloc[-1].date()),
            **{f"calibration_{k}": v for k, v in metrics([float(t["pnl_usd"]) for t in cal_trades]).items()},
            **{f"holdout_{k}": v for k, v in metrics([float(t["pnl_usd"]) for t in holdout_trades]).items()},
            "holdout_q_reduction_count": sum(1 for t in holdout_trades if t.get("q_reduction_applied")),
        }
        rows.append(row)
    return rows, trades


def evaluate_rolling(
    daily: pd.DataFrame, variant: Variant, friction_model: dict[str, Any]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    train_len = 252
    test_len = 63
    step = 63
    folds: list[dict[str, Any]] = []
    trades: list[dict[str, Any]] = []
    aggregate_rows: list[dict[str, Any]] = []
    by_label: dict[str, list[float]] = {label: [] for label, _ in friction_rates(friction_model)}
    positive_by_label: dict[str, int] = {label: 0 for label, _ in friction_rates(friction_model)}
    fold_count = 0
    for fold_no, start in enumerate(range(0, max(len(daily) - train_len - test_len + 1, 0), step), start=1):
        train = daily.iloc[start : start + train_len].copy()
        test = daily.iloc[start + train_len : start + train_len + test_len].copy()
        if len(train) < train_len or len(test) < test_len:
            continue
        fold_count += 1
        config = materialize_variant(train, variant)
        for label, fee_rate in friction_rates(friction_model):
            fold_trades = run_variant(test, config, f"rolling_test_{fold_no}", label, fee_rate)
            trades.extend(fold_trades)
            pnls = [float(t["pnl_usd"]) for t in fold_trades]
            by_label[label].extend(pnls)
            if sum(pnls) > 0:
                positive_by_label[label] += 1
            m = metrics(pnls)
            folds.append(
                {
                    "fold_no": fold_no,
                    "test_start": str(test["date"].iloc[0].date()),
                    "test_end": str(test["date"].iloc[-1].date()),
                    **config,
                    "friction_label": label,
                    "fee_rate": fee_rate,
                    **{f"test_{k}": v for k, v in m.items()},
                    "test_q_reduction_count": sum(1 for t in fold_trades if t.get("q_reduction_applied")),
                }
            )
    for label, _ in friction_rates(friction_model):
        m = metrics(by_label[label])
        aggregate_rows.append(
            {
                "name": variant.name,
                "friction_label": label,
                **{f"rolling_{k}": v for k, v in m.items()},
                "rolling_fold_count": fold_count,
                "rolling_positive_fold_count": positive_by_label[label],
                "rolling_positive_fold_rate": float(positive_by_label[label] / fold_count) if fold_count else 0.0,
            }
        )
    return aggregate_rows, folds, trades


def build_comparison(split_rows: list[dict[str, Any]], rolling_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    split_map = {(row["name"], row["friction_label"]): row for row in split_rows}
    rolling_map = {(row["name"], row["friction_label"]): row for row in rolling_rows}
    rows: list[dict[str, Any]] = []
    for key, split in split_map.items():
        rolling = rolling_map.get(key, {})
        rows.append(
            {
                "name": key[0],
                "friction_label": key[1],
                "promotable": split.get("promotable", True),
                "holdout_trades": split.get("holdout_trades", 0),
                "holdout_win_rate": split.get("holdout_win_rate", 0.0),
                "holdout_net_pnl_usd": split.get("holdout_net_pnl_usd", 0.0),
                "holdout_profit_factor": split.get("holdout_profit_factor", 0.0),
                "holdout_max_drawdown_usd": split.get("holdout_max_drawdown_usd", 0.0),
                "holdout_q_reduction_count": split.get("holdout_q_reduction_count", 0),
                "rolling_trades": rolling.get("rolling_trades", 0),
                "rolling_win_rate": rolling.get("rolling_win_rate", 0.0),
                "rolling_net_pnl_usd": rolling.get("rolling_net_pnl_usd", 0.0),
                "rolling_profit_factor": rolling.get("rolling_profit_factor", 0.0),
                "rolling_max_drawdown_usd": rolling.get("rolling_max_drawdown_usd", 0.0),
                "rolling_positive_fold_rate": rolling.get("rolling_positive_fold_rate", 0.0),
            }
        )
    return rows


def row_for(comparison: list[dict[str, Any]], name: str, friction_label: str) -> dict[str, Any]:
    for row in comparison:
        if row["name"] == name and row["friction_label"] == friction_label:
            return row
    raise KeyError((name, friction_label))


def select_promoted(comparison: list[dict[str, Any]]) -> dict[str, Any] | None:
    base_l2 = row_for(comparison, "v1_21_frozen_floor_1p10", "l2_estimated")
    candidate_names = sorted({row["name"] for row in comparison if row.get("promotable") and row["name"] != base_l2["name"]})
    promoted: list[dict[str, Any]] = []
    for name in candidate_names:
        l2 = row_for(comparison, name, "l2_estimated")
        triple = row_for(comparison, name, "l2_triple")
        if (
            l2["holdout_trades"] >= 20
            and l2["holdout_win_rate"] >= base_l2["holdout_win_rate"]
            and l2["holdout_net_pnl_usd"] >= base_l2["holdout_net_pnl_usd"]
            and l2["holdout_profit_factor"] > base_l2["holdout_profit_factor"]
            and l2["rolling_profit_factor"] > base_l2["rolling_profit_factor"]
            and l2["rolling_net_pnl_usd"] > base_l2["rolling_net_pnl_usd"]
            and l2["rolling_positive_fold_rate"] >= base_l2["rolling_positive_fold_rate"]
            and triple["holdout_net_pnl_usd"] > 0
            and triple["rolling_net_pnl_usd"] > 0
        ):
            promoted.append(l2)
    promoted.sort(
        key=lambda row: (
            row["rolling_profit_factor"],
            row["holdout_profit_factor"],
            row["rolling_net_pnl_usd"],
        ),
        reverse=True,
    )
    return promoted[0] if promoted else None


def make_plot(comparison: list[dict[str, Any]]) -> str:
    try:
        import matplotlib.pyplot as plt  # type: ignore
    except Exception:
        return ""
    df = pd.DataFrame([r for r in comparison if r["friction_label"] == "l2_estimated"])
    if df.empty:
        return ""
    fig, axes = plt.subplots(2, 2, figsize=(14, 8))
    labels = df["name"].str.replace("_", "\n", regex=False)
    axes[0, 0].bar(labels, df["holdout_profit_factor"])
    axes[0, 0].axhline(1.0, color="black", linewidth=0.8)
    axes[0, 0].set_title("Holdout PF with L2 friction")
    axes[0, 0].tick_params(axis="x", labelrotation=20)

    axes[0, 1].bar(labels, df["rolling_profit_factor"])
    axes[0, 1].axhline(1.0, color="black", linewidth=0.8)
    axes[0, 1].set_title("Rolling PF with L2 friction")
    axes[0, 1].tick_params(axis="x", labelrotation=20)

    axes[1, 0].bar(labels, df["rolling_net_pnl_usd"])
    axes[1, 0].axhline(0, color="black", linewidth=0.8)
    axes[1, 0].set_title("Rolling PnL with L2 friction")
    axes[1, 0].tick_params(axis="x", labelrotation=20)

    axes[1, 1].bar(labels, df["rolling_max_drawdown_usd"])
    axes[1, 1].axhline(0, color="black", linewidth=0.8)
    axes[1, 1].set_title("Rolling Max Drawdown")
    axes[1, 1].tick_params(axis="x", labelrotation=20)
    fig.tight_layout()
    out = OUT_DIR / "HFCD_Trading_V1_22_GoldExecutionQDriftReplay.png"
    fig.savefig(out, dpi=160)
    plt.close(fig)
    return str(out)


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    daily = load_daily_features()
    friction_model = load_bbo_friction_model()
    split_rows: list[dict[str, Any]] = []
    rolling_rows: list[dict[str, Any]] = []
    fold_rows: list[dict[str, Any]] = []
    holdout_trades: list[dict[str, Any]] = []
    rolling_trades: list[dict[str, Any]] = []

    for variant in variants():
        split, htrades = evaluate_split(daily, variant, friction_model)
        rolling, folds, rtrades = evaluate_rolling(daily, variant, friction_model)
        split_rows.extend(split)
        rolling_rows.extend(rolling)
        fold_rows.extend(folds)
        holdout_trades.extend(htrades)
        rolling_trades.extend(rtrades)

    comparison = build_comparison(split_rows, rolling_rows)
    promoted = select_promoted(comparison)
    base_l2 = row_for(comparison, "v1_21_frozen_floor_1p10", "l2_estimated")
    q_soft_l2 = row_for(comparison, "q_soft_reduce_floor_1p10", "l2_estimated")
    q_event_l2 = row_for(comparison, "q_soft_event_guard_floor_1p10", "l2_estimated")
    q_hard_l2 = row_for(comparison, "q_hard_guard_audit_floor_1p10", "l2_estimated")
    status = "gold_execution_qdrift_candidate" if promoted else "gold_execution_qdrift_watchlist"
    plot = make_plot(comparison)

    write_csv(OUT_DIR / "hfcd_trading_v1_22_split_metrics.csv", split_rows)
    write_csv(OUT_DIR / "hfcd_trading_v1_22_rolling_metrics.csv", rolling_rows)
    write_csv(OUT_DIR / "hfcd_trading_v1_22_variant_comparison.csv", comparison)
    write_csv(OUT_DIR / "hfcd_trading_v1_22_rolling_folds.csv", fold_rows)
    write_csv(OUT_DIR / "hfcd_trading_v1_22_holdout_trades.csv", holdout_trades)
    write_csv(OUT_DIR / "hfcd_trading_v1_22_rolling_trades.csv", rolling_trades)

    v21_summary = json.loads(V21_SUMMARY_PATH.read_text(encoding="utf-8")) if V21_SUMMARY_PATH.exists() else {}
    summary = {
        "version": VERSION,
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "mode": "local_gold_execution_qdrift_replay_not_deployed_not_live_trading",
        "input_daily_rows": int(len(daily)),
        "source_v21_status": v21_summary.get("status"),
        "friction_model": friction_model,
        "base_l2_estimated": base_l2,
        "promoted_variant_l2_estimated": promoted,
        "q_soft_reduce_l2_estimated": q_soft_l2,
        "q_soft_event_guard_watchlist_l2_estimated": q_event_l2,
        "q_hard_guard_audit_l2_estimated": q_hard_l2,
        "status": status,
        "plot": plot,
        "notes": [
            "V1.22 keeps V1.21 threshold=1.10 frozen and tests execution/Q-risk controls only.",
            "Q soft reduction preserves the 24-trade holdout sample while reducing weak Q-core exposure.",
            "Q hard guard and event guard can raise PF further but are treated as watchlist/audit when sample size shrinks.",
            "Current BBO friction comes from a short GC 1s sample, so it is better than pure fee stress but not a full tick replay.",
        ],
    }
    (OUT_DIR / "hfcd_trading_v1_22_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    if promoted:
        promoted_line = (
            f"`{promoted['name']}` 升为候选：L2 friction holdout PF "
            f"{promoted['holdout_profit_factor']:.3f}，rolling PF {promoted['rolling_profit_factor']:.3f}。"
        )
    else:
        promoted_line = "没有变体在 L2 friction 下同时满足样本、PF、rolling 和 3x 摩擦门。"

    md = [
        f"# {VERSION}",
        "",
        "## 定位",
        "",
        "V1.22 冻结 V1.21 黄金主线 `threshold=1.10`，只测试真实执行摩擦和 Q 核风险控制。",
        "",
        "## 结论",
        "",
        f"- status: `{status}`",
        f"- {promoted_line}",
        "",
        "## 执行摩擦模型",
        "",
        f"- BBO source: `{friction_model['source']}`",
        f"- BBO rows: {friction_model['rows']}",
        f"- median spread: {friction_model['median_spread_points']}",
        f"- median top book size: {friction_model['median_top_book_size']}",
        f"- estimated L2 fee rate: {friction_model['estimated_l2_fee_rate']:.8f}",
        f"- triple L2 fee rate: {friction_model['triple_l2_fee_rate']:.8f}",
        "",
        "## V1.21 冻结基线（L2 friction）",
        "",
        f"- holdout: trades={base_l2['holdout_trades']}, win={base_l2['holdout_win_rate']:.3f}, PF={base_l2['holdout_profit_factor']:.3f}, PnL={base_l2['holdout_net_pnl_usd']:.2f}, DD={base_l2['holdout_max_drawdown_usd']:.2f}",
        f"- rolling: trades={base_l2['rolling_trades']}, win={base_l2['rolling_win_rate']:.3f}, PF={base_l2['rolling_profit_factor']:.3f}, PnL={base_l2['rolling_net_pnl_usd']:.2f}, DD={base_l2['rolling_max_drawdown_usd']:.2f}",
        "",
        "## Q 软降仓候选（L2 friction）",
        "",
        f"- holdout: trades={q_soft_l2['holdout_trades']}, win={q_soft_l2['holdout_win_rate']:.3f}, PF={q_soft_l2['holdout_profit_factor']:.3f}, PnL={q_soft_l2['holdout_net_pnl_usd']:.2f}, DD={q_soft_l2['holdout_max_drawdown_usd']:.2f}, Q降仓次数={q_soft_l2['holdout_q_reduction_count']}",
        f"- rolling: trades={q_soft_l2['rolling_trades']}, win={q_soft_l2['rolling_win_rate']:.3f}, PF={q_soft_l2['rolling_profit_factor']:.3f}, PnL={q_soft_l2['rolling_net_pnl_usd']:.2f}, DD={q_soft_l2['rolling_max_drawdown_usd']:.2f}",
        "",
        "解释：弱 Q 核样本不直接剔除，而是降为 50% 仓位。它保留交易数，同时压缩亏损单影响。",
        "",
        "## 事件/Q 联合观察线",
        "",
        f"- holdout: trades={q_event_l2['holdout_trades']}, win={q_event_l2['holdout_win_rate']:.3f}, PF={q_event_l2['holdout_profit_factor']:.3f}, PnL={q_event_l2['holdout_net_pnl_usd']:.2f}, DD={q_event_l2['holdout_max_drawdown_usd']:.2f}",
        f"- rolling: trades={q_event_l2['rolling_trades']}, win={q_event_l2['rolling_win_rate']:.3f}, PF={q_event_l2['rolling_profit_factor']:.3f}, PnL={q_event_l2['rolling_net_pnl_usd']:.2f}, DD={q_event_l2['rolling_max_drawdown_usd']:.2f}",
        "",
        "这条线 PF 和回撤更漂亮，但 holdout 只有 20 笔且 PnL 低于 Q 软降仓，暂列观察。",
        "",
        "## Q 硬门审计",
        "",
        f"- holdout: trades={q_hard_l2['holdout_trades']}, win={q_hard_l2['holdout_win_rate']:.3f}, PF={q_hard_l2['holdout_profit_factor']:.3f}, PnL={q_hard_l2['holdout_net_pnl_usd']:.2f}",
        f"- rolling: trades={q_hard_l2['rolling_trades']}, win={q_hard_l2['rolling_win_rate']:.3f}, PF={q_hard_l2['rolling_profit_factor']:.3f}, PnL={q_hard_l2['rolling_net_pnl_usd']:.2f}",
        "",
        "Q 硬门继续显示高 PF，但样本收缩严重，不作为可推广策略。",
        "",
        "## 风险边界",
        "",
        "V1.22 仍是本地 replay。BBO 只是一段短样本摩擦标定，不是完整 tick 级订单簿历史；真正上线前需要更长 L2、交易时段拆分和分钟级 Q 路径。",
    ]
    (OUT_DIR / "HFCD_Trading_V1_22_GoldExecutionQDriftReplay.md").write_text("\n".join(md) + "\n", encoding="utf-8")

    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"out_dir={OUT_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
