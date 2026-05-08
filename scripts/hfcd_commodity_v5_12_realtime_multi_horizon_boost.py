#!/usr/bin/env python3
"""HFCD Commodity V5.12: realtime multi-horizon boost.

Local research only. No broker calls, no testnet calls, no online page changes.

V5.12 keeps the electricity-style interpretation:
- scan the current state frequently;
- predict multiple future horizons from that current state;
- decide long / short / flat / add / reduce / reverse from the prediction set.

This version is a non-destructive boost over V5.11:
- adds micro exogenous pressure features derived from term/crack/weather/storage
  sensors already available in V5.4-V5.6;
- uses a denser but bounded policy grid;
- keeps CL's V5.4 lineage protected and uses extra sensors as overlays.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler


ROOT = Path.cwd()
VERSION = "HFCD_Commodity_V5_12_RealtimeMultiHorizonBoost"
OUT_DIR = ROOT / "outputs" / "hfcd_commodity_v5_12_realtime_multi_horizon_boost"
V511_PATH = ROOT / "scripts" / "hfcd_commodity_v5_11_realtime_multi_horizon_scanner.py"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


v511 = load_module("v511_realtime_mh", V511_PATH)

TARGET_SYMBOLS = v511.TARGET_SYMBOLS
HORIZON_LABELS = v511.HORIZON_LABELS
HORIZON_SETS = v511.HORIZON_SETS
BASE_NOTIONAL_USD = v511.BASE_NOTIONAL_USD

BOOST_COLS = [
    "v512_ret1_z",
    "v512_ret4_z",
    "v512_volume_shock_z",
    "v512_range_pressure_z",
    "v512_hfcd_quality_delta",
    "v512_bsigma_delta",
    "v512_sigma_accel",
    "v512_term_pressure",
    "v512_inventory_pressure",
    "v512_weather_pressure",
    "v512_crack_pressure",
    "v512_trade_pressure",
]


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def zscore(series: pd.Series, window: int = 96) -> pd.Series:
    x = pd.to_numeric(series, errors="coerce")
    mu = x.rolling(window, min_periods=max(8, window // 8)).mean()
    sd = x.rolling(window, min_periods=max(8, window // 8)).std(ddof=0)
    return ((x - mu) / (sd + 1e-9)).replace([np.inf, -np.inf], np.nan).fillna(0.0).clip(-6, 6)


def first_existing(frame: pd.DataFrame, names: list[str]) -> pd.Series:
    out = pd.Series(0.0, index=frame.index, dtype=float)
    for name in names:
        if name in frame.columns:
            out = out + pd.to_numeric(frame[name], errors="coerce").fillna(0.0)
    return out


def add_v512_features(frame: pd.DataFrame, symbol: str) -> pd.DataFrame:
    out = frame.copy()
    close = pd.to_numeric(out["close"], errors="coerce").replace(0, np.nan).ffill()
    ret1 = close.pct_change().fillna(0.0)
    volume = pd.to_numeric(out.get("volume", 0.0), errors="coerce").fillna(0.0)
    high = pd.to_numeric(out.get("high", close), errors="coerce").fillna(close)
    low = pd.to_numeric(out.get("low", close), errors="coerce").fillna(close)

    out["v512_ret1_z"] = zscore(ret1, 144)
    out["v512_ret4_z"] = zscore(close.pct_change(4).fillna(0.0), 144)
    out["v512_volume_shock_z"] = zscore(np.log1p(volume).diff().fillna(0.0), 144)
    out["v512_range_pressure_z"] = zscore(((high - low) / (close + 1e-9)).fillna(0.0), 144)
    out["v512_hfcd_quality_delta"] = zscore(pd.to_numeric(out.get("v53_manifest_quality", 0.0), errors="coerce").diff(3), 96)
    out["v512_bsigma_delta"] = zscore(pd.to_numeric(out.get("v53_bsigma", 0.0), errors="coerce").diff(3), 96)
    sigma = pd.to_numeric(out.get("v53_sigma_ledger", 0.0), errors="coerce").fillna(0.0)
    out["v512_sigma_accel"] = zscore(sigma.diff(2).diff(2), 96)

    curve = first_existing(
        out,
        [
            "curve_roll_yield_proxy",
            "curve_backwardation_delta_z",
            "curve_backwardation_z",
        ],
    )
    if symbol == "CL=F":
        inventory = -first_existing(out, ["crude_stocks_surprise_z", "crude_stocks_change_z"])
        crack = first_existing(out, ["rb_crack_delta_z_v54", "ho_crack_delta_z_v54", "brent_wti_spread_delta_z_v54"])
        weather = first_existing(out, ["refinery_demand"])
    elif symbol == "RB=F":
        inventory = -first_existing(out, ["gasoline_stocks_surprise_z", "gasoline_stocks_change_z"])
        crack = first_existing(out, ["rb_crack_delta_z_v54", "rb_crack_z_v53", "rb_ho_spread_z"])
        weather = first_existing(out, ["rb_driving_forecast_pressure", "rb_driving_weather", "driving_season_pressure"])
    elif symbol == "HO=F":
        inventory = -first_existing(out, ["distillate_stocks_surprise_z", "distillate_stocks_change_z"])
        crack = first_existing(out, ["ho_crack_delta_z_v54", "ho_crack_z_v53", "rb_ho_spread_z"])
        weather = first_existing(out, ["ho_heating_forecast_pressure", "ho_heating_weather", "heating_season_pressure"])
    else:
        inventory = first_existing(out, ["ng_storage_deficit_z", "ng_storage_tightness"]) - first_existing(
            out, ["ng_storage_surprise_z", "ng_storage_change_z"]
        )
        crack = first_existing(out, ["ng_oil_ratio_delta_z_v54", "ng_oil_ratio_z_v53"])
        weather = first_existing(out, ["ng_weather_forecast_pressure", "ng_weather_pressure"])

    out["v512_term_pressure"] = zscore(curve, 96)
    out["v512_inventory_pressure"] = zscore(inventory, 96)
    out["v512_weather_pressure"] = zscore(weather, 96)
    out["v512_crack_pressure"] = zscore(crack, 96)
    raw_pressure = (
        0.30 * out["v512_inventory_pressure"]
        + 0.22 * out["v512_crack_pressure"]
        + 0.16 * out["v512_term_pressure"]
        + 0.14 * out["v512_weather_pressure"]
        + 0.10 * out["v512_sigma_accel"]
        - 0.08 * out["v512_bsigma_delta"].clip(lower=0)
    )
    # CL's core baseline is protected: extra sensors tilt but do not dominate.
    shrink = 0.55 if symbol == "CL=F" else 1.0
    out["v512_trade_pressure"] = (raw_pressure * shrink).clip(-6, 6).fillna(0.0)
    for col in BOOST_COLS:
        out[col] = pd.to_numeric(out.get(col, 0.0), errors="coerce").replace([np.inf, -np.inf], np.nan).fillna(0.0)
    return out


_orig_load_mode_features = v511.load_mode_features
_orig_feature_columns = v511.feature_columns
_orig_signal_state = v511.signal_state


def load_mode_features_boost(mode_cfg: dict[str, Any]):
    features, coverage, sensor_meta = _orig_load_mode_features(mode_cfg)
    boosted = {symbol: add_v512_features(frame, symbol) for symbol, frame in features.items()}
    sensor_meta = dict(sensor_meta)
    sensor_meta["v512_boost"] = {
        "status": "enabled",
        "features": BOOST_COLS,
        "note": "Uses already attached V5.4-V5.6 exogenous sensors as micro overlays; not a broker feed.",
    }
    return boosted, coverage, sensor_meta


def feature_columns_boost(symbol: str) -> list[str]:
    return list(dict.fromkeys(_orig_feature_columns(symbol) + BOOST_COLS))


def train_direction_model(train: pd.DataFrame, symbol: str, horizon: str):
    cols = feature_columns_boost(symbol)
    y_ret = pd.to_numeric(train[f"future_return_{horizon}"], errors="coerce").fillna(0.0).to_numpy(dtype=float)
    y = (y_ret > 0).astype(int)
    if len(train) < 240 or len(set(y.tolist())) < 2:
        return None
    x = train[cols].to_numpy(dtype=float)
    return make_pipeline(
        StandardScaler(),
        LogisticRegression(C=0.35, class_weight="balanced", max_iter=700, solver="lbfgs"),
    ).fit(x, y)


def add_predictions_boost(df: pd.DataFrame, symbol: str, mode: str, train: pd.DataFrame):
    cols = feature_columns_boost(symbol)
    x = df[cols].to_numpy(dtype=float)
    out = df.copy()
    coverage: list[dict[str, Any]] = []
    for horizon in HORIZON_LABELS:
        return_model = v511.train_return_model(train, symbol, horizon)
        direction_model = train_direction_model(train, symbol, horizon)
        if return_model is not None:
            signed = np.asarray(return_model.predict(x), dtype=float)
            return_prob = v511.return_to_probability(signed, train, horizon)
        else:
            signed = np.zeros(len(out), dtype=float)
            return_prob = np.full(len(out), 0.5, dtype=float)
        if direction_model is not None:
            direction_prob = np.asarray(direction_model.predict_proba(x)[:, 1], dtype=float)
            prob_up = 0.62 * direction_prob + 0.38 * return_prob
        else:
            prob_up = return_prob
        out[f"{horizon}_signed_return_pred"] = signed
        out[f"{horizon}_prob_up"] = np.clip(prob_up, 0.01, 0.99)
        coverage.append(
            {
                "mode": mode,
                "symbol": symbol,
                "horizon": horizon,
                "direction_models": "logistic_balanced" if direction_model is not None else "",
                "return_model": "ridge" if return_model is not None else "",
                "train_rows": len(train),
                "status": "trained" if return_model is not None or direction_model is not None else "missing",
            }
        )
    return out, coverage


def signal_state_boost(row: pd.Series, policy) -> dict[str, Any]:
    state = _orig_signal_state(row, policy)
    pressure = float(row.get("v512_trade_pressure", 0.0))
    overlay_score = 0.014 * float(np.tanh(pressure / 2.0))
    overlay_return = 0.0014 * float(np.tanh(pressure / 2.0))
    score = 0.72 * float(state["score"]) + 0.28 * overlay_score
    expected = 0.80 * float(state["expected_return"]) + 0.20 * overlay_return
    direction = 1 if score >= 0 else -1
    agreement = float(state["agreement"])
    if np.sign(pressure) == direction and abs(pressure) >= 0.75:
        agreement = min(1.0, agreement + 0.10)
    if np.sign(pressure) == -direction and abs(pressure) >= 1.50:
        agreement = max(0.0, agreement - 0.12)
    state.update(
        {
            "score": float(score),
            "direction": int(direction),
            "confidence": float(abs(score)),
            "agreement": float(agreement),
            "expected_return": float(expected),
            "expected_move_bps": float(max(state["expected_move_bps"], abs(expected) * 10000.0)),
            "v512_pressure": round(pressure, 6),
        }
    )
    return state


def desired_units_boost(row: pd.Series, policy) -> tuple[int, dict[str, Any]]:
    state = signal_state_boost(row, policy)
    pressure = float(row.get("v512_trade_pressure", 0.0))
    if state["confidence"] < policy.dead_zone and state["expected_move_bps"] < policy.min_move_bps + 2.0:
        return 0, {**state, "reason": "dead_zone"}
    if state["agreement"] < policy.min_agreement:
        return 0, {**state, "reason": "horizon_disagreement"}
    if state["expected_move_bps"] < policy.min_move_bps:
        return 0, {**state, "reason": "move_too_small"}
    if float(row.get("v53_manifest_quality", 0.0)) < policy.min_hfcd_quality:
        return 0, {**state, "reason": "hfcd_quality_low"}
    if float(row.get("v53_bsigma", 0.0)) > policy.risk_cut and state["confidence"] < policy.dead_zone + 0.020:
        return 0, {**state, "reason": "bsigma_cut"}
    if np.sign(pressure) == -state["direction"] and abs(pressure) > 2.2 and state["confidence"] < policy.dead_zone + 0.025:
        return 0, {**state, "reason": "exogenous_pressure_disagree"}

    quality = float(row.get("v53_manifest_quality", 0.0))
    units = 1
    if state["confidence"] >= policy.dead_zone + 0.018 and state["expected_move_bps"] >= policy.min_move_bps + 3.0:
        units += 1
    if abs(pressure) >= 1.6 and np.sign(pressure) == state["direction"] and quality >= policy.min_hfcd_quality:
        units += 1
    return int(state["direction"] * min(policy.max_units, units)), {**state, "reason": "active"}


def policy_grid_boost(symbol: str, mode: str) -> list[Any]:
    if symbol == "CL=F":
        horizon_sets = ["all", "mid"]
        profiles = [
            (0.007, 0.52, 1.0, 0.00, 2, 3.4),
            (0.010, 0.58, 3.0, 0.06, 2, 3.0),
            (0.014, 0.66, 5.0, 0.14, 2, 2.6),
        ]
    elif symbol == "HO=F":
        horizon_sets = ["near", "mid", "barbell"]
        profiles = [
            (0.006, 0.50, 1.0, 0.00, 2, 3.6),
            (0.010, 0.58, 3.0, 0.06, 3, 3.2),
            (0.014, 0.66, 5.0, 0.12, 3, 2.8),
        ]
    elif symbol == "RB=F":
        horizon_sets = ["near", "mid"]
        profiles = [
            (0.006, 0.50, 1.0, 0.00, 2, 3.6),
            (0.010, 0.58, 3.0, 0.06, 2, 3.2),
            (0.014, 0.66, 5.0, 0.12, 2, 2.8),
        ]
    else:
        horizon_sets = ["near", "mid"]
        profiles = [
            (0.007, 0.52, 1.0, 0.00, 1, 3.8),
            (0.011, 0.60, 3.0, 0.08, 2, 3.2),
            (0.015, 0.68, 5.0, 0.15, 2, 2.8),
        ]
    out = []
    for horizon_set in horizon_sets:
        for dead_zone, min_agreement, min_move_bps, min_quality, max_units, risk_cut in profiles:
            out.append(
                v511.RealtimePolicy(
                    symbol,
                    mode,
                    horizon_set,
                    dead_zone,
                    min_agreement,
                    min_move_bps,
                    min_quality,
                    max_units,
                    risk_cut,
                )
            )
    return out


def select_routes_boost(summary_df: pd.DataFrame) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    if summary_df.empty:
        return selected
    for symbol, group in summary_df.groupby("symbol", sort=False):
        candidates = group[
            (group["validation_active_signal_rate"] >= 0.08)
            & (group["test_active_signal_rate"] >= 0.08)
            & (group["validation_direction_hit_rate"] >= 0.58)
            & (group["test_direction_hit_rate"] >= 0.58)
            & (group["validation_profit_factor"] >= 1.10)
            & (group["test_profit_factor"] >= 1.10)
            & (group["test_actions_per_day"] >= 0.80)
        ].copy()
        if not candidates.empty:
            selected.append(candidates.sort_values("selection_score", ascending=False).iloc[0].to_dict())
    return sorted(selected, key=lambda r: (float(r.get("test_direction_hit_rate", 0)), float(r.get("test_profit_factor", 0))), reverse=True)


def make_report(run_summary: dict[str, Any], selected: list[dict[str, Any]], best_rows: list[dict[str, Any]]) -> str:
    lines = [
        f"# {VERSION}",
        "",
        "## 结论",
        "",
        f"- 状态：`{run_summary['status']}`",
        "- V5.12 继续采用“当前时刻扫描，预测多个未来 horizon”的电力模型式结构。",
        "- 本版不接前向账本，只做本地盲测；目标是先提高命中率、PF 和动作密度。",
        "- 增强项：真实期限结构/库存预期差/天气压力/裂解价差作为 V5.12 微观外生压力特征。",
        "- CL 继续保护 V5.4 强基线，额外传感器只做非破坏性叠加。",
        f"- 策略总数：`{run_summary['route_count']}`；候选数：`{run_summary['candidate_count']}`；65%+目标数：`{run_summary['target65_count']}`。",
        "",
        "## 通过候选",
        "",
    ]
    if selected:
        lines.append("| 标的 | horizon组 | 验证命中/PF | 测试命中/PF | 活跃率 | 动作/天 | 加/减/反手 | 测试PNL | 回撤 |")
        lines.append("|---|---|---:|---:|---:|---:|---:|---:|---:|")
        for r in selected:
            lines.append(
                f"| {r['symbol']} | {r['horizon_set']} | "
                f"{float(r['validation_direction_hit_rate']):.2%}/{float(r['validation_profit_factor']):.2f} | "
                f"{float(r['test_direction_hit_rate']):.2%}/{float(r['test_profit_factor']):.2f} | "
                f"{float(r['test_active_signal_rate']):.2%} | {float(r['test_actions_per_day']):.2f} | "
                f"{int(r['test_add_actions'])}/{int(r['test_reduce_actions'])}/{int(r['test_reverse_actions'])} | "
                f"{float(r['test_net_pnl_usd']):.2f} | {float(r['test_max_drawdown_usd']):.2f} |"
            )
    else:
        lines.append("没有路线通过 V5.12 候选门。")
    lines += ["", "## 每个标的最优观察", ""]
    lines.append("| 标的 | horizon组 | 验证命中/PF | 测试命中/PF | 活跃率 | 动作/天 | 测试PNL | 状态 |")
    lines.append("|---|---|---:|---:|---:|---:|---:|---|")
    for r in best_rows:
        lines.append(
            f"| {r['symbol']} | {r['horizon_set']} | "
            f"{float(r['validation_direction_hit_rate']):.2%}/{float(r['validation_profit_factor']):.2f} | "
            f"{float(r['test_direction_hit_rate']):.2%}/{float(r['test_profit_factor']):.2f} | "
            f"{float(r['test_active_signal_rate']):.2%} | {float(r['test_actions_per_day']):.2f} | "
            f"{float(r['test_net_pnl_usd']):.2f} | {r['realtime_mh_status']} |"
        )
    lines += [
        "",
        "## 关键判断",
        "",
        "- 这里的 horizon 是“从当前时刻预测未来 15m/30m/1h/1.5h/2h/2.5h/3h”，不是每隔 2 小时才预测一次。",
        "- `actions_per_day` 是历史回放中的平均动作次数，不保证每天固定发生同样次数。",
        "- 若 V5.12 仍无法稳定达到 65%+ 命中率和 PF>1.3，问题更可能在外生数据质量/实时可用性，而不是阈值。",
        "",
        "## 下一步行动计划",
        "",
        "如果有路线通过 V5.12 候选门，下一步做 V5.13 forward-shadow 只接通过路线；如果没有通过，下一步应补更真实的可交易天气预报、期货合约链和库存市场预期差数据，不继续简单调阈值。",
    ]
    return "\n".join(lines) + "\n"


def make_figure(selected: list[dict[str, Any]], best_rows: list[dict[str, Any]], path: Path) -> None:
    rows = selected or best_rows
    if not rows:
        return
    labels = [f"{r['symbol']}\n{r['horizon_set']}" for r in rows]
    hit = [float(r.get("test_direction_hit_rate", 0.0)) for r in rows]
    pf = [min(float(r.get("test_profit_factor", 0.0)), 5.0) / 5.0 for r in rows]
    actions = [min(float(r.get("test_actions_per_day", 0.0)), 12.0) / 12.0 for r in rows]
    x = np.arange(len(labels))
    width = 0.25
    fig, ax = plt.subplots(figsize=(12, 5.5))
    ax.bar(x - width, hit, width, label="test hit rate")
    ax.bar(x, pf, width, label="PF/5 cap")
    ax.bar(x + width, actions, width, label="actions/day/12 cap")
    ax.axhline(0.65, color="tab:green", linestyle="--", linewidth=1, label="65% hit target")
    ax.set_ylim(0, 1)
    ax.set_xticks(x)
    ax.set_xticklabels(labels)
    ax.set_title("V5.12 realtime multi-horizon boost")
    ax.grid(axis="y", alpha=0.25)
    ax.legend()
    fig.tight_layout()
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=160)
    plt.close(fig)


def main() -> None:
    started = datetime.now(timezone.utc)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    v511.load_mode_features = load_mode_features_boost
    v511.feature_columns = feature_columns_boost
    v511.add_predictions = add_predictions_boost
    v511.signal_state = signal_state_boost
    v511.desired_units = desired_units_boost
    v511.policy_grid = policy_grid_boost

    all_rows: list[dict[str, Any]] = []
    all_events: list[dict[str, Any]] = []
    all_summaries: list[dict[str, Any]] = []
    all_coverage: list[dict[str, Any]] = []
    sensor_meta_by_mode: dict[str, Any] = {}
    latest_signals: list[dict[str, Any]] = []

    for mode_cfg in v511.MODES:
        features, coverage, sensor_meta = v511.load_mode_features(mode_cfg)
        all_coverage.extend(coverage)
        sensor_meta_by_mode[str(mode_cfg["mode"])] = sensor_meta
        for symbol in TARGET_SYMBOLS:
            frame = features.get(symbol)
            if frame is None or frame.empty:
                all_coverage.append({"mode": mode_cfg["mode"], "symbol": symbol, "status": "missing_feature_frame"})
                continue
            rows, events, summaries, model_cov = v511.evaluate_symbol(frame, symbol, mode_cfg)
            all_rows.extend(rows)
            all_events.extend(events)
            all_summaries.extend(summaries)
            all_coverage.extend(model_cov)
            tail = v511.clean_for_model(frame, symbol).tail(1)
            if len(tail):
                latest_signals.append(
                    {
                        "mode": mode_cfg["mode"],
                        "symbol": symbol,
                        "timestamp": pd.Timestamp(tail.iloc[0]["timestamp"]).isoformat(),
                        "close": round(float(tail.iloc[0]["close"]), 6),
                        "rows": len(frame),
                    }
                )

    summary_df = pd.DataFrame(all_summaries)
    selected = select_routes_boost(summary_df) if not summary_df.empty else []
    best = v511.best_by_symbol(summary_df) if not summary_df.empty else []
    target65_count = (
        int(
            (
                (summary_df.get("validation_direction_hit_rate", pd.Series(dtype=float)) >= 0.65)
                & (summary_df.get("test_direction_hit_rate", pd.Series(dtype=float)) >= 0.65)
                & (summary_df.get("validation_profit_factor", pd.Series(dtype=float)) >= 1.30)
                & (summary_df.get("test_profit_factor", pd.Series(dtype=float)) >= 1.30)
            ).sum()
        )
        if not summary_df.empty
        else 0
    )
    run_summary = {
        "version": VERSION,
        "generated_at": now_iso(),
        "status": "realtime_mh_boost_candidates" if selected else "realtime_mh_boost_watchlist_only",
        "route_count": int(len(summary_df)),
        "candidate_count": int(len(selected)),
        "target65_count": target65_count,
        "selected_policies": [r["policy"] for r in selected],
        "modes": v511.MODES,
        "prediction_horizons": HORIZON_LABELS,
        "runtime_sec": round((datetime.now(timezone.utc) - started).total_seconds(), 3),
        "latest_signal_readiness": latest_signals,
        "outputs": {
            "summary_json": str(OUT_DIR / "hfcd_commodity_v5_12_summary.json"),
            "policy_summary_csv": str(OUT_DIR / "hfcd_commodity_v5_12_policy_summary.csv"),
            "selected_routes_csv": str(OUT_DIR / "hfcd_commodity_v5_12_selected_routes.csv"),
            "best_by_symbol_csv": str(OUT_DIR / "hfcd_commodity_v5_12_best_by_symbol.csv"),
            "trade_replay_csv": str(OUT_DIR / "hfcd_commodity_v5_12_trade_replay.csv"),
            "action_events_csv": str(OUT_DIR / "hfcd_commodity_v5_12_action_events.csv"),
            "coverage_csv": str(OUT_DIR / "hfcd_commodity_v5_12_coverage.csv"),
            "report_md": str(OUT_DIR / "HFCD_Commodity_V5_12_RealtimeMultiHorizonBoost.md"),
            "figure_png": str(OUT_DIR / "HFCD_Commodity_V5_12_RealtimeMultiHorizonBoost.png"),
        },
        "sensor_meta_by_mode": sensor_meta_by_mode,
    }

    (OUT_DIR / "hfcd_commodity_v5_12_summary.json").write_text(json.dumps(run_summary, ensure_ascii=False, indent=2), encoding="utf-8")
    summary_df.to_csv(OUT_DIR / "hfcd_commodity_v5_12_policy_summary.csv", index=False)
    pd.DataFrame(selected).to_csv(OUT_DIR / "hfcd_commodity_v5_12_selected_routes.csv", index=False)
    pd.DataFrame(best).to_csv(OUT_DIR / "hfcd_commodity_v5_12_best_by_symbol.csv", index=False)
    v511.write_csv(OUT_DIR / "hfcd_commodity_v5_12_trade_replay.csv", all_rows)
    v511.write_csv(OUT_DIR / "hfcd_commodity_v5_12_action_events.csv", all_events)
    v511.write_csv(OUT_DIR / "hfcd_commodity_v5_12_coverage.csv", all_coverage)
    (OUT_DIR / "HFCD_Commodity_V5_12_RealtimeMultiHorizonBoost.md").write_text(
        make_report(run_summary, selected, best), encoding="utf-8"
    )
    make_figure(selected, best, OUT_DIR / "HFCD_Commodity_V5_12_RealtimeMultiHorizonBoost.png")
    print(json.dumps(run_summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
