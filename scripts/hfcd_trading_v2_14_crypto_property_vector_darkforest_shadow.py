#!/usr/bin/env python3
"""HFCD Trading V2.14: Crypto property vector + DarkForest shadow.

This is a local-only shadow comparator. It does not modify the V2.13 main
forward paper ledger. It records BTC/ETH 10-dimensional property vectors,
DarkForest sensors and four independent shadow strategies:

1. V2.11/V2.12 baseline
2. 10D property-fusion score
3. liquidation-event rebound
4. maker-cost filter

The state is isolated under V2.14 outputs, so repeated runs can accumulate
forward PnL evidence without touching live orders or the V2.13 state.
"""

from __future__ import annotations

import argparse
import csv
import importlib.util
import json
import math
import socket
import sys
import time
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pandas as pd


VERSION = "HFCD_Trading_V2_14_CryptoPropertyVectorDarkForestShadow"
ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v2_14_crypto_property_vector_darkforest_shadow"
V12_PATH = ROOT / "scripts" / "hfcd_trading_v2_12_crypto_forward_paper_shadow.py"
V13_PATH = ROOT / "scripts" / "hfcd_trading_v2_13_crypto_forward_daemon_liquidation_tape.py"

SYMBOLS = ["BTCUSDT", "ETHUSDT"]
SHADOW_STRATEGIES = ["baseline", "property_vector", "liquidation_event", "maker_cost"]
NOTIONAL_USD = 1000.0
TAKER_ONE_WAY_COST = 0.0006
MAKER_ONE_WAY_COST = 0.0002

PROPERTY_WEIGHTS = {
    "BTCUSDT": {
        "Q": 0.12,
        "DeltaSigma": 0.14,
        "C": 0.10,
        "Pi": 0.15,
        "Sigma": 0.16,
        "EtaHealth": 0.10,
        "BSigmaHealth": 0.10,
        "RHealth": 0.08,
        "Tau": 0.03,
        "Omega": 0.02,
    },
    "ETHUSDT": {
        "Q": 0.10,
        "DeltaSigma": 0.13,
        "C": 0.10,
        "Pi": 0.18,
        "Sigma": 0.15,
        "EtaHealth": 0.12,
        "BSigmaHealth": 0.10,
        "RHealth": 0.07,
        "Tau": 0.03,
        "Omega": 0.02,
    },
}


def now_utc() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def number(value: float, digits: int = 6) -> float:
    try:
        return round(float(value or 0.0), digits)
    except Exception:
        return 0.0


def clamp(value: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, value))


def ensure_out() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)


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


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load module: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def load_state() -> dict[str, Any]:
    path = OUT_DIR / "hfcd_trading_v2_14_shadow_state.json"
    if not path.exists():
        return {
            "version": VERSION,
            "created_at": iso(now_utc()),
            "positions": {},
            "realized_pnl_usd": {strategy: 0.0 for strategy in SHADOW_STRATEGIES},
            "closed_trades": {strategy: 0 for strategy in SHADOW_STRATEGIES},
        }
    return json.loads(path.read_text(encoding="utf-8"))


def save_state(state: dict[str, Any]) -> None:
    state["updated_at"] = iso(now_utc())
    (OUT_DIR / "hfcd_trading_v2_14_shadow_state.json").write_text(
        json.dumps(state, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def collect_liquidations_v14(v13: Any, seconds: int) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    started = now_utc()
    if seconds <= 0:
        return {
            "status": "skipped",
            "rows": rows,
            "summary_by_symbol": {},
            "started_at": iso(started),
            "finished_at": iso(now_utc()),
        }
    ws = v13.MinimalWebSocket(v13.FORCE_ORDER_HOST, v13.FORCE_ORDER_PATH, timeout=5.0)
    try:
        ws.connect()
        deadline = time.time() + seconds
        while time.time() < deadline:
            try:
                text = ws.read_text()
            except socket.timeout:
                continue
            if text is None:
                break
            if not text:
                continue
            payload = json.loads(text)
            row = v13.liquidation_row(payload, now_utc())
            if row and row["symbol"] in SYMBOLS:
                rows.append(row)
                append_csv(OUT_DIR / "hfcd_trading_v2_14_liquidation_tape.csv", row)
    except Exception as exc:  # noqa: BLE001
        return {
            "status": "failed",
            "error": str(exc),
            "rows": rows,
            "summary_by_symbol": summarize_liquidations(rows),
            "started_at": iso(started),
            "finished_at": iso(now_utc()),
        }
    finally:
        ws.close()
    return {
        "status": "ok",
        "rows": rows,
        "summary_by_symbol": summarize_liquidations(rows),
        "started_at": iso(started),
        "finished_at": iso(now_utc()),
    }


def summarize_liquidations(rows: list[dict[str, Any]]) -> dict[str, dict[str, float]]:
    out: dict[str, dict[str, float]] = {}
    for symbol in SYMBOLS:
        subset = [row for row in rows if row["symbol"] == symbol]
        buy = sum(float(row["notional_usd"]) for row in subset if row["side"] == "BUY")
        sell = sum(float(row["notional_usd"]) for row in subset if row["side"] == "SELL")
        out[symbol] = {
            "count": len(subset),
            "buy_liq_notional_usd": number(buy, 4),
            "sell_liq_notional_usd": number(sell, 4),
            "net_sell_liq_notional_usd": number(sell - buy, 4),
            "total_liq_notional_usd": number(buy + sell, 4),
        }
    return out


def closed_bars(v12: Any, symbol: str, policy: Any, btc_bars: pd.DataFrame | None = None) -> tuple[pd.DataFrame, dict[str, Any]]:
    klines = v12.fetch_5m_klines(symbol)
    bars = v12.aggregate_bars(klines, policy.timeframe)
    signal = v12.compute_signal(symbol, policy, bars, btc_bars=btc_bars)
    return bars, signal


def leverage_radius(signal: dict[str, Any]) -> float:
    long_short_pressure = clamp(
        abs(float(signal["global_long_short_ratio"]) - 1) * 0.45
        + abs(float(signal["top_long_short_ratio"]) - 1) * 0.55,
        0,
        2,
    )
    return clamp(
        float(signal["funding_extreme"]) * 0.35
        + abs(float(signal["oi_change_30x5m"])) * 3.0 * 0.35
        + long_short_pressure * 0.30
    )


def property_vector(symbol: str, signal: dict[str, Any], liq: dict[str, float]) -> dict[str, float]:
    trend = float(signal["trend"])
    direction_phase = clamp(0.5 + trend / 2.4)
    l2_cavity = float(signal["liquidity_cavity"])
    r = leverage_radius(signal)
    liquidation_pressure = clamp(float(liq.get("total_liq_notional_usd", 0.0)) / (1_000_000 if symbol == "BTCUSDT" else 300_000))
    b_sigma = clamp(float(signal["b_sigma"]) * 0.75 + liquidation_pressure * 0.25)
    sigma = clamp(
        float(signal["stablecoin_score"]) * 0.25
        + float(signal["cvd_proxy"]) * 0.35
        + clamp(0.5 + float(signal["oi_change_30x5m"]) * 5.0) * 0.25
        + clamp(0.5 + float(liq.get("net_sell_liq_notional_usd", 0.0)) / (2_000_000 if symbol == "BTCUSDT" else 600_000)) * 0.15
    )
    omega = 0.55 if symbol == "BTCUSDT" else float(signal["relative_strength_score"])
    return {
        "Q": float(signal["q_core"]),
        "DeltaSigma": direction_phase,
        "C": l2_cavity,
        "Pi": clamp(float(signal["trend_score"]) * 0.45 + direction_phase * 0.55),
        "Sigma": sigma,
        "Eta": float(signal["eta"]),
        "BSigma": b_sigma,
        "R": r,
        "Tau": clamp(1 - float(signal["funding_extreme"])),
        "Omega": clamp(omega),
    }


def property_score(symbol: str, vector: dict[str, float]) -> float:
    w = PROPERTY_WEIGHTS[symbol]
    return (
        w["Q"] * vector["Q"]
        + w["DeltaSigma"] * vector["DeltaSigma"]
        + w["C"] * vector["C"]
        + w["Pi"] * vector["Pi"]
        + w["Sigma"] * vector["Sigma"]
        + w["EtaHealth"] * (1 - vector["Eta"])
        + w["BSigmaHealth"] * (1 - vector["BSigma"])
        + w["RHealth"] * (1 - vector["R"])
        + w["Tau"] * vector["Tau"]
        + w["Omega"] * vector["Omega"]
    )


def darkforest_row(ts: datetime, symbol: str, signal: dict[str, Any], liq: dict[str, float]) -> dict[str, Any]:
    return {
        "timestamp": iso(ts),
        "symbol": symbol,
        "funding_rate": signal["last_funding_rate"],
        "funding_extreme": signal["funding_extreme"],
        "oi_change_30x5m": signal["oi_change_30x5m"],
        "global_long_short_ratio": signal["global_long_short_ratio"],
        "top_long_short_ratio": signal["top_long_short_ratio"],
        "l2_mid_price": signal["mid_price"],
        "l2_spread_bps": signal["spread_bps"],
        "l2_depth_0p2_notional": signal["depth_0p2_notional"],
        "l2_depth_1p0_notional": signal["depth_1p0_notional"],
        "l2_imbalance_0p2": signal["depth_imbalance_0p2"],
        "liquidation_count": int(liq.get("count", 0)),
        "liquidation_buy_notional_usd": liq.get("buy_liq_notional_usd", 0.0),
        "liquidation_sell_notional_usd": liq.get("sell_liq_notional_usd", 0.0),
        "liquidation_net_sell_notional_usd": liq.get("net_sell_liq_notional_usd", 0.0),
        "metrics_status": signal["metrics_status"],
        "source": "binance_public_futures_plus_forceOrder_shadow",
    }


def vector_row(ts: datetime, symbol: str, signal: dict[str, Any], vector: dict[str, float], p_score: float) -> dict[str, Any]:
    row = {
        "timestamp": iso(ts),
        "symbol": symbol,
        "baseline_score": signal["score"],
        "property_fusion_score": number(p_score),
        "baseline_signal_ok": signal["signal_ok"],
        "baseline_skip_reasons": signal["skip_reasons"],
    }
    row.update({k: number(v) for k, v in vector.items()})
    row.update({f"weight_{k}": number(v) for k, v in PROPERTY_WEIGHTS[symbol].items()})
    return row


def strategy_decisions(symbol: str, policy: Any, signal: dict[str, Any], vector: dict[str, float], p_score: float, liq: dict[str, float]) -> dict[str, dict[str, Any]]:
    baseline_ok = bool(signal["signal_ok"])
    property_ok = (
        p_score >= 0.66
        and vector["DeltaSigma"] >= 0.52
        and vector["Q"] >= policy.min_q
        and vector["C"] >= policy.min_cavity
        and vector["BSigma"] <= policy.max_bsigma
        and vector["R"] <= 0.85
    )
    liq_threshold = 1_000_000 if symbol == "BTCUSDT" else 300_000
    liq_ok = (
        float(liq.get("net_sell_liq_notional_usd", 0.0)) >= liq_threshold
        and vector["C"] >= 0.45
        and vector["BSigma"] <= 0.90
    )
    spread_limit = 0.8 if symbol == "BTCUSDT" else 1.8
    maker_fill_quality = clamp(vector["C"] * 0.55 + (1 - min(1.0, float(signal["spread_bps"]) / spread_limit)) * 0.30 + (1 - abs(float(signal["depth_imbalance_0p2"]))) * 0.15)
    maker_ok = baseline_ok and float(signal["spread_bps"]) <= spread_limit and maker_fill_quality >= 0.55
    return {
        "baseline": {
            "open_long": baseline_ok,
            "score": float(signal["score"]),
            "reason": "baseline_signal_pass" if baseline_ok else signal["skip_reasons"],
            "one_way_cost": TAKER_ONE_WAY_COST,
        },
        "property_vector": {
            "open_long": property_ok,
            "score": p_score,
            "reason": "property_vector_pass" if property_ok else "property_vector_gate_failed",
            "one_way_cost": TAKER_ONE_WAY_COST,
        },
        "liquidation_event": {
            "open_long": liq_ok,
            "score": clamp(float(liq.get("net_sell_liq_notional_usd", 0.0)) / (liq_threshold * 2)),
            "reason": "liquidation_rebound_pass" if liq_ok else "liquidation_event_absent_or_weak",
            "one_way_cost": TAKER_ONE_WAY_COST,
        },
        "maker_cost": {
            "open_long": maker_ok,
            "score": maker_fill_quality,
            "reason": "maker_cost_filter_pass" if maker_ok else "maker_cost_or_baseline_gate_failed",
            "one_way_cost": MAKER_ONE_WAY_COST,
        },
    }


def position_key(strategy: str, symbol: str) -> str:
    return f"{strategy}:{symbol}"


def due_time(pos: dict[str, Any]) -> datetime:
    return datetime.fromisoformat(str(pos["due_time"]).replace("Z", "+00:00"))


def bar_minutes(timeframe: str) -> int:
    if timeframe.endswith("h"):
        return int(timeframe[:-1]) * 60
    raise ValueError(f"unsupported timeframe: {timeframe}")


def open_shadow_position(state: dict[str, Any], strategy: str, symbol: str, policy: Any, signal: dict[str, Any], decision: dict[str, Any], ts: datetime) -> dict[str, Any]:
    price = float(signal["mid_price"])
    qty = NOTIONAL_USD / price if price else 0.0
    cost = NOTIONAL_USD * float(decision["one_way_cost"])
    due = ts + timedelta(minutes=bar_minutes(policy.timeframe) * int(policy.hold_bars))
    state["positions"][position_key(strategy, symbol)] = {
        "strategy": strategy,
        "symbol": symbol,
        "side": "long",
        "entry_time": iso(ts),
        "due_time": iso(due),
        "entry_price": number(price, 8),
        "quantity": number(qty, 10),
        "notional_usd": NOTIONAL_USD,
        "entry_cost_usd": number(cost, 6),
        "one_way_cost": decision["one_way_cost"],
        "policy_name": policy.source_policy,
    }
    return {
        "timestamp": iso(ts),
        "strategy": strategy,
        "symbol": symbol,
        "event": "open",
        "action": "shadow_open_long",
        "price": number(price, 8),
        "quantity": number(qty, 8),
        "notional_usd": number(NOTIONAL_USD, 2),
        "net_pnl_usd": 0.0,
        "realized_pnl_total_usd": state["realized_pnl_usd"][strategy],
        "score": number(float(decision["score"])),
        "reason": decision["reason"],
        "source": "v2_14_shadow",
    }


def close_shadow_position(state: dict[str, Any], strategy: str, symbol: str, signal: dict[str, Any], reason: str, ts: datetime) -> dict[str, Any]:
    key = position_key(strategy, symbol)
    pos = state["positions"][key]
    exit_price = float(signal["mid_price"])
    entry_price = float(pos["entry_price"])
    qty = float(pos["quantity"])
    gross = (exit_price - entry_price) * qty
    exit_cost = float(pos["notional_usd"]) * float(pos["one_way_cost"])
    net = gross - float(pos["entry_cost_usd"]) - exit_cost
    state["realized_pnl_usd"][strategy] = number(float(state["realized_pnl_usd"].get(strategy, 0.0)) + net, 6)
    state["closed_trades"][strategy] = int(state["closed_trades"].get(strategy, 0)) + 1
    del state["positions"][key]
    return {
        "timestamp": iso(ts),
        "strategy": strategy,
        "symbol": symbol,
        "event": "close",
        "action": "shadow_close_long",
        "price": number(exit_price, 8),
        "quantity": number(qty, 8),
        "notional_usd": number(float(pos["notional_usd"]), 2),
        "net_pnl_usd": number(net, 6),
        "realized_pnl_total_usd": state["realized_pnl_usd"][strategy],
        "score": "",
        "reason": reason,
        "source": "v2_14_shadow",
    }


def process_shadow_strategy(state: dict[str, Any], strategy: str, symbol: str, policy: Any, signal: dict[str, Any], decision: dict[str, Any], ts: datetime) -> dict[str, Any]:
    key = position_key(strategy, symbol)
    if key in state["positions"]:
        pos = state["positions"][key]
        entry = float(pos["entry_price"])
        current = float(signal["mid_price"])
        ret = (current - entry) / entry if entry else 0.0
        if ret <= -float(policy.stop_loss):
            return close_shadow_position(state, strategy, symbol, signal, "stop_loss", ts)
        if ret >= float(policy.take_profit):
            return close_shadow_position(state, strategy, symbol, signal, "take_profit", ts)
        if ts >= due_time(pos):
            return close_shadow_position(state, strategy, symbol, signal, "time_exit", ts)
        unrealized = (current - entry) * float(pos["quantity"]) - float(pos["entry_cost_usd"])
        return {
            "timestamp": iso(ts),
            "strategy": strategy,
            "symbol": symbol,
            "event": "hold",
            "action": "shadow_hold_long",
            "price": number(current, 8),
            "quantity": pos["quantity"],
            "notional_usd": pos["notional_usd"],
            "net_pnl_usd": number(unrealized, 6),
            "realized_pnl_total_usd": state["realized_pnl_usd"][strategy],
            "score": number(float(decision["score"])),
            "reason": "shadow_position_open_waiting_exit",
            "source": "v2_14_shadow",
        }
    if decision["open_long"]:
        return open_shadow_position(state, strategy, symbol, policy, signal, decision, ts)
    return {
        "timestamp": iso(ts),
        "strategy": strategy,
        "symbol": symbol,
        "event": "skip",
        "action": "shadow_skip",
        "price": signal["mid_price"],
        "quantity": 0.0,
        "notional_usd": 0.0,
        "net_pnl_usd": 0.0,
        "realized_pnl_total_usd": state["realized_pnl_usd"][strategy],
        "score": number(float(decision["score"])),
        "reason": decision["reason"],
        "source": "v2_14_shadow",
    }


def decision_row(ts: datetime, symbol: str, strategy: str, decision: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
    return {
        "timestamp": iso(ts),
        "symbol": symbol,
        "strategy": strategy,
        "open_long_decision": decision["open_long"],
        "decision_score": number(float(decision["score"])),
        "decision_reason": decision["reason"],
        "event": event["event"],
        "action": event["action"],
        "price": event["price"],
        "net_pnl_usd": event["net_pnl_usd"],
        "realized_pnl_total_usd": event["realized_pnl_total_usd"],
    }


def render_report(summary: dict[str, Any]) -> str:
    lines = [
        f"# {VERSION}",
        "",
        "## 结论",
        "",
        "- V2.14 是旁路 shadow 对照，不改变 V2.13 主前向账本。",
        "- 本轮明确输出 BTC/ETH 的 10维物性向量，并把资金费率、OI、多空比、L2 depth、强平流纳入 DarkForestSensors。",
        "- 四套策略同时记录：baseline、property_vector、liquidation_event、maker_cost。",
        "",
        "## 本轮状态",
        "",
        f"- 状态：`{summary['status']}`。",
        f"- 强平采集：`{summary['liquidation_status']['status']}`，事件 `{summary['liquidation_status'].get('events', 0)}`。",
        "",
        "## 当前 shadow 事件",
        "",
    ]
    for event in summary["latest_events"]:
        lines.append(
            f"- `{event['symbol']}` `{event['strategy']}` `{event['event']}`："
            f"score={event['score']}，PnL={event['net_pnl_usd']}，reason=`{event['reason']}`。"
        )
    lines.extend([
        "",
        "## 边界",
        "",
        "- 其他 AI 的模拟收益不进入本报告结论；这里只记录本地真实 forward 采样。",
        "- 强平事件驱动策略必须积累足够事件样本后再评估，不能用一次无事件窗口判断有效或无效。",
    ])
    return "\n".join(lines) + "\n"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=VERSION)
    parser.add_argument("--liquidation-seconds", type=int, default=8)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    ensure_out()
    ts = now_utc()
    v12 = load_module("hfcd_v2_12_for_v14", V12_PATH)
    v13 = load_module("hfcd_v2_13_for_v14", V13_PATH)
    state = load_state()

    liquidation_status = collect_liquidations_v14(v13, args.liquidation_seconds)
    liq_by_symbol = liquidation_status.get("summary_by_symbol", {})

    bars_by_symbol: dict[str, pd.DataFrame] = {}
    signals: dict[str, dict[str, Any]] = {}
    for symbol in SYMBOLS:
        policy = v12.POLICIES[symbol]
        if symbol == "BTCUSDT":
            bars, signal = closed_bars(v12, symbol, policy)
            bars_by_symbol[symbol] = bars
            signals[symbol] = signal
        else:
            bars, signal = closed_bars(v12, symbol, policy, btc_bars=bars_by_symbol.get("BTCUSDT"))
            bars_by_symbol[symbol] = bars
            signals[symbol] = signal

    latest_events: list[dict[str, Any]] = []
    latest_decisions: list[dict[str, Any]] = []
    latest_vectors: list[dict[str, Any]] = []
    latest_sensors: list[dict[str, Any]] = []

    for symbol in SYMBOLS:
        policy = v12.POLICIES[symbol]
        signal = signals[symbol]
        liq = liq_by_symbol.get(symbol, {})
        vector = property_vector(symbol, signal, liq)
        p_score = property_score(symbol, vector)
        decisions = strategy_decisions(symbol, policy, signal, vector, p_score, liq)
        vector_record = vector_row(ts, symbol, signal, vector, p_score)
        sensor_record = darkforest_row(ts, symbol, signal, liq)
        latest_vectors.append(vector_record)
        latest_sensors.append(sensor_record)
        append_csv(OUT_DIR / "hfcd_trading_v2_14_property_vectors.csv", vector_record)
        append_csv(OUT_DIR / "hfcd_trading_v2_14_darkforest_sensors.csv", sensor_record)
        for strategy, decision in decisions.items():
            event = process_shadow_strategy(state, strategy, symbol, policy, signal, decision, ts)
            latest_events.append(event)
            latest_decisions.append(decision_row(ts, symbol, strategy, decision, event))
            append_csv(OUT_DIR / "hfcd_trading_v2_14_shadow_events.csv", event)
            append_csv(OUT_DIR / "hfcd_trading_v2_14_shadow_decisions.csv", latest_decisions[-1])

    save_state(state)
    write_csv(OUT_DIR / "hfcd_trading_v2_14_latest_property_vectors.csv", latest_vectors)
    write_csv(OUT_DIR / "hfcd_trading_v2_14_latest_darkforest_sensors.csv", latest_sensors)
    write_csv(OUT_DIR / "hfcd_trading_v2_14_latest_events.csv", latest_events)
    write_csv(OUT_DIR / "hfcd_trading_v2_14_latest_decisions.csv", latest_decisions)

    summary = {
        "version": VERSION,
        "created_at": iso(ts),
        "status": "property_vector_darkforest_shadow_completed",
        "no_real_orders": True,
        "no_online_page_change": True,
        "does_not_modify_v2_13_main_ledger": True,
        "liquidation_status": {
            "status": liquidation_status.get("status"),
            "events": sum(int(v.get("count", 0)) for v in liq_by_symbol.values()),
            "summary_by_symbol": liq_by_symbol,
            "started_at": liquidation_status.get("started_at"),
            "finished_at": liquidation_status.get("finished_at"),
            "error": liquidation_status.get("error", ""),
        },
        "state": state,
        "latest_vectors": latest_vectors,
        "latest_sensors": latest_sensors,
        "latest_events": latest_events,
        "files": {
            "state": str(OUT_DIR / "hfcd_trading_v2_14_shadow_state.json"),
            "property_vectors": str(OUT_DIR / "hfcd_trading_v2_14_property_vectors.csv"),
            "darkforest_sensors": str(OUT_DIR / "hfcd_trading_v2_14_darkforest_sensors.csv"),
            "shadow_decisions": str(OUT_DIR / "hfcd_trading_v2_14_shadow_decisions.csv"),
            "shadow_events": str(OUT_DIR / "hfcd_trading_v2_14_shadow_events.csv"),
            "liquidation_tape": str(OUT_DIR / "hfcd_trading_v2_14_liquidation_tape.csv"),
            "summary": str(OUT_DIR / "hfcd_trading_v2_14_summary.json"),
            "report": str(OUT_DIR / "HFCD_Trading_V2_14_CryptoPropertyVectorDarkForestShadow.md"),
        },
    }
    (OUT_DIR / "hfcd_trading_v2_14_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT_DIR / "HFCD_Trading_V2_14_CryptoPropertyVectorDarkForestShadow.md").write_text(render_report(summary), encoding="utf-8")

    print(json.dumps({
        "version": VERSION,
        "status": summary["status"],
        "liquidation_events": summary["liquidation_status"]["events"],
        "events": [
            {
                "strategy": e["strategy"],
                "symbol": e["symbol"],
                "event": e["event"],
                "score": e["score"],
                "reason": e["reason"],
                "net_pnl_usd": e["net_pnl_usd"],
            }
            for e in latest_events
        ],
        "output_dir": str(OUT_DIR),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
