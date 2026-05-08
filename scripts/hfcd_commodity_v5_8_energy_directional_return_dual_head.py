#!/usr/bin/env python3
"""HFCD Commodity V5.8: directional + return dual-head specialist.

Local research only. No broker calls, no testnet calls, no online page changes.

Goal:
- Keep V5.7's dense next-horizon forecast and long/short/reverse actions.
- Add a return head so a direction signal is only traded when expected move
  can cover noise and transaction cost.
- Preserve CL V5.4 as the return benchmark and HO V5.6 as the hit-rate
  benchmark; keep RB/NG as diagnostics until blind evidence improves.
"""

from __future__ import annotations

import importlib.util
import json
import math
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from sklearn.ensemble import ExtraTreesRegressor, HistGradientBoostingRegressor, RandomForestRegressor
from sklearn.linear_model import Ridge
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler


ROOT = Path.cwd()
VERSION = "HFCD_Commodity_V5_8_EnergyDirectionalReturnDualHead"
OUT_DIR = ROOT / "outputs" / "hfcd_commodity_v5_8_energy_directional_return_dual_head"
V56_PATH = ROOT / "scripts" / "hfcd_commodity_v5_6_energy_specialist_split.py"
V57_PATH = ROOT / "scripts" / "hfcd_commodity_v5_7_energy_dense_forecast_specialist.py"

spec56 = importlib.util.spec_from_file_location("v56_specialist", V56_PATH)
v56 = importlib.util.module_from_spec(spec56)
assert spec56 and spec56.loader
sys.modules["v56_specialist"] = v56
spec56.loader.exec_module(v56)

spec57 = importlib.util.spec_from_file_location("v57_dense", V57_PATH)
v57 = importlib.util.module_from_spec(spec57)
assert spec57 and spec57.loader
sys.modules["v57_dense"] = v57
spec57.loader.exec_module(v57)


TARGET_SYMBOLS = v56.TARGET_SYMBOLS
ROUTE_FREQS = v56.ROUTE_FREQS
BASE_NOTIONAL_USD = v56.BASE_NOTIONAL_USD


@dataclass(frozen=True)
class DualHeadPolicy:
    symbol: str
    cadence: str
    direction_model_name: str
    return_model_name: str
    dead_zone: float
    min_predicted_move_bps: float
    cost_cover_multiple: float
    min_hfcd_quality: float
    max_units: int
    risk_cut: float
    signed_agreement_floor_bps: float

    @property
    def name(self) -> str:
        return (
            f"{self.symbol}_{self.cadence}_{self.direction_model_name}_{self.return_model_name}_dual"
            f"_dz{self.dead_zone:.3f}_move{self.min_predicted_move_bps:.1f}"
            f"_costx{self.cost_cover_multiple:.1f}_q{self.min_hfcd_quality:.2f}"
            f"_max{self.max_units}_risk{self.risk_cut:.2f}_agree{self.signed_agreement_floor_bps:.1f}"
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


def direction_probability(row: pd.Series, policy: DualHeadPolicy) -> tuple[float, int]:
    if policy.direction_model_name == "ensemble":
        return float(row["ensemble_prob_up"]), int(row.get("ensemble_consensus", 0))
    return float(row[f"{policy.direction_model_name}_prob_up"]), 4


def train_return_heads(train_df: pd.DataFrame, symbol: str) -> dict[str, Any]:
    cols = v56.feature_columns(symbol)
    x = train_df[cols].to_numpy(dtype=float)
    y_signed = train_df["future_return"].to_numpy(dtype=float)
    y_abs = np.abs(y_signed)
    if len(train_df) < 100 or float(np.nanstd(y_signed)) <= 1e-10:
        return {}
    signed_models: dict[str, Any] = {
        "ridge": make_pipeline(StandardScaler(), Ridge(alpha=3.0)).fit(x, y_signed),
        "extra_trees": ExtraTreesRegressor(
            n_estimators=140,
            max_depth=5,
            min_samples_leaf=14,
            random_state=77,
        ).fit(x, y_signed),
        "hist_gb": HistGradientBoostingRegressor(
            max_iter=80,
            learning_rate=0.035,
            max_leaf_nodes=7,
            l2_regularization=0.45,
            min_samples_leaf=20,
            random_state=77,
        ).fit(x, y_signed),
    }
    abs_models: dict[str, Any] = {
        "ridge": make_pipeline(StandardScaler(), Ridge(alpha=3.0)).fit(x, y_abs),
        "extra_trees": ExtraTreesRegressor(
            n_estimators=140,
            max_depth=5,
            min_samples_leaf=14,
            random_state=177,
        ).fit(x, y_abs),
        "hist_gb": HistGradientBoostingRegressor(
            max_iter=80,
            learning_rate=0.035,
            max_leaf_nodes=7,
            l2_regularization=0.45,
            min_samples_leaf=20,
            random_state=177,
        ).fit(x, y_abs),
    }
    return {"signed": signed_models, "abs": abs_models}


def predict_return_heads(df: pd.DataFrame, symbol: str, return_heads: dict[str, Any]) -> pd.DataFrame:
    cols = v56.feature_columns(symbol)
    x = df[cols].to_numpy(dtype=float)
    out = df.copy()
    signed_preds: list[np.ndarray] = []
    abs_preds: list[np.ndarray] = []
    for name, model in return_heads.get("signed", {}).items():
        pred = np.asarray(model.predict(x), dtype=float)
        out[f"{name}_signed_return_pred"] = pred
        signed_preds.append(pred)
    for name, model in return_heads.get("abs", {}).items():
        pred = np.maximum(0.0, np.asarray(model.predict(x), dtype=float))
        out[f"{name}_abs_return_pred"] = pred
        abs_preds.append(pred)
    if signed_preds:
        out["return_ensemble_signed_return_pred"] = np.mean(np.vstack(signed_preds), axis=0)
    else:
        out["return_ensemble_signed_return_pred"] = 0.0
    if abs_preds:
        out["return_ensemble_abs_return_pred"] = np.mean(np.vstack(abs_preds), axis=0)
    else:
        out["return_ensemble_abs_return_pred"] = 0.0
    return out


def return_predictions(row: pd.Series, policy: DualHeadPolicy) -> tuple[float, float]:
    signed_col = f"{policy.return_model_name}_signed_return_pred"
    abs_col = f"{policy.return_model_name}_abs_return_pred"
    signed = float(row.get(signed_col, row.get("return_ensemble_signed_return_pred", 0.0)))
    magnitude = float(row.get(abs_col, row.get("return_ensemble_abs_return_pred", 0.0)))
    return signed, max(0.0, magnitude)


def dual_head_target_units(row: pd.Series, policy: DualHeadPolicy, cost_rate: float) -> tuple[int, dict[str, Any]]:
    p, consensus = direction_probability(row, policy)
    signed_pred, abs_pred = return_predictions(row, policy)
    edge = p - 0.5
    confidence = abs(edge)
    direction = 1 if edge > 0 else -1
    predicted_move_bps = abs_pred * 10000.0
    signed_pred_bps = signed_pred * 10000.0
    required_move_bps = max(policy.min_predicted_move_bps, cost_rate * 10000.0 * policy.cost_cover_multiple)
    reason: list[str] = []

    if confidence < policy.dead_zone:
        return 0, {
            "p_up": p,
            "edge": edge,
            "confidence": confidence,
            "signed_return_pred": signed_pred,
            "abs_return_pred": abs_pred,
            "predicted_move_bps": predicted_move_bps,
            "required_move_bps": required_move_bps,
            "reason": "edge_in_dead_zone",
        }
    if float(row.get("v53_manifest_quality", 0.0)) < policy.min_hfcd_quality:
        return 0, {
            "p_up": p,
            "edge": edge,
            "confidence": confidence,
            "signed_return_pred": signed_pred,
            "abs_return_pred": abs_pred,
            "predicted_move_bps": predicted_move_bps,
            "required_move_bps": required_move_bps,
            "reason": "manifest_quality_low",
        }
    if predicted_move_bps < required_move_bps:
        return 0, {
            "p_up": p,
            "edge": edge,
            "confidence": confidence,
            "signed_return_pred": signed_pred,
            "abs_return_pred": abs_pred,
            "predicted_move_bps": predicted_move_bps,
            "required_move_bps": required_move_bps,
            "reason": "return_head_too_small",
        }
    if abs(signed_pred_bps) >= policy.signed_agreement_floor_bps and np.sign(signed_pred) != direction:
        return 0, {
            "p_up": p,
            "edge": edge,
            "confidence": confidence,
            "signed_return_pred": signed_pred,
            "abs_return_pred": abs_pred,
            "predicted_move_bps": predicted_move_bps,
            "required_move_bps": required_move_bps,
            "reason": "signed_return_disagrees",
        }

    units = 1
    units += int((predicted_move_bps - required_move_bps) / max(required_move_bps, 1e-9))
    units += int((confidence - policy.dead_zone) / 0.070)
    units = min(policy.max_units, max(1, units))

    bsigma = float(row.get("v53_bsigma", 0.0))
    cavity = float(row.get("v53_c_cavity", 0.0))
    if bsigma > policy.risk_cut and units > 1:
        units -= 1
        reason.append("bsigma_reduce")
    if cavity < 0.30 and units > 1:
        units -= 1
        reason.append("cavity_reduce")

    if policy.symbol == "CL=F":
        guard = float(row.get("v55_cl_profit_guard", 0.0))
        if abs(guard) > 1.10 and np.sign(guard) == direction and units < policy.max_units:
            units += 1
            reason.append("cl_overlay_add")
    elif policy.symbol == "HO=F":
        size_score = float(row.get("v55_ho_size_score", 0.0))
        if abs(size_score) > 1.10 and np.sign(size_score) == direction and units < policy.max_units:
            units += 1
            reason.append("ho_quality_add")
        if abs(size_score) < 0.20 and units > 1:
            units -= 1
            reason.append("ho_quality_reduce")
    elif policy.symbol in {"RB=F", "NG=F"}:
        units = min(units, 1)
        reason.append("watchlist_single_unit")

    return int(direction * max(0, units)), {
        "p_up": p,
        "edge": edge,
        "confidence": confidence,
        "consensus": consensus,
        "signed_return_pred": signed_pred,
        "abs_return_pred": abs_pred,
        "predicted_move_bps": predicted_move_bps,
        "required_move_bps": required_move_bps,
        "reason": "+".join(reason) if reason else "dual_head_confirmed",
    }


def replay_dual_head(df: pd.DataFrame, policy: DualHeadPolicy) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    cost_rate = v56.v51.trade_cost(policy.symbol, policy.cadence)
    position = 0
    rows: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []
    for i in range(len(df) - 1):
        row = df.iloc[i]
        ts = pd.Timestamp(row["timestamp"])
        desired, meta = dual_head_target_units(row, policy, cost_rate)
        delta = desired - position
        action = v57.action_from_transition(position, desired)
        if action != "hold":
            events.append(
                {
                    "policy": policy.name,
                    "symbol": policy.symbol,
                    "cadence": policy.cadence,
                    "timestamp": ts.isoformat(),
                    "action": action,
                    "from_units": position,
                    "to_units": desired,
                    "close": round(float(row["close"]), 6),
                    "p_up": round(float(meta["p_up"]), 6),
                    "edge": round(float(meta["edge"]), 6),
                    "predicted_move_bps": round(float(meta["predicted_move_bps"]), 6),
                    "required_move_bps": round(float(meta["required_move_bps"]), 6),
                    "transition_reason": meta["reason"],
                }
            )
        pnl_before_cost = desired * BASE_NOTIONAL_USD * float(row["next_bar_return"])
        turnover_cost = abs(delta) * BASE_NOTIONAL_USD * cost_rate
        pnl = pnl_before_cost - turnover_cost
        active = int(desired != 0)
        direction_hit = int(np.sign(desired) == np.sign(float(row["future_return"]))) if active else 0
        rows.append(
            {
                "policy": policy.name,
                "symbol": policy.symbol,
                "cadence": policy.cadence,
                "timestamp": ts.isoformat(),
                "close": round(float(row["close"]), 6),
                "decision": "long" if desired > 0 else ("short" if desired < 0 else "flat"),
                "position_units_before": position,
                "position_units_after": desired,
                "action": action,
                "direction_model_name": policy.direction_model_name,
                "return_model_name": policy.return_model_name,
                "dead_zone": policy.dead_zone,
                "min_predicted_move_bps": policy.min_predicted_move_bps,
                "cost_cover_multiple": policy.cost_cover_multiple,
                "min_hfcd_quality": policy.min_hfcd_quality,
                "max_units": policy.max_units,
                "risk_cut": policy.risk_cut,
                "signed_agreement_floor_bps": policy.signed_agreement_floor_bps,
                "p_up": round(float(meta["p_up"]), 6),
                "edge": round(float(meta["edge"]), 6),
                "confidence": round(float(meta["confidence"]), 6),
                "signed_return_pred": round(float(meta["signed_return_pred"]), 8),
                "abs_return_pred": round(float(meta["abs_return_pred"]), 8),
                "predicted_move_bps": round(float(meta["predicted_move_bps"]), 6),
                "required_move_bps": round(float(meta["required_move_bps"]), 6),
                "transition_reason": meta["reason"],
                "future_return": round(float(row["future_return"]), 8),
                "direction_signal_active": active,
                "direction_hit": direction_hit,
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


def summarize(rows: list[dict[str, Any]], policy: DualHeadPolicy, split: str) -> dict[str, Any]:
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
    predicted_moves = [float(r["predicted_move_bps"]) for r in active]
    realized_abs = [abs(float(r["future_return"])) * 10000.0 for r in active]
    return {
        "policy": policy.name,
        "symbol": policy.symbol,
        "cadence": policy.cadence,
        "direction_model_name": policy.direction_model_name,
        "return_model_name": policy.return_model_name,
        "dead_zone": policy.dead_zone,
        "min_predicted_move_bps": policy.min_predicted_move_bps,
        "cost_cover_multiple": policy.cost_cover_multiple,
        "min_hfcd_quality": policy.min_hfcd_quality,
        "max_units": policy.max_units,
        "risk_cut": policy.risk_cut,
        "signed_agreement_floor_bps": policy.signed_agreement_floor_bps,
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
        "direction_hit_rate": round(sum(int(r["direction_hit"]) for r in active) / len(active), 6) if active else 0.0,
        "avg_predicted_move_bps": round(float(np.mean(predicted_moves)) if predicted_moves else 0.0, 6),
        "avg_realized_abs_move_bps": round(float(np.mean(realized_abs)) if realized_abs else 0.0, 6),
        "net_pnl_usd": round(sum(pnls), 6),
        "profit_factor": round(profit_factor(pnls), 6),
        "max_drawdown_usd": round(max_drawdown_from_pnls(pnls), 6),
        "turnover_cost_usd": round(sum(float(r["turnover_cost_usd"]) for r in sub), 6),
    }


def evaluate(feature_df: pd.DataFrame, symbol: str, cadence: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    df = v56.clean_df(feature_df, symbol)
    if len(df) < 120:
        return [], [], []
    cut1, cut2 = v56.split_masks(pd.to_datetime(df["timestamp"], utc=True))
    train = df[pd.to_datetime(df["timestamp"], utc=True) <= cut1]
    direction_models = v56.train_models(train, symbol)
    return_heads = train_return_heads(train, symbol)
    if not direction_models or not return_heads:
        return [], [], []
    pred = v56.predict_model_scores(df, symbol, direction_models)
    pred = predict_return_heads(pred, symbol, return_heads)

    if symbol in {"CL=F", "HO=F"}:
        direction_model_names = ["ensemble", "hist_gb", "extra_trees"]
        return_model_names = ["return_ensemble", "ridge", "extra_trees"]
    else:
        direction_model_names = ["ensemble", "hist_gb"]
        return_model_names = ["return_ensemble", "ridge"]
    if symbol == "CL=F":
        dead_zones = [0.020, 0.035]
        min_moves = [4.0, 7.0]
        max_units_grid = [1, 2]
    elif symbol == "HO=F":
        dead_zones = [0.025, 0.050]
        min_moves = [3.0, 6.0]
        max_units_grid = [1, 2]
    else:
        dead_zones = [0.050]
        min_moves = [6.0]
        max_units_grid = [1]
    cost_multiples = [1.5, 2.5] if symbol in {"CL=F", "HO=F"} else [2.0]
    quality_gates = [0.00, 0.35] if symbol in {"CL=F", "HO=F"} else [0.35]
    risk_cuts = [3.0]
    signed_agreement_floors = [0.5]

    all_rows: list[dict[str, Any]] = []
    all_events: list[dict[str, Any]] = []
    summaries: list[dict[str, Any]] = []
    for direction_model_name in direction_model_names:
        for return_model_name in return_model_names:
            for dead_zone in dead_zones:
                for min_move in min_moves:
                    for cost_multiple in cost_multiples:
                        for quality in quality_gates:
                            for max_units in max_units_grid:
                                for risk_cut in risk_cuts:
                                    for agree_floor in signed_agreement_floors:
                                        policy = DualHeadPolicy(
                                            symbol,
                                            cadence,
                                            direction_model_name,
                                            return_model_name,
                                            dead_zone,
                                            min_move,
                                            cost_multiple,
                                            quality,
                                            max_units,
                                            risk_cut,
                                            agree_floor,
                                        )
                                        rows, events = replay_dual_head(pred, policy)
                                        for row in rows:
                                            row["split"] = split_name(pd.Timestamp(row["timestamp"]), cut1, cut2)
                                        for event in events:
                                            event["split"] = split_name(pd.Timestamp(event["timestamp"]), cut1, cut2)
                                        by_split = {split: summarize(rows, policy, split) for split in ["train", "validation", "test"]}
                                        combined: dict[str, Any] = {
                                            "policy": policy.name,
                                            "symbol": symbol,
                                            "cadence": cadence,
                                            "direction_model_name": direction_model_name,
                                            "return_model_name": return_model_name,
                                            "dead_zone": dead_zone,
                                            "min_predicted_move_bps": min_move,
                                            "cost_cover_multiple": cost_multiple,
                                            "min_hfcd_quality": quality,
                                            "max_units": max_units,
                                            "risk_cut": risk_cut,
                                            "signed_agreement_floor_bps": agree_floor,
                                        }
                                        for split, vals in by_split.items():
                                            for k, v in vals.items():
                                                if k in combined or k in {
                                                    "policy",
                                                    "symbol",
                                                    "cadence",
                                                    "direction_model_name",
                                                    "return_model_name",
                                                    "split",
                                                }:
                                                    continue
                                                combined[f"{split}_{k}"] = v
                                        val = by_split["validation"]
                                        test = by_split["test"]
                                        combined["dual_head_status"] = (
                                            "dual_head_blind_confirmed"
                                            if val["active_signal_rate"] >= 0.12
                                            and test["active_signal_rate"] >= 0.12
                                            and val["actions_per_day"] >= 1.0
                                            and test["actions_per_day"] >= 1.0
                                            and val["direction_hit_rate"] >= 0.57
                                            and test["direction_hit_rate"] >= 0.57
                                            and val["profit_factor"] >= 1.05
                                            and test["profit_factor"] >= 1.05
                                            else "dual_head_watchlist_or_blocked"
                                        )
                                        combined["target70_status"] = (
                                            "target70_dual_head_confirmed"
                                            if val["active_signal_rate"] >= 0.08
                                            and test["active_signal_rate"] >= 0.08
                                            and val["direction_hit_rate"] >= 0.68
                                            and test["direction_hit_rate"] >= 0.68
                                            and val["profit_factor"] >= 1.0
                                            and test["profit_factor"] >= 1.0
                                            else "not_target70"
                                        )
                                        density_bonus = min(test["actions_per_day"], 10.0) * 1.5 + min(test["active_signal_rate"], 0.60) * 10.0
                                        return_alignment = min(test["avg_realized_abs_move_bps"], 20.0) / max(test["avg_predicted_move_bps"], 1.0)
                                        combined["selection_score"] = round(
                                            130.0 * min(val["direction_hit_rate"], test["direction_hit_rate"])
                                            + 12.0 * min(val["profit_factor"], 4.0)
                                            + 16.0 * min(test["profit_factor"], 4.0)
                                            + density_bonus
                                            + min(return_alignment, 2.0) * 4.0
                                            - abs(test["max_drawdown_usd"]) * 0.025
                                            + 0.08 * test["net_pnl_usd"],
                                            6,
                                        )
                                        summaries.append(combined)
                                        if (
                                            combined["dual_head_status"] == "dual_head_blind_confirmed"
                                            or combined["target70_status"] == "target70_dual_head_confirmed"
                                        ):
                                            all_rows.extend(rows)
                                            all_events.extend(events)
    return all_rows, all_events, summaries


def select_routes(summary_df: pd.DataFrame) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    if summary_df.empty:
        return selected
    for (symbol, cadence), group in summary_df.groupby(["symbol", "cadence"], sort=False):
        candidates = group[group["dual_head_status"] == "dual_head_blind_confirmed"].copy()
        if symbol == "CL=F":
            candidates = candidates[
                (candidates["test_profit_factor"] >= 1.35)
                & (candidates["test_net_pnl_usd"] > 10)
                & (candidates["test_max_drawdown_usd"] > -90)
            ]
        elif symbol == "HO=F":
            candidates = candidates[
                (candidates["test_profit_factor"] >= 1.0)
                & (candidates["test_direction_hit_rate"] >= 0.60)
            ]
        else:
            candidates = candidates.iloc[0:0]
        candidates = candidates.sort_values("selection_score", ascending=False)
        if not candidates.empty:
            selected.append(candidates.iloc[0].to_dict())
    return sorted(
        selected,
        key=lambda r: (
            float(r.get("test_direction_hit_rate", 0)),
            float(r.get("test_profit_factor", 0)),
            float(r.get("test_net_pnl_usd", 0)),
        ),
        reverse=True,
    )


def best_by_route(summary_df: pd.DataFrame) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if summary_df.empty:
        return rows
    for (_, _), group in summary_df.groupby(["symbol", "cadence"], sort=False):
        eligible = group[group["validation_active_signal_rate"] >= 0.08]
        if eligible.empty:
            eligible = group
        best = eligible.sort_values(
            [
                "validation_direction_hit_rate",
                "validation_profit_factor",
                "test_direction_hit_rate",
                "test_profit_factor",
                "test_net_pnl_usd",
            ],
            ascending=False,
        ).iloc[0]
        rows.append(best.to_dict())
    return rows


def make_report(run_summary: dict[str, Any], selected: list[dict[str, Any]], best_rows: list[dict[str, Any]]) -> str:
    lines = [
        f"# {VERSION}",
        "",
        "## Conclusion",
        "",
        f"- Status: `{run_summary['status']}`",
        f"- Route count: `{run_summary['route_count']}`; dual-head candidates: `{run_summary['candidate_count']}`; target-70 candidates: `{run_summary['target70_count']}`.",
        "- V5.8 adds a return-magnitude head to V5.7 dense direction forecasts.",
        "- A trade is allowed only when direction probability, expected move, cost coverage, and HFCD risk state agree.",
        "- CL still protects the V5.4 return baseline; HO still targets higher hit-rate; RB/NG remain diagnostics.",
        "",
        "## Selected routes",
        "",
    ]
    if selected:
        lines.append("| Symbol | Cadence | Direction | Return | Move bps | Validation hit/PF | Test hit/PF | Active | Actions/day | Test PnL | DD |")
        lines.append("|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|")
        for r in selected:
            lines.append(
                f"| {r['symbol']} | {r['cadence']} | {r['direction_model_name']} | {r['return_model_name']} | "
                f"{float(r['min_predicted_move_bps']):.1f} | "
                f"{float(r['validation_direction_hit_rate']):.2%}/{float(r['validation_profit_factor']):.2f} | "
                f"{float(r['test_direction_hit_rate']):.2%}/{float(r['test_profit_factor']):.2f} | "
                f"{float(r['test_active_signal_rate']):.2%} | {float(r['test_actions_per_day']):.2f} | "
                f"{float(r['test_net_pnl_usd']):.2f} | {float(r['test_max_drawdown_usd']):.2f} |"
            )
    else:
        lines.append("No route passed validation + blind-test dual-head gates.")

    lines += ["", "## Validation-first best by route", ""]
    lines.append("| Symbol | Cadence | Direction | Return | Validation hit/PF | Test hit/PF | Active | Actions/day | Add/Reduce/Reverse | Test PnL | Status |")
    lines.append("|---|---:|---|---|---:|---:|---:|---:|---:|---:|---|")
    for r in best_rows:
        lines.append(
            f"| {r['symbol']} | {r['cadence']} | {r['direction_model_name']} | {r['return_model_name']} | "
            f"{float(r['validation_direction_hit_rate']):.2%}/{float(r['validation_profit_factor']):.2f} | "
            f"{float(r['test_direction_hit_rate']):.2%}/{float(r['test_profit_factor']):.2f} | "
            f"{float(r['test_active_signal_rate']):.2%} | {float(r['test_actions_per_day']):.2f} | "
            f"{int(r['test_add_actions'])}/{int(r['test_reduce_actions'])}/{int(r['test_reverse_actions'])} | "
            f"{float(r['test_net_pnl_usd']):.2f} | {r['dual_head_status']} |"
        )

    lines += [
        "",
        "## Judgment",
        "",
        "- If V5.8 reduces active density but improves PF and drawdown, it is useful as a quality filter.",
        "- If it improves hit-rate but removes too much PnL, it should remain an overlay rather than a replacement.",
        "- Do not promote to forward ledger unless it beats the frozen CL/HO baselines by symbol.",
        "",
        "## Next action plan",
        "",
        "If V5.8 still cannot reach stable 65%-70% hit-rate with positive PF, V5.9 should add an event-state head: EIA release regime, pit-session liquidity, cross-product lead-lag, and separate entry/scale/reverse classifiers instead of one shared action mapper.",
        "",
    ]
    return "\n".join(lines)


def plot_results(selected: list[dict[str, Any]], best_rows: list[dict[str, Any]], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fig, axes = plt.subplots(3, 1, figsize=(14, 11), constrained_layout=True)
    labels = [f"{r['symbol']} {r['cadence']}" for r in best_rows]
    hit = [float(r.get("test_direction_hit_rate", 0)) for r in best_rows]
    pf = [float(r.get("test_profit_factor", 0)) for r in best_rows]
    pnl = [float(r.get("test_net_pnl_usd", 0)) for r in best_rows]
    axes[0].bar(labels, hit, color=["#059669" if v >= 0.65 else "#f59e0b" if v >= 0.57 else "#64748b" for v in hit])
    axes[0].axhline(0.70, color="#dc2626", linestyle="--", label="70% target")
    axes[0].axhline(0.57, color="#0891b2", linestyle="--", label="dual-head min")
    axes[0].set_ylim(0, 1)
    axes[0].set_title("V5.8 dual-head blind-test direction hit rate")
    axes[0].tick_params(axis="x", rotation=45)
    axes[0].legend()
    axes[0].grid(axis="y", alpha=0.25)
    axes[1].bar(labels, pf, color=["#059669" if v >= 1.35 else "#f59e0b" if v >= 1.0 else "#64748b" for v in pf])
    axes[1].axhline(1.0, color="#dc2626", linestyle="--", label="PF 1.0")
    axes[1].set_title("V5.8 test profit factor")
    axes[1].tick_params(axis="x", rotation=45)
    axes[1].legend()
    axes[1].grid(axis="y", alpha=0.25)
    axes[2].bar(labels, pnl, color=["#0ea5e9" if v >= 0 else "#ef4444" for v in pnl])
    axes[2].set_title("V5.8 test net PnL")
    axes[2].tick_params(axis="x", rotation=45)
    axes[2].grid(axis="y", alpha=0.25)
    fig.savefig(path, dpi=160)
    plt.close(fig)


def main() -> None:
    started = time.time()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    feature_cache, data_coverage, sensor_meta = v56.build_feature_cache()
    all_rows: list[dict[str, Any]] = []
    all_events: list[dict[str, Any]] = []
    all_summaries: list[dict[str, Any]] = []
    for (symbol, cadence), features in feature_cache.items():
        rows, events, summaries = evaluate(features, symbol, cadence)
        all_rows.extend(rows)
        all_events.extend(events)
        all_summaries.extend(summaries)
        print(f"[{VERSION}] evaluated {symbol} {cadence}: rows={len(features)} policies={len(summaries)}", flush=True)

    summary_df = pd.DataFrame(all_summaries)
    if not summary_df.empty:
        summary_df = summary_df.sort_values(
            ["dual_head_status", "target70_status", "selection_score"],
            ascending=[True, True, False],
        )
    selected = select_routes(summary_df)
    best_rows = best_by_route(summary_df)
    status = "dual_head_candidates" if selected else "dual_head_watchlist_no_candidate"
    target70_count = int(sum(1 for r in selected if r.get("target70_status") == "target70_dual_head_confirmed"))

    write_csv(OUT_DIR / "hfcd_commodity_v5_8_data_coverage.csv", data_coverage)
    summary_df.to_csv(OUT_DIR / "hfcd_commodity_v5_8_policy_summary.csv", index=False)
    write_csv(OUT_DIR / "hfcd_commodity_v5_8_selected_routes.csv", selected, list(summary_df.columns))
    write_csv(OUT_DIR / "hfcd_commodity_v5_8_best_by_route.csv", best_rows)
    write_csv(OUT_DIR / "hfcd_commodity_v5_8_dual_head_replay.csv", all_rows)
    write_csv(OUT_DIR / "hfcd_commodity_v5_8_position_events.csv", all_events)

    report_path = OUT_DIR / "HFCD_Commodity_V5_8_EnergyDirectionalReturnDualHead.md"
    chart_path = OUT_DIR / "HFCD_Commodity_V5_8_EnergyDirectionalReturnDualHead.png"
    run_summary = {
        "version": VERSION,
        "generated_at": now_iso(),
        "runtime_seconds": round(time.time() - started, 3),
        "status": status,
        "route_count": len(all_summaries),
        "candidate_count": len(selected),
        "target70_count": target70_count,
        "best_validation_hit_rate": float(summary_df["validation_direction_hit_rate"].max()) if not summary_df.empty else None,
        "best_test_hit_rate": float(summary_df["test_direction_hit_rate"].max()) if not summary_df.empty else None,
        "report": str(report_path),
        "chart": str(chart_path),
        "selected_routes": selected,
        "best_by_route": best_rows,
        "data_coverage": data_coverage,
        "sensor_meta": sensor_meta,
        "notes": [
            "Local research only; no exchange orders.",
            "Dual-head filter: direction probability plus predicted return magnitude.",
            "Train-only models, validation-selected policies, blind test audit.",
        ],
    }
    (OUT_DIR / "hfcd_commodity_v5_8_summary.json").write_text(
        json.dumps(run_summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    report_path.write_text(make_report(run_summary, selected, best_rows), encoding="utf-8")
    plot_results(selected, best_rows, chart_path)
    print(
        json.dumps(
            {
                "status": status,
                "candidate_count": len(selected),
                "target70_count": target70_count,
                "out_dir": str(OUT_DIR),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
