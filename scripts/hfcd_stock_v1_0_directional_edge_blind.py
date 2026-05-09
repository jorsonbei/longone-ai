#!/usr/bin/env python3
"""HFCD Stock V1.0: directional forecast-edge blind test.

Offline research only. This script does not touch online pages, broker APIs,
Testnet accounts, Worker/D1 ledgers, or real orders.

Scope:
- SPY/QQQ/IWM plus NVDA/TSLA/AAPL/MSFT/AMD.
- 15m/30m/1h/2h/3h horizons.
- long_only, short_only, and both are tested together but promoted separately.
- Entry is next bar open; target selection uses train split only.
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


VERSION = "HFCD_Stock_V1_0_DirectionalEdgeBlind"
ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "outputs" / "hfcd_stock_v1_0_directional_edge_blind"
RAW_DIR = OUT_DIR / "raw_yahoo_chart"

SYMBOLS = ["SPY", "QQQ", "IWM", "NVDA", "TSLA", "AAPL", "MSFT", "AMD"]
INDEX_SYMBOLS = {"SPY", "QQQ", "IWM"}
CADENCES = {
    "15m": "15min",
    "30m": "30min",
    "1h": "60min",
    "2h": "120min",
    "3h": "180min",
}
BASE_INTERVAL = "15m"
FETCH_RANGE = "60d"
NOTIONAL_USD = 1000.0
STARTING_EQUITY_USD = 10000.0

FEATURES = [
    "ret_1",
    "ret_2",
    "ret_4",
    "ret_8",
    "ret_16",
    "range_pct",
    "atr_pct",
    "volume_ratio",
    "dollar_volume_ratio",
    "trend_efficiency",
    "hfcd_q_core",
    "hfcd_cavity",
    "hfcd_eta_health",
    "hfcd_bsigma_health",
    "bar_pos",
    "opening_risk",
    "closing_risk",
    "is_friday",
    "spy_ret_1",
    "spy_ret_4",
    "qqq_ret_1",
    "qqq_ret_4",
    "relative_spy_4",
    "relative_qqq_4",
]

BASE_COST = {
    "SPY": 0.00018,
    "QQQ": 0.00020,
    "IWM": 0.00026,
    "AAPL": 0.00022,
    "MSFT": 0.00022,
    "NVDA": 0.00034,
    "TSLA": 0.00038,
    "AMD": 0.00034,
}


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

    @property
    def name(self) -> str:
        return (
            f"{self.symbol}_{self.cadence}_{self.side_policy}_"
            f"score{self.score_floor:.2f}_edge{self.edge_floor:.4f}_"
            f"hold{self.hold_bars}_sl{self.stop_atr:.1f}_tp{self.take_atr:.1f}"
        )


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def n(value: Any, digits: int = 6) -> float:
    try:
        out = float(value)
        if not math.isfinite(out):
            return 0.0
        return round(out, digits)
    except Exception:
        return 0.0


def sigmoid(x: float) -> float:
    try:
        return 1.0 / (1.0 + math.exp(-x))
    except OverflowError:
        return 0.0 if x < 0 else 1.0


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
    req = urllib.request.Request(url, headers={"User-Agent": "HFCD-Stock-V1/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_yahoo_15m(symbol: str) -> pd.DataFrame:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    cache = RAW_DIR / f"{symbol}_{FETCH_RANGE}_{BASE_INTERVAL}.json"
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol)}?"
        + urllib.parse.urlencode({"range": FETCH_RANGE, "interval": BASE_INTERVAL, "includePrePost": "false"})
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
    df = pd.DataFrame(
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
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df = df.dropna().sort_values("timestamp").reset_index(drop=True)
    df["symbol"] = symbol
    return df


def resample_ohlcv(base: pd.DataFrame, cadence: str) -> pd.DataFrame:
    rule = CADENCES[cadence]
    indexed = base.set_index("timestamp").sort_index()
    out = (
        indexed.resample(rule, label="right", closed="right")
        .agg({"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"})
        .dropna()
        .reset_index()
    )
    out["symbol"] = str(base["symbol"].iloc[0])
    out["cadence"] = cadence
    return out


def add_bar_context(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    session = out["timestamp"].dt.date
    out["bar_in_session"] = out.groupby(session).cumcount()
    out["bars_in_session"] = out.groupby(session)["timestamp"].transform("count").clip(lower=1)
    out["bar_pos"] = out["bar_in_session"] / (out["bars_in_session"] - 1).replace(0, 1)
    out["opening_risk"] = (out["bar_in_session"] <= 1).astype(float)
    out["closing_risk"] = (out["bar_in_session"] >= (out["bars_in_session"] - 2)).astype(float)
    out["is_friday"] = (out["timestamp"].dt.weekday == 4).astype(float)
    return out


def enrich(df: pd.DataFrame) -> pd.DataFrame:
    out = add_bar_context(df.sort_values("timestamp").copy().reset_index(drop=True))
    close = out["close"].astype(float)
    volume = out["volume"].replace(0, np.nan).ffill().fillna(1.0).astype(float)
    ret = close.pct_change().fillna(0.0)
    prev_close = close.shift(1)
    tr = pd.concat(
        [
            (out["high"] - out["low"]).abs(),
            (out["high"] - prev_close).abs(),
            (out["low"] - prev_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    atr = tr.rolling(14, min_periods=4).mean().fillna(tr.expanding().mean()).clip(lower=1e-9)
    atr_pct = (atr / close).replace([np.inf, -np.inf], np.nan).fillna(0.0).clip(lower=0.00001)
    range_pct = ((out["high"] - out["low"]) / close).replace([np.inf, -np.inf], np.nan).fillna(0.0)
    dollar_volume = (close * volume).replace(0, np.nan)

    for w in [1, 2, 4, 8, 16]:
        out[f"ret_{w}"] = close.pct_change(w).fillna(0.0)

    vol_slow = ret.rolling(32, min_periods=8).std().fillna(ret.std() or 0.001).clip(lower=0.00001)
    volume_ratio = (volume / volume.rolling(32, min_periods=8).median()).replace([np.inf, -np.inf], np.nan).fillna(1.0)
    dollar_volume_ratio = (
        dollar_volume / dollar_volume.rolling(32, min_periods=8).median()
    ).replace([np.inf, -np.inf], np.nan).fillna(1.0)
    trend_span = (close - close.shift(8)).abs()
    path = close.diff().abs().rolling(8, min_periods=4).sum().replace(0, np.nan)
    trend_efficiency = (trend_span / path).replace([np.inf, -np.inf], np.nan).fillna(0.0).clip(0.0, 1.0)
    vwap = ((close * volume).rolling(32, min_periods=8).sum() / volume.rolling(32, min_periods=8).sum()).fillna(close)
    q_ratio = (close / vwap - 1.0).replace([np.inf, -np.inf], np.nan).fillna(0.0)

    out["atr"] = atr
    out["atr_pct"] = atr_pct
    out["range_pct"] = range_pct
    out["volume_ratio"] = volume_ratio.clip(0.0, 8.0)
    out["dollar_volume_ratio"] = dollar_volume_ratio.clip(0.0, 8.0)
    out["trend_efficiency"] = trend_efficiency
    out["q_ratio"] = q_ratio
    out["future_return"] = close.shift(-1) / close - 1.0

    out["hfcd_q_core"] = (1.0 - (q_ratio.abs() / 0.035).clip(0.0, 1.0) * 0.35).clip(0.0, 1.0)
    out["hfcd_cavity"] = (
        0.55 * (1.0 / (1.0 + out["volume_ratio"].sub(1.0).abs()))
        + 0.45 * (1.0 - (range_pct / (vol_slow * 6.0)).clip(0.0, 1.0))
    ).clip(0.0, 1.0)
    out["hfcd_eta_health"] = (1.0 - ((atr_pct / atr_pct.rolling(32, min_periods=8).median()).sub(1.0).abs() / 2.5)).clip(0.0, 1.0).fillna(0.5)
    out["hfcd_bsigma_health"] = (
        1.0
        - (
            out["opening_risk"] * 0.18
            + out["closing_risk"] * 0.12
            + (range_pct / (vol_slow * 7.0)).clip(0.0, 1.0) * 0.45
            + (out["volume_ratio"] / 8.0).clip(0.0, 1.0) * 0.25
        )
    ).clip(0.0, 1.0)
    return out.dropna(subset=["future_return"]).reset_index(drop=True)


def add_reference_features(datasets: dict[tuple[str, str], pd.DataFrame]) -> None:
    for cadence in CADENCES:
        spy = datasets.get(("SPY", cadence))
        qqq = datasets.get(("QQQ", cadence))
        spy_ref = None
        qqq_ref = None
        if spy is not None:
            spy_ref = spy[["timestamp", "ret_1", "ret_4"]].rename(columns={"ret_1": "spy_ret_1", "ret_4": "spy_ret_4"})
        if qqq is not None:
            qqq_ref = qqq[["timestamp", "ret_1", "ret_4"]].rename(columns={"ret_1": "qqq_ret_1", "ret_4": "qqq_ret_4"})
        for key, df in list(datasets.items()):
            if key[1] != cadence:
                continue
            out = df.copy()
            if spy_ref is not None:
                out = out.merge(spy_ref, on="timestamp", how="left")
            if qqq_ref is not None:
                out = out.merge(qqq_ref, on="timestamp", how="left")
            for col in ["spy_ret_1", "spy_ret_4", "qqq_ret_1", "qqq_ret_4"]:
                if col not in out:
                    out[col] = 0.0
                out[col] = out[col].fillna(0.0)
            out["relative_spy_4"] = out["ret_4"] - out["spy_ret_4"]
            out["relative_qqq_4"] = out["ret_4"] - out["qqq_ret_4"]
            datasets[key] = out


def split_label(i: int, n_rows: int) -> str:
    if i < int(n_rows * 0.60):
        return "train"
    if i < int(n_rows * 0.80):
        return "validation"
    return "test"


def fit_ridge(train: pd.DataFrame) -> dict[str, Any]:
    usable = train.dropna(subset=FEATURES + ["future_return"]).copy()
    if len(usable) < 80:
        return {"available": False, "reason": "insufficient_train_rows"}
    x = usable[FEATURES].astype(float).replace([np.inf, -np.inf], 0.0).fillna(0.0).to_numpy()
    y = usable["future_return"].astype(float).to_numpy()
    mean = x.mean(axis=0)
    std = x.std(axis=0)
    std[std == 0] = 1.0
    z = (x - mean) / std
    design = np.column_stack([np.ones(len(z)), z])
    alpha = 3.0
    reg = np.eye(design.shape[1]) * alpha
    reg[0, 0] = 0.0
    beta = np.linalg.pinv(design.T @ design + reg) @ design.T @ y
    pred = design @ beta
    mae = float(np.mean(np.abs(pred - y)))
    return {
        "available": True,
        "features": FEATURES,
        "mean": mean.tolist(),
        "std": std.tolist(),
        "beta": beta.tolist(),
        "mae": mae,
        "train_rows": int(len(usable)),
    }


def apply_model(df: pd.DataFrame, model: dict[str, Any]) -> pd.DataFrame:
    out = df.copy()
    if not model.get("available"):
        out["predicted_return"] = 0.0
        return out
    x = out[FEATURES].astype(float).replace([np.inf, -np.inf], 0.0).fillna(0.0).to_numpy()
    mean = np.array(model["mean"], dtype=float)
    std = np.array(model["std"], dtype=float)
    beta = np.array(model["beta"], dtype=float)
    z = (x - mean) / std
    design = np.column_stack([np.ones(len(z)), z])
    out["predicted_return"] = design @ beta
    scale = (out["atr_pct"].clip(lower=0.0001) * 0.85).astype(float)
    out["long_score"] = (
        0.46 * out["predicted_return"].div(scale).map(sigmoid)
        + 0.16 * out["hfcd_cavity"]
        + 0.14 * out["hfcd_eta_health"]
        + 0.12 * out["hfcd_bsigma_health"]
        + 0.08 * out["trend_efficiency"]
        + 0.04 * out["hfcd_q_core"]
    ).clip(0.0, 1.0)
    out["short_score"] = (
        0.46 * (-out["predicted_return"]).div(scale).map(sigmoid)
        + 0.16 * out["hfcd_cavity"]
        + 0.14 * out["hfcd_eta_health"]
        + 0.12 * out["hfcd_bsigma_health"]
        + 0.08 * out["trend_efficiency"]
        + 0.04 * out["hfcd_q_core"]
    ).clip(0.0, 1.0)
    return out


def forecast_edge(row: pd.Series, symbol: str, side: str, model_mae: float) -> dict[str, float]:
    predicted_side_return = float(row["predicted_return"]) if side == "long" else -float(row["predicted_return"])
    cost = BASE_COST.get(symbol, 0.00030) + 0.05 * float(row["atr_pct"])
    noise = max(0.00025, min(0.0035, 0.25 * model_mae + 0.10 * float(row["atr_pct"])))
    event_buffer = 0.00012 * float(row.get("opening_risk", 0.0)) + 0.00008 * float(row.get("closing_risk", 0.0))
    edge = predicted_side_return - cost - noise - event_buffer
    return {
        "predicted_side_return": predicted_side_return,
        "cost_pct": cost,
        "noise_buffer_pct": noise,
        "event_buffer_pct": event_buffer,
        "forecast_edge_pct": edge,
    }


def side_return(side: str, entry: float, exit_: float) -> float:
    return exit_ / entry - 1.0 if side == "long" else entry / exit_ - 1.0


def build_policies(symbol: str, cadence: str) -> list[Policy]:
    policies: list[Policy] = []
    if symbol in INDEX_SYMBOLS:
        score_floors = [0.58, 0.64]
        edge_floors = [0.0, 0.00020]
        min_cavity = 0.36
        min_eta = 0.30
    else:
        score_floors = [0.60, 0.66]
        edge_floors = [0.0, 0.00030]
        min_cavity = 0.34
        min_eta = 0.26
    hold_options = {
        "15m": [1, 2],
        "30m": [1, 2],
        "1h": [1, 2],
        "2h": [1],
        "3h": [1],
    }[cadence]
    exits = [(0.9, 1.4), (1.2, 2.0)]
    for side_policy in ["long_only", "short_only", "both"]:
        for score_floor in score_floors:
            for edge_floor in edge_floors:
                for hold in hold_options:
                    for stop_atr, take_atr in exits:
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
                                min_cavity=min_cavity,
                                min_eta_health=min_eta,
                            )
                        )
    return policies


def decide_signal(row: pd.Series, policy: Policy, model_mae: float) -> tuple[str, dict[str, float], str]:
    if float(row["hfcd_cavity"]) < policy.min_cavity:
        return "", {}, "cavity_below_floor"
    if float(row["hfcd_eta_health"]) < policy.min_eta_health:
        return "", {}, "eta_health_below_floor"
    long_edge = forecast_edge(row, policy.symbol, "long", model_mae)
    short_edge = forecast_edge(row, policy.symbol, "short", model_mae)
    long_ok = (
        policy.side_policy in {"long_only", "both"}
        and float(row["long_score"]) >= policy.score_floor
        and long_edge["forecast_edge_pct"] >= policy.edge_floor
    )
    short_ok = (
        policy.side_policy in {"short_only", "both"}
        and float(row["short_score"]) >= policy.score_floor
        and short_edge["forecast_edge_pct"] >= policy.edge_floor
    )
    if policy.side_policy == "long_only":
        return ("long", long_edge, "edge_long_confirmed") if long_ok else ("", long_edge, "long_edge_or_score_failed")
    if policy.side_policy == "short_only":
        return ("short", short_edge, "edge_short_confirmed") if short_ok else ("", short_edge, "short_edge_or_score_failed")
    if long_ok and short_ok:
        if long_edge["forecast_edge_pct"] >= short_edge["forecast_edge_pct"]:
            return "long", long_edge, "both_choose_long_by_edge"
        return "short", short_edge, "both_choose_short_by_edge"
    if long_ok:
        return "long", long_edge, "both_long_only_passed"
    if short_ok:
        return "short", short_edge, "both_short_only_passed"
    better = long_edge if long_edge["forecast_edge_pct"] >= short_edge["forecast_edge_pct"] else short_edge
    return "", better, "both_edge_or_score_failed"


def simulate(df: pd.DataFrame, policy: Policy, model: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    rows = df.reset_index(drop=True)
    trades: list[dict[str, Any]] = []
    gate_rows: list[dict[str, Any]] = []
    if len(rows) < 140 or not model.get("available"):
        return trades, gate_rows
    model_mae = float(model.get("mae", 0.001))
    i = 40
    cooldown_until = -1
    while i < len(rows) - policy.hold_bars - 2:
        if i <= cooldown_until:
            i += 1
            continue
        row = rows.iloc[i]
        split = split_label(i, len(rows))
        side, edge, reason = decide_signal(row, policy, model_mae)
        if side or (split != "train" and i % 25 == 0):
            gate_rows.append(
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
                    "cost_pct": n(edge.get("cost_pct", 0.0), 8),
                    "noise_buffer_pct": n(edge.get("noise_buffer_pct", 0.0), 8),
                    "event_buffer_pct": n(edge.get("event_buffer_pct", 0.0), 8),
                    "long_score": n(row.get("long_score"), 6),
                    "short_score": n(row.get("short_score"), 6),
                    "hfcd_cavity": n(row.get("hfcd_cavity"), 6),
                    "hfcd_eta_health": n(row.get("hfcd_eta_health"), 6),
                    "hfcd_bsigma_health": n(row.get("hfcd_bsigma_health"), 6),
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
                hit_sl = low <= sl
                hit_tp = high >= tp
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
                hit_sl = high >= sl
                hit_tp = low <= tp
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
        realized_cost = float(edge.get("cost_pct", BASE_COST.get(policy.symbol, 0.00030)))
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
                "predicted_side_return": n(edge.get("predicted_side_return", 0.0), 8),
                "exit_reason": exit_reason,
                "intrabar_ambiguous": ambiguous,
            }
        )
        cooldown_until = exit_i
        i = exit_i + 1
    return trades, gate_rows


def metrics(trades: list[dict[str, Any]]) -> dict[str, Any]:
    if not trades:
        return {
            "trades": 0,
            "win_rate": 0.0,
            "net_pnl_usd": 0.0,
            "profit_factor": 0.0,
            "max_drawdown_usd": 0.0,
            "avg_pnl_usd": 0.0,
            "actions_per_day": 0.0,
        }
    pnl = [float(t["pnl_usd"]) for t in trades]
    wins = [x for x in pnl if x > 0]
    losses = [x for x in pnl if x < 0]
    equity = 0.0
    peak = 0.0
    max_dd = 0.0
    for x in pnl:
        equity += x
        peak = max(peak, equity)
        max_dd = min(max_dd, equity - peak)
    dates = {str(t["entry_ts"])[:10] for t in trades}
    return {
        "trades": len(pnl),
        "win_rate": n(len(wins) / len(pnl), 6),
        "net_pnl_usd": n(sum(pnl), 4),
        "profit_factor": n(sum(wins) / abs(sum(losses)), 6) if losses else (999.0 if wins else 0.0),
        "max_drawdown_usd": n(max_dd, 4),
        "avg_pnl_usd": n(sum(pnl) / len(pnl), 4),
        "actions_per_day": n(len(pnl) / max(1, len(dates)), 4),
    }


def status(row: dict[str, Any]) -> str:
    min_val_trades = 4 if row["cadence"] in {"2h", "3h"} else 5
    min_test_trades = 4 if row["cadence"] in {"2h", "3h"} else 5
    if (
        row["train_trades"] >= 8
        and row["validation_trades"] >= min_val_trades
        and row["test_trades"] >= min_test_trades
        and row["train_net_pnl_usd"] > 0
        and row["validation_net_pnl_usd"] > 0
        and row["test_net_pnl_usd"] > 0
        and row["validation_profit_factor"] >= 1.30
        and row["test_profit_factor"] >= 1.30
    ):
        return "stock_edge_candidate"
    if row["test_trades"] >= min_test_trades and row["test_net_pnl_usd"] > 0 and row["test_profit_factor"] >= 1.15:
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


def summarize_policy(policy: Policy, trades: list[dict[str, Any]], model: dict[str, Any], rows: int) -> dict[str, Any]:
    split_metrics = {split: metrics([t for t in trades if t["split"] == split]) for split in ["train", "validation", "test"]}
    out: dict[str, Any] = {
        **asdict(policy),
        "policy_name": policy.name,
        "data_rows": rows,
        "model_available": bool(model.get("available", False)),
        "model_train_rows": int(model.get("train_rows", 0)),
        "model_mae": n(model.get("mae", 0.0), 8),
    }
    for split, m in split_metrics.items():
        for k, v in m.items():
            out[f"{split}_{k}"] = v
    out["status"] = status(out)
    out["selection_score"] = n(selection_score(out), 4)
    return out


def status_rank(value: str) -> int:
    return {"stock_edge_candidate": 3, "test_positive_watchlist": 1, "blocked": 0}.get(value, 0)


def select_best(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    for symbol in SYMBOLS:
        for cadence in CADENCES:
            for side_policy in ["long_only", "short_only", "both"]:
                group = [r for r in rows if r["symbol"] == symbol and r["cadence"] == cadence and r["side_policy"] == side_policy]
                if not group:
                    continue
                group.sort(
                    key=lambda r: (
                        status_rank(str(r["status"])),
                        float(r["test_net_pnl_usd"]),
                        float(r["test_profit_factor"]),
                        float(r["selection_score"]),
                    ),
                    reverse=True,
                )
                selected.append(dict(group[0]))
    return selected


def build_permission_matrix(selected: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for symbol in SYMBOLS:
        for cadence in CADENCES:
            long_route = next((r for r in selected if r["symbol"] == symbol and r["cadence"] == cadence and r["side_policy"] == "long_only"), None)
            short_route = next((r for r in selected if r["symbol"] == symbol and r["cadence"] == cadence and r["side_policy"] == "short_only"), None)
            out.append(
                {
                    "symbol": symbol,
                    "cadence": cadence,
                    "long_allowed": bool(long_route and long_route["status"] == "stock_edge_candidate"),
                    "short_allowed": bool(short_route and short_route["status"] == "stock_edge_candidate"),
                    "long_status": long_route["status"] if long_route else "missing",
                    "short_status": short_route["status"] if short_route else "missing",
                    "long_test_pnl_usd": long_route["test_net_pnl_usd"] if long_route else 0.0,
                    "short_test_pnl_usd": short_route["test_net_pnl_usd"] if short_route else 0.0,
                }
            )
    return out


def load_datasets() -> tuple[dict[tuple[str, str], pd.DataFrame], list[dict[str, Any]]]:
    base_data: dict[str, pd.DataFrame] = {}
    coverage: list[dict[str, Any]] = []
    for symbol in SYMBOLS:
        try:
            base = fetch_yahoo_15m(symbol)
            base_data[symbol] = base
            coverage.append(
                {
                    "symbol": symbol,
                    "source": "yahoo_chart_15m",
                    "range": FETCH_RANGE,
                    "rows": len(base),
                    "first_ts": base["timestamp"].min().isoformat() if len(base) else "",
                    "last_ts": base["timestamp"].max().isoformat() if len(base) else "",
                    "status": "ok" if len(base) >= 300 else "coverage_low",
                }
            )
        except Exception as exc:
            coverage.append({"symbol": symbol, "source": "yahoo_chart_15m", "rows": 0, "status": f"error:{exc}"})
    datasets: dict[tuple[str, str], pd.DataFrame] = {}
    for symbol, base in base_data.items():
        for cadence in CADENCES:
            try:
                datasets[(symbol, cadence)] = enrich(resample_ohlcv(base, cadence))
            except Exception as exc:
                coverage.append({"symbol": symbol, "cadence": cadence, "source": "resample", "rows": 0, "status": f"error:{exc}"})
    add_reference_features(datasets)
    for (symbol, cadence), df in datasets.items():
        coverage.append(
            {
                "symbol": symbol,
                "cadence": cadence,
                "source": "yahoo_chart_15m_resampled",
                "rows": len(df),
                "first_ts": df["timestamp"].min().isoformat() if len(df) else "",
                "last_ts": df["timestamp"].max().isoformat() if len(df) else "",
                "status": "ok" if len(df) >= 120 else "coverage_low",
            }
        )
    return datasets, coverage


def build_plot(selected: list[dict[str, Any]], path: Path) -> bool:
    try:
        top = sorted(selected, key=lambda r: float(r["selection_score"]), reverse=True)[:24]
        labels = [f"{r['symbol']} {r['cadence']} {r['side_policy'].replace('_only','')}" for r in top]
        test_pnl = [float(r["test_net_pnl_usd"]) for r in top]
        val_pnl = [float(r["validation_net_pnl_usd"]) for r in top]
        fig, ax = plt.subplots(figsize=(15, 7))
        fig.patch.set_facecolor("#111111")
        ax.set_facecolor("#111111")
        x = np.arange(len(labels))
        ax.bar(x - 0.18, val_pnl, width=0.36, label="validation", color="#38bdf8")
        ax.bar(x + 0.18, test_pnl, width=0.36, label="test", color=["#34d399" if v > 0 else "#fb7185" for v in test_pnl])
        ax.axhline(0, color="#dddddd", linewidth=0.8)
        ax.set_xticks(x)
        ax.set_xticklabels(labels, rotation=45, ha="right", color="#dddddd")
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
        f"- `online_or_broker_touched`: `false`",
        "",
        "## 规则",
        "",
        "- 做多、做空、both 同时盲测，但晋级权限按方向分开。",
        "- 开仓必须通过 ForecastEdge：预测未来收益 - 成本 - 噪音缓冲 - 事件缓冲。",
        "- train、validation、test 都扣成本为正，且 validation/test PF >= 1.30，才允许进入下一步 forward shadow。",
        "",
        "## 允许方向",
        "",
    ]
    allowed = [r for r in summary["permission_matrix"] if r["long_allowed"] or r["short_allowed"]]
    if not allowed:
        lines.append("- 本轮没有任何方向达到 forward shadow 门槛。")
    else:
        for row in allowed:
            lines.append(
                f"- `{row['symbol']}` `{row['cadence']}` long_allowed={row['long_allowed']} short_allowed={row['short_allowed']} "
                f"long_test={row['long_test_pnl_usd']} short_test={row['short_test_pnl_usd']}"
            )
    lines.extend(["", "## Top Routes", ""])
    for row in summary["top_selected"][:20]:
        lines.append(
            f"- `{row['symbol']}` `{row['cadence']}` `{row['side_policy']}` status=`{row['status']}` "
            f"val PnL={row['validation_net_pnl_usd']} PF={row['validation_profit_factor']} trades={row['validation_trades']}；"
            f"test PnL={row['test_net_pnl_usd']} PF={row['test_profit_factor']} trades={row['test_trades']}。"
        )
    return "\n".join(lines) + "\n"


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    datasets, coverage = load_datasets()
    write_csv(OUT_DIR / "hfcd_stock_v1_0_data_coverage.csv", coverage)

    summaries: list[dict[str, Any]] = []
    all_trades: list[dict[str, Any]] = []
    gate_audit: list[dict[str, Any]] = []
    model_rows: list[dict[str, Any]] = []

    for (symbol, cadence), df0 in datasets.items():
        if len(df0) < 140:
            continue
        n_rows = len(df0)
        train_end = int(n_rows * 0.60)
        model = fit_ridge(df0.iloc[:train_end].copy())
        df = apply_model(df0, model)
        model_rows.append(
            {
                "symbol": symbol,
                "cadence": cadence,
                "available": bool(model.get("available")),
                "train_rows": int(model.get("train_rows", 0)),
                "mae": n(model.get("mae", 0.0), 8),
                "reason": model.get("reason", ""),
            }
        )
        for policy in build_policies(symbol, cadence):
            trades, gates = simulate(df, policy, model)
            all_trades.extend(trades)
            gate_audit.extend(gates)
            summaries.append(summarize_policy(policy, trades, model, len(df)))

    selected = select_best(summaries)
    selected_names = {row["policy_name"] for row in selected}
    selected_trades = [row for row in all_trades if row["policy_name"] in selected_names]
    permission_matrix = build_permission_matrix(selected)
    direction_candidates = [
        row
        for row in selected
        if row["status"] == "stock_edge_candidate" and row["side_policy"] in {"long_only", "short_only"}
    ]
    combo_candidates = [
        row
        for row in selected
        if row["status"] == "stock_edge_candidate" and row["side_policy"] == "both"
    ]
    watchlist = [row for row in selected if row["status"] == "test_positive_watchlist"]
    top_selected = sorted(selected, key=lambda r: float(r["selection_score"]), reverse=True)[:40]
    decision = "stock_v1_forward_shadow_ready" if direction_candidates else ("stock_v1_watchlist_only" if watchlist or combo_candidates else "stock_v1_blocked")

    png_path = OUT_DIR / "HFCD_Stock_V1_0_DirectionalEdgeBlind.png"
    figure_generated = build_plot(top_selected, png_path)

    output_files = {
        "summary": str(OUT_DIR / "hfcd_stock_v1_0_summary.json"),
        "policy_summary": str(OUT_DIR / "hfcd_stock_v1_0_policy_summary.csv"),
        "selected_routes": str(OUT_DIR / "hfcd_stock_v1_0_selected_routes.csv"),
        "permission_matrix": str(OUT_DIR / "hfcd_stock_v1_0_direction_permission_matrix.csv"),
        "selected_trades": str(OUT_DIR / "hfcd_stock_v1_0_selected_trades.csv"),
        "gate_audit": str(OUT_DIR / "hfcd_stock_v1_0_gate_audit.csv"),
        "model_audit": str(OUT_DIR / "hfcd_stock_v1_0_model_audit.csv"),
        "data_coverage": str(OUT_DIR / "hfcd_stock_v1_0_data_coverage.csv"),
        "report": str(OUT_DIR / "HFCD_Stock_V1_0_DirectionalEdgeBlind.md"),
        "figure": str(png_path),
    }
    summary = {
        "version": VERSION,
        "generated_at": utc_now(),
        "decision": decision,
        "promotion_status": "candidate_for_forward_shadow" if direction_candidates else "blocked",
        "deployment_allowed": False,
        "online_or_broker_touched": False,
        "data_mode": "yahoo_public_intraday_15m_resampled_local_blind",
        "scope": {
            "symbols": SYMBOLS,
            "cadences": list(CADENCES.keys()),
            "side_policies": ["long_only", "short_only", "both"],
            "entry_model": "signal_bar_close_then_next_bar_open",
            "promotion_gate": "train validation and test must all pass after costs with enough trades and PF >= 1.30",
        },
        "quality_gates": {
            "supports_long_short": True,
            "long_short_promoted_separately": True,
            "forecast_edge_gate_used": True,
            "position_controller_rule": "no-position open only when forecast-edge passes; add/reduce/reverse are next forward-controller stage, not enabled by this blind test",
            "figure_generated": figure_generated,
        },
        "candidate_count": len(direction_candidates),
        "combo_candidate_count": len(combo_candidates),
        "watchlist_count": len(watchlist),
        "candidate_routes": direction_candidates,
        "combo_candidate_routes": combo_candidates,
        "permission_matrix": permission_matrix,
        "top_selected": top_selected,
        "output_files": output_files,
        "next_action": "If candidates exist, build Stock V1.1 forward shadow only for permitted directions; otherwise add real stock sensors such as VIX, sector ETF coupling, earnings/calendar events, and options-gamma proxy before retesting.",
    }

    write_csv(OUT_DIR / "hfcd_stock_v1_0_policy_summary.csv", summaries)
    write_csv(OUT_DIR / "hfcd_stock_v1_0_selected_routes.csv", selected)
    write_csv(OUT_DIR / "hfcd_stock_v1_0_direction_permission_matrix.csv", permission_matrix)
    write_csv(OUT_DIR / "hfcd_stock_v1_0_selected_trades.csv", selected_trades)
    write_csv(OUT_DIR / "hfcd_stock_v1_0_gate_audit.csv", gate_audit)
    write_csv(OUT_DIR / "hfcd_stock_v1_0_model_audit.csv", model_rows)
    (OUT_DIR / "hfcd_stock_v1_0_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT_DIR / "HFCD_Stock_V1_0_DirectionalEdgeBlind.md").write_text(render_report(summary), encoding="utf-8")
    print(json.dumps({"decision": decision, "candidate_count": len(direction_candidates), "combo_candidate_count": len(combo_candidates), "watchlist_count": len(watchlist), "output_dir": str(OUT_DIR)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
