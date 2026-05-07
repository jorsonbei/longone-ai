#!/usr/bin/env python3
"""HFCD Trading V2.12: BTC/ETH forward paper shadow.

Local-only one-shot runner.

It promotes the V2.11 independently validated BTC 1h and ETH 2h policies into
an append-only forward paper ledger using public Binance USD-M futures market
data. It records live snapshots, signals, paper opens/closes, PnL and skip
reasons. It does not use account credentials and never sends real orders.
"""

from __future__ import annotations

import csv
import json
import math
import time
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pandas as pd


VERSION = "HFCD_Trading_V2_12_CryptoForwardPaperShadow"
ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v2_12_crypto_forward_paper_shadow"
V11_SUMMARY = ROOT / "outputs" / "hfcd_trading_v2_11_crypto_robust_selector_1h_2h" / "hfcd_trading_v2_11_summary.json"

NOTIONAL_USD = 1000.0
ONE_WAY_COST_RATE = 0.0006
USER_AGENT = "HFCD-ThingNature-OS/2.12"


@dataclass(frozen=True)
class Policy:
    symbol: str
    timeframe: str
    head: str
    side_policy: str
    threshold: float
    hold_bars: int
    min_q: float
    min_cavity: float
    max_bsigma: float
    stop_loss: float
    take_profit: float
    source_policy: str


POLICIES: dict[str, Policy] = {
    "BTCUSDT": Policy(
        symbol="BTCUSDT",
        timeframe="1h",
        head="btc_macro_liquidity",
        side_policy="long_only",
        threshold=0.66,
        hold_bars=18,
        min_q=0.45,
        min_cavity=0.38,
        max_bsigma=0.78,
        stop_loss=0.018,
        take_profit=0.032,
        source_policy="BTCUSDT_1h_btc_macro_liquidity_long_only_t0.66_h18",
    ),
    "ETHUSDT": Policy(
        symbol="ETHUSDT",
        timeframe="2h",
        head="eth_beta_relative",
        side_policy="long_only",
        threshold=0.66,
        hold_bars=9,
        min_q=0.45,
        min_cavity=0.38,
        max_bsigma=0.78,
        stop_loss=0.024,
        take_profit=0.042,
        source_policy="ETHUSDT_2h_eth_beta_relative_long_only_t0.66_h9",
    ),
}


def now_utc() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def number(value: float, digits: int = 6) -> float:
    return round(float(value or 0.0), digits)


def clamp(value: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, value))


def to_float(value: Any) -> float:
    try:
        out = float(value)
        return out if math.isfinite(out) else 0.0
    except Exception:
        return 0.0


def fetch_json(url: str, timeout: int = 20) -> Any:
    last = ""
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8", "ignore"))
        except Exception as exc:  # noqa: BLE001
            last = str(exc)
            time.sleep(0.35 + attempt * 0.4)
    raise RuntimeError(f"fetch failed: {url} :: {last}")


def query(base: str, params: dict[str, Any]) -> str:
    return f"{base}?{urllib.parse.urlencode(params)}"


def append_csv(path: Path, row: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    exists = path.exists() and path.stat().st_size > 0
    with path.open("a", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(row.keys()))
        if not exists:
            writer.writeheader()
        writer.writerow(row)


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def load_state() -> dict[str, Any]:
    path = OUT_DIR / "hfcd_trading_v2_12_forward_state.json"
    if not path.exists():
        return {
            "version": VERSION,
            "created_at": iso(now_utc()),
            "realized_pnl_usd": 0.0,
            "open_positions": {},
            "closed_trades": 0,
        }
    return json.loads(path.read_text(encoding="utf-8"))


def save_state(state: dict[str, Any]) -> None:
    state["updated_at"] = iso(now_utc())
    (OUT_DIR / "hfcd_trading_v2_12_forward_state.json").write_text(
        json.dumps(state, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def selected_v11_context() -> dict[str, Any]:
    if not V11_SUMMARY.exists():
        return {"available": False}
    data = json.loads(V11_SUMMARY.read_text(encoding="utf-8"))
    return {
        "available": True,
        "decision": data.get("decision", {}),
        "quality_gates": data.get("quality_gates", {}),
        "selected": data.get("selected", []),
    }


def fetch_5m_klines(symbol: str, limit: int = 1500) -> pd.DataFrame:
    payload = fetch_json(query("https://fapi.binance.com/fapi/v1/klines", {
        "symbol": symbol,
        "interval": "5m",
        "limit": limit,
    }))
    rows: list[dict[str, Any]] = []
    current_ms = int(now_utc().timestamp() * 1000)
    for item in payload:
        close_time_ms = int(item[6])
        if close_time_ms >= current_ms:
            continue
        rows.append({
            "timestamp": pd.Timestamp(datetime.fromtimestamp(int(item[0]) / 1000, timezone.utc)),
            "close_time": pd.Timestamp(datetime.fromtimestamp(close_time_ms / 1000, timezone.utc)),
            "open": to_float(item[1]),
            "high": to_float(item[2]),
            "low": to_float(item[3]),
            "close": to_float(item[4]),
            "volume": to_float(item[5]),
            "quote_volume": to_float(item[7]),
            "trades": int(item[8]),
            "taker_buy_quote_volume": to_float(item[10]),
        })
    df = pd.DataFrame(rows)
    if df.empty:
        raise RuntimeError(f"no completed 5m klines for {symbol}")
    return df.sort_values("timestamp")


def aggregate_bars(df: pd.DataFrame, timeframe: str) -> pd.DataFrame:
    k = df.set_index("timestamp").sort_index()
    latest_completed_source_bar = k.index.max()
    out = k.resample(timeframe, label="right", closed="right").agg({
        "open": "first",
        "high": "max",
        "low": "min",
        "close": "last",
        "volume": "sum",
        "quote_volume": "sum",
        "trades": "sum",
        "taker_buy_quote_volume": "sum",
    }).dropna(subset=["open", "close"])
    # Resample labels the active 1h/2h bucket by its future closing timestamp.
    # The strategy must only see fully closed higher-timeframe bars.
    out = out[out.index <= latest_completed_source_bar]
    return out.reset_index()


def fetch_depth_metrics(symbol: str) -> dict[str, float]:
    payload = fetch_json(query("https://fapi.binance.com/fapi/v1/depth", {"symbol": symbol, "limit": 100}))
    bids = [(to_float(px), to_float(qty)) for px, qty in payload.get("bids", [])]
    asks = [(to_float(px), to_float(qty)) for px, qty in payload.get("asks", [])]
    if not bids or not asks:
        raise RuntimeError(f"empty depth for {symbol}")
    best_bid, best_bid_qty = bids[0]
    best_ask, best_ask_qty = asks[0]
    mid = (best_bid + best_ask) / 2
    spread = best_ask - best_bid

    def side_notional(levels: list[tuple[float, float]], side: str, pct: float) -> float:
        total = 0.0
        for px, qty in levels:
            inside = px >= mid * (1 - pct) if side == "bid" else px <= mid * (1 + pct)
            if inside:
                total += px * qty
        return total

    bid_0p2 = side_notional(bids, "bid", 0.002)
    ask_0p2 = side_notional(asks, "ask", 0.002)
    bid_1p0 = side_notional(bids, "bid", 0.010)
    ask_1p0 = side_notional(asks, "ask", 0.010)
    total_0p2 = bid_0p2 + ask_0p2
    total_1p0 = bid_1p0 + ask_1p0
    imbalance_0p2 = (bid_0p2 - ask_0p2) / (total_0p2 + 1e-9)
    imbalance_1p0 = (bid_1p0 - ask_1p0) / (total_1p0 + 1e-9)
    ref = 25_000_000 if symbol == "BTCUSDT" else 12_000_000
    liquidity_cavity = clamp(math.log1p(total_0p2) / math.log1p(ref))
    return {
        "mid_price": mid,
        "best_bid": best_bid,
        "best_ask": best_ask,
        "best_bid_qty": best_bid_qty,
        "best_ask_qty": best_ask_qty,
        "spread": spread,
        "spread_bps": spread / mid * 10_000,
        "bid_0p2_notional": bid_0p2,
        "ask_0p2_notional": ask_0p2,
        "bid_1p0_notional": bid_1p0,
        "ask_1p0_notional": ask_1p0,
        "depth_0p2_notional": total_0p2,
        "depth_1p0_notional": total_1p0,
        "depth_imbalance_0p2": imbalance_0p2,
        "depth_imbalance_1p0": imbalance_1p0,
        "liquidity_cavity": liquidity_cavity,
    }


def latest_public_metrics(symbol: str) -> dict[str, float | str]:
    out: dict[str, float | str] = {
        "last_funding_rate": 0.0,
        "mark_price": 0.0,
        "index_price": 0.0,
        "oi_change_30x5m": 0.0,
        "global_long_short_ratio": 1.0,
        "top_long_short_ratio": 1.0,
        "metrics_status": "ok",
    }
    try:
        prem = fetch_json(query("https://fapi.binance.com/fapi/v1/premiumIndex", {"symbol": symbol}))
        out["last_funding_rate"] = to_float(prem.get("lastFundingRate"))
        out["mark_price"] = to_float(prem.get("markPrice"))
        out["index_price"] = to_float(prem.get("indexPrice"))
    except Exception as exc:  # noqa: BLE001
        out["metrics_status"] = f"premium_failed:{exc}"
    try:
        oi = fetch_json(query("https://fapi.binance.com/futures/data/openInterestHist", {"symbol": symbol, "period": "5m", "limit": 30}))
        if isinstance(oi, list) and len(oi) >= 2:
            first = to_float(oi[0].get("sumOpenInterest"))
            last = to_float(oi[-1].get("sumOpenInterest"))
            out["oi_change_30x5m"] = (last - first) / first if first else 0.0
    except Exception as exc:  # noqa: BLE001
        out["metrics_status"] = f"{out['metrics_status']}|oi_failed:{exc}"
    try:
        glob = fetch_json(query("https://fapi.binance.com/futures/data/globalLongShortAccountRatio", {"symbol": symbol, "period": "5m", "limit": 1}))
        if isinstance(glob, list) and glob:
            out["global_long_short_ratio"] = to_float(glob[-1].get("longShortRatio"))
    except Exception as exc:  # noqa: BLE001
        out["metrics_status"] = f"{out['metrics_status']}|global_lsr_failed:{exc}"
    try:
        top = fetch_json(query("https://fapi.binance.com/futures/data/topLongShortAccountRatio", {"symbol": symbol, "period": "5m", "limit": 1}))
        if isinstance(top, list) and top:
            out["top_long_short_ratio"] = to_float(top[-1].get("longShortRatio"))
    except Exception as exc:  # noqa: BLE001
        out["metrics_status"] = f"{out['metrics_status']}|top_lsr_failed:{exc}"
    return out


def safe_pct(series: pd.Series, periods: int) -> float:
    if len(series) <= periods:
        return 0.0
    base = to_float(series.iloc[-periods - 1])
    last = to_float(series.iloc[-1])
    return (last - base) / base if base else 0.0


def compute_bar_features(symbol: str, policy: Policy, bars: pd.DataFrame, btc_bars: pd.DataFrame | None = None) -> dict[str, float]:
    close = bars["close"]
    ret_1 = close.pct_change()
    ret_3 = safe_pct(close, 3)
    ret_6 = safe_pct(close, 6)
    ret_12 = safe_pct(close, 12)
    vol_12 = to_float(ret_1.tail(12).std())
    vol_48 = to_float(ret_1.tail(48).std())
    eta = clamp((vol_12 / (vol_48 + 1e-9)) / 4)
    recent_max = to_float(close.tail(48).max())
    last = to_float(close.iloc[-1])
    q_core = clamp(1 - abs(last / recent_max - 1) / 0.12) if recent_max else 0.55
    trend = max(-1.2, min(1.2, ret_3 * 70 + ret_6 * 45 + ret_12 * 25))
    trend_score = clamp(abs(trend) / 1.2)
    taker_buy_ratio = to_float(bars["taker_buy_quote_volume"].tail(12).sum()) / (to_float(bars["quote_volume"].tail(12).sum()) + 1e-9)
    cvd_proxy = clamp((taker_buy_ratio - 0.5) / 0.18 + 0.5)
    rel_score = 0.5
    if symbol == "ETHUSDT" and btc_bars is not None and not btc_bars.empty:
        btc_close = btc_bars["close"]
        btc_ret_6 = safe_pct(btc_close, 6)
        rel_score = clamp(((ret_6 - btc_ret_6) / 0.015) + 0.5)
    return {
        "last_bar_close": last,
        "bar_timestamp": bars["timestamp"].iloc[-1].isoformat().replace("+00:00", "Z"),
        "ret_3": ret_3,
        "ret_6": ret_6,
        "ret_12": ret_12,
        "eta": eta,
        "q_core": q_core,
        "trend": trend,
        "trend_score": trend_score,
        "cvd_proxy": cvd_proxy,
        "relative_strength_score": rel_score,
    }


def compute_signal(symbol: str, policy: Policy, bars: pd.DataFrame, btc_bars: pd.DataFrame | None = None) -> dict[str, Any]:
    depth = fetch_depth_metrics(symbol)
    metrics = latest_public_metrics(symbol)
    bar = compute_bar_features(symbol, policy, bars, btc_bars=btc_bars)
    funding_extreme = clamp(abs(to_float(metrics["last_funding_rate"])) / 0.0005)
    oi_change = to_float(metrics["oi_change_30x5m"])
    long_short_pressure = clamp(
        abs(to_float(metrics["global_long_short_ratio"]) - 1) * 0.45
        + abs(to_float(metrics["top_long_short_ratio"]) - 1) * 0.55,
        0,
        2,
    )
    b_sigma = clamp(
        bar["eta"] * 0.18
        + long_short_pressure * 0.18
        + abs(oi_change) * 3.0
        + funding_extreme * 0.16
    )
    stablecoin_score = 0.50
    if symbol == "BTCUSDT":
        score = (
            0.20 * bar["q_core"]
            + 0.20 * depth["liquidity_cavity"]
            + 0.18 * max(0.0, bar["trend"]) / 1.2
            + 0.12 * bar["cvd_proxy"]
            + 0.12 * stablecoin_score
            + 0.10 * (1 - b_sigma)
            + 0.08 * (1 - funding_extreme)
        )
    else:
        score = (
            0.16 * bar["q_core"]
            + 0.18 * depth["liquidity_cavity"]
            + 0.16 * max(0.0, bar["trend"]) / 1.2
            + 0.18 * bar["relative_strength_score"]
            + 0.10 * bar["cvd_proxy"]
            + 0.10 * stablecoin_score
            + 0.08 * (1 - b_sigma)
            + 0.04 * (1 - funding_extreme)
        )
    reasons: list[str] = []
    if score < policy.threshold:
        reasons.append("score_underthreshold")
    if bar["trend"] <= 0:
        reasons.append("trend_not_positive")
    if bar["q_core"] < policy.min_q:
        reasons.append("q_core_underthreshold")
    if depth["liquidity_cavity"] < policy.min_cavity:
        reasons.append("liquidity_cavity_underthreshold")
    if b_sigma > policy.max_bsigma:
        reasons.append("b_sigma_overthreshold")
    return {
        "symbol": symbol,
        "timeframe": policy.timeframe,
        "policy_name": policy.source_policy,
        "score": number(score),
        "threshold": policy.threshold,
        "q_core": number(bar["q_core"]),
        "trend": number(bar["trend"]),
        "trend_score": number(bar["trend_score"]),
        "liquidity_cavity": number(depth["liquidity_cavity"]),
        "b_sigma": number(b_sigma),
        "eta": number(bar["eta"]),
        "stablecoin_score": stablecoin_score,
        "funding_extreme": number(funding_extreme),
        "last_funding_rate": number(to_float(metrics["last_funding_rate"]), 10),
        "oi_change_30x5m": number(oi_change),
        "global_long_short_ratio": number(to_float(metrics["global_long_short_ratio"])),
        "top_long_short_ratio": number(to_float(metrics["top_long_short_ratio"])),
        "cvd_proxy": number(bar["cvd_proxy"]),
        "relative_strength_score": number(bar["relative_strength_score"]),
        "mid_price": number(depth["mid_price"], 8),
        "best_bid": number(depth["best_bid"], 8),
        "best_ask": number(depth["best_ask"], 8),
        "spread_bps": number(depth["spread_bps"], 4),
        "depth_0p2_notional": number(depth["depth_0p2_notional"], 2),
        "depth_1p0_notional": number(depth["depth_1p0_notional"], 2),
        "depth_imbalance_0p2": number(depth["depth_imbalance_0p2"]),
        "bar_timestamp": bar["bar_timestamp"],
        "metrics_status": metrics["metrics_status"],
        "stablecoin_freshness": "stale_historical_v2_7",
        "liquidation_realtime_status": "not_collected_in_oneshot",
        "signal_ok": len(reasons) == 0,
        "skip_reasons": "|".join(reasons) if reasons else "-",
    }


def due_time_from_position(pos: dict[str, Any]) -> datetime:
    return datetime.fromisoformat(str(pos["due_time"]).replace("Z", "+00:00"))


def bar_minutes(timeframe: str) -> int:
    if timeframe.endswith("h"):
        return int(timeframe[:-1]) * 60
    raise ValueError(f"unsupported timeframe: {timeframe}")


def close_position(state: dict[str, Any], symbol: str, signal: dict[str, Any], reason: str, ts: datetime) -> dict[str, Any]:
    pos = state["open_positions"][symbol]
    exit_price = float(signal["mid_price"])
    qty = float(pos["quantity"])
    entry_price = float(pos["entry_price"])
    gross_pnl = (exit_price - entry_price) * qty
    exit_cost = float(pos["notional_usd"]) * ONE_WAY_COST_RATE
    net_pnl = gross_pnl - float(pos["entry_cost_usd"]) - exit_cost
    state["realized_pnl_usd"] = number(float(state.get("realized_pnl_usd", 0.0)) + net_pnl, 6)
    state["closed_trades"] = int(state.get("closed_trades", 0)) + 1
    del state["open_positions"][symbol]
    return {
        "timestamp": iso(ts),
        "symbol": symbol,
        "event": "close",
        "action": "paper_close_long",
        "policy_name": signal["policy_name"],
        "timeframe": signal["timeframe"],
        "price": number(exit_price, 8),
        "quantity": number(qty, 8),
        "notional_usd": number(float(pos["notional_usd"]), 2),
        "gross_pnl_usd": number(gross_pnl, 6),
        "cost_usd": number(float(pos["entry_cost_usd"]) + exit_cost, 6),
        "net_pnl_usd": number(net_pnl, 6),
        "realized_pnl_total_usd": state["realized_pnl_usd"],
        "score": signal["score"],
        "q_core": signal["q_core"],
        "liquidity_cavity": signal["liquidity_cavity"],
        "b_sigma": signal["b_sigma"],
        "reason": reason,
        "market_source": "binance_public_futures",
    }


def open_position(state: dict[str, Any], policy: Policy, signal: dict[str, Any], ts: datetime) -> dict[str, Any]:
    entry_price = float(signal["mid_price"])
    qty = NOTIONAL_USD / entry_price if entry_price else 0.0
    entry_cost = NOTIONAL_USD * ONE_WAY_COST_RATE
    due = ts + timedelta(minutes=bar_minutes(policy.timeframe) * policy.hold_bars)
    state["open_positions"][policy.symbol] = {
        "symbol": policy.symbol,
        "side": "long",
        "entry_time": iso(ts),
        "entry_bar_timestamp": signal["bar_timestamp"],
        "due_time": iso(due),
        "entry_price": number(entry_price, 8),
        "quantity": number(qty, 10),
        "notional_usd": NOTIONAL_USD,
        "entry_cost_usd": number(entry_cost, 6),
        "policy_name": policy.source_policy,
        "timeframe": policy.timeframe,
        "threshold": policy.threshold,
    }
    return {
        "timestamp": iso(ts),
        "symbol": policy.symbol,
        "event": "open",
        "action": "paper_open_long",
        "policy_name": policy.source_policy,
        "timeframe": policy.timeframe,
        "price": number(entry_price, 8),
        "quantity": number(qty, 8),
        "notional_usd": number(NOTIONAL_USD, 2),
        "gross_pnl_usd": 0.0,
        "cost_usd": number(entry_cost, 6),
        "net_pnl_usd": 0.0,
        "realized_pnl_total_usd": state.get("realized_pnl_usd", 0.0),
        "score": signal["score"],
        "q_core": signal["q_core"],
        "liquidity_cavity": signal["liquidity_cavity"],
        "b_sigma": signal["b_sigma"],
        "reason": "v2_11_signal_passed_forward_shadow",
        "market_source": "binance_public_futures",
    }


def process_symbol(state: dict[str, Any], policy: Policy, signal: dict[str, Any], ts: datetime) -> dict[str, Any]:
    symbol = policy.symbol
    if symbol in state["open_positions"]:
        pos = state["open_positions"][symbol]
        entry_price = float(pos["entry_price"])
        current_price = float(signal["mid_price"])
        ret = (current_price - entry_price) / entry_price if entry_price else 0.0
        due = due_time_from_position(pos)
        if ret <= -policy.stop_loss:
            return close_position(state, symbol, signal, "stop_loss", ts)
        if ret >= policy.take_profit:
            return close_position(state, symbol, signal, "take_profit", ts)
        if ts >= due:
            return close_position(state, symbol, signal, "time_exit", ts)
        unrealized = (current_price - entry_price) * float(pos["quantity"]) - float(pos["entry_cost_usd"])
        return {
            "timestamp": iso(ts),
            "symbol": symbol,
            "event": "hold",
            "action": "paper_hold_long",
            "policy_name": policy.source_policy,
            "timeframe": policy.timeframe,
            "price": number(current_price, 8),
            "quantity": pos["quantity"],
            "notional_usd": pos["notional_usd"],
            "gross_pnl_usd": number((current_price - entry_price) * float(pos["quantity"]), 6),
            "cost_usd": pos["entry_cost_usd"],
            "net_pnl_usd": number(unrealized, 6),
            "realized_pnl_total_usd": state.get("realized_pnl_usd", 0.0),
            "score": signal["score"],
            "q_core": signal["q_core"],
            "liquidity_cavity": signal["liquidity_cavity"],
            "b_sigma": signal["b_sigma"],
            "reason": "position_open_waiting_exit",
            "market_source": "binance_public_futures",
        }

    if signal["signal_ok"]:
        return open_position(state, policy, signal, ts)

    return {
        "timestamp": iso(ts),
        "symbol": symbol,
        "event": "skip",
        "action": "paper_skip",
        "policy_name": policy.source_policy,
        "timeframe": policy.timeframe,
        "price": signal["mid_price"],
        "quantity": 0.0,
        "notional_usd": 0.0,
        "gross_pnl_usd": 0.0,
        "cost_usd": 0.0,
        "net_pnl_usd": 0.0,
        "realized_pnl_total_usd": state.get("realized_pnl_usd", 0.0),
        "score": signal["score"],
        "q_core": signal["q_core"],
        "liquidity_cavity": signal["liquidity_cavity"],
        "b_sigma": signal["b_sigma"],
        "reason": signal["skip_reasons"],
        "market_source": "binance_public_futures",
    }


def snapshot_row(ts: datetime, signal: dict[str, Any]) -> dict[str, Any]:
    keys = [
        "symbol",
        "timeframe",
        "policy_name",
        "score",
        "threshold",
        "q_core",
        "trend",
        "liquidity_cavity",
        "b_sigma",
        "eta",
        "stablecoin_score",
        "funding_extreme",
        "last_funding_rate",
        "oi_change_30x5m",
        "global_long_short_ratio",
        "top_long_short_ratio",
        "cvd_proxy",
        "relative_strength_score",
        "mid_price",
        "best_bid",
        "best_ask",
        "spread_bps",
        "depth_0p2_notional",
        "depth_1p0_notional",
        "depth_imbalance_0p2",
        "bar_timestamp",
        "metrics_status",
        "stablecoin_freshness",
        "liquidation_realtime_status",
        "signal_ok",
        "skip_reasons",
    ]
    row = {"timestamp": iso(ts)}
    row.update({k: signal.get(k, "") for k in keys})
    return row


def render_report(summary: dict[str, Any], events: list[dict[str, Any]]) -> str:
    lines = [
        f"# {VERSION}",
        "",
        "## 结论",
        "",
        "- 本轮是本地 forward paper shadow；只使用 Binance 公开 USD-M 合约实时行情，不读取账户、不下真实订单。",
        "- BTC 使用 V2.11 的 1小时 long-only 策略；ETH 使用 V2.11 的 2小时 long-only 策略。",
        "- 其他 AI 提到的 BTC/CL 模拟收益不作为事实；本账本只记录本机实时采样结果。",
        "",
        "## 本轮事件",
        "",
    ]
    for event in events:
        lines.append(
            f"- `{event['symbol']}` `{event['event']}`：price={event['price']}，"
            f"score={event['score']}，PnL={event['net_pnl_usd']}，reason=`{event['reason']}`。"
        )
    lines.extend([
        "",
        "## 传感器边界",
        "",
        f"- 清算历史：`{summary['quality_gates']['uses_liquidation_history']}`，仍未接入历史回放。",
        "- 清算实时流：本 one-shot runner 未保持 WebSocket 长连接，只做状态标记；后续 daemon 版再采集 `!forceOrder@arr`。",
        "- 稳定币流：当前只保留 V2.7 历史账本标记，forward freshness 记为 stale，不能当作新鲜实时信号。",
        "",
        "## 下一步",
        "",
        "把该 runner 定时化为 daemon/cron，每 15-30 分钟追加 snapshots/events；同时继续补 CoinGlass/Coinalyze/Tardis 的清算历史。",
    ])
    return "\n".join(lines) + "\n"


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    ts = now_utc()
    state = load_state()
    events: list[dict[str, Any]] = []
    snapshots: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []

    bars_by_symbol: dict[str, pd.DataFrame] = {}
    agg_by_symbol: dict[str, pd.DataFrame] = {}
    try:
        for symbol, policy in POLICIES.items():
            bars_by_symbol[symbol] = fetch_5m_klines(symbol)
            agg_by_symbol[symbol] = aggregate_bars(bars_by_symbol[symbol], policy.timeframe)
    except Exception as exc:  # noqa: BLE001
        summary = {
            "version": VERSION,
            "created_at": iso(ts),
            "status": "market_fetch_failed",
            "error": str(exc),
            "no_real_orders": True,
            "no_online_page_change": True,
        }
        (OUT_DIR / "hfcd_trading_v2_12_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
        raise

    btc_1h = agg_by_symbol.get("BTCUSDT")
    for symbol, policy in POLICIES.items():
        try:
            signal = compute_signal(symbol, policy, agg_by_symbol[symbol], btc_bars=btc_1h)
            snapshots.append(snapshot_row(ts, signal))
            event = process_symbol(state, policy, signal, ts)
            events.append(event)
        except Exception as exc:  # noqa: BLE001
            errors.append({"symbol": symbol, "error": str(exc)})
            events.append({
                "timestamp": iso(ts),
                "symbol": symbol,
                "event": "error",
                "action": "paper_error",
                "policy_name": policy.source_policy,
                "timeframe": policy.timeframe,
                "price": 0.0,
                "quantity": 0.0,
                "notional_usd": 0.0,
                "gross_pnl_usd": 0.0,
                "cost_usd": 0.0,
                "net_pnl_usd": 0.0,
                "realized_pnl_total_usd": state.get("realized_pnl_usd", 0.0),
                "score": 0.0,
                "q_core": 0.0,
                "liquidity_cavity": 0.0,
                "b_sigma": 0.0,
                "reason": str(exc),
                "market_source": "binance_public_futures",
            })

    for row in snapshots:
        append_csv(OUT_DIR / "hfcd_trading_v2_12_forward_snapshots.csv", row)
    for row in events:
        append_csv(OUT_DIR / "hfcd_trading_v2_12_forward_events.csv", row)
    save_state(state)

    summary = {
        "version": VERSION,
        "created_at": iso(ts),
        "status": "forward_paper_shadow_cycle_completed" if not errors else "forward_paper_shadow_cycle_completed_with_errors",
        "source": "binance_public_usdm_futures",
        "no_real_orders": True,
        "no_online_page_change": True,
        "policies": {symbol: asdict(policy) for symbol, policy in POLICIES.items()},
        "v2_11_context": selected_v11_context(),
        "quality_gates": {
            "uses_realtime_klines": True,
            "uses_realtime_depth": True,
            "uses_realtime_open_interest": True,
            "uses_realtime_funding": True,
            "uses_realtime_long_short_ratio": True,
            "uses_liquidation_history": False,
            "uses_liquidation_realtime_websocket": False,
            "stablecoin_forward_freshness": "stale_historical_v2_7",
        },
        "state": state,
        "events": events,
        "errors": errors,
        "files": {
            "state": str(OUT_DIR / "hfcd_trading_v2_12_forward_state.json"),
            "events": str(OUT_DIR / "hfcd_trading_v2_12_forward_events.csv"),
            "snapshots": str(OUT_DIR / "hfcd_trading_v2_12_forward_snapshots.csv"),
            "summary": str(OUT_DIR / "hfcd_trading_v2_12_summary.json"),
            "report": str(OUT_DIR / "HFCD_Trading_V2_12_CryptoForwardPaperShadow.md"),
        },
    }
    (OUT_DIR / "hfcd_trading_v2_12_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT_DIR / "HFCD_Trading_V2_12_CryptoForwardPaperShadow.md").write_text(render_report(summary, events), encoding="utf-8")
    write_csv(OUT_DIR / "hfcd_trading_v2_12_latest_events.csv", events)
    write_csv(OUT_DIR / "hfcd_trading_v2_12_latest_snapshots.csv", snapshots)

    print(json.dumps({
        "version": VERSION,
        "status": summary["status"],
        "events": [
            {
                "symbol": row["symbol"],
                "event": row["event"],
                "score": row["score"],
                "reason": row["reason"],
                "net_pnl_usd": row["net_pnl_usd"],
            }
            for row in events
        ],
        "output_dir": str(OUT_DIR),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
