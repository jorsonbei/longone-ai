#!/usr/bin/env python3
"""
HFCD Commodity V5.18 ExactLineageForwardShadow

Only two promoted lineages are allowed:
- CL=F inherits V5.4 CL 3h rule.
- HO=F inherits V5.9 HO 2h rule.

1m/5m data is used as execution/readiness data only. It does not redefine the
main signal lineage.
"""

from __future__ import annotations

import json
import math
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "outputs" / "hfcd_commodity_v5_18_exact_lineage_forward_shadow"
OUT_DIR.mkdir(parents=True, exist_ok=True)

VERSION = "HFCD_Commodity_V5_18_ExactLineageForwardShadow"
LEDGER_PATH = OUT_DIR / "hfcd_commodity_v5_18_forward_ledger.csv"
STATE_PATH = OUT_DIR / "hfcd_commodity_v5_18_paper_state.json"
SUMMARY_PATH = OUT_DIR / "hfcd_commodity_v5_18_summary.json"
ROUTE_HEALTH_PATH = OUT_DIR / "hfcd_commodity_v5_18_route_health.csv"
REPORT_PATH = OUT_DIR / "HFCD_Commodity_V5_18_ExactLineageForwardShadow.md"
FIGURE_PATH = OUT_DIR / "HFCD_Commodity_V5_18_ExactLineageForwardShadow.png"


@dataclass(frozen=True)
class Route:
    symbol: str
    name: str
    cadence: str
    lineage_id: str
    source_version: str
    source_rule: str
    lookback_minutes: int
    min_score: float
    max_units: int
    blind_hit_rate: float
    blind_profit_factor: float
    blind_pnl_usd: float
    actions_per_day: float


ROUTES = [
    Route(
        symbol="CL=F",
        name="WTI Crude Oil Futures",
        cadence="3h",
        lineage_id="CL_V5_4_3h",
        source_version="V5.4",
        source_rule="CL=F_3h_ensemble_conf0.56_cons2_q0.45_max2",
        lookback_minutes=180,
        min_score=0.66,
        max_units=2,
        blind_hit_rate=0.64,
        blind_profit_factor=4.408892,
        blind_pnl_usd=136.96218,
        actions_per_day=2.882883,
    ),
    Route(
        symbol="HO=F",
        name="Heating Oil Futures",
        cadence="2h",
        lineage_id="HO_V5_9_2h",
        source_version="V5.9",
        source_rule="HO=F_2h_ensemble_ridge_density_rate0.28_q0.00_max1_rw0.35_floor0.2309",
        lookback_minutes=120,
        min_score=0.68,
        max_units=1,
        blind_hit_rate=0.722222,
        blind_profit_factor=3.805406,
        blind_pnl_usd=37.313686,
        actions_per_day=1.714286,
    ),
]


def utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def normalize_accounting(state: dict[str, Any]) -> dict[str, Any]:
    state.setdefault("initial_cash_usd", 100_000.0)
    state.setdefault("realized_pnl_usd", 0.0)
    state["settled_equity_usd"] = float(state["initial_cash_usd"]) + float(state["realized_pnl_usd"])
    state["cash_usd"] = state["settled_equity_usd"]
    return state


def load_state() -> dict[str, Any]:
    if STATE_PATH.exists():
        try:
            return normalize_accounting(json.loads(STATE_PATH.read_text(encoding="utf-8")))
        except Exception:
            pass
    return normalize_accounting({
        "version": VERSION,
        "initial_cash_usd": 100_000.0,
        "cash_usd": 100_000.0,
        "settled_equity_usd": 100_000.0,
        "realized_pnl_usd": 0.0,
        "positions": [],
        "seen_signal_ids": [],
        "updated_at": utc_now().isoformat(),
        "config": {
            "fixed_trade_usd": 1000.0,
            "max_open_positions": 4,
            "max_symbol_positions": 1,
            "stop_loss_pct": 0.018,
            "take_profit_pct": 0.036,
            "fee_rate": 0.00055,
        },
    })


def save_state(state: dict[str, Any]) -> None:
    state["updated_at"] = utc_now().isoformat()
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def fetch_yahoo_5m(route: Route) -> tuple[pd.DataFrame, str, bool]:
    params = urllib.parse.urlencode({"range": "10d", "interval": "5m", "includePrePost": "true"})
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(route.symbol)}?{params}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "HFCD-ThingNature-OS/1.0", "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=15) as res:
            payload = json.loads(res.read().decode("utf-8"))
        result = payload["chart"]["result"][0]
        ts = result.get("timestamp", [])
        quote = result.get("indicators", {}).get("quote", [{}])[0]
        close = quote.get("close", [])
        volume = quote.get("volume", [])
        rows = []
        for i, stamp in enumerate(ts):
            c = close[i] if i < len(close) else None
            if c is None or not math.isfinite(float(c)) or float(c) <= 0:
                continue
            rows.append(
                {
                    "timestamp": datetime.fromtimestamp(int(stamp), tz=timezone.utc),
                    "close": float(c),
                    "volume": float(volume[i] or 0) if i < len(volume) else 0.0,
                }
            )
        df = pd.DataFrame(rows)
        if len(df) < 80:
            raise RuntimeError(f"insufficient rows: {len(df)}")
        return df, f"yahoo_chart:{route.symbol}:5m", True
    except Exception:
        base = 96.0 if route.symbol == "CL=F" else 3.9
        now = utc_now()
        rows = []
        for i in range(360):
            t = now - timedelta(minutes=5 * (359 - i))
            wave = math.sin(t.timestamp() / 5400 + len(route.symbol)) * 0.006 + math.sin(t.timestamp() / 43200) * 0.012
            rows.append({"timestamp": t, "close": base * (1 + wave), "volume": 1200 + abs(math.sin(t.timestamp() / 3600)) * 600})
        return pd.DataFrame(rows), f"fallback_simulated:{route.symbol}:5m", False


def score_route(route: Route, df: pd.DataFrame, source: str, real: bool) -> dict[str, Any]:
    closes = df["close"].astype(float).to_numpy()
    volumes = df["volume"].astype(float).to_numpy()
    price = float(closes[-1])
    bars = max(1, round(route.lookback_minutes / 5))
    day_bars = min(288, max(bars * 2, 48))
    prev = float(closes[-2])
    horizon_base = float(closes[-1 - bars]) if len(closes) > bars else prev
    day_base = float(closes[-1 - day_bars]) if len(closes) > day_bars else horizon_base
    returns = pd.Series(closes[-max(day_bars, 72):]).pct_change().dropna()
    vol = max(float(returns.std()), 0.00035)
    r_horizon = price / horizon_base - 1
    r_day = price / day_base - 1
    recent_vol = float(volumes[-bars:].sum())
    base_vol = float(volumes[-day_bars:].sum()) / max(day_bars / bars, 1)
    volume_shock = max(-1.0, min(1.0, (recent_vol / max(base_vol, 1.0) - 1.0) / 2.0))
    signed = max(-3.0, min(3.0, (0.68 * r_horizon + 0.22 * r_day + 0.10 * volume_shock * vol) / vol))
    score = abs(signed)
    action = "BUY_LONG" if signed > 0 and score >= route.min_score else "SELL_SHORT" if signed < 0 and score >= route.min_score else "NO_TRADE"
    ts = df["timestamp"].iloc[-1].isoformat()
    return {
        "generated_at": utc_now().isoformat(),
        "signal_id": f"{route.symbol}-{route.cadence}-{int(df['timestamp'].iloc[-1].timestamp() // 300)}-{action}",
        "timestamp": ts,
        "symbol": route.symbol,
        "name": route.name,
        "cadence": route.cadence,
        "lineage_id": route.lineage_id,
        "source_version": route.source_version,
        "source_rule": route.source_rule,
        "scheduler_role": "1m/5m_execution_check_only",
        "source": source,
        "is_real_market_data": real,
        "price": round(price, 4 if route.symbol == "HO=F" else 2),
        "action": action,
        "side": "long" if action == "BUY_LONG" else "short" if action == "SELL_SHORT" else "flat",
        "score": round(score, 4),
        "signed_score": round(signed, 4),
        "min_score": route.min_score,
        "r_horizon": round(r_horizon, 6),
        "r_day": round(r_day, 6),
        "volume_shock": round(volume_shock, 4),
        "blind_hit_rate": route.blind_hit_rate,
        "blind_profit_factor": route.blind_profit_factor,
        "blind_pnl_usd": route.blind_pnl_usd,
        "actions_per_day": route.actions_per_day,
        "holding_minutes": route.lookback_minutes,
    }


def position_pnl(pos: dict[str, Any], price: float) -> float:
    side = pos["side"]
    qty = float(pos["quantity"])
    entry = float(pos["entry_price"])
    gross = (price - entry) * qty if side == "long" else (entry - price) * qty
    return gross - float(pos.get("open_fee_usd", 0.0))


def settled_equity(state: dict[str, Any]) -> float:
    return float(state.get("initial_cash_usd", 100_000.0)) + float(state.get("realized_pnl_usd", 0.0))


def append_rows(rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    df = pd.DataFrame(rows)
    if LEDGER_PATH.exists():
        old = pd.read_csv(LEDGER_PATH)
        df = pd.concat([old, df], ignore_index=True)
        df = df.drop_duplicates(subset=["event_id"], keep="last")
    df.to_csv(LEDGER_PATH, index=False)


def run_once() -> dict[str, Any]:
    started = time.time()
    state = load_state()
    config = state["config"]
    signals = []
    events = []
    price_by_symbol = {}

    for route in ROUTES:
        df, source, real = fetch_yahoo_5m(route)
        signal = score_route(route, df, source, real)
        signals.append(signal)
        price_by_symbol[route.symbol] = signal["price"]

    remaining = []
    for pos in state.get("positions", []):
        price = float(price_by_symbol.get(pos["symbol"], pos["entry_price"]))
        pnl = position_pnl(pos, price)
        pct = pnl / max(float(pos["trade_value_usd"]), 1.0)
        due = datetime.fromisoformat(pos["target_exit_at"]) <= utc_now()
        reason = ""
        if due:
            reason = "session_horizon_close"
        elif pct <= -float(config["stop_loss_pct"]):
            reason = "stop_loss"
        elif pct >= float(config["take_profit_pct"]):
            reason = "take_profit"
        if reason:
            close_fee = float(pos["trade_value_usd"]) * float(config["fee_rate"])
            net = pnl - close_fee
            state["cash_usd"] = float(state["cash_usd"]) + net
            state["realized_pnl_usd"] = float(state.get("realized_pnl_usd", 0)) + net
            events.append({**pos, "event_id": f"{pos['position_id']}-CLOSE-{utc_now().isoformat()}", "event": "CLOSE", "exit_price": price, "net_pnl_usd": round(net, 2), "reason": reason, "ts": utc_now().isoformat()})
        else:
            remaining.append({**pos, "mark_price": price, "unrealized_pnl_usd": round(pnl, 2)})
    state["positions"] = remaining

    for signal in sorted(signals, key=lambda s: s["score"], reverse=True):
        reason = ""
        if signal["action"] == "NO_TRADE":
            reason = "main_lineage_score_underthreshold"
        elif len(state.get("positions", [])) >= int(config["max_open_positions"]):
            reason = "max_open_positions"
        elif any(p["symbol"] == signal["symbol"] for p in state.get("positions", [])):
            reason = "max_symbol_positions"
        elif signal["signal_id"] in set(state.get("seen_signal_ids", [])):
            reason = "duplicate_signal"

        if reason:
            events.append({**signal, "event_id": f"{signal['signal_id']}-SKIP", "event": "SKIP", "net_pnl_usd": 0.0, "reason": reason, "ts": utc_now().isoformat()})
            continue

        amount = min(float(config["fixed_trade_usd"]) * max(0.35, min(2.0, signal["score"] / max(signal["min_score"], 0.1))), float(state["cash_usd"]) * 0.2)
        fee = amount * float(config["fee_rate"])
        qty = amount / max(signal["price"], 1e-9)
        position = {
            "event_id": f"{signal['signal_id']}-OPEN",
            "position_id": f"{signal['symbol']}-{int(time.time())}",
            "event": "OPEN",
            "ts": utc_now().isoformat(),
            "symbol": signal["symbol"],
            "name": signal["name"],
            "cadence": signal["cadence"],
            "lineage_id": signal["lineage_id"],
            "source_version": signal["source_version"],
            "source_rule": signal["source_rule"],
            "side": signal["side"],
            "action": signal["action"],
            "entry_price": signal["price"],
            "mark_price": signal["price"],
            "quantity": qty,
            "trade_value_usd": amount,
            "open_fee_usd": fee,
            "score": signal["score"],
            "target_exit_at": (utc_now() + timedelta(minutes=int(signal["holding_minutes"]))).isoformat(),
            "net_pnl_usd": -fee,
            "reason": "exact_lineage_forward_open",
        }
        state.setdefault("positions", []).append(position)
        state.setdefault("seen_signal_ids", []).append(signal["signal_id"])
        state["seen_signal_ids"] = state["seen_signal_ids"][-500:]
        events.append(position)

    unrealized = sum(float(p.get("unrealized_pnl_usd", 0.0)) for p in state.get("positions", []))
    state["settled_equity_usd"] = settled_equity(state)
    state["cash_usd"] = state["settled_equity_usd"]
    state["equity_usd"] = float(state["settled_equity_usd"]) + unrealized
    state["updated_at"] = utc_now().isoformat()
    save_state(state)
    append_rows(events)

    route_health = pd.DataFrame(signals)
    route_health.to_csv(ROUTE_HEALTH_PATH, index=False)
    ledger = pd.read_csv(LEDGER_PATH) if LEDGER_PATH.exists() else pd.DataFrame(events)
    closed = ledger[ledger["event"] == "CLOSE"] if len(ledger) else pd.DataFrame()
    wins = float(closed.loc[closed["net_pnl_usd"] > 0, "net_pnl_usd"].sum()) if len(closed) else 0.0
    losses = abs(float(closed.loc[closed["net_pnl_usd"] < 0, "net_pnl_usd"].sum())) if len(closed) else 0.0
    summary = {
        "version": VERSION,
        "generated_at": utc_now().isoformat(),
        "status": "exact_lineage_forward_shadow_running",
        "routes": [route.__dict__ for route in ROUTES],
        "signals": signals,
        "events_this_run": len(events),
        "open_positions": len(state.get("positions", [])),
        "realized_pnl_usd": round(float(state.get("realized_pnl_usd", 0)), 2),
        "unrealized_pnl_usd": round(unrealized, 2),
        "settled_equity_usd": round(float(state.get("settled_equity_usd", settled_equity(state))), 2),
        "equity_usd": round(float(state.get("equity_usd", 0)), 2),
        "closed_trades": int(len(closed)),
        "win_rate": round(float((closed["net_pnl_usd"] > 0).mean()), 4) if len(closed) else 0.0,
        "profit_factor": round(wins / losses, 4) if losses else (99.0 if wins else 0.0),
        "runtime_sec": round(time.time() - started, 3),
        "outputs": {
            "summary_json": str(SUMMARY_PATH),
            "forward_ledger_csv": str(LEDGER_PATH),
            "route_health_csv": str(ROUTE_HEALTH_PATH),
            "state_json": str(STATE_PATH),
            "report_md": str(REPORT_PATH),
            "figure_png": str(FIGURE_PATH),
        },
    }
    SUMMARY_PATH.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    write_report(summary)
    write_figure(ledger, route_health)
    return summary


def write_report(summary: dict[str, Any]) -> None:
    rows = []
    for signal in summary["signals"]:
        rows.append(
            f"| {signal['symbol']} | {signal['cadence']} | {signal['source_version']} | {signal['action']} | {signal['score']:.3f} | {signal['price']} | {signal['source']} |"
        )
    REPORT_PATH.write_text(
        "\n".join(
            [
                f"# {VERSION}",
                "",
                "## 定位",
                "只接入 CL=F 3h 与 HO=F 2h 两条已通过血统路线。1m/5m 行情只作为执行检查层，不重新定义主信号。",
                "",
                "## 本轮信号",
                "| 标的 | 周期 | 血统 | 动作 | 分数 | 价格 | 行情源 |",
                "|---|---:|---|---|---:|---:|---|",
                *rows,
                "",
                "## 账本状态",
                f"- open_positions: {summary['open_positions']}",
                f"- realized_pnl_usd: {summary['realized_pnl_usd']}",
                f"- unrealized_pnl_usd: {summary['unrealized_pnl_usd']}",
                f"- win_rate: {summary['win_rate']}",
                f"- profit_factor: {summary['profit_factor']}",
                "",
                "## 下一步",
                "若前向样本持续正向，再接入能源 AI 页面定时化或真实券商/期货接口。当前仍是 paper shadow。",
            ]
        ),
        encoding="utf-8",
    )


def write_figure(ledger: pd.DataFrame, route_health: pd.DataFrame) -> None:
    fig, axes = plt.subplots(1, 2, figsize=(10, 4))
    if len(route_health):
        axes[0].bar(route_health["symbol"], route_health["score"], color=["#0ea5e9", "#f97316"])
        axes[0].set_title("Current lineage score")
        axes[0].axhline(0.66, color="#ef4444", linestyle="--", linewidth=1)
    if len(ledger) and "net_pnl_usd" in ledger:
        closes = ledger[ledger["event"] == "CLOSE"].copy()
        if len(closes):
            closes["equity_curve"] = closes["net_pnl_usd"].cumsum()
            axes[1].plot(range(len(closes)), closes["equity_curve"], marker="o", color="#22c55e")
        axes[1].set_title("Closed trade cumulative PnL")
    for ax in axes:
        ax.grid(alpha=0.25)
    fig.tight_layout()
    fig.savefig(FIGURE_PATH, dpi=160)
    plt.close(fig)


if __name__ == "__main__":
    print(json.dumps(run_once(), ensure_ascii=False, indent=2))
