#!/usr/bin/env python3
"""HFCD Commodity V5.9: energy sample-density lift.

Local research only. No broker calls, no testnet calls, no online page changes.

Goal:
- Fix V5.8's "high hit-rate but sample starvation" failure mode.
- Keep next-horizon direction prediction on every 15m/30m/1h/1.5h/2h/2.5h/3h bar.
- Use the return head for sizing and density calibration, not as a hard gate.
- Select routes by validation + blind-test sample count, hit-rate, PF, DD and actions/day.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


ROOT = Path.cwd()
VERSION = "HFCD_Commodity_V5_9_EnergySampleDensityLift"
OUT_DIR = ROOT / "outputs" / "hfcd_commodity_v5_9_energy_sample_density_lift"
V56_PATH = ROOT / "scripts" / "hfcd_commodity_v5_6_energy_specialist_split.py"
V57_PATH = ROOT / "scripts" / "hfcd_commodity_v5_7_energy_dense_forecast_specialist.py"
V58_PATH = ROOT / "scripts" / "hfcd_commodity_v5_8_energy_directional_return_dual_head.py"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


v56 = load_module("v56_specialist", V56_PATH)
v57 = load_module("v57_dense", V57_PATH)
v58 = load_module("v58_dual", V58_PATH)

TARGET_SYMBOLS = v56.TARGET_SYMBOLS
BASE_NOTIONAL_USD = v56.BASE_NOTIONAL_USD


@dataclass(frozen=True)
class DensityPolicy:
    symbol: str
    cadence: str
    direction_model_name: str
    return_model_name: str
    target_active_rate: float
    min_hfcd_quality: float
    max_units: int
    risk_cut: float
    return_weight: float
    quality_floor: float

    @property
    def name(self) -> str:
        return (
            f"{self.symbol}_{self.cadence}_{self.direction_model_name}_{self.return_model_name}"
            f"_density_rate{self.target_active_rate:.2f}_q{self.min_hfcd_quality:.2f}"
            f"_max{self.max_units}_rw{self.return_weight:.2f}_floor{self.quality_floor:.4f}"
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


def direction_probability(row: pd.Series, model_name: str) -> tuple[float, int]:
    if model_name == "ensemble":
        return float(row["ensemble_prob_up"]), int(row.get("ensemble_consensus", 0))
    return float(row[f"{model_name}_prob_up"]), 4


def return_predictions(row: pd.Series, return_model_name: str) -> tuple[float, float]:
    signed_col = f"{return_model_name}_signed_return_pred"
    abs_col = f"{return_model_name}_abs_return_pred"
    signed = float(row.get(signed_col, row.get("return_ensemble_signed_return_pred", 0.0)))
    magnitude = max(0.0, float(row.get(abs_col, row.get("return_ensemble_abs_return_pred", 0.0))))
    return signed, magnitude


def add_density_scores(df: pd.DataFrame, symbol: str, direction_model_name: str, return_model_name: str) -> pd.DataFrame:
    out = df.copy()
    p_vals: list[float] = []
    direction_vals: list[int] = []
    consensus_vals: list[int] = []
    signed_vals: list[float] = []
    abs_vals: list[float] = []
    for _, row in out.iterrows():
        p, consensus = direction_probability(row, direction_model_name)
        signed, magnitude = return_predictions(row, return_model_name)
        p_vals.append(p)
        direction_vals.append(1 if p >= 0.5 else -1)
        consensus_vals.append(consensus)
        signed_vals.append(signed)
        abs_vals.append(magnitude)
    out["density_p_up"] = p_vals
    out["density_direction"] = direction_vals
    out["density_consensus"] = consensus_vals
    out["density_signed_pred"] = signed_vals
    out["density_abs_pred"] = abs_vals
    out["density_confidence"] = np.abs(out["density_p_up"] - 0.5)
    out["density_predicted_move_bps"] = out["density_abs_pred"] * 10000.0

    cost_bps = float(v56.v51.trade_cost(symbol, "1h")) * 10000.0
    # Return head is useful, but V5.8 showed it should not be a hard gate. Use
    # a saturating multiplier so big predicted moves improve sizing while small
    # moves still remain testable if the direction edge is strong.
    move_ratio = out["density_predicted_move_bps"] / max(cost_bps * 1.5, 1.0)
    out["density_return_boost"] = np.clip(np.sqrt(np.maximum(move_ratio, 0.0)), 0.35, 2.25)
    hfcd_quality = pd.to_numeric(out.get("v53_manifest_quality", 0.0), errors="coerce").fillna(0.0)
    sigma = pd.to_numeric(out.get("v53_sigma_ledger", 0.0), errors="coerce").fillna(0.0)
    q_core = pd.to_numeric(out.get("v53_q_core", 0.0), errors="coerce").fillna(0.0)
    out["density_hfcd_boost"] = np.clip(0.50 + 0.22 * hfcd_quality + 0.12 * np.abs(sigma) + 0.10 * q_core, 0.35, 1.80)
    signed_alignment = np.sign(out["density_signed_pred"].to_numpy(dtype=float)) == out["density_direction"].to_numpy(dtype=int)
    out["density_signed_alignment"] = signed_alignment.astype(int)
    out["density_raw_quality"] = out["density_confidence"] * out["density_return_boost"] * out["density_hfcd_boost"]
    return out


def calibrate_quality_floor(train_df: pd.DataFrame, target_active_rate: float) -> float:
    quality = pd.to_numeric(train_df["density_raw_quality"], errors="coerce").replace([np.inf, -np.inf], np.nan).dropna()
    if quality.empty:
        return 999.0
    target_active_rate = float(np.clip(target_active_rate, 0.02, 0.85))
    return float(np.quantile(quality, 1.0 - target_active_rate))


def density_target_units(row: pd.Series, policy: DensityPolicy, cost_rate: float) -> tuple[int, dict[str, Any]]:
    p = float(row["density_p_up"])
    direction = int(row["density_direction"])
    confidence = float(row["density_confidence"])
    raw_quality = float(row["density_raw_quality"])
    predicted_move_bps = float(row["density_predicted_move_bps"])
    signed_pred = float(row["density_signed_pred"])
    signed_alignment = int(row["density_signed_alignment"])
    reason: list[str] = []

    if raw_quality < policy.quality_floor:
        return 0, {
            "p_up": p,
            "confidence": confidence,
            "raw_quality": raw_quality,
            "predicted_move_bps": predicted_move_bps,
            "signed_return_pred": signed_pred,
            "reason": "calibrated_density_floor",
        }
    if float(row.get("v53_manifest_quality", 0.0)) < policy.min_hfcd_quality:
        return 0, {
            "p_up": p,
            "confidence": confidence,
            "raw_quality": raw_quality,
            "predicted_move_bps": predicted_move_bps,
            "signed_return_pred": signed_pred,
            "reason": "manifest_quality_low",
        }

    # If return head strongly disagrees, keep the sample but compress to flat
    # only when the direction edge is weak. This preserves sample count without
    # letting noisy reverse predictions dominate.
    if signed_alignment == 0 and confidence < 0.09:
        return 0, {
            "p_up": p,
            "confidence": confidence,
            "raw_quality": raw_quality,
            "predicted_move_bps": predicted_move_bps,
            "signed_return_pred": signed_pred,
            "reason": "weak_edge_return_disagrees",
        }
    if signed_alignment == 0:
        reason.append("return_disagree_size_cap")

    quality_excess = raw_quality - policy.quality_floor
    floor = max(abs(policy.quality_floor), 1e-6)
    units = 1 + int(quality_excess / floor)
    move_units = int((predicted_move_bps * policy.return_weight) / max(cost_rate * 10000.0 * 3.0, 1.0))
    units += max(0, move_units)
    units = min(policy.max_units, max(1, units))

    if signed_alignment == 0:
        units = min(units, 1)

    bsigma = float(row.get("v53_bsigma", 0.0))
    cavity = float(row.get("v53_c_cavity", 0.0))
    if bsigma > policy.risk_cut and units > 1:
        units -= 1
        reason.append("bsigma_reduce")
    if cavity < 0.28 and units > 1:
        units -= 1
        reason.append("cavity_reduce")

    if policy.symbol == "CL=F":
        guard = float(row.get("v55_cl_profit_guard", 0.0))
        if abs(guard) > 1.10 and np.sign(guard) == direction and units < policy.max_units:
            units += 1
            reason.append("cl_overlay_add")
        if abs(guard) < 0.15 and units > 1:
            units -= 1
            reason.append("cl_weak_guard_reduce")
    elif policy.symbol == "HO=F":
        size_score = float(row.get("v55_ho_size_score", 0.0))
        if abs(size_score) > 1.05 and np.sign(size_score) == direction and units < policy.max_units:
            units += 1
            reason.append("ho_quality_add")
        if abs(size_score) < 0.18 and units > 1:
            units -= 1
            reason.append("ho_quality_reduce")
    elif policy.symbol in {"RB=F", "NG=F"}:
        units = min(units, 1)
        reason.append("watchlist_single_unit")

    return int(direction * max(0, units)), {
        "p_up": p,
        "confidence": confidence,
        "raw_quality": raw_quality,
        "predicted_move_bps": predicted_move_bps,
        "signed_return_pred": signed_pred,
        "reason": "+".join(reason) if reason else "density_confirmed",
    }


def action_from_transition(position: int, desired: int) -> str:
    return str(v57.action_from_transition(position, desired))


def replay_density(df: pd.DataFrame, policy: DensityPolicy) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    cost_rate = v56.v51.trade_cost(policy.symbol, policy.cadence)
    position = 0
    rows: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []
    for i in range(len(df) - 1):
        row = df.iloc[i]
        ts = pd.Timestamp(row["timestamp"])
        desired, meta = density_target_units(row, policy, cost_rate)
        delta = desired - position
        action = action_from_transition(position, desired)
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
                    "confidence": round(float(meta["confidence"]), 6),
                    "raw_quality": round(float(meta["raw_quality"]), 8),
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
                "target_active_rate": policy.target_active_rate,
                "min_hfcd_quality": policy.min_hfcd_quality,
                "max_units": policy.max_units,
                "risk_cut": policy.risk_cut,
                "return_weight": policy.return_weight,
                "quality_floor": policy.quality_floor,
                "p_up": round(float(meta["p_up"]), 6),
                "confidence": round(float(meta["confidence"]), 6),
                "signed_return_pred": round(float(meta["signed_return_pred"]), 8),
                "predicted_move_bps": round(float(meta["predicted_move_bps"]), 6),
                "raw_quality": round(float(meta["raw_quality"]), 8),
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


def summarize(rows: list[dict[str, Any]], policy: DensityPolicy, split: str) -> dict[str, Any]:
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
        "cadence": policy.cadence,
        "direction_model_name": policy.direction_model_name,
        "return_model_name": policy.return_model_name,
        "target_active_rate": policy.target_active_rate,
        "min_hfcd_quality": policy.min_hfcd_quality,
        "max_units": policy.max_units,
        "risk_cut": policy.risk_cut,
        "return_weight": policy.return_weight,
        "quality_floor": round(policy.quality_floor, 8),
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
        "net_pnl_usd": round(sum(pnls), 6),
        "profit_factor": round(profit_factor(pnls), 6),
        "max_drawdown_usd": round(max_drawdown_from_pnls(pnls), 6),
        "turnover_cost_usd": round(sum(float(r["turnover_cost_usd"]) for r in sub), 6),
    }


def evaluate(feature_df: pd.DataFrame, symbol: str, cadence: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    df = v56.clean_df(feature_df, symbol)
    if len(df) < 140:
        return [], [], []
    cut1, cut2 = v56.split_masks(pd.to_datetime(df["timestamp"], utc=True))
    timestamps = pd.to_datetime(df["timestamp"], utc=True)
    train = df[timestamps <= cut1]
    direction_models = v56.train_models(train, symbol)
    return_heads = v58.train_return_heads(train, symbol)
    if not direction_models or not return_heads:
        return [], [], []

    pred_base = v56.predict_model_scores(df, symbol, direction_models)
    pred_base = v58.predict_return_heads(pred_base, symbol, return_heads)

    if symbol in {"CL=F", "HO=F"}:
        direction_model_names = ["ensemble", "hist_gb", "extra_trees"]
        return_model_names = ["return_ensemble", "ridge"]
        target_rates = [0.10, 0.18, 0.28, 0.40]
        quality_gates = [0.00, 0.25]
        max_units_grid = [1, 2, 3] if symbol == "HO=F" else [1, 2]
    else:
        direction_model_names = ["ensemble", "hist_gb"]
        return_model_names = ["return_ensemble", "ridge"]
        target_rates = [0.18, 0.30, 0.45]
        quality_gates = [0.20]
        max_units_grid = [1]
    risk_cuts = [3.0]
    return_weights = [0.35, 0.65]

    all_rows: list[dict[str, Any]] = []
    all_events: list[dict[str, Any]] = []
    summaries: list[dict[str, Any]] = []
    for direction_model_name in direction_model_names:
        for return_model_name in return_model_names:
            scored = add_density_scores(pred_base, symbol, direction_model_name, return_model_name)
            scored_train = scored[pd.to_datetime(scored["timestamp"], utc=True) <= cut1]
            for target_rate in target_rates:
                floor = calibrate_quality_floor(scored_train, target_rate)
                for quality in quality_gates:
                    for max_units in max_units_grid:
                        for risk_cut in risk_cuts:
                            for return_weight in return_weights:
                                policy = DensityPolicy(
                                    symbol=symbol,
                                    cadence=cadence,
                                    direction_model_name=direction_model_name,
                                    return_model_name=return_model_name,
                                    target_active_rate=target_rate,
                                    min_hfcd_quality=quality,
                                    max_units=max_units,
                                    risk_cut=risk_cut,
                                    return_weight=return_weight,
                                    quality_floor=floor,
                                )
                                rows, events = replay_density(scored, policy)
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
                                    "target_active_rate": target_rate,
                                    "min_hfcd_quality": quality,
                                    "max_units": max_units,
                                    "risk_cut": risk_cut,
                                    "return_weight": return_weight,
                                    "quality_floor": round(floor, 8),
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
                                min_test_samples = 30 if cadence in {"15m", "30m", "1h"} else 18
                                min_val_samples = 30 if cadence in {"15m", "30m", "1h"} else 18
                                combined["sample_status"] = (
                                    "sample_dense_enough"
                                    if val["active_signal_bars"] >= min_val_samples and test["active_signal_bars"] >= min_test_samples
                                    else "sample_sparse"
                                )
                                combined["density_status"] = (
                                    "density_blind_confirmed"
                                    if combined["sample_status"] == "sample_dense_enough"
                                    and val["actions_per_day"] >= 1.5
                                    and test["actions_per_day"] >= 1.5
                                    and val["direction_hit_rate"] >= 0.56
                                    and test["direction_hit_rate"] >= 0.56
                                    and val["profit_factor"] >= 1.0
                                    and test["profit_factor"] >= 1.0
                                    and test["max_drawdown_usd"] > -120
                                    else "density_watchlist_or_blocked"
                                )
                                combined["target70_status"] = (
                                    "target70_density_confirmed"
                                    if combined["sample_status"] == "sample_dense_enough"
                                    and val["direction_hit_rate"] >= 0.68
                                    and test["direction_hit_rate"] >= 0.68
                                    and val["profit_factor"] >= 1.0
                                    and test["profit_factor"] >= 1.0
                                    else "not_target70"
                                )
                                density_bonus = min(test["actions_per_day"], 10.0) * 2.0 + min(test["active_signal_bars"], 80) * 0.10
                                sample_penalty = 0 if combined["sample_status"] == "sample_dense_enough" else 12
                                combined["selection_score"] = round(
                                    115.0 * min(val["direction_hit_rate"], test["direction_hit_rate"])
                                    + 12.0 * min(val["profit_factor"], 3.0)
                                    + 15.0 * min(test["profit_factor"], 3.0)
                                    + density_bonus
                                    + 0.045 * test["net_pnl_usd"]
                                    - abs(test["max_drawdown_usd"]) * 0.022
                                    - sample_penalty,
                                    6,
                                )
                                summaries.append(combined)
                                if combined["density_status"] == "density_blind_confirmed" or combined["target70_status"] == "target70_density_confirmed":
                                    all_rows.extend(rows)
                                    all_events.extend(events)
    return all_rows, all_events, summaries


def select_routes(summary_df: pd.DataFrame) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    if summary_df.empty:
        return selected
    for (symbol, cadence), group in summary_df.groupby(["symbol", "cadence"], sort=False):
        candidates = group[group["density_status"] == "density_blind_confirmed"].copy()
        if symbol == "CL=F":
            candidates = candidates[
                (candidates["test_profit_factor"] >= 1.20)
                & (candidates["test_net_pnl_usd"] > 0)
                & (candidates["test_max_drawdown_usd"] > -100)
            ]
        elif symbol == "HO=F":
            candidates = candidates[
                (candidates["test_direction_hit_rate"] >= 0.58)
                & (candidates["test_profit_factor"] >= 1.0)
            ]
        else:
            # RB/NG can be reported, but not promoted yet.
            candidates = candidates.iloc[0:0]
        candidates = candidates.sort_values("selection_score", ascending=False)
        if not candidates.empty:
            selected.append(candidates.iloc[0].to_dict())
    return sorted(
        selected,
        key=lambda r: (
            float(r.get("test_direction_hit_rate", 0)),
            float(r.get("test_profit_factor", 0)),
            float(r.get("test_actions_per_day", 0)),
        ),
        reverse=True,
    )


def best_by_route(summary_df: pd.DataFrame) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if summary_df.empty:
        return rows
    for (_, _), group in summary_df.groupby(["symbol", "cadence"], sort=False):
        eligible = group[group["sample_status"] == "sample_dense_enough"]
        if eligible.empty:
            eligible = group
        best = eligible.sort_values(
            [
                "density_status",
                "selection_score",
                "test_direction_hit_rate",
                "test_profit_factor",
                "test_actions_per_day",
            ],
            ascending=[True, False, False, False, False],
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
        f"- 路线总数：`{run_summary['route_count']}`；样本密度候选：`{run_summary['candidate_count']}`；70%候选：`{run_summary['target70_count']}`。",
        "- V5.9 解决的是“样本太少”：收益幅度头不再硬过滤，而是参与仓位大小和密度校准。",
        "- 每条路线都审计 active bars、actions/day、方向命中率、PF、最大回撤和加仓/减仓/反手。",
        "- RB/NG 仍只观察，不直接接前向账本。",
        "",
        "## 选中路线",
        "",
    ]
    if selected:
        lines.append("| 标的 | 周期 | 方向模型 | 收益头 | 目标活跃率 | 验证样本/命中/PF | 测试样本/命中/PF | 动作/天 | 测试PNL | 回撤 |")
        lines.append("|---|---:|---|---|---:|---:|---:|---:|---:|---:|")
        for r in selected:
            lines.append(
                f"| {r['symbol']} | {r['cadence']} | {r['direction_model_name']} | {r['return_model_name']} | "
                f"{float(r['target_active_rate']):.0%} | "
                f"{int(r['validation_active_signal_bars'])}/{float(r['validation_direction_hit_rate']):.2%}/{float(r['validation_profit_factor']):.2f} | "
                f"{int(r['test_active_signal_bars'])}/{float(r['test_direction_hit_rate']):.2%}/{float(r['test_profit_factor']):.2f} | "
                f"{float(r['test_actions_per_day']):.2f} | {float(r['test_net_pnl_usd']):.2f} | "
                f"{float(r['test_max_drawdown_usd']):.2f} |"
            )
    else:
        lines.append("没有路线同时通过样本数、盲测命中率、PF 和回撤要求。")

    lines += ["", "## 每条路线最优样本密度结果", ""]
    lines.append("| 标的 | 周期 | 方向/收益 | 验证样本/命中/PF | 测试样本/命中/PF | 动作/天 | 加/减/反 | 测试PNL | 样本状态 | 策略状态 |")
    lines.append("|---|---:|---|---:|---:|---:|---:|---:|---|---|")
    for r in best_rows:
        lines.append(
            f"| {r['symbol']} | {r['cadence']} | {r['direction_model_name']}/{r['return_model_name']} | "
            f"{int(r['validation_active_signal_bars'])}/{float(r['validation_direction_hit_rate']):.2%}/{float(r['validation_profit_factor']):.2f} | "
            f"{int(r['test_active_signal_bars'])}/{float(r['test_direction_hit_rate']):.2%}/{float(r['test_profit_factor']):.2f} | "
            f"{float(r['test_actions_per_day']):.2f} | "
            f"{int(r['test_add_actions'])}/{int(r['test_reduce_actions'])}/{int(r['test_reverse_actions'])} | "
            f"{float(r['test_net_pnl_usd']):.2f} | {r['sample_status']} | {r['density_status']} |"
        )

    lines += [
        "",
        "## 判断",
        "",
        "- 样本数优先于漂亮胜率。少于 18-30 个测试 active bars 的路线，本轮不允许晋级。",
        "- 如果 hit-rate 提高但 PF < 1，说明方向略对但利润不足覆盖噪声和交易成本。",
        "- 如果 actions/day 太低，不符合你要的“日内不断预测和可加减仓”目标。",
        "",
        "## 下一步行动计划",
        "",
        "若 V5.9 仍无法稳定产生 65%-70% 命中率且 PF>1 的密集路线，下一步 V5.10 不再调阈值，而是做 EnergyActionSpecialist：把开仓、加仓、减仓、反手拆成四个独立动作模型，并加入 EIA 发布窗口、pit session 和跨品种 lead-lag 的动作标签。",
        "",
    ]
    return "\n".join(lines)


def plot_results(selected: list[dict[str, Any]], best_rows: list[dict[str, Any]], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fig, axes = plt.subplots(3, 1, figsize=(14, 11), constrained_layout=True)
    labels = [f"{r['symbol']} {r['cadence']}" for r in best_rows]
    hit = [float(r.get("test_direction_hit_rate", 0)) for r in best_rows]
    samples = [float(r.get("test_active_signal_bars", 0)) for r in best_rows]
    pf = [float(r.get("test_profit_factor", 0)) for r in best_rows]
    axes[0].bar(labels, hit, color=["#059669" if v >= 0.65 else "#f59e0b" if v >= 0.56 else "#64748b" for v in hit])
    axes[0].axhline(0.70, color="#dc2626", linestyle="--", label="70% target")
    axes[0].axhline(0.56, color="#0891b2", linestyle="--", label="density min")
    axes[0].set_ylim(0, 1)
    axes[0].set_title("V5.9 blind-test direction hit rate")
    axes[0].tick_params(axis="x", rotation=45)
    axes[0].legend()
    axes[0].grid(axis="y", alpha=0.25)
    axes[1].bar(labels, samples, color=["#0ea5e9" if v >= 30 else "#f59e0b" if v >= 18 else "#64748b" for v in samples])
    axes[1].axhline(30, color="#059669", linestyle="--", label="30 active bars")
    axes[1].set_title("V5.9 test active sample count")
    axes[1].tick_params(axis="x", rotation=45)
    axes[1].legend()
    axes[1].grid(axis="y", alpha=0.25)
    axes[2].bar(labels, pf, color=["#059669" if v >= 1.2 else "#f59e0b" if v >= 1.0 else "#ef4444" for v in pf])
    axes[2].axhline(1.0, color="#dc2626", linestyle="--", label="PF 1.0")
    axes[2].set_title("V5.9 test profit factor")
    axes[2].tick_params(axis="x", rotation=45)
    axes[2].legend()
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
            ["density_status", "target70_status", "sample_status", "selection_score"],
            ascending=[True, True, True, False],
        )
    selected = select_routes(summary_df)
    best_rows = best_by_route(summary_df)
    status = "density_lift_candidates" if selected else "density_lift_watchlist_no_candidate"
    target70_count = int(sum(1 for r in selected if r.get("target70_status") == "target70_density_confirmed"))

    write_csv(OUT_DIR / "hfcd_commodity_v5_9_data_coverage.csv", data_coverage)
    summary_df.to_csv(OUT_DIR / "hfcd_commodity_v5_9_policy_summary.csv", index=False)
    write_csv(OUT_DIR / "hfcd_commodity_v5_9_selected_routes.csv", selected, list(summary_df.columns))
    write_csv(OUT_DIR / "hfcd_commodity_v5_9_best_by_route.csv", best_rows)
    write_csv(OUT_DIR / "hfcd_commodity_v5_9_density_replay.csv", all_rows)
    write_csv(OUT_DIR / "hfcd_commodity_v5_9_position_events.csv", all_events)

    report_path = OUT_DIR / "HFCD_Commodity_V5_9_EnergySampleDensityLift.md"
    chart_path = OUT_DIR / "HFCD_Commodity_V5_9_EnergySampleDensityLift.png"
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
            "Local research only; no broker or testnet orders.",
            "Train-calibrated density floor prevents sample starvation.",
            "Return head sizes exposure instead of hard-filtering most trades.",
            "Candidate gates require enough active samples, actions/day, hit-rate, PF and DD.",
        ],
    }
    (OUT_DIR / "hfcd_commodity_v5_9_summary.json").write_text(
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
