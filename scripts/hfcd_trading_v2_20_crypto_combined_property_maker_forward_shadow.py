#!/usr/bin/env python3
"""HFCD Trading V2.20: combined BTC/ETH property-maker forward shadow.

Local-only one-shot runner.

Purpose:
- Keep V2.13 main crypto forward ledger untouched.
- Promote only shadow variants proven by local blind tests:
  - BTCUSDT: baseline, property_vector, maker_cost from V2.16/V2.15.
  - ETHUSDT: baseline plus eth_maker_cost from V2.17.
- Continue auditing real liquidation-history availability without fabricating it.

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
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


VERSION = "HFCD_Trading_V2_20_CryptoCombinedPropertyMakerForwardShadow"
ROOT = Path.cwd()
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v2_20_crypto_combined_property_maker_forward_shadow"
V12_PATH = ROOT / "scripts" / "hfcd_trading_v2_12_crypto_forward_paper_shadow.py"
V13_PATH = ROOT / "scripts" / "hfcd_trading_v2_13_crypto_forward_daemon_liquidation_tape.py"
V16_PATH = ROOT / "scripts" / "hfcd_trading_v2_16_btc_property_maker_forward_shadow.py"
V17_SUMMARY = ROOT / "outputs" / "hfcd_trading_v2_17_eth_specific_property_blind" / "hfcd_trading_v2_17_summary.json"

SYMBOLS = ["BTCUSDT", "ETHUSDT"]
STRATEGIES_BY_SYMBOL = {
    "BTCUSDT": ["baseline", "property_vector", "maker_cost"],
    "ETHUSDT": ["baseline", "eth_maker_cost"],
}
MAKER_ONE_WAY_COST = 0.0002

LIQUIDATION_HISTORY_CANDIDATES = [
    ROOT / "outputs" / "hfcd_trading_v2_4_crypto_true_sensor_history" / "hfcd_trading_v2_4_liquidation_history.csv",
    ROOT / "data" / "crypto_liquidation_history.csv",
    ROOT / "training" / "crypto_liquidation_history.csv",
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


def load_state() -> dict[str, Any]:
    path = OUT_DIR / "hfcd_trading_v2_20_shadow_state.json"
    if not path.exists():
        realized = {}
        closed = {}
        for symbol, strategies in STRATEGIES_BY_SYMBOL.items():
            for strategy in strategies:
                key = f"{symbol}:{strategy}"
                realized[key] = 0.0
                closed[key] = 0
        return {
            "version": VERSION,
            "created_at": iso(now_utc()),
            "positions": {},
            "realized_pnl_usd": realized,
            "closed_trades": closed,
        }
    return read_json(path)


def save_state(state: dict[str, Any]) -> None:
    state["updated_at"] = iso(now_utc())
    (OUT_DIR / "hfcd_trading_v2_20_shadow_state.json").write_text(
        json.dumps(state, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


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
                append_csv(OUT_DIR / "hfcd_trading_v2_20_realtime_liquidation_tape.csv", row)
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


def liquidation_history_coverage() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for path in LIQUIDATION_HISTORY_CANDIDATES:
        exists = path.exists()
        row_count = 0
        if exists and path.stat().st_size > 0:
            with path.open("r", encoding="utf-8", newline="") as fh:
                reader = csv.reader(fh)
                header_seen = False
                for _ in reader:
                    if not header_seen:
                        header_seen = True
                        continue
                    row_count += 1
        rows.append({
            "path": str(path),
            "exists": exists,
            "rows": row_count,
            "status": "ready" if row_count > 0 else ("empty" if exists else "missing"),
        })
    return rows


def historical_liquidation_ready(coverage: list[dict[str, Any]]) -> bool:
    return any(int(row["rows"]) > 0 for row in coverage)


def eth_maker_decision(signal: dict[str, Any]) -> dict[str, Any]:
    spread_limit = 1.2
    spread_factor = 1 - min(1.0, float(signal["spread_bps"]) / spread_limit)
    fill_quality = clamp(
        float(signal["liquidity_cavity"]) * 0.50
        + spread_factor * 0.25
        + (1 - abs(float(signal["depth_imbalance_0p2"]))) * 0.15
        + float(signal["relative_strength_score"]) * 0.10
    )
    reasons: list[str] = []
    if not signal["signal_ok"]:
        reasons.append(str(signal["skip_reasons"]))
    if fill_quality < 0.46:
        reasons.append("maker_fill_quality_under_0p46")
    if float(signal["liquidity_cavity"]) < 0.34:
        reasons.append("liquidity_cavity_under_0p34")
    if float(signal["spread_bps"]) > spread_limit:
        reasons.append("spread_over_maker_limit")
    ok = len(reasons) == 0
    return {
        "open_long": ok,
        "score": fill_quality,
        "reason": "eth_maker_cost_filter_pass" if ok else "|".join(reasons),
        "one_way_cost": MAKER_ONE_WAY_COST,
        "maker_fill_quality": fill_quality,
    }


def eth_maker_vector_row(ts: datetime, signal: dict[str, Any], decision: dict[str, Any]) -> dict[str, Any]:
    return {
        "timestamp": iso(ts),
        "symbol": "ETHUSDT",
        "strategy": "eth_maker_cost",
        "baseline_score": signal["score"],
        "relative_strength_score": signal["relative_strength_score"],
        "q_core": signal["q_core"],
        "liquidity_cavity": signal["liquidity_cavity"],
        "b_sigma": signal["b_sigma"],
        "eta": signal["eta"],
        "funding_extreme": signal["funding_extreme"],
        "spread_bps": signal["spread_bps"],
        "depth_0p2_notional": signal["depth_0p2_notional"],
        "depth_imbalance_0p2": signal["depth_imbalance_0p2"],
        "eth_maker_fill_quality": number(decision["maker_fill_quality"]),
        "eth_maker_selected_from_v2_17": True,
        "source": "binance_public_futures_forward_shadow",
    }


def normalize_property_row(row: dict[str, Any]) -> dict[str, Any]:
    fields = [
        "timestamp",
        "symbol",
        "strategy",
        "baseline_score",
        "btc_property_fusion_score",
        "eth_maker_fill_quality",
        "baseline_signal_ok",
        "baseline_skip_reasons",
        "relative_strength_score",
        "q_core",
        "liquidity_cavity",
        "b_sigma",
        "eta",
        "funding_extreme",
        "spread_bps",
        "depth_0p2_notional",
        "depth_imbalance_0p2",
        "Q",
        "DeltaSigma",
        "C",
        "Pi",
        "Sigma",
        "Eta",
        "BSigma",
        "R",
        "Tau",
        "Omega",
        "weight_Q",
        "weight_DeltaSigma",
        "weight_C",
        "weight_Pi",
        "weight_Sigma",
        "weight_EtaHealth",
        "weight_BSigmaHealth",
        "weight_RHealth",
        "weight_Tau",
        "weight_Omega",
        "source",
    ]
    normalized = {field: row.get(field, "") for field in fields}
    if "property_fusion_score" in row:
        normalized["btc_property_fusion_score"] = row["property_fusion_score"]
        normalized["strategy"] = row.get("strategy") or "property_vector"
    return normalized


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
        "source": "v2_20_forward_shadow",
    }


def render_report(summary: dict[str, Any]) -> str:
    lines = [
        f"# {VERSION}",
        "",
        "## 结论",
        "",
        "- V2.20 是合并 forward shadow，不替代 V2.13 主账本，不改线上页面，不下真实订单。",
        "- BTC 运行 baseline / property_vector / maker_cost。",
        "- ETH 运行 baseline / eth_maker_cost；eth_maker_cost 来自 V2.17 历史盲测选择。",
        f"- 本轮状态：`{summary['status']}`。",
        f"- 历史强平数据：`{summary['historical_liquidation_status']}`。",
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
        "- BTC property_vector 的晋级依据是 V2.15 历史盲测；仍需 forward shadow 样本验证。",
        "- ETH 本轮不使用 ETH 10维 gate，只使用 V2.17 证明有效的 maker_cost 执行变体。",
        "- 强平事件 blind 仍等待真实历史强平数据；实时 forceOrder 只做前向 tape，不可反推历史。",
    ])
    return "\n".join(lines) + "\n"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=VERSION)
    parser.add_argument("--liquidation-seconds", type=int, default=8)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    ts = now_utc()
    v12 = load_module("hfcd_v2_12_for_v20", V12_PATH)
    v13 = load_module("hfcd_v2_13_for_v20", V13_PATH)
    v16 = load_module("hfcd_v2_16_for_v20", V16_PATH)
    state = load_state()

    liq_status = collect_realtime_liquidations(v13, args.liquidation_seconds)
    liq_by_symbol = liq_status.get("summary_by_symbol", {})
    hist_liq = liquidation_history_coverage()

    bars_by_symbol: dict[str, Any] = {}
    signals: dict[str, dict[str, Any]] = {}
    for symbol in SYMBOLS:
        policy = v12.POLICIES[symbol]
        if symbol == "BTCUSDT":
            bars, signal = v16.closed_bars(v12, symbol, policy)
        else:
            bars, signal = v16.closed_bars(v12, symbol, policy, btc_bars=bars_by_symbol.get("BTCUSDT"))
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
        sensor = v16.darkforest_row(ts, symbol, signal, liq)
        latest_sensors.append(sensor)
        append_csv(OUT_DIR / "hfcd_trading_v2_20_darkforest_sensors.csv", sensor)

        if symbol == "BTCUSDT":
            vector = v16.property_vector_btc(signal, liq)
            p_score = v16.property_score_btc(vector)
            vector_out = normalize_property_row(v16.vector_row(ts, signal, vector, p_score))
            latest_vectors.append(vector_out)
            append_csv(OUT_DIR / "hfcd_trading_v2_20_property_vectors.csv", vector_out)
            decisions = v16.btc_strategy_decisions(policy, signal, vector, p_score)
        else:
            decisions = {
                "baseline": v16.eth_baseline_decision(signal),
                "eth_maker_cost": eth_maker_decision(signal),
            }
            vector_out = normalize_property_row(eth_maker_vector_row(ts, signal, decisions["eth_maker_cost"]))
            latest_vectors.append(vector_out)
            append_csv(OUT_DIR / "hfcd_trading_v2_20_property_vectors.csv", vector_out)

        for strategy in STRATEGIES_BY_SYMBOL[symbol]:
            decision = decisions[strategy]
            event = v16.process_strategy(state, symbol, strategy, policy, signal, decision, ts)
            latest_events.append(event)
            drow = decision_row(ts, symbol, strategy, decision, event)
            latest_decisions.append(drow)
            append_csv(OUT_DIR / "hfcd_trading_v2_20_forward_events.csv", event)
            append_csv(OUT_DIR / "hfcd_trading_v2_20_forward_decisions.csv", drow)

    save_state(state)
    write_csv(OUT_DIR / "hfcd_trading_v2_20_latest_events.csv", latest_events)
    write_csv(OUT_DIR / "hfcd_trading_v2_20_latest_decisions.csv", latest_decisions)
    write_csv(OUT_DIR / "hfcd_trading_v2_20_latest_darkforest_sensors.csv", latest_sensors)
    write_csv(OUT_DIR / "hfcd_trading_v2_20_latest_property_vectors.csv", latest_vectors)
    write_csv(OUT_DIR / "hfcd_trading_v2_20_liquidation_history_coverage.csv", hist_liq)

    v17 = read_json(V17_SUMMARY)
    hist_ready = historical_liquidation_ready(hist_liq)
    summary = {
        "version": VERSION,
        "created_at": iso(ts),
        "status": "crypto_combined_property_maker_forward_shadow_completed",
        "no_real_orders": True,
        "no_online_page_change": True,
        "does_not_modify_v2_13_main_ledger": True,
        "does_not_modify_v2_16_shadow_ledger": True,
        "strategy_scope": STRATEGIES_BY_SYMBOL,
        "v2_17_eth_context": {
            "available": bool(v17),
            "selected_by_validation": v17.get("decision", {}).get("selected_by_validation", ""),
            "promote_eth_property_variant": v17.get("decision", {}).get("promote_eth_property_variant", ""),
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
        "latest_events": latest_events,
        "latest_decisions": latest_decisions,
        "latest_sensors": latest_sensors,
        "latest_vectors": latest_vectors,
        "files": {
            "state": str(OUT_DIR / "hfcd_trading_v2_20_shadow_state.json"),
            "events": str(OUT_DIR / "hfcd_trading_v2_20_forward_events.csv"),
            "decisions": str(OUT_DIR / "hfcd_trading_v2_20_forward_decisions.csv"),
            "darkforest_sensors": str(OUT_DIR / "hfcd_trading_v2_20_darkforest_sensors.csv"),
            "property_vectors": str(OUT_DIR / "hfcd_trading_v2_20_property_vectors.csv"),
            "liquidation_history_coverage": str(OUT_DIR / "hfcd_trading_v2_20_liquidation_history_coverage.csv"),
            "summary": str(OUT_DIR / "hfcd_trading_v2_20_summary.json"),
            "report": str(OUT_DIR / "HFCD_Trading_V2_20_CryptoCombinedPropertyMakerForwardShadow.md"),
        },
    }
    (OUT_DIR / "hfcd_trading_v2_20_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT_DIR / "HFCD_Trading_V2_20_CryptoCombinedPropertyMakerForwardShadow.md").write_text(render_report(summary), encoding="utf-8")

    print(json.dumps({
        "version": VERSION,
        "status": summary["status"],
        "historical_liquidation_status": summary["historical_liquidation_status"],
        "realtime_liquidation_events": summary["realtime_liquidation_status"]["events"],
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
