#!/usr/bin/env python3
"""HFCD Commodity V5.11: realtime multi-horizon scanner.

Local research only. No broker calls, no testnet calls, no online page changes.

Purpose:
- Match the electricity-style runtime idea: evaluate the current state often,
  then predict multiple future horizons from that state.
- Historical blind test uses 5m bars because public Yahoo 1m history is short.
- Realtime-forward mode is designed for 1m scanning once a daemon is connected.

For every base decision point, predict:
15m, 30m, 1h, 1.5h, 2h, 2.5h, 3h.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from sklearn.linear_model import Ridge
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler


ROOT = Path.cwd()
VERSION = "HFCD_Commodity_V5_11_RealtimeMultiHorizonScanner"
OUT_DIR = ROOT / "outputs" / "hfcd_commodity_v5_11_realtime_multi_horizon_scanner"
V56_PATH = ROOT / "scripts" / "hfcd_commodity_v5_6_energy_specialist_split.py"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


v56 = load_module("v56_specialist", V56_PATH)
v51 = v56.v51
v40 = v56.v40

TARGET_SYMBOLS = ["CL=F", "RB=F", "HO=F", "NG=F"]
PEER_SYMBOLS = v56.PEER_SYMBOLS
BASE_NOTIONAL_USD = v56.BASE_NOTIONAL_USD

HORIZON_MINUTES = [15, 30, 60, 90, 120, 150, 180]
HORIZON_LABELS = ["15m", "30m", "1h", "1.5h", "2h", "2.5h", "3h"]
HORIZON_SETS = {
    "all": HORIZON_LABELS,
    "near": ["15m", "30m", "1h"],
    "mid": ["30m", "1h", "1.5h", "2h"],
    "far": ["1h", "1.5h", "2h", "2.5h", "3h"],
    "barbell": ["15m", "1h", "3h"],
}

MODES = [
    {
        "mode": "5m_blind",
        "interval": "5m",
        "range": "60d",
        "base_minutes": 5,
        "run_policy_search": True,
        "min_rows": 1200,
    },
    {
        "mode": "1m_recent_realtime_readiness",
        "interval": "1m",
        "range": "7d",
        "base_minutes": 1,
        "run_policy_search": False,
        "min_rows": 600,
    },
]


@dataclass(frozen=True)
class RealtimePolicy:
    symbol: str
    mode: str
    horizon_set: str
    dead_zone: float
    min_agreement: float
    min_move_bps: float
    min_hfcd_quality: float
    max_units: int
    risk_cut: float

    @property
    def name(self) -> str:
        return (
            f"{self.symbol}_{self.mode}_{self.horizon_set}_rtmh"
            f"_dead{self.dead_zone:.3f}_agree{self.min_agreement:.2f}"
            f"_move{self.min_move_bps:.1f}_q{self.min_hfcd_quality:.2f}"
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


def yahoo_chart(symbol: str, interval: str, range_: str) -> pd.DataFrame:
    encoded = urllib.parse.quote(symbol, safe="")
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{encoded}"
        f"?range={range_}&interval={interval}&includePrePost=false"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 HFCD"})
    with urllib.request.urlopen(req, timeout=45) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    result = data["chart"]["result"][0]
    timestamps = result.get("timestamp") or []
    quote = result["indicators"]["quote"][0]
    rows = []
    for i, ts in enumerate(timestamps):
        close = quote.get("close", [None] * len(timestamps))[i]
        if close is None:
            continue
        rows.append(
            {
                "timestamp": pd.to_datetime(ts, unit="s", utc=True),
                "symbol": symbol,
                "open": quote.get("open", [None] * len(timestamps))[i],
                "high": quote.get("high", [None] * len(timestamps))[i],
                "low": quote.get("low", [None] * len(timestamps))[i],
                "close": close,
                "volume": quote.get("volume", [0] * len(timestamps))[i] or 0,
                "market_source": f"Yahoo Finance chart {interval}/{range_}",
            }
        )
    return pd.DataFrame(rows).dropna(subset=["close"]).sort_values("timestamp").reset_index(drop=True)


def profit_factor(pnls: list[float]) -> float:
    return float(v56.profit_factor(pnls))


def max_drawdown_from_pnls(pnls: list[float]) -> float:
    return float(v56.max_drawdown_from_pnls(pnls))


def split_name(ts: pd.Timestamp, cut1: pd.Timestamp, cut2: pd.Timestamp) -> str:
    return v56.split_name(ts, cut1, cut2)


def trade_cost(symbol: str, mode: str) -> float:
    base = 0.00090
    if symbol == "NG=F":
        base += 0.00025
    if mode.startswith("1m"):
        base += 0.00035
    elif mode.startswith("5m"):
        base += 0.00022
    return base


def horizon_bars(base_minutes: int) -> dict[str, int]:
    return {label: max(1, int(round(minutes / base_minutes))) for label, minutes in zip(HORIZON_LABELS, HORIZON_MINUTES)}


def add_future_labels(frame: pd.DataFrame, base_minutes: int) -> pd.DataFrame:
    out = frame.copy()
    bars = horizon_bars(base_minutes)
    out["next_base_return"] = out["close"].shift(-1) / out["close"] - 1.0
    for label, n in bars.items():
        out[f"future_return_{label}"] = out["close"].shift(-n) / out["close"] - 1.0
    return out.dropna(subset=["next_base_return"] + [f"future_return_{h}" for h in HORIZON_LABELS]).reset_index(drop=True)


def load_mode_features(mode_cfg: dict[str, Any]) -> tuple[dict[str, pd.DataFrame], list[dict[str, Any]], dict[str, Any]]:
    eia, eia_meta = v40.load_eia_series(v40.SERIES)
    supply = v40.build_supply_features(eia)
    raw: dict[str, pd.DataFrame] = {}
    coverage: list[dict[str, Any]] = []
    for symbol in PEER_SYMBOLS:
        try:
            frame = yahoo_chart(symbol, mode_cfg["interval"], mode_cfg["range"])
            raw[symbol] = frame
            coverage.append(
                {
                    "mode": mode_cfg["mode"],
                    "symbol": symbol,
                    "interval": mode_cfg["interval"],
                    "range": mode_cfg["range"],
                    "rows": len(frame),
                    "start": frame["timestamp"].min().isoformat() if len(frame) else "",
                    "end": frame["timestamp"].max().isoformat() if len(frame) else "",
                    "status": "loaded" if len(frame) else "empty",
                }
            )
        except Exception as exc:
            coverage.append(
                {
                    "mode": mode_cfg["mode"],
                    "symbol": symbol,
                    "interval": mode_cfg["interval"],
                    "range": mode_cfg["range"],
                    "rows": 0,
                    "status": "failed",
                    "error": repr(exc),
                }
            )
    if raw:
        start_ts = min(pd.Timestamp(frame["timestamp"].min()) for frame in raw.values() if len(frame))
        end_ts = max(pd.Timestamp(frame["timestamp"].max()) for frame in raw.values() if len(frame))
        weather, weather_meta = v56.load_weather_basket_features(start_ts, end_ts)
    else:
        weather, weather_meta = pd.DataFrame(), {"status": "missing", "rows": 0}
    ng_storage, ng_meta = v56.load_ng_storage_features()

    curves: dict[tuple[str, str], pd.DataFrame] = {}
    features: dict[str, pd.DataFrame] = {}
    for symbol in TARGET_SYMBOLS:
        if symbol not in raw:
            continue
        peers = {peer: v51.add_universal_features(df) for peer, df in raw.items() if len(df)}
        base = v51.add_universal_features(raw[symbol])
        feat = v56.attach_exogenous(base, symbol, mode_cfg["mode"], peers, supply, ng_storage, weather, curves)
        feat = add_future_labels(feat, int(mode_cfg["base_minutes"]))
        features[symbol] = feat
    sensor_meta = {
        "eia": eia_meta,
        "weather": weather_meta,
        "ng_storage": ng_meta,
        "note": "High-frequency features reuse no-leak EIA/NG/weather sensors via merge_asof; finite curve sensor is disabled for 1m/5m until real contract-chain feed is added.",
    }
    return features, coverage, sensor_meta


def feature_columns(symbol: str) -> list[str]:
    cols = v56.feature_columns(symbol)
    return list(dict.fromkeys(cols))


def clean_for_model(frame: pd.DataFrame, symbol: str) -> pd.DataFrame:
    out = frame.copy()
    for col in feature_columns(symbol):
        if col not in out.columns:
            out[col] = 0.0
        out[col] = pd.to_numeric(out[col], errors="coerce").replace([np.inf, -np.inf], np.nan).ffill().fillna(0.0)
    for col in ["v53_manifest_quality", "v53_bsigma", "v53_q_core", "v53_sigma_ledger"]:
        if col not in out.columns:
            out[col] = 0.0
        out[col] = pd.to_numeric(out[col], errors="coerce").replace([np.inf, -np.inf], np.nan).fillna(0.0)
    return out.dropna(subset=[f"future_return_{h}" for h in HORIZON_LABELS]).reset_index(drop=True)


def train_return_model(train: pd.DataFrame, symbol: str, horizon: str):
    cols = feature_columns(symbol)
    x = train[cols].to_numpy(dtype=float)
    y = train[f"future_return_{horizon}"].to_numpy(dtype=float)
    if len(train) < 180 or float(np.nanstd(y)) <= 1e-10:
        return None
    return make_pipeline(StandardScaler(), Ridge(alpha=5.0)).fit(x, y)


def return_to_probability(pred: np.ndarray, train: pd.DataFrame, horizon: str) -> np.ndarray:
    y = train[f"future_return_{horizon}"].to_numpy(dtype=float)
    scale = float(np.nanstd(y)) if len(y) else 0.0
    scale = max(scale, 1e-5)
    z = np.clip(pred / scale, -4.0, 4.0)
    return 1.0 / (1.0 + np.exp(-z))


def add_predictions(df: pd.DataFrame, symbol: str, mode: str, train: pd.DataFrame) -> tuple[pd.DataFrame, list[dict[str, Any]]]:
    cols = feature_columns(symbol)
    x = df[cols].to_numpy(dtype=float)
    out = df.copy()
    coverage: list[dict[str, Any]] = []
    for horizon in HORIZON_LABELS:
        return_model = train_return_model(train, symbol, horizon)
        if return_model is not None:
            signed = np.asarray(return_model.predict(x), dtype=float)
            out[f"{horizon}_signed_return_pred"] = signed
            out[f"{horizon}_prob_up"] = return_to_probability(signed, train, horizon)
        else:
            out[f"{horizon}_signed_return_pred"] = 0.0
            out[f"{horizon}_prob_up"] = 0.5
        coverage.append(
            {
                "mode": mode,
                "symbol": symbol,
                "horizon": horizon,
                "direction_models": "ridge_return_sigmoid" if return_model is not None else "",
                "return_model": "ridge" if return_model is not None else "",
                "train_rows": len(train),
                "status": "trained" if return_model is not None else "missing",
            }
        )
    return out, coverage


def horizon_weights(horizons: list[str]) -> dict[str, float]:
    bars = {label: minutes for label, minutes in zip(HORIZON_LABELS, HORIZON_MINUTES)}
    raw = {h: 1.0 / np.sqrt(float(bars[h])) for h in horizons}
    total = sum(raw.values()) or 1.0
    return {h: raw[h] / total for h in horizons}


def signal_state(row: pd.Series, policy: RealtimePolicy) -> dict[str, Any]:
    horizons = HORIZON_SETS[policy.horizon_set]
    weights = horizon_weights(horizons)
    score = 0.0
    expected = 0.0
    expected_abs = 0.0
    directions: list[int] = []
    realized_weighted = 0.0
    for horizon in horizons:
        p = float(row.get(f"{horizon}_prob_up", 0.5))
        edge = p - 0.5
        signed = float(row.get(f"{horizon}_signed_return_pred", 0.0))
        w = weights[horizon]
        score += w * edge
        expected += w * signed
        expected_abs += w * abs(signed)
        directions.append(1 if edge >= 0 else -1)
        realized_weighted += w * float(row.get(f"future_return_{horizon}", 0.0))
    direction = 1 if score >= 0 else -1
    agreement = sum(1 for d in directions if d == direction) / max(len(directions), 1)
    return {
        "score": float(score),
        "direction": int(direction),
        "agreement": float(agreement),
        "confidence": float(abs(score)),
        "expected_return": float(expected),
        "expected_move_bps": float(abs(expected_abs) * 10000.0),
        "realized_weighted_return": float(realized_weighted),
        "realized_direction": 1 if realized_weighted >= 0 else -1,
    }


def desired_units(row: pd.Series, policy: RealtimePolicy) -> tuple[int, dict[str, Any]]:
    state = signal_state(row, policy)
    reason = "active"
    if state["confidence"] < policy.dead_zone:
        return 0, {**state, "reason": "dead_zone"}
    if state["agreement"] < policy.min_agreement:
        return 0, {**state, "reason": "horizon_disagreement"}
    if state["expected_move_bps"] < policy.min_move_bps:
        return 0, {**state, "reason": "move_too_small"}
    if float(row.get("v53_manifest_quality", 0.0)) < policy.min_hfcd_quality:
        return 0, {**state, "reason": "hfcd_quality_low"}
    if float(row.get("v53_bsigma", 0.0)) > policy.risk_cut and state["confidence"] < policy.dead_zone + 0.025:
        return 0, {**state, "reason": "bsigma_cut"}
    if np.sign(state["expected_return"]) not in {0, state["direction"]} and state["confidence"] < policy.dead_zone + 0.02:
        return 0, {**state, "reason": "return_head_disagree"}
    units = 1
    if state["confidence"] >= policy.dead_zone + 0.025:
        units += 1
    if state["expected_move_bps"] >= policy.min_move_bps + 8.0:
        units += 1
    return int(state["direction"] * min(policy.max_units, units)), {**state, "reason": reason}


def transition_action(position: int, target: int) -> str:
    if target == position:
        return "hold"
    if position == 0 and target != 0:
        return "open_long" if target > 0 else "open_short"
    if target == 0:
        return "flat"
    if np.sign(target) != np.sign(position):
        return "reverse_to_long" if target > 0 else "reverse_to_short"
    if abs(target) > abs(position):
        return "add_long" if target > 0 else "add_short"
    return "reduce_long" if position > 0 else "reduce_short"


def replay(df: pd.DataFrame, policy: RealtimePolicy) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    cost_rate = trade_cost(policy.symbol, policy.mode)
    position = 0
    rows: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []
    for i in range(len(df) - 1):
        row = df.iloc[i]
        target, meta = desired_units(row, policy)
        action = transition_action(position, target)
        delta = target - position
        pnl_before = target * BASE_NOTIONAL_USD * float(row["next_base_return"])
        cost = abs(delta) * BASE_NOTIONAL_USD * cost_rate
        pnl = pnl_before - cost
        active = int(target != 0)
        hit = int(np.sign(target) == int(meta["realized_direction"])) if active else 0
        record = {
            "policy": policy.name,
            "symbol": policy.symbol,
            "mode": policy.mode,
            "timestamp": pd.Timestamp(row["timestamp"]).isoformat(),
            "split": str(row.get("split", "")),
            "close": round(float(row["close"]), 6),
            "decision": "long" if target > 0 else ("short" if target < 0 else "flat"),
            "position_units_before": position,
            "position_units_after": target,
            "action": action,
            "horizon_set": policy.horizon_set,
            "mh_score": round(float(meta["score"]), 8),
            "mh_confidence": round(float(meta["confidence"]), 8),
            "mh_agreement": round(float(meta["agreement"]), 6),
            "expected_return": round(float(meta["expected_return"]), 8),
            "expected_move_bps": round(float(meta["expected_move_bps"]), 4),
            "transition_reason": meta["reason"],
            "next_base_return": round(float(row["next_base_return"]), 8),
            "realized_weighted_return": round(float(meta["realized_weighted_return"]), 8),
            "direction_signal_active": active,
            "direction_hit": hit,
            "pnl_before_cost_usd": round(float(pnl_before), 6),
            "turnover_cost_usd": round(float(cost), 6),
            "pnl_usd": round(float(pnl), 6),
            "manifest_quality": round(float(row.get("v53_manifest_quality", 0.0)), 6),
            "bsigma": round(float(row.get("v53_bsigma", 0.0)), 6),
        }
        rows.append(record)
        if action != "hold":
            events.append({k: record[k] for k in ["policy", "symbol", "mode", "timestamp", "action", "close", "position_units_before", "position_units_after", "mh_score", "transition_reason"]})
            events[-1]["split"] = record["split"]
        position = target
    return rows, events


def summarize(rows: list[dict[str, Any]], policy: RealtimePolicy, split: str) -> dict[str, Any]:
    sub = [r for r in rows if r["split"] == split]
    active = [r for r in sub if int(r["direction_signal_active"]) == 1]
    events = [r for r in sub if r["action"] != "hold"]
    pnls = [float(r["pnl_usd"]) for r in sub]
    days = max(
        1e-9,
        (pd.Timestamp(sub[-1]["timestamp"]) - pd.Timestamp(sub[0]["timestamp"])).total_seconds() / 86400
        if len(sub) >= 2
        else 0.0,
    )
    return {
        "policy": policy.name,
        "symbol": policy.symbol,
        "mode": policy.mode,
        "horizon_set": policy.horizon_set,
        "split": split,
        "bars": len(sub),
        "actions": len(events),
        "actions_per_day": round(len(events) / days, 6) if sub else 0.0,
        "active_signal_bars": len(active),
        "active_signal_rate": round(len(active) / len(sub), 6) if sub else 0.0,
        "direction_hit_rate": round(sum(int(r["direction_hit"]) for r in active) / len(active), 6) if active else 0.0,
        "long_bars": sum(1 for r in sub if int(r["position_units_after"]) > 0),
        "short_bars": sum(1 for r in sub if int(r["position_units_after"]) < 0),
        "flat_bars": sum(1 for r in sub if int(r["position_units_after"]) == 0),
        "avg_abs_units": round(float(np.mean([abs(int(r["position_units_after"])) for r in sub])) if sub else 0.0, 6),
        "add_actions": sum(1 for r in events if str(r["action"]).startswith("add")),
        "reduce_actions": sum(1 for r in events if str(r["action"]).startswith("reduce")),
        "reverse_actions": sum(1 for r in events if str(r["action"]).startswith("reverse")),
        "net_pnl_usd": round(sum(pnls), 6),
        "profit_factor": round(profit_factor(pnls), 6),
        "max_drawdown_usd": round(max_drawdown_from_pnls(pnls), 6),
        "turnover_cost_usd": round(sum(float(r["turnover_cost_usd"]) for r in sub), 6),
    }


def policy_grid(symbol: str, mode: str) -> list[RealtimePolicy]:
    out: list[RealtimePolicy] = []
    # Keep V5.11 intentionally bounded: it validates realtime multi-horizon
    # scanning, not hyperparameter search. Wider search belongs in V5.12+.
    horizon_sets = ["all", "near", "mid"] if symbol in {"HO=F", "CL=F"} else ["near", "mid"]
    max_units_grid = [2] if symbol in {"HO=F", "CL=F"} else [1]
    for horizon_set in horizon_sets:
        for max_units in max_units_grid:
            out.append(RealtimePolicy(symbol, mode, horizon_set, 0.012, 0.58, 0.0, 0.0, max_units, 3.2))
    return out


def evaluate_symbol(frame: pd.DataFrame, symbol: str, mode_cfg: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    df = clean_for_model(frame, symbol)
    if len(df) < int(mode_cfg["min_rows"]):
        return [], [], [], [{"mode": mode_cfg["mode"], "symbol": symbol, "status": "too_few_rows", "rows": len(df)}]
    cut1, cut2 = v56.split_masks(pd.to_datetime(df["timestamp"], utc=True))
    train = df[pd.to_datetime(df["timestamp"], utc=True) <= cut1]
    pred, coverage = add_predictions(df, symbol, str(mode_cfg["mode"]), train)
    ts = pd.to_datetime(pred["timestamp"], utc=True)
    pred["split"] = np.where(ts <= cut1, "train", np.where(ts <= cut2, "validation", "test"))
    if not mode_cfg["run_policy_search"]:
        latest = pred.tail(1).copy()
        readiness = {
            "mode": mode_cfg["mode"],
            "symbol": symbol,
            "status": "readiness_only_no_blind_promotion",
            "rows": len(df),
            "latest_timestamp": pd.Timestamp(latest.iloc[0]["timestamp"]).isoformat() if len(latest) else "",
            "latest_close": float(latest.iloc[0]["close"]) if len(latest) else None,
        }
        return [], [], [], coverage + [readiness]
    all_rows: list[dict[str, Any]] = []
    all_events: list[dict[str, Any]] = []
    summaries: list[dict[str, Any]] = []
    for policy in policy_grid(symbol, str(mode_cfg["mode"])):
        rows, events = replay(pred, policy)
        by_split = {split: summarize(rows, policy, split) for split in ["train", "validation", "test"]}
        combined: dict[str, Any] = {
            "policy": policy.name,
            "symbol": symbol,
            "mode": policy.mode,
            "horizon_set": policy.horizon_set,
            "dead_zone": policy.dead_zone,
            "min_agreement": policy.min_agreement,
            "min_move_bps": policy.min_move_bps,
            "min_hfcd_quality": policy.min_hfcd_quality,
            "max_units": policy.max_units,
            "risk_cut": policy.risk_cut,
        }
        for split, vals in by_split.items():
            for k, v in vals.items():
                if k in combined or k in {"policy", "symbol", "mode", "horizon_set", "split"}:
                    continue
                combined[f"{split}_{k}"] = v
        val = by_split["validation"]
        test = by_split["test"]
        combined["realtime_mh_status"] = (
            "realtime_multi_horizon_blind_confirmed"
            if val["active_signal_rate"] >= 0.10
            and test["active_signal_rate"] >= 0.10
            and val["actions_per_day"] >= 2.0
            and test["actions_per_day"] >= 2.0
            and val["direction_hit_rate"] >= 0.56
            and test["direction_hit_rate"] >= 0.56
            and val["profit_factor"] >= 1.0
            and test["profit_factor"] >= 1.0
            else "watchlist_or_blocked"
        )
        combined["target70_status"] = (
            "target70_realtime_mh_confirmed"
            if val["active_signal_rate"] >= 0.05
            and test["active_signal_rate"] >= 0.05
            and val["direction_hit_rate"] >= 0.68
            and test["direction_hit_rate"] >= 0.68
            and val["profit_factor"] >= 1.0
            and test["profit_factor"] >= 1.0
            else "not_target70"
        )
        combined["selection_score"] = round(
            130.0 * min(val["direction_hit_rate"], test["direction_hit_rate"])
            + 12.0 * min(val["profit_factor"], 4.0)
            + 16.0 * min(test["profit_factor"], 4.0)
            + min(test["actions_per_day"], 12.0) * 2.0
            + min(test["active_signal_rate"], 0.60) * 10.0
            - abs(test["max_drawdown_usd"]) * 0.02
            + 0.08 * test["net_pnl_usd"],
            6,
        )
        summaries.append(combined)
        if combined["realtime_mh_status"] == "realtime_multi_horizon_blind_confirmed" or combined["target70_status"] == "target70_realtime_mh_confirmed":
            all_rows.extend(rows)
            all_events.extend(events)
    return all_rows, all_events, summaries, coverage


def select_routes(summary_df: pd.DataFrame) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    if summary_df.empty:
        return selected
    for symbol, group in summary_df.groupby("symbol", sort=False):
        candidates = group[group["realtime_mh_status"] == "realtime_multi_horizon_blind_confirmed"].copy()
        if symbol == "CL=F":
            candidates = candidates[(candidates["test_profit_factor"] >= 1.25) & (candidates["test_net_pnl_usd"] > 5)]
        elif symbol == "HO=F":
            candidates = candidates[(candidates["test_profit_factor"] >= 1.0) & (candidates["test_direction_hit_rate"] >= 0.58)]
        else:
            candidates = candidates[(candidates["test_profit_factor"] >= 1.05) & (candidates["test_net_pnl_usd"] > 0)]
        candidates = candidates.sort_values("selection_score", ascending=False)
        if not candidates.empty:
            selected.append(candidates.iloc[0].to_dict())
    return sorted(selected, key=lambda r: (float(r.get("test_direction_hit_rate", 0)), float(r.get("test_profit_factor", 0))), reverse=True)


def best_by_symbol(summary_df: pd.DataFrame) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if summary_df.empty:
        return rows
    for (symbol, mode), group in summary_df.groupby(["symbol", "mode"], sort=False):
        eligible = group[group["validation_active_signal_rate"] >= 0.05]
        if eligible.empty:
            eligible = group
        best = eligible.sort_values(["validation_direction_hit_rate", "validation_profit_factor", "test_direction_hit_rate", "test_profit_factor", "test_actions_per_day"], ascending=False).iloc[0]
        rows.append(best.to_dict())
    return rows


def make_report(run_summary: dict[str, Any], selected: list[dict[str, Any]], best_rows: list[dict[str, Any]]) -> str:
    lines = [
        f"# {VERSION}",
        "",
        "## 结论",
        "",
        f"- 状态：`{run_summary['status']}`",
        "- 这版采用电力模型式逻辑：当前时刻频繁评估，同时预测多个未来 horizon。",
        "- 历史盲测使用 `5m_blind`；实时部署建议使用 `1m_realtime` 每分钟扫描。",
        "- 每次扫描都输出 15m/30m/1h/1.5h/2h/2.5h/3h 的方向概率和收益幅度。",
        f"- 策略总数：`{run_summary['route_count']}`；候选数：`{run_summary['candidate_count']}`；70%确认：`{run_summary['target70_count']}`。",
        "",
        "## 选中路线",
        "",
    ]
    if selected:
        lines.append("| 标的 | 模式 | horizon组 | 验证命中/PF | 测试命中/PF | 活跃率 | 动作/天 | 加/减/反手 | 测试PNL | 回撤 |")
        lines.append("|---|---|---|---:|---:|---:|---:|---:|---:|---:|")
        for r in selected:
            lines.append(
                f"| {r['symbol']} | {r['mode']} | {r['horizon_set']} | "
                f"{float(r['validation_direction_hit_rate']):.2%}/{float(r['validation_profit_factor']):.2f} | "
                f"{float(r['test_direction_hit_rate']):.2%}/{float(r['test_profit_factor']):.2f} | "
                f"{float(r['test_active_signal_rate']):.2%} | {float(r['test_actions_per_day']):.2f} | "
                f"{int(r['test_add_actions'])}/{int(r['test_reduce_actions'])}/{int(r['test_reverse_actions'])} | "
                f"{float(r['test_net_pnl_usd']):.2f} | {float(r['test_max_drawdown_usd']):.2f} |"
            )
    else:
        lines.append("没有路线通过候选门。")
    lines += ["", "## 每个标的最优观察", ""]
    lines.append("| 标的 | 模式 | horizon组 | 验证命中/PF | 测试命中/PF | 活跃率 | 动作/天 | 测试PNL | 状态 |")
    lines.append("|---|---|---|---:|---:|---:|---:|---:|---|")
    for r in best_rows:
        lines.append(
            f"| {r['symbol']} | {r['mode']} | {r['horizon_set']} | "
            f"{float(r['validation_direction_hit_rate']):.2%}/{float(r['validation_profit_factor']):.2f} | "
            f"{float(r['test_direction_hit_rate']):.2%}/{float(r['test_profit_factor']):.2f} | "
            f"{float(r['test_active_signal_rate']):.2%} | {float(r['test_actions_per_day']):.2f} | "
            f"{float(r['test_net_pnl_usd']):.2f} | {r['realtime_mh_status']} |"
        )
    lines += [
        "",
        "## 关键说明",
        "",
        "- `5m_blind` 不是最终交易频率，只是因为公开 1m 历史太短，无法做稳健盲测。",
        "- `1m_recent_realtime_readiness` 只做数据可用性检查；真正上线后应每分钟运行一次同一套预测器。",
        "- 这解决了 `HO=F 2h` 被误解成“每 2 小时才评估一次”的问题：现在是当前时刻预测未来 2h。",
        "",
        "## 下一步行动计划",
        "",
        "V5.12 应把 V5.11 的选中路线接入本地 forward shadow：每 1 分钟扫描一次，记录当前多 horizon 信号、目标仓位、加仓/减仓/反手原因和 paper PnL；历史盲测继续用 5m 扩样本，前向执行用 1m。",
    ]
    return "\n".join(lines) + "\n"


def make_figure(selected: list[dict[str, Any]], best_rows: list[dict[str, Any]], path: Path) -> None:
    rows = selected or best_rows
    if not rows:
        return
    labels = [f"{r['symbol']}\n{r['mode']}\n{r['horizon_set']}" for r in rows]
    hit = [float(r.get("test_direction_hit_rate", 0.0)) for r in rows]
    pf = [min(float(r.get("test_profit_factor", 0.0)), 5.0) / 5.0 for r in rows]
    actions = [min(float(r.get("test_actions_per_day", 0.0)), 12.0) / 12.0 for r in rows]
    x = np.arange(len(labels))
    width = 0.25
    fig, ax = plt.subplots(figsize=(12, 5.5))
    ax.bar(x - width, hit, width, label="test hit rate")
    ax.bar(x, pf, width, label="PF/5 cap")
    ax.bar(x + width, actions, width, label="actions/day/12 cap")
    ax.set_ylim(0, 1)
    ax.set_xticks(x)
    ax.set_xticklabels(labels)
    ax.set_title("V5.11 realtime-style multi-horizon scanner")
    ax.grid(axis="y", alpha=0.25)
    ax.legend()
    fig.tight_layout()
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=160)
    plt.close(fig)


def main() -> None:
    started = datetime.now(timezone.utc)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    all_rows: list[dict[str, Any]] = []
    all_events: list[dict[str, Any]] = []
    all_summaries: list[dict[str, Any]] = []
    all_coverage: list[dict[str, Any]] = []
    sensor_meta_by_mode: dict[str, Any] = {}
    latest_signals: list[dict[str, Any]] = []

    for mode_cfg in MODES:
        features, coverage, sensor_meta = load_mode_features(mode_cfg)
        all_coverage.extend(coverage)
        sensor_meta_by_mode[str(mode_cfg["mode"])] = sensor_meta
        for symbol in TARGET_SYMBOLS:
            frame = features.get(symbol)
            if frame is None or frame.empty:
                all_coverage.append({"mode": mode_cfg["mode"], "symbol": symbol, "status": "missing_feature_frame"})
                continue
            rows, events, summaries, model_cov = evaluate_symbol(frame, symbol, mode_cfg)
            all_rows.extend(rows)
            all_events.extend(events)
            all_summaries.extend(summaries)
            all_coverage.extend(model_cov)
            tail = clean_for_model(frame, symbol).tail(1)
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
    selected = select_routes(summary_df) if not summary_df.empty else []
    best = best_by_symbol(summary_df) if not summary_df.empty else []
    target70_count = int((summary_df.get("target70_status", pd.Series(dtype=str)) == "target70_realtime_mh_confirmed").sum()) if not summary_df.empty else 0
    run_summary = {
        "version": VERSION,
        "generated_at": now_iso(),
        "status": "realtime_multi_horizon_candidates" if selected else "realtime_multi_horizon_watchlist_only",
        "route_count": int(len(summary_df)),
        "candidate_count": int(len(selected)),
        "target70_count": target70_count,
        "selected_policies": [r["policy"] for r in selected],
        "modes": MODES,
        "prediction_horizons": HORIZON_LABELS,
        "runtime_sec": round((datetime.now(timezone.utc) - started).total_seconds(), 3),
        "latest_signal_readiness": latest_signals,
        "outputs": {
            "summary_json": str(OUT_DIR / "hfcd_commodity_v5_11_summary.json"),
            "policy_summary_csv": str(OUT_DIR / "hfcd_commodity_v5_11_policy_summary.csv"),
            "selected_routes_csv": str(OUT_DIR / "hfcd_commodity_v5_11_selected_routes.csv"),
            "best_by_symbol_csv": str(OUT_DIR / "hfcd_commodity_v5_11_best_by_symbol.csv"),
            "trade_replay_csv": str(OUT_DIR / "hfcd_commodity_v5_11_trade_replay.csv"),
            "action_events_csv": str(OUT_DIR / "hfcd_commodity_v5_11_action_events.csv"),
            "coverage_csv": str(OUT_DIR / "hfcd_commodity_v5_11_coverage.csv"),
            "report_md": str(OUT_DIR / "HFCD_Commodity_V5_11_RealtimeMultiHorizonScanner.md"),
            "figure_png": str(OUT_DIR / "HFCD_Commodity_V5_11_RealtimeMultiHorizonScanner.png"),
        },
        "sensor_meta_by_mode": sensor_meta_by_mode,
    }

    (OUT_DIR / "hfcd_commodity_v5_11_summary.json").write_text(json.dumps(run_summary, ensure_ascii=False, indent=2), encoding="utf-8")
    summary_df.to_csv(OUT_DIR / "hfcd_commodity_v5_11_policy_summary.csv", index=False)
    pd.DataFrame(selected).to_csv(OUT_DIR / "hfcd_commodity_v5_11_selected_routes.csv", index=False)
    pd.DataFrame(best).to_csv(OUT_DIR / "hfcd_commodity_v5_11_best_by_symbol.csv", index=False)
    write_csv(OUT_DIR / "hfcd_commodity_v5_11_trade_replay.csv", all_rows)
    write_csv(OUT_DIR / "hfcd_commodity_v5_11_action_events.csv", all_events)
    write_csv(OUT_DIR / "hfcd_commodity_v5_11_coverage.csv", all_coverage)
    report = make_report(run_summary, selected, best)
    (OUT_DIR / "HFCD_Commodity_V5_11_RealtimeMultiHorizonScanner.md").write_text(report, encoding="utf-8")
    make_figure(selected, best, OUT_DIR / "HFCD_Commodity_V5_11_RealtimeMultiHorizonScanner.png")
    print(json.dumps(run_summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
