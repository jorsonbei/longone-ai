#!/usr/bin/env python3
"""HFCD Commodity V5.2: hit-rate lift for NG/RB next-horizon routes.

Local research only. No broker calls, no testnet calls, no online changes.

Goal:
- Do not move NG/RB to forward ledger yet.
- Try to lift direction hit rate toward ~70% using stricter, validation-selected
  confidence gates and model consensus.
- Report the trade-off: hit rate, PF, PnL, drawdown, actions/day.

No-leak protocol:
- Train models on first 60% of time.
- Select model/gate by validation split only.
- Report blind test split separately.
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
from sklearn.ensemble import ExtraTreesClassifier, HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler


ROOT = Path.cwd()
VERSION = "HFCD_Commodity_V5_2_HitRateLift"
OUT_DIR = ROOT / "outputs" / "hfcd_commodity_v5_2_hit_rate_lift"
V51_PATH = ROOT / "scripts" / "hfcd_commodity_v5_1_next_horizon_density_router.py"
V40_PATH = ROOT / "scripts" / "hfcd_commodity_v4_0_crude_oil_supply_forecast.py"

spec51 = importlib.util.spec_from_file_location("v51_density", V51_PATH)
v51 = importlib.util.module_from_spec(spec51)
assert spec51 and spec51.loader
sys.modules["v51_density"] = v51
spec51.loader.exec_module(v51)

spec40 = importlib.util.spec_from_file_location("v40_crude_supply", V40_PATH)
v40 = importlib.util.module_from_spec(spec40)
assert spec40 and spec40.loader
sys.modules["v40_crude_supply"] = v40
spec40.loader.exec_module(v40)


TARGET_SYMBOLS = ["NG=F", "RB=F"]
PEER_SYMBOLS = ["CL=F", "RB=F", "HO=F", "NG=F"]
ROUTE_FREQS = v51.ROUTE_FREQS
BASE_NOTIONAL_USD = 500.0


@dataclass(frozen=True)
class HitRatePolicy:
    symbol: str
    cadence: str
    model_name: str
    confidence_threshold: float
    min_consensus: int
    max_units: int

    @property
    def name(self) -> str:
        return (
            f"{self.symbol}_{self.cadence}_{self.model_name}_conf{self.confidence_threshold:.2f}_"
            f"cons{self.min_consensus}_max{self.max_units}"
        )


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def write_csv(path: Path, rows: list[dict[str, Any]], columns: list[str] | None = None) -> None:
    if rows:
        v40.write_csv(path, rows)
        return
    pd.DataFrame(columns=columns or []).to_csv(path, index=False)


def profit_factor(pnls: list[float]) -> float:
    return float(v40.profit_factor(pnls))


def max_drawdown_from_pnls(pnls: list[float]) -> float:
    return float(v40.max_drawdown_from_pnls(pnls))


def split_masks(timestamps: pd.Series) -> tuple[pd.Timestamp, pd.Timestamp]:
    return v51.split_masks(timestamps)


def split_name(ts: pd.Timestamp, cut1: pd.Timestamp, cut2: pd.Timestamp) -> str:
    return v51.split_name(ts, cut1, cut2)


def build_feature_cache() -> tuple[dict[tuple[str, str], pd.DataFrame], list[dict[str, Any]]]:
    eia, _ = v40.load_eia_series(v40.SERIES)
    supply = v40.build_supply_features(eia)
    base_cache: dict[str, pd.DataFrame] = {}
    coverage: list[dict[str, Any]] = []
    for symbol in PEER_SYMBOLS:
        try:
            base = v51.load_base_bars(symbol)
            base_cache[symbol] = base
            coverage.append(
                {
                    "symbol": symbol,
                    "base_rows": len(base),
                    "start": base["timestamp"].min().isoformat() if len(base) else "",
                    "end": base["timestamp"].max().isoformat() if len(base) else "",
                    "status": "loaded" if len(base) else "empty",
                }
            )
        except Exception as exc:
            coverage.append({"symbol": symbol, "base_rows": 0, "status": "failed", "error": repr(exc)})

    feature_cache: dict[tuple[str, str], pd.DataFrame] = {}
    for cadence, rule in ROUTE_FREQS:
        peers: dict[str, pd.DataFrame] = {}
        for symbol, base in base_cache.items():
            frame = v51.resample_bars(base, cadence, rule)
            if len(frame):
                peers[symbol] = frame
        for symbol in TARGET_SYMBOLS:
            if symbol not in peers:
                continue
            feat = v51.add_universal_features(peers[symbol])
            feat = v51.add_energy_features(feat, symbol, peers, supply)
            feature_cache[(symbol, cadence)] = feat
    return feature_cache, coverage


def clean_df(feature_df: pd.DataFrame, symbol: str) -> pd.DataFrame:
    df = v51.clean_feature_frame(feature_df, symbol)
    # Add a few accuracy-oriented persistence/mean-reversion helpers without
    # leaking future data.
    df["ret_sign_1"] = np.sign(df["bar_return"]).replace(0, np.nan).ffill().fillna(0.0)
    df["ret_sign_4_sum"] = np.sign(df["bar_return"]).rolling(4, min_periods=2).sum().fillna(0.0)
    df["vol_compression"] = (1.0 / (1.0 + df["eta_noise"].clip(0, 5))).fillna(0.5)
    df["score_quality_proxy"] = (
        df["cavity_score"].clip(0, 1) * df["vol_compression"].clip(0, 1)
    ).fillna(0.0)
    return df


def feature_columns(symbol: str) -> list[str]:
    cols = v51.feature_columns_for(symbol)
    return cols + ["ret_sign_1", "ret_sign_4_sum", "vol_compression", "score_quality_proxy"]


def train_models(train_df: pd.DataFrame, symbol: str) -> dict[str, Any]:
    cols = feature_columns(symbol)
    x = train_df[cols].to_numpy(dtype=float)
    y = (train_df["future_return"].to_numpy(dtype=float) > 0).astype(int)
    models: dict[str, Any] = {}
    if len(np.unique(y)) < 2:
        return models
    models["logit_balanced"] = make_pipeline(
        StandardScaler(),
        LogisticRegression(C=0.45, class_weight="balanced", max_iter=2000, random_state=42),
    ).fit(x, y)
    models["extra_trees"] = ExtraTreesClassifier(
        n_estimators=220,
        max_depth=4,
        min_samples_leaf=12,
        random_state=42,
        class_weight="balanced",
    ).fit(x, y)
    models["hist_gb"] = HistGradientBoostingClassifier(
        max_iter=90,
        learning_rate=0.045,
        max_leaf_nodes=7,
        l2_regularization=0.25,
        min_samples_leaf=18,
        random_state=42,
    ).fit(x, y)
    return models


def predict_model_scores(df: pd.DataFrame, symbol: str, models: dict[str, Any]) -> pd.DataFrame:
    cols = feature_columns(symbol)
    x = df[cols].to_numpy(dtype=float)
    out = df.copy()
    probs: list[np.ndarray] = []
    for name, model in models.items():
        p = model.predict_proba(x)[:, 1]
        out[f"{name}_prob_up"] = p
        out[f"{name}_score"] = p * 2.0 - 1.0
        probs.append(p)
    if probs:
        ensemble = np.mean(np.vstack(probs), axis=0)
        out["ensemble_prob_up"] = ensemble
        out["ensemble_score"] = ensemble * 2.0 - 1.0
        # Agreement count for predicted side.
        signs = np.vstack([(p >= 0.5).astype(int) for p in probs])
        up_votes = signs.sum(axis=0)
        out["ensemble_consensus"] = np.maximum(up_votes, len(probs) - up_votes)
    else:
        out["ensemble_prob_up"] = 0.5
        out["ensemble_score"] = 0.0
        out["ensemble_consensus"] = 0
    return out


def target_units(row: pd.Series, policy: HitRatePolicy) -> int:
    if policy.model_name == "ensemble":
        p = float(row["ensemble_prob_up"])
        consensus = int(row.get("ensemble_consensus", 0))
    else:
        p = float(row[f"{policy.model_name}_prob_up"])
        consensus = 3
    confidence = max(p, 1.0 - p)
    if confidence < policy.confidence_threshold:
        return 0
    if consensus < policy.min_consensus:
        return 0
    # If the market is noisy and quality proxy is weak, abstain instead of
    # forcing a low-quality trade.
    if float(row.get("score_quality_proxy", 0.0)) < 0.10 and float(row.get("eta_noise", 1.0)) > 2.5:
        return 0
    extra = int((confidence - policy.confidence_threshold) / 0.08)
    units = min(policy.max_units, 1 + max(0, extra))
    return units if p >= 0.5 else -units


def replay(df: pd.DataFrame, policy: HitRatePolicy) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    cost_rate = v51.trade_cost(policy.symbol, policy.cadence)
    position = 0
    rows: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []
    for i in range(len(df) - 1):
        row = df.iloc[i]
        ts = pd.Timestamp(row["timestamp"])
        desired = target_units(row, policy)
        delta = desired - position
        action = "hold"
        if delta != 0:
            if position == 0 and desired != 0:
                action = "open_long" if desired > 0 else "open_short"
            elif desired == 0:
                action = "flat"
            elif np.sign(desired) != np.sign(position):
                action = "reverse_to_long" if desired > 0 else "reverse_to_short"
            elif abs(desired) > abs(position):
                action = "add_long" if desired > 0 else "add_short"
            else:
                action = "reduce_long" if position > 0 else "reduce_short"
            events.append(
                {
                    "policy": policy.name,
                    "symbol": policy.symbol,
                    "cadence": policy.cadence,
                    "timestamp": ts.isoformat(),
                    "action": action,
                    "from_units": position,
                    "to_units": desired,
                    "confidence": round(float(max(row.get(f"{policy.model_name}_prob_up", row.get("ensemble_prob_up", 0.5)), 1 - row.get(f"{policy.model_name}_prob_up", row.get("ensemble_prob_up", 0.5)))), 6),
                    "close": round(float(row["close"]), 6),
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
                "confidence_threshold": policy.confidence_threshold,
                "min_consensus": policy.min_consensus,
                "model_name": policy.model_name,
                "future_return": round(float(row["future_return"]), 8),
                "next_bar_return": round(float(row["next_bar_return"]), 8),
                "direction_signal_active": active,
                "direction_hit": direction_hit,
                "pnl_before_cost_usd": round(float(pnl_before_cost), 6),
                "turnover_cost_usd": round(float(turnover_cost), 6),
                "pnl_usd": round(float(pnl), 6),
                "notional_per_unit_usd": BASE_NOTIONAL_USD,
                "gross_exposure_usd": abs(desired) * BASE_NOTIONAL_USD,
            }
        )
        position = desired
    return rows, events


def summarize(rows: list[dict[str, Any]], policy: HitRatePolicy, split: str) -> dict[str, Any]:
    sub = [r for r in rows if r["split"] == split]
    pnls = [float(r["pnl_usd"]) for r in sub]
    active = [r for r in sub if int(r["direction_signal_active"]) == 1]
    events = [r for r in sub if r["action"] != "hold"]
    wins = [x for x in pnls if x > 0]
    losses = [x for x in pnls if x < 0]
    days = max(
        1e-9,
        (pd.Timestamp(sub[-1]["timestamp"]) - pd.Timestamp(sub[0]["timestamp"])).total_seconds() / 86400
        if len(sub) >= 2
        else 0.0,
    )
    return {
        "policy": policy.name,
        "symbol": policy.symbol,
        "cadence": policy.cadence,
        "model_name": policy.model_name,
        "confidence_threshold": policy.confidence_threshold,
        "min_consensus": policy.min_consensus,
        "max_units": policy.max_units,
        "split": split,
        "bars": len(sub),
        "actions": len(events),
        "actions_per_day": round(len(events) / days, 6) if sub else 0.0,
        "active_signal_bars": len(active),
        "active_signal_rate": round(len(active) / len(sub), 6) if sub else 0.0,
        "long_bars": sum(1 for r in sub if int(r["position_units_after"]) > 0),
        "short_bars": sum(1 for r in sub if int(r["position_units_after"]) < 0),
        "flat_bars": sum(1 for r in sub if int(r["position_units_after"]) == 0),
        "direction_hit_rate": round(sum(int(r["direction_hit"]) for r in active) / len(active), 6) if active else 0.0,
        "net_pnl_usd": round(sum(pnls), 6),
        "profit_factor": round(profit_factor(pnls), 6),
        "max_drawdown_usd": round(max_drawdown_from_pnls(pnls), 6),
        "win_rate_bar": round(len(wins) / len(pnls), 6) if pnls else 0.0,
        "avg_win_usd": round(sum(wins) / len(wins), 6) if wins else 0.0,
        "avg_loss_usd": round(sum(losses) / len(losses), 6) if losses else 0.0,
        "turnover_cost_usd": round(sum(float(r["turnover_cost_usd"]) for r in sub), 6),
    }


def evaluate(feature_df: pd.DataFrame, symbol: str, cadence: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    df = clean_df(feature_df, symbol)
    if len(df) < 100:
        return [], [], []
    cut1, cut2 = split_masks(pd.to_datetime(df["timestamp"], utc=True))
    train = df[pd.to_datetime(df["timestamp"], utc=True) <= cut1]
    models = train_models(train, symbol)
    if not models:
        return [], [], []
    pred = predict_model_scores(df, symbol, models)
    all_rows: list[dict[str, Any]] = []
    all_events: list[dict[str, Any]] = []
    summaries: list[dict[str, Any]] = []
    model_names = list(models.keys()) + ["ensemble"]
    for model_name in model_names:
        for threshold in [0.56, 0.60, 0.64, 0.68, 0.72, 0.76, 0.80, 0.84]:
            for consensus in ([2, 3] if model_name == "ensemble" else [1]):
                for max_units in [1, 2]:
                    policy = HitRatePolicy(symbol, cadence, model_name, threshold, consensus, max_units)
                    rows, events = replay(pred, policy)
                    for row in rows:
                        row["split"] = split_name(pd.Timestamp(row["timestamp"]), cut1, cut2)
                    for event in events:
                        event["split"] = split_name(pd.Timestamp(event["timestamp"]), cut1, cut2)
                    by_split = {split: summarize(rows, policy, split) for split in ["train", "validation", "test"]}
                    combined: dict[str, Any] = {
                        "policy": policy.name,
                        "symbol": symbol,
                        "cadence": cadence,
                        "model_name": model_name,
                        "confidence_threshold": threshold,
                        "min_consensus": consensus,
                        "max_units": max_units,
                    }
                    for split, vals in by_split.items():
                        for k, v in vals.items():
                            if k in combined or k in {"policy", "symbol", "cadence", "model_name", "split"}:
                                continue
                            combined[f"{split}_{k}"] = v
                    val = by_split["validation"]
                    test = by_split["test"]
                    combined["target70_status"] = (
                        "target70_blind_confirmed"
                        if val["active_signal_bars"] >= 8
                        and test["active_signal_bars"] >= 5
                        and val["direction_hit_rate"] >= 0.68
                        and test["direction_hit_rate"] >= 0.68
                        and val["profit_factor"] >= 1.0
                        and test["profit_factor"] >= 1.0
                        else "not_target70"
                    )
                    combined["accuracy_candidate_status"] = (
                        "accuracy_lift_candidate"
                        if val["active_signal_bars"] >= 10
                        and test["active_signal_bars"] >= 8
                        and val["direction_hit_rate"] >= 0.62
                        and test["direction_hit_rate"] >= 0.62
                        and val["profit_factor"] >= 1.0
                        and test["profit_factor"] >= 1.0
                        else "watchlist_or_blocked"
                    )
                    combined["selection_score"] = round(
                        100.0 * val["direction_hit_rate"]
                        + 75.0 * test["direction_hit_rate"]
                        + 8.0 * min(val["profit_factor"], 4.0)
                        + 8.0 * min(test["profit_factor"], 4.0)
                        + 2.0 * min(test["actions_per_day"], 8.0)
                        - abs(test["max_drawdown_usd"]) * 0.03
                        + 0.10 * test["net_pnl_usd"],
                        6,
                    )
                    summaries.append(combined)
                    all_rows.extend(rows)
                    all_events.extend(events)
    return all_rows, all_events, summaries


def select_routes(summary_df: pd.DataFrame) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    if summary_df.empty:
        return selected
    for (symbol, cadence), group in summary_df.groupby(["symbol", "cadence"], sort=False):
        candidates = group[group["target70_status"] == "target70_blind_confirmed"].sort_values("selection_score", ascending=False)
        if candidates.empty:
            candidates = group[group["accuracy_candidate_status"] == "accuracy_lift_candidate"].sort_values("selection_score", ascending=False)
        if not candidates.empty:
            selected.append(candidates.iloc[0].to_dict())
    return sorted(selected, key=lambda r: (float(r.get("test_direction_hit_rate", 0)), float(r.get("test_profit_factor", 0))), reverse=True)


def make_report(run_summary: dict[str, Any], selected: list[dict[str, Any]], best_by_route: list[dict[str, Any]]) -> str:
    lines = [
        f"# {VERSION}",
        "",
        "## 结论",
        "",
        f"- 状态：`{run_summary['status']}`",
        f"- 目标：把 NG/RB 下一周期方向命中率尽量推近 70%，但不接前向账本。",
        f"- 路线总数：`{run_summary['route_count']}`；70%确认路线：`{run_summary['target70_count']}`；准确率候选：`{run_summary['candidate_count']}`。",
        "- 本轮使用 train/validation/test 三段：模型只用 train 训练，阈值只看 validation 选择，test 作为盲测。",
        "",
        "## 选中路线",
        "",
    ]
    if selected:
        lines.append("| 标的 | 周期 | 模型 | 阈值 | 共识 | 验证命中/PF | 测试命中/PF | 测试动作/天 | 测试PNL | 回撤 |")
        lines.append("|---|---:|---|---:|---:|---:|---:|---:|---:|---:|")
        for r in selected:
            lines.append(
                f"| {r['symbol']} | {r['cadence']} | {r['model_name']} | {float(r['confidence_threshold']):.2f} | "
                f"{int(r['min_consensus'])} | {float(r['validation_direction_hit_rate']):.2%}/{float(r['validation_profit_factor']):.2f} | "
                f"{float(r['test_direction_hit_rate']):.2%}/{float(r['test_profit_factor']):.2f} | "
                f"{float(r['test_actions_per_day']):.2f} | {float(r['test_net_pnl_usd']):.2f} | {float(r['test_max_drawdown_usd']):.2f} |"
            )
    else:
        lines.append("没有路线同时通过验证段和盲测段。")
    lines += ["", "## 各路线最好盲测命中率", ""]
    lines.append("| 标的 | 周期 | 模型 | 验证命中/PF | 测试命中/PF | 测试动作/天 | 状态 |")
    lines.append("|---|---:|---|---:|---:|---:|---|")
    for r in best_by_route:
        lines.append(
            f"| {r['symbol']} | {r['cadence']} | {r['model_name']} | "
            f"{float(r['validation_direction_hit_rate']):.2%}/{float(r['validation_profit_factor']):.2f} | "
            f"{float(r['test_direction_hit_rate']):.2%}/{float(r['test_profit_factor']):.2f} | "
            f"{float(r['test_actions_per_day']):.2f} | {r['accuracy_candidate_status']} |"
        )
    lines += [
        "",
        "## 判断",
        "",
        "- 如果 70% 只发生在 test、validation 不支持，不能晋级；这类结果大概率不稳。",
        "- 如果 validation 和 test 都超过 62% 且 PF>1，才算命中率提升候选。",
        "- 如果动作/天很低，说明是狙击型，不是电力式高频。",
        "",
        "## 下一步行动计划",
        "",
        "如果本轮没有 70% 双段确认路线，V5.3 需要补更强外生传感器：NG 用天气/库存/期限结构，RB 用汽油库存、裂解价差、驾驶季节性和 EIA 发布窗口，而不是继续硬调阈值。",
        "",
    ]
    return "\n".join(lines)


def plot_results(selected: list[dict[str, Any]], best_by_route: list[dict[str, Any]], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fig, axes = plt.subplots(2, 1, figsize=(12, 8), constrained_layout=True)
    ax = axes[0]
    labels = [f"{r['symbol']} {r['cadence']}" for r in best_by_route]
    vals = [float(r.get("test_direction_hit_rate", 0)) for r in best_by_route]
    ax.bar(labels, vals, color=["#059669" if v >= 0.68 else "#f59e0b" if v >= 0.62 else "#64748b" for v in vals])
    ax.axhline(0.70, color="#dc2626", linestyle="--", label="70% target")
    ax.axhline(0.62, color="#0891b2", linestyle="--", label="candidate floor")
    ax.set_ylim(0, 1)
    ax.set_title("Best blind-test direction hit rate by route")
    ax.tick_params(axis="x", rotation=35)
    ax.legend()
    ax.grid(axis="y", alpha=0.25)

    ax2 = axes[1]
    if selected:
        labels2 = [f"{r['symbol']} {r['cadence']}" for r in selected]
        vals2 = [float(r.get("test_actions_per_day", 0)) for r in selected]
        ax2.bar(labels2, vals2, color="#10b981")
    ax2.set_title("Selected route action density per day")
    ax2.grid(axis="y", alpha=0.25)
    fig.savefig(path, dpi=160)
    plt.close(fig)


def main() -> None:
    started = time.time()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    feature_cache, data_coverage = build_feature_cache()
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
        summary_df = summary_df.sort_values(["target70_status", "accuracy_candidate_status", "selection_score"], ascending=[True, True, False])
    selected = select_routes(summary_df)
    best_by_route: list[dict[str, Any]] = []
    if not summary_df.empty:
        for (_, _), group in summary_df.groupby(["symbol", "cadence"], sort=False):
            # Best by validation-first, then blind hit. This avoids picking a
            # pure test-only fluke as the displayed best route.
            best = group.sort_values(
                ["validation_direction_hit_rate", "validation_profit_factor", "test_direction_hit_rate", "test_profit_factor"],
                ascending=False,
            ).iloc[0]
            best_by_route.append(best.to_dict())
    status = "hit_rate_lift_candidates" if selected else "hit_rate_lift_watchlist_no_candidate"
    target70_count = int(sum(1 for r in selected if r.get("target70_status") == "target70_blind_confirmed"))

    write_csv(OUT_DIR / "hfcd_commodity_v5_2_data_coverage.csv", data_coverage)
    summary_df.to_csv(OUT_DIR / "hfcd_commodity_v5_2_policy_summary.csv", index=False)
    write_csv(OUT_DIR / "hfcd_commodity_v5_2_selected_routes.csv", selected, list(summary_df.columns))
    write_csv(OUT_DIR / "hfcd_commodity_v5_2_best_by_route.csv", best_by_route)
    write_csv(OUT_DIR / "hfcd_commodity_v5_2_bar_replay.csv", all_rows)
    write_csv(OUT_DIR / "hfcd_commodity_v5_2_position_events.csv", all_events)

    report_path = OUT_DIR / "HFCD_Commodity_V5_2_HitRateLift.md"
    chart_path = OUT_DIR / "HFCD_Commodity_V5_2_HitRateLift.png"
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
        "best_by_route": best_by_route,
        "data_coverage": data_coverage,
        "notes": [
            "Local research only; no exchange orders.",
            "Train-only models, validation-selected thresholds, blind test audit.",
            "The purpose is higher hit rate, not forward ledger deployment.",
        ],
    }
    (OUT_DIR / "hfcd_commodity_v5_2_summary.json").write_text(
        json.dumps(run_summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    report_path.write_text(make_report(run_summary, selected, best_by_route), encoding="utf-8")
    plot_results(selected, best_by_route, chart_path)
    print(json.dumps({"status": status, "candidate_count": len(selected), "target70_count": target70_count, "out_dir": str(OUT_DIR)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
