#!/usr/bin/env python3
"""HFCD Commodity V5.21: energy property-vector fusion audit.

This run absorbs the energy-specific 10D property vectors from the V5.2 design
without replacing the currently stronger V5.18 exact-lineage forward shadow.

Key guardrail:
- V5.21 is a shadow/blind audit. It only promotes if it beats the frozen
  CL V5.4 3h and HO V5.9 2h lineages on sample size, hit rate, and PF.
- Short 5m/15m/30m lookback features are deliberately excluded from the core
  feature set. Realtime scanning can still run every 1m/5m, but each scan uses
  1h/2h/3h/5h/24h context windows.
"""

from __future__ import annotations

import json
import math
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "outputs" / "hfcd_commodity_v5_21_energy_property_vector_fusion"
OUT_DIR.mkdir(parents=True, exist_ok=True)

VERSION = "HFCD_Commodity_V5_21_EnergyPropertyVectorFusion"
SUMMARY_PATH = OUT_DIR / "hfcd_commodity_v5_21_summary.json"
WEIGHTS_PATH = OUT_DIR / "hfcd_commodity_v5_21_energy_property_weights.csv"
CONFIG_PATH = OUT_DIR / "hfcd_commodity_v5_21_density_router_config.csv"
LATEST_VECTOR_PATH = OUT_DIR / "hfcd_commodity_v5_21_latest_property_vectors.csv"
BLIND_REPLAY_PATH = OUT_DIR / "hfcd_commodity_v5_21_blind_replay.csv"
BLIND_SUMMARY_PATH = OUT_DIR / "hfcd_commodity_v5_21_blind_summary.csv"
REPORT_PATH = OUT_DIR / "HFCD_Commodity_V5_21_EnergyPropertyVectorFusion.md"
FIGURE_PATH = OUT_DIR / "HFCD_Commodity_V5_21_EnergyPropertyVectorFusion.png"

DIMENSIONS = ["Q", "DeltaSigma", "C", "Pi", "Sigma", "Eta", "BSigma", "R", "Tau", "Omega"]

RAW_ENERGY_WEIGHTS: dict[str, dict[str, float]] = {
    "CL=F": dict(zip(DIMENSIONS, [8, 18, 11, 13, 17, 8, 8, 7, 13, 7])),
    "RB=F": dict(zip(DIMENSIONS, [8, 14, 13, 15, 16, 9, 7, 7, 11, 10])),
    "HO=F": dict(zip(DIMENSIONS, [8, 13, 12, 14, 16, 10, 7, 7, 13, 10])),
    "NG=F": dict(zip(DIMENSIONS, [9, 12, 10, 12, 15, 15, 8, 7, 14, 8])),
}


def normalize_weights(raw: dict[str, dict[str, float]]) -> dict[str, dict[str, float]]:
    normalized: dict[str, dict[str, float]] = {}
    for symbol, weights in raw.items():
        total = sum(weights.values())
        normalized[symbol] = {key: value / total * 100.0 for key, value in weights.items()}
    return normalized


ENERGY_WEIGHTS = normalize_weights(RAW_ENERGY_WEIGHTS)

HORIZONS_MIN = [15, 30, 60, 90, 120, 150, 180]
CORE_LOOKBACK_MIN = [60, 120, 180, 300, 1440]


@dataclass(frozen=True)
class SymbolProfile:
    symbol: str
    name: str
    min_property_score: float
    min_confidence: float
    min_expected_bps: float
    cost_bps: float


PROFILES: dict[str, SymbolProfile] = {
    "CL=F": SymbolProfile("CL=F", "WTI Crude Oil Futures", 0.58, 0.58, 13.0, 7.5),
    "RB=F": SymbolProfile("RB=F", "RBOB Gasoline Futures", 0.57, 0.58, 13.0, 8.5),
    "HO=F": SymbolProfile("HO=F", "Heating Oil Futures", 0.57, 0.57, 12.0, 8.0),
    "NG=F": SymbolProfile("NG=F", "Natural Gas Futures", 0.60, 0.60, 18.0, 11.0),
}

LINEAGE_BASELINES = {
    "CL=F": {"lineage": "V5.4 CL 3h strong baseline", "horizon": "3h", "hit_rate": 0.64, "profit_factor": 4.408892, "min_trades": 25},
    "HO=F": {"lineage": "V5.9 HO 2h hit-rate lineage", "horizon": "2h", "hit_rate": 0.722222, "profit_factor": 3.805406, "min_trades": 18},
    "RB=F": {"lineage": "V5.1/V5.2 RB 1.5h density candidate", "horizon": "1.5h", "hit_rate": 0.0, "profit_factor": 1.10, "min_trades": 25},
    "NG=F": {"lineage": "V5.1/V5.2 NG 1.5h density candidate", "horizon": "1.5h", "hit_rate": 0.0, "profit_factor": 1.10, "min_trades": 25},
}


def utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def label_for_minutes(minutes: int) -> str:
    if minutes < 60:
        return f"{minutes}m"
    whole = minutes // 60
    rem = minutes % 60
    if rem == 0:
        return f"{whole}h"
    if rem == 30:
        return f"{whole}.5h"
    return f"{whole}h{rem}m"


def clamp01(value: float) -> float:
    if not math.isfinite(value):
        return 0.5
    return max(0.0, min(1.0, value))


def logistic(value: float) -> float:
    value = max(-50.0, min(50.0, value))
    return 1.0 / (1.0 + math.exp(-value))


def yahoo_chart(symbol: str, interval: str, range_: str) -> tuple[pd.DataFrame, str, bool, int]:
    params = urllib.parse.urlencode({"range": range_, "interval": interval, "includePrePost": "true"})
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol)}?{params}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "HFCD-ThingNature-OS/1.0", "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=20) as res:
            payload = json.loads(res.read().decode("utf-8"))
        result = payload["chart"]["result"][0]
        ts = result.get("timestamp", [])
        quote = result.get("indicators", {}).get("quote", [{}])[0]
        rows = []
        for i, stamp in enumerate(ts):
            close = quote.get("close", [None] * len(ts))[i]
            if close is None or not math.isfinite(float(close)) or float(close) <= 0:
                continue
            open_ = quote.get("open", [close] * len(ts))[i] or close
            high = quote.get("high", [close] * len(ts))[i] or close
            low = quote.get("low", [close] * len(ts))[i] or close
            rows.append(
                {
                    "timestamp": datetime.fromtimestamp(int(stamp), tz=timezone.utc),
                    "open": float(open_),
                    "high": float(high),
                    "low": float(low),
                    "close": float(close),
                    "volume": float(quote.get("volume", [0] * len(ts))[i] or 0),
                }
            )
        frame = pd.DataFrame(rows).dropna(subset=["close"]).sort_values("timestamp").reset_index(drop=True)
        if len(frame) < 240:
            raise RuntimeError(f"insufficient rows: {len(frame)}")
        return frame, f"yahoo_chart:{symbol}:{interval}/{range_}", True, int(interval.replace("m", ""))
    except Exception:
        now = utc_now()
        base = {"CL=F": 94.0, "RB=F": 3.0, "HO=F": 3.8, "NG=F": 3.6}.get(symbol, 50.0)
        rows = []
        for i in range(1600):
            t = now - timedelta(minutes=5 * (1599 - i))
            wave = math.sin(i / 18 + len(symbol)) * 0.006 + math.sin(i / 96) * 0.012
            rows.append({"timestamp": t, "open": base * (1 + wave * 0.98), "high": base * (1 + wave + 0.002), "low": base * (1 + wave - 0.002), "close": base * (1 + wave), "volume": 1000 + abs(math.sin(i / 15)) * 800})
        return pd.DataFrame(rows), f"fallback_simulated:{symbol}:5m", False, 5


def load_series(symbol: str) -> tuple[pd.DataFrame, str, bool, int]:
    for interval, range_ in [("1m", "7d"), ("5m", "60d")]:
        frame, source, real, base_minutes = yahoo_chart(symbol, interval, range_)
        if len(frame) >= max(360, int(1440 / base_minutes) + 200):
            return frame, source, real, base_minutes
    raise RuntimeError(f"no usable series for {symbol}")


def return_over(frame: pd.DataFrame, idx: int, minutes: int, base_minutes: int) -> float:
    bars = max(1, int(round(minutes / max(base_minutes, 1))))
    if idx - bars < 0:
        return 0.0
    past = float(frame["close"].iloc[idx - bars])
    now = float(frame["close"].iloc[idx])
    return now / max(past, 1e-9) - 1.0


def future_return(frame: pd.DataFrame, idx: int, minutes: int, base_minutes: int) -> float | None:
    bars = max(1, int(round(minutes / max(base_minutes, 1))))
    if idx + bars >= len(frame):
        return None
    now = float(frame["close"].iloc[idx])
    fut = float(frame["close"].iloc[idx + bars])
    return fut / max(now, 1e-9) - 1.0


def rolling_vol(frame: pd.DataFrame, idx: int, bars: int) -> float:
    start = max(1, idx - bars)
    series = frame["close"].iloc[start : idx + 1].pct_change().dropna()
    if series.empty:
        return 0.0001
    return max(float(series.std() or 0.0001), 0.0001)


def window_efficiency(frame: pd.DataFrame, idx: int, minutes: int, base_minutes: int) -> float:
    bars = max(2, int(round(minutes / max(base_minutes, 1))))
    if idx - bars < 0:
        return 0.0
    closes = frame["close"].iloc[idx - bars : idx + 1].astype(float)
    net = abs(float(closes.iloc[-1] - closes.iloc[0]))
    path = float(closes.diff().abs().sum())
    return net / max(path, 1e-9)


def compute_properties(frame: pd.DataFrame, idx: int, symbol: str, base_minutes: int) -> dict[str, float]:
    ret = {m: return_over(frame, idx, m, base_minutes) for m in CORE_LOOKBACK_MIN}
    vol_1h = rolling_vol(frame, idx, max(10, int(60 / base_minutes)))
    vol_24h = rolling_vol(frame, idx, max(40, int(1440 / base_minutes)))
    short_pressure = np.mean([ret[60], ret[120]])
    medium_pressure = np.mean([ret[180], ret[300]])
    long_pressure = ret[1440]
    high_window = frame["high"].iloc[max(0, idx - int(300 / base_minutes)) : idx + 1].astype(float)
    low_window = frame["low"].iloc[max(0, idx - int(300 / base_minutes)) : idx + 1].astype(float)
    close = float(frame["close"].iloc[idx])
    drawdown = 0.0 if high_window.empty else close / max(float(high_window.max()), 1e-9) - 1.0
    range_pct = 0.0 if low_window.empty else (float(high_window.max()) - float(low_window.min())) / max(close, 1e-9)
    volume_recent = float(frame["volume"].iloc[max(0, idx - int(60 / base_minutes)) : idx + 1].sum())
    volume_base = float(frame["volume"].iloc[max(0, idx - int(1440 / base_minutes)) : idx + 1].mean() * max(1, int(60 / base_minutes)))
    volume_shock = volume_recent / max(volume_base, 1.0) - 1.0
    eff_3h = window_efficiency(frame, idx, 180, base_minutes)
    eff_5h = window_efficiency(frame, idx, 300, base_minutes)
    alignment = (
        float(np.sign(ret[60]) == np.sign(ret[120]))
        + float(np.sign(ret[120]) == np.sign(ret[180]))
        + float(np.sign(ret[180]) == np.sign(ret[300]))
        + float(np.sign(ret[300]) == np.sign(ret[1440]))
    ) / 4.0

    # These are tradable proxies, not official inventory/term-structure feeds.
    return {
        "Q": clamp01(0.72 + 0.20 * alignment - 3.5 * abs(drawdown) - 1.6 * range_pct),
        "DeltaSigma": logistic((0.45 * ret[300] + 0.35 * ret[180] + 0.20 * ret[1440]) / max(vol_24h, 1e-5)),
        "C": clamp01(0.48 + 0.24 * logistic(volume_shock) + 0.20 * (1.0 - min(range_pct / 0.035, 1.0)) + 0.08 * alignment),
        "Pi": clamp01(0.20 + 0.35 * eff_3h + 0.25 * eff_5h + 0.20 * alignment),
        "Sigma": logistic((0.50 * medium_pressure + 0.25 * long_pressure + 0.25 * volume_shock * vol_24h) / max(vol_24h, 1e-5)),
        "Eta": clamp01(vol_1h / max(vol_24h, 1e-5) / 2.0),
        "BSigma": clamp01(0.30 * min(abs(volume_shock), 2.0) / 2.0 + 0.45 * min(abs(short_pressure) / max(vol_1h * 3.0, 1e-5), 1.0) + 0.25 * (1.0 - alignment)),
        "R": clamp01(0.30 + 0.45 * min(abs(medium_pressure) / max(vol_24h * 4.0, 1e-5), 1.0) + 0.25 * min(vol_1h / max(vol_24h, 1e-5), 2.0) / 2.0),
        "Tau": clamp01(0.50 + 0.30 * np.sign(long_pressure) * min(abs(long_pressure) / max(vol_24h * 8.0, 1e-5), 1.0) + 0.20 * alignment),
        "Omega": clamp01(0.35 + 0.35 * alignment + 0.30 * min(abs(short_pressure + medium_pressure) / max(vol_24h * 5.0, 1e-5), 1.0)),
    }


def property_score(props: dict[str, float], symbol: str) -> float:
    weights = ENERGY_WEIGHTS[symbol]
    return sum(weights[k] * props[k] for k in DIMENSIONS) / 100.0


def signed_signal(frame: pd.DataFrame, idx: int, symbol: str, base_minutes: int, props: dict[str, float]) -> float:
    ret = {m: return_over(frame, idx, m, base_minutes) for m in CORE_LOOKBACK_MIN}
    weights = ENERGY_WEIGHTS[symbol]
    vol = max(rolling_vol(frame, idx, max(20, int(300 / base_minutes))), 1e-5)
    trend = (weights["Pi"] * (0.42 * ret[60] + 0.32 * ret[120] + 0.26 * ret[180]))
    ledger = (weights["Sigma"] * (0.45 * ret[180] + 0.35 * ret[300] + 0.20 * ret[1440]))
    macro = (weights["DeltaSigma"] * (0.55 * ret[300] + 0.45 * ret[1440]))
    tau = (weights["Tau"] * (ret[1440] - ret[60] * 0.35))
    omega = (weights["Omega"] * (0.50 * ret[120] + 0.50 * ret[180]))
    risk_drag = weights["BSigma"] * (props["BSigma"] - 0.5) * vol * 1.8
    raw = (trend + ledger + macro + tau + omega) / 100.0 - risk_drag
    return math.tanh(raw / max(vol * 3.0, 1e-5))


def latest_vectors(frames: dict[str, tuple[pd.DataFrame, str, bool, int]]) -> list[dict[str, Any]]:
    rows = []
    now = utc_now().isoformat()
    for symbol, (frame, source, real, base_minutes) in frames.items():
        idx = len(frame) - 1
        props = compute_properties(frame, idx, symbol, base_minutes)
        score = property_score(props, symbol)
        signed = signed_signal(frame, idx, symbol, base_minutes, props)
        rows.append(
            {
                "generated_at": now,
                "symbol": symbol,
                "source": source,
                "is_real_market_data": real,
                "base_interval_minutes": base_minutes,
                "timestamp": frame["timestamp"].iloc[idx].isoformat(),
                "price": float(frame["close"].iloc[idx]),
                "property_score": round(score, 4),
                "signed_signal": round(signed, 4),
                "direction": "long" if signed > 0 else "short" if signed < 0 else "flat",
                **{k: round(props[k], 4) for k in DIMENSIONS},
            }
        )
    return rows


def profit_factor(pnls: pd.Series) -> float:
    wins = float(pnls[pnls > 0].sum())
    losses = float(-pnls[pnls < 0].sum())
    if losses <= 1e-9:
        return 999.0 if wins > 0 else 0.0
    return wins / losses


def max_drawdown(pnls: pd.Series) -> float:
    if pnls.empty:
        return 0.0
    curve = pnls.cumsum()
    return float((curve - curve.cummax()).min())


def blind_replay_symbol(symbol: str, frame: pd.DataFrame, source: str, real: bool, base_minutes: int) -> list[dict[str, Any]]:
    profile = PROFILES[symbol]
    max_lookback_bars = max(int(1440 / base_minutes), 50)
    step = max(1, int(5 / base_minutes))
    rows = []
    for idx in range(max_lookback_bars, len(frame) - int(max(HORIZONS_MIN) / base_minutes) - 1, step):
        props = compute_properties(frame, idx, symbol, base_minutes)
        score = property_score(props, symbol)
        signed = signed_signal(frame, idx, symbol, base_minutes, props)
        direction = "long" if signed > 0 else "short" if signed < 0 else "flat"
        vol = max(rolling_vol(frame, idx, max(20, int(180 / base_minutes))), 1e-5)
        confidence = 0.50 + min(0.48, abs(signed) * 0.30 + max(score - 0.50, 0.0) * 0.34)
        for horizon in HORIZONS_MIN:
            fut = future_return(frame, idx, horizon, base_minutes)
            if fut is None:
                continue
            expected_return = signed * vol * math.sqrt(horizon / 60.0) * 2.25
            expected_bps = abs(expected_return) * 10000.0
            action = "NO_TRADE"
            if score >= profile.min_property_score and confidence >= profile.min_confidence and expected_bps >= max(profile.min_expected_bps, profile.cost_bps * 1.7):
                action = "BUY_LONG" if direction == "long" else "SELL_SHORT"
            if action == "NO_TRADE":
                continue
            sign = 1.0 if action == "BUY_LONG" else -1.0
            pnl = sign * fut * 1000.0 - profile.cost_bps / 10000.0 * 1000.0
            rows.append(
                {
                    "timestamp": frame["timestamp"].iloc[idx].isoformat(),
                    "symbol": symbol,
                    "source": source,
                    "is_real_market_data": real,
                    "horizon": label_for_minutes(horizon),
                    "horizon_minutes": horizon,
                    "action": action,
                    "direction": direction,
                    "price": float(frame["close"].iloc[idx]),
                    "future_return": round(fut, 6),
                    "hit": bool((fut > 0 and action == "BUY_LONG") or (fut < 0 and action == "SELL_SHORT")),
                    "pnl_usd": round(pnl, 4),
                    "property_score": round(score, 4),
                    "confidence": round(confidence, 4),
                    "expected_bps": round(expected_bps, 2),
                    "signed_signal": round(signed, 4),
                    **{k: round(props[k], 4) for k in DIMENSIONS},
                }
            )
    return rows


def summarize_blind(replay: pd.DataFrame) -> pd.DataFrame:
    rows = []
    if replay.empty:
        return pd.DataFrame(rows)
    for (symbol, horizon), group in replay.groupby(["symbol", "horizon"]):
        pnls = group["pnl_usd"].astype(float)
        rows.append(
            {
                "symbol": symbol,
                "horizon": horizon,
                "trades": int(len(group)),
                "direction_hit_rate": float(group["hit"].mean()),
                "net_pnl_usd": float(pnls.sum()),
                "profit_factor": profit_factor(pnls),
                "max_drawdown_usd": max_drawdown(pnls),
                "avg_property_score": float(group["property_score"].mean()),
                "actions_per_day": float(len(group) / max(1.0, (pd.to_datetime(group["timestamp"]).max() - pd.to_datetime(group["timestamp"]).min()).total_seconds() / 86400.0)),
                "source": str(group["source"].iloc[-1]),
                "is_real_market_data": bool(group["is_real_market_data"].all()),
            }
        )
    out = pd.DataFrame(rows)
    if not out.empty:
        out = out.sort_values(["symbol", "profit_factor", "net_pnl_usd"], ascending=[True, False, False]).reset_index(drop=True)
    return out


def promote_candidates(summary: pd.DataFrame) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    if summary.empty:
        return candidates
    for symbol, group in summary.groupby("symbol"):
        best = group.sort_values(["profit_factor", "net_pnl_usd"], ascending=False).iloc[0].to_dict()
        baseline = LINEAGE_BASELINES.get(symbol, {})
        min_trades = int(baseline.get("min_trades", 25))
        baseline_pf = float(baseline.get("profit_factor", 1.1))
        baseline_hit = float(baseline.get("hit_rate", 0.0))
        passed = (
            int(best["trades"]) >= min_trades
            and float(best["profit_factor"]) > max(1.3, baseline_pf)
            and (baseline_hit <= 0 or float(best["direction_hit_rate"]) >= baseline_hit)
            and float(best["net_pnl_usd"]) > 0
        )
        best["baseline_lineage"] = baseline.get("lineage", "")
        best["baseline_pf"] = baseline_pf
        best["baseline_hit_rate"] = baseline_hit
        best["candidate_status"] = "promote_shadow_candidate" if passed else "research_only"
        candidates.append(best)
    return candidates


def write_weights_and_config() -> None:
    weight_rows = []
    for symbol, weights in ENERGY_WEIGHTS.items():
        raw = RAW_ENERGY_WEIGHTS[symbol]
        total = sum(weights.values())
        raw_total = sum(raw.values())
        row = {
            "symbol": symbol,
            "raw_total_weight": raw_total,
            "normalized_total_weight": round(total, 8),
            **{f"raw_{key}": raw[key] for key in DIMENSIONS},
            **{key: round(weights[key], 6) for key in DIMENSIONS},
        }
        weight_rows.append(row)
    pd.DataFrame(weight_rows).to_csv(WEIGHTS_PATH, index=False)
    config_rows = []
    for symbol, profile in PROFILES.items():
        config_rows.append(
            {
                "symbol": symbol,
                "cadence": "realtime_scan_1m_or_5m",
                "core_lookbacks": ",".join(label_for_minutes(m) for m in CORE_LOOKBACK_MIN),
                "horizons": ",".join(label_for_minutes(m) for m in HORIZONS_MIN),
                "min_property_score": profile.min_property_score,
                "min_confidence": profile.min_confidence,
                "min_expected_bps": profile.min_expected_bps,
                "cost_bps": profile.cost_bps,
                "promotion_policy": "must_beat_frozen_lineage_before_online_main",
            }
        )
    pd.DataFrame(config_rows).to_csv(CONFIG_PATH, index=False)


def write_report(summary: dict[str, Any], blind_summary: pd.DataFrame, candidates: list[dict[str, Any]]) -> None:
    lines = [
        f"# {VERSION}",
        "",
        "## 定位",
        "V5.21 吸收 Grok 的能源专属 10 维物性权重，但只作为旁路盲测与实时向量账本；不替代当前线上 V5.18 主血统。",
        "",
        "## 关键约束",
        "- 核心特征窗口只使用过去 1h/2h/3h/5h/24h。",
        "- 不使用 5m/15m/30m 短窗口作为主信号特征，避免把微观噪声误当成物性。",
        "- 扫描频率可以是 1m/5m，但每次扫描都重新计算中长窗口物性。",
        "",
        "## 能源权重",
        "| 标的 | Q | Δσ | C | Π | Σ | η | Bσ | R | τ | Ω |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for symbol, weights in ENERGY_WEIGHTS.items():
        lines.append("| " + symbol + " | " + " | ".join(str(int(weights[d])) for d in DIMENSIONS) + " |")
    lines.extend(["", "## 盲测最佳路线", "| 标的 | Horizon | Trades | Hit | PF | PnL | DD | 判断 |", "|---|---:|---:|---:|---:|---:|---:|---|"])
    for row in candidates:
        lines.append(
            f"| {row['symbol']} | {row['horizon']} | {int(row['trades'])} | "
            f"{row['direction_hit_rate']:.2%} | {row['profit_factor']:.2f} | "
            f"${row['net_pnl_usd']:.2f} | ${row['max_drawdown_usd']:.2f} | {row['candidate_status']} |"
        )
    if blind_summary.empty:
        lines.append("| - | - | 0 | - | - | - | - | no_data |")
    lines.extend(
        [
            "",
            "## 结论",
            summary["decision"],
            "",
            "## 下一步",
            "如果 V5.21 没有路线超过冻结血统，下一步不应上线；应把这些 10 维向量接入 V5.20 执行层做非破坏性过滤，或者补真实库存预期差/期限结构后重测。",
        ]
    )
    REPORT_PATH.write_text("\n".join(lines), encoding="utf-8")


def write_figure(blind_summary: pd.DataFrame) -> None:
    if blind_summary.empty:
        return
    best = blind_summary.sort_values(["symbol", "profit_factor"], ascending=[True, False]).groupby("symbol").head(1)
    fig, axes = plt.subplots(1, 2, figsize=(11, 4))
    axes[0].bar(best["symbol"], best["profit_factor"], color="#22c55e")
    axes[0].axhline(1.3, color="#f59e0b", linestyle="--", linewidth=1)
    axes[0].set_title("Best PF by symbol")
    axes[0].set_ylabel("Profit Factor")
    axes[1].bar(best["symbol"], best["direction_hit_rate"], color="#38bdf8")
    axes[1].axhline(0.65, color="#f59e0b", linestyle="--", linewidth=1)
    axes[1].set_title("Best hit rate by symbol")
    axes[1].set_ylim(0, 1)
    for ax in axes:
        ax.grid(alpha=0.25)
    fig.tight_layout()
    fig.savefig(FIGURE_PATH, dpi=160)
    plt.close(fig)


def main() -> None:
    started = datetime.now()
    frames: dict[str, tuple[pd.DataFrame, str, bool, int]] = {}
    coverage = []
    for symbol in PROFILES:
        frame, source, real, base_minutes = load_series(symbol)
        frames[symbol] = (frame, source, real, base_minutes)
        coverage.append({"symbol": symbol, "source": source, "is_real_market_data": real, "rows": len(frame), "base_interval_minutes": base_minutes})

    write_weights_and_config()
    latest = latest_vectors(frames)
    pd.DataFrame(latest).to_csv(LATEST_VECTOR_PATH, index=False)

    replay_rows: list[dict[str, Any]] = []
    for symbol, (frame, source, real, base_minutes) in frames.items():
        replay_rows.extend(blind_replay_symbol(symbol, frame, source, real, base_minutes))
    replay = pd.DataFrame(replay_rows)
    replay.to_csv(BLIND_REPLAY_PATH, index=False)
    blind_summary = summarize_blind(replay)
    blind_summary.to_csv(BLIND_SUMMARY_PATH, index=False)
    candidates = promote_candidates(blind_summary)
    promoted = [c for c in candidates if c.get("candidate_status") == "promote_shadow_candidate"]
    decision = "keep_v5_18_main_lineage"
    if promoted:
        decision = "property_vector_shadow_candidate_only_not_online_main"

    summary = {
        "version": VERSION,
        "generated_at": utc_now().isoformat(),
        "status": "energy_property_vector_shadow_completed",
        "decision": decision,
        "core_lookbacks": [label_for_minutes(m) for m in CORE_LOOKBACK_MIN],
        "horizons": [label_for_minutes(m) for m in HORIZONS_MIN],
        "coverage": coverage,
        "latest_vectors": latest,
        "candidate_audit": candidates,
        "promoted_shadow_candidates": promoted,
        "lineage_baselines": LINEAGE_BASELINES,
        "runtime_sec": round((datetime.now() - started).total_seconds(), 3),
        "outputs": {
            "summary_json": str(SUMMARY_PATH),
            "weights_csv": str(WEIGHTS_PATH),
            "density_router_config_csv": str(CONFIG_PATH),
            "latest_property_vectors_csv": str(LATEST_VECTOR_PATH),
            "blind_replay_csv": str(BLIND_REPLAY_PATH),
            "blind_summary_csv": str(BLIND_SUMMARY_PATH),
            "report_md": str(REPORT_PATH),
            "figure_png": str(FIGURE_PATH),
        },
    }
    SUMMARY_PATH.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    write_report(summary, blind_summary, candidates)
    write_figure(blind_summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
