#!/usr/bin/env python3
"""HFCD Trading V2.16: BTC property/maker forward shadow.

Local-only one-shot runner.

V2.15 historical blind test showed BTC improved with the 10D property gate and
Maker-cost filter, while ETH regressed. V2.16 therefore runs:

- BTCUSDT: baseline, property_vector, maker_cost
- ETHUSDT: baseline only

It writes an isolated forward shadow ledger and does not modify V2.13/V2.14
state, online pages, account keys, or real orders.
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


VERSION = "HFCD_Trading_V2_16_BTCPropertyMakerForwardShadow"
ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v2_16_btc_property_maker_forward_shadow"
V12_PATH = ROOT / "scripts" / "hfcd_trading_v2_12_crypto_forward_paper_shadow.py"
V13_PATH = ROOT / "scripts" / "hfcd_trading_v2_13_crypto_forward_daemon_liquidation_tape.py"
V15_SUMMARY = ROOT / "outputs" / "hfcd_trading_v2_15_crypto_property_darkforest_historical_blind" / "hfcd_trading_v2_15_summary.json"

SYMBOLS = ["BTCUSDT", "ETHUSDT"]
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
}

STRATEGIES_BY_SYMBOL = {
    "BTCUSDT": ["baseline", "property_vector", "maker_cost"],
    "ETHUSDT": ["baseline"],
}


def now_utc() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def number(value: Any, digits: int = 6) -> float:
    try:
        out = float(value or 0.0)
        if not math.isfinite(out):
            return 0.0
        return round(out, digits)
    except Exception:
        return 0.0


def clamp(value: Any, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, number(value, 12)))


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
    path = OUT_DIR / "hfcd_trading_v2_16_shadow_state.json"
    if not path.exists():
        return {
            "version": VERSION,
            "created_at": iso(now_utc()),
            "positions": {},
            "realized_pnl_usd": {
                "BTCUSDT:baseline": 0.0,
                "BTCUSDT:property_vector": 0.0,
                "BTCUSDT:maker_cost": 0.0,
                "ETHUSDT:baseline": 0.0,
            },
            "closed_trades": {
                "BTCUSDT:baseline": 0,
                "BTCUSDT:property_vector": 0,
                "BTCUSDT:maker_cost": 0,
                "ETHUSDT:baseline": 0,
            },
        }
    return json.loads(path.read_text(encoding="utf-8"))


def save_state(state: dict[str, Any]) -> None:
    state["updated_at"] = iso(now_utc())
    (OUT_DIR / "hfcd_trading_v2_16_shadow_state.json").write_text(
        json.dumps(state, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def collect_liquidations(v13: Any, seconds: int) -> dict[str, Any]:
    started = now_utc()
    if seconds <= 0:
        return {
            "status": "skipped",
            "rows": [],
            "summary_by_symbol": {symbol: empty_liq_summary() for symbol in SYMBOLS},
            "started_at": iso(started),
            "finished_at": iso(now_utc()),
        }
    rows: list[dict[str, Any]] = []
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
                append_csv(OUT_DIR / "hfcd_trading_v2_16_liquidation_tape.csv", row)
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


def empty_liq_summary() -> dict[str, float]:
    return {
        "count": 0,
        "buy_liq_notional_usd": 0.0,
        "sell_liq_notional_usd": 0.0,
        "net_sell_liq_notional_usd": 0.0,
        "total_liq_notional_usd": 0.0,
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


def closed_bars(v12: Any, symbol: str, policy: Any, btc_bars: Any | None = None) -> tuple[Any, dict[str, Any]]:
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


def property_vector_btc(signal: dict[str, Any], liq: dict[str, float]) -> dict[str, float]:
    trend = float(signal["trend"])
    direction_phase = clamp(0.5 + trend / 2.4)
    r = leverage_radius(signal)
    liquidation_pressure = clamp(float(liq.get("total_liq_notional_usd", 0.0)) / 1_000_000)
    b_sigma = clamp(float(signal["b_sigma"]) * 0.75 + liquidation_pressure * 0.25)
    sigma = clamp(
        float(signal["stablecoin_score"]) * 0.25
        + float(signal["cvd_proxy"]) * 0.35
        + clamp(0.5 + float(signal["oi_change_30x5m"]) * 5.0) * 0.25
        + clamp(0.5 + float(liq.get("net_sell_liq_notional_usd", 0.0)) / 2_000_000) * 0.15
    )
    return {
        "Q": float(signal["q_core"]),
        "DeltaSigma": direction_phase,
        "C": float(signal["liquidity_cavity"]),
        "Pi": clamp(float(signal["trend_score"]) * 0.45 + direction_phase * 0.55),
        "Sigma": sigma,
        "Eta": float(signal["eta"]),
        "BSigma": b_sigma,
        "R": r,
        "Tau": clamp(1 - float(signal["funding_extreme"])),
        "Omega": 0.55,
    }


def property_score_btc(vector: dict[str, float]) -> float:
    w = PROPERTY_WEIGHTS["BTCUSDT"]
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


def btc_strategy_decisions(policy: Any, signal: dict[str, Any], vector: dict[str, float], p_score: float) -> dict[str, dict[str, Any]]:
    baseline_ok = bool(signal["signal_ok"])
    property_ok = (
        p_score >= 0.66
        and vector["DeltaSigma"] >= 0.52
        and vector["Q"] >= float(policy.min_q)
        and vector["C"] >= float(policy.min_cavity)
        and vector["BSigma"] <= float(policy.max_bsigma)
        and vector["R"] <= 0.85
    )
    spread_limit = 0.8
    maker_fill_quality = clamp(
        vector["C"] * 0.55
        + (1 - min(1.0, float(signal["spread_bps"]) / spread_limit)) * 0.30
        + (1 - abs(float(signal["depth_imbalance_0p2"]))) * 0.15
    )
    maker_ok = baseline_ok and float(signal["spread_bps"]) <= spread_limit and maker_fill_quality >= 0.55
    return {
        "baseline": {
            "open_long": baseline_ok,
            "score": float(signal["score"]),
            "reason": "baseline_signal_pass" if baseline_ok else signal["skip_reasons"],
            "one_way_cost": TAKER_ONE_WAY_COST,
            "maker_fill_quality": maker_fill_quality,
        },
        "property_vector": {
            "open_long": property_ok,
            "score": p_score,
            "reason": "property_vector_pass" if property_ok else "property_vector_gate_failed",
            "one_way_cost": TAKER_ONE_WAY_COST,
            "maker_fill_quality": maker_fill_quality,
        },
        "maker_cost": {
            "open_long": maker_ok,
            "score": maker_fill_quality,
            "reason": "maker_cost_filter_pass" if maker_ok else "maker_cost_or_baseline_gate_failed",
            "one_way_cost": MAKER_ONE_WAY_COST,
            "maker_fill_quality": maker_fill_quality,
        },
    }


def eth_baseline_decision(signal: dict[str, Any]) -> dict[str, Any]:
    return {
        "open_long": bool(signal["signal_ok"]),
        "score": float(signal["score"]),
        "reason": "eth_baseline_signal_pass" if signal["signal_ok"] else signal["skip_reasons"],
        "one_way_cost": TAKER_ONE_WAY_COST,
        "maker_fill_quality": "",
    }


def position_key(symbol: str, strategy: str) -> str:
    return f"{symbol}:{strategy}"


def due_time(pos: dict[str, Any]) -> datetime:
    return datetime.fromisoformat(str(pos["due_time"]).replace("Z", "+00:00"))


def bar_minutes(timeframe: str) -> int:
    if timeframe.endswith("h"):
        return int(timeframe[:-1]) * 60
    raise ValueError(f"unsupported timeframe: {timeframe}")


def open_position(state: dict[str, Any], symbol: str, strategy: str, policy: Any, signal: dict[str, Any], decision: dict[str, Any], ts: datetime) -> dict[str, Any]:
    key = position_key(symbol, strategy)
    price = float(signal["mid_price"])
    qty = NOTIONAL_USD / price if price else 0.0
    cost = NOTIONAL_USD * float(decision["one_way_cost"])
    due = ts + timedelta(minutes=bar_minutes(policy.timeframe) * int(policy.hold_bars))
    state["positions"][key] = {
        "symbol": symbol,
        "strategy": strategy,
        "side": "long",
        "entry_time": iso(ts),
        "due_time": iso(due),
        "entry_price": number(price, 8),
        "quantity": number(qty, 10),
        "notional_usd": NOTIONAL_USD,
        "entry_cost_usd": number(cost, 6),
        "one_way_cost": float(decision["one_way_cost"]),
        "policy_name": policy.source_policy,
        "timeframe": policy.timeframe,
    }
    return event_row(ts, symbol, strategy, "open", "shadow_open_long", signal, decision, qty, 0.0, "forward_shadow_open")


def close_position(state: dict[str, Any], symbol: str, strategy: str, signal: dict[str, Any], reason: str, ts: datetime) -> dict[str, Any]:
    key = position_key(symbol, strategy)
    pos = state["positions"][key]
    exit_price = float(signal["mid_price"])
    entry_price = float(pos["entry_price"])
    qty = float(pos["quantity"])
    gross = (exit_price - entry_price) * qty
    exit_cost = float(pos["notional_usd"]) * float(pos["one_way_cost"])
    net = gross - float(pos["entry_cost_usd"]) - exit_cost
    ledger_key = key
    state["realized_pnl_usd"][ledger_key] = number(float(state["realized_pnl_usd"].get(ledger_key, 0.0)) + net, 6)
    state["closed_trades"][ledger_key] = int(state["closed_trades"].get(ledger_key, 0)) + 1
    del state["positions"][key]
    return event_row(ts, symbol, strategy, "close", "shadow_close_long", signal, {"score": "", "reason": reason}, qty, net, reason)


def hold_position(state: dict[str, Any], symbol: str, strategy: str, signal: dict[str, Any], decision: dict[str, Any], ts: datetime) -> dict[str, Any]:
    key = position_key(symbol, strategy)
    pos = state["positions"][key]
    current = float(signal["mid_price"])
    entry = float(pos["entry_price"])
    unrealized = (current - entry) * float(pos["quantity"]) - float(pos["entry_cost_usd"])
    return event_row(ts, symbol, strategy, "hold", "shadow_hold_long", signal, decision, float(pos["quantity"]), unrealized, "position_open_waiting_exit")


def event_row(
    ts: datetime,
    symbol: str,
    strategy: str,
    event: str,
    action: str,
    signal: dict[str, Any],
    decision: dict[str, Any],
    qty: float,
    pnl: float,
    reason: str,
) -> dict[str, Any]:
    ledger_key = position_key(symbol, strategy)
    return {
        "timestamp": iso(ts),
        "symbol": symbol,
        "strategy": strategy,
        "event": event,
        "action": action,
        "policy_name": signal["policy_name"],
        "timeframe": signal["timeframe"],
        "price": number(signal["mid_price"], 8),
        "quantity": number(qty, 8),
        "notional_usd": number(NOTIONAL_USD if qty else 0.0, 2),
        "net_pnl_usd": number(pnl, 6),
        "score": number(decision.get("score", 0)) if decision.get("score", "") != "" else "",
        "reason": reason,
        "baseline_score": signal["score"],
        "q_core": signal["q_core"],
        "liquidity_cavity": signal["liquidity_cavity"],
        "b_sigma": signal["b_sigma"],
        "spread_bps": signal["spread_bps"],
        "maker_fill_quality": decision.get("maker_fill_quality", ""),
        "ledger_key": ledger_key,
        "source": "binance_public_futures_forward_shadow",
    }


def process_strategy(state: dict[str, Any], symbol: str, strategy: str, policy: Any, signal: dict[str, Any], decision: dict[str, Any], ts: datetime) -> dict[str, Any]:
    key = position_key(symbol, strategy)
    if key in state["positions"]:
        pos = state["positions"][key]
        current = float(signal["mid_price"])
        entry = float(pos["entry_price"])
        ret = (current - entry) / entry if entry else 0.0
        if ret <= -float(policy.stop_loss):
            return close_position(state, symbol, strategy, signal, "stop_loss", ts)
        if ret >= float(policy.take_profit):
            return close_position(state, symbol, strategy, signal, "take_profit", ts)
        if ts >= due_time(pos):
            return close_position(state, symbol, strategy, signal, "time_exit", ts)
        return hold_position(state, symbol, strategy, signal, decision, ts)
    if decision["open_long"]:
        return open_position(state, symbol, strategy, policy, signal, decision, ts)
    return event_row(ts, symbol, strategy, "skip", "shadow_skip", signal, decision, 0.0, 0.0, decision["reason"])


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


def vector_row(ts: datetime, signal: dict[str, Any], vector: dict[str, float], p_score: float) -> dict[str, Any]:
    row = {
        "timestamp": iso(ts),
        "symbol": "BTCUSDT",
        "baseline_score": signal["score"],
        "property_fusion_score": number(p_score),
        "baseline_signal_ok": signal["signal_ok"],
        "baseline_skip_reasons": signal["skip_reasons"],
    }
    row.update({k: number(v) for k, v in vector.items()})
    row.update({f"weight_{k}": number(v) for k, v in PROPERTY_WEIGHTS["BTCUSDT"].items()})
    return row


def decision_row(ts: datetime, symbol: str, strategy: str, decision: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
    return {
        "timestamp": iso(ts),
        "symbol": symbol,
        "strategy": strategy,
        "open_long_decision": bool(decision["open_long"]),
        "decision_score": number(decision["score"]),
        "decision_reason": decision["reason"],
        "event": event["event"],
        "action": event["action"],
        "price": event["price"],
        "net_pnl_usd": event["net_pnl_usd"],
        "source": "v2_16_forward_shadow",
    }


def read_v15_context() -> dict[str, Any]:
    if not V15_SUMMARY.exists():
        return {"available": False}
    data = json.loads(V15_SUMMARY.read_text(encoding="utf-8"))
    return {
        "available": True,
        "decision": data.get("decision", {}),
        "test_summary": data.get("test_summary", []),
    }


def render_report(summary: dict[str, Any]) -> str:
    lines = [
        f"# {VERSION}",
        "",
        "## 结论",
        "",
        "- V2.16 是本地 forward shadow，不改 V2.13/V2.14 主账本，不改线上页面，不下真实订单。",
        "- BTC 根据 V2.15 历史盲测，单独运行 baseline、10维物性版、Maker 成本版。",
        "- ETH 保留 baseline；不套 BTC 的 10维门。",
        f"- 本轮状态：`{summary['status']}`。",
        "",
        "## 最新事件",
        "",
    ]
    for event in summary["latest_events"]:
        lines.append(
            f"- `{event['symbol']}` `{event['strategy']}` `{event['event']}`："
            f"score={event['score']}，price={event['price']}，PnL={event['net_pnl_usd']}，reason=`{event['reason']}`。"
        )
    lines.extend([
        "",
        "## 边界",
        "",
        "- BTC 的 10维物性/Maker 升级只来自 V2.15 历史盲测；仍需要 forward 样本积累。",
        "- ETH 在 V2.15 中 property/maker 退化，因此本版只保留 V2.13 baseline。",
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
    v12 = load_module("hfcd_v2_12_for_v16", V12_PATH)
    v13 = load_module("hfcd_v2_13_for_v16", V13_PATH)
    state = load_state()

    liquidation_status = collect_liquidations(v13, args.liquidation_seconds)
    liq_by_symbol = liquidation_status.get("summary_by_symbol", {})

    bars_by_symbol: dict[str, Any] = {}
    signals: dict[str, dict[str, Any]] = {}
    for symbol in SYMBOLS:
        policy = v12.POLICIES[symbol]
        if symbol == "BTCUSDT":
            bars, signal = closed_bars(v12, symbol, policy)
        else:
            bars, signal = closed_bars(v12, symbol, policy, btc_bars=bars_by_symbol.get("BTCUSDT"))
        bars_by_symbol[symbol] = bars
        signals[symbol] = signal

    latest_events: list[dict[str, Any]] = []
    latest_decisions: list[dict[str, Any]] = []
    latest_sensors: list[dict[str, Any]] = []
    latest_vectors: list[dict[str, Any]] = []

    for symbol in SYMBOLS:
        policy = v12.POLICIES[symbol]
        signal = signals[symbol]
        liq = liq_by_symbol.get(symbol, empty_liq_summary())
        latest_sensors.append(darkforest_row(ts, symbol, signal, liq))
        append_csv(OUT_DIR / "hfcd_trading_v2_16_darkforest_sensors.csv", latest_sensors[-1])

        if symbol == "BTCUSDT":
            vector = property_vector_btc(signal, liq)
            p_score = property_score_btc(vector)
            latest_vectors.append(vector_row(ts, signal, vector, p_score))
            append_csv(OUT_DIR / "hfcd_trading_v2_16_btc_property_vectors.csv", latest_vectors[-1])
            decisions = btc_strategy_decisions(policy, signal, vector, p_score)
        else:
            decisions = {"baseline": eth_baseline_decision(signal)}

        for strategy in STRATEGIES_BY_SYMBOL[symbol]:
            decision = decisions[strategy]
            event = process_strategy(state, symbol, strategy, policy, signal, decision, ts)
            latest_events.append(event)
            latest_decisions.append(decision_row(ts, symbol, strategy, decision, event))
            append_csv(OUT_DIR / "hfcd_trading_v2_16_forward_events.csv", event)
            append_csv(OUT_DIR / "hfcd_trading_v2_16_forward_decisions.csv", latest_decisions[-1])

    save_state(state)
    write_csv(OUT_DIR / "hfcd_trading_v2_16_latest_events.csv", latest_events)
    write_csv(OUT_DIR / "hfcd_trading_v2_16_latest_decisions.csv", latest_decisions)
    write_csv(OUT_DIR / "hfcd_trading_v2_16_latest_darkforest_sensors.csv", latest_sensors)
    write_csv(OUT_DIR / "hfcd_trading_v2_16_latest_btc_property_vectors.csv", latest_vectors)

    summary = {
        "version": VERSION,
        "created_at": iso(ts),
        "status": "btc_property_maker_forward_shadow_completed",
        "no_real_orders": True,
        "no_online_page_change": True,
        "does_not_modify_v2_13_main_ledger": True,
        "does_not_modify_v2_14_shadow_ledger": True,
        "v2_15_context": read_v15_context(),
        "liquidation_status": {
            "status": liquidation_status.get("status"),
            "events": sum(int(v.get("count", 0)) for v in liq_by_symbol.values()),
            "summary_by_symbol": liq_by_symbol,
            "error": liquidation_status.get("error", ""),
        },
        "strategy_scope": STRATEGIES_BY_SYMBOL,
        "state": state,
        "latest_events": latest_events,
        "latest_decisions": latest_decisions,
        "latest_sensors": latest_sensors,
        "latest_vectors": latest_vectors,
        "files": {
            "state": str(OUT_DIR / "hfcd_trading_v2_16_shadow_state.json"),
            "events": str(OUT_DIR / "hfcd_trading_v2_16_forward_events.csv"),
            "decisions": str(OUT_DIR / "hfcd_trading_v2_16_forward_decisions.csv"),
            "darkforest_sensors": str(OUT_DIR / "hfcd_trading_v2_16_darkforest_sensors.csv"),
            "btc_property_vectors": str(OUT_DIR / "hfcd_trading_v2_16_btc_property_vectors.csv"),
            "summary": str(OUT_DIR / "hfcd_trading_v2_16_summary.json"),
            "report": str(OUT_DIR / "HFCD_Trading_V2_16_BTCPropertyMakerForwardShadow.md"),
        },
    }
    (OUT_DIR / "hfcd_trading_v2_16_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT_DIR / "HFCD_Trading_V2_16_BTCPropertyMakerForwardShadow.md").write_text(render_report(summary), encoding="utf-8")

    print(json.dumps({
        "version": VERSION,
        "status": summary["status"],
        "liquidation_events": summary["liquidation_status"]["events"],
        "events": [
            {
                "symbol": e["symbol"],
                "strategy": e["strategy"],
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
