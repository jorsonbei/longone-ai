#!/usr/bin/env python3
"""HFCD Trading V2.8: 60-day crypto L2 + metrics + stablecoin retrain.

Local-only research run. It consumes the V2.7 sensor audit outputs and compares
four lineages on exactly the same BTC/ETH 5m window:

- legacy_price_volume
- metrics_only
- l2_metrics
- l2_metrics_stablecoin

The point is to test whether the longer L2/metrics window and stablecoin ledger
actually improve paper trading quality before any online promotion.
"""

from __future__ import annotations

import csv
import json
import math
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


VERSION = "HFCD_Trading_V2_8_CryptoExtendedL2StablecoinTrain"
ROOT = Path.cwd()
V27_DIR = ROOT / "outputs" / "hfcd_trading_v2_7_crypto_extended_l2_sensor_audit"
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v2_8_crypto_extended_l2_stablecoin_train"
SYMBOLS = ["BTCUSDT", "ETHUSDT"]
INTERVAL = "5m"
NOTIONAL_USD = 1000.0
BASE_ROUNDTRIP_COST = 0.0012
L2_COST_SLOPE = 0.00022
STABLECOIN_COST_GUARD = 0.00005


@dataclass(frozen=True)
class ParamSet:
    symbol: str
    family: str
    mode: str
    policy_name: str
    holding_bars: int
    min_score: float
    min_property: float
    min_q: float
    min_cavity: float
    max_b_sigma: float
    max_eta: float
    stop_loss: float
    take_profit: float
    trail_activate: float
    trail_giveback: float
    cooldown_bars: int
    side_policy: str
    exit_mode: str


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as fh:
        return list(csv.DictReader(fh))


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    headers = list(rows[0].keys())
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=headers)
        writer.writeheader()
        writer.writerows(rows)


def to_float(value: Any) -> float:
    try:
        out = float(value)
        return out if math.isfinite(out) else 0.0
    except Exception:
        return 0.0


def number(value: float, digits: int = 6) -> float:
    return round(float(value or 0.0), digits)


def clamp(value: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, value))


def mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def std(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    m = mean(values)
    return math.sqrt(sum((x - m) ** 2 for x in values) / (len(values) - 1))


def percentile(values: list[float], p: float) -> float:
    clean = sorted(x for x in values if math.isfinite(x))
    if not clean:
        return 0.0
    idx = min(len(clean) - 1, max(0, int((len(clean) - 1) * p)))
    return clean[idx]


def iso_from_ms(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat().replace("+00:00", "Z").replace(".000Z", "Z")


def fetch_json(url: str) -> Any:
    last = ""
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "HFCD-ThingNature-OS/2.8", "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=35) as resp:
                return json.loads(resp.read().decode("utf-8", "ignore"))
        except Exception as exc:  # noqa: BLE001
            last = str(exc)
            time.sleep(0.45 + attempt * 0.35)
    raise RuntimeError(f"fetch failed: {url} :: {last}")


def fetch_klines(symbol: str, date_start: str, date_end: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    interval_ms = 5 * 60 * 1000
    cursor = int(datetime.fromisoformat(f"{date_start}T00:00:00+00:00").timestamp() * 1000)
    end = int(datetime.fromisoformat(f"{date_end}T23:59:59+00:00").timestamp() * 1000)
    while cursor <= end:
        params = urllib.parse.urlencode({
            "symbol": symbol,
            "interval": INTERVAL,
            "limit": 1500,
            "startTime": cursor,
            "endTime": end,
        })
        payload = fetch_json(f"https://fapi.binance.com/fapi/v1/klines?{params}")
        if not isinstance(payload, list) or not payload:
            break
        for item in payload:
            rows.append({
                "ts": iso_from_ms(int(item[0])),
                "symbol": symbol,
                "open": to_float(item[1]),
                "high": to_float(item[2]),
                "low": to_float(item[3]),
                "close": to_float(item[4]),
                "volume": to_float(item[5]),
                "quote_volume": to_float(item[7]),
            })
        last_open = int(payload[-1][0])
        cursor = last_open + interval_ms
        if len(payload) < 1500:
            break
        time.sleep(0.12)
    dedup = {row["ts"]: row for row in rows}
    return [dedup[k] for k in sorted(dedup)]


def stablecoin_daily_features(rows: list[dict[str, str]]) -> dict[str, dict[str, float]]:
    by_day: dict[str, dict[str, float]] = defaultdict(lambda: {"supply": 0.0, "d1": 0.0, "d7": 0.0})
    for row in rows:
        day = row["date"]
        by_day[day]["supply"] += to_float(row.get("supply_usd"))
        by_day[day]["d1"] += to_float(row.get("supply_change_1d_usd"))
        by_day[day]["d7"] += to_float(row.get("supply_change_7d_usd"))

    days = sorted(by_day)
    d1_values: list[float] = []
    d7_values: list[float] = []
    out: dict[str, dict[str, float]] = {}
    for day in days:
        d1_values.append(by_day[day]["d1"])
        d7_values.append(by_day[day]["d7"])
        win1 = d1_values[-90:]
        win7 = d7_values[-90:]
        z1 = (by_day[day]["d1"] - mean(win1)) / max(std(win1), 1.0)
        z7 = (by_day[day]["d7"] - mean(win7)) / max(std(win7), 1.0)
        out[day] = {
            "stable_supply_usd": by_day[day]["supply"],
            "stable_flow_1d_z": clamp(z1 / 4 + 0.5),
            "stable_flow_7d_z": clamp(z7 / 4 + 0.5),
            "stable_flow_raw_z": max(-4.0, min(4.0, z1 * 0.45 + z7 * 0.55)),
        }
    return out


def load_inputs() -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]], dict[str, dict[str, float]]]:
    summary = json.loads((V27_DIR / "hfcd_trading_v2_7_summary.json").read_text(encoding="utf-8"))
    book_rows = []
    for row in read_csv(V27_DIR / "hfcd_trading_v2_7_book_depth_5m.csv"):
        book_rows.append({
            "ts": row["ts"],
            "symbol": row["symbol"],
            "ask_0p2_notional": to_float(row.get("ask_0p2_notional")),
            "bid_0p2_notional": to_float(row.get("bid_0p2_notional")),
            "ask_1p0_notional": to_float(row.get("ask_1p0_notional")),
            "bid_1p0_notional": to_float(row.get("bid_1p0_notional")),
            "depth_imbalance_0p2": to_float(row.get("depth_imbalance_0p2")),
            "depth_imbalance_1p0": to_float(row.get("depth_imbalance_1p0")),
            "liquidity_cavity_0p2_usd": to_float(row.get("liquidity_cavity_0p2_usd")),
            "liquidity_cavity_1p0_usd": to_float(row.get("liquidity_cavity_1p0_usd")),
        })
    metric_rows = []
    for row in read_csv(V27_DIR / "hfcd_trading_v2_7_metrics_5m.csv"):
        metric_rows.append({
            "ts": row["ts"],
            "symbol": row["symbol"],
            "count_long_short_ratio": to_float(row.get("count_long_short_ratio")),
            "count_toptrader_long_short_ratio": to_float(row.get("count_toptrader_long_short_ratio")),
            "sum_open_interest": to_float(row.get("sum_open_interest")),
            "sum_open_interest_value": to_float(row.get("sum_open_interest_value")),
            "sum_taker_long_short_vol_ratio": to_float(row.get("sum_taker_long_short_vol_ratio")),
            "sum_toptrader_long_short_ratio": to_float(row.get("sum_toptrader_long_short_ratio")),
        })
    stable = stablecoin_daily_features(read_csv(V27_DIR / "hfcd_trading_v2_7_stablecoin_supply_history.csv"))
    return summary, book_rows, metric_rows, stable


def map_by_symbol_ts(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {f"{row['symbol']}|{row['ts']}": row for row in rows}


def rolling_z(value: float, window: list[float]) -> float:
    s = std(window)
    if not window or s <= 0:
        return 0.0
    return max(-4.0, min(4.0, (value - mean(window)) / s))


def build_features(
    symbol: str,
    klines: list[dict[str, Any]],
    book_map: dict[str, dict[str, Any]],
    metric_map: dict[str, dict[str, Any]],
    stable_by_day: dict[str, dict[str, float]],
) -> list[dict[str, Any]]:
    joined = []
    for row in klines:
        book = book_map.get(f"{symbol}|{row['ts']}")
        metric = metric_map.get(f"{symbol}|{row['ts']}")
        if book and metric:
            joined.append({"kline": row, "book": book, "metric": metric})

    l2_values = [x["book"]["liquidity_cavity_1p0_usd"] for x in joined]
    l2p75 = max(percentile(l2_values, 0.75), 1.0)
    l2p95 = max(percentile(l2_values, 0.95), 1.0)
    qv_values = [x["kline"]["quote_volume"] for x in joined]
    qv_p95 = max(percentile(qv_values, 0.95), 1.0)
    out: list[dict[str, Any]] = []

    for i, packed in enumerate(joined):
        row = packed["kline"]
        book = packed["book"]
        metric = packed["metric"]
        closes = [x["kline"]["close"] for x in joined[max(0, i - 288): i + 1]]
        rets = [0.0] + [closes[j] / closes[j - 1] - 1 for j in range(1, len(closes))]
        ret1 = joined[i]["kline"]["close"] / joined[i - 1]["kline"]["close"] - 1 if i > 0 else 0.0
        ret_fast = row["close"] / joined[max(0, i - 6)]["kline"]["close"] - 1
        ret_mid = row["close"] / joined[max(0, i - 24)]["kline"]["close"] - 1
        ret_long = row["close"] / joined[max(0, i - 96)]["kline"]["close"] - 1
        vol_short = max(std(rets[-36:]), 0.0008)
        vol_long = max(std(rets[-288:]), vol_short, 0.0008)
        vol_ratio = clamp(vol_short / max(vol_long, 0.0008), 0, 4)
        candle_spread = max((row["high"] - row["low"]) / max(row["close"], 1), 0)
        qv_win = [x["kline"]["quote_volume"] for x in joined[max(0, i - 288): i + 1]]
        volume_ratio = row["quote_volume"] / max(mean(qv_win), 1)
        trend_signs = [math.copysign(1, x) if x else 0 for x in [ret_fast, ret_mid, ret_long]]
        agreement = max(sum(1 for x in trend_signs if x > 0), sum(1 for x in trend_signs if x < 0)) / 3
        recent_max = max(closes)
        drawdown = row["close"] / recent_max - 1 if recent_max > 0 else 0
        q_core = clamp(0.24 + agreement * 0.42 + clamp(1 + drawdown * 12, 0, 1) * 0.22 + (0.05 if symbol == "BTCUSDT" else 0.03))
        legacy_cavity = clamp(0.18 + math.log1p(row["quote_volume"]) / math.log1p(qv_p95) * 0.72 - candle_spread * 12 - max(0, vol_ratio - 1.6) * 0.08)
        l2_cavity_0p2 = clamp(math.log1p(book["liquidity_cavity_0p2_usd"]) / math.log1p(l2p75))
        l2_cavity_1p0 = clamp(math.log1p(book["liquidity_cavity_1p0_usd"]) / math.log1p(l2p95))
        l2_cavity = clamp(0.20 + l2_cavity_0p2 * 0.38 + l2_cavity_1p0 * 0.42 - max(0, abs(book["depth_imbalance_0p2"]) - 0.55) * 0.18)
        raw_oi_win = [x["_raw_oi"] for x in out[-288:] if x.get("_raw_oi", 0) > 0]
        oi_z = rolling_z(metric["sum_open_interest"], raw_oi_win)
        prev_oi = out[-1]["_raw_oi"] if out else metric["sum_open_interest"]
        oi_slope = clamp((metric["sum_open_interest"] / max(prev_oi, 1) - 1) * 20, -2, 2)
        taker_pressure = max(-2.0, min(2.0, math.log(max(metric["sum_taker_long_short_vol_ratio"], 0.05))))
        account_crowding = clamp(abs(math.log(max(metric["count_long_short_ratio"], 0.05))) / 1.3)
        top_crowding = clamp(abs(math.log(max(metric["sum_toptrader_long_short_ratio"], 0.05))) / 1.3)
        day = row["ts"][:10]
        stable = stable_by_day.get(day, {"stable_flow_1d_z": 0.5, "stable_flow_7d_z": 0.5, "stable_flow_raw_z": 0.0, "stable_supply_usd": 0.0})
        feature = {
            **row,
            "ret_1": ret1,
            "ret_fast": ret_fast,
            "ret_mid": ret_mid,
            "ret_long": ret_long,
            "realized_vol": vol_short,
            "vol_ratio": vol_ratio,
            "candle_spread": candle_spread,
            "volume_ratio": volume_ratio,
            "q_core": q_core,
            "legacy_cavity": legacy_cavity,
            "l2_cavity": l2_cavity,
            "l2_cavity_0p2": l2_cavity_0p2,
            "l2_cavity_1p0": l2_cavity_1p0,
            "depth_imbalance_0p2": max(-1.0, min(1.0, book["depth_imbalance_0p2"])),
            "depth_imbalance_1p0": max(-1.0, min(1.0, book["depth_imbalance_1p0"])),
            "oi_z": oi_z,
            "oi_slope": oi_slope,
            "taker_pressure": taker_pressure,
            "account_crowding": account_crowding,
            "top_trader_crowding": top_crowding,
            "stable_flow_1d_z": stable["stable_flow_1d_z"],
            "stable_flow_7d_z": stable["stable_flow_7d_z"],
            "stable_flow_raw_z": stable["stable_flow_raw_z"],
            "stable_supply_usd": stable["stable_supply_usd"],
            "omega_coupling": 0.5,
            "_raw_oi": metric["sum_open_interest"],
        }
        out.append(feature)
    for row in out:
        row.pop("_raw_oi", None)
    return out


def correlation(a: list[float], b: list[float]) -> float:
    if len(a) < 12 or len(a) != len(b):
        return 0.0
    ma = mean(a)
    mb = mean(b)
    da = math.sqrt(sum((x - ma) ** 2 for x in a))
    db = math.sqrt(sum((x - mb) ** 2 for x in b))
    if not da or not db:
        return 0.0
    return sum((a[i] - ma) * (b[i] - mb) for i in range(len(a))) / (da * db)


def inject_omega(a: list[dict[str, Any]], b: list[dict[str, Any]]) -> None:
    b_by_ts = {row["ts"]: row for row in b}
    ar: list[float] = []
    br: list[float] = []
    for row in a:
        other = b_by_ts.get(row["ts"])
        ar.append(row["ret_1"])
        br.append(other["ret_1"] if other else 0.0)
        row["omega_coupling"] = clamp(0.5 + correlation(ar[-96:], br[-96:]) * 0.25)


def property_weights(symbol: str, family: str) -> dict[str, float]:
    if symbol == "BTCUSDT":
        if family == "l2_metrics_stablecoin":
            return {"q": 0.15, "c": 0.18, "pi": 0.15, "sigma": 0.15, "stable": 0.12, "anti_b": 0.15, "anti_r": 0.06, "omega": 0.04}
        if family == "l2_metrics":
            return {"q": 0.16, "c": 0.21, "pi": 0.16, "sigma": 0.18, "stable": 0.00, "anti_b": 0.17, "anti_r": 0.07, "omega": 0.05}
        if family == "metrics_only":
            return {"q": 0.18, "c": 0.14, "pi": 0.17, "sigma": 0.22, "stable": 0.00, "anti_b": 0.15, "anti_r": 0.08, "omega": 0.06}
        return {"q": 0.20, "c": 0.17, "pi": 0.18, "sigma": 0.16, "stable": 0.00, "anti_b": 0.15, "anti_r": 0.08, "omega": 0.06}
    if family == "l2_metrics_stablecoin":
        return {"q": 0.10, "c": 0.18, "pi": 0.18, "sigma": 0.14, "stable": 0.11, "anti_b": 0.14, "anti_r": 0.08, "omega": 0.07}
    if family == "l2_metrics":
        return {"q": 0.12, "c": 0.20, "pi": 0.20, "sigma": 0.16, "stable": 0.00, "anti_b": 0.15, "anti_r": 0.09, "omega": 0.08}
    if family == "metrics_only":
        return {"q": 0.13, "c": 0.13, "pi": 0.21, "sigma": 0.20, "stable": 0.00, "anti_b": 0.14, "anti_r": 0.10, "omega": 0.09}
    return {"q": 0.15, "c": 0.16, "pi": 0.22, "sigma": 0.15, "stable": 0.00, "anti_b": 0.13, "anti_r": 0.10, "omega": 0.09}


def compute_bundle(row: dict[str, Any], params: ParamSet) -> dict[str, float]:
    use_l2 = params.family in {"l2_metrics", "l2_metrics_stablecoin"}
    use_metrics = params.family != "legacy_price_volume"
    use_stable = params.family == "l2_metrics_stablecoin"
    cavity = row["l2_cavity"] if use_l2 else row["legacy_cavity"]
    l2_pressure = row["depth_imbalance_0p2"] * 0.65 + row["depth_imbalance_1p0"] * 0.25 if use_l2 else 0.0
    taker = row["taker_pressure"] if use_metrics else 0.0
    oi_z = row["oi_z"] if use_metrics else 0.0
    stable_raw = row["stable_flow_raw_z"] if use_stable else 0.0
    raw_trend = (0.44 * row["ret_fast"] + 0.34 * row["ret_mid"] + 0.22 * row["ret_long"]) / max(row["realized_vol"], 0.0008)
    micro = taker * 0.48 + l2_pressure * 0.68 + oi_z * 0.05 + stable_raw * (0.08 if use_stable else 0)
    mean_revert = -max(-1.4, min(1.4, (row["ret_long"] / max(row["realized_vol"], 0.0008)) / 2.8))
    if params.mode == "trend":
        signed = raw_trend
    elif params.mode == "trend_l2_pressure":
        signed = raw_trend * (0.68 + cavity * 0.24) + micro * 0.25
    elif params.mode == "stablecoin_resonance":
        signed = raw_trend * (0.60 + cavity * 0.22) + micro * 0.22 + stable_raw * 0.10
    else:
        signed = raw_trend + micro * 0.16 if row["q_core"] > 0.68 and abs(raw_trend) > 0.65 else mean_revert * cavity + micro * 0.12
    signed = max(-1.9, min(1.9, signed))
    pi = clamp(0.5 + ((0.45 * row["ret_fast"] + 0.35 * row["ret_mid"] + 0.2 * row["ret_long"]) / max(row["realized_vol"], 0.0008)) * 0.10 + micro * 0.04)
    sigma = clamp(0.45 + math.log(max(row["volume_ratio"], 0.05)) * 0.12 + oi_z * 0.032 + taker * 0.032 + stable_raw * (0.06 if use_stable else 0))
    stable_score = clamp(0.50 + stable_raw / 5.0) if use_stable else 0.0
    eta = clamp((row["vol_ratio"] - 0.7) / 2.3 + (max(0, 0.52 - cavity) * 0.35 if use_l2 else 0))
    b_sigma = clamp(
        eta * 0.42 +
        max(0, oi_z) * 0.06 +
        max(0, row["oi_slope"]) * 0.08 +
        row["account_crowding"] * (0.13 if use_metrics else 0.04) +
        row["top_trader_crowding"] * (0.10 if use_metrics else 0.03) +
        (max(0, abs(row["depth_imbalance_0p2"]) - 0.45) * 0.18 if use_l2 else 0) +
        (max(0, -stable_raw) * 0.045 if use_stable else 0)
    )
    r_radius = clamp(max(0, oi_z) * 0.11 + max(0, row["oi_slope"]) * 0.16 + eta * 0.24 + row["account_crowding"] * (0.10 if use_metrics else 0.03))
    w = property_weights(params.symbol, params.family)
    prop = (
        w["q"] * row["q_core"] +
        w["c"] * cavity +
        w["pi"] * pi +
        w["sigma"] * sigma +
        w["stable"] * stable_score +
        w["anti_b"] * (1 - b_sigma) +
        w["anti_r"] * (1 - r_radius) +
        w["omega"] * row["omega_coupling"]
    )
    return {
        "signed_score": signed,
        "score": abs(signed),
        "property_score": prop,
        "q_core": row["q_core"],
        "liquidity_cavity": cavity,
        "pi_coherence": pi,
        "sigma_ledger": sigma,
        "stablecoin_score": stable_score,
        "eta_noise": eta,
        "b_sigma": b_sigma,
        "r_radius": r_radius,
        "omega_coupling": row["omega_coupling"],
    }


def signal_at(rows: list[dict[str, Any]], idx: int, params: ParamSet) -> tuple[str, str, dict[str, float]]:
    if idx < 100 or idx >= len(rows):
        return "none", "insufficient_history", {}
    bundle = compute_bundle(rows[idx], params)
    if bundle["q_core"] < params.min_q:
        return "none", "q_core_underthreshold", bundle
    if bundle["liquidity_cavity"] < params.min_cavity:
        return "none", "liquidity_cavity_underthreshold", bundle
    if bundle["b_sigma"] > params.max_b_sigma:
        return "none", "b_sigma_overheated", bundle
    if bundle["eta_noise"] > params.max_eta:
        return "none", "eta_noise_overheated", bundle
    if bundle["score"] < params.min_score or bundle["property_score"] < params.min_property:
        return "none", "property_score_underthreshold", bundle
    side = "long" if bundle["signed_score"] >= 0 else "short"
    if params.side_policy == "long_only" and side == "short":
        return "none", "side_policy_reject_short", bundle
    if params.side_policy == "short_only" and side == "long":
        return "none", "side_policy_reject_long", bundle
    return side, "", bundle


def execution_cost(entry: dict[str, Any], params: ParamSet) -> float:
    cost = BASE_ROUNDTRIP_COST
    if params.family in {"l2_metrics", "l2_metrics_stablecoin"}:
        cost += max(0, 1 - entry["l2_cavity"]) * L2_COST_SLOPE
    if params.family == "l2_metrics_stablecoin":
        cost += max(0, 0.48 - entry["stable_flow_1d_z"]) * STABLECOIN_COST_GUARD
    return cost


def simulate(rows: list[dict[str, Any]], params: ParamSet, split: str, start: int, end: int) -> tuple[list[dict[str, Any]], dict[str, int]]:
    trades: list[dict[str, Any]] = []
    failures: dict[str, int] = defaultdict(int)
    idx = max(start, 102)
    limit = min(end, len(rows) - params.holding_bars - 3)
    while idx < limit:
        side, reason, bundle = signal_at(rows, idx, params)
        if side == "none":
            failures[reason] += 1
            idx += 1
            continue
        entry = rows[idx + 1]
        entry_price = entry["open"] or rows[idx]["close"]
        exit_idx = idx + 1 + params.holding_bars
        exit_price = rows[exit_idx]["close"]
        exit_reason = "time_exit"
        peak = entry_price
        trough = entry_price
        trailing = False
        for j in range(idx + 2, min(idx + 1 + params.holding_bars, len(rows) - 1) + 1):
            bar = rows[j]
            peak = max(peak, bar["high"])
            trough = min(trough, bar["low"])
            if side == "long":
                stop = entry_price * (1 - params.stop_loss)
                take = entry_price * (1 + params.take_profit)
                if bar["low"] <= stop or bar["high"] >= take:
                    exit_idx = j
                    exit_price = stop if bar["low"] <= stop else take
                    exit_reason = "stop_loss" if bar["low"] <= stop else "take_profit"
                    break
                if params.exit_mode in {"profit_trailing", "trailing_with_decay"} and peak / entry_price - 1 >= params.trail_activate:
                    trailing = True
                if trailing and (peak - bar["close"]) / peak >= params.trail_giveback:
                    exit_idx = j
                    exit_price = bar["close"]
                    exit_reason = "profit_trailing"
                    break
            else:
                stop = entry_price * (1 + params.stop_loss)
                take = entry_price * (1 - params.take_profit)
                if bar["high"] >= stop or bar["low"] <= take:
                    exit_idx = j
                    exit_price = stop if bar["high"] >= stop else take
                    exit_reason = "stop_loss" if bar["high"] >= stop else "take_profit"
                    break
                if params.exit_mode in {"profit_trailing", "trailing_with_decay"} and entry_price / trough - 1 >= params.trail_activate:
                    trailing = True
                if trailing and (bar["close"] - trough) / trough >= params.trail_giveback:
                    exit_idx = j
                    exit_price = bar["close"]
                    exit_reason = "profit_trailing"
                    break
            if params.exit_mode in {"opposite_or_decay", "trailing_with_decay"}:
                live_side, live_reason, _ = signal_at(rows, j - 1, params)
                structural = live_side == "none" and live_reason in {
                    "q_core_underthreshold",
                    "liquidity_cavity_underthreshold",
                    "b_sigma_overheated",
                    "eta_noise_overheated",
                    "property_score_underthreshold",
                }
                opposite = live_side not in {"none", side}
                if structural or opposite:
                    exit_idx = j
                    exit_price = bar["close"]
                    exit_reason = f"dynamic_{live_reason}" if structural else "dynamic_opposite_signal"
                    break
        gross = exit_price / entry_price - 1 if side == "long" else entry_price / exit_price - 1
        cost = execution_cost(entry, params)
        net = gross - cost
        trades.append({
            "split": split,
            "symbol": params.symbol,
            "feature_family": params.family,
            "policy_name": params.policy_name,
            "side": side,
            "entry_ts": entry["ts"],
            "exit_ts": rows[exit_idx]["ts"],
            "entry_price": number(entry_price, 4),
            "exit_price": number(exit_price, 4),
            "holding_bars": exit_idx - idx - 1,
            "score": number(bundle.get("score", 0), 6),
            "property_score": number(bundle.get("property_score", 0), 6),
            "q_core": number(bundle.get("q_core", 0), 6),
            "liquidity_cavity": number(bundle.get("liquidity_cavity", 0), 6),
            "stablecoin_score": number(bundle.get("stablecoin_score", 0), 6),
            "b_sigma": number(bundle.get("b_sigma", 0), 6),
            "exit_reason": exit_reason,
            "gross_return": number(gross, 8),
            "execution_cost": number(cost, 8),
            "net_return": number(net, 8),
            "pnl_usd": number(net * NOTIONAL_USD, 4),
        })
        idx = exit_idx + params.cooldown_bars
    return trades, dict(failures)


def metrics(trades: list[dict[str, Any]], days: float) -> dict[str, float]:
    pnl = [to_float(t["pnl_usd"]) for t in trades]
    wins = [x for x in pnl if x > 0]
    losses = [x for x in pnl if x < 0]
    eq = 0.0
    peak = 0.0
    dd = 0.0
    for x in pnl:
        eq += x
        peak = max(peak, eq)
        dd = min(dd, eq - peak)
    return {
        "trades": len(trades),
        "win_rate": number(len(wins) / len(pnl), 6) if pnl else 0.0,
        "net_pnl_usd": number(sum(pnl), 4),
        "gross_profit_usd": number(sum(wins), 4),
        "gross_loss_usd": number(sum(losses), 4),
        "profit_factor": number(sum(wins) / abs(sum(losses)), 6) if losses else (999.0 if wins else 0.0),
        "max_drawdown_usd": number(dd, 4),
        "avg_pnl_usd": number(mean(pnl), 4),
        "trades_per_day": number(len(trades) / max(days, 1), 6),
    }


def split_indices(n: int) -> dict[str, tuple[int, int]]:
    train_end = int(n * 0.50)
    val_end = int(n * 0.75)
    return {
        "train": (0, train_end),
        "validation": (train_end, val_end),
        "test": (val_end, n),
    }


def build_candidates(symbol: str, family: str) -> list[ParamSet]:
    modes = ["trend", "trend_l2_pressure", "mean_revert_guard"]
    if family == "l2_metrics_stablecoin":
        modes.append("stablecoin_resonance")
    profiles = [
        (0.62, 0.58, 0.52, 0.48, 0.66, 0.90),
        (0.78, 0.62, 0.58, 0.54, 0.58, 0.82),
        (0.94, 0.66, 0.64, 0.60, 0.52, 0.74),
        (1.10, 0.70, 0.68, 0.66, 0.46, 0.66),
    ]
    out: list[ParamSet] = []
    for mode in modes:
        for holding in [12, 24, 48, 72]:
            for i, (min_score, min_prop, min_q, min_cavity, max_b, max_eta) in enumerate(profiles):
                for exit_mode in ["opposite_or_decay", "trailing_with_decay"]:
                    out.append(ParamSet(
                        symbol=symbol,
                        family=family,
                        mode=mode,
                        policy_name=f"{family}_{mode}_h{holding}_p{i}_{exit_mode}",
                        holding_bars=holding,
                        min_score=min_score,
                        min_property=min_prop,
                        min_q=min_q,
                        min_cavity=min_cavity,
                        max_b_sigma=max_b,
                        max_eta=max_eta,
                        stop_loss=0.010 if symbol == "BTCUSDT" else 0.014,
                        take_profit=0.018 if symbol == "BTCUSDT" else 0.026,
                        trail_activate=0.010 if symbol == "BTCUSDT" else 0.014,
                        trail_giveback=0.006 if symbol == "BTCUSDT" else 0.009,
                        cooldown_bars=6 if holding <= 24 else 12,
                        side_policy="both",
                        exit_mode=exit_mode,
                    ))
    return out


def evaluate_symbol_family(symbol: str, family: str, rows: list[dict[str, Any]]) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]], dict[str, int]]:
    splits = split_indices(len(rows))
    days = max((datetime.fromisoformat(rows[-1]["ts"].replace("Z", "+00:00")) - datetime.fromisoformat(rows[0]["ts"].replace("Z", "+00:00"))).total_seconds() / 86400, 1)
    candidates = []
    all_candidate_rows: list[dict[str, Any]] = []
    failure_total: dict[str, int] = defaultdict(int)
    for params in build_candidates(symbol, family):
        split_trades: dict[str, list[dict[str, Any]]] = {}
        split_metrics: dict[str, dict[str, float]] = {}
        for split, (start, end) in splits.items():
            trades, failures = simulate(rows, params, split, start, end)
            split_trades[split] = trades
            split_days = max((end - start) / 288, 1)
            split_metrics[split] = metrics(trades, split_days)
            if split in {"train", "validation"}:
                for k, v in failures.items():
                    failure_total[k] += v
        train = split_metrics["train"]
        val = split_metrics["validation"]
        test = split_metrics["test"]
        robustness = (
            train["net_pnl_usd"] * 0.35 +
            val["net_pnl_usd"] * 0.45 +
            min(train["profit_factor"], 3.0) * 10 +
            min(val["profit_factor"], 3.0) * 14 -
            abs(min(0, train["max_drawdown_usd"])) * 0.02 -
            abs(min(0, val["max_drawdown_usd"])) * 0.03
        )
        if train["trades"] < 8 or val["trades"] < 4:
            robustness -= 60
        row = {
            **asdict(params),
            "train_trades": train["trades"],
            "train_win_rate": train["win_rate"],
            "train_net_pnl_usd": train["net_pnl_usd"],
            "train_profit_factor": train["profit_factor"],
            "train_max_drawdown_usd": train["max_drawdown_usd"],
            "validation_trades": val["trades"],
            "validation_win_rate": val["win_rate"],
            "validation_net_pnl_usd": val["net_pnl_usd"],
            "validation_profit_factor": val["profit_factor"],
            "validation_max_drawdown_usd": val["max_drawdown_usd"],
            "test_trades": test["trades"],
            "test_win_rate": test["win_rate"],
            "test_net_pnl_usd": test["net_pnl_usd"],
            "test_profit_factor": test["profit_factor"],
            "test_max_drawdown_usd": test["max_drawdown_usd"],
            "selection_score": number(robustness, 6),
        }
        all_candidate_rows.append(row)
        candidates.append((robustness, params, split_trades, split_metrics, row))
    candidates.sort(key=lambda item: item[0], reverse=True)
    best = candidates[0]
    selected_trades = best[2]["train"] + best[2]["validation"] + best[2]["test"]
    selected_row = dict(best[4])
    selected_row["status"] = classify(selected_row)
    selected_row["days"] = number(days, 2)
    return selected_row, selected_trades, all_candidate_rows, dict(failure_total)


def classify(row: dict[str, Any]) -> str:
    if row["test_trades"] < 5:
        return "blocked_low_test_trades"
    if row["test_net_pnl_usd"] > 0 and row["test_profit_factor"] >= 1.10 and row["validation_net_pnl_usd"] >= 0:
        return "extended_sensor_validation_pass"
    if row["test_net_pnl_usd"] > 0 and row["test_profit_factor"] >= 1.0:
        return "positive_test_watchlist"
    return "blocked_negative_oos"


def svg_report(summary_rows: list[dict[str, Any]]) -> str:
    rows = sorted(summary_rows, key=lambda x: (x["symbol"], x.get("feature_family", x.get("family", ""))))
    lines = []
    y = 150
    for row in rows:
        family = row.get("feature_family", row.get("family", ""))
        color = "#86efac" if "pass" in row["status"] else "#fde68a" if "watchlist" in row["status"] else "#fca5a5"
        lines.append(f'<text x="60" y="{y}" fill="{color}" font-size="18" font-family="Arial">{row["symbol"]} {family}: test PnL {row["test_net_pnl_usd"]}, PF {row["test_profit_factor"]}, trades {row["test_trades"]}, {row["status"]}</text>')
        y += 30
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="1180" height="520" viewBox="0 0 1180 520">
  <rect width="1180" height="520" fill="#06110f"/>
  <rect x="24" y="24" width="1132" height="472" rx="24" fill="#10231c" stroke="#245a47"/>
  <text x="60" y="74" fill="#f8fafc" font-size="28" font-family="Arial" font-weight="700">{VERSION}</text>
  <text x="60" y="110" fill="#a7f3d0" font-size="17" font-family="Arial">Same-window comparison: legacy vs metrics vs L2 vs L2+stablecoin. Local only.</text>
  {''.join(lines)}
</svg>"""


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    v27, book_rows, metric_rows, stable_by_day = load_inputs()
    date_start = v27["date_start"]
    date_end = v27["date_end"]
    book_map = map_by_symbol_ts(book_rows)
    metric_map = map_by_symbol_ts(metric_rows)
    features_by_symbol: dict[str, list[dict[str, Any]]] = {}
    for symbol in SYMBOLS:
        klines = fetch_klines(symbol, date_start, date_end)
        features_by_symbol[symbol] = build_features(symbol, klines, book_map, metric_map, stable_by_day)
    inject_omega(features_by_symbol["BTCUSDT"], features_by_symbol["ETHUSDT"])
    inject_omega(features_by_symbol["ETHUSDT"], features_by_symbol["BTCUSDT"])

    families = ["legacy_price_volume", "metrics_only", "l2_metrics", "l2_metrics_stablecoin"]
    summary_rows: list[dict[str, Any]] = []
    all_trades: list[dict[str, Any]] = []
    all_candidates: list[dict[str, Any]] = []
    failure_rows: list[dict[str, Any]] = []
    coverage_rows: list[dict[str, Any]] = []

    for symbol, rows in features_by_symbol.items():
        coverage_rows.append({
            "symbol": symbol,
            "feature_rows": len(rows),
            "first_ts": rows[0]["ts"] if rows else "",
            "last_ts": rows[-1]["ts"] if rows else "",
            "stablecoin_rows_available": len(stable_by_day),
            "book_depth_source": "v2_7_binance_vision_bookDepth",
            "metrics_source": "v2_7_binance_vision_metrics",
            "stablecoin_source": "v2_7_defillama_stablecoin_history",
        })
        for family in families:
            selected, trades, candidates, failures = evaluate_symbol_family(symbol, family, rows)
            summary_rows.append(selected)
            all_trades.extend(trades)
            all_candidates.extend(candidates)
            for reason, count in failures.items():
                failure_rows.append({"symbol": symbol, "feature_family": family, "reason": reason, "count": count})

    combined_rows = []
    for family in families:
        fam_trades = [t for t in all_trades if t["feature_family"] == family and t["split"] == "test"]
        combined_rows.append({"feature_family": family, **metrics(fam_trades, 15)})
    family_rank = sorted(combined_rows, key=lambda r: (r["net_pnl_usd"], r["profit_factor"]), reverse=True)
    best_family = family_rank[0]["feature_family"] if family_rank else ""

    write_csv(OUT_DIR / "hfcd_trading_v2_8_summary.csv", summary_rows)
    write_csv(OUT_DIR / "hfcd_trading_v2_8_trades.csv", all_trades)
    write_csv(OUT_DIR / "hfcd_trading_v2_8_top_candidates.csv", sorted(all_candidates, key=lambda r: to_float(r["selection_score"]), reverse=True)[:300])
    write_csv(OUT_DIR / "hfcd_trading_v2_8_failure_modes.csv", failure_rows)
    write_csv(OUT_DIR / "hfcd_trading_v2_8_sensor_coverage.csv", coverage_rows)
    write_csv(OUT_DIR / "hfcd_trading_v2_8_family_comparison.csv", combined_rows)

    result = {
        "version": VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "date_start": date_start,
        "date_end": date_end,
        "input_v27_status": v27["decision"]["status"],
        "quality_gates": {
            "same_window_comparison": True,
            "uses_extended_l2": True,
            "uses_metrics": True,
            "uses_stablecoin_ledger": True,
            "uses_liquidation_history": False,
            "no_online_page_change": True,
        },
        "summary": summary_rows,
        "combined_test": combined_rows,
        "decision": {
            "best_family_by_combined_test": best_family,
            "has_any_pass": any("pass" in row["status"] for row in summary_rows),
            "has_any_positive_test": any(row["test_net_pnl_usd"] > 0 for row in summary_rows),
            "still_missing": ["liquidation_history"],
            "next_step": "If no robust pass, do not tune thresholds blindly; either add liquidation history or split BTC/ETH into lower-frequency regimes.",
        },
    }
    (OUT_DIR / "hfcd_trading_v2_8_summary.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT_DIR / "HFCD_Trading_V2_8_CryptoExtendedL2StablecoinTrain.svg").write_text(svg_report(summary_rows), encoding="utf-8")

    md = f"""# {VERSION}

生成时间：{result['generated_at']}

## 目标

使用 V2.7 的 60 天同窗口传感器账本，验证 BTC/ETH 在加入真实 L2、metrics 和稳定币账本后是否转正。

## 输入

- 日期：{date_start} 至 {date_end}
- Binance Vision bookDepth：V2.7 coverage pass
- Binance Vision metrics：V2.7 coverage pass
- DefiLlama stablecoin：V2.7 ready
- 清算历史：仍缺

## 合并测试集对比

{chr(10).join(f"- {r['feature_family']}: trades={r['trades']}, win={r['win_rate']}, PnL={r['net_pnl_usd']}, PF={r['profit_factor']}, DD={r['max_drawdown_usd']}" for r in combined_rows)}

## 分标的最优血统

{chr(10).join(f"- {r['symbol']} / {r.get('feature_family', r.get('family', ''))}: test_trades={r['test_trades']}, test_win={r['test_win_rate']}, test_pnl={r['test_net_pnl_usd']}, test_pf={r['test_profit_factor']}, status={r['status']}" for r in summary_rows)}

## 审计判断

1. 本轮没有调线上页面，也没有上线。
2. 对比使用同一窗口，避免 V2.3/V2.6 那种跨窗口误判。
3. 如果 L2+stablecoin 未稳定胜出，说明问题不是单纯缺 L2，而是清算/事件/子类型 regime 仍缺。
4. 清算历史仍缺，所以任何正收益都只能是本地候选，不可视为自动交易就绪。

## 下一步

{result['decision']['next_step']}
"""
    (OUT_DIR / "HFCD_Trading_V2_8_CryptoExtendedL2StablecoinTrain.md").write_text(md, encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
