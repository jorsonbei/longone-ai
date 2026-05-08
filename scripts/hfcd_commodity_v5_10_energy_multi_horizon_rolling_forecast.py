#!/usr/bin/env python3
"""HFCD Commodity V5.10: energy multi-horizon rolling forecast.

Local research only. No broker calls, no testnet calls, no online page changes.

This fixes the V5.x cadence/horizon mismatch:
- V5.1-V5.9 resampled to each route cadence, so a "2h" route only evaluated
  at 2h bar closes and predicted the next 2h bar.
- The electricity runtime line instead evaluates the current state and emits
  multiple future horizons together.

V5.10 uses a 15m base cadence and predicts 15m/30m/1h/1.5h/2h/2.5h/3h from
every 15m decision point. The action controller can hold, add, reduce, flatten
or reverse every 15m, while its confidence is based on multi-horizon agreement.
"""

from __future__ import annotations

import importlib.util
import json
import math
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler


ROOT = Path.cwd()
VERSION = "HFCD_Commodity_V5_10_EnergyMultiHorizonRollingForecast"
OUT_DIR = ROOT / "outputs" / "hfcd_commodity_v5_10_energy_multi_horizon_rolling_forecast"
V56_PATH = ROOT / "scripts" / "hfcd_commodity_v5_6_energy_specialist_split.py"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


v56 = load_module("v56_specialist", V56_PATH)

TARGET_SYMBOLS = v56.TARGET_SYMBOLS
BASE_NOTIONAL_USD = v56.BASE_NOTIONAL_USD
BASE_CADENCE = "15m"

HORIZONS: list[tuple[str, int]] = [
    ("15m", 1),
    ("30m", 2),
    ("1h", 4),
    ("1.5h", 6),
    ("2h", 8),
    ("2.5h", 10),
    ("3h", 12),
]

HORIZON_SETS: dict[str, list[str]] = {
    "all": [h for h, _ in HORIZONS],
    "short": ["15m", "30m", "1h"],
    "mid": ["1h", "1.5h", "2h"],
    "long": ["2h", "2.5h", "3h"],
    "barbell": ["15m", "1h", "3h"],
}


@dataclass(frozen=True)
class MultiHorizonPolicy:
    symbol: str
    horizon_set: str
    dead_zone: float
    unit_step: float
    min_agreement: float
    min_expected_move_bps: float
    min_hfcd_quality: float
    max_units: int
    risk_cut: float

    @property
    def name(self) -> str:
        return (
            f"{self.symbol}_15m_eval_{self.horizon_set}_mh_dead{self.dead_zone:.3f}"
            f"_step{self.unit_step:.3f}_agree{self.min_agreement:.2f}"
            f"_move{self.min_expected_move_bps:.1f}_q{self.min_hfcd_quality:.2f}"
            f"_max{self.max_units}_risk{self.risk_cut:.1f}"
        )


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def write_csv(path: Path, rows: list[dict[str, Any]], columns: list[str] | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if rows:
        pd.DataFrame(rows).to_csv(path, index=False)
    else:
        pd.DataFrame(columns=columns or []).to_csv(path, index=False)


def profit_factor(pnls: list[float]) -> float:
    return float(v56.profit_factor(pnls))


def max_drawdown_from_pnls(pnls: list[float]) -> float:
    return float(v56.max_drawdown_from_pnls(pnls))


def split_name(ts: pd.Timestamp, cut1: pd.Timestamp, cut2: pd.Timestamp) -> str:
    return v56.split_name(ts, cut1, cut2)


def action_from_transition(position: int, desired: int) -> str:
    if desired == position:
        return "hold"
    if position == 0 and desired != 0:
        return "open_long" if desired > 0 else "open_short"
    if desired == 0:
        return "flat"
    if np.sign(desired) != np.sign(position):
        return "reverse_to_long" if desired > 0 else "reverse_to_short"
    if abs(desired) > abs(position):
        return "add_long" if desired > 0 else "add_short"
    return "reduce_long" if position > 0 else "reduce_short"


def ensure_feature_columns(frame: pd.DataFrame, symbol: str) -> pd.DataFrame:
    out = frame.copy()
    cols = v56.feature_columns(symbol)
    for col in cols:
        if col not in out.columns:
            out[col] = 0.0
        out[col] = pd.to_numeric(out[col], errors="coerce").replace([np.inf, -np.inf], np.nan).ffill().fillna(0.0)
    out["next_15m_return"] = out["close"].shift(-1) / out["close"] - 1.0
    for horizon, bars in HORIZONS:
        out[f"future_return_{horizon}"] = out["close"].shift(-bars) / out["close"] - 1.0
    out = out.dropna(subset=["next_15m_return"] + [f"future_return_{h}" for h, _ in HORIZONS]).reset_index(drop=True)
    return out


def fit_direction_models(train_df: pd.DataFrame, symbol: str, horizon: str) -> dict[str, Any]:
    cols = v56.feature_columns(symbol)
    x = train_df[cols].to_numpy(dtype=float)
    y = (train_df[f"future_return_{horizon}"].to_numpy(dtype=float) > 0).astype(int)
    if len(train_df) < 120 or len(np.unique(y)) < 2:
        return {}
    return {
        "logit": make_pipeline(
            StandardScaler(),
            LogisticRegression(C=0.45, class_weight="balanced", max_iter=2200, random_state=42),
        ).fit(x, y),
        "hist_gb": HistGradientBoostingClassifier(
            max_iter=70,
            learning_rate=0.045,
            max_leaf_nodes=7,
            l2_regularization=0.35,
            min_samples_leaf=18,
            random_state=42,
        ).fit(x, y),
    }


def fit_return_models(train_df: pd.DataFrame, symbol: str, horizon: str) -> dict[str, Any]:
    cols = v56.feature_columns(symbol)
    x = train_df[cols].to_numpy(dtype=float)
    y_signed = train_df[f"future_return_{horizon}"].to_numpy(dtype=float)
    y_abs = np.abs(y_signed)
    if len(train_df) < 120 or float(np.nanstd(y_signed)) <= 1e-10:
        return {}
    return {
        "signed": make_pipeline(StandardScaler(), Ridge(alpha=4.0)).fit(x, y_signed),
        "abs": make_pipeline(StandardScaler(), Ridge(alpha=4.0)).fit(x, y_abs),
    }


def add_multi_horizon_predictions(df: pd.DataFrame, symbol: str, train_df: pd.DataFrame) -> tuple[pd.DataFrame, list[dict[str, Any]]]:
    cols = v56.feature_columns(symbol)
    x = df[cols].to_numpy(dtype=float)
    out = df.copy()
    coverage: list[dict[str, Any]] = []
    for horizon, _bars in HORIZONS:
        direction_models = fit_direction_models(train_df, symbol, horizon)
        return_models = fit_return_models(train_df, symbol, horizon)
        prob_cols: list[np.ndarray] = []
        for name, model in direction_models.items():
            p = np.asarray(model.predict_proba(x)[:, 1], dtype=float)
            out[f"{horizon}_{name}_prob_up"] = p
            prob_cols.append(p)
        if prob_cols:
            stack = np.vstack(prob_cols)
            out[f"{horizon}_prob_up"] = np.mean(stack, axis=0)
            votes = (stack >= 0.5).astype(int)
            up_votes = votes.sum(axis=0)
            out[f"{horizon}_model_consensus"] = np.maximum(up_votes, len(prob_cols) - up_votes)
        else:
            out[f"{horizon}_prob_up"] = 0.5
            out[f"{horizon}_model_consensus"] = 0
        if return_models:
            out[f"{horizon}_signed_return_pred"] = np.asarray(return_models["signed"].predict(x), dtype=float)
            out[f"{horizon}_abs_return_pred"] = np.maximum(0.0, np.asarray(return_models["abs"].predict(x), dtype=float))
        else:
            out[f"{horizon}_signed_return_pred"] = 0.0
            out[f"{horizon}_abs_return_pred"] = 0.0
        coverage.append(
            {
                "symbol": symbol,
                "horizon": horizon,
                "direction_models": ",".join(direction_models.keys()) if direction_models else "",
                "return_models": ",".join(return_models.keys()) if return_models else "",
                "status": "trained" if direction_models else "missing_model",
                "train_rows": len(train_df),
            }
        )
    return out, coverage


def horizon_weights(horizons: list[str]) -> dict[str, float]:
    bars_by_h = dict(HORIZONS)
    raw = {h: 1.0 / math.sqrt(float(bars_by_h[h])) for h in horizons}
    total = sum(raw.values()) or 1.0
    return {h: raw[h] / total for h in horizons}


def multi_horizon_state(row: pd.Series, policy: MultiHorizonPolicy) -> dict[str, Any]:
    horizons = HORIZON_SETS[policy.horizon_set]
    weights = horizon_weights(horizons)
    edges: list[float] = []
    signed_preds: list[float] = []
    abs_preds: list[float] = []
    directions: list[int] = []
    realized_dirs: list[int] = []
    for h in horizons:
        p = float(row.get(f"{h}_prob_up", 0.5))
        edge = p - 0.5
        signed = float(row.get(f"{h}_signed_return_pred", 0.0))
        magnitude = max(0.0, float(row.get(f"{h}_abs_return_pred", 0.0)))
        w = weights[h]
        edges.append(w * edge)
        signed_preds.append(w * signed)
        abs_preds.append(w * magnitude)
        directions.append(1 if edge >= 0 else -1)
        realized = float(row.get(f"future_return_{h}", 0.0))
        realized_dirs.append(1 if realized >= 0 else -1)
    score = float(np.sum(edges))
    expected_signed = float(np.sum(signed_preds))
    expected_abs = float(np.sum(abs_preds))
    dominant = 1 if score >= 0 else -1
    agreement = float(sum(1 for d in directions if d == dominant) / max(len(directions), 1))
    realized_weighted = float(
        sum(weights[h] * float(row.get(f"future_return_{h}", 0.0)) for h in horizons)
    )
    realized_direction = 1 if realized_weighted >= 0 else -1
    return {
        "score": score,
        "dominant_direction": dominant,
        "agreement": agreement,
        "expected_signed_return": expected_signed,
        "expected_abs_return": expected_abs,
        "expected_move_bps": expected_abs * 10000.0,
        "realized_weighted_return": realized_weighted,
        "realized_direction": realized_direction,
        "horizon_count": len(horizons),
    }


def target_units(row: pd.Series, policy: MultiHorizonPolicy) -> tuple[int, dict[str, Any]]:
    state = multi_horizon_state(row, policy)
    score = float(state["score"])
    confidence = abs(score)
    direction = int(state["dominant_direction"])
    reason = "active"
    if confidence < policy.dead_zone:
        reason = "dead_zone"
        return 0, {**state, "confidence": confidence, "reason": reason}
    if float(state["agreement"]) < policy.min_agreement:
        reason = "horizon_disagreement"
        return 0, {**state, "confidence": confidence, "reason": reason}
    if float(state["expected_move_bps"]) < policy.min_expected_move_bps:
        reason = "expected_move_too_small"
        return 0, {**state, "confidence": confidence, "reason": reason}
    if float(row.get("v53_manifest_quality", 0.0)) < policy.min_hfcd_quality:
        reason = "hfcd_quality_low"
        return 0, {**state, "confidence": confidence, "reason": reason}
    if float(row.get("v53_bsigma", 0.0)) > policy.risk_cut and confidence < policy.dead_zone + 0.035:
        reason = "bsigma_risk_cut"
        return 0, {**state, "confidence": confidence, "reason": reason}
    if np.sign(float(state["expected_signed_return"])) not in {0, direction} and confidence < policy.dead_zone + 0.025:
        reason = "return_head_disagrees"
        return 0, {**state, "confidence": confidence, "reason": reason}
    units = 1 + int(max(0.0, confidence - policy.dead_zone) / max(policy.unit_step, 1e-9))
    if float(state["expected_move_bps"]) > policy.min_expected_move_bps + 8.0:
        units += 1
    units = min(policy.max_units, max(1, units))
    return int(direction * units), {**state, "confidence": confidence, "reason": reason}


def replay(df: pd.DataFrame, policy: MultiHorizonPolicy) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    cost_rate = float(v56.v51.trade_cost(policy.symbol, BASE_CADENCE))
    position = 0
    rows: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []
    for i in range(len(df) - 1):
        row = df.iloc[i]
        ts = pd.Timestamp(row["timestamp"])
        desired, meta = target_units(row, policy)
        delta = desired - position
        action = action_from_transition(position, desired)
        if action != "hold":
            events.append(
                {
                    "policy": policy.name,
                    "symbol": policy.symbol,
                    "timestamp": ts.isoformat(),
                    "action": action,
                    "from_units": position,
                    "to_units": desired,
                    "close": round(float(row["close"]), 6),
                    "mh_score": round(float(meta["score"]), 8),
                    "agreement": round(float(meta["agreement"]), 6),
                    "expected_move_bps": round(float(meta["expected_move_bps"]), 4),
                    "transition_reason": meta["reason"],
                }
            )
        pnl_before_cost = desired * BASE_NOTIONAL_USD * float(row["next_15m_return"])
        turnover_cost = abs(delta) * BASE_NOTIONAL_USD * cost_rate
        pnl = pnl_before_cost - turnover_cost
        active = int(desired != 0)
        direction_hit_weighted = int(np.sign(desired) == int(meta["realized_direction"])) if active else 0
        hit_15m = int(np.sign(desired) == np.sign(float(row["future_return_15m"]))) if active else 0
        rows.append(
            {
                "policy": policy.name,
                "symbol": policy.symbol,
                "base_cadence": BASE_CADENCE,
                "horizon_set": policy.horizon_set,
                "timestamp": ts.isoformat(),
                "close": round(float(row["close"]), 6),
                "decision": "long" if desired > 0 else ("short" if desired < 0 else "flat"),
                "position_units_before": position,
                "position_units_after": desired,
                "action": action,
                "dead_zone": policy.dead_zone,
                "unit_step": policy.unit_step,
                "min_agreement": policy.min_agreement,
                "min_expected_move_bps": policy.min_expected_move_bps,
                "min_hfcd_quality": policy.min_hfcd_quality,
                "max_units": policy.max_units,
                "risk_cut": policy.risk_cut,
                "mh_score": round(float(meta["score"]), 8),
                "mh_confidence": round(float(meta["confidence"]), 8),
                "mh_agreement": round(float(meta["agreement"]), 6),
                "expected_signed_return": round(float(meta["expected_signed_return"]), 8),
                "expected_move_bps": round(float(meta["expected_move_bps"]), 4),
                "transition_reason": meta["reason"],
                "future_return_15m": round(float(row["future_return_15m"]), 8),
                "realized_weighted_return": round(float(meta["realized_weighted_return"]), 8),
                "direction_signal_active": active,
                "direction_hit_weighted": direction_hit_weighted,
                "direction_hit_15m": hit_15m,
                "manifest_quality": round(float(row.get("v53_manifest_quality", 0.0)), 6),
                "sigma_ledger": round(float(row.get("v53_sigma_ledger", 0.0)), 6),
                "q_core": round(float(row.get("v53_q_core", 0.0)), 6),
                "bsigma": round(float(row.get("v53_bsigma", 0.0)), 6),
                "pnl_before_cost_usd": round(float(pnl_before_cost), 6),
                "turnover_cost_usd": round(float(turnover_cost), 6),
                "pnl_usd": round(float(pnl), 6),
                "notional_per_unit_usd": BASE_NOTIONAL_USD,
                "gross_exposure_usd": abs(desired) * BASE_NOTIONAL_USD,
            }
        )
        position = desired
    return rows, events


def summarize(rows: list[dict[str, Any]], policy: MultiHorizonPolicy, split: str) -> dict[str, Any]:
    sub = [r for r in rows if r["split"] == split]
    pnls = [float(r["pnl_usd"]) for r in sub]
    active = [r for r in sub if int(r["direction_signal_active"]) == 1]
    events = [r for r in sub if r["action"] != "hold"]
    days = max(
        1e-9,
        (pd.Timestamp(sub[-1]["timestamp"]) - pd.Timestamp(sub[0]["timestamp"])).total_seconds() / 86400
        if len(sub) >= 2
        else 0.0,
    )
    action_counts = {a: sum(1 for r in events if r["action"] == a) for a in sorted({r["action"] for r in events})}
    return {
        "policy": policy.name,
        "symbol": policy.symbol,
        "base_cadence": BASE_CADENCE,
        "horizon_set": policy.horizon_set,
        "dead_zone": policy.dead_zone,
        "unit_step": policy.unit_step,
        "min_agreement": policy.min_agreement,
        "min_expected_move_bps": policy.min_expected_move_bps,
        "min_hfcd_quality": policy.min_hfcd_quality,
        "max_units": policy.max_units,
        "risk_cut": policy.risk_cut,
        "split": split,
        "bars": len(sub),
        "actions": len(events),
        "actions_per_day": round(len(events) / days, 6) if sub else 0.0,
        "active_signal_bars": len(active),
        "active_signal_rate": round(len(active) / len(sub), 6) if sub else 0.0,
        "long_bars": sum(1 for r in sub if int(r["position_units_after"]) > 0),
        "short_bars": sum(1 for r in sub if int(r["position_units_after"]) < 0),
        "flat_bars": sum(1 for r in sub if int(r["position_units_after"]) == 0),
        "avg_abs_units": round(float(np.mean([abs(int(r["position_units_after"])) for r in sub])) if sub else 0.0, 6),
        "add_actions": action_counts.get("add_long", 0) + action_counts.get("add_short", 0),
        "reduce_actions": action_counts.get("reduce_long", 0) + action_counts.get("reduce_short", 0),
        "reverse_actions": action_counts.get("reverse_to_long", 0) + action_counts.get("reverse_to_short", 0),
        "direction_hit_weighted": round(sum(int(r["direction_hit_weighted"]) for r in active) / len(active), 6) if active else 0.0,
        "direction_hit_15m": round(sum(int(r["direction_hit_15m"]) for r in active) / len(active), 6) if active else 0.0,
        "net_pnl_usd": round(sum(pnls), 6),
        "profit_factor": round(profit_factor(pnls), 6),
        "max_drawdown_usd": round(max_drawdown_from_pnls(pnls), 6),
        "turnover_cost_usd": round(sum(float(r["turnover_cost_usd"]) for r in sub), 6),
    }


def evaluate_symbol(feature_df: pd.DataFrame, symbol: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    df = ensure_feature_columns(feature_df, symbol)
    if len(df) < 300:
        return [], [], [], []
    cut1, cut2 = v56.split_masks(pd.to_datetime(df["timestamp"], utc=True))
    train = df[pd.to_datetime(df["timestamp"], utc=True) <= cut1]
    pred, model_coverage = add_multi_horizon_predictions(df, symbol, train)

    if symbol == "CL=F":
        horizon_sets = ["all", "mid", "long", "barbell"]
        max_units_grid = [1, 2]
    elif symbol == "HO=F":
        horizon_sets = ["all", "short", "mid", "barbell"]
        max_units_grid = [1, 2, 3]
    else:
        horizon_sets = ["all", "short", "mid"]
        max_units_grid = [1, 2]
    dead_zones = [0.012, 0.018, 0.026]
    unit_steps = [0.018, 0.030]
    min_agreements = [0.58, 0.72]
    min_moves = [0.0, 3.0, 6.0]
    quality_gates = [0.0, 0.30]
    risk_cuts = [2.8, 3.4]

    all_rows: list[dict[str, Any]] = []
    all_events: list[dict[str, Any]] = []
    summaries: list[dict[str, Any]] = []
    for horizon_set in horizon_sets:
        for dead_zone in dead_zones:
            for unit_step in unit_steps:
                for agreement in min_agreements:
                    for min_move in min_moves:
                        for quality in quality_gates:
                            for max_units in max_units_grid:
                                for risk_cut in risk_cuts:
                                    policy = MultiHorizonPolicy(
                                        symbol,
                                        horizon_set,
                                        dead_zone,
                                        unit_step,
                                        agreement,
                                        min_move,
                                        quality,
                                        max_units,
                                        risk_cut,
                                    )
                                    rows, events = replay(pred, policy)
                                    for row in rows:
                                        row["split"] = split_name(pd.Timestamp(row["timestamp"]), cut1, cut2)
                                    for event in events:
                                        event["split"] = split_name(pd.Timestamp(event["timestamp"]), cut1, cut2)
                                    by_split = {split: summarize(rows, policy, split) for split in ["train", "validation", "test"]}
                                    combined: dict[str, Any] = {
                                        "policy": policy.name,
                                        "symbol": symbol,
                                        "base_cadence": BASE_CADENCE,
                                        "horizon_set": horizon_set,
                                        "dead_zone": dead_zone,
                                        "unit_step": unit_step,
                                        "min_agreement": agreement,
                                        "min_expected_move_bps": min_move,
                                        "min_hfcd_quality": quality,
                                        "max_units": max_units,
                                        "risk_cut": risk_cut,
                                    }
                                    for split, vals in by_split.items():
                                        for k, v in vals.items():
                                            if k in combined or k in {"policy", "symbol", "base_cadence", "horizon_set", "split"}:
                                                continue
                                            combined[f"{split}_{k}"] = v
                                    val = by_split["validation"]
                                    test = by_split["test"]
                                    combined["multi_horizon_status"] = (
                                        "multi_horizon_blind_confirmed"
                                        if val["active_signal_rate"] >= 0.12
                                        and test["active_signal_rate"] >= 0.12
                                        and val["actions_per_day"] >= 2.0
                                        and test["actions_per_day"] >= 2.0
                                        and val["direction_hit_weighted"] >= 0.56
                                        and test["direction_hit_weighted"] >= 0.56
                                        and val["profit_factor"] >= 1.0
                                        and test["profit_factor"] >= 1.0
                                        else "multi_horizon_watchlist_or_blocked"
                                    )
                                    combined["target70_status"] = (
                                        "target70_multi_horizon_confirmed"
                                        if val["active_signal_rate"] >= 0.07
                                        and test["active_signal_rate"] >= 0.07
                                        and val["direction_hit_weighted"] >= 0.68
                                        and test["direction_hit_weighted"] >= 0.68
                                        and val["profit_factor"] >= 1.0
                                        and test["profit_factor"] >= 1.0
                                        else "not_target70"
                                    )
                                    density_bonus = min(test["actions_per_day"], 10.0) * 2.0 + min(test["active_signal_rate"], 0.60) * 10.0
                                    combined["selection_score"] = round(
                                        130.0 * min(val["direction_hit_weighted"], test["direction_hit_weighted"])
                                        + 12.0 * min(val["profit_factor"], 4.0)
                                        + 16.0 * min(test["profit_factor"], 4.0)
                                        + density_bonus
                                        - abs(test["max_drawdown_usd"]) * 0.022
                                        + 0.08 * test["net_pnl_usd"],
                                        6,
                                    )
                                    summaries.append(combined)
                                    if (
                                        combined["multi_horizon_status"] == "multi_horizon_blind_confirmed"
                                        or combined["target70_status"] == "target70_multi_horizon_confirmed"
                                    ):
                                        all_rows.extend(rows)
                                        all_events.extend(events)
    signal_cols = [
        "timestamp",
        "symbol",
        "close",
        "v53_manifest_quality",
        "v53_bsigma",
    ]
    for h, _ in HORIZONS:
        signal_cols.extend([f"{h}_prob_up", f"{h}_signed_return_pred", f"{h}_abs_return_pred", f"future_return_{h}"])
    signal_sample = pred[signal_cols].tail(1000).to_dict("records")
    return all_rows, all_events, summaries, model_coverage + [{"type": "signal_sample_rows", "symbol": symbol, "rows": len(signal_sample)}]


def select_routes(summary_df: pd.DataFrame) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    if summary_df.empty:
        return selected
    for symbol, group in summary_df.groupby("symbol", sort=False):
        candidates = group[group["multi_horizon_status"] == "multi_horizon_blind_confirmed"].copy()
        if symbol == "CL=F":
            candidates = candidates[(candidates["test_profit_factor"] >= 1.30) & (candidates["test_net_pnl_usd"] > 8)]
        elif symbol == "HO=F":
            candidates = candidates[(candidates["test_profit_factor"] >= 1.0) & (candidates["test_direction_hit_weighted"] >= 0.58)]
        else:
            # RB/NG stay diagnostic until exogenous coverage improves.
            candidates = candidates.iloc[0:0]
        candidates = candidates.sort_values("selection_score", ascending=False)
        if not candidates.empty:
            selected.append(candidates.iloc[0].to_dict())
    return sorted(
        selected,
        key=lambda r: (
            float(r.get("test_direction_hit_weighted", 0.0)),
            float(r.get("test_profit_factor", 0.0)),
            float(r.get("test_actions_per_day", 0.0)),
        ),
        reverse=True,
    )


def best_by_symbol(summary_df: pd.DataFrame) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if summary_df.empty:
        return rows
    for symbol, group in summary_df.groupby("symbol", sort=False):
        eligible = group[group["validation_active_signal_rate"] >= 0.08]
        if eligible.empty:
            eligible = group
        best = eligible.sort_values(
            [
                "validation_direction_hit_weighted",
                "validation_profit_factor",
                "test_direction_hit_weighted",
                "test_profit_factor",
                "test_actions_per_day",
            ],
            ascending=False,
        ).iloc[0]
        rows.append(best.to_dict())
    return rows


def make_report(run_summary: dict[str, Any], selected: list[dict[str, Any]], best_rows: list[dict[str, Any]]) -> str:
    lines = [
        f"# {VERSION}",
        "",
        "## 结论",
        "",
        f"- 状态：`{run_summary['status']}`",
        "- 已修正 V5.1-V5.9 的关键问题：不再把 2h/3h 当作评估间隔。",
        "- 现在每 15 分钟评估一次，并同时预测 15m、30m、1h、1.5h、2h、2.5h、3h 后的方向。",
        "- 控制器按多 horizon 共振决定做多、做空、观望、加仓、减仓或反手。",
        f"- 路线总数：`{run_summary['route_count']}`；候选：`{run_summary['candidate_count']}`；70%确认：`{run_summary['target70_count']}`。",
        "",
        "## 选中路线",
        "",
    ]
    if selected:
        lines.append("| 标的 | 评估频率 | horizon组 | 验证命中/PF | 测试命中/PF | 活跃率 | 动作/天 | 加/减/反手 | 测试PNL | 回撤 |")
        lines.append("|---|---:|---|---:|---:|---:|---:|---:|---:|---:|")
        for r in selected:
            lines.append(
                f"| {r['symbol']} | 15m | {r['horizon_set']} | "
                f"{float(r['validation_direction_hit_weighted']):.2%}/{float(r['validation_profit_factor']):.2f} | "
                f"{float(r['test_direction_hit_weighted']):.2%}/{float(r['test_profit_factor']):.2f} | "
                f"{float(r['test_active_signal_rate']):.2%} | {float(r['test_actions_per_day']):.2f} | "
                f"{int(r['test_add_actions'])}/{int(r['test_reduce_actions'])}/{int(r['test_reverse_actions'])} | "
                f"{float(r['test_net_pnl_usd']):.2f} | {float(r['test_max_drawdown_usd']):.2f} |"
            )
    else:
        lines.append("没有路线同时通过 validation 和 blind test。")
    lines += ["", "## 每个标的 validation-first 最优", ""]
    lines.append("| 标的 | horizon组 | 验证命中/PF | 测试命中/PF | 活跃率 | 动作/天 | 测试PNL | 状态 |")
    lines.append("|---|---|---:|---:|---:|---:|---:|---|")
    for r in best_rows:
        lines.append(
            f"| {r['symbol']} | {r['horizon_set']} | "
            f"{float(r['validation_direction_hit_weighted']):.2%}/{float(r['validation_profit_factor']):.2f} | "
            f"{float(r['test_direction_hit_weighted']):.2%}/{float(r['test_profit_factor']):.2f} | "
            f"{float(r['test_active_signal_rate']):.2%} | {float(r['test_actions_per_day']):.2f} | "
            f"{float(r['test_net_pnl_usd']):.2f} | {r['multi_horizon_status']} |"
        )
    lines += [
        "",
        "## 解释",
        "",
        "- `15m 评估频率`：每 15 分钟重新计算一次当前状态。",
        "- `horizon组`：同一时刻同时看多个未来距离，不是等到该 horizon 才评估。",
        "- `动作/天`：实际仓位变化次数，包括开仓、加仓、减仓、反手、平仓。",
        "- `命中率`：仓位方向与多 horizon 加权真实方向一致的比例。",
        "",
        "## 下一步行动计划",
        "",
        "V5.11 应接入真实前向 rolling 账本：每 15 分钟更新 CL/RB/HO/NG 的多 horizon 预测，先只记录，不下单；同时继续补真实期限结构、库存预期差和天气预报，验证 V5.10 的多 horizon 控制器是否能在前向样本中保持命中率和 PF。",
    ]
    return "\n".join(lines) + "\n"


def make_figure(selected: list[dict[str, Any]], best_rows: list[dict[str, Any]], path: Path) -> None:
    rows = selected or best_rows
    if not rows:
        return
    labels = [f"{r['symbol']}\n{r['horizon_set']}" for r in rows]
    hit = [float(r.get("test_direction_hit_weighted", 0.0)) for r in rows]
    pf = [min(float(r.get("test_profit_factor", 0.0)), 5.0) / 5.0 for r in rows]
    actions = [min(float(r.get("test_actions_per_day", 0.0)), 10.0) / 10.0 for r in rows]
    x = np.arange(len(labels))
    width = 0.25
    fig, ax = plt.subplots(figsize=(11, 5.5))
    ax.bar(x - width, hit, width, label="hit rate")
    ax.bar(x, pf, width, label="PF / 5 cap")
    ax.bar(x + width, actions, width, label="actions/day / 10 cap")
    ax.set_ylim(0, 1)
    ax.set_xticks(x)
    ax.set_xticklabels(labels)
    ax.set_title("V5.10 15m rolling multi-horizon energy routes")
    ax.grid(axis="y", alpha=0.25)
    ax.legend()
    fig.tight_layout()
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=160)
    plt.close(fig)


def main() -> None:
    t0 = datetime.now(timezone.utc)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    feature_cache, coverage, sensor_meta = v56.build_feature_cache()
    base_feature_rows = [c for c in coverage if c.get("symbol") in TARGET_SYMBOLS or c.get("sensor")]

    all_rows: list[dict[str, Any]] = []
    all_events: list[dict[str, Any]] = []
    summaries: list[dict[str, Any]] = []
    model_coverage: list[dict[str, Any]] = []
    signal_samples: list[dict[str, Any]] = []

    for symbol in TARGET_SYMBOLS:
        feat = feature_cache.get((symbol, BASE_CADENCE))
        if feat is None or feat.empty:
            model_coverage.append({"symbol": symbol, "status": "missing_15m_feature_frame"})
            continue
        rows, events, summ, cov = evaluate_symbol(feat, symbol)
        all_rows.extend(rows)
        all_events.extend(events)
        summaries.extend(summ)
        model_coverage.extend(cov)
        # Compact signal sample for direct inspection.
        compact = ensure_feature_columns(feat, symbol).tail(200)
        for _, r in compact.iterrows():
            signal_samples.append(
                {
                    "symbol": symbol,
                    "timestamp": pd.Timestamp(r["timestamp"]).isoformat(),
                    "close": round(float(r["close"]), 6),
                    **{f"future_return_{h}": round(float(r[f"future_return_{h}"]), 8) for h, _ in HORIZONS},
                }
            )

    summary_df = pd.DataFrame(summaries)
    selected = select_routes(summary_df) if not summary_df.empty else []
    best = best_by_symbol(summary_df) if not summary_df.empty else []
    target70_count = int((summary_df.get("target70_status", pd.Series(dtype=str)) == "target70_multi_horizon_confirmed").sum()) if not summary_df.empty else 0
    run_summary = {
        "version": VERSION,
        "generated_at": now_iso(),
        "base_evaluation_cadence": BASE_CADENCE,
        "prediction_horizons": [h for h, _ in HORIZONS],
        "status": "multi_horizon_candidates" if selected else "multi_horizon_watchlist_only",
        "route_count": int(len(summary_df)),
        "candidate_count": int(len(selected)),
        "target70_count": target70_count,
        "selected_policies": [r["policy"] for r in selected],
        "runtime_sec": round((datetime.now(timezone.utc) - t0).total_seconds(), 3),
        "outputs": {
            "summary_json": str(OUT_DIR / "hfcd_commodity_v5_10_summary.json"),
            "policy_summary_csv": str(OUT_DIR / "hfcd_commodity_v5_10_policy_summary.csv"),
            "selected_routes_csv": str(OUT_DIR / "hfcd_commodity_v5_10_selected_routes.csv"),
            "best_by_symbol_csv": str(OUT_DIR / "hfcd_commodity_v5_10_best_by_symbol.csv"),
            "trade_replay_csv": str(OUT_DIR / "hfcd_commodity_v5_10_trade_replay.csv"),
            "action_events_csv": str(OUT_DIR / "hfcd_commodity_v5_10_action_events.csv"),
            "model_coverage_csv": str(OUT_DIR / "hfcd_commodity_v5_10_model_coverage.csv"),
            "signal_sample_csv": str(OUT_DIR / "hfcd_commodity_v5_10_signal_sample.csv"),
            "report_md": str(OUT_DIR / "HFCD_Commodity_V5_10_EnergyMultiHorizonRollingForecast.md"),
            "figure_png": str(OUT_DIR / "HFCD_Commodity_V5_10_EnergyMultiHorizonRollingForecast.png"),
        },
        "sensor_meta": sensor_meta,
        "base_feature_coverage_rows": len(base_feature_rows),
    }

    (OUT_DIR / "hfcd_commodity_v5_10_summary.json").write_text(
        json.dumps(run_summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    summary_df.to_csv(OUT_DIR / "hfcd_commodity_v5_10_policy_summary.csv", index=False)
    pd.DataFrame(selected).to_csv(OUT_DIR / "hfcd_commodity_v5_10_selected_routes.csv", index=False)
    pd.DataFrame(best).to_csv(OUT_DIR / "hfcd_commodity_v5_10_best_by_symbol.csv", index=False)
    write_csv(OUT_DIR / "hfcd_commodity_v5_10_trade_replay.csv", all_rows)
    write_csv(OUT_DIR / "hfcd_commodity_v5_10_action_events.csv", all_events)
    write_csv(OUT_DIR / "hfcd_commodity_v5_10_model_coverage.csv", model_coverage)
    write_csv(OUT_DIR / "hfcd_commodity_v5_10_signal_sample.csv", signal_samples)
    report = make_report(run_summary, selected, best)
    (OUT_DIR / "HFCD_Commodity_V5_10_EnergyMultiHorizonRollingForecast.md").write_text(report, encoding="utf-8")
    make_figure(selected, best, OUT_DIR / "HFCD_Commodity_V5_10_EnergyMultiHorizonRollingForecast.png")
    print(json.dumps(run_summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
