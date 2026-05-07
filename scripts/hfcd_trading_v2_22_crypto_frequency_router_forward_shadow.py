#!/usr/bin/env python3
"""HFCD Trading V2.22: crypto frequency-router forward shadow.

Local-only runner.

Purpose:
- Keep V2.13/V2.20 ledgers untouched.
- Freeze the current robust frequency routing:
  - BTCUSDT main: V2.11 1h baseline.
  - ETHUSDT main: V2.11 2h baseline.
  - ETHUSDT shadow: V2.21 15m frequency candidate.
- Keep BTC 15m/30m and ETH 30m archived unless future blind tests beat V2.11.

No account credentials are used. No real orders are sent. No online page is
modified.
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
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


VERSION = "HFCD_Trading_V2_22_CryptoFrequencyRouterForwardShadow"
ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v2_22_crypto_frequency_router_forward_shadow"
V12_PATH = ROOT / "scripts" / "hfcd_trading_v2_12_crypto_forward_paper_shadow.py"
V13_PATH = ROOT / "scripts" / "hfcd_trading_v2_13_crypto_forward_daemon_liquidation_tape.py"
V21_SUMMARY = ROOT / "outputs" / "hfcd_trading_v2_21_crypto_15m_30m_historical_blind" / "hfcd_trading_v2_21_summary.json"

NOTIONAL_USD = 1000.0
TAKER_ONE_WAY_COST = 0.0006
SYMBOLS = ["BTCUSDT", "ETHUSDT"]


@dataclass(frozen=True)
class RoutePolicy:
    symbol: str
    route: str
    role: str
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
    selected_from: str
    enabled: bool = True
    archive_reason: str = ""


ROUTES: list[RoutePolicy] = [
    RoutePolicy(
        symbol="BTCUSDT",
        route="btc_main_1h_v2_11",
        role="main",
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
        selected_from="V2.11 robust selector",
    ),
    RoutePolicy(
        symbol="ETHUSDT",
        route="eth_main_2h_v2_11",
        role="main",
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
        selected_from="V2.11 robust selector",
    ),
    RoutePolicy(
        symbol="ETHUSDT",
        route="eth_shadow_15m_v2_21",
        role="shadow",
        timeframe="15min",
        head="eth_beta_relative",
        side_policy="both",
        threshold=0.66,
        hold_bars=24,
        min_q=0.45,
        min_cavity=0.38,
        max_bsigma=0.78,
        stop_loss=0.024,
        take_profit=0.042,
        source_policy="ETHUSDT_15min_eth_beta_relative_both_t0.66_h24",
        selected_from="V2.21 15m/30m blind test shadow watchlist",
    ),
    RoutePolicy(
        symbol="BTCUSDT",
        route="btc_archive_15m_v2_21",
        role="archived",
        timeframe="15min",
        head="btc_macro_liquidity",
        side_policy="both",
        threshold=0.70,
        hold_bars=24,
        min_q=0.45,
        min_cavity=0.38,
        max_bsigma=0.78,
        stop_loss=0.018,
        take_profit=0.032,
        source_policy="BTCUSDT_15min_btc_macro_liquidity_both_t0.7_h24",
        selected_from="V2.21 15m/30m blind test",
        enabled=False,
        archive_reason="V2.21 did not beat BTC V2.11 1h on test PnL/PF/DD.",
    ),
    RoutePolicy(
        symbol="ETHUSDT",
        route="eth_archive_30m_v2_21",
        role="archived",
        timeframe="30min",
        head="eth_beta_relative",
        side_policy="both",
        threshold=0.64,
        hold_bars=12,
        min_q=0.45,
        min_cavity=0.38,
        max_bsigma=0.78,
        stop_loss=0.024,
        take_profit=0.042,
        source_policy="ETHUSDT_30min_eth_beta_relative_both_t0.64_h12",
        selected_from="V2.21 15m/30m blind test",
        enabled=False,
        archive_reason="V2.21 30m validation did not survive test split.",
    ),
]


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


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load module: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


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


def read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def route_key(policy: RoutePolicy) -> str:
    return f"{policy.symbol}:{policy.route}"


def initial_state() -> dict[str, Any]:
    return {
        "version": VERSION,
        "created_at": iso(now_utc()),
        "positions": {},
        "realized_pnl_usd": {route_key(p): 0.0 for p in ROUTES if p.enabled},
        "closed_trades": {route_key(p): 0 for p in ROUTES if p.enabled},
    }


def load_state() -> dict[str, Any]:
    path = OUT_DIR / "hfcd_trading_v2_22_frequency_router_state.json"
    if not path.exists():
        return initial_state()
    state = read_json(path)
    for policy in ROUTES:
        if policy.enabled:
            key = route_key(policy)
            state.setdefault("realized_pnl_usd", {}).setdefault(key, 0.0)
            state.setdefault("closed_trades", {}).setdefault(key, 0)
    return state


def save_state(state: dict[str, Any]) -> None:
    state["updated_at"] = iso(now_utc())
    (OUT_DIR / "hfcd_trading_v2_22_frequency_router_state.json").write_text(
        json.dumps(state, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def bar_minutes(timeframe: str) -> int:
    if timeframe.endswith("min"):
        return int(timeframe[:-3])
    if timeframe.endswith("h"):
        return int(timeframe[:-1]) * 60
    raise ValueError(f"unsupported timeframe: {timeframe}")


def side_sign(side: str) -> int:
    return 1 if side == "long" else -1


def due_time(pos: dict[str, Any]) -> datetime:
    return datetime.fromisoformat(str(pos["due_time"]).replace("Z", "+00:00"))


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


def collect_realtime_liquidations(v13: Any, seconds: int) -> dict[str, Any]:
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
                append_csv(OUT_DIR / "hfcd_trading_v2_22_realtime_liquidation_tape.csv", row)
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


def historical_liquidation_coverage() -> list[dict[str, Any]]:
    candidates = [
        ROOT / "outputs" / "hfcd_trading_v2_4_crypto_true_sensor_history" / "hfcd_trading_v2_4_liquidation_history.csv",
        ROOT / "data" / "crypto_liquidation_history.csv",
        ROOT / "training" / "crypto_liquidation_history.csv",
    ]
    rows: list[dict[str, Any]] = []
    for path in candidates:
        exists = path.exists()
        count = 0
        if exists and path.stat().st_size > 0:
            with path.open("r", encoding="utf-8", newline="") as fh:
                reader = csv.reader(fh)
                header = True
                for _ in reader:
                    if header:
                        header = False
                        continue
                    count += 1
        rows.append({
            "path": str(path),
            "exists": exists,
            "rows": count,
            "status": "ready" if count > 0 else ("empty" if exists else "missing"),
        })
    return rows


def compute_route_signal(v12: Any, policy: RoutePolicy, bars: Any, btc_bars: Any | None = None) -> dict[str, Any]:
    depth = v12.fetch_depth_metrics(policy.symbol)
    metrics = v12.latest_public_metrics(policy.symbol)
    bar = v12.compute_bar_features(policy.symbol, policy, bars, btc_bars=btc_bars)
    funding_extreme = clamp(abs(v12.to_float(metrics["last_funding_rate"])) / 0.0005)
    oi_change = v12.to_float(metrics["oi_change_30x5m"])
    long_short_pressure = clamp(
        abs(v12.to_float(metrics["global_long_short_ratio"]) - 1) * 0.45
        + abs(v12.to_float(metrics["top_long_short_ratio"]) - 1) * 0.55,
        0,
        2,
    )
    b_sigma = clamp(
        float(bar["eta"]) * 0.18
        + long_short_pressure * 0.18
        + abs(oi_change) * 3.0
        + funding_extreme * 0.16
    )
    stablecoin_score = 0.50
    q = float(bar["q_core"])
    c = float(depth["liquidity_cavity"])
    trend_score = float(bar["trend_score"])
    rel = float(bar["relative_strength_score"])
    cvd = float(bar["cvd_proxy"])
    if policy.head == "btc_macro_liquidity":
        score = 0.25 * q + 0.25 * stablecoin_score + 0.20 * c + 0.20 * trend_score + 0.10 * (1 - b_sigma)
    elif policy.head == "eth_beta_relative":
        score = 0.18 * q + 0.18 * stablecoin_score + 0.22 * c + 0.24 * trend_score + 0.10 * rel + 0.08 * (1 - b_sigma)
    else:
        score = 0.22 * q + 0.20 * stablecoin_score + 0.20 * c + 0.22 * trend_score + 0.16 * (1 - b_sigma)

    trend = float(bar["trend"])
    side = "long" if trend >= 0 else "short"
    reasons: list[str] = []
    if score < policy.threshold:
        reasons.append("score_underthreshold")
    if policy.side_policy == "long_only" and side != "long":
        reasons.append("side_not_allowed")
    if policy.side_policy == "short_only" and side != "short":
        reasons.append("side_not_allowed")
    if q < policy.min_q:
        reasons.append("q_core_underthreshold")
    if c < policy.min_cavity:
        reasons.append("liquidity_cavity_underthreshold")
    if b_sigma > policy.max_bsigma:
        reasons.append("b_sigma_overthreshold")

    return {
        "symbol": policy.symbol,
        "route": policy.route,
        "role": policy.role,
        "timeframe": policy.timeframe,
        "policy_name": policy.source_policy,
        "side_policy": policy.side_policy,
        "side": side,
        "score": number(score),
        "threshold": policy.threshold,
        "q_core": number(q),
        "trend": number(trend),
        "trend_score": number(trend_score),
        "liquidity_cavity": number(c),
        "b_sigma": number(b_sigma),
        "eta": number(bar["eta"]),
        "stablecoin_score": stablecoin_score,
        "funding_extreme": number(funding_extreme),
        "last_funding_rate": number(v12.to_float(metrics["last_funding_rate"]), 10),
        "oi_change_30x5m": number(oi_change),
        "global_long_short_ratio": number(v12.to_float(metrics["global_long_short_ratio"])),
        "top_long_short_ratio": number(v12.to_float(metrics["top_long_short_ratio"])),
        "cvd_proxy": number(cvd),
        "relative_strength_score": number(rel),
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
        "signal_ok": len(reasons) == 0,
        "skip_reasons": "|".join(reasons) if reasons else "-",
    }


def signal_snapshot(ts: datetime, signal: dict[str, Any]) -> dict[str, Any]:
    return {"timestamp": iso(ts), **signal}


def event_row(
    ts: datetime,
    policy: RoutePolicy,
    signal: dict[str, Any],
    event: str,
    action: str,
    qty: float,
    pnl: float,
    reason: str,
    side: str,
    decision_score: float | str,
) -> dict[str, Any]:
    return {
        "timestamp": iso(ts),
        "symbol": policy.symbol,
        "route": policy.route,
        "role": policy.role,
        "event": event,
        "action": action,
        "side": side,
        "policy_name": policy.source_policy,
        "timeframe": policy.timeframe,
        "price": signal["mid_price"],
        "quantity": number(qty, 8),
        "notional_usd": number(NOTIONAL_USD if qty else 0.0, 2),
        "net_pnl_usd": number(pnl, 6),
        "score": decision_score,
        "reason": reason,
        "q_core": signal["q_core"],
        "liquidity_cavity": signal["liquidity_cavity"],
        "b_sigma": signal["b_sigma"],
        "spread_bps": signal["spread_bps"],
        "ledger_key": route_key(policy),
        "source": "binance_public_futures_frequency_router_shadow",
    }


def open_position(state: dict[str, Any], policy: RoutePolicy, signal: dict[str, Any], ts: datetime) -> dict[str, Any]:
    key = route_key(policy)
    price = float(signal["mid_price"])
    qty = NOTIONAL_USD / price if price else 0.0
    cost = NOTIONAL_USD * TAKER_ONE_WAY_COST
    due = ts + timedelta(minutes=bar_minutes(policy.timeframe) * int(policy.hold_bars))
    state["positions"][key] = {
        "symbol": policy.symbol,
        "route": policy.route,
        "role": policy.role,
        "side": signal["side"],
        "entry_time": iso(ts),
        "due_time": iso(due),
        "entry_price": number(price, 8),
        "quantity": number(qty, 10),
        "notional_usd": NOTIONAL_USD,
        "entry_cost_usd": number(cost, 6),
        "one_way_cost": TAKER_ONE_WAY_COST,
        "policy_name": policy.source_policy,
        "timeframe": policy.timeframe,
    }
    return event_row(ts, policy, signal, "open", f"shadow_open_{signal['side']}", qty, 0.0, "frequency_router_signal_passed", signal["side"], signal["score"])


def close_position(state: dict[str, Any], policy: RoutePolicy, signal: dict[str, Any], reason: str, ts: datetime) -> dict[str, Any]:
    key = route_key(policy)
    pos = state["positions"][key]
    exit_price = float(signal["mid_price"])
    entry_price = float(pos["entry_price"])
    qty = float(pos["quantity"])
    gross = (exit_price - entry_price) * qty * side_sign(str(pos["side"]))
    exit_cost = float(pos["notional_usd"]) * float(pos["one_way_cost"])
    net = gross - float(pos["entry_cost_usd"]) - exit_cost
    state["realized_pnl_usd"][key] = number(float(state["realized_pnl_usd"].get(key, 0.0)) + net, 6)
    state["closed_trades"][key] = int(state["closed_trades"].get(key, 0)) + 1
    del state["positions"][key]
    return event_row(ts, policy, signal, "close", "shadow_close", qty, net, reason, str(pos["side"]), "")


def hold_position(state: dict[str, Any], policy: RoutePolicy, signal: dict[str, Any], ts: datetime) -> dict[str, Any]:
    key = route_key(policy)
    pos = state["positions"][key]
    current = float(signal["mid_price"])
    entry = float(pos["entry_price"])
    unrealized = (current - entry) * float(pos["quantity"]) * side_sign(str(pos["side"])) - float(pos["entry_cost_usd"])
    return event_row(ts, policy, signal, "hold", "shadow_hold", float(pos["quantity"]), unrealized, "position_open_waiting_exit", str(pos["side"]), signal["score"])


def process_policy(state: dict[str, Any], policy: RoutePolicy, signal: dict[str, Any], ts: datetime) -> dict[str, Any]:
    key = route_key(policy)
    if key in state["positions"]:
        pos = state["positions"][key]
        current = float(signal["mid_price"])
        entry = float(pos["entry_price"])
        ret = ((current - entry) / entry * side_sign(str(pos["side"]))) if entry else 0.0
        if ret <= -float(policy.stop_loss):
            return close_position(state, policy, signal, "stop_loss", ts)
        if ret >= float(policy.take_profit):
            return close_position(state, policy, signal, "take_profit", ts)
        if ts >= due_time(pos):
            return close_position(state, policy, signal, "time_exit", ts)
        return hold_position(state, policy, signal, ts)
    if signal["signal_ok"]:
        return open_position(state, policy, signal, ts)
    return event_row(ts, policy, signal, "skip", "shadow_skip", 0.0, 0.0, signal["skip_reasons"], signal["side"], signal["score"])


def archived_rows(ts: datetime) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for policy in ROUTES:
        if policy.enabled:
            continue
        rows.append({
            "timestamp": iso(ts),
            "symbol": policy.symbol,
            "route": policy.route,
            "role": policy.role,
            "timeframe": policy.timeframe,
            "policy_name": policy.source_policy,
            "enabled": policy.enabled,
            "archive_reason": policy.archive_reason,
            "selected_from": policy.selected_from,
        })
    return rows


def render_report(summary: dict[str, Any]) -> str:
    lines = [
        f"# {VERSION}",
        "",
        "## 结论",
        "",
        f"- 本轮状态：`{summary['status']}`。",
        "- V2.22 是 frequency router forward shadow，不替代 V2.13/V2.20，不改线上页面，不下真实订单。",
        "- BTC 主路由保持 V2.11 `1h`；ETH 主路由保持 V2.11 `2h`。",
        "- ETH `15m` 只做 shadow；BTC `15m` 和 ETH `30m` 因 V2.21 没打过主基线而归档。",
        f"- 历史强平数据：`{summary['historical_liquidation_status']}`。",
        "",
        "## 最新事件",
        "",
    ]
    for event in summary["latest_events"]:
        lines.append(
            f"- `{event['symbol']}` `{event['route']}` `{event['event']}`："
            f"side={event['side']}，score={event['score']}，price={event['price']}，"
            f"PnL={event['net_pnl_usd']}，reason=`{event['reason']}`。"
        )
    lines.extend([
        "",
        "## 路由原则",
        "",
        "- 频率不是越高越好；只有历史盲测同时提升 test PnL、PF、回撤，才允许升级主路由。",
        "- ETH 15m 当前只验证 forward shadow，不参与主账本仓位决策。",
        "- 真实强平历史仍缺，强平事件策略继续等待 V2.19/V2.24 数据补齐。",
    ])
    return "\n".join(lines) + "\n"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=VERSION)
    parser.add_argument("--cycles", type=int, default=1, help="1=one shot, 0=run forever")
    parser.add_argument("--interval-minutes", type=float, default=15.0)
    parser.add_argument("--liquidation-seconds", type=int, default=8)
    return parser.parse_args()


def run_cycle(args: argparse.Namespace) -> dict[str, Any]:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    ts = now_utc()
    v12 = load_module("hfcd_v2_12_for_v22", V12_PATH)
    v13 = load_module("hfcd_v2_13_for_v22", V13_PATH)
    state = load_state()

    liq_status = collect_realtime_liquidations(v13, args.liquidation_seconds)
    liq_by_symbol = liq_status.get("summary_by_symbol", {})
    hist_liq = historical_liquidation_coverage()
    hist_ready = any(int(row["rows"]) > 0 for row in hist_liq)

    klines: dict[str, Any] = {}
    aggregated: dict[tuple[str, str], Any] = {}
    for symbol in SYMBOLS:
        klines[symbol] = v12.fetch_5m_klines(symbol)
    for symbol in SYMBOLS:
        for tf in sorted({p.timeframe for p in ROUTES if p.symbol == symbol and p.enabled}):
            aggregated[(symbol, tf)] = v12.aggregate_bars(klines[symbol], tf)

    latest_signals: list[dict[str, Any]] = []
    latest_events: list[dict[str, Any]] = []
    for policy in [p for p in ROUTES if p.enabled]:
        btc_tf = aggregated.get(("BTCUSDT", policy.timeframe))
        signal = compute_route_signal(v12, policy, aggregated[(policy.symbol, policy.timeframe)], btc_bars=btc_tf)
        signal["liquidation_count"] = int(liq_by_symbol.get(policy.symbol, empty_liq_summary()).get("count", 0))
        latest_signals.append(signal_snapshot(ts, signal))
        event = process_policy(state, policy, signal, ts)
        latest_events.append(event)
        append_csv(OUT_DIR / "hfcd_trading_v2_22_forward_signals.csv", latest_signals[-1])
        append_csv(OUT_DIR / "hfcd_trading_v2_22_forward_events.csv", event)

    archive = archived_rows(ts)
    for row in archive:
        append_csv(OUT_DIR / "hfcd_trading_v2_22_archived_routes.csv", row)

    save_state(state)
    write_csv(OUT_DIR / "hfcd_trading_v2_22_latest_signals.csv", latest_signals)
    write_csv(OUT_DIR / "hfcd_trading_v2_22_latest_events.csv", latest_events)
    write_csv(OUT_DIR / "hfcd_trading_v2_22_latest_archived_routes.csv", archive)
    write_csv(OUT_DIR / "hfcd_trading_v2_22_liquidation_history_coverage.csv", hist_liq)
    write_csv(OUT_DIR / "hfcd_trading_v2_22_route_config.csv", [asdict(p) for p in ROUTES])

    v21 = read_json(V21_SUMMARY)
    summary = {
        "version": VERSION,
        "created_at": iso(ts),
        "status": "frequency_router_forward_shadow_cycle_completed",
        "no_real_orders": True,
        "no_online_page_change": True,
        "does_not_modify_v2_13_main_ledger": True,
        "does_not_modify_v2_20_shadow_ledger": True,
        "recommended_schedule": "every_15_minutes",
        "enabled_routes": [asdict(p) for p in ROUTES if p.enabled],
        "archived_routes": archive,
        "v2_21_context": {
            "available": bool(v21),
            "decision": v21.get("decision", {}),
            "selected": v21.get("selected", []),
        },
        "realtime_liquidation_status": {
            "status": liq_status.get("status"),
            "events": sum(int(v.get("count", 0)) for v in liq_by_symbol.values()),
            "summary_by_symbol": liq_by_symbol,
            "error": liq_status.get("error", ""),
        },
        "historical_liquidation_status": "ready" if hist_ready else "blocked_missing_real_liquidation_history",
        "historical_liquidation_coverage": hist_liq,
        "state": state,
        "latest_signals": latest_signals,
        "latest_events": latest_events,
        "files": {
            "state": str(OUT_DIR / "hfcd_trading_v2_22_frequency_router_state.json"),
            "signals": str(OUT_DIR / "hfcd_trading_v2_22_forward_signals.csv"),
            "events": str(OUT_DIR / "hfcd_trading_v2_22_forward_events.csv"),
            "route_config": str(OUT_DIR / "hfcd_trading_v2_22_route_config.csv"),
            "archived_routes": str(OUT_DIR / "hfcd_trading_v2_22_archived_routes.csv"),
            "summary": str(OUT_DIR / "hfcd_trading_v2_22_summary.json"),
            "report": str(OUT_DIR / "HFCD_Trading_V2_22_CryptoFrequencyRouterForwardShadow.md"),
        },
    }
    (OUT_DIR / "hfcd_trading_v2_22_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT_DIR / "HFCD_Trading_V2_22_CryptoFrequencyRouterForwardShadow.md").write_text(render_report(summary), encoding="utf-8")
    return summary


def main() -> None:
    args = parse_args()
    cycle = 0
    while True:
        cycle += 1
        summary = run_cycle(args)
        print(json.dumps({
            "version": VERSION,
            "status": summary["status"],
            "cycle": cycle,
            "historical_liquidation_status": summary["historical_liquidation_status"],
            "realtime_liquidation_events": summary["realtime_liquidation_status"]["events"],
            "events": [
                {
                    "symbol": e["symbol"],
                    "route": e["route"],
                    "role": e["role"],
                    "event": e["event"],
                    "side": e["side"],
                    "score": e["score"],
                    "reason": e["reason"],
                    "net_pnl_usd": e["net_pnl_usd"],
                }
                for e in summary["latest_events"]
            ],
            "output_dir": str(OUT_DIR),
        }, ensure_ascii=False, indent=2))
        if args.cycles > 0 and cycle >= args.cycles:
            break
        time.sleep(max(1.0, float(args.interval_minutes) * 60.0))


if __name__ == "__main__":
    main()
