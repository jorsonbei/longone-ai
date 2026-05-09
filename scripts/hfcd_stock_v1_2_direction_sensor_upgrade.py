#!/usr/bin/env python3
"""HFCD Stock V1.2: direction-specific sensor upgrade blind test.

This stage focuses only on the single-side legs identified by V1.1:
- SPY 2h long
- AAPL 15m short
- NVDA 15m short
- IWM 1h long
- MSFT 30m long
- MSFT 1h long

New information added versus V1.0/V1.1:
- VIX risk proxy
- SOXX/XLK sector coupling
- SPY/QQQ market coupling
- event-window proxies: gap shock, market shock, VIX spike, open/close risk

Offline blind test only. No broker, online page, Worker/D1, or forward ledger
is touched.
"""

from __future__ import annotations

import csv
import json
import math
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

import hfcd_stock_v1_0_directional_edge_blind as v10


VERSION = "HFCD_Stock_V1_2_DirectionSensorUpgrade"
ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "outputs" / "hfcd_stock_v1_2_direction_sensor_upgrade"
RAW_DIR = OUT_DIR / "raw_yahoo_chart"

TARGET_ROUTES = [
    {"symbol": "SPY", "cadence": "2h", "side_policy": "long_only", "source": "v1_1_spy_2h_combo_long_confirmed"},
    {"symbol": "AAPL", "cadence": "15m", "side_policy": "short_only", "source": "v1_1_aapl_15m_combo_short_confirmed"},
    {"symbol": "NVDA", "cadence": "15m", "side_policy": "short_only", "source": "v1_0_watchlist_nvda_15m_short"},
    {"symbol": "IWM", "cadence": "1h", "side_policy": "long_only", "source": "v1_0_watchlist_iwm_1h_long"},
    {"symbol": "MSFT", "cadence": "30m", "side_policy": "long_only", "source": "v1_0_watchlist_msft_30m_long"},
    {"symbol": "MSFT", "cadence": "1h", "side_policy": "long_only", "source": "v1_0_watchlist_msft_1h_long"},
]

SENSOR_SYMBOLS = ["SPY", "QQQ", "^VIX", "SOXX", "XLK"]
SYMBOL_TO_SECTOR = {
    "NVDA": "SOXX",
    "AMD": "SOXX",
    "AAPL": "XLK",
    "MSFT": "XLK",
    "TSLA": "QQQ",
    "SPY": "SPY",
    "QQQ": "QQQ",
    "IWM": "SPY",
}
NOTIONAL_USD = 1000.0

FEATURES = v10.FEATURES + [
    "vix_ret_1",
    "vix_ret_4",
    "vix_level_z",
    "vix_spike_proxy",
    "soxx_ret_1",
    "soxx_ret_4",
    "xlk_ret_1",
    "xlk_ret_4",
    "sector_ret_1",
    "sector_ret_4",
    "relative_sector_4",
    "market_shock_proxy",
    "gap_shock_proxy",
    "event_risk_proxy",
]


@dataclass(frozen=True)
class Policy:
    symbol: str
    cadence: str
    side_policy: str
    score_floor: float
    edge_floor: float
    hold_bars: int
    stop_atr: float
    take_atr: float
    min_cavity: float
    min_eta_health: float
    max_event_risk: float
    session_policy: str

    @property
    def name(self) -> str:
        return (
            f"{self.symbol}_{self.cadence}_{self.side_policy}_"
            f"score{self.score_floor:.2f}_edge{self.edge_floor:.4f}_"
            f"hold{self.hold_bars}_sl{self.stop_atr:.1f}_tp{self.take_atr:.1f}_"
            f"event{self.max_event_risk:.2f}_{self.session_policy}"
        )


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def n(value: Any, digits: int = 6) -> float:
    return v10.n(value, digits)


def write_csv(path: Path, rows: list[dict[str, Any]], headers: list[str] | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = headers or sorted({key for row in rows for key in row.keys()})
    if not fields:
        path.write_text("", encoding="utf-8")
        return
    priority = ["symbol", "cadence", "side_policy", "policy_name", "split", "entry_ts", "signal_ts"]
    fields = [x for x in priority if x in fields] + [x for x in fields if x not in priority]
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def http_json(url: str, timeout: int = 30) -> Any:
    req = urllib.request.Request(url, headers={"User-Agent": "HFCD-Stock-V1.2"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def cache_name(symbol: str) -> str:
    return symbol.replace("^", "IDX_").replace("/", "_")


def fetch_yahoo_15m(symbol: str) -> pd.DataFrame:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    cache = RAW_DIR / f"{cache_name(symbol)}_60d_15m.json"
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol)}?"
        + urllib.parse.urlencode({"range": "60d", "interval": "15m", "includePrePost": "false"})
    )
    try:
        data = http_json(url)
        cache.write_text(json.dumps(data), encoding="utf-8")
    except Exception:
        if not cache.exists():
            raise
        data = json.loads(cache.read_text(encoding="utf-8"))
    result = (data.get("chart", {}).get("result") or [None])[0]
    if not result:
        raise RuntimeError(f"Yahoo returned no chart data for {symbol}")
    ts = result.get("timestamp") or []
    quote = (result.get("indicators", {}).get("quote") or [{}])[0]
    out = pd.DataFrame(
        {
            "timestamp": pd.to_datetime(ts, unit="s", utc=True),
            "open": quote.get("open", []),
            "high": quote.get("high", []),
            "low": quote.get("low", []),
            "close": quote.get("close", []),
            "volume": quote.get("volume", []),
        }
    )
    for col in ["open", "high", "low", "close", "volume"]:
        out[col] = pd.to_numeric(out[col], errors="coerce")
    out = out.dropna(subset=["timestamp", "open", "high", "low", "close"]).sort_values("timestamp").reset_index(drop=True)
    out["volume"] = out["volume"].fillna(0.0)
    out["symbol"] = symbol
    return out


def safe_enrich(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    if out["volume"].fillna(0).sum() <= 0:
        out["volume"] = 1.0
    return v10.enrich(out)


def build_base_datasets(coverage: list[dict[str, Any]]) -> dict[tuple[str, str], pd.DataFrame]:
    symbols = sorted(set([r["symbol"] for r in TARGET_ROUTES] + SENSOR_SYMBOLS))
    base: dict[str, pd.DataFrame] = {}
    for symbol in symbols:
        try:
            df = fetch_yahoo_15m(symbol)
            base[symbol] = df
            coverage.append(
                {
                    "symbol": symbol,
                    "source": "yahoo_chart_15m",
                    "rows": len(df),
                    "first_ts": df["timestamp"].min().isoformat() if len(df) else "",
                    "last_ts": df["timestamp"].max().isoformat() if len(df) else "",
                    "status": "ok" if len(df) >= 300 else "coverage_low",
                }
            )
        except Exception as exc:
            coverage.append({"symbol": symbol, "source": "yahoo_chart_15m", "rows": 0, "status": f"error:{exc}"})
    datasets: dict[tuple[str, str], pd.DataFrame] = {}
    needed_cadences = sorted(set(r["cadence"] for r in TARGET_ROUTES))
    for symbol, df in base.items():
        for cadence in needed_cadences:
            try:
                out = safe_enrich(v10.resample_ohlcv(df, cadence))
                datasets[(symbol, cadence)] = out
                coverage.append(
                    {
                        "symbol": symbol,
                        "cadence": cadence,
                        "source": "yahoo_chart_15m_resampled",
                        "rows": len(out),
                        "first_ts": out["timestamp"].min().isoformat() if len(out) else "",
                        "last_ts": out["timestamp"].max().isoformat() if len(out) else "",
                        "status": "ok" if len(out) >= 120 else "coverage_low",
                    }
                )
            except Exception as exc:
                coverage.append({"symbol": symbol, "cadence": cadence, "source": "resample_enrich", "rows": 0, "status": f"error:{exc}"})
    return datasets


def sensor_ref(datasets: dict[tuple[str, str], pd.DataFrame], symbol: str, cadence: str, prefix: str) -> pd.DataFrame | None:
    df = datasets.get((symbol, cadence))
    if df is None or df.empty:
        return None
    cols = ["timestamp", "close", "ret_1", "ret_4"]
    ref = df[cols].copy()
    return ref.rename(columns={"close": f"{prefix}_close", "ret_1": f"{prefix}_ret_1", "ret_4": f"{prefix}_ret_4"})


def add_sensor_features(df: pd.DataFrame, symbol: str, cadence: str, datasets: dict[tuple[str, str], pd.DataFrame]) -> pd.DataFrame:
    out = df.copy()
    for sensor_symbol, prefix in [("SPY", "spy"), ("QQQ", "qqq"), ("^VIX", "vix"), ("SOXX", "soxx"), ("XLK", "xlk")]:
        ref = sensor_ref(datasets, sensor_symbol, cadence, prefix)
        if ref is not None:
            out = out.merge(ref, on="timestamp", how="left")
    for col in [
        "spy_ret_1",
        "spy_ret_4",
        "qqq_ret_1",
        "qqq_ret_4",
        "vix_ret_1",
        "vix_ret_4",
        "soxx_ret_1",
        "soxx_ret_4",
        "xlk_ret_1",
        "xlk_ret_4",
    ]:
        if col not in out:
            out[col] = 0.0
        out[col] = pd.to_numeric(out[col], errors="coerce").fillna(0.0)
    if "vix_close" not in out:
        out["vix_close"] = 0.0
    vix = pd.to_numeric(out["vix_close"], errors="coerce").ffill().fillna(0.0)
    vix_mean = vix.rolling(48, min_periods=12).mean().replace(0, np.nan)
    vix_std = vix.rolling(48, min_periods=12).std().replace(0, np.nan)
    out["vix_level_z"] = ((vix - vix_mean) / vix_std).replace([np.inf, -np.inf], 0.0).fillna(0.0).clip(-4.0, 4.0)
    out["vix_spike_proxy"] = ((out["vix_ret_1"] > 0.025) | (out["vix_level_z"] > 1.5)).astype(float)

    sector = SYMBOL_TO_SECTOR.get(symbol, "SPY")
    prefix = {"SOXX": "soxx", "XLK": "xlk", "QQQ": "qqq", "SPY": "spy"}.get(sector, "spy")
    out["sector_ret_1"] = out.get(f"{prefix}_ret_1", out["spy_ret_1"]).fillna(0.0)
    out["sector_ret_4"] = out.get(f"{prefix}_ret_4", out["spy_ret_4"]).fillna(0.0)
    out["relative_spy_4"] = out["ret_4"] - out["spy_ret_4"]
    out["relative_qqq_4"] = out["ret_4"] - out["qqq_ret_4"]
    out["relative_sector_4"] = out["ret_4"] - out["sector_ret_4"]

    prev_close = out["close"].shift(1).replace(0, np.nan)
    gap = (out["open"] / prev_close - 1.0).replace([np.inf, -np.inf], 0.0).fillna(0.0)
    out["gap_abs"] = gap.abs()
    out["gap_shock_proxy"] = ((out["gap_abs"] > (out["atr_pct"].shift(1).fillna(out["atr_pct"]) * 1.5)) & (out["volume_ratio"] > 1.2)).astype(float)
    out["market_shock_proxy"] = ((out["spy_ret_1"].abs() > 0.0045) | (out["qqq_ret_1"].abs() > 0.0055) | (out["vix_spike_proxy"] > 0)).astype(float)
    out["event_risk_proxy"] = (
        0.30 * out["opening_risk"]
        + 0.20 * out["closing_risk"]
        + 0.25 * out["gap_shock_proxy"]
        + 0.25 * out["market_shock_proxy"]
    ).clip(0.0, 1.0)
    return out.replace([np.inf, -np.inf], 0.0).fillna(0.0)


def fit_ridge(train: pd.DataFrame) -> dict[str, Any]:
    usable = train.dropna(subset=FEATURES + ["future_return"]).copy()
    if len(usable) < 60:
        return {"available": False, "reason": "insufficient_train_rows"}
    x = usable[FEATURES].astype(float).replace([np.inf, -np.inf], 0.0).fillna(0.0).to_numpy()
    y = usable["future_return"].astype(float).to_numpy()
    mean = x.mean(axis=0)
    std = x.std(axis=0)
    std[std == 0] = 1.0
    z = (x - mean) / std
    design = np.column_stack([np.ones(len(z)), z])
    alpha = 5.0
    reg = np.eye(design.shape[1]) * alpha
    reg[0, 0] = 0.0
    beta = np.linalg.pinv(design.T @ design + reg) @ design.T @ y
    pred = design @ beta
    return {
        "available": True,
        "features": FEATURES,
        "mean": mean.tolist(),
        "std": std.tolist(),
        "beta": beta.tolist(),
        "mae": float(np.mean(np.abs(pred - y))),
        "train_rows": int(len(usable)),
    }


def apply_model(df: pd.DataFrame, model: dict[str, Any]) -> pd.DataFrame:
    out = df.copy()
    if not model.get("available"):
        out["predicted_return"] = 0.0
    else:
        x = out[FEATURES].astype(float).replace([np.inf, -np.inf], 0.0).fillna(0.0).to_numpy()
        mean = np.array(model["mean"], dtype=float)
        std = np.array(model["std"], dtype=float)
        beta = np.array(model["beta"], dtype=float)
        z = (x - mean) / std
        design = np.column_stack([np.ones(len(z)), z])
        out["predicted_return"] = design @ beta
    scale = (out["atr_pct"].clip(lower=0.0001) * 0.85).astype(float)
    long_align = (
        0.50 * out["predicted_return"].div(scale).map(v10.sigmoid)
        + 0.13 * out["hfcd_cavity"]
        + 0.10 * out["hfcd_eta_health"]
        + 0.10 * out["hfcd_bsigma_health"]
        + 0.07 * out["trend_efficiency"]
        + 0.05 * out["sector_ret_1"].div(scale).map(v10.sigmoid)
        + 0.05 * out["spy_ret_1"].div(scale).map(v10.sigmoid)
    )
    short_align = (
        0.50 * (-out["predicted_return"]).div(scale).map(v10.sigmoid)
        + 0.13 * out["hfcd_cavity"]
        + 0.10 * out["hfcd_eta_health"]
        + 0.10 * out["hfcd_bsigma_health"]
        + 0.07 * out["trend_efficiency"]
        + 0.05 * (-out["sector_ret_1"]).div(scale).map(v10.sigmoid)
        + 0.05 * (-out["spy_ret_1"]).div(scale).map(v10.sigmoid)
    )
    out["long_score"] = long_align.clip(0.0, 1.0)
    out["short_score"] = short_align.clip(0.0, 1.0)
    return out


def forecast_edge(row: pd.Series, symbol: str, side: str, model_mae: float) -> dict[str, float]:
    predicted_side_return = float(row["predicted_return"]) if side == "long" else -float(row["predicted_return"])
    base_cost = v10.BASE_COST.get(symbol, 0.00030)
    spread_slip = base_cost + 0.045 * float(row["atr_pct"])
    noise = max(0.00025, min(0.0040, 0.22 * model_mae + 0.09 * float(row["atr_pct"])))
    event_buffer = 0.00035 * float(row.get("event_risk_proxy", 0.0))
    edge = predicted_side_return - spread_slip - noise - event_buffer
    return {
        "predicted_side_return": predicted_side_return,
        "cost_pct": spread_slip,
        "noise_buffer_pct": noise,
        "event_buffer_pct": event_buffer,
        "forecast_edge_pct": edge,
    }


def split_label(i: int, n_rows: int) -> str:
    return v10.split_label(i, n_rows)


def build_policies(route: dict[str, str]) -> list[Policy]:
    symbol = route["symbol"]
    cadence = route["cadence"]
    side_policy = route["side_policy"]
    if side_policy == "long_only":
        score_floors = [0.54, 0.58, 0.62, 0.66]
    else:
        score_floors = [0.56, 0.60, 0.64, 0.68]
    edge_floors = [0.0, 0.00010, 0.00025]
    holds = {"15m": [1, 2, 3], "30m": [1, 2, 3], "1h": [1, 2], "2h": [1, 2], "3h": [1]}[cadence]
    exits = [(0.8, 1.3), (1.05, 1.8), (1.3, 2.3)]
    max_events = [0.55, 0.75]
    session_policies = ["avoid_open_close", "allow_close_avoid_open"]
    policies: list[Policy] = []
    for score_floor in score_floors:
        for edge_floor in edge_floors:
            for hold in holds:
                for stop_atr, take_atr in exits:
                    for max_event in max_events:
                        for session_policy in session_policies:
                            policies.append(
                                Policy(
                                    symbol=symbol,
                                    cadence=cadence,
                                    side_policy=side_policy,
                                    score_floor=score_floor,
                                    edge_floor=edge_floor,
                                    hold_bars=hold,
                                    stop_atr=stop_atr,
                                    take_atr=take_atr,
                                    min_cavity=0.30,
                                    min_eta_health=0.22,
                                    max_event_risk=max_event,
                                    session_policy=session_policy,
                                )
                            )
    return policies


def decide_signal(row: pd.Series, policy: Policy, model_mae: float) -> tuple[str, dict[str, float], str]:
    if float(row["hfcd_cavity"]) < policy.min_cavity:
        return "", {}, "cavity_below_floor"
    if float(row["hfcd_eta_health"]) < policy.min_eta_health:
        return "", {}, "eta_health_below_floor"
    if float(row["event_risk_proxy"]) > policy.max_event_risk:
        return "", {}, "event_risk_above_floor"
    if policy.session_policy == "avoid_open_close" and (float(row["opening_risk"]) > 0 or float(row["closing_risk"]) > 0):
        return "", {}, "session_open_close_block"
    if policy.session_policy == "allow_close_avoid_open" and float(row["opening_risk"]) > 0:
        return "", {}, "session_open_block"
    side = "long" if policy.side_policy == "long_only" else "short"
    edge = forecast_edge(row, policy.symbol, side, model_mae)
    score = float(row["long_score"] if side == "long" else row["short_score"])
    if score < policy.score_floor:
        return "", edge, "score_below_floor"
    if edge["forecast_edge_pct"] < policy.edge_floor:
        return "", edge, "forecast_edge_below_floor"
    return side, edge, f"{side}_sensor_edge_confirmed"


def side_return(side: str, entry: float, exit_: float) -> float:
    return v10.side_return(side, entry, exit_)


def simulate(df: pd.DataFrame, policy: Policy, model: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    rows = df.reset_index(drop=True)
    trades: list[dict[str, Any]] = []
    gates: list[dict[str, Any]] = []
    if len(rows) < 80 or not model.get("available"):
        return trades, gates
    model_mae = float(model.get("mae", 0.001))
    i = 32
    cooldown_until = -1
    while i < len(rows) - policy.hold_bars - 2:
        if i <= cooldown_until:
            i += 1
            continue
        row = rows.iloc[i]
        split = split_label(i, len(rows))
        side, edge, reason = decide_signal(row, policy, model_mae)
        if side or (split != "train" and i % 20 == 0):
            gates.append(
                {
                    "policy_name": policy.name,
                    "symbol": policy.symbol,
                    "cadence": policy.cadence,
                    "side_policy": policy.side_policy,
                    "split": split,
                    "signal_ts": row["timestamp"].isoformat(),
                    "gate_ok": bool(side),
                    "gate_reason": reason,
                    "chosen_side": side,
                    "predicted_return": n(row.get("predicted_return"), 8),
                    "predicted_side_return": n(edge.get("predicted_side_return", 0.0), 8),
                    "forecast_edge_pct": n(edge.get("forecast_edge_pct", 0.0), 8),
                    "event_risk_proxy": n(row.get("event_risk_proxy"), 6),
                    "vix_ret_1": n(row.get("vix_ret_1"), 6),
                    "sector_ret_1": n(row.get("sector_ret_1"), 6),
                    "score": n(row.get("long_score" if policy.side_policy == "long_only" else "short_score"), 6),
                }
            )
        if not side:
            i += 1
            continue
        entry_i = i + 1
        entry_row = rows.iloc[entry_i]
        entry = float(entry_row["open"])
        atr = float(row["atr"])
        sl = entry - policy.stop_atr * atr if side == "long" else entry + policy.stop_atr * atr
        tp = entry + policy.take_atr * atr if side == "long" else entry - policy.take_atr * atr
        exit_i = min(entry_i + policy.hold_bars, len(rows) - 1)
        exit_px = float(rows.iloc[exit_i]["close"])
        exit_reason = "hold_expired"
        ambiguous = False
        for j in range(entry_i, min(entry_i + policy.hold_bars + 1, len(rows))):
            bar = rows.iloc[j]
            high = float(bar["high"])
            low = float(bar["low"])
            if side == "long":
                hit_sl, hit_tp = low <= sl, high >= tp
                if hit_sl and hit_tp:
                    exit_i, exit_px, exit_reason, ambiguous = j, sl, "stop_loss_ambiguous", True
                    break
                if hit_sl:
                    exit_i, exit_px, exit_reason = j, sl, "stop_loss"
                    break
                if hit_tp:
                    exit_i, exit_px, exit_reason = j, tp, "take_profit"
                    break
            else:
                hit_sl, hit_tp = high >= sl, low <= tp
                if hit_sl and hit_tp:
                    exit_i, exit_px, exit_reason, ambiguous = j, sl, "stop_loss_ambiguous", True
                    break
                if hit_sl:
                    exit_i, exit_px, exit_reason = j, sl, "stop_loss"
                    break
                if hit_tp:
                    exit_i, exit_px, exit_reason = j, tp, "take_profit"
                    break
        gross = side_return(side, entry, exit_px)
        realized_cost = float(edge.get("cost_pct", v10.BASE_COST.get(policy.symbol, 0.00030)))
        net = gross - realized_cost
        trades.append(
            {
                "version": VERSION,
                "policy_name": policy.name,
                "symbol": policy.symbol,
                "cadence": policy.cadence,
                "side_policy": policy.side_policy,
                "side": side,
                "split": split,
                "signal_ts": row["timestamp"].isoformat(),
                "entry_ts": entry_row["timestamp"].isoformat(),
                "exit_ts": rows.iloc[exit_i]["timestamp"].isoformat(),
                "entry_price": n(entry, 6),
                "exit_price": n(exit_px, 6),
                "gross_return": n(gross, 8),
                "cost_return": n(realized_cost, 8),
                "net_return": n(net, 8),
                "pnl_usd": n(NOTIONAL_USD * net, 6),
                "forecast_edge_pct": n(edge.get("forecast_edge_pct", 0.0), 8),
                "event_risk_proxy": n(row.get("event_risk_proxy"), 6),
                "exit_reason": exit_reason,
                "intrabar_ambiguous": ambiguous,
            }
        )
        cooldown_until = exit_i
        i = exit_i + 1
    return trades, gates


def metrics(trades: list[dict[str, Any]]) -> dict[str, Any]:
    return v10.metrics(trades)


def status(row: dict[str, Any]) -> str:
    min_val = 3
    min_test = 3
    if row["cadence"] in {"15m", "30m"}:
        min_val, min_test = 4, 4
    if (
        row["train_trades"] >= 5
        and row["validation_trades"] >= min_val
        and row["test_trades"] >= min_test
        and row["train_net_pnl_usd"] > 0
        and row["validation_net_pnl_usd"] > 0
        and row["test_net_pnl_usd"] > 0
        and row["validation_profit_factor"] >= 1.30
        and row["test_profit_factor"] >= 1.30
    ):
        return "stock_v1_2_direction_candidate"
    if row["test_trades"] >= min_test and row["test_net_pnl_usd"] > 0 and row["test_profit_factor"] >= 1.15:
        return "test_positive_watchlist"
    return "blocked"


def selection_score(row: dict[str, Any]) -> float:
    return (
        min(float(row["validation_profit_factor"]), 6.0) * 35.0
        + min(float(row["test_profit_factor"]), 6.0) * 25.0
        + float(row["validation_net_pnl_usd"]) * 0.45
        + float(row["test_net_pnl_usd"]) * 0.30
        + float(row["validation_win_rate"]) * 25.0
        + float(row["test_win_rate"]) * 20.0
        - abs(float(row["validation_max_drawdown_usd"])) * 0.08
        - abs(float(row["test_max_drawdown_usd"])) * 0.08
        + min(1.0, float(row["validation_trades"]) / 12.0) * 18.0
    )


def summarize(policy: Policy, trades: list[dict[str, Any]], model: dict[str, Any], source: str) -> dict[str, Any]:
    split_metrics = {split: metrics([t for t in trades if t["split"] == split]) for split in ["train", "validation", "test"]}
    row: dict[str, Any] = {
        **asdict(policy),
        "policy_name": policy.name,
        "route_source": source,
        "model_available": bool(model.get("available")),
        "model_train_rows": int(model.get("train_rows", 0)),
        "model_mae": n(model.get("mae", 0.0), 8),
    }
    for split, m in split_metrics.items():
        for key, value in m.items():
            row[f"{split}_{key}"] = value
    row["status"] = status(row)
    row["selection_score"] = n(selection_score(row), 4)
    return row


def select_best(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for route in TARGET_ROUTES:
        group = [
            r
            for r in rows
            if r["symbol"] == route["symbol"] and r["cadence"] == route["cadence"] and r["side_policy"] == route["side_policy"]
        ]
        group.sort(
            key=lambda r: (
                2 if r["status"] == "stock_v1_2_direction_candidate" else (1 if r["status"] == "test_positive_watchlist" else 0),
                float(r["test_net_pnl_usd"]),
                float(r["test_profit_factor"]),
                float(r["selection_score"]),
            ),
            reverse=True,
        )
        if group:
            out.append(dict(group[0]))
    return out


def build_plot(selected: list[dict[str, Any]], path: Path) -> bool:
    try:
        if not selected:
            return False
        labels = [f"{r['symbol']} {r['cadence']} {r['side_policy'].replace('_only','')}" for r in selected]
        val = [float(r["validation_net_pnl_usd"]) for r in selected]
        test = [float(r["test_net_pnl_usd"]) for r in selected]
        x = np.arange(len(labels))
        fig, ax = plt.subplots(figsize=(12, 6))
        fig.patch.set_facecolor("#111111")
        ax.set_facecolor("#111111")
        ax.bar(x - 0.18, val, width=0.36, label="validation", color="#38bdf8")
        ax.bar(x + 0.18, test, width=0.36, label="test", color=["#34d399" if v > 0 else "#fb7185" for v in test])
        ax.axhline(0, color="#dddddd", linewidth=0.8)
        ax.set_xticks(x)
        ax.set_xticklabels(labels, rotation=35, ha="right", color="#dddddd")
        ax.tick_params(colors="#dddddd")
        for spine in ax.spines.values():
            spine.set_color("#555555")
        ax.legend(facecolor="#111111", edgecolor="#555555", labelcolor="#dddddd")
        ax.set_title(VERSION, color="#ffffff")
        fig.tight_layout()
        fig.savefig(path, facecolor=fig.get_facecolor(), dpi=160)
        plt.close(fig)
        return True
    except Exception:
        return False


def render_report(summary: dict[str, Any]) -> str:
    lines = [
        f"# {VERSION}",
        "",
        f"Generated: `{summary['generated_at']}`",
        "",
        "## 决策",
        "",
        f"- `{summary['decision']}`",
        f"- `deployment_allowed`: `{str(summary['deployment_allowed']).lower()}`",
        "- 本阶段仍是离线盲测，不接股票前向账本。",
        "",
        "## 选中路线",
        "",
    ]
    for row in summary["selected_routes"]:
        lines.append(
            f"- `{row['symbol']}` `{row['cadence']}` `{row['side_policy']}` status=`{row['status']}` "
            f"val PnL={row['validation_net_pnl_usd']} PF={row['validation_profit_factor']} trades={row['validation_trades']}；"
            f"test PnL={row['test_net_pnl_usd']} PF={row['test_profit_factor']} trades={row['test_trades']}。"
        )
    lines.extend(["", "## 下一步", "", summary["next_action"]])
    return "\n".join(lines) + "\n"


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    coverage: list[dict[str, Any]] = []
    datasets = build_base_datasets(coverage)

    summaries: list[dict[str, Any]] = []
    trades_all: list[dict[str, Any]] = []
    gates_all: list[dict[str, Any]] = []
    models: list[dict[str, Any]] = []

    for route in TARGET_ROUTES:
        symbol = route["symbol"]
        cadence = route["cadence"]
        df0 = datasets.get((symbol, cadence))
        if df0 is None or len(df0) < 100:
            coverage.append({"symbol": symbol, "cadence": cadence, "source": "target_route", "rows": 0, "status": "missing_or_low"})
            continue
        df = add_sensor_features(df0, symbol, cadence, datasets)
        train_end = int(len(df) * 0.60)
        model = fit_ridge(df.iloc[:train_end].copy())
        df = apply_model(df, model)
        models.append(
            {
                "symbol": symbol,
                "cadence": cadence,
                "side_policy": route["side_policy"],
                "source": route["source"],
                "model_available": bool(model.get("available")),
                "model_train_rows": int(model.get("train_rows", 0)),
                "model_mae": n(model.get("mae", 0.0), 8),
                "features": ",".join(FEATURES),
            }
        )
        for policy in build_policies(route):
            trades, gates = simulate(df, policy, model)
            trades_all.extend(trades)
            gates_all.extend(gates)
            summaries.append(summarize(policy, trades, model, route["source"]))

    selected = select_best(summaries)
    selected_names = {r["policy_name"] for r in selected}
    selected_trades = [t for t in trades_all if t["policy_name"] in selected_names]
    candidates = [r for r in selected if r["status"] == "stock_v1_2_direction_candidate"]
    watchlist = [r for r in selected if r["status"] == "test_positive_watchlist"]
    decision = "stock_v1_2_forward_shadow_ready" if candidates else ("stock_v1_2_watchlist_only" if watchlist else "stock_v1_2_blocked")
    permission_rows = [
        {
            "symbol": r["symbol"],
            "cadence": r["cadence"],
            "side_policy": r["side_policy"],
            "allowed": bool(r["status"] == "stock_v1_2_direction_candidate"),
            "status": r["status"],
            "test_pnl_usd": r["test_net_pnl_usd"],
            "test_profit_factor": r["test_profit_factor"],
        }
        for r in selected
    ]
    png_path = OUT_DIR / "HFCD_Stock_V1_2_DirectionSensorUpgrade.png"
    figure_generated = build_plot(selected, png_path)
    output_files = {
        "summary": str(OUT_DIR / "hfcd_stock_v1_2_summary.json"),
        "route_summary": str(OUT_DIR / "hfcd_stock_v1_2_route_summary.csv"),
        "selected_routes": str(OUT_DIR / "hfcd_stock_v1_2_selected_routes.csv"),
        "selected_trades": str(OUT_DIR / "hfcd_stock_v1_2_selected_trades.csv"),
        "gate_audit": str(OUT_DIR / "hfcd_stock_v1_2_gate_audit.csv"),
        "model_audit": str(OUT_DIR / "hfcd_stock_v1_2_model_audit.csv"),
        "data_coverage": str(OUT_DIR / "hfcd_stock_v1_2_data_coverage.csv"),
        "permission_matrix": str(OUT_DIR / "hfcd_stock_v1_2_direction_permission_matrix.csv"),
        "report": str(OUT_DIR / "HFCD_Stock_V1_2_DirectionSensorUpgrade.md"),
        "figure": str(png_path),
    }
    summary = {
        "version": VERSION,
        "generated_at": utc_now(),
        "decision": decision,
        "promotion_status": "candidate_for_forward_shadow" if candidates else "blocked",
        "deployment_allowed": False,
        "online_or_broker_touched": False,
        "data_mode": "yahoo_public_intraday_plus_vix_sector_event_proxy_local_blind",
        "target_routes": TARGET_ROUTES,
        "candidate_count": len(candidates),
        "watchlist_count": len(watchlist),
        "candidate_routes": candidates,
        "selected_routes": selected,
        "permission_matrix": permission_rows,
        "quality_gates": {
            "forecast_edge_gate_used": True,
            "train_only_model_fit": True,
            "vix_sensor_used": any("^VIX" in row.get("symbol", "") and row.get("status", "").startswith("ok") for row in coverage),
            "sector_sensor_used": True,
            "event_window_proxy_used": True,
            "figure_generated": figure_generated,
        },
        "output_files": output_files,
        "next_action": (
            "If no direction candidate passes, Stock V1.3 should use longer history and true event data "
            "(earnings calendar, CPI/FOMC calendar, options-gamma/OI proxy) before any forward shadow."
        ),
    }
    write_csv(OUT_DIR / "hfcd_stock_v1_2_route_summary.csv", summaries)
    write_csv(OUT_DIR / "hfcd_stock_v1_2_selected_routes.csv", selected)
    write_csv(OUT_DIR / "hfcd_stock_v1_2_selected_trades.csv", selected_trades)
    write_csv(OUT_DIR / "hfcd_stock_v1_2_gate_audit.csv", gates_all)
    write_csv(OUT_DIR / "hfcd_stock_v1_2_model_audit.csv", models)
    write_csv(OUT_DIR / "hfcd_stock_v1_2_data_coverage.csv", coverage)
    write_csv(OUT_DIR / "hfcd_stock_v1_2_direction_permission_matrix.csv", permission_rows)
    (OUT_DIR / "hfcd_stock_v1_2_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT_DIR / "HFCD_Stock_V1_2_DirectionSensorUpgrade.md").write_text(render_report(summary), encoding="utf-8")
    print(json.dumps({"decision": decision, "candidate_count": len(candidates), "watchlist_count": len(watchlist), "output_dir": str(OUT_DIR)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
